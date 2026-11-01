import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import * as run from './ops-run.mjs';
import * as author from './ops-author.mjs';
import * as ledger from './ops-ledger.mjs';
import * as inspect from './ops-inspect.mjs';
import { placement } from './placement.mjs';
import { record } from './worklog.mjs';
import { CODES, STATES_DIR } from './constants.mjs';
import { readAll } from './journal.mjs';
import { buildView } from './view.mjs';
import { buildKinds, ignoredSettingsReadable } from './kinds.mjs';
import { applicability } from './units.mjs';
import { uncheckedViewpoints } from './unchecked.mjs';
import { CRITERIA_FIXTURE, LIMITS, REPO_ROOT, answersFor, context, newKey, skillDir, tmpDir } from './fixtures/harness.mjs';

// 実際の docs/ は一般規約（guidelines/documentation.md）と SP-BPCONFORMANCE-041 の網羅の理由を持つ判定基準の集合として読める。
const DOCS = path.join(REPO_ROOT, 'docs');
const TABLE = '| 判断点 | 硬い層へ置けない理由 |\n|---|---|\n';

async function rejects(promise, code, pattern) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code, error.reason);
    if (pattern) assert.match(error.reason, pattern);
    return true;
  });
}

async function viewOf(ctx, state) {
  return buildView(await readAll(path.join(ctx.stateRoot, STATES_DIR, state)));
}

async function create(t, extra = {}) {
  const ctx = context(t, { criteriaDir: DOCS, ...extra });
  if (!ctx) return {};
  const base = await tmpDir(t);
  const root = path.join(base, 'made');
  const s = await run.start(ctx, { host: 'native', key: newKey(), function: 'create', target: { root }, limits: LIMITS, request: '表を作るスキル' });
  return { ctx, root, req: { state: s.state, run: s.run } };
}

async function write(c, number, body) {
  const { items } = await run.stageStart(c.ctx, { ...c.req, stage: 'write', round: number, keys: [{ iteration: number }] });
  await fs.mkdir(c.root, { recursive: true });
  const text = `---\nname: m\n---\n# M\n${body}`;
  await fs.writeFile(path.join(c.root, 'SKILL.md'), text);
  await run.files(c.ctx, { ...c.req, entries: [{ path: path.join(c.root, 'SKILL.md'), iteration: number, action: 'write' }] });
  await run.itemResult(c.ctx, { ...c.req, item: items[0], result: { written: [], designNote: { path: 'SKILL.md', startLine: 4, endLine: text.replace(/\n$/, '').split('\n').length } } });
}

async function gateReady(c, number, body = `x\n${TABLE}`) {
  if (body !== null) await write(c, number, body);
  await author.pathsRetake(c.ctx, { ...c.req, iteration: number });
  if (number === 1) await ledger.ledgerCreate(c.ctx, c.req);
  else await ledger.ledgerRetake(c.ctx, c.req);
  await run.stageStart(c.ctx, { ...c.req, stage: 'gate', round: number, keys: [{ iteration: number }] });
}

test('SP-BPRUN-005・SP-BPRUN-031: start が host と開始の時刻 at を run の開始の記録に書き、native・codex 以外の host を E_INPUT で拒否する', async (t) => {
  const ctx = context(t, { now: new Date('2026-01-02T03:04:05.678Z') });
  if (!ctx) return;
  const root = await skillDir(t);
  for (const host of [undefined, 'other']) await rejects(run.start(ctx, { host, key: newKey(), function: 'review', target: { root }, limits: LIMITS }), CODES.input, /host/);
  const s = await run.start(ctx, { host: 'codex', key: newKey(), function: 'review', target: { root }, limits: LIMITS });
  const r1 = (await viewOf(ctx, s.state)).runs[0];
  assert.deepEqual([r1.host, r1.at], ['codex', '2026-01-02T03:04:05.678Z']);
  await run.stop(ctx, { state: s.state, run: s.run, kind: 'blocked', reason: 'x', launches: 1 });
  const r = await run.start(ctx, { host: 'native', key: newKey(), state: s.state });
  assert.equal((await viewOf(ctx, s.state)).runs.find((x) => x.id === r.run).host, 'native');
});

test('SP-BPRUN-042・SP-BPRUN-044: record が記録台帳の記録を log.jsonl に足し、同じ担当の同じ内容を 2 度足さず、再開した run の記録が前の run の記録を消さず書き換えない', async (t) => {
  const c = await create(t);
  if (!c.ctx) return;
  const entry = { role: '書き手', item: 'w1', attempt: 1, path: 'write-1.md', evidence: ['ev-1.txt'] };
  const out = await record(c.ctx, { ...c.req, ...entry });
  assert.equal(out.record.guidelines.sha256.length, 64);
  assert.equal(typeof out.record.guidelines.version, 'string');
  assert.equal((await record(c.ctx, { ...c.req, ...entry })).same, true);
  await rejects(record(c.ctx, { ...c.req, ...entry, path: 'other.md' }), CODES.conflict);
  const first = (await viewOf(c.ctx, c.req.state)).workLogs.map(({ seq, line, ...r }) => r);
  assert.equal(first.length, 1);
  await run.stop(c.ctx, { ...c.req, kind: 'blocked', reason: 'x', launches: 1 });
  const r2 = await run.start(c.ctx, { host: 'native', key: newKey(), state: c.req.state });
  await record(c.ctx, { state: c.req.state, run: r2.run, ...entry });
  const after = (await viewOf(c.ctx, c.req.state)).workLogs.map(({ seq, line, ...r }) => r);
  assert.deepEqual(after[0], first[0]);
  assert.deepEqual(after.map((w) => w.run), ['r1', 'r2']);
});

