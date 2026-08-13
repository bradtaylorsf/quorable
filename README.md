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
```

Model ids are provider-qualified: `openrouter:x-ai/grok-4.3` (bare ids mean
OpenRouter), `anthropic:claude-…`, `openai:gpt-…`, `local:llama-3.3-70b`
(any OpenAI-compatible endpoint — Ollama, LM Studio, vLLM, Together — via
`providers.local_base_url`). Local models are free; the panel warns loudly
when all reviewers share one vendor, because agreement statistics assume
independent raters.

## Configuration

Layered, later wins:

```
packaged defaults → ~/.quorable/config.yaml → ./quorable.yaml (nearest
ancestor) → env (QUORABLE_COUNCIL, QUORABLE_RIGOR) → flags
```

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

The Python package in `src/quorable/` is the executable spec the TS engine
was ported from. `fixtures/parity/*.json` pin the numeric behavior —
Fleiss' κ, ICC, composites, gate results — and both test suites verify
against them, so the two engines cannot silently diverge
(`tools/extract_parity_fixtures.py` regenerates).

Design documents: [`CONTRACT.md`](CONTRACT.md) (engine/pack contract),
[`docs/GENERALIZATION_PLAN.md`](docs/GENERALIZATION_PLAN.md) (roadmap and
decisions). Live API tests never run in CI; a smoke test costs real money
and is opt-in.

MIT.
