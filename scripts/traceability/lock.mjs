import { link, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';

export const io = Object.freeze({link,readFile,readdir,rm,writeFile,hostname,sleep,kill:(pid,signal) => process.kill(pid,signal)});

const ATTEMPTS = 40;
const WAIT_MS = 50;
const NESTED_GUARDS = 3;
const absent = error => { if (error.code === 'ENOENT') return null; throw error; };
const created = promise => promise.then(() => true,error => { if (error.code === 'EEXIST') return false; throw error; });

function ownerOf(text) {
  const [, pid, host] = text?.match(/^([1-9]\d*) (\S+) /) ?? [];
  return pid ? {pid:Number(pid),host} : null;
}

function alive(pid, fs) {
  try {
    fs.kill(pid,0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    if (error.code === 'EPERM') return true;
    throw error;
  }
}

const dead = (owner, fs) => Boolean(owner) && owner.host === fs.hostname() && !alive(owner.pid,fs);
const describe = (text, owner) => owner ? `PID ${owner.pid} on ${owner.host}` : `an unrecognized owner ${JSON.stringify((text ?? '').slice(0,80))}`;

// 死んだ持ち主のファイルの削除は、その中身ごとの回収用ファイルを持つ間に、中身が変わっていないときだけ行う。
// rename や確かめずに消すと、その間に置かれた生きた持ち主のファイルを消して排他が破れる。回収用ファイルも中身に PID を持ち、持ち主が死んでいれば同じ手順で回収する。
async function removeStale(lockPath, target, text, draft, fs, depth = 0) {
  const guard = `${lockPath}.reclaim-${createHash('sha256').update(text).digest('hex').slice(0,16)}`;
  if (await created(fs.link(draft,guard))) {
    try {
      if (await fs.readFile(target,'utf8').catch(absent) === text) await fs.rm(target,{force:true});
    } finally {
      await fs.rm(guard,{force:true});
    }
    return null;
  }
  const held = await fs.readFile(guard,'utf8').catch(absent);
  if (held !== null && depth < NESTED_GUARDS && dead(ownerOf(held),fs)) await removeStale(lockPath,guard,held,draft,fs,depth + 1);
  return held === null ? null : `${guard} held by ${describe(held,ownerOf(held))}`;
}

// 取得の途中で強制終了した実行の下書きと回収用ファイルを片付ける。下書きは持ち主の実行しか読まないので、持ち主が死んでいれば消してよい。
async function sweep(lockPath, draft, fs) {
  const base = path.basename(lockPath);
  for (const name of await fs.readdir(path.dirname(lockPath))) {
    const file = path.join(path.dirname(lockPath),name);
    if (file === draft || !name.startsWith(`${base}.`)) continue;
    const text = await fs.readFile(file,'utf8').catch(absent);
    if (text === null || !dead(ownerOf(text),fs)) continue;
    if (name.endsWith('.tmp')) await fs.rm(file,{force:true});
    else if (name.startsWith(`${base}.reclaim-`)) await removeStale(lockPath,file,text,draft,fs,1);
  }
}

// 中身を書いてから link で置くので、ロックは中身の無い状態で見えない。
export async function acquireLock(lockPath, fs = io) {
  const token = `${process.pid} ${fs.hostname()} ${randomUUID()}\n`;
  const draft = `${lockPath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(draft,token);
  try {
    await sweep(lockPath,draft,fs);
    let busy = null;
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      if (await created(fs.link(draft,lockPath))) return token;
      const text = await fs.readFile(lockPath,'utf8').catch(absent);
      if (text === null) continue;
      const owner = ownerOf(text);
      if (!dead(owner,fs)) throw new Error(`Cannot acquire output lock ${lockPath}: held by ${describe(text,owner)}. If that process has exited, delete ${lockPath} and rerun.`);
      busy = await removeStale(lockPath,lockPath,text,draft,fs);
      if (busy) await fs.sleep(WAIT_MS);
    }
    throw new Error(`Cannot acquire output lock ${lockPath}: stale-lock recovery did not finish in ${ATTEMPTS} attempts (${busy}). If that process has exited, delete the recovery file and rerun.`);
  } finally {
    await fs.rm(draft,{force:true});
  }
}

export async function releaseLock(lockPath, token, fs = io) {
  if (await fs.readFile(lockPath,'utf8').catch(absent) === token) await fs.rm(lockPath,{force:true});
}
