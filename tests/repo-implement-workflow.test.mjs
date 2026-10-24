import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Workflow } from '../plugins/workflow/skills/dynamic-workflow-runner/scripts/runtime/runtime.mjs'
import { readSourceMetadata } from '../plugins/workflow/skills/dynamic-workflow-runner/scripts/runtime/source.mjs'
import { categories } from '../scripts/traceability/specs.mjs'
import { main } from '../.agents/skills/repo-implement/scripts/implement-cli.mjs'
import { main as reviewMain } from '../.agents/skills/repo-review/scripts/review-cli.mjs'
import { canonical, fnvSum, isRepoRelativePath } from '../.agents/skills/repo-implement/scripts/implement-core.mjs'
import { bodyLiteral } from './helpers/workflow-source.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SKILL_DIR = realpathSync(path.join(ROOT, '.agents', 'skills', 'repo-implement'))
const PLAN_NAME = 'repo-implement-plan'
const RUN_NAME = 'repo-implement-run'
const acorn = createRequire(path.join(ROOT, 'plugins', 'workflow', 'skills', 'dynamic-workflow-runner', 'scripts', 'runtime', 'package.json'))('acorn')
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com',
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
}

// 公開の前は skill の scripts/、公開の後は plugin の workflows/ にある。どちらでも meta.name で 1 本に決める。
function sourceNamed(name) {
  const dirs = [path.join(SKILL_DIR, 'scripts'), ...readdirSync(path.join(ROOT, 'plugins')).map((p) => path.join(ROOT, 'plugins', p, 'workflows'))]
  const hits = dirs.filter((d) => existsSync(d)).flatMap((d) => readdirSync(d).filter((f) => f.endsWith('.js')).map((f) => path.join(d, f)))
    .filter((f) => {
      try {
        return readSourceMetadata(readFileSync(f, 'utf8')).name === name
      } catch {
        return false
      }
    })
  assert.equal(hits.length, 1, `meta.name ${name} の source がちょうど 1 本ない: ${hits}`)
  return hits[0]
}
const PLAN_SOURCE = sourceNamed(PLAN_NAME)
const RUN_SOURCE = sourceNamed(RUN_NAME)
const TEXT = { plan: readFileSync(PLAN_SOURCE, 'utf8'), run: readFileSync(RUN_SOURCE, 'utf8') }
const META = { plan: readSourceMetadata(TEXT.plan), run: readSourceMetadata(TEXT.run) }

function git(repo, ...args) {
  return execFileSync('git', ['-C', repo, ...args], { env: GIT_ENV }).toString('utf8').trim()
}

function tmp(t, prefix) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function write(repo, file, text) {
  mkdirSync(path.dirname(path.join(repo, file)), { recursive: true })
  writeFileSync(path.join(repo, file), text)
}

function fixture(t) {
  const repo = tmp(t, 'repo-implement-wf-')
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'commit.gpgsign', 'false')
  write(repo, 'Makefile', 'test:\n\t@echo ok\n')
  write(repo, 'src/a.mjs', 'export const a = 1\n')
  write(repo, 'keep.md', 'keep\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'base')
  git(repo, 'checkout', '-q', '-b', 'work')
  write(repo, 'keep.md', 'mine\n')
  const out = JSON.parse(main(['start'], JSON.stringify({ repo, stateDir: tmp(t, 'repo-implement-wf-state-'), policyRef: 'main' })).output)
  assert.equal(out.ok, true, out.reason)
  return { repo, state: out.state, stateSum: out.state_sum, statePath: out.state_path }
}

const vp = (ids, reason = '') => ({ case_ids: ids, not_applicable_reason: reason })
const TEST_PLAN = {
  conditions: [{
    id: 'C1', statement: 'a は 2 を返す', source: '依頼', uncovered_reason: '',
    viewpoints: { normal: vp(['T1']), recovery: vp([], '再試行の経路を持たない'), error: vp(['T2']), boundary: vp(['T1']) },
  }],
  cases: [
    { id: 'T1', layer: 'unit', input: '既定', expected: '2', expected_basis: '依頼', parameterized_group: 'a-values', spec_ids: [] },
    { id: 'T2', layer: 'review', input: '文書', expected: '記述が一致', expected_basis: '依頼', parameterized_group: '', spec_ids: [] },
  ],
}

