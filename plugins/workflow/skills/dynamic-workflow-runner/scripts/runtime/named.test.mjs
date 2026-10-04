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
  const scriptPath = join(plugin, 'workflows/unrelated-filename.js');
  await writeFile(scriptPath, `export const meta={name:'tiny',description:'tiny'}; return {custom:args,resumable:true};`);
  const request = { name: 'example:tiny', args: { workspace: root, unicode: '回答そのまま' } };
  let calls = 0;
  const backend = { capabilities: ['read-only', 'fresh-thread', 'workspace-write'], prepare: async () => ({ cwd: root, mode: 'workspace-write' }), run: async prompt => { calls++; return prompt; } };
  const host = { trustedPluginRoots: [plugin], trustedSource: true, backend, runDir: join(root, 'run') };
  return { root, plugin, request, host, scriptPath, calls: () => calls };
}

test('meta name resolves independently of basename and preserves arbitrary source results', async t => {
  const f = await fixture(t);
  const call = structuredClone(f.request), pending = Workflow(call, f.host);
  call.name = 'example:changed-after-call';
  assert.deepEqual(await pending, { custom: f.request.args, resumable: true });
  const receipt = JSON.parse(await readFile(join(f.host.runDir, 'request.json'), 'utf8'));
  assert.equal(receipt.namedWorkflow.name, f.request.name);
  assert.equal(receipt.namedWorkflow.pluginRoot, f.plugin);
  assert.equal(receipt.namedWorkflow.scriptPath, f.scriptPath);
  assert.match(receipt.sourceHash, /^[a-f0-9]{64}$/);
});

test('invalid selectors, missing roots and native resume fail before dispatch', async t => {
  const f = await fixture(t);
  for (const name of ['tiny', '../example:tiny', 'example:../tiny', 'example:other']) await assert.rejects(Workflow({ ...f.request, name }, f.host));
  for (const host of [{ ...f.host, trustedPluginRoots: [] }, { ...f.host, trustedSource: false },
    { ...f.host, trustedPluginRoots: [f.plugin, f.plugin] }, { ...f.host, allowedWorkflowNames: [f.request.name] }])
    await assert.rejects(Workflow(f.request, host));
  await assert.rejects(Workflow({ ...f.request, scriptPath: '/unused' }, f.host), /mutually exclusive/);
  await assert.rejects(Workflow({ ...f.request, resumeFromRunId: 'native-run' }, f.host), /unsupported Workflow request field/);
  assert.equal(f.calls(), 0);
});

test('duplicate metadata and malformed literal metadata fail before dispatch', async t => {
  const f = await fixture(t), other = join(f.plugin, 'workflows/other.js');
  for (const source of ["export const meta={name:'tiny',description:'duplicate'}; return 1;", "export const meta={name:args.name,description:'dynamic'}; return 1;", "export const meta={name:'../escape',description:'bad'}; return 1;"]) {
    await writeFile(other, source);
    await assert.rejects(Workflow(f.request, f.host), /duplicate|literal/);
  }
  assert.equal(f.calls(), 0);
});

test('only the selected source is subject to capability and agent-option gates', async t => {
  const f = await fixture(t);
  await writeFile(join(f.plugin, 'workflows/unsupported.js'), "export const meta={name:'unsupported',description:'x',requirements:['worktree']}; return await agent('x',{model:'sonnet',isolation:'worktree'});");
  assert.deepEqual(await Workflow(f.request, f.host), { custom: f.request.args, resumable: true });
  await assert.rejects(Workflow({ name:'example:unsupported' }, { ...f.host, runDir:join(f.root,'rejected') }), /unsupported.*requirement|capability/);
  await writeFile(f.scriptPath, "export const meta={name:'tiny',description:'x'}; return await agent('x',{model:'sonnet',tools:['x']});");
  await assert.rejects(Workflow(f.request, { ...f.host, runDir:join(f.root,'options') }), /unsupported source capability option/);
  assert.equal(f.calls(), 0);
});

test('duplicate plugin identities and symlinked roots, manifests, source fail closed', async t => {
  for (const target of ['root', '.claude-plugin', '.claude-plugin/plugin.json', 'workflows', 'workflows/unrelated-filename.js', 'duplicate']) {
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

test('ordinary workspace and mode arguments retain source semantics', async t => {
  const f = await fixture(t);
  const args = { mode:'update', workspace:'source-owned-value', cursor:{ offset:3 } };
  assert.deepEqual(await Workflow({ ...f.request,args }, f.host), { custom:args,resumable:true });
});

test('named checkpoint resumes the host protocol and binds source hash and qualified identity', async t => {
  const f = await fixture(t);
  await writeFile(f.scriptPath, "export const meta={name:'tiny',description:'x'}; const first=await agent('first'); await checkpoint('cut'); return {first,last:await agent('last'),resumable:true};");
  const checkpoint={files:[],dependenciesComplete:true,backendIdentity:'mock',stopAfter:'cut'};
  const stopped=await Workflow(f.request,{...f.host,checkpoint});
  assert.equal(stopped.status,'checkpoint'); assert.equal(f.calls(),1);
  const receipt=JSON.parse(await readFile(join(f.host.runDir,'request.json'),'utf8'));
  assert.deepEqual(receipt.identity.namedWorkflow,receipt.namedWorkflow);
  const resume={previousRun:f.host.runDir,freshness:'verified'};
  const host={...f.host,runDir:join(f.root,'resumed'),checkpoint:{...checkpoint,stopAfter:undefined},resume};
  const original=await readFile(f.scriptPath,'utf8');
  await writeFile(f.scriptPath,original+'\n');
  await assert.rejects(Workflow(f.request,host),/identity|source|changed/);
  await writeFile(f.scriptPath,original);
  await assert.rejects(Workflow({scriptPath:f.scriptPath,args:f.request.args},host),/identity/);
  assert.deepEqual(await Workflow(f.request,host),{first:'first',last:'last',resumable:true});
  assert.equal(f.calls(),2);
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
  await writeFile(f.scriptPath, `export const meta={name:'tiny',description:'tiny'}; return await agent('exact role prompt',{schema:{type:'object',properties:{answer:{type:'string'}},required:['answer']}});`);
  const { backend, runDir, ...authority } = f.host;
  const host = { ...authority, cwd: f.root, workspace: { mode: 'workspace-write' }, CodexClass: Fake };
  assert.deepEqual(await executeWorkflow(f.request, { ...host, runDir }), { answer: '回答' });
  const bound = createWorkflow({ ...host, runRoot: f.root }); host.trustedPluginRoots.length = 0;
  assert.deepEqual(await bound({ ...f.request, args:{mode:'update'} }), { answer: '回答' });
  assert.deepEqual(await executeWorkflow({scriptPath:f.scriptPath,args:{mode:'update'}},{...host,trustedPluginRoots:[f.plugin],runDir:join(f.root,'ordinary-update')}),{answer:'回答'});
  assert.equal(configs.length, 3);
});

test('skill-creator update cannot bypass its authority through named checkpoint', async t => {
  const f=await fixture(t);
  await writeFile(f.scriptPath,"export const meta={name:'skill-creator-review',description:'x'}; return await agent('must-not-run');");
  await assert.rejects(Workflow({name:'example:skill-creator-review',args:{mode:'update'}},{...f.host,checkpoint:{files:[],dependenciesComplete:true,backendIdentity:'mock'}}),/skill-creator update/);
  assert.equal(f.calls(),0);
});
