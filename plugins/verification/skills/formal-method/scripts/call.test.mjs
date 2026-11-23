// 担当の呼び出し（lib/call.mjs の runCall と、client の claim・query・submit・close）のテスト。
// 契約: cli-contract.md「依頼と応答」「受け箱」「status.json」、artifact-formats.md「claim の Task」「Workflow の返り値」、architecture.md「担当の起動」。
// 前半は run-daemon の Run を同じ process で動かし、client の関数で依頼を出す（期限と閉じた後の拒否を、時刻を合わせて起こすため）。
// 後半は本物の CLI と harness で start から terminal まで流す（停止の報告の段と、包まれた返り値の回帰）。harness は担当と同じく
// Bash の命令（入口の claim・query_cmd・submit_cmd と CLI の close）で流す（via: 'shell'）。
// coverage-audit の blackboard.test.mjs（args・query の規則）と launch.test.mjs（起動の数・出し直し）に倣う。
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Run } from './lib/run.mjs';
import { LAUNCHER, SUBMITS_MAX, markUnseen, packByUnion, runCall, runWorkers, sq, unionBytes, unwrap } from './lib/call.mjs';
import { refFiles, expandRefHashes, WORKFLOW_SCRIPT } from './lib/agents.mjs';
import { mergeSpans, fileLines, spanText } from './lib/target-refs.mjs';
import { execFileSync } from 'node:child_process';
import { close, workerCall } from './lib/client.mjs';
import { readStatus } from './lib/store.mjs';
import { startTimeOf } from './lib/process.mjs';
import { ROLES } from './lib/roles.mjs';
import { REVISE_ROUNDS_MAX, UNIT_MAX_BYTES, WORKER_CALL_MAX_MS } from './lib/schemas.mjs';
import { sha256Bytes } from './lib/canonical.mjs';
import { makeWorkspace, removeTree, CLI, runShell } from './test-fixtures/cli-runner.mjs';
import { runScenario } from './test-fixtures/pipeline.mjs';
import { SM, wrongGoal, PART_SCENARIO } from './test-fixtures/pipeline-cases.mjs';
import { resultInvariants } from './test-fixtures/result-schema.mjs';
import { stopStageViolations } from './test-fixtures/decomposition-check.mjs';

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
// 1 体に 1 担当の呼び出し。戻り値は items と同じ順の結果
const callOf = (run, stage, items) => runCall(run, { stage, workers: items.map((it) => ({ items: [it] })) }).then((o) => o.map((w) => w.results[0]));

// ---- 同じ process の run-daemon ----
function makeRun(t, { deadlineMs = 60000 } = {}) {
  const root = makeWorkspace('fm-call-');
  t.after(() => removeTree(root));
  const runDir = join(root, 'run1');
  mkdirSync(join(runDir, 'targets', 'T1', 'files'), { recursive: true });
  writeFileSync(join(runDir, 'request.json'), '{"note":"request"}\n');
  writeFileSync(join(runDir, 'targets', 'T1', 'files', 'spec.md'), '# spec\n');
  writeFileSync(join(runDir, 'ledger.json'), '{}\n');
  const identity = { pid: process.pid, started_at: startTimeOf(process.pid), nonce: 'abc123' };
  writeFileSync(join(runDir, 'run.lock'), JSON.stringify({ ...identity, role: 'run-daemon' }));
  const run = new Run({ runDir, runId: 'run1', root, workspace: root, nonce: 'abc123', identity });
  run.clock = { limited: false, usableExpired: () => false, batchDeadlineWall: () => Date.now() + deadlineMs };
  return run;
}
const reviewSpec = () => ({ role: 'extraction-reviewer', stage: '確認', unit_id: 'extraction-T1', perspective: 'extraction', target_id: 'T1',
  input_refs: [{ name: 'request', ref: 'request.json' }, { name: 'copy-T1', ref: 'targets/T1/files' }] });
const authorSpec = () => ({ role: 'model-author', stage: 'モデル化', property_ids: ['P1'], input_refs: [{ name: 'request', ref: 'request.json' }] });
async function waitOpen(runDir) {
  for (let i = 0; i < 200; i += 1) {
    const s = readStatus(runDir);
    if (s && s.action === 'run_agents') return s.call;
    await sleep(20);
  }
  throw new Error('呼び出しが開かない');
}
const rel = (task, name) => `attempts/${task.task_id}/${name}`;
function writeReview(task) {
  writeFileSync(join(task.attempt_dir, 'worklog.json'), '{}');
  writeFileSync(join(task.attempt_dir, 'review.json'), '{}');
  writeFileSync(task.result_path, JSON.stringify({ task_id: task.task_id, unit_id: task.context.unit_id, perspective: task.context.perspective, result: '成り立つ', findings: [],
    judgments: [], record_ref: rel(task, 'review.json'), worklog_ref: rel(task, 'worklog.json') }));
}
function writeAuthor(task, n) {
  writeFileSync(join(task.attempt_dir, 'worklog.json'), JSON.stringify({ n }));
  writeFileSync(task.result_path, JSON.stringify({ task_id: task.task_id, status: 'done', outputs: [], questions: [], blocked_by_question: [], reason: null, worklog_ref: rel(task, 'worklog.json') }));
}
const RULES = { ref: `document-rules/${'a'.repeat(64)}.md`, version: `sha256:${'a'.repeat(64)}` };
const defects = (n) => Array.from({ length: n }, (_, i) => ({ kind: 'other', key: `d${i}`, text: `欠陥 ${i}` }));
function closeWith(run, callId, value) {
  const f = join(run.root, `wf-${callId}.json`);
  writeFileSync(f, JSON.stringify(value));
  return close({ run_dir: run.runDir, call_id: callId, workflow_output_path: f });
}
const agentsOf = (n) => ({ agents: Array.from({ length: n }, (_, i) => ({ role: 'extraction-reviewer', label: `r-${i}`, model: 'sonnet', effort: 'high', ok: true })), tokens: 1234 });

