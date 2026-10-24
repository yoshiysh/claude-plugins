import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defaultIo, main } from './implement-cli.mjs'
import { CODES, DEFAULT_POLICY_REF, fnvSum, sha256 } from './implement-core.mjs'

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
  write(repo, '.gitignore', 'build/\n')
  write(repo, 'src/a.mjs', 'export const a = 1\n')
  write(repo, 'src/a.test.mjs', "import test from 'node:test'\ntest('a', () => {})\n")
  write(repo, 'keep.md', 'keep\n')
  write(repo, 'gone.md', 'gone\n')
  write(repo, 'real/x.md', 'x\n')
  symlinkSync('real', path.join(repo, 'link'))
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'base')
  git(repo, 'update-ref', `refs/remotes/${DEFAULT_POLICY_REF}`, 'main')
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
  const out = ok('start', { repo: fx.repo, stateDir: fx.stateDir })
  return { state: out.state, statePath: out.state_path, stateSum: out.state_sum, out, repo: fx.repo, stateDir: fx.stateDir }
}

function planFor(s, patch = {}) {
  const plan = { status: 'approved', state_sum: s.stateSum, affected_paths: ['src/a.mjs', 'src/a.test.mjs', 'src/new.test.mjs', 'FAIL'], checks: [{ kind: 'make', value: 'test' }], ...patch }
  return { plan, planSum: fnvSum(plan) }
}

const ref = (s) => ({ statePath: s.statePath, stateSum: s.stateSum })

// 実装の Workflow の返り値と同じ形（券の sum と round を持ち、全体に sum が付く）。
function implementationFor(begun, touched, status = 'ready_for_check') {
  const body = { status, repairRound: begun.ticket.round, ticket_sum: begun.ticket_sum, touched_paths: touched }
  return { ...body, sum: fnvSum(body) }
}

function admit(s, p) {
  const out = ok('inventory', { ...ref(s), ...p })
  assert.equal(out.admitted, true, JSON.stringify(out.problems))
  ok('run-checks', { ...ref(s), ...p, phase: 'baseline' })
}

// begin-round → 書き込み → inventory を 1 回分流す。
function round(s, p, edit, touched, { repair = null, status } = {}) {
  const begun = ok('begin-round', { ...ref(s), ...p, repair })
  edit?.(s.repo)
  return { begun, inv: ok('inventory', { ...ref(s), ...p, implementation: implementationFor(begun, touched, status) }) }
}

// repo-review の plan 操作が stateDir に書く計画のファイルの形（record-review が照らす部分）を、今の作業ツリーから作る。
function reviewPlanFile(s, files, patch = {}) {
  const digests = Object.fromEntries(files.filter((f) => typeof f === 'string' && !f.startsWith('..')).map((f) => [f, `file:${sha256(readFileSync(path.join(s.repo, f)))}`]))
  const plan = { mode: 'working_tree', baseRef: s.state.head, headSha: s.state.head, policyRef: s.state.policyRef, target: { files }, excluded: [], generated: [], preserved: s.out.preservedPaths, digests, reviewers: LENSES.map((id) => ({ id })), ...patch }
  const file = path.join(s.stateDir, `review-plan-${fnvSum(plan)}.json`)
  writeFileSync(file, JSON.stringify(plan))
  return { reviewPlanPath: file, reviewPlanSum: fnvSum(plan), plan }
}

const LENSES = ['correctness', 'docs']
// repo-review の Workflow の返り値の形（record-review が照らす部分）。sum は本文の fnvSum。
function reviewOf(s, files, patch = {}) {
  const body = {
    status: 'completed', mode: 'working_tree', headSha: s.state.head, baseRef: s.state.head, policyRef: s.state.policyRef, scope: null, target: { files },
    excluded: [], generated: [], preserved: s.out.preservedPaths, coverage: LENSES.map((id) => ({ id })), pin: { ok: true }, findings: [], unverified: [], reasons: [], ...patch,
  }
  return { ...body, sum: fnvSum(body) }
}

const confirmed = (patch = {}) => ({
  path: 'src/a.mjs', line: 1, in_target: true,
  claim: { severity: 'HIGH', summary: 's', condition: 'c', impact: 'i', evidence: 'e', rule: 'r' },
  votes: [{ vote: 'confirmed' }], ...patch,
})

