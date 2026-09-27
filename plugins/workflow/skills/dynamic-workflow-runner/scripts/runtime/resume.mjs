// Explicit quiescent-boundary protocol. Legacy journals are never executable.
import { fork } from 'node:child_process';
import { constants, promises as fsPromises } from 'node:fs';
import { lstat, readFile, realpath, mkdir, rm, stat } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import Ajv from 'ajv';
import { compileSource } from './source.mjs';
import { exactObject, validateRequirements } from './inputs.mjs';
import { rejectUpdateWorkflow } from './update-guard.mjs';
import { runAgent } from './agent-run.mjs';
import { createRunWorkspace, reuseRunWorkspace, snapshotRunWorkspace } from './run-workspace.mjs';

const PROTOCOL = 'quiescent-checkpoint-v1';
const hash = value => createHash('sha256').update(value).digest('hex');
const json = value => JSON.stringify(value);
const same = (a, b) => json(a) === json(b);
export const maxEvidenceBytes = 32 * 1024 * 1024;
const evidenceReadChunkBytes = 64 * 1024;

function sameEvidenceFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode &&
    left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

async function syncDirectory(path) {
  const file = await fsPromises.open(path, 'r');
  try { await file.sync(); } finally { await file.close(); }
}
async function durableFile(path, content) {
  const file = await fsPromises.open(path, 'wx', 0o600);
  try { await file.writeFile(content); await file.sync(); } finally { await file.close(); }
}
async function filesSnapshot(paths) {
  return Promise.all(paths.map(async path => {
    const resolved = await realpath(path);
    const info = await stat(resolved);
    if (!info.isFile()) throw Error(`checkpoint dependency is not a file: ${path}`);
    return { path, resolved, hash: hash(await readFile(resolved)) };
  }));
}
async function implementationHash() {
  // Bind runtime/worker, backend policy implementation and pinned dependencies.
  const names = ['runtime.mjs', 'resume.mjs', 'agent-run.mjs', 'worker.mjs', 'source.mjs', 'inputs.mjs',
    'codex.mjs', 'models.mjs', 'contexts.mjs', 'environment.mjs', 'workspaces.mjs', 'run-workspace.mjs', 'package-lock.json'];
  return hash(json(await Promise.all(names.map(async name =>
    [name, hash(await readFile(new URL(name, import.meta.url)))]))));
}
async function readEvidence(root, name) {
  const path = join(root, name);
  if (await realpath(path) !== path) throw Error('checkpoint evidence symlinks are not supported');
  const info = await lstat(path);
  if (!info.isFile() || info.size > maxEvidenceBytes) throw Error('invalid checkpoint evidence file');
  if (typeof constants.O_NOFOLLOW !== 'number' || typeof constants.O_NONBLOCK !== 'number')
    throw Error('safe checkpoint evidence reads require O_NOFOLLOW and O_NONBLOCK support');
  const file = await fsPromises.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await file.stat();
    if (!opened.isFile() || !sameEvidenceFile(info, opened)) throw Error('checkpoint evidence changed before read');
    const content = Buffer.alloc(info.size);
    let bytesRead = 0;
    while (bytesRead < info.size) {
      const length = Math.min(evidenceReadChunkBytes, info.size - bytesRead);
      const result = await file.read(content, bytesRead, length, bytesRead);
      if (!result.bytesRead) throw Error('checkpoint evidence changed while reading (short read)');
      bytesRead += result.bytesRead;
    }
    const [current, pathInfo] = await Promise.all([file.stat(), lstat(path)]);
    if (!current.isFile() || !pathInfo.isFile() || pathInfo.isSymbolicLink() ||
        !sameEvidenceFile(opened, current) || !sameEvidenceFile(opened, pathInfo))
      throw Error('checkpoint evidence changed while reading');
    return content.toString('utf8');
  } finally { await file.close(); }
}

