"""Stage 2 cross-model synthesis.

Forked from the reference implementation's synthesis module. Single call to the synthesis model with all
Stage 1 reviews as input. Genericized: the output schema comes from
pack.synthesis_schema; persona-weighting language lives in the project's
prompts/synthesis.md, not here. Agreement statistics are computed in Python
and patched over the LLM output; ranked-fix priority scores are recomputed
in code (LLM arithmetic is never trusted).
"""
from __future__ import annotations

import json
import logging
import time
from pathlib import Path
from typing import Any

from pydantic import BaseModel

from quorable.engine.agreement import compute_agreement
from quorable.engine.assembly import assemble_for_stage2
from quorable.engine.client import CostTracker, OpenRouterClient
from quorable.engine.config import Config
from quorable.engine.manifest import ManifestEntry
from quorable.engine.prompts import (
    DOC_DELIMITER,
    harden_system_prompt,
    load_system_prompt,
)
from quorable.engine.reviewer import ReviewResult
from quorable.engine.schemas import Document
from quorable.engine.validation import validated_call

logger = logging.getLogger(__name__)


def persona_coverage(
    results: list[ReviewResult],
    config: Config,
) -> dict[str, int]:
    """Count successful reviews per configured persona.

    A persona with zero successful reviews means an entire lens is missing
    from synthesis — that must be surfaced in the report, not just a log
    line, because project synthesis prompts typically weight some personas
    as the most important signal.
    """
    coverage = {p: 0 for p in config.personas}
    for r in results:
        if r.review is not None and r.persona in coverage:
            coverage[r.persona] += 1
    return coverage


def _format_reviews_for_prompt(results: list[ReviewResult]) -> str:
    """Serialize all successful Stage 1 reviews into a prompt section.

    Each review is labeled with model and persona so the synthesis model
    can attribute findings and detect model-specific patterns.
    """
    parts: list[str] = []
    for r in results:
        if r.review is None:
            continue
        label = f"REVIEW: model={r.model} persona={r.persona} run={r.run_number}"
        review_json = json.dumps(r.review.model_dump(), indent=2, ensure_ascii=False)
        parts.append(f"{label}\n{review_json}")
    return ("\n" + "=" * 60 + "\n").join(parts)


def _build_synthesis_schema_instruction(schema: type[BaseModel]) -> str:
    """Generate the JSON schema instruction from the pack's synthesis schema."""
    json_schema = schema.model_json_schema()
    return (
        "\n\nYou MUST respond with a single JSON object that conforms to "
        "the following schema. Do not include any text outside the JSON.\n\n"
        "```json\n"
        f"{json.dumps(json_schema, indent=2)}\n"
        "```"
    )


def _load_synthesis_prompt(prompts_dir: Path) -> str:
    """Load the synthesis prompt from prompts/synthesis.md."""
    path = prompts_dir / "synthesis.md"
    if not path.exists():
        raise FileNotFoundError(f"Synthesis prompt not found: {path}")
    return path.read_text(encoding="utf-8")


def _build_synthesis_messages(
    *,
    system_prompt: str,
    synthesis_prompt: str,
    reviews_text: str,
    documents: list[Document],
    schema: type[BaseModel],
) -> list[dict[str, str]]:
    """Build the message list for the synthesis model call.

    Layout:
    - system: the base system prompt
    - user: synthesis instructions + all reviews + relevant documents + schema
    """
    parts: list[str] = []

    # Synthesis-specific instructions
    parts.append("SYNTHESIS INSTRUCTIONS:\n" + synthesis_prompt)

    # All Stage 1 reviews
    parts.append(DOC_DELIMITER + "STAGE 1 REVIEWS" + DOC_DELIMITER + reviews_text)

    # Supporting documents for synthesis context
    if documents:
        parts.append(DOC_DELIMITER + "REFERENCE DOCUMENTS" + DOC_DELIMITER)
        for doc in documents:
            header = f"DOCUMENT: {doc.name}\nROLE: {doc.role}\n"
            parts.append(header + "-" * 40 + "\n" + doc.content)

    # Schema instruction
    parts.append(_build_synthesis_schema_instruction(schema))

    user_content = DOC_DELIMITER.join(parts)

    return [
        {"role": "system", "content": harden_system_prompt(system_prompt)},
        {"role": "user", "content": user_content},
    ]


def recompute_ranked_fixes(synthesis: BaseModel) -> None:
    """Recompute priority scores in code and sort ranked_fixes descending.

    priority = (impact² × consensus) / (1 + ease). The synthesis model is
    asked to compute this too, but its arithmetic is overwritten here.
    Duck-typed so any pack synthesis schema honoring the ranked_fixes
    convention gets the recompute, whether or not it reuses the engine's
    RankedFix model.
    """
    fixes = getattr(synthesis, "ranked_fixes", None)
    if not fixes:
        return
    for fix in fixes:
        impact = getattr(fix, "impact", None)
        ease = getattr(fix, "ease", None)
        consensus = getattr(fix, "consensus", None)
        if impact is None or ease is None or consensus is None:
            continue
        fix.priority_score = round((impact ** 2) * consensus / (1 + ease), 4)
    try:
        fixes.sort(key=lambda f: getattr(f, "priority_score", 0.0), reverse=True)
    except TypeError:
        logger.warning("Could not sort ranked_fixes — leaving model order")


