import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, writeFile, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Workflow } from './runtime.mjs';
import { compileSource } from './source.mjs';
import { codexBackend } from './codex.mjs';
import { Codex } from '@openai/codex-sdk';
const header = `export const meta = {name:'test',description:'test workflow'};\n`;

async function run(t, body, backend, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'workflow-runtime-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const scriptPath = join(dir, 'arbitrary-name.flow');
  await writeFile(scriptPath, header + body);
  return { result: await Workflow({ scriptPath, args: { text: 'hello' } }, {
    backend, trustedSource: true, runDir: join(dir, 'run'), timeoutMs: 3000, ...options,
  }), events: (await readFile(join(dir, 'run/events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse) };
}

test('real JS: args, phases, two agents, branch and return; arbitrary extension', async t => {
  const prompts = [];
  const { result, events } = await run(t, `phase('Generate'); const a = await agent(args.text);
    phase('Check'); if (a === 'hello') return await agent(a + '!'); return null;`, {
    run: async prompt => { prompts.push(prompt); return prompt; },
  });
  assert.equal(result, 'hello!'); assert.deepEqual(prompts, ['hello', 'hello!']);
  assert.equal(events.filter(e => e.type === 'agent.started').length, 2);
  assert.equal(events.at(-1).type, 'run.completed');
});
test('non-JSON and non-cloneable args fail with the JSON serializability error', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'workflow-runtime-args-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const scriptPath = join(dir, 'source.js');
  await writeFile(scriptPath, header + 'return args.text;');
  const host = { trustedSource: true, backend: { run: async () => null } };
  const cyclic = {}; cyclic.self = cyclic;
  for (const [index, args] of [{ callback: () => null }, { count: 1n }, cyclic, Symbol('value')].entries()) {
    const runDir = join(dir, `run-${index}`);
    await assert.rejects(Workflow({ scriptPath, args }, { ...host, runDir }),
      error => error.name === 'Error' && error.message === 'args must be JSON serializable');
  }
  assert.equal(await Workflow({ scriptPath, args: { text: 'valid' } },
    { ...host, runDir: join(dir, 'valid-run') }), 'valid');
});
test('parallel/pipeline preserve order, null and bound nested concurrency', async t => {
  let active = 0, peak = 0;
  const { result } = await run(t, `return await parallel([
    () => pipeline(['a','bad','c'], x => agent(x)), () => agent('d')]);`, {
    run: async prompt => {
      peak = Math.max(peak, ++active);
      await new Promise(r => setTimeout(r, 10)); active--;
      if (prompt === 'bad') throw Error('API failure'); return prompt;
    },
  }, { maxAgents: 4, concurrency: 2 });
  assert.deepEqual(result, [['a', null, 'c'], 'd']); assert.equal(peak, 2);
});
test('schema uses Unicode code points, invalid output becomes null', async t => {
  const { result } = await run(t, `const schema = {type:'string', maxLength:100};
    return await parallel([() => agent('good',{schema}), () => agent('bad',{schema})]);`, {
    run: async prompt => '😀'.repeat(prompt === 'good' ? 60 : 101),
  });
  assert.deepEqual(result, ['😀'.repeat(60), null]);
});
test('agent budget cannot be caught and converted to success', async t => {
  await assert.rejects(run(t, `try { for (;;) await agent('x'); } catch {} return 'passed';`,
    { run: async () => 'ok' }, { maxAgents: 1 }), /budget exceeded/);
});
test('infinite loop is terminated', async t => {
  await assert.rejects(run(t, 'while(true) {}', { run: async () => '' }, { timeoutMs: 150 }), /deadline|timed out/);
});
test('unknown agent option fails before backend invocation', async t => {
  let calls = 0;
  await assert.rejects(run(t, `return await agent('x',{tools:['Bash']});`,
    { run: async () => { calls++; } }), /unsupported agent option/);
  assert.equal(calls, 0);
});
test('unawaited agent work is not successful completion', async t => {
  await assert.rejects(run(t, `agent('x'); return 'done';`,
    { run: async () => new Promise(() => {}) }), /unawaited/);
});
test('randomness, clock and direct process access are absent', async t => {
  for (const expression of ['Date.now()', 'new Date()', 'Math.random()', 'process.cwd()'])
    await assert.rejects(run(t, `return ${expression};`, { run: async () => '' }));
});
test('parser rejects imports even in dead code; no regex rewriting of strings', () => {
  for (const source of ["if(false) import('fs');", "export default 1;"])
    assert.throws(() => compileSource(header + source), /unsupported/);
  assert.equal(compileSource(header + `return 'import( export const meta';`).meta.name, 'test');
  assert.throws(() => compileSource(`export const meta = {name: f(),description:'x'};`), /literal/);
});

test('final return and prompt are byte bounded', async t => {
  await assert.rejects(run(t, `return 'x'.repeat(1000);`, { run: async () => '' },
    { maxOutputBytes: 100 }), /byte limit/);
  let calls = 0;
  await assert.rejects(run(t, `return await agent('x'.repeat(1000));`,
    { run: async () => { calls++; return ''; } }, { maxOutputBytes: 100 }), /prompt byte/);
  assert.equal(calls, 0);
});
test('agent timeout aborts a pending backend and records a null result', async t => {
  let aborted = false;
  const { result, events } = await run(t, `return await agent('x');`, {
    run: async (_, __, { signal }) => new Promise(resolve => {
      signal.addEventListener('abort', () => { aborted = true; resolve(null); }, { once: true });
    }),
  }, { timeoutMs: 200 });
  assert.equal(result, null);
  assert.equal(aborted, true);
  assert.equal(events.filter(e => e.type === 'agent.timeout').length, 1);
});
test('agent timeout returns null, records timeout, and aborts only that backend call', async t => {
  let aborted = false;
  const { result, events } = await run(t, `return await agent('slow');`, {
    run: async (_, __, { signal }) => new Promise(resolve => {
      signal.addEventListener('abort', () => { aborted = true; resolve(null); }, { once: true });
    }),
  }, { timeoutMs: 1000, agentTimeoutMs: 25 });
  assert.equal(result, null);
  assert.equal(aborted, true);
  assert.equal(events.filter(e => e.type === 'agent.timeout').length, 1);
  assert.equal(events.at(-1).type, 'run.completed');
});

test('source hands role-specific file paths through one retained per-run workspace', async t => {
  const root = await mkdtemp(join(tmpdir(), 'workflow-runtime-shared-workspace-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const scriptPath = join(root, 'evidence.flow');
  const runDir = join(root, 'run');
  await writeFile(scriptPath, `export const meta = {name:'evidence-review',description:'shared evidence files',requirements:['workspace-write']};
    const evidencePath = workspace.path + '/research-notes.md';
    await agent('write ' + evidencePath, {label:'research'});
    return await agent('read only ' + evidencePath, {label:'review'});`);
  const backend = {
    capabilities: ['read-only', 'fresh-thread', 'workspace-write'],
    async prepare() { return { cwd: root }; },
    async run(prompt) {
      const path = prompt.match(/(?:write|read only) (.+)$/)?.[1];
      assert.ok(path);
      if (prompt.startsWith('write ')) {
        await writeFile(path, 'role evidence\n');
        return 'written';
      }
      return await readFile(path, 'utf8');
    },
  };
  const result = await Workflow({ scriptPath }, { backend, trustedSource: true, runDir, requirements: ['workspace-write'] });
  const receipt = JSON.parse(await readFile(join(runDir, 'request.json'), 'utf8'));
  const events = (await readFile(join(runDir, 'events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(result, 'role evidence\n');
  assert.equal(receipt.workspace.path.startsWith(join(await realpath(root), 'dynamic-workflows', 'workspace', 'evidence-review') + '/'), true);
  assert.notEqual(receipt.workspace.path, runDir);
  assert.equal(await readFile(join(receipt.workspace.path, 'research-notes.md'), 'utf8'), 'role evidence\n');
  assert.equal(events.some(event => event.type === 'workspace.created' && event.path === receipt.workspace.path), true);
});
test('trust acknowledgement is required before opening source', async () => {
  await assert.rejects(Workflow({ scriptPath: '/missing' }, { backend: { run() {} } }), /trustedSource/);
});

test('update rejects a backend that only self-advertises staging capabilities', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'workflow-runtime-update-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = await realpath(dir);
  const targetRoot = join(root, 'targets'), stagingRoot = join(root, 'staging-root');
  const target = join(targetRoot, 'target'), staging = join(stagingRoot, 'staging'), scriptPath = join(root, 'update.flow');
  await mkdir(targetRoot); await mkdir(stagingRoot);
  await mkdir(target);
  await writeFile(join(target, 'SKILL.md'), 'before\n');
  await writeFile(scriptPath, `export const meta = {name:'skill-creator-review',description:'update'}; return null;`);
  let calls = 0;
  await assert.rejects(Workflow({ scriptPath, args: { mode: 'update', target: { skillPath: target } } }, {
    backend: { capabilities: ['read-only', 'fresh-thread', 'staging-write', 'artifact-manifest', 'fresh-reverify', 'hash-bound-action-package'],
      async run() { calls++; } },
    trustedSource: true, runDir: join(root, 'run'), timeoutMs: 3000,
    updateContract: { targetRoot, stagingRoot, targetDir: target, stagingDir: staging },
  }), /Codex SDK staging-only backend/);
  assert.equal(calls, 0);
  assert.equal(await readFile(join(target, 'SKILL.md'), 'utf8'), 'before\n');
});

test('update binds the contract to the exact caller target before staging or dispatch', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'workflow-runtime-update-target-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = await realpath(dir);
  const targetRoot = join(root, 'targets'), stagingRoot = join(root, 'staging-root');
  const target = join(targetRoot, 'target'), other = join(targetRoot, 'other'), staging = join(stagingRoot, 'staging');
  await mkdir(targetRoot); await mkdir(stagingRoot);
  const scriptPath = join(root, 'update.flow');
  await mkdir(target); await mkdir(other);
  await writeFile(scriptPath, `export const meta = {name:'skill-creator-review',description:'update'}; return null;`);
  const contract = { targetRoot, stagingRoot, targetDir: target, stagingDir: staging };
  const backend = codexBackend({ cwd: root, updateContract: contract });
  await assert.rejects(Workflow({ scriptPath, args: { mode: 'update', target: { skillPath: other } } }, {
    backend, trustedSource: true, runDir: join(root, 'run'), timeoutMs: 3000,
    updateContract: contract,
  }), /must match args\.target\.skillPath/);
  await assert.rejects(readFile(staging), { code: 'ENOENT' });
});

test('update runs each phase in its scoped cwd and returns the caller package without applying it', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'workflow-runtime-update-result-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = await realpath(dir);
  const targetRoot = join(root, 'targets'), stagingRoot = join(root, 'staging-root');
  const target = join(targetRoot, 'target'), staging = join(stagingRoot, 'staging');
  await mkdir(targetRoot); await mkdir(stagingRoot);
  const scriptPath = join(root, 'update.flow'), runDir = join(root, 'run');
  await mkdir(target); await writeFile(join(target, 'SKILL.md'), 'before\n');
  await writeFile(scriptPath, `export const meta = {name:'skill-creator-review',description:'update'};
    await agent('write staging',{phase:'Update',label:'update-r1'});
    await agent('fresh reverify',{phase:'Reverify',label:'reverify-r1'});
    return { verdict:'applied_to_staging', staging:{dir:args.stagingDir,changed_files:[{path:'SKILL.md',reason:'intent',findings_addressed:['f1']}]},
      reverify_receipt:{phase:'Reverify',staging_dir:args.stagingDir,fresh_thread:true,completed:true,by_category:{quality:0},updater_thread_id:'update-r1',fresh_thread_id:'reverify-r1'} };`);
  const calls = [];
  const originalStartThread = Codex.prototype.startThread;
  Codex.prototype.startThread = function (options) {
    calls.push(options);
    return { async runStreamed() {
      if (options.workingDirectory === staging) {
        await cp(target, staging, { recursive: true });
        await writeFile(join(staging, 'SKILL.md'), 'after\n');
      }
      return { events: (async function* () {
        yield { type: 'item.completed', item: { type: 'agent_message', text: 'done' } };
        yield { type: 'turn.completed', usage: { input_tokens: 0, output_tokens: 0 } };
      })() };
    } };
  };
  try {
    const contract = { targetRoot, stagingRoot, targetDir: target, stagingDir: staging };
    const result = await Workflow({ scriptPath, args: { mode: 'update', target: { skillPath: target }, stagingDir: staging } }, {
      backend: codexBackend({ cwd: root, updateContract: contract }), updateContract: contract,
      trustedSource: true, runDir, timeoutMs: 3000,
    });
    assert.equal(result.source_result.verdict, 'applied_to_staging');
    assert.equal(result.action_package.changed_files[0].path, 'SKILL.md');
    assert.equal(result.action_package.apply.source_dir, target);
    assert.equal(result.action_package_path, join(runDir, 'update-action-package.json'));
    assert.equal(result.action_package_sha256,
      createHash('sha256').update(await readFile(result.action_package_path)).digest('hex'));
    assert.deepEqual(calls.map(call => [call.workingDirectory, call.sandboxMode]), [
      [staging, 'workspace-write'], [root, 'read-only'],
    ]);
    assert.equal(await readFile(join(target, 'SKILL.md'), 'utf8'), 'before\n');
  } finally {
    Codex.prototype.startThread = originalStartThread;
  }
});

test('pipeline settles every item and turns callback exceptions into null', async t => {
  const calls = [];
  const { result } = await run(t, `return await pipeline(['before','after','slow'], async x => {
    if (x === 'before') throw Error('callback before dispatch');
    const out = await agent(x);
    if (x === 'after') throw Error('callback after dispatch');
    return out;
  });`, { run: async prompt => {
    calls.push(prompt);
    if (prompt === 'slow') await new Promise(r => setTimeout(r, 30));
    return prompt;
  } });
  assert.deepEqual(result, [null, null, 'slow']);
  assert.deepEqual(calls.sort(), ['after', 'slow']);
});

test('pipeline cannot turn host budget or invalid agent options into success', async t => {
  await assert.rejects(run(t, `return await pipeline(['a','b'], x => agent(x));`,
    { run: async p => p }, { maxAgents: 1 }), /budget exceeded/);
  await assert.rejects(run(t, `return await pipeline(['a'], x => agent(x,{unknown:true}));`,
    { run: async p => p }), /unsupported agent option/);
});
