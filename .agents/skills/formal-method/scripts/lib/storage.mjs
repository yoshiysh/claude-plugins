// 保存の基礎（architecture.md「保存と排他」の不変の記録）。一時ファイル・fsync・rename・ディレクトリの fsync で書き、
// 再読込で指紋を照合して初めて保存できたとする。formal-method が書く記録は、書く直前に秘密値の型で走査する。
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { sha256Bytes, randomHex } from './canonical.mjs';
import { scanSecrets, describeHits } from './secrets.mjs';

export function fsyncDir(dir) {
  const fd = openSync(dir, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

export const tempNameFor = (finalPath) => `${finalPath}.tmp-${randomHex(12)}`;

// 一時ファイルに書いて fsync する（排他作成）。
export function writeTempFile(tmpPath, data) {
  const fd = openSync(tmpPath, 'wx', 0o644);
  try {
    const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
    let at = 0;
    while (at < bytes.length) at += writeSync(fd, bytes, at, bytes.length - at);
    fsyncSync(fd);
  } finally { closeSync(fd); }
}

// rename で置き換える書込み。読む者は途中の内容を見ない。
export function atomicWrite(finalPath, data) {
  const tmp = tempNameFor(finalPath);
  writeTempFile(tmp, data);
  renameSync(tmp, finalPath);
  fsyncDir(dirname(finalPath));
}

export const hashFile = (p) => sha256Bytes(readFileSync(p));

export function reloadVerify(p, expected) {
  try { return hashFile(p) === expected; } catch { return false; }
}

// run の領域に記録を書く（証拠を含む）。秘密値の型があれば書かない。戻り値は { ok, hash } か { ok: false, reason, secret }。
export function writeEvidence(runDir, ref, data) {
  const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
  const hits = scanSecrets(bytes);
  if (hits.length > 0) return { ok: false, secret: true, reason: `秘密値の型を見つけたので書かない: ${describeHits(hits)}` };
  const p = join(runDir, ref);
  try {
    mkdirSync(dirname(p), { recursive: true });
    atomicWrite(p, bytes);
  } catch (e) {
    return { ok: false, secret: false, reason: `書けない: ${e.code ?? e.message}` };
  }
  const hash = sha256Bytes(bytes);
  if (!reloadVerify(p, hash)) return { ok: false, secret: false, reason: '再読込の指紋が一致しない' };
  return { ok: true, hash };
}
