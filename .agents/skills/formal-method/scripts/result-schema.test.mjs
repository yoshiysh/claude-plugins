// 自己検査: 結果の形と「id と参照の一覧」の不変の検査（test-fixtures/result-schema.mjs）が、正しい結果を通し、壊れた結果を拒む。
import test from 'node:test';
import assert from 'node:assert/strict';
import { resultInvariants, refInvariants } from './test-fixtures/result-schema.mjs';
import { sampleResult } from './test-fixtures/fabricate.mjs';

const end = { started: true, tool_result: '満たす', abnormal_exit: false, unreadable_output: false, stopped_by: null, time_limit_hit: null };
function richResult() {
  const r = sampleResult('rich');
  r.models = [{ id: 'M1', ref: 'attempts/m/model-M1.json', covers: { targets: ['T1'], states: ['s0'], events: ['e'], assumptions: [], constraints: [], excluded: [] },
    mapping: [], unmapped: { requirements: [], properties: [], model_elements: [] },
    combinations: { applicable: true, cells: [{ state: 's0', event: 'e', class: '許される', grounds: 'g', transition_ids: ['t'] }] },
    paths: { applicable: false, reason: 'x' }, behavior: { applicable: false, reason: 'x' }, diagram: { derivable: false, reason: 'x' } }];
  r.checks = [{ id: 'C-MP1', kind: 'property', model_id: 'M1', assumptions: [], scope: 's', unit: 'u', tool_time_limit: { seconds: 1, source: '計画（内部の上限 TOOL_TIME_LIMIT_MAX_S 以下）' },
    state: '実行した', verdict: '成功', end, reason: 'r', evidence_refs: [], completed_scope: null, incomplete_scope: null }];
  r.confirmations.deterministic = [{ id: 'confirm-sanity-1', kind: 'sanity', property_ids: ['P1'], model_property_id: 'MP1', plan_id: 'S-MP1', item: 'i', result: '成り立つ', checker: 'cli', materials: [], end, reason: 'r' }];
  r.properties = [{ id: 'P1', statement: 's', sources: [{ kind: 'goal', id: 'G1', source: null }], formalizable: true, nonformal_reason: null, verdict: ['未確認'], assurance: null,
    detection: { status: '検出能力未確認', mutations: [], reason: 'r' }, method: null, check_ids: ['C-MP1'], confirmation_ids: ['confirm-sanity-1'], evidence_refs: [], reason: 'r', depends_on_questions: [] }];
  r.decomposition.graph.nodes = [
    { id: 'prop:M1/MP1', kind: 'property', location: { file: 'attempts/m/model-M1.json', pointer: '/properties/0' } },
    { id: 'tr:M1/t', kind: 'transition', location: { file: 'attempts/m/model-M1.json', pointer: '/state_machine/transitions/0' } },
    { id: 'var:M1/a', kind: 'variable', location: { file: 'attempts/m/model-M1.json', pointer: '/state_machine/variables/0' } },
  ];
  r.decomposition.graph.edges = [{ id: 'write:tr:M1/t->var:M1/a', from: 'tr:M1/t', to: 'var:M1/a', kind: 'write', location: { file: 'attempts/m/model-M1.json', pointer: '/state_machine/transitions/0/updates/0/var' } }];
  r.decomposition.candidates = [{ id: 'C1', nodes: ['tr:M1/t', 'var:M1/a'], strength_to: [] }];
  // 分割: 部分の契約の検査（kind contract）と合成の条件の検査（kind composition）。性質の check_ids には property と composition だけ
  const chk = (id, kind) => ({ ...structuredClone(r.checks[0]), id, kind });
  r.checks.push(chk('C-K1', 'contract'), chk('C-CC1', 'composition'));
  r.decomposition.adopted = true;
  r.decomposition.parts = [{ id: 'pa', model_id: 'M1', owns_variables: ['var:M1/a'], transitions: ['tr:M1/t'] }];
  r.decomposition.contracts = [{ id: 'K1', model_id: 'M1', derived_from: 'MP1', part_id: 'pa', statement: 's', verdict: ['検証済み'], check_ids: ['C-K1'], reason: 'r' }];
  r.decomposition.composition_conditions = [{ id: 'CC1', model_id: 'M1', derived_from: 'MP1', statement: 's', check_ids: ['C-CC1'], depends_on: ['K1'] }];
  r.properties[0].check_ids = ['C-MP1', 'C-CC1'];
  r.models[0].mapping = [{ source: { kind: 'goal', id: 'G1' }, property_id: 'P1', model_element: 'MP1', check_ids: ['C-MP1', 'C-CC1'], relation: '形式化', reason: null }];
  r.stop_report.checks_aborted = [{ id: 'C-K1', kind: 'contract' }];
  r.performance.executions = [{ id: 'C-K1', kind: 'contract', elapsed_ms: { value: 1, unit: 'ms' }, cpu_time_ms: { status: '取得できず', reason: 'x' }, peak_rss_bytes: { status: '取得できず', reason: 'x' } }];
  return r;
}

