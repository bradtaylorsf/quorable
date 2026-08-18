# quorable — engine/pack contract (v0.1)

quorable is a multi-model adversarial review-and-revision harness for writing,
extracted from `the legal-argument reference implementation` (the engine) and organized on the
`a grant-proposal system` context-map pattern (the content layout). It is
"Show Sidekick for writing": the harness ships as a CLI + Python library; each
**project** (a folder in a user repo) owns its domain — personas, rubric,
prompts, gates, golden set — and the engine stays domain-blind.

Consumers planned: `ideology/shorts-agent/` (first), then re-homing the legal
and grant systems as packs.

## The split

**Engine (this repo, `src/quorable/engine/`)** — forked from
`the legal-argument reference implementation`, genericized, never edited per-domain:

| Module | Origin | Change on fork |
|---|---|---|
| `client.py` | as-is | none (OpenRouter async client, tenacity retries, CostTracker) |
| `validation.py` | as-is | none (validated_call: fence-strip, sanitize, pydantic, 1 retry) |
| `costs.py` | as-is | none (live pricing refresh, chars/4 estimation) |
| `parsers.py` | genericized | `a domain-specific draft-name constant` → `pack.primary_doc_name`; keep never-truncate-primary rule |
| `manifest.py` | genericized | hardcoded legal section keys → free-form sections; keep `ManifestEntry`, tiers, `send_to` routing |
| `assembly.py` | as-is | doc-name comments only |
| `pipeline.py` | genericized | `classify_document_type` markers → `pack.doc_type_markers`; `_check_sac_committed` → `_check_primary_committed`; keep fan-out, semaphore, cost governor, run dirs |
| `reviewer.py` | genericized | metadata pulls primary-doc hash via pack name |
| `synthesis.py` | genericized | schema instruction from `pack.synthesis_schema`; persona-weighting text lives in project prompts |
| `agreement.py` | genericized | `SCORE_DIMENSIONS`/`RULING_CATEGORIES`/`_CAUSE_KEYWORD_RULES` → from pack; keep Fleiss' kappa + ICC math verbatim |
| `held_out.py` | genericized | `STAGE3_RECOMMENDED_DOCS` → pack; keep exclusion checks, cross-vendor warning, holdout ledger + exhaustion |
| `regressions.py` | genericized | `cause_of_action` key → `unit` (pack-defined grouping label) |
| `golden.py` | genericized | detector registry: mechanical detectors come from `pack.mechanical_gates` by gate name; `llm_*` detectors call pack-named prompts |
| `reports.py`, `diff.py` | genericized | render from pack schemas via shared field conventions (below) |
| `research.py`, `logging_config.py` | as-is | none |
| dropped | `citecheck.py`, `xref.py`, `filing.py`, `compliance.py`, `opposition.py`, `simulate.py` | legal-only; packs may reimplement as gates |

**New engine modules (net-new, no parent):**

- `drafting.py` — Stage-DRAFT/REVISE: one call to `models.drafter` with
  project prompt (`prompts/draft.md` / `prompts/revise.md`), canon/context docs
  via manifest routing (`send_to: [draft]`), returns the new primary-doc text.
  Reuses `validated_call` with a trivial `{"script": str}` wrapper or raw-text
  mode (drafts are prose, not JSON — support `json_mode=False`).
- `gates.py` — mechanical (non-LLM) gate framework. A gate is
  `Gate(name, fn)` where `fn(primary_text: str, project: Project) -> GateResult(passed, findings: list[str])`.
  Engine provides combinators + two batteries packs can instantiate:
  `word_count_gate(max_words, section=None)`, `term_lint_gate(canonical_terms: dict[str, list[str]])`
  (canonical spelling → known-bad aliases), `banned_elements_gate(patterns)`.
