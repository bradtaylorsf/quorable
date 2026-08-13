"""Engine-owned pydantic models.

The Stage 1 review schema and Stage 2 synthesis schema are supplied by the
project's Pack, not the engine. This module keeps only:

- the Document model (parsed inputs), and
- conventional building blocks packs are expected to reuse (or mirror
  field-for-field) so the engine's reports/diff/regressions can render any
  pack's output: Finding, Weakness, ContestedIssue, UniqueArgument, RankedFix.

Field-name conventions (see CONTRACT.md): Stage 1 schemas carry `persona`,
`model_id`, `findings` (severity int + suggested_fix), and a list of per-unit
score objects; synthesis schemas carry `consensus_weaknesses`,
`contested_issues`, `ranked_fixes`, `inter_rater_agreement`,
`held_out_validator_status`. The grouping key is `unit` (the parent called it
`cause_of_action`).
"""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field, model_validator


# ---------------------------------------------------------------------------
# Document model
# ---------------------------------------------------------------------------

class Document(BaseModel):
    """A parsed input document ready for inclusion in LLM prompts."""

    name: str
    role: str
    tier: int = Field(ge=1, le=3)
    content: str
    page_count: int = Field(ge=0)
    char_count: int = Field(ge=0)
    sha256: str
    truncated: bool = False


# ---------------------------------------------------------------------------
# Conventional Stage 1 building blocks
# ---------------------------------------------------------------------------

class Finding(BaseModel):
    """One reviewer finding. Every attack must cite a location and state what
    would neutralize it (the red-team persona rule)."""

    description: str
    severity: int = Field(ge=1, le=5, description="1 = blocking, 5 = cosmetic")
    location: str = Field(
        default="", description="Where in the document the issue lives",
    )
    suggested_fix: str = ""


# ---------------------------------------------------------------------------
# Conventional Stage 2 building blocks
# ---------------------------------------------------------------------------

class Weakness(BaseModel):
    description: str
    unit: str
    severity: Literal["critical", "major", "minor"]
    reviewer_count: int
    suggested_fix: str


class ContestedIssue(BaseModel):
    description: str
    position_a: str
    position_b: str
    models_supporting_a: list[str]
    models_supporting_b: list[str]


class UniqueArgument(BaseModel):
    description: str
    source_model: str
    source_persona: str
    assessment: str


class RankedFix(BaseModel):
    description: str
    unit: str
    impact: int = Field(ge=1, le=5)
    # ease: 1 = simple language change … 5 = requires substantial new material
    # (higher = harder).
    ease: int = Field(ge=1, le=5)
    consensus: float = Field(ge=0, le=1)
    priority_score: float = 0.0

    @model_validator(mode="after")
    def _recompute_priority(self) -> RankedFix:
        """Compute priority_score deterministically in code.

        The synthesis model is asked to compute this too, but LLM arithmetic
        is not trusted: whatever it returns is overwritten here with
        (impact² × consensus) / (1 + ease) — the canonical formula.
        """
        self.priority_score = round(
            (self.impact ** 2) * self.consensus / (1 + self.ease), 4
        )
        return self
