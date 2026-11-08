// 結合: 実際の process を止める・殺す・保存先を書込み不可にする（AC-10・13・19、verification-plan「実装を相手にした並行テスト」）。
// 正本: cli-contract.md「salvage の手順」「結果と台帳の保存の失敗」「Z3 の adapter」、SP-FORMALMETHOD-010・014・015。
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { cli, cliEnv, drive, expectOk, expectRejected, makeWorkspace, removeTree, runCli, skipIfRoot } from './test-fixtures/cli-runner.mjs';
import { runScenario, setupWorkspace, canonicalRequest, readFakeLog } from './test-fixtures/pipeline.mjs';
import { makeHarness, defaultScenario } from './test-fixtures/agent-harness.mjs';
import { makeFakeBin, pathWithFake } from './test-fixtures/make-fake-bin.mjs';
import { fileHash, snapshotTree, liveIdentity, makeRunDir, writeLock, writeStatus, statusOf } from './test-fixtures/fabricate.mjs';
import { resultInvariants } from './test-fixtures/result-schema.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; } };
async function killAndWait(pid) {
  try { process.kill(pid, 'SIGKILL'); } catch { /* 終了済み */ }
  for (let i = 0; i < 100 && alive(pid); i += 1) await sleep(50);
  assert.equal(alive(pid), false, `pid ${pid} が終わる`);
}
const P = (id, line, over = {}) => ({ id, file: 'spec.md', line, statement: `性質 ${id}`, query: { result: 'unsat' }, sanity: { result: 'sat' }, mutation: { result: 'sat' }, ...over });

// 担当を待っている run の run-daemon を殺した状態を作る。
async function killedWhileWaitingForAgents(t) {
  const ws = setupWorkspace();
  const bin = `${ws}-bin`;
  t.after(() => { removeTree(ws); removeTree(bin); });
  const env = cliEnv({ path: pathWithFake(makeFakeBin(bin)) });
  const s = expectOk(await cli('start', { request: canonicalRequest() }, { cwd: ws, env }), 'start').status;
  let status = s;
  for (let i = 0; status.action !== 'run_agents' && i < 50; i += 1) {
    assert.notEqual(status.action, 'terminal', '担当を起動する前に終わらない');
    status = expectOk(await cli('wait', { run_dir: status.run_dir, status_seq: status.seq }, { cwd: ws, env }), 'wait').status ?? status;
  }
  assert.equal(status.action, 'run_agents');
  await killAndWait(status.daemon.pid);
  return { ws, env, status, dir: status.run_dir };
}

test('verification-plan 並行テスト SP-FORMALMETHOD-015: run-daemon を lock を握ったまま殺すと、wait は E_STALE、submit は受け箱の外を書かず、state.json は最後の内容のまま', async (t) => {
  const { ws, env, status, dir } = await killedWhileWaitingForAgents(t);
  const stateBefore = existsSync(join(dir, 'state.json')) ? readFileSync(join(dir, 'state.json')) : null;
  expectRejected(await cli('wait', { run_dir: dir, status_seq: status.seq }, { cwd: ws, env }), 'E_STALE');
  const before = snapshotTree(dir);
  expectOk(await cli('submit', { run_dir: dir, batch_id: status.batch.batch_id, timed_out: true }, { cwd: ws, env }), 'submit');
  const after = snapshotTree(dir);
  const changed = Object.keys({ ...before, ...after }).filter((k) => before[k] !== after[k]);
  assert.ok(changed.every((k) => k === 'inbox' || k.startsWith('inbox/') || k === '.'), `受け箱の外が変わった: ${changed.join()}`);
  if (stateBefore) assert.ok(readFileSync(join(dir, 'state.json')).equals(stateBefore));
});

