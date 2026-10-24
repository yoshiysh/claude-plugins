import { createHash } from 'node:crypto'

export const CODES = Object.freeze({
  input: 'E_INPUT',
  pin: 'E_PIN',
  check: 'E_CHECK',
  state: 'E_STATE',
  io: 'E_IO',
  internal: 'E_INTERNAL',
})

// check の許可リストの正本。make の target は Makefile の検証の入口に限る。必須 check は AGENTS.md「検証」の合否ゲート。
export const MAKE_TARGETS = Object.freeze(['test', 'check', 'portability', 'traceability', 'traceability-complete'])
export const NODE_TEST_SUFFIX = '.test.mjs'
export const CHECK_KINDS = Object.freeze(['make', 'node-test'])
export const REQUIRED_CHECKS = Object.freeze([Object.freeze({ kind: 'make', value: 'test' })])
export const PHASES = Object.freeze(['baseline', 'after'])
export const OUTPUT_TAIL_LINES = 40
export const MAIN_BRANCH = 'main'
// 方針の版は主ブランチの先端（REVIEW.md「レビュー方針は基底ブランチの REVIEW.md」）。作業 branch の commit が規約を変えていても、その変更で同じ変更を免責しない。
export const DEFAULT_POLICY_REF = `origin/${MAIN_BRANCH}`

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
  // - で始まる値は node の flag に、glob の文字を含む値は node --test の glob として読まれ、別のファイルを実行し得る。
  if (!isRepoRelativePath(check.value) || check.value.startsWith('-') || /[*?[\]{}]/.test(check.value)) return `node --test の path が repo 相対の正規形でない: ${JSON.stringify(check.value)}`
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

// 「変更の集合」の正本は repo-review の working_tree と同じ定義（HEAD との差分 ∪ ignore されない未追跡のファイル）。
// git status にだけ出る path（未追跡の入れ子の repo は末尾に / が付く、index だけが HEAD と違い作業ツリーは HEAD と同じ path）は、
// この集合に無いか正規形の path でないので、preserved にも照合の対象にもできない。start はそれを拒否する。
export function unreviewablePaths(statusPaths, changeSet) {
  return statusPaths.filter((p) => !isRepoRelativePath(p) || !changeSet.includes(p)).sort()
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
  if (typeof state.snapshot !== 'string') return 'state.snapshot が無い'
  return null
}

export function planProblem(plan, planSum, state, stateSum) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) return 'plan がオブジェクトでない'
  if (fnvSum(plan) !== planSum) return 'plan と planSum が合わない（plan の Workflow の返り値の plan と plan_sum をそのまま渡す）'
  if (plan.state_sum !== stateSum) return 'plan が別の state で作られている'
  if (!['approved', 'no_change'].includes(plan.status)) return `plan.status が approved・no_change でない: ${JSON.stringify(plan.status)}`
  if (!Array.isArray(plan.affected_paths) || plan.affected_paths.some((p) => !isRepoRelativePath(p))) return 'plan.affected_paths が repo 相対の path の配列でない'
  if (plan.status === 'approved' && plan.affected_paths.length === 0) return '承認済みの plan に affected_paths が無い'
  if (!Array.isArray(plan.checks)) return 'plan.checks が配列でない'
  return null
}

// 承認済みの plan の check は、許可リストに収まり、必須の check を全て含む。変更不要の plan は check を持たない。
export function planCheckProblems(plan) {
  const problems = plan.checks.map((c) => checkProblem(c, plan.affected_paths)).filter(Boolean)
  if (plan.status === 'approved') {
    const keys = plan.checks.map((c) => (c && typeof c === 'object' ? checkKey(c) : null))
    for (const required of REQUIRED_CHECKS) if (!keys.includes(checkKey(required))) problems.push(`必須の check ${checkKey(required)} が無い`)
  } else if (plan.checks.length) problems.push('変更不要の plan が check を持つ')
  return problems
}

// ledger.snapshot は、CLI が最後に受け入れた作業ツリーの snapshot。段の外での書き込みは、次の段でこれと食い違って見つかる。
export function newLedger(stateSum, snapshot) {
  return { state_sum: stateSum, snapshot, plan_sum: null, rounds: [], open: null, baseline: null, checks: [], reviews: [], terminal: null }
}

export function requireLive(ledger, step) {
  if (ledger.terminal) throw new ImplementError(CODES.state, `${step}: この run は abandon で終わっている（${ledger.terminal.reason}）`)
}

