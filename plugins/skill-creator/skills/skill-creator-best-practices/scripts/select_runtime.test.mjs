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
});
