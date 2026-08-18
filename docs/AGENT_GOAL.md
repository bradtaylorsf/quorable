# Agent goal: build the quorable TS CLI

*The mission prompt for the implementation agent. Written 2026-08-12.*

Build quorable: a TypeScript CLI, published-ready for npm, that runs multi-model
adversarial review councils against any document. Work in
~/Documents/GitHub/quorable (git repo, main branch).

THE SPEC — read these first, in order:

1. CONTRACT.md — the engine/pack contract and non-negotiables carried from the
   parent systems.

   (The roadmap that drove this — docs/GENERALIZATION_PLAN.md, M0–M10, with
   design detail in §5 — was retired once M0–M9 landed. Source comments still
   cite it as "plan M2", "plan §5.4", "Blocker 3"; recover it from git history
   if you need the reasoning behind one of those.)
2. The Python code in src/quorable/ — this is the executable spec, not the
   product. 176 passing tests (make test). Never break it; retire it to
   reference/ only when TS reaches parity.

WHAT TO BUILD (sequencing per the plan):

- TS workspace in this same repo (package.json beside pyproject.toml). Node 20+,
  strict TS, zod, commander + @clack/prompts, p-retry, official mupdf WASM
  package for PDFs. Vitest.
- Port the engine core generalized-from-day-one: provider abstraction
  (openrouter / anthropic / openai / openai-compatible for local models),
  generic YAML rubric packs (no per-domain code), auto-manifest from --context
  dirs, config layering (defaults → ~/.quorable → project → env → flags).
- CLI: `quorable review <file-or-dir> --council <name> --rigor
  quick|standard|rigorous`, plus init, panel, validate, golden, diff, handoff,
  outcome, keys, persona/council management. Interactive picker on TTY; every
  interactive choice echoes equivalent flags. Output defaults to
  `<filename>-reviewed/` next to the target.
- Blind-spot integrity (M6) is mandatory, not optional: cold reader at every
  tier, two-sided agreement flags, persona differentiation score, escape rate,
  discrimination test, validation_tasks.json emission.

PARITY GATE (this is the acceptance bar for the engine):

Extract JSON fixtures from the Python tests (agreement inputs → κ/ICC outputs,
review sets → composites and gate results). The TS engine must reproduce
Python's numbers on identical inputs to 6 decimal places before anything ships.
Port the remaining Python test intent as vitest suites.

HARD RULES:

- Statistical honesty: κ/ICC computed in code and patched over LLM output;
  blocking findings computed from raw reviews, never trusted to synthesis;
  warn on single-vendor panels; ≥2 cross-vendor models per persona or say so.
- Cost governor aborts, never degrades. Failures become result rows, never
  crashes. Injection guard on every prompt. No API keys in code or commits.
- Commit in small, well-messaged increments per milestone. Run the full
  test suite (Python AND TS) before every commit.
- Live API runs cost money: use OPENROUTER_API_KEY from env only if present,
  cap any live smoke test at $2, and never make live calls in CI/tests.
- Do NOT publish to npm/PyPI or create GitHub remotes — Brad does that.

DONE = `npx quorable review somefile.md` works end-to-end from a clean clone
with only an OpenRouter key: interactive council pick, panel runs, scored
synthesis report + traces + validation tasks in somefile-reviewed/, parity
fixtures green, both test suites green, README rewritten for the TS CLI.
