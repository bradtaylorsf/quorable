# Agent-loop integration results — September 11, 2026

## Follow-up: mixed-provider live test passed

After Claude access was restored, the real Codex/Claude smoke test passed
on September 11 (September 12 UTC). Both providers reviewed the seeded
document; Claude synthesized, Codex revised, and Claude verified the fixes
and performed a fresh final evaluation. The loop reached `ready` after one
revision and ten invocations, and the separate `readiness` command passed.
The smoke assertions confirmed the original source was unchanged and the
candidate preserved the required rollout facts under the word limit.

Artifacts: `runs/live-agents-2026-09-12T03-50-06-528Z/`, including
`smoke-result.md` and `loop/readiness_report.md`.

The first authenticated mixed attempt uncovered two formatting problems:
introductory prose before the decision record and a colon in an unquoted
YAML evidence value. The parser now tolerates introductory prose while
retaining strict schema validation; prompts use literal block scalars for
free-text fields. A required-seat failure also prevents synthesis in a
readiness loop. The failed run remains under
`runs/live-agents-2026-09-12T03-42-37-156Z/`. The fresh successful run required
no decision-record repairs. All 340 TypeScript tests passed after the fixes.

## Original test session

The live fixture is a fictional rollout plan with an authoritative reference.
It contains incorrect approval status, immediate full-traffic rollout, vague
rollback behavior, and no named rollback owner.

| Test | Observed result |
| --- | --- |
| Original installed Codex CLI, 0.144.1 | Failed: configured `gpt-6-astra` required a newer CLI |
| Separately installed Codex CLI, 0.154.0 | Review and synthesis completed using `gpt-6-astra` |
| Full Codex revision loop | Ready after one revision, eight fresh agent invocations |
| Finding verification | Three blocking findings and one major finding recorded as resolved, each with evidence and verifier history |
| Original source preservation | Source unchanged; proposed document saved as candidate-v1.md |
| Clean control | Ready without revision, three fresh invocations |
| Clean-control mechanical gate | Word count passed against the exact candidate |
| Post-run readiness command | Passed source, report, registry and candidate freshness checks |
| Claude Code CLI, 2.1.243 | Actual invocation failed: organization disabled Claude subscription access |

Claude Code was logged in, but the service returned:

> Your organization has disabled Claude subscription access for Claude Code

It requested an Anthropic API key or administrator enablement. No Anthropic
API key was available in the existing Quorable configuration. Access was not
bypassed. A mixed Codex/Claude live run could not be verified in that original
session. The follow-up above closes this gap with an authenticated run;
the earlier deterministic tests alone did not establish that result.

The Codex upgrade was installed under `/tmp/quorable-smoke-tools`, leaving
the user's existing CLI installation in place. Tests selected it with
`QUORABLE_CODEX_BIN=/tmp/quorable-smoke-tools/node_modules/.bin/codex`.

Local live artifacts from this session:

- Initial mixed attempt: `/tmp/quorable-live-investigation-20260911/`
- Updated Codex council: `/tmp/quorable-live-codex-updated-20260911/`
- Full revision loop: `/tmp/quorable-live-revision-20260911/`
- Clean control with artifact freshness hashes: `/tmp/quorable-live-clean-20260911/`

The full revision run began before the post-run `readiness` command's
additional report/registry manifest hashes were added. It exercised the
controller's inline readiness checks; the subsequent clean control exercised
the final manifest format and post-run readiness command. No old manifest
was retroactively fabricated to make the new check pass.

To repeat with both CLIs after Claude access is restored:

```bash
npm run build
RUN_LIVE_TESTS=1 npm run test:agents:live
```

Use `QUORABLE_CODEX_BIN` if the default installed CLI still needs updating.
`QUORABLE_SMOKE_AGENTS=codex` selects a single-provider smoke test with fresh
review/revision/verification sessions; the default requires both harnesses.
These are plumbing and small seeded-defect tests, not a general quality
benchmark or proof of statistical independence between models.
