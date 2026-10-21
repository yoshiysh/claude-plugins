import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import * as run from './ops-run.mjs';
import * as ledger from './ops-ledger.mjs';
import { CODES, OUTCOMES, STATES_DIR } from './constants.mjs';
import { readAll } from './journal.mjs';
import { buildView } from './view.mjs';
import { LIMITS, context, skillDir } from './fixtures/harness.mjs';

const K1 = 'SP-BPCONFORMANCE-010/目標の固定/t2/r1';
const K2 = 'SP-BPCONFORMANCE-010/目標の固定/t2/r2';
const FOUR = { 'SKILL.md': '---\nname: x\n---\n# A\na\n# B\nb\n', 'scripts/x.js': 'x\n' };

async function rejects(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code, error.reason);
    return true;
  });
}

async function viewOf(ctx, state) {
  return buildView(await readAll(path.join(ctx.stateRoot, STATES_DIR, state)));
}

async function setup(t, { fn = 'update', files = FOUR, ctx: given } = {}) {
  const ctx = given ?? context(t);
  if (!ctx) return {};
  const root = await skillDir(t, files);
  const s = await run.start(ctx, { function: fn, target: { root }, limits: LIMITS, ...(fn === 'update' ? { grounds: [{ text: 'a' }] } : {}) });
  const req = { state: s.state, run: s.run };
  const made = await ledger.ledgerCreate(ctx, req);
  const byLoc = (name) => made.assets.find((a) => JSON.stringify(a.loc).includes(name) || a.path === name)?.id;
  return { ctx, root, req, assets: made.assets, byLoc };
}

async function verifyMany(ctx, req, { round = null, stage = 'verify', entries }) {
  const prepared = [];
  for (const e of entries) {
    const { assignments } = await ledger.assignments(ctx, { ...req, stage, ...(e.groups ? { groups: e.groups } : { rule: 'all' }) });
    prepared.push({ ...e, viewpoint: e.viewpoint ?? 'conformance', assignment: assignments[0] });
  }
  const { items } = await run.stageStart(ctx, { ...req, stage, round, keys: prepared.map((p, i) => ({ n: i, viewpoint: p.viewpoint, assignment: p.assignment.id })) });
  const outs = [];
  for (const [i, p] of prepared.entries()) {
    const out = await ledger.verdicts(ctx, { ...req, item: items[i], assignment: p.assignment.id, viewpoint: p.viewpoint, result: p.result ?? { judgements: p.judgements, candidates: p.candidates ?? [] } });
    outs.push({ ...out, item: items[i], assignment: p.assignment });
  }
  return outs;
}

async function verify(ctx, req, { round = null, stage = 'verify', ...entry }) {
  return (await verifyMany(ctx, req, { round, stage, entries: [entry] }))[0];
}

function cand(asset, kind = K1, viewpoint = 'conformance', quote = '引用 L1') {
  return { asset, viewpoint, kind, quote, content: '内容', fix: '直し方' };
}

function allJudged(assets, value, except = {}) {
  return assets.map((a) => ({ asset: a.id, judgement: except[a.id] ?? value }));
}

async function refuteAll(ctx, req, round, verdict, reason = '理由') {
  const { keys } = await ledger.refutationItems(ctx, { ...req, stages: [{ stage: 'verify', round }] });
  const { items } = await run.stageStart(ctx, { ...req, stage: 'refute', round, keys });
  const out = [];
  for (const item of items) out.push(await ledger.refutation(ctx, { ...req, item, verdict, reason }));
  return out;
}

test('SP-BPFINDINGS-001: ファイル 3 つの対象スキルで台帳を作り、全てのファイルの資産が列挙される', async (t) => {
  const { assets } = await setup(t, { files: { 'SKILL.md': '# A\n', 'references/r.md': '# R\n', 'scripts/s.js': 's\n' } });
  if (!assets) return;
  assert.deepEqual([...new Set(assets.map((a) => a.path))].sort(), ['SKILL.md', 'references/r.md', 'scripts/s.js']);
});

test('SP-BPFINDINGS-033: ファイルが 0 件の対象スキルで台帳の作成が理由つきで失敗する', async (t) => {
  const ctx = context(t);
  if (!ctx) return;
  const root = await skillDir(t, { 'SKILL.md': '' });
  const s = await run.start(ctx, { function: 'review', target: { root }, limits: LIMITS });
  await assert.rejects(ledger.ledgerCreate(ctx, { state: s.state, run: s.run }), (e) => e.code === CODES.input && /0 件/.test(e.reason));
  assert.equal((await viewOf(ctx, s.state)).ledger, null);
});

