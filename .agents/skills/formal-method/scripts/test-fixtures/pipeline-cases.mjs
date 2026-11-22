// cli-pipeline*.test.mjs が共有する定数・判定の道具と、正準のシナリオの 1 回だけの run。
import { after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative } from 'node:path';
import { runScenario } from './pipeline.mjs';
import { resultInvariants, refInvariants } from './result-schema.mjs';
import { fileHash } from './fabricate.mjs';
import { removeTree } from './cli-runner.mjs';
import { SM2, SM2_PROPS, partitionFixture } from './partition.mjs';
import { stopStageViolations, deriveGraph, INTERRUPTS } from './decomposition-check.mjs';
import { TOOL_OUTPUT_MAX_BYTES } from './constants.mjs';
import { expandRefs } from './ledger-check.mjs';

export const P = (id, line, over = {}) => ({ id, file: 'spec.md', line, statement: `性質 ${id}`, query: { result: 'unsat' }, sanity: { result: 'sat' }, mutation: { result: 'sat' }, ...over });
export const prop = (result, id) => result.properties.find((p) => p.id === id);
export const checksOf = (result, p) => p.check_ids.map((id) => result.checks.find((c) => c.id === id));
export const sha256hex = (s) => createHash('sha256').update(s).digest('hex');
export const runRefOf = (runDir, dir, name) => relative(runDir, join(dir, name));
export const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
// 最後の plan-author の task の計画（harness が書いたもの）
export function planOf(harness) {
  const t = harness.memory.byRole['plan-author'];
  return { plan: readJson(join(t.attempt_dir, 'plan.json')), mutations: readJson(join(t.attempt_dir, 'mutations.json')) };
}
// 道具に渡す query: input_refs のファイルのバイト列を順に、各ファイルの後に \n を 1 つ置いてつないだもの（cli-contract「Z3 の adapter」）
export const queryOf = (runDir, refs) => refs.map((r) => `${readFileSync(join(runDir, r), 'utf8')}\n`).join('');
// 実行の証拠は checks/<execution_id>/ にあり、execution_id は検査なら Check.id、確認なら Confirmation.id（cli-contract「run の領域の配置」）
export const evidence = (runDir, id, name) => join(runDir, 'checks', id, name);
export const inputOf = (runDir, id) => readFileSync(evidence(runDir, id, 'input.smt2'), 'utf8');
// その実行の input.smt2 を受け取った偽の z3 の呼出し（指紋で引く）
export const callsFor = (log, text) => log.filter((e) => e.kind === 'query-start' && e.query_sha256 === sha256hex(text));
// 欠陥が残った計画の要素は実行せず、どの欄にも載せず、unverified[] に「計画の欠陥: <計画の id>」で載る（artifact-formats「検査」）
export function assertExcluded(result, ids) {
  for (const id of ids) {
    const u = result.unverified.find((x) => x.item.includes(`計画の欠陥: ${id}`));
    assert.ok(u, `unverified[] の item に 計画の欠陥: ${id}: ${JSON.stringify(result.unverified)}`);
    assert.ok(u.reason.length > 0, 'reason に残った欠陥の理由');
    assert.ok(!result.checks.some((c) => c.id === id), `${id} は checks[] に無い`);
    const confs = [...result.confirmations.deterministic, ...result.confirmations.meaning];
    assert.ok(!confs.some((c) => c.plan_id === id), `${id} から確認を作らない`);
    for (const p of result.properties) assert.ok(!p.check_ids.includes(id));
    if (result.stop_report) assert.ok(![...result.stop_report.checks_running, ...result.stop_report.checks_aborted].some((x) => x.id === id));
    assert.ok(!result.performance.executions.some((x) => x.id === id), `${id} は performance.executions に無い`);
  }
}
export const tOf = (call) => Number(call.args.find((a) => a.startsWith('-T:'))?.slice(3));
export const tasksOf = (harness, role) => harness.memory.tasks.filter((x) => x.role === role);
// 修正の巡: 同じ担当（同じ task）が 2 回以上提出し、1 回目の submit は ok: false で欠陥を返して出し直させた（architecture「段と処理の順序」の修正の巡）
export function assertRevised(harness, role, stage) {
  const ts = tasksOf(harness, role);
  assert.equal(ts.length, 1, `${role} の出し直しは同じ task（${ts.length} 件）`);
  assert.equal(ts[0].context.stage, stage, `修正の巡は同じ段（${stage}）`);
  const subs = harness.memory.submits.filter((x) => x.task_id === ts[0].task_id);
  assert.ok(subs.length >= 2, `${role} に修正の巡の提出がある（${subs.length} 回）`);
  assert.deepEqual([subs[0].result.ok, subs[0].result.done], [false, false], '1 回目の提出は欠陥を返して出し直させる');
  assert.ok(subs[0].result.problems.length >= 1, '欠陥を返す');
  assert.ok(subs.at(-1).result.done, '最後の提出で閉じる');
}

// harness を渡すと、採った計画（最後の plan-author の計画）で、計画との照合（refInvariants）も当てる
export function assertRecordsConsistent(status, result, harness = null) {
  const dir = status.run_dir;
  const read = (ref) => (existsSync(join(dir, ref)) ? readFileSync(join(dir, ref), 'utf8') : null);
  const t = harness?.memory.byRole['plan-author'];
  const adopted = t && existsSync(join(t.attempt_dir, 'plan.json')) ? { plan: runRefOf(dir, t.attempt_dir, 'plan.json'), mutations: runRefOf(dir, t.attempt_dir, 'mutations.json') } : null;
  if (harness) assert.ok(adopted || !t, '採った計画がある');
  assert.deepEqual(refInvariants(result, read, adopted), [], '起点が run の領域の Ref が実在し、結果が採った計画と合う');
  const savedRefs = new Set(result.records.saved.map((s) => s.ref));
  for (const s of result.records.saved) {
    assert.ok(existsSync(join(dir, s.ref)), `saved の ${s.ref} がある`);
    if (s.hash !== null) assert.equal(fileHash(join(dir, s.ref)), s.hash, `${s.ref} の指紋`);
  }
  for (const u of result.records.unsaved) assert.ok(!u.ref || !savedRefs.has(u.ref), `${u.ref} は saved に無い`);
}
// ---- 正準の 完了 のシナリオ（1 ファイル・1 目標・1 性質・1 検査・1 sanity・1 変異） ----
let canonical;
export const canonicalRun = async () => {
  if (!canonical) canonical = runScenario(null, {});
  return canonical;
};
after(async () => { if (canonical) { const c = await canonical.catch(() => null); if (c) removeTree(c.ws); } });

// ---- AC-05: 道具の失敗 ----
// [名前, 道具, query の指示, 期待の検査の判定, 期待の End の一部]
export const TOOL_CASES = [
  // 性質の検査には -model を渡すので、偽の z3 は unknown の後にもモデルを出す（実測の一部の unknown）。モデルは答えの読みに使わない
  ['答えとしての unknown（-model の下でモデルが続く）', 'fake', { result: 'unknown' }, 'unknown', { tool_result: '判定できない', abnormal_exit: false, unreadable_output: false }],
  ['道具自身の時間の上限（timeout）', 'fake', { result: 'timeout' }, '時間切れ', { tool_result: '判定できない', time_limit_hit: '道具' }],
  ['-T を超える応答の遅れ', 'fake', { sleepMs: 5000 }, '時間切れ', { tool_result: '判定できない', time_limit_hit: '道具' }],
  ['異常終了（出力なし、終了コード 3）', 'fake', { mode: 'crash' }, '実行失敗', { tool_result: 'なし', abnormal_exit: true, unreadable_output: false, stopped_by: null }],
  ['メモリ不足（標準エラーに (error "out of memory")、終了コード 101）', 'fake', { mode: 'oom' }, '実行失敗', { tool_result: 'なし', abnormal_exit: true, stopped_by: null }],
  ['構文の誤り（標準出力に (error …)、終了コード 1）', 'fake', { mode: 'syntax-error' }, '実行失敗', { tool_result: '判定以外のエラー', abnormal_exit: false, unreadable_output: false }],
  ['読めない出力（知らない 1 行）', 'fake', { result: 'maybe' }, '実行失敗', { tool_result: 'なし', unreadable_output: true, abnormal_exit: false }],
  ['読めない出力（空）', 'fake', { mode: 'empty' }, '実行失敗', { tool_result: 'なし', unreadable_output: true, abnormal_exit: false }],
  // -model を渡した実行で最初の行が答えでなければ、読む順 0 に当たらず 4 で読めない（sat と unsat の 2 行は下の証人の表）
  ['読めない出力（答えでない行で始まる 2 行）', 'fake', { mode: 'multi-junk' }, '実行失敗', { tool_result: 'なし', unreadable_output: true, abnormal_exit: false }],
  // -model の下では答えの後の (error …) の行はモデルの文字列に入り、終了コード 1 で abnormal_exit（cli-contract「読む順」0・3）
  ['答えの後の誤った form（sat・(error …)・モデル、終了コード 1）', 'fake', { mode: 'error-after-answer' }, '実行失敗', { tool_result: 'なし', abnormal_exit: true, unreadable_output: false, stopped_by: null }],
];

