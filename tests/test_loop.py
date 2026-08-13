"""Tests for the draft→panel→synthesis→gates→revise loop.

All stage functions are injected fakes — no network, no client. Covers the
three stop conditions (SHIPPABLE / EXHAUSTED / ABORTED-on-budget), the
per-iteration run-directory layout, and the amended blocking_findings
contract (raw-review blockers block shipping even when the synthesis LLM
drops them).
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest
import yaml

from quorable.engine.client import CallRecord, CostTracker
from quorable.engine.loop import (
    LoopStatus,
    check_ship_gates,
    compute_scores,
    run_loop,
)
from quorable.engine.reviewer import ReviewResult

CLEAN_SCRIPT = (
    "HOOK: You are wasting three hours a week on show notes.\n\n"
    "SCRIPT: Showkick fixes that. One upload. Done.\n"
)


@pytest.fixture
def loop_config(toy_config, tmp_path):
    """Toy config with outputs redirected to a temp dir."""
    toy_config.paths.outputs = tmp_path / "runs"
    return toy_config


def _make_review(pack, *, clarity=5, punch=5, verdict="good", persona="praiser",
                 findings=None):
    return pack.review_schema.model_validate({
        "persona": persona,
        "model_id": "test/model",
        "unit_reviews": [
            {"unit": "hook", "clarity": clarity, "punch": punch,
             "verdict": verdict, "weaknesses": []},
            {"unit": "body", "clarity": clarity, "punch": punch,
             "verdict": verdict, "weaknesses": []},
        ],
        "verdict": verdict,
        "confidence": 0.8,
        "findings": findings or [],
    })


def _make_result(review, persona="praiser"):
    return ReviewResult(
        model="test/model", persona=persona, run_number=1,
        review=review, latency_seconds=0.1,
        prompt_tokens_estimate=100, validation_ok=review is not None,
    )


def _make_synthesis(pack, weaknesses=None):
    return pack.synthesis_schema.model_validate({
        "consensus_weaknesses": weaknesses or [],
        "contested_issues": [],
        "ranked_fixes": [],
        "inter_rater_agreement": {},
        "held_out_validator_status": "not_yet_run",
    })


def _stage_fns(pack, *, clarity=5, punch=5, findings=None, weaknesses=None,
               cost_per_panel=0.0, revise_text=None):
    """Build (draft_fn, panel_fn, synthesis_fn) fakes with recorded calls."""
    calls = {"draft": [], "panel": [], "synthesis": []}

    async def draft_fn(mode, *, brief=None, previous_script=None,
                       synthesis=None, cost_tracker=None):
        calls["draft"].append(mode)
        if mode == "draft":
            return CLEAN_SCRIPT
        return revise_text or (previous_script + f"\n<!-- revision {len(calls['draft'])} -->")

    async def panel_fn(script, iter_dir, cost_tracker):
        calls["panel"].append(iter_dir)
        if cost_per_panel:
            cost_tracker.record(CallRecord(
                "test/model", "hash", 0.1, 100, 50, 150, cost_per_panel,
            ))
        return [
            _make_result(_make_review(
                pack, clarity=clarity, punch=punch,
                persona="praiser", findings=findings,
            ), persona="praiser"),
            _make_result(_make_review(
                pack, clarity=clarity, punch=punch, persona="critic",
            ), persona="critic"),
        ]

    async def synthesis_fn(results, script, iter_dir, cost_tracker):
        calls["synthesis"].append(iter_dir)
        synthesis = _make_synthesis(pack, weaknesses=weaknesses)
        (iter_dir / "synthesis.json").write_text(
            json.dumps(synthesis.model_dump()), encoding="utf-8",
        )
        return synthesis

    return draft_fn, panel_fn, synthesis_fn, calls


# ---------------------------------------------------------------------------
# Stop condition 1: ship gates pass -> SHIPPABLE
# ---------------------------------------------------------------------------

async def test_shippable_on_first_iteration(loop_config, toy_pack):
    draft_fn, panel_fn, synthesis_fn, calls = _stage_fns(toy_pack)

    result = await run_loop(
        config=loop_config, pack=toy_pack,
        initial_script=CLEAN_SCRIPT,
        draft_fn=draft_fn, panel_fn=panel_fn, synthesis_fn=synthesis_fn,
    )

    assert result.status is LoopStatus.SHIPPABLE
    assert result.iterations == 1
    assert calls["draft"] == []  # no revision needed
    assert result.iteration_records[0].ship_ok
    assert result.iteration_records[0].composite == pytest.approx(5.0)

    # Per-iteration run dir layout: runs/run_<ts>/iter_1/
    iter_dir = result.run_dir / "iter_1"
    assert (iter_dir / "script_v1.md").exists()
    assert (iter_dir / "gates.json").exists()
    assert (iter_dir / "synthesis.json").exists()
    assert (result.run_dir / "loop_summary.yaml").exists()
    summary = yaml.safe_load((result.run_dir / "loop_summary.yaml").read_text())
    assert summary["status"] == "shippable"


# ---------------------------------------------------------------------------
# Stop condition 2: max_iterations -> EXHAUSTED
# ---------------------------------------------------------------------------

async def test_exhausted_at_max_iterations(loop_config, toy_pack):
    # Low scores never pass ship gates
    draft_fn, panel_fn, synthesis_fn, calls = _stage_fns(toy_pack, clarity=2, punch=2)

    result = await run_loop(
        config=loop_config, pack=toy_pack,
        initial_script=CLEAN_SCRIPT,
        max_iterations=3,
        draft_fn=draft_fn, panel_fn=panel_fn, synthesis_fn=synthesis_fn,
    )

    assert result.status is LoopStatus.EXHAUSTED
    assert result.iterations == 3
    assert calls["draft"] == ["revise", "revise"]  # revised between iters, not after last
    for n in (1, 2, 3):
        assert (result.run_dir / f"iter_{n}" / f"script_v{n}.md").exists()
    # Revisions actually changed the script fed to later iterations
    v1 = (result.run_dir / "iter_1" / "script_v1.md").read_text()
    v2 = (result.run_dir / "iter_2" / "script_v2.md").read_text()
    assert v1 != v2
    assert not result.iteration_records[-1].ship_ok
    assert any("composite" in r for r in result.iteration_records[-1].ship_reasons)


async def test_default_max_iterations_from_config(loop_config, toy_pack):
    # toy config pipeline.max_iterations == 2
    draft_fn, panel_fn, synthesis_fn, _ = _stage_fns(toy_pack, clarity=2, punch=2)
    result = await run_loop(
        config=loop_config, pack=toy_pack,
        initial_script=CLEAN_SCRIPT,
        draft_fn=draft_fn, panel_fn=panel_fn, synthesis_fn=synthesis_fn,
    )
    assert result.status is LoopStatus.EXHAUSTED
    assert result.iterations == 2


# ---------------------------------------------------------------------------
# Stop condition 3: budget -> ABORTED (abort, don't degrade)
# ---------------------------------------------------------------------------

async def test_budget_abort(loop_config, toy_pack):
    draft_fn, panel_fn, synthesis_fn, calls = _stage_fns(
        toy_pack, clarity=2, punch=2, cost_per_panel=1.0,
    )

    result = await run_loop(
        config=loop_config, pack=toy_pack,
        initial_script=CLEAN_SCRIPT,
        max_iterations=5,
        budget=0.5,   # first panel already exceeds this
        draft_fn=draft_fn, panel_fn=panel_fn, synthesis_fn=synthesis_fn,
    )

    assert result.status is LoopStatus.ABORTED
    assert result.abort_reason is not None
    assert "budget" in result.abort_reason.lower() or "cost" in result.abort_reason.lower()
    assert len(calls["panel"]) == 1  # aborted immediately, no further spend
    summary = yaml.safe_load((result.run_dir / "loop_summary.yaml").read_text())
    assert summary["status"] == "aborted"


# ---------------------------------------------------------------------------
# Amended contract: blocking findings computed from RAW reviews
# ---------------------------------------------------------------------------

async def test_raw_review_blocker_blocks_even_when_synthesis_omits_it(
    loop_config, toy_pack,
):
    """A severity-1 finding in a raw review blocks shipping even though the
    synthesis output contains no critical weakness (the synthesis LLM
    silently dropped it)."""
    blocker = {
        "description": "canon drift: claims Showkick edits audio",
        "severity": 1,
        "location": "SCRIPT line 2",
        "suggested_fix": "Cut the audio-editing claim",
    }
    draft_fn, panel_fn, synthesis_fn, _ = _stage_fns(
        toy_pack, clarity=5, punch=5, findings=[blocker], weaknesses=[],
    )

    result = await run_loop(
        config=loop_config, pack=toy_pack,
        initial_script=CLEAN_SCRIPT,
        max_iterations=1,
        draft_fn=draft_fn, panel_fn=panel_fn, synthesis_fn=synthesis_fn,
    )

    assert result.status is LoopStatus.EXHAUSTED  # never SHIPPABLE
    record = result.iteration_records[0]
    assert not record.ship_ok
    assert any("blocking findings" in r for r in record.ship_reasons)
    assert any("canon drift" in r for r in record.ship_reasons)


async def test_synthesis_critical_weakness_also_blocks(loop_config, toy_pack):
    weaknesses = [{
        "description": "hook contradicts canon",
        "unit": "hook",
        "severity": "critical",
        "reviewer_count": 2,
        "suggested_fix": "rewrite hook",
    }]
    draft_fn, panel_fn, synthesis_fn, _ = _stage_fns(
        toy_pack, clarity=5, punch=5, weaknesses=weaknesses,
    )
    result = await run_loop(
        config=loop_config, pack=toy_pack,
        initial_script=CLEAN_SCRIPT,
        max_iterations=1,
        draft_fn=draft_fn, panel_fn=panel_fn, synthesis_fn=synthesis_fn,
    )
    assert result.status is LoopStatus.EXHAUSTED
    assert any(
        "blocking findings" in r
        for r in result.iteration_records[0].ship_reasons
    )


# ---------------------------------------------------------------------------
# Mechanical gates inside the loop
# ---------------------------------------------------------------------------

async def test_failing_mechanical_gate_blocks_shipping(loop_config, toy_pack):
    dirty_script = CLEAN_SCRIPT + "\nTODO: fix the outro\n"
    draft_fn, panel_fn, synthesis_fn, _ = _stage_fns(toy_pack)

    result = await run_loop(
        config=loop_config, pack=toy_pack,
        initial_script=dirty_script,
        max_iterations=1,
        draft_fn=draft_fn, panel_fn=panel_fn, synthesis_fn=synthesis_fn,
    )

    assert result.status is LoopStatus.EXHAUSTED
    record = result.iteration_records[0]
    assert not record.gates_passed
    assert any("mechanical gates failed" in r for r in record.ship_reasons)
    gates = json.loads((result.run_dir / "iter_1" / "gates.json").read_text())
    assert not gates["banned_elements"]["passed"]


# ---------------------------------------------------------------------------
# Drafting from a brief / single-pass mode
# ---------------------------------------------------------------------------

async def test_initial_draft_from_brief(loop_config, toy_pack):
    draft_fn, panel_fn, synthesis_fn, calls = _stage_fns(toy_pack)
    result = await run_loop(
        config=loop_config, pack=toy_pack,
        brief="30-second short about show notes",
        draft_fn=draft_fn, panel_fn=panel_fn, synthesis_fn=synthesis_fn,
    )
    assert result.status is LoopStatus.SHIPPABLE
    assert calls["draft"] == ["draft"]
    assert result.final_script == CLEAN_SCRIPT


async def test_no_draft_forces_single_pass(loop_config, toy_pack):
    draft_fn, panel_fn, synthesis_fn, calls = _stage_fns(toy_pack, clarity=2, punch=2)
    result = await run_loop(
        config=loop_config, pack=toy_pack,
        initial_script=CLEAN_SCRIPT,
        max_iterations=4,
        no_draft=True,
        draft_fn=draft_fn, panel_fn=panel_fn, synthesis_fn=synthesis_fn,
    )
    assert result.status is LoopStatus.EXHAUSTED
    assert result.iterations == 1
    assert calls["draft"] == []  # never revises in single-pass mode


async def test_failed_revision_aborts(loop_config, toy_pack):
    _, panel_fn, synthesis_fn, _ = _stage_fns(toy_pack, clarity=2, punch=2)

    async def failing_draft(mode, **kwargs):
        return None

    result = await run_loop(
        config=loop_config, pack=toy_pack,
        initial_script=CLEAN_SCRIPT,
        max_iterations=3,
        draft_fn=failing_draft, panel_fn=panel_fn, synthesis_fn=synthesis_fn,
    )
    assert result.status is LoopStatus.ABORTED
    assert "revision failed" in (result.abort_reason or "")


# ---------------------------------------------------------------------------
# Score helpers
# ---------------------------------------------------------------------------

def test_compute_scores_weighted(toy_pack):
    reviews = [
        toy_pack.review_schema.model_validate({
            "unit_reviews": [
                {"unit": "hook", "clarity": 5, "punch": 1, "verdict": "good"},
            ],
            "verdict": "good",
        }),
    ]
    composite, per_dimension = compute_scores(reviews, toy_pack)
    assert per_dimension == {"clarity": 5.0, "punch": 1.0}
    assert composite == pytest.approx(3.0)  # equal weights


def test_check_ship_gates_reports_all_reasons(toy_pack):
    reviews = [
        toy_pack.review_schema.model_validate({
            "unit_reviews": [
                {"unit": "hook", "clarity": 2, "punch": 2, "verdict": "bad"},
            ],
            "verdict": "bad",
        }),
    ]
    ok, reasons, composite, dims = check_ship_gates(
        synthesis=None, reviews=reviews, gate_results={}, pack=toy_pack,
    )
    assert not ok
    joined = " | ".join(reasons)
    assert "no synthesis" in joined
    assert "composite" in joined
    assert "dimensions below min" in joined