function draft(fx, patch = {}) {
  return {
    head_sha: fx.state.head, summary: 'a を 2 にする', no_change: false, no_change_reason: '',
    affected_paths: ['src/a.mjs', 'src/a.test.mjs'], invariants: ['export 名を変えない'], implementation_steps: ['a を 2 にする'],
    additional_checks: [{ kind: 'node-test', value: 'src/a.test.mjs' }], human_decision_required: false, questions: [], test_plan: TEST_PLAN,
    ...patch,
  }
}

function planReview(fx, patch = {}) {
  return {
    head_sha: fx.state.head, approved: true, issues: [], human_decisions: [],
    test_plan_review: { missing_conditions: [], unexamined_viewpoints: [], implementation_derived_expectations: [] },
    checked_paths: ['src/a.mjs'], evidence: [{ path: 'src/a.mjs', line: 1, claim: 'a は 1 を返す' }],
    ...patch,
  }
}

function implementation(fx, patch = {}) {
  return {
    head_sha: fx.state.head, status: 'changed', summary: '直した', touched_paths: ['src/a.mjs', 'src/a.test.mjs'],
    case_tests: [{ case_id: 'T1', tests: [{ path: 'src/a.test.mjs', name: 'a は 2 を返す' }] }], tests_without_case: [], unresolved: [],
    ...patch,
  }
}

function backend(handlers, capabilities = ['read-only', 'fresh-thread']) {
  const calls = []
  return {
    calls,
    capabilities,
    async run(prompt, options) {
      calls.push({ prompt, options })
      const handler = handlers[options.label] ?? handlers[options.label.replace(/-\d+$/, '')]
      if (!handler) throw new Error(`unexpected label ${options.label}`)
      return handler(prompt)
    },
  }
}

async function run(t, kind, args, b) {
  const runRoot = tmp(t, `repo-implement-${kind}-run-`)
  return Workflow({ scriptPath: kind === 'plan' ? PLAN_SOURCE : RUN_SOURCE, args }, { backend: b, runDir: path.join(runRoot, 'run'), trustedSource: true, ...META[kind].limits })
}

const planArgs = (fx, extra = {}) => ({ skillDir: SKILL_DIR, request: 'src/a.mjs の a を 2 にして', state: fx.state, stateSum: fx.stateSum, ...extra })

async function approvedPlan(t, fx) {
  const result = await run(t, 'plan', planArgs(fx), backend({ planner: () => draft(fx), planReviewer: () => planReview(fx) }))
  assert.equal(result.status, 'approved', JSON.stringify(result))
  return result
}

const WRITE = ['read-only', 'fresh-thread', 'workspace-write']
const runArgs = (fx, approved, extra = {}) => ({ skillDir: SKILL_DIR, state: fx.state, stateSum: fx.stateSum, plan: approved.plan, planSum: approved.plan_sum, ...extra })

test('計画: planner と plan-reviewer が通した計画を、必須 check を足し sum をつけて approved で返す', async (t) => {
  const fx = fixture(t)
  const b = backend({ planner: () => draft(fx), planReviewer: () => planReview(fx) })
  const result = await run(t, 'plan', planArgs(fx), b)
  assert.equal(result.status, 'approved')
  assert.deepEqual(result.plan.checks, [{ kind: 'make', value: 'test' }, { kind: 'node-test', value: 'src/a.test.mjs' }])
  assert.equal(result.plan_sum, fnvSum(result.plan))
  assert.equal(result.plan.state_sum, fx.stateSum)
  assert.equal(result.plan.request, 'src/a.mjs の a を 2 にして')
  assert.deepEqual(b.calls.map((c) => c.options.label), ['planner', 'planReviewer'])
  for (const c of b.calls) assert.deepEqual([c.options.model, c.options.effort], ['opus', 'high'], c.options.label)
  const prefix = (c) => c.prompt.slice(0, c.prompt.indexOf('--- この役の担当 ---'))
  assert.ok(prefix(b.calls[0]).length > 0)
  assert.equal(prefix(b.calls[0]), prefix(b.calls[1]), '共通部分は prompt の先頭にそろう')
  assert.ok(b.calls[1].prompt.includes('"checks"'), 'plan-reviewer は script が足した check も含めて照らす')
})

