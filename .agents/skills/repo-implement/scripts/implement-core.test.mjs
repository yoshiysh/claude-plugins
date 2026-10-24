import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CODES, ImplementError, MAKE_TARGETS, OUTPUT_TAIL_LINES, REQUIRED_CHECKS, argvOf, baselineVerdict, checkProblem, fnvSum, implementationProblem,
  inventoryProblems, newLedger, parsePorcelain, planProblem, recordRound, reviewProblem, reviewRecord, snapshotOf, tail, verifyProblems,
} from './implement-core.mjs'

const HEAD = 'a'.repeat(40)
const POLICY = 'b'.repeat(40)
const STATE = { repo: '/r', head: HEAD, policyRef: POLICY, preserved: [{ path: 'keep.md', digest: 'file:1' }], ledgerPath: '/s/l.json' }
const PLAN = { status: 'approved', state_sum: 's1', affected_paths: ['src/a.mjs', 'src/a.test.mjs'], checks: [{ kind: 'make', value: 'test' }] }

test('許可リストの正本: 必須 check は make test で、make の target は許可リストに入っている', () => {
  assert.deepEqual(REQUIRED_CHECKS.map((c) => [c.kind, c.value]), [['make', 'test']])
  for (const c of REQUIRED_CHECKS) assert.ok(MAKE_TARGETS.includes(c.value))
})

test('checkProblem は許可リストと affected_paths に照らして check を受け入れるか拒否する', async (t) => {
  const affected = ['src/a.test.mjs', '-x.test.mjs', 'src/a.mjs']
  const cases = [
    { name: '正常: make の許可された target', check: { kind: 'make', value: 'test' }, ok: true },
    { name: '正常: affected_paths にある .test.mjs', check: { kind: 'node-test', value: 'src/a.test.mjs' }, ok: true },
    { name: '異常: 許可リストに無い make target', check: { kind: 'make', value: 'runtime-deps' }, ok: false, match: /許可リスト/ },
    { name: '異常: 知らない kind', check: { kind: 'npm', value: 'test' }, ok: false, match: /kind/ },
    { name: '異常: 余分なキー', check: { kind: 'make', value: 'test', args: ['-j'] }, ok: false, match: /キー/ },
    { name: '異常: オブジェクトでない', check: 'make test', ok: false, match: /オブジェクト/ },
    { name: '異常: affected_paths に無いテスト', check: { kind: 'node-test', value: 'tests/other.test.mjs' }, ok: false, match: /affected_paths/ },
    { name: '異常: .test.mjs でない path', check: { kind: 'node-test', value: 'src/a.mjs' }, ok: false, match: /\.test\.mjs/ },
    { name: '境界: - で始まる path は node の flag になるので拒否する', check: { kind: 'node-test', value: '-x.test.mjs' }, ok: false, match: /正規形/ },
    { name: '境界: .. を含む path', check: { kind: 'node-test', value: 'src/../a.test.mjs' }, ok: false, match: /正規形/ },
  ]
  for (const c of cases) {
    await t.test(c.name, () => {
      const problem = checkProblem(c.check, affected)
      if (c.ok) assert.equal(problem, null)
      else assert.match(problem, c.match)
    })
  }
})

test('argvOf は固定の実行ファイルと値だけで argv を組む', () => {
  assert.deepEqual(argvOf({ kind: 'make', value: 'check' }), ['make', 'check'])
  assert.deepEqual(argvOf({ kind: 'node-test', value: 'a b.test.mjs' }), ['node', '--test', 'a b.test.mjs'], '空白は 1 つの引数のまま')
})

test('parsePorcelain は -z の項目を XY と path に分け、空白を含む path を保つ', () => {
  assert.deepEqual(parsePorcelain(' M a.md\0?? dir/b c.md\0D  gone.md\0'), [
    { xy: ' M', path: 'a.md' }, { xy: '??', path: 'dir/b c.md' }, { xy: 'D ', path: 'gone.md' },
  ])
  assert.deepEqual(parsePorcelain(''), [], '境界: 変更が無い')
})

test('snapshotOf は項目の順に依らず、HEAD・状態・内容のどれが変わっても変わる', () => {
  const e = [{ path: 'b', xy: ' M', digest: 'file:1' }, { path: 'a', xy: '??', digest: 'file:2' }]
  const base = snapshotOf(HEAD, e)
  assert.equal(snapshotOf(HEAD, [...e].reverse()), base)
  assert.notEqual(snapshotOf(POLICY, e), base)
  assert.notEqual(snapshotOf(HEAD, [{ ...e[0], digest: 'file:9' }, e[1]]), base)
  assert.notEqual(snapshotOf(HEAD, [{ ...e[0], xy: 'M ' }, e[1]]), base)
})

