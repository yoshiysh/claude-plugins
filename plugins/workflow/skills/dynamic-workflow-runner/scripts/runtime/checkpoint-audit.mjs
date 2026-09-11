import { readFile, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import Ajv from 'ajv';

const digest = value => createHash('sha256').update(value).digest('hex');
const requireThat = (ok, message) => { if (!ok) throw Error(`invalid checkpoint: ${message}`); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const known = new Set(['run.started', 'run.completed', 'run.failed', 'phase', 'log',
  'agent.started', 'agent.event', 'agent.completed', 'agent.failed', 'agent.invalid_output']);
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

// A legacy journal can provide evidence, but cannot authorize replay. In particular,
// its asynchronous start record is not a write-ahead side-effect boundary.
export function auditCheckpoint({ source, requestText, eventsText }) {
  requireThat(typeof source === 'string' && typeof requestText === 'string' && typeof eventsText === 'string', 'text inputs required');
  const request = JSON.parse(requestText);
  requireThat(object(request) && Object.hasOwn(request, 'args'), 'request shape');
  requireThat(request.sourceHash === digest(source), 'source hash mismatch');
  requireThat(request.argsHash === digest(JSON.stringify(request.args)), 'args hash mismatch');
  requireThat(eventsText.endsWith('\n'), 'truncated journal');
  const lines = eventsText.slice(0, -1).split('\n');
  requireThat(lines.length > 1 && lines.every(Boolean), 'empty journal entry');
  const events = lines.map(line => JSON.parse(line));
  const tasks = new Map();
  const ajv = new Ajv({ strict: true, allErrors: true });
  let terminal;
  for (const [index, event] of events.entries()) {
    requireThat(object(event) && event.sequence === index + 1 && known.has(event.type), 'sequence or event type');
    requireThat(!terminal, 'events after terminal');
    if (index === 0) requireThat(event.type === 'run.started', 'missing run start');
    else requireThat(event.type !== 'run.started', 'duplicate run start');
    if (event.type === 'run.failed' || event.type === 'run.completed') {
      requireThat(Array.isArray(event.inFlight) && event.inFlight.every(Number.isSafeInteger), 'terminal inFlight');
      const pending = [...tasks.values()].filter(t => !t.settled).map(t => t.id).sort((a,b) => a-b);
      requireThat(JSON.stringify([...event.inFlight].sort((a,b) => a-b)) === JSON.stringify(pending), 'inFlight does not match observed lifecycle');
      requireThat(Number.isSafeInteger(event.calls) && event.calls >= tasks.size && [...tasks.keys()].every(id => id <= event.calls), 'terminal call count');
      terminal = event;
      continue;
    }
    if (!event.type.startsWith('agent.')) continue;
    requireThat(Number.isSafeInteger(event.id) && event.id > 0, 'agent id');
    if (event.type === 'agent.started') {
      requireThat(!tasks.has(event.id) && object(event.options) && /^[a-f0-9]{64}$/.test(event.promptHash), 'duplicate or malformed start');
      tasks.set(event.id, { id: event.id, label: event.options.label ?? null,
        promptHash: event.promptHash, options: event.options, settled: false });
      continue;
    }
    const task = tasks.get(event.id);
    requireThat(task && !task.settled, 'event without active task');
    if (event.type === 'agent.completed') {
      requireThat(Object.hasOwn(event, 'result'), 'missing result');
      if (event.result !== null && task.options.schema !== undefined)
        requireThat(ajv.compile(task.options.schema)(event.result), 'result schema mismatch');
      task.settled = true;
      task.outcome = event.result === null ? 'null-result' : 'completed';
      task.resultHash = digest(JSON.stringify(event.result));
    } else if (event.type === 'agent.failed') {
      task.settled = true;
      task.outcome = 'failed';
    }
  }
  requireThat(terminal, 'missing terminal; run may still be active');
  const complete = [...tasks.values()].filter(t => t.outcome === 'completed');
  const uncertain = [...tasks.values()].filter(t => t.outcome !== 'completed');
  const candidates = complete.map(({ id, label, promptHash, options, resultHash }) => ({
    id, label, promptHash, optionsHash: digest(JSON.stringify(options)), resultHash,
  }));
  return freeze({ format: 'workflow-checkpoint-audit/v1', status: uncertain.length ? 'reconciliation-required' : 'legacy-evidence-only',
    executable: false, sourceHash: request.sourceHash, argsHash: request.argsHash,
    evidenceHash: digest(JSON.stringify([digest(source), digest(requestText), digest(eventsText)])),
    terminal: terminal.type, candidateResults: candidates,
    uncertainTasks: uncertain.map(t => ({ id: t.id, label: t.label, state: t.outcome ?? 'started-without-outcome' })),
    blockers: [
      ...(uncertain.length ? ['Started/failed/null-result tasks need outcome reconciliation; absence of a reply is not proof of no effects.'] : []),
      'Legacy journals do not durably record every accepted call and reply delivery before effects or source continuation.',
      'Source/args hashes do not bind referenced files, artifacts, live external evidence or the effective model policy.',
      'This audit is not a resume permit. Candidate results are historical evidence, not automatically reusable results.',
    ] });
}

export async function inspectCheckpoint(directory) {
  const root = await realpath(directory);
  const read = async name => {
    const path = await realpath(join(root, name));
    requireThat(path.startsWith(`${root}/`), 'evidence symlink leaves run directory');
    const info = await stat(path);
    requireThat(info.isFile() && info.size <= 32 * 1024 * 1024, 'evidence file type or size');
    return readFile(path, 'utf8');
  };
  const [source, requestText, eventsText] = await Promise.all(['source.txt', 'request.json', 'events.jsonl'].map(read));
  return auditCheckpoint({ source, requestText, eventsText });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 3) throw Error('usage: node checkpoint-audit.mjs RUN_DIRECTORY');
    console.log(JSON.stringify(await inspectCheckpoint(process.argv[2]), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
