// 結合: start から terminal まで、担当の harness と PATH の偽の z3 で通し、結果と記録を観測する。
// 担当の harness は test-fixtures/agent-harness.mjs（受け取った task が契約の形に合わなければ、その違反で失敗する）。
// 正本: SP-FORMALMETHOD-003〜015、artifact-formats.md「結果」「検査の終わり方」、cli-contract.md「Z3 の adapter」。
// このファイルは計画の照合・.smt2 の違反・sanity。ファイルを分けて並列に走らせ、共有の道具は test-fixtures/pipeline-cases.mjs に置く。
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { runScenario } from './test-fixtures/pipeline.mjs';
import { resultInvariants } from './test-fixtures/result-schema.mjs';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { P, prop, assertExcluded, tasksOf, assertRevised, PART_SCENARIO, withChosen, SMT_VIOLATIONS, appendAfterCheckSat, assertNoSanityConfirmed, PARTITION_QUERY_VIOLATIONS, partitionViolating, SANITY_CASES, detConf, PART_CASES, PLAN_DEFECTS, onlyRound1, assertRecordsConsistent, z3Candidate, planOf } from './test-fixtures/pipeline-cases.mjs';
import { M1, M2, MP1, MP2, C_P1, C_P2, C_K_A, C_CC1, C_CC2, MU_P1, S_P1, checkIds } from './test-fixtures/core-ids.mjs';

