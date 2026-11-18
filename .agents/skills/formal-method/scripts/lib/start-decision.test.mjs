// unit: scripts/lib/start.mjs の decideStartOutcome(observation)（cli-contract「unit の入口（内部）」1）。
// 期待値は、cli-contract「起動の手順」の 5 と「salvage の手順」の規則から、このファイルの expectedDecision が独立に導く。
// 結合テストで時機を合わせられない start の E_BUSY（verification-plan「結合テストで起こせない場面」）をここで覆う。
import test from 'node:test';
import assert from 'node:assert/strict';

const loadStart = () => import('./start.mjs');

const WAIT = 210000;
const base = {
  spawn_failed: false, daemon_exited: false, waited_ms: 0, start_wait_ms: WAIT, run_dir_exists: false, lock_holder: null,
  result_json: 'absent', status_json: 'absent', salvage_mark: 'absent', mark_winner: null,
};
const obs = (over) => ({ ...base, ...over });

// 契約の文から導いた判断。
function expectedDecision(o) {
  // 5-1: 起動に失敗したか、起動した process の終了を観測した
  if (o.spawn_failed || o.daemon_exited) {
    if (!o.run_dir_exists) return { kind: 'return_launch_failure' };
    // salvage の規則 1: 保持者が生きているか生死を判定できなければ E_BUSY（run-daemon）
    if (o.lock_holder === 'alive' || o.lock_holder === 'unknown') return { kind: 'e_busy', detail: { holder_role: 'run-daemon', liveness: o.lock_holder } };
    // 規則 2: result.json が結果の形に合えば返す。あるのに読めないか形に合わなければ E_RESULT_UNREADABLE（別の結果を作らない）
    if (o.result_json === 'valid') return { kind: 'salvage', step: 'return_result_json' };
    if (o.result_json === 'invalid') return { kind: 'result_unreadable' };
    // 規則 3: status.json が terminal ならその result（読めない status.json は当たらない）
    if (o.status_json === 'terminal') return { kind: 'salvage', step: 'return_status_result' };
    // 規則 4: 印。I/O で書けなければ公開しない R'。既にあれば勝者の生死
    if (o.salvage_mark === 'unwritable') return { kind: 'salvage', step: 'return_unpublished' };
    if (o.salvage_mark === 'present' && (o.mark_winner === 'alive' || o.mark_winner === 'unknown')) return { kind: 'e_busy', detail: { holder_role: 'salvage', liveness: o.mark_winner } };
    // 規則 5
    return { kind: 'salvage', step: 'build_and_publish' };
  }
  // 5-2: run の領域と status.json（読める Status）が現れた
  if (o.run_dir_exists && ['run_agents', 'working', 'terminal'].includes(o.status_json)) return { kind: 'return_status' };
  // 5-3: START_WAIT_MS に達した。run.lock があれば seq: 0 の working、無ければ子を止めて評価し直す
  if (o.waited_ms >= o.start_wait_ms) return o.run_dir_exists && o.lock_holder !== null ? { kind: 'return_working' } : { kind: 'stop_child_and_reevaluate' };
  return { kind: 'keep_waiting' };
}

