"""CLI entry point for quorable.

Nine commands per CONTRACT.md: init, ingest, cost-estimate, run, panel,
validate, golden, diff, handoff. Every command operates on the current
directory or --project <dir> (the project holds config.yaml, pack.py, and
the data directories).
"""
from __future__ import annotations

import logging
from pathlib import Path

import typer

from quorable.engine.logging_config import setup_logging

logger = logging.getLogger(__name__)

app = typer.Typer(
    name="quorable",
    help="Multi-model adversarial review-and-revision harness for writing.",
    no_args_is_help=True,
)

_PROJECT_OPTION = typer.Option(
    Path("."), "--project", help="Project directory (holds config.yaml + pack.py)",
)


@app.callback()
def _configure() -> None:
    """Set up structured logging before any subcommand runs."""
    setup_logging()


def _config_path(project: Path) -> Path:
    path = project / "config.yaml"
    if not path.exists():
        typer.secho(
            f"No config.yaml in {project.resolve()} — run `quorable init` "
            f"or pass --project.",
            fg="red",
        )
        raise typer.Exit(1)
    return path


def _load(project: Path):
    """Load (config, pack) for a project, with clear failure output."""
    from quorable.engine.config import load_config
    from quorable.pack import PackError, load_pack

    config_path = _config_path(project)
    config = load_config(config_path)
    try:
        pack = load_pack(config_path)
    except PackError as exc:
        typer.secho(str(exc), fg="red")
        raise typer.Exit(1)
    return config, pack


def _load_documents(config, pack):
    from quorable.engine.manifest import load_manifest
    from quorable.engine.parsers import parse_document

    inputs_dir = config.paths.inputs
    entries = load_manifest(inputs_dir / "manifest.yaml", inputs_dir)
    documents: dict = {}
    for entry in entries:
        if entry.path.exists():
            try:
                documents[entry.name] = parse_document(
                    entry, primary_doc_name=pack.primary_doc_name,
                )
            except Exception as exc:
                logger.warning("Failed to parse %s: %s", entry.name, exc)
    return entries, documents


# ---------------------------------------------------------------------------
# init
# ---------------------------------------------------------------------------


_CONFIG_TEMPLATE = """\
# quorable project configuration — see CONTRACT.md in the quorable repo.

pack: ./pack.py

models:
  reviewers:
    - id: anthropic/claude-sonnet-4.6
      temperature: 0.2
    - id: openai/gpt-5.4
      temperature: 0.2
    - id: google/gemini-3.5-flash
      temperature: 0.2
  synthesizer:
    id: anthropic/claude-sonnet-4.6
    temperature: 0.1
  held_out:
    id: x-ai/grok-4.3        # keep cross-vendor vs. every reviewer
    temperature: 0.2
  drafter:
    id: anthropic/claude-sonnet-4.6
    temperature: 0.7

pipeline:
  runs_per_persona: 2        # reviews per (model, persona) pair
  max_concurrency: 5
  timeout_seconds: 300
  cost_threshold: 20.0       # per-LOOP; confirmation above this, abort at ×multiplier
  cost_abort_multiplier: 2.0
  max_iterations: 3          # loop stop condition

personas: []                 # e.g. [hook_doctor, canon_guardian, red_team]

# document_type: script      # key into pack.doc_type_markers (wrong-mode guard)
regressions_path: ./regressions.yaml
"""

