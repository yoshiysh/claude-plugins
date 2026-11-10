// start（cli-contract.md「起動の手順」「unit の入口（内部）」1）。start は依頼を検査しない。
// .tmp-* を消すのは removeOwnTmp、.probe-* を消すのは removeProbeDir の中だけ（構造の契約）。
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomHex } from './canonical.mjs';
import { START_WAIT_MS, STATUS_ACTIONS } from './schemas.mjs';
import { writeTempFile, fsyncDir } from './storage.mjs';
import { scanSecrets } from './secrets.mjs';
import { livenessOf, killGroup } from './process.mjs';
import { lockHolder, readPublishedResult, readStatus, readMark, salvage } from './store.mjs';
import { acceptanceStopResult } from './result.mjs';
import { locationFromEnv } from './performance.mjs';

const CLI_PATH = fileURLToPath(new URL('../formal-method-cli.mjs', import.meta.url));
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

// 純粋関数。評価の順は起動の手順の 5 と salvage の手順のとおり。
export function decideStartOutcome(o) {
  if (o.spawn_failed || o.daemon_exited) {
    if (!o.run_dir_exists) return { kind: 'return_launch_failure' };
    if (o.lock_holder === 'alive' || o.lock_holder === 'unknown') return { kind: 'e_busy', detail: { holder_role: 'run-daemon', liveness: o.lock_holder } };
    if (o.result_json === 'valid') return { kind: 'salvage', step: 'return_result_json' };
    if (o.result_json === 'invalid') return { kind: 'result_unreadable' };
    if (o.status_json === 'terminal') return { kind: 'salvage', step: 'return_status_result' };
    if (o.salvage_mark === 'unwritable') return { kind: 'salvage', step: 'return_unpublished' };
    if (o.salvage_mark === 'present' && (o.mark_winner === 'alive' || o.mark_winner === 'unknown')) return { kind: 'e_busy', detail: { holder_role: 'salvage', liveness: o.mark_winner } };
    return { kind: 'salvage', step: 'build_and_publish' };
  }
  if (o.run_dir_exists && STATUS_ACTIONS.includes(o.status_json)) return { kind: 'return_status' };
  if (o.waited_ms >= o.start_wait_ms) return o.run_dir_exists && o.lock_holder !== null ? { kind: 'return_working' } : { kind: 'stop_child_and_reevaluate' };
  return { kind: 'keep_waiting' };
}

export function removeOwnTmp(root, runId, nonce) {
  try {
    rmSync(join(root, `.tmp-${runId}-${nonce}`), { recursive: true, force: true });
    return null;
  } catch (e) { return `一時の領域を消せない（${e.code ?? e.message}）`; }
}

export function removeProbeDir(dir) {
  try { rmSync(dir, { recursive: true, force: true }); return true; } catch { return false; }
}

const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };

// 保存先の能力の確認: .probe-<nonce>/ を作り、書込み・fsync・ディレクトリの fsync を試し、消す。
function probe(root) {
  try { mkdirSync(root, { recursive: true }); } catch (e) { return `保存先の root を作れない（${e.code ?? e.message}）`; }
  const dir = join(root, `.probe-${randomHex(12)}`);
  try { mkdirSync(dir); } catch (e) { return `保存先に書けない（${e.code ?? e.message}）`; }
  let failure = null;
  try {
    writeTempFile(join(dir, 'probe'), 'probe');
    fsyncDir(dir);
    fsyncDir(root);
  } catch (e) { failure = `保存先に書けないか fsync できない（${e.code ?? e.message}）`; }
  if (!removeProbeDir(dir) && !failure) failure = '能力の確認の領域を消せない';
  return failure;
}

const utcStamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

function observe(runDir, child) {
  const exists = isDir(runDir);
  const o = {
    spawn_failed: child.spawnFailed, daemon_exited: child.exited || child.stopUnobserved, waited_ms: child.waited(), start_wait_ms: START_WAIT_MS,
    run_dir_exists: exists, lock_holder: null, result_json: 'absent', status_json: 'absent', salvage_mark: 'absent', mark_winner: null,
  };
  if (!exists) return o;
  const holder = lockHolder(runDir);
  o.lock_holder = holder ? livenessOf(holder) : 'dead';
  const pub = readPublishedResult(runDir);
  o.result_json = pub === 'absent' ? 'absent' : pub.valid ? 'valid' : 'invalid';
  const st = readStatus(runDir);
  o.status_json = st ? st.action : 'absent';
  const mark = readMark(runDir);
  o.salvage_mark = mark.state;
  if (mark.state === 'present') o.mark_winner = mark.winner ? livenessOf(mark.winner) : 'dead';
  return o;
}

