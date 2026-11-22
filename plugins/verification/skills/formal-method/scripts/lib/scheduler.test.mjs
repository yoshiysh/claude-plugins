// unit: scripts/lib/scheduler.mjs の runExecution(execution, io)（architecture.md「scheduler の unit の入口」）。
// io.clock を偽の時計に、io.spawn を偽の process に、io.signal を AbortController の signal に差し替え、
// close・期限・停止の要求・出力の上限の順を起こす（verification-plan.md「照合 1」の scheduler の unit の行）。
// 期待値は architecture.md「期限と道具の終わりが重なったとき」「scheduler の unit の入口」と、cli-contract.md「Z3 の adapter」の
// 読む順・答えと tool_result の対応・出力の上限・答えの後の停止から決める。各行の end に classifyCheck を当て、例外にならないことも確かめる。
import test from 'node:test';
import assert from 'node:assert/strict';
import { invalidReason } from '../test-fixtures/spec-verdict.mjs';

const loadScheduler = () => import('./scheduler.mjs');
const loadVerdict = () => import('./verdict.mjs');
const loadSchemas = () => import('./schemas.mjs');

const enc = (s) => new TextEncoder().encode(s);
const bytes = (n, ch = 'x') => new Uint8Array(n).fill(ch.charCodeAt(0));
const concat = (...parts) => {
  const bs = parts.map((p) => (typeof p === 'string' ? enc(p) : p));
  const out = new Uint8Array(bs.reduce((n, b) => n + b.length, 0));
  let at = 0;
  for (const b of bs) { out.set(b, at); at += b.length; }
  return out;
};
const flush = () => new Promise((r) => setImmediate(r));

const DEADLINE = 1000;
// 実行の種類と with_model・expected の組は、cli-contract「Z3 の adapter」の -model と答えの対応どおりに置く（runExecution は kind を見ない）
const SPEC = {
  property: { execution_id: 'C-P1', kind: 'property', with_model: true, expected: 'unsat' },
  contract: { execution_id: 'C-K1', kind: 'contract', with_model: false, expected: 'unsat' },
  sanity: { execution_id: 'S-P1', kind: 'sanity', with_model: false, expected: 'sat' },
  mutation: { execution_id: 'MU-P1', kind: 'mutation', with_model: false, expected: 'sat' },
};
const spec = (kind, over = {}) => ({ ...SPEC[kind], query: enc('(check-sat)\n'), tool_time_limit_seconds: 30, deadline_ms: DEADLINE, ...over });

// End の既定（artifact-formats「検査の終わり方」）
const END = (over = {}) => ({ started: true, tool_result: 'なし', abnormal_exit: false, unreadable_output: false, stopped_by: null, time_limit_hit: null, ...over });
const NOT_STARTED = { started: false, tool_result: 'なし', abnormal_exit: false, unreadable_output: false, stopped_by: null, time_limit_hit: null };
const STOP_TIME = END({ stopped_by: '時間', time_limit_hit: '依頼元' });
const STOP_OTHER = END({ stopped_by: 'その他' });
const OVERFLOW = END({ unreadable_output: true, stopped_by: 'その他' });

