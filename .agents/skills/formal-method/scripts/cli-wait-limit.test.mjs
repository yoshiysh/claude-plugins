// 結合: wait の待ちの上限（WAIT_LIMIT_MS = 210000ms）と still_waiting の liveness。1 件ごとに約 210 秒かかるので並行に走らせる。
// 正本: cli-contract.md「コマンド」の wait、「生死の判定」、「定数」。
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { cli, cliEnv, expectOk, makeWorkspace, removeTree } from './test-fixtures/cli-runner.mjs';
import { liveIdentity, makeRunDir, writeLock, writeStatus, statusOf, snapshotTree } from './test-fixtures/fabricate.mjs';
import { pathWithout } from './test-fixtures/make-fake-bin.mjs';

const CASES = [
  ['生きている保持者', () => cliEnv(), 'alive'],
  ['ps を使えず生死を判定できない保持者', () => cliEnv({ path: pathWithout(['ps']) }), 'unknown'],
];

describe('cli-contract wait の上限', { concurrency: true }, () => {
  for (const [name, env, liveness] of CASES) {
    test(`cli-contract wait: ${name}で seq が増えなければ、WAIT_LIMIT_MS で still_waiting（liveness ${liveness}）を返し、CALL_MAX_MS 以内に終わり、何も書かない`, { timeout: 280000 }, async (t) => {
      const ws = makeWorkspace();
      const { dir } = makeRunDir(ws);
      const holder = await liveIdentity();
      t.after(() => { holder.stop(); removeTree(ws); });
      writeLock(dir, holder.id);
      writeStatus(dir, statusOf(dir, { seq: 3, daemon: holder.id }));
      const before = snapshotTree(dir);
      const r = await cli('wait', { run_dir: dir, status_seq: 3 }, { cwd: ws, env: env(), timeoutMs: 270000 });
      const j = expectOk(r, 'wait');
      assert.equal(j.outcome, 'still_waiting');
      assert.equal(j.status_seq, 3);
      assert.equal(j.liveness, liveness);
      assert.ok(r.elapsedMs >= 210000 - 2000, `WAIT_LIMIT_MS まで待つ: ${r.elapsedMs}`);
      assert.ok(r.elapsedMs <= 240000, `CALL_MAX_MS 以内: ${r.elapsedMs}`);
      assert.deepEqual(snapshotTree(dir), before);
    });
  }
});
