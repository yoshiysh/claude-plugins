import { createHash } from 'node:crypto'

export const CODES = Object.freeze({
  input: 'E_INPUT',
  pin: 'E_PIN',
  check: 'E_CHECK',
  state: 'E_STATE',
  io: 'E_IO',
  internal: 'E_INTERNAL',
})

// check の許可リストの正本。make の target は Makefile の検証の入口に限る（runtime-deps と references は test が含む）。
// 必須 check は AGENTS.md「検証」の合否ゲート。
export const MAKE_TARGETS = Object.freeze(['test', 'check', 'portability', 'traceability', 'traceability-complete'])
export const NODE_TEST_SUFFIX = '.test.mjs'
export const CHECK_KINDS = Object.freeze(['make', 'node-test'])
export const REQUIRED_CHECKS = Object.freeze([Object.freeze({ kind: 'make', value: 'test' })])
export const PHASES = Object.freeze(['baseline', 'after'])
export const OUTPUT_TAIL_LINES = 40
export const MAIN_BRANCH = 'main'

export class ImplementError extends Error {
  constructor(code, message, detail = {}) {
    super(message)
    this.code = code
    this.detail = detail
  }
}

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? 'null' : canonical(v))).join(',')}]`
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`
}

function fnvSum(value) {
  const text = canonical(value)
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

function isRepoRelativePath(path) {
  return typeof path === 'string'
    && path.length > 0
    && !path.startsWith('/')
    && !path.includes('\\')
    && path.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..')
}

export { canonical, fnvSum, isRepoRelativePath }

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

export function checkPolicy() {
  return { makeTargets: [...MAKE_TARGETS], nodeTestSuffix: NODE_TEST_SUFFIX, required: REQUIRED_CHECKS.map((c) => ({ ...c })) }
}

export function checkKey(check) {
  return `${check.kind}:${check.value}`
}

// argv は固定の実行ファイルと、許可リストで確かめた値だけで組む（モデルの自由文を shell に渡さない）。
export function checkProblem(check, affectedPaths) {
  if (!check || typeof check !== 'object' || Array.isArray(check)) return 'check は {kind, value} のオブジェクト'
  const keys = Object.keys(check).sort().join(',')
  if (keys !== 'kind,value') return `check のキーは kind と value だけ（${keys}）`
  if (!CHECK_KINDS.includes(check.kind)) return `kind が ${CHECK_KINDS.join('・')} のどれでもない: ${JSON.stringify(check.kind)}`
  if (check.kind === 'make') {
    return MAKE_TARGETS.includes(check.value) ? null : `make の target が許可リストに無い: ${JSON.stringify(check.value)}`
  }
  if (!isRepoRelativePath(check.value) || check.value.startsWith('-')) return `node --test の path が repo 相対の正規形でない: ${JSON.stringify(check.value)}`
  if (!check.value.endsWith(NODE_TEST_SUFFIX)) return `node --test の path が ${NODE_TEST_SUFFIX} でない: ${check.value}`
  if (!affectedPaths.includes(check.value)) return `node --test の path が plan.affected_paths に無い: ${check.value}`
  return null
}

export function argvOf(check) {
  return check.kind === 'make' ? ['make', check.value] : ['node', '--test', check.value]
}

export function tail(text, lines = OUTPUT_TAIL_LINES) {
  const all = String(text ?? '').replace(/\n$/, '').split('\n')
  return all.slice(-lines).join('\n')
}

// `git status --porcelain=v1 -z --no-renames` の各項目は "XY <path>"。--no-renames なので元の path の欄は無い。
export function parsePorcelain(text) {
  return text.split('\0').filter(Boolean).map((entry) => ({ xy: entry.slice(0, 2), path: entry.slice(3) }))
}

export function snapshotOf(head, entries) {
  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return sha256(canonical({ head, entries: sorted }))
}

const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
export const isSha = (value) => typeof value === 'string' && SHA.test(value)

export function stateProblem(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return 'state がオブジェクトでない'
  if (typeof state.repo !== 'string' || !state.repo.startsWith('/')) return 'state.repo が絶対パスでない'
  if (!isSha(state.head) || !isSha(state.policyRef)) return 'state.head・state.policyRef が完全な SHA でない'
  if (!Array.isArray(state.preserved) || state.preserved.some((p) => !isRepoRelativePath(p?.path) || typeof p?.digest !== 'string')) return 'state.preserved が {path, digest} の配列でない'
  if (typeof state.ledgerPath !== 'string' || !state.ledgerPath.startsWith('/')) return 'state.ledgerPath が絶対パスでない'
  return null
}

export function planProblem(plan, planSum, state, stateSum) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) return 'plan がオブジェクトでない'
  if (fnvSum(plan) !== planSum) return 'plan と planSum が合わない（plan の Workflow の返り値の plan と plan_sum をそのまま渡す）'
  if (plan.state_sum !== stateSum) return 'plan が別の state で作られている'
  if (!['approved', 'no_change'].includes(plan.status)) return `plan.status が approved・no_change でない: ${JSON.stringify(plan.status)}`
  if (!Array.isArray(plan.affected_paths) || plan.affected_paths.some((p) => !isRepoRelativePath(p))) return 'plan.affected_paths が repo 相対の path の配列でない'
  if (!Array.isArray(plan.checks)) return 'plan.checks が配列でない'
  return null
}

