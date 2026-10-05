import { readFile, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { readSourceMetadata } from './source.mjs';
import { canonicalNamedPath as canonical, readNamedFile } from './named-file.mjs';

const localNameShape = /^[a-z][a-z0-9-]*$/;
const nameShape = /^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/;
export const namedHostKeys = ['trustedPluginRoots'];

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
    const manifestFile = await readNamedFile(manifestPath, undefined, [root, manifestDir]);
    const manifest = JSON.parse(manifestFile.source);
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
    const file = await readNamedFile(scriptPath, undefined, [plugins[0], workflows]);
    const { source } = file;
    const meta = readSourceMetadata(source);
    if (!localNameShape.test(meta.name) || sources.has(meta.name)) throw Error('invalid or duplicate named workflow source metadata');
    sources.set(meta.name, { source, scriptPath, meta, bytes: file.bytes, fileInfo: file.info });
  }
  const selected = sources.get(workflowName);
  if (!selected) throw Error('named workflow source is missing');
  return { request: { scriptPath: selected.scriptPath, ...(request.args === undefined ? {} : { args: request.args }) },
    named: true, source: selected.source, meta: selected.meta, bytes: selected.bytes, fileInfo: selected.fileInfo,
    identity: { name, pluginRoot: plugins[0], scriptPath: selected.scriptPath } };
}

export async function verifyNamedSource(resolved, path, source, bytes) {
  if (!resolved?.named) return;
  await canonical(resolved.identity.scriptPath, false);
  if (path !== resolved.identity.scriptPath || source !== resolved.source || !bytes?.equals(resolved.bytes))
    throw Error('named workflow source changed during resolution');
}


export async function readExecutionSource(request, resolved) {
  if (!resolved?.named) {
    const path = await realpath(request.scriptPath);
    return { path, source: await readFile(path, 'utf8') };
  }
  const { scriptPath: path, pluginRoot } = resolved.identity;
  const file = await readNamedFile(path, resolved.fileInfo,
    [pluginRoot, join(pluginRoot, '.claude-plugin'), join(pluginRoot, 'workflows')]);
  await verifyNamedSource(resolved, path, file.source, file.bytes);
  return { path, source: file.source };
}
