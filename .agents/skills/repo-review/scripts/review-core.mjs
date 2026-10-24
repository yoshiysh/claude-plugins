import path from 'node:path'

export const MODES = Object.freeze(['diff', 'working_tree', 'audit'])
export const MIN_REVIEWERS = 2
export const LENS_ID = /^[a-z][a-z0-9-]*$/
export const SKILL_DESIGN_LENS = 'skill-design'
// このスキルが足す「スキル設計」の観点の適用範囲（スキルの実体の置き場は AGENTS.md「現在の実体」）。tests/fixtures の題材は当てない。
export const SKILL_DESIGN_TARGETS = Object.freeze([
  'plugins/*/skills/*/SKILL.md', '.agents/skills/*/SKILL.md',
  'plugins/*/skills/*/agents/*.md', '.agents/skills/*/agents/*.md',
])
// Workflow source を探す場所。best-practices.md §13「script の置き場」の 2 つの置き場（<skill>/scripts と plugin の workflows）を glob にしたもの。
export const WORKFLOW_SOURCE_PATHS = Object.freeze(['plugins/*/workflows/*.js', 'plugins/*/skills/*/scripts/*.js', '.agents/skills/*/scripts/*.js'])
// runner は先頭の文が export const meta = {…} であることを求める。先頭の空白・コメントを読み飛ばしてから見る（meta の中身が literal かまでは見ない）。
const LEADING_TRIVIA = /^(?:\s+|\/\/[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*/
const WORKFLOW_SOURCE_HEAD = /^export\s+const\s+meta\s*=\s*\{/
export const VERDICTS = Object.freeze(['confirmed', 'refuted', 'unverified'])
// 検証の段の数。1 段目は候補ごとに 1 体、2 段目は決着しなかった主張に残りの観点を全て当てる（best-practices の schemas.md「refuter の出力」）。
export const VERIFY_ROUNDS = 2
// 結果を返したが信用しない reviewer の status と、その意味。merge が untrusted の各項目の meaning に載せる（意味の正本はここだけ）。
const UNTRUSTED_STATUSES = Object.freeze({
  head_mismatch: 'reviewer が見た HEAD が計画と違う。別の版の内容を指し得る',
  pack_unread: 'reviewer が方針の束を読めなかった。全員に共通の方針で判断していない',
  forbidden_reads: 'reviewer が読まない path（分類の正本は unreadableClassifier）を読んだ。読んではいけない内容に依り得る',
})
// 根拠の申告のうち、記録だけにする分類と、その意味。merge が ignoredSupporting の各項目の meaning に載せる（意味の正本はここだけ）。
const IGNORED_KINDS = Object.freeze({
  policy_pack: '方針の束そのもの。方針の根拠は policy_sections に節の ID で返す',
  outside_repo: 'repo の外の path（スキル自身の指示文書など）。根拠は repo の中のファイルに限る',
  not_path: 'repo 相対の path として読めない',
})
export const CODES = Object.freeze({ input: 'E_INPUT', pin: 'E_PIN', plan: 'E_PLAN', policy: 'E_POLICY', transport: 'E_TRANSPORT', io: 'E_IO', internal: 'E_INTERNAL' })
// CLI の拒否に付ける、caller の次の手。replan は前処理の 3（plan）からやり直せば直り得るもの、none はやり直しても同じ答えになるもの。
export const RETRY = Object.freeze({ replan: 'replan', none: 'none' })
// pin が崩れた原因と mode の組ごとの次の手と、それを行う主体（user は利用者の操作で caller は利用者に伝える、caller は caller が行う）。
// 次の手の正本はここだけで、SKILL.md は pin.causes[] の by と action を参照する。
const ANY = '*'
export const PIN_ACTIONS = Object.freeze({
  commits: { [ANY]: { by: 'caller', action: '手元に無い commit を git fetch で取ってから、前処理からやり直す' } },
  head: {
    diff: { by: 'user', action: '作業ツリーを headSha の checkout に戻してもらう（切り替えは利用者の操作）。戻った後に caller が前処理からやり直す' },
    [ANY]: { by: 'caller', action: 'HEAD が動いた。今の HEAD を headSha にして前処理からやり直す' },
  },
  worktree: { diff: { by: 'user', action: '作業ツリーの変更・未追跡のファイルを片付けてもらう（片付けは利用者の操作）。片付いた後に caller が前処理からやり直す' } },
  preserved: { [ANY]: { by: 'caller', action: 'preservedPaths を変更の集合にある path だけにして、前処理からやり直す' } },
  changed: { [ANY]: { by: 'caller', action: '計画の後に対象か方針が変わった。今の内容で前処理からやり直す' } },
  pack: { [ANY]: { by: 'caller', action: '方針の束が変わったか消えた。新しい stateDir で前処理の 3 からやり直す' } },
  collect: { [ANY]: { by: 'caller', action: '対象を集め直せなかった（scope の消失・git の失敗など）。problems の原因を確かめ、直せるなら直して前処理からやり直す' } },
})

export function pinAction(cause, mode) {
  const row = PIN_ACTIONS[cause]
  const hit = row?.[mode] ?? row?.[ANY]
  if (!hit) throw new ReviewError(CODES.internal, `pin の原因 ${cause} に mode ${mode} の次の手が無い`)
  return hit
}

const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/

export class ReviewError extends Error {
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

export { canonical, fnvSum }

export function isRepoPath(file) {
  return typeof file === 'string'
    && file.length > 0
    && !file.startsWith('/')
    && !file.includes('\\')
    && file.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..')
}

export function isWorkflowSource(text) {
  return WORKFLOW_SOURCE_HEAD.test(text.replace(LEADING_TRIVIA, ''))
}

export function globToRegExp(pattern) {
  return new RegExp(`^${pattern
    .split(/(\*\*\/|\*\*|\*)/)
    .map((part) => (part === '**/' ? '(?:.*/)?'
      : part === '**' ? '.*'
        : part === '*' ? '[^/]*'
          : part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')))
    .join('')}$`)
}

export function matcher(patterns) {
  const res = patterns.map(globToRegExp)
  return (file) => res.some((re) => re.test(file))
}

const order = (a, b) => (a < b ? -1 : a > b ? 1 : 0)

function sorted(list) {
  return [...new Set(list)].sort(order)
}

function duplicates(list) {
  const seen = new Set()
  const out = new Set()
  for (const x of list) {
    if (seen.has(x)) out.add(x)
    seen.add(x)
  }
  return [...out].sort(order)
}

function fail(code, problems) {
  throw new ReviewError(code, problems.join('; '), { problems })
}

const isObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x)
const isStringArray = (x) => Array.isArray(x) && x.every((s) => typeof s === 'string')
const isCount = (x) => Number.isInteger(x) && x >= 0

function checkStringList(name, list, problems, { allowEmpty = true } = {}) {
  if (!Array.isArray(list)) {
    problems.push(`${name} は配列でなければならない`)
    return
  }
  if (!allowEmpty && list.length === 0) problems.push(`${name} は空にできない`)
  const bad = list.filter((p) => !isRepoPath(p))
  if (bad.length) problems.push(`${name} にリポジトリ相対の正規のパスでないものがある: ${JSON.stringify(bad)}`)
  const dup = duplicates(list)
  if (dup.length) problems.push(`${name} に重複がある: ${JSON.stringify(dup)}`)
}

// 監査の範囲だけは「.」（リポジトリ全体）を受ける。それ以外の . は範囲の書き方の揺れで、同じ対象が別の名前で入る。
export function checkRequest(request, { requireReviewers }) {
  const problems = []
  const r = isObject(request) ? request : {}
  if (typeof r.repo !== 'string' || !r.repo.startsWith('/')) problems.push('repo は絶対パスでなければならない')
  if (!MODES.includes(r.mode)) problems.push(`mode は ${MODES.join('・')} のどれか`)
  if (!SHA.test(r.headSha ?? '')) problems.push('headSha は完全な commit SHA でなければならない')
  if (!SHA.test(r.policyRef ?? '')) problems.push('policyRef は完全な commit SHA でなければならない')
  if (r.mode === 'audit') {
    if (r.baseRef !== undefined && !SHA.test(r.baseRef)) problems.push('audit の baseRef は省くか完全な commit SHA にする')
    if (!Array.isArray(r.scope) || r.scope.length === 0) problems.push('audit は scope（監査するパスの一覧）が要る')
    else if (!(r.scope.length === 1 && r.scope[0] === '.')) checkStringList('scope', r.scope, problems, { allowEmpty: false })
  } else {
    if (!SHA.test(r.baseRef ?? '')) problems.push(`${r.mode} は baseRef に完全な commit SHA が要る`)
    if (r.scope !== undefined) problems.push('scope は audit だけが持つ')
  }
  if (r.preservedPaths !== undefined) {
    if (r.mode !== 'working_tree') problems.push('preservedPaths は working_tree だけが持つ')
    else checkStringList('preservedPaths', r.preservedPaths, problems)
  }
  if (requireReviewers) checkReviewers(r.reviewers, problems)
  else if (r.reviewers !== undefined) problems.push('inventory は reviewers を受けない')
  if (problems.length) fail(CODES.input, problems)
  return {
    repo: r.repo.replace(/\/+$/, '') || '/',
    mode: r.mode,
    ...(r.baseRef === undefined ? {} : { baseRef: r.baseRef }),
    headSha: r.headSha,
    policyRef: r.policyRef,
    ...(r.mode === 'audit' ? { scope: [...r.scope] } : {}),
    preservedPaths: r.mode === 'working_tree' ? sorted(r.preservedPaths ?? []) : [],
    ...(requireReviewers ? { reviewers: r.reviewers.map((x) => ({ id: x.id, focus: x.focus, files: [...x.files] })) } : {}),
  }
}

function checkReviewers(reviewers, problems) {
  if (!Array.isArray(reviewers) || reviewers.length < MIN_REVIEWERS) {
    problems.push(`reviewers は ${MIN_REVIEWERS} 人以上の配列でなければならない`)
    return
  }
  for (const [i, x] of reviewers.entries()) {
    if (!isObject(x)) {
      problems.push(`reviewers[${i}] がオブジェクトでない`)
      continue
    }
    if (typeof x.id !== 'string' || !LENS_ID.test(x.id)) problems.push(`reviewers[${i}].id は ${LENS_ID} に合わなければならない`)
    if (typeof x.focus !== 'string' || !x.focus.trim()) problems.push(`reviewers[${i}].focus が空`)
    checkStringList(`reviewers[${i}].files`, x.files, problems, { allowEmpty: false })
  }
  const dup = duplicates(reviewers.map((x) => x?.id))
  if (dup.length) problems.push(`reviewers の id が重複している: ${JSON.stringify(dup)}`)
}

// 1 つのパスは 1 つの区分にだけ入る。優先は「呼び出し側の作業中の変更 > 読まない path > 生成物 > レビュー対象」。
export function partition(paths, { excludePaths, generatedPaths, preservedPaths = [] }) {
  const isExcluded = matcher(excludePaths)
  const isGenerated = matcher(generatedPaths)
  const preserved = new Set(preservedPaths)
  const out = { reviewable: [], excluded: [], generated: [], preserved: [] }
  for (const file of sorted(paths)) {
    if (preserved.has(file)) out.preserved.push(file)
    else if (isExcluded(file)) out.excluded.push(file)
    else if (isGenerated(file)) out.generated.push(file)
    else out.reviewable.push(file)
  }
  return out
}

// reviewer は作業ツリーのファイルも開ける。diff で作業ツリーが head と違う内容だと、別の版の内容と行番号で候補が作られるので、head を checkout した clean な作業ツリーでだけ始める。
export function pinIssues(request, state) {
  const issues = []
  if (state.missingCommits.length) issues.push({ cause: 'commits', message: `commit が無い: ${JSON.stringify(state.missingCommits)}` })
  if (state.head !== request.headSha) issues.push({ cause: 'head', message: `HEAD ${state.head} が headSha ${request.headSha} と違う` })
  if (request.mode === 'diff' && state.dirty.length) issues.push({ cause: 'worktree', message: `diff は作業ツリーに変更・未追跡のファイルがあると始められない: ${JSON.stringify(state.dirty)}` })
  const missingPreserved = request.preservedPaths.filter((p) => !state.paths.includes(p))
  if (missingPreserved.length) issues.push({ cause: 'preserved', message: `preservedPaths に変更の無いパスがある: ${JSON.stringify(missingPreserved)}` })
  return issues
}

export function pinProblems(request, state) {
  return pinIssues(request, state).map((x) => x.message)
}

export function causesOf(issues, mode) {
  return sorted(issues.map((x) => x.cause)).map((cause) => ({ cause, ...pinAction(cause, mode) }))
}

export function failedPin(issues, mode) {
  return { ok: false, problems: issues.map((x) => x.message), causes: causesOf(issues, mode), changed: [] }
}

export function inventoryOf(request, state) {
  const parts = partition(state.paths, { excludePaths: state.excludePaths, generatedPaths: state.generatedPaths, preservedPaths: request.preservedPaths })
  return { head: state.head, excludePaths: state.excludePaths, generatedPaths: state.generatedPaths, ...parts }
}

export function buildPlan(request, state, details) {
  const pin = pinProblems(request, state)
  if (pin.length) fail(CODES.pin, pin)
  const inv = inventoryOf(request, state)
  const problems = []
  if (inv.reviewable.length === 0) problems.push('レビュー対象のファイルが 0 件（除外・生成物・作業中の変更だけ）')
  const target = new Set(inv.reviewable)
  const assigned = new Set(request.reviewers.flatMap((x) => x.files))
  const missing = inv.reviewable.filter((f) => !assigned.has(f))
  const outOfScope = sorted([...assigned].filter((f) => !target.has(f)))
  if (missing.length) problems.push(`どの reviewer にも割り当てていない対象がある: ${JSON.stringify(missing)}`)
  if (outOfScope.length) problems.push(`対象でないパスを割り当てている: ${JSON.stringify(outOfScope)}`)
  const isSkillDesign = matcher(SKILL_DESIGN_TARGETS)
  const skillDesignTargets = inv.reviewable.filter((f) => isSkillDesign(f) || details.workflowSources.includes(f))
  if (skillDesignTargets.length) {
    const lens = request.reviewers.find((x) => x.id === SKILL_DESIGN_LENS)
    const uncovered = lens ? skillDesignTargets.filter((f) => !lens.files.includes(f)) : skillDesignTargets
    if (uncovered.length) problems.push(`スキル設計の対象を reviewer「${SKILL_DESIGN_LENS}」に割り当てていない: ${JSON.stringify(uncovered)}`)
  }
  if (problems.length) fail(CODES.plan, problems)
  return {
    repo: request.repo,
    mode: request.mode,
    ...(request.baseRef === undefined ? {} : { baseRef: request.baseRef }),
    headSha: request.headSha,
    policyRef: request.policyRef,
    ...(request.scope ? { scope: request.scope } : {}),
    preservedPaths: request.preservedPaths,
    excludePaths: inv.excludePaths,
    generatedPaths: inv.generatedPaths,
    generatedNote: state.generatedNote,
    target: { files: inv.reviewable },
    excluded: inv.excluded,
    generated: inv.generated,
    preserved: inv.preserved,
    symlinks: details.symlinks,
    digests: request.mode === 'diff' ? null : details.digests,
    skillDesignTargets,
    reviewers: request.reviewers,
  }
}

function sameList(a, b) {
  return a.length === b.length && a.every((x, i) => x === b[i])
}

// 計画の後に commit・HEAD・方針・変更の集合・作業ツリーのバイトのどれかが動くと、指摘は計画した対象とは別の内容を指す。
export function checkPin(plan, state, details) {
  const issues = pinIssues(plan, state)
  const inv = inventoryOf(plan, state)
  for (const key of ['excludePaths', 'generatedPaths']) {
    if (!sameList(plan[key], inv[key])) issues.push({ cause: 'changed', message: `${key} が計画と違う` })
  }
  for (const key of ['reviewable', 'excluded', 'generated', 'preserved']) {
    const before = key === 'reviewable' ? plan.target.files : plan[key]
    if (!sameList(before, inv[key])) issues.push({ cause: 'changed', message: `${key} の集合が計画と違う: 計画 ${JSON.stringify(before)} 現在 ${JSON.stringify(inv[key])}` })
  }
  const changed = []
  if (plan.digests) {
    for (const file of plan.target.files) if ((details.digests[file] ?? null) !== (plan.digests[file] ?? null)) changed.push(file)
    if (changed.length) issues.push({ cause: 'changed', message: `対象の内容が計画の後に変わった: ${JSON.stringify(changed)}` })
  }
  return { ok: issues.length === 0, problems: issues.map((x) => x.message), causes: causesOf(issues, plan.mode), changed }
}

// 計画の symlinkMap（CLI が計画の作成時に作った、symlink から repo の中の実体への対応表）で、接頭辞の一致する link を実体へ置き換える。
// core はファイルシステムに触れないので、表に無い symlink は解決しない。
export function resolveSymlinks(file, symlinkMap = {}) {
  let current = file
  for (let hop = 0; hop < 16; hop += 1) {
    const link = Object.keys(symlinkMap).filter((l) => current === l || current.startsWith(`${l}/`)).sort((a, b) => b.length - a.length)[0]
    if (!link) return current
    current = `${symlinkMap[link]}${current.slice(link.length)}`
  }
  return current
}

// 読まない path の分類の正本。理由の文字列は指摘・申告の不正の理由として結果に載る。
function unreadableClassifier(plan) {
  const isExcluded = matcher(plan.excludePaths)
  const isGenerated = matcher(plan.generatedPaths)
  const preserved = new Set(plan.preserved)
  return (f) => (isExcluded(f) ? '内容を読まない path' : isGenerated(f) ? '生成物' : preserved.has(f) ? '呼び出し側の作業中の変更' : null)
}

export const PLACES = Object.freeze({ read: 'read', location: 'location' })

// symlink はこのリポジトリでは同じファイルの別名なので、どの path も symlinkMap で実体へ解決してからも禁止判定する。対象の symlink は
// リンク先の文字列として読ませている（共有の prompt）ので、対象に入る葉の link そのもの（完全一致）だけは、読んだ申告（place.kind が read）と、
// 1 行目だけを指す場所（place.kind が location で line 1、end_line が無いか 1）に限ってリンク先の禁止判定を当てない。
function unreadableMatcher(plan) {
  const classify = unreadableClassifier(plan)
  const leafTarget = (f) => Object.hasOwn(plan.symlinkMap, f) && plan.target.files.includes(f)
  const linkItself = (place) => place.kind === PLACES.read || (place.kind === PLACES.location && place.line === 1 && (place.end_line ?? 1) === 1)
  return (file, place) => {
    if (!Object.values(PLACES).includes(place?.kind)) throw new ReviewError(CODES.internal, `場所の種類が不正: ${JSON.stringify(place)}`)
    for (const f of new Set(leafTarget(file) && linkItself(place) ? [file] : [file, resolveSymlinks(file, plan.symlinkMap)])) {
      const why = classify(f)
      if (why) return why
    }
    return null
  }
}

function findingProblem(plan, unreadable, finding) {
  if (!isObject(finding) || !isRepoPath(finding.path)) return 'path がリポジトリ相対の正規のパスでない'
  const why = unreadable(finding.path, { kind: PLACES.location, line: finding.line, end_line: finding.end_line })
  if (why) return `path が${why}に当たる`
  if (plan.mode === 'audit' && !plan.target.files.includes(finding.path)) return 'audit の指摘が対象の外にある'
  if (!Number.isInteger(finding.line) || finding.line < 1) return 'line が 1 以上の整数でない'
  if (finding.end_line !== undefined && (!Number.isInteger(finding.end_line) || finding.end_line < finding.line)) return 'end_line が line より前'
  const ids = plan.policyPack.index.map((e) => e.id)
  if (!Array.isArray(finding.rule_sections) || finding.rule_sections.length === 0 || finding.rule_sections.some((id) => !ids.includes(id))) {
    return 'rule_sections が方針の束の節の ID でない'
  }
  return null
}

// macOS の /var と /private/var のように、同じ場所を指す絶対パスの別名を同一視する。
function absAliases(abs) {
  const a = path.posix.normalize(abs).replace(/\/+$/, '') || '/'
  return [...new Set([a, a.startsWith('/private/') ? a.slice('/private'.length) : `/private${a}`])]
}

export { absAliases }

// ok・forbidden 以外の分類は記録だけにする。IGNORED_KINDS に無い分類が来たら、黙って落とさず E_INTERNAL で止める。
export function ignoredEntries(classified) {
  const unknown = classified.filter((x) => !['ok', 'forbidden'].includes(x.kind) && !Object.hasOwn(IGNORED_KINDS, x.kind))
  if (unknown.length) fail(CODES.internal, [`IGNORED_KINDS に無い分類: ${JSON.stringify(unknown.map((x) => x.kind))}`])
  return classified.filter((x) => Object.hasOwn(IGNORED_KINDS, x.kind)).map((x) => ({ entry: x.entry, kind: x.kind, meaning: IGNORED_KINDS[x.kind] }))
}

// 読んだという申告（supporting_files の path と担当外の coverage）を分類する。注記は schema の別の欄（lines）にあり、ここでは path だけを見る。
// 読まない path の判定を先に、字句の正規化（`./`・`..`・`//`・repo の絶対パスとその別名）と計画の symlink 対応の範囲で行う。
// repo の外は、束と完全一致なら policy_pack、それ以外は outside_repo。repo の外・パスでないものは根拠の列挙の不備として記録するだけで、対象の読み残しにはしない。
export function classifySupporting(plan, unreadable, entry) {
  if (typeof entry !== 'string' || !entry.trim()) return { kind: 'not_path', entry }
  let rel = null
  if (entry.startsWith('/')) {
    const norm = path.posix.normalize(entry).replace(/\/+$/, '')
    const prefix = absAliases(plan.repo).find((r) => norm.startsWith(`${r === '/' ? '' : r}/`))
    if (prefix) rel = norm.slice(prefix === '/' ? 1 : prefix.length + 1)
    else return { kind: absAliases(plan.policyPack.path).includes(norm) ? 'policy_pack' : 'outside_repo', entry }
  } else {
    rel = path.posix.normalize(entry).replace(/\/+$/, '')
    if (rel === '..' || rel.startsWith('../')) return { kind: 'outside_repo', entry }
  }
  if (!isRepoPath(rel)) return { kind: 'not_path', entry }
  const why = unreadable(rel, { kind: PLACES.read })
  return why ? { kind: 'forbidden', entry, path: rel, reason: why } : { kind: 'ok', entry, path: rel }
}

function checkResultShape(res, i) {
  const ok = isObject(res) && typeof res.head_sha === 'string' && typeof res.policy_pack_token === 'string' && isStringArray(res.coverage) && Array.isArray(res.supporting_files) && res.supporting_files.every((x) => isObject(x) && typeof x.path === 'string') && isStringArray(res.policy_sections)
    && isCount(res.limitations) && Array.isArray(res.findings)
  if (!ok) fail(CODES.input, [`results[${i}] は null か {head_sha, policy_pack_token, coverage, supporting_files（{path} の配列）, policy_sections, limitations（件数）, findings} でなければならない`])
}

export function merge(plan, results) {
  if (!Array.isArray(results) || results.length !== plan.reviewers.length) fail(CODES.input, ['results は reviewers と同じ長さの配列でなければならない'])
  results.forEach((res, i) => res === null || checkResultShape(res, i))
  const unreadable = unreadableMatcher(plan)
  const packIds = plan.policyPack.index.map((e) => e.id)
  const reviewers = plan.reviewers.map((rv, i) => {
    const res = results[i]
    const base = { id: rv.id, status: 'ok', missing: [], extra: [], duplicate: [], forbiddenReads: [], ignoredSupporting: [], invalidPolicySections: [], invalidFindings: [], limitations: 0 }
    if (res === null) return { ...base, status: 'missing', missing: [...rv.files] }
    if (res.head_sha !== plan.headSha) return { ...base, status: 'head_mismatch', missing: [...rv.files] }
    // 束を読めなかった reviewer は、全員の共通の方針でない判断をしている。HEAD の食い違いと同じく指摘を検証に回さない。
    if (res.policy_pack_token !== plan.policyPack.token) return { ...base, status: 'pack_unread', missing: [...rv.files] }
    // 担当外の coverage も同じ分類にかけ、読まない path を読んだものは extra でなく forbiddenReads に振り分ける。
    const outside = res.coverage.filter((f) => !rv.files.includes(f)).map((f) => classifySupporting(plan, unreadable, f))
    const supporting = [...res.supporting_files.map((f) => classifySupporting(plan, unreadable, f.path)), ...outside.filter((x) => x.kind === 'forbidden')]
    const forbidden = supporting.filter((x) => x.kind === 'forbidden')
    const forbiddenReads = [...new Map(forbidden.map((x) => [x.path, { path: x.path, reason: x.reason }])).values()].sort((a, b) => order(a.path, b.path))
    const ignoredSupporting = ignoredEntries(supporting)
    // 読まない path を読んだ reviewer は、HEAD の食い違いと同じく担当の全てを読み残しとし、指摘を検証に回さない（読んではいけない内容に依り得る）。
    if (forbiddenReads.length) return { ...base, status: 'forbidden_reads', missing: [...rv.files], forbiddenReads, ignoredSupporting }
    return {
      ...base,
      missing: rv.files.filter((f) => !res.coverage.includes(f)),
      extra: sorted(outside.filter((x) => x.kind !== 'forbidden').map((x) => x.entry)),
      duplicate: duplicates(res.coverage),
      ignoredSupporting,
      invalidPolicySections: sorted(res.policy_sections.filter((id) => !packIds.includes(id))),
      invalidFindings: res.findings.flatMap((f, j) => {
        const why = findingProblem(plan, unreadable, f)
        return why ? [{ finding: j, reason: why }] : []
      }),
      limitations: res.limitations,
    }
  })
  const covered = new Set()
  for (const [i, rv] of reviewers.entries()) {
    if (rv.status !== 'ok') continue
    for (const f of plan.reviewers[i].files) if (!rv.missing.includes(f)) covered.add(f)
  }
  const missingCoverage = plan.target.files.filter((f) => !covered.has(f))
  const members = []
  for (const [i, rv] of reviewers.entries()) {
    if (rv.status !== 'ok') continue
    const invalid = new Set(rv.invalidFindings.map((x) => x.finding))
    for (const [j, f] of results[i].findings.entries()) {
      if (!invalid.has(j)) members.push({ reviewer: i, finding: j, path: f.path, start: f.line, end: f.end_line ?? f.line })
    }
  }
  const clusters = clusterByRange(members).map((c) => ({
    path: c.path,
    line: c.start,
    end_line: c.end,
    lens: plan.reviewers[Math.min(...c.members.map((m) => m.reviewer))].id,
    in_target: plan.target.files.includes(c.path),
    members: c.members.map((m) => [m.reviewer, m.finding]),
  }))
  const complete = missingCoverage.length === 0 && reviewers.every((rv) => rv.status === 'ok'
    && !rv.missing.length && !rv.extra.length && !rv.duplicate.length
    && !rv.invalidFindings.length && rv.limitations === 0)
  // 結果を返したが信用しない reviewer の指摘は、検証に回さず別の欄で返す（どの status がそれに当たるかは UNTRUSTED_STATUSES だけが決め、reason にその status を入れる）。
  const untrusted = reviewers.flatMap((rv, i) => (Object.hasOwn(UNTRUSTED_STATUSES, rv.status)
    ? results[i].findings.map((_, j) => ({ reviewer: i, finding: j, reason: rv.status, meaning: UNTRUSTED_STATUSES[rv.status] })) : []))
  const forbiddenReads = reviewers.flatMap((rv) => rv.forbiddenReads.map((x) => ({ reviewer: rv.id, ...x })))
  return { complete, reviewers, missingCoverage, clusters, untrusted, forbiddenReads, first: firstAssignments(plan, clusters) }
}

// 同じ path で行範囲が重なる指摘を 1 つの候補にまとめる（重なりは推移的にたどる）。隣り合うだけの範囲はまとめない。
export function clusterByRange(members) {
  const byPath = new Map()
  for (const m of members) {
    if (!byPath.has(m.path)) byPath.set(m.path, [])
    byPath.get(m.path).push(m)
  }
  const out = []
  for (const path of [...byPath.keys()].sort(order)) {
    const list = byPath.get(path).sort((a, b) => a.start - b.start || a.end - b.end || a.reviewer - b.reviewer || a.finding - b.finding)
    let current = null
    for (const m of list) {
      if (current && m.start <= current.end) {
        current.end = Math.max(current.end, m.end)
        current.members.push(m)
      } else {
        current = { path, start: m.start, end: m.end, members: [m] }
        out.push(current)
      }
    }
  }
  for (const c of out) c.members.sort((a, b) => a.reviewer - b.reviewer || a.finding - b.finding)
  return out
}

// 1 段目は候補ごとに、最初に挙げた観点の検証役 1 体が全ての主張を判定する。この並びの良し悪しは実測していない。
export function firstAssignments(plan, clusters) {
  return plan.reviewers
    .map((rv) => ({ lens: rv.id, items: clusters.flatMap((c, k) => (c.lens === rv.id ? [{ cluster: k, claims: c.members.map((_, i) => i) }] : [])) }))
    .filter((a) => a.items.length)
}

function secondAssignments(plan, clusters, pending) {
  return plan.reviewers
    .map((rv) => ({
      lens: rv.id,
      items: clusters.flatMap((c, k) => {
        const claims = pending.filter((p) => p.cluster === k).map((p) => p.claim)
        return c.lens !== rv.id && claims.length ? [{ cluster: k, claims }] : []
      }),
    }))
    .filter((a) => a.items.length)
}

function evidenceProblem(unreadable, proof) {
  if (!isObject(proof) || !isRepoPath(proof.path)) return 'evidence の path が正規のパスでない'
  if (unreadable(proof.path, { kind: PLACES.location, line: proof.line })) return 'evidence が読まない path を根拠にしている'
  if (!Number.isInteger(proof.line) || proof.line < 1) return 'evidence の line が 1 以上の整数でない'
  return null
}

function voteOf(unreadable, r) {
  if (!VERDICTS.includes(r.verdict)) return { vote: 'invalid', reason: 'verdict が confirmed・refuted・unverified のどれでもない' }
  if (!Array.isArray(r.evidence)) return { vote: 'invalid', reason: 'evidence が配列でない' }
  for (const proof of r.evidence) {
    const why = evidenceProblem(unreadable, proof)
    if (why) return { vote: 'invalid', reason: why }
  }
  if (r.verdict === 'confirmed' && r.evidence.length === 0) return { vote: 'invalid', reason: 'confirmed に evidence が無い' }
  return { vote: r.verdict === 'unverified' ? 'unreadable' : r.verdict }
}

// 1 つの段の票を割り当てと照らす。欠けた・2 回返った・不正な・読めなかった票は有効票に数えない（数えると検証していない票で決着する）。
function roundVotes(plan, unreadable, round, r) {
  if (!isObject(round) || !Array.isArray(round.verifications) || round.verifications.length !== round.assignments.length) {
    fail(CODES.input, [`rounds[${r}].verifications は assignments と同じ長さの配列でなければならない`])
  }
  const votes = []
  const diagnostics = round.assignments.map((a, ai) => {
    const v = round.verifications[ai]
    const expected = a.items.flatMap((it) => it.claims.map((claim) => `${it.cluster}:${claim}`))
    const diag = { round: r, lens: a.lens, status: 'ok', missing: [], extra: [], duplicate: [], invalid: [] }
    const record = (key, vote, reason) => {
      const [cluster, claim] = key.split(':').map(Number)
      votes.push({ cluster, claim, round: r, lens: a.lens, vote, ...(reason ? { reason } : {}) })
    }
    if (v === null) {
      expected.forEach((key) => record(key, 'missing'))
      return { ...diag, status: 'missing', missing: expected }
    }
    if (!isObject(v) || typeof v.head_sha !== 'string' || typeof v.policy_pack_token !== 'string' || !Array.isArray(v.results) || v.results.some((x) => !isObject(x))) {
      fail(CODES.input, [`rounds[${r}].verifications[${ai}] は null か {head_sha, policy_pack_token, results} でなければならない`])
    }
    const status = v.head_sha !== plan.headSha ? 'head_mismatch' : v.policy_pack_token !== plan.policyPack.token ? 'pack_unread' : null
    if (status) {
      expected.forEach((key) => record(key, 'missing'))
      return { ...diag, status, missing: expected }
    }
    const keys = v.results.map((x) => `${x.cluster}:${x.claim}`)
    diag.extra = sorted(keys.filter((k) => !expected.includes(k)))
    diag.duplicate = duplicates(keys.filter((k) => expected.includes(k)))
    for (const key of expected) {
      const hits = v.results.filter((x) => `${x.cluster}:${x.claim}` === key)
      if (hits.length === 0) {
        diag.missing.push(key)
        record(key, 'missing')
      } else if (hits.length > 1) {
        record(key, 'missing', '同じ主張に 2 回以上判定した')
      } else {
        const { vote, reason } = voteOf(unreadable, hits[0])
        if (vote === 'invalid') diag.invalid.push({ key, reason })
        record(key, vote === 'invalid' ? 'missing' : vote, reason)
      }
    }
    return diag
  })
  return { votes, diagnostics }
}

function checkAssignments(name, actual, expected) {
  if (canonical(actual) !== canonical(expected)) fail(CODES.input, [`${name} が候補から決まる割り当てと違う`])
}

// rounds が 1 つなら 1 段目の判定と 2 段目の割り当てを返し、2 つなら全観点の有効票の多数決で決める。
export function judge(plan, merged, rounds) {
  if (!isObject(merged) || !Array.isArray(merged.clusters) || merged.clusters.some((c) => !isObject(c) || typeof c.lens !== 'string' || !Array.isArray(c.members) || c.members.length === 0)) {
    fail(CODES.input, ['merged.clusters は {lens, members} の配列でなければならない'])
  }
  if (!Array.isArray(rounds) || rounds.length < 1 || rounds.length > VERIFY_ROUNDS) fail(CODES.input, [`rounds は 1〜${VERIFY_ROUNDS} 個の配列でなければならない`])
  const { clusters } = merged
  const unreadable = unreadableMatcher(plan)
  checkAssignments('rounds[0].assignments', rounds[0]?.assignments, firstAssignments(plan, clusters))
  const first = roundVotes(plan, unreadable, rounds[0], 0)
  const claims = clusters.flatMap((c, k) => c.members.map((_, i) => ({ cluster: k, claim: i })))
  const votesFor = (all, x) => all.filter((v) => v.cluster === x.cluster && v.claim === x.claim)
  const majority = Math.floor(plan.reviewers.length / 2) + 1
  const unsettled = claims.filter((x) => !votesFor(first.votes, x).some((v) => v.vote === 'confirmed'))
  // 2 段目で足せる票は残りの観点の数まで。過半数に届き得ない主張に検証役を起動しても結果は unverified から変わらない
  // （例: 観点 2 つで 1 段目の票が refuted でない主張）。
  const reachable = (x) => plan.reviewers.length - 1 >= majority
    || votesFor(first.votes, x).filter((v) => v.vote === 'refuted').length + plan.reviewers.length - 1 >= majority
  const pending = unsettled.filter(reachable)
  const second = secondAssignments(plan, clusters, pending)
  if (rounds.length === 1) {
    const verdictOf = (x) => (!unsettled.includes(x) ? 'confirmed' : pending.includes(x) ? 'pending' : 'unverified')
    const outcomes = claims.map((x) => ({ ...x, verdict: verdictOf(x), votes: votesFor(first.votes, x) }))
    return { complete: unsettled.length === 0, outcomes, second, diagnostics: first.diagnostics }
  }
  checkAssignments('rounds[1].assignments', rounds[1]?.assignments, second)
  const next = roundVotes(plan, unreadable, rounds[1], 1)
  const all = [...first.votes, ...next.votes]
  const outcomes = claims.map((x) => {
    const votes = votesFor(all, x)
    if (!unsettled.includes(x)) return { ...x, verdict: 'confirmed', votes }
    if (!pending.includes(x)) return { ...x, verdict: 'unverified', votes }
    const count = (verdict) => votes.filter((v) => v.vote === verdict).length
    const verdict = count('confirmed') >= majority ? 'confirmed' : count('refuted') >= majority ? 'refuted' : 'unverified'
    return { ...x, verdict, votes }
  })
  return { complete: outcomes.every((o) => o.verdict !== 'unverified'), outcomes, second: [], diagnostics: [...first.diagnostics, ...next.diagnostics] }
}

// REVIEW.md の「読むもの」の表から、読む文書と節を取り出す。文書は右の列の backtick の .md のパス（glob を除く）か、
// REVIEW.md が「`<path>`（以下 <別名>）」で定めた別名（左の列でも読む）。文書の後に続く「…」（前に §<番号> があれば番号も）を
// その文書の節とし、右の列で節が 1 つも付かない文書は全体を読む。取れなかった参照は理由つきで unparsed に返す（黙って落とすと見ていない文書が「無し」に化ける）。
export function parseReadingTable(reviewText) {
  const aliases = new Map([...reviewText.matchAll(/`([^`]+\.md)`（以下 ([^）]+)）/g)].map((m) => [m[2], m[1]]))
  const section = reviewText.split(/^## /m).find((x) => x.startsWith('読むもの'))
  if (!section) throw new ReviewError(CODES.policy, 'REVIEW.md に「読むもの」の節が無い')
  const rows = section.split('\n').filter((l) => /^\|/.test(l) && !/^\|[\s|:-]+$/.test(l)).slice(1)
  if (rows.length === 0) throw new ReviewError(CODES.policy, 'REVIEW.md の「読むもの」に表の行が無い')
  const docs = new Map()
  const unparsed = []
  const aliasPattern = [...aliases.keys()].map((a) => a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
  const token = new RegExp(`\`([^\`]+)\`|(?:§(\\d+))?「([^」]+)」${aliasPattern ? `|(${aliasPattern})` : ''}`, 'g')
  const entry = (path) => {
    if (!docs.has(path)) docs.set(path, { whole: false, titles: [] })
    return docs.get(path)
  }
  const scan = (cell, right) => {
    let current = null
    let titled = false
    const close = () => {
      if (current && right && !titled) entry(current).whole = true
    }
    for (const m of cell.matchAll(token)) {
      if (m[1] !== undefined || m[4] !== undefined) {
        close()
        const doc = m[4] !== undefined ? aliases.get(m[4]) : right && m[1].endsWith('.md') && !/[*?[]/.test(m[1]) ? m[1] : null
        current = doc
        titled = false
        if (doc && right) entry(doc)
        continue
      }
      const title = { title: m[3], num: m[2] === undefined ? null : Number(m[2]) }
      if (current) {
        const e = entry(current)
        if (!e.titles.some((x) => x.title === title.title && x.num === title.num)) e.titles.push(title)
        titled = true
      } else if (right || title.num !== null) {
        unparsed.push({ text: m[0], reason: '文書の無い節の参照' })
      }
    }
    close()
    const bare = cell.replace(/`[^`]*`/g, '')
    for (const m of bare.matchAll(/(?:^|[^\w./-])((?:[\w.-]+\/)+[\w.-]+\.md)(?![\w/])/g)) unparsed.push({ text: m[1], reason: 'backtick の無いパス' })
  }
  for (const row of rows) {
    const trimmed = row.trim()
    if (!trimmed.endsWith('|')) unparsed.push({ text: trimmed, reason: '表の行の末尾に | が無い' })
    const cells = trimmed.replace(/^\|/, '').replace(/\|$/, '').split('|')
    if (cells.length < 2) {
      unparsed.push({ text: trimmed, reason: '表の列が足りない' })
      continue
    }
    scan(cells[0], false)
    scan(cells.slice(1).join('|'), true)
  }
  return { docs: [...docs.entries()].map(([path, d]) => ({ path, whole: d.whole, titles: d.titles })), unparsed }
}

function titleLabel(t) {
  return t.num === null || t.num === undefined ? t.title : `§${t.num}「${t.title}」`
}

// 見出しの文字列が節の名前と同じか、先頭の「<番号>. 」を除くと同じものを、その節とする。§番号があれば、その番号の節そのものか、
// その節の中の同じ名前の見出しに限る（「§13「script の置き場」」は §13 の中の小見出しを指す）。
// 範囲は次の同じか上の深さの見出しの前まで。末尾の改行は行に数えない。
export function extractSections(text, titles) {
  const lines = text.replace(/\n$/, '').split('\n')
  const headings = []
  let fence = false
  for (const [i, line] of lines.entries()) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence
    const m = !fence && /^(#{1,6})\s+(.*?)\s*$/.exec(line)
    if (m) {
      const n = /^(\d+)\.\s*(.*)$/.exec(m[2])
      headings.push({ line: i + 1, level: m[1].length, text: m[2], num: n ? Number(n[1]) : null, rest: n ? n[2] : m[2] })
    }
  }
  const sections = []
  const missing = []
  for (const raw of titles) {
    const t = typeof raw === 'string' ? { title: raw, num: null } : raw
    const named = (x) => x.text === t.title || x.rest === t.title
    let h
    if (t.num === null) h = headings.find(named)
    else {
      const top = headings.find((x) => x.num === t.num)
      const topEnd = top && (headings.find((x) => x.line > top.line && x.level <= top.level)?.line ?? lines.length + 1)
      h = top && (named(top) ? top : headings.find((x) => x.line > top.line && x.line < topEnd && named(x)))
    }
    if (!h) {
      missing.push(titleLabel(t))
      continue
    }
    const next = headings.find((x) => x.line > h.line && x.level <= h.level)
    sections.push({ title: titleLabel(t), start: h.line, end: next ? next.line - 1 : lines.length })
  }
  return { sections, missing }
}

// 束は索引と、元のファイルの行番号を付けた本文。agent は索引から要る節だけを開き、根拠は元のファイルの path:line で書ける。
function partLabel(path, title) {
  if (!title) return `${path}（全体）`
  return title.startsWith('§') ? `${path} ${title}` : `${path}「${title}」`
}

// token は束を開いた agent だけが知る短い値で、計画の外（prompt）には出さない。agent が返した値を CLI が照らして、束を読んだかを確かめる。
export function renderPolicyPack(policyRef, parts, missing, token) {
  const body = []
  const index = []
  for (const [k, p] of parts.entries()) {
    const id = `P${k + 1}`
    const label = partLabel(p.path, p.title)
    const start = body.length + 1
    body.push(`## [${id}] ${label}`)
    for (let n = p.start; n <= p.end; n += 1) body.push(`${p.path}:${n}| ${p.lines[n - 1] ?? ''}`)
    body.push('')
    index.push({ id, path: p.path, title: p.title ?? null, source: [p.start, p.end], bodyStart: start, bodyEnd: body.length - 1 })
  }
  const missingLine = `束に入れなかったもの（見ていない）: ${missing.length ? missing.map((m) => `${m.path ? partLabel(m.path, m.title).replace('（全体）', '') : m.text}（${m.reason}）`).join('・') : '無し'}`
  const headerLength = 4 + index.length + 2
  const header = [
    `# repo-review の方針の束（policyRef ${policyRef} の REVIEW.md と、その「読むもの」の表が挙げる文書・節）`,
    '',
    `読取りトークン（policy_pack_token に返す）: ${token}`,
    '索引（束の中の行 / 元のファイルの行）:',
    ...index.map((e) => `- [${e.id}] ${partLabel(e.path, e.title)} 束の ${e.bodyStart + headerLength}-${e.bodyEnd + headerLength} 行 / 元の ${e.source[0]}-${e.source[1]} 行`),
    missingLine,
    '',
  ]
  return {
    text: [...header, ...body].join('\n'),
    index: index.map((e) => ({ id: e.id, path: e.path, title: e.title, source: e.source, pack: [e.bodyStart + headerLength, e.bodyEnd + headerLength] })),
  }
}
