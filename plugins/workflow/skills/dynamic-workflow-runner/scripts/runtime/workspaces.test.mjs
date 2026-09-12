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

async function mockPdca(f, { rejectBuild = false } = {}) {
  const starts = [], calls = [];
  class MockCodex {
    startThread(options) {
      starts.push(options);
      return { async runStreamed(prompt) {
        const role = prompt.match(/\/agents\/([\w-]+)\.md/)?.[1];
        const call = { role, prompt, options };
        calls.push(call);
        let result;
        if (role === 'builder') result = { artifacts: [], measurement_points: [] };
        else if (role === 'build-verifier') result = rejectBuild
          ? { verdict: 'revise', findings: [{ lens: 'contract', severity: 'blocker', claim: 'missing measurement', why_it_breaks_measurement: 'mock rejection' }] }
          : { verdict: 'pass', findings: [] };
        else if (role === 'runner') {
          assert.equal(calls.at(-2).role, 'build-verifier');
          assert.equal(await readFile(join(options.workingDirectory, 'baseline.txt'), 'utf8'), 'baseline');
          await writeFile(join(options.workingDirectory, 'run-output.txt'), 'mock observation');
          result = { condition_id: 'single', run_index: 1, executed: true, observations: 'mock observation' };
        } else if (role === 'verifier') {
          call.lens = prompt.match(/\[LENS\]: (\w+)/)?.[1];
          result = { condition_id: 'single', run_index: 1, measured: true, criteria_checks: [],
            ...(call.lens === 'criteria' ? { score: 1 } : {}) };
        } else if (role === 'mechanism-analyst') {
          call.seat = prompt.match(/\[SEAT\]: (\w+)/)?.[1];
          result = { mechanisms: [], criteria_validity: `mock analyst ${call.seat} only`, unmeasured: [], gap: '' };
        } else if (role === 'mechanism-arbiter') result = { pairs: [] };
        else assert.fail(`unexpected PDCA role: ${role}`);
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
      successCriteria: { text: 'mock match', metric: 'match', higher_is_better: true } },
  }, { trustedSource: true, runDir: join(f.root, 'run'), maxAgents: 9, timeoutMs: 10000,
    requirements: ['workspace-write', 'worktree'],
    backend: codexBackend({ cwd: f.cwd, CodexClass: MockCodex, modelMap: { opus: 'mock', sonnet: 'mock' },
      workspace: { mode: 'workspace-write', worktreeRoot: f.worktreeRoot, baseCommit: f.baseCommit } }),
  });
  return { result, starts, calls };
}

test('unchanged PDCA JS mock control-flow covers current roles and temporary worktree isolation only', async t => {
  const f = await fixture(t);
  await writeFile(join(f.cwd, 'baseline.txt'), 'user dirty checkout');
  const { result, starts, calls } = await mockPdca(f);
  assert.equal(result.status, 'ok'); assert.equal(result.confidence, 'inconclusive');
  assert.equal(starts.length, 9);
  assert.deepEqual(calls.map(c => c.role), ['builder', 'build-verifier', 'runner',
    'verifier', 'verifier', 'verifier', 'mechanism-analyst', 'mechanism-analyst', 'mechanism-arbiter']);
  assert.deepEqual(calls.filter(c => c.role === 'verifier').map(c => c.lens).sort(), ['authenticity', 'contract', 'criteria']);
  const analysts = calls.filter(c => c.role === 'mechanism-analyst');
  assert.deepEqual(analysts.map(c => c.seat).sort(), ['A', 'B']);
  assert.ok(analysts.every(c => !c.prompt.includes('mock analyst')));
  assert.equal(new Set(calls.map(c => c.options)).size, 9);
  const runnerDirectory = calls.find(c => c.role === 'runner').options.workingDirectory;
  assert.notEqual(runnerDirectory, f.cwd);
  assert.equal(await readFile(join(runnerDirectory, 'run-output.txt'), 'utf8'), 'mock observation');
  await assert.rejects(readFile(join(f.cwd, 'run-output.txt')), { code: 'ENOENT' });
  assert.equal(await readFile(join(f.cwd, 'baseline.txt'), 'utf8'), 'user dirty checkout');
  // The SDK canonicalizes cwd (e.g. /var to /private/var on macOS).
  // This proves allocation/control-flow, not builder artifact delivery or live model behavior.
  assert.ok(calls.filter(c => c.role !== 'runner').every(c => c.options.workingDirectory === starts[0].workingDirectory));
  assert.equal(result.build_review.verdict, 'pass');
  assert.equal(result.check.results.per_condition[0].measured_n, 1);
  assert.equal(result.check.results.per_condition[0].mean_score, 1);
  assert.deepEqual(result.ledger_entries.find(e => e.type === 'do_run').payload.lenses_applied,
    ['criteria', 'authenticity', 'contract']);
  assert.ok(starts.every(x => x.sandboxMode === 'workspace-write' && x.approvalPolicy === 'never'));
});

test('PDCA build rejection exhausts bounded revisions without dispatching a runner', async t => {
  const f = await fixture(t);
  const { result, calls } = await mockPdca(f, { rejectBuild: true });
  assert.equal(result.status, 'BLOCKED');
  assert.match(result.reason, /measurement 契約/);
  assert.deepEqual(calls.map(c => c.role), ['builder', 'build-verifier', 'builder', 'build-verifier', 'builder', 'build-verifier']);
  assert.equal(result.build_attempts.length, 3);
  assert.ok(result.build_attempts.every(a => a.verdict === 'revise' && a.blockers_majors === 1));
  assert.ok(calls.filter(c => c.role === 'builder').slice(1).every(c => c.prompt.includes('[BUILD_FINDINGS]')));
  assert.ok(!result.ledger_entries.some(e => e.type === 'do_run'));
});
