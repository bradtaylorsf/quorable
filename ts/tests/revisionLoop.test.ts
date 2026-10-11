import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { describeStopRules, runRevisionLoop, type RevisionLoopArgs } from "../src/engine/revisionLoop.js";
import { evaluateReadiness, locateQuote, parseDecision, ReviewDecisionSchema, registerFindings, applyVerification,
  sha256, recheckRevisionRun, type TrackedFinding, type SourceVersion } from "../src/engine/readiness.js";
import type { AgentRunner, AgentResponse } from "../src/engine/agentHarness.js";
import { wordCountGate } from "../src/engine/gates.js";
import { treeHash } from "../src/engine/tree.js";
import type { MetricSpec } from "../src/engine/metrics.js";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const dirs: string[] = [];
function temp(): string { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "quorable-loop-"))); dirs.push(d); return d; }
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function response(markdown: string): AgentResponse { return { markdown, status: "completed", error: null, elapsedMs: 1 }; }
function record(value: unknown): string { return `---\n${stringify(value)}---\n\n## Assessment\nSources inspected and acceptance checks evaluated.\n`; }
function primary(prompt: string): string {
  const match = /(?:Primary document: |Primary: )([^\n]+)/.exec(prompt);
  if (!match) throw new Error("No primary in assignment");
  return match[1]!.startsWith('"') ? JSON.parse(match[1]!) : match[1]!;
}
const finding = (file: string) => ({ id: "F1", severity: "blocking" as const, kind: "defect" as const,
  claim: "Rollout is unsafe", acceptance_check: "Replace unsafe rollout with a staged rollout and owner",
  evidence: [{ path: file, quote: fs.readFileSync(file, "utf8").trim() }] });
function fakeRunner(): AgentRunner {
  return async (req) => {
    const file = primary(req.prompt); const bad = fs.readFileSync(file, "utf8").includes("unsafe");
    if (req.prompt.includes("Independently verify every registered finding")) {
      const registry = parse(req.prompt.split("Registry:\n")[1]!.split("\n\nStart with YAML")[0]!);
      return response(record({ resolutions: registry.map((r: { id: string }) => ({
        id: r.id, disposition: bad ? "open" : "resolved", rationale: "Checked the candidate against its acceptance condition.",
        evidence: [{ path: file, quote: fs.readFileSync(file, "utf8").trim() }],
      })) }));
    }
    if (req.prompt.includes("You are the revision author")) {
      // A normal coding session: edit the candidate in place, reply with a summary.
      expect(req.policy).toBe("write"); expect(fs.realpathSync(req.cwd)).toBe(path.dirname(file));
      fs.writeFileSync(file, "# Rollout\n\nOwner Luis will execute a staged rollout.\n");
      return response("Rewrote the rollout section with a staged plan and a named owner.");
    }
    if (req.prompt.includes("Investigate as the ") || req.prompt.includes("Act as a final evaluator")) {
      return response(record({ findings: bad ? [finding(file)] : [], recommendation: bad ? "revise" : "ready" }));
    }
    return response("# Synthesis\nResolve each recorded blocker before readiness.");
  };
}
function setup(): RevisionLoopArgs {
  const dir = temp(); const file = path.join(dir, "draft.md"); fs.writeFileSync(file, "# Rollout\n\nAn unsafe rollout.\n");
  const ref = path.join(dir, "reference.md"); fs.writeFileSync(ref, "Owner Luis requires a staged rollout.");
  return { target: file, workspace: dir, contextPaths: [ref], outDir: path.join(dir, "run"),
    criteria: "Staged rollout with an accountable owner", personas: { expert: "Inspect references" },
    reviewers: [{ harness: "codex" }, { harness: "claude" }], synthesizers: [{ harness: "claude" }],
    reviser: { harness: "codex" }, verifier: { harness: "claude" }, evaluator: { harness: "claude" },
    gates: [wordCountGate(250)], maxConcurrency: 2, timeoutMs: 1000, runner: fakeRunner() };
}

