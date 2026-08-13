"""Tests for free-form manifest parsing (ported from the parent's
test_manifest, adapted to the toy project's manifest)."""
from __future__ import annotations

import logging
from pathlib import Path

import pytest

from quorable.engine.manifest import load_manifest

FIXTURES = Path(__file__).parent / "fixtures"
TOY_INPUTS = FIXTURES / "toy_pack" / "inputs"


def test_load_manifest_count():
    """Manifest should produce the expected number of entries."""
    entries = load_manifest(TOY_INPUTS / "manifest.yaml", TOY_INPUTS)
    # system_prompt + script_draft + canon + 00_context + 01_missing = 5
    assert len(entries) == 5


def test_tier_assignment():
    entries = load_manifest(TOY_INPUTS / "manifest.yaml", TOY_INPUTS)
    by_name = {e.name: e for e in entries}
    assert by_name["system_prompt"].tier == 1
    assert by_name["script_draft"].tier == 1
    assert by_name["00_context"].tier == 2
    assert by_name["01_missing"].tier == 3


def test_send_to_routing():
    entries = load_manifest(TOY_INPUTS / "manifest.yaml", TOY_INPUTS)
    by_name = {e.name: e for e in entries}
    assert "stage1" in by_name["system_prompt"].send_to
    assert "stage1_critic" in by_name["00_context"].send_to
    assert "draft" in by_name["script_draft"].send_to
    assert by_name["01_missing"].send_to == []


def test_path_resolution():
    entries = load_manifest(TOY_INPUTS / "manifest.yaml", TOY_INPUTS)
    for entry in entries:
        if entry.tier < 3:  # tier 3 files may not exist in fixtures
            assert entry.path.is_absolute() or entry.path.exists()


def test_missing_file_warns(caplog):
    """Missing file should log a warning but not crash."""
    with caplog.at_level(logging.WARNING):
        load_manifest(TOY_INPUTS / "manifest.yaml", TOY_INPUTS)
    # 01_missing.md doesn't exist — should have warned
    assert any("missing file" in r.message.lower() for r in caplog.records)


def test_free_form_sections(tmp_path):
    """Any top-level key works: single entry, named dict, list, dict of lists."""
    (tmp_path / "a.md").write_text("a", encoding="utf-8")
    (tmp_path / "b.md").write_text("b", encoding="utf-8")
    (tmp_path / "c.md").write_text("c", encoding="utf-8")
    (tmp_path / "d.md").write_text("d", encoding="utf-8")
    manifest = tmp_path / "manifest.yaml"
    manifest.write_text(
        """
solo:
  path: a.md
  tier: 1
named:
  first:
    path: b.md
    tier: 1
listed:
  - path: c.md
    tier: 2
nested:
  group:
    - path: d.md
      tier: 2
""",
        encoding="utf-8",
    )
    entries = load_manifest(manifest, tmp_path)
    by_name = {e.name: e for e in entries}
    assert set(by_name) == {"solo", "first", "c", "d"}
    assert by_name["solo"].path == tmp_path / "a.md"
    assert by_name["d"].tier == 2


def test_critical_missing_file_raises(tmp_path):
    manifest = tmp_path / "manifest.yaml"
    manifest.write_text(
        """
core:
  vital:
    path: nope.md
    tier: 1
    critical: true
""",
        encoding="utf-8",
    )
    with pytest.raises(FileNotFoundError, match="Critical document missing"):
        load_manifest(manifest, tmp_path)
