import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CODES, ReviewError, buildPlan, canonical, classifySupporting, ignoredEntries, resolveSymlinks, checkPin, checkRequest, clusterByRange, firstAssignments, fnvSum,
  PIN_ACTIONS, extractSections, globToRegExp, pinAction, isRepoPath, isWorkflowSource, judge, merge, parseReadingTable, partition, renderPolicyPack,
} from './review-core.mjs'

const H = 'a'.repeat(40)
const B = 'b'.repeat(40)
const P = 'c'.repeat(40)
const H2 = 'd'.repeat(40)
const EXCLUDE = ['**/*.lock', '**/package-lock.json']
const GENERATED = ['plugins/p/skills/s/references/criteria/**']
const NO_DETAILS = { symlinks: [], workflowSources: [], digests: null }
const PACK = { path: '/s/repo-review-policy-abc.md', sha256: 'H', token: 'S', index: [{ id: 'P1' }, { id: 'P2' }], missing: [] }

function rejects(fn, code, pattern, label = '') {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof ReviewError, `${label}: ReviewError でない: ${error}`)
    assert.equal(error.code, code, label)
    if (pattern) assert.match(error.message, pattern, label)
    return true
  })
}

test('fnvSum は canonical の文字列の FNV-1a 32bit（期待値は別実装で求めた既知の値）', () => {
  for (const [value, text, sum] of [
    [null, 'null', '77074ba4'],
    [{}, '{}', '5465b825'],
    ['a', '"a"', '61a1cfea'],
    [{ b: 'x', a: [1, undefined], c: undefined }, '{"a":[1,null],"b":"x"}', '92b2496e'],
  ]) {
    assert.equal(canonical(value), text)
    assert.equal(fnvSum(value), sum)
  }
  assert.notEqual(fnvSum({ a: 'x' }), fnvSum({ a: 'y' }))
})

test('isRepoPath はリポジトリ相対の正規のパスだけを受ける', () => {
  for (const [file, ok] of [
    ['a.md', true], ['plugins/p/SKILL.md', true], ['.github/workflows/x.yml', true],
    ['', false], ['/abs', false], ['a//b', false], ['./a', false], ['a/../b', false], ['a/.', false], ['a\\b', false], ['a/', false], [1, false],
  ]) assert.equal(isRepoPath(file), ok, JSON.stringify(file))
})

test('globToRegExp: ** は 0 段以上のディレクトリ、* は / をまたがない', () => {
  for (const [pattern, file, ok] of [
    ['**/*.lock', 'a.lock', true],
    ['**/*.lock', 'x/y/a.lock', true],
    ['**/*.lock', 'a.locks', false],
    ['**/package-lock.json', 'package-lock.json', true],
    ['**/package-lock.json', 'p/my-package-lock.json', false],
    ['plugins/p/skills/s/references/criteria/**', 'plugins/p/skills/s/references/criteria/specifications/x.md', true],
    ['plugins/p/skills/s/references/criteria/**', 'plugins/p/skills/s/references/criteria-old/x.md', false],
    ['**/skills/*/agents/*.md', 'plugins/a/skills/s/agents/r.md', true],
    ['**/skills/*/agents/*.md', 'plugins/a/skills/s/agents/x/r.md', false],
    ['a.b', 'axb', false],
  ]) assert.equal(globToRegExp(pattern).test(file), ok, `${pattern} ${file}`)
})

test('isWorkflowSource は先頭の空白・コメントを読み飛ばし、先頭の文が export const meta = {…} のときだけ真', () => {
  for (const [text, ok] of [
    ["export const meta = { name: 'x', description: 'y' }\n", true],
    ["\n  export const meta={name:'x'}", true],
    ["// 説明\nexport const meta = { name: 'x' }", true],
    ["/* a\n b */ // c\n\nexport const meta = {}", true],
    ["import x from 'y'\nexport const meta = {}", false],
    ["const a = 1\n// export const meta = {}", false],
    ["/* export const meta = { */\nconst a = 1", false],
    ['export const meta = 1', false],
    ["export const meta = 'x'", false],
    ['export const metadata = {}', false],
    ['', false],
  ]) assert.equal(isWorkflowSource(text), ok, JSON.stringify(text))
})

test('partition: 1 つのパスは 1 区分だけに入り、作業中の変更 > 除外 > 生成物 > 対象の順に決まる', () => {
  const out = partition(
    ['z.md', 'a.lock', 'plugins/p/skills/s/references/criteria/x.md', 'mine.lock', 'b.md', 'b.md'],
    { excludePaths: EXCLUDE, generatedPaths: GENERATED, preservedPaths: ['mine.lock'] },
  )
  assert.deepEqual(out, {
    reviewable: ['b.md', 'z.md'],
    excluded: ['a.lock'],
    generated: ['plugins/p/skills/s/references/criteria/x.md'],
    preserved: ['mine.lock'],
  })
  assert.deepEqual(partition([], { excludePaths: EXCLUDE, generatedPaths: [] }), { reviewable: [], excluded: [], generated: [], preserved: [] })
})

const baseRequest = { repo: '/r', mode: 'diff', baseRef: B, headSha: H, policyRef: P }
const twoReviewers = [{ id: 'correctness', focus: 'バグ', files: ['a.md'] }, { id: 'docs', focus: '文書', files: ['a.md'] }]

test('checkRequest は形の誤りを E_INPUT で全て挙げる', () => {
  for (const [label, patch, pattern] of [
    ['相対の repo', { repo: 'r' }, /repo は絶対パス/],
    ['未知の mode', { mode: 'pr' }, /mode は/],
    ['短い headSha', { headSha: 'abc' }, /headSha/],
    ['option に見える headSha', { headSha: `--${'a'.repeat(38)}` }, /headSha/],
    ['branch 名の policyRef', { policyRef: 'main' }, /policyRef/],
    ['diff の baseRef 無し', { baseRef: undefined }, /baseRef/],
    ['diff に scope', { scope: ['a'] }, /scope は audit/],
    ['diff に preservedPaths', { preservedPaths: [] }, /preservedPaths は working_tree/],
    ['audit の scope 無し', { mode: 'audit', baseRef: undefined }, /scope/],
    ['audit の scope に ..', { mode: 'audit', baseRef: undefined, scope: ['../x'] }, /scope/],
    ['reviewer 1 人', { reviewers: [twoReviewers[0]] }, /2 人以上/],
    ['reviewer id の重複', { reviewers: [twoReviewers[0], { ...twoReviewers[1], id: 'correctness' }] }, /重複/],
    ['reviewer id の形', { reviewers: [twoReviewers[0], { ...twoReviewers[1], id: 'Docs' }] }, /id は/],
    ['担当の空', { reviewers: [twoReviewers[0], { ...twoReviewers[1], files: [] }] }, /空にできない/],
    ['担当の重複', { reviewers: [twoReviewers[0], { ...twoReviewers[1], files: ['a.md', 'a.md'] }] }, /重複/],
    ['focus の空', { reviewers: [twoReviewers[0], { ...twoReviewers[1], focus: ' ' }] }, /focus/],
  ]) {
    rejects(() => checkRequest({ ...baseRequest, reviewers: twoReviewers, ...patch }, { requireReviewers: true }), CODES.input, pattern, label)
  }
  rejects(() => checkRequest({ ...baseRequest, reviewers: twoReviewers }, { requireReviewers: false }), CODES.input, /inventory は reviewers/)
})

