import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import * as run from './ops-run.mjs';
import * as ledger from './ops-ledger.mjs';
import { CODES, NEXT_ARGS_KEYS, STATES_DIR } from './constants.mjs';
import { readAll } from './journal.mjs';
import { canonical, sha256Hex } from './ids.mjs';
import { buildView } from './view.mjs';
import { LIMITS, context, skillDir, tmpDir, newKey } from './fixtures/harness.mjs';

async function rejects(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code, error.reason);
    return true;
  });
}

async function logOf(ctx, state) {
  return readAll(path.join(ctx.stateRoot, STATES_DIR, state));
}

async function startReview(t, files) {
  const ctx = context(t);
  if (!ctx) return {};
  const root = await skillDir(t, files);
  const out = await run.start(ctx, { key: newKey(), function: 'review', target: { root }, limits: LIMITS });
  return { ctx, root, ...out, req: { state: out.state, run: out.run } };
}

async function stateDirs(ctx) {
  return (await fs.readdir(path.join(ctx.stateRoot, STATES_DIR)).catch(() => [])).filter((n) => !n.startsWith('.'));
}

test('SP-BPRUN-003: 開始の操作が状態と修正の根拠を 1 回の書き込みで書く', async (t) => {
  const ctx = context(t);
  if (!ctx) return;
  const root = await skillDir(t);
  const out = await run.start(ctx, { key: newKey(), function: 'update', target: { root }, limits: LIMITS, grounds: [{ kind: '利用者の指示', text: 'a' }] });
  const lines = await logOf(ctx, out.state);
  assert.equal(lines.length, 1);
  assert.deepEqual(lines[0].records.map((r) => r.t), ['state', 'ground', 'run', 'paths', 'fingerprint']);
  assert.equal(out.run, 'r1');
});

test('SP-BPRUN-003: staging の書き込みを失敗させると、状態も根拠も残らない', async (t) => {
  const ctx = context(t, { writeFile: async () => { throw new Error('書き込みの失敗'); } });
  if (!ctx) return;
  const root = await skillDir(t);
  await assert.rejects(run.start(ctx, { key: newKey(), function: 'update', target: { root }, limits: LIMITS, grounds: [{ text: 'a' }] }), /書き込みの失敗/);
  assert.deepEqual(await stateDirs(ctx), []);
});

test('SP-BPRUN-004: 修正の根拠 3 件で記録 ID が 3 つ返り、dismissed の指摘も絞らずに書かれる', async (t) => {
  const ctx = context(t);
  if (!ctx) return;
  const root = await skillDir(t);
  const grounds = [
    { id: 'F1', state: 'open' },
    { id: 'F2', state: 'dismissed', dismissReason: 'x' },
    { kind: '利用者の指示', text: '直して' },
  ];
  const out = await run.start(ctx, { key: newKey(), function: 'update', target: { root }, limits: LIMITS, grounds });
  assert.deepEqual(out.groundIds, ['G1', 'G2', 'G3']);
  const view = buildView(await logOf(ctx, out.state));
  assert.deepEqual(view.grounds.map((g) => g.ground), grounds);
});

test('SP-BPRUN-005: 前提の記録が検証の受理を経ずに書ける', async (t) => {
  const { ctx, req } = await startReview(t);
  if (!ctx) return;
  const a = await run.premise(ctx, { ...req, kind: 'goal', text: '目標' });
  const b = await run.premise(ctx, { ...req, kind: 'answer', text: '回答' });
  assert.deepEqual([a.id, b.id], ['P1', 'P2']);
  const again = await run.premise(ctx, { ...req, kind: 'goal', text: '目標' });
  assert.equal(again.id, 'P1');
  assert.equal(again.same, true);
});

test('SP-BPRUN-005: 未着手の項目・試行の回数・反復の回数が状態に残る', async (t) => {
  const ctx = context(t);
  if (!ctx) return;
  const root = await skillDir(t);
  const s = await run.start(ctx, { key: newKey(), function: 'update', target: { root }, limits: LIMITS, grounds: [{ text: 'a' }] });
  const req = { state: s.state, run: s.run };
  const { items } = await run.stageStart(ctx, { ...req, stage: 'gate', round: 1, keys: [{ n: 1 }] });
  await run.itemResult(ctx, { ...req, item: items[0], result: { pass: false }, iteration: 1 });
  const v = await run.stageStart(ctx, { ...req, stage: 'verify', round: 2, keys: [{ v: 'a' }, { v: 'b' }] });
  await run.itemFail(ctx, { ...req, item: v.items[0], attempt: 1, reason: 'null' });
  const view = buildView(await logOf(ctx, s.state));
  assert.equal(view.iterations, 1);
  assert.equal(view.items.get(v.items[0]).fails.length, 1);
  const resumed = await run.start(ctx, { key: newKey(), state: s.state });
  assert.deepEqual(resumed.pending, v.items);
});

test('SP-BPRUN-006: 同じ書き込みの繰り返しで状態が変わらず、食い違う書き込みを拒否する', async (t) => {
  const { ctx, req } = await startReview(t);
  if (!ctx) return;
  const { items } = await run.stageStart(ctx, { ...req, stage: 'verify', keys: [{ a: 1 }] });
  await run.itemResult(ctx, { ...req, item: items[0], result: { x: 1 } });
  const before = await logOf(ctx, req.state);
  const again = await run.itemResult(ctx, { ...req, item: items[0], result: { x: 1 } });
  assert.equal(again.same, true);
  assert.deepEqual(await logOf(ctx, req.state), before);
  await rejects(run.itemResult(ctx, { ...req, item: items[0], result: { x: 2 } }), CODES.conflict);
  assert.deepEqual(await logOf(ctx, req.state), before);
});

test('SP-BPRUN-006: 並行の書き込みで記録が欠けない', async (t) => {
  const { ctx, req } = await startReview(t);
  if (!ctx) return;
  const keys = Array.from({ length: 9 }, (_, i) => ({ i }));
  const { items } = await run.stageStart(ctx, { ...req, stage: 'verify', keys });
  await Promise.all(items.map((item, i) => run.itemResult(ctx, { ...req, item, result: { i } })));
  const view = buildView(await logOf(ctx, req.state));
  assert.equal(items.filter((id) => view.items.get(id).result).length, 9);
});

