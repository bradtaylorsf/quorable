"""Tests for regression tracking (ported from the parent's test_regressions;
`cause_of_action` renamed to `unit`)."""
from __future__ import annotations

from pathlib import Path

from quorable.engine.regressions import (
    RegressionEntry,
    RegressionRegistry,
    RegressionResult,
    check_regressions,
    load_registry,
    save_registry,
    update_registry,
)
from quorable.engine.schemas import Weakness


class _FakeSynthesis:
    """Anything with a consensus_weaknesses list satisfies the convention."""

    def __init__(self, weaknesses: list[Weakness]):
        self.consensus_weaknesses = weaknesses


def _make_synthesis(weaknesses: list[dict]) -> _FakeSynthesis:
    return _FakeSynthesis([Weakness(**w) for w in weaknesses])


def _make_weakness(description: str, unit: str = "hook", severity: str = "major") -> dict:
    return {
        "description": description,
        "unit": unit,
        "severity": severity,
        "reviewer_count": 3,
        "suggested_fix": "Fix it",
    }


def _make_entry(
    description: str,
    unit: str = "hook",
    resolved: bool = False,
    resolved_run_id: str | None = None,
    doc_sha256: str | None = None,
) -> RegressionEntry:
    return RegressionEntry(
        description=description,
        unit=unit,
        severity="major",
        run_id="run_20260401",
        date="2026-04-01",
        resolved=resolved,
        resolved_run_id=resolved_run_id,
        doc_sha256=doc_sha256,
    )


# ---------------------------------------------------------------------------
# Registry persistence
# ---------------------------------------------------------------------------

class TestRegistryPersistence:
    def test_load_empty_file(self, tmp_path: Path):
        path = tmp_path / "regressions.yaml"
        registry = load_registry(path)
        assert len(registry.entries) == 0

    def test_round_trip(self, tmp_path: Path):
        path = tmp_path / "regressions.yaml"
        registry = RegressionRegistry(entries=[
            _make_entry("Hook buries the promise"),
            _make_entry("Body repeats the hook", unit="body"),
        ])
        save_registry(registry, path)
        loaded = load_registry(path)
        assert len(loaded.entries) == 2
        assert loaded.entries[0].description == "Hook buries the promise"
        assert loaded.entries[1].unit == "body"

    def test_save_creates_parent_dirs(self, tmp_path: Path):
        path = tmp_path / "sub" / "dir" / "regressions.yaml"
        save_registry(RegressionRegistry(), path)
        assert path.exists()


# ---------------------------------------------------------------------------
# Regression checking
# ---------------------------------------------------------------------------

class TestCheckRegressions:
    def test_new_weaknesses_detected(self):
        synthesis = _make_synthesis([
            _make_weakness("Hook buries the promise"),
            _make_weakness("Body repeats the hook", unit="body"),
        ])
        registry = RegressionRegistry()

        result = check_regressions(
            synthesis=synthesis, registry=registry, run_id="run_001",
        )

        assert len(result.new_entries) == 2
        assert len(result.reappeared) == 0
        assert len(result.resolved) == 0

    def test_existing_weakness_not_flagged_as_new(self):
        synthesis = _make_synthesis([
            _make_weakness("Hook buries the promise"),
        ])
        registry = RegressionRegistry(entries=[
            _make_entry("Hook buries the promise"),
        ])

        result = check_regressions(
            synthesis=synthesis, registry=registry, run_id="run_002",
        )

        assert len(result.new_entries) == 0
        assert len(result.reappeared) == 0
        assert len(result.resolved) == 0

    def test_resolved_weakness_reappearing_is_regression(self):
        synthesis = _make_synthesis([
            _make_weakness("Hook buries the promise"),
        ])
        registry = RegressionRegistry(entries=[
            _make_entry(
                "Hook buries the promise",
                resolved=True,
                resolved_run_id="run_002",
            ),
        ])

        result = check_regressions(
            synthesis=synthesis, registry=registry, run_id="run_003",
        )

        assert len(result.reappeared) == 1
        assert result.reappeared[0].description == "Hook buries the promise"

    def test_missing_weakness_resolved_when_document_revised(self):
        """Absence + a CHANGED document hash = genuinely resolved."""
        synthesis = _make_synthesis([])  # No weaknesses
        registry = RegressionRegistry(entries=[
            _make_entry("Hook buries the promise", doc_sha256="aaa"),
        ])

        result = check_regressions(
            synthesis=synthesis, registry=registry, run_id="run_002",
            doc_sha256="bbb",  # document was revised
        )

        assert len(result.resolved) == 1
        assert result.resolved[0].description == "Hook buries the promise"

    def test_missing_weakness_not_resolved_when_document_unchanged(self):
        """Absence with the SAME document hash is reviewer noise, not a fix."""
        synthesis = _make_synthesis([])
        registry = RegressionRegistry(entries=[
            _make_entry("Hook buries the promise", doc_sha256="aaa"),
        ])

        result = check_regressions(
            synthesis=synthesis, registry=registry, run_id="run_002",
            doc_sha256="aaa",  # unchanged document
        )

        assert len(result.resolved) == 0

    def test_missing_weakness_not_resolved_for_legacy_entry(self):
        """Entries recorded without a doc hash can never prove revision."""
        synthesis = _make_synthesis([])
        registry = RegressionRegistry(entries=[
            _make_entry("Hook buries the promise"),  # no doc_sha256
        ])

        result = check_regressions(
            synthesis=synthesis, registry=registry, run_id="run_002",
            doc_sha256="bbb",
        )

        assert len(result.resolved) == 0

    def test_new_entries_record_doc_hash(self):
        synthesis = _make_synthesis([_make_weakness("Fresh weakness spotted")])
        registry = RegressionRegistry()

        result = check_regressions(
            synthesis=synthesis, registry=registry, run_id="run_001",
            doc_sha256="abc123",
        )

        assert result.new_entries[0].doc_sha256 == "abc123"

    def test_case_insensitive_matching(self):
        synthesis = _make_synthesis([
            _make_weakness("hook buries the promise"),
        ])
        registry = RegressionRegistry(entries=[
            _make_entry("Hook Buries The Promise"),
        ])

        result = check_regressions(
            synthesis=synthesis, registry=registry, run_id="run_002",
        )

        # Should match — not flagged as new
        assert len(result.new_entries) == 0


# ---------------------------------------------------------------------------
# Registry update
# ---------------------------------------------------------------------------

class TestUpdateRegistry:
    def test_adds_new_entries(self):
        registry = RegressionRegistry()
        regression_result = RegressionResult(
            new_entries=[_make_entry("New weakness")],
        )

        updated = update_registry(
            registry=registry, regression_result=regression_result, run_id="run_001",
        )

        assert len(updated.entries) == 1
        assert updated.entries[0].description == "New weakness"

    def test_marks_resolved(self):
        entry = _make_entry("Old weakness")
        registry = RegressionRegistry(entries=[entry])
        regression_result = RegressionResult(resolved=[entry])

        updated = update_registry(
            registry=registry, regression_result=regression_result, run_id="run_002",
        )

        assert updated.entries[0].resolved is True
        assert updated.entries[0].resolved_run_id == "run_002"

    def test_reopens_reappeared(self):
        entry = _make_entry("Regressed weakness", resolved=True, resolved_run_id="run_002")
        registry = RegressionRegistry(entries=[entry])
        regression_result = RegressionResult(reappeared=[entry])

        updated = update_registry(
            registry=registry, regression_result=regression_result, run_id="run_003",
        )

        assert updated.entries[0].resolved is False
        assert updated.entries[0].resolved_run_id is None