test('start: 開始時の変更を preservedPaths として内容・XY・index の entry つきで記録し、削除は HEAD の blob で記録する', (t) => {
  const fx = fixture(t)
  write(fx.repo, 'keep.md', 'edited\n')
  write(fx.repo, 'notes/untracked.md', 'u\n')
  unlinkSync(path.join(fx.repo, 'gone.md'))
  const s = start(fx)
  assert.deepEqual(s.out.preservedPaths, ['gone.md', 'keep.md', 'notes/untracked.md'])
  const digests = Object.fromEntries(s.state.preserved.map((p) => [p.path, p.digest]))
  assert.match(digests['gone.md'], new RegExp(`^deleted:${git(fx.repo, 'rev-parse', 'HEAD:gone.md')}\\|xy: D\\|index:100644 `))
  assert.match(digests['keep.md'], /^file:[0-9a-f]{64}\|xy: M\|index:100644 [0-9a-f]{40} 0$/)
  assert.match(digests['notes/untracked.md'], /\|xy:\?\?\|index:none$/)
  assert.equal(s.state.head, fx.head)
  assert.equal(s.state.policyRef, git(fx.repo, 'rev-parse', 'main'))
  assert.equal(s.state.branch, 'work')
  assert.equal(fnvSum(JSON.parse(readFileSync(s.statePath, 'utf8'))), s.stateSum)
})

test('start: policyRef は主ブランチの remote の先端に固定し、呼び出し側の値を受け付けない', (t) => {
  const fx = fixture(t)
  git(fx.repo, 'commit', '-q', '--allow-empty', '-m', 'work branch commit')
  assert.equal(call('start', { repo: fx.repo, stateDir: fx.stateDir, policyRef: 'HEAD' }).code, CODES.input)
  const out = ok('start', { repo: fx.repo, stateDir: fx.stateDir })
  assert.equal(out.state.policyRef, git(fx.repo, 'rev-parse', DEFAULT_POLICY_REF))
  assert.notEqual(out.state.policyRef, out.state.head)
})

test('start: 始められない入力を理由つきで拒否し、state を書かない', async (t) => {
  const cases = [
    { name: '異常: main の上', setup: (t) => fixture(t, { branch: 'main' }), body: (fx) => ({ repo: fx.repo, stateDir: fx.stateDir }), code: CODES.pin },
    { name: '異常: branch の無い HEAD', body: (fx) => { git(fx.repo, 'checkout', '-q', '--detach'); return { repo: fx.repo, stateDir: fx.stateDir } }, code: CODES.pin },
    { name: '異常: stateDir が repo の中', body: (fx) => { mkdirSync(path.join(fx.repo, 'st')); return { repo: fx.repo, stateDir: path.join(fx.repo, 'st') } }, code: CODES.input },
    { name: '異常: remote の主ブランチが無い', body: (fx) => { git(fx.repo, 'update-ref', '-d', `refs/remotes/${DEFAULT_POLICY_REF}`); return { repo: fx.repo, stateDir: fx.stateDir } }, code: CODES.pin },
    { name: '異常: 未追跡の入れ子の repo（レビューの変更の集合として扱えない）', body: (fx) => { mkdirSync(path.join(fx.repo, 'nested')); git(path.join(fx.repo, 'nested'), 'init', '-q'); write(fx.repo, 'nested/x', 'x\n'); return { repo: fx.repo, stateDir: fx.stateDir } }, code: CODES.pin },
    { name: '異常: index だけが HEAD と違う path（staged の後に作業ツリーを戻した）', body: (fx) => { write(fx.repo, 'keep.md', 'staged\n'); git(fx.repo, 'add', 'keep.md'); write(fx.repo, 'keep.md', 'keep\n'); return { repo: fx.repo, stateDir: fx.stateDir } }, code: CODES.pin },
    { name: '異常: stateDir が無い', body: (fx) => ({ repo: fx.repo, stateDir: path.join(fx.stateDir, 'missing') }), code: CODES.input },
    { name: '異常: repo が root でない', body: (fx) => ({ repo: path.join(fx.repo, 'src'), stateDir: fx.stateDir }), code: CODES.input },
  ]
  for (const c of cases) {
    await t.test(c.name, (t) => {
      const fx = (c.setup ?? fixture)(t)
      const out = call('start', c.body(fx))
      assert.equal(out.ok, false)
      assert.equal(out.code, c.code, out.reason)
      assert.deepEqual(readdirSync(fx.stateDir), [])
    })
  }
  await t.test('準正常: 同じ stateDir での 2 回目の start は前の state を上書きしない', (t) => {
    const fx = fixture(t)
    start(fx)
    assert.equal(call('start', { repo: fx.repo, stateDir: fx.stateDir }).code, CODES.state)
  })
})

