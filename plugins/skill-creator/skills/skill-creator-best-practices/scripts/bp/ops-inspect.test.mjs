import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs, readFileSync } from 'node:fs';
import path from 'node:path';
import * as run from './ops-run.mjs';
import * as ledger from './ops-ledger.mjs';
import * as inspect from './ops-inspect.mjs';
import { outcome } from './ops-author.mjs';
import { CODES, FIXED_AUDIT_UNCHECKED, STATES_DIR } from './constants.mjs';
import { sha256Hex } from './ids.mjs';
import { readAll } from './journal.mjs';
import { buildView } from './view.mjs';
import { uncheckedViewpoints } from './unchecked.mjs';
import { CRITERIA_FIXTURE, LIMITS, PROMPT_AUDIT_FIXTURE, context, newKey, skillDir, tmpDir } from './fixtures/harness.mjs';

const FILES = { 'SKILL.md': '---\nname: x\n---\n# A\na\n# B\nb\n', 'scripts/x.js': 'x\n' };
const PA_ROWS = readFileSync(PROMPT_AUDIT_FIXTURE, 'utf8').split('\n').map((l) => /^(\d+)\. \*\*(.+?)\*\*/.exec(l)).filter(Boolean)
  .map((m) => `| PA-${m[1]} | ${m[1]}. ${m[2]} |`);

async function rejects(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code, error.reason);
    return true;
  });
}

async function viewOf(ctx, state) {
  return buildView(await readAll(path.join(ctx.stateRoot, STATES_DIR, state)));
}

async function edited(t, file, edit) {
  const dir = await tmpDir(t, 'bp-criteria-');
  await fs.cp(CRITERIA_FIXTURE, dir, { recursive: true });
  const target = path.join(dir, file);
  await fs.writeFile(target, edit(await fs.readFile(target, 'utf8')));
  return dir;
}

// fixture の SP-BPINSPECTION-009 の表は 2 行なので、prompt-audit の 6 項目と揃えた写しを作る（照合の不一致を既定にしない）。
async function sixRows(t, extra = (s) => s) {
  return edited(t, path.join('specifications', 'bp-inspection.md'), (s) => extra(s.replace(/\| PA-1 \|[^\n]*\n\| PA-2 \|[^\n]*/, PA_ROWS.join('\n'))));
}

async function begin(t, fn, { ctx: given, files = FILES } = {}) {
  const ctx = given ?? context(t);
  if (!ctx) return {};
  const root = await skillDir(t, files);
  const s = await run.start(ctx, { key: newKey(), function: fn, target: { root }, limits: LIMITS });
  const req = { state: s.state, run: s.run };
  await run.stageStart(ctx, { ...req, stage: 'targets', keys: [] });
  const targets = await inspect.targets(ctx, req);
  return { ctx, root, req, targets };
}

async function withLedger(t, fn, options) {
  const b = await begin(t, fn, options);
  if (!b.ctx) return {};
  const made = await ledger.ledgerCreate(b.ctx, b.req);
  return { ...b, assets: made.assets };
}

async function verifyItems(ctx, req, viewpoints) {
  const { assignments } = await ledger.assignments(ctx, { ...req, stage: 'verify', rule: 'all' });
  const { items } = await run.stageStart(ctx, { ...req, stage: 'verify', keys: viewpoints.map((viewpoint, i) => ({ viewpoint, group: viewpoints.indexOf(viewpoint) === i ? 1 : i + 1 })) });
  return { items, assignment: assignments[0] };
}

function judged(assets, extra = {}) {
  return { judgements: assets.map((a) => ({ asset: a.id, judgement: 'ok' })), candidates: [], unchecked: [], ...extra };
}

test('SP-BPINSPECTION-004: review の照らす先の決定が、観点ごとの照らす先のパスと指紋を状態に書き、読めた観点を run の観点の集合にする', async (t) => {
  const { ctx, req, targets } = await begin(t, 'review');
  if (!ctx) return;
  assert.equal(targets.blocked, null);
  assert.deepEqual(targets.viewpoints, ['flow', 'spec']);
  const spec = targets.targets.find((x) => x.viewpoint === 'spec');
  const file = path.join(CRITERIA_FIXTURE, 'specifications', 'bp-conformance.md');
  assert.deepEqual(spec.files, [{ path: file, sha256: sha256Hex(readFileSync(file)) }]);
  const view = await viewOf(ctx, req.state);
  assert.deepEqual(view.targets[0].targets.find((x) => x.viewpoint === 'spec').fingerprint, spec.fingerprint);
  assert.equal(view.stages.get('targets|').ended, true);
});