test('checkRequest は audit の「.」と working_tree の preservedPaths を受けて正規化する', () => {
  const audit = checkRequest({ ...baseRequest, mode: 'audit', baseRef: undefined, scope: ['.'] }, { requireReviewers: false })
  assert.deepEqual(audit.scope, ['.'])
  assert.deepEqual(audit.preservedPaths, [])
  const wt = checkRequest({ ...baseRequest, mode: 'working_tree', preservedPaths: ['z', 'a'] }, { requireReviewers: false })
  assert.deepEqual(wt.preservedPaths, ['a', 'z'])
})

function state(paths, patch = {}) {
  return { head: H, missingCommits: [], dirty: [], excludePaths: EXCLUDE, generatedPaths: GENERATED, generatedNote: 'note', paths, ...patch }
}

function request(patch = {}) {
  return checkRequest({ ...baseRequest, reviewers: twoReviewers, ...patch }, { requireReviewers: true })
}

test('buildPlan: 担当の和集合が対象と一致すれば計画を返し、除外・生成物は名前だけ残す', () => {
  const plan = buildPlan(request(), state(['a.md', 'x.lock', 'plugins/p/skills/s/references/criteria/y.md']), NO_DETAILS)
  assert.deepEqual(plan.target.files, ['a.md'])
  assert.deepEqual(plan.excluded, ['x.lock'])
  assert.deepEqual(plan.generated, ['plugins/p/skills/s/references/criteria/y.md'])
  assert.equal(plan.digests, null)
  assert.equal(plan.generatedNote, 'note')
  assert.deepEqual(plan.skillDesignTargets, [])
})

test('buildPlan は担当の漏れ・対象外の割り当て・スキル設計の観点の欠けを E_PLAN で拒否する', () => {
  for (const [label, reviewers, paths, pattern] of [
    ['担当の漏れ', twoReviewers, ['a.md', 'b.md'], /割り当てていない対象/],
    ['対象外の割り当て', [twoReviewers[0], { ...twoReviewers[1], files: ['a.md', 'x.lock'] }], ['a.md', 'x.lock'], /対象でないパス/],
    ['生成物の割り当て', [twoReviewers[0], { ...twoReviewers[1], files: ['plugins/p/skills/s/references/criteria/y.md'] }], ['a.md', 'plugins/p/skills/s/references/criteria/y.md'], /対象でないパス/],
    ['SKILL.md にスキル設計の観点が無い', [{ ...twoReviewers[0], files: ['plugins/p/skills/s/SKILL.md'] }, { ...twoReviewers[1], files: ['plugins/p/skills/s/SKILL.md'] }], ['plugins/p/skills/s/SKILL.md'], /スキル設計/],
    ['対象が 0 件', twoReviewers, ['x.lock'], /0 件/],
  ]) {
    rejects(() => buildPlan(request({ reviewers }), state(paths), NO_DETAILS), CODES.plan, pattern, label)
  }
})

test('スキル設計の観点の適用範囲: SKILL.md・agents はパスで、Workflow source は内容で決まる', () => {
  for (const [file, workflow, needs] of [
    ['plugins/p/skills/s/SKILL.md', false, true],
    ['.agents/skills/s/SKILL.md', false, true],
    ['plugins/p/skills/s/agents/reviewer.md', false, true],
    ['plugins/p/workflows/run.js', true, true],
    ['.agents/skills/s/scripts/run.js', true, true],
    ['plugins/p/skills/s/scripts/select_runtime.js', false, false],
    ['plugins/p/skills/s/references/guide.md', false, false],
    ['tests/fixtures/t/review-target/SKILL.md', false, false],
    ['tests/fixtures/t/review-target/agents/checker.md', false, false],
    ['docs/guidelines/README.md', false, false],
  ]) {
    const details = { ...NO_DETAILS, workflowSources: workflow ? [file] : [] }
    const reviewers = [{ id: 'skill-design', focus: 'スキル設計', files: [file] }, { id: 'docs', focus: '文書', files: [file] }]
    assert.deepEqual(buildPlan(request({ reviewers }), state([file]), details).skillDesignTargets, needs ? [file] : [], file)
    if (needs) {
      const without = [{ id: 'correctness', focus: 'バグ', files: [file] }, { id: 'docs', focus: '文書', files: [file] }]
      rejects(() => buildPlan(request({ reviewers: without }), state([file]), details), CODES.plan, /スキル設計/, file)
    }
  }
})

test('buildPlan は commit の欠け・HEAD の食い違い・diff の作業ツリーの変更・変更の無い preservedPaths を E_PIN で拒否する', () => {
  rejects(() => buildPlan(request(), state(['a.md'], { missingCommits: [H] }), NO_DETAILS), CODES.pin, /commit が無い/)
  rejects(() => buildPlan(request(), state(['a.md'], { head: H2 }), NO_DETAILS), CODES.pin, /HEAD/, 'diff も head を checkout した作業ツリーでだけ始める')
  rejects(() => buildPlan(request(), state(['a.md'], { dirty: ['untracked.md'] }), NO_DETAILS), CODES.pin, /作業ツリー/)
  assert.deepEqual(buildPlan(request({ mode: 'working_tree' }), state(['a.md'], { dirty: ['a.md'] }), { ...NO_DETAILS, digests: { 'a.md': 'file:h' } }).target.files, ['a.md'], 'working_tree は変更があって当然')
  rejects(() => buildPlan(request({ mode: 'working_tree' }), state(['a.md'], { head: H2 }), NO_DETAILS), CODES.pin, /HEAD/)
  rejects(() => buildPlan(request({ mode: 'working_tree', preservedPaths: ['gone.md'] }), state(['a.md']), NO_DETAILS), CODES.pin, /preservedPaths/)
  const wt = buildPlan(request({ mode: 'working_tree', preservedPaths: ['mine.md'] }), state(['a.md', 'mine.md']), { ...NO_DETAILS, digests: { 'a.md': 'file:h1' } })
  assert.deepEqual(wt.preserved, ['mine.md'])
  assert.deepEqual(wt.digests, { 'a.md': 'file:h1' })
})

test('checkPin: 計画の後に HEAD・方針・集合・内容のどれかが動いたら ok を落とす', () => {
  const plan = buildPlan(request({ mode: 'working_tree' }), state(['a.md']), { ...NO_DETAILS, digests: { 'a.md': 'file:h1' } })
  const d = (digest) => ({ ...NO_DETAILS, digests: { 'a.md': digest } })
  for (const [label, st, details, ok, pattern] of [
    ['変化なし', state(['a.md']), d('file:h1'), true, null],
    ['HEAD が動いた', state(['a.md'], { head: H2 }), d('file:h1'), false, /HEAD/],
    ['変更が増えた', state(['a.md', 'b.md']), d('file:h1'), false, /reviewable/],
    ['除外の方針が変わった', state(['a.md'], { excludePaths: ['**/*.md'] }), d('file:h1'), false, /excludePaths/],
    ['内容が変わった', state(['a.md']), d('file:h2'), false, /内容/],
    ['symlink に変わった', state(['a.md']), d('symlink:h1'), false, /内容/],
    ['対象が消えた', state(['a.md']), d(null), false, /内容/],
  ]) {
    const pin = checkPin(plan, st, details)
    assert.equal(pin.ok, ok, label)
    if (pattern) assert.match(pin.problems.join('\n'), pattern, label)
  }
  const diffPlan = buildPlan(request(), state(['a.md']), NO_DETAILS)
  assert.equal(checkPin(diffPlan, state(['a.md']), NO_DETAILS).ok, true)
  assert.equal(checkPin(diffPlan, state(['a.md'], { head: H2 }), NO_DETAILS).ok, false)
  assert.equal(checkPin(diffPlan, state(['a.md'], { dirty: ['a.md'] }), NO_DETAILS).ok, false)
  assert.equal(checkPin(diffPlan, state(['a.md'], { missingCommits: [B] }), NO_DETAILS).ok, false)
})

