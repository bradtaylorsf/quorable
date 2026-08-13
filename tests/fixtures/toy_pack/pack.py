"""Toy pack: the minimal project used to test the engine pack-independently.

Two score dimensions (clarity, punch), two canonical units (hook, body),
two personas, and the three engine gate batteries.
"""
from typing import Literal

from pydantic import BaseModel, Field

from quorable.engine.gates import (
    banned_elements_gate,
    term_lint_gate,
    word_count_gate,
)
from quorable.engine.schemas import ContestedIssue, Finding, RankedFix, Weakness
from quorable.pack import Pack, ShipGates


class UnitScore(BaseModel):
    unit: str
    clarity: int = Field(ge=1, le=5)
    punch: int = Field(ge=1, le=5)
    verdict: Literal["good", "mixed", "bad"]
    weaknesses: list[str] = Field(default_factory=list)


class ToyReview(BaseModel):
    persona: str = ""
    model_id: str = ""
    unit_reviews: list[UnitScore]
    verdict: Literal["good", "mixed", "bad"]
    confidence: float = Field(ge=0, le=1, default=0.5)
    findings: list[Finding] = Field(default_factory=list)
    suspected_prompt_injection: list[str] = Field(default_factory=list)


class ToySynthesis(BaseModel):
    consensus_weaknesses: list[Weakness]
    contested_issues: list[ContestedIssue] = Field(default_factory=list)
    ranked_fixes: list[RankedFix] = Field(default_factory=list)
    inter_rater_agreement: dict[str, float] = Field(default_factory=dict)
    held_out_validator_status: str = "not_yet_run"


def _blocking_findings(
    synthesis: ToySynthesis | None,
    reviews: list[ToyReview],
) -> list[str]:
    """Product-truth guard, computed from ground truth in code.

    Severity-1 findings in the RAW reviews block shipping even when the
    synthesis LLM silently drops them; synthesis-level critical weaknesses
    block too.
    """
    blockers: list[str] = []
    for review in reviews:
        for finding in review.findings:
            if finding.severity == 1:
                blockers.append(finding.description)
    if synthesis is not None:
        blockers.extend(
            w.description
            for w in synthesis.consensus_weaknesses
            if w.severity == "critical"
        )
    return blockers


PACK = Pack(
    name="toy",
    review_schema=ToyReview,
    synthesis_schema=ToySynthesis,
    score_dimensions=["clarity", "punch"],
    verdict_field="verdict",
    verdict_categories=["good", "mixed", "bad"],
    canonical_units=["hook", "body"],
    unit_field="unit",
    primary_doc_name="script_draft",
    doc_type_markers={
        "script": ["HOOK:", "SCRIPT:"],
        "brief": ["BRIEF:"],
    },
    mechanical_gates=[
        word_count_gate(120),
        term_lint_gate({"Showkick": ["Show Kick", "showkick"]}),
        banned_elements_gate([r"\bTODO\b"]),
    ],
    ship_gates=ShipGates(
        composite_min=4.0,
        dimension_min=3.0,
        blocking_findings=_blocking_findings,
        weights={"clarity": 1.0, "punch": 1.0},
    ),
    drafter_enabled=True,
    held_out_recommended_docs=["canon"],
)