// 偽の時計・偽の process・停止の要求。
// closeOnKill: 'auto' は killGroup の後に setImmediate で（postKillStdout を出してから）close を出す。'manual' はテストが close を出す。
function makeIo({ now = 0, closeOnKill = 'auto', killExit = null, postKillStdout = null, preAbort = false } = {}) {
  const ac = new AbortController();
  if (preAbort) ac.abort();
  const timers = [];
  const cbs = { stdout: [], stderr: [], close: [] };
  const state = { now, killCount: 0, spawnCount: 0, spawnedWith: null, setTimerAt: [], cleared: [], closed: false, closeScheduled: false, sent: [] };
  let resolveSpawned;
  const spawned = new Promise((r) => { resolveSpawned = r; });
  const emit = (kind, data) => {
    const b = typeof data === 'string' ? enc(data) : data;
    if (kind === 'stdout' && !state.closeScheduled && !state.closed) state.sent.push(b); // 止める前に送った標準出力
    for (const cb of cbs[kind]) cb(b);
  };
  const close = (code) => {
    if (state.closed) return; // close は 1 回だけ（ProcessHandle.onClose）
    state.closed = true;
    for (const cb of cbs.close) cb(code);
  };
  const proc = {
    onStdout: (cb) => { cbs.stdout.push(cb); },
    onStderr: (cb) => { cbs.stderr.push(cb); },
    onClose: (cb) => { cbs.close.push(cb); },
    killGroup: () => {
      state.killCount += 1;
      if (closeOnKill === 'auto' && !state.closeScheduled) {
        state.closeScheduled = true;
        setImmediate(() => { if (postKillStdout) emit('stdout', postKillStdout); close(killExit); });
      }
    },
  };
  const io = {
    clock: {
      now: () => state.now,
      setTimer: (at, cb) => { const h = { at, cb, cleared: false, fired: false }; timers.push(h); state.setTimerAt.push(at); return h; },
      clearTimer: (h) => { state.cleared.push(h); if (h && typeof h === 'object') h.cleared = true; },
    },
    spawn: (execution) => { state.spawnCount += 1; state.spawnedWith = execution; resolveSpawned(); return proc; },
    signal: ac.signal,
  };
  // 偽の時計を進め、外されていない timer のうち時刻に達したものを呼ぶ
  const advanceTo = (t) => {
    state.now = t;
    for (const h of timers) if (!h.cleared && !h.fired && h.at <= t) { h.fired = true; h.cb(); }
  };
  return {
    io, state, timers, spawned, close, advanceTo,
    stdout: (d) => emit('stdout', d), stderr: (d) => emit('stderr', d), abort: () => ac.abort(),
    deadline: () => advanceTo(DEADLINE),
  };
}

