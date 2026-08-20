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
- First real PDF coverage: two tests that build a minimal PDF with known
  text and assert extraction, page markers and page order. Previously only
  the broken-PDF path was tested.
- CI on GitHub Actions: typecheck, build and test across Node 22 and 24, the
  Python reference suite, and an `npm pack` contents check.
- `CONTRIBUTING.md`, `SECURITY.md`, `.env.example`, and this changelog.
- `docs/operations.md` — cost traps, local-seat reliability, rubric gate
  syntax, and known limits.

### Fixed
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
