import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, realpath, writeFile, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Codex } from '@openai/codex-sdk';
import { createWorkflow, executeWorkflow, workflowContext } from './adapter.mjs';
import { contextPolicy } from './contexts.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../../');

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
  const directories = (await readdir(dir, { withFileTypes: true })).filter(x => x.isDirectory());
  const runs = [];
  for (const entry of directories) {
    try { await stat(join(dir, entry.name, 'request.json')); runs.push(entry); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
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
  assert.throws(() => createWorkflow({ ...host, updateContract: { targetRoot: host.cwd, stagingRoot: host.cwd, targetDir: host.cwd, stagingDir: host.cwd } }), /unsupported/);
  assert.throws(() => executeWorkflow({ scriptPath: '/unused', args: { mode: 'update' } },
    { cwd: host.cwd, runDir: host.cwd, trustedSource: true, CodexClass: host.CodexClass }), /createWorkflow host updatePolicy/);
  await assert.rejects(createWorkflow(host)({ scriptPath: '/missing', context: workflowContext() }), /unsupported/);
  const { runRoot, ...once } = host;
  assert.throws(() => executeWorkflow({ scriptPath: '/missing' }, { ...once, runDir: join(runRoot, 'null'), context: null }), /context/);
  assert.equal(configs.length, 0);
});

test('createWorkflow binds skill-creator update to host policy and returns a staged package', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'workflow-adapter-update-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const targetRoot = join(dir, 'targets'), stagingRoot = join(dir, 'staging'), runRoot = join(dir, 'runs');
  const workerDirectory = join(dir, 'worker'), targetDir = join(targetRoot, 'example');
  await Promise.all([mkdir(targetRoot), mkdir(stagingRoot), mkdir(runRoot), mkdir(workerDirectory), mkdir(targetDir)]);
  const [canonicalTargetRoot, canonicalStagingRoot, canonicalRunRoot, canonicalWorkerDirectory, canonicalTargetDir] =
    await Promise.all([targetRoot, stagingRoot, runRoot, workerDirectory, targetDir].map(path => realpath(path)));
  await writeFile(join(targetDir, 'SKILL.md'), 'before\n');

  const scriptPath = join(repoRoot, 'plugins/skill-creator/skills/skill-creator-best-practices/scripts/review_skill.js');
  const calls = [];
  const originalStartThread = Codex.prototype.startThread;
  Codex.prototype.startThread = function (options) {
    const sdkConfig = this.options.config;
    calls.push({ ...options, sdkConfig });
    return { async runStreamed(prompt) {
      const update = options.model === 'test-updater';
      if (update) {
        assert.equal(options.sandboxMode, 'workspace-write');
        assert.equal(options.workingDirectory.startsWith(canonicalStagingRoot + '/'), true);
        for (const entry of await readdir(targetDir))
          await cp(join(targetDir, entry), join(options.workingDirectory, entry), { recursive: true });
        await writeFile(join(options.workingDirectory, 'SKILL.md'), 'after\n');
      } else {
        assert.equal(options.model, 'test-reviewer');
        assert.equal(options.sandboxMode, 'read-only');
        assert.equal(options.workingDirectory, canonicalWorkerDirectory);
      }
      const result = prompt.includes('"changed_files"')
        ? { changed_files: [{ path: 'SKILL.md', reason: 'test update', findings_addressed: [] }], summary: 'updated' }
        : { findings: [], scanned_files: ['SKILL.md'], unreadable: false,
            ...(prompt.includes('"unchecked_judgments"') ? { unchecked_judgments: [] } : {}) };
      return { events: (async function* () {
        yield { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ json: JSON.stringify(result) }) } };
        yield { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } };
      })() };
    } };
  };

  try {
    const Workflow = createWorkflow({
      cwd: canonicalWorkerDirectory,
      runRoot: canonicalRunRoot,
      trustedSource: true,
      modelMap: {
        sonnet: { model: 'test-reviewer', modelReasoningEffort: 'low' },
        opus: { model: 'test-updater', modelReasoningEffort: 'low' },
      },
      maxAgents: 64,
      concurrency: 8,
      timeoutMs: 60000,
      agentTimeoutMs: 48000,
      updatePolicy: { targetRoot: canonicalTargetRoot, stagingRoot: canonicalStagingRoot },
    });
    let result;
    try {
      result = await Workflow({
        scriptPath,
        args: {
          skillDir: join(repoRoot, 'plugins/skill-creator/skills/skill-creator-best-practices'),
          mode: 'update',
          target: { skillPath: targetDir, scope: 'full' },
          uncheckedItems: [],
          intent: 'exercise the adapter update route',
        },
      });
    } catch (error) {
      const runs = await readdir(canonicalRunRoot);
      const events = (await readFile(join(canonicalRunRoot, runs[0], 'events.jsonl'), 'utf8'))
        .trim().split('\n').map(line => JSON.parse(line)).filter(event => event.type === 'agent.failed');
      throw new Error(`${error.message}; agent failures: ${JSON.stringify(events.map(({ id, error: message }) => ({ id, message })))}`);
    }

    assert.equal(result.source_result.verdict, 'applied_to_staging');
    assert.equal(result.source_result.target.skillPath, canonicalTargetDir);
    assert.equal(result.action_package.changed_files[0].operation, 'update');
    assert.equal(result.action_package.changed_files[0].path, 'SKILL.md');
    assert.equal(result.action_package.apply.source_dir, canonicalTargetDir);
    assert.equal(result.action_package.apply.staging_dir.startsWith(canonicalStagingRoot + '/update-'), true);
    assert.equal(result.action_package_sha256.length, 64);
    assert.equal(await readFile(join(canonicalTargetDir, 'SKILL.md'), 'utf8'), 'before\n');
    assert.equal(await readFile(join(result.action_package.apply.staging_dir, 'SKILL.md'), 'utf8'), 'after\n');
    assert.ok(calls.some(call => call.sandboxMode === 'workspace-write'));
    assert.ok(calls.filter(call => call.sandboxMode === 'workspace-write').every(call =>
      call.sdkConfig.sandbox_workspace_write.network_access === false &&
      call.sdkConfig.sandbox_workspace_write.exclude_slash_tmp === true &&
      call.sdkConfig.sandbox_workspace_write.exclude_tmpdir_env_var === true &&
      call.sdkConfig.sandbox_workspace_write.writable_roots.length === 0));
    assert.ok(calls.filter(call => call.sandboxMode === 'read-only').every(call => call.workingDirectory === canonicalWorkerDirectory));
  } finally {
    Codex.prototype.startThread = originalStartThread;
  }
});

