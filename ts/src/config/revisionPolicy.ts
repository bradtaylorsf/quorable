/**
 * Revision policy: everything that decides what "done" means for
 * `quorable revise`, in one YAML file — criteria, one-time setup, pass/fail
 * checks, metric gates with thresholds and sample counts, per-round derive
 * steps, and the stop rules. Rubrics may contribute checks and metrics; CLI
 * flags add to lists and override scalars. Precedence for scalars:
 * CLI flag > policy file > built-in default.
 *
 * ```yaml
 * criteria: Fix the retry logic without changing the public API.
 * setup:   [{name: deps, run: [npm, ci]}]
 * checks:  [{name: tests, run: [npm, test]}]
 * metrics:
 *   - name: coverage
 *     run: [npm, run, -s, coverage]
 *     extract: {file: coverage/coverage-summary.json, json: total.lines.pct}
 *     goal: maximize
 *     threshold: 85
 *     runs: 1
 *     min_delta: 0.5
 * stop:
 *   require: [blocking, major]
 *   max_revisions: 5
 *   plateau_rounds: 2
 *   on_regression: revert
 * ```
 */
import fs from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { parseCheckFlag, validateCheck, type CommandCheck } from "../engine/checks.js";
import { parseMetricFlag, validateMetric, type MetricSpec } from "../engine/metrics.js";
import type { RegressionPolicy } from "../engine/revisionLoop.js";

const Name = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/, "names are letters, digits, . _ - (max 64), starting with a letter or digit");
const Argv = z.array(z.string().min(1)).min(1);
const Timeout = z.number().int().positive().default(600);

export const CheckEntrySchema = z.object({ name: Name, run: Argv, timeout_seconds: Timeout }).strict();
export const MetricEntrySchema = z.object({
  name: Name,
  run: Argv,
  timeout_seconds: Timeout,
  goal: z.enum(["maximize", "minimize"]),
  threshold: z.number(),
  runs: z.number().int().min(1).max(50).default(1),
  aggregate: z.enum(["median", "mean", "min", "max"]).default("median"),
  min_delta: z.number().min(0).default(0),
  extract: z.object({
    json: z.string().min(1).optional(),
    regex: z.string().min(1).optional(),
    file: z.string().min(1).optional(),
  }).strict().optional(),
  require_success: z.boolean().default(false),
}).strict();
export type CheckEntry = z.infer<typeof CheckEntrySchema>;
export type MetricEntry = z.infer<typeof MetricEntrySchema>;

export const SEVERITIES = ["blocking", "major", "minor"] as const;
export type Severity = typeof SEVERITIES[number];
export const REGRESSION_POLICIES = ["continue", "revert", "stop"] as const satisfies readonly RegressionPolicy[];

const StopSchema = z.object({
  require: z.array(z.enum(SEVERITIES)).min(1).optional(),
  max_revisions: z.number().int().min(0).optional(),
  max_investigations: z.number().int().min(0).optional(),
  max_jobs: z.number().int().min(1).optional(),
  max_elapsed_seconds: z.number().int().min(1).optional(),
  plateau_rounds: z.number().int().min(1).optional(),
  on_regression: z.enum(REGRESSION_POLICIES).optional(),
}).strict();

export const RevisionPolicySchema = z.object({
  criteria: z.string().trim().min(1).optional(),
  primary: z.string().min(1).optional(),
  exclude: z.array(Name).default([]),
  setup: z.array(CheckEntrySchema).default([]),
  checks: z.array(CheckEntrySchema).default([]),
  metrics: z.array(MetricEntrySchema).default([]),
  derive: z.array(CheckEntrySchema).default([]),
  stop: StopSchema.default({}),
}).strict();
export type RevisionPolicyFile = z.infer<typeof RevisionPolicySchema>;

export class PolicyError extends Error { override name = "PolicyError"; }