test('SP-BPFINDINGS-005: 変更・追加・削除・不変を 1 つずつ含む書き換えの後に列挙し直し、表の 4 行どおりの記録になる', async (t) => {
  const { ctx, req, root, byLoc } = await setup(t, { files: { 'SKILL.md': '# Keep\nk\n# Change\nc\n# Drop\nd\n' } });
  if (!ctx) return;
  await fs.writeFile(path.join(root, 'SKILL.md'), '# Keep\nk\n# Change\nC!\n# New\nn\n');
  const out = await ledger.ledgerRetake(ctx, req);
  assert.deepEqual(out.counts, { unchanged: 1, changed: 1, added: 1, gone: 1 });
  assert.deepEqual(out.gone.map((g) => g.id), [byLoc('Drop')]);
  const lines = await readAll(path.join(ctx.stateRoot, STATES_DIR, req.state));
  assert.deepEqual(lines.at(-1).records.map((r) => [r.t, r.id]), [
    ['digest', byLoc('Change')],
    ['asset', lines.at(-1).records[1].id],
    ['digest', lines.at(-1).records[1].id],
    ['gone', byLoc('Drop')],
  ]);
  assert.equal((await ledger.ledgerRetake(ctx, req)).retake, null);
});

test('SP-BPFINDINGS-006・SP-BPFINDINGS-034: 台帳に無い資産 ID を含む結果を拒否し、その担当の資産が skip 一覧に残り、拒否の件数と担当が状態に記録される', async (t) => {
  const { ctx, req, assets } = await setup(t);
  if (!ctx) return;
  await assert.rejects(
    verify(ctx, req, { judgements: [{ asset: 'ANOTINLEDGER', judgement: 'ok' }, ...allJudged(assets, 'ok')] }),
    (e) => e.code === CODES.result && /ANOTINLEDGER/.test(e.reason),
  );
  const rep = await ledger.report(ctx, { ...req, viewpoints: ['conformance'] });
  assert.equal(rep.skip[0].assets.length, assets.length);
  assert.equal(rep.rejected.count, 1);
  assert.equal(rep.rejected.by[0].assignment, 'Sverify1');
  await rejects(ledger.assignments(ctx, { ...req, stage: 'assign', groups: [[assets[0].id, 'ANOPE']] }), CODES.result);
  assert.equal((await ledger.report(ctx, { ...req, viewpoints: ['conformance'] })).rejected.count, 2);
});

test('SP-BPFINDINGS-034: 機能の文書が足した欄を持つ結果が、足した欄を理由に拒否されない', async (t) => {
  const { ctx, req, assets } = await setup(t);
  if (!ctx) return;
  const out = await verify(ctx, req, { result: { judgements: allJudged(assets, 'ok'), candidates: [], units: [{ unit: K1, result: '適合' }], uninspected: [] } });
  assert.equal(out.ok, assets.length);
});

test('SP-BPFINDINGS-008: 「判断できない」の資産にも「見た」が記録され、反証の結果を待たずに入る', async (t) => {
  const { ctx, req, assets } = await setup(t);
  if (!ctx) return;
  const out = await verify(ctx, req, { judgements: allJudged(assets, 'unsure', { [assets[0].id]: 'candidate' }), candidates: [cand(assets[0].id)] });
  assert.equal(out.seen, assets.length);
  const cov = (await ledger.report(ctx, { ...req, viewpoints: ['conformance'] })).coverage[0];
  assert.equal(cov.seen, assets.length);
});

test('SP-BPFINDINGS-009: 「確認済みで問題なし」が観点と担当の指紋の組とともに記録される', async (t) => {
  const { ctx, req, assets } = await setup(t);
  if (!ctx) return;
  const out = await verify(ctx, req, { judgements: allJudged(assets, 'ok') });
  const view = await viewOf(ctx, req.state);
  const ok = view.seen.filter((s) => s.value === 'ok');
  assert.equal(ok.length, assets.length);
  assert.ok(ok.every((s) => s.viewpoint === 'conformance' && s.fpset === out.assignment.fpset && /^[0-9a-f]{64}$/.test(s.fpset)));
});

test('SP-BPFINDINGS-010: 閉集合に無い指摘の種類を含む候補の記録が拒否される', async (t) => {
  const { ctx, req, assets } = await setup(t);
  if (!ctx) return;
  await rejects(verify(ctx, req, { judgements: allJudged(assets, 'ok', { [assets[0].id]: 'candidate' }), candidates: [cand(assets[0].id, 'SP-BPCONFORMANCE-999')] }), CODES.result);
});

test('SP-BPFINDINGS-010: 目標の観点・契約の観点・監査の観点の閉集合に無い指摘の種類を含む候補の記録が拒否される', async (t) => {
  const { ctx, req, assets } = await setup(t);
  if (!ctx) return;
  const a = assets[0].id;
  const j = allJudged(assets, 'ok', { [a]: 'candidate' });
  await rejects(verify(ctx, req, { round: 1, viewpoint: 'goal', judgements: j, candidates: [cand(a, '目標:無い種類', 'goal')] }), CODES.result);
  await rejects(verify(ctx, req, { round: 2, viewpoint: 'contract', judgements: j, candidates: [cand(a, '契約:無い種類', 'contract')] }), CODES.result);
  await rejects(verify(ctx, req, { round: 3, viewpoint: 'audit', judgements: j, candidates: [cand(a, 'PA-7', 'audit')] }), CODES.result);
  const ok = await verify(ctx, req, { viewpoint: 'goal', round: 4, judgements: j, candidates: [cand(a, '目標:修正の根拠の未反映', 'goal')] });
  assert.equal(ok.refutationKeys.length, 1);
});

