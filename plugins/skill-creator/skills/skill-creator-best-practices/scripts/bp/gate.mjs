import { FINDING_GATE, FINDING_STATES, GATE_DECISIONS, GATE_NEXT, REVIEW_VALUES, UNCHECKED_KINDS, UNIT_RESULTS } from './constants.mjs';
import { internal } from './errors.mjs';

const ANY = '*';
const { open, dismissed, resolved, regressed } = FINDING_STATES;
const { exists, absent, unknown } = REVIEW_VALUES;
export const NO_JUDGEMENT = 'none';
export const RECORDED_RUN = Object.freeze({ current: 'current', previous: 'previous' });
export const KEYS_VERDICT = Object.freeze({ fail: 'fail', allOk: 'allOk', other: 'other' });
export const INCREMENT = Object.freeze({ below: 'below', reached: 'reached' });

// SP-BPAUTHORING-022 の表。行は互いに重ならないので、当たる行は 1 つに決まる。
export const FINDING_ROWS = Object.freeze([
  { run: RECORDED_RUN.current, state: open, judgement: ANY, onCurrent: ANY, result: FINDING_GATE.fail },
  { run: RECORDED_RUN.current, state: regressed, judgement: ANY, onCurrent: ANY, result: FINDING_GATE.fail },
  { run: RECORDED_RUN.current, state: dismissed, judgement: ANY, onCurrent: true, result: FINDING_GATE.ok },
  { run: RECORDED_RUN.current, state: dismissed, judgement: ANY, onCurrent: false, result: FINDING_GATE.unverifiable },
  { run: RECORDED_RUN.current, state: resolved, judgement: ANY, onCurrent: true, result: FINDING_GATE.ok },
  { run: RECORDED_RUN.current, state: resolved, judgement: ANY, onCurrent: false, result: FINDING_GATE.unverifiable },
  { run: RECORDED_RUN.previous, state: ANY, judgement: exists, onCurrent: ANY, result: FINDING_GATE.fail },
  { run: RECORDED_RUN.previous, state: ANY, judgement: absent, onCurrent: true, result: FINDING_GATE.ok },
  { run: RECORDED_RUN.previous, state: ANY, judgement: absent, onCurrent: false, result: FINDING_GATE.unverifiable },
  { run: RECORDED_RUN.previous, state: ANY, judgement: unknown, onCurrent: ANY, result: FINDING_GATE.unverifiable },
  { run: RECORDED_RUN.previous, state: open, judgement: NO_JUDGEMENT, onCurrent: true, result: FINDING_GATE.fail },
  { run: RECORDED_RUN.previous, state: regressed, judgement: NO_JUDGEMENT, onCurrent: true, result: FINDING_GATE.fail },
  { run: RECORDED_RUN.previous, state: dismissed, judgement: NO_JUDGEMENT, onCurrent: true, result: FINDING_GATE.ok },
  { run: RECORDED_RUN.previous, state: resolved, judgement: NO_JUDGEMENT, onCurrent: true, result: FINDING_GATE.ok },
  { run: RECORDED_RUN.previous, state: ANY, judgement: NO_JUDGEMENT, onCurrent: false, result: FINDING_GATE.unverifiable },
]);

// SP-BPAUTHORING-021 の表。「未検査」は検証役が添えた区分のまま返すので、結果の列は区分を持たない。
export const UNIT_ROWS = Object.freeze([
  { given: UNIT_RESULTS.conform, keys: ANY, result: UNIT_RESULTS.conform },
  { given: UNIT_RESULTS.na, keys: ANY, result: UNIT_RESULTS.na },
  { given: UNIT_RESULTS.unchecked, keys: ANY, result: UNIT_RESULTS.unchecked },
  { given: UNIT_RESULTS.nonconform, keys: KEYS_VERDICT.fail, result: UNIT_RESULTS.nonconform },
  { given: UNIT_RESULTS.nonconform, keys: KEYS_VERDICT.allOk, result: UNIT_RESULTS.conform },
  { given: UNIT_RESULTS.nonconform, keys: KEYS_VERDICT.other, result: UNIT_RESULTS.unchecked, unchecked: UNCHECKED_KINDS.unforced },
]);

export const NEXT_ROWS = Object.freeze([
  { decision: GATE_DECISIONS.pass, increment: ANY, next: GATE_NEXT.formal },
  { decision: GATE_DECISIONS.fail, increment: INCREMENT.below, next: GATE_NEXT.rewrite },
  { decision: GATE_DECISIONS.fail, increment: INCREMENT.reached, next: GATE_NEXT.iterationLimit },
  { decision: GATE_DECISIONS.unverifiable, increment: ANY, next: GATE_NEXT.blocked },
]);

const hit = (cell, value) => cell === ANY || cell === value;

function only(rows, input, fields, what) {
  const found = rows.filter((r) => fields.every((f) => hit(r[f], input[f])));
  if (found.length !== 1) internal(`${what}の表に当たる行が ${found.length} 行ある: ${JSON.stringify(input)}`);
  return found[0];
}

export function findingGate(input, rows = FINDING_ROWS) {
  return only(rows, input, ['run', 'state', 'judgement', 'onCurrent'], '指摘による合否').result;
}

export function unitGate(input, rows = UNIT_ROWS) {
  const row = only(rows, input, ['given', 'keys'], '判定の単位の結果');
  return { result: row.result, unchecked: row.result === UNIT_RESULTS.unchecked ? row.unchecked ?? input.unchecked : undefined };
}

export function nextStep(input, rows = NEXT_ROWS) {
  return only(rows, input, ['decision', 'increment'], '合否の後の進み方').next;
}

export function iterationDecision({ unverifiable, failing }) {
  if (Object.values(unverifiable).some((list) => list.length > 0)) return GATE_DECISIONS.unverifiable;
  if (Object.values(failing).some((list) => list.length > 0)) return GATE_DECISIONS.fail;
  return GATE_DECISIONS.pass;
}