export function toCheck(entry: CheckEntry): CommandCheck {
  return validateCheck({ name: entry.name, argv: entry.run, timeoutMs: entry.timeout_seconds * 1000 });
}
export function toMetric(entry: MetricEntry): MetricSpec {
  return validateMetric({
    name: entry.name, argv: entry.run, timeoutMs: entry.timeout_seconds * 1000,
    goal: entry.goal, threshold: entry.threshold, runs: entry.runs, aggregate: entry.aggregate,
    minDelta: entry.min_delta, ...(entry.extract ? { extract: entry.extract } : {}),
    requireSuccess: entry.require_success,
  });
}

export function parseRevisionPolicy(text: string, label = "policy"): RevisionPolicyFile {
  let raw: unknown;
  try { raw = parseYaml(text) ?? {}; }
  catch (exc) { throw new PolicyError(`${label}: invalid YAML — ${exc instanceof Error ? exc.message : exc}`); }
  const parsed = RevisionPolicySchema.safeParse(raw);
  if (!parsed.success) {
    throw new PolicyError(`${label} is invalid:\n${parsed.error.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n")}`);
  }
  try { parsed.data.metrics.forEach(toMetric); parsed.data.checks.forEach(toCheck); }
  catch (exc) { throw new PolicyError(`${label}: ${exc instanceof Error ? exc.message : exc}`); }
  return parsed.data;
}
export function loadRevisionPolicy(file: string): RevisionPolicyFile {
  if (!fs.existsSync(file)) throw new PolicyError(`Policy file not found: ${file}`);
  return parseRevisionPolicy(fs.readFileSync(file, "utf8"), file);
}

export interface StopRules {
  require: Severity[];
  maxRevisions: number;
  maxInvestigations: number;
  maxJobs: number;
  maxElapsedSeconds: number;
  plateauRounds: number;
  onRegression: RegressionPolicy;
}
export const DEFAULT_STOP_RULES: StopRules = {
  require: ["blocking", "major"], maxRevisions: 3, maxInvestigations: 2, maxJobs: 40,
  maxElapsedSeconds: 1200, plateauRounds: 2, onRegression: "continue",
};

export interface RevisionPolicyFlags {
  criteria?: string; primary?: string; exclude?: string[];
  setup?: string[]; check?: string[]; metric?: string[]; derive?: string[];
  checkTimeoutMs?: number;
  require?: string[];
  maxRevisions?: number; maxInvestigations?: number; maxJobs?: number; maxElapsedSeconds?: number;
  plateauRounds?: number; onRegression?: string;
}
export interface ResolvedRevisionPolicy {
  criteria: string | null;
  primary: string | null;
  exclude: string[];
  setup: CommandCheck[];
  checks: CommandCheck[];
  metrics: MetricSpec[];
  derive: CommandCheck[];
  stop: StopRules;
}

