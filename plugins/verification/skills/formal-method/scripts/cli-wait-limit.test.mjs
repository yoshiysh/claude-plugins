// 結合: wait の待ちの上限（WAIT_LIMIT_MS = 210000ms）と still_waiting の liveness。仮想時計で即座に期限到達を検証する。
// 正本: cli-contract.md「コマンド」の wait、「生死の判定」、「定数」。
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { wait } from './lib/client.mjs';
import { CALL_MAX_MS, WAIT_LIMIT_MS } from './lib/schemas.mjs';
import { makeWorkspace, removeTree } from './test-fixtures/cli-runner.mjs';
import { liveIdentity, makeRunDir, writeLock, writeStatus, statusOf, snapshotTree } from './test-fixtures/fabricate.mjs';
import { pathWithout } from './test-fixtures/make-fake-bin.mjs';

const CASES = [
  ['生きている保持者', null, 'alive'],
  ['ps を使えず生死を判定できない保持者', () => pathWithout(['ps']), 'unknown'],
];

// process.env.PATH を切り替えるケースがあるため直列で実行する（全体で数十ms）。
describe('cli-contract wait の上限', () => {
  for (const [name, makePath, liveness] of CASES) {
    test(`cli-contract wait: ${name}で seq が増えなければ、WAIT_LIMIT_MS で still_waiting（liveness ${liveness}）を返し、CALL_MAX_MS 以内に終わり、何も書かない`, async (t) => {
      const ws = makeWorkspace();
      const { dir } = makeRunDir(ws);
      const holder = await liveIdentity();
      const origPath = process.env.PATH;
      t.after(() => {
        process.env.PATH = origPath;
        holder.stop();
        removeTree(ws);
      });
      writeLock(dir, holder.id);
      writeStatus(dir, statusOf(dir, { seq: 3, daemon: holder.id }));
      if (makePath) process.env.PATH = makePath();
      const before = snapshotTree(dir);

      let virtualNow = 0;
      const r = await wait(
        { run_dir: dir, status_seq: 3 },
        { now: () => virtualNow, waitChange: async (_d, ms) => { virtualNow += ms; } },
      );

      assert.equal(r.ok, true);
      assert.equal(r.outcome, 'still_waiting');
      assert.equal(r.status_seq, 3);
      assert.equal(r.liveness, liveness);
      assert.ok(virtualNow >= WAIT_LIMIT_MS, `WAIT_LIMIT_MS まで待つ: ${virtualNow}`);
      assert.ok(virtualNow <= CALL_MAX_MS, `CALL_MAX_MS 以内: ${virtualNow}`);
      assert.deepEqual(snapshotTree(dir), before);
    });
  }
});