// 合成の条件の検査 C-CC1 が 反例 で、そこから反例を作った結果（Counterexample は property・composition の 反例 の検査からだけ作る）
function withCounterexample(r) {
  r.checks.find((c) => c.id === 'C-CC1').verdict = '反例';
  r.properties[0].verdict = ['反例'];
  r.confirmations.deterministic.push({ id: 'confirm-replay-1', kind: 'replay', property_ids: ['P1'], model_property_id: 'MP1', plan_id: null, item: 'i', result: '確認できず', checker: 'cli', materials: [], end, reason: 'モデルが無い' });
  r.counterexamples = [{ id: 'X1', property_id: 'P1', sources: [{ kind: 'goal', id: 'G1' }], check_id: 'C-CC1', input_and_trace: 'x', violated_condition: 'v', replay: { confirmation_id: 'confirm-replay-1', steps_ref: 'checks/e1/input.smt2' } }];
  r.causes = [{ subject: { kind: 'counterexample', id: 'X1' }, cause: '対象が性質を満たさない', grounds: 'g', classified_by: 't1' }];
  return r;
}
// M1 と別に、モデルの性質 MP2 を持つモデル M2 を足す（derived_from が別のモデルの性質を指す負例のため）
function withSecondModel(r) {
  r.models.push({ ...structuredClone(r.models[0]), id: 'M2', ref: 'attempts/m/model-M2.json', mapping: [] });
  r.decomposition.graph.nodes.push({ id: 'prop:M2/MP2', kind: 'property', location: { file: 'attempts/m/model-M2.json', pointer: '/properties/0' } });
  return r;
}

test('result-schema の自己検査: 最小の結果と、参照のそろった結果は違反なし', () => {
  assert.deepEqual(resultInvariants(sampleResult()), []);
  assert.deepEqual(resultInvariants(richResult()), []);
});

// 契約の変更で許すようになった形（artifact-formats「検査」「形式モデルと対応」「分割と合成」「反例と原因」）
const ACCEPTED = [
  ['kind contract の検査が checks[]・stop_report.checks_*・performance.executions にある', (r) => r],
  ['合成の条件の検査から作った反例', withCounterexample],
  ['形式化 の行で check_ids が空でも reason（検査の無い理由）があれば通す', (r) => { r.models[0].mapping[0].check_ids = []; r.models[0].mapping[0].reason = '計画に検査が無い（計画作成役が返らない）'; return r; }],
  ['形式化 の行で check_ids が空でなければ reason は null でよい', (r) => { r.models[0].mapping[0].reason = null; return r; }],
  ['合成の条件の check_ids が空（検査の欠け）', (r) => { r.decomposition.composition_conditions[0].check_ids = []; r.checks = r.checks.filter((c) => c.id !== 'C-CC1'); r.properties[0].check_ids = ['C-MP1']; r.models[0].mapping[0].check_ids = ['C-MP1']; return r; }],
  ['契約の check_ids が空（検査の欠け）', (r) => { r.decomposition.contracts[0].check_ids = []; r.decomposition.contracts[0].verdict = ['未確認']; r.checks = r.checks.filter((c) => c.id !== 'C-K1'); r.stop_report.checks_aborted = []; r.performance.executions = []; return r; }],
];
// 原因の問い（artifact-formats「担当の返り値」: 問いは原因の分類が 要求の不足 のときだけ questions[] に入る）
const Q1 = { id: 'Q1', missing_decision: 'm', affected: ['P1'], options: ['a', 'b'] };
const withQuestionCause = (cause, inQuestions) => (r) => {
  r.causes = [{ subject: { kind: 'question', id: 'Q1' }, cause, grounds: 'g', classified_by: 't1' }];
  r.questions = inQuestions ? [structuredClone(Q1)] : [];
  r.stop_report.questions = inQuestions ? ['Q1'] : [];
  return r;
};
ACCEPTED.push(
  ['要求の不足 の原因の問いが questions[] にある', withQuestionCause('要求の不足', true)],
  ['原因未確認 の原因の問いが questions[] に無い', withQuestionCause('原因未確認', false)],
);
for (const [name, make] of ACCEPTED) {
  test(`result-schema の自己検査: ${name} を通す`, () => {
    assert.deepEqual(resultInvariants(make(richResult())), []);
  });
}

