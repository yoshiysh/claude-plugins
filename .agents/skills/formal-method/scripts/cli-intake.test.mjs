// 結合: 担当を起動せずに終わるケース。コマンドの入力の誤り、保存先の能力、依頼の秘密値、受け付けない依頼（AC-15）。
// 正本: cli-contract.md「誤りと終了コード」「起動の手順」「run の領域の配置」、artifact-formats.md「依頼」、SP-FORMALMETHOD-001・014。
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { cli, cliEnv, drive, expectOk, expectRejected, makeWorkspace, removeTree, RUNS, skipIfRoot } from './test-fixtures/cli-runner.mjs';
import { listTree, fileHash } from './test-fixtures/fabricate.mjs';
import { resultInvariants, validate, Status } from './test-fixtures/result-schema.mjs';
import { execFileSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { basename } from 'node:path';
import { pathWithout } from './test-fixtures/make-fake-bin.mjs';

function workspaceWithTarget() {
  const ws = makeWorkspace();
  mkdirSync(join(ws, 'target'));
  writeFileSync(join(ws, 'target', 'spec.md'), '# 対象\nR1: x は常に 0 以上である。\nR2: y は x より大きい。\n');
  writeFileSync(join(ws, 'target', 'blob.bin'), Buffer.from([0x00, 0x01, 0x02, 0x0a]));
  return ws;
}

const baseRequest = () => ({
  targets: [{ id: 'T1', location: 'target' }],
  goals: [{ id: 'G1', text: 'R1 と R2 が成り立つ' }],
});

// ---- 誤りと終了コード ----
const CONTRACT_CASES = [
  ['未知のコマンド', ['nope'], '{}'],
  ['引数が 0 個', [], '{}'],
  ['引数が 2 個', ['start', 'extra'], JSON.stringify({ request: baseRequest() })],
  ['start の標準入力が JSON でない', ['start'], '{not json'],
  ['wait の標準入力が JSON でない', ['wait'], ''],
  ['salvage の標準入力が JSON でない', ['salvage'], 'null x'],
  ['submit の標準入力が JSON でない', ['submit'], '[1,'],
];
for (const [name, args, stdin] of CONTRACT_CASES) {
  test(`cli-contract 誤りと終了コード E_CONTRACT: ${name} は終了コード 2 で、何も書かない`, async (t) => {
    const ws = makeWorkspace();
    t.after(() => removeTree(ws));
    const r = await cli(args, stdin, { cwd: ws });
    expectRejected(r, 'E_CONTRACT');
    assert.equal(existsSync(join(ws, '.formal-method')), false);
  });
}

// [名前, コマンド, 入力, 期待の detail.reason]
const INPUT_CASES = [
  ['start に request が無い', 'start', {}, 'shape'],
  ['start の入力が配列', 'start', [{ request: {} }], 'shape'],
  ['wait に run_dir が無い', 'wait', { status_seq: 0 }, 'shape'],
  ['wait の run_dir が文字列でない', 'wait', { run_dir: 1, status_seq: 0 }, 'shape'],
  ['wait の status_seq が負', 'wait', { run_dir: '<ws>', status_seq: -1 }, 'shape'],
  ['wait の status_seq が整数でない', 'wait', { run_dir: '<ws>', status_seq: 1.5 }, 'shape'],
  ['wait の status_seq が文字列', 'wait', { run_dir: '<ws>', status_seq: '1' }, 'shape'],
  ['wait の run_dir が無いディレクトリ', 'wait', { run_dir: '<ws>/missing', status_seq: 0 }, 'run_dir_not_found'],
  ['salvage の run_dir が無い', 'salvage', {}, 'shape'],
  ['salvage の run_dir が無いディレクトリ', 'salvage', { run_dir: '<ws>/missing' }, 'run_dir_not_found'],
  ['submit に batch_id が無い', 'submit', { run_dir: '<ws>', workflow_output_path: '/x' }, 'shape'],
  ['submit に workflow_output_path も timed_out も無い', 'submit', { run_dir: '<ws>', batch_id: 'b1' }, 'shape'],
  ['submit の timed_out が false', 'submit', { run_dir: '<ws>', batch_id: 'b1', timed_out: false }, 'shape'],
  ['submit に workflow_output_path と timed_out の両方', 'submit', { run_dir: '<ws>', batch_id: 'b1', workflow_output_path: '/x', timed_out: true }, 'shape'],
  ['submit の run_dir が無いディレクトリ', 'submit', { run_dir: '<ws>/missing', batch_id: 'b1', timed_out: true }, 'run_dir_not_found'],
  // batch_id は受け箱の file 名になるので Id の文字だけ（cli-contract「コマンド」の submit）
  ['submit の batch_id が ../x（path の区切りを含む）', 'submit', { run_dir: '<ws>', batch_id: '../x', timed_out: true }, 'shape'],
  ['submit の batch_id が a/b', 'submit', { run_dir: '<ws>', batch_id: 'a/b', workflow_output_path: '/x' }, 'shape'],
  ['submit の batch_id が空', 'submit', { run_dir: '<ws>', batch_id: '', timed_out: true }, 'shape'],
];
for (const [name, command, input, detailReason] of INPUT_CASES) {
  test(`cli-contract 誤りと終了コード E_INPUT: ${name} は終了コード 1 で、何も書かない`, async (t) => {
    const ws = makeWorkspace();
    t.after(() => removeTree(ws));
    const text = JSON.stringify(input).replaceAll('<ws>', ws);
    const before = listTree(ws);
    const r = await cli(command, text, { cwd: ws });
    const j = expectRejected(r, 'E_INPUT', detailReason);
    assert.equal(j.command, command);
    assert.deepEqual(listTree(ws), before);
    assert.equal(existsSync(join(ws, '.formal-method')), false);
  });
}

// ---- 保存先の能力（AC-13 の受付の段） ----
function assertAcceptStop(status, code) {
  assert.deepEqual(validate(Status, status), [], 'Status の形');
  assert.equal(status.action, 'terminal');
  assert.equal(status.run_dir, null);
  assert.equal(status.seq, 0);
  assert.equal(status.daemon, null);
  const r = status.result;
  assert.deepEqual(resultInvariants(r), []);
  assert.equal(r.status, '停止');
  assert.equal(r.provisional, true, 'run_dir: null で返る結果は仮の結果');
  assert.ok(r.records.unsaved.some((u) => u.kind === 'result'));
  assert.equal(r.stop_report.stage, '受付');
  assert.ok(r.stop_report.reasons.some((x) => x.code === code && x.stage === '受付'), JSON.stringify(r.stop_report.reasons));
  assert.deepEqual(r.records.saved, [], '保存できた記録は無い');
  return r;
}

test('SP-FORMALMETHOD-014 AC-13: 保存先の root（.formal-method/runs/）が書込み不可なら、run-daemon を起動せず 保存の失敗 の停止を返し、結果を含む全ての記録が unsaved', async (t) => {
  if (skipIfRoot(t)) return;
  const ws = workspaceWithTarget();
  t.after(() => removeTree(ws));
  mkdirSync(join(ws, RUNS), { recursive: true });
  chmodSync(join(ws, RUNS), 0o555);
  const r = await cli('start', { request: baseRequest() }, { cwd: ws });
  const status = expectOk(r, 'start').status;
  const result = assertAcceptStop(status, '保存の失敗');
  const kinds = result.records.unsaved.map((u) => u.kind);
  assert.ok(kinds.includes('result'), '結果のファイル自身が unsaved に載る');
  assert.ok(kinds.includes('ledger'), '台帳が unsaved に載る');
  for (const u of result.records.unsaved) assert.ok(u.reason.length > 0);
  assert.deepEqual(readdirSync(join(ws, RUNS)), [], '保存先に何も残らない');
  assert.deepEqual([...new Set(result.stop_report.unsaved)].sort(), [...new Set(kinds)].sort());
});

test('SP-FORMALMETHOD-014 AC-13 境界: .formal-method/ 自体を作れない（workspace が書込み不可）場合も 保存の失敗 の停止を返す', async (t) => {
  if (skipIfRoot(t)) return;
  const ws = workspaceWithTarget();
  t.after(() => removeTree(ws));
  chmodSync(ws, 0o555);
  const r = await cli('start', { request: baseRequest() }, { cwd: ws });
  assertAcceptStop(expectOk(r, 'start').status, '保存の失敗');
  chmodSync(ws, 0o755);
  assert.equal(existsSync(join(ws, '.formal-method', 'runs')) && readdirSync(join(ws, RUNS)).length > 0, false);
});

// ---- 秘密値の走査（cli-contract「run の領域の配置」） ----
const SECRET_CASES = [
  ['private_key', '-----BEGIN OPENSSH PRIVATE KEY-----'],
  ['private_key（種類なし）', '-----BEGIN PRIVATE KEY-----'],
  ['aws_access_key_id', 'AKIAABCDEFGHIJKLMNOP'],
  ['aws_access_key_id（ASIA）', 'ASIAABCDEFGHIJKLMNOP'],
  ['github_token', `ghp_${'a'.repeat(36)}`],
  ['slack_token', 'xoxb-1234567890-abcdef'],
];
for (const [name, secret] of SECRET_CASES) {
  test(`cli-contract 秘密値の走査 AC-15: 依頼に ${name} の型があれば request.input.json を書かず、保存の失敗 の停止で、値を出力に残さない`, async (t) => {
    const ws = workspaceWithTarget();
    t.after(() => removeTree(ws));
    const req = baseRequest();
    req.goals[0].text = `鍵 ${secret} を扱う`;
    const r = await cli('start', { request: req }, { cwd: ws });
    const result = assertAcceptStop(expectOk(r, 'start').status, '保存の失敗');
    assert.ok(result.records.unsaved.some((u) => u.kind === 'request'), '依頼が unsaved に載る');
    const runs = join(ws, RUNS);
    const files = existsSync(runs) ? listTree(runs) : [];
    assert.deepEqual(files.filter((f) => f.endsWith('request.input.json')), [], 'request.input.json が無い');
    assert.deepEqual(files, [], '一時の領域（removeOwnTmp）も能力の確認の領域（removeProbeDir）も残らない');
    assert.equal(r.stdout.includes(secret), false, '標準出力に値が無い');
    assert.equal(r.stderr.includes(secret), false, '標準エラーに値が無い');
  });
}

const NOT_SECRET = [
  ['password= の代入', 'password=hunter2'],
  ['sk- の接頭辞', `sk-${'a'.repeat(40)}`],
  ['AKIA の桁が足りない', 'AKIAABCDEFGHIJKLMNO'],
  ['gh トークンの桁が足りない', `ghp_${'a'.repeat(35)}`],
];
for (const [name, value] of NOT_SECRET) {
  test(`cli-contract 秘密値の走査 AC-15 境界: 4 つの型に無い形（${name}）では 保存の失敗 で止めない`, async (t) => {
    const ws = workspaceWithTarget();
    t.after(() => removeTree(ws));
    // 対象を渡さない依頼にして、担当を起動せずに受付の検査まで進める
    const req = { goals: [{ id: 'G1', text: `値 ${value}` }] };
    const { result, status } = await drive(ws, req, {});
    assert.notEqual(status.run_dir, null, 'run の領域ができる（秘密値の走査で止まらない）');
    assert.equal(result.status, '停止');
    assert.ok(!result.stop_report.reasons.some((x) => x.code === '保存の失敗'), JSON.stringify(result.stop_report.reasons));
    assert.ok(result.stop_report.reasons.some((x) => x.request_code === 'target_missing'));
  });
}

// ---- 受け付けない依頼（AC-15）----
// [名前, 依頼を作る関数(ws), 期待の request_code, 期待の item か field（任意）]
const REJECT_CASES = [
  ['対象なし（キーが無い）', () => ({ goals: baseRequest().goals }), 'target_missing'],
  ['対象なし（空）', () => ({ ...baseRequest(), targets: [] }), 'target_missing'],
  ['目標なし（キーが無い）', () => ({ targets: baseRequest().targets }), 'goal_missing'],
  ['目標なし（空）', () => ({ ...baseRequest(), goals: [] }), 'goal_missing'],
  ['空の文字列', () => ({ ...baseRequest(), goals: [{ id: 'G1', text: '' }] }), 'shape_invalid', { field: '/goals/0/text' }],
  ['必須のキーの欠け（location）', () => ({ ...baseRequest(), targets: [{ id: 'T1' }] }), 'shape_invalid', { field: '/targets/0/location' }],
  ['型の違い（targets が文字列）', () => ({ ...baseRequest(), targets: 'target' }), 'shape_invalid', { field: '/targets' }],
  ['Id の形の違い（空白を含む）', () => ({ ...baseRequest(), goals: [{ id: 'G 1', text: 'x' }] }), 'shape_invalid', { field: '/goals/0/id' }],
  ['識別子の重複（対象）', () => ({ ...baseRequest(), targets: [{ id: 'T1', location: 'target' }, { id: 'T1', location: 'target/spec.md' }] }), 'duplicate_id'],
  ['識別子の重複（目標）', () => ({ ...baseRequest(), goals: [{ id: 'G1', text: 'a' }, { id: 'G1', text: 'b' }] }), 'duplicate_id'],
  ['識別子の重複（既知の要求）', () => ({ ...baseRequest(), known_requirements: [{ id: 'K1', text: 'a' }, { id: 'K1', text: 'b' }] }), 'duplicate_id'],
  ['理由の無い除外', () => ({ ...baseRequest(), scope: { include: [{ kind: 'target', id: 'T1' }], exclude: [{ item: { kind: 'goal', id: 'G1' } }] } }), 'exclude_without_reason', { item: { kind: 'goal', id: 'G1' } }],
  ['依頼に無いものを指す範囲', () => ({ ...baseRequest(), scope: { include: [{ kind: 'goal', id: 'G9' }], exclude: [] } }), 'pointer_unresolved', { item: { kind: 'goal', id: 'G9' } }],
  ['依頼に無いものを指す除外', () => ({ ...baseRequest(), scope: { include: [{ kind: 'target', id: 'T1' }], exclude: [{ item: { kind: 'target', id: 'T9' }, reason: 'x' }] } }), 'pointer_unresolved', { item: { kind: 'target', id: 'T9' } }],
  ['対象に無いファイルを指す範囲', () => ({ ...baseRequest(), scope: { include: [{ kind: 'location', target_id: 'T1', file: 'missing.md' }], exclude: [] } }), 'pointer_unresolved'],
  ['ファイルの行数を超える範囲', () => ({ ...baseRequest(), scope: { include: [{ kind: 'location', target_id: 'T1', file: 'spec.md', span: 'L1-L5' }], exclude: [] } }), 'pointer_unresolved'],
  ['バイナリのファイルの行を指す範囲', () => ({ ...baseRequest(), scope: { include: [{ kind: 'location', target_id: 'T1', file: 'blob.bin', span: 'L1-L1' }], exclude: [] } }), 'pointer_unresolved'],
  ['目標の出所が対象に無い箇所', () => ({ ...baseRequest(), goals: [{ id: 'G1', text: 'x', source: { target_id: 'T1', file: 'spec.md', span: 'L5-L5' } }] }), 'pointer_unresolved'],
  ['目標の出所が依頼に無い対象', () => ({ ...baseRequest(), goals: [{ id: 'G1', text: 'x', source: { target_id: 'T9', file: 'spec.md', span: 'L1-L1' } }] }), 'pointer_unresolved'],
  ['時間の上限が 0', () => ({ ...baseRequest(), time_limit_seconds: 0 }), 'time_limit_invalid'],
  ['時間の上限が負', () => ({ ...baseRequest(), time_limit_seconds: -1 }), 'time_limit_invalid'],
  ['時間の上限が整数でない', () => ({ ...baseRequest(), time_limit_seconds: 1.5 }), 'time_limit_invalid'],
  ['時間の上限が文字列', () => ({ ...baseRequest(), time_limit_seconds: '10' }), 'time_limit_invalid'],
  ['時間の上限が null', () => ({ ...baseRequest(), time_limit_seconds: null }), 'time_limit_invalid'],
  ['時間の上限が真偽値', () => ({ ...baseRequest(), time_limit_seconds: true }), 'time_limit_invalid'],
  ['空のファイル（0 行）の行を指す範囲', (ws) => { writeFileSync(join(ws, 'target', 'empty.md'), ''); return { ...baseRequest(), scope: { include: [{ kind: 'location', target_id: 'T1', file: 'empty.md', span: 'L1-L1' }], exclude: [] } }; }, 'pointer_unresolved'],
  ['末尾の改行の後の空の要素を指す範囲（3 行のファイルの L4）', () => ({ ...baseRequest(), scope: { include: [{ kind: 'location', target_id: 'T1', file: 'spec.md', span: 'L4-L4' }], exclude: [] } }), 'pointer_unresolved'],
  ['取得できない対象（location が無い）', () => ({ ...baseRequest(), targets: [{ id: 'T1', location: 'nowhere' }] }), 'target_unavailable'],
  ['取得できない対象（扱えない URI）', () => ({ ...baseRequest(), targets: [{ id: 'T1', location: 'https://example.com/spec.md' }] }), 'target_unavailable'],
  ['取得できない対象（file:// の先が無い）', (ws) => ({ ...baseRequest(), targets: [{ id: 'T1', location: `file://${ws}/nowhere` }] }), 'target_unavailable'],
  ['取得できない対象（根を読めない）', (ws) => { mkdirSync(join(ws, 'locked')); writeFileSync(join(ws, 'locked', 'a.md'), 'a\n'); chmodSync(join(ws, 'locked'), 0o000); return { ...baseRequest(), targets: [{ id: 'T1', location: 'locked' }] }; }, 'target_unavailable'],
  ['取得できない対象（symbolic link の先が無い）', (ws) => { symlinkSync(join(ws, 'nowhere'), join(ws, 'dangling')); return { ...baseRequest(), targets: [{ id: 'T1', location: 'dangling' }] }; }, 'target_unavailable'],
  ['指紋の不一致', () => ({ ...baseRequest(), targets: [{ id: 'T1', location: 'target', content_hash: `sha256:${'0'.repeat(64)}` }] }), 'revision_mismatch'],
  ['git の外のファイルに revision を添える', () => ({ ...baseRequest(), targets: [{ id: 'T1', location: 'target/spec.md', revision: 'HEAD' }] }), 'revision_mismatch'],
];

for (const [name, make, code, where] of REJECT_CASES) {
  test(`SP-FORMALMETHOD-001 AC-15: ${name} は検証を始めず、受付の段の停止で ${code} と項目・理由を示す`, async (t) => {
    if (name.includes('根を読めない') && skipIfRoot(t)) return;
    const ws = workspaceWithTarget();
    t.after(() => removeTree(ws));
    const req = make(ws);
    const { status, result, statuses } = await drive(ws, req, {});
    for (const s of statuses) assert.notEqual(s.action, 'run_agents', '担当を起動しない');
    assert.deepEqual(resultInvariants(result), []);
    assert.equal(result.status, '停止');
    assert.equal(result.stop_report.stage, '受付');
    const hit = result.stop_report.reasons.filter((x) => x.code === '依頼の不備' && x.request_code === code);
    assert.ok(hit.length >= 1, JSON.stringify(result.stop_report.reasons));
    for (const h of hit) assert.ok(h.detail.length > 0, '理由');
    if (where?.field) assert.ok(hit.some((h) => h.field === where.field), `field ${where.field}: ${JSON.stringify(hit)}`);
    if (where?.item) assert.ok(hit.some((h) => isDeepStrictEqual(h.item, where.item)), `item: ${JSON.stringify(hit)}`);
    // 検証を始めていない: 対象の写しも検査の記録も無い
    assert.deepEqual(result.properties, []);
    assert.deepEqual(result.checks, []);
    assert.deepEqual(result.verified_scope.targets, []);
    if (status.run_dir) {
      assert.equal(existsSync(join(status.run_dir, 'targets')), false, '対象の写しが無い');
      assert.equal(existsSync(join(status.run_dir, 'checks')), false, '検査の記録が無い');
      assert.equal(existsSync(join(status.run_dir, 'batches')), false, 'task の一覧が無い');
    }
  });
}

test('SP-FORMALMETHOD-001・014 AC-15: 受付で止めた run は、run-daemon が記録を保存し、索引・台帳・結果を辿れる', async (t) => {
  const ws = workspaceWithTarget();
  t.after(() => removeTree(ws));
  const { status, result } = await drive(ws, { goals: baseRequest().goals }, {});
  const dir = status.run_dir;
  assert.ok(dir.startsWith(join(ws, RUNS) + '/'), `run_dir は保存先の root の下の絶対 path: ${dir}`);
  const runId = dir.slice(join(ws, RUNS).length + 1);
  const index = JSON.parse(readFileSync(join(ws, RUNS, 'index', `${runId}.json`), 'utf8'));
  assert.deepEqual(index, { run_id: runId, run_dir: dir, created_stage: '受付' });
  assert.ok(result.records.ledger_refs.includes('ledger.json'));
  const saved = Object.fromEntries(result.records.saved.map((s) => [s.ref, s]));
  assert.ok(saved['result.json'] && saved['result.json'].hash === null, '結果のファイル自身は hash: null');
  assert.ok(saved['ledger.json'] && saved['ledger.json'].hash === null, '台帳は hash: null');
  for (const s of result.records.saved) {
    assert.ok(existsSync(join(dir, s.ref)), `${s.ref} がある`);
    if (s.hash !== null) assert.equal(fileHash(join(dir, s.ref)), s.hash, `${s.ref} の指紋`);
  }
  const onDisk = JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8'));
  assert.deepEqual(onDisk, result, 'status の result と result.json が同じ');
  assert.equal(onDisk.provisional, false, '公開された result.json は正の結果');
  const ledger = JSON.parse(readFileSync(join(dir, 'ledger.json'), 'utf8'));
  assert.equal(ledger.schema, 'formal-method.ledger/1');
  assert.equal(ledger.kind, 'main');
  assert.equal(ledger.registered_result_hash, fileHash(join(dir, 'result.json')));
  assert.deepEqual(readdirSync(join(ws, RUNS)).filter((n) => n.startsWith('.tmp-') || n.startsWith('.probe-')), [], '一時の領域と能力の確認の領域が残らない');
  const runlog = join(dir, 'worklogs', 'cli-受付.json');
  assert.ok(existsSync(runlog), '入った段（受付）の作業記録 worklogs/cli-受付.json がある');
  assert.equal(JSON.parse(readFileSync(runlog, 'utf8')).stage, '受付');
});

// ---- 起動の手順: run-daemon の引数と標準入出力（cli-contract「呼び方と入力の口」「起動の手順」3） ----
const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; } };
test('cli-contract 呼び方と入力の口・起動の手順 3: start は run-daemon の生きている間に返り（標準入出力を繋がない）、標準出力は start の 1 行の JSON だけで、run-daemon の argv はコマンド名・run_id・nonce・一時の領域の絶対 path の 4 つ', async (t) => {
  const ws = workspaceWithTarget();
  let daemonPid = null;
  t.after(async () => {
    if (daemonPid) {
      try { process.kill(-daemonPid, 'SIGKILL'); } catch { try { process.kill(daemonPid, 'SIGKILL'); } catch { /* 終了済み */ } }
      for (let i = 0; i < 100 && isAlive(daemonPid); i += 1) await new Promise((r) => setTimeout(r, 50));
    }
    removeTree(ws);
  });
  // 担当を待つ状態で start が返る（担当の harness を動かさないので、run-daemon は担当の返り値を待ち続ける）
  const env = cliEnv({ path: pathWithout(['z3']) });
  const r = await cli('start', { request: baseRequest() }, { cwd: ws, env });
  let status = expectOk(r, 'start').status;
  assert.equal(r.lines, 1, 'start の標準出力は 1 行の JSON だけ（run-daemon の出力が混ざらない）');
  // start は最初の status.json をそのまま返す（cli-contract.md:117）ので working もありうる。担当を待つ状態まで wait で進める
  assert.ok(['working', 'run_agents'].includes(status.action), JSON.stringify(status));
  for (let i = 0; i < 20 && status.action === 'working'; i += 1) {
    const w = expectOk(await cli('wait', { run_dir: status.run_dir, status_seq: status.seq }, { cwd: ws, env }), 'wait');
    if (w.outcome !== 'still_waiting') status = w.status;
  }
  assert.equal(status.action, 'run_agents', '担当を待つ状態（run-daemon は生きている）');
  assert.ok(status.daemon, 'run-daemon の識別を返す');
  daemonPid = status.daemon.pid;
  // runCli は start の標準出力の close で返る。run-daemon が pipe を継いでいれば、ここで生きていることはない
  assert.equal(isAlive(daemonPid), true, 'start は run-daemon の生きている間に返る');
  const runId = basename(status.run_dir);
  const argv = execFileSync('ps', ['-ww', '-o', 'args=', '-p', String(daemonPid)], { encoding: 'utf8' }).trim().split(/\s+/);
  const at = argv.indexOf('run-daemon');
  assert.ok(at >= 0, `run-daemon のコマンド名: ${argv.join(' ')}`);
  const rest = argv.slice(at + 1);
  assert.equal(rest.length, 3, `run-daemon の後の引数は run_id・nonce・一時の領域の 3 つ: ${rest.join(' ')}`);
  assert.equal(rest[0], runId);
  assert.equal(rest[1], status.daemon.nonce);
  assert.equal(rest[2].replace(/\/$/, ''), join(ws, RUNS, `.tmp-${runId}-${status.daemon.nonce}`), '一時の領域の絶対 path');
});

test('SP-FORMALMETHOD-013 AC-12: 受付で止めた結果でも、CI の有無が performance.location に分かれる', async (t) => {
  const ws = workspaceWithTarget();
  t.after(() => removeTree(ws));
  const local = await drive(ws, { goals: baseRequest().goals }, { env: cliEnv({ ci: false }) });
  const ci = await drive(ws, { goals: baseRequest().goals }, { env: cliEnv({ ci: true }) });
  assert.equal(local.result.performance.location, 'ローカル');
  assert.equal(ci.result.performance.location, 'CI');
});
