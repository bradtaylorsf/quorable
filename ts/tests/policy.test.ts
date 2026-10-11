import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_STOP_RULES, loadRevisionPolicy, parseRevisionPolicy, policyToPlain, PolicyError, resolveRevisionPolicy,
} from "../src/config/revisionPolicy.js";
import { buildPackFromRubric, parseRubric } from "../src/pack/rubric.js";

const example = fileURLToPath(new URL("../../docs/examples/revise-policy.yaml", import.meta.url));

describe("revision policy files", () => {
  it("the documented example loads and resolves", () => {
    const policy = resolveRevisionPolicy({ file: loadRevisionPolicy(example) });
    expect(policy.criteria).toMatch(/retry logic/);
    expect(policy.setup.map((s) => s.name)).toEqual(["deps"]);
    expect(policy.checks.map((c) => c.name)).toEqual(["tests", "types"]);
    expect(policy.metrics).toHaveLength(2);
    expect(policy.metrics[0]).toMatchObject({ name: "coverage", goal: "maximize", threshold: 85, runs: 1, minDelta: 0.5,
      extract: { file: "coverage/coverage-summary.json", json: "total.lines.pct" } });
    expect(policy.metrics[1]).toMatchObject({ name: "p95_ms", goal: "minimize", runs: 5, aggregate: "median" });
    expect(policy.derive.map((d) => d.name)).toEqual(["api-surface"]);
    expect(policy.stop).toEqual({ require: ["blocking", "major"], maxRevisions: 5, maxInvestigations: 2, maxJobs: 60,
      maxElapsedSeconds: 3600, plateauRounds: 2, onRegression: "revert" });
    expect(policy.exclude).toEqual(["fixtures-large"]);
  });
  it("an empty policy resolves to the built-in defaults", () => {
    const policy = resolveRevisionPolicy({ file: parseRevisionPolicy("") });
    expect(policy.stop).toEqual(DEFAULT_STOP_RULES); expect(policy.criteria).toBeNull();
    expect(policy.checks).toEqual([]); expect(policy.metrics).toEqual([]);
  });
  it("rejects unknown keys, bad values and invalid regexes with every problem listed", () => {
    expect(() => parseRevisionPolicy("stop:\n  plateau: 2\n")).toThrow(/stop: Unrecognized key/);
    expect(() => parseRevisionPolicy("metrics:\n  - name: c\n    run: [x]\n    goal: up\n    threshold: 1\n")).toThrow(/metrics.0.goal/);
    expect(() => parseRevisionPolicy("metrics:\n  - name: c\n    run: [x]\n    goal: maximize\n    threshold: 1\n    extract: {regex: '('}\n")).toThrow(/invalid extract.regex/);
    expect(() => parseRevisionPolicy("checks:\n  - name: 'has space'\n    run: [x]\n")).toThrow(/checks.0.name/);
    expect(() => parseRevisionPolicy("stop: {on_regression: undo}")).toThrow(/on_regression/);
    expect(() => parseRevisionPolicy("{{{")).toThrow(PolicyError);
  });
  it("CLI flags override scalars and extend lists; names must be unique across checks, metrics and derive", () => {
    const file = parseRevisionPolicy("criteria: from file\nchecks: [{name: tests, run: [npm, test]}]\nstop: {max_revisions: 5, on_regression: revert, plateau_rounds: 3}\n");
    const policy = resolveRevisionPolicy({ file, flags: { criteria: "from flag", check: ["lint=npm run lint"], metric: ["score >= 9 x3: node s.js"],
      maxRevisions: 8, require: ["minor"], checkTimeoutMs: 5000 } });
    expect(policy.criteria).toBe("from flag");
    expect(policy.checks.map((c) => c.name)).toEqual(["tests", "lint"]); expect(policy.checks[1]!.timeoutMs).toBe(5000);
    expect(policy.metrics[0]).toMatchObject({ name: "score", runs: 3 });
    expect(policy.stop).toMatchObject({ maxRevisions: 8, onRegression: "revert", plateauRounds: 3, require: ["blocking", "minor"] });
    expect(() => resolveRevisionPolicy({ file, flags: { metric: ["tests >= 1: node t.js"] } })).toThrow(/'tests' is defined more than once/);
    expect(() => resolveRevisionPolicy({ flags: { require: ["critical"] } })).toThrow(/Unknown severity/);
    expect(() => resolveRevisionPolicy({ flags: { onRegression: "undo" } })).toThrow(/on_regression/);
    expect(() => resolveRevisionPolicy({ flags: { metric: ["bad spec"] } })).toThrow(PolicyError);
  });
  it("rubric checks and metrics come first and merge with the policy", () => {
    const pack = buildPackFromRubric(parseRubric([
      "name: r", "units: [u]", "dimensions: {d: {}}", "verdict: {categories: [ship, revise]}", "ship: {composite_min: 1, dimension_min: 1}",
      "checks: [{name: build, run: [make]}]", "metrics: [{name: size_kb, run: [du, -k, out], goal: minimize, threshold: 500, min_delta: 10}]",
    ].join("\n")));
    expect(pack.mechanicalMetrics).toHaveLength(1);
    const policy = resolveRevisionPolicy({ rubric: { checks: pack.mechanicalChecks, metrics: pack.mechanicalMetrics }, flags: { check: ["tests=npm test"] } });
    expect(policy.checks.map((c) => c.name)).toEqual(["build", "tests"]);
    expect(policy.metrics[0]).toMatchObject({ name: "size_kb", goal: "minimize", minDelta: 10 });
  });
  it("prints back as a plain, re-loadable shape", () => {
    const plain = policyToPlain(resolveRevisionPolicy({ file: loadRevisionPolicy(example) }));
    expect((plain.stop as Record<string, unknown>).on_regression).toBe("revert");
    expect((plain.metrics as Record<string, unknown>[])[1]).toMatchObject({ name: "p95_ms", run: ["node", "bench/retry.js"], runs: 5, min_delta: 5 });
    expect(path.basename(example)).toBe("revise-policy.yaml");
  });
});
