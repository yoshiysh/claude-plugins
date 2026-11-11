// 結合: start から terminal まで、担当の harness と PATH の偽の z3 で通し、結果と記録を観測する。
// 担当の harness は test-fixtures/agent-harness.mjs（受け取った task が契約の形に合わなければ、その違反で失敗する）。
// 正本: SP-FORMALMETHOD-003〜015、artifact-formats.md「結果」「検査の終わり方」、cli-contract.md「Z3 の adapter」。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative, posix } from 'node:path';
import { runScenario, canonicalRequest, SPEC_TEXT } from './test-fixtures/pipeline.mjs';
import { resultInvariants, refInvariants, RESULT_KEYS } from './test-fixtures/result-schema.mjs';
import { fileHash } from './test-fixtures/fabricate.mjs';
import { removeTree, skipIfRoot } from './test-fixtures/cli-runner.mjs';
import { specAggregate, DEFAULT_FACTS } from './test-fixtures/spec-verdict.mjs';
import { SM2, SM2_PROPS, partitionFixture } from './test-fixtures/partition.mjs';
import { writerMergeScc, stopStageViolations, deriveGraph, crossingEdges, INTERRUPTS } from './test-fixtures/decomposition-check.mjs';
import { TOOL_OUTPUT_MAX_BYTES } from './test-fixtures/constants.mjs';
import { ledgerEntryViolations, tasksById, expandRefs, AGENT_PERMISSIONS_CONTRACT, LEDGER_ENTRY_KEYS } from './test-fixtures/ledger-check.mjs';

const P = (id, line, over = {}) => ({ id, file: 'spec.md', line, statement: `性質 ${id}`, query: { result: 'unsat' }, sanity: { result: 'sat' }, mutation: { result: 'sat' }, ...over });
const prop = (result, id) => result.properties.find((p) => p.id === id);
const checksOf = (result, p) => p.check_ids.map((id) => result.checks.find((c) => c.id === id));
const sha256hex = (s) => createHash('sha256').update(s).digest('hex');
const runRefOf = (runDir, dir, name) => relative(runDir, join(dir, name));
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
// 最後の plan-author の task の計画（harness が書いたもの）
function planOf(harness) {
  const t = harness.memory.byRole['plan-author'];
  return { plan: readJson(join(t.attempt_dir, 'plan.json')), mutations: readJson(join(t.attempt_dir, 'mutations.json')) };
}
// 道具に渡す query: input_refs のファイルのバイト列を順に、各ファイルの後に \n を 1 つ置いてつないだもの（cli-contract「Z3 の adapter」）
const queryOf = (runDir, refs) => refs.map((r) => `${readFileSync(join(runDir, r), 'utf8')}\n`).join('');
// 実行の証拠は checks/<execution_id>/ にあり、execution_id は検査なら Check.id、確認なら Confirmation.id（cli-contract「run の領域の配置」）
const evidence = (runDir, id, name) => join(runDir, 'checks', id, name);
const inputOf = (runDir, id) => readFileSync(evidence(runDir, id, 'input.smt2'), 'utf8');
// その実行の input.smt2 を受け取った偽の z3 の呼出し（指紋で引く）
const callsFor = (log, text) => log.filter((e) => e.kind === 'query-start' && e.query_sha256 === sha256hex(text));
// 欠陥が残った計画の要素は実行せず、どの欄にも載せず、unverified[] に「計画の欠陥: <計画の id>」で載る（artifact-formats「検査」）
function assertExcluded(result, ids) {
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
const tOf = (call) => Number(call.args.find((a) => a.startsWith('-T:'))?.slice(3));
const tasksOf = (harness, role) => harness.memory.tasks.filter((x) => x.role === role);
// 修正の巡: 同じ役に 2 つ目以降の task が出て、revise_defects_ref が非 null（artifact-formats「task の一覧」）
function assertRevised(harness, role, stage) {
  const ts = tasksOf(harness, role);
  assert.ok(ts.length >= 2, `${role} に修正の巡の task が出る（${ts.length} 件）`);
  assert.equal(ts[0].context.revise_defects_ref, null, '最初の巡は revise_defects_ref が null');
  for (const x of ts.slice(1)) {
    assert.notEqual(x.context.revise_defects_ref, null, '修正の巡の task は revise_defects_ref を持つ');
    assert.equal(x.context.stage, stage, `修正の巡は同じ段（${stage}）`);
  }
}

// harness を渡すと、採った計画（最後の plan-author の計画）で、計画との照合（refInvariants）も当てる
function assertRecordsConsistent(status, result, harness = null) {
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
const canonicalRun = async () => {
  if (!canonical) canonical = runScenario(null, {});
  return canonical;
};
after(async () => { if (canonical) { const c = await canonical.catch(() => null); if (c) removeTree(c.ws); } });

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
  // 正準のシナリオの実行は、性質の検査・sanity・変異（反例が無いので replay は無い）。checks/<execution_id>/input.smt2 で呼出しを引く
  const execs = [...result.checks.map((c) => [c.id, c.kind]), ...result.confirmations.deterministic.filter((c) => c.end?.started).map((c) => [c.id, c.kind])];
  assert.deepEqual([...new Set(execs.map(([, k]) => k))].sort(), ['mutation', 'property', 'sanity']);
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
});