describe('call', { concurrency: 4 }, () => {
test('cli-contract 依頼と応答 SP-FORMALMETHOD-015 args: run_agents の call は {call_id, args_path, deadline_wall_ms, workflow_script} で、args は {state, callId, stage, workers} だけ。workers の行は {id, role, model, effort} で model・effort は roles.mjs の値', async (t) => {
  const run = makeRun(t);
  const p = callOf(run, '確認', [{ spec: reviewSpec() }, { spec: authorSpec(), check: () => ({ defects: [], value: null }) }]);
  const call = await waitOpen(run.runDir);
  assert.deepEqual(Object.keys(call).sort(), ['args_path', 'call_id', 'deadline_wall_ms', 'workflow_script']);
  assert.equal(call.workflow_script, WORKFLOW_SCRIPT);
  const args = JSON.parse(readFileSync(call.args_path, 'utf8'));
  assert.deepEqual(Object.keys(args).sort(), ['callId', 'stage', 'state', 'workers']);
  assert.deepEqual([args.state, args.callId, args.stage], [run.runDir, call.call_id, '確認']);
  assert.deepEqual(args.workers.map((w) => Object.keys(w).sort()), [['effort', 'id', 'model', 'role'], ['effort', 'id', 'model', 'role']]);
  for (const w of args.workers) assert.deepEqual([w.model, w.effort], [ROLES[w.role].model, ROLES[w.role].effort], w.role);
  // 役の入口は本物の CLI を import するだけで、台帳に登録しない
  const launcher = readFileSync(join(run.runDir, LAUNCHER), 'utf8');
  assert.ok(launcher.includes(JSON.stringify(new URL(`file://${CLI}`).href)), launcher);
  assert.ok(!run.entries.some((e) => e.ref === LAUNCHER), '入口は台帳に無い');
  assert.equal(closeWith(run, call.call_id, agentsOf(0)).outcome, 'accepted');
  await p;
});

test('cli-contract 依頼と応答 SP-FORMALMETHOD-012 AC-04 query: 担当の外の資料・他の担当の task・workers に無い worker は E_CALL で拒み、担当の資料は path を返して最初の query の時点で指紋を固定する', async (t) => {
  const run = makeRun(t);
  const p = callOf(run, '確認', [{ spec: reviewSpec() }, { spec: reviewSpec() }]);
  const call = await waitOpen(run.runDir);
  const base = { run_dir: run.runDir, call_id: call.call_id };
  const c1 = await workerCall('claim', { ...base, worker: 'w01' });
  const c2 = await workerCall('claim', { ...base, worker: 'w02' });
  assert.equal(c1.ok, true);
  assert.deepEqual(Object.keys(c1.tasks[0].context).sort(), ['candidates', 'model_id', 'perspective', 'property_ids', 'run_dir', 'stage', 'subject', 'target_id', 'unit_id'], 'claim は資料を渡さない');
  const outside = await workerCall('query', { ...base, worker: 'w01', task_id: c1.tasks[0].task_id, refs: ['ledger.json'] });
  assert.deepEqual([outside.ok, outside.code, outside.detail.reason], [false, 'E_CALL', 'outside_task']);
  const other = await workerCall('query', { ...base, worker: 'w01', task_id: c2.tasks[0].task_id });
  assert.deepEqual([other.code, other.detail.reason], ['E_CALL', 'outside_task']);
  const stranger = await workerCall('claim', { ...base, worker: 'w99' });
  assert.deepEqual([stranger.code, stranger.detail.reason], ['E_CALL', 'unknown_worker']);
  const inside = await workerCall('query', { ...base, worker: 'w01', task_id: c1.tasks[0].task_id, refs: ['targets/T1/files/spec.md'] });
  assert.equal(inside.ok, true, JSON.stringify(inside));
  assert.deepEqual(inside.inputs.map((x) => x.path), [join(run.runDir, 'targets/T1/files/spec.md')]);
  const all = await workerCall('query', { ...base, worker: 'w01', task_id: c1.tasks[0].task_id });
  assert.deepEqual(all.inputs.map((x) => x.ref), ['request.json', 'targets/T1/files']);
  // 指紋は最初の query で固定する: その後に資料が変わっても、渡した資料の指紋は変わらない
  writeFileSync(join(run.runDir, 'request.json'), '{"note":"changed"}\n');
  writeReview(c1.tasks[0]);
  const s1 = await workerCall('submit', { ...base, worker: 'w01' });
  assert.deepEqual(s1.results.map((r) => [r.ok, r.done]), [[true, true]]);
  closeWith(run, call.call_id, agentsOf(2));
  const out = await p;
  assert.equal(out[0].ok, true);
  assert.equal(out[0].materials.find((m) => m.ref === 'request.json').hash, sha256Bytes(Buffer.from('{"note":"request"}\n')), '指紋は最初の query の時点の中身');
  assert.deepEqual(out[0].materials.map((m) => m.ref), ['request.json', 'targets/T1/files/spec.md']);
  assert.equal(out[1].ok, false, 'w02 は取ったまま出さなかった');
});

test('cli-contract 依頼と応答 SP-FORMALMETHOD-015 AC-19 submit: 閉じた後の submit と claim は E_CALL call_closed で拒み、取ったまま出さなかった担当はその段の 担当の失敗 になる', async (t) => {
  const run = makeRun(t);
  const p = callOf(run, '確認', [{ spec: reviewSpec() }]);
  const call = await waitOpen(run.runDir);
  const base = { run_dir: run.runDir, call_id: call.call_id, worker: 'w01' };
  const c = await workerCall('claim', base);
  writeReview(c.tasks[0]);
  closeWith(run, call.call_id, agentsOf(1));
  const out = await p;
  const late = await workerCall('submit', base);
  assert.deepEqual([late.ok, late.code, late.detail.reason], [false, 'E_CALL', 'call_closed']);
  const again = await workerCall('claim', base);
  assert.deepEqual([again.code, again.detail.reason], ['E_CALL', 'call_closed']);
  assert.equal(out[0].ok, false);
  assert.match(out[0].cause, new RegExp(`${call.call_id}.*${c.tasks[0].task_id}.*claim したまま submit しなかった`));
  assert.deepEqual(run.agentFailures.map((x) => [x.code, x.stage, x.detail]), [['担当の失敗', '確認', out[0].cause]]);
});

test('cli-contract 依頼と応答 run の領域の配置: 閉じた呼び出しの requests/<call_id>/ と responses/<call_id>/ は、閉じた直後は client が応答を読み直せるよう残し、次の呼び出しを開くときに消す（受け渡しの口で、記録ではない）', async (t) => {
  const run = makeRun(t);
  const p = callOf(run, '確認', [{ spec: reviewSpec() }]);
  const call = await waitOpen(run.runDir);
  const base = { run_dir: run.runDir, call_id: call.call_id, worker: 'w01' };
  const c = await workerCall('claim', base);
  writeReview(c.tasks[0]);
  assert.equal((await workerCall('submit', base)).results[0].ok, true);
  assert.ok(existsSync(join(run.runDir, 'requests', call.call_id)) && existsSync(join(run.runDir, 'responses', call.call_id)), '開いている間は依頼と応答がある');
  closeWith(run, call.call_id, agentsOf(1));
  const out = await p;
  assert.equal(out[0].ok, true);
  assert.equal(readStatus(run.runDir).action, 'working', '呼び出しを閉じた status を書いた');
  assert.ok(existsSync(join(run.runDir, 'responses', call.call_id)), '閉じた直後は、最後の drain の応答を client が読み直せる');
  const late = await workerCall('claim', base);
  assert.deepEqual([late.code, late.detail.reason], ['E_CALL', 'call_closed']);
  const p2 = callOf(run, '確認', [{ spec: reviewSpec() }]);
  const call2 = await waitOpen(run.runDir);
  assert.notEqual(call2.call_id, call.call_id);
  assert.equal(existsSync(join(run.runDir, 'requests', call.call_id)), false, '次の呼び出しを開くとき、閉じた呼び出しの依頼を消す');
  assert.equal(existsSync(join(run.runDir, 'responses', call.call_id)), false, '次の呼び出しを開くとき、閉じた呼び出しの応答を消す');
  assert.ok(existsSync(join(run.runDir, 'requests', call2.call_id)), '開いた呼び出しの置き場は残す');
  close({ run_dir: run.runDir, call_id: call2.call_id, timed_out: true });
  await p2;
  run.removeClosedExchanges();
  assert.equal(existsSync(join(run.runDir, 'responses', call2.call_id)), false, '集約と同じく、最後の呼び出しの分も消せる');
});

test('cli-contract 依頼と応答 SP-FORMALMETHOD-015 AC-19 submit: 期限の後の submit は受理せず E_CALL で拒み、その担当は 担当の失敗 になる', async (t) => {
  const run = makeRun(t, { deadlineMs: 600 });
  const p = callOf(run, '確認', [{ spec: reviewSpec() }]);
  const call = await waitOpen(run.runDir);
  const base = { run_dir: run.runDir, call_id: call.call_id, worker: 'w01' };
  const c = await workerCall('claim', base);
  writeReview(c.tasks[0]);
  await sleep(Math.max(0, call.deadline_wall_ms - Date.now()) + 50);
  const s = await workerCall('submit', base);
  assert.equal(s.ok, false, JSON.stringify(s));
  assert.equal(s.code, 'E_CALL');
  // 期限の後に run-daemon が処理すれば deadline_passed、期限で閉じた後なら call_closed（どちらも提出を受け付けない）
  assert.ok(['deadline_passed', 'call_closed'].includes(s.detail.reason), s.detail.reason);
  const out = await p;
  assert.equal(out[0].ok, false);
  assert.equal(run.agentFailures.length, 1);
  assert.ok(run.log('確認').unconfirmed.some((x) => x.includes('期限で閉じた')), JSON.stringify(run.log('確認').unconfirmed));
});

test('cli-contract 受け箱 SP-FORMALMETHOD-013 close: 包んだ返り値（{summary, agentCount, logs, result}）でも timed_out でも、submit で受理した成果物は残り、起動の記録と tokens だけを記録する（batch ごと拒否しない）', async (t) => {
  for (const mode of ['wrapped', 'timed_out', 'broken']) {
    const run = makeRun(t);
    const p = callOf(run, '確認', [{ spec: reviewSpec() }]);
    const call = await waitOpen(run.runDir);
    const base = { run_dir: run.runDir, call_id: call.call_id, worker: 'w01' };
    const c = await workerCall('claim', base);
    await workerCall('query', { ...base, task_id: c.tasks[0].task_id });
    writeReview(c.tasks[0]);
    assert.equal((await workerCall('submit', base)).results[0].ok, true);
    if (mode === 'wrapped') closeWith(run, call.call_id, { summary: '1 体', agentCount: 1, logs: [], result: agentsOf(1) });
    else if (mode === 'timed_out') close({ run_dir: run.runDir, call_id: call.call_id, timed_out: true });
    else close({ run_dir: run.runDir, call_id: call.call_id, workflow_output_path: join(run.root, 'missing.json') });
    const out = await p;
    assert.equal(out[0].ok, true, `${mode}: ${out[0].cause}`);
    assert.equal(out[0].ret.result, '成り立つ');
    assert.deepEqual(run.agentFailures, [], mode);
    const rec = run.calls[0];
    if (mode === 'wrapped') assert.deepEqual([rec.closed_by, rec.agents.length, rec.tokens], ['close', 1, 1234]);
    else assert.deepEqual([rec.agents, rec.tokens], [null, null], mode);
  }
  assert.deepEqual(unwrap({ summary: 's', agentCount: 0, logs: [], result: { agents: [], tokens: null } }), { agents: [], tokens: null });
});

test('architecture 修正の巡: 作成役が 1 回目の提出で欠陥を返されると、同じ worker が同じ task を出し直し、欠陥の無い 2 回目で受理される', async (t) => {
  const run = makeRun(t);
  let n = 0;
  const check = () => { n += 1; return { defects: n === 1 ? defects(2) : [], value: { n } }; };
  const p = callOf(run, 'モデル化', [{ spec: authorSpec(), check }]);
  const call = await waitOpen(run.runDir);
  const base = { run_dir: run.runDir, call_id: call.call_id, worker: 'w01' };
  const c = await workerCall('claim', base);
  writeAuthor(c.tasks[0], 1);
  const r1 = (await workerCall('submit', base)).results[0];
  assert.deepEqual([r1.ok, r1.done, r1.problems], [false, false, ['欠陥 0', '欠陥 1']]);
  assert.deepEqual(run.revisions, [{ task_id: c.tasks[0].task_id, submit: 1, stage: 'モデル化', defects: defects(2).map((d) => ({ key: d.key, text: d.text })) }], '出し直しの欠陥を台帳の revisions に記録する');
  assert.deepEqual(run.ledgerContent().revisions, run.revisions, '台帳の内容に載る');
  assert.equal(existsSync(join(run.runDir, 'revisions')), false, '欠陥を別のファイルに書かない');
  // 同じ worker の claim は同じ task を返す（新しい task を出さない）
  assert.equal((await workerCall('claim', base)).tasks[0].task_id, c.tasks[0].task_id);
  writeAuthor(c.tasks[0], 2);
  const r2 = (await workerCall('submit', base)).results[0];
  assert.deepEqual([r2.ok, r2.done], [true, true]);
  assert.equal((await workerCall('claim', base)).done, true);
  closeWith(run, call.call_id, agentsOf(1));
  const out = await p;
  assert.deepEqual([out[0].ok, out[0].last.value, out[0].last.defects], [true, { n: 2 }, []]);
  assert.equal(run.taskNo, 1, 'task は 1 つだけ');
});

test('architecture 修正の巡: 欠陥が前の提出より減らない 2 回目は、残った欠陥ごと受理して打ち切る。提出は REVISE_ROUNDS_MAX + 1 回まで', async (t) => {
  assert.equal(SUBMITS_MAX, REVISE_ROUNDS_MAX + 1);
  for (const [name, counts, accepted] of [['減らない', [2, 2], 2], ['減り続けても上限で打ち切る', [3, 2, 1], SUBMITS_MAX]]) {
    const run = makeRun(t);
    let n = 0;
    const check = () => { const k = counts[Math.min(n, counts.length - 1)]; n += 1; return { defects: defects(k), value: null }; };
    const p = callOf(run, 'モデル化', [{ spec: authorSpec(), check }]);
    const call = await waitOpen(run.runDir);
    const base = { run_dir: run.runDir, call_id: call.call_id, worker: 'w01' };
    const c = await workerCall('claim', base);
    const rs = [];
    for (let i = 1; i <= 5; i += 1) {
      writeAuthor(c.tasks[0], i);
      const r = (await workerCall('submit', base)).results[0];
      rs.push(r);
      if (r.done) break;
    }
    assert.equal(rs.length, accepted, `${name}: 提出の回数`);
    const last = rs.at(-1);
    assert.deepEqual([last.ok, last.done], [true, true], name);
    assert.equal(last.remaining.length, counts[accepted - 1], `${name}: 残った欠陥を返す`);
    closeWith(run, call.call_id, agentsOf(1));
    const out = await p;
    assert.equal(out[0].ok, true, name);
    assert.equal(out[0].last.defects.length, counts[accepted - 1]);
  }
});

test('artifact-formats 担当の返り値 SP-FORMALMETHOD-015 AC-19: 形の違う提出は直して出し直せ、上限まで直らなければ 担当の失敗。cannot_proceed は出し直させずに 担当の失敗', async (t) => {
  for (const [name, write, submits] of [['形の違い', (task) => writeFileSync(task.result_path, '{"task_id": 1}'), SUBMITS_MAX],
    ['cannot_proceed', (task) => { writeFileSync(join(task.attempt_dir, 'worklog.json'), '{}'); writeFileSync(task.result_path, JSON.stringify({ task_id: task.task_id, status: 'cannot_proceed', outputs: [], questions: [], blocked_by_question: [], reason: '進めない', worklog_ref: rel(task, 'worklog.json') })); }, 1]]) {
    const run = makeRun(t);
    const p = callOf(run, 'モデル化', [{ spec: authorSpec(), check: () => ({ defects: [], value: null }) }]);
    const call = await waitOpen(run.runDir);
    const base = { run_dir: run.runDir, call_id: call.call_id, worker: 'w01' };
    const c = await workerCall('claim', base);
    let k = 0;
    for (; k < 5; k += 1) {
      write(c.tasks[0]);
      const r = (await workerCall('submit', base)).results[0];
      assert.equal(r.ok, false, name);
      if (r.done) break;
    }
    assert.equal(k + 1, submits, `${name}: 提出の回数`);
    closeWith(run, call.call_id, agentsOf(1));
    const out = await p;
    assert.equal(out[0].ok, false, name);
    assert.deepEqual(run.agentFailures.map((x) => x.stage), ['モデル化'], name);
  }
});


// ---- 1 体に詰めた担当（architecture.md「担当の起動」の起動の理由、cli-contract.md「依頼と応答」） ----
const reviewSpecN = (n) => ({ ...reviewSpec(), unit_id: `extraction-T${n}`, target_id: `T${n}` });
const causeSpecN = (n) => ({ role: 'cause-analyst', stage: '確認', unit_id: `cause-counterexample-cex-${n}`, subject: { kind: 'counterexample', id: `cex-${n}` }, input_refs: [{ name: 'request', ref: 'request.json' }] });
function writeCause(task) {
  writeFileSync(join(task.attempt_dir, 'worklog.json'), '{}');
  writeFileSync(join(task.attempt_dir, 'cause.json'), '{}');
  writeFileSync(task.result_path, JSON.stringify({ task_id: task.task_id, unit_id: task.context.unit_id, cause: '対象が性質を満たさない', grounds: '根拠', questions: [],
    record_ref: rel(task, 'cause.json'), worklog_ref: rel(task, 'worklog.json') }));
}

test('SP-FORMALMETHOD-013 AC-12 詰め合わせ: 1 体に詰めた担当は 1 回の claim で全て返り、submit は返り値を書いた担当ごとに受理か拒否を返す', async (t) => {
  const run = makeRun(t);
  const p = runCall(run, { stage: '確認', workers: [{ items: [1, 2, 3].map((n) => ({ spec: reviewSpecN(n) })) }] });
  const call = await waitOpen(run.runDir);
  const args = JSON.parse(readFileSync(call.args_path, 'utf8'));
  assert.deepEqual(args.workers.map((w) => [w.id, w.role]), [['w01', 'extraction-reviewer']], '3 つの担当で 1 体');
  const base = { run_dir: run.runDir, call_id: call.call_id, worker: 'w01' };
  const c = await workerCall('claim', base);
  assert.deepEqual(c.tasks.map((x) => x.context.unit_id), ['extraction-T1', 'extraction-T2', 'extraction-T3']);
  assert.equal(typeof c.submit_cmd, 'string', 'submit の命令は worker で 1 つ（応答の最上位）');
  assert.ok(c.tasks.every((x) => !('submit_cmd' in x)), 'task は submit の命令を持たない');
  // 2 つだけ書いて出すと、その 2 つだけを照合して受理する
  writeReview(c.tasks[0]);
  writeReview(c.tasks[1]);
  const s1 = await workerCall('submit', base);
  assert.deepEqual(s1.results.map((r) => [r.task_id, r.ok, r.done]), [[c.tasks[0].task_id, true, true], [c.tasks[1].task_id, true, true]]);
  // 出し終えていない担当だけを claim が返す
  assert.deepEqual((await workerCall('claim', base)).tasks.map((x) => x.task_id), [c.tasks[2].task_id]);
  // 形の違う返り値はその担当だけ拒む
  writeFileSync(c.tasks[2].result_path, '{"task_id": 1}');
  const s2 = await workerCall('submit', base);
  assert.deepEqual(s2.results.map((r) => [r.task_id, r.ok, r.done]), [[c.tasks[2].task_id, false, false]]);
  writeReview(c.tasks[2]);
  assert.deepEqual((await workerCall('submit', base)).results.map((r) => [r.ok, r.done]), [[true, true]]);
  assert.equal((await workerCall('claim', base)).done, true);
  closeWith(run, call.call_id, agentsOf(1));
  const [w] = await p;
  assert.deepEqual(w.results.map((r) => r.ok), [true, true, true]);
  assert.equal(run.calls[0].tasks, 3);
});

test('architecture 担当の起動: 1 つの段の担当は、体の数によらず 1 回の呼び出しで起動する（確認の段で 6 体なら、呼び出しは 1 つで args の workers は 6 件）', async (t) => {
  const run = makeRun(t);
  const p = runWorkers(run, [1, 2, 3, 4, 5, 6].map((n) => ({ items: [{ spec: reviewSpecN(n) }] })));
  let settled = false;
  p.then(() => { settled = true; }, () => { settled = true; });
  // 開いた呼び出しを全て記録して閉じる（呼び出しを分ける実装でも、残りの呼び出しで止まらない）
  const opened = [];
  for (let i = 0; !settled && i < 500; i += 1) {
    const s = readStatus(run.runDir);
    if (s?.action === 'run_agents' && !opened.some((c) => c.call_id === s.call.call_id)) {
      opened.push({ call_id: s.call.call_id, args: JSON.parse(readFileSync(s.call.args_path, 'utf8')) });
      closeWith(run, s.call.call_id, agentsOf(0));
    }
    await sleep(20);
  }
  const out = await p;
  assert.equal(opened.length, 1, `呼び出しは 1 つ: ${JSON.stringify(opened.map((c) => [c.call_id, c.args.workers.length]))}`);
  assert.equal(opened[0].args.stage, '確認');
  assert.deepEqual(opened[0].args.workers.map((w) => w.id), ['w01', 'w02', 'w03', 'w04', 'w05', 'w06']);
  assert.equal(run.calls.length, 1);
  assert.equal(out.length, 6, '戻り値は workers と同じ順の 6 件');
});

test('SP-FORMALMETHOD-008・013 依存つきの担当: 分割と計画を 1 体が順に担い、計画の担当は分割の担当が閉じるまで claim に出ず、分割を受理した submit の next で返る。閉じた時点で分割の結果を渡す', async (t) => {
  const run = makeRun(t);
  const order = [];
  const part = { role: 'partition-author', stage: '計画', candidates: [{ id: 'C1', nodes: ['n1'] }], input_refs: [{ name: 'request', ref: 'request.json' }] };
  const plan = { role: 'plan-author', stage: '計画', property_ids: ['P1'], input_refs: [{ name: 'request', ref: 'request.json' }] };
  const items = [
    { spec: part, check: () => ({ defects: [], value: null }), settle: (r) => order.push(['part', r.ok]) },
    { role: 'plan-author', stage: '計画', spec: () => { order.push(['plan-spec']); return plan; }, check: () => ({ defects: [], value: null }), after: 0, settle: (r) => order.push(['plan', r.ok]) },
  ];
  const p = runCall(run, { stage: '計画', workers: [{ items }] });
  const call = await waitOpen(run.runDir);
  const args = JSON.parse(readFileSync(call.args_path, 'utf8'));
  assert.deepEqual(args.workers.map((w) => w.role), ['partition-author+plan-author']);
  const base = { run_dir: run.runDir, call_id: call.call_id, worker: 'w01' };
  const c1 = await workerCall('claim', base);
  assert.deepEqual(c1.tasks.map((x) => x.role), ['partition-author'], '最初は分割の担当だけ');
  assert.deepEqual(order, [], '計画の spec はまだ作らない');
  writeAuthor(c1.tasks[0], 1);
  const s1 = await workerCall('submit', base);
  assert.equal(s1.results[0].done, true);
  assert.deepEqual(order[0], ['part', true], '分割の担当が閉じた時点で結果を渡す');
  assert.deepEqual(s1.next?.tasks?.map((x) => x.role), ['plan-author'], `分割を受理した submit の next が計画の担当: ${JSON.stringify(s1.next)}`);
  assert.deepEqual(order, [['part', true], ['plan-spec']], '計画の spec は分割の結果を受けた後（next を作る時点）で作る');
  writeAuthor(s1.next.tasks[0], 1);
  const s2 = await workerCall('submit', base);
  assert.equal(s2.results[0].done, true);
  assert.deepEqual(s2.next, { done: true }, '最後の受理の next は done: true（終わりの claim は要らない）');
  closeWith(run, call.call_id, agentsOf(1));
  const [w] = await p;
  assert.deepEqual(w.results.map((r) => r.ok), [true, true]);
  assert.deepEqual(order.at(-1), ['plan', true]);
});

test('SP-FORMALMETHOD-015 AC-19 依存つきの担当: 分割の担当が閉じないまま呼び出しが閉じたら、計画の担当は出さず、その段の 担当の失敗 にする', async (t) => {
  const run = makeRun(t);
  const part = { role: 'partition-author', stage: '計画', candidates: [{ id: 'C1', nodes: ['n1'] }], input_refs: [{ name: 'request', ref: 'request.json' }] };
  const items = [{ spec: part, check: () => ({ defects: [], value: null }) },
    { role: 'plan-author', stage: '計画', spec: () => ({ role: 'plan-author', stage: '計画', property_ids: ['P1'], input_refs: [] }), after: 0 }];
  const p = runCall(run, { stage: '計画', workers: [{ items }] });
  const call = await waitOpen(run.runDir);
  await workerCall('claim', { run_dir: run.runDir, call_id: call.call_id, worker: 'w01' });
  closeWith(run, call.call_id, agentsOf(1));
  const [w] = await p;
  assert.deepEqual(w.results.map((r) => [r.ok, Boolean(r.dependency)]), [[false, false], [false, true]]);
  assert.equal(run.agentFailures.length, 2);
  assert.ok(run.agentFailures.every((x) => x.stage === '計画'));
  assert.match(run.agentFailures[1].detail, /依存する担当が閉じる前に呼び出しが閉じた/);
});

test('SP-FORMALMETHOD-011・013 原因の束: mode fit の worker は claim ごとに上限までの束を取り、束を取ったまま 1 件も出さなければ手放して次の束の上限を半分にする', async (t) => {
  const items = [1, 2, 3].map((n) => ({ spec: causeSpecN(n), bytes: 10 }));
  // 1 回目の呼び出し: 3 件の束を取って出さない
  const run = makeRun(t);
  const p1 = runCall(run, { stage: '確認', workers: [{ mode: 'fit', cap: 100, items }] });
  const call1 = await waitOpen(run.runDir);
  const b1 = { run_dir: run.runDir, call_id: call1.call_id, worker: 'w01' };
  assert.equal((await workerCall('claim', b1)).tasks.length, 3);
  closeWith(run, call1.call_id, agentsOf(1));
  const [w1] = await p1;
  assert.deepEqual(w1.results.map((r) => Boolean(r.released)), [true, true, true], '手放す');
  assert.equal(w1.nextCap, 15, '束の量 30 の半分');
  assert.deepEqual(run.agentFailures, [], '手放した担当は 担当の失敗 にしない');
  // 2 回目の呼び出し: 上限 15 では 1 件ずつの束になり、出し終えるたびに次の束を返す
  const p2 = runCall(run, { stage: '確認', workers: [{ mode: 'fit', cap: w1.nextCap, items }] });
  const call2 = await waitOpen(run.runDir);
  const b2 = { run_dir: run.runDir, call_id: call2.call_id, worker: 'w01' };
  const seen = [];
  for (;;) {
    const c = await workerCall('claim', b2);
    if (c.done) break;
    seen.push(c.tasks.length);
    for (const task of c.tasks) writeCause(task);
    assert.ok((await workerCall('submit', b2)).results.every((r) => r.ok));
  }
  assert.deepEqual(seen, [1, 1, 1]);
  closeWith(run, call2.call_id, agentsOf(1));
  const [w2] = await p2;
  assert.deepEqual(w2.results.map((r) => r.ok), [true, true, true]);
  assert.equal(w2.nextCap, UNIT_MAX_BYTES, '1 件以上出した呼び出しの後は上限を戻す');
});

test('SP-FORMALMETHOD-015 AC-19 原因の束: 1 件の束を取ったまま出さなかった担当は手放さず 担当の失敗 にし、1 件以上出した worker の取り残しは手放す', async (t) => {
  const run = makeRun(t);
  const p = runCall(run, { stage: '確認', workers: [{ mode: 'fit', cap: 10, items: [1, 2].map((n) => ({ spec: causeSpecN(n), bytes: 10 })) }] });
  const call = await waitOpen(run.runDir);
  const base = { run_dir: run.runDir, call_id: call.call_id, worker: 'w01' };
  assert.equal((await workerCall('claim', base)).tasks.length, 1);
  closeWith(run, call.call_id, agentsOf(1));
  const [w] = await p;
  assert.deepEqual(w.results.map((r) => [r.ok, Boolean(r.released)]), [[false, false], [false, true]], '取った 1 件は失敗、取っていない 1 件は手放す');
  assert.equal(run.agentFailures.length, 1);
  assert.match(run.agentFailures[0].detail, /claim したまま submit しなかった/);
});

// ---- 検証役の指摘への回帰（呼び出しの口） ----
test('SP-FORMALMETHOD-015 AC-19 呼び出しを開けない: 中断の理由があって呼び出しを開かないとき、settle を持つ担当（分割・計画）にも結果を渡し、unit の onFail が成果物を作れなかった記録にする', async (t) => {
  const run = makeRun(t);
  run.interrupt('時間の上限', 'テストで止めた');
  const unit = { accept: () => assert.fail('受理しない'), onFail: (why) => run.notCreatedFor('plan-author', why) };
  const got = [];
  const items = [{ spec: authorSpec(), check: () => ({ defects: [], value: null }), settle: (r) => { got.push(r); run.settleAuthor(unit, r); } }];
  const [w] = await runCall(run, { stage: '計画', workers: [{ items }] });
  assert.deepEqual(w.results.map((r) => [r.ok, r.notIssued]), [[false, true]]);
  assert.equal(got.length, 1, 'settle が 1 度呼ばれる');
  assert.deepEqual(run.notCreated.map((x) => x.kind), ['plan', 'mutations']);
  assert.ok(run.notCreated.every((x) => /中断の理由/.test(x.reason)), JSON.stringify(run.notCreated));
});

test('SP-FORMALMETHOD-015 AC-19 architecture 担当の起動: 受理した後に attempt の領域が書き換わった担当は、閉じた時点で 担当の失敗 にし、settle で渡した受理は revoke で取り消す', async (t) => {
  const run = makeRun(t);
  const revoked = [];
  const items = [
    { spec: { role: 'partition-author', stage: '計画', candidates: [{ id: 'C1', nodes: ['n1'] }], input_refs: [{ name: 'request', ref: 'request.json' }] }, check: () => ({ defects: [], value: null }), settle: () => {}, revoke: (r) => revoked.push(r) },
    { spec: { role: 'plan-author', stage: '計画', property_ids: ['P1'], input_refs: [{ name: 'request', ref: 'request.json' }] }, check: () => ({ defects: [], value: null }) },
  ];
  const p = runCall(run, { stage: '計画', workers: [{ items: [items[0]] }, { items: [items[1]] }] });
  const call = await waitOpen(run.runDir);
  const tasks = [];
  for (const worker of ['w01', 'w02']) {
    const base = { run_dir: run.runDir, call_id: call.call_id, worker };
    const c = await workerCall('claim', base);
    writeAuthor(c.tasks[0], 1);
    assert.deepEqual((await workerCall('submit', base)).results.map((r) => [r.ok, r.done]), [[true, true]], worker);
    tasks.push(c.tasks[0]);
    writeFileSync(join(c.tasks[0].attempt_dir, 'late.txt'), '受理の後に書いた');
  }
  closeWith(run, call.call_id, agentsOf(2));
  const out = await p;
  for (const w of out) {
    assert.equal(w.results[0].ok, false);
    assert.match(w.results[0].cause, /受理した後に attempt の領域のファイルが書き換わった/);
  }
  assert.equal(revoked.length, 1, '閉じる前に渡した受理だけを取り消す');
  assert.equal(revoked[0].task.task_id, tasks[0].task_id);
  assert.deepEqual(run.agentFailures.map((x) => x.stage), ['計画', '計画']);
});

test('SP-FORMALMETHOD-015 architecture 修正の巡: 出し直しを求めた後に提出が無いまま閉じた担当は、ファイルが変わっていなければ前の提出を残った欠陥ごと受理し、変わっていれば 担当の失敗 にする', async (t) => {
  for (const touched of [false, true]) {
    const run = makeRun(t);
    const p = callOf(run, 'モデル化', [{ spec: authorSpec(), check: () => ({ defects: defects(2), value: { n: 1 } }) }]);
    const call = await waitOpen(run.runDir);
    const base = { run_dir: run.runDir, call_id: call.call_id, worker: 'w01' };
    const c = await workerCall('claim', base);
    writeAuthor(c.tasks[0], 1);
    assert.deepEqual((await workerCall('submit', base)).results.map((r) => [r.ok, r.done]), [[false, false]]);
    if (touched) writeAuthor(c.tasks[0], 2);
    closeWith(run, call.call_id, agentsOf(1));
    const [r] = await p;
    if (!touched) {
      assert.deepEqual([r.ok, r.last.value, r.last.defects.length], [true, { n: 1 }, 2]);
      assert.deepEqual(run.agentFailures, []);
    } else {
      assert.equal(r.ok, false);
      assert.match(r.cause, /最後の提出が受理されないまま閉じた/);
    }
  }
});

test('SP-FORMALMETHOD-015 cli-contract 依頼と応答: 応答の待ちの上限（no_response）の後に同じ submit を流し直しても、照合し直さず前の応答を返し、提出の回数を増やさない。見た応答の後の同じ提出は照合する', async (t) => {
  const run = makeRun(t);
  let n = 0;
  const check = () => { n += 1; return { defects: defects(2), value: { n } }; };
  const p = callOf(run, 'モデル化', [{ spec: authorSpec(), check }]);
  const call = await waitOpen(run.runDir);
  const base = { run_dir: run.runDir, call_id: call.call_id, worker: 'w01' };
  const c = await workerCall('claim', base);
  writeAuthor(c.tasks[0], 1);
  // 依頼の公開から WORKER_CALL_MAX_MS 後に応答した submit（client は no_response で諦めた）を、req_id の時刻を戻して作る
  const shifted = { now: () => Date.now() - WORKER_CALL_MAX_MS };
  const first = await workerCall('submit', base, shifted);
  assert.deepEqual(first.results.map((r) => [r.ok, r.done]), [[false, false]], '1 回目は出し直しを求める');
  const again = await workerCall('submit', base);
  assert.deepEqual(again, first, '流し直しは前の応答と同じ');
  assert.equal(n, 1, '流し直しは照合し直さない');
  assert.deepEqual(run.revisions.map((x) => [x.task_id, x.submit]), [[c.tasks[0].task_id, 1]]);
  // 前の応答を見た後の同じ提出は、直せなかった提出として照合し、欠陥が減らないので残った欠陥ごと受理する（2 回目の提出）
  const third = (await workerCall('submit', base)).results[0];
  assert.deepEqual([third.ok, third.done, third.remaining.length, n], [true, true, 2, 2]);
  closeWith(run, call.call_id, agentsOf(1));
  const [r] = await p;
  assert.deepEqual([r.ok, r.last.value], [true, { n: 2 }]);
});

test('SP-FORMALMETHOD-013・015 cli-contract 依頼と応答: 束の worker が no_response の後に同じ submit を流し直しても、返り値の無い担当を照合せず、取り残しを 担当の失敗 にしない', async (t) => {
  const run = makeRun(t);
  const p = runCall(run, { stage: '確認', workers: [{ mode: 'fit', cap: 100, items: [1, 2, 3].map((n) => ({ spec: causeSpecN(n), bytes: 10 })) }] });
  const call = await waitOpen(run.runDir);
  const base = { run_dir: run.runDir, call_id: call.call_id, worker: 'w01' };
  const c = await workerCall('claim', base);
  writeCause(c.tasks[0]);
  const first = await workerCall('submit', base, { now: () => Date.now() - WORKER_CALL_MAX_MS });
  assert.deepEqual(first.results.map((r) => [r.task_id, r.ok]), [[c.tasks[0].task_id, true]]);
  assert.deepEqual(await workerCall('submit', base), first, '流し直しは前の応答と同じ（残りの担当を照合しない）');
  closeWith(run, call.call_id, agentsOf(1));
  const [w] = await p;
  assert.deepEqual(w.results.map((r) => [r.ok, Boolean(r.released)]), [[true, false], [false, true], [false, true]], '出していない担当は手放す');
  assert.deepEqual(run.agentFailures, []);
});

test('SP-FORMALMETHOD-012 cli-contract 依頼と応答 query: refs の .. と . は畳んでから担当の資料と照らし、担当の資料の外へ出る ref と絶対の path は拒む', async (t) => {
  const run = makeRun(t);
  const p = callOf(run, '確認', [{ spec: reviewSpec() }]);
  const call = await waitOpen(run.runDir);
  const base = { run_dir: run.runDir, call_id: call.call_id, worker: 'w01' };
  const c = await workerCall('claim', base);
  const q = (refs) => workerCall('query', { ...base, task_id: c.tasks[0].task_id, refs });
  for (const ref of ['targets/T1/files/../../../ledger.json', 'targets/T1/files/../manifest.json', '../run1/ledger.json', join(run.runDir, 'ledger.json')]) {
    const r = await q([ref]);
    assert.deepEqual([r.ok, r.detail?.reason], [false, 'outside_task'], ref);
  }
  const ok = await q(['targets/T1/./files/spec.md']);
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.deepEqual(ok.inputs.map((x) => [x.ref, x.path]), [['targets/T1/files/spec.md', join(run.runDir, 'targets/T1/files/spec.md')]]);
  closeWith(run, call.call_id, agentsOf(1));
  await p;
});

test('SP-FORMALMETHOD-015 AC-19 cli-contract submit の next 依存つきの担当: 分割の照合の間に呼び出しの期限を越えたら、next は期限を求め直して計画の task を作らずに done: true を返し、計画の担当は期限を過ぎていたと書く（依存する担当が閉じる前とは書かない）', async (t) => {
  const run = makeRun(t, { deadlineMs: 1500 });
  let deadline = Infinity;
  let planSpecs = 0;
  let base = null;
  let resent = null;
  // 分割の照合が期限を越えるまで掛かる（依頼を受けた時点では期限の前）。照合の間に同じ submit を公開する（workerCall は依頼を同期で公開する）。
  // run-daemon は、それを期限の後（閉じる前の最後の処理）に処理する
  const slow = () => {
    resent = workerCall('submit', base);
    while (Date.now() < deadline + 100) { /* 期限を越えるまで待つ */ }
    return { defects: [], value: null };
  };
  const items = [{ spec: partSpec(), check: slow },
    { role: 'plan-author', stage: '計画', spec: () => { planSpecs += 1; return planSpec(); }, after: 0 }];
  const p = runCall(run, { stage: '計画', workers: [{ items }] });
  const call = await waitOpen(run.runDir);
  deadline = call.deadline_wall_ms;
  base = { run_dir: run.runDir, call_id: call.call_id, worker: 'w01' };
  const c = await workerCall('claim', base);
  assert.deepEqual(c.tasks.map((x) => x.role), ['partition-author']);
  writeAuthor(c.tasks[0], 1);
  const s = await workerCall('submit', base);
  assert.deepEqual(s.results.map((r) => [r.ok, r.done]), [[true, true]], JSON.stringify(s));
  assert.deepEqual(s.next, { done: true }, '照合の後に期限を求め直し、期限の後は新しい task を作らない');
  // 受理の後の同じ submit が期限の後に届いても、結果を返し、claim の規則の拒否（deadline_passed）を next: {done: true} に変える
  const r = await resent;
  assert.deepEqual([r.ok, r.results?.map((x) => [x.ok, x.done]), r.next], [true, [[true, true]], { done: true }], JSON.stringify(r));
  assert.equal(planSpecs, 0, '計画の task を作らない');
  const [w] = await p;
  assert.deepEqual(w.results.map((r) => [r.ok, Boolean(r.dependency)]), [[true, false], [false, true]]);
  assert.equal(run.agentFailures.length, 1);
  assert.match(run.agentFailures[0].detail, /依存する担当が閉じた時点で呼び出しの期限を過ぎていた/);
  assert.doesNotMatch(run.agentFailures[0].detail, /閉じる前に/);
  const record = JSON.parse(readFileSync(join(run.runDir, 'calls', call.call_id, 'tasks.json'), 'utf8'));
  assert.deepEqual(record.tasks.map((x) => x.task.role), ['partition-author']);
});

test('SP-FORMALMETHOD-008・015 AC-19 結合: 分割の担当が受理された後に attempt の領域が書き換わると、分割の受理を取り消し（台帳に登録せず、分割を採らない）、計画の段の 担当の失敗 にする', async (t) => {
  const close = (s, call) => {
    const pt = call.tasks.find((x) => x.role === 'partition-author');
    if (pt) writeFileSync(join(pt.attempt_dir, 'late.txt'), '受理の後に書いた');
    return null;
  };
  const { result, harness } = await runScenario(t, { scenario: PART_SCENARIO(), hooks: { close } });
  assert.deepEqual(resultInvariants(result), []);
  const pt = harness.memory.tasks.find((x) => x.role === 'partition-author');
  assert.ok(pt);
  assert.equal(result.decomposition.adopted, false);
  assert.ok(result.stop_report.artifacts_not_created.some((x) => x.kind === 'partitions'), JSON.stringify(result.stop_report.artifacts_not_created));
  assert.ok(result.stop_report.reasons.some((x) => x.code === '担当の失敗' && x.stage === '計画' && x.detail.includes(pt.task_id) && x.detail.includes('受理した後に attempt の領域のファイルが書き換わった')), JSON.stringify(result.stop_report.reasons));
  assert.ok(!result.stop_report.artifacts_created.some((x) => x.ref.startsWith(`attempts/${pt.task_id}/`)), '取り消した担当の記録を登録しない');
  assert.ok(!result.checks.some((c) => (c.kind === 'contract' || c.kind === 'composition') && c.verdict === '成功'), '取り消した分割の検査を実行しない');
});

test('SP-FORMALMETHOD-008・015 AC-19 結合: 計画の担当が閉じる時点で受理され、同じ worker の分割の受理が同時に取り消されても（取り消しが計画の受理より先）、契約・合成の条件の検査を実行しない', async (t) => {
  const close = (s, call) => {
    const pt = call.tasks.find((x) => x.role === 'partition-author');
    if (pt) writeFileSync(join(pt.attempt_dir, 'late.txt'), '受理の後に書いた');
    return null;
  };
  // 計画は 1 回目に欠陥（sanity の時間の上限）を返され、harness は出し直さずに worker を終える（閉じた時点で前の提出を受理する）
  const editPlan = (plan, { round }) => (round === 1 ? { ...plan, sanity: plan.sanity.map((x) => ({ ...x, tool_time_limit_seconds: 100000 })) } : plan);
  const { result, harness } = await runScenario(t, { scenario: { ...PART_SCENARIO(), editPlan, stopAfterSubmits: { 'plan-author': 1 } }, hooks: { close } });
  assert.deepEqual(resultInvariants(result), []);
  const plans = harness.memory.submits.filter((x) => x.role === 'plan-author');
  assert.deepEqual(plans.map((x) => [x.result.ok, x.result.done]), [[false, false]], '計画は閉じる時点で受理される');
  assert.ok(harness.memory.tasks.some((x) => x.role === 'plan-author'));
  assert.equal(result.decomposition.adopted, false);
  assert.ok(result.checks.length >= 1, '計画は採られている');
  assert.ok(!result.checks.some((c) => c.kind === 'contract' || c.kind === 'composition'), JSON.stringify(result.checks.map((c) => [c.id, c.kind])));
  assert.ok(!result.performance.executions.some((x) => x.kind === 'contract' || x.kind === 'composition'), '取り消した分割の query を読む検査を実行しない');
  assert.ok(result.unverified.some((u) => /分割の受理を取り消した/.test(u.reason)), JSON.stringify(result.unverified));
});

// 流し直しの判定の境界（cli-contract.md「依頼と応答」の流し直し）。req_id の時刻は client の now で決まるので、その時刻をずらして作る
async function revisingCall(t) {
  const run = makeRun(t);
  const counter = { n: 0 };
  const check = () => { counter.n += 1; return { defects: defects(2), value: { n: counter.n } }; };
  const p = callOf(run, 'モデル化', [{ spec: authorSpec(), check }]);
  const call = await waitOpen(run.runDir);
  const base = { run_dir: run.runDir, call_id: call.call_id, worker: 'w01' };
  const c = await workerCall('claim', base);
  writeAuthor(c.tasks[0], 1);
  const done = async () => { closeWith(run, call.call_id, agentsOf(1)); return p; };
  return { run, call, base, task: c.tasks[0], counter, done };
}
const ago = (ms) => ({ now: () => Date.now() - ms });

test('SP-FORMALMETHOD-015 cli-contract 依頼と応答 流し直し: 応答を WORKER_CALL_MAX_MS − 1000 の手前で書いた submit は見た応答として扱い、同じ提出は照合し直す', async (t) => {
  const { base, counter, done } = await revisingCall(t);
  await workerCall('submit', base, ago(WORKER_CALL_MAX_MS - 3000));
  const again = (await workerCall('submit', base)).results[0];
  assert.equal(counter.n, 2, '見た応答の後の同じ提出は照合する');
  assert.deepEqual([again.ok, again.done], [true, true], '欠陥が減らないので受理する');
  await done();
});

test('SP-FORMALMETHOD-015 cli-contract 依頼と応答 流し直し: 前の応答を返したときも流し直しの依頼の時刻で見たかを決め直し、その応答も見られていなければ次の流し直しにも同じ応答を返す', async (t) => {
  const { base, counter, done } = await revisingCall(t);
  const first = await workerCall('submit', base, ago(WORKER_CALL_MAX_MS));
  assert.deepEqual(await workerCall('submit', base, ago(WORKER_CALL_MAX_MS)), first, '1 度目の流し直し（これも見られない）');
  assert.deepEqual(await workerCall('submit', base), first, '2 度目の流し直しも前の応答');
  assert.equal(counter.n, 1);
  // 2 度目の流し直しの応答は見たので、その後の同じ提出は照合する
  assert.equal((await workerCall('submit', base)).results[0].done, true);
  assert.equal(counter.n, 2);
  await done();
});

test('SP-FORMALMETHOD-015 cli-contract 依頼と応答 流し直し: 見ていない応答の後でも、attempt の領域を書き換えた提出は照合し直す', async (t) => {
  const { base, task, counter, done } = await revisingCall(t);
  const first = await workerCall('submit', base, ago(WORKER_CALL_MAX_MS));
  writeAuthor(task, 2);
  const r = await workerCall('submit', base);
  assert.notDeepEqual(r, first);
  assert.equal(counter.n, 2, '書き換えた提出は前の応答を返さない');
  await done();
});

test('SP-FORMALMETHOD-015 cli-contract 依頼と応答 流し直し: 書けなかった submit の応答には見ていない印を付け、流し直しに前の応答を返す。拒否の応答を書けなかったときは印を付けない', async (t) => {
  const { run, call, base, counter, done } = await revisingCall(t);
  const dir = join(run.runDir, 'responses', call.call_id);
  chmodSync(dir, 0o500);
  let fast = Date.now();
  // 応答を書けないので client は no_response になる（client の待ちの時計だけを速め、req_id の時刻は今にする）
  const lost = await workerCall('submit', base, { now: () => { const v = fast; fast += 20000; return v; } });
  assert.equal(lost.detail?.reason, 'no_response', JSON.stringify(lost));
  for (let i = 0; i < 100 && counter.n === 0; i += 1) await sleep(20);
  await sleep(100);
  chmodSync(dir, 0o700);
  assert.ok(run.log('確認').failures.concat(run.log().failures).some((x) => /応答を書けない/.test(x)));
  const again = await workerCall('submit', base);
  assert.deepEqual(again.results.map((r) => [r.ok, r.done]), [[false, false]], '前の応答（出し直しの要求）');
  assert.equal(counter.n, 1, '書けなかった応答の流し直しは照合し直さない');
  await done();
  // 拒否の応答（submit の照合の応答でないもの）を書けなかったときは、前の submit に印を付けない
  const w = { id: 'w01', lastSubmit: { response: { ok: true, results: [] }, unseen: false } };
  markUnseen({ ws: [w] }, { command: 'submit', worker: 'w01' }, { ok: false, code: 'E_CALL', detail: { reason: 'deadline_passed' } });
  assert.equal(w.lastSubmit.unseen, false);
  markUnseen({ ws: [w] }, { command: 'submit', worker: 'w01' }, w.lastSubmit.response);
  assert.equal(w.lastSubmit.unseen, true);
});

// ---- 詰め合わせの量は資料の和集合（共有の資料は 1 度だけ数える） ----
const filesMap = (o) => new Map(Object.entries(o));
test('SP-FORMALMETHOD-013 AC-12 packByUnion: 共有の資料 60KB と固有の資料 5KB ずつの単位 5 件は、和集合 85KB で 1 体に入る（単位ごとの和なら 325KB）', () => {
  const files = (i) => filesMap({ 'targets/T1/files/spec.md': 60000, [`attempts/u${i}.json`]: 5000 });
  assert.deepEqual(packByUnion([1, 2, 3, 4, 5], files), [[1, 2, 3, 4, 5]]);
  assert.equal(unionBytes([1, 2, 3, 4, 5].map(files)), 85000);
  assert.ok([1, 2, 3, 4, 5].reduce((n, i) => n + unionBytes([files(i)]), 0) > UNIT_MAX_BYTES, '単位ごとの和なら上限を超える');
});

test('SP-FORMALMETHOD-013 AC-12 packByUnion: 単位を足して和集合が UNIT_MAX_BYTES を超えたら次の体に移る（ちょうど上限は同じ体）。1 件で超える単位は単独の束', () => {
  const files = (i) => filesMap({ shared: 60000, [`u${i}`]: 5000 });
  const fit = (UNIT_MAX_BYTES - 60000) / 5000;
  const ids = Array.from({ length: fit + 1 }, (_, i) => i + 1);
  assert.deepEqual(packByUnion(ids, files), [ids.slice(0, fit), [fit + 1]], `60000 + ${fit} × 5000 = UNIT_MAX_BYTES はちょうど上限`);
  const big = (id) => (id === 'b' ? filesMap({ big: UNIT_MAX_BYTES + 1 }) : filesMap({ shared: 60000, [id]: 5000 }));
  assert.deepEqual(packByUnion(['a', 'b', 'c', 'd'], big), [['a'], ['b'], ['c', 'd']], '上限を超える単位は単独で、前に戻って詰めない');
  assert.deepEqual(packByUnion([], files), []);
});

test('SP-FORMALMETHOD-011・013 原因の束: mode fit の束も資料の和集合で上限と比べ、半分にする量も和集合で数える', async (t) => {
  const run = makeRun(t);
  const items = [1, 2, 3].map((n) => ({ spec: causeSpecN(n), files: filesMap({ shared: 60, [`own-${n}`]: 10 }) }));
  const p = runCall(run, { stage: '確認', workers: [{ mode: 'fit', cap: 90, items }] });
  const call = await waitOpen(run.runDir);
  const base = { run_dir: run.runDir, call_id: call.call_id, worker: 'w01' };
  assert.equal((await workerCall('claim', base)).tasks.length, 3, '和集合 90 は上限 90 に収まる（和なら 210）');
  closeWith(run, call.call_id, agentsOf(1));
  const [w] = await p;
  assert.equal(w.nextCap, 45, '束の和集合 90 の半分');
});

test('SP-FORMALMETHOD-012・013 詰め合わせ: claim は同じ体の担当が共有する資料を shared_inputs に 1 度だけ挙げ、渡した資料の指紋は担当ごとの最初の query の時点で残る', async (t) => {
  const run = makeRun(t);
  writeFileSync(join(run.runDir, 'shared.txt'), 'v1');
  writeFileSync(join(run.runDir, 'a.txt'), 'a');
  writeFileSync(join(run.runDir, 'b.txt'), 'b');
  const spec = (n, own) => ({ ...reviewSpecN(n), input_refs: [{ name: 'request', ref: 'request.json' }, { name: 'shared', ref: 'shared.txt' }, { name: 'own', ref: own }] });
  const p = runCall(run, { stage: '確認', workers: [{ items: [{ spec: spec(1, 'a.txt') }, { spec: spec(2, 'b.txt') }] }] });
  const call = await waitOpen(run.runDir);
  const base = { run_dir: run.runDir, call_id: call.call_id, worker: 'w01' };
  const c = await workerCall('claim', base);
  const ts = c.tasks.map((x) => ({ task_id: x.task_id }));
  assert.deepEqual(c.shared_inputs, [{ ref: 'request.json', path: join(run.runDir, 'request.json'), tasks: ts }, { ref: 'shared.txt', path: join(run.runDir, 'shared.txt'), tasks: ts }]);
  await workerCall('query', { ...base, task_id: c.tasks[0].task_id });
  writeFileSync(join(run.runDir, 'shared.txt'), 'v2');
  await workerCall('query', { ...base, task_id: c.tasks[1].task_id });
  for (const task of c.tasks) writeReview(task);
  await workerCall('submit', base);
  closeWith(run, call.call_id, agentsOf(1));
  const [w] = await p;
  const refsOf = (r) => r.materials.map((m) => m.ref);
  assert.deepEqual(w.results.map(refsOf), [['request.json', 'shared.txt', 'a.txt'], ['request.json', 'shared.txt', 'b.txt']], '担当ごとに自分の資料だけ');
  const hashOf = (r, ref) => r.materials.find((m) => m.ref === ref).hash;
  assert.equal(hashOf(w.results[0], 'shared.txt'), sha256Bytes(Buffer.from('v1')));
  assert.equal(hashOf(w.results[1], 'shared.txt'), sha256Bytes(Buffer.from('v2')), '共有の資料も担当ごとの最初の query の時点の指紋');
});

// 対象のファイルを持つ run（受付の段を通さず、受付が控えるのと同じ targets[].files を置く）
function withTarget(run, text) {
  const abs = join(run.root, 'spec-src.md');
  writeFileSync(abs, text);
  run.targets = [{ id: 'T1', files: [{ path: 'spec.md', abs, bytes: Buffer.from(text), text: true, content_hash: sha256Bytes(Buffer.from(text)) }] }];
  return abs;
}

test('SP-FORMALMETHOD-012 詰め合わせ: shared_inputs は共有する資料の範囲を task ごとに残し、和に畳まない', async (t) => {
  const run = makeRun(t);
  withTarget(run, 'a\nb\nc\n');
  const spec = (n, span) => ({ ...reviewSpecN(n), input_refs: [{ name: 'request', ref: 'request.json' }, { name: 'target', ref: 'target:T1/spec.md', spans: [span] }] });
  const p = runCall(run, { stage: '確認', workers: [{ items: [{ spec: spec(1, 'L1-L1') }, { spec: spec(2, 'L3-L3') }] }] });
  const call = await waitOpen(run.runDir);
  const base = { run_dir: run.runDir, call_id: call.call_id, worker: 'w01' };
  const c = await workerCall('claim', base);
  const shared = c.shared_inputs.find((x) => x.ref === 'target:T1/spec.md');
  assert.deepEqual(shared.tasks, [{ task_id: c.tasks[0].task_id, spans: ['L1-L1'] }, { task_id: c.tasks[1].task_id, spans: ['L3-L3'] }]);
  assert.equal(shared.path, run.targets[0].files[0].abs, '対象の ref の path は元のファイルの絶対パス');
  for (const task of c.tasks) await workerCall('query', { ...base, task_id: task.task_id });
  for (const task of c.tasks) writeReview(task);
  await workerCall('submit', base);
  closeWith(run, call.call_id, agentsOf(1));
  await p;
});

test('architecture 対象の固定: query の時点の対象の指紋が受付と違えば、集約の段で読み直した指紋が受付と同じでも 対象の変化 になり、2 度照らしても理由は 1 つ', async (t) => {
  const run = makeRun(t);
  const abs = withTarget(run, 'a\nb\n');
  const p = callOf(run, '確認', [{ spec: { ...reviewSpec(), input_refs: [{ name: 'request', ref: 'request.json' }, { name: 'target', ref: 'target:T1/spec.md' }] } }]);
  const call = await waitOpen(run.runDir);
  const base = { run_dir: run.runDir, call_id: call.call_id, worker: 'w01' };
  const c = await workerCall('claim', base);
  writeFileSync(abs, 'changed\n');
  await workerCall('query', { ...base, task_id: c.tasks[0].task_id });
  writeFileSync(abs, 'a\nb\n');
  writeReview(c.tasks[0]);
  await workerCall('submit', base);
  closeWith(run, call.call_id, agentsOf(1));
  await p;
  assert.equal(run.queriedMaterials.length, 1, '最初の query の資料の指紋を控える');
  run.checkTargetsFixed();
  run.checkTargetsFixed();
  assert.equal(run.targetChanges.length, 1);
  assert.match(run.targetChanges[0].detail, /対象 T1 のファイル spec\.md が受付の後に変わった/);
  assert.deepEqual([...run.changedTargets.get('T1').entries()], [['spec.md', '担当の query の時点の指紋が受付の指紋と違う']]);
});

test('architecture 担当の起動: refFiles は範囲を持つ対象の ref の範囲の行だけを、行ごとに（行のバイト数 + 改行）数え、重なった行は 1 度だけ数える', async (t) => {
  const run = makeRun(t);
  withTarget(run, 'aa\nbbb\ncccc\n');
  const pathOf = (ref) => run.pathOf(ref);
  const m = refFiles(run.runDir, [{ ref: 'target:T1/spec.md', spans: ['L2-L3', 'L3-L3'] }, { ref: 'request.json' }], pathOf);
  assert.deepEqual([...m.entries()], [['target:T1/spec.md#L2', 4], ['target:T1/spec.md#L3', 5], ['request.json', readFileSync(join(run.runDir, 'request.json')).length]]);
  const whole = refFiles(run.runDir, ['target:T1/spec.md'], pathOf);
  assert.deepEqual([...whole.entries()], [['target:T1/spec.md', 12]], '範囲が無ければファイルの全体');
});

test('target-refs: mergeSpans は重なりと隣り合いを畳み、読めない Span は誤りにする。fileLines・spanText は Span の行の規則（linesOf・parseSpan）に従う', () => {
  assert.deepEqual(mergeSpans(['L5-L6', 'L1-L2', 'L3-L3', 'L2-L2']), ['L1-L3', 'L5-L6']);
  for (const bad of ['L0-L1', 'L3-L2', 'x', null]) assert.throws(() => mergeSpans(['L1-L1', bad]), /読めない Span/, String(bad));
  const lines = fileLines(Buffer.from('a\r\nb\n\nc\n'));
  assert.deepEqual(lines, ['a\r', 'b', '', 'c'], '末尾の \\n の後の空の要素は数えず、\\r は行に残す');
  assert.equal(spanText(lines, 'L2-L9'), 'b\n\nc', '行数を超える部分は切る');
  assert.equal(spanText(lines, 'L2'), null);
});

test('architecture 対象の固定: expandRefHashes は読めないファイルを例外にせず unreadable として記録する（範囲の有無によらず）', async (t) => {
  const run = makeRun(t);
  const abs = withTarget(run, 'a\nb\n');
  if (typeof process.getuid === 'function' && process.getuid() === 0) { t.skip('root では読めないファイルを作れない'); return; }
  chmodSync(abs, 0o000);
  const got = expandRefHashes(run.runDir, ['target:T1/spec.md', { ref: 'target:T1/spec.md', spans: ['L1-L1'] }], (ref) => run.pathOf(ref));
  chmodSync(abs, 0o644);
  assert.deepEqual(got, [{ ref: 'target:T1/spec.md', hash: 'unreadable' }, { ref: 'target:T1/spec.md', hash: 'unreadable' }]);
});

test('call の部品: unwrap は native Workflow の完了通知 {summary, agentCount, result} の包みだけを外し、他の値はそのまま返す', () => {
  const inner = { agents: [{ role: 'extractor' }], tokens: 5 };
  assert.deepEqual(unwrap({ summary: '1 体', agentCount: 1, logs: [], result: inner }), inner);
  assert.deepEqual(unwrap({ summary: '1 体', agentCount: 1, result: null }), null, 'result が null でも包みを外す');
  for (const v of [inner, { summary: 1, agentCount: 1, result: inner }, { summary: 's', agentCount: '1', result: inner }, { summary: 's', result: inner }, [inner], null, 'x']) {
    assert.deepEqual(unwrap(v), v, JSON.stringify(v));
  }
});

test('call の部品: sq は文字列を shell の 1 語にし、引用符・空白・改行・$ をそのまま渡す', () => {
  assert.equal(sq("a'b"), "'a'\\''b'");
  for (const x of ['', 'plain', "it's", 'a b\nc', '$HOME `x` "q"', '{"k":"v\'s"}']) {
    assert.equal(execFileSync('sh', ['-c', `printf '%s' ${sq(x)}`], { encoding: 'utf8' }), x, JSON.stringify(x));
  }
});

// ---- 往復と応答の大きさ（cli-contract.md「コマンド」「依頼と応答」、artifact-formats.md「claim の Task」、agent-obligations.md「書く場所と返し方」） ----
// submit の受理は next で次に出せる task（なければ done: true）を返し、担当は終わりの claim を流さない。
// claim の応答は、役ごとの返り値の形（return_schemas）と、worker で 1 つの query_cmd・submit_cmd・scratch_dir を最上位に 1 度だけ持つ。
const CLAIM_TASK_KEYS = ['attempt_dir', 'context', 'effort', 'instructions', 'model', 'result_path', 'role', 'task_id'];
const partSpec = () => ({ role: 'partition-author', stage: '計画', candidates: [{ id: 'C1', nodes: ['n1'] }], input_refs: [{ name: 'request', ref: 'request.json' }] });
const planSpec = () => ({ role: 'plan-author', stage: '計画', property_ids: ['P1'], input_refs: [{ name: 'request', ref: 'request.json' }] });
const count = (text, needle) => text.split(needle).length - 1;

test('SP-FORMALMETHOD-013 cli-contract 依頼と応答 submit の next: 受理した submit は next にまだ出していない task を claim と同じ形で返し、最後の受理は next: {done: true} を返す（終わりの claim を流さずに終えられる）', async (t) => {
  const run = makeRun(t);
  const p = runCall(run, { stage: '確認', workers: [{ items: [1, 2, 3].map((n) => ({ spec: reviewSpecN(n) })) }] });
  const call = await waitOpen(run.runDir);
  const base = { run_dir: run.runDir, call_id: call.call_id, worker: 'w01' };
  const c = await workerCall('claim', base);
  const ids = c.tasks.map((x) => x.task_id);
  writeReview(c.tasks[0]);
  const s1 = await workerCall('submit', base);
  assert.deepEqual(s1.results.map((r) => [r.task_id, r.ok, r.done]), [[ids[0], true, true]]);
  assert.ok(s1.next && s1.next.done === false, `受理の後に出していない task があれば next は done: false: ${JSON.stringify(s1.next)}`);
  assert.deepEqual(s1.next.tasks.map((x) => x.task_id), ids.slice(1), 'next は出していない task（claim の tasks と同じ形）');
  assert.ok(s1.next.tasks.every((x) => Object.keys(x).sort().join() === CLAIM_TASK_KEYS.join()), JSON.stringify(s1.next.tasks.map((x) => Object.keys(x))));
  for (const task of c.tasks.slice(1)) writeReview(task);
  const s2 = await workerCall('submit', base);
  assert.deepEqual(s2.results.map((r) => [r.ok, r.done]), [[true, true], [true, true]]);
  assert.deepEqual(s2.next, { done: true }, '出せる task が無ければ next は done: true だけ');
  closeWith(run, call.call_id, agentsOf(1));
  const [w] = await p;
  assert.deepEqual(w.results.map((r) => r.ok), [true, true, true]);
  assert.deepEqual(run.agentFailures, []);
});

test('SP-FORMALMETHOD-011・013 cli-contract 依頼と応答 submit の next: 束の worker は、束を出し終えた submit の next で次の束を受け取り、claim を流し直さずに全ての束を出し終える', async (t) => {
  const run = makeRun(t);
  const p = runCall(run, { stage: '確認', workers: [{ mode: 'fit', cap: 10, items: [1, 2, 3].map((n) => ({ spec: causeSpecN(n), bytes: 10 })) }] });
  const call = await waitOpen(run.runDir);
  const base = { run_dir: run.runDir, call_id: call.call_id, worker: 'w01' };
  const c = await workerCall('claim', base);
  assert.equal(c.tasks.length, 1);
  const seen = [c.tasks.map((x) => x.task_id)];
  let tasks = c.tasks;
  for (let i = 0; i < 5; i += 1) {
    for (const task of tasks) writeCause(task);
    const s = await workerCall('submit', base);
    assert.ok(s.results.every((r) => r.ok && r.done), JSON.stringify(s.results));
    assert.ok(s.next, `受理した submit は next を持つ: ${JSON.stringify(s)}`);
    if (s.next.done) break;
    tasks = s.next.tasks;
    seen.push(tasks.map((x) => x.task_id));
  }
  assert.deepEqual(seen.map((x) => x.length), [1, 1, 1], '上限 10 の束は 1 件ずつ');
  assert.equal(new Set(seen.flat()).size, 3, '束は重ならない');
  closeWith(run, call.call_id, agentsOf(1));
  const [w] = await p;
  assert.deepEqual(w.results.map((r) => r.ok), [true, true, true]);
  assert.deepEqual(run.agentFailures, [], 'next で受け取った束は、claim で受け取った束と同じく取った担当として閉じる');
});

test('SP-FORMALMETHOD-015 cli-contract 依頼と応答 submit の next: 差し戻し（ok: false・done: false）の submit は next を持たない。失敗として閉じた task（cannot_proceed）の submit は next を持つ', async (t) => {
  const run = makeRun(t);
  let n = 0;
  const check = () => { n += 1; return { defects: n === 1 ? defects(2) : [], value: null }; };
  const p = callOf(run, 'モデル化', [{ spec: authorSpec(), check }]);
  const call = await waitOpen(run.runDir);
  const base = { run_dir: run.runDir, call_id: call.call_id, worker: 'w01' };
  const c = await workerCall('claim', base);
  writeAuthor(c.tasks[0], 1);
  const back = await workerCall('submit', base);
  assert.deepEqual(back.results.map((r) => [r.ok, r.done]), [[false, false]]);
  assert.ok(!('next' in back), `差し戻しの応答に next を入れない: ${JSON.stringify(back)}`);
  writeAuthor(c.tasks[0], 2);
  const ok = await workerCall('submit', base);
  assert.deepEqual(ok.results.map((r) => [r.ok, r.done]), [[true, true]]);
  assert.deepEqual(ok.next, { done: true });
  closeWith(run, call.call_id, agentsOf(1));
  assert.equal((await p)[0].ok, true);

  const run2 = makeRun(t);
  const p2 = callOf(run2, 'モデル化', [{ spec: authorSpec(), check: () => ({ defects: [], value: null }) }]);
  const call2 = await waitOpen(run2.runDir);
  const base2 = { run_dir: run2.runDir, call_id: call2.call_id, worker: 'w01' };
  const task = (await workerCall('claim', base2)).tasks[0];
  writeFileSync(join(task.attempt_dir, 'worklog.json'), '{}');
  writeFileSync(task.result_path, JSON.stringify({ task_id: task.task_id, status: 'cannot_proceed', outputs: [], questions: [], blocked_by_question: [], reason: '進めない', worklog_ref: rel(task, 'worklog.json') }));
  const failed = await workerCall('submit', base2);
  assert.deepEqual(failed.results.map((r) => [r.ok, r.done]), [[false, true]]);
  assert.deepEqual(failed.next, { done: true }, '閉じた task の後は次へ進む');
  closeWith(run2, call2.call_id, agentsOf(1));
  assert.equal((await p2)[0].ok, false);
});

test('SP-FORMALMETHOD-008・013 cli-contract 依頼と応答 submit の next: 依存つきの計画の task は、分割の task が閉じるまで next に出ず、分割を受理した submit の next で返る。next は新しく出た役の返り値の形を return_schemas に持つ', async (t) => {
  const run = makeRun(t);
  const order = [];
  let n = 0;
  const items = [
    { spec: partSpec(), check: () => { n += 1; return { defects: n === 1 ? defects(2) : [], value: null }; }, settle: (r) => order.push(['part', r.ok]) },
    { role: 'plan-author', stage: '計画', spec: () => { order.push(['plan-spec']); return planSpec(); }, check: () => ({ defects: [], value: null }), after: 0 },
  ];
  const p = runCall(run, { stage: '計画', workers: [{ items }] });
  const call = await waitOpen(run.runDir);
  const base = { run_dir: run.runDir, call_id: call.call_id, worker: 'w01' };
  const c = await workerCall('claim', base);
  assert.deepEqual(c.tasks.map((x) => x.role), ['partition-author']);
  assert.deepEqual(Object.keys(c.return_schemas ?? {}), ['partition-author'], 'claim の return_schemas は返した task の役だけ');
  writeAuthor(c.tasks[0], 1);
  const back = await workerCall('submit', base);
  assert.deepEqual(back.results.map((r) => [r.ok, r.done]), [[false, false]]);
  assert.ok(!('next' in back), '分割の差し戻しでは next を出さない');
  assert.deepEqual(order, [], '分割が閉じるまで計画の task を作らない');
  writeAuthor(c.tasks[0], 2);
  const s = await workerCall('submit', base);
  assert.deepEqual(s.results.map((r) => [r.task_id, r.ok, r.done]), [[c.tasks[0].task_id, true, true]]);
  assert.ok(s.next && s.next.done === false, JSON.stringify(s.next));
  assert.deepEqual(s.next.tasks.map((x) => x.role), ['plan-author'], '分割が閉じた後の next は計画の task');
  assert.deepEqual(order, [['part', true], ['plan-spec']], '計画の spec は分割の結果を受けた後に作る');
  assert.deepEqual(Object.keys(s.next.return_schemas ?? {}), ['plan-author']);
  assert.equal(s.next.return_schemas['plan-author'].type, 'object');
  writeAuthor(s.next.tasks[0], 1);
  const last = await workerCall('submit', base);
  assert.deepEqual(last.results.map((r) => [r.ok, r.done]), [[true, true]]);
  assert.deepEqual(last.next, { done: true });
  closeWith(run, call.call_id, agentsOf(1));
  const [w] = await p;
  assert.deepEqual(w.results.map((r) => r.ok), [true, true]);
  assert.deepEqual(run.agentFailures, [], 'next で受け取った計画の task も、取った担当として閉じる');
});

test('SP-FORMALMETHOD-015 cli-contract 依頼と応答 流し直し submit の next: next で新しい task を作った submit の応答を担当が見ていなければ、同じ submit の流し直しは同じ next を返し、task を作り直さない。tasks.json は next で作った task を含めて書き直す', async (t) => {
  const run = makeRun(t);
  let planSpecs = 0;
  const items = [{ spec: partSpec(), check: () => ({ defects: [], value: null }) },
    { role: 'plan-author', stage: '計画', spec: () => { planSpecs += 1; return planSpec(); }, check: () => ({ defects: [], value: null }), after: 0 }];
  const p = runCall(run, { stage: '計画', workers: [{ items }] });
  const call = await waitOpen(run.runDir);
  const base = { run_dir: run.runDir, call_id: call.call_id, worker: 'w01' };
  const c = await workerCall('claim', base);
  writeAuthor(c.tasks[0], 1);
  const first = await workerCall('submit', base, ago(WORKER_CALL_MAX_MS));
  assert.deepEqual(first.next?.tasks?.map((x) => x.role), ['plan-author'], JSON.stringify(first));
  const again = await workerCall('submit', base);
  assert.deepEqual(again, first, '流し直しは前の応答（同じ next）');
  assert.equal(planSpecs, 1, '流し直しで計画の task を作り直さない');
  writeAuthor(first.next.tasks[0], 1);
  const last = await workerCall('submit', base);
  assert.deepEqual(last.results.map((r) => [r.task_id, r.ok, r.done]), [[first.next.tasks[0].task_id, true, true]]);
  assert.deepEqual(last.next, { done: true });
  closeWith(run, call.call_id, agentsOf(1));
  const [w] = await p;
  assert.deepEqual(w.results.map((r) => r.ok), [true, true]);
  const record = JSON.parse(readFileSync(join(run.runDir, 'calls', call.call_id, 'tasks.json'), 'utf8'));
  assert.deepEqual(record.tasks.map((x) => x.task.task_id), [c.tasks[0].task_id, first.next.tasks[0].task_id], 'next で作った task も呼び出しの記録に残る');
});

test('SP-FORMALMETHOD-013 cli-contract 依頼と応答 submit の next: 受理の後の同じ submit（照合しない）も、取った全ての task の結果と next を持つ', async (t) => {
  const run = makeRun(t);
  const p = runCall(run, { stage: '確認', workers: [{ items: [1, 2].map((n) => ({ spec: reviewSpecN(n) })) }] });
  const call = await waitOpen(run.runDir);
  const base = { run_dir: run.runDir, call_id: call.call_id, worker: 'w01' };
  const c = await workerCall('claim', base);
  for (const task of c.tasks) writeReview(task);
  const s1 = await workerCall('submit', base);
  assert.deepEqual(s1.next, { done: true });
  const s2 = await workerCall('submit', base);
  assert.deepEqual(s2.results.map((r) => [r.task_id, r.ok, r.done]), c.tasks.map((x) => [x.task_id, true, true]));
  assert.deepEqual(s2.next, { done: true }, '受理の後の同じ submit も next を持つ');
  closeWith(run, call.call_id, agentsOf(1));
  const [w] = await p;
  assert.deepEqual(w.results.map((r) => r.ok), [true, true]);
});

test('SP-FORMALMETHOD-013 cli-contract 依頼と応答 claim scratch_dir: worker の scratch_dir を作れなければ、呼び出しを開かずに 保存の失敗 で run を止め、担当を出さない（claim は無い scratch_dir を返さない）', async (t) => {
  const run = makeRun(t);
  // 次の呼び出し（call-001）の w01 の scratch_dir の場所にファイルを置き、ディレクトリを作れなくする
  mkdirSync(join(run.runDir, 'attempts'), { recursive: true });
  writeFileSync(join(run.runDir, 'attempts', 'call-001-w01'), '');
  const out = await callOf(run, '確認', [{ spec: reviewSpec() }]);
  assert.deepEqual(out.map((r) => [r.ok, Boolean(r.notIssued)]), [[false, true]]);
  assert.match(out[0].cause, /scratch_dir を作れない/);
  assert.ok(run.halted() && run.interrupts.some((x) => x.code === '保存の失敗'), JSON.stringify(run.interrupts));
  assert.ok(run.unsaved.some((x) => x.ref === 'attempts/call-001-w01'), JSON.stringify(run.unsaved));
  assert.notEqual(readStatus(run.runDir)?.action, 'run_agents', '呼び出しを開かない');
});

test('SP-FORMALMETHOD-013 cli-contract コマンド claim: 返り値の形は最上位の return_schemas に役ごとに 1 度だけ置き、task は return_schema・query_cmd・submit_cmd を持たない', async (t) => {
  const run = makeRun(t);
  const p = runCall(run, { stage: '確認', workers: [{ items: [1, 2, 3, 4].map((n) => ({ spec: reviewSpecN(n) })) }] });
  const call = await waitOpen(run.runDir);
  const base = { run_dir: run.runDir, call_id: call.call_id, worker: 'w01' };
  const c = await workerCall('claim', base);
  assert.equal(c.tasks.length, 4);
  for (const task of c.tasks) assert.deepEqual(Object.keys(task).sort(), CLAIM_TASK_KEYS, `${task.task_id} の欄`);
  assert.deepEqual(Object.keys(c.return_schemas ?? {}), ['extraction-reviewer'], '役ごとに 1 つ');
  const schema = c.return_schemas['extraction-reviewer'];
  assert.equal(schema.type, 'object');
  assert.ok(schema.properties && 'perspective' in schema.properties && 'record_ref' in schema.properties, '確認役の返り値（ReviewReturn）の形');
  assert.equal(count(JSON.stringify(c), '"$schema"'), 1, '同じ役の task が 4 つでも、返り値の形は応答に 1 度だけ');
  for (const task of c.tasks) writeReview(task);
  await workerCall('submit', base);
  closeWith(run, call.call_id, agentsOf(1));
  await p;
});

test('SP-FORMALMETHOD-013 cli-contract コマンド claim・query: query_cmd・submit_cmd は応答の最上位に 1 度だけ置き、query_cmd に task_id を引数で足すと、その task の query になる', async (t) => {
  const run = makeRun(t);
  const p = runCall(run, { stage: '確認', workers: [{ items: [1, 2].map((n) => ({ spec: reviewSpecN(n) })) }] });
  const call = await waitOpen(run.runDir);
  const base = { run_dir: run.runDir, call_id: call.call_id, worker: 'w01' };
  const c = await workerCall('claim', base);
  assert.equal(typeof c.query_cmd, 'string');
  assert.equal(typeof c.submit_cmd, 'string');
  const text = JSON.stringify(c);
  assert.equal(count(text, '"query_cmd"'), 1, 'query_cmd は応答に 1 度だけ');
  assert.equal(count(text, '"submit_cmd"'), 1, 'submit_cmd は応答に 1 度だけ');
  for (const task of c.tasks) assert.ok(!c.query_cmd.includes(task.task_id), 'query_cmd は task_id を持たない（worker で 1 つ）');
  // 担当と同じく Bash で流す: <query_cmd> <task_id>
  for (const task of c.tasks) {
    const q = (await runShell(`${c.query_cmd} ${sq(task.task_id)}`)).json;
    assert.equal(q?.ok, true, JSON.stringify(q));
    assert.deepEqual([q.command, q.task_id], ['query', task.task_id]);
    assert.deepEqual(q.inputs.map((x) => x.ref), ['request.json', 'targets/T1/files']);
  }
  // task_id を足さない query_cmd は入力の形に合わない
  const bare = await runShell(c.query_cmd);
  assert.deepEqual([bare.code, bare.json?.code, bare.json?.detail?.reason], [1, 'E_INPUT', 'shape'], bare.stdout);
  // 2 語目を取るのは query だけ。claim に 2 語目を渡すと契約の誤り
  const extra = await runShell(`printf '%s' ${sq(JSON.stringify(base))} | ${sq(process.execPath)} ${sq(CLI)} claim extra`);
  assert.deepEqual([extra.code, extra.json?.code], [2, 'E_CONTRACT'], extra.stdout);
  // 2 語目と標準入力の両方に task_id があれば、どちらの task か決まらないので入力の形に合わない
  const id0 = c.tasks[0].task_id;
  const both = await runShell(`printf '%s' ${sq(JSON.stringify({ ...base, task_id: id0 }))} | ${sq(process.execPath)} ${sq(CLI)} query ${sq(id0)}`);
  assert.deepEqual([both.code, both.json?.code, both.json?.detail?.reason], [1, 'E_INPUT', 'shape'], both.stdout);
  // query も 3 語目は取らない（契約の誤り）
  const three = await runShell(`${c.query_cmd} ${sq(id0)} ${sq(c.tasks[1].task_id)}`);
  assert.deepEqual([three.code, three.json?.code], [2, 'E_CONTRACT'], three.stdout);
  for (const task of c.tasks) writeReview(task);
  const s = (await runShell(c.submit_cmd)).json;
  assert.deepEqual(s?.results?.map((r) => [r.ok, r.done]), [[true, true], [true, true]], JSON.stringify(s));
  closeWith(run, call.call_id, agentsOf(1));
  const [w] = await p;
  assert.deepEqual(w.results.map((r) => r.ok), [true, true]);
});

test('SP-FORMALMETHOD-013 agent-obligations 書く場所と返し方: claim は worker ごとに別の scratch_dir（<run_dir>/attempts/<call_id>-<worker>）を返し、そこに書いても受理を取り消さない', async (t) => {
  const run = makeRun(t);
  const p = callOf(run, '確認', [{ spec: reviewSpec() }, { spec: reviewSpec() }]);
  const call = await waitOpen(run.runDir);
  const bases = ['w01', 'w02'].map((worker) => ({ run_dir: run.runDir, call_id: call.call_id, worker }));
  const cs = [];
  for (const b of bases) cs.push(await workerCall('claim', b));
  assert.deepEqual(cs.map((c) => c.scratch_dir), ['w01', 'w02'].map((wk) => join(run.runDir, 'attempts', `${call.call_id}-${wk}`)), 'worker ごとに決まった場所');
  assert.notEqual(cs[0].scratch_dir, cs[1].scratch_dir);
  for (const c of cs) {
    assert.ok(existsSync(c.scratch_dir), `${c.scratch_dir} は claim の時点である`);
    assert.ok(c.tasks.every((x) => x.attempt_dir !== c.scratch_dir && !c.scratch_dir.startsWith(`${x.attempt_dir}/`)), 'task の attempt の領域とは別');
  }
  assert.equal((await workerCall('claim', bases[0])).scratch_dir, cs[0].scratch_dir, '取り直しても同じ scratch_dir');
  for (const [i, c] of cs.entries()) {
    writeFileSync(join(c.scratch_dir, 'gen.mjs'), '// 生成物\n');
    writeReview(c.tasks[0]);
    assert.deepEqual((await workerCall('submit', bases[i])).results.map((r) => [r.ok, r.done]), [[true, true]]);
    // 受理の後に scratch_dir に書いても、attempt の領域の書換えにならない
    writeFileSync(join(c.scratch_dir, 'gen.mjs'), '// 書き直した生成物\n');
  }
  closeWith(run, call.call_id, agentsOf(2));
  const out = await p;
  assert.deepEqual(out.map((r) => r.ok), [true, true], JSON.stringify(out.map((r) => r.cause)));
  assert.deepEqual(run.agentFailures, []);
  // 書込み範囲（agent-obligations.md「書く場所と返し方」）に scratch_dir が入る
  const obligations = readFileSync(new URL('../references/agent-obligations.md', import.meta.url), 'utf8');
  const rule = obligations.split('\n').find((l) => l.startsWith('- 書くのは'));
  assert.ok(rule && rule.includes('`attempt_dir`') && rule.includes('`scratch_dir`'), rule);
});

// ---- 本物の CLI と harness ----
test('SP-FORMALMETHOD-015 AC-19: 担当が claim したまま submit しなかった作成役は、その段の 担当の失敗 になり、停止の報告の段はその段と一致する', async (t) => {
  for (const [role, stage] of [['model-author', 'モデル化'], ['plan-author', '計画']]) {
    const { result, harness } = await runScenario(t, { scenario: { returns: { [role]: 'missing' } }, hooks: { via: 'shell' } });
    assert.deepEqual(resultInvariants(result), []);
    const task = harness.memory.tasks.find((x) => x.role === role);
    assert.ok(task, `${role} の task が出る`);
    const rs = result.stop_report.reasons.filter((x) => x.code === '担当の失敗');
    assert.ok(rs.some((x) => x.stage === stage && x.detail.includes(task.task_id) && x.detail.includes('claim したまま submit しなかった')), JSON.stringify(rs));
    assert.equal(result.stop_report.stage, stage);
    assert.deepEqual(stopStageViolations(result), []);
  }
});

test('cli-contract 受け箱 SP-FORMALMETHOD-015 回帰: 司令塔が包んだ完了通知（{summary, agentCount, logs, result}）や timed_out で close しても、受理済みの担当は捨てられず run は完了する', async (t) => {
  for (const mode of ['wrapped', 'timed_out', 'wf_shape']) {
    const { result, harness } = await runScenario(t, { hooks: { close: () => mode, via: 'shell' } });
    assert.deepEqual(resultInvariants(result), []);
    assert.equal(result.status, '完了', `${mode}: ${JSON.stringify(result.stop_report?.reasons)}`);
    assert.ok(harness.memory.closes.length >= 4 && harness.memory.closes.every((x) => x.mode === mode));
  }
});

test('architecture 修正の巡 結合: モデル作成役が 1 回目に欠陥を返されると同じ worker が出し直し、2 回目で受理される（task は 1 つ）。欠陥が減らなければ 2 回目で打ち切る', async (t) => {
  for (const [persist, verdictDone] of [[false, true], [true, false]]) {
    const { result, harness } = await runScenario(t, { scenario: { stateMachine: SM, editStateMachine: wrongGoal(persist) }, hooks: { via: 'shell' } });
    assert.deepEqual(resultInvariants(result), []);
    const tasks = harness.memory.tasks.filter((x) => x.role === 'model-author');
    assert.equal(tasks.length, 1, '出し直しは同じ task');
    const subs = harness.memory.submits.filter((x) => x.role === 'model-author');
    assert.equal(subs.length, 2, `提出の回数: ${JSON.stringify(subs)}`);
    assert.deepEqual([subs[0].result.ok, subs[0].result.done], [false, false]);
    assert.ok(subs[0].result.problems.length >= 1);
    assert.deepEqual([subs[1].result.ok, subs[1].result.done], [true, true]);
    assert.equal(Boolean(subs[1].result.remaining?.length), !verdictDone, persist ? '残った欠陥ごと受理' : '欠陥の無い受理');
  }
});

// ---- 役ごとの参照と、CLI が持つ指紋（artifact-formats.md「claim の Task」、cli-contract.md「依頼と応答」、agent-obligations.md「作業記録」） ----
const worklogDraft = (task, inputs, extra = {}) => ({ schema: 'formal-method.worklog/1', role: task.role, task_id: task.task_id, stage: task.context.stage, target: 'T1', inputs,
  actions: '読んだ。', results: '書いた。', grounds: 'テスト。', failures: [], unconfirmed: [], unreadable_inputs: [], ...extra });
function writeReviewWith(task, worklog) {
  writeFileSync(join(task.attempt_dir, 'worklog.json'), JSON.stringify(worklog));
  writeFileSync(join(task.attempt_dir, 'review.json'), '{}');
  writeFileSync(task.result_path, JSON.stringify({ task_id: task.task_id, unit_id: task.context.unit_id, perspective: task.context.perspective, result: '成り立つ', findings: [],
    judgments: [], record_ref: rel(task, 'review.json'), worklog_ref: rel(task, 'worklog.json') }));
}

test('SP-FORMALMETHOD-013・014 claim: task の instructions は役の指示・役の分の義務・役の型の抜粋・run の領域の文書の一般規約の写しの 4 つで、応答の最上位に規約の {ref, version} を 1 度だけ置く', async (t) => {
  const run = makeRun(t);
  run.docRules = RULES;
  mkdirSync(join(run.runDir, 'document-rules'), { recursive: true });
  writeFileSync(join(run.runDir, RULES.ref), '# 規約\n');
  const p = callOf(run, '確認', [{ spec: reviewSpec() }, { spec: authorSpec(), check: () => ({ defects: [], value: null }) }]);
  const call = await waitOpen(run.runDir);
  const base = { run_dir: run.runDir, call_id: call.call_id };
  const c1 = await workerCall('claim', { ...base, worker: 'w01' });
  const c2 = await workerCall('claim', { ...base, worker: 'w02' });
  assert.deepEqual(c1.document_rules, RULES);
  assert.ok(!('document_rules' in c1.tasks[0]), 'task は規約を持たない');
  const skill = join(CLI, '..', '..');
  const rules = join(run.runDir, RULES.ref);
  assert.deepEqual(c1.tasks[0].instructions, [join(skill, 'agents/extraction-reviewer.md'), join(skill, 'references/obligations/confirmer.md'), join(skill, 'references/types/extraction-reviewer.md'), rules]);
  assert.deepEqual(c2.tasks[0].instructions, [join(skill, 'agents/model-author.md'), join(skill, 'references/obligations/author.md'), join(skill, 'references/types/model-author.md'), rules]);
  for (const x of [...c1.tasks[0].instructions, ...c2.tasks[0].instructions]) assert.ok(existsSync(x), x);
  closeWith(run, call.call_id, agentsOf(2));
  await p;
});

test('SP-FORMALMETHOD-012 query: ファイルの資料は固定した指紋 hash を持ち、attempts/ の外の同じディレクトリの 2 つ以上の続いた資料は 1 つの ref と path と entries に畳む（attempts/ の資料は畳まず、ディレクトリの entry は / で終わる。畳んだ資料の指紋は返さず、ファイルごとの指紋は materials に残す）', async (t) => {
  const run = makeRun(t);
  const dir = join(run.runDir, 'attempts', 't900-model-author', 'm1');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'model.json'), '{"m":1}');
  writeFileSync(join(dir, 'q1.smt2'), '(check-sat)\n');
  for (const id of ['c1', 'c2']) { mkdirSync(join(run.runDir, 'checks', id), { recursive: true }); writeFileSync(join(run.runDir, 'checks', id, 'stdout.txt'), id); }
  // 続いた同じディレクトリの資料だけを畳む（間に別のディレクトリの資料が入る worklogs/ の 1 つは畳まない）
  mkdirSync(join(run.runDir, 'worklogs'), { recursive: true });
  writeFileSync(join(run.runDir, 'worklogs', 'cli-a.json'), '{}');
  mkdirSync(join(run.runDir, 'judgments'), { recursive: true });
  for (const n of ['m1', 'm2']) writeFileSync(join(run.runDir, 'judgments', `${n}.json`), n);
  const spec = { ...reviewSpec(), input_refs: [{ name: 'request', ref: 'request.json' }, { name: 'model-m1', ref: 'attempts/t900-model-author/m1/model.json' },
    { name: 'query-q1', ref: 'attempts/t900-model-author/m1/q1.smt2' }, { name: 'checks-c1', ref: 'checks/c1' }, { name: 'checks-c2', ref: 'checks/c2' }, { name: 'worklog-a', ref: 'worklogs/cli-a.json' },
    { name: 'judgments-m1', ref: 'judgments/m1.json' }, { name: 'judgments-m2', ref: 'judgments/m2.json' }] };
  const p = callOf(run, '確認', [{ spec }]);
  const call = await waitOpen(run.runDir);
  const base = { run_dir: run.runDir, call_id: call.call_id, worker: 'w01' };
  const c = await workerCall('claim', base);
  const all = await workerCall('query', { ...base, task_id: c.tasks[0].task_id });
  const h = (rel2) => sha256Bytes(readFileSync(join(run.runDir, rel2)));
  assert.deepEqual(all.inputs, [
    { name: 'request', ref: 'request.json', path: join(run.runDir, 'request.json'), hash: h('request.json') },
    // attempts/ の資料は、作成役の作業記録・返り値と同じディレクトリにあるので畳まない（畳むと独立検証者に attempt のディレクトリを渡すことになる）
    { name: 'model-m1', ref: 'attempts/t900-model-author/m1/model.json', path: join(dir, 'model.json'), hash: h('attempts/t900-model-author/m1/model.json') },
    { name: 'query-q1', ref: 'attempts/t900-model-author/m1/q1.smt2', path: join(dir, 'q1.smt2'), hash: h('attempts/t900-model-author/m1/q1.smt2') },
    { ref: 'checks/', path: `${join(run.runDir, 'checks')}/`, entries: [{ name: 'checks-c1', entry: 'c1/' }, { name: 'checks-c2', entry: 'c2/' }] },
    { name: 'worklog-a', ref: 'worklogs/cli-a.json', path: join(run.runDir, 'worklogs', 'cli-a.json'), hash: h('worklogs/cli-a.json') },
    { ref: 'judgments/', path: `${join(run.runDir, 'judgments')}/`, entries: [{ name: 'judgments-m1', entry: 'm1.json' }, { name: 'judgments-m2', entry: 'm2.json' }] },
  ]);
  // refs で引いた 1 つのファイルは、ref・path・hash で返す
  const one = await workerCall('query', { ...base, task_id: c.tasks[0].task_id, refs: ['attempts/t900-model-author/m1/q1.smt2'] });
  assert.deepEqual(one.inputs, [{ name: 'query-q1', ref: 'attempts/t900-model-author/m1/q1.smt2', path: join(dir, 'q1.smt2'), hash: h('attempts/t900-model-author/m1/q1.smt2') }]);
  writeReview(c.tasks[0]);
  await workerCall('submit', base);
  closeWith(run, call.call_id, agentsOf(1));
  const [r] = await p;
  assert.deepEqual(r.materials.map((m) => m.ref), ['request.json', 'attempts/t900-model-author/m1/model.json', 'attempts/t900-model-author/m1/q1.smt2', 'checks/c1/stdout.txt', 'checks/c2/stdout.txt', 'worklogs/cli-a.json',
    'judgments/m1.json', 'judgments/m2.json'], 'ファイルごとの指紋は materials（台帳の input_refs）に残る');
});

