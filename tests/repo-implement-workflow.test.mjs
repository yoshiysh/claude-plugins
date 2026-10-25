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
import { changeSet, defaultIo, main } from '../.agents/skills/repo-implement/scripts/implement-cli.mjs'
import { collectState, defaultIo as reviewIo, main as reviewMain } from '../.agents/skills/repo-review/scripts/review-cli.mjs'
import { MAKE_TARGETS, canonical, fnvSum, isRepoRelativePath } from '../.agents/skills/repo-implement/scripts/implement-core.mjs'
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
function sourceNamed(name, skillScripts = path.join(SKILL_DIR, 'scripts')) {
  const dirs = [skillScripts, ...readdirSync(path.join(ROOT, 'plugins')).map((p) => path.join(ROOT, 'plugins', p, 'workflows'))]
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
const REVIEW_SKILL_DIR = realpathSync(path.join(ROOT, '.agents', 'skills', 'repo-review'))
const REVIEW_SOURCE = sourceNamed('repo-review-run', path.join(REVIEW_SKILL_DIR, 'scripts'))
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
  write(repo, '.github/workflows/claude_review.yml', `jobs:\n  review:\n    with:\n      exclude-paths: '["**/*.lock"]'\n`)
  write(repo, 'REVIEW.md', '# Review\n\n## 読むもの\n\n| 変更 | 読むもの |\n|---|---|\n| すべて | `REVIEW.md` |\n')
  write(repo, 'src/a.mjs', 'export const a = 1\n')
  write(repo, 'keep.md', 'keep\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'base')
  git(repo, 'update-ref', 'refs/remotes/origin/main', 'main')
  git(repo, 'checkout', '-q', '-b', 'work')
  write(repo, 'keep.md', 'mine\n')
  const out = JSON.parse(main(['start'], JSON.stringify({ repo, stateDir: tmp(t, 'repo-implement-wf-state-') })).output)
  assert.equal(out.ok, true, out.reason)
  return { repo, state: out.state, stateSum: out.state_sum, statePath: out.state_path, preservedPaths: out.preservedPaths }
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
    case_tests: [{ case_id: 'T1', tests: [{ path: 'src/a.test.mjs', name: 'a は 2 を返す' }] }], tests_without_case: [], unresolved: [], notes: [],
    ...patch,
  }
}

// handler は (prompt, n)。n はその役の何回目の起動か（label の末尾の -<n> を外した名前ごとに数える）。
function backend(handlers, capabilities = ['read-only', 'fresh-thread']) {
  const calls = []
  return {
    calls,
    capabilities,
    async run(prompt, options) {
      const role = options.label.replace(/-\d+$/, '')
      const n = calls.filter((c) => c.role === role).length
      calls.push({ prompt, options, role })
      const handler = handlers[role]
      if (!handler) throw new Error(`unexpected label ${options.label}`)
      return handler(prompt, n)
    },
  }
}

async function run(t, kind, args, b) {
  const runRoot = tmp(t, `repo-implement-${kind}-run-`)
  return Workflow({ scriptPath: kind === 'plan' ? PLAN_SOURCE : RUN_SOURCE, args }, { backend: b, runDir: path.join(runRoot, 'run'), trustedSource: true, ...META[kind].limits })
}

const planArgs = (fx, extra = {}) => ({ skillDir: SKILL_DIR, request: 'src/a.mjs の a を 2 にして', state: fx.state, stateSum: fx.stateSum, ...extra })
const MAX_PLAN_REVISIONS = bodyLiteral(TEXT.plan, 'MAX_PLAN_REVISIONS')
const MAX_REPAIR_ROUNDS = bodyLiteral(TEXT.run, 'MAX_REPAIR_ROUNDS')

async function approvedPlan(t, fx) {
  const result = await run(t, 'plan', planArgs(fx), backend({ planner: () => draft(fx), planReviewer: () => planReview(fx) }))
  assert.equal(result.status, 'approved', JSON.stringify(result))
  return result
}

