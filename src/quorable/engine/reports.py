"""Human-readable report generation from pack synthesis output.

Forked from the reference implementation's reports module and genericized: reports render from the
pack's synthesis schema via the shared field conventions (consensus
weaknesses with `unit`, contested_issues, ranked_fixes,
inter_rater_agreement, held_out_validator_status). The legal-only
tentative-ruling compliance report is gone; packs that need an analogous
deliverable render it from their own synthesis fields.
"""
from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

from pydantic import BaseModel

from quorable.engine.client import CostTracker

logger = logging.getLogger(__name__)


def _severity_marker(severity: str) -> str:
    """Map severity to a text marker (no emoji per project style)."""
    return {"critical": "[CRITICAL]", "major": "[MAJOR]", "minor": "[MINOR]"}.get(
        severity, ""
    )


def _format_agreement_table(agreement: dict[str, float]) -> str:
    """Format inter-rater agreement stats as a markdown table."""
    lines = ["| Metric | Value | Interpretation |", "|--------|-------|----------------|"]
    for key, val in sorted(agreement.items()):
        if val != val:  # NaN check
            interp = "Insufficient data"
            val_str = "N/A"
        elif key.startswith("icc_"):
            val_str = f"{val:.4f}"
            if val >= 0.75:
                interp = "Excellent agreement"
            elif val >= 0.6:
                interp = "Good agreement"
            elif val >= 0.4:
                interp = "Moderate agreement"
            else:
                interp = "**Genuinely contested**"
        else:
            val_str = f"{val:.4f}"
            if val >= 0.61:
                interp = "Substantial agreement"
            elif val >= 0.41:
                interp = "Moderate agreement"
            elif val >= 0.21:
                interp = "Fair agreement"
            else:
                interp = "**Poor agreement**"

        if key.startswith("icc_") and "__" in key:
            dim, persona = key.removeprefix("icc_").split("__", 1)
            label = f"ICC ({persona}): {dim}"
        elif key.startswith("icc_"):
            # Pooled ICC mixes designed persona bias with model disagreement;
            # per-persona rows above are the clean reliability signal.
            label = f"ICC (pooled, all personas): {key.removeprefix('icc_')}"
        else:
            label = key.replace("fleiss_kappa_", "Fleiss' kappa: ")
        lines.append(f"| {label} | {val_str} | {interp} |")
    return "\n".join(lines)


