import test from 'node:test';
import assert from 'node:assert/strict';
import { APPLICABILITY_ANSWERS, PRESENCE, RUN_SEQUENCE, SHAPES } from './constants.mjs';
import { judgeApplicability } from './applicability.mjs';

const ANSWERS = Object.values(APPLICABILITY_ANSWERS);
const { yes: Y, no: N, unreached: U } = APPLICABILITY_ANSWERS;
const ROWS = [
  { row: 1, form: SHAPES.turn, ledger: PRESENCE.absent, fanout: PRESENCE.absent, units: [{ value: 'U1' }], forced: [] },
  { row: 2, form: SHAPES.turn, ledger: PRESENCE.present, fanout: '*', units: [{ value: 'U2' }, { value: 'X' }], forced: ['X'] },
  { row: 3, form: SHAPES.pipeline, ledger: PRESENCE.absent, fanout: PRESENCE.present, units: [{ value: 'U3' }], forced: [] },
  { row: 4, form: SHAPES.iterative, ledger: PRESENCE.absent, fanout: PRESENCE.absent, units: [{ value: 'U4' }, { value: 'U1' }], forced: [] },
  { row: 5, form: SHAPES.pipeline, ledger: PRESENCE.absent, fanout: PRESENCE.absent, units: [{ value: 'U5' }], forced: [] },
  { row: 6, form: SHAPES.explore, ledger: PRESENCE.absent, fanout: PRESENCE.absent, units: [{ value: 'U6' }], forced: [] },
];
const quotes = [{ asset: 'A1', line: 3, text: 't' }];
const ans = (answer) => ({ answer, quotes });
const CTX = { assetIds: new Set(['A1', 'A2']), rows: ROWS, allowed: new Set(['U1', 'U2', 'U3', 'U4', 'U5', 'X']) };

function single([A, W, Q1, Q2, Q3], ledger = PRESENCE.absent, fanout = PRESENCE.absent) {
  return { answers: { A: ans(A), W: ans(W), Q1: ans(Q1), Q2: ans(Q2), Q3: ans(Q3) }, ledger: ans(ledger), fanout: ans(fanout) };
}

function element(run, [Q1, Q2, Q3], assets = ['A1'], ledger = PRESENCE.absent, fanout = PRESENCE.absent) {
  return { run, answers: { Q1: ans(Q1), Q2: ans(Q2), Q3: ans(Q3) }, ledger: ans(ledger), fanout: ans(fanout), assets };
}

function split(runs) {
  return { answers: { A: ans(Y), W: ans(Y) }, runs };
}

test('SP-BPINSPECTION-006: W がはいでない 3^5 = 243 通りの答えの並びのうち、A・W の表と Q1・Q2・Q3 の表の 5 通りだけを受理し、到達した形を決める', () => {
  const accepted = [];
  for (const A of ANSWERS) for (const W of ANSWERS) for (const Q1 of ANSWERS) for (const Q2 of ANSWERS) for (const Q3 of ANSWERS) {
    if (W === Y) continue;
    const out = judgeApplicability(single([A, W, Q1, Q2, Q3]), { ...CTX, rows: ROWS.map((r) => ({ ...r, ledger: '*', fanout: '*' })) });
    if (!out.error) accepted.push([[A, W, Q1, Q2, Q3].join(','), out.shape]);
  }
  assert.deepEqual(accepted.sort(), [
    [[N, U, U, U, U].join(','), SHAPES.turn],
    [[Y, N, N, N, N].join(','), SHAPES.turn],
    [[Y, N, N, N, Y].join(','), SHAPES.explore],
    [[Y, N, N, Y, U].join(','), SHAPES.iterative],
    [[Y, N, Y, U, U].join(','), SHAPES.pipeline],
  ].sort());
});

test('SP-BPINSPECTION-006・SP-BPINSPECTION-007: 行の条件の「*」に資産台帳・fan-out のどちらの答えも当たり、閉集合に無い単位を行の単位と強いられた未検査から外す', () => {
  const turn = [N, U, U, U, U];
  for (const fanout of Object.values(PRESENCE)) {
    const out = judgeApplicability(single(turn, PRESENCE.present, fanout), { ...CTX, allowed: new Set(['U1', 'U2', 'U3']) });
    assert.equal(out.row, 2);
    assert.deepEqual(out.units, [{ value: 'U2' }]);
    assert.deepEqual(out.forced, []);
  }
  const none = judgeApplicability(single([Y, N, Y, U, U], PRESENCE.present, PRESENCE.present), CTX);
  assert.match(none.error, /当たる行が無い/);
});

