import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CODES, ImplementError, MAKE_TARGETS, OUTPUT_TAIL_LINES, REQUIRED_CHECKS, argvOf, baselineVerdict, checkProblem, fnvSum, implementationProblem,
  inventoryProblems, newLedger, parsePorcelain, planCheckProblems, planProblem, reviewProblems, reviewRecord, roundEffectProblems, roundTicket,
  snapshotOf, tail, unreviewablePaths, verifyProblems,
} from './implement-core.mjs'

const HEAD = 'a'.repeat(40)
const POLICY = 'b'.repeat(40)
const STATE = { repo: '/r', head: HEAD, policyRef: POLICY, preserved: [{ path: 'keep.md', digest: 'file:1' }], ledgerPath: '/s/l.json', snapshot: 'S0' }
const PLAN = { status: 'approved', state_sum: 's1', affected_paths: ['src/a.mjs', 'src/a.test.mjs'], checks: [{ kind: 'make', value: 'test' }] }

test('許可リストの正本: 必須 check は make test で、make の target は許可リストに入っている', () => {
  assert.deepEqual(REQUIRED_CHECKS.map((c) => [c.kind, c.value]), [['make', 'test']])
  for (const c of REQUIRED_CHECKS) assert.ok(MAKE_TARGETS.includes(c.value))
})