test('SP-BPFINDINGS-010: 同じ資産に、同じ仕様項目の原則の表の別の行の違反を 2 件記録し、別の指摘になる', async (t) => {
  const { ctx, req, assets } = await setup(t);
  if (!ctx) return;
  const a = assets[0].id;
  await verify(ctx, req, { round: 1, judgements: allJudged(assets, 'ok', { [a]: 'candidate' }), candidates: [cand(a, K1), cand(a, K2)] });
  const made = await refuteAll(ctx, req, 1, 'uphold');
  assert.equal(new Set(made.map((m) => m.finding)).size, 2);
});

test('SP-BPFINDINGS-011・SP-BPFINDINGS-036: 引用と内容の文言だけが違う同じ鍵の候補 2 件が同じ指摘になり、観点だけが違う 2 件が別の指摘 ID になる', async (t) => {
  const { ctx, req, assets } = await setup(t);
  if (!ctx) return;
  const a = assets[0].id;
  const j = allJudged(assets, 'ok', { [a]: 'candidate' });
  await verifyMany(ctx, req, { round: 1, entries: [
    { judgements: j, candidates: [cand(a, K1, 'conformance', '言い方 1')] },
    { judgements: j, candidates: [{ ...cand(a, K1, 'conformance', '言い方 2'), content: '別の文言' }] },
    { viewpoint: 'flow', judgements: j, candidates: [cand(a, K1, 'flow')] },
  ] });
  const { keys } = await ledger.refutationItems(ctx, { ...req, stages: [{ stage: 'verify', round: 1 }] });
  assert.equal(keys.length, 2);
  const made = await refuteAll(ctx, req, 1, 'uphold');
  assert.equal(made.length, 2);
  assert.notEqual(made[0].finding, made[1].finding);
  assert.equal((await viewOf(ctx, req.state)).findings.size, 2);
});

test('SP-BPFINDINGS-011: 別の台帳 ID の台帳では指摘 ID が異なり、同じ台帳の再開の前後では一致する', async (t) => {
  const ctx = context(t);
  if (!ctx) return;
  const one = await setup(t, { ctx });
  const two = await setup(t, { ctx });
  const a1 = one.assets[0].id;
  const a2 = two.assets[0].id;
  assert.equal(a1, a2);
  for (const s of [one, two]) {
    await verify(ctx, s.req, { round: 1, judgements: allJudged(s.assets, 'ok', { [a1]: 'candidate' }), candidates: [cand(a1)] });
  }
  const f1 = (await refuteAll(ctx, one.req, 1, 'uphold'))[0].finding;
  const f2 = (await refuteAll(ctx, two.req, 1, 'uphold'))[0].finding;
  assert.notEqual(f1, f2);
  await fs.writeFile(path.join(one.root, 'SKILL.md'), '---\nname: y\n---\n# A\na\n# B\nb\n');
  const r2 = await run.start(ctx, { state: one.req.state });
  const req2 = { state: one.req.state, run: r2.run };
  assert.equal(r2.retake.counts.changed, 1);
  await verify(ctx, req2, { round: 2, judgements: allJudged(one.assets, 'ok', { [a1]: 'candidate' }), candidates: [cand(a1, K1, 'conformance', '再開後')] });
  const again = await refuteAll(ctx, req2, 2, 'uphold');
  assert.deepEqual(again.map((x) => [x.finding, x.created]), [[f1, false]]);
  assert.deepEqual([...(await viewOf(ctx, one.req.state)).findings.keys()], [f1]);
});