test('SP-FORMALMETHOD-012・014 submit: 作業記録の inputs の指紋と document_rules を担当が書かなければ、CLI が渡した資料の指紋と規約で補ってから照合する', async (t) => {
  const run = makeRun(t);
  run.docRules = RULES;
  const p = callOf(run, '確認', [{ spec: reviewSpec() }]);
  const call = await waitOpen(run.runDir);
  const base = { run_dir: run.runDir, call_id: call.call_id, worker: 'w01' };
  const c = await workerCall('claim', base);
  const task = c.tasks[0];
  await workerCall('query', { ...base, task_id: task.task_id });
  writeReviewWith(task, worklogDraft(task, [{ ref: 'request.json' }, { ref: 'targets/T1/files/spec.md' }]));
  const s = await workerCall('submit', base);
  assert.deepEqual(s.results.map((r) => [r.ok, r.done]), [[true, true]], JSON.stringify(s));
  const wl = JSON.parse(readFileSync(join(task.attempt_dir, 'worklog.json'), 'utf8'));
  assert.deepEqual(wl.inputs, [{ ref: 'request.json', hash: sha256Bytes(Buffer.from('{"note":"request"}\n')) }, { ref: 'targets/T1/files/spec.md', hash: sha256Bytes(Buffer.from('# spec\n')) }]);
  assert.deepEqual(wl.document_rules, RULES);
  closeWith(run, call.call_id, agentsOf(1));
  const [r] = await p;
  assert.equal(r.ok, true, '補った後の attempt の領域で受理する（CLI の書き換えで受理を取り消さない）');
});