test('inventory（受け入れ）: symlink・ignore される path、許可リストの外・必須の欠けた check、計画の段の書き込みを受け入れない', async (t) => {
  const cases = [
    { name: '正常: 受け入れる', patch: {}, causes: [] },
    { name: '異常: symlink の下の path', patch: { affected_paths: ['link/x.md'] }, causes: ['symlink_path'] },
    { name: '異常: ディレクトリそのもの', patch: { affected_paths: ['src'] }, causes: ['symlink_path'] },
    { name: '異常: ignore される path', patch: { affected_paths: ['build/out.txt'] }, causes: ['ignored_path'] },
    { name: '異常: 許可リストに無い make target', patch: { checks: [{ kind: 'make', value: 'test' }, { kind: 'make', value: 'runtime-deps' }] }, causes: ['check_not_allowed'] },
    { name: '異常: 必須の make test が無い', patch: { checks: [{ kind: 'make', value: 'check' }] }, causes: ['check_not_allowed'] },
    { name: '異常: 計画の段で作業ツリーが変わった', patch: {}, edit: (r) => write(r, 'src/a.mjs', 'planned write\n'), causes: ['changed_outside_steps'] },
  ]
  for (const c of cases) {
    await t.test(c.name, (t) => {
      const fx = fixture(t)
      const s = start(fx)
      c.edit?.(fx.repo)
      const out = ok('inventory', { ...ref(s), ...planFor(s, c.patch) })
      assert.deepEqual(out.problems.map((p) => p.cause), c.causes)
      assert.equal(out.admitted, c.causes.length === 0)
    })
  }
  await t.test('準正常: 実装の前なら計画し直した plan を受け入れ直し、baseline を取り直させる', (t) => {
    const fx = fixture(t)
    const s = start(fx)
    admit(s, planFor(s))
    const second = planFor(s, { checks: [{ kind: 'make', value: 'test' }, { kind: 'make', value: 'check' }] })
    assert.equal(ok('inventory', { ...ref(s), ...second }).admitted, true)
    assert.equal(call('begin-round', { ...ref(s), ...second, repair: null }).code, CODES.state, 'baseline の取り直しの前')
    ok('run-checks', { ...ref(s), ...second, phase: 'baseline' })
    ok('begin-round', { ...ref(s), ...second, repair: null })
  })
  await t.test('異常: 実装の round の後は受け入れ直さない', (t) => {
    const fx = fixture(t)
    const s = start(fx)
    const p = planFor(s)
    admit(s, p)
    round(s, p, (r) => write(r, 'src/a.mjs', '2\n'), ['src/a.mjs'])
    assert.equal(call('inventory', { ...ref(s), ...planFor(s, { affected_paths: ['src/a.mjs', 'README.md'] }) }).code, CODES.state)
  })
})

test('inventory（実装の後）: 実際の変更を plan・touched_paths・preserved・申告と照らす', async (t) => {
  const cases = [
    { name: '正常: 申告どおり', edit: (r) => write(r, 'src/a.mjs', 'export const a = 2\n'), touched: ['src/a.mjs'], causes: [] },
    { name: '異常: 申告漏れ', edit: (r) => { write(r, 'src/a.mjs', '2\n'); write(r, 'src/a.test.mjs', '2\n') }, touched: ['src/a.mjs'], causes: ['undeclared'] },
    { name: '異常: plan の外', edit: (r) => write(r, 'README.md', 'x\n'), touched: [], causes: ['outside_plan', 'undeclared'] },
    { name: '異常: preserved の内容を書き換えた', edit: (r) => write(r, 'keep.md', 'overwritten\n'), touched: [], causes: ['preserved_changed'] },
    { name: '異常: preserved を git add した（内容は同じ）', edit: (r) => git(r, 'add', 'keep.md'), touched: [], causes: ['index_changed', 'preserved_changed'] },
    { name: '異常: plan の path を stage した後に作業ツリーを編集した', edit: (r) => { write(r, 'src/a.mjs', 'staged\n'); git(r, 'add', 'src/a.mjs'); write(r, 'src/a.mjs', 'worktree\n') }, touched: ['src/a.mjs'], causes: ['index_changed'] },
    { name: '異常: plan の path を stage した後に作業ツリーを HEAD に戻した（変更の集合から消える）', edit: (r) => { write(r, 'src/a.mjs', 'staged\n'); git(r, 'add', 'src/a.mjs'); write(r, 'src/a.mjs', 'export const a = 1\n') }, touched: ['src/a.mjs'], causes: ['index_changed'] },
    { name: '異常: 実装したと返したのに何も書いていない', edit: null, touched: ['src/a.mjs'], causes: ['no_effect'] },
    { name: '異常: 失敗した実装が作業ツリーを変えた', edit: (r) => write(r, 'src/a.mjs', '2\n'), touched: ['src/a.mjs'], status: 'blocked', causes: ['changed_on_failure'] },
  ]
  for (const c of cases) {
    await t.test(c.name, (t) => {
      const fx = fixture(t)
      write(fx.repo, 'keep.md', 'mine\n')
      const s = start(fx)
      const p = planFor(s)
      admit(s, p)
      const { inv } = round(s, p, c.edit, c.touched, { status: c.status })
      assert.deepEqual(inv.problems.map((x) => x.cause), c.causes)
    })
  }
  await t.test('異常: 券の無い返り値・書き換えた返り値・同じ券の 2 回目を拒否する', (t) => {
    const fx = fixture(t)
    const s = start(fx)
    const p = planFor(s)
    admit(s, p)
    const forged = { status: 'ready_for_check', repairRound: 0, ticket_sum: 'x', touched_paths: [] }
    assert.equal(call('inventory', { ...ref(s), ...p, implementation: { ...forged, sum: fnvSum(forged) } }).code, CODES.input, '開いた round が無い')
    const begun = ok('begin-round', { ...ref(s), ...p, repair: null })
    write(fx.repo, 'src/a.mjs', '2\n')
    assert.equal(call('inventory', { ...ref(s), ...p, implementation: { ...implementationFor(begun, ['src/a.mjs']), touched_paths: [] } }).code, CODES.input, 'sum が合わない')
    ok('inventory', { ...ref(s), ...p, implementation: implementationFor(begun, ['src/a.mjs']) })
    assert.equal(call('inventory', { ...ref(s), ...p, implementation: implementationFor(begun, ['src/a.mjs']) }).code, CODES.input, '閉じた券の 2 回目')
  })
})