const BROKEN = [
  ['検査の id の重なり', (r) => { r.checks.push(structuredClone(r.checks[0])); }, '実行と確認 の id C-MP1 が重なる'],
  ['検査と確認で id が重なる', (r) => { r.confirmations.deterministic[0].id = 'C-MP1'; r.properties[0].confirmation_ids = ['C-MP1']; }, '実行と確認 の id C-MP1 が重なる'],
  ['sanity の確認の id が計画の id のまま', (r) => { r.confirmations.deterministic[0].id = 'S-MP1'; r.properties[0].confirmation_ids = ['S-MP1']; }, '確認の id S-MP1 が confirm-sanity-<n> の形でない'],
  ['sanity の確認の plan_id が null', (r) => { r.confirmations.deterministic[0].plan_id = null; }, 'plan_id が null'],
  ['計画から作らない確認の plan_id が null でない', (r) => { r.confirmations.meaning.push({ id: 'confirm-fidelity-1', kind: 'fidelity', property_ids: ['P1'], model_property_id: null, plan_id: 'S-MP1', item: 'i', result: '成り立つ', checker: 't1', materials: [], end: null, reason: 'r' }); }, 'plan_id は null'],
  ['mutation の確認の plan_id が Detection の変異に無い', (r) => { r.properties[0].detection.mutations = [{ id: 'MU-MP1', expected_violation: 'sat', detected: true, confirmation_id: 'confirm-mutation-1' }]; r.confirmations.deterministic.push({ id: 'confirm-mutation-1', kind: 'mutation', property_ids: ['P1'], model_property_id: 'MP1', plan_id: 'MU-other', item: 'i', result: '成り立つ', checker: 'cli', materials: [], end, reason: 'r' }); }, 'plan_id MU-other が Detection.mutations[].id に無い'],
  ['計画の検査の id が confirm- で始まる', (r) => { r.checks[0].id = 'confirm-property-1'; r.properties[0].check_ids = ['confirm-property-1']; }, '計画の id confirm-property-1 が confirm- で始まる'],
  ['計画の変異の id が confirm- で始まる', (r) => { r.properties[0].detection.mutations = [{ id: 'confirm-mut-1', expected_violation: 'sat', detected: true, confirmation_id: 'confirm-sanity-1' }]; }, '計画の id confirm-mut-1 が confirm- で始まる'],
  ['Detection の confirmation_id が別の変異の確認を指す', (r) => { r.properties[0].detection.mutations = [{ id: 'MU-MP1', expected_violation: 'sat', detected: true, confirmation_id: 'confirm-sanity-1' }]; }, 'plan_id MU-MP1 の mutation の確認でない'],
  ['確認の id の kind が違う', (r) => { r.confirmations.deterministic[0].id = 'confirm-replay-1'; r.properties[0].confirmation_ids = ['confirm-replay-1']; }, 'confirm-sanity-<n> の形でない'],
  ['CLI の確認の id が confirm- の形でない', (r) => { r.confirmations.meaning.push({ id: 'F1', kind: 'fidelity', property_ids: ['P1'], model_property_id: null, plan_id: null, item: 'i', result: '成り立つ', checker: 't1', materials: [], end: null, reason: 'r' }); }, '確認の id F1 が confirm-fidelity-<n> の形でない'],
  ['実在しない検査を指す check_ids', (r) => { r.properties[0].check_ids.push('C-none'); }, 'check_ids の C-none が実在しない'],
  ['実在しない確認を指す confirmation_ids', (r) => { r.properties[0].confirmation_ids = ['confirm-sanity-9']; }, 'confirmation_ids の confirm-sanity-9'],
  ['確認の property_ids が inventory の性質に無い', (r) => { r.confirmations.deterministic[0].property_ids = ['MP1']; }, 'property_ids の MP1'],
  ['確認の model_property_id がモデルの性質に無い', (r) => { r.confirmations.deterministic[0].model_property_id = 'P1'; }, 'model_property_id の P1'],
  ['Check.model_id が実在しない', (r) => { r.checks[0].model_id = 'M9'; }, 'Check.model_id の M9'],
  ['辺の端が要素に無い', (r) => { r.decomposition.graph.edges[0] = { ...r.decomposition.graph.edges[0], id: 'write:tr:M1/x->var:M1/a', from: 'tr:M1/x' }; }, '辺 write:tr:M1/x->var:M1/a の端'],
  ['候補の要素が graph に無い', (r) => { r.decomposition.candidates[0].nodes = ['var:M1/z']; }, '候補 C1.nodes'],
  ['部分の要素が別のモデルのもの', (r) => {
    r.models.push({ ...structuredClone(r.models[0]), id: 'M2', ref: 'attempts/m/model-M2.json' });
    r.decomposition.graph.nodes.push({ id: 'var:M2/a', kind: 'variable', location: { file: 'attempts/m/model-M2.json', pointer: '/state_machine/variables/0' } });
    r.decomposition.parts = [{ id: 'pa', model_id: 'M1', owns_variables: ['var:M2/a'], transitions: [] }];
  }, 'M1 の変数でない'],
  ['組合せの状態が covers に無い', (r) => { r.models[0].combinations.cells[0].state = 's9'; }, '組合せ s9/e'],
  ['モデルの重なり', (r) => { r.models.push(structuredClone(r.models[0])); }, 'モデル の id M1 が重なる'],
  ['仮の結果なのに result が unsaved に無い', (r) => { r.provisional = true; }, 'provisional true と records.unsaved の result（false）'],
  ['result が unsaved なのに仮の結果でない', (r) => { r.records.unsaved.push({ kind: 'result', ref: 'result.json', reason: '書けない' }); r.stop_report.unsaved = ['result']; }, 'provisional false と records.unsaved の result（true）'],
  ['仮の結果が 完了', (r) => { r.provisional = true; r.records.unsaved.push({ kind: 'result', ref: 'result.json', reason: '書けない' }); r.status = '完了'; r.stop_report = null; }, '仮の結果の状態が 停止 でない'],
  // 検査の kind（artifact-formats「検査」）
  ['Check.kind が確認用の実行の kind', (r) => { r.checks[1].kind = 'replay'; }, '/checks/1/kind'],
  ['性質の check_ids に kind contract の検査', (r) => { r.properties[0].check_ids.push('C-K1'); }, 'check_ids の C-K1 が kind contract'],
  ['mapping の check_ids に kind contract の検査', (r) => { r.models[0].mapping[0].check_ids.push('C-K1'); }, 'M1.mapping[].check_ids（kind property・composition） の C-K1 が実在しない'],
  ['mapping の check_ids が確認の id を指す', (r) => { r.models[0].mapping[0].check_ids.push('confirm-sanity-1'); }, 'mapping[].check_ids（kind property・composition） の confirm-sanity-1'],
  ['形式化 の行で check_ids が空で reason が null', (r) => { r.models[0].mapping[0].check_ids = []; }, '形式化 の行の check_ids が空で reason が null'],
  ['契約の check_ids に kind property の検査', (r) => { r.decomposition.contracts[0].check_ids.push('C-MP1'); }, '契約 K1.check_ids（kind contract） の C-MP1'],
  ['kind contract の検査がどの契約の check_ids にも無い', (r) => { r.decomposition.contracts[0].check_ids = []; }, 'kind contract の検査 C-K1 が 0 個の Contract.check_ids'],
  ['kind contract の検査が 2 つの契約の check_ids に現れる', (r) => { r.decomposition.contracts.push({ ...structuredClone(r.decomposition.contracts[0]), id: 'K2' }); }, 'kind contract の検査 C-K1 が 2 個の Contract.check_ids'],
  ['合成の条件の check_ids に kind contract の検査', (r) => { r.decomposition.composition_conditions[0].check_ids.push('C-K1'); }, '合成の条件 CC1.check_ids（kind composition） の C-K1'],
  ['合成の条件に derived_from が無い', (r) => { delete r.decomposition.composition_conditions[0].derived_from; }, 'composition_conditions/0/derived_from: 必須のキーが無い'],
  ['合成の条件の derived_from がモデルの性質に無い', (r) => { r.decomposition.composition_conditions[0].derived_from = 'P1'; }, 'composition_conditions[].derived_from の P1 が M1 のモデルの性質に実在しない'],
  ['合成の条件の derived_from が別のモデルの性質', (r) => { withSecondModel(r); r.decomposition.composition_conditions[0].derived_from = 'MP2'; }, 'composition_conditions[].derived_from の MP2 が M1 のモデルの性質に実在しない'],
  ['契約の derived_from が別のモデルの性質', (r) => { withSecondModel(r); r.decomposition.contracts[0].derived_from = 'MP2'; }, 'Contract.derived_from の MP2 が M1 のモデルの性質に実在しない'],
  // 反例（artifact-formats「反例と原因」）
  ['反例の check_id が kind contract の検査', (r) => { withCounterexample(r); r.checks.find((c) => c.id === 'C-K1').verdict = '反例'; r.counterexamples[0].check_id = 'C-K1'; }, '反例 X1.check_id（kind property・composition） の C-K1'],
  ['反例の check_id の検査が 反例 でない', (r) => { withCounterexample(r); r.counterexamples[0].check_id = 'C-MP1'; }, '反例 X1.check_id の C-MP1 の verdict が 成功'],
  ['反例の check_id が確認の id', (r) => { withCounterexample(r); r.counterexamples[0].check_id = 'confirm-sanity-1'; }, '反例 X1.check_id（kind property・composition） の confirm-sanity-1'],
  // 欠陥が残った計画の要素（artifact-formats「検査」）
  ['計画の欠陥として載せた検査が checks[] にある', (r) => { r.unverified.push({ item: '計画の欠陥: C-K1', reason: 'r' }); }, '計画の欠陥 C-K1 が checks[] にある'],
  ['計画の欠陥として載せた検査を check_ids・stop_report・performance が指す', (r) => { r.unverified.push({ item: '計画の欠陥: C-K1', reason: 'r' }); r.checks = r.checks.filter((c) => c.id !== 'C-K1'); }, '計画の欠陥 C-K1 を指す欄がある'],
  ['計画の欠陥として載せた sanity から確認を作った', (r) => { r.unverified.push({ item: '計画の欠陥: S-MP1', reason: 'r' }); }, '計画の欠陥 S-MP1 から作った確認が confirmations にある'],
  ['共同不変条件の check_ids が確認の id（checks[] に実在しない）', (r) => {
    r.decomposition.graph.edges.push({ id: 'read:tr:M1/t->var:M1/a', from: 'tr:M1/t', to: 'var:M1/a', kind: 'read', location: { file: 'attempts/m/model-M1.json', pointer: '/state_machine/transitions/0/guard' } });
    r.decomposition.parts.push({ id: 'pb', model_id: 'M1', owns_variables: [], transitions: [] });
    r.decomposition.boundaries = [{ edge_id: 'read:tr:M1/t->var:M1/a', producer: 'pa', consumer: 'pb', shared_symbols: ['a'], assumption: 'a', guarantee: 'a', assumption_basis: { kind: '共同不変条件', check_ids: ['confirm-sanity-1'] }, responsible: ['K1'] }];
  }, 'assumption_basis.check_ids の confirm-sanity-1'],
];
BROKEN.push(
  ['要求の不足 の原因の問いが questions[] に無い', (r) => { withQuestionCause('要求の不足', false)(r); }, '原因の問い の Q1 が実在しない'],
  ['原因未確認 の原因の問いが questions[] にある', (r) => { withQuestionCause('原因未確認', true)(r); }, '原因の問い Q1 は 原因未確認 なので questions[] に入らない'],
  ['対象が性質を満たさない の原因の問いが questions[] にある', (r) => { withQuestionCause('対象が性質を満たさない', true)(r); }, '原因の問い Q1 は 対象が性質を満たさない なので questions[] に入らない'],
);
for (const [name, breakIt, expected] of BROKEN) {
  test(`result-schema の自己検査: ${name} を拒む`, () => {
    const r = richResult();
    breakIt(r);
    const errs = resultInvariants(r);
    assert.ok(errs.some((e) => e.includes(expected)), `${expected}: ${errs.join(' | ')}`);
  });
}