test('cli-contract salvage 4・5 SP-FORMALMETHOD-015 AC-19: 保持者が死んだ run の salvage は、処理の中断 の停止の結果を、時刻・pid・nonce を含まず決定的に作り、台帳 → result.json の順に 1 つだけ公開する', async (t) => {
  const { ws, env, status, dir } = await killedWhileWaitingForAgents(t);
  const first = expectOk(await cli('salvage', { run_dir: dir }, { cwd: ws, env }), 'salvage').status;
  assert.equal(first.action, 'terminal');
  const r = first.result;
  assert.deepEqual(resultInvariants(r), []);
  assert.equal(r.status, '停止');
  assert.ok(r.stop_report.reasons.some((x) => x.code === '処理の中断'));
  assert.ok(['受付', '洗い出し', 'モデル化', '計画', '実行', '確認', '集約'].includes(r.stop_report.stage));
  for (const k of ['total_ms']) assert.equal(r.performance.run[k].status, '取得できず');
  const text = JSON.stringify(r);
  for (const v of [String(status.daemon.pid), status.daemon.nonce, status.daemon.started_at]) assert.equal(text.includes(v), false, `結果に作った者の値 ${v} が無い`);
  const published = JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8'));
  assert.deepEqual(published, r, '結果は run-daemon と同じ名前 result.json に公開する');
  const ledger = JSON.parse(readFileSync(join(dir, 'salvage-ledger.json'), 'utf8'));
  assert.equal(ledger.kind, 'salvage');
  assert.equal(ledger.registered_result_hash, fileHash(join(dir, 'result.json')), '公開した結果の指紋が追補台帳に載る');
  assert.ok(r.records.ledger_refs.includes('salvage-ledger.json'));
  const wl = JSON.parse(readFileSync(join(dir, 'salvage-worklog.json'), 'utf8'));
  assert.equal(wl.role, 'salvage');
  assert.equal(wl.stage, '集約');
  const before = snapshotTree(dir);
  const again = expectOk(await cli('salvage', { run_dir: dir }, { cwd: ws, env }), 'salvage').status;
  assert.deepEqual(again.result, r, '2 回目も同じ結果');
  assert.deepEqual(snapshotTree(dir), before, '2 回目は何も書かない');
  // salvage の後、run-daemon は書かない: status.json は terminal でない古いままでよいが、2 つ目の結果は現れない
  assert.deepEqual(readdirSync(dir).filter((n) => /result\.json$/.test(n)), ['result.json'], '結果のファイルは result.json 1 つだけ');
});

test('cli-contract 結果と台帳の保存の失敗 公開の負け: 並行に 4 つの salvage を呼ぶと、どれも E_BUSY（salvage）か、result.json に公開された 1 つの結果を返す（負けた側は既にある結果を読んで返す）', async (t) => {
  const { ws, env, dir } = await killedWhileWaitingForAgents(t);
  const outs = await Promise.all([0, 1, 2, 3].map(() => cli('salvage', { run_dir: dir }, { cwd: ws, env })));
  const results = [];
  for (const o of outs) {
    if (o.json?.ok) results.push(o.json.status.result);
    else { const j = expectRejected(o, 'E_BUSY'); assert.equal(j.detail.holder_role, 'salvage'); assert.equal(j.detail.run_dir, dir); }
  }
  const final = expectOk(await cli('salvage', { run_dir: dir }, { cwd: ws, env }), 'salvage').status.result;
  for (const x of results) assert.deepEqual(x, final);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8')), final);
  assert.deepEqual(readdirSync(dir).filter((n) => /result\.json$/.test(n)), ['result.json']);
});

