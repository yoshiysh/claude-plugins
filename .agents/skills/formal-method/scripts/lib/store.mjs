// run の領域の排他・状態の保存・salvage（cli-contract.md「起動の手順」4、「生死の判定」「salvage の手順」「構造の契約」）。
// run.lock は排他作成だけで書き、消すのは releaseOwnLock（nonce の照合の後）だけ。lock を奪う手順も外す手順も持たない。
import { lstatSync, linkSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { randomHex, sha256Bytes, canonicalJson } from './canonical.mjs';
import { Identity, LockFile, LEDGER_SCHEMA, Result, STATE_SCHEMA, Status, conforms } from './schemas.mjs';
import { atomicWrite, fsyncDir, writeTempFile } from './storage.mjs';
import { livenessOf, startTimeOf, killGroup, UNKNOWN_START_TIME } from './process.mjs';
import { NODE_FS, publishOne, publishResult } from './publish.mjs';
import { buildSalvageResult, salvageWorklog } from './result.mjs';

const readJsonFile = (p) => JSON.parse(readFileSync(p, 'utf8'));
const isFile = (p) => { try { return lstatSync(p).isFile(); } catch { return false; } };
const exists = (p) => { try { lstatSync(p); return true; } catch { return false; } };

// ---- lock ----
export function createLock(tmpDir, identity) {
  writeFileSync(join(tmpDir, 'run.lock'), JSON.stringify({ ...identity, role: 'run-daemon' }), { flag: 'wx', mode: 0o644 });
  fsyncDir(tmpDir);
}

// lock の保持者の識別（Identity）。無いか読めなければ null。
export function lockHolder(runDir) {
  try {
    const held = readJsonFile(join(runDir, 'run.lock'));
    if (!conforms(LockFile, held)) return null;
    return { pid: held.pid, started_at: held.started_at, nonce: held.nonce };
  } catch { return null; }
}

// 保持者の生死。lock が無いか読めなければ、保持者は終わったものとする。
export function holderLiveness(runDir) {
  const id = lockHolder(runDir);
  return id ? livenessOf(id) : 'dead';
}

export function publishRunDir(root, runId, nonce) {
  renameSync(join(root, `.tmp-${runId}-${nonce}`), join(root, runId));
  fsyncDir(root);
  return join(root, runId);
}

export function releaseOwnLock(runDir, nonce) {
  let held;
  try { held = readJsonFile(join(runDir, 'run.lock')); } catch { return false; }
  if (!held || held.nonce !== nonce) return false;
  try { unlinkSync(join(runDir, 'run.lock')); return true; } catch { return false; }
}

// ---- salvage.mark で守った書込み（run-daemon だけが使う） ----
export class SalvagedError extends Error {
  constructor() { super('salvage.mark がある'); this.code = 'SALVAGED'; }
}
export const salvageMarked = (runDir) => exists(join(runDir, 'salvage.mark'));

export function guardedWrite(runDir, name, value) {
  if (salvageMarked(runDir)) throw new SalvagedError();
  atomicWrite(join(runDir, name), typeof value === 'string' ? value : JSON.stringify(value));
}

// ---- 読む側 ----
export function readStatus(runDir) {
  const statusPath = join(runDir, 'status.json');
  if (!isFile(statusPath)) return null;
  try {
    const s = readJsonFile(statusPath);
    return conforms(Status, s) ? s : null;
  } catch { return null; }
}

export function readState(runDir) {
  try {
    const s = readJsonFile(join(runDir, 'state.json'));
    return s && typeof s === 'object' && s.schema === STATE_SCHEMA ? s : null;
  } catch { return null; }
}

// result.json の有無と形。'absent' | { valid: true, result } | { valid: false }
export function readPublishedResult(runDir) {
  const publishedPath = join(runDir, 'result.json');
  if (!exists(publishedPath)) return 'absent';
  if (!isFile(publishedPath)) return { valid: false };
  try {
    const r = readJsonFile(publishedPath);
    return conforms(Result, r) ? { valid: true, result: r } : { valid: false };
  } catch { return { valid: false }; }
}

// salvage.mark の観測: 'absent' | 'present'（勝者の識別も返す）
export function readMark(runDir) {
  const winnerPath = join(runDir, 'salvage.mark');
  if (!exists(winnerPath)) return { state: 'absent', winner: null };
  try {
    const w = readJsonFile(winnerPath);
    return { state: 'present', winner: conforms(Identity, w) ? w : null };
  } catch { return { state: 'present', winner: null }; }
}

const terminalStatus = (runDir, result, extra = {}) => ({ seq: extra.seq ?? 0, run_dir: runDir, action: 'terminal', batch: null, result, daemon: extra.daemon ?? null });

// ---- salvage の手順（cli-contract.md「salvage の手順」） ----
// 戻り値: { ok: true, status } | { ok: false, code, reason, detail }
export function salvage(runDir, { location } = {}) {
  const holder = lockHolder(runDir);
  const holderState = holder ? livenessOf(holder) : 'dead';
  if (holderState !== 'dead') {
    return { ok: false, code: 'E_BUSY', reason: 'run.lock の保持者が生きているか、生死を判定できない', detail: { holder_role: 'run-daemon', liveness: holderState, run_dir: runDir } };
  }
  const prevStatus = readStatus(runDir);
  const extra = { seq: prevStatus ? prevStatus.seq : 0, daemon: holder };
  // 規則 2
  const published = readPublishedResult(runDir);
  if (published !== 'absent') {
    if (published.valid) return { ok: true, status: terminalStatus(runDir, published.result, extra) };
    return unreadable(runDir);
  }
  // 規則 3
  if (prevStatus && prevStatus.action === 'terminal') return { ok: true, status: { ...prevStatus, batch: null } };
  // 規則 4
  const markPath = join(runDir, 'salvage.mark');
  const mark = readMark(runDir);
  if (mark.state === 'present') {
    const w = mark.winner ? livenessOf(mark.winner) : 'dead';
    if (w !== 'dead') return { ok: false, code: 'E_BUSY', reason: 'salvage.mark の勝者が生きているか、生死を判定できない', detail: { holder_role: 'salvage', liveness: w, run_dir: runDir } };
  } else {
    const me = { pid: process.pid, started_at: startTimeOf(process.pid) ?? UNKNOWN_START_TIME, nonce: randomHex(12) };
    const tmp = `${markPath}.tmp-${me.nonce}`;
    let wrote = false;
    try {
      writeTempFile(tmp, JSON.stringify(me));
      wrote = true;
      linkSync(tmp, markPath);
      fsyncDir(runDir);
    } catch (e) {
      if (e && e.code === 'EEXIST') {
        const again = readMark(runDir);
        const w = again.winner ? livenessOf(again.winner) : 'dead';
        if (w !== 'dead') { cleanupTmp(tmp, wrote); return { ok: false, code: 'E_BUSY', reason: 'salvage.mark の勝者が生きているか、生死を判定できない', detail: { holder_role: 'salvage', liveness: w, run_dir: runDir } }; }
      } else {
        cleanupTmp(tmp, wrote);
        // 規則 4 の I/O の誤り: 5 の 1・2 で結果を作り、公開しない R' を返す
        stopLiveChildren(runDir);
        const { result: r } = buildSalvageResult(runDir, { location, unpublished: true });
        return { ok: true, status: terminalStatus(runDir, r, extra) };
      }
    }
    cleanupTmp(tmp, wrote);
  }
  // 規則 5-1: children/ の記録のうち、pid と開始時刻が一致して生きている group を止める
  stopLiveChildren(runDir);
  // 規則 5-2〜5-4
  return publishSalvage(runDir, { location, extra });
}

function cleanupTmp(tmp, wrote) {
  if (!wrote) return;
  try { unlinkSync(tmp); } catch { /* 後始末の失敗は結果を変えない */ }
}

const unreadable = (runDir) => ({ ok: false, code: 'E_RESULT_UNREADABLE', reason: 'result.json が公開されているが、読めないか結果の形に合わない', detail: { run_dir: runDir, path: join(runDir, 'result.json') } });

export function stopLiveChildren(runDir) {
  const dir = join(runDir, 'children');
  let names = [];
  try { names = readdirSync(dir).filter((n) => /^\d+\.json$/.test(n)); } catch { return; }
  for (const n of names) {
    let rec;
    try { rec = readJsonFile(join(dir, n)); } catch { continue; }
    if (!rec || !Number.isSafeInteger(rec.pgid) || rec.pgid <= 1) continue;
    if (livenessOf({ pid: rec.pgid, started_at: rec.started_at }) === 'alive') killGroup(rec.pgid, 'SIGKILL');
  }
}

// 決定的に作った作業記録を公開の手順（publish.mjs の publishOne）で公開する（既にあって指紋が同じなら成功とみなす）。
function publishDeterministic(runDir, name, bytes) {
  const out = publishOne(NODE_FS, runDir, join(runDir, name), new Uint8Array(bytes));
  if (out.ok) return { ok: true };
  if (!out.exists) return { ok: false, reason: out.reason };
  if (!out.existing) return { ok: false, reason: `既にあるファイルを読めない（${out.readError}）` };
  return sha256Bytes(out.existing) === sha256Bytes(bytes) ? { ok: true } : { ok: false, reason: '既にあって指紋が違う' };
}

function publishSalvage(runDir, { location, extra }) {
  const wl = salvageWorklog(runDir);
  const wlBytes = Buffer.from(canonicalJson(wl), 'utf8');
  const wlOut = publishDeterministic(runDir, 'salvage-worklog.json', wlBytes);
  const { result: r, ledgerEntries } = buildSalvageResult(runDir, { location, worklog: wlOut.ok ? { hash: sha256Bytes(wlBytes) } : { reason: wlOut.reason } });
  const ledger = { schema: LEDGER_SCHEMA, run_id: basename(runDir), kind: 'salvage', entries: ledgerEntries, registered_result_hash: null };
  const out = publishResult({ run_dir: runDir, ledger: { name: 'salvage-ledger.json', content: ledger }, result: r });
  if (out.outcome === 'lost_unreadable') return unreadable(runDir);
  return { ok: true, status: terminalStatus(runDir, out.result, extra) };
}

