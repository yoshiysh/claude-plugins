import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { newKey, setup, tmp } from './helpers/bp-harness.mjs';
import { readAll } from '../plugins/skill-creator/skills/skill-creator-best-practices/scripts/bp/journal.mjs';
import { buildView } from '../plugins/skill-creator/skills/skill-creator-best-practices/scripts/bp/view.mjs';
import { STATES_DIR } from '../plugins/skill-creator/skills/skill-creator-best-practices/scripts/bp/constants.mjs';
import { applicability } from '../plugins/skill-creator/skills/skill-creator-best-practices/scripts/bp/units.mjs';
import { LIMITS } from '../plugins/skill-creator/skills/skill-creator-best-practices/scripts/bp/fixtures/harness.mjs';

const REQUEST = '設定ファイルを整形するスキルを作る。対象は YAML だけ。';

async function begin(t, fn = 'create', { grounds, files } = {}) {
  const s = await setup(t, { fn, files });
  if (!s) return null;
  const body = { key: newKey(), function: fn, target: s.target, limits: LIMITS, ...(fn === 'create' ? { request: REQUEST } : { grounds: grounds ?? [{ kind: '利用者の指示', text: '短くする' }] }) };
  const st = await s.env.request('start', body);
  assert.equal(st.ok, true, st.reason);
  const req = { state: st.state, run: st.run };
  const w = (op, b = {}) => s.env.request(op, { ...req, ...b });
  return { ...s, st, req, w, body };
}

async function logOf(c) {
  return readAll(path.join(c.env.root, STATES_DIR, c.req.state));
}

function goal(sources, extra = {}) {
  return { deliverables: [{ text: '成果物', sources }], scope: [], prohibitions: [], numeric: [], deixis: [], ...extra };
}

async function goalItem(c, round = 1) {
  const out = await c.w('stage-start', { stage: 'goal', round, keys: [{ goal: round }] });
  return out.items[0];
}

test('SP-BPAUTHORING-007・SP-BPAUTHORING-006: 依頼文に無い引用を持つ要素を照合が通さず、通った目標は前提・項目の結果・段の終わりと同じ 1 行で書かれる', async (t) => {
  const c = await begin(t);
  if (!c) return;
  const item = await goalItem(c);
  const bad = await c.w('goal-check', { item, n: 1, goal: goal([{ kind: 'request', quote: '依頼文に無い' }]) });
  assert.equal(bad.passed, false);
  assert.match(bad.failures[0].reason, /依頼文に無い引用/);
  assert.deepEqual(bad.untilPass, { limit: 3, count: 1, sinceRunStart: 1, hit: false });
  const ok = await c.w('goal-check', { item, n: 2, goal: goal([{ kind: 'request', quote: 'YAML だけ' }]) });
  assert.equal(ok.passed, true);
  const lines = await logOf(c);
  assert.deepEqual(lines.at(-1).records.map((r) => r.t), ['repeat', 'premise', 'result', 'stageEnd']);
  assert.equal(lines.at(-1).records[1].kind, 'goal');
  const again = await c.w('goal-check', { item, n: 2, goal: goal([{ kind: 'request', quote: 'YAML だけ' }]) });
  assert.equal(again.same, true);
  const conflict = await c.w('goal-check', { item, n: 2, goal: goal([{ kind: 'request', quote: 'YAML' }]) });
  assert.equal(conflict.code, 'E_CONFLICT');
});

test('SP-BPAUTHORING-006・SP-BPAUTHORING-007: update で前提に無い記録 ID・dismissed の指摘の記録 ID を出所にした要素を通さず、修正の根拠のどれかを指さない目標を通さない', async (t) => {
  const grounds = [{ kind: '利用者の指示', text: '短くする' }, { id: 'F1', state: 'open' }, { id: 'F2', state: 'dismissed' }];
  const c = await begin(t, 'update', { grounds });
  if (!c) return;
  await c.w('stage-start', { stage: 'snapshot', keys: [] });
  await c.w('snapshot', {});
  const item = await goalItem(c);
  const unknown = await c.w('goal-check', { item, n: 1, goal: goal([{ kind: 'ground', ground: 'G9' }]) });
  assert.match(unknown.failures[0].reason, /前提に無い修正の根拠の記録 ID/);
  const dismissed = await c.w('goal-check', { item, n: 2, goal: goal([{ kind: 'ground', ground: 'G3' }]) });
  assert.match(dismissed.failures[0].reason, /修正の根拠として扱わない根拠の記録 ID: G3/);
  const partial = await c.w('goal-check', { item, n: 3, goal: goal([{ kind: 'ground', ground: 'G1' }]) });
  assert.deepEqual(partial.failures.map((f) => f.reason), ['修正の根拠 G2 を成果物か範囲の出所として指していない']);
  assert.equal(partial.untilPass.hit, true);
});

