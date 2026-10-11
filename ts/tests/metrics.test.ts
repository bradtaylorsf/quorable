import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  aggregateValues, describeTarget, extractValue, improvement, jsonPath, measureMetric, meetsThreshold, parseMetricFlag, validateMetric,
  type MetricSpec,
} from "../src/engine/metrics.js";

const dirs: string[] = [];
function temp(): string { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "quorable-metrics-"))); dirs.push(d); return d; }
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const node = process.execPath;
const out = (stdout: string, stderr = "") => ({ stdout, stderr });
const base = (over: Partial<MetricSpec> = {}): MetricSpec => ({ name: "m", argv: [node, "-e", "console.log(1)"], timeoutMs: 10_000,
  goal: "maximize", threshold: 1, runs: 1, aggregate: "median", minDelta: 0, ...over });

describe("metric flag syntax", () => {
  it("parses name, direction, threshold, runs and min_delta", () => {
    expect(parseMetricFlag("coverage >= 85 x3 ~0.5: npm run -s coverage", 1000)).toMatchObject({
      name: "coverage", goal: "maximize", threshold: 85, runs: 3, minDelta: 0.5, aggregate: "median", argv: ["npm", "run", "-s", "coverage"] });
    expect(parseMetricFlag("p95_ms<=120:node bench.js --json", 1000)).toMatchObject({ name: "p95_ms", goal: "minimize", threshold: 120, runs: 1, minDelta: 0, argv: ["node", "bench.js", "--json"] });
    expect(parseMetricFlag("loss <= -0.25 ~0.01 x2 : python eval.py", 1000)).toMatchObject({ threshold: -0.25, runs: 2, minDelta: 0.01 });
    expect(parseMetricFlag("t>=1: node -e console.log('a:b')", 1000).argv).toEqual(["node", "-e", "console.log('a:b')"]);
  });
  it("rejects malformed specs with a usable message", () => {
    expect(() => parseMetricFlag("coverage 85: npm test", 1)).toThrow(/name >= threshold/);
    expect(() => parseMetricFlag("coverage > 85: npm test", 1)).toThrow(/name >= threshold/);
    expect(() => parseMetricFlag("coverage >= 85 x0: npm test", 1)).toThrow(/runs must be/);
    expect(() => parseMetricFlag("coverage >= 85:", 1)).toThrow(/name >= threshold/);
  });
  it("validates extraction settings", () => {
    expect(() => validateMetric(base({ extract: { json: "a", regex: "b" } }))).toThrow(/not both/);
    expect(() => validateMetric(base({ extract: { regex: "(" } }))).toThrow(/invalid extract.regex/);
    expect(() => validateMetric(base({ extract: { file: "../outside.json" } }))).toThrow(/inside the candidate/);
    expect(() => validateMetric(base({ extract: { file: "/etc/passwd" } }))).toThrow(/inside the candidate/);
    expect(() => validateMetric(base({ minDelta: -1 }))).toThrow(/min_delta/);
  });
});

describe("value extraction", () => {
  it("defaults to the last number on stdout, ignoring colour codes, then falls back to stderr", () => {
    expect(extractValue(out("ran 12 tests\nscore: \x1b[32m87.5\x1b[0m\n"), undefined, ".")).toBe(87.5);
    expect(extractValue(out("", "warn: 3 issues"), undefined, ".")).toBe(3);
    expect(extractValue(out("1e-3"), undefined, ".")).toBe(0.001);
    expect(() => extractValue(out("nothing", "here"), undefined, ".")).toThrow(/no number/);
  });
  it("takes the last regex match, capture group first", () => {
    expect(extractValue(out("p95=140ms\np95=118.5ms\ndone in 2.1s"), { regex: "p95=([0-9.]+)ms" }, ".")).toBe(118.5);
    expect(extractValue(out("Lines: 91.2% (40/44)"), { regex: "Lines: \\S+" }, ".")).toBe(91.2);
    expect(() => extractValue(out("p95 missing"), { regex: "p95=([0-9.]+)" }, ".")).toThrow(/did not match/);
  });
  it("reads a JSON path from stdout, including a JSON line after log noise", () => {
    expect(extractValue(out('{"total":{"lines":{"pct":88.1}}}'), { json: "total.lines.pct" }, ".")).toBe(88.1);
    expect(extractValue(out('building...\n{"results":[{"score":"0.73"}]}\n'), { json: "results[0].score" }, ".")).toBe(0.73);
    expect(() => extractValue(out('{"a":{}}'), { json: "a.b" }, ".")).toThrow(/has no 'b'/);
    expect(() => extractValue(out('{"a":"high"}'), { json: "a" }, ".")).toThrow(/not a finite number/);
    expect(jsonPath({ a: [{ b: 2 }] }, "a.0.b")).toBe(2);
  });
  it("reads a file the command wrote inside the candidate, and refuses one outside it", () => {
    const dir = temp(); fs.mkdirSync(path.join(dir, "coverage"));
    fs.writeFileSync(path.join(dir, "coverage", "summary.json"), JSON.stringify({ total: { lines: { pct: 92 } } }));
    expect(extractValue(out("ignored 5"), { file: "coverage/summary.json", json: "total.lines.pct" }, dir)).toBe(92);
    fs.writeFileSync(path.join(dir, "score.txt"), "final=7.25\n");
    expect(extractValue(out(""), { file: "score.txt", regex: "final=(\\S+)" }, dir)).toBe(7.25);
    expect(() => extractValue(out(""), { file: "missing.json" }, dir)).toThrow(/not written/);
    const outside = temp(); fs.writeFileSync(path.join(outside, "x.txt"), "9");
    fs.symlinkSync(path.join(outside, "x.txt"), path.join(dir, "link.txt"));
    expect(() => extractValue(out(""), { file: "link.txt" }, dir)).toThrow(/escapes the candidate/);
  });
});

