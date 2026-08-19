/**
 * The zero-config review orchestrator (plan M4 + M5 + M6) behind
 * `quorable review <file>`:
 *
 *   auto-manifest → parse → (unit discovery for long docs) → Stage-1
 *   fan-out + cold reader → Stage-2 synthesis (stats patched in code) →
 *   mechanical gates → integrity metrics → validation tasks → held-out at
 *   rigorous (escape rate + sev-1 teeth) → regressions → ship check →
 *   reports, all written to <filename>-reviewed/.
 *
 * Failures become result rows; the cost governor aborts, never degrades.
 * Every stage call is injectable so the whole orchestration is testable
 * with no network.
 */

import fs from "node:fs";
import path from "node:path";

import { stringify as stringifyYaml } from "yaml";

import { assembleForPersona, assembleForStage2, assembleForStage3 } from "./assembly.js";
import { CostAbortError, CostTracker, estimatePipelineCost, estimatePerLoopUsd, type CostEstimate } from "./costs.js";
import { allGatesPassed, runGates, type GateResult } from "./gates.js";
import { autoManifest, assertManifestLoaded, type DocumentModel, type ManifestEntry } from "./manifest.js";
import { documentFromText, prepareDocuments, sha256Text } from "./parsers.js";
import { buildJobList, personaCoverage, runStage1, type ReviewJob, type ReviewResult, type Stage1CallContext } from "./pipeline.js";
import { runStage2 } from "./synthesis.js";
import { checkShipGates, type ShipCheckResult } from "./scoring.js";
import { mapReactionsToDimensions, rubricGaps, runColdRead, type ColdRead } from "./coldReader.js";
import { personaDifferentiation, twoSidedAgreementFlags, type AgreementFlags, type PersonaOverlap } from "./integrity.js";
import { collectValidationTasks, readValidationTasks, validationTaskShipReasons, writeValidationTasks, type ValidationTask } from "./validationTasks.js";
import { compareHeldOut, recordHoldoutUse, runStage3, verifyHeldOutExclusion, writeHeldOutTriage, type HeldOutComparison } from "./heldOut.js";
import { checkRegressions, loadRegistry, saveRegistry, updateRegistry, type RegressionResult } from "./regressions.js";
import { generateCostSummary, generateSynthesisReport } from "./reports.js";
import { mergeUnitReviews, runMapPass, splitByMap, unitReviewDocuments, UNIT_DISCOVERY_THRESHOLD_CHARS, type DocumentMap } from "./unitDiscovery.js";
import { ModelClient, resolutionOf, type ProviderSettings } from "../providers/registry.js";
import { panelVendorWarnings, type ChatMessage } from "../providers/types.js";
import type { Pack } from "../pack/types.js";
import type { QuorableConfig, RigorSettings } from "../config/schema.js";
import { activeReviewers, localBackendWarnings } from "../config/schema.js";

export interface ReviewInjected {
  /**
   * Stage-1: (job, messages) → validated review object or null. The optional
   * call context carries the job index and a failure-kind reporter (report
   * "provider" to exercise the recovery pass).
   */
  stage1CallFn?: (
    job: ReviewJob,
    messages: ChatMessage[],
    call?: Stage1CallContext,
  ) => Promise<Record<string, unknown> | null>;
  synthesisCallFn?: (messages: ChatMessage[]) => Promise<Record<string, unknown> | null>;
  /** Stage-2 unstructured fallback: messages → prose markdown or null. */
  synthesisFallbackFn?: (messages: ChatMessage[]) => Promise<string | null>;
  coldReadFn?: (messages: ChatMessage[]) => Promise<ColdRead | null>;
  coldMapFn?: (messages: ChatMessage[]) => Promise<{ mappings: { reaction_index: number; dimension: string | null }[] } | null>;
  mapPassFn?: (messages: ChatMessage[]) => Promise<DocumentMap | null>;
  heldOutCallFn?: (messages: ChatMessage[]) => Promise<Record<string, unknown> | null>;
  adjudicateFn?: (messages: ChatMessage[]) => Promise<{ verdicts: { held_out_weakness: string; matches_known_issue: boolean; matched_description: string }[] } | null>;
}

