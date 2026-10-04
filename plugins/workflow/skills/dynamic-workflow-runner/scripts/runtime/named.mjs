import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { compileSource } from './source.mjs';
import { exactObject, validateRequirements } from './inputs.mjs';

const nameShape = /^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/;
const scriptShape = /^[A-Za-z0-9][A-Za-z0-9._-]*\.js$/;
export const namedHostKeys = ['trustedPluginRoots', 'allowedWorkflowNames'];

async function canonical(path, directory) {
  const info = await lstat(path);
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile()) ||
      await realpath(path) !== resolve(path)) throw Error(`named workflow path must be canonical and symlink-free: ${path}`);
  return path;
}

export async function resolveNamedWorkflow(request, host, capabilities) {
  if (request.name === undefined) {
    if (typeof request.scriptPath !== 'string' || !isAbsolute(request.scriptPath))
      throw Error('absolute scriptPath or approved workflow name required');
    return { request, named: false };
  }
  if (request.scriptPath !== undefined) throw Error('name and scriptPath are mutually exclusive');
  if (typeof request.name !== 'string' || !nameShape.test(request.name)) throw Error('invalid qualified workflow name');
  const { trustedPluginRoots: roots, allowedWorkflowNames: allowed } = host;
  if (!Array.isArray(allowed) || allowed.some(n => typeof n !== 'string' || !nameShape.test(n)) ||
      new Set(allowed).size !== allowed.length || !allowed.includes(request.name))
    throw Error('named workflow requires explicit host allowedWorkflowNames authorization');
  if (!Array.isArray(roots) || !roots.length || roots.some(p => typeof p !== 'string' || !isAbsolute(p)) ||
      new Set(roots.map(p => resolve(p))).size !== roots.length)
    throw Error('named workflow requires distinct absolute trustedPluginRoots');
  const [pluginName, workflowName] = request.name.split(':');
  const matches = [];
  for (const root of roots) {
    await canonical(root, true);
    const manifestDir = join(root, '.claude-plugin');
    await canonical(manifestDir, true);
    const manifestPath = join(manifestDir, 'plugin.json');
    await canonical(manifestPath, false);
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    if (typeof manifest.name !== 'string' || !/^[a-z][a-z0-9-]*$/.test(manifest.name))
      throw Error('invalid trusted plugin manifest name');
    if (manifest.name === pluginName) matches.push(root);
  }
  if (matches.length !== 1) throw Error('named workflow plugin is missing or ambiguous');
  const workflows = join(matches[0], 'workflows');
  await canonical(workflows, true);
  const registryPath = join(workflows, 'codex-workflows.json');
  await canonical(registryPath, false);
  const registry = JSON.parse(await readFile(registryPath, 'utf8'));
  exactObject(registry, ['schemaVersion', 'workflows'], 'named workflow registry');
  if (registry.schemaVersion !== 1 || !Array.isArray(registry.workflows)) throw Error('invalid named workflow registry');
  const names = new Set();
  for (const entry of registry.workflows) {
    exactObject(entry, ['name', 'scriptPath', 'requirements', 'continuation', 'workspaceArg'], 'named workflow registration');
    if (typeof entry.name !== 'string' || !/^[a-z][a-z0-9-]*$/.test(entry.name) || names.has(entry.name) ||
        typeof entry.scriptPath !== 'string' || !scriptShape.test(entry.scriptPath) ||
        !Array.isArray(entry.requirements) || entry.requirements.some(x => typeof x !== 'string') ||
        entry.continuation !== 'next_args' ||
        (entry.workspaceArg !== undefined && (typeof entry.workspaceArg !== 'string' || !/^[a-z][A-Za-z0-9_]*$/.test(entry.workspaceArg) || !entry.requirements.includes('workspace-write')))) throw Error('invalid or duplicate named workflow registration');
    names.add(entry.name);
  }
  const entry = registry.workflows.find(e => e.name === workflowName);
  if (!entry) throw Error('named workflow has no verified Codex registration');
  validateRequirements(entry.requirements, capabilities);
  const scriptPath = join(workflows, entry.scriptPath);
  await canonical(scriptPath, false);
  const source = await readFile(scriptPath, 'utf8');
  if (compileSource(source, capabilities).meta.name !== workflowName) throw Error('named workflow source metadata does not match registration');
  if (host.checkpoint !== undefined || host.resume !== undefined)
    throw Error('named workflow uses caller next_args continuation, not runner checkpoint/resume');
  return { request: { scriptPath, ...(request.args === undefined ? {} : { args: request.args }) },
    named: true, workspaceArg: entry.workspaceArg, source, identity: { name: request.name, pluginRoot: matches[0], registryPath, scriptPath } };
}

export function namedResult(result, named) {
  if (!named || !result || typeof result !== 'object' || Array.isArray(result)) return result;
  return Object.hasOwn(result, 'resumable') ? { ...result, resumable: false } : result;
}

export async function validateNamedWorkspace(resolved, args, policy) {
  if (!resolved.workspaceArg) return;
  const path = args?.[resolved.workspaceArg];
  if (typeof path !== 'string' || !isAbsolute(path) || typeof policy?.cwd !== 'string' || policy.mode !== 'workspace-write')
    throw Error('named workflow requires an absolute workspace argument and a prepared worker cwd');
  await canonical(path, true);
  const cwd = await realpath(policy.cwd);
  const rel = relative(cwd, path);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw Error('named workflow workspace must be inside the worker cwd write scope');
}
