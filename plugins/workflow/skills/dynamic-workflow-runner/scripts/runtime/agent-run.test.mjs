import assert from 'node:assert/strict';
import test from 'node:test';
import { runAgent } from './agent-run.mjs';

test('timeout waits for an aborted backend to finish its late write', async () => {
  let lateWriteFinished = false;
  const backend = {
    run: (_prompt, _options, { signal }) => new Promise(resolve => {
      signal.addEventListener('abort', () => {
        setTimeout(() => {
          lateWriteFinished = true;
          resolve('late result');
        }, 30);
      }, { once: true });
    }),
  };
  const outcome = await runAgent({ backend, task: { prompt: 'test', options: {} }, remainingMs: 1000, timeoutMs: 5 });
  assert.equal(outcome.timedOut, true);
  assert.equal(outcome.quiesced, true);
  assert.equal(lateWriteFinished, true);
});
