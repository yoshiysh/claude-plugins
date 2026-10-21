import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildKinds, conformanceUnits } from '../plugins/skill-creator/skills/skill-creator-best-practices/scripts/bp/kinds.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = path.join(ROOT, 'docs');

function functionalSpIds() {
  const text = readFileSync(path.join(DOCS, 'specifications', 'bp-conformance.md'), 'utf8');
  const chapter = text.split(/^## /m).find((c) => c.startsWith('機能仕様'));
  return [...chapter.matchAll(/^#### (SP-BPCONFORMANCE-\d{3})/gm)].map((m) => m[1]);
}

test('SP-BPFINDINGS-010: 実際の docs/ から、「機能仕様」の章の全ての仕様項目が 1 つ以上の判定の単位に解決する', () => {
  const units = conformanceUnits(DOCS);
  assert.deepEqual(units.map((u) => u.sp), functionalSpIds());
  for (const u of units) assert.ok(u.units.length > 0, u.sp);
});

test('SP-BPFINDINGS-010: 原則の表の行を判定の単位にする仕様項目は SP-BPCONFORMANCE-010〜017 だけで、参照した節の表が全て見つかる', () => {
  const units = conformanceUnits(DOCS);
  assert.deepEqual(units.filter((u) => u.rowUnits).map((u) => u.sp), [10, 11, 12, 13, 14, 15, 16, 17].map((n) => `SP-BPCONFORMANCE-0${n}`));
  const s015 = units.find((u) => u.sp === 'SP-BPCONFORMANCE-015').units.map((u) => u.value);
  for (const sub of ['探索グラフ/計画役/t1', '探索グラフ/実行役・回収役・検証役/t1', '探索グラフ/実行役・回収役・検証役/t2', '探索グラフ/停止/t1']) {
    assert.ok(s015.some((v) => v.includes(`/${sub}/`)), sub);
  }
  assert.ok(units.find((u) => u.sp === 'SP-BPCONFORMANCE-017').units.some((u) => /\/b1$/.test(u.value)));
  const values = units.flatMap((u) => u.units.map((x) => x.value));
  assert.equal(new Set(values).size, values.length);
});

test('SP-BPFINDINGS-010: 実際の docs/ から仕様・目標・契約・監査の観点の閉集合を作れる', () => {
  const kinds = buildKinds(DOCS, 'update');
  assert.deepEqual(kinds.spec.map((k) => k.value), Array.from({ length: 10 }, (_, i) => `SP-BPCONFORMANCE-0${27 + i}`));
  assert.ok(kinds.goal.some((k) => k.value === '目標:修正の根拠の未反映'));
  assert.ok(!buildKinds(DOCS, 'create').goal.some((k) => k.value === '目標:修正の根拠の未反映'));
  assert.equal(kinds.contract.length, 5);
  assert.deepEqual(kinds.audit.map((k) => k.value), ['PA-1', 'PA-2', 'PA-3', 'PA-4', 'PA-5', 'PA-6']);
});
