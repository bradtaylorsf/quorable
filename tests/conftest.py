"""Shared fixtures: the toy pack project used to test the engine
pack-independently. No test in this suite touches the network — HTTP is
mocked with respx where needed."""
from __future__ import annotations

import shutil
from pathlib import Path

import pytest

FIXTURES = Path(__file__).parent / "fixtures"
TOY_PACK_DIR = FIXTURES / "toy_pack"


@pytest.fixture
def toy_project() -> Path:
    """Path to the committed toy project fixture (read-only usage)."""
    return TOY_PACK_DIR


@pytest.fixture
def toy_config(toy_project: Path):
    from quorable.engine.config import load_config

    return load_config(toy_project / "config.yaml")


@pytest.fixture
def toy_pack(toy_project: Path):
    from quorable.pack import load_pack

    return load_pack(toy_project / "config.yaml")


@pytest.fixture
def toy_project_copy(tmp_path: Path):
    """A writable copy of the toy project (for tests that produce outputs)."""
    dest = tmp_path / "toy_pack"
    shutil.copytree(TOY_PACK_DIR, dest)
    return dest
