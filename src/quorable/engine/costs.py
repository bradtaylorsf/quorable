"""Cost estimation and controls.

Forked from the reference implementation's costs module (logic intact): estimates pipeline cost before
running based on input token counts and model pricing, with live pricing
refresh from OpenRouter. Extended with an optional drafter line item and a
per-loop multiplier so `quorable cost-estimate` covers the full
draft→panel→synthesis→revise loop.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field

import httpx

from quorable.engine.config import Config
from quorable.engine.manifest import ManifestEntry
from quorable.engine.prompts import CHARS_PER_TOKEN
from quorable.engine.schemas import Document

logger = logging.getLogger(__name__)

# Approximate output tokens per call.
ESTIMATED_OUTPUT_TOKENS_STAGE1 = 4000
ESTIMATED_OUTPUT_TOKENS_SYNTHESIS = 5000
ESTIMATED_OUTPUT_TOKENS_DRAFT = 4000

# OpenRouter pricing per 1M tokens (input/output).
# Last verified: 2026-07-05 via https://openrouter.ai/api/v1/models/<id>/endpoints
# Update when models or pricing change — check before each major run.
# NOTE: this table affects only the PRE-RUN ESTIMATE and abort-threshold math.
# Actual per-call cost is taken from OpenRouter's API response (usage.cost).
MODEL_PRICING: dict[str, tuple[float, float]] = {
    # Current models (verified 2026-07-05 from OpenRouter API)
    "x-ai/grok-4.3": (1.25, 2.50),
    "anthropic/claude-sonnet-5": (2.00, 10.00),
    "openai/gpt-5.5": (5.00, 30.00),
    "google/gemini-3.5-flash": (1.50, 9.00),
    "anthropic/claude-opus-4.7": (5.00, 25.00),
    "anthropic/claude-sonnet-4.6": (3.00, 15.00),
    "openai/gpt-5.4": (2.50, 15.00),
    # Earlier models (verified 2026-04-11)
    "x-ai/grok-4.1-fast": (0.20, 0.50),
    "openai/gpt-5.4-mini": (0.75, 4.50),
    "anthropic/claude-haiku-4.5": (1.00, 5.00),
    "google/gemini-3.1-pro-preview": (2.00, 12.00),
    "anthropic/claude-opus-4.6": (5.00, 25.00),
    # Legacy models (keep for historical run comparisons)
    "anthropic/claude-opus-4": (15.0, 75.0),
    "openai/gpt-5": (10.0, 30.0),
    "google/gemini-2.5-pro": (1.25, 10.0),
    "anthropic/claude-sonnet-4": (3.0, 15.0),
    "deepseek/deepseek-r1": (0.55, 2.19),
}

# Fallback pricing if model not in the table.
DEFAULT_PRICING: tuple[float, float] = (1.00, 5.00)

# Live pricing fetched from OpenRouter at CLI invocation time via
# refresh_live_pricing(). Checked before the static MODEL_PRICING table,
# so estimates track whatever models the config names without code edits.
OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models"
_LIVE_PRICING: dict[str, tuple[float, float]] = {}


def refresh_live_pricing(
    model_ids: list[str],
    timeout_seconds: float = 10.0,
) -> bool:
    """Fetch current pricing for the given models from OpenRouter's public API.

    Called by the CLI (cost-estimate / run) so estimates follow the config
    automatically. Deliberately NOT called inside estimate_pipeline_cost —
    the default test suite must stay network-free. Any failure degrades
    gracefully to the static table with a warning; a stale estimate is
    annoying, but a blocked run would be worse. Returns True if the fetch
    succeeded (even if some models were missing from the response).

    OpenRouter reports prices per token; we store per 1M tokens to match
    MODEL_PRICING.
    """
    wanted = set(model_ids)
    try:
        resp = httpx.get(OPENROUTER_MODELS_URL, timeout=timeout_seconds)
        resp.raise_for_status()
        data = resp.json().get("data", [])
    except Exception as exc:  # noqa: BLE001 — degrade to static table on any failure
        logger.warning(
            "Live pricing fetch failed (%s) — using static MODEL_PRICING table.",
            exc,
        )
        return False

    for model in data:
        mid = model.get("id")
        if mid not in wanted:
            continue
        pricing = model.get("pricing") or {}
        try:
            prompt = float(pricing["prompt"]) * 1_000_000
            completion = float(pricing["completion"]) * 1_000_000
        except (KeyError, TypeError, ValueError):
            logger.warning("Unparseable live pricing for %s — skipping.", mid)
            continue
        _LIVE_PRICING[mid] = (prompt, completion)
        logger.info(
            "Live pricing %s: $%.2f in / $%.2f out per 1M tokens", mid, prompt, completion
        )

    missing = wanted - set(_LIVE_PRICING)
    if missing:
        logger.warning(
            "No live pricing found for %s — static table/default will be used. "
            "Check the model id exists at https://openrouter.ai/models.",
            sorted(missing),
        )
    return True


def _get_pricing(model_id: str) -> tuple[float, float]:
    """Get (input_per_1m, output_per_1m) pricing for a model.

    Order: live OpenRouter pricing → static MODEL_PRICING table → default.
    Warns loudly on the default so a stale table can't silently skew the
    pre-run estimate (the abort threshold is derived from it).
    """
    if model_id in _LIVE_PRICING:
        return _LIVE_PRICING[model_id]
    if model_id not in MODEL_PRICING:
        logger.warning(
            "No pricing entry for %s — using DEFAULT_PRICING $%.2f/$%.2f per 1M. "
            "Estimate may be wrong; update MODEL_PRICING in costs.py "
            "(see https://openrouter.ai/api/v1/models/%s/endpoints).",
            model_id, DEFAULT_PRICING[0], DEFAULT_PRICING[1], model_id,
        )
    return MODEL_PRICING.get(model_id, DEFAULT_PRICING)


def _token_cost(tokens: int, price_per_1m: float) -> float:
    """Compute dollar cost for a token count at a given per-1M rate."""
    return (tokens / 1_000_000) * price_per_1m


@dataclass
class ModelEstimate:
    """Cost estimate for one model's contribution to the pipeline."""

    model_id: str
    num_calls: int
    input_tokens_per_call: int
    output_tokens_per_call: int
    input_cost_usd: float
    output_cost_usd: float

    @property
    def total_cost_usd(self) -> float:
        return self.input_cost_usd + self.output_cost_usd


