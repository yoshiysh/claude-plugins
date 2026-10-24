export const MODES = Object.freeze(['diff', 'working_tree', 'audit'])
export const MIN_REVIEWERS = 2
export const SKILL_DESIGN_LENS = 'skill-design'
// このスキルが足す「スキル設計」の観点の適用範囲。REVIEW.md の「読むもの」の表とは別の、このスキル自身の規則の正本。
export const SKILL_DESIGN_TARGETS = Object.freeze([
  '**/SKILL.md',
  '**/skills/*/agents/*.md',
  'plugins/*/workflows/*.js',
  '**/skills/*/scripts/*.js',
])
export const VERDICTS = Object.freeze(['confirmed', 'refuted', 'unverified'])
export const CODES = Object.freeze({ input: 'E_INPUT', pin: 'E_PIN', plan: 'E_PLAN', transport: 'E_TRANSPORT', io: 'E_IO' })

const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
export const LENS_ID = /^[a-z][a-z0-9-]*$/

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

function sorted(list) {
  return [...new Set(list)].sort()
}

function duplicates(list) {
  const seen = new Set()
  const out = new Set()
  for (const x of list) {
    if (seen.has(x)) out.add(x)
    seen.add(x)
  }
  return [...out].sort()
}

function fail(code, problems) {
  throw new ReviewError(code, problems.join('; '), { problems })
}

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
  const r = request && typeof request === 'object' ? request : {}
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
    repo: r.repo,
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
    if (!x || typeof x !== 'object') {
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

export function pinProblems(request, state) {
  const problems = []
  if (state.head !== request.headSha) problems.push(`HEAD ${state.head} が headSha ${request.headSha} と違う`)
  if (request.mode === 'diff' && state.dirty.length) problems.push(`diff は追跡しているファイルの未コミットの変更があると始められない: ${JSON.stringify(state.dirty)}`)
  const missingPreserved = request.preservedPaths.filter((p) => !state.paths.includes(p))
  if (missingPreserved.length) problems.push(`preservedPaths に変更の無いパスがある: ${JSON.stringify(missingPreserved)}`)
  return problems
}

export function inventoryOf(request, state) {
  const parts = partition(state.paths, { excludePaths: state.excludePaths, generatedPaths: state.generatedPaths, preservedPaths: request.preservedPaths })
  return { head: state.head, dirty: state.dirty, excludePaths: state.excludePaths, generatedPaths: state.generatedPaths, ...parts }
}

export function buildPlan(request, state, digests) {
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
  const skillDesignTargets = inv.reviewable.filter(isSkillDesign)
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
    target: { files: inv.reviewable },
    excluded: inv.excluded,
    generated: inv.generated,
    preserved: inv.preserved,
    digests: request.mode === 'diff' ? null : digests,
    skillDesignTargets,
    reviewers: request.reviewers,
  }
}

function sameSet(a, b) {
  return a.length === b.length && a.every((x) => b.includes(x))
}

// 計画の後に HEAD・変更の集合・作業ツリーのバイトのどれかが動くと、指摘は計画した対象とは別の内容を指す。
export function checkPin(plan, state, digests) {
  const problems = pinProblems(plan, state)
  const inv = inventoryOf(plan, state)
  for (const key of ['reviewable', 'excluded', 'generated', 'preserved']) {
    const before = key === 'reviewable' ? plan.target.files : plan[key]
    if (!sameSet(before, inv[key])) problems.push(`${key} の集合が計画と違う: 計画 ${JSON.stringify(before)} 現在 ${JSON.stringify(inv[key])}`)
  }
  const changed = []
  if (plan.digests) {
    for (const file of plan.target.files) if ((digests?.[file] ?? null) !== (plan.digests[file] ?? null)) changed.push(file)
    if (changed.length) problems.push(`対象の内容が計画の後に変わった: ${JSON.stringify(changed)}`)
  }
  return { ok: problems.length === 0, problems, changed }
}

function findingProblem(plan, finding) {
  const isExcluded = matcher(plan.excludePaths)
  const isGenerated = matcher(plan.generatedPaths)
  if (!isRepoPath(finding?.path)) return 'path がリポジトリ相対の正規のパスでない'
  if (isExcluded(finding.path)) return 'path が内容を読まない path に当たる'
  if (isGenerated(finding.path)) return 'path が生成物に当たる'
  if (plan.mode === 'audit' && !plan.target.files.includes(finding.path)) return 'audit の指摘が対象の外にある'
  if (!Number.isInteger(finding.line) || finding.line < 1) return 'line が 1 以上の整数でない'
  if (finding.end_line !== undefined && (!Number.isInteger(finding.end_line) || finding.end_line < finding.line)) return 'end_line が line より前'
  return null
}

function evidenceProblem(plan, proof) {
  const isExcluded = matcher(plan.excludePaths)
  const isGenerated = matcher(plan.generatedPaths)
  if (!isRepoPath(proof?.path)) return 'evidence の path が正規のパスでない'
  if (isExcluded(proof.path) || isGenerated(proof.path)) return 'evidence が読まない path を根拠にしている'
  if (!Number.isInteger(proof.line) || proof.line < 1) return 'evidence の line が 1 以上の整数でない'
  return null
}