export interface ReviewArgs {
  targetPath: string;
  contextDirs: string[];
  outDir?: string | null;
  pack: Pack;
  personas: string[];
  personaOverlays: Record<string, string>;
  config: QuorableConfig;
  rigor: RigorSettings;
  providerSettings: ProviderSettings;
  systemPrompt: string;
  synthesisPrompt: string;
  coldReaderPrompt: string;
  /** Pre-run confirmation hook: return false to abort before spending. */
  confirmCost?: (estimate: CostEstimate, perLoopUsd: number) => Promise<boolean>;
  onEvent?: (msg: string) => void;
  injected?: ReviewInjected;
}

export interface ReviewOutcome {
  outDir: string;
  runId: string;
  shipCheck: ShipCheckResult;
  synthesis: Record<string, unknown> | null;
  /** Prose synthesis when the structured call failed and fallback ran. */
  synthesisMarkdown: string | null;
  results: ReviewResult[];
  coldRead: ColdRead | null;
  validationTasks: ValidationTask[];
  differentiation: PersonaOverlap[];
  agreementFlags: AgreementFlags | null;
  heldOutComparison: HeldOutComparison | null;
  regressions: RegressionResult | null;
  totalCostUsd: number;
  aborted: boolean;
  abortReason: string | null;
  panelWarnings: string[];
}

export function defaultOutDir(targetPath: string): string {
  const parsed = path.parse(path.resolve(targetPath));
  return path.join(parsed.dir, `${parsed.name}-reviewed`);
}

function generateRunId(): string {
  return new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace("T", "_")
    .slice(0, 15);
}