test('SP-BPAUTHORING-006: update の出所に写しのファイルからの逐語の引用が使え、写しに無い引用は通らない', async (t) => {
  const c = await begin(t, 'update');
  if (!c) return;
  await c.w('snapshot', {});
  const item = await goalItem(c);
  const bad = await c.w('goal-check', { item, n: 1, goal: goal([{ kind: 'snapshot', path: 'SKILL.md', quote: '無い文' }, { kind: 'ground', ground: 'G1' }]) });
  assert.equal(bad.passed, true);
  const req = await c.w('goal-check', { item, n: 2, goal: goal([{ kind: 'request', quote: 'x' }]) });
  assert.equal(req.code, 'E_CONFLICT');
  const c2 = await begin(t, 'update');
  await c2.w('snapshot', {});
  const item2 = await goalItem(c2);
  const only = await c2.w('goal-check', { item: item2, n: 1, goal: goal([{ kind: 'snapshot', path: 'SKILL.md', quote: '無い文' }], { scope: [{ text: 's', sources: [{ kind: 'ground', ground: 'G1' }] }] }) });
  assert.match(only.failures[0].reason, /写しの SKILL.md に無い引用/);
  const good = await c2.w('goal-check', { item: item2, n: 2, goal: goal([{ kind: 'snapshot', path: 'SKILL.md', quote: '本文' }], { scope: [{ text: 's', sources: [{ kind: 'ground', ground: 'G1' }] }] }) });
  assert.equal(good.passed, true);
});

test('SP-BPAUTHORING-004: 写しが最初の run でだけ作られ、写しの記録がある状態の再開で作り直されず、指紋の食い違いを出力する', async (t) => {
  const c = await begin(t, 'update');
  if (!c) return;
  const first = await c.w('snapshot', {});
  assert.equal(first.verified, true);
  const copied = path.join(first.dir, 'root', 'SKILL.md');
  assert.equal(await fs.readFile(copied, 'utf8'), await fs.readFile(path.join(c.target.root, 'SKILL.md'), 'utf8'));
  await fs.writeFile(path.join(c.target.root, 'SKILL.md'), '書き換えた\n');
  await c.w('stop', { kind: 'blocked', reason: 'x', pending: [], launches: 1 });
  const resumed = await c.env.request('start', { key: newKey(), state: c.req.state });
  const second = await c.env.request('snapshot', { state: c.req.state, run: resumed.run });
  assert.equal(second.same, true);
  assert.notEqual(await fs.readFile(copied, 'utf8'), '書き換えた\n');
  await fs.writeFile(copied, '壊した\n');
  const broken = await c.env.request('snapshot', { state: c.req.state, run: resumed.run });
  assert.equal(broken.code, 'E_CONFLICT');
  assert.deepEqual(broken.mismatched, ['SKILL.md']);
  const create = await begin(t);
  assert.equal((await create.w('snapshot', {})).code, 'E_INPUT');
});

test('SP-BPAUTHORING-036: 反復の番号だけが違う同じ段の項目が別の項目になり、新しい反復で前の回の結果を引き継がない', async (t) => {
  const c = await begin(t);
  if (!c) return;
  const one = await c.w('stage-start', { stage: 'verify', round: 1, keys: [{ viewpoint: 'conformance' }] });
  await c.w('item-fail', { item: one.items[0], attempt: 1, reason: 'x' });
  const two = await c.w('stage-start', { stage: 'verify', round: 2, keys: [{ viewpoint: 'conformance' }] });
  assert.notEqual(one.items[0], two.items[0]);
  assert.deepEqual(two.status[0], { id: two.items[0], attempts: 0, result: false, aborted: false, discarded: false });
  assert.equal((await c.w('stage-start', { stage: 'verify', round: 3, part: 1, keys: [] })).code, 'E_INPUT');
});

