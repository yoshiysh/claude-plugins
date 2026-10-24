import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CODES, ReviewError, buildPlan, canonical, checkPin, checkRequest, clusterByRange, firstAssignments, fnvSum,
  globToRegExp, isRepoPath, isWorkflowSource, judge, merge, partition,
} from './review-core.mjs'

const H = 'a'.repeat(40)
const B = 'b'.repeat(40)
const P = 'c'.repeat(40)
const H2 = 'd'.repeat(40)
const EXCLUDE = ['**/*.lock', '**/package-lock.json']
const GENERATED = ['plugins/p/skills/s/references/criteria/**']
const NO_DETAILS = { symlinks: [], workflowSources: [], digests: null }

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

test('isWorkflowSource は先頭の文が export const meta のときだけ真', () => {
  for (const [text, ok] of [
    ["export const meta = { name: 'x', description: 'y' }\n", true],
    ["\n  export const meta={name:'x'}", true],
    ["import x from 'y'\nexport const meta = {}", false],
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
  return { head: H, missingCommits: [], excludePaths: EXCLUDE, generatedPaths: GENERATED, generatedNote: 'note', paths, ...patch }
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

test('buildPlan は diff の commit の欠け・working_tree の HEAD の食い違い・変更の無い preservedPaths を E_PIN で拒否する', () => {
  rejects(() => buildPlan(request(), state(['a.md'], { missingCommits: [H] }), NO_DETAILS), CODES.pin, /commit が無い/)
  const diffWithOtherHead = buildPlan(request(), state(['a.md'], { head: H2 }), NO_DETAILS)
  assert.deepEqual(diffWithOtherHead.target.files, ['a.md'], 'diff は作業ツリーの HEAD に依らない')
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
  assert.equal(checkPin(diffPlan, state(['a.md'], { head: H2 }), NO_DETAILS).ok, true)
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
    mode: 'diff', headSha: H, excludePaths: EXCLUDE, generatedPaths: GENERATED, preserved: [],
    target: { files: ['a.md', 'b.md'] },
    reviewers: [{ id: 'correctness', focus: 'x', files: ['a.md', 'b.md'] }, { id: 'docs', focus: 'y', files: ['a.md'] }],
    ...patch,
  }
}

function result(patch = {}) {
  return { head_sha: H, coverage: ['a.md', 'b.md'], supporting_files: ['REVIEW.md'], limitations: 0, findings: [], ...patch }
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
    ['除外 path を根拠に読んだ', result({ supporting_files: ['x.lock'] }), { invalidSupporting: ['x.lock'] }, []],
    ['作業中の変更を根拠に読んだ', result({ supporting_files: ['mine.md'] }), { invalidSupporting: ['mine.md'] }, []],
    ['読めなかった記録', result({ limitations: 1 }), { limitations: 1 }, []],
  ]) {
    const out = merge(mergePlan({ preserved: ['mine.md'] }), [first, other])
    assert.equal(out.complete, false, label)
    for (const [k, v] of Object.entries(expectReviewer)) assert.deepEqual(out.reviewers[0][k], v, `${label}: ${k}`)
    assert.deepEqual(out.missingCoverage, missingCoverage, label)
    assert.equal(out.clusters.length, 1, `${label}: 他の reviewer の指摘は検証に回る`)
  }
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
const R3 = { mode: 'diff', headSha: H, excludePaths: EXCLUDE, generatedPaths: GENERATED, preserved: [], target: { files: ['a.md'] }, reviewers: ['a', 'b', 'c'].map((id) => ({ id, focus: id, files: ['a.md'] })) }
const CLUSTERS = [{ lens: 'a', members: [[0, 0], [1, 0]] }, { lens: 'b', members: [[1, 1]] }]
const ev = [{ path: 'a.md', line: 1 }]
const vote = (cluster, claim, verdict, evidence = verdict === 'confirmed' ? ev : []) => ({ cluster, claim, verdict, evidence })
const round = (assignments, results) => ({ assignments, verifications: results.map((r) => (r === null ? null : { head_sha: H, results: r })) })

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
  const otherHead = judge(R3, { clusters: CLUSTERS }, [{ assignments: first, verifications: [{ head_sha: H2, results: [vote(0, 0, 'confirmed'), vote(0, 1, 'confirmed')] }, { head_sha: H, results: ok1 }] }])
  assert.equal(otherHead.diagnostics[0].status, 'head_mismatch')
  assert.equal(otherHead.outcomes[0].verdict, 'pending')
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