// 最後の round が実装を終え、inventory の照合を通ったときだけ、その後の段（check・レビュー・次の修正）へ進める。
export function requireLastRoundPassed(ledger, step) {
  const last = ledger.rounds.at(-1)
  if (!last) throw new ImplementError(CODES.state, `${step}: 実装の round が無い`)
  if (last.status !== 'ready_for_check' || !last.passed) {
    throw new ImplementError(CODES.state, `${step}: 最後の round ${last.round} が通っていない（status ${last.status}・inventory ${last.passed ? '通過' : '不通過'}）。abandon で終えて報告する`)
  }
}

export function runsOf(ledger, round) {
  return ledger.checks.filter((c) => c.phase === 'after' && c.round === round)
}

export function reviewsOf(ledger, round) {
  return ledger.reviews.filter((r) => r.round === round)
}

export function requireAdmitted(ledger, planSum) {
  if (ledger.plan_sum !== planSum) throw new ImplementError(CODES.state, 'この plan は inventory で受け入れていない（実装の前に implementation なしの inventory を呼ぶ）')
}

export function requireUnchanged(ledger, snapshot, step) {
  if (ledger.snapshot !== snapshot) throw new ImplementError(CODES.state, `${step}: 作業ツリーが CLI の記録の外で変わった（最後に記録した snapshot と違う）`)
}

export function requireClosed(ledger, step) {
  if (ledger.open) throw new ImplementError(CODES.state, `${step}: round ${ledger.open.round} の実装を inventory で閉じていない`)
}

export const REPAIRS = Object.freeze(['checks', 'review'])

export function isConfirmedFinding(f) {
  return Boolean(f && isRepoRelativePath(f.path) && Number.isSafeInteger(f.line) && f.line > 0 && typeof f.in_target === 'boolean'
    && f.claim && ['severity', 'summary', 'condition', 'impact', 'evidence', 'rule'].every((k) => typeof f.claim[k] === 'string' && f.claim[k].trim())
    && Array.isArray(f.votes) && f.votes.some((v) => v?.vote === 'confirmed'))
}

export function insidePlan(f, plan) {
  return f.in_target && plan.affected_paths.includes(f.path)
}

// 修正の入力は CLI の記録から取る（司令塔が選ばない）。check の修正は直前の round の後の run の repairable な失敗、レビューの修正は直前の round の後のレビューの確定指摘。
export function roundTicket(ledger, plan, planSum, repair) {
  const round = ledger.rounds.length
  if (ledger.baseline === null) throw new ImplementError(CODES.state, '実装の前に baseline の run-checks を流す')
  if (round === 0) {
    if (repair !== null) throw new ImplementError(CODES.input, '最初の実装（round 0）に修正の入力は無い（repair は null）')
    return { ticket: { round, plan_sum: planSum, state_sum: ledger.state_sum, snapshot: ledger.snapshot, repair: null, findings: [], checkFailures: [] } }
  }
  if (!REPAIRS.includes(repair)) throw new ImplementError(CODES.input, `round ${round} は修正の回で、repair は ${REPAIRS.join('・')} のどれか`)
  requireLastRoundPassed(ledger, 'begin-round')
  const runs = runsOf(ledger, round - 1)
  if (!runs.length) throw new ImplementError(CODES.state, `round ${round - 1} の実装の後の run-checks が無い`)
  if (repair === 'checks') {
    const checkFailures = runs.flatMap((r) => r.results).filter((r) => r.repairable === true)
    if (!checkFailures.length) throw new ImplementError(CODES.state, '直前の run に、変更が起こしたと決められる失敗が無い')
    return { ticket: { round, plan_sum: planSum, state_sum: ledger.state_sum, snapshot: ledger.snapshot, repair, findings: [], checkFailures } }
  }
  const review = reviewsOf(ledger, round - 1).at(-1)
  if (!review) throw new ImplementError(CODES.state, `round ${round - 1} の後のレビューが記録されていない`)
  if (!review.findingsDetail.length) throw new ImplementError(CODES.state, '直前のレビューに確定指摘が無い')
  const outside = review.findingsDetail.filter((f) => !insidePlan(f, plan))
  if (outside.length) return { needsReplan: outside }
  return { ticket: { round, plan_sum: planSum, state_sum: ledger.state_sum, snapshot: ledger.snapshot, repair, findings: review.findingsDetail, checkFailures: [] } }
}

export function implementationProblem(implementation, open) {
  if (!implementation || typeof implementation !== 'object' || Array.isArray(implementation)) return 'implementation がオブジェクトでない'
  const { sum, ...rest } = implementation
  if (fnvSum(rest) !== sum) return 'implementation の sum が合わない（implement の Workflow の返り値をそのまま渡す）'
  if (!open) return '開いている round が無い（begin-round の券で実装の Workflow を呼ぶ）'
  if (implementation.ticket_sum !== open.ticket_sum || implementation.repairRound !== open.round) return '返り値が開いている round の券のものでない'
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
  if (changed.length) problems.push({ cause: 'preserved_changed', message: '開始時からあった変更（preservedPaths）の内容・有無・index の状態が変わった', paths: changed })
  return problems
}

