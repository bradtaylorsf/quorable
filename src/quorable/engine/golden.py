"""Golden-set harness: measured recall against seeded defects.

Forked from the reference implementation's golden module and genericized: the parent's hardcoded
detectors (citecheck/xref) became a registry keyed by the pack's mechanical
gate names. `golden/manifest.yaml` lists documents with KNOWN seeded defects
plus a clean negative-control document; each defect names a `detector`:

- a mechanical gate name from pack.mechanical_gates (free, default tier), or
- an `llm_*` name, which resolves to the project prompt
  `prompts/<detector>.md` and is only evaluated with --live (costs money).

Recall per defect and false positives on the negative control are the
system's only ground-truth measurement — run this after ANY prompt, persona,
or gate change. Negative-control mechanical false positives fail the command.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

from quorable.engine.config import Config
from quorable.engine.gates import Gate

logger = logging.getLogger(__name__)

GOLDEN_DIR = Path("golden")


@dataclass
class DefectOutcome:
    defect_id: str
    detector: str
    expect: str
    caught: bool
    detail: str = ""


@dataclass
class CaseOutcome:
    case_id: str
    negative_control: bool
    outcomes: list[DefectOutcome] = field(default_factory=list)
    false_positives: list[str] = field(default_factory=list)
    skipped_live: int = 0

    @property
    def caught(self) -> int:
        return sum(1 for o in self.outcomes if o.caught)

    @property
    def total(self) -> int:
        return len(self.outcomes)


def _load_golden_manifest(golden_dir: Path) -> dict:
    manifest_path = golden_dir / "manifest.yaml"
    if not manifest_path.exists():
        raise FileNotFoundError(f"Golden manifest not found: {manifest_path}")
    with open(manifest_path) as f:
        return yaml.safe_load(f)


def _gate_registry(pack: Any) -> dict[str, Gate]:
    return {g.name: g for g in pack.mechanical_gates}


def _run_mechanical_case(
    case: dict,
    golden_dir: Path,
    pack: Any,
    config: Config | None,
) -> CaseOutcome:
    """Run the pack's mechanical gates against one golden case."""
    doc_path = golden_dir / case["path"]
    text = doc_path.read_text(encoding="utf-8")
    outcome = CaseOutcome(
        case_id=case["id"],
        negative_control=bool(case.get("negative_control", False)),
    )

    gates = _gate_registry(pack)
    # Run every gate once; results feed both defect scoring and the
    # negative-control false-positive check.
    gate_results = {name: gate.run(text, config) for name, gate in gates.items()}

    for defect in case.get("defects", []):
        detector = defect["detector"]
        expect = str(defect["expect"])
        if detector.startswith("llm_"):
            outcome.skipped_live += 1
            continue
        gate_result = gate_results.get(detector)
        if gate_result is None:
            outcome.outcomes.append(DefectOutcome(
                defect_id=defect["id"], detector=detector, expect=expect,
                caught=False,
                detail=(
                    f"detector '{detector}' is not a pack gate "
                    f"(available: {sorted(gates)})"
                ),
            ))
            continue
        findings = " | ".join(gate_result.findings)
        caught = any(expect in f for f in gate_result.findings)
        outcome.outcomes.append(DefectOutcome(
            defect_id=defect["id"], detector=detector, expect=expect,
            caught=caught,
            detail=f"findings: {findings or '(none)'}",
        ))

    # --- False positives on the negative control ---
    if outcome.negative_control:
        for name, result in gate_results.items():
            outcome.false_positives.extend(
                f"{name}: {f}" for f in result.findings
            )

    return outcome


