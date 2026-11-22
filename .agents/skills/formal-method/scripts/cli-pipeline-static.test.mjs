// 結合: 静的な確認（SP-FORMALMETHOD-012 の表、architecture.md「静的な確認」）を、担当の harness と PATH の偽の z3 で通して観測する。
// 偽の z3 は、節を切り取った query（fake-core の名前が欠けたもの）に ablated-result（既定 sat）を返す（test-fixtures/fake-z3.mjs）。
// このファイルは節の印と静的な確認の場面。共有の道具は test-fixtures/pipeline-cases.mjs に置く。
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { runScenario } from './test-fixtures/pipeline.mjs';
import { resultInvariants } from './test-fixtures/result-schema.mjs';
import { namedClauses, smtQuery } from './test-fixtures/agent-harness.mjs';
import { ABLATION_PER_PROPERTY_MAX } from './lib/schemas.mjs';
import { P, prop, inputOf, assertRecordsConsistent, canonicalRun } from './test-fixtures/pipeline-cases.mjs';

const det = (result, kind) => result.confirmations.deterministic.filter((c) => c.kind === kind);
const judgments = (result, kind) => result.confirmations.judgments.filter((j) => j.kind === kind);
// 前提 1 つ・規則 1 つ・否定 1 つの性質（名前は P1-p1・P1-r2・P1-g3）
const PREMISE_SMT = '(declare-const x Int)\n(assert (>= x 0))\n(assert (<= x 8))\n(assert (not (>= (* x x) 0)))';
const withPremise = (over = {}) => P('P1', 2, { smt: PREMISE_SMT, roles: ['premise', 'rule', 'goal'], scopeVariables: ['x'], ...over });
const names = (clauses, ...roles) => clauses.filter((c) => roles.includes(c.role)).map((c) => c.name);

function assertNotSuccess(result, kind, pattern) {
  const p = prop(result, 'P1');
  assert.deepEqual(p.verdict, ['未確認'], `${kind} が成り立たない性質は検証の成功にならない: ${p.reason}`);
  assert.match(p.reason, /決定的な検査の静的な確認が成り立たない/);
  assert.doesNotMatch(p.reason, /意味の確認（[^）]*静的な確認/, '静的な確認の失敗を意味の確認の名前で書かない');
  const c = det(result, kind).find((x) => x.model_property_id === 'P1');
  assert.equal(c?.result, '成り立たない', JSON.stringify(c));
  assert.match(c.reason, pattern);
  assert.equal(result.status, '停止');
  assert.ok(result.stop_report.reasons.some((x) => x.code === '確認が終わっていない'), JSON.stringify(result.stop_report.reasons));
}

describe('cli-pipeline-static', { concurrency: 4 }, () => {
test('SP-FORMALMETHOD-012 AC-22: 正準のシナリオでは、否定だけの実行が sat で、静的な確認は全て成り立ち、判断を要する項目は無く、完了する', async () => {
  const { result, status } = await canonicalRun();
  assert.equal(result.status, '完了', JSON.stringify(result.stop_report));
  for (const kind of ['goal_trivial', 'premise_only', 'premise_load', 'plan_coverage', 'scope_variables', 'mutation_scope']) {
    const cs = det(result, kind);
    assert.equal(cs.length, 1, `${kind} の確認が 1 つ`);
    assert.equal(cs[0].result, '成り立つ', `${kind}: ${cs[0].reason}`);
    assert.equal(cs[0].model_property_id, 'P1');
    assert.deepEqual(cs[0].property_ids, ['P1']);
  }
  assert.deepEqual(result.confirmations.judgments, []);
  // 否定だけの実行の input.smt2 は、性質の否定の節だけを残し、宣言と (check-sat) を残す
  const goal = det(result, 'goal_trivial')[0];
  assert.ok(goal.end.started);
  const text = inputOf(status.run_dir, goal.id);
  assert.match(text, /:named P1-g2\)\)/);
  assert.doesNotMatch(text, /:named P1-r1/);
  assert.match(text, /\(declare-const x Int\)/);
  assert.match(text, /\(check-sat\)\n/);
  assert.ok(result.performance.executions.some((x) => x.id === goal.id && x.kind === 'ablation'), '静的な確認の実行は kind ablation');
  // 前提が無いので、前提と否定だけは否定だけの実行の答えを使い、自分の実行を持たない
  const prem = det(result, 'premise_only')[0];
  assert.equal(prem.end, null);
  assert.ok(!existsSync(join(status.run_dir, 'checks', prem.id)), '前提と否定だけの実行は無い');
});

