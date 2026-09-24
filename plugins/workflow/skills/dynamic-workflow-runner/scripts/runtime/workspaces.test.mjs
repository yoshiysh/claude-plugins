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
  const policy = workspacePolicy(f.cwd, { mode: 'read-only', worktreeRoot: f.worktreeRoot, baseCommit: f.baseCommit });
  const context = { signal: new AbortController().signal, emit: event => events.push(event) };
  const [a, b] = await Promise.all([policy.allocate({ isolation: 'worktree' }, context), policy.allocate({ isolation: 'worktree' }, context)]);
  assert.notEqual(a, b);
  assert.equal(await readFile(join(a, 'baseline.txt'), 'utf8'), 'baseline');
  await writeFile(join(a, 'baseline.txt'), 'worker A');
  assert.equal(await readFile(join(b, 'baseline.txt'), 'utf8'), 'baseline');
  assert.equal(await readFile(join(f.cwd, 'baseline.txt'), 'utf8'), 'user dirty checkout');
  assert.equal(events.filter(e => e.type === 'workspace.ready').length, 2);
});

test('a queued worktree setup checks cancellation before allocating its directory', async t => {
  const f = await fixture(t), events = [];
  const policy = workspacePolicy(f.cwd, { mode: 'read-only', worktreeRoot: f.worktreeRoot, baseCommit: f.baseCommit });
  const queuedController = new AbortController();
  let queuedResult;
  const first = policy.allocate({ isolation: 'worktree' }, {
    signal: new AbortController().signal,
    emit(event) {
      events.push(event);
      if (event.type === 'workspace.allocated' && !queuedResult) {
        queuedResult = policy.allocate({ isolation: 'worktree' }, {
          signal: queuedController.signal,
          emit: queuedEvent => events.push(queuedEvent),
        }).then(value => ({ value }), error => ({ error }));
        queueMicrotask(() => queuedController.abort());
      }
    },
  });
  await first;
  const result = await queuedResult;
  assert.match(result.error?.message ?? '', /abort/i);
  assert.equal(events.filter(event => event.type === 'workspace.allocated').length, 1);
  assert.equal(events.filter(event => event.type === 'workspace.ready').length, 1);
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

test('workspace policies never advertise update capabilities', async t => {
  const f = await fixture(t);
  const writable = workspacePolicy(f.cwd, { mode: 'workspace-write' });
  assert.deepEqual(writable.capabilities, ['read-only', 'fresh-thread', 'workspace-write']);
  await writable.prepare();

  const readOnly = workspacePolicy(f.cwd, {});
  assert.deepEqual(readOnly.capabilities, ['read-only', 'fresh-thread']);
  await readOnly.prepare();

  const contract = { targetDir: join(f.cwd, 'target'), stagingDir: join(f.cwd, 'staging') };
  assert.throws(() => codexBackend({ cwd: f.cwd, updateContract: contract }), /unsupported Codex backend field: updateContract/);
});

test('workspace-write rejects a worktree-isolated dispatch before opening its SDK thread', async t => {
  const f = await fixture(t), starts = [];
  class MockCodex {
    startThread(options) {
      starts.push(options);
      return { async runStreamed() { return { events: (async function* () {
        yield { type: 'item.completed', item: { type: 'agent_message', text: 'done' } };
        yield { type: 'turn.completed', usage: {} };
      })() }; } };
    }
  }
  const scriptPath = join(f.root, 'flow.js');
  await writeFile(scriptPath, `export const meta={name:'handoff',description:'test',requirements:['workspace-write','worktree']}; await agent('shared'); return await agent('isolated',{isolation:'worktree'});`);
  await assert.rejects(Workflow({ scriptPath, args: {} }, {
    trustedSource: true, runDir: join(f.root, 'run'), requirements: ['workspace-write', 'worktree'],
    backend: codexBackend({ cwd: f.cwd, CodexClass: MockCodex, model: 'test-model', modelReasoningEffort: 'low',
      workspace: { mode: 'workspace-write', worktreeRoot: f.worktreeRoot, baseCommit: f.baseCommit } }),
  }), /workspace-write cannot use worktree isolation/);
  assert.equal(starts.length, 1);
});

test('unchanged PDCA JS fails closed when shared workspace-write meets worktree isolation', async t => {
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
  await assert.rejects(Workflow({
    scriptPath: fileURLToPath(new URL('../../../pdca/scripts/pdca.js', import.meta.url)),
    args: { skillDir: '/mock/pdca', plan: 'mock only', runsPerCondition: 1,
      successCriteria: { text: 'mock match', metric: 'match', higher_is_better: true },
      frozenHarness: { path: '/mock/run/frozen', entry: 'score.py', digest: 'mock-digest', class: 'deterministic_script',
        criteria: { metric: 'match', higher_is_better: true, threshold: 1 } } },
  }, { trustedSource: true, runDir: join(f.root, 'run'), maxAgents: 16, timeoutMs: 5000,
    requirements: ['workspace-write', 'worktree'],
    backend: codexBackend({ cwd: f.cwd, CodexClass: MockCodex, modelMap: { opus: 'mock', sonnet: 'mock' },
      workspace: { mode: 'workspace-write', worktreeRoot: f.worktreeRoot, baseCommit: f.baseCommit } }),
  }), /workspace-write cannot use worktree isolation/);
});