// 実装したと申告した round は作業ツリーを動かし、失敗した round は動かさない。どちらに外れても申告と実際が違う。
export function roundEffectProblems(status, before, after) {
  if (status === 'ready_for_check' && before === after) return [{ cause: 'no_effect', message: '実装したと返したのに作業ツリーが変わっていない', paths: [] }]
  if (status !== 'ready_for_check' && before !== after) return [{ cause: 'changed_on_failure', message: `status ${status} の実装が作業ツリーを変えた`, paths: [] }]
  return []
}

const sortedEq = (a, b) => canonical([...a].sort()) === canonical([...b].sort())

// repo-review の返り値と、その plan 操作が書いた計画のファイル（plan_path・plan_sum）を照らす。計画の digest で、今の作業ツリーの内容を
// レビューしたことを確かめる（返り値そのものには内容の digest が無い）。
export function reviewShapeProblems(review) {
  const problems = []
  if (!review || typeof review !== 'object' || Array.isArray(review)) return ['review が repo-review の返り値のオブジェクトでない']
  const { sum, ...rest } = review
  if (typeof sum !== 'string' || fnvSum(rest) !== sum) problems.push('review の sum が無いか本文と合わない（repo-review の Workflow の返り値をそのまま渡す）')
  if (!Array.isArray(review.target?.files) || review.target.files.some((f) => !isRepoRelativePath(f))) problems.push('review.target.files が repo 相対の path の配列でない')
  return problems
}

export function reviewProblems({ review, reviewPlan, state, actual, digests }) {
  const problems = reviewShapeProblems(review)
  if (problems.length) return problems
  if (!['completed', 'review_incomplete'].includes(review.status)) problems.push(`review.status が completed・review_incomplete でない: ${JSON.stringify(review.status)}`)
  for (const key of ['findings', 'unverified', 'reasons', 'excluded', 'generated', 'preserved']) if (!Array.isArray(review[key])) problems.push(`review.${key} が配列でない`)
  // 途中で止まった review_incomplete（pin の崩れ・運搬の失敗）は coverage を持たない。completed は観点ごとの coverage と崩れなかった pin を持つ。
  if (review.status === 'completed') {
    const lensIds = (reviewPlan.reviewers ?? []).map((r) => r.id)
    if (!Array.isArray(review.coverage) || !sortedEq(review.coverage.map((c) => c?.id), lensIds)) problems.push('review の coverage の観点が計画のファイルの reviewers と違う（Workflow を走らせた返り値でない）')
    if (review.pin?.ok !== true) problems.push('completed の review に、最後まで崩れなかった pin が無い')
  }
  if (problems.length) return problems
  if (review.findings.some((f) => !isConfirmedFinding(f))) problems.push('review.findings に repo-review が確定した指摘の形でないものがある')
  if (review.mode !== 'working_tree' || reviewPlan.mode !== 'working_tree') problems.push('review が working_tree モードでない')
  if (review.headSha !== state.head || review.baseRef !== state.head) problems.push('review の headSha・baseRef が開始時の HEAD でない')
  if (review.policyRef !== state.policyRef) problems.push('review の policyRef が開始時の policyRef でない')
  if ((review.scope ?? null) !== null) problems.push('review に scope がある（working_tree は変更の全体をレビューする）')
  for (const key of ['headSha', 'baseRef', 'policyRef']) if (review[key] !== reviewPlan[key]) problems.push(`review の ${key} が計画のファイルと違う`)
  if (!sortedEq(review.target.files, reviewPlan.target?.files ?? [])) problems.push('review の対象が計画のファイルの対象と違う')
  for (const key of ['excluded', 'generated', 'preserved']) if (!sortedEq(review[key], reviewPlan[key] ?? [])) problems.push(`review の ${key} が計画のファイルと違う`)
  if (!sortedEq(review.preserved, state.preserved.map((p) => p.path))) problems.push('review の preserved が開始時の preservedPaths と違う')
  if (!sortedEq([...review.target.files, ...review.excluded, ...review.generated], actual)) problems.push('review の対象・除外・生成物の和が今の変更の集合と違う')
  const stale = review.target.files.filter((f) => (reviewPlan.digests?.[f] ?? null) !== digests[f])
  if (stale.length) problems.push(`review した内容が今の内容と違う: ${JSON.stringify(stale)}`)
  return problems
}