test('SP-BPRUN-007: 作業場所を対象スキルの中と既存のディレクトリに作らない', async (t) => {
  const ctx = context(t);
  if (!ctx) return;
  const root = await skillDir(t);
  await rejects(run.start({ ...ctx, stateRoot: path.join(root, 'state') }, { key: newKey(), function: 'review', target: { root }, limits: LIMITS }), CODES.place);
  assert.equal((await fs.readdir(root)).includes('state'), false);
});

test('SP-BPRUN-039: 作業場所を /tmp 系に作らない', async (t) => {
  const ctx = context(t);
  if (!ctx) return;
  const root = await skillDir(t);
  const tmp = await tmpDir(t, 'bp-state-');
  await rejects(run.start({ ...ctx, stateRoot: tmp }, { key: newKey(), function: 'review', target: { root }, limits: LIMITS }), CODES.place);
  assert.deepEqual(await fs.readdir(tmp), []);
});

test('SP-BPRUN-009: 書いたファイルの一覧が run ごとに残り、消したファイルが印とともに残り、検証を通ったかが追記される', async (t) => {
  const ctx = context(t);
  if (!ctx) return;
  const root = await skillDir(t);
  const s = await run.start(ctx, { key: newKey(), function: 'update', target: { root }, limits: LIMITS, grounds: [{ text: 'a' }] });
  const req = { state: s.state, run: s.run };
  const out = await run.files(ctx, { ...req, entries: [
    { path: path.join(root, 'SKILL.md'), iteration: 1, action: 'write' },
    { path: path.join(root, 'old.md'), iteration: 1, action: 'delete' },
    { path: '/elsewhere/x.md', iteration: 1, action: 'write' },
  ] });
  assert.deepEqual(out.recorded, ['SKILL.md', 'old.md']);
  assert.deepEqual(out.outside, ['/elsewhere/x.md']);
  await run.files(ctx, { ...req, entries: [{ path: path.join(root, 'SKILL.md'), verified: true, iteration: 1 }] });
  const view = buildView(await logOf(ctx, s.state));
  assert.deepEqual(view.files.map((f) => [f.run, f.path, f.action]), [['r1', 'SKILL.md', 'write'], ['r1', 'old.md', 'delete']]);
  assert.deepEqual(view.verified.map((v) => [v.path, v.verified]), [['SKILL.md', true]]);
  assert.deepEqual(run.unverifiedFiles(view).map((f) => f.path), ['old.md']);
});

test('SP-BPRUN-011: 停止の記録に種類・理由・検証を通っていないファイルが残る', async (t) => {
  const ctx = context(t);
  if (!ctx) return;
  const root = await skillDir(t);
  const s = await run.start(ctx, { key: newKey(), function: 'create', target: { root: path.join(path.dirname(root), 'new-skill') }, limits: LIMITS, request: '作って' });
  const req = { state: s.state, run: s.run };
  await run.files(ctx, { ...req, entries: [{ path: path.join(path.dirname(root), 'new-skill', 'SKILL.md'), iteration: 1, action: 'write' }] });
  const out = await run.stop(ctx, { ...req, kind: 'needs_input', reason: '回答が要る', pending: [], launches: 3, outside: ['/x/y'] });
  assert.equal(out.stop.kind, 'needs_input');
  assert.equal(out.stop.reason, '回答が要る');
  assert.deepEqual(out.stop.unverified.map((f) => f.path), ['SKILL.md']);
  assert.deepEqual(out.stop.outside, ['/x/y']);
  assert.equal(out.stop.launches, 3);
});

test('SP-BPRUN-011: BLOCKED の停止の記録に理由が残る', async (t) => {
  const { ctx, req } = await startReview(t);
  if (!ctx) return;
  const out = await run.stop(ctx, { ...req, kind: 'blocked', reason: '段 verify の運搬役が失敗: timeout', pending: [], launches: 1 });
  assert.equal(out.stop.kind, 'blocked');
  assert.match(out.stop.reason, /timeout/);
  await rejects(run.stop(ctx, { ...req, kind: 'blocked', reason: '', pending: [], launches: 1 }), CODES.staleRun);
});

test('SP-BPRUN-011: 反復の上限の停止の記録に、当たった上限が反復の回数か起動数の上限かが残る', async (t) => {
  const { ctx, req } = await startReview(t);
  if (!ctx) return;
  await rejects(run.stop(ctx, { ...req, kind: 'iteration_limit', reason: 'x', pending: [], launches: 1 }), CODES.input);
  const out = await run.stop(ctx, { ...req, kind: 'iteration_limit', reason: '起動数の上限', limitHit: 'launch', pending: [], launches: 1 });
  assert.equal(out.stop.limitHit, 'launch');
});

test('SP-BPRUN-014: 完了した状態への開始を拒否する', async (t) => {
  const { ctx, req } = await startReview(t);
  if (!ctx) return;
  await run.stop(ctx, { ...req, kind: 'complete', pending: [], launches: 1 });
  const before = await logOf(ctx, req.state);
  await rejects(run.start(ctx, { key: newKey(), state: req.state }), CODES.input);
  assert.deepEqual(await logOf(ctx, req.state), before);
});

test('SP-BPRUN-016: 停止時と再開時の指紋の食い違いを出力する', async (t) => {
  const { ctx, req, root } = await startReview(t, { 'SKILL.md': '# A\n', 'b.md': 'b\n' });
  if (!ctx) return;
  await run.stop(ctx, { ...req, kind: 'blocked', reason: 'x', pending: [], launches: 1 });
  await fs.writeFile(path.join(root, 'b.md'), 'changed\n');
  const out = await run.start(ctx, { key: newKey(), state: req.state });
  assert.deepEqual(out.changed, ['b.md']);
  assert.deepEqual(out.baseline, { run: 'r1', at: 'stop' });
});

