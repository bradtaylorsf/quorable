/**
 * Cost estimation and controls, ported from costs.py.
 *
 * The static pricing table affects only the PRE-RUN ESTIMATE and the
 * abort-threshold math. Actual per-call cost comes from the provider
 * (OpenRouter reports usage.cost; Anthropic/OpenAI report tokens, priced
 * from the same table; local models cost zero). The cost governor ABORTS —
 * it never degrades a run to stay under budget.
 */

import { parseModelRef, type ModelRef } from "../providers/types.js";
import { pythonRound } from "./pyformat.js";

/** Rough estimate: 1 token ≈ 4 characters for English text. */
export const CHARS_PER_TOKEN = 4;

export const ESTIMATED_OUTPUT_TOKENS_STAGE1 = 4000;
export const ESTIMATED_OUTPUT_TOKENS_SYNTHESIS = 5000;
export const ESTIMATED_OUTPUT_TOKENS_DRAFT = 4000;

/**
 * OpenRouter pricing per 1M tokens (input/output), carried verbatim from the
 * Python engine (last verified 2026-07-05). Update when models or pricing
 * change; live pricing (refreshLivePricing) is checked first at CLI time.
 */
export const MODEL_PRICING: Record<string, [number, number]> = {
  // Current models (verified 2026-07-05 from OpenRouter API)
  "x-ai/grok-4.3": [1.25, 2.5],
  "anthropic/claude-sonnet-5": [2.0, 10.0],
  "openai/gpt-5.5": [5.0, 30.0],
  "google/gemini-3.5-flash": [1.5, 9.0],
  "anthropic/claude-opus-4.7": [5.0, 25.0],
  "anthropic/claude-sonnet-4.6": [3.0, 15.0],
  "openai/gpt-5.4": [2.5, 15.0],
  // Earlier models (verified 2026-04-11)
  "x-ai/grok-4.1-fast": [0.2, 0.5],
  "openai/gpt-5.4-mini": [0.75, 4.5],
  "anthropic/claude-haiku-4.5": [1.0, 5.0],
  "google/gemini-3.1-pro-preview": [2.0, 12.0],
  "anthropic/claude-opus-4.6": [5.0, 25.0],
  // Legacy models (keep for historical run comparisons)
  "anthropic/claude-opus-4": [15.0, 75.0],
  "openai/gpt-5": [10.0, 30.0],
  "google/gemini-2.5-pro": [1.25, 10.0],
  "anthropic/claude-sonnet-4": [3.0, 15.0],
  "deepseek/deepseek-r1": [0.55, 2.19],
};

export const DEFAULT_PRICING: [number, number] = [1.0, 5.0];

export const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";

const livePricing = new Map<string, [number, number]>();

/**
 * Fetch current pricing for the given models from OpenRouter's public API.
 * Called by the CLI so estimates follow the config automatically; any
 * failure degrades gracefully to the static table. Never called in tests.
 */
