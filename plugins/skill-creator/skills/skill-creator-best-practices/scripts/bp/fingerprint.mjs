import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import { sha256Hex } from './ids.mjs';
import { realpathLoose } from './workspace.mjs';

export function fileDigest(bytes) {
  return sha256Hex(bytes);
}

function within(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function pluginRoot(file) {
  let dir = path.dirname(file);
  for (;;) {
    if (existsSync(path.join(dir, '.claude-plugin', 'plugin.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// 一覧の中のパスを ID の材料にする形へ正規化する。根の中は根からの相対、根の外の workflow script は plugin の根からの相対に plugin: を付ける。
export function pathKey(root, file) {
  const realRoot = realpathLoose(root);
  const real = realpathLoose(file);
  if (within(real, realRoot)) return path.relative(realRoot, real).split(path.sep).join('/');
  const plugin = pluginRoot(real);
  if (plugin) return `plugin:${path.relative(plugin, real).split(path.sep).join('/')}`;
  return `abs:${real}`;
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

// 対象スキルを構成するファイル: 根の中の今の全てのファイルと、一覧にある根の外のファイル。
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