test('計画: 計画が使えないときは理由つきの status で止まり、plan-reviewer を起動しない', async (t) => {
  const cases = [
    { name: '異常: planner が返らない', planner: () => null, status: 'incomplete', reason: 'planner-unavailable' },
    { name: '異常: planner が別の HEAD を見た', planner: (fx) => draft(fx, { head_sha: 'f'.repeat(40) }), status: 'incomplete', reason: 'planner-head-mismatch' },
    { name: '準正常: 人の判断が要る', planner: (fx) => draft(fx, { human_decision_required: true, questions: ['互換を保つか'] }), status: 'needs_human_decision' },
    { name: '異常: 判断が要ると言うのに質問が無い', planner: (fx) => draft(fx, { human_decision_required: true }), status: 'incomplete', reason: 'planner-raised-decision-without-question' },
    { name: '異常: 変更不要なのに path がある', planner: (fx) => draft(fx, { no_change: true, no_change_reason: 'x' }), status: 'incomplete', reason: 'invalid-no-change-plan' },
    { name: '異常: path が正規形でない', planner: (fx) => draft(fx, { affected_paths: ['../a.mjs'] }), status: 'incomplete', reason: 'plan-missing-or-invalid-paths' },
    { name: '異常: preserved と重なる', planner: (fx) => draft(fx, { affected_paths: ['keep.md', 'src/a.test.mjs'] }), status: 'needs_isolated_worktree' },
  ]
  for (const c of cases) {
    await t.test(c.name, async (t) => {
      const fx = fixture(t)
      const b = backend({ planner: () => c.planner(fx), planReviewer: () => assert.fail('起動しない') })
      const result = await run(t, 'plan', planArgs(fx), b)
      assert.equal(result.status, c.status)
      if (c.reason) assert.equal(result.reason, c.reason)
    })
  }
})