test('SP-BPRUN-045・SP-BPRUN-036: 一般規約の写しを消した作業場所で record が写しのパスを理由に E_INPUT で拒否し、閉集合を要する操作（units）も E_INPUT で拒否する', async (t) => {
  const dir = await tmpDir(t, 'bp-criteria-');
  await fs.cp(DOCS, dir, { recursive: true });
  await fs.rm(path.join(dir, 'guidelines'), { recursive: true });
  const c = await create(t, { criteriaDir: dir });
  if (!c.ctx) return;
  await rejects(record(c.ctx, { ...c.req, role: '書き手', attempt: 1, path: 'a.md' }), CODES.input, /一般規約の写しが無い.*guidelines/);
  await rejects(author.units(c.ctx), CODES.input, /guidelines/);
});

test('SP-BPRUN-045・SP-BPRUN-042: plugin の version を得られないと record が E_INPUT で拒否し、作業場所の外のパス・並びでない evidence・文字列でない item を拒否する', async (t) => {
  const c = await create(t);
  if (!c.ctx) return;
  const ok = { role: '書き手', attempt: 1, path: 'a.md' };
  await rejects(record({ ...c.ctx, pluginJson: path.join(c.root, 'none.json') }, { ...c.req, ...ok }), CODES.input, /version/);
  for (const bad of [{ path: '/abs.md' }, { path: '../x.md' }, { evidence: ['../e'] }, { evidence: 'e' }, { item: 3 }, { attempt: 0 }, { role: '' }]) {
    await rejects(record(c.ctx, { ...c.req, ...ok, ...bad }), CODES.input);
  }
});

test('SP-BPRUN-047: 結果を返さなかった担当の代わりの作業記録が、試行の失敗と停止と同じ 1 行で記録台帳に試行の番号つきで足される', async (t) => {
  const c = await create(t);
  if (!c.ctx) return;
  const { items } = await run.stageStart(c.ctx, { ...c.req, stage: 'verify', round: 1, keys: [{ viewpoint: 'goal' }] });
  const content = { stage: '検証', target: items[0], input: ['a.md'], failure: '結果を返さなかった', unconfirmed: [items[0]] };
  await run.itemFail(c.ctx, { ...c.req, item: items[0], attempt: 1, reason: 'x', substitute: { role: '検証役', content } });
  let lines = await readAll(path.join(c.ctx.stateRoot, STATES_DIR, c.req.state));
  assert.deepEqual(lines.at(-1).records.map((r) => r.t), ['fail', 'workLog']);
  assert.deepEqual([lines.at(-1).records[1].item, lines.at(-1).records[1].attempt, lines.at(-1).records[1].substitute, lines.at(-1).records[1].path], [items[0], 1, content, null]);
  await run.stop(c.ctx, { ...c.req, kind: 'blocked', reason: 'x', launches: 1, substitute: { role: '書き手', attempt: 1, content } });
  lines = await readAll(path.join(c.ctx.stateRoot, STATES_DIR, c.req.state));
  assert.ok(lines.at(-1).records.some((r) => r.t === 'workLog' && r.role === '書き手'));
  assert.ok(lines.at(-1).records.some((r) => r.t === 'stop'));
});

test('SP-BPRUN-046: interventions の answers は開始の操作が前提に書いた回答だけを数え、premise の操作の回答を数えない', async (t) => {
  const c = await create(t);
  if (!c.ctx) return;
  await run.premise(c.ctx, { ...c.req, kind: 'answer', text: '直接の回答' });
  const out = await run.stop(c.ctx, { ...c.req, kind: 'blocked', reason: 'x', launches: 1 });
  assert.equal(out.stop.performance.interventions.answers, 0);
});

test('SP-BPAUTHORING-034: 1 回目は missing で止まり、回答して再開し、出所の照合が上限まで通らずに止まった run の判断材料は、最後の回の failures から作る', async (t) => {
  const c = await create(t);
  if (!c.ctx) return;
  const first = (await run.stageStart(c.ctx, { ...c.req, stage: 'goal', round: 1, keys: [{ goal: 1 }] })).items[0];
  await author.goalCheck(c.ctx, { ...c.req, item: first, missing: [{ question: 'どれ', reason: 'r' }], impact: ['scope'] });
  await run.stop(c.ctx, { ...c.req, kind: 'needs_input', reason: 'q', launches: 1 });
  const one = await author.outcome(c.ctx, { state: c.req.state });
  assert.deepEqual([one.toDecide, one.impact], [[{ question: 'どれ', reason: 'r' }], ['scope']]);
  const r2 = await run.start(c.ctx, { host: 'native', key: newKey(), state: c.req.state, answer: '答え' });
  const req = { state: c.req.state, run: r2.run };
  const item = (await run.stageStart(c.ctx, { ...req, stage: 'goal', round: 2, keys: [{ goal: 2 }] })).items[0];
  const goal = { deliverables: [{ text: '無い', sources: [{ kind: 'request', quote: '依頼文に無い' }] }], scope: [], prohibitions: [], numeric: [], deixis: [] };
  let last;
  for (const n of [1, 2, 3]) last = await author.goalCheck(c.ctx, { ...req, item, n, goal });
  await run.stop(c.ctx, { ...req, kind: 'needs_input', reason: 'q', launches: 1 });
  const out = await author.outcome(c.ctx, { state: c.req.state });
  assert.deepEqual([out.toDecide, out.impact, out.verification], [last.failures, null, null]);
  assert.ok(Array.isArray(out.remainingWork));
});

