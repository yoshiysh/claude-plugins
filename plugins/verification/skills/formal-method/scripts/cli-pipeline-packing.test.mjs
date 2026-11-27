// 結合: 担当の詰め合わせ（architecture.md「担当の起動」の起動の理由、cli-contract.md「依頼と応答」の claim・submit）、
// 意味の確認の 3 つの「かつ」（SP-FORMALMETHOD-012。artifact-formats.md「意味の確認から判定の入力への写し」）、
// 起動した担当の数と消費量（SP-FORMALMETHOD-013、artifact-formats.md「性能の記録」の agent_calls）を、担当の harness と PATH の偽の z3 で通して観測する。
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { runScenario, canonicalRequest, SPEC_TEXT } from './test-fixtures/pipeline.mjs';
import { resultInvariants } from './test-fixtures/result-schema.mjs';
import { modelIdOf } from './test-fixtures/core-ids.mjs';
import { P, prop, SM_A, SMT_A } from './test-fixtures/pipeline-cases.mjs';
import { UNIT_MAX_BYTES } from './lib/schemas.mjs';

const SPEC6 = `# 対象\n${[1, 2, 3, 4, 5, 6].map((i) => `R${i}: 性質 ${i} が成り立つ。`).join('\n')}\n`;
const FILES = { 'target/spec.md': SPEC6 };
const sorted = (xs) => [...xs].sort();
const idOf = (pid) => modelIdOf([pid]);
// 性質 n 件を、1 つずつ別のモデルに置く（出所を共有しないので partition-models が性質ごとにモデルを作る。#264 SP-264-010。
// model_id は modelIdOf で求め、モデルの並びは model_id の順）
const perModel = (props) => ({ properties: props, models: props.map((p, i) => ({ id: `M${i + 1}`, propertyIds: [p.id] })) });
const tasksOf = (harness, pred) => harness.memory.tasks.filter(pred);
// task を最初に返した claim（又は submit の next）の worker と、それが返した task の id。via は 'claim' か 'next'
function claimOf(harness, taskId) {
  for (const call of harness.memory.calls) {
    const c = call.claims.find((x) => x.task_ids?.includes(taskId));
    if (c) return { call, worker: c.worker, task_ids: c.task_ids, via: c.via };
  }
  return null;
}
// 判断を要する項目（効いている前提）を持つ性質: 前提 1 つ・規則 1 つ・否定 1 つで、偽の z3 は全ての節を要るとする
const PREMISE_SMT = '(declare-const x Int)\n(assert (>= x 0))\n(assert (<= x 8))\n(assert (not (>= (* x x) 0)))';
const withPremise = () => P('P1', 2, { smt: PREMISE_SMT, roles: ['premise', 'rule', 'goal'], scopeVariables: ['x'], fakeCore: (cs) => cs.map((c) => c.name) });

