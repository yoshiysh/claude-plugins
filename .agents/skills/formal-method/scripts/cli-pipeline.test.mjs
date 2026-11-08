// 結合: start から terminal まで、担当の harness と PATH の偽の z3 で通し、結果と記録を観測する。
// 担当の harness は test-fixtures/agent-harness.mjs（受け取った task が契約の形に合わなければ、その違反で失敗する）。
// 正本: SP-FORMALMETHOD-003〜015、artifact-formats.md「結果」「検査の終わり方」、cli-contract.md「Z3 の adapter」。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runScenario, canonicalRequest, SPEC_TEXT } from './test-fixtures/pipeline.mjs';
import { resultInvariants, refInvariants, RESULT_KEYS } from './test-fixtures/result-schema.mjs';
import { fileHash } from './test-fixtures/fabricate.mjs';
import { removeTree } from './test-fixtures/cli-runner.mjs';
import { specAggregate, DEFAULT_FACTS } from './test-fixtures/spec-verdict.mjs';
import { writerMergeScc, stopStageViolations, deriveGraph, crossingEdges, INTERRUPTS } from './test-fixtures/decomposition-check.mjs';

const P = (id, line, over = {}) => ({ id, file: 'spec.md', line, statement: `性質 ${id}`, query: { result: 'unsat' }, sanity: { result: 'sat' }, mutation: { result: 'sat' }, ...over });
const prop = (result, id) => result.properties.find((p) => p.id === id);
const checksOf = (result, p) => p.check_ids.map((id) => result.checks.find((c) => c.id === id));

function assertRecordsConsistent(status, result) {
  const dir = status.run_dir;
  assert.deepEqual(refInvariants(result, (ref) => (existsSync(join(dir, ref)) ? readFileSync(join(dir, ref), 'utf8') : null)), [], '起点が run の領域の Ref が実在する');
  const savedRefs = new Set(result.records.saved.map((s) => s.ref));
  for (const s of result.records.saved) {
    assert.ok(existsSync(join(dir, s.ref)), `saved の ${s.ref} がある`);
    if (s.hash !== null) assert.equal(fileHash(join(dir, s.ref)), s.hash, `${s.ref} の指紋`);
  }
  for (const u of result.records.unsaved) assert.ok(!u.ref || !savedRefs.has(u.ref), `${u.ref} は saved に無い`);
}

// ---- 正準の 完了 のシナリオ（1 ファイル・1 目標・1 性質・1 検査・1 sanity・1 変異） ----
let canonical;
const canonicalRun = async () => {
  if (!canonical) canonical = runScenario(null, {});
  return canonical;
};
after(async () => { if (canonical) { const c = await canonical.catch(() => null); if (c) removeTree(c.ws); } });

test('SP-FORMALMETHOD-015 AC-14 AC-21: 全ての条件が成り立つ依頼は 完了 になり、stop_report は null で、結果は schema に通る', async () => {
  const { result, status } = await canonicalRun();
  assert.deepEqual(resultInvariants(result), []);
  assert.equal(result.status, '完了', JSON.stringify(result.stop_report));
  assert.equal(result.stop_report, null);
  assert.equal(result.provisional, false);
  assert.deepEqual(Object.keys(result).sort(), [...RESULT_KEYS].sort());
  assert.deepEqual(prop(result, 'P1').verdict, ['検証済み']);
  assert.equal(status.action, 'terminal');
  assertRecordsConsistent(status, result);
});

test('SP-FORMALMETHOD-014 AC-13: 完了の run の記録は台帳に参照と指紋で載り、結果のファイルと台帳は saved に hash null で載る', async () => {
  const { result, status } = await canonicalRun();
  const dir = status.run_dir;
  const saved = Object.fromEntries(result.records.saved.map((s) => [s.ref, s]));
  assert.equal(saved['result.json']?.hash, null);
  assert.equal(saved['ledger.json']?.hash, null);
  assert.deepEqual(result.records.unsaved, []);
  const ledger = JSON.parse(readFileSync(join(dir, 'ledger.json'), 'utf8'));
  assert.equal(ledger.registered_result_hash, fileHash(join(dir, 'result.json')));
  for (const e of ledger.entries) assert.equal(fileHash(join(dir, e.ref)), e.hash, `台帳の ${e.ref}`);
  const kinds = new Set(ledger.entries.map((e) => e.kind));
  for (const k of ['request', 'target_snapshot', 'document_rules', 'inventory', 'model', 'mapping', 'plan', 'mutations', 'query', 'execution_evidence', 'worklog']) assert.ok(kinds.has(k), `台帳に ${k}`);
  assert.ok(!ledger.entries.some((e) => e.producer !== 'cli' && e.kind === 'ledger'), '担当は台帳を書かない（PR-BPDESIGNEDSKILL-030）');
});

