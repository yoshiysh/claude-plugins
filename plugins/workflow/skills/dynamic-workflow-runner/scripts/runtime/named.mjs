import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { readSourceMetadata } from './source.mjs';

const localNameShape = /^[a-z][a-z0-9-]*$/;
const nameShape = /^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/;
export const namedHostKeys = ['trustedPluginRoots'];

async function canonical(path, directory) {
  const info = await lstat(path);
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile()) ||
      await realpath(path) !== resolve(path)) throw Error(`named workflow path must be canonical and symlink-free: ${path}`);
  return path;
}

export async function resolveNamedWorkflow(request, host) {
  if (request.name === undefined) {
    if (typeof request.scriptPath !== 'string' || !isAbsolute(request.scriptPath))
      throw Error('absolute scriptPath or qualified workflow name required');
    return { request, named: false };
  }
  if (request.scriptPath !== undefined) throw Error('name and scriptPath are mutually exclusive');
  const name = request.name;
  if (typeof name !== 'string' || !nameShape.test(name)) throw Error('invalid qualified workflow name');
  const roots = host.trustedPluginRoots;
  if (!Array.isArray(roots) || !roots.length || roots.some(p => typeof p !== 'string' || !isAbsolute(p)) ||
      new Set(roots.map(p => resolve(p))).size !== roots.length)
    throw Error('named workflow requires distinct absolute trustedPluginRoots');
  const [pluginName, workflowName] = name.split(':');
  const plugins = [];
  for (const root of roots) {
    await canonical(root, true);
    const manifestDir = join(root, '.claude-plugin');
    await canonical(manifestDir, true);
    const manifestPath = join(manifestDir, 'plugin.json');
    await canonical(manifestPath, false);
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    if (typeof manifest.name !== 'string' || !localNameShape.test(manifest.name))
      throw Error('invalid trusted plugin manifest name');
    if (manifest.name === pluginName) plugins.push(root);
  }
  if (plugins.length !== 1) throw Error('named workflow plugin is missing or ambiguous');
  const workflows = join(plugins[0], 'workflows');
  await canonical(workflows, true);
  const sources = new Map();
  for (const filename of (await readdir(workflows)).sort()) {
    if (!filename.endsWith('.js')) continue;
    const scriptPath = join(workflows, filename);
    await canonical(scriptPath, false);
    const source = await readFile(scriptPath, 'utf8');
    const meta = readSourceMetadata(source);
    if (!localNameShape.test(meta.name) || sources.has(meta.name)) throw Error('invalid or duplicate named workflow source metadata');
    sources.set(meta.name, { source, scriptPath });
  }
  const selected = sources.get(workflowName);
  if (!selected) throw Error('named workflow source is missing');
  return { request: { scriptPath: selected.scriptPath, ...(request.args === undefined ? {} : { args: request.args }) },
    named: true, source: selected.source,
    identity: { name, pluginRoot: plugins[0], scriptPath: selected.scriptPath } };
}

export async function verifyNamedSource(resolved, path, source) {
  if (!resolved?.named) return;
  await canonical(resolved.identity.scriptPath, false);
  if (path !== resolved.identity.scriptPath || source !== resolved.source)
    throw Error('named workflow source changed during resolution');
}