test('SP-FORMALMETHOD-012 AC-22: 前提だけで性質が導けるモデル（前提と否定だけで unsat）は premise_only が成り立たず、性質は検証の成功にならない', async (t) => {
  const p = withPremise({ fakeCore: (cs) => names(cs, 'premise', 'goal') });
  const { result, status, harness } = await runScenario(t, { scenario: { properties: [p] } });
  assert.deepEqual(resultInvariants(result), []);
  assertRecordsConsistent(status, result, harness);
  assertNotSuccess(result, 'premise_only', /前提だけで結論が出ている/);
  assert.equal(det(result, 'goal_trivial')[0].result, '成り立つ');
  const text = inputOf(status.run_dir, det(result, 'premise_only')[0].id);
  assert.match(text, /:named P1-p1/);
  assert.doesNotMatch(text, /:named P1-r2/);
});

test('SP-FORMALMETHOD-012 AC-22: 性質の否定が自明なモデル（否定だけで unsat）は goal_trivial が成り立たず、性質は検証の成功にならない', async (t) => {
  const p = P('P1', 2, { fakeCore: (cs) => names(cs, 'goal') });
  const { result } = await runScenario(t, { scenario: { properties: [p] } });
  assert.deepEqual(resultInvariants(result), []);
  assertNotSuccess(result, 'goal_trivial', /性質が自明/);
});

test('SP-FORMALMETHOD-005・012 AC-22: 範囲として扱う変数が出所の規則にも性質の否定にも現れないモデルは scope_variables が成り立たず、性質は検証の成功にならない', async (t) => {
  const smt = '(declare-const x Int)\n(declare-const y Int)\n(assert (and (>= x (- 8)) (<= x 8)))\n(assert (not (>= (* x x) 0)))';
  const { result } = await runScenario(t, { scenario: { properties: [P('P1', 2, { smt, scopeVariables: ['x', 'y'] })] } });
  assert.deepEqual(resultInvariants(result), []);
  assertNotSuccess(result, 'scope_variables', /現れない: y/);
  assert.deepEqual(prop(result, 'P1').assurance.scope_variables, ['x', 'y'], '結果の保証は範囲として扱う変数を持つ');
});

test('SP-FORMALMETHOD-012 AC-22: 計画した検査の欠けたモデル（変異も用意できない理由も無い）は plan_coverage が成り立たず、性質は検証の成功にならない', async (t) => {
  const scenario = { editMutations: (m) => ({ ...m, mutations: [], unavailable: [] }) };
  const { result } = await runScenario(t, { scenario });
  assert.deepEqual(resultInvariants(result), []);
  assertNotSuccess(result, 'plan_coverage', /変異と、用意できない理由/);
});

test('SP-FORMALMETHOD-012 AC-22: 出所の規則を変えない変異（名前を保ち規則の節の項が同じ）は mutation_scope が成り立たず、性質は検証の成功にならない', async (t) => {
  const same = namedClauses(smtQuery('mutation P1', { result: 'sat' }), 'P1', { id: 'P1' }).text;
  const scenario = { editMutations: (m, { put }) => ({ ...m, mutations: m.mutations.map((x) => ({ ...x, mutation_ref: put('same.smt2', same) })) }) };
  const { result } = await runScenario(t, { scenario });
  assert.deepEqual(resultInvariants(result), []);
  assertNotSuccess(result, 'mutation_scope', /規則の節（P1-r1）を変えない/);
});

