# From quorable to a general review CLI

*Research + build plan — 2026-08-12*

Companion to [`CONTRACT.md`](../CONTRACT.md) (the engine/pack contract) and
[`UNIFICATION_PLAN.md`](UNIFICATION_PLAN.md) (the 2026-07-27 survey that
decided to finish quorable rather than start over). This document answers a
narrower question: **what stands between quorable today and a CLI you can
point at any file, from anywhere, with a named council of personas?**

Decisions taken as given (2026-08-12):

- Generalize **quorable in place** — do not start a new repo.
- v1 supports **OpenRouter + Anthropic direct + OpenAI direct + local models**.
- Runs are **tiered**: `quick` / `standard` / `rigorous`.

---

## 1. What actually exists today

### 1.1 The family tree

```
the legal-argument reference implementation  (the reference implementation, 7,574 LOC, 24 GitHub issues — all closed)
  ├─→ a grant-proposal system-grant-agent  (grant_review, 3,473 LOC; adds a drafter,
  │     drops golden/regressions/diff)
  │     └─→ brad-jobsearch/negotiation-agent (negotiation_review; adds
  │           feedback auto-glob)
  └─→ quorable  (engine/pack split; 176 tests pass; never run live)
        └─ ideology/shorts-agent/  (first real pack; never run)
```

The three Python systems share roughly 85% of their code. The fork mechanism
is copy-paste, so fixes do not propagate — the reason quorable exists.

### 1.2 Is quorable using the same fundamentals?

Yes. Module-for-module, with the domain vocabulary lifted out into the Pack:

| Capability | Origin | In quorable |
|---|---|---|
| Async OpenRouter client, tenacity retries, `CostTracker` | legal `client.py` | copied verbatim (217 lines) |
| `validated_call`: fence-strip → sanitize → pydantic → 1 retry | legal `validation.py` | verbatim |
| Live pricing refresh + chars/4 estimation + cost governor | legal `costs.py` | verbatim |
| Stage-1 fan-out (model × persona × run), semaphore, run dirs | legal `pipeline.py` | genericized |
| Stage-2 cross-model synthesis | legal `synthesis.py` | genericized |
| **Fleiss' κ + ICC(1,1)** | legal `agreement.py` | **math verbatim**; vocabulary from Pack |
| Stage-3 held-out validation, exclusion checks, ledger | legal `held_out.py` | genericized |
| Golden seeded-defect recall + negative control | legal `golden.py` | genericized |
| Regression registry (fuzzy weakness matching) | legal `regressions.py` | genericized, `cause_of_action` → `unit` |
| Prompt-injection guard + `suspected_prompt_injection` field | legal `prompts.py` | verbatim |
| Draft / revise stage | grant `drafter.py` | rebuilt as `drafting.py` |
| **The draft→panel→synthesis→gates→revise loop** | *neither parent* | net-new `loop.py` |
| Mechanical gate framework | *neither parent* | net-new `gates.py` |
| Prediction ledger / handoff | *neither parent* | net-new `ledger.py` |

Legal-only modules (`citecheck`, `xref`, `filing`, `compliance`, `opposition`,
`simulate`) were dropped on the fork; the contract says packs reimplement them
as `Gate`s.

### 1.3 The scales

Scoring is entirely pack-defined and runs at two levels.

**Per-unit, per-dimension scores.** A "unit" is whatever the domain divides
the work into — a cause of action (legal), a rubric dimension (shorts), an act
or sequence (screenplay). Each reviewer returns a list of unit objects. Two
shapes are supported:

- *attribute style* (the legal parent): each unit object carries one numeric
  attribute per score dimension.
- *unit-major style* (`Pack.unit_score_field` set): each unit object carries
  its dimension name plus one numeric score.

The engine's score accessors handle both, so a pack picks whichever matches how
its domain thinks.

**Composite + gates.** `ShipGates` holds `composite_min`, `dimension_min`,
optional per-dimension `weights`, `composite_exclude_personas` (red-team
personas score low by design — pooling them would make the composite measure
harshness), and `blocking_findings(synthesis, reviews)`. That last one is the
product-truth guard: it is computed **in code from the raw reviews**, never
read from the synthesis model's output, so a synthesizer that quietly drops a
severity-1 finding cannot unblock a ship.

