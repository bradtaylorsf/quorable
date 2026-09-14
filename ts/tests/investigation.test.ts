import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { harnessCommand, parseAgentSpec, runAgentProcess, type AgentRequest, type AgentResponse } from "../src/engine/agentHarness.js";
import { runInvestigation, type InvestigationArgs } from "../src/engine/investigation.js";

const dirs: string[] = [];
function temp(): string { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "quorable-agents-")); dirs.push(dir); return dir; }
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const ok = (markdown = "## Assessment\nEvidence-backed critique."): AgentResponse => ({ status: "completed", markdown, error: null, elapsedMs: 1 });
const cli = fileURLToPath(new URL("../../dist/cli/main.js", import.meta.url));
const execFileAsync = promisify(execFile);
function setup(): InvestigationArgs {
  const dir = temp();
  const target = path.join(dir, "draft.md"); fs.writeFileSync(target, "The draft.");
  return { target, workspace: dir, contextPaths: [], outDir: path.join(dir, "run"),
    personas: { expert: "Check claims", editor: "Check structure" }, reviewers: [{ harness: "codex" }, { harness: "claude" }],
    synthesizers: [{ harness: "claude" }], criteria: "Ready for publication", maxConcurrency: 2,
    timeoutMs: 1000, runner: async () => ok() };
}

describe("investigative councils", () => {
  it("bounds concurrency and waits for all reviews before synthesis", async () => {
    const args = setup(); let active = 0; let peak = 0; let reviews = 0;
    args.runner = async (request) => {
      active++; peak = Math.max(peak, active);
      expect(request.cwd).toBe(fs.realpathSync(args.workspace));
      expect(request.prompt).toContain(fs.realpathSync(args.target));
      if (request.prompt.includes("Assigned reviewer reports:")) expect(reviews).toBe(4);
      else { expect(request.prompt).not.toContain("Assigned reviewer reports:"); reviews++; }
      await new Promise((r) => setTimeout(r, 10)); active--; return ok();
    };
    const result = await runInvestigation(args);
    expect(peak).toBe(2); expect(result.status).toBe("completed");
    expect(fs.readdirSync(path.join(args.outDir, "reviews"))).toHaveLength(4);
    const meta = parse(fs.readFileSync(path.join(args.outDir, "run.yaml"), "utf8"));
    expect(meta.readiness).toBe("unassessed"); expect(meta.cost_usd).toBeNull();
    expect(meta.jobs).toHaveLength(5);
  });
  it("preserves failed seats and synthesizes partial evidence without successful execution status", async () => {
    const args = setup(); let calls = 0;
    args.runner = async (request) => {
      if (++calls === 1) throw new Error("missing executable");
      if (request.prompt.includes("Assigned reviewer reports:")) {
        expect(request.prompt).toContain("failed; no usable report");
      }
      return ok("Recommendation: ready");
    };
    const result = await runInvestigation(args);
    expect(result.status).toBe("incomplete");
    expect(fs.readFileSync(result.report, "utf8")).toContain("Readiness: **unassessed by code**");
    expect(fs.readdirSync(path.join(args.outDir, "reviews"))).toHaveLength(3);
  });
  it("never synthesizes when every reviewer fails", async () => {
    const args = setup(); let calls = 0;
    args.runner = async () => { calls++; return { ...ok(""), status: "failed", error: "bad" }; };
    const result = await runInvestigation(args);
    expect(calls).toBe(4); expect(result.status).toBe("incomplete");
    expect(fs.readFileSync(result.report, "utf8")).toContain("No successful final synthesis");
  });
  it("marks empty successful reports as failures", async () => {
    const args = setup(); args.runner = async () => ok("  ");
    expect((await runInvestigation(args)).status).toBe("incomplete");
  });
  it("reconciles multiple syntheses with access to original findings", async () => {
    const args = setup(); args.synthesizers.push({ harness: "codex" }); let calls = 0;
    args.runner = async (request) => {
      calls++;
      if (request.prompt.includes("Compare the synthesis reports")) {
        expect(request.prompt).toContain("Original reviewer reports:");
        expect(request.prompt).toContain("synthesis-2");
      }
      return ok();
    };
    expect((await runInvestigation(args)).status).toBe("completed"); expect(calls).toBe(7);
    expect(fs.existsSync(path.join(args.outDir, "synthesis", "final.md"))).toBe(true);
  });
  it("prepares all stages without launching or requiring authentication", async () => {
    const args = setup(); args.dryRun = true;
    args.synthesizers.push({ harness: "codex" });
    args.runner = async () => { throw new Error("must not launch"); };
    expect((await runInvestigation(args)).status).toBe("planned");
    expect(fs.readdirSync(path.join(args.outDir, "prompts"))).toHaveLength(7);
    expect(fs.readdirSync(path.join(args.outDir, "reviews"))).toHaveLength(0);
  });
  it("refuses to overwrite a previous run", async () => {
    const args = setup(); await runInvestigation(args);
    await expect(runInvestigation(args)).rejects.toThrow(/EEXIST/);
  });
  it("detects primary mutation during the council", async () => {
    const args = setup(); args.runner = async () => { fs.writeFileSync(args.target, "changed"); return ok(); };
    const result = await runInvestigation(args);
    expect(result.status).toBe("incomplete"); expect(fs.readFileSync(result.report, "utf8")).toContain("Primary document changed");
  });
  it("validates context before creating a run", async () => {
    const args = setup(); args.contextPaths = [path.join(args.workspace, "missing")];
    await expect(runInvestigation(args)).rejects.toThrow(); expect(fs.existsSync(args.outDir)).toBe(false);
  });
  it("cancels pending jobs without launching them", async () => {
    const args = setup(); const controller = new AbortController(); controller.abort(); args.signal = controller.signal;
    let launched = false; args.runner = async () => { launched = true; return ok(); };
    expect((await runInvestigation(args)).status).toBe("incomplete"); expect(launched).toBe(false);
  });
});