test('SP-FORMALMETHOD-012 AC-22: 結論を支える前提を持つモデルでは、前提を 1 つずつ外した実行で効いている前提を判断を要する項目に置き、その性質の意味の確認の記録がある', async (t) => {
  const p = withPremise({ fakeCore: (cs) => cs.map((c) => c.name) });
  const { result, status, harness } = await runScenario(t, { scenario: { properties: [p] } });
  assert.deepEqual(resultInvariants(result), []);
  assertRecordsConsistent(status, result, harness);
  const [j] = judgments(result, 'premise_load');
  assert.equal(j?.cause, '効いている前提', JSON.stringify(result.confirmations.judgments));
  assert.deepEqual(j.clause_names, ['P1-p1']);
  assert.equal(j.model_property_id, 'P1');
  assert.ok(j.end.started, '前提を外した実行の終わり方を持つ');
  const text = inputOf(status.run_dir, j.id);
  assert.doesNotMatch(text, /:named P1-p1/);
  assert.match(text, /:named P1-r2/);
  // 規則と否定だけの実行は sat で、その確認は成り立つ（判断を要する項目は検証の失敗ではない）
  assert.ok(det(result, 'premise_load').some((c) => c.result === '成り立つ' && /結論は前提に支えられる/.test(c.reason)));
  // 判断を要する項目ごとの意味の確認の記録（答えた者は忠実さの確認役の task、渡した資料は判断を要する項目の記録を含む）
  const jc = result.confirmations.meaning.find((c) => c.kind === 'judgment' && c.item === j.id);
  assert.ok(jc, 'その項目の意味の確認の記録がある');
  assert.deepEqual([jc.result, jc.model_property_id, jc.plan_id, jc.property_ids], ['成り立つ', 'P1', j.plan_id, ['P1']]);
  const fid = result.confirmations.meaning.find((c) => c.kind === 'fidelity');
  assert.equal(jc.checker, fid.checker, '忠実さの確認役が答える');
  assert.ok(jc.materials.some((m) => m.ref === 'judgments/M1.json'), JSON.stringify(jc.materials));
  assert.deepEqual(prop(result, 'P1').verdict, ['検証済み']);
});

test('SP-FORMALMETHOD-012 AC-22: 前提と否定だけで unsat でも、前提が外部の依存に支えられるなら成り立たないと断定せず、判断を要する項目にする', async (t) => {
  const p = withPremise({ fakeCore: (cs) => names(cs, 'premise', 'goal'), premiseBasis: { 'P1-p1': '外部の依存' } });
  const scenario = { properties: [p], externalDependencies: [{ id: 'X1', text: 'x は外部の API が 0 以上に保つ', source: null }] };
  const { result } = await runScenario(t, { scenario });
  assert.deepEqual(resultInvariants(result), []);
  assert.deepEqual(det(result, 'premise_only'), [], 'premise_only の決定的な確認は作らない');
  const [j] = judgments(result, 'premise_only');
  assert.equal(j?.cause, '外部の依存', JSON.stringify(result.confirmations.judgments));
  assert.deepEqual(j.clause_names, ['P1-p1']);
  assert.ok(!/静的な確認が成り立たない/.test(prop(result, 'P1').reason), prop(result, 'P1').reason);
});

