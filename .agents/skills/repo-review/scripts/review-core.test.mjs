import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CODES, ReviewError, buildPlan, canonical, checkPin, checkRequest, clusterByRange, finalize, fnvSum,
  globToRegExp, isRepoPath, merge, partition,
} from './review-core.mjs'

const H = 'a'.repeat(40)
const B = 'b'.repeat(40)
const P = 'c'.repeat(40)
const H2 = 'd'.repeat(40)
const EXCLUDE = ['**/*.lock', '**/package-lock.json']
const GENERATED = ['plugins/p/skills/s/references/criteria/**']

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
    ['plugins/*/workflows/*.js', 'plugins/a/workflows/x.js', true],
    ['plugins/*/workflows/*.js', 'plugins/a/b/workflows/x.js', false],
    ['a.b', 'axb', false],
  ]) assert.equal(globToRegExp(pattern).test(file), ok, `${pattern} ${file}`)
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
  assert.deepEqual(partition([], { excludePaths: EXCLUDE, generatedPaths: GENERATED }), { reviewable: [], excluded: [], generated: [], preserved: [] })
})

const baseRequest = { repo: '/r', mode: 'diff', baseRef: B, headSha: H, policyRef: P }
const twoReviewers = [{ id: 'correctness', focus: 'バグ', files: ['a.md'] }, { id: 'docs', focus: '文書', files: ['a.md'] }]

