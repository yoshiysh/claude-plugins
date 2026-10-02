import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Workflow } from './runtime.mjs';
import { codexBackend } from './codex.mjs';
import { modelResolver, reasoningEfforts } from './models.mjs';

async function fixture(t, body, checkpoint = false) {
  const dir = await mkdtemp(join(tmpdir(), 'workflow-effort-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const scriptPath = join(dir, 'effort.flow');
  await writeFile(scriptPath, `export const meta={name:'effort',description:'test'};\n${body}`);
  const starts = [];
  class FakeCodex {
    startThread(options) {
      starts.push(options);
      return { async runStreamed(prompt) {
        return { events: (async function* () {
          yield { type: 'item.completed', item: { type: 'agent_message', text: prompt } };
          yield { type: 'turn.completed' };
        })() };
      } };
    }
  }
  const backend = codexBackend({ cwd: dir, model: 'default-target', modelReasoningEffort: 'medium',
    modelMap: { sonnet: { model: 'mapped-target', modelReasoningEffort: 'high' }, bare: 'bare-target' },
    environment: { path: '/usr/bin:/bin', requiredCommands: ['sh'] }, CodexClass: FakeCodex });
  let index = 0;
  const run = extra => Workflow({ scriptPath, args: {} }, { backend, trustedSource: true,
    timeoutMs: 10000, maxAgents: 8, runDir: join(dir, `run-${++index}`),
    ...(checkpoint ? { checkpoint: { files: [scriptPath], dependenciesComplete: true, stopAfter: 'one' } } : {}),
    ...extra });
  const events = async number => (await readFile(join(dir, `run-${number}`, 'events.jsonl'), 'utf8'))
    .trim().split('\n').map(JSON.parse);
  return { run, starts, events, backend };
}

function extractSdkEfforts(types) {
  const declaration = types.match(/\btype\s+ModelReasoningEffort\s*=\s*([^;]+);/);
  assert.ok(declaration, 'SDK declaration for ModelReasoningEffort must exist');
  return [...declaration[1].matchAll(/"([^"]+)"/g)].map(match => match[1]);
}

test('SDK effort extraction accepts declaration whitespace changes', () => {
  const declaration = '"none" | "low" | "medium" | "high"';
  for (const source of [
    `type ModelReasoningEffort = ${declaration};`,
    `type ModelReasoningEffort =\n  ${declaration};`,
    `type\tModelReasoningEffort  \t=   ${declaration};`,
    `type\nModelReasoningEffort = ${declaration};`,
  ]) {
    assert.deepEqual(extractSdkEfforts(source), ['none', 'low', 'medium', 'high']);
  }
  assert.throws(() => extractSdkEfforts('type OtherEffort = "low";'),
    /SDK declaration for ModelReasoningEffort must exist/);
});

test('effort policy matches the pinned SDK type and override retains model mapping policy', async () => {
  const types = await readFile(new URL('./node_modules/@openai/codex-sdk/dist/index.d.ts', import.meta.url), 'utf8');
  const sdkEfforts = extractSdkEfforts(types);
  assert.deepEqual(reasoningEfforts, sdkEfforts);
  const resolve = modelResolver({ model: 'default', modelReasoningEffort: 'medium',
    modelMap: { source: { model: 'mapped', modelReasoningEffort: 'high' } } });
  for (const effort of sdkEfforts) {
    assert.equal(resolve('source', effort).modelReasoningEffort, effort);
    assert.equal(resolve(undefined, effort).modelReasoningEffort, effort);
  }
  assert.equal(resolve('source').modelReasoningEffort, 'high');
  assert.equal(resolve().modelReasoningEffort, 'medium');
  assert.deepEqual(modelResolver()(undefined, 'low'), {
    requested: null, origin: 'host-default', modelReasoningEffort: 'low',
  });
  assert.throws(() => resolve('unknown', 'low'), /mapping/);
  assert.throws(() => resolve('source', 'guess'), /invalid agent effort/);
});

test('one-shot source effort reaches SDK thread options and model selection logs', async t => {
  const f = await fixture(t, `await agent('mapped',{model:'sonnet',effort:'low'});
    await agent('default',{effort:'high'}); await agent('mapped omitted',{model:'sonnet'});
    await agent('default omitted'); return await agent('bare',{model:'bare',effort:'medium'});`);
  assert.equal(await f.run(), 'bare');
  assert.deepEqual(f.starts.map(({ model, modelReasoningEffort }) => [model, modelReasoningEffort]), [
    ['mapped-target', 'low'], ['default-target', 'high'], ['mapped-target', 'high'],
    ['default-target', 'medium'], ['bare-target', 'medium'],
  ]);
  const events = await f.events(1);
  assert.deepEqual(events.filter(e => e.type === 'agent.event' && e.event.type === 'model.selected').map(e => e.event.modelReasoningEffort),
    f.starts.map(e => e.modelReasoningEffort));
  assert.equal(events.find(e => e.type === 'agent.started').options.effort, 'low');
});

test('checkpoint/resume uses effective effort and dispatches only new agents', async t => {
  const f = await fixture(t, `const first=await agent('first',{model:'bare',effort:'low'});
    await checkpoint('one'); return await agent(first+' second',{effort:'high'});`, true);
  assert.doesNotThrow(() => f.backend.validateCheckpoint({ model: 'bare', effort: 'low' }));
  assert.throws(() => f.backend.validateCheckpoint({ model: 'bare' }), /explicit model and reasoning effort/);
  const stopped = await f.run();
  assert.equal(stopped.status, 'checkpoint');
  assert.equal(await f.run({ resume: { previousRun: stopped.runDir, freshness: 'verified' } }), 'first second');
  assert.deepEqual(f.starts.map(({ model, modelReasoningEffort }) => [model, modelReasoningEffort]),
    [['bare-target', 'low'], ['default-target', 'high']]);
  const firstEvents = await f.events(1), continuedEvents = await f.events(2);
  assert.equal(firstEvents.find(e => e.type === 'agent.accepted').options.effort, 'low');
  assert.equal(continuedEvents.filter(e => e.type === 'agent.started').at(-1).options.effort, 'high');
  assert.equal(continuedEvents.filter(e => e.type === 'agent.event' && e.event.type === 'model.selected').at(-1).event.modelReasoningEffort, 'high');
});

for (const checkpoint of [false, true]) {
  test(`invalid efforts fail before SDK dispatch (${checkpoint ? 'checkpoint' : 'one-shot'})`, async t => {
    for (const effort of ['guess', 'none', '', null, 1, {}, []]) {
      const f = await fixture(t, `return await agent('x',{effort:${JSON.stringify(effort)}});`, checkpoint);
      await assert.rejects(f.run(), /invalid agent effort/);
      assert.equal(f.starts.length, 0);
      assert.throws(() => f.backend.validate({ effort }), /invalid agent effort/);
    }
  });

  test(`runtime validates effort for custom backends (${checkpoint ? 'checkpoint' : 'one-shot'})`, async t => {
    const f = await fixture(t, `return await agent('x',{effort:'guess'});`, checkpoint);
    let calls = 0, validations = 0;
    await assert.rejects(f.run({ backend: { resumeIdentity: 'custom-backend',
      validate() { validations++; }, validateCheckpoint() { validations++; },
      run: async () => { calls++; return 'wrong'; } } }), /invalid agent effort/);
    assert.equal(calls, 0);
    assert.equal(validations, 0);
  });
}

test('resume rejects invalid effort beyond the checkpoint before new SDK dispatch', async t => {
  const f = await fixture(t, `await agent('first',{effort:'low'}); await checkpoint('one');
    return await agent('second',{effort:'guess'});`, true);
  const stopped = await f.run();
  assert.equal(stopped.status, 'checkpoint');
  await assert.rejects(f.run({ resume: { previousRun: stopped.runDir, freshness: 'verified' } }), /invalid agent effort/);
  assert.equal(f.starts.length, 1);
});
