import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defaultIo, main } from './implement-cli.mjs'
import { CODES, fnvSum } from './implement-core.mjs'

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), 'implement-cli.mjs')
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com',
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
}
// fixture の make test は FAIL というファイルがあれば失敗する。開始時と変更後の成否を作業ツリーの内容だけで切り替える。
const MAKEFILE = 'test:\n\t@echo running\n\t@test ! -e FAIL\ncheck:\n\t@echo check\n'

function git(repo, ...args) {
  return execFileSync('git', ['-C', repo, ...args], { env: GIT_ENV }).toString('utf8').trim()
}

function write(repo, file, text) {
  mkdirSync(path.dirname(path.join(repo, file)), { recursive: true })
  writeFileSync(path.join(repo, file), text)
}

function tmp(t, prefix) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function fixture(t, { branch = 'work' } = {}) {
  const repo = tmp(t, 'repo-implement-cli-')
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'commit.gpgsign', 'false')
  write(repo, 'Makefile', MAKEFILE)
  write(repo, 'src/a.mjs', 'export const a = 1\n')
  write(repo, 'src/a.test.mjs', "import test from 'node:test'\ntest('a', () => {})\n")
  write(repo, 'keep.md', 'keep\n')
  write(repo, 'gone.md', 'gone\n')
  write(repo, 'real/x.md', 'x\n')
  symlinkSync('real', path.join(repo, 'link'))
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'base')
  if (branch !== 'main') git(repo, 'checkout', '-q', '-b', branch)
  return { repo, stateDir: tmp(t, 'repo-implement-state-'), head: git(repo, 'rev-parse', 'HEAD') }
}

function call(op, body) {
  return JSON.parse(main([op], JSON.stringify(body)).output)
}

function ok(op, body) {
  const out = call(op, body)
  assert.equal(out.ok, true, `${op}: ${out.code} ${out.reason}`)
  return out
}

function start(fx) {
  const out = ok('start', { repo: fx.repo, stateDir: fx.stateDir, policyRef: 'main' })
  return { state: out.state, statePath: out.state_path, stateSum: out.state_sum, out }
}

function planFor(s, patch = {}) {
  const plan = { status: 'approved', state_sum: s.stateSum, affected_paths: ['src/a.mjs', 'src/a.test.mjs', 'src/new.test.mjs'], checks: [{ kind: 'make', value: 'test' }], ...patch }
  return { plan, planSum: fnvSum(plan) }
}

function implementation(round, touched, status = 'ready_for_check') {
  const body = { status, repairRound: round, touched_paths: touched }
  return { ...body, sum: fnvSum(body) }
}

const ref = (s) => ({ statePath: s.statePath, stateSum: s.stateSum })
const review = (s, patch = {}) => ({ status: 'completed', mode: 'working_tree', headSha: s.state.head, baseRef: s.state.head, policyRef: s.state.policyRef, findings: [], unverified: [], reasons: [], ...patch })

test('start: 開始時の変更を preservedPaths として内容の digest つきで記録し、削除は HEAD の blob で記録する', (t) => {
  const fx = fixture(t)
  write(fx.repo, 'keep.md', 'edited\n')
  write(fx.repo, 'notes/untracked.md', 'u\n')
  unlinkSync(path.join(fx.repo, 'gone.md'))
  const s = start(fx)
  assert.deepEqual(s.out.preservedPaths, ['gone.md', 'keep.md', 'notes/untracked.md'])
  const digests = Object.fromEntries(s.state.preserved.map((p) => [p.path, p.digest]))
  assert.equal(digests['gone.md'], `deleted:${git(fx.repo, 'rev-parse', 'HEAD:gone.md')}`)
  assert.match(digests['keep.md'], /^file:[0-9a-f]{64}$/)
  assert.equal(s.state.head, fx.head)
  assert.equal(s.state.policyRef, git(fx.repo, 'rev-parse', 'main'))
  assert.equal(s.state.branch, 'work')
  assert.equal(fnvSum(JSON.parse(readFileSync(s.statePath, 'utf8'))), s.stateSum)
})