test('createWorkflow requires host update policy and rejects mismatched target or staging before dispatch', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'workflow-adapter-update-policy-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const targetRoot = join(dir, 'targets'), stagingRoot = join(dir, 'staging');
  const targetDir = join(targetRoot, 'inside'), outsideTarget = join(dir, 'outside');
  const runRoot = join(dir, 'runs'), workerDirectory = join(dir, 'worker');
  await Promise.all([mkdir(targetRoot), mkdir(stagingRoot), mkdir(runRoot), mkdir(workerDirectory), mkdir(outsideTarget)]);
  await mkdir(targetDir);
  let dispatches = 0;
  const originalStartThread = Codex.prototype.startThread;
  Codex.prototype.startThread = function () {
    dispatches++;
    throw new Error('must fail before dispatch');
  };
  const request = target => ({ scriptPath: '/unused', args: { mode: 'update', target: { skillPath: target } } });
  try {
    const noPolicy = createWorkflow({ cwd: workerDirectory, runRoot, trustedSource: true });
    await assert.rejects(noPolicy(request(targetDir)), /explicit host updatePolicy/);

    const Workflow = createWorkflow({ cwd: workerDirectory, runRoot, trustedSource: true,
      updatePolicy: { targetRoot, stagingRoot } });
    await assert.rejects(Workflow(request(outsideTarget)), /outside updatePolicy\.targetRoot/);
    await assert.rejects(Workflow({
      scriptPath: '/unused',
      args: { mode: 'update', target: { skillPath: targetDir }, stagingDir: join(stagingRoot, 'caller-selected') },
    }), /cannot override it/);
    assert.equal(dispatches, 0);
  } finally {
    Codex.prototype.startThread = originalStartThread;
  }
});