describe('cli-pipeline-packing', { concurrency: 4 }, () => {
test('SP-FORMALMETHOD-013 AC-12 詰め合わせ: 忠実さの単位 5 件（モデル 5 個）は 1 体の worker に入り、1 回の claim で 5 つの担当を受け取り、担当ごとに受理される', async (t) => {
  const props = ['P1', 'P2', 'P3', 'P4', 'P5'].map((id, i) => P(id, i + 2));
  const { result, harness } = await runScenario(t, { files: FILES, scenario: perModel(props) });
  assert.deepEqual(resultInvariants(result), []);
  const fid = tasksOf(harness, (x) => x.context.perspective === 'fidelity');
  assert.deepEqual(sorted(fid.map((x) => x.context.model_id)), sorted(props.map((p) => idOf(p.id))));
  const c = claimOf(harness, fid[0].task_id);
  assert.deepEqual(sorted(c.task_ids), sorted(fid.map((x) => x.task_id)), '1 回の claim が 5 つの担当を返す');
  assert.equal(c.call.workers.filter((w) => w.role === 'fidelity-reviewer').length, 1, '忠実さの確認役は 1 体');
  // 担当ごとに submit で受理された
  for (const f of fid) assert.ok(harness.memory.submits.some((s) => s.task_id === f.task_id && s.result?.ok && s.result.done), f.task_id);
  // 性質ごとの保証の担当は出ない
  assert.equal(tasksOf(harness, (x) => x.role === 'assurance-reviewer').length, 0);
  for (const p of props) assert.deepEqual(prop(result, p.id).verdict, ['検証済み'], p.id);
  assert.equal(result.status, '完了', JSON.stringify(result.stop_report?.reasons));
  // 確認の段で起動したのは、抽出の確認役 1 体と忠実さの確認役 1 体（反例が無いので原因の分類役は出ない）
  const st = result.performance.agent_calls.stages.find((s) => s.stage === '確認');
  assert.deepEqual(st.agents, { value: 2, unit: 'count' });
});

test('SP-FORMALMETHOD-013 architecture 担当の起動: 抽出役は、資料の和集合が UNIT_MAX_BYTES に収まる対象を 1 体に詰め、対象ごとの task を submit の next で順に渡す。収まらない対象は別の体', async (t) => {
  const request = canonicalRequest({ targets: [{ id: 'T1', location: 'target' }, { id: 'T2', location: 'target2' }, { id: 'T3', location: 'target3' }] });
  // T1・T2 は小さく、T3 は 1 件で UNIT_MAX_BYTES の半分を超え、T1・T2 の体に足すと収まらない
  const big = `${SPEC_TEXT}# pad ${'x'.repeat(UNIT_MAX_BYTES)}\n`;
  const { result, harness } = await runScenario(t, { files: { 'target/spec.md': SPEC_TEXT, 'target2/spec.md': SPEC_TEXT, 'target3/spec.md': big }, request });
  const calls = harness.memory.calls.filter((c) => c.stage === '洗い出し');
  assert.equal(calls.length, 1, '洗い出しの呼び出しは 1 回');
  assert.deepEqual(calls[0].workers.map((w) => w.role), ['extractor', 'extractor'], '抽出役は 2 体（T1・T2 と T3）');
  const ex = tasksOf(harness, (x) => x.role === 'extractor');
  const of = (tid) => claimOf(harness, ex.find((x) => x.context.target_id === tid).task_id);
  assert.equal(of('T1').worker, of('T2').worker);
  assert.notEqual(of('T1').worker, of('T3').worker);
  assert.deepEqual([of('T1').via, of('T1').task_ids.length, of('T2').via, of('T2').task_ids.length, of('T3').via], ['claim', 1, 'next', 1, 'claim']);
  const st = result.performance.agent_calls.stages.find((s) => s.stage === '洗い出し');
  assert.deepEqual(st.agents, { value: 2, unit: 'count' });
});

test('SP-FORMALMETHOD-013 AC-12 詰め合わせ: 資料が UNIT_MAX_BYTES を超える単位は 1 体に分かれ、他の単位は並びの順に詰める（next-fit）', async (t) => {
  // M5 の性質の query に UNIT_MAX_BYTES を超える注釈を入れる（忠実さの確認役は性質の query を資料に持つ）
  const big = `(declare-const x Int)\n; ${'comment '.repeat(Math.ceil(UNIT_MAX_BYTES / 8) + 10)}\n(assert (and (>= x (- 8)) (<= x 8)))\n(assert (not (>= (* x x) 0)))`;
  const props = ['P1', 'P2', 'P3', 'P4', 'P5'].map((id, i) => P(id, i + 2, id === 'P5' ? { smt: big, scopeVariables: ['x'] } : {}));
  const { result, harness } = await runScenario(t, { files: FILES, scenario: perModel(props) });
  assert.deepEqual(resultInvariants(result), []);
  const fid = tasksOf(harness, (x) => x.context.perspective === 'fidelity');
  const byWorker = new Map();
  for (const f of fid) { const c = claimOf(harness, f.task_id); const k = `${c.call.callId}/${c.worker}`; byWorker.set(k, [...(byWorker.get(k) ?? []), f.context.model_id]); }
  // 単位の並びは model_id の順。P5 のモデルは 1 体に分かれ、その前後の単位はそれぞれ並びの順に詰める（next-fit）
  const order = sorted(props.map((p) => idOf(p.id)));
  const k = order.indexOf(idOf('P5'));
  const expected = [order.slice(0, k), [order[k]], order.slice(k + 1)].filter((g) => g.length).map(sorted).sort((a, b) => a[0].localeCompare(b[0]));
  assert.deepEqual([...byWorker.values()].map(sorted).sort((a, b) => a[0].localeCompare(b[0])), expected, JSON.stringify([...byWorker]));
});

test('SP-FORMALMETHOD-013 architecture 担当の起動: 確認の段の担当が 6 体（抽出の確認役 1 体と、資料が UNIT_MAX_BYTES を超える忠実さの単位 5 件）でも、確認の段の呼び出しは 1 回で、args の workers は 6 件', async (t) => {
  const big = (i) => `(declare-const x Int)\n; ${`c${i} `.repeat(Math.ceil(UNIT_MAX_BYTES / 3) + 10)}\n(assert (and (>= x (- 8)) (<= x 8)))\n(assert (not (>= (* x x) 0)))`;
  const props = ['P1', 'P2', 'P3', 'P4', 'P5'].map((id, i) => P(id, i + 2, { smt: big(i), scopeVariables: ['x'] }));
  const { result, harness } = await runScenario(t, { files: FILES, scenario: perModel(props) });
  assert.deepEqual(resultInvariants(result), []);
  const calls = harness.memory.calls.filter((c) => c.stage === '確認');
  assert.equal(calls.length, 1, `確認の段の呼び出しは 1 つ: ${JSON.stringify(calls.map((c) => [c.callId, c.workers.map((w) => w.role)]))}`);
  assert.deepEqual(calls[0].workers.map((w) => w.id), ['w01', 'w02', 'w03', 'w04', 'w05', 'w06']);
  assert.equal(calls[0].workers.filter((w) => w.role === 'fidelity-reviewer').length, 5, '忠実さの確認役は単位ごとに 1 体');
  const st = result.performance.agent_calls.stages.find((s) => s.stage === '確認');
  assert.equal(st.calls, 1);
  assert.deepEqual(st.agents, { value: 6, unit: 'count' });
  for (const p of props) assert.deepEqual(prop(result, p.id).verdict, ['検証済み'], p.id);
});

test('SP-FORMALMETHOD-012 AC-22: 判断を要する項目が無い性質は、忠実さの確認が成り立てば 検証済み になり、成り立たなければ 検証済み にならない', async (t) => {
  const ok = await runScenario(t, {});
  assert.deepEqual(ok.result.confirmations.judgments, [], '正準のシナリオに判断を要する項目は無い');
  assert.deepEqual(prop(ok.result, 'P1').verdict, ['検証済み'], '判断を要する項目が 0 件でも未確認にしない');
  const bad = await runScenario(t, { scenario: { reviews: { fidelity: '成り立たない' } } });
  assert.deepEqual(resultInvariants(bad.result), []);
  assert.deepEqual(bad.result.confirmations.judgments, []);
  const p = prop(bad.result, 'P1');
  assert.deepEqual(p.verdict, ['未確認'], p.reason);
  assert.match(p.reason, /意味の確認（忠実さの確認）が成り立たない/);
});

test('SP-FORMALMETHOD-012 AC-22: 判断を要する項目の意味の確認が成り立たなければ、忠実さと静的な確認が成り立っても 検証済み にならず、その記録が結果に残る', async (t) => {
  for (const [answer, verdict] of [['成り立たない', ['未確認']], ['確認できず', ['未確認']], ['成り立つ', ['検証済み']]]) {
    const { result } = await runScenario(t, { scenario: { properties: [withPremise()], judgmentAnswers: { premise_load: answer } } });
    assert.deepEqual(resultInvariants(result), []);
    const [j] = result.confirmations.judgments;
    assert.equal(j?.cause, '効いている前提', JSON.stringify(result.confirmations.judgments));
    const jc = result.confirmations.meaning.filter((c) => c.kind === 'judgment' && c.item === j.id);
    assert.equal(jc.length, 1, '判断を要する項目ごとに意味の確認がちょうど 1 つ');
    assert.equal(jc[0].result, answer);
    assert.ok(jc[0].materials.length > 0 && jc[0].checker.startsWith('t'), '確認した者と渡した資料を持つ');
    assert.ok(prop(result, 'P1').confirmation_ids.includes(jc[0].id), '性質の confirmation_ids に入る');
    assert.equal(result.confirmations.meaning.find((c) => c.kind === 'fidelity').result, '成り立つ');
    const p = prop(result, 'P1');
    assert.deepEqual(p.verdict, verdict, `${answer}: ${p.reason}`);
    if (answer !== '成り立つ') {
      assert.match(p.reason, /意味の確認（判断を要する項目の意味の確認）が成り立たない/);
      assert.ok(result.stop_report.reasons.some((x) => x.code === '確認が終わっていない'));
    }
  }
});

test('SP-FORMALMETHOD-012 AC-22: 忠実さの確認役が判断を要する項目に答えない返り値は形の違いとして拒まれ、出し直しが無ければその項目は 確認できず', async (t) => {
  // 答えを落とした返り値（judgments []）を、上限まで出し直しても直さない
  const { result, harness } = await runScenario(t, { scenario: { properties: [withPremise()], judgmentAnswers: { premise_load: null } } });
  assert.deepEqual(resultInvariants(result), []);
  const fid = tasksOf(harness, (x) => x.context.perspective === 'fidelity')[0];
  const subs = harness.memory.submits.filter((s) => s.task_id === fid.task_id);
  assert.ok(subs[0].result.ok === false && subs[0].result.problems.some((x) => /判断を要する項目 .* の答えが無い/.test(x)), JSON.stringify(subs));
  const [j] = result.confirmations.judgments;
  assert.equal(result.confirmations.meaning.find((c) => c.kind === 'judgment' && c.item === j.id).result, '確認できず');
  assert.deepEqual(prop(result, 'P1').verdict, ['未確認']);
});

test('SP-FORMALMETHOD-011 AC-08 原因の束: 反例 3 件の原因の主題は 1 体の原因の分類役の 1 つの束になり、主題ごとに分類が返る', async (t) => {
  const props = ['P1', 'P2', 'P3'].map((id, i) => P(id, i + 2, { query: { result: 'sat' } }));
  const { result, harness } = await runScenario(t, { files: FILES, scenario: { properties: props } });
  assert.deepEqual(resultInvariants(result), []);
  const ca = tasksOf(harness, (x) => x.role === 'cause-analyst');
  assert.equal(ca.length, 3);
  const c = claimOf(harness, ca[0].task_id);
  assert.deepEqual(sorted(c.task_ids), sorted(ca.map((x) => x.task_id)), '1 回の claim が束の 3 件を返す');
  assert.equal(c.call.workers.filter((w) => w.role === 'cause-analyst').length, 1);
  assert.deepEqual(sorted(result.causes.map((x) => x.classified_by)), sorted(ca.map((x) => x.task_id)));
  assert.ok(result.causes.every((x) => x.cause === '対象が性質を満たさない'));
});

test('SP-FORMALMETHOD-011・013 原因の束: 束を取ったまま 1 件も出さなかった呼び出しの後は、試行に数えずに手放し、次の束の上限が半分になる', async (t) => {
  const props = ['P1', 'P2', 'P3'].map((id, i) => P(id, i + 2, { query: { result: 'sat' } }));
  const { result, harness } = await runScenario(t, { files: FILES, scenario: { properties: props, holdCalls: { 'cause-analyst': 1 } } });
  assert.deepEqual(resultInvariants(result), []);
  const calls = harness.memory.calls.filter((x) => x.workers.some((w) => w.role === 'cause-analyst'));
  assert.ok(calls.length >= 2, `原因の分類役の呼び出しが 2 つ以上: ${calls.length}`);
  const firstClaim = (call) => call.claims.find((x) => x.task_ids && call.workers.find((w) => w.id === x.worker).role === 'cause-analyst');
  const n1 = firstClaim(calls[0]).task_ids.length;
  const n2 = firstClaim(calls[1]).task_ids.length;
  assert.equal(n1, 3, '最初の束は 3 件');
  assert.ok(n2 < n1, `次の束は上限が半分なので小さい: ${n2}`);
  // 手放した主題は 担当の失敗 にせず、後の呼び出しで全て分類される
  assert.ok(!result.stop_report?.reasons.some((x) => x.code === '担当の失敗'), JSON.stringify(result.stop_report?.reasons));
  assert.equal(result.causes.length, 3);
  assert.ok(result.causes.every((x) => x.cause === '対象が性質を満たさない'), JSON.stringify(result.causes));
});

test('SP-FORMALMETHOD-008・013 分割と計画: 分割の候補が 2 つ以上なら、分割と計画は同じ worker が順に受け取り、計画の担当は分割の担当を受理した submit の next で返る', async (t) => {
  // 状態遷移を持つモデル 2 つ（依存グラフの分割の候補が 2 つになる）
  const scenario = {
    properties: [P('P1', 2, { smt: SMT_A }), P('P2', 3, { smt: SMT_A })],
    models: [{ id: 'M1', propertyIds: ['P1'], stateMachine: SM_A }, { id: 'M2', propertyIds: ['P2'], stateMachine: { ...SM_A, transitions: SM_A.transitions.map((x) => ({ ...x, source_ids: ['E-P2'] })) } }],
  };
  const { result, harness } = await runScenario(t, { scenario });
  assert.deepEqual(resultInvariants(result), []);
  assert.ok(result.decomposition.candidates.length >= 2, `分割の候補: ${result.decomposition.candidates.length}`);
  const pt = tasksOf(harness, (x) => x.role === 'partition-author')[0];
  const pl = tasksOf(harness, (x) => x.role === 'plan-author')[0];
  assert.ok(pt && pl, '分割と計画の担当が出る');
  const a = claimOf(harness, pt.task_id);
  const b = claimOf(harness, pl.task_id);
  assert.equal(a.call.callId, b.call.callId, '同じ呼び出し');
  assert.equal(a.worker, b.worker, '同じ worker');
  assert.deepEqual(a.call.workers.map((w) => w.role), ['partition-author+plan-author']);
  assert.deepEqual([a.via, a.task_ids], ['claim', [pt.task_id]], '最初の claim は分割の担当だけ');
  assert.deepEqual([b.via, b.task_ids], ['next', [pl.task_id]], '計画の担当は分割を受理した submit の next');
  const ptDone = harness.memory.submits.findIndex((s) => s.task_id === pt.task_id && s.result?.done);
  const plFirst = harness.memory.submits.findIndex((s) => s.task_id === pl.task_id);
  assert.ok(ptDone >= 0 && ptDone < plFirst, '計画の提出は分割が閉じた後');
  assert.equal(result.status, '完了', JSON.stringify(result.stop_report?.reasons));
});

test('SP-FORMALMETHOD-013 AC-12 agent_calls: 呼び出しごと・段ごと・全体の起動した担当の数と tokens を持ち、段の和と全体の和が呼び出しの値と合う', async (t) => {
  const { result, harness } = await runScenario(t, { hooks: { tokens: () => 1000 } });
  assert.deepEqual(resultInvariants(result), []);
  const ac = result.performance.agent_calls;
  assert.equal(ac.calls.length, harness.memory.calls.length);
  for (const c of ac.calls) {
    const h = harness.memory.calls.find((x) => x.callId === c.call_id);
    assert.equal(c.stage, h.stage);
    assert.equal(c.workers, h.workers.length);
    assert.deepEqual(c.agents, { value: h.workers.length, unit: 'count' });
    assert.deepEqual(c.launched.map((a) => a.role), h.workers.map((w) => w.role));
    assert.deepEqual(c.tokens, { value: 1000, unit: 'tokens' });
    assert.equal(c.closed_by, 'close');
  }
  for (const s of ac.stages) {
    const xs = ac.calls.filter((c) => c.stage === s.stage);
    assert.equal(s.calls, xs.length);
    assert.equal(s.agents.value, xs.reduce((n, c) => n + c.agents.value, 0));
    assert.equal(s.tokens.value, 1000 * xs.length);
  }
  assert.deepEqual(ac.total, { calls: ac.calls.length, agents: { value: ac.calls.reduce((n, c) => n + c.agents.value, 0), unit: 'count' }, tokens: { value: 1000 * ac.calls.length, unit: 'tokens' } });
  // 洗い出し・モデル化・計画・確認の各段に 1 つずつ、どれも 1 体（抽出役・モデル作成役・計画作成役）か確認の 2 体
  assert.deepEqual(ac.stages.map((s) => [s.stage, s.agents.value]), [['洗い出し', 1], ['モデル化', 1], ['計画', 1], ['確認', 2]]);
});

test('SP-FORMALMETHOD-013 AC-12 agent_calls: 起動の記録か tokens を取れなかった呼び出しは 取得できず で示し、0 にせず、それを含む段と全体の和も 取得できず にする', async (t) => {
  const pickConfirm = (s, call) => call.stage === '確認';
  const { result } = await runScenario(t, { hooks: { close: (s, call) => (pickConfirm(s, call) ? 'timed_out' : null) } });
  assert.deepEqual(resultInvariants(result), []);
  const ac = result.performance.agent_calls;
  const confirm = ac.calls.filter((c) => c.stage === '確認');
  assert.ok(confirm.length >= 1);
  for (const c of confirm) {
    assert.equal(c.closed_by, 'timed_out');
    assert.equal(c.agents.status, '取得できず');
    assert.deepEqual(c.launched, []);
    assert.equal(c.tokens.status, '取得できず');
  }
  // 他の段は起動の数が取れ、tokens は Workflow の返り値が null なので 取得できず
  for (const c of ac.calls.filter((x) => x.stage !== '確認')) { assert.equal(c.agents.unit, 'count'); assert.equal(c.tokens.status, '取得できず'); }
  assert.equal(ac.stages.find((s) => s.stage === '確認').agents.status, '取得できず');
  assert.equal(ac.stages.find((s) => s.stage === '洗い出し').agents.value, 1);
  assert.equal(ac.total.agents.status, '取得できず');
  assert.match(ac.total.agents.reason, /取得できなかった呼び出しがある/);
  assert.equal(ac.total.tokens.status, '取得できず');
});

test('SP-FORMALMETHOD-013 AC-12 詰め合わせ 結合: UNIT_MAX_BYTES を超える同じ対象のファイルの範囲だけを渡す形式化できない性質の単位 2 件は、範囲の行だけを数えて 1 体に入る', async (t) => {
  // ファイルの全体を数えると 1 件で上限を超えて 1 体ずつに分かれる（範囲の行だけを数えれば、2 件の和は数十バイト）
  const pad = `${'x'.repeat(78)}\n`.repeat(Math.ceil(UNIT_MAX_BYTES / 79) + 10);
  const files = { 'target/spec.md': `# 対象\nR1: 性質 1 が成り立つ。\nR2: 性質 2 が成り立つ。\nR3: 性質 3 が成り立つ。\n${pad}` };
  const props = [P('P1', 2), P('P2', 3, { formalizable: false }), P('P3', 4, { formalizable: false })];
  const { result, harness } = await runScenario(t, { files, scenario: { properties: props } });
  assert.deepEqual(resultInvariants(result), []);
  const nf = tasksOf(harness, (x) => x.context.perspective === 'nonformal');
  assert.equal(nf.length, 2);
  const c = claimOf(harness, nf[0].task_id);
  assert.deepEqual(sorted(c.task_ids), sorted(nf.map((x) => x.task_id)), '1 回の claim が 2 つの担当を返す');
  assert.equal(c.call.workers.filter((w) => w.role === 'assurance-reviewer').length, 1, '形式化できない性質の確認役は 1 体');
  for (const task of nf) assert.ok(task.context.input_refs.find((x) => x.ref === 'target:T1/spec.md')?.spans, `${task.task_id}: 範囲で渡す`);
});
});

