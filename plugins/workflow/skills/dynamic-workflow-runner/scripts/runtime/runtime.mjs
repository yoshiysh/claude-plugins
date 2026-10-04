import { fork } from 'node:child_process';
import { readFile, realpath, mkdir, writeFile, appendFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import Ajv from 'ajv';
import { compileSource } from './source.mjs';
import { agentOptionKeys, exactObject, requestKeys, limitKeys, validateRequirements } from './inputs.mjs';
import { resumableWorkflow } from './resume.mjs';
import { enforcesUpdateBoundary } from './codex.mjs';
import { finalizeUpdateContract, prepareUpdateContract, verifyUpdateTarget } from './update-contract.mjs';
import { validateEffort } from './models.mjs';
import { runAgent } from './agent-run.mjs';
import { createRunWorkspace } from './run-workspace.mjs';
import { namedHostKeys, namedResult, resolveNamedWorkflow, validateNamedWorkspace } from './named.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
export async function Workflow(request, host = {}) {
  exactObject(request, requestKeys, 'Workflow request');
  exactObject(host, ['backend', 'runDir', 'trustedSource', 'requirements', 'updateContract', 'checkpoint', 'resume', ...namedHostKeys, ...limitKeys], 'Workflow host');
  if (host.trustedSource !== true) throw Error('trustedSource acknowledgement required; not a hostile-code sandbox');
  const capabilities = Object.freeze([...(host.backend?.capabilities ?? ['read-only', 'fresh-thread'])]);
  const resolved = await resolveNamedWorkflow(request, host, capabilities);
  request = resolved.request;
  if (host.updateContract !== undefined && (host.checkpoint !== undefined || host.resume !== undefined))
    throw new Error('update contract cannot use checkpoint or resume');
  if (host.checkpoint !== undefined || host.resume !== undefined) return resumableWorkflow(request, host);
  validateRequirements(host.requirements, capabilities);
  const { scriptPath } = request;
  let args;
  try {
    args = structuredClone(request.args ?? {});
    if (JSON.stringify(args) === undefined) throw new Error('args are not JSON serializable');
  }
  catch { throw new Error('args must be JSON serializable'); }
  const {
  backend, runDir, trustedSource = false, maxAgents = 2, concurrency = 2,
  timeoutMs = 60000, agentTimeoutMs = Math.max(1, Math.floor(timeoutMs * 0.8)), maxOutputBytes = 1000000,
  } = host;
  if (!trustedSource) throw new Error('trustedSource acknowledgement required; not a hostile-code sandbox');
  if (!backend || typeof backend.run !== 'function') throw new Error('backend.run required');
  for (const [key, value] of Object.entries({ maxAgents, concurrency, timeoutMs, agentTimeoutMs, maxOutputBytes }))
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`invalid ${key}`);
  if (maxAgents > 1000 || concurrency > 16) throw new Error('agent limits exceed supported maximum');
  const path = await realpath(scriptPath);
  const source = await readFile(path, 'utf8');
  if (resolved.named && source !== resolved.source) throw Error('named workflow source changed during resolution');
  const { meta, body } = compileSource(source, capabilities);
  const creatorUpdate = meta.name === 'skill-creator-review' && args?.mode === 'update';
  if (creatorUpdate && host.updateContract === undefined)
    throw new Error('skill-creator update requires an enforced updateContract');
  if ((meta.name === 'skill-creator-review' && args?.mode !== 'update') && host.updateContract !== undefined)
    throw new Error('updateContract is only valid for skill-creator update mode');
  if (host.updateContract !== undefined && (!creatorUpdate || !enforcesUpdateBoundary(backend, host.updateContract)))
    throw new Error('updateContract requires the Codex SDK staging-only backend configured with the same paths');
  let update = null;
  if (host.updateContract !== undefined) {
    const targetArg = args?.target?.skillPath;
    const targetDir = typeof targetArg === 'string' ? await realpath(targetArg) : null;
    const contractTarget = await realpath(host.updateContract.targetDir);
    if (targetDir !== contractTarget || targetDir !== host.updateContract.targetDir)
      throw new Error('updateContract.targetDir must match args.target.skillPath and remain canonical');
    const requestedStaging = args.stagingDir ?? `${targetArg.replace(/\/+$/, '')}-workspace/staging`;
    if (typeof requestedStaging !== 'string' || resolve(requestedStaging) !== resolve(host.updateContract.stagingDir))
      throw new Error('updateContract.stagingDir must match args.stagingDir or its documented default');
    if (host.updateContract.targetRoot !== undefined && await realpath(host.updateContract.targetRoot) !== host.updateContract.targetRoot)
      throw new Error('updateContract.targetRoot must remain canonical');
    if (host.updateContract.stagingRoot !== undefined && await realpath(host.updateContract.stagingRoot) !== host.updateContract.stagingRoot)
      throw new Error('updateContract.stagingRoot must remain canonical');
    update = await prepareUpdateContract(host.updateContract);
    args.stagingDir = update.stagingDir;
  }
  const backendPolicy = await backend.prepare?.();
  await validateNamedWorkspace(resolved, args, backendPolicy);
  let encodedArgs;
  try { encodedArgs = JSON.stringify(args); }
  catch { throw new Error('args must be JSON serializable'); }
  if (encodedArgs === undefined) throw new Error('args must be JSON serializable');
  if (!runDir) throw new Error('new runDir required');
  // Exclusive directory: no overwrite, implicit resume, or replay of side effects.
  await mkdir(runDir, { mode: 0o700 });
  const workspace = typeof backendPolicy?.cwd === 'string'
    ? await createRunWorkspace({ projectRoot: backendPolicy.cwd, workflowName: meta.name, runDir })
    : null;
  await writeFile(join(runDir, 'source.txt'), source, { mode: 0o600 });
  await writeFile(join(runDir, 'request.json'), JSON.stringify({ scriptPath: path, args: JSON.parse(encodedArgs),
    ...(resolved.named ? { namedWorkflow: resolved.identity } : {}),
    sourceHash: hash(source), argsHash: hash(encodedArgs), meta, requirements: host.requirements ?? [], backendPolicy,
    workspace,
    ...(update === null ? {} : { updateContract: { targetRoot: update.targetRoot, stagingRoot: update.stagingRoot,
      targetDir: update.targetDir, stagingDir: update.stagingDir,
      sourceManifest: update.sourceManifest } }),
    limits: { maxAgents, concurrency, timeoutMs, agentTimeoutMs, maxOutputBytes } }, null, 2), { mode: 0o600 });
  let journal = Promise.resolve();
  let sequence = 0;
  const record = event => {
    journal = journal.then(() => appendFile(join(runDir, 'events.jsonl'),
      JSON.stringify({ sequence: ++sequence, time: new Date().toISOString(), ...event }) + '\n', { mode: 0o600 }));
    // Avoid unhandled rejection; finalization still awaits the original chain.
    journal.catch(() => {});
  };
  if (workspace) record({ type: 'workspace.created', path: workspace.path });
  const ajv = new Ajv({ strict: true, allErrors: true });
  const worker = fork(new URL('./worker.mjs', import.meta.url), [], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'], execArgv: ['--max-old-space-size=128'],
    env: { PATH: process.env.PATH },
  });
  const abort = new AbortController();
  const queue = [];
  const inflight = new Set();
  const observedAgentLabels = new Set();
  let calls = 0, active = 0, settled = false, outputBytes = 0;
  const deadlineAt = performance.now() + timeoutMs;
  record({ type: 'run.started' });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('workflow deadline exceeded')), timeoutMs);
    async function finish(error, result) {
      result = namedResult(result, resolved.named);
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      abort.abort();
      worker.kill('SIGKILL');
      if (update !== null) {
        try {
          // This runs for source errors too. A failed source must not conceal a direct
          // mutation of the caller-owned tree behind an otherwise useful error message.
          await verifyUpdateTarget(update);
          if (!error) {
            const actionPackage = await finalizeUpdateContract(update, result, observedAgentLabels);
            if (actionPackage !== null) {
              const packageText = JSON.stringify(actionPackage, null, 2);
              const packagePath = join(runDir, 'update-action-package.json');
              await writeFile(packagePath, packageText, { mode: 0o600 });
              result = Object.freeze({ source_result: result, action_package: actionPackage,
                action_package_path: packagePath, action_package_sha256: hash(packageText) });
            } else {
              result = Object.freeze({ source_result: result, action_package: null,
                action_package_path: null, action_package_sha256: null });
            }
          }
        } catch (contractError) {
          error = error ?? contractError;
        }
      }
      record({ type: error ? 'run.failed' : 'run.completed', error: error?.message, result,
        inFlight: [...inflight], calls });
      try { await journal; } catch (e) { error = e; }
      if (error) reject(error); else resolve(result);
    }
    function pump() {
      while (!settled && active < concurrency && queue.length) {
        const task = queue.shift();
        active++; inflight.add(task.id);
        if (update !== null && typeof task.options.label === 'string') observedAgentLabels.add(task.options.label);
        record({ type: 'agent.started', id: task.id, promptHash: hash(task.prompt), options: task.options });
        runAgent({ backend, task, signal: abort.signal, remainingMs: deadlineAt - performance.now(),
          timeoutMs: agentTimeoutMs,
          emit: event => { if (!settled) record({ type: 'agent.event', id: task.id, event }); },
        }).then(({ result, timedOut, timeoutMs: effectiveTimeoutMs }) => {
          if (settled) return;
          if (timedOut) {
            record({ type: 'agent.timeout', id: task.id, timeoutMs: effectiveTimeoutMs });
            worker.send({ type: 'reply', id: task.id, result: null });
            return;
          }
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
        exactObject(options, agentOptionKeys, 'agent option');
        validateEffort(options.effort);
        if (options.isolation !== undefined && (options.isolation !== 'worktree' || !capabilities.includes('worktree')))
          throw new Error('unsupported agent option: isolation');
        for (const key of ['model', 'label', 'phase'])
          if (options[key] !== undefined && typeof options[key] !== 'string') throw new Error(`invalid ${key}`);
        const validate = options.schema === undefined ? null : ajv.compile(options.schema);
        backend.validate?.(options);
        queue.push({ ...message, validate }); pump();
      } catch (error) { finish(error); }
    });
    worker.send({ type: 'start', args: JSON.parse(encodedArgs), meta, body, workspace });
  });
}
