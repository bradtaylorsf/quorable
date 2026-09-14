/** Opt-in real CLI integration; uses each selected harness's authentication and billing. */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { parse } from 'yaml';
if (process.env.RUN_LIVE_TESTS !== '1') {
  console.error('Live agents incur usage. Opt in with RUN_LIVE_TESTS=1.');
  process.exit(1);
}
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cli = path.join(root, 'dist/cli/main.js');
const fixture = path.join(root, 'fixtures/investigation-smoke');
const output = path.join(root, 'runs', `live-agents-${new Date().toISOString().replace(/[:.]/g, '-')}`);
const agents = (process.env.QUORABLE_SMOKE_AGENTS || 'codex,claude').split(',');
assert(agents.length > 0 && agents.every((a) => a === 'codex' || a === 'claude'));
fs.mkdirSync(output, { recursive: true });
const criteria = 'This fictional rollout plan must match the authoritative reference: name both owners, use 10% initial traffic, advance only after 24 hours below 1% errors, roll back above 2% for five minutes, and accurately describe approval status. Keep it under 250 words. A separate public release note is outside scope. Check documentary consistency, not actual operational authorization. Keep reports concise.';
async function run(args) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd: root, stdio: 'inherit', shell: false });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`CLI exited ${code}. Artifacts: ${output}`)));
  });
}
const target = path.join(fixture, 'draft.md');
const original = fs.readFileSync(target, 'utf8');
const selected = agents.flatMap((a) => ['--agent', a]);
const common = [target, '--context', path.join(fixture, 'reference.md'), '--criteria', criteria, '--persona', 'skeptical_expert', ...selected];
const synthesizer = agents.at(-1);
await run(['investigate', ...common, '--synthesizer', synthesizer, '--timeout', '180', '--out', path.join(output, 'council')]);
const council = parse(fs.readFileSync(path.join(output, 'council/run.yaml'), 'utf8'));
assert.equal(council.status, 'completed');
assert.deepEqual(council.jobs.filter((j) => j.role === 'review').map((j) => j.agent.harness), agents);
await run(['revise', ...common, '--synthesizer', synthesizer, '--reviser', agents[0], '--verifier', synthesizer,
  '--evaluator', synthesizer, '--max-revisions', '2', '--max-jobs', '24', '--max-elapsed', '1200', '--timeout', '180',
  '--out', path.join(output, 'loop')]);
await run(['readiness', path.join(output, 'loop')]);
const loop = parse(fs.readFileSync(path.join(output, 'loop/run.yaml'), 'utf8'));
const registry = parse(fs.readFileSync(path.join(output, 'loop/findings.yaml'), 'utf8')).findings;
assert.equal(loop.status, 'ready');
assert(loop.revisions >= 1, 'Seeded defects must require a revision');
assert(registry.length > 0, 'The seeded defects must produce findings');
assert(registry.some((f) => f.history.some((h) => h.disposition === 'resolved')), 'At least one fix must be verified');
assert.equal(fs.readFileSync(target, 'utf8'), original, 'Source must not be overwritten');
const candidate = fs.readFileSync(loop.candidate.path, 'utf8');
assert(candidate.trim().split(/\s+/).length < 250, 'Candidate must remain below the fixture word limit');
for (const required of ['Maya Chen', 'Luis Ortega', '10%', '24', '1%', '2%']) assert(candidate.includes(required), `Candidate missing ${required}`);
fs.writeFileSync(path.join(output, 'smoke-result.md'), `# Live integration smoke\n\nPassed: ${agents.join(', ')}.\n\nA real council completed, the seeded document was revised, fixes were independently verified, and the recorded readiness passed a freshness recheck. Original source unchanged.\n\nThis checks plumbing and a small seeded fixture, not general model quality.\n`);
console.log(`Live smoke passed. Artifacts: ${output}`);