test('verification-plan ホストに殺された場合: 実行の段の最中に run-daemon を殺しても、salvage の後に道具の process が残らない', async (t) => {
  const ws = setupWorkspace();
  const bin = `${ws}-bin`;
  const log = join(bin, 'calls.jsonl');
  t.after(() => { removeTree(ws); removeTree(bin); });
  const env = cliEnv({ path: pathWithFake(makeFakeBin(bin, { log })) });
  const harness = makeHarness(defaultScenario({ toolTimeLimit: 300, properties: [P('P1', 2, { query: { result: 'unsat', sleepMs: 120000 } })] }));
  let daemon = null;
  const running = drive(ws, canonicalRequest(), { env, onAgents: (s) => harness.onAgents(s), onStatus: (s) => { if (s.daemon) daemon = s.daemon; } });
  let started = null;
  for (let i = 0; i < 600 && !started; i += 1) {
    started = readFakeLog(log).find((e) => e.kind === 'query-start' && e.sleep_ms === 120000);
    if (!started) await sleep(100);
  }
  assert.ok(started, '長い検査が始まる');
  assert.ok(daemon);
  await killAndWait(daemon.pid);
  const { result } = await running;
  assert.equal(result.status, '停止');
  await sleep(500);
  const pids = [...new Set(readFakeLog(log).filter((e) => e.kind === 'query-start').map((e) => e.pid))];
  for (const pid of pids) assert.equal(alive(pid), false, `道具の process ${pid} が残らない`);
});

test('verification-plan ホストに殺された場合: 前景の client（wait）を殺しても、run の状態は変わらない', async (t) => {
  const ws = makeWorkspace();
  const { dir } = makeRunDir(ws);
  const holder = await liveIdentity();
  t.after(() => { holder.stop(); removeTree(ws); });
  writeLock(dir, holder.id);
  writeStatus(dir, statusOf(dir, { seq: 1, daemon: holder.id }));
  const before = snapshotTree(dir);
  let child = null;
  const p = runCli('wait', JSON.stringify({ run_dir: dir, status_seq: 1 }), { cwd: ws, onSpawn: (c) => { child = c; } });
  await sleep(700);
  assert.ok(child && alive(child.pid), 'wait の process がいる');
  child.kill('SIGKILL');
  const r = await p;
  assert.equal(r.signal, 'SIGKILL');
  assert.deepEqual(snapshotTree(dir), before);
});

test('SP-FORMALMETHOD-014 AC-13: 途中の段で保存先を書込み不可にすると、停止 になり、保存できたものの参照と保存できなかった記録・理由が分かれる', async (t) => {
  if (skipIfRoot(t)) return;
  const ws = setupWorkspace();
  const bin = `${ws}-bin`;
  t.after(() => { removeTree(ws); removeTree(bin); });
  const env = cliEnv({ path: pathWithFake(makeFakeBin(bin)) });
  const harness = makeHarness(defaultScenario());
  let locked = false;
  const { result, status } = await drive(ws, canonicalRequest(), {
    env,
    onAgents: async (s) => {
      await harness.onAgents(s);
      if (!locked) { locked = true; chmodSync(join(s.run_dir, 'batches'), 0o555); }
    },
  });
  chmodSync(join(status.run_dir ?? ws, 'batches'), 0o755);
  assert.equal(result.status, '停止');
  assert.ok(result.stop_report.reasons.some((x) => x.code === '保存の失敗'), JSON.stringify(result.stop_report.reasons));
  assert.ok(result.records.unsaved.length >= 1);
  for (const u of result.records.unsaved) assert.ok(u.reason.length > 0);
  const saved = new Set(result.records.saved.map((s) => s.ref));
  for (const u of result.records.unsaved) if (u.ref) assert.equal(saved.has(u.ref), false);
  for (const s of result.records.saved) {
    assert.ok(existsSync(join(status.run_dir, s.ref)), `${s.ref}`);
    if (s.hash) assert.equal(fileHash(join(status.run_dir, s.ref)), s.hash);
  }
  assert.ok(result.stop_report.reasons.some((x) => x.code === '記録の未保存'), '途中で書けなかった run は 記録の未保存 も入る');
});

