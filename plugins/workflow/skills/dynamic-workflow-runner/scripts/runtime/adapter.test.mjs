import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkflow, executeWorkflow, workflowContext } from './adapter.mjs';
import { contextPolicy } from './contexts.mjs';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'workflow-adapter-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const configs = [], prompts = [];
  class Fake {
    constructor(config) { configs.push(config); }
    startThread(options) {
      assert.equal(options.sandboxMode, 'read-only');
      assert.equal(options.approvalPolicy, 'never');
      return { async runStreamed(prompt) { prompts.push(prompt); return { events: (async function* () {
        yield { type: 'item.completed', item: { type: 'agent_message', text: prompt } };
        yield { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } };
      })() }; } };
    }
  }
  return { dir, configs, prompts, host: { cwd: dir, runRoot: dir, trustedSource: true, CodexClass: Fake } };
}

test('host default handles dynamic and absent labels without removing plugin dependencies', async () => {
  const input = workflowContext(), policy = contextPolicy(input);
  input.defaultProfile = 'changed';
  for (const label of [undefined, 'Check-1', 'Check-999', '任意の担当']) {
    const selected = await policy.select({ label });
    assert.deepEqual(selected.sdkConfig, { features: {}, memories: { use_memories: false, generate_memories: false } });
    assert.equal(selected.receipt.selection, 'host-default');
  }
  const explicit = workflowContext();
  explicit.profiles.local = { memory: 'off', apps: 'off', plugins: 'off', references: [] };
  explicit.assignments.Check = 'local';
  assert.equal((await contextPolicy(explicit).select({ label: 'Check' })).receipt.selection, 'exact-label');
  for (const defaultProfile of [null, '', 'missing', 1]) assert.throws(() => contextPolicy({ ...workflowContext(), defaultProfile }));
});

test('bound standard calls preserve args, prompts and return shape across arbitrary source names', async t => {
  const { dir, host, configs, prompts } = await fixture(t);
  const a = join(dir, 'not-a-fixed-name.flow'), b = join(dir, 'another.source');
  await writeFile(a, 'export const meta={name:"a",description:"a"}; return await parallel(args.items.map((x,i)=>()=>agent(x,{label:`Role-${i}`})));');
  await writeFile(b, 'export const meta={name:"b",description:"b"}; return {answer:await agent(args.text)};');
  const Workflow = createWorkflow(host);
  host.context = { invalid: true };
  const call = { scriptPath: a, args: { items: ['one', 'two'] } };
  const pending = Workflow(call);
  call.args.items[0] = 'mutated';
  const [first, second] = await Promise.all([pending, Workflow({ scriptPath: b, args: { text: 'three' } })]);
  assert.deepEqual(first, ['one', 'two']);
  assert.deepEqual(second, { answer: 'three' });
  assert.deepEqual([...prompts].sort(), ['one', 'three', 'two']);
  assert.equal(configs.length, 3);
  assert.ok(configs.every(x => x.config.memories.use_memories === false && x.config.features.plugins === undefined));
  const runs = (await readdir(dir, { withFileTypes: true })).filter(x => x.isDirectory());
  assert.equal(runs.length, 2);
  for (const entry of runs) {
    const receipt = JSON.parse(await readFile(join(dir, entry.name, 'request.json'), 'utf8'));
    assert.equal(receipt.backendPolicy.context.defaultProfile, 'workflow');
  }
});

test('one-shot and bound adapters apply identical defaults and explicit inherit policy', async t => {
  const { dir, host, configs } = await fixture(t);
  const scriptPath = join(dir, 'input.txt');
  await writeFile(scriptPath, 'export const meta={name:"x",description:"x"}; return await agent("unchanged");');
  const { runRoot, ...once } = host;
  assert.equal(await executeWorkflow({ scriptPath }, { ...once, runDir: join(dir, 'once') }), 'unchanged');
  const inherited = workflowContext(); inherited.profiles.workflow.memory = 'inherit';
  assert.equal(await createWorkflow({ ...host, context: inherited })({ scriptPath }), 'unchanged');
  assert.equal(configs[0].config.memories.use_memories, false);
  assert.equal(configs[1].config.memories, undefined);
});

test('adapter rejects authority and call-shape overrides without dispatch', async t => {
  const { host, configs } = await fixture(t);
  assert.throws(() => createWorkflow({ ...host, trustedSource: false }), /trustedSource/);
  assert.throws(() => createWorkflow({ ...host, runRoot: 'relative' }), /absolute/);
  assert.throws(() => createWorkflow({ ...host, arbitrary: true }), /unsupported/);
  await assert.rejects(createWorkflow(host)({ scriptPath: '/missing', context: workflowContext() }), /unsupported/);
  const { runRoot, ...once } = host;
  assert.throws(() => executeWorkflow({ scriptPath: '/missing' }, { ...once, runDir: join(runRoot, 'null'), context: null }), /context/);
  assert.equal(configs.length, 0);
});