// ---- AC-05: 道具の失敗 ----
// [名前, 道具, query の指示, 期待の検査の判定, 期待の End の一部]
const TOOL_CASES = [
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

// ---- 受け箱の batch の拒否（cli-contract「受け箱」、artifact-formats「担当の返り値」「Workflow の返り値」） ----
// harness は返り値を全て done で書いたうえで、受け箱か Workflow の返り値だけを崩す（test-fixtures/agent-harness.mjs の hooks.reject）。
// 拒否した batch の全ての task が、担当の失敗（段は task の context.stage）・作業記録の failures の 1 件・成果物の未作成になる。
// 期限の 2 つの型（late・no_submit）は依頼の時間の上限で期限を近くに置く（担当の batch の期限は早い方。architecture「時計と資源」）。
// late は、run-daemon が期限で batch を閉じたか、期限の後に受け箱を読んだかを外から区別しない（どちらも batch の拒否）。
const ID_CHARS = 'A-Za-z0-9._-';
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const hasId = (text, id) => new RegExp(`(^|[^${ID_CHARS}])${escapeRe(id)}([^${ID_CHARS}]|$)`).test(text);
// batch_id と task_id を除いても、原因の文が残る（原因の語は契約が定めないので、空でないことだけを見る）
const residue = (text, batchId, taskId) => text.split(taskId).join('').split(batchId).join('').replace(/[\s\p{P}\p{S}]/gu, '');
const mentions = (text, batchId, taskId) => text.includes(batchId) && hasId(text, taskId) && residue(text, batchId, taskId).length > 0;
const ROLE_KINDS = { extractor: ['inventory'], 'model-author': ['model', 'mapping'], 'plan-author': ['plan', 'mutations'] };
const firstBatchWith = (role) => {
  let done = false;
  return (_s, list) => {
    if (done || !list.tasks.some((x) => x.role === role)) return null;
    done = true;
    return 'pick';
  };
};
function assertBatchRejected({ result, status, harness }) {
  const issued = harness.memory.batches.map((b) => `${b.batch_id}: ${b.tasks.map((x) => x.role).join('・')}`);
  assert.equal(harness.memory.rejected.length, 1, `拒否を起こした batch は 1 つ（0 なら拒否する役の batch が出なかった。出た batch: ${JSON.stringify(issued)}${result ? `、停止の理由: ${JSON.stringify(result.stop_report?.reasons ?? [])}` : ''}）`);
  const { list } = harness.memory.rejected[0];
  assert.deepEqual(resultInvariants(result), []);
  assert.equal(result.status, '停止');
  const sr = result.stop_report;
  assert.deepEqual(stopStageViolations(result), [], JSON.stringify(sr.reasons));
  const created = sr.artifacts_created.map((x) => x.ref);
  const notCreated = sr.artifacts_not_created.map((x) => x.kind);
  for (const task of list.tasks) {
    const stage = task.context.stage;
    // 停止の理由: task ごとに 担当の失敗 を 1 つ、段は task の context.stage、detail に batch_id・task_id・原因
    const rs = sr.reasons.filter((x) => x.code === '担当の失敗' && x.stage === stage && mentions(x.detail, list.batch_id, task.task_id));
    assert.equal(rs.length, 1, `${task.task_id} の 担当の失敗（段 ${stage}、detail に batch_id・task_id・原因）: ${JSON.stringify(sr.reasons)}`);
    // 作業記録: その task の段の worklogs/cli-<stage>.json の failures に 1 件
    const log = join(status.run_dir, 'worklogs', `cli-${stage}.json`);
    assert.ok(existsSync(log), `worklogs/cli-${stage}.json がある`);
    const failures = readJson(log).failures.filter((f) => mentions(f, list.batch_id, task.task_id));
    assert.equal(failures.length, 1, `cli-${stage}.json の failures に ${task.task_id} が 1 件: ${JSON.stringify(readJson(log).failures)}`);
    // 期限内に書いた返り値でも成功に数えない: 成果物を生成済みに数えず、作るはずの成果物は未作成
    assert.ok(!created.some((r) => r.startsWith(`attempts/${task.task_id}/`) && !r.endsWith('worklog.json')), `${task.task_id} の成果物を生成済みに数えない: ${created.join()}`);
    for (const k of ROLE_KINDS[task.role] ?? []) assert.ok(notCreated.includes(k), `${k} は未作成: ${notCreated.join()}`);
    // 照合役なら確認できず の確認、原因の分類役なら 原因未確認 の原因になる（artifact-formats「確認」「担当の返り値」）
    if (task.context.perspective) assertReviewFailed(result, task, harness, { rejected: true });
    else if (task.role === 'cause-analyst') assertCauseFailed(result, task, { rejected: true });
    else assert.ok(!result.confirmations.meaning.some((c) => c.checker === task.task_id), `${task.task_id} の意味の確認を作らない`);
  }
  // 拒否した task の段は停止の理由の段に入る（AC-19）。中断の理由が無ければ、stop_report.stage は reasons の全ての段のうち
  // Stage の並びで最も上流の段（artifact-formats「stop_report.stage の決め方」）。他の理由（例: 反例 は 実行）の段も含めて求める
  const reasonStages = sr.reasons.map((x) => x.stage);
  for (const task of list.tasks) assert.ok(reasonStages.includes(task.context.stage), `拒否した ${task.task_id} の段 ${task.context.stage} が停止の理由の段に入る`);
  if (!sr.reasons.some((x) => INTERRUPTS.includes(x.code))) {
    const STAGE_ORDER = ['受付', '洗い出し', 'モデル化', '計画', '実行', '確認', '集約'];
    const upstream = [...reasonStages].sort((a, b) => STAGE_ORDER.indexOf(a) - STAGE_ORDER.indexOf(b))[0];
    assert.equal(sr.stage, upstream, JSON.stringify(sr.reasons));
  }
  return list;
}
const REJECT_CASES = [
  // [名前, 拒否の型, 拒否する batch の役, 依頼の差分, scenario の差分]
  // 期限の 2 つの型は、依頼の時間の上限 24 秒（担当の batch の期限は開始から約 18 秒）で、遅い環境でも抽出役の batch が期限の前に出る余裕を取る
  ['Workflow の返り値の batch_id が開いている batch と違う', 'wf_batch_id', 'extractor', {}],
  ['received の値が tasks.json と違う', 'received', 'extractor', {}],
  ['results の task の集合が tasks から欠ける', 'set_missing', 'extractor', {}],
  ['results の task の集合に余分な task がある', 'set_extra', 'extractor', {}],
  ['受け箱が timed_out: true（返り値は期限内に書いてある）', 'timed_out', 'extractor', {}],
  ['受け箱が timed_out: true（モデル化の段の batch）', 'timed_out', 'model-author', {}],
  ['期限の後に受け箱を公開する（返り値は期限内に書いてある）', 'late', 'extractor', { time_limit_seconds: 24 }],
  ['期限までに受け箱を公開しない', 'no_submit', 'extractor', { time_limit_seconds: 24 }],
  ['受け箱が timed_out: true（反例の原因の分類役の batch）', 'timed_out', 'cause-analyst', {}, { properties: [P('P1', 3, { query: { result: 'sat' } })] }],
  ['受け箱を読めない（権限 000）', 'inbox_unreadable', 'extractor', {}],
  ['受け箱が JSON でない', 'inbox_not_json', 'extractor', {}],
  ['受け箱が形に合わない（workflow_output_path も timed_out も無い）', 'inbox_shape', 'extractor', {}],
  ['受け箱の batch_id が開いている batch と違う', 'inbox_batch_id', 'extractor', {}],
  ['受け箱の workflow_output_path のファイルを読めない（存在しない）', 'wf_unreadable', 'extractor', {}],
  ['Workflow の返り値が形に合わない（results が配列でない）', 'wf_shape', 'extractor', {}],
];
for (const [name, mode, role, over, scenario = {}] of REJECT_CASES) {
  test(`cli-contract 受け箱 batch の拒否 SP-FORMALMETHOD-015 AC-19: ${name}と、batch の全ての task が 担当の失敗（段は task の context.stage）になり、作業記録の failures に 1 件ずつ入り、成果物は未作成`, async (t) => {
    if (mode === 'inbox_unreadable' && skipIfRoot(t)) return;
    const pick = firstBatchWith(role);
    const out = await runScenario(t, { request: canonicalRequest(over), scenario, hooks: { reject: (s, list) => (pick(s, list) ? mode : null) } });
    const list = assertBatchRejected(out);
    assert.ok(list.tasks.some((x) => x.role === role), `${role} の batch を拒否した`);
  });
}

test('cli-contract 受け箱 batch の拒否 SP-FORMALMETHOD-015 AC-19: 確認の段の batch が timed_out だと、その確認は 確認できず になり、性質は 未確認 になり、stop_report.stage は確認', async (t) => {
  const pick = firstBatchWith('fidelity-reviewer');
  const out = await runScenario(t, { hooks: { reject: (s, list) => (pick(s, list) ? 'timed_out' : null) } });
  const list = assertBatchRejected(out);
  assert.ok(list.tasks.every((x) => x.context.stage === '確認'), '独立検証者の batch は確認の段（architecture「段と処理の順序」）');
  assert.deepEqual(prop(out.result, 'P1').verdict, ['未確認'], '忠実さの確認が 確認できず なので meaning_confirmed が false で 未確認（artifact-formats「意味の確認から判定の入力への写し」の注）');
  assert.equal(out.result.stop_report.stage, '確認');
});

// ---- 照合役と原因の分類役の失敗（artifact-formats「確認」の意味の確認の作り方・写しの表、「担当の返り値」、architecture「担当の起動」） ----
// 失敗した task の 担当の失敗 の detail として許す文の集合。
// batch の拒否では detail が batch_id・task_id を持つ（cli-contract「受け箱」）ので、その task の 1 つに絞る。
// 他の経路では detail の中身を契約が定めないので、その段の 担当の失敗 の detail のどれかとする。
function failureDetails(sr, task, { rejected = false } = {}) {
  const at = sr.reasons.filter((x) => x.code === '担当の失敗' && x.stage === task.context.stage);
  assert.ok(at.length >= 1, `${task.task_id} の段 ${task.context.stage} に 担当の失敗: ${JSON.stringify(sr.reasons)}`);
  if (!rejected) return at.map((x) => x.detail);
  const own = at.filter((x) => hasId(x.detail, task.task_id));
  assert.equal(own.length, 1, `${task.task_id} の 担当の失敗: ${JSON.stringify(sr.reasons)}`);
  return [own[0].detail];
}
// 写しの表の「関わる性質」
function expectedPropertyIds(task, harness) {
  const c = task.context;
  if (c.perspective === 'fidelity') {
    const ms = harness.memory.models.filter((m) => m.id === c.model_id).map((m) => readJson(join(m.task.attempt_dir, m.file)));
    assert.ok(ms.length >= 1, `${c.model_id} のモデルを harness が書いた`);
    return [...new Set(ms[ms.length - 1].properties.flatMap((p) => p.inventory_property_ids))].sort();
  }
  if (c.perspective === 'nonformal' || c.perspective === 'assurance') return c.property_ids;
  return [];
}
// 意味の確認の共通の欄（artifact-formats「意味の確認の作り方」の共通の欄と写しの表の「関わる性質」）
function assertConfirmationCommon(conf, task, harness) {
  const c = task.context;
  assert.equal(conf.kind, c.perspective);
  assert.equal(conf.item, c.unit_id);
  assert.equal(conf.checker, task.task_id);
  assert.equal(conf.plan_id, null);
  assert.equal(conf.end, null);
  assert.equal(conf.model_property_id, c.perspective === 'assurance' ? c.unit_id.slice('assurance-'.length) : null);
  assert.deepEqual(conf.property_ids, expectedPropertyIds(task, harness));
  // ディレクトリの ref は下の全てのファイルの RefHash に辞書順で展開する（artifact-formats「ディレクトリの ref の指紋」）
  assert.deepEqual(conf.materials, expandRefs(c.run_dir, c.input_refs), 'materials は context.input_refs をファイルの RefHash に展開したもの');
}
// expandRefs は test-fixtures/ledger-check.mjs（台帳の検査と同じ展開）
function assertReviewFailed(result, task, harness, opts = {}) {
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
function assertCauseFailed(result, task, opts = {}) {
  const details = failureDetails(result.stop_report, task, opts);
  const cs = result.causes.filter((x) => x.classified_by === task.task_id);
  assert.equal(cs.length, 1, `${task.task_id} の原因がちょうど 1 つ: ${JSON.stringify(result.causes)}`);
  assert.equal(cs[0].cause, '原因未確認');
  assert.ok(details.includes(cs[0].grounds), `grounds は 担当の失敗 の detail と同じ文: ${cs[0].grounds} / ${JSON.stringify(details)}`);
  assert.deepEqual(cs[0].subject, task.context.subject);
  assert.ok(!result.confirmations.meaning.some((x) => x.checker === task.task_id), '原因の分類役の確認を作らない');
  if (task.context.subject.kind === 'question') assert.ok(!result.questions.some((q) => q.id === task.context.subject.id), '原因未確認 の問いは questions[] に入らない');
}
const reviewTasks = (harness, perspective) => harness.memory.tasks.filter((x) => x.context.perspective === perspective);
const REVIEW_FAIL_CASES = [
  // [観点, 失敗の型, scenario（又はそれを返す関数）, 判定の確かめ]
  ['fidelity', 'missing', {}, (r) => assert.deepEqual(prop(r, 'P1').verdict, ['未確認'])],
  ['fidelity', 'bad_shape', {}, (r) => assert.deepEqual(prop(r, 'P1').verdict, ['未確認'])],
  ['assurance', 'missing', {}, (r) => assert.deepEqual(prop(r, 'P1').verdict, ['未確認'])],
  ['assurance', 'bad_shape', {}, (r) => assert.deepEqual(prop(r, 'P1').verdict, ['未確認'])],
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

const CAUSE_Q = { id: 'Q9', missing_decision: 'R2 の y が x と等しいときの扱い', affected: ['P2'], options: ['許す', '許さない'] };
const CAUSE_FAIL_CASES = [
  // [名前, scenario, subject の kind]
  ['反例の原因の分類役が返らない', { properties: [P('P1', 3, { query: { result: 'sat' } })], returns: { 'cause-analyst': 'missing' } }, 'counterexample'],
  ['反例の原因の分類役が形の違う返り値を返す', { properties: [P('P1', 3, { query: { result: 'sat' } })], returns: { 'cause-analyst': 'bad_shape' } }, 'counterexample'],
  ['作成役の問いの原因の分類役が返らない', { properties: [P('P1', 2), P('P2', 3)], questionsBy: { extractor: [CAUSE_Q] },
    cause: { cause: '要求の不足', grounds: 'R2 は等しい場合を定めない', questions: [CAUSE_Q] }, returns: { 'cause-analyst': 'missing' } }, 'question'],
];
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
  const reviews = { fidelity: '確認できず', assurance: '成り立たない' };
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
  const { result } = await runScenario(t, { scenario: { reviews: { assurance: '成り立たない' } } });
  assert.deepEqual(resultInvariants(result), []);
  assert.ok(result.confirmations.meaning.some((x) => x.kind === 'assurance' && x.result === '成り立たない'), '保証の確認が 成り立たない');
  assert.ok(!result.confirmations.meaning.some((x) => x.result === '確認できず'), '確認できず の意味の確認は無い');
  assert.equal(result.status, '停止');
  assert.ok(result.stop_report.reasons.some((x) => x.code === '確認が終わっていない'), JSON.stringify(result.stop_report.reasons));
});

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
  assert.ok(result.confirmations.deterministic.some((c) => c.kind === 'sanity' && c.property_ids.includes('P1') && c.model_property_id === 'P1' && c.result === '成り立たない'));
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

// ---- AC-12: 性能の比較の条件 ----
const CLAIM_CASES = [
  ['条件が一致する比較は 一致を確認 で、主張を残す', 'match', '一致を確認', true],
  ['範囲と保証の違う比較は 一致を確認できず で、主張を null にする', 'mismatch', '一致を確認できず', false],
];
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

// ---- AC-07: 境界の契約と合成（分割の fixture は test-fixtures/partition.mjs） ----
const partitionWithUnconfirmedAssumption = partitionFixture();

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

// ---- 証人と replay（cli-contract「Z3 の adapter」「証人」、artifact-formats「反例と原因」） ----
// 反例の検査の query（input_refs をつないだもの）と、replay の input.smt2（Counterexample.replay.steps_ref）
function counterexampleQueries(status, result, harness, propertyId) {
  const x = result.counterexamples.find((c) => c.property_id === propertyId);
  assert.ok(x, `${propertyId} の反例`);
  const { plan } = planOf(harness);
  const check = plan.checks.find((c) => c.id === x.check_id);
  const original = inputOf(status.run_dir, x.check_id);
  assert.equal(original, queryOf(status.run_dir, check.input_refs), '反例の検査の input.smt2 は input_refs をつないだもの');
  return { x, check, original, stepsText: readFileSync(join(status.run_dir, x.replay.steps_ref), 'utf8') };
}

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

// reason に記号を語として、この順に挙げ、absent の記号を挙げない
function assertNamedInOrder(reason, names, absent = []) {
  const pos = (sym) => reason.search(new RegExp(`(^|[^A-Za-z0-9_!])${sym.replace('!', '\\!')}([^A-Za-z0-9_!]|$)`));
  const ps = names.map(pos);
  assert.ok(ps.every((x) => x >= 0), `${names.join('・')} を挙げる: ${reason}`);
  assert.deepEqual([...ps].sort((a, b) => a - b), ps, `宣言の順（${names.join('・')}）: ${reason}`);
  for (const a of absent) assert.equal(pos(a), -1, `${a} は挙げない: ${reason}`);
}

// 証人の規則を区別するモデル（cli-contract「証人」のモデルの形・証人の値・replay の query）。偽の z3 の model-text で、このモデルをそのまま出させる
const WITNESS_SMT = ['p Int', 'q Bool', 'n Int', 'd Real', 'e Real', 't String', 'u String', 'm Int', 'h Real', 'lm (Array Int Int)', 'aa (Array Int Int)', 'g Int']
  .map((x) => `(declare-const ${x})`).join('\n') + '\n(declare-fun ff (Int) Int)\n(assert (> p (ff 1)))';
const WITNESS_MODEL = [
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

// 秘密値（cli-contract「run の領域の配置」の秘密値の走査）: 見つかった記録は書かず、値は出力に残らない
const SECRET = 'AKIAABCDEFGHIJKLMNOP';
function assertSecretNowhere(out, runDir) {
  assert.ok(!JSON.stringify(out.result).includes(SECRET), '結果に値が残らない');
  assert.ok(!out.statuses.some((x) => JSON.stringify(x).includes(SECRET)), 'Status に値が残らない');
  // 担当が自分で書いた attempts/ と、対象の写し targets/ は formal-method の記録でないので見ない
  const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (['attempts', 'targets'].includes(e.name) && d === runDir ? [] : walk(join(d, e.name))) : [join(d, e.name)]));
  for (const f of walk(runDir)) assert.ok(!readFileSync(f).includes(SECRET), `${relative(runDir, f)} に値が残らない`);
}
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

