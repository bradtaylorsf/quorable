"""Tests for the prediction ledger + handoff emission."""
from __future__ import annotations

import json
from pathlib import Path

import pytest
import yaml

from quorable.engine.ledger import (
    LedgerFrozenError,
    build_prediction_row,
    emit_handoff,
    freeze_prediction,
    latest_iter_dir,
    per_persona_verdicts,
)


def _write_review(raw_dir: Path, name: str, review) -> None:
    raw_dir.mkdir(parents=True, exist_ok=True)
    (raw_dir / name).write_text(
        json.dumps(review.model_dump()), encoding="utf-8",
    )


def _make_review(pack, persona: str, verdict: str, clarity: int = 4):
    return pack.review_schema.model_validate({
        "persona": persona,
        "model_id": "test/model",
        "unit_reviews": [
            {"unit": "hook", "clarity": clarity, "punch": clarity, "verdict": verdict},
        ],
        "verdict": verdict,
    })


@pytest.fixture
def fake_run_dir(tmp_path, toy_pack):
    """A run directory shaped like a finished 2-iteration loop run."""
    run_dir = tmp_path / "run_20260720_120000"
    for n, (verdict, clarity) in enumerate([("bad", 2), ("good", 4)], start=1):
        iter_dir = run_dir / f"iter_{n}"
        iter_dir.mkdir(parents=True)
        (iter_dir / f"script_v{n}.md").write_text(f"script v{n}", encoding="utf-8")
        (iter_dir / "synthesis.json").write_text("{}", encoding="utf-8")
        raw = iter_dir / "raw_reviews"
        _write_review(raw, "m_praiser_run1.json", _make_review(toy_pack, "praiser", verdict, clarity))
        _write_review(raw, "m_critic_run1.json", _make_review(toy_pack, "critic", verdict, clarity))
    (run_dir / "loop_summary.yaml").write_text("status: shippable\n", encoding="utf-8")
    return run_dir


def test_latest_iter_dir(fake_run_dir):
    assert latest_iter_dir(fake_run_dir).name == "iter_2"


def test_build_prediction_row(fake_run_dir, toy_pack):
    row = build_prediction_row(run_dir=fake_run_dir, pack=toy_pack, hypothesis="h1")
    assert row["run_id"] == "20260720_120000"
    assert row["iteration_shipped"] == 2
    assert row["composite"] == pytest.approx(4.0)
    assert row["per_dimension"] == {"clarity": 4.0, "punch": 4.0}
    assert row["per_persona_verdict"] == {"praiser": "good", "critic": "good"}
    assert row["hypothesis"] == "h1"
    assert row["file_id"].startswith("script_draft_")
    assert row["timestamp"]


def test_freeze_prediction_appends(tmp_path, fake_run_dir, toy_pack):
    ledger = tmp_path / "handoff" / "predictions.yaml"
    row = build_prediction_row(run_dir=fake_run_dir, pack=toy_pack)
    freeze_prediction(row, ledger)
    entries = yaml.safe_load(ledger.read_text())
    assert len(entries) == 1
    assert entries[0]["run_id"] == "20260720_120000"


def test_freeze_prediction_is_write_once(tmp_path, fake_run_dir, toy_pack):
    ledger = tmp_path / "predictions.yaml"
    row = build_prediction_row(run_dir=fake_run_dir, pack=toy_pack)
    freeze_prediction(row, ledger)
    with pytest.raises(LedgerFrozenError, match="write-once"):
        freeze_prediction(row, ledger)
    # The original row is untouched
    entries = yaml.safe_load(ledger.read_text())
    assert len(entries) == 1


def test_emit_handoff_copies_deliverables(tmp_path, fake_run_dir):
    dest = tmp_path / "handoff"
    emitted = emit_handoff(run_dir=fake_run_dir, dest_dir=dest)
    names = {p.name for p in emitted}
    assert "script_v2.md" in names
    assert "synthesis.json" in names
    assert "loop_summary.yaml" in names
    assert all(p.exists() for p in emitted)
    # Emitted under a run-labeled subdirectory
    assert all(p.parent.name == "run_20260720_120000" for p in emitted)


def test_per_persona_verdicts_modal(toy_pack):
    reviews = [
        _make_review(toy_pack, "critic", "bad"),
        _make_review(toy_pack, "critic", "good"),
        _make_review(toy_pack, "critic", "bad"),
        _make_review(toy_pack, "praiser", "good"),
    ]
    personas = ["critic", "critic", "critic", "praiser"]
    verdicts = per_persona_verdicts(reviews, personas, toy_pack)
    assert verdicts == {"critic": "bad", "praiser": "good"}