export function newLedger(stateSum) {
  return { state_sum: stateSum, plan_sum: null, rounds: [], baseline: null, checks: [], reviews: [] }
}

export function admitPlan(ledger, planSum) {
  return { ...ledger, plan_sum: planSum }
}

export function requireAdmitted(ledger, planSum) {
  if (ledger.plan_sum !== planSum) throw new ImplementError(CODES.state, 'この plan は inventory で受け入れていない（実装の前に implementation なしの inventory を呼ぶ）')
}

// 修正の回数は check の修正と review の修正の合計で、round は 0 から 1 ずつ増え、戻らない。上限は implement の Workflow source が持つ。
export function recordRound(ledger, implementation) {
  const expected = ledger.rounds.length
  if (implementation.repairRound !== expected) {
    throw new ImplementError(CODES.state, `repairRound は ${expected} でなければならない（${implementation.repairRound}）。round は戻さない`)
  }
  return { ...ledger, rounds: [...ledger.rounds, { round: expected, status: implementation.status, touched: [...implementation.touched_paths] }] }
}

export function implementationProblem(implementation) {
  if (!implementation || typeof implementation !== 'object' || Array.isArray(implementation)) return 'implementation がオブジェクトでない'
  const { sum, ...rest } = implementation
  if (fnvSum(rest) !== sum) return 'implementation の sum が合わない（implement の Workflow の返り値をそのまま渡す）'
  if (!Number.isSafeInteger(implementation.repairRound) || implementation.repairRound < 0) return 'implementation.repairRound が 0 以上の整数でない'
  if (typeof implementation.status !== 'string') return 'implementation.status が文字列でない'
  if (!Array.isArray(implementation.touched_paths) || implementation.touched_paths.some((p) => !isRepoRelativePath(p))) return 'implementation.touched_paths が repo 相対の path の配列でない'
  return null
}

const diff = (a, b) => [...new Set(a)].filter((x) => !b.includes(x)).sort()

// actual は開始時 HEAD からの変更の path（preserved を除く）、preservedNow は preserved の今の digest。
export function inventoryProblems({ state, plan, head, actual, preservedNow, touched }) {
  const problems = []
  if (head !== state.head) problems.push({ cause: 'head_changed', message: `HEAD が開始時 ${state.head} から ${head} に変わった`, paths: [] })
  const outside = diff(actual, plan.affected_paths)
  if (outside.length) problems.push({ cause: 'outside_plan', message: 'plan.affected_paths の外の path が変わった', paths: outside })
  if (touched !== null) {
    const undeclared = diff(actual, touched)
    if (undeclared.length) problems.push({ cause: 'undeclared', message: 'implementer が touched_paths に挙げていない path が変わった', paths: undeclared })
  }
  const changed = state.preserved.filter((p) => preservedNow[p.path] !== p.digest).map((p) => p.path).sort()
  if (changed.length) problems.push({ cause: 'preserved_changed', message: '開始時からあった変更（preservedPaths）の内容か有無が変わった', paths: changed })
  return problems
}

