import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Workflow } from './runtime.mjs';
import { createWorkflow, executeWorkflow } from './adapter.mjs';

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'named-workflow-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const plugin = join(root, 'plugin');
  await mkdir(join(plugin, '.claude-plugin'), { recursive: true });
  await mkdir(join(plugin, 'workflows'));
  await writeFile(join(plugin, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'example' }));
  const entry = { name: 'tiny', scriptPath: 'tiny.js', requirements: ['workspace-write'], continuation: 'next_args', workspaceArg: 'workspace' };
  const registry = entries => writeFile(join(plugin, 'workflows/codex-workflows.json'), JSON.stringify({ schemaVersion: 1, workflows: entries }));
  await registry([entry]);
  await writeFile(join(plugin, 'workflows/tiny.js'), `export const meta={name:'tiny',description:'tiny'}; return {status:'needs_answers',resumable:true,next_args:args};`);
  const request = { name: 'example:tiny', args: { workspace: root, unicode: '回答そのまま' } };
  let calls = 0;
  const backend = { capabilities: ['read-only', 'fresh-thread', 'workspace-write'], prepare: async () => ({ cwd: root, mode: 'workspace-write' }), run: async () => { calls++; return null; } };
  const host = { trustedPluginRoots: [plugin], allowedWorkflowNames: [request.name], trustedSource: true, backend, runDir: join(root, 'run') };
  return { root, plugin, request, host, entry, registry, calls: () => calls };
}

test('approved name resolves by manifest and registration and preserves next_args', async t => {
  const f = await fixture(t);
  assert.deepEqual(await Workflow(f.request, f.host), { status: 'needs_answers', resumable: false, next_args: f.request.args });
  const receipt = JSON.parse(await readFile(join(f.host.runDir, 'request.json'), 'utf8'));
  assert.equal(receipt.namedWorkflow.name, f.request.name);
  assert.equal(receipt.namedWorkflow.pluginRoot, f.plugin);
});

test('names do not auto-enable unknown sources, permission escalation, or native/runner replay', async t => {
  const f = await fixture(t);
  for (const name of ['tiny', '../example:tiny', 'example:../tiny', 'example:other']) await assert.rejects(Workflow({ ...f.request, name }, f.host));
  for (const host of [{ ...f.host, allowedWorkflowNames: [] }, { ...f.host, trustedPluginRoots: [] }, { ...f.host, trustedSource: false },
    { ...f.host, allowedWorkflowNames: [f.request.name, f.request.name] }, { ...f.host, trustedPluginRoots: [f.plugin, f.plugin] },
    { ...f.host, checkpoint: {} }, { ...f.host, resume: {} }, { ...f.host, backend: { ...f.host.backend, capabilities: ['read-only', 'fresh-thread'] } }])
    await assert.rejects(Workflow(f.request, host));
  await assert.rejects(Workflow({ ...f.request, scriptPath: '/unused' }, f.host), /mutually exclusive/);
  await assert.rejects(Workflow({ ...f.request, resumeFromRunId: 'native-run' }, f.host), /unsupported Workflow request field/);
  await f.registry([]);
  await assert.rejects(Workflow(f.request, f.host), /no verified Codex registration/);
  assert.equal(f.calls(), 0);
});

test('registration duplicate, traversal, continuation and source mismatch reject before dispatch', async t => {
  const f = await fixture(t);
  for (const entries of [[f.entry, f.entry], [{ ...f.entry, scriptPath: '../tiny.js' }], [{ ...f.entry, continuation: 'resumeFromRunId' }]]) {
    await f.registry(entries);
    await assert.rejects(Workflow(f.request, f.host), /invalid or duplicate/);
  }
  await f.registry([f.entry]);
  await writeFile(join(f.plugin, 'workflows/tiny.js'), "export const meta={name:'other',description:'other'}; return 1;");
  await assert.rejects(Workflow(f.request, f.host), /does not match/);
  assert.equal(f.calls(), 0);
});

test('duplicate plugin identities and symlinked roots, manifests, registry and source fail closed', async t => {
  for (const target of ['root', '.claude-plugin', '.claude-plugin/plugin.json', 'workflows', 'workflows/codex-workflows.json', 'workflows/tiny.js', 'duplicate']) {
    const f = await fixture(t);
    if (target === 'root') {
      const alias = join(f.root, 'alias'); await symlink(f.plugin, alias); f.host.trustedPluginRoots = [alias];
    } else if (target === 'duplicate') {
      const extra = join(f.root, 'second'); await mkdir(join(extra, '.claude-plugin'), { recursive: true });
      await writeFile(join(extra, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'example' })); f.host.trustedPluginRoots.push(extra);
    } else {
      const path = join(f.plugin, target), moved = join(f.root, 'moved'); await rename(path, moved); await symlink(moved, path);
    }
    await assert.rejects(Workflow(f.request, f.host), /symlink-free|ambiguous/);
    assert.equal(f.calls(), 0);
  }
});

test('named workspace must exist canonically within a prepared writable worker cwd', async t => {
  const f = await fixture(t);
  const outside = await realpath(await mkdtemp(join(tmpdir(), 'named-outside-')));
  t.after(() => rm(outside, { recursive: true, force: true }));
  for (const workspace of [outside, join(f.root, 'missing'), 'relative']) await assert.rejects(Workflow({ ...f.request, args: { workspace } }, f.host));
  for (const prepare of [undefined, async () => ({ cwd: f.root, mode: 'read-only' })])
    await assert.rejects(Workflow(f.request, { ...f.host, backend: { ...f.host.backend, prepare } }), /prepared worker cwd/);
  assert.equal(f.calls(), 0);
});

test('both adapters transport named source and structured SDK results with immutable host authorization', async t => {
  const f = await fixture(t), configs = [];
  class Fake {
    constructor(config) { configs.push(config); }
    startThread(options) {
      assert.equal(options.workingDirectory, f.root); assert.equal(options.sandboxMode, 'workspace-write');
      return { async runStreamed(prompt) {
        assert.ok(prompt.startsWith('exact role prompt'));
        return { events: (async function* () {
          yield { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ json: JSON.stringify({ answer: '回答' }) }) } };
          yield { type: 'turn.completed' };
        })() };
      } };
    }
  }
  await writeFile(join(f.plugin, 'workflows/tiny.js'), `export const meta={name:'tiny',description:'tiny'}; return await agent('exact role prompt',{schema:{type:'object',properties:{answer:{type:'string'}},required:['answer']}});`);
  const { backend, runDir, ...authority } = f.host;
  const host = { ...authority, cwd: f.root, workspace: { mode: 'workspace-write' }, CodexClass: Fake };
  assert.deepEqual(await executeWorkflow(f.request, { ...host, runDir }), { answer: '回答' });
  const bound = createWorkflow({ ...host, runRoot: f.root }); host.allowedWorkflowNames.length = 0;
  assert.deepEqual(await bound(f.request), { answer: '回答' }); assert.equal(configs.length, 2);
});
