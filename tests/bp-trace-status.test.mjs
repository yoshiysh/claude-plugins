import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tableAfter } from './helpers/bp-docs.mjs';
import { confirmedKeys, readRecords, rowKey } from '../tools/read-bp-trial.mjs';
import { TRACE_STATUS, traceRows as sharedTraceRows } from '../tools/lib/bp-docs.mjs';
import { RUNS_FILE, TRIAL_DIR, readRuns } from '../tools/bp-trial.mjs';
import { loadConfig } from '../scripts/traceability/specs.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SPECS = path.join(ROOT, 'docs', 'specifications');
const SKILL = path.join(ROOT, 'plugins', 'skill-creator', 'skills', 'skill-creator-best-practices');
// 仕様書の集合はトレーサビリティ検査の設定を正本にする（集合を別に持つと、片方だけを通る「完了」の行ができる）。
const CONFIG = await loadConfig(path.join(ROOT, 'traceability.config.json'));

// 試走と eval の行は名前の付いたテストでは縛れないので、記録と正解表から毎回計算した集合だけが「完了」を許す（手で足す集合を持たない）。
const TRIAL_ROWS = readRecords();
const CONFIRMED = confirmedKeys(TRIAL_ROWS);

function traceRows(file) {
  return sharedTraceRows(file, SPECS);
}

// bp-run.md の「検証方法」の見分け方の表を正本にし、テストに見分け方を書き写さない。
function trialRules() {
  const rows = tableAfter(readFileSync(path.join(SPECS, 'bp-run.md'), 'utf8'), '| 仕様書 | 試走で確かめる行 |');
  return rows.map(([file, rule]) => {
    const name = /^`([^`]+)`$/.exec(file)[1];
    const prefix = /検証方法の列が `([^`]+)` で始まる/.exec(rule);
    if (prefix) return { file: name, isTrial: (r) => r.method.startsWith(prefix[1]) };
    if (!/「検証方法」の試走の表/.test(rule)) throw new Error(`見分け方を読めない: ${rule}`);
    const table = tableAfter(readFileSync(path.join(SPECS, name), 'utf8'), '| 要求 ID | 仕様項目 ID | 測る試走 |');
    const how = new Map(table.map(([req, spec, h]) => [`${req}|${spec}`, h]));
    return { file: name, pairs: [...how.keys()], how, isTrial: (r) => how.has(`${r.req}|${r.spec}`) };
  });
}

// 正解表の行は、トレーサビリティ表にあり、試走か eval で確かめる行で、測る試走が「無し」でない行だけ（表に無い行の記録は、どの行も「完了」にしない）。
function expectedProblems(rows, rules) {
  const problems = [];
  for (const r of rows) {
    const rule = rules.find((x) => x.file === r.file);
    const row = rule && traceRows(r.file).find((t) => t.req === r.req && t.spec === r.spec && t.method === r.method);
    if (!row) { problems.push(`トレーサビリティ表に無い: ${rowKey(r)}`); continue; }
    if (!rule.isTrial(row)) { problems.push(`試走で確かめる行でない: ${rowKey(r)}`); continue; }
    if (rule.how?.get(`${r.req}|${r.spec}`).startsWith('無し')) problems.push(`測る試走が無い: ${rowKey(r)}`);
  }
  return problems;
}

const SPEC_FILES = CONFIG.specFiles.map((f) => path.relative(realpathSync(SPECS), path.join(CONFIG.root, f)));

// 「完了」の行に成功したテストがあるかは make test のトレーサビリティ検査（scripts/traceability）が見る。ここは名前の付いたテストで縛れない試走の行だけを見る。
// 試走の行は模擬の検証役でも名前の付いたテストが通ってしまうので、テスト名の有無では「完了」を縛れない。
test('検証方法: 試走と eval で確かめる行は、記録と正解表から計算した集合にあるときだけ「完了」で、見分け方の表が指す行は全てトレーサビリティ表にある', () => {
  const rules = trialRules();
  assert.deepEqual(rules.map((r) => r.file).sort(), ['bp-authoring.md', 'bp-conformance.md', 'bp-entry.md', 'bp-inspection.md']);
  const early = [];
  let trial = 0;
  for (const rule of rules) {
    const rows = traceRows(rule.file);
    for (const pair of rule.pairs ?? []) assert.ok(rows.some((r) => `${r.req}|${r.spec}` === pair), `${rule.file}: 試走の表の行がトレーサビリティ表に無い: ${pair}`);
    for (const r of rows.filter(rule.isTrial)) {
      trial += 1;
      if (r.status === TRACE_STATUS.done && !CONFIRMED.has(rowKey(r))) early.push(`${r.file}: ${r.req} ${r.spec} ${r.method}`);
    }
  }
  assert.ok(trial > 0);
  assert.deepEqual(early, []);
});