// ---- AC-14: 1 つずつ残すと 停止 ----
export const RESIDUE_CASES = [
  ['未対応（対応なし）', { mapping: { P1: '対応なし' } }, 'fake', (p) => assert.ok(!p.verdict.includes('検証済み'))],
  ['未実行（道具が無い）', {}, 'absent', (p) => assert.deepEqual(p.verdict, ['未実行'])],
  ['unknown', { properties: [P('P1', 2, { query: { result: 'unknown' } })] }, 'fake', (p) => assert.deepEqual(p.verdict, ['unknown'])],
  ['時間切れ', { properties: [P('P1', 2, { query: { result: 'timeout' } })] }, 'fake', (p) => assert.deepEqual(p.verdict, ['時間切れ'])],
  ['実行失敗', { properties: [P('P1', 2, { query: { mode: 'crash' } })] }, 'fake', (p) => assert.deepEqual(p.verdict, ['実行失敗'])],
  ['未確認（忠実さの確認が成り立たない）', { reviews: { fidelity: '成り立たない' } }, 'fake', (p) => assert.deepEqual(p.verdict, ['未確認'])],
  ['検出能力未確認（変異を用意できず別の方法も無い）', { properties: [P('P1', 2, { mutation: null })] }, 'fake', (p, r) => {
    assert.equal(p.detection.status, '検出能力未確認');
    assert.ok(r.stop_report.reasons.some((x) => x.code === '検出能力未確認'));
  }],
  ['必要な性質が 0 件', { properties: [] }, 'fake', (p, r) => {
    assert.equal(p, undefined);
    assert.ok(r.stop_report.reasons.some((x) => x.code === '必要な性質が 0 件'));
  }],
];

// ---- AC-19: 段の分かっている処理で失敗を起こす ----
// 担当の失敗（返り値が無い・形が違う・cannot_proceed）は、停止の理由 担当の失敗 を、その task の context.stage で記録する。
// 中断の理由ではないので run は先へ進み、stop_report.stage は最も上流の段（＝失敗した処理の段）になる。
export const AGENT_FAIL = [['extractor', ['inventory']], ['model-author', ['model', 'mapping']], ['plan-author', ['plan', 'mutations']]];
export const AGENT_MODES = [['返り値が無い', 'missing'], ['返り値の形が違う', 'bad_shape'], ['cannot_proceed を返す', 'cannot_proceed']];

// ---- 受け箱と close（cli-contract「受け箱」、artifact-formats「Workflow の返り値」） ----
// harness は担当を全て submit で受理させたうえで、司令塔の close だけを崩す（test-fixtures/agent-harness.mjs の hooks.close）。
// 受理は submit で決まっているので、どの閉じ方でも、その呼び出しの受理した担当は残る（前の稿の「batch ごと拒否」の回帰）。
// 期限の 2 つの型（late・none）は依頼の時間の上限で期限を近くに置く（担当の呼び出しの期限は早い方。architecture「時計と資源」）。
export const ID_CHARS = 'A-Za-z0-9._-';
export const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const hasId = (text, id) => new RegExp(`(^|[^${ID_CHARS}])${escapeRe(id)}([^${ID_CHARS}]|$)`).test(text);
export const ROLE_KINDS = { extractor: ['inventory'], 'model-author': ['model', 'mapping'], 'plan-author': ['plan', 'mutations'] };
export const firstCallWith = (role) => {
  let done = false;
  return (_s, call) => {
    if (done || !call.workers.some((x) => x.role === role)) return false;
    done = true;
    return true;
  };
};
export function assertAcceptedKept({ result, status, harness }, mode) {
  const picked = harness.memory.closes.filter((x) => x.mode === mode);
  assert.equal(picked.length, 1, `閉じ方 ${mode} を当てた呼び出しは 1 つ: ${JSON.stringify(harness.memory.closes)}`);
  const call = harness.memory.calls.find((c) => c.callId === picked[0].call_id);
  assert.deepEqual(resultInvariants(result), []);
  assert.deepEqual(stopStageViolations(result), [], JSON.stringify(result.stop_report?.reasons ?? []));
  const reasons = result.stop_report?.reasons ?? [];
  const created = result.records.saved.map((x) => x.ref);
  assert.ok(call.tasks.length >= 1, 'その呼び出しの担当が取られた');
  for (const task of call.tasks) {
    assert.ok(!reasons.some((x) => x.code === '担当の失敗' && hasId(x.detail, task.task_id)), `受理した ${task.task_id} は 担当の失敗 にならない: ${JSON.stringify(reasons)}`);
    if (ROLE_KINDS[task.role]) assert.ok(created.some((r) => r.startsWith(`attempts/${task.task_id}/`) && !r.endsWith('worklog.json')), `${task.task_id} の成果物は保存された`);
    if (task.context.perspective) assert.ok(result.confirmations.meaning.some((c) => c.checker === task.task_id && c.result !== '確認できず'), `${task.task_id} の意味の確認は残る`);
    if (task.role === 'cause-analyst') assert.ok(result.causes.some((c) => c.classified_by === task.task_id && c.cause !== '原因未確認'), `${task.task_id} の原因は残る`);
  }
  // 起動の記録と tokens を記録できない閉じ方は、その段の作業記録の unconfirmed に呼び出しの id と共に残る
  const log = JSON.parse(readFileSync(join(status.run_dir, 'worklogs', `cli-${call.stage}.json`), 'utf8'));
  const noted = log.unconfirmed.some((x) => x.includes(call.callId));
  assert.equal(noted, !['plain', 'wrapped'].includes(mode), `${mode}: unconfirmed に ${call.callId}: ${JSON.stringify(log.unconfirmed)}`);
  return call;
}
export const CLOSE_CASES = [
  // [名前, 閉じ方, 閉じ方を当てる呼び出しの役, 依頼の差分, scenario の差分]
  ['Workflow の完了通知が返り値を包む（{summary, agentCount, logs, result}）', 'wrapped', 'extractor', {}],
  ['close が timed_out: true（洗い出しの段）', 'timed_out', 'extractor', {}],
  ['close が timed_out: true（モデル化の段）', 'timed_out', 'model-author', {}],
  ['close が timed_out: true（確認の段）', 'timed_out', 'fidelity-reviewer', {}],
  ['close が timed_out: true（反例の原因の分類役）', 'timed_out', 'cause-analyst', {}, { properties: [P('P1', 3, { query: { result: 'sat' } })] }],
  ['期限の後に close する', 'late', 'extractor', { time_limit_seconds: 12 }],
  ['close しない（run-daemon が期限で閉じる）', 'none', 'extractor', { time_limit_seconds: 12 }],
  ['受け箱が JSON でない', 'inbox_not_json', 'extractor', {}],
  ['受け箱が形に合わない（workflow_output_path も timed_out も無い）', 'inbox_shape', 'extractor', {}],
  ['受け箱の call_id が開いている呼び出しと違う', 'inbox_call_id', 'extractor', {}],
  ['受け箱の workflow_output_path のファイルを読めない（存在しない）', 'wf_unreadable', 'extractor', {}],
  ['Workflow の返り値が形に合わない（agents が配列でない）', 'wf_shape', 'extractor', {}],
];

