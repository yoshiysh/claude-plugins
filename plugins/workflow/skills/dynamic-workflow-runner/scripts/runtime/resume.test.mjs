import test from 'node:test';
import assert from 'node:assert/strict';
import { constants, promises as fsPromises } from 'node:fs';
import { mkdtemp, writeFile, readFile, rm, mkdir, stat, open, chmod, truncate, unlink, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Workflow } from './runtime.mjs';
import { maxEvidenceBytes } from './resume.mjs';
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

test('checkpoint continuation retains the shared evidence workspace', async t => {
  const f = await fixture(t, `const path=workspace.path+'/evidence.md'; await agent('write '+path); await checkpoint('one'); return await agent('read '+path);`, {
    backend: {
      prepare: async () => ({ cwd: f.dir }),
      async run(prompt) {
        const [, operation, path] = prompt.match(/^(write|read) (.+)$/) ?? [];
        if (operation === 'write') return writeFile(path, 'shared evidence').then(() => 'written');
        if (operation === 'read') return readFile(path, 'utf8');
        throw Error('unexpected prompt');
      },
    },
  });
  const stopped = await f.run();
  const saved = JSON.parse(await readFile(join(stopped.runDir, 'request.json'), 'utf8'));
  assert.ok(saved.identity.workspace.path.startsWith(join(await realpath(f.dir), 'dynamic-workflows', 'workspace', 'resume') + '/'));
  assert.equal(await readFile(join(saved.identity.workspace.path, 'evidence.md'), 'utf8'), 'shared evidence');
  assert.equal(await f.run({ resume: resume(stopped) }), 'shared evidence');
  const continued = JSON.parse(await readFile(join(f.dir, 'run-2', 'request.json'), 'utf8'));
  assert.equal(continued.identity.workspace.path, saved.identity.workspace.path);
  const events = (await readFile(join(f.dir, 'run-2', 'events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(events.filter(event => event.type === 'workspace.created').length, 1);
});

test('workspace edits, additions, removals and directory-mode changes reject resume before live dispatch', async t => {
  const changes = ['edit', 'add', 'remove', ...(process.platform === 'win32' ? [] : ['root-mode', 'nested-mode'])];
  for (const change of changes) {
    const dispatched = [];
    const f = await fixture(t, `const path=workspace.path+'/nested/evidence.md'; await agent('write '+path); await checkpoint('one'); return await agent('live');`, {
      backend: {
        prepare: async () => ({ cwd: f.dir }),
        async run(prompt) {
          dispatched.push(prompt);
          const path = prompt.match(/^write (.+)$/)?.[1];
          if (!path) throw Error(`unexpected prompt: ${prompt}`);
          await mkdir(dirname(path), { recursive: true, mode: 0o700 });
          return writeFile(path, 'sealed').then(() => 'written');
        },
      },
    });
    const stopped = await f.run();
    const saved = JSON.parse(await readFile(join(stopped.runDir, 'request.json'), 'utf8'));
    const file = join(saved.identity.workspace.path, 'nested', 'evidence.md');
    if (change === 'edit') await writeFile(file, 'changed');
    if (change === 'add') await writeFile(join(saved.identity.workspace.path, 'extra.md'), 'added');
    if (change === 'remove') await rm(file);
    if (change === 'root-mode') await chmod(saved.identity.workspace.path, 0o755);
    if (change === 'nested-mode') await chmod(dirname(file), 0o755);
    await assert.rejects(f.run({ resume: resume(stopped) }), /checkpoint workspace drift/, change);
    assert.equal(dispatched.length, 1, change);
    assert.match(dispatched[0], /^write /, change);
  }
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

test('checkpoint and resume reject update workflows before execution', async t => {
  const f = await fixture(t, `await agent('a'); await checkpoint('one'); return await agent('b');`);
  const stopped = await f.run();
  const updateCapabilities = ['read-only', 'fresh-thread', 'staging-write', 'artifact-manifest',
    'fresh-reverify', 'hash-bound-action-package'];
  let prepared = 0;
  const updateBackend = { ...f.host.backend, capabilities: updateCapabilities, prepare() { prepared++; } };

  await assert.rejects(f.run({ updateContract: {} }), /unsupported Workflow host field: updateContract/);
  await assert.rejects(f.run({ backend: updateBackend, requirements: updateCapabilities.slice(2), resume: resume(stopped) }),
    /update workflows are not supported/);
  await assert.rejects(f.run({}, { mode: 'update' }), /update workflows are not supported/);
  await writeFile(f.scriptPath, `export const meta={name:'resume',description:'test',requirements:${JSON.stringify(updateCapabilities.slice(2))}};\nawait agent('a'); await checkpoint('one');`);
  await assert.rejects(f.run({ backend: updateBackend, resume: resume(stopped) }),
    /update workflows are not supported/);

  assert.deepEqual(f.invoked, ['a']);
  assert.equal(prepared, 0);
  await assert.rejects(stat(join(f.dir, 'run-2')), { code: 'ENOENT' });
  await assert.rejects(stat(join(f.dir, 'run-3')), { code: 'ENOENT' });
  await assert.rejects(stat(join(f.dir, 'run-4')), { code: 'ENOENT' });
  await assert.rejects(stat(join(f.dir, 'run-5')), { code: 'ENOENT' });
});

test('checkpoint agent default remains bounded only by the workflow deadline', async t => {
  let calls = 0;
  const f = await fixture(t, `return await agent('slow');`, {
    backend: { run: async () => { calls++; await new Promise(resolve => setTimeout(resolve, 1250)); return 'done'; } },
  });
  assert.equal(await f.run({ timeoutMs: 1500 }), 'done');
  assert.equal(calls, 1);
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

test('oversized checkpoint evidence is rejected before backend dispatch', async t => {
  const f = await fixture(t, `await agent('a'); await checkpoint('one'); return await agent('b');`);
  const stopped = await f.run();
  await truncate(join(stopped.runDir, 'request.json'), maxEvidenceBytes + 1);
  await assert.rejects(f.run({ resume: resume(stopped) }), /invalid checkpoint evidence file/);
  assert.deepEqual(f.invoked, ['a']);
});

test('checkpoint evidence growth during fd reads is bounded and rejected', async t => {
  const f = await fixture(t, `await agent('a'); await checkpoint('one'); return await agent('b');`);
  const stopped = await f.run();
  const evidencePath = join(await realpath(stopped.runDir), 'request.json');
  const capturedSize = (await stat(evidencePath)).size;
  const originalOpen = fsPromises.open;
  let requestedBytes = 0, grew = false, readFileUsed = false;
  t.mock.method(fsPromises, 'open', async function(path, flags, ...args) {
    const handle = await originalOpen(path, flags, ...args);
    if (path !== evidencePath) return handle;
    const originalRead = handle.read.bind(handle);
    handle.read = async (buffer, offset, length, position) => {
      requestedBytes += length;
      if (!grew) {
        grew = true;
        await fsPromises.truncate(evidencePath, capturedSize + 64 * 1024 * 1024);
      }
      return originalRead(buffer, offset, length, position);
    };
    const originalReadFile = handle.readFile.bind(handle);
    handle.readFile = async (...readArgs) => {
      readFileUsed = true;
      return originalReadFile(...readArgs);
    };
    return handle;
  });
  await assert.rejects(f.run({ resume: resume(stopped) }), /checkpoint evidence changed while reading/);
  assert.equal(grew, true);
  assert.ok(requestedBytes > 0);
  assert.ok(requestedBytes <= capturedSize);
  assert.equal(readFileUsed, false);
  assert.deepEqual(f.invoked, ['a']);
});

test('checkpoint evidence replaced by a symlink is opened with no-follow flags and never read', {
  skip: typeof constants.O_NOFOLLOW !== 'number' || typeof constants.O_NONBLOCK !== 'number',
}, async t => {
  const f = await fixture(t, `await agent('a'); await checkpoint('one'); return await agent('b');`);
  const stopped = await f.run();
  const evidencePath = join(await realpath(stopped.runDir), 'request.json');
  const replacement = join(f.dir, 'replacement.txt');
  await writeFile(replacement, 'outside evidence');
  const originalOpen = fsPromises.open;
  let swapped = false, readCalls = 0;
  t.mock.method(fsPromises, 'open', async function(path, flags, ...args) {
    if (path === evidencePath) {
      swapped = true;
      assert.notEqual(flags & constants.O_NOFOLLOW, 0);
      assert.notEqual(flags & constants.O_NONBLOCK, 0);
      await unlink(evidencePath);
      await symlink(replacement, evidencePath);
    }
    const handle = await originalOpen(path, flags, ...args);
    if (path === evidencePath) {
      const originalRead = handle.read.bind(handle);
      handle.read = async (...readArgs) => {
        readCalls++;
        return originalRead(...readArgs);
      };
    }
    return handle;
  });
  await assert.rejects(f.run({ resume: resume(stopped) }));
  assert.equal(swapped, true);
  assert.equal(readCalls, 0);
  assert.deepEqual(f.invoked, ['a']);
});
