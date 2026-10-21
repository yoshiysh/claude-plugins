import test from 'node:test';
import assert from 'node:assert/strict';
import { APPLICABILITY_ANSWERS, PRESENCE, SHAPES } from './constants.mjs';
import { PATHS, judgeApplicability, shapeOf } from './applicability.mjs';

const ANSWERS = Object.values(APPLICABILITY_ANSWERS);
const ROWS = [
  { row: 1, form: SHAPES.turn, ledger: PRESENCE.absent, fanout: PRESENCE.absent, units: [{ value: 'U1' }], forced: [] },
  { row: 2, form: SHAPES.turn, ledger: PRESENCE.present, fanout: '*', units: [{ value: 'U2' }, { value: 'X' }], forced: ['X'] },
  { row: 3, form: SHAPES.pipeline, ledger: PRESENCE.absent, fanout: PRESENCE.present, units: [{ value: 'U3' }], forced: [] },
];

function result(seq, ledger = PRESENCE.absent, fanout = PRESENCE.absent) {
  const quotes = [{ asset: 'A1', line: 3, text: 't' }];
  const [A, Q1, Q2, Q3] = seq;
  return { answers: { A: { answer: A, quotes }, Q1: { answer: Q1, quotes }, Q2: { answer: Q2, quotes }, Q3: { answer: Q3, quotes } }, ledger: { answer: ledger, quotes }, fanout: { answer: fanout, quotes } };
}

test('SP-BPINSPECTION-006: 3 × 3 × 3 × 3 = 81 通りの答えの並びのうち、形の判定の図の道の 5 通りだけを受理し、到達した形を決める', () => {
  const accepted = [];
  for (const A of ANSWERS) for (const Q1 of ANSWERS) for (const Q2 of ANSWERS) for (const Q3 of ANSWERS) {
    const shape = shapeOf([A, Q1, Q2, Q3]);
    if (shape) accepted.push([[A, Q1, Q2, Q3].join(','), shape]);
  }
  assert.equal(accepted.length, 5);
  assert.deepEqual(accepted.map(([, s]) => s).sort(), [SHAPES.explore, SHAPES.iterative, SHAPES.pipeline, SHAPES.turn, SHAPES.turn].sort());
  assert.deepEqual(PATHS.map((p) => p.answers.join(',')).sort(), accepted.map(([k]) => k).sort());
});

test('SP-BPINSPECTION-006: 行の条件の「*」に資産台帳・fan-out のどちらの答えも当たり、除く単位を行の単位と強いられた未検査から外す', () => {
  const turn = ['いいえ', '問いに到達しない', '問いに到達しない', '問いに到達しない'];
  for (const fanout of Object.values(PRESENCE)) {
    const out = judgeApplicability(result(turn, PRESENCE.present, fanout), { assetIds: new Set(['A1']), rows: ROWS, excluded: ['X'] });
    assert.equal(out.row, 2);
    assert.deepEqual(out.units, [{ value: 'U2' }]);
    assert.deepEqual(out.forced, []);
  }
  const none = judgeApplicability(result(['はい', 'はい', '問いに到達しない', '問いに到達しない']), { assetIds: new Set(['A1']), rows: ROWS, excluded: [] });
  assert.match(none.error, /当たる行が無い/);
});

test('SP-BPINSPECTION-006: 引用の無い答え・行番号の無い引用・台帳に無い資産 ID・閉集合の外の資産台帳の答えを拒否する', () => {
  const base = ['はい', 'はい', '問いに到達しない', '問いに到達しない'];
  const ctx = { assetIds: new Set(['A1']), rows: ROWS, excluded: [] };
  const noQuote = result(base, PRESENCE.absent, PRESENCE.present);
  noQuote.answers.Q1.quotes = [];
  assert.match(judgeApplicability(noQuote, ctx).error, /引用が 1 件も無い/);
  const noLine = result(base, PRESENCE.absent, PRESENCE.present);
  noLine.fanout.quotes = [{ asset: 'A1', line: 0, text: 't' }];
  assert.match(judgeApplicability(noLine, ctx).error, /行番号/);
  const stray = result(base, PRESENCE.absent, PRESENCE.present);
  stray.ledger.quotes = [{ asset: 'A9', line: 1, text: 't' }];
  assert.match(judgeApplicability(stray, ctx).error, /台帳の今の資産に無い/);
  assert.match(judgeApplicability(result(base, 'ある', PRESENCE.present), ctx).error, /選択肢に無い/);
  assert.equal(judgeApplicability(result(base, PRESENCE.absent, PRESENCE.present), ctx).row, 3);
});
