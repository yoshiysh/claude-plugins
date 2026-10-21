import { BASIS, FINDING_STATES, REVIEW_INPUT, REVIEW_VALUES } from './constants.mjs';
import { internal } from './errors.mjs';

const { exists, absent, unknown, skip } = REVIEW_VALUES;
const SAME_AS_LAST = 'same_as_last';

const { r: R, content: C, candidates: K, judged: J } = REVIEW_INPUT;

export const REVIEW_INPUT_VALUES = Object.freeze(Object.fromEntries(Object.entries(REVIEW_INPUT).map(([k, v]) => [k, Object.values(v)])));

// 行の番号は SP-BPFINDINGS-018 の表の「順」で、上から順に当てる。basis は記録に残す判定の出所で、判定しない行は持たない。
export const REVIEW_ROWS = Object.freeze([
  { row: 1, when: (i) => i.r === R.empty && i.content === C.changed, value: unknown, basis: BASIS.unknown },
  { row: 2, when: (i) => i.r === R.empty && i.content === C.same, value: skip, basis: null },
  { row: 3, when: (i) => i.candidates === K.upheld, value: exists, basis: BASIS.upheld },
  { row: 4, when: (i) => i.candidates === K.unrefuted, value: unknown, basis: BASIS.unknown },
  { row: 5, when: (i) => i.candidates === K.dup, value: SAME_AS_LAST, basis: SAME_AS_LAST },
  { row: 6, when: (i) => i.candidates === K.rejected, value: absent, basis: BASIS.rejected },
  { row: 7, when: (i) => i.candidates === K.none && i.judged === J.decided, value: absent, basis: BASIS.noCandidate },
  { row: 8, when: (i) => i.candidates === K.none && i.judged === J.unsure, value: unknown, basis: BASIS.unknown },
]);

export function impossibleReason(i) {
  if (i.r === R.empty && (i.candidates !== K.none || i.judged !== J.none)) return 'R が空なのに候補か判定がある';
  if (i.r === R.present && i.judged === J.none) return 'R があるのにその資産の判定が無い';
  if (i.candidates === K.mixedDup) return '同じ鍵の候補に重複と重複でないものが混ざる（1 つの段の中で資産の内容は同じ）';
  if (i.candidates === K.dup && i.content === C.changed) return '内容の指紋が変わったのに重複がある（重複は最後の判定と同じ内容の指紋の候補だけ）';
  if (i.candidates !== K.none && i.judged === J.unsure) return '同じ鍵の候補があるのに、その資産の判定が全て「判断できない」';
  return null;
}

export function reviewJudgement(input, last) {
  const impossible = impossibleReason(input);
  if (impossible) internal(`起こりえない見直しの入力: ${impossible}`, { input });
  const row = REVIEW_ROWS.find((r) => r.when(input));
  if (!row) internal('見直しの表のどの行にも当たらない', { input });
  if (row.value === SAME_AS_LAST) {
    if (last?.value !== exists && last?.value !== absent) internal(`重複の行で最後の判定の値が無い: ${last?.value}`);
    if (!last.basis) internal('重複の行で最後の判定の basis が無い');
    return { row: row.row, value: last.value, basis: last.basis };
  }
  return { row: row.row, value: row.value, basis: row.basis };
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