test('SP-BPRUN-016: 停止の記録の無い状態では、最後に記録した指紋と照らす', async (t) => {
  const { ctx, req, root } = await startReview(t, { 'SKILL.md': '# A\n' });
  if (!ctx) return;
  await fs.writeFile(path.join(root, 'new.md'), 'n\n');
  const out = await run.start(ctx, { key: newKey(), state: req.state });
  assert.deepEqual(out.changed, ['new.md']);
  assert.deepEqual(out.baseline, { run: 'r1', at: 'start' });
});

test('SP-BPRUN-017: 現在でない run の書き込みを拒否し、状態が変わらない', async (t) => {
  const { ctx, req } = await startReview(t);
  if (!ctx) return;
  const { items } = await run.stageStart(ctx, { ...req, stage: 'verify', keys: [{ a: 1 }] });
  const r2 = await run.start(ctx, { key: newKey(), state: req.state });
  assert.equal(r2.run, 'r2');
  const before = await logOf(ctx, req.state);
  await rejects(run.itemResult(ctx, { ...req, item: items[0], result: { late: true } }), CODES.staleRun);
  assert.deepEqual(await logOf(ctx, req.state), before);
});

test('SP-BPRUN-017: 前の run の遅れた書き込みが新しい run の状態を変えない', async (t) => {
  const { ctx, req } = await startReview(t);
  if (!ctx) return;
  const { items } = await run.stageStart(ctx, { ...req, stage: 'verify', keys: [{ a: 1 }, { a: 2 }] });
  await run.start(ctx, { key: newKey(), state: req.state });
  const r2 = { state: req.state, run: 'r2' };
  await run.itemResult(ctx, { ...r2, item: items[0], result: { ok: 1 } });
  await rejects(run.itemResult(ctx, { ...req, item: items[1], result: { late: 1 } }), CODES.staleRun);
  await rejects(run.stop(ctx, { ...req, kind: 'blocked', reason: 'late', pending: [], launches: 1 }), CODES.staleRun);
  const view = buildView(await logOf(ctx, req.state));
  assert.equal(view.items.get(items[1]).result, undefined);
  assert.equal(view.stops.size, 0);
});

test('SP-BPRUN-018: 止まった段の決め方の 4 通りと、list が未完了の状態と next_args を返す', async (t) => {
  const { ctx, req, root } = await startReview(t);
  if (!ctx) return;
  let listed = await run.list(ctx, { function: 'review', target: { root } });
  assert.equal(listed.states[0].stoppedStage.status, 'none');
  const a = await run.stageStart(ctx, { ...req, stage: 'targets', keys: [] });
  assert.deepEqual(a.items, []);
  await run.stageFinish(ctx, { ...req, stage: 'targets' });
  listed = await run.list(ctx, { function: 'review', target: { root } });
  assert.deepEqual(listed.states[0].stoppedStage, { stage: 'targets', round: null, status: 'finished' });
  const v = await run.stageStart(ctx, { ...req, stage: 'verify', keys: [{ k: 1 }, { k: 2 }] });
  await run.itemResult(ctx, { ...req, item: v.items[0], result: {} });
  listed = await run.list(ctx, { function: 'review', target: { root } });
  assert.deepEqual(listed.states[0].stoppedStage, { stage: 'verify', round: null, status: 'open' });
  assert.deepEqual(listed.states[0].pending, [v.items[1]]);
  assert.deepEqual(listed.states[0].nextArgs, { [NEXT_ARGS_KEYS.function]: 'review', [NEXT_ARGS_KEYS.state]: req.state });
  await run.stop(ctx, { ...req, kind: 'iteration_limit', limitHit: 'launch', reason: '起動数の上限', pending: [v.items[1]], launches: 4 });
  const resumed = await run.start(ctx, { key: newKey(), state: req.state });
  assert.deepEqual(resumed.stoppedStage, { stage: 'verify', round: null, status: 'stopped' });
  assert.deepEqual(resumed.pending, [v.items[1]]);
  assert.equal((await run.list(ctx, { function: 'audit', target: { root } })).states.length, 0);
});

test('SP-BPRUN-020: 起動しなかった項目が上限の無いときの起動順で未着手として残る', async (t) => {
  const { ctx, req } = await startReview(t);
  if (!ctx) return;
  const v = await run.stageStart(ctx, { ...req, stage: 'verify', keys: [{ k: 1 }, { k: 2 }, { k: 3 }] });
  await run.itemResult(ctx, { ...req, item: v.items[0], result: {} });
  await rejects(run.stop(ctx, { ...req, kind: 'iteration_limit', limitHit: 'launch', reason: 'x', pending: [v.items[2]], launches: 5 }), CODES.conflict);
  await rejects(run.stop(ctx, { ...req, kind: 'iteration_limit', limitHit: 'launch', reason: 'x', pending: [v.items[2], v.items[1]], launches: 5 }), CODES.conflict);
  const out = await run.stop(ctx, { ...req, kind: 'iteration_limit', limitHit: 'launch', reason: '起動数の上限 5', pending: [v.items[1], v.items[2]], launches: 5 });
  assert.deepEqual(out.stop.pending, [v.items[1], v.items[2]]);
  assert.deepEqual(out.stop.stage, { stage: 'verify', round: null });
});

test('SP-BPRUN-028: 試行の回数が増え、limits.attempts で打ち切りの印が付き、未着手から外れる', async (t) => {
  const { ctx, req } = await startReview(t);
  if (!ctx) return;
  const v = await run.stageStart(ctx, { ...req, stage: 'verify', keys: [{ k: 1 }] });
  const f1 = await run.itemFail(ctx, { ...req, item: v.items[0], attempt: 1, reason: 'null' });
  assert.deepEqual([f1.attempts, f1.aborted], [1, false]);
  assert.equal((await run.itemFail(ctx, { ...req, item: v.items[0], attempt: 1, reason: 'null' })).same, true);
  await rejects(run.itemFail(ctx, { ...req, item: v.items[0], attempt: 3, reason: 'null' }), CODES.conflict);
  await run.itemFail(ctx, { ...req, item: v.items[0], attempt: 2, reason: 'null' });
  const f3 = await run.itemFail(ctx, { ...req, item: v.items[0], attempt: 3, reason: 'null' });
  assert.deepEqual([f3.attempts, f3.aborted], [3, true]);
  const out = await run.stop(ctx, { ...req, kind: 'blocked', reason: '全件の打ち切り', pending: [], launches: 3 });
  assert.deepEqual(out.stop.pending, []);
});