test('clusterByRange: 重なる範囲は推移的にまとめ、隣り合うだけの範囲と別の path はまとめない', () => {
  const m = (reviewer, finding, path, start, end = start) => ({ reviewer, finding, path, start, end })
  for (const [label, members, expected] of [
    ['同じ行の別の主張は 1 候補の 2 主張', [m(0, 0, 'a', 3), m(1, 0, 'a', 3)], [['a', 3, 3, 2]]],
    ['隣り合う範囲', [m(0, 0, 'a', 1, 3), m(1, 0, 'a', 4, 5)], [['a', 1, 3, 1], ['a', 4, 5, 1]]],
    ['推移的な重なり', [m(0, 0, 'a', 1, 5), m(1, 0, 'a', 5, 9), m(0, 1, 'a', 9, 12)], [['a', 1, 12, 3]]],
    ['包含', [m(0, 0, 'a', 1, 20), m(1, 0, 'a', 5, 6)], [['a', 1, 20, 2]]],
    ['別の path', [m(0, 0, 'b', 1), m(1, 0, 'a', 1)], [['a', 1, 1, 1], ['b', 1, 1, 1]]],
    ['空', [], []],
  ]) {
    assert.deepEqual(clusterByRange(members).map((c) => [c.path, c.start, c.end, c.members.length]), expected, label)
  }
})

function mergePlan(patch = {}) {
  return {
    repo: '/r', mode: 'diff', headSha: H, excludePaths: EXCLUDE, generatedPaths: GENERATED, preserved: [], policyPack: PACK, symlinks: [], symlinkMap: {},
    target: { files: ['a.md', 'b.md'] },
    reviewers: [{ id: 'correctness', focus: 'x', files: ['a.md', 'b.md'] }, { id: 'docs', focus: 'y', files: ['a.md'] }],
    ...patch,
  }
}

function result(patch = {}) {
  const r = { head_sha: H, policy_pack_token: 'S', coverage: ['a.md', 'b.md'], supporting_files: ['REVIEW.md'], policy_sections: ['P1'], limitations: 0, findings: [], ...patch }
  const supporting = Array.isArray(r.supporting_files) ? r.supporting_files.map((x) => (typeof x === 'string' ? { path: x } : x)) : r.supporting_files
  return { ...r, supporting_files: supporting, findings: Array.isArray(r.findings) ? r.findings.map((f) => ({ rule_sections: ['P1'], ...f })) : r.findings }
}

test('merge: 全員が担当を読み終え指摘が重なれば、候補は最初に挙げた観点の 1 段目に回る', () => {
  const out = merge(mergePlan(), [
    result({ findings: [{ path: 'b.md', line: 4, end_line: 6 }] }),
    result({ coverage: ['a.md'], findings: [{ path: 'b.md', line: 6 }, { path: 'caller.md', line: 2 }] }),
  ])
  assert.equal(out.complete, true)
  assert.deepEqual(out.missingCoverage, [])
  assert.deepEqual(out.clusters, [
    { path: 'b.md', line: 4, end_line: 6, lens: 'correctness', in_target: true, members: [[0, 0], [1, 0]] },
    { path: 'caller.md', line: 2, end_line: 2, lens: 'docs', in_target: false, members: [[1, 1]] },
  ])
  assert.deepEqual(out.first, [{ lens: 'correctness', items: [{ cluster: 0, claims: [0, 1] }] }, { lens: 'docs', items: [{ cluster: 1, claims: [0] }] }])
})

test('merge: 欠けた reviewer・HEAD の違い・読み残し・余分・重複・読めなかった記録は complete を落とすが、他の指摘は残す', () => {
  const other = result({ coverage: ['a.md'], findings: [{ path: 'a.md', line: 1 }] })
  for (const [label, first, expectReviewer, missingCoverage] of [
    ['reviewer が返らない', null, { status: 'missing', missing: ['a.md', 'b.md'] }, ['b.md']],
    ['HEAD が違う', result({ head_sha: H2 }), { status: 'head_mismatch' }, ['b.md']],
    ['担当の読み残し', result({ coverage: ['a.md'] }), { status: 'ok', missing: ['b.md'] }, ['b.md']],
    ['担当外の coverage', result({ coverage: ['a.md', 'b.md', 'z.md'] }), { extra: ['z.md'] }, []],
    ['coverage の重複', result({ coverage: ['a.md', 'b.md', 'a.md'] }), { duplicate: ['a.md'] }, []],
    ['読めなかった記録', result({ limitations: 1 }), { limitations: 1 }, []],
    ['方針の束を読めなかった', result({ policy_pack_token: 'unreadable' }), { status: 'pack_unread', missing: ['a.md', 'b.md'] }, ['b.md']],
  ]) {
    const out = merge(mergePlan({ preserved: ['mine.md'] }), [first, other])
    assert.equal(out.complete, false, label)
    for (const [k, v] of Object.entries(expectReviewer)) assert.deepEqual(out.reviewers[0][k], v, `${label}: ${k}`)
    assert.deepEqual(out.missingCoverage, missingCoverage, label)
    assert.equal(out.clusters.length, 1, `${label}: 他の reviewer の指摘は検証に回る`)
  }
  const untrusted = merge(mergePlan(), [result({ policy_pack_token: 'unreadable', findings: [{ path: 'a.md', line: 3 }, { path: 'b.md', line: 1 }] }), result({ coverage: ['a.md'], head_sha: H2, findings: [{ path: 'a.md', line: 1 }] })])
  assert.ok(untrusted.untrusted.every((x) => typeof x.meaning === 'string' && x.meaning.length > 0), 'status の意味を CLI が載せる')
  assert.deepEqual(untrusted.untrusted.map(({ meaning, ...x }) => x), [
    { reviewer: 0, finding: 0, reason: 'pack_unread' }, { reviewer: 0, finding: 1, reason: 'pack_unread' }, { reviewer: 1, finding: 0, reason: 'head_mismatch' },
  ], '信用しない reviewer の指摘を CLI が列挙して返す')
  assert.deepEqual(untrusted.clusters, [])
  assert.deepEqual(merge(mergePlan(), [null, result({ coverage: ['a.md'] })]).untrusted, [], '返らなかった reviewer は指摘を持たない')
})

test('merge: 正規でない・除外・生成物・作業中の変更・audit の対象外・行の逆転の指摘は候補にしない', () => {
  for (const [label, finding, mode] of [
    ['絶対パス', { path: '/a.md', line: 1 }, 'diff'],
    ['除外 path', { path: 'x.lock', line: 1 }, 'diff'],
    ['生成物', { path: 'plugins/p/skills/s/references/criteria/y.md', line: 1 }, 'diff'],
    ['作業中の変更', { path: 'mine.md', line: 1 }, 'diff'],
    ['audit の対象外', { path: 'caller.md', line: 1 }, 'audit'],
    ['line が 0', { path: 'a.md', line: 0 }, 'diff'],
    ['end_line < line', { path: 'a.md', line: 5, end_line: 4 }, 'diff'],
    ['rule_sections が束に無い', { path: 'a.md', line: 1, rule_sections: ['P9'] }, 'diff'],
    ['rule_sections が空', { path: 'a.md', line: 1, rule_sections: [] }, 'diff'],
  ]) {
    const out = merge(mergePlan({ mode, preserved: ['mine.md'] }), [result({ findings: [finding] }), result({ coverage: ['a.md'] })])
    assert.equal(out.clusters.length, 0, label)
    assert.equal(out.reviewers[0].invalidFindings.length, 1, label)
    assert.equal(out.complete, false, label)
  }
})

