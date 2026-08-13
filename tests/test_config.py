"""Tests for config.yaml parsing (ported from the parent's test_config)."""
from __future__ import annotations

from pathlib import Path

import pytest
from pydantic import ValidationError

from quorable.engine.config import Config, load_config

FIXTURES = Path(__file__).parent / "fixtures"
TOY = FIXTURES / "toy_pack"


def test_load_toy_config():
    """Load the toy project config.

    Structural checks only — the held-out invariant (never among active
    reviewers) is the part worth guarding.
    """
    cfg = load_config(TOY / "config.yaml")
    assert len(cfg.active_reviewers) == 2
    assert cfg.held_out_model_id == "heldout/model-c"
    assert cfg.held_out_model_id not in [m.id for m in cfg.active_reviewers]
    assert cfg.pipeline.runs_per_persona >= 1
    assert cfg.pipeline.max_concurrency >= 1
    assert cfg.pipeline.max_iterations == 2
    assert cfg.personas == ["praiser", "critic"]
    assert cfg.models.drafter is not None
    assert cfg.models.drafter.id == "test/drafter-model"


def test_paths_resolved_relative_to_config_file():
    cfg = load_config(TOY / "config.yaml")
    assert cfg.pack.is_absolute()
    assert cfg.pack == (TOY / "pack.py").resolve() or cfg.pack == TOY / "pack.py"
    assert cfg.paths.inputs == TOY / "inputs"
    assert cfg.paths.outputs == TOY / "runs"
    assert cfg.regressions_path == TOY / "regressions.yaml"


def test_held_out_excluded_from_active():
    cfg = Config.model_validate({
        "models": {
            "reviewers": [
                {"id": "model-a", "held_out": False},
                {"id": "model-b", "held_out": True},
            ],
            "synthesizer": {"id": "model-c"},
            "held_out": {"id": "model-d"},
        },
    })
    assert len(cfg.active_reviewers) == 1
    assert cfg.active_reviewers[0].id == "model-a"


def test_config_invalid_temperature():
    with pytest.raises(ValidationError):
        Config.model_validate({
            "models": {
                "reviewers": [{"id": "x", "temperature": 5.0}],
                "synthesizer": {"id": "y"},
                "held_out": {"id": "z"},
            },
        })


def test_config_defaults():
    cfg = Config.model_validate({
        "models": {
            "reviewers": [{"id": "a"}],
            "synthesizer": {"id": "b"},
            "held_out": {"id": "c"},
        },
    })
    assert cfg.pipeline.timeout_seconds == 300
    assert cfg.pipeline.retry_attempts == 3
    assert cfg.pipeline.max_iterations == 3
    assert cfg.personas == []          # no legal-domain persona defaults
    assert cfg.models.drafter is None  # drafter optional
    assert cfg.document_type is None
    assert cfg.pack == Path("./pack.py")
