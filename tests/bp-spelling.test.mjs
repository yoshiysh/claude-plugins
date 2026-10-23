import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CODES, ENTRY_OPS, NEXT_ARGS_KEYS, OPS, STAGES, VIEWPOINTS, WORKFLOW_SOURCES } from '../plugins/skill-creator/skills/skill-creator-best-practices/scripts/bp/constants.mjs';
import { tableAfter } from './helpers/bp-docs.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUN = readFileSync(path.join(ROOT, 'docs', 'specifications', 'bp-run.md'), 'utf8');
const FINDINGS = readFileSync(path.join(ROOT, 'docs', 'specifications', 'bp-findings.md'), 'utf8');

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

test('SP-BPRUN-031: 仕様の操作の表と CLI の定数（run の中の操作と入口の操作）が一致し、2 つの集合が交わらない', () => {
  const rows = tableAfter(RUN, '| 操作 | 実現する項目 | 受け取るもの | 返すもの |');
  const spec = rows.map(([cell]) => cell.replace(/`/g, ''));
  assert.deepEqual(spec.sort(), [...Object.values(OPS), ...Object.values(ENTRY_OPS)].sort());
  assert.deepEqual(Object.values(OPS).filter((op) => Object.values(ENTRY_OPS).includes(op)), []);
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

// ---- script の写しを CLI の定数と仕様の表に照らす（script は import できないので写しを持つ。写しの照合漏れと、仕様の表と応答の形のずれを止める）

import { createRequire } from 'node:module';
import * as CLI_CONSTANTS from '../plugins/skill-creator/skills/skill-creator-best-practices/scripts/bp/constants.mjs';
import { sum as cliSum } from '../plugins/skill-creator/skills/skill-creator-best-practices/scripts/bp/ids.mjs';
import { isTreatedGround as cliTreated } from '../plugins/skill-creator/skills/skill-creator-best-practices/scripts/bp/ops-author.mjs';

const SCRIPT_DIR = path.join(ROOT, 'plugins', 'skill-creator', 'skills', 'skill-creator-best-practices', 'scripts');
const AUTHORING = readFileSync(path.join(ROOT, 'docs', 'specifications', 'bp-authoring.md'), 'utf8');
const CONFORMANCE = readFileSync(path.join(ROOT, 'docs', 'specifications', 'bp-conformance.md'), 'utf8');
const ENTRY = readFileSync(path.join(ROOT, 'docs', 'specifications', 'bp-entry.md'), 'utf8');
const INSPECTION = readFileSync(path.join(ROOT, 'docs', 'specifications', 'bp-inspection.md'), 'utf8');
const acorn = createRequire(path.join(ROOT, 'plugins', 'workflow', 'skills', 'dynamic-workflow-runner', 'scripts', 'runtime', 'package.json'))('acorn');
const OFFSET = 'async function __s() {\n'.length - 'export '.length;

// 写しの定数のうち閉集合として本文のリテラルを照らさないもの。鍵・欄・操作の名前の集合で、本文の欄名・観点の値・英単語と字面がぶつかる（観点の値は SP-BPFINDINGS-011 のテストが別に照らす）。
const NOT_CLOSED = {
  OPS: '操作の名前。運搬役の要求の op として定数から引き、CLI の実行が照らす',
  STAGE: '段の slug。観点の値（goal）と同じ字面を持つ',
  INSPECT_PIPELINE: '段の slug の並び。STAGE と同じ',
  FUNCTION: '機能の名前。prompt の文に機能を名指す語として現れる',
  NEXT_ARGS_KEYS: '欄の名前', LIMIT_KEYS: '欄の名前', INPUT_KEYS: '欄の名前', RESULT_KEYS: '欄の名前', GOAL_KEYS: '欄の名前',
  RUN_VIEWPOINTS: '観点の値（SP-BPFINDINGS-011 のテストが照らす）',
  SOURCE_KINDS: 'schema の enum と prompt の例示で定数から引く。例示の "kind" の値はテストが別に照らす（SP-BPAUTHORING-006）',
  GROUND_INSTRUCTION: '欄の名前と種別の文言。CLI の関数と振る舞いで照らす',
  GROUND_REF_KEY: '欄の名前。CLI の関数と振る舞いで照らす',
  CONTRACT_ELEMENTS: '契約の要素の文言。prompt に要素の名前として並べる',
  CRITERIA_DIR: 'パス', CRITERIA_FILES: 'パス',
  ROLE_WRITE_LIMITS: '返り値に載せる役の文言', INSPECT_ROLE_WRITE_LIMITS: '返り値に載せる役の文言',
};

const SCRIPTS = {
  author: {
    file: 'bp_author.js',
    copied: ['OPS', 'STAGE', 'CODES', 'FUNCTION', 'STOP_KINDS', 'NEXT_ARGS_KEYS', 'LIMIT_KEYS', 'INPUT_KEYS', 'RESULT_KEYS', 'RUN_VIEWPOINTS',
      'GOAL_KEYS', 'SOURCE_KINDS', 'GROUND_INSTRUCTION', 'GROUND_REF_KEY', 'UNIT_RESULTS', 'UNCHECKED_KINDS', 'CONTRACT_ELEMENTS', 'GATE_NEXT', 'LIMIT_HITS', 'CRITERIA_DIR', 'CRITERIA_FILES',
      'ROLE_WRITE_LIMITS', 'STOP_CAUSES', 'FILE_ACTIONS', 'ASSIGN_RULES', 'STAGE_STATUS', 'CONTRACT_NONE', 'JUDGEMENTS', 'REFUTATION_VERDICTS', 'VANISH_NONE'],
    skipFunctions: ['isTreatedGround'],
  },
  inspect: {
    file: 'bp_inspect.js',
    copied: ['OPS', 'STAGE', 'CODES', 'FUNCTION', 'STOP_KINDS', 'NEXT_ARGS_KEYS', 'LIMIT_KEYS', 'INPUT_KEYS', 'RESULT_KEYS', 'RUN_VIEWPOINTS',
      'INSPECT_PIPELINE', 'LIMIT_HITS', 'ASSIGN_RULES', 'JUDGEMENTS', 'REFUTATION_VERDICTS', 'VANISH_NONE', 'STOP_CAUSES', 'APPLICABILITY_QUESTIONS',
      'APPLICABILITY_ANSWERS', 'PRESENCE', 'UNCHECKED_SCOPES', 'INSPECT_ROLE_WRITE_LIMITS', 'PRESENCE_QUESTIONS', 'TARGET_FILES'],
    skipFunctions: [],
  },
};

for (const s of Object.values(SCRIPTS)) {
  s.source = readFileSync(path.join(SCRIPT_DIR, s.file), 'utf8');
  s.ast = acorn.parse(`async function __s() {\n${s.source.replace(/^export const meta =/, 'const meta =')}\n}`, { ecmaVersion: 'latest', sourceType: 'module' });
  s.top = s.ast.body[0].body.body;
}

function literalIn(s, name) {
  const decl = s.top.filter((x) => x.type === 'VariableDeclaration').flatMap((x) => x.declarations).find((d) => d.id.name === name);
  assert.ok(decl, `${s.file} に ${name} の定数が無い`);
  const text = s.source.slice(decl.init.start - OFFSET, decl.init.end - OFFSET);
  return Function(`"use strict"; return (${text});`)();
}

const SOURCE = SCRIPTS.author.source;
const literalOf = (name) => literalIn(SCRIPTS.author, name);

function scriptFunction(names) {
  const s = SCRIPTS.author;
  const decls = s.top.filter((x) => x.type === 'FunctionDeclaration' && names.includes(x.id.name));
  const text = decls.map((d) => s.source.slice(d.start - OFFSET, d.end - OFFSET)).join('\n');
  const consts = ['GROUND_INSTRUCTION', 'GROUND_REF_KEY'].map((n) => `const ${n} = ${JSON.stringify(literalOf(n))};`).join('\n');
  return Function(`"use strict"; ${consts}\n${text}\nreturn { ${names.join(', ')} };`)();
}

function scriptLiterals(s) {
  const skip = s.top.filter((x) => (x.type === 'VariableDeclaration' && s.copied.includes(x.declarations[0].id.name)) || (x.type === 'FunctionDeclaration' && s.skipFunctions.includes(x.id.name)));
  const out = [];
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (skip.includes(node)) return;
    if (node.type === 'Property' && node.key.name === 'fields') return;
    if (node.type === 'Literal' && typeof node.value === 'string') out.push({ value: node.value, line: s.source.slice(0, node.start - OFFSET).split('\n').length });
    if (node.type === 'TemplateElement') out.push({ value: node.value.cooked, line: s.source.slice(0, node.start - OFFSET).split('\n').length });
    for (const k of Object.keys(node)) if (k !== 'type' && k !== 'start' && k !== 'end') visit(node[k]);
  };
  visit(s.top);
  return out;
}

for (const [label, s] of Object.entries(SCRIPTS)) {
  // 写しの定数を照らしても、本文が閉集合の値をリテラルで書き直すと、CLI の値が変わったときに本文だけ古いまま残る
  // （模擬の agent は schema を見ないので結合テストでも落ちない）。閉集合は写しから NOT_CLOSED を引いたもので、新しく写した定数は既定で照らす。
  test(`SP-BPRUN-031: ${s.file} の本文は、写しの定数の閉集合の値をリテラルや prompt の引用で書き直さず、定数から引く`, () => {
    const closed = s.copied.filter((n) => !Object.hasOwn(NOT_CLOSED, n));
    assert.ok(closed.length > 0);
    const values = new Set(closed.flatMap((n) => { const v = literalIn(s, n); return typeof v === 'string' ? [v] : Object.values(v).flat(); }));
    // 引用の "ok" は応答の予約欄（SP-BPRUN-031）を指し、judgement の ok と字面が同じなので引用の照合から外す。
    const quotedOnly = new Set(['ok']);
    const hits = scriptLiterals(s).filter((l) => values.has(l.value) || [...l.value.matchAll(/"([^"]+)"/g)].some((m) => values.has(m[1]) && !quotedOnly.has(m[1])));
    assert.deepEqual(hits, []);
  });

  test(`SP-BPRUN-031: ${s.file} の定数の写しが CLI の定数と深く一致し、CLI の定数と同じ名前の最上位の定数は全て照合に入っている`, () => {
    for (const name of s.copied) assert.deepEqual(literalIn(s, name), JSON.parse(JSON.stringify(CLI_CONSTANTS[name])), `${label}: ${name}`);
    const names = s.top.filter((x) => x.type === 'VariableDeclaration').map((x) => x.declarations[0].id.name);
    const stray = names.filter((n) => Object.hasOwn(CLI_CONSTANTS, n) && !s.copied.includes(n));
    assert.deepEqual(stray, [], `${label}: CLI の定数と同じ名前なのに照合に入っていない`);
    for (const n of Object.keys(NOT_CLOSED)) assert.ok(Object.hasOwn(CLI_CONSTANTS, n), `NOT_CLOSED の名前が CLI の定数に無い: ${n}`);
  });

  test(`SP-BPFINDINGS-011: ${s.file} が観点を比べるリテラルは CLI の観点の値にある`, () => {
    // 選択肢ごとに別に走査する（1 つの正規表現の選択肢にすると、前の選択肢が先に当たって三項の結果を拾わない）。
    const patterns = [/viewpoint === '([^']+)'/g, /target(?:Of|File)\('([^']+)'/g, /viewpoint === '[^']+' \? '([^']+)' : /g, /viewpoint === '[^']+' \? '[^']+' : '([^']+)'/g];
    const used = patterns.flatMap((re) => [...s.source.matchAll(re)].map((m) => m[1]));
    if (s.file === 'bp_inspect.js') assert.ok(patterns.slice(2).some((re) => re.test(s.source)), '三項の観点のリテラルを拾っていない');
    assert.ok(used.length > 0);
    for (const v of used) assert.ok(Object.hasOwn(CLI_CONSTANTS.VIEWPOINTS, v), v);
  });

  test(`SP-BPRUN-023・SP-BPCONFORMANCE-035: ${s.file} の役ごとの model と effort が bp-conformance の best-practices の役の表と一致する`, () => {
    const rows = tableAfter(CONFORMANCE, '| best-practices の役 | `model` | `effort` |');
    const roles = { 書き手: 'writer', 検証役: 'verifier', 反証役: 'refuter', 抽出役: 'extractor', 運搬役: 'carrier' };
    const spec = Object.fromEntries(rows.map(([role, model, effort]) => [roles[role], { model: model.replace(/`/g, ''), effort: effort.replace(/`/g, '') }]));
    assert.deepEqual(literalIn(s, 'ROLE_MODELS'), spec);
  });

  test(`SP-BPCONFORMANCE-027〜031・SP-BPCONFORMANCE-036: ${s.file} の上限の定数が bp-conformance の確定値と一致する`, () => {
    const value = (id, unit) => Number(new RegExp(`#### ${id}[\\s\\S]*?(\\d+) ${unit}以下`).exec(CONFORMANCE)[1]);
    assert.equal(literalIn(s, 'CONCURRENCY'), value('SP-BPCONFORMANCE-027', '体'));
    assert.deepEqual(literalIn(s, 'LIMITS'), {
      untilPass: value('SP-BPCONFORMANCE-028', '回'),
      iterations: value('SP-BPCONFORMANCE-029', '回'),
      attempts: value('SP-BPCONFORMANCE-031', '回'),
    });
  });
}

test('SP-BPRUN-021: 仕様に書いた review・audit の最小の起動数と段ごとの最悪の回数が bp_inspect.js の定数から計算した値と一致する', () => {
  const s = SCRIPTS.inspect;
  const m = /review の最小の起動数は (\d+)、audit は (\d+) とする/.exec(RUN);
  assert.ok(m, 'SP-BPRUN-021 に review・audit の最小の起動数の書き戻しが無い');
  const limits = literalIn(s, 'LIMITS');
  const reserve = literalIn(s, 'RESERVE');
  const w = Function('LIMITS', `return (${s.source.slice(s.source.indexOf('const WORST = ') + 'const WORST = '.length, s.source.indexOf('\nconst RESERVE'))});`)(limits);
  const min = (fn) => w.start + w.targets + w.bundle + limits.attempts * w.attempt + (fn === 'review' ? limits.attempts * w.attempt : w.carrier) + w.item + reserve;
  assert.deepEqual([Number(m[1]), Number(m[2])], [min('review'), min('audit')]);
  const section = RUN.slice(RUN.indexOf('review・audit の段ごとの最悪の回数は次の表とする'));
  const row = (name) => Number(new RegExp(`\\| ${name} \\| (\\d+) \\|`).exec(section)?.[1]);
  assert.deepEqual([row('`worst\\(開始\\)`'), row('`worst\\(照らす先\\)`'), row('`worst\\(束\\)`'), row('`worst\\(fan-out でない段の 1 回\\)`'), row('`worst\\(段の境の運搬役\\)`'), row('`worst\\(fan-out の項目\\)`'), row('`R`（予約分）')],
    [w.start, w.targets, w.bundle, w.attempt, w.carrier, w.item, reserve]);
  const fnText = s.source.slice(s.source.indexOf('function minimalLaunches'), s.source.indexOf('\n}\n', s.source.indexOf('function minimalLaunches')));
  assert.equal(Function('WORST', 'LIMITS', 'RESERVE', 'FUNCTION', `${fnText}\n}\nreturn [minimalLaunches('review'), minimalLaunches('audit')];`)(w, limits, reserve, { review: 'review', audit: 'audit' }).join(','), `${m[1]},${m[2]}`);
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

test('SP-BPFINDINGS-031・SP-BPAUTHORING-029: script と CLI が修正の根拠として扱う根拠（参照の形を含む）を同じに決める', () => {
  const { isTreatedGround } = scriptFunction(['isTreatedGround']);
  const cases = [
    { kind: '利用者の指示', text: 'a' }, { kind: '利用者の指示' }, { text: 'a' }, { id: 'F1', state: 'open' }, { id: 'F1', state: 'dismissed' },
    { state: 'open' }, { kind: '利用者の指示', text: 'a', state: 'resolved' }, null, 'x', [], {},
    { from: 'bp-20261023000000-abcdefgh' }, { from: 1 }, { from: 'bp-x', state: 'open' }, { from: 'bp-x', kind: '利用者の指示', text: 'a' },
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
  const inspectStopped = spellings(INSPECTION, '| 項目 | 綴り | 中身（完了以外） |', 1);
  const ledgerItems = spellings(FINDINGS, '| 項目 | review・audit の綴り | 中身 |', 1);
  assert.deepEqual([...new Set([...common, ...complete, ...stopped, ...inspected, ...inspectStopped, ...ledgerItems])].sort(), Object.values(CLI_CONSTANTS.RESULT_KEYS).sort());
  assert.deepEqual([...new Set(verification)].sort(), Object.values(CLI_CONSTANTS.VERIFICATION_KEYS).sort());
});

test('SP-BPRUN-021: 仕様に書いた create・update の最小の起動数と段ごとの最悪の回数が script の定数から計算した値と一致する', () => {
  const worst = literalOf('RESERVE');
  const m = /create の最小の起動数は (\d+)、update は (\d+) とする/.exec(RUN);
  assert.ok(m, 'SP-BPRUN-021 に最小の起動数の書き戻しが無い');
  const limits = literalOf('LIMITS');
  const w = Function('LIMITS', `return (${SOURCE.slice(SOURCE.indexOf('const WORST = ') + 'const WORST = '.length, SOURCE.indexOf('\nconst RESERVE'))});`)(limits);
  const min = (fn) => w.start + w.resumeDiscard + (fn === 'update' ? w.carrier : 0) + w.carrier + limits.untilPass * w.goalAttempt + w.carrier + w.write + w.item + worst;
  assert.deepEqual([Number(m[1]), Number(m[2])], [min('create'), min('update')]);
  const row = (name) => Number(new RegExp(`\\| ${name} \\| (\\d+) \\|`).exec(RUN)?.[1]);
  assert.deepEqual([row('`worst\\(再開の破棄\\)`'), row('`worst\\(開始\\)`'), row('`worst\\(fan-out の項目\\)`'), row('`worst\\(目標の固定の 1 回\\)`'), row('`worst\\(書く\\)`'), row('`worst\\(段の境の運搬役\\)`'), row('`R`（予約分）')], [w.resumeDiscard, w.start, w.item, w.goalAttempt, w.write, w.carrier, worst]);
});

test('SP-BPRUN-031・SP-BPINSPECTION-004: targets の操作の出力の欄と files の name・section の値が、仕様の操作の表の targets の行と CLI の定数に一致する', async () => {
  const row = RUN.split('\n').find((l) => l.startsWith('| `targets` |'));
  const { readTargets } = await import('../plugins/skill-creator/skills/skill-creator-best-practices/scripts/bp/targets.mjs');
  const out = readTargets({ criteriaDir: path.join(ROOT, 'docs'), promptAudit: path.join(SCRIPT_DIR, '..', 'references', 'prompt-audit.md') }, 'review');
  for (const key of Object.keys(out.targets[0])) assert.ok(row.includes(`\`${key}\``), key);
  for (const key of ['name', 'path', 'sha256']) assert.ok(row.includes(key), key);
  for (const name of Object.values(CLI_CONSTANTS.TARGET_FILES)) assert.ok(row.includes(`\`${name}\``), name);
  for (const section of [CLI_CONSTANTS.CRITERIA_CHAPTERS.functional, CLI_CONSTANTS.CRITERIA_CHAPTERS.capacityPrefix, CLI_CONSTANTS.PROMPT_AUDIT_SECTION]) assert.ok(row.includes(`「${section}」`), section);
  assert.deepEqual(out.targets.map((t) => t.section), [CLI_CONSTANTS.CRITERIA_CHAPTERS.functional, CLI_CONSTANTS.CRITERIA_CHAPTERS.capacityPrefix]);
});

test('SP-BPRUN-031: CLI の照らす先の決定が名指す判定基準の写しの鍵が CRITERIA_FILES の鍵にある', () => {
  const source = readFileSync(path.join(SCRIPT_DIR, 'bp', 'targets.mjs'), 'utf8');
  const used = [...source.matchAll(/criteriaFile\(ctx, '([^']+)'\)/g)].map((m) => m[1]);
  assert.ok(used.length >= 4);
  for (const key of used) {
    assert.ok(Object.hasOwn(CLI_CONSTANTS.CRITERIA_FILES, key), key);
    assert.ok(Object.hasOwn(CLI_CONSTANTS.TARGET_FILES, key), key);
  }
});

test('SP-BPENTRY-001: 入口が起動する source の名前の定数が 2 本の script の meta.name と一致する', () => {
  assert.equal(literalIn(SCRIPTS.author, 'meta').name, WORKFLOW_SOURCES.author);
  assert.equal(literalIn(SCRIPTS.inspect, 'meta').name, WORKFLOW_SOURCES.inspect);
});
