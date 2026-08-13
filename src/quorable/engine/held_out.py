"""Stage 3 held-out validation.

Forked from the reference implementation's held_out module. Runs only the held-out model (excluded from
Stages 1-2 in code) against the revised primary document. If it surfaces
issues not caught earlier, the pipeline may have been overfitting to the
Stage 1 models.

Genericizations: STAGE3_RECOMMENDED_DOCS comes from
pack.held_out_recommended_docs; the review schema and primary-doc name come
from the pack. The exclusion checks, cross-vendor warning, holdout ledger,
and exhaustion warnings are kept intact. Stage 3 stays OUTSIDE the revision
loop — it runs once on the final document via `quorable validate`.
"""
from __future__ import annotations

import json
import logging
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import yaml
from pydantic import BaseModel, Field

from quorable.engine.assembly import assemble_for_stage3
from quorable.engine.client import CostTracker, OpenRouterClient
from quorable.engine.config import Config
from quorable.engine.manifest import ManifestEntry, load_manifest
from quorable.engine.parsers import parse_document
from quorable.engine.prompts import build_messages, load_system_prompt
from quorable.engine.regressions import FUZZY_THRESHOLD
from quorable.engine.schemas import Document
from quorable.engine.validation import validated_call

logger = logging.getLogger(__name__)


def _verify_held_out_exclusion(config: Config) -> None:
    """Enforce that the held-out model was not used in Stages 1-2.

    Checks that no reviewer model shares the held-out model's ID.
    This is a code-level enforcement on top of the config-level exclusion.
    Also warns when the held-out model shares a vendor with any reviewer —
    same-family models have correlated failure modes, which weakens the
    held-out check's independence.
    """
    held_out_id = config.held_out_model_id
    for reviewer in config.models.reviewers:
        if reviewer.id == held_out_id:
            raise ValueError(
                f"Held-out model {held_out_id} appears in the reviewer list. "
                f"It must be excluded from Stages 1-2."
            )
    if config.models.synthesizer.id == held_out_id:
        raise ValueError(
            f"Held-out model {held_out_id} is configured as the synthesizer. "
            f"It must be excluded from Stages 1-2."
        )
    if config.models.drafter is not None and config.models.drafter.id == held_out_id:
        raise ValueError(
            f"Held-out model {held_out_id} is configured as the drafter. "
            f"It must be excluded from drafting and Stages 1-2."
        )

    held_out_vendor = held_out_id.split("/")[0]
    overlapping = [
        r.id for r in config.active_reviewers
        if r.id.split("/")[0] == held_out_vendor
    ]
    if overlapping:
        logger.warning(
            "Held-out model %s shares vendor '%s' with reviewer(s) %s — "
            "same-family models have correlated blind spots, weakening the "
            "held-out validation. Prefer a cross-vendor held-out model.",
            held_out_id, held_out_vendor, overlapping,
        )


def _ledger_path(config: Config) -> Path:
    return config.paths.outputs / "holdout_ledger.yaml"


def record_holdout_use(
    config: Config,
    *,
    doc_sha256: str | None,
    verdict: str,
    run_dir: Path,
) -> None:
    """Append this Stage 3 invocation to the holdout ledger.

    The ledger exists to make holdout exhaustion measurable: every time the
    held-out model is consulted against a revision of the same document, its
    independence decays (you are tuning against it). Warns when usage is
    accumulating.
    """
    path = _ledger_path(config)
    entries: list[dict] = []
    if path.exists():
        entries = yaml.safe_load(path.read_text(encoding="utf-8")) or []

    entries.append({
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "model": config.held_out_model_id,
        "doc_sha256": doc_sha256,
        "verdict": verdict,
        "run_dir": str(run_dir),
    })
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        yaml.dump(entries, default_flow_style=False), encoding="utf-8"
    )

    same_model_uses = sum(
        1 for e in entries if e.get("model") == config.held_out_model_id
    )
    same_doc_uses = sum(
        1 for e in entries
        if e.get("doc_sha256") == doc_sha256 and doc_sha256 is not None
    )
    if same_doc_uses > 1:
        logger.warning(
            "Held-out model already validated this exact document version "
            "(%d times) — re-running adds no information.", same_doc_uses,
        )
    if same_model_uses >= 3:
        logger.warning(
            "HOLDOUT EXHAUSTION: %s has now been consulted %d times across "
            "document revisions. Each iteration tuned against its feedback "
            "erodes its independence. Consider rotating in a fresh held-out "
            "model (different vendor) for the final validation.",
            config.held_out_model_id, same_model_uses,
        )


