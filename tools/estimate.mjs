/**
 * Pre-run cost estimate for a quorable review — ZERO API calls.
 *
 * Reproduces exactly what runReview() computes and logs before it spends
 * anything: same autoManifest, same prepareDocuments, same
 * estimatePipelineCost. Adds the cold-reader call, which the engine's own
 * estimate omits (it is not in estimatePipelineCost).
 *
 * Usage: node estimate.mjs <target> [--context dir]... [--council name]
 *                          [--rigor tier] [--model id]...
 */
import path from "node:path";

import { fileURLToPath } from "node:url";
const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");
const { resolveContext } = await import(`${DIST}/cli/context.js`);
const { autoManifest } = await import(`${DIST}/engine/manifest.js`);
const { prepareDocuments } = await import(`${DIST}/engine/parsers.js`);
const { assembleForPersona } = await import(`${DIST}/engine/assembly.js`);
const { buildJobList } = await import(`${DIST}/engine/pipeline.js`);
const {
  estimatePipelineCost,
  estimatePerLoopUsd,
  modelEstimateTotal,
  getPricing,
  tokenCost,
  refreshLivePricing,
  CHARS_PER_TOKEN,
  ESTIMATED_OUTPUT_TOKENS_STAGE1,
} = await import(`${DIST}/engine/costs.js`);
const { activeReviewers } = await import(`${DIST}/config/schema.js`);
const { UNIT_DISCOVERY_THRESHOLD_CHARS } = await import(`${DIST}/engine/unitDiscovery.js`);

// --- args -------------------------------------------------------------------
const argv = process.argv.slice(2);
const target = path.resolve(argv[0]);
const contextDirs = [];
const models = [];
let council, rigor;
for (let i = 1; i < argv.length; i++) {
  if (argv[i] === "--context") contextDirs.push(path.resolve(argv[++i]));
  else if (argv[i] === "--council") council = argv[++i];
  else if (argv[i] === "--rigor") rigor = argv[++i];
  else if (argv[i] === "--model") models.push(argv[++i]);
}

const ctx = resolveContext(target, { council, rigor, models });
const live = await refreshLivePricing(
  [...ctx.config.models.reviewers.map((r) => r.id), ctx.config.models.synthesizer.id]
    .filter((s) => !s.includes(":")),
).catch(() => false);

// --- documents (identical to runReview) -------------------------------------
const entries = autoManifest(target, contextDirs, { primaryName: ctx.pack.primaryDocName });
const documents = await prepareDocuments(entries, { primaryDocName: null, onWarning: () => {} });
const primary = documents[ctx.pack.primaryDocName];

const personas =
  ctx.rigor.personaLimit !== null ? ctx.personas.slice(0, ctx.rigor.personaLimit) : ctx.personas;
const reviewers = activeReviewers(ctx.config).filter((r) => r.id !== ctx.config.models.held_out.id);
const jobs = buildJobList({
  reviewers,
  heldOutId: ctx.config.models.held_out.id,
  personas,
  runsPerPersona: ctx.rigor.runsPerPersona,
});

const personaDocs = {};
for (const p of personas) personaDocs[p] = assembleForPersona(p, entries, documents);

const estimate = estimatePipelineCost({
  reviewerIds: reviewers.map((r) => r.id),
  synthesizerId: ctx.config.models.synthesizer.id,
  drafterId: null,
  runsPerPersona: ctx.rigor.runsPerPersona,
  personas,
  personaDocChars: (p) => (personaDocs[p] ?? []).map((d) => d.charCount),
  allDocChars: Object.values(documents).map((d) => d.charCount),
  systemPromptChars: ctx.prompts.system.length,
  personaOverlayChars: Object.fromEntries(
    Object.entries(ctx.personaOverlays).map(([p, o]) => [p, o.length]),
  ),
  includeDrafter: false,
  iterations: 1,
});

// --- corrections the engine's own estimate does not make --------------------
// BUG 1: getPricing() has no case for local/openai_compatible specs, so they
//        fall through to DEFAULT_PRICING ($1/$5). The cost TRACKER is correct
//        (recordCall uses response.costUsd, measured $0), so this inflates the
//        estimate only — conservative, but it can trip confirmCost falsely.
const isLocal = (id) => /^(local|openai[-_]compatible):/i.test(id);
for (const m of estimate.modelEstimates) {
  if (isLocal(m.modelId)) {
    m.inputCostUsd = 0;
    m.outputCostUsd = 0;
  }
}
// BUG 2: when the primary exceeds UNIT_DISCOVERY_THRESHOLD_CHARS, runReview
//        fans every job out across the discovered units (jobs x units) but
//        computes the estimate from `jobs` alone. The printed estimate is then
//        low by the unit count. This is what made the 2026-08-16 pulse cost
//        $18.61 against a 9-call estimate.
const willFanOut = primary.charCount > UNIT_DISCOVERY_THRESHOLD_CHARS;
const ASSUMED_UNITS = 7; // map pass picks 3-12; the pulse got 7