async function readyGate(c, number = 1) {
  await c.w('stage-start', { stage: 'write', round: number, keys: [{ iteration: number }] });
  await fs.mkdir(c.target.root, { recursive: true });
  await fs.writeFile(path.join(c.target.root, 'SKILL.md'), `---\nname: m\n---\n# M\n${number}\n`);
  await c.w('files', { entries: [{ path: path.join(c.target.root, 'SKILL.md'), iteration: number, action: 'write' }] });
  await c.w('paths-retake', { iteration: number });
  if (number === 1) await c.w('ledger-create', {});
  else await c.w('ledger-retake', {});
  await c.w('stage-start', { stage: 'gate', round: number, keys: [{ iteration: number }] });
}

test('SP-BPAUTHORING-024: 合否の段の項目の結果と反復の回数の +1 が 1 回の書き込みで書かれ、同じ書き込みを繰り返しても反復の回数が増えない', async (t) => {
  const c = await begin(t);
  if (!c) return;
  await readyGate(c);
  const before = (await logOf(c)).length;
  const g = await c.w('gate', { number: 1 });
  assert.equal(g.decision, 'unverifiable');
  const lines = await logOf(c);
  assert.equal(lines.length, before + 1);
  assert.deepEqual(lines.at(-1).records.map((r) => [r.t, r.iteration]), [['result', 1]]);
  const again = await c.w('gate', { number: 1 });
  assert.equal(again.same, true);
  assert.equal(buildView(await logOf(c)).iterations, 1);
  assert.deepEqual(again.iterations, g.iterations);
});

test('SP-BPAUTHORING-026: 合格の前の完了を拒否し、完了以外の停止の後に書いたファイルの一覧に検証を通った記録が無い', async (t) => {
  const c = await begin(t);
  if (!c) return;
  await readyGate(c);
  await c.w('gate', { number: 1 });
  const complete = await c.w('stop', { kind: 'complete', pending: [], launches: 3 });
  assert.equal(complete.code, 'E_CONFLICT');
  const blocked = await c.w('stop', { kind: 'blocked', reason: '検証が成り立たない', pending: [], launches: 3 });
  assert.equal(blocked.ok, true);
  const view = buildView(await logOf(c));
  assert.deepEqual(view.verified, []);
  assert.deepEqual(blocked.stop.unverified.map((f) => f.path), ['SKILL.md']);
});

test('SP-BPAUTHORING-015: パスの一覧の取り直しが解決できない callsite を行番号とともに記録し、同じ反復の送り直しは記録を足さない', async (t) => {
  const c = await begin(t);
  if (!c) return;
  await fs.mkdir(c.target.root, { recursive: true });
  await fs.writeFile(path.join(c.target.root, 'SKILL.md'), '# M\n\nWorkflow({ scriptPath: "scripts/none.js" })\n');
  const out = await c.w('paths-retake', { iteration: 1 });
  assert.deepEqual(out.unresolved.map((u) => u.line), [3]);
  const before = (await logOf(c)).length;
  const again = await c.w('paths-retake', { iteration: 1 });
  assert.equal(again.same, true);
  assert.equal((await logOf(c)).length, before);
  const lines = await logOf(c);
  assert.deepEqual(lines.at(-1).records.map((r) => [r.t, r.at ?? null]), [['paths', null], ['fingerprint', 'retake']]);
});

test('SP-BPAUTHORING-015: 書き手が結果を返さなかったとき、最後に記録した指紋と食い違う一覧の中のファイルを書いたか消したかの印とともに記録する', async (t) => {
  const c = await begin(t, 'update', { files: { 'SKILL.md': '# X\n', 'gone.md': '# G\n' } });
  if (!c) return;
  await fs.writeFile(path.join(c.target.root, 'SKILL.md'), '# 変えた\n');
  await fs.rm(path.join(c.target.root, 'gone.md'));
  await fs.writeFile(path.join(c.target.root, 'new.md'), '# N\n');
  const out = await c.w('files-scan', { iteration: 1 });
  assert.deepEqual(out.recorded, ['SKILL.md', 'gone.md', 'new.md']);
  const view = buildView(await logOf(c));
  assert.deepEqual(view.files.map((f) => [f.path, f.action]), [['SKILL.md', 'write'], ['gone.md', 'delete'], ['new.md', 'write']]);
});