function validateHistory(request, events, seal) {
  if (request.protocol !== PROTOCOL || seal.protocol !== PROTOCOL) throw Error('unsupported checkpoint protocol');
  let digest = '', sequence = 0, calls = 0;
  const accepted = new Map(), completed = new Map(), dispatched = new Set(), released = new Set();
  const ajv = new Ajv({ strict: true, allErrors: true });
  for (const event of events) {
    const { digest: supplied, ...payload } = event;
    if (event.sequence !== ++sequence || event.previous !== digest || hash(json(payload)) !== supplied)
      throw Error('checkpoint journal integrity mismatch');
    digest = supplied;
    if (event.type === 'agent.accepted') {
      if (accepted.has(event.id) || typeof event.prompt !== 'string') throw Error('invalid checkpoint admission');
      accepted.set(event.id, event); calls++;
    } else if (event.type === 'agent.started') {
      if (!accepted.has(event.id) || dispatched.has(event.id)) throw Error('invalid checkpoint dispatch');
      dispatched.add(event.id);
    } else if (event.type === 'agent.completed') {
      if (!dispatched.has(event.id) || completed.has(event.id) || event.result === null || event.result === undefined)
        throw Error('unresolved checkpoint result');
      const schema = accepted.get(event.id).options.schema;
      if (schema !== undefined && !ajv.validate(schema, event.result)) throw Error('invalid checkpoint result schema');
      completed.set(event.id, event.result);
    } else if (event.type === 'reply.released') {
      if (!completed.has(event.id) || released.has(event.id)) throw Error('invalid checkpoint reply order');
      released.add(event.id);
    } else if (event.type === 'checkpoint.passed' || event.type === 'checkpoint.stopped') {
      if (accepted.size !== released.size || event.calls !== calls) throw Error('checkpoint is not quiescent');
    } else if (!['run.started', 'workspace.created', 'agent.event', 'phase', 'log'].includes(event.type)) {
      throw Error(`unresolved checkpoint event: ${event.type}`);
    }
  }
  const boundary = events.at(-1);
  if (!boundary || boundary.type !== 'checkpoint.stopped' || boundary.digest !== seal.journalDigest ||
      calls !== boundary.calls || accepted.size !== released.size || !same(boundary.files, seal.files) ||
      !Array.isArray(boundary.workspace) || !same(boundary.workspace, seal.workspace))
    throw Error('no sealed quiescent checkpoint');
  if (calls > request.limits.maxAgents || !Number.isSafeInteger(boundary.outputBytes) || boundary.outputBytes < 0 ||
      boundary.outputBytes > request.limits.maxOutputBytes || !Number.isSafeInteger(boundary.remainingMs) ||
      boundary.remainingMs <= 0 || boundary.remainingMs > request.limits.timeoutMs)
    throw Error('invalid checkpoint budget');
  return { boundary, completed };
}