test('checkRequest は形の誤りを E_INPUT で全て挙げる', () => {
  for (const [label, patch, pattern] of [
    ['相対の repo', { repo: 'r' }, /repo は絶対パス/],
    ['未知の mode', { mode: 'pr' }, /mode は/],
    ['短い headSha', { headSha: 'abc' }, /headSha/],
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
    const request = { ...baseRequest, reviewers: twoReviewers, ...patch }
    rejects(() => checkRequest(request, { requireReviewers: true }), CODES.input, pattern, label)
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
  return { head: H, dirty: [], excludePaths: EXCLUDE, generatedPaths: GENERATED, paths, ...patch }
}

function request(patch = {}) {
  return checkRequest({ ...baseRequest, reviewers: twoReviewers, ...patch }, { requireReviewers: true })
}

test('buildPlan: 担当の和集合が対象と一致すれば計画を返し、除外・生成物は名前だけ残す', () => {
  const plan = buildPlan(request(), state(['a.md', 'x.lock', 'plugins/p/skills/s/references/criteria/y.md']), null)
  assert.deepEqual(plan.target.files, ['a.md'])
  assert.deepEqual(plan.excluded, ['x.lock'])
  assert.deepEqual(plan.generated, ['plugins/p/skills/s/references/criteria/y.md'])
  assert.equal(plan.digests, null)
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
    rejects(() => buildPlan(request({ reviewers }), state(paths), null), CODES.plan, pattern, label)
  }
})

test('スキル設計の観点の適用範囲（SKILL.md・agents・Workflow script）と、その外', () => {
  for (const [file, needs] of [
    ['plugins/p/skills/s/SKILL.md', true],
    ['.agents/skills/s/SKILL.md', true],
    ['plugins/p/skills/s/agents/reviewer.md', true],
    ['plugins/p/workflows/run.js', true],
    ['.agents/skills/s/scripts/review.js', true],
    ['plugins/p/skills/s/references/guide.md', false],
    ['plugins/p/skills/s/scripts/core.mjs', false],
    ['docs/guidelines/README.md', false],
  ]) {
    const reviewers = [{ id: 'skill-design', focus: 'スキル設計', files: [file] }, { id: 'docs', focus: '文書', files: [file] }]
    const plan = buildPlan(request({ reviewers }), state([file]), null)
    assert.deepEqual(plan.skillDesignTargets, needs ? [file] : [], file)
    if (needs) {
      const without = [{ id: 'correctness', focus: 'バグ', files: [file] }, { id: 'docs', focus: '文書', files: [file] }]
      rejects(() => buildPlan(request({ reviewers: without }), state([file]), null), CODES.plan, /スキル設計/)
    }
  }
})

test('buildPlan は HEAD の食い違い・diff の未コミットの変更・変更の無い preservedPaths を E_PIN で拒否する', () => {
  rejects(() => buildPlan(request(), state(['a.md'], { head: H2 }), null), CODES.pin, /HEAD/)
  rejects(() => buildPlan(request(), state(['a.md'], { dirty: ['a.md'] }), null), CODES.pin, /未コミット/)
  rejects(() => buildPlan(request({ mode: 'working_tree', preservedPaths: ['gone.md'] }), state(['a.md']), {}), CODES.pin, /preservedPaths/)
  const wt = buildPlan(request({ mode: 'working_tree', preservedPaths: ['mine.md'] }), state(['a.md', 'mine.md'], { dirty: ['a.md'] }), { 'a.md': 'h1' })
  assert.deepEqual(wt.preserved, ['mine.md'])
  assert.deepEqual(wt.digests, { 'a.md': 'h1' })
})

test('checkPin: 計画の後に HEAD・集合・内容のどれかが動いたら ok を落とす', () => {
  const plan = buildPlan(request({ mode: 'working_tree' }), state(['a.md']), { 'a.md': 'h1' })
  for (const [label, st, digests, ok, pattern] of [
    ['変化なし', state(['a.md']), { 'a.md': 'h1' }, true, null],
    ['HEAD が動いた', state(['a.md'], { head: H2 }), { 'a.md': 'h1' }, false, /HEAD/],
    ['変更が増えた', state(['a.md', 'b.md']), { 'a.md': 'h1' }, false, /reviewable/],
    ['内容が変わった', state(['a.md']), { 'a.md': 'h2' }, false, /内容/],
    ['対象が消えた', state(['a.md']), { 'a.md': null }, false, /内容/],
  ]) {
    const pin = checkPin(plan, st, digests)
    assert.equal(pin.ok, ok, label)
    if (pattern) assert.match(pin.problems.join('\n'), pattern, label)
  }
  const diffPlan = buildPlan(request(), state(['a.md']), null)
  assert.equal(checkPin(diffPlan, state(['a.md']), null).ok, true)
  assert.equal(checkPin(diffPlan, state(['a.md'], { dirty: ['a.md'] }), null).ok, false)
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
    mode: 'diff', headSha: H, excludePaths: EXCLUDE, generatedPaths: GENERATED,
    target: { files: ['a.md', 'b.md'] },
    reviewers: [{ id: 'correctness', focus: 'x', files: ['a.md', 'b.md'] }, { id: 'docs', focus: 'y', files: ['a.md'] }],
    ...patch,
  }
}

function result(patch = {}) {
  return { head_sha: H, coverage: ['a.md', 'b.md'], supporting_files: ['REVIEW.md'], limitations: [], findings: [], ...patch }
}

test('merge: 全員が担当を読み終え指摘が重なれば、候補は最初に挙げた観点の検証役に回る', () => {
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
  assert.deepEqual(out.groups, [{ lens: 'correctness', clusters: [0] }, { lens: 'docs', clusters: [1] }])
})

test('merge: 欠けた reviewer・HEAD の違い・読み残し・余分・重複・読めなかった記録は complete を落とすが、他の指摘は残す', () => {
  for (const [label, results, expectReviewer, missingCoverage] of [
    ['reviewer が返らない', [null, result({ coverage: ['a.md'], findings: [{ path: 'a.md', line: 1 }] })], { status: 'missing', missing: ['a.md', 'b.md'] }, ['b.md']],
    ['HEAD が違う', [result({ head_sha: H2 }), result({ coverage: ['a.md'], findings: [{ path: 'a.md', line: 1 }] })], { status: 'head_mismatch' }, ['b.md']],
    ['担当の読み残し', [result({ coverage: ['a.md'] }), result({ coverage: ['a.md'], findings: [{ path: 'a.md', line: 1 }] })], { status: 'ok', missing: ['b.md'] }, ['b.md']],
    ['担当外の coverage', [result({ coverage: ['a.md', 'b.md', 'z.md'] }), result({ coverage: ['a.md'], findings: [{ path: 'a.md', line: 1 }] })], { extra: ['z.md'] }, []],
    ['coverage の重複', [result({ coverage: ['a.md', 'b.md', 'a.md'] }), result({ coverage: ['a.md'], findings: [{ path: 'a.md', line: 1 }] })], { duplicate: ['a.md'] }, []],
    ['除外 path を根拠に読んだ', [result({ supporting_files: ['x.lock'] }), result({ coverage: ['a.md'], findings: [{ path: 'a.md', line: 1 }] })], { invalidSupporting: ['x.lock'] }, []],
    ['読めなかった記録', [result({ limitations: ['b.md を開けない'] }), result({ coverage: ['a.md'], findings: [{ path: 'a.md', line: 1 }] })], { limitations: 1 }, []],
  ]) {
    const out = merge(mergePlan(), results)
    assert.equal(out.complete, false, label)
    for (const [k, v] of Object.entries(expectReviewer)) assert.deepEqual(out.reviewers[0][k], v, `${label}: ${k}`)
    assert.deepEqual(out.missingCoverage, missingCoverage, label)
    assert.equal(out.clusters.length, 1, `${label}: 他の reviewer の指摘は検証に回る`)
  }
})

test('merge: 正規でない・除外・生成物・audit の対象外・行の逆転の指摘は候補にしない', () => {
  for (const [label, finding, mode] of [
    ['絶対パス', { path: '/a.md', line: 1 }, 'diff'],
    ['除外 path', { path: 'x.lock', line: 1 }, 'diff'],
    ['生成物', { path: 'plugins/p/skills/s/references/criteria/y.md', line: 1 }, 'diff'],
    ['audit の対象外', { path: 'caller.md', line: 1 }, 'audit'],
    ['line が 0', { path: 'a.md', line: 0 }, 'diff'],
    ['end_line < line', { path: 'a.md', line: 5, end_line: 4 }, 'diff'],
  ]) {
    const out = merge(mergePlan({ mode }), [result({ findings: [finding] }), result({ coverage: ['a.md'] })])
    assert.equal(out.clusters.length, 0, label)
    assert.equal(out.reviewers[0].invalidFindings.length, 1, label)
    assert.equal(out.complete, false, label)
  }
  rejects(() => merge(mergePlan(), [result()]), CODES.input, /同じ長さ/)
})

const twoClusters = {
  clusters: [
    { path: 'a.md', line: 1, end_line: 1, lens: 'correctness', in_target: true, members: [[0, 0], [1, 0]] },
    { path: 'b.md', line: 2, end_line: 2, lens: 'docs', in_target: true, members: [[1, 1]] },
  ],
  groups: [{ lens: 'correctness', clusters: [0] }, { lens: 'docs', clusters: [1] }],
}
const ev = [{ path: 'a.md', line: 1 }]

test('finalize: 全候補に有効な判定があれば complete、confirmed の主張の残りは refuted になる', () => {
  const out = finalize(mergePlan(), twoClusters, [
    { head_sha: H, results: [{ cluster: 0, verdict: 'confirmed', confirmed_members: [1], evidence: ev }] },
    { head_sha: H, results: [{ cluster: 1, verdict: 'refuted', confirmed_members: [], evidence: [] }] },
  ])
  assert.equal(out.complete, true)
  assert.deepEqual(out.outcomes, [
    { cluster: 0, verdict: 'confirmed', confirmed_members: [1], refuted_members: [0], source: 'verifier' },
    { cluster: 1, verdict: 'refuted', confirmed_members: [], refuted_members: [0], source: 'verifier' },
  ])
})

test('finalize: 欠けた・不正な判定は unverified にし、complete を落とす', () => {
  const ok1 = { head_sha: H, results: [{ cluster: 1, verdict: 'refuted', confirmed_members: [], evidence: [] }] }
  for (const [label, first, source, verifierField] of [
    ['検証役が返らない', null, 'missing', ['status', 'missing']],
    ['HEAD が違う', { head_sha: H2, results: [{ cluster: 0, verdict: 'confirmed', confirmed_members: [0], evidence: ev }] }, 'missing', ['status', 'head_mismatch']],
    ['候補への判定が無い', { head_sha: H, results: [] }, 'missing', ['missing', [0]]],
    ['担当外の候補', { head_sha: H, results: [{ cluster: 1, verdict: 'refuted', confirmed_members: [], evidence: [] }] }, 'missing', ['extra', [1]]],
    ['同じ候補を 2 回', { head_sha: H, results: [{ cluster: 0, verdict: 'refuted', confirmed_members: [], evidence: [] }, { cluster: 0, verdict: 'confirmed', confirmed_members: [0], evidence: ev }] }, 'invalid', ['duplicate', [0]]],
    ['confirmed に根拠が無い', { head_sha: H, results: [{ cluster: 0, verdict: 'confirmed', confirmed_members: [0], evidence: [] }] }, 'invalid', null],
    ['confirmed の主張が空', { head_sha: H, results: [{ cluster: 0, verdict: 'confirmed', confirmed_members: [], evidence: ev }] }, 'invalid', null],
    ['主張の番号が範囲外', { head_sha: H, results: [{ cluster: 0, verdict: 'confirmed', confirmed_members: [2], evidence: ev }] }, 'invalid', null],
    ['refuted に confirmed_members', { head_sha: H, results: [{ cluster: 0, verdict: 'refuted', confirmed_members: [0], evidence: [] }] }, 'invalid', null],
    ['除外 path を根拠にした', { head_sha: H, results: [{ cluster: 0, verdict: 'confirmed', confirmed_members: [0], evidence: [{ path: 'x.lock', line: 1 }] }] }, 'invalid', null],
    ['生成物を根拠にした', { head_sha: H, results: [{ cluster: 0, verdict: 'refuted', confirmed_members: [], evidence: [{ path: 'plugins/p/skills/s/references/criteria/y.md', line: 1 }] }] }, 'invalid', null],
    ['検証役の unverified', { head_sha: H, results: [{ cluster: 0, verdict: 'unverified', confirmed_members: [], evidence: [] }] }, 'verifier', null],
  ]) {
    const out = finalize(mergePlan(), twoClusters, [first, ok1])
    assert.equal(out.complete, false, label)
    assert.equal(out.outcomes[0].verdict, 'unverified', label)
    assert.equal(out.outcomes[0].source, source, label)
    assert.equal(out.outcomes[1].verdict, 'refuted', `${label}: 他の候補の判定は残る`)
    if (verifierField) assert.deepEqual(out.verifiers[0][verifierField[0]], verifierField[1], label)
  }
  rejects(() => finalize(mergePlan(), twoClusters, [null]), CODES.input, /同じ長さ/)
})

test('finalize: 候補が 0 件なら判定なしで complete', () => {
  assert.deepEqual(finalize(mergePlan(), { clusters: [], groups: [] }, []), { complete: true, verifiers: [], outcomes: [] })
})
