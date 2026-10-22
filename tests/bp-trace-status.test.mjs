import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SPECS = path.join(ROOT, 'docs', 'specifications');
const SKILL = path.join(ROOT, 'plugins', 'skill-creator', 'skills', 'skill-creator-best-practices');
const TEST_DIRS = [path.join(ROOT, 'tests'), path.join(SKILL, 'scripts', 'bp')];
const TRACE_ROW = /^\| PR-[^|]*\|[^|]*\|[^|]*\| (未着手|作成中|完了) \|$/;

// 試走で確かめた行（仕様書・要求 ID・仕様項目 ID の列）。試走の PR が、記録を PR 本文に貼ったうえで足す。
const TRIAL_CONFIRMED = new Set([]);

function testTitles() {
  return TEST_DIRS.flatMap((dir) => readdirSync(dir).filter((f) => f.endsWith('.test.mjs')).map((f) => readFileSync(path.join(dir, f), 'utf8')))
    .flatMap((text) => [...text.matchAll(/\btest\(\s*([`'"])((?:(?!\1).)*)\1/g)].map((m) => m[2]));
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

function cells(line) {
  return line.split('|').slice(1, -1).map((c) => c.trim());
}

function traceRows(file) {
  return readFileSync(path.join(SPECS, file), 'utf8').split('\n').filter((l) => TRACE_ROW.test(l)).map((l) => {
    const [req, spec, method, status] = cells(l);
    return { file, req, spec, ids: spec.split(',').map((s) => s.trim()), method, status };
  });
}

function tableAfter(text, header) {
  const lines = text.split('\n');
  const at = lines.indexOf(header);
  if (at < 0) throw new Error(`表が無い: ${header}`);
  const rows = [];
  for (const l of lines.slice(at + 2)) {
    if (!l.startsWith('|')) break;
    rows.push(cells(l));
  }
  return rows;
}

// bp-run.md の「検証方法」の見分け方の表を正本にし、テストに見分け方を書き写さない。
function trialRules() {
  const rows = tableAfter(readFileSync(path.join(SPECS, 'bp-run.md'), 'utf8'), '| 仕様書 | 試走で確かめる行 |');
  return rows.map(([file, rule]) => {
    const name = /^`([^`]+)`$/.exec(file)[1];
    const prefix = /検証方法の列が `([^`]+)` で始まる/.exec(rule);
    if (prefix) return { file: name, isTrial: (r) => r.method.startsWith(prefix[1]) };
    if (!/「検証方法」の試走の表/.test(rule)) throw new Error(`見分け方を読めない: ${rule}`);
    const pairs = tableAfter(readFileSync(path.join(SPECS, name), 'utf8'), '| 要求 ID | 仕様項目 ID | 測る試走 |').map(([req, spec]) => `${req}|${spec}`);
    return { file: name, pairs, isTrial: (r) => pairs.includes(`${r.req}|${r.spec}`) };
  });
}

const SPEC_FILES = readdirSync(SPECS).filter((f) => /^bp-.*\.md$/.test(f));

// テストの有無しか見ない（確かめ方が行の検証方法に足りるかは見ない。それは生成者と別の検証役が行とテストを突き合わせて見る）。
// 「完了」の行に、テスト名の無い仕様項目が 1 つでもあれば、テストの無い行を「完了」にしている。
test('検証方法: best-practices の仕様書のトレーサビリティ表で「完了」の行の仕様項目 ID が全て、どれかのテスト名に現れる', () => {
  const ids = titleIds(testTitles());
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