test('SP-BPRUN-004・SP-BPRUN-015: 再開の開始が回答を run の開始と同じ 1 行で前提として書き、同じ key の送り直しで別の回答は拒否する', async (t) => {
  const c = await begin(t);
  if (!c) return;
  await c.w('stop', { kind: 'needs_input', reason: '問い', pending: [], launches: 2 });
  const key = newKey();
  const resumed = await c.env.request('start', { key, state: c.req.state, answer: 'YAML だけ' });
  const lines = await logOf(c);
  assert.deepEqual(lines.at(-1).records.slice(0, 2).map((r) => r.t), ['run', 'premise']);
  assert.deepEqual(resumed.progress.answers, [{ id: 'P1', text: 'YAML だけ' }]);
  assert.equal((await c.env.request('start', { key, state: c.req.state, answer: 'YAML だけ' })).same, true);
  assert.equal((await c.env.request('start', { key, state: c.req.state, answer: '別' })).code, 'E_CONFLICT');
});

async function criteriaUnits(c) {
  return applicability(c.env.criteriaDir);
}

async function verifyReady(c, viewpoint) {
  await readyGate(c);
  const { assignments } = await c.w('assignments', { stage: 'verify', rule: 'all' });
  const { items } = await c.w('stage-start', { stage: 'verify', round: 1, keys: [{ viewpoint }] });
  return { assignment: assignments[0], item: items[0] };
}

function judged(assignment) {
  return assignment.assets.map((asset) => ({ asset, judgement: 'ok' }));
}

test('SP-BPAUTHORING-017・SP-BPCONFORMANCE-001・SP-BPCONFORMANCE-018・SP-BPCONFORMANCE-038・SP-BPCONFORMANCE-020: create の適合の観点の結果で、判定の結果を付けていない単位・理由の無い未検査・不適合の単位に同じ結果の中に無い鍵を添えたもの・強いられた未検査でない単位の強いられた未検査・4 項目の並びでない残る危険を拒否し、理由つきの未検査を受ける', async (t) => {
  const c = await begin(t);
  if (!c) return;
  const { assignment, item } = await verifyReady(c, 'conformance');
  const row = (await criteriaUnits(c))[8];
  const base = () => ({ judgements: judged(assignment), candidates: [], applicability: { row: row.row }, residualRisks: [], units: row.units.map((u) => ({ unit: u.value, result: 'conform', reason: 'r' })) });
  const body = (result) => ({ item, assignment: assignment.id, viewpoint: 'conformance', result });
  const stray = base();
  stray.units[0] = { ...stray.units[0], result: 'nonconform', keys: [{ asset: assignment.assets[0], viewpoint: 'conformance', kind: 'x' }] };
  assert.match((await c.w('verdicts', body(stray))).reason, /同じ結果の中に無い候補の鍵/);
  const forced = base();
  const notForced = forced.units.find((u) => !row.forced.includes(u.unit));
  Object.assign(notForced, { result: 'unchecked', unchecked: 'forced' });
  assert.match((await c.w('verdicts', body(forced))).reason, /強いられた未検査でない単位/);
  const lacking = base();
  delete lacking.residualRisks;
  assert.match((await c.w('verdicts', body(lacking))).reason, /欄が無い: residualRisks/);
  const missing = base();
  missing.units.pop();
  assert.match((await c.w('verdicts', body(missing))).reason, /判定の結果を付けていない単位/);
  const silent = base();
  Object.assign(silent.units.find((u) => !row.forced.includes(u.unit)), { result: 'unchecked', unchecked: 'unforced', reason: '' });
  assert.match((await c.w('verdicts', body(silent))).reason, /未検査の単位に理由が無い/);
  for (const risk of [{ role: '書き手', restriction: 'r', reason: 'x' }, { role: '書き手', restriction: 'r', host: '', reason: 'x' }]) {
    const partial = base();
    partial.residualRisks = [risk];
    assert.match((await c.w('verdicts', body(partial))).reason, /residualRisks は \{role, restriction, host, reason\} の並びでなければならない/);
  }
  const ok = base();
  const f = ok.units.find((u) => row.forced.includes(u.unit));
  Object.assign(f, { result: 'unchecked', unchecked: 'forced' });
  const unforced = ok.units.find((u) => !row.forced.includes(u.unit));
  Object.assign(unforced, { result: 'unchecked', unchecked: 'unforced', reason: '当たる記述が対象スキルに無い' });
  const accepted = await c.w('verdicts', body(ok));
  assert.equal(accepted.ok, true, accepted.reason);
  const view = buildView(await logOf(c));
  assert.equal(view.extras.get(item).data.units.length, row.units.length);
  assert.deepEqual(view.extras.get(item).data.units.find((u) => u.unit === unforced.unit), unforced);
  assert.equal(view.rejected.length, 7);
});

