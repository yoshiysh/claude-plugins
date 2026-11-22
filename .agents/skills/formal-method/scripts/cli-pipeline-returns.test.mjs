// 結合: start から terminal まで、担当の harness と PATH の偽の z3 で通し、結果と記録を観測する。
// 担当の harness は test-fixtures/agent-harness.mjs（受け取った task が契約の形に合わなければ、その違反で失敗する）。
// 正本: SP-FORMALMETHOD-003〜015、artifact-formats.md「結果」「検査の終わり方」、cli-contract.md「Z3 の adapter」。
// このファイルは問い・決定的な確認・担当の返り値・input_refs・ref の指紋。ファイルを分けて並列に走らせ、共有の道具は test-fixtures/pipeline-cases.mjs に置く。
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runScenario, canonicalRequest, SPEC_TEXT } from './test-fixtures/pipeline.mjs';
import { resultInvariants } from './test-fixtures/result-schema.mjs';
import { removeTree, skipIfRoot } from './test-fixtures/cli-runner.mjs';
import { expandRefs } from './test-fixtures/ledger-check.mjs';
import { P, prop, assertExcluded, tasksOf, assertRevised, canonicalRun, hasId, SM, PART_SCENARIO, assertNoChecksRow, QUESTION, QUESTION_CASES, detConf, assertDetCommon, partitionDefect, PARTITION_DEFECTS, assertAuthorPropertyIds, PROPERTY_IDS_CASES, assertInputRefs, timeLimitDiag, NO_MUTATION_CASES, COMBINATION_CASES, HALFWIDTH, EMOJI, wrongGoal } from './test-fixtures/pipeline-cases.mjs';