test('SP-FORMALMETHOD-010 AC-10 demonstration: 互いに依存しない性質を複数持つ対象で、道具の process が同時に複数ある（ps の標本）', async (t) => {
  if (availableParallelism() < 2) { t.skip('CPU が 1 つの環境では同時に動かす数が 1 になる'); return; }
  const tag = `ac10-${process.pid}-${Date.now()}`;
  const props = [P('P1', 2), P('P2', 3), P('P3', 4)].map((p) => ({ ...p, query: { result: 'unsat', sleepMs: 3000 } }));
  let maxSeen = 0;
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      const ps = execFileSync('ps', ['-A', '-o', 'command='], { encoding: 'utf8' });
      const n = ps.split('\n').filter((l) => l.includes(`--fake-tag=${tag}`) && !l.includes('-version')).length;
      maxSeen = Math.max(maxSeen, n);
      await sleep(150);
    }
  })();
  const out = await runScenario(t, { scenario: { properties: props }, tag });
  sampling = false;
  await sampler;
  assert.ok(maxSeen >= 2, `ps で見た道具の process の最大の数: ${maxSeen}`);
  const ivs = out.log().filter((e) => e.kind === 'query-start' && e.sleep_ms === 3000).map((e) => [e.at_ms, e.at_ms + 3000]);
  assert.ok(ivs.some((a, i) => ivs.some((b, j) => i !== j && a[0] < b[1] && b[0] < a[1])), '道具の記録でも実行が重なる');
});

test('SP-FORMALMETHOD-010 AC-10: 依頼元の時間の上限に達すると、実行中の検査（確認用を含む）を止め、始めていない検査を始めず、完了と未完了の範囲を示す', { timeout: 400000 }, async (t) => {
  // 担当の batch の期限は run の期限 − 残す時間（min(60 秒, 150/4 秒) = 37.5 秒）なので、担当が返る時間を残す
  const limit = 150;
  const props = [P('P1', 2, { query: { result: 'unsat', sleepMs: 280000 } }), P('P2', 3, { sanity: { result: 'sat', sleepMs: 280000 } })];
  const started = Date.now();
  const out = await runScenario(t, { request: canonicalRequest({ time_limit_seconds: limit }), scenario: { toolTimeLimit: 300, properties: props } });
  const r = out.result;
  assert.equal(r.status, '停止');
  assert.ok(r.stop_report.reasons.some((x) => x.code === '時間の上限'));
  const c1 = r.checks.find((c) => r.properties.find((p) => p.id === 'P1').check_ids.includes(c.id));
  assert.equal(c1.verdict, '時間切れ');
  assert.equal(c1.end.stopped_by, '時間');
  assert.equal(c1.end.time_limit_hit, '依頼元');
  assert.ok(c1.incomplete_scope !== null && c1.completed_scope !== null, '途中で止まった検査は完了と未完了の範囲を持つ');
  const stoppedKinds = [...r.stop_report.checks_aborted, ...r.stop_report.checks_running].map((x) => x.kind);
  assert.ok(stoppedKinds.includes('property'));
  assert.ok(stoppedKinds.some((k) => ['sanity', 'mutation', 'replay'].includes(k)), `確認用の実行も止まり stop_report に出る: ${stoppedKinds.join()}`);
  // 検査に使える期限は run の期限 − 残す時間（min(60 秒, 上限の 1/4) = 37.5 秒）。起動の遅れを 3 秒まで見込む
  const deadline = started + (limit - Math.min(60, limit / 4)) * 1000 + 3000;
  for (const e of out.log().filter((x) => x.kind === 'query-start')) assert.ok(e.at_ms <= deadline, '時間の上限の後に道具の実行を始めない');
  for (const c of r.checks.filter((x) => x.state === '実行していない')) assert.equal(c.verdict, '未実行');
  await sleep(500);
  for (const pid of [...new Set(out.log().map((e) => e.pid))]) assert.equal(alive(pid), false, `道具の process ${pid} が残らない`);
});

