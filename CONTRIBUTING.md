# Contributing to quorable

Thanks for looking. quorable is a small, opinionated tool; the fastest way
to get a change merged is to know which of its two halves you are touching.

## The two engines

| Tree | What it is |
|---|---|
| `ts/src/` | **The product.** The TypeScript engine and CLI that ships to npm. |
| `src/quorable/` | **The executable spec.** The Python engine the TS port was written against. Not shipped. |

`fixtures/parity/*.json` pin the numeric behaviour — Fleiss' κ, ICC(1,1),
composites, gate results. **Both** suites verify against them, which is what
stops the two engines silently diverging.

If you change any number the engine computes, you must either
(a) show the fixtures still pass, or (b) change the fixtures deliberately and
say why in the PR. Regenerate with `tools/extract_parity_fixtures.py`.

## Setup

```bash
npm install && npm run build && npm test    # TypeScript engine + CLI
make install && make test                   # Python reference engine
```

Node 20+ is required. The Python side is uv-managed.

## Before you open a PR

```bash
npm run typecheck && npm run build && npm test && make test
```

CI runs exactly this across Node 20/22/24. Live API tests never run in CI —
a smoke test costs real money and is opt-in via `RUN_LIVE_TESTS=1`.

## Design rules that are not up for negotiation

These are the reason the tool is worth using. A PR that breaks one will be
sent back even if it is otherwise good. The long form is in
[`CONTRACT.md`](CONTRACT.md).

- **No number comes from a model.** Scores, gates, agreement statistics and
  the ship verdict are computed in code from the raw Stage-1 reviews. A
  synthesis model that drops a severity-1 finding must not be able to unblock
  a ship.
- **Failures become result rows, never crashes.** A provider error is data.
  But it must also be *visible* — a silently short panel is a correctness bug,
  because κ and ICC are then computed over an unbalanced rater set.
- **The engine stays domain-blind.** Personas, rubrics, gates and golden sets
  are user-supplied YAML and markdown. Per-domain logic does not belong in
  `ts/src/engine/`.
- **Checked and asserted are never laundered together.** A claim a reviewer
  could not verify goes to `validation_tasks.json`, not into the report as
  fact.
- **An unrecognized model prefix is an error**, never a silent fallthrough to
  a paid call.

## Adding a rubric or council

You almost certainly do not need to write code. A rubric is a YAML file
(dimensions, scales, weights, verdict categories, mechanical gates, ship
thresholds); a council names personas, and personas are plain markdown. See
the README and the packs in `assets/`. New general-interest packs are welcome
as PRs; anything domain-specific is better in your own `~/.quorable/` or a
project's `.quorable/`.

Gate patterns compile with JavaScript `new RegExp(p, "m")` — see
[`docs/operations.md`](docs/operations.md) for the syntax traps.

## Reporting bugs

Cost and agreement bugs are the ones that matter most. If you file one,
include the run's `run_metadata.yaml`, the raw review count, and
`models × personas × runs` — **never** an API key or client document.
