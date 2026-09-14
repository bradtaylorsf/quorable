# Bounded revision loops and readiness

`quorable revise` reviews a Markdown/text document, keeps a persistent
finding registry, asks an agent to propose a revised document, independently
verifies fixes, and evaluates a readiness policy. The source document is
never overwritten. Each proposed version is a new file in the run directory.

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

Run `npm run build` first when using `node dist/cli/main.js` from this repo.
The chosen CLI harnesses must be installed and authenticated. Override an
executable for testing or a separately installed version with
`QUORABLE_CODEX_BIN` or `QUORABLE_CLAUDE_BIN`; values are executable paths,
not shell commands. Harness specifications accept `codex:MODEL_ID` and
`claude:MODEL_ID`.

## Execution and artifacts

The controller snapshots the primary and explicit text context, then:

1. Runs the independent persona council and synthesis.
2. Validates each review's small decision record and registers findings.
3. Starts a separate verifier invocation to account for every finding.
4. Investigates unresolved evidence/disputes within the investigation limit.
5. Runs rubric mechanical gates on the exact candidate.
6. If eligible, starts a fresh final evaluator that is not given panel reports.
7. Otherwise, asks the revision agent for a complete proposed document,
   writes a new candidate, and reviews it again within the remaining limits.

The implementation performs a full council review after every revision.
Focused re-review is a possible optimization after quality measurement.

| Artifact | Contents |
| --- | --- |
| `workspace/candidate-vN.md` | Versioned candidates; code writes these from revision responses |
| `workspace/references/` | Frozen copies of explicitly supplied text context |
| `round-N/` | Each council's Markdown reviews, synthesis, and run metadata |
| `agents/job-NNN.prompt.md` | Exact assignment for every invocation, including format repairs |
| `agents/job-NNN.md` | Final response, including failed/invalid responses when available |
| `agents/job-NNN.log` | Harness stderr when emitted |
| `findings.yaml` | Stable finding IDs, origins, evidence, and disposition history |
| `run.yaml` | Policy, limits, versions, hashes, agent job history, checks and outcome |
| `readiness_report.md` | Human-readable result and link to the candidate |

The loop output must be new and outside any reference directory. References
are limited to 500 text files / 20 MiB; primary text to 2 MiB. Hidden entries
and common dependency/output directories are skipped during directory
traversal. Reference symlinks are rejected. The loop's working directory is
the frozen workspace, not the original project; include required project
evidence explicitly with `--context`. Evidence from outside the snapshot
cannot authorize readiness in this version.

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

Defaults: 3 revisions, 2 targeted investigation waves, 40 total agent
invocations (including format repairs), 3 concurrent reviewers, 600 seconds
per agent, and a 1200-second total deadline. Stop after 2 revisions without
verified finding resolution, or immediately if a revision repeats a prior
candidate hash. A hard deadline cancels active work; pending jobs cannot
spend beyond the invocation limit.

| Outcome | Meaning | Exit code |
| --- | --- | --- |
| `ready` | Recorded policy passed for this candidate | 0 |
| `needs_evidence` | A necessary source or unresolved dispute remains | 2 |
| `needs_user_input` | An author's consequential decision is required | 2 |
| `stalled` | No verified progress or a repeated candidate | 2 |
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
affect execution, and peer artifact isolation is a prompt constraint.
For adversarial documents or stronger guarantees, run the harnesses in
separate restricted containers. On Windows, timeout/cancellation currently
terminates the immediate process only; POSIX terminates its process group.

## Testing

`npm test` includes no-network tests for the registry, stale evidence,
independent verification, final evaluation, limits, cancellations, and the
full revise/review flow. To run the explicit paid/authenticated integration
smoke test, use `RUN_LIVE_TESTS=1 npm run test:agents:live` after building.
Both harnesses must have working account access. Real quality evaluation
still needs a larger defect corpus and clean controls; a plumbing smoke
test is not a benchmark of review accuracy.
