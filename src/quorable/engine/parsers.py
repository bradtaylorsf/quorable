"""Document parsers: PDF, Markdown, YAML → Document model.

Forked from the reference implementation's parsers module and genericized: the hardcoded a domain-specific draft-name constant
became the pack-supplied `primary_doc_name` parameter. The never-truncate-
primary rule is kept: the primary document fails loudly at the character cap;
everything else truncates with a marker.
"""
from __future__ import annotations

import hashlib
import logging
from pathlib import Path

import yaml

from quorable.engine.manifest import ManifestEntry
from quorable.engine.schemas import Document

logger = logging.getLogger(__name__)

MAX_CHARS = 200_000


class PrimaryDocTooLargeError(Exception):
    """The primary document exceeds the hard character limit."""


def _sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _enforce_char_limit(
    content: str, name: str, primary_doc_name: str | None,
) -> str:
    """Apply the 200K character cap. The primary doc fails loudly; others truncate."""
    if len(content) <= MAX_CHARS:
        return content

    if primary_doc_name is not None and name == primary_doc_name:
        raise PrimaryDocTooLargeError(
            f"Primary document '{name}' is {len(content):,} chars, exceeding "
            f"the {MAX_CHARS:,} char hard limit. This is not allowed — the "
            f"primary document must never be truncated."
        )

    logger.warning(
        "Document '%s' is %d chars — truncating to %d with marker.",
        name,
        len(content),
        MAX_CHARS,
    )
    return content[:MAX_CHARS] + "\n\n[… TRUNCATED at 200,000 characters …]"


# ---------------------------------------------------------------------------
# Format-specific parsers
# ---------------------------------------------------------------------------

def _parse_pdf(path: Path) -> tuple[str, int]:
    """Extract text from a PDF with [p.N] markers. Returns (content, page_count)."""
    import fitz  # pymupdf

    doc = fitz.open(path)
    pages: list[str] = []
    for page_num in range(len(doc)):
        page = doc[page_num]
        text = page.get_text()
        if not text.strip():
            logger.warning("PDF '%s' page %d returned empty text.", path.name, page_num + 1)
        pages.append(f"[p.{page_num + 1}]\n{text}")
    doc.close()
    return "\n\n".join(pages), len(pages)


def _parse_markdown(path: Path) -> tuple[str, int]:
    """Read markdown/text as-is. page_count is always 1."""
    try:
        return path.read_text(encoding="utf-8"), 1
    except UnicodeDecodeError:
        logger.warning("'%s' is not UTF-8 — reading as latin-1.", path.name)
        return path.read_text(encoding="latin-1"), 1


def _parse_yaml_doc(path: Path) -> tuple[str, int]:
    """Load YAML and serialize as readable context. page_count is always 1."""
    with open(path) as f:
        data = yaml.safe_load(f)
    return yaml.dump(data, default_flow_style=False, allow_unicode=True), 1


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

_FORMAT_PARSERS = {
    "pdf": _parse_pdf,
    "markdown": _parse_markdown,
    "yaml": _parse_yaml_doc,
}


def parse_document(
    entry: ManifestEntry,
    *,
    primary_doc_name: str | None = None,
) -> Document:
    """Parse a single manifest entry into a Document model.

    `primary_doc_name` (from the pack) marks the document that must never be
    truncated — it raises PrimaryDocTooLargeError past the cap instead.
    """
    parser = _FORMAT_PARSERS.get(entry.format)
    if parser is None:
        raise ValueError(f"Unknown document format '{entry.format}' for {entry.name}")

    if not entry.path.exists():
        raise FileNotFoundError(f"Document not found: {entry.path}")

    raw_content, page_count = parser(entry.path)
    content = _enforce_char_limit(raw_content, entry.name, primary_doc_name)
    truncated = len(raw_content) > MAX_CHARS

    return Document(
        name=entry.name,
        role=entry.role,
        tier=entry.tier,
        content=content,
        page_count=page_count,
        char_count=len(content),
        sha256=_sha256(content),
        truncated=truncated,
    )


def document_from_text(
    name: str,
    text: str,
    *,
    role: str = "",
    tier: int = 1,
) -> Document:
    """Build a Document from in-memory text (used by the revision loop, where
    interim drafts exist only inside the run directory, not in inputs/)."""
    return Document(
        name=name,
        role=role,
        tier=tier,
        content=text,
        page_count=1,
        char_count=len(text),
        sha256=_sha256(text),
    )