test('cli-contract 結果と台帳の保存の失敗: salvage の追補台帳の公開が「既にあって指紋が違う」で失敗し result.json が無ければ、結果を公開せず、停止 の R\' を返し、台帳と結果を unsaved に理由付きで載せる', async (t) => {
  const { ws, env, dir } = await killedWhileWaitingForAgents(t);
  writeFileSync(join(dir, 'salvage-ledger.json'), JSON.stringify({ schema: 'formal-method.ledger/1', run_id: 'other', kind: 'salvage', entries: [], registered_result_hash: `sha256:${'1'.repeat(64)}` }));
  const r = expectOk(await cli('salvage', { run_dir: dir }, { cwd: ws, env }), 'salvage').status.result;
  assert.deepEqual(resultInvariants(r), []);
  assert.equal(r.status, '停止');
  assert.equal(existsSync(join(dir, 'result.json')), false, '台帳の公開に失敗したら結果を公開しない');
  const kinds = r.records.unsaved.map((u) => u.kind);
  assert.ok(kinds.includes('salvage_ledger') && kinds.includes('result'), kinds.join());
  for (const u of r.records.unsaved) assert.ok(u.reason.length > 0);
  assert.ok(!r.records.saved.some((x) => x.ref === 'result.json' || x.ref === 'salvage-ledger.json'));
  assert.ok(r.stop_report.reasons.some((x) => x.code === '保存の失敗' && x.stage === '集約'), JSON.stringify(r.stop_report.reasons));
  assert.ok(r.stop_report.reasons.some((x) => x.code === '記録の未保存'));
  assert.equal(r.provisional, true, '公開されずに返った R\' は仮の結果');
});

test('cli-contract salvage の手順: salvage.mark を置いた後、run-daemon は state.json・status.json・result.json・ledger.json を書かずに終わる（生死の判定を誤らせる偽の ps）', async (t) => {
  const ws = setupWorkspace();
  const bin = `${ws}-bin`;
  const fakePs = `${ws}-ps`;
  t.after(() => { removeTree(ws); removeTree(bin); removeTree(fakePs); });
  const path = pathWithFake(makeFakeBin(bin));
  const env = cliEnv({ path });
  const s0 = expectOk(await cli('start', { request: canonicalRequest() }, { cwd: ws, env }), 'start').status;
  let status = s0;
  for (let i = 0; status.action !== 'run_agents' && i < 50; i += 1) {
    status = expectOk(await cli('wait', { run_dir: status.run_dir, status_seq: status.seq }, { cwd: ws, env }), 'wait').status ?? status;
  }
  assert.equal(status.action, 'run_agents');
  const dir = status.run_dir;
  // salvage にだけ、開始時刻を違えて返す ps を見せる（保持者が終わったと誤らせる）
  mkdirSync(fakePs, { recursive: true });
  writeFileSync(join(fakePs, 'ps'), '#!/bin/sh\necho "Mon Jan  1 00:00:00 2001"\n');
  chmodSync(join(fakePs, 'ps'), 0o755);
  const salvaged = expectOk(await cli('salvage', { run_dir: dir }, { cwd: ws, env: cliEnv({ path: `${fakePs}:${path}` }) }), 'salvage').status;
  assert.equal(salvaged.action, 'terminal');
  assert.ok(existsSync(join(dir, 'salvage.mark')));
  const watched = ['state.json', 'status.json', 'result.json', 'ledger.json'];
  const bytes = () => Object.fromEntries(watched.map((n) => [n, existsSync(join(dir, n)) ? readFileSync(join(dir, n)).toString('base64') : null]));
  const before = bytes();
  await harnessSubmit(status, ws, env);
  for (let i = 0; i < 300 && alive(status.daemon.pid); i += 1) await sleep(100);
  assert.equal(alive(status.daemon.pid), false, 'run-daemon は終わる');
  assert.deepEqual(bytes(), before, 'salvage.mark の後は何も書かない');
  assert.ok(existsSync(join(dir, 'result.json')), 'salvage が result.json に公開した');
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8')), salvaged.result, 'run の結果は result.json の 1 つ');
  assert.deepEqual(readdirSync(dir).filter((n) => /result\.json$/.test(n)), ['result.json']);
});

