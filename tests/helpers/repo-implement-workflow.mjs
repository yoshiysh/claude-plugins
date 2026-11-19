// tests/repo-implement-workflow*.test.mjs が共有する fixture・Workflow の実行・CLI の呼び出しの道具。
import { after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Workflow } from '../../plugins/workflow/skills/dynamic-workflow-runner/scripts/runtime/runtime.mjs'
import { readSourceMetadata } from '../../plugins/workflow/skills/dynamic-workflow-runner/scripts/runtime/source.mjs'
import { main } from '../../.agents/skills/repo-implement/scripts/implement-cli.mjs'
import { main as reviewMain } from '../../.agents/skills/repo-review/scripts/review-cli.mjs'
import { fnvSum } from '../../.agents/skills/repo-implement/scripts/implement-core.mjs'
import { bodyLiteral } from './workflow-source.mjs'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
export const SKILL_DIR = realpathSync(path.join(ROOT, '.agents', 'skills', 'repo-implement'))
export const PLAN_NAME = 'repo-implement-plan'
export const RUN_NAME = 'repo-implement-run'
export const acorn = createRequire(path.join(ROOT, 'plugins', 'workflow', 'skills', 'dynamic-workflow-runner', 'scripts', 'runtime', 'package.json'))('acorn')
export const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com',
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
}

// 公開の前は skill の scripts/、公開の後は plugin の workflows/ にある。どちらでも meta.name で 1 本に決める。
export function sourceNamed(name, skillScripts = path.join(SKILL_DIR, 'scripts')) {
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
export const PLAN_SOURCE = sourceNamed(PLAN_NAME)
export const RUN_SOURCE = sourceNamed(RUN_NAME)
export const REVIEW_SKILL_DIR = realpathSync(path.join(ROOT, '.agents', 'skills', 'repo-review'))
export const REVIEW_SOURCE = sourceNamed('repo-review-run', path.join(REVIEW_SKILL_DIR, 'scripts'))
export const TEXT = { plan: readFileSync(PLAN_SOURCE, 'utf8'), run: readFileSync(RUN_SOURCE, 'utf8') }
export const META = { plan: readSourceMetadata(TEXT.plan), run: readSourceMetadata(TEXT.run) }

export function git(repo, ...args) {
  return execFileSync('git', ['-C', repo, ...args], { env: GIT_ENV }).toString('utf8').trim()
}

export function tmp(t, prefix) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

export function write(repo, file, text) {
  mkdirSync(path.dirname(path.join(repo, file)), { recursive: true })
  writeFileSync(path.join(repo, file), text)
}

// 開始時の commit までの repo は全ての fixture で同じなので、process ごとに 1 回だけ作って写す（毎回 git を 7 回起動しない）。
let base
after(() => { if (base) rmSync(base, { recursive: true, force: true }) })
export function template() {
  if (base) return base
  const repo = realpathSync(mkdtempSync(path.join(tmpdir(), 'repo-implement-wf-base-')))
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
  base = repo
  return base
}

export function fixture(t) {
  const repo = tmp(t, 'repo-implement-wf-')
  cpSync(template(), repo, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true })
  // 写しは inode と ctime が変わるので、index の stat 情報を今のファイルに合わせる（内容は同じ）。
  git(repo, 'update-index', '-q', '--refresh')
  write(repo, 'keep.md', 'mine\n')
  const out = JSON.parse(main(['start'], JSON.stringify({ repo, stateDir: tmp(t, 'repo-implement-wf-state-') })).output)
  assert.equal(out.ok, true, out.reason)
  return { repo, state: out.state, stateSum: out.state_sum, statePath: out.state_path, preservedPaths: out.preservedPaths }
}

export const vp = (ids, reason = '') => ({ case_ids: ids, not_applicable_reason: reason })
export const TEST_PLAN = {
  conditions: [{
    id: 'C1', statement: 'a は 2 を返す', source: '依頼', uncovered_reason: '',
    viewpoints: { normal: vp(['T1']), recovery: vp([], '再試行の経路を持たない'), error: vp(['T2']), boundary: vp(['T1']) },
  }],
  cases: [
    { id: 'T1', layer: 'unit', input: '既定', expected: '2', expected_basis: '依頼', parameterized_group: 'a-values', spec_ids: [] },
    { id: 'T2', layer: 'review', input: '文書', expected: '記述が一致', expected_basis: '依頼', parameterized_group: '', spec_ids: [] },
  ],
}

export function draft(fx, patch = {}) {
  return {
    head_sha: fx.state.head, summary: 'a を 2 にする', no_change: false, no_change_reason: '',
    affected_paths: ['src/a.mjs', 'src/a.test.mjs'], invariants: ['export 名を変えない'], implementation_steps: ['a を 2 にする'],
    additional_checks: [{ kind: 'node-test', value: 'src/a.test.mjs' }], human_decision_required: false, questions: [], test_plan: TEST_PLAN,
    ...patch,
  }
}