describe("aggregation and direction", () => {
  it("aggregates samples", () => {
    expect(aggregateValues([3, 1, 2], "median")).toBe(2);
    expect(aggregateValues([4, 1, 3, 2], "median")).toBe(2.5);
    expect(aggregateValues([1, 2, 6], "mean")).toBe(3);
    expect(aggregateValues([5, 1, 9], "min")).toBe(1);
    expect(aggregateValues([5, 1, 9], "max")).toBe(9);
  });
  it("compares in the goal direction", () => {
    expect(meetsThreshold({ goal: "maximize", threshold: 80 }, 80)).toBe(true);
    expect(meetsThreshold({ goal: "maximize", threshold: 80 }, 79.9)).toBe(false);
    expect(meetsThreshold({ goal: "minimize", threshold: 120 }, 119)).toBe(true);
    expect(improvement({ goal: "maximize" }, 70, 75)).toBe(5);
    expect(improvement({ goal: "minimize" }, 140, 120)).toBe(20);
    expect(describeTarget(base({ name: "p95", goal: "minimize", threshold: 120, runs: 5, minDelta: 5 }))).toBe("p95 <= 120, median of 5 runs, meaningful change 5");
  });
});

describe("measuring", () => {
  it("runs the command the configured number of times and logs each value", async () => {
    const dir = temp(); const counter = path.join(dir, "n");
    const argv = [node, "-e", `const fs=require('fs');const n=fs.existsSync('${counter}')?Number(fs.readFileSync('${counter}','utf8')):0;fs.writeFileSync('${counter}',String(n+1));console.log('value ' + [10,30,20][n])`];
    const m = await measureMetric(base({ argv, runs: 3, threshold: 15 }), dir, path.join(dir, "logs"));
    expect(m).toMatchObject({ value: 20, samples: [10, 30, 20], spread: 20, passed: true, findings: [] });
    expect(m.logs).toHaveLength(3);
    expect(fs.readFileSync(m.logs[1]!, "utf8")).toContain("metric_value: 30");
  });
  it("reports an unmet threshold with the samples", async () => {
    const dir = temp();
    const m = await measureMetric(base({ argv: [node, "-e", "console.log(4)"], runs: 2, threshold: 5 }), dir, path.join(dir, "logs"));
    expect(m.passed).toBe(false); expect(m.findings[0]).toMatch(/^m: 4 \(median of 2: 4, 4\) does not meet >= 5/);
  });
  it("ignores the exit code by default but honours require_success", async () => {
    const dir = temp(); const argv = [node, "-e", "console.log('passing: 7'); process.exit(1)"];
    expect((await measureMetric(base({ argv, threshold: 5 }), dir, path.join(dir, "a"))).value).toBe(7);
    const strict = await measureMetric(base({ argv, threshold: 5, requireSuccess: true }), dir, path.join(dir, "b"));
    expect(strict.value).toBeNull(); expect(strict.findings[0]).toMatch(/could not be measured — run 1: exit 1/);
  });
  it("fails the measurement on a timeout instead of trusting partial output", async () => {
    const dir = temp();
    const m = await measureMetric(base({ argv: [node, "-e", "console.log(99); setTimeout(()=>{}, 20000)"], timeoutMs: 150 }), dir, path.join(dir, "logs"));
    expect(m.value).toBeNull(); expect(m.findings[0]).toMatch(/timed out/);
  });
  it("passes environment variables to the command", async () => {
    const dir = temp();
    const m = await measureMetric(base({ argv: [node, "-e", "console.log(process.env.QUORABLE_TEST_VALUE)"] }), dir, path.join(dir, "logs"), { QUORABLE_TEST_VALUE: "42" });
    expect(m.value).toBe(42);
  });
});
