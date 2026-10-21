import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  assetIds, candidateVerifier, commands, failCarrier, inspectArgs, inspectDefaults, logOf, resumeArgs, runInspect, setupInspect, viewOf, viewpointOf,
} from './helpers/bp-harness.mjs';
import { OPS } from '../plugins/skill-creator/skills/skill-creator-best-practices/scripts/bp/constants.mjs';

const FNS = ['review', 'audit'];
const VIEWPOINTS = { review: ['flow', 'spec'], audit: ['audit'] };
const mark = (fn) => `［${fn}］`;
const roles = (calls) => calls.filter((c) => c.role !== 'carrier').map((c) => c.role);
const ops = (calls) => calls.filter((c) => c.role === 'carrier').flatMap((c) => commands(c.prompt).map((x) => x.op));

function compose(...carriers) {
  return async (...a) => {
    for (const c of carriers) {
      const out = await c(...a);
      if (out !== undefined) return out;
    }
    return undefined;
  };
}

// op を含む運搬役のうち when に当たる最初の 1 つで、先頭の k 個の要求だけを実行して応答を失う（段の途中まで書いて止まった run を作る）。
function partialCarrier(op, k, when = () => true) {
  let done = false;
  return async (prompt, options, env) => {
    if (done || !prompt.includes(` ${op} <<`) || !when(prompt)) return undefined;
    done = true;
    for (const c of commands(prompt).slice(0, k)) await env.call(c.op, c.text);
    return null;
  };
}

// op の要求の項目のうち、現れた順で index 番目の項目の運搬役を全て失う（送り直しも失うので、その項目の書き込みで BLOCKED になる）。
function loseItem(op, index = 0) {
  const seen = [];
  return async (prompt) => {
    if (!prompt.includes(` ${op} <<`)) return undefined;
    const item = /"item":"([^"]+)"/.exec(prompt)[1];
    if (!seen.includes(item)) seen.push(item);
    return seen.indexOf(item) === index ? null : undefined;
  };
}

async function editFile(file, edit) {
  await fs.writeFile(file, edit(await fs.readFile(file, 'utf8')));
}

function itemsOf(view, stage) {
  return [...view.items.values()].filter((i) => i.stage === stage);
}

