import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FINDING_ROWS, NEXT_ROWS, UNIT_ROWS, findingGate, iterationDecision, nextStep, unitGate,
} from '../plugins/skill-creator/skills/skill-creator-best-practices/scripts/bp/gate.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AUTHORING = readFileSync(path.join(ROOT, 'docs', 'specifications', 'bp-authoring.md'), 'utf8');

function table(header) {
  const start = AUTHORING.indexOf(header);
  assert.ok(start >= 0, header);
  const lines = AUTHORING.slice(start).split('\n');
  const rows = [];
  for (const line of lines.slice(2)) {
    if (!line.startsWith('|')) break;
    rows.push(line.replace(/^\||\|$/g, '').split('|').map((c) => c.trim()));
  }
  return rows;
}

const ANY = '*';
const pick = (map, cell) => {
  if (cell === ANY) return ANY;
  const hit = Object.entries(map).find(([label]) => cell.startsWith(label));
  assert.ok(hit, `表の値を読めない: ${cell}`);
  return hit[1];
};

const FINDING_MAP = {
  run: { '今の run': 'current', '前の run': 'previous' },
  state: { open: 'open', dismissed: 'dismissed', resolved: 'resolved', regressed: 'regressed' },
  judgement: { 存在する: 'exists', 存在しない: 'absent', 判定できない: 'unknown', 記録なし: 'none' },
  onCurrent: { はい: true, いいえ: false },
  result: { 不合格: 'fail', 合格を妨げない: 'ok', 検証が成り立たない: 'unverifiable' },
};
const UNIT_MAP = {
  given: { 不適合: 'nonconform', 適合: 'conform', 対象外: 'na', 未検査: 'unchecked' },
  keys: { 不合格とした指摘が: 'fail', 全て合格を妨げない: 'allOk', 上記以外: 'other' },
  result: { 不適合: 'nonconform', 適合: 'conform', 対象外: 'na', 未検査: 'unchecked' },
};
const NEXT_MAP = {
  decision: { 合格: 'pass', 不合格: 'fail', 検証が成り立たない: 'unverifiable' },
  increment: { 反復の上限より小さい: 'below', 反復の上限に達した: 'reached' },
  result: { 完了で止まる: 'complete', 次の反復の書く段へ戻る: 'rewrite', 反復の上限で止まる: 'iterationLimit', 'SP-BPAUTHORING-030': 'blocked' },
};

function specRows(header, fields, map) {
  return table(header).map((cells) => Object.fromEntries(fields.map((f, i) => [f, pick(map[f], cells[i])])));
}

function product(domains) {
  return Object.entries(domains).reduce((acc, [k, values]) => acc.flatMap((o) => values.map((v) => ({ ...o, [k]: v }))), [{}]);
}

function mismatches(spec, domains, fields, run) {
  const out = [];
  for (const input of product(domains)) {
    const rows = spec.filter((r) => fields.every((f) => r[f] === ANY || r[f] === input[f]));
    if (rows.length !== 1) { out.push(`${JSON.stringify(input)}: 仕様の表で当たる行が ${rows.length} 行`); continue; }
    let got;
    try { got = run(input); } catch (error) { got = `throw ${error.message}`; }
    if (got !== rows[0].result) out.push(`${JSON.stringify(input)}: 仕様 ${rows[0].result} / 実装 ${got}`);
  }
  return out;
}

const FINDING_DOMAINS = {
  run: ['current', 'previous'],
  state: ['open', 'dismissed', 'resolved', 'regressed'],
  judgement: ['exists', 'absent', 'unknown', 'none'],
  onCurrent: [true, false],
};
const UNIT_DOMAINS = { given: ['conform', 'nonconform', 'na', 'unchecked'], keys: ['fail', 'allOk', 'other'] };
const NEXT_DOMAINS = { decision: ['pass', 'fail', 'unverifiable'], increment: ['below', 'reached'] };