describe('cli-pipeline', { concurrency: 4 }, () => {
test('artifact-formats no_suitable_tool の決め方 SP-FORMALMETHOD-007: chosen.tool が z3 でなく検査も変異も無い性質は、計画の欠陥でなく（修正の巡が出ない）、未実行 で method は選んだ道具を示す', async (t) => {
  const scenario = {
    editPlan: (plan) => ({ ...withChosen('Rust')(plan), checks: [] }),
    editMutations: (m) => ({ ...m, mutations: [], unavailable: [{ property_id: 'P1', reason: 'z3 で実行しない', alternative: null }] }),
  };
  const { result, harness } = await runScenario(t, { scenario });
  assert.deepEqual(resultInvariants(result), []);
  assert.equal(tasksOf(harness, 'plan-author').length, 1, '検査の欠けから除くので修正の巡は出ない');
  assert.deepEqual(prop(result, 'P1').verdict, ['未実行']);
  assert.equal(prop(result, 'P1').method.chosen.tool, 'Rust');
  assert.equal(result.status, '停止');
});
for (const [name, violate] of SMT_VIOLATIONS) {
  for (const kind of ['property', 'sanity']) {
    test(`artifact-formats 担当の成果物: モデル作成役の ${kind} の query で${name}と、モデル化の照合の欠陥で、モデル作成役に修正の巡が出て、直れば通常の結果になる`, async (t) => {
      const editModelQuery = (text, ctx) => (ctx.kind === kind && ctx.round === 1 ? violate(text) : text);
      const { result, harness } = await runScenario(t, { scenario: { editModelQuery } });
      assert.deepEqual(resultInvariants(result), []);
      assertRevised(harness, 'model-author', 'モデル化');
      assert.deepEqual(prop(result, 'P1').verdict, ['検証済み']);
      assert.equal(result.status, '完了', JSON.stringify(result.stop_report));
    });
  }
}
test('artifact-formats 担当の成果物・検査・確認 SP-FORMALMETHOD-012: 修正の巡の後も sanity の query の違反が残れば、その sanity は計画の欠陥として除かれ、性質は 未確認、syntax の確認が 成り立たない ので 確認が終わっていない も持って 停止。result_presence は sanity を数えず 成り立つ', async (t) => {
  const { result, harness } = await runScenario(t, { scenario: { editModelQuery: (text, { kind }) => (kind === 'sanity' ? `${text}(assert true)\n` : text) } });
  assert.deepEqual(resultInvariants(result), []);
  assertRevised(harness, 'model-author', 'モデル化');
  assertExcluded(result, [S_P1]);
  assert.ok(!result.confirmations.deterministic.some((c) => c.kind === 'sanity' && c.property_ids.includes('P1')), 'P1 の sanity の確認は無い');
  // assertNoSanityConfirmed と違い、.smt2 の規則の違反は syntax の区分なので述語 2 も立つ（artifact-formats「syntax・reference・output_format の作り方」）
  assert.deepEqual(prop(result, 'P1').verdict, ['未確認']);
  assert.equal(result.status, '停止');
  const codes = result.stop_report.reasons.map((x) => x.code);
  assert.ok(codes.includes('必要な性質が検証の成功でない'), codes.join());
  assert.ok(codes.includes('確認が終わっていない'), `syntax が 成り立たない ので述語 2 も立つ: ${codes.join()}`);
  const syntax = detConf(result, 'syntax');
  assert.equal(syntax?.result, '成り立たない', String(JSON.stringify(syntax)));
  assert.ok(syntax.reason.includes('モデル化: '), `reason に <段>: <欠陥の文>: ${syntax.reason}`);
  assert.ok(result.stop_report.unconfirmed_scope.includes(syntax.item), `unconfirmed_scope に ${syntax.item}`);
  assert.equal(detConf(result, 'result_presence')?.result, '成り立つ', 'result_presence は PlanFile.checks だけを数え、除いた sanity は数えない');
});
for (const [label, which, checkId] of PARTITION_QUERY_VIOLATIONS) {
  test(`artifact-formats 担当の成果物: 分割作成役の${label}の query の (check-sat) が最後の form でないと、分割の照合の欠陥で分割作成役に修正の巡が出て、直れば通常の結果になる`, async (t) => {
    const { result, harness } = await runScenario(t, { scenario: { ...PART_SCENARIO(), partition: partitionViolating(which, false) } });
    assert.deepEqual(resultInvariants(result), []);
    assertRevised(harness, 'partition-author', '計画');
    assert.deepEqual(prop(result, 'P1').verdict, ['検証済み']);
  });
  // 欠陥の残った分割は採らず、親の性質は全体のモデルの検査だけで判定する（artifact-formats「欠陥の残った分割」）。
  // .smt2 の規則の違反は syntax の区分なので、syntax が 成り立たない で 確認が終わっていない で停止する
  test(`artifact-formats 欠陥の残った分割 SP-FORMALMETHOD-009・012: 分割作成役の${label}の query の違反が修正の巡の後も残れば、分割を採らず（${checkId} を作らない）、親の性質は全体の検査で 検証済み、syntax が 成り立たない で 確認が終わっていない で停止`, async (t) => {
    const { result, harness } = await runScenario(t, { scenario: { ...PART_SCENARIO(), partition: partitionViolating(which, true) } });
    assert.deepEqual(resultInvariants(result), []);
    assertRevised(harness, 'partition-author', '計画');
    assert.equal(result.decomposition.adopted, false);
    assert.deepEqual([result.decomposition.contracts, result.decomposition.composition_conditions], [[], []]);
    assert.ok(!result.checks.some((c) => c.id === checkId || c.kind === 'contract' || c.kind === 'composition'), '分割の検査を作らない');
    assert.deepEqual(prop(result, 'P1').verdict, ['検証済み'], '全体のモデルの検査だけで判定する');
    const syntax = detConf(result, 'syntax');
    assert.equal(syntax?.result, '成り立たない', String(JSON.stringify(syntax)));
    assert.ok(/計画: .+/.test(syntax.reason), `reason: ${syntax.reason}`);
    assert.equal(result.status, '停止');
    assert.ok(result.stop_report.reasons.some((x) => x.code === '確認が終わっていない'), JSON.stringify(result.stop_report.reasons));
  });
}

test('artifact-formats 担当の成果物・検査: 修正の巡の後も (check-sat) の位置の違反が残った .smt2 を使う検査は計画の欠陥として除かれ（unverified[] に載り、どの欄にも無い）、性質は 未確認', async (t) => {
  const { result, harness } = await runScenario(t, { scenario: { editModelQuery: appendAfterCheckSat(() => true) } });
  assert.deepEqual(resultInvariants(result), []);
  assertRevised(harness, 'model-author', 'モデル化');
  assertExcluded(result, [C_P1]);
  assert.deepEqual(prop(result, 'P1').verdict, ['未確認']);
  assert.equal(result.status, '停止');
});
for (const [name, sanity, expected, end = {}] of SANITY_CASES) {
  test(`cli-contract Z3 の adapter: 前提の整合（sanity）の道具が ${name} を返すと、確認の result は ${expected}`, async (t) => {
    const { result } = await runScenario(t, { scenario: { properties: [P('P1', 2, { sanity })] } });
    assert.deepEqual(resultInvariants(result), []);
    const cs = result.confirmations.deterministic.filter((c) => c.kind === 'sanity' && c.property_ids.includes('P1'));
    assert.equal(cs.length, 1);
    assert.equal(cs[0].result, expected, cs[0].reason);
    assert.equal(cs[0].end.started, true);
    for (const [k, v] of Object.entries(end)) assert.equal(cs[0].end[k], v, `end.${k}`);
  });
}

// ======== 分割と合成（PART_CASES）・計画の照合（PLAN_DEFECTS）。計画の段の下書きの形（#264 U4）に依るのでここで流す ========
for (const [name, over, part, contractVerdict, parentVerdict, extra] of PART_CASES) {
  test(`artifact-formats 分割と合成 SP-FORMALMETHOD-009 AC-07: ${name}なら、契約は ${contractVerdict.join()}、親の性質は ${parentVerdict.join()}`, async (t) => {
    const { result, harness } = await runScenario(t, { scenario: PART_SCENARIO(over, part) });
    assert.deepEqual(resultInvariants(result), []);
    const k = result.decomposition.contracts.find((x) => x.id === 'K-a');
    assert.deepEqual(k.verdict, contractVerdict);
    assert.deepEqual(prop(result, 'P1').verdict, parentVerdict);
    if (extra) extra(result, harness);
    if (contractVerdict[0] === '反例') {
      // 契約の反例は Counterexample を作らず、has_counterexample にも数えない
      assert.ok(!result.counterexamples.some((x) => x.check_id === C_K_A), '契約の検査から反例を作らない');
      assert.deepEqual(result.counterexamples, []);
      assert.ok(!result.stop_report.reasons.some((r) => r.code === '反例'), '契約の反例は停止の理由 反例 に数えない');
      assert.ok(k.reason.length > 0);
    }
    if (parentVerdict[0] === '反例') assert.ok(result.counterexamples.some((x) => x.check_id === C_CC2 && x.property_id === 'P1'), '合成の条件の反例は親の性質の反例');
    assert.equal(result.status, '停止');
  });
}
for (const [name, edits, persisted] of PLAN_DEFECTS) {
  test(`artifact-formats plan と mutations 計画の照合: ${name}計画は計画の欠陥で、修正の巡が出て、直れば通常の結果になる`, async (t) => {
    const scenario = Object.fromEntries(Object.entries(edits).map(([k, fn]) => [k, onlyRound1(fn)]));
    const { result, harness, status } = await runScenario(t, { scenario });
    assert.deepEqual(resultInvariants(result), []);
    assertRevised(harness, 'plan-author', '計画');
    assertRecordsConsistent(status, result, harness);
    assert.deepEqual(prop(result, 'P1').verdict, ['検証済み']);
    assert.equal(z3Candidate(prop(result, 'P1').method)?.role, '検証器');
    assert.equal(prop(result, 'P1').method.chosen.tool, 'z3', 'method は selection を写す');
    assert.equal(result.status, '完了', JSON.stringify(result.stop_report));
  });
  if (persisted) {
    test(`artifact-formats plan と mutations 計画の照合: ${name}欠陥が修正の巡の後も残れば、止めずに進み、性質の判定が規則どおり`, async (t) => {
      const { result, harness, status } = await runScenario(t, { scenario: edits });
      assert.deepEqual(resultInvariants(result), []);
      assertRevised(harness, 'plan-author', '計画');
      assertRecordsConsistent(status, result, harness);
      persisted(result);
      assert.equal(result.status, '停止');
    });
  }
}

// ======== #264 SP-264-012（計画の段）・020・021、DD-15・DD-17 ========
const ledgerOf = (status) => JSON.parse(readFileSync(join(status.run_dir, 'ledger.json'), 'utf8'));
const revisionKeys = (status) => ledgerOf(status).revisions.flatMap((r) => r.defects.map((d) => d.key));
const TWO = { properties: [P('P1', 2), P('P2', 3)] };

test('SP-264-012 DD-17: 計画の段も、モデルごとに plan-author の task を 1 つ出し、1 体の worker に順に claim させる', async (t) => {
  const { result, harness } = await runScenario(t, { scenario: TWO });
  assert.deepEqual(resultInvariants(result), []);
  const ts = tasksOf(harness, 'plan-author');
  assert.deepEqual(ts.map((x) => x.context.model_id).sort(), [M1, M2].sort());
  const calls = result.performance.agent_calls.calls.filter((c) => c.stage === '計画');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].workers, 1, '起動は 1 体');
  assert.equal(calls[0].tasks, 2, 'task はモデルの数');
  // モデルごとの計画をモデルの順につないで 1 つの計画にする（どちらの検査も実行される）
  for (const id of [C_P1, C_P2]) assert.ok(result.checks.some((c) => c.id === id), id);
  for (const p of ['P1', 'P2']) assert.deepEqual(prop(result, p).verdict, ['検証済み'], p);
  assert.equal(result.status, '完了', JSON.stringify(result.stop_report));
});