// 起動の 6 つの場合（verification-plan「起動の手順」）と、E_BUSY・salvage の各規則。
const CASES = [
  ['起動そのものの失敗（run の領域が無い）→ 起動の失敗の停止', obs({ spawn_failed: true }), { kind: 'return_launch_failure' }],
  ['一時の領域の作成の後、rename の前に crash（run の領域が無い）→ 起動の失敗の停止', obs({ daemon_exited: true }), { kind: 'return_launch_failure' }],
  ['rename の後、最初の status.json の前に crash → salvage と同じ規則で結果を作る', obs({ daemon_exited: true, run_dir_exists: true, lock_holder: 'dead' }), { kind: 'salvage', step: 'build_and_publish' }],
  ['status.json が現れた → その Status を返す', obs({ run_dir_exists: true, lock_holder: 'alive', status_json: 'working' }), { kind: 'return_status' }],
  ['START_WAIT_MS に達し run.lock がある（遅い run-daemon）→ seq: 0 の working', obs({ waited_ms: WAIT, run_dir_exists: true, lock_holder: 'alive' }), { kind: 'return_working' }],
  ['START_WAIT_MS に達し rename していない → 子を止めて評価し直す', obs({ waited_ms: WAIT }), { kind: 'stop_child_and_reevaluate' }],
  ['待つ間（期限の直前）→ 待ち続ける', obs({ waited_ms: WAIT - 1, run_dir_exists: true, lock_holder: 'alive' }), { kind: 'keep_waiting' }],
  ['壊れた status.json は現れたことにならない', obs({ run_dir_exists: true, lock_holder: 'alive', status_json: 'invalid' }), { kind: 'keep_waiting' }],
  ['E_BUSY: crash の後に salvage.mark の勝者が生きている', obs({ daemon_exited: true, run_dir_exists: true, lock_holder: 'dead', salvage_mark: 'present', mark_winner: 'alive' }), { kind: 'e_busy', detail: { holder_role: 'salvage', liveness: 'alive' } }],
  ['E_BUSY: 勝者の生死を判定できない', obs({ daemon_exited: true, run_dir_exists: true, lock_holder: 'dead', salvage_mark: 'present', mark_winner: 'unknown' }), { kind: 'e_busy', detail: { holder_role: 'salvage', liveness: 'unknown' } }],
  ['E_BUSY: run.lock の保持者の生死を判定できない', obs({ daemon_exited: true, run_dir_exists: true, lock_holder: 'unknown' }), { kind: 'e_busy', detail: { holder_role: 'run-daemon', liveness: 'unknown' } }],
  ['salvage の規則 2: 結果の形に合う result.json', obs({ daemon_exited: true, run_dir_exists: true, lock_holder: 'dead', result_json: 'valid', status_json: 'terminal' }), { kind: 'salvage', step: 'return_result_json' }],
  ['salvage の規則 2: 形の壊れた result.json は、status.json が terminal でも result_unreadable', obs({ daemon_exited: true, run_dir_exists: true, lock_holder: 'dead', result_json: 'invalid', status_json: 'terminal' }), { kind: 'result_unreadable' }],
  ['salvage の規則 1 は 2 より先: 保持者が生きていれば、壊れた result.json があっても E_BUSY', obs({ daemon_exited: true, run_dir_exists: true, lock_holder: 'alive', result_json: 'invalid' }), { kind: 'e_busy', detail: { holder_role: 'run-daemon', liveness: 'alive' } }],
  ['salvage の規則 3: result.json が無く status.json が terminal ならその result', obs({ daemon_exited: true, run_dir_exists: true, lock_holder: 'dead', status_json: 'terminal' }), { kind: 'salvage', step: 'return_status_result' }],
  ['salvage の規則 3→4: 読めない status.json は当たらず印へ（勝者は死んでいる）', obs({ daemon_exited: true, run_dir_exists: true, lock_holder: 'dead', status_json: 'invalid', salvage_mark: 'present', mark_winner: 'dead' }), { kind: 'salvage', step: 'build_and_publish' }],
  ['salvage の規則 4: 印を I/O で書けない → 公開しない R\'', obs({ daemon_exited: true, run_dir_exists: true, lock_holder: 'dead', salvage_mark: 'unwritable' }), { kind: 'salvage', step: 'return_unpublished' }],
  ['5-1 は 5-2 より先: 終了を観測すれば status.json があっても salvage の規則', obs({ daemon_exited: true, run_dir_exists: true, lock_holder: 'dead', status_json: 'working' }), { kind: 'salvage', step: 'build_and_publish' }],
];

test('起動の判断の期待値の自己検査: 表の期待値は契約からの導出と一致する', () => {
  for (const [name, o, d] of CASES) assert.deepEqual(expectedDecision(o), d, name);
});

for (const [name, o, d] of CASES) {
  test(`cli-contract unit の入口 decideStartOutcome: ${name}`, async () => {
    const { decideStartOutcome } = await loadStart();
    const input = structuredClone(o);
    assert.deepEqual(decideStartOutcome(input), d);
    assert.deepEqual(input, o, '観測を変えない');
  });
}

// 起こりうる観測の全ての組（run の領域が無ければ lock・result・status・印は無い、勝者は印があるときだけ）で、契約の導出と一致する。
function allObservations() {
  const out = [];
  const B = [false, true];
  for (const spawn_failed of B) for (const daemon_exited of B) for (const waited of [0, WAIT - 1, WAIT]) for (const run_dir_exists of B) {
    const holders = run_dir_exists ? ['alive', 'dead', 'unknown'] : [null];
    const results = run_dir_exists ? ['absent', 'valid', 'invalid'] : ['absent'];
    const statuses = run_dir_exists ? ['absent', 'invalid', 'run_agents', 'working', 'terminal'] : ['absent'];
    const marks = run_dir_exists ? ['absent', 'present', 'unwritable'] : ['absent'];
    for (const lock_holder of holders) for (const result_json of results) for (const status_json of statuses) for (const salvage_mark of marks) {
      for (const mark_winner of salvage_mark === 'present' ? ['alive', 'dead', 'unknown'] : [null]) {
        out.push({ spawn_failed, daemon_exited, waited_ms: waited, start_wait_ms: WAIT, run_dir_exists, lock_holder, result_json, status_json, salvage_mark, mark_winner });
      }
    }
  }
  return out;
}

test('cli-contract unit の入口 decideStartOutcome: 起こりうる観測の全ての組で、契約からの導出と同じ判断を返す', async () => {
  const { decideStartOutcome } = await loadStart();
  const all = allObservations();
  assert.ok(all.length > 1000);
  const diffs = [];
  for (const o of all) {
    const got = decideStartOutcome(structuredClone(o));
    const exp = expectedDecision(o);
    try { assert.deepEqual(got, exp); } catch { diffs.push(`${JSON.stringify(o)} → ${JSON.stringify(got)}（期待 ${JSON.stringify(exp)}）`); }
  }
  assert.deepEqual(diffs.slice(0, 20), [], `違い ${diffs.length} 件`);
});