test('start: 始められない入力を理由つきで拒否し、state を書かない', async (t) => {
  const cases = [
    { name: '異常: main の上', setup: (t) => fixture(t, { branch: 'main' }), body: (fx) => ({ repo: fx.repo, stateDir: fx.stateDir, policyRef: 'main' }), code: CODES.pin },
    { name: '異常: stateDir が repo の中', body: (fx) => { mkdirSync(path.join(fx.repo, 'st')); return { repo: fx.repo, stateDir: path.join(fx.repo, 'st'), policyRef: 'main' } }, code: CODES.input },
    { name: '異常: policyRef が commit に解決しない', body: (fx) => ({ repo: fx.repo, stateDir: fx.stateDir, policyRef: 'no-such-ref' }), code: CODES.pin },
    { name: '異常: stateDir が無い', body: (fx) => ({ repo: fx.repo, stateDir: path.join(fx.stateDir, 'missing'), policyRef: 'main' }), code: CODES.input },
    { name: '異常: repo が root でない', body: (fx) => ({ repo: path.join(fx.repo, 'src'), stateDir: fx.stateDir, policyRef: 'main' }), code: CODES.input },
  ]
  for (const c of cases) {
    await t.test(c.name, (t) => {
      const fx = (c.setup ?? fixture)(t)
      const out = call('start', c.body(fx))
      assert.equal(out.ok, false)
      assert.equal(out.code, c.code, out.reason)
      assert.equal(spawnSync('ls', [fx.stateDir], { encoding: 'utf8' }).stdout, '')
    })
  }
  await t.test('準正常: 同じ stateDir での 2 回目の start は前の state を上書きしない', (t) => {
    const fx = fixture(t)
    start(fx)
    assert.equal(call('start', { repo: fx.repo, stateDir: fx.stateDir, policyRef: 'main' }).code, CODES.state)
  })
})

test('inventory（実装の前）: symlink を通る path と許可リストに無い check を受け入れない', async (t) => {
  const cases = [
    { name: '正常: 受け入れる', patch: {}, causes: [] },
    { name: '異常: symlink の下の path', patch: { affected_paths: ['link/x.md'] }, causes: ['symlink_path'] },
    { name: '異常: ディレクトリそのもの', patch: { affected_paths: ['src'] }, causes: ['symlink_path'] },
    { name: '異常: 許可リストに無い make target', patch: { checks: [{ kind: 'make', value: 'runtime-deps' }] }, causes: ['check_not_allowed'] },
  ]
  for (const c of cases) {
    await t.test(c.name, (t) => {
      const fx = fixture(t)
      const s = start(fx)
      const out = ok('inventory', { ...ref(s), ...planFor(s, c.patch) })
      assert.deepEqual(out.problems.map((p) => p.cause), c.causes)
      assert.equal(out.admitted, c.causes.length === 0)
    })
  }
})

