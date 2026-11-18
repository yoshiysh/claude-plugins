import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { confirmedKeys, readRecords, rowKey } from '../tools/read-bp-trial.mjs';
import { TRACE_STATUS, verifiedTraceRows } from '../tools/lib/bp-docs.mjs';
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
  return verifiedTraceRows(readFileSync(path.join(SPECS, file), 'utf8')).map((row) => ({ file, ...row }));
}

// 意味の判定を持つ計画と、登録した正解表の行は、実記録による完了の検査から外さない。
function trialRules() {
  const registered = new Set(TRIAL_ROWS.map(rowKey));
  return SPEC_FILES.map((file) => ({
    file,
    isTrial: (row) => /レビュー|eval|試走/.test(row.verification.means) || registered.has(rowKey(row)),
  }));
}

function expectedProblems(rows, rules) {
  return rows.flatMap((r) => {
    const rule = rules.find((x) => x.file === r.file);
    const row = rule && traceRows(r.file).find((t) => rowKey(t) === rowKey(r));
    return row ? [] : [`トレーサビリティ表に無い: ${rowKey(r)}`];
  });
}

const SPEC_FILES = CONFIG.specFiles.map((f) => path.relative(realpathSync(SPECS), path.join(CONFIG.root, f)));

// 「完了」の行に成功したテストがあるかは make test のトレーサビリティ検査（scripts/traceability）が見る。ここは名前の付いたテストで縛れない試走の行だけを見る。
// 試走の行は模擬の検証役でも名前の付いたテストが通ってしまうので、テスト名の有無では「完了」を縛れない。
test('検証方法: 試走と eval で確かめる行は、記録と正解表から計算した集合にあるときだけ「完了」で、全ての検証方法参照が正本の一行に解決する', () => {
  const rules = trialRules();
  assert.deepEqual(rules.map((r) => r.file).sort(), [...SPEC_FILES].sort());
  const early = [];
  let trial = 0;
  for (const rule of rules) {
    const rows = traceRows(rule.file);
    for (const r of rows.filter(rule.isTrial)) {
      trial += 1;
      if (r.status === TRACE_STATUS.done && !CONFIRMED.has(rowKey(r))) early.push(`${r.file}: ${r.req} ${r.spec} ${r.method}`);
    }
  }
  assert.ok(trial > 0);
  assert.deepEqual(early, []);
});

test('検証方法: 試走の正解表の全ての行は、トレーサビリティ表にある試走の行で、検証方法の参照が現行の正本に解決し、runs.json の全ての正解表のファイルがある', () => {
  const rules = trialRules();
  assert.deepEqual(expectedProblems(TRIAL_ROWS, rules), []);
  const runs = readRuns(RUNS_FILE);
  const files = Object.values(runs).flatMap((r) => r.expected);
  assert.ok(files.length > 0);
  for (const f of files) assert.ok(statSync(path.join(TRIAL_DIR, f)).isFile(), f);
  const C = 'bp-conformance.md';
  const valid = traceRows(C)[0];
  const bad = [
    { ...valid, req: 'PR-BPDESIGNEDSKILL-999' },
    { ...valid, method: '古い検証方法' },
    { ...valid, spec: 'SP-BPCONFORMANCE-999' },
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

test('検証方法: 正本の検証方法行の欠落・重複・不正な表・参照先の違いを拒否する', () => {
  const source = readFileSync(path.join(SPECS, 'bp-entry.md'), 'utf8');
  const canonical = source.split('\n').find((line) => line.startsWith('| SP-BPENTRY-001 |'));
  assert.ok(canonical);
  for (const changed of [
    source.replace(canonical, ''),
    source.replace(canonical, `${canonical}\n${canonical}`),
    source.replace(canonical, '| SP-BPENTRY-001 | 手段だけ |'),
    source.replace('[検証方法](#検証方法) の SP-BPENTRY-001 行', '[検証方法](#検証方法) の SP-BPENTRY-002 行'),
  ]) assert.throws(() => verifiedTraceRows(changed), /検証方法|表の途中/);
});