test('SP-BPFINDINGS-014: 表の 4 行の入力で記録を確かめる（維持は open、却下は dismissed と理由）', async (t) => {
  const { ctx, req, assets, root } = await setup(t);
  if (!ctx) return;
  const [a, b] = [assets[0].id, assets[1].id];
  await verify(ctx, req, { round: 1, judgements: allJudged(assets, 'ok', { [a]: 'candidate', [b]: 'candidate' }), candidates: [cand(a), cand(b)] });
  const { keys } = await ledger.refutationItems(ctx, { ...req, stages: [{ stage: 'verify', round: 1 }] });
  const { items } = await run.stageStart(ctx, { ...req, stage: 'refute', round: 1, keys });
  const kept = await ledger.refutation(ctx, { ...req, item: items[0], verdict: 'uphold', reason: '確かに' });
  const dropped = await ledger.refutation(ctx, { ...req, item: items[1], verdict: 'reject', reason: '誤読' });
  assert.equal(kept.state, 'open');
  assert.equal(dropped.state, 'dismissed');
  const view = await viewOf(ctx, req.state);
  assert.equal(view.findings.get(dropped.finding).states[0].reason, '誤読');
  await fs.writeFile(path.join(root, 'SKILL.md'), '---\nname: changed\n---\n# A\na2\n# B\nb\n');
  await ledger.ledgerRetake(ctx, req);
  await verify(ctx, req, { round: 2, judgements: allJudged(assets, 'ok', { [a]: 'candidate', [b]: 'candidate' }), candidates: [cand(a), cand(b)] });
  const r2 = await ledger.refutationItems(ctx, { ...req, stages: [{ stage: 'verify', round: 2 }] });
  const i2 = await run.stageStart(ctx, { ...req, stage: 'refute', round: 2, keys: r2.keys });
  const keptAgain = await ledger.refutation(ctx, { ...req, item: i2.items[0], verdict: 'uphold', reason: '二度目も確か' });
  const droppedAgain = await ledger.refutation(ctx, { ...req, item: i2.items[1], verdict: 'reject', reason: '二度目の却下' });
  assert.deepEqual([keptAgain.finding, keptAgain.created, droppedAgain.finding, droppedAgain.created], [kept.finding, false, dropped.finding, false]);
  const after = await viewOf(ctx, req.state);
  assert.equal(after.findings.size, 2);
  assert.deepEqual([after.refutes.get(i2.items[0]).verdict, after.refutes.get(i2.items[1]).reason], ['uphold', '二度目の却下']);
});

test('SP-BPFINDINGS-035: 同じ候補に 2 つの異なる反証の結果を記録させ、2 つ目が拒否される', async (t) => {
  const { ctx, req, assets } = await setup(t);
  if (!ctx) return;
  const a = assets[0].id;
  await verify(ctx, req, { round: 1, judgements: allJudged(assets, 'ok', { [a]: 'candidate' }), candidates: [cand(a)] });
  const { keys } = await ledger.refutationItems(ctx, { ...req, stages: [{ stage: 'verify', round: 1 }] });
  const { items } = await run.stageStart(ctx, { ...req, stage: 'refute', round: 1, keys });
  await ledger.refutation(ctx, { ...req, item: items[0], verdict: 'uphold', reason: 'x' });
  assert.equal((await ledger.refutation(ctx, { ...req, item: items[0], verdict: 'uphold', reason: 'x' })).same, true);
  await rejects(ledger.refutation(ctx, { ...req, item: items[0], verdict: 'reject', reason: 'y' }), CODES.conflict);
});

test('SP-BPFINDINGS-016: 書き換えない run の台帳に resolved を記録させ、拒否される', async (t) => {
  const { ctx, req, assets } = await setup(t, { fn: 'review' });
  if (!ctx) return;
  const a = assets[0].id;
  await verify(ctx, req, { viewpoint: 'flow', judgements: allJudged(assets, 'ok', { [a]: 'candidate' }), candidates: [cand(a, K1, 'flow')] });
  const { keys } = await ledger.refutationItems(ctx, { ...req, stages: [{ stage: 'verify', round: null }] });
  const { items } = await run.stageStart(ctx, { ...req, stage: 'refute', keys });
  const made = await ledger.refutation(ctx, { ...req, item: items[0], verdict: 'uphold', reason: 'x' });
  await rejects(ledger.reviewJudge(ctx, { ...req, stages: [{ stage: 'verify', round: null }] }), CODES.conflict);
  const v = await run.stageStart(ctx, { ...req, stage: 'vanish', keys: [{ finding: made.finding, gone: 1 }] });
  await rejects(ledger.vanishMatch(ctx, { ...req, item: v.items[0], choice: 'none' }), CODES.conflict);
  assert.deepEqual((await viewOf(ctx, req.state)).findings.get(made.finding).states.map((s) => s.state), ['open']);
});

async function openFinding(t, opts) {
  const s = await setup(t, opts);
  if (!s.ctx) return {};
  const a = s.assets[2].id;
  await verify(s.ctx, s.req, { round: 1, judgements: allJudged(s.assets, 'ok', { [a]: 'candidate' }), candidates: [cand(a)] });
  const [made] = await refuteAll(s.ctx, s.req, 1, 'uphold');
  return { ...s, a, finding: made.finding };
}