_PACK_TEMPLATE = '''\
"""Project pack — the domain contract for this quorable project.

Fill in the schemas, dimensions, gates, and ship criteria for your domain.
See quorable's CONTRACT.md for field semantics and schema conventions.
"""
from typing import Literal

from pydantic import BaseModel, Field

from quorable.engine.gates import banned_elements_gate, term_lint_gate, word_count_gate
from quorable.engine.schemas import ContestedIssue, Finding, RankedFix, Weakness
from quorable.pack import Pack, ShipGates


class UnitScore(BaseModel):
    unit: str
    # One 1-5 attribute per score dimension, matching Pack.score_dimensions:
    clarity: int = Field(ge=1, le=5)
    punch: int = Field(ge=1, le=5)
    verdict: Literal["good", "mixed", "bad"]
    weaknesses: list[str] = Field(default_factory=list)


class Review(BaseModel):
    persona: str = ""
    model_id: str = ""
    unit_reviews: list[UnitScore]
    verdict: Literal["good", "mixed", "bad"]
    confidence: float = Field(ge=0, le=1, default=0.5)
    findings: list[Finding] = Field(default_factory=list)
    suspected_prompt_injection: list[str] = Field(default_factory=list)


class Synthesis(BaseModel):
    consensus_weaknesses: list[Weakness]
    contested_issues: list[ContestedIssue] = Field(default_factory=list)
    ranked_fixes: list[RankedFix] = Field(default_factory=list)
    inter_rater_agreement: dict[str, float] = Field(default_factory=dict)
    held_out_validator_status: str = "not_yet_run"


def _blocking_findings(synthesis: Synthesis | None, reviews: list[Review]) -> list[str]:
    """Product-truth guard, computed from the RAW reviews in code.

    Never trust the synthesis LLM to copy blockers through — a severity-1
    finding in any raw review blocks shipping even if synthesis drops it.
    """
    blockers = [
        f.description
        for r in reviews
        for f in r.findings
        if f.severity == 1
    ]
    if synthesis is not None:
        blockers.extend(
            w.description
            for w in synthesis.consensus_weaknesses
            if w.severity == "critical"
        )
    return blockers


PACK = Pack(
    name="my_pack",
    review_schema=Review,
    synthesis_schema=Synthesis,
    score_dimensions=["clarity", "punch"],
    verdict_field="verdict",
    verdict_categories=["good", "mixed", "bad"],
    canonical_units=["hook", "body"],
    unit_field="unit",
    primary_doc_name="script_draft",
    doc_type_markers={},
    mechanical_gates=[
        word_count_gate(400),
        term_lint_gate({}),
        banned_elements_gate([]),
    ],
    ship_gates=ShipGates(
        composite_min=4.0,
        dimension_min=3.0,
        blocking_findings=_blocking_findings,
        weights=None,
    ),
    drafter_enabled=True,
    held_out_recommended_docs=[],
)
'''

_MANIFEST_TEMPLATE = """\
# manifest.yaml — Define all input documents, their roles, tiers, and routing.
# Sections are free-form; any top-level key may hold a single entry, a dict
# of named entries, or a list of entries.
#
# send_to values: stage1 (all personas), stage1_<persona>, stage2, stage3,
# draft (routed to the drafter).

# system_prompt:
#   path: system_prompt.md
#   role: "Base system prompt for all reviewers"
#   tier: 1
#   send_to: [stage1, stage2, stage3]

# core:
#   script_draft:
#     path: core/script_draft.md
#     role: "Primary document under review"
#     tier: 1
#     critical: true
#     send_to: [stage1, stage2, stage3, draft]
#   canon:
#     path: core/canon.md
#     role: "Product-truth source — drift from this is severity 1"
#     tier: 1
#     send_to: [stage1, stage2, draft]
"""

_GOLDEN_MANIFEST_TEMPLATE = """\
# golden/manifest.yaml — documents with KNOWN seeded defects + one clean
# negative control. Run `quorable golden` after ANY prompt/persona/gate
# change; misses and negative-control false positives fail the command.

cases: []
#  - id: seeded_case_1
#    path: seeded_case_1.md
#    defects:
#      - id: overlength
#        detector: word_count             # a pack mechanical-gate name
#        expect: "words"
#  - id: clean_control
#    path: clean_control.md
#    negative_control: true
"""


