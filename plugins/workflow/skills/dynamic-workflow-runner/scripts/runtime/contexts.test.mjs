import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, symlink, unlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { contextPolicy } from './contexts.mjs';
import { codexBackend } from './codex.mjs';
import { Workflow } from './runtime.mjs';

const digest = text => createHash('sha256').update(text).digest('hex');
const profile = (overrides = {}) => ({ memory: 'off', apps: 'off', plugins: 'off', references: [], ...overrides });
const request = (overrides = {}) => ({ profiles: { local: profile() }, assignments: { Check: 'local' }, ...overrides });
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'workflow-context-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('context defaults do not certify inherited host state or override settings', async () => {
  const policy = contextPolicy();
  assert.equal((await policy.prepare()).status, 'host-context-unverified');
  assert.deepEqual((await policy.select({})).sdkConfig, {});
});

test('profiles bind exact labels, snapshot inputs and never change global configuration', async () => {
  const originalPath = process.env.PATH;
  const input = request({ profiles: { local: profile(), external: profile({ apps: 'inherit', plugins: 'inherit', memory: 'inherit' }) },
    assignments: { Check: 'local', Research: 'external' } });
  const policy = contextPolicy(input);
  input.assignments.Check = 'external'; input.profiles.local.memory = 'inherit';
  const local = await policy.select({ label: 'Check' });
  assert.deepEqual(local.sdkConfig, { features: { apps: false, plugins: false, remote_plugin: false },
    memories: { use_memories: false, generate_memories: false } });
  assert.equal(local.receipt.profile, 'local');
  assert.equal(local.receipt.settingsHash, digest(JSON.stringify(local.sdkConfig)));
  assert.deepEqual((await policy.select({ label: 'Research' })).sdkConfig, { features: {} });
  assert.throws(() => policy.validate({}), /unassigned/);
  assert.throws(() => policy.validate({ label: 'check' }), /unassigned/);
  assert.equal(process.env.PATH, originalPath);
  assert.equal(local.sdkConfig.skills, undefined); // never replace inherited skills.config array
});

test('unknown inputs and unsupported instruction or skill overrides fail closed', () => {
  for (const input of [null, {}, request({ profiles: {} }), request({ assignments: {} }),
    request({ assignments: { Check: 'missing' } }), request({ assignments: { ' ': 'local' } }),
    request({ extra: true }), request({ profiles: { local: profile({ memory: true }) } }),
    request({ profiles: { local: profile({ disabledSkills: [] }) } }),
    request({ profiles: { local: profile({ model_instructions_file: '/tmp/x' }) } }),
    request({ profiles: { local: profile({ references: [{ path: 'relative', sha256: 'a'.repeat(64) }] }) } }),
    request({ profiles: { local: profile({ references: [{ path: '/tmp/x', sha256: 1 }] }) } }),
  ]) assert.throws(() => contextPolicy(input));
});

test('reference availability, hashes, aliases and drift are checked before dispatch', async t => {
  const dir = await fixture(t), a = join(dir, 'role.md'), b = join(dir, 'other.md'), link = join(dir, 'link.md');
  await writeFile(a, 'role'); await writeFile(b, 'role'); await symlink(a, link);
  const input = request({ profiles: { local: profile({ references: [{ path: link, sha256: digest('role') }] }) } });
  const policy = contextPolicy(input);
  const receipt = await policy.prepare();
  assert.equal(receipt.profiles.local.references[0].sha256, digest('role'));
  await unlink(link); await symlink(b, link);
  await assert.rejects(policy.select({ label: 'Check' }), /drift/);
  await writeFile(b, 'changed');
  await assert.rejects(policy.prepare(), /changed/);
  const missing = contextPolicy(request({ profiles: { local: profile({ references: [{ path: join(dir, 'missing'), sha256: digest('role') }] }) } }));
  await assert.rejects(missing.prepare(), /ENOENT/);
  const duplicate = contextPolicy(request({ profiles: { local: profile({ references: [{ path: a, sha256: digest('role') }, { path: a, sha256: digest('role') }] }) } }));
  await assert.rejects(duplicate.prepare(), /duplicate/);
});

test('SDK settings are isolated by role while permissions, PATH, prompt and fresh threads remain intact', async () => {
  const instances = [], starts = [], prompts = [], events = [];
  class Fake {
    constructor(options) { this.options = options; instances.push(options); }
    startThread(options) { starts.push(options); return { async runStreamed(prompt) {
      prompts.push(prompt); return { events: (async function* () {
        yield { type: 'item.completed', item: { type: 'agent_message', text: 'ok' } };
        yield { type: 'turn.completed', usage: { input_tokens: 5, output_tokens: 1 } };
      })() };
    } }; }
  }
  const input = { cwd: tmpdir(), CodexClass: Fake, context: request({ profiles: { local: profile(), external: profile({ plugins: 'inherit' }) },
    assignments: { Check: 'local', Research: 'external' } }) };
  const backend = codexBackend(input);
  input.context = undefined;
  await Promise.all(['Check', 'Research'].map(label => backend.run('exact role prompt', { label }, { emit: e => events.push(e) })));
  assert.equal(instances.length, 2);
  assert.equal(instances[0].config.features.plugins, false);
  assert.equal(instances[1].config.features.plugins, undefined);
  for (const start of starts) {
    assert.equal(start.sandboxMode, 'read-only'); assert.equal(start.approvalPolicy, 'never');
    assert.equal(start.webSearchMode, 'disabled'); assert.equal(start.networkAccessEnabled, false);
  }
  assert.deepEqual(prompts, ['exact role prompt', 'exact role prompt']);
  assert.equal(events.filter(e => e.type === 'context.selected').length, 2);
  assert.ok(instances.every(x => x.config.features.multi_agent === false));
});

test('bad references prevent run creation and unknown labels cannot dispatch even when source catches errors', async t => {
  const dir = await fixture(t), source = join(dir, 'arbitrary.flow');
  await writeFile(source, 'export const meta={name:"x",description:"x"}; try { return await agent("x",{label:"Unknown"}); } catch { return "bypass"; }');
  let starts = 0;
  class Fake { startThread() { starts++; throw Error('must not dispatch'); } }
  const backend = codexBackend({ cwd: dir, CodexClass: Fake, context: request() });
  await assert.rejects(Workflow({ scriptPath: source }, { backend, runDir: join(dir, 'run'), trustedSource: true }), /unassigned/);
  assert.equal(starts, 0);
  const bad = codexBackend({ cwd: dir, CodexClass: Fake, context: request({ profiles: { local: profile({ references: [{ path: join(dir, 'absent'), sha256: digest('x') }] }) } }) });
  await assert.rejects(Workflow({ scriptPath: source }, { backend: bad, runDir: join(dir, 'not-created'), trustedSource: true }), /ENOENT/);
  await assert.rejects(readFile(join(dir, 'not-created', 'request.json')), /ENOENT/);
});
