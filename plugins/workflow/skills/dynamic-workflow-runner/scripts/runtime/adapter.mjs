import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Workflow as runWorkflow } from './runtime.mjs';
import { codexBackend } from './codex.mjs';
import { exactObject, backendKeys, limitKeys, requestKeys } from './inputs.mjs';
import { namedHostKeys } from './named.mjs';

// Common execution policy, not inference from a caller name, label or prompt.
// Keep dependency catalogs available; source owns explicit task knowledge.
export function workflowContext() {
  return { profiles: { workflow: { memory: 'off', apps: 'inherit', plugins: 'inherit', references: [] } },
    assignments: {}, defaultProfile: 'workflow' };
}

const hostKeys = [...new Set([...backendKeys.filter(key => key !== 'updateContract'), 'trustedSource', 'requirements', 'updatePolicy', 'checkpoint', 'resume', ...namedHostKeys, ...limitKeys])];
const updatePolicyKeys = ['targetRoot', 'stagingRoot'];
const inside = (root, path) => {
  const rel = relative(root, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

function validateUpdatePolicy(policy) {
  if (policy === undefined) return undefined;
  exactObject(policy, updatePolicyKeys, 'updatePolicy');
  for (const key of updatePolicyKeys) {
    if (typeof policy[key] !== 'string' || !isAbsolute(policy[key]))
      throw Error(`updatePolicy.${key} must be an absolute path`);
  }
  return structuredClone(policy);
}

function snapshot(host, directoryKey) {
  exactObject(host, [...hostKeys, directoryKey], 'adapter host');
  if (host.trustedSource !== true) throw Error('trustedSource acknowledgement required');
  if (typeof host[directoryKey] !== 'string' || !isAbsolute(host[directoryKey]))
    throw Error(`absolute ${directoryKey} required`);
  const { CodexClass, ...data } = host;
  const owned = structuredClone(data);
  if (Object.hasOwn(owned, 'updatePolicy')) owned.updatePolicy = validateUpdatePolicy(owned.updatePolicy);
  return { ...owned, ...(CodexClass === undefined ? {} : { CodexClass }) };
}

async function bindUpdatePolicy(request, policy) {
  if (!policy) throw Error('skill-creator update requires an explicit host updatePolicy');
  if (request.args?.stagingDir !== undefined)
    throw Error('args.stagingDir is selected by host updatePolicy and cannot override it');

  const targetArg = request.args?.target?.skillPath;
  if (typeof targetArg !== 'string' || !isAbsolute(targetArg))
    throw Error('args.target.skillPath must be an absolute path for a host-policy update');
  const [targetRoot, stagingRoot, targetDir] = await Promise.all([
    realpath(policy.targetRoot), realpath(policy.stagingRoot), realpath(targetArg),
  ]);
  for (const [path, name] of [[targetRoot, 'updatePolicy.targetRoot'], [stagingRoot, 'updatePolicy.stagingRoot'], [targetDir, 'args.target.skillPath']]) {
    if (!(await stat(path)).isDirectory()) throw Error(`${name} must be a directory`);
  }
  if (!inside(targetRoot, targetDir) || targetRoot === targetDir)
    throw Error('args.target.skillPath is outside updatePolicy.targetRoot');
  if (inside(targetRoot, stagingRoot) || inside(stagingRoot, targetRoot))
    throw Error('updatePolicy targetRoot and stagingRoot must be separate');

  const stagingDir = join(stagingRoot, `update-${randomUUID()}`);
  const args = { ...request.args,
    target: { ...request.args.target, skillPath: targetDir },
    stagingDir,
  };
  return { request: { ...request, args }, updateContract: { targetRoot, stagingRoot, targetDir, stagingDir } };
}

function executeBoundWorkflow(request, host, updateContract) {
  exactObject(request, requestKeys, 'Workflow request');
  const ownedRequest = structuredClone(request);
  const owned = snapshot(host, 'runDir');
  if (owned.updatePolicy !== undefined || owned.updateContract !== undefined)
    throw Error('update authorization is available only through createWorkflow updatePolicy');
  const updateMode = ownedRequest.args?.mode === 'update';
  if (updateMode !== (updateContract !== undefined))
    throw Error('skill-creator update requires a createWorkflow host updatePolicy');
  const backendConfig = Object.fromEntries(backendKeys.filter(k => Object.hasOwn(owned, k)).map(k => [k, owned[k]]));
  if (updateContract !== undefined) backendConfig.updateContract = updateContract;
  backendConfig.context ??= workflowContext();
  // Null is invalid configuration, never an instruction to silently use defaults.
  if (owned.context === null) throw Error('context must be an object');
  const limits = Object.fromEntries(limitKeys.filter(k => Object.hasOwn(owned, k)).map(k => [k, owned[k]]));
  return runWorkflow(ownedRequest, { ...limits, backend: codexBackend(backendConfig),
    trustedSource: true, runDir: owned.runDir, requirements: owned.requirements,
    updateContract,
    checkpoint: owned.checkpoint, resume: owned.resume,
    trustedPluginRoots: owned.trustedPluginRoots, allowedWorkflowNames: owned.allowedWorkflowNames });
}

// The one-shot entry remains read-only; only the bound host can mint an update contract.
export function executeWorkflow(request, host) {
  exactObject(request, requestKeys, 'Workflow request');
  if (request.args?.mode === 'update')
    throw Error('skill-creator update requires a createWorkflow host updatePolicy');
  return executeBoundWorkflow(request, host);
}

// Configure the host once. Each call keeps the standard {scriptPath,args} shape
// and receives an independent run/backend; update calls add a caller apply package.
export function createWorkflow(host) {
  const { runRoot, updatePolicy, ...owned } = snapshot(host, 'runRoot');
  if (owned.updateContract !== undefined)
    throw Error('updateContract is not a host option; configure updatePolicy');
  return async function Workflow(request) {
    exactObject(request, requestKeys, 'Workflow request');
    let call = structuredClone(request);
    let updateContract = owned.updateContract;
    if (call.args?.mode === 'update' && updatePolicy !== undefined) {
      const bound = await bindUpdatePolicy(call, updatePolicy);
      call = bound.request;
      updateContract = bound.updateContract;
    } else if (call.args?.mode === 'update' && updateContract === undefined) {
      throw Error('skill-creator update requires an explicit host updatePolicy');
    }
    const root = await realpath(runRoot);
    if (!(await stat(root)).isDirectory()) throw Error('runRoot must be a directory');
    return executeBoundWorkflow(call, { ...owned, runDir: join(root, randomUUID()) }, updateContract);
  };
}