test('SP-FORMALMETHOD-012 AC-22: 静的な確認の道具が unknown を返したら、その確認を成り立つとも成り立たないとも断定せず、判断を要する項目にする', async (t) => {
  const p = withPremise({ query: { result: 'unsat', 'ablated-result': 'unknown' }, fakeCore: (cs) => cs.map((c) => c.name) });
  const { result } = await runScenario(t, { scenario: { properties: [p] } });
  assert.deepEqual(resultInvariants(result), []);
  for (const kind of ['goal_trivial', 'premise_only', 'premise_load']) {
    assert.deepEqual(det(result, kind), [], `${kind} の決定的な確認は作らない`);
    const [j] = judgments(result, kind);
    assert.equal(j?.cause, '道具が判定できない', kind);
    assert.equal(j.end.tool_result, '判定できない');
  }
  assert.deepEqual(prop(result, 'P1').verdict, ['検証済み'], '判断を要する項目は意味の確認が扱い、決定的な確認の失敗に数えない');
});

test(`SP-FORMALMETHOD-012 AC-22: 前提を 1 つずつ外す再検査が ABLATION_PER_PROPERTY_MAX（${ABLATION_PER_PROPERTY_MAX}）を超える性質は、再検査をせず全ての前提を判断を要する項目にする`, async (t) => {
  const n = ABLATION_PER_PROPERTY_MAX - 2;
  const smt = ['(declare-const x Int)', ...Array.from({ length: n }, (_, i) => `(assert (>= x (- ${i + 1})))`), '(assert (<= x 8))', '(assert (not (>= (* x x) 0)))'].join('\n');
  const roles = [...Array(n).fill('premise'), 'rule', 'goal'];
  const p = P('P1', 2, { smt, roles, fakeCore: (cs) => cs.map((c) => c.name) });
  const { result } = await runScenario(t, { scenario: { properties: [p] } });
  assert.deepEqual(resultInvariants(result), []);
  const js = judgments(result, 'premise_load');
  assert.equal(js.length, n, JSON.stringify(js.map((j) => j.cause)));
  assert.ok(js.every((j) => j.cause === '上限を超えた' && j.end === null && j.clause_names.length === 1));
  const ablations = result.performance.executions.filter((x) => x.kind === 'ablation');
  assert.equal(ablations.length, 3, '否定だけ・前提と否定だけ・規則と否定だけの 3 つだけ実行する');
});

// ---- 検証役の指摘への回帰（切り取った実行ごとの答えは偽の z3 の fake-answers で決める） ----
// 前提 2 つ・規則 1 つ・否定 1 つ（名前は P1-p1・P1-p2・P1-r3・P1-g4）
const TWO_PREMISE_SMT = '(declare-const x Int)\n(assert (>= x 0))\n(assert (>= x 1))\n(assert (<= x 8))\n(assert (not (>= (* x x) 0)))';
const twoPremises = (answers, over = {}) => P('P1', 2, { smt: TWO_PREMISE_SMT, roles: ['premise', 'premise', 'rule', 'goal'], scopeVariables: ['x'], fakeCore: () => null, fakeAnswers: () => answers, ...over });
const ablationsOf = (result) => result.performance.executions.filter((x) => x.kind === 'ablation');

test('SP-FORMALMETHOD-012 AC-22: 規則と否定だけが sat で、前提を 1 つずつ外した実行が全て unsat（前提が重なって効いている）なら、前提の組を判断を要する項目にし、前提ごとに「結論を支えていない」と書かない', async (t) => {
  const p = twoPremises([[['P1-g4'], 'sat'], [['P1-p1', 'P1-p2', 'P1-g4'], 'sat'], [['P1-r3', 'P1-g4'], 'sat'], [['P1-p2', 'P1-r3', 'P1-g4'], 'unsat'], [['P1-p1', 'P1-r3', 'P1-g4'], 'unsat']]);
  const { result, status, harness } = await runScenario(t, { scenario: { properties: [p] } });
  assert.deepEqual(resultInvariants(result), []);
  assertRecordsConsistent(status, result, harness);
  const js = judgments(result, 'premise_load');
  assert.equal(js.length, 1, JSON.stringify(js));
  assert.deepEqual([js[0].cause, js[0].clause_names], ['効いている前提の組', ['P1-p1', 'P1-p2']]);
  assert.ok(result.confirmations.meaning.some((c) => c.kind === 'judgment' && c.item === js[0].id), 'その項目の意味の確認の記録がある');
  const per = det(result, 'premise_load').filter((c) => /だけを外しても/.test(c.reason));
  assert.equal(per.length, 2);
  assert.ok(!det(result, 'premise_load').some((c) => /結論を支えていない/.test(c.reason)), '重なって効く前提に「結論を支えていない」と付けない');
});

