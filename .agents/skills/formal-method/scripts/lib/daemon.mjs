// run-daemon の入口（cli-contract.md「呼び方と入力の口」「起動の手順」4、「結果と台帳の保存の失敗」）。
// 一時の領域に run.lock を排他作成して最終の名前へ rename し、status.json を seq 1 で書いてから依頼を検査する。
// state.json・status.json・result.json・ledger.json を書く直前に毎回 salvage.mark を確かめ、あれば何も書かずに終わる。
import { basename, dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { atomicWrite } from './storage.mjs';
import { createLock, publishRunDir, releaseOwnLock, salvageMarked, SalvagedError } from './store.mjs';
import { startTimeOf, UNKNOWN_START_TIME } from './process.mjs';
import { publishResult } from './publish.mjs';
import { Run, StatusWriteError } from './run.mjs';
import { buildResult, finalizeResult, secretStopResult } from './result.mjs';
import { scanSecrets } from './secrets.mjs';
import { LEDGER_SCHEMA } from './schemas.mjs';
import { renderReport } from './render.mjs';
import { canonicalJson } from './canonical.mjs';

export async function runDaemon({ runId, nonce, tmpDir }) {
  if (basename(tmpDir) !== `.tmp-${runId}-${nonce}` || !/^[A-Za-z0-9._-]+$/.test(runId) || !/^[0-9a-f]+$/.test(nonce)) process.exit(2);
  const root = dirname(tmpDir);
  // workspace は start を呼んだ process の現在のディレクトリ（cli-contract.md「呼び方と入力の口」）。start はそれを cwd にして起動する
  const workspace = process.cwd();
  const identity = { pid: process.pid, started_at: startTimeOf(process.pid) ?? UNKNOWN_START_TIME, nonce };
  try { createLock(tmpDir, identity); } catch { process.exit(1); }
  let runDir;
  try { runDir = publishRunDir(root, runId, nonce); } catch { process.exit(1); }
  const run = new Run({ runDir, runId, root, workspace, nonce, identity });
  try {
    mkdirSync(join(root, 'index'), { recursive: true });
    atomicWrite(join(root, 'index', `${runId}.json`), JSON.stringify({ run_id: runId, run_dir: runDir, created_stage: '受付' }));
  } catch (e) {
    run.unsaved.push({ kind: 'worklog', ref: null, reason: `run の索引を書けない（${e.code ?? e.message}）` });
  }
  try {
    run.writeStatus('working', null);
    await pipeline(run);
    await aggregate(run);
  } catch (e) {
    if (e instanceof SalvagedError || e instanceof StatusWriteError) process.exit(0);
    // 内部の誤り: 途中の状態を捨て、得た範囲で集約する
    try {
      run.interrupt('内部の誤り', `run-daemon の内部の誤り: ${String(e && e.message ? e.message : e).slice(0, 300)}`);
      await aggregate(run);
    } catch (e2) {
      process.exit(e2 instanceof SalvagedError || e2 instanceof StatusWriteError ? 0 : 1);
    }
  }
  process.exit(0);
}

async function stage(run, name, fn) {
  if (run.halted()) return;
  run.enterStage(name);
  try {
    if (run.clock.limited && run.clock.usableExpired()) run.timeLimitReached(`${name}の段に入った時点で、検査に使える期限が過ぎていた`);
    else await fn();
  } catch (e) {
    if (e instanceof SalvagedError || e instanceof StatusWriteError) throw e;
    run.interrupt('内部の誤り', `${name}の段の内部の誤り: ${String(e && e.message ? e.message : e).slice(0, 300)}`);
  }
  run.leaveStage(name);
}

async function pipeline(run) {
  let accepted;
  try { accepted = run.acceptance(); } catch (e) {
    if (e instanceof SalvagedError || e instanceof StatusWriteError) throw e;
    run.interrupt('内部の誤り', `受付の段の内部の誤り: ${String(e && e.message ? e.message : e).slice(0, 300)}`);
    run.leaveStage('受付');
    return;
  }
  if (!accepted) return;
  await stage(run, '洗い出し', () => run.extraction());
  await stage(run, 'モデル化', () => run.modelling());
  await stage(run, '計画', () => run.planning());
  await stage(run, '実行', () => run.execution());
  await stage(run, '確認', () => run.confirmation());
}

async function aggregate(run) {
  run.enterStage('集約');
  run.addSummaryConfirmations();
  const parts = buildResult(run);
  // report.md は公開する結果と同じ状態を示すよう、ここまでに保存できなかった記録（run.unsaved）を同じく数えて下書きを作る
  const reportRecords = { ledger_refs: ['ledger.json'], saved: [], unsaved: run.unsaved.map((u) => ({ ...u })) };
  const draft = finalizeResult(run, parts, reportRecords);
  run.writeRecordFile('report.md', renderReport(draft), { kind: 'report' });
  run.log('集約').actions.push('判定を集約し、完了の条件を評価し、結果・報告・作業記録・記録台帳を保存した。');
  run.log('集約').results.push(`状態は ${draft.status}。`);
  run.leaveStage('集約');
  const records = {
    ledger_refs: ['ledger.json'],
    saved: [...run.entries.map((e) => ({ kind: e.kind, ref: e.ref, hash: e.hash })), { kind: 'ledger', ref: 'ledger.json', hash: null }, { kind: 'result', ref: 'result.json', hash: null }],
    unsaved: run.unsaved.map((u) => ({ ...u })),
  };
  const result = finalizeResult(run, buildResult(run), records);
  if (salvageMarked(run.runDir)) throw new SalvagedError();
  const ledger = { schema: LEDGER_SCHEMA, run_id: run.runId, kind: 'main', entries: run.entries, registered_result_hash: null };
  // 結果も記録として走査する（秘密値の型を見つけたら公開せず、R の中身を持たない R' を返す）
  let out;
  if (scanSecrets(canonicalJson(result)).length || scanSecrets(canonicalJson(ledger)).length) {
    out = { outcome: 'ledger_failed', result: secretStopResult(result, { location: run.location, why: '結果か台帳に秘密値の型があるので公開しない' }), fault: null };
  } else out = publishResult({ run_dir: run.runDir, ledger: { name: 'ledger.json', content: ledger }, result });
  if (out.outcome === 'lost_unreadable') process.exit(0);
  run.writeStatus('terminal', null, out.result);
  releaseOwnLock(run.runDir, run.nonce);
}