async function harnessSubmit(status, ws, env) {
  const h = makeHarness(defaultScenario());
  await h.onAgents(status, { cwd: ws, env });
}

test('cli-contract 結果と台帳の保存の失敗 公開の負け: salvage が result.json を公開した後に来た salvage は、自分の結果を作らずに既にある result.json を返す', async (t) => {
  const { ws, env, dir } = await killedWhileWaitingForAgents(t);
  const first = expectOk(await cli('salvage', { run_dir: dir }, { cwd: ws, env }), 'salvage').status.result;
  // 既にある結果の中身によらず、それを返す（結果の形に合う別の結果に置き換えて確かめる）
  const other = { ...first, unverified: [...first.unverified, { item: '既にある結果の印', reason: 'テストが置いた' }] };
  const { rmSync } = await import('node:fs');
  rmSync(join(dir, 'result.json'));
  writeFileSync(join(dir, 'result.json'), JSON.stringify(other));
  const again = expectOk(await cli('salvage', { run_dir: dir }, { cwd: ws, env }), 'salvage').status.result;
  assert.deepEqual(again, other);
});

test('cli-contract status.json は記録に数えない: status.json を書けなくなった run-daemon は何も書かずに終わり、wait は E_STALE、salvage が result.json に結果を公開する', async (t) => {
  const ws = setupWorkspace();
  const bin = `${ws}-bin`;
  t.after(() => { removeTree(ws); removeTree(bin); });
  const env = cliEnv({ path: pathWithFake(makeFakeBin(bin)) });
  let status = expectOk(await cli('start', { request: canonicalRequest() }, { cwd: ws, env }), 'start').status;
  for (let i = 0; status.action !== 'run_agents' && i < 50; i += 1) {
    status = expectOk(await cli('wait', { run_dir: status.run_dir, status_seq: status.seq }, { cwd: ws, env }), 'wait').status ?? status;
  }
  assert.equal(status.action, 'run_agents');
  const dir = status.run_dir;
  // status.json の置き換え（rename）だけを失敗させる: 同じ名前を空でないディレクトリにする
  const { rmSync } = await import('node:fs');
  rmSync(join(dir, 'status.json'));
  mkdirSync(join(dir, 'status.json', 'block'), { recursive: true });
  const watched = () => Object.fromEntries(['state.json', 'ledger.json', 'result.json'].map((n) => [n, existsSync(join(dir, n)) ? readFileSync(join(dir, n)).toString('base64') : null]));
  const h = makeHarness(defaultScenario());
  await h.onAgents(status, { cwd: ws, env });
  for (let i = 0; i < 600 && alive(status.daemon.pid); i += 1) await sleep(100);
  assert.equal(alive(status.daemon.pid), false, 'run-daemon は終わる');
  const afterDaemon = watched();
  assert.equal(afterDaemon['result.json'], null, 'run-daemon は結果を公開しない');
  expectRejected(await cli('wait', { run_dir: dir, status_seq: status.seq }, { cwd: ws, env }), 'E_STALE');
  const r = expectOk(await cli('salvage', { run_dir: dir }, { cwd: ws, env }), 'salvage').status.result;
  assert.equal(r.status, '停止');
  assert.equal(r.provisional, false, 'salvage が公開した結果は正の結果');
  assert.ok(r.stop_report.reasons.some((x) => x.code === '処理の中断'));
  assert.ok(!r.records.unsaved.some((u) => /status/.test(u.ref ?? '')), 'status.json は未保存の記録に数えない');
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8')), r);
});