@app.command()
def init(
    project: Path = _PROJECT_OPTION,
) -> None:
    """Scaffold a project skeleton: config.yaml, pack.py, data directories."""
    from rich.console import Console

    console = Console()
    project.mkdir(parents=True, exist_ok=True)

    created: list[str] = []
    for subdir in ("context", "personas", "prompts", "golden", "briefs", "inputs"):
        path = project / subdir
        if not path.exists():
            path.mkdir(parents=True)
            created.append(f"{subdir}/")

    def _write_if_missing(rel: str, content: str) -> None:
        path = project / rel
        if path.exists():
            console.print(f"[yellow]{rel} already exists — skipping[/yellow]")
            return
        path.write_text(content, encoding="utf-8")
        created.append(rel)

    _write_if_missing("config.yaml", _CONFIG_TEMPLATE)
    _write_if_missing("pack.py", _PACK_TEMPLATE)
    _write_if_missing("inputs/manifest.yaml", _MANIFEST_TEMPLATE)
    _write_if_missing("golden/manifest.yaml", _GOLDEN_MANIFEST_TEMPLATE)

    console.print("[bold green]Scaffolded quorable project[/bold green]")
    for item in created:
        console.print(f"  Created: {item}")
    console.print(
        "\nNext: edit pack.py (schemas, dimensions, gates), config.yaml "
        "(models, personas), and inputs/manifest.yaml. Then run "
        "`quorable ingest` and `quorable cost-estimate` before any real run."
    )


# ---------------------------------------------------------------------------
# ingest
# ---------------------------------------------------------------------------


@app.command()
def ingest(
    project: Path = _PROJECT_OPTION,
) -> None:
    """Parse all documents per manifest, report stats."""
    from rich.console import Console
    from rich.table import Table

    from quorable.engine.manifest import load_manifest
    from quorable.engine.parsers import parse_document

    console = Console()
    config, pack = _load(project)
    inputs_dir = config.paths.inputs
    entries = load_manifest(inputs_dir / "manifest.yaml", inputs_dir)

    table = Table(title="Ingested Documents")
    table.add_column("Name")
    table.add_column("Tier", justify="center")
    table.add_column("Format")
    table.add_column("Chars", justify="right")
    table.add_column("Pages", justify="right")
    table.add_column("SHA256 (first 12)")

    for entry in entries:
        if not entry.path.exists():
            table.add_row(
                entry.name, str(entry.tier), entry.format,
                "[red]MISSING[/red]", "-", "-",
            )
            continue
        doc = parse_document(entry, primary_doc_name=pack.primary_doc_name)
        table.add_row(
            doc.name,
            str(entry.tier),
            entry.format,
            f"{doc.char_count:,}",
            str(doc.page_count),
            doc.sha256[:12],
        )

    console.print(table)


# ---------------------------------------------------------------------------
# cost-estimate
# ---------------------------------------------------------------------------


@app.command(name="cost-estimate")
def cost_estimate(
    project: Path = _PROJECT_OPTION,
) -> None:
    """Estimate per-loop cost (incl. drafter calls) without running.

    MUST be run before the first real `run` on a project.
    """
    from rich.console import Console

    from quorable.engine.costs import (
        estimate_pipeline_cost,
        format_cost_estimate,
        refresh_live_pricing,
    )
    from quorable.engine.prompts import load_persona_overlay, load_system_prompt

    console = Console()
    config, pack = _load(project)
    inputs_dir = config.paths.inputs

    model_ids = [m.id for m in config.active_reviewers] + [
        config.models.synthesizer.id, config.held_out_model_id,
    ]
    if config.models.drafter is not None:
        model_ids.append(config.models.drafter.id)
    refresh_live_pricing(model_ids)

    entries, documents = _load_documents(config, pack)

    system_prompt = load_system_prompt(inputs_dir)
    persona_overlay_chars: dict[str, int] = {}
    for persona in config.personas:
        overlay = load_persona_overlay(config.paths.personas, persona)
        persona_overlay_chars[persona] = len(overlay)

    est = estimate_pipeline_cost(
        config=config,
        entries=entries,
        documents=documents,
        system_prompt_chars=len(system_prompt),
        persona_overlay_chars=persona_overlay_chars,
        include_drafter=pack.drafter_enabled,
        iterations=config.pipeline.max_iterations,
    )

    console.print(format_cost_estimate(est, config))


# ---------------------------------------------------------------------------
# run — the full loop
# ---------------------------------------------------------------------------