test('SP-BPFINDINGS-017: 状態の遷移の後に前の記録が残り、同じ書き込みの繰り返しで台帳が変わらない', async (t) => {
  const { ctx, req, assets, a, finding, root } = await openFinding(t);
  if (!ctx) return;
  await fs.writeFile(path.join(root, 'SKILL.md'), '---\nname: x\n---\n# A\nfixed\n# B\nfixed\n');
  await ledger.ledgerRetake(ctx, req);
  const fresh = (await viewOf(ctx, req.state));
  await verify(ctx, req, { round: 2, judgements: [...fresh.assets.values()].filter((x) => !x.gone).map((x) => ({ asset: x.id, judgement: 'ok' })) });
  const first = await ledger.reviewJudge(ctx, { ...req, stages: [{ stage: 'verify', round: 2 }], round: 2 });
  assert.equal(first.judgements.find((j) => j.finding === finding).state, 'resolved');
  const before = (await readAll(path.join(ctx.stateRoot, STATES_DIR, req.state))).length;
  await ledger.reviewJudge(ctx, { ...req, stages: [{ stage: 'verify', round: 2 }], round: 2 });
  assert.equal((await readAll(path.join(ctx.stateRoot, STATES_DIR, req.state))).length, before);
  const view = await viewOf(ctx, req.state);
  assert.deepEqual(view.findings.get(finding).states.map((s) => s.state), ['open', 'resolved']);
  assert.ok(assets && a);
});

test('SP-BPFINDINGS-018: 見直しの操作が段の結果から表の行を選ぶ（存在する・存在しない・判定できない・判定しない・重複）', async (t) => {
  const { ctx, req, root, finding, a } = await openFinding(t);
  if (!ctx) return;
  const current = async () => [...(await viewOf(ctx, req.state)).assets.values()].filter((x) => !x.gone);
  const judgeRound = (round) => ledger.reviewJudge(ctx, { ...req, stages: [{ stage: 'verify', round }], round });
  let out = await judgeRound(1);
  assert.equal(out.judgements[0].row, 2);
  await fs.writeFile(path.join(root, 'SKILL.md'), '---\nname: x\n---\n# A\na\n# B\nb2\n');
  await ledger.ledgerRetake(ctx, req);
  await verify(ctx, req, { round: 2, judgements: (await current()).map((x) => ({ asset: x.id, judgement: x.id === a ? 'candidate' : 'ok' })), candidates: [cand(a)] });
  await refuteAll(ctx, req, 2, 'uphold');
  out = await judgeRound(2);
  assert.deepEqual([out.judgements[0].row, out.judgements[0].state], [3, 'open']);
  await fs.writeFile(path.join(root, 'SKILL.md'), '---\nname: x\n---\n# A\na\n# B\nb3\n');
  await ledger.ledgerRetake(ctx, req);
  await verify(ctx, req, { round: 3, judgements: (await current()).map((x) => ({ asset: x.id, judgement: 'unsure' })) });
  out = await judgeRound(3);
  assert.deepEqual([out.judgements[0].row, out.judgements[0].value, out.judgements[0].state], [8, 'unknown', 'open']);
  await verify(ctx, req, { round: 4, judgements: (await current()).map((x) => ({ asset: x.id, judgement: 'ok' })) });
  out = await judgeRound(4);
  assert.deepEqual([out.judgements[0].row, out.judgements[0].state], [7, 'resolved']);
  assert.equal(finding, out.judgements[0].finding);
});

test('SP-BPFINDINGS-018: 却下された候補と同じ内容の候補が別の担当の指紋の組で返ると重複になり、dismissed が今の組とともに記録される', async (t) => {
  const s = await setup(t);
  if (!s.ctx) return;
  const { ctx, req, root, assets } = s;
  const y = assets[1].id;
  await verify(ctx, req, { round: 1, judgements: allJudged(assets, 'ok', { [y]: 'candidate' }), candidates: [cand(y)] });
  const [made] = await refuteAll(ctx, req, 1, 'reject');
  await fs.writeFile(path.join(root, 'scripts/x.js'), 'changed other\n');
  await ledger.ledgerRetake(ctx, req);
  const now = [...(await viewOf(ctx, req.state)).assets.values()].filter((x) => !x.gone);
  const second = await verify(ctx, req, { round: 2, judgements: now.map((x) => ({ asset: x.id, judgement: x.id === y ? 'candidate' : 'ok' })), candidates: [cand(y)] });
  assert.equal(second.duplicates, 1);
  const out = await ledger.reviewJudge(ctx, { ...req, stages: [{ stage: 'verify', round: 2 }], round: 2 });
  const j = out.judgements.find((x) => x.finding === made.finding);
  assert.deepEqual([j.row, j.value, j.state], [5, 'absent', 'dismissed']);
  const rep = await ledger.report(ctx, { ...req, viewpoints: ['conformance'] });
  assert.equal(rep.findings[0].judgedOnCurrent, true);
});

