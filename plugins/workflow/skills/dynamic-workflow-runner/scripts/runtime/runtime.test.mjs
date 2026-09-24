import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Workflow } from './runtime.mjs';
import { compileSource } from './source.mjs';
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
    run: async (_, __, { signal }) => new Promise(() => {
      signal.addEventListener('abort', () => { aborted = true; });
    }),
  }, { timeoutMs: 200 });
  assert.equal(result, null);
  assert.equal(aborted, true);
  assert.equal(events.filter(e => e.type === 'agent.timeout').length, 1);
});
test('agent timeout returns null, records timeout, and aborts only that backend call', async t => {
  let aborted = false;
  const { result, events } = await run(t, `return await agent('slow');`, {
    run: async (_, __, { signal }) => new Promise(() => {
      signal.addEventListener('abort', () => { aborted = true; });
    }),
  }, { timeoutMs: 1000, agentTimeoutMs: 25 });
  assert.equal(result, null);
  assert.equal(aborted, true);
  assert.equal(events.filter(e => e.type === 'agent.timeout').length, 1);
  assert.equal(events.at(-1).type, 'run.completed');
});
test('trust acknowledgement is required before opening source', async () => {
  await assert.rejects(Workflow({ scriptPath: '/missing' }, { backend: { run() {} } }), /trustedSource/);
});

test('update workflows fail closed before backend preparation, run creation, and dispatch', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'workflow-runtime-update-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = await realpath(dir), scriptPath = join(root, 'update.flow');
  const capabilities = ['read-only', 'fresh-thread', 'staging-write', 'artifact-manifest', 'fresh-reverify', 'hash-bound-action-package'];
  const cases = [
    { name: 'args-mode', args: { mode: 'update' } },
    { name: 'backend-contract', backendContract: { targetDir: '/target', stagingDir: '/staging' } },
    { name: 'host-requirements', host: { requirements: capabilities.slice(2) } },
    { name: 'backend-capabilities', backendCapabilities: capabilities },
    { name: 'source-requirements', source: `${header.replace("description:'test workflow'", `description:'test workflow',requirements:${JSON.stringify(capabilities.slice(2))}`)}return 1;`,
      backendCapabilities: capabilities },
  ];
  for (const variant of cases) {
    let prepared = 0, dispatched = 0;
    const runDir = join(root, `run-${variant.name}`);
    await writeFile(scriptPath, variant.source ?? `${header}return 1;`);
    const backend = { run() { dispatched++; }, prepare() { prepared++; },
      ...(variant.backendContract ? { updateContract: variant.backendContract } : {}),
      ...(variant.backendCapabilities ? { capabilities: variant.backendCapabilities } : {}) };
    await assert.rejects(Workflow({ scriptPath, args: variant.args ?? {} }, {
      backend, trustedSource: true, runDir, ...variant.host,
    }), /update workflows are not supported|unsupported Workflow host field/);
    assert.equal(prepared, 0, variant.name);
    assert.equal(dispatched, 0, variant.name);
    await assert.rejects(realpath(runDir), { code: 'ENOENT' }, variant.name);
  }
});

test('agent timeout defaults to 80% of the workflow deadline', async t => {
  const { result, events } = await run(t, `return await agent('slow');`, {
    run: async (_, __, { signal }) => new Promise(resolve => {
      signal.addEventListener('abort', () => resolve('too late'));
    }),
  }, { timeoutMs: 1000 });
  assert.equal(result, null);
  assert.equal(events.find(event => event.type === 'agent.timeout').timeoutMs, 800);
});

test('source passes role-specific evidence paths through one retained per-run workspace', async t => {
  const root = await mkdtemp(join(tmpdir(), 'workflow-runtime-shared-workspace-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const scriptPath = join(root, 'evidence.flow'), runDir = join(root, 'run');
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
        await writeFile(path, 'role evidence\\n');
        return 'written';
      }
      return await readFile(path, 'utf8');
    },
  };
  const result = await Workflow({ scriptPath }, { backend, trustedSource: true, runDir, requirements: ['workspace-write'] });
  const receipt = JSON.parse(await readFile(join(runDir, 'request.json'), 'utf8'));
  const events = (await readFile(join(runDir, 'events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(result, 'role evidence\\n');
  assert.equal(receipt.workspace.path.startsWith(join(await realpath(root), 'dynamic-workflows', 'workspace', 'evidence-review') + '/'), true);
  assert.notEqual(receipt.workspace.path, runDir);
  assert.equal(await readFile(join(receipt.workspace.path, 'research-notes.md'), 'utf8'), 'role evidence\\n');
  assert.equal(events.some(event => event.type === 'workspace.created' && event.path === receipt.workspace.path), true);
});
