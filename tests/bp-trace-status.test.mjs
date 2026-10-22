import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tableAfter, testTitles } from './helpers/bp-docs.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SPECS = path.join(ROOT, 'docs', 'specifications');
const SKILL = path.join(ROOT, 'plugins', 'skill-creator', 'skills', 'skill-creator-best-practices');
const TEST_DIRS = [path.join(ROOT, 'tests'), path.join(SKILL, 'scripts', 'bp')];
const TRACE_HEADER = '| 要求 ID | 仕様項目 ID | 検証方法 | ステータス |';
const STATUSES = ['未着手', '作成中', '完了'];
const EXPECTED_TRIAL = JSON.parse(readFileSync(path.join(ROOT, 'tests', 'fixtures', 'bp-trial', 'review-target.expected.json'), 'utf8'));

// 試走の行は名前の付いたテストでは縛れないので、試走の記録で確かめた行（仕様書|要求 ID|仕様項目 ID の列）だけをここに足す。
const TRIAL_CONFIRMED = new Set([]);

function allTitles() {
  return TEST_DIRS.flatMap((dir) => readdirSync(dir).filter((f) => f.endsWith('.test.mjs')).flatMap((f) => testTitles(path.join(dir, f))));
}

// テスト名の「SP-X-027〜031」「SP-X-011〜SP-X-013」は範囲の全ての ID を名指すものとして数える（端だけを拾うと間の ID が漏れる）。
function titleIds(titles) {
  const ids = new Set();
  for (const t of titles) {
    for (const m of t.matchAll(/(SP-[A-Z]+)-(\d{3})(?:〜(?:(SP-[A-Z]+)-)?(\d{3}))?/g)) {
      if (m[3] && m[3] !== m[1]) throw new Error(`範囲の両端の接頭辞が違う: ${m[0]}`);
      const last = Number(m[4] ?? m[2]);
      for (let i = Number(m[2]); i <= last; i += 1) ids.add(`${m[1]}-${String(i).padStart(3, '0')}`);
    }
  }
  return ids;
}