test('SP-BPAUTHORING-038・SP-BPAUTHORING-039: 基準が求めた制約の仕様項目 ID と、契約の変化に選んだ記録 ID・仕様項目 ID を照らし、当たらなければ拒否する', async (t) => {
  const c = await begin(t, 'update', { grounds: [{ kind: '利用者の指示', text: 'a' }, { id: 'F1', state: 'dismissed' }] });
  if (!c) return;
  const g = await verifyReady(c, 'goal');
  const body = (result, x = g, viewpoint = 'goal') => ({ item: x.item, assignment: x.assignment.id, viewpoint, result });
  const basis = (sp) => ({ judgements: judged(g.assignment), candidates: [], basisConstraints: [{ asset: g.assignment.assets[0], sp }] });
  assert.match((await c.w('verdicts', body({ judgements: judged(g.assignment), candidates: [] }))).reason, /欄が無い: basisConstraints/);
  assert.match((await c.w('verdicts', body(basis('SP-BPCONFORMANCE-999')))).reason, /bp-conformance の写しに無い/);
  assert.equal((await c.w('verdicts', body(basis('SP-BPCONFORMANCE-027')))).ok, true);
  const { items } = await c.w('stage-start', { stage: 'verify', round: 2, keys: [{ viewpoint: 'contract' }] });
  const k = { item: items[0], assignment: g.assignment };
  const change = (choice, candidates = []) => ({ judgements: judged(g.assignment), candidates, contractChanges: [{ element: '出力', change: 'c', choice }] });
  assert.match((await c.w('verdicts', body({ judgements: judged(g.assignment), candidates: [] }, k, 'contract'))).reason, /欄が無い: contractChanges/);
  assert.match((await c.w('verdicts', body(change('G2'), k, 'contract'))).reason, /渡した修正の根拠の記録 ID でも/);
  assert.match((await c.w('verdicts', body(change('none'), k, 'contract'))).reason, /「該当なし」の変化に、その要素の指摘の種類の候補が無い/);
  assert.equal((await c.w('verdicts', body(change('G1'), k, 'contract'))).ok, true);
});

test('SP-BPENTRY-022・SP-BPENTRY-006: name と scriptPath の callsite を持つ対象スキルで、パスの一覧の作成が同じ入力に同じ一覧を返し、解決できない callsite を行番号とともに返す', async (t) => {
  const base = await tmp(t, 'bp-plugin-');
  const plugin = path.join(base, 'p');
  await fs.mkdir(path.join(plugin, '.claude-plugin'), { recursive: true });
  await fs.writeFile(path.join(plugin, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'p' }));
  await fs.mkdir(path.join(plugin, 'workflows'), { recursive: true });
  await fs.writeFile(path.join(plugin, 'workflows', 'flow.js'), "export const meta = {\n  name: 'flow',\n  description: 'd',\n}\n");
  await fs.writeFile(path.join(plugin, 'workflows', 'other.js'), "export const meta = {\n  name: 'other',\n  description: 'd',\n}\n");
  const skill = path.join(plugin, 'skills', 's');
  await fs.mkdir(path.join(skill, 'scripts'), { recursive: true });
  await fs.writeFile(path.join(skill, 'scripts', 'in.js'), 'x');
  await fs.writeFile(path.join(skill, 'SKILL.md'), [
    '# S',
    'Workflow({ name: "p:flow", args: { a: 1 } })',
    'Workflow({ scriptPath: "[SKILL_DIR]/../../workflows/other.js" })',
    'Workflow({ scriptPath: "scripts/in.js" })',
    'Workflow({ name: "p:missing" })',
    'Workflow({ name: "q:elsewhere" })',
    'Workflow({ scriptPath: `${dir}/x.js` })',
    '',
  ].join('\n'));
  const s = await setup(t);
  if (!s) return;
  const first = await s.env.request('paths', { root: skill });
  const second = await s.env.request('paths', { root: skill });
  assert.equal(first.plugin, 'p');
  assert.deepEqual(first.files, [path.join(plugin, 'workflows', 'flow.js'), path.join(plugin, 'workflows', 'other.js')].sort());
  assert.deepEqual(first.unresolved.map((u) => u.line), [5, 7]);
  assert.deepEqual({ ...second, sum: undefined }, { ...first, sum: undefined });
});