describe("bounded revision loop", () => {
  it("reviews, revises, independently verifies, re-reviews and evaluates readiness on the exact version", async () => {
    const args = setup(); const original = fs.readFileSync(args.target, "utf8");
    const result = await runRevisionLoop(args);
    expect(result.status).toBe("ready"); expect(result.revisions).toBe(1);
    expect(fs.readFileSync(args.target, "utf8")).toBe(original);
    const manifest = parse(fs.readFileSync(path.join(args.outDir, "run.yaml"), "utf8"));
    expect(manifest.candidate.sha256).toBe(sha256(result.candidate));
    expect(manifest.final_evaluation.candidate_sha256).toBe(manifest.candidate.sha256);
    expect(manifest.evaluation_uses).toBe(1);
    expect(recheckRevisionRun(args.outDir).ready).toBe(true);
    const registry = parse(fs.readFileSync(path.join(args.outDir, "findings.yaml"), "utf8")).findings;
    expect(registry).toHaveLength(1); expect(registry[0].origins).toHaveLength(2);
    expect(registry[0].history.map((h: { disposition: string }) => h.disposition)).toEqual(["open", "resolved"]);
    expect(registry[0].history[1].verifier).toMatch(/^job-/);
    expect(manifest.jobs.find((j: { id: string }) => j.id === registry[0].history[1].verifier).agent.harness).toBe("claude");
  });
  it("does not expose panel artifacts to the final evaluator", async () => {
    const args = setup(); const fake = args.runner!; let final = "";
    args.runner = async (req) => { if (req.prompt.includes("Act as a final evaluator")) final = req.prompt; return fake(req); };
    expect((await runRevisionLoop(args)).status).toBe("ready");
    expect(final).not.toContain("Registry:"); expect(final).not.toContain("round-0");
  });
  it("fails closed for a missing council seat", async () => {
    const args = setup(); const fake = args.runner!;
    let synthesized = false;
    args.runner = async (req) => req.prompt.includes("Investigate as") && req.agent.harness === "claude"
      ? { ...response("Organization disabled access"), status: "failed", error: "Organization disabled access" }
      : (synthesized ||= req.prompt.includes("Assigned reviewer reports:"), fake(req));
    const result = await runRevisionLoop(args); expect(result.status).toBe("failed"); expect(result.revisions).toBe(0);
    expect(synthesized).toBe(false);
  });
  it("enforces job budget even during a council fan-out", async () => {
    const args = setup(); args.limits = { maxJobs: 1 };
    const result = await runRevisionLoop(args); expect(result.status).toBe("exhausted"); expect(result.jobs).toBe(1);
  });
  it("enforces revision count", async () => {
    const args = setup(); args.limits = { maxRevisions: 0 };
    const result = await runRevisionLoop(args); expect(result.status).toBe("exhausted"); expect(result.revisions).toBe(0);
  });
  it("stops repeated candidates instead of spinning", async () => {
    const args = setup(); const fake = args.runner!;
    args.runner = async (req) => req.prompt.includes("You are the revision author") ? response("Looked, changed nothing.") : fake(req);
    const result = await runRevisionLoop(args); expect(result.status).toBe("stalled"); expect(result.reasons[0]).toMatch(/changed nothing/);
  });
  it("stops changing prose that does not resolve blockers", async () => {
    const args = setup(); const fake = args.runner!; let n = 0;
    args.runner = async (req) => {
      if (!req.prompt.includes("You are the revision author")) return fake(req);
      fs.writeFileSync(primary(req.prompt), `# Rollout\n\nAn unsafe rollout. Revision ${++n}.\n`); return response("Edited.");
    };
    const result = await runRevisionLoop(args); expect(result.status).toBe("stalled"); expect(result.revisions).toBe(2);
  });
  it("rejects evidence outside the frozen set", async () => {
    const args = setup(); const fake = args.runner!;
    args.runner = async (req) => req.prompt.includes("Investigate as") ? response(record({ findings: [finding(args.target)], recommendation: "revise" })) : fake(req);
    expect((await runRevisionLoop(args)).status).toBe("failed");
  });
  it("rejects quotes that do not occur in the cited file", async () => {
    const args = setup(); const fake = args.runner!;
    args.runner = async (req) => req.prompt.includes("Investigate as") ? response(record({ findings: [{ ...finding(primary(req.prompt)), evidence: [{ path: primary(req.prompt), quote: "An invented source quotation" }] }], recommendation: "revise" })) : fake(req);
    expect((await runRevisionLoop(args)).status).toBe("failed");
  });
  it("detects changed reference originals even though snapshots are stable", async () => {
    const args = setup(); const fake = args.runner!;
    args.runner = async (req) => { fs.writeFileSync(args.contextPaths[0]!, "Changed evidence"); return fake(req); };
    expect((await runRevisionLoop(args)).status).toBe("failed");
  });
  it("stops for author decisions", async () => {
    const args = setup(); const fake = args.runner!;
    args.runner = async (req) => req.prompt.includes("Investigate as") ? response(record({ findings: [{ ...finding(primary(req.prompt)), kind: "decision" }], recommendation: "needs_user_input" })) : fake(req);
    const result = await runRevisionLoop(args); expect(result.status).toBe("needs_user_input"); expect(result.revisions).toBe(0);
  });
  it("bounds follow-up investigations for missing evidence", async () => {
    const args = setup(); args.limits = { maxInvestigations: 1 }; const fake = args.runner!;
    args.runner = async (req) => req.prompt.includes("Investigate as") ? response(record({ findings: [{ ...finding(primary(req.prompt)), kind: "evidence" }], recommendation: "needs_evidence" })) : fake(req);
    const result = await runRevisionLoop(args); expect(result.status).toBe("needs_evidence");
    expect(parse(fs.readFileSync(path.join(args.outDir, "run.yaml"), "utf8")).investigations).toBe(1);
  });
  it("requires full verifier coverage", async () => {
    const args = setup(); const fake = args.runner!;
    args.runner = async (req) => req.prompt.includes("Independently verify") ? response(record({ resolutions: [] })) : fake(req);
    expect((await runRevisionLoop(args)).status).toBe("failed");
  });
  it("requires a final evaluation even with no open findings", async () => {
    const args = setup(); const fake = args.runner!;
    args.runner = async (req) => req.prompt.includes("Act as a final evaluator")
      ? { ...response(""), status: "failed", error: "Evaluator offline" } : fake(req);
    expect((await runRevisionLoop(args)).status).toBe("failed");
    expect(recheckRevisionRun(args.outDir).ready).toBe(false);
  });
  it("fails mechanical checks independently of the agents' recommendations", async () => {
    const args = setup(); args.gates = [wordCountGate(1)]; args.limits = { maxRevisions: 1 };
    expect((await runRevisionLoop(args)).status).toBe("exhausted");
  });
  it("rejects changed reports and registry after a ready run", async () => {
    const args = setup(); expect((await runRevisionLoop(args)).status).toBe("ready");
    const file = path.join(args.outDir, "agents", "job-001.md"); fs.appendFileSync(file, "Changed");
    expect(recheckRevisionRun(args.outDir).ready).toBe(false);
    fs.appendFileSync(path.join(args.outDir, "findings.yaml"), "\n# changed");
    expect(recheckRevisionRun(args.outDir).reasons.join(" ")).toContain("Finding registry changed");
  });
  it("supports separate verifier sessions on the same harness", async () => {
    const args = setup(); args.verifier = { harness: "codex" };
    expect((await runRevisionLoop(args)).status).toBe("ready");
  });
  it("stops after one schema repair, preserving raw prose", async () => {
    const args = setup(); args.runner = async () => response("Just prose, no decision record.");
    const result = await runRevisionLoop(args); expect(result.status).toBe("failed");
    const files = fs.readdirSync(path.join(args.outDir, "agents")).filter((f) => /^job-\d+.md$/.test(f));
    expect(files.length).toBeGreaterThanOrEqual(4);
    expect(fs.readFileSync(path.join(args.outDir, "agents", files[0]!), "utf8")).toContain("Just prose");
  });
  it("enforces the total deadline", async () => {
    const args = setup(); args.limits = { maxElapsedMs: 25 };
    args.runner = async () => { await new Promise((r) => setTimeout(r, 40)); return response("Late"); };
    expect((await runRevisionLoop(args)).status).toBe("exhausted");
  });
  it("cancels before spending on a pre-cancelled run", async () => {
    const args = setup(); const controller = new AbortController(); controller.abort(); args.signal = controller.signal;
    const result = await runRevisionLoop(args); expect(result.status).toBe("cancelled"); expect(result.jobs).toBe(0);
  });
  it("rejects invalid limits before creating output", async () => {
    const args = setup(); args.limits = { maxJobs: 0 };
    await expect(runRevisionLoop(args)).rejects.toThrow(/Invalid loop limit/);
    expect(fs.existsSync(args.outDir)).toBe(false);
  });
});

