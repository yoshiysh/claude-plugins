import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, mkdir, stat, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Workflow } from './runtime.mjs';
import { executeWorkflow } from './adapter.mjs';

async function fixture(t, body, extra = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'resume-runtime-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const scriptPath = join(dir, 'flow.js'), dependency = join(dir, 'reference.txt');
  await writeFile(scriptPath, `export const meta={name:'resume',description:'test'};\n${body}`);
  await writeFile(dependency, 'evidence');
  const invoked = [];
  const host = { backend: { run: async prompt => { invoked.push(prompt); return prompt; } },
    trustedSource: true, maxAgents: 4, concurrency: 2, timeoutMs: 10000,
    checkpoint: { files: [dependency], dependenciesComplete: true, backendIdentity: 'mock-v1', stopAfter: 'one' }, ...extra };
  let index = 0;
  const run = (overrides = {}, args = {}) => Workflow({ scriptPath, args }, { ...host, runDir: join(dir, `run-${++index}`), ...overrides });
  return { dir, scriptPath, dependency, host, invoked, run };
}
const resume = stopped => ({ previousRun: stopped.runDir, freshness: 'verified' });

test('checkpoint stops then replays completed work and dispatches only new work', async t => {
  const f = await fixture(t, `const a=await agent('first'); await checkpoint('one'); return await agent(a+' second');`);
  const stopped = await f.run();
  assert.equal(stopped.status, 'checkpoint'); assert.deepEqual(f.invoked, ['first']);
  assert.equal(await f.run({ resume: resume(stopped) }), 'first second');
  assert.deepEqual(f.invoked, ['first', 'first second']);
  await assert.rejects(f.run({ resume: resume(stopped) }), /EEXIST/);
  assert.ok((await stat(join(stopped.runDir, 'continuation.lock'))).isDirectory());
});

test('parallel out-of-order completion and race branch replay preserves transcript', async t => {
  const invoked = [];
  const f = await fixture(t, `const a=agent('slow'), b=agent('fast'); const winner=await Promise.race([a,b]);
    const ordered=await Promise.all([a,b]); await checkpoint('one'); return await agent(winner+ordered.join(','));`, {
    backend: { run: async prompt => { invoked.push(prompt); if(prompt==='slow') await new Promise(r=>setTimeout(r,30)); return prompt; } },
  });
  const stopped = await f.run();
  assert.equal(await f.run({ resume: resume(stopped) }), 'fastslow,fast');
  assert.deepEqual(invoked, ['slow', 'fast', 'fastslow,fast']);
});

test('checkpoint chain retains cumulative call and time budget without charging replay twice', async t => {
  const f = await fixture(t, `await agent('a'); await checkpoint('one'); await agent('b'); await checkpoint('two'); return await agent('c');`, { maxAgents: 2 });
  const one = await f.run();
  const two = await f.run({ resume: resume(one), checkpoint: { ...f.host.checkpoint, stopAfter: 'two' } });
  assert.equal(two.calls, 2); assert.ok(two.remainingMs < one.remainingMs);
  await assert.rejects(f.run({ resume: resume(two) }), /budget exceeded/);
  assert.deepEqual(f.invoked, ['a', 'b']);
});

test('source, args, policy, file and budget drift fail before backend invocation', async t => {
  for (const variant of ['source', 'args', 'backend', 'file', 'budget', 'freshness']) {
    const f = await fixture(t, `await agent('a'); await checkpoint('one'); return await agent('b');`);
    const stopped = await f.run();
    const override = { resume: resume(stopped) }; let args = {};
    if (variant === 'source') await writeFile(f.scriptPath, (await readFile(f.scriptPath, 'utf8'))+'\n// drift');
    if (variant === 'args') args = { changed: true };
    if (variant === 'backend') override.checkpoint = { ...f.host.checkpoint, backendIdentity: 'changed' };
    if (variant === 'file') await writeFile(f.dependency, 'changed');
    if (variant === 'budget') override.maxAgents = 5;
    if (variant === 'freshness') override.resume.freshness = 'assumed';
    await assert.rejects(f.run(override, args), /identity mismatch|drift|freshness/);
    assert.deepEqual(f.invoked, ['a'], variant);
  }
});

test('null, failed, invalid and pending calls cannot create executable checkpoint', async t => {
  for (const body of [`await agent('a'); await checkpoint('one');`, `agent('a'); await checkpoint('one');`]) {
    const f = await fixture(t, body, { backend: { run: async () => null } });
    await assert.rejects(f.run(), /quiescent|pending/);
  }
  const failed = await fixture(t, `await agent('a'); await checkpoint('one');`, {
    backend: { run: async () => { throw Error('unknown effect'); } },
  });
  await assert.rejects(failed.run(), /quiescent/);
  const invalid = await fixture(t, `await agent('a', {schema: {type:'integer'}}); await checkpoint('one');`, {
    backend: { run: async () => 'not an integer' },
  });
  await assert.rejects(invalid.run(), /quiescent/);
});