test('SP-BPRUN-029: 状態に無い run ID・項目の ID の書き込みを E_UNKNOWN_ID で拒否する', async (t) => {
  const { ctx, req } = await startReview(t);
  if (!ctx) return;
  await rejects(run.itemResult(ctx, { ...req, run: 'r9', item: 'verify-XXXX', result: {} }), CODES.unknownId);
  await rejects(run.itemResult(ctx, { ...req, item: 'verify-XXXX', result: {} }), CODES.unknownId);
  await rejects(run.stageStart(ctx, { ...req, stage: 'nope', keys: [] }), CODES.unknownId);
  await rejects(run.stageStart(ctx, { ...req, stage: 'vanish', round: 1, keys: [{ finding: 'FNOPE', gone: 1 }] }), CODES.unknownId);
  await rejects(run.premise(ctx, { state: 'bp-00000000000000-nope', run: 'r1', kind: 'goal', text: 'x' }), CODES.unknownId);
});

const WRITE_OPS = [
  ['premise', (r) => ({ ...r, kind: 'goal', text: 'x' })],
  ['stageStart', (r) => ({ ...r, stage: 'verify', round: 7, keys: [{ z: 1 }] })],
  ['itemResult', (r, item) => ({ ...r, item, result: { z: 1 } })],
  ['itemFail', (r, item) => ({ ...r, item, attempt: 1, reason: 'x' })],
  ['stageRepeat', (r) => ({ ...r, stage: 'assign', n: 1, limitKey: 'attempts' })],
  ['stageFinish', (r) => ({ ...r, stage: 'verify', round: 1 })],
  ['discard', (r, item) => ({ ...r, items: [item] })],
  ['files', (r, item, root) => ({ ...r, entries: [{ path: path.join(root, 'SKILL.md'), iteration: 1, action: 'write' }] })],
  ['stop', (r) => ({ ...r, kind: 'blocked', reason: 'x', pending: [], launches: 1 })],
];

for (const [name, build] of WRITE_OPS) {
  test(`SP-BPRUN-031: ${name} が SP-BPRUN-006・SP-BPRUN-017 に反する書き込みを拒否し、理由を出力する`, async (t) => {
    const ctx = context(t);
    if (!ctx) return;
    const root = await skillDir(t);
    const s = await run.start(ctx, { key: newKey(), function: 'update', target: { root }, limits: LIMITS, grounds: [{ text: 'a' }] });
    const r1 = { state: s.state, run: s.run };
    const { items } = await run.stageStart(ctx, { ...r1, stage: 'verify', round: 1, keys: [{ a: 1 }] });
    await run.start(ctx, { key: newKey(), state: s.state });
    const before = await logOf(ctx, s.state);
    await assert.rejects(run[name](ctx, build(r1, items[0], root)), (error) => {
      assert.equal(error.code, CODES.staleRun);
      assert.match(error.reason, /現在の run ではない/);
      return true;
    });
    assert.deepEqual(await logOf(ctx, s.state), before);
  });
}

test('SP-BPRUN-031: 食い違う書き込みを各操作が拒否する（段の列挙・結果・停止）', async (t) => {
  const { ctx, req } = await startReview(t);
  if (!ctx) return;
  const { items } = await run.stageStart(ctx, { ...req, stage: 'verify', keys: [{ a: 1 }] });
  await rejects(run.stageStart(ctx, { ...req, stage: 'verify', keys: [{ a: 2 }] }), CODES.conflict);
  await run.stop(ctx, { ...req, kind: 'blocked', reason: 'one', pending: items, launches: 1 });
  assert.equal((await run.stop(ctx, { ...req, kind: 'blocked', reason: 'one', pending: items, launches: 1 })).same, true);
  await rejects(run.stop(ctx, { ...req, kind: 'blocked', reason: 'two', pending: [], launches: 1 }), CODES.staleRun);
});

test('SP-BPRUN-033: next_args が機能と状態 ID だけを持つ', async (t) => {
  const { ctx, req, root } = await startReview(t);
  if (!ctx) return;
  const out = await run.stop(ctx, { ...req, kind: 'blocked', reason: 'x', pending: [], launches: 1 });
  assert.deepEqual(Object.keys(out.nextArgs).sort(), [NEXT_ARGS_KEYS.function, NEXT_ARGS_KEYS.state].sort());
  const listed = await run.list(ctx, { function: 'review', target: { root } });
  assert.deepEqual(listed.states[0].nextArgs, out.nextArgs);
  const done = await startReview(t);
  const complete = await run.stop(done.ctx, { ...done.req, kind: 'complete', pending: [], launches: 1 });
  assert.equal(complete.nextArgs, undefined);
});

test('SP-BPRUN-038: 同じ段を同じ入力で列挙し直すと同じ項目の ID と順が返り、同じ鍵の 2 回の列挙が 1 項目になる', async (t) => {
  const { ctx, req } = await startReview(t);
  if (!ctx) return;
  const keys = [{ b: 2 }, { a: 1 }, { b: 2 }];
  const one = await run.stageStart(ctx, { ...req, stage: 'verify', keys });
  assert.equal(one.items.length, 2);
  const two = await run.stageStart(ctx, { ...req, stage: 'verify', keys });
  assert.deepEqual(two.items, one.items);
  assert.equal(two.same, true);
  const other = await run.stageStart(ctx, { ...req, stage: 'verify', round: 2, keys });
  assert.notDeepEqual(other.items, one.items);
});