describe("directory candidates (repositories and other artifacts)", () => {
  const node = process.execPath;
  function repo(): { dir: string; app: string } {
    const dir = temp(); fs.mkdirSync(path.join(dir, "src")); fs.mkdirSync(path.join(dir, "node_modules"));
    fs.writeFileSync(path.join(dir, "node_modules", "junk.js"), "junk");
    const app = path.join(dir, "src", "app.js"); fs.writeFileSync(app, "module.exports = { ok: false }; // unsafe default\n");
    fs.writeFileSync(path.join(dir, "README.md"), "# App\n\nSafe by default.\n");
    return { dir, app };
  }
  /** Locate the candidate copy from either brief: the loop's own, or the investigation's workspace. */
  function candidateOf(prompt: string): string {
    const own = /Candidate directory: ([^\n]+)/.exec(prompt); if (own) return own[1]!;
    const ws = /Workspace: ("[^"]+")/.exec(prompt); if (ws) return path.join(JSON.parse(ws[1]!), "candidate");
    throw new Error("No candidate in prompt");
  }
  const seen: { reviewerPrompts: string[]; reviserRequests: { cwd: string; policy?: string; readDirs?: string[] }[] } = { reviewerPrompts: [], reviserRequests: [] };
  function repoRunner(): AgentRunner {
    return async (req) => {
      const app = path.join(candidateOf(req.prompt), "src", "app.js");
      const bad = fs.readFileSync(app, "utf8").includes("ok: false");
      if (req.prompt.includes("Independently verify every registered finding")) {
        const registry = parse(req.prompt.split("Registry:\n")[1]!.split("\n\nStart with YAML")[0]!);
        return response(record({ resolutions: registry.map((r: { id: string }) => ({ id: r.id, disposition: bad ? "open" : "resolved",
          rationale: "Loaded the module and inspected the exported default.", evidence: [{ path: app, quote: bad ? "ok: false" : "ok: true" }] })) }));
      }
      if (req.prompt.includes("You are the revision author")) {
        seen.reviserRequests.push({ cwd: req.cwd, policy: req.policy, readDirs: req.readDirs });
        fs.writeFileSync(path.join(req.cwd, "src", "app.js"), "module.exports = { ok: true }; // safe default\n");
        return response("Flipped the default in src/app.js to safe; the safety check now passes.");
      }
      if (req.prompt.includes("Investigate as the ")) seen.reviewerPrompts.push(req.prompt);
      if (req.prompt.includes("Investigate as the ") || req.prompt.includes("Act as a final evaluator")) {
        return response(record({ findings: bad ? [{ id: "F1", severity: "blocking", kind: "defect", claim: "The module is unsafe by default",
          acceptance_check: "src/app.js exports ok: true and the safety check passes", evidence: [{ path: app, quote: "ok: false" }] }] : [],
          recommendation: bad ? "revise" : "ready" }));
      }
      return response("# Synthesis\nOne blocker: unsafe default.");
    };
  }
  function repoArgs(): RevisionLoopArgs & { dir: string; app: string } {
    const { dir, app } = repo(); seen.reviewerPrompts = []; seen.reviserRequests = [];
    return { dir, app, target: dir, workspace: dir, contextPaths: [], outDir: path.join(temp(), "run"),
      criteria: "The module must be safe by default and the safety check must pass", personas: { reviewer: "Inspect the code" },
      reviewers: [{ harness: "codex" }], synthesizers: [{ harness: "claude" }],
      reviser: { harness: "codex" }, verifier: { harness: "claude" }, evaluator: { harness: "claude" },
      gates: [], checks: [{ name: "safety", argv: [node, "-e", "process.exit(require('./src/app.js').ok ? 0 : 1)"], timeoutMs: 10_000 }],
      maxConcurrency: 2, timeoutMs: 1000, runner: repoRunner() };
  }
  it("reviews a repository, lets a write session fix it in place, verifies, and never touches the source", async () => {
    const args = repoArgs(); const before = treeHash(args.dir);
    const result = await runRevisionLoop(args);
    expect(result.status).toBe("ready"); expect(result.revisions).toBe(1); expect(result.primary).toBeNull();
    expect(treeHash(args.dir)).toBe(before); expect(fs.readFileSync(args.app, "utf8")).toContain("ok: false");
    expect(fs.existsSync(path.join(result.candidate, "node_modules"))).toBe(false);
    expect(fs.readFileSync(path.join(result.candidate, "src", "app.js"), "utf8")).toContain("ok: true");
    // The reviser was a write session confined to the candidate with read access to evidence.
    expect(seen.reviserRequests).toEqual([{ cwd: result.candidate, policy: "write", readDirs: expect.arrayContaining([path.join(args.outDir, "workspace", "checks")]) }]);
    // Mechanical check logs are frozen evidence and reviewers were told the check failed.
    expect(fs.readFileSync(path.join(args.outDir, "workspace", "checks", "v0", "safety.log"), "utf8")).toContain("result: exit 1");
    expect(fs.readFileSync(path.join(args.outDir, "workspace", "checks", "attempt-1", "safety.log"), "utf8")).toContain("result: exit 0");
    expect(seen.reviewerPrompts[0]).toContain("safety: FAILED"); expect(seen.reviewerPrompts.at(-1)).toContain("safety: passed");
    expect(seen.reviewerPrompts.at(-1)).toContain("attempt-1.patch");
    const patch = fs.readFileSync(path.join(args.outDir, "workspace", "revisions", "attempt-1.patch"), "utf8");
    expect(patch).toContain("-module.exports = { ok: false"); expect(patch).toContain("+module.exports = { ok: true");
    const manifest = parse(fs.readFileSync(path.join(args.outDir, "run.yaml"), "utf8"));
    expect(manifest.format).toBe("quorable-loop-v2"); expect(manifest.target_kind).toBe("directory");
    expect(manifest.candidate.sha256).toBe(sha256(result.candidate)); expect(manifest.versions).toHaveLength(2);
    expect(manifest.candidate.commit).toMatch(/^[a-f0-9]{40}$/);
    expect(manifest.gate_history.map((g: { results: Record<string, { passed: boolean }> }) => g.results["safety"]!.passed)).toEqual([false, true]);
    expect(execFileSync("git", ["log", "--oneline"], { cwd: result.candidate, encoding: "utf8" }).trim().split("\n")).toHaveLength(2);
    expect(recheckRevisionRun(args.outDir).ready).toBe(true);
  });
  it("stalls when the write session changes nothing", async () => {
    const args = repoArgs(); const fake = args.runner!;
    args.runner = async (req) => req.prompt.includes("You are the revision author") ? response("Nothing to do.") : fake(req);
    const result = await runRevisionLoop(args); expect(result.status).toBe("stalled"); expect(result.reasons[0]).toMatch(/changed nothing/);
  });
  it("fails closed when the candidate is edited but the check still fails and findings stay open", async () => {
    const args = repoArgs(); const fake = args.runner!; args.limits = { maxRevisions: 1 };
    args.runner = async (req) => {
      if (!req.prompt.includes("You are the revision author")) return fake(req);
      fs.writeFileSync(path.join(req.cwd, "src", "app.js"), "module.exports = { ok: false }; // still unsafe, reworded\n"); return response("Tidied comments.");
    };
    const result = await runRevisionLoop(args); expect(result.status).toBe("exhausted"); expect(recheckRevisionRun(args.outDir).ready).toBe(false);
  });
  it("runs setup once in the copy and applies text gates to a declared primary", async () => {
    const args = repoArgs(); args.primary = "README.md"; args.gates = [wordCountGate(250)];
    args.setup = [{ name: "prep", argv: [node, "-e", "require('fs').writeFileSync('generated.txt', 'g')"], timeoutMs: 5000 }];
    const result = await runRevisionLoop(args);
    expect(result.status).toBe("ready"); expect(result.primary).toBe(path.join(result.candidate, "README.md"));
    expect(fs.existsSync(path.join(result.candidate, "generated.txt"))).toBe(true);
    expect(fs.existsSync(path.join(args.dir, "generated.txt"))).toBe(false);
    expect(fs.readFileSync(path.join(args.outDir, "workspace", "checks", "setup", "prep.log"), "utf8")).toContain("exit 0");
    const manifest = parse(fs.readFileSync(path.join(args.outDir, "run.yaml"), "utf8"));
    expect(Object.keys(manifest.gate_history[0].results).sort()).toEqual(["safety", "word_count"]);
  });
  it("stops with a failed status when setup fails", async () => {
    const args = repoArgs(); args.setup = [{ name: "deps", argv: [node, "-e", "console.error('registry unreachable'); process.exit(7)"], timeoutMs: 5000 }];
    const result = await runRevisionLoop(args); expect(result.status).toBe("failed"); expect(result.reasons[0]).toMatch(/Setup failed: deps/); expect(result.jobs).toBe(0);
  });
  it("refuses text gates on a directory without a primary, before creating output", async () => {
    const args = repoArgs(); args.gates = [wordCountGate(10)];
    await expect(runRevisionLoop(args)).rejects.toThrow(/primary/); expect(fs.existsSync(args.outDir)).toBe(false);
  });
  it.skipIf(process.platform === "win32")("accepts agent evidence given as resolved paths when the run was addressed through a symlink", async () => {
    // macOS: /tmp → /private/tmp. Agents cite realpaths; the controller must compare resolved paths everywhere.
    const real = temp(); const link = path.join(temp(), "link"); fs.symlinkSync(real, link);
    const args = repoArgs(); const viaLink = (p: string): string => path.join(link, path.relative(path.dirname(args.dir), p));
    fs.cpSync(args.dir, path.join(real, path.basename(args.dir)), { recursive: true });
    args.target = viaLink(args.dir); args.workspace = args.target; args.outDir = path.join(link, "run"); args.dir = path.join(real, path.basename(args.dir));
    expect(fs.realpathSync(args.target)).toBe(args.dir); expect(args.target).not.toBe(args.dir);
    const fake = args.runner!;
    args.runner = async (req) => {
      // Evidence paths arrive fully resolved, as a real harness reports them.
      const resolved = (file: string): string => fs.realpathSync(file);
      const original = fake; const res = await original({ ...req, prompt: req.prompt.replace(/Candidate directory: ([^\n]+)/, (_m, d: string) => `Candidate directory: ${resolved(d)}`) });
      return res;
    };
    const result = await runRevisionLoop(args);
    expect(result.status).toBe("ready"); expect(result.candidate).toBe(fs.realpathSync(result.candidate));
    expect(recheckRevisionRun(args.outDir).ready).toBe(true);
  });
  it("refuses output inside the target", async () => {
    const args = repoArgs(); args.outDir = path.join(args.dir, "run");
    await expect(runRevisionLoop(args)).rejects.toThrow(/outside the target/);
  });
});