async def _run_live_case(
    case: dict,
    golden_dir: Path,
    config: Config,
    outcome: CaseOutcome,
) -> None:
    """Run llm_* detectors against a golden case (live LLM calls).

    Each llm_* detector name maps to a project prompt
    prompts/<detector>.md. The prompt is run against the golden document
    with a deliberately generic system prompt (golden docs are NOT the real
    project, and a project-tuned system prompt would contaminate the
    measurement). A defect is caught when its `expect` string appears in the
    model's free-text response (case-insensitive).
    """
    from quorable.engine.client import CostTracker, OpenRouterClient

    llm_defects = [
        d for d in case.get("defects", []) if d["detector"].startswith("llm_")
    ]
    if not llm_defects:
        return

    doc_path = golden_dir / case["path"]
    text = doc_path.read_text(encoding="utf-8")

    tracker = CostTracker()
    model_id = config.active_reviewers[0].id
    outcome.skipped_live = 0

    async with OpenRouterClient(
        max_concurrency=1,
        timeout_seconds=config.pipeline.timeout_seconds,
        retry_attempts=config.pipeline.retry_attempts,
        cost_tracker=tracker,
    ) as client:
        for detector in sorted({d["detector"] for d in llm_defects}):
            prompt_path = config.paths.prompts / f"{detector}.md"
            defects = [d for d in llm_defects if d["detector"] == detector]
            if not prompt_path.exists():
                for defect in defects:
                    outcome.outcomes.append(DefectOutcome(
                        defect_id=defect["id"], detector=detector,
                        expect=str(defect["expect"]), caught=False,
                        detail=f"prompt not found: {prompt_path}",
                    ))
                continue

            messages = [
                {
                    "role": "system",
                    "content": (
                        "You are a rigorous editorial auditor performing a "
                        "cold review of the attached document."
                    ),
                },
                {
                    "role": "user",
                    "content": (
                        prompt_path.read_text(encoding="utf-8")
                        + "\n\nDOCUMENT UNDER AUDIT:\n"
                        + "-" * 40 + "\n" + text
                    ),
                },
            ]
            try:
                response = await client.chat(
                    model=model_id, messages=messages,
                    temperature=0.1, json_mode=False,
                )
                content = client.get_content(response) or ""
            except Exception as exc:  # noqa: BLE001 — failure becomes a result row
                content = ""
                logger.error("Live golden call failed for %s: %s", detector, exc)

            for defect in defects:
                expect = str(defect["expect"])
                caught = expect.lower() in content.lower()
                outcome.outcomes.append(DefectOutcome(
                    defect_id=defect["id"], detector=detector,
                    expect=expect, caught=caught,
                    detail=f"response chars: {len(content)}",
                ))

    logger.info(
        "Golden live case %s | model=%s cost=$%.4f",
        case["id"], model_id, tracker.total_usd,
    )


def format_golden_report(outcomes: list[CaseOutcome], live: bool) -> str:
    """Render the golden-run results as markdown."""
    lines = ["# Golden-Set Report\n"]
    mode = "mechanical + live LLM" if live else "mechanical only"
    lines.append(f"Mode: {mode}\n")

    total_seeded = sum(o.total for o in outcomes)
    total_caught = sum(o.caught for o in outcomes)
    total_skipped = sum(o.skipped_live for o in outcomes)
    if total_seeded or total_skipped:
        lines.append(
            f"**Recall: {total_caught}/{total_seeded} seeded defects caught"
            + (f" ({total_skipped} llm defects skipped — run with --live)"
               if total_skipped else "")
            + ".**\n"
        )

    for o in outcomes:
        tag = " (negative control)" if o.negative_control else ""
        lines.append(f"## {o.case_id}{tag}\n")
        if o.outcomes:
            lines.append("| Defect | Detector | Expected | Caught |")
            lines.append("|---|---|---|---|")
            for d in o.outcomes:
                lines.append(
                    f"| {d.defect_id} | {d.detector} | {d.expect} | "
                    f"{'YES' if d.caught else '**MISSED**'} |"
                )
            lines.append("")
            for d in o.outcomes:
                if not d.caught:
                    lines.append(f"- MISSED {d.defect_id}: {d.detail}")
            lines.append("")
        if o.skipped_live:
            lines.append(
                f"- {o.skipped_live} llm defect(s) not evaluated "
                "(mechanical-only run)\n"
            )
        if o.negative_control:
            if o.false_positives:
                lines.append(
                    f"**False positives ({len(o.false_positives)}):**"
                )
                for fp in o.false_positives:
                    lines.append(f"- {fp}")
            else:
                lines.append("**False positives: none.**")
            lines.append("")
    return "\n".join(lines)


async def run_golden(
    config: Config,
    pack: Any,
    *,
    golden_dir: Path | None = None,
    live: bool = False,
) -> tuple[list[CaseOutcome], str]:
    """Execute the golden-set run; returns (outcomes, markdown report)."""
    gdir = golden_dir or config.paths.golden
    manifest = _load_golden_manifest(gdir)

    outcomes: list[CaseOutcome] = []
    for case in manifest["cases"]:
        outcome = _run_mechanical_case(case, gdir, pack, config)
        if live:
            await _run_live_case(case, gdir, config, outcome)
        outcomes.append(outcome)

    report = format_golden_report(outcomes, live)
    return outcomes, report