// 証人を読めないとき: 反例の検査は 反例 のまま、replay は始めず 確認できず、steps_ref は反例の検査の query を指す
const NOT_STARTED_END = { started: false, tool_result: 'なし', abnormal_exit: false, unreadable_output: false, stopped_by: null, time_limit_hit: null };
const WITNESS_CASES = [
  ['モデルが無い', { result: 'sat', model: 'none' }],
  ['形に合わないモデル（list の後に form が残る）', { result: 'sat', model: 'malformed' }],
  ['固定する記号が無いモデル（literal でない項だけ）', { result: 'sat', model: 'unfixable' }],
  ['答えの後の行が list でない（sat と unsat の 2 行。読む順 0 で 2 行目はモデルの文字列）', { mode: 'multi' }],
  ['TOOL_OUTPUT_MAX_BYTES を超えるモデル（上限までに答えを読めたので止めない）', { result: 'sat', model: 'huge' }],
];
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
    editPlan: (plan) => ({ ...plan, checks: plan.checks.map((c) => ({ ...c, tool_time_limit_seconds: { 'C-K-a': 11, 'C-CC1': 13, 'C-CC2': 14 }[c.id] ?? c.tool_time_limit_seconds })) }),
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

// ---- 部分の契約の検査と合成の条件（artifact-formats「検査」「分割と合成」） ----
const PART_SCENARIO = (over = {}, part = {}) => ({ stateMachine: SM2, properties: SM2_PROPS, partition: partitionFixture({ basis: 'guarantee', conds: ['CC1', 'CC2'], ...part }), ...over });
const dropChecks = (...ids) => (plan) => ({ ...plan, checks: plan.checks.filter((c) => !ids.includes(c.id)) });