test('merge は欠けた・型の違う入力を既定値で埋めず E_INPUT で拒否する', () => {
  for (const [label, results] of [
    ['長さの違い', [result()]],
    ['coverage の欠け', [{ ...result(), coverage: undefined }, result()]],
    ['limitations が件数でない', [result({ limitations: ['x'] }), result()]],
    ['findings が配列でない', [result({ findings: null }), result()]],
    ['head_sha の欠け', [{ ...result(), head_sha: undefined }, result()]],
  ]) rejects(() => merge(mergePlan(), results), CODES.input, null, label)
})

// 3 観点・候補 2 つ（候補 0 は主張 2 つで lens a、候補 1 は主張 1 つで lens b）。
const R3 = { mode: 'diff', headSha: H, excludePaths: EXCLUDE, generatedPaths: GENERATED, preserved: [], policyPack: PACK, symlinks: [], symlinkMap: {}, target: { files: ['a.md'] }, reviewers: ['a', 'b', 'c'].map((id) => ({ id, focus: id, files: ['a.md'] })) }
const CLUSTERS = [{ lens: 'a', members: [[0, 0], [1, 0]] }, { lens: 'b', members: [[1, 1]] }]
const ev = [{ path: 'a.md', line: 1 }]
const vote = (cluster, claim, verdict, evidence = verdict === 'confirmed' ? ev : []) => ({ cluster, claim, verdict, evidence })
const round = (assignments, results) => ({ assignments, verifications: results.map((r) => (r === null ? null : { head_sha: H, policy_pack_token: 'S', results: r })) })

test('judge 1 段目: 有効な confirmed の 1 票だけで確定し、それ以外の主張は残りの観点に回す', () => {
  const first = firstAssignments(R3, CLUSTERS)
  assert.deepEqual(first, [{ lens: 'a', items: [{ cluster: 0, claims: [0, 1] }] }, { lens: 'b', items: [{ cluster: 1, claims: [0] }] }])
  const out = judge(R3, { clusters: CLUSTERS }, [round(first, [[vote(0, 0, 'confirmed'), vote(0, 1, 'refuted')], [vote(1, 0, 'unverified')]])])
  assert.equal(out.complete, false)
  assert.deepEqual(out.outcomes.map((o) => [o.cluster, o.claim, o.verdict]), [[0, 0, 'confirmed'], [0, 1, 'pending'], [1, 0, 'pending']])
  assert.deepEqual(out.second, [
    { lens: 'a', items: [{ cluster: 1, claims: [0] }] },
    { lens: 'b', items: [{ cluster: 0, claims: [1] }] },
    { lens: 'c', items: [{ cluster: 0, claims: [1] }, { cluster: 1, claims: [0] }] },
  ])
  const all = judge(R3, { clusters: CLUSTERS }, [round(first, [[vote(0, 0, 'confirmed'), vote(0, 1, 'confirmed')], [vote(1, 0, 'confirmed')]])])
  assert.equal(all.complete, true)
  assert.deepEqual(all.second, [])
})

test('judge 1 段目: 欠けた・2 回の・不正な・読めなかった票は有効票にせず決着させない', () => {
  const first = firstAssignments(R3, CLUSTERS)
  const ok1 = [vote(1, 0, 'confirmed')]
  for (const [label, a, diagKey] of [
    ['検証役が返らない', null, 'missing'],
    ['主張への票が無い', [vote(0, 1, 'confirmed')], 'missing'],
    ['同じ主張に 2 票', [vote(0, 0, 'confirmed'), vote(0, 0, 'confirmed'), vote(0, 1, 'confirmed')], 'duplicate'],
    ['confirmed に根拠が無い', [vote(0, 0, 'confirmed', []), vote(0, 1, 'confirmed')], 'invalid'],
    ['除外 path を根拠にした', [vote(0, 0, 'confirmed', [{ path: 'x.lock', line: 1 }]), vote(0, 1, 'confirmed')], 'invalid'],
    ['生成物を根拠にした', [vote(0, 0, 'confirmed', [{ path: 'plugins/p/skills/s/references/criteria/y.md', line: 2 }]), vote(0, 1, 'confirmed')], 'invalid'],
    ['読めなかった', [vote(0, 0, 'unverified'), vote(0, 1, 'confirmed')], null],
  ]) {
    const out = judge(R3, { clusters: CLUSTERS }, [round(first, [a, ok1])])
    assert.equal(out.outcomes[0].verdict, 'pending', label)
    assert.equal(out.outcomes[2].verdict, 'confirmed', `${label}: 他の主張の判定は残る`)
    assert.notEqual(out.outcomes[0].votes[0]?.vote, 'confirmed', label)
    if (diagKey === 'missing' && a === null) assert.equal(out.diagnostics[0].status, 'missing', label)
    else if (diagKey) assert.ok(out.diagnostics[0][diagKey].length > 0, label)
    if (diagKey === 'invalid') {
      assert.equal(out.outcomes[0].votes[0].vote, 'missing', `${label}: 不正な票は欠けた票として残す`)
      assert.ok(out.outcomes[0].votes[0].reason, label)
    }
  }
  const extra = judge(R3, { clusters: CLUSTERS }, [round(first, [[vote(0, 0, 'confirmed'), vote(0, 1, 'confirmed'), vote(1, 0, 'confirmed')], [vote(1, 0, 'refuted')]])])
  assert.deepEqual(extra.diagnostics[0].extra, ['1:0'], '担当外の票は捨てる')
  assert.equal(extra.outcomes[2].verdict, 'pending', '担当外の票では決着しない')
  for (const [label, head, sha, status] of [['HEAD が違う', H2, 'S', 'head_mismatch'], ['方針の束を読めなかった', H, 'unreadable', 'pack_unread']]) {
    const v = judge(R3, { clusters: CLUSTERS }, [{ assignments: first, verifications: [{ head_sha: head, policy_pack_token: sha, results: [vote(0, 0, 'confirmed'), vote(0, 1, 'confirmed')] }, { head_sha: H, policy_pack_token: 'S', results: ok1 }] }])
    assert.equal(v.diagnostics[0].status, status, label)
    assert.equal(v.outcomes[0].verdict, 'pending', label)
  }
})

test('judge 2 段目: 全観点の有効票の過半数で確定・棄却し、届かなければ unverified', () => {
  const twoLens = { ...R3, reviewers: R3.reviewers.slice(0, 2) }
  const c1 = [{ lens: 'a', members: [[0, 0]] }]
  const f2 = firstAssignments(twoLens, c1)
  const s2 = [{ lens: 'b', items: [{ cluster: 0, claims: [0] }] }]
  const f3 = firstAssignments(R3, c1)
  const s3 = [{ lens: 'b', items: [{ cluster: 0, claims: [0] }] }, { lens: 'c', items: [{ cluster: 0, claims: [0] }] }]
  for (const [label, plan, first, second, v1, v2, expected] of [
    ['R=2 で 2 票とも refuted', twoLens, f2, s2, 'refuted', ['refuted'], 'refuted'],
    ['R=2 で 1 票の refuted だけでは棄却しない', twoLens, f2, s2, 'refuted', ['unverified'], 'unverified'],
    ['R=2 で割れたら unverified', twoLens, f2, s2, 'refuted', ['confirmed'], 'unverified'],
    ['R=3 で 2 票の confirmed は確定', R3, f3, s3, 'refuted', ['confirmed', 'confirmed'], 'confirmed'],
    ['R=3 で 2 票の refuted は棄却', R3, f3, s3, 'refuted', ['refuted', 'confirmed'], 'refuted'],
    ['R=3 で有効票が 1 つなら unverified', R3, f3, s3, 'unverified', ['refuted', null], 'unverified'],
  ]) {
    const r2 = second.map((_, i) => (v2[i] === null ? null : [vote(0, 0, v2[i])]))
    const out = judge(plan, { clusters: c1 }, [round(first, [[vote(0, 0, v1)]]), round(second, r2)])
    assert.equal(out.outcomes[0].verdict, expected, label)
    assert.equal(out.complete, expected !== 'unverified', label)
  }
})