export async function runReview(args: ReviewArgs): Promise<ReviewOutcome> {
  const emit = args.onEvent ?? (() => {});
  const injected = args.injected ?? {};
  const outDir = args.outDir ?? defaultOutDir(args.targetPath);
  const runId = generateRunId();
  const logLines: string[] = [];
  const log = (msg: string): void => {
    logLines.push(`${new Date().toISOString()} ${msg}`);
    emit(msg);
  };

  const rawReviewsDir = path.join(outDir, "raw_reviews");
  fs.mkdirSync(rawReviewsDir, { recursive: true });
  // Re-runs over the same output directory must not inherit the previous
  // run's traces: same-named files would be overwritten anyway, but a
  // council change orphans the rest and `render` would score them into a
  // later verdict.
  const staleTraces = fs.readdirSync(rawReviewsDir).filter((f) => f.endsWith(".json"));
  for (const f of staleTraces) fs.rmSync(path.join(rawReviewsDir, f));
  if (staleTraces.length > 0) {
    log(`Cleared ${staleTraces.length} raw review trace(s) left by a previous run`);
  }
  const statusPath = path.join(outDir, "run_status.txt");
  fs.writeFileSync(statusPath, "running\n", "utf-8");

  // Written INCREMENTALLY as each review completes — a crash mid-run keeps
  // every finished review, and `ls raw_reviews` shows live progress. The
  // harness-tracked persona/model_id overwrite whatever the model claimed
  // to be (local models hallucinate both), and the run_id stamp lets
  // loadRawReviews reject traces that leak in from another run.
  const writeTrace = (r: {
    model: string;
    persona: string;
    runNumber: number;
    review: Record<string, unknown> | null;
  }): void => {
    if (r.review === null) return;
    const safeModel = r.model.replace(/[/:]/g, "_");
    const stamped = { ...r.review, persona: r.persona, model_id: r.model, run_id: runId };
    fs.writeFileSync(
      path.join(rawReviewsDir, `${safeModel}_${r.persona}_run${r.runNumber}.json`),
      JSON.stringify(stamped, null, 2),
      "utf-8",
    );
  };

  const tracker = new CostTracker();
  // Clients are constructed lazily so injected (no-network) stage functions
  // never require provider keys.
  const clientCache = new Map<string, ModelClient>();
  const getClient = (spec: string): ModelClient => {
    let client = clientCache.get(spec);
    if (!client) {
      client = new ModelClient(spec, args.providerSettings, tracker);
      clientCache.set(spec, client);
    }
    return client;
  };
  const abortThreshold =
    args.config.pipeline.cost_threshold * args.config.pipeline.cost_abort_multiplier;

  // Preserve the prior synthesis (if any) for the changes-since section.
  let priorSynthesis: Record<string, unknown> | null = null;
  const synthesisPath = path.join(outDir, "synthesis.json");
  if (fs.existsSync(synthesisPath)) {
    try {
      priorSynthesis = JSON.parse(fs.readFileSync(synthesisPath, "utf-8"));
    } catch {
      priorSynthesis = null;
    }
  }

  const finish = (outcome: ReviewOutcome): ReviewOutcome => {
    fs.writeFileSync(
      statusPath,
      outcome.aborted ? `aborted: ${outcome.abortReason}\n` : "completed\n",
      "utf-8",
    );
    fs.writeFileSync(path.join(outDir, "run.log"), logLines.join("\n") + "\n", "utf-8");
    fs.writeFileSync(
      path.join(outDir, "cost_summary.txt"),
      generateCostSummary(tracker),
      "utf-8",
    );
    return outcome;
  };

  const abortedOutcome = (reason: string): ReviewOutcome =>
    finish({
      outDir,
      runId,
      shipCheck: { ok: false, reasons: [reason], warnings: [], composite: null, perDimension: {} },
      synthesis: null,
      synthesisMarkdown: null,
      results: [],
      coldRead: null,
      validationTasks: [],
      differentiation: [],
      agreementFlags: null,
      heldOutComparison: null,
      regressions: null,
      totalCostUsd: tracker.totalUsd,
      aborted: true,
      abortReason: reason,
      panelWarnings: [],
    });

  // --- Manifest + documents -------------------------------------------------
  const entries: ManifestEntry[] = autoManifest(args.targetPath, args.contextDirs, {
    primaryName: args.pack.primaryDocName,
  });
  const documents = await prepareDocuments(entries, {
    // The primary-too-large guard is deliberately NOT applied here: long
    // primaries go through unit discovery instead of failing.
    primaryDocName: null,
    onWarning: log,
  });
  assertManifestLoaded(entries, documents);
  const primary = documents[args.pack.primaryDocName];
  if (!primary) {
    return abortedOutcome(`primary document failed to load: ${args.targetPath}`);
  }

  // --- Panel composition warnings (statistical honesty) ---------------------
  const configuredReviewers = activeReviewers(args.config);
  const reviewers = configuredReviewers.filter(
    (r) => r.id !== args.config.models.held_out.id,
  );
  if (reviewers.length === 0) {
    return abortedOutcome(
      `held-out model ${args.config.models.held_out.id} is the only configured ` +
        `reviewer — the Stage-1 panel is empty (a validator must not sit on the ` +
        `panel it validates). Configure at least one reviewer distinct from held_out.`,
    );
  }
  const panelWarnings = [
    // The exclusion is correct by design, but it must never be silent: a
    // held_out that names a reviewer quietly shrinks the panel (and the
    // whole run, if the survivors then fail).
    ...(reviewers.length < configuredReviewers.length
      ? [
          `held-out model ${args.config.models.held_out.id} is also configured as a ` +
            `reviewer — it is EXCLUDED from the Stage-1 panel (a validator must not ` +
            `sit on the panel it validates). Panel is ${reviewers.length} of ` +
            `${configuredReviewers.length} configured reviewer(s): ` +
            reviewers.map((r) => r.id).join(", "),
        ]
      : []),
    ...panelVendorWarnings(
      reviewers.map((r) => r.id),
      args.rigor.heldOut ? args.config.models.held_out.id : null,
      resolutionOf(args.providerSettings),
    ),
    ...localBackendWarnings(args.config),
  ];
  for (const w of panelWarnings) log(`WARNING: ${w}`);

  // --- Rigor: persona limiting (quick = council's top 3) --------------------
  const personas =
    args.rigor.personaLimit !== null
      ? args.personas.slice(0, args.rigor.personaLimit)
      : args.personas;

  // --- Long-document unit discovery (§5.2) ----------------------------------
  let pack = args.pack;
  let discoveredMap: DocumentMap | null = null;
  let discoveredUnits: ReturnType<typeof splitByMap> = null;
  if (primary.charCount > UNIT_DISCOVERY_THRESHOLD_CHARS) {
    log(
      `Primary document is ${primary.charCount.toLocaleString("en-US")} chars — ` +
        `running unit discovery (map pass)`,
    );
    discoveredMap = await runMapPass({
      client: injected.mapPassFn ? null : getClient(args.config.models.synthesizer.id),
      documentText: primary.content,
      onWarning: log,
      callFn: injected.mapPassFn,
    });
    if (discoveredMap) {
      discoveredUnits = splitByMap(primary.content, discoveredMap);
      if (discoveredUnits) {
        pack = {
          ...args.pack,
          canonicalUnits: discoveredUnits.map((u) => u.name),
        };
        log(
          `Discovered ${discoveredUnits.length} units: ` +
            discoveredUnits.map((u) => u.name).join(" | "),
        );
      } else {
        log("Unit boundaries could not be located — falling back to whole-document review");
      }
    } else {
      log("Map pass failed — falling back to whole-document review");
    }
  }

  // --- Job list + cost estimate --------------------------------------------
  const runsPerPersona = args.rigor.runsPerPersona;
  const jobs = buildJobList({
    reviewers,
    heldOutId: args.config.models.held_out.id,
    personas,
    runsPerPersona,
    onWarning: log,
  });

  const personaDocs: Record<string, DocumentModel[]> = {};
  for (const persona of personas) {
    personaDocs[persona] = assembleForPersona(persona, entries, documents);
  }

  // The estimate must describe the calls that will actually be made. On a
  // long document every job fans out across the discovered units, and each
  // of those calls sees one unit's payload in place of the whole primary —
  // so both the count and the per-call prompt change. Estimating from the
  // un-fanned job list understates the run by roughly the unit count, and
  // this is the number the user confirms before the money is spent.
  const unitFanOut =
    discoveredMap && discoveredUnits
      ? (() => {
          const units = discoveredUnits;
          // Unit payloads do not vary by persona; build them once.
          const unitDocChars = units.map((_, i) =>
            unitReviewDocuments(discoveredMap, units, i).map((d) => d.charCount),
          );
          return {
            unitCount: units.length,
            perUnitDocChars: (persona: string, unitIndex: number) => [
              ...(personaDocs[persona] ?? [])
                .filter((d) => d.name !== pack.primaryDocName)
                .map((d) => d.charCount),
              ...(unitDocChars[unitIndex] ?? []),
            ],
          };
        })()
      : null;

  const estimate = estimatePipelineCost({
    reviewerIds: reviewers.map((r) => r.id),
    synthesizerId: args.config.models.synthesizer.id,
    drafterId: null,
    endpoints: Object.keys(args.providerSettings.endpoints ?? {}),
    runsPerPersona,
    personas,
    personaDocChars: (p) => (personaDocs[p] ?? []).map((d) => d.charCount),
    allDocChars: Object.values(documents).map((d) => d.charCount),
    systemPromptChars: args.systemPrompt.length,
    personaOverlayChars: Object.fromEntries(
      Object.entries(args.personaOverlays).map(([p, o]) => [p, o.length]),
    ),
    includeDrafter: false,
    iterations: 1,
    unitFanOut,
    // The cold reader runs at every rigor tier: one read plus one mapping call.
    coldRead: { promptChars: args.coldReaderPrompt.length + primary.charCount + 2000 },
  });
  const perLoop = estimatePerLoopUsd(estimate);
  const reviewCalls = jobs.length * (unitFanOut?.unitCount ?? 1);
  log(
    `Estimated cost: $${perLoop.toFixed(2)} (${reviewCalls} review calls` +
      (unitFanOut ? ` — ${jobs.length} jobs × ${unitFanOut.unitCount} units` : "") +
      ` + cold read + synthesis)`,
  );
  if (args.confirmCost) {
    const proceed = await args.confirmCost(estimate, perLoop);
    if (!proceed) return abortedOutcome("aborted by user at cost confirmation");
  }

  // --- Stage 1 + cold reader (M6.1 — every tier) ----------------------------
  let results: ReviewResult[];
  let coldRead: ColdRead | null = null;
  try {
    const stage1Args = {
      personaOverlays: args.personaOverlays,
      systemPrompt: args.systemPrompt,
      reviewSchema: pack.reviewSchema,
      unitField: pack.unitField,
      providerSettings: args.providerSettings,
      maxConcurrency: args.config.pipeline.max_concurrency,
      costTracker: tracker,
      abortThreshold,
      onWarning: log,
      callFn: injected.stage1CallFn,
    };

    const coldPromise = runColdRead({
      client: injected.coldReadFn ? null : getClient(args.config.models.synthesizer.id),
      coldReaderPrompt: args.coldReaderPrompt,
      documentText: primary.content,
      onWarning: log,
      callFn: injected.coldReadFn,
    });

    if (discoveredMap && discoveredUnits) {
      // Unit-scoped review: fan out (job × unit), then merge per job.
      const units = discoveredUnits;
      const perJobReviews = new Map<string, (Record<string, unknown> | null)[]>();
      const unitJobs: ReviewJob[] = [];
      const unitJobMeta: { jobKey: string; unitIndex: number }[] = [];
      for (const job of jobs) {
        const jobKey = `${job.model.id}|${job.persona}|${job.runNumber}`;
        perJobReviews.set(jobKey, []);
        for (let u = 0; u < units.length; u++) {
          unitJobs.push(job);
          unitJobMeta.push({ jobKey, unitIndex: u });
        }
      }
      const mergeJob = (jobKey: string): Record<string, unknown> | null =>
        mergeUnitReviews(
          (perJobReviews.get(jobKey) ?? []).filter(
            (r): r is Record<string, unknown> => r !== null,
          ),
          {
            unitListField: pack.unitListField,
            verdictField: pack.verdictField,
            verdictCategories: pack.verdictCategories,
          },
        );
      const unitResults = await runStage1({
        ...stage1Args,
        jobs: unitJobs,
        personaDocuments: {}, // overridden per call below
        canonicalUnits: null,
        callFn: async (job, messages, call) => {
          void messages;
          const meta = unitJobMeta[call.jobIndex]!;
          const docs = [
            ...(personaDocs[job.persona] ?? []).filter(
              (d) => d.name !== pack.primaryDocName,
            ),
            ...unitReviewDocuments(discoveredMap!, units, meta.unitIndex),
          ];
          const { buildMessages } = await import("./prompts.js");
          const unitMessages = buildMessages({
            systemPrompt: args.systemPrompt,
            personaOverlay: args.personaOverlays[job.persona] ?? "",
            documents: docs,
            schema: pack.reviewSchema,
            canonicalUnits: [units[meta.unitIndex]!.name],
            unitField: pack.unitField,
          });
          const review = injected.stage1CallFn
            ? await injected.stage1CallFn(job, unitMessages, call)
            : await (async () => {
                const { validatedCall } = await import("./validation.js");
                return validatedCall(getClient(job.model.id), unitMessages, pack.reviewSchema, {
                  temperature: job.model.temperature,
                  persona: job.persona,
                  onWarning: log,
                  onFailure: call.reportFailure,
                });
              })();
          const jobReviews = perJobReviews.get(meta.jobKey)!;
          jobReviews.push(review);
          // Last expected unit (or a recovery-pass retry): the merged trace
          // for this job is complete enough to persist now.
          if (jobReviews.length >= units.length) {
            writeTrace({
              model: job.model.id,
              persona: job.persona,
              runNumber: job.runNumber,
              review: mergeJob(meta.jobKey),
            });
          }
          return review;
        },
      });
      void unitResults;
      results = jobs.map((job) => {
        const jobKey = `${job.model.id}|${job.persona}|${job.runNumber}`;
        const merged = mergeJob(jobKey);
        return {
          model: job.model.id,
          persona: job.persona,
          runNumber: job.runNumber,
          review: merged,
          latencySeconds: 0,
          promptTokensEstimate: 0,
          validationOk: merged !== null,
          error: merged === null ? "all unit reviews failed" : null,
          failureKind: null,
        };
      });
    } else {
      results = await runStage1({
        ...stage1Args,
        jobs,
        personaDocuments: personaDocs,
        canonicalUnits: pack.canonicalUnits.length > 0 ? pack.canonicalUnits : null,
        onResult: writeTrace,
      });
    }

    coldRead = await coldPromise;
  } catch (exc) {
    if (exc instanceof CostAbortError) {
      log(`COST ABORT: ${exc.message}`);
      return abortedOutcome(exc.message);
    }
    throw exc;
  }

  // Traces were written incrementally as reviews completed; this idempotent
  // sweep guarantees completeness for rows recovered from rejections.
  for (const r of results) writeTrace(r);

  const coverage = personaCoverage(results, personas);
  const missingPersonas = Object.entries(coverage)
    .filter(([, n]) => n === 0)
    .map(([p]) => p);
  if (missingPersonas.length > 0) {
    // A lens lost to PROVIDER errors is a quieter, worse failure than one
    // lost to validation: the reviews were never produced at all, and the
    // run otherwise "succeeds". Say which one happened.
    const providerLost = missingPersonas.filter((p) => {
      const rows = results.filter((r) => r.persona === p);
      return rows.length > 0 && rows.every((r) => r.failureKind === "provider");
    });
    const otherLost = missingPersonas.filter((p) => !providerLost.includes(p));
    if (otherLost.length > 0) {
      log(
        `PERSONA DROPOUT: no successful reviews for persona(s): ` +
          `${otherLost.join(", ")} — the synthesis will be missing these lenses.`,
      );
    }
    if (providerLost.length > 0) {
      log(
        `PERSONA DROPOUT (provider errors): every call for persona(s) ` +
          `${providerLost.join(", ")} failed at the PROVIDER even after the ` +
          `recovery pass — the model(s) never answered (network/API failure, ` +
          `not validation). The synthesis will be missing these lenses; check ` +
          `the backend is up and re-run.`,
      );
    }
  }

  // --- Cold-read dimension mapping (rubric gaps) ----------------------------
  if (coldRead && coldRead.reactions.length > 0) {
    const dimensionDescriptions = Object.fromEntries(
      pack.scoreDimensions.map((d) => [d, ""]),
    );
    coldRead = await mapReactionsToDimensions({
      client: injected.coldMapFn ? null : getClient(args.config.models.synthesizer.id),
      coldRead,
      dimensions: dimensionDescriptions,
      onWarning: log,
      callFn: injected.coldMapFn,
    });
    fs.writeFileSync(
      path.join(outDir, "cold_read.json"),
      JSON.stringify(coldRead, null, 2),
      "utf-8",
    );
    const gaps = rubricGaps(coldRead);
    if (gaps.length > 0) {
      log(`RUBRIC GAPS: ${gaps.length} cold-read reaction(s) map to no rubric dimension`);
    }
  }

  // --- Stage 2 synthesis ----------------------------------------------------
  const stage2 = await runStage2({
    results,
    agreementPack: pack,
    synthesisSchema: pack.synthesisSchema,
    systemPrompt: args.systemPrompt,
    synthesisPrompt: args.synthesisPrompt,
    stage2Documents: assembleForStage2(entries, documents),
    client: injected.synthesisCallFn ? null : getClient(args.config.models.synthesizer.id),
    temperature: args.config.models.synthesizer.temperature,
    expectedReviews: jobs.length,
    agreementStats: args.rigor.agreementStats,
    synthesisFallback: args.config.pipeline.synthesis_fallback,
    onWarning: log,
    callFn: injected.synthesisCallFn,
    fallbackCallFn: injected.synthesisFallbackFn,
  });
  if (tracker.totalUsd > abortThreshold) {
    return abortedOutcome(
      `Running cost $${tracker.totalUsd.toFixed(2)} exceeds abort threshold ` +
        `$${abortThreshold.toFixed(2)}`,
    );
  }
  const synthesis = stage2.synthesis;
  const synthesisMarkdown = stage2.synthesisMarkdown;
  // True only when the structured call failed AND prose was produced.
  const synthesisFallbackUsed = synthesis === null && synthesisMarkdown !== null;

  // --- Mechanical gates -----------------------------------------------------
  const gateResults: Record<string, GateResult> = runGates(
    pack.mechanicalGates,
    primary.content,
  );
  fs.writeFileSync(
    path.join(outDir, "gates.json"),
    JSON.stringify(
      Object.fromEntries(
        Object.entries(gateResults).map(([n, r]) => [n, { passed: r.passed, findings: r.findings }]),
      ),
      null,
      2,
    ),
    "utf-8",
  );
  if (!allGatesPassed(gateResults)) {
    log(
      "Mechanical gate failures: " +
        Object.entries(gateResults)
          .filter(([, r]) => !r.passed)
          .map(([n]) => n)
          .join(", "),
    );
  }

  // --- Integrity metrics (M6.2 / M6.3) --------------------------------------
  const agreementFlags = args.rigor.agreementStats
    ? twoSidedAgreementFlags(stage2.agreement)
    : null;
  const reviewsByPersona: Record<string, Record<string, unknown>[]> = {};
  for (const r of results) {
    if (r.review === null) continue;
    (reviewsByPersona[r.persona] ??= []).push(r.review);
  }
  const differentiation = personaDifferentiation(reviewsByPersona, {
    scoreDimensions: pack.scoreDimensions,
    unitField: pack.unitField,
    unitListField: pack.unitListField,
    unitScoreField: pack.unitScoreField,
    keywordRules: pack.unitKeywordRules,
    dimensionScales: pack.dimensionScales,
  });
  for (const overlap of differentiation) {
    if (overlap.decorative) {
      log(
        `PERSONA OVERLAP: ${overlap.personaA} and ${overlap.personaB} found ` +
          `${(overlap.overlap * 100).toFixed(0)}% the same things — one is decorative.`,
      );
    }
  }

  // --- Validation tasks (M6/§5.3) -------------------------------------------
  // Carry forward resolutions from a prior run of the same document.
  const priorTasks = readValidationTasks(outDir);
  const priorByClaim = new Map(priorTasks.map((t) => [t.claim.toLowerCase().trim(), t]));
  const validationTasks = collectValidationTasks(results).map((task) => {
    const prior = priorByClaim.get(task.claim.toLowerCase().trim());
    return prior && prior.status !== "open"
      ? { ...task, status: prior.status, resolution_note: prior.resolution_note }
      : task;
  });
  writeValidationTasks(outDir, validationTasks);

  // --- Held-out validation at rigorous (M6.4) -------------------------------
  let heldOutComparison: HeldOutComparison | null = null;
  if (args.rigor.heldOut && synthesis === null && synthesisFallbackUsed) {
    log(
      "SKIPPED held-out comparison: it diffs against the STRUCTURED synthesis, " +
        "which this run does not have (markdown fallback). Re-run with a " +
        "synthesizer that returns schema-valid JSON to get held-out validation.",
    );
  }
  if (args.rigor.heldOut && synthesis !== null) {
    verifyHeldOutExclusion({
      heldOutId: args.config.models.held_out.id,
      reviewerIds: reviewers.map((r) => r.id),
      synthesizerId: args.config.models.synthesizer.id,
      drafterId: args.config.models.drafter?.id ?? null,
    });
    const stage3Docs = assembleForStage3(entries, documents);
    const heldOutReview = await runStage3({
      client: injected.heldOutCallFn ? null : getClient(args.config.models.held_out.id),
      pack,
      systemPrompt: args.systemPrompt,
      stage3Documents: stage3Docs.length > 0 ? stage3Docs : [primary],
      temperature: args.config.models.held_out.temperature,
      onWarning: log,
      callFn: injected.heldOutCallFn,
    });
    if (heldOutReview !== null) {
      fs.writeFileSync(
        path.join(outDir, "held_out_validation.json"),
        JSON.stringify(heldOutReview, null, 2),
        "utf-8",
      );
      heldOutComparison = await compareHeldOut({
        heldOutReview,
        synthesis,
        pack,
        adjudicatorClient: injected.adjudicateFn
          ? null
          : getClient(args.config.models.synthesizer.id),
        onWarning: log,
        callFn: injected.adjudicateFn,
      });
      writeHeldOutTriage(outDir, heldOutComparison);
      synthesis["held_out_validator_status"] = heldOutComparison.status;
      recordHoldoutUse({
        ledgerPath: path.join(outDir, "holdout_ledger.yaml"),
        model: args.config.models.held_out.id,
        docSha256: primary.sha256,
        verdict: String(heldOutReview[pack.verdictField] ?? "unknown"),
        runDir: outDir,
        onWarning: log,
      });
    } else {
      log("Held-out validation failed — status stays not_yet_run");
    }
  }

  // --- Regressions (standard+) ----------------------------------------------
  let regressions: RegressionResult | null = null;
  if (args.rigor.regressions && synthesis === null && synthesisFallbackUsed) {
    log(
      "SKIPPED regression check: it tracks weaknesses from the STRUCTURED " +
        "synthesis, which this run does not have (markdown fallback). The " +
        "regression registry is left untouched rather than recorded wrong.",
    );
  }
  if (args.rigor.regressions && synthesis !== null) {
    const registryPath = path.join(outDir, "regressions.yaml");
    const registry = loadRegistry(registryPath);
    regressions = checkRegressions({
      synthesis,
      registry,
      runId,
      docSha256: primary.sha256,
      onWarning: log,
    });
    saveRegistry(
      updateRegistry({ registry, result: regressions, runId }),
      registryPath,
    );
    if (regressions.reappeared.length > 0) {
      log(
        `REGRESSIONS: ${regressions.reappeared.length} previously-resolved ` +
          `weakness(es) reappeared`,
      );
    }
  }

  // --- Ship check (blocking computed from RAW reviews in code) --------------
  const reviews = results.filter((r) => r.review !== null).map((r) => r.review!);
  const reviewPersonas = results.filter((r) => r.review !== null).map((r) => r.persona);
  const shipCheck = checkShipGates({
    synthesis,
    reviews,
    gateResults,
    pack,
    personas: reviewPersonas,
    synthesisFallbackUsed,
  });
  // M6 additions to the gate: unresolved validation tasks (rigorous) and
  // held-out sev-1 findings the panel missed entirely (rigorous).
  const extraReasons = [
    ...validationTaskShipReasons(validationTasks, {
      blockOnOpen: args.rigor.validationTasksBlock,
    }),
    ...(args.rigor.validationTasksBlock && heldOutComparison
      ? heldOutComparison.missedSevOne.map(
          (m) => `held-out validator found a severity-1 issue the panel missed: ${m}`,
        )
      : []),
  ];
  const finalCheck: ShipCheckResult = {
    ok: shipCheck.ok && extraReasons.length === 0,
    reasons: [...shipCheck.reasons, ...extraReasons],
    warnings: shipCheck.warnings,
    composite: shipCheck.composite,
    perDimension: shipCheck.perDimension,
  };

  // --- Persist synthesis + report + metadata --------------------------------
  if (synthesis !== null) {
    fs.writeFileSync(synthesisPath, JSON.stringify(synthesis, null, 2), "utf-8");
  }
  const report = generateSynthesisReport({
    synthesis: synthesis ?? {},
    synthesisMarkdown,
    // Agreement is computed in code, so it survives a failed structured call.
    agreement: stage2.agreement,
    shipCheck: finalCheck,
    personaCoverage: coverage,
    agreementFlags,
    coldRead,
    differentiation,
    heldOutComparison,
    validationTasks,
    panelWarnings,
    priorSynthesis,
  });
  fs.writeFileSync(path.join(outDir, "synthesis_report.md"), report, "utf-8");
  if (synthesisFallbackUsed) {
    log(
      "No synthesis.json written (unstructured fallback) — `quorable diff` " +
        "cannot compare this run against another, and `quorable handoff` has " +
        "no structured synthesis to freeze.",
    );
  }

  const metadata = {
    run_id: runId,
    timestamp: new Date().toISOString(),
    target: path.resolve(args.targetPath),
    pack: pack.name,
    rigor: args.config.rigor,
    council: args.config.council,
    config: {
      models: reviewers.map((r) => r.id),
      held_out_model: args.config.models.held_out.id,
      synthesizer: args.config.models.synthesizer.id,
      personas,
      runs_per_persona: runsPerPersona,
    },
    unit_discovery:
      discoveredMap && discoveredUnits
        ? { units: discoveredUnits.map((u) => u.name) }
        : null,
    hashes: {
      [pack.primaryDocName]: primary.sha256,
      system_prompt: sha256Text(args.systemPrompt),
      personas: Object.fromEntries(
        Object.entries(args.personaOverlays).map(([p, o]) => [p, sha256Text(o)]),
      ),
      documents: Object.fromEntries(
        Object.entries(documents).map(([name, d]) => [name, d.sha256]),
      ),
    },
    results_summary: {
      total: results.length,
      succeeded: results.filter((r) => r.validationOk).length,
      failed: results.filter((r) => !r.validationOk).length,
    },
    cost: {
      total_usd: Math.round(tracker.totalUsd * 10_000) / 10_000,
      threshold_usd: args.config.pipeline.cost_threshold,
      abort_multiplier: args.config.pipeline.cost_abort_multiplier,
    },
  };
  fs.writeFileSync(path.join(outDir, "run_metadata.yaml"), stringifyYaml(metadata), "utf-8");

  return finish({
    outDir,
    runId,
    shipCheck: finalCheck,
    synthesis,
    synthesisMarkdown,
    results,
    coldRead,
    validationTasks,
    differentiation,
    agreementFlags,
    heldOutComparison,
    regressions,
    totalCostUsd: tracker.totalUsd,
    aborted: false,
    abortReason: null,
    panelWarnings,
  });
}