def generate_synthesis_report(
    synthesis: Any,
    *,
    prior_synthesis: Any | None = None,
    persona_coverage: dict[str, int] | None = None,
) -> str:
    """Generate the primary human-readable synthesis report.

    Includes: persona coverage (missing lenses surfaced first), consensus
    weaknesses ranked by severity, contested issues, ranked fixes, agreement
    statistics, and a diff against the prior run if available.
    """
    sections: list[str] = []

    # Header
    sections.append("# quorable Adversarial Review — Synthesis Report\n")

    # --- Persona coverage (surfaced first: a missing lens changes how much
    # to trust everything below) ---
    if persona_coverage is not None:
        missing = [p for p, n in persona_coverage.items() if n == 0]
        sections.append("## Review Coverage\n")
        coverage_str = ", ".join(
            f"{p}: {n}" for p, n in persona_coverage.items()
        )
        sections.append(f"Successful reviews per persona — {coverage_str}\n")
        if missing:
            sections.append(
                f"**WARNING: no successful reviews from persona(s) "
                f"{', '.join(missing)}. This synthesis is missing those "
                f"lenses entirely — re-run them before relying on it.**\n"
            )

    # --- Consensus Weaknesses ---
    weaknesses = getattr(synthesis, "consensus_weaknesses", []) or []
    sections.append("## Consensus Weaknesses\n")
    if weaknesses:
        # Group by severity: critical first, then major, then minor
        for severity in ("critical", "major", "minor"):
            group = [w for w in weaknesses if getattr(w, "severity", "") == severity]
            if not group:
                continue
            sections.append(f"### {severity.title()} Issues\n")
            for w in group:
                sections.append(
                    f"- {_severity_marker(w.severity)} **{getattr(w, 'unit', '')}**: "
                    f"{w.description} ({getattr(w, 'reviewer_count', '?')} reviewers)\n"
                    f"  - *Suggested fix:* {getattr(w, 'suggested_fix', '')}\n"
                )
    else:
        sections.append("No consensus weaknesses identified.\n")

    # --- Contested Issues ---
    contested = getattr(synthesis, "contested_issues", []) or []
    sections.append("## Contested Issues\n")
    if contested:
        for ci in contested:
            sections.append(f"### {ci.description}\n")
            sections.append(f"**Position A:** {ci.position_a}\n")
            sections.append(f"- Models: {', '.join(ci.models_supporting_a)}\n")
            sections.append(f"**Position B:** {ci.position_b}\n")
            sections.append(f"- Models: {', '.join(ci.models_supporting_b)}\n")
    else:
        sections.append("No contested issues identified.\n")

    # --- Ranked Fixes ---
    fixes = getattr(synthesis, "ranked_fixes", []) or []
    sections.append("## Ranked Fixes (by priority)\n")
    if fixes:
        sections.append(
            "| # | Fix | Unit | Impact | Ease | Consensus | Priority |\n"
            "|---|-----|------|--------|------|-----------|----------|\n"
        )
        for i, fix in enumerate(fixes, 1):
            sections.append(
                f"| {i} | {fix.description} | {getattr(fix, 'unit', '')} | "
                f"{fix.impact}/5 | {fix.ease}/5 | {fix.consensus:.0%} | "
                f"{fix.priority_score:.1f} |\n"
            )
    else:
        sections.append("No fixes ranked.\n")

    # --- Unique Arguments ---
    uniques = getattr(synthesis, "unique_arguments", []) or []
    if uniques:
        sections.append("## Unique Arguments (single-reviewer findings)\n")
        for ua in uniques:
            sections.append(
                f"- **{ua.source_model}** ({ua.source_persona}): {ua.description}\n"
                f"  - *Assessment:* {ua.assessment}\n"
            )

    # --- Inter-Rater Agreement ---
    agreement = getattr(synthesis, "inter_rater_agreement", {}) or {}
    sections.append("## Inter-Rater Agreement Statistics\n")
    sections.append(_format_agreement_table(agreement) + "\n")

    # --- Diff against prior run ---
    if prior_synthesis is not None:
        sections.append("## Changes from Prior Run\n")
        sections.append(_generate_diff(prior_synthesis, synthesis))

    # --- Held-out status ---
    status = getattr(synthesis, "held_out_validator_status", "not_yet_run")
    sections.append(f"\n---\n*Held-out validator status: {status}*\n")

    return "\n".join(sections)


def _generate_diff(
    prior: Any,
    current: Any,
) -> str:
    """Generate a textual diff between two synthesis runs."""
    lines: list[str] = []

    # Compare weakness counts
    prior_descs = {w.description for w in getattr(prior, "consensus_weaknesses", []) or []}
    current_descs = {w.description for w in getattr(current, "consensus_weaknesses", []) or []}

    new_weaknesses = current_descs - prior_descs
    resolved_weaknesses = prior_descs - current_descs

    if new_weaknesses:
        lines.append("### New Weaknesses\n")
        for w in new_weaknesses:
            lines.append(f"- {w}\n")

    if resolved_weaknesses:
        lines.append("### Resolved Weaknesses\n")
        for w in resolved_weaknesses:
            lines.append(f"- ~~{w}~~\n")

    if not new_weaknesses and not resolved_weaknesses:
        lines.append("No changes in consensus weaknesses.\n")

    # Compare fix priorities
    prior_fixes = {
        f.description: f.priority_score
        for f in getattr(prior, "ranked_fixes", []) or []
    }
    current_fixes = {
        f.description: f.priority_score
        for f in getattr(current, "ranked_fixes", []) or []
    }

    new_fixes = set(current_fixes.keys()) - set(prior_fixes.keys())
    if new_fixes:
        lines.append("### New Fixes Identified\n")
        for f in new_fixes:
            lines.append(f"- {f} (priority: {current_fixes[f]:.1f})\n")

    return "\n".join(lines)