test('SP-BPFINDINGS-019: 前の run が open を記録した指摘に、再開した run で「存在しない」を与えると、状態が記録されず見直しの判定だけが記録される', async (t) => {
  const { ctx, req, root, finding } = await openFinding(t);
  if (!ctx) return;
  const r2 = await run.start(ctx, { state: req.state });
  const req2 = { state: req.state, run: r2.run };
  await fs.writeFile(path.join(root, 'SKILL.md'), '---\nname: x\n---\n# A\na\n# B\nfixed\n');
  await ledger.ledgerRetake(ctx, req2);
  const now = [...(await viewOf(ctx, req.state)).assets.values()].filter((x) => !x.gone);
  await verify(ctx, req2, { round: 2, judgements: now.map((x) => ({ asset: x.id, judgement: 'ok' })) });
  const out = await ledger.reviewJudge(ctx, { ...req2, stages: [{ stage: 'verify', round: 2 }], round: 2 });
  assert.deepEqual([out.judgements[0].recorded, out.judgements[0].value], ['judgement', 'absent']);
  const f = (await viewOf(ctx, req.state)).findings.get(finding);
  assert.deepEqual(f.states.map((s) => s.state), ['open']);
  assert.deepEqual(f.judgements.map((j) => [j.run, j.value]), [['r2', 'absent']]);
  const rep = await ledger.report(ctx, { ...req2, viewpoints: ['conformance'] });
  assert.equal(rep.findings[0].state, undefined);
  assert.deepEqual([rep.findings[0].stateRun, rep.findings[0].judgement], ['r1', 'absent']);
});

test('SP-BPFINDINGS-019: 内容の指紋も担当の指紋の組も最後の判定と同じ指摘に状態の記録も見直しの判定の記録も足されない', async (t) => {
  const { ctx, req, finding } = await openFinding(t);
  if (!ctx) return;
  const before = (await readAll(path.join(ctx.stateRoot, STATES_DIR, req.state))).length;
  const out = await ledger.reviewJudge(ctx, { ...req, stages: [{ stage: 'verify', round: 1 }], round: 1 });
  assert.deepEqual(out.judgements, [{ finding, value: 'skip', row: 2, recorded: 'none' }]);
  assert.equal((await readAll(path.join(ctx.stateRoot, STATES_DIR, req.state))).length, before);
});

test('SP-BPFINDINGS-037: 照合の検証役の資産 ID・「該当なし」・結果なしの 3 通りで、状態と資産の記録が正しい', async (t) => {
  for (const [choice, value, state] of [['asset', 'exists', 'open'], ['none', 'absent', 'resolved'], [null, 'unknown', 'open']]) {
    const { ctx, req, root, finding, a } = await openFinding(t);
    if (!ctx) return;
    await fs.writeFile(path.join(root, 'SKILL.md'), '---\nname: x\n---\n# A\na\n# Renamed\nb\n');
    const retake = await ledger.ledgerRetake(ctx, req);
    assert.deepEqual(retake.gone.map((g) => g.id), [a]);
    const { items } = await run.stageStart(ctx, { ...req, stage: 'vanish', keys: [{ finding, gone: retake.retake }] });
    const renamed = [...(await viewOf(ctx, req.state)).assets.values()].find((x) => JSON.stringify(x.loc).includes('Renamed')).id;
    const out = await ledger.vanishMatch(ctx, { ...req, item: items[0], choice: choice === 'asset' ? renamed : choice });
    assert.deepEqual([out.value, out.state], [value, state], String(choice));
    const f = (await viewOf(ctx, req.state)).findings.get(finding);
    assert.deepEqual(f.assets, choice === 'asset' ? [a, renamed] : [a]);
  }
});

test('SP-BPFINDINGS-037: 照合で資産を足した指摘は、足した資産の鍵の候補も同じ指摘として照合する', async (t) => {
  const { ctx, req, root, finding } = await openFinding(t);
  if (!ctx) return;
  await fs.writeFile(path.join(root, 'SKILL.md'), '---\nname: x\n---\n# A\na\n# Renamed\nb\n');
  const retake = await ledger.ledgerRetake(ctx, req);
  const { items } = await run.stageStart(ctx, { ...req, stage: 'vanish', keys: [{ finding, gone: retake.retake }] });
  const now = [...(await viewOf(ctx, req.state)).assets.values()].filter((x) => !x.gone);
  const renamed = now.find((x) => JSON.stringify(x.loc).includes('Renamed')).id;
  await ledger.vanishMatch(ctx, { ...req, item: items[0], choice: renamed });
  const out = await verify(ctx, req, { round: 2, judgements: now.map((x) => ({ asset: x.id, judgement: x.id === renamed ? 'candidate' : 'ok' })), candidates: [cand(renamed)] });
  assert.equal(out.duplicates, 1);
  assert.equal((await viewOf(ctx, req.state)).dups[0].finding, finding);
});

test('SP-BPFINDINGS-021: 最後の判定の後に資産を書き換え、見直さずに結果を作ると「今の内容で判定したか」が否になる', async (t) => {
  const { ctx, req, root } = await openFinding(t);
  if (!ctx) return;
  assert.equal((await ledger.report(ctx, { ...req, viewpoints: ['conformance'] })).findings[0].judgedOnCurrent, true);
  await fs.writeFile(path.join(root, 'SKILL.md'), '---\nname: x\n---\n# A\na\n# B\nrewritten\n');
  await ledger.ledgerRetake(ctx, req);
  assert.equal((await ledger.report(ctx, { ...req, viewpoints: ['conformance'] })).findings[0].judgedOnCurrent, false);
});

