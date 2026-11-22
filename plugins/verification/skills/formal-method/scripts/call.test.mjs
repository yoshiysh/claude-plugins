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
import { LAUNCHER, SUBMITS_MAX, markUnseen, packByUnion, runCall, sq, unionBytes, unwrap } from './lib/call.mjs';
import { refFiles, expandRefHashes, WORKFLOW_SCRIPT } from './lib/agents.mjs';
import { mergeSpans, fileLines, spanText } from './lib/target-refs.mjs';
import { execFileSync } from 'node:child_process';
import { close, workerCall } from './lib/client.mjs';
import { readStatus } from './lib/store.mjs';
import { startTimeOf } from './lib/process.mjs';
import { ROLES } from './lib/roles.mjs';
import { REVISE_ROUNDS_MAX, UNIT_MAX_BYTES, WORKER_CALL_MAX_MS } from './lib/schemas.mjs';
import { sha256Bytes } from './lib/canonical.mjs';
import { makeWorkspace, removeTree, CLI } from './test-fixtures/cli-runner.mjs';
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
  writeFileSync(join(runDir, 'state.json'), '{}\n');
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
  const outside = await workerCall('query', { ...base, worker: 'w01', task_id: c1.tasks[0].task_id, refs: ['state.json'] });
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
  assert.ok(existsSync(join(run.runDir, 'revisions', `${c.tasks[0].task_id}-1-defects.json`)), '出し直しの欠陥を記録する');
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
  assert.ok(c.tasks.every((x) => x.submit_cmd === c.tasks[0].submit_cmd), 'submit の命令は worker で 1 つ');
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

test('SP-FORMALMETHOD-008・013 依存つきの担当: 分割と計画を 1 体が順に担い、計画の担当は分割の担当が閉じるまで claim に出ない。閉じた時点で分割の結果を渡す', async (t) => {
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
  assert.equal((await workerCall('submit', base)).results[0].done, true);
  assert.deepEqual(order, [['part', true]], '分割の担当が閉じた時点で結果を渡す');
  const c2 = await workerCall('claim', base);
  assert.deepEqual(c2.tasks.map((x) => x.role), ['plan-author']);
  assert.deepEqual(order, [['part', true], ['plan-spec']], '計画の spec は分割の結果を受けた後の claim で作る');
  writeAuthor(c2.tasks[0], 1);
  assert.equal((await workerCall('submit', base)).results[0].done, true);
  assert.equal((await workerCall('claim', base)).done, true);
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
  assert.ok(existsSync(join(run.runDir, 'revisions', `${c.tasks[0].task_id}-1-defects.json`)));
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
  for (const ref of ['targets/T1/files/../../../state.json', 'targets/T1/files/../manifest.json', '../run1/state.json', join(run.runDir, 'state.json')]) {
    const r = await q([ref]);
    assert.deepEqual([r.ok, r.detail?.reason], [false, 'outside_task'], ref);
  }
  const ok = await q(['targets/T1/./files/spec.md']);
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.deepEqual(ok.inputs.map((x) => [x.ref, x.path]), [['targets/T1/files/spec.md', join(run.runDir, 'targets/T1/files/spec.md')]]);
  closeWith(run, call.call_id, agentsOf(1));
  await p;
});

test('SP-FORMALMETHOD-015 AC-19 依存つきの担当: 依存する担当が閉じた後に worker が claim しないまま呼び出しが閉じたら、そのとおりに書く（依存する担当が閉じる前とは書かない）', async (t) => {
  const run = makeRun(t);
  const part = { role: 'partition-author', stage: '計画', candidates: [{ id: 'C1', nodes: ['n1'] }], input_refs: [{ name: 'request', ref: 'request.json' }] };
  const items = [{ spec: part, check: () => ({ defects: [], value: null }) },
    { role: 'plan-author', stage: '計画', spec: () => ({ role: 'plan-author', stage: '計画', property_ids: ['P1'], input_refs: [] }), after: 0 }];
  const p = runCall(run, { stage: '計画', workers: [{ items }] });
  const call = await waitOpen(run.runDir);
  const base = { run_dir: run.runDir, call_id: call.call_id, worker: 'w01' };
  const c = await workerCall('claim', base);
  writeAuthor(c.tasks[0], 1);
  assert.equal((await workerCall('submit', base)).results[0].done, true);
  closeWith(run, call.call_id, agentsOf(1));
  const [w] = await p;
  assert.deepEqual(w.results.map((r) => [r.ok, Boolean(r.dependency)]), [[true, false], [false, true]]);
  assert.equal(run.agentFailures.length, 1);
  assert.match(run.agentFailures[0].detail, /依存する担当が閉じた後、呼び出しが閉じるまでに worker が claim しなかった/);
  assert.doesNotMatch(run.agentFailures[0].detail, /閉じる前に/);
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

