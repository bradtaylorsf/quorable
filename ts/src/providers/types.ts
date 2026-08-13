/**
 * Provider abstraction (plan M1).
 *
 * Model ids are provider-qualified: `openrouter:x-ai/grok-4.3`,
 * `anthropic:claude-sonnet-4-6`, `openai:gpt-5.4`, `local:llama-3.3-70b`
 * (an alias for `openai_compatible` with a base URL from config). A bare id
 * keeps today's meaning — OpenRouter — for backward compatibility.
 *
 * Every provider normalizes to the same response shape; `costUsd` is real
 * money on every path: OpenRouter reports it, Anthropic/OpenAI are priced
 * from the local table, local models price at zero.
 */

export type ProviderKind =
  | "openrouter"
  | "anthropic"
  | "openai"
  | "openai_compatible";

export interface ModelRef {
  provider: ProviderKind;
  /** Provider-native model id (e.g. "x-ai/grok-4.3", "claude-sonnet-4-6"). */
  model: string;
  /** The original spec string as configured. */
  raw: string;
}

const PROVIDER_ALIASES: Record<string, ProviderKind> = {
  openrouter: "openrouter",
  anthropic: "anthropic",
  openai: "openai",
  openai_compatible: "openai_compatible",
  "openai-compatible": "openai_compatible",
  local: "openai_compatible",
};

/** Parse a (possibly provider-qualified) model spec. Bare ids → openrouter. */
export function parseModelRef(spec: string): ModelRef {
  const idx = spec.indexOf(":");
  if (idx > 0) {
    const prefix = spec.slice(0, idx).toLowerCase();
    const provider = PROVIDER_ALIASES[prefix];
    if (provider) {
      return { provider, model: spec.slice(idx + 1), raw: spec };
    }
  }
  return { provider: "openrouter", model: spec, raw: spec };
}

/**
 * The vendor whose weights answer the call — the independence unit for
 * agreement statistics. OpenRouter ids carry the vendor as their path prefix
 * ("anthropic/claude-…" → "anthropic"); direct providers are their own
 * vendor; openai-compatible/local endpoints are one shared vendor bucket
 * ("local") because self-hosted variants of the same family are exactly the
 * correlated-rater case the warning exists for.
 */
export function vendorOf(ref: ModelRef): string {
  if (ref.provider === "openrouter") {
    const slash = ref.model.indexOf("/");
    return slash > 0 ? ref.model.slice(0, slash) : ref.model;
  }
  if (ref.provider === "openai_compatible") return "local";
  return ref.provider;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface NormalizedResponse {
  content: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
}

export interface ChatOptions {
  temperature: number;
  jsonMode: boolean;
  maxTokens?: number;
}

export interface Provider {
  readonly kind: ProviderKind;
  chat(model: string, messages: ChatMessage[], opts: ChatOptions): Promise<NormalizedResponse>;
}

export class ProviderError extends Error {
  override name = "ProviderError";
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

/** Only 429/500/503 and timeouts are retryable (parity with the parent). */
export function isRetryableStatus(status: number | undefined): boolean {
  return status === 429 || status === 500 || status === 503;
}

// ---------------------------------------------------------------------------
// Statistical-honesty warnings (M1 risk note + M6 cross-vendor rule)
// ---------------------------------------------------------------------------

/**
 * Warnings about panel composition. κ/ICC assume INDEPENDENT raters: a
 * single-vendor panel reads as high agreement when it is really shared
 * blind spots, and a held-out model sharing a vendor with a reviewer
 * weakens the held-out check's independence.
 */
export function panelVendorWarnings(
  reviewerSpecs: string[],
  heldOutSpec?: string | null,
): string[] {
  const warnings: string[] = [];
  const vendors = new Set(reviewerSpecs.map((s) => vendorOf(parseModelRef(s))));
  if (reviewerSpecs.length >= 2 && vendors.size === 1) {
    const [vendor] = vendors;
    warnings.push(
      `SINGLE-VENDOR PANEL: all ${reviewerSpecs.length} reviewer models are ` +
        `'${vendor}'. Agreement statistics assume independent raters — same-` +
        `vendor models share blind spots, so κ/ICC will overstate reliability. ` +
        `Add a reviewer from another vendor.`,
    );
  }
  if (heldOutSpec) {
    const heldOutVendor = vendorOf(parseModelRef(heldOutSpec));
    const overlapping = reviewerSpecs.filter(
      (s) => vendorOf(parseModelRef(s)) === heldOutVendor,
    );
    if (overlapping.length > 0) {
      warnings.push(
        `Held-out model ${heldOutSpec} shares vendor '${heldOutVendor}' with ` +
          `reviewer(s) ${overlapping.join(", ")} — same-family models have ` +
          `correlated blind spots; held-out validation is NOT meaningful. ` +
          `Prefer a cross-vendor held-out model.`,
      );
    }
  }
  return warnings;
}

/**
 * The interactive-picker guardrail (plan §5.4): a persona reviewed by fewer
 * than 2 cross-vendor models has no agreement statistics, just an opinion.
 */
export function personaModelWarnings(
  personaModels: Record<string, string[]>,
): string[] {
  const warnings: string[] = [];
  for (const [persona, specs] of Object.entries(personaModels)) {
    const vendors = new Set(specs.map((s) => vendorOf(parseModelRef(s))));
    if (specs.length < 2) {
      warnings.push(
        `Persona '${persona}' runs on a single model (${specs.join(", ") || "none"}) — ` +
          `no agreement statistics, just an opinion. Assign ≥2 cross-vendor models.`,
      );
    } else if (vendors.size < 2) {
      warnings.push(
        `Persona '${persona}' runs only on vendor '${[...vendors][0]}' — ` +
          `agreement statistics will overstate reliability. Mix vendors.`,
      );
    }
  }
  return warnings;
}