test('SP-FORMALMETHOD-014 PR-BPDESIGNEDSKILL-028・042: 決定的な処理の作業記録が段ごとにあり、適用した文書の規約の版と不変の写しを指す', async () => {
  const { status } = await canonicalRun();
  const dir = status.run_dir;
  const { readdirSync } = await import('node:fs');
  const logs = readdirSync(join(dir, 'worklogs')).filter((n) => /^cli-.+\.json$/.test(n));
  assert.ok(logs.length >= 1);
  for (const n of logs) {
    const w = JSON.parse(readFileSync(join(dir, 'worklogs', n), 'utf8'));
    assert.equal(w.schema, 'formal-method.worklog/1');
    assert.equal(w.role, 'cli');
    assert.equal(w.task_id, null);
    assert.ok(['受付', '洗い出し', 'モデル化', '計画', '実行', '確認', '集約'].includes(w.stage));
    assert.equal(fileHash(join(dir, w.document_rules.ref)), w.document_rules.version, '規約の写しの指紋が版');
    assert.match(w.document_rules.ref, /^document-rules\/sha256:[0-9a-f]{64}\.md$|^document-rules\/[0-9a-f]{64}\.md$/);
  }
});

test('SP-FORMALMETHOD-001 AC-01: 同じ依頼を 2 回渡すと、verified_scope の対象・版・範囲が一致し、指定していない目標が検証済みに現れない', async (t) => {
  const a = await runScenario(t, {});
  const b = await runScenario(t, {});
  const pick = (r) => ({ targets: r.verified_scope.targets.map(({ id, location, revision, content_hash, files }) => ({ id, location, revision, content_hash, files })), include: r.verified_scope.include, exclude: r.verified_scope.exclude });
  assert.deepEqual(pick(a.result), pick(b.result));
  for (const p of a.result.properties) for (const s of p.sources) if (s.kind === 'goal') assert.equal(s.id, 'G1');
  const t1 = a.result.verified_scope.targets[0];
  assert.equal(t1.revision, null, 'revision を添えない依頼の版は null');
  assert.match(t1.content_hash, /^sha256:[0-9a-f]{64}$/);
  // 集まりの指紋は <FilePath>\0<指紋>\n を FilePath の順につないだ文字列の SHA-256（artifact-formats「版と指紋」）
  const { createHash } = await import('node:crypto');
  const joined = t1.files.map((f) => `${f.path}\0${f.content_hash}\n`).join('');
  assert.equal(t1.content_hash, `sha256:${createHash('sha256').update(joined).digest('hex')}`);
  assert.deepEqual(t1.files.map((f) => f.path), ['spec.md']);
  assert.equal(t1.files[0].content_hash, `sha256:${createHash('sha256').update(SPEC_TEXT).digest('hex')}`);
});

test('SP-FORMALMETHOD-001 AC-01: 範囲から除外した目標は検証済みとして現れない', async (t) => {
  const request = canonicalRequest({
    goals: [{ id: 'G1', text: 'R1 が成り立つ' }, { id: 'G2', text: 'R2 が成り立つ' }],
    scope: { include: [{ kind: 'target', id: 'T1' }, { kind: 'goal', id: 'G1' }], exclude: [{ item: { kind: 'goal', id: 'G2' }, reason: '今回は見ない' }] },
  });
  const { result } = await runScenario(t, { request });
  assert.deepEqual(result.verified_scope.exclude.filter((e) => e.origin === '依頼元'), [{ item: { kind: 'goal', id: 'G2' }, reason: '今回は見ない', origin: '依頼元' }]);
  for (const p of result.properties) {
    if (p.verdict.includes('検証済み')) assert.ok(!p.sources.some((s) => s.kind === 'goal' && s.id === 'G2'), `${p.id} は除外した G2 を出所に持たない`);
  }
});

test('SP-FORMALMETHOD-007 AC-05: 性質ごとに選んだ手法と道具・比較した候補（Rust と Z3 を含む）・理由を示し、見積りが取れない値を 0 にしない', async () => {
  const { result } = await canonicalRun();
  const m = prop(result, 'P1').method;
  assert.ok(m);
  const names = m.candidates.map((c) => `${c.role}:${c.name}`);
  assert.ok(names.some((n) => n.startsWith('実行基盤:') && /rust/i.test(n)), names.join());
  assert.ok(names.some((n) => n.startsWith('検証器:') && /z3/i.test(n)), names.join());
  for (const c of m.candidates) for (const [k, v] of Object.entries(c.estimates)) {
    if ('value' in v) assert.ok(v.value !== 0 || v.unit, `${c.name}.${k}`);
    else assert.ok(['取得できず', '該当なし'].includes(v.status));
  }
});

test('SP-FORMALMETHOD-005・012 AC-04: 意味の確認の記録が、項目の判定・確認した者（task_id）・渡した資料を持ち、決定的な検査と別の配列にある', async () => {
  const { result, harness } = await canonicalRun();
  const taskIds = new Set(harness.memory.tasks.map((t) => t.task_id));
  assert.ok(result.confirmations.meaning.length >= 1);
  for (const c of result.confirmations.meaning) {
    assert.ok(taskIds.has(c.checker), `意味の確認の checker は担当の task_id: ${c.checker}`);
    assert.ok(c.materials.length >= 1, '渡した資料');
  }
  for (const c of result.confirmations.deterministic) assert.equal(c.checker, 'cli');
  assert.ok(result.confirmations.meaning.some((c) => c.kind === 'fidelity' && c.result === '成り立つ'));
  const m = result.models[0];
  assert.deepEqual(m.covers.targets, ['T1']);
  assert.ok(m.covers.assumptions.length >= 1);
  const a = prop(result, 'P1').assurance;
  assert.equal(a.kind, '範囲を限った検査');
  assert.ok(a.bounds.length >= 1);
});