test('begin-round: 順序と記録の外の書き込みを、書き込みの前に拒否する', async (t) => {
  await t.test('異常: 受け入れの前・baseline の前・開いた round がある・記録の外で変わった', (t) => {
    const fx = fixture(t)
    const s = start(fx)
    const p = planFor(s)
    assert.equal(call('begin-round', { ...ref(s), ...p, repair: null }).code, CODES.state, '受け入れの前')
    ok('inventory', { ...ref(s), ...p })
    assert.equal(call('begin-round', { ...ref(s), ...p, repair: null }).code, CODES.state, 'baseline の前')
    ok('run-checks', { ...ref(s), ...p, phase: 'baseline' })
    write(fx.repo, 'src/a.mjs', 'outside the steps\n')
    assert.equal(call('begin-round', { ...ref(s), ...p, repair: null }).code, CODES.state, '記録の外の書き込み')
    write(fx.repo, 'src/a.mjs', 'export const a = 1\n')
    ok('begin-round', { ...ref(s), ...p, repair: null })
    assert.equal(call('begin-round', { ...ref(s), ...p, repair: null }).code, CODES.state, '開いた round がある')
  })
  await t.test('異常: 変更不要の plan は実装しない', (t) => {
    const fx = fixture(t)
    const s = start(fx)
    const p = planFor(s, { status: 'no_change', affected_paths: [], checks: [] })
    ok('inventory', { ...ref(s), ...p })
    assert.equal(call('begin-round', { ...ref(s), ...p, repair: null }).code, CODES.state)
  })
  await t.test('準正常: 計画の外を指す確定指摘は券を出さず、round を消費しない', (t) => {
    const fx = fixture(t)
    const s = start(fx)
    const p = planFor(s)
    admit(s, p)
    round(s, p, (r) => write(r, 'src/a.mjs', '2\n'), ['src/a.mjs'])
    ok('run-checks', { ...ref(s), ...p, phase: 'after' })
    const rp = reviewPlanFile(s, ['src/a.mjs'])
    ok('record-review', { ...ref(s), review: reviewOf(s, ['src/a.mjs'], { findings: [confirmed({ in_target: false, path: 'src/caller.mjs' })] }), reviewPlanPath: rp.reviewPlanPath, reviewPlanSum: rp.reviewPlanSum })
    const out = ok('begin-round', { ...ref(s), ...p, repair: 'review' })
    assert.equal(out.needs_replan, true)
    assert.equal(out.findingsOutsidePlan[0].path, 'src/caller.mjs')
    assert.equal(JSON.parse(readFileSync(s.state.ledgerPath, 'utf8')).open, null)
  })
})