test('SP-FORMALMETHOD-012・014 submit: 作業記録に書いた指紋か document_rules が CLI の値と食い違えば、欠陥として差し戻す', async (t) => {
  const run = makeRun(t);
  run.docRules = RULES;
  const p = callOf(run, '確認', [{ spec: reviewSpec() }]);
  const call = await waitOpen(run.runDir);
  const base = { run_dir: run.runDir, call_id: call.call_id, worker: 'w01' };
  const c = await workerCall('claim', base);
  const task = c.tasks[0];
  await workerCall('query', { ...base, task_id: task.task_id });
  const wrong = `sha256:${'0'.repeat(64)}`;
  writeReviewWith(task, worklogDraft(task, [{ ref: 'request.json', hash: wrong }]));
  const s1 = await workerCall('submit', base);
  assert.deepEqual(s1.results.map((r) => [r.ok, r.done]), [[false, false]]);
  assert.match(s1.results[0].problems.join(' '), /request\.json.*指紋/);
  writeReviewWith(task, worklogDraft(task, [{ ref: 'request.json' }], { document_rules: { ...RULES, version: wrong } }));
  const s2 = await workerCall('submit', base);
  assert.deepEqual(s2.results.map((r) => [r.ok, r.done]), [[false, false]]);
  assert.match(s2.results[0].problems.join(' '), /document_rules/);
  writeReviewWith(task, worklogDraft(task, [{ ref: 'request.json', hash: sha256Bytes(Buffer.from('{"note":"request"}\n')) }], { document_rules: RULES }));
  const s3 = await workerCall('submit', base);
  assert.deepEqual(s3.results.map((r) => [r.ok, r.done]), [[true, true]], '書いた値が合えばそのまま受理する');
  closeWith(run, call.call_id, agentsOf(1));
  await p;
});
test('SP-FORMALMETHOD-012 submit: 作業記録の inputs に渡していない資料か範囲があれば、今のファイルで補わずに欠陥として差し戻す（query を流さなかった担当は全ての資料が欠陥）', async (t) => {
  const run = makeRun(t);
  run.docRules = RULES;
  const p = callOf(run, '確認', [{ spec: reviewSpec() }]);
  const call = await waitOpen(run.runDir);
  const base = { run_dir: run.runDir, call_id: call.call_id, worker: 'w01' };
  const c = await workerCall('claim', base);
  const task = c.tasks[0];
  // query の前の提出: 資料を渡していないので、どの ref も補えない
  writeReviewWith(task, worklogDraft(task, [{ ref: 'request.json' }]));
  const s0 = await workerCall('submit', base);
  assert.deepEqual(s0.results.map((r) => [r.ok, r.done]), [[false, false]]);
  assert.match(s0.results[0].problems.join(' '), /request\.json.*渡していない/);
  await workerCall('query', { ...base, task_id: task.task_id });
  // materials に無い ref（台帳・領域の外）は、今のファイルが読めても補わない。範囲で渡していない資料の範囲も補わない
  writeReviewWith(task, worklogDraft(task, [{ ref: 'request.json' }, { ref: 'ledger.json' }, { ref: '../run1/request.json' }, { ref: 'targets/T1/files/spec.md', spans: [{ span: 'L1-L1' }] }]));
  const s1 = await workerCall('submit', base);
  assert.deepEqual(s1.results.map((r) => [r.ok, r.done]), [[false, false]]);
  const text = s1.results[0].problems.join(' ');
  assert.match(text, /ledger\.json は渡していない/);
  assert.match(text, /\.\.\/run1\/request\.json は渡していない/);
  assert.match(text, /spec\.md の L1-L1 は渡していない/);
  assert.doesNotMatch(text, / request\.json /, '渡した資料は補う');
  const wl = JSON.parse(readFileSync(join(task.attempt_dir, 'worklog.json'), 'utf8'));
  // 渡したファイル（全体で渡した spec.md）の指紋は補い、渡していない資料と範囲の指紋は書き足さない
  assert.deepEqual(wl.inputs.slice(1), [{ ref: 'ledger.json' }, { ref: '../run1/request.json' }, { ref: 'targets/T1/files/spec.md', hash: sha256Bytes(Buffer.from('# spec\n')), spans: [{ span: 'L1-L1' }] }]);
  writeReviewWith(task, worklogDraft(task, [{ ref: 'request.json' }]));
  const s3 = await workerCall('submit', base);
  assert.deepEqual(s3.results.map((r) => [r.ok, r.done]), [[true, true]]);
  closeWith(run, call.call_id, agentsOf(1));
  await p;
});
});