test('result-schema の自己検査: refInvariants は run の領域に無い Ref と、モデルに無い transition_ids を拒む', () => {
  const r = richResult();
  const files = { 'attempts/m/model-M1.json': JSON.stringify({ model_id: 'M1', state_machine: { transitions: [{ id: 't' }] }, properties: [{ id: 'MP1', inventory_property_ids: ['P1'] }] }),
    'attempts/p/plan.json': JSON.stringify({ sanity: [{ id: 'S-MP1' }], checks: PLAN_CHECKS }) };
  r.records.saved.push({ kind: 'plan', ref: 'attempts/p/plan.json', hash: `sha256:${'0'.repeat(64)}` });
  assert.deepEqual(refInvariants(r, (ref) => files[ref] ?? null), []);
  const r2 = structuredClone(r);
  r2.confirmations.deterministic[0].plan_id = 'S-none';
  assert.ok(refInvariants(r2, (ref) => files[ref] ?? null).some((e) => e.includes('plan_id S-none が計画（PlanFile.sanity）に無い')));
  r.models[0].combinations.cells[0].transition_ids = ['t9'];
  r.decomposition.graph.nodes[0].location.file = 'attempts/m/missing.json';
  const errs = refInvariants(r, (ref) => files[ref] ?? null);
  assert.ok(errs.some((e) => e.includes('transition_ids t9')), errs.join(' | '));
  assert.ok(errs.some((e) => e.includes('missing.json')), errs.join(' | '));
});