async def run_stage3(
    *,
    config: Config,
    pack: Any,
    run_dir: Path,
    entries: list[ManifestEntry] | None = None,
    documents: dict[str, Document] | None = None,
    cost_tracker: CostTracker | None = None,
) -> BaseModel | None:
    """Execute Stage 3 held-out validation.

    Runs a single review call using only the held-out model against the
    Stage 3 document set (system prompt + revised primary doc + metadata).
    Returns the validated pack review-schema instance or None on failure.
    """
    start = time.monotonic()

    # Enforce held-out exclusion
    _verify_held_out_exclusion(config)

    held_out = config.models.held_out
    logger.info("Starting Stage 3 held-out validation | model=%s", held_out.id)

    # Load documents if not provided
    if entries is None or documents is None:
        inputs_dir = config.paths.inputs
        entries = load_manifest(inputs_dir / "manifest.yaml", inputs_dir)
        documents = {}
        for entry in entries:
            if entry.path.exists():
                try:
                    documents[entry.name] = parse_document(
                        entry, primary_doc_name=pack.primary_doc_name,
                    )
                except Exception as exc:
                    logger.warning("Failed to parse %s: %s", entry.name, exc)

    # Assemble Stage 3 documents
    stage3_docs = assemble_for_stage3(entries, documents)
    if not stage3_docs:
        logger.error("No Stage 3 documents found — check manifest send_to fields")
        return None

    logger.info("Stage 3 document set: %s", [d.name for d in stage3_docs])

    # The pack's schema may demand scores that require reference documents.
    # If the manifest doesn't route the pack's recommended docs to stage3,
    # the model is forced to guess — refuse to pretend that's fine.
    stage3_names = {d.name for d in stage3_docs}
    missing = [
        n for n in pack.held_out_recommended_docs
        if n not in stage3_names and n in documents
    ]
    if missing:
        logger.error(
            "Stage 3 document set is missing %s, but the pack recommends "
            "them for held-out validation (its schema scores dimensions that "
            "depend on them). Add 'stage3' to their send_to in the manifest — "
            "the held-out scores for those dimensions are otherwise "
            "unanchored.",
            ", ".join(missing),
        )

    # Build messages — use system prompt as system, documents as user content
    # No persona overlay for Stage 3 — the held-out model reviews without bias
    system_prompt = load_system_prompt(config.paths.inputs)
    messages = build_messages(
        system_prompt=system_prompt,
        persona_overlay=(
            "You are an independent held-out validator. Review the document "
            "without any specific persona bias. Focus on identifying issues "
            "that other reviewers may have missed."
        ),
        documents=stage3_docs,
        schema=pack.review_schema,
        canonical_units=pack.canonical_units or None,
        unit_field=pack.unit_field,
    )

    # Call the held-out model
    tracker = cost_tracker or CostTracker()
    async with OpenRouterClient(
        max_concurrency=1,
        timeout_seconds=config.pipeline.timeout_seconds,
        retry_attempts=config.pipeline.retry_attempts,
        cost_tracker=tracker,
    ) as client:
        review = await validated_call(
            client,
            model=held_out.id,
            messages=messages,
            schema=pack.review_schema,
            temperature=held_out.temperature,
            persona="held_out_validator",
        )

    if review is None:
        logger.error("Stage 3 held-out validation failed")
        return None

    # Save held_out_validation.json
    output_path = run_dir / "held_out_validation.json"
    output_path.write_text(
        json.dumps(review.model_dump(), indent=2, ensure_ascii=False),
        encoding="utf-8",
    )
    logger.info("Saved held-out validation to %s", output_path)

    # Record this consultation in the holdout ledger (exhaustion tracking)
    primary_doc = documents.get(pack.primary_doc_name)
    verdict = str(getattr(review, pack.verdict_field, "unknown"))
    record_holdout_use(
        config,
        doc_sha256=primary_doc.sha256 if primary_doc else None,
        verdict=verdict,
        run_dir=run_dir,
    )

    latency = round(time.monotonic() - start, 3)
    logger.info(
        "Stage 3 complete | model=%s verdict=%s latency=%.1fs cost=$%.4f",
        held_out.id, verdict, latency, tracker.total_usd,
    )

    return review