describe('cli-pipeline', { concurrency: 4 }, () => {
for (const [role, row] of QUESTION_CASES) {
  test(`architecture 段と処理の順序 artifact-formats 検査の欠け: ${role} が問いに依存すると挙げた性質は後の段から外れ、修正の巡が出ず、${row === 'none' ? 'mapping の行を持たず' : '形式化 の行は check_ids が空で reason を持ち'}、depends_on_questions に問いの id を持ち 未確認`, async (t) => {
    const scenario = {
      properties: [P('P1', 2), P('P2', 3)],
      questionsBy: { [role]: [QUESTION] },
      cause: { cause: '要求の不足', grounds: 'R2 は等しい場合を定めない', questions: [QUESTION] },
    };
    const { result, harness } = await runScenario(t, { scenario });
    assert.deepEqual(resultInvariants(result), []);
    assert.equal(tasksOf(harness, 'plan-author').length, 1, '問いに依存する性質の検査の欠けは計画の欠陥でない');
    const rows = result.models.flatMap((m) => m.mapping).filter((x) => x.property_id === 'P2');
    if (row === 'none') {
      assert.deepEqual(rows, [], '抽出役が挙げた性質はモデル化から外れ、mapping の行を持たない');
      assert.deepEqual(prop(result, 'P2').check_ids, []);
    } else {
      assertNoChecksRow(result, 'P2');
      if (role === 'model-author') for (const x of rows.filter((y) => y.relation === '形式化')) assert.ok(x.reason.includes('Q1'), `reason に問いの id: ${x.reason}`);
    }
    assert.ok(prop(result, 'P2').depends_on_questions.includes('Q1'), JSON.stringify(prop(result, 'P2').depends_on_questions));
    assert.deepEqual(prop(result, 'P2').verdict, ['未確認']);
    assert.ok(prop(result, 'P1').check_ids.length >= 1, '他の性質の検査は続ける');
    assert.equal(result.status, '停止');
  });
}
for (const [name, kind] of PARTITION_DEFECTS) {
  test(`artifact-formats 分割の照合の境界 SP-FORMALMETHOD-009 AC-07: ${name}分割は分割の欠陥で、分割作成役に修正の巡が出て、直れば通常の結果になり、syntax・reference は 成り立つ`, async (t) => {
    const { result, harness } = await runScenario(t, { scenario: { ...PART_SCENARIO(), partition: partitionDefect(kind) } });
    assert.deepEqual(resultInvariants(result), []);
    assertRevised(harness, 'partition-author', '計画');
    assert.deepEqual(prop(result, 'P1').verdict, ['検証済み']);
    for (const b of result.decomposition.boundaries) {
      assert.ok(b.responsible.every((id) => result.decomposition.contracts.some((k) => k.id === id && k.part_id === b.producer)), '直った分割の境界');
      assert.notEqual(b.assumption_basis.kind, '共同不変条件');
    }
    // 修正の巡で直った欠陥は数えない（SP-012 の syntax・reference）
    for (const k of ['syntax', 'reference']) { const c = detConf(result, k); assert.equal(c?.result, '成り立つ', `${k}: ${JSON.stringify(c)}`); assertDetCommon(c); }
  });
}
test('artifact-formats 確認 SP-FORMALMETHOD-012: 実在しない id（Boundary.responsible）が修正の巡の後も残れば reference の確認が 成り立たない で、reason に <段>: <欠陥の文> を持ち、unconfirmed_scope に入る', async (t) => {
  const { result, harness } = await runScenario(t, { scenario: { ...PART_SCENARIO(), partition: partitionDefect('responsible', true) } });
  assert.deepEqual(resultInvariants(result), []);
  assertRevised(harness, 'partition-author', '計画');
  const ref = detConf(result, 'reference');
  assert.equal(ref?.result, '成り立たない', String(JSON.stringify(ref)));
  assertDetCommon(ref);
  assert.ok(/計画: .+/.test(ref.reason), `reason: ${ref.reason}`);
  assert.ok(ref.reason.includes('K-missing'), `reason は分割の照合の欠陥（実在しない responsible の K-missing）を指す: ${ref.reason}`);
  assert.equal(detConf(result, 'syntax')?.result, '成り立つ', '参照の欠陥は syntax に数えない');
  // 欠陥の残った分割は採らない（artifact-formats「欠陥の残った分割」）
  const d = result.decomposition;
  assert.equal(d.adopted, false);
  assert.deepEqual([d.parts, d.boundaries, d.contracts, d.composition_conditions], [[], [], [], []]);
  assert.equal(d.reason, '分割の欠陥が残った');
  assert.deepEqual(prop(result, 'P1').verdict, ['検証済み'], '分割を採らないので、親の性質は全体のモデルの検査だけで判定する');
  assert.ok(!result.checks.some((c) => c.kind === 'contract' || c.kind === 'composition'), '分割の検査を作らない');
  assert.ok(d.decisions.length >= 1 && d.decisions.every((x) => x.adopted === false && x.reason === '分割の欠陥が残った'), JSON.stringify(d.decisions));
  assert.deepEqual(d.decisions.map((x) => x.candidate_id).sort(), d.candidates.map((x) => x.id).sort(), 'decisions は導いた候補ごと');
  assert.equal(result.status, '停止');
  assert.ok(result.stop_report.reasons.some((x) => x.code === '確認が終わっていない'));
  assert.ok(result.stop_report.unconfirmed_scope.includes(ref.item));
});

// ---- n=31: AuthorReturn.blocked_by_question は性質の id（artifact-formats「AuthorReturn.blocked_by_question」） ----
test('artifact-formats AuthorReturn.blocked_by_question: モデル作成役が性質の id を挙げて needs_answer を返すと、その性質は計画から外れ、depends_on_questions を持ち 未確認', async (t) => {
  const q = { id: 'Q7', missing_decision: 'R2 の扱い', affected: ['P2'], options: ['許す', '許さない'] };
  const scenario = { properties: [P('P1', 2), P('P2', 3)], questionsBy: { 'model-author': [q] }, cause: { cause: '要求の不足', grounds: 'R2 は定めない', questions: [q] } };
  const { result, harness } = await runScenario(t, { scenario });
  assert.deepEqual(resultInvariants(result), []);
  const ma = harness.memory.authorReturns.find((x) => x.task.role === 'model-author');
  assert.deepEqual(ma.ret.blocked_by_question, ['P2'], 'harness は性質の id を返した');
  const plan = harness.memory.tasks.filter((x) => x.role === 'plan-author').at(-1);
  assert.ok(!plan.context.property_ids.includes('P2'), '計画作成役の property_ids から外れる');
  assert.deepEqual(prop(result, 'P2').check_ids, []);
  assert.ok(prop(result, 'P2').depends_on_questions.includes('Q7'), JSON.stringify(prop(result, 'P2').depends_on_questions));
  assert.deepEqual(prop(result, 'P2').verdict, ['未確認']);
  assert.ok(!result.stop_report.reasons.some((x) => x.code === '担当の失敗'), '性質の id は形の違いでない');
});
test('artifact-formats AuthorReturn.blocked_by_question: モデル作成役が問いの id を blocked_by_question に入れると、返り値の形の違いで 担当の失敗（モデル化）になる', async (t) => {
  const q = { id: 'Q7', missing_decision: 'R2 の扱い', affected: ['P2'], options: ['許す', '許さない'] };
  const scenario = { properties: [P('P1', 2), P('P2', 3)], questionsBy: { 'model-author': [q] }, blockedAs: { 'model-author': 'question_ids' } };
  const { result } = await runScenario(t, { scenario });
  assert.deepEqual(resultInvariants(result), []);
  assert.equal(result.status, '停止');
  assert.ok(result.stop_report.reasons.some((x) => x.code === '担当の失敗' && x.stage === 'モデル化'), JSON.stringify(result.stop_report.reasons));
  const notCreated = result.stop_report.artifacts_not_created.map((x) => x.kind);
  for (const k of ['model', 'mapping']) assert.ok(notCreated.includes(k), `${k} は未作成`);
});
for (const [name, scenario] of PROPERTY_IDS_CASES) {
  test(`artifact-formats 役と context: ${name}とき、model-author と plan-author の context.property_ids が表どおり`, async (t) => {
    const { result, harness } = await runScenario(t, { scenario });
    assert.deepEqual(resultInvariants(result), []);
    assertAuthorPropertyIds(harness);
  });
}

// ---- n=32: result_presence（artifact-formats「result_presence の作り方」） ----
test('artifact-formats result_presence SP-FORMALMETHOD-012: 欠陥が無い計画では 成り立つ', async () => {
  const { result } = await canonicalRun();
  const c = detConf(result, 'result_presence');
  assert.equal(c?.result, '成り立つ', String(JSON.stringify(c)));
  assertDetCommon(c);
});
test('artifact-formats result_presence SP-FORMALMETHOD-012: 欠陥で除いた検査がある計画では 成り立たない で、reason にその id があり、確認が終わっていない で停止', async (t) => {
  const { result } = await runScenario(t, { scenario: { editPlan: (plan) => ({ ...plan, checks: plan.checks.map((c) => (c.id === 'C-P1' ? { ...c, expected: 'sat' } : c)) }) } });
  assert.deepEqual(resultInvariants(result), []);
  assertExcluded(result, ['C-P1']);
  const c = detConf(result, 'result_presence');
  assert.equal(c?.result, '成り立たない', String(JSON.stringify(c)));
  assertDetCommon(c);
  assert.ok(hasId(c.reason, 'C-P1'), `reason に C-P1: ${c.reason}`);
  assert.ok(result.stop_report.reasons.some((x) => x.code === '確認が終わっていない'));
});
test('artifact-formats result_presence SP-FORMALMETHOD-012: 計画が無い（計画作成役が返らない）run では result_presence を作らない', async (t) => {
  const { result } = await runScenario(t, { scenario: { returns: { 'plan-author': 'missing' } } });
  assert.deepEqual(resultInvariants(result), []);
  assert.equal(detConf(result, 'result_presence'), undefined);
});
test('artifact-formats 独立検証者の input_refs: extraction・fidelity・nonformal の task の input_refs が表どおりで、materials と台帳の input_refs はディレクトリを展開した RefHash', async (t) => {
  const out = await runScenario(t, { scenario: { properties: [P('P1', 2), P('P2', 3, { formalizable: false })] } });
  assert.deepEqual(resultInvariants(out.result), []);
  const tasks = out.harness.memory.tasks.filter((x) => x.context.perspective);
  for (const p of ['extraction', 'fidelity', 'nonformal']) assert.ok(tasks.some((x) => x.context.perspective === p), `${p} の task が出る`);
  assert.ok(!tasks.some((x) => x.context.perspective === 'assurance'), '性質ごとの保証の task は出ない');
  assertInputRefs(out, tasks);
});
test('artifact-formats 独立検証者の input_refs: composition の task の input_refs が表どおり', async (t) => {
  const out = await runScenario(t, { scenario: PART_SCENARIO() });
  const tasks = out.harness.memory.tasks.filter((x) => x.context.perspective === 'composition');
  assertInputRefs(out, tasks);
});
test('artifact-formats 原因の分類役の input_refs: 反例の原因の分類役の input_refs が表どおり（先頭は request.json）', async (t) => {
  const out = await runScenario(t, { scenario: { properties: [P('P1', 3, { query: { result: 'sat' } })] } });
  const tasks = out.harness.memory.tasks.filter((x) => x.role === 'cause-analyst');
  assertInputRefs(out, tasks);
});

// ---- n=34: 担当を出さなかった unit と原因（artifact-formats「意味の確認の作り方」の担当を出さなかったとき、「担当の返り値」） ----
// 確認の段の attempt の領域を作れなくする（計画の段の担当が書いた後、attempts/ を書込み不可にする）。
// 時間の上限で確認の段にだけ担当を出さない run は、外から時刻を合わせられないので、同じ規則の 保存の失敗 の経路で起こす
test('artifact-formats 意味の確認 担当の返り値 SP-FORMALMETHOD-012: 確認の段で担当を出さなかった（attempt の領域を作れない）run は、意味の確認が checker cli・materials []・確認できず で unverified[] に写り、原因は classified_by cli・原因未確認 で、担当の失敗 は無い', async (t) => {
  if (skipIfRoot(t)) return;
  let locked = null;
  // 計画作成役の返り値と成果物を書いた後、submit の前に attempts/ を書込み不可にする（後の段の attempts/<task_id>/ を作れない）
  // 外した権限は、失敗しても必ず戻す（runScenario の後始末より先に登録する）
  t.after(() => { if (locked) { try { chmodSync(locked, 0o755); } catch { /* 消し済み */ } } });
  const hooks = { beforeSubmit: async (s, list) => { if (!locked && list.tasks.some((x) => x.role === 'plan-author')) { locked = join(s.run_dir, 'attempts'); chmodSync(locked, 0o555); } } };
  const scenario = { properties: [P('P1', 3, { query: { result: 'sat' } })] };
  let out;
  try { out = await runScenario(t, { scenario, hooks }); } finally { if (locked) chmodSync(locked, 0o755); }
  const { result, harness } = out;
  assert.ok(locked, "計画の段の担当の提出の前に attempts/ を書込み不可にした");
  assert.ok(!harness.memory.tasks.some((x) => x.context.stage === '確認'), '確認の段の担当は出ない');
  assert.deepEqual(resultInvariants(result), []);
  assert.ok(result.confirmations.meaning.length >= 1, '確認の段で組み立てた unit の意味の確認がある');
  for (const c of result.confirmations.meaning) {
    assert.deepEqual([c.checker, c.materials, c.result], ['cli', [], '確認できず'], `${c.item}`);
    assert.ok(c.reason.length > 0);
    assert.ok(result.unverified.some((u) => u.item === c.item && u.reason === c.reason), `unverified[] に ${c.item}`);
  }
  assert.ok(result.counterexamples.length >= 1);
  for (const x of result.counterexamples) {
    const cs = result.causes.filter((c) => c.subject.kind === 'counterexample' && c.subject.id === x.id);
    assert.equal(cs.length, 1, `${x.id} の原因`);
    assert.deepEqual([cs[0].cause, cs[0].classified_by], ['原因未確認', 'cli']);
    assert.ok(cs[0].grounds.length > 0);
  }
  assert.ok(!result.stop_report.reasons.some((x) => x.code === '担当の失敗'), '担当の失敗 は記録しない');
  assert.ok(result.stop_report.reasons.some((x) => x.code === '保存の失敗'), JSON.stringify(result.stop_report.reasons));
});
test('artifact-formats 担当の返り値 SP-FORMALMETHOD-010・011: 時間の上限で確認の段より前に止まった run でも、全ての反例に原因（原因未確認・classified_by cli・grounds が空でない）があり、checker cli の意味の確認は無い', async (t) => {
  // P1 はすぐ反例、P2 は検査に使える期限（上限 12 秒・残す時間 3 秒で、開始から約 9 秒）より長く眠り、実行の段で時間の上限に達する
  const scenario = { toolTimeLimit: 300, properties: [P('P1', 2, { query: { result: 'sat' } }), P('P2', 3, { query: { result: 'unsat', sleepMs: 200000 } })] };
  const { result, harness } = await runScenario(t, { request: canonicalRequest({ time_limit_seconds: 12 }), scenario });
  const why = timeLimitDiag(result, harness);
  assert.deepEqual(resultInvariants(result), []);
  assert.ok(result.stop_report.reasons.some((x) => x.code === '時間の上限'), why);
  assert.ok(!harness.memory.tasks.some((x) => x.context.stage === '確認'), `確認の段の担当は出ない: ${why}`);
  assert.ok(result.counterexamples.length >= 1, `P1 の反例が出る（時間の上限の前に計画まで進む）: ${why}`);
  for (const x of result.counterexamples) {
    const cs = result.causes.filter((c) => c.subject.kind === 'counterexample' && c.subject.id === x.id);
    assert.equal(cs.length, 1, `${x.id} の原因`);
    assert.deepEqual([cs[0].cause, cs[0].classified_by], ['原因未確認', 'cli']);
    assert.ok(cs[0].grounds.length > 0);
  }
  assert.ok(!result.confirmations.meaning.some((c) => c.checker === 'cli'), '確認の段に入らずに止まった run は意味の確認を作らない');
  assert.ok(!result.stop_report.reasons.some((x) => x.code === '担当の失敗'));
});

// ---- SP-012: syntax・reference・output_format（artifact-formats「syntax・reference・output_format の作り方」） ----
test('artifact-formats 確認 SP-FORMALMETHOD-012: 全てが成り立つ run では syntax・reference・output_format・result_presence が 成り立つ で、unverified[] にそれらの item が無い', async () => {
  const { result } = await canonicalRun();
  for (const k of ['syntax', 'reference', 'output_format', 'result_presence']) {
    const c = detConf(result, k);
    assert.equal(c?.result, '成り立つ', `${k}: ${JSON.stringify(c)}`);
    assertDetCommon(c);
    assert.ok(!result.unverified.some((u) => u.item === c.item), `unverified[] に ${c.item} を写さない`);
  }
  assert.equal(result.status, '完了');
});
test('artifact-formats 確認 SP-FORMALMETHOD-012: id の重複（一意の違反）だけが欠陥として残る run では、reference は 成り立つ のまま', async (t) => {
  const { result, harness } = await runScenario(t, { scenario: { allowDuplicatePlanIds: true, editPlan: (plan) => ({ ...plan, sanity: [...plan.sanity, structuredClone(plan.sanity[0])] }) } });
  assert.deepEqual(resultInvariants(result), []);
  // 重複を計画の欠陥として扱った（修正の巡が出て、残った欠陥は unverified[] に 計画の欠陥: で載る）
  assertRevised(harness, 'plan-author', '計画');
  assert.ok(result.unverified.some((u) => u.item.includes('計画の欠陥: ')), `unverified[] に 計画の欠陥: ${JSON.stringify(result.unverified)}`);
  for (const k of ['syntax', 'reference']) assert.equal(detConf(result, k)?.result, '成り立つ', `${k}: 一意の違反は other の区分`);
});
test('artifact-formats 確認 SP-FORMALMETHOD-012: 最後の巡で計画が形に合わなくなれば、その構文の欠陥が syntax に数えられ 成り立たない', async (t) => {
  // 2 巡目は tool_time_limit_seconds を整数でなく文字列にする（PlanFile の形に合わない）
  const editPlan = (plan, { round }) => (round === 1 ? { ...plan, selection: [] } : { ...plan, checks: plan.checks.map((c) => ({ ...c, tool_time_limit_seconds: 'thirty' })) });
  const { result, harness } = await runScenario(t, { scenario: { editPlan } });
  assert.deepEqual(resultInvariants(result), []);
  assertRevised(harness, 'plan-author', '計画');
  const c = detConf(result, 'syntax');
  assert.equal(c?.result, '成り立たない', String(JSON.stringify(c)));
  assert.ok(/計画: .+/.test(c.reason), `reason: ${c.reason}`);
  assert.ok(result.stop_report.unconfirmed_scope.includes(c.item));
});
test('artifact-formats 確認 SP-FORMALMETHOD-012: 偽の z3 が読めない出力を返す run では output_format が 成り立たない で、reason にその実行の id がある', async (t) => {
  const { result } = await runScenario(t, { scenario: { toolTimeLimit: 2, properties: [P('P1', 2, { query: { result: 'maybe' } })] } });
  assert.deepEqual(resultInvariants(result), []);
  const c = detConf(result, 'output_format');
  assert.equal(c?.result, '成り立たない', String(JSON.stringify(c)));
  assertDetCommon(c);
  assert.ok(hasId(c.reason, 'C-P1'), `reason に C-P1: ${c.reason}`);
  assert.ok(result.stop_report.unconfirmed_scope.includes(c.item));
});
test('artifact-formats 確認 SP-FORMALMETHOD-012: z3 が (error …) を返す run では、検査は 実行失敗 で、output_format は 成り立つ', async (t) => {
  const { result } = await runScenario(t, { scenario: { toolTimeLimit: 2, properties: [P('P1', 2, { query: { mode: 'syntax-error' } })] } });
  assert.deepEqual(resultInvariants(result), []);
  assert.equal(result.checks.find((x) => x.id === 'C-P1').verdict, '実行失敗');
  assert.equal(detConf(result, 'output_format')?.result, '成り立つ');
});
test('artifact-formats 確認 SP-FORMALMETHOD-012: 時間の上限で止めた実行だけの run では、output_format は 成り立つ', async (t) => {
  // 上限 12 秒（検査に使える期限は開始から約 9 秒）。全ての実行が期限より長く眠る
  const sleep = { sleepMs: 200000 };
  const scenario = { toolTimeLimit: 300, properties: [P('P1', 2, { query: { result: 'unsat', ...sleep }, sanity: { result: 'sat', ...sleep }, mutation: { result: 'sat', ...sleep } })] };
  const { result, harness } = await runScenario(t, { request: canonicalRequest({ time_limit_seconds: 12 }), scenario });
  const why = timeLimitDiag(result, harness);
  assert.deepEqual(resultInvariants(result), []);
  const ends = [...result.checks.map((x) => x.end), ...result.confirmations.deterministic.filter((x) => x.end).map((x) => x.end)].filter((e) => e.started);
  assert.ok(ends.length >= 1, `道具の実行が始まった（時間の上限の前に実行の段まで進む）: ${why}`);
  assert.ok(ends.every((e) => e.stopped_by === '時間'), `始めた実行は全て時間の上限で止まった: ${JSON.stringify(ends)}; ${why}`);
  assert.equal(detConf(result, 'output_format')?.result, '成り立つ');
});
test('artifact-formats 確認 SP-FORMALMETHOD-012: 照合した成果物も道具の実行も無い run（受付で止まる）では、syntax・reference・output_format を作らない', async (t) => {
  const { result } = await runScenario(t, { request: { targets: [{ id: 'T1', location: 'target' }], goals: [] } });
  assert.equal(result.status, '停止');
  for (const k of ['syntax', 'reference', 'output_format', 'result_presence']) assert.equal(detConf(result, k), undefined, k);
});
for (const [name, alternative] of NO_MUTATION_CASES) {
  test(`artifact-formats 変異の無い性質の detection SP-FORMALMETHOD-012: 変異を用意できず ${name}性質は、検出能力未確認（mutations []）で、reason に「別の方法の確認の結果が無い」を持ち、run は 検出能力未確認 で 停止`, async (t) => {
    const editMutations = (m) => ({ ...m, mutations: [], unavailable: [{ property_id: 'P1', reason: '変異を作れない', alternative }] });
    const { result } = await runScenario(t, { scenario: { properties: [P('P1', 2, { mutation: null })], editMutations } });
    assert.deepEqual(resultInvariants(result), []);
    const p = prop(result, 'P1');
    assert.ok(result.confirmations.meaning.some((c) => c.kind === 'fidelity' && c.property_ids.includes('P1') && c.result === '成り立つ'), '忠実さの確認は 成り立つ');
    assert.equal(p.detection.status, '検出能力未確認', '別の方法で確認 にしない');
    assert.deepEqual(p.detection.mutations, []);
    assert.ok(p.detection.reason.includes('別の方法の確認の結果が無い'), p.detection.reason);
    if (alternative) assert.ok(p.detection.reason.includes(alternative), `reason に alternative の文: ${p.detection.reason}`);
    // detection_performed は false なので判定は検出に依らない（検出能力未確認は判定に混ぜず述語 7 で完了を妨げる）
    assert.deepEqual(p.verdict, ['検証済み']);
    assert.equal(result.status, '停止');
    assert.ok(result.stop_report.reasons.some((x) => x.code === '検出能力未確認'), JSON.stringify(result.stop_report.reasons));
  });
}
for (const [name, sm, n] of COMBINATION_CASES) {
  test(`artifact-formats 役と context: ${name}の 対応できていない 組合せの原因の分類役は unit_id が cause-combination-M1-${n} で、返り値が受け入れられる`, async (t) => {
    const { result, harness } = await runScenario(t, { scenario: { stateMachine: sm } });
    assert.deepEqual(resultInvariants(result), []);
    const task = harness.memory.tasks.find((x) => x.role === 'cause-analyst' && x.context.subject?.kind === 'combination');
    assert.ok(task, '組合せの原因の分類役が出る');
    assert.equal(task.context.unit_id, `cause-combination-M1-${n}`);
    const cell = result.models[0].combinations.cells[n];
    assert.deepEqual([task.context.subject.state, task.context.subject.event], [cell.state, cell.event], '組合せの名前は subject が持つ');
    assert.equal(cell.class, '対応できていない');
    const c = result.causes.find((x) => x.subject.kind === 'combination');
    assert.equal(c.classified_by, task.task_id, '返り値を受け入れた（原因未確認 でない）');
    assert.equal(c.cause, '対象が性質を満たさない');
    assert.ok(!result.stop_report.reasons.some((x) => x.code === '担当の失敗'), JSON.stringify(result.stop_report.reasons));
  });
}

// 欠陥の区分が other だけ（共同不変条件は「前提の循環」と同じく other。artifact-formats「欠陥の区分」）の分割が残る run:
// 分割を採らず、親の性質は全体のモデルの検査どおりで、syntax・reference は 成り立つ
test('artifact-formats 欠陥の残った分割 SP-FORMALMETHOD-009・012: other の区分の欠陥（共同不変条件）だけが残る分割は採らず、親の性質は全体の検査どおり 検証済み で、syntax・reference は 成り立つ', async (t) => {
  const { result, harness } = await runScenario(t, { scenario: { ...PART_SCENARIO(), partition: partitionDefect('joint', true) } });
  assert.deepEqual(resultInvariants(result), []);
  assertRevised(harness, 'partition-author', '計画');
  const d = result.decomposition;
  assert.equal(d.adopted, false);
  assert.equal(d.reason, '分割の欠陥が残った');
  assert.deepEqual([d.parts, d.boundaries, d.contracts, d.composition_conditions], [[], [], [], []]);
  assert.equal(result.checks.find((c) => c.id === 'C-P1')?.verdict, '成功', '全体のモデルの検査');
  assert.deepEqual(prop(result, 'P1').verdict, ['検証済み']);
  for (const k of ['syntax', 'reference']) assert.equal(detConf(result, k)?.result, '成り立つ', `${k}: other の区分は写さない`);
});
test('expandRefs の自己検査: ディレクトリの中は UTF-8 のバイト列の辞書順で、UTF-16 の順とずれる名前でもバイト列の順に並べ、要素の順は input_refs のまま', async (t) => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'fm-expand-'));
  t.after(() => removeTree(dir));
  mkdirSync(join(dir, 'd', 'sub'), { recursive: true });
  for (const n of [`${EMOJI}.txt`, `${HALFWIDTH}.txt`, 'a.txt', 'sub/b.txt']) writeFileSync(join(dir, 'd', n), n);
  writeFileSync(join(dir, 'z.json'), '{}');
  assert.ok(`${EMOJI}.txt` < `${HALFWIDTH}.txt`, '前提: UTF-16 の順では絵文字が先');
  const refs = expandRefs(dir, [{ name: 'z', ref: 'z.json' }, { name: 'd', ref: 'd/' }]).map((x) => x.ref);
  // 's'（0x73）は EF・F0 より前なので sub/b.txt は a.txt の次。U+FF61（EF）は U+1F600（F0）より前
  assert.deepEqual(refs, ['z.json', 'd/a.txt', 'd/sub/b.txt', `d/${HALFWIDTH}.txt`, `d/${EMOJI}.txt`], 'ファイルの要素はそのまま先、ディレクトリの中はバイト列の順');
});
test('artifact-formats 担当に渡す資料の順: 対象に UTF-16 の順とずれる名前のファイルがあっても、対象の全体を渡す抽出の確認役の materials は UTF-8 のバイト列の順に並ぶ', async (t) => {
  const files = { 'target/spec.md': SPEC_TEXT, [`target/${HALFWIDTH}.md`]: '半角の句点\n', [`target/${EMOJI}.md`]: '絵文字\n' };
  const out = await runScenario(t, { files, scenario: {} });
  assert.deepEqual(resultInvariants(out.result), []);
  const tasks = out.harness.memory.tasks.filter((x) => x.context.perspective === 'extraction');
  assert.ok(tasks.length >= 1);
  for (const task of tasks) {
    const conf = out.result.confirmations.meaning.find((c) => c.checker === task.task_id);
    const refs = conf.materials.map((m) => m.ref);
    const iH = refs.indexOf(`target:T1/${HALFWIDTH}.md`);
    const iE = refs.indexOf(`target:T1/${EMOJI}.md`);
    assert.ok(iH >= 0 && iE >= 0 && iH < iE, `${task.task_id}: ${refs.join(', ')}`);
    assert.deepEqual(conf.materials, expandRefs(out.status.run_dir, task.context.input_refs));
  }
});
test('artifact-formats goals の property_id: モデル作成役が 1 巡目だけ目標の性質の id を誤ると、モデル化の照合の欠陥で修正の巡が出て、直れば目標が Paths.targets に載る', async (t) => {
  const { result, harness } = await runScenario(t, { scenario: { stateMachine: SM, editStateMachine: wrongGoal(false) } });
  assert.deepEqual(resultInvariants(result), []);
  assertRevised(harness, 'model-author', 'モデル化');
  const paths = result.models[0].paths;
  assert.equal(paths.applicable, true);
  assert.ok(paths.targets.some((x) => x.state === '完了' && x.property_id === 'P1'), JSON.stringify(paths.targets));
  assert.ok(!paths.unverified.some((u) => u.reason === '目標の性質が無い'), JSON.stringify(paths.unverified));
  assert.equal(detConf(result, 'reference')?.result, '成り立つ', '修正の巡で直った欠陥は数えない');
});
test('artifact-formats goals の property_id: 目標の性質の id の誤りが修正の巡の後も残ると、reference が 成り立たない（reason に目標と性質の id）で、その目標は Paths.targets に無く Paths.unverified に 目標の性質が無い で載る', async (t) => {
  const { result, harness } = await runScenario(t, { scenario: { stateMachine: SM, editStateMachine: wrongGoal(true) } });
  assert.deepEqual(resultInvariants(result), []);
  assertRevised(harness, 'model-author', 'モデル化');
  const ref = detConf(result, 'reference');
  assert.equal(ref?.result, '成り立たない', String(JSON.stringify(ref)));
  assert.ok(ref.reason.includes('モデル化: '), `reason は <段>: <欠陥の文>: ${ref.reason}`);
  assert.ok(ref.reason.includes('完了') && ref.reason.includes('P-missing'), `reason に目標（完了）と性質の id（P-missing）: ${ref.reason}`);
  const paths = result.models[0].paths;
  assert.equal(paths.applicable, true);
  assert.ok(!paths.targets.some((x) => x.state === '完了'), `目標 完了 は Paths.targets に無い: ${JSON.stringify(paths.targets)}`);
  assert.ok(paths.unverified.some((u) => u.target === '完了' && u.reason === '目標の性質が無い'), JSON.stringify(paths.unverified));
  assert.equal(result.status, '停止');
  assert.ok(result.stop_report.reasons.some((x) => x.code === '確認が終わっていない'));
});
// ---- 対象をまたぐ id の重なり（architecture.md「段と処理の順序」の洗い出し） ----
test('architecture 洗い出し: 後の対象（T2）が先に submit して受理された後に T1 が同じ id の inventory を出すと、提出の順序に依らず T1（後から submit した側）の欠陥にし、受理済みの T2 は変えない', async (t) => {
  let t2Accepted;
  const accepted = new Promise((r) => { t2Accepted = r; });
  const isExtractor = (task, tid) => task.role === 'extractor' && task.context.target_id === tid;
  const hooks = {
    // T1 の提出は、T2 の受理を待ってから出す（待ちきれなければ失敗にする）
    beforeSubmit: async (_s, { tasks }) => {
      if (!tasks.some((x) => isExtractor(x, 'T1'))) return;
      await Promise.race([accepted, new Promise((_, rej) => { setTimeout(() => rej(new Error('T2 の抽出役が受理されない')), 30000).unref(); })]);
    },
    afterSubmit: async (_s, { task, result }) => { if (isExtractor(task, 'T2') && result.done) t2Accepted(); },
  };
  const request = canonicalRequest({ targets: [{ id: 'T1', location: 'target' }, { id: 'T2', location: 'target2' }] });
  const { harness } = await runScenario(t, { files: { 'target/spec.md': SPEC_TEXT, 'target2/spec.md': SPEC_TEXT }, request, hooks });
  const subs = (tid) => harness.memory.submits.filter((x) => harness.memory.tasks.some((k) => k.task_id === x.task_id && isExtractor(k, tid)));
  const dup = (x) => [...(x.result?.problems ?? []), ...(x.result?.remaining ?? [])].filter((d) => /重なる/.test(d));
  const t2 = subs('T2');
  assert.ok(t2.length >= 1 && t2[0].result.ok && t2[0].result.done, `T2 は最初の提出で受理: ${JSON.stringify(t2)}`);
  assert.deepEqual(t2.flatMap(dup), [], '受理済みの T2 に重なりの欠陥を付けない');
  const t1 = subs('T1');
  assert.ok(t1.length >= 1, JSON.stringify(harness.memory.submits));
  const first = dup(t1[0]);
  assert.ok(first.some((d) => d.includes('性質の id P1') && d.includes('対象 T2')), `T1 の最初の提出に性質の重なり: ${JSON.stringify(t1[0])}`);
  assert.ok(first.some((d) => d.includes('要素の id E-P1') && d.includes('対象 T2')), `T1 の最初の提出に要素の重なり: ${JSON.stringify(t1[0])}`);
  assert.equal(t1[0].result.ok, false, '重なりは T1 の修正の巡に戻す');
});
test('architecture 洗い出し: 両方とも未受理で id が重なるとき、前の対象（T1）が後から submit しても欠陥にせず、後ろの対象（T2）だけを差し戻す', async (t) => {
  const signal = () => { let r; const p = new Promise((x) => { r = x; }); return { p, r }; };
  const t2Rejected = signal();
  const t1Accepted = signal();
  const wait = (p, why) => Promise.race([p, new Promise((_, rej) => { setTimeout(() => rej(new Error(why)), 30000).unref(); })]);
  const isExtractor = (task, tid) => task.role === 'extractor' && task.context.target_id === tid;
  let t2Round = 0;
  const hooks = {
    beforeSubmit: async (_s, { tasks }) => {
      const task = tasks[0];
      // T1 は、T2 の下書き（別の欠陥で差し戻された提出）が控えられてから出す
      if (isExtractor(task, 'T1')) { await wait(t2Rejected.p, 'T2 の最初の提出が差し戻されない'); return; }
      if (!isExtractor(task, 'T2')) return;
      t2Round += 1;
      if (t2Round === 1) {
        // 最初の提出だけ、出所の無い source_ids を 3 つ足して差し戻させる（id は変えない）
        const f = join(task.attempt_dir, 'inventory.json');
        const inv = JSON.parse(readFileSync(f, 'utf8'));
        inv.properties[0].source_ids.push('E-none1', 'E-none2', 'E-none3');
        writeFileSync(f, JSON.stringify(inv, null, 2));
      } else if (t2Round === 2) await wait(t1Accepted.p, 'T1 の抽出役が受理されない');
    },
    afterSubmit: async (_s, { task, result }) => {
      if (isExtractor(task, 'T2') && !result.ok) t2Rejected.r();
      if (isExtractor(task, 'T1') && result.done) t1Accepted.r();
    },
  };
  const request = canonicalRequest({ targets: [{ id: 'T1', location: 'target' }, { id: 'T2', location: 'target2' }] });
  const { harness } = await runScenario(t, { files: { 'target/spec.md': SPEC_TEXT, 'target2/spec.md': SPEC_TEXT }, request, hooks });
  const subs = (tid) => harness.memory.submits.filter((x) => harness.memory.tasks.some((k) => k.task_id === x.task_id && isExtractor(k, tid)));
  const dup = (x) => [...(x.result?.problems ?? []), ...(x.result?.remaining ?? [])].filter((d) => /重なる/.test(d));
  const t1 = subs('T1');
  assert.ok(t1.length >= 1 && t1[0].result.ok && t1[0].result.done, `T1 は未受理の T2 と重なっても最初の提出で受理: ${JSON.stringify(t1)}`);
  assert.deepEqual(t1.flatMap(dup), [], '前の対象 T1 に重なりの欠陥を付けない');
  const t2 = subs('T2');
  assert.ok(t2.length >= 2, JSON.stringify(t2));
  assert.equal(t2[0].result.ok, false, 'T2 の最初の提出は出所の欠陥で差し戻す');
  assert.deepEqual(dup(t2[0]), [], 'T2 の最初の提出の時点では T1 がまだ無い');
  assert.equal(t2[1].result.ok, false, 'T2 の 2 回目の提出は重なりで差し戻す');
  assert.ok(dup(t2[1]).some((d) => d.includes('性質の id P1') && d.includes('対象 T1')), `T2 の 2 回目の提出に重なり: ${JSON.stringify(t2[1])}`);
});
});
