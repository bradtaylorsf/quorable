"""Unit-major score shape (Pack.unit_score_field) + composite persona exclusion.

Covers the integration-round contract additions: the shorts-shaped
`dimension_scores: [{dimension, score, rationale}]` layout flowing through
pack validation, compute_scores, ICC collection, ship gates, and diff score
extraction; and ShipGates.composite_exclude_personas removing red-team
reviews from the composite/floor while their severity-1 findings still block.
"""
from __future__ import annotations

import math
from pathlib import Path

import pytest

from quorable.engine.agreement import compute_agreement
from quorable.engine.loop import check_ship_gates, compute_scores
from quorable.pack import PackError, load_pack

FIXTURES = Path(__file__).parent / "fixtures"
UM_PACK = load_pack(FIXTURES / "toy_pack_unit_major" / "config.yaml")


def _review(
    clarity: int,
    punch: int,
    *,
    persona: str = "fan",
    verdict: str = "hold",
    findings: list[dict] | None = None,
):
    return UM_PACK.review_schema.model_validate({
        "persona": persona,
        "model_id": "test/model",
        "dimension_scores": [
            {"dimension": "clarity", "score": clarity, "rationale": "r"},
            {"dimension": "punch", "score": punch, "rationale": "r"},
        ],
        "verdict": verdict,
        "findings": findings or [],
    })


# ---------------------------------------------------------------------------
# Pack loading / validation
# ---------------------------------------------------------------------------

class TestUnitMajorPackValidation:
    def test_loads_unit_major_pack(self):
        assert UM_PACK.name == "toy_unit_major"
        assert UM_PACK.unit_score_field == "score"
        assert UM_PACK.unit_list_field == "dimension_scores"
        assert UM_PACK.ship_gates.composite_exclude_personas == ["red_team"]

    def test_dimensions_not_required_as_attributes(self):
        """score_dimensions are unit_field VALUES in unit-major mode — the
        item schema has no clarity/punch attributes and still validates."""
        item_fields = set(
            UM_PACK.review_schema.model_fields["dimension_scores"]
            .annotation.__args__[0]
            .model_fields
        )
        assert "clarity" not in item_fields  # would be required in None mode
        assert {"dimension", "score"} <= item_fields

    def test_unit_major_requires_score_field_on_items(self, tmp_path):
        (tmp_path / "pack.py").write_text(
            """
from pydantic import BaseModel

from quorable.pack import Pack, ShipGates


class Item(BaseModel):
    dimension: str
    # no `score` field


class Review(BaseModel):
    dimension_scores: list[Item]
    verdict: str


class Synthesis(BaseModel):
    consensus_weaknesses: list = []


PACK = Pack(
    name="broken_um",
    review_schema=Review,
    synthesis_schema=Synthesis,
    score_dimensions=["clarity"],
    verdict_field="verdict",
    verdict_categories=["hold"],
    canonical_units=["clarity"],
    unit_field="dimension",
    unit_list_field="dimension_scores",
    unit_score_field="score",
    primary_doc_name="doc",
    doc_type_markers={},
    mechanical_gates=[],
    ship_gates=ShipGates(composite_min=8.0, dimension_min=6.0),
)
""",
            encoding="utf-8",
        )
        (tmp_path / "config.yaml").write_text("pack: ./pack.py\n", encoding="utf-8")
        with pytest.raises(PackError, match="no 'score' field"):
            load_pack(tmp_path / "config.yaml")


# ---------------------------------------------------------------------------
# compute_scores in unit-major mode
# ---------------------------------------------------------------------------

class TestUnitMajorScores:
    def test_per_dimension_and_weighted_composite(self):
        reviews = [_review(9, 6)]
        composite, per_dimension = compute_scores(reviews, UM_PACK)
        assert per_dimension == {"clarity": 9.0, "punch": 6.0}
        # weights clarity=2, punch=1 → (9*2 + 6*1)/3 = 8.0
        assert composite == pytest.approx(8.0)

    def test_means_across_reviews(self):
        reviews = [_review(9, 7), _review(7, 5)]
        composite, per_dimension = compute_scores(reviews, UM_PACK)
        assert per_dimension == {"clarity": 8.0, "punch": 6.0}

    def test_unit_name_canonicalization_aligns_variants(self):
        """'1. Clarity (overall)' still lands in the clarity dimension."""
        review = UM_PACK.review_schema.model_validate({
            "persona": "fan",
            "dimension_scores": [
                {"dimension": "1. Clarity (overall)", "score": 9},
                {"dimension": "PUNCH", "score": 6},
            ],
            "verdict": "hold",
        })
        _, per_dimension = compute_scores([review], UM_PACK)
        assert per_dimension == {"clarity": 9.0, "punch": 6.0}


# ---------------------------------------------------------------------------
# composite_exclude_personas
# ---------------------------------------------------------------------------