// 期限の後に届いた依頼の分岐（deadline_passed）。Date.now を進めて、run-daemon が期限の後に依頼を処理する場面を確実に作る。
// Date.now を差し替えるので、他のテストと並べずに describe の後で流す。client の待ちは差し替えない時計で測る
test('SP-FORMALMETHOD-015 AC-19 cli-contract 依頼と応答: 期限の後に処理した claim・query・submit は E_CALL deadline_passed で拒み、その担当は 担当の失敗 になる', async (t) => {
  const run = makeRun(t);
  const p = callOf(run, '確認', [{ spec: reviewSpec() }]);
  const call = await waitOpen(run.runDir);
  const base = { run_dir: run.runDir, call_id: call.call_id, worker: 'w01' };
  const c = await workerCall('claim', base);
  writeReview(c.tasks[0]);
  const real = Date.now;
  const late = [];
  try {
    Date.now = () => real() + (call.deadline_wall_ms - real()) + 1;
    const opts = { now: real };
    // 期限で閉じる前の drain が処理するので、どれも call_closed でなく deadline_passed になる
    const [s, q, cl] = await Promise.all([workerCall('submit', base, opts), workerCall('query', { ...base, task_id: c.tasks[0].task_id }, opts), workerCall('claim', base, opts)]);
    late.push(s, q, cl);
  } finally { Date.now = real; }
  for (const r of late) assert.deepEqual([r.ok, r.code, r.detail?.reason], [false, 'E_CALL', 'deadline_passed'], JSON.stringify(r));
  const [r] = await p;
  assert.equal(r.ok, false);
  assert.equal(run.agentFailures.length, 1);
});