test('SP-264-021 DD-18: plan-author の task の context.target_ids は、そのモデルの性質・契約・合成の条件の id（宣言の順）', async (t) => {
  const { harness } = await runScenario(t, { scenario: PART_SCENARIO() });
  const [task] = tasksOf(harness, 'plan-author');
  assert.equal(task.context.model_id, M1);
  assert.deepEqual(task.context.target_ids, [MP1, 'K-a', 'CC1', 'CC2']);
  const two = await runScenario(t, { scenario: TWO });
  for (const x of tasksOf(two.harness, 'plan-author')) assert.deepEqual(x.context.target_ids, [x.context.model_id === M1 ? MP1 : MP2]);
});

test('SP-264-020・021: 下書きから組み立てた計画は、検査と sanity の id・input_refs・expected・depends_on と変異の detector_check_id を骨組みで埋め、assembled/<task_id>/ に書いて台帳に載せる', async (t) => {
  const { result, harness, status } = await runScenario(t, { scenario: PART_SCENARIO() });
  assert.deepEqual(resultInvariants(result), []);
  const [task] = tasksOf(harness, 'plan-author');
  const draft = JSON.parse(readFileSync(join(task.attempt_dir, 'plan.json'), 'utf8'));
  assert.equal(draft.schema, 'formal-method.plan-draft/1');
  assert.ok(!('checks' in draft) && !('sanity' in draft), '担当は検査と sanity を書かない');
  for (const kind of ['plan', 'mutations']) {
    const ref = `assembled/${task.task_id}/${kind}.json`;
    assert.ok(existsSync(join(status.run_dir, ref)), ref);
    assert.ok(ledgerOf(status).entries.some((e) => e.kind === kind && e.ref === ref && e.producer === task.task_id), `台帳に ${ref}`);
  }
  const { plan, mutations } = planOf(harness);
  assert.deepEqual(plan.checks.map((c) => c.id), [C_P1, C_K_A, C_CC1, C_CC2], 'モデルの順、property → contract → composition');
  const byId = new Map(plan.checks.map((c) => [c.id, c]));
  assert.deepEqual(byId.get(C_P1).depends_on, []);
  assert.deepEqual(byId.get(C_CC1).depends_on, [C_K_A], '合成の条件は depends_on の契約の検査を待つ');
  assert.deepEqual(byId.get(C_CC2).depends_on, []);
  for (const c of plan.checks) { assert.equal(c.expected, 'unsat'); assert.equal(c.input_refs.length, 1); assert.equal(c.model_id, M1); }
  assert.deepEqual(plan.sanity.map((x) => x.id), [S_P1]);
  assert.deepEqual(mutations.mutations.map((m) => [m.id, m.detector_check_id]), [[MU_P1, C_P1]], 'detector_check_id は prop-<property_id>');
});

