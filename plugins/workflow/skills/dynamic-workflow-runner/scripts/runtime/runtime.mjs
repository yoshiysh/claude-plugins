import { fork } from 'node:child_process';
import { readFile, realpath, mkdir, writeFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import Ajv from 'ajv';
import { compileSource } from './source.mjs';
import { exactObject, requestKeys, limitKeys, validateRequirements } from './inputs.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
export async function Workflow(request, host = {}) {
  exactObject(request, requestKeys, 'Workflow request');
  exactObject(host, ['backend', 'runDir', 'trustedSource', 'requirements', ...limitKeys], 'Workflow host');
  validateRequirements(host.requirements);
  const { scriptPath, args = {} } = request;
  const {
  backend, runDir, trustedSource = false, maxAgents = 2, concurrency = 2,
  timeoutMs = 60000, maxOutputBytes = 1000000,
  } = host;
  if (!trustedSource) throw new Error('trustedSource acknowledgement required; not a hostile-code sandbox');
  if (!backend || typeof backend.run !== 'function') throw new Error('backend.run required');
  for (const [key, value] of Object.entries({ maxAgents, concurrency, timeoutMs, maxOutputBytes }))
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`invalid ${key}`);
  if (maxAgents > 1000 || concurrency > 16) throw new Error('agent limits exceed supported maximum');
  const path = await realpath(scriptPath);
  const source = await readFile(path, 'utf8');
  const { meta, body } = compileSource(source);
  const encodedArgs = JSON.stringify(args);
  if (encodedArgs === undefined) throw new Error('args must be JSON serializable');
  if (!runDir) throw new Error('new runDir required');
  // Exclusive directory: no overwrite, implicit resume, or replay of side effects.
  await mkdir(runDir, { mode: 0o700 });
  await writeFile(join(runDir, 'source.txt'), source, { mode: 0o600 });
  await writeFile(join(runDir, 'request.json'), JSON.stringify({ scriptPath: path, args: JSON.parse(encodedArgs),
    sourceHash: hash(source), argsHash: hash(encodedArgs), meta, requirements: host.requirements ?? [],
    limits: { maxAgents, concurrency, timeoutMs, maxOutputBytes } }, null, 2), { mode: 0o600 });
  let journal = Promise.resolve();
  let sequence = 0;
  const record = event => {
    journal = journal.then(() => appendFile(join(runDir, 'events.jsonl'),
      JSON.stringify({ sequence: ++sequence, time: new Date().toISOString(), ...event }) + '\n', { mode: 0o600 }));
    // Avoid unhandled rejection; finalization still awaits the original chain.
    journal.catch(() => {});
  };
  const ajv = new Ajv({ strict: true, allErrors: true });
  const worker = fork(new URL('./worker.mjs', import.meta.url), [], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'], execArgv: ['--max-old-space-size=128'],
    env: { PATH: process.env.PATH },
  });
  const abort = new AbortController();
  const queue = [];
  const inflight = new Set();
  let calls = 0, active = 0, settled = false, outputBytes = 0;
  record({ type: 'run.started' });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('workflow deadline exceeded')), timeoutMs);
    async function finish(error, result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      abort.abort();
      worker.kill('SIGKILL');
      record({ type: error ? 'run.failed' : 'run.completed', error: error?.message, result,
        inFlight: [...inflight], calls });
      try { await journal; } catch (e) { error = e; }
      if (error) reject(error); else resolve(result);
    }
    function pump() {
      while (!settled && active < concurrency && queue.length) {
        const task = queue.shift();
        active++; inflight.add(task.id);
        record({ type: 'agent.started', id: task.id, promptHash: hash(task.prompt), options: task.options });
        Promise.resolve().then(() => backend.run(task.prompt, task.options, {
          signal: abort.signal,
          emit: event => { if (!settled) record({ type: 'agent.event', id: task.id, event }); },
        })).then(result => {
          if (settled) return;
          if (result !== null && task.validate && !task.validate(result)) {
            record({ type: 'agent.invalid_output', id: task.id, errors: task.validate.errors });
            result = null;
          }
          const encoded = JSON.stringify(result);
          if (encoded === undefined) throw new Error('backend returned undefined');
          outputBytes += Buffer.byteLength(encoded);
          if (outputBytes > maxOutputBytes) return finish(new Error('output byte limit exceeded'));
          record({ type: 'agent.completed', id: task.id, result });
          worker.send({ type: 'reply', id: task.id, result });
        }).catch(error => {
          if (settled) return;
          if (error.fatal) return finish(error);
          record({ type: 'agent.failed', id: task.id, error: error.message });
          worker.send({ type: 'reply', id: task.id, result: null });
        }).finally(() => { active--; inflight.delete(task.id); pump(); });
      }
    }
    worker.on('error', finish);
    worker.on('exit', (code, signal) => { if (!settled) finish(new Error(`worker exited: ${code}/${signal}`)); });
    worker.stderr.on('data', () => {});
    worker.on('message', message => {
      if (settled) return;
      try {
        if (message.type === 'result') {
          outputBytes += Buffer.byteLength(JSON.stringify(message.result));
          if (outputBytes > maxOutputBytes) return finish(new Error('output byte limit exceeded'));
          return finish(null, message.result);
        }
        if (message.type === 'error') return finish(new Error(message.error));
        if (['phase', 'log'].includes(message.type)) {
          outputBytes += Buffer.byteLength(JSON.stringify(message));
          if (outputBytes > maxOutputBytes) return finish(new Error('output byte limit exceeded'));
          record(message); return;
        }
        if (message.type !== 'agent') throw new Error('unknown worker message');
        if (++calls > maxAgents) throw new Error('agent call budget exceeded');
        const { prompt, options } = message;
        if (typeof prompt !== 'string' || !prompt || !options || typeof options !== 'object' || Array.isArray(options))
          throw new Error('invalid agent arguments');
        if (Buffer.byteLength(prompt) > maxOutputBytes) throw new Error('prompt byte limit exceeded');
        for (const key of Object.keys(options))
          if (!['model', 'label', 'phase', 'schema'].includes(key)) throw new Error(`unsupported agent option: ${key}`);
        for (const key of ['model', 'label', 'phase'])
          if (options[key] !== undefined && typeof options[key] !== 'string') throw new Error(`invalid ${key}`);
        const validate = options.schema === undefined ? null : ajv.compile(options.schema);
        backend.validate?.(options);
        queue.push({ ...message, validate }); pump();
      } catch (error) { finish(error); }
    });
    worker.send({ type: 'start', args: JSON.parse(encodedArgs), meta, body });
  });
}