@app.command()
def run(
    brief: str = typer.Argument(
        None,
        help="Brief file (path, resolved against briefs/ then the project) "
             "to draft from. Omit to review the manifest's primary document.",
    ),
    project: Path = _PROJECT_OPTION,
    max_iter: int = typer.Option(None, "--max-iter", help="Override pipeline.max_iterations"),
    budget: float = typer.Option(None, "--budget", help="Per-loop cost abort threshold in USD"),
    confirm: bool = typer.Option(False, "--confirm", help="Skip interactive cost confirmation"),
    no_draft: bool = typer.Option(
        False, "--no-draft",
        help="Single-pass parent behavior: panel + synthesis only, no revisions",
    ),
) -> None:
    """Run the full draft→panel→synthesis→gates→revise loop."""
    import asyncio

    from rich.console import Console

    from quorable.engine.costs import (
        estimate_pipeline_cost,
        format_cost_estimate,
        refresh_live_pricing,
    )
    from quorable.engine.loop import LoopStatus, run_loop
    from quorable.engine.prompts import load_persona_overlay, load_system_prompt

    console = Console()
    config, pack = _load(project)
    inputs_dir = config.paths.inputs

    # --- Resolve the brief ---
    brief_text: str | None = None
    if brief:
        candidates = [Path(brief), config.paths.briefs / brief, project / brief]
        for candidate in candidates:
            if candidate.is_file():
                brief_text = candidate.read_text(encoding="utf-8")
                break
        if brief_text is None:
            console.print(f"[red]Brief not found: {brief}[/red]")
            raise typer.Exit(1)

    # --- Cost estimation before running ---
    model_ids = [m.id for m in config.active_reviewers] + [
        config.models.synthesizer.id, config.held_out_model_id,
    ]
    if config.models.drafter is not None:
        model_ids.append(config.models.drafter.id)
    refresh_live_pricing(model_ids)

    entries, documents = _load_documents(config, pack)
    system_prompt = load_system_prompt(inputs_dir)
    persona_overlay_chars: dict[str, int] = {}
    for p in config.personas:
        overlay = load_persona_overlay(config.paths.personas, p)
        persona_overlay_chars[p] = len(overlay)

    iterations = max_iter or config.pipeline.max_iterations
    est = estimate_pipeline_cost(
        config=config,
        entries=entries,
        documents=documents,
        system_prompt_chars=len(system_prompt),
        persona_overlay_chars=persona_overlay_chars,
        include_drafter=pack.drafter_enabled and not no_draft,
        iterations=iterations,
    )
    console.print(format_cost_estimate(est, config))
    console.print()

    threshold = budget if budget is not None else config.pipeline.cost_threshold
    if est.per_loop_usd > threshold and not confirm:
        proceed = typer.confirm(
            f"Estimated per-loop cost ${est.per_loop_usd:.2f} exceeds "
            f"${threshold:.2f}. Proceed?"
        )
        if not proceed:
            console.print("[yellow]Aborted by user.[/yellow]")
            raise typer.Exit(0)

    console.print("[bold]Starting review loop[/bold]")
    console.print(f"  Pack: {pack.name}")
    console.print(f"  Models: {[m.id for m in config.active_reviewers]}")
    console.print(f"  Personas: {config.personas}")
    console.print(f"  Max iterations: {iterations}")

    result = asyncio.run(run_loop(
        config=config,
        pack=pack,
        brief=brief_text,
        max_iterations=max_iter,
        budget=budget,
        no_draft=no_draft,
    ))

    console.print()
    console.print(f"[bold]Loop finished: {result.status.value.upper()}[/bold]")
    console.print(f"  Run ID: {result.run_id}")
    console.print(f"  Output: {result.run_dir}")
    console.print(f"  Iterations: {result.iterations}")
    for record in result.iteration_records:
        composite = f"{record.composite:.2f}" if record.composite is not None else "n/a"
        console.print(
            f"    iter_{record.number}: composite={composite} "
            f"ship={'PASS' if record.ship_ok else 'no (' + '; '.join(record.ship_reasons) + ')'}"
        )
    console.print(f"  Total cost: ${result.total_cost_usd:.4f}")
    if result.abort_reason:
        console.print(f"  [red]Abort reason: {result.abort_reason}[/red]")

    # --- Reports + regressions on the final iteration ---
    if result.synthesis is not None and result.iterations > 0:
        from quorable.engine.regressions import (
            check_regressions,
            load_registry,
            save_registry,
            update_registry,
        )
        from quorable.engine.reports import load_prior_synthesis, save_reports

        final_iter_dir = result.run_dir / f"iter_{result.iterations}"

        import hashlib

        doc_sha = (
            hashlib.sha256(result.final_script.encode("utf-8")).hexdigest()
            if result.final_script
            else None
        )
        registry = load_registry(config.regressions_path)
        regression_result = check_regressions(
            synthesis=result.synthesis, registry=registry,
            run_id=result.run_id, doc_sha256=doc_sha,
        )
        registry = update_registry(
            registry=registry, regression_result=regression_result,
            run_id=result.run_id,
        )
        save_registry(registry, config.regressions_path)
        if regression_result.reappeared:
            console.print(
                f"  [bold red]Regressions detected: "
                f"{len(regression_result.reappeared)} previously resolved "
                f"weaknesses reappeared[/bold red]"
            )

        prior = load_prior_synthesis(
            config.paths.outputs, result.run_dir, pack.synthesis_schema,
        )
        from quorable.engine.client import CostTracker

        tracker = CostTracker()
        tracker.total_usd = result.total_cost_usd
        save_reports(
            result.synthesis, final_iter_dir, tracker,
            prior_synthesis=prior,
        )
        console.print(f"  Report: {final_iter_dir / 'synthesis_report.md'}")

    if result.status is LoopStatus.ABORTED:
        raise typer.Exit(1)


