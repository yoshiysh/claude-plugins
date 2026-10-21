import { promises as fs, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { CODES, LOG_FILE, STATE_DIR_NAME, STATE_ROOT_ENV, STATES_DIR, WORK_DIR } from './constants.mjs';
import { reject } from './errors.mjs';
import { formatLine } from './journal.mjs';

export function realpathLoose(p) {
  const abs = path.resolve(p);
  const rest = [];
  let cur = abs;
  for (;;) {
    try {
      return path.join(realpathSync(cur), ...rest.reverse());
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
      const parent = path.dirname(cur);
      if (parent === cur) return abs;
      rest.push(path.basename(cur));
      cur = parent;
    }
  }
}

function gitToplevel(cwd) {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null;
  }
}

export function resolveStateRoot({ cwd = process.cwd(), env = process.env } = {}) {
  const fromEnv = env[STATE_ROOT_ENV];
  if (fromEnv) {
    if (!path.isAbsolute(fromEnv)) reject(CODES.place, `${STATE_ROOT_ENV} は絶対パスでなければならない: ${fromEnv}`);
    return fromEnv;
  }
  return path.join(gitToplevel(cwd) ?? cwd, STATE_DIR_NAME);
}

// macOS の $TMPDIR は /var/folders 配下で OS が定期的に消すので /tmp 系に含める（SP-BPRUN-039）。
function forbiddenPrefixes() {
  const list = ['/tmp', '/private/tmp', '/var/tmp', '/private/var/tmp', '/var/folders', '/private/var/folders', os.tmpdir()];
  try { list.push(realpathSync(os.tmpdir())); } catch { /* tmpdir が無い環境では文字列だけで照らす */ }
  return [...new Set(list.map((p) => path.resolve(p)))];
}

export function within(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

export function forbiddenReason(root, { targetRoots = [] } = {}) {
  const real = realpathLoose(root);
  for (const prefix of forbiddenPrefixes()) {
    if (within(real, prefix) || within(path.resolve(root), prefix)) return `作業場所が /tmp 系の清掃で消える場所の配下にある: ${real}（${prefix}）`;
  }
  const parts = real.split(path.sep);
  for (let i = 0; i + 1 < parts.length; i += 1) {
    if (parts[i] === 'dynamic-workflows' && parts[i + 1] === 'workspace') return `作業場所が Codex runner の run ごとの workspace の配下にある: ${real}`;
  }
  for (const target of targetRoots) {
    if (within(real, realpathLoose(target))) return `作業場所が対象スキルの中にある: ${real}`;
  }
  return null;
}

export function assertAllowedRoot(root, options) {
  const reason = forbiddenReason(root, options);
  if (reason) reject(CODES.place, reason);
  return realpathLoose(root);
}

export function stateDir(root, id) {
  return path.join(root, STATES_DIR, id);
}

export async function createStateDir(root, id, firstLine, { writeFile = fs.writeFile } = {}) {
  const states = path.join(root, STATES_DIR);
  await fs.mkdir(states, { recursive: true });
  const target = path.join(states, id);
  const staging = path.join(states, `.staging-${id}`);
  try {
    await fs.lstat(target);
    reject(CODES.conflict, `状態のディレクトリが既にある: ${target}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await fs.mkdir(staging);
  try {
    await fs.mkdir(path.join(staging, WORK_DIR));
    await writeFile(path.join(staging, LOG_FILE), formatLine(firstLine), { flag: 'wx' });
    const handle = await fs.open(path.join(staging, LOG_FILE), 'r');
    await handle.sync();
    await handle.close();
    await fs.rename(staging, target);
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true });
    throw error;
  }
  return target;
}

export async function listStateIds(root) {
  try {
    const names = await fs.readdir(path.join(root, STATES_DIR));
    return names.filter((n) => !n.startsWith('.')).sort();
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}
