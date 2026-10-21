import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CODES, NEXT_ARGS_KEYS, OPS, STAGES, VIEWPOINTS } from '../plugins/skill-creator/skills/skill-creator-best-practices/scripts/bp/constants.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUN = readFileSync(path.join(ROOT, 'docs', 'specifications', 'bp-run.md'), 'utf8');
const FINDINGS = readFileSync(path.join(ROOT, 'docs', 'specifications', 'bp-findings.md'), 'utf8');

function tableAfter(text, marker) {
  const start = text.indexOf(marker);
  assert.ok(start >= 0, marker);
  const lines = text.slice(start).split('\n');
  const first = lines.findIndex((l) => l.startsWith('|'));
  const rows = [];
  for (const line of lines.slice(first + 2)) {
    if (!line.startsWith('|')) break;
    rows.push(line.replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.trim()));
  }
  return rows;
}

test('SP-BPRUN-038: 仕様の段の slug の表と CLI の定数が一致する', () => {
  const rows = tableAfter(RUN, '段の slug は次の表とする。');
  const spec = new Map(rows.map(([name, slug]) => [slug.replace(/`/g, ''), name]));
  assert.deepEqual([...spec.keys()].sort(), Object.keys(STAGES).sort());
  for (const [slug, name] of Object.entries(STAGES)) assert.ok(spec.get(slug).split('・').includes(name), `${slug}: ${spec.get(slug)} / ${name}`);
});

test('SP-BPRUN-031: 仕様の符号の表と CLI の定数が一致する', () => {
  const rows = tableAfter(RUN, '| 符号 | 意味 | script の扱い |');
  const spec = rows.flatMap(([cell]) => cell.match(/E_[A-Z_]+/g));
  assert.deepEqual(spec.sort(), Object.values(CODES).sort());
});

test('SP-BPRUN-031: 仕様の操作の表と CLI の定数が一致する', () => {
  const rows = tableAfter(RUN, '| 操作 | 実現する項目 | 受け取るもの | 返すもの |');
  const spec = rows.map(([cell]) => cell.replace(/`/g, ''));
  assert.deepEqual(spec.sort(), Object.values(OPS).sort());
});

test('SP-BPRUN-033: 仕様の next_args の綴りと CLI の定数が一致する', () => {
  const m = /綴りは `(\{[^`]+\})` とする/.exec(RUN);
  assert.ok(m);
  const keys = [...m[1].matchAll(/"(\w+)":/g)].map((x) => x[1]);
  assert.deepEqual(keys.sort(), Object.values(NEXT_ARGS_KEYS).sort());
});

test('SP-BPFINDINGS-011: 仕様の観点の値と CLI の定数が一致する', () => {
  const m = /観点の値は (.+?)とする/.exec(FINDINGS);
  assert.ok(m);
  const values = [...m[1].matchAll(/`(\w+)`（([^）]+)）/g)].map((x) => [x[1], x[2]]);
  assert.deepEqual(Object.fromEntries(values), VIEWPOINTS);
});

// ---- 2 段目: script の写しを CLI の定数と仕様の表に照らす（script は import できないので写しを持つ。§5.9 の教訓 1・5）

import { createRequire } from 'node:module';
import * as CLI_CONSTANTS from '../plugins/skill-creator/skills/skill-creator-best-practices/scripts/bp/constants.mjs';
import { sum as cliSum } from '../plugins/skill-creator/skills/skill-creator-best-practices/scripts/bp/ids.mjs';
import { isTreatedGround as cliTreated } from '../plugins/skill-creator/skills/skill-creator-best-practices/scripts/bp/ops-author.mjs';

const SCRIPT = path.join(ROOT, 'plugins', 'skill-creator', 'skills', 'skill-creator-best-practices', 'scripts', 'bp_author.js');
const SOURCE = readFileSync(SCRIPT, 'utf8');
const AUTHORING = readFileSync(path.join(ROOT, 'docs', 'specifications', 'bp-authoring.md'), 'utf8');
const CONFORMANCE = readFileSync(path.join(ROOT, 'docs', 'specifications', 'bp-conformance.md'), 'utf8');
const ENTRY = readFileSync(path.join(ROOT, 'docs', 'specifications', 'bp-entry.md'), 'utf8');
const INSPECTION = readFileSync(path.join(ROOT, 'docs', 'specifications', 'bp-inspection.md'), 'utf8');
const acorn = createRequire(path.join(ROOT, 'plugins', 'workflow', 'skills', 'dynamic-workflow-runner', 'scripts', 'runtime', 'package.json'))('acorn');

function parseScript() {
  const body = SOURCE.replace(/^export const meta =/, 'const meta =');
  return acorn.parse(`async function __s() {\n${body}\n}`, { ecmaVersion: 'latest', sourceType: 'module' });
}

const AST = parseScript();
const OFFSET = 'async function __s() {\n'.length - 'export '.length;

function literalOf(name) {
  const decl = AST.body[0].body.body.filter((s) => s.type === 'VariableDeclaration').flatMap((s) => s.declarations).find((d) => d.id.name === name);
  assert.ok(decl, `script に ${name} の定数が無い`);
  const text = SOURCE.slice(decl.init.start - OFFSET, decl.init.end - OFFSET);
  return Function(`"use strict"; return (${text});`)();
}

function scriptFunction(names) {
  const decls = AST.body[0].body.body.filter((s) => s.type === 'FunctionDeclaration' && names.includes(s.id.name));
  const text = decls.map((d) => SOURCE.slice(d.start - OFFSET, d.end - OFFSET)).join('\n');
  const consts = ['GROUND_INSTRUCTION'].map((n) => `const ${n} = ${JSON.stringify(literalOf(n))};`).join('\n');
  return Function(`"use strict"; ${consts}\n${text}\nreturn { ${names.join(', ')} };`)();
}

const COPIED = ['OPS', 'STAGE', 'CODES', 'FUNCTION', 'STOP_KINDS', 'NEXT_ARGS_KEYS', 'LIMIT_KEYS', 'INPUT_KEYS', 'RESULT_KEYS', 'RUN_VIEWPOINTS',
  'GOAL_KEYS', 'SOURCE_KINDS', 'GROUND_INSTRUCTION', 'UNIT_RESULTS', 'UNCHECKED_KINDS', 'CONTRACT_ELEMENTS', 'GATE_NEXT', 'LIMIT_HITS', 'CRITERIA_DIR', 'CRITERIA_FILES',
  'ROLE_WRITE_LIMITS', 'STOP_CAUSES', 'FILE_ACTIONS', 'ASSIGN_RULES', 'STAGE_STATUS', 'CONTRACT_NONE', 'JUDGEMENTS', 'REFUTATION_VERDICTS', 'VANISH_NONE'];

function scriptLiterals() {
  const top = AST.body[0].body.body;
  const skip = top.filter((s) => (s.type === 'VariableDeclaration' && COPIED.includes(s.declarations[0].id.name)) || (s.type === 'FunctionDeclaration' && s.id.name === 'isTreatedGround'));
  const out = [];
  const visit = (node, parentKey) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach((n) => visit(n, parentKey)); return; }
    if (skip.includes(node)) return;
    if (node.type === 'Property' && node.key.name === 'fields') return;
    if (node.type === 'Literal' && typeof node.value === 'string') out.push({ value: node.value, line: SOURCE.slice(0, node.start - OFFSET).split('\n').length });
    if (node.type === 'TemplateElement') out.push({ value: node.value.cooked, line: SOURCE.slice(0, node.start - OFFSET).split('\n').length });
    for (const k of Object.keys(node)) if (k !== 'type' && k !== 'start' && k !== 'end') visit(node[k], k);
  };
  visit(AST.body[0].body.body);
  return out;
}

// 写しの定数を照らしても、本文が閉集合の値をリテラルで書き直すと、CLI の値が変わったときに本文だけ古いまま残る
// （模擬の agent は schema を見ないので結合テストでも落ちない）。report の欄の名前（fields）と、CLI の関数と振る舞いで照らす isTreatedGround は除く。
test('SP-BPRUN-031: script の本文は、写しの定数の閉集合の値をリテラルや prompt の引用で書き直さず、定数から引く', () => {
  const closed = ['FILE_ACTIONS', 'ASSIGN_RULES', 'STAGE_STATUS', 'CONTRACT_NONE', 'JUDGEMENTS', 'REFUTATION_VERDICTS', 'VANISH_NONE', 'LIMIT_HITS', 'UNIT_RESULTS', 'UNCHECKED_KINDS', 'GATE_NEXT', 'STOP_KINDS', 'STOP_CAUSES', 'CODES'];
  const values = new Set(closed.flatMap((n) => { const v = literalOf(n); return typeof v === 'string' ? [v] : Object.values(v); }));
  // 引用の "ok" は応答の予約欄（SP-BPRUN-031）を指し、judgement の ok と字面が同じなので引用の照合から外す。
  const quotedOnly = new Set(['ok']);
  const hits = scriptLiterals().filter((l) => values.has(l.value) || [...l.value.matchAll(/"([^"]+)"/g)].some((m) => values.has(m[1]) && !quotedOnly.has(m[1])));
  assert.deepEqual(hits, []);
});

test('SP-BPFINDINGS-011: script が観点を比べるリテラルは CLI の観点の値にある', () => {
  const used = [...SOURCE.matchAll(/viewpoint === '([^']+)'/g)].map((m) => m[1]);
  assert.ok(used.length > 0);
  for (const v of used) assert.ok(Object.hasOwn(CLI_CONSTANTS.VIEWPOINTS, v), v);
});

test('SP-BPRUN-031・TBD-SBPRUN-001 の保持規則: script の定数の写しが CLI の定数と深く一致する', () => {
  for (const name of COPIED) assert.deepEqual(literalOf(name), JSON.parse(JSON.stringify(CLI_CONSTANTS[name])), name);
});

test('SP-BPRUN-038: script の段の名前と meta.phases の title が CLI の段の名前と一致し、create・update の段の表の順に並ぶ', () => {
  const titles = literalOf('STAGE_TITLES');
  for (const [slug, title] of Object.entries(titles)) assert.equal(CLI_CONSTANTS.STAGES[slug], title, slug);
  const phases = literalOf('meta').phases.map((p) => p.title);
  assert.deepEqual(phases, Object.values(titles));
  const table = tableAfter(AUTHORING, '| 段 | 項目 | 起動する役 | 定める仕様項目 |').map(([name]) => name);
  const order = ['開始', '作り直す前の写し', '目標の固定', '書く', '台帳', '検証', '追加の検証', '反証', '消えた資産の照合', '見直し', '合否'];
  assert.deepEqual(order.filter((n) => table.includes(n)), table);
  assert.deepEqual(phases, order);
});

test('SP-BPRUN-023・SP-BPCONFORMANCE-035: script の役ごとの model と effort が bp-conformance の best-practices の役の表と一致する', () => {
  const rows = tableAfter(CONFORMANCE, '| best-practices の役 | `model` | `effort` |');
  const roles = { 書き手: 'writer', 検証役: 'verifier', 反証役: 'refuter', 抽出役: 'extractor', 運搬役: 'carrier' };
  const spec = Object.fromEntries(rows.map(([role, model, effort]) => [roles[role], { model: model.replace(/`/g, ''), effort: effort.replace(/`/g, '') }]));
  assert.deepEqual(literalOf('ROLE_MODELS'), spec);
});

test('SP-BPCONFORMANCE-027〜031・SP-BPCONFORMANCE-036: script の上限の定数が bp-conformance の確定値と一致する', () => {
  const value = (id, unit) => Number(new RegExp(`#### ${id}[\\s\\S]*?(\\d+) ${unit}以下`).exec(CONFORMANCE)[1]);
  assert.equal(literalOf('CONCURRENCY'), value('SP-BPCONFORMANCE-027', '体'));
  assert.deepEqual(literalOf('LIMITS'), {
    untilPass: value('SP-BPCONFORMANCE-028', '回'),
    iterations: value('SP-BPCONFORMANCE-029', '回'),
    attempts: value('SP-BPCONFORMANCE-031', '回'),
  });
});

