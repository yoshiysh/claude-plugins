import { FINDING_STATES, REVIEW_VALUES } from './constants.mjs';
import { internal } from './errors.mjs';

const { exists, absent, unknown, skip } = REVIEW_VALUES;
const SAME_AS_LAST = 'same_as_last';

// 見直しの判定の入力の値（SP-BPFINDINGS-018）。
export const REVIEW_INPUT_VALUES = Object.freeze({
  r: ['empty', 'present'],
  content: ['changed', 'same'],
  candidates: ['none', 'upheld', 'unrefuted', 'dup', 'rejected', 'mixed_dup'],
  judged: ['none', 'decided', 'unsure'],
});

// 上から順に当て、最初に当たった行を取る。行の番号は bp-findings.md の SP-BPFINDINGS-018 の表の「順」と同じ。
export const REVIEW_ROWS = Object.freeze([
  { row: 1, when: (i) => i.r === 'empty' && i.content === 'changed', value: unknown },
  { row: 2, when: (i) => i.r === 'empty' && i.content === 'same', value: skip },
  { row: 3, when: (i) => i.candidates === 'upheld', value: exists },
  { row: 4, when: (i) => i.candidates === 'unrefuted', value: unknown },
  { row: 5, when: (i) => i.candidates === 'dup', value: SAME_AS_LAST },
  { row: 6, when: (i) => i.candidates === 'rejected', value: absent },
  { row: 7, when: (i) => i.candidates === 'none' && i.judged === 'decided', value: absent },
  { row: 8, when: (i) => i.candidates === 'none' && i.judged === 'unsure', value: unknown },
]);

export function impossibleReason(i) {
  if (i.r === 'empty' && (i.candidates !== 'none' || i.judged !== 'none')) return 'R が空なのに候補か判定がある';
  if (i.r === 'present' && i.judged === 'none') return 'R があるのにその資産の判定が無い';
  if (i.candidates === 'mixed_dup') return '同じ鍵の候補に重複と重複でないものが混ざる（1 つの段の中で資産の内容は同じ）';
  if (i.candidates === 'dup' && i.content === 'changed') return '内容の指紋が変わったのに重複がある（重複は最後の判定と同じ内容の指紋の候補だけ）';
  if (i.candidates !== 'none' && i.judged === 'unsure') return '同じ鍵の候補があるのに、その資産の判定が全て「判断できない」';
  return null;
}

export function reviewJudgement(input, lastValue) {
  const impossible = impossibleReason(input);
  if (impossible) internal(`起こりえない見直しの入力: ${impossible}`, { input });
  const row = REVIEW_ROWS.find((r) => r.when(input));
  if (!row) internal('見直しの表のどの行にも当たらない', { input });
  if (row.value === SAME_AS_LAST) {
    if (lastValue !== exists && lastValue !== absent) internal(`重複の行で最後の判定の値が無い: ${lastValue}`);
    return { row: row.row, value: lastValue };
  }
  return { row: row.row, value: row.value };
}

const TRANSITIONS = Object.freeze({
  [FINDING_STATES.open]: { [exists]: FINDING_STATES.open, [absent]: FINDING_STATES.resolved, [unknown]: FINDING_STATES.open },
  [FINDING_STATES.dismissed]: { [exists]: FINDING_STATES.open, [absent]: FINDING_STATES.dismissed, [unknown]: FINDING_STATES.dismissed },
  [FINDING_STATES.resolved]: { [exists]: FINDING_STATES.regressed, [absent]: FINDING_STATES.resolved, [unknown]: FINDING_STATES.resolved },
  [FINDING_STATES.regressed]: { [exists]: FINDING_STATES.regressed, [absent]: FINDING_STATES.resolved, [unknown]: FINDING_STATES.regressed },
});

export function nextState(state, value) {
  const next = TRANSITIONS[state]?.[value];
  if (!next) internal(`状態の遷移が無い: ${state} × ${value}`);
  return next;
}
