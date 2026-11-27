// 結合: start から terminal まで、担当の harness と PATH の偽の z3 で通し、結果と記録を観測する。
// 担当の harness は test-fixtures/agent-harness.mjs（受け取った task が契約の形に合わなければ、その違反で失敗する）。
// 正本: SP-FORMALMETHOD-003〜015、artifact-formats.md「結果」「検査の終わり方」、cli-contract.md「Z3 の adapter」。
// このファイルは確認の担当の失敗・停止の段・状態機械・依存グラフ・分割と合成・証人・検査の欠け。ファイルを分けて並列に走らせ、共有の道具は test-fixtures/pipeline-cases.mjs に置く。
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { runScenario, canonicalRequest, wrapCore } from './test-fixtures/pipeline.mjs';
import { makeWorkspace, removeTree } from './test-fixtures/cli-runner.mjs';
import { resultInvariants } from './test-fixtures/result-schema.mjs';
import { SM2, SM2_PROPS, partitionFixture } from './test-fixtures/partition.mjs';
import { writerMergeScc, stopStageViolations, crossingEdges } from './test-fixtures/decomposition-check.mjs';
import { TOOL_OUTPUT_MAX_BYTES } from './test-fixtures/constants.mjs';
import { M1, M2, MP1, C_P1, C_P2, C_K_A, C_CC1, C_CC2 } from './test-fixtures/core-ids.mjs';
import { P, prop, checksOf, planOf, queryOf, evidence, inputOf, callsFor, tOf, tasksOf, assertRevised, assertRecordsConsistent, canonicalRun, firstCallWith, assertAcceptedKept, assertConfirmationCommon, assertReviewFailed, assertCauseFailed, reviewTasks, REVIEW_FAIL_CASES, CAUSE_FAIL_CASES, STAGE_CASES, SM, topLevelForms, resolvePointer, CLAIM_CASES, assertGraphMatches, partitionWithUnconfirmedAssumption, SM_A, SMT_A, counterexampleQueries, assertNamedInOrder, WITNESS_SMT, WITNESS_MODEL, SECRET, assertSecretNowhere, NOT_STARTED_END, WITNESS_CASES, PART_SCENARIO, dropChecks, assertNoChecksRow, NO_PLAN_CASES, assertExcluded, appendAfterCheckSat } from './test-fixtures/pipeline-cases.mjs';