describe("metric gates and stop policies", () => {
  const node = process.execPath;
  const readScore = "process.stdout.write('score: ' + require('fs').readFileSync('score.txt','utf8').trim() + '\\n')";
  function scoreRepo(start: number, extra: Record<string, string> = {}): string {
    const dir = temp();
    fs.writeFileSync(path.join(dir, "score.txt"), `${start}\n`);
    fs.writeFileSync(path.join(dir, "README.md"), "# Score\n\nThe score must reach the target.\n");
    for (const [rel, content] of Object.entries(extra)) { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), content); }
    return dir;
  }
  const scoreMetric = (over: Partial<MetricSpec> = {}): MetricSpec => ({ name: "score", argv: [node, "-e", readScore], timeoutMs: 10_000,
    goal: "maximize", threshold: 80, runs: 1, aggregate: "median", minDelta: 1, ...over });
  function candidateOf(prompt: string): string {
    const own = /Candidate directory: ([^\n]+)/.exec(prompt); if (own) return own[1]!;
    const ws = /Workspace: ("[^"]+")/.exec(prompt); if (ws) return path.join(JSON.parse(ws[1]!), "candidate");
    throw new Error("No candidate in prompt");
  }
  interface Seen { reviser: string[]; reviewers: string[]; evaluator: string[] }
  /** Reviewers file no findings; the metric alone drives revision. `edit` returns the next score, or null to edit nothing. */
  function metricRunner(seen: Seen, edit: (attempt: number, score: number, dir: string) => number | null): AgentRunner {
    let attempt = 0;
    return async (req) => {
      if (req.prompt.includes("You are the revision author")) {
        seen.reviser.push(req.prompt); attempt++;
        const file = path.join(req.cwd, "score.txt"); const score = Number(fs.readFileSync(file, "utf8"));
        const next = edit(attempt, score, req.cwd);
        if (next !== null) fs.writeFileSync(file, `${next}\n`);
        return response(next === null ? "I cannot raise the score further without changing the requirements." : `Set the score to ${next}.`);
      }
      if (req.prompt.includes("Act as a final evaluator")) { seen.evaluator.push(req.prompt); return response(record({ findings: [], recommendation: "ready" })); }
      if (req.prompt.includes("Investigate as the ")) {
        seen.reviewers.push(req.prompt);
        return response(record({ findings: [], recommendation: req.prompt.includes("NOT MET") ? "revise" : "ready" }));
      }
      return response("# Synthesis\nThe metric decides.");
    };
  }
  function metricArgs(dir: string, runner: AgentRunner, over: Partial<RevisionLoopArgs> = {}): RevisionLoopArgs {
    return { target: dir, workspace: dir, contextPaths: [], outDir: path.join(temp(), "run"),
      criteria: "Raise the score to the target", personas: { reviewer: "Check the score" },
      reviewers: [{ harness: "codex" }], synthesizers: [{ harness: "claude" }],
      reviser: { harness: "codex" }, verifier: { harness: "claude" }, evaluator: { harness: "claude" },
      gates: [], metrics: [scoreMetric()], maxConcurrency: 1, timeoutMs: 1000, runner,
      limits: { maxRevisions: 5 }, ...over };
  }
  const manifestOf = (outDir: string) => parse(fs.readFileSync(path.join(outDir, "run.yaml"), "utf8"));

  it("loops until the metric meets its threshold, and tells every agent the target and the stop rules", async () => {
    const seen: Seen = { reviser: [], reviewers: [], evaluator: [] };
    const args = metricArgs(scoreRepo(20), metricRunner(seen, (_n, s) => s + 30));
    const result = await runRevisionLoop(args);
    expect(result.status).toBe("ready"); expect(result.revisions).toBe(2); expect(result.attempts).toBe(2);
    expect(result.metrics).toEqual({ score: { value: 80, passed: true } });
    const manifest = manifestOf(args.outDir);
    expect(manifest.metric_history.map((v: { metrics: { score: { value: number } } }) => v.metrics.score.value)).toEqual([20, 50, 80]);
    expect(manifest.gate_history.map((g: { results: { score: { passed: boolean } } }) => g.results.score.passed)).toEqual([false, false, true]);
    expect(manifest.progress).toEqual([{ version: 1, signals: ["score improved 20 → 50"] }, { version: 2, signals: ["score improved 50 → 80"] }]);
    expect(seen.reviser[0]).toContain("READY when"); expect(seen.reviser[0]).toContain("score >= 80");
    expect(seen.reviser[0]).toContain("score = 20"); expect(seen.reviser[0]).toContain("NOT MET");
    expect(seen.reviser[0]).toContain("This is revision attempt 1 of at most 5."); expect(seen.reviser[0]).toMatch(/Budget left after this attempt: 4 revision attempt\(s\)/); expect(seen.reviser[1]).toContain("history v0 20 → v1 50");
    expect(seen.reviewers[0]).toContain("STALLED after 2"); expect(seen.evaluator[0]).toContain("score = 80");
    expect(fs.readFileSync(result.report, "utf8")).toContain("## Metrics");
    expect(recheckRevisionRun(args.outDir).ready).toBe(true);
  });
  it("stops as stalled when the last attempts improve by less than min_delta", async () => {
    const seen: Seen = { reviser: [], reviewers: [], evaluator: [] };
    const args = metricArgs(scoreRepo(20), metricRunner(seen, (_n, s) => Math.round((s + 0.4) * 10) / 10), { limits: { maxRevisions: 10, stagnationCycles: 2 } });
    const result = await runRevisionLoop(args);
    expect(result.status).toBe("stalled"); expect(result.revisions).toBe(2);
    expect(result.reasons[0]).toContain("No meaningful progress in 2 consecutive revision attempt(s)");
    expect(result.reasons[0]).toContain("score: v0 20 → v1 20.4 → v2 20.8 (meaningful change 1, target >= 80)");
    expect(recheckRevisionRun(args.outDir).ready).toBe(false);
  });
  it("with plateau_rounds 1, stops the first time an accepted attempt does not improve meaningfully", async () => {
    const seen: Seen = { reviser: [], reviewers: [], evaluator: [] };
    const args = metricArgs(scoreRepo(20), metricRunner(seen, (n, s) => (n === 1 ? 60 : s + 0.5)), { limits: { maxRevisions: 10, stagnationCycles: 1 } });
    const result = await runRevisionLoop(args);
    expect(result.status).toBe("stalled"); expect(result.revisions).toBe(2);
  });
  it("judges a noisy metric on the aggregate of its runs", async () => {
    // Each run prints the next value of a fixed noisy sequence; median of [79, 95, 81] is 81 (passes), min is 79 (fails).
    const counter = path.join(temp(), "counter");
    const noisy = `const fs=require('fs');const c='${counter}';const n=fs.existsSync(c)?Number(fs.readFileSync(c,'utf8')):0;fs.writeFileSync(c,String(n+1));console.log([79,95,81][n%3])`;
    const seen: Seen = { reviser: [], reviewers: [], evaluator: [] };
    const args = metricArgs(scoreRepo(0), metricRunner(seen, () => null), { metrics: [scoreMetric({ argv: [node, "-e", noisy], runs: 3 })] });
    const result = await runRevisionLoop(args);
    expect(result.status).toBe("ready"); expect(result.revisions).toBe(0);
    const manifest = manifestOf(args.outDir);
    expect(manifest.metric_history[0].metrics.score).toMatchObject({ value: 81, samples: [79, 95, 81], spread: 16 });
    for (const i of [1, 2, 3]) expect(fs.existsSync(path.join(args.outDir, "workspace", "checks", "v0", `score.run-${i}.log`))).toBe(true);
    fs.writeFileSync(counter, "0");
    const strict = metricArgs(scoreRepo(0), metricRunner(seen, () => null), { metrics: [scoreMetric({ argv: [node, "-e", noisy], runs: 3, aggregate: "min" })], limits: { maxRevisions: 1 } });
    const failed = await runRevisionLoop(strict);
    expect(failed.metrics.score).toEqual({ value: 79, passed: false });
  });
  it("reverts a regressing attempt, tells the reviser why, and keeps the better version", async () => {
    const seen: Seen = { reviser: [], reviewers: [], evaluator: [] };
    const args = metricArgs(scoreRepo(50), metricRunner(seen, (n) => (n === 1 ? 10 : 90)), { onRegression: "revert" });
    const result = await runRevisionLoop(args);
    expect(result.status).toBe("ready"); expect(result.revisions).toBe(1); expect(result.attempts).toBe(2);
    expect(fs.readFileSync(path.join(result.candidate, "score.txt"), "utf8").trim()).toBe("90");
    const manifest = manifestOf(args.outDir);
    expect(manifest.attempts.map((a: { status: string }) => a.status)).toEqual(["rejected", "accepted"]);
    expect(manifest.attempts[0].reasons[0]).toBe("score worsened from its best 50 to 10 (tolerance 1)");
    expect(manifest.metric_history.map((v: { metrics: { score: { value: number } } }) => v.metrics.score.value)).toEqual([50, 90]);
    expect(seen.reviser[1]).toContain("Your previous attempt (attempt 1) was reverted: score worsened");
    expect(seen.reviser[1]).toContain("attempt-1.patch");
    expect(seen.reviewers).toHaveLength(2); // the reverted attempt never reached the council
    const tags = execFileSync("git", ["tag"], { cwd: result.candidate, encoding: "utf8" }).trim();
    expect(tags).toBe("rejected-attempt-1");
    expect(execFileSync("git", ["log", "--oneline"], { cwd: result.candidate, encoding: "utf8" }).trim().split("\n")).toHaveLength(2);
    expect(fs.readFileSync(path.join(args.outDir, "workspace", "revisions", "attempt-1.patch"), "utf8")).toContain("+10");
    expect(recheckRevisionRun(args.outDir).ready).toBe(true);
  });
  it("on_regression stop restores the previous candidate and ends the run", async () => {
    const seen: Seen = { reviser: [], reviewers: [], evaluator: [] };
    const args = metricArgs(scoreRepo(50), metricRunner(seen, () => 10), { onRegression: "stop" });
    const result = await runRevisionLoop(args);
    expect(result.status).toBe("stalled"); expect(result.reasons[0]).toMatch(/regressed .*on_regression is stop/);
    expect(fs.readFileSync(path.join(result.candidate, "score.txt"), "utf8").trim()).toBe("50");
    expect(manifestOf(args.outDir).candidate.sha256).toBe(treeHash(result.candidate));
  });
  it("treats breaking a passing check as a regression even when the metric improves", async () => {
    const seen: Seen = { reviser: [], reviewers: [], evaluator: [] };
    const readme = { name: "readme", argv: [node, "-e", "process.exit(require('fs').readFileSync('README.md','utf8').includes('target') ? 0 : 1)"], timeoutMs: 5000 };
    const args = metricArgs(scoreRepo(50), metricRunner(seen, (n, _s, dir) => { if (n === 1) fs.writeFileSync(path.join(dir, "README.md"), "# Score\n"); return 90; }),
      { onRegression: "revert", checks: [readme] });
    const result = await runRevisionLoop(args);
    expect(result.status).toBe("ready");
    const manifest = manifestOf(args.outDir);
    expect(manifest.attempts[0].status).toBe("rejected"); expect(manifest.attempts[0].reasons[0]).toMatch(/^readme passed before and now fails/);
    expect(fs.readFileSync(path.join(result.candidate, "README.md"), "utf8")).toContain("target");
  });
  it("stalls when every attempt in the plateau window is reverted", async () => {
    const seen: Seen = { reviser: [], reviewers: [], evaluator: [] };
    const args = metricArgs(scoreRepo(50), metricRunner(seen, (n) => 40 - n), { onRegression: "revert", limits: { maxRevisions: 10, stagnationCycles: 2 } });
    const result = await runRevisionLoop(args);
    expect(result.status).toBe("stalled"); expect(result.revisions).toBe(0); expect(result.attempts).toBe(2);
    expect(result.reasons[0]).toContain("attempt 1 reverted"); expect(result.reasons[0]).toContain("attempt 2 reverted");
  });
  it("stalls when a reverted attempt is repeated", async () => {
    const seen: Seen = { reviser: [], reviewers: [], evaluator: [] };
    const args = metricArgs(scoreRepo(50), metricRunner(seen, () => 10), { onRegression: "revert", limits: { maxRevisions: 10, stagnationCycles: 5 } });
    const result = await runRevisionLoop(args);
    expect(result.status).toBe("stalled"); expect(result.reasons[0]).toMatch(/already reverted/);
  });
  it("records the reviser's explanation when it cannot make progress", async () => {
    const seen: Seen = { reviser: [], reviewers: [], evaluator: [] };
    const result = await runRevisionLoop(metricArgs(scoreRepo(20), metricRunner(seen, () => null)));
    expect(result.status).toBe("stalled"); expect(result.reasons[0]).toContain("I cannot raise the score further");
  });
  it("fails the measurement rather than guessing when the metric prints no number", async () => {
    const seen: Seen = { reviser: [], reviewers: [], evaluator: [] };
    const args = metricArgs(scoreRepo(20), metricRunner(seen, () => null), { metrics: [scoreMetric({ argv: [node, "-e", "console.log('no digits here')"] })] });
    const result = await runRevisionLoop(args);
    expect(result.metrics.score).toEqual({ value: null, passed: false });
    expect(manifestOf(args.outDir).gate_history[0].results.score.findings[0]).toMatch(/could not be measured — run 1: output contains no number/);
  });
  it("reverts files that checks write into the candidate, including ones the project's .gitignore hides", async () => {
    const seen: Seen = { reviser: [], reviewers: [], evaluator: [] };
    const dirty = { name: "dirty", argv: [node, "-e", "const fs=require('fs');fs.writeFileSync('junk.txt','x');fs.writeFileSync('out.log','x');fs.appendFileSync('README.md','scribble');fs.mkdirSync('coverage',{recursive:true});fs.writeFileSync('coverage/c.json','{}')"], timeoutMs: 5000 };
    const dir = scoreRepo(85, { ".gitignore": "*.log\n" });
    const args = metricArgs(dir, metricRunner(seen, () => null), { checks: [dirty] });
    const result = await runRevisionLoop(args);
    expect(result.status).toBe("ready");
    expect(fs.existsSync(path.join(result.candidate, "junk.txt"))).toBe(false);
    expect(fs.existsSync(path.join(result.candidate, "out.log"))).toBe(false);
    expect(fs.readFileSync(path.join(result.candidate, "README.md"), "utf8")).not.toContain("scribble");
    expect(fs.existsSync(path.join(result.candidate, "coverage", "c.json"))).toBe(true); // excluded output is left alone
    const sideEffects = manifestOf(args.outDir).measurements[0].side_effects.sort();
    expect(sideEffects).toEqual(["README.md", "junk.txt", "out.log"]);
  });
  it("keeps project-ignored files in the candidate's identity and restores them on revert", async () => {
    const seen: Seen = { reviser: [], reviewers: [], evaluator: [] };
    const dir = scoreRepo(50, { ".gitignore": "config.local\n", "config.local": "keep me\n" });
    const args = metricArgs(dir, metricRunner(seen, (n, _s, cwd) => { if (n === 1) { fs.rmSync(path.join(cwd, "config.local")); return 10; } return 90; }), { onRegression: "revert" });
    const result = await runRevisionLoop(args);
    expect(result.status).toBe("ready");
    expect(fs.readFileSync(path.join(result.candidate, "config.local"), "utf8")).toBe("keep me\n");
    expect(execFileSync("git", ["ls-files"], { cwd: result.candidate, encoding: "utf8" })).toContain("config.local");
  });
  it("derives evidence each round that reviewers can quote and metrics can read", async () => {
    // A stand-in for "render the script and transcribe it": derive uppercases script.txt into the derive dir.
    const derive = { name: "transcript", argv: [node, "-e", "const fs=require('fs');fs.writeFileSync(require('path').join(process.env.QUORABLE_DERIVE_OUT,'transcript.txt'),fs.readFileSync('script.txt','utf8').toUpperCase())"], timeoutMs: 5000 };
    const words = scoreMetric({ name: "words", threshold: 3, minDelta: 0, argv: [node, "-e", "const fs=require('fs');console.log(fs.readFileSync(require('path').join(process.env.QUORABLE_DERIVED_DIR,'transcript','transcript.txt'),'utf8').trim().split(/\\s+/).length)"] });
    const dir = scoreRepo(0, { "script.txt": "hello there\n" });
    const transcripts: string[] = [];
    const runner: AgentRunner = async (req) => {
      const transcript = /([^\s"]+\/derived\/[^\s/"]+\/transcript\/transcript\.txt)/.exec(req.prompt)?.[1];
      if (req.prompt.includes("You are the revision author")) { fs.writeFileSync(path.join(req.cwd, "script.txt"), "hello there friend\n"); return response("Lengthened the script."); }
      if (req.prompt.includes("Independently verify every registered finding")) {
        const registry = parse(req.prompt.split("Registry:\n")[1]!.split("\n\nStart with YAML")[0]!);
        const script = path.join(candidateOf(req.prompt), "script.txt"); const fixed = fs.readFileSync(script, "utf8").includes("friend");
        return response(record({ resolutions: registry.map((r: { id: string }) => ({ id: r.id, disposition: fixed ? "resolved" : "open",
          rationale: fixed ? "The transcript now has three words." : "Still two words.", evidence: [{ path: script, quote: fixed ? "hello there friend" : "hello there" }] })) }));
      }
      if (req.prompt.includes("Investigate as the ")) {
        transcripts.push(transcript!);
        const text = fs.readFileSync(transcript!, "utf8");
        return response(record(text.includes("FRIEND") ? { findings: [], recommendation: "ready" } : { findings: [{ id: "F1", severity: "blocking", kind: "defect",
          claim: "The rendered transcript is too short", acceptance_check: "The transcript has at least three words", evidence: [{ path: transcript!, quote: "HELLO THERE" }] }], recommendation: "revise" }));
      }
      if (req.prompt.includes("Act as a final evaluator")) return response(record({ findings: [], recommendation: "ready" }));
      return response("# Synthesis\nTranscript too short.");
    };
    const args = metricArgs(dir, runner, { metrics: [words], derive: [derive] });
    const result = await runRevisionLoop(args);
    expect(result.status).toBe("ready"); expect(result.metrics.words).toEqual({ value: 3, passed: true });
    expect(transcripts[0]).toContain(path.join("derived", "v0", "transcript")); expect(transcripts[1]).toContain(path.join("derived", "attempt-1", "transcript"));
    expect(fs.readFileSync(path.join(args.outDir, "workspace", "derived", "v0", "transcript", "transcript.txt"), "utf8")).toBe("HELLO THERE\n");
    expect(fs.existsSync(path.join(result.candidate, "transcript.txt"))).toBe(false);
    const registry = parse(fs.readFileSync(path.join(args.outDir, "findings.yaml"), "utf8")).findings;
    expect(registry[0].evidence[0].path).toContain(path.join("derived", "v0", "transcript", "transcript.txt"));
    expect(manifestOf(args.outDir).gate_history[0].results.transcript.passed).toBe(true);
  });
  it("describes its stop rules for humans and agents", async () => {
    const text = describeStopRules({ requiredSeverities: ["blocking", "major"], textGates: [], checks: [{ name: "tests", argv: ["npm", "test"], timeoutMs: 1 }], derive: [],
      metrics: [scoreMetric({ name: "coverage", threshold: 85, runs: 3, minDelta: 0.5 })], limits: { maxRevisions: 5, maxInvestigations: 2, maxJobs: 60, maxElapsedMs: 3_600_000, stagnationCycles: 2 }, onRegression: "revert" });
    expect(text).toContain("checks pass (tests)"); expect(text).toContain("coverage >= 85, median of 3 runs, meaningful change 0.5");
    expect(text).toContain("STALLED after 2 consecutive"); expect(text).toContain("are reverted before review");
    expect(text).toContain("EXHAUSTED after 5 revision attempt(s), 60 agent jobs, or 3600 seconds.");
  });
});