test('SP-BPRUN-046: stop が performance を現在の run の分で書き、オブジェクトでない cost を E_INPUT で拒否し、cost の無い run は {unavailable: true, host} になる', async (t) => {
  const ctx = context(t, { now: new Date('2026-01-01T00:00:00.000Z') });
  if (!ctx) return;
  const root = await skillDir(t);
  const s = await run.start(ctx, { host: 'codex', key: newKey(), function: 'review', target: { root }, limits: LIMITS });
  const req = { state: s.state, run: s.run };
  for (const cost of [1, 'x', null, [1]]) await rejects(run.stop(ctx, { ...req, kind: 'blocked', reason: 'x', launches: 1, cost }), CODES.input, /cost/);
  await rejects(run.stop(ctx, { ...req, kind: 'blocked', reason: 'x', launches: 1, performance: {} }), CODES.input);
  const later = { ...ctx, now: new Date('2026-01-01T00:00:01.500Z') };
  const out = await run.stop(later, { ...req, kind: 'blocked', reason: 'x', launches: 1 });
  assert.equal(out.stop.at, '2026-01-01T00:00:01.500Z');
  assert.deepEqual(out.stop.performance, {
    durationMs: 1500, interventions: { answers: 0, resumes: 0 }, retries: { attempts: 0, iterations: 0, untilPass: {} }, cost: { unavailable: true, host: 'codex' },
  });
  const r2 = await run.start(ctx, { host: 'native', key: newKey(), state: s.state, answer: '回答' });
  const out2 = await run.stop(ctx, { state: s.state, run: r2.run, kind: 'blocked', reason: 'y', launches: 1, cost: { tokens: 5 } });
  assert.deepEqual(out2.stop.performance.interventions, { answers: 1, resumes: 1 });
  assert.deepEqual(out2.stop.performance.cost, { tokens: 5 });
});

test('SP-BPRUN-046: resumes が前の run 無し・needs_input か BLOCKED・それ以外の種類・停止の記録無しで 0・1・0・1 になり、untilPass が増えた段だけを鍵に持つ', async (t) => {
  const c = await create(t);
  if (!c.ctx) return;
  const stopOf = async (r, body) => (await run.stop(c.ctx, { state: c.req.state, run: r, launches: 1, ...body })).stop.performance;
  const resume = async () => (await run.start(c.ctx, { host: 'native', key: newKey(), state: c.req.state })).run;
  await run.stageRepeat(c.ctx, { ...c.req, stage: 'goal', n: 1, limitKey: 'untilPass' });
  const p1 = await stopOf('r1', { kind: 'needs_input', reason: 'q' });
  assert.deepEqual([p1.interventions.resumes, p1.retries.untilPass], [0, { goal: 1 }]);
  const r2 = await resume();
  const p2 = await stopOf(r2, { kind: 'iteration_limit', reason: 'l', limitHit: 'launch' });
  assert.deepEqual([p2.interventions.resumes, p2.retries.untilPass], [1, {}]);
  const r3 = await resume();
  const p3 = await stopOf(r3, { kind: 'blocked', reason: 'b' });
  assert.equal(p3.interventions.resumes, 0);
  await resume();
  const r5 = await resume();
  const p5 = await stopOf(r5, { kind: 'blocked', reason: 'b' });
  assert.equal(p5.interventions.resumes, 1);
});

test('SP-BPRUN-005・SP-BPRUN-031: goal-check が missing を受けて繰り返しの回数を増やさずに項目の結果と段の終わりを 1 行で書き、goal と missing の両方か形の誤った missing を拒否し、照合を通らない goal の繰り返しの記録が failures を持つ', async (t) => {
  const c = await create(t);
  if (!c.ctx) return;
  const { items } = await run.stageStart(c.ctx, { ...c.req, stage: 'goal', round: 1, keys: [{ goal: 1 }] });
  const goal = { deliverables: [{ text: '無い', sources: [{ kind: 'request', quote: '依頼文に無い' }] }], scope: [], prohibitions: [], numeric: [], deixis: [] };
  const failed = await author.goalCheck(c.ctx, { ...c.req, item: items[0], n: 1, goal });
  assert.equal(failed.passed, false);
  assert.deepEqual((await viewOf(c.ctx, c.req.state)).lastRepeats.get('goal').failures, failed.failures);
  assert.deepEqual(failed.failures.map((f) => [f.element, f.value]), [['deliverables', '無い']]);
  await rejects(author.goalCheck(c.ctx, { ...c.req, item: items[0], n: 2, goal, missing: [{ question: 'q', reason: 'r' }] }), CODES.input);
  await rejects(author.goalCheck(c.ctx, { ...c.req, item: items[0], n: 2 }), CODES.input);
  for (const [missing, impact] of [[[], undefined], [[{ question: '', reason: 'r' }], undefined], [[{ question: 'q', reason: 'r' }], ['scope', 'scope']], [[{ question: 'q', reason: 'r' }], ['other']]]) {
    await rejects(author.goalCheck(c.ctx, { ...c.req, item: items[0], missing, impact }), CODES.result);
  }
  const before = await readAll(path.join(c.ctx.stateRoot, STATES_DIR, c.req.state));
  await author.goalCheck(c.ctx, { ...c.req, item: items[0], missing: [{ question: 'どれを作るか', reason: '成果物が無い' }], impact: ['deliverables'] });
  const after = await readAll(path.join(c.ctx.stateRoot, STATES_DIR, c.req.state));
  assert.deepEqual(after.at(-1).records.map((r) => r.t), ['result', 'stageEnd']);
  assert.equal(after.length, before.length + 1);
  const view = await viewOf(c.ctx, c.req.state);
  assert.equal(view.repeats.get('goal'), 1);
  assert.deepEqual(view.items.get(items[0]).result.result, { missing: [{ question: 'どれを作るか', reason: '成果物が無い' }], impact: ['deliverables'] });
});