test('SP-BPINSPECTION-006: 引用の無い答え・行番号の無い引用・台帳に無い資産 ID・閉集合の外の資産台帳の答えを拒否する', () => {
  const base = [Y, N, Y, U, U];
  const noQuote = single(base, PRESENCE.absent, PRESENCE.present);
  noQuote.answers.Q1.quotes = [];
  assert.match(judgeApplicability(noQuote, CTX).error, /引用が 1 件も無い/);
  const noLine = single(base, PRESENCE.absent, PRESENCE.present);
  noLine.fanout = { answer: PRESENCE.present, quotes: [{ asset: 'A1', line: 0, text: 't' }] };
  assert.match(judgeApplicability(noLine, CTX).error, /行番号/);
  const stray = single(base, PRESENCE.absent, PRESENCE.present);
  stray.ledger = { answer: PRESENCE.absent, quotes: [{ asset: 'A9', line: 1, text: 't' }] };
  assert.match(judgeApplicability(stray, CTX).error, /台帳の今の資産に無い/);
  assert.match(judgeApplicability(single(base, 'ある', PRESENCE.present), CTX).error, /選択肢に無い/);
  assert.equal(judgeApplicability(single(base, PRESENCE.absent, PRESENCE.present), CTX).row, 3);
});

test('SP-BPINSPECTION-006: W がはいで要素が 3 つ以上の runs を受理し、要素ごとの {run, shape, row, assets} と全ての行の単位の和を返す', () => {
  const out = judgeApplicability(split([
    element(RUN_SEQUENCE, [N, Y, U], ['A1']),
    element('writer', [Y, U, U], ['A2']),
    element('checker', [N, N, N], ['A1', 'A2']),
  ]), CTX);
  assert.equal(out.error, undefined);
  assert.deepEqual(out.runs, [
    { run: RUN_SEQUENCE, shape: SHAPES.iterative, row: 4, assets: ['A1'] },
    { run: 'writer', shape: SHAPES.pipeline, row: 5, assets: ['A2'] },
    { run: 'checker', shape: SHAPES.turn, row: 1, assets: ['A1', 'A2'] },
  ]);
  assert.equal(out.shape, undefined);
  assert.deepEqual(out.units.map((u) => u.value), ['U4', 'U1', 'U5']);
});

test('SP-BPINSPECTION-006: 要素が 2 つの runs・1 つ目が sequence でない runs・run が重複する runs・台帳に無い資産 ID を assets に持つ runs・W と合わない置き場の Q1・Q2・Q3 を拒否する', () => {
  const ok = () => [element(RUN_SEQUENCE, [Y, U, U]), element('a', [Y, U, U]), element('b', [Y, U, U])];
  assert.match(judgeApplicability(split(ok().slice(0, 2)), CTX).error, /3 つ未満/);
  const first = ok();
  first[0].run = 'main';
  assert.match(judgeApplicability(split(first), CTX).error, /1 つ目の要素の run が sequence でない/);
  const dup = ok();
  dup[2].run = 'a';
  assert.match(judgeApplicability(split(dup), CTX).error, /重複/);
  const named = ok();
  named[1].run = RUN_SEQUENCE;
  assert.match(judgeApplicability(split(named), CTX).error, /重複するか sequence/);
  const stray = ok();
  stray[1].assets = ['A9'];
  assert.match(judgeApplicability(split(stray), CTX).error, /assets の資産 ID が台帳の今の資産に無い/);
  const misplaced = split(ok());
  misplaced.answers.Q1 = ans(Y);
  assert.match(judgeApplicability(misplaced, CTX).error, /runs の外にある: Q1/);
  const presence = split(ok());
  presence.ledger = ans(PRESENCE.absent);
  assert.match(judgeApplicability(presence, CTX).error, /runs の外にある: ledger/);
  const withRuns = single([Y, N, Y, U, U]);
  withRuns.runs = ok();
  assert.match(judgeApplicability(withRuns, CTX).error, /W がはいでないのに runs がある/);
  const bad = ok();
  bad[2].answers.Q1 = ans(U);
  assert.match(judgeApplicability(split(bad), CTX).error, /図の道に無い/);
});

test('SP-BPINSPECTION-006: A・W の表で受理しない組（A いいえ・W はい、A いいえ・W いいえ、A はい・W 問いに到達しない）を拒否する', () => {
  for (const [A, W] of [[N, Y], [N, N], [Y, U]]) {
    const r = W === Y ? split([element(RUN_SEQUENCE, [Y, U, U]), element('a', [Y, U, U]), element('b', [Y, U, U])]) : single([A, W, Y, U, U]);
    r.answers.A = ans(A);
    assert.match(judgeApplicability(r, CTX).error, /図の道に無い/, `${A}・${W}`);
  }
});