test('checkProblem は許可リストと affected_paths に照らして check を受け入れるか拒否する', async (t) => {
  const affected = ['src/a.test.mjs', '-x.test.mjs', 'src/a.mjs', ...['*', '?', '[', ']', '{', '}'].map((ch) => `src/a${ch}.test.mjs`)]
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
    ...['*', '?', '[', ']', '{', '}'].map((ch) => ({ name: `境界: glob の文字 ${ch} を含む path は node --test が glob として読むので拒否する`, check: { kind: 'node-test', value: `src/a${ch}.test.mjs` }, ok: false, match: /正規形/ })),
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
  assert.deepEqual(parsePorcelain('?? sub/\0'), [{ xy: '??', path: 'sub/' }], '境界: 未追跡の入れ子の repo は末尾の / のまま返す')
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


const R = (round, extra = {}) => ({ round, status: 'ready_for_check', touched: ['src/a.mjs'], snapshot_before: 'A', snapshot_after: 'B', passed: true, ...extra })

test('unreviewablePaths は repo-review の変更の集合に無い path・正規形でない path を返す', async (t) => {
  for (const [name, status, changes, expected] of [
    ['正常: status と変更の集合が一致', ['a.md', 'b/c.md'], ['a.md', 'b/c.md'], []],
    ['異常: 未追跡の入れ子の repo（末尾の /）', ['nested/'], ['nested/'], ['nested/']],
    ['異常: index だけが HEAD と違う path', ['keep.md'], [], ['keep.md']],
    ['境界: 変更が無い', [], [], []],
  ]) await t.test(name, () => assert.deepEqual(unreviewablePaths(status, changes), expected))
})
const after = (round, results) => ({ phase: 'after', round, head: HEAD, snapshot_before: 'B', snapshot_after: 'B', tree_changed: false, results })
const finding = (patch = {}) => ({
  path: 'src/a.mjs', line: 1, in_target: true,
  claim: { severity: 'HIGH', summary: 's', condition: 'c', impact: 'i', evidence: 'e', rule: 'r' },
  votes: [{ vote: 'confirmed' }], ...patch,
})
const ledger0 = (patch = {}) => ({ ...newLedger('s1', 'S0'), plan_sum: 'p', baseline: { results: [] }, ...patch })

test('roundTicket は round を記録から決め、修正の入力を記録から取る', async (t) => {
  await t.test('正常: 最初の実装は修正の入力なしの round 0', () => {
    assert.deepEqual(roundTicket(ledger0(), PLAN, 'p', null).ticket, { round: 0, plan_sum: 'p', state_sum: 's1', snapshot: 'S0', repair: null, findings: [], checkFailures: [] })
  })
  await t.test('異常: 最後の round が通っていなければ次の回を開かない', () => {
    for (const last of [R(0, { status: 'incomplete' }), R(0, { passed: false })]) {
      assert.throws(() => roundTicket(ledger0({ rounds: [last], checks: [after(0, [{ repairable: true }])] }), PLAN, 'p', 'checks'), (e) => e.code === CODES.state)
    }
  })
  await t.test('準正常: check の修正は同じ round の全ての run の repairable な失敗の和を載せる', () => {
    const a = { check: { kind: 'make', value: 'test' }, exit_code: 2, repairable: true }
    const { ticket } = roundTicket(ledger0({ rounds: [R(0)], checks: [after(0, [a]), after(0, [{ ...a, exit_code: 0, repairable: false }])] }), PLAN, 'p', 'checks')
    assert.deepEqual(ticket.checkFailures, [a])
  })
  await t.test('正常: check の修正は直前の run の repairable な失敗だけを載せる', () => {
    const fail = { check: { kind: 'make', value: 'test' }, exit_code: 2, repairable: true }
    const old = { check: { kind: 'make', value: 'check' }, exit_code: 2, repairable: false }
    const { ticket } = roundTicket(ledger0({ rounds: [R(0)], checks: [after(0, [fail, old])] }), PLAN, 'p', 'checks')
    assert.deepEqual([ticket.round, ticket.checkFailures], [1, [fail]])
  })
  await t.test('正常: レビューの修正は直前のレビューの確定指摘を載せる', () => {
    const f = finding()
    const { ticket } = roundTicket(ledger0({ rounds: [R(0)], checks: [after(0, [])], reviews: [{ round: 0, findingsDetail: [f] }] }), PLAN, 'p', 'review')
    assert.deepEqual(ticket.findings, [f])
  })
  await t.test('準正常: 計画の外か対象の外を指す確定指摘は券を出さず needsReplan を返す', () => {
    for (const f of [finding({ path: 'README.md' }), finding({ in_target: false })]) {
      const out = roundTicket(ledger0({ rounds: [R(0)], checks: [after(0, [])], reviews: [{ round: 0, findingsDetail: [f] }] }), PLAN, 'p', 'review')
      assert.deepEqual(out, { needsReplan: [f] })
    }
  })
  const rejects = [
    ['異常: baseline の前', ledger0({ baseline: null }), null, CODES.state],
    ['異常: round 0 に修正の入力', ledger0(), 'checks', CODES.input],
    ['異常: 修正の回に入力が無い', ledger0({ rounds: [R(0)], checks: [after(0, [])] }), null, CODES.input],
    ['異常: 直前の round の run が無い', ledger0({ rounds: [R(0), R(1)], checks: [after(0, [])] }), 'checks', CODES.state],
    ['異常: 変更起因の失敗が無いのに check の修正', ledger0({ rounds: [R(0)], checks: [after(0, [{ repairable: false }])] }), 'checks', CODES.state],
    ['異常: 直前の round のレビューが無い', ledger0({ rounds: [R(0)], checks: [after(0, [])] }), 'review', CODES.state],
    ['異常: 確定指摘の無いレビューでレビューの修正', ledger0({ rounds: [R(0)], checks: [after(0, [])], reviews: [{ round: 0, findingsDetail: [] }] }), 'review', CODES.state],
  ]
  for (const [name, ledger, repair, code] of rejects) {
    await t.test(name, () => assert.throws(() => roundTicket(ledger, PLAN, 'p', repair), (e) => e instanceof ImplementError && e.code === code))
  }
})

test('implementationProblem は sum と開いている round の券で返り値を照らす', async (t) => {
  const body = { status: 'ready_for_check', repairRound: 0, ticket_sum: 'T', touched_paths: ['a'] }
  const open = { round: 0, ticket_sum: 'T' }
  assert.equal(implementationProblem({ ...body, sum: fnvSum(body) }, open), null)
  for (const [name, impl, o, match] of [
    ['異常: 書き換えた返り値', { ...body, touched_paths: ['b'], sum: fnvSum(body) }, open, /sum/],
    ['異常: 開いている round が無い', { ...body, sum: fnvSum(body) }, null, /開いている round/],
    ['異常: 別の券の返り値', { ...body, ticket_sum: 'U', sum: fnvSum({ ...body, ticket_sum: 'U' }) }, open, /券/],
    ['異常: 別の round の返り値', { ...body, repairRound: 1, sum: fnvSum({ ...body, repairRound: 1 }) }, open, /券/],
  ]) await t.test(name, () => assert.match(implementationProblem(impl, o), match))
})

test('roundEffectProblems は申告と作業ツリーの動きの食い違いを返す', async (t) => {
  for (const [name, status, before, afterSnap, causes] of [
    ['正常: 実装して変わった', 'ready_for_check', 'A', 'B', []],
    ['異常: 実装したと返したのに変わっていない', 'ready_for_check', 'A', 'A', ['no_effect']],
    ['異常: 失敗した実装が作業ツリーを変えた', 'blocked', 'A', 'B', ['changed_on_failure']],
    ['正常: 起動しなかった回は変えない', 'repair_limit_reached', 'A', 'A', []],
  ]) await t.test(name, () => assert.deepEqual(roundEffectProblems(status, before, afterSnap).map((p) => p.cause), causes))
})

test('planProblem は sum・state・status の食い違いを拒否する', async (t) => {
  const sum = fnvSum(PLAN)
  assert.equal(planProblem(PLAN, sum, STATE, 's1'), null)
  for (const [name, plan, planSum, stateSum, match] of [
    ['異常: plan を書き換えた', { ...PLAN, affected_paths: ['x'] }, sum, 's1', /planSum/],
    ['異常: 別の state の plan', PLAN, sum, 's2', /別の state/],
    ['異常: 承認されていない', { ...PLAN, status: 'blocked' }, fnvSum({ ...PLAN, status: 'blocked' }), 's1', /status/],
    ['境界: 承認済みなのに affected_paths が空', { ...PLAN, affected_paths: [] }, fnvSum({ ...PLAN, affected_paths: [] }), 's1', /affected_paths が無い/],
  ]) await t.test(name, () => assert.match(planProblem(plan, planSum, STATE, stateSum), match))
})

test('planCheckProblems は必須の check の欠けと許可リストの外を返す', async (t) => {
  for (const [name, plan, match] of [
    ['正常: 必須を含む', PLAN, null],
    ['異常: 必須の make test が無い', { ...PLAN, checks: [{ kind: 'make', value: 'check' }] }, /必須の check make:test/],
    ['異常: 許可リストの外', { ...PLAN, checks: [...PLAN.checks, { kind: 'make', value: 'install' }] }, /許可リスト/],
    ['異常: 変更不要の plan が check を持つ', { ...PLAN, status: 'no_change', affected_paths: [] }, /変更不要/],
    ['正常: 変更不要の plan は check を持たない', { ...PLAN, status: 'no_change', affected_paths: [], checks: [] }, null],
  ]) {
    await t.test(name, () => {
      const problems = planCheckProblems(plan)
      if (match === null) assert.deepEqual(problems, [])
      else assert.match(problems.join('\n'), match)
    })
  }
})

const clean = { state: STATE, plan: PLAN, head: HEAD, actual: ['src/a.mjs'], preservedNow: { 'keep.md': 'file:1' }, touched: ['src/a.mjs'] }

test('inventoryProblems は plan の外・申告漏れ・preserved の変化・HEAD の移動を原因ごとに返す', async (t) => {
  const cases = [
    { name: '正常: 計画どおり', patch: {}, causes: [] },
    { name: '異常: plan の外の変更', patch: { actual: ['src/a.mjs', 'README.md'], touched: ['src/a.mjs', 'README.md'] }, causes: ['outside_plan'] },
    { name: '異常: 申告漏れ', patch: { actual: ['src/a.mjs', 'src/a.test.mjs'] }, causes: ['undeclared'] },
    { name: '異常: preserved の内容・index の状態が変わった', patch: { preservedNow: { 'keep.md': 'file:2' } }, causes: ['preserved_changed'] },
    { name: '異常: preserved が消えた', patch: { preservedNow: { 'keep.md': 'absent' } }, causes: ['preserved_changed'] },
    { name: '異常: HEAD が動いた', patch: { head: POLICY }, causes: ['head_changed'] },
    { name: '異常: index が開始時から動いた', patch: { index: 'moved' }, causes: ['index_changed'] },
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
    ['境界: 開始時にまだ無かったテストは、変更が作ったので変更起因', run({ not_run: 'x' }), false],
    ['境界: 開始時の記録に無い check', { results: [] }, null],
    ['境界: 開始時の記録そのものが無い', null, null],
  ]) await t.test(name, () => assert.equal(baselineVerdict(baseline, check), expected))
})

const seal = (body) => ({ ...body, sum: fnvSum(body) })
const REVIEW_BODY = { status: 'completed', mode: 'working_tree', headSha: HEAD, baseRef: HEAD, policyRef: POLICY, scope: null, target: { files: ['src/a.mjs'] }, excluded: [], generated: [], preserved: ['keep.md'], coverage: [{ id: 'c' }, { id: 'd' }], pin: { ok: true }, findings: [], unverified: [], reasons: [] }
const REVIEW = seal(REVIEW_BODY)
const REVIEW_PLAN = { mode: 'working_tree', headSha: HEAD, baseRef: HEAD, policyRef: POLICY, target: { files: ['src/a.mjs'] }, excluded: [], generated: [], preserved: ['keep.md'], digests: { 'src/a.mjs': 'file:x' }, reviewers: [{ id: 'c' }, { id: 'd' }] }
const reseal = (patch) => seal({ ...REVIEW_BODY, ...patch })

test('reviewProblems は repo-review の返り値を、計画のファイル・開始時の状態・今の変更と内容に照らす', async (t) => {
  const base = { review: REVIEW, reviewPlan: REVIEW_PLAN, state: STATE, actual: ['src/a.mjs'], digests: { 'src/a.mjs': 'file:x' } }
  assert.deepEqual(reviewProblems(base), [])
  const cases = [
    ['異常: diff モード', { review: reseal({ mode: 'diff' }) }, /working_tree/],
    ['異常: 別の HEAD', { review: reseal({ headSha: POLICY }) }, /headSha/],
    ['異常: 別の policyRef', { review: reseal({ policyRef: HEAD }) }, /policyRef/],
    ['異常: scope で狭めた', { review: reseal({ scope: ['src'] }) }, /scope/],
    ['異常: implementer の変更を preserved に混ぜた', { review: reseal({ preserved: ['keep.md', 'src/a.mjs'], target: { files: [] } }), reviewPlan: { ...REVIEW_PLAN, preserved: ['keep.md', 'src/a.mjs'], target: { files: [] } } }, /preserved が開始時/],
    ['異常: 対象が今の変更の一部だけ', { actual: ['src/a.mjs', 'src/b.mjs'] }, /和が今の変更/],
    ['異常: 前の round の内容をレビューした結果', { digests: { 'src/a.mjs': 'file:y' } }, /今の内容と違う/],
    ['異常: 返り値の対象が計画のファイルと違う', { review: reseal({ target: { files: ['src/b.mjs'] } }) }, /計画のファイルの対象/],
    ['異常: 確定指摘の形でない findings', { review: reseal({ findings: [{ path: 'src/a.mjs' }] }) }, /確定した指摘の形/],
    ['異常: 知らない status', { review: reseal({ status: 'done' }) }, /status/],
    ['異常: sum が無い', { review: REVIEW_BODY }, /sum/],
    ['異常: findings を落とした（sum が合わない）', { review: { ...seal({ ...REVIEW_BODY, findings: [finding()] }), findings: [] } }, /sum/],
    ['異常: 計画の reviewers と coverage の観点が違う（手で組んだ返り値）', { review: reseal({ coverage: [{ id: 'c' }] }) }, /coverage/],
    ['異常: completed に pin が無い', { review: reseal({ pin: undefined }) }, /pin/],
    ['異常: target.files に repo の外の path', { review: reseal({ target: { files: ['../x'] } }) }, /repo 相対/],
    ['正常: 途中で止まった review_incomplete は coverage を持たなくてよい', { review: reseal({ status: 'review_incomplete', coverage: undefined, pin: undefined }) }, null],
    ['異常: findings が無い', { review: reseal({ findings: undefined }) }, /findings/],
  ]
  for (const [name, patch, match] of cases) {
    await t.test(name, () => {
      const problems = reviewProblems({ ...base, ...patch })
      if (match === null) assert.deepEqual(problems, [])
      else assert.match(problems.join('\n'), match)
    })
  }
  await t.test('準正常: 同じ round のやり直しは前が review_incomplete のときだけで、前の確定指摘を消さない', () => {
    const f = finding()
    const prev = reviewRecord(reseal({ status: 'review_incomplete', findings: [f] }), 0, 'x')
    const again = reviewRecord(REVIEW, 0, 'y', [prev])
    assert.deepEqual([again.findings, again.passed], [1, false])
    assert.throws(() => reviewRecord(REVIEW, 0, 'z', [again]), (e) => e.code === CODES.state, 'completed の後の 2 回目')
  })
  assert.equal(reviewRecord({ ...REVIEW, unverified: [{}] }, 0, 'x').passed, false, '未検証が残る review は通っていない')
  assert.equal(reviewRecord({ ...REVIEW, status: 'review_incomplete' }, 0, 'x').passed, false)
})

function ledgerWith({ checkPatch = {}, reviewPatch = {}, results, patch = {} } = {}) {
  return {
    ...newLedger('s1', 'S'),
    plan_sum: 'p',
    rounds: [R(0, { snapshot_after: 'S' })],
    checks: [{ phase: 'after', round: 0, snapshot_before: 'S', snapshot_after: 'S', tree_changed: false, results: results ?? [{ check: { kind: 'make', value: 'test' }, exit_code: 0 }], ...checkPatch }],
    reviews: [{ round: 0, snapshot: 'S', status: 'completed', reasons: [], findings: 0, unverified: 0, passed: true, ...reviewPatch }],
    ...patch,
  }
}

test('verifyProblems は最後の check と review が今の作業ツリーで通ったときだけ空になる', async (t) => {
  const base = { state: STATE, plan: PLAN, head: HEAD, actual: ['src/a.mjs'], preservedNow: { 'keep.md': 'file:1' }, snapshot: 'S' }
  const noChange = { ...PLAN, status: 'no_change', affected_paths: [], checks: [] }
  const cases = [
    { name: '正常: 全て通った', ledger: ledgerWith(), patch: {}, causes: [] },
    { name: '異常: check が失敗した', ledger: ledgerWith({ results: [{ check: { kind: 'make', value: 'test' }, exit_code: 2 }] }), patch: {}, causes: ['checks_failed'] },
    { name: '異常: plan の check を実行していない', ledger: ledgerWith({ results: [] }), patch: {}, causes: ['checks_failed'] },
    { name: '異常: review の後に記録の外で変わった', ledger: ledgerWith(), patch: { snapshot: 'T' }, causes: ['changed_outside_steps', 'changed_since_checks', 'changed_since_review'] },
    { name: '異常: review が通っていない', ledger: ledgerWith({ reviewPatch: { passed: false, findings: 1 } }), patch: {}, causes: ['review_not_passed'] },
    { name: '異常: check の実行中に作業ツリーが変わった', ledger: ledgerWith({ checkPatch: { tree_changed: true } }), patch: {}, causes: ['checks_changed_tree'] },
    { name: '異常: review が check の後の作業ツリーでない', ledger: ledgerWith({ checkPatch: { snapshot_after: 'U' } }), patch: {}, causes: ['changed_since_checks', 'review_not_on_checked_tree'] },
    { name: '異常: 最後の round の後に check も review も無い', ledger: ledgerWith({ patch: { rounds: [R(0), R(1, { snapshot_after: 'S' })] } }), patch: {}, causes: ['checks_missing', 'review_missing'] },
    { name: '異常: 開いたままの round', ledger: ledgerWith({ patch: { open: { round: 1, ticket_sum: 'x' } } }), patch: {}, causes: ['round_open'] },
    { name: '異常: 最後の round が incomplete（check とレビューを通しても）', ledger: ledgerWith({ patch: { rounds: [R(0, { snapshot_after: 'S', status: 'incomplete' })] } }), patch: {}, causes: ['last_round_not_passed'] },
    { name: '異常: 最後の round の inventory が通っていない', ledger: ledgerWith({ patch: { rounds: [R(0, { snapshot_after: 'S', passed: false })] } }), patch: {}, causes: ['last_round_not_passed'] },
    { name: '異常: 失敗した run の後に通るまで回し直した', ledger: ledgerWith({ patch: { checks: [{ phase: 'after', round: 0, snapshot_before: 'S', snapshot_after: 'S', tree_changed: false, results: [{ check: { kind: 'make', value: 'test' }, exit_code: 2 }] }, ...ledgerWith().checks] } }), patch: {}, causes: ['checks_failed'] },
    { name: '異常: abandon で終わった run', ledger: ledgerWith({ patch: { terminal: { reason: 'x', snapshot: 'S' } } }), patch: {}, causes: ['terminated'] },
    { name: '異常: 承認済みの plan なのに変更が無い', ledger: ledgerWith(), patch: { actual: [] }, causes: ['not_implemented'] },
    { name: '異常: 承認済みの plan なのに round が無い', ledger: { ...newLedger('s1', 'S'), plan_sum: 'p' }, patch: { actual: [] }, causes: ['not_implemented'] },
    { name: '正常: 変更不要の plan で round も変更も無い', ledger: { ...newLedger('s1', 'S'), plan_sum: 'p' }, patch: { plan: noChange, actual: [] }, causes: [] },
    { name: '異常: 変更不要の plan なのに変更がある', ledger: { ...newLedger('s1', 'S'), plan_sum: 'p' }, patch: { plan: { ...noChange, affected_paths: ['src/a.mjs'] } }, causes: ['changed_for_no_change_plan'] },
  ]
  for (const c of cases) {
    await t.test(c.name, () => assert.deepEqual(verifyProblems({ ...base, ...c.patch, ledger: c.ledger }).map((p) => p.cause), c.causes))
  }
})
