import test from 'node:test';
import assert from 'node:assert/strict';
import { codexBackend } from './codex.mjs';

test('SDK adapter fresh threads, schema, restrictive options, events and explicit model mapping', async () => {
  const starts = [], turns = [], emitted = [];
  class FakeCodex {
    startThread(options) {
      starts.push(options);
      return { async runStreamed(prompt, opts) {
        turns.push({ prompt, opts });
        return { events: (async function* () {
          yield { type: 'thread.started', thread_id: 'mock-thread' };
          yield { type: 'item.completed', item: { type: 'agent_message', text: '{"ok":true}' } };
          yield { type: 'turn.completed', usage: { input_tokens: 3, output_tokens: 2 } };
        })() };
      } };
    }
  }
  const backend = codexBackend({ cwd: '/tmp', modelMap: { sonnet: {
    model: 'explicit-model', modelReasoningEffort: 'high',
  } }, CodexClass: FakeCodex });
  assert.throws(() => backend.validate({ model: 'opus' }), /mapping/);
  const signal = new AbortController().signal;
  for (let i = 0; i < 2; i++) {
    const result = await backend.run('test', { model: 'sonnet', schema: { type: 'object' } }, { signal, emit: e => emitted.push(e) });
    assert.deepEqual(result, { ok: true });
  }
  assert.equal(starts.length, 2);
  assert.equal(starts[0].sandboxMode, 'read-only');
  assert.equal(starts[0].approvalPolicy, 'never');
  assert.equal(starts[0].networkAccessEnabled, false);
  assert.equal(starts[0].model, 'explicit-model');
  assert.equal(starts[0].modelReasoningEffort, 'high');
  assert.equal(turns[0].opts.signal, signal);
  assert.equal(emitted.length, 6);
  assert.deepEqual(turns.map(turn => turn.prompt), ['test', 'test']);
  assert.deepEqual(emitted[0], { type: 'model.selected', requested: 'sonnet', origin: 'explicit',
    model: 'explicit-model', modelReasoningEffort: 'high' });
});

test('SDK adapter rejects stream without completion', async () => {
  class Broken {
    startThread() { return { async runStreamed() { return { events: (async function* () {})() }; } }; }
  }
  await assert.rejects(codexBackend({ cwd: '/tmp', CodexClass: Broken }).run('x', {}, {
    signal: new AbortController().signal, emit() {},
  }), /incomplete/);
});
