/**
 * Config schema + packaged defaults (plan M2/Blocker 3).
 *
 * Layering, later wins: packaged defaults → ~/.quorable/config.yaml →
 * project config → environment variables → CLI flags. Models stay purely a
 * config concern (§5.4): councils name personas only, and the interactive
 * picker writes config rather than being a second system.
 */

import { z } from "zod";

export const ModelRoleSchema = z.object({
  id: z.string().min(1),
  temperature: z.number().min(0).max(2).default(0.2),
  /**
   * Vendor bucket for agreement statistics. Only needed for local /
   * openai-compatible models, which default to one shared "local" bucket —
   * set this when the panel genuinely runs different weight families and
   * κ/ICC should treat them as independent raters.
   */
  vendor: z.string().min(1).nullish().default(null),
});

export const ReviewerSchema = ModelRoleSchema.extend({
  held_out: z.boolean().default(false),
});

export const RIGOR_TIERS = ["quick", "standard", "rigorous"] as const;
export type RigorTier = (typeof RIGOR_TIERS)[number];

/**
 * A named OpenAI-compatible endpoint (`providers.endpoints.<name>`), usable
 * as a model prefix: `lmstudio:qwen/qwen3.5-9b`. Covers local servers
 * (Ollama, LM Studio, llama.cpp, vLLM) and hosted OpenAI-compatible APIs
 * (Together, Groq, Fireworks, DeepSeek) with no code change.
 */
export const EndpointSchema = z
  .object({
    /** e.g. http://localhost:1234/v1 — include the /v1. */
    base_url: z.string().min(1),
    /**
     * Env var holding this endpoint's key, read from the process env first,
     * then ~/.quorable/.env. Omit for local servers that need no key.
     * Preferred over `api_key` — keeps secrets out of committed config.
     */
    api_key_env: z.string().min(1).nullish().default(null),
    /** Literal key. Discouraged in a committed project config. */
    api_key: z.string().min(1).nullish().default(null),
    /**
     * Whether the endpoint accepts `response_format: {type: "json_object"}`.
     * Off by default: many local servers reject it outright, and the
     * schema instruction + repair loop is the real safety net.
     */
    json_mode: z.boolean().default(false),
    /** Vendor bucket for every model here (agreement statistics). */
    vendor: z.string().min(1).nullish().default(null),
    /**
     * Derive the vendor bucket from the model id's `vendor/model` prefix,
     * the way OpenRouter ids work. Right for aggregators and for LM Studio
     * ids like `google/gemma-4-26b-a4b`.
     */
    vendor_from_model_id: z.boolean().default(false),
  })
  .strict();

export const ConfigSchema = z.object({
  models: z
    .object({
      reviewers: z.array(ReviewerSchema).min(1),
      synthesizer: ModelRoleSchema,
      held_out: ModelRoleSchema,
      drafter: ModelRoleSchema.nullish().default(null),
    })
    .strict(),
  pipeline: z
    .object({
      runs_per_persona: z.number().int().min(1).default(2),
      max_concurrency: z.number().int().min(1).default(5),
      timeout_seconds: z.number().int().min(30).default(300),
      retry_attempts: z.number().int().min(0).default(3),
      // Per-LOOP threshold. The governor ABORTS at threshold × multiplier —
      // it never degrades a run to stay under budget.
      cost_threshold: z.number().min(0).default(20.0),
      cost_abort_multiplier: z.number().min(1).default(2.0),
      max_iterations: z.number().int().min(1).default(3),
      /**
       * What to do when the SYNTHESIZER returns no schema-valid JSON.
       * "none" (default) keeps the run without a narrative. "markdown" makes
       * one more unvalidated call for prose, which weak local synthesizers
       * can manage when strict JSON defeats them. Scores, gates and
       * agreement statistics are computed in code from the raw reviews, so
       * the narrative layer failing over costs nothing in integrity.
       * Reviewer-stage validation is NEVER relaxed by this.
       */
      synthesis_fallback: z.enum(["none", "markdown"]).default("none"),
    })
    .strict()
    .prefault({}),
  /**
   * Active profile name. A profile is a named bundle of settings — normally
   * "which local backend does this job run on" — selected per job rather
   * than merged together. Running two local servers at once makes them
   * compete for memory and evict each other's models mid-run, so a job
   * picks one.
   */
  profile: z.string().min(1).nullish().default(null),
  /**
   * Named partial configs, expanded in place wherever `profile` selects one.
   * A layer's own explicit keys still beat the profile it selected, and
   * definitions accumulate across layers while the SELECTION switches.
   */
  profiles: z.record(z.string().min(1), z.record(z.string(), z.unknown())).default({}),
  council: z.string().default("general-doc"),
  rigor: z.enum(RIGOR_TIERS).default("standard"),
  /** Rubric name override; default resolves from the council. */
  rubric: z.string().nullish().default(null),
  /** Persona override; default resolves from the council. */
  personas: z.array(z.string()).default([]),
  providers: z
    .object({
      /** Base URL for the built-in `local:` / `openai_compatible:` prefix. */
      local_base_url: z.string().nullish().default(null),
      /** Named OpenAI-compatible endpoints, addressable as `<name>:<model>`. */
      endpoints: z.record(z.string().min(1), EndpointSchema).default({}),
    })
    .strict()
    .prefault({}),
});

