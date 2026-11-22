// 結合: start から terminal まで、担当の harness と PATH の偽の z3 で通し、結果と記録を観測する。
// 担当の harness は test-fixtures/agent-harness.mjs（受け取った task が契約の形に合わなければ、その違反で失敗する）。
// 正本: SP-FORMALMETHOD-003〜015、artifact-formats.md「結果」「検査の終わり方」、cli-contract.md「Z3 の adapter」。
// このファイルは完了の run・道具の失敗・残った性質・担当の失敗・受け箱と close。ファイルを分けて並列に走らせ、共有の道具は test-fixtures/pipeline-cases.mjs に置く。
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { runScenario, canonicalRequest, SPEC_TEXT } from './test-fixtures/pipeline.mjs';
import { resultInvariants, RESULT_KEYS } from './test-fixtures/result-schema.mjs';
import { fileHash } from './test-fixtures/fabricate.mjs';
import { skipIfRoot } from './test-fixtures/cli-runner.mjs';
import { specAggregate, DEFAULT_FACTS } from './test-fixtures/spec-verdict.mjs';
import { stopStageViolations, INTERRUPTS } from './test-fixtures/decomposition-check.mjs';
import { ledgerEntryViolations, tasksById, AGENT_PERMISSIONS_CONTRACT, LEDGER_ENTRY_KEYS } from './test-fixtures/ledger-check.mjs';
import { P, prop, checksOf, inputOf, callsFor, assertRecordsConsistent, canonicalRun, TOOL_CASES, RESIDUE_CASES, AGENT_FAIL, AGENT_MODES, firstCallWith, assertAcceptedKept, CLOSE_CASES } from './test-fixtures/pipeline-cases.mjs';

