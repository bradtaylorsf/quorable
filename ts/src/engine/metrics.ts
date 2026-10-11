/**
 * Metric gates: a named command whose output yields a number, compared to a
 * threshold. Each round the command runs `runs` times and the samples are
 * aggregated, so a noisy measurement (a benchmark, a sampled eval, a flaky
 * pass rate) is judged on a stable value. The number is extracted by code
 * from the command's output, or from a file it writes inside the candidate;
 * it is never taken from an agent's report.
 *
 * `minDelta` does double duty: it is the smallest change that counts as
 * meaningful progress, and the tolerance before a worse value counts as a
 * regression. Set it at or above the measurement's noise floor.
 */
import fs from "node:fs";
import path from "node:path";
import { abnormalExit, runCommandCheck, validateCheck, type CommandCheck } from "./checks.js";
import { insideOrEqual } from "./tree.js";

export type MetricGoal = "maximize" | "minimize";
export type MetricAggregate = "median" | "mean" | "min" | "max";
export interface MetricExtract {
  /** Dotted path into JSON (`total.lines.pct`, `results[0].score`); stdout, or `file` when given. */
  json?: string;
  /** Regex; the first capture group (or whole match) of the LAST match is the value. */
  regex?: string;
  /** File the command writes, relative to the candidate directory (read after the command exits). */
  file?: string;
}
export interface MetricSpec extends CommandCheck {
  goal: MetricGoal;
  threshold: number;
  /** Samples per measurement. */
  runs: number;
  aggregate: MetricAggregate;
  /** Smallest change in the goal direction that counts as progress; also the regression tolerance. */
  minDelta: number;
  /** Without one, the value is the last number printed on stdout (then stderr). */
  extract?: MetricExtract;
  /** When true a non-zero exit fails the sample; by default only the extracted number matters. */
  requireSuccess?: boolean;
}
export interface MetricMeasurement {
  name: string;
  value: number | null;
  samples: (number | null)[];
  spread: number | null;
  passed: boolean;
  findings: string[];
  logs: string[];
}

export const MAX_METRIC_RUNS = 50;
const GOALS: MetricGoal[] = ["maximize", "minimize"];
const AGGREGATES: MetricAggregate[] = ["median", "mean", "min", "max"];

export function validateMetric(metric: MetricSpec): MetricSpec {
  validateCheck(metric);
  const where = `Metric '${metric.name}'`;
  if (!GOALS.includes(metric.goal)) throw new Error(`${where}: goal must be maximize or minimize.`);
  if (!Number.isFinite(metric.threshold)) throw new Error(`${where}: threshold must be a finite number.`);
  if (!Number.isSafeInteger(metric.runs) || metric.runs < 1 || metric.runs > MAX_METRIC_RUNS) throw new Error(`${where}: runs must be 1–${MAX_METRIC_RUNS}.`);
  if (!AGGREGATES.includes(metric.aggregate)) throw new Error(`${where}: aggregate must be one of ${AGGREGATES.join(", ")}.`);
  if (!Number.isFinite(metric.minDelta) || metric.minDelta < 0) throw new Error(`${where}: min_delta must be a non-negative number.`);
  const e = metric.extract;
  if (e) {
    if (e.json !== undefined && e.regex !== undefined) throw new Error(`${where}: extract with json or regex, not both.`);
    if (e.json !== undefined && !e.json.trim()) throw new Error(`${where}: extract.json is empty.`);
    if (e.regex !== undefined) {
      try { new RegExp(e.regex); } catch (exc) { throw new Error(`${where}: invalid extract.regex — ${exc instanceof Error ? exc.message : exc}`); }
    }
    if (e.file !== undefined && (!e.file.trim() || path.isAbsolute(e.file) || e.file.split(/[\\/]+/).includes(".."))) {
      throw new Error(`${where}: extract.file must be a relative path inside the candidate.`);
    }
  }
  return metric;
}

const METRIC_FLAG = /^\s*([A-Za-z0-9][A-Za-z0-9_.-]{0,63})\s*(>=|<=)\s*(-?\d+(?:\.\d+)?)((?:\s*(?:x\d+|~\d+(?:\.\d+)?))*)\s*:\s*(\S.*)$/;