test('SP-FORMALMETHOD-012 AC-22: 性質の否定の節が無いモデルは、空の否定の実行を組み立てず、静的な確認が成り立たず（未実行）、syntax の欠陥が残って検証の成功にならない', async (t) => {
  const { result } = await runScenario(t, { scenario: { properties: [P('P1', 2, { roles: ['rule', 'rule'] })] } });
  assert.deepEqual(resultInvariants(result), []);
  assert.deepEqual(ablationsOf(result), [], '否定だけの実行を組み立てない');
  for (const kind of ['goal_trivial', 'premise_only', 'premise_load']) {
    const c = det(result, kind).find((x) => x.model_property_id === 'P1');
    assert.equal(c?.result, '確認できず', `${kind}: ${JSON.stringify(c)}`);
    assert.match(c.reason, /性質の否定（role goal）が無い.*未実行/);
  }
  assert.deepEqual(result.confirmations.judgments, [], '意味の確認に回さない');
  assert.equal(det(result, 'syntax')[0]?.result, '成り立たない');
  assert.deepEqual(prop(result, 'P1').verdict, ['未確認']);
  assert.match(prop(result, 'P1').reason, /決定的な検査の静的な確認が成り立たない/);
});

test('SP-FORMALMETHOD-012 AC-22: 節を役ごとに切り取れない検査の入力（名前の無い assert・役の違う節が状態を縛る define-fun を共有する）は、判断を要する項目にせず、決定的な確認の失敗（未実行）として残し、検査の成功を性質の成功にしない', async (t) => {
  const edits = {
    unnamed: (text, { kind }) => (kind === 'property' ? text.replace('(check-sat)', '(assert (<= x 9))\n(check-sat)') : text),
    shared: (text, { kind }) => (kind === 'property' ? text.replace('(declare-const x Int)', '(declare-const x Int)\n(define-fun inr () Bool (and (>= x (- 8)) (<= x 8)))')
      .replace('(and (>= x (- 8)) (<= x 8)) :named P1-r1', 'inr :named P1-r1').replace('(not (>= (* x x) 0)) :named P1-g2', '(not (=> inr (>= (* x x) 0))) :named P1-g2') : text),
  };
  for (const [name, editModelQuery, pattern] of [['unnamed', edits.unnamed, /:named の無い/], ['shared', edits.shared, /define-fun（inr: goal・rule）/]]) {
    const { result } = await runScenario(t, { scenario: { editModelQuery } });
    assert.deepEqual(resultInvariants(result), [], name);
    assert.deepEqual(ablationsOf(result), [], `${name}: 静的な確認の実行を組み立てない`);
    assert.deepEqual(result.confirmations.judgments, [], `${name}: 判断を要する項目にしない`);
    for (const kind of ['goal_trivial', 'premise_only', 'premise_load']) {
      const c = det(result, kind)[0];
      assert.equal(c?.result, '確認できず', `${name} ${kind}`);
      assert.match(c.reason, pattern, `${name} ${kind}: ${c.reason}`);
    }
    assert.ok(result.checks.some((c) => c.id === 'C-P1' && c.verdict === '成功'), `${name}: 性質の検査そのものは成功する`);
    assert.deepEqual(prop(result, 'P1').verdict, ['未確認'], name);
  }
});

