import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Command } from "commander";
import { resolveContext } from "../context.js";
import { parseAgentSpec } from "../../engine/agentHarness.js";
import { runInvestigation } from "../../engine/investigation.js";

const collect = (value: string, previous: string[]): string[] => [...previous, value];
function positive(value: string): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error("Expected a positive integer.");
  return n;
}
interface Options {
  council?: string; rubric?: string; persona: string[]; config?: string;
  workspace?: string; context: string[]; out?: string; criteria?: string;
  agent: string[]; synthesizer: string[]; finalSynthesizer?: string;
  concurrency: number; timeout: number; dryRun?: boolean;
}
export function registerInvestigationCommand(program: Command): void {
  program.command("investigate <file>")
    .description("Investigate with Codex/Claude Code personas and Markdown synthesis (advisory)")
    .option("--council <name>", "council supplying personas and rubric")
    .option("--rubric <name>", "rubric supplying review dimensions")
    .option("--persona <name>", "select a persona (repeatable)", collect, [])
    .option("--config <path>", "explicit project configuration")
    .option("--workspace <dir>", "agent working directory (default: document directory)")
    .option("--context <path>", "reference file or directory to investigate (repeatable)", collect, [])
    .option("--criteria <text>", "purpose, audience, requirements, and acceptance criteria")
    .option("--agent <harness[:model]>", "codex or claude, optional model; each runs every persona", collect, [])
    .option("--synthesizer <harness[:model]>", "synthesis agent (repeatable; multiple get a final synthesis)", collect, [])
    .option("--final-synthesizer <harness[:model]>", "agent to reconcile synthesis reports")
    .option("--concurrency <n>", "maximum simultaneous agents", positive, 3)
    .option("--timeout <seconds>", "wall-clock limit per agent", positive, 600)
    .option("--out <dir>", "fresh output directory (must not exist)")
    .option("--dry-run", "write assignments and planned report paths without launching agents")
    .action(async (file: string, opts: Options) => {
      const target = path.resolve(file);
      const ctx = resolveContext(target, { council: opts.council, rubric: opts.rubric,
        personas: opts.persona, config: opts.config });
      const reviewers = (opts.agent.length ? opts.agent : ["codex"]).map(parseAgentSpec);
      const synthesizers = opts.synthesizer.length ? opts.synthesizer.map(parseAgentSpec) : [reviewers[0]!];
      const controller = new AbortController();
      const cancel = (): void => controller.abort();
      process.once("SIGINT", cancel);
      process.once("SIGTERM", cancel);
      try {
        console.error(`Investigative council: ${ctx.personas.length * reviewers.length} reviewers, ${synthesizers.length} synthesizer(s). Harness billing applies; API cost governor does not apply.`);
        const outcome = await runInvestigation({
          target, workspace: path.resolve(opts.workspace ?? path.dirname(target)),
          contextPaths: opts.context.map((p) => path.resolve(p)),
          outDir: path.resolve(opts.out ?? path.join(path.dirname(target), `${path.parse(target).name}-investigated-${randomUUID().slice(0, 8)}`)),
          personas: ctx.personaOverlays, reviewers, synthesizers,
          finalSynthesizer: opts.finalSynthesizer ? parseAgentSpec(opts.finalSynthesizer) : undefined,
          criteria: [`Council: ${ctx.council.name}; rubric: ${ctx.pack.name}.`,
            `Evaluate these dimensions: ${ctx.pack.scoreDimensions.join(", ")}.`,
            `Document units: ${ctx.pack.canonicalUnits.join(", ")}.`,
            opts.criteria ?? "Infer the document's intended audience and purpose; state your assumptions."].join("\n"),
          maxConcurrency: opts.concurrency, timeoutMs: opts.timeout * 1000,
          dryRun: opts.dryRun, signal: controller.signal, onEvent: (m) => console.error(m),
        });
        console.log(`Council ${outcome.status}. Report: ${outcome.report}`);
        if (outcome.status === "incomplete") process.exitCode = 2;
      } finally {
        process.removeListener("SIGINT", cancel);
        process.removeListener("SIGTERM", cancel);
      }
    });
}
