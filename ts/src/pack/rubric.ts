/**
 * The generic pack (plan M3 — the keystone): a rubric YAML becomes a
 * working Pack with no code. Review and synthesis schemas are generated at
 * load time with zod; everything downstream — agreement math, gates, ship
 * logic, reports, golden — is unchanged because it all reads the Pack.
 *
 * ```yaml
 * name: blog-post
 * units: [hook, argument, evidence, structure, close]
 * dimensions:
 *   clarity:      {weight: 1.0, scale: [1, 10]}
 *   originality:  {weight: 1.5, scale: [1, 10]}
 * verdict:
 *   field: publish_readiness
 *   categories: [ship, revise, rethink]
 * gates:
 *   - word_count: {max: 2000}
 *   - banned_elements: ["as an AI", "in today's fast-paced"]
 *   - term_lint: {Quorable: [quorable, Qorable]}
 * ship:
 *   composite_min: 7.0
 *   dimension_min: 5
 *   blocking: severity_1_findings   # named built-in, not a lambda
 *   composite_exclude_personas: [red_team]
 * ```
 */

import fs from "node:fs";

import { parse as parseYaml } from "yaml";
import { z } from "zod";

import { bannedElementsGate, termLintGate, wordCountGate, type Gate } from "../engine/gates.js";
import { BLOCKING_BUILTINS } from "../engine/scoring.js";
import { PackError, type Pack } from "./types.js";

// ---------------------------------------------------------------------------
// Rubric file schema
// ---------------------------------------------------------------------------

const DimensionSchema = z.object({
  weight: z.number().positive().default(1.0),
  scale: z.tuple([z.number(), z.number()]).default([1, 10]),
  description: z.string().default(""),
});

const GateEntrySchema = z.union([
  z.object({ word_count: z.object({ max: z.number().int().positive(), section: z.string().optional(), line_prefix: z.string().optional() }) }),
  z.object({ banned_elements: z.array(z.string()).min(1) }),
  z.object({ term_lint: z.record(z.string(), z.array(z.string())) }),
]);

const RubricSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(""),
  units: z.array(z.string().min(1)).min(1),
  dimensions: z.record(z.string().min(1), DimensionSchema).refine(
    (d) => Object.keys(d).length > 0,
    { message: "at least one dimension is required" },
  ),
  verdict: z.object({
    field: z.string().min(1).default("verdict"),
    categories: z.array(z.string().min(1)).min(2),
  }),
  gates: z.array(GateEntrySchema).default([]),
  ship: z.object({
    composite_min: z.number(),
    dimension_min: z.number(),
    blocking: z.string().nullish().default("severity_1_findings"),
    composite_exclude_personas: z.array(z.string()).default([]),
  }),
  unit_keyword_rules: z.array(z.tuple([z.string(), z.string()])).default([]),
});

export type Rubric = z.infer<typeof RubricSchema>;

export function parseRubric(yamlText: string, sourceLabel = "rubric"): Rubric {
  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (exc) {
    throw new PackError(`${sourceLabel}: invalid YAML — ${exc instanceof Error ? exc.message : exc}`);
  }
  const parsed = RubricSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new PackError(`${sourceLabel} is invalid:\n${detail}`);
  }
  const rubric = parsed.data;
  if (rubric.ship.blocking && !(rubric.ship.blocking in BLOCKING_BUILTINS)) {
    throw new PackError(
      `${sourceLabel}: ship.blocking names unknown built-in '${rubric.ship.blocking}' ` +
        `(available: ${Object.keys(BLOCKING_BUILTINS).join(", ")})`,
    );
  }
  return rubric;
}

export function loadRubricFile(filePath: string): Rubric {
  if (!fs.existsSync(filePath)) {
    throw new PackError(`Rubric file not found: ${filePath}`);
  }
  return parseRubric(fs.readFileSync(filePath, "utf-8"), filePath);
}

// ---------------------------------------------------------------------------
// Schema generation
// ---------------------------------------------------------------------------

/** Conventional Finding shape (CONTRACT.md): every attack cites a location
 * and states what would neutralize it. */
export const FindingSchema = z.object({
  description: z.string(),
  severity: z.number().int().min(1).max(5),
  location: z.string().default(""),
  suggested_fix: z.string().default(""),
});

/** M6/§5.3 validation tasks: claims a reviewer could not ground. */
export const ValidationRequestSchema = z.object({
  claim: z.string(),
  source_doc: z.string().default(""),
  what_would_confirm: z.string().default(""),
});

export const WeaknessSchema = z.object({
  description: z.string(),
  unit: z.string(),
  severity: z.enum(["critical", "major", "minor"]),
  reviewer_count: z.number().int(),
  suggested_fix: z.string(),
});