// 計画（PlanFile.checks・MutationsFile）との照合。保存された plan・mutations の記録で照らす
const PLAN_CHECKS = [
  { id: 'C-MP1', kind: 'property', target_id: 'MP1' },
  { id: 'C-K1', kind: 'contract', target_id: 'K1' },
  { id: 'C-CC1', kind: 'composition', target_id: 'CC1' },
];
function planFixture({ checks = PLAN_CHECKS, mutations = [{ id: 'MU-MP1', property_id: 'MP1', detector_check_id: 'C-MP1' }] } = {}) {
  const r = richResult();
  const files = {
    'attempts/m/model-M1.json': JSON.stringify({ model_id: 'M1', state_machine: { transitions: [{ id: 't' }] }, properties: [{ id: 'MP1', inventory_property_ids: ['P1'] }] }),
    'attempts/p/plan.json': JSON.stringify({ sanity: [{ id: 'S-MP1' }], checks }),
    'attempts/p/mutations.json': JSON.stringify({ mutations, unavailable: [] }),
  };
  const h = `sha256:${'0'.repeat(64)}`;
  r.records.saved.push({ kind: 'plan', ref: 'attempts/p/plan.json', hash: h }, { kind: 'mutations', ref: 'attempts/p/mutations.json', hash: h });
  return { r, read: (ref) => files[ref] ?? null, files };
}