test('inventory（実装の後）: 実際の変更を plan・touched_paths・preserved と照らし、round を戻させない', async (t) => {
  const cases = [
    { name: '正常: 申告どおり', edit: (r) => write(r, 'src/a.mjs', 'export const a = 2\n'), touched: ['src/a.mjs'], causes: [] },
    { name: '異常: 申告漏れ', edit: (r) => { write(r, 'src/a.mjs', '2\n'); write(r, 'src/a.test.mjs', '2\n') }, touched: ['src/a.mjs'], causes: ['undeclared'] },
    { name: '異常: plan の外', edit: (r) => write(r, 'README.md', 'x\n'), touched: [], causes: ['outside_plan', 'undeclared'] },
    { name: '異常: preserved を書き換えた', edit: (r) => write(r, 'keep.md', 'overwritten\n'), touched: [], causes: ['preserved_changed'] },
  ]
  for (const c of cases) {
    await t.test(c.name, (t) => {
      const fx = fixture(t)
      write(fx.repo, 'keep.md', 'mine\n')
      const s = start(fx)
      const p = planFor(s)
      ok('inventory', { ...ref(s), ...p })
      c.edit(fx.repo)
      const out = ok('inventory', { ...ref(s), ...p, implementation: implementation(0, c.touched) })
      assert.deepEqual(out.problems.map((x) => x.cause), c.causes)
    })
  }
  await t.test('異常: 受け入れていない plan・sum の合わない返り値・戻した round を拒否する', (t) => {
    const fx = fixture(t)
    const s = start(fx)
    const p = planFor(s)
    assert.equal(call('inventory', { ...ref(s), ...p, implementation: implementation(0, []) }).code, CODES.state)
    ok('inventory', { ...ref(s), ...p })
    assert.equal(call('inventory', { ...ref(s), ...p, implementation: { ...implementation(0, []), touched_paths: ['src/a.mjs'] } }).code, CODES.input)
    ok('inventory', { ...ref(s), ...p, implementation: implementation(0, []) })
    assert.equal(call('inventory', { ...ref(s), ...p, implementation: implementation(0, []) }).code, CODES.state, 'round のリセット')
  })
})

test('run-checks: 開始時に成功していた check の変更後の失敗だけを repairable にする', async (t) => {
  const cases = [
    { name: '正常: 開始時も変更後も成功', failBefore: false, failAfter: false, exit: 0, failedAtBaseline: false, repairable: false },
    { name: '異常: 変更が起こした失敗', failBefore: false, failAfter: true, exit: 2, failedAtBaseline: false, repairable: true },
    { name: '準正常: 開始時から失敗していた', failBefore: true, failAfter: true, exit: 2, failedAtBaseline: true, repairable: false },
  ]
  for (const c of cases) {
    await t.test(c.name, (t) => {
      const fx = fixture(t)
      if (c.failBefore) write(fx.repo, 'FAIL', 'x\n')
      const s = start(fx)
      const p = planFor(s, { affected_paths: ['src/a.mjs', 'FAIL'] })
      ok('inventory', { ...ref(s), ...p })
      const baseline = ok('run-checks', { ...ref(s), ...p, phase: 'baseline' })
      assert.equal(baseline.run.results[0].exit_code, c.failBefore ? 2 : 0)
      if (c.failAfter && !c.failBefore) write(fx.repo, 'FAIL', 'x\n')
      write(fx.repo, 'src/a.mjs', 'changed\n')
      const touched = ['src/a.mjs', ...(c.failAfter && !c.failBefore ? ['FAIL'] : [])]
      ok('inventory', { ...ref(s), ...p, implementation: implementation(0, touched) })
      const out = ok('run-checks', { ...ref(s), ...p, phase: 'after' })
      const [r] = out.run.results
      assert.deepEqual([r.argv, r.exit_code, r.failed_at_baseline, r.repairable], [['make', 'test'], c.exit, c.failedAtBaseline, c.repairable])
      assert.match(r.stdout_tail, /running/)
      assert.equal(out.passed, c.exit === 0)
      assert.equal(out.run_sum, fnvSum(out.run))
      assert.equal(out.run.tree_changed, false)
    })
  }
})