// 行: [名前, spec, makeIo の option, 出来事を起こす手順, { end, kill, model_cut, stdout?, exit_code?, timerCleared? }]
// stdout・exit_code は close が最初の行だけ確かめる（止めた後の値は契約が固定しない）。
function rows(MAX) {
  return [
    // ---- close が最初（stopped_by: null、killGroup を呼ばない、timer を外す。後の出来事は終わり方を変えない） ----
    ['close → 期限: 答え unsat・expected unsat・終了コード 0 は 満たす', spec('contract'), {},
      (h) => { h.stdout('unsat\n'); h.close(0); h.advanceTo(DEADLINE + 1); },
      { end: END({ tool_result: '満たす' }), kill: false, model_cut: 'none', stdout: 'unsat\n', exit_code: 0, timerCleared: true }],
    ['close → 停止の要求: sanity（expected sat）の答え unsat は 反する', spec('sanity'), {},
      (h) => { h.stdout('unsat\n'); h.close(0); h.abort(); },
      { end: END({ tool_result: '反する' }), kill: false, model_cut: 'none', stdout: 'unsat\n', exit_code: 0, timerCleared: true }],
    ['close → 期限: mutation（expected_violation sat）の答え sat は 満たす', spec('mutation'), {},
      (h) => { h.stdout('sat\n'); h.close(0); h.deadline(); },
      { end: END({ tool_result: '満たす' }), kill: false, model_cut: 'none', stdout: 'sat\n', exit_code: 0, timerCleared: true }],
    ['close → 期限: 答え timeout は 判定できない・time_limit_hit 道具', spec('contract'), {},
      (h) => { h.stdout('timeout\n'); h.close(0); h.deadline(); },
      { end: END({ tool_result: '判定できない', time_limit_hit: '道具' }), kill: false, model_cut: 'none', stdout: 'timeout\n', exit_code: 0, timerCleared: true }],
    ['close → 停止の要求: 答え unknown は 判定できない・time_limit_hit null', spec('contract'), {},
      (h) => { h.stdout('unknown\n'); h.close(0); h.abort(); },
      { end: END({ tool_result: '判定できない' }), kill: false, model_cut: 'none', stdout: 'unknown\n', exit_code: 0, timerCleared: true }],
    ['close → 期限: (error の行と終了コード 1 は 判定以外のエラー（読む順の 1 が 3 より先）', spec('contract'), {},
      (h) => { h.stdout('(error "line 1 column 9: unknown constant foo")\n'); h.close(1); h.deadline(); },
      { end: END({ tool_result: '判定以外のエラー' }), kill: false, model_cut: 'none', exit_code: 1, timerCleared: true }],
    ['close → 期限: 答えの行なし・標準エラーのみ・終了コード 101 は abnormal_exit', spec('contract'), {},
      (h) => { h.stderr('(error "out of memory")\n'); h.close(101); h.deadline(); },
      { end: END({ abnormal_exit: true }), kill: false, model_cut: 'none', stdout: '', stderr: '(error "out of memory")\n', exit_code: 101, timerCleared: true }],
    ['close → 期限: -model なしで空でない行が 2 つ（sat と unsat）は unreadable_output', spec('contract'), {},
      (h) => { h.stdout('sat\nunsat\n'); h.close(0); h.deadline(); },
      { end: END({ unreadable_output: true }), kill: false, model_cut: 'none', exit_code: 0, timerCleared: true }],
    ['close → 期限: 終了コード 0 で出力が空は unreadable_output', spec('contract'), {},
      (h) => { h.close(0); h.deadline(); },
      { end: END({ unreadable_output: true }), kill: false, model_cut: 'none', stdout: '', exit_code: 0, timerCleared: true }],
    ['close → 期限: -model ありで答え sat とモデルは 反する（モデルは読む順に使わない）', spec('property'), {},
      (h) => { h.stdout('sat\n(\n  (define-fun x () Int\n    (- 1))\n)\n'); h.close(0); h.deadline(); },
      { end: END({ tool_result: '反する' }), kill: false, model_cut: 'none', exit_code: 0, timerCleared: true }],
    ['close → 期限: -model ありで答えの後の (error の行と終了コード 1 は abnormal_exit（読む順の 0・3）', spec('property'), {},
      (h) => { h.stdout('sat\n(error "model is not available")\n'); h.close(1); h.deadline(); },
      { end: END({ abnormal_exit: true }), kill: false, model_cut: 'none', exit_code: 1, timerCleared: true }],
    ['close を受けた時点で clock.now() が期限を過ぎていても、timer が先に来ていなければ止めていない', spec('contract'), {},
      (h) => { h.state.now = DEADLINE + 5; h.stdout('unsat\n'); h.close(0); },
      { end: END({ tool_result: '満たす' }), kill: false, model_cut: 'none', stdout: 'unsat\n', exit_code: 0, timerCleared: true }],
    ['期限が無い（deadline_ms null）ときは timer を置かず、close で決まる', spec('contract', { deadline_ms: null }), {},
      (h) => { h.stdout('unsat\n'); h.close(0); },
      { end: END({ tool_result: '満たす' }), kill: false, model_cut: 'none', stdout: 'unsat\n', exit_code: 0, noTimer: true }],

    // ---- with_model: false で期限・停止の要求が最初 ----
    ['with_model false で期限 → close: 期限の前に答えの行を受けていても なし・時間・依頼元（止めた後の出力も使わない）', spec('contract'), { postKillStdout: 'sat\n' },
      (h) => { h.stdout('unsat\n'); h.deadline(); },
      { end: STOP_TIME, kill: true, model_cut: 'none' }],
    ['with_model false で停止の要求 → close: その他・time_limit_hit null', spec('contract'), {},
      (h) => { h.stdout('unsat\n'); h.abort(); },
      { end: STOP_OTHER, kill: true, model_cut: 'none' }],
    ['期限 → 停止の要求 → close: 先の期限で決まる', spec('contract'), { closeOnKill: 'manual' },
      (h) => { h.deadline(); h.abort(); h.close(null); },
      { end: STOP_TIME, kill: true, model_cut: 'none' }],
    ['停止の要求 → 期限 → close: 先の停止の要求で決まる', spec('contract'), { closeOnKill: 'manual' },
      (h) => { h.abort(); h.deadline(); h.close(null); },
      { end: STOP_OTHER, kill: true, model_cut: 'none' }],
    ['期限で止めた後の close の終了コードが 1 でも abnormal_exit にしない', spec('contract'), { killExit: 1 },
      (h) => { h.deadline(); },
      { end: STOP_TIME, kill: true, model_cut: 'none' }],
    ['停止の要求で止めた後の close の終了コードが null でも abnormal_exit にしない', spec('contract'), { killExit: null },
      (h) => { h.abort(); },
      { end: STOP_OTHER, kill: true, model_cut: 'none' }],
    ['停止の要求で止めた後の close の終了コードが 137 でも abnormal_exit にしない', spec('sanity'), { killExit: 137 },
      (h) => { h.stdout('sat\n'); h.abort(); },
      { end: STOP_OTHER, kill: true, model_cut: 'none' }],

    // ---- with_model: true（答えの後の停止） ----
    ['with_model true で答えの行が chunk にまたがり、改行を受けた後・close の前に期限: 答え sat で 反する・stopped_by null・止める', spec('property'), {},
      (h) => { h.stdout('sa'); h.stdout('t\n(\n  (define-fun x '); h.deadline(); },
      { end: END({ tool_result: '反する' }), kill: true, model_cut: 'stopped_after_answer' }],
    ['with_model true で答え unsat の後に停止の要求: 満たす・stopped_by null・止める', spec('property'), {},
      (h) => { h.stdout('unsat\n'); h.abort(); },
      { end: END({ tool_result: '満たす' }), kill: true, model_cut: 'stopped_after_answer' }],
    ['with_model true で答え timeout の後に期限: 判定できない・time_limit_hit 道具', spec('property'), {},
      (h) => { h.stdout('timeout\n'); h.deadline(); },
      { end: END({ tool_result: '判定できない', time_limit_hit: '道具' }), kill: true, model_cut: 'stopped_after_answer' }],
    ['with_model true で空の行の後の最初の空でない行が答え: 答えの後の停止', spec('property'), {},
      (h) => { h.stdout('\n\nsat\n'); h.deadline(); },
      { end: END({ tool_result: '反する' }), kill: true, model_cut: 'stopped_after_answer' }],
    ['with_model true で答えの行を読み終える前（改行の前）に期限: なし・時間・依頼元', spec('property'), {},
      (h) => { h.stdout('sa'); h.deadline(); },
      { end: STOP_TIME, kill: true, model_cut: 'none' }],
    ['with_model true で最初の空でない行が答えでない（(error の行）後に期限: 答えを読んでいないので なし・時間', spec('property'), {},
      (h) => { h.stdout('(error "x")\n'); h.deadline(); },
      { end: STOP_TIME, kill: true, model_cut: 'none' }],
    ['with_model true で答えの行の前に停止の要求: なし・その他', spec('property'), {},
      (h) => { h.abort(); },
      { end: STOP_OTHER, kill: true, model_cut: 'none' }],

    // ---- 出力の上限 ----
    ['with_model false で標準出力が 1 つの chunk で上限を超える: 止めて その他・unreadable_output', spec('contract'), {},
      (h) => { h.stdout(concat('unsat\n', bytes(MAX - 6 + 1, '\n'))); },
      { end: OVERFLOW, kill: true, model_cut: 'none' }],
    ['with_model false で上限ちょうどの後の 1 バイトで超える（chunk をまたぐ）: 止めて その他・unreadable_output', spec('contract'), {},
      (h) => { h.stdout(concat('unsat\n', bytes(MAX - 6, '\n'))); h.stdout('\n'); },
      { end: OVERFLOW, kill: true, model_cut: 'none' }],
    ['境界: with_model false で標準出力がちょうど上限で終わる: 止めず、答えのとおり 満たす', spec('contract'), {},
      (h) => { h.stdout(concat('unsat\n', bytes(MAX - 6, '\n'))); h.close(0); },
      { end: END({ tool_result: '満たす' }), kill: false, model_cut: 'none', stdoutLength: MAX, stdoutPrefix: true, exit_code: 0, timerCleared: true }],
    ['with_model true で答えの行を読み終える前に上限を超える: 止めて その他・unreadable_output', spec('property'), {},
      (h) => { h.stdout(bytes(MAX + 1, 'x')); },
      { end: OVERFLOW, kill: true, model_cut: 'none' }],
    ['with_model true で答えの行の後の chunk で上限を超える: 止めず truncated、close で決まる', spec('property'), {},
      (h) => { h.stdout('sat\n'); h.stdout(bytes(MAX, 'x')); h.close(0); },
      { end: END({ tool_result: '反する' }), kill: false, model_cut: 'truncated', stdoutLength: MAX, stdoutPrefix: true, exit_code: 0 }],
    ['with_model true で答えの行と同じ chunk の終わりが上限を超える: 止めず truncated', spec('property'), {},
      (h) => { h.stdout(concat('sat\n', bytes(MAX, 'x'))); h.close(0); },
      { end: END({ tool_result: '反する' }), kill: false, model_cut: 'truncated', stdoutLength: MAX, stdoutPrefix: true, exit_code: 0 }],
    ['境界: 答えの行の改行がちょうど上限のバイトにあり、同じ chunk で上限を超える: truncated', spec('property'), {},
      (h) => { h.stdout(concat(bytes(MAX - 4, '\n'), 'sat\n', bytes(10, 'x'))); h.close(0); },
      { end: END({ tool_result: '反する' }), kill: false, model_cut: 'truncated', stdoutLength: MAX, stdoutPrefix: true, exit_code: 0 }],
    ['境界: 答えの行の改行が上限の 1 バイト後にある: 答えを読み終える前に超えたので止めて その他', spec('property'), {},
      (h) => { h.stdout(concat(bytes(MAX - 3, '\n'), 'sat\n')); },
      { end: OVERFLOW, kill: true, model_cut: 'none' }],
    ['境界: 標準出力がちょうど上限で終わる: 切り詰めず model_cut none', spec('property'), {},
      (h) => { h.stdout(concat('sat\n', bytes(MAX - 4, 'x'))); h.close(0); },
      { end: END({ tool_result: '反する' }), kill: false, model_cut: 'none', stdoutLength: MAX, stdoutPrefix: true, exit_code: 0 }],
    ['truncated の後に期限（答えの後の停止）が来ても truncated のまま', spec('property'), {},
      (h) => { h.stdout('sat\n'); h.stdout(bytes(MAX, 'x')); h.deadline(); },
      { end: END({ tool_result: '反する' }), kill: true, model_cut: 'truncated' }],
    ['上限を超えて止めた後に期限が来ても終わり方は変わらない', spec('contract'), { closeOnKill: 'manual' },
      (h) => { h.stdout(bytes(MAX + 1, '\n')); h.deadline(); h.close(null); },
      { end: OVERFLOW, kill: true, model_cut: 'none' }],
  ];
}