function formal(properties, readable = { ok: true }) {
  return { workRecord: 'formal-1.md', readable, properties };
}

test('SP-BPRUN-031・SP-BPAUTHORING-044: 形式検証の段の result で要らない reason の省略・null・文字列を受理し、要る reason の無い要素と 4 欄の外の欄を持つ要素を拒否し、段を通ったかと cause を判定表で返す', async (t) => {
  const c = await create(t);
  if (!c.ctx) return;
  const items = (await run.stageStart(c.ctx, { ...c.req, stage: 'formal', round: 1, keys: [1, 2, 3, 4, 5, 6, 7].map((n) => ({ n })) })).items;
  const send = (i, result) => run.itemResult(c.ctx, { ...c.req, item: items[i], result });
  const bad = [
    formal([{ target: 't', formalized: false, outcome: 'unconfirmed' }]),
    formal([{ target: 't', formalized: true, outcome: 'fails', reason: '' }]),
    formal([{ target: 't', formalized: true, outcome: 'holds', note: 'x' }]),
    formal([{ target: 't', formalized: true, outcome: 'confirmed' }]),
    { ...formal([]), extra: 1 },
    formal([], { ok: false }),
    formal([{ target: 't', formalized: true, outcome: 'holds' }], { ok: false, reason: 'r' }),
    { ...formal([]), workRecord: '/abs.md' },
  ];
  for (const r of bad) await rejects(send(0, r), CODES.result);
  assert.deepEqual(await send(0, formal([{ target: 'a', formalized: true, outcome: 'holds' }, { target: 'b', formalized: true, outcome: 'holds', reason: null }, { target: 'c', formalized: true, outcome: 'holds', reason: 'x' }, { target: 'd', formalized: false, outcome: 'unconfirmed', reason: 'r' }])).then((o) => [o.passed, o.cause]), [true, null]);
  assert.deepEqual(await send(1, formal([])).then((o) => [o.passed, o.cause]), [true, null]);
  assert.deepEqual(await send(2, formal([], { ok: false, reason: '読めない' })).then((o) => [o.passed, o.cause]), [false, 'formalUnrunnable']);
  assert.deepEqual(await send(3, formal([{ target: 'a', formalized: true, outcome: 'unrunnable', reason: '道具が無い' }])).then((o) => [o.passed, o.cause]), [false, 'formalUnrunnable']);
  assert.deepEqual(await send(4, formal([{ target: 'a', formalized: true, outcome: 'fails', reason: '反例' }])).then((o) => [o.passed, o.cause]), [false, 'formalFailed']);
  assert.deepEqual(await send(5, formal([{ target: 'a', formalized: true, outcome: 'fails', reason: '反例' }, { target: 'b', formalized: true, outcome: 'unrunnable', reason: 'x' }])).then((o) => [o.passed, o.cause]), [false, 'formalFailed']);
});

test('SP-BPRUN-031・SP-BPAUTHORING-021: placement が判断点の表の照合を状態に書き、同じ鍵の送り直しで記録が増えず、lines と reason が同じパスと行番号を持ち、placement の無い gate を E_INPUT で拒否する', async (t) => {
  const c = await create(t);
  if (!c.ctx) return;
  await rejects(placement(c.ctx, { ...c.req, iteration: 1 }), CODES.input, /書く段の結果/);
  await gateReady(c, 1, `x\n${TABLE}| 層 |  |\n| 層 | 理由 |\n| a | b | c |\n`);
  await rejects(author.gate(c.ctx, { ...c.req, number: 1 }), CODES.input, /placement/);
  const out = await placement(c.ctx, { ...c.req, iteration: 1 });
  assert.equal(out.result, 'nonconform');
  assert.deepEqual(out.lines, [{ path: 'SKILL.md', line: 8 }, { path: 'SKILL.md', line: 10 }]);
  for (const l of out.lines) assert.ok(out.reason.includes(`${l.path}:${l.line}`), out.reason);
  const again = await placement(c.ctx, { ...c.req, iteration: 1 });
  assert.equal(again.same, true);
  assert.equal((await viewOf(c.ctx, c.req.state)).placements.length, 1);
  const g = await author.gate(c.ctx, { ...c.req, number: 1 });
  assert.equal(g.decision, 'unverifiable');
});

test('SP-BPCONFORMANCE-041: 判定表の行ごとに見出し行 0・2 以上・区切り行無し・空のセル・適合（データ行 0 行とフェンスの中の例を含む）を照らす', async () => {
  const { judgePlacement } = await import('./placement.mjs');
  const range = (text, fenced = new Set()) => [{ path: 'S.md', lines: text.split('\n'), from: 1, fenced }];
  assert.deepEqual(judgePlacement(range('本文')).lines, []);
  assert.equal(judgePlacement(range('本文')).result, 'nonconform');
  assert.deepEqual(judgePlacement(range(`${TABLE}${TABLE}`)).lines.map((l) => l.line), [1, 3]);
  assert.deepEqual(judgePlacement(range('| 判断点 | 硬い層へ置けない理由 |\n本文')).lines.map((l) => l.line), [1]);
  assert.equal(judgePlacement(range(`${TABLE}| a \\| b | c |`)).result, 'conform');
  assert.equal(judgePlacement(range(TABLE)).result, 'conform');
  assert.equal(judgePlacement(range(`${TABLE}| a | b |\n\n${TABLE.split('\n')[0]}`, new Set([4]))).result, 'conform');
});

