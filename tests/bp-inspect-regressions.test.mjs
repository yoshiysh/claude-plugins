import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  candidateVerifier, commands, compose, createArgs, failCarrier, inspectArgs, inspectDefaults, partialCarrier, resumeArgs, runAuthor, runInspect,
  setup, setupInspect, updateArgs, viewOf, viewpointOf,
} from './helpers/bp-harness.mjs';
import { sum } from '../plugins/skill-creator/skills/skill-creator-best-practices/scripts/bp/ids.mjs';
import { OPS } from '../plugins/skill-creator/skills/skill-creator-best-practices/scripts/bp/constants.mjs';

// 3 段目の監査の反証のプローブ（probe-s3）を回帰テストとして取り込んだもの。
const FNS = ['review', 'audit'];
const VIEWPOINTS = { review: ['flow', 'spec'], audit: ['audit'] };
const mark = (fn) => `［${fn}］`;
const roles = (calls) => calls.filter((c) => c.role !== 'carrier').map((c) => c.role);

// 停止を書いた運搬役の応答を 1 回だけ失う（送り直しは届く）。
function loseAfterStopOnce() {
  let done = false;
  return async (prompt, options, env) => {
    if (done || !prompt.includes(' stop <<')) return undefined;
    done = true;
    await env.carry(prompt);
    return null;
  };
}

for (const fn of FNS) {
  test(`SP-BPINSPECTION-030・SP-BPRUN-014・SP-BPRUN-029: 観点の全ての検証の項目が打ち切りで BLOCKED になった run を、原因を直して再開すると、同じ BLOCKED を繰り返さず追加の起動で見て完了する${mark(fn)}`, async (t) => {
    const s = await setupInspect(t);
    if (!s) return;
    const vp = VIEWPOINTS[fn][0];
    const r1 = await runInspect(t, { env: s.env, args: inspectArgs(fn, s.target), scenario: { verify: async (p) => (viewpointOf(p) === vp ? null : inspectDefaults.verify(p)) } });
    assert.equal(r1.result.stopKind, 'blocked');
    assert.match(r1.result.reason, /全ての項目が試行の上限で打ち切りになった/);
    const r2 = await runInspect(t, { env: s.env, args: resumeArgs(r1.result) });
    assert.equal(r2.result.stopKind, 'complete', r2.result.reason);
    assert.ok(r2.calls.some((c) => c.label === `verifier:${vp}:extra`));
    assert.deepEqual(r2.result.ledger.skip.find((x) => x.viewpoint === vp).assets, []);
    assert.deepEqual(r2.result.uncheckedViewpoints.filter((u) => u.scope === 'whole' && u.viewpoint === vp), []);
  });

  test(`SP-BPINSPECTION-030・SP-BPFINDINGS-015: 反証の全ての項目が打ち切りで BLOCKED になった run の再開は、打ち切った鍵を処理し直さず、未反証の候補を結果に残して完了する${mark(fn)}`, async (t) => {
    const s = await setupInspect(t);
    if (!s) return;
    const verify = candidateVerifier({ viewpoint: VIEWPOINTS[fn][0] });
    const r1 = await runInspect(t, { env: s.env, args: inspectArgs(fn, s.target), scenario: { verify, refute: async () => null } });
    assert.equal(r1.result.stopKind, 'blocked');
    assert.equal(r1.result.stoppedStage, '反証');
    const r2 = await runInspect(t, { env: s.env, args: resumeArgs(r1.result) });
    assert.equal(r2.result.stopKind, 'complete', r2.result.reason);
    assert.deepEqual(roles(r2.calls), []);
    assert.ok(r2.result.ledger.unrefuted.length >= 1);
    assert.deepEqual(r2.result.findings, []);
  });

  test(`SP-BPRUN-027・SP-BPRUN-034: 停止を書いた運搬役の応答を失っても同じ要求を 1 回送り直して停止の返り値を返し、状態を再開できないまま BLOCKED にしない${mark(fn)}`, async (t) => {
    const s = await setupInspect(t);
    if (!s) return;
    const { result, calls } = await runInspect(t, { env: s.env, args: inspectArgs(fn, s.target), scenario: { carrier: loseAfterStopOnce() } });
    assert.equal(result.stopKind, 'complete', result.reason);
    assert.equal(calls.filter((c) => c.prompt.includes(' stop <<')).length, 2);
    const view = await viewOf(s.env, result.state);
    assert.equal(view.stops.get('r1').launches, calls.length - 1);
  });
}

test('SP-BPINSPECTION-030・SP-BPRUN-018: 担当の作成の段を終えて適用の判定の段を始める前に止まった review の再開は、段の開始を書いてから適用の判定を行う', async (t) => {
  const s = await setupInspect(t);
  if (!s) return;
  const r1 = await runInspect(t, { env: s.env, args: inspectArgs('review', s.target), scenario: { carrier: partialCarrier(OPS.assignments, 3, (p) => p.includes('"groups"')) } });
  assert.equal(r1.result.stopKind, 'blocked');
  const v1 = await viewOf(s.env, r1.result.state);
  assert.equal(v1.stages.get('assign|').ended, true);
  assert.equal(v1.stages.get('applicability|'), undefined);
  const r2 = await runInspect(t, { env: s.env, args: resumeArgs(r1.result) });
  assert.equal(r2.result.stopKind, 'complete', r2.result.reason);
  assert.equal(roles(r2.calls).filter((r) => r === 'applicability').length, 1);
  assert.ok(!roles(r2.calls).includes('extract'));
});

