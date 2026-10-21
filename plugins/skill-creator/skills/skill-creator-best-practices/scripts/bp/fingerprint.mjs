import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import { internal } from './errors.mjs';
import { sha256Hex } from './ids.mjs';
import { realpathLoose, within } from './workspace.mjs';

export function fileDigest(bytes) {
  return sha256Hex(bytes);
}

export function pluginRoot(file) {
  let dir = path.dirname(file);
  for (;;) {
    if (existsSync(path.join(dir, '.claude-plugin', 'plugin.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function pathKey(root, file) {
  const realRoot = realpathLoose(root);
  const real = realpathLoose(file);
  if (within(real, realRoot)) return path.relative(realRoot, real).split(path.sep).join('/');
  const plugin = pluginRoot(real);
  if (plugin) return `plugin:${path.relative(plugin, real).split(path.sep).join('/')}`;
  return internal(`根の外で plugin の根を持たないファイルはパスの一覧に入れない: ${real}`);
}

export function isInList(pathsRecord, file) {
  const real = realpathLoose(file);
  if (within(real, realpathLoose(pathsRecord.root))) return true;
  return pathsRecord.files.some((f) => realpathLoose(f) === real);
}

async function walk(dir, out) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, out);
    else if (entry.isFile()) out.push(full);
    else if (entry.isSymbolicLink()) {
      const stat = await fs.stat(full).catch(() => null);
      if (stat?.isFile()) out.push(full);
    }
  }
}

export async function targetFiles(pathsRecord) {
  const root = realpathLoose(pathsRecord.root);
  const files = [];
  await walk(root, files);
  for (const extra of pathsRecord.files) {
    const real = realpathLoose(extra);
    if (!within(real, root) && existsSync(real)) files.push(real);
  }
  const keyed = files.map((f) => ({ file: f, key: pathKey(root, f) }));
  keyed.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return keyed;
}

export async function targetFingerprint(pathsRecord) {
  const out = {};
  for (const { file, key } of await targetFiles(pathsRecord)) {
    out[key] = fileDigest(await fs.readFile(file));
  }
  return out;
}

export function diffFingerprints(before, after) {
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  return [...keys].filter((k) => (before ?? {})[k] !== (after ?? {})[k]).sort();
}