test('検証方法: 試走の正解表の全ての行は、トレーサビリティ表にある試走の行で、測る試走が「無し」の行を含まず、runs.json の全ての正解表のファイルがある', () => {
  const rules = trialRules();
  assert.deepEqual(expectedProblems(TRIAL_ROWS, rules), []);
  const runs = readRuns(RUNS_FILE);
  const files = Object.values(runs).flatMap((r) => r.expected);
  assert.ok(files.length > 0);
  for (const f of files) assert.ok(statSync(path.join(TRIAL_DIR, f)).isFile(), f);
  const C = 'bp-conformance.md';
  const bad = [
    { file: C, req: 'PR-BPDESIGNEDSKILL-999', spec: 'SP-BPCONFORMANCE-006', method: 'x' },
    { file: C, req: 'PR-BPDESIGNEDSKILL-017', spec: 'SP-BPCONFORMANCE-022', method: traceRows(C).find((r) => r.req === 'PR-BPDESIGNEDSKILL-017').method },
    { file: C, req: 'PR-BPDESIGNEDSKILL-001', spec: 'SP-BPCONFORMANCE-001, SP-BPCONFORMANCE-003, SP-BPCONFORMANCE-004', method: traceRows(C).find((r) => r.req === 'PR-BPDESIGNEDSKILL-001').method },
  ];
  assert.equal(expectedProblems(bad, rules).length, bad.length);
});

// 列の数・ステータスの語彙・仕様項目 ID の形の検査は traceRows が持つ（ここに写さない）。
test('検証方法: best-practices の仕様書のトレーサビリティ表を、行の形を検査する読み取りで全て読め、仕様書は仕様書の置き場にある', () => {
  assert.ok(SPEC_FILES.length > 0 && SPEC_FILES.every((f) => !f.startsWith('..')));
  assert.ok(SPEC_FILES.flatMap(traceRows).length > 100);
});

function filesUnder(dir, keep) {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    return statSync(p).isDirectory() ? filesUnder(p, keep) : keep(p) ? [p] : [];
  });
}

// 計画の段の語は読み手に経緯を持ち込み、段が変わると黙って嘘になる。経緯は commit message と PR 本文に置く。
test('規約: best-practices の配布物・テスト・仕様書・要求文書に、作り直しの段を指す語が無い', () => {
  const STAGE_WORD = new RegExp(['[0-9０-９一二三四五]\\s?段目', 'まだ' + '本番', '別の段で' + '置く', '置かれる' + '前', '置かれる' + 'まで'].join('|'));
  const files = [
    ...filesUnder(path.join(SKILL, 'scripts'), (p) => /\.(m?js|py)$/.test(p)),
    ...filesUnder(path.join(ROOT, 'tests'), (p) => /[/\\](bp-[^/\\]*\.(m?js)|bp-trial[/\\].*)$/.test(p) && p !== fileURLToPath(import.meta.url)),
    ...filesUnder(path.join(ROOT, 'tools'), (p) => /[/\\][^/\\]*bp[^/\\]*\.mjs$/.test(p)),
    ...SPEC_FILES.map((f) => path.join(SPECS, f)),
    ...readdirSync(path.join(ROOT, 'docs', 'requirements')).filter((f) => /^bp-.*\.md$/.test(f)).map((f) => path.join(ROOT, 'docs', 'requirements', f)),
  ];
  assert.ok(files.length > 20);
  const hits = files.flatMap((f) => readFileSync(f, 'utf8').split('\n').map((l, i) => [f, i + 1, l]).filter(([, , l]) => STAGE_WORD.test(l)).map(([f, i]) => `${path.relative(ROOT, f)}:${i}`));
  assert.deepEqual(hits, []);
});