test('SP-BPRUN-038: 段の名前・回・鍵が違えば別の項目の ID になる', async (t) => {
  const { ctx, req } = await startReview(t);
  if (!ctx) return;
  const a = await run.stageStart(ctx, { ...req, stage: 'verify', round: 1, keys: [{ k: 1 }] });
  const b = await run.stageStart(ctx, { ...req, stage: 'verify', round: 2, keys: [{ k: 1 }] });
  const c = await run.stageStart(ctx, { ...req, stage: 'refute', round: 1, keys: [{ k: 1 }] });
  assert.equal(new Set([a.items[0], b.items[0], c.items[0]]).size, 3);
  assert.match(a.items[0], /^verify\.1-[0-9A-Z]{8}$/);
});

test('SP-BPRUN-013: 反復の回数は累計で持ち、上限は run の開始時の累計からの増分に当てる', async (t) => {
  const ctx = context(t);
  if (!ctx) return;
  const root = await skillDir(t);
  const s = await run.start(ctx, { key: newKey(), function: 'update', target: { root }, limits: { ...LIMITS, iterations: 2 }, grounds: [{ text: 'a' }] });
  let req = { state: s.state, run: s.run };
  for (const n of [1, 2]) {
    const { items } = await run.stageStart(ctx, { ...req, stage: 'gate', round: n, keys: [{ n }] });
    const out = await run.itemResult(ctx, { ...req, item: items[0], result: { pass: false }, iteration: n });
    assert.equal(out.iterations.hit, n === 2);
  }
  await run.stop(ctx, { ...req, kind: 'iteration_limit', limitHit: 'iteration', reason: '反復の上限', pending: [], launches: 6 });
  const r2 = await run.start(ctx, { key: newKey(), state: s.state });
  req = { state: s.state, run: r2.run };
  const { items } = await run.stageStart(ctx, { ...req, stage: 'gate', round: 3, keys: [{ n: 3 }] });
  await rejects(run.itemResult(ctx, { ...req, item: items[0], result: {}, iteration: 5 }), CODES.conflict);
  const out = await run.itemResult(ctx, { ...req, item: items[0], result: { pass: false }, iteration: 3 });
  assert.deepEqual(out.iterations, { limit: 2, count: 3, sinceRunStart: 1, hit: false });
});

test('SP-BPRUN-015: 破棄した未着手の項目は未着手に数えない', async (t) => {
  const { ctx, req } = await startReview(t);
  if (!ctx) return;
  const v = await run.stageStart(ctx, { ...req, stage: 'verify', keys: [{ k: 1 }, { k: 2 }] });
  await run.start(ctx, { key: newKey(), state: req.state });
  const r2 = { state: req.state, run: 'r2' };
  await run.discard(ctx, { ...r2, items: v.items });
  const listed = await run.list(ctx, { function: 'review', target: { root: buildView(await logOf(ctx, req.state)).paths[0].root } });
  assert.deepEqual(listed.states[0].pending, []);
});

test('段ごとの繰り返しの回数は累計で持ち、上限は run の開始時からの増分に当てる', async (t) => {
  const { ctx, req } = await startReview(t);
  if (!ctx) return;
  const one = await run.stageRepeat(ctx, { ...req, stage: 'assign', n: 1, limitKey: 'attempts' });
  assert.deepEqual([one.count, one.hit], [1, false]);
  await rejects(run.stageRepeat(ctx, { ...req, stage: 'assign', n: 3, limitKey: 'attempts' }), CODES.conflict);
  await run.stageRepeat(ctx, { ...req, stage: 'assign', n: 2, limitKey: 'attempts' });
  const three = await run.stageRepeat(ctx, { ...req, stage: 'assign', n: 3, limitKey: 'attempts' });
  assert.equal(three.hit, true);
});

test('SP-BPAUTHORING-029: 既にあるディレクトリと symlink を指す create の開始が状態を作らずに理由を返し、ディレクトリが変わらない', async (t) => {
  const ctx = context(t);
  if (!ctx) return;
  const root = await skillDir(t);
  const before = await fs.readdir(root);
  await rejects(run.start(ctx, { key: newKey(), function: 'create', target: { root }, limits: LIMITS, request: 'x' }), CODES.input);
  const link = path.join(path.dirname(root), 'linked');
  await fs.symlink(path.join(path.dirname(root), 'missing-target'), link);
  await assert.rejects(run.start(ctx, { key: newKey(), function: 'create', target: { root: link }, limits: LIMITS, request: 'x' }), (e) => e.code === CODES.input && /symlink/.test(e.reason));
  assert.deepEqual(await fs.readdir(root), before);
  assert.deepEqual(await stateDirs(ctx), []);
});

test('SP-BPAUTHORING-029: update で無いディレクトリを拒否し、状態を作らない', async (t) => {
  const ctx = context(t);
  if (!ctx) return;
  const base = await tmpDir(t);
  await rejects(run.start(ctx, { key: newKey(), function: 'update', target: { root: path.join(base, 'none') }, limits: LIMITS, grounds: [{ text: 'a' }] }), CODES.input);
  assert.deepEqual(await stateDirs(ctx), []);
});

test('SP-BPINSPECTION-021・SP-BPINSPECTION-026: 根が SKILL.md のあるディレクトリのときだけ、開始の操作が状態を作る', async (t) => {
  const ctx = context(t);
  if (!ctx) return;
  const noSkill = await skillDir(t, { 'README.md': 'x' });
  for (const fn of ['review', 'audit']) {
    await assert.rejects(run.start(ctx, { key: newKey(), function: fn, target: { root: noSkill }, limits: LIMITS }), (e) => e.code === CODES.input && /SKILL\.md/.test(e.reason));
    await rejects(run.start(ctx, { key: newKey(), function: fn, target: { root: path.join(noSkill, 'none') }, limits: LIMITS }), CODES.input);
  }
  assert.deepEqual(await stateDirs(ctx), []);
  const ok = await skillDir(t);
  const out = await run.start(ctx, { key: newKey(), function: 'audit', target: { root: ok }, limits: LIMITS });
  assert.deepEqual(await stateDirs(ctx), [out.state]);
});