test('SP-FORMALMETHOD-012 AC-22: 計画の性質の検査の input_refs が性質の query を含まなければ、計画の照合の欠陥で、その検査は実行しない', async (t) => {
  const editPlan = (plan) => ({ ...plan, checks: plan.checks.map((c) => (c.kind === 'property' ? { ...c, input_refs: plan.sanity.find((x) => x.model_property_id === c.target_id).input_refs } : c)) });
  const { result, harness } = await runScenario(t, { scenario: { editPlan } });
  assert.deepEqual(resultInvariants(result), []);
  const subs = harness.memory.submits.filter((x) => x.role === 'plan-author');
  assert.ok(subs[0].result.problems.some((x) => /input_refs に性質 P1 の query .* が無い/.test(x)), JSON.stringify(subs[0].result));
  assert.ok(!result.checks.some((c) => c.id === 'C-P1' && c.verdict === '成功'), '欠陥の残った検査は実行しない');
  assert.deepEqual(ablationsOf(result), []);
  assert.notDeepEqual(prop(result, 'P1').verdict, ['検証済み']);
});

test('SP-FORMALMETHOD-001・012 AC-22: 前提に外部の依存があっても、外部の依存でない前提と否定だけで unsat なら premise_only は成り立たないと断定し、sat のときだけ判断を要する項目にする', async (t) => {
  const deps = [{ id: 'X1', text: 'x は外部の API が 0 以上に保つ', source: null }];
  for (const [inner, expectJudgment] of [['unsat', false], ['sat', true]]) {
    const p = twoPremises([[['P1-g4'], 'sat'], [['P1-p1', 'P1-p2', 'P1-g4'], 'unsat'], [['P1-p2', 'P1-g4'], inner], [['P1-r3', 'P1-g4'], 'unsat']], { premiseBasis: { 'P1-p1': '外部の依存' } });
    const { result, status } = await runScenario(t, { scenario: { properties: [p], externalDependencies: deps } });
    assert.deepEqual(resultInvariants(result), [], inner);
    const ab = ablationsOf(result);
    const recheck = ab.find((x) => { const text = inputOf(status.run_dir, x.id); return /:named P1-p2/.test(text) && !/:named P1-p1/.test(text) && !/:named P1-r3/.test(text); });
    assert.ok(recheck, `${inner}: 外部の依存の前提を外した再検査を流す`);
    if (expectJudgment) {
      const [j] = judgments(result, 'premise_only');
      assert.deepEqual([j?.cause, j?.clause_names], ['外部の依存', ['P1-p1']], JSON.stringify(result.confirmations.judgments));
      assert.deepEqual(det(result, 'premise_only').map((c) => [c.id, c.result]), [[recheck.id, '成り立つ']], '再検査の答えは決定的な確認に残す');
    } else {
      const c = det(result, 'premise_only')[0];
      assert.equal(c?.result, '成り立たない', JSON.stringify(c));
      assert.match(c.reason, /外部の依存によらず前提だけで結論が出ている/);
      assert.deepEqual(judgments(result, 'premise_only'), []);
      assert.ok(det(result, 'premise_only').some((c) => c.id === recheck.id && c.result === '成り立たない'));
      assert.deepEqual(prop(result, 'P1').verdict, ['未確認']);
    }
  }
});

test('SP-FORMALMETHOD-012 AC-22: 変異が規則の節と一緒に性質の否定の節や宣言を変えたら、自明な変異として mutation_scope が成り立たない', async (t) => {
  const mut = namedClauses(smtQuery('mutation P1', { result: 'sat' }), 'P1', { id: 'P1' }, { mutate: true }).text;
  for (const [name, text, pattern] of [
    ['否定も変える', mut.replace('(not (>= (* x x) 0)) :named P1-g2', '(not (>= (* x x) 1)) :named P1-g2'), /規則でない節 P1-g2（goal）を変える/],
    ['宣言を足す', mut.replace('(declare-const x Int)', '(declare-const x Int)\n(declare-const z Int)'), /assert でない form/],
  ]) {
    const scenario = { editMutations: (m, { put }) => ({ ...m, mutations: m.mutations.map((x) => ({ ...x, mutation_ref: put('both.smt2', text) })) }) };
    const { result } = await runScenario(t, { scenario });
    assert.deepEqual(resultInvariants(result), [], name);
    assertNotSuccess(result, 'mutation_scope', pattern);
  }
});