test('cli-contract Z3 の adapter: 道具に渡す option は -in・-T:<秒>・-version だけで、子 process に環境変数を渡さない', async () => {
  const { log } = await canonicalRun();
  const calls = log();
  assert.ok(calls.length >= 1, '道具を呼んだ');
  for (const c of calls) {
    for (const a of c.args) assert.match(a, /^(-in|-version|-T:([1-9]\d*))$/, JSON.stringify(c.args));
    const t = c.args.find((a) => a.startsWith('-T:'));
    if (t) assert.ok(Number(t.slice(3)) <= 600, 'TOOL_TIME_LIMIT_MAX_S 以下');
    assert.ok(!c.env_keys.includes('FM_TEST_MARKER') && !c.env_keys.includes('PATH') && !c.env_keys.includes('HOME'), JSON.stringify(c.env_keys));
  }
});

test('SP-FORMALMETHOD-010 AC-10: 検査ごとに対象の性質・前提・範囲・実行の単位・道具の時間の上限を記録し、内部の上限を結果に出す', async () => {
  const { result, status } = await canonicalRun();
  const [c] = checksOf(result, prop(result, 'P1'));
  assert.equal(c.state, '実行した');
  assert.equal(c.verdict, '成功');
  assert.equal(c.tool_time_limit.seconds, 30);
  assert.ok(c.unit.length > 0 && c.scope.length > 0);
  assert.deepEqual(result.verified_scope.internal_time_limits, { agent_batch_deadline_ms: 1800000, tool_time_limit_max_s: 600, note: '内部の上限' });
  assert.ok(c.evidence_refs.length >= 1);
  for (const ref of c.evidence_refs) assert.ok(existsSync(join(status.run_dir, ref)), `証拠 ${ref} がある`);
});

// ---- AC-09: 成り立つ・反する・判定できない・時間の上限 ----
test('SP-FORMALMETHOD-010・011・015 AC-09: 4 性質の判定が区別され、反例が項目を揃え、独立な検査は最後まで動き、状態は 停止', async (t) => {
  const scenario = { properties: [
    P('P-ok', 2), P('P-cex', 3, { query: { result: 'sat' } }), P('P-unk', 4, { query: { result: 'unknown' } }), P('P-to', 5, { query: { result: 'timeout' } }),
  ] };
  const { result, status } = await runScenario(t, { scenario });
  assert.deepEqual(resultInvariants(result), []);
  assert.equal(result.status, '停止');
  assert.deepEqual(prop(result, 'P-ok').verdict, ['検証済み']);
  assert.deepEqual(prop(result, 'P-cex').verdict, ['反例']);
  assert.deepEqual(prop(result, 'P-unk').verdict, ['unknown']);
  assert.deepEqual(prop(result, 'P-to').verdict, ['時間切れ']);
  assert.equal(checksOf(result, prop(result, 'P-to'))[0].end.time_limit_hit, '道具');
  for (const p of result.properties) for (const c of checksOf(result, p)) assert.equal(c.state, '実行した', `${c.id} は D1 で最後まで動く`);
  const cx = result.counterexamples.filter((x) => x.property_id === 'P-cex');
  assert.equal(cx.length, 1);
  assert.ok(cx[0].sources.length >= 1 && cx[0].input_and_trace && cx[0].violated_condition);
  assert.ok(result.confirmations.deterministic.some((c) => c.id === cx[0].replay.confirmation_id && c.kind === 'replay'));
  assert.ok(existsSync(join(status.run_dir, cx[0].replay.steps_ref)), '再現の手順への参照が実在する');
  assert.ok(result.causes.some((c) => c.subject.kind === 'counterexample' && c.subject.id === cx[0].id));
  const codes = result.stop_report.reasons.map((r) => r.code);
  assert.ok(codes.includes('反例') && codes.includes('必要な性質が検証の成功でない'), codes.join());
});

test('SP-FORMALMETHOD-011 AC-09 外からの照合: 検査が 1 件以上ある性質の判定の集合が、check_ids の検査の判定に集約の規則を当て直した値と一致する（confirmations は入れない）', async (t) => {
  const scenario = { properties: [P('A', 2), P('B', 3, { query: { result: 'sat' } }), P('C', 4, { query: { mode: 'crash' } }), P('D', 5, { query: { result: 'unknown' } })] };
  const { result } = await runScenario(t, { scenario });
  for (const p of result.properties) {
    const cvs = checksOf(result, p).map((c) => c.verdict);
    if (cvs.length === 0) continue;
    if (cvs.some((v) => v !== '成功')) {
      assert.deepEqual(p.verdict, specAggregate({ ...DEFAULT_FACTS, check_verdicts: cvs }), p.id);
    } else {
      assert.ok(p.verdict.length === 1 && ['検証済み', '未確認'].includes(p.verdict[0]), `${p.id}: 全て成功なら 検証済み か 未確認`);
    }
  }
});

