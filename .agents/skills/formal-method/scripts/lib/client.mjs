// client のコマンド（cli-contract.md「コマンド」「受け箱」「生死の判定」）。client は lock を取らず、state.json を書かない。
// submit が書くのは受け箱だけ、wait と salvage の規則 1〜3 は何も書かない。
import { linkSync, lstatSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomHex } from './canonical.mjs';
import { WAIT_LIMIT_MS, WAIT_POLL_MS } from './schemas.mjs';
import { writeTempFile, fsyncDir } from './storage.mjs';
import { holderLiveness, readStatus } from './store.mjs';

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const present = (p) => { try { lstatSync(p); return true; } catch { return false; } };

// 受け箱の公開: inbox/.tmp-<nonce> に書いて fsync し、inbox/<batch_id>.json へ link で公開し、一時ファイルを消す。
export function submit(input) {
  const runDir = input.run_dir;
  const box = join(runDir, 'inbox');
  const published = join(box, `${input.batch_id}.json`);
  // 既にあれば、何も変えずに duplicate を返す（排他を決めるのは下の link）
  if (present(published)) return { outcome: 'duplicate' };
  const content = 'timed_out' in input ? { batch_id: input.batch_id, timed_out: true } : { batch_id: input.batch_id, workflow_output_path: input.workflow_output_path };
  mkdirSync(box, { recursive: true });
  const staging = join(box, `.tmp-${randomHex(12)}`);
  writeTempFile(staging, JSON.stringify(content));
  try {
    linkSync(staging, published);
    fsyncDir(box);
    return { outcome: 'accepted' };
  } catch (e) {
    if (e && e.code === 'EEXIST') return { outcome: 'duplicate' };
    throw e;
  } finally {
    try { unlinkSync(staging); } catch { /* 後始末の失敗は結果を変えない */ }
  }
}

// wait: terminal ならすぐ返す。seq が増えるか保持者が終わるまで、WAIT_LIMIT_MS を上限に WAIT_POLL_MS の間隔で待つ。
export async function wait(input) {
  const runDir = input.run_dir;
  const started = process.hrtime.bigint();
  const waitedMs = () => Number((process.hrtime.bigint() - started) / 1000000n);
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
    await sleep(Math.min(WAIT_POLL_MS, left));
  }
}
