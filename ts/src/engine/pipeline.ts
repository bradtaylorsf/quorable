/**
 * Stage 1 parallel review pipeline, ported from pipeline.py.
 *
 * Fans out review calls across all (model, persona, run) combinations with
 * semaphore-based concurrency limiting. Enforces held-out exclusion IN
 * CODE, the cost abort threshold (checked before and inside the semaphore —
 * abort, never degrade), and graceful failure handling: failures become
 * result rows, never crashes.
 */

import type { z } from "zod";

import { CostAbortError, CostTracker } from "./costs.js";
import { buildMessages, estimatePromptTokens } from "./prompts.js";
import { validatedCall } from "./validation.js";
import type { DocumentModel } from "./manifest.js";
import { ModelClient, type ProviderSettings } from "../providers/registry.js";

export interface ReviewerModel {
  id: string;
  temperature: number;
}

export interface ReviewJob {
  model: ReviewerModel;
  persona: string;
  runNumber: number;
}

export interface ReviewResult {
  model: string;
  persona: string;
  runNumber: number;
  review: Record<string, unknown> | null;
  latencySeconds: number;
  promptTokensEstimate: number;
  validationOk: boolean;
  error: string | null;
}

/** Simple counting semaphore. */
export class Semaphore {
  private queue: (() => void)[] = [];
  private available: number;

  constructor(count: number) {
    this.available = count;
  }

  async acquire(): Promise<() => void> {
    if (this.available > 0) {
      this.available -= 1;
      return () => this.release();
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
    this.available -= 1;
    return () => this.release();
  }

  private release(): void {
    this.available += 1;
    const next = this.queue.shift();
    if (next) next();
  }
}

/**
 * Generate all (model, persona, run) combinations, excluding held-out.
 * The held-out model is excluded here IN CODE, not just in configuration.
 */
export function buildJobList(args: {
  reviewers: ReviewerModel[];
  heldOutId: string;
  personas: string[];
  runsPerPersona: number;
  onWarning?: (msg: string) => void;
}): ReviewJob[] {
  const jobs: ReviewJob[] = [];
  for (const model of args.reviewers) {
    if (model.id === args.heldOutId) {
      args.onWarning?.(
        `Reviewer model ${model.id} matches held-out model — skipping from Stage 1`,
      );
      continue;
    }
    for (const persona of args.personas) {
      for (let run = 1; run <= args.runsPerPersona; run++) {
        jobs.push({ model, persona, runNumber: run });
      }
    }
  }
  return jobs;
}

export interface Stage1Args {
  jobs: ReviewJob[];
  personaOverlays: Record<string, string>;
  personaDocuments: Record<string, DocumentModel[]>;
  systemPrompt: string;
  reviewSchema: z.ZodType<Record<string, unknown>>;
  canonicalUnits: string[] | null;
  unitField: string;
  providerSettings: ProviderSettings;
  maxConcurrency: number;
  costTracker: CostTracker;
  abortThreshold: number;
  onWarning?: (msg: string) => void;
  /** Injectable for tests: runs one review call. */
  callFn?: (job: ReviewJob, messages: ReturnType<typeof buildMessages>) => Promise<Record<string, unknown> | null>;
}

/**
 * Execute the Stage-1 fan-out. The cost governor is re-checked inside the
 * semaphore — the point where a job actually starts spending money.
 */
export async function runStage1(args: Stage1Args): Promise<ReviewResult[]> {
  const semaphore = new Semaphore(args.maxConcurrency);
  const warn = args.onWarning ?? (() => {});

  const clients = new Map<string, ModelClient>();
  const clientFor = (spec: string): ModelClient => {
    let client = clients.get(spec);
    if (!client) {
      client = new ModelClient(spec, args.providerSettings, args.costTracker);
      clients.set(spec, client);
    }
    return client;
  };

  const overBudget = (): boolean => args.costTracker.totalUsd > args.abortThreshold;

  const runJob = async (job: ReviewJob): Promise<ReviewResult> => {
    if (overBudget()) {
      throw new CostAbortError(
        `Running cost $${args.costTracker.totalUsd.toFixed(2)} exceeds ` +
          `abort threshold $${args.abortThreshold.toFixed(2)}`,
      );
    }
    const messages = buildMessages({
      systemPrompt: args.systemPrompt,
      personaOverlay: args.personaOverlays[job.persona] ?? "",
      documents: args.personaDocuments[job.persona] ?? [],
      schema: args.reviewSchema,
      canonicalUnits: args.canonicalUnits,
      unitField: args.unitField,
    });
    const tokenEstimate = estimatePromptTokens(messages);

    const release = await semaphore.acquire();
    const start = performance.now();
    try {
      // Re-check inside the semaphore: money is about to be spent.
      if (overBudget()) {
        throw new CostAbortError(
          `Running cost $${args.costTracker.totalUsd.toFixed(2)} exceeds ` +
            `abort threshold $${args.abortThreshold.toFixed(2)}`,
        );
      }
      const review = args.callFn
        ? await args.callFn(job, messages)
        : await validatedCall(clientFor(job.model.id), messages, args.reviewSchema, {
            temperature: job.model.temperature,
            persona: job.persona,
            onWarning: warn,
          });
      const latency = (performance.now() - start) / 1000;
      return {
        model: job.model.id,
        persona: job.persona,
        runNumber: job.runNumber,
        review,
        latencySeconds: Math.round(latency * 1000) / 1000,
        promptTokensEstimate: tokenEstimate,
        validationOk: review !== null,
        error: review === null ? "validation or API failure" : null,
      };
    } finally {
      release();
    }
  };

  const settled = await Promise.allSettled(args.jobs.map((job) => runJob(job)));

  const results: ReviewResult[] = [];
  for (let i = 0; i < settled.length; i++) {
    const outcome = settled[i]!;
    if (outcome.status === "fulfilled") {
      results.push(outcome.value);
      continue;
    }
    // Cost aborts propagate — abort, never degrade.
    if (outcome.reason instanceof CostAbortError) throw outcome.reason;
    const job = args.jobs[i]!;
    warn(
      `Review failed | model=${job.model.id} persona=${job.persona} ` +
        `run=${job.runNumber} error=${outcome.reason}`,
    );
    results.push({
      model: job.model.id,
      persona: job.persona,
      runNumber: job.runNumber,
      review: null,
      latencySeconds: 0,
      promptTokensEstimate: 0,
      validationOk: false,
      error: String(outcome.reason),
    });
  }
  return results;
}

/** Count successful reviews per configured persona (dropout surfacing). */
export function personaCoverage(
  results: ReviewResult[],
  personas: string[],
): Record<string, number> {
  const coverage: Record<string, number> = Object.fromEntries(
    personas.map((p) => [p, 0]),
  );
  for (const r of results) {
    if (r.review !== null && r.persona in coverage) coverage[r.persona]! += 1;
  }
  return coverage;
}
