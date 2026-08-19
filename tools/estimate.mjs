/**
 * Pre-run cost estimate for a quorable review — ZERO API calls.
 *
 * Reproduces exactly what runReview() computes and logs before it spends
 * anything: same autoManifest, same prepareDocuments, same
 * estimatePipelineCost, same cold-reader and unit-fan-out terms.
 *
 * The one thing it cannot know without spending money is how many units the
 * map pass will discover on a long document, so it assumes ASSUMED_UNITS.
 * The engine uses the real count.
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

// A long primary triggers the map pass, after which every job runs once per
// discovered unit. The real count needs an API call; the map pass picks 3-12.
const willFanOut = primary.charCount > UNIT_DISCOVERY_THRESHOLD_CHARS;
const ASSUMED_UNITS = 7;

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
  endpoints: Object.keys(ctx.providerSettings?.endpoints ?? {}),
  coldRead: { promptChars: primary.charCount + ctx.prompts.coldReader.length + 2000 },
  unitFanOut: willFanOut
    ? {
        unitCount: ASSUMED_UNITS,
        // Each unit call drops the primary and carries one unit's payload:
        // the unit text plus a whole-document summary and neighbour synopses.
        perUnitDocChars: (p) => [
          ...(personaDocs[p] ?? [])
            .filter((d) => d.name !== ctx.pack.primaryDocName)
            .map((d) => d.charCount),
          Math.ceil(primary.charCount / ASSUMED_UNITS) + 4000,
        ],
      }
    : null,
});

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
// Push order is: one entry per reviewer, then cold read, cold map, synthesis.
// Label positionally — several of them share the synthesizer's model id.
const endpointNames = Object.keys(ctx.providerSettings?.endpoints ?? {});
const tailLabels = [" (cold read)", " (cold map)", " (synthesis)"];
for (const [i, m] of estimate.modelEstimates.entries()) {
  const [pi, po] = getPricing(m.modelId, endpointNames);
  const label = i >= reviewers.length ? (tailLabels[i - reviewers.length] ?? "") : "";
  console.log(
    `  ${(m.modelId + label).padEnd(30)} ${String(m.numCalls).padStart(5)} ` +
      `${(Math.round(m.inputTokensPerCall / 1000) + "k").padStart(9)} ` +
      `${f(m.inputCostUsd, 9)} ${f(m.outputCostUsd, 9)} ${f(modelEstimateTotal(m))}   [$${pi}/$${po} per 1M]`,
  );
}
console.log("-".repeat(78));
const totalCalls = estimate.modelEstimates.reduce((a, m) => a + m.numCalls, 0);
console.log(`  ${"TOTAL PER RUN".padEnd(30)} ${String(totalCalls).padStart(5)} ${"".padStart(29)} ${f(engineTotal)}`);
if (willFanOut) {
  console.log("");
  console.log(
    `  ** MAP PASS FIRES ** the figure above assumes ${ASSUMED_UNITS} units; the real ` +
      `count is 3-12,\n  so the true cost scales with it. Retargeting a smaller ` +
      `primary is the cheapest lever.`,
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
