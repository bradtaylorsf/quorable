# quorable

Multi-model adversarial review councils for any document. Point it at a
file; a council of independent critical personas — each running on multiple
models across vendors — reviews it, a synthesis stage merges the reviews
without averaging away disagreement, and you get a scored report with
honest inter-rater agreement statistics, mechanical gates, and a ship / no-
ship verdict computed in code, never trusted to a model.

```bash
npx quorable review draft.md
```

That is the whole quick start. On first run quorable asks for an OpenRouter
key (one key, every vendor — stored in `~/.quorable/.env`, chmod 600), lets
you pick a council interactively, estimates the cost, and writes everything
to `draft-reviewed/` next to the file.

## Why councils

A single model reviewing a document tells you what one model thinks. A
council gives you:

- **Independent lenses.** Each persona (a plain markdown file) owns one
  kind of failure: the skeptical expert attacks claims, the structural
  editor attacks the outline, the red team writes the takedown before the
  internet does.
- **Cross-vendor honesty.** Every persona runs on multiple models from
  different vendors. Fleiss' κ and ICC(1,1) are computed in code and
  patched over anything a model claims; low agreement is reported as
  "genuinely contested", suspiciously uniform agreement is flagged too
  (it usually means redundant personas, not quality).
- **A verdict you can't sweet-talk.** Blocking findings are computed from
  the raw reviews — a synthesis model that quietly drops a severity-1
  finding cannot unblock a ship. The cost governor aborts rather than
  degrades. Failures become result rows, never crashes.

## The blind-spot machinery

Every review also audits itself:

- **Cold reader** (every tier): one reviewer gets the document with *no
  rubric, no persona* — "you are the intended reader; react." Reactions
  that map to no rubric dimension are reported as **rubric gaps**: things
  your scoring system cannot see.
- **Persona differentiation:** if two personas keep finding the same
  things, one is decorative — the report says so.
- **Held-out validation** (`--rigor rigorous`): a model excluded from the
  panel *in code* reviews the final document. Its **escape rate** measures
  what the panel missed; a severity-1 finding the panel missed entirely
  blocks the ship.
- **Validation tasks:** when a reviewer asserts something it could not
  verify ("this contradicts the canon doc"), the claim lands in
  `validation_tasks.json` for a human or calling agent to resolve —
  *checked* and *asserted* are never laundered together. Open tasks block
  shipping at the rigorous tier.
- **Golden sets + discrimination test:** seed known defects and a clean
  control (`quorable golden`); optionally add a real accepted and a real
  rejected document — if the rubric can't tell them apart, the rubric is
  broken regardless of what κ says.
- **Outcome ledger:** `quorable handoff` freezes a write-once prediction
  row; `quorable outcome <run-id> --result "..."` joins what actually
  happened. The only true ground truth in the system.

## Commands

```
quorable review <file|dir>    # the main event (interactive picker on a TTY)
    --council <name>          # blog-post | grant-proposal | screenplay |
                              # legal-pleading | general-doc (default) | yours
    --rigor quick|standard|rigorous
    --context <dir>           # glob a folder of reference docs into the review
    --persona <name> --model <id> --out <dir> --yes --save

quorable panel <file>         # panel + synthesis only, no ship verdict
quorable validate <run-dir>   # held-out validation on an existing run
quorable golden [--dir d]     # seeded-defect recall; non-zero exit on miss
quorable render <run-dir>     # re-evaluate gates after resolving validation tasks
quorable diff <run-a> <run-b> # what changed between two runs
quorable handoff <run-dir>    # freeze the prediction row + emit deliverables
quorable outcome <run-id> --result "..."   # record what actually happened

quorable keys set|list|delete            # provider keys (~/.quorable/.env, 600)
quorable persona list|show|new           # the persona library
quorable council list|show|new|add|remove
quorable init                            # scaffold a project quorable.yaml

quorable config show                     # effective config + which layers set it
quorable config get|set|unset <key>      # edit a layer (--project for this repo)
quorable config models <ids...>          # set the reviewer panel
quorable config endpoint add|list|remove # named OpenAI-compatible endpoints
quorable config profile list|use|show    # pick one backend per job
```

