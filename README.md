# quorable

*(formerly `writekick`; renamed 2026-08-12)*

Multi-model adversarial review-and-revision harness for writing. The engine is
forked from `the legal-argument reference implementation` (OpenRouter fan-out reviews, cross-model
synthesis with inter-rater agreement statistics, held-out validation, golden
sets, regression tracking) and generalized so that **each project owns its
domain** while the engine stays domain-blind.

**[`CONTRACT.md`](CONTRACT.md) is the authoritative design document** — read it
before changing anything.

## The engine/pack split

- **Engine** (`src/quorable/engine/`): domain-blind pipeline machinery — the
  OpenRouter client, validated structured calls, cost governance, the
  draft→panel→synthesis→gates→revise loop, agreement math, held-out
  validation, golden-set recall, regression tracking. Never edited per-domain.
- **Pack** (`src/quorable/pack.py` contract, instantiated per project): a
  project directory carries a `pack.py` exposing a `PACK = Pack(...)` object —
  review/synthesis schemas, score dimensions, verdict categories, canonical
  units, mechanical gates, ship gates — plus plain data: `personas/*.md`,
  `prompts/*.md`, `context/`, `golden/`, an inputs manifest, and `config.yaml`
  (which names the pack via its `pack:` key).

## Install

```bash
make install          # uv sync --extra dev
```

Set `OPENROUTER_API_KEY` in the environment or a `.env` file.

## CLI

All commands operate on the current directory or `--project <dir>`:

```
quorable init                 # scaffold a project skeleton
quorable ingest               # parse manifest docs, print table
quorable cost-estimate        # per-loop estimate incl. drafter calls — run before first real run
quorable run [BRIEF] [--max-iter N --budget X --confirm --no-draft]
quorable panel [SCRIPT]       # Stage 1+2 only on an existing draft
quorable validate --run-dir   # Stage 3 held-out validation + ledger
quorable golden [--live]      # seeded-defect recall; exit non-zero on miss
quorable diff A B             # cross-run comparison
quorable handoff RUN          # emit deliverables + freeze predictions.yaml
```

## Testing

```bash
make test             # unit tests, network-free (mocked with respx)
```

Engine tests run against `tests/fixtures/toy_pack/`, a minimal project, so the
engine is exercised pack-independently.