test('run-checks: 実行の順と対象を記録で縛り、許可リストに無いものは何も実行しない', async (t) => {
  await t.test('境界: 開始時にまだ無いテストは baseline で実行せず、変更後は実行する', (t) => {
    const fx = fixture(t)
    const s = start(fx)
    const p = planFor(s, { checks: [{ kind: 'node-test', value: 'src/new.test.mjs' }] })
    ok('inventory', { ...ref(s), ...p })
    const baseline = ok('run-checks', { ...ref(s), ...p, phase: 'baseline' })
    assert.equal(baseline.run.results[0].not_run, 'baseline にまだ無いテスト')
    write(fx.repo, 'src/new.test.mjs', "import test from 'node:test'\ntest('n', () => {})\n")
    ok('inventory', { ...ref(s), ...p, implementation: implementation(0, ['src/new.test.mjs']) })
    const out = ok('run-checks', { ...ref(s), ...p, phase: 'after' })
    assert.deepEqual([out.run.results[0].argv, out.run.results[0].exit_code, out.run.results[0].failed_at_baseline], [['node', '--test', 'src/new.test.mjs'], 0, null])
  })
  await t.test('異常: baseline の 2 回目・実装の前の after・受け入れていない plan を拒否する', (t) => {
    const fx = fixture(t)
    const s = start(fx)
    const p = planFor(s)
    assert.equal(call('run-checks', { ...ref(s), ...p, phase: 'baseline' }).code, CODES.state)
    ok('inventory', { ...ref(s), ...p })
    assert.equal(call('run-checks', { ...ref(s), ...p, phase: 'after' }).code, CODES.state)
    ok('run-checks', { ...ref(s), ...p, phase: 'baseline' })
    assert.equal(call('run-checks', { ...ref(s), ...p, phase: 'baseline' }).code, CODES.state)
    assert.equal(call('run-checks', { ...ref(s), ...p, phase: 'later' }).code, CODES.input)
  })
  await t.test('異常: 受け入れた後に check を差し替えた plan は sum が変わり、受け入れていないものとして拒否する', (t) => {
    const fx = fixture(t)
    const s = start(fx)
    ok('inventory', { ...ref(s), ...planFor(s) })
    const forged = planFor(s, { checks: [{ kind: 'make', value: 'install' }] })
    assert.equal(call('run-checks', { ...ref(s), ...forged, phase: 'baseline' }).code, CODES.state)
  })
  await t.test('異常: 許可リストに無い check を含む plan は 1 件も実行しない', (t) => {
    const fx = fixture(t)
    const s = start(fx)
    const p = planFor(s, { checks: [{ kind: 'make', value: 'test' }, { kind: 'make', value: 'install' }] })
    const ledger = JSON.parse(readFileSync(s.state.ledgerPath, 'utf8'))
    writeFileSync(s.state.ledgerPath, JSON.stringify({ ...ledger, plan_sum: p.planSum }))
    const ran = []
    const io = { ...defaultIo(), run: (argv) => { ran.push(argv); return { status: 0, stdout: '', stderr: '' } } }
    const out = JSON.parse(main(['run-checks'], JSON.stringify({ ...ref(s), ...p, phase: 'baseline' }), io).output)
    assert.equal(out.code, CODES.check)
    assert.deepEqual(ran, [])
  })
})

function happyPath(t) {
  const fx = fixture(t)
  const s = start(fx)
  const p = planFor(s)
  ok('inventory', { ...ref(s), ...p })
  ok('run-checks', { ...ref(s), ...p, phase: 'baseline' })
  write(fx.repo, 'src/a.mjs', 'export const a = 2\n')
  ok('inventory', { ...ref(s), ...p, implementation: implementation(0, ['src/a.mjs']) })
  ok('run-checks', { ...ref(s), ...p, phase: 'after' })
  return { fx, s, p }
}