export const ContestedIssueSchema = z.object({
  description: z.string(),
  position_a: z.string(),
  position_b: z.string(),
  models_supporting_a: z.array(z.string()),
  models_supporting_b: z.array(z.string()),
});

export const UniqueArgumentSchema = z.object({
  description: z.string(),
  source_model: z.string(),
  source_persona: z.string(),
  assessment: z.string(),
});

export const RankedFixSchema = z.object({
  description: z.string(),
  unit: z.string(),
  impact: z.number().int().min(1).max(5),
  ease: z.number().int().min(1).max(5),
  consensus: z.number().min(0).max(1),
  priority_score: z.number().default(0),
});

function buildReviewSchema(rubric: Rubric): z.ZodType<Record<string, unknown>> {
  const unitShape: Record<string, z.ZodType> = {
    unit: z.string(),
  };
  for (const [dim, spec] of Object.entries(rubric.dimensions)) {
    const [lo, hi] = spec.scale;
    unitShape[dim] = z.number().min(lo).max(hi);
  }
  unitShape[rubric.verdict.field] = z.enum(
    rubric.verdict.categories as [string, ...string[]],
  );
  unitShape["weaknesses"] = z.array(z.string()).default([]);
  unitShape["rationale"] = z.string().default("");

  const reviewShape: Record<string, z.ZodType> = {
    persona: z.string().default(""),
    model_id: z.string().default(""),
    unit_reviews: z.array(z.object(unitShape)),
    confidence: z.number().min(0).max(1).default(0.5),
    findings: z.array(FindingSchema).default([]),
    suspected_prompt_injection: z.array(z.string()).default([]),
    validation_requests: z.array(ValidationRequestSchema).default([]),
  };
  reviewShape[rubric.verdict.field] = z.enum(
    rubric.verdict.categories as [string, ...string[]],
  );
  return z.object(reviewShape) as z.ZodType<Record<string, unknown>>;
}

function buildSynthesisSchema(): z.ZodType<Record<string, unknown>> {
  return z.object({
    consensus_weaknesses: z.array(WeaknessSchema),
    contested_issues: z.array(ContestedIssueSchema).default([]),
    ranked_fixes: z.array(RankedFixSchema).default([]),
    unique_arguments: z.array(UniqueArgumentSchema).default([]),
    inter_rater_agreement: z.record(z.string(), z.number()).default({}),
    held_out_validator_status: z.string().default("not_yet_run"),
  }) as z.ZodType<Record<string, unknown>>;
}

function buildGates(rubric: Rubric): Gate[] {
  const gates: Gate[] = [];
  for (const entry of rubric.gates) {
    if ("word_count" in entry) {
      const cfg = entry.word_count;
      gates.push(
        wordCountGate(cfg.max, {
          section: cfg.section ?? null,
          linePrefix: cfg.line_prefix ?? null,
        }),
      );
    } else if ("banned_elements" in entry) {
      gates.push(bannedElementsGate(entry.banned_elements));
    } else if ("term_lint" in entry) {
      gates.push(termLintGate(entry.term_lint));
    }
  }
  return gates;
}

/** A rubric YAML becomes a working Pack — no per-domain code. */
export function buildPackFromRubric(rubric: Rubric): Pack {
  const dimensionWeights = Object.fromEntries(
    Object.entries(rubric.dimensions).map(([d, spec]) => [d, spec.weight]),
  );
  const dimensionScales = Object.fromEntries(
    Object.entries(rubric.dimensions).map(([d, spec]) => [d, spec.scale]),
  ) as Record<string, [number, number]>;
  const allWeightsOne = Object.values(dimensionWeights).every((w) => w === 1.0);

  return {
    name: rubric.name,
    reviewSchema: buildReviewSchema(rubric),
    synthesisSchema: buildSynthesisSchema(),
    scoreDimensions: Object.keys(rubric.dimensions),
    verdictField: rubric.verdict.field,
    verdictCategories: rubric.verdict.categories,
    canonicalUnits: rubric.units,
    unitField: "unit",
    unitListField: "unit_reviews",
    unitScoreField: null,
    unitKeywordRules: rubric.unit_keyword_rules,
    primaryDocName: "primary_document",
    docTypeMarkers: {},
    mechanicalGates: buildGates(rubric),
    shipGates: {
      compositeMin: rubric.ship.composite_min,
      dimensionMin: rubric.ship.dimension_min,
      blockingFindings: rubric.ship.blocking
        ? BLOCKING_BUILTINS[rubric.ship.blocking]!
        : null,
      weights: allWeightsOne ? null : dimensionWeights,
      compositeExcludePersonas: rubric.ship.composite_exclude_personas,
    },
    drafterEnabled: false,
    heldOutRecommendedDocs: [],
    dimensionScales,
    dimensionWeights,
  };
}

export function loadPackFromRubricFile(filePath: string): Pack {
  return buildPackFromRubric(loadRubricFile(filePath));
}