# ---------------------------------------------------------------------------
# panel — Stage 1+2 only on an existing draft
# ---------------------------------------------------------------------------


@app.command()
def panel(
    script: str = typer.Argument(
        None,
        help="Path to an existing draft to review. Omit to use the "
             "manifest's primary document.",
    ),
    project: Path = _PROJECT_OPTION,
    persona: str = typer.Option(None, help="Run only this persona"),
    model: str = typer.Option(None, help="Run only this model"),
    confirm: bool = typer.Option(False, "--confirm", help="Skip interactive cost confirmation"),
) -> None:
    """Stage 1 + 2 only on an existing draft (human-written review mode)."""
    import asyncio

    from rich.console import Console

    from quorable.engine.pipeline import run_stage1
    from quorable.engine.reports import save_reports
    from quorable.engine.synthesis import persona_coverage as _persona_coverage
    from quorable.engine.synthesis import run_stage2

    console = Console()
    config, pack = _load(project)

    primary_text: str | None = None
    if script:
        script_path = Path(script)
        if not script_path.is_file():
            script_path = project / script
        if not script_path.is_file():
            console.print(f"[red]Script not found: {script}[/red]")
            raise typer.Exit(1)
        primary_text = script_path.read_text(encoding="utf-8")

    # Validate filters before starting
    if persona and persona not in config.personas:
        console.print(
            f"[red]Unknown persona '{persona}'. "
            f"Valid: {', '.join(config.personas)}[/red]"
        )
        raise typer.Exit(1)
    if model and model not in [m.id for m in config.active_reviewers]:
        console.print(
            f"[red]Unknown or held-out model '{model}'. "
            f"Valid: {', '.join(m.id for m in config.active_reviewers)}[/red]"
        )
        raise typer.Exit(1)

    if not confirm:
        proceed = typer.confirm(
            "Run Stage 1 + 2 panel now? (run `quorable cost-estimate` first "
            "if you have not)"
        )
        if not proceed:
            console.print("[yellow]Aborted by user.[/yellow]")
            raise typer.Exit(0)

    console.print("[bold]Starting Stage 1 review panel[/bold]")
    result = asyncio.run(run_stage1(
        config, pack,
        filter_persona=persona,
        filter_model=model,
        primary_text=primary_text,
    ))

    console.print(f"[bold green]Stage 1 complete[/bold green]")
    console.print(f"  Run ID: {result.run_id}")
    console.print(f"  Succeeded: {result.succeeded}/{result.succeeded + result.failed}")
    console.print(f"  Total cost: ${result.total_cost_usd:.4f}")

    if not result.succeeded:
        console.print("[red]No successful reviews — skipping Stage 2.[/red]")
        raise typer.Exit(1)

    synthesis = asyncio.run(run_stage2(
        config=config,
        pack=pack,
        stage1_results=result.results,
        entries=result.entries or [],
        documents=result.documents or {},
        run_dir=result.run_dir,
    ))

    if synthesis is None:
        console.print("[red]Stage 2 synthesis failed.[/red]")
        raise typer.Exit(1)

    coverage = _persona_coverage(result.results, config)
    missing_personas = [p for p, n in coverage.items() if n == 0]
    if missing_personas:
        console.print(
            f"  [bold red]PERSONA DROPOUT: no successful reviews from "
            f"{', '.join(missing_personas)}[/bold red]"
        )

    save_reports(
        synthesis, result.run_dir, result.cost_tracker,
        persona_coverage=coverage,
    )
    console.print(f"[bold green]Stage 2 complete[/bold green]")
    console.print(f"  Report: {result.run_dir / 'synthesis_report.md'}")