// 行の字面の正規表現で拾うと、書式の崩れた行が検査から黙って消える。
function traceRows(file) {
  return tableAfter(readFileSync(path.join(SPECS, file), 'utf8'), TRACE_HEADER).map(([req, spec, method, status, ...rest]) => (
    { file, req, spec, ids: (spec ?? '').split(',').map((x) => x.trim()), method, status, extra: rest.length }
  ));
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

// 「完了」にしてよいのは、トレーサビリティ表にあり、試走で確かめる行で、試走で全ての句を測れる行だけ（測る試走が無い行・測れない句を持つ行は入れられない）。
function confirmedProblems(confirmed, rules) {
  const problems = [];
  for (const key of confirmed) {
    const [file, req, spec] = key.split('|');
    const rule = rules.find((r) => r.file === file);
    const row = rule && traceRows(file).find((r) => r.req === req && r.spec === spec);
    if (!row) { problems.push(`トレーサビリティ表に無い: ${key}`); continue; }
    if (!rule.isTrial(row)) { problems.push(`試走で確かめる行でない: ${key}`); continue; }
    if (!rule.how) continue;
    if (rule.how.get(`${req}|${spec}`).startsWith('無し')) problems.push(`測る試走が無い: ${key}`);
    const exp = EXPECTED_TRIAL.rows.find((r) => r.req === req && r.spec === spec);
    if (exp && ((exp.unmeasured ?? []).length || Object.values(exp.measures).some((m) => m.by === 'none'))) problems.push(`試走で測れない句がある: ${key}`);
  }
  return problems;
}

const SPEC_FILES = readdirSync(SPECS).filter((f) => /^bp-.*\.md$/.test(f));

// テストの有無しか見ない（確かめ方が行の検証方法に足りるかは見ない。それは生成者と別の検証役が行とテストを突き合わせて見る）。
// 「完了」の行に、テスト名の無い仕様項目が 1 つでもあれば、テストの無い行を「完了」にしている。
test('検証方法: best-practices の仕様書のトレーサビリティ表で「完了」の行の仕様項目 ID が全て、どれかのテスト名に現れる', () => {
  const ids = titleIds(allTitles());
  const missing = [];
  let rows = 0;
  for (const r of SPEC_FILES.flatMap(traceRows).filter((x) => x.status === '完了')) {
    rows += 1;
    for (const id of r.ids) if (!ids.has(id)) missing.push(`${r.file}: ${r.req} ${id}`);
  }
  assert.ok(rows > 0);
  assert.deepEqual([...new Set(missing)], []);
});

test('検証方法: テスト名の仕様項目 ID の範囲は両端の間の全ての ID を名指し、接頭辞の違う範囲を拒否する', () => {
  assert.deepEqual([...titleIds(['SP-BPCONFORMANCE-027〜029・SP-BPRUN-011〜SP-BPRUN-012 と SP-BPRUN-040'])],
    ['SP-BPCONFORMANCE-027', 'SP-BPCONFORMANCE-028', 'SP-BPCONFORMANCE-029', 'SP-BPRUN-011', 'SP-BPRUN-012', 'SP-BPRUN-040']);
  assert.throws(() => titleIds(['SP-BPRUN-011〜SP-BPFINDINGS-013']), /接頭辞が違う/);
});

// 試走の行は模擬の検証役でも名前の付いたテストが通ってしまうので、テスト名の有無では「完了」を縛れない。
test('検証方法: 試走で確かめる行は、試走で確かめた行の集合にあるときだけ「完了」で、見分け方の表が指す行は全てトレーサビリティ表にある', () => {
  const rules = trialRules();
  assert.deepEqual(rules.map((r) => r.file).sort(), ['bp-authoring.md', 'bp-conformance.md', 'bp-inspection.md']);
  const early = [];
  let trial = 0;
  for (const rule of rules) {
    const rows = traceRows(rule.file);
    for (const pair of rule.pairs ?? []) assert.ok(rows.some((r) => `${r.req}|${r.spec}` === pair), `${rule.file}: 試走の表の行がトレーサビリティ表に無い: ${pair}`);
    for (const r of rows.filter(rule.isTrial)) {
      trial += 1;
      if (r.status === '完了' && !TRIAL_CONFIRMED.has(`${r.file}|${r.req}|${r.spec}`)) early.push(`${r.file}: ${r.req} ${r.spec}`);
    }
  }
  assert.ok(trial > 0);
  assert.deepEqual(early, []);
  assert.deepEqual(confirmedProblems(TRIAL_CONFIRMED, rules), []);
});

test('検証方法: 試走で確かめた行の集合は、トレーサビリティ表に無い行・試走の行でない行・測る試走が無い行・試走で測れない句を持つ行を受けない', () => {
  const rules = trialRules();
  const C = 'bp-conformance.md';
  const bad = [
    `${C}|PR-BPDESIGNEDSKILL-999|SP-BPCONFORMANCE-006`,
    `${C}|PR-BPDESIGNEDSKILL-017|SP-BPCONFORMANCE-022`,
    `${C}|PR-BPDESIGNEDSKILL-001|SP-BPCONFORMANCE-001, SP-BPCONFORMANCE-003, SP-BPCONFORMANCE-004`,
    `${C}|PR-BPDESIGNEDSKILL-008|SP-BPCONFORMANCE-012, SP-BPCONFORMANCE-027`,
    `${C}|PR-BPOPERATIONS-025|${EXPECTED_TRIAL.rows.find((r) => r.req === 'PR-BPOPERATIONS-025').spec}`,
  ];
  assert.equal(confirmedProblems(new Set(bad), rules).length, bad.length);
  assert.deepEqual(confirmedProblems(new Set([`${C}|PR-BPDESIGNEDSKILL-002|SP-BPCONFORMANCE-006`]), rules), []);
});

test('検証方法: best-practices の仕様書のトレーサビリティ表の全ての行が 4 列で、ステータスが未着手・作成中・完了のどれかである', () => {
  const rows = SPEC_FILES.flatMap(traceRows);
  assert.ok(rows.length > 100);
  for (const r of rows) {
    assert.equal(r.extra, 0, `${r.file}: ${r.req}`);
    assert.ok(STATUSES.includes(r.status), `${r.file}: ${r.req} ${r.spec}: ${JSON.stringify(r.status)}`);
  }
});

function filesUnder(dir, keep) {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    return statSync(p).isDirectory() ? filesUnder(p, keep) : keep(p) ? [p] : [];
  });
}

// 計画の段の語は読み手に経緯を持ち込み、段が変わると黙って嘘になる。経緯は commit message と PR 本文に置く。
test('規約: best-practices の配布物・テスト・仕様書・要求文書に、作り直しの段を指す語が無い', () => {
  const STAGE_WORD = new RegExp(['[0-9０-９一二三四五]\\s?段目', 'まだ' + '本番'].join('|'));
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