function seeded(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0; return s / 2 ** 32; };
}

function randomValue(rand, depth = 0) {
  const pool = ['あ', '設計', '😀', '\ud83d', 'a"b', '\\', '\n', 'x', '漢字テキスト', ''];
  const kind = depth > 3 ? Math.floor(rand() * 4) : Math.floor(rand() * 6);
  if (kind === 0) return pool[Math.floor(rand() * pool.length)] + pool[Math.floor(rand() * pool.length)];
  if (kind === 1) return Math.floor(rand() * 1e6) - 5e5;
  if (kind === 2) return rand() < 0.5;
  if (kind === 3) return null;
  if (kind === 4) return Array.from({ length: Math.floor(rand() * 4) }, () => randomValue(rand, depth + 1));
  const keys = Array.from({ length: Math.floor(rand() * 5) }, () => pool[Math.floor(rand() * pool.length)] + Math.floor(rand() * 9));
  return Object.fromEntries(keys.map((k) => [k, randomValue(rand, depth + 1)]));
}

test('SP-BPRUN-031: script の fnvSum が CLI の sum と 500 個の値（日本語・サロゲート・入れ子・キーの順違い）で一致する', () => {
  const { fnvSum } = scriptFunction(['canonical', 'fnvSum']);
  const rand = seeded(20261021);
  for (let i = 0; i < 500; i += 1) {
    const v = randomValue(rand);
    assert.equal(fnvSum(v), cliSum(v), JSON.stringify(v));
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const reversed = Object.fromEntries(Object.entries(v).reverse());
      assert.equal(fnvSum(reversed), cliSum(v));
    }
  }
});