test('artifact-formats 検査・分割と合成 AC-07・AC-09: 契約の検査は checks[] に kind contract で現れ properties[].check_ids に入らず、契約に依らない合成の条件の検査も親の check_ids に入り、全てそろえば親は 検証済み', async (t) => {
  const { result, status, harness } = await runScenario(t, { scenario: PART_SCENARIO() });
  assert.deepEqual(resultInvariants(result), []);
  assertRecordsConsistent(status, result, harness);
  const d = result.decomposition;
  assert.equal(d.adopted, true, d.reason);
  const kc = result.checks.find((c) => c.id === 'C-K-a');
  assert.equal(kc?.kind, 'contract', '契約の検査は checks[] に kind contract');
  assert.deepEqual(d.contracts.find((k) => k.id === 'K-a').check_ids, ['C-K-a']);
  assert.deepEqual(d.contracts.find((k) => k.id === 'K-a').verdict, ['検証済み']);
  for (const p of result.properties) assert.ok(!p.check_ids.includes('C-K-a'), `${p.id}.check_ids に契約の検査が入らない`);
  for (const m of result.models) for (const row of m.mapping) assert.ok(!row.check_ids.includes('C-K-a'), 'mapping の check_ids に契約の検査が入らない');
  assert.deepEqual([...prop(result, 'P1').check_ids].sort(), ['C-CC1', 'C-CC2', 'C-P1'], '性質の検査と、derived_from が P1 の合成の条件の検査（契約に依らない CC2 を含む）');
  for (const cc of d.composition_conditions) assert.equal(cc.derived_from, 'P1');
  assert.ok(result.performance.executions.some((e) => e.id === 'C-K-a' && e.kind === 'contract'), 'performance.executions に kind contract');
  assert.deepEqual(prop(result, 'P1').verdict, ['検証済み'], '全ての契約が 検証済み で、derived_from の合成の条件が全て成功');
});