**Agreement statistics.** Fleiss' κ on the categorical verdict field, ICC(1,1)
per score dimension across reviewers. Computed in Python and *patched over*
whatever the synthesis LLM claimed. ICC below 0.4 marks a dimension "genuinely
contested" and surfaces it in the report rather than averaging it away.

### 1.4 How the evals actually run

Four independent mechanisms, none of which depend on the models grading
themselves:

1. **Golden set** (`golden.py`) — `golden/manifest.yaml` lists documents with
   *known* seeded defects plus one clean negative control. Each defect names a
   detector: a mechanical gate name (free, default) or an `llm_*` name that
   resolves to `prompts/<detector>.md` and only runs with `--live`. Missed
   defects or mechanical false positives on the control exit non-zero. This is
   the only ground-truth recall measurement in the system; the contract says to
   run it after *any* prompt, persona, or gate change.
2. **Held-out validator** (`held_out.py`) — one model excluded from Stages 1–2
   *in code*, cross-vendor by requirement, run once on the final draft. New
   issues it surfaces suggest the panel overfit. Every consultation is logged
   to `holdout_ledger.yaml` with exhaustion warnings.
3. **Regression registry** (`regressions.py`) — weaknesses from prior versions,
   fuzzy-matched at 0.85 similarity. A previously-resolved weakness that
   reappears is flagged loudly and hash-gated against the document version.
4. **Agreement statistics** — within-run: low κ/ICC means the panel does not
   agree, which is itself a finding.

**The gap:** nothing measures the reviews against *human* judgment.
`ledger.py` freezes a `predictions.yaml` row (composite, per-dimension,
per-persona verdict, hypothesis) at handoff time precisely so outcomes can be
joined back later — but it has never been run, so there is no calibration data.

### 1.5 Personas — already fully data-driven

A persona is a plain markdown file at `personas/<name>.md`, listed by name in
`config.yaml` under `personas:`. It is loaded as an overlay on top of the
shared `inputs/system_prompt.md`, prepended to the user message as `PERSONA
INSTRUCTIONS:`, and SHA-256 hashed into `run_metadata.yaml` for
reproducibility. No code, no registration.

12 real personas exist across the three systems (5 legal, 7 grant, 7 shorts
with overlap). They range from ~30 to ~60 lines: a lens, what the persona
owns, the analytical approach, and a temperament. The red-team rule from
a grant-proposal system is a house standard — *every attack must cite a location and
state what would neutralize it*.

This is the piece of the vision that is already done. Moving personas to
`~/.quorable/personas/` and grouping them into councils is file plumbing, not
architecture.

### 1.6 Model / provider configuration today

`config.yaml` names four roles — `reviewers[]` (a list, each with `id`,
`temperature`, `held_out`), `synthesizer`, `held_out`, `drafter` (optional).
All four go through one class, `OpenRouterClient`, with 8 call sites across the
engine. Pricing refreshes live from `https://openrouter.ai/api/v1/models`;
cost per call is read from OpenRouter's `usage.cost` field.

**Local models: not supported.** There is no base-URL override, no provider
field, no auth abstraction. `OPENROUTER_API_KEY` is required at client
construction or it raises.

---

## 2. Open GitHub issues

There are none, anywhere.

- **the legal-argument reference implementation** (`bradtaylorsf/the legal-argument reference implementation`) — 24 issues,
  **all closed**. They read as the original build order: schemas → parsers →
  manifest → client → validation → Stage 1 → parallelize → κ/ICC → Stage 2 →
  reports → Stage 3 → research → opposition → regressions → CLI → costs →
  diff → logging → live e2e → README.
- **a grant-proposal system-grant-agent** (`aging-navigator/...`) — 0 issues, ever.
- **quorable** — **not a git repository and has no remote.** Never committed.

The backlog is not in an issue tracker; it is in `CONTRACT.md` (the design
contract), `UNIFICATION_PLAN.md` (§3 target CLI design), and this document.

---

## 3. The gap between today and the vision