// 1 round のレビューの記録は 1 回。やり直せるのは前の記録が review_incomplete のときだけで、そのときも前の確定指摘は消さずに和を取る
// （指摘 0 件が出るまで回し直して通すことを防ぐ）。
export function reviewRecord(review, round, snapshot, previous = []) {
  if (previous.some((r) => r.status !== 'review_incomplete')) {
    throw new ImplementError(CODES.state, `round ${round} のレビューは既に記録した（やり直せるのは review_incomplete の後だけ）`)
  }
  const seen = new Set()
  const findingsDetail = [...previous.flatMap((r) => r.findingsDetail), ...review.findings].filter((f) => {
    const key = canonical(f)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  return {
    round,
    snapshot,
    status: review.status,
    reasons: [...review.reasons],
    findings: findingsDetail.length,
    findingsDetail,
    unverified: review.unverified.length,
    passed: review.status === 'completed' && findingsDetail.length === 0 && review.unverified.length === 0,
  }
}

export function checkRecord(phase, round, before, after, head, results) {
  return { phase, round, head, snapshot_before: before, snapshot_after: after, tree_changed: before !== after, results }
}

// 変更が起こした失敗と言えるのは、開始時（実装の前）に同じ check が成功していたか、開始時にまだ無かったテストの check のとき。
export function baselineVerdict(baseline, check) {
  const hit = baseline?.results.find((r) => checkKey(r.check) === checkKey(check))
  if (!hit) return null
  if (hit.not_run) return false
  return hit.exit_code !== 0
}

export function verifyProblems({ state, ledger, plan, head, actual, preservedNow, snapshot }) {
  const touched = ledger.rounds.flatMap((r) => r.touched)
  const problems = inventoryProblems({ state, plan, head, actual, preservedNow, touched: ledger.rounds.length ? touched : null })
  if (ledger.terminal) problems.push({ cause: 'terminated', message: `この run は abandon で終わっている（${ledger.terminal.reason}）`, paths: [] })
  if (ledger.open) problems.push({ cause: 'round_open', message: `round ${ledger.open.round} を inventory で閉じていない`, paths: [] })
  if (ledger.snapshot !== snapshot) problems.push({ cause: 'changed_outside_steps', message: '作業ツリーが CLI の記録の外で変わった', paths: [] })
  if (plan.status === 'no_change') {
    if (ledger.rounds.length || actual.length) problems.push({ cause: 'changed_for_no_change_plan', message: '変更不要の plan なのに実装の round か変更がある', paths: actual })
    return problems
  }
  const lastRound = ledger.rounds.length - 1
  if (lastRound < 0 || actual.length === 0) problems.push({ cause: 'not_implemented', message: '承認済みの plan の変更が作業ツリーに無い', paths: [] })
  if (lastRound < 0) return problems
  const last = ledger.rounds[lastRound]
  if (last.status !== 'ready_for_check' || !last.passed) problems.push({ cause: 'last_round_not_passed', message: `最後の round ${lastRound} が通っていない（status ${last.status}）`, paths: [] })
  // 同じ round の run は全てを数える。失敗した run の後に通るまで回し直しても、失敗は消えない。
  const runs = runsOf(ledger, lastRound)
  const run = runs.at(-1)
  if (!run) {
    problems.push({ cause: 'checks_missing', message: '最後の round の後の run-checks が記録されていない', paths: [] })
  } else {
    const failed = plan.checks.filter((c) => runs.some((r) => r.results.find((x) => checkKey(x.check) === checkKey(c))?.exit_code !== 0)).map(checkKey)
    if (failed.length) problems.push({ cause: 'checks_failed', message: '最後の round の run のどれかで成功していない check がある', paths: failed })
    if (runs.some((r) => r.tree_changed)) problems.push({ cause: 'checks_changed_tree', message: 'check の実行中に作業ツリーが変わった', paths: [] })
    if (run.snapshot_after !== snapshot) problems.push({ cause: 'changed_since_checks', message: '最後に check を通した後に作業ツリーが変わった', paths: [] })
  }
  const review = reviewsOf(ledger, lastRound).at(-1)
  if (!review) {
    problems.push({ cause: 'review_missing', message: '最後の round の後の review が記録されていない', paths: [] })
  } else {
    if (!review.passed) problems.push({ cause: 'review_not_passed', message: `review が通っていない（status ${review.status}・findings ${review.findings}・unverified ${review.unverified}）`, paths: review.reasons })
    if (review.snapshot !== snapshot) problems.push({ cause: 'changed_since_review', message: '最後に review を通した後に作業ツリーが変わった', paths: [] })
    if (run && review.snapshot !== run.snapshot_after) problems.push({ cause: 'review_not_on_checked_tree', message: 'review した作業ツリーが最後に check を通した作業ツリーと違う', paths: [] })
  }
  return problems
}