test('SP-BPINSPECTION-004・SP-BPINSPECTION-005・SP-BPINSPECTION-025: 「性能・容量」の章の見出しが無い写しでは仕様の観点が読めないと記録され、観点の集合がフローの観点だけになり、仕様の観点の全体が未検査に載る', async (t) => {
  const criteriaDir = await edited(t, path.join('specifications', 'bp-conformance.md'), (s) => s.replace('## 性能・容量（対象スキルに課す確定値）', '## 容量'));
  const ctx = context(t, { criteriaDir });
  if (!ctx) return;
  const { req, targets } = await begin(t, 'review', { ctx });
  assert.equal(targets.blocked, null);
  assert.deepEqual(targets.viewpoints, ['flow']);
  const spec = targets.targets.find((x) => x.viewpoint === 'spec');
  assert.equal(spec.readable, false);
  const view = await viewOf(ctx, req.state);
  const unchecked = uncheckedViewpoints(view).filter((u) => u.viewpoint === 'spec');
  assert.deepEqual(unchecked.map((u) => [u.scope, u.value, u.run]), [['whole', 'spec', req.run]]);
  assert.match(unchecked[0].reason, /bp-conformance\.md/);
});

test('SP-BPINSPECTION-027: フローの観点の照らす先を読めない review は blocked を返して照らす先の決定の段を終えない', async (t) => {
  const criteriaDir = await edited(t, path.join('specifications', 'bp-conformance.md'), (s) => s.replace('## 機能仕様', '## 機能'));
  const ctx = context(t, { criteriaDir });
  if (!ctx) return;
  const { req, targets } = await begin(t, 'review', { ctx });
  assert.match(targets.blocked.reason, /bp-conformance\.md/);
  const view = await viewOf(ctx, req.state);
  assert.equal(view.stages.get('targets|').ended, false);
});

test('SP-BPINSPECTION-027: prompt-audit を読めない audit は blocked を返す', async (t) => {
  const ctx = context(t, { criteriaDir: await sixRows(t), promptAudit: path.join(await tmpDir(t), 'none.md') });
  if (!ctx) return;
  const { targets } = await begin(t, 'audit', { ctx });
  assert.match(targets.blocked.reason, /none\.md/);
});

