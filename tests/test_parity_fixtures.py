"""Guard: the committed parity fixtures must match what the engine computes.

The TS engine's parity gate compares against fixtures/parity/*.json. If the
Python engine's math ever changes, this test forces the fixtures (and hence
the TS port) to be regenerated in the same commit — the two engines can never
silently diverge.
"""
from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
PARITY_DIR = REPO / "fixtures" / "parity"

FIXTURE_FILES = [
    "agreement_cases.json",
    "icc_cases.json",
    "kappa_cases.json",
    "normalize_cases.json",
    "scoring_cases.json",
    "priority_cases.json",
    "gate_cases.json",
    "sequence_matcher_cases.json",
    "validation_text_cases.json",
    "cost_cases.json",
]


def _load_extractor():
    spec = importlib.util.spec_from_file_location(
        "extract_parity_fixtures", REPO / "tools" / "extract_parity_fixtures.py",
    )
    module = importlib.util.module_from_spec(spec)
    sys.modules["extract_parity_fixtures"] = module
    spec.loader.exec_module(module)
    return module


def test_fixtures_exist():
    for name in FIXTURE_FILES:
        assert (PARITY_DIR / name).exists(), (
            f"Missing parity fixture {name} — run "
            f"`uv run python tools/extract_parity_fixtures.py`"
        )


def test_fixtures_match_engine(tmp_path):
    """Regenerate into a temp dir and compare against committed fixtures."""
    ex = _load_extractor()
    ex.OUT_DIR = tmp_path

    ex.main()

    for name in FIXTURE_FILES:
        committed = json.loads((PARITY_DIR / name).read_text(encoding="utf-8"))
        fresh = json.loads((tmp_path / name).read_text(encoding="utf-8"))
        assert committed == fresh, (
            f"{name} is stale — the engine's math changed. Regenerate with "
            f"`uv run python tools/extract_parity_fixtures.py` and update the "
            f"TS engine to match in the same commit."
        )
