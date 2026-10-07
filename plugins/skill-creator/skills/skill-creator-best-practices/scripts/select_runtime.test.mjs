import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const selector = fileURLToPath(new URL('./select_runtime.js', import.meta.url));
const run = async (...args) => JSON.parse((await execute(process.execPath, [selector, ...args])).stdout);

test('update stays native when available and is rejected on the Codex runner', async () => {
  assert.deepEqual(await run('--mode', 'update', '--native-available', '--runner-installed'),
    { selected_runtime: 'native', rejected_reason: null, halt: false });
  const rejected = await run('--mode', 'update', '--no-native', '--runner-installed');
  assert.equal(rejected.selected_runtime, null);
  assert.match(rejected.rejected_reason, /rejected_source: mode=update/);
  assert.equal(rejected.halt, true);
  assert.deepEqual(await run('--mode', 'update', '--no-native', '--runner-installed', '--update-policy-bound'),
    { selected_runtime: 'dynamic-workflow-runner', rejected_reason: null, halt: false });
  assert.equal((await run('--mode', 'update', '--no-native', '--no-runner', '--update-policy-bound')).halt, true);
});

test('audit stays native when available and is rejected on the Codex runner like review', async () => {
  assert.deepEqual(await run('--mode', 'audit', '--native-available', '--runner-installed'),
    { selected_runtime: 'native', rejected_reason: null, halt: false });
  const rejected = await run('--mode', 'audit', '--no-native', '--runner-installed');
  assert.equal(rejected.selected_runtime, null);
  assert.match(rejected.rejected_reason, /rejected_source: mode=audit/);
  assert.equal(rejected.halt, true);
});