test('result-schema の自己検査: refInvariants は計画の検査・契約の検査の順・性質の検査の集合・detector_check_id が契約に合う結果を通す', () => {
  const { r, read } = planFixture();
  assert.deepEqual(refInvariants(r, read), []);
  // 契約の検査が 2 つなら、Contract.check_ids は計画の順
  const two = planFixture({ checks: [...PLAN_CHECKS, { id: 'C-K1b', kind: 'contract', target_id: 'K1' }] });
  two.r.checks.push({ ...structuredClone(two.r.checks[0]), id: 'C-K1b', kind: 'contract' });
  two.r.decomposition.contracts[0].check_ids = ['C-K1', 'C-K1b'];
  assert.deepEqual(refInvariants(two.r, two.read), []);
  // 計画が 2 つ保存された（修正の巡）結果には、採った計画を渡さなければ計画との照合を当てない
  const revised = planFixture();
  revised.files['attempts/p2/plan.json'] = JSON.stringify({ sanity: [{ id: 'S-MP1' }], checks: [] });
  revised.r.records.saved.push({ kind: 'plan', ref: 'attempts/p2/plan.json', hash: `sha256:${'0'.repeat(64)}` });
  assert.deepEqual(refInvariants(revised.r, revised.read), []);
  // 採った計画を渡せば、その計画で照らす（正しい計画は通し、別の計画は拒む）
  assert.deepEqual(refInvariants(revised.r, revised.read, { plan: 'attempts/p/plan.json', mutations: 'attempts/p/mutations.json' }), []);
  assert.ok(refInvariants(revised.r, revised.read, { plan: 'attempts/p2/plan.json', mutations: 'attempts/p/mutations.json' }).some((e) => e.includes('欠陥の残らなかった PlanFile.checks の要素ごとに 1 つ')));
});