- `loop.py` — the orchestrator neither parent has:
  ```
  draft (or load existing) → panel (Stage 1 fan-out) → synthesis (Stage 2)
    → ship-gate check → if pass: stop(SHIPPABLE)
    → if iterations == max_iterations: stop(EXHAUSTED)
    → revise → re-run mechanical gates → loop
  ```
  Stop conditions, all mandatory in config: `ship_gates` pass; `max_iterations`
  (default 3); budget — reuse `CostTracker` + `CostAbortError`, threshold =
  `pipeline.cost_threshold` (this is a per-LOOP number, not per-call).
  Every iteration writes `runs/run_<ts>/iter_<n>/` with raw_reviews/,
  synthesis.json, script_v<n>.md. Held-out (Stage 3) stays OUTSIDE the loop —
  run once on the final script via `validate`, exactly like the parent.
- `ledger.py` — on `handoff`: freeze `predictions.yaml` row
  `{file_id, run_id, iteration_shipped, composite, per_dimension: {...}, per_persona_verdict: {...}, hypothesis, timestamp}`
  and emit handoff files to a pack-configured destination dir.

## The Pack object

A project's `config.yaml` gains one key: `pack: ./pack.py`. The engine loads it
with importlib (path relative to config) and reads module attribute `PACK`:

```python
from quorable.pack import Pack, ShipGates

PACK = Pack(
    name="shorts",
    review_schema=ShortReview,            # type[BaseModel] — Stage-1 output
    synthesis_schema=ShortSynthesis,      # type[BaseModel] — Stage-2 output
    score_dimensions=[...],               # ICC targets; must match schema fields
    verdict_field="predicted_retention_shape",   # Fleiss' kappa target
    verdict_categories=["cliff","slow_bleed","hold","hook_and_hold"],
    canonical_units=[...],                # canonical dimension names (parent: canonical_causes)
    unit_field="dimension",               # grouping key for regressions/agreement
    unit_list_field="dimension_scores",   # name of the per-unit list on the review schema
    unit_score_field="score",             # OPTIONAL. None (default) = parent-style: each unit
                                          # object has one numeric attribute PER score_dimension.
                                          # Set (e.g. "score") = unit-major style: each unit object
                                          # carries its dimension name in `unit_field` and a single
                                          # numeric `unit_score_field` — the spec-verbatim shorts
                                          # shape. Engine score/ICC accessors support both.
    primary_doc_name="script_draft",
    doc_type_markers={"script": [...], "brief": [...]},  # wrong-mode guard
    mechanical_gates=[...],               # list[Gate], run in Stage GATES + golden detectors
    ship_gates=ShipGates(
        composite_min=8.0,
        dimension_min=6,
        blocking_findings=lambda synthesis, reviews: [...],  # e.g. sev-1 from canon_guardian;
                                              # `reviews` = successful raw Stage-1 review objects, so
                                              # blocking gates are computed from ground truth in code,
                                              # never trusted to the synthesis LLM's copy-through
                                              # (same posture as agreement stats / priority_score)
        weights={...},                    # dimension → weight; None = unweighted
        composite_exclude_personas=[...], # personas excluded from composite AND dimension-floor
                                          # statistics (red-team personas score low by design;
                                          # their findings and blocking gates still count)
    ),
    drafter_enabled=True,                 # False ⇒ review-only domain (legal/grant mode): `run` is single-pass
    held_out_recommended_docs=[...],
)
```

Field-name conventions the engine's reports/diff rely on (packs must honor):
Stage-1 schema has `persona: str`, `model_id: str`, `findings: list[...]` with
`severity: int` + `suggested_fix: str`; per-dimension scores live in a list of
objects with `dimension`/`score`/`rationale`. Synthesis schema has
`consensus_weaknesses`, `contested_issues`, `ranked_fixes` (with
`priority_score` recomputed in code as `(impact² × consensus)/(1+ease)`),
`inter_rater_agreement`, `held_out_validator_status` — same names as parent.

Everything else is project data, not code: `personas/*.md` (plain overlay
prose, parent format), `prompts/*.md`, `context/00_*.md` numbered context map,
`golden/` corpus + manifest, `inputs` manifest, models/weights/thresholds in
`config.yaml`.

## CLI (typer app `quorable`, operates on cwd or `--project`)