test('DD-15 DD-17 (a): 2 つのモデルの片方の plan-author だけが形に合わない計画を返し続けても、他方のモデルの検査は計画に残る', async (t) => {
  const editPlanDraft = (d, ctx) => (ctx.model_id === M2 ? { ...d, selection: 'broken' } : d);
  const { result, harness } = await runScenario(t, { scenario: { ...TWO, editPlanDraft } });
  assert.deepEqual(resultInvariants(result), []);
  assert.equal(tasksOf(harness, 'plan-author').length, 2);
  assert.ok(result.checks.some((c) => c.id === C_P1), '形に合うモデルの検査は残る');
  assert.ok(!result.checks.some((c) => c.id === C_P2), '形に合わないモデルの検査は無い');
  assert.deepEqual(prop(result, 'P1').verdict, ['検証済み']);
  assert.deepEqual(prop(result, 'P2').verdict, ['未確認']);
  assert.equal(result.status, '停止');
});

test('DD-15 DD-17 (b): 2 つのモデルで変異の id が重なると mutation-dup の欠陥で後のモデルの plan-author が修正の巡に戻り、直せば通常の結果になる', async (t) => {
  // 計画の task はモデルの順に鎖になり、mutation-dup は後のモデルに付く（architecture・artifact-formats「計画作成役が書くもの」）。
  // モデルの順を定めた正本は無いので、最初に来たモデルを控え、後のモデルの変異の id を先のモデルの変異の id に重ねる
  let first = null;
  let once = true;
  const editMutationsDraft = (d, ctx) => {
    if (first === null) first = ctx.model_id;
    if (ctx.model_id === first || !once) return d;
    once = false;
    const dup = first === M1 ? MU_P1 : checkIds.mutation(MP2);
    return { ...d, mutations: d.mutations.map((m) => ({ ...m, id: dup })) };
  };
  const { result, harness, status } = await runScenario(t, { scenario: { ...TWO, editMutationsDraft } });
  assert.deepEqual(resultInvariants(result), []);
  assert.ok(revisionKeys(status).some((k) => k.startsWith('mutation-dup:')), revisionKeys(status).join());
  assert.ok(first === M1 || first === M2, `最初のモデル: ${first}`);
  const m2 = tasksOf(harness, 'plan-author').find((x) => x.context.model_id !== first);
  assert.ok(m2, '後のモデルの plan-author がある');
  assert.ok(harness.memory.submits.filter((x) => x.task_id === m2.task_id).length >= 2, '後のモデルの plan-author が出し直す');
  for (const p of ['P1', 'P2']) assert.deepEqual(prop(result, p).verdict, ['検証済み'], p);
  assert.equal(result.status, '完了', JSON.stringify(result.stop_report));
});
});