/**
 * `name >= threshold [xRUNS] [~MIN_DELTA]: command args` — `>=` maximizes, `<=` minimizes.
 * Whitespace-split command, no shell; the value is the last number printed. Use a policy
 * file for JSON, regex, or file extraction.
 */
export function parseMetricFlag(value: string, timeoutMs: number): MetricSpec {
  const m = METRIC_FLAG.exec(value);
  if (!m) throw new Error(`Expected 'name >= threshold [xRUNS] [~MIN_DELTA]: command' (or <=), got '${value}'.`);
  let runs = 1; let minDelta = 0;
  for (const token of m[4]!.trim().split(/\s+/).filter(Boolean)) {
    if (token.startsWith("x")) runs = Number(token.slice(1)); else minDelta = Number(token.slice(1));
  }
  return validateMetric({
    name: m[1]!, goal: m[2] === ">=" ? "maximize" : "minimize", threshold: Number(m[3]),
    runs, minDelta, aggregate: "median", argv: m[5]!.trim().split(/\s+/), timeoutMs,
  });
}

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const NUMBER = /[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?/g;

function lastNumber(text: string): number | null {
  const all = text.match(NUMBER);
  return all ? Number(all[all.length - 1]) : null;
}
function toNumber(raw: unknown, what: string): number {
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw.trim()) : NaN;
  if (!Number.isFinite(n)) throw new Error(`${what} is not a finite number: ${JSON.stringify(raw)?.slice(0, 80)}`);
  return n;
}
/** Whole text as JSON, else the last line that parses as a JSON object or array. */
function parseJsonOutput(text: string): unknown {
  try { return JSON.parse(text); } catch { /* fall through */ }
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith("{") || l.startsWith("["));
  for (let i = lines.length - 1; i >= 0; i--) {
    try { return JSON.parse(lines[i]!); } catch { /* keep looking */ }
  }
  throw new Error("output contains no JSON document");
}
export function jsonPath(doc: unknown, dotted: string): unknown {
  const segments = dotted.replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean);
  let cur: unknown = doc;
  for (const seg of segments) {
    if (cur === null || typeof cur !== "object") throw new Error(`JSON path '${dotted}' stops at '${seg}'`);
    cur = Array.isArray(cur) ? cur[Number(seg)] : (cur as Record<string, unknown>)[seg];
    if (cur === undefined) throw new Error(`JSON path '${dotted}' has no '${seg}'`);
  }
  return cur;
}

export function extractValue(output: { stdout: string; stderr: string }, extract: MetricExtract | undefined, cwd: string): number {
  const stdout = output.stdout.replace(ANSI, "");
  const stderr = output.stderr.replace(ANSI, "");
  let text = stdout;
  if (extract?.file) {
    const root = fs.realpathSync(cwd);
    const resolved = path.resolve(root, extract.file);
    if (!fs.existsSync(resolved)) throw new Error(`metric file not written: ${extract.file}`);
    const real = fs.realpathSync(resolved);
    if (!insideOrEqual(real, root)) throw new Error(`metric file escapes the candidate: ${extract.file}`);
    text = fs.readFileSync(real, "utf8").replace(ANSI, "");
  }
  if (extract?.json) return toNumber(jsonPath(parseJsonOutput(text.trim()), extract.json), `JSON path '${extract.json}'`);
  const sources = extract?.file ? [text] : [stdout, stderr];
  if (extract?.regex) {
    for (const source of sources) {
      const matches = [...source.matchAll(new RegExp(extract.regex, "gm"))];
      const last = matches.at(-1);
      if (!last) continue;
      const captured = (last[1] ?? last[0]).trim();
      const n = Number(captured);
      if (Number.isFinite(n)) return n;
      const inner = lastNumber(captured);
      if (inner !== null) return inner;
      throw new Error(`regex matched '${captured.slice(0, 80)}', which contains no number`);
    }
    throw new Error(`regex /${extract.regex}/ did not match the output`);
  }
  for (const source of sources) {
    const n = lastNumber(source);
    if (n !== null) return n;
  }
  throw new Error("output contains no number");
}