class TestCompositeExcludePersonas:
    def test_red_team_excluded_from_composite_and_floor(self):
        reviews = [
            _review(9, 9, persona="fan"),
            _review(2, 2, persona="red_team"),  # low BY DESIGN
        ]
        composite, per_dimension = compute_scores(reviews, UM_PACK)
        # Only the fan review counts: composite 9.0, no dimension below floor
        assert composite == pytest.approx(9.0)
        assert per_dimension == {"clarity": 9.0, "punch": 9.0}

    def test_without_exclusion_red_team_would_drag_composite(self):
        """Sanity check that the exclusion is doing real work."""
        reviews = [
            _review(9, 9, persona="fan"),
            _review(2, 2, persona="red_team"),
        ]
        # personas list overrides review.persona — relabel the red team so
        # nothing is excluded, and the pooled composite collapses.
        composite, _ = compute_scores(
            reviews, UM_PACK, personas=["fan", "someone_else"],
        )
        assert composite == pytest.approx(5.5)

    def test_excluded_persona_severity1_finding_still_blocks(self):
        """The red team is out of the composite but its blocking findings
        still gate shipping (findings/blocking channels are untouched)."""
        reviews = [
            _review(9, 9, persona="fan"),
            _review(
                2, 2, persona="red_team",
                findings=[{
                    "severity": 1,
                    "location": "0:12",
                    "issue": "canon break: the barrier is described as new",
                    "suggested_fix": "cut the claim",
                }],
            ),
        ]
        synthesis = UM_PACK.synthesis_schema.model_validate({})
        ok, reasons, composite, per_dimension = check_ship_gates(
            synthesis=synthesis,
            reviews=reviews,
            gate_results={},
            pack=UM_PACK,
        )
        # Composite/floor pass on the fan review alone…
        assert composite == pytest.approx(9.0)
        assert all(m >= UM_PACK.ship_gates.dimension_min for m in per_dimension.values())
        # …but the excluded persona's severity-1 finding still blocks.
        assert not ok
        joined = " | ".join(reasons)
        assert "blocking findings" in joined
        assert "canon break" in joined

    def test_all_reviews_excluded_means_no_scores(self):
        reviews = [_review(9, 9, persona="red_team")]
        composite, per_dimension = compute_scores(reviews, UM_PACK)
        assert composite is None
        assert per_dimension == {}


# ---------------------------------------------------------------------------
# Ship gates end-to-end in unit-major mode
# ---------------------------------------------------------------------------

class TestUnitMajorShipGates:
    def test_passes_when_composite_and_floor_met(self):
        reviews = [_review(9, 8, persona="fan")]
        synthesis = UM_PACK.synthesis_schema.model_validate({})
        ok, reasons, composite, _ = check_ship_gates(
            synthesis=synthesis, reviews=reviews, gate_results={}, pack=UM_PACK,
        )
        assert ok, reasons
        # compute_scores rounds to 4 decimals
        assert composite == pytest.approx((9 * 2 + 8) / 3, abs=1e-4)

    def test_dimension_floor_failure_reported(self):
        reviews = [_review(10, 5, persona="fan")]  # punch below floor of 6
        synthesis = UM_PACK.synthesis_schema.model_validate({})
        ok, reasons, _, _ = check_ship_gates(
            synthesis=synthesis, reviews=reviews, gate_results={}, pack=UM_PACK,
        )
        assert not ok
        assert any("punch=5.00" in r for r in reasons)


# ---------------------------------------------------------------------------
# Agreement statistics in unit-major mode
# ---------------------------------------------------------------------------

class TestUnitMajorAgreement:
    def test_icc_units_pooled_is_meaningful(self):
        # Reviewers consistently differentiate the units → high icc_units
        reviews = [
            _review(9, 3), _review(9, 3), _review(8, 4),
        ]
        result = compute_agreement(reviews, UM_PACK)
        assert result["icc_units"] > 0.5
        # Per-dimension ICC is single-subject in unit-major mode → NaN
        assert math.isnan(result["icc_clarity"])
        assert math.isnan(result["icc_punch"])

    def test_fleiss_kappa_present(self):
        reviews = [_review(9, 3, verdict="hold"), _review(9, 3, verdict="cliff")]
        result = compute_agreement(reviews, UM_PACK)
        assert "fleiss_kappa_verdict" in result

    def test_per_persona_icc_units(self):
        reviews = [
            _review(9, 3, persona="fan"), _review(8, 4, persona="fan"),
            _review(5, 5, persona="red_team"), _review(4, 6, persona="red_team"),
        ]
        personas = ["fan", "fan", "red_team", "red_team"]
        result = compute_agreement(reviews, UM_PACK, personas=personas)
        assert "icc_units__fan" in result
        assert "icc_units__red_team" in result


# ---------------------------------------------------------------------------
# Diff score extraction in unit-major mode
# ---------------------------------------------------------------------------

def test_diff_extracts_unit_major_scores(tmp_path):
    import json

    from quorable.engine.diff import _extract_unit_scores

    raw_dir = tmp_path / "raw_reviews"
    raw_dir.mkdir()
    for i, (clarity, punch) in enumerate([(9, 5), (7, 7)]):
        review = _review(clarity, punch)
        (raw_dir / f"m_fan_run{i}.json").write_text(
            json.dumps(review.model_dump()), encoding="utf-8",
        )

    scores = _extract_unit_scores(UM_PACK, tmp_path)
    assert scores["clarity"] == {"clarity": 8.0}
    assert scores["punch"] == {"punch": 6.0}
