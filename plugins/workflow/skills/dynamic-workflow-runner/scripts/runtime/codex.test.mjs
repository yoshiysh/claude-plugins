import test from 'node:test';
import assert from 'node:assert/strict';
import { codexBackend } from './codex.mjs';
import { fileURLToPath } from 'node:url';

test('SDK adapter fresh threads, schema, restrictive options, events and explicit model mapping', async () => {
  const starts = [], turns = [], emitted = [];
  class FakeCodex {
    startThread(options) {
      starts.push(options);
      return { async runStreamed(prompt, opts) {
        turns.push({ prompt, opts });
        return { events: (async function* () {
          yield { type: 'thread.started', thread_id: 'mock-thread' };
          yield { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({json:'{"ok":true}'}) } };
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
  assert.notEqual(turns[0].opts.signal, signal);
  assert.equal(turns[0].opts.outputSchema.additionalProperties, false);
  assert.equal(emitted.length, 6);
  assert.ok(turns.every(turn => turn.prompt.startsWith('test\n\n[OUTPUT TRANSPORT]')));
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

test('failure events are drained and finished SDK children are detached from later abort', async () => {
  let drained = false, childSignal;
  class Failed {
    startThread() { return { async runStreamed(prompt, options) {
      childSignal = options.signal;
      return { events: (async function* () {
        yield { type: 'error', message: 'schema rejected' };
        drained = true;
      })() };
    } }; }
  }
  const controller = new AbortController();
  await assert.rejects(codexBackend({cwd:'/tmp',CodexClass:Failed}).run('x',{}, {
    signal:controller.signal,emit() {},
  }), /schema rejected/);
  assert.equal(drained,true);
  controller.abort();
  assert.equal(childSignal.aborted,false);
});

test('active SDK cancellation is forwarded', async () => {
  const controller = new AbortController();
  class Pending {
    startThread() { return { async runStreamed(prompt, {signal}) {
      return { events: (async function* () {
        const aborted = new Promise(resolve => signal.addEventListener('abort',resolve,{once:true}));
        controller.abort();
        await aborted;
        signal.throwIfAborted();
      })() };
    } }; }
  }
  await assert.rejects(codexBackend({cwd:'/tmp',CodexClass:Pending}).run('x',{}, {
    signal:controller.signal,emit() {},
  }), /abort/i);
});

test('transport preserves optional, nullable, nested and additional caller properties without mutation', async () => {
  const schema={type:'object',properties:{optional:{type:'number'},nested:{type:'object'}},required:['nested']};
  const before=JSON.stringify(schema);
  const result={nested:{extra:null},additional:[1,null]};
  class Structured {
    startThread() { return { async runStreamed(prompt,opts) {
      assert.equal(opts.outputSchema.additionalProperties,false);
      assert.ok(prompt.includes(before));
      return {events:(async function* () {
        yield {type:'item.completed',item:{type:'agent_message',text:JSON.stringify({json:JSON.stringify(result)})}};
        yield {type:'turn.completed'};
      })()};
    } }; }
  }
  assert.deepEqual(await codexBackend({cwd:'/tmp',CodexClass:Structured}).run('role',{schema},{emit(){}}),result);
  assert.equal(JSON.stringify(schema),before);
});

test('malformed envelopes are rejected rather than inferred or retried', async () => {
  for (const text of ['null','{}','{"json":{}}','{"json":"not json"}','{"json":"{}","extra":1}']) {
    class Invalid {
      startThread() { return {async runStreamed() { return {events:(async function* () {
        yield {type:'item.completed',item:{type:'agent_message',text}};
        yield {type:'turn.completed'};
      })()};} }; }
    }
    await assert.rejects(codexBackend({cwd:'/tmp',CodexClass:Invalid}).run('role',{schema:{type:'object'}},{emit(){}}));
  }
});

test('real pinned SDK drains CLI error process before host abort (no inference)', async () => {
  const controller = new AbortController();
  await assert.rejects(codexBackend({cwd:'/tmp',
    codexPathOverride:fileURLToPath(new URL('./sdk-error-fixture.mjs',import.meta.url)),
  }).run('fixture',{}, {signal:controller.signal,emit(){}}), /fixture API rejection/);
  controller.abort();
  await new Promise(resolve => setTimeout(resolve,30));
});