```
quorable init                 # scaffold a project: config.yaml, context/, personas/, prompts/, golden/, briefs/
quorable ingest               # parse manifest docs, print table (parent behavior)
quorable cost-estimate        # per-loop estimate incl. drafter calls; MUST be run before first real `run`
quorable run [BRIEF] [--max-iter N --budget X --confirm --no-draft]
                               # full loop; --no-draft or drafter_enabled=False ⇒ single-pass parent behavior
quorable panel [SCRIPT]       # Stage 1+2 only on an existing draft (human-written review mode)
quorable validate --run-dir   # Stage 3 held-out, parent behavior + ledger
quorable golden [--live]      # seeded-defect recall, exit non-zero on miss
quorable diff A B             # cross-run comparison
quorable handoff RUN          # emit deliverables + freeze predictions.yaml
```

Makefile in each project wraps these, parent-style (`run-ask`, `run-persona P=`, …).

## Non-negotiables carried from the parents

- Committed-primary-doc guard before any run (git porcelain check).
- Held-out model excluded from Stages 1–2 **in code**, cross-vendor warning,
  consultation ledger with exhaustion warnings.
- Agreement statistics computed in Python and patched over LLM output.
- Cost governor checks before and inside the semaphore; abort, don't degrade.
- Failures become result rows, never crashes; persona dropout surfaced loudly.
- Golden recall run after ANY prompt/persona/gate change; negative control
  false-positives fail the command.
- The red-team persona rule (verbatim from a grant-proposal system): every attack must
  cite a location and state what would neutralize it.
- The product-truth guard generalizes: each pack names a truth source (canon,
  case context, product spec); drift from it is severity-1 regardless of how
  good the drifted version reads. In the loop this is a `blocking_findings`
  ship-gate, never an averaged score.

## Stage-2 synthesis fallback (TS-only)

`pipeline.synthesis_fallback: none | markdown` (default `none`).

When the SYNTHESIZER returns no schema-valid JSON, `markdown` makes one
further **unvalidated** call asking for prose under fixed headings, and the
report carries it under `## Synthesis (unstructured fallback)`. This exists
because weak local synthesizers routinely fail strict JSON on a call whose
input is every Stage-1 review at once.

It costs nothing in integrity, and the reason is structural: **scores, gates
and agreement statistics never come from synthesis.** `checkShipGates`
computes from the raw reviews via `computeScores`, mechanical gates run
against the document text, and agreement is computed in code and patched
over the LLM output. Synthesis is the narrative layer only.

Rules that hold on this path:

- **Stage 1 is never relaxed.** Reviews stay strict JSON. Every score, gate
  and statistic derives from them; that is the guarantee the tool rests on.
- The prose is never parsed, and the model is instructed to emit no numbers,
  because any it produced would contradict the computed ones.
- `synthesis` stays `null` — no partial object is fabricated.
- `synthesis.json` is not written. Held-out comparison and the regression
  check keep their `synthesis !== null` guards and warn when skipped;
  `quorable diff` fails with an explanation rather than a missing-file crash.
- "no synthesis output" stops being a blocking ship reason (humans did get a
  report) and becomes a `ShipCheckResult.warnings` entry, stated plainly in
  the report. With the fallback off, or when the fallback call itself fails,
  it remains blocking exactly as before.

**This is TS-only.** The Python engine (`src/quorable/engine/loop.py:185`)
keeps the original unconditional `"no synthesis output"` reason. Python is
the executable spec for *numeric* behaviour — the parity fixtures pin κ, ICC,
composites and gate results — and this feature adds no arithmetic. It is an
operational affordance for the shipping TS CLI's local-model path, so
duplicating it in the spec would add divergence surface for no parity value.
If Python ever ships again, port it then.

## Testing

Port the parent's test layout (`tests/test_<module>.py`, fixtures dir, no-network
unit tests + `test_live_e2e.py` gated behind an env var). Engine tests use a
minimal `tests/fixtures/toy_pack/` (tiny schema, 2 personas, fake docs) so the
engine is tested pack-independently. Python ≥3.11, pydantic v2, typer, httpx,
tenacity, uv-managed.
