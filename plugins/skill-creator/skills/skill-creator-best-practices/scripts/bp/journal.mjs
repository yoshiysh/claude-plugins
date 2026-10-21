import { promises as fs } from 'node:fs';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { CODES, LOCK_BREAK_DELAY_ENV, LOCK_FILE, LOCK_WAIT_MS, LOG_FILE } from './constants.mjs';
import { reject } from './errors.mjs';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function tempName(lockPath, tag) {
  return `${lockPath}.${tag}.${process.pid}.${randomBytes(6).toString('hex')}`;
}

// 一時ファイルに中身を書いてから link するので、中身の無いロックが見える瞬間を作らない。
async function createLock(lockPath) {
  const nonce = randomBytes(6).toString('hex');
  const tmp = tempName(lockPath, 'new');
  await fs.writeFile(tmp, JSON.stringify({ pid: process.pid, host: os.hostname(), at: new Date().toISOString(), nonce }), { flag: 'wx' });
  try {
    await fs.link(tmp, lockPath);
    return nonce;
  } catch (error) {
    if (error.code === 'EEXIST') return null;
    throw error;
  } finally {
    await fs.rm(tmp, { force: true });
  }
}

async function readOwner(file) {
  try {
    const stat = await fs.stat(file);
    return { text: await fs.readFile(file, 'utf8'), mtimeMs: stat.mtimeMs };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function isStale({ text, mtimeMs }) {
  let owner;
  try {
    owner = JSON.parse(text);
  } catch {
    return Date.now() - mtimeMs > LOCK_WAIT_MS;
  }
  return owner.host === os.hostname() && !alive(owner.pid);
}

// 古いロックを消すのは lock.break を持つ 1 体だけにする。持ち主の死んだロックを消すのはこの 1 体だけなので、
// 読み直してから消すまでの間にロックが入れ替わることは無い。
async function breakStale(lockPath) {
  const first = await readOwner(lockPath);
  if (!first) return true;
  if (!isStale(first)) return false;
  const breakPath = `${lockPath}.break`;
  if (!(await createLock(breakPath))) {
    const breaker = await readOwner(breakPath);
    if (breaker && isStale(breaker)) await fs.rm(breakPath, { force: true });
    return false;
  }
  try {
    const delay = Number(process.env[LOCK_BREAK_DELAY_ENV] ?? 0);
    if (delay > 0) await sleep(delay);
    const again = await readOwner(lockPath);
    if (!again) return true;
    if (!isStale(again)) return false;
    await fs.rm(lockPath, { force: true });
    return true;
  } finally {
    await fs.rm(breakPath, { force: true });
  }
}

async function release(lockPath, nonce) {
  const owner = await readOwner(lockPath);
  if (!owner) return;
  let mine = false;
  try { mine = JSON.parse(owner.text).nonce === nonce; } catch { mine = false; }
  if (mine) await fs.rm(lockPath, { force: true });
}

export async function withLock(dir, fn, { waitMs = LOCK_WAIT_MS } = {}) {
  const lockPath = path.join(dir, LOCK_FILE);
  const deadline = Date.now() + waitMs;
  let delay = 5;
  let nonce;
  while (!(nonce = await createLock(lockPath))) {
    if (await breakStale(lockPath)) continue;
    if (Date.now() >= deadline) reject(CODES.lock, `状態のロックを ${waitMs} ms 待っても取れない: ${lockPath}`);
    await sleep(delay);
    delay = Math.min(delay * 2, 200);
  }
  try {
    return await fn();
  } finally {
    await release(lockPath, nonce);
  }
}

function parseLines(text) {
  const parts = text.split('\n');
  // 改行で終わらない末尾は書きかけで死んだ行なので捨てる。
  parts.pop();
  return parts.filter((line) => line.length > 0).map((line) => JSON.parse(line));
}

export async function readAll(dir) {
  let text;
  try {
    text = await fs.readFile(path.join(dir, LOG_FILE), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  return parseLines(text);
}

export function formatLine(line) {
  return `${JSON.stringify(line)}\n`;
}

export async function append(dir, line) {
  const file = path.join(dir, LOG_FILE);
  const handle = await fs.open(file, 'r+');
  try {
    const { size } = await handle.stat();
    if (size > 0) {
      const text = (await handle.readFile({ encoding: 'utf8' }));
      if (!text.endsWith('\n')) {
        const keep = Buffer.byteLength(text.slice(0, text.lastIndexOf('\n') + 1));
        await handle.truncate(keep);
      }
    }
    const { size: end } = await handle.stat();
    await handle.write(formatLine(line), end);
    await handle.sync();
  } finally {
    await handle.close();
  }
}
