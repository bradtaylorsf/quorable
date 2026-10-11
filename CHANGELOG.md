# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- **PDF parsing moved from mupdf to pdf.js.** mupdf is AGPL-3.0-or-later,
  which put a copyleft dependency inside an MIT package — enough to fail a
  dependency scanner at most companies. `pdfjs-dist` is Apache-2.0, and the
  dependency tree is now MIT/Apache/ISC/BSD throughout. Extraction output is
  unchanged: per-page text under `[p.N]` markers.
- **Node 22.13+ is now required** (was 20+). pdf.js sets that floor, and its
  Node-20-compatible line is stranded below a high-severity advisory
  (GHSA-hq66-cqwq-w95j, arbitrary JS execution on opening a malicious PDF —
  precisely this tool's threat model). Node 20 reached EOL in April 2026.
  CI drops the Node 20 job.

### Added
- **Metric gates, stop rules, and derive steps for `quorable revise`.**
  - `--metric 'name >= threshold [xRUNS] [~MIN_DELTA]: command'` (or
    `metrics:` in a rubric or policy): a number extracted by code — last
    number printed, a regex, or a JSON path from stdout or a written file —
    sampled `runs` times per round and aggregated (median, mean, min, max).
    A metric at its threshold is a mechanical readiness requirement.
  - Stop rules: `--plateau-rounds` (stalled after N attempts without a
    finding resolved, a failing check fixed, or a metric gain of at least
    `min_delta`), `--on-regression continue|revert|stop` (revert resets the
    candidate before review, tags the attempt, and tells the next reviser
    why), `--require <severity>`, and the existing budgets. `--max-revisions`
    now counts attempts, accepted or reverted. Every agent is shown the rules,
    current metric values, best values, history, and remaining budget.
  - `--policy <file.yaml>`: criteria, setup, checks, metrics, derive steps
    and stop rules in one validated file
    ([example](docs/examples/revise-policy.yaml)); flags extend lists and
    override scalars. `--dry-run` prints the merged policy and the stop rules
    in plain English and starts nothing.
  - `--derive name=command`: runs first every round and writes evidence into
    `$QUORABLE_DERIVE_OUT`, outside the candidate — the way a video or other
    binary artifact gets transcribed, quoted, and scored.
  - Anything a check, metric, or derive step writes into the candidate is
    reverted after measurement and recorded, so test runs cannot change what
    is judged. Candidate commits now include files the project's own
    `.gitignore` hides, so reverts restore them.
  - Artifacts renamed per attempt: `workspace/checks/<v0|attempt-K>/`,
    `workspace/revisions/attempt-K.patch`, `workspace/derived/…`. `run.yaml`
    gains `metric_history`, `progress`, `attempts`, `measurements`, and the
    stop rules.
- **`quorable revise` works on directories — repositories, projects, folders
  of derived evidence — not only text files.** The target is copied (no
  symlinks, no dependency/build output), every version is a commit in a
  private git store inside the copy, and the candidate's identity is a tree
  hash computed by the controller. The reviser is a normal coding session
  confined to the copy (Codex `workspace-write` sandbox, or Claude Code with
  Edit/Write/Bash under a permission allowlist; never a bypass flag); the
  controller re-hashes, commits, and writes `workspace/revisions/vN.patch`.
  `--check name=command` runs the project's own checks inside the candidate
  every round with frozen, quotable logs; `--setup` runs one-time prep;
  `--primary` names the text file for text gates; `--exclude` widens the
  skip list. `quorable investigate` accepts a directory too.
- `code-review` council (`correctness_reviewer`, `security_reviewer`,
  `maintainability_reviewer`, `red_team`) and a `code` rubric with no text
  gates; rubrics gain a `checks:` list of commands.
- `quorable revise` and `quorable readiness`: bounded revision loops,
  frozen evidence, stable finding registry, separate verifier invocations,
  mechanical gates, final evaluation, and source/artifact freshness checks.
- Real Codex/Claude CLI smoke fixture and opt-in integration test.
- `quorable investigate`: bounded concurrent Codex/Claude Code persona
  sessions, Markdown reviews, agent synthesis, optional parallel synthesis
  perspectives and final reconciliation, dry-run assignments, incremental
  execution metadata, cancellation and timeouts. Recommendations are
  advisory; no automatic ship verdict is inferred from prose.
- `docs/agent-councils.md`: architecture evaluation, usage, current limits,
  and a roadmap for evidence-backed decision records and bounded loops.
- First real PDF coverage: two tests that build a minimal PDF with known
  text and assert extraction, page markers and page order. Previously only
  the broken-PDF path was tested.
- CI on GitHub Actions: typecheck, build and test across Node 22 and 24, the
  Python reference suite, and an `npm pack` contents check.
- `CONTRIBUTING.md`, `SECURITY.md`, `.env.example`, and this changelog.
- `docs/operations.md` — cost traps, local-seat reliability, rubric gate
  syntax, and known limits.

### Fixed
- Evidence quotes that differ from the file only in whitespace — typically
  multi-line code re-indented by the quoting agent — now link, and the
  registry stores the file's exact text. Evidence that does not link now gets
  the same single repair attempt as a malformed record instead of failing the
  run outright. Found by a live loop whose final evaluator quoted two lines
  of code without their indentation.
- Revision-loop paths are resolved before they are recorded or compared, so
  agents' realpaths (`/private/tmp/...` on macOS) match the controller's.
- **The pre-run cost estimate now covers the calls that are actually made.**
  On a document over 60,000 characters the engine fans every Stage-1 job out
  across the discovered units, but the estimate — and therefore the cost
  confirmation prompt — was computed from the un-fanned job list, so a run
  could be approved at a fraction of what it went on to spend. The estimate
  now takes the real unit count and the cold reader's two calls.
- `tools/estimate.mjs` priced named local endpoints at the default hosted
  rate because it never passed its configured endpoint names to
  `getPricing()`. A local panel now estimates at $0.00, as the engine
  already did.
- Project-level `.quorable/{personas,councils,rubrics}` are now actually
  loaded. `resolve.ts` documented the search root but no CLI path passed it,
  so per-project assets silently never resolved and councils referencing
  them failed with "not found". `persona`/`council` listings now label rows
  `(project)` / `(user)` / `(packaged)`.

## [0.2.0] — 2026-08-18

### Added
- Per-project configuration: `quorable.yaml` / `.quorable.yaml` discovered
  from the document's directory upward.
- Named OpenAI-compatible endpoints, covering local servers (Ollama, LM
  Studio, llama.cpp, vLLM) and hosted APIs with no code change.
- Profiles — one backend per job — so two local servers cannot evict each
  other's models mid-run.
- `pipeline.synthesis_fallback: markdown` for synthesizers that cannot hold
  the JSON schema. Scores, gates and agreement statistics remain computed in
  code, so the fallback never affects a number.

### Fixed
- `render` trusted model-reported persona and model id over the filename.
- `loadRawReviews` filename fallback truncated persona names containing an
  underscore (`historical_auditor` → `auditor`).
- Naming a reviewer as `held_out` silently removed it from the panel.
- Provider-failed reviews were discarded with no re-queue, causing silent
  persona dropout.
- `raw_reviews/` was not cleared between runs; orphans from an earlier run
  could be scored into a later verdict.
- Review traces are now written incrementally — a crash mid-run no longer
  loses every completed review.

## [0.1.0] — 2026-08-12

Initial TypeScript engine and CLI, ported from the Python reference engine
at full numeric parity against `fixtures/parity/`.

[Unreleased]: https://github.com/bradtaylorsf/quorable/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/bradtaylorsf/quorable/releases/tag/v0.2.0
[0.1.0]: https://github.com/bradtaylorsf/quorable/releases/tag/v0.1.0