// 欠けた検査: 計画に無いので checks[] に無く、その契約・合成の条件の check_ids は空
const missingCheck = (id, where) => (r, harness) => {
  assertRevised(harness, 'plan-author', '計画');
  assert.ok(!r.checks.some((c) => c.id === id), `計画に無い ${id} は checks[] に無い`);
  const owner = where === 'contract' ? r.decomposition.contracts.find((k) => k.id === 'K-a') : r.decomposition.composition_conditions.find((c) => c.id === 'CC1');
  assert.deepEqual(owner.check_ids, []);
};
// 依存先の検査が成功でない合成の条件の検査は始めない（D1）
const ccNotRun = (r, id) => {
  const c = r.checks.find((x) => x.id === id);
  assert.ok(c, `${id} は checks[] にある`);
  assert.equal(c.state, '実行していない', `${id} の state`);
  assert.equal(c.verdict, '未実行', `${id} の verdict`);
};
// 親の性質の全てで no_suitable_tool（chosen.tool が z3 でない）。検査も変異も無ければ検査の欠けから除くので修正の巡は出ない
const notZ3NoChecks = {
  editPlan: (plan) => ({ ...plan, selection: plan.selection.map((x) => ({ ...x, chosen: { ...x.chosen, tool: 'Rust' } })), checks: [] }),
  editMutations: (m) => ({ ...m, mutations: [], unavailable: m.mutations.map(() => ({ property_id: 'P1', reason: 'z3 で実行しない', alternative: null })) }),
};
const PART_CASES = [
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
      assert.ok(!result.counterexamples.some((x) => x.check_id === 'C-K-a'), '契約の検査から反例を作らない');
      assert.deepEqual(result.counterexamples, []);
      assert.ok(!result.stop_report.reasons.some((r) => r.code === '反例'), '契約の反例は停止の理由 反例 に数えない');
      assert.ok(k.reason.length > 0);
    }
    if (parentVerdict[0] === '反例') assert.ok(result.counterexamples.some((x) => x.check_id === 'C-CC2' && x.property_id === 'P1'), '合成の条件の反例は親の性質の反例');
    assert.equal(result.status, '停止');
  });
}

test('artifact-formats 分割と合成: 合成の条件の derived_from が別のモデルの性質を指す分割は分割の欠陥で、分割作成役に修正の巡が出て、直した分割が結果に入る', async (t) => {
  const scenario = {
    modelPropPrefix: 'MP-',
    properties: [{ ...SM2_PROPS[0] }, P('P2', 3, { smt: SMT_A })],
    models: [{ id: 'M1', propertyIds: ['P1'], stateMachine: SM2 }, { id: 'M2', propertyIds: ['P2'], stateMachine: { ...SM_A, transitions: SM_A.transitions.map((x) => ({ ...x, source_ids: ['E-P2'] })) } }],
    partition: partitionFixture({ basis: 'guarantee', conds: ['CC1'], derivedFrom: (round) => (round === 1 ? 'MP-P2' : 'MP-P1') }),
  };
  const { result, harness } = await runScenario(t, { scenario });
  assert.deepEqual(resultInvariants(result), []);
  assertRevised(harness, 'partition-author', '計画');
  for (const x of [...result.decomposition.contracts, ...result.decomposition.composition_conditions]) assert.equal(x.derived_from, 'MP-P1', `${x.id} は同じモデル M1 の性質を指す`);
});

// ---- 検査の欠けと 形式化 の行（artifact-formats「形式モデルと対応」「plan と mutations」） ----
function assertNoChecksRow(result, id) {
  const rows = result.models.flatMap((m) => m.mapping).filter((r) => r.property_id === id && r.relation === '形式化');
  assert.ok(rows.length >= 1, `${id} の 形式化 の行`);
  for (const r of rows) { assert.deepEqual(r.check_ids, []); assert.ok(r.reason && r.reason.length > 0, '検査の無い理由'); }
  assert.deepEqual(prop(result, id).check_ids, []);
  assert.ok(prop(result, id).reason.length > 0);
}