export function planReview(fx, patch = {}) {
  return {
    head_sha: fx.state.head, approved: true, issues: [], human_decisions: [],
    test_plan_review: { missing_conditions: [], unexamined_viewpoints: [], implementation_derived_expectations: [] },
    checked_paths: ['src/a.mjs'], evidence: [{ path: 'src/a.mjs', line: 1, claim: 'a は 1 を返す' }],
    ...patch,
  }
}

export function implementation(fx, patch = {}) {
  return {
    head_sha: fx.state.head, status: 'changed', summary: '直した', touched_paths: ['src/a.mjs', 'src/a.test.mjs'],
    case_tests: [{ case_id: 'T1', tests: [{ path: 'src/a.test.mjs', name: 'a は 2 を返す' }] }], tests_without_case: [], unresolved: [], notes: [],
    ...patch,
  }
}

// handler は (prompt, n)。n はその役の何回目の起動か（label の末尾の -<n> を外した名前ごとに数える）。
export function backend(handlers, capabilities = ['read-only', 'fresh-thread']) {
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

export async function run(t, kind, args, b) {
  const runRoot = tmp(t, `repo-implement-${kind}-run-`)
  return Workflow({ scriptPath: kind === 'plan' ? PLAN_SOURCE : RUN_SOURCE, args }, { backend: b, runDir: path.join(runRoot, 'run'), trustedSource: true, ...META[kind].limits })
}

export const planArgs = (fx, extra = {}) => ({ skillDir: SKILL_DIR, request: 'src/a.mjs の a を 2 にして', state: fx.state, stateSum: fx.stateSum, ...extra })
export const MAX_PLAN_REVISIONS = bodyLiteral(TEXT.plan, 'MAX_PLAN_REVISIONS')
export const MAX_REPAIR_ROUNDS = bodyLiteral(TEXT.run, 'MAX_REPAIR_ROUNDS')

export async function approvedPlan(t, fx) {
  const result = await run(t, 'plan', planArgs(fx), backend({ planner: () => draft(fx), planReviewer: () => planReview(fx) }))
  assert.equal(result.status, 'approved', JSON.stringify(result))
  return result
}

export const WRITE = ['read-only', 'fresh-thread', 'workspace-write']
export const cli = (op, body) => JSON.parse(main([op], JSON.stringify(body)).output)
export const refOf = (fx, approved) => ({ statePath: fx.statePath, stateSum: fx.stateSum, plan: approved.plan, planSum: approved.plan_sum })

// 受け入れ・baseline・begin-round を CLI で流し、実装の Workflow の args を返す。
export function admitAndBegin(fx, approved) {
  const ref = refOf(fx, approved)
  assert.equal(cli('inventory', ref).admitted, true)
  assert.equal(cli('run-checks', { ...ref, phase: 'baseline' }).ok, true)
  const begun = cli('begin-round', { ...ref, repair: null })
  assert.equal(begun.ok, true, begun.reason)
  return { skillDir: SKILL_DIR, state: fx.state, stateSum: fx.stateSum, plan: approved.plan, planSum: approved.plan_sum, ticket: begun.ticket, ticketSum: begun.ticket_sum }
}

// begin-round を通さずに券の形だけを作る（実装の Workflow の入力検査を、CLI の記録と切り離して確かめる）。
export function ticketArgs(fx, approved, patch = {}) {
  const ticket = { round: 0, plan_sum: approved.plan_sum, state_sum: fx.stateSum, snapshot: fx.state.snapshot, repair: null, findings: [], checkFailures: [], ...patch }
  return { skillDir: SKILL_DIR, state: fx.state, stateSum: fx.stateSum, plan: approved.plan, planSum: approved.plan_sum, ticket, ticketSum: fnvSum(ticket) }
}

export const RR_COMMAND = /node '([^']+)' (\S+) <<'(RR_[0-9a-f]{8})'\n(.*)\n\3/g

// repo-review の Workflow を本物の source で流す。運搬役は prompt のコマンドを本物の CLI で実行し、reviewer は指摘なしで担当を全て読んだと返す。
export async function runReview(t, rp, reviewers) {
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

export const confirmedFinding = (patch = {}) => ({
  path: 'src/a.mjs', line: 1, end_line: 1, in_target: true, lens: 'correctness', cluster: 0,
  claim: { reported_by: 'correctness', severity: 'HIGH', path: 'src/a.mjs', line: 1, summary: 's', condition: 'c', impact: 'i', evidence: 'e', rule: 'r', rule_sections: ['P1'] },
  votes: [{ round: 1, lens: 'correctness', vote: 'confirmed', reason: 'x', evidence: [] }],
  ...patch,
})
export const failed = { check: { kind: 'make', value: 'test' }, argv: ['make', 'test'], exit_code: 2, stdout_tail: 'boom', stderr_tail: '', failed_at_baseline: false, repairable: true }

export function declarations(source) {
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
