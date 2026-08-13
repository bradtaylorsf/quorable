"""Tests for the golden-set harness (mechanical tier, pack-gate detectors)."""
from __future__ import annotations

import pytest

from quorable.engine.golden import format_golden_report, run_golden


async def test_mechanical_recall_on_toy_golden(toy_config, toy_pack):
    outcomes, report = await run_golden(toy_config, toy_pack, live=False)

    by_id = {o.case_id: o for o in outcomes}
    seeded = by_id["seeded_defects"]

    caught = {d.defect_id: d.caught for d in seeded.outcomes}
    # All three mechanical defects are caught by the pack gates
    assert caught == {
        "bad_alias": True,
        "leftover_todo": True,
        "overlength": True,
    }
    # The llm defect is skipped in mechanical mode, not silently dropped
    assert seeded.skipped_live == 1

    # Negative control: no false positives from any pack gate
    control = by_id["clean_control"]
    assert control.negative_control
    assert control.false_positives == []

    assert "Recall: 3/3" in report
    assert "llm defects skipped" in report


async def test_unknown_detector_is_a_miss_not_a_crash(toy_config, toy_pack, tmp_path):
    golden_dir = tmp_path / "golden"
    golden_dir.mkdir()
    (golden_dir / "doc.md").write_text("clean text", encoding="utf-8")
    (golden_dir / "manifest.yaml").write_text(
        """
cases:
  - id: bad_detector_case
    path: doc.md
    defects:
      - id: typo_detector
        detector: not_a_real_gate
        expect: "whatever"
""",
        encoding="utf-8",
    )
    outcomes, report = await run_golden(
        toy_config, toy_pack, golden_dir=golden_dir, live=False,
    )
    outcome = outcomes[0].outcomes[0]
    assert not outcome.caught
    assert "not a pack gate" in outcome.detail
    assert "MISSED" in report


async def test_missing_golden_manifest_raises(toy_config, toy_pack, tmp_path):
    with pytest.raises(FileNotFoundError, match="Golden manifest not found"):
        await run_golden(
            toy_config, toy_pack, golden_dir=tmp_path / "nope", live=False,
        )


def test_format_report_negative_control_section():
    from quorable.engine.golden import CaseOutcome, DefectOutcome

    outcomes = [
        CaseOutcome(
            case_id="ctrl", negative_control=True,
            false_positives=["term_lint: found 'X'"],
        ),
        CaseOutcome(
            case_id="seeded", negative_control=False,
            outcomes=[DefectOutcome("d1", "term_lint", "X", True)],
        ),
    ]
    report = format_golden_report(outcomes, live=False)
    assert "False positives (1)" in report
    assert "Recall: 1/1" in report