test('SP-FORMALMETHOD-012 AC-22: 答えが混ざる（否定だけが sat、規則と否定だけが unknown）なら、断定できたものは決定的な確認にし、答えの無い実行だけを判断を要する項目にする', async (t) => {
  const p = withPremise({ fakeCore: () => null, fakeAnswers: () => [[['P1-g3'], 'sat'], [['P1-p1', 'P1-g3'], 'sat'], [['P1-r2', 'P1-g3'], 'unknown']] });
  const { result } = await runScenario(t, { scenario: { properties: [p] } });
  assert.deepEqual(resultInvariants(result), []);
  assert.equal(det(result, 'goal_trivial')[0]?.result, '成り立つ');
  assert.equal(det(result, 'premise_only')[0]?.result, '成り立つ');
  assert.deepEqual(det(result, 'premise_load'), []);
  const [j] = judgments(result, 'premise_load');
  assert.deepEqual([j?.cause, j?.end?.tool_result], ['道具が判定できない', '判定できない']);
  assert.equal(ablationsOf(result).length, 3, '答えの無い規則と否定だけの後に、前提を外す再検査を出さない');
});

test('SP-FORMALMETHOD-010・012 AC-22: 切り取った実行が時間切れか実行失敗なら、その確認を断定せず、判断を要する項目（道具が判定できない）にする', async (t) => {
  for (const [answer, endOk] of [['timeout', (e) => e.time_limit_hit !== null || e.tool_result === '時間切れ'], ['crash', (e) => e.abnormal_exit === true]]) {
    const p = withPremise({ fakeCore: () => null, fakeAnswers: () => [[['P1-g3'], answer], [['P1-p1', 'P1-g3'], 'sat'], [['P1-r2', 'P1-g3'], 'unsat']] });
    const { result } = await runScenario(t, { scenario: { properties: [p] } });
    assert.deepEqual(resultInvariants(result), [], answer);
    assert.deepEqual(det(result, 'goal_trivial'), [], answer);
    const [j] = judgments(result, 'goal_trivial');
    assert.equal(j?.cause, '道具が判定できない', answer);
    assert.ok(endOk(j.end), `${answer}: ${JSON.stringify(j.end)}`);
    assert.equal(det(result, 'premise_only')[0]?.result, '成り立つ', `${answer}: 他の実行は断定する`);
  }
});

test(`SP-FORMALMETHOD-012 AC-22: 前提がちょうど ABLATION_PER_PROPERTY_MAX − 3（${ABLATION_PER_PROPERTY_MAX - 3}）個の性質は、上限ちょうどなので前提を 1 つずつ外す再検査を全て流す`, async (t) => {
  const n = ABLATION_PER_PROPERTY_MAX - 3;
  const smt = ['(declare-const x Int)', ...Array.from({ length: n }, (_, i) => `(assert (>= x (- ${i + 1})))`), '(assert (<= x 8))', '(assert (not (>= (* x x) 0)))'].join('\n');
  const p = P('P1', 2, { smt, roles: [...Array(n).fill('premise'), 'rule', 'goal'], fakeCore: (cs) => cs.map((c) => c.name) });
  const { result } = await runScenario(t, { scenario: { properties: [p] } });
  assert.deepEqual(resultInvariants(result), []);
  assert.equal(ablationsOf(result).length, ABLATION_PER_PROPERTY_MAX, '3 つと前提の数の和が上限ちょうど');
  const js = judgments(result, 'premise_load');
  assert.equal(js.length, n);
  assert.ok(js.every((j) => j.cause === '効いている前提' && j.end?.started), JSON.stringify(js.map((j) => j.cause)));
});