const FINDING_SPEC = () => specRows('| 条件: 記録した run | 条件: 状態 | 条件: この run の見直しの判定 | 条件: 今の内容で判定したか | 結果 |', ['run', 'state', 'judgement', 'onCurrent', 'result'], FINDING_MAP);
const UNIT_SPEC = () => specRows('| 条件: 検証役が返した結果 | 条件: 添えた鍵の指摘 | 結果 |', ['given', 'keys', 'result'], UNIT_MAP);
const NEXT_SPEC = () => specRows('| 条件: 合否 | 条件: 増分 | 結果 |', ['decision', 'increment', 'result'], NEXT_MAP);

const checks = {
  finding: (rows) => mismatches(FINDING_SPEC(), FINDING_DOMAINS, ['run', 'state', 'judgement', 'onCurrent'], (i) => findingGate(i, rows)),
  unit: (rows) => mismatches(UNIT_SPEC(), UNIT_DOMAINS, ['given', 'keys'], (i) => unitGate(i, rows).result),
  next: (rows) => mismatches(NEXT_SPEC(), NEXT_DOMAINS, ['decision', 'increment'], (i) => nextStep(i, rows)),
};

test('SP-BPAUTHORING-022: 仕様の表の全ての組で、指摘による合否が表の行と一致する（行は互いに重ならず、組は全て覆われる）', () => {
  assert.equal(FINDING_SPEC().length, 15);
  assert.deepEqual(checks.finding(FINDING_ROWS), []);
});

test('SP-BPAUTHORING-021: 仕様の表の 6 行の入力で、判定の単位の結果が表と一致し、強いられていない未検査の区分が付く', () => {
  assert.equal(UNIT_SPEC().length, 6);
  assert.deepEqual(checks.unit(UNIT_ROWS), []);
  assert.deepEqual(unitGate({ given: 'nonconform', keys: 'other' }), { result: 'unchecked', unchecked: 'unforced' });
  assert.deepEqual(unitGate({ given: 'unchecked', keys: 'other', unchecked: 'forced' }), { result: 'unchecked', unchecked: 'forced' });
});

test('SP-BPAUTHORING-025: 判定表の 4 行の入力で進み方が表と一致する', () => {
  assert.equal(NEXT_SPEC().length, 4);
  assert.deepEqual(checks.next(NEXT_ROWS), []);
});

test('SP-BPAUTHORING-023: 検証が成り立たない条件は不合格の条件より先に当たり、どちらも無ければ合格', () => {
  const none = { findings: [], unrefuted: [], skip: [], aborted: [], unitsMissing: [] };
  assert.equal(iterationDecision({ unverifiable: { ...none, unrefuted: [{}] }, failing: { findings: ['F'], units: [] } }), 'unverifiable');
  for (const key of Object.keys(none)) assert.equal(iterationDecision({ unverifiable: { ...none, [key]: ['x'] }, failing: { findings: [], units: [] } }), 'unverifiable', key);
  assert.equal(iterationDecision({ unverifiable: none, failing: { findings: [], units: ['u'] } }), 'fail');
  assert.equal(iterationDecision({ unverifiable: none, failing: { findings: [], units: [] } }), 'pass');
});

// §5.9 の教訓 4: 行の結果を 1 つずつ入れ替えた表で、表の照合が必ず落ちる。
test('SP-BPAUTHORING-021・022・025: 実装の表の行の結果を 1 つでも入れ替えると、仕様の表との照合が落ちる', () => {
  const swaps = { finding: ['fail', 'ok', 'unverifiable'], unit: ['conform', 'nonconform', 'na', 'unchecked'], next: ['complete', 'rewrite', 'iterationLimit', 'blocked'] };
  const tables = { finding: FINDING_ROWS, unit: UNIT_ROWS, next: NEXT_ROWS };
  for (const [name, rows] of Object.entries(tables)) {
    rows.forEach((row, i) => {
      const field = name === 'next' ? 'next' : 'result';
      const other = swaps[name].find((v) => v !== row[field]);
      const mutated = rows.map((r, j) => (j === i ? { ...r, [field]: other } : r));
      assert.ok(checks[name](mutated).length > 0, `${name} の ${i + 1} 行目を入れ替えても落ちない`);
    });
  }
});