test('judge: 観点が 2 つのとき、1 段目の票が refuted でない主張は 2 段目に回さず unverified にする（過半数に届き得ない）', () => {
  const twoLens = { ...R3, reviewers: R3.reviewers.slice(0, 2) }
  const c2 = [{ lens: 'a', members: [[0, 0], [0, 1], [0, 2]] }]
  const first = firstAssignments(twoLens, c2)
  const out = judge(twoLens, { clusters: c2 }, [round(first, [[vote(0, 0, 'confirmed'), vote(0, 1, 'refuted'), vote(0, 2, 'unverified')]])])
  assert.deepEqual(out.outcomes.map((o) => o.verdict), ['confirmed', 'pending', 'unverified'])
  assert.deepEqual(out.second, [{ lens: 'b', items: [{ cluster: 0, claims: [1] }] }], '棄却され得る主張だけを回す')
  const done = judge(twoLens, { clusters: c2 }, [round(first, [[vote(0, 0, 'confirmed'), vote(0, 1, 'refuted'), vote(0, 2, 'unverified')]]), round(out.second, [[vote(0, 1, 'refuted')]])])
  assert.deepEqual(done.outcomes.map((o) => o.verdict), ['confirmed', 'refuted', 'unverified'])
  const none = judge(twoLens, { clusters: c2 }, [round(first, [null])])
  assert.deepEqual(none.second, [], '1 段目が欠けたら観点 2 つでは何も決まらないので起動しない')
  assert.deepEqual(none.outcomes.map((o) => o.verdict), ['unverified', 'unverified', 'unverified'])
})

test('judge は候補から決まる割り当てと違う段を E_INPUT で拒否する', () => {
  const first = firstAssignments(R3, CLUSTERS)
  rejects(() => judge(R3, { clusters: CLUSTERS }, [round([{ lens: 'c', items: [{ cluster: 0, claims: [0, 1] }] }], [[]])]), CODES.input, /割り当て/)
  const r1 = round(first, [[vote(0, 0, 'confirmed'), vote(0, 1, 'refuted')], [vote(1, 0, 'confirmed')]])
  rejects(() => judge(R3, { clusters: CLUSTERS }, [r1, round([{ lens: 'b', items: [{ cluster: 0, claims: [0, 1] }] }], [[]])]), CODES.input, /割り当て/)
  rejects(() => judge(R3, { clusters: CLUSTERS }, []), CODES.input, /rounds/)
  rejects(() => judge(R3, { clusters: [{ lens: 'a' }] }, [r1]), CODES.input, /clusters/)
  rejects(() => judge(R3, { clusters: CLUSTERS }, [{ assignments: first, verifications: [null] }]), CODES.input, /同じ長さ/)
})

test('judge: 候補が 0 件なら 1 段目の判定だけで complete', () => {
  assert.deepEqual(judge(R3, { clusters: [] }, [round([], [])]), { complete: true, outcomes: [], second: [], diagnostics: [] })
})

test('parseReadingTable: 右の列の文書と、その後に続く「…」を節として取り、節の無い文書は全体にする', () => {
  const review = [
    '正本は `docs/b.md`（以下 b.md）。',
    '## 読むもの',
    '| 変更 | 読むもの |',
    '|---|---|',
    '| `*.md` | `docs/a.md`、b.md §1「一」・§2「二」。`subprocess` の扱い「無関係」 |',
    '| `*.js` | `docs/a.md`「節」、`docs/c.md` |',
    '| `x` | 文書の無い行 |',
    '## 次',
    '| `docs/z.md` | 表の外 |',
  ].join('\n')
  assert.deepEqual(parseReadingTable(review), {
    docs: [
      { path: 'docs/a.md', whole: true, titles: [{ title: '節', num: null }] },
      { path: 'docs/b.md', whole: false, titles: [{ title: '一', num: 1 }, { title: '二', num: 2 }] },
      { path: 'docs/c.md', whole: true, titles: [] },
    ],
    unparsed: [{ text: '「無関係」', reason: '文書の無い節の参照' }],
  })
  assert.throws(() => parseReadingTable('# 無い'), (e) => e.code === CODES.policy)
  assert.throws(() => parseReadingTable('## 読むもの\n\n文だけ\n'), (e) => e.code === CODES.policy)
})

test('parseReadingTable: 左の列の別名の §参照も読み、取れなかった参照（backtick の無いパス・末尾の | の無い行・文書の無い §参照）を理由つきで返す', () => {
  const review = [
    '正本は `docs/b.md`（以下 b.md）。',
    '## 読むもの',
    '| 変更 | 読むもの |',
    '|---|---|',
    '| Workflow（b.md §13「置き場」の） | `docs/a.md` |',
    '| `*.md`・`SKILL.md` | docs/plain.md を読む |',
    '| `x` | `docs/c.md`',
    '| `y` | §4「宙に浮いた節」 |',
  ].join('\n')
  const out = parseReadingTable(review)
  assert.deepEqual(out.docs, [
    { path: 'docs/b.md', whole: false, titles: [{ title: '置き場', num: 13 }] },
    { path: 'docs/a.md', whole: true, titles: [] },
    { path: 'docs/c.md', whole: true, titles: [] },
  ], '左の列の glob と .md の名前は文書として読まない')
  assert.deepEqual(out.unparsed.map((u) => [u.text, u.reason]), [
    ['docs/plain.md', 'backtick の無いパス'],
    ['| `x` | `docs/c.md`', '表の行の末尾に | が無い'],
    ['§4「宙に浮いた節」', '文書の無い節の参照'],
  ])
})

test('extractSections: 番号付きの見出しも名前で当て、同じか上の深さの次の見出しの前までを取り、コードの中の見出しは見ない', () => {
  const text = ['# T', '## 1. 一', 'a', '```', '## 二', '```', '### 一の下', 'b', '## 二', 'c'].join('\n')
  assert.deepEqual(extractSections(text, ['一', '二', '無い']), {
    sections: [{ title: '一', start: 2, end: 8 }, { title: '二', start: 9, end: 10 }],
    missing: ['無い'],
  })
  assert.deepEqual(extractSections(`${text}\n`, [{ title: '二', num: null }]).sections, [{ title: '二', start: 9, end: 10 }], '末尾の改行は行に数えない')
  assert.deepEqual(extractSections(text, [{ title: '一', num: 1 }, { title: '一', num: 2 }]), {
    sections: [{ title: '§1「一」', start: 2, end: 8 }],
    missing: ['§2「一」'],
  }, '§番号があれば番号も照らす')
  assert.deepEqual(extractSections(text, [{ title: '一の下', num: 1 }, { title: '一の下', num: 2 }]), {
    sections: [{ title: '§1「一の下」', start: 7, end: 8 }],
    missing: ['§2「一の下」'],
  }, '§番号の節の中の小見出しも当てる（ほかの番号の節の中は当てない）')
})

