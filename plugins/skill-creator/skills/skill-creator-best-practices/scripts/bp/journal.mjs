import { promises as fs, constants as fsc } from 'node:fs';
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

async function breakStale(lockPath) {
  let owner;
  try {
    owner = JSON.parse(await fs.readFile(lockPath, 'utf8'));
  } catch {
    return false;
  }
  if (owner.host !== os.hostname() || alive(owner.pid)) return false;
  await fs.rm(lockPath, { force: true });
  return true;
}

export async function withLock(dir, fn, { waitMs = LOCK_WAIT_MS } = {}) {
  const lockPath = path.join(dir, LOCK_FILE);
  const deadline = Date.now() + waitMs;
  let delay = 5;
  for (;;) {
    try {
      const handle = await fs.open(lockPath, fsc.O_CREAT | fsc.O_EXCL | fsc.O_WRONLY);
      await handle.writeFile(JSON.stringify({ pid: process.pid, host: os.hostname(), at: new Date().toISOString() }));
      await handle.close();
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (await breakStale(lockPath)) continue;
      if (Date.now() >= deadline) reject(CODES.lock, `状態のロックを ${waitMs} ms 待っても取れない: ${lockPath}`);
      await sleep(delay);
      delay = Math.min(delay * 2, 200);
    }
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