describe('cli-pipeline', { concurrency: 4 }, () => {
test('SP-FORMALMETHOD-015 AC-14 AC-21: 全ての条件が成り立つ依頼は 完了 になり、stop_report は null で、結果は schema に通る', async () => {
  const { result, status, harness } = await canonicalRun();
  assert.deepEqual(resultInvariants(result), []);
  assert.equal(result.status, '完了', JSON.stringify(result.stop_report));
  assert.equal(result.stop_report, null);
  assert.equal(result.provisional, false);
  assert.deepEqual(Object.keys(result).sort(), [...RESULT_KEYS].sort());
  assert.deepEqual(prop(result, 'P1').verdict, ['検証済み']);
  assert.equal(status.action, 'terminal');
  assertRecordsConsistent(status, result, harness);
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
  assert.ok(!ledger.entries.some((e) => e.producer !== 'cli' && e.kind === 'ledger'), '担当は台帳を書かない（PR-BPDESIGNEDSKILL-029: 担当は共有の記録台帳へ直接書き込まない）');
});

test('artifact-formats 記録台帳 SP-FORMALMETHOD-014: 完了の run の台帳の全ての entry が 9 欄を持ち、担当の entry は tasks.json の model・effort と AGENT_PERMISSIONS、cli の entry は null・null・[]', async () => {
  const { status, harness } = await canonicalRun();
  const dir = status.run_dir;
  const ledger = JSON.parse(readFileSync(join(dir, 'ledger.json'), 'utf8'));
  const tasks = tasksById(dir);
  assert.ok(tasks.size >= 1 && harness.memory.tasks.every((x) => tasks.has(x.task_id)), 'harness が受けた task は tasks.json にある');
  assert.deepEqual(ledgerEntryViolations(ledger, tasks, dir), [], '欄・producer ごとの値・担当の entry の input_refs（作業記録を含む）・cli の entry の input_refs []');
  assert.ok(ledger.entries.some((e) => e.producer === 'cli'), 'cli の entry がある');
  assert.ok(ledger.entries.some((e) => tasks.has(e.producer)), '担当の entry がある（担当の成果物・作業記録）');
});

test('記録台帳の検査の自己検査: 欄の欠け・cli の権限・担当の model の違い・知らない producer を拒み、契約どおりの entry を受ける', () => {
  const tasks = new Map([['t1', { task_id: 't1', model: 'm-high', effort: 'high' }]]);
  const base = { kind: 'worklog', ref: 'worklogs/cli-受付.json', hash: `sha256:${'0'.repeat(64)}`, stage: '受付', input_refs: [] };
  const cliE = { ...base, producer: 'cli', model: null, effort: null, permissions: [] };
  const agentE = { ...base, producer: 't1', model: 'm-high', effort: 'high', permissions: [...AGENT_PERMISSIONS_CONTRACT] };
  const ok = (es) => ledgerEntryViolations({ entries: es }, tasks);
  assert.deepEqual(ok([cliE, agentE, { ...cliE, producer: 'salvage' }]), []);
  for (const k of LEDGER_ENTRY_KEYS) { const e = { ...cliE }; delete e[k]; assert.equal(ok([e]).length, 1, `${k} の欠け`); }
  assert.equal(ok([{ ...cliE, permissions: ['fresh-thread'] }]).length, 1);
  assert.equal(ok([{ ...cliE, model: 'm' }]).length, 1);
  assert.equal(ok([{ ...cliE, producer: 'salvage', effort: 'high' }]).length, 1, 'salvage の effort は null');
  assert.equal(ok([{ ...cliE, input_refs: [{ ref: 'request.json', hash: base.hash }] }]).length, 1, 'cli の input_refs は []');
  assert.equal(ledgerEntryViolations({}, tasks).length, 1, 'entries の無い台帳');
  assert.deepEqual(ledgerEntryViolations({ entries: [] }, tasks), [], '空の entries は許す');
  assert.equal(ok([{ ...agentE, model: 'm-low' }]).length, 1);
  assert.equal(ok([{ ...agentE, effort: 'low' }]).length, 1);
  assert.equal(ok([{ ...agentE, permissions: ['workspace-write', 'fresh-thread'] }]).length, 1, '順の違い');
  assert.equal(ok([{ ...agentE, producer: 't9' }]).length, 1);
});

test('SP-FORMALMETHOD-014 PR-BPDESIGNEDSKILL-028・040: 決定的な処理の作業記録が段ごとにあり、適用した文書の規約の版と不変の写しを指す', async () => {
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

test('cli-contract Z3 の adapter: 道具に渡す option は -in・-T:<秒>・-model・-version だけで、-model は性質の検査にだけ渡し、子 process に環境変数を渡さない', async () => {
  const { log, result, status } = await canonicalRun();
  const calls = log();
  assert.ok(calls.length >= 1, '道具を呼んだ');
  // 正準のシナリオの実行は、性質の検査・sanity・変異・静的な確認の否定だけの実行（反例が無いので replay は無く、前提の節が無いので
  // 前提と否定だけ・規則と否定だけの実行も無い）。checks/<execution_id>/input.smt2 で呼出しを引く
  const execs = [...result.checks.map((c) => [c.id, c.kind]), ...result.confirmations.deterministic.filter((c) => c.end?.started).map((c) => [c.id, c.kind])];
  assert.deepEqual([...new Set(execs.map(([, k]) => k))].sort(), ['goal_trivial', 'mutation', 'property', 'sanity']);
  for (const [id, kind] of execs) {
    const cs = callsFor(calls, inputOf(status.run_dir, id));
    assert.ok(cs.length >= 1, `${kind} ${id} の input.smt2 で道具を呼ぶ`);
    for (const c of cs) assert.equal(c.args.includes('-model'), kind === 'property', `${kind} の引数 ${JSON.stringify(c.args)}`);
  }
  for (const c of calls) {
    for (const a of c.args) assert.match(a, /^(-in|-version|-model|-T:([1-9]\d*))$/, JSON.stringify(c.args));
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
  // 偽の z3 は -model の sat の後に実測の形のモデルを出すので、証人から replay の query を作って実行し、反例を再現する（cli-contract「証人」）
  const replay = result.confirmations.deterministic.find((c) => c.id === cx[0].replay.confirmation_id);
  assert.equal(replay.result, '成り立つ', replay.reason);
  assert.equal(replay.end.started, true);
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
  // 性質の否定だけの query にも unsat を返すので、静的な確認は性質が自明だと示す（SP-FORMALMETHOD-012 AC-22）
  assert.equal(result.confirmations.deterministic.find((c) => c.kind === 'goal_trivial')?.result, '成り立たない');
});
for (const [name, tool, query, verdict, end] of TOOL_CASES) {
  test(`SP-FORMALMETHOD-007・011 AC-05: ${name} は検査の判定 ${verdict} になり、性質は成功にならず、状態は 停止`, async (t) => {
    const scenario = { toolTimeLimit: 2, properties: [P('P1', 2, { query })] };
    const { result, log } = await runScenario(t, { scenario, tool });
    const p = prop(result, 'P1');
    const [c] = checksOf(result, p);
    assert.equal(c.verdict, verdict);
    if (query.result === 'unknown') assert.ok(log().some((e) => e.kind === 'query-end' && e.model === 'real'), '偽の z3 が unknown の後にモデルを出した');
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
for (const [name, mode, role, over, scenario = {}] of CLOSE_CASES) {
  test(`cli-contract 受け箱 SP-FORMALMETHOD-015 AC-19: ${name}でも、その呼び出しで submit が受理した担当は捨てられず（担当の失敗 にならず成果物・確認・原因が残る）、起動の記録を残せないことは作業記録の unconfirmed に残る`, async (t) => {
    const pick = firstCallWith(role);
    const out = await runScenario(t, { request: canonicalRequest(over), scenario, hooks: { close: (s, call) => (pick(s, call) ? mode : null) } });
    const call = assertAcceptedKept(out, mode);
    assert.ok(call.workers.some((x) => x.role === role), `${role} の呼び出しに当てた`);
  });
}
});