test('SP-BPINSPECTION-030・SP-BPRUN-028: 担当の作成の運搬役の最後の段の開始が E_LOCK を返した review の再開は完了する', async (t) => {
  const s = await setupInspect(t);
  if (!s) return;
  let done = false;
  const carrier = async (prompt, options, env) => {
    if (done || !prompt.includes(' assignments <<') || !prompt.includes('"groups"')) return undefined;
    done = true;
    const list = commands(prompt);
    const responses = [];
    for (const c of list.slice(0, 3)) responses.push(JSON.stringify(await env.call(c.op, c.text)));
    const body = { ok: false, code: 'E_LOCK', reason: 'lock busy' };
    responses.push(JSON.stringify({ ...body, sum: sum(body) }));
    return { responses };
  };
  const r1 = await runInspect(t, { env: s.env, args: inspectArgs('review', s.target), scenario: { carrier } });
  assert.equal(r1.result.stopKind, 'blocked');
  assert.match(r1.result.reason, /段「担当の作成」の運搬役（CLI）が失敗した: stage-start: E_LOCK/);
  const r2 = await runInspect(t, { env: s.env, args: resumeArgs(r1.result) });
  assert.equal(r2.result.stopKind, 'complete', r2.result.reason);
});

test('SP-BPRUN-027・SP-BPRUN-034: update で停止を書いた運搬役の応答を失っても同じ要求を 1 回送り直して停止の返り値を返す［update］', async (t) => {
  const s = await setup(t, { fn: 'update' });
  if (!s) return;
  const { result, calls } = await runAuthor(t, { env: s.env, args: updateArgs(s.target), scenario: { carrier: loseAfterStopOnce() } });
  assert.equal(result.stopKind, 'complete', result.reason);
  assert.equal(calls.filter((c) => c.prompt.includes(' stop <<')).length, 2);
});

test('SP-BPRUN-029・SP-BPRUN-018: 全件の打ち切りの後に停止の記録を書けずに終わった create を再開すると、前の run の打ち切りを数えて同じ BLOCKED を繰り返さず、検証の段を閉じて先へ進む［create］', async (t) => {
  const s = await setup(t);
  if (!s) return;
  const carrier = compose(failCarrier(OPS.stop, { nth: [1, 2] }));
  const r1 = await runAuthor(t, { env: s.env, args: createArgs(s.target), scenario: { verify: async () => null, carrier } });
  assert.equal(r1.result.stopKind, 'blocked');
  assert.equal((await viewOf(s.env, r1.result.state)).stops.size, 0);
  const r2 = await runAuthor(t, { env: s.env, args: resumeArgs(r1.result) });
  assert.doesNotMatch(r2.result.reason ?? '', /全ての項目が試行の上限で打ち切りになった/);
  assert.ok(r2.calls.some((c) => c.label.endsWith(':extra')));
});

test('SP-BPINSPECTION-004・SP-BPINSPECTION-029: 停止の間に判定基準の写しの bp-inspection を書き換えると（除く単位と監査の観点の一覧の出所）、再開が照らす先の食い違いとして BLOCKED にする［review］［audit］', async (t) => {
  for (const fn of FNS) {
    const s = await setupInspect(t);
    if (!s) return;
    const r1 = await runInspect(t, { env: s.env, args: inspectArgs(fn, s.target), scenario: { extract: async () => null } });
    const file = path.join(s.criteriaDir, 'specifications', 'bp-inspection.md');
    await fs.appendFile(file, '\n追記\n');
    const r2 = await runInspect(t, { env: s.env, args: resumeArgs(r1.result) });
    assert.equal(r2.result.stopKind, 'blocked', fn);
    assert.ok(r2.result.reason.includes(file), r2.result.reason);
    assert.deepEqual(roles(r2.calls), []);
  }
});


for (const fn of FNS) {
  test(`SP-BPRUN-027・SP-BPRUN-030: fan-out の外の agent の失敗で BLOCKED になる理由に、段・役と host が返した失敗の内容がある${mark(fn)}`, async (t) => {
    const s = await setupInspect(t);
    if (!s) return;
    // Codex runner は backend の失敗を null として返す（失敗の内容は script に届かない）。host が投げたときの内容は静的な照合で確かめる。
    const thrown = await runInspect(t, { env: s.env, args: inspectArgs(fn, s.target), scenario: { extract: async () => { throw new Error('agent の時間切れ'); } } });
    assert.equal(thrown.result.stopKind, 'blocked');
    assert.match(thrown.result.reason, /段「担当の作成」の抽出役が結果を返さなかった/);
    const s2 = await setupInspect(t);
    const lost = await runInspect(t, { env: s2.env, args: inspectArgs(fn, s2.target), scenario: { carrier: failCarrier(OPS.bundle) } });
    assert.equal(lost.result.stopKind, 'blocked');
    assert.match(lost.result.reason, /段「台帳の作成と資産の束」の運搬役（CLI）が失敗した: 運搬役が結果を返さなかった/);
  });
}