test('SP-BPAUTHORING-021: 理由の空いたデータ行を持つ designNote で placement が不適合を記録し、gate の units の SP-BPCONFORMANCE-041 の単位が不適合で合否が不合格になり、検証役がその単位の結果を返すと拒否され、書き手を起動しなかった反復の placement は前の反復の designNote を読む', async (t) => {
  const c = await create(t);
  if (!c.ctx) return;
  await gateReady(c, 1, `x\n${TABLE}| 層 |  |\n`);
  const row = applicability(DOCS)[8];
  const { assignments } = await ledger.assignments(c.ctx, { ...c.req, stage: 'verify', rule: 'all' });
  const assignment = assignments[0];
  const { items } = await run.stageStart(c.ctx, { ...c.req, stage: 'verify', round: 1, keys: [{ viewpoint: 'conformance' }, { viewpoint: 'goal' }] });
  await ledger.verdicts(c.ctx, { ...c.req, item: items[1], assignment: assignment.id, viewpoint: 'goal', result: { judgements: assignment.assets.map((asset) => ({ asset, judgement: 'ok' })), candidates: [], basisConstraints: [] } });
  const units = row.units.map((u) => ({ unit: u.value, result: row.forced.includes(u.value) ? 'unchecked' : 'conform', reason: 'r', ...(row.forced.includes(u.value) ? { unchecked: 'forced' } : {}) }));
  const result = (extra = []) => ({ judgements: assignment.assets.map((asset) => ({ asset, judgement: 'ok' })), candidates: [], applicability: answersFor(row, assignment.assets[0]), units: [...units, ...extra], residualRisks: [], checkedRoleLimits: [] });
  const send = (r) => ledger.verdicts(c.ctx, { ...c.req, item: items[0], assignment: assignment.id, viewpoint: 'conformance', result: r });
  await rejects(send(result([{ unit: 'SP-BPCONFORMANCE-041', result: 'conform', reason: 'r' }])), CODES.result, /SP-BPCONFORMANCE-041/);
  await send(result());
  await placement(c.ctx, { ...c.req, iteration: 1 });
  const g = await author.gate(c.ctx, { ...c.req, number: 1 });
  assert.deepEqual(g.units.find((u) => u.unit === 'SP-BPCONFORMANCE-041').result, 'nonconform');
  assert.equal(g.decision, 'fail');
  assert.ok(g.rewrite.units.some((u) => u.unit === 'SP-BPCONFORMANCE-041'));
  await gateReady(c, 2, null);
  const reread = await placement(c.ctx, { ...c.req, iteration: 2 });
  assert.deepEqual(reread.lines, [{ path: 'SKILL.md', line: 8 }]);
});

test('SP-BPAUTHORING-017・SP-BPCONFORMANCE-041: 同じ反復で検証の段と追加の検証の段の適合の観点の結果を書いた状態の残る危険に、検証役が返さなくても網羅の残る危険が 1 件だけある', async (t) => {
  const c = await create(t);
  if (!c.ctx) return;
  await gateReady(c, 1);
  const row = applicability(DOCS)[8];
  const units = row.units.map((u) => ({ unit: u.value, result: row.forced.includes(u.value) ? 'unchecked' : 'conform', reason: 'r', ...(row.forced.includes(u.value) ? { unchecked: 'forced' } : {}) }));
  for (const stage of ['verify', 'verify-extra']) {
    const { assignments } = await ledger.assignments(c.ctx, { ...c.req, stage, rule: 'all' });
    const assignment = assignments[0];
    const { items } = await run.stageStart(c.ctx, { ...c.req, stage, round: 1, ...(stage === 'verify-extra' ? { part: 1 } : {}), keys: [{ viewpoint: 'conformance' }] });
    const out = await ledger.verdicts(c.ctx, { ...c.req, item: items[0], assignment: assignment.id, viewpoint: 'conformance', result: { judgements: assignment.assets.map((asset) => ({ asset, judgement: 'ok' })), candidates: [], applicability: answersFor(row, assignment.assets[0]), units, residualRisks: [{ role: '書き手', restriction: 'r', host: 'Claude Code', reason: 'x' }], checkedRoleLimits: [] } });
    assert.equal(out.ok ?? true, true, out.reason);
  }
  const risks = [...(await viewOf(c.ctx, c.req.state)).extras.values()].flatMap((x) => x.data.residualRisks);
  assert.deepEqual(risks.filter((r) => r.sp === 'SP-BPCONFORMANCE-041').length, 1);
  assert.match(risks.find((r) => r.sp).reason, /網羅/);
});

test('SP-BPFINDINGS-010: create・update の適合の観点と review のフローの観点の閉集合に SP-BPCONFORMANCE-041 が無く、検証役がその種類の候補を返すと拒否される', async (t) => {
  for (const fn of ['create', 'update']) {
    const kinds = buildKinds(DOCS, fn);
    assert.ok(!kinds.conformance.some((k) => k.value === 'SP-BPCONFORMANCE-041'), fn);
    assert.ok(!kinds.flow.some((k) => k.value === 'SP-BPCONFORMANCE-041'), fn);
  }
  const c = await create(t);
  if (!c.ctx) return;
  await gateReady(c, 1);
  const row = applicability(DOCS)[8];
  const { assignments } = await ledger.assignments(c.ctx, { ...c.req, stage: 'verify', rule: 'all' });
  const assignment = assignments[0];
  const { items } = await run.stageStart(c.ctx, { ...c.req, stage: 'verify', round: 1, keys: [{ viewpoint: 'conformance' }] });
  const asset = assignment.assets[0];
  const result = { judgements: assignment.assets.map((a) => ({ asset: a, judgement: a === asset ? 'candidate' : 'ok' })), candidates: [{ asset, viewpoint: 'conformance', kind: 'SP-BPCONFORMANCE-041', quote: 'q', content: 'c', fix: 'f' }], applicability: answersFor(row, asset), units: row.units.map((u) => ({ unit: u.value, result: 'conform', reason: 'r' })), residualRisks: [], checkedRoleLimits: [] };
  await rejects(ledger.verdicts(c.ctx, { ...c.req, item: items[0], assignment: assignment.id, viewpoint: 'conformance', result }), CODES.result);
});