// 呼ぶ前に期限が過ぎているか停止の要求が済んでいる（spawn を呼ばず started: false）
const BEFORE = [
  ['境界: clock.now() が deadline_ms と等しい', spec('contract'), { now: DEADLINE }],
  ['clock.now() が deadline_ms を過ぎている', spec('property'), { now: DEADLINE + 1 }],
  ['signal が既に abort されている（期限なし）', spec('contract', { deadline_ms: null }), { preAbort: true }],
];

test('scheduler の unit: 期待する end は全て起こりうる組で、classifyCheck の拒む組でない（期待値の自己検査）', () => {
  for (const [name, , , , exp] of rows(16)) assert.equal(invalidReason(exp.end), null, name);
  assert.equal(invalidReason(NOT_STARTED), null);
});

test('scheduler の unit: 出力の上限の行が使う TOOL_OUTPUT_MAX_BYTES は契約の値', async () => {
  const { TOOL_OUTPUT_MAX_BYTES } = await loadSchemas();
  assert.equal(TOOL_OUTPUT_MAX_BYTES, 1048576);
});

function assertOutcome(out, execution, exp, h) {
  assert.equal(out.execution_id, execution.execution_id);
  assert.deepEqual(out.end, exp.end, 'end の全ての欄');
  assert.equal(out.model_cut, exp.model_cut, 'model_cut');
  if (exp.kill) assert.ok(h.state.killCount > 0, 'killGroup を呼ぶ');
  else assert.equal(h.state.killCount, 0, 'killGroup を呼ばない');
  assert.ok(out.stdout instanceof Uint8Array && out.stderr instanceof Uint8Array);
  if ('stdout' in exp) assert.equal(new TextDecoder().decode(out.stdout), exp.stdout, '受けた標準出力');
  if ('stdoutLength' in exp) assert.equal(out.stdout.length, exp.stdoutLength, '標準出力は上限までに切り詰める');
  if ('stderr' in exp) assert.equal(new TextDecoder().decode(out.stderr), exp.stderr, '受けた標準エラー');
  if (exp.stdoutPrefix) {
    const sent = concat(...h.state.sent);
    assert.ok(Buffer.from(out.stdout).equals(Buffer.from(sent.subarray(0, exp.stdoutLength))), 'stdout は送ったバイト列の先頭 TOOL_OUTPUT_MAX_BYTES バイト');
  }
  if (exp.noTimer) assert.deepEqual(h.state.setTimerAt, [], '期限が無ければ timer を置かない');
  assert.deepEqual(h.state.spawnedWith, execution, 'spawn に execution を渡す');
  if ('exit_code' in exp) assert.equal(out.exit_code, exp.exit_code, 'close の終了コード');
  if (exp.timerCleared) {
    assert.ok(h.state.setTimerAt.includes(execution.deadline_ms), 'deadline_ms に timer を置く');
    assert.ok(h.timers.filter((x) => x.at === execution.deadline_ms).every((x) => x.cleared), 'close が先なら timer を外す');
  }
  assert.equal(h.state.spawnCount, 1, 'spawn は 1 回');
}

