import test from 'node:test';
import assert from 'node:assert/strict';
import { buildKinds, conformanceUnits } from './kinds.mjs';
import { CRITERIA_FIXTURE } from './fixtures/harness.mjs';

test('SP-BPFINDINGS-010: 判定基準の写しから観点ごとの閉集合を決定的に作る', () => {
  const kinds = buildKinds(CRITERIA_FIXTURE, 'create');
  assert.deepEqual(kinds.conformance.map((k) => k.value), [
    'SP-BPCONFORMANCE-001',
    'SP-BPCONFORMANCE-010/目標の固定/t2/r1',
    'SP-BPCONFORMANCE-010/目標の固定/t2/r2',
    'SP-BPCONFORMANCE-010/目標の固定/t2/r3',
    'SP-BPCONFORMANCE-015/探索グラフ/計画役/t1/r1',
    'SP-BPCONFORMANCE-015/探索グラフ/実行役・回収役・検証役/t1/r1',
    'SP-BPCONFORMANCE-015/探索グラフ/実行役・回収役・検証役/t2/r1',
    'SP-BPCONFORMANCE-017/資産台帳/t1/r1',
    'SP-BPCONFORMANCE-017/資産台帳/b1',
    'SP-BPCONFORMANCE-017/資産台帳/b2',
  ]);
  assert.deepEqual(kinds.flow, kinds.conformance);
  assert.deepEqual(kinds.spec.map((k) => k.value), ['SP-BPCONFORMANCE-027', 'SP-BPCONFORMANCE-033']);
  assert.deepEqual(kinds.goal.map((k) => k.value), ['目標:成果物の未達', '目標:範囲の逸脱']);
  assert.deepEqual(buildKinds(CRITERIA_FIXTURE, 'update').goal.map((k) => k.value), ['目標:成果物の未達', '目標:範囲の逸脱', '目標:修正の根拠の未反映']);
  assert.deepEqual(kinds.contract.map((k) => k.value), ['契約:入力の変化', '契約:出力の変化']);
  assert.deepEqual(kinds.audit.map((k) => k.value), ['PA-1', 'PA-2']);
  assert.equal(kinds.conformance[1].meaning, '一つ目の原則');
});

test('SP-BPFINDINGS-010: 同じ入力から同じ閉集合を作る', () => {
  assert.deepEqual(conformanceUnits(CRITERIA_FIXTURE), conformanceUnits(CRITERIA_FIXTURE));
});