export function merge(plan, results) {
  if (!Array.isArray(results) || results.length !== plan.reviewers.length) fail(CODES.input, ['results は reviewers と同じ長さの配列でなければならない'])
  const reviewers = plan.reviewers.map((rv, i) => {
    const res = results[i]
    const base = { id: rv.id, status: 'ok', missing: [], extra: [], duplicate: [], invalidSupporting: [], invalidFindings: [], limitations: 0 }
    if (!res) return { ...base, status: 'missing', missing: [...rv.files] }
    if (res.head_sha !== plan.headSha) return { ...base, status: 'head_mismatch', missing: [...rv.files] }
    const coverage = res.coverage ?? []
    const isExcluded = matcher(plan.excludePaths)
    const isGenerated = matcher(plan.generatedPaths)
    return {
      ...base,
      missing: rv.files.filter((f) => !coverage.includes(f)),
      extra: sorted(coverage.filter((f) => !rv.files.includes(f))),
      duplicate: duplicates(coverage),
      invalidSupporting: sorted((res.supporting_files ?? []).filter((f) => !isRepoPath(f) || isExcluded(f) || isGenerated(f))),
      invalidFindings: (res.findings ?? []).flatMap((f, j) => {
        const why = findingProblem(plan, f)
        return why ? [{ finding: j, reason: why }] : []
      }),
      limitations: (res.limitations ?? []).length,
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
    for (const [j, f] of (results[i].findings ?? []).entries()) {
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
  const groups = plan.reviewers
    .map((rv) => ({ lens: rv.id, clusters: clusters.flatMap((c, k) => (c.lens === rv.id ? [k] : [])) }))
    .filter((g) => g.clusters.length)
  const complete = missingCoverage.length === 0 && reviewers.every((rv) => rv.status === 'ok'
    && !rv.missing.length && !rv.extra.length && !rv.duplicate.length && !rv.invalidSupporting.length
    && !rv.invalidFindings.length && rv.limitations === 0)
  return { complete, reviewers, missingCoverage, clusters, groups }
}

// 同じ path で行範囲が重なる指摘を 1 つの候補にまとめる（重なりは推移的にたどる）。隣り合うだけの範囲はまとめない。
export function clusterByRange(members) {
  const byPath = new Map()
  for (const m of members) {
    if (!byPath.has(m.path)) byPath.set(m.path, [])
    byPath.get(m.path).push(m)
  }
  const out = []
  for (const path of [...byPath.keys()].sort()) {
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

export function finalize(plan, merged, verifications) {
  const { clusters, groups } = merged
  if (!Array.isArray(verifications) || verifications.length !== groups.length) fail(CODES.input, ['verifications は groups と同じ長さの配列でなければならない'])
  const outcomes = clusters.map((c, k) => ({ cluster: k, verdict: 'unverified', confirmed_members: [], refuted_members: [], source: 'missing' }))
  const verifiers = groups.map((g, gi) => {
    const v = verifications[gi]
    const base = { lens: g.lens, status: 'ok', missing: [], extra: [], duplicate: [], invalid: [] }
    if (!v) return { ...base, status: 'missing', missing: [...g.clusters] }
    if (v.head_sha !== plan.headSha) return { ...base, status: 'head_mismatch', missing: [...g.clusters] }
    const results = v.results ?? []
    const seen = results.map((r) => r?.cluster)
    const extra = sorted(seen.filter((k) => !g.clusters.includes(k)))
    const duplicate = duplicates(seen.filter((k) => g.clusters.includes(k)))
    const missing = g.clusters.filter((k) => !seen.includes(k))
    const invalid = []
    for (const r of results) {
      if (!g.clusters.includes(r.cluster) || duplicate.includes(r.cluster)) continue
      const why = verdictProblem(plan, clusters[r.cluster], r)
      if (why) {
        invalid.push({ cluster: r.cluster, reason: why })
        outcomes[r.cluster].source = 'invalid'
        continue
      }
      const all = clusters[r.cluster].members.map((_, i) => i)
      const confirmed = r.verdict === 'confirmed' ? sorted(r.confirmed_members) : []
      outcomes[r.cluster] = {
        cluster: r.cluster,
        verdict: r.verdict,
        confirmed_members: confirmed,
        refuted_members: r.verdict === 'unverified' ? [] : all.filter((i) => !confirmed.includes(i)),
        source: 'verifier',
      }
    }
    for (const k of duplicate) outcomes[k].source = 'invalid'
    return { ...base, missing, extra, duplicate, invalid }
  })
  const complete = verifiers.every((v) => v.status === 'ok' && !v.missing.length && !v.extra.length && !v.duplicate.length && !v.invalid.length)
    && outcomes.every((o) => o.verdict !== 'unverified')
  return { complete, verifiers, outcomes }
}

function verdictProblem(plan, cluster, r) {
  if (!VERDICTS.includes(r.verdict)) return 'verdict が confirmed・refuted・unverified のどれでもない'
  const evidence = Array.isArray(r.evidence) ? r.evidence : null
  if (!evidence) return 'evidence が配列でない'
  for (const proof of evidence) {
    const why = evidenceProblem(plan, proof)
    if (why) return why
  }
  const cm = r.confirmed_members ?? []
  if (!Array.isArray(cm)) return 'confirmed_members が配列でない'
  if (r.verdict === 'confirmed') {
    if (evidence.length === 0) return 'confirmed に evidence が無い'
    if (cm.length === 0) return 'confirmed に confirmed_members が無い'
    if (duplicates(cm).length || cm.some((i) => !Number.isInteger(i) || i < 0 || i >= cluster.members.length)) return 'confirmed_members が候補の主張の番号でない'
  } else if (cm.length) return `${r.verdict} に confirmed_members がある`
  return null
}