// ---- 照合役と原因の分類役の失敗（artifact-formats「確認」の意味の確認の作り方・写しの表、「担当の返り値」、architecture「担当の起動」） ----
// 失敗した task の 担当の失敗 の detail として許す文の集合。閉じた呼び出しの担当の失敗は detail が call_id・task_id を持つ
// （cli-contract「受け箱」）ので、その task のものに絞る。
export function failureDetails(sr, task) {
  const at = sr.reasons.filter((x) => x.code === '担当の失敗' && x.stage === task.context.stage);
  assert.ok(at.length >= 1, `${task.task_id} の段 ${task.context.stage} に 担当の失敗: ${JSON.stringify(sr.reasons)}`);
  const own = at.filter((x) => hasId(x.detail, task.task_id));
  assert.equal(own.length, 1, `${task.task_id} の 担当の失敗: ${JSON.stringify(sr.reasons)}`);
  return [own[0].detail];
}
// 写しの表の「関わる性質」
export function expectedPropertyIds(task, harness) {
  const c = task.context;
  if (c.perspective === 'fidelity') {
    const ms = harness.memory.models.filter((m) => m.id === c.model_id).map((m) => readJson(join(m.task.attempt_dir, m.file)));
    assert.ok(ms.length >= 1, `${c.model_id} のモデルを harness が書いた`);
    return [...new Set(ms[ms.length - 1].properties.flatMap((p) => p.inventory_property_ids))].sort();
  }
  if (c.perspective === 'nonformal') return c.property_ids;
  return [];
}
// 意味の確認の共通の欄（artifact-formats「意味の確認の作り方」の共通の欄と写しの表の「関わる性質」）
export function assertConfirmationCommon(conf, task, harness) {
  const c = task.context;
  assert.equal(conf.kind, c.perspective);
  assert.equal(conf.item, c.unit_id);
  assert.equal(conf.checker, task.task_id);
  assert.equal(conf.plan_id, null);
  assert.equal(conf.end, null);
  assert.equal(conf.model_property_id, null);
  assert.deepEqual(conf.property_ids, expectedPropertyIds(task, harness));
  // ディレクトリの ref は下の全てのファイルの RefHash に辞書順で展開する（artifact-formats「ディレクトリの ref の指紋」）
  assert.deepEqual(conf.materials, expandRefs(c.run_dir, c.input_refs), 'materials は context.input_refs をファイルの RefHash に展開したもの');
}
// expandRefs は test-fixtures/ledger-check.mjs（台帳の検査と同じ展開）
export function assertReviewFailed(result, task, harness, opts = {}) {
  const c = task.context;
  const sr = result.stop_report;
  assert.equal(result.status, '停止');
  const details = failureDetails(sr, task, opts);
  const confs = result.confirmations.meaning.filter((x) => x.item === c.unit_id && x.kind === c.perspective);
  assert.equal(confs.length, 1, `${c.unit_id} の意味の確認がちょうど 1 つ: ${JSON.stringify(result.confirmations.meaning)}`);
  const conf = confs[0];
  assert.equal(conf.result, '確認できず');
  assertConfirmationCommon(conf, task, harness);
  assert.ok(details.includes(conf.reason), `reason は 担当の失敗 の detail と同じ文: ${conf.reason} / ${JSON.stringify(details)}`);
  const detail = conf.reason;
  assert.ok(!result.confirmations.deterministic.some((x) => x.checker === task.task_id), '意味の確認は deterministic に入れない');
  assert.ok(result.unverified.some((u) => u.item === c.unit_id && u.reason === detail), `unverified[] に ${c.unit_id}: ${JSON.stringify(result.unverified)}`);
  assert.ok(sr.unconfirmed_scope.includes(c.unit_id), `unconfirmed_scope に ${c.unit_id}: ${JSON.stringify(sr.unconfirmed_scope)}`);
  assert.ok(sr.reasons.some((x) => x.code === '確認が終わっていない'), 'confirmations_unresolved が true で 確認が終わっていない');
}
export function assertCauseFailed(result, task, opts = {}) {
  const details = failureDetails(result.stop_report, task, opts);
  const cs = result.causes.filter((x) => x.classified_by === task.task_id);
  assert.equal(cs.length, 1, `${task.task_id} の原因がちょうど 1 つ: ${JSON.stringify(result.causes)}`);
  assert.equal(cs[0].cause, '原因未確認');
  assert.ok(details.includes(cs[0].grounds), `grounds は 担当の失敗 の detail と同じ文: ${cs[0].grounds} / ${JSON.stringify(details)}`);
  assert.deepEqual(cs[0].subject, task.context.subject);
  assert.ok(!result.confirmations.meaning.some((x) => x.checker === task.task_id), '原因の分類役の確認を作らない');
  if (task.context.subject.kind === 'question') assert.ok(!result.questions.some((q) => q.id === task.context.subject.id), '原因未確認 の問いは questions[] に入らない');
}
export const reviewTasks = (harness, perspective) => harness.memory.tasks.filter((x) => x.context.perspective === perspective);
export const REVIEW_FAIL_CASES = [
  // [観点, 失敗の型, scenario（又はそれを返す関数）, 判定の確かめ]
  ['fidelity', 'missing', {}, (r) => assert.deepEqual(prop(r, 'P1').verdict, ['未確認'])],
  ['fidelity', 'bad_shape', {}, (r) => assert.deepEqual(prop(r, 'P1').verdict, ['未確認'])],
  ['nonformal', 'missing', { properties: [P('P1', 2, { formalizable: false })] }, (r) => assert.deepEqual(prop(r, 'P1').verdict, ['未確認'])],
  ['nonformal', 'bad_shape', { properties: [P('P1', 2, { formalizable: false })] }, (r) => assert.deepEqual(prop(r, 'P1').verdict, ['未確認'])],
  ['extraction', 'missing', {}, (r) => {
    assert.equal(r.verified_scope.extraction_coverage.complete, false);
    assert.deepEqual(prop(r, 'P1').verdict, ['検証済み'], '抽出の確認は性質の判定に写さない');
  }],
  // PART_SCENARIO は後で定義するので、テストの中で呼ぶ
  ['composition', 'missing', () => PART_SCENARIO(), (r) => {
    for (const k of r.decomposition.contracts) assert.ok(!k.verdict.includes('検証済み'), `契約 ${k.id} は検証済みにならない`);
    assert.ok(!prop(r, 'P1').verdict.includes('検証済み'), '親の性質は検証済みにならない');
  }],
];

export const CAUSE_Q = { id: 'Q9', missing_decision: 'R2 の y が x と等しいときの扱い', affected: ['P2'], options: ['許す', '許さない'] };
export const CAUSE_FAIL_CASES = [
  // [名前, scenario, subject の kind]
  ['反例の原因の分類役が返らない', { properties: [P('P1', 3, { query: { result: 'sat' } })], returns: { 'cause-analyst': 'missing' } }, 'counterexample'],
  ['反例の原因の分類役が形の違う返り値を返す', { properties: [P('P1', 3, { query: { result: 'sat' } })], returns: { 'cause-analyst': 'bad_shape' } }, 'counterexample'],
  ['作成役の問いの原因の分類役が返らない', { properties: [P('P1', 2), P('P2', 3)], questionsBy: { extractor: [CAUSE_Q] },
    cause: { cause: '要求の不足', grounds: 'R2 は等しい場合を定めない', questions: [CAUSE_Q] }, returns: { 'cause-analyst': 'missing' } }, 'question'],
];

// 担当の失敗 以外で、段が契約で決まる処理の失敗。
export const STAGE_CASES = [
  ['道具の実行が実行失敗で終わる（実行できない検査は 実行）', { properties: [P('P1', 2, { query: { mode: 'crash' } })] }, 'fake', '実行'],
  ['道具が無い（実行できない検査は 計画）', {}, 'absent', '計画'],
  ['反例（反例は 実行）', { properties: [P('P1', 2, { query: { result: 'sat' } })] }, 'fake', '実行'],
  ['忠実さの確認が成り立たない（集約の条件だけ）', { reviews: { fidelity: '成り立たない' } }, 'fake', '集約'],
];