test('verify: 最後に check と review を通した作業ツリーのままのときだけ ok にする', async (t) => {
  await t.test('正常: check と review が通り、その後に変わっていない', (t) => {
    const { s, p } = happyPath(t)
    ok('record-review', { ...ref(s), review: review(s) })
    const out = ok('verify', { ...ref(s), ...p })
    assert.deepEqual(out.problems, [])
    assert.equal(out.passed, true)
  })
  await t.test('異常: review の後に作業ツリーが変わった', (t) => {
    const { fx, s, p } = happyPath(t)
    ok('record-review', { ...ref(s), review: review(s) })
    write(fx.repo, 'src/a.mjs', 'export const a = 3\n')
    assert.deepEqual(ok('verify', { ...ref(s), ...p }).problems.map((x) => x.cause), ['changed_since_checks', 'changed_since_review'])
  })
  await t.test('異常: review が確定指摘を返した', (t) => {
    const { s, p } = happyPath(t)
    ok('record-review', { ...ref(s), review: review(s, { findings: [{}] }) })
    assert.deepEqual(ok('verify', { ...ref(s), ...p }).problems.map((x) => x.cause), ['review_not_passed'])
  })
  await t.test('異常: review を記録していない', (t) => {
    const { s, p } = happyPath(t)
    assert.deepEqual(ok('verify', { ...ref(s), ...p }).problems.map((x) => x.cause), ['review_missing'])
  })
  await t.test('異常: 別の HEAD の review は記録しない', (t) => {
    const { s } = happyPath(t)
    assert.equal(call('record-review', { ...ref(s), review: review(s, { headSha: 'f'.repeat(40) }) }).code, CODES.input)
  })
  await t.test('境界: 変更が無い計画は check と review を求めない', (t) => {
    const fx = fixture(t)
    const s = start(fx)
    const p = planFor(s, { status: 'no_change', affected_paths: [], checks: [] })
    ok('inventory', { ...ref(s), ...p })
    assert.equal(ok('verify', { ...ref(s), ...p }).passed, true)
  })
})

test('snapshot: 内容・未追跡・symlink の先の文字列で変わり、読むだけでは変わらない', (t) => {
  const fx = fixture(t)
  const s = start(fx)
  const first = ok('snapshot', ref(s)).snapshot
  assert.equal(ok('snapshot', ref(s)).snapshot, first, '読むだけでは変わらない')
  write(fx.repo, 'new.md', 'n\n')
  const second = ok('snapshot', ref(s)).snapshot
  assert.notEqual(second, first)
  write(fx.repo, 'new.md', 'm\n')
  assert.notEqual(ok('snapshot', ref(s)).snapshot, second, '同じ path の内容の違い')
  rmSync(path.join(fx.repo, 'new.md'))
  unlinkSync(path.join(fx.repo, 'link'))
  symlinkSync('src', path.join(fx.repo, 'link'))
  assert.notEqual(ok('snapshot', ref(s)).snapshot, first, 'symlink の先の文字列の違い')
})

test('state の改変・写し間違いは E_INPUT で拒否する', (t) => {
  const fx = fixture(t)
  const s = start(fx)
  assert.equal(call('snapshot', { statePath: s.statePath, stateSum: '00000000' }).code, CODES.input)
  assert.equal(call('snapshot', { statePath: 'relative.json', stateSum: s.stateSum }).code, CODES.input)
  writeFileSync(s.statePath, JSON.stringify({ ...s.state, head: 'c'.repeat(40) }))
  assert.equal(call('snapshot', ref(s)).code, CODES.input)
})

test('main: 使い方の誤りは exit 2、拒否は exit 1 で、本物の CLI も同じ JSON の 1 行を返す', async (t) => {
  for (const [name, argv, input, exit, code] of [
    ['異常: 知らない操作', ['merge'], '{}', 2, CODES.input],
    ['異常: 引数が多い', ['start', 'x'], '{}', 2, CODES.input],
    ['異常: JSON でない', ['start'], 'not json', 2, CODES.input],
    ['異常: 配列', ['start'], '[]', 2, CODES.input],
    ['異常: 必須の値が無い', ['start'], '{}', 1, CODES.input],
  ]) {
    await t.test(name, () => {
      const r = main(argv, input)
      assert.equal(r.exitCode, exit)
      assert.equal(JSON.parse(r.output).code, code)
    })
  }
  await t.test('正常: 子プロセスとして start を通す（空白を含む stateDir）', (t) => {
    const fx = fixture(t)
    const dir = path.join(fx.stateDir, 'a b')
    mkdirSync(dir)
    const r = spawnSync(process.execPath, [CLI, 'start'], { input: JSON.stringify({ repo: fx.repo, stateDir: dir, policyRef: 'main' }), encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    const out = JSON.parse(r.stdout)
    assert.equal(out.ok, true)
    assert.equal(out.state_path, path.join(dir, 'repo-implement-state.json'))
  })
})