export function aggregateValues(values: number[], how: MetricAggregate): number {
  if (!values.length) throw new Error("No samples to aggregate.");
  const sorted = [...values].sort((a, b) => a - b);
  switch (how) {
    case "min": return sorted[0]!;
    case "max": return sorted[sorted.length - 1]!;
    case "mean": return values.reduce((s, v) => s + v, 0) / values.length;
    case "median": {
      const mid = Math.floor(sorted.length / 2);
      return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
    }
  }
}
export function meetsThreshold(metric: Pick<MetricSpec, "goal" | "threshold">, value: number): boolean {
  return metric.goal === "maximize" ? value >= metric.threshold : value <= metric.threshold;
}
/** Positive when `to` is better than `from` in the metric's goal direction. */
export function improvement(metric: Pick<MetricSpec, "goal">, from: number, to: number): number {
  return metric.goal === "maximize" ? to - from : from - to;
}
export function formatNumber(v: number): string {
  return Number.isInteger(v) ? String(v) : String(Number(v.toPrecision(6)));
}
export function describeTarget(metric: Pick<MetricSpec, "goal" | "threshold" | "runs" | "aggregate" | "minDelta" | "name">): string {
  const sampling = metric.runs > 1 ? `, ${metric.aggregate} of ${metric.runs} runs` : "";
  const delta = metric.minDelta > 0 ? `, meaningful change ${formatNumber(metric.minDelta)}` : "";
  return `${metric.name} ${metric.goal === "maximize" ? ">=" : "<="} ${formatNumber(metric.threshold)}${sampling}${delta}`;
}

/** Run the metric `runs` times in cwd and aggregate. Any failed sample fails the measurement. */
export async function measureMetric(
  metric: MetricSpec, cwd: string, logDir: string, env: Record<string, string> = {}, signal?: AbortSignal,
): Promise<MetricMeasurement> {
  validateMetric(metric);
  const samples: (number | null)[] = []; const logs: string[] = []; const problems: string[] = [];
  for (let i = 1; i <= metric.runs; i++) {
    if (signal?.aborted) { samples.push(null); problems.push(`run ${i}: cancelled`); break; }
    const log = path.join(logDir, metric.runs > 1 ? `${metric.name}.run-${i}.log` : `${metric.name}.log`);
    const run = await runCommandCheck(metric, cwd, log, signal, env);
    logs.push(log);
    if (abnormalExit(run.exit) || (metric.requireSuccess && !run.result.passed)) {
      samples.push(null); problems.push(`run ${i}: ${run.exit}`);
      fs.appendFileSync(log, `\nmetric_error: ${run.exit}\n`);
      continue;
    }
    try {
      const value = extractValue(run, metric.extract, cwd);
      samples.push(value);
      fs.appendFileSync(log, `\nmetric_value: ${value}\n`);
    } catch (exc) {
      const message = exc instanceof Error ? exc.message : String(exc);
      samples.push(null); problems.push(`run ${i}: ${message}`);
      fs.appendFileSync(log, `\nmetric_error: ${message}\n`);
    }
  }
  const ok = samples.filter((s): s is number => s !== null);
  if (problems.length || ok.length !== metric.runs) {
    return { name: metric.name, value: null, samples, spread: null, passed: false, logs,
      findings: [`${metric.name}: could not be measured — ${problems.join("; ")} (log: ${logs[0] ?? logDir})`] };
  }
  const value = aggregateValues(ok, metric.aggregate);
  const spread = Math.max(...ok) - Math.min(...ok);
  const passed = meetsThreshold(metric, value);
  const sampling = metric.runs > 1 ? ` (${metric.aggregate} of ${metric.runs}: ${ok.map(formatNumber).join(", ")})` : "";
  return { name: metric.name, value, samples, spread, passed, logs,
    findings: passed ? [] : [`${metric.name}: ${formatNumber(value)}${sampling} does not meet ${metric.goal === "maximize" ? ">=" : "<="} ${formatNumber(metric.threshold)} (log: ${logs[0]})`] };
}