Model ids are provider-qualified: `openrouter:x-ai/grok-4.3` (bare ids mean
OpenRouter), `anthropic:claude-…`, `openai:gpt-…`, `local:llama-3.3-70b`
(the built-in `providers.local_base_url` endpoint), or `<endpoint>:<model>`
for anything you name yourself. An unrecognized prefix is an error, never a
silent fallthrough to a paid OpenRouter call.

## Configuration

Layered, later wins:

```
packaged defaults → ~/.quorable/config.yaml → ./quorable.yaml (nearest
ancestor, else nearest to the cwd) → env → flags
```

`quorable config show` prints the result and the file behind each layer.
Env overrides: `QUORABLE_COUNCIL`, `QUORABLE_RUBRIC`, `QUORABLE_RIGOR`,
`QUORABLE_MODELS` (comma-separated), `QUORABLE_SYNTHESIZER`,
`QUORABLE_HELD_OUT`, `QUORABLE_LOCAL_BASE_URL`, `QUORABLE_PROFILE`,
`QUORABLE_CONFIG` (an explicit config path, same as `--config`).

### Local and other providers

Name any OpenAI-compatible endpoint and address it as a model prefix. This
covers local servers (Ollama, LM Studio, llama.cpp, vLLM) and hosted APIs
(Together, Groq, Fireworks, DeepSeek) with no code change:

```yaml
providers:
  endpoints:
    lmstudio:
      base_url: http://localhost:1234/v1
      vendor_from_model_id: true        # ids look like google/gemma-4-26b
    ollama:
      base_url: http://localhost:11434/v1
    together:
      base_url: https://api.together.xyz/v1
      api_key_env: TOGETHER_API_KEY     # process env, then ~/.quorable/.env
      vendor_from_model_id: true

models:
  reviewers:
    - id: lmstudio:google/gemma-4-26b-a4b
    - id: lmstudio:openai/gpt-oss-20b
    - id: lmstudio:qwen/qwen3.5-9b
```

Or from the CLI, which validates before it writes:

```bash
quorable config endpoint add lmstudio http://localhost:1234/v1 --vendor-from-model-id
quorable config models lmstudio:google/gemma-4-26b-a4b lmstudio:qwen/qwen3.5-9b
```

Local models are free, and the pre-run estimate prices them at $0.00 rather
than at the default hosted rate.

**Vendor buckets are the honesty mechanism.** κ/ICC assume independent
raters, so local models default to ONE shared `local` bucket — self-hosted
variants of the same family share blind spots, and a panel of them would
report high agreement that is really correlated error. When your local
models genuinely are different weight families, say so explicitly, either
per endpoint (`vendor_from_model_id`) or per model:

```yaml
models:
  reviewers:
    - {id: ollama:qwen2.5:latest, vendor: qwen}
    - {id: ollama:llama3.3:70b,   vendor: meta}
```

The panel still warns loudly when reviewers collapse to one vendor, or when
the held-out model shares a vendor with any reviewer.

### Profiles: one backend per job

Two local servers on one machine compete for the same memory and evict each
other's models mid-run — which shows up as `HTTP 400: Model unloaded` and a
panel that silently thins out. So a job picks **one** backend:

```yaml
profile: lmstudio          # the active one

profiles:
  lmstudio:
    providers:
      endpoints:
        lmstudio: {base_url: "http://localhost:1234/v1", vendor_from_model_id: true}
    models:
      reviewers:
        - id: lmstudio:google/gemma-4-26b-a4b
        - id: lmstudio:openai/gpt-oss-20b
        - id: lmstudio:qwen/qwen3.5-9b
      synthesizer: {id: lmstudio:google/gemma-4-26b-a4b}
  ollama:
    providers:
      endpoints:
        ollama: {base_url: "http://localhost:11434/v1"}
    models:
      reviewers: [{id: "ollama:qwen2.5:latest"}]
      synthesizer: {id: "ollama:qwen2.5:latest"}
```

```bash
quorable config profile list          # which exist, which is active
quorable config profile use ollama    # switch globally
quorable config profile use ollama --project   # ...or for this project only
quorable review draft.md --profile ollama      # ...or just this run
```

Only the active profile's endpoints are defined, so a stray `ollama:` model id
cannot resolve while `lmstudio` is active — it fails with a named error rather
than quietly reaching a server the rest of the run isn't using. If you define
both backends at the top level instead of in profiles, a run whose models
straddle two localhost endpoints warns.