test('unsealed, torn and edited predecessors are rejected before dispatch', async t => {
  for (const kind of ['unsealed', 'torn', 'edited']) {
    const f = await fixture(t, `await agent('a'); await checkpoint('one'); return await agent('b');`);
    const stopped = await f.run();
    const path = join(stopped.runDir, 'events.jsonl');
    if (kind === 'unsealed') await rm(join(stopped.runDir, 'checkpoint.json'));
    if (kind === 'torn') await writeFile(path, (await readFile(path, 'utf8')).trimEnd());
    if (kind === 'edited') await writeFile(path, (await readFile(path, 'utf8')).replace('"prompt":"a"', '"prompt":"changed"'));
    await assert.rejects(f.run({ resume: resume(stopped) }), /ENOENT|torn|integrity/);
    assert.deepEqual(f.invoked, ['a']);
  }
});

test('exclusive continuation lease permits only one concurrent resume', async t => {
  const f = await fixture(t, `await agent('a'); await checkpoint('one'); return await agent('b');`);
  const stopped = await f.run();
  const outcomes = await Promise.allSettled([f.run({ resume: resume(stopped) }), f.run({ resume: resume(stopped) })]);
  assert.equal(outcomes.filter(o => o.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter(o => o.status === 'rejected').length, 1);
  assert.deepEqual(f.invoked, ['a', 'b']);
});

test('legacy evidence cannot be resumed and held lease is not removed by contender', async t => {
  const f = await fixture(t, `return await agent('a');`);
  const root = join(f.dir, 'legacy'); await mkdir(root);
  await assert.rejects(f.run({ resume: { previousRun: root, freshness: 'verified' } }), /ENOENT/);
  await mkdir(join(root, 'continuation.lock'));
  await assert.rejects(f.run({ resume: { previousRun: root, freshness: 'verified' } }), /EEXIST/);
  assert.ok((await stat(join(root, 'continuation.lock'))).isDirectory());
});

test('common adapter exposes checkpoint/resume with pinned mock SDK model policy', async t => {
  const f = await fixture(t, `const a=await agent('a'); await checkpoint('one'); return await agent(a+'b');`);
  const prompts = [];
  class MockCodex {
    startThread() { return { async runStreamed(prompt) {
      prompts.push(prompt);
      return { events: (async function*() { yield { type: 'item.completed', item: { type: 'agent_message', text: prompt } };
        yield { type: 'turn.completed', usage: {} }; })() };
    } }; }
  }
  const host = { trustedSource: true, cwd: f.dir, CodexClass: MockCodex,
    model: 'test-model', modelReasoningEffort: 'low', checkpoint: f.host.checkpoint, timeoutMs: 10000,
    environment: { path: '/usr/bin:/bin', requiredCommands: ['sh'] } };
  const request = { scriptPath: f.scriptPath, args: {} };
  const stopped = await executeWorkflow(request, { ...host, runDir: join(f.dir, 'adapter-one') });
  assert.equal(await executeWorkflow(request, { ...host, runDir: join(f.dir, 'adapter-two'), resume: resume(stopped) }), 'ab');
  assert.deepEqual(prompts, ['a', 'ab']);
  await assert.rejects(executeWorkflow(request, { ...host, environment: undefined, runDir: join(f.dir, 'adapter-no-env') }), /explicit worker environment/);
  assert.deepEqual(prompts, ['a', 'ab']);
});

test('write and fsync faults at every task/checkpoint boundary prevent unsafe resume', async t => {
  for (const type of ['agent.accepted', 'agent.started', 'agent.completed', 'reply.released', 'checkpoint.stopped']) {
    for (const operation of ['write', 'sync']) {
      const f = await fixture(t, `await agent('a'); await checkpoint('one'); return await agent('b');`);
      const handle = await open(join(f.dir, 'probe'), 'w');
      const prototype = Object.getPrototypeOf(handle);
      const write = prototype.writeFile, sync = prototype.sync;
      let failSync = false, injected = false;
      const writeMock = t.mock.method(prototype, 'writeFile', async function(value, ...args) {
        if (typeof value === 'string' && value.includes(`"type":"${type}"`) && !injected) {
          injected = true;
          if (operation === 'write') throw Error('injected journal failure');
          failSync = true;
        }
        return write.call(this, value, ...args);
      });
      const syncMock = t.mock.method(prototype, 'sync', async function(...args) {
        if (failSync) { failSync = false; throw Error('injected journal failure'); }
        return sync.call(this, ...args);
      });
      try {
        await assert.rejects(f.run(), /injected journal failure/);
        assert.equal(injected, true);
        assert.equal(f.invoked.length, ['agent.accepted', 'agent.started'].includes(type) ? 0 : 1);
        await assert.rejects(f.run({ resume: { previousRun: join(f.dir, 'run-1'), freshness: 'verified' } }), /ENOENT/);
      } finally { writeMock.mock.restore(); syncMock.mock.restore(); await handle.close(); }
    }
  }
});