export async function refreshLivePricing(
  modelIds: string[],
  timeoutMs = 10_000,
): Promise<boolean> {
  const wanted = new Set(modelIds);
  let data: { id?: string; pricing?: { prompt?: string; completion?: string } }[];
  try {
    const resp = await fetch(OPENROUTER_MODELS_URL, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const body = (await resp.json()) as { data?: typeof data };
    data = body.data ?? [];
  } catch {
    return false;
  }
  for (const model of data) {
    const mid = model.id;
    if (!mid || !wanted.has(mid)) continue;
    const prompt = Number.parseFloat(model.pricing?.prompt ?? "");
    const completion = Number.parseFloat(model.pricing?.completion ?? "");
    if (!Number.isFinite(prompt) || !Number.isFinite(completion)) continue;
    livePricing.set(mid, [prompt * 1_000_000, completion * 1_000_000]);
  }
  return true;
}

/**
 * (input_per_1M, output_per_1M): live → static table → provider-aware
 * fallback.
 *
 * A provider-qualified spec is priced on its bare model id, and models on a
 * local/openai-compatible endpoint price at ZERO unless the table happens to
 * know them — mirroring exactly what OpenAIProvider records at call time, so
 * the pre-run estimate matches the bill. Without this, a local panel would
 * estimate at the default hosted rate and show money it never spends.
 */
export function getPricing(
  modelId: string,
  endpoints: readonly string[] = [],
): [number, number] {
  const live = livePricing.get(modelId);
  if (live) return live;
  const known = MODEL_PRICING[modelId];
  if (known) return known;

  let ref: ModelRef;
  try {
    ref = parseModelRef(modelId, { endpoints });
  } catch {
    return DEFAULT_PRICING;
  }
  if (ref.provider === "openai_compatible") {
    return MODEL_PRICING[ref.model] ?? [0, 0];
  }
  if (ref.raw !== ref.model) {
    return livePricing.get(ref.model) ?? MODEL_PRICING[ref.model] ?? DEFAULT_PRICING;
  }
  return DEFAULT_PRICING;
}

export function tokenCost(tokens: number, pricePer1M: number): number {
  return (tokens / 1_000_000) * pricePer1M;
}

// ---------------------------------------------------------------------------
// Cost tracking (per run/loop)
// ---------------------------------------------------------------------------

export interface CallRecord {
  model: string;
  promptHash: string;
  latencySeconds: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
}

export class CostTracker {
  totalUsd = 0;
  records: CallRecord[] = [];

  record(call: CallRecord): void {
    this.totalUsd += call.costUsd;
    this.records.push(call);
  }
}

export class CostAbortError extends Error {
  override name = "CostAbortError";
}

// ---------------------------------------------------------------------------
// Pre-run estimation
// ---------------------------------------------------------------------------

export interface ModelEstimate {
  modelId: string;
  numCalls: number;
  inputTokensPerCall: number;
  outputTokensPerCall: number;
  inputCostUsd: number;
  outputCostUsd: number;
}

export function modelEstimateTotal(m: ModelEstimate): number {
  return m.inputCostUsd + m.outputCostUsd;
}

export interface CostEstimate {
  modelEstimates: ModelEstimate[];
  iterations: number;
}

export function estimateTotalUsd(estimate: CostEstimate): number {
  return estimate.modelEstimates.reduce((acc, m) => acc + modelEstimateTotal(m), 0);
}

export function estimatePerLoopUsd(estimate: CostEstimate): number {
  return estimateTotalUsd(estimate) * estimate.iterations;
}

/** Estimate total character count for one Stage 1 prompt. */
export function estimatePromptChars(
  docChars: number[],
  systemPromptChars: number,
  personaOverlayChars: number,
): number {
  const overhead = 2000;
  return (
    systemPromptChars +
    personaOverlayChars +
    docChars.reduce((a, b) => a + b, 0) +
    overhead
  );
}

export interface EstimateInputs {
  /** Reviewer model ids, held-out already excluded. */
  reviewerIds: string[];
  synthesizerId: string;
  drafterId: string | null;
  runsPerPersona: number;
  personas: string[];
  /** Per-persona document char counts (post send_to routing). */
  personaDocChars: (persona: string) => number[];
  /** All parsed document char counts (drafter input). */
  allDocChars: number[];
  systemPromptChars: number;
  personaOverlayChars: Record<string, number>;
  includeDrafter: boolean;
  iterations: number;
  /** Configured endpoint names, so local specs price at zero. */
  endpoints?: readonly string[];
}

/**
 * Estimate one iteration's cost before running: Stage 1 reviews
 * (models × personas × runs) + one synthesis call + optionally one drafter
 * call. `iterations` records the loop multiplier for per-loop reporting.
 */
export function estimatePipelineCost(inputs: EstimateInputs): CostEstimate {
  const estimate: CostEstimate = {
    modelEstimates: [],
    iterations: Math.max(1, inputs.iterations),
  };
  const runsPerPersona = inputs.runsPerPersona;

  for (const modelId of inputs.reviewerIds) {
    const [inputPrice, outputPrice] = getPricing(modelId, inputs.endpoints ?? []);
    let totalInputTokens = 0;
    let numCalls = 0;

    for (const persona of inputs.personas) {
      const docChars = inputs.personaDocChars(persona);
      const overlayChars = inputs.personaOverlayChars[persona] ?? 1000;
      const promptChars = estimatePromptChars(
        docChars,
        inputs.systemPromptChars,
        overlayChars,
      );
      const inputTokens = Math.floor(promptChars / CHARS_PER_TOKEN);
      totalInputTokens += inputTokens * runsPerPersona;
      numCalls += runsPerPersona;
    }

    const avgInput = numCalls ? Math.floor(totalInputTokens / numCalls) : 0;
    estimate.modelEstimates.push({
      modelId,
      numCalls,
      inputTokensPerCall: avgInput,
      outputTokensPerCall: ESTIMATED_OUTPUT_TOKENS_STAGE1,
      inputCostUsd: pythonRound(tokenCost(totalInputTokens, inputPrice), 4),
      outputCostUsd: pythonRound(
        tokenCost(numCalls * ESTIMATED_OUTPUT_TOKENS_STAGE1, outputPrice),
        4,
      ),
    });
  }

  // --- Stage 2: synthesis ---
  const [synthInputPrice, synthOutputPrice] = getPricing(
    inputs.synthesizerId,
    inputs.endpoints ?? [],
  );
  const stage1OutputChars =
    estimate.modelEstimates.reduce((acc, m) => acc + m.numCalls, 0) *
    ESTIMATED_OUTPUT_TOKENS_STAGE1 *
    CHARS_PER_TOKEN;
  const synthInputChars = stage1OutputChars + inputs.systemPromptChars + 5000;
  const synthInputTokens = Math.floor(synthInputChars / CHARS_PER_TOKEN);

  estimate.modelEstimates.push({
    modelId: inputs.synthesizerId,
    numCalls: 1,
    inputTokensPerCall: synthInputTokens,
    outputTokensPerCall: ESTIMATED_OUTPUT_TOKENS_SYNTHESIS,
    inputCostUsd: pythonRound(tokenCost(synthInputTokens, synthInputPrice), 4),
    outputCostUsd: pythonRound(
      tokenCost(ESTIMATED_OUTPUT_TOKENS_SYNTHESIS, synthOutputPrice),
      4,
    ),
  });

  // --- Drafter (one draft/revise call per iteration) ---
  if (inputs.includeDrafter && inputs.drafterId !== null) {
    const [draftInputPrice, draftOutputPrice] = getPricing(
      inputs.drafterId,
      inputs.endpoints ?? [],
    );
    const docChars = inputs.allDocChars.reduce((a, b) => a + b, 0);
    const draftInputTokens = Math.floor(
      (docChars + inputs.systemPromptChars + 5000) / CHARS_PER_TOKEN,
    );
    estimate.modelEstimates.push({
      modelId: inputs.drafterId,
      numCalls: 1,
      inputTokensPerCall: draftInputTokens,
      outputTokensPerCall: ESTIMATED_OUTPUT_TOKENS_DRAFT,
      inputCostUsd: pythonRound(tokenCost(draftInputTokens, draftInputPrice), 4),
      outputCostUsd: pythonRound(
        tokenCost(ESTIMATED_OUTPUT_TOKENS_DRAFT, draftOutputPrice),
        4,
      ),
    });
  }

  return estimate;
}