test('SP-FORMALMETHOD-012 AC-22: 前提が一部だけ重なって効く（A は外すと sat、B と C はそれぞれ外しても unsat で、両方外すと sat）なら、A と、B・C の組を判断を要する項目にする', async (t) => {
  const smt = '(declare-const x Int)\n(assert (>= x 0))\n(assert (>= x 1))\n(assert (>= x 2))\n(assert (<= x 8))\n(assert (not (>= (* x x) 0)))';
  const answers = [[['P1-g5'], 'sat'], [['P1-p1', 'P1-p2', 'P1-p3', 'P1-g5'], 'sat'], [['P1-r4', 'P1-g5'], 'sat'],
    [['P1-p2', 'P1-p3', 'P1-r4', 'P1-g5'], 'sat'], [['P1-p1', 'P1-p3', 'P1-r4', 'P1-g5'], 'unsat'], [['P1-p1', 'P1-p2', 'P1-r4', 'P1-g5'], 'unsat'], [['P1-p1', 'P1-r4', 'P1-g5'], 'sat']];
  const p = P('P1', 2, { smt, roles: ['premise', 'premise', 'premise', 'rule', 'goal'], scopeVariables: ['x'], fakeCore: () => null, fakeAnswers: () => answers });
  const { result, status, harness } = await runScenario(t, { scenario: { properties: [p] } });
  assert.deepEqual(resultInvariants(result), []);
  assertRecordsConsistent(status, result, harness);
  const js = judgments(result, 'premise_load').map((j) => [j.cause, j.clause_names]);
  assert.deepEqual(js, [['効いている前提', ['P1-p1']], ['効いている前提の組', ['P1-p2', 'P1-p3']]], JSON.stringify(js));
  const grp = judgments(result, 'premise_load')[1];
  assert.ok(grp.end?.started, '組をまとめて外した実行の終わり方を持つ');
  const text = inputOf(status.run_dir, grp.id);
  assert.match(text, /:named P1-p1/);
  assert.doesNotMatch(text, /:named P1-p2|:named P1-p3/);
  assert.equal(ablationsOf(result).length, 3 + 3 + 1, '3 つ・前提ごとの 3 つ・組の 1 つ');
});

test('SP-FORMALMETHOD-012 AC-22: 1 つずつ外して unsat だった前提の組をまとめて外しても unsat なら、組は結論を支えていないとして決定的な確認にする', async (t) => {
  const smt = '(declare-const x Int)\n(assert (>= x 0))\n(assert (>= x 1))\n(assert (>= x 2))\n(assert (<= x 8))\n(assert (not (>= (* x x) 0)))';
  const answers = [[['P1-g5'], 'sat'], [['P1-p1', 'P1-p2', 'P1-p3', 'P1-g5'], 'sat'], [['P1-r4', 'P1-g5'], 'sat'],
    [['P1-p2', 'P1-p3', 'P1-r4', 'P1-g5'], 'sat'], [['P1-p1', 'P1-p3', 'P1-r4', 'P1-g5'], 'unsat'], [['P1-p1', 'P1-p2', 'P1-r4', 'P1-g5'], 'unsat'], [['P1-p1', 'P1-r4', 'P1-g5'], 'unsat']];
  const p = P('P1', 2, { smt, roles: ['premise', 'premise', 'premise', 'rule', 'goal'], scopeVariables: ['x'], fakeCore: () => null, fakeAnswers: () => answers });
  const { result } = await runScenario(t, { scenario: { properties: [p] } });
  assert.deepEqual(resultInvariants(result), []);
  assert.deepEqual(judgments(result, 'premise_load').map((j) => j.cause), ['効いている前提']);
  assert.ok(det(result, 'premise_load').some((c) => /まとめて外しても充足不能/.test(c.reason)));
});
});