describe("evidence quotes", () => {
  it("matches re-indented or re-wrapped quotes and returns the file's own text", () => {
    const file = 'module.exports = function slugify(text) {\n  return text\n    .replace(/[^a-z0-9\\s-]/g, "")\n    .replace(/[\\s-]+/g, "-");\n};\n';
    const reindented = '.replace(/[^a-z0-9\\s-]/g, "")\n.replace(/[\\s-]+/g, "-")';
    expect(locateQuote(file, reindented)).toBe('.replace(/[^a-z0-9\\s-]/g, "")\n    .replace(/[\\s-]+/g, "-")');
    expect(locateQuote("Accents are stripped,\npunctuation is dropped.", "Accents are stripped, punctuation is dropped.")).toBe("Accents are stripped,\npunctuation is dropped.");
    expect(locateQuote(file, "return text")).toBe("return text");
  });
  it("still rejects anything that is not the file's text", () => {
    const file = "Owner Luis requires a staged rollout.";
    expect(locateQuote(file, "Owner Luis requires a full rollout.")).toBeNull();
    expect(locateQuote(file, "OwnerLuis requires")).toBeNull();
    expect(locateQuote("a b c d e f g h", "  a   b  ")).toBeNull(); // fewer than 8 non-space characters
  });
  it("accepts a final evaluator's re-indented code quote (the live-run failure) and stores it verbatim", async () => {
    const { dir } = (() => { const d = temp(); fs.mkdirSync(path.join(d, "src"));
      fs.writeFileSync(path.join(d, "src", "app.js"), "module.exports = {\n  ok: true,\n  mode: 'safe',\n};\n"); return { dir: d }; })();
    const runner: AgentRunner = async (req) => {
      const app = /Candidate directory: ([^\n]+)/.exec(req.prompt)?.[1] ?? path.join(JSON.parse(/Workspace: ("[^"]+")/.exec(req.prompt)![1]!), "candidate");
      if (req.prompt.includes("Act as a final evaluator")) return response(record({ findings: [{ id: "F1", severity: "minor", kind: "defect",
        claim: "Mode could be documented", acceptance_check: "A comment explains mode", evidence: [{ path: path.join(app, "src", "app.js"), quote: "ok: true,\nmode: 'safe'," }] }], recommendation: "ready" }));
      if (req.prompt.includes("Investigate as the ")) return response(record({ findings: [], recommendation: "ready" }));
      return response("# Synthesis\nNo findings.");
    };
    const outDir = path.join(temp(), "run");
    const result = await runRevisionLoop({ target: dir, workspace: dir, contextPaths: [], outDir, criteria: "Safe by default",
      personas: { reviewer: "Inspect" }, reviewers: [{ harness: "codex" }], synthesizers: [{ harness: "codex" }],
      reviser: { harness: "codex" }, verifier: { harness: "codex" }, evaluator: { harness: "codex" }, gates: [], maxConcurrency: 1, timeoutMs: 1000, runner });
    expect(result.status).toBe("ready");
    const registry = parse(fs.readFileSync(path.join(outDir, "findings.yaml"), "utf8")).findings;
    expect(registry[0].evidence[0].quote).toBe("ok: true,\n  mode: 'safe',");
  });
  it("gives an agent one repair when its evidence does not link, then continues", async () => {
    const args = setup(); const fake = args.runner!; const prompts: string[] = []; let calls = 0;
    args.runner = async (req) => {
      if (!req.prompt.includes("Investigate as") || req.agent.harness !== "codex") return fake(req);
      prompts.push(req.prompt);
      if (++calls === 1) return response(record({ findings: [{ ...finding(primary(req.prompt)), evidence: [{ path: primary(req.prompt), quote: "An invented source quotation" }] }], recommendation: "revise" }));
      return fake(req);
    };
    const result = await runRevisionLoop(args);
    expect(result.status).toBe("ready");
    expect(prompts[1]).toContain("Repair only the decision record"); expect(prompts[1]).toContain("Evidence quote does not occur in");
  });
  it("names the evidence problem when a repair also fails", async () => {
    const args = setup(); const fake = args.runner!;
    args.runner = async (req) => req.prompt.includes("Investigate as") ? response(record({ findings: [{ ...finding(primary(req.prompt)), evidence: [{ path: "/nonexistent/file.md", quote: "Something long enough" }] }], recommendation: "revise" })) : fake(req);
    const result = await runRevisionLoop(args);
    expect(result.status).toBe("failed"); expect(result.reasons[0]).toMatch(/council seat or synthesis failed: Evidence path does not exist: \/nonexistent\/file\.md/);
  });
});

describe("readiness policy", () => {
  it("accepts introductory prose without relaxing decision validation", () => {
    expect(parseDecision(`I have inspected both files.\n\n${record({ findings: [], recommendation: "ready" })}`, ReviewDecisionSchema).recommendation).toBe("ready");
    expect(() => parseDecision(`Intro\n\n${record({ findings: [], recommendation: "unsupported" })}`, ReviewDecisionSchema)).toThrow();
    expect(() => parseDecision(`\`\`\`yaml\n${record({ findings: [], recommendation: "ready" })}\n\`\`\``, ReviewDecisionSchema)).toThrow(/code fence/);
  });
  it("preserves colons in literal evidence quotes and rejects invalid unquoted mappings", () => {
    const report = `Introductory prose.\n\n---\nfindings:\n  - id: F1\n    severity: blocking\n    kind: defect\n    claim: |-\n      Missing owner: Luis Ortega\n    acceptance_check: |-\n      Name the rollback owner.\n    evidence:\n      - path: /reference.md\n        quote: |-\n          Rollback owner: Luis Ortega.\nrecommendation: revise\n---\n\n## Assessment\nVerified the named owner in the reference.`;
    expect(parseDecision(report, ReviewDecisionSchema).findings[0]!.evidence[0]!.quote).toBe("Rollback owner: Luis Ortega.");
    expect(() => parseDecision(report.replace("quote: |-\n          Rollback owner: Luis Ortega.", "quote: Rollback owner: Luis Ortega."), ReviewDecisionSchema)).toThrow(/Nested mappings/);
  });
  it("rejects a verifier claiming to be the revision-author invocation", () => {
    const args = setup();
    expect(() => applyVerification({ registry: [], decision: { resolutions: [] },
      candidate: { path: args.target, sha256: sha256(args.target) }, sources: [], cwd: args.workspace,
      verifier: "job-1", reviser: "job-1", report: "verify.md" })).toThrow(/different agent invocation/);
  });
  it("does not let a changed candidate reuse old resolutions or checks", () => {
    const args = setup(); const candidate: SourceVersion = { path: args.target, sha256: sha256(args.target) };
    const registry: TrackedFinding[] = [];
    registerFindings(registry, { findings: [finding(args.target)], recommendation: "revise" }, "review-1", [candidate], args.workspace);
    applyVerification({ registry, decision: { resolutions: [{ id: registry[0]!.id, disposition: "resolved", rationale: "Verified fix", evidence: finding(args.target).evidence }] },
      candidate, sources: [], cwd: args.workspace, verifier: "claude", reviser: "codex", report: "verify.md" });
    const input = { candidate, sources: [], registry, requiredSeverities: ["blocking" as const], reviewsComplete: true,
      reviewSha256: candidate.sha256, gates: {}, gatesSha256: candidate.sha256,
      finalEvaluation: { passed: true, candidate_sha256: candidate.sha256 } };
    expect(evaluateReadiness(input).ready).toBe(true);
    fs.writeFileSync(args.target, "New document version.");
    expect(evaluateReadiness(input).ready).toBe(false);
    const newInput = { ...input, candidate: { ...candidate, sha256: sha256(args.target) } };
    expect(evaluateReadiness(newInput).reasons).toEqual(expect.arrayContaining([
      "Required reviews did not complete for this candidate.", "Mechanical checks are stale.",
      "F-0001: unresolved or stale blocking finding.", "Final independent evaluation has not passed for this candidate.",
    ]));
  });
  it("rejects malformed/duplicate/unknown frontmatter fields and absent narrative", () => {
    expect(() => parseDecision("---\nfindings: []\nrecommendation: ready\nrecommendation: revise\n---\nBody", ReviewDecisionSchema)).toThrow();
    expect(() => parseDecision(record({ findings: [], recommendation: "ready", ship: true }), ReviewDecisionSchema)).toThrow();
    expect(() => parseDecision("---\nfindings: []\nrecommendation: ready\n---", ReviewDecisionSchema)).toThrow();
  });
});

const cli = fileURLToPath(new URL("../../dist/cli/main.js", import.meta.url));
describe.skipIf(!fs.existsSync(cli))("built revise CLI", () => {
  const run = (argv: string[], cwd: string) => spawnSync(process.execPath, [cli, ...argv], { cwd, encoding: "utf8",
    env: { ...process.env, QUORABLE_HOME: path.join(cwd, ".home") } });
  it("dry-run prints the merged policy and stop rules and starts nothing", () => {
    const dir = temp(); fs.writeFileSync(path.join(dir, "a.js"), "x\n");
    const policy = path.join(temp(), "policy.yaml");
    fs.writeFileSync(policy, "criteria: Make it fast\nchecks: [{name: tests, run: [npm, test]}]\nstop: {max_revisions: 6, on_regression: revert}\n");
    const res = run(["revise", dir, "--council", "code-review", "--policy", policy, "--metric", "p95 <= 120 x5 ~5: node bench.js",
      "--plateau-rounds", "3", "--dry-run"], dir);
    expect(res.status).toBe(0);
    const [config, rules] = res.stdout.split("# Stop rules");
    const parsed = parse(config!);
    expect(parsed.criteria).toBe("Make it fast"); expect(parsed.checks[0]).toMatchObject({ name: "tests", run: ["npm", "test"] });
    expect(parsed.metrics[0]).toMatchObject({ name: "p95", goal: "minimize", threshold: 120, runs: 5, min_delta: 5 });
    expect(parsed.stop).toMatchObject({ max_revisions: 6, on_regression: "revert", plateau_rounds: 3, require: ["blocking", "major"] });
    expect(config).toContain("run: [ npm, test ]");
    expect(rules).toContain("p95 <= 120, median of 5 runs, meaningful change 5"); expect(rules).toContain("STALLED after 3 consecutive");
    expect(fs.readdirSync(path.dirname(dir)).some((f) => f.includes("-revised-"))).toBe(false);
  });
  it("dry-run explains why a real run would be refused", () => {
    const dir = temp(); fs.writeFileSync(path.join(dir, "a.md"), "x\n");
    const res = run(["revise", dir, "--dry-run"], dir);
    expect(res.status).toBe(1);
    expect(res.stdout).toContain("No criteria"); expect(res.stdout).toMatch(/has text gates .* but no primary file/);
  });
  it("rejects a malformed metric flag before doing anything", () => {
    const dir = temp(); fs.writeFileSync(path.join(dir, "a.js"), "x\n");
    const res = run(["revise", dir, "--council", "code-review", "--criteria", "c", "--metric", "coverage 85: npm test", "--dry-run"], dir);
    expect(res.status).not.toBe(0); expect(res.stderr).toMatch(/name >= threshold/);
  });
});