// 作業記録と inventory の補いの規則（agents.mjs の completeWorklog・completeQuoteHashes）。範囲の指紋は quote_hash と同じ求め方
test('SP-FORMALMETHOD-012 作業記録の補い: 範囲だけを読んだ対象のファイルは、渡した資料のファイル全体の指紋と範囲ごとの指紋で補い、渡していない範囲・資料は補わずに欠陥にする', async () => {
  const { completeWorklog } = await import('./lib/agents.mjs');
  const text = 'a\nb\nc\n';
  const lines = fileLines(Buffer.from(text));
  const sh = (s) => sha256Bytes(Buffer.from(s, 'utf8'));
  const materials = [{ ref: 'target:T1/x.md', hash: sh(text), spans: [{ span: 'L1-L2', hash: sh(spanText(lines, 'L1-L2')) }] }];
  const ok = completeWorklog({ inputs: [{ ref: 'target:T1/x.md', spans: [{ span: 'L1-L2' }] }] }, { materials, docRules: RULES });
  assert.deepEqual(ok.problems, []);
  assert.deepEqual(ok.worklog.inputs, [{ ref: 'target:T1/x.md', hash: sh(text), spans: [{ span: 'L1-L2', hash: sh('a\nb') }] }]);
  assert.deepEqual(ok.worklog.document_rules, RULES);
  assert.equal(ok.changed, true);
  // 渡していない範囲（L3-L3）は、ファイルが読めても今の行で求めない
  const sub = completeWorklog({ inputs: [{ ref: 'target:T1/x.md', spans: [{ span: 'L3-L3' }] }], document_rules: RULES }, { materials, docRules: RULES });
  assert.equal(sub.problems.length, 1);
  assert.match(sub.problems[0], /L3-L3.*渡していない/);
  assert.deepEqual(sub.worklog.inputs[0].spans, [{ span: 'L3-L3' }], '補わない');
  // 渡していない資料（materials に無い ref）と、materials が無い（query を流さなかった）担当の資料
  // 指紋を書いていても（CLI が求められない値なので照らせない）欠陥にする
  const other = completeWorklog({ inputs: [{ ref: 'target:T1/y.md' }, { ref: '../x.md', hash: sh(text) }], document_rules: RULES }, { materials, docRules: RULES });
  assert.equal(other.problems.length, 2);
  assert.ok(other.problems.every((x) => /渡していない/.test(x)));
  assert.deepEqual(other.worklog.inputs, [{ ref: 'target:T1/y.md' }, { ref: '../x.md', hash: sh(text) }]);
  const none = completeWorklog({ inputs: [{ ref: 'target:T1/x.md' }], document_rules: RULES }, { materials: [], docRules: RULES });
  assert.match(none.problems.join(' '), /target:T1\/x\.md.*渡していない/);
  const bad = completeWorklog({ inputs: [{ ref: 'target:T1/x.md', hash: sh(text), spans: [{ span: 'L1-L2', hash: sh('x') }] }], document_rules: RULES }, { materials, docRules: RULES });
  assert.equal(bad.problems.length, 1);
  assert.match(bad.problems[0], /L1-L2/);
  const same = completeWorklog({ inputs: [{ ref: 'target:T1/x.md', hash: sh(text) }], document_rules: RULES }, { materials, docRules: RULES });
  assert.deepEqual([same.problems, same.changed], [[], false], '全て書いてあって合えば書き換えない');
});