test('cli-contract 状態を決める順序 SP-FORMALMETHOD-014・015: 集約の段で台帳・結果を公開できなければ、完了 を出さず、公開しない 停止 の R\' を返す（保存の失敗（集約）と記録の未保存）', async (t) => {
  if (skipIfRoot(t)) return;
  const ws = setupWorkspace();
  const bin = `${ws}-bin`;
  t.after(() => { removeTree(ws); removeTree(bin); });
  const env = cliEnv({ path: pathWithFake(makeFakeBin(bin)) });
  // 確認の段の最後の batch を返した後、結果と台帳の公開先（run の領域）に書けなくする。status.json の書込みも失敗するので、
  // 結果は status.json の terminal か、E_STALE からの salvage の経路で返る。どちらでも 完了 は出ず、result.json は無い。
  let lockedDir = null;
  const harness = makeHarness(defaultScenario(), {
    beforeSubmit: async (s, list) => {
      if (list.tasks.every((x) => x.context.stage === '確認') && !lockedDir) { lockedDir = s.run_dir; }
    },
  });
  const out = { result: null, error: null };
  let st = expectOk(await cli('start', { request: canonicalRequest() }, { cwd: ws, env }), 'start').status;
  for (let step = 0; step < 200 && st.action !== 'terminal'; step += 1) {
    if (st.action === 'run_agents') {
      await harness.onAgents(st, { cwd: ws, env });
      if (lockedDir) chmodSync(lockedDir, 0o555);
    }
    const w = await cli('wait', { run_dir: st.run_dir, status_seq: st.seq }, { cwd: ws, env });
    if (w.json?.code === 'E_STALE') {
      const sv = await cli('salvage', { run_dir: st.run_dir }, { cwd: ws, env });
      if (sv.json?.ok) st = sv.json.status; else { out.error = sv.json; break; }
      continue;
    }
    const j = expectOk(w, 'wait');
    if (j.status) st = j.status;
  }
  if (lockedDir) chmodSync(lockedDir, 0o755);
  assert.ok(lockedDir, '確認の段の batch が出た');
  assert.equal(existsSync(join(lockedDir, 'result.json')), false, '公開できなかった結果は無い');
  if (st.action === 'terminal') {
    const r = st.result;
    assert.equal(r.status, '停止', 'status.json の terminal に 完了 が出るのは result.json の公開に通ったときだけ');
    assert.ok(r.stop_report.reasons.some((x) => x.code === '保存の失敗'), JSON.stringify(r.stop_report.reasons));
    assert.ok(r.records.unsaved.some((u) => u.kind === 'result'));
    assert.equal(r.provisional, true, '公開されずに返った結果は仮の結果');
  } else {
    assert.ok(out.error, '結果を返せないときは誤りの出力が返る');
  }
  // 領域を書けるようにして salvage を呼ぶと、result.json が公開され、正の結果に置き換わる
  const sv = expectOk(await cli('salvage', { run_dir: lockedDir }, { cwd: ws, env }), 'salvage').status.result;
  assert.equal(sv.provisional, false);
  assert.deepEqual(JSON.parse(readFileSync(join(lockedDir, 'result.json'), 'utf8')), sv);
});