@dataclass
class CostEstimate:
    """Full pipeline cost estimate."""

    model_estimates: list[ModelEstimate] = field(default_factory=list)
    # Multiplier applied by the loop (per-iteration estimate × iterations).
    iterations: int = 1

    @property
    def total_usd(self) -> float:
        return sum(m.total_cost_usd for m in self.model_estimates)

    @property
    def per_loop_usd(self) -> float:
        return self.total_usd * self.iterations


def estimate_prompt_chars(
    documents: list[Document],
    system_prompt_chars: int,
    persona_overlay_chars: int,
) -> int:
    """Estimate total character count for one Stage 1 prompt."""
    doc_chars = sum(d.char_count for d in documents)
    # Add overhead for delimiters, headers, schema instruction (~2K chars)
    overhead = 2000
    return system_prompt_chars + persona_overlay_chars + doc_chars + overhead


def estimate_pipeline_cost(
    *,
    config: Config,
    entries: list[ManifestEntry],
    documents: dict[str, Document],
    system_prompt_chars: int,
    persona_overlay_chars: dict[str, int],
    include_drafter: bool = False,
    iterations: int = 1,
) -> CostEstimate:
    """Estimate one iteration's cost before running.

    Accounts for: Stage 1 reviews (models × personas × runs_per_persona)
    plus one Stage 2 synthesis call, plus (optionally) one drafter call.
    `iterations` records the loop multiplier for per-loop reporting; the
    per-model line items stay per-iteration.
    """
    from quorable.engine.assembly import assemble_for_persona

    estimate = CostEstimate(iterations=max(1, iterations))
    runs_per_persona = config.pipeline.runs_per_persona

    # --- Stage 1: per-model estimates ---
    for model_cfg in config.active_reviewers:
        input_price, output_price = _get_pricing(model_cfg.id)
        total_input_tokens = 0
        num_calls = 0

        for persona in config.personas:
            docs = assemble_for_persona(persona, entries, documents)
            overlay_chars = persona_overlay_chars.get(persona, 1000)
            prompt_chars = estimate_prompt_chars(docs, system_prompt_chars, overlay_chars)
            input_tokens = prompt_chars // CHARS_PER_TOKEN

            total_input_tokens += input_tokens * runs_per_persona
            num_calls += runs_per_persona

        avg_input = total_input_tokens // num_calls if num_calls else 0
        input_cost = _token_cost(total_input_tokens, input_price)
        output_cost = _token_cost(
            num_calls * ESTIMATED_OUTPUT_TOKENS_STAGE1, output_price,
        )

        estimate.model_estimates.append(ModelEstimate(
            model_id=model_cfg.id,
            num_calls=num_calls,
            input_tokens_per_call=avg_input,
            output_tokens_per_call=ESTIMATED_OUTPUT_TOKENS_STAGE1,
            input_cost_usd=round(input_cost, 4),
            output_cost_usd=round(output_cost, 4),
        ))

    # --- Stage 2: synthesis model ---
    synth_model = config.models.synthesizer.id
    synth_input_price, synth_output_price = _get_pricing(synth_model)

    # Synthesis input = all Stage 1 outputs + reference docs + prompt overhead
    stage1_output_chars = (
        sum(m.num_calls for m in estimate.model_estimates)
        * ESTIMATED_OUTPUT_TOKENS_STAGE1
        * CHARS_PER_TOKEN
    )
    synth_input_chars = stage1_output_chars + system_prompt_chars + 5000
    synth_input_tokens = synth_input_chars // CHARS_PER_TOKEN

    estimate.model_estimates.append(ModelEstimate(
        model_id=synth_model,
        num_calls=1,
        input_tokens_per_call=synth_input_tokens,
        output_tokens_per_call=ESTIMATED_OUTPUT_TOKENS_SYNTHESIS,
        input_cost_usd=round(_token_cost(synth_input_tokens, synth_input_price), 4),
        output_cost_usd=round(
            _token_cost(ESTIMATED_OUTPUT_TOKENS_SYNTHESIS, synth_output_price), 4,
        ),
    ))

    # --- Drafter (one draft/revise call per iteration) ---
    if include_drafter and config.models.drafter is not None:
        drafter_model = config.models.drafter.id
        draft_input_price, draft_output_price = _get_pricing(drafter_model)
        doc_chars = sum(d.char_count for d in documents.values())
        draft_input_tokens = (doc_chars + system_prompt_chars + 5000) // CHARS_PER_TOKEN
        estimate.model_estimates.append(ModelEstimate(
            model_id=drafter_model,
            num_calls=1,
            input_tokens_per_call=draft_input_tokens,
            output_tokens_per_call=ESTIMATED_OUTPUT_TOKENS_DRAFT,
            input_cost_usd=round(_token_cost(draft_input_tokens, draft_input_price), 4),
            output_cost_usd=round(
                _token_cost(ESTIMATED_OUTPUT_TOKENS_DRAFT, draft_output_price), 4,
            ),
        ))

    logger.info(
        "Cost estimate: $%.2f per iteration (%d model line items, ×%d iterations = $%.2f)",
        estimate.total_usd, len(estimate.model_estimates),
        estimate.iterations, estimate.per_loop_usd,
    )

    return estimate