describe("harness subprocess adapters", () => {
  function request(): AgentRequest {
    return { agent: { harness: "codex" }, cwd: temp(), prompt: "literal $(touch nope) `id`\nSecond line", timeoutMs: 3000 };
  }
  it("rejects unknown harnesses and empty model IDs", () => {
    expect(() => parseAgentSpec("openrouter:model")).toThrow();
    expect(() => parseAgentSpec("codex:")).toThrow();
    expect(parseAgentSpec("claude:some-model")).toEqual({ harness: "claude", model: "some-model" });
  });
  it("uses read-only Codex and a limited Claude tool set", () => {
    const codex = harnessCommand({ harness: "codex" });
    expect(codex.args).toContain("read-only"); expect(codex.args).toContain('approval_policy="never"');
    const claude = harnessCommand({ harness: "claude" });
    expect(claude.args).toContain("dontAsk"); expect(claude.args).not.toContain("Bash");
    expect(claude.args).toContain("--strict-mcp-config");
  });
  it("passes literal prompts through stdin and captures final text", async () => {
    const req = request();
    const result = await runAgentProcess(req, { command: process.execPath, args: ["-e", "process.stdin.pipe(process.stdout)"] });
    expect(result.status).toBe("completed"); expect(result.markdown).toBe(req.prompt);
    expect(fs.existsSync(path.join(req.cwd, "nope"))).toBe(false);
  });
  it("records stderr and a nonzero exit even when partial prose exists", async () => {
    let trace = "";
    const result = await runAgentProcess({ ...request(), onTrace: (t) => { trace += t; } }, {
      command: process.execPath, args: ["-e", "console.log('partial'); console.error('failed check'); process.exit(7)"] });
    expect(result.status).toBe("failed"); expect(result.markdown).toBe("partial"); expect(trace).toContain("failed check");
  });
  it("returns a failure row for a missing executable", async () => {
    const result = await runAgentProcess(request(), { command: "/missing-quorable-agent", args: [] });
    expect(result.status).toBe("failed"); expect(result.error).toContain("ENOENT");
  });
  it("surfaces provider access errors written to stdout", async () => {
    const result = await runAgentProcess(request(), { command: process.execPath,
      args: ["-e", "console.log('Organization disabled subscription access'); process.exit(1)"] });
    expect(result.status).toBe("failed");
    expect(result.error).toContain("Organization disabled subscription access");
  });
  it("kills a stalled process on timeout", async () => {
    const result = await runAgentProcess({ ...request(), timeoutMs: 100 }, {
      command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"] });
    expect(result.status).toBe("timed_out");
  });
  it("kills an in-flight process on cancellation", async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 100);
    const result = await runAgentProcess({ ...request(), signal: controller.signal }, {
      command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"] });
    clearTimeout(timer); expect(result.status).toBe("cancelled");
  });
});

describe.skipIf(!fs.existsSync(cli))("built investigative CLI", () => {
  it("prepares Markdown assignments with no provider authentication", async () => {
    const args = setup();
    const { stdout } = await execFileAsync(process.execPath, [cli, "investigate", args.target,
      "--council", "general-doc", "--persona", "skeptical_expert", "--agent", "codex",
      "--agent", "claude", "--criteria", "Verify ownership", "--dry-run", "--out", args.outDir], {
      cwd: args.workspace, env: { ...process.env, QUORABLE_HOME: path.join(args.workspace, "home") },
    });
    expect(stdout).toContain("Council planned");
    expect(fs.readFileSync(path.join(args.outDir, "prompts", "review-1-1.md"), "utf8")).toContain("Verify ownership");
    expect(fs.readdirSync(path.join(args.outDir, "prompts"))).toHaveLength(3);
  });
  it.skipIf(process.platform === "win32")("runs a fake harness end to end without model calls", async () => {
    const args = setup(); const bin = path.join(args.workspace, "bin"); fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "codex"), '#!/usr/bin/env node\nprocess.stdin.resume(); process.stdin.on("end", () => console.log("## Assessment\\nReview completed with evidence."));\n', { mode: 0o755 });
    const { stdout } = await execFileAsync(process.execPath, [cli, "investigate", args.target,
      "--council", "general-doc", "--persona", "skeptical_expert", "--agent", "codex",
      "--out", args.outDir], { cwd: args.workspace,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, QUORABLE_HOME: path.join(args.workspace, "home") },
    });
    expect(stdout).toContain("Council completed");
    expect(fs.readFileSync(path.join(args.outDir, "synthesis_report.md"), "utf8")).toContain("Review completed with evidence.");
    expect(parse(fs.readFileSync(path.join(args.outDir, "run.yaml"), "utf8")).readiness).toBe("unassessed");
  });
});