test('renderPolicyPack: 索引の行の範囲が束の本文の位置と元のファイルの行に合う', () => {
  const lines = ['l1', 'l2', 'l3']
  const { text, index } = renderPolicyPack('a'.repeat(40), [{ path: 'x.md', title: null, lines, start: 1, end: 3 }, { path: 'y.md', title: '節', lines, start: 2, end: 3 }], [{ path: 'z.md' }])
  const out = text.split('\n')
  assert.deepEqual(index.map((e) => [e.id, e.source]), [['P1', [1, 3]], ['P2', [2, 3]]])
  assert.equal(out[index[1].pack[0] - 1], '## [P2] y.md「節」')
  assert.deepEqual(out.slice(index[1].pack[0], index[1].pack[1]), ['y.md:2| l2', 'y.md:3| l3'])
  assert.match(text, /束に入れなかったもの（見ていない）: z\.md/)
})

test('pin の次の手は原因と mode の組で決まり、直す主体（利用者か caller か）を持つ', () => {
  for (const [cause, mode, by, pattern] of [
    ['head', 'diff', 'user', /checkout に戻して/],
    ['head', 'working_tree', 'caller', /今の HEAD を headSha にして/],
    ['head', 'audit', 'caller', /今の HEAD を headSha にして/],
    ['worktree', 'diff', 'user', /片付けて/],
    ['preserved', 'working_tree', 'caller', /preservedPaths/],
    ['commits', 'diff', 'caller', /git fetch/],
    ['changed', 'audit', 'caller', /今の内容/],
    ['pack', 'diff', 'caller', /stateDir/],
    ['collect', 'audit', 'caller', /原因/],
  ]) {
    const a = pinAction(cause, mode)
    assert.equal(a.by, by, `${cause}/${mode}`)
    assert.match(a.action, pattern, `${cause}/${mode}`)
  }
  assert.throws(() => pinAction('worktree', 'audit'), (e) => e.code === CODES.internal, 'diff にしか起きない原因は他の mode に次の手を持たない')
  for (const row of Object.values(PIN_ACTIONS)) for (const v of Object.values(row)) assert.ok(['user', 'caller'].includes(v.by))
  const plan = buildPlan(request({ mode: 'working_tree' }), state(['a.md']), { ...NO_DETAILS, digests: { 'a.md': 'file:h' } })
  assert.deepEqual(checkPin(plan, state(['a.md'], { head: H2 }), { ...NO_DETAILS, digests: { 'a.md': 'file:h' } }).causes.map((c) => [c.cause, c.by]), [['head', 'caller']], 'working_tree で HEAD が動いたら古い HEAD への切り替えを頼まない')
})

test('renderPolicyPack は読取りトークンを束の先頭に置き、索引の行の範囲をずらさない', () => {
  const { text, index } = renderPolicyPack('a'.repeat(40), [{ path: 'x.md', title: null, lines: ['l1'], start: 1, end: 1 }], [], 'abc123')
  const out = text.split('\n')
  assert.ok(out.slice(0, 4).includes('読取りトークン（policy_pack_token に返す）: abc123'))
  assert.equal(out[index[0].pack[0] - 1], '## [P1] x.md（全体）')
})

test('supporting_files の分類: repo の外・方針の束・指示文書は記録だけにし、読まない path だけを forbiddenReads にする', () => {
  for (const [label, entry, kind, extra] of [
    ['repo 相対', 'REVIEW.md', 'ok', { path: 'REVIEW.md' }],
    ['repo の中の絶対パス', '/r/docs/x.md', 'ok', { path: 'docs/x.md' }],
    ['repo の中の指示文書（スキルが repo の中）', '/r/.agents/skills/repo-review/agents/reviewer.md', 'ok', { path: '.agents/skills/repo-review/agents/reviewer.md' }],
    ['方針の束', '/s/repo-review-policy-abc.md', 'policy_pack', {}],
    ['別の実パスの方針の束', '/private/s/repo-review-policy-abc.md', 'policy_pack', {}],
    ['repo の外の絶対パス', '/Users/u/skills/repo-review/agents/reviewer.md', 'outside_repo', {}],
    ['節の ID', 'P4', 'ok', { path: 'P4' }],
    ['空白を含む相対パス', 'a b/c.md', 'ok', { path: 'a b/c.md' }],
    ['repo の外へ出る ..', '../x.md', 'outside_repo', {}],
    ['空', ' ', 'not_path', {}],
    ['除外 path', 'x.lock', 'forbidden', { path: 'x.lock' }],
    ['生成物', 'plugins/p/skills/s/references/criteria/y.md', 'forbidden', { path: 'plugins/p/skills/s/references/criteria/y.md' }],
    ['作業中の変更', '/r/mine.md', 'forbidden', { path: 'mine.md' }],
  ]) {
    const out = classifySupporting(mergePlan({ preserved: ['mine.md'] }), (f) => (['x.lock', 'mine.md'].includes(f) || f.startsWith('plugins/p/skills/s/references/criteria/') ? 'x' : null), entry)
    assert.equal(out.kind, kind, label)
    for (const [k, v] of Object.entries(extra)) assert.equal(out[k], v, `${label}: ${k}`)
  }
})

test('merge: 根拠の列挙が repo の外を指しても coverage は欠けず、読まない path の読みだけを forbiddenReads として返す', () => {
  for (const [label, supporting, complete, forbidden, ignored] of [
    ['束と repo の外の指示文書', [{ path: '/s/repo-review-policy-abc.md', lines: 'P1 REVIEW.md:1-64' }, '/Users/u/skills/repo-review/agents/reviewer.md'], true, [], 2],
    ['除外 path（2 回挙げても 1 件）', ['x.lock', './x.lock'], false, [{ reviewer: 'correctness', path: 'x.lock', reason: '内容を読まない path' }], 0],
    ['作業中の変更', ['mine.md'], false, [{ reviewer: 'correctness', path: 'mine.md', reason: '呼び出し側の作業中の変更' }], 0],
  ]) {
    const out = merge(mergePlan({ preserved: ['mine.md'] }), [result({ supporting_files: supporting }), result({ coverage: ['a.md'] })])
    assert.equal(out.complete, complete, label)
    assert.deepEqual(out.forbiddenReads, forbidden, label)
    assert.equal(out.reviewers[0].ignoredSupporting.length, ignored, label)
  }
  const bad = merge(mergePlan(), [result({ policy_sections: ['P1', 'P9'] }), result({ coverage: ['a.md'] })])
  assert.deepEqual(bad.reviewers[0].invalidPolicySections, ['P9'])
  assert.equal(bad.complete, true, '束に無い節の ID は記録だけ')
})

test('回帰: native のスモークテストで reviewer が挙げた束の path と スキル自身の agents/reviewer.md で coverage_or_limitations にならない', () => {
  // native Workflow のスモークテストで reviewer が返した supporting_files の形（場所は架空のパスに置き換えた）。
  const plan = mergePlan({
    repo: '/home/u/work/repo-worktree',
    policyPack: { ...PACK, path: '/private/var/folders/xx/T/tmp.x/repo-review-policy-4a960702f9ede3ad.md' },
    target: { files: ['docs/guidelines/documentation.md'] },
    reviewers: [{ id: 'absence-claims', focus: 'x', files: ['docs/guidelines/documentation.md'] }, { id: 'docs', focus: 'y', files: ['docs/guidelines/documentation.md'] }],
  })
  const supporting = [
    { path: '/private/var/folders/xx/T/tmp.x/repo-review-policy-4a960702f9ede3ad.md', lines: 'P1 REVIEW.md:1-64, P4 AGENTS.md:52-139, P15 docs/guidelines/README.md:1-30' },
    { path: '/home/u/work/repo/.agents/skills/repo-review/agents/reviewer.md' },
  ]
  const cov = ['docs/guidelines/documentation.md']
  const out = merge(plan, [result({ coverage: cov, supporting_files: supporting }), result({ coverage: cov, supporting_files: ['REVIEW.md'] })])
  assert.equal(out.complete, true)
  assert.deepEqual(out.forbiddenReads, [])
  assert.deepEqual(out.reviewers[0].ignoredSupporting.map((x) => x.kind), ['policy_pack', 'outside_repo'])
})