test('tail は末尾の行だけを残す', async (t) => {
  const lines = (n) => Array.from({ length: n }, (_, i) => `l${i + 1}`).join('\n')
  for (const [name, n, expectedFirst] of [
    ['境界: 上限より少ない', OUTPUT_TAIL_LINES - 1, 'l1'],
    ['境界: ちょうど上限', OUTPUT_TAIL_LINES, 'l1'],
    ['境界: 上限 + 1', OUTPUT_TAIL_LINES + 1, 'l2'],
  ]) {
    await t.test(name, () => {
      const out = tail(`${lines(n)}\n`).split('\n')
      assert.equal(out.length, Math.min(n, OUTPUT_TAIL_LINES))
      assert.equal(out[0], expectedFirst)
    })
  }
  assert.equal(tail(undefined), '', '境界: 出力が無い')
})

test('recordRound は round を 0 から 1 ずつだけ進め、戻すことも飛ばすことも拒否する', async (t) => {
  const impl = (round) => ({ repairRound: round, status: 'ready_for_check', touched_paths: ['src/a.mjs'] })
  const one = recordRound(newLedger('s'), impl(0))
  assert.deepEqual(one.rounds, [{ round: 0, status: 'ready_for_check', touched: ['src/a.mjs'] }])
  for (const [name, ledger, round] of [
    ['異常: 同じ round を繰り返す（リセット）', one, 0],
    ['異常: round を飛ばす', one, 2],
    ['異常: 最初の実装が 0 でない', newLedger('s'), 1],
  ]) {
    await t.test(name, () => {
      assert.throws(() => recordRound(ledger, impl(round)), (e) => e instanceof ImplementError && e.code === CODES.state)
    })
  }
})

test('implementationProblem は sum で写し間違いを検出する', () => {
  const body = { status: 'ready_for_check', repairRound: 0, touched_paths: ['a'] }
  assert.equal(implementationProblem({ ...body, sum: fnvSum(body) }), null)
  assert.match(implementationProblem({ ...body, touched_paths: ['b'], sum: fnvSum(body) }), /sum/)
  assert.match(implementationProblem({ ...body, repairRound: -1, sum: fnvSum({ ...body, repairRound: -1 }) }), /repairRound/)
})

test('planProblem は sum・state・status の食い違いを拒否する', async (t) => {
  const sum = fnvSum(PLAN)
  assert.equal(planProblem(PLAN, sum, STATE, 's1'), null)
  for (const [name, plan, planSum, stateSum, match] of [
    ['異常: plan を書き換えた', { ...PLAN, affected_paths: ['x'] }, sum, 's1', /planSum/],
    ['異常: 別の state の plan', PLAN, sum, 's2', /別の state/],
    ['異常: 承認されていない', { ...PLAN, status: 'blocked' }, fnvSum({ ...PLAN, status: 'blocked' }), 's1', /status/],
  ]) await t.test(name, () => assert.match(planProblem(plan, planSum, STATE, stateSum), match))
})

const clean = { state: STATE, plan: PLAN, head: HEAD, actual: ['src/a.mjs'], preservedNow: { 'keep.md': 'file:1' }, touched: ['src/a.mjs'] }

test('inventoryProblems は plan の外・申告漏れ・preserved の変化・HEAD の移動を原因ごとに返す', async (t) => {
  const cases = [
    { name: '正常: 計画どおり', patch: {}, causes: [] },
    { name: '異常: plan の外の変更', patch: { actual: ['src/a.mjs', 'README.md'], touched: ['src/a.mjs', 'README.md'] }, causes: ['outside_plan'] },
    { name: '異常: 申告漏れ', patch: { actual: ['src/a.mjs', 'src/a.test.mjs'] }, causes: ['undeclared'] },
    { name: '異常: preserved の内容が変わった', patch: { preservedNow: { 'keep.md': 'file:2' } }, causes: ['preserved_changed'] },
    { name: '異常: preserved が消えた', patch: { preservedNow: { 'keep.md': 'absent' } }, causes: ['preserved_changed'] },
    { name: '異常: HEAD が動いた', patch: { head: POLICY }, causes: ['head_changed'] },
    { name: '境界: 実装の前（touched が null）は申告漏れを見ない', patch: { actual: [], touched: null }, causes: [] },
  ]
  for (const c of cases) {
    await t.test(c.name, () => assert.deepEqual(inventoryProblems({ ...clean, ...c.patch }).map((p) => p.cause), c.causes))
  }
})

