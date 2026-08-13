"""The draft → panel → synthesis → gates → revise orchestrator.

Net-new (neither parent has this loop):

    draft (or load existing) → panel (Stage 1 fan-out) → synthesis (Stage 2)
      → ship-gate check → if pass: stop(SHIPPABLE)
      → if iterations == max_iterations: stop(EXHAUSTED)
      → revise → re-run mechanical gates → loop

Stop conditions (all mandatory in config):
- pack.ship_gates pass (SHIPPABLE),
- pipeline.max_iterations reached (EXHAUSTED),
- budget: shared CostTracker + CostAbortError with a per-LOOP threshold
  (pipeline.cost_threshold × cost_abort_multiplier, or an explicit
  --budget) — abort, never degrade (ABORTED).

Every iteration writes runs/run_<ts>/iter_<n>/ with raw_reviews/,
synthesis.json, gates.json, and script_v<n>.md. Held-out validation (Stage 3)
stays OUTSIDE the loop — run once on the final script via `quorable
validate`, exactly like the parent.

Stage functions are injectable (draft_fn / panel_fn / synthesis_fn) so the
loop's control flow is testable with no network.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any, Awaitable, Callable

import yaml
from pydantic import BaseModel

from quorable.engine.client import CostTracker
from quorable.engine.config import Config
from quorable.engine.gates import GateResult, all_gates_passed, run_gates
from quorable.engine.manifest import load_manifest
from quorable.engine.parsers import parse_document
from quorable.engine.pipeline import CostAbortError, check_primary_committed, run_stage1
from quorable.engine.reviewer import ReviewResult, generate_run_id
from quorable.engine.synthesis import run_stage2

logger = logging.getLogger(__name__)


class LoopStatus(str, Enum):
    SHIPPABLE = "shippable"
    EXHAUSTED = "exhausted"
    ABORTED = "aborted"


# Injectable stage signatures (all async):
#   draft_fn(mode, *, brief, previous_script, synthesis, cost_tracker) -> str | None
#   panel_fn(script_text, iter_dir, cost_tracker) -> list[ReviewResult]
#   synthesis_fn(results, iter_dir, cost_tracker) -> BaseModel | None
DraftFn = Callable[..., Awaitable[str | None]]
PanelFn = Callable[[str, Path, CostTracker], Awaitable[list[ReviewResult]]]
SynthesisFn = Callable[..., Awaitable[BaseModel | None]]


@dataclass
class IterationRecord:
    number: int
    composite: float | None = None
    per_dimension: dict[str, float] = field(default_factory=dict)
    ship_ok: bool = False
    ship_reasons: list[str] = field(default_factory=list)
    gates_passed: bool = True


@dataclass
class LoopResult:
    status: LoopStatus
    iterations: int
    run_id: str
    run_dir: Path
    final_script: str | None
    final_script_path: Path | None
    synthesis: BaseModel | None
    total_cost_usd: float
    iteration_records: list[IterationRecord] = field(default_factory=list)
    abort_reason: str | None = None


# ---------------------------------------------------------------------------
# Ship-gate evaluation
# ---------------------------------------------------------------------------

def compute_scores(
    reviews: list[Any],
    pack: Any,
    personas: list[str] | None = None,
) -> tuple[float | None, dict[str, float]]:
    """Compute (composite, per-dimension means) from Stage 1 reviews.

    Per-dimension mean = mean over every unit score in every review, in
    either score shape (attribute style, or unit-major via
    pack.unit_score_field). Composite = weighted mean of the dimension means
    (ship_gates.weights, or unweighted when None).

    Reviews from ship_gates.composite_exclude_personas are excluded from
    BOTH the composite and the per-dimension floor statistics (red-team
    personas score low by design) — they still count everywhere else
    (findings, blocking gates, synthesis input, agreement stats). The
    persona for each review comes from the aligned `personas` list when
    given, else the review's own `persona` field.
    """
    from quorable.engine.agreement import _unit_score_for_dimension

    unit_list_field = getattr(pack, "unit_list_field", "unit_reviews")
    unit_score_field = getattr(pack, "unit_score_field", None)
    keyword_rules = tuple(getattr(pack, "unit_keyword_rules", ()) or ())
    excluded = set(
        getattr(pack.ship_gates, "composite_exclude_personas", None) or ()
    )

    def _persona_of(index: int, review: Any) -> str:
        if personas is not None and index < len(personas):
            return personas[index]
        return str(getattr(review, "persona", "") or "")

    scored_reviews = [
        review for i, review in enumerate(reviews)
        if _persona_of(i, review) not in excluded
    ]
    if excluded and len(scored_reviews) < len(reviews):
        logger.info(
            "Composite/floor statistics exclude %d review(s) from persona(s) "
            "%s (composite_exclude_personas)",
            len(reviews) - len(scored_reviews), sorted(excluded),
        )

    per_dimension: dict[str, float] = {}
    for dim in pack.score_dimensions:
        values: list[float] = []
        for review in scored_reviews:
            for unit in getattr(review, unit_list_field, None) or []:
                value = _unit_score_for_dimension(
                    unit, dim,
                    unit_field=pack.unit_field,
                    unit_score_field=unit_score_field,
                    keyword_rules=keyword_rules,
                )
                if value is not None:
                    values.append(value)
        if values:
            per_dimension[dim] = round(sum(values) / len(values), 4)

    if not per_dimension:
        return None, {}

    weights = pack.ship_gates.weights or {d: 1.0 for d in per_dimension}
    weighted_sum = 0.0
    weight_total = 0.0
    for dim, mean in per_dimension.items():
        w = weights.get(dim, 0.0 if pack.ship_gates.weights else 1.0)
        weighted_sum += mean * w
        weight_total += w
    composite = round(weighted_sum / weight_total, 4) if weight_total else None
    return composite, per_dimension


def check_ship_gates(
    *,
    synthesis: BaseModel | None,
    reviews: list[Any],
    gate_results: dict[str, GateResult],
    pack: Any,
    personas: list[str] | None = None,
) -> tuple[bool, list[str], float | None, dict[str, float]]:
    """Evaluate the pack's ship gates. Returns (ok, reasons, composite, dims).

    The blocking-findings gate (product-truth guard) is a gate, never an
    averaged score: any blocking finding fails shipping regardless of how
    good the composite looks. It receives BOTH the synthesis and the raw
    Stage-1 reviews, so a blocker present in a raw review still blocks even
    when the synthesis LLM silently drops it.
    """
    reasons: list[str] = []
    composite, per_dimension = compute_scores(reviews, pack, personas=personas)

    if synthesis is None:
        reasons.append("no synthesis output")

    if not all_gates_passed(gate_results):
        failed = [n for n, r in gate_results.items() if not r.passed]
        reasons.append(f"mechanical gates failed: {', '.join(failed)}")

    if composite is None:
        reasons.append("no scores extracted from reviews")
    else:
        if composite < pack.ship_gates.composite_min:
            reasons.append(
                f"composite {composite:.2f} < min {pack.ship_gates.composite_min:.2f}"
            )
        low = {
            d: m for d, m in per_dimension.items()
            if m < pack.ship_gates.dimension_min
        }
        if low:
            reasons.append(
                "dimensions below min "
                f"{pack.ship_gates.dimension_min:.2f}: "
                + ", ".join(f"{d}={m:.2f}" for d, m in sorted(low.items()))
            )

    if pack.ship_gates.blocking_findings is not None:
        try:
            blocking = pack.ship_gates.blocking_findings(synthesis, reviews) or []
        except Exception as exc:  # noqa: BLE001 — a broken gate blocks shipping
            blocking = [f"blocking_findings gate crashed: {exc}"]
        if blocking:
            reasons.append(
                "blocking findings: " + "; ".join(str(b) for b in blocking)
            )

    return (not reasons, reasons, composite, per_dimension)


# ---------------------------------------------------------------------------
# Default stage implementations (network-backed)
# ---------------------------------------------------------------------------

def _default_draft_fn(config: Config, pack: Any) -> DraftFn:
    from quorable.engine.drafting import assemble_for_draft, run_draft
    from quorable.engine.prompts import load_system_prompt

    async def _draft(
        mode: str,
        *,
        brief: str | None = None,
        previous_script: str | None = None,
        synthesis: BaseModel | None = None,
        cost_tracker: CostTracker | None = None,
    ) -> str | None:
        inputs_dir = config.paths.inputs
        entries = load_manifest(inputs_dir / "manifest.yaml", inputs_dir)
        documents = {}
        for entry in entries:
            if entry.path.exists():
                try:
                    documents[entry.name] = parse_document(
                        entry, primary_doc_name=pack.primary_doc_name,
                    )
                except Exception as exc:
                    logger.warning("Failed to parse %s: %s", entry.name, exc)
        # The current script is passed explicitly; exclude any stale on-disk
        # copy from the reference set.
        draft_docs = assemble_for_draft(
            entries, documents, exclude={pack.primary_doc_name},
        )
        return await run_draft(
            config=config,
            system_prompt=load_system_prompt(inputs_dir),
            prompts_dir=config.paths.prompts,
            mode=mode,
            documents=draft_docs,
            brief=brief,
            previous_script=previous_script,
            synthesis=synthesis,
            cost_tracker=cost_tracker,
        )

    return _draft


def _default_panel_fn(
    config: Config, pack: Any, abort_threshold: float,
) -> PanelFn:
    async def _panel(
        script_text: str, iter_dir: Path, cost_tracker: CostTracker,
    ) -> list[ReviewResult]:
        result = await run_stage1(
            config,
            pack,
            run_dir=iter_dir,
            primary_text=script_text,
            cost_tracker=cost_tracker,
            abort_threshold=abort_threshold,
            skip_commit_check=True,
        )
        return result.results

    return _panel


def _default_synthesis_fn(config: Config, pack: Any) -> SynthesisFn:
    async def _synthesize(
        results: list[ReviewResult],
        script_text: str,
        iter_dir: Path,
        cost_tracker: CostTracker,
    ) -> BaseModel | None:
        inputs_dir = config.paths.inputs
        entries = load_manifest(inputs_dir / "manifest.yaml", inputs_dir)
        documents = {}
        for entry in entries:
            if entry.path.exists():
                try:
                    documents[entry.name] = parse_document(
                        entry, primary_doc_name=pack.primary_doc_name,
                    )
                except Exception as exc:
                    logger.warning("Failed to parse %s: %s", entry.name, exc)
        from quorable.engine.parsers import document_from_text

        documents[pack.primary_doc_name] = document_from_text(
            pack.primary_doc_name, script_text,
            role="Primary document under review",
        )
        return await run_stage2(
            config=config,
            pack=pack,
            stage1_results=results,
            entries=entries,
            documents=documents,
            run_dir=iter_dir,
            cost_tracker=cost_tracker,
        )

    return _synthesize


# ---------------------------------------------------------------------------
# The loop
# ---------------------------------------------------------------------------

def _load_initial_script(config: Config, pack: Any) -> str:
    """Read the committed primary document from the inputs manifest."""
    inputs_dir = config.paths.inputs
    entries = load_manifest(inputs_dir / "manifest.yaml", inputs_dir)
    for entry in entries:
        if entry.name == pack.primary_doc_name:
            check_primary_committed(entry.path)
            doc = parse_document(entry, primary_doc_name=pack.primary_doc_name)
            return doc.content
    raise FileNotFoundError(
        f"Primary document '{pack.primary_doc_name}' not found in manifest "
        f"({inputs_dir / 'manifest.yaml'}) — add it, or pass a brief with "
        f"drafting enabled."
    )


async def run_loop(
    *,
    config: Config,
    pack: Any,
    brief: str | None = None,
    initial_script: str | None = None,
    max_iterations: int | None = None,
    budget: float | None = None,
    no_draft: bool = False,
    draft_fn: DraftFn | None = None,
    panel_fn: PanelFn | None = None,
    synthesis_fn: SynthesisFn | None = None,
) -> LoopResult:
    """Run the full draft→panel→synthesis→gates→revise loop.

    `--no-draft` or pack.drafter_enabled=False degrades to single-pass parent
    behavior: one panel + synthesis on the existing document, no revisions
    (max one iteration, EXHAUSTED unless it ships).
    """
    max_iter = max_iterations or config.pipeline.max_iterations
    loop_threshold = (
        budget
        if budget is not None
        else config.pipeline.cost_threshold * config.pipeline.cost_abort_multiplier
    )
    drafting_enabled = pack.drafter_enabled and not no_draft
    if not drafting_enabled and max_iter > 1:
        logger.info(
            "Drafting disabled (%s) — single-pass review mode, max_iterations "
            "forced to 1",
            "--no-draft" if pack.drafter_enabled else "pack.drafter_enabled=False",
        )
        max_iter = 1

    cost_tracker = CostTracker()
    draft = draft_fn or _default_draft_fn(config, pack)
    panel = panel_fn or _default_panel_fn(config, pack, loop_threshold)
    synthesize = synthesis_fn or _default_synthesis_fn(config, pack)

    run_id = generate_run_id()
    run_dir = config.paths.outputs / f"run_{run_id}"
    run_dir.mkdir(parents=True, exist_ok=True)
    logger.info(
        "Loop %s started | max_iterations=%d budget=$%.2f drafting=%s",
        run_id, max_iter, loop_threshold, drafting_enabled,
    )

    records: list[IterationRecord] = []
    synthesis: BaseModel | None = None
    script: str | None = initial_script
    final_script_path: Path | None = None
    status = LoopStatus.EXHAUSTED
    abort_reason: str | None = None

    def _over_budget() -> bool:
        return cost_tracker.total_usd > loop_threshold

    def _write_summary() -> None:
        summary = {
            "run_id": run_id,
            "status": status.value,
            "iterations": len(records),
            "total_cost_usd": round(cost_tracker.total_usd, 4),
            "budget_usd": loop_threshold,
            "abort_reason": abort_reason,
            "iteration_records": [
                {
                    "iteration": r.number,
                    "composite": r.composite,
                    "per_dimension": r.per_dimension,
                    "ship_ok": r.ship_ok,
                    "ship_reasons": r.ship_reasons,
                    "gates_passed": r.gates_passed,
                }
                for r in records
            ],
        }
        (run_dir / "loop_summary.yaml").write_text(
            yaml.dump(summary, default_flow_style=False, allow_unicode=True),
            encoding="utf-8",
        )

    try:
        # --- Initial script: provided, drafted, or loaded from inputs ---
        if script is None:
            if drafting_enabled and brief:
                logger.info("Drafting initial script from brief")
                script = await draft(
                    "draft", brief=brief, previous_script=None,
                    synthesis=None, cost_tracker=cost_tracker,
                )
                if script is None:
                    status = LoopStatus.ABORTED
                    abort_reason = "initial draft failed"
                    _write_summary()
                    return LoopResult(
                        status=status, iterations=0, run_id=run_id,
                        run_dir=run_dir, final_script=None,
                        final_script_path=None, synthesis=None,
                        total_cost_usd=cost_tracker.total_usd,
                        iteration_records=records, abort_reason=abort_reason,
                    )
            else:
                script = _load_initial_script(config, pack)

        for n in range(1, max_iter + 1):
            iter_dir = run_dir / f"iter_{n}"
            iter_dir.mkdir(parents=True, exist_ok=True)

            script_path = iter_dir / f"script_v{n}.md"
            script_path.write_text(script, encoding="utf-8")
            final_script_path = script_path

            record = IterationRecord(number=n)
            records.append(record)

            # --- Panel (Stage 1 fan-out) ---
            results = await panel(script, iter_dir, cost_tracker)
            reviews = [r.review for r in results if r.review is not None]
            review_personas = [r.persona for r in results if r.review is not None]
            if _over_budget():
                raise CostAbortError(
                    f"Running cost ${cost_tracker.total_usd:.2f} exceeds "
                    f"loop budget ${loop_threshold:.2f}"
                )

            # --- Synthesis (Stage 2) ---
            synthesis = await synthesize(results, script, iter_dir, cost_tracker)
            if _over_budget():
                raise CostAbortError(
                    f"Running cost ${cost_tracker.total_usd:.2f} exceeds "
                    f"loop budget ${loop_threshold:.2f}"
                )

            # --- Mechanical gates ---
            gate_results = run_gates(pack.mechanical_gates, script, config)
            record.gates_passed = all_gates_passed(gate_results)
            (iter_dir / "gates.json").write_text(
                yaml_safe_gates(gate_results), encoding="utf-8",
            )

            # --- Ship-gate check ---
            ship_ok, reasons, composite, per_dimension = check_ship_gates(
                synthesis=synthesis,
                reviews=reviews,
                gate_results=gate_results,
                pack=pack,
                personas=review_personas,
            )
            record.composite = composite
            record.per_dimension = per_dimension
            record.ship_ok = ship_ok
            record.ship_reasons = reasons

            if ship_ok:
                logger.info(
                    "Iteration %d SHIPPABLE (composite=%.2f)",
                    n, composite if composite is not None else float("nan"),
                )
                status = LoopStatus.SHIPPABLE
                break

            logger.info(
                "Iteration %d not shippable: %s", n, "; ".join(reasons),
            )

            if n == max_iter:
                logger.warning(
                    "Max iterations (%d) reached without shipping — EXHAUSTED",
                    max_iter,
                )
                status = LoopStatus.EXHAUSTED
                break

            if not drafting_enabled:
                status = LoopStatus.EXHAUSTED
                break

            # --- Revise ---
            revised = await draft(
                "revise", brief=brief, previous_script=script,
                synthesis=synthesis, cost_tracker=cost_tracker,
            )
            if _over_budget():
                raise CostAbortError(
                    f"Running cost ${cost_tracker.total_usd:.2f} exceeds "
                    f"loop budget ${loop_threshold:.2f}"
                )
            if revised is None:
                logger.error("Revision failed — stopping loop")
                status = LoopStatus.ABORTED
                abort_reason = f"revision failed at iteration {n}"
                break
            script = revised

            # --- Re-run mechanical gates on the fresh revision (loudly) ---
            post_gates = run_gates(pack.mechanical_gates, script, config)
            if not all_gates_passed(post_gates):
                failed = [g for g, r in post_gates.items() if not r.passed]
                logger.warning(
                    "Revised draft still fails mechanical gate(s) %s — the "
                    "next panel iteration will see these failures",
                    ", ".join(failed),
                )

    except CostAbortError as exc:
        logger.error("Loop cost abort: %s", exc)
        status = LoopStatus.ABORTED
        abort_reason = str(exc)

    _write_summary()
    logger.info(
        "Loop %s finished | status=%s iterations=%d cost=$%.4f",
        run_id, status.value, len(records), cost_tracker.total_usd,
    )

    return LoopResult(
        status=status,
        iterations=len(records),
        run_id=run_id,
        run_dir=run_dir,
        final_script=script,
        final_script_path=final_script_path,
        synthesis=synthesis,
        total_cost_usd=cost_tracker.total_usd,
        iteration_records=records,
        abort_reason=abort_reason,
    )


def yaml_safe_gates(gate_results: dict[str, GateResult]) -> str:
    """Serialize gate results as JSON (stored as gates.json)."""
    import json as _json

    return _json.dumps(
        {
            name: {"passed": r.passed, "findings": r.findings}
            for name, r in gate_results.items()
        },
        indent=2,
        ensure_ascii=False,
    )
