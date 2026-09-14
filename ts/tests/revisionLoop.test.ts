import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { runRevisionLoop, type RevisionLoopArgs } from "../src/engine/revisionLoop.js";
import { evaluateReadiness, parseDecision, ReviewDecisionSchema, registerFindings, applyVerification,
  sha256, recheckRevisionRun, type TrackedFinding, type SourceVersion } from "../src/engine/readiness.js";
import type { AgentRunner, AgentResponse } from "../src/engine/agentHarness.js";
import { wordCountGate } from "../src/engine/gates.js";

const dirs: string[] = [];
function temp(): string { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "quorable-loop-"))); dirs.push(d); return d; }
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function response(markdown: string): AgentResponse { return { markdown, status: "completed", error: null, elapsedMs: 1 }; }
function record(value: unknown): string { return `---\n${stringify(value)}---\n\n## Assessment\nSources inspected and acceptance checks evaluated.\n`; }
function primary(prompt: string): string {
  const match = /(?:Primary document: |Candidate: )([^\n]+)/.exec(prompt);
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
    if (req.prompt.includes("Revise the document to satisfy")) return response("# Rollout\n\nOwner Luis will execute a staged rollout.\n");
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
    args.runner = async (req) => req.prompt.includes("Revise the document to satisfy") ? response(fs.readFileSync(primary(req.prompt), "utf8")) : fake(req);
    expect((await runRevisionLoop(args)).status).toBe("stalled");
  });
  it("stops changing prose that does not resolve blockers", async () => {
    const args = setup(); const fake = args.runner!; let n = 0;
    args.runner = async (req) => req.prompt.includes("Revise the document to satisfy") ? response(`# Rollout\n\nAn unsafe rollout. Revision ${++n}.\n`) : fake(req);
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