test('classifySupporting は字句の正規化と計画の symlink 対応の範囲で、読まない path を判定する', () => {
  const plan = (repo) => mergePlan({ repo, symlinkMap: { '.agents/skills/s': 'plugins/p/skills/s', '.claude/skills': '.agents/skills' } })
  for (const [label, repo, entry, kind, rel] of [
    ['./ を前に付けた', '/r', './mine.md', 'forbidden', 'mine.md'],
    ['.. で戻る', '/r', 'a/../mine.md', 'forbidden', 'mine.md'],
    ['repo の外へ出る ..', '/r', '../mine.md', 'outside_repo', null],
    ['絶対パスの ..', '/r', '/r/../r/mine.md', 'forbidden', 'mine.md'],
    ['絶対パスの //', '/r', '/r//mine.md', 'forbidden', 'mine.md'],
    ['repo の末尾の /', '/r/', '/r/mine.md', 'forbidden', 'mine.md'],
    ['/var と /private/var（repo が /var）', '/var/t/r', '/private/var/t/r/mine.md', 'forbidden', 'mine.md'],
    ['/private/var と /var（repo が /private/var）', '/private/var/t/r', '/var/t/r/x.lock', 'forbidden', 'x.lock'],
    ['束の名前を含む別の path', '/r', '/elsewhere/repo-review-policy-abc.md', 'outside_repo', null],
    ['束の別名', '/r', '/private/s/repo-review-policy-abc.md', 'policy_pack', null],
    ['repo の中の普通の path', '/r', '/r/docs/./a.md', 'ok', 'docs/a.md'],
    ['空白を含む repo', '/Users/First Last/repo', '/Users/First Last/repo/mine.md', 'forbidden', 'mine.md'],
    ['空白を含む禁止 path', '/r', 'a b/mine.lock', 'forbidden', 'a b/mine.lock'],
    ['repo の中の symlink 経由の禁止 path', '/r', '.agents/skills/s/references/criteria/y.md', 'forbidden', '.agents/skills/s/references/criteria/y.md'],
    ['2 段の symlink 経由の禁止 path', '/r', '.claude/skills/s/references/criteria/y.md', 'forbidden', '.claude/skills/s/references/criteria/y.md'],
    ['repo の絶対パスの symlink 経由', '/r', '/r/.agents/skills/s/references/criteria/y.md', 'forbidden', '.agents/skills/s/references/criteria/y.md'],
    ['symlink 経由の普通の path', '/r', '.agents/skills/s/SKILL.md', 'ok', '.agents/skills/s/SKILL.md'],
    ['束の名前を含む repo の中の path', '/r', 'docs/repo-review-policy-abc.md', 'ok', 'docs/repo-review-policy-abc.md'],
  ]) {
    const p = plan(repo)
    const unreadable = (f) => (['mine.md', 'x.lock', 'a b/mine.lock'].includes(resolveSymlinks(f, p.symlinkMap)) || resolveSymlinks(f, p.symlinkMap).startsWith('plugins/p/skills/s/references/criteria/') ? 'x' : null)
    const out = classifySupporting(p, unreadable, entry)
    assert.equal(out.kind, kind, label)
    if (rel) assert.equal(out.path, rel, label)
  }
  assert.equal(checkRequest({ ...baseRequest, repo: '/r//' }, { requireReviewers: false }).repo, '/r', '計画の repo は末尾の / を除く')
  assert.equal(checkRequest({ ...baseRequest, repo: '//' }, { requireReviewers: false }).repo, '/', 'repo が / だけでも空にしない')
})

test('merge: 読まない path を読んだ reviewer は、coverage・supporting のどちらで申告しても forbiddenReads に出て、その指摘は untrusted になる', () => {
  for (const [label, first] of [
    ['supporting に禁止 path', result({ supporting_files: ['./x.lock'], findings: [{ path: 'a.md', line: 1 }] })],
    ['不正な指摘も持つ', result({ supporting_files: ['x.lock'], findings: [{ path: 'x.lock', line: 1 }] })],
    ['担当外の coverage に禁止 path', result({ coverage: ['a.md', 'b.md', 'x.lock'], findings: [{ path: 'a.md', line: 1 }] })],
  ]) {
    const out = merge(mergePlan(), [first, result({ coverage: ['a.md'] })])
    assert.deepEqual(out.forbiddenReads, [{ reviewer: 'correctness', path: 'x.lock', reason: '内容を読まない path' }], label)
    assert.deepEqual(out.reviewers[0].extra, [], `${label}: extra には振り分けない`)
    assert.deepEqual(out.untrusted.map(({ meaning, ...x }) => x), [{ reviewer: 0, finding: 0, reason: 'forbidden_reads' }], label)
    assert.deepEqual(out.clusters, [], `${label}: 検証に回さない`)
    assert.equal(out.reviewers[0].status, 'forbidden_reads', label)
    assert.deepEqual(out.missingCoverage, ['b.md'], `${label}: HEAD の食い違いと同じく担当を読み残しとする`)
    assert.equal(out.complete, false, label)
    assert.deepEqual(out.reviewers[0].invalidFindings, [], `${label}: 指摘は untrusted だけに載せ、invalid_findings と重ねない`)
  }
})

test('merge: symlink 経由で読んだ生成物も計画の symlinkMap で実体に直して forbiddenReads にし、supporting_files は {path} の配列、coverage は path の配列だけを受ける', () => {
  const plan = mergePlan({ symlinkMap: { '.agents/skills/s': 'plugins/p/skills/s', '.claude/skills': '.agents/skills' } })
  for (const entry of ['.agents/skills/s/references/criteria/y.md', '.claude/skills/s/references/criteria/y.md']) {
    const out = merge(plan, [result({ supporting_files: [{ path: entry, lines: 'L1-3' }] }), result({ coverage: ['a.md'] })])
    assert.deepEqual(out.forbiddenReads.map((x) => [x.path, x.reason]), [[entry, '生成物']], entry)
  }
  const strings = { head_sha: H, policy_pack_token: 'S', coverage: ['a.md', 'b.md'], supporting_files: ['REVIEW.md'], policy_sections: [], limitations: 0, findings: [] }
  rejects(() => merge(plan, [strings, result({ coverage: ['a.md'] })]), CODES.input, /supporting_files/, '注記つきの文字列の supporting_files は受けない')
  rejects(() => merge(plan, [result({ coverage: [{ path: 'a.md' }] }), result({ coverage: ['a.md'] })]), CODES.input, null, 'coverage は path の文字列の配列')
})