test('SP-BPFINDINGS-031・SP-BPAUTHORING-029: script と CLI が修正の根拠として扱う根拠を同じに決める', () => {
  const { isTreatedGround } = scriptFunction(['isTreatedGround']);
  const cases = [
    { kind: '利用者の指示', text: 'a' }, { kind: '利用者の指示' }, { text: 'a' }, { id: 'F1', state: 'open' }, { id: 'F1', state: 'dismissed' },
    { state: 'open' }, { kind: '利用者の指示', text: 'a', state: 'resolved' }, null, 'x', [], {},
  ];
  for (const c of cases) assert.equal(isTreatedGround(c), cliTreated(c), JSON.stringify(c));
});

function spellings(text, marker, column) {
  const rows = tableAfter(text, marker);
  return rows.flatMap((r) => [...r[column].matchAll(/`([A-Za-z]+)`/g)].map((m) => m[1]));
}

test('TBD-SBPENTRY-002 の書き戻し: SP-BPENTRY-013 の綴りの表と script・CLI の入力の綴りが一致する', () => {
  const spec = spellings(ENTRY, '| 項目 | 綴り | 渡すとき |', 1);
  assert.deepEqual(spec.sort(), Object.values(literalOf('INPUT_KEYS')).sort());
  assert.deepEqual(literalOf('INPUT_KEYS'), JSON.parse(JSON.stringify(CLI_CONSTANTS.INPUT_KEYS)));
});