test('SP-BPFINDINGS-022: 資産 4 つのうち 3 つに「見た」を記録するとカバレッジが 3/4 になり、1 つを書き換えると 2/4 になる', async (t) => {
  const { ctx, req, root, assets } = await setup(t);
  if (!ctx) return;
  assert.equal(assets.length, 4);
  const three = assets.slice(0, 3).map((a) => a.id);
  await verify(ctx, req, { groups: [three], judgements: three.map((id) => ({ asset: id, judgement: 'ok' })) });
  assert.equal((await ledger.report(ctx, { ...req, viewpoints: ['conformance'] })).coverage[0].ratio, '3/4');
  await fs.writeFile(path.join(root, 'SKILL.md'), '---\nname: x\n---\n# A\nA!\n# B\nb\n');
  await ledger.ledgerRetake(ctx, req);
  assert.equal((await ledger.report(ctx, { ...req, viewpoints: ['conformance'] })).coverage[0].ratio, '2/4');
});

test('SP-BPFINDINGS-022・SP-BPFINDINGS-023: run の観点の集合に無い観点についてカバレッジと skip 一覧が作られず、「見た」が 0 件の資産が観点ごとの skip 一覧に載る', async (t) => {
  const { ctx, req, assets } = await setup(t);
  if (!ctx) return;
  const two = assets.slice(0, 2).map((a) => a.id);
  await verify(ctx, req, { groups: [two], judgements: two.map((id) => ({ asset: id, judgement: 'unsure' })) });
  const rep = await ledger.report(ctx, { ...req, viewpoints: ['conformance', 'goal'] });
  assert.deepEqual(rep.coverage.map((c) => c.viewpoint), ['conformance', 'goal']);
  assert.deepEqual(rep.skip[0].assets.map((a) => a.id), assets.slice(2).map((a) => a.id));
  assert.equal(rep.skip[1].assets.length, 4);
  assert.ok(rep.skip[0].assets.every((a) => a.path && a.loc));
  const only = await ledger.report(ctx, { ...req, viewpoints: ['goal'] });
  assert.deepEqual(only.coverage.map((c) => c.viewpoint), ['goal']);
});

test('SP-BPFINDINGS-024: 表の 5 行に当たる資産を 1 つずつ作り、結末を確かめる。「見た」だけと未反証だけの資産は「確認済みで問題なし」にならない', async (t) => {
  const { ctx, req, assets } = await setup(t, { files: { 'SKILL.md': '# A\na\n# B\nb\n# C\nc\n# D\nd\n# E\ne\n# F\nf\n' } });
  if (!ctx) return;
  const [open, dismissed, ok, seen, , unrefuted] = assets.map((a) => a.id);
  const five = [open, dismissed, ok, seen, unrefuted];
  await verify(ctx, req, {
    round: 1,
    groups: [five],
    judgements: [
      { asset: open, judgement: 'candidate' }, { asset: dismissed, judgement: 'candidate' }, { asset: ok, judgement: 'ok' },
      { asset: seen, judgement: 'unsure' }, { asset: unrefuted, judgement: 'candidate' },
    ],
    candidates: [cand(open), cand(dismissed), cand(unrefuted)],
  });
  const { keys } = await ledger.refutationItems(ctx, { ...req, stages: [{ stage: 'verify', round: 1 }] });
  const { items } = await run.stageStart(ctx, { ...req, stage: 'refute', round: 1, keys });
  await ledger.refutation(ctx, { ...req, item: items[0], verdict: 'uphold', reason: 'x' });
  await ledger.refutation(ctx, { ...req, item: items[1], verdict: 'reject', reason: 'y' });
  await ledger.refutation(ctx, { ...req, item: items[2], verdict: null });
  const rep = await ledger.report(ctx, { ...req, viewpoints: ['conformance'] });
  const of = (id) => rep.outcomes.find((o) => o.asset === id).outcome;
  assert.deepEqual(assets.map((a) => of(a.id)), [OUTCOMES.finding, OUTCOMES.dismissedOnly, OUTCOMES.ok, OUTCOMES.seenOnly, OUTCOMES.skip, OUTCOMES.seenOnly]);
  assert.deepEqual(rep.unrefuted.map((u) => u.key.asset), [unrefuted]);
});

test('SP-BPFINDINGS-015: 反証役が結果を返さなかった候補は、open にも dismissed にもならず未反証の候補になる', async (t) => {
  const { ctx, req, assets } = await setup(t);
  if (!ctx) return;
  const a = assets[0].id;
  await verify(ctx, req, { round: 1, judgements: allJudged(assets, 'ok', { [a]: 'candidate' }), candidates: [cand(a)] });
  const out = await refuteAll(ctx, req, 1, null);
  assert.deepEqual(out[0], { unrefuted: true, finding: null, created: false, state: null, same: false });
  assert.equal((await viewOf(ctx, req.state)).findings.size, 0);
});