// ---- AC-03: 状態遷移の組合せと図 ----
export const SM = {
  states: ['待ち', '実行中', '完了'], events: ['開始', '終了'], initial: '待ち',
  variables: [{ id: 'x', sort: 'Int', domain: '0..1', init: '0' }],
  transitions: [
    { id: 'tr1', from: '待ち', event: '開始', to: '実行中', guard: 'true', updates: [], unchanged: ['x'], source_ids: ['E-P1'] },
    { id: 'tr2', from: '実行中', event: '終了', to: '完了', guard: 'true', updates: [], unchanged: ['x'], source_ids: ['E-P1'] },
  ],
  forbidden: [{ from: '完了', event: '開始', source_ids: ['E-P1'] }],
  uncovered: [{ from: '待ち', event: '終了', missing_info: '待ちで終了が来たときの定めが無い' }],
  goals: [{ state: '完了', kind: '完了', property_id: 'P1' }],
};


// ---- AC-06: 依存グラフの箇所（T の独立の照合。候補の導き直しは criteria の文法が契約に無いので行わない） ----
export function topLevelForms(text) {
  const forms = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === ';') { while (i < text.length && text[i] !== '\n') i += 1; continue; }
    if (c === '"') { i += 1; while (i < text.length && text[i] !== '"') i += 1; continue; }
    if (c === '(') { if (depth === 0) start = i; depth += 1; }
    if (c === ')') { depth -= 1; if (depth === 0) forms.push([start, i]); }
  }
  return forms;
}
export function resolvePointer(doc, pointer) {
  if (pointer === '') return doc;
  return pointer.split('/').slice(1).map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~')).reduce((o, k) => (o == null ? undefined : o[k]), doc);
}

// ---- AC-12: 性能の比較の条件 ----
export const CLAIM_CASES = [
  ['条件が一致する比較は 一致を確認 で、主張を残す', 'match', '一致を確認', true],
  ['範囲と保証の違う比較は 一致を確認できず で、主張を null にする', 'mismatch', '一致を確認できず', false],
];

// ---- AC-06: 依存グラフと候補の導き直し ----
// 返された形式モデル（models[].ref の model.json と、その query の .smt2）から、依存グラフの導出の規則で T が導き直す。
export function rederive(status, result) {
  const dir = status.run_dir;
  const read = (r) => (existsSync(join(dir, r)) ? readFileSync(join(dir, r), 'utf8') : null);
  return deriveGraph(result.models.map((m) => ({ model: JSON.parse(read(m.ref)), ref: m.ref })), read);
}
export function assertGraphMatches(status, result) {
  const mine = rederive(status, result);
  const g = result.decomposition.graph;
  assert.deepEqual(refInvariants(result, (ref) => (existsSync(join(status.run_dir, ref)) ? readFileSync(join(status.run_dir, ref), 'utf8') : null)), [], 'Ref とモデルの中の名前が実在する');
  assert.deepEqual(g.nodes, mine.nodes, '要素（id・kind・location・並び）');
  assert.deepEqual(g.edges, mine.edges, '辺（id・from・to・kind・location・並び）');
  assert.deepEqual(g.unconfirmed.map((u) => u.relation), mine.unconfirmed.map((u) => u.relation), '未確認の関係');
  return mine;
}

// ---- AC-07: 境界の契約と合成（分割の fixture は test-fixtures/partition.mjs） ----
export const partitionWithUnconfirmedAssumption = partitionFixture();

export const SM_A = { states: ['s0'], events: ['e'], initial: 's0', variables: [{ id: 'a', sort: 'Int', domain: '0..3', init: '0' }],
  transitions: [{ id: 't', from: 's0', event: 'e', to: 's0', guard: '(< a 3)', updates: [{ var: 'a', term: '(+ a 1)' }], unchanged: [], source_ids: ['E-P1'] }],
  forbidden: [], uncovered: [], goals: [] };
export const SMT_A = '(declare-const a Int)\n(assert (>= a 0))\n(assert (not (>= (+ a 1) 0)))';

// ---- 証人と replay（cli-contract「Z3 の adapter」「証人」、artifact-formats「反例と原因」） ----
// 反例の検査の query（input_refs をつないだもの）と、replay の input.smt2（Counterexample.replay.steps_ref）
export function counterexampleQueries(status, result, harness, propertyId) {
  const x = result.counterexamples.find((c) => c.property_id === propertyId);
  assert.ok(x, `${propertyId} の反例`);
  const { plan } = planOf(harness);
  const check = plan.checks.find((c) => c.id === x.check_id);
  const original = inputOf(status.run_dir, x.check_id);
  assert.equal(original, queryOf(status.run_dir, check.input_refs), '反例の検査の input.smt2 は input_refs をつないだもの');
  return { x, check, original, stepsText: readFileSync(join(status.run_dir, x.replay.steps_ref), 'utf8') };
}

// reason に記号を語として、この順に挙げ、absent の記号を挙げない
export function assertNamedInOrder(reason, names, absent = []) {
  const pos = (sym) => reason.search(new RegExp(`(^|[^A-Za-z0-9_!])${sym.replace('!', '\\!')}([^A-Za-z0-9_!]|$)`));
  const ps = names.map(pos);
  assert.ok(ps.every((x) => x >= 0), `${names.join('・')} を挙げる: ${reason}`);
  assert.deepEqual([...ps].sort((a, b) => a - b), ps, `宣言の順（${names.join('・')}）: ${reason}`);
  for (const a of absent) assert.equal(pos(a), -1, `${a} は挙げない: ${reason}`);
}

// 証人の規則を区別するモデル（cli-contract「証人」のモデルの形・証人の値・replay の query）。偽の z3 の model-text で、このモデルをそのまま出させる
export const WITNESS_SMT = ['p Int', 'q Bool', 'n Int', 'd Real', 'e Real', 't String', 'u String', 'm Int', 'h Real', 'lm (Array Int Int)', 'aa (Array Int Int)', 'g Int']
  .map((x) => `(declare-const ${x})`).join('\n') + '\n(declare-fun ff (Int) Int)\n(assert (> p (ff 1)))';
export const WITNESS_MODEL = [
  '(',
  '  ; 注釈の中の定義は使わない (define-fun m () Int 9)',
  '  (define-fun g () Int',
  '    (-',
  '      7))',
  '  (define-fun u () String',
  '    "x;y") ; 文字列の literal の中の ; は注釈でない',
  '  (define-fun t () String',
  '    "ab")',
  '  (define-fun e () Real',
  '    (/ 1.0 3.0))',
  '  (define-fun d () Real',
  '    1.5)',
  '  (define-fun n () Int',
  '    (- 3))',
  '  (define-fun q () Bool',
  '    false)',
  '  (define-fun p () Int',
  '    4)',
  '  (define-fun h () Real',
  '    (root-obj (+ (^ x 2) (- 2)) 1))',
  '  (define-fun lm () (Array Int Int)',
  '    (lambda ((x!1 Int)) 0))',
  '  (define-fun aa () (Array Int Int)',
  '    (_ as-array k!0))',
  '  (define-fun k!0 ((x!0 Int)) Int',
  '    0)',
  '  (define-fun ff ((x!0 Int)) Int',
  '    1)',
  ')',
].join('\n');

// 秘密値（cli-contract「run の領域の配置」の秘密値の走査）: 見つかった記録は書かず、値は出力に残らない
export const SECRET = 'AKIAABCDEFGHIJKLMNOP';
export function assertSecretNowhere(out, runDir) {
  assert.ok(!JSON.stringify(out.result).includes(SECRET), '結果に値が残らない');
  assert.ok(!out.statuses.some((x) => JSON.stringify(x).includes(SECRET)), 'Status に値が残らない');
  // 担当が自分で書いた attempts/ と、対象の写し targets/ は formal-method の記録でないので見ない
  const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (['attempts', 'targets'].includes(e.name) && d === runDir ? [] : walk(join(d, e.name))) : [join(d, e.name)]));
  for (const f of walk(runDir)) assert.ok(!readFileSync(f).includes(SECRET), `${relative(runDir, f)} に値が残らない`);
}

