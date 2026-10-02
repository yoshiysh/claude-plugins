import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, realpath, rename, rm, symlink } from 'node:fs/promises';
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
  assert.deepEqual(events.map(e => e.type), [
    'workspace.allocated', 'workspace.ready', 'workspace.allocated', 'workspace.ready',
  ]);
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

test('workspace-write rejects an isolated dispatch before opening its SDK thread', async t => {
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
  await writeFile(scriptPath, `export const meta={name:'handoff',description:'test'}; await agent('shared'); return await agent('isolated',{isolation:'worktree'});`);
  await assert.rejects(Workflow({ scriptPath, args: {} }, {
    trustedSource: true, runDir: join(f.root, 'run'), requirements: ['workspace-write', 'worktree'],
    backend: codexBackend({ cwd: f.cwd, CodexClass: MockCodex, model: 'test-model',
      modelReasoningEffort: 'low', workspace: { mode: 'workspace-write', worktreeRoot: f.worktreeRoot, baseCommit: f.baseCommit } }),
  }), /workspace-write cannot use worktree isolation/);
  assert.equal(starts.length, 1);
});

test('update scopes workspace-write to a nested staging cwd and keeps other phases read-only', async t => {
  const f = await fixture(t);
  const canonicalRoot = await realpath(f.root);
  const targetRoot = join(canonicalRoot, 'targets'), stagingRoot = join(canonicalRoot, 'staging-root');
  await mkdir(targetRoot); await mkdir(stagingRoot);
  const updateContract = { targetRoot, stagingRoot,
    targetDir: join(targetRoot, 'target'), stagingDir: join(stagingRoot, 'staging-update') };
  await mkdir(updateContract.targetDir); await mkdir(updateContract.stagingDir);
  const policy = workspacePolicy(f.cwd, {}, updateContract);
  assert.deepEqual(policy.capabilities, ['read-only', 'fresh-thread']);
  await policy.prepare();
  const context = { signal: new AbortController().signal, emit() {} };
  for (const phase of ['Find', 'Verify', 'Reverify']) {
    assert.equal(await policy.allocate({ phase }, context), await realpath(f.cwd));
    assert.equal(policy.modeFor({ phase }), 'read-only');
  }
  assert.equal(await policy.allocate({ phase: 'Update' }, context), await realpath(updateContract.stagingDir));
  assert.equal(policy.modeFor({ phase: 'Update' }), 'workspace-write');
  assert.ok(!policy.capabilities.includes('staging-write'));
  await assert.doesNotReject(policy.validateDispatch({ phase: 'Update' }, updateContract.stagingDir));
  const replacedStagingRoot = join(canonicalRoot, 'staging-root-original');
  await rename(stagingRoot, replacedStagingRoot);
  await symlink(replacedStagingRoot, stagingRoot);
  await assert.rejects(policy.validateDispatch({ phase: 'Update' }, updateContract.stagingDir), /real directory/);

  assert.throws(() => workspacePolicy(f.cwd, { mode: 'workspace-write' }, {
    targetRoot: updateContract.targetRoot, stagingRoot: updateContract.stagingRoot,
    targetDir: updateContract.targetDir, stagingDir: updateContract.stagingDir,
  }), /read-only base workspace/);
  for (const [key, value] of [['targetDir', join(f.root, 'outside')], ['stagingDir', join(f.root, 'outside-staging')]]) {
    const invalid = { ...updateContract, [key]: value };
    assert.throws(() => workspacePolicy(f.cwd, {}, invalid), /roots and directories/);
  }
  assert.throws(() => workspacePolicy(f.cwd, {}, {
    targetRoot: updateContract.targetRoot,
    stagingRoot: updateContract.stagingRoot,
    targetDir: updateContract.targetDir,
    stagingDir: updateContract.targetDir,
  }), /roots and directories/);
  assert.throws(() => workspacePolicy(f.cwd, {}, {
    targetRoot: updateContract.targetRoot,
    stagingRoot: updateContract.stagingRoot,
    targetDir: 'relative', stagingDir: updateContract.stagingDir,
  }), /absolute/);
});