async function review(t, files) {
  const ctx = context(t, { criteriaDir: DOCS });
  if (!ctx) return {};
  const root = await skillDir(t, files);
  const s = await run.start(ctx, { host: 'native', key: newKey(), function: 'review', target: { root }, limits: LIMITS });
  const req = { state: s.state, run: s.run };
  await run.stageStart(ctx, { ...req, stage: 'targets', keys: [] });
  await inspect.targets(ctx, req);
  const made = await ledger.ledgerCreate(ctx, req);
  return { ctx, req, root, assets: made.assets };
}

test('SP-BPFINDINGS-014・SP-BPINSPECTION-007: review の placement の不適合から作った指摘が反証の段の項目に入らず、その資産の内容の指紋 1 つの組の open の指摘になり、照合と停止を始め直しても台帳に記録が足されない', async (t) => {
  const r = await review(t, { 'SKILL.md': `---\nname: x\n---\n# X\n## 設計\n${TABLE}| 層 |  |\n` });
  if (!r.ctx) return;
  const out = await placement(r.ctx, r.req);
  assert.equal(out.result, 'nonconform');
  assert.equal(out.findings.length, 1);
  const view = await viewOf(r.ctx, r.req.state);
  const f = view.findings.get(out.findings[0]);
  assert.equal(f.key.kind, 'SP-BPCONFORMANCE-041');
  assert.equal(f.states.at(-1).state, 'open');
  assert.deepEqual(Object.keys(f.states.at(-1).fps), [f.key.asset]);
  assert.match(f.texts.quote, /^L8: /);
  assert.deepEqual((await ledger.refutationItems(r.ctx, { ...r.req, stages: [{ stage: 'verify', round: null }] })).keys, []);
  await run.stop(r.ctx, { ...r.req, kind: 'blocked', reason: 'x', launches: 1 });
  const r2 = await run.start(r.ctx, { host: 'native', key: newKey(), state: r.req.state });
  const before = (await viewOf(r.ctx, r.req.state)).findings.size;
  const again = await placement(r.ctx, { state: r.req.state, run: r2.run });
  assert.deepEqual(again.findings, out.findings);
  const after = await viewOf(r.ctx, r.req.state);
  assert.equal(after.findings.size, before);
  assert.equal(after.findings.get(out.findings[0]).states.length, 1);
});

test('SP-BPINSPECTION-007: 見出し行の無い review の placement の指摘は SKILL.md の frontmatter の資産に、frontmatter の無い SKILL.md では最初の見出しより前の本文の資産に出る', async (t) => {
  for (const [text, loc] of [['---\nname: x\n---\n# X\n本文\n', 'fm'], ['前の本文\n# X\n本文\n', 'pre']]) {
    const r = await review(t, { 'SKILL.md': text });
    if (!r.ctx) return;
    const out = await placement(r.ctx, r.req);
    const f = (await viewOf(r.ctx, r.req.state)).findings.get(out.findings[0]);
    assert.equal(r.assets.find((a) => a.id === f.key.asset).loc.k, loc);
    assert.equal(f.texts.quote, '');
  }
});

test('SP-BPINSPECTION-025・SP-BPCONFORMANCE-041: 読めないファイルがあり読めたファイルだけでは結果が決まらない placement は未検査になり、未検査の観点に placement の理由の 1 件と網羅の理由の 1 件が載る', async (t) => {
  const r = await review(t, { 'SKILL.md': `---\nname: x\n---\n# X\n${TABLE}`, 'x.md': '# Y\n本文\n' });
  if (!r.ctx) return;
  await fs.chmod(path.join(r.root, 'x.md'), 0o000);
  t.after(() => fs.chmod(path.join(r.root, 'x.md'), 0o644).catch(() => null));
  const out = await placement(r.ctx, r.req);
  assert.equal(out.result, 'unchecked');
  assert.match(out.reason, /x\.md/);
  const list = uncheckedViewpoints(await viewOf(r.ctx, r.req.state)).filter((u) => u.value === 'SP-BPCONFORMANCE-041');
  assert.deepEqual(list.map((u) => u.reason).sort(), [out.reason, list.find((u) => /網羅/.test(u.reason)).reason].sort());
  assert.equal(list.length, 2);
});

test('SP-BPCONFORMANCE-041: 読めないファイルがあっても、読めたファイルだけで見出し行が 2 つ以上なら不適合を返す', async (t) => {
  const r = await review(t, { 'SKILL.md': `---\nname: x\n---\n# X\n${TABLE}\n## B\n${TABLE}`, 'x.md': '# Y\n' });
  if (!r.ctx) return;
  await fs.chmod(path.join(r.root, 'x.md'), 0o000);
  t.after(() => fs.chmod(path.join(r.root, 'x.md'), 0o644).catch(() => null));
  const out = await placement(r.ctx, r.req);
  assert.equal(out.result, 'nonconform');
  assert.equal(out.findings.length, 2, '見出し行を含む 2 つの資産ごとに指摘を作る');
});