// 証人を読めないとき: 反例の検査は 反例 のまま、replay は始めず 確認できず、steps_ref は反例の検査の query を指す
export const NOT_STARTED_END = { started: false, tool_result: 'なし', abnormal_exit: false, unreadable_output: false, stopped_by: null, time_limit_hit: null };
export const WITNESS_CASES = [
  ['モデルが無い', { result: 'sat', model: 'none' }],
  ['形に合わないモデル（list の後に form が残る）', { result: 'sat', model: 'malformed' }],
  ['固定する記号が無いモデル（literal でない項だけ）', { result: 'sat', model: 'unfixable' }],
  ['答えの後の行が list でない（sat と unsat の 2 行。読む順 0 で 2 行目はモデルの文字列）', { mode: 'multi' }],
  ['TOOL_OUTPUT_MAX_BYTES を超えるモデル（上限までに答えを読めたので止めない）', { result: 'sat', model: 'huge' }],
];

// ---- 部分の契約の検査と合成の条件（artifact-formats「検査」「分割と合成」） ----
export const PART_SCENARIO = (over = {}, part = {}) => ({ stateMachine: SM2, properties: SM2_PROPS, partition: partitionFixture({ basis: 'guarantee', conds: ['CC1', 'CC2'], ...part }), ...over });
export const dropChecks = (...ids) => (plan) => ({ ...plan, checks: plan.checks.filter((c) => !ids.includes(c.id)) });

// 欠けた検査: 計画に無いので checks[] に無く、その契約・合成の条件の check_ids は空
export const missingCheck = (id, where) => (r, harness) => {
  assertRevised(harness, 'plan-author', '計画');
  assert.ok(!r.checks.some((c) => c.id === id), `計画に無い ${id} は checks[] に無い`);
  const owner = where === 'contract' ? r.decomposition.contracts.find((k) => k.id === 'K-a') : r.decomposition.composition_conditions.find((c) => c.id === 'CC1');
  assert.deepEqual(owner.check_ids, []);
};
// 依存先の検査が成功でない合成の条件の検査は始めない（D1）
export const ccNotRun = (r, id) => {
  const c = r.checks.find((x) => x.id === id);
  assert.ok(c, `${id} は checks[] にある`);
  assert.equal(c.state, '実行していない', `${id} の state`);
  assert.equal(c.verdict, '未実行', `${id} の verdict`);
};
// 親の性質の全てで no_suitable_tool（chosen.tool が z3 でない）。検査も変異も無ければ検査の欠けから除くので修正の巡は出ない
export const notZ3NoChecks = {
  editPlan: (plan) => ({ ...plan, selection: plan.selection.map((x) => ({ ...x, chosen: { ...x.chosen, tool: 'Rust' } })), checks: [] }),
  editMutations: (m) => ({ ...m, mutations: [], unavailable: m.mutations.map(() => ({ property_id: 'P1', reason: 'z3 で実行しない', alternative: null })) }),
};
export const PART_CASES = [
  // [名前, scenario の上書き, 分割の上書き, 契約 K-a の期待の判定, 親 P1 の期待の判定, 追加の検査]
  // harness は合成の条件の検査の depends_on に契約の検査を置くので、契約の検査が成功でなければ C-CC1 は始めず 未実行（D1、architecture「互いに独立な検査」）。
  // 親の性質は aggregateProperty の段 1 で 未実行
  ['契約の検査が 反例', {}, { contract: { result: 'sat' } }, ['反例'], ['未実行'], (r) => ccNotRun(r, 'C-CC1')],
  ['契約の検査が 時間切れ（道具自身の時間の上限）', {}, { contract: { result: 'timeout' } }, ['時間切れ'], ['未実行'], (r) => ccNotRun(r, 'C-CC1')],
  ['契約の検査が欠けた（修正の巡の後も残る）', { editPlan: dropChecks('C-K-a') }, {}, ['未確認'], ['未確認'], missingCheck('C-K-a', 'contract')],
  ['契約に依る合成の条件の検査が欠けた（修正の巡の後も残る）', { editPlan: dropChecks('C-CC1') }, {}, ['検証済み'], ['未確認'], missingCheck('C-CC1', 'condition')],
  ['契約に依らない合成の条件の検査が 反例', {}, { cond: { CC2: { result: 'sat' } } }, ['検証済み'], ['反例'], null],
  // 契約の判定の facts は親の性質から取る（artifact-formats「分割と合成」の契約の判定）
  ['親の性質の前提の整合（sanity）が成り立たない（deterministic_confirmed が false）', { properties: [{ ...SM2_PROPS[0], sanity: { result: 'unsat' } }] }, {}, ['未確認'], ['未確認'], null],
  ['合成の意味の確認が成り立たない（meaning_confirmed が false）', { reviews: { composition: '成り立たない' } }, {}, ['未確認'], ['未確認'], null],
  ['合成の意味の確認が 確認できず（合成の検証者が返らない）', { returns: { 'composition-reviewer': 'missing' } }, {}, ['未確認'], ['未確認'], null],
  ['親の性質の chosen.tool が z3 でないのに契約・合成の条件の検査がある（欠陥として除く）', { editPlan: (plan) => ({ ...plan, selection: plan.selection.map((x) => ({ ...x, chosen: { ...x.chosen, tool: 'Rust' } })) }) }, {}, ['未実行'], ['未実行'],
    (r, harness) => { assertRevised(harness, 'plan-author', '計画'); assertExcluded(r, ['C-P1', 'C-K-a', 'C-CC1', 'C-CC2']); }],
  ['親の性質の全てで no_suitable_tool で、検査が無い（検査の欠けから除く）', notZ3NoChecks, {}, ['未実行'], ['未実行'],
    (r, harness) => { assert.equal(tasksOf(harness, 'plan-author').length, 1, '修正の巡は出ない'); assert.deepEqual(r.checks, []); }],
];

// ---- 検査の欠けと 形式化 の行（artifact-formats「形式モデルと対応」「plan と mutations」） ----
export function assertNoChecksRow(result, id) {
  const rows = result.models.flatMap((m) => m.mapping).filter((r) => r.property_id === id && r.relation === '形式化');
  assert.ok(rows.length >= 1, `${id} の 形式化 の行`);
  for (const r of rows) { assert.deepEqual(r.check_ids, []); assert.ok(r.reason && r.reason.length > 0, '検査の無い理由'); }
  assert.deepEqual(prop(result, id).check_ids, []);
  assert.ok(prop(result, id).reason.length > 0);
}

export const NO_PLAN_CASES = [
  // [名前, 道具, 計画作成役の返り方, 期待の判定]
  ['計画作成役が返らず、道具がある', 'fake', 'missing', ['未確認']],
  ['計画作成役が cannot_proceed を返し、道具がある', 'fake', 'cannot_proceed', ['未確認']],
  ['計画作成役が返らず、道具が無い（SP-007）', 'absent', 'missing', ['未実行']],
];