export async function resumableWorkflow(request, host) {
  rejectUpdateWorkflow(request, host);
  if (host.trustedSource !== true) throw Error('trustedSource acknowledgement required');
  const { backend, runDir } = host;
  if (!backend || typeof backend.run !== 'function') throw Error('backend.run required');
  if (!runDir || !isAbsolute(runDir)) throw Error('absolute new runDir required');
  const policy = exactObject(host.checkpoint, ['files', 'dependenciesComplete', 'backendIdentity', 'stopAfter'], 'checkpoint');
  if (policy.dependenciesComplete !== true || !Array.isArray(policy.files) ||
      policy.files.some(p => typeof p !== 'string' || !isAbsolute(p)) || new Set(policy.files).size !== policy.files.length)
    throw Error('checkpoint requires complete explicit absolute dependency files');
  if (policy.stopAfter !== undefined && (typeof policy.stopAfter !== 'string' || !policy.stopAfter))
    throw Error('invalid checkpoint stopAfter');
  const backendIdentity = backend.resumeIdentity ?? policy.backendIdentity;
  if (!backendIdentity || (typeof backendIdentity !== 'string' && typeof backendIdentity !== 'object'))
    throw Error('checkpoint backend identity required');
  const limits = { maxAgents: host.maxAgents ?? 2, concurrency: host.concurrency ?? 2,
    timeoutMs: host.timeoutMs ?? 60000,
    agentTimeoutMs: host.agentTimeoutMs ?? (host.timeoutMs ?? 60000),
    maxOutputBytes: host.maxOutputBytes ?? 1000000 };
  for (const [key, value] of Object.entries(limits))
    if (!Number.isSafeInteger(value) || value < 1) throw Error(`invalid ${key}`);
  if (limits.maxAgents > 1000 || limits.concurrency > 16) throw Error('agent limits exceed supported maximum');
  const capabilities = [...(backend.capabilities ?? ['read-only', 'fresh-thread'])];
  validateRequirements(host.requirements, capabilities);
  const path = await realpath(request.scriptPath);
  const source = await readFile(path, 'utf8');
  const argsText = json(request.args ?? {});
  if (argsText === undefined) throw Error('args must be JSON serializable');
  const { meta, body } = compileSource(source, capabilities);
  rejectUpdateWorkflow(request, host, meta.requirements);
  const backendPolicy = await backend.prepare?.() ?? null;
  backend.validateCheckpointPolicy?.();
  const identity = { protocol: PROTOCOL, implementationHash: await implementationHash(), sourceHash: hash(source),
    argsHash: hash(argsText), sourceWorkerEnvironment: { PATH: process.env.PATH, node: process.version },
    capabilities, requirements: host.requirements ?? [], backendIdentity, backendPolicy,
    limits, dependencyPaths: policy.files };
  let previous, workspace = null, lease, leaseAcquired = false, claimed = false;
  try {
    if (host.resume !== undefined) {
      exactObject(host.resume, ['previousRun', 'freshness'], 'resume');
      if (host.resume.freshness !== 'verified' || typeof host.resume.previousRun !== 'string')
        throw Error('resume requires previousRun and explicit freshness: verified');
      const root = await realpath(host.resume.previousRun);
      lease = join(root, 'continuation.lock');
      await mkdir(lease, { mode: 0o700 });
      leaseAcquired = true;
      const [requestText, eventsText, sealText, savedSource] = await Promise.all(
        ['request.json', 'events.jsonl', 'checkpoint.json', 'source.txt'].map(name => readEvidence(root, name)));
      const old = JSON.parse(requestText), seal = JSON.parse(sealText);
      if (!eventsText.endsWith('\n')) throw Error('torn checkpoint journal');
      if (typeof backendPolicy?.cwd === 'string') workspace = await reuseRunWorkspace({
        projectRoot: backendPolicy.cwd, workflowName: meta.name, workspace: old.identity?.workspace, runDir });
      identity.workspace = workspace;
      if (seal.requestHash !== hash(requestText) || seal.sourceHash !== hash(savedSource) || savedSource !== source ||
          !same(old.identity, identity)) throw Error('checkpoint execution identity mismatch');
      const events = eventsText.trimEnd().split('\n').map(JSON.parse);
      const checked = validateHistory(old, events, seal);
      if (!same(await filesSnapshot(policy.files), seal.files)) throw Error('checkpoint dependency/artifact drift');
      if (!same(await snapshotRunWorkspace(workspace?.path), seal.workspace)) throw Error('checkpoint workspace drift');
      previous = { root, events, ...checked, digest: hash(requestText + eventsText + sealText) };
    }
    const initialFiles = await filesSnapshot(policy.files);
    await mkdir(runDir, { mode: 0o700 });
    if (!host.resume && typeof backendPolicy?.cwd === 'string') {
      workspace = await createRunWorkspace({ projectRoot: backendPolicy.cwd, workflowName: meta.name, runDir });
      identity.workspace = workspace;
    } else if (!host.resume) identity.workspace = null;
    // A predecessor is permanently consumed once a new run owns continuation.
    // Failures after this point require reconciliation, not lease deletion/retry.
    if (lease) {
      claimed = true;
      await durableFile(join(lease, 'owner.json'), json({ runDir, predecessorDigest: previous.digest }));
      await syncDirectory(lease);
      await syncDirectory(previous.root);
    }
    await durableFile(join(runDir, 'source.txt'), source);
    const requestText = json({ protocol: PROTOCOL, identity, scriptPath: path, args: JSON.parse(argsText),
      meta, limits, initialFiles, predecessor: previous ? { runDir: previous.root, digest: previous.digest } : null });
    await durableFile(join(runDir, 'request.json'), requestText);
    const journal = await fsPromises.open(join(runDir, 'events.jsonl'), 'wx', 0o600);
    await syncDirectory(runDir);
    try { return await execute({ backend, runDir, policy, limits, meta, body, argsText, source,
      requestText, previous, journal, capabilities, workspace }); }
    finally { await journal.close(); }
  } finally {
    if (leaseAcquired && !claimed) await rm(lease, { recursive: true, force: true });
  }
}