test('run-checks: 開始時に成功していた check と開始時に無かったテストの、変更後の失敗だけを repairable にする', async (t) => {
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
      const p = planFor(s)
      ok('inventory', { ...ref(s), ...p })
      const baseline = ok('run-checks', { ...ref(s), ...p, phase: 'baseline' })
      assert.equal(baseline.run.results[0].exit_code, c.failBefore ? 2 : 0)
      const addFail = c.failAfter && !c.failBefore
      round(s, p, (r) => { write(r, 'src/a.mjs', 'changed\n'); if (addFail) write(r, 'FAIL', 'x\n') }, ['src/a.mjs', ...(addFail ? ['FAIL'] : [])])
      const out = ok('run-checks', { ...ref(s), ...p, phase: 'after' })
      const [r] = out.run.results
      assert.deepEqual([r.argv, r.exit_code, r.failed_at_baseline, r.repairable], [['make', 'test'], c.exit, c.failedAtBaseline, c.repairable])
      assert.match(r.stdout_tail, /running/)
      assert.equal(out.passed, c.exit === 0)
      assert.equal(out.run.tree_changed, false)
    })
  }
  await t.test('境界: 開始時にまだ無いテストは baseline で実行せず、変更後の失敗は変更起因にする', (t) => {
    const fx = fixture(t)
    const s = start(fx)
    const p = planFor(s, { checks: [{ kind: 'make', value: 'test' }, { kind: 'node-test', value: 'src/new.test.mjs' }] })
    ok('inventory', { ...ref(s), ...p })
    const baseline = ok('run-checks', { ...ref(s), ...p, phase: 'baseline' })
    assert.equal(baseline.run.results[1].not_run, 'baseline にまだ無いテスト')
    round(s, p, (r) => write(r, 'src/new.test.mjs', "import test from 'node:test'\ntest('n', () => { throw new Error('x') })\n"), ['src/new.test.mjs'])
    const r = ok('run-checks', { ...ref(s), ...p, phase: 'after' }).run.results[1]
    assert.deepEqual([r.argv, r.exit_code === 0, r.failed_at_baseline, r.repairable], [['node', '--test', 'src/new.test.mjs'], false, false, true])
  })
})