// ---- 計画の照合（artifact-formats「plan と mutations」、cli-contract「Z3 の adapter」の道具に渡す query） ----
export const setSelection = (fn) => (plan) => ({ ...plan, selection: fn(plan.selection) });
export const z3Candidate = (sel) => sel.candidates.find((c) => c.name === 'z3');
export const withChosen = (tool) => setSelection((sel) => sel.map((x) => ({ ...x, chosen: { ...x.chosen, tool } })));
// 欠陥が残ったときの期待: 欠陥の残った計画の要素（検査・sanity・変異）は除き（assertExcluded）、性質は道具があれば 未確認、SP-007 なら 未実行
// （artifact-formats「検査」）。selection の欠け・重なりが残った性質も、その検査を欠陥の残った要素として除き、method は null（artifact-formats.md:733）。
export const sp007 = (r) => { assertExcluded(r, ['C-P1']); assert.deepEqual(prop(r, 'P1').verdict, ['未実行']); };
export const selectionLeft = (r) => {
  assertExcluded(r, ['C-P1']);
  assert.equal(prop(r, 'P1').method, null, 'method は null');
  assert.deepEqual(prop(r, 'P1').verdict, ['未確認'], 'no_suitable_tool は準備の結果だけ（z3 はある）');
  assert.ok(r.stop_report.reasons.some((x) => x.code === '必要な性質が検証の成功でない'), JSON.stringify(r.stop_report.reasons));
};
export const PLAN_DEFECTS = [
  // [名前, scenario の上書き（巡ごと）, 欠陥が残ったときの期待]
  ['selection の要素が欠ける', { editPlan: setSelection(() => []) }, selectionLeft],
  ['selection の要素が重なる', { editPlan: setSelection((sel) => [...sel, structuredClone(sel[0])]) }, selectionLeft],
  // モデルの性質ごとに PlanFile.sanity が 1 つ以上ある（artifact-formats.md:743 の検査の欠け）
  ['sanity の無い計画', { editPlan: (plan) => ({ ...plan, sanity: [] }) },
    (r) => {
      assert.ok(!r.confirmations.deterministic.some((c) => c.kind === 'sanity'), 'sanity の確認は無い');
      // 静的な確認の plan_coverage が 成り立たない ので、述語 1 に加えて述語 2（確認が終わっていない）でも止まる（SP-FORMALMETHOD-012）
      const cov = r.confirmations.deterministic.find((c) => c.kind === 'plan_coverage' && c.model_property_id === 'P1');
      assert.equal(cov?.result, '成り立たない', JSON.stringify(cov));
      assert.match(cov.reason, /前提の整合の確認/);
      assert.deepEqual(prop(r, 'P1').verdict, ['未確認']);
      const codes = r.stop_report.reasons.map((x) => x.code);
      assert.ok(codes.includes('必要な性質が検証の成功でない') && codes.includes('確認が終わっていない'), codes.join());
    }],
  // property・contract・composition の検査の expected は unsat（artifact-formats.md:731）
  ['kind property の検査の expected が unsat でない', { editPlan: (plan) => ({ ...plan, checks: plan.checks.map((c) => (c.id === 'C-P1' ? { ...c, expected: 'sat' } : c)) }) },
    (r) => { assertExcluded(r, ['C-P1']); assert.deepEqual(prop(r, 'P1').verdict, ['未確認']); }],
  ['chosen.tool が表記の揺れ（Z3）で候補の名前に無い', { editPlan: withChosen('Z3') }, sp007],
  ['chosen.tool が候補に無い名前', { editPlan: withChosen('cvc5') }, sp007],
  ['z3 の検証器の候補が無い', { editPlan: setSelection((sel) => sel.map((x) => ({ ...x, candidates: x.candidates.map((c) => (c.name === 'z3' ? { ...c, name: 'cvc5' } : c)), chosen: { ...x.chosen, tool: 'cvc5' } }))) }, sp007],
  ['chosen.tool が z3 でない性質に kind property の検査がある', { editPlan: withChosen('Rust') }, sp007],
  ['kind contract の検査の target_id がモデルの性質の id', { editPlan: (plan) => ({ ...plan, checks: [...plan.checks, { ...plan.checks[0], id: 'C-bad', kind: 'contract', target_id: 'P1' }] }) },
    (r) => { assertExcluded(r, ['C-bad']); assert.ok(r.checks.some((c) => c.id === 'C-P1'), '欠陥の無い検査は実行する'); }],
  // input_refs が指せるのは担当の query だけ（cli-contract.md:337）。担当の query 2 つを並べると、(check-sat) を持つ input が最後でない
  ['担当の query 2 つを並べた検査（(check-sat) を持つ input が最後でない）', { editPlan: (plan, { mref }) => ({ ...plan, checks: plan.checks.map((c) => (c.kind === 'property' ? { ...c, input_refs: [mref(`${c.target_id}-sanity.smt2`), ...c.input_refs] } : c)) }) },
    // 検出役の検査の input_refs を使う変異 MU-P1 も、最後の input を置き換えた後も (check-sat) を持つ input が最後でないので除く
    (r) => { assertExcluded(r, ['C-P1', 'MU-P1']); assert.deepEqual(prop(r, 'P1').verdict, ['未確認'], '検査の欠けと同じ'); }],
  ['input_refs が担当の query でないファイル（対象の写し）を指す検査', { editPlan: (plan, { targetRef }) => ({ ...plan, checks: plan.checks.map((c) => (c.kind === 'property' ? { ...c, input_refs: [targetRef('spec.md'), ...c.input_refs] } : c)) }) },
    (r) => { assertExcluded(r, ['C-P1']); assert.deepEqual(prop(r, 'P1').verdict, ['未確認']); }],
  ['(check-sat) が最後の form でない変異（計画作成役の .smt2）', { editMutations: (m, { put }) => ({ ...m, mutations: m.mutations.map((x) => ({ ...x, mutation_ref: put('mut-bad.smt2', '; mutation bad\n(declare-const x Int)\n(check-sat)\n(assert (> x 0))\n') })) }) },
    (r) => {
      // 変異を全て除かれた性質: detection は 検出能力未確認・mutations []・reason に除いた変異の計画の id。run は 停止 で理由に 検出能力未確認（artifact-formats.md:731）
      assertExcluded(r, ['MU-P1']);
      const det = prop(r, 'P1').detection;
      assert.equal(det.status, '検出能力未確認');
      assert.deepEqual(det.mutations, []);
      assert.ok(det.reason.includes('MU-P1'), `reason に除いた変異の id: ${det.reason}`);
      assert.ok(det.reason.includes('別の方法の確認の結果が無い'), `reason に「別の方法の確認の結果が無い」: ${det.reason}`);
      assert.ok(r.stop_report.reasons.some((x) => x.code === '検出能力未確認'), JSON.stringify(r.stop_report.reasons));
    }],
  // 変異は検出役の性質の query と同じ節の名前の集合を持つ（artifact-formats「担当の成果物」の節の名前、SP-FORMALMETHOD-012）
  ['節の名前（:named）を保たない変異', { editMutations: (m, { put }) => ({ ...m, mutations: m.mutations.map((x) => ({ ...x, mutation_ref: put('mut-unnamed.smt2', '; mutation unnamed\n(declare-const x Int)\n(assert (> x 0))\n(check-sat)\n') })) }) },
    (r) => {
      assertExcluded(r, ['MU-P1']);
      assert.equal(prop(r, 'P1').detection.status, '検出能力未確認');
      const ref = r.confirmations.deterministic.find((c) => c.kind === 'reference');
      assert.equal(ref?.result, '成り立たない', '名前の食い違いは reference の区分の欠陥');
      assert.match(ref.reason, /MU-P1 の assert の名前/);
    }],
  // mutation_ref は計画作成役自身の attempts/<task_id>/ で始まる（artifact-formats「変異のファイル」）。モデル作成役の query を指すと計画の欠陥
  ['mutation_ref が他の役の attempt（モデル作成役の query）を指す変異', { editMutations: (m, { mref }) => ({ ...m, mutations: m.mutations.map((x) => ({ ...x, mutation_ref: mref(`${x.property_id}.smt2`) })) }) },
    (r) => {
      assertExcluded(r, ['MU-P1']);
      const det = prop(r, 'P1').detection;
      assert.equal(det.status, '検出能力未確認');
      assert.ok(det.reason.includes('MU-P1'), `reason に除いた変異の id: ${det.reason}`);
      assert.ok(det.reason.includes('別の方法の確認の結果が無い'), `reason に「別の方法の確認の結果が無い」: ${det.reason}`);
    }],
];
export const onlyRound1 = (fn) => (x, ctx) => (ctx.round === 1 ? fn(x, ctx) : x);

// 担当が書く .smt2 の規則（(check-sat) をちょうど 1 つ最後の form に置き、get-model・set-option・push などを書かない）は、
// そのファイルを書いた役の段で照らす（artifact-formats「担当の成果物」）
export const SMT_VIOLATIONS = [
  ['(check-sat) の後に form がある', (q) => `${q}(assert true)\n`],
  ['(check-sat) が 0 個', (q) => q.replace('(check-sat)\n', '')],
  ['(check-sat) が 2 個', (q) => `${q}(check-sat)\n`],
  ['get-model を書いた', (q) => q.replace('(check-sat)', '(get-model)\n(check-sat)')],
  ['set-option を書いた', (q) => `(set-option :produce-models true)\n${q}`],
  ['push を書いた', (q) => q.replace('(check-sat)', '(push 1)\n(check-sat)')],
];
export const appendAfterCheckSat = (when) => (text, { round, kind }) => (kind === 'property' && when(round) ? `${text}(assert true)\n` : text);