export type QuorableConfig = z.infer<typeof ConfigSchema>;
export type EndpointConfig = z.infer<typeof EndpointSchema>;

/**
 * Spec → vendor bucket, from per-model `vendor` and per-endpoint policy.
 * Only entries that actually declare something appear; everything else
 * falls back to `vendorOf`'s conservative defaults.
 */
export function vendorOverrides(config: QuorableConfig): Record<string, string> {
  const endpoints = config.providers.endpoints;
  const out: Record<string, string> = {};

  const fromEndpoint = (spec: string): string | null => {
    const idx = spec.indexOf(":");
    if (idx <= 0) return null;
    const prefix = spec.slice(0, idx);
    if (prefix.includes("/")) return null;
    const endpoint = endpoints[prefix];
    if (!endpoint) return null;
    if (endpoint.vendor) return endpoint.vendor;
    if (endpoint.vendor_from_model_id) {
      const model = spec.slice(idx + 1);
      const slash = model.indexOf("/");
      if (slash > 0) return model.slice(0, slash);
    }
    return null;
  };

  const roles = [
    ...config.models.reviewers,
    config.models.synthesizer,
    config.models.held_out,
    ...(config.models.drafter ? [config.models.drafter] : []),
  ];
  for (const role of roles) {
    const declared = role.vendor ?? fromEndpoint(role.id);
    if (declared) out[role.id] = declared;
  }
  return out;
}

/** Endpoint names, for resolving `<name>:<model>` specs. */
export function endpointNames(config: QuorableConfig): string[] {
  return Object.keys(config.providers.endpoints);
}

export function activeReviewers(config: QuorableConfig) {
  return config.models.reviewers.filter((r) => !r.held_out);
}

/**
 * Packaged default models: cross-vendor by construction, all reachable with
 * a single OpenRouter key (the zero-config path), held-out cross-vendor
 * against every reviewer.
 */
export const PACKAGED_DEFAULTS = {
  models: {
    reviewers: [
      { id: "anthropic/claude-sonnet-4.6", temperature: 0.2 },
      { id: "openai/gpt-5.4", temperature: 0.2 },
      { id: "google/gemini-3.5-flash", temperature: 0.2 },
    ],
    synthesizer: { id: "anthropic/claude-sonnet-4.6", temperature: 0.1 },
    held_out: { id: "x-ai/grok-4.3", temperature: 0.2 },
  },
} satisfies Record<string, unknown>;

// ---------------------------------------------------------------------------
// Rigor tiers (plan M5) — config-overlay presets, not new code paths.
// ---------------------------------------------------------------------------

export interface RigorSettings {
  runsPerPersona: number;
  /** null = full council; N = council's top N personas. */
  personaLimit: number | null;
  agreementStats: boolean;
  heldOut: boolean;
  goldenPreRun: boolean;
  regressions: boolean;
  /** Revise-loop iterations (when drafting): null = config max_iterations. */
  maxIterations: number | null;
  /** Unresolved validation tasks block the ship gate at this tier. */
  validationTasksBlock: boolean;
}

export const RIGOR_PRESETS: Record<RigorTier, RigorSettings> = {
  quick: {
    runsPerPersona: 1,
    personaLimit: 3,
    agreementStats: false,
    heldOut: false,
    goldenPreRun: false,
    regressions: false,
    maxIterations: 1,
    validationTasksBlock: false,
  },
  standard: {
    runsPerPersona: 2,
    personaLimit: null,
    agreementStats: true,
    heldOut: false,
    goldenPreRun: false,
    regressions: true,
    maxIterations: 1,
    validationTasksBlock: false,
  },
  rigorous: {
    runsPerPersona: 2,
    personaLimit: null,
    agreementStats: true,
    heldOut: true,
    goldenPreRun: true,
    regressions: true,
    maxIterations: null,
    validationTasksBlock: true,
  },
};
// The cold reader (M6.1) runs at EVERY tier — it is not a rigor option.

/**
 * Warn when one job's models span more than one LOCAL backend. Two servers
 * on the same machine compete for the same memory and evict each other's
 * models mid-run (observed as "Model unloaded" 400s that silently thin the
 * panel). Remote endpoints are exempt — several hosted APIs at once is
 * normal and costs nothing.
 */
export function localBackendWarnings(config: QuorableConfig): string[] {
  const endpoints = config.providers.endpoints;
  const isLocal = (url: string): boolean =>
    /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:|\/|$)/i.test(url);

  const specs = [
    ...config.models.reviewers.filter((r) => !r.held_out).map((r) => r.id),
    config.models.synthesizer.id,
  ];
  const used = new Set<string>();
  for (const spec of specs) {
    const idx = spec.indexOf(":");
    if (idx <= 0) continue;
    const prefix = spec.slice(0, idx);
    if (prefix.includes("/")) continue;
    const endpoint = endpoints[prefix];
    if (endpoint && isLocal(endpoint.base_url)) used.add(prefix);
  }
  if (used.size < 2) return [];
  return [
    `TWO LOCAL BACKENDS IN ONE RUN: models are split across ${[...used].sort().join(" and ")}, ` +
      `which run on this machine and will compete for memory — each can evict the ` +
      `other's models mid-run and silently thin the panel. Put this job on one ` +
      `backend (\`quorable config profile use <name>\`).`,
  ];
}