| You want | Today | Gap |
|---|---|---|
| Point at any file, get a review | Requires a project dir with `config.yaml` + `pack.py` | **Blocker 1** |
| No Python per domain | `pack.py` is Python; shorts' is 271 lines | **Blocker 1** |
| Context = just a folder | `inputs/manifest.yaml` hand-authored per doc, with tiers and `send_to` routing | **Blocker 2** |
| Run from anywhere | Everything resolves relative to a project's `config.yaml` | **Blocker 3** |
| Global personas + councils | Personas are per-project files; "council" does not exist | Small |
| `~/.quorable` config + keys | No global config; keys from env/`.env` only | Small |
| Output to `<filename>-reviewed/` | Output to `<project>/runs/run_<ts>/` | Small |
| Anthropic / OpenAI / local | OpenRouter only, hardcoded | **Blocker 4** |
| Substitute models when provider changes | No capability model, no validation | Medium |
| quick / standard / rigorous | Everything always on | Medium |
| Aggregated score, full report, traces | **Already there** | — |

The four blockers, in the order they must be solved:

**Blocker 1 — the pack is Python.** `Pack` requires two pydantic schema
*classes*. Every new domain is a code-authoring task. This is the single
biggest obstacle to "point it at anything."
*Fix:* a **generic pack** built from YAML. Dimensions, verdict categories,
units, and gates come from a rubric file; the review and synthesis pydantic
models are generated at load time with `pydantic.create_model`. `pack.py`
survives as an escape hatch for domains that genuinely need code (legal
cite-check gates), but 90% of use cases never see Python.

**Blocker 2 — the manifest.** `inputs/manifest.yaml` declares every document
with a path, role, tier, and `send_to` routing list. Powerful, and correct for
a legal filing with 20 exhibits. Fatal for "review this blog post."
*Fix:* auto-manifest. `--context <dir>` globs the directory into tier-2
entries routed to `stage1` by default; the target file becomes the tier-1
primary. A hand-written manifest still wins when present.

**Blocker 3 — project-dir gravity.** `load_config` resolves all eight path
fields relative to the config file. There is no notion of a global default.
*Fix:* config layering — packaged defaults → `~/.quorable/config.yaml` →
project `config.yaml` → env vars → CLI flags, later wins.

**Blocker 4 — one hardcoded provider.** Contained (8 call sites, one class),
but it touches cost accounting: OpenRouter *reports* cost in the response;
Anthropic and OpenAI report tokens only, so cost must be computed from a local
pricing table. The cost governor and every estimate depend on that number.

---

## 4. Build plan

### M0 — Put quorable under version control *(blocking, minutes)*

`git init`, commit, push. The engine has never been committed. Everything
below is unreviewable until this is done. Also: the loop's
`check_primary_committed` guard silently no-ops outside a git repo, so a core
safety property is currently off.

### M1 — Provider abstraction *(the largest single piece)*

- `Provider` protocol: `chat(model, messages, temperature, json_mode) ->
  NormalizedResponse{content, prompt_tokens, completion_tokens, cost_usd}`.
- Implementations: `openrouter` (existing code), `anthropic`, `openai`,
  `openai_compatible` (base-URL override — covers Ollama, LM Studio, vLLM,
  Together, Groq).
- Model ids become provider-qualified: `openrouter:x-ai/grok-4.3`,
  `anthropic:claude-opus-4.8`, `local:llama-3.3-70b`. A bare id keeps today's
  meaning for backward compatibility.
- Per-provider pricing tables so `cost_usd` is real for non-OpenRouter calls;
  local models price at zero.
- **Structured output differs per provider** — OpenRouter/OpenAI take
  `response_format: json_object`, Anthropic wants a tool definition or an
  assistant prefill, and local models often support neither reliably. The
  provider owns this; `validated_call`'s fence-strip + retry is the existing
  safety net and gets a third fallback (repair prompt) for weak local models.
- **Capability check + substitution.** On load, verify each configured model is
  reachable with the connected keys. When it is not, fail with a menu of
  same-role substitutes from a connected provider rather than a stack trace —
  this is the check you asked for.

*Risk to state plainly:* the agreement statistics assume **independent**
raters. Cross-vendor panels satisfy that; a panel of three local Llama variants
does not, and κ/ICC will read as high agreement when it is really shared blind
spots. The CLI should warn when a panel is single-vendor and refuse to report
held-out validation as meaningful when the held-out model shares a vendor with
a reviewer (the legal system already warns; make it louder).

### M2 — Global home `~/.quorable/`

```
~/.quorable/
  config.yaml          # default models per role, default council, default rigor
  providers.yaml       # which providers are connected (keys via keyring or env)
  personas/*.md        # the global persona library
  councils/*.yaml      # named persona sets + per-council model/rubric defaults
  rubrics/*.yaml       # reusable scoring rubrics (generic-pack input)
  packs/               # installed code packs (legal, grant, shorts)
  cache/pricing.json
```

