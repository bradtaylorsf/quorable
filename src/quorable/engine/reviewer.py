"""Single Stage 1 review call end-to-end.

Forked from the reference implementation's reviewer module: orchestrates one complete review — prompt
construction → OpenRouter call → pydantic validation → JSON output. This is
the atomic unit the parallel pipeline fans out across models and personas.
Genericized: the review schema and canonical units come from the pack, and
run metadata pulls the primary-document hash via the pack's
primary_doc_name.
"""
from __future__ import annotations

import hashlib
import json
import logging
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import yaml
from pydantic import BaseModel

from quorable.engine.client import OpenRouterClient
from quorable.engine.config import Config
from quorable.engine.manifest import ManifestEntry
from quorable.engine.parsers import parse_document
from quorable.engine.prompts import build_messages, estimate_prompt_tokens
from quorable.engine.schemas import Document
from quorable.engine.validation import validated_call

logger = logging.getLogger(__name__)


@dataclass
class ReviewResult:
    """The outcome of a single Stage 1 review call."""

    model: str
    persona: str
    run_number: int
    review: BaseModel | None
    latency_seconds: float
    prompt_tokens_estimate: int
    validation_ok: bool
    error: str | None = None


def _prepare_documents(
    entries: list[ManifestEntry],
    *,
    primary_doc_name: str | None = None,
) -> dict[str, Document]:
    """Parse all manifest entries into Documents, skipping missing files."""
    documents: dict[str, Document] = {}
    for entry in entries:
        if entry.path.exists():
            try:
                documents[entry.name] = parse_document(
                    entry, primary_doc_name=primary_doc_name,
                )
            except Exception as exc:
                logger.warning("Failed to parse %s: %s", entry.name, exc)
    return documents


def _create_run_dir(output_dir: Path, run_id: str) -> Path:
    """Create the output directory structure for a pipeline run."""
    run_dir = output_dir / f"run_{run_id}"
    raw_dir = run_dir / "raw_reviews"
    raw_dir.mkdir(parents=True, exist_ok=True)
    return run_dir


def _save_review_json(
    run_dir: Path,
    model: str,
    persona: str,
    run_number: int,
    review: BaseModel,
) -> Path:
    """Save a validated review as JSON to the raw_reviews directory."""
    # Sanitize model name for filename (e.g., vendor/model-x → vendor_model-x)
    safe_model = model.replace("/", "_")
    filename = f"{safe_model}_{persona}_run{run_number}.json"
    raw_dir = run_dir / "raw_reviews"
    raw_dir.mkdir(parents=True, exist_ok=True)
    path = raw_dir / filename
    path.write_text(
        json.dumps(review.model_dump(), indent=2, ensure_ascii=False),
        encoding="utf-8",
    )
    logger.info("Saved review to %s", path)
    return path


def _build_run_metadata(
    config: Config,
    pack: Any,
    documents: dict[str, Document],
    system_prompt_hash: str,
    persona_hashes: dict[str, str],
    results: list[ReviewResult],
    run_id: str,
    start_time: float,
) -> dict[str, Any]:
    """Build the run_metadata.yaml content."""
    # Extract the primary-document hash for top-level visibility
    primary_hash = None
    primary_doc = documents.get(pack.primary_doc_name)
    if primary_doc is not None:
        primary_hash = primary_doc.sha256

    return {
        "run_id": run_id,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "duration_seconds": round(time.monotonic() - start_time, 2),
        "pack": pack.name,
        "config": {
            "models": [m.id for m in config.active_reviewers],
            "held_out_model": config.held_out_model_id,
            "personas": config.personas,
            "runs_per_persona": config.pipeline.runs_per_persona,
            "temperature": {m.id: m.temperature for m in config.active_reviewers},
        },
        "hashes": {
            pack.primary_doc_name: primary_hash,
            "system_prompt": system_prompt_hash,
            "personas": persona_hashes,
            "documents": {
                name: doc.sha256 for name, doc in documents.items()
            },
        },
        "results_summary": {
            "total": len(results),
            "succeeded": sum(1 for r in results if r.validation_ok),
            "failed": sum(1 for r in results if not r.validation_ok),
        },
    }


def save_run_metadata(run_dir: Path, metadata: dict[str, Any]) -> Path:
    """Write run_metadata.yaml to the run directory."""
    path = run_dir / "run_metadata.yaml"
    path.write_text(
        yaml.dump(metadata, default_flow_style=False, allow_unicode=True),
        encoding="utf-8",
    )
    logger.info("Saved run metadata to %s", path)
    return path


async def run_single_review(
    *,
    client: OpenRouterClient,
    model: str,
    persona: str,
    run_number: int,
    temperature: float,
    system_prompt: str,
    persona_overlay: str,
    documents: list[Document],
    schema: type[BaseModel],
    canonical_units: list[str] | None = None,
    unit_field: str = "unit",
) -> ReviewResult:
    """Execute a single Stage 1 review call.

    This is the core function: build prompt → call model → validate → return.
    Does not save to disk — the caller handles persistence.
    """
    start = time.monotonic()

    messages = build_messages(
        system_prompt=system_prompt,
        persona_overlay=persona_overlay,
        documents=documents,
        schema=schema,
        canonical_units=canonical_units,
        unit_field=unit_field,
    )
    token_estimate = estimate_prompt_tokens(messages)

    logger.info(
        "Starting review | model=%s persona=%s run=%d tokens≈%d",
        model, persona, run_number, token_estimate,
    )

    review = await validated_call(
        client,
        model=model,
        messages=messages,
        schema=schema,
        temperature=temperature,
        persona=persona,
    )

    latency = round(time.monotonic() - start, 3)
    validation_ok = review is not None

    if validation_ok:
        logger.info(
            "Review completed | model=%s persona=%s run=%d latency=%.1fs",
            model, persona, run_number, latency,
        )
    else:
        logger.warning(
            "Review failed validation | model=%s persona=%s run=%d latency=%.1fs",
            model, persona, run_number, latency,
        )

    return ReviewResult(
        model=model,
        persona=persona,
        run_number=run_number,
        review=review,
        latency_seconds=latency,
        prompt_tokens_estimate=token_estimate,
        validation_ok=validation_ok,
    )


def generate_run_id() -> str:
    """Generate a timestamped run ID."""
    return datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")


def hash_text(text: str) -> str:
    """SHA-256 hash of a string."""
    return hashlib.sha256(text.encode("utf-8")).hexdigest()
