"""Run diff command.

Forked from the reference implementation's diff module and genericized: compares two pipeline runs via
the pack's schemas — new weaknesses, resolved weaknesses, score deltas per
unit (pack.score_dimensions from raw reviews), and held-out status changes.
"""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from pydantic import BaseModel

logger = logging.getLogger(__name__)


@dataclass
class ScoreDelta:
    """Score change for a unit between two runs."""

    unit: str
    dimension: str
    score_a: float
    score_b: float

    @property
    def delta(self) -> float:
        return self.score_b - self.score_a


@dataclass
class DiffResult:
    """Result of comparing two pipeline runs."""

    run_a_id: str
    run_b_id: str
    new_weaknesses: list[str] = field(default_factory=list)
    resolved_weaknesses: list[str] = field(default_factory=list)
    score_deltas: list[ScoreDelta] = field(default_factory=list)
    status_a: str = "not_yet_run"
    status_b: str = "not_yet_run"
    fix_count_a: int = 0
    fix_count_b: int = 0
    weakness_count_a: int = 0
    weakness_count_b: int = 0


def _resolve_run_dir(run_ref: str, outputs_dir: Path) -> Path:
    """Resolve a run reference (ID or path) to a directory."""
    # Try as a direct path first
    as_path = Path(run_ref)
    if as_path.is_dir():
        return as_path

    # Try as a run ID under outputs_dir
    run_dir = outputs_dir / f"run_{run_ref}"
    if run_dir.is_dir():
        return run_dir

    # Try as-is under outputs_dir
    run_dir = outputs_dir / run_ref
    if run_dir.is_dir():
        return run_dir

    raise FileNotFoundError(
        f"Cannot find run directory for '{run_ref}'. "
        f"Tried: {as_path}, {outputs_dir / f'run_{run_ref}'}, {outputs_dir / run_ref}"
    )


def _synthesis_dir(run_dir: Path) -> Path:
    """Return the directory holding synthesis.json for a run.

    Loop runs store per-iteration outputs in iter_N subdirectories; the
    latest iteration with a synthesis represents the run.
    """
    if (run_dir / "synthesis.json").exists():
        return run_dir
    iter_dirs = sorted(
        (d for d in run_dir.iterdir() if d.is_dir() and d.name.startswith("iter_")),
        key=lambda d: d.name,
        reverse=True,
    )
    for iter_dir in iter_dirs:
        if (iter_dir / "synthesis.json").exists():
            return iter_dir
    return run_dir


def _load_synthesis(run_dir: Path, synthesis_schema: type[BaseModel]) -> BaseModel:
    """Load synthesis.json from a run directory (or its latest iteration)."""
    path = _synthesis_dir(run_dir) / "synthesis.json"
    if not path.exists():
        raise FileNotFoundError(f"No synthesis.json in {run_dir}")
    data = json.loads(path.read_text(encoding="utf-8"))
    return synthesis_schema.model_validate(data)


def _extract_unit_scores(
    pack: Any,
    run_dir: Path,
) -> dict[str, dict[str, float]]:
    """Extract average scores per unit from raw review JSONs.

    Returns {unit_name: {dimension: avg_score}}.
    """
    scores: dict[str, dict[str, float]] = {}
    raw_dir = _synthesis_dir(run_dir) / "raw_reviews"
    if not raw_dir.is_dir():
        return scores

    from quorable.engine.agreement import _unit_score_for_dimension

    dimensions = list(pack.score_dimensions)
    unit_list_field = getattr(pack, "unit_list_field", "unit_reviews")
    unit_score_field = getattr(pack, "unit_score_field", None)
    keyword_rules = tuple(getattr(pack, "unit_keyword_rules", ()) or ())

    # Accumulate per-unit per-dimension scores across all reviews (both
    # score shapes — in unit-major mode each unit contributes only its own
    # dimension's column).
    accum: dict[str, dict[str, list[float]]] = {}
    for review_path in sorted(raw_dir.glob("*.json")):
        try:
            data = json.loads(review_path.read_text(encoding="utf-8"))
            review = pack.review_schema.model_validate(data)
            for unit in getattr(review, unit_list_field, None) or []:
                unit_name = str(getattr(unit, pack.unit_field, ""))
                if unit_name not in accum:
                    accum[unit_name] = {d: [] for d in dimensions}
                for dim in dimensions:
                    value = _unit_score_for_dimension(
                        unit, dim,
                        unit_field=pack.unit_field,
                        unit_score_field=unit_score_field,
                        keyword_rules=keyword_rules,
                    )
                    if value is not None:
                        accum[unit_name][dim].append(value)
        except Exception as exc:
            logger.warning("Failed to load raw review %s: %s", review_path.name, exc)

    for unit_name, dims in accum.items():
        scores[unit_name] = {
            dim: round(sum(vals) / len(vals), 2)
            for dim, vals in dims.items()
            if vals
        }
    return scores