test('SP-FORMALMETHOD-012 AC-09: 常に成功を返す道具では、変異の検出が 検出せず になり、性質は検証の成功にならない', async (t) => {
  const { result } = await runScenario(t, { tool: 'always-unsat' });
  const p = prop(result, 'P1');
  assert.equal(p.detection.status, '検出せず');
  assert.ok(p.detection.mutations.length >= 1);
  for (const m of p.detection.mutations) assert.equal(m.detected, false);
  assert.ok(!p.verdict.includes('検証済み'));
  assert.equal(result.status, '停止');
});

// ---- AC-05: 道具の失敗 ----
// [名前, 道具, query の指示, 期待の検査の判定, 期待の End の一部]
const TOOL_CASES = [
  ['答えとしての unknown', 'fake', { result: 'unknown' }, 'unknown', { tool_result: '判定できない', abnormal_exit: false, unreadable_output: false }],
  ['道具自身の時間の上限（timeout）', 'fake', { result: 'timeout' }, '時間切れ', { tool_result: '判定できない', time_limit_hit: '道具' }],
  ['-T を超える応答の遅れ', 'fake', { sleepMs: 5000 }, '時間切れ', { tool_result: '判定できない', time_limit_hit: '道具' }],
  ['異常終了（出力なし、終了コード 3）', 'fake', { mode: 'crash' }, '実行失敗', { tool_result: 'なし', abnormal_exit: true, unreadable_output: false, stopped_by: null }],
  ['メモリ不足（標準エラーに (error "out of memory")、終了コード 101）', 'fake', { mode: 'oom' }, '実行失敗', { tool_result: 'なし', abnormal_exit: true, stopped_by: null }],
  ['構文の誤り（標準出力に (error …)、終了コード 1）', 'fake', { mode: 'syntax-error' }, '実行失敗', { tool_result: '判定以外のエラー', abnormal_exit: false, unreadable_output: false }],
  ['読めない出力（知らない 1 行）', 'fake', { result: 'maybe' }, '実行失敗', { tool_result: 'なし', unreadable_output: true, abnormal_exit: false }],
  ['読めない出力（空）', 'fake', { mode: 'empty' }, '実行失敗', { tool_result: 'なし', unreadable_output: true, abnormal_exit: false }],
  ['読めない出力（2 行）', 'fake', { mode: 'multi' }, '実行失敗', { tool_result: 'なし', unreadable_output: true, abnormal_exit: false }],
];
for (const [name, tool, query, verdict, end] of TOOL_CASES) {
  test(`SP-FORMALMETHOD-007・011 AC-05: ${name} は検査の判定 ${verdict} になり、性質は成功にならず、状態は 停止`, async (t) => {
    const scenario = { toolTimeLimit: 2, properties: [P('P1', 2, { query })] };
    const { result } = await runScenario(t, { scenario, tool });
    const p = prop(result, 'P1');
    const [c] = checksOf(result, p);
    assert.equal(c.verdict, verdict);
    for (const [k, v] of Object.entries(end)) assert.equal(c.end[k], v, `end.${k}`);
    assert.ok(p.verdict.includes(verdict));
    assert.equal(result.status, '停止');
  });
}

test('SP-FORMALMETHOD-007 AC-05: 実行環境から道具を除くと、その道具を要る性質は 未実行 で理由を持ち、状態は 停止', async (t) => {
  const { result } = await runScenario(t, { tool: 'absent' });
  const p = prop(result, 'P1');
  assert.deepEqual(p.verdict, ['未実行']);
  assert.ok(p.reason.length > 0);
  assert.equal(result.status, '停止');
  assert.ok(result.stop_report.reasons.some((r) => r.code === '実行できない検査'));
});

