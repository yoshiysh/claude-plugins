// client のコマンド（cli-contract.md「コマンド」「受け箱」「依頼と応答」「生死の判定」）。client は lock を取らず、台帳と status.json を書かない。
// close が書くのは受け箱だけ、claim・query・submit が書くのは依頼のファイルだけ、wait と salvage の規則 1〜3 は何も書かない。
import { linkSync, lstatSync, mkdirSync, readFileSync, unlinkSync, watch } from 'node:fs';
import { join } from 'node:path';
import { randomHex } from './canonical.mjs';
import { WAIT_LIMIT_MS, WAIT_POLL_MS, WORKER_CALL_MAX_MS } from './schemas.mjs';
import { writeTempFile, fsyncDir } from './storage.mjs';
import { holderLiveness, readStatus } from './store.mjs';

const present = (p) => { try { lstatSync(p); return true; } catch { return false; } };

function waitForChange(runDir, ms) {
  return new Promise((resolve) => {
    let watcher = null;
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { watcher?.close(); } catch { /* ignore */ }
      resolve();
    };
    const timer = setTimeout(done, ms);
    try {
      watcher = watch(runDir, { persistent: false }, (_event, filename) => {
        if (!filename || filename === 'status.json' || filename === 'run.lock') done();
      });
      watcher.on('error', () => { /* fallback to timer */ });
    } catch { /* fallback to timer */ }
  });
}

// 一時ファイルに書いて fsync し、published へ link で公開し、一時ファイルを消す。link が既にあれば何も変えずに false。
function publishOnce(dir, published, content) {
  mkdirSync(dir, { recursive: true });
  const staging = join(dir, `.tmp-${randomHex(12)}`);
  writeTempFile(staging, JSON.stringify(content));
  try {
    linkSync(staging, published);
    fsyncDir(dir);
    return true;
  } catch (e) {
    if (e && e.code === 'EEXIST') return false;
    throw e;
  } finally {
    try { unlinkSync(staging); } catch { /* 後始末の失敗は結果を変えない */ }
  }
}

// close（受け箱の公開）: inbox/<call_id>.json へ link で公開する。既にあれば、何も変えずに duplicate を返す（排他を決めるのは link）。
export function close(input) {
  const box = join(input.run_dir, 'inbox');
  const published = join(box, `${input.call_id}.json`);
  if (present(published)) return { outcome: 'duplicate' };
  const content = 'timed_out' in input ? { call_id: input.call_id, timed_out: true } : { call_id: input.call_id, workflow_output_path: input.workflow_output_path };
  return { outcome: publishOnce(box, published, content) ? 'accepted' : 'duplicate' };
}

const WORKER_POLL_MS = 50;
const LIVENESS_EVERY_MS = 1000;
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const callOpen = (s, callId) => Boolean(s && s.action === 'run_agents' && s.call && s.call.call_id === callId);
const stale = (runDir) => ({ ok: false, code: 'E_STALE', reason: 'run.lock の保持者が終わったが、status.json が terminal でない', detail: { run_dir: runDir } });
const closedRefusal = (callId) => ({ ok: false, code: 'E_CALL', reason: `呼び出し ${callId} は開いていない（閉じたか、別の呼び出し）。worker を終える`, detail: { reason: 'call_closed' } });

// 役の依頼（claim・query・submit）: requests/<call_id>/<req_id>.json に link で公開し、run-daemon が書く responses/<call_id>/<req_id>.json を
// WORKER_CALL_MAX_MS まで待つ。呼び出しが開いていなければ依頼を出さずに拒否し、run-daemon が終わっていれば E_STALE を返す。
export async function workerCall(command, input, { now = () => Date.now() } = {}) {
  const runDir = input.run_dir;
  const first = readStatus(runDir);
  // 依頼を出す前に、保持者が終わっていれば E_STALE、呼び出しが開いていなければ拒否する（どちらも何も書かない）
  if (first?.action !== 'terminal' && holderLiveness(runDir) === 'dead') return stale(runDir);
  if (!callOpen(first, input.call_id)) return closedRefusal(input.call_id);
  const reqId = `${String(now()).padStart(15, '0')}-${randomHex(8)}`;
  const { run_dir: _r, call_id: _c, ...rest } = input;
  publishOnce(join(runDir, 'requests', input.call_id), join(runDir, 'requests', input.call_id, `${reqId}.json`), { req_id: reqId, command, ...rest });
  const responsePath = join(runDir, 'responses', input.call_id, `${reqId}.json`);
  const read = () => { try { return JSON.parse(readFileSync(responsePath, 'utf8')); } catch { return null; } };
  const started = now();
  let checked = started;
  for (;;) {
    const r = read();
    if (r) return r;
    if (now() - checked >= LIVENESS_EVERY_MS) {
      checked = now();
      if (!callOpen(readStatus(runDir), input.call_id)) return read() ?? closedRefusal(input.call_id);
      if (holderLiveness(runDir) === 'dead') return read() ?? stale(runDir);
    }
    if (now() - started >= WORKER_CALL_MAX_MS) {
      return { ok: false, code: 'E_CALL', reason: `run-daemon の応答を ${WORKER_CALL_MAX_MS} ms 待っても届かない。同じ命令を流し直してよい`, detail: { reason: 'no_response' } };
    }
    await sleep(WORKER_POLL_MS);
  }
}

// wait: terminal ならすぐ返す。seq が増えるか保持者が終わるまで、WAIT_LIMIT_MS を上限に待つ（fs.watch + WAIT_POLL_MS フォールバック）。
export async function wait(input, { now = () => Number(process.hrtime.bigint() / 1000000n), waitChange = waitForChange } = {}) {
  const runDir = input.run_dir;
  const started = now();
  const waitedMs = () => now() - started;
  for (;;) {
    const s = readStatus(runDir);
    if (s && (s.action === 'terminal' || s.seq > input.status_seq)) return { ok: true, status: s };
    const liveness = holderLiveness(runDir);
    if (liveness === 'dead') {
      const again = readStatus(runDir);
      if (again && (again.action === 'terminal' || again.seq > input.status_seq)) return { ok: true, status: again };
      return { ok: false, code: 'E_STALE', reason: 'run.lock の保持者が終わったが、status.json が terminal でない', detail: { run_dir: runDir } };
    }
    const left = WAIT_LIMIT_MS - waitedMs();
    if (left <= 0) return { ok: true, outcome: 'still_waiting', status_seq: input.status_seq, liveness };
    await waitChange(runDir, Math.min(WAIT_POLL_MS, left));
  }
}
