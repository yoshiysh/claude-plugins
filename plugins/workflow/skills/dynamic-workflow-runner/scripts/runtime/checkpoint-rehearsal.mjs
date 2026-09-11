import { readFile, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Workflow } from './runtime.mjs';
import { auditCheckpoint } from './checkpoint-audit.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');

// Trusted control-flow rehearsal only. No SDK/backend injection is accepted and
// the first unknown call is fatal. Never use this result as a resume permit.
export async function rehearseCheckpoint({ previousRun, runDir, trustedSource = false }) {
  if (trustedSource !== true) throw Error('trustedSource acknowledgement required');
  const root = await realpath(previousRun);
  const read = async name => {
    const path = await realpath(join(root, name));
    if (!path.startsWith(`${root}/`)) throw Error('evidence link outside run');
    const info = await stat(path);
    if (!info.isFile() || info.size > 32 * 1024 * 1024) throw Error('invalid evidence file');
    return readFile(path, 'utf8');
  };
  const [source, requestText, eventsText] = await Promise.all(['source.txt','request.json','events.jsonl'].map(read));
  const audit = auditCheckpoint({ source, requestText, eventsText });
  const request = JSON.parse(requestText);
  const events = eventsText.trimEnd().split('\n').map(JSON.parse);
  const starts = events.filter(e => e.type === 'agent.started');
  const completions = events.filter(e => e.type === 'agent.completed' && e.result !== null);
  const completeById = new Map(completions.map(e => [e.id,e]));
  const waiting = new Map(); let nextStart = 0, nextCompletion = 0, frontier;
  const boundary = Error('checkpoint rehearsal boundary'); boundary.fatal = true;
  function release() {
    while (nextCompletion < completions.length) {
      const event = completions[nextCompletion];
      const resolve = waiting.get(event.id);
      if (!resolve) return;
      waiting.delete(event.id); nextCompletion++;
      resolve(structuredClone(event.result));
    }
  }
  const backend = {
    capabilities: [...new Set(['read-only','fresh-thread', ...(request.requirements ?? [])])],
    async run(prompt, options) {
      const historical = starts[nextStart++];
      if (historical && (hash(prompt) !== historical.promptHash || JSON.stringify(options) !== JSON.stringify(historical.options))) {
        const error = Error('historical prompt/options mismatch'); error.fatal = true; throw error;
      }
      if (!historical || !completeById.has(historical.id)) {
        frontier ??= { id: historical?.id ?? null, label: options.label ?? null,
          reason: historical ? 'historical-outcome-unresolved' : 'new-call' };
        throw boundary;
      }
      return new Promise(resolve => { waiting.set(historical.id, resolve); release(); });
    },
  };
  let status;
  try {
    // Execute the saved source, not the possibly modified original path.
    await Workflow({ scriptPath: join(root,'source.txt'), args: request.args }, {
      backend, runDir, trustedSource: true, requirements: request.requirements,
      maxAgents: Math.min(1000, starts.length + 1), concurrency: request.limits.concurrency,
      timeoutMs: 10000, maxOutputBytes: request.limits.maxOutputBytes,
    });
    status = 'historical-return';
  } catch (error) {
    if (error !== boundary) throw error;
    status = 'stopped-at-frontier';
  }
  if (nextCompletion !== completions.length) throw Error('historical transcript not fully consumed');
  return { status, executable: false, evidenceHash: audit.evidenceHash,
    historicalResultsReplayed: nextCompletion, modelCalls: 0, frontier: frontier ?? null,
    warning: 'Control-flow rehearsal only; no reference freshness, external effect or safe continuation certification.' };
}