const WRITE = ['read-only', 'fresh-thread', 'workspace-write']
const cli = (op, body) => JSON.parse(main([op], JSON.stringify(body)).output)
const refOf = (fx, approved) => ({ statePath: fx.statePath, stateSum: fx.stateSum, plan: approved.plan, planSum: approved.plan_sum })

// 受け入れ・baseline・begin-round を CLI で流し、実装の Workflow の args を返す。
function admitAndBegin(fx, approved) {
  const ref = refOf(fx, approved)
  assert.equal(cli('inventory', ref).admitted, true)
  assert.equal(cli('run-checks', { ...ref, phase: 'baseline' }).ok, true)
  const begun = cli('begin-round', { ...ref, repair: null })
  assert.equal(begun.ok, true, begun.reason)
  return { skillDir: SKILL_DIR, state: fx.state, stateSum: fx.stateSum, plan: approved.plan, planSum: approved.plan_sum, ticket: begun.ticket, ticketSum: begun.ticket_sum }
}

// begin-round を通さずに券の形だけを作る（実装の Workflow の入力検査を、CLI の記録と切り離して確かめる）。
function ticketArgs(fx, approved, patch = {}) {
  const ticket = { round: 0, plan_sum: approved.plan_sum, state_sum: fx.stateSum, snapshot: fx.state.snapshot, repair: null, findings: [], checkFailures: [], ...patch }
  return { skillDir: SKILL_DIR, state: fx.state, stateSum: fx.stateSum, plan: approved.plan, planSum: approved.plan_sum, ticket, ticketSum: fnvSum(ticket) }
}

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

const RR_COMMAND = /node '([^']+)' (\S+) <<'(RR_[0-9a-f]{8})'\n(.*)\n\3/g

// repo-review の Workflow を本物の source で流す。運搬役は prompt のコマンドを本物の CLI で実行し、reviewer は指摘なしで担当を全て読んだと返す。
async function runReview(t, rp, reviewers) {
  const token = /^読取りトークン（policy_pack_token に返す）: (\S+)$/m.exec(readFileSync(rp.plan.policyPack.path, 'utf8'))[1]
  const b = {
    capabilities: ['read-only', 'fresh-thread'],
    async run(prompt, options) {
      if (options.label.startsWith('carrier:')) {
        const responses = []
        for (const m of prompt.matchAll(RR_COMMAND)) {
          const out = reviewMain([m[2]], m[4]).output
          responses.push(out)
          if (!JSON.parse(out).ok) break
        }
        return { responses }
      }
      const id = options.label.slice('review:'.length)
      return { head_sha: rp.plan.headSha, policy_pack_token: token, coverage: reviewers.find((r) => r.id === id).files, supporting_files: [], policy_sections: ['P1'], findings: [], limitations: [] }
    },
  }
  const meta = readSourceMetadata(readFileSync(REVIEW_SOURCE, 'utf8'))
  return Workflow({ scriptPath: REVIEW_SOURCE, args: { skillDir: REVIEW_SKILL_DIR, plan: rp.plan, planSum: rp.plan_sum, planPath: rp.plan_path } },
    { backend: b, runDir: path.join(tmp(t, 'repo-implement-rr-run-'), 'run'), trustedSource: true, ...meta.limits })
}

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

const confirmedFinding = (patch = {}) => ({
  path: 'src/a.mjs', line: 1, end_line: 1, in_target: true, lens: 'correctness', cluster: 0,
  claim: { reported_by: 'correctness', severity: 'HIGH', path: 'src/a.mjs', line: 1, summary: 's', condition: 'c', impact: 'i', evidence: 'e', rule: 'r', rule_sections: ['P1'] },
  votes: [{ round: 1, lens: 'correctness', vote: 'confirmed', reason: 'x', evidence: [] }],
  ...patch,
})
const failed = { check: { kind: 'make', value: 'test' }, argv: ['make', 'test'], exit_code: 2, stdout_tail: 'boom', stderr_tail: '', failed_at_baseline: false, repairable: true }

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