# ---------------------------------------------------------------------------
# validate — Stage 3 held-out (outside the loop)
# ---------------------------------------------------------------------------


@app.command()
def validate(
    project: Path = _PROJECT_OPTION,
    run_dir: str = typer.Option(None, "--run-dir", help="Run (or iteration) directory containing synthesis.json"),
) -> None:
    """Run Stage 3 held-out validation on the final script + ledger update."""
    import asyncio
    import json as _json

    from rich.console import Console

    from quorable.engine.held_out import (
        adjudicate_held_out_status,
        run_stage3,
        update_synthesis_status,
    )
    from quorable.engine.ledger import latest_iter_dir

    console = Console()
    config, pack = _load(project)

    console.print("[bold]Starting Stage 3 held-out validation[/bold]")
    console.print(f"  Held-out model: {config.held_out_model_id}")

    # Determine run directory
    if run_dir:
        target_dir = Path(run_dir)
        if not target_dir.is_dir():
            target_dir = config.paths.outputs / run_dir
    else:
        outputs = config.paths.outputs
        if not outputs.exists():
            console.print("[red]No runs directory found. Run the pipeline first.[/red]")
            raise typer.Exit(1)
        run_dirs = sorted(
            [d for d in outputs.iterdir() if d.is_dir() and d.name.startswith("run_")],
            key=lambda d: d.name,
            reverse=True,
        )
        if not run_dirs:
            console.print("[red]No run directories found. Run the pipeline first.[/red]")
            raise typer.Exit(1)
        target_dir = run_dirs[0]

    # Loop runs keep artifacts per-iteration — validate the final iteration.
    if not (target_dir / "synthesis.json").exists():
        latest = latest_iter_dir(target_dir)
        if latest is not None:
            target_dir = latest

    console.print(f"  Run directory: {target_dir}")

    review = asyncio.run(run_stage3(config=config, pack=pack, run_dir=target_dir))

    if review is None:
        console.print("[red]Stage 3 validation failed[/red]")
        raise typer.Exit(1)

    console.print(f"[bold green]Stage 3 complete[/bold green]")
    verdict = getattr(review, pack.verdict_field, "unknown")
    console.print(f"  Verdict: {verdict}")

    synthesis_path = target_dir / "synthesis.json"
    if synthesis_path.exists():
        data = _json.loads(synthesis_path.read_text())
        synthesis = pack.synthesis_schema.model_validate(data)
        status = asyncio.run(adjudicate_held_out_status(
            config=config,
            pack=pack,
            held_out_review=review,
            synthesis=synthesis,
            run_dir=target_dir,
        ))
        update_synthesis_status(synthesis, status, target_dir)
        console.print(f"  Held-out status: {status}")
        console.print(f"  Triage file: {target_dir / 'held_out_new_issues.md'}")
    else:
        console.print("  [yellow]No synthesis.json found — skipping status update[/yellow]")