// 行の数は TOOL_OUTPUT_MAX_BYTES に依らないので、名前は小さい値で列挙し、値は schemas.mjs から読む
for (const [i, [name]] of rows(16).entries()) {
  test(`scheduler の unit SP-FORMALMETHOD-011 AC-09: ${name}`, { timeout: 5000 }, async () => {
    const { TOOL_OUTPUT_MAX_BYTES } = await loadSchemas();
    const [, execution, ioOpts, steps, exp] = rows(TOOL_OUTPUT_MAX_BYTES)[i];
    const { runExecution } = await loadScheduler();
    const { classifyCheck } = await loadVerdict();
    const h = makeIo(ioOpts);
    const pending = runExecution(execution, h.io);
    await h.spawned;
    await flush();
    await steps(h);
    const out = await pending;
    await flush();
    assertOutcome(out, execution, exp, h);
    assert.ok(out.stdout.length <= TOOL_OUTPUT_MAX_BYTES, 'stdout は上限まで');
    assert.doesNotThrow(() => classifyCheck(structuredClone(out.end)), 'classifyCheck が例外を投げない');
  });
}

for (const [name, execution, ioOpts] of BEFORE) {
  test(`scheduler の unit SP-FORMALMETHOD-011 AC-09: 始める前 ${name}: spawn を呼ばず started false の end を返す`, { timeout: 5000 }, async () => {
    const { runExecution } = await loadScheduler();
    const { classifyCheck } = await loadVerdict();
    const h = makeIo(ioOpts);
    const out = await runExecution(execution, h.io);
    assert.equal(h.state.spawnCount, 0, 'spawn を呼ばない');
    assert.deepEqual(h.state.setTimerAt, [], '始めないなら timer を置かない');
    assert.equal(h.state.killCount, 0);
    assert.equal(out.execution_id, execution.execution_id);
    assert.deepEqual(out.end, NOT_STARTED, 'end の全ての欄');
    assert.equal(out.model_cut, 'none');
    assert.doesNotThrow(() => classifyCheck(structuredClone(out.end)), 'classifyCheck が例外を投げない');
  });
}