// sanity の確認が無い（除いた sanity がある）性質は deterministic_confirmed が false で 未確認、run は述語 1 で 停止（artifact-formats.md:593）
export function assertNoSanityConfirmed(r) {
  assert.deepEqual(prop(r, 'P1').verdict, ['未確認']);
  assert.equal(r.status, '停止');
  const codes = r.stop_report.reasons.map((x) => x.code);
  assert.ok(codes.includes('必要な性質が検証の成功でない'), codes.join());
  assert.ok(!codes.includes('確認が終わっていない'), `述語 2 に当たらない: ${codes.join()}`);
}

// 分割作成役の契約・合成の条件の query は、計画の段の分割の照合で照らし、修正の巡は分割作成役に出る
export const PARTITION_QUERY_VIOLATIONS = [['契約', 'contract', 'C-K-a'], ['合成の条件', 'composition', 'C-CC1']];
// persist が false なら 1 巡目だけ違反し、修正の巡で直す
export const partitionViolating = (which, persist) => (cands, put, ctx) => {
  const base = partitionFixture({ basis: 'guarantee', conds: ['CC1', 'CC2'] })(cands, put, ctx);
  if (!persist && ctx.round > 1) return base;
  const bad = (x, id) => ({ ...x, query_ref: put(`${id}-bad.smt2`, `; ${which} ${id}\n(declare-const a Int)\n(check-sat)\n(assert (< a 0))\n`) });
  return which === 'contract'
    ? { ...base, contracts: base.contracts.map((k) => bad(k, k.id)) }
    : { ...base, composition_conditions: base.composition_conditions.map((c) => (c.id === 'CC1' ? bad(c, c.id) : c)) };
};

// ---- 道具を実行した確認の result（cli-contract「Z3 の adapter」: end に classifyCheck を当て、成功 → 成り立つ、反例 → 成り立たない、他 → 確認できず） ----
export const SANITY_CASES = [
  ['sat（期待どおり）', { result: 'sat' }, '成り立つ'],
  ['unsat（前提の矛盾）', { result: 'unsat' }, '成り立たない'],
  ['unknown', { result: 'unknown' }, '確認できず'],
  ['timeout', { result: 'timeout' }, '確認できず'],
  ['異常終了', { mode: 'crash' }, '確認できず'],
  // sanity には -model を渡さないので、sat と unsat の 2 行は読む順 0 に当たらず読めない出力
  ['sat と unsat の 2 行（-model なしでは読めない）', { mode: 'multi' }, '確認できず'],
  // -model を渡さない実行では、答えの後の (error …) の行は読む順 1 に当たる
  ['答えの後の誤った form（-model なしで sat と (error …)、終了コード 1）', { mode: 'error-after-answer' }, '確認できず', { tool_result: '判定以外のエラー', abnormal_exit: false }],
];

// ---- 問いに依存する性質は、挙げた段より後の段から外す（architecture.md:100-104、artifact-formats.md:740） ----
export const QUESTION = { id: 'Q1', missing_decision: 'R2 の y が x と等しいときの扱い', affected: ['P2'], options: ['許す', '許さない'] };
export const QUESTION_CASES = [
  // [問いを挙げた役, P2 の 形式化 の行]
  ['extractor', 'none'],
  ['model-author', 'empty'],
  ['plan-author', 'empty'],
];

// ======== 契約の改訂（レビューの n=5・31・32・33・34、SP-012 の syntax・reference・output_format）で増えたケース ========

// 決定的な確認のうち kind ごとに 1 つ（run に最大 1 つ）を返す。無ければ undefined
export function detConf(result, kind) {
  const cs = result.confirmations.deterministic.filter((c) => c.kind === kind);
  assert.ok(cs.length <= 1, `${kind} の確認は run に 1 つまで: ${cs.length}`);
  return cs[0];
}
export const DET_ITEMS = { syntax: '担当の成果物の構文', reference: '担当の成果物の参照の解決', output_format: '道具の出力の形式', result_presence: '計画した全ての検査の結果' };
// 共通の欄（artifact-formats「result_presence の作り方」「syntax・reference・output_format の作り方」）
export function assertDetCommon(c) {
  assert.deepEqual([c.property_ids, c.model_property_id, c.plan_id, c.checker, c.materials, c.end], [[], null, null, 'cli', [], null], `${c.kind} の共通の欄`);
  assert.equal(c.item, DET_ITEMS[c.kind]);
  assert.equal(typeof c.reason, 'string');
}

// ---- n=5: 分割の照合の境界（artifact-formats「分割の照合の境界」） ----
// 1 巡目だけ欠陥のある分割を返し、修正の巡で直す（persist なら直さない）
export const partitionDefect = (kind, persist = false) => (cands, put, ctx) => {
  const base = partitionFixture({ basis: 'guarantee', conds: ['CC1', 'CC2'] })(cands, put, ctx);
  if (!persist && ctx.round > 1) return base;
  if (kind === 'responsible') return { ...base, boundaries: base.boundaries.map((b) => ({ ...b, responsible: ['K-missing'] })) };
  if (kind === 'part_id') return { ...base, contracts: base.contracts.map((k) => ({ ...k, part_id: 'part-b' })) };
  return { ...base, boundaries: base.boundaries.map((b) => ({ ...b, assumption_basis: { kind: '共同不変条件', check_ids: ['C-JI1'] } })) };
};
export const PARTITION_DEFECTS = [
  ['Boundary.responsible が同じ分割の contracts[].id に無い', 'responsible'],
  ['責任を負う契約の part_id が Boundary.producer と違う', 'part_id'],
  ['assumption_basis.kind が 共同不変条件', 'joint'],
];

// ---- context.property_ids（artifact-formats「役と context」の model-author・plan-author の行） ----
export function assertAuthorPropertyIds(harness) {
  const inv = harness.memory.tasks.filter((x) => x.role === 'extractor').flatMap((x) => readJson(join(x.attempt_dir, 'inventory.json')).properties);
  const extractorBlocked = new Set(inv.filter((p) => p.blocked_by_question.length > 0).map((p) => p.id));
  const sorted = (xs) => [...xs].sort();
  for (const ma of harness.memory.tasks.filter((x) => x.role === 'model-author')) {
    assert.deepEqual(sorted(ma.context.property_ids), sorted(inv.map((p) => p.id).filter((id) => !extractorBlocked.has(id))), 'model-author の property_ids');
  }
  const maTask = harness.memory.tasks.filter((x) => x.role === 'model-author').at(-1);
  const maRet = harness.memory.authorReturns.filter((x) => x.task.role === 'model-author').at(-1);
  const inModels = new Set(harness.memory.models.flatMap((m) => readJson(join(m.task.attempt_dir, m.file)).properties.flatMap((p) => p.inventory_property_ids)));
  const formal = new Set(inv.filter((p) => p.formalizable).map((p) => p.id));
  for (const pa of harness.memory.tasks.filter((x) => x.role === 'plan-author')) {
    const expected = maTask.context.property_ids.filter((id) => formal.has(id) && !maRet.ret.blocked_by_question.includes(id) && inModels.has(id));
    assert.deepEqual(sorted(pa.context.property_ids), sorted(expected), 'plan-author の property_ids');
  }
}
export const PROPERTY_IDS_CASES = [
  // [名前, scenario]
  ['形式化できない性質を含む', { properties: [P('P1', 2), P('P2', 3, { formalizable: false })] }],
  ['抽出役が問いに依存すると挙げた性質を含む', { properties: [P('P1', 2), P('P2', 3)], questionsBy: { extractor: [{ id: 'Q8', missing_decision: 'R2', affected: ['P2'], options: ['a', 'b'] }] } }],
  ['モデル作成役が問いに依存すると挙げた性質を含む', { properties: [P('P1', 2), P('P2', 3)], questionsBy: { 'model-author': [{ id: 'Q8', missing_decision: 'R2', affected: ['P2'], options: ['a', 'b'] }] } }],
];