# ---------------------------------------------------------------------------
# golden
# ---------------------------------------------------------------------------


@app.command()
def golden(
    project: Path = _PROJECT_OPTION,
    live: bool = typer.Option(
        False, "--live",
        help="Also run llm_* detectors via their project prompts (costs money).",
    ),
) -> None:
    """Golden-set harness: measured recall against seeded defects.

    Exits non-zero if any evaluated defect is missed or the negative control
    produces mechanical false positives. Run after ANY prompt, persona, or
    gate change.
    """
    import asyncio
    from datetime import datetime, timezone

    from rich.console import Console

    from quorable.engine.golden import run_golden

    console = Console()
    config, pack = _load(project)

    outcomes, report = asyncio.run(
        run_golden(config, pack, live=live)
    )

    console.print(report)
    ts = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    report_path = config.paths.golden / f"report_{ts}.md"
    report_path.write_text(report, encoding="utf-8")
    console.print(f"[bold green]Report saved to {report_path}[/bold green]")

    missed = sum(
        1 for o in outcomes for d in o.outcomes if not d.caught
    )
    mechanical_fps = sum(
        len([fp for fp in o.false_positives if not fp.startswith("llm")])
        for o in outcomes if o.negative_control
    )
    if missed or mechanical_fps:
        console.print(
            f"[bold red]Golden run FAILED: {missed} defect(s) missed, "
            f"{mechanical_fps} mechanical false positive(s).[/bold red]"
        )
        raise typer.Exit(1)


# ---------------------------------------------------------------------------
# diff
# ---------------------------------------------------------------------------


@app.command()
def diff(
    run_a: str = typer.Argument(help="First run ID or directory path"),
    run_b: str = typer.Argument(help="Second run ID or directory path"),
    project: Path = _PROJECT_OPTION,
) -> None:
    """Compare two pipeline runs and surface changes."""
    from rich.console import Console

    from quorable.engine.diff import compare_runs, format_diff

    console = Console()
    config, pack = _load(project)

    diff_result = compare_runs(
        run_a=run_a,
        run_b=run_b,
        outputs_dir=config.paths.outputs,
        pack=pack,
    )

    console.print(format_diff(diff_result))


# ---------------------------------------------------------------------------
# handoff
# ---------------------------------------------------------------------------


@app.command()
def handoff(
    run: str = typer.Argument(help="Run ID or directory to hand off"),
    project: Path = _PROJECT_OPTION,
    hypothesis: str = typer.Option(
        "", "--hypothesis",
        help="What this version is predicted to do better (frozen in the ledger)",
    ),
) -> None:
    """Emit deliverables and freeze the predictions.yaml row for a run."""
    from rich.console import Console

    from quorable.engine.diff import _resolve_run_dir
    from quorable.engine.ledger import (
        PREDICTIONS_FILENAME,
        LedgerFrozenError,
        build_prediction_row,
        emit_handoff,
        freeze_prediction,
    )

    console = Console()
    config, pack = _load(project)

    run_dir = _resolve_run_dir(run, config.paths.outputs)

    row = build_prediction_row(
        run_dir=run_dir, pack=pack, hypothesis=hypothesis,
    )
    ledger_path = config.paths.handoff / PREDICTIONS_FILENAME
    try:
        freeze_prediction(row, ledger_path)
    except LedgerFrozenError as exc:
        console.print(f"[red]{exc}[/red]")
        raise typer.Exit(1)

    emitted = emit_handoff(run_dir=run_dir, dest_dir=config.paths.handoff)

    console.print("[bold green]Handoff complete[/bold green]")
    console.print(f"  Ledger: {ledger_path}")
    console.print(f"  Prediction: composite={row['composite']} iteration={row['iteration_shipped']}")
    for path in emitted:
        console.print(f"  Emitted: {path}")