test('SP-FORMALMETHOD-012 作業記録の補い: 渡した時点で読めなかった資料（unreadable）に担当が指紋を書いていれば欠陥にし、書いていなければ unreadable で補う', async () => {
  const { completeWorklog } = await import('./lib/agents.mjs');
  const materials = [{ ref: 'checks/c1/stdout.txt', hash: 'unreadable' }];
  const wrote = completeWorklog({ inputs: [{ ref: 'checks/c1/stdout.txt', hash: `sha256:${'1'.repeat(64)}` }], document_rules: RULES }, { materials, docRules: RULES });
  assert.equal(wrote.problems.length, 1);
  assert.match(wrote.problems[0], /checks\/c1\/stdout\.txt/);
  const omitted = completeWorklog({ inputs: [{ ref: 'checks/c1/stdout.txt' }], document_rules: RULES }, { materials, docRules: RULES });
  assert.deepEqual([omitted.problems, omitted.worklog.inputs], [[], [{ ref: 'checks/c1/stdout.txt', hash: 'unreadable' }]]);
});

test('SP-FORMALMETHOD-001 inventory の補い: quote_hash の無い要素は出所の行から補い、書いてあれば補わない（照合は coverage の照合が持つ）', async () => {
  const { completeQuoteHashes } = await import('./lib/agents.mjs');
  const text = 'a\nb\nc\n';
  const inv = { elements: [{ id: 'E1', source: { target_id: 'T1', file: 'x.md', span: 'L2-L3' } }, { id: 'E2', source: { target_id: 'T1', file: 'x.md', span: 'L1-L1', quote_hash: 'sha256:keep' } }] };
  const out = completeQuoteHashes(inv, (tid, file) => (tid === 'T1' && file === 'x.md' ? text : null));
  assert.equal(out.changed, true);
  assert.deepEqual(out.inventory.elements.map((e) => e.source.quote_hash), [sha256Bytes(Buffer.from('b\nc', 'utf8')), 'sha256:keep']);
  const none = completeQuoteHashes({ elements: [{ id: 'E3', source: { target_id: 'T1', file: 'y.md', span: 'L1-L1' } }] }, () => null);
  assert.deepEqual([none.changed, none.inventory.elements[0].source.quote_hash], [false, undefined], '読めない出所は補わない（coverage の照合が欠陥にする）');
});