// ---- n=33: 独立検証者と原因の分類役の input_refs（artifact-formats「独立検証者と原因の分類役の input_refs」） ----
export const norm = (r) => r.replace(/\/+$/, '');
export function lastTask(harness, role, pred = () => true) { return harness.memory.tasks.filter((x) => x.role === role && pred(x)).at(-1); }
export function expectedInputRefs(task, { result, harness, runDir }) {
  const c = task.context;
  const rel = (abs) => relative(runDir, abs);
  const req = readJson(join(runDir, 'request.json'));
  const allCopies = req.targets.map((x) => `targets/${x.id}/files`);
  const invOf = (targetId) => rel(join(lastTask(harness, 'extractor', (x) => x.context.target_id === targetId).attempt_dir, 'inventory.json'));
  const allInv = req.targets.map((x) => invOf(x.id));
  const modelOf = (id) => { const m = harness.memory.models.filter((x) => x.id === id).at(-1); return { model: rel(join(m.task.attempt_dir, m.file)), mapping: rel(join(m.task.attempt_dir, `mapping-${id}.json`)), json: readJson(join(m.task.attempt_dir, m.file)) }; };
  const ran = (id) => existsSync(join(runDir, 'checks', id));
  const rec = (id) => `checks/${id}`;
  const plan = lastTask(harness, 'plan-author');
  switch (c.perspective) {
    case 'extraction': return [`targets/${c.target_id}/files`, `targets/${c.target_id}/manifest.json`, invOf(c.target_id), 'worklogs/cli-洗い出し.json'];
    case 'fidelity': {
      // 性質の query と、判断を要する項目があればその記録とその実行の記録（artifact-formats「独立検証者と原因の分類役の input_refs」）
      const m = modelOf(c.model_id);
      const mps = new Set(m.json.properties.map((p) => p.id));
      const js = result.confirmations.judgments.filter((j) => mps.has(j.model_property_id));
      return [...allCopies, ...req.targets.map((x) => `targets/${x.id}/manifest.json`), ...allInv, m.model, m.mapping, ...m.json.properties.map((p) => p.query_ref),
        ...(js.length ? [`judgments/${c.model_id}.json`] : []), ...js.map((j) => j.id).filter(ran).map(rec), 'worklogs/cli-モデル化.json'];
    }
    case 'nonformal': {
      const pid = c.property_ids[0];
      const inv = harness.memory.tasks.filter((x) => x.role === 'extractor').map((x) => ({ x, j: readJson(join(x.attempt_dir, 'inventory.json')) })).filter(({ j }) => j.properties.some((p) => p.id === pid)).at(-1);
      const p = inv.j.properties.find((y) => y.id === pid);
      const targets = [...new Set(p.source_ids.map((sid) => inv.j.elements.find((e) => e.id === sid).source.target_id))];
      return [...targets.map((id) => `targets/${id}/files`), rel(join(inv.x.attempt_dir, 'inventory.json'))];
    }
    case 'composition': {
      const pt = lastTask(harness, 'partition-author');
      const pj = readJson(join(pt.attempt_dir, 'partitions.json'));
      const models = [...new Set(harness.memory.models.map((m) => m.id))].map((id) => modelOf(id).model);
      const execs = result.checks.filter((x) => ['contract', 'composition'].includes(x.kind)).map((x) => x.id).filter(ran).map(rec);
      return [rel(join(pt.attempt_dir, 'partitions.json')), ...models, ...pj.contracts.map((k) => k.query_ref), ...pj.composition_conditions.map((k) => k.query_ref), ...execs, 'worklogs/cli-計画.json'];
    }
    default: {
      assert.equal(task.role, 'cause-analyst');
      const s = c.subject;
      assert.equal(s.kind, 'counterexample', 'このテストは反例の原因だけを扱う');
      const cex = result.counterexamples.find((x) => x.id === s.id);
      const chk = result.checks.find((x) => x.id === cex.check_id);
      const m = modelOf(chk.model_id);
      return [...allCopies, ...[cex.check_id, cex.replay.confirmation_id].filter((id) => id && ran(id)).map(rec), m.model, m.mapping];
    }
  }
}
export function assertInputRefs(out, tasks) {
  const runDir = out.status.run_dir;
  assert.ok(tasks.length >= 1);
  const ledger = readJson(join(runDir, 'ledger.json'));
  for (const task of tasks) {
    const refs = task.context.input_refs;
    assert.deepEqual(refs[0], { name: 'request', ref: 'request.json' }, `${task.task_id} の先頭は request.json`);
    assert.deepEqual(refs.slice(1).map((r) => norm(r.ref)).sort(), expectedInputRefs(task, { ...out, runDir }).map(norm).sort(), `${task.task_id}（${task.context.perspective ?? task.role}）の input_refs`);
    for (const r of refs) {
      assert.ok(existsSync(join(runDir, r.ref)), `${r.ref} は実在する（実行していない検査の記録は入れない）`);
      assert.ok(!(r.ref.startsWith('attempts/') && statSync(join(runDir, r.ref)).isDirectory()), `${r.ref}: attempts/ のディレクトリは入れない`);
    }
    // 台帳の input_refs もディレクトリを展開した RefHash（その task が作った記録の entry）
    // 作業記録を含む、その task の全ての entry（artifact-formats「記録台帳」）
    for (const e of ledger.entries.filter((x) => x.producer === task.task_id)) assert.deepEqual(e.input_refs, expandRefs(runDir, refs), `台帳の ${e.ref} の input_refs`);
  }
  for (const c of out.result.confirmations.meaning) {
    const task = tasks.find((x) => x.task_id === c.checker);
    if (task) assert.deepEqual(c.materials, expandRefs(runDir, task.context.input_refs), `${c.item} の materials`);
  }
}

// 時間の上限の run が想定の筋に乗らなかったときの手掛かり: 開いた呼び出し（段と役）と停止の理由
export function timeLimitDiag(result, harness) {
  const calls = harness.memory.calls.map((b) => `${b.callId}[${b.workers.map((x) => `${b.stage}/${x.role}`).join(',')}]`);
  return `開いた呼び出し: ${calls.join(' ')}; 停止の理由: ${JSON.stringify(result.stop_report?.reasons ?? [])}`;
}

// ---- #26: 変異の無い性質の detection（artifact-formats「変異の無い性質の detection」。依頼者の決定） ----
export const NO_MUTATION_CASES = [
  // [名前, alternative]
  ['alternative があり、保証の確認が 成り立つ', '仕様書の読み合わせで検出できることを確かめる'],
  ['alternative が null', null],
];

// ---- #8: 組合せの原因の分類役の unit_id は cause-combination-<model_id>-<n>（artifact-formats「役と context」） ----
export const renameState = (sm, from, to) => JSON.parse(JSON.stringify(sm).split(`"${from}"`).join(`"${to}"`));
export const COMBINATION_CASES = [
  // [名前, 状態遷移, 対応できていない組の位置 n]
  ['日本語の状態名', SM, 1],
  ['空白を含む状態名', renameState(SM, '待ち', 'wait state'), 1],
];

// ---- ディレクトリの ref の展開の並び: UTF-8 のバイト列の辞書順（artifact-formats「ディレクトリの ref の指紋」） ----
// U+FF61（UTF-8 は EF BD A1、UTF-16 は FF61）と U+1F600（UTF-8 は F0 9F 98 80、UTF-16 は D83D DE00）は、2 つの順で前後が入れ替わる
export const HALFWIDTH = '｡';
export const EMOJI = '\u{1F600}';

// ---- goals[].property_id は同じ ModelFile の properties[].id に実在する参照（artifact-formats「状態遷移」の goals） ----
// モデル作成役が目標の性質の id を誤る（persist なら修正の巡の後も直さない）
export const wrongGoal = (persist) => (sm, { round }) => (persist || round === 1 ? { ...sm, goals: sm.goals.map((g) => ({ ...g, property_id: 'P-missing' })) } : sm);
