import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

test('a worktree writer and a shared-checkout reader complete through mock SDK with explicit write/worktree policy', async t => {
  const f = await fixture(t), starts = [];
  const scriptPath = join(f.root, 'two-roles.flow');
  await writeFile(scriptPath, `export const meta = {name:'two-roles',description:'worktree writer and shared reader'};
    const RESULT = {type:'object',properties:{done:{type:'boolean'}},required:['done'],additionalProperties:false};
    const written = await agent('Read /mock/agents/writer.md', {model:'opus',label:'writer',schema:RESULT,isolation:'worktree'});
    const read = await agent('Read /mock/agents/reader.md', {model:'sonnet',label:'reader',schema:RESULT});
    return {status:'ok',written,read};`);
  class MockCodex {
    startThread(options) {
      const start = { ...options };
      starts.push(start);
      return { async runStreamed(prompt) {
        start.role = prompt.match(/\/agents\/([a-z-]+\.md)/)[1];
        return { events: (async function* () {
          yield { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({json:JSON.stringify({ done: true })}) } };
          yield { type: 'turn.completed', usage: { input_tokens: 0, output_tokens: 0 } };
        })() };
      } };
    }
  }
  const result = await Workflow({ scriptPath, args: {} },
    { trustedSource: true, runDir: join(f.root, 'run'), maxAgents: 4, timeoutMs: 5000,
    requirements: ['workspace-write', 'worktree'],
    backend: codexBackend({ cwd: f.cwd, CodexClass: MockCodex, modelMap: { opus: 'mock', sonnet: 'mock' },
      workspace: { mode: 'workspace-write', worktreeRoot: f.worktreeRoot, baseCommit: f.baseCommit } }),
  });
  assert.deepEqual(result, { status: 'ok', written: { done: true }, read: { done: true } });
  assert.deepEqual(starts.map(s => s.role), ['writer.md', 'reader.md']);
  const [writer, reader] = starts;
  assert.notEqual(writer.workingDirectory, reader.workingDirectory);
  assert.equal(reader.workingDirectory, await realpath(f.cwd));
  assert.ok(starts.every(x => x.sandboxMode === 'workspace-write' && x.approvalPolicy === 'never'));
});