async function execute({ backend, runDir, policy, limits, meta, body, argsText, source,
  requestText, previous, journal, capabilities, workspace }) {
  let sequence = 0, digest = '', io = Promise.resolve(), poisoned;
  const record = event => {
    const next = io.then(async () => {
      const payload = { sequence: ++sequence, previous: digest, ...event };
      digest = hash(json(payload));
      await journal.writeFile(json({ ...payload, digest }) + '\n');
      await journal.sync();
    });
    io = next;
    next.catch(error => { poisoned = error; });
    return next;
  };
  if (previous) {
    for (const event of previous.events) {
      const { sequence: _, previous: __, digest: ___, ...payload } = event;
      // Earlier stops become passed boundaries in the successor transcript.
      if (payload.type === 'checkpoint.stopped') payload.type = 'checkpoint.passed';
      await record(payload);
    }
  } else {
    await record({ type: 'run.started' });
    if (workspace) await record({ type: 'workspace.created', path: workspace.path });
  }
  const transcript = previous?.events.filter(e => ['agent.accepted', 'reply.released',
    'checkpoint.passed', 'checkpoint.stopped', 'phase', 'log'].includes(e.type)) ?? [];
  let cursor = 0, replaying = Boolean(previous);
  const replayPending = new Set();
  const ajv = new Ajv({ strict: true, allErrors: true });
  const queue = [], active = new Set();
  let calls = previous?.boundary.calls ?? 0, outputBytes = previous?.boundary.outputBytes ?? 0;
  let tainted = false, settled = false, admission = Promise.resolve();
  const availableMs = previous?.boundary.remainingMs ?? limits.timeoutMs;
  const start = performance.now();
  const abort = new AbortController();
  const worker = fork(new URL('./worker.mjs', import.meta.url), [], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'], execArgv: ['--max-old-space-size=128'], env: { PATH: process.env.PATH },
  });
  worker.stderr.on('data', () => {});
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(Error('workflow deadline exceeded')), availableMs);
    async function finish(error, result, stopped = false) {
      if (settled) return;
      settled = true; clearTimeout(timer); abort.abort(); worker.kill('SIGKILL');
      try {
        if (!stopped) await record({ type: error ? 'run.failed' : 'run.completed', error: error?.message,
          result, inFlight: [...active], queued: queue.map(t => t.id), calls });
        await io;
      } catch (failure) { error = failure; }
      if (error) reject(error); else resolve(result);
    }
    function send(id, result) {
      if (!settled && !poisoned) worker.send({ type: 'reply', id, result }, error => { if (error) finish(error); });
    }
    function debit(value) {
      const text = json(value);
      if (text === undefined) throw Error('backend returned undefined');
      outputBytes += Buffer.byteLength(text);
      if (outputBytes > limits.maxOutputBytes) throw Error('output byte limit exceeded');
    }
    function releaseReplay() {
      while (transcript[cursor]?.type === 'reply.released') {
        const event = transcript[cursor++];
        if (!replayPending.delete(event.id)) throw Error('historical reply before admission');
        send(event.id, structuredClone(previous.completed.get(event.id)));
      }
    }
    function pump() {
      while (!settled && !poisoned && !replaying && active.size < limits.concurrency && queue.length) {
        const task = queue.shift(); active.add(task.id);
        (async () => {
          await record({ type: 'agent.started', id: task.id, promptHash: hash(task.prompt), options: task.options });
          if (settled || poisoned) return;
          let result;
          try {
            const outcome = await runAgent({ backend, task, signal: abort.signal,
              remainingMs: availableMs - (performance.now() - start), timeoutMs: limits.agentTimeoutMs,
              emit: event => { if (!settled && active.has(task.id)) record({ type: 'agent.event', id: task.id, event }).catch(finish); } });
            if (outcome.timedOut) {
              await record({ type: 'agent.timeout', id: task.id, timeoutMs: outcome.timeoutMs });
              result = null;
            } else result = outcome.result;
          } catch (error) {
            if (settled) return;
            tainted = true;
            if (error.fatal) throw error;
            await record({ type: 'agent.failed', id: task.id, error: error.message });
            result = null;
          }
          if (settled) return;
          if (result === null || (task.validate && !task.validate(result))) {
            tainted = true; result = null;
          }
          debit(result);
          await record({ type: 'agent.completed', id: task.id, result });
          await record({ type: 'reply.released', id: task.id });
          active.delete(task.id);
          send(task.id, result); pump();
        })().catch(finish);
      }
    }
    function validateAgent(message) {
      const { prompt, options } = message;
      if (typeof prompt !== 'string' || !prompt || !options || typeof options !== 'object' || Array.isArray(options))
        throw Error('invalid agent arguments');
      if (Buffer.byteLength(prompt) > limits.maxOutputBytes) throw Error('prompt byte limit exceeded');
      exactObject(options, ['model', 'label', 'phase', 'schema', 'isolation'], 'agent option');
      if (options.isolation !== undefined && (options.isolation !== 'worktree' || !capabilities.includes('worktree')))
        throw Error('unsupported agent option: isolation');
      for (const key of ['model', 'label', 'phase'])
        if (options[key] !== undefined && typeof options[key] !== 'string') throw Error(`invalid ${key}`);
      backend.validate?.(options); backend.validateCheckpoint?.(options);
      return options.schema === undefined ? null : ajv.compile(options.schema);
    }
    async function receive(message) {
      if (settled) return;
      if (poisoned) throw poisoned;
      if (message.type === 'error') throw Error(message.error);
      if (replaying) {
        const expected = transcript[cursor];
        if (message.type === 'agent') {
          validateAgent(message);
          if (expected?.type !== 'agent.accepted' || expected.id !== message.id ||
              expected.prompt !== message.prompt || !same(expected.options, message.options))
            throw Error('historical prompt/options/order mismatch');
          replayPending.add(message.id); cursor++; releaseReplay(); return;
        }
        if (message.type === 'checkpoint') {
          if (!['checkpoint.passed', 'checkpoint.stopped'].includes(expected?.type) ||
              expected.id !== message.id || expected.label !== message.label || replayPending.size)
            throw Error('historical checkpoint mismatch');
          cursor++;
          if (expected.type === 'checkpoint.stopped') {
            if (cursor !== transcript.length) throw Error('historical transcript not fully consumed');
            // Recheck immediately before opening live admission.
            if (!same(await filesSnapshot(policy.files), previous.boundary.files)) throw Error('checkpoint dependency/artifact drift');
            if (!same(await snapshotRunWorkspace(workspace?.path), previous.boundary.workspace))
              throw Error('checkpoint workspace drift');
            replaying = false;
          }
          send(message.id, null); releaseReplay(); return;
        }
        if (['phase', 'log'].includes(message.type) && expected?.type === message.type && same(expected.value, message.value)) {
          cursor++; releaseReplay(); return;
        }
        throw Error('historical transcript not fully consumed or control-flow mismatch');
      }
      if (message.type === 'agent') {
        const validate = validateAgent(message);
        if (++calls > limits.maxAgents) throw Error('agent call budget exceeded');
        await record({ type: 'agent.accepted', id: message.id, prompt: message.prompt, options: message.options });
        if (settled) return;
        queue.push({ ...message, validate }); pump(); return;
      }
      if (message.type === 'checkpoint') {
        if (active.size || queue.length || tainted) throw Error('checkpoint requires quiescent successful outcomes');
        const stopped = policy.stopAfter === message.label;
        const files = await filesSnapshot(policy.files);
        const workspaceFiles = await snapshotRunWorkspace(workspace?.path);
        const remainingMs = Math.floor(availableMs - (performance.now() - start));
        if (remainingMs <= 0) throw Error('workflow deadline exceeded');
        await record({ type: stopped ? 'checkpoint.stopped' : 'checkpoint.passed', id: message.id,
          label: message.label, calls, outputBytes, remainingMs, files, workspace: workspaceFiles });
        if (settled) return;
        if (stopped) {
          await durableFile(join(runDir, 'checkpoint.json'), json({ protocol: PROTOCOL, journalDigest: digest,
            requestHash: hash(requestText), sourceHash: hash(source), files, workspace: workspaceFiles }));
          await syncDirectory(runDir);
          if (settled) return;
          return finish(null, { status: 'checkpoint', runDir, label: message.label, calls, remainingMs }, true);
        }
        send(message.id, null); return;
      }
      if (['phase', 'log'].includes(message.type)) { debit(message); await record(message); return; }
      if (message.type === 'result') {
        if (active.size || queue.length) throw Error('unawaited agent calls at workflow return');
        debit(message.result); return finish(null, message.result);
      }
      throw Error('unknown worker message');
    }
    worker.on('error', finish);
    worker.on('exit', (code, signal) => { if (!settled) finish(Error(`worker exited: ${code}/${signal}`)); });
    worker.on('message', message => {
      admission = admission.then(() => receive(message)); admission.catch(finish);
    });
    worker.send({ type: 'start', args: JSON.parse(argsText), meta, body, checkpoints: true, workspace });
  });
}
