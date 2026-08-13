"""Tests for document parsers (ported from the parent's test_parsers;
SAC-specific naming replaced with the pack-supplied primary_doc_name)."""
from __future__ import annotations

from pathlib import Path

import pytest

from quorable.engine.manifest import ManifestEntry
from quorable.engine.parsers import (
    MAX_CHARS,
    PrimaryDocTooLargeError,
    document_from_text,
    parse_document,
)

FIXTURES = Path(__file__).parent / "fixtures"

PRIMARY = "script_draft"


def _entry(name: str, path: Path, fmt: str, tier: int = 1) -> ManifestEntry:
    return ManifestEntry(
        name=name, path=path, format=fmt, role="test", tier=tier, send_to=["stage1"],
    )


def test_parse_markdown():
    doc = parse_document(_entry("sample", FIXTURES / "sample.md", "markdown"))
    assert "Sample Document" in doc.content
    assert doc.page_count == 1
    assert doc.char_count > 0
    assert len(doc.sha256) == 64


def test_parse_yaml():
    doc = parse_document(_entry("metadata", FIXTURES / "sample.yaml", "yaml"))
    assert "Test v. Example" in doc.content
    assert doc.page_count == 1


def test_parse_missing_file():
    with pytest.raises(FileNotFoundError):
        parse_document(_entry("gone", FIXTURES / "nonexistent.md", "markdown"))


def test_parse_unknown_format():
    with pytest.raises(ValueError, match="Unknown document format"):
        parse_document(_entry("x", FIXTURES / "sample.md", "docx"))


def test_truncation_non_primary(tmp_path):
    """Non-primary documents over 200K chars get truncated."""
    big_file = tmp_path / "big.md"
    big_file.write_text("x" * (MAX_CHARS + 100))
    doc = parse_document(
        _entry("big_doc", big_file, "markdown"), primary_doc_name=PRIMARY,
    )
    assert doc.char_count <= MAX_CHARS + 100  # includes truncation marker
    assert "TRUNCATED" in doc.content
    assert doc.truncated


def test_primary_too_large_fails(tmp_path):
    """The primary document over 200K chars raises PrimaryDocTooLargeError."""
    big_file = tmp_path / "script.md"
    big_file.write_text("x" * (MAX_CHARS + 100))
    with pytest.raises(PrimaryDocTooLargeError):
        parse_document(
            _entry(PRIMARY, big_file, "markdown"), primary_doc_name=PRIMARY,
        )


def test_no_primary_name_truncates_everything(tmp_path):
    """Without a primary_doc_name, even a doc named like one just truncates."""
    big_file = tmp_path / "script.md"
    big_file.write_text("x" * (MAX_CHARS + 100))
    doc = parse_document(_entry(PRIMARY, big_file, "markdown"))
    assert "TRUNCATED" in doc.content


def test_sha256_deterministic():
    doc1 = parse_document(_entry("s1", FIXTURES / "sample.md", "markdown"))
    doc2 = parse_document(_entry("s2", FIXTURES / "sample.md", "markdown"))
    assert doc1.sha256 == doc2.sha256


def test_document_from_text():
    doc = document_from_text("interim", "HOOK: hi", role="Loop revision")
    assert doc.name == "interim"
    assert doc.char_count == len("HOOK: hi")
    assert len(doc.sha256) == 64
    assert doc.page_count == 1
