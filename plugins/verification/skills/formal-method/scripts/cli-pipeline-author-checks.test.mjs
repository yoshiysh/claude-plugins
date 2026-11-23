// 結合: 確認の段の静的な確認と確認役が見つける型のうち機械で決まるものを、作成役の submit の照合でも返す（architecture.md「静的な確認」の
// 作成役の照合への前倒し）。作成役が検査の前に直す機会を足すだけで、確認の段の判定は残す。正しい成果物は差し戻さない（偽の陽性の場面）。
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalRequest, runScenario } from './test-fixtures/pipeline.mjs';
import { P, prop } from './test-fixtures/pipeline-cases.mjs';
import { SM2, SM2_PROPS } from './test-fixtures/partition.mjs';

const PREMISE_SMT = '(declare-const x Int)\n(assert (>= x 0))\n(assert (<= x 8))\n(assert (not (>= (* x x) 0)))';
const withPremise = (over = {}) => P('P1', 2, { smt: PREMISE_SMT, roles: ['premise', 'rule', 'goal'], scopeVariables: ['x'], ...over });
// ID を定義する対象（見出しの SP-DEMO-001）が、別の仕様書の SP-BASE-002 を本文で参照する
const ID_SPEC = '#### SP-DEMO-001 受付\nR1: x の 2 乗は常に 0 以上である（SP-BASE-002）。\nR2: y は x より大きい。\n';

// 否定の中の自由な記号 z は性質を全称で強めるだけ（∀x∈[-8,8]. ∀z. x²+z² ≥ 0）で、空虚にしない
const GOAL_ONLY_SMT = '(declare-const x Int)\n(declare-const z Int)\n(assert (and (>= x (- 8)) (<= x 8)))\n(assert (not (>= (+ (* x x) (* z z)) 0)))';

const submitsOf = (harness, role) => harness.memory.submits.filter((x) => x.role === role && x.result);
const firstProblems = (harness, role) => submitsOf(harness, role)[0]?.result.problems ?? [];
function assertSentBack(harness, role, pattern) {
  const first = submitsOf(harness, role)[0];
  assert.ok(first, `${role} の submit がある`);
  assert.equal(first.result.ok, false, `${role} の最初の提出を差し戻す: ${JSON.stringify(first.result)}`);
  assert.ok(first.result.problems.some((x) => pattern.test(x)), `${role} の problems に ${pattern}: ${JSON.stringify(first.result.problems)}`);
}

describe('cli-pipeline-author-checks', { concurrency: 4 }, () => {
test('SP-FORMALMETHOD-005・012 AC-22: 範囲として扱う変数が出所の規則にも性質の否定にも現れなければ、モデル作成役の照合が差し戻し、確認の段の scope_variables も成り立たない', async (t) => {
  const smt = '(declare-const x Int)\n(declare-const y Int)\n(assert (and (>= x (- 8)) (<= x 8)))\n(assert (not (>= (* x x) 0)))';
  const { harness, result } = await runScenario(t, { scenario: { properties: [P('P1', 2, { smt, scopeVariables: ['x', 'y'] })] } });
  assertSentBack(harness, 'model-author', /範囲として扱う変数 y が .*出所の規則にも性質の否定にも、それらが参照する define-fun の本体にも現れない/);
  const c = result.confirmations.deterministic.find((x) => x.kind === 'scope_variables');
  assert.equal(c?.result, '成り立たない', '確認の段の静的な確認は残す');
});

test('SP-FORMALMETHOD-012: 作成役の仮定の前提に source_ids が無ければ、モデル作成役の照合が差し戻す', async (t) => {
  const { harness } = await runScenario(t, { scenario: { properties: [withPremise({ premiseSources: [] })] } });
  assertSentBack(harness, 'model-author', /前提の節 P1-p1 は basis が 作成役の仮定 なのに source_ids が無い/);
});

test('SP-FORMALMETHOD-004・005: 性質の出所の要素が、どの節の source_ids にも対応表の行にも無ければ、モデル作成役の照合が差し戻す', async (t) => {
  const p2 = P('P2', 3, { clauseSources: ['E-P1'], mappingLocation: false });
  const { harness } = await runScenario(t, { scenario: { properties: [P('P1', 2), p2] } });
  assertSentBack(harness, 'model-author', /inventory の性質 P2 の出所 E-P2 が/);
});

test('SP-FORMALMETHOD-004: どの性質の source_ids にも出てこない要素は、抽出役の照合が差し戻す', async (t) => {
  const { harness } = await runScenario(t, { scenario: { extraElements: [{ file: 'spec.md', line: 4 }] } });
  assertSentBack(harness, 'extractor', /要素 E-X4 がどの性質の source_ids にも無い/);
});

test('SP-FORMALMETHOD-004: 本文の別の ID の参照が external_dependencies に無ければ、抽出役の照合が差し戻す', async (t) => {
  const { harness } = await runScenario(t, { files: { 'target/spec.md': ID_SPEC } });
  assertSentBack(harness, 'extractor', /spec\.md:L2 の ID の参照 SP-BASE-002 が/);
});

// 偽の陽性: 既存の正しい場面（test-fixtures の場面）で、抽出役とモデル作成役の最初の提出に欠陥を返さない
const CORRECT = [
  ['正準のシナリオ', {}],
  ['作成役の仮定の前提を持つ性質', { scenario: { properties: [withPremise()] } }],
  ['外部の依存の前提を持つ性質', { scenario: { properties: [withPremise({ premiseBasis: { 'P1-p1': '外部の依存' } })], externalDependencies: [{ id: 'X1', text: 'x は外部の API が 0 以上に保つ', source: null }] } }],
  ['性質が 2 つと形式化できない性質', { scenario: { properties: [P('P1', 2), P('P2', 3), P('P3', 4, { formalizable: false })] } }],
  ['状態遷移を持つモデル', { scenario: { stateMachine: SM2, properties: SM2_PROPS } }],
  ['性質の否定にだけ現れる変数を持つ性質', { scenario: { properties: [P('P1', 2, { smt: GOAL_ONLY_SMT })] } }],
  ['依頼元が除外した行だけで外の ID を参照する対象', { files: { 'target/spec.md': ID_SPEC }, request: canonicalRequest({ scope: { include: [{ kind: 'target', id: 'T1' }, { kind: 'goal', id: 'G1' }], exclude: [{ item: { kind: 'location', target_id: 'T1', file: 'spec.md', span: 'L2-L2' }, reason: '外の要求の写し' }] } }) }],
  ['外の ID の参照を external_dependencies に書いた対象', { files: { 'target/spec.md': ID_SPEC }, scenario: { externalDependencies: [{ id: 'X1', text: 'SP-BASE-002（別の仕様書）', source: null }] } }],
];
for (const [name, opts] of CORRECT) {
  test(`SP-FORMALMETHOD-004・005・012 偽の陽性: ${name}では、抽出役とモデル作成役の最初の提出を差し戻さない`, async (t) => {
    const { harness, result } = await runScenario(t, opts);
    for (const role of ['extractor', 'model-author']) {
      const subs = submitsOf(harness, role);
      assert.ok(subs.length >= 1, `${role} の submit がある`);
      for (const s of subs.filter((x) => x.round === 1)) assert.deepEqual([s.result.ok, s.result.problems], [true, []], `${role}: ${JSON.stringify(s.result)}`);
      assert.deepEqual(firstProblems(harness, role), []);
    }
    assert.ok(result.properties.length >= 1 && prop(result, result.properties[0].id), '結果を返す');
  });
}
});