test('計画: ケース計画の形の欠けを invalid-test-plan で返す（観点の未検討・未カバーの黙殺・宙に浮いたケース）', async (t) => {
  const cond = (patch) => ({ ...TEST_PLAN.conditions[0], ...patch })
  const cases = [
    { name: '異常: 観点がケースも不適用の理由も持たない', tp: { ...TEST_PLAN, conditions: [cond({ viewpoints: { ...TEST_PLAN.conditions[0].viewpoints, recovery: vp([]) } })] }, match: /recovery はケースか不適用の理由のどちらか一方/ },
    { name: '異常: 観点がケースと不適用の理由の両方を持つ', tp: { ...TEST_PLAN, conditions: [cond({ viewpoints: { ...TEST_PLAN.conditions[0].viewpoints, error: vp(['T2'], 'x') } })] }, match: /error はケースか/ },
    { name: '異常: ケースの無い条件に未カバーの理由が無い', tp: { ...TEST_PLAN, cases: [], conditions: [cond({ viewpoints: Object.fromEntries(categories.map((v) => [v, vp([], '無い')])) })] }, match: /未カバーの理由が無い/ },
    { name: '異常: 未カバーの条件がケースを持つ', tp: { ...TEST_PLAN, conditions: [cond({ uncovered_reason: '測れない' })] }, match: /未カバーの条件 C1 がケースを持つ/ },
    { name: '異常: 無いケースを指す', tp: { ...TEST_PLAN, cases: [TEST_PLAN.cases[0]] }, match: /無いケース T2/ },
    { name: '異常: どの条件にも結び付かないケース', tp: { ...TEST_PLAN, cases: [...TEST_PLAN.cases, { ...TEST_PLAN.cases[0], id: 'T9' }] }, match: /T9 がどの条件にも結び付かない/ },
    { name: '異常: ケースの重複', tp: { ...TEST_PLAN, cases: [...TEST_PLAN.cases, TEST_PLAN.cases[0]] }, match: /T1 が重複/ },
    { name: '境界: 変更があるのに条件が 0 件', tp: { conditions: [], cases: [] }, match: /条件が 1 つも無い/ },
  ]
  for (const c of cases) {
    await t.test(c.name, async (t) => {
      const fx = fixture(t)
      const result = await run(t, 'plan', planArgs(fx), backend({ planner: () => draft(fx, { test_plan: c.tp }), planReviewer: () => assert.fail('起動しない') }))
      assert.equal(result.status, 'incomplete')
      assert.equal(result.reason, 'invalid-test-plan')
      assert.match(result.problems.join('\n'), c.match)
    })
  }
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

test('計画: plan-reviewer の承認は根拠とケース計画の照合が揃ったときだけ通す', async (t) => {
  const gaps = (key) => ({ test_plan_review: { missing_conditions: [], unexamined_viewpoints: [], implementation_derived_expectations: [], [key]: ['x'] } })
  const cases = [
    { name: '異常: 根拠が無い', patch: { evidence: [] }, status: 'incomplete', reason: 'plan-review-evidence-incomplete' },
    { name: '異常: 読んでいない path を根拠にする', patch: { evidence: [{ path: 'other.md', line: 1, claim: 'x' }] }, status: 'incomplete', reason: 'plan-review-evidence-incomplete' },
    { name: '異常: 別の HEAD', patch: { head_sha: 'f'.repeat(40) }, status: 'incomplete', reason: 'plan-review-head-mismatch' },
    { name: '準正常: 人の判断が要る', patch: { human_decisions: ['公開の契約を変えるか'] }, status: 'needs_human_decision' },
    { name: '異常: 承認しない', patch: { approved: false, issues: ['caller を見落とした'] }, status: 'blocked' },
    { name: '異常: 条件の取りこぼし', patch: gaps('missing_conditions'), status: 'blocked' },
    { name: '異常: 観点の未検討', patch: gaps('unexamined_viewpoints'), status: 'blocked' },
    { name: '異常: 期待値が実装由来', patch: gaps('implementation_derived_expectations'), status: 'blocked' },
  ]
  for (const c of cases) {
    await t.test(c.name, async (t) => {
      const fx = fixture(t)
      const result = await run(t, 'plan', planArgs(fx), backend({ planner: () => draft(fx), planReviewer: () => planReview(fx, c.patch) }))
      assert.equal(result.status, c.status)
      if (c.reason) assert.equal(result.reason, c.reason)
    })
  }
})

test('schema に合わない返り値は採用せず、後の役を起動しない', async (t) => {
  const cases = [
    { name: '異常: planner の返り値に test_plan が無い', kind: 'plan', handlers: (fx) => { const { test_plan, ...d } = draft(fx); return { planner: () => d, planReviewer: () => assert.fail('起動しない') } }, reason: 'planner-unavailable' },
    { name: '異常: planner の check に余分なキー', kind: 'plan', handlers: (fx) => ({ planner: () => draft(fx, { additional_checks: [{ kind: 'make', value: 'test', args: '-j' }] }), planReviewer: () => assert.fail('起動しない') }), reason: 'planner-unavailable' },
    { name: '異常: planner の観点が 1 つ欠ける', kind: 'plan', handlers: (fx) => { const { boundary, ...v } = TEST_PLAN.conditions[0].viewpoints; return { planner: () => draft(fx, { test_plan: { ...TEST_PLAN, conditions: [{ ...TEST_PLAN.conditions[0], viewpoints: v }] } }), planReviewer: () => assert.fail('起動しない') } }, reason: 'planner-unavailable' },
    { name: '異常: plan-reviewer の返り値に test_plan_review が無い', kind: 'plan', handlers: (fx) => { const { test_plan_review, ...r } = planReview(fx); return { planner: () => draft(fx), planReviewer: () => r } }, reason: 'plan-review-unavailable' },
  ]
  for (const c of cases) {
    await t.test(c.name, async (t) => {
      const fx = fixture(t)
      const result = await run(t, c.kind, planArgs(fx), backend(c.handlers(fx)))
      assert.equal(result.status, 'incomplete')
      assert.equal(result.reason, c.reason)
    })
  }
  await t.test('異常: implementer の返り値に余分なキー', async (t) => {
    const fx = fixture(t)
    const approved = await approvedPlan(t, fx)
    const result = await run(t, 'run', runArgs(fx, approved), backend({ implementer: () => ({ ...implementation(fx), note: 'x' }) }, WRITE))
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

test('実装: 承認済みの計画を implementer に渡し、返り値を CLI の inventory がそのまま受け入れる', async (t) => {
  const fx = fixture(t)
  const approved = await approvedPlan(t, fx)
  const admitted = JSON.parse(main(['inventory'], JSON.stringify({ statePath: fx.statePath, stateSum: fx.stateSum, plan: approved.plan, planSum: approved.plan_sum })).output)
  assert.equal(admitted.admitted, true, JSON.stringify(admitted))
  const b = backend({
    implementer: () => {
      write(fx.repo, 'src/a.mjs', 'export const a = 2\n')
      write(fx.repo, 'src/a.test.mjs', "import test from 'node:test'\ntest('a は 2 を返す', () => {})\n")
      return implementation(fx)
    },
  }, WRITE)
  const result = await run(t, 'run', runArgs(fx, approved), b)
  assert.equal(result.status, 'ready_for_check', JSON.stringify(result))
  assert.deepEqual(b.calls.map((c) => [c.options.label, c.options.model, c.options.effort]), [['implementer-0', 'opus', 'high']])
  assert.ok(!b.calls[0].prompt.includes('直す確定指摘'))
  const inv = JSON.parse(main(['inventory'], JSON.stringify({ statePath: fx.statePath, stateSum: fx.stateSum, plan: approved.plan, planSum: approved.plan_sum, implementation: result })).output)
  assert.equal(inv.ok, true, inv.reason)
  assert.deepEqual(inv.problems, [])
})

test('実装: 書き込みの権限が無い実行面では起動しない', async (t) => {
  const fx = fixture(t)
  const approved = await approvedPlan(t, fx)
  const b = backend({ implementer: () => assert.fail('起動しない') })
  await assert.rejects(run(t, 'run', runArgs(fx, approved), b), /workspace-write/)
})

test('実装: implementer の返り値が契約に合わないときは理由つきの status で止まる', async (t) => {
  const cases = [
    { name: '異常: 返らない', impl: () => null, status: 'incomplete', reason: 'implementer-unavailable' },
    // native の agent() は throw し、この runner は null に変える。どちらでも run を落とさず incomplete にする。
    { name: '異常: 構造化出力で失敗した（throw）', impl: () => { throw new Error('schema exhausted') }, status: 'incomplete', reason: /^implementer-(failed|unavailable)$/ },
    { name: '異常: 別の HEAD', impl: (fx) => implementation(fx, { head_sha: 'f'.repeat(40) }), status: 'blocked', reason: 'implementation-head-mismatch' },
    { name: '異常: 未解決が残る', impl: (fx) => implementation(fx, { unresolved: ['仕様が無い'] }), status: 'blocked', reason: 'implementation-unresolved' },
    { name: '異常: 計画の外を書いた', impl: (fx) => implementation(fx, { touched_paths: ['README.md'] }), status: 'blocked', reason: 'implementation-status-or-scope-mismatch' },
    { name: '異常: changed なのに path が無い', impl: (fx) => implementation(fx, { touched_paths: [] }), status: 'blocked', reason: 'implementation-status-or-scope-mismatch' },
    { name: '異常: 自動テストのケースにテストが無い', impl: (fx) => implementation(fx, { case_tests: [] }), status: 'incomplete', reason: 'case-tests-incomplete', gap: ['missing', ['T1']] },
    { name: '異常: 計画に無いケースのテスト', impl: (fx) => implementation(fx, { case_tests: [...implementation(fx).case_tests, { case_id: 'T9', tests: [{ path: 'src/a.test.mjs', name: 'x' }] }] }), status: 'incomplete', reason: 'case-tests-incomplete', gap: ['unknown', ['T9']] },
    { name: '異常: ケースの無いテスト', impl: (fx) => implementation(fx, { tests_without_case: [{ path: 'src/a.test.mjs', name: 'extra' }] }), status: 'incomplete', reason: 'case-tests-incomplete' },
    { name: '境界: review の層のケースはテストの所在を求めない', impl: (fx) => implementation(fx), status: 'ready_for_check' },
    { name: '正常: 実装不要', impl: (fx) => implementation(fx, { status: 'no_change', touched_paths: [], case_tests: [] }), status: 'no_change' },
  ]
  for (const c of cases) {
    await t.test(c.name, async (t) => {
      const fx = fixture(t)
      const approved = await approvedPlan(t, fx)
      const result = await run(t, 'run', runArgs(fx, approved), backend({ implementer: () => c.impl(fx) }, WRITE))
      assert.equal(result.status, c.status, JSON.stringify(result))
      if (c.reason instanceof RegExp) assert.match(result.reason, c.reason)
      else if (c.reason) assert.equal(result.reason, c.reason)
      if (c.gap) assert.deepEqual(result.caseTestGaps[c.gap[0]], c.gap[1])
      const { sum, ...rest } = result
      assert.equal(sum, fnvSum(rest), 'どの status でも CLI が受け取れる sum を持つ')
    })
  }
})

const confirmedFinding = (patch = {}) => ({
  path: 'src/a.mjs', line: 1, end_line: 1, in_target: true, lens: 'correctness', cluster: 0,
  claim: { reported_by: 'correctness', severity: 'HIGH', path: 'src/a.mjs', line: 1, summary: 's', condition: 'c', impact: 'i', evidence: 'e', rule: 'r', rule_sections: ['P1'] },
  votes: [{ round: 1, lens: 'correctness', vote: 'confirmed', reason: 'x', evidence: [] }],
  ...patch,
})

function afterRun(fx, results, round = 0) {
  const r = { phase: 'after', round, head: fx.state.head, snapshot_before: 'S', snapshot_after: 'S', tree_changed: false, results }
  return { checkRun: r, checkRunSum: fnvSum(r) }
}

test('修正: 回数は MAX_REPAIR_ROUNDS までで、入力は確定指摘か変更起因の check の失敗だけ', async (t) => {
  const MAX = bodyLiteral(TEXT.run, 'MAX_REPAIR_ROUNDS')
  const failed = (repairable) => ({ check: { kind: 'make', value: 'test' }, argv: ['make', 'test'], exit_code: 2, stdout_tail: 'boom', stderr_tail: '', failed_at_baseline: !repairable, repairable })
  const cases = [
    { name: '正常: 確定指摘を直す', extra: { repairRound: 1, reviewFindings: [confirmedFinding()] }, status: 'ready_for_check', prompt: /直す確定指摘/ },
    { name: '正常: 変更起因の check の失敗を直す', extra: (fx) => ({ repairRound: 1, ...afterRun(fx, [failed(true)]) }), status: 'ready_for_check', prompt: /boom/ },
    { name: '境界: 上限ちょうどの回', extra: { repairRound: MAX, reviewFindings: [confirmedFinding()] }, status: 'ready_for_check' },
    { name: '異常: 確定指摘が計画の外を指す', extra: { repairRound: 1, reviewFindings: [confirmedFinding({ path: 'README.md' })] }, status: 'needs_replan' },
    { name: '異常: 確定指摘が対象の外（呼び出し元）を指す', extra: { repairRound: 1, reviewFindings: [confirmedFinding({ in_target: false })] }, status: 'needs_replan' },
    { name: '異常: 修正なのに直すものを返さなかった', extra: { repairRound: 1, reviewFindings: [confirmedFinding()] }, impl: (fx) => implementation(fx, { status: 'no_change', touched_paths: [], case_tests: [] }), status: 'blocked', reason: 'repair-returned-no-change' },
  ]
  for (const c of cases) {
    await t.test(c.name, async (t) => {
      const fx = fixture(t)
      const approved = await approvedPlan(t, fx)
      const b = backend({ implementer: () => (c.impl ?? implementation)(fx) }, WRITE)
      const extra = typeof c.extra === 'function' ? c.extra(fx) : c.extra
      const result = await run(t, 'run', runArgs(fx, approved, extra), b)
      assert.equal(result.status, c.status, JSON.stringify(result))
      if (c.reason) assert.equal(result.reason, c.reason)
      if (c.prompt) assert.match(b.calls[0].prompt, c.prompt)
      assert.equal(result.repairRound, extra.repairRound)
    })
  }
  const rejected = [
    ['異常: 上限を超える回', { repairRound: MAX + 1, reviewFindings: [confirmedFinding()] }],
    ['異常: 負の回', { repairRound: -1 }],
    ['異常: 最初の実装に修正の入力を渡す', { repairRound: 0, reviewFindings: [confirmedFinding()] }],
    ['異常: 修正の回に入力が無い', { repairRound: 1 }],
    ['異常: 開始時から失敗していた check だけを渡す', (fx) => ({ repairRound: 1, ...afterRun(fx, [failed(false)]) })],
    ['異常: 前の round の check の失敗を持ち込む', (fx) => ({ repairRound: 2, ...afterRun(fx, [failed(true)], 0) })],
    ['異常: 別の HEAD での check の結果', (fx) => ({ repairRound: 1, ...afterRun({ state: { head: 'f'.repeat(40) } }, [failed(true)]) })],
    ['異常: 確定していない指摘', { repairRound: 1, reviewFindings: [confirmedFinding({ votes: [{ vote: 'refuted' }] })] }],
    ['異常: run-checks の出力を書き換えた', (fx) => ({ repairRound: 1, ...afterRun(fx, [failed(true)]), checkRunSum: '00000000' })],
    ['異常: 計画を書き換えた', { planSum: '00000000' }],
  ]
  for (const [name, extra] of rejected) {
    await t.test(name, async (t) => {
      const fx = fixture(t)
      const approved = await approvedPlan(t, fx)
      const b = backend({ implementer: () => assert.fail('起動しない') }, WRITE)
      await assert.rejects(run(t, 'run', runArgs(fx, approved, typeof extra === 'function' ? extra(fx) : extra), b))
      assert.equal(b.calls.length, 0)
    })
  }
  await t.test('異常: 承認されていない計画は実装しない', async (t) => {
    const fx = fixture(t)
    const approved = await approvedPlan(t, fx)
    const plan = { ...approved.plan, status: 'blocked' }
    await assert.rejects(run(t, 'run', runArgs(fx, { plan, plan_sum: fnvSum(plan) }), backend({}, WRITE)), /承認済み/)
  })
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
  git(repo, 'checkout', '-q', '-b', 'work')
  write(repo, 'src/b.mjs', 'b\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'ahead of main')
  write(repo, 'keep.md', 'mine\n')
  const started = JSON.parse(main(['start'], JSON.stringify({ repo, stateDir: tmp(t, 'repo-implement-rr-state-'), policyRef: 'main' })).output)
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

function declarations(source) {
  const body = source.replace(/^export const meta =/, 'const meta =')
  const prefix = 'async function __s() {\n'
  const ast = acorn.parse(`${prefix}${body}\n}`, { ecmaVersion: 'latest', sourceType: 'module' })
  const out = new Map()
  for (const n of ast.body[0].body.body) {
    const name = n.type === 'VariableDeclaration' ? n.declarations[0].id.name : n.id?.name
    if (name) out.set(name, `${prefix}${body}`.slice(n.start, n.end))
  }
  return out
}

test('Workflow source の写し（canonical・fnvSum・isRepoRelativePath）は CLI の部品と一致する', () => {
  for (const text of [TEXT.plan, TEXT.run]) {
    const d = declarations(text)
    assert.equal(d.get('canonical'), canonical.toString())
    assert.equal(d.get('fnvSum'), fnvSum.toString())
    assert.equal(d.get('isRepoRelativePath'), isRepoRelativePath.toString())
  }
})

test('写しの定数は正本と一致する（観点の名前は traceability の分類、重大度は REVIEW.md の表）', () => {
  assert.deepEqual(bodyLiteral(TEXT.plan, 'VIEWPOINTS'), categories)
  const review = readFileSync(path.join(ROOT, 'REVIEW.md'), 'utf8')
  const section = review.split(/^## /m).find((s) => s.startsWith('重大度'))
  assert.deepEqual(bodyLiteral(TEXT.run, 'SEVERITIES'), [...section.matchAll(/^\| ([A-Z]+) \|/gm)].map((m) => m[1]))
})

test('meta.limits は本体の役の数と agentTimeoutMs から決まり、全ての役が model と effort を明示する', () => {
  for (const kind of ['plan', 'run']) {
    const roles = bodyLiteral(TEXT[kind], 'ROLE_MODELS')
    const limits = META[kind].limits
    assert.equal(limits.maxAgents, Object.keys(roles).length, kind)
    assert.equal(limits.timeoutMs, limits.maxAgents * limits.agentTimeoutMs, kind)
    for (const [role, opts] of Object.entries(roles)) {
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
