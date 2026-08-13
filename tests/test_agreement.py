"""Tests for inter-rater agreement statistics.

Ported from the parent's test_agreement — the Fleiss' kappa and ICC math is
unchanged; dimension/category constants now come from the toy pack.
"""
from __future__ import annotations

import math
from pathlib import Path

from quorable.engine.agreement import (
    LOW_AGREEMENT_THRESHOLD,
    compute_agreement,
    fleiss_kappa,
    get_contested_dimensions,
    icc_oneway,
    normalize_unit_name,
)
from quorable.pack import load_pack

FIXTURES = Path(__file__).parent / "fixtures"
PACK = load_pack(FIXTURES / "toy_pack" / "config.yaml")
ToyReview = PACK.review_schema

KAPPA_KW = dict(
    verdict_field=PACK.verdict_field,
    verdict_categories=PACK.verdict_categories,
    unit_field=PACK.unit_field,
)


def _make_unit(
    unit: str = "hook",
    clarity: int = 3,
    punch: int = 3,
    verdict: str = "good",
) -> dict:
    return {
        "unit": unit,
        "clarity": clarity,
        "punch": punch,
        "verdict": verdict,
        "weaknesses": [],
    }


def _make_review(
    verdict: str = "good",
    units: list[dict] | None = None,
    persona: str = "praiser",
):
    return ToyReview.model_validate({
        "persona": persona,
        "model_id": "test/model",
        "unit_reviews": units or [_make_unit(verdict=verdict)],
        "verdict": verdict,
        "confidence": 0.7,
        "findings": [],
    })


# ---------------------------------------------------------------------------
# Fleiss' kappa
# ---------------------------------------------------------------------------

class TestFleissKappa:
    def test_perfect_agreement(self):
        """All raters agree on every subject -> kappa is undefined (NaN).

        When p_e = 1.0 (all ratings fall in one category), the denominator
        of kappa is zero. Returning NaN is mathematically correct — the
        statistic is undefined, not "perfect agreement."
        """
        reviews = [_make_review("good") for _ in range(10)]
        assert math.isnan(fleiss_kappa(reviews, **KAPPA_KW))

    def test_no_agreement(self):
        """Raters disagree on units -> kappa near 0 or negative."""
        units_a = [_make_unit("hook", verdict="good"), _make_unit("body", verdict="bad")]
        units_b = [_make_unit("hook", verdict="bad"), _make_unit("body", verdict="good")]
        units_c = [_make_unit("hook", verdict="mixed"), _make_unit("body", verdict="mixed")]
        reviews = (
            [_make_review(units=units_a) for _ in range(4)]
            + [_make_review(units=units_b) for _ in range(4)]
            + [_make_review(units=units_c) for _ in range(4)]
        )
        kappa = fleiss_kappa(reviews, **KAPPA_KW)
        assert kappa < 0.3

    def test_partial_agreement(self):
        """Most raters agree on most units -> kappa positive."""
        agree_units = [
            _make_unit("hook", verdict="good"),
            _make_unit("body", verdict="bad"),
            _make_unit("outro", verdict="good"),
        ]
        dissent_units = [
            _make_unit("hook", verdict="bad"),
            _make_unit("body", verdict="good"),
            _make_unit("outro", verdict="mixed"),
        ]
        reviews = (
            [_make_review(units=agree_units) for _ in range(8)]
            + [_make_review(units=dissent_units) for _ in range(2)]
        )
        kappa = fleiss_kappa(reviews, **KAPPA_KW)
        assert kappa > 0

    def test_single_review_returns_nan(self):
        """Fewer than 2 raters -> NaN."""
        assert math.isnan(fleiss_kappa([_make_review()], **KAPPA_KW))

    def test_empty_returns_nan(self):
        assert math.isnan(fleiss_kappa([], **KAPPA_KW))

    def test_two_raters_agree(self):
        """Two raters, same verdict on all units — kappa undefined (NaN)."""
        reviews = [_make_review("bad"), _make_review("bad")]
        assert math.isnan(fleiss_kappa(reviews, **KAPPA_KW))

    def test_two_raters_disagree(self):
        reviews = [_make_review("bad"), _make_review("good")]
        kappa = fleiss_kappa(reviews, **KAPPA_KW)
        assert kappa < 0


# ---------------------------------------------------------------------------
# ICC (one-way random, single measures) — math verbatim from parent
# ---------------------------------------------------------------------------

