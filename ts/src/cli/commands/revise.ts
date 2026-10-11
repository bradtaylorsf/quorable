import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Option, type Command } from "commander";
import { Document, isScalar, visit } from "yaml";
import { resolveContext } from "../context.js";
import { parseAgentSpec } from "../../engine/agentHarness.js";
import { describeStopRules, runRevisionLoop } from "../../engine/revisionLoop.js";
import { recheckRevisionRun } from "../../engine/readiness.js";
import { DEFAULT_EXCLUDES } from "../../engine/tree.js";
import { formatNumber } from "../../engine/metrics.js";
import { DEFAULT_STOP_RULES, loadRevisionPolicy, policyToPlain, resolveRevisionPolicy } from "../../config/revisionPolicy.js";

const collect = (v: string, previous: string[]): string[] => [...previous, v];
function integer(v: string): number {
  const n = Number(v); if (!Number.isSafeInteger(n) || n < 0) throw new Error("Expected a nonnegative integer."); return n;
}
interface Options {
  council?: string; rubric?: string; persona: string[]; config?: string; context: string[]; policy?: string;
  criteria?: string; agent: string[]; synthesizer: string; reviser: string; verifier: string;
  evaluator: string; out?: string; concurrency: number; timeout: number;
  maxRevisions?: number; maxInvestigations?: number; maxJobs?: number; maxElapsed?: number;
  plateauRounds?: number; stagnationCycles?: number; onRegression?: string; require: string[];
  exclude: string[]; primary?: string; check: string[]; setup: string[]; metric: string[]; derive: string[];
  checkTimeout: number; dryRun?: boolean;
}
export function registerRevisionCommand(program: Command): void {
  program.command("readiness <run-dir>")
    .description("Recheck a revision run's decision, source versions, and evidence artifacts")
    .action((dir: string) => {
      const result = recheckRevisionRun(path.resolve(dir));
      console.log(result.ready ? "READY: recorded readiness policy still passes." : "NOT READY:");
      for (const reason of result.reasons) console.log(`- ${reason}`);
      if (result.candidate) console.log(`Candidate: ${result.candidate}`);
      if (!result.ready) process.exitCode = 2;
    });
  program.command("revise <path>")
    .description("Bounded review → fix-in-place → verify loop over a text file or a whole directory; stops on readiness, plateau, regression policy, or budget; source never modified")
    .option("--policy <file>", "revision policy YAML: criteria, setup, checks, metrics, derive steps, stop rules (see docs/examples/revise-policy.yaml)")
    .option("--criteria <text>", "explicit purpose and readiness requirements (required here or as criteria: in the policy)")
    .option("--council <name>", "council to review each version")
    .option("--rubric <name>", "rubric supplying text gates, checks and metrics")
    .option("--persona <name>", "persona to include (repeatable)", collect, [])
    .option("--config <path>", "explicit project configuration")
    .option("--context <path>", "text evidence to snapshot (repeatable)", collect, [])
    .option("--primary <relpath>", "primary text file inside a directory target (needed for text gates)")
    .option("--exclude <name>", `directory/file name to skip when copying a directory target (repeatable; defaults: ${DEFAULT_EXCLUDES.join(", ")})`, collect, [])
    .option("--check <name=command>", "pass/fail command run inside the candidate each round; exit 0 passes (repeatable, no shell)", collect, [])
    .option("--metric <spec>", "metric gate 'name >= threshold [xRUNS] [~MIN_DELTA]: command' — >= maximizes, <= minimizes; value = last number printed (repeatable)", collect, [])
    .option("--derive <name=command>", "command run first each round to derive evidence into $QUORABLE_DERIVE_OUT, e.g. a transcript of a render (repeatable)", collect, [])
    .option("--setup <name=command>", "one-time command run inside the fresh copy before round 0, e.g. deps='npm ci' (repeatable)", collect, [])
    .option("--check-timeout <seconds>", "per-command limit for --check/--metric/--derive/--setup", integer, 600)
    .option("--require <severity>", "finding severity that blocks readiness: blocking, major, minor (repeatable; blocking always; default blocking+major)", collect, [])
    .option("--on-regression <mode>", `what to do when an attempt breaks a passing check or worsens a metric beyond its min_delta: continue | revert | stop (default: ${DEFAULT_STOP_RULES.onRegression})`)
    .option("--plateau-rounds <n>", `stop as stalled after n consecutive attempts without meaningful progress (default: ${DEFAULT_STOP_RULES.plateauRounds})`, integer)
    .addOption(new Option("--stagnation-cycles <n>", "deprecated alias of --plateau-rounds").argParser(integer).hideHelp())
    .option("--max-revisions <n>", `maximum revision attempts, accepted or reverted (default: ${DEFAULT_STOP_RULES.maxRevisions})`, integer)
    .option("--max-investigations <n>", `maximum targeted verification waves (default: ${DEFAULT_STOP_RULES.maxInvestigations})`, integer)
    .option("--max-jobs <n>", `total agent invocation limit including repairs (default: ${DEFAULT_STOP_RULES.maxJobs})`, integer)
    .option("--max-elapsed <seconds>", `total run deadline (default: ${DEFAULT_STOP_RULES.maxElapsedSeconds})`, integer)
    .option("--agent <harness[:model]>", "each agent runs every persona (default: codex and claude)", collect, [])
    .option("--synthesizer <harness[:model]>", "synthesis agent", "claude")
    .option("--reviser <harness[:model]>", "revision author: a normal coding session confined to the candidate copy", "codex")
    .option("--verifier <harness[:model]>", "independent verification session (default: claude)", "claude")
    .option("--evaluator <harness[:model]>", "fresh final evaluation session without panel reports", "claude")
    .option("--concurrency <n>", "maximum parallel review agents", integer, 3)
    .option("--timeout <seconds>", "per-agent wall-clock limit", integer, 600)
    .option("--out <dir>", "fresh run directory, outside the target and reference directories")
    .option("--dry-run", "print the resolved policy and stop rules, then exit without starting anything")
    .action(async (file: string, opts: Options) => {
      const target = path.resolve(file);
      const isDir = fs.existsSync(target) && fs.statSync(target).isDirectory();
      // Config discovery starts at the target directory itself when the target is a directory.
      const ctx = resolveContext(isDir ? path.join(target, ".") : target, { council: opts.council, rubric: opts.rubric,
        personas: opts.persona, config: opts.config });
      const policy = resolveRevisionPolicy({
        file: opts.policy ? loadRevisionPolicy(path.resolve(opts.policy)) : null,
        rubric: { checks: ctx.pack.mechanicalChecks, metrics: ctx.pack.mechanicalMetrics },
        flags: { criteria: opts.criteria, primary: opts.primary, exclude: opts.exclude, setup: opts.setup, check: opts.check,
          metric: opts.metric, derive: opts.derive, checkTimeoutMs: opts.checkTimeout * 1000, require: opts.require,
          maxRevisions: opts.maxRevisions, maxInvestigations: opts.maxInvestigations, maxJobs: opts.maxJobs,
          maxElapsedSeconds: opts.maxElapsed, plateauRounds: opts.plateauRounds ?? opts.stagnationCycles, onRegression: opts.onRegression },
      });
      const limits = { maxRevisions: policy.stop.maxRevisions, maxInvestigations: policy.stop.maxInvestigations,
        maxJobs: policy.stop.maxJobs, maxElapsedMs: policy.stop.maxElapsedSeconds * 1000, stagnationCycles: policy.stop.plateauRounds };
      const agents = { reviewers: opts.agent.length ? opts.agent : ["codex", "claude"], synthesizer: opts.synthesizer,
        reviser: opts.reviser, verifier: opts.verifier, evaluator: opts.evaluator };
      const stopRules = describeStopRules({ requiredSeverities: policy.stop.require, textGates: ctx.pack.mechanicalGates.map((g) => g.name),
        checks: policy.checks, derive: policy.derive, metrics: policy.metrics, limits, onRegression: policy.stop.onRegression });
      const problems: string[] = [];
      if (!policy.criteria) problems.push("No criteria: pass --criteria or set criteria: in the policy file.");
      if (isDir && ctx.pack.mechanicalGates.length && !policy.primary) problems.push(`Rubric '${ctx.pack.name}' has text gates (${ctx.pack.mechanicalGates.map((g) => g.name).join(", ")}) but no primary file: pass --primary, or use a rubric without text gates such as --council code-review.`);
      if (opts.dryRun) {
        const doc = new Document({ target, kind: isDir ? "directory" : "file",
          council: ctx.council.name, rubric: ctx.pack.name, personas: ctx.personas, text_gates: ctx.pack.mechanicalGates.map((g) => g.name),
          agents, ...policyToPlain(policy) });
        // Lists of plain values (argv, names) read best on one line.
        visit(doc, { Seq(_, node) { if (node.items.every((item) => isScalar(item))) node.flow = true; } });
        console.log(`# quorable revise — dry run, nothing was started\n${doc.toString({ lineWidth: 0 })}`);
        console.log(`# Stop rules\n${stopRules}`);
        if (problems.length) { console.log(`\n# A real run would be refused\n${problems.map((p) => `- ${p}`).join("\n")}`); process.exitCode = 1; }
        return;
      }
      if (problems.length) throw new Error(problems.join("\n"));
      const controller = new AbortController(); const abort = (): void => controller.abort();
      process.once("SIGINT", abort); process.once("SIGTERM", abort);
      try {
        console.error(`Harness billing applies; job/time limits are enforced, dollar cost is unknown. ${isDir ? "The target directory" : "The source file"} will not be modified; the reviser works in a disposable copy.`);
        if (opts.reviser.startsWith("claude")) console.error("Note: the Claude reviser runs with Edit/Write/Bash under a permission allowlist and no OS sandbox; Codex uses its workspace-write sandbox.");
        console.error(`Stop rules:\n${stopRules}`);
        const result = await runRevisionLoop({ target, workspace: isDir ? target : path.dirname(target),
          contextPaths: opts.context.map((p) => path.resolve(p)),
          outDir: path.resolve(opts.out ?? path.join(path.dirname(target), `${path.parse(target).name || path.basename(target)}-revised-${randomUUID().slice(0, 8)}`)),
          criteria: policy.criteria!, personas: ctx.personaOverlays,
          reviewers: agents.reviewers.map(parseAgentSpec),
          synthesizers: [parseAgentSpec(opts.synthesizer)], reviser: parseAgentSpec(opts.reviser),
          verifier: parseAgentSpec(opts.verifier), evaluator: parseAgentSpec(opts.evaluator),
          gates: ctx.pack.mechanicalGates, checks: policy.checks, metrics: policy.metrics, derive: policy.derive, setup: policy.setup,
          primary: policy.primary ?? undefined, excludes: [...DEFAULT_EXCLUDES, ...policy.exclude],
          requiredSeverities: policy.stop.require, onRegression: policy.stop.onRegression,
          maxConcurrency: opts.concurrency, timeoutMs: opts.timeout * 1000, limits,
          signal: controller.signal, onEvent: (m) => console.error(m),
        });
        console.log(`Readiness: ${result.status}\nCandidate: ${result.candidate}${result.primary ? `\nPrimary: ${result.primary}` : ""}\nReport: ${result.report}`);
        for (const [name, m] of Object.entries(result.metrics)) console.log(`Metric ${name}: ${m.value === null ? "not measurable" : formatNumber(m.value)} (${m.passed ? "met" : "not met"})`);
        console.log(`Revisions accepted: ${result.revisions} of ${result.attempts} attempt(s); agent jobs: ${result.jobs}`);
        for (const reason of result.reasons) console.log(`- ${reason}`);
        if (result.status !== "ready") process.exitCode = result.status === "failed" ? 1 : result.status === "cancelled" ? 130 : 2;
      } finally { process.removeListener("SIGINT", abort); process.removeListener("SIGTERM", abort); }
    });
}
