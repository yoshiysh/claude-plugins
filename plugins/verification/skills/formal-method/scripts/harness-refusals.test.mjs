// 結合: test の担当の代わり（test-fixtures/agent-harness.mjs）が、claim の拒否を黙って捨てず、memory.refusals に控えて
// stderr に 1 行の JSON で出す（Issue #264: 拒否の理由が test の失敗の文言に出ず、残存失敗の原因を追えなかった）。契約の違反（memory.violations）には足さない
// （意図して claim しない・提出しない test を壊さないため）。run-daemon も core も要らない: 保持者の終わった run の領域を作り、
// workerCall が依頼を出す前に E_STALE を返す経路（cli-contract.md「生死の判定」、lib/client.mjs の workerCall）を使う。
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeWorkspace, removeTree } from './test-fixtures/cli-runner.mjs';
import { deadIdentity, makeRunDir, writeLock, writeStatus, statusOf } from './test-fixtures/fabricate.mjs';
import { makeHarness } from './test-fixtures/agent-harness.mjs';

const EMPTY_SCENARIO = { returns: {}, holdCalls: {}, returnsByPerspective: {}, stopAfterSubmits: {}, blockedAs: {} };

test('cli-contract 生死の判定 #264 harness の claim の拒否: 保持者が終わった呼び出しで claim が E_STALE なら、memory.refusals に {call_id, worker, command, code, reason, detail} を控え、stderr に 1 行の JSON を出し、契約の違反には足さない', async (t) => {
  const ws = makeWorkspace();
  t.after(() => removeTree(ws));
  const { dir } = makeRunDir(ws);
  const id = await deadIdentity();
  writeLock(dir, id);
  const callId = 'call-001';
  const argsPath = join(dir, 'args.json');
  const workers = [
    { id: 'w01', role: 'extractor', model: 'sonnet', effort: 'medium' },
    { id: 'w02', role: 'plan-author', model: 'sonnet', effort: 'medium' },
  ];
  writeFileSync(argsPath, JSON.stringify({ state: dir, callId, stage: '洗い出し', workers }));
  const call = { call_id: callId, args_path: argsPath, deadline_wall_ms: Date.now() + 60000, workflow_script: 'formal-method.js' };
  const status = statusOf(dir, { seq: 1, action: 'run_agents', call, daemon: id });
  writeStatus(dir, status);

  const lines = [];
  const orig = process.stderr.write;
  t.mock.method(process.stderr, 'write', function write(chunk, ...rest) {
    lines.push(...String(chunk).split('\n').filter((l) => l.length > 0));
    return orig.call(this, chunk, ...rest);
  });
  // close は保持者の終わった run では受理されないので、閉じずに終える
  const { onAgents, memory } = makeHarness(EMPTY_SCENARIO, { close: () => 'none' });
  await onAgents(status);
  t.mock.restoreAll();

  assert.deepEqual(memory.violations, [], '拒否は契約の違反に数えない');
  assert.ok(Array.isArray(memory.refusals), 'memory.refusals がある');
  const byWorker = Object.fromEntries(memory.refusals.map((r) => [r.worker, r]));
  assert.deepEqual(Object.keys(byWorker).sort(), ['w01', 'w02'], 'worker ごとに 1 件ずつ控える');
  for (const w of ['w01', 'w02']) {
    const r = byWorker[w];
    assert.equal(r.call_id, callId);
    assert.equal(r.command, 'claim');
    assert.equal(r.code, 'E_STALE');
    assert.equal(typeof r.reason, 'string');
    assert.ok(r.reason.length > 0, 'reason が空でない');
    assert.deepEqual(r.detail, { run_dir: dir });
  }
  // stderr の行: 1 行の JSON で、控えと同じ欄を持つ
  const printed = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((j) => j && j.command === 'claim' && j.call_id === callId);
  assert.deepEqual(printed.map((j) => j.worker).sort(), ['w01', 'w02'], 'worker ごとに stderr に 1 行の JSON');
  for (const j of printed) {
    assert.deepEqual(Object.keys(j).sort(), ['call_id', 'code', 'command', 'detail', 'reason', 'worker']);
    assert.deepEqual(j, byWorker[j.worker]);
  }
});