def compare_runs(
    *,
    run_a: str,
    run_b: str,
    outputs_dir: Path,
    pack: Any,
) -> DiffResult:
    """Compare two pipeline runs and compute their diff."""
    dir_a = _resolve_run_dir(run_a, outputs_dir)
    dir_b = _resolve_run_dir(run_b, outputs_dir)

    synth_a = _load_synthesis(dir_a, pack.synthesis_schema)
    synth_b = _load_synthesis(dir_b, pack.synthesis_schema)

    # Weakness diff
    descs_a = {w.description for w in getattr(synth_a, "consensus_weaknesses", []) or []}
    descs_b = {w.description for w in getattr(synth_b, "consensus_weaknesses", []) or []}

    new_weaknesses = sorted(descs_b - descs_a)
    resolved_weaknesses = sorted(descs_a - descs_b)

    # Score deltas across all dimensions from raw reviews
    scores_a = _extract_unit_scores(pack, dir_a)
    scores_b = _extract_unit_scores(pack, dir_b)

    score_deltas: list[ScoreDelta] = []
    all_units = set(scores_a.keys()) | set(scores_b.keys())
    for unit in sorted(all_units):
        dims_a = scores_a.get(unit, {})
        dims_b = scores_b.get(unit, {})
        all_dims = set(dims_a.keys()) | set(dims_b.keys())
        for dim in sorted(all_dims):
            val_a = dims_a.get(dim, 0.0)
            val_b = dims_b.get(dim, 0.0)
            if val_a != val_b:
                score_deltas.append(ScoreDelta(
                    unit=unit,
                    dimension=dim,
                    score_a=val_a,
                    score_b=val_b,
                ))

    # Extract run IDs from directory names
    run_a_id = dir_a.name.removeprefix("run_")
    run_b_id = dir_b.name.removeprefix("run_")

    return DiffResult(
        run_a_id=run_a_id,
        run_b_id=run_b_id,
        new_weaknesses=new_weaknesses,
        resolved_weaknesses=resolved_weaknesses,
        score_deltas=score_deltas,
        status_a=getattr(synth_a, "held_out_validator_status", "not_yet_run"),
        status_b=getattr(synth_b, "held_out_validator_status", "not_yet_run"),
        fix_count_a=len(getattr(synth_a, "ranked_fixes", []) or []),
        fix_count_b=len(getattr(synth_b, "ranked_fixes", []) or []),
        weakness_count_a=len(descs_a),
        weakness_count_b=len(descs_b),
    )


def format_diff(result: DiffResult) -> str:
    """Format a DiffResult as a rich-compatible string."""
    lines: list[str] = []

    lines.append(f"[bold]Run Diff: {result.run_a_id} → {result.run_b_id}[/bold]\n")

    # Summary
    lines.append(f"Weaknesses: {result.weakness_count_a} → {result.weakness_count_b}")
    lines.append(f"Ranked fixes: {result.fix_count_a} → {result.fix_count_b}")
    lines.append(
        f"Held-out status: {result.status_a} → {result.status_b}"
    )
    lines.append("")

    # New weaknesses
    if result.new_weaknesses:
        lines.append(f"[bold red]New weaknesses ({len(result.new_weaknesses)}):[/bold red]")
        for w in result.new_weaknesses:
            lines.append(f"  + {w}")
        lines.append("")

    # Resolved weaknesses
    if result.resolved_weaknesses:
        lines.append(
            f"[bold green]Resolved weaknesses ({len(result.resolved_weaknesses)}):[/bold green]"
        )
        for w in result.resolved_weaknesses:
            lines.append(f"  - {w}")
        lines.append("")

    # Score deltas
    if result.score_deltas:
        lines.append("[bold]Score changes:[/bold]")
        for sd in result.score_deltas:
            direction = "+" if sd.delta > 0 else ""
            color = "green" if sd.delta > 0 else "red"
            dim_label = sd.dimension.replace("_", " ").title()
            lines.append(
                f"  [{color}]{sd.unit} ({dim_label}): "
                f"{sd.score_a:.1f} → {sd.score_b:.1f} "
                f"({direction}{sd.delta:.1f})[/{color}]"
            )
        lines.append("")

    if not result.new_weaknesses and not result.resolved_weaknesses and not result.score_deltas:
        lines.append("[dim]No significant differences found.[/dim]")

    return "\n".join(lines)