Plus config layering (defaults → home → project → env → flags) and
`quorable config set/get`, `quorable providers add/list`.

*Decision needed:* keys in the OS keyring (safer, adds a dependency) versus
`~/.quorable/.env` with 600 perms (simpler, matches today).

### M3 — The generic pack *(the keystone)*

A rubric YAML becomes a working pack with no Python:

```yaml
# ~/.quorable/rubrics/blog-post.yaml
name: blog-post
units: [hook, argument, evidence, structure, close]
dimensions:
  clarity:      {weight: 1.0, scale: [1, 10]}
  originality:  {weight: 1.5, scale: [1, 10]}
  evidence:     {weight: 2.0, scale: [1, 10]}
verdict:
  field: publish_readiness
  categories: [ship, revise, rethink]
gates:
  - word_count: {max: 2000}
  - banned_elements: ["as an AI", "in today's fast-paced"]
ship:
  composite_min: 7.0
  dimension_min: 5
  blocking: severity_1_findings   # named built-in, not a lambda
```

`build_pack_from_rubric()` generates the review and synthesis pydantic models
via `create_model` and returns a real `Pack`. Everything downstream — agreement
math, gates, ship logic, reports, golden — is unchanged, because they all read
the Pack, not the schema.

This is what turns quorable from a framework into a tool.

### M4 — Zero-config invocation

```
quorable review <file-or-dir> [--context <dir>] [--council <name>]
                               [--rubric <name>] [--rigor quick|standard|rigorous]
                               [--out <dir>]
```

Behavior: no `config.yaml` needed. Target file becomes the primary doc,
`--context` globs into an auto-manifest, council resolves from
`~/.quorable/councils/`, output defaults to `<filename>-reviewed/` next to the
target — containing `raw_reviews/`, `synthesis.json`, `synthesis_report.md`,
`run_metadata.yaml`, `run.log`, `gates.json`, and the per-persona reports.

All of those artifacts are already produced; this milestone is routing and
defaults, not new machinery.

### M5 — Rigor tiers

| | quick | standard | rigorous |
|---|---|---|---|
| runs per persona | 1 | 2 | 2 |
| personas | council's top 3 | full council | full council |
| agreement stats | off | on | on |
| held-out validation | off | off | on |
| golden recall | off | off | on (pre-run) |
| regression registry | off | on | on |
| revise loop | off | 1 iteration | up to `max_iterations` |

Implementation is a config-overlay preset, not new code paths.

### M6 — Blind-spot integrity *(anti-Goodhart: make the eval audit itself)*

The panel's raters can be independent by vendor and still be **correlated by
prompt**: every reviewer receives the same system prompt, rubric, context
pack, and pre-declared dimensions. Nobody on the panel is empowered to say
"you're measuring the wrong thing," so a cross-vendor panel can show beautiful
κ while being uniformly blind in exactly the way the rubric is blind — and the
revise loop then optimizes the document toward that flawed scoring function.
The golden set inherits the same defect: seeded defects only measure recall on
failure modes the author already knew about.

Six countermeasures, ranked by value per unit of effort:

1. **The cold reader** — one reviewer per run that receives the document with
   *no rubric, no context pack, no persona overlay*: "you are the intended
   reader; react." Any finding it produces that maps to no rubric dimension is
   a **rubric gap** — the only signal in the system not conditioned on the
   author's priors. One extra call per run. Runs at every rigor tier.
2. **Two-sided agreement reporting** — today only `LOW_AGREEMENT_THRESHOLD =
   0.4` exists. Add a high-side flag: suspiciously uniform agreement (κ/ICC
   near-perfect across the board) is reported as a warning — it usually means
   redundant personas or correlated raters, not quality. Free (arithmetic on
   collected data).
3. **Persona differentiation score** — pairwise overlap of what each persona
   actually *found* (location + dimension coverage). Two personas above ~70%
   overlap ⇒ one is decorative; report it and suggest a rewrite or drop. Free.
4. **Escape rate + held-out teeth** — escape rate = novel held-out findings ÷
   total held-out findings, tracked across iterations. Rising escape rate
   alongside a rising composite = measurable overfitting. At `rigorous` tier, a
   severity-1 finding the panel missed entirely **blocks the ship** (today the
   held-out verdict is informational only). Also: ask the held-out model about
   the *diff* between first and final drafts ("what got worse?") — revision
   damage is currently unmeasured.