def format_cost_estimate(estimate: CostEstimate, config: Config) -> str:
    """Format a cost estimate as a human-readable string."""
    lines: list[str] = []
    lines.append("quorable — Cost Estimate")
    lines.append("=" * 50)

    lines.append(
        f"\n{'Model':<40} {'Calls':>5} {'In Tok':>8} {'Out Tok':>8} "
        f"{'In $':>8} {'Out $':>8} {'Total $':>8}"
    )
    lines.append("-" * 95)

    for m in estimate.model_estimates:
        lines.append(
            f"{m.model_id:<40} {m.num_calls:>5} "
            f"{m.input_tokens_per_call:>8} {m.output_tokens_per_call:>8} "
            f"${m.input_cost_usd:>7.4f} ${m.output_cost_usd:>7.4f} "
            f"${m.total_cost_usd:>7.4f}"
        )

    lines.append("-" * 95)
    lines.append(f"{'TOTAL':<40} {'':>5} {'':>8} {'':>8} {'':>8} {'':>8} ${estimate.total_usd:>7.4f}")

    if estimate.iterations > 1:
        lines.append(
            f"\nPer-loop (× {estimate.iterations} max iterations): "
            f"${estimate.per_loop_usd:.4f}"
        )

    lines.append(f"\nCost threshold (per loop): ${config.pipeline.cost_threshold:.2f}")
    lines.append(f"Abort multiplier: {config.pipeline.cost_abort_multiplier}x")
    lines.append(
        f"Abort at: ${config.pipeline.cost_threshold * config.pipeline.cost_abort_multiplier:.2f}"
    )

    if estimate.total_usd > config.pipeline.cost_threshold:
        lines.append(
            f"\n** Estimated cost ${estimate.total_usd:.2f} exceeds "
            f"${config.pipeline.cost_threshold:.2f} threshold — "
            f"confirmation required (--confirm flag or interactive y/n) **"
        )

    return "\n".join(lines)