export function reviewProblem(review, state) {
  if (!review || typeof review !== 'object' || Array.isArray(review)) return 'review が repo-review の返り値のオブジェクトでない'
  if (!['completed', 'review_incomplete'].includes(review.status)) return `review.status が completed・review_incomplete でない: ${JSON.stringify(review.status)}`
  if (review.mode !== 'working_tree') return `review.mode が working_tree でない: ${JSON.stringify(review.mode)}`
  if (review.headSha !== state.head || review.baseRef !== state.head) return 'review の headSha・baseRef が開始時 HEAD でない'
  if (review.policyRef !== state.policyRef) return 'review の policyRef が開始時の policyRef でない'
  for (const key of ['findings', 'unverified', 'reasons']) if (!Array.isArray(review[key])) return `review.${key} が配列でない`
  return null
}

export function reviewRecord(review, round, snapshot) {
  return {
    round,
    snapshot,
    status: review.status,
    reasons: [...review.reasons],
    findings: review.findings.length,
    unverified: review.unverified.length,
    passed: review.status === 'completed' && review.findings.length === 0 && review.unverified.length === 0,
  }
}

export function checkRecord(phase, round, before, after, head, results) {
  return { phase, round, head, snapshot_before: before, snapshot_after: after, tree_changed: before !== after, results }
}

// 変更が起こした失敗と言えるのは、開始時（実装の前）に同じ check が成功していたときだけ。
export function baselineVerdict(baseline, check) {
  const hit = baseline?.results.find((r) => checkKey(r.check) === checkKey(check))
  if (!hit || hit.exit_code === undefined || hit.not_run) return null
  return hit.exit_code !== 0
}

export function verifyProblems({ state, ledger, plan, head, actual, preservedNow, snapshot }) {
  const touched = ledger.rounds.flatMap((r) => r.touched)
  const problems = inventoryProblems({ state, plan, head, actual, preservedNow, touched: ledger.rounds.length ? touched : null })
  if (actual.length === 0) return problems
  const lastRound = ledger.rounds.length - 1
  if (lastRound < 0) problems.push({ cause: 'no_round', message: '実装の round が記録されていない', paths: [] })
  const run = [...ledger.checks].reverse().find((c) => c.phase === 'after')
  if (!run || run.round !== lastRound) {
    problems.push({ cause: 'checks_missing', message: '最後の round の後の run-checks が記録されていない', paths: [] })
  } else {
    const ran = new Map(run.results.map((r) => [checkKey(r.check), r]))
    const failed = plan.checks.filter((c) => ran.get(checkKey(c))?.exit_code !== 0).map(checkKey)
    if (failed.length) problems.push({ cause: 'checks_failed', message: '成功していない check がある', paths: failed })
    if (run.tree_changed) problems.push({ cause: 'checks_changed_tree', message: 'check の実行中に作業ツリーが変わった', paths: [] })
    if (run.snapshot_after !== snapshot) problems.push({ cause: 'changed_since_checks', message: '最後に check を通した後に作業ツリーが変わった', paths: [] })
  }
  const review = ledger.reviews.at(-1)
  if (!review || review.round !== lastRound) {
    problems.push({ cause: 'review_missing', message: '最後の round の後の review が記録されていない', paths: [] })
  } else {
    if (!review.passed) problems.push({ cause: 'review_not_passed', message: `review が通っていない（status ${review.status}・findings ${review.findings}・unverified ${review.unverified}）`, paths: review.reasons })
    if (review.snapshot !== snapshot) problems.push({ cause: 'changed_since_review', message: '最後に review を通した後に作業ツリーが変わった', paths: [] })
    if (run && review.snapshot !== run.snapshot_after) problems.push({ cause: 'review_not_on_checked_tree', message: 'review した作業ツリーが最後に check を通した作業ツリーと違う', paths: [] })
  }
  return problems
}