test('baselineVerdict は開始時の結果から、変更が起こした失敗かを決める', async (t) => {
  const check = { kind: 'make', value: 'test' }
  const run = (r) => ({ results: [{ check, ...r }] })
  for (const [name, baseline, expected] of [
    ['正常: 開始時に成功していた', run({ exit_code: 0 }), false],
    ['異常: 開始時から失敗していた', run({ exit_code: 2 }), true],
    ['境界: 開始時に実行していない（まだ無いテスト）', run({ not_run: 'x' }), null],
    ['境界: 開始時の記録に無い check', { results: [] }, null],
    ['境界: 開始時の記録そのものが無い', null, null],
  ]) await t.test(name, () => assert.equal(baselineVerdict(baseline, check), expected))
})

test('reviewProblem は repo-review の working_tree の返り値で、開始時の HEAD と policyRef のものだけを受け入れる', async (t) => {
  const review = { status: 'completed', mode: 'working_tree', headSha: HEAD, baseRef: HEAD, policyRef: POLICY, findings: [], unverified: [], reasons: [] }
  assert.equal(reviewProblem(review, STATE), null)
  for (const [name, patch, match] of [
    ['異常: diff モード', { mode: 'diff' }, /mode/],
    ['異常: 別の HEAD', { headSha: POLICY }, /headSha/],
    ['異常: 別の policyRef', { policyRef: HEAD }, /policyRef/],
    ['異常: 知らない status', { status: 'done' }, /status/],
    ['異常: findings が無い', { findings: undefined }, /findings/],
  ]) await t.test(name, () => assert.match(reviewProblem({ ...review, ...patch }, STATE), match))
  assert.equal(reviewRecord({ ...review, unverified: [{}] }, 0, 'x').passed, false, '未検証が残る review は通っていない')
  assert.equal(reviewRecord({ ...review, status: 'review_incomplete' }, 0, 'x').passed, false)
})

function ledgerWith({ checkPatch = {}, reviewPatch = {}, results } = {}) {
  return {
    ...newLedger('s1'),
    plan_sum: 'p',
    rounds: [{ round: 0, status: 'ready_for_check', touched: ['src/a.mjs'] }],
    checks: [{ phase: 'after', round: 0, snapshot_before: 'S', snapshot_after: 'S', tree_changed: false, results: results ?? [{ check: { kind: 'make', value: 'test' }, exit_code: 0 }], ...checkPatch }],
    reviews: [{ round: 0, snapshot: 'S', status: 'completed', reasons: [], findings: 0, unverified: 0, passed: true, ...reviewPatch }],
  }
}

test('verifyProblems は最後の check と review が今の作業ツリーで通ったときだけ空になる', async (t) => {
  const base = { state: STATE, plan: PLAN, head: HEAD, actual: ['src/a.mjs'], preservedNow: { 'keep.md': 'file:1' }, snapshot: 'S' }
  const cases = [
    { name: '正常: 全て通った', ledger: ledgerWith(), patch: {}, causes: [] },
    { name: '異常: check が失敗した', ledger: ledgerWith({ results: [{ check: { kind: 'make', value: 'test' }, exit_code: 2 }] }), patch: {}, causes: ['checks_failed'] },
    { name: '異常: plan の check を実行していない', ledger: ledgerWith({ results: [] }), patch: {}, causes: ['checks_failed'] },
    { name: '異常: review の後に変わった', ledger: ledgerWith(), patch: { snapshot: 'T' }, causes: ['changed_since_checks', 'changed_since_review'] },
    { name: '異常: review が通っていない', ledger: ledgerWith({ reviewPatch: { passed: false, findings: 1 } }), patch: {}, causes: ['review_not_passed'] },
    { name: '異常: check の実行中に作業ツリーが変わった', ledger: ledgerWith({ checkPatch: { tree_changed: true } }), patch: {}, causes: ['checks_changed_tree'] },
    { name: '異常: review が check の後の作業ツリーでない', ledger: ledgerWith({ checkPatch: { snapshot_after: 'U' } }), patch: {}, causes: ['changed_since_checks', 'review_not_on_checked_tree'] },
    { name: '異常: 最後の round の後に check も review も無い', ledger: { ...ledgerWith(), rounds: [...ledgerWith().rounds, { round: 1, status: 'ready_for_check', touched: ['src/a.mjs'] }] }, patch: {}, causes: ['checks_missing', 'review_missing'] },
    { name: '境界: 変更が無ければ check と review を求めない', ledger: { ...newLedger('s1'), plan_sum: 'p' }, patch: { actual: [] }, causes: [] },
  ]
  for (const c of cases) {
    await t.test(c.name, () => assert.deepEqual(verifyProblems({ ...base, ...c.patch, ledger: c.ledger }).map((p) => p.cause), c.causes))
  }
})