test('開始の操作は limits が 1 以上の整数でないと状態を作らない', async (t) => {
  const ctx = context(t);
  if (!ctx) return;
  const root = await skillDir(t);
  await rejects(run.start(ctx, { key: newKey(), function: 'review', target: { root }, limits: { attempts: 0, iterations: 3, untilPass: 3 } }), CODES.input);
  await rejects(run.start(ctx, { key: newKey(), function: 'review', target: { root } }), CODES.input);
  assert.deepEqual(await stateDirs(ctx), []);
});

test('SP-BPRUN-026: onTargetChanged の停止は、対象スキルが変わっていたら BLOCKED と変わったパスを同じ 1 行で書く', async (t) => {
  const { ctx, req, root } = await startReview(t, { 'SKILL.md': '# A\n' });
  if (!ctx) return;
  await fs.writeFile(path.join(root, 'SKILL.md'), '# B\n');
  const before = (await logOf(ctx, req.state)).length;
  const out = await run.stop(ctx, { ...req, kind: 'complete', pending: [], launches: 2, onTargetChanged: 'blocked' });
  assert.equal(out.stop.kind, 'blocked');
  assert.match(out.stop.reason, /SKILL\.md/);
  assert.deepEqual(out.stop.requested, { kind: 'complete', reason: '' });
  assert.equal((await logOf(ctx, req.state)).length, before + 1);
});

test('SP-BPRUN-009・SP-BPRUN-011: 通った後に書き直したファイルと、通った後に落ちたファイルは検証を通っていないものとして残る', async (t) => {
  const ctx = context(t);
  if (!ctx) return;
  const root = await skillDir(t, { 'SKILL.md': '# A\n', 'a.md': 'a\n', 'b.md': 'b\n' });
  const s = await run.start(ctx, { key: newKey(), function: 'update', target: { root }, limits: LIMITS, grounds: [{ text: 'a' }] });
  const req = { state: s.state, run: s.run };
  const f = (name) => path.join(root, name);
  await run.files(ctx, { ...req, entries: ['SKILL.md', 'a.md', 'b.md'].map((n) => ({ path: f(n), iteration: 1, action: 'write' })) });
  await run.files(ctx, { ...req, entries: ['SKILL.md', 'a.md', 'b.md'].map((n) => ({ path: f(n), iteration: 1, verified: true })) });
  await run.files(ctx, { ...req, entries: [{ path: f('a.md'), iteration: 2, action: 'write' }] });
  await run.files(ctx, { ...req, entries: [{ path: f('b.md'), iteration: 2, verified: false }] });
  const view = buildView(await logOf(ctx, s.state));
  assert.deepEqual(run.unverifiedFiles(view).map((x) => x.path).sort(), ['a.md', 'b.md']);
  await rejects(run.files(ctx, { ...req, entries: [{ path: f('a.md'), action: 'write' }] }), CODES.input);
});

test('SP-BPRUN-031: 同じ key の開始の送り直しは状態も run も増やさない', async (t) => {
  const ctx = context(t);
  if (!ctx) return;
  const root = await skillDir(t);
  const key = newKey();
  const one = await run.start(ctx, { key, function: 'review', target: { root }, limits: LIMITS });
  const two = await run.start(ctx, { key, function: 'review', target: { root }, limits: LIMITS });
  assert.deepEqual([two.state, two.run, two.same], [one.state, 'r1', true]);
  assert.deepEqual(await stateDirs(ctx), [one.state]);
  await rejects(run.start(ctx, { key, function: 'audit', target: { root }, limits: LIMITS }), CODES.conflict);
  const rkey = newKey();
  const r2 = await run.start(ctx, { key: rkey, state: one.state });
  const again = await run.start(ctx, { key: rkey, state: one.state });
  assert.deepEqual([r2.run, again.run, again.same], ['r2', 'r2', true]);
  assert.deepEqual(again.changed, r2.changed);
  assert.equal(buildView(await logOf(ctx, one.state)).runs.length, 2);
  await rejects(run.start(ctx, { function: 'review', target: { root }, limits: LIMITS }), CODES.input);
});

test('SP-BPRUN-028: 打ち切った項目と破棄した項目に新しい試行の失敗を書けない', async (t) => {
  const { ctx, req } = await startReview(t);
  if (!ctx) return;
  const v = await run.stageStart(ctx, { ...req, stage: 'verify', keys: [{ k: 1 }, { k: 2 }] });
  for (const n of [1, 2, 3]) await run.itemFail(ctx, { ...req, item: v.items[0], attempt: n, reason: 'x' });
  await rejects(run.itemFail(ctx, { ...req, item: v.items[0], attempt: 4, reason: 'x' }), CODES.conflict);
  assert.equal((await run.itemFail(ctx, { ...req, item: v.items[0], attempt: 3, reason: 'x' })).same, true);
  await run.discard(ctx, { ...req, items: [v.items[1]] });
  await rejects(run.itemFail(ctx, { ...req, item: v.items[1], attempt: 1, reason: 'x' }), CODES.conflict);
});

test('SP-BPRUN-018: list は読めない状態を理由つきで飛ばして宣言する', async (t) => {
  const { ctx, req, root } = await startReview(t);
  if (!ctx) return;
  const other = await run.start(ctx, { key: newKey(), function: 'review', target: { root }, limits: LIMITS });
  await fs.appendFile(path.join(ctx.stateRoot, STATES_DIR, other.state, 'log.jsonl'), '{broken\n');
  const listed = await run.list(ctx, { function: 'review', target: { root } });
  assert.deepEqual(listed.states.map((s) => s.state), [req.state].filter((id) => id !== other.state));
  assert.deepEqual(listed.unreadable.map((u) => u.state), [other.state]);
});