async def run_stage2(
    *,
    config: Config,
    pack: Any,
    stage1_results: list[ReviewResult],
    entries: list[ManifestEntry],
    documents: dict[str, Document],
    run_dir: Path,
    cost_tracker: CostTracker | None = None,
) -> BaseModel | None:
    """Execute Stage 2 synthesis.

    Takes all Stage 1 results, computes agreement statistics in Python,
    calls the synthesis model with all reviews and reference docs, then
    patches the inter_rater_agreement field with the computed stats.
    """
    start = time.monotonic()

    # Filter to successful reviews
    successful = [r for r in stage1_results if r.review is not None]
    if not successful:
        logger.error("No successful Stage 1 reviews — cannot synthesize")
        return None

    # Warn if fewer than half the expected reviews succeeded
    expected = (
        len(config.active_reviewers)
        * len(config.personas)
        * config.pipeline.runs_per_persona
    )
    if len(successful) < expected * 0.5:
        logger.warning(
            "Only %d/%d reviews succeeded — synthesis may be unreliable",
            len(successful), expected,
        )

    # Surface entire-persona dropout loudly: a missing lens silently skews
    # the synthesis (project prompts typically weight certain personas).
    coverage = persona_coverage(stage1_results, config)
    missing_personas = [p for p, n in coverage.items() if n == 0]
    if missing_personas:
        logger.error(
            "PERSONA DROPOUT: no successful reviews for persona(s): %s — "
            "the synthesis will be missing these lenses entirely. "
            "Consider re-running with --persona <name> before relying on it.",
            ", ".join(missing_personas),
        )

    logger.info("Starting Stage 2 synthesis with %d reviews", len(successful))

    # --- Compute agreement statistics in Python (not by the LLM) ---
    reviews = [r.review for r in successful if r.review is not None]
    agreement = compute_agreement(
        reviews, pack, personas=[r.persona for r in successful],
    )

    # --- Build prompt ---
    system_prompt = load_system_prompt(config.paths.inputs)
    synthesis_prompt = _load_synthesis_prompt(config.paths.prompts)
    reviews_text = _format_reviews_for_prompt(successful)
    stage2_docs = assemble_for_stage2(entries, documents)

    messages = _build_synthesis_messages(
        system_prompt=system_prompt,
        synthesis_prompt=synthesis_prompt,
        reviews_text=reviews_text,
        documents=stage2_docs,
        schema=pack.synthesis_schema,
    )

    # --- Call synthesis model ---
    tracker = cost_tracker or CostTracker()
    async with OpenRouterClient(
        max_concurrency=1,
        timeout_seconds=config.pipeline.timeout_seconds,
        retry_attempts=config.pipeline.retry_attempts,
        cost_tracker=tracker,
    ) as client:
        synthesis = await validated_call(
            client,
            model=config.models.synthesizer.id,
            messages=messages,
            schema=pack.synthesis_schema,
            temperature=config.models.synthesizer.temperature,
            persona="synthesis",
        )

    if synthesis is None:
        logger.error("Stage 2 synthesis call failed validation")
        return None

    # --- Patch agreement stats (computed in Python, not by the LLM) ---
    if hasattr(synthesis, "inter_rater_agreement"):
        synthesis.inter_rater_agreement = agreement
    else:
        logger.warning(
            "Synthesis schema has no inter_rater_agreement field — computed "
            "stats will only appear in reports"
        )

    # --- Sanity-clamp LLM-reported reviewer counts ---
    # reviewer_count is the synthesis model's count of how many reviews
    # flagged a weakness; it cannot exceed the number of reviews it was given.
    n_reviews = len(successful)
    for w in getattr(synthesis, "consensus_weaknesses", []) or []:
        count = getattr(w, "reviewer_count", None)
        if count is not None and count > n_reviews:
            logger.warning(
                "Clamping impossible reviewer_count %d -> %d for weakness: %s",
                count, n_reviews, getattr(w, "description", "")[:60],
            )
            w.reviewer_count = n_reviews

    # --- Recompute + sort ranked fixes (LLM arithmetic never trusted) ---
    recompute_ranked_fixes(synthesis)

    # --- Save synthesis.json ---
    synthesis_path = run_dir / "synthesis.json"
    synthesis_path.write_text(
        json.dumps(synthesis.model_dump(), indent=2, ensure_ascii=False),
        encoding="utf-8",
    )
    logger.info("Saved synthesis to %s", synthesis_path)

    latency = round(time.monotonic() - start, 3)
    logger.info(
        "Stage 2 complete | reviews=%d latency=%.1fs cost=$%.4f",
        len(successful), latency, tracker.total_usd,
    )

    return synthesis