test('TBD-SBPAUTHORING-001 の書き戻し・SP-BPINSPECTION-024・SP-BPFINDINGS-030: SP-BPRUN-032・SP-BPAUTHORING-032〜034・SP-BPINSPECTION-024・SP-BPFINDINGS-030 の綴りの列が CLI の返り値の綴りと一致する', () => {
  const common = spellings(RUN, '| 項目 | 綴り | 返すとき |', 1);
  const complete = spellings(AUTHORING, '| 条件: 機能 | 条件: 項目 | 綴り | 結果 |', 2);
  const stopped = spellings(AUTHORING, '| 項目 | 綴り | 中身 |', 1);
  const verification = spellings(AUTHORING, '| 項目 | 綴り | 中身（検証の結果） |', 1);
  const inspected = spellings(INSPECTION, '| 項目 | 綴り | 機能 | 中身 |', 1);
  const ledgerItems = spellings(FINDINGS, '| 項目 | review・audit の綴り | 中身 |', 1);
  assert.deepEqual([...new Set([...common, ...complete, ...stopped, ...inspected, ...ledgerItems])].sort(), Object.values(CLI_CONSTANTS.RESULT_KEYS).sort());
  assert.deepEqual([...new Set(verification)].sort(), Object.values(CLI_CONSTANTS.VERIFICATION_KEYS).sort());
});

test('TBD-SBPRUN-003 の書き戻し: 仕様に書いた create・update の最小の起動数と段ごとの最悪の回数が script の定数から計算した値と一致する', () => {
  const worst = literalOf('RESERVE');
  const m = /create の最小の起動数は (\d+)、update は (\d+) とする/.exec(RUN);
  assert.ok(m, 'SP-BPRUN-021 に最小の起動数の書き戻しが無い');
  const limits = literalOf('LIMITS');
  const w = Function('LIMITS', `return (${SOURCE.slice(SOURCE.indexOf('const WORST = ') + 'const WORST = '.length, SOURCE.indexOf('\nconst RESERVE'))});`)(limits);
  const min = (fn) => w.start + w.resumeDiscard + (fn === 'update' ? w.carrier : 0) + w.carrier + limits.untilPass * w.goalAttempt + w.carrier + w.write + w.item + worst;
  assert.deepEqual([Number(m[1]), Number(m[2])], [min('create'), min('update')]);
  const row = (name) => Number(new RegExp(`\\| ${name} \\| (\\d+) \\|`).exec(RUN)?.[1]);
  assert.deepEqual([row('`worst\\(再開の破棄\\)`'), row('`worst\\(開始\\)`'), row('`worst\\(fan-out の項目\\)`'), row('`worst\\(目標の固定の 1 回\\)`'), row('`worst\\(書く\\)`'), row('`R`（予約分）')], [w.resumeDiscard, w.start, w.item, w.goalAttempt, w.write, worst]);
});