def generate_cost_summary(cost_tracker: CostTracker) -> str:
    """Generate cost_summary.txt with per-model and total costs."""
    lines: list[str] = []
    lines.append("quorable — Cost Summary")
    lines.append("=" * 40)

    if not cost_tracker.records:
        lines.append("\nNo API calls recorded.")
        return "\n".join(lines)

    # Per-model aggregation
    model_costs: dict[str, float] = {}
    model_calls: dict[str, int] = {}
    model_tokens: dict[str, int] = {}

    for record in cost_tracker.records:
        model_costs[record.model] = model_costs.get(record.model, 0) + record.cost_usd
        model_calls[record.model] = model_calls.get(record.model, 0) + 1
        model_tokens[record.model] = model_tokens.get(record.model, 0) + record.total_tokens

    lines.append("\nPer-Model Breakdown:")
    lines.append("-" * 40)
    lines.append(f"{'Model':<40} {'Calls':>5} {'Tokens':>10} {'Cost':>10}")
    lines.append("-" * 67)
    for model in sorted(model_costs.keys()):
        lines.append(
            f"{model:<40} {model_calls[model]:>5} "
            f"{model_tokens[model]:>10} ${model_costs[model]:>9.4f}"
        )

    lines.append("-" * 67)
    total_calls = sum(model_calls.values())
    total_tokens = sum(model_tokens.values())
    lines.append(
        f"{'TOTAL':<40} {total_calls:>5} "
        f"{total_tokens:>10} ${cost_tracker.total_usd:>9.4f}"
    )

    return "\n".join(lines)


def save_reports(
    synthesis: Any,
    run_dir: Path,
    cost_tracker: CostTracker,
    *,
    prior_synthesis: Any | None = None,
    persona_coverage: dict[str, int] | None = None,
) -> None:
    """Save all report files to the run directory."""
    # synthesis_report.md
    report = generate_synthesis_report(
        synthesis,
        prior_synthesis=prior_synthesis,
        persona_coverage=persona_coverage,
    )
    report_path = run_dir / "synthesis_report.md"
    report_path.write_text(report, encoding="utf-8")
    logger.info("Saved synthesis report to %s", report_path)

    # cost_summary.txt
    cost = generate_cost_summary(cost_tracker)
    cost_path = run_dir / "cost_summary.txt"
    cost_path.write_text(cost, encoding="utf-8")
    logger.info("Saved cost summary to %s", cost_path)


def load_prior_synthesis(
    outputs_dir: Path,
    current_run_dir: Path,
    synthesis_schema: type[BaseModel],
) -> BaseModel | None:
    """Load synthesis.json from the most recent prior run, if one exists.

    Sorts candidates by directory name descending (run IDs are ISO8601
    timestamps, so lexicographic ordering equals chronological). Falls back
    to mtime if names don't follow the expected format. Resolves paths
    before comparison to avoid symlink/relative-path mismatches. Loop runs
    keep their synthesis in iteration subdirectories, so the latest
    iteration's synthesis represents the run.
    """
    if not outputs_dir.exists():
        return None

    current_resolved = current_run_dir.resolve()

    candidates = [
        d for d in outputs_dir.iterdir()
        if d.is_dir() and d.name.startswith("run_") and d.resolve() != current_resolved
    ]

    # Primary sort: name descending (ISO8601 run IDs).
    # Tiebreak: mtime descending (handles non-standard names).
    candidates.sort(key=lambda d: (d.name, d.stat().st_mtime), reverse=True)

    for run_dir in candidates:
        synthesis_path = run_dir / "synthesis.json"
        if not synthesis_path.exists():
            iter_dirs = sorted(
                (d for d in run_dir.iterdir() if d.is_dir() and d.name.startswith("iter_")),
                key=lambda d: d.name,
                reverse=True,
            )
            for iter_dir in iter_dirs:
                if (iter_dir / "synthesis.json").exists():
                    synthesis_path = iter_dir / "synthesis.json"
                    break
        if synthesis_path.exists():
            try:
                data = json.loads(synthesis_path.read_text(encoding="utf-8"))
                return synthesis_schema.model_validate(data)
            except Exception as exc:
                logger.warning("Failed to load prior synthesis from %s: %s", synthesis_path, exc)
    return None