// ---- AC-14: 1 つずつ残すと 停止 ----
const RESIDUE_CASES = [
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
for (const [name, scenario, tool, check] of RESIDUE_CASES) {
  test(`SP-FORMALMETHOD-015 AC-14: 必要な性質に ${name} を 1 つ残すと 停止 になり、停止の報告を持つ`, async (t) => {
    const { result } = await runScenario(t, { scenario, tool });
    assert.deepEqual(resultInvariants(result), []);
    assert.equal(result.status, '停止');
    assert.ok(result.stop_report);
    assert.deepEqual(stopStageViolations(result), []);
    check(prop(result, 'P1'), result);
  });
}

// ---- AC-08: 要求の不足と問い ----
test('SP-FORMALMETHOD-011 AC-08: 原因が 要求の不足 の反例は、問い（不足・影響先・選択肢）を返し、問いに依存する性質は成功にならない', async (t) => {
  const question = { id: 'Q1', missing_decision: 'y が x と等しいときの扱い', affected: ['P1'], options: ['許す', '許さない'] };
  const scenario = { properties: [P('P1', 3, { query: { result: 'sat' } })], cause: { cause: '要求の不足', grounds: 'R2 は等しい場合を定めない', questions: [question] } };
  const { result } = await runScenario(t, { scenario });
  assert.ok(result.causes.some((c) => c.cause === '要求の不足'));
  const q = result.questions.find((x) => x.missing_decision === question.missing_decision);
  assert.ok(q, JSON.stringify(result.questions));
  assert.ok(q.affected.length >= 1 && q.options.length >= 2);
  const p = prop(result, 'P1');
  assert.ok(!p.verdict.includes('検証済み'));
  assert.equal(result.status, '停止');
  assert.ok(result.stop_report.questions.includes(q.id));
});

test('SP-FORMALMETHOD-011 AC-08: 原因が 対象が性質を満たさない の反例は、根拠と分類した担当を持ち、問いを作らない', async (t) => {
  const { result, harness } = await runScenario(t, { scenario: { properties: [P('P1', 3, { query: { result: 'sat' } })] } });
  const c = result.causes.find((x) => x.subject.kind === 'counterexample');
  assert.equal(c.cause, '対象が性質を満たさない');
  assert.ok(c.grounds.length > 0);
  assert.ok(harness.memory.tasks.some((t2) => t2.task_id === c.classified_by && t2.role === 'cause-analyst'));
  assert.deepEqual(result.questions, []);
});

// ---- AC-19: 段の分かっている処理で失敗を起こす ----
// 担当の失敗（返り値が無い・形が違う・cannot_proceed）は、停止の理由 担当の失敗 を、その task の context.stage で記録する。
// 中断の理由ではないので run は先へ進み、stop_report.stage は最も上流の段（＝失敗した処理の段）になる。
const AGENT_FAIL = [['extractor', ['inventory']], ['model-author', ['model', 'mapping']], ['plan-author', ['plan', 'mutations']]];
const AGENT_MODES = [['返り値が無い', 'missing'], ['返り値の形が違う', 'bad_shape'], ['cannot_proceed を返す', 'cannot_proceed']];
for (const [role, kinds] of AGENT_FAIL) {
  for (const [name, mode] of AGENT_MODES) {
    test(`SP-FORMALMETHOD-015 AC-19 担当の失敗: ${role} が${name}と、担当の失敗 がその task の context.stage で記録され、stop_report.stage がその段になり、成果物は未作成`, async (t) => {
      const { result, status, harness } = await runScenario(t, { scenario: { returns: { [role]: mode } } });
      const failed = harness.memory.tasks.filter((x) => x.role === role);
      assert.ok(failed.length >= 1, `${role} の task が出る`);
      const stage = failed[0].context.stage;
      assert.deepEqual(resultInvariants(result), []);
      assert.equal(result.status, '停止');
      const reasons = result.stop_report.reasons;
      assert.ok(reasons.some((x) => x.code === '担当の失敗' && x.stage === stage), JSON.stringify(reasons));
      assert.ok(!reasons.some((x) => INTERRUPTS.includes(x.code)), '担当の失敗だけでは中断の理由を入れない');
      assert.equal(result.stop_report.stage, stage);
      assert.deepEqual(stopStageViolations(result), []);
      const notCreated = result.stop_report.artifacts_not_created.map((x) => x.kind);
      for (const k of kinds) assert.ok(notCreated.includes(k), `${k} は未作成: ${notCreated.join()}`);
      const created = result.stop_report.artifacts_created.map((x) => x.ref);
      for (const tk of failed) assert.ok(!created.some((r) => r.startsWith(`attempts/${tk.task_id}/`) && !r.endsWith('worklog.json')), '失敗した担当の成果物を生成済みに数えない');
      const log = join(status.run_dir, 'worklogs', `cli-${stage}.json`);
      assert.ok(existsSync(log), `worklogs/cli-${stage}.json がある`);
    });
  }
}

// 担当の失敗 以外で、段が契約で決まる処理の失敗。
const STAGE_CASES = [
  ['道具の実行が実行失敗で終わる（実行できない検査は 実行）', { properties: [P('P1', 2, { query: { mode: 'crash' } })] }, 'fake', '実行'],
  ['道具が無い（実行できない検査は 計画）', {}, 'absent', '計画'],
  ['反例（反例は 実行）', { properties: [P('P1', 2, { query: { result: 'sat' } })] }, 'fake', '実行'],
  ['忠実さの確認が成り立たない（集約の条件だけ）', { reviews: { fidelity: '成り立たない' } }, 'fake', '集約'],
];
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

// ---- AC-03: 状態遷移の組合せと図 ----
const SM = {
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


// ---- AC-06: 依存グラフの箇所（T の独立の照合。候補の導き直しは criteria の文法が契約に無いので行わない） ----
function topLevelForms(text) {
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
function resolvePointer(doc, pointer) {
  if (pointer === '') return doc;
  return pointer.split('/').slice(1).map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~')).reduce((o, k) => (o == null ? undefined : o[k]), doc);
}

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
      assert.ok(Number(m[1]) >= 1 && Number(m[1]) <= forms.length, `${x.location.pointer} は ${forms.length} 個の S 式の中`);
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
  assert.ok(result.confirmations.deterministic.some((c) => c.kind === 'sanity' && c.property_ids.includes('P1') && c.model_property_id === 'P1' && c.result === '成り立たない'));
  assert.equal(result.status, '停止');
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

// ---- AC-12: 性能の比較の条件 ----
const CLAIM_CASES = [
  ['条件が一致する比較は 一致を確認 で、主張を残す', 'match', '一致を確認', true],
  ['範囲と保証の違う比較は 一致を確認できず で、主張を null にする', 'mismatch', '一致を確認できず', false],
];
for (const [name, claim, expected, kept] of CLAIM_CASES) {
  test(`SP-FORMALMETHOD-013 AC-12: ${name}`, async (t) => {
    const { result } = await runScenario(t, { scenario: { claim } });
    const m = prop(result, 'P1').method;
    const cc = m.comparison_conditions.find((c) => c.compared.includes('Z3') && c.compared.includes('Rust'));
    assert.ok(cc, JSON.stringify(m.comparison_conditions));
    assert.equal(cc.result, expected);
    if (claim === 'mismatch') assert.equal(cc.matches.scope && cc.matches.assurance, false);
    else assert.ok(Object.values(cc.matches).every(Boolean));
    const z3 = m.candidates.find((c) => c.name === 'Z3');
    assert.equal(z3.performance_claim !== null, kept);
    assert.deepEqual(resultInvariants(result), []);
  });
}

// ---- AC-06: 依存グラフと候補の導き直し ----
// 返された形式モデル（models[].ref の model.json と、その query の .smt2）から、依存グラフの導出の規則で T が導き直す。
function rederive(status, result) {
  const dir = status.run_dir;
  const read = (r) => (existsSync(join(dir, r)) ? readFileSync(join(dir, r), 'utf8') : null);
  return deriveGraph(result.models.map((m) => ({ model: JSON.parse(read(m.ref)), ref: m.ref })), read);
}
function assertGraphMatches(status, result) {
  const mine = rederive(status, result);
  const g = result.decomposition.graph;
  assert.deepEqual(refInvariants(result, (ref) => (existsSync(join(status.run_dir, ref)) ? readFileSync(join(status.run_dir, ref), 'utf8') : null)), [], 'Ref とモデルの中の名前が実在する');
  assert.deepEqual(g.nodes, mine.nodes, '要素（id・kind・location・並び）');
  assert.deepEqual(g.edges, mine.edges, '辺（id・from・to・kind・location・並び）');
  assert.deepEqual(g.unconfirmed.map((u) => u.relation), mine.unconfirmed.map((u) => u.relation), '未確認の関係');
  return mine;
}

const SM2 = {
  states: ['s0'], events: ['ea', 'eb'], initial: 's0',
  variables: [{ id: 'a', sort: 'Int', domain: '0..3', init: '0' }, { id: 'b', sort: 'Int', domain: '0..3', init: '0' }],
  transitions: [
    { id: 'ta', from: 's0', event: 'ea', to: 's0', guard: '(< a 3)', updates: [{ var: 'a', term: '(+ a 1)' }], unchanged: ['b'], source_ids: ['E-P1'] },
    { id: 'tb', from: 's0', event: 'eb', to: 's0', guard: '(and (>= a 0) (< b 3))', updates: [{ var: 'b', term: '(+ b 1)' }], unchanged: ['a'], source_ids: ['E-P1'] },
  ],
  forbidden: [], uncovered: [], goals: [],
};
const SM2_SMT = '(declare-const a Int)\n(declare-const b Int)\n(assert (and (>= a 0) (>= b 0)))\n(assert (not (>= (+ a b) 0)))';
const SM2_PROPS = [{ id: 'P1', file: 'spec.md', line: 2, statement: 'a と b の和は 0 以上', query: { result: 'unsat' }, sanity: { result: 'sat' }, mutation: { result: 'sat' }, smt: SM2_SMT }];

test('SP-FORMALMETHOD-008 AC-06 analysis: 返されたモデルから依存グラフを導出の規則で導き直すと返された graph と一致し、writer-merge-scc/1 を当て直すと candidates と一致する（正準のシナリオ）', async () => {
  const { result, status } = await canonicalRun();
  assertGraphMatches(status, result);
  const d = result.decomposition;
  assert.deepEqual(d.criteria, { algorithm: 'writer-merge-scc/1' });
  assert.deepEqual(d.candidates, writerMergeScc(d.graph));
});

test('SP-FORMALMETHOD-008・009 AC-06・AC-07: 書き手の違う 2 つの組を持つモデルで、候補を導き直すと一致し、分割作成役は同じ候補を受け取る', async (t) => {
  const { result, harness, status } = await runScenario(t, { scenario: { stateMachine: SM2, properties: SM2_PROPS } });
  assertGraphMatches(status, result);
  const d = result.decomposition;
  const mine = writerMergeScc(d.graph);
  assert.deepEqual(d.candidates, mine);
  assert.ok(mine.length >= 2, `候補が 2 つ以上: ${JSON.stringify(mine)}`);
  const pt = harness.memory.tasks.find((x) => x.role === 'partition-author');
  assert.ok(pt, '候補が 2 つ以上なら分割作成役が出る');
  assert.deepEqual(pt.context.candidates, mine.map(({ id, nodes }) => ({ id, nodes })));
  assert.deepEqual(d.decisions.map((x) => x.candidate_id).sort(), mine.map((c) => c.id).sort());
  if (!d.adopted) for (const p of result.properties) assert.ok(!p.verdict.includes('検証済み') || d.parts.length === 0, '候補だけで独立に検証できると示さない');
});

// ---- AC-07: 境界の契約と合成 ----
// 部分を跨ぐ辺ごとに境界を 1 つ置き、その前提を 確認できない前提 にする（edge_id は規則の辺の id）。
// parts の要素は graph の要素の id で書き、1 つの部分は 1 つのモデル（model_id）に属する
const PARTS = [{ id: 'part-a', model_id: 'M1', owns_variables: ['var:M1/a'], transitions: ['tr:M1/ta'] }, { id: 'part-b', model_id: 'M1', owns_variables: ['var:M1/b'], transitions: ['tr:M1/tb'] }];
const partitionWithUnconfirmedAssumption = (_cands, put, { crossing }) => ({
  parts: PARTS,
  boundaries: crossing(PARTS).map((e) => ({
    edge_id: e.id, producer: 'part-a', consumer: 'part-b', shared_symbols: [e.to.replace(/^var:M1\//, '')], assumption: 'a は 0 以上', guarantee: 'a は 0 以上',
    assumption_basis: { kind: '確認できない前提', reason: '環境が a を 0 以上に保つという前提が依頼に無い' }, responsible: ['K-a'],
  })),
  contracts: [{ id: 'K-a', model_id: 'M1', derived_from: 'P1', part_id: 'part-a', statement: 'a は 0 以上', query_ref: put('K-a.smt2', '; fake-result: unsat\n(declare-const a Int)\n(assert (< a 0))\n(check-sat)\n') }],
  composition_conditions: [{ id: 'CC1', model_id: 'M1', statement: 'K-a ならば P1', query_ref: put('CC1.smt2', '; fake-result: unsat\n(declare-const a Int)\n(assert (< a 0))\n(check-sat)\n'), depends_on: ['K-a'] }],
});

test('SP-FORMALMETHOD-009 AC-07 analysis: 部分の前提を確認できない分割では全体の性質が検証済みにならず、跨ぐ辺ごとに境界があり、分割前の要素は規則の id で対応・対応なし・除外のちょうど 1 つに入る', async (t) => {
  const { result, status } = await runScenario(t, { scenario: { stateMachine: SM2, properties: SM2_PROPS, partition: partitionWithUnconfirmedAssumption } });
  const d = result.decomposition;
  const mine = assertGraphMatches(status, result);
  assert.equal(d.adopted, true, d.reason);
  // 跨ぐ辺: T が導いたグラフで、部分の持つ変数・遷移（var:・tr:）の間を跨ぐ辺。境界は跨ぐ辺ごとに 1 つ
  const cross = crossingEdges(mine, d.parts).map((e) => e.id).sort();
  for (const p of d.parts) assert.equal(p.model_id, 'M1');
  for (const k of d.contracts) assert.equal(k.model_id, 'M1');
  for (const c of result.checks.filter((x) => x.kind === 'composition')) assert.equal(c.model_id, 'M1', '合成の条件の検査の model_id は合成の条件の model_id');
  assert.ok(cross.includes('read:tr:M1/tb->var:M1/a'), cross.join());
  assert.deepEqual(d.boundaries.map((b) => b.edge_id).sort(), cross);
  for (const b of d.boundaries) assert.ok(b.responsible.length >= 1, '境界ごとに責任を負う契約か検査');
  assert.ok(d.boundaries.some((b) => b.assumption_basis.kind === '確認できない前提'));
  assert.ok(d.composition_conditions.length >= 1);
  for (const p of result.properties) assert.ok(!p.verdict.includes('検証済み'), `${p.id} は確認できない前提の分割で検証済みにならない`);
  assert.equal(result.status, '停止');
  // T の独立の照合: 変数・遷移の要素（規則の id）は、対応・対応なし・除外のちょうど 1 つに入る
  const elems = mine.nodes.filter((n) => n.kind === 'variable' || n.kind === 'transition').map((n) => n.id);
  assert.deepEqual(elems, ['tr:M1/ta', 'tr:M1/tb', 'var:M1/a', 'var:M1/b']);
  const buckets = [d.correspondence.matched.map((m) => m.element), d.correspondence.unmatched, d.correspondence.excluded.map((e) => e.element)];
  for (const e of elems) assert.equal(buckets.filter((b) => b.includes(e)).length, 1, `${e} の対応`);
  // 部分が持つ要素は 対応なし にならず、対応の先に自分の部分を持つ
  const ownerOf = { 'var:M1/a': 'part-a', 'tr:M1/ta': 'part-a', 'var:M1/b': 'part-b', 'tr:M1/tb': 'part-b' };
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
  const out = await runScenario(t, { request: canonicalRequest({ time_limit_seconds: 1 }) });
  const r = out.result;
  assert.equal(r.status, '停止');
  assert.ok(!r.stop_report.reasons.some((x) => x.request_code === 'time_limit_invalid'));
  assert.ok(r.stop_report.reasons.some((x) => x.code === '時間の上限'), JSON.stringify(r.stop_report.reasons));
  assert.deepEqual(stopStageViolations(r), []);
  for (const c of r.checks) assert.ok(c.verdict === '未実行' || c.verdict === '時間切れ', `${c.id}: ${c.verdict}`);
  // 残す時間は min(60 秒, 上限の 1/4) = 0.25 秒。期限（開始から 0.75 秒）の後に道具を始めない
  for (const e of out.log().filter((x) => x.kind === 'query-start')) assert.ok(e.at_ms <= started + 750 + 2000, '期限の後に道具を始めない');
  for (const b of out.harness.memory.batches) assert.ok(b.deadline_wall_ms <= started + 750 + 3000, '担当の batch の期限は run の期限 − 残す時間（起動の遅れを 3 秒まで見込む）');
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
  for (const c of sanity) { assert.deepEqual(c.property_ids, ['P1']); assert.equal(c.model_property_id, 'MP-P1'); assert.equal(c.plan_id, 'S-MP-P1', '計画の sanity の id は plan_id に残る'); assert.match(c.id, /^confirm-sanity-\d+$/); }
  for (const c of result.confirmations.deterministic.filter((x) => x.kind === 'mutation')) { assert.equal(c.model_property_id, 'MP-P1'); assert.equal(c.plan_id, 'MU-MP-P1'); }
  for (const m of prop(result, 'P1').detection.mutations) { assert.equal(m.id, 'MU-MP-P1'); assert.match(m.confirmation_id, /^confirm-mutation-\d+$/); }
  for (const c of result.confirmations.meaning.filter((x) => x.kind === 'assurance')) assert.equal(c.model_property_id, 'MP-P1');
  assert.ok(result.decomposition.graph.nodes.some((n) => n.id === 'prop:M1/MP-P1'), 'graph の性質はモデルの性質の id');
  assert.ok(!result.decomposition.graph.nodes.some((n) => n.id === 'prop:M1/P1'));
  assert.equal(prop(result, 'P1').detection.status, '検出を確認');
  assertGraphMatches(status, result);
});

test('artifact-formats 性質の id の名前空間 AC-14: 変異を用意できない性質の unavailable は inventory の id で、その性質は 検出能力未確認', async (t) => {
  const { result } = await runScenario(t, { scenario: { modelPropPrefix: 'MP-', properties: [P('P1', 2, { mutation: null })] } });
  assert.equal(prop(result, 'P1').detection.status, '検出能力未確認');
  assert.equal(result.status, '停止');
});

const SM_A = { states: ['s0'], events: ['e'], initial: 's0', variables: [{ id: 'a', sort: 'Int', domain: '0..3', init: '0' }],
  transitions: [{ id: 't', from: 's0', event: 'e', to: 's0', guard: '(< a 3)', updates: [{ var: 'a', term: '(+ a 1)' }], unchanged: [], source_ids: ['E-P1'] }],
  forbidden: [], uncovered: [], goals: [] };
const SMT_A = '(declare-const a Int)\n(assert (>= a 0))\n(assert (not (>= (+ a 1) 0)))';

test('SP-FORMALMETHOD-005・008 AC-06: モデルが 2 つのとき、graph は両方の要素を model_id で分けて持ち、導き直しと一致し、property の辺は同じモデルの変数にだけ引く', async (t) => {
  const scenario = {
    modelPropPrefix: 'MP-',
    properties: [P('P1', 2, { smt: SMT_A }), P('P2', 3, { smt: SMT_A })],
    models: [{ id: 'M1', propertyIds: ['P1'], stateMachine: SM_A }, { id: 'M2', propertyIds: ['P2'], stateMachine: { ...SM_A, transitions: SM_A.transitions.map((x) => ({ ...x, source_ids: ['E-P2'] })) } }],
  };
  const { result, status } = await runScenario(t, { scenario });
  assert.deepEqual(resultInvariants(result), []);
  assert.deepEqual(result.models.map((m) => m.id).sort(), ['M1', 'M2']);
  const mine = assertGraphMatches(status, result);
  const ids = mine.nodes.map((n) => n.id);
  for (const id of ['var:M1/a', 'var:M2/a', 'tr:M1/t', 'tr:M2/t', 'prop:M1/MP-P1', 'prop:M2/MP-P2']) assert.ok(ids.includes(id), id);
  for (const e of result.decomposition.graph.edges.filter((x) => x.kind === 'property')) {
    assert.equal(e.from.split('/')[0].replace(/^prop:/, ''), e.to.split('/')[0].replace(/^var:/, ''), `${e.id} は同じモデルの変数への辺`);
  }
  for (const m of result.models) {
    const fileOfModel = result.decomposition.graph.nodes.filter((n) => n.id.startsWith(`var:${m.id}/`) || n.id.startsWith(`tr:${m.id}/`) || n.id.startsWith(`prop:${m.id}/`)).map((n) => n.location.file);
    assert.ok(fileOfModel.every((f) => f === m.ref), `${m.id} の状態遷移と性質の要素の location.file は models[].ref`);
  }
  assert.deepEqual(result.decomposition.candidates, writerMergeScc(result.decomposition.graph));
  for (const p of ['P1', 'P2']) assert.deepEqual(prop(result, p).verdict, ['検証済み'], p);
  for (const c of result.checks) assert.ok(['M1', 'M2'].includes(c.model_id));
});
