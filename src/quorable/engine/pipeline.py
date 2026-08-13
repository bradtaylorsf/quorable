"""Stage 1 parallel review pipeline.

Forked from the reference implementation's pipeline module. Fans out review calls across all
(model, persona, run_number) combinations using asyncio.gather with
semaphore-based concurrency limiting. Enforces held-out model exclusion,
the cost abort threshold, and graceful failure handling.

Genericizations: document-type classification markers come from
pack.doc_type_markers; the committed-document guard checks the pack's
primary document; the review schema comes from the pack. The loop can also
inject an in-memory primary text (interim revisions) and share a cost
tracker/abort threshold across iterations.
"""
from __future__ import annotations

import asyncio
import logging
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from quorable.engine.assembly import assemble_for_persona
from quorable.engine.client import CostTracker, OpenRouterClient
from quorable.engine.config import Config, ReviewerModelConfig
from quorable.engine.logging_config import add_file_handler
from quorable.engine.manifest import load_manifest
from quorable.engine.parsers import document_from_text, parse_document
from quorable.engine.prompts import load_persona_overlay, load_system_prompt
from quorable.engine.reviewer import (
    ReviewResult,
    _build_run_metadata,
    _create_run_dir,
    _save_review_json,
    generate_run_id,
    hash_text,
    run_single_review,
    save_run_metadata,
)
from quorable.engine.schemas import Document

logger = logging.getLogger(__name__)


class CostAbortError(Exception):
    """Raised when running cost exceeds the abort threshold."""


class UncommittedPrimaryDocError(Exception):
    """Raised when the primary document has uncommitted changes."""


class DocumentTypeMismatchError(Exception):
    """Raised when the reviewed document does not match config.document_type."""


# Classification looks ONLY at the head region (first N chars): a document
# usually states its own type near the top, while its BODY freely mentions
# the other modes, which would poison a whole-document scan.
_HEAD_REGION_CHARS = 3000


def classify_document_type(
    content: str,
    markers: dict[str, list[str]],
) -> str | None:
    """Best-effort classification of the primary document's type.

    `markers` is the pack's doc_type_markers: type name → marker strings.
    Returns the single type whose markers match the head region, or None
    when no type (or more than one type) matches — ambiguity never asserts
    a classification.
    """
    head = content[:_HEAD_REGION_CHARS].upper()
    matched = [
        doc_type
        for doc_type, marks in markers.items()
        if any(m.upper() in head for m in marks)
    ]
    if len(matched) == 1:
        return matched[0]
    return None


def _check_document_type(
    config: Config,
    pack: Any,
    documents: dict[str, Document],
) -> None:
    """Abort loudly if the primary document contradicts config.document_type."""
    if config.document_type is None or not pack.doc_type_markers:
        return
    doc = documents.get(pack.primary_doc_name)
    if doc is None:
        return
    detected = classify_document_type(doc.content, pack.doc_type_markers)
    if detected is None:
        logger.warning(
            "Could not classify %s against pack.doc_type_markers — proceeding "
            "on config.document_type=%s. Verify the right document is in the "
            "%s slot.",
            pack.primary_doc_name, config.document_type, pack.primary_doc_name,
        )
        return
    if detected != config.document_type:
        raise DocumentTypeMismatchError(
            f"config.document_type is '{config.document_type}' but the "
            f"document in the {pack.primary_doc_name} slot reads as a "
            f"'{detected}'. The persona set and system prompt for this mode "
            f"would apply the wrong review standard. Check that the correct "
            f"file is in the manifest slot and that you passed the right "
            f"--project."
        )


def check_primary_committed(primary_path: Path) -> None:
    """Verify the primary document is committed before running the pipeline.

    Prevents data loss by ensuring the version being reviewed is tracked in
    git and can be recovered if the file is later modified or corrupted.
    """
    if not primary_path.exists():
        return  # Nothing to check if the primary doc doesn't exist yet

    try:
        result = subprocess.run(
            ["git", "status", "--porcelain", "--", str(primary_path)],
            capture_output=True,
            text=True,
            cwd=primary_path.parent,
            timeout=10,
        )
        if result.returncode == 0 and result.stdout.strip():
            raise UncommittedPrimaryDocError(
                f"{primary_path.name} has uncommitted changes. Commit before "
                f"running the pipeline to ensure the reviewed version is "
                f"recoverable.\n"
                f"  git add {primary_path} && git commit -m 'draft: <description>'\n"
                f"Status: {result.stdout.strip()}"
            )
    except subprocess.TimeoutExpired:
        logger.warning("Git status check timed out — skipping commit check")
    except FileNotFoundError:
        logger.warning("Git not found — skipping commit check")


@dataclass
class ReviewJob:
    """One scheduled review: a (model, persona, run_number) combination."""

    model_config: ReviewerModelConfig
    persona: str
    run_number: int


@dataclass
class Stage1Result:
    """The complete result of a Stage 1 parallel run."""

    run_id: str
    run_dir: Path
    results: list[ReviewResult]
    total_cost_usd: float
    succeeded: int
    failed: int
    cost_tracker: CostTracker | None = None
    entries: list | None = None
    documents: dict[str, Document] | None = None