// --- cold reader: real cost, absent from estimatePipelineCost ---------------
const [cIn, cOut] = getPricing(ctx.config.models.synthesizer.id);
const coldInTok = Math.floor((primary.charCount + ctx.prompts.coldReader.length + 2000) / CHARS_PER_TOKEN);
const coldUsd = tokenCost(coldInTok, cIn) + tokenCost(3000, cOut);

// --- report -----------------------------------------------------------------
const f = (n, w = 10) => `$${n.toFixed(4)}`.padStart(w);
const engineTotal = estimatePerLoopUsd(estimate);

console.log(`\nquorable — PRE-RUN COST ESTIMATE  (no API calls made)`);
console.log("=".repeat(78));
console.log(`target      ${path.relative(process.cwd(), target)}`);
console.log(`council     ${ctx.council.name}   rubric: ${ctx.pack.name}   rigor: ${ctx.config.rigor}`);
console.log(`pricing     ${live ? "live from OpenRouter" : "static table (live fetch failed)"}`);
console.log("");

console.log("CORPUS");
console.log("-".repeat(78));
let corpusChars = 0;
for (const [name, d] of Object.entries(documents)) {
  const tier = entries.find((e) => e.name === name)?.tier;
  corpusChars += d.charCount;
  console.log(
    `  t${tier}  ${name.padEnd(34)} ${d.charCount.toLocaleString().padStart(9)} ch  ` +
      `~${Math.round(d.charCount / CHARS_PER_TOKEN / 1000)}k tok`,
  );
}
console.log(
  `      ${"TOTAL PER STAGE-1 CALL".padEnd(34)} ${corpusChars.toLocaleString().padStart(9)} ch  ` +
    `~${Math.round(corpusChars / CHARS_PER_TOKEN / 1000)}k tok`,
);
console.log(
  `  primary ${primary.charCount.toLocaleString()} ch vs unit-discovery threshold ` +
    `${UNIT_DISCOVERY_THRESHOLD_CHARS.toLocaleString()} ch → ` +
    (willFanOut
      ? `MAP PASS FIRES — every job fans out x~${ASSUMED_UNITS} units  ** COST MULTIPLIER **`
      : `no map pass, 1 call per (model, persona, run)`),
);
console.log("");

console.log(`PANEL   ${reviewers.length} models x ${personas.length} personas x ${ctx.rigor.runsPerPersona} run(s) = ${jobs.length} stage-1 calls`);
console.log("-".repeat(78));
console.log(`  ${"model".padEnd(30)} ${"calls".padStart(5)} ${"in/call".padStart(9)} ${"in $".padStart(9)} ${"out $".padStart(9)} ${"total".padStart(10)}`);
for (const m of estimate.modelEstimates) {
  const [pi, po] = getPricing(m.modelId);
  const label = m.numCalls === 1 && m.modelId === ctx.config.models.synthesizer.id ? " (synthesis)" : "";
  console.log(
    `  ${(m.modelId + label).padEnd(30)} ${String(m.numCalls).padStart(5)} ` +
      `${(Math.round(m.inputTokensPerCall / 1000) + "k").padStart(9)} ` +
      `${f(m.inputCostUsd, 9)} ${f(m.outputCostUsd, 9)} ${f(modelEstimateTotal(m))}   [$${pi}/$${po} per 1M]`,
  );
}
console.log(`  ${"cold reader (+1 call)".padEnd(30)} ${String(1).padStart(5)} ${(Math.round(coldInTok / 1000) + "k").padStart(9)} ${"".padStart(9)} ${"".padStart(9)} ${f(coldUsd)}`);
console.log("-".repeat(78));
console.log(`  ${"engine estimate".padEnd(30)} ${String(jobs.length + 1).padStart(5)} ${"".padStart(29)} ${f(engineTotal)}`);
console.log(`  ${"+ cold reader".padEnd(30)} ${String(1).padStart(5)} ${"".padStart(29)} ${f(coldUsd)}`);
const base = engineTotal + coldUsd;
console.log(`  ${"TOTAL PER RUN".padEnd(30)} ${String(jobs.length + 2).padStart(5)} ${"".padStart(29)} ${f(base)}`);
if (willFanOut) {
  const stage1 = estimate.modelEstimates
    .filter((m) => m.numCalls > 1)
    .reduce((a, m) => a + modelEstimateTotal(m), 0);
  const fanned = base + stage1 * (ASSUMED_UNITS - 1);
  console.log("");
  console.log(`  ** UNIT FAN-OUT NOT IN THE ENGINE ESTIMATE ABOVE **`);
  console.log(
    `  ${"REAL TOTAL (x" + ASSUMED_UNITS + " units)"} ≈ ${f(fanned)} across ` +
      `~${jobs.length * ASSUMED_UNITS + 3} calls — retarget a smaller primary.`,
  );
}
console.log("");
console.log(
  `  governor: aborts at $${(ctx.config.pipeline.cost_threshold * ctx.config.pipeline.cost_abort_multiplier).toFixed(2)} ` +
    `(cost_threshold ${ctx.config.pipeline.cost_threshold} x ${ctx.config.pipeline.cost_abort_multiplier})`,
);
console.log(
  `  assumption: ${ESTIMATED_OUTPUT_TOKENS_STAGE1} output tokens/review. ` +
    `Output is the estimate's only soft number.`,
);
console.log("");