/** Merge rubric measures, the policy file, and CLI flags into one validated policy. */
export function resolveRevisionPolicy(input: {
  file?: RevisionPolicyFile | null;
  rubric?: { checks?: CommandCheck[]; metrics?: MetricSpec[] };
  flags?: RevisionPolicyFlags;
}): ResolvedRevisionPolicy {
  const file = input.file ?? RevisionPolicySchema.parse({});
  const flags = input.flags ?? {};
  const timeoutMs = flags.checkTimeoutMs ?? 600_000;
  const fromFlags = <T>(values: string[] | undefined, parse: (v: string, t: number) => T): T[] => {
    try { return (values ?? []).map((v) => parse(v, timeoutMs)); }
    catch (exc) { throw new PolicyError(exc instanceof Error ? exc.message : String(exc)); }
  };
  const setup = [...file.setup.map(toCheck), ...fromFlags(flags.setup, parseCheckFlag)];
  const checks = [...(input.rubric?.checks ?? []), ...file.checks.map(toCheck), ...fromFlags(flags.check, parseCheckFlag)];
  const metrics = [...(input.rubric?.metrics ?? []), ...file.metrics.map(toMetric), ...fromFlags(flags.metric, parseMetricFlag)];
  const derive = [...file.derive.map(toCheck), ...fromFlags(flags.derive, parseCheckFlag)];
  const duplicate = (names: string[]): string | undefined => names.find((n, i) => names.indexOf(n) !== i);
  const gateDup = duplicate([...derive, ...checks, ...metrics].map((c) => c.name));
  if (gateDup) throw new PolicyError(`'${gateDup}' is defined more than once across derive, checks and metrics; names must be unique.`);
  const setupDup = duplicate(setup.map((c) => c.name));
  if (setupDup) throw new PolicyError(`Setup step '${setupDup}' is defined more than once.`);

  const require = flags.require?.length ? flags.require : file.stop.require ?? DEFAULT_STOP_RULES.require;
  const bad = require.find((s) => !(SEVERITIES as readonly string[]).includes(s));
  if (bad) throw new PolicyError(`Unknown severity '${bad}'; use blocking, major or minor.`);
  const required = [...new Set(["blocking", ...require])] as Severity[];
  const onRegression = (flags.onRegression ?? file.stop.on_regression ?? DEFAULT_STOP_RULES.onRegression) as RegressionPolicy;
  if (!(REGRESSION_POLICIES as readonly string[]).includes(onRegression)) throw new PolicyError(`on_regression must be continue, revert or stop, got '${onRegression}'.`);
  const pick = (flag: number | undefined, fromFile: number | undefined, fallback: number): number => flag ?? fromFile ?? fallback;
  return {
    criteria: flags.criteria?.trim() || file.criteria || null,
    primary: flags.primary ?? file.primary ?? null,
    exclude: [...file.exclude, ...(flags.exclude ?? [])],
    setup, checks, metrics, derive,
    stop: {
      require: required,
      maxRevisions: pick(flags.maxRevisions, file.stop.max_revisions, DEFAULT_STOP_RULES.maxRevisions),
      maxInvestigations: pick(flags.maxInvestigations, file.stop.max_investigations, DEFAULT_STOP_RULES.maxInvestigations),
      maxJobs: pick(flags.maxJobs, file.stop.max_jobs, DEFAULT_STOP_RULES.maxJobs),
      maxElapsedSeconds: pick(flags.maxElapsedSeconds, file.stop.max_elapsed_seconds, DEFAULT_STOP_RULES.maxElapsedSeconds),
      plateauRounds: pick(flags.plateauRounds, file.stop.plateau_rounds, DEFAULT_STOP_RULES.plateauRounds),
      onRegression,
    },
  };
}

/** Plain object for printing (`revise --dry-run`) and for the run manifest. */
export function policyToPlain(policy: ResolvedRevisionPolicy): Record<string, unknown> {
  const cmd = (c: CommandCheck): Record<string, unknown> => ({ name: c.name, run: c.argv, timeout_seconds: c.timeoutMs / 1000 });
  return {
    criteria: policy.criteria, primary: policy.primary, exclude: policy.exclude,
    setup: policy.setup.map(cmd), checks: policy.checks.map(cmd), derive: policy.derive.map(cmd),
    metrics: policy.metrics.map((m) => ({ ...cmd(m), goal: m.goal, threshold: m.threshold, runs: m.runs,
      aggregate: m.aggregate, min_delta: m.minDelta, ...(m.extract ? { extract: m.extract } : {}),
      require_success: m.requireSuccess ?? false })),
    stop: { require: policy.stop.require, max_revisions: policy.stop.maxRevisions,
      max_investigations: policy.stop.maxInvestigations, max_jobs: policy.stop.maxJobs,
      max_elapsed_seconds: policy.stop.maxElapsedSeconds, plateau_rounds: policy.stop.plateauRounds,
      on_regression: policy.stop.onRegression },
  };
}
