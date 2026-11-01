import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  candidateVerifier, commands, compose, logOf, createArgs, failCarrier, inspectArgs, inspectDefaults, partialCarrier, resumeArgs, runAuthor, runInspect,
  setup, setupInspect, viewOf, viewpointOf,
} from '../helpers/harness.mjs';
import { sum } from '../../../plugins/skill-creator/skills/skill-creator-best-practices/scripts/bp/ids.mjs';
import { OPS } from '../../../plugins/skill-creator/skills/skill-creator-best-practices/scripts/bp/constants.mjs';

// 再開・停止・照らす先の境の場合で、一度欠陥が見つかったものの回帰テスト。
const FNS = ['review', 'audit'];
const VIEWPOINTS = { review: ['flow', 'spec'], audit: ['audit'] };
const mark = (fn) => `［${fn}］`;
const roles = (calls) => calls.filter((c) => c.role !== 'carrier').map((c) => c.role);

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
  test(`SP-BPRUN-027・SP-BPRUN-030: fan-out の外の agent の失敗で BLOCKED になる理由に段と役があり、host が null を返したときは結果を返さなかったこと、運搬役の失敗では失敗の内容がある${mark(fn)}`, async (t) => {
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

for (const fn of FNS) {
  test(`SP-BPRUN-018: 段の開始の記録が 1 つも無く停止の記録も無い状態から再開すると、機能の最初の段から始める${mark(fn)}`, async (t) => {
    const s = await setupInspect(t);
    if (!s) return;
    const carrier = compose(failCarrier(OPS.targets), failCarrier(OPS.stop, { nth: [1, 2] }));
    const r1 = await runInspect(t, { env: s.env, args: inspectArgs(fn, s.target), scenario: { carrier } });
    assert.equal(r1.result.stopKind, 'blocked');
    const v1 = await viewOf(s.env, r1.result.state);
    assert.equal(v1.stages.size, 0);
    assert.equal(v1.stops.size, 0);
    const r2 = await runInspect(t, { env: s.env, args: resumeArgs(r1.result) });
    assert.equal(r2.result.stopKind, 'complete', r2.result.reason);
    const lines = await logOf(s.env, r1.result.state);
    const first = lines.find((l) => l.records.some((r) => r.t === 'stage'));
    assert.equal(first.run, 'r2');
    assert.equal(first.records.find((r) => r.t === 'stage').stage, 'targets');
    assert.equal(roles(r2.calls)[0], 'extract');
  });
}

for (const fn of FNS) {
  test(`SP-BPRUN-031・SP-BPINSPECTION-026: 形の誤った key は CLI の開始の操作が E_INPUT で拒否し、状態を作らず next_args の無い BLOCKED になる${mark(fn)}`, async (t) => {
    const s = await setupInspect(t);
    if (!s) return;
    const { result, calls } = await runInspect(t, { env: s.env, args: inspectArgs(fn, s.target, { key: 'bad key!' }) });
    assert.equal(result.stopKind, 'blocked');
    assert.match(result.reason, /start: E_INPUT key は英数字と/);
    assert.equal(result.nextArgs, undefined);
    assert.deepEqual(roles(calls), []);
    assert.deepEqual((await fs.readdir(path.join(s.env.root, 'states')).catch(() => [])).filter((d) => !d.startsWith('.')), []);
  });
}

test('SP-BPINSPECTION-029: 判定基準の写しの置き場を移してから内容を変えた再開の BLOCKED の理由は、今のファイルのパスを指す［review］', async (t) => {
  const s = await setupInspect(t);
  if (!s) return;
  const r1 = await runInspect(t, { env: s.env, args: inspectArgs('review', s.target), scenario: { extract: async () => null } });
  const moved = path.join(s.base, 'moved-criteria');
  await fs.cp(s.criteriaDir, moved, { recursive: true });
  s.env.criteriaDir = moved;
  const file = path.join(moved, 'specifications', 'bp-inspection.md');
  await fs.appendFile(file, '\n追記\n');
  const r2 = await runInspect(t, { env: s.env, args: resumeArgs(r1.result) });
  assert.equal(r2.result.stopKind, 'blocked');
  assert.ok(r2.result.reason.includes(file), r2.result.reason);
});
