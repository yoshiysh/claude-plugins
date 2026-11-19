// repo-implement の Workflow の結合のうち、計画の Workflow・schema・Workflow source と SKILL.md の静的な照合。ファイルを分けて並列に走らせ、共有の道具は helpers/repo-implement-workflow.mjs に置く。
import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { Workflow } from '../plugins/workflow/skills/dynamic-workflow-runner/scripts/runtime/runtime.mjs'
import { categories } from '../scripts/traceability/specs.mjs'
import { main } from '../.agents/skills/repo-implement/scripts/implement-cli.mjs'
import { main as reviewMain } from '../.agents/skills/repo-review/scripts/review-cli.mjs'
import { MAKE_TARGETS, canonical, checkPolicy, fnvSum, isRepoRelativePath } from '../.agents/skills/repo-implement/scripts/implement-core.mjs'
import { bodyLiteral } from './helpers/workflow-source.mjs'
import { ROOT, SKILL_DIR, PLAN_NAME, RUN_NAME, PLAN_SOURCE, RUN_SOURCE, TEXT, META, git, tmp, write, fixture, vp, TEST_PLAN, draft, planReview, implementation, backend, run, planArgs, MAX_PLAN_REVISIONS, approvedPlan, WRITE, ticketArgs, failed, declarations } from './helpers/repo-implement-workflow.mjs'

