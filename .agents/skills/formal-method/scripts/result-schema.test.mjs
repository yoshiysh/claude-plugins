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
  return r;
}

test('result-schema の自己検査: 最小の結果と、参照のそろった結果は違反なし', () => {
  assert.deepEqual(resultInvariants(sampleResult()), []);
  assert.deepEqual(resultInvariants(richResult()), []);
});

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
];
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
  const files = { 'attempts/m/model-M1.json': JSON.stringify({ model_id: 'M1', state_machine: { transitions: [{ id: 't' }] }, properties: [{ id: 'MP1' }] }),
    'attempts/p/plan.json': JSON.stringify({ sanity: [{ id: 'S-MP1' }], checks: [] }) };
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
