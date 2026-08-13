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
});

export const ReviewerSchema = ModelRoleSchema.extend({
  held_out: z.boolean().default(false),
});

export const RIGOR_TIERS = ["quick", "standard", "rigorous"] as const;
export type RigorTier = (typeof RIGOR_TIERS)[number];

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
    })
    .strict()
    .prefault({}),
  council: z.string().default("general-doc"),
  rigor: z.enum(RIGOR_TIERS).default("standard"),
  /** Rubric name override; default resolves from the council. */
  rubric: z.string().nullish().default(null),
  /** Persona override; default resolves from the council. */
  personas: z.array(z.string()).default([]),
  providers: z
    .object({
      local_base_url: z.string().nullish().default(null),
    })
    .strict()
    .prefault({}),
});

export type QuorableConfig = z.infer<typeof ConfigSchema>;

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