def extract_review_weaknesses(review: BaseModel, pack: Any) -> list[str]:
    """Collect free-text weaknesses from a pack review instance.

    Convention: per-unit objects may carry a `weaknesses: list[str]`;
    review-level `findings` carry objects with a `description`. Both are
    harvested so held-out comparison works across pack schema styles.
    """
    weaknesses: list[str] = []
    unit_list_field = getattr(pack, "unit_list_field", "unit_reviews")
    for unit in getattr(review, unit_list_field, None) or []:
        for w in getattr(unit, "weaknesses", None) or []:
            weaknesses.append(str(w))
    for finding in getattr(review, "findings", None) or []:
        desc = getattr(finding, "description", None)
        if desc:
            weaknesses.append(str(desc))
    return weaknesses


def _fuzzy_match_weakness(
    description: str,
    known_descriptions: set[str],
    threshold: float = FUZZY_THRESHOLD,
) -> bool:
    """Check if a description fuzzy-matches any known weakness."""
    from difflib import SequenceMatcher

    desc_lower = description.lower().strip()
    for known in known_descriptions:
        ratio = SequenceMatcher(None, desc_lower, known).ratio()
        if ratio >= threshold:
            return True
    return False


class WeaknessMatchVerdict(BaseModel):
    """LLM adjudication of whether one weakness matches any known weakness."""

    held_out_weakness: str
    matches_known_issue: bool
    matched_description: str = Field(
        default="",
        description="The known weakness it matches, verbatim, if any",
    )


class HeldOutAdjudication(BaseModel):
    """Full adjudication of held-out weaknesses vs. synthesis weaknesses."""

    verdicts: list[WeaknessMatchVerdict]