test('artifact-formats plan と mutations 検査の欠け: モデルの性質の検査が無い計画は計画の欠陥で修正の巡が出て、直れば通常の結果になる', async (t) => {
  const { result, harness } = await runScenario(t, { scenario: { editPlan: (plan, { round }) => (round === 1 ? dropChecks('C-P1')(plan) : plan) } });
  assert.deepEqual(resultInvariants(result), []);
  assertRevised(harness, 'plan-author', '計画');
  assert.deepEqual(prop(result, 'P1').verdict, ['検証済み']);
  assert.equal(result.status, '完了', JSON.stringify(result.stop_report));
});

test('artifact-formats 形式モデルと対応 検査の欠け: 修正の巡の後も検査が欠ければ止めずに進み、形式化 の行は check_ids が空で reason を持ち、性質は 未確認', async (t) => {
  const { result, harness } = await runScenario(t, { scenario: { editPlan: dropChecks('C-P1') } });
  assert.deepEqual(resultInvariants(result), []);
  assertRevised(harness, 'plan-author', '計画');
  assertNoChecksRow(result, 'P1');
  assert.deepEqual(prop(result, 'P1').verdict, ['未確認']);
  assert.ok(tasksOf(harness, 'fidelity-reviewer').length >= 1, '止めずに確認の段へ進む');
  assert.equal(result.status, '停止');
});

const NO_PLAN_CASES = [
  // [名前, 道具, 計画作成役の返り方, 期待の判定]
  ['計画作成役が返らず、道具がある', 'fake', 'missing', ['未確認']],
  ['計画作成役が cannot_proceed を返し、道具がある', 'fake', 'cannot_proceed', ['未確認']],
  ['計画作成役が返らず、道具が無い（SP-007）', 'absent', 'missing', ['未実行']],
];
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