test('run-checks: 実行の順と対象を記録で縛り、許可されないものは何も実行しない', async (t) => {
  await t.test('異常: baseline の 2 回目・実装の前の after・受け入れていない plan・知らない phase を拒否する', (t) => {
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
  await t.test('異常: round を閉じる前・記録の外で変わった後の after を拒否する', (t) => {
    const fx = fixture(t)
    const s = start(fx)
    const p = planFor(s)
    admit(s, p)
    const begun = ok('begin-round', { ...ref(s), ...p, repair: null })
    write(fx.repo, 'src/a.mjs', '2\n')
    assert.equal(call('run-checks', { ...ref(s), ...p, phase: 'after' }).code, CODES.state, 'round を閉じる前')
    ok('inventory', { ...ref(s), ...p, implementation: implementationFor(begun, ['src/a.mjs']) })
    write(fx.repo, 'src/a.mjs', '3\n')
    assert.equal(call('run-checks', { ...ref(s), ...p, phase: 'after' }).code, CODES.state, '記録の外の書き込み')
  })
  await t.test('異常: 変更後に node --test の path が symlink か欠落なら実行しない', async (t) => {
    for (const [name, edit] of [
      ['欠落', (r) => rmSync(path.join(r, 'src/a.test.mjs'))],
      ['symlink', (r) => { rmSync(path.join(r, 'src/a.test.mjs')); symlinkSync('a.mjs', path.join(r, 'src/a.test.mjs')) }],
    ]) {
      await t.test(name, (t) => {
        const fx = fixture(t)
        const s = start(fx)
        const p = planFor(s, { checks: [{ kind: 'make', value: 'test' }, { kind: 'node-test', value: 'src/a.test.mjs' }] })
        admit(s, p)
        round(s, p, edit, ['src/a.test.mjs'])
        assert.equal(call('run-checks', { ...ref(s), ...p, phase: 'after' }).code, CODES.check)
      })
    }
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

function implemented(t) {
  const fx = fixture(t)
  const s = start(fx)
  const p = planFor(s)
  admit(s, p)
  round(s, p, (r) => write(r, 'src/a.mjs', 'export const a = 2\n'), ['src/a.mjs'])
  ok('run-checks', { ...ref(s), ...p, phase: 'after' })
  return { fx, s, p }
}

function recordReview(s, files, reviewPatch = {}, planPatch = {}) {
  const rp = reviewPlanFile(s, files, planPatch)
  return call('record-review', { ...ref(s), review: reviewOf(s, files, reviewPatch), reviewPlanPath: rp.reviewPlanPath, reviewPlanSum: rp.reviewPlanSum })
}

test('record-review: 今の変更の全体を今の内容でレビューした結果だけを記録する', async (t) => {
  await t.test('正常: 記録し、確定指摘はレビューの修正の券に載る', (t) => {
    const { s, p } = implemented(t)
    const out = recordReview(s, ['src/a.mjs'], { findings: [confirmed()] })
    assert.equal(out.ok, true, out.reason)
    assert.equal(out.review.passed, false)
    const begun = ok('begin-round', { ...ref(s), ...p, repair: 'review' })
    assert.deepEqual([begun.ticket.round, begun.ticket.findings.length], [1, 1])
  })
  const rejects = [
    ['異常: 対象を一部に狭めた', (s) => recordReview(s, [], {}, {})],
    ['異常: implementer の変更を preserved に混ぜた', (s) => recordReview(s, [], { preserved: [...s.out.preservedPaths, 'src/a.mjs'] }, { preserved: [...s.out.preservedPaths, 'src/a.mjs'] })],
    ['異常: scope を付けた', (s) => recordReview(s, ['src/a.mjs'], { scope: ['src'] })],
    ['異常: 計画のファイルと返り値の対象が違う', (s) => recordReview(s, ['src/a.mjs'], {}, { target: { files: ['src/b.mjs'] } })],
    ['異常: 計画のファイルの後に内容が変わった（前の round のレビュー）', (s) => recordReview(s, ['src/a.mjs'], {}, { digests: { 'src/a.mjs': 'file:old' } })],
    ['異常: 計画のファイルの sum が合わない', (s) => call('record-review', { ...ref(s), review: reviewOf(s, ['src/a.mjs']), ...{ reviewPlanPath: reviewPlanFile(s, ['src/a.mjs']).reviewPlanPath, reviewPlanSum: '00000000' } })],
    ['異常: 別の HEAD のレビュー', (s) => recordReview(s, ['src/a.mjs'], { headSha: 'f'.repeat(40) })],
  ]
  for (const [name, act] of rejects) {
    await t.test(name, (t) => {
      const { s } = implemented(t)
      assert.equal(act(s).code, CODES.input)
    })
  }
  await t.test('異常: check の前のレビューは記録しない', (t) => {
    const fx = fixture(t)
    const s = start(fx)
    const p = planFor(s)
    admit(s, p)
    round(s, p, (r) => write(r, 'src/a.mjs', '2\n'), ['src/a.mjs'])
    assert.equal(recordReview(s, ['src/a.mjs']).code, CODES.state)
  })
})

test('verify: 最後に check と review を通した作業ツリーのままのときだけ passed にする', async (t) => {
  await t.test('正常: check と review が通り、その後に変わっていない', (t) => {
    const { s, p } = implemented(t)
    assert.equal(recordReview(s, ['src/a.mjs']).ok, true)
    const out = ok('verify', { ...ref(s), ...p })
    assert.deepEqual(out.problems, [])
    assert.equal(out.passed, true)
  })
  await t.test('異常: review の後に作業ツリーが変わった', (t) => {
    const { fx, s, p } = implemented(t)
    recordReview(s, ['src/a.mjs'])
    write(fx.repo, 'src/a.mjs', 'export const a = 3\n')
    assert.deepEqual(ok('verify', { ...ref(s), ...p }).problems.map((x) => x.cause), ['changed_outside_steps', 'changed_since_checks', 'changed_since_review'])
  })
  await t.test('異常: review が確定指摘を返した', (t) => {
    const { s, p } = implemented(t)
    recordReview(s, ['src/a.mjs'], { findings: [confirmed()] })
    assert.deepEqual(ok('verify', { ...ref(s), ...p }).problems.map((x) => x.cause), ['review_not_passed'])
  })
  await t.test('異常: review を記録していない', (t) => {
    const { s, p } = implemented(t)
    assert.deepEqual(ok('verify', { ...ref(s), ...p }).problems.map((x) => x.cause), ['review_missing'])
  })
  await t.test('異常: 承認済みの plan を実装していない', (t) => {
    const fx = fixture(t)
    const s = start(fx)
    const p = planFor(s)
    admit(s, p)
    assert.deepEqual(ok('verify', { ...ref(s), ...p }).problems.map((x) => x.cause), ['not_implemented'])
  })
  await t.test('境界: 変更不要の計画は check と review を求めない', (t) => {
    const fx = fixture(t)
    const s = start(fx)
    const p = planFor(s, { status: 'no_change', affected_paths: [], checks: [] })
    ok('inventory', { ...ref(s), ...p })
    assert.equal(ok('verify', { ...ref(s), ...p }).passed, true)
  })
})

test('通らなかった round の後は check・レビューへ進めず、abandon で終えて残った変更を返す', async (t) => {
  for (const [name, status, edit, touched] of [
    ['異常: 実装の Workflow が incomplete', 'incomplete', null, []],
    ['異常: inventory が plan の外の変更で通らない', 'ready_for_check', (r) => write(r, 'README.md', 'x\n'), ['README.md']],
  ]) {
    await t.test(name, (t) => {
      const fx = fixture(t)
      const s = start(fx)
      const p = planFor(s)
      admit(s, p)
      round(s, p, edit, touched, { status })
      assert.equal(call('run-checks', { ...ref(s), ...p, phase: 'after' }).code, CODES.state)
      assert.equal(call('begin-round', { ...ref(s), ...p, repair: 'checks' }).code, CODES.state)
      assert.equal(ok('verify', { ...ref(s), ...p }).passed, false)
      const out = ok('abandon', { ...ref(s), reason: name })
      assert.deepEqual(out.remaining, edit ? ['README.md'] : [])
      for (const [op, body] of [['begin-round', { ...p, repair: null }], ['run-checks', { ...p, phase: 'after' }], ['inventory', p], ['abandon', { reason: 'x' }]]) {
        assert.equal(call(op, { ...ref(s), ...body }).code, CODES.state, `${op} は終わった run で受け付けない`)
      }
      assert.ok(ok('verify', { ...ref(s), ...p }).problems.some((x) => x.cause === 'terminated'))
    })
  }
  await t.test('準正常: Workflow が返り値無しで終わって開いたままの round を abandon が閉じる', (t) => {
    const fx = fixture(t)
    const s = start(fx)
    const p = planFor(s)
    admit(s, p)
    ok('begin-round', { ...ref(s), ...p, repair: null })
    write(fx.repo, 'src/a.mjs', 'half written\n')
    const out = ok('abandon', { ...ref(s), reason: 'workflow timeout' })
    assert.deepEqual(out.remaining, ['src/a.mjs'])
    assert.deepEqual([out.uninventoriedWrites, out.changedOutsideSteps], [true, false], 'implementer の書き込みを段の外の書き込みと報告しない')
    const ledger = JSON.parse(readFileSync(s.state.ledgerPath, 'utf8'))
    assert.deepEqual([ledger.open, ledger.rounds.at(-1).status], [null, 'abandoned'])
  })
  await t.test('異常: 理由の無い abandon', (t) => {
    const fx = fixture(t)
    const s = start(fx)
    assert.equal(call('abandon', ref(s)).code, CODES.input)
  })
})

test('record-review: 1 round に 1 回だけ記録し、やり直しは review_incomplete の後だけ', async (t) => {
  await t.test('異常: completed の後の 2 回目', (t) => {
    const { s } = implemented(t)
    assert.equal(recordReview(s, ['src/a.mjs'], { findings: [confirmed()] }).ok, true)
    assert.equal(recordReview(s, ['src/a.mjs']).code, CODES.state, '指摘 0 件が出るまで回し直せない')
  })
  await t.test('準正常: review_incomplete の後のやり直しは記録し、前の確定指摘を残す', (t) => {
    const { s, p } = implemented(t)
    assert.equal(recordReview(s, ['src/a.mjs'], { status: 'review_incomplete', coverage: undefined, pin: undefined, findings: [confirmed()] }).ok, true)
    const again = recordReview(s, ['src/a.mjs'])
    assert.equal(again.ok, true, again.reason)
    assert.deepEqual([again.review.findings, again.review.passed], [1, false])
    assert.deepEqual(ok('verify', { ...ref(s), ...p }).problems.map((x) => x.cause), ['review_not_passed'])
  })
  await t.test('異常: 返り値から findings を落とした', (t) => {
    const { s } = implemented(t)
    const rp = reviewPlanFile(s, ['src/a.mjs'])
    const dropped = { ...reviewOf(s, ['src/a.mjs'], { findings: [confirmed()] }), findings: [] }
    assert.equal(call('record-review', { ...ref(s), review: dropped, reviewPlanPath: rp.reviewPlanPath, reviewPlanSum: rp.reviewPlanSum }).code, CODES.input)
  })
  await t.test('異常: target.files の path が repo の外・文字列でない（内容を読む前に拒否する）', async (t) => {
    for (const files of [['../outside'], [42]]) {
      await t.test(JSON.stringify(files), (t) => {
        const { s } = implemented(t)
        const out = recordReview(s, files)
        assert.equal(out.code, CODES.input, out.reason)
      })
    }
  })
})

test('run-checks: 同じ round の run は全てを数え、通るまで回し直しても失敗は消えない', (t) => {
  const fx = fixture(t)
  const s = start(fx)
  const p = planFor(s)
  admit(s, p)
  round(s, p, (r) => { write(r, 'src/a.mjs', '2\n'); write(r, 'FAIL', 'x\n') }, ['src/a.mjs', 'FAIL'])
  assert.equal(ok('run-checks', { ...ref(s), ...p, phase: 'after' }).passed, false)
  rmSync(path.join(fx.repo, 'FAIL'))
  assert.equal(call('run-checks', { ...ref(s), ...p, phase: 'after' }).code, CODES.state, '記録の外で失敗の原因を消した')
})

test('大きな入力はファイルの path で渡せ、拒否された op は記録を書かない（正しい入力で同じ段を流し直せる）', async (t) => {
  await t.test('正常: implementationPath・reviewPath で渡す', (t) => {
    const fx = fixture(t)
    const s = start(fx)
    const p = planFor(s)
    admit(s, p)
    const begun = ok('begin-round', { ...ref(s), ...p, repair: null })
    write(fx.repo, 'src/a.mjs', '2\n')
    const implFile = path.join(s.stateDir, 'impl.json')
    writeFileSync(implFile, JSON.stringify(implementationFor(begun, ['src/a.mjs'])))
    assert.equal(call('inventory', { ...ref(s), ...p, implementation: implementationFor(begun, ['src/a.mjs']), implementationPath: implFile }).code, CODES.input, '両方は渡さない')
    assert.equal(ok('inventory', { ...ref(s), ...p, implementationPath: implFile }).passed, true)
    ok('run-checks', { ...ref(s), ...p, phase: 'after' })
    const rp = reviewPlanFile(s, ['src/a.mjs'])
    const reviewFile = path.join(s.stateDir, 'review.json')
    writeFileSync(reviewFile, JSON.stringify(reviewOf(s, ['src/a.mjs'])))
    assert.equal(ok('record-review', { ...ref(s), reviewPath: reviewFile, reviewPlanPath: rp.reviewPlanPath, reviewPlanSum: rp.reviewPlanSum }).next, 'verify')
  })
  await t.test('準正常: 写し間違いで拒否された後、同じ段を正しい入力で流し直せる', (t) => {
    const { s, p } = implemented(t)
    const before = readFileSync(s.state.ledgerPath, 'utf8')
    const rp = reviewPlanFile(s, ['src/a.mjs'])
    const bad = [
      ['record-review', { review: { ...reviewOf(s, ['src/a.mjs']), findings: [confirmed()] }, reviewPlanPath: rp.reviewPlanPath, reviewPlanSum: rp.reviewPlanSum }],
      ['begin-round', { ...p, planSum: '00000000', repair: 'checks' }],
      ['run-checks', { ...p, phase: 'later' }],
      ['inventory', { ...p, implementation: { status: 'x' } }],
      ['verify', { ...p, planSum: '00000000' }],
      ['abandon', {}],
    ]
    for (const [op, body] of bad) {
      assert.equal(call(op, { ...ref(s), ...body }).ok, false, op)
      assert.equal(readFileSync(s.state.ledgerPath, 'utf8'), before, `${op} の拒否は記録を書かない`)
    }
    assert.equal(recordReview(s, ['src/a.mjs']).ok, true)
  })
})

test('record-review: 記録から次の段を 1 つに決めて返す', async (t) => {
  const cases = [
    ['正常: 確定も未検証も無い', [{}], 'verify'],
    ['異常: 確定指摘がある', [{ findings: [confirmed()] }], 'repair'],
    ['異常: completed で未検証が残る', [{ unverified: [{ claim: 'x' }] }], 'abandon'],
    ['準正常: 途中で止まったレビュー（やり直せる）', [{ status: 'review_incomplete', coverage: undefined, pin: undefined }], 'retry_review'],
    ['準正常: 確定指摘が残る review_incomplete は修正へ', [{ status: 'review_incomplete', coverage: undefined, pin: undefined, findings: [confirmed()] }], 'repair'],
    ['境界: やり直しの上限に達した review_incomplete', [{ status: 'review_incomplete', coverage: undefined, pin: undefined }, { status: 'review_incomplete', coverage: undefined, pin: undefined }], 'abandon'],
    ['準正常: やり直しても前の未検証は残る', [{ status: 'review_incomplete', coverage: undefined, pin: undefined, unverified: [{ claim: 'x' }] }], 'abandon'],
  ]
  for (const [name, reviews, next] of cases) {
    await t.test(name, (t) => {
      const { s } = implemented(t)
      let out
      for (const patch of reviews) out = recordReview(s, ['src/a.mjs'], patch)
      assert.equal(out.ok, true, out.reason)
      assert.equal(out.next, next)
    })
  }
  await t.test('異常: 上限を超えるやり直し', (t) => {
    const { s } = implemented(t)
    const inc = { status: 'review_incomplete', coverage: undefined, pin: undefined }
    recordReview(s, ['src/a.mjs'], inc)
    recordReview(s, ['src/a.mjs'], inc)
    assert.equal(recordReview(s, ['src/a.mjs'], inc).code, CODES.state)
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
  const third = ok('snapshot', ref(s))
  assert.notEqual(third.snapshot, first, 'symlink の先の文字列の違い')
  assert.equal(third.unchanged, false)
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
    const r = spawnSync(process.execPath, [CLI, 'start'], { input: JSON.stringify({ repo: fx.repo, stateDir: dir }), encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    const out = JSON.parse(r.stdout)
    assert.equal(out.ok, true)
    assert.equal(out.state_path, path.join(dir, 'repo-implement-state.json'))
  })
})