describe('repo-implement-workflow', { concurrency: 4 }, () => {
test('計画: planner と plan-reviewer が通した計画を、必須 check を足し sum をつけて approved で返す', async (t) => {
  const fx = fixture(t)
  const b = backend({ planner: () => draft(fx), planReviewer: () => planReview(fx) })
  const result = await run(t, 'plan', planArgs(fx), b)
  assert.equal(result.status, 'approved')
  assert.deepEqual(result.plan.checks, [{ kind: 'make', value: 'test' }, { kind: 'node-test', value: 'src/a.test.mjs' }])
  assert.equal(result.plan_sum, fnvSum(result.plan))
  assert.equal(result.plan.state_sum, fx.stateSum)
  assert.equal(result.plan.request, 'src/a.mjs の a を 2 にして')
  assert.deepEqual(b.calls.map((c) => c.options.label), ['planner-0', 'planReviewer-0'])
  for (const c of b.calls) assert.deepEqual([c.options.model, c.options.effort], ['opus', 'high'], c.options.label)
  const prefix = (c) => c.prompt.slice(0, c.prompt.indexOf('--- この役の担当 ---'))
  assert.ok(prefix(b.calls[0]).length > 0)
  for (const [kind, rule] of Object.entries(checkPolicy().kinds)) assert.ok(b.calls[0].prompt.includes(`${kind} は ${rule}`), kind)
  assert.ok(!b.calls[0].prompt.includes('\\"'), 'check の書式の説明が二重にエスケープされている')
  assert.equal(prefix(b.calls[0]), prefix(b.calls[1]), '共通部分は prompt の先頭にそろう')
  assert.ok(b.calls[1].prompt.includes('"checks"'), 'plan-reviewer は script が足した check も含めて照らす')
})

test('計画: 計画が使えないときは理由つきの status で止まり、plan-reviewer を起動しない', async (t) => {
  const cases = [
    { name: '異常: planner が返らない', planner: () => null, status: 'incomplete', reason: 'planner-unavailable' },
    { name: '異常: planner が別の HEAD を見た', planner: (fx) => draft(fx, { head_sha: 'f'.repeat(40) }), status: 'incomplete', reason: 'planner-head-mismatch' },
    { name: '準正常: 人の判断が要る', planner: (fx) => draft(fx, { human_decision_required: true, questions: ['互換を保つか'] }), status: 'needs_human_decision' },
    { name: '異常: preserved と重なる', planner: (fx) => draft(fx, { affected_paths: ['keep.md', 'src/a.test.mjs'] }), status: 'needs_isolated_worktree' },
  ]
  for (const c of cases) {
    await t.test(c.name, async (t) => {
      const fx = fixture(t)
      const b = backend({ planner: () => c.planner(fx), planReviewer: () => assert.fail('起動しない') })
      const result = await run(t, 'plan', planArgs(fx), b)
      assert.equal(result.status, c.status)
      if (c.reason) assert.equal(result.reason, c.reason)
      assert.equal(b.calls.length, 1, '止まる理由は計画し直しで直らないので planner に戻さない')
    })
  }
})

test('計画: script の形の検査に落ちた計画は理由を添えて planner に戻し、MAX_PLAN_REVISIONS を超えたら止まる', async (t) => {
  const cond = (patch) => ({ ...TEST_PLAN.conditions[0], ...patch })
  const cases = [
    { name: '異常: 観点がケースも不適用の理由も持たない', patch: { test_plan: { ...TEST_PLAN, conditions: [cond({ viewpoints: { ...TEST_PLAN.conditions[0].viewpoints, recovery: vp([]) } })] } }, match: /recovery はケースか不適用の理由のどちらか一方/ },
    { name: '異常: 観点がケースと不適用の理由の両方を持つ', patch: { test_plan: { ...TEST_PLAN, conditions: [cond({ viewpoints: { ...TEST_PLAN.conditions[0].viewpoints, error: vp(['T2'], 'x') } })] } }, match: /error はケースか/ },
    { name: '異常: ケースの無い条件に未カバーの理由が無い', patch: { test_plan: { ...TEST_PLAN, cases: [], conditions: [cond({ viewpoints: Object.fromEntries(categories.map((v) => [v, vp([], '無い')])) })] } }, match: /未カバーの理由が無い/ },
    { name: '異常: 未カバーの条件がケースを持つ', patch: { test_plan: { ...TEST_PLAN, conditions: [cond({ uncovered_reason: '測れない' })] } }, match: /未カバーの条件 C1 がケースを持つ/ },
    { name: '異常: 無いケースを指す', patch: { test_plan: { ...TEST_PLAN, cases: [TEST_PLAN.cases[0]] } }, match: /無いケース T2/ },
    { name: '異常: どの条件にも結び付かないケース', patch: { test_plan: { ...TEST_PLAN, cases: [...TEST_PLAN.cases, { ...TEST_PLAN.cases[0], id: 'T9' }] } }, match: /T9 がどの条件にも結び付かない/ },
    { name: '異常: ケースの重複', patch: { test_plan: { ...TEST_PLAN, cases: [...TEST_PLAN.cases, TEST_PLAN.cases[0]] } }, match: /T1 が重複/ },
    { name: '境界: 変更があるのに条件が 0 件', patch: { test_plan: { conditions: [], cases: [] } }, match: /条件が 1 つも無い/ },
    { name: '異常: 変更不要なのに path がある', patch: { no_change: true, no_change_reason: 'x' }, match: /変更不要の計画は/ },
    { name: '異常: path が正規形でない', patch: { affected_paths: ['../a.mjs'] }, match: /正規形でない/ },
  ]
  for (const c of cases) {
    await t.test(c.name, async (t) => {
      const fx = fixture(t)
      const b = backend({ planner: () => draft(fx, c.patch), planReviewer: () => assert.fail('起動しない') })
      const result = await run(t, 'plan', planArgs(fx), b)
      assert.deepEqual([result.status, result.reason, result.revisions_exhausted], ['incomplete', 'invalid-plan', true])
      assert.match(result.problems.join('\n'), c.match)
      assert.equal(b.calls.length, 1 + MAX_PLAN_REVISIONS)
      assert.match(b.calls[1].prompt, /通らなかった理由/, '2 回目の planner に理由を渡す')
    })
  }
  for (const [name, patch] of [
    ['準正常: 判断が要ると言うのに質問が無い', { human_decision_required: true }],
    ['準正常: 判断は要らないのに確認の質問がある', { questions: ['この理解で合っているか'] }],
  ]) {
    await t.test(name, async (t) => {
      const fx = fixture(t)
      const b = backend({ planner: (_, n) => (n === 0 ? draft(fx, patch) : draft(fx)), planReviewer: () => planReview(fx) })
      const result = await run(t, 'plan', planArgs(fx), b)
      assert.deepEqual([result.status, result.attempt], ['approved', 1], '人を待たせずに planner に戻す')
      assert.match(b.calls[1].prompt, /human_decision_required が true のときだけ/)
    })
  }
  await t.test('準正常: 理由を受けて直した計画は通る', async (t) => {
    const fx = fixture(t)
    const b = backend({ planner: (_, n) => (n === 0 ? draft(fx, { test_plan: { conditions: [], cases: [] } }) : draft(fx)), planReviewer: () => planReview(fx) })
    const result = await run(t, 'plan', planArgs(fx), b)
    assert.deepEqual([result.status, result.attempt], ['approved', 1])
  })
  await t.test('正常: 未カバーを理由つきで明示した条件は受け入れる', async (t) => {
    const fx = fixture(t)
    const tp = { conditions: [...TEST_PLAN.conditions, { ...cond({ id: 'C2', uncovered_reason: '実機でしか確かめられない' }), viewpoints: Object.fromEntries(categories.map((v) => [v, vp([])])) }], cases: TEST_PLAN.cases }
    const result = await run(t, 'plan', planArgs(fx), backend({ planner: () => draft(fx, { test_plan: tp }), planReviewer: () => planReview(fx) }))
    assert.equal(result.status, 'approved')
  })
  await t.test('境界: 変更不要の計画は条件 0 件でよく、必須 check も足さない', async (t) => {
    const fx = fixture(t)
    const result = await run(t, 'plan', planArgs(fx), backend({
      planner: () => draft(fx, { no_change: true, no_change_reason: 'src/a.mjs:1 が既に満たす', affected_paths: [], additional_checks: [], test_plan: { conditions: [], cases: [] } }),
      planReviewer: () => planReview(fx),
    }))
    assert.equal(result.status, 'no_change')
    assert.deepEqual(result.plan.checks, [])
  })
})

test('計画: plan-reviewer が通さない計画は指摘を添えて planner に戻し、根拠の欠けと人の判断は戻さず止まる', async (t) => {
  const gaps = (key) => ({ test_plan_review: { missing_conditions: [], unexamined_viewpoints: [], implementation_derived_expectations: [], [key]: ['x'] } })
  const sendBack = [
    ['異常: 承認しない', { approved: false, issues: ['caller を見落とした'] }],
    ['異常: 条件の取りこぼし', gaps('missing_conditions')],
    ['異常: 観点の未検討', gaps('unexamined_viewpoints')],
    ['異常: 期待値が実装由来', gaps('implementation_derived_expectations')],
  ]
  for (const [name, patch] of sendBack) {
    await t.test(name, async (t) => {
      const fx = fixture(t)
      const b = backend({ planner: () => draft(fx), planReviewer: () => planReview(fx, patch) })
      const result = await run(t, 'plan', planArgs(fx), b)
      assert.deepEqual([result.status, result.revisions_exhausted], ['blocked', true])
      assert.equal(b.calls.filter((c) => c.role === 'planner').length, 1 + MAX_PLAN_REVISIONS)
      assert.match(b.calls[2].prompt, /通らなかった理由/)
    })
  }
  await t.test('準正常: 指摘を受けて直した計画を 2 回目に承認する', async (t) => {
    const fx = fixture(t)
    const b = backend({ planner: () => draft(fx), planReviewer: (_, n) => planReview(fx, n === 0 ? { approved: false, issues: ['x'] } : {}) })
    const result = await run(t, 'plan', planArgs(fx), b)
    assert.deepEqual([result.status, result.attempt], ['approved', 1])
    assert.deepEqual(b.calls.map((c) => c.options.label), ['planner-0', 'planReviewer-0', 'planner-1', 'planReviewer-1'])
  })
  const stop = [
    ['異常: 根拠が無い', { evidence: [] }, 'incomplete', 'plan-review-evidence-incomplete'],
    ['異常: 読んでいない path を根拠にする', { evidence: [{ path: 'other.md', line: 1, claim: 'x' }] }, 'incomplete', 'plan-review-evidence-incomplete'],
    ['異常: 別の HEAD', { head_sha: 'f'.repeat(40) }, 'incomplete', 'plan-review-head-mismatch'],
    ['準正常: 人の判断が要る', { human_decisions: ['公開の契約を変えるか'] }, 'needs_human_decision', undefined],
  ]
  for (const [name, patch, status, reason] of stop) {
    await t.test(name, async (t) => {
      const fx = fixture(t)
      const b = backend({ planner: () => draft(fx), planReviewer: () => planReview(fx, patch) })
      const result = await run(t, 'plan', planArgs(fx), b)
      assert.equal(result.status, status)
      if (reason) assert.equal(result.reason, reason)
      assert.equal(b.calls.length, 2)
    })
  }
})

test('schema に合わない返り値は採用せず、後の役を起動しない', async (t) => {
  const cases = [
    { name: '異常: planner の返り値に test_plan が無い', handlers: (fx) => { const { test_plan, ...d } = draft(fx); return { planner: () => d, planReviewer: () => assert.fail('起動しない') } }, reason: 'planner-unavailable' },
    { name: '異常: planner の check に余分なキー', handlers: (fx) => ({ planner: () => draft(fx, { additional_checks: [{ kind: 'make', value: 'test', args: '-j' }] }), planReviewer: () => assert.fail('起動しない') }), reason: 'planner-unavailable' },
    { name: '異常: planner の観点が 1 つ欠ける', handlers: (fx) => { const { boundary, ...v } = TEST_PLAN.conditions[0].viewpoints; return { planner: () => draft(fx, { test_plan: { ...TEST_PLAN, conditions: [{ ...TEST_PLAN.conditions[0], viewpoints: v }] } }), planReviewer: () => assert.fail('起動しない') } }, reason: 'planner-unavailable' },
    { name: '異常: plan-reviewer の返り値に test_plan_review が無い', handlers: (fx) => { const { test_plan_review, ...r } = planReview(fx); return { planner: () => draft(fx), planReviewer: () => r } }, reason: 'plan-review-unavailable' },
  ]
  for (const c of cases) {
    await t.test(c.name, async (t) => {
      const fx = fixture(t)
      const result = await run(t, 'plan', planArgs(fx), backend(c.handlers(fx)))
      assert.equal(result.status, 'incomplete')
      assert.equal(result.reason, c.reason)
    })
  }
  await t.test('異常: implementer の返り値に余分なキー', async (t) => {
    const fx = fixture(t)
    const approved = await approvedPlan(t, fx)
    const result = await run(t, 'run', ticketArgs(fx, approved), backend({ implementer: () => ({ ...implementation(fx), note: 'x' }) }, WRITE))
    assert.equal(result.status, 'incomplete')
    assert.match(result.reason, /^implementer-(failed|unavailable)$/)
  })
})

test('計画: state の写し間違いは agent を起動する前に拒否する', async (t) => {
  const fx = fixture(t)
  const b = backend({})
  for (const bad of [planArgs(fx, { stateSum: '00000000' }), planArgs(fx, { skillDir: 'relative' }), planArgs(fx, { request: ' ' })]) {
    await assert.rejects(run(t, 'plan', bad, b))
  }
  assert.equal(b.calls.length, 0)
})

test('許可リストの make の target は Makefile の .PHONY にある', () => {
  const makefile = readFileSync(path.join(ROOT, 'Makefile'), 'utf8')
  const phony = /^\.PHONY:(.*)$/m.exec(makefile)[1].trim().split(/\s+/)
  for (const target of MAKE_TARGETS) assert.ok(phony.includes(target), target)
})

test('SKILL.md が repo-review に渡す値（baseRef・headSha は開始時の HEAD、policyRef は主ブランチ、preservedPaths）を repo-review の CLI が受け入れ、変更だけを対象にする', (t) => {
  const repo = tmp(t, 'repo-implement-rr-')
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'commit.gpgsign', 'false')
  write(repo, '.github/workflows/claude_review.yml', `jobs:\n  review:\n    with:\n      exclude-paths: '["**/*.lock"]'\n`)
  write(repo, 'src/a.mjs', '1\n')
  write(repo, 'keep.md', 'k\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'base')
  git(repo, 'update-ref', 'refs/remotes/origin/main', 'main')
  git(repo, 'checkout', '-q', '-b', 'work')
  write(repo, 'src/b.mjs', 'b\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'ahead of main')
  write(repo, 'keep.md', 'mine\n')
  const started = JSON.parse(main(['start'], JSON.stringify({ repo, stateDir: tmp(t, 'repo-implement-rr-state-') })).output)
  assert.equal(started.ok, true, started.reason)
  assert.notEqual(started.state.head, started.state.policyRef, '主ブランチより先の commit を持つ branch で確かめる')
  write(repo, 'src/a.mjs', '2\n')
  const out = JSON.parse(reviewMain(['inventory'], JSON.stringify({
    repo, mode: 'working_tree', baseRef: started.state.head, headSha: started.state.head, policyRef: started.state.policyRef, preservedPaths: started.preservedPaths,
  })).output)
  assert.equal(out.ok, true, out.reason)
  assert.deepEqual(out.pin_problems, [])
  assert.deepEqual(out.inventory.reviewable, ['src/a.mjs'])
  assert.deepEqual(out.inventory.preserved, ['keep.md'])
})

test('Workflow source の写し（canonical・fnvSum・isRepoRelativePath）は CLI の部品と一致する', () => {
  for (const text of [TEXT.plan, TEXT.run]) {
    const d = declarations(text)
    assert.equal(d.get('canonical'), canonical.toString())
    assert.equal(d.get('fnvSum'), fnvSum.toString())
    assert.equal(d.get('isRepoRelativePath'), isRepoRelativePath.toString())
  }
})

test('観点のキーは traceability の分類と一致する', () => {
  assert.deepEqual(Object.keys(bodyLiteral(TEXT.plan, 'VIEWPOINT_LABELS')), categories)
})

test('実装の Workflow がテストの所在を求めない層は、計画の Workflow の層のキーにある', () => {
  assert.ok(Object.keys(bodyLiteral(TEXT.plan, 'LAYER_LABELS')).includes(bodyLiteral(TEXT.run, 'REVIEW_LAYER')))
})

test('meta.limits は本体の役の数・計画し直しの上限・agentTimeoutMs から決まり、全ての役が model と effort を明示する', () => {
  const planRoles = Object.keys(bodyLiteral(TEXT.plan, 'ROLE_MODELS')).length
  assert.equal(META.plan.limits.maxAgents, planRoles * (1 + MAX_PLAN_REVISIONS))
  assert.equal(META.run.limits.maxAgents, Object.keys(bodyLiteral(TEXT.run, 'ROLE_MODELS')).length)
  for (const kind of ['plan', 'run']) {
    const limits = META[kind].limits
    assert.equal(limits.timeoutMs, limits.maxAgents * limits.agentTimeoutMs, kind)
    for (const [role, opts] of Object.entries(bodyLiteral(TEXT[kind], 'ROLE_MODELS'))) {
      assert.equal(typeof opts.model, 'string', `${kind}:${role}`)
      assert.equal(typeof opts.effort, 'string', `${kind}:${role}`)
    }
  }
  assert.deepEqual(META.plan.requirements, ['read-only', 'fresh-thread'])
  assert.ok(META.run.requirements.includes('workspace-write'))
})

test('初めての公開の操作が 2 つの Workflow script を移せる（SKILL.md の callsite 以外に移動前のパスが無い）', () => {
  const code = [
    'import json, sys',
    'from pathlib import Path',
    'sys.path.insert(0, sys.argv[1])',
    'import register_plugin as r',
    "print(json.dumps(r.inspect_workflow_scripts(Path(sys.argv[2]), 'repo-implement', set(), set(), set())))",
  ].join('\n')
  const out = spawnSync('python3', ['-I', '-c', code, path.join(ROOT, '.agents', 'skills', 'manage-marketplace-plugin', 'scripts'), SKILL_DIR], { encoding: 'utf8' })
  assert.equal(out.status, 0, out.stderr)
  const found = JSON.parse(out.stdout)
  const unpublished = [PLAN_SOURCE, RUN_SOURCE].filter((s) => s.startsWith(path.join(SKILL_DIR, 'scripts')))
  assert.equal(found.length, unpublished.length)
  for (const f of found) assert.deepEqual(f.reasons, [], f.file)
  if (unpublished.length === 0) {
    const skill = readFileSync(path.join(SKILL_DIR, 'SKILL.md'), 'utf8')
    for (const name of [PLAN_NAME, RUN_NAME]) assert.match(skill, new RegExp(`name: "[a-z][a-z0-9-]*:${name}"`))
  }
})
})