test('cli-contract salvage 4: salvage.mark を I/O の誤りで書けなければ（run の領域が書込み不可）、公開しない 停止 の R\' を標準出力で返し、何度呼んでも同じ内容', async (t) => {
  if (skipIfRoot(t)) return;
  const { ws, env, dir } = await killedWhileWaitingForAgents(t);
  chmodSync(dir, 0o555);
  t.after(() => { try { chmodSync(dir, 0o755); } catch { /* 消し済み */ } });
  const first = expectOk(await cli('salvage', { run_dir: dir }, { cwd: ws, env }), 'salvage').status;
  const second = expectOk(await cli('salvage', { run_dir: dir }, { cwd: ws, env }), 'salvage').status;
  chmodSync(dir, 0o755);
  assert.equal(first.action, 'terminal');
  const r = first.result;
  assert.deepEqual(resultInvariants(r), []);
  assert.equal(r.status, '停止');
  assert.equal(r.provisional, true, '公開しない R\' は仮の結果');
  const reasons = r.stop_report.reasons;
  assert.ok(reasons.some((x) => x.code === '処理の中断'), JSON.stringify(reasons));
  assert.ok(reasons.some((x) => x.code === '保存の失敗' && x.stage === '集約'), JSON.stringify(reasons));
  const kinds = r.records.unsaved.map((u) => u.kind);
  for (const k of ['salvage_worklog', 'salvage_ledger', 'result']) assert.ok(kinds.includes(k), `${k} が unsaved に載る: ${kinds.join()}`);
  for (const u of r.records.unsaved) assert.ok(u.reason.length > 0);
  assert.equal(existsSync(join(dir, 'result.json')), false, 'R\' は公開しない');
  assert.equal(existsSync(join(dir, 'salvage.mark')), false);
  assert.deepEqual(second.result, r, 'R\' は決定的で、何度呼んでも同じ内容');
  // 領域を書けるようにして salvage を呼ぶと、result.json が公開され、それが正の結果になる
  const final = expectOk(await cli('salvage', { run_dir: dir }, { cwd: ws, env }), 'salvage').status.result;
  assert.equal(final.provisional, false);
  assert.ok(existsSync(join(dir, 'result.json')));
  const published = JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8'));
  assert.deepEqual(published, final, '正の結果は result.json');
  assert.equal(published.provisional, false);
  assert.deepEqual(resultInvariants(published), []);
  const again = expectOk(await cli('salvage', { run_dir: dir }, { cwd: ws, env }), 'salvage').status.result;
  assert.deepEqual(again, published, '以後は公開された結果を返す');
});

test('cli-contract wait・salvage 3: 壊れた status.json（JSON でない）は seq が増えていないものとし、保持者が終われば wait は E_STALE、salvage は規則 4 に進み result.json に結果を公開する', async (t) => {
  const { ws, env, dir } = await killedWhileWaitingForAgents(t);
  const { rmSync } = await import('node:fs');
  rmSync(join(dir, 'status.json'));
  writeFileSync(join(dir, 'status.json'), '{"seq": 9, "action": "termin');
  expectRejected(await cli('wait', { run_dir: dir, status_seq: 0 }, { cwd: ws, env }), 'E_STALE');
  const r = expectOk(await cli('salvage', { run_dir: dir }, { cwd: ws, env }), 'salvage').status.result;
  assert.equal(r.status, '停止');
  assert.ok(r.stop_report.reasons.some((x) => x.code === '処理の中断'));
  assert.ok(existsSync(join(dir, 'salvage.mark')), '規則 4 に進んだ');
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8')), r);
});

test('cli-contract 仮の結果と正の結果: 結果の公開に失敗した R\' は仮の結果（provisional: true・result が unsaved・停止）で、領域を書けるようにして salvage を呼ぶと result.json が公開され正の結果になる', async (t) => {
  if (skipIfRoot(t)) return;
  const { ws, env, dir } = await killedWhileWaitingForAgents(t);
  chmodSync(dir, 0o555);
  t.after(() => { try { chmodSync(dir, 0o755); } catch { /* 消し済み */ } });
  const r1 = expectOk(await cli('salvage', { run_dir: dir }, { cwd: ws, env }), 'salvage').status.result;
  chmodSync(dir, 0o755);
  assert.deepEqual(resultInvariants(r1), []);
  assert.equal(r1.provisional, true);
  assert.equal(r1.status, '停止');
  assert.ok(r1.records.unsaved.some((u) => u.kind === 'result'));
  assert.equal(existsSync(join(dir, 'result.json')), false);
  const r2 = expectOk(await cli('salvage', { run_dir: dir }, { cwd: ws, env }), 'salvage').status.result;
  assert.deepEqual(resultInvariants(r2), []);
  assert.equal(r2.provisional, false);
  assert.ok(!r2.records.unsaved.some((u) => u.kind === 'result'));
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8')), r2);
});
