import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { workspacePolicy } from './workspaces.mjs';
import { codexBackend } from './codex.mjs';
import { Workflow } from './runtime.mjs';

const execute = promisify(execFile);
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'workflow-worktree-test-'));
  // This fixture owns the entire temporary repository and all worktrees.
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, 'repo'), worktreeRoot = join(root, 'workers');
  await mkdir(cwd); await mkdir(worktreeRoot);
  const git = async args => (await execute('git', ['-C', cwd, '-c', 'core.hooksPath=/dev/null', ...args])).stdout.trim();
  await git(['init']); await writeFile(join(cwd, 'baseline.txt'), 'baseline');
  await git(['add', 'baseline.txt']);
  await git(['-c', 'user.name=Runtime Test', '-c', 'user.email=runtime@example.invalid', 'commit', '-m', 'fixture']);
  return { root, cwd, worktreeRoot, baseCommit: await git(['rev-parse', 'HEAD']) };
}

test('worktrees use an explicit immutable baseline and retain independent outputs', async t => {
  const f = await fixture(t), events = [];
  await writeFile(join(f.cwd, 'baseline.txt'), 'user dirty checkout');
  const policy = workspacePolicy(f.cwd, { mode: 'workspace-write', worktreeRoot: f.worktreeRoot, baseCommit: f.baseCommit });
  const context = { signal: new AbortController().signal, emit: event => events.push(event) };
  const [a, b] = await Promise.all([policy.allocate({ isolation: 'worktree' }, context), policy.allocate({ isolation: 'worktree' }, context)]);
  assert.notEqual(a, b);
  assert.equal(await readFile(join(a, 'baseline.txt'), 'utf8'), 'baseline');
  await writeFile(join(a, 'baseline.txt'), 'worker A');
  assert.equal(await readFile(join(b, 'baseline.txt'), 'utf8'), 'baseline');
  assert.equal(await readFile(join(f.cwd, 'baseline.txt'), 'utf8'), 'user dirty checkout');
  assert.equal(events.filter(e => e.type === 'workspace.ready').length, 2);
});

test('invalid, overlapping and cancelled workspace requests cannot dispatch', async t => {
  const f = await fixture(t);
  assert.throws(() => workspacePolicy(f.cwd, { mode: 'danger-full-access' }), /unsupported/);
  assert.throws(() => workspacePolicy(f.cwd, { worktreeRoot: f.worktreeRoot }), /together/);
  assert.throws(() => workspacePolicy(f.cwd, { worktreeRoot: f.worktreeRoot, baseCommit: 'HEAD' }), /full commit/);
  await assert.rejects(workspacePolicy(f.cwd, { worktreeRoot: f.cwd, baseCommit: f.baseCommit }).prepare(), /separate/);
  const policy = workspacePolicy(f.cwd, { worktreeRoot: f.worktreeRoot, baseCommit: f.baseCommit });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(policy.allocate({ isolation: 'worktree' }, { signal: controller.signal, emit() { assert.fail('allocated after abort'); } }), /abort/i);
});

test('unchanged PDCA JS completes through mock SDK with explicit write/worktree policy', async t => {
  const f = await fixture(t), starts = [];
  const roleResults = {
    'builder.md': { artifacts: [], measurement_points: [] },
    'build-verifier.md': { verdict: 'pass', findings: [], frozen_harness_digest_ok: true, frozen_harness_touched: false },
    'runner.md': { condition_id: 'single', run_index: 1, executed: true, observations: 'mock observation' },
    'verifier.md': { condition_id: 'single', run_index: 1, measured: true, score: 1, criteria_checks: [], frozen_harness_digest_ok: true },
    'mechanism-analyst.md': { mechanisms: [{ statement: 'mock mechanism', evidence: 'mock observation',
      alternative_explanations: [], identified: true }], criteria_validity: 'mock only', unmeasured: [], gap: '' },
    'mechanism-arbiter.md': { pairs: [{ a: 0, b: 0 }] },
  };
  class MockCodex {
    startThread(options) {
      const start = { ...options };
      starts.push(start);
      return { async runStreamed(prompt) {
        start.role = prompt.match(/\/agents\/([a-z-]+\.md)/)[1];
        const result = roleResults[start.role];
        assert.ok(result, `unmocked PDCA role: ${start.role}`);
        return { events: (async function* () {
          yield { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({json:JSON.stringify(result)}) } };
          yield { type: 'turn.completed', usage: { input_tokens: 0, output_tokens: 0 } };
        })() };
      } };
    }
  }
  const result = await Workflow({
    scriptPath: fileURLToPath(new URL('../../../pdca/scripts/pdca.js', import.meta.url)),
    args: { skillDir: '/mock/pdca', plan: 'mock only', runsPerCondition: 1,
      successCriteria: { text: 'mock match', metric: 'match', higher_is_better: true },
      frozenHarness: { path: '/mock/run/frozen', entry: 'score.py', digest: 'mock-digest', class: 'deterministic_script',
        criteria: { metric: 'match', higher_is_better: true, threshold: 1 } } },
  }, { trustedSource: true, runDir: join(f.root, 'run'), maxAgents: 16, timeoutMs: 5000,
    requirements: ['workspace-write', 'worktree'],
    backend: codexBackend({ cwd: f.cwd, CodexClass: MockCodex, modelMap: { opus: 'mock', sonnet: 'mock' },
      workspace: { mode: 'workspace-write', worktreeRoot: f.worktreeRoot, baseCommit: f.baseCommit } }),
  });
  assert.equal(result.status, 'ok'); assert.equal(result.confidence, 'inconclusive');
  assert.deepEqual(result.check.mechanisms.map(m => m.corroboration), ['corroborated']);
  const roleCounts = {};
  for (const s of starts) roleCounts[s.role] = (roleCounts[s.role] ?? 0) + 1;
  assert.deepEqual(roleCounts, { 'builder.md': 1, 'build-verifier.md': 1, 'runner.md': 1, 'verifier.md': 3,
    'mechanism-analyst.md': 2, 'mechanism-arbiter.md': 1 });
  const [runner] = starts.filter(s => s.role === 'runner.md'), shared = starts.filter(s => s.role !== 'runner.md');
  assert.ok(shared.every(s => s.workingDirectory !== runner.workingDirectory));
  assert.equal(new Set(shared.map(s => s.workingDirectory)).size, 1);
  assert.ok(starts.every(x => x.sandboxMode === 'workspace-write' && x.approvalPolicy === 'never'));
});