async def adjudicate_held_out_status(
    *,
    config: Config,
    pack: Any,
    held_out_review: BaseModel,
    synthesis: BaseModel,
    run_dir: Path,
    cost_tracker: CostTracker | None = None,
) -> str:
    """Semantically compare held-out weaknesses against synthesis weaknesses.

    Lexical matching (SequenceMatcher) cannot recognize the same issue worded
    differently by different models, which made the old comparison report
    "found_new_issues" almost unconditionally. This uses one cheap
    synthesizer-model call to adjudicate semantic identity, falls back to the
    lexical comparison if the call fails, and always writes
    held_out_new_issues.md for human triage.
    """
    held_out_weaknesses = extract_review_weaknesses(held_out_review, pack)
    known = [
        w.description
        for w in getattr(synthesis, "consensus_weaknesses", []) or []
    ]

    if not held_out_weaknesses:
        logger.info("Held-out review lists no weaknesses — agrees")
        return "agrees"

    new_issues: list[str] | None = None

    if known:
        known_block = "\n".join(f"- {d}" for d in known)
        held_block = "\n".join(f"- {w}" for w in held_out_weaknesses)
        messages = [
            {
                "role": "system",
                "content": (
                    "You compare lists of editorial-review findings. Two "
                    "findings match when they identify the SAME underlying "
                    "issue, even if worded differently. Different issues "
                    "about the same part of the document do NOT match."
                ),
            },
            {
                "role": "user",
                "content": (
                    "KNOWN ISSUES (from the main review synthesis):\n"
                    f"{known_block}\n\n"
                    "HELD-OUT VALIDATOR ISSUES:\n"
                    f"{held_block}\n\n"
                    "For EACH held-out issue, decide whether it matches any "
                    "known issue. Respond with a single JSON object matching "
                    "this schema:\n"
                    f"{json.dumps(HeldOutAdjudication.model_json_schema(), indent=2)}"
                ),
            },
        ]
        tracker = cost_tracker or CostTracker()
        try:
            async with OpenRouterClient(
                max_concurrency=1,
                timeout_seconds=config.pipeline.timeout_seconds,
                retry_attempts=config.pipeline.retry_attempts,
                cost_tracker=tracker,
            ) as client:
                adjudication = await validated_call(
                    client,
                    model=config.models.synthesizer.id,
                    messages=messages,
                    schema=HeldOutAdjudication,
                    temperature=0.0,
                    persona="held_out_adjudicator",
                )
            if adjudication is not None:
                new_issues = [
                    v.held_out_weakness
                    for v in adjudication.verdicts
                    if not v.matches_known_issue
                ]
        except Exception as exc:  # noqa: BLE001 — degrade to lexical fallback
            logger.warning("Held-out adjudication call failed (%s)", exc)

    if new_issues is None:
        logger.warning(
            "Falling back to lexical (SequenceMatcher) held-out comparison — "
            "treat 'found_new_issues' with skepticism: lexical matching "
            "over-reports novelty."
        )
        known_lower = {d.lower().strip() for d in known}
        new_issues = [
            w for w in held_out_weaknesses
            if not _fuzzy_match_weakness(w, known_lower)
        ]

    # Always leave a human-triage artifact — the binary status is a summary,
    # not a substitute for reading what the held-out model actually found.
    triage_path = run_dir / "held_out_new_issues.md"
    lines = ["# Held-Out Validator — New Issues Triage\n"]
    if new_issues:
        lines.append(
            "The held-out model raised the following issues that the main "
            "review synthesis did not. Each one is either (a) a real gap the "
            "reviewer ensemble missed — evidence of overfitting — or (b) "
            "held-out model noise. A human must decide which.\n"
        )
        for issue in new_issues:
            lines.append(f"- [ ] {issue}")
    else:
        lines.append(
            "No new issues: everything the held-out model flagged was "
            "already in the synthesis.\n"
        )
    triage_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    logger.info("Wrote held-out triage to %s", triage_path)

    if new_issues:
        logger.warning(
            "Held-out validator found %d issue(s) not in synthesis — see %s",
            len(new_issues), triage_path,
        )
        return "found_new_issues"
    return "agrees"


def determine_held_out_status(
    *,
    held_out_review: BaseModel,
    synthesis: BaseModel,
    pack: Any,
) -> str:
    """Compare the held-out review against Stage 2 synthesis (lexical).

    LEGACY fallback: uses SequenceMatcher, which over-reports novelty because
    two models describing the same issue rarely exceed 0.85 lexical
    similarity. Prefer adjudicate_held_out_status(), which compares
    semantically and falls back to this only when the adjudication call fails.

    Returns "agrees" if the held-out model found no issues beyond what
    Stage 1-2 already identified. Returns "found_new_issues" if new
    weaknesses were surfaced. Uses fuzzy matching to account for
    wording differences between models.
    """
    known_descriptions = {
        w.description.lower().strip()
        for w in getattr(synthesis, "consensus_weaknesses", []) or []
    }

    new_issues = [
        weakness
        for weakness in extract_review_weaknesses(held_out_review, pack)
        if not _fuzzy_match_weakness(weakness, known_descriptions)
    ]

    if new_issues:
        logger.warning(
            "Held-out validator found %d new issues not in synthesis: %s",
            len(new_issues), new_issues[:5],
        )
        return "found_new_issues"

    logger.info("Held-out validator agrees with synthesis — no new issues found")
    return "agrees"


def update_synthesis_status(
    synthesis: BaseModel,
    status: str,
    run_dir: Path,
) -> None:
    """Update held_out_validator_status in synthesis and re-save."""
    if hasattr(synthesis, "held_out_validator_status"):
        synthesis.held_out_validator_status = status

    synthesis_path = run_dir / "synthesis.json"
    if synthesis_path.exists():
        synthesis_path.write_text(
            json.dumps(synthesis.model_dump(), indent=2, ensure_ascii=False),
            encoding="utf-8",
        )
        logger.info("Updated synthesis.json with held_out_validator_status=%s", status)
