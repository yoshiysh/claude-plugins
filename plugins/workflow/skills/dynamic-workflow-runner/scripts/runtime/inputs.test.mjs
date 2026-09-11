import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, access, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { Workflow } from './runtime.mjs';
import { codexBackend } from './codex.mjs';
import { compileSource } from './source.mjs';

test('unknown resume, permission and budget settings fail before source or backend access', async () => {
  const request = { scriptPath: '/missing' };
  const host = { trustedSource: true, backend: { run() { throw Error('must not call'); } } };
  for (const key of ['resumeFromRunId', 'resume', 'approvalPolicy'])
    await assert.rejects(Workflow({ ...request, [key]: true }, host), /unsupported Workflow request field/);
  for (const key of ['resume', 'sandboxMode', 'approvalPolicy', 'maxTokens'])
    await assert.rejects(Workflow(request, { ...host, [key]: true }), /unsupported Workflow host field/);
  for (const requirement of ['worktree', 'workspace-write', 'approval-forwarding', 'resume'])
    await assert.rejects(Workflow(request, { ...host, requirements: [requirement] }), /unsupported runtime requirement/);
  for (const key of ['sandboxMode', 'approvalPolicy', 'resumeFromRunId'])
    assert.throws(() => codexBackend({ cwd: '/tmp', [key]: true }), /unsupported Codex backend field/);
});

test('unchanged PDCA source rejects isolation before builder and before run creation', async t => {
  const root = await mkdtemp(join(tmpdir(), 'workflow-preflight-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let calls = 0;
  await assert.rejects(Workflow({
    scriptPath: fileURLToPath(new URL('../../../pdca/scripts/pdca.js', import.meta.url)),
    args: {},
  }, { backend: { run() { calls++; } }, runDir: join(root, 'run'), trustedSource: true }),
  /unsupported source capability option: isolation/);
  assert.equal(calls, 0);
  await assert.rejects(access(join(root, 'run')), { code: 'ENOENT' });
});

test('source metadata requirements gate execution, including inactive branches', () => {
  assert.throws(() => compileSource(`export const meta = {name:'x',description:'x',requirements:['resume']}; return 1;`), /unsupported runtime requirement/);
  assert.throws(() => compileSource(`export const meta = {name:'x',description:'x'};
    if(false) agent('x', {model:'x',isolation:'worktree'}); return 1;`), /unsupported source capability/);
});

test('CLI rejects unsupported request and limits without inference', async t => {
  const root = await mkdtemp(join(tmpdir(), 'workflow-cli-check-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const value of [{ resumeFromRunId: 'previous' }, { limits: { maxTokens: 1 } }]) {
    const request = join(root, 'request.json');
    await writeFile(request, JSON.stringify(value));
    await assert.rejects(promisify(execFile)(process.execPath,
      [fileURLToPath(new URL('./cli.mjs', import.meta.url)), request, '--live', '--trusted-source']),
    error => /unsupported/.test(error.stderr));
  }
});
