import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defaultIo, main, readExcludePaths, readGeneratedPaths } from './review-cli.mjs'
import { CODES, fnvSum } from './review-core.mjs'

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), 'review-cli.mjs')
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com',
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
}
const WORKFLOW_YML = [
  'jobs:',
  '  review:',
  '    with:',
  `      exclude-paths: '["**/*.lock","**/package-lock.json"]'`,
  '      review-policy-path: REVIEW.md',
  '',
].join('\n')

function git(repo, ...args) {
  return execFileSync('git', ['-C', repo, ...args], { env: GIT_ENV }).toString('utf8').trim()
}

function write(repo, file, text) {
  mkdirSync(path.dirname(path.join(repo, file)), { recursive: true })
  writeFileSync(path.join(repo, file), text)
}

// base: 方針と判定基準の定数だけ。head: 文書・lockfile・判定基準の写し・SKILL.md を変える。
function fixture(t) {
  const repo = realpathSync(mkdtempSync(path.join(tmpdir(), 'repo-review-cli-')))
  t.after(() => rmSync(repo, { recursive: true, force: true }))
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'commit.gpgsign', 'false')
  write(repo, '.github/workflows/claude_review.yml', WORKFLOW_YML)
  write(repo, 'plugins/p/skills/s/scripts/bp/constants.mjs', "export const CRITERIA_DIR = 'references/criteria';\n")
  write(repo, 'docs/a.md', 'a\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'base')
  const base = git(repo, 'rev-parse', 'HEAD')
  write(repo, 'docs/a.md', 'a2\n')
  write(repo, 'x/package-lock.json', '{}\n')
  write(repo, 'plugins/p/skills/s/references/criteria/specifications/c.md', 'copy\n')
  write(repo, 'plugins/p/skills/s/SKILL.md', '---\nname: s\n---\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'head')
  const head = git(repo, 'rev-parse', 'HEAD')
  return { repo, base, head }
}

function run(op, body, io = defaultIo()) {
  const { exitCode, output } = main([op], JSON.stringify(body), io)
  const parsed = JSON.parse(output)
  const { sum, ...rest } = parsed
  assert.equal(sum, fnvSum(rest), '出力の sum は本文と一致する')
  return { exitCode, ...parsed }
}

function signed(body) {
  return { ...body, sum: fnvSum(body) }
}

const REVIEWERS = [
  { id: 'skill-design', focus: 'スキル設計', files: ['plugins/p/skills/s/SKILL.md'] },
  { id: 'docs', focus: '文書', files: ['docs/a.md', 'plugins/p/skills/s/SKILL.md'] },
]

test('inventory: diff の変更を policyRef の exclude-paths と判定基準の写しの置き場で分ける', (t) => {
  const { repo, base, head } = fixture(t)
  const out = run('inventory', { repo, mode: 'diff', baseRef: base, headSha: head, policyRef: base })
  assert.equal(out.exitCode, 0)
  assert.deepEqual(out.inventory.excludePaths, ['**/*.lock', '**/package-lock.json'])
  assert.deepEqual(out.inventory.generatedPaths, ['plugins/p/skills/s/references/criteria/**'])
  assert.deepEqual(out.inventory.reviewable, ['docs/a.md', 'plugins/p/skills/s/SKILL.md'])
  assert.deepEqual(out.inventory.excluded, ['x/package-lock.json'])
  assert.deepEqual(out.inventory.generated, ['plugins/p/skills/s/references/criteria/specifications/c.md'])
  assert.deepEqual(out.pin_problems, [])
})

test('plan: 計画と plan_sum を返し、スキル設計の観点が無ければ E_PLAN で拒否する', (t) => {
  const { repo, base, head } = fixture(t)
  const body = { repo, mode: 'diff', baseRef: base, headSha: head, policyRef: base }
  const ok = run('plan', { ...body, reviewers: REVIEWERS })
  assert.equal(ok.exitCode, 0)
  assert.equal(ok.plan_sum, fnvSum(ok.plan))
  assert.deepEqual(ok.plan.target.files, ['docs/a.md', 'plugins/p/skills/s/SKILL.md'])
  assert.deepEqual(ok.plan.skillDesignTargets, ['plugins/p/skills/s/SKILL.md'])
  assert.equal(ok.plan.digests, null)
  const ng = run('plan', { ...body, reviewers: REVIEWERS.map((r) => ({ ...r, id: r.id === 'skill-design' ? 'structure' : r.id })) })
  assert.equal(ng.exitCode, 1)
  assert.equal(ng.code, CODES.plan)
})

test('diff: 移動・削除したファイルは元と先の両方の path をレビュー対象に入れる', (t) => {
  const { repo, head } = fixture(t)
  git(repo, 'mv', 'docs/a.md', 'docs/moved.md')
  git(repo, 'rm', '-q', 'plugins/p/skills/s/SKILL.md')
  git(repo, 'commit', '-q', '-m', 'move')
  const moved = git(repo, 'rev-parse', 'HEAD')
  const out = run('inventory', { repo, mode: 'diff', baseRef: head, headSha: moved, policyRef: head })
  assert.deepEqual(out.inventory.reviewable, ['docs/a.md', 'docs/moved.md', 'plugins/p/skills/s/SKILL.md'])
})

test('plan: diff は追跡ファイルの未コミットの変更と HEAD の食い違いを E_PIN で拒否する', (t) => {
  const { repo, base, head } = fixture(t)
  write(repo, 'docs/a.md', 'dirty\n')
  const dirty = run('plan', { repo, mode: 'diff', baseRef: base, headSha: head, policyRef: base, reviewers: REVIEWERS })
  assert.equal(dirty.code, CODES.pin)
  assert.match(dirty.reason, /未コミット/)
  git(repo, 'checkout', '-q', '--', 'docs/a.md')
  const moved = run('plan', { repo, mode: 'diff', baseRef: base, headSha: base, policyRef: base, reviewers: REVIEWERS })
  assert.equal(moved.code, CODES.pin)
  assert.match(moved.reason, /HEAD/)
})

test('working_tree: staged・unstaged・untracked を含め、呼び出し側の作業中の変更を外し、内容の SHA-256 を記録する', (t) => {
  const { repo, head } = fixture(t)
  write(repo, 'docs/a.md', 'unstaged\n')
  write(repo, 'docs/new.md', 'untracked\n')
  write(repo, 'docs/staged.md', 'staged\n')
  git(repo, 'add', 'docs/staged.md')
  write(repo, 'docs/mine.md', 'pre-existing\n')
  const reviewers = [
    { id: 'correctness', focus: 'x', files: ['docs/a.md', 'docs/new.md'] },
    { id: 'docs', focus: 'y', files: ['docs/staged.md'] },
  ]
  const out = run('plan', { repo, mode: 'working_tree', baseRef: head, headSha: head, policyRef: head, preservedPaths: ['docs/mine.md'], reviewers })
  assert.equal(out.exitCode, 0, out.reason)
  assert.deepEqual(out.plan.target.files, ['docs/a.md', 'docs/new.md', 'docs/staged.md'])
  assert.deepEqual(out.plan.preserved, ['docs/mine.md'])
  // 期待値は shasum -a 256 で求めた 'untracked\n' のバイト列の SHA-256。
  assert.equal(out.plan.digests['docs/new.md'], '528eee7ba2c0adea12842fd3eab1088d4d8402d115182154b0baef559f2164f2')
  assert.deepEqual(Object.keys(out.plan.digests).sort(), out.plan.target.files)
  write(repo, 'docs/new.md', 'changed during review\n')
  const pin = run('pin', signed({ plan: out.plan }))
  assert.equal(pin.exitCode, 0)
  assert.equal(pin.pin.ok, false)
  assert.deepEqual(pin.pin.changed, ['docs/new.md'])
})

test('audit: scope の下の追跡・未追跡のファイルを列挙し、symlink と存在しない scope を拒否する', (t) => {
  const { repo, head } = fixture(t)
  write(repo, 'docs/untracked.md', 'u\n')
  rmSync(path.join(repo, 'docs/a.md'))
  symlinkSync('docs', path.join(repo, 'link'))
  const inv = run('inventory', { repo, mode: 'audit', headSha: head, policyRef: head, scope: ['docs'] })
  assert.equal(inv.exitCode, 0, inv.reason)
  assert.deepEqual(inv.inventory.reviewable, ['docs/untracked.md'], '作業ツリーに無い追跡ファイルは今の内容に無いので入れない')
  const whole = run('inventory', { repo, mode: 'audit', headSha: head, policyRef: head, scope: ['.'] })
  assert.ok(whole.inventory.reviewable.includes('.github/workflows/claude_review.yml'))
  assert.ok(whole.inventory.excluded.includes('x/package-lock.json'))
  for (const [scope, pattern] of [[['link'], /symlink/], [['nope'], /無い/]]) {
    const out = run('inventory', { repo, mode: 'audit', headSha: head, policyRef: head, scope })
    assert.equal(out.code, CODES.input)
    assert.match(out.reason, pattern)
  }
})

test('運搬役の操作は sum の無い・合わない入力を E_TRANSPORT で拒否し、壊れた入力と未知の操作は使い方の誤りにする', (t) => {
  const { repo, base, head } = fixture(t)
  const { plan } = run('plan', { repo, mode: 'diff', baseRef: base, headSha: head, policyRef: base, reviewers: REVIEWERS })
  for (const [label, body] of [
    ['sum が無い', { plan }],
    ['sum が合わない', { plan, sum: '00000000' }],
    ['本文を 1 字変えた', { ...signed({ plan }), plan: { ...plan, headSha: base } }],
  ]) {
    const out = run('pin', body)
    assert.equal(out.exitCode, 1, label)
    assert.equal(out.code, CODES.transport, label)
  }
  const ok = run('pin', signed({ plan }))
  assert.equal(ok.pin.ok, true)
  for (const [argv, text] of [[['pin'], '{not json'], [['nope'], '{}'], [[], '{}'], [['pin', 'extra'], '{}']]) {
    const { exitCode, output } = main(argv, text)
    assert.equal(exitCode, 2, JSON.stringify(argv))
    assert.equal(JSON.parse(output).ok, false)
  }
})

test('exclude-paths と判定基準の置き場の読み取りは、形が合わなければ E_IO で止まる', () => {
  assert.deepEqual(readExcludePaths(WORKFLOW_YML), ['**/*.lock', '**/package-lock.json'])
  for (const yml of ['jobs: {}\n', `${WORKFLOW_YML}      exclude-paths: '["a"]'\n`, "      exclude-paths: 'not json'\n", "      exclude-paths: '[]'\n", "      exclude-paths: '[\"\"]'\n"]) {
    assert.throws(() => readExcludePaths(yml), (e) => e.code === CODES.io, yml)
  }
  const ref = 'f'.repeat(40)
  assert.deepEqual(readGeneratedPaths(`${ref}:plugins/p/skills/s/scripts/bp/constants.mjs:3:export const CRITERIA_DIR = 'references/criteria';\n`, ref), ['plugins/p/skills/s/references/criteria/**'])
  for (const out of ['', `${ref}:a.mjs:1:export const CRITERIA_DIR = 'x';\n${ref}:b.mjs:1:export const CRITERIA_DIR = 'y';\n`, `${ref}:tools/constants.mjs:1:export const CRITERIA_DIR = 'x';\n`]) {
    assert.throws(() => readGeneratedPaths(out, ref), (e) => e.code === CODES.io, out)
  }
})

test('CLI の入口: stdin の JSON を受けて 1 行の JSON と終了符号を返す', (t) => {
  const { repo, base, head } = fixture(t)
  const ok = spawnSync(process.execPath, [CLI, 'inventory'], { input: JSON.stringify({ repo, mode: 'diff', baseRef: base, headSha: head, policyRef: base }) })
  assert.equal(ok.status, 0, ok.stderr.toString())
  assert.equal(ok.stdout.toString().trim().split('\n').length, 1)
  assert.equal(JSON.parse(ok.stdout.toString()).ok, true)
  const ng = spawnSync(process.execPath, [CLI, 'inventory'], { input: JSON.stringify({ repo, mode: 'diff', headSha: head, policyRef: base }) })
  assert.equal(ng.status, 1)
  assert.equal(JSON.parse(ng.stdout.toString()).code, CODES.input)
})
