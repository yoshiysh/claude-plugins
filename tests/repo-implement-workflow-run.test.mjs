// repo-implement の Workflow の結合のうち、実装の Workflow・修正の券・CLI を通した通し・変更の集合。ファイルを分けて並列に走らせ、共有の道具は helpers/repo-implement-workflow.mjs に置く。
import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { changeSet, defaultIo, main } from '../.agents/skills/repo-implement/scripts/implement-cli.mjs'
import { collectState, defaultIo as reviewIo, main as reviewMain } from '../.agents/skills/repo-review/scripts/review-cli.mjs'
import { fnvSum } from '../.agents/skills/repo-implement/scripts/implement-core.mjs'
import { git, tmp, write, fixture, implementation, backend, run, MAX_REPAIR_ROUNDS, approvedPlan, WRITE, cli, refOf, admitAndBegin, ticketArgs, runReview, confirmedFinding, failed } from './helpers/repo-implement-workflow.mjs'

describe('repo-implement-workflow', { concurrency: 4 }, () => {
test('通し: 計画 → 受け入れ → 実装 → check → 本物の repo-review の計画のファイルで record-review → verify が CLI の記録だけで通る', async (t) => {
  const fx = fixture(t)
  const approved = await approvedPlan(t, fx)
  const args = admitAndBegin(fx, approved)
  const b = backend({
    implementer: () => {
      write(fx.repo, 'src/a.mjs', 'export const a = 2\n')
      write(fx.repo, 'src/a.test.mjs', "import test from 'node:test'\ntest('a は 2 を返す', () => {})\n")
      return implementation(fx)
    },
  }, WRITE)
  const result = await run(t, 'run', args, b)
  assert.equal(result.status, 'ready_for_check', JSON.stringify(result))
  assert.deepEqual(b.calls.map((c) => [c.options.label, c.options.model, c.options.effort]), [['implementer-0', 'opus', 'high']])
  assert.ok(!b.calls[0].prompt.includes('直す確定指摘'))
  const ref = refOf(fx, approved)
  const inv = cli('inventory', { ...ref, implementation: result })
  assert.equal(inv.passed, true, JSON.stringify(inv))
  const checked = cli('run-checks', { ...ref, phase: 'after' })
  assert.equal(checked.passed, true, JSON.stringify(checked))
  const reviewers = [{ id: 'correctness', focus: 'バグ', files: ['src/a.mjs', 'src/a.test.mjs'] }, { id: 'docs', focus: '文書', files: ['src/a.mjs'] }]
  const rp = JSON.parse(reviewMain(['plan'], JSON.stringify({
    repo: fx.repo, mode: 'working_tree', baseRef: fx.state.head, headSha: fx.state.head, policyRef: fx.state.policyRef, preservedPaths: fx.preservedPaths, reviewers, stateDir: tmp(t, 'repo-implement-rr-'),
  })).output)
  assert.equal(rp.ok, true, rp.reason)
  const review = await runReview(t, rp, reviewers)
  assert.equal(review.status, 'completed', JSON.stringify(review.reasons))
  const recorded = cli('record-review', { statePath: fx.statePath, stateSum: fx.stateSum, review, reviewPlanPath: rp.plan_path, reviewPlanSum: rp.plan_sum })
  assert.equal(recorded.ok, true, recorded.reason)
  const verified = cli('verify', ref)
  assert.deepEqual(verified.problems, [])
  assert.equal(verified.passed, true)
  assert.equal(cli('record-review', { statePath: fx.statePath, stateSum: fx.stateSum, review, reviewPlanPath: rp.plan_path, reviewPlanSum: rp.plan_sum }).code, 'E_STATE', '同じ round の 2 回目は記録しない')
  write(fx.repo, 'src/a.mjs', 'export const a = 3\n')
  assert.equal(cli('verify', ref).passed, false, 'レビューの後の書き込みは通さない')
})

test('通し: 正規形でない touched_paths を返した実装でも、inventory が round を閉じて原因を記録する', async (t) => {
  for (const [name, touchedOf] of [['./ 付き', () => './src/a.mjs'], ['絶対パス', (repo) => path.join(repo, 'src/a.mjs')]]) {
    await t.test(name, async (t) => {
      const fx = fixture(t)
      const approved = await approvedPlan(t, fx)
      const args = admitAndBegin(fx, approved)
      const bad = touchedOf(fx.repo)
      const b = backend({ implementer: () => { write(fx.repo, 'src/a.mjs', 'export const a = 2\n'); return implementation(fx, { touched_paths: [bad] }) } }, WRITE)
      const result = await run(t, 'run', args, b)
      assert.equal(result.reason, 'implementation-status-or-scope-mismatch', JSON.stringify(result))
      const inv = cli('inventory', { ...refOf(fx, approved), implementation: result })
      assert.equal(inv.ok, true, inv.reason)
      assert.equal(inv.passed, false)
      const invalid = inv.problems.find((p) => p.cause === 'invalid_touched_path')
      assert.deepEqual(invalid?.paths, [bad])
      const ledger = JSON.parse(readFileSync(fx.state.ledgerPath, 'utf8'))
      assert.equal(ledger.open, null)
      assert.ok(ledger.rounds.at(-1).problems.some((p) => p.cause === 'invalid_touched_path'))
    })
  }
})

test('実装: 書き込みの権限が無い実行面では起動しない', async (t) => {
  const fx = fixture(t)
  const approved = await approvedPlan(t, fx)
  const b = backend({ implementer: () => assert.fail('起動しない') })
  await assert.rejects(run(t, 'run', ticketArgs(fx, approved), b), /workspace-write/)
})

test('実装: implementer の返り値が契約に合わないときは理由つきの status で止まる', async (t) => {
  const cases = [
    { name: '異常: 返らない', impl: () => null, status: 'incomplete', reason: 'implementer-unavailable' },
    // native の agent() は throw し、この runner は null に変える。どちらでも run を落とさず incomplete にする。
    { name: '異常: 構造化出力で失敗した（throw）', impl: () => { throw new Error('schema exhausted') }, status: 'incomplete', reason: /^implementer-(failed|unavailable)$/ },
    { name: '異常: 別の HEAD', impl: (fx) => implementation(fx, { head_sha: 'f'.repeat(40) }), status: 'blocked', reason: 'implementation-head-mismatch' },
    { name: '異常: 果たせなかった作業が残る', impl: (fx) => implementation(fx, { unresolved: ['仕様が無い'] }), status: 'blocked', reason: 'implementation-unresolved' },
    { name: '正常: 範囲内の判断の注記だけなら止まらない', impl: (fx) => implementation(fx, { notes: ['確定指摘に応えるためテスト名を計画の手順から 1 句変えた'] }), status: 'ready_for_check' },
    { name: '異常: 注記と果たせなかった作業の両方があれば止まる', impl: (fx) => implementation(fx, { notes: ['x'], unresolved: ['y'] }), status: 'blocked', reason: 'implementation-unresolved' },
    { name: '異常: 計画の外を書いた', impl: (fx) => implementation(fx, { touched_paths: ['README.md'] }), status: 'blocked', reason: 'implementation-status-or-scope-mismatch' },
    { name: '異常: changed なのに path が無い', impl: (fx) => implementation(fx, { touched_paths: [] }), status: 'blocked', reason: 'implementation-status-or-scope-mismatch' },
    { name: '異常: 承認済みの計画に implementer だけが変更不要と返す', impl: (fx) => implementation(fx, { status: 'no_change', touched_paths: [], case_tests: [] }), status: 'blocked', reason: 'no-change-against-approved-plan' },
    { name: '異常: 自動テストのケースにテストが無い', impl: (fx) => implementation(fx, { case_tests: [] }), status: 'incomplete', reason: 'case-tests-incomplete', gap: ['missing', ['T1']] },
    { name: '異常: 計画に無いケースのテスト', impl: (fx) => implementation(fx, { case_tests: [...implementation(fx).case_tests, { case_id: 'T9', tests: [{ path: 'src/a.test.mjs', name: 'x' }] }] }), status: 'incomplete', reason: 'case-tests-incomplete', gap: ['unknown', ['T9']] },
    { name: '異常: ケースの無いテスト', impl: (fx) => implementation(fx, { tests_without_case: [{ path: 'src/a.test.mjs', name: 'extra' }] }), status: 'incomplete', reason: 'case-tests-incomplete' },
    { name: '境界: review の層のケースはテストの所在を求めない', impl: (fx) => implementation(fx), status: 'ready_for_check' },
  ]
  for (const c of cases) {
    await t.test(c.name, async (t) => {
      const fx = fixture(t)
      const approved = await approvedPlan(t, fx)
      const args = ticketArgs(fx, approved)
      const result = await run(t, 'run', args, backend({ implementer: () => c.impl(fx) }, WRITE))
      assert.equal(result.status, c.status, JSON.stringify(result))
      if (c.reason instanceof RegExp) assert.match(result.reason, c.reason)
      else if (c.reason) assert.equal(result.reason, c.reason)
      if (c.gap) assert.deepEqual(result.caseTestGaps[c.gap[0]], c.gap[1])
      const { sum, ...rest } = result
      assert.equal(sum, fnvSum(rest), 'どの status でも CLI が受け取れる sum を持つ')
      assert.equal(result.ticket_sum, args.ticketSum)
    })
  }
})

test('修正: 券の入力（確定指摘・check の失敗）だけを implementer に渡し、MAX_REPAIR_ROUNDS を超える券では起動しない', async (t) => {
  const cases = [
    { name: '正常: 確定指摘を直す', patch: { round: 1, repair: 'review', findings: [confirmedFinding()] }, status: 'ready_for_check', prompt: /直す確定指摘/ },
    { name: '正常: 変更起因の check の失敗を直す', patch: { round: 1, repair: 'checks', checkFailures: [failed] }, status: 'ready_for_check', prompt: /boom/ },
    { name: '境界: 上限ちょうどの回', patch: { round: MAX_REPAIR_ROUNDS, repair: 'review', findings: [confirmedFinding()] }, status: 'ready_for_check' },
    { name: '境界: 上限 + 1 の回は backstop で止まる', patch: { round: MAX_REPAIR_ROUNDS + 1, repair: 'review', findings: [confirmedFinding()] }, status: 'repair_limit_reached', launched: false },
  ]
  for (const c of cases) {
    await t.test(c.name, async (t) => {
      const fx = fixture(t)
      const approved = await approvedPlan(t, fx)
      const b = backend({ implementer: () => implementation(fx) }, WRITE)
      const result = await run(t, 'run', ticketArgs(fx, approved, c.patch), b)
      assert.equal(result.status, c.status, JSON.stringify(result))
      if (c.prompt) assert.match(b.calls[0].prompt, c.prompt)
      assert.equal(b.calls.length, c.launched === false ? 0 : 1)
      assert.equal(result.repairRound, c.patch.round)
    })
  }
  const rejected = [
    ['異常: 券を書き換えた', (fx, a) => ({ ...ticketArgs(fx, a), ticketSum: '00000000' })],
    ['異常: 別の plan の券', (fx, a) => ticketArgs(fx, a, { plan_sum: '00000000' })],
    ['異常: 別の state の券', (fx, a) => ticketArgs(fx, a, { state_sum: '00000000' })],
    ['異常: 計画を書き換えた', (fx, a) => ({ ...ticketArgs(fx, a), planSum: '00000000' })],
    ['異常: 負の round', (fx, a) => ticketArgs(fx, a, { round: -1 })],
  ]
  for (const [name, mk] of rejected) {
    await t.test(name, async (t) => {
      const fx = fixture(t)
      const approved = await approvedPlan(t, fx)
      const b = backend({ implementer: () => assert.fail('起動しない') }, WRITE)
      await assert.rejects(run(t, 'run', mk(fx, approved), b))
      assert.equal(b.calls.length, 0)
    })
  }
  const unapproved = [
    ['異常: status が approved でない', { status: 'blocked' }],
    ['異常: 別の policyRef の計画', { policy_ref: 'f'.repeat(40) }],
    ['異常: 別の HEAD で立てた計画', { head_sha: 'f'.repeat(40) }],
    ['異常: 別の state の計画', { state_sum: '00000000' }],
    ['異常: plan-reviewer が承認していない', (p) => ({ plan_review: { ...p.plan_review, approved: false } })],
    ['異常: plan-reviewer が別の HEAD を見た', (p) => ({ plan_review: { ...p.plan_review, head_sha: 'f'.repeat(40) } })],
  ]
  for (const [name, patch] of unapproved) {
    await t.test(name, async (t) => {
      const fx = fixture(t)
      const approved = await approvedPlan(t, fx)
      const plan = { ...approved.plan, ...(typeof patch === 'function' ? patch(approved.plan) : patch) }
      const forged = { plan, plan_sum: fnvSum(plan) }
      await assert.rejects(run(t, 'run', ticketArgs(fx, forged), backend({ implementer: () => assert.fail('起動しない') }, WRITE)), /承認済み/)
    })
  }
})

test('変更の集合の定義は repo-review と同じ: start が preserved にする path を repo-review の working_tree が受け入れ、扱えない状態は start が拒否する', async (t) => {
  const make = (t) => {
    const repo = tmp(t, 'repo-implement-set-')
    git(repo, 'init', '-q', '-b', 'main')
    git(repo, 'config', 'commit.gpgsign', 'false')
    write(repo, '.github/workflows/claude_review.yml', `jobs:\n  review:\n    with:\n      exclude-paths: '["**/*.lock"]'\n`)
    for (const f of ['m.md', 's.md', 'd.md', 'k.md']) write(repo, f, `${f}\n`)
    git(repo, 'add', '-A')
    git(repo, 'commit', '-q', '-m', 'base')
    git(repo, 'update-ref', 'refs/remotes/origin/main', 'main')
    git(repo, 'checkout', '-q', '-b', 'work')
    return repo
  }
  const inventory = (repo, started) => JSON.parse(reviewMain(['inventory'], JSON.stringify({
    repo, mode: 'working_tree', baseRef: started.state.head, headSha: started.state.head, policyRef: started.state.policyRef, preservedPaths: started.preservedPaths,
  })).output)
  await t.test('正常: unstaged・staged・untracked・削除', (t) => {
    const repo = make(t)
    write(repo, 'm.md', 'edited\n')
    write(repo, 's.md', 'staged\n')
    git(repo, 'add', 's.md')
    write(repo, 'new/u.md', 'u\n')
    rmSync(path.join(repo, 'd.md'))
    const started = JSON.parse(main(['start'], JSON.stringify({ repo, stateDir: tmp(t, 'repo-implement-set-state-') })).output)
    assert.equal(started.ok, true, started.reason)
    const out = inventory(repo, started)
    assert.deepEqual(out.pin_problems, [])
    assert.deepEqual(out.inventory.preserved, started.preservedPaths)
    assert.deepEqual(out.inventory.reviewable, [])
  })
  for (const [name, setup] of [
    ['異常: 未追跡の入れ子の repo', (repo) => { mkdirSync(path.join(repo, 'nested')); git(path.join(repo, 'nested'), 'init', '-q'); write(repo, 'nested/x', 'x\n') }],
    ['異常: index だけが HEAD と違う path', (repo) => { write(repo, 'k.md', 'staged\n'); git(repo, 'add', 'k.md'); write(repo, 'k.md', 'k.md\n') }],
  ]) {
    await t.test(name, (t) => {
      const repo = make(t)
      setup(repo)
      const started = JSON.parse(main(['start'], JSON.stringify({ repo, stateDir: tmp(t, 'repo-implement-set-state-') })).output)
      assert.equal(started.code, 'E_PIN', started.reason)
    })
  }
})

test('変更の集合は、さまざまな作業ツリーの状態で repo-review の working_tree の集合と一致する', (t) => {
  const repo = tmp(t, 'repo-implement-cs-')
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'commit.gpgsign', 'false')
  write(repo, '.github/workflows/claude_review.yml', `jobs:\n  review:\n    with:\n      exclude-paths: '["**/*.lock"]'\n`)
  write(repo, '.gitignore', 'ignored/\n')
  for (const f of ['m.md', 's.md', 'd.md', 'k.md', 'r.md', 'sp ace.md']) write(repo, f, `${f}\n`)
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'base')
  const head = git(repo, 'rev-parse', 'HEAD')
  const states = [
    () => {},
    () => write(repo, 'm.md', 'edited\n'),
    () => { write(repo, 's.md', 'staged\n'); git(repo, 'add', 's.md') },
    () => { write(repo, 'k.md', 'staged\n'); git(repo, 'add', 'k.md'); write(repo, 'k.md', 'k.md\n') },
    () => rmSync(path.join(repo, 'd.md')),
    () => { git(repo, 'mv', 'r.md', 'renamed.md') },
    () => write(repo, 'new/dir/u.md', 'u\n'),
    () => write(repo, 'ignored/x.md', 'x\n'),
    () => write(repo, 'sp ace.md', 'edited\n'),
    () => { mkdirSync(path.join(repo, 'nested')); git(path.join(repo, 'nested'), 'init', '-q'); write(repo, 'nested/x', 'x\n') },
  ]
  for (const apply of states) {
    apply()
    const ours = changeSet(defaultIo(), repo)
    const theirs = collectState({ repo, mode: 'working_tree', baseRef: head, headSha: head, policyRef: head }, reviewIo()).paths
    assert.deepEqual(ours, theirs)
  }
})
})