test('SP-BPFINDINGS-026: 別の状態の台帳の指摘 ID を指定した状態の記録が拒否される', async (t) => {
  const ctx = context(t);
  if (!ctx) return;
  const one = await openFinding(t, { ctx });
  const two = await setup(t, { ctx });
  await rejects(run.stageStart(ctx, { ...two.req, stage: 'vanish', keys: [{ finding: one.finding, gone: 1 }] }), CODES.unknownId);
});

test('SP-BPFINDINGS-029: dismissed の指摘の結果に却下の理由が載る', async (t) => {
  const { ctx, req, assets } = await setup(t, { fn: 'review' });
  if (!ctx) return;
  const a = assets[0].id;
  await verify(ctx, req, { viewpoint: 'flow', judgements: allJudged(assets, 'ok', { [a]: 'candidate' }), candidates: [cand(a, K1, 'flow')] });
  const { keys } = await ledger.refutationItems(ctx, { ...req, stages: [{ stage: 'verify', round: null }] });
  const { items } = await run.stageStart(ctx, { ...req, stage: 'refute', keys });
  await ledger.refutation(ctx, { ...req, item: items[0], verdict: 'reject', reason: '基準の誤読' });
  const rep = await ledger.report(ctx, { ...req, viewpoints: ['flow'] });
  assert.deepEqual([rep.findings[0].state, rep.findings[0].dismissReason, rep.findings[0].stateRun, rep.findings[0].function], ['dismissed', '基準の誤読', 'r1', 'review']);
  for (const field of ['id', 'viewpoint', 'kind', 'assets', 'quote', 'content', 'fix', 'judgedOnCurrent']) assert.ok(field in rep.findings[0], field);
});

test('SP-BPFINDINGS-012: 同じ担当を 2 体が見て同じ鍵の候補を返すと、反証の項目は 1 つで、その結果が 2 件の候補の両方を覆う', async (t) => {
  const { ctx, req, assets } = await setup(t);
  if (!ctx) return;
  const a = assets[0].id;
  const { assignments } = await ledger.assignments(ctx, { ...req, stage: 'verify', rule: 'all' });
  const { items } = await run.stageStart(ctx, { ...req, stage: 'verify', round: 1, keys: [{ who: 1, assignment: assignments[0].id }, { who: 2, assignment: assignments[0].id }] });
  for (const item of items) {
    await ledger.verdicts(ctx, { ...req, item, assignment: assignments[0].id, viewpoint: 'conformance', result: { judgements: allJudged(assets, 'ok', { [a]: 'candidate' }), candidates: [cand(a)] } });
  }
  const { keys } = await ledger.refutationItems(ctx, { ...req, stages: [{ stage: 'verify', round: 1 }] });
  assert.equal(keys.length, 1);
});

test('SP-BPRUN-031: 台帳の書き込みの操作が SP-BPRUN-017 に反する書き込みを拒否し、状態が変わらない', async (t) => {
  const { ctx, req, assets } = await setup(t);
  if (!ctx) return;
  const a = assets[0].id;
  const { assignments } = await ledger.assignments(ctx, { ...req, stage: 'verify', rule: 'all' });
  const sid = assignments[0].id;
  const { items } = await run.stageStart(ctx, { ...req, stage: 'verify', round: 1, keys: [{ n: 1, assignment: sid }, { n: 2, assignment: sid }] });
  const result = { judgements: allJudged(assets, 'ok', { [a]: 'candidate' }), candidates: [cand(a)] };
  await ledger.verdicts(ctx, { ...req, item: items[0], assignment: sid, viewpoint: 'conformance', result });
  const { keys } = await ledger.refutationItems(ctx, { ...req, stages: [{ stage: 'verify', round: 1 }] });
  const refute = await run.stageStart(ctx, { ...req, stage: 'refute', round: 1, keys });
  await run.start(ctx, { state: req.state });
  const before = await readAll(path.join(ctx.stateRoot, STATES_DIR, req.state));
  const calls = {
    ledgerCreate: { ...req },
    ledgerRetake: { ...req },
    assignments: { ...req, stage: 'verify', rule: 'all' },
    verdicts: { ...req, item: items[1], assignment: sid, viewpoint: 'conformance', result },
    refutation: { ...req, item: refute.items[0], verdict: 'uphold', reason: 'x' },
    reviewJudge: { ...req, stages: [{ stage: 'verify', round: 1 }], round: 1 },
    vanishMatch: { ...req, item: refute.items[0], choice: 'none' },
  };
  for (const [name, body] of Object.entries(calls)) {
    await assert.rejects(ledger[name](ctx, body), (e) => e.code === CODES.staleRun && /現在の run ではない/.test(e.reason), name);
  }
  assert.deepEqual(await readAll(path.join(ctx.stateRoot, STATES_DIR, req.state)), before);
});