test('対象に入る葉の link の 1 行目への指摘・根拠と、その link を読んだ申告には、リンク先の禁止判定を当てない', () => {
  const plan = mergePlan({ mode: 'working_tree', target: { files: ['CLAUDE.md', 'a.md'] }, preserved: ['AGENTS.md'], symlinkMap: { 'CLAUDE.md': 'AGENTS.md' },
    reviewers: [{ id: 'correctness', focus: 'x', files: ['CLAUDE.md', 'a.md'] }, { id: 'docs', focus: 'y', files: ['a.md'] }] })
  const ok = merge(plan, [result({ coverage: ['CLAUDE.md', 'a.md'], findings: [{ path: 'CLAUDE.md', line: 1 }] }), result({ coverage: ['a.md'] })])
  assert.deepEqual(ok.reviewers[0].invalidFindings, [], 'symlink の行への指摘は、リンク先が作業中の変更でも不正にしない')
  assert.equal(ok.clusters.length, 1)
  const read = merge(plan, [result({ coverage: ['CLAUDE.md', 'a.md'], supporting_files: ['docs/../CLAUDE.md'] }), result({ coverage: ['a.md'] })])
  assert.deepEqual(read.forbiddenReads, [], '対象の葉の link を読んだ申告は、正規化した path が link と一致すれば forbidden にしない')
  const first = firstAssignments(plan, ok.clusters)
  const v = judge({ ...plan, policyPack: PACK }, { clusters: ok.clusters }, [{ assignments: first, verifications: [{ head_sha: H, policy_pack_token: 'S', results: [{ cluster: 0, claim: 0, verdict: 'confirmed', evidence: [{ path: 'CLAUDE.md', line: 1 }] }] }] }])
  assert.equal(v.outcomes[0].verdict, 'confirmed', 'symlink の行を根拠にした票は有効')
})

test('ignoredSupporting の各項目は分類の意味を持つ', () => {
  const out = merge(mergePlan(), [result({ supporting_files: ['/elsewhere/x.md', '../y.md', ' '] }), result({ coverage: ['a.md'] })])
  assert.deepEqual(out.reviewers[0].ignoredSupporting.map((x) => x.kind), ['outside_repo', 'outside_repo', 'not_path'])
  assert.ok(out.reviewers[0].ignoredSupporting.every((x) => typeof x.meaning === 'string' && x.meaning.length > 0))
})

test('ディレクトリの symlink の下の生成物を指す指摘・evidence・申告・担当外の coverage は、全て実体へ解決して不正・forbidden にする', () => {
  const plan = mergePlan({ symlinkMap: { '.agents/skills/s': 'plugins/p/skills/s' } })
  const under = '.agents/skills/s/references/criteria/x.md'
  const finding = merge(plan, [result({ findings: [{ path: under, line: 3 }] }), result({ coverage: ['a.md'] })])
  assert.match(finding.reviewers[0].invalidFindings[0].reason, /生成物/, '指摘')
  const at1 = merge(plan, [result({ findings: [{ path: under, line: 1 }] }), result({ coverage: ['a.md'] })])
  assert.match(at1.reviewers[0].invalidFindings[0].reason, /生成物/, '1 行目でも link そのものでなければ例外にしない')
  for (const [label, r] of [['申告', result({ supporting_files: [under] })], ['担当外の coverage', result({ coverage: ['a.md', 'b.md', under] })]]) {
    const out = merge(plan, [r, result({ coverage: ['a.md'] })])
    assert.deepEqual(out.forbiddenReads.map((x) => [x.path, x.reason]), [[under, '生成物']], label)
  }
  const clusters = [{ lens: 'correctness', members: [[0, 0]] }]
  const v = judge(plan, { clusters }, [{ assignments: firstAssignments(plan, clusters), verifications: [{ head_sha: H, policy_pack_token: 'S', results: [{ cluster: 0, claim: 0, verdict: 'confirmed', evidence: [{ path: under, line: 3 }] }] }] }])
  assert.equal(v.outcomes[0].votes[0].vote, 'missing', 'evidence')
})

test('対象に入る葉の link は、読んだ申告なら coverage でも supporting でも forbidden にせず、場所なら 1 行目だけを例外にする', () => {
  const base = { preserved: ['AGENTS.md'], symlinkMap: { 'CLAUDE.md': 'AGENTS.md' } }
  const inTarget = mergePlan({ ...base, symlinks: ['CLAUDE.md'], target: { files: ['CLAUDE.md', 'a.md', 'b.md'] }, reviewers: [{ id: 'correctness', focus: 'x', files: ['a.md', 'b.md'] }, { id: 'docs', focus: 'y', files: ['CLAUDE.md', 'a.md'] }] })
  const outside = mergePlan(base)
  const other = (plan) => result({ coverage: plan.reviewers[1].files })
  for (const [label, r] of [['coverage', result({ coverage: ['a.md', 'b.md', 'CLAUDE.md'] })], ['supporting', result({ supporting_files: ['CLAUDE.md'] })]]) {
    const yes = merge(inTarget, [r, other(inTarget)])
    assert.deepEqual(yes.forbiddenReads, [], `対象の葉の link を ${label} で読んだ申告は forbidden にしない`)
    const no = merge(outside, [r, other(outside)])
    assert.deepEqual(no.forbiddenReads.map((x) => x.path), ['CLAUDE.md'], `対象でない葉の link を ${label} で読んだ申告は解決後で判定する`)
  }
  for (const [label, plan, finding, ok] of [
    ['対象の link の 1 行目', inTarget, { path: 'CLAUDE.md', line: 1 }, true],
    ['対象の link の 2 行目', inTarget, { path: 'CLAUDE.md', line: 2 }, false],
    ['対象の link の 1-2 行目', inTarget, { path: 'CLAUDE.md', line: 1, end_line: 2 }, false],
    ['対象でない link の 1 行目', outside, { path: 'CLAUDE.md', line: 1 }, false],
  ]) {
    const out = merge(plan, [result({ coverage: plan.reviewers[0].files, findings: [finding] }), other(plan)])
    assert.equal(out.reviewers[0].invalidFindings.length === 0, ok, label)
    const clusters = [{ lens: plan.reviewers[0].id, members: [[0, 0]] }]
    const v = judge(plan, { clusters }, [{ assignments: firstAssignments(plan, clusters), verifications: [{ head_sha: H, policy_pack_token: 'S', results: [{ cluster: 0, claim: 0, verdict: 'confirmed', evidence: [{ path: finding.path, line: finding.line }] }] }] }])
    if (finding.end_line === undefined) assert.equal(v.outcomes[0].votes[0].vote === 'confirmed', ok, `${label}（evidence）`)
  }
})

test('2 段の symlink（.claude/skills 経由）と絶対パスの link 経由の指摘・evidence は、実体の禁止 path で判定する', () => {
  const plan = mergePlan({ symlinkMap: { '.claude/skills': '.agents/skills', '.agents/skills/s': 'plugins/p/skills/s', 'plugins/p/abs-in': 'plugins/p/skills/s/references' } })
  for (const p of ['.claude/skills/s/references/criteria/x.md', 'plugins/p/abs-in/criteria/x.md']) {
    const out = merge(plan, [result({ findings: [{ path: p, line: 1 }] }), result({ coverage: ['a.md'] })])
    assert.match(out.reviewers[0].invalidFindings[0]?.reason ?? '', /生成物/, p)
    const clusters = [{ lens: 'correctness', members: [[0, 0]] }]
    const v = judge(plan, { clusters }, [{ assignments: firstAssignments(plan, clusters), verifications: [{ head_sha: H, policy_pack_token: 'S', results: [{ cluster: 0, claim: 0, verdict: 'confirmed', evidence: [{ path: p, line: 1 }] }] }] }])
    assert.equal(v.outcomes[0].votes[0].vote, 'missing', `${p}（evidence）`)
  }
})

test('ignoredEntries は IGNORED_KINDS に無い分類を黙って落とさず E_INTERNAL で止める', () => {
  assert.deepEqual(ignoredEntries([{ kind: 'ok', entry: 'a' }, { kind: 'forbidden', entry: 'b' }]), [])
  assert.equal(ignoredEntries([{ kind: 'outside_repo', entry: '/x' }])[0].kind, 'outside_repo')
  rejects(() => ignoredEntries([{ kind: 'mystery', entry: 'x' }]), CODES.internal, /mystery/)
})