// ---- 計画の照合（artifact-formats「plan と mutations」、cli-contract「Z3 の adapter」の道具に渡す query） ----
const setSelection = (fn) => (plan) => ({ ...plan, selection: fn(plan.selection) });
const z3Candidate = (sel) => sel.candidates.find((c) => c.name === 'z3');
const withChosen = (tool) => setSelection((sel) => sel.map((x) => ({ ...x, chosen: { ...x.chosen, tool } })));
// 欠陥が残ったときの期待: 欠陥の残った計画の要素（検査・sanity・変異）は除き（assertExcluded）、性質は道具があれば 未確認、SP-007 なら 未実行
// （artifact-formats「検査」）。selection の欠け・重なりが残った性質も、その検査を欠陥の残った要素として除き、method は null（artifact-formats.md:733）。
const sp007 = (r) => { assertExcluded(r, ['C-P1']); assert.deepEqual(prop(r, 'P1').verdict, ['未実行']); };
const selectionLeft = (r) => {
  assertExcluded(r, ['C-P1']);
  assert.equal(prop(r, 'P1').method, null, 'method は null');
  assert.deepEqual(prop(r, 'P1').verdict, ['未確認'], 'no_suitable_tool は準備の結果だけ（z3 はある）');
  assert.ok(r.stop_report.reasons.some((x) => x.code === '必要な性質が検証の成功でない'), JSON.stringify(r.stop_report.reasons));
};
const PLAN_DEFECTS = [
  // [名前, scenario の上書き（巡ごと）, 欠陥が残ったときの期待]
  ['selection の要素が欠ける', { editPlan: setSelection(() => []) }, selectionLeft],
  ['selection の要素が重なる', { editPlan: setSelection((sel) => [...sel, structuredClone(sel[0])]) }, selectionLeft],
  // モデルの性質ごとに PlanFile.sanity が 1 つ以上ある（artifact-formats.md:743 の検査の欠け）
  ['sanity の無い計画', { editPlan: (plan) => ({ ...plan, sanity: [] }) },
    (r) => { assert.ok(!r.confirmations.deterministic.some((c) => c.kind === 'sanity'), 'sanity の確認は無い'); assertNoSanityConfirmed(r); }],
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
const onlyRound1 = (fn) => (x, ctx) => (ctx.round === 1 ? fn(x, ctx) : x);
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

// 担当が書く .smt2 の規則（(check-sat) をちょうど 1 つ最後の form に置き、get-model・set-option・push などを書かない）は、
// そのファイルを書いた役の段で照らす（artifact-formats「担当の成果物」）
const SMT_VIOLATIONS = [
  ['(check-sat) の後に form がある', (q) => `${q}(assert true)\n`],
  ['(check-sat) が 0 個', (q) => q.replace('(check-sat)\n', '')],
  ['(check-sat) が 2 個', (q) => `${q}(check-sat)\n`],
  ['get-model を書いた', (q) => q.replace('(check-sat)', '(get-model)\n(check-sat)')],
  ['set-option を書いた', (q) => `(set-option :produce-models true)\n${q}`],
  ['push を書いた', (q) => q.replace('(check-sat)', '(push 1)\n(check-sat)')],
];
const appendAfterCheckSat = (when) => (text, { round, kind }) => (kind === 'property' && when(round) ? `${text}(assert true)\n` : text);
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

// sanity の確認が無い（除いた sanity がある）性質は deterministic_confirmed が false で 未確認、run は述語 1 で 停止（artifact-formats.md:593）
function assertNoSanityConfirmed(r) {
  assert.deepEqual(prop(r, 'P1').verdict, ['未確認']);
  assert.equal(r.status, '停止');
  const codes = r.stop_report.reasons.map((x) => x.code);
  assert.ok(codes.includes('必要な性質が検証の成功でない'), codes.join());
  assert.ok(!codes.includes('確認が終わっていない'), `述語 2 に当たらない: ${codes.join()}`);
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

// 分割作成役の契約・合成の条件の query は、計画の段の分割の照合で照らし、修正の巡は分割作成役に出る
const PARTITION_QUERY_VIOLATIONS = [['契約', 'contract', 'C-K-a'], ['合成の条件', 'composition', 'C-CC1']];
// persist が false なら 1 巡目だけ違反し、修正の巡で直す
const partitionViolating = (which, persist) => (cands, put, ctx) => {
  const base = partitionFixture({ basis: 'guarantee', conds: ['CC1', 'CC2'] })(cands, put, ctx);
  if (!persist && ctx.round > 1) return base;
  const bad = (x, id) => ({ ...x, query_ref: put(`${id}-bad.smt2`, `; ${which} ${id}\n(declare-const a Int)\n(check-sat)\n(assert (< a 0))\n`) });
  return which === 'contract'
    ? { ...base, contracts: base.contracts.map((k) => bad(k, k.id)) }
    : { ...base, composition_conditions: base.composition_conditions.map((c) => (c.id === 'CC1' ? bad(c, c.id) : c)) };
};
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

// ---- 道具を実行した確認の result（cli-contract「Z3 の adapter」: end に classifyCheck を当て、成功 → 成り立つ、反例 → 成り立たない、他 → 確認できず） ----
const SANITY_CASES = [
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

// ---- 問いに依存する性質は、挙げた段より後の段から外す（architecture.md:100-104、artifact-formats.md:740） ----
const QUESTION = { id: 'Q1', missing_decision: 'R2 の y が x と等しいときの扱い', affected: ['P2'], options: ['許す', '許さない'] };
const QUESTION_CASES = [
  // [問いを挙げた役, P2 の 形式化 の行]
  ['extractor', 'none'],
  ['model-author', 'empty'],
  ['plan-author', 'empty'],
];
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

// ======== 契約の改訂（レビューの n=5・31・32・33・34、SP-012 の syntax・reference・output_format）で増えたケース ========

// 決定的な確認のうち kind ごとに 1 つ（run に最大 1 つ）を返す。無ければ undefined
function detConf(result, kind) {
  const cs = result.confirmations.deterministic.filter((c) => c.kind === kind);
  assert.ok(cs.length <= 1, `${kind} の確認は run に 1 つまで: ${cs.length}`);
  return cs[0];
}
const DET_ITEMS = { syntax: '担当の成果物の構文', reference: '担当の成果物の参照の解決', output_format: '道具の出力の形式', result_presence: '計画した全ての検査の結果' };
// 共通の欄（artifact-formats「result_presence の作り方」「syntax・reference・output_format の作り方」）
function assertDetCommon(c) {
  assert.deepEqual([c.property_ids, c.model_property_id, c.plan_id, c.checker, c.materials, c.end], [[], null, null, 'cli', [], null], `${c.kind} の共通の欄`);
  assert.equal(c.item, DET_ITEMS[c.kind]);
  assert.equal(typeof c.reason, 'string');
}

// ---- n=5: 分割の照合の境界（artifact-formats「分割の照合の境界」） ----
// 1 巡目だけ欠陥のある分割を返し、修正の巡で直す（persist なら直さない）
const partitionDefect = (kind, persist = false) => (cands, put, ctx) => {
  const base = partitionFixture({ basis: 'guarantee', conds: ['CC1', 'CC2'] })(cands, put, ctx);
  if (!persist && ctx.round > 1) return base;
  if (kind === 'responsible') return { ...base, boundaries: base.boundaries.map((b) => ({ ...b, responsible: ['K-missing'] })) };
  if (kind === 'part_id') return { ...base, contracts: base.contracts.map((k) => ({ ...k, part_id: 'part-b' })) };
  return { ...base, boundaries: base.boundaries.map((b) => ({ ...b, assumption_basis: { kind: '共同不変条件', check_ids: ['C-JI1'] } })) };
};
const PARTITION_DEFECTS = [
  ['Boundary.responsible が同じ分割の contracts[].id に無い', 'responsible'],
  ['責任を負う契約の part_id が Boundary.producer と違う', 'part_id'],
  ['assumption_basis.kind が 共同不変条件', 'joint'],
];
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

// ---- context.property_ids（artifact-formats「役と context」の model-author・plan-author の行） ----
function assertAuthorPropertyIds(harness) {
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
const PROPERTY_IDS_CASES = [
  // [名前, scenario]
  ['形式化できない性質を含む', { properties: [P('P1', 2), P('P2', 3, { formalizable: false })] }],
  ['抽出役が問いに依存すると挙げた性質を含む', { properties: [P('P1', 2), P('P2', 3)], questionsBy: { extractor: [{ id: 'Q8', missing_decision: 'R2', affected: ['P2'], options: ['a', 'b'] }] } }],
  ['モデル作成役が問いに依存すると挙げた性質を含む', { properties: [P('P1', 2), P('P2', 3)], questionsBy: { 'model-author': [{ id: 'Q8', missing_decision: 'R2', affected: ['P2'], options: ['a', 'b'] }] } }],
];
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

// ---- n=33: 独立検証者と原因の分類役の input_refs（artifact-formats「独立検証者と原因の分類役の input_refs」） ----
const norm = (r) => r.replace(/\/+$/, '');
function lastTask(harness, role, pred = () => true) { return harness.memory.tasks.filter((x) => x.role === role && pred(x)).at(-1); }
function expectedInputRefs(task, { result, harness, runDir }) {
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
    case 'fidelity': { const m = modelOf(c.model_id); return [...allCopies, ...req.targets.map((x) => `targets/${x.id}/manifest.json`), ...allInv, m.model, m.mapping, 'worklogs/cli-モデル化.json']; }
    case 'assurance': {
      const mp = c.unit_id.slice('assurance-'.length);
      const m = modelOf(c.model_id);
      const planFile = readJson(join(plan.attempt_dir, 'plan.json'));
      const execs = [
        ...planFile.checks.filter((x) => x.target_id === mp).map((x) => x.id),
        ...result.confirmations.deterministic.filter((x) => ['sanity', 'mutation', 'replay'].includes(x.kind) && x.model_property_id === mp).map((x) => x.id),
      ].filter(ran).map(rec);
      const mut = join(plan.attempt_dir, 'mutations.json');
      return [m.model, m.mapping, m.json.properties.find((p) => p.id === mp).query_ref, rel(join(plan.attempt_dir, 'plan.json')), ...(existsSync(mut) ? [rel(mut)] : []), ...execs];
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
function assertInputRefs(out, tasks) {
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
test('artifact-formats 独立検証者の input_refs: extraction・fidelity・assurance・nonformal の task の input_refs が表どおりで、materials と台帳の input_refs はディレクトリを展開した RefHash', async (t) => {
  const out = await runScenario(t, { scenario: { properties: [P('P1', 2), P('P2', 3, { formalizable: false })] } });
  assert.deepEqual(resultInvariants(out.result), []);
  const tasks = out.harness.memory.tasks.filter((x) => x.context.perspective);
  for (const p of ['extraction', 'fidelity', 'assurance', 'nonformal']) assert.ok(tasks.some((x) => x.context.perspective === p), `${p} の task が出る`);
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
// 確認の段の task.md を保存できなくする（実行の段までの batch を返した後、attempts/ を書込み不可にする）。
// 時間の上限で確認の段にだけ担当を出さない run は、外から時刻を合わせられないので、同じ規則の 保存の失敗 の経路で起こす
test('artifact-formats 意味の確認 担当の返り値 SP-FORMALMETHOD-012: 確認の段で担当を出さなかった（task.md を保存できない）run は、意味の確認が checker cli・materials []・確認できず で unverified[] に写り、原因は classified_by cli・原因未確認 で、担当の失敗 は無い', async (t) => {
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
  assert.ok(locked, '計画の段の batch で attempts/ を書込み不可にした');
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
  // P1 はすぐ反例、P2 は検査に使える期限（上限 60 秒・残す時間 15 秒で、開始から約 45 秒）より長く眠り、実行の段で時間の上限に達する
  const scenario = { toolTimeLimit: 300, properties: [P('P1', 2, { query: { result: 'sat' } }), P('P2', 3, { query: { result: 'unsat', sleepMs: 200000 } })] };
  const { result, harness } = await runScenario(t, { request: canonicalRequest({ time_limit_seconds: 60 }), scenario });
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

// 時間の上限の run が想定の筋に乗らなかったときの手掛かり: 出た batch（段と役）と停止の理由
function timeLimitDiag(result, harness) {
  const batches = harness.memory.batches.map((b) => `${b.batch_id}[${b.tasks.map((x) => `${x.context.stage}/${x.role}`).join(',')}]`);
  return `出た batch: ${batches.join(' ')}; 停止の理由: ${JSON.stringify(result.stop_report?.reasons ?? [])}`;
}

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
  // 上限 60 秒（検査に使える期限は開始から約 45 秒）。全ての実行が期限より長く眠る
  const sleep = { sleepMs: 200000 };
  const scenario = { toolTimeLimit: 300, properties: [P('P1', 2, { query: { result: 'unsat', ...sleep }, sanity: { result: 'sat', ...sleep }, mutation: { result: 'sat', ...sleep } })] };
  const { result, harness } = await runScenario(t, { request: canonicalRequest({ time_limit_seconds: 60 }), scenario });
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

// ---- #26: 変異の無い性質の detection（artifact-formats「変異の無い性質の detection」。依頼者の決定） ----
const NO_MUTATION_CASES = [
  // [名前, alternative]
  ['alternative があり、保証の確認が 成り立つ', '仕様書の読み合わせで検出できることを確かめる'],
  ['alternative が null', null],
];
for (const [name, alternative] of NO_MUTATION_CASES) {
  test(`artifact-formats 変異の無い性質の detection SP-FORMALMETHOD-012: 変異を用意できず ${name}性質は、検出能力未確認（mutations []）で、reason に「別の方法の確認の結果が無い」を持ち、run は 検出能力未確認 で 停止`, async (t) => {
    const editMutations = (m) => ({ ...m, mutations: [], unavailable: [{ property_id: 'P1', reason: '変異を作れない', alternative }] });
    const { result } = await runScenario(t, { scenario: { properties: [P('P1', 2, { mutation: null })], editMutations } });
    assert.deepEqual(resultInvariants(result), []);
    const p = prop(result, 'P1');
    assert.ok(result.confirmations.meaning.some((c) => c.kind === 'assurance' && c.property_ids.includes('P1') && c.result === '成り立つ'), '保証の確認は 成り立つ');
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

// ---- #8: 組合せの原因の分類役の unit_id は cause-combination-<model_id>-<n>（artifact-formats「役と context」） ----
const renameState = (sm, from, to) => JSON.parse(JSON.stringify(sm).split(`"${from}"`).join(`"${to}"`));
const COMBINATION_CASES = [
  // [名前, 状態遷移, 対応できていない組の位置 n]
  ['日本語の状態名', SM, 1],
  ['空白を含む状態名', renameState(SM, '待ち', 'wait state'), 1],
];
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

// ---- ディレクトリの ref の展開の並び: UTF-8 のバイト列の辞書順（artifact-formats「ディレクトリの ref の指紋」） ----
// U+FF61（UTF-8 は EF BD A1、UTF-16 は FF61）と U+1F600（UTF-8 は F0 9F 98 80、UTF-16 は D83D DE00）は、2 つの順で前後が入れ替わる
const HALFWIDTH = '｡';
const EMOJI = '\u{1F600}';
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
test('artifact-formats ディレクトリの ref の指紋: 対象の写しに UTF-16 の順とずれる名前のファイルがあっても、materials と台帳の input_refs は UTF-8 のバイト列の順に展開される', async (t) => {
  const files = { 'target/spec.md': SPEC_TEXT, [`target/${HALFWIDTH}.md`]: '半角の句点\n', [`target/${EMOJI}.md`]: '絵文字\n' };
  const out = await runScenario(t, { files, scenario: {} });
  assert.deepEqual(resultInvariants(out.result), []);
  const tasks = out.harness.memory.tasks.filter((x) => x.context.perspective === 'extraction' || x.context.perspective === 'fidelity');
  assert.ok(tasks.length >= 1);
  for (const task of tasks) {
    const conf = out.result.confirmations.meaning.find((c) => c.checker === task.task_id);
    const refs = conf.materials.map((m) => m.ref);
    const iH = refs.indexOf(`targets/T1/files/${HALFWIDTH}.md`);
    const iE = refs.indexOf(`targets/T1/files/${EMOJI}.md`);
    assert.ok(iH >= 0 && iE >= 0 && iH < iE, `${task.task_id}: ${refs.join(', ')}`);
    assert.deepEqual(conf.materials, expandRefs(out.status.run_dir, task.context.input_refs));
  }
});

// ---- goals[].property_id は同じ ModelFile の properties[].id に実在する参照（artifact-formats「状態遷移」の goals） ----
// モデル作成役が目標の性質の id を誤る（persist なら修正の巡の後も直さない）
const wrongGoal = (persist) => (sm, { round }) => (persist || round === 1 ? { ...sm, goals: sm.goals.map((g) => ({ ...g, property_id: 'P-missing' })) } : sm);
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