test('scheduler の unit 境界: clock.now() が deadline_ms の 1 前なら spawn を呼び、deadline_ms に timer を置く', { timeout: 5000 }, async () => {
  const { runExecution } = await loadScheduler();
  const h = makeIo({ now: DEADLINE - 1 });
  const execution = spec('contract');
  const pending = runExecution(execution, h.io);
  await h.spawned;
  await flush();
  assert.ok(h.state.setTimerAt.includes(DEADLINE), 'deadline_ms に timer を置く');
  h.stdout('unsat\n');
  h.close(0);
  const out = await pending;
  assert.equal(h.state.spawnCount, 1);
  assert.deepEqual(out.end, END({ tool_result: '満たす' }));
});

test('scheduler の unit: 止めた場合も close が来るまで戻らない', { timeout: 5000 }, async () => {
  const { runExecution } = await loadScheduler();
  const h = makeIo({ closeOnKill: 'manual' });
  let settled = false;
  const pending = runExecution(spec('contract'), h.io).then((o) => { settled = true; return o; });
  await h.spawned;
  await flush();
  h.deadline();
  for (let i = 0; i < 5; i += 1) await flush();
  assert.ok(h.state.killCount > 0, 'killGroup を呼ぶ');
  assert.equal(settled, false, 'close の前に戻らない');
  h.close(null);
  const out = await pending;
  assert.deepEqual(out.end, STOP_TIME);
});