5. **Discrimination test in golden** — alongside seeded defects, include one
   known-bad real document (a demurred complaint, a rejected grant, a video
   that died at 20% retention) and one known-good. If the panel cannot separate
   them, the rubric is broken regardless of what κ says. This tests the eval
   itself, which recall testing structurally cannot.
6. **Outcome loop** — `quorable outcome <run-id> --result <what happened>`
   appends real-world results to the frozen `predictions.yaml` rows. Even n=10
   reveals whether the composite correlates with anything real. Only true
   ground truth in the system; already half-built; never run.

Items 1–3 are nearly free and change what the report says. 4–5 are the teeth.
6 is slow to pay off and is the only thing that can ever validate the whole
apparatus.

*Related warning (from M1):* κ/ICC assume independent raters. Warn loudly when
a panel is single-vendor; refuse to present held-out validation as meaningful
when the held-out model shares a vendor with a reviewer.

### M7 — Council management

`quorable persona new|list|show|edit`, `quorable council new|list|add|remove`,
`quorable council show <name>` (personas, default models, default rubric).
Ship 3–4 starter councils built from the 12 personas that already exist:
`legal-pleading`, `grant-proposal`, `screenplay`, `blog-post`.

### M8 — Input formats

PDF, markdown, and YAML parse today. Add `.docx` (the shorts pack is blocked on
exactly this — the world-bible is a docx), `.txt`, and `.fountain`/`.fdx` for
scripts. Directory-as-primary (chapters, multi-file docs) needs a concatenation
strategy with per-file provenance markers.

### M9 — Port the good ideas the forks have and the engine does not

- **Feedback auto-glob** (from the negotiation agent): `inputs/feedback/*.md`
  auto-loads as tier-1 and overrides older context. `UNIFICATION_PLAN.md` calls
  it the best single idea in any fork — it is how a conversational session
  steers the next run without editing config.
- **`quorable render <run-dir>`** — idempotent report re-render. The grant repo
  documents a defect where held-out status stays stuck at `not_yet_run`.
- **Manifest declared-vs-loaded assertion** — the grant repo silently skipped
  three critical documents in every committed run because a manifest section
  was never loaded. Fail loudly instead.

### M10 — Migrate and retire

Convert legal, grant, and shorts to packs on the unified engine; keep the legal
code pack (cite-check, xref) as the proof that the escape hatch works. Retire
the forks.

### Sequencing

M0 → M1 → M3 → M4 gets you a usable general CLI: point at a file, name a
council, get a scored report with traces. M2 can land alongside M1. M6 items
1–3 (cold reader, two-sided agreement, persona differentiation) are cheap
enough to land with M4 — they change what every report says. M5, M7, M8 are
quality-of-life; M6 items 4–6 land with M5's `rigorous` tier. M9 is cheap and
high-value. M10 is the payoff — one system instead of four.

If the goal is the shortest path to *proving the vision*, do M0, then a
hardcoded-OpenRouter M3+M4 first, and defer M1. Multi-provider is the bigger
job and the generic pack is the bigger risk — de-risk the unknown first.

---

## 5. Open questions

1. **Name.** ~~Rename now or keep quorable?~~ *Decided 2026-08-12: rename to
   a quorum-family name (a body of independent voices + a threshold that must
   be met to pass — exactly what `ShipGates` does). Final spelling pending
   registry availability; council stays the word for a persona set. Code
   rename happens once the name clears PyPI (primary — this is a Python
   package) and npm (defensive).*
2. **Key storage** — OS keyring vs. `~/.quorable/.env`.
3. **Calibration.** `predictions.yaml` exists to join predicted quality against
   real outcomes and has never been used. Is closing that loop in scope, or is
   the CLI's job to produce good reviews and leave calibration manual?
4. **Long documents.** The 200k-char cap holds a 115-page screenplay (~120k),
   but the revise stage cannot regenerate one in a single completion. Does the
   loop need unit-scoped revision (revise one act, keep the rest as context),
   or is review-only the answer for long work?
5. **Council-level model defaults.** Should a council pin its own models (a
   legal council always uses cross-vendor frontier models; a blog council uses
   cheap ones), or do models stay purely a config concern?
