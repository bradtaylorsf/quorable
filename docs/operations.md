# Operating quorable: cost, reliability, and known limits

Field notes from running real councils. Everything here is a property of
the engine, not of any one document — read it before you point quorable at
something expensive.

## Estimate before you run

```bash
node tools/estimate.mjs <target> --context <dir>
```

Zero API calls. It walks the same `autoManifest` → `prepareDocuments` →
`estimatePipelineCost` path the engine uses, so it agrees with the number
`quorable review` prints at the confirmation prompt.

Both cover the whole run: Stage-1 reviews (models × personas × runs × units),
the cold reader's two calls, and synthesis. Local and OpenAI-compatible models
price at $0.00.

**The one number neither can know is the unit count.** When the primary
exceeds `UNIT_DISCOVERY_THRESHOLD_CHARS` (60,000), a map pass splits it into
3–12 units and **every** job then runs once per unit — 24 review calls becomes
24 × *units*. `quorable review` runs the map pass before it estimates, so its
figure uses the real count and the confirmation prompt is accurate.
`tools/estimate.mjs` makes no API calls, so it assumes 7 units and says so.

Either way, crossing 60,000 characters multiplies the bill. Keeping the
primary under the threshold and routing long material in as `--context` is
still the cheapest lever you have.

## Holding the cost down

In descending order of effect:

1. **Keep the primary under 60,000 characters.** See above. Worth several×
   on its own — it is the difference between one call per job and one per
   job per unit.
2. **Keep the corpus tight.** Every tier-2 context document rides along on
   every Stage-1 call. Corpus chars × personas × models × runs is the whole
   input bill.
3. **Pick small models, and check the price rather than the name.** Names
   are a poor guide to cost; a "flash" tier from one vendor can be an order
   of magnitude above another vendor's.
4. **Rigor tiers are coarse.** `quick` is runs=1 but caps the council at
   three personas; `standard` is all personas but forces runs=2. There is no
   all-personas-at-runs=1 setting — `pipeline.runs_per_persona` is **not
   read** on the review path; the rigor preset supplies it.

Because `--rigor quick` silently keeps only the **first three** personas of
a council, order your councils so the three that catch the expensive defects
come first.

## Check the model table before you trust it

`MODEL_PRICING` in `ts/src/engine/costs.ts` is a static snapshot with a
verification date in the comments. It goes stale in both directions: prices
drift down, and models get **deprecated**, at which point every call returns
`HTTP 404`. Because failed calls become result rows rather than crashes, a
run against a retired model completes with part of the panel missing.

`refreshLivePricing()` corrects the *prices* at CLI time. It says nothing
about *availability*. Smoke-test every seat you have not used recently.

## On local seats

A local seat is free and counts as its own vendor bucket for the agreement
statistics, which is genuinely attractive. Measured against real work, it is
usually still the wrong trade.

Observed on a 39k-token payload: a mid-size local model passed a single
smoke test (schema-valid, $0, ~205s, three attempts) and then delivered
**2 of its 16 reviews** in the actual run — an 87% loss, failing after three
attempts over and over, mostly `Invalid JSON: No number after minus sign`
(it emits a bare `-` where a score belongs). It also added ~30 minutes of
wall clock.

Two lessons that generalise beyond that one model:

1. **One passing smoke test does not qualify a seat.** Schema compliance on
   a complex generated schema is probabilistic. A model at ~60% per-call
   success looks fine once and is useless across sixteen calls.
2. **Failure rows are safe but not free.** They never crash the run, which
   is correct — but the panel silently finishes short, and κ / ICC are then
   computed over an unbalanced rater set. **Always reconcile the raw review
   count against `models × personas × runs` before trusting the agreement
   numbers.**

When the cheap hosted tier costs cents for a full seat, a local seat saves
cents and costs reliability. Use local seats for privacy, not for economy.
If a local synthesizer cannot hold the JSON schema, see
`pipeline.synthesis_fallback` in the README.

## Writing rubric gates

**Gate patterns compile with JavaScript `new RegExp(p, "m")`.** Python's
inline-flag form `(?i)…` is **not** supported and throws a raw `SyntaxError`
at pack-load time. Spell case-insensitivity with character classes:
`[Ss]trip before sending`.

**⚠️ Use exactly ONE `banned_elements` entry per rubric.** `buildGates()`
names every one of them `banned_elements`, and `runGates()` collects results
into a `Record<string, GateResult>` keyed by that name — so a second entry
**silently overwrites the first**. No warning, no error, and `gates.json`
shows a single passing gate. The same collision applies to any repeated gate
type, including `term_lint` and unscoped `word_count`. Merge every pattern
into one list. Tracked as an issue.

**`quorable render` does not re-run gates.** It reads `gates.json` off disk
and recomputes only the ship verdict. After fixing a rubric's gates you must
re-run the review — rendering will not pick them up.

## Known limit: gates see the primary only

`runGates` runs against the primary document text. In a multi-document
package the other files are **not** gate-checked. Catch the rest with a grep
before the package leaves your hands, e.g.:

```bash
rg -n "INTERNAL|DRAFT|TBD|TODO|\[P\]" <run-dir>/
```
