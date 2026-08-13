# quorable Unification Plan

*2026-07-27 — replaces the per-repo review agents with one CLI + per-project packs*

## 0. The headline finding

**You already started this, and you got further than you remember.** `~/Documents/GitHub/quorable` is the unified CLI: a fork of the legal-argument reference implementation's engine with a clean engine/pack split, 9 working CLI commands (`init`, `ingest`, `cost-estimate`, `run`, `panel`, `validate`, `golden`, `diff`, `handoff`), and 176 passing network-free tests. It was built in one sitting on 2026-07-20 and then stopped cold: **never git-committed, never run against a real project.** `CONTRACT.md` is its authoritative design doc.

Its first consumer pack also already exists: `ideology/shorts-agent/` — 7 personas, a 10-dimension weighted rubric, mechanical gates, golden fixtures with a negative control, briefs, and a Makefile wrapping the `quorable` binary. It too has never run (no `OPENROUTER_API_KEY` in ideology's `.env`, `runs/` doesn't exist, and the world-bible `.docx` can't be parsed yet).

**Decision: do not start over. Finish quorable.** The hard part (the engine) is done and tested; what's missing is exactly the ergonomics you listed — global config, model overrides, hidden-folder/multi-job mode, persona building, goal elicitation, docx, smarter stop reasons, and a skill layer for the Claude Code / Codex harness.

## 1. The family tree (what exists today)

```
the legal-argument reference implementation  (the reference implementation, ~7.6k LOC, 287 tests)   ← origin, deepest
  ├─→ a grant-proposal system-grant-agent  (grant_review)           ← fork, adds drafter, drops golden/regressions
  │     └─→ brad-jobsearch/negotiation-agent (negotiation_review)  ← fork of the fork, adds feedback auto-glob
  └─→ quorable  (engine/pack split, generalized)          ← THE UNIFICATION (v0.1, unused)
        └─ ideology/shorts-agent/                          ← first pack (authored, never run)
```

Cross-repo sweep confirmed: **no other full framework copies exist.** Adjacent material:
- `brad-jobsearch/negotiation/` — prose-only predecessor of the negotiation agent (personas.md + run protocol run by hand in Claude sessions). A clean "before" specimen; retire after migration.
- `brad-jobsearch/interview-prep/` — persona prompt packs, no loop. Future pack candidate.
- `a grant-proposal system/` — content only; the grant agent vendored copies of its context files (byte-identical today, hand-synced).
- `sitsim` — independent TS propose/review/vote loop (Anthropic SDK, not OpenRouter). Leave alone.
- `muckwire` — planner/critic/synthesizer research loop, roles not personas. Leave alone.
- Show Sidekick's `reviewer.md` meta-skill (vendored in 8+ video repos) — single-voice CHAI gate, different philosophy ("never block indefinitely"). Keep separate, but steal its skill-layering pattern (§5).

The three forks share ~85% of their Python; four modules are byte-identical across grant/negotiation. The fork mechanism is copy-paste, so fixes never propagate — the negotiation agent currently has a **live breaking bug** from exactly this: a 7th criterion added to `config.yaml` + `system_prompt.md` on 07-25 that `schemas.py`'s hardcoded 6-value `Literal` will reject on the next run.

## 2. What each repo contributes to the unified engine

| Capability | Lives in | Status in quorable |
|---|---|---|
| Draft → panel → synthesis → revise loop, ship gates, budget abort | quorable `engine/loop.py` | ✅ done |
| Fleiss' κ + ICC agreement, code-recomputed `priority_score` | all | ✅ done |
| Held-out validation + ledger + exhaustion warnings | legal | ✅ done (ledger + exclusion) |
| Golden seeded-defect recall + negative control | legal | ✅ done |
| Regression registry (hash-gated auto-resolve) | legal | ✅ done |
| Cost estimate (live OpenRouter pricing) + hard abort | all | ✅ done |
| `run_metadata.yaml` sha256 reproducibility record | all | ✅ done |
| Injection guard + `suspected_prompt_injection` field | legal | ✅ done |
| **Feedback auto-glob** (`inputs/feedback/*.md` → tier-1, overrides older context) | negotiation only | ❌ **port to engine** — this is the best single idea in any fork and is exactly how a harness session steers the pipeline without touching config |
| Idempotent report re-render (fixes "held-out status stuck at not_yet_run") | nowhere (grant repo documents the defect) | ❌ add `quorable render <run-dir>` |
| Manifest declared-vs-loaded assertion | nowhere (grant repo's `source:` section silently never loaded — 3 critical docs skipped in every committed run) | ❌ add loud check |
| citecheck / xref mechanical gates | legal | ⚠️ stay legal-pack-side, implemented as pack `Gate`s |
| Compliance / discipline single-model audit | grant / negotiation | ⚠️ pack-side prompt + gate |
| Demurrer simulation, research loop, filing checklist | legal | ⚠️ legal-pack extras, not engine |
| Section specs for drafting (currently ~200-line prose blobs in `drafter.py` / `analyst.py`, incl. PII) | grant + negotiation | ❌ becomes pack data (`prompts/sections/*.md` + YAML) |
| Skill layering + harness sync (`.claude/skills` + `.agents/skills` mirrors, drift detection) | alpha-loop + Show Sidekick | ❌ build `quorable sync` (§5) |

## 3. Target CLI design

### 3.1 Config layering (default config + overrides)

Resolution order, later wins:

```
1. Engine defaults (pydantic)
2. ~/.config/quorable/config.yaml        ← NEW global default: model roster, temps,
                                             pipeline knobs, cost thresholds
3. <project>/config.yaml                  ← pack + project overrides (only what differs)
4. <project>/jobs/<job>/config.yaml       ← NEW per-job overrides (optional)
5. CLI flags                              ← NEW: --reviewer m1 --reviewer m2 --synthesizer m
                                             --drafter m --held-out m --runs-per-persona N
                                             --max-iter N --budget X
```

`quorable config --resolved [--job X]` prints the merged result with provenance per key. `cost-estimate` honors the same overrides, so "what would this run cost with GPT-5.5 swapped in" is one flag away. This kills the current requirement that every repo carry a full model roster copied from legal's config.

### 3.2 Two project layouts, one discovery rule

**Standalone** (current quorable layout — for dedicated repos like a migrated the legal-argument reference implementation):

```
myproject/
  config.yaml  pack.py  personas/  prompts/  inputs/  golden/  briefs/  runs/  handoff/
```

**Embedded** (`quorable init --embedded` — for agents living inside an existing repo, the brad-jobsearch case):

```
host-repo/
  .quorable/
    config.yaml            # names the pack, points at jobs
    pack.py
    personas/  prompts/    # shared across jobs
    jobs/
      anthropic-offer/
        goal.md  config.yaml  inputs/  runs/
      board-structure/
        goal.md  config.yaml  inputs/  runs/
```

- Discovery: walk up from cwd for `.quorable/` or `config.yaml` with a `pack:` key (git-style). `--project` still overrides.
- `quorable run --job anthropic-offer` selects a job; single-job projects need no flag. `quorable jobs` lists them.
- `init --embedded` appends `.quorable/**/runs/` and `.env` to the host `.gitignore` and never touches host files otherwise.
- This natively replaces the legal-argument reference implementation's dual-config hack: SAC mode and opposition mode become two **jobs** sharing one pack (with per-job persona subsets — opposition drops `pleading_form_auditor` via a job-level `personas:` override).
- Option for "visible" embedded mode: `init --embedded --dir review/` if you'd rather see it.

### 3.3 A runnable `init` (the current weakest link)

Today `init` scaffolds empty dirs and a config with `personas: []` — a fresh project cannot run. Fix by shipping a **starter pack template**: generic `pack.py` (severity 1–3 findings, 1–10 dimension scores — the shorts-agent shape, which is the best-evolved), generic `system_prompt.md`, `draft/revise/synthesis.md` prompts (the shorts-agent ones are domain-neutral except nouns), four starter personas (skeptic/red-team, target-audience, domain-expert, editor), and a filled example manifest. `quorable init --template blog|grant|legal|negotiation|shorts|blank` seeds domain variants. `quorable doctor` validates completeness (personas listed exist as files, prompts present, manifest paths resolve, pack loads, schema/config criteria agree — the check that would have caught the negotiation 7th-criterion drift and the grant `source:` bug).

### 3.4 Goal/vision + persona building — harness-side, validated CLI-side

The elicitation you described ("gather context first, get the user's goals, build personas from all angles") should **not** be Python — it's a conversation. It lives in the skill layer (§5): the `quorable-setup` skill interviews you, writes `goal.md` (goal, audience, success criteria, constraints, score targets), derives 5–8 personas with a dimension-ownership map (every rubric dimension owned by ≥1 persona; always include one red-team persona excluded from the composite and, where there's a canon/fact base, one truth-guard persona whose severity-1 findings are ship-blockers — the two structural roles proven across shorts/grant/legal). The CLI's job is only `quorable doctor` validation plus template scaffolding. `goal.md` gets `send_to: [draft, stage1, stage2, stage3]` in the manifest so every stage knows what the document is for.

### 3.5 Loop termination: from 3 statuses to a real taxonomy

Current: `SHIPPABLE | EXHAUSTED | ABORTED`. Per-iteration composites are already recorded but never compared. Target:

| Status | Trigger | Meaning for you |
|---|---|---|
| `SHIPPABLE` | composite ≥ `composite_min`, all dims ≥ `dimension_min`, no blocking findings, gates pass | Done |
| `PLATEAUED` | composite delta < `plateau_epsilon` (default 0.15) for `plateau_patience` (default 2) consecutive iterations, **and** the blocking-findings set is stable | "The agent can't change the way it talks anymore" — revision is out of headroom |
| `NEEDS_INFO` | ≥ half the top-N ranked fixes are flagged `requires_new_information`, or accumulated `information_needed` items block gated dimensions | Fundamentally an information problem — go answer the listed questions, drop them in `inputs/feedback/`, resume |
| `STRUCTURALLY_CAPPED` | same blocking findings survive ≥2 revisions with no score movement on their dimensions, or synthesis flags a goal/constraint conflict | It will never clear the bar as asked — the goal, constraints, or bar must change |
| `EXHAUSTED` | `max_iterations` hit while still improving | Raise `--max-iter` if you want more |
| `ABORTED` | budget ceiling / drafter failure / fatal error | Mechanical stop |

Schema additions (engine-level conventions, packs inherit): `requires_new_information: bool` + `information_needed: list[str]` on ranked fixes; an optional `structural_concerns` synthesis field. `loop_summary.yaml` gains `stop_reason` with the evidence (score trajectory, unresolved blockers, open questions) so the harness skill can tell you *why* and what to do next.

### 3.6 Output formats

- Inputs: add `.docx` parsing (mammoth or python-docx → markdown at ingest). This unblocks the shorts pack's #1 canon source and lets grant/legal ingest Word sources directly.
- Outputs: `quorable export <run-dir> --format docx|md` (pandoc if present, python-docx fallback) for the final draft + synthesis report. Markdown stays the native format.
- `quorable render <run-dir>` re-renders `synthesis_report.md` idempotently, folding in held-out/red-team/discipline results after the fact.

### 3.7 Standardized scoring

Standardize the **template**, not a mandate: 1–10 dimension scores, per-dimension weights, weighted composite, red-team persona excluded from composite, severity 1–3 findings, and the invariant `priority_score = (impact² × consensus) / (1 + ease)` recomputed in code. Packs may override shape (legal keeps 1–5 × 8 dims), but everything scaffolded by `init` uses the standard, and `diff` can compare any two runs of the same pack. Add validation that `composite_min`/`dimension_min` match the schema's declared score range (currently unchecked).

## 4. Engine work items (quorable repo)

**Phase 0 — stabilize (do first, ~an hour)**
1. `git init` + initial commit of quorable as-is. It's the only repo in the family with no history.
2. Fix `init`'s dead top-level `context/` dir (manifest resolves relative to `inputs/`).
3. Add the manifest "declared N, loaded M" assertion + test (the grant bug).

**Phase 1 — config & ergonomics**
4. Global config at `~/.config/quorable/config.yaml` + layered merge + `config --resolved`.
5. CLI model/pipeline overrides on `run`, `panel`, `cost-estimate`.
6. Starter-pack templates + `doctor`.

**Phase 2 — layouts & jobs**
7. `.quorable/` embedded mode + walk-up discovery + `--job` / `jobs/` registry.
8. Feedback auto-glob ported from negotiation-agent (tier-1, "later feedback overrides older context", covered by its existing test).

**Phase 3 — loop & formats**
9. Termination taxonomy of §3.5 (plateau detection, `requires_new_information` plumbing, `stop_reason` evidence block).
10. `.docx` ingest; `export --format docx`; `render`.

**Phase 4 — harness layer**
11. `quorable sync` + skill templates (§5).
12. Golden `--live` panel mode (run the real persona panel per golden case instead of substring matching — the shorts pack's documented blocker).

**Phase 5 — migrations** (§6), then delete-or-freeze legacy CLIs.

Also worth doing along the way: CLI tests (CliRunner — currently zero) and tests for `pipeline`/`synthesis`/`held_out`/`drafting`, which are the untested half of src.

## 5. The skill library (Claude Code / Codex harness)

Adopt the **alpha-loop distribution pattern** (proven in `alpha-loop/src/commands/sync.ts` and Show Sidekick's generated mirrors): skills live once in the quorable repo under `templates/skills/<name>/SKILL.md`, and `quorable sync` fans them into whatever harness is present — `.claude/skills/` + `CLAUDE.md` pointer for Claude Code, `.agents/skills/` + `AGENTS.md` for Codex — with drift detection so local edits aren't clobbered.

Four skills:

- **`quorable-setup`** — the elicitation flow: interview for `goal.md`; choose standalone vs embedded and job structure; generate personas + ownership map + rubric weights; scaffold via `init --template`; run `doctor`; run `cost-estimate` and report the number before any spend.
- **`quorable-run`** — drive `run`/`panel`, interpret `loop_summary.yaml`'s `stop_reason`, present ranked fixes and the scorecard, and on `NEEDS_INFO` turn `information_needed` into questions for you, writing your answers to `inputs/feedback/YYYY-MM-DD-<topic>.md`.
- **`quorable-iterate`** — the harness-as-drafter mode: `run --no-draft` panels an existing draft, then the *harness agent* (not an OpenRouter drafter) applies the ranked fixes to the draft and re-runs. This is exactly your "take the feedback, have the agent perform it, run again" loop, and it's why every persona/prompt file should stay dual-use (readable prose, not just API payload — the shorts pack already does this deliberately).
- **`quorable-validate`** — held-out validation + golden + regression interpretation before you ship.

The shorts pack's `context/00_CONTEXT_MAP.md` "Phase 1 manual mode" is a hand-written spec for these skills — converting it is mostly mechanical.

## 6. Migration paths (each repo stays in place)

Order chosen so each migration exercises the features the next one needs.

### 6.1 `ideology/shorts-agent` — first (it's already a pack; ~half a day)
1. After Phase 0/3: convert `IDEOLOGY_Science_World_Bible.docx` (docx ingest) and un-comment it in the manifest.
2. Add `OPENROUTER_API_KEY` to ideology's `.env`; `mkdir runs/`, create the handoff dir.
3. `quorable doctor` → `golden` (mechanical tier) → `cost-estimate` → first real `run` on the `file-001-transfer-night` brief.
4. `quorable sync` to give ideology the four skills alongside its Show Sidekick skills.
   This run is the acceptance test for the whole engine.

### 6.2 New: **tech-blog-post reviewer** — second (greenfield validates `init`; ~a day)
`quorable init --template blog` in a new `blog-review/` repo (or embedded in `bradleytaylorai/` or `taylormademoves/`, where the posts live). Starter pack:
- **Personas (7):** `target_reader` (the practitioner you're writing for), `skeptical_hn_commenter` (red team, excluded from composite), `technical_fact_checker` (truth guard — severity-1 factual findings block shipping), `seo_distribution_strategist`, `narrative_editor`, `brand_voice_guardian`, `busy_executive_skimmer`.
- **Dimensions (1–10, weighted):** hook_strength, clarity, technical_accuracy (gate-weighted 0.0 like canon_fidelity — accuracy is a gate, not an average), novelty_of_insight, structure_and_skimmability, actionability, credibility_evidence, cta_alignment.
- **Mechanical gates:** `word_count_gate` (per section), `banned_elements_gate` seeded with AI-tell phrases ("delve", "in today's fast-paced world", "it's important to note", rule-of-three stacks, "isn't just X — it's Y"), `term_lint_gate` for product-name canon.
- **Golden:** one post with seeded defects (a fabricated benchmark number, a broken claim, banned phrases, a buried lede) + one clean control.
- Score target example: ship at composite ≥ 8.0, technical_accuracy blockers zero.

### 6.3 `brad-jobsearch/negotiation-agent` — third (first embedded migration)
1. `quorable init --embedded --template negotiation` in `brad-jobsearch/` → `.quorable/` with jobs (e.g. `opening-move`, `structure-track` — the `--track` mechanism becomes two jobs, preserving the hard non-mixing rule).
2. Move personas/prompts/system_prompt verbatim; move `analyst.py`'s `OPENING_SPECS`/`STRUCTURE_SPECS` prose into `prompts/sections/*.md`; `_HELD_OUT_OVERLAY` becomes `personas/_held_out.md` (now hashed into run metadata).
3. Write `pack.py` with **seven** criteria — this migration *is* the fix for the criteria drift; rename `brad_confirmations` → `open_questions` with marker token `[BRAD: confirm]` in config.
4. Discipline check → pack prompt + blocking gate; counterparty sim → pack extra.
5. Feedback dir carries over unchanged (the engine now owns the glob).
6. Freeze the old `nego` CLI (leave `.venv` untouched until parity is proven on one side-by-side run), then delete `src/`. Retire the prose `negotiation/` packet (keep as archive).
   Sensitivity note: keep `.quorable/` inside the existing chmod-700 boundary; nothing new gets committed — the host repo tracks almost nothing today and that posture stays.

### 6.4 `a grant-proposal system-grant-agent` — fourth
1. Standalone project: add `pack.py` (6 criteria + 9 sections + integrity-flag kinds move from `Literal`s to pack schema), keep personas/prompts/inputs in place.
2. Move `drafter.SECTION_SPECS` → `prompts/sections/*.md` — **this removes PII (names, emails, phone numbers, pricing) from Python source**.
3. The engine's manifest assertion surfaces the `source:` bug; re-register `team_decisions`/`confirmed_facts`/`sme_key_insights` correctly — the next run will be the first that actually reviews against the authoritative fact docs.
4. Golden + regressions come back for free from the engine (the fork had dropped them); seed a small golden set from a past draft with known fabrication-bait.
5. Compliance check → pack gate; `.gitignore` fix for `outputs/` (316 files currently tracked); document that `a grant-proposal system/` is the pack's source-of-truth content bank and vendored copies should be replaced by manifest paths pointing at it (or a sync script).

### 6.5 `the legal-argument reference implementation` — last (deepest, and it's live litigation tooling)
1. One pack, **two jobs** (`sac`, `opposition`) replacing the dual-config trees; per-job persona subsets, per-job regressions path, per-job `document_type` guard (the classifier moves into the engine as an optional pack hook).
2. Port `citecheck.py` + `xref.py` as pack-provided mechanical `Gate`s (they already fit the Gate contract: pure functions, non-zero exit semantics → blocking findings). `filing.py`, `simulate.py`, `research.py` become pack extra commands (quorable grows a light `pack_commands` registration hook, or they stay as scripts inside the repo — decide at migration time).
3. Golden set migrates as-is (same manifest shape). Regression registries (1,708 lines) migrate with their hash-gating semantics preserved.
4. Migrate **between filings only**, with a parity gate: run old `sac-review run` and new `quorable run` against the same committed draft, diff `synthesis.json` structure and gate results before cutting over. Keep `the reference implementation` frozen until then.
5. Preserve verbatim: git-committed-input enforcement, holdout ledger + exhaustion warnings, semantic held-out adjudication, injection hardening — all already in the quorable engine or ported in Phase 0–3.

### 6.6 Not migrating
`sitsim`, `muckwire`, Show Sidekick's reviewer skill (different philosophies, working systems), `interview-prep` (future pack candidate once the interview format is worth panel review).

## 7. Bugs found along the way (fix regardless)

1. **negotiation-agent will fail its next run** — 7 criteria in config/system_prompt vs 6 in `schemas.py` (`CANONICAAL_CRITERIA`, `CriterionName`, `_CRITERION_LABELS`, `SCORE_DIMENSIONS`). Fixed by migration 6.3, or one-line-per-file hotfix if you need a run before then.
2. **grant agent silently never loads its `source:` manifest section** — `manifest._LIST_SECTIONS` doesn't include it; every committed run reviewed without `team_decisions.md`/`confirmed_facts.md` despite `critical: true`. Hotfix: add `"source"` to the tuple, or wait for migration 6.4.
3. **grant agent's `outputs/` is tracked in git** (316 files) despite README claiming otherwise.
4. **quorable has no git history** — Phase 0 item 1.
5. grant/negotiation `costs.MODEL_PRICING` static tables don't contain their own configured models — on network failure the cost guard degrades to default pricing silently. The engine's table needs a refresh cadence note.

## 8. Suggested sequencing

| Step | Scope | Rough effort |
|---|---|---|
| 0 | quorable: git init, init fixes, manifest assertion | hours |
| 1 | Config layering + CLI overrides + doctor + templates | 1–2 days |
| 2 | Embedded mode + jobs + feedback glob | 1–2 days |
| 3 | Stop-reason taxonomy + docx in/out + render | 1–2 days |
| 4 | Skill templates + `quorable sync` | 1 day |
| 5 | shorts-agent first real run (acceptance test) | half day |
| 6 | Blog-review pack (greenfield validation) | 1 day |
| 7 | negotiation-agent embedded migration | 1 day |
| 8 | grant-agent migration | 1 day |
| 9 | the legal-argument reference implementation migration (between filings, parity-gated) | 2–3 days |

Steps 5–8 are independent enough to run as parallel harness sessions once 0–4 land.