test('SP-BPINSPECTION-010・SP-BPINSPECTION-028: 項目を 1 つ足した prompt-audit の写しと、名前を 1 字変えた写しで照合が不一致になり、食い違った番号と名前を返す', async (t) => {
  const criteriaDir = await sixRows(t);
  const ok = context(t, { criteriaDir });
  if (!ok) return;
  assert.equal((await begin(t, 'audit', { ctx: ok })).targets.blocked, null);
  const text = readFileSync(PROMPT_AUDIT_FIXTURE, 'utf8');
  const dir = await tmpDir(t);
  const added = path.join(dir, 'added.md');
  await fs.writeFile(added, text.replace('6. **Stale internal guidance**', '6. **Stale internal guidance**: x\n7. **Extra**'));
  const renamed = path.join(dir, 'renamed.md');
  await fs.writeFile(renamed, text.replace('**Conflicting instructions**', '**Conflicting instruction**'));
  const a = await begin(t, 'audit', { ctx: context(t, { criteriaDir, promptAudit: added }) });
  assert.match(a.targets.blocked.reason, /7\. Extra/);
  const r = await begin(t, 'audit', { ctx: context(t, { criteriaDir, promptAudit: renamed }) });
  assert.match(r.targets.blocked.reason, /1\. Conflicting instruction"/);
});

test('SP-BPINSPECTION-029: 照らす先の決定の段を終えた後の照らす先の決定は書き込まず、照らす先を書き換えると食い違ったパスを返す', async (t) => {
  const criteriaDir = await edited(t, 'design/skill-design-patterns.md', (s) => s);
  const ctx = context(t, { criteriaDir });
  if (!ctx) return;
  const { req } = await begin(t, 'review', { ctx });
  const before = await readAll(path.join(ctx.stateRoot, STATES_DIR, req.state));
  const again = await inspect.targets(ctx, req);
  assert.equal(again.compared, true);
  assert.equal(again.blocked, null);
  const design = path.join(criteriaDir, 'design', 'skill-design-patterns.md');
  await fs.appendFile(design, '\n追記\n');
  const changed = await inspect.targets(ctx, req);
  assert.deepEqual(changed.blocked.paths, [design]);
  assert.deepEqual(await readAll(path.join(ctx.stateRoot, STATES_DIR, req.state)), before);
});

test('TBD-SBPRUN-001 の保持規則: 判定基準の写しが無いと照らす先の決定を理由つきの E_INPUT で拒否する', async (t) => {
  const ctx = context(t, { criteriaDir: path.join(await tmpDir(t), 'none') });
  if (!ctx) return;
  const root = await skillDir(t, FILES);
  const s = await run.start(ctx, { key: newKey(), function: 'review', target: { root }, limits: LIMITS });
  const req = { state: s.state, run: s.run };
  await run.stageStart(ctx, { ...req, stage: 'targets', keys: [] });
  await rejects(inspect.targets(ctx, req), CODES.input);
});

test('SP-BPINSPECTION-017: 資産の束が資産ごとの見出しと行番号つきの本文を持ち、同じ世代は同じ中身で、消したファイルは記録から書き直す', async (t) => {
  const { ctx, req, assets } = await withLedger(t, 'review');
  if (!ctx) return;
  const first = await inspect.bundle(ctx, req);
  assert.equal(first.generation, 0);
  assert.equal(first.assets, assets.length);
  const text = await fs.readFile(first.path, 'utf8');
  for (const a of assets) assert.ok(text.includes(`## ${a.id} ${a.path} `), a.id);
  assert.match(text, /\nL6: # B\nL7: b\n/);
  const again = await inspect.bundle(ctx, req);
  assert.equal(again.same, true);
  await fs.rm(first.path);
  await inspect.bundle(ctx, req);
  assert.equal(await fs.readFile(first.path, 'utf8'), text);
});

test('SP-BPINSPECTION-009: audit の検証役の結果で、PA-1〜PA-6 以外の指摘の種類を持つ候補を拒否する', async (t) => {
  const ctx = context(t, { criteriaDir: await sixRows(t) });
  if (!ctx) return;
  const { req, assets } = await withLedger(t, 'audit', { ctx });
  const { items, assignment } = await verifyItems(ctx, req, ['audit']);
  const cand = (kind) => judged(assets, { judgements: assets.map((a, i) => ({ asset: a.id, judgement: i === 0 ? 'candidate' : 'ok' })), candidates: [{ asset: assets[0].id, viewpoint: 'audit', kind, quote: 'L1', content: 'c', fix: 'f' }] });
  await rejects(ledger.verdicts(ctx, { ...req, item: items[0], assignment: assignment.id, viewpoint: 'audit', result: cand('PA-7') }), CODES.result);
  await rejects(ledger.verdicts(ctx, { ...req, item: items[0], assignment: assignment.id, viewpoint: 'audit', result: cand('SP-BPCONFORMANCE-027') }), CODES.result);
  const out = await ledger.verdicts(ctx, { ...req, item: items[0], assignment: assignment.id, viewpoint: 'audit', result: cand('PA-6') });
  assert.equal(out.refutationKeys.length, 1);
});

test('SP-BPINSPECTION-017: 未検査の観点の候補を足した結果を受理し、範囲が 3 種の外か観点が run の観点の集合に無い候補を含む結果と、欄の無い結果を拒否する', async (t) => {
  const { ctx, req, assets } = await withLedger(t, 'review');
  if (!ctx) return;
  const { items, assignment } = await verifyItems(ctx, req, ['flow', 'spec']);
  const send = (unchecked) => ledger.verdicts(ctx, { ...req, item: items[1], assignment: assignment.id, viewpoint: 'spec', result: judged(assets, { unchecked }) });
  await rejects(send([{ viewpoint: 'spec', scope: 'chapter', value: 'SP-BPCONFORMANCE-027', reason: 'r' }]), CODES.result);
  await rejects(send([{ viewpoint: 'audit', scope: 'pa', value: 'PA-1', reason: 'r' }]), CODES.result);
  await rejects(send([{ viewpoint: 'spec', scope: 'unit', value: 'SP-BPCONFORMANCE-099', reason: 'r' }]), CODES.result);
  await rejects(ledger.verdicts(ctx, { ...req, item: items[1], assignment: assignment.id, viewpoint: 'spec', result: { judgements: judged(assets).judgements, candidates: [] } }), CODES.result);
  const out = await send([{ viewpoint: 'spec', scope: 'unit', value: 'SP-BPCONFORMANCE-027', reason: '値を読めない' }]);
  assert.equal(out.seen, assets.length);
  const view = await viewOf(ctx, req.state);
  assert.equal(view.rejected.length, 4);
  assert.deepEqual(uncheckedViewpoints(view).filter((u) => u.viewpoint === 'spec').map((u) => [u.scope, u.value, u.reason]), [['unit', 'SP-BPCONFORMANCE-027', '値を読めない']]);
});

test('SP-BPINSPECTION-025: 未検査の観点の 5 つの場合を観点・範囲・理由・記録した run とともに作り、同じ未検査を 2 体が返すと 1 件にまとめる', async (t) => {
  const criteriaDir = await sixRows(t, (s) => s);
  const noSpec = await edited(t, path.join('specifications', 'bp-conformance.md'), (s) => s.replace('## 性能・容量（対象スキルに課す確定値）', '## 容量'));
  const review = await withLedger(t, 'review', { ctx: context(t, { criteriaDir: noSpec }) });
  if (!review.ctx) return;
  const r = await verifyItems(review.ctx, review.req, ['flow', 'flow']);
  const flowUnchecked = [{ viewpoint: 'flow', scope: 'unit', value: 'SP-BPCONFORMANCE-001', reason: '判定できない' }];
  await ledger.verdicts(review.ctx, { ...review.req, item: r.items[0], assignment: r.assignment.id, viewpoint: 'flow', result: judged(review.assets, { unchecked: flowUnchecked }) });
  await ledger.verdicts(review.ctx, { ...review.req, item: r.items[1], assignment: r.assignment.id, viewpoint: 'flow', result: judged(review.assets, { unchecked: flowUnchecked }) });
  const reviewList = uncheckedViewpoints(await viewOf(review.ctx, review.req.state));
  assert.deepEqual(reviewList.map((u) => [u.viewpoint, u.scope, u.value, u.run]), [['spec', 'whole', 'spec', 'r1'], ['flow', 'unit', 'SP-BPCONFORMANCE-001', 'r1']]);

  const actx = context(t, { criteriaDir });
  const audit = await withLedger(t, 'audit', { ctx: actx });
  const a = await verifyItems(actx, audit.req, ['audit']);
  const auditUnchecked = [
    { viewpoint: 'audit', scope: 'pa', value: 'PA-2', reason: 'PR-BPDESIGNEDSKILL-016 を優先した' },
    { viewpoint: 'audit', scope: 'pa', value: 'PA-4', reason: 'モデルの名指しが無い' },
  ];
  await ledger.verdicts(actx, { ...audit.req, item: a.items[0], assignment: a.assignment.id, viewpoint: 'audit', result: judged(audit.assets, { unchecked: auditUnchecked }) });
  const auditList = uncheckedViewpoints(await viewOf(actx, audit.req.state));
  assert.deepEqual(auditList.map((u) => [u.scope, u.value, u.reason]), [
    ['pa', 'PA-2', auditUnchecked[0].reason], ['pa', 'PA-4', auditUnchecked[1].reason], ['pa', FIXED_AUDIT_UNCHECKED.value, FIXED_AUDIT_UNCHECKED.reason],
  ]);

  const aborted = await withLedger(t, 'audit', { ctx: actx });
  const b = await verifyItems(actx, aborted.req, ['audit']);
  for (const attempt of [1, 2, 3]) await run.itemFail(actx, { ...aborted.req, item: b.items[0], attempt, reason: '検証役が結果を返さなかった' });
  const abortedList = uncheckedViewpoints(await viewOf(actx, aborted.req.state));
  assert.deepEqual(abortedList.filter((u) => u.scope === 'whole').map((u) => [u.viewpoint, u.value, u.run]), [['audit', 'audit', 'r1']]);
  assert.match(abortedList.find((u) => u.scope === 'whole').reason, /試行の上限/);
});

// 形がターンごとの指揮の行で PR-BPDESIGNEDSKILL-002 が強いられた未検査になる写し（fixture は反復型の 1 行だけを持つ）。
async function turnCriteria(t) {
  return edited(t, path.join('specifications', 'bp-conformance.md'), (s) => s
    .replace('PR-BPDESIGNEDSKILL-001 はどの行でも当たる。', 'PR-BPDESIGNEDSKILL-001・002 はどの行でも当たる。')
    .replace('| 固定集合の反復型 | 無 | 有 | 001 が当たる |', '| 固定集合の反復型 | 無 | 有 | 001 が当たる |\n| ターンごとの指揮 | 無 | 無 | 001 が当たる |')
    .replace('| PR-BPDESIGNEDSKILL-001 | SP-BPCONFORMANCE-010 | fixture | 未着手 |', '| PR-BPDESIGNEDSKILL-001 | SP-BPCONFORMANCE-010 | fixture | 未着手 |\n| PR-BPDESIGNEDSKILL-002 | SP-BPCONFORMANCE-001 | fixture | 未着手 |'));
}

function answers(asset, seq, ledgerAnswer = '無', fanout = '無') {
  const quotes = [{ asset, line: 1, text: '---' }];
  const [A, Q1, Q2, Q3] = seq;
  return { answers: { A: { answer: A, quotes }, Q1: { answer: Q1, quotes }, Q2: { answer: Q2, quotes }, Q3: { answer: Q3, quotes } }, ledger: { answer: ledgerAnswer, quotes }, fanout: { answer: fanout, quotes } };
}

test('SP-BPINSPECTION-006・SP-BPFINDINGS-034: 適用の判定が閉集合の外の答え・台帳に無い資産 ID・図の道と合わない並びを拒否の記録とともに拒み、受理した結果から形と行を決め、送り直しは最初の結果とだけ照らす', async (t) => {
  const { ctx, req, assets } = await withLedger(t, 'review');
  if (!ctx) return;
  await run.stageStart(ctx, { ...req, stage: 'applicability', keys: [] });
  const id = assets[0].id;
  const send = (n, result) => inspect.applicability(ctx, { ...req, n, result });
  await rejects(send(1, answers(id, ['たぶん', '問いに到達しない', '問いに到達しない', '問いに到達しない'])), CODES.result);
  await rejects(send(2, answers('ANOPE', ['はい', 'いいえ', 'はい', '問いに到達しない'], '無', '有')), CODES.result);
  await rejects(send(3, answers(id, ['はい', 'はい', 'はい', '問いに到達しない'], '無', '有')), CODES.result);
  const good = answers(id, ['はい', 'いいえ', 'はい', '問いに到達しない'], '無', '有');
  const out = await send(4, good);
  assert.equal(out.shape, '固定集合の反復型');
  assert.equal(out.row, 1);
  assert.ok(!out.units.some((u) => u.value === 'SP-BPCONFORMANCE-010/目標の固定/t2/r3'));
  const view = await viewOf(ctx, req.state);
  assert.equal(view.rejected.length, 3);
  assert.equal(view.stages.get('applicability|').ended, true);
  assert.equal((await send(4, good)).same, true);
  await rejects(send(5, answers(id, ['いいえ', '問いに到達しない', '問いに到達しない', '問いに到達しない'])), CODES.conflict);
});

test('SP-BPINSPECTION-025・SP-BPINSPECTION-007: 形がターンごとの指揮の適用の判定で、強いられた未検査の単位の候補を拒否し、その単位が SP-BPCONFORMANCE-006 を理由に未検査の観点に載る', async (t) => {
  const ctx = context(t, { criteriaDir: await turnCriteria(t) });
  if (!ctx) return;
  const { req, assets } = await withLedger(t, 'review', { ctx });
  await run.stageStart(ctx, { ...req, stage: 'applicability', keys: [] });
  const out = await inspect.applicability(ctx, { ...req, n: 1, result: answers(assets[0].id, ['いいえ', '問いに到達しない', '問いに到達しない', '問いに到達しない']) });
  assert.equal(out.shape, 'ターンごとの指揮');
  assert.deepEqual(out.forced, ['SP-BPCONFORMANCE-001']);
  const { items, assignment } = await verifyItems(ctx, req, ['flow']);
  const cand = { judgements: assets.map((a, i) => ({ asset: a.id, judgement: i === 0 ? 'candidate' : 'ok' })), candidates: [{ asset: assets[0].id, viewpoint: 'flow', kind: 'SP-BPCONFORMANCE-001', quote: 'L1', content: 'c', fix: 'f' }], unchecked: [] };
  await rejects(ledger.verdicts(ctx, { ...req, item: items[0], assignment: assignment.id, viewpoint: 'flow', result: cand }), CODES.result);
  await ledger.verdicts(ctx, { ...req, item: items[0], assignment: assignment.id, viewpoint: 'flow', result: judged(assets, { unchecked: [{ viewpoint: 'flow', scope: 'unit', value: 'SP-BPCONFORMANCE-001', reason: '検証役の理由' }] }) });
  const list = uncheckedViewpoints(await viewOf(ctx, req.state)).filter((u) => u.viewpoint === 'flow');
  assert.deepEqual(list.map((u) => [u.scope, u.value, u.reason]), [['unit', 'SP-BPCONFORMANCE-001', 'SP-BPCONFORMANCE-006']]);
});

test('SP-BPINSPECTION-007: review のフローの観点の閉集合から除く単位の表の単位を除き、create・update の適合の観点の閉集合には残す', async (t) => {
  const { ctx, req } = await begin(t, 'review');
  if (!ctx) return;
  const flow = await ledger.kinds(ctx, { state: req.state, viewpoint: 'flow' });
  assert.ok(!flow.kinds.some((k) => k.value === 'SP-BPCONFORMANCE-010/目標の固定/t2/r3'));
  const conformance = await ledger.kinds(ctx, { state: req.state, viewpoint: 'conformance' });
  assert.ok(conformance.kinds.some((k) => k.value === 'SP-BPCONFORMANCE-010/目標の固定/t2/r3'));
});

test('SP-BPINSPECTION-014・SP-BPINSPECTION-024: audit の完了の返り値が照らした先・未検査の観点・状態の今の対象スキルのパスの一覧を持ち、確度・declared_only・audit_header の鍵を持たない', async (t) => {
  const ctx = context(t, { criteriaDir: await sixRows(t) });
  if (!ctx) return;
  const { req, assets, root } = await withLedger(t, 'audit', { ctx });
  const { items, assignment } = await verifyItems(ctx, req, ['audit']);
  await ledger.verdicts(ctx, { ...req, item: items[0], assignment: assignment.id, viewpoint: 'audit', result: judged(assets) });
  await run.stop(ctx, { ...req, kind: 'complete', launches: 3, onTargetChanged: 'blocked' });
  const out = await outcome(ctx, { state: req.state });
  assert.equal(out.stopKind, 'complete');
  assert.deepEqual(out.target, { root, files: [] });
  assert.equal(out.targets[0].files[0].path, PROMPT_AUDIT_FIXTURE);
  assert.ok(out.uncheckedViewpoints.some((u) => u.value === FIXED_AUDIT_UNCHECKED.value));
  for (const k of ['confidence', 'declared_only', 'audit_header', 'declaredOnly', 'auditHeader']) assert.ok(!JSON.stringify(out).includes(`"${k}"`), k);
  assert.deepEqual(out.unverifiedRoleLimits.map((r) => r.role), ['検証役・反証役・抽出役', '運搬役']);
});

test('SP-BPINSPECTION-018・SP-BPAUTHORING-041: 反証に回す鍵を、候補を書いた順でなく、鍵の最初の候補を返した検証の項目の列挙の順（段は stages の順）に並べる', async (t) => {
  const { ctx, req, assets } = await withLedger(t, 'review');
  if (!ctx) return;
  const { items, assignment } = await verifyItems(ctx, req, ['flow', 'spec']);
  const cand = (asset, viewpoint, kind) => ({
    judgements: assets.map((a) => ({ asset: a.id, judgement: a.id === asset ? 'candidate' : 'ok' })),
    candidates: [{ asset, viewpoint, kind, quote: 'L1', content: 'c', fix: 'f' }],
    unchecked: [],
  });
  await ledger.verdicts(ctx, { ...req, item: items[1], assignment: assignment.id, viewpoint: 'spec', result: cand(assets[0].id, 'spec', 'SP-BPCONFORMANCE-027') });
  await ledger.verdicts(ctx, { ...req, item: items[0], assignment: assignment.id, viewpoint: 'flow', result: cand(assets[1].id, 'flow', 'SP-BPCONFORMANCE-001') });
  const { keys } = await ledger.refutationItems(ctx, { ...req, stages: [{ stage: 'verify', round: null }, { stage: 'verify-extra', round: null }] });
  assert.deepEqual(keys.map((k) => k.viewpoint), ['flow', 'spec']);
});
