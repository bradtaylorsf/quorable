"""Per-persona document assembly (§3).

Assembles the correct document set for each persona based on the manifest's
send_to field.  Tier 1 documents go to every Stage 1 persona.  Tier 2
documents are routed per the manifest.  Tier 3 documents are never sent.
"""
from __future__ import annotations

import logging

from quorable.engine.manifest import ManifestEntry
from quorable.engine.schemas import Document

logger = logging.getLogger(__name__)


def _matches_persona(entry: ManifestEntry, persona: str) -> bool:
    """Check whether a manifest entry should be sent to a given persona.

    send_to values use prefixes like 'stage1' (all personas), or
    'stage1_textualist' (specific persona).
    """
    for target in entry.send_to:
        if target == "stage1":
            return True
        if target == f"stage1_{persona}":
            return True
    return False


def assemble_for_persona(
    persona: str,
    entries: list[ManifestEntry],
    documents: dict[str, Document],
) -> list[Document]:
    """Return the ordered document list for a Stage 1 persona.

    Tier 1 documents are always included.  Tier 2 documents are included
    only if their send_to list matches the persona.  Tier 3 documents are
    never included.
    """
    result: list[Document] = []
    for entry in entries:
        if entry.tier == 3:
            continue
        if entry.tier == 1:
            doc = documents.get(entry.name)
            if doc:
                result.append(doc)
        elif entry.tier == 2 and _matches_persona(entry, persona):
            doc = documents.get(entry.name)
            if doc:
                result.append(doc)
    return result


def assemble_for_stage2(
    entries: list[ManifestEntry],
    documents: dict[str, Document],
) -> list[Document]:
    """Return documents for Stage 2 synthesis.

    Includes any non-tier-3 document whose send_to list contains "stage2"
    (tier 2 documents may be explicitly routed to stage2 by the manifest).
    """
    result: list[Document] = []
    for entry in entries:
        if entry.tier == 3:
            continue
        if "stage2" in entry.send_to:
            doc = documents.get(entry.name)
            if doc:
                result.append(doc)
    return result


def assemble_for_stage3(
    entries: list[ManifestEntry],
    documents: dict[str, Document],
) -> list[Document]:
    """Return documents for Stage 3 held-out validation.

    Only documents explicitly routed to stage3 (typically: the system
    prompt, the revised primary document, and core metadata).
    """
    result: list[Document] = []
    for entry in entries:
        if "stage3" in entry.send_to:
            doc = documents.get(entry.name)
            if doc:
                result.append(doc)
    return result
