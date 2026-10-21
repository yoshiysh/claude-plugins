import test from 'node:test';
import assert from 'node:assert/strict';
import { CODES, FINDING_STATES, REVIEW_VALUES } from './constants.mjs';
import { REVIEW_INPUT_VALUES, REVIEW_ROWS, nextState, reviewJudgement } from './judge.mjs';

function* combos() {
  for (const r of REVIEW_INPUT_VALUES.r) for (const content of REVIEW_INPUT_VALUES.content) {
    for (const candidates of REVIEW_INPUT_VALUES.candidates) for (const judged of REVIEW_INPUT_VALUES.judged) {
      yield { r, content, candidates, judged };
    }
  }
}

const EXPECTED = [
  [{ r: 'empty', content: 'changed', candidates: 'none', judged: 'none' }, 1, REVIEW_VALUES.unknown],
  [{ r: 'empty', content: 'same', candidates: 'none', judged: 'none' }, 2, REVIEW_VALUES.skip],
  [{ r: 'present', content: 'changed', candidates: 'upheld', judged: 'decided' }, 3, REVIEW_VALUES.exists],
  [{ r: 'present', content: 'same', candidates: 'unrefuted', judged: 'decided' }, 4, REVIEW_VALUES.unknown],
  [{ r: 'present', content: 'same', candidates: 'dup', judged: 'decided' }, 5, REVIEW_VALUES.absent],
  [{ r: 'present', content: 'changed', candidates: 'rejected', judged: 'decided' }, 6, REVIEW_VALUES.absent],
  [{ r: 'present', content: 'changed', candidates: 'none', judged: 'decided' }, 7, REVIEW_VALUES.absent],
  [{ r: 'present', content: 'changed', candidates: 'none', judged: 'unsure' }, 8, REVIEW_VALUES.unknown],
];

test('SP-BPFINDINGS-018: 表の 8 行の条件を 1 つずつ作り、判定を確かめる', () => {
  for (const [input, row, value] of EXPECTED) {
    assert.deepEqual(reviewJudgement(input, REVIEW_VALUES.absent), { row, value }, JSON.stringify(input));
  }
  assert.equal(reviewJudgement({ r: 'present', content: 'same', candidates: 'dup', judged: 'decided' }, REVIEW_VALUES.exists).value, REVIEW_VALUES.exists);
});

// 期待値は実装の表から取らず、bp-findings.md の SP-BPFINDINGS-018 の文言から独立に書く。
function fromSpec(i, last) {
  const impossible =
    (i.r === 'empty' && (i.candidates !== 'none' || i.judged !== 'none'))
    || (i.r === 'present' && i.judged === 'none')
    || i.candidates === 'mixed_dup'
    || (i.candidates === 'dup' && i.content === 'changed')
    || (i.candidates !== 'none' && i.judged === 'unsure');
  if (impossible) return null;
  if (i.r === 'empty') return i.content === 'changed' ? { row: 1, value: 'unknown' } : { row: 2, value: 'skip' };
  if (i.candidates === 'upheld') return { row: 3, value: 'exists' };
  if (i.candidates === 'unrefuted') return { row: 4, value: 'unknown' };
  if (i.candidates === 'dup') return { row: 5, value: last };
  if (i.candidates === 'rejected') return { row: 6, value: 'absent' };
  return i.judged === 'decided' ? { row: 7, value: 'absent' } : { row: 8, value: 'unknown' };
}

test('SP-BPFINDINGS-018: 組の列挙で、漏れが無く、死んだ行が無く、起こりえない組は内部の失敗になる', () => {
  const hits = new Map(REVIEW_ROWS.map((r) => [r.row, 0]));
  for (const last of ['exists', 'absent']) {
    for (const input of combos()) {
      const expected = fromSpec(input, last);
      if (expected === null) {
        assert.throws(() => reviewJudgement(input, last), (e) => e.code === CODES.internal, JSON.stringify(input));
        continue;
      }
      const got = reviewJudgement(input, last);
      assert.deepEqual(got, expected, JSON.stringify(input));
      hits.set(got.row, hits.get(got.row) + 1);
    }
  }
  for (const [row, n] of hits) assert.ok(n > 0, `死んだ行: ${row}`);
});

test('SP-BPFINDINGS-018: 内容が不変・組が変化・候補が未反証の組が「判定できない」に当たる（係り先の曖昧さが残らない）', () => {
  assert.deepEqual(reviewJudgement({ r: 'present', content: 'same', candidates: 'unrefuted', judged: 'decided' }, REVIEW_VALUES.exists), { row: 4, value: REVIEW_VALUES.unknown });
});

test('SP-BPFINDINGS-018: R の全てがその資産を「判断できない」と判定したときは「判定できない」で、「存在しない」に倒さない', () => {
  assert.equal(reviewJudgement({ r: 'present', content: 'changed', candidates: 'none', judged: 'unsure' }, REVIEW_VALUES.exists).value, REVIEW_VALUES.unknown);
});

test('SP-BPFINDINGS-019: 4 状態 × 3 判定の 12 通りの次の状態', () => {
  const { open, dismissed, resolved, regressed } = FINDING_STATES;
  const { exists, absent, unknown } = REVIEW_VALUES;
  const table = [
    [open, open, resolved, open],
    [dismissed, open, dismissed, dismissed],
    [resolved, regressed, resolved, resolved],
    [regressed, regressed, resolved, regressed],
  ];
  for (const [state, e, a, u] of table) {
    assert.deepEqual([nextState(state, exists), nextState(state, absent), nextState(state, unknown)], [e, a, u], state);
  }
});
