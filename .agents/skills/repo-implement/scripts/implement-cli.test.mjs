// implement-cli の start・inventory・begin-round。共有の道具は test-fixtures/implement-cli.mjs（ファイルを分けて並列に走らせる）。
import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, readdirSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { main } from './implement-cli.mjs'
import { CODES, DEFAULT_POLICY_REF, fnvSum } from './implement-core.mjs'
import { git, write, fixture, call, ok, start, planFor, ref, implementationFor, admit, round, reviewPlanFile, reviewOf, confirmed } from './test-fixtures/implement-cli.mjs'

describe('implement-cli', { concurrency: 4 }, () => {
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
    assert.equal(ok('inventory', { ...ref(s), ...planFor(s) }).baseline_needed, false, '同じ plan の受け入れ直しは baseline を残す')
    const second = planFor(s, { checks: [{ kind: 'make', value: 'test' }, { kind: 'make', value: 'check' }] })
    const readmitted = ok('inventory', { ...ref(s), ...second })
    assert.deepEqual([readmitted.admitted, readmitted.baseline_needed], [true, true])
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
  for (const [name, touchedOf] of [['./ 付き', () => './src/a.mjs'], ['絶対パス', (repo) => path.join(repo, 'src/a.mjs')]]) {
    await t.test(`異常: 正規形でない touched_paths（${name}）でも round を閉じ、原因を記録する`, (t) => {
      const fx = fixture(t)
      const s = start(fx)
      const p = planFor(s)
      admit(s, p)
      const bad = touchedOf(fx.repo)
      const { inv } = round(s, p, (r) => write(r, 'src/a.mjs', '2\n'), [bad])
      assert.equal(inv.passed, false)
      assert.deepEqual(inv.problems.map((x) => x.cause), ['invalid_touched_path', 'undeclared'])
      assert.deepEqual(inv.problems[0].paths, [bad])
      const ledger = JSON.parse(readFileSync(s.state.ledgerPath, 'utf8'))
      assert.equal(ledger.open, null)
      assert.deepEqual(ledger.rounds.at(-1).problems.map((x) => x.cause), ['invalid_touched_path', 'undeclared'])
      assert.equal(call('begin-round', { ...ref(s), ...p, repair: 'checks' }).code, CODES.state, '通らなかった round の後は次の回を開かない')
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
})
