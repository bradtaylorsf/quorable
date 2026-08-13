"""Load and validate a project's config.yaml into pydantic models.

Forked from the reference implementation's config module and genericized: the legal-specific fields
(document_type literal, canonical_causes, cite_check_ignore, compliance_check)
are gone. Domain vocabulary now comes from the Pack (see quorable.pack);
config.yaml gains a `pack:` key pointing at the project's pack.py.

Paths in config.yaml are resolved relative to the config file itself so the
CLI can operate on any --project directory.
"""
from __future__ import annotations

import logging
from pathlib import Path

import yaml
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)


class ReviewerModelConfig(BaseModel):
    id: str
    temperature: float = Field(ge=0, le=2, default=0.2)
    held_out: bool = False


class SingleModelConfig(BaseModel):
    id: str
    temperature: float = Field(ge=0, le=2, default=0.2)


class ModelsConfig(BaseModel):
    reviewers: list[ReviewerModelConfig]
    synthesizer: SingleModelConfig
    held_out: SingleModelConfig
    # Drafter is optional: review-only packs (drafter_enabled=False) never
    # call it, and `panel` mode works without one.
    drafter: SingleModelConfig | None = None


class PipelineConfig(BaseModel):
    runs_per_persona: int = Field(ge=1, default=2)
    max_concurrency: int = Field(ge=1, default=5)
    timeout_seconds: int = Field(ge=30, default=300)
    retry_attempts: int = Field(ge=0, default=3)
    # cost_threshold is a per-LOOP number (draft + all panel iterations +
    # syntheses), not per-call. The loop aborts — never degrades — when the
    # running cost crosses threshold × abort multiplier.
    cost_threshold: float = Field(ge=0, default=20.0)
    cost_abort_multiplier: float = Field(ge=1, default=2.0)
    # Loop stop condition: hard cap on draft→panel→revise iterations.
    max_iterations: int = Field(ge=1, default=3)


class PathsConfig(BaseModel):
    inputs: Path = Path("./inputs")
    outputs: Path = Path("./runs")
    personas: Path = Path("./personas")
    prompts: Path = Path("./prompts")
    research: Path = Path("./research")
    golden: Path = Path("./golden")
    briefs: Path = Path("./briefs")
    handoff: Path = Path("./handoff")


class Config(BaseModel):
    # Path to the project's pack.py (relative to this config file). The pack
    # supplies all domain vocabulary: schemas, dimensions, gates, markers.
    pack: Path = Path("./pack.py")

    models: ModelsConfig
    pipeline: PipelineConfig = PipelineConfig()
    personas: list[str] = Field(default_factory=list)
    paths: PathsConfig = PathsConfig()

    # Which entry of pack.doc_type_markers the primary document is expected
    # to match. The pipeline heuristically classifies the document at startup
    # and aborts loudly on a mismatch (wrong-mode guard). None disables the
    # check.
    document_type: str | None = None

    # Regression registry for this project. Each config MUST point at its own
    # registry file — a shared registry lets a run in one mode falsely mark
    # another mode's weaknesses "resolved".
    regressions_path: Path = Path("./regressions.yaml")

    @property
    def active_reviewers(self) -> list[ReviewerModelConfig]:
        """Reviewer models excluding any erroneously marked held_out."""
        return [m for m in self.models.reviewers if not m.held_out]

    @property
    def held_out_model_id(self) -> str:
        return self.models.held_out.id


def _resolve(base: Path, p: Path) -> Path:
    return p if p.is_absolute() else (base / p)


def load_config(path: Path) -> Config:
    """Load config.yaml, validate it, and resolve paths against its parent."""
    path = Path(path)
    with open(path) as f:
        raw = yaml.safe_load(f)
    config = Config.model_validate(raw)

    base = path.parent
    config.pack = _resolve(base, config.pack)
    config.regressions_path = _resolve(base, config.regressions_path)
    for field_name in PathsConfig.model_fields:
        setattr(
            config.paths, field_name,
            _resolve(base, getattr(config.paths, field_name)),
        )

    logger.info(
        "Config loaded from %s (%d reviewer models)",
        path, len(config.active_reviewers),
    )
    return config
