// 結合: start から terminal まで、担当の harness と PATH の偽の z3 で通し、結果と記録を観測する。
// 担当の harness は test-fixtures/agent-harness.mjs（受け取った task が契約の形に合わなければ、その違反で失敗する）。
// 正本: SP-FORMALMETHOD-003〜015、artifact-formats.md「結果」「検査の終わり方」、cli-contract.md「Z3 の adapter」。
// このファイルは計画の照合・.smt2 の違反・sanity。ファイルを分けて並列に走らせ、共有の道具は test-fixtures/pipeline-cases.mjs に置く。
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { runScenario } from './test-fixtures/pipeline.mjs';
import { resultInvariants } from './test-fixtures/result-schema.mjs';
import { P, prop, assertExcluded, tasksOf, assertRevised, PART_SCENARIO, withChosen, SMT_VIOLATIONS, appendAfterCheckSat, assertNoSanityConfirmed, PARTITION_QUERY_VIOLATIONS, partitionViolating, SANITY_CASES, detConf } from './test-fixtures/pipeline-cases.mjs';

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
  assertExcluded(result, ['S-P1']);
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
  assertExcluded(result, ['C-P1']);
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
});