test('result-schema の自己検査: refInvariants は、欠陥が残り unverified[] に「計画の欠陥」で載った計画の検査を、checks[] と check_ids に求めない', () => {
  const { r, read } = planFixture({ checks: [...PLAN_CHECKS, { id: 'C-K1b', kind: 'contract', target_id: 'K1' }] });
  r.unverified.push({ item: '計画の欠陥: C-K1b', reason: '(check-sat) を持つ input が最後でない' });
  assert.deepEqual(refInvariants(r, read), []);
  assert.deepEqual(resultInvariants(r), []);
  // item が「計画の欠陥: <id>」と一致しない項目（前後に文字がある）は、欠陥として読まない
  const loose = planFixture({ checks: [...PLAN_CHECKS, { id: 'C-K1b', kind: 'contract', target_id: 'K1' }] });
  loose.r.unverified.push({ item: '計画の欠陥: C-K1b ほか', reason: 'r' });
  assert.ok(refInvariants(loose.r, loose.read).some((e) => e.includes('欠陥の残らなかった PlanFile.checks')));
});

const PLAN_BROKEN = [
  ['計画の検査が checks[] に無い（計画の欠陥としても載っていない）', {}, (r) => { r.checks = r.checks.filter((c) => c.id !== 'C-K1'); r.decomposition.contracts[0].check_ids = []; r.stop_report.checks_aborted = []; r.performance.executions = []; }, '欠陥の残らなかった PlanFile.checks の要素ごとに 1 つ'],
  ['checks[] の kind が計画と違う', { checks: PLAN_CHECKS.map((c) => (c.id === 'C-CC1' ? { ...c, kind: 'property', target_id: 'MP1' } : c)) }, () => {}, '欠陥の残らなかった PlanFile.checks の要素ごとに 1 つ'],
  ['Contract.check_ids が計画の順でない', { checks: [...PLAN_CHECKS, { id: 'C-K1b', kind: 'contract', target_id: 'K1' }] }, (r) => {
    r.checks.push({ ...structuredClone(r.checks[0]), id: 'C-K1b', kind: 'contract' });
    r.decomposition.contracts[0].check_ids = ['C-K1b', 'C-K1'];
  }, '契約 K1.check_ids が計画の順の kind contract の検査（C-K1,C-K1b）でない'],
  ['性質の check_ids に合成の条件の検査が欠ける', {}, (r) => { r.properties[0].check_ids = ['C-MP1']; }, 'P1.check_ids が、モデルの性質の検査と合成の条件の検査の集合（C-CC1,C-MP1）でない'],
  ['detector_check_id が kind contract の検査', { mutations: [{ id: 'MU-MP1', property_id: 'MP1', detector_check_id: 'C-K1' }] }, () => {}, 'detector_check_id C-K1 が、target_id MP1 の kind property の検査でない'],
  ['detector_check_id の検査の target_id が変異の property_id と違う', { mutations: [{ id: 'MU-MP1', property_id: 'MP9', detector_check_id: 'C-MP1' }] }, () => {}, 'detector_check_id C-MP1 が、target_id MP9 の kind property の検査でない'],
];
for (const [name, opts, breakIt, expected] of PLAN_BROKEN) {
  test(`result-schema の自己検査: refInvariants は ${name} を拒む`, () => {
    const { r, read } = planFixture(opts);
    breakIt(r);
    const errs = refInvariants(r, read);
    assert.ok(errs.some((e) => e.includes(expected)), `${expected}: ${errs.join(' | ')}`);
  });
}
