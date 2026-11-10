// run の領域の排他・状態の保存・salvage（cli-contract.md「起動の手順」4、「生死の判定」「salvage の手順」「構造の契約」）。
// run.lock は排他作成だけで書き、消すのは releaseOwnLock（nonce の照合の後）だけ。lock を奪う手順も外す手順も持たない。
import { lstatSync, linkSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { randomHex, sha256Bytes, canonicalJson } from './canonical.mjs';
import { Identity, LockFile, LEDGER_SCHEMA, Result, STATE_SCHEMA, Status, conforms } from './schemas.mjs';
import { atomicWrite, fsyncDir, writeTempFile } from './storage.mjs';
import { livenessOf, startTimeOf, killGroup, UNKNOWN_START_TIME } from './process.mjs';
import { NODE_FS, publishOne, publishResult } from './publish.mjs';
import { buildSalvageResult, salvageWorklog, secretStopResult } from './result.mjs';
import { scanSecrets } from './secrets.mjs';

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
// run の領域の観測（salvage の規則と start の 5-1 が読む値）。
export function observeRun(runDir) {
  const holder = lockHolder(runDir);
  const pub = readPublishedResult(runDir);
  const st = readStatus(runDir);
  const mark = readMark(runDir);
  return {
    lock_holder: holder ? livenessOf(holder) : 'dead',
    result_json: pub === 'absent' ? 'absent' : pub.valid ? 'valid' : 'invalid',
    status_json: st ? st.action : 'absent',
    salvage_mark: mark.state,
    mark_winner: mark.state === 'present' ? (mark.winner ? livenessOf(mark.winner) : 'dead') : null,
  };
}

// salvage の規則 1〜5 の判断の正本（純粋関数）。start の起動の手順 5-1 も、この関数で同じ規則を当てる。
// salvage_mark は 'absent' | 'present' | 'unwritable'（印の一時ファイルか link が I/O の誤りで失敗した）。
export function salvageDecision(o) {
  if (o.lock_holder === 'alive' || o.lock_holder === 'unknown') return { kind: 'e_busy', detail: { holder_role: 'run-daemon', liveness: o.lock_holder } };
  if (o.result_json === 'valid') return { kind: 'salvage', step: 'return_result_json' };
  if (o.result_json === 'invalid') return { kind: 'result_unreadable' };
  if (o.status_json === 'terminal') return { kind: 'salvage', step: 'return_status_result' };
  if (o.salvage_mark === 'unwritable') return { kind: 'salvage', step: 'return_unpublished' };
  if (o.salvage_mark === 'present' && (o.mark_winner === 'alive' || o.mark_winner === 'unknown')) return { kind: 'e_busy', detail: { holder_role: 'salvage', liveness: o.mark_winner } };
  return { kind: 'salvage', step: 'build_and_publish' };
}

const BUSY_REASON = { 'run-daemon': 'run.lock の保持者が生きているか、生死を判定できない', salvage: 'salvage.mark の勝者が生きているか、生死を判定できない' };
export const busy = (runDir, detail) => ({ ok: false, code: 'E_BUSY', reason: BUSY_REASON[detail.holder_role], detail: { ...detail, run_dir: runDir } });

// 印を書く（規則 4）。戻り値: 'written' | 'exists' | 'unwritable'
function writeMark(runDir) {
  const markPath = join(runDir, 'salvage.mark');
  const me = { pid: process.pid, started_at: startTimeOf(process.pid) ?? UNKNOWN_START_TIME, nonce: randomHex(12) };
  const tmp = `${markPath}.tmp-${me.nonce}`;
  let wrote = false;
  try {
    writeTempFile(tmp, JSON.stringify(me));
    wrote = true;
    linkSync(tmp, markPath);
    fsyncDir(runDir);
    return 'written';
  } catch (e) {
    return e && e.code === 'EEXIST' ? 'exists' : 'unwritable';
  } finally { cleanupTmp(tmp, wrote); }
}

// 戻り値: { ok: true, status } | { ok: false, code, reason, detail }
export function salvage(runDir, { location } = {}) {
  const holder = lockHolder(runDir);
  const prevStatus = readStatus(runDir);
  const extra = { seq: prevStatus ? prevStatus.seq : 0, daemon: holder };
  const o = observeRun(runDir);
  let d = salvageDecision(o);
  // 規則 4: 印が無ければ書き、その結果で同じ規則を当て直す
  if (d.kind === 'salvage' && d.step === 'build_and_publish' && o.salvage_mark === 'absent') {
    const w = writeMark(runDir);
    if (w === 'exists') {
      const again = readMark(runDir);
      d = salvageDecision({ ...o, salvage_mark: 'present', mark_winner: again.winner ? livenessOf(again.winner) : 'dead' });
    } else if (w === 'unwritable') d = salvageDecision({ ...o, salvage_mark: 'unwritable' });
  }
  if (d.kind === 'e_busy') return busy(runDir, d.detail);
  if (d.kind === 'result_unreadable') return unreadable(runDir);
  if (d.step === 'return_result_json') {
    const published = readPublishedResult(runDir);
    return published !== 'absent' && published.valid ? { ok: true, status: terminalStatus(runDir, published.result, extra) } : unreadable(runDir);
  }
  if (d.step === 'return_status_result') return { ok: true, status: { ...prevStatus, batch: null } };
  // 規則 5-1: children/ の記録のうち、pid と開始時刻が一致して生きている group を止める（規則 4 の I/O の誤りでも同じ）
  stopLiveChildren(runDir);
  if (d.step === 'return_unpublished') {
    const { result: r } = buildSalvageResult(runDir, { location, unpublished: true });
    return { ok: true, status: terminalStatus(runDir, r, extra) };
  }
  // 規則 5-2〜5-4
  return publishSalvage(runDir, { location, extra });
}

function cleanupTmp(tmp, wrote) {
  if (!wrote) return;
  try { unlinkSync(tmp); } catch { /* 後始末の失敗は結果を変えない */ }
}

export const unreadable = (runDir) => ({ ok: false, code: 'E_RESULT_UNREADABLE', reason: 'result.json が公開されているが、読めないか結果の形に合わない', detail: { run_dir: runDir, path: join(runDir, 'result.json') } });

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
  const ledgerOf = (entries) => ({ schema: LEDGER_SCHEMA, run_id: basename(runDir), kind: 'salvage', entries, registered_result_hash: null });
  // 公開する記録（作業記録・追補台帳・結果）を、書く直前に秘密値の型で走査する（cli-contract.md「run の領域の配置」）。
  // 当たれば何も公開せず、中身を持たない R' を返す（run-daemon の集約と同じ扱い）
  const planned = buildSalvageResult(runDir, { location, worklog: { hash: sha256Bytes(wlBytes) } });
  if ([wlBytes.toString('utf8'), canonicalJson(planned.result), canonicalJson(ledgerOf(planned.ledgerEntries))].some((t) => scanSecrets(t).length > 0)) {
    const leading = planned.result.stop_report.reasons.filter((x) => x.code === '処理の中断');
    const r = secretStopResult(planned.result, { location, why: 'salvage の作業記録・追補台帳・結果に秘密値の型があるので公開しない', ledgerName: 'salvage-ledger.json', ledgerKind: 'salvage_ledger', ownUnsaved: ['salvage_worklog'], leading });
    return { ok: true, status: terminalStatus(runDir, r, extra) };
  }
  const wlOut = publishDeterministic(runDir, 'salvage-worklog.json', wlBytes);
  const { result: r, ledgerEntries } = buildSalvageResult(runDir, { location, worklog: wlOut.ok ? { hash: sha256Bytes(wlBytes) } : { reason: wlOut.reason } });
  const out = publishResult({ run_dir: runDir, ledger: { name: 'salvage-ledger.json', content: ledgerOf(ledgerEntries) }, result: r });
  if (out.outcome === 'lost_unreadable') return unreadable(runDir);
  return { ok: true, status: terminalStatus(runDir, out.result, extra) };
}