def _build_job_list(
    config: Config,
) -> list[ReviewJob]:
    """Generate all (model, persona, run) combinations, excluding held-out.

    The held-out model is excluded by using config.active_reviewers, which
    filters out any reviewer marked held_out. The dedicated held-out model
    from config.models.held_out is never included in Stage 1 — this is
    enforced here in code, not just in configuration.
    """
    held_out_id = config.held_out_model_id
    jobs: list[ReviewJob] = []

    for model_cfg in config.active_reviewers:
        # Belt-and-suspenders: even if a reviewer somehow has the held-out ID,
        # skip it.
        if model_cfg.id == held_out_id:
            logger.warning(
                "Reviewer model %s matches held-out model — skipping from Stage 1",
                model_cfg.id,
            )
            continue

        for persona in config.personas:
            for run in range(1, config.pipeline.runs_per_persona + 1):
                jobs.append(ReviewJob(
                    model_config=model_cfg,
                    persona=persona,
                    run_number=run,
                ))

    logger.info(
        "Built %d review jobs (%d models × %d personas × %d runs)",
        len(jobs),
        len(config.active_reviewers),
        len(config.personas),
        config.pipeline.runs_per_persona,
    )
    return jobs


async def run_stage1(
    config: Config,
    pack: Any,
    *,
    filter_persona: str | None = None,
    filter_model: str | None = None,
    run_dir: Path | None = None,
    primary_text: str | None = None,
    cost_tracker: CostTracker | None = None,
    abort_threshold: float | None = None,
    skip_commit_check: bool = False,
) -> Stage1Result:
    """Execute the full Stage 1 parallel review pipeline.

    Loads documents, constructs prompts per persona, fans out all review
    calls with concurrency limiting, tracks cost, and saves results.

    Loop integration: `run_dir` reuses an existing directory (iteration
    dirs); `primary_text` overrides the primary document with in-memory text
    (interim revisions that exist only in the run directory);
    `cost_tracker`/`abort_threshold` share the per-loop cost governor.
    """
    start_time = time.monotonic()

    # --- Load inputs ---
    inputs_dir = config.paths.inputs
    entries = load_manifest(inputs_dir / "manifest.yaml", inputs_dir)

    # --- Pre-flight: ensure the primary document is committed ---
    # Skipped when the loop injects an interim revision (that text lives in
    # the run directory, not in inputs/) — the loop performs the guard once
    # on the starting document instead.
    if not skip_commit_check and primary_text is None:
        for entry in entries:
            if entry.name == pack.primary_doc_name:
                check_primary_committed(entry.path)
                break

    if run_dir is None:
        run_id = generate_run_id()
        run_dir = _create_run_dir(config.paths.outputs, run_id)
    else:
        run_id = run_dir.name.removeprefix("run_")
        (run_dir / "raw_reviews").mkdir(parents=True, exist_ok=True)

    # Attach structured file handler so all log output goes to run.log
    file_handler = add_file_handler(run_dir)
    logger.info("Run %s started — logging to %s", run_id, run_dir / "run.log")

    # Status marker so an interrupted run leaves an explicit record instead
    # of a directory that silently looks like a run that never finished.
    status_path = run_dir / "run_status.txt"
    status_path.write_text("running\n", encoding="utf-8")

    documents: dict[str, Document] = {}
    for entry in entries:
        if entry.path.exists():
            try:
                documents[entry.name] = parse_document(
                    entry, primary_doc_name=pack.primary_doc_name,
                )
            except Exception as exc:
                logger.warning("Failed to parse %s: %s", entry.name, exc)

    if primary_text is not None:
        prior = documents.get(pack.primary_doc_name)
        documents[pack.primary_doc_name] = document_from_text(
            pack.primary_doc_name,
            primary_text,
            role=prior.role if prior else "Primary document under review",
            tier=prior.tier if prior else 1,
        )

    # Abort before spending money if the document under review does not
    # match the configured mode.
    _check_document_type(config, pack, documents)

    system_prompt = load_system_prompt(inputs_dir)
    system_prompt_hash = hash_text(system_prompt)

    # Load all persona overlays
    persona_overlays: dict[str, str] = {}
    persona_hashes: dict[str, str] = {}
    for persona in config.personas:
        overlay = load_persona_overlay(config.paths.personas, persona)
        persona_overlays[persona] = overlay
        persona_hashes[persona] = hash_text(overlay)

    # --- Build job list ---
    jobs = _build_job_list(config)

    # Apply filters if specified
    if filter_persona:
        jobs = [j for j in jobs if j.persona == filter_persona]
        logger.info("Filtered to persona=%s: %d jobs", filter_persona, len(jobs))
    if filter_model:
        jobs = [j for j in jobs if j.model_config.id == filter_model]
        logger.info("Filtered to model=%s: %d jobs", filter_model, len(jobs))

    if not jobs:
        logger.warning("No review jobs to run after filtering")
        status_path.write_text("completed (no jobs after filtering)\n", encoding="utf-8")
        logging.getLogger().removeHandler(file_handler)
        file_handler.close()
        return Stage1Result(
            run_id=run_id, run_dir=run_dir, results=[],
            total_cost_usd=0.0, succeeded=0, failed=0,
            entries=entries, documents=documents,
        )

    # --- Pre-assemble per-persona document lists ---
    persona_docs: dict[str, list[Document]] = {}
    for persona in config.personas:
        persona_docs[persona] = assemble_for_persona(persona, entries, documents)

    # --- Run reviews in parallel ---
    tracker = cost_tracker or CostTracker()
    cost_threshold = (
        abort_threshold
        if abort_threshold is not None
        else config.pipeline.cost_threshold * config.pipeline.cost_abort_multiplier
    )

    async with OpenRouterClient(
        max_concurrency=config.pipeline.max_concurrency,
        timeout_seconds=config.pipeline.timeout_seconds,
        retry_attempts=config.pipeline.retry_attempts,
        cost_tracker=tracker,
    ) as client:
        semaphore = asyncio.Semaphore(config.pipeline.max_concurrency)

        async def _run_with_cost_check(job: ReviewJob) -> ReviewResult:
            """Run one review, checking cost threshold before starting."""
            if tracker.total_usd > cost_threshold:
                raise CostAbortError(
                    f"Running cost ${tracker.total_usd:.2f} exceeds "
                    f"abort threshold ${cost_threshold:.2f}"
                )

            async with semaphore:
                # Re-check inside the semaphore: this is the point where a
                # job actually starts spending money, potentially long after
                # the coroutine was created (when cost was still ~0).
                if tracker.total_usd > cost_threshold:
                    raise CostAbortError(
                        f"Running cost ${tracker.total_usd:.2f} exceeds "
                        f"abort threshold ${cost_threshold:.2f}"
                    )
                return await run_single_review(
                    client=client,
                    model=job.model_config.id,
                    persona=job.persona,
                    run_number=job.run_number,
                    temperature=job.model_config.temperature,
                    system_prompt=system_prompt,
                    persona_overlay=persona_overlays[job.persona],
                    documents=persona_docs[job.persona],
                    schema=pack.review_schema,
                    canonical_units=pack.canonical_units or None,
                    unit_field=pack.unit_field,
                )

        # Use gather with return_exceptions so one failure doesn't cancel all
        raw_results = await asyncio.gather(
            *[_run_with_cost_check(job) for job in jobs],
            return_exceptions=True,
        )

    # --- Process results ---
    results: list[ReviewResult] = []
    for i, raw in enumerate(raw_results):
        if isinstance(raw, CostAbortError):
            logger.error("Cost abort: %s", raw)
            status_path.write_text(f"aborted: {raw}\n", encoding="utf-8")
            logging.getLogger().removeHandler(file_handler)
            file_handler.close()
            raise raw
        if isinstance(raw, Exception):
            job = jobs[i]
            logger.error(
                "Review failed with exception | model=%s persona=%s run=%d error=%s",
                job.model_config.id, job.persona, job.run_number, raw,
            )
            results.append(ReviewResult(
                model=job.model_config.id,
                persona=job.persona,
                run_number=job.run_number,
                review=None,
                latency_seconds=0.0,
                prompt_tokens_estimate=0,
                validation_ok=False,
                error=str(raw),
            ))
        else:
            results.append(raw)

    # --- Save outputs ---
    for result in results:
        if result.review is not None:
            _save_review_json(
                run_dir, result.model, result.persona,
                result.run_number, result.review,
            )

    succeeded = sum(1 for r in results if r.validation_ok)
    failed = sum(1 for r in results if not r.validation_ok)

    # Save run metadata
    metadata = _build_run_metadata(
        config=config,
        pack=pack,
        documents=documents,
        system_prompt_hash=system_prompt_hash,
        persona_hashes=persona_hashes,
        results=results,
        run_id=run_id,
        start_time=start_time,
    )
    metadata["cost"] = {
        "total_usd": round(tracker.total_usd, 4),
        "threshold_usd": config.pipeline.cost_threshold,
        "abort_multiplier": config.pipeline.cost_abort_multiplier,
    }
    metadata["duration_seconds"] = round(time.monotonic() - start_time, 2)
    save_run_metadata(run_dir, metadata)

    # Remove file handler to avoid leaking into subsequent runs
    logging.getLogger().removeHandler(file_handler)
    file_handler.close()

    logger.info(
        "Stage 1 complete | run_id=%s succeeded=%d failed=%d cost=$%.4f",
        run_id, succeeded, failed, tracker.total_usd,
    )
    status_path.write_text(
        f"completed (succeeded={succeeded} failed={failed})\n", encoding="utf-8"
    )

    return Stage1Result(
        run_id=run_id,
        run_dir=run_dir,
        results=results,
        total_cost_usd=tracker.total_usd,
        succeeded=succeeded,
        failed=failed,
        cost_tracker=tracker,
        entries=entries,
        documents=documents,
    )