// 合否の導き方（keysVerdict・今の内容で判定したか・打ち切り）を状態から直接照らす。
async function gateWith(t, { refute, abort = false, rewrite = false }) {
  const c = await begin(t);
  if (!c) return null;
  const { assignment, item } = await verifyReady(c, 'conformance');
  const row = (await criteriaUnits(c))[8];
  const asset = assignment.assets[0];
  const { kinds } = await c.w('kinds', { viewpoint: 'conformance' });
  const key = { asset, viewpoint: 'conformance', kind: kinds[0].value };
  if (abort) {
    for (const attempt of [1, 2, 3]) await c.w('item-fail', { item, attempt, reason: 'x' });
  } else {
    const units = row.units.map((u) => ({ unit: u.value, result: row.forced.includes(u.value) ? 'unchecked' : 'conform', reason: 'r', ...(row.forced.includes(u.value) ? { unchecked: 'forced' } : {}) }));
    const target = units.find((u) => u.result === 'conform');
    Object.assign(target, { result: 'nonconform', keys: [key] });
    const out = await c.w('verdicts', { item, assignment: assignment.id, viewpoint: 'conformance', result: { judgements: assignment.assets.map((a) => ({ asset: a, judgement: a === asset ? 'candidate' : 'ok' })), candidates: [{ ...key, quote: 'q', content: 'c', fix: 'f' }], applicability: { row: row.row }, units, residualRisks: [] } });
    assert.equal(out.ok, true, out.reason);
    const { keys } = await c.w('refutation-items', { stages: [{ stage: 'verify', round: 1 }] });
    const ref = await c.w('stage-start', { stage: 'refute', round: 1, keys });
    if (refute !== undefined) await c.w('refutation', { item: ref.items[0], verdict: refute, reason: 'r', ...(refute === null ? { attempt: 1 } : {}) });
    if (rewrite) {
      await fs.writeFile(path.join(c.target.root, 'SKILL.md'), '---\nname: changed\n---\n# M\n書き換えた\n');
      await c.w('ledger-retake', {});
    }
    await c.w('review-judge', { stages: [{ stage: 'verify', round: 1 }] });
    return { g: await c.w('gate', { number: 1 }), unit: target.unit };
  }
  return { g: await c.w('gate', { number: 1 }) };
}

test('SP-BPAUTHORING-021・SP-BPAUTHORING-022: 合否は添えた鍵の指摘の合否から単位の結果を導く（維持なら不適合、却下なら適合、未反証なら強いられていない未検査）', async (t) => {
  const upheld = await gateWith(t, { refute: 'uphold' });
  if (!upheld) return;
  assert.equal(upheld.g.units.find((u) => u.unit === upheld.unit).result, 'nonconform');
  assert.equal(upheld.g.decision, 'unverifiable');
  const rejected = await gateWith(t, { refute: 'reject' });
  const r = rejected.g.units.find((u) => u.unit === rejected.unit);
  assert.equal(r.result, 'conform');
  assert.match(r.reason, /反証で退けられたか直った: F/);
  const unrefuted = await gateWith(t, { refute: null });
  assert.deepEqual(unrefuted.g.units.find((u) => u.unit === unrefuted.unit), { ...unrefuted.g.units.find((u) => u.unit === unrefuted.unit), result: 'unchecked', unchecked: 'unforced' });
  assert.equal(unrefuted.g.unverifiable.unrefuted.length, 1);
});

test('SP-BPAUTHORING-022・SP-BPFINDINGS-021: 却下した指摘の資産を判定の後に書き換えると、今の内容で判定していないので検証が成り立たない', async (t) => {
  const out = await gateWith(t, { refute: 'reject', rewrite: true });
  if (!out) return;
  const f = out.g.findings[0];
  assert.deepEqual([f.run, f.state, f.onCurrent, f.result], ['current', 'dismissed', false, 'unverifiable']);
  assert.ok(out.g.unverifiable.findings.includes(f.id));
});

test('SP-BPAUTHORING-021: 適合の観点の検証役の項目が打ち切りになると、単位の一覧を空にして打ち切った項目 ID を載せ、検証が成り立たない', async (t) => {
  const out = await gateWith(t, { abort: true });
  if (!out) return;
  assert.deepEqual(out.g.units, []);
  assert.equal(out.g.unverifiable.aborted.length, 1);
  assert.match(out.g.unverifiable.aborted[0], /^verify\.1-/);
  assert.equal(out.g.decision, 'unverifiable');
});
