// Process isolation bounds hangs; vm is NOT a security boundary for hostile code.
import vm from 'node:vm';
const pending = new Map();
let next = 0;
process.on('message', async message => {
  if (message.type === 'reply') {
    const p = pending.get(message.id);
    if (!p) return;
    pending.delete(message.id);
    if (message.error) p.reject(new Error(message.error));
    else p.resolve(message.result);
    return;
  }
  if (message.type !== 'start') return;
  const rpc = (prompt, options) => new Promise((resolve, reject) => {
    const id = ++next;
    pending.set(id, { resolve, reject });
    process.send({ type: 'agent', id, prompt, options });
  });
  const emit = (type, value) => process.send({ type, value });
  const context = vm.createContext({ __rpc: rpc, __emit: emit, __args: JSON.stringify(message.args), __meta: JSON.stringify(message.meta) },
    { codeGeneration: { strings: false, wasm: false } });
  try {
    new vm.Script(`
      const args = JSON.parse(__args), meta = JSON.parse(__meta);
      const agent = (prompt, options = {}) => __rpc(prompt, options);
      const phase = value => { if (typeof value !== 'string') throw Error('phase must be a string'); __emit('phase', value); };
      const log = value => __emit('log', String(value));
      const parallel = tasks => {
        if (!Array.isArray(tasks) || tasks.length > 4096 || tasks.some(t => typeof t !== 'function'))
          throw Error('parallel requires at most 4096 task functions');
        return Promise.all(tasks.map(task => Promise.resolve().then(task)));
      };
      const pipeline = (items, fn) => {
        if (!Array.isArray(items) || items.length > 4096 || typeof fn !== 'function')
          throw Error('pipeline requires at most 4096 items and a function');
        return parallel(items.map((item, index) => () => fn(item, index)));
      };
      const OriginalDate = Date;
      Date = class extends OriginalDate {
        constructor(...values) { if (!values.length) throw Error('pass timestamp through args'); super(...values); }
        static now() { throw Error('pass timestamp through args'); }
      };
      Math.random = () => { throw Error('pass randomness through args'); };
    `).runInContext(context, { timeout: 1000 });
    const result = await new vm.Script(`(async () => { "use strict"; ${message.body}\n})()`).runInContext(context, { timeout: 1000 });
    if (pending.size) throw new Error('unawaited agent calls at workflow return');
    process.send({ type: 'result', result: result ?? null });
  } catch (error) {
    process.send({ type: 'error', error: error.message });
  }
});