A profile is a plain partial config, so it can carry anything — rigor,
pipeline settings, councils — not just models. A layer's own explicit keys
still beat the profile it selected.

### When a local synthesizer can't do strict JSON

Stage 2 hands the synthesizer every Stage-1 review at once and demands
schema-valid JSON back. Small local models often fail that call even when
they review perfectly well. By default the run then has no narrative:

```yaml
pipeline:
  synthesis_fallback: markdown   # default: none
```

With `markdown`, one further unvalidated call asks for prose under fixed
headings, and the report carries it under `## Synthesis (unstructured
fallback)`.

This is safe because **synthesis never produces a number**. Scores, gates and
agreement statistics are computed in code from the raw Stage-1 reviews, and
reviewer-stage validation stays strict — it is never relaxed by this setting.
What you give up on the fallback path is the structured artifact: no
`synthesis.json`, so held-out comparison and the regression check are skipped
(with a warning), and `quorable diff` cannot compare that run. The report
states plainly that its narrative is unstructured.

### Per-project overrides

`quorable.yaml` (or `.quorable.yaml`) in the document's directory or any
ancestor overrides your global defaults for that project only — cheap local
models by default, frontier models where the stakes justify them:

```yaml
# ~/clients/acme/quorable.yaml — this project pays for the good models
models:
  reviewers:
    - id: anthropic/claude-sonnet-4.6
    - id: openai/gpt-5.4
    - id: google/gemini-3.5-flash
  synthesizer: {id: anthropic/claude-sonnet-4.6, temperature: 0.1}
rigor: rigorous
```

`--config <path>` points at a config file directly, bypassing discovery.

Councils name **personas only**; models stay a config concern. A rubric is
a YAML file — dimensions, scales, weights, verdict categories, mechanical
gates, ship thresholds — and becomes a working pack with no code:

```yaml
# ~/.quorable/rubrics/my-newsletter.yaml
name: my-newsletter
units: [hook, argument, evidence, close]
dimensions:
  clarity:  {weight: 1.0, scale: [1, 10]}
  evidence: {weight: 2.0, scale: [1, 10]}
verdict: {field: publish_readiness, categories: [ship, revise, rethink]}
gates:
  - word_count: {max: 1200}
  - banned_elements: ["as an AI"]
ship:
  composite_min: 7.0
  dimension_min: 5
  blocking: severity_1_findings
  composite_exclude_personas: [red_team]   # red team scores low BY DESIGN
```

Long documents are handled by runtime unit discovery: a map pass finds the
acts/chapters, each persona reviews unit-by-unit with the global summary
and neighboring synopses in context, and scores land per-unit exactly as
for short documents.

## Outputs

`<filename>-reviewed/` contains `synthesis_report.md` (the human report),
`synthesis.json`, `raw_reviews/` (every individual review — the traces),
`validation_tasks.json`, `cold_read.json`, `gates.json`,
`run_metadata.yaml` (hashes of everything for reproducibility), `run.log`,
and `cost_summary.txt`.

## Development

```bash
npm install && npm run build && npm test    # TypeScript engine + CLI
make install && make test                   # Python reference engine
```

`fixtures/parity/*.json` pin the numeric behavior — Fleiss' κ, ICC,
composites, gate results — and both suites verify against them, so the two
engines cannot silently diverge (`tools/extract_parity_fixtures.py`
regenerates).

The Python package in `src/quorable/` is not shipped — it is the executable
spec the TS engine was ported from, and it stays in the repo so the parity
fixtures have two independent implementations to check.

Live API tests never run in CI; a smoke test costs real money and is opt-in
via `RUN_LIVE_TESTS=1`.

| Document | What is in it |
|---|---|
| [`CONTRACT.md`](CONTRACT.md) | The engine/pack contract — the non-negotiables. |
| [`docs/operations.md`](docs/operations.md) | Cost traps, local-seat reliability, rubric gate syntax, known limits. **Read before spending money.** |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | Setup, the parity gate, and the design rules a PR must not break. |
| [`SECURITY.md`](SECURITY.md) | Where your documents and keys go, and how to report a vulnerability. |
| [`CHANGELOG.md`](CHANGELOG.md) | What changed, per release. |

The build plans that produced M0–M9 have been retired now that the work has
landed; they remain in git history.

MIT.
