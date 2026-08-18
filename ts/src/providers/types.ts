/**
 * Provider abstraction (plan M1).
 *
 * Model ids are provider-qualified: `openrouter:x-ai/grok-4.3`,
 * `anthropic:claude-sonnet-4-6`, `openai:gpt-5.4`, `local:llama-3.3-70b`
 * (an alias for `openai_compatible` with a base URL from config). A bare id
 * keeps today's meaning — OpenRouter — for backward compatibility.
 *
 * Beyond those built-ins, a config may name its OWN endpoints under
 * `providers.endpoints` — `lmstudio:qwen/qwen3.5-9b`, `together:…` — each
 * with its own base URL and key. Those names are passed in as resolution
 * context because they are a config concern, not a compiled-in list.
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
  /** Named `providers.endpoints` entry this ref resolves through, if any. */
  endpoint?: string;
}

/**
 * How a spec string resolves: which endpoint names exist, and which vendor
 * bucket each spec counts as for agreement statistics. Both come from
 * config, so every entry point that parses specs threads this through.
 */
export interface ModelResolution {
  /** Names configured under `providers.endpoints`. */
  endpoints?: readonly string[];
  /** Spec string → explicit vendor bucket (per-model or per-endpoint). */
  vendors?: Readonly<Record<string, string>>;
}

const PROVIDER_ALIASES: Record<string, ProviderKind> = {
  openrouter: "openrouter",
  anthropic: "anthropic",
  openai: "openai",
  openai_compatible: "openai_compatible",
  "openai-compatible": "openai_compatible",
  local: "openai_compatible",
};

export const BUILTIN_PROVIDER_PREFIXES = Object.keys(PROVIDER_ALIASES);

/** Levenshtein distance, for "did you mean" on a mistyped prefix. */
function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(
        prev[j]! + 1,
        row[j - 1]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = row;
  }
  return prev[b.length]!;
}

/** The nearest known name, if one is close enough to be a likely typo. */
function closestName(input: string, candidates: readonly string[]): string | null {
  let best: string | null = null;
  let bestDistance = Infinity;
  for (const name of candidates) {
    const d = editDistance(input, name.toLowerCase());
    if (d < bestDistance) {
      bestDistance = d;
      best = name;
    }
  }
  return bestDistance <= Math.max(2, Math.floor(input.length / 3)) ? best : null;
}

/**
 * Parse a (possibly provider-qualified) model spec.
 *
 * `vendor/model` ids with no prefix stay OpenRouter, including OpenRouter's
 * own `…:free` / `…:nitro` variant suffixes — those carry a `/` before the
 * colon, which is what distinguishes them from a provider prefix. An
 * unrecognized bare prefix is an ERROR rather than a silent fallthrough to
 * OpenRouter: a typo'd endpoint name must not quietly become a paid call.
 */
export function parseModelRef(spec: string, res: ModelResolution = {}): ModelRef {
  const idx = spec.indexOf(":");
  if (idx > 0) {
    const prefix = spec.slice(0, idx).toLowerCase();
    // A '/' before the colon means this is an OpenRouter id with a variant
    // suffix (meta-llama/llama-3.3-70b-instruct:free), not a prefix.
    if (!prefix.includes("/")) {
      const provider = PROVIDER_ALIASES[prefix];
      if (provider) {
        return { provider, model: spec.slice(idx + 1), raw: spec };
      }
      const endpoint = (res.endpoints ?? []).find((n) => n.toLowerCase() === prefix);
      if (endpoint) {
        return {
          provider: "openai_compatible",
          model: spec.slice(idx + 1),
          raw: spec,
          endpoint,
        };
      }
      const known = [...BUILTIN_PROVIDER_PREFIXES, ...(res.endpoints ?? [])];
      const nearest = closestName(prefix, known);
      throw new ProviderError(
        `Model '${spec}' names an unknown provider or endpoint '${prefix}'. ` +
          (nearest
            ? `Did you mean '${nearest}:${spec.slice(idx + 1)}'? `
            : `Known: ${known.join(", ")}. `) +
          `Define it under providers.endpoints, or run ` +
          `\`quorable config endpoint add ${prefix} <base-url>\`.`,
      );
    }
  }
  return { provider: "openrouter", model: spec, raw: spec };
}

/**
 * The vendor whose weights answer the call — the independence unit for
 * agreement statistics. OpenRouter ids carry the vendor as their path prefix
 * ("anthropic/claude-…" → "anthropic"); direct providers are their own
 * vendor.
 *
 * Openai-compatible/local endpoints default to ONE shared bucket ("local"),
 * because self-hosted variants of the same family are exactly the
 * correlated-rater case the warning exists for. That default is
 * deliberately pessimistic: a config that genuinely runs different weight
 * families locally (gemma + gpt-oss + qwen) declares their vendors
 * explicitly — per model, or per endpoint via `vendor_from_model_id` — and
 * takes responsibility for the claim.
 */
export function vendorOf(ref: ModelRef, res: ModelResolution = {}): string {
  const declared = res.vendors?.[ref.raw];
  if (declared) return declared;
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
  res: ModelResolution = {},
): string[] {
  const warnings: string[] = [];
  const vendors = new Set(reviewerSpecs.map((s) => vendorOf(parseModelRef(s, res), res)));
  if (reviewerSpecs.length < 2) {
    // κ/ICC need at least two raters to mean anything. One model is one
    // opinion, and the report must not let that pass as a measurement.
    warnings.push(
      `SINGLE-MODEL PANEL: only ${reviewerSpecs.length} reviewer model ` +
        `(${reviewerSpecs.join(", ") || "none"}). There are no agreement ` +
        `statistics in this run — κ/ICC need at least two independent raters — ` +
        `so every score is one model's opinion. Add a cross-vendor reviewer.`,
    );
  }
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
    const heldOutVendor = vendorOf(parseModelRef(heldOutSpec, res), res);
    const overlapping = reviewerSpecs.filter(
      (s) => vendorOf(parseModelRef(s, res), res) === heldOutVendor,
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
  res: ModelResolution = {},
): string[] {
  const warnings: string[] = [];
  for (const [persona, specs] of Object.entries(personaModels)) {
    const vendors = new Set(specs.map((s) => vendorOf(parseModelRef(s, res), res)));
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
