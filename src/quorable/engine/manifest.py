"""Parse inputs/manifest.yaml into structured ManifestEntry objects.

Forked from the reference implementation's manifest module and genericized: the parent hardcoded its
legal section keys (core / rulings / defense / plaintiff / evidence / judge).
Here sections are free-form — any top-level key works, so each project can
organize its manifest around its own domain. The ManifestEntry shape, tiers,
and `send_to` routing are unchanged.

Supported shapes under any top-level key:

- a single entry dict with a `path` key (entry named after the top-level key),
- a dict of named entry dicts (entries named after the sub-keys),
- a list of entry dicts (entries named after each path's stem),
- a dict of named lists (one level of nesting, e.g. the parent's
  defense.primary/replies/historical — entries named after path stems).

`system_prompt` is just another single-entry key by this scheme, preserving
the parent's manifest format.
"""
from __future__ import annotations

import logging
from pathlib import Path

import yaml
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)


class ManifestEntry(BaseModel):
    """One document described in the manifest."""

    name: str
    path: Path
    format: str = "markdown"
    role: str = ""
    tier: int = Field(ge=1, le=3)
    send_to: list[str] = Field(default_factory=list)
    critical: bool = False
    notes: str = ""


def _parse_single(raw: dict, inputs_dir: Path, fallback_name: str) -> ManifestEntry:
    """Turn one manifest entry dict into a ManifestEntry."""
    rel_path = raw["path"]
    abs_path = inputs_dir / rel_path
    if not abs_path.exists():
        logger.warning("Manifest references missing file: %s", abs_path)

    return ManifestEntry(
        name=fallback_name,
        path=abs_path,
        format=raw.get("format", _guess_format(rel_path)),
        role=raw.get("role", ""),
        tier=raw.get("tier", 1),
        send_to=raw.get("send_to", []),
        critical=raw.get("critical", False),
        notes=raw.get("notes", ""),
    )


def _guess_format(path_str: str) -> str:
    suffix = Path(path_str).suffix.lower()
    return {".pdf": "pdf", ".md": "markdown", ".yaml": "yaml", ".yml": "yaml"}.get(
        suffix, "markdown"
    )


def _is_entry_dict(val: object) -> bool:
    return isinstance(val, dict) and "path" in val


def _parse_list(items: list, inputs_dir: Path) -> list[ManifestEntry]:
    entries: list[ManifestEntry] = []
    for item in items:
        if not _is_entry_dict(item):
            logger.warning("Skipping malformed manifest list item: %r", item)
            continue
        name = Path(item["path"]).stem
        entries.append(_parse_single(item, inputs_dir, name))
    return entries


def load_manifest(manifest_path: Path, inputs_dir: Path) -> list[ManifestEntry]:
    """Parse the manifest YAML and return a flat list of ManifestEntry."""
    with open(manifest_path) as f:
        raw = yaml.safe_load(f) or {}

    entries: list[ManifestEntry] = []

    for key, val in raw.items():
        if val is None:
            continue
        if _is_entry_dict(val):
            # Single entry named after the top-level key (e.g. system_prompt)
            entries.append(_parse_single(val, inputs_dir, key))
        elif isinstance(val, dict):
            # Dict of named entries, or dict of named lists
            for sub_key, sub_val in val.items():
                if sub_val is None:
                    continue
                if _is_entry_dict(sub_val):
                    entries.append(_parse_single(sub_val, inputs_dir, sub_key))
                elif isinstance(sub_val, list):
                    entries.extend(_parse_list(sub_val, inputs_dir))
                else:
                    logger.warning(
                        "Skipping malformed manifest section %s.%s", key, sub_key,
                    )
        elif isinstance(val, list):
            entries.extend(_parse_list(val, inputs_dir))
        else:
            logger.warning("Skipping malformed manifest section %s", key)

    logger.info(
        "Loaded manifest with %d entries (%d tier-1, %d tier-2, %d tier-3)",
        len(entries),
        sum(1 for e in entries if e.tier == 1),
        sum(1 for e in entries if e.tier == 2),
        sum(1 for e in entries if e.tier == 3),
    )

    # Enforce that all critical files exist
    for entry in entries:
        if entry.critical and not entry.path.exists():
            raise FileNotFoundError(
                f"Critical document missing: {entry.name} ({entry.path}). "
                f"The pipeline cannot run without this file."
            )

    return entries
