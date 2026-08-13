"""Unit-major toy pack: the shorts-shaped score layout.

Each per-unit object carries its dimension name in `dimension` plus a single
numeric `score` (Pack.unit_score_field="score"), unlike the attribute-style
toy pack. Includes a red-team persona excluded from composite/floor stats.
"""
from typing import Literal

from pydantic import BaseModel, Field

from quorable.engine.gates import banned_elements_gate, word_count_gate
from quorable.engine.schemas import ContestedIssue, RankedFix, Weakness
from quorable.pack import Pack, ShipGates


class Finding(BaseModel):
    severity: int = Field(ge=1, le=5)
    location: str = ""
    issue: str = ""
    suggested_fix: str = ""


class DimensionScore(BaseModel):
    dimension: str
    score: int = Field(ge=1, le=10)
    rationale: str = ""
    suggested_fix: str | None = None


class UMReview(BaseModel):
    persona: str = ""
    model_id: str = ""
    dimension_scores: list[DimensionScore]
    verdict: Literal["cliff", "hold"]
    findings: list[Finding] = Field(default_factory=list)


class UMSynthesis(BaseModel):
    consensus_weaknesses: list[Weakness] = Field(default_factory=list)
    contested_issues: list[ContestedIssue] = Field(default_factory=list)
    ranked_fixes: list[RankedFix] = Field(default_factory=list)
    inter_rater_agreement: dict[str, float] = Field(default_factory=dict)
    held_out_validator_status: str = "not_yet_run"


def _blocking_findings(
    synthesis: UMSynthesis | None,
    reviews: list[UMReview],
) -> list[str]:
    """Severity-1 findings from ANY raw review block shipping — including
    reviews from composite-excluded personas."""
    return [
        f.issue
        for review in reviews
        for f in review.findings
        if f.severity == 1
    ]


PACK = Pack(
    name="toy_unit_major",
    review_schema=UMReview,
    synthesis_schema=UMSynthesis,
    score_dimensions=["clarity", "punch"],
    verdict_field="verdict",
    verdict_categories=["cliff", "hold"],
    canonical_units=["clarity", "punch"],
    unit_field="dimension",
    unit_list_field="dimension_scores",
    unit_score_field="score",
    primary_doc_name="script_draft",
    doc_type_markers={},
    mechanical_gates=[
        word_count_gate(120),
        banned_elements_gate([r"\bTODO\b"]),
    ],
    ship_gates=ShipGates(
        composite_min=8.0,
        dimension_min=6.0,
        blocking_findings=_blocking_findings,
        weights={"clarity": 2.0, "punch": 1.0},
        composite_exclude_personas=["red_team"],
    ),
    drafter_enabled=True,
)
