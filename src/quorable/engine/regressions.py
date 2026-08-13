"""Regression tracking across pipeline runs.

Forked from the reference implementation's regressions module with the grouping key renamed from
`cause_of_action` to `unit` (pack-defined grouping label). Maintains
regressions.yaml listing weaknesses from prior document versions. After each
run, checks whether any prior weakness reappeared and flags it. New
weaknesses are added to the registry.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any

import yaml
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

# Similarity threshold for fuzzy weakness matching. Two descriptions with
# a SequenceMatcher ratio >= this value are considered the same weakness
# even if the exact wording differs across model runs.
FUZZY_THRESHOLD = 0.85


def _make_key(description: str, unit: str) -> tuple[str, str]:
    """Normalize a weakness into a lookup key."""
    return (description.lower().strip(), unit.lower().strip())


def _fuzzy_find(
    key: tuple[str, str],
    candidates: dict[tuple[str, str], RegressionEntry],
) -> RegressionEntry | None:
    """Find the best fuzzy match for a key in candidates, if above threshold.

    Matches on unit (exact, case-insensitive) then description similarity
    via SequenceMatcher.
    """
    desc, unit = key
    # Short descriptions are unreliable for fuzzy matching — require a higher
    # threshold or exact match when descriptions are under 40 characters.
    min_length_for_fuzzy = 40
    effective_threshold = FUZZY_THRESHOLD
    if len(desc) < min_length_for_fuzzy:
        effective_threshold = 0.95

    best_ratio = 0.0
    best_entry: RegressionEntry | None = None
    for (c_desc, c_unit), entry in candidates.items():
        if unit != c_unit:
            continue
        ratio = SequenceMatcher(None, desc, c_desc).ratio()
        if ratio > best_ratio:
            best_ratio = ratio
            best_entry = entry
    if best_ratio >= effective_threshold and best_entry is not None:
        return best_entry
    return None


class RegressionEntry(BaseModel):
    """A single tracked weakness from a prior run."""

    description: str
    unit: str
    severity: str
    run_id: str
    date: str
    resolved: bool = False
    resolved_run_id: str | None = None
    # SHA256 of the document under review when this weakness was recorded.
    # Used to gate auto-resolution: a weakness may only be auto-resolved by a
    # run reviewing a REVISED document (different hash). If the document is
    # unchanged and the weakness merely failed to re-surface, that is
    # stochastic reviewer variation, not a fix. Legacy entries (None) are
    # never auto-resolved.
    doc_sha256: str | None = None


class RegressionRegistry(BaseModel):
    """The full regression registry persisted to regressions.yaml."""

    entries: list[RegressionEntry] = Field(default_factory=list)


class RegressionResult(BaseModel):
    """Result of comparing current weaknesses against the registry."""

    reappeared: list[RegressionEntry] = Field(default_factory=list)
    new_entries: list[RegressionEntry] = Field(default_factory=list)
    resolved: list[RegressionEntry] = Field(default_factory=list)


def load_registry(path: Path) -> RegressionRegistry:
    """Load the regression registry from regressions.yaml.

    Returns an empty registry if the file doesn't exist.
    """
    if not path.exists():
        logger.info("No regressions.yaml found at %s — starting fresh", path)
        return RegressionRegistry()

    with open(path) as f:
        raw = yaml.safe_load(f)

    if raw is None:
        return RegressionRegistry()

    return RegressionRegistry.model_validate(raw)


def save_registry(registry: RegressionRegistry, path: Path) -> None:
    """Save the regression registry to regressions.yaml."""
    path.parent.mkdir(parents=True, exist_ok=True)
    data = registry.model_dump()
    path.write_text(
        yaml.dump(data, default_flow_style=False, allow_unicode=True),
        encoding="utf-8",
    )
    logger.info("Saved regression registry to %s (%d entries)", path, len(registry.entries))


def check_regressions(
    *,
    synthesis: Any,
    registry: RegressionRegistry,
    run_id: str,
    doc_sha256: str | None = None,
) -> RegressionResult:
    """Compare current weaknesses against the registry.

    `synthesis` is a pack synthesis-schema instance honoring the
    consensus_weaknesses convention (items with description/unit/severity).

    Identifies three categories:
    - reappeared: weaknesses that were previously resolved but showed up again
    - new_entries: weaknesses not previously tracked
    - resolved: previously tracked weaknesses not in the current run, AND
      whose recorded document hash differs from the current document (i.e.,
      the document was actually revised). Absence alone never resolves an
      entry: with an unchanged document it is reviewer noise, and entries
      recorded without a hash cannot prove revision.
    """
    weaknesses = getattr(synthesis, "consensus_weaknesses", []) or []

    # Build lookup of existing entries by key
    existing_by_key: dict[tuple[str, str], RegressionEntry] = {}
    for entry in registry.entries:
        existing_by_key[_make_key(entry.description, entry.unit)] = entry

    result = RegressionResult()
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    # Track which existing entries were matched (exact or fuzzy)
    matched_existing_keys: set[tuple[str, str]] = set()

    for weakness in weaknesses:
        key = _make_key(weakness.description, weakness.unit)

        # Try exact match first, then fuzzy
        existing = existing_by_key.get(key)
        matched_key = key
        if existing is None:
            existing = _fuzzy_find(key, existing_by_key)
            if existing is not None:
                matched_key = _make_key(existing.description, existing.unit)
                logger.info(
                    "Fuzzy matched weakness '%s' to existing '%s'",
                    weakness.description[:60], existing.description[:60],
                )

        if existing is not None:
            matched_existing_keys.add(matched_key)
            if existing.resolved:
                # Previously resolved, now reappeared — a regression
                result.reappeared.append(existing)
                logger.warning(
                    "Regression detected: '%s' (%s) — previously resolved in %s",
                    existing.description, existing.unit, existing.resolved_run_id,
                )
            # else: still active, not new — nothing to flag
        else:
            # New weakness not previously tracked
            new_entry = RegressionEntry(
                description=weakness.description,
                unit=weakness.unit,
                severity=str(weakness.severity),
                run_id=run_id,
                date=now,
                doc_sha256=doc_sha256,
            )
            result.new_entries.append(new_entry)

    # Check for resolved: previously active (not resolved) entries that are
    # no longer in the current weakness set (exact or fuzzy) — but ONLY when
    # the document has demonstrably changed since the entry was recorded.
    for key, entry in existing_by_key.items():
        if entry.resolved or key in matched_existing_keys:
            continue
        if entry.doc_sha256 is None:
            logger.info(
                "Weakness absent but has no recorded doc hash — NOT "
                "auto-resolving (legacy entry): '%s' (%s)",
                entry.description[:60], entry.unit,
            )
            continue
        if doc_sha256 is None or entry.doc_sha256 == doc_sha256:
            logger.info(
                "Weakness absent but document unchanged — NOT auto-resolving "
                "(reviewer noise, not a fix): '%s' (%s)",
                entry.description[:60], entry.unit,
            )
            continue
        result.resolved.append(entry)
        logger.info(
            "Weakness resolved (document revised): '%s' (%s)",
            entry.description, entry.unit,
        )

    logger.info(
        "Regression check complete | reappeared=%d new=%d resolved=%d",
        len(result.reappeared), len(result.new_entries), len(result.resolved),
    )

    return result


def update_registry(
    *,
    registry: RegressionRegistry,
    regression_result: RegressionResult,
    run_id: str,
) -> RegressionRegistry:
    """Update the registry with results from the current run.

    - Adds new entries
    - Marks resolved entries
    - Re-opens reappeared entries
    """
    # Mark resolved entries
    resolved_keys = {
        (e.description.lower().strip(), e.unit.lower().strip())
        for e in regression_result.resolved
    }

    # Mark reappeared entries as no longer resolved
    reappeared_keys = {
        (e.description.lower().strip(), e.unit.lower().strip())
        for e in regression_result.reappeared
    }

    for entry in registry.entries:
        key = (entry.description.lower().strip(), entry.unit.lower().strip())
        if key in resolved_keys:
            entry.resolved = True
            entry.resolved_run_id = run_id
        elif key in reappeared_keys:
            entry.resolved = False
            entry.resolved_run_id = None

    # Add new entries
    registry.entries.extend(regression_result.new_entries)

    return registry