test('SP-BPRUN-031: key の記録が無い状態を指すときは理由つきの E_CONFLICT で、一時ファイルを残さない', async (t) => {
  const ctx = context(t);
  if (!ctx) return;
  const root = await skillDir(t);
  const key = newKey();
  const made = await run.start(ctx, { key, function: 'review', target: { root }, limits: LIMITS });
  const states = path.join(ctx.stateRoot, STATES_DIR);
  const markers = (await fs.readdir(states)).filter((n) => n.startsWith('.key-'));
  assert.equal(markers.length, 1);
  assert.equal(await fs.readFile(path.join(states, markers[0]), 'utf8'), made.state);
  await fs.rm(path.join(states, made.state), { recursive: true });
  await assert.rejects(run.start(ctx, { key, function: 'review', target: { root }, limits: LIMITS }), (e) => e.code === CODES.conflict && /指す状態が無い/.test(e.reason));
});

test('SP-BPRUN-009: 書いたファイルの記録と検証の記録を 1 つの要求で送ると E_INPUT', async (t) => {
  const ctx = context(t);
  if (!ctx) return;
  const root = await skillDir(t);
  const s = await run.start(ctx, { key: newKey(), function: 'update', target: { root }, limits: LIMITS, grounds: [{ text: 'a' }] });
  const req = { state: s.state, run: s.run };
  const file = path.join(root, 'SKILL.md');
  await rejects(run.files(ctx, { ...req, entries: [{ path: file, iteration: 1, action: 'write' }, { path: file, iteration: 1, verified: true }] }), CODES.input);
  assert.deepEqual(buildView(await logOf(ctx, s.state)).files, []);
});

test('SP-BPRUN-017: 停止を書いた後に対象が変わってから届いた同じ stop の送り直しは same で受理する', async (t) => {
  const { ctx, req, root } = await startReview(t, { 'SKILL.md': '# A\n' });
  if (!ctx) return;
  const body = { ...req, kind: 'complete', pending: [], launches: 2, onTargetChanged: 'blocked' };
  const first = await run.stop(ctx, body);
  assert.equal(first.stop.kind, 'complete');
  await fs.writeFile(path.join(root, 'SKILL.md'), '# changed after stop\n');
  const before = await logOf(ctx, req.state);
  const again = await run.stop(ctx, body);
  assert.deepEqual([again.same, again.stop.kind], [true, 'complete']);
  assert.deepEqual(await logOf(ctx, req.state), before);
  await rejects(run.stop(ctx, { ...body, launches: 3 }), CODES.staleRun);
});

test('SP-BPFINDINGS-002: 根の外で plugin.json を持つ祖先の無いファイルを含む開始は E_INPUT で、状態を作らない', async (t) => {
  const ctx = context(t);
  if (!ctx) return;
  const root = await skillDir(t);
  const base = await tmpDir(t);
  await fs.writeFile(path.join(base, 'loose.js'), 'x\n');
  await assert.rejects(run.start(ctx, { key: newKey(), function: 'review', target: { root, files: [path.join(base, 'loose.js')] }, limits: LIMITS }), (e) => e.code === CODES.input && /plugin\.json/.test(e.reason));
  assert.deepEqual(await stateDirs(ctx), []);
  const plugin = path.join(base, 'plug');
  await fs.mkdir(path.join(plugin, '.claude-plugin'), { recursive: true });
  await fs.mkdir(path.join(plugin, 'workflows'));
  await fs.writeFile(path.join(plugin, '.claude-plugin', 'plugin.json'), '{}');
  await fs.writeFile(path.join(plugin, 'workflows', 'w.js'), 'w\n');
  const ok = await run.start(ctx, { key: newKey(), function: 'review', target: { root, files: [path.join(plugin, 'workflows', 'w.js')] }, limits: LIMITS });
  const fp = buildView(await logOf(ctx, ok.state)).fingerprints[0].files;
  assert.ok('plugin:workflows/w.js' in fp);
});

test('SP-BPFINDINGS-002: 根の中の symlink が plugin の外のファイルを指す開始は E_INPUT で、状態を作らない', async (t) => {
  const ctx = context(t);
  if (!ctx) return;
  const root = await skillDir(t);
  const base = await tmpDir(t);
  await fs.writeFile(path.join(base, 'outside.md'), 'x\n');
  await fs.symlink(path.join(base, 'outside.md'), path.join(root, 'link.md'));
  await assert.rejects(run.start(ctx, { key: newKey(), function: 'review', target: { root }, limits: LIMITS }), (e) => e.code === CODES.input && /symlink/.test(e.reason));
  assert.deepEqual(await stateDirs(ctx), []);
});

test('SP-BPRUN-011・SP-BPRUN-016: 開始の後に plugin の外を指す symlink が置かれても、停止は書けてその実体を除外の一覧に残し、再開と取り直しは E_INPUT で止まる', async (t) => {
  const ctx = context(t);
  if (!ctx) return;
  const root = await skillDir(t);
  const base = await tmpDir(t);
  const s = await run.start(ctx, { key: newKey(), function: 'update', target: { root }, limits: LIMITS, grounds: [{ text: 'a' }] });
  const req = { state: s.state, run: s.run };
  await ledger.ledgerCreate(ctx, req);
  await fs.writeFile(path.join(base, 'outside.md'), 'x\n');
  await fs.symlink(path.join(base, 'outside.md'), path.join(root, 'link.md'));
  await rejects(ledger.ledgerRetake(ctx, req), CODES.input);
  const out = await run.stop(ctx, { ...req, kind: 'blocked', reason: 'x', pending: [], launches: 1 });
  assert.deepEqual(out.stop.excluded, ['link.md']);
  const again = await run.stop(ctx, { ...req, kind: 'blocked', reason: 'x', pending: [], launches: 1 });
  assert.equal(again.same, true);
  await assert.rejects(run.start(ctx, { key: newKey(), state: s.state }), (e) => e.code === CODES.input && e.reason.includes('link.md') && /plugin\.json/.test(e.reason));
  assert.equal(buildView(await logOf(ctx, s.state)).runs.length, 1);
});