describe('cli-pipeline', { concurrency: 4 }, () => {
test('cli-contract 受け箱 SP-FORMALMETHOD-012・015: 確認の段の呼び出しを timed_out で閉じても、submit で受理した確認は残り、性質は 検証済み で完了する（前の稿の batch ごとの拒否の回帰）', async (t) => {
  const pick = firstCallWith('fidelity-reviewer');
  const out = await runScenario(t, { hooks: { close: (s, call) => (pick(s, call) ? 'timed_out' : null) } });
  const call = assertAcceptedKept(out, 'timed_out');
  assert.equal(call.stage, '確認', '独立検証者の呼び出しは確認の段（architecture「段と処理の順序」）');
  assert.deepEqual(prop(out.result, 'P1').verdict, ['検証済み']);
  assert.equal(out.result.status, '完了', JSON.stringify(out.result.stop_report?.reasons));
});
for (const [perspective, mode, scenario, verdicts] of REVIEW_FAIL_CASES) {
  test(`artifact-formats 確認 担当の返り値 SP-FORMALMETHOD-012・015 AC-19: ${perspective} の照合役が${mode === 'missing' ? '返らない' : '形の違う返り値を返す'}と、その unit の確認が 確認できず で 1 つでき、unverified・unconfirmed_scope に写り、確認が終わっていない で停止する`, async (t) => {
    const base = typeof scenario === 'function' ? scenario() : scenario;
    const { result, harness } = await runScenario(t, { scenario: { ...base, returnsByPerspective: { [perspective]: mode } } });
    assert.deepEqual(resultInvariants(result), []);
    const failed = reviewTasks(harness, perspective);
    assert.ok(failed.length >= 1, `${perspective} の task が出る`);
    for (const task of failed) assertReviewFailed(result, task, harness);
    verdicts(result);
    assert.deepEqual(stopStageViolations(result), []);
  });
}
for (const [name, scenario, kind] of CAUSE_FAIL_CASES) {
  test(`artifact-formats 担当の返り値 SP-FORMALMETHOD-011 AC-19: ${name}と、その subject の原因が 原因未確認・grounds は 担当の失敗 の detail・classified_by はその task で 1 つでき、確認は作らない`, async (t) => {
    const { result, harness } = await runScenario(t, { scenario });
    assert.deepEqual(resultInvariants(result), []);
    const failed = harness.memory.tasks.filter((x) => x.role === 'cause-analyst' && x.context.subject?.kind === kind);
    assert.ok(failed.length >= 1, `subject が ${kind} の原因の分類役の task が出る`);
    for (const task of failed) assertCauseFailed(result, task);
  });
}

test('artifact-formats 確認 SP-FORMALMETHOD-012: 正常に返った照合役の確認は result が返り値の result で、reason は空でない文。確認できず は unverified[] に写る', async (t) => {
  const reviews = { fidelity: '確認できず', extraction: '成り立たない' };
  const { result, harness } = await runScenario(t, { scenario: { reviews } });
  assert.deepEqual(resultInvariants(result), []);
  const tasks = harness.memory.tasks.filter((x) => x.context.perspective);
  assert.ok(tasks.length >= 1);
  for (const task of tasks) {
    const c = task.context;
    const confs = result.confirmations.meaning.filter((x) => x.checker === task.task_id);
    assert.equal(confs.length, 1, `${task.task_id} の意味の確認がちょうど 1 つ`);
    const conf = confs[0];
    assertConfirmationCommon(conf, task, harness);
    assert.equal(conf.result, reviews[c.perspective] ?? '成り立つ', `${c.unit_id} の result は ReviewReturn.result`);
    assert.equal(typeof conf.reason, 'string');
    assert.ok(conf.reason.trim().length > 0, 'reason は空でない文');
    if (conf.result === '確認できず') {
      assert.ok(result.unverified.some((u) => u.item === c.unit_id && u.reason === conf.reason), `unverified[] に ${c.unit_id}`);
      assert.ok(result.stop_report.unconfirmed_scope.includes(c.unit_id), `unconfirmed_scope に ${c.unit_id}: ${JSON.stringify(result.stop_report.unconfirmed_scope)}`);
    }
  }
  // 成り立つ でない意味の確認が残るので confirmations_unresolved が true（artifact-formats「decideStatus」）
  assert.equal(result.status, '停止');
  assert.ok(result.stop_report.reasons.some((x) => x.code === '確認が終わっていない'), JSON.stringify(result.stop_report.reasons));
  assert.ok(result.confirmations.meaning.some((x) => x.kind === 'fidelity' && x.result === '確認できず'), '忠実さの確認できず の行が出る');
});

test('artifact-formats decideStatus SP-FORMALMETHOD-012・015: 意味の確認が 成り立たない だけ（確認できず が無い）でも confirmations_unresolved が true で、確認が終わっていない で停止する', async (t) => {
  const { result } = await runScenario(t, { scenario: { reviews: { extraction: '成り立たない' } } });
  assert.deepEqual(resultInvariants(result), []);
  assert.ok(result.confirmations.meaning.some((x) => x.kind === 'extraction' && x.result === '成り立たない'), '抽出の確認が 成り立たない');
  assert.ok(!result.confirmations.meaning.some((x) => x.result === '確認できず'), '確認できず の意味の確認は無い');
  assert.equal(result.status, '停止');
  assert.ok(result.stop_report.reasons.some((x) => x.code === '確認が終わっていない'), JSON.stringify(result.stop_report.reasons));
});
for (const [name, scenario, tool, stage] of STAGE_CASES) {
  test(`SP-FORMALMETHOD-015 AC-19: ${name} と、停止の報告の段が規則どおりで（${stage}）、その段の作業記録があり、7 項目を区別して持つ`, async (t) => {
    const { result, status } = await runScenario(t, { scenario, tool });
    assert.deepEqual(resultInvariants(result), []);
    assert.equal(result.status, '停止');
    assert.deepEqual(stopStageViolations(result), [], JSON.stringify(result.stop_report.reasons));
    assert.equal(result.stop_report.stage, stage, JSON.stringify(result.stop_report.reasons));
    const log = join(status.run_dir, 'worklogs', `cli-${stage}.json`);
    assert.ok(existsSync(log), `入った段の作業記録 worklogs/cli-${stage}.json がある`);
    assert.equal(JSON.parse(readFileSync(log, 'utf8')).stage, stage);
    for (const k of ['stage', 'reasons', 'confirmed_scope', 'unconfirmed_scope', 'artifacts_created', 'artifacts_not_created', 'checks_running', 'checks_aborted', 'questions', 'unsaved']) assert.ok(k in result.stop_report, k);
  });
}

test('SP-FORMALMETHOD-003 AC-21: 完了・停止のどちらでも report.md の成功の語は構造の該当する欄にある', async (t) => {
  const done = await canonicalRun();
  const stopped = await runScenario(t, { scenario: { properties: [P('P1', 2), P('P2', 3, { query: { result: 'sat' } })] } });
  for (const { status, result } of [done, stopped]) {
    const report = readFileSync(join(status.run_dir, 'report.md'), 'utf8');
    for (const line of report.split('\n')) {
      for (const [word, verdict] of [['検証済み', '検証済み'], ['別手段で確認済み', '別手段で確認済み']]) {
        if (!line.includes(word) || line.includes(`未${word}`)) continue;
        for (const p of result.properties) {
          if (new RegExp(`(^|[^A-Za-z0-9._-])${p.id.replace(/[.]/g, '\\.')}([^A-Za-z0-9._-]|$)`).test(line)) assert.deepEqual(p.verdict, [verdict], `report.md の行「${line}」`);
        }
      }
    }
    if (result.status === '停止') assert.ok(!/状態[^\n]*[:：]\s*完了/.test(report), 'report.md が 完了 と表示しない');
  }
  assert.deepEqual(resultInvariants(stopped.result), []);
  assert.ok(stopped.result.stop_report && done.result.stop_report === null);
});

test('SP-FORMALMETHOD-006・015 AC-03: 全ての状態×出来事が 3 区分と根拠を持ち、対応できていない組合せは未検証と原因に現れ、完了 にならない', async (t) => {
  const { result } = await runScenario(t, { scenario: { stateMachine: SM } });
  const m = result.models[0];
  assert.equal(m.combinations.applicable, true);
  const cells = m.combinations.cells;
  assert.equal(cells.length, SM.states.length * SM.events.length);
  assert.deepEqual(cells.map((c) => `${c.state}/${c.event}`), SM.states.flatMap((s) => SM.events.map((e) => `${s}/${e}`)), '宣言順');
  const cls = (s, e) => cells.find((c) => c.state === s && c.event === e).class;
  assert.equal(cls('待ち', '開始'), '許される');
  assert.equal(cls('完了', '開始'), '禁止された');
  assert.equal(cls('待ち', '終了'), '対応できていない');
  // 遷移が書かれていないことだけを禁止の根拠にしない: 定めの無い組は 禁止された にならない
  assert.equal(cls('実行中', '開始') === '禁止された', false);
  for (const c of cells) assert.ok(c.grounds.length > 0);
  assert.ok(result.causes.some((c) => c.subject.kind === 'combination' && c.subject.state === '待ち' && c.subject.event === '終了'));
  assert.ok(result.unverified.some((u) => u.item.includes('待ち') && u.item.includes('終了')));
  assert.equal(result.status, '停止');
  assert.ok(result.stop_report.reasons.some((r) => r.code === '対応できていない組合せ'));
  assert.ok(result.stop_report.reasons.some((r) => r.code === '対応できていない組合せ' && r.stage === 'モデル化'));
  assert.deepEqual(stopStageViolations(result), []);
});

test('SP-FORMALMETHOD-006 AC-03 analysis: 図とモデルを T が独立に突き合わせた余分・欠けが、結果の extra・missing と一致する', async (t) => {
  const { result } = await runScenario(t, { scenario: { stateMachine: SM } });
  const d = result.models[0].diagram;
  if (!d.derivable) { assert.ok(d.reason.length > 0); return; }
  assert.equal(d.format, 'mermaid');
  const edges = new Set();
  for (const line of d.text.split('\n')) {
    const mm = line.match(/^\s*([^\s:-]+)\s*-->\s*([^\s:]+)\s*(?::\s*(.+))?$/);
    if (mm && mm[1] !== '[*]' && mm[2] !== '[*]') edges.add(`${mm[1]}->${mm[2]}`);
  }
  const modelEdges = new Set(SM.transitions.map((tr) => `${tr.from}->${tr.to}`));
  const extra = [...edges].filter((e) => !modelEdges.has(e));
  const missing = [...modelEdges].filter((e) => !edges.has(e));
  assert.equal(d.extra.length > 0, extra.length > 0, `extra: 結果 ${JSON.stringify(d.extra)} 独立 ${JSON.stringify(extra)}`);
  assert.equal(d.missing.length > 0, missing.length > 0, `missing: 結果 ${JSON.stringify(d.missing)} 独立 ${JSON.stringify(missing)}`);
});

test('SP-FORMALMETHOD-008 AC-06 analysis: 依存グラフの各要素と辺の箇所が、返された形式モデルの実在する箇所（JSON Pointer か S 式の番号）を指す', async () => {
  const { result, status } = await canonicalRun();
  const g = result.decomposition.graph;
  assert.ok(g.nodes.length >= 1);
  const ids = new Set(g.nodes.map((n) => n.id));
  for (const e of g.edges) assert.ok(ids.has(e.from) && ids.has(e.to), `辺 ${e.from}→${e.to} の端が要素にある`);
  for (const x of [...g.nodes, ...g.edges]) {
    const file = join(status.run_dir, x.location.file);
    assert.ok(existsSync(file), `${x.location.file} がある`);
    const text = readFileSync(file, 'utf8');
    const m = x.location.pointer.match(/^form:(\d+):(\d+)-(\d+)$/);
    if (m) {
      const forms = topLevelForms(text);
      // form の番号は 0 始まり（artifact-formats「依存グラフの導出の規則」）
      assert.ok(Number(m[1]) >= 0 && Number(m[1]) < forms.length, `${x.location.pointer} は ${forms.length} 個の S 式の中（0 始まり）`);
    } else {
      assert.match(x.location.pointer, /^(\/[^/]*)*$/, 'JSON Pointer');
      assert.notEqual(resolvePointer(JSON.parse(text), x.location.pointer), undefined, `${x.location.file}#${x.location.pointer} が解決する`);
    }
  }
  assert.ok(g.nodes.some((n) => n.kind === 'property'), '性質が要素にある');
});

test('SP-FORMALMETHOD-008 AC-06: 分割しなかった結果は、候補と採否の理由を区別して持ち、部分・契約を持たない（候補だけで独立に検証できると示さない）', async () => {
  const { result } = await canonicalRun();
  const d = result.decomposition;
  assert.ok(d.reason.length > 0);
  if (!d.adopted) {
    assert.deepEqual([d.parts, d.boundaries, d.contracts, d.composition_conditions], [[], [], [], []]);
    assert.deepEqual(d.correspondence, { matched: [], unmatched: [], excluded: [] });
  }
  for (const c of d.candidates) assert.ok(d.decisions.some((x) => x.candidate_id === c.id) || d.candidates.length < 2, `候補 ${c.id} の採否`);
});

test('SP-FORMALMETHOD-005・012 AC-04: 前提が互いに矛盾する（sanity が unsat）対象では、前提の整合の確認が 成り立たない で、性質は検証の成功にならず 停止', async (t) => {
  const { result } = await runScenario(t, { scenario: { properties: [P('P1', 2, { sanity: { result: 'unsat' } })] } });
  const p = prop(result, 'P1');
  assert.ok(!p.verdict.includes('検証済み'), JSON.stringify(p.verdict));
  assert.ok(result.confirmations.deterministic.some((c) => c.kind === 'sanity' && c.property_ids.includes('P1') && c.model_property_id === MP1 && c.result === '成り立たない'));
  assert.equal(result.status, '停止');
  // deterministic の 成り立たない も未解決に数える（artifact-formats「decideStatus」の confirmations_unresolved）
  assert.ok(result.stop_report.reasons.some((x) => x.code === '確認が終わっていない'), JSON.stringify(result.stop_report.reasons));
});

test('SP-FORMALMETHOD-013 AC-12: 取れない値は 0 でなく 取得できず・該当なし で示す（cost は取得できず、ビルドの無い道具の build_ms は該当なし、retries は 0 回）', async () => {
  const { result } = await canonicalRun();
  const run = result.performance.run;
  assert.equal(run.cost.status, '取得できず');
  assert.equal(run.build_ms.status, '該当なし');
  assert.deepEqual(run.retries, { value: 0, unit: 'count' });
  assert.equal(result.performance.location, 'ローカル');
  for (const f of result.performance.findings) assert.equal(f.decision, 'この run では採用しない');
  for (const p of result.properties) for (const cc of p.method?.comparison_conditions ?? []) {
    const all = Object.values(cc.matches).every(Boolean);
    if (!all) assert.equal(cc.result, '一致を確認できず', '条件の一致しない組は優劣を示さない');
  }
});

// ---- AC-02: 抽出の網羅 ----
test('SP-FORMALMETHOD-004 AC-02: unread が空で抽出の確認が成り立てば extraction_coverage.complete は true', async () => {
  const { result } = await canonicalRun();
  assert.deepEqual(result.verified_scope.unread, []);
  assert.equal(result.verified_scope.extraction_coverage.complete, true, result.verified_scope.extraction_coverage.reason);
  assert.ok(result.confirmations.meaning.some((c) => c.kind === 'extraction' && c.result === '成り立つ'));
});

test('SP-FORMALMETHOD-004 AC-02: 抽出の確認が成り立たなければ extraction_coverage.complete は false で、完了にならない', async (t) => {
  const { result } = await runScenario(t, { scenario: { reviews: { extraction: '成り立たない' } } });
  assert.equal(result.verified_scope.extraction_coverage.complete, false);
  assert.ok(result.verified_scope.extraction_coverage.reason.length > 0);
  assert.equal(result.status, '停止');
});
for (const [name, claim, expected, kept] of CLAIM_CASES) {
  test(`SP-FORMALMETHOD-013 AC-12: ${name}`, async (t) => {
    const { result } = await runScenario(t, { scenario: { claim } });
    const m = prop(result, 'P1').method;
    const cc = m.comparison_conditions.find((c) => c.compared.includes('z3') && c.compared.includes('Rust'));
    assert.ok(cc, JSON.stringify(m.comparison_conditions));
    assert.equal(cc.result, expected);
    if (claim === 'mismatch') assert.equal(cc.matches.scope && cc.matches.assurance, false);
    else assert.ok(Object.values(cc.matches).every(Boolean));
    const z3 = m.candidates.find((c) => c.name === 'z3');
    assert.equal(z3.performance_claim !== null, kept);
    assert.deepEqual(resultInvariants(result), []);
  });
}

test('SP-FORMALMETHOD-008 AC-06 analysis: 返されたモデルから依存グラフを導出の規則で導き直すと返された graph と一致し、writer-merge-scc/1 を当て直すと candidates と一致する（正準のシナリオ）', async () => {
  const { result, status } = await canonicalRun();
  assertGraphMatches(status, result);
  const d = result.decomposition;
  assert.deepEqual(d.criteria, { algorithm: 'writer-merge-scc/1' });
  assert.deepEqual(d.candidates, writerMergeScc(d.graph));
});

// 候補 id の他の候補への辺（artifact-formats の境界の定め）: 両端の節点が違う候補に属する graph.edges の辺ごとに 1 つ。辺は from が to に依る向きで、
// producer は to の節点の候補、consumer は from の節点の候補、shared_symbols は to の節点の / の後の名前、to_candidate は id から見た他方の候補
function candidateEdges(graph, candidates, id) {
  const ownerOf = (n) => candidates.find((c) => c.nodes.includes(n))?.id;
  const out = [];
  for (const e of graph.edges) {
    const consumer = ownerOf(e.from);
    const producer = ownerOf(e.to);
    if (!consumer || !producer || consumer === producer || (id !== consumer && id !== producer)) continue;
    out.push({ edge_id: e.id, to_candidate: id === consumer ? producer : consumer, producer_candidate: producer, consumer_candidate: consumer, shared_symbols: [e.to.slice(e.to.indexOf('/') + 1)] });
  }
  return out;
}

test('SP-FORMALMETHOD-008・009 AC-06・AC-07: 書き手の違う 2 つの組を持つモデルで、候補を導き直すと一致し、分割作成役は同じ候補を受け取る', async (t) => {
  const { result, harness, status } = await runScenario(t, { scenario: { stateMachine: SM2, properties: SM2_PROPS } });
  assertGraphMatches(status, result);
  const d = result.decomposition;
  const mine = writerMergeScc(d.graph);
  assert.deepEqual(d.candidates, mine);
  assert.ok(mine.length >= 2, `候補が 2 つ以上: ${JSON.stringify(mine)}`);
  const pt = harness.memory.tasks.find((x) => x.role === 'partition-author');
  assert.ok(pt, '候補が 2 つ以上なら分割作成役が出る');
  // 候補は他の候補への辺を持つ（artifact-formats「分割作成役の task の context.candidates[]」）。期待は依存グラフから独立に導く
  assert.deepEqual(pt.context.candidates, mine.map(({ id, nodes }) => ({ id, nodes, edges: candidateEdges(d.graph, mine, id) })));
  assert.deepEqual(d.decisions.map((x) => x.candidate_id).sort(), mine.map((c) => c.id).sort());
  if (!d.adopted) for (const p of result.properties) assert.ok(!p.verdict.includes('検証済み') || d.parts.length === 0, '候補だけで独立に検証できると示さない');
});

test('SP-FORMALMETHOD-009 AC-07 analysis: 部分の前提を確認できない分割では全体の性質が検証済みにならず、跨ぐ辺ごとに境界があり、分割前の要素は規則の id で対応・対応なし・除外のちょうど 1 つに入る', async (t) => {
  const { result, status } = await runScenario(t, { scenario: { stateMachine: SM2, properties: SM2_PROPS, partition: partitionWithUnconfirmedAssumption } });
  const d = result.decomposition;
  const mine = assertGraphMatches(status, result);
  assert.equal(d.adopted, true, d.reason);
  // 跨ぐ辺: T が導いたグラフで、部分の持つ変数・遷移（var:・tr:）の間を跨ぐ辺。境界は跨ぐ辺ごとに 1 つ
  const cross = crossingEdges(mine, d.parts).map((e) => e.id).sort();
  for (const p of d.parts) assert.equal(p.model_id, M1);
  for (const k of d.contracts) assert.equal(k.model_id, M1);
  for (const c of result.checks.filter((x) => x.kind === 'composition')) assert.equal(c.model_id, M1, '合成の条件の検査の model_id は合成の条件の model_id');
  assert.ok(cross.includes(`read:tr:${M1}/tb->var:${M1}/a`), cross.join());
  assert.deepEqual(d.boundaries.map((b) => b.edge_id).sort(), cross);
  for (const b of d.boundaries) assert.ok(b.responsible.length >= 1, '境界ごとに責任を負う契約か検査');
  assert.ok(d.boundaries.some((b) => b.assumption_basis.kind === '確認できない前提'));
  assert.ok(d.composition_conditions.length >= 1);
  for (const p of result.properties) assert.ok(!p.verdict.includes('検証済み'), `${p.id} は確認できない前提の分割で検証済みにならない`);
  assert.equal(result.status, '停止');
  // T の独立の照合: 変数・遷移の要素（規則の id）は、対応・対応なし・除外のちょうど 1 つに入る
  const elems = mine.nodes.filter((n) => n.kind === 'variable' || n.kind === 'transition').map((n) => n.id);
  assert.deepEqual(elems, [`tr:${M1}/ta`, `tr:${M1}/tb`, `var:${M1}/a`, `var:${M1}/b`]);
  const buckets = [d.correspondence.matched.map((m) => m.element), d.correspondence.unmatched, d.correspondence.excluded.map((e) => e.element)];
  for (const e of elems) assert.equal(buckets.filter((b) => b.includes(e)).length, 1, `${e} の対応`);
  // 部分が持つ要素は 対応なし にならず、対応の先に自分の部分を持つ
  // 部分の id は候補の id（partition-assemble。SP-264-023）。a の組と b の組の候補を引く
  const candOf = (el) => d.candidates.find((c) => c.nodes.includes(el)).id;
  const ownerOf = Object.fromEntries([`var:${M1}/a`, `tr:${M1}/ta`, `var:${M1}/b`, `tr:${M1}/tb`].map((el) => [el, candOf(el)]));
  for (const [el, part] of Object.entries(ownerOf)) {
    assert.equal(d.correspondence.unmatched.includes(el), false, `${el} は 対応なし でない`);
    const m = d.correspondence.matched.find((x) => x.element === el);
    if (m) assert.ok(m.to.includes(part), `${el} の対応の先に ${part}`);
  }
});

test('SP-FORMALMETHOD-009 AC-07: 部分の成功だけで全体を検証済みにしない（合成の条件と契約がそろっても、確認できない前提が残れば親は検証済みでない）', async (t) => {
  const { result } = await runScenario(t, { scenario: { stateMachine: SM2, properties: SM2_PROPS, partition: partitionWithUnconfirmedAssumption } });
  const contracts = result.decomposition.contracts;
  assert.ok(contracts.length >= 1);
  const parent = prop(result, 'P1');
  assert.ok(!parent.verdict.includes('検証済み'));
});

// ---- AC-10: 時間の上限が小さい依頼 ----
test('SP-FORMALMETHOD-010・015 AC-10: 時間の上限 1 秒の依頼は受け付け、期限の過ぎた担当・道具を出さず、時間の上限 で停止する', async (t) => {
  const started = Date.now();
  const out = await runScenario(t, {
    request: canonicalRequest({ time_limit_seconds: 1 }),
    scenario: { properties: [P('P1', 2, { query: { result: 'unsat', sleepMs: 1500 } })] },
  });
  const r = out.result;
  assert.equal(r.status, '停止');
  assert.ok(!r.stop_report.reasons.some((x) => x.request_code === 'time_limit_invalid'));
  assert.ok(r.stop_report.reasons.some((x) => x.code === '時間の上限'), JSON.stringify(r.stop_report.reasons));
  assert.deepEqual(stopStageViolations(r), []);
  for (const c of r.checks) assert.ok(c.verdict === '未実行' || c.verdict === '時間切れ', `${c.id}: ${c.verdict}`);
  // 残す時間は min(60 秒, 上限の 1/4) = 0.25 秒。期限（開始から 0.75 秒）の後に道具を始めない
  for (const e of out.log().filter((x) => x.kind === 'query-start')) assert.ok(e.at_ms <= started + 750 + 2000, '期限の後に道具を始めない');
  for (const b of out.harness.memory.calls) assert.ok(b.deadline_wall_ms <= started + 750 + 3000, '担当の呼び出しの期限は run の期限 − 残す時間（起動の遅れを 3 秒まで見込む）');
});

// ---- 性質の id の名前空間と、モデルが 2 つのとき ----
test('artifact-formats 性質の id の名前空間 AC-04・AC-09: モデルの性質の id を inventory の id と違えても、結果の性質は inventory の id で、確認は両方の id を持ち、完了する', async (t) => {
  const { result, status } = await runScenario(t, { scenario: { modelPropPrefix: 'MP-' } });
  assert.deepEqual(resultInvariants(result), []);
  assert.deepEqual(result.properties.map((p) => p.id), ['P1'], 'PropertyResult.id は inventory の性質の id');
  assert.deepEqual(prop(result, 'P1').verdict, ['検証済み']);
  assert.equal(result.status, '完了', JSON.stringify(result.stop_report));
  const sanity = result.confirmations.deterministic.filter((c) => c.kind === 'sanity');
  assert.ok(sanity.length >= 1);
  // モデルの性質の id は <model_id>. で始まる（SP-264-012）。harness はその後ろに接頭辞 MP- と inventory の id を置く
  const mp = `${M1}.MP-P1`;
  for (const c of sanity) { assert.deepEqual(c.property_ids, ['P1']); assert.equal(c.model_property_id, mp); assert.equal(c.plan_id, `sanity-${mp}-1`, '計画の sanity の id は plan_id に残る'); assert.match(c.id, /^confirm-sanity-\d+$/); }
  for (const c of result.confirmations.deterministic.filter((x) => x.kind === 'mutation')) { assert.equal(c.model_property_id, mp); assert.equal(c.plan_id, `MU-${mp}`); }
  for (const m of prop(result, 'P1').detection.mutations) { assert.equal(m.id, `MU-${mp}`); assert.match(m.confirmation_id, /^confirm-mutation-\d+$/); }
  for (const c of result.confirmations.deterministic.filter((x) => ['goal_trivial', 'plan_coverage'].includes(x.kind))) assert.equal(c.model_property_id, mp);
  assert.ok(result.decomposition.graph.nodes.some((n) => n.id === `prop:${M1}/${mp}`), 'graph の性質はモデルの性質の id');
  assert.ok(!result.decomposition.graph.nodes.some((n) => n.id === `prop:${M1}/P1`));
  assert.equal(prop(result, 'P1').detection.status, '検出を確認');
  assertGraphMatches(status, result);
});

test('artifact-formats 性質の id の名前空間 AC-14: 変異を用意できない性質の unavailable は inventory の id で、その性質は 検出能力未確認', async (t) => {
  const { result } = await runScenario(t, { scenario: { modelPropPrefix: 'MP-', properties: [P('P1', 2, { mutation: null })] } });
  assert.equal(prop(result, 'P1').detection.status, '検出能力未確認');
  assert.equal(result.status, '停止');
});

test('SP-FORMALMETHOD-005・008 AC-06: モデルが 2 つのとき、graph は両方の要素を model_id で分けて持ち、導き直しと一致し、property の辺は同じモデルの変数にだけ引く', async (t) => {
  const scenario = {
    modelPropPrefix: 'MP-',
    properties: [P('P1', 2, { smt: SMT_A }), P('P2', 3, { smt: SMT_A })],
    models: [{ id: 'M1', propertyIds: ['P1'], stateMachine: SM_A }, { id: 'M2', propertyIds: ['P2'], stateMachine: { ...SM_A, transitions: SM_A.transitions.map((x) => ({ ...x, source_ids: ['E-P2'] })) } }],
  };
  const { result, status } = await runScenario(t, { scenario });
  assert.deepEqual(resultInvariants(result), []);
  assert.deepEqual(result.models.map((m) => m.id).sort(), [M1, M2].sort(), 'model_id は partition-models が出所の成分から決める');
  const mine = assertGraphMatches(status, result);
  const ids = mine.nodes.map((n) => n.id);
  for (const id of [`var:${M1}/a`, `var:${M2}/a`, `tr:${M1}/t`, `tr:${M2}/t`, `prop:${M1}/${M1}.MP-P1`, `prop:${M2}/${M2}.MP-P2`]) assert.ok(ids.includes(id), id);
  for (const e of result.decomposition.graph.edges.filter((x) => x.kind === 'property')) {
    assert.equal(e.from.split('/')[0].replace(/^prop:/, ''), e.to.split('/')[0].replace(/^var:/, ''), `${e.id} は同じモデルの変数への辺`);
  }
  for (const m of result.models) {
    const fileOfModel = result.decomposition.graph.nodes.filter((n) => n.id.startsWith(`var:${m.id}/`) || n.id.startsWith(`tr:${m.id}/`) || n.id.startsWith(`prop:${m.id}/`)).map((n) => n.location.file);
    assert.ok(fileOfModel.every((f) => f === m.ref), `${m.id} の状態遷移と性質の要素の location.file は models[].ref`);
  }
  assert.deepEqual(result.decomposition.candidates, writerMergeScc(result.decomposition.graph));
  for (const p of ['P1', 'P2']) assert.deepEqual(prop(result, p).verdict, ['検証済み'], p);
  for (const c of result.checks) assert.ok([M1, M2].includes(c.model_id));
});

test('cli-contract 証人 AC-09: replay の input.smt2 は反例の検査の query の (check-sat) の直前に、固定する記号ごとの literal の assert をモデルの要素の順に 1 行ずつ持ち、他のバイト列は変えない', async (t) => {
  // 偽の z3 の real のモデル: 宣言の逆順に f（引数あり）・arr=((as const …) 0)・y=2・w=#b000・v=#x00・b=true・r=(- (/ 3.0 2.0))・x=2、最後に k!0=5（宣言の無い補助の記号）
  const smt = '(declare-const x Int)\n(declare-const r Real)\n(declare-const b Bool)\n(declare-const v (_ BitVec 8))\n(declare-const w (_ BitVec 3))\n(declare-fun y () Int)\n(declare-const arr (Array Int Int))\n(declare-fun f (Int) Int)\n(assert (> x (f 1)))';
  const scenario = { properties: [P('P1', 2, { query: { result: 'sat' }, smt })] };
  const { result, status, harness } = await runScenario(t, { scenario });
  assert.deepEqual(resultInvariants(result), []);
  assertRecordsConsistent(status, result, harness);
  const { x, original, stepsText } = counterexampleQueries(status, result, harness, 'P1');
  const at = original.lastIndexOf('(check-sat)');
  assert.ok(stepsText.startsWith(original.slice(0, at)) && stepsText.endsWith(original.slice(at)), 'replay の query は (check-sat) の直前に挿入しただけ');
  const inserted = stepsText.slice(at, stepsText.length - (original.length - at));
  // literal の項の値だけを、モデルの要素の順に固定する。(as const …)・引数のある定義・宣言の無い k!0 は固定しない。
  // <項> はモデルの文字列から写し、空白の並び（改行を含む）を空白 1 つにまとめるので、assert は 1 行（cli-contract「証人」replay の query）
  // assert はモデルの要素の順（宣言の順ではない）
  const expected = ['(assert (= y 2))', '(assert (= w #b000))', '(assert (= v #x00))', '(assert (= b true))', '(assert (= r (- (/ 3.0 2.0))))', '(assert (= x 2))'];
  assert.equal(inserted, expected.map((l) => `${l}\n`).join(''), `挿入した行: ${JSON.stringify(inserted)}`);
  assert.equal(stepsText, inputOf(status.run_dir, x.replay.confirmation_id), 'steps_ref は checks/<replay の Confirmation.id>/input.smt2');
  const replay = result.confirmations.deterministic.find((c) => c.id === x.replay.confirmation_id);
  assert.equal(replay.kind, 'replay');
  assert.equal(replay.result, '成り立つ', '偽の z3 は replay の query にも sat を返す（再現）');
  // reason に挙げるのは宣言された記号のうち固定しなかったもの（arr: 項が literal でない、f: 引数がある）を宣言の順（モデルの順は f・arr）で、補助の記号 k!0 は挙げない
  assertNamedInOrder(replay.reason, ['arr', 'f'], ['k!0', 'x', 'y']);
});
test('cli-contract 証人: 注釈を除き（literal の中の ; は残す）、literal（false・(- 数字)・小数・(/ 小数 小数)・文字列・複数行の項）だけを空白をまとめて固定し、root-obj・lambda・as-array・引数のある関数・モデルに無い記号は固定せず宣言の順に reason に挙げる', async (t) => {
  const scenario = { properties: [P('P1', 2, { query: { result: 'sat', 'model-text': JSON.stringify(WITNESS_MODEL) }, smt: WITNESS_SMT })] };
  const { result, status, harness } = await runScenario(t, { scenario });
  assert.deepEqual(resultInvariants(result), []);
  const { x, original, stepsText } = counterexampleQueries(status, result, harness, 'P1');
  const at = original.lastIndexOf('(check-sat)');
  const expected = ['(assert (= g (- 7)))', '(assert (= u "x;y"))', '(assert (= t "ab"))', '(assert (= e (/ 1.0 3.0)))', '(assert (= d 1.5))', '(assert (= n (- 3)))', '(assert (= q false))', '(assert (= p 4))'];
  assert.equal(stepsText, original.slice(0, at) + expected.map((l) => `${l}\n`).join('') + original.slice(at));
  const replay = result.confirmations.deterministic.find((c) => c.id === x.replay.confirmation_id);
  assert.equal(replay.result, '成り立つ', replay.reason);
  // 宣言の順: m（モデルに無い）・h（root-obj）・lm（lambda）・aa（as-array）・ff（引数がある）。k!0 は宣言されていないので挙げない
  assertNamedInOrder(replay.reason, ['m', 'h', 'lm', 'aa', 'ff'], ['k!0']);
});
test('cli-contract 証人・秘密値の走査: モデルに秘密値の型があれば stdout.txt を保存せず、証人を読めないので replay は始まらず 確認できず。反例の検査は 反例 のまま、停止の理由に 保存の失敗、値は出力に残らない', async (t) => {
  const smt = '(declare-const x Int)\n(declare-const tok String)\n(assert (> x 1))';
  const out = await runScenario(t, { scenario: { properties: [P('P1', 2, { query: { result: 'sat', model: 'secret' }, smt })] } });
  const { result, status } = out;
  assert.deepEqual(resultInvariants(result), []);
  const [c] = checksOf(result, prop(result, 'P1'));
  assert.equal(c.verdict, '反例');
  assert.equal(c.end.tool_result, '反する');
  const x = result.counterexamples.find((y) => y.check_id === c.id);
  assert.ok(x, '反例');
  const replay = result.confirmations.deterministic.find((y) => y.id === x.replay.confirmation_id);
  assert.equal(replay.result, '確認できず');
  assert.deepEqual(replay.end, NOT_STARTED_END);
  assert.equal(result.status, '停止');
  assert.ok(result.stop_report.reasons.some((r) => r.code === '保存の失敗'), JSON.stringify(result.stop_report.reasons));
  assert.ok(result.records.unsaved.length >= 1, '保存できなかった記録');
  assertSecretNowhere(out, status.run_dir);
});

test('cli-contract 秘密値の走査: 担当が書いた .smt2 の注釈に秘密値の型があれば、その記録と、それを含む input.smt2 を書かず、停止の理由は 保存の失敗 で、値は出力に残らない', async (t) => {
  const out = await runScenario(t, { scenario: { editModelQuery: (text, { kind }) => (kind === 'property' ? `; token ${SECRET}\n${text}` : text) } });
  const { result, status } = out;
  assert.equal(result.status, '停止');
  assert.ok(result.stop_report.reasons.some((r) => r.code === '保存の失敗'), JSON.stringify(result.stop_report.reasons));
  assert.ok(result.records.unsaved.length >= 1, '保存できなかった記録');
  assertSecretNowhere(out, status.run_dir);
});
for (const [name, query] of WITNESS_CASES) {
  test(`cli-contract 証人 AC-09: ${name}では、反例の検査は 反例 のまま、replay を始めず 確認できず で、steps_ref は反例の検査の query を指す`, async (t) => {
    const { result, status, harness } = await runScenario(t, { scenario: { properties: [P('P1', 2, { query })] } });
    assert.deepEqual(resultInvariants(result), []);
    const [c] = checksOf(result, prop(result, 'P1'));
    assert.equal(c.verdict, '反例');
    assert.deepEqual({ tool_result: c.end.tool_result, abnormal_exit: c.end.abnormal_exit, unreadable_output: c.end.unreadable_output, stopped_by: c.end.stopped_by },
      { tool_result: '反する', abnormal_exit: false, unreadable_output: false, stopped_by: null }, 'モデルは答えの読みに使わない');
    assert.deepEqual(prop(result, 'P1').verdict, ['反例']);
    const { x, original, stepsText } = counterexampleQueries(status, result, harness, 'P1');
    assert.equal(stepsText, original, 'steps_ref は反例の検査の input.smt2');
    const replay = result.confirmations.deterministic.find((y) => y.id === x.replay.confirmation_id);
    assert.equal(replay.result, '確認できず');
    assert.deepEqual(replay.end, NOT_STARTED_END);
    assert.ok(replay.reason.length > 0, '読めなかった理由');
    const TRUNCATED = '標準出力を TOOL_OUTPUT_MAX_BYTES で切り詰めた';
    if (query.model === 'huge') {
      assert.equal(statSync(evidence(status.run_dir, c.id, 'stdout.txt')).size, TOOL_OUTPUT_MAX_BYTES, 'stdout.txt は上限までのバイト列');
      for (const reason of [c.reason, replay.reason]) assert.ok(reason.includes(TRUNCATED), `固定の語: ${reason}`);
    } else {
      assert.ok(!c.reason.includes(TRUNCATED), '切り詰めていない実行に固定の語を書かない');
    }
  });
}

test('cli-contract Z3 の adapter: -model は property・composition の実行にだけ渡し、-T は検査・sanity は計画の値、mutation は検出役の検査の値、replay は反例の検査の値', async (t) => {
  const scenario = {
    stateMachine: SM2, toolTimeLimit: 30,
    properties: [{ ...SM2_PROPS[0], query: { result: 'sat' }, toolTimeLimit: 17 }],
    partition: partitionFixture({ basis: 'guarantee', conds: ['CC1', 'CC2'] }),
    editPlan: (plan) => ({ ...plan, checks: plan.checks.map((c) => ({ ...c, tool_time_limit_seconds: { [C_K_A]: 11, [C_CC1]: 13, [C_CC2]: 14 }[c.id] ?? c.tool_time_limit_seconds })) }),
  };
  const { result, status, harness, log } = await runScenario(t, { scenario });
  assert.deepEqual(resultInvariants(result), []);
  const calls = log();
  const { plan, mutations } = planOf(harness);
  const dir = status.run_dir;
  const expectRun = (what, text, model, seconds) => {
    const cs = callsFor(calls, text);
    assert.ok(cs.length >= 1, `${what} の query（input_refs をつないだもの）で道具を呼ぶ`);
    for (const c of cs) {
      assert.equal(c.args.includes('-model'), model, `${what} の -model: ${JSON.stringify(c.args)}`);
      assert.equal(tOf(c), seconds, `${what} の -T`);
    }
  };
  // 実行ごとに checks/<execution_id>/input.smt2 を読み、input_refs をつないだものと一致し、それを受け取った呼出しの引数を見る
  const confs = result.confirmations.deterministic;
  const execIds = new Set(result.performance.executions.map((e) => e.id));
  const expectExec = (what, id, expectedQuery, model, seconds) => {
    const text = inputOf(dir, id);
    if (expectedQuery !== null) assert.equal(text, expectedQuery, `${what} の input.smt2 は input_refs をつないだもの`);
    assert.ok(execIds.has(id), `${what} の id ${id} は performance.executions[].id`);
    expectRun(what, text, model, seconds);
  };
  for (const c of plan.checks) expectExec(`${c.kind} ${c.id}`, c.id, queryOf(dir, c.input_refs), c.kind === 'property' || c.kind === 'composition', c.tool_time_limit_seconds);
  for (const s of plan.sanity) {
    const conf = confs.find((x) => x.kind === 'sanity' && x.plan_id === s.id);
    expectExec(`sanity ${s.id}`, conf.id, queryOf(dir, s.input_refs), false, s.tool_time_limit_seconds);
  }
  for (const m of mutations.mutations) {
    const det = plan.checks.find((c) => c.id === m.detector_check_id);
    // input_refs は担当の query ちょうど 1 つで、変異はそれを mutation_ref に置き換える（cli-contract.md:337-338）。
    // 変異の input.smt2 は mutation_ref の内容（検出役の検査の query ではない）
    assert.equal(det.input_refs.length, 1);
    const conf = confs.find((x) => x.kind === 'mutation' && x.plan_id === m.id);
    expectExec(`mutation ${m.id}`, conf.id, queryOf(dir, [m.mutation_ref]), false, det.tool_time_limit_seconds);
    assert.notEqual(inputOf(dir, conf.id), inputOf(dir, det.id), '変異の query は検出役の検査の query と違う');
  }
  const x = result.counterexamples.find((c) => c.property_id === 'P1');
  assert.ok(x, 'P1 の反例');
  expectExec('replay', x.replay.confirmation_id, null, false, plan.checks.find((c) => c.id === x.check_id).tool_time_limit_seconds);
});

test('artifact-formats 検査・分割と合成 AC-07・AC-09: 契約の検査は checks[] に kind contract で現れ properties[].check_ids に入らず、契約に依らない合成の条件の検査も親の check_ids に入り、全てそろえば親は 検証済み', async (t) => {
  const { result, status, harness } = await runScenario(t, { scenario: PART_SCENARIO() });
  assert.deepEqual(resultInvariants(result), []);
  assertRecordsConsistent(status, result, harness);
  const d = result.decomposition;
  assert.equal(d.adopted, true, d.reason);
  const kc = result.checks.find((c) => c.id === C_K_A);
  assert.equal(kc?.kind, 'contract', '契約の検査は checks[] に kind contract');
  assert.deepEqual(d.contracts.find((k) => k.id === 'K-a').check_ids, [C_K_A]);
  assert.deepEqual(d.contracts.find((k) => k.id === 'K-a').verdict, ['検証済み']);
  for (const p of result.properties) assert.ok(!p.check_ids.includes(C_K_A), `${p.id}.check_ids に契約の検査が入らない`);
  for (const m of result.models) for (const row of m.mapping) assert.ok(!row.check_ids.includes(C_K_A), 'mapping の check_ids に契約の検査が入らない');
  assert.deepEqual([...prop(result, 'P1').check_ids].sort(), [C_CC1, C_CC2, C_P1].sort(), '性質の検査と、derived_from が P1 の合成の条件の検査（契約に依らない CC2 を含む）');
  for (const cc of d.composition_conditions) assert.equal(cc.derived_from, MP1);
  assert.ok(result.performance.executions.some((e) => e.id === C_K_A && e.kind === 'contract'), 'performance.executions に kind contract');
  assert.deepEqual(prop(result, 'P1').verdict, ['検証済み'], '全ての契約が 検証済み で、derived_from の合成の条件が全て成功');
});
// 分割と合成の PART_CASES と、計画の照合の PLAN_DEFECTS は、計画の段の下書きの形（#264 U4）に依るので cli-pipeline-plan-defects.test.mjs で流す

test('artifact-formats 分割と合成: 合成の条件の derived_from が別のモデルの性質を指す分割は分割の欠陥で、分割作成役に修正の巡が出て、直した分割が結果に入る', async (t) => {
  const scenario = {
    modelPropPrefix: 'MP-',
    properties: [{ ...SM2_PROPS[0] }, P('P2', 3, { smt: SMT_A })],
    models: [{ id: 'M1', propertyIds: ['P1'], stateMachine: SM2 }, { id: 'M2', propertyIds: ['P2'], stateMachine: { ...SM_A, transitions: SM_A.transitions.map((x) => ({ ...x, source_ids: ['E-P2'] })) } }],
    partition: partitionFixture({ basis: 'guarantee', conds: ['CC1'], derivedFrom: (round) => (round === 1 ? `${M2}.MP-P2` : 'MP-P1') }),
  };
  const { result, harness } = await runScenario(t, { scenario });
  assert.deepEqual(resultInvariants(result), []);
  assertRevised(harness, 'partition-author', '計画');
  for (const x of [...result.decomposition.contracts, ...result.decomposition.composition_conditions]) assert.equal(x.derived_from, `${M1}.MP-P1`, `${x.id} は同じモデル（P1 の成分）の性質を指す`);
});

test('artifact-formats plan と mutations 検査の欠け: モデルの性質の検査が無い計画は計画の欠陥で修正の巡が出て、直れば通常の結果になる', async (t) => {
  const { result, harness } = await runScenario(t, { scenario: { editPlan: (plan, { round }) => (round === 1 ? dropChecks(C_P1)(plan) : plan) } });
  assert.deepEqual(resultInvariants(result), []);
  assertRevised(harness, 'plan-author', '計画');
  assert.deepEqual(prop(result, 'P1').verdict, ['検証済み']);
  assert.equal(result.status, '完了', JSON.stringify(result.stop_report));
});

test('artifact-formats 形式モデルと対応 検査の欠け: 修正の巡の後も検査が欠ければ止めずに進み、形式化 の行は check_ids が空で reason を持ち、性質は 未確認', async (t) => {
  const { result, harness } = await runScenario(t, { scenario: { editPlan: dropChecks(C_P1) } });
  assert.deepEqual(resultInvariants(result), []);
  assertRevised(harness, 'plan-author', '計画');
  assertNoChecksRow(result, 'P1');
  assert.deepEqual(prop(result, 'P1').verdict, ['未確認']);
  assert.ok(tasksOf(harness, 'fidelity-reviewer').length >= 1, '止めずに確認の段へ進む');
  assert.equal(result.status, '停止');
});
for (const [name, tool, mode, verdict] of NO_PLAN_CASES) {
  test(`artifact-formats 検査の欠け SP-FORMALMETHOD-007・011: ${name}と、計画が無いので全ての検査が欠け、形式化 の行は check_ids が空で reason を持ち、性質は ${verdict.join()}`, async (t) => {
    const { result } = await runScenario(t, { scenario: { returns: { 'plan-author': mode } }, tool });
    assert.deepEqual(resultInvariants(result), []);
    assert.deepEqual(result.checks, []);
    assertNoChecksRow(result, 'P1');
    assert.deepEqual(prop(result, 'P1').verdict, verdict);
    assert.equal(prop(result, 'P1').method, null, '計画が無い性質の method は null');
    assert.equal(result.status, '停止');
  });
}

// ======== #264 SP-264-012: モデルの決定的な分割と、モデルごとの task（U3） ========
const ledgerOf = (status) => JSON.parse(readFileSync(join(status.run_dir, 'ledger.json'), 'utf8'));
const revisionKeys = (status) => ledgerOf(status).revisions.flatMap((r) => r.defects.map((d) => d.key));
const TWO = { properties: [P('P1', 2), P('P2', 3)] };

test('SP-264-012: 出所を共有しない 2 組の性質では、モデル化の段は partition-models の id ごとに model-author の task を 1 つずつ出し、1 体の worker に順に claim させる', async (t) => {
  const { result, harness } = await runScenario(t, { scenario: TWO });
  assert.deepEqual(resultInvariants(result), []);
  const ts = tasksOf(harness, 'model-author');
  assert.deepEqual(ts.map((x) => x.context.model_id).sort(), [M1, M2].sort(), 'context.model_id は partition-models の id');
  for (const x of ts) {
    assert.deepEqual(x.context.property_ids, [x.context.model_id === M1 ? 'P1' : 'P2'], 'context.property_ids はそのモデルの性質');
    assert.equal(x.context.model_property_id_prefix, `${x.context.model_id}.`);
  }
  const calls = result.performance.agent_calls.calls.filter((c) => c.stage === 'モデル化');
  assert.equal(calls.length, 1, 'モデル化の段の呼び出しは 1 つ');
  assert.equal(calls[0].workers, 1, '起動は 1 体（task はモデルの数）');
  assert.equal(calls[0].tasks, 2);
  const hc = harness.memory.calls.filter((c) => c.stage === 'モデル化');
  assert.deepEqual(hc.map((c) => c.workers.length), [1]);
  // 1 体が前の task を閉じてから次の task を受け取る（after の鎖。最初の claim は 1 つ、次は submit の next）
  assert.deepEqual(hc[0].claims.filter((c) => c.task_ids).map((c) => c.task_ids.length), [1, 1]);
  for (const p of ['P1', 'P2']) assert.deepEqual(prop(result, p).verdict, ['検証済み'], p);
  assert.equal(result.status, '完了', JSON.stringify(result.stop_report));
});

test('SP-264-012: モデルの性質の id は <model_id>. で始まるので、2 つのモデルで prop- の検査の id が重ならない', async (t) => {
  const { result } = await runScenario(t, { scenario: TWO });
  const ids = result.checks.map((c) => c.id);
  assert.ok(ids.includes(C_P1) && ids.includes(C_P2), ids.join());
  assert.equal(new Set(ids).size, ids.length, '検査の id は run で一意');
  for (const m of result.models) for (const p of m.properties ?? []) assert.ok(p.id.startsWith(`${m.id}.`), p.id);
});

test('SP-264-012: 接頭辞 <model_id>. の無いモデルの性質の id を返したモデル作成役は mp-prefix の欠陥で修正の巡に戻り、直せば通常の結果になる', async (t) => {
  const editModel = (m, { round }) => (round === 1 ? { ...m, properties: m.properties.map((p) => ({ ...p, id: p.id.slice(p.id.indexOf('.') + 1) })) } : m);
  const { result, harness, status } = await runScenario(t, { scenario: { editModel } });
  assert.deepEqual(resultInvariants(result), []);
  assertRevised(harness, 'model-author', 'モデル化');
  assert.ok(revisionKeys(status).some((k) => k === 'mp-prefix:P1' || k.startsWith('mp-prefix:')), revisionKeys(status).join());
  assert.deepEqual(prop(result, 'P1').verdict, ['検証済み']);
  assert.equal(result.status, '完了', JSON.stringify(result.stop_report));
});

test('SP-264-012: context.model_id と違う model_id のモデルは reference の欠陥で修正の巡に戻る', async (t) => {
  const editModel = (m, { round }) => (round === 1 ? { ...m, model_id: 'm-other' } : m);
  const { result, harness } = await runScenario(t, { scenario: { editModel } });
  assert.deepEqual(resultInvariants(result), []);
  assertRevised(harness, 'model-author', 'モデル化');
  assert.deepEqual(result.models.map((m) => m.id), [M1]);
  assert.equal(result.status, '完了', JSON.stringify(result.stop_report));
});

test('DD-14: 2 つのモデルの query がどちらも .smt2 の規則に反したまま受理されると、両方の違反が計画の欠陥の要素に届く（先のモデルの違反が消えない）', async (t) => {
  const { result, harness } = await runScenario(t, { scenario: { ...TWO, editModelQuery: appendAfterCheckSat(() => true) } });
  assert.deepEqual(resultInvariants(result), []);
  assert.equal(tasksOf(harness, 'model-author').length, 2);
  assertExcluded(result, [C_P1, C_P2]);
  for (const p of ['P1', 'P2']) assert.deepEqual(prop(result, p).verdict, ['未確認'], p);
});

test('SP-264-004・012: モデル化の段で実行体が誤りで終わると（CoreError）、担当の修正の巡に回さず 内部の誤り で中断する', async (t) => {
  const dir = makeWorkspace('fm-core-wrap-');
  t.after(() => removeTree(dir));
  const bin = wrapCore(dir, { fail: 'partition-models' });
  const { result, harness } = await runScenario(t, { env: { FORMAL_METHOD_CORE_BIN: bin } });
  assert.deepEqual(resultInvariants(result), []);
  assert.equal(result.status, '停止');
  assert.ok(result.stop_report.reasons.some((r) => r.code === '内部の誤り'), JSON.stringify(result.stop_report.reasons));
  assert.equal(tasksOf(harness, 'model-author').length, 0, 'モデル作成役を出さない');
});

// ======== #264 SP-264-025: 対応表の行の骨組み（U3） ========
test('SP-264-025・DD-16: 対応表の骨組みは views/mapping-rows-<model_id>.json で model-author の資料に入り、組み立てた対応表は assembled/<task_id>/mapping.json に 1 つだけ書かれて台帳に載る', async () => {
  const { result, harness, status } = await canonicalRun();
  const [task] = tasksOf(harness, 'model-author');
  const ref = `views/mapping-rows-${M1}.json`;
  assert.ok(task.context.input_refs.some((x) => x.ref === ref), `${ref} が資料に無い`);
  const view = JSON.parse(readFileSync(join(status.run_dir, ref), 'utf8'));
  assert.deepEqual(view.rows.map((r) => [r.row_id, r.property_id, r.source]), [['P1/E-P1', 'P1', { kind: 'location', target_id: 'T1', file: 'spec.md', span: 'L2-L2' }]], '性質ごと・source_ids の要素ごとの location の行');
  const asm = `assembled/${task.task_id}/mapping.json`;
  assert.ok(existsSync(join(status.run_dir, asm)), `${asm} が無い`);
  const m = JSON.parse(readFileSync(join(status.run_dir, asm), 'utf8'));
  assert.equal(m.schema, 'formal-method.mapping/1');
  assert.equal(m.model_id, M1, 'model_id は context.model_id から埋める');
  const loc = m.rows.filter((r) => r.source.kind === 'location');
  assert.deepEqual(loc.map((r) => [r.property_id, r.model_element, r.relation]), [['P1', MP1, '形式化']]);
  assert.ok(m.rows.some((r) => r.source.kind === 'goal' && r.source.id === 'G1'), 'extra_rows の目標の行を後ろにつなぐ');
  assert.ok(ledgerOf(status).entries.some((e) => e.kind === 'mapping' && e.ref === asm && e.producer === task.task_id), '台帳に組み立てた対応表を、その task を producer として載せる');
  assert.equal(result.models[0].mapping.length, m.rows.length);
});

test('SP-264-025: 形式化できない性質の location の行の relation と reason は骨組みが決める（形式検証でない確認・nonformal_reason）', async (t) => {
  const { result, status, harness } = await runScenario(t, { scenario: { properties: [P('P1', 2), P('P2', 3, { formalizable: false })] } });
  assert.deepEqual(resultInvariants(result), []);
  // 形式化できない性質だけの成分は、model_id が最も小さい形式のモデルに入る（SP-264-010 の規則 4）
  const ts = tasksOf(harness, 'model-author');
  assert.equal(ts.length, 1);
  assert.deepEqual(ts[0].context.property_ids, ['P1', 'P2']);
  const view = JSON.parse(readFileSync(join(status.run_dir, `views/mapping-rows-${M1}.json`), 'utf8'));
  const row = view.rows.find((r) => r.property_id === 'P2');
  assert.equal(row.relation, '形式検証でない確認');
  assert.equal(row.reason, '数で表せない', 'reason は inventory の nonformal_reason');
  const mapped = result.models[0].mapping.filter((r) => r.property_id === 'P2' && r.source.kind === 'location');
  assert.deepEqual(mapped.map((r) => r.relation), ['形式検証でない確認']);
});

const MAPPING_DEFECTS = [
  ['骨組みの行に rows の要素が無い', (d) => ({ ...d, rows: [] })],
  ['骨組みに無い row_id が rows にある', (d) => ({ ...d, rows: [...d.rows, { ...d.rows[0], row_id: 'P1/E-none' }] })],
  ['extra_rows に source.kind が location の行がある', (d) => ({ ...d, extra_rows: [...d.extra_rows, { source: { kind: 'location', target_id: 'T1', file: 'spec.md', span: 'L2-L2' }, property_id: 'P1', model_element: MP1, relation: '形式化', reason: null }] })],
  ['extra_rows の property_id がそのモデルの性質に無い', (d) => ({ ...d, extra_rows: [...d.extra_rows, { source: { kind: 'goal', id: 'G1' }, property_id: 'P9', model_element: MP1, relation: '形式化', reason: null }] })],
];
for (const [name, edit] of MAPPING_DEFECTS) {
  test(`SP-264-025: 対応表の下書きで${name}と、モデル化の欠陥で修正の巡に戻り、直せば通常の結果になる`, async (t) => {
    const { result, harness } = await runScenario(t, { scenario: { editMappingDraft: (d, { round }) => (round === 1 ? edit(d) : d) } });
    assert.deepEqual(resultInvariants(result), []);
    assertRevised(harness, 'model-author', 'モデル化');
    assert.deepEqual(prop(result, 'P1').verdict, ['検証済み']);
    assert.equal(result.status, '完了', JSON.stringify(result.stop_report));
  });
}

test('SP-264-025: extra_rows に目標・既知の要求の行を書くと、結果の性質の sources にそれが載り、unmapped.requirements にその目標が載らない（今の挙動と同じ）', async (t) => {
  const request = canonicalRequest({ known_requirements: [{ id: 'K1', text: 'x は 0 以上である' }] });
  const editMappingDraft = (d) => ({ ...d, extra_rows: [...d.extra_rows, { source: { kind: 'known_requirement', id: 'K1' }, property_id: 'P1', model_element: MP1, relation: '形式化', reason: null }] });
  const { result } = await runScenario(t, { request, scenario: { editMappingDraft } });
  assert.deepEqual(resultInvariants(result), []);
  const src = prop(result, 'P1').sources.map((x) => `${x.kind}:${x.id}`);
  assert.ok(src.includes('goal:G1') && src.includes('known_requirement:K1'), src.join());
  assert.ok(!result.models[0].unmapped.requirements.some((x) => x.id === 'G1'), JSON.stringify(result.models[0].unmapped));
});
});
