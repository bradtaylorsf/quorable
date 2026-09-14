import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Command } from "commander";
import { resolveContext } from "../context.js";
import { parseAgentSpec } from "../../engine/agentHarness.js";
import { runRevisionLoop } from "../../engine/revisionLoop.js";
import { recheckRevisionRun } from "../../engine/readiness.js";
const collect = (v: string, previous: string[]): string[] => [...previous, v];
function integer(v: string): number {
  const n = Number(v); if (!Number.isSafeInteger(n) || n < 0) throw new Error("Expected a nonnegative integer."); return n;
}
interface Options {
  council?: string; rubric?: string; persona: string[]; config?: string; context: string[];
  criteria: string; agent: string[]; synthesizer: string; reviser: string; verifier: string;
  evaluator: string; out?: string; concurrency: number; timeout: number;
  maxRevisions: number; maxInvestigations: number; maxJobs: number; maxElapsed: number;
  stagnationCycles: number;
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
  program.command("revise <file>")
    .description("Bounded agent revision loop with evidence-linked readiness (never overwrites the source)")
    .requiredOption("--criteria <text>", "explicit purpose and readiness requirements")
    .option("--council <name>", "council to review each version")
    .option("--rubric <name>", "rubric supplying mechanical checks")
    .option("--persona <name>", "persona to include (repeatable)", collect, [])
    .option("--config <path>", "explicit project configuration")
    .option("--context <path>", "text evidence to snapshot (repeatable)", collect, [])
    .option("--agent <harness[:model]>", "each agent runs every persona (default: codex and claude)", collect, [])
    .option("--synthesizer <harness[:model]>", "synthesis agent", "claude")
    .option("--reviser <harness[:model]>", "revision author", "codex")
    .option("--verifier <harness[:model]>", "independent verification session (default: claude)", "claude")
    .option("--evaluator <harness[:model]>", "fresh final evaluation session without panel reports", "claude")
    .option("--concurrency <n>", "maximum parallel review agents", integer, 3)
    .option("--timeout <seconds>", "per-agent wall-clock limit", integer, 600)
    .option("--max-revisions <n>", "maximum revised candidates", integer, 3)
    .option("--max-investigations <n>", "maximum targeted verification waves", integer, 2)
    .option("--max-jobs <n>", "total agent invocation limit including repairs", integer, 40)
    .option("--max-elapsed <seconds>", "total run deadline", integer, 1200)
    .option("--stagnation-cycles <n>", "stop after this many revisions without verified progress", integer, 2)
    .option("--out <dir>", "fresh run directory, outside reference directories")
    .action(async (file: string, opts: Options) => {
      const target = path.resolve(file);
      const ctx = resolveContext(target, { council: opts.council, rubric: opts.rubric,
        personas: opts.persona, config: opts.config });
      const controller = new AbortController(); const abort = (): void => controller.abort();
      process.once("SIGINT", abort); process.once("SIGTERM", abort);
      try {
        console.error("Harness billing applies; job/time limits are enforced, dollar cost is unknown. Source file will not be overwritten.");
        const result = await runRevisionLoop({ target, workspace: path.dirname(target),
          contextPaths: opts.context.map((p) => path.resolve(p)),
          outDir: path.resolve(opts.out ?? path.join(path.dirname(target), `${path.parse(target).name}-revised-${randomUUID().slice(0, 8)}`)),
          criteria: opts.criteria, personas: ctx.personaOverlays,
          reviewers: (opts.agent.length ? opts.agent : ["codex", "claude"]).map(parseAgentSpec),
          synthesizers: [parseAgentSpec(opts.synthesizer)], reviser: parseAgentSpec(opts.reviser),
          verifier: parseAgentSpec(opts.verifier), evaluator: parseAgentSpec(opts.evaluator),
          gates: ctx.pack.mechanicalGates, maxConcurrency: opts.concurrency, timeoutMs: opts.timeout * 1000,
          limits: { maxRevisions: opts.maxRevisions, maxInvestigations: opts.maxInvestigations,
            maxJobs: opts.maxJobs, maxElapsedMs: opts.maxElapsed * 1000, stagnationCycles: opts.stagnationCycles },
          signal: controller.signal, onEvent: (m) => console.error(m),
        });
        console.log(`Readiness: ${result.status}\nCandidate: ${result.candidate}\nReport: ${result.report}`);
        if (result.status !== "ready") process.exitCode = result.status === "failed" ? 1 : result.status === "cancelled" ? 130 : 2;
      } finally { process.removeListener("SIGINT", abort); process.removeListener("SIGTERM", abort); }
    });
}
