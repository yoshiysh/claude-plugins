// ケース計画の構造の検査: 仕様の検証方法の表の全ての AC が計画を持ち、4 つの観点ごとにケースか不適用の理由がある。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CASE_PLAN } from './test-fixtures/case-plan.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
function specPath() {
  for (let d = HERE; d !== dirname(d); d = dirname(d)) {
    const p = join(d, 'docs', 'specifications', 'formal-method.md');
    if (existsSync(p)) return p;
  }
  return null;
}

test('testing.md ケースの設計: 仕様の検証方法の表の AC と、ケース計画の AC が一致する（欠番を含めない）', (t) => {
  const p = specPath();
  if (!p) { t.skip('仕様を持つリポジトリの外で動いている'); return; }
  const ids = [...readFileSync(p, 'utf8').matchAll(/^\| (AC-\d\d) \|/gm)].map((m) => m[1]);
  assert.deepEqual(Object.keys(CASE_PLAN).sort(), [...new Set(ids)].sort());
  for (const gone of ['AC-11', 'AC-16', 'AC-17', 'AC-18', 'AC-20']) assert.equal(gone in CASE_PLAN, false);
});

test('testing.md ケースの設計: 各 AC は正常・準正常・異常・境界の観点ごとに、ケースか不適用の理由を持つ', () => {
  for (const [ac, plan] of Object.entries(CASE_PLAN)) {
    assert.deepEqual(Object.keys(plan).sort(), ['boundary', 'error', 'normal', 'recovery'], ac);
    for (const [k, v] of Object.entries(plan)) {
      if (Array.isArray(v)) {
        assert.ok(v.length > 0, `${ac}.${k}`);
        for (const c of v) { assert.ok(c.id.length > 0); assert.ok(['auto', 'eval', 'inspection'].includes(c.layer), `${ac}.${k}`); }
      } else {
        assert.ok(typeof v.notApplicable === 'string' && v.notApplicable.length > 0, `${ac}.${k} の不適用の理由`);
      }
    }
  }
});
