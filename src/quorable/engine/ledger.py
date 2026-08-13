"""Prediction ledger + handoff emission.

Net-new (no parent module). On `quorable handoff RUN`:

- freeze a predictions.yaml row
  {file_id, run_id, iteration_shipped, composite, per_dimension: {...},
   per_persona_verdict: {...}, hypothesis, timestamp}
  ("frozen" = write-once per run_id: an existing row for the same run is
  never overwritten — predictions made before publication must not be
  editable after the outcome is known), and
- emit the deliverables (final script, synthesis.json, synthesis_report.md)
  to the project's handoff destination directory.

`per_persona_verdict` holds the per-persona modal value of the pack's
verdict_field (e.g. predicted retention shape in the shorts domain).
"""
from __future__ import annotations

import json
import logging
import shutil
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import yaml

from quorable.engine.loop import compute_scores

logger = logging.getLogger(__name__)

PREDICTIONS_FILENAME = "predictions.yaml"


class LedgerFrozenError(Exception):
    """Raised when a prediction row for this run_id already exists."""


def latest_iter_dir(run_dir: Path) -> Path | None:
    """Return the latest iter_N subdirectory holding a synthesis, if any."""
    iter_dirs = sorted(
        (d for d in run_dir.iterdir() if d.is_dir() and d.name.startswith("iter_")),
        key=lambda d: d.name,
        reverse=True,
    )
    for d in iter_dirs:
        if (d / "synthesis.json").exists() or any(d.glob("script_v*.md")):
            return d
    return None


def _load_raw_reviews(raw_dir: Path, pack: Any) -> tuple[list[Any], list[str]]:
    """Load validated raw reviews and their personas from a raw_reviews dir.

    Persona is recovered from the review's own `persona` field when present,
    else from the filename convention <model>_<persona>_runN.json.
    """
    reviews: list[Any] = []
    personas: list[str] = []
    if not raw_dir.is_dir():
        return reviews, personas
    for path in sorted(raw_dir.glob("*.json")):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            review = pack.review_schema.model_validate(data)
        except Exception as exc:
            logger.warning("Skipping unparseable review %s: %s", path.name, exc)
            continue
        persona = str(getattr(review, "persona", "") or "")
        if not persona:
            stem_parts = path.stem.rsplit("_run", 1)[0].split("_")
            persona = stem_parts[-1] if stem_parts else "unknown"
        reviews.append(review)
        personas.append(persona)
    return reviews, personas


def per_persona_verdicts(
    reviews: list[Any],
    personas: list[str],
    pack: Any,
) -> dict[str, str]:
    """Modal verdict (pack.verdict_field) per persona."""
    by_persona: dict[str, list[str]] = {}
    for review, persona in zip(reviews, personas):
        verdict = getattr(review, pack.verdict_field, None)
        if verdict is None:
            continue
        by_persona.setdefault(persona, []).append(str(verdict))
    return {
        persona: Counter(vs).most_common(1)[0][0]
        for persona, vs in by_persona.items()
        if vs
    }


def build_prediction_row(
    *,
    run_dir: Path,
    pack: Any,
    file_id: str | None = None,
    hypothesis: str = "",
) -> dict[str, Any]:
    """Build the predictions.yaml row for a run from its artifacts."""
    target_dir = latest_iter_dir(run_dir) or run_dir
    iteration = 0
    if target_dir.name.startswith("iter_"):
        try:
            iteration = int(target_dir.name.removeprefix("iter_"))
        except ValueError:
            iteration = 0

    reviews, personas = _load_raw_reviews(target_dir / "raw_reviews", pack)
    # Same persona-exclusion semantics as the ship gate, so the frozen
    # composite is the number the loop actually gated on.
    composite, per_dimension = compute_scores(reviews, pack, personas=personas)

    scripts = sorted(target_dir.glob("script_v*.md"))
    resolved_file_id = file_id
    if resolved_file_id is None:
        if scripts:
            import hashlib

            text = scripts[-1].read_text(encoding="utf-8")
            digest = hashlib.sha256(text.encode("utf-8")).hexdigest()[:12]
            resolved_file_id = f"{pack.primary_doc_name}_{digest}"
        else:
            resolved_file_id = pack.primary_doc_name

    return {
        "file_id": resolved_file_id,
        "run_id": run_dir.name.removeprefix("run_"),
        "iteration_shipped": iteration,
        "composite": composite,
        "per_dimension": per_dimension,
        "per_persona_verdict": per_persona_verdicts(reviews, personas, pack),
        "hypothesis": hypothesis,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }


def freeze_prediction(
    row: dict[str, Any],
    ledger_path: Path,
) -> Path:
    """Append the row to predictions.yaml, refusing to overwrite (freeze).

    A row for the same run_id may only be written once — the ledger is the
    record of what was predicted BEFORE outcomes were known.
    """
    entries: list[dict[str, Any]] = []
    if ledger_path.exists():
        entries = yaml.safe_load(ledger_path.read_text(encoding="utf-8")) or []

    for existing in entries:
        if existing.get("run_id") == row.get("run_id"):
            raise LedgerFrozenError(
                f"predictions.yaml already has a frozen row for run "
                f"{row.get('run_id')} — predictions are write-once. Delete "
                f"the row manually only if you are certain it was recorded "
                f"in error."
            )

    entries.append(row)
    ledger_path.parent.mkdir(parents=True, exist_ok=True)
    ledger_path.write_text(
        yaml.dump(entries, default_flow_style=False, allow_unicode=True, sort_keys=False),
        encoding="utf-8",
    )
    logger.info("Froze prediction row for run %s in %s", row.get("run_id"), ledger_path)
    return ledger_path


def emit_handoff(
    *,
    run_dir: Path,
    dest_dir: Path,
) -> list[Path]:
    """Copy the run's deliverables into the handoff destination directory.

    Deliverables: the final script, synthesis.json, synthesis_report.md, and
    held-out artifacts when present.
    """
    target_dir = latest_iter_dir(run_dir) or run_dir
    run_label = run_dir.name
    out_dir = dest_dir / run_label
    out_dir.mkdir(parents=True, exist_ok=True)

    emitted: list[Path] = []
    candidates: list[Path] = []
    scripts = sorted(target_dir.glob("script_v*.md"))
    if scripts:
        candidates.append(scripts[-1])
    for name in (
        "synthesis.json",
        "synthesis_report.md",
        "held_out_validation.json",
        "held_out_new_issues.md",
        "gates.json",
    ):
        path = target_dir / name
        if path.exists():
            candidates.append(path)
    # Loop summary lives at the run level
    summary = run_dir / "loop_summary.yaml"
    if summary.exists():
        candidates.append(summary)

    for src in candidates:
        dst = out_dir / src.name
        shutil.copy2(src, dst)
        emitted.append(dst)
        logger.info("Handoff: %s -> %s", src, dst)

    if not emitted:
        logger.warning("No deliverables found in %s — nothing emitted", run_dir)
    return emitted