test('SP-BPINSPECTION-007: 空白だけの SKILL.md の review の placement の指摘は、台帳の今の資産の資産 ID の昇順の最初の資産に出る', async (t) => {
  const r = await review(t, { 'SKILL.md': '  \n', 'b.md': '# B\n本文\n', 'a.md': '# A\n本文\n' });
  if (!r.ctx) return;
  const out = await placement(r.ctx, r.req);
  const f = (await viewOf(r.ctx, r.req.state)).findings.get(out.findings[0]);
  assert.equal(f.key.asset, r.assets.map((a) => a.id).sort()[0]);
});

test('SP-BPCONFORMANCE-041・SP-BPRUN-031: placement 経由で、区切り行のセルが 2 つでない表・空行を挟んだ後の行・コードフェンスの中の見出し行・designNote の区間の外にだけある表を照らし、create の読めない designNote は未検査にする', async (t) => {
  const cases = [
    [`x\n| 判断点 | 硬い層へ置けない理由 |\n|---|---|---|\n`, 'nonconform'],
    [`x\n${TABLE}\n| 層 |  |\n`, 'conform'],
    ['x\n```\n| 判断点 | 硬い層へ置けない理由 |\n```\n' + TABLE, 'conform'],
  ];
  for (const [body, want] of cases) {
    const c = await create(t);
    if (!c.ctx) return;
    await write(c, 1, body);
    assert.equal((await placement(c.ctx, { ...c.req, iteration: 1 })).result, want, body);
  }
  const c = await create(t);
  const { items } = await run.stageStart(c.ctx, { ...c.req, stage: 'write', round: 1, keys: [{ iteration: 1 }] });
  await fs.mkdir(c.root, { recursive: true });
  await fs.writeFile(path.join(c.root, 'SKILL.md'), `---\nname: m\n---\n# M\n本文\n${TABLE}`);
  await run.itemResult(c.ctx, { ...c.req, item: items[0], result: { written: [], designNote: { path: 'SKILL.md', startLine: 4, endLine: 5 } } });
  assert.equal((await placement(c.ctx, { ...c.req, iteration: 1 })).result, 'nonconform');
  const gone = await create(t);
  await write(gone, 1, `x\n${TABLE}`);
  await fs.rm(path.join(gone.root, 'SKILL.md'));
  const unchecked = await placement(gone.ctx, { ...gone.req, iteration: 1 });
  assert.equal(unchecked.result, 'unchecked');
  assert.match(unchecked.reason, /SKILL\.md/);
});

test('SP-BPRUN-031: 書き手を起動しなかった反復 3 の placement は、反復 1 でなく反復 2 の書く段の designNote を読む', async (t) => {
  const c = await create(t);
  if (!c.ctx) return;
  await write(c, 1, `x\n${TABLE}| 層 |  |\n`);
  await write(c, 2, `x\n${TABLE}`);
  assert.equal((await placement(c.ctx, { ...c.req, iteration: 3 })).result, 'conform');
});

test('SP-BPCONFORMANCE-019・SP-BPINSPECTION-025: 無視される設定の一覧は実際の写しから読め、記述の無い写しでは読めない', () => {
  assert.equal(ignoredSettingsReadable(DOCS), true);
  assert.equal(ignoredSettingsReadable(CRITERIA_FIXTURE), false);
});

test('SP-BPRUN-032: writtenFiles の要素が {path, action, verified} で、検証の結果の無いファイルが false になる', async (t) => {
  const c = await create(t);
  if (!c.ctx) return;
  await write(c, 1, 'x\n');
  const draft = await run.stopDraft(c.ctx, { state: c.req.state });
  assert.deepEqual(draft.writtenFiles, [{ path: 'SKILL.md', action: 'write', verified: false }]);
});

test('SP-BPAUTHORING-026・SP-BPAUTHORING-044: 合格の後に形式検証の段を通っていない完了の停止を CLI が E_CONFLICT で拒否する', async (t) => {
  const c = await create(t);
  if (!c.ctx) return;
  await gateReady(c, 1);
  await placement(c.ctx, { ...c.req, iteration: 1 });
  await author.gate(c.ctx, { ...c.req, number: 1 });
  await rejects(run.stop(c.ctx, { ...c.req, kind: 'complete', launches: 1 }), CODES.conflict);
});

async function verifyClean(c, number, { limits = [] } = {}) {
  const row = applicability(DOCS)[8];
  const { assignments } = await ledger.assignments(c.ctx, { ...c.req, stage: 'verify', rule: 'all' });
  const assignment = assignments[0];
  const { items } = await run.stageStart(c.ctx, { ...c.req, stage: 'verify', round: number, keys: [{ viewpoint: 'conformance' }, { viewpoint: 'goal' }] });
  const judgements = assignment.assets.map((asset) => ({ asset, judgement: 'ok' }));
  await ledger.verdicts(c.ctx, { ...c.req, item: items[1], assignment: assignment.id, viewpoint: 'goal', result: { judgements, candidates: [], basisConstraints: [] } });
  const units = row.units.map((u) => ({ unit: u.value, result: row.forced.includes(u.value) ? 'unchecked' : 'conform', reason: 'r', ...(row.forced.includes(u.value) ? { unchecked: 'forced' } : {}) }));
  return ledger.verdicts(c.ctx, { ...c.req, item: items[0], assignment: assignment.id, viewpoint: 'conformance', result: { judgements, candidates: [], applicability: answersFor(row, assignment.assets[0]), units, residualRisks: [], checkedRoleLimits: limits } });
}

