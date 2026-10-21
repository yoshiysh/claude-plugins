import { promises as fs } from 'node:fs';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { CODES, LOCK_FILE, LOCK_WAIT_MS, LOG_FILE } from './constants.mjs';
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
  const tmp = tempName(lockPath, 'new');
  await fs.writeFile(tmp, JSON.stringify({ pid: process.pid, host: os.hostname(), at: new Date().toISOString(), nonce: randomBytes(6).toString('hex') }), { flag: 'wx' });
  try {
    await fs.link(tmp, lockPath);
    return true;
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  } finally {
    await fs.rm(tmp, { force: true });
  }
}

function isStale(text, mtimeMs) {
  let owner;
  try {
    owner = JSON.parse(text);
  } catch {
    return Date.now() - mtimeMs > LOCK_WAIT_MS;
  }
  return owner.host === os.hostname() && !alive(owner.pid);
}

// 古いと見たロックを一意の名前へ rename してから中身を照らす。間に別の者が作り直したロックを消さないため。
async function breakStale(lockPath) {
  let text;
  let stat;
  try {
    stat = await fs.stat(lockPath);
    text = await fs.readFile(lockPath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return true;
    throw error;
  }
  if (!isStale(text, stat.mtimeMs)) return false;
  const grave = tempName(lockPath, 'stale');
  try {
    await fs.rename(lockPath, grave);
  } catch (error) {
    if (error.code === 'ENOENT') return true;
    throw error;
  }
  const moved = await fs.readFile(grave, 'utf8').catch(() => null);
  if (moved !== text) {
    await fs.link(grave, lockPath).catch((error) => { if (error.code !== 'EEXIST') throw error; });
    await fs.rm(grave, { force: true });
    return false;
  }
  await fs.rm(grave, { force: true });
  return true;
}

export async function withLock(dir, fn, { waitMs = LOCK_WAIT_MS } = {}) {
  const lockPath = path.join(dir, LOCK_FILE);
  const deadline = Date.now() + waitMs;
  let delay = 5;
  while (!(await createLock(lockPath))) {
    if (await breakStale(lockPath)) continue;
    if (Date.now() >= deadline) reject(CODES.lock, `状態のロックを ${waitMs} ms 待っても取れない: ${lockPath}`);
    await sleep(delay);
    delay = Math.min(delay * 2, 200);
  }
  try {
    return await fn();
  } finally {
    await fs.rm(lockPath, { force: true });
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
