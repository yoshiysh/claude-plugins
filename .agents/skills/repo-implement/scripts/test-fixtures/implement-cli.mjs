// implement-cli*.test.mjs が共有する fixture と CLI の呼び出しの道具。
import { after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { main } from '../implement-cli.mjs'
import { DEFAULT_POLICY_REF, fnvSum, sha256 } from '../implement-core.mjs'

export const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'implement-cli.mjs')
export const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com',
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
}
// fixture の make test は FAIL というファイルがあれば失敗する。開始時と変更後の成否を作業ツリーの内容だけで切り替える。
export const MAKEFILE = 'test:\n\t@echo running\n\t@test ! -e FAIL\ncheck:\n\t@echo check\n'

export function git(repo, ...args) {
  return execFileSync('git', ['-C', repo, ...args], { env: GIT_ENV }).toString('utf8').trim()
}

export function write(repo, file, text) {
  mkdirSync(path.dirname(path.join(repo, file)), { recursive: true })
  writeFileSync(path.join(repo, file), text)
}

export function tmp(t, prefix) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

// fixture の repo は branch ごとに 1 回だけ git で作り、各テストには写しを渡す（毎回の git init・commit の起動を省く）。
// 写しは symlink をそのまま写し、写しの後に index の stat 情報を今のファイルに合わせ直す（新しく作った repo と同じ状態にする）。
const templates = new Map()
after(() => { for (const { repo } of templates.values()) rmSync(repo, { recursive: true, force: true }) })

export function template(branch) {
  if (templates.has(branch)) return templates.get(branch)
  const repo = realpathSync(mkdtempSync(path.join(tmpdir(), 'repo-implement-template-')))
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
  const made = { repo, head: git(repo, 'rev-parse', 'HEAD') }
  templates.set(branch, made)
  return made
}

export function fixture(t, { branch = 'work' } = {}) {
  const base = template(branch)
  const repo = tmp(t, 'repo-implement-cli-')
  cpSync(base.repo, repo, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true })
  git(repo, 'update-index', '-q', '--refresh')
  return { repo, stateDir: tmp(t, 'repo-implement-state-'), head: base.head }
}

export function call(op, body) {
  return JSON.parse(main([op], JSON.stringify(body)).output)
}

export function ok(op, body) {
  const out = call(op, body)
  assert.equal(out.ok, true, `${op}: ${out.code} ${out.reason}`)
  return out
}

export function start(fx) {
  const out = ok('start', { repo: fx.repo, stateDir: fx.stateDir })
  return { state: out.state, statePath: out.state_path, stateSum: out.state_sum, out, repo: fx.repo, stateDir: fx.stateDir }
}

export function planFor(s, patch = {}) {
  const plan = { status: 'approved', state_sum: s.stateSum, affected_paths: ['src/a.mjs', 'src/a.test.mjs', 'src/new.test.mjs', 'FAIL'], checks: [{ kind: 'make', value: 'test' }], ...patch }
  return { plan, planSum: fnvSum(plan) }
}

export const ref = (s) => ({ statePath: s.statePath, stateSum: s.stateSum })

// 実装の Workflow の返り値と同じ形（券の sum と round を持ち、全体に sum が付く）。
export function implementationFor(begun, touched, status = 'ready_for_check') {
  const body = { status, repairRound: begun.ticket.round, ticket_sum: begun.ticket_sum, touched_paths: touched }
  return { ...body, sum: fnvSum(body) }
}

export function admit(s, p) {
  const out = ok('inventory', { ...ref(s), ...p })
  assert.equal(out.admitted, true, JSON.stringify(out.problems))
  ok('run-checks', { ...ref(s), ...p, phase: 'baseline' })
}

// begin-round → 書き込み → inventory を 1 回分流す。
export function round(s, p, edit, touched, { repair = null, status } = {}) {
  const begun = ok('begin-round', { ...ref(s), ...p, repair })
  edit?.(s.repo)
  return { begun, inv: ok('inventory', { ...ref(s), ...p, implementation: implementationFor(begun, touched, status) }) }
}

// repo-review の plan 操作が stateDir に書く計画のファイルの形（record-review が照らす部分）を、今の作業ツリーから作る。
export function reviewPlanFile(s, files, patch = {}) {
  const digests = Object.fromEntries(files.filter((f) => typeof f === 'string' && !f.startsWith('..')).map((f) => [f, `file:${sha256(readFileSync(path.join(s.repo, f)))}`]))
  const plan = { mode: 'working_tree', baseRef: s.state.head, headSha: s.state.head, policyRef: s.state.policyRef, target: { files }, excluded: [], generated: [], preserved: s.out.preservedPaths, digests, reviewers: LENSES.map((id) => ({ id })), ...patch }
  const file = path.join(s.stateDir, `review-plan-${fnvSum(plan)}.json`)
  writeFileSync(file, JSON.stringify(plan))
  return { reviewPlanPath: file, reviewPlanSum: fnvSum(plan), plan }
}

export const LENSES = ['correctness', 'docs']
// repo-review の Workflow の返り値の形（record-review が照らす部分）。sum は本文の fnvSum。
export function reviewOf(s, files, patch = {}) {
  const body = {
    status: 'completed', mode: 'working_tree', headSha: s.state.head, baseRef: s.state.head, policyRef: s.state.policyRef, scope: null, target: { files },
    excluded: [], generated: [], preserved: s.out.preservedPaths, coverage: LENSES.map((id) => ({ id })), pin: { ok: true }, findings: [], unverified: [], reasons: [], ...patch,
  }
  return { ...body, sum: fnvSum(body) }
}

export const confirmed = (patch = {}) => ({
  path: 'src/a.mjs', line: 1, in_target: true,
  claim: { severity: 'HIGH', summary: 's', condition: 'c', impact: 'i', evidence: 'e', rule: 'r' },
  votes: [{ vote: 'confirmed' }], ...patch,
})


export function implemented(t) {
  const fx = fixture(t)
  const s = start(fx)
  const p = planFor(s)
  admit(s, p)
  round(s, p, (r) => write(r, 'src/a.mjs', 'export const a = 2\n'), ['src/a.mjs'])
  ok('run-checks', { ...ref(s), ...p, phase: 'after' })
  return { fx, s, p }
}

export function recordReview(s, files, reviewPatch = {}, planPatch = {}) {
  const rp = reviewPlanFile(s, files, planPatch)
  return call('record-review', { ...ref(s), review: reviewOf(s, files, reviewPatch), reviewPlanPath: rp.reviewPlanPath, reviewPlanSum: rp.reviewPlanSum })
}