class TestICC:
    def test_perfect_agreement(self):
        """All raters give the same scores -> ICC = 1.0."""
        scores = [[3.0, 3.0, 3.0], [4.0, 4.0, 4.0], [2.0, 2.0, 2.0]]
        assert icc_oneway(scores) == 1.0

    def test_no_agreement(self):
        """Random/opposing scores -> ICC near 0 or negative."""
        scores = [[1.0, 5.0, 3.0], [5.0, 1.0, 3.0], [3.0, 3.0, 3.0]]
        icc = icc_oneway(scores)
        assert icc < 0.5

    def test_moderate_agreement(self):
        """Scores close but not identical -> positive ICC."""
        scores = [[3.0, 4.0, 3.0], [2.0, 2.0, 3.0], [5.0, 5.0, 4.0]]
        icc = icc_oneway(scores)
        assert 0 < icc < 1.0

    def test_empty_returns_nan(self):
        assert math.isnan(icc_oneway([]))

    def test_single_subject_returns_nan(self):
        assert math.isnan(icc_oneway([[3.0, 4.0]]))

    def test_single_rater_per_subject_returns_nan(self):
        assert math.isnan(icc_oneway([[3.0], [4.0]]))


# ---------------------------------------------------------------------------
# Unit-name normalization
# ---------------------------------------------------------------------------

class TestNormalizeUnitName:
    def test_strips_numbering_and_parentheticals(self):
        assert normalize_unit_name("1. Hook (cold open)") == "hook"

    def test_keyword_rules_take_priority(self):
        rules = [("cold open", "hook"), ("cta", "outro")]
        assert normalize_unit_name("The Cold Open bit", rules) == "hook"
        assert normalize_unit_name("CTA section", rules) == "outro"

    def test_case_and_whitespace(self):
        assert normalize_unit_name("  BODY  ") == "body"


# ---------------------------------------------------------------------------
# Full compute_agreement (pack-driven)
# ---------------------------------------------------------------------------

class TestComputeAgreement:
    def test_returns_all_keys(self):
        reviews = [_make_review() for _ in range(6)]
        result = compute_agreement(reviews, PACK)
        assert "fleiss_kappa_verdict" in result
        assert "icc_clarity" in result
        assert "icc_punch" in result
        assert len(result) == 3  # 1 kappa + 2 ICC dimensions

    def test_with_multiple_units(self):
        """Reviews with multiple units produce valid ICC keys."""
        units = [
            _make_unit("hook", clarity=4),
            _make_unit("body", clarity=2),
        ]
        reviews = [_make_review(units=units) for _ in range(6)]
        result = compute_agreement(reviews, PACK)
        assert "icc_clarity" in result

    def test_per_persona_icc_keys(self):
        units_hi = [_make_unit("hook", clarity=5), _make_unit("body", clarity=4)]
        units_lo = [_make_unit("hook", clarity=2), _make_unit("body", clarity=1)]
        reviews = (
            [_make_review(units=units_hi, persona="praiser") for _ in range(2)]
            + [_make_review(units=units_lo, persona="critic") for _ in range(2)]
        )
        personas = ["praiser", "praiser", "critic", "critic"]
        result = compute_agreement(reviews, PACK, personas=personas)
        assert "icc_clarity__praiser" in result
        assert "icc_clarity__critic" in result

    def test_persona_length_mismatch_skips_per_persona(self):
        reviews = [_make_review() for _ in range(4)]
        result = compute_agreement(reviews, PACK, personas=["praiser"])
        assert not any("__" in k for k in result)


class TestGetContestedDimensions:
    def test_flags_low_agreement(self):
        agreement = {
            "fleiss_kappa_verdict": 0.8,
            "icc_clarity": 0.1,
            "icc_punch": 0.9,
        }
        contested = get_contested_dimensions(agreement)
        assert "clarity" in contested
        assert "punch" not in contested

    def test_ignores_nan(self):
        agreement = {
            "icc_clarity": float("nan"),
        }
        assert get_contested_dimensions(agreement) == []

    def test_empty_agreement(self):
        assert get_contested_dimensions({}) == []

    def test_threshold_boundary(self):
        agreement = {"icc_clarity": LOW_AGREEMENT_THRESHOLD}
        assert get_contested_dimensions(agreement) == []