// 再開した run の前に止める段ごとの作り方。どれも停止の種類によらず、止まった段から続く（SP-BPINSPECTION-030 の表）。
for (const fn of FNS) {
  test(`SP-BPINSPECTION-030・SP-BPINSPECTION-029・SP-BPRUN-015: 照らす先を読めずに BLOCKED になった run を、照らす先を直して再開すると、照らす先の決定の段をやり直して全ての段を最初から進む${mark(fn)}`, async (t) => {
    const s = await setupInspect(t);
    if (!s) return;
    const file = fn === 'review' ? path.join(s.criteriaDir, 'specifications', 'bp-conformance.md') : s.env.promptAudit;
    let restore = null;
    if (fn === 'review') {
      const text = await fs.readFile(file, 'utf8');
      restore = () => fs.writeFile(file, text);
      await fs.writeFile(file, text.replace('## 機能仕様', '## 機能'));
    } else {
      s.env.promptAudit = path.join(s.base, 'missing.md');
      restore = async () => { s.env.promptAudit = file; };
    }
    const r1 = await runInspect(t, { env: s.env, args: inspectArgs(fn, s.target) });
    assert.equal(r1.result.stopKind, 'blocked');
    assert.deepEqual(roles(r1.calls), []);
    await restore();
    const r2 = await runInspect(t, { env: s.env, args: resumeArgs(r1.result) });
    assert.equal(r2.result.stopKind, 'complete', r2.result.reason);
    assert.equal(roles(r2.calls)[0], 'extract');
    const view = await viewOf(s.env, r1.result.state);
    assert.deepEqual(view.targets.map((x) => x.run), ['r1', 'r2']);
    assert.deepEqual(r2.result.targets.map((x) => x.readable), VIEWPOINTS[fn].map(() => true));
  });

  test(`SP-BPINSPECTION-030: 台帳の作成と資産の束の段で止まった run の再開は、その段を最初から行う${mark(fn)}`, async (t) => {
    const s = await setupInspect(t);
    if (!s) return;
    const r1 = await runInspect(t, { env: s.env, args: inspectArgs(fn, s.target), scenario: { carrier: partialCarrier(OPS.bundle, 1) } });
    assert.equal(r1.result.stopKind, 'blocked');
    assert.equal(r1.result.stoppedStage, '台帳の作成と資産の束');
    const r2 = await runInspect(t, { env: s.env, args: resumeArgs(r1.result) });
    assert.equal(r2.result.stopKind, 'complete', r2.result.reason);
    assert.ok(ops(r2.calls).includes(OPS.ledgerCreate));
    assert.equal(roles(r2.calls)[0], 'extract');
  });

  test(`SP-BPINSPECTION-030: 担当の作成の段で抽出役が結果を返さずに止まった run の再開は、担当の作成をやり直す${mark(fn)}`, async (t) => {
    const s = await setupInspect(t);
    if (!s) return;
    const r1 = await runInspect(t, { env: s.env, args: inspectArgs(fn, s.target), scenario: { extract: async () => null } });
    assert.equal(r1.result.stoppedStage, '担当の作成');
    const r2 = await runInspect(t, { env: s.env, args: resumeArgs(r1.result) });
    assert.equal(r2.result.stopKind, 'complete', r2.result.reason);
    assert.equal(roles(r2.calls)[0], 'extract');
  });

  test(`SP-BPINSPECTION-030・SP-BPINSPECTION-029: 担当の組を書いた運搬役の応答を捨てて BLOCKED にした run を再開すると、抽出役を起動せず、担当の組が 1 組のまま${mark(fn)}`, async (t) => {
    const s = await setupInspect(t);
    if (!s) return;
    const r1 = await runInspect(t, { env: s.env, args: inspectArgs(fn, s.target), scenario: { carrier: partialCarrier(OPS.assignments, 2, (p) => p.includes('"groups"')) } });
    assert.equal(r1.result.stopKind, 'blocked');
    assert.equal(r1.result.stoppedStage, '担当の作成');
    const before = [...(await viewOf(s.env, r1.result.state)).assignments.values()].filter((a) => a.stage === 'assign');
    assert.equal(before.length, 2);
    const r2 = await runInspect(t, { env: s.env, args: resumeArgs(r1.result) });
    assert.equal(r2.result.stopKind, 'complete', r2.result.reason);
    assert.ok(!roles(r2.calls).includes('extract'));
    const after = [...(await viewOf(s.env, r1.result.state)).assignments.values()].filter((a) => a.stage === 'assign');
    assert.deepEqual(after, before);
  });

  if (fn === 'review') {
    test(`SP-BPINSPECTION-030・SP-BPINSPECTION-029: 適用の判定の段で検証役が結果を返さずに止まった run の再開は適用の判定をやり直し、結果を書いた運搬役の応答を捨てて BLOCKED にした run の再開は適用の判定の検証役を起動しない${mark(fn)}`, async (t) => {
      const s = await setupInspect(t);
      if (!s) return;
      const r1 = await runInspect(t, { env: s.env, args: inspectArgs(fn, s.target), scenario: { applicability: async () => null } });
      assert.equal(r1.result.stoppedStage, '適用の判定');
      const r2 = await runInspect(t, { env: s.env, args: resumeArgs(r1.result) });
      assert.equal(r2.result.stopKind, 'complete', r2.result.reason);
      assert.deepEqual([...new Set(roles(r2.calls))].slice(0, 2), ['applicability', 'verify']);
      const s2 = await setupInspect(t);
      const r3 = await runInspect(t, { env: s2.env, args: inspectArgs(fn, s2.target), scenario: { carrier: partialCarrier(OPS.applicability, 2) } });
      assert.equal(r3.result.stopKind, 'blocked');
      const r4 = await runInspect(t, { env: s2.env, args: resumeArgs(r3.result) });
      assert.equal(r4.result.stopKind, 'complete', r4.result.reason);
      assert.ok(!roles(r4.calls).includes('applicability') && !roles(r4.calls).includes('extract'));
      assert.equal((await viewOf(s2.env, r3.result.state)).rejected.length, 0);
    });
  }

  test(`SP-BPINSPECTION-030・SP-BPRUN-018: 観点ごとの検証の段で止まった run の再開は、担当と適用の判定を作り直さず未着手の項目だけを処理する${mark(fn)}`, async (t) => {
    const s = await setupInspect(t);
    if (!s) return;
    const r1 = await runInspect(t, { env: s.env, args: inspectArgs(fn, s.target), scenario: { carrier: loseItem(OPS.verdicts) } });
    assert.equal(r1.result.stoppedStage, '検証');
    const r2 = await runInspect(t, { env: s.env, args: resumeArgs(r1.result) });
    assert.equal(r2.result.stopKind, 'complete', r2.result.reason);
    assert.deepEqual([...new Set(roles(r2.calls))], ['verify']);
    const view = await viewOf(s.env, r1.result.state);
    assert.ok(itemsOf(view, 'verify').every((i) => i.result));
    assert.equal(itemsOf(view, 'verify').filter((i) => view.lineRuns.get(i.result.line) === 'r2').length, roles(r2.calls).length);
  });

  test(`SP-BPINSPECTION-030・SP-BPRUN-035: 追加の起動で止まった run の再開は、止まった部分の未着手の項目を破棄せずに処理し、skip 一覧が空になれば段を終える${mark(fn)}`, async (t) => {
    const s = await setupInspect(t);
    if (!s) return;
    const extract = async (prompt) => {
      const groups = (await inspectDefaults.extract(prompt)).groups;
      return { groups: groups.map((g) => g.slice(0, 1)) };
    };
    let lostItem = null;
    const carrier = async (prompt) => {
      if (!prompt.includes(' verdicts <<') || !prompt.includes('"viewpoint"')) return undefined;
      const item = /"item":"([^"]+)"/.exec(prompt)[1];
      if (!item.startsWith('verify-extra')) return undefined;
      lostItem = lostItem ?? item;
      return item === lostItem ? null : undefined;
    };
    const r1 = await runInspect(t, { env: s.env, args: inspectArgs(fn, s.target), scenario: { extract, carrier } });
    assert.equal(r1.result.stopKind, 'blocked');
    assert.equal(r1.result.stoppedStage, '追加の検証');
    const r2 = await runInspect(t, { env: s.env, args: resumeArgs(r1.result) });
    assert.equal(r2.result.stopKind, 'complete', r2.result.reason);
    const view = await viewOf(s.env, r1.result.state);
    assert.ok(view.items.get(lostItem).result);
    assert.equal(view.items.get(lostItem).discarded, null);
    assert.ok(roles(r2.calls).every((r) => r === 'verify' || r === 'refute'));
    assert.ok(r2.calls.some((c) => c.label.endsWith(':extra')));
    assert.deepEqual(r2.result.ledger.skip.map((x) => x.assets.length), VIEWPOINTS[fn].map(() => 0));
  });

  test(`SP-BPINSPECTION-030: 反証の段で止まった run の再開は、未着手の鍵だけを処理する${mark(fn)}`, async (t) => {
    const s = await setupInspect(t);
    if (!s) return;
    const verify = candidateVerifier({ viewpoint: VIEWPOINTS[fn][0] });
    const r1 = await runInspect(t, { env: s.env, args: inspectArgs(fn, s.target), scenario: { verify, carrier: loseItem(OPS.refutation) } });
    assert.equal(r1.result.stoppedStage, '反証');
    const v1 = await viewOf(s.env, r1.result.state);
    const pending = itemsOf(v1, 'refute').filter((i) => !i.result).length;
    assert.ok(pending >= 1);
    const r2 = await runInspect(t, { env: s.env, args: resumeArgs(r1.result) });
    assert.equal(r2.result.stopKind, 'complete', r2.result.reason);
    assert.deepEqual(roles(r2.calls), Array(pending).fill('refute'));
  });

  test(`SP-BPINSPECTION-030・SP-BPRUN-027: 停止の記録を書く運搬役が失敗して記録の無いまま照合と停止で止まった run の再開は、agent を起動せずにその段を最初から行う${mark(fn)}`, async (t) => {
    const s = await setupInspect(t);
    if (!s) return;
    const r1 = await runInspect(t, { env: s.env, args: inspectArgs(fn, s.target), scenario: { carrier: failCarrier(OPS.stop) } });
    assert.equal(r1.result.stopKind, 'blocked');
    assert.match(r1.result.reason, /停止の記録を書けなかった/);
    assert.equal((await viewOf(s.env, r1.result.state)).stops.size, 0);
    const r2 = await runInspect(t, { env: s.env, args: resumeArgs(r1.result) });
    assert.equal(r2.result.stopKind, 'complete', r2.result.reason);
    assert.deepEqual(roles(r2.calls), []);
  });

  test(`SP-BPINSPECTION-029: 停止中に照らす先を書き換えて再開すると、検証役も反証役も起動せず BLOCKED と食い違ったパスを返し、書き換えずに再開すると抽出役${fn === 'review' ? 'と適用の判定' : ''}が再び起動されない${mark(fn)}`, async (t) => {
    const s = await setupInspect(t);
    if (!s) return;
    const r1 = await runInspect(t, { env: s.env, args: inspectArgs(fn, s.target), scenario: { carrier: loseItem(OPS.verdicts) } });
    assert.equal(r1.result.stopKind, 'blocked');
    const r2 = await runInspect(t, { env: s.env, args: resumeArgs(r1.result) });
    assert.equal(r2.result.stopKind, 'complete', r2.result.reason);
    assert.ok(!roles(r2.calls).includes('extract') && !roles(r2.calls).includes('applicability'));
    const copy = path.join(s.base, 'prompt-audit.md');
    await fs.copyFile(s.env.promptAudit, copy);
    const s2 = await setupInspect(t, { promptAudit: copy });
    const r3 = await runInspect(t, { env: s2.env, args: inspectArgs(fn, s2.target), scenario: { carrier: loseItem(OPS.verdicts) } });
    assert.equal(r3.result.stopKind, 'blocked');
    const file = fn === 'review' ? path.join(s2.criteriaDir, 'design', 'skill-design-patterns.md') : copy;
    await fs.appendFile(file, '\n追記\n');
    const r4 = await runInspect(t, { env: s2.env, args: resumeArgs(r3.result) });
    assert.equal(r4.result.stopKind, 'blocked');
    assert.match(r4.result.reason, /照らす先が状態の指紋と食い違う/);
    assert.ok(r4.result.reason.includes(file));
    assert.deepEqual(roles(r4.calls), []);
  });

  test(`SP-BPINSPECTION-030・SP-BPFINDINGS-005: 台帳の作成と資産の束の段を終えた状態から、停止の間に節を 1 つ書き換えて再開すると、台帳が取り直され資産の束が書き直され、書き換えた資産が skip 一覧に戻る${mark(fn)}`, async (t) => {
    const s = await setupInspect(t);
    if (!s) return;
    const r1 = await runInspect(t, { env: s.env, args: inspectArgs(fn, s.target), scenario: { carrier: failCarrier(OPS.stop) } });
    const v1 = await viewOf(s.env, r1.result.state);
    assert.equal(v1.bundles.length, 1);
    const changed = [...v1.assets.values()].find((a) => JSON.stringify(a.loc).includes('手順'));
    await editFile(path.join(s.target.root, 'SKILL.md'), (x) => x.replace('手順の本文', '手順の本文を書き換えた'));
    const r2 = await runInspect(t, { env: s.env, args: resumeArgs(r1.result) });
    assert.equal(r2.result.stopKind, 'complete', r2.result.reason);
    const v2 = await viewOf(s.env, r1.result.state);
    assert.equal(v2.retakes, 1);
    assert.deepEqual(v2.bundles.map((b) => b.generation), [0, 1]);
    const bundle = await fs.readFile(path.join(s.env.root, 'states', r1.result.state, 'work', 'bundle.1.md'), 'utf8');
    assert.ok(bundle.includes('手順の本文を書き換えた'));
    // r1 は追加の起動の段を始める前に止まったので、r2 は追加の起動から続け、skip 一覧に戻った資産だけを担当にする。
    const extras = r2.calls.filter((c) => c.role !== 'carrier');
    assert.deepEqual(extras.map((c) => c.label), VIEWPOINTS[fn].map((v) => `verifier:${v}:extra`));
    for (const c of extras) assert.deepEqual(assetIds(c.prompt), [changed.id]);
  });

  test(`SP-BPFINDINGS-020・SP-BPFINDINGS-037・SP-BPINSPECTION-030: 停止の間に指摘のある節を消した run を再開すると、消えた資産の照合の段で検証役が指摘を台帳に作った順に起動され、状態が記録されず見直しの判定だけが記録され、照合の段で止まった run の再開はその回の未着手を処理する${mark(fn)}`, async (t) => {
    const s = await setupInspect(t);
    if (!s) return;
    const verify = candidateVerifier({ viewpoint: VIEWPOINTS[fn][0], asset: (ids) => ids.at(-1) });
    const r1 = await runInspect(t, { env: s.env, args: inspectArgs(fn, s.target), scenario: { verify, carrier: failCarrier(OPS.stop) } });
    const v1 = await viewOf(s.env, r1.result.state);
    const findings = [...v1.findings.values()].sort((a, b) => a.order - b.order);
    assert.ok(findings.length >= 2);
    await fs.writeFile(path.join(s.target.root, 'SKILL.md'), '---\nname: x\ndescription: d\n---\n# X\n');
    await fs.rm(path.join(s.target.root, 'scripts', 'x.js'));
    const r2 = await runInspect(t, { env: s.env, args: resumeArgs(r1.result), scenario: { carrier: loseItem(OPS.vanishMatch, 1) } });
    assert.equal(r2.result.stopKind, 'blocked');
    assert.equal(r2.result.stoppedStage, '消えた資産の照合');
    const vanishCalls = r2.calls.filter((c) => c.role === 'vanish');
    assert.deepEqual(vanishCalls.map((c) => /指摘 ID: (\S+)/.exec(c.prompt)[1]), findings.map((f) => f.id));
    const r3 = await runInspect(t, { env: s.env, args: resumeArgs(r2.result) });
    assert.equal(r3.result.stopKind, 'complete', r3.result.reason);
    assert.equal(r3.calls.filter((c) => c.role === 'vanish').length, 1);
    const v3 = await viewOf(s.env, r1.result.state);
    for (const f of findings) {
      const g = v3.findings.get(f.id);
      assert.equal(g.states.length, 1);
      assert.ok(g.judgements.some((j) => j.round.startsWith('vanish:')), f.id);
    }
  });
}