test('SP-BPRUN-031: 停止の送り直しを照らす要求の値は、正規化した要求の sha256 である', async (t) => {
  const { ctx, req } = await startReview(t);
  if (!ctx) return;
  const out = await run.stop(ctx, { ...req, kind: 'blocked', reason: 'x', pending: [], launches: 1 });
  const expected = sha256Hex(canonical({ kind: 'blocked', reason: 'x', limitHit: null, pending: [], launches: 1, outside: [], onTargetChanged: null }));
  assert.equal(out.stop.asked, expected);
});

test('SP-BPFINDINGS-001: 台帳の作成は plugin の外のファイルがあれば理由つきの E_INPUT で、台帳を作らない', async (t) => {
  const ctx = context(t);
  if (!ctx) return;
  const root = await skillDir(t);
  const base = await tmpDir(t);
  const s = await run.start(ctx, { key: newKey(), function: 'review', target: { root }, limits: LIMITS });
  await fs.writeFile(path.join(base, 'outside.md'), 'x\n');
  await fs.symlink(path.join(base, 'outside.md'), path.join(root, 'link.md'));
  await assert.rejects(ledger.ledgerCreate(ctx, { state: s.state, run: s.run }), (e) => e.code === CODES.input && e.reason.includes('link.md'));
  assert.equal(buildView(await logOf(ctx, s.state)).ledger, null);
});

test('SP-BPRUN-026: 停止で plugin の外のファイルを除いたら、対象が変わったとして review の完了を BLOCKED にする', async (t) => {
  const { ctx, req, root } = await startReview(t);
  if (!ctx) return;
  const base = await tmpDir(t);
  await fs.writeFile(path.join(base, 'outside.md'), 'x\n');
  await fs.symlink(path.join(base, 'outside.md'), path.join(root, 'link.md'));
  const out = await run.stop(ctx, { ...req, kind: 'complete', pending: [], launches: 1, onTargetChanged: 'blocked' });
  assert.equal(out.stop.kind, 'blocked');
  assert.match(out.stop.reason, /link\.md/);
});

test('SP-BPRUN-009: 開始の後に plugin の外に作られた一覧のファイルの files は E_INPUT', async (t) => {
  const ctx = context(t);
  if (!ctx) return;
  const root = await skillDir(t);
  const base = await tmpDir(t);
  const later = path.join(base, 'later.js');
  const s = await run.start(ctx, { key: newKey(), function: 'update', target: { root, files: [later] }, limits: LIMITS, grounds: [{ text: 'a' }] });
  await fs.writeFile(later, 'x\n');
  await assert.rejects(run.files(ctx, { state: s.state, run: s.run, entries: [{ path: later, iteration: 1, action: 'write' }] }), (e) => e.code === CODES.input && e.reason.includes(later));
});

test('SP-BPRUN-028: ifNoResult を付けた試行の失敗は、結果のある項目なら記録を足さずに resulted を返し、結果の無い項目なら通常どおり数える', async (t) => {
  const { ctx, req } = await startReview(t);
  if (!ctx) return;
  const { items } = await run.stageStart(ctx, { ...req, stage: 'verify', round: 1, keys: [{ n: 1 }, { n: 2 }] });
  await run.itemResult(ctx, { ...req, item: items[0], result: { x: 1 } });
  const before = await logOf(ctx, req.state);
  const done = await run.itemFail(ctx, { ...req, item: items[0], attempt: 1, reason: 'r', ifNoResult: true });
  assert.equal(done.resulted, true);
  assert.equal(done.attempts, 0);
  assert.deepEqual(await logOf(ctx, req.state), before);
  await rejects(run.itemFail(ctx, { ...req, item: items[0], attempt: 1, reason: 'r' }), CODES.conflict);
  const counted = await run.itemFail(ctx, { ...req, item: items[1], attempt: 1, reason: 'r', ifNoResult: true });
  assert.equal(counted.resulted, undefined);
  assert.equal(counted.attempts, 1);
});

test('SP-BPRUN-011・SP-BPRUN-031: 停止の cause は BLOCKED にだけ verifiers を付けられ、記録に残る', async (t) => {
  const { ctx, req } = await startReview(t);
  if (!ctx) return;
  await rejects(run.stop(ctx, { ...req, kind: 'complete', pending: [], launches: 1, cause: 'verifiers' }), CODES.input);
  await rejects(run.stop(ctx, { ...req, kind: 'blocked', reason: 'x', pending: [], launches: 1, cause: 'carrier' }), CODES.input);
  const out = await run.stop(ctx, { ...req, kind: 'blocked', reason: 'x', pending: [], launches: 1, cause: 'verifiers' });
  assert.equal(out.stop.cause, 'verifiers');
  await rejects(run.stop(ctx, { ...req, kind: 'blocked', reason: 'x', pending: [], launches: 1 }), CODES.staleRun);
});

test('SP-BPRUN-017・SP-BPRUN-027: 停止を書いた後の run に届いた、既に書いた記録と同じ要求は記録を足さずに受け、記録を足す要求は E_STALE_RUN で拒否する', async (t) => {
  const ctx = context(t);
  if (!ctx) return;
  const root = await skillDir(t);
  const s = await run.start(ctx, { key: newKey(), function: 'review', target: { root }, limits: LIMITS });
  const req = { state: s.state, run: s.run };
  await run.stageStart(ctx, { ...req, stage: 'refute', keys: [] });
  await run.stageFinish(ctx, { ...req, stage: 'refute' });
  await run.stop(ctx, { ...req, kind: 'blocked', reason: 'x', launches: 1 });
  const before = await readAll(path.join(ctx.stateRoot, STATES_DIR, s.state));
  assert.equal((await run.stageFinish(ctx, { ...req, stage: 'refute' })).same, true);
  assert.equal((await run.stageStart(ctx, { ...req, stage: 'refute', keys: [] })).same, true);
  await rejects(run.stageStart(ctx, { ...req, stage: 'close', keys: [] }), CODES.staleRun);
  assert.deepEqual(await readAll(path.join(ctx.stateRoot, STATES_DIR, s.state)), before);
});
