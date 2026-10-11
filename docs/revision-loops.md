# Bounded revision loops and readiness

`quorable revise` reviews an **artifact** — a single text file, or a whole
directory such as a repository, a project, or a folder of derived evidence —
keeps a persistent finding registry, hands a normal coding session a
disposable copy to fix in place, independently verifies the fixes, and
evaluates a readiness policy. The source is never modified. Every version of
the candidate is a commit in a private git store inside the copy.

```bash
quorable revise draft.md \
  --context reference.md \
  --criteria 'Verify the plan against the approved reference, name owners, and specify acceptance checks.' \
  --persona skeptical_expert \
  --agent codex --agent claude \
  --reviser codex --verifier claude --evaluator claude \
  --max-revisions 3 --max-investigations 2 \
  --max-jobs 40 --max-elapsed 1200 --timeout 600 \
  --out ./runs/rollout-review

quorable readiness ./runs/rollout-review
```

A repository works the same way; the project's own checks become part of
readiness:

```bash
quorable revise ./my-service \
  --council code-review \
  --criteria 'Fix the flaky retry logic without changing the public API; all tests must pass.' \
  --setup deps='npm ci' \
  --check tests='npm test' --check types='npx tsc --noEmit' \
  --agent codex --agent claude --reviser codex \
  --out ../runs/my-service-retry
```

Run `npm run build` first when using `node dist/cli/main.js` from this repo.
The chosen CLI harnesses must be installed and authenticated. Override an
executable for testing or a separately installed version with
`QUORABLE_CODEX_BIN` or `QUORABLE_CLAUDE_BIN`; values are executable paths,
not shell commands. Harness specifications accept `codex:MODEL_ID` and
`claude:MODEL_ID`.

## Directories, repositories, and other artifacts

The engine is domain-blind; what makes a target reviewable is a quotable
evidence surface and a mechanical way to check it.

- **Candidate = a directory.** A file target is wrapped in a directory of one
  file; a directory target is copied without symlinks and without excluded
  names (`.git`, `node_modules`, `dist`, `build`, `target`, `coverage`, …;
  add more with `--exclude`). The candidate's identity is a sha256 over the
  sorted (path, content hash) pairs of every non-excluded file, computed by
  the controller, never reported by an agent. Up to 50,000 files.
