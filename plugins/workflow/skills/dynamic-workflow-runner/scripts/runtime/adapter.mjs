import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Workflow as runWorkflow } from './runtime.mjs';
import { codexBackend } from './codex.mjs';
import { exactObject, backendKeys, limitKeys, requestKeys } from './inputs.mjs';

// Common execution policy, not inference from a caller name, label or prompt.
// Keep dependency catalogs available; source owns explicit task knowledge.
export function workflowContext() {
  return { profiles: { workflow: { memory: 'off', apps: 'inherit', plugins: 'inherit', references: [] } },
    assignments: {}, defaultProfile: 'workflow' };
}

const hostKeys = [...backendKeys, 'trustedSource', 'requirements', ...limitKeys];
function snapshot(host, directoryKey) {
  exactObject(host, [...hostKeys, directoryKey], 'adapter host');
  if (host.trustedSource !== true) throw Error('trustedSource acknowledgement required');
  if (typeof host[directoryKey] !== 'string' || !isAbsolute(host[directoryKey]))
    throw Error(`absolute ${directoryKey} required`);
  const { CodexClass, ...data } = host;
  return { ...structuredClone(data), ...(CodexClass === undefined ? {} : { CodexClass }) };
}

// Shared by the one-shot CLI and the bound Workflow function.
export function executeWorkflow(request, host) {
  exactObject(request, requestKeys, 'Workflow request');
  const ownedRequest = structuredClone(request);
  const owned = snapshot(host, 'runDir');
  const backendConfig = Object.fromEntries(backendKeys.filter(k => Object.hasOwn(owned, k)).map(k => [k, owned[k]]));
  backendConfig.context ??= workflowContext();
  // Null is invalid configuration, never an instruction to silently use defaults.
  if (owned.context === null) throw Error('context must be an object');
  const limits = Object.fromEntries(limitKeys.filter(k => Object.hasOwn(owned, k)).map(k => [k, owned[k]]));
  return runWorkflow(ownedRequest, { ...limits, backend: codexBackend(backendConfig),
    trustedSource: true, runDir: owned.runDir, requirements: owned.requirements });
}

// Configure the host once. Each call keeps the standard {scriptPath,args} shape,
// returns the source result unchanged, and receives an independent run/backend.
export function createWorkflow(host) {
  const { runRoot, ...owned } = snapshot(host, 'runRoot');
  return async function Workflow(request) {
    exactObject(request, requestKeys, 'Workflow request');
    const call = structuredClone(request);
    const root = await realpath(runRoot);
    if (!(await stat(root)).isDirectory()) throw Error('runRoot must be a directory');
    return executeWorkflow(call, { ...owned, runDir: join(root, randomUUID()) });
  };
}