// start の作用。戻り値: { ok: true, status } | { ok: false, code, reason, detail }
export async function start(input, { cwd = process.cwd() } = {}) {
  const location = locationFromEnv();
  const root = join(cwd, '.formal-method', 'runs');
  const fail = probe(root);
  if (fail) return { ok: true, status: stopStatus(acceptanceStopResult({ code: '保存の失敗', detail: fail, location })) };
  const runId = `${utcStamp()}-${randomHex(3)}`;
  const nonce = randomHex(12);
  const tmpDir = join(root, `.tmp-${runId}-${nonce}`);
  const text = JSON.stringify(input.request);
  try { mkdirSync(tmpDir); } catch (e) {
    return { ok: true, status: stopStatus(acceptanceStopResult({ code: '保存の失敗', detail: `一時の領域を作れない（${e.code ?? e.message}）`, location })) };
  }
  if (scanSecrets(text).length > 0) {
    const left = removeOwnTmp(root, runId, nonce);
    const detail = '依頼に秘密値の型があるので、依頼を保存せず run-daemon を起動しない';
    return { ok: true, status: stopStatus(acceptanceStopResult({ code: '保存の失敗', detail, location, requestUnsaved: true, unverified: left ? [{ item: tmpDir, reason: left }] : [] })) };
  }
  try { writeTempFile(join(tmpDir, 'request.input.json'), text); fsyncDir(tmpDir); } catch (e) {
    const left = removeOwnTmp(root, runId, nonce);
    return { ok: true, status: stopStatus(acceptanceStopResult({ code: '保存の失敗', detail: `依頼を書けない（${e.code ?? e.message}）`, location, requestUnsaved: true, unverified: left ? [{ item: tmpDir, reason: left }] : [] })) };
  }
  const runDir = join(root, runId);
  const startedAt = process.hrtime.bigint();
  // exited は終了を観測したときだけ立てる。stopUnobserved は、止めたが上限までに終了を観測できなかった印（判断にだけ使い、一時の領域は消さない）
  const child = { spawnFailed: false, exited: false, stopUnobserved: false, waited: () => Number((process.hrtime.bigint() - startedAt) / 1000000n), pid: null };
  let exitedResolve;
  const exited = new Promise((r) => { exitedResolve = r; });
  try {
    const cp = spawn(process.execPath, [CLI_PATH, 'run-daemon', runId, nonce, tmpDir], { cwd, detached: true, stdio: ['ignore', 'ignore', 'ignore'], env: process.env });
    cp.on('error', () => { child.spawnFailed = true; exitedResolve(); });
    cp.on('exit', () => { child.exited = true; exitedResolve(); });
    child.pid = cp.pid ?? null;
    cp.unref();
  } catch {
    child.spawnFailed = true;
    exitedResolve();
  }
  const finishTmp = () => {
    if (!isDir(tmpDir)) return [];
    if (!child.exited && !child.spawnFailed) return child.stopUnobserved ? [{ item: tmpDir, reason: 'run-daemon を止めたが終了を観測できなかったので、一時の領域を消さない' }] : [];
    const left = removeOwnTmp(root, runId, nonce);
    return left ? [{ item: tmpDir, reason: left }] : [];
  };
  for (;;) {
    const d = decideStartOutcome(observe(runDir, child));
    switch (d.kind) {
      case 'keep_waiting':
        await Promise.race([sleep(50), exited]);
        continue;
      case 'return_status': {
        const st = readStatus(runDir);
        if (!st) { await sleep(50); continue; }
        return { ok: true, status: st };
      }
      case 'return_working': {
        const holder = lockHolder(runDir);
        return { ok: true, status: { seq: 0, action: 'working', run_dir: runDir, batch: null, result: null, daemon: holder } };
      }
      case 'stop_child_and_reevaluate':
        // start は子の親で、子をまだ回収していないので pid は再利用されない。生死の判定によらずに group を止め、終了を待つ
        if (child.pid && !child.exited) killGroup(child.pid, 'SIGKILL');
        await Promise.race([exited, sleep(5000)]);
        if (!child.exited && !child.spawnFailed) child.stopUnobserved = true;
        continue;
      case 'return_launch_failure': {
        const unverified = finishTmp();
        return { ok: true, status: stopStatus(acceptanceStopResult({ code: '起動の失敗', detail: 'run-daemon の起動に失敗したか、run の領域を作る前に終わった', location, unverified })) };
      }
      case 'e_busy':
        finishTmp();
        return { ok: false, code: 'E_BUSY', reason: 'run の領域の保持者が生きているか、生死を判定できない', detail: { ...d.detail, run_dir: runDir } };
      case 'result_unreadable':
        finishTmp();
        return { ok: false, code: 'E_RESULT_UNREADABLE', reason: 'result.json が公開されているが、読めないか結果の形に合わない', detail: { run_dir: runDir, path: join(runDir, 'result.json') } };
      case 'salvage': {
        finishTmp();
        return salvage(runDir, { location });
      }
      default:
        throw new Error(`未知の判断 ${d.kind}`);
    }
  }
}

const stopStatus = (result) => ({ seq: 0, run_dir: null, action: 'terminal', batch: null, result, daemon: null });