async function passGate(t) {
  const c = await create(t);
  if (!c.ctx) return {};
  await gateReady(c, 1);
  await verifyClean(c, 1);
  await placement(c.ctx, { ...c.req, iteration: 1 });
  const g = await author.gate(c.ctx, { ...c.req, number: 1 });
  assert.equal(g.decision, 'pass', JSON.stringify(g.unverifiable));
  return c;
}

async function formalItem(c, round, result) {
  const { items } = await run.stageStart(c.ctx, { ...c.req, stage: 'formal', round, keys: [{ formal: round }] });
  return run.itemResult(c.ctx, { ...c.req, item: items[0], result });
}

test('SP-BPAUTHORING-026・SP-BPAUTHORING-044・SP-BPAUTHORING-032: 合格の後の形式検証を通れば完了を受理して formalVerification が作業記録のパスを指し、fails・unrunnable なら完了を拒否する', async (t) => {
  for (const [props, ok] of [[[{ target: 'a', formalized: true, outcome: 'holds' }], true], [[{ target: 'a', formalized: true, outcome: 'fails', reason: 'r' }], false], [[{ target: 'a', formalized: true, outcome: 'unrunnable', reason: 'r' }], false]]) {
    const c = await passGate(t);
    if (!c.ctx) return;
    await formalItem(c, 1, formal(props));
    if (!ok) { await rejects(run.stop(c.ctx, { ...c.req, kind: 'complete', launches: 1 }), CODES.conflict); continue; }
    await run.stop(c.ctx, { ...c.req, kind: 'complete', launches: 1 });
    const out = await author.outcome(c.ctx, { state: c.req.state });
    assert.equal(out.verification.formalVerification, 'formal-1.md');
  }
});

test('SP-BPAUTHORING-032・SP-BPAUTHORING-044: 合否より前の形式検証の結果は完了の条件にも formalVerification にも効かない', async (t) => {
  const c = await create(t);
  if (!c.ctx) return;
  await formalItem(c, 1, formal([]));
  await gateReady(c, 1);
  await verifyClean(c, 1);
  await placement(c.ctx, { ...c.req, iteration: 1 });
  await author.gate(c.ctx, { ...c.req, number: 1 });
  await rejects(run.stop(c.ctx, { ...c.req, kind: 'complete', launches: 1 }), CODES.conflict);
  await run.stop(c.ctx, { ...c.req, kind: 'blocked', reason: 'x', launches: 1 });
  assert.equal((await author.outcome(c.ctx, { state: c.req.state })).verification.formalVerification, null);
});

test('SP-BPRUN-031・SP-BPAUTHORING-014・SP-BPAUTHORING-036: 再開の progress が SP-BPRUN-031 の欄だけを持ち、formalRound が最後の回、formalFails がその回の fails の target と reason になる', async (t) => {
  const c = await passGate(t);
  if (!c.ctx) return;
  await formalItem(c, 1, formal([{ target: 'a', formalized: true, outcome: 'fails', reason: '反例' }, { target: 'b', formalized: true, outcome: 'unrunnable', reason: 'x' }, { target: 'c', formalized: false, outcome: 'unconfirmed', reason: 'y' }]));
  await run.stop(c.ctx, { ...c.req, kind: 'blocked', reason: 'f', launches: 1, cause: 'formalFailed' });
  const r = await run.start(c.ctx, { host: 'native', key: newKey(), state: c.req.state });
  assert.deepEqual(Object.keys(r.progress).sort(), ['decisions', 'formalFails', 'formalRound', 'lastRewrite', 'lastStop']);
  assert.deepEqual([r.progress.formalRound, r.progress.formalFails], [1, [{ target: 'a', reason: '反例' }]]);
  assert.deepEqual(r.progress.lastStop, { kind: 'blocked', limitHit: null, cause: 'formalFailed' });
  assert.deepEqual(r.progress.decisions, [{ iteration: 1, decision: 'pass' }]);
});

test('SP-BPRUN-031: 形式検証の段の result で workRecord が work/ の外・properties が並びでない・target が文字列でない・formalized が真偽値でない・readable がオブジェクトでないものを拒否する', async (t) => {
  const c = await create(t);
  if (!c.ctx) return;
  const { items } = await run.stageStart(c.ctx, { ...c.req, stage: 'formal', round: 1, keys: [{ formal: 1 }] });
  for (const bad of [{ ...formal([]), workRecord: '../x.md' }, { ...formal([]), properties: {} }, formal([{ target: 1, formalized: true, outcome: 'holds' }]), formal([{ target: 't', formalized: 'yes', outcome: 'holds' }]), formal([], 'ok'), formal([], { ok: 'true' })]) {
    await rejects(run.itemResult(c.ctx, { ...c.req, item: items[0], result: bad }), CODES.result);
  }
});

test('SP-BPAUTHORING-046: checkedRoleLimits の配布先が Claude Code でない要素と、効かない制限があるのに SP-BPCONFORMANCE-019 の単位が不適合でない結果を拒否する', async (t) => {
  const c = await create(t);
  if (!c.ctx) return;
  await gateReady(c, 1);
  const out = await verifyClean(c, 1, { limits: [{ role: '検証役', restriction: 'tools', host: 'Codex runner', result: '効く' }] }).catch((e) => e);
  assert.match(out.reason, /checkedRoleLimits/);
  const ineffective = await verifyClean(c, 1, { limits: [{ role: '検証役', restriction: 'tools', host: 'Claude Code', result: '効かない' }] }).catch((e) => e);
  assert.match(ineffective.reason, /SP-BPCONFORMANCE-019/);
});
