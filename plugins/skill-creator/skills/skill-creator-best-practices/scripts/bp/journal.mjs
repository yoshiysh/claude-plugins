import { promises as fs } from 'node:fs';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { CODES, LOCK_FILE, LOCK_WAIT_MS, LOG_FILE } from './constants.mjs';
import { reject } from './errors.mjs';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 中身を書いた一時ファイルを link するので、中身の無いファイルが見える瞬間を作らない。target が既にあれば false。
export async function linkCreate(target, content) {
  const tmp = `${target}.new.${process.pid}.${randomBytes(6).toString('hex')}`;
  await fs.writeFile(tmp, content, { flag: 'wx' });
  try {
    await fs.link(tmp, target);
    return true;
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  } finally {
    await fs.rm(tmp, { force: true });
  }
}

export async function readOrNull(file) {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function createLock(lockPath) {
  const nonce = randomBytes(6).toString('hex');
  const owner = JSON.stringify({ pid: process.pid, host: os.hostname(), at: new Date().toISOString(), nonce });
  return (await linkCreate(lockPath, owner)) ? nonce : null;
}

async function release(lockPath, nonce) {
  const owner = await readOrNull(lockPath);
  if (owner === null) return;
  let mine = false;
  try { mine = JSON.parse(owner).nonce === nonce; } catch { mine = false; }
  if (mine) await fs.rm(lockPath, { force: true });
}

// 他のプロセスのロックは古く見えても破らない。破る仕組みを重ねると、破る側の排他が同じ問題を持つ。
// 消してよいかは、他に CLI が動いていないことを確かめられる利用者だけが決める。
export async function withLock(dir, fn, { waitMs = LOCK_WAIT_MS } = {}) {
  const lockPath = path.join(dir, LOCK_FILE);
  const deadline = Date.now() + waitMs;
  let delay = 5;
  let nonce;
  while (!(nonce = await createLock(lockPath))) {
    if (Date.now() >= deadline) {
      const owner = await readOrNull(lockPath);
      let holder = owner ?? '（読めない）';
      try { holder = JSON.stringify(JSON.parse(holder)); } catch { /* 中身をそのまま載せる */ }
      reject(CODES.lock, `状態のロックを ${waitMs} ms 待っても取れない: ${lockPath}。持ち主: ${holder}。他に CLI が動いていないことを確かめてから、利用者がこのファイルを消す`, { lockPath, holder: owner });
    }
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