- **The reviser is a normal coding session.** Codex runs with its
  `workspace-write` sandbox; Claude Code runs with Read/Glob/Grep/Edit/Write/
  Bash under a `dontAsk` permission allowlist. Both have the candidate as
  their working directory and read access to the frozen references and
  check logs. The session edits files in place and replies with a summary;
  the controller re-hashes the tree, commits it, writes
  `workspace/revisions/attempt-K.patch`, and either accepts it as the next
  version or reverts it (see [stop rules](#metrics-thresholds-and-stop-rules)).
  A session that changes nothing, or reproduces an earlier tree, stalls the
  loop; its own explanation is recorded in the stop reason.
- **Command checks** (`--check name=command`, or `checks:` in the rubric) run
  inside the candidate at the start of every round, without a shell. Exit 0
  passes. Output is frozen to `workspace/checks/<version>/name.log`, listed
  as a reference path, and quotable as evidence — a verifier can cite the
  test runner's own output. Anything a check writes into the candidate is
  reverted afterwards and listed in `run.yaml` under `measurements`, so a
  test run cannot change what is being judged; writes into excluded
  directories (`coverage/`, `dist/`, …) are left alone. `--setup
  name=command` runs once in the fresh copy before round 0 (dependency
  install, code generation); what it writes into excluded directories stays
  out of the candidate's identity, and anything else becomes part of v0.
- **Text gates** (word count, banned patterns, term lint) need a primary
  text file: the target itself, or `--primary <relpath>` inside a directory.
  A rubric with text gates and no primary is rejected before any output is
  created rather than silently skipped.
- **Evidence stays verbatim.** Findings and resolutions quote substrings of
  files inside the candidate, the frozen references, the check and metric
  logs, or derived evidence. Whitespace runs are treated as equal when
  matching, because agents re-indent multi-line code when they quote it;
  every other character must match in order, and the stored quote is the
  file's own text. A record whose evidence does not link gets one repair
  attempt, told which quote failed, before the run fails.
- **Derive steps** (`--derive name=command`, or `derive:` in a policy) run
  first in every round and turn the candidate into reviewable text: render
  a script and transcribe it, probe a video, print a public API surface.
  Each step writes into `$QUORABLE_DERIVE_OUT` — outside the candidate,
  under `workspace/derived/<version>/<name>/` — so derived output never
  changes the candidate's identity. Text files there are quotable by every
  agent; metrics read them through `$QUORABLE_DERIVED_DIR/<name>/`. A
  failing derive step is a failing check. This is how a binary artifact
  (video, audio, images) gets reviewed and scored: the reviser edits the
  source, derive regenerates the evidence, metrics and reviewers judge it.

## Metrics, thresholds, and stop rules

A **metric** is a command whose output yields a number, a direction, and a
threshold. Each round it runs `runs` times inside the candidate and the
samples are aggregated (`median` by default, or `mean`, `min`, `max`), so a
noisy measurement — a benchmark, a sampled eval, a flaky pass rate — is
judged on a stable value. The number is extracted by code: by default the
last number printed on stdout; or a regex (the last match's first group);
or a JSON path, from stdout or from a file the command writes inside the
candidate. Agents never report it. A sample that times out, crashes, or
prints no number fails the measurement rather than being guessed.

```bash
# name >= threshold [xRUNS] [~MIN_DELTA]: command      (<= to minimize)
quorable revise ./svc --council code-review --criteria '…' \
  --check tests='npm test' \
  --metric 'coverage >= 85 ~0.5: node scripts/coverage-pct.js' \
  --metric 'p95_ms <= 120 x5 ~5: node bench/retry.js' \
  --on-regression revert --plateau-rounds 2 --max-revisions 6
```

`min_delta` (`~` in the flag) is the measurement's noise floor. It means
two things: an improvement smaller than it is not progress, and a decline
larger than it is a regression. With `min_delta: 0`, every wobble counts.

Use a **policy file** for anything beyond that flag syntax — JSON or regex
extraction, per-metric timeouts, `require_success`, and the stop rules —
with `--policy file.yaml`. The annotated example at
[`examples/revise-policy.yaml`](examples/revise-policy.yaml) is loaded by
the test suite, so it stays valid. Rubrics may also declare `checks:` and
`metrics:`. Lists from the rubric, the policy, and flags are merged; for
single values a flag beats the policy, which beats the default. Run with
`--dry-run` to print the merged policy and the stop rules in plain English
without starting anything.

**The stop rules.** Every agent — reviewers, verifier, reviser, evaluator —
is shown the same rules, the current check results, each metric's current
value, best value, history, and threshold, and (for the reviser) how many
attempts, jobs, and seconds remain. The loop ends in exactly one of these
states:

| Stop | Condition | Configure with |
| --- | --- | --- |
| `ready` | For the exact candidate: every required finding resolved or refuted by an agent that did not write the fix, every check and derive step passing, every metric at its threshold, and a fresh evaluator agreeing | `require`, `checks`, `metrics`, `derive` |
| `stalled` (plateau) | `plateau_rounds` consecutive revision attempts with no meaningful progress: no finding resolved or refuted, no failing check fixed, no metric better than its best by `min_delta` | `plateau_rounds`, each metric's `min_delta` |
| `stalled` (regression) | With `on_regression: stop`, the first attempt that breaks a passing check or worsens a metric beyond `min_delta`; the previous version is restored first | `on_regression` |
| `stalled` (no change) | A revision changes nothing, repeats an earlier version, or repeats a reverted attempt | — |
| `exhausted` | `max_revisions` attempts, `max_jobs` agent invocations, or `max_elapsed_seconds` used | `max_revisions`, `max_jobs`, `max_elapsed_seconds` |
| `needs_user_input` / `needs_evidence` | A required finding needs an author's decision, or evidence the frozen sources cannot supply | — |

**Regressions.** `on_regression` decides what happens to an attempt that
breaks a previously passing check or leaves a metric worse than its best
by more than `min_delta`:

- `continue` (default) — keep it; the next council reviews it like any
  other revision.
- `revert` — reset the candidate to the previous version before any agent
  spends time on it, tag the attempt `rejected-attempt-K` in the candidate's
  git store, keep its diff and measurement logs, and tell the next revision
  session exactly what regressed and where the diff is. The attempt counts
  toward `max_revisions` and toward the plateau. This is the setting for
  hill-climbing a metric.
- `stop` — revert, then end the run as `stalled`.

Readiness is still not "the score is high enough". A metric at its
threshold is one mechanical requirement among the others; open blocking
findings or a dissenting final evaluator still hold the run. The reviser is
told to change the artifact, not the instrument — a metric command lives in
the candidate only if you put it there, so keep measurement scripts outside
the target (or in an excluded directory) when gaming them is a concern.

## Execution and artifacts

The controller copies the target, runs setup, commits `candidate v0`, and
snapshots the explicit text context, then each round:

1. Measures the exact candidate: derive steps, checks, metrics, then text
   gates; reverts anything the commands wrote into it; freezes logs and
   derived text as evidence.
2. Runs the independent persona council and synthesis, with the stop rules,
   check results, metric values and history, and the latest diff in the
   brief.
3. Validates each review's small decision record and registers findings.
4. Starts a separate verifier invocation to account for every finding.
5. Investigates unresolved evidence/disputes within the investigation limit.
6. Records this version's progress; if everything passes, starts a fresh
   final evaluator that is not given panel reports.
7. Otherwise checks the plateau, then starts a revision session in the
   candidate copy. With `on_regression: revert` or `stop` the attempt is
   measured immediately and reverted if it regressed; otherwise it becomes
   the next version and the next round reviews it.

The implementation performs a full council review after every revision.
Focused re-review is a possible optimization after quality measurement.

| Artifact | Contents |
| --- | --- |
| `workspace/candidate/` | The disposable copy the reviser edits; `git log --all` inside it is the version history, reverted attempts tagged `rejected-attempt-K` |
| `workspace/revisions/attempt-K.patch` | Diff of revision attempt K against the version it started from |
| `workspace/checks/<version>/*.log` | Frozen output of every derive step, check and metric run for `v0` or `attempt-K` (and `setup/`) |
| `workspace/derived/<version>/<name>/` | Derive-step output for that version: quotable when text |
| `workspace/references/` | Frozen copies of explicitly supplied text context |
| `round-N/` | Each council's Markdown reviews, synthesis, and run metadata |
| `agents/job-NNN.prompt.md` | Exact assignment for every invocation, including format repairs |
| `agents/job-NNN.md` | Final response, including failed/invalid responses when available |
| `agents/job-NNN.log` | Harness stderr when emitted |
| `findings.yaml` | Stable finding IDs, origins, evidence, and disposition history |
| `run.yaml` | Policy and stop rules, limits, versions, hashes, agent jobs, check results per version (`gate_history`), metric values per version (`metric_history`), progress signals, every attempt with its outcome, and the result |
| `readiness_report.md` | Human-readable result and link to the candidate |

The loop output must be new and outside the target and any reference
directory. References are limited to 500 text files / 20 MiB; a single-file
target or a primary to 2 MiB; quotable files inside a candidate to 2 MiB
each. Hidden entries and common dependency/output directories are skipped
during reference traversal; reference symlinks are rejected, candidate
symlinks are dropped from the copy. Reviewers, verifiers and the evaluator
work in the frozen workspace; the reviser works inside the candidate copy.
Evidence from outside the snapshot cannot authorize readiness.

## Markdown reports with small decision records

A review starts with YAML frontmatter, followed by the normal Markdown
assessment. This is a small automation interface, not a schema for every
paragraph of reasoning:

```markdown
---
findings:
  - id: F1
    severity: blocking
    kind: defect
    claim: |-
      The plan starts at full traffic contrary to the staged rollout requirement.
    acceptance_check: |-
      Specify a 10% initial rollout and the required advancement condition.
    evidence:
      - path: /run/workspace/candidate-v0.md
        quote: |-
          starts with 100% of traffic immediately
recommendation: revise
---

## Assessment
Explain the evidence, counterevidence, implications and suggested fix.
```

Code assigns global IDs and preserves all review origins. Only an exact
normalized claim **and** acceptance-check match merges findings; fuzzy
matching cannot erase minority issues. Re-raised findings reopen, and
severity can increase but cannot silently decrease.

Code checks that each cited file is in the frozen source set and that the
verbatim quote occurs in that exact version. Code supplies hashes; the
model cannot invent them. Valid quotation does not prove the surrounding
claim or entailment; that remains a semantic verification task.

Introductory prose before the decision record is tolerated and preserved;
the first unfenced YAML record must still pass the complete strict schema.
Prompts use literal block scalars for free-text fields so source quotations
containing colons do not become accidental YAML mappings.

Malformed frontmatter gets one format-repair invocation, charged against
the same job/deadline limits. Both original and repaired responses remain
available. Exhausted format repair stops the run; it does not discard the
prose or permit readiness. Transport errors stop the run in this version;
there is no automatic network retry.

In readiness loops, a failed required review seat prevents synthesis from
starting. Advisory `investigate` runs may still synthesize a partial panel,
with incomplete execution status and visible missing seats.

## Blocker resolution

Kinds are `defect`, `evidence`, and `decision`. Statuses are `open`,
`fix_proposed`, `disputed`, `resolved`, and `refuted`.

A separate verifier invocation must account for every registry ID exactly
once. It records its disposition, rationale, exact quotes, evidence hashes,
candidate hash, report path, timestamp, and invocation identity. A resolved
fix must cite the current candidate. Missing evidence stays open; disputes
stay unresolved. Verifiers cannot emit `accepted_risk`, delete findings,
or change their severity. Human risk-acceptance overrides are not implemented.

The engine prevents the revision-author invocation from being its verifier.
Fresh Codex/Claude sessions are used, without resume flags. A different
harness is the default for model diversity, but separate sessions of the
same harness are supported. Fresh context is not proof of statistical
independence. All previously resolved findings are reverified against each
new candidate so old acceptance cannot silently carry forward.

## Readiness policy

The default policy requires blocking **and major** findings to be resolved
or refuted; the library can additionally require minor findings. Blocking
findings cannot be excluded. The CLI uses the mechanical gates from the
resolved rubric; natural-language criteria do not create mechanical gates.

Code requires completed review coverage, current verification records,
passing mechanical checks, and a passing independent final evaluation,
all bound to the same candidate hash. Sources and reference originals are
checked for changes during the run. The final evaluation sees only the
candidate, frozen references, and criteria, not council recommendations.
If consulted again after a revision, that reuse is recorded; this is not a
claim that the same model remains statistically held out.

`readiness` rechecks the recorded policy, source and artifact hashes,
resolution freshness, mechanical-check coverage, and final evaluation.
Use it immediately before consuming the candidate. It does not rerun model
judgments or execute a deployment. Run artifacts are locally trusted audit
records, not signed attestations resistant to someone rewriting every
record and its hash.

Readiness means the configured checks passed; it does not certify objective
truth, professional approval, or operational authorization. Evidence
completeness and the semantic quality of the reviews remain model judgments.

## Limits and terminal states

Defaults: 3 revision attempts, 2 targeted investigation waves, 40 total
agent invocations (including format repairs), 3 concurrent reviewers, 600
seconds per agent, a 1200-second total deadline, a plateau of 2 attempts,
and `on_regression: continue`. See
[stop rules](#metrics-thresholds-and-stop-rules) for every condition. A
hard deadline cancels active work, including running checks and metrics;
pending jobs cannot spend beyond the invocation limit.

| Outcome | Meaning | Exit code |
| --- | --- | --- |
| `ready` | Recorded policy passed for this candidate | 0 |
| `needs_evidence` | A necessary source or unresolved dispute remains | 2 |
| `needs_user_input` | An author's consequential decision is required | 2 |
| `stalled` | Plateau, a regression under `on_regression: stop`, or a revision that changed nothing or repeated a version | 2 |
| `exhausted` | Revision, invocation, or time budget reached | 2 |
| `failed` | Execution, decision validation, or evidence integrity failed | 1 |
| `cancelled` | User interrupted the run | 130 |

Budget exhaustion never relaxes readiness. Harness billing is external;
spend is recorded as unknown, not zero. No dollar cap is claimed. There is
no automatic source overwrite, deployment, resumable controller, external
question-answer channel, or human override endpoint. To supply missing
information, update the source/reference material and start a new run.

The read-only adapters and source hashes do not provide OS-level isolation
between all agent sessions. Runtime user configuration/hooks may still
affect execution, and peer artifact isolation is a prompt constraint. The
revision session is a real write session: Codex is confined by its
`workspace-write` sandbox; Claude Code is confined only by its permission
allowlist (no `--dangerously-skip-permissions` is ever passed) and its
`Bash` tool can do what your user can. Edits to the original target or the
frozen references are detected by hash and fail the run, but detection is
not prevention. For untrusted repositories or stronger guarantees, run the
harnesses in separate restricted containers, and prefer `--reviser codex`.
Command checks come from your rubric or flags and run unsandboxed, like the
project's own build scripts. On Windows, timeout/cancellation currently
terminates the immediate process only; POSIX terminates its process group.

## Testing

`npm test` includes no-network tests for the registry, stale evidence,
independent verification, final evaluation, limits, cancellations, and the
full revise/review flow. To run the explicit paid/authenticated integration
smoke test, use `RUN_LIVE_TESTS=1 npm run test:agents:live` after building.
Both harnesses must have working account access. Real quality evaluation
still needs a larger defect corpus and clean controls; a plumbing smoke
test is not a benchmark of review accuracy.
