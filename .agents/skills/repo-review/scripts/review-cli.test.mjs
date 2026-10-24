import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defaultIo, main, parseCriteriaDir, parseCriteriaTool, readExcludePaths } from './review-cli.mjs'
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
const TOOL = [
  "import path from 'node:path';",
  "import { CRITERIA_DIR, CRITERIA_FILES } from '../plugins/p/skills/s/scripts/bp/constants.mjs';",
  "const SKILL = path.join('plugins', 'p', 'skills', 's');",
  'function copyRoot(root) {',
  '  return path.join(root, SKILL, CRITERIA_DIR);',
  '}',
  '',
].join('\n')

const REVIEW_MD = [
  '# Review',
  '',
  '方針は `docs/rules.md`（以下 rules.md）を正本とする。',
  '',
  '## 読むもの',
  '',
  '| 変更 | 読むもの |',
  '|---|---|',
  '| `*.md` | `docs/guide.md`、rules.md「作業ルール」・「無い節」 |',
  '| すべて | `docs/missing.md` |',
  '',
  '## 重大度',
  '',
].join('\n')
const RULES_MD = '# Rules\n\n## 作業ルール\n\n- 写さない\n\n## ほか\n\nx\n'

function git(repo, ...args) {
  return execFileSync('git', ['-C', repo, ...args], { env: GIT_ENV }).toString('utf8').trim()
}

function write(repo, file, text) {
  mkdirSync(path.dirname(path.join(repo, file)), { recursive: true })
  writeFileSync(path.join(repo, file), text)
}

function tmp(t, prefix) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

// base: 方針・写しの tool・判定基準の定数だけ。head: 文書・lockfile・判定基準の写し・SKILL.md・Workflow source・ヘルパーの .js を変える。
function fixture(t, { tool = true } = {}) {
  const repo = tmp(t, 'repo-review-cli-')
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'commit.gpgsign', 'false')
  write(repo, '.github/workflows/claude_review.yml', WORKFLOW_YML)
  write(repo, 'REVIEW.md', REVIEW_MD)
  write(repo, 'docs/rules.md', RULES_MD)
  write(repo, 'docs/guide.md', 'guide\n')
  if (tool) write(repo, 'tools/sync-bp-criteria.mjs', TOOL)
  write(repo, 'plugins/p/skills/s/scripts/bp/constants.mjs', "export const CRITERIA_DIR = 'references/criteria';\n")
  write(repo, 'docs/a.md', 'a\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'base')
  const base = git(repo, 'rev-parse', 'HEAD')
  write(repo, 'docs/a.md', 'a2\n')
  write(repo, 'x/package-lock.json', '{}\n')
  write(repo, 'plugins/p/skills/s/references/criteria/specifications/c.md', 'copy\n')
  write(repo, 'plugins/p/skills/s/SKILL.md', '---\nname: s\n---\n')
  write(repo, 'plugins/p/skills/s/scripts/run.js', "export const meta = { name: 'run', description: 'd' }\n")
  write(repo, 'plugins/p/skills/s/scripts/helper.js', 'export function f() {}\n')
  symlinkSync('../docs', path.join(repo, 'plugins/p/docs-link'))
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'head')
  return { repo, base, head: git(repo, 'rev-parse', 'HEAD'), stateDir: tmp(t, 'repo-review-state-') }
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

const HEAD_FILES = ['docs/a.md', 'plugins/p/docs-link', 'plugins/p/skills/s/SKILL.md', 'plugins/p/skills/s/scripts/helper.js', 'plugins/p/skills/s/scripts/run.js']
const REVIEWERS = [
  { id: 'skill-design', focus: 'スキル設計', files: ['plugins/p/skills/s/SKILL.md', 'plugins/p/skills/s/scripts/run.js'] },
  { id: 'docs', focus: '文書', files: HEAD_FILES },
]

function diffBody({ repo, base, head }) {
  return { repo, mode: 'diff', baseRef: base, headSha: head, policyRef: base }
}

test('inventory: diff の変更を policyRef の exclude-paths と、写しの tool が書く置き場で分ける', (t) => {
  const fx = fixture(t)
  const out = run('inventory', diffBody(fx))
  assert.equal(out.exitCode, 0, out.reason)
  assert.deepEqual(out.inventory.excludePaths, ['**/*.lock', '**/package-lock.json'])
  assert.deepEqual(out.inventory.generatedPaths, ['plugins/p/skills/s/references/criteria/**'])
  assert.deepEqual(out.inventory.reviewable, HEAD_FILES)
  assert.deepEqual(out.inventory.excluded, ['x/package-lock.json'])
  assert.deepEqual(out.inventory.generated, ['plugins/p/skills/s/references/criteria/specifications/c.md'])
  assert.match(out.generated_note, /SP-BPRUN-036/)
  assert.deepEqual(out.pin_problems, [])
})

test('inventory: policyRef に写しの tool が無ければ生成物は無い（E_IO にしない）', (t) => {
  const fx = fixture(t, { tool: false })
  const out = run('inventory', diffBody(fx))
  assert.equal(out.exitCode, 0, out.reason)
  assert.deepEqual(out.inventory.generatedPaths, [])
  assert.ok(out.inventory.reviewable.includes('plugins/p/skills/s/references/criteria/specifications/c.md'))
})

test('plan: 計画を stateDir のファイルに書き、symlink と内容で判定した Workflow source を記録する', (t) => {
  const fx = fixture(t)
  const out = run('plan', { ...diffBody(fx), reviewers: REVIEWERS, stateDir: fx.stateDir })
  assert.equal(out.exitCode, 0, out.reason)
  assert.equal(out.plan_sum, fnvSum(out.plan))
  assert.equal(path.dirname(out.plan_path), fx.stateDir)
  assert.deepEqual(JSON.parse(readFileSync(out.plan_path, 'utf8')), out.plan)
  assert.deepEqual(out.plan.symlinks, ['plugins/p/docs-link'])
  assert.deepEqual(out.plan.symlinkMap, { 'plugins/p/docs-link': 'plugins/docs' }, '追跡中の symlink を実体の path へ解決した対応表')
  const pack = readFileSync(out.plan.policyPack.path, 'utf8')
  assert.equal(path.dirname(out.plan.policyPack.path), fx.stateDir)
  assert.match(out.plan.policyPack.token, /^[0-9a-f]{12}$/)
  assert.ok(pack.includes(`読取りトークン（policy_pack_token に返す）: ${out.plan.policyPack.token}`))
  assert.deepEqual(out.plan.policyPack.index.map((e) => [e.id, e.path, e.title]), [['P1', 'REVIEW.md', null], ['P2', 'docs/guide.md', null], ['P3', 'docs/rules.md', '作業ルール']])
  assert.deepEqual(out.plan.policyPack.missing, [{ path: 'docs/rules.md', title: '無い節', reason: '節が無い' }, { path: 'docs/missing.md', reason: 'policyRef に無い' }])
  const lines = pack.split('\n')
  const p3 = out.plan.policyPack.index[2]
  assert.equal(lines[p3.pack[0] - 1], '## [P3] docs/rules.md「作業ルール」')
  assert.deepEqual(lines.slice(p3.pack[0], p3.pack[1]), ['docs/rules.md:3| ## 作業ルール', 'docs/rules.md:4| ', 'docs/rules.md:5| - 写さない', 'docs/rules.md:6| '])
  assert.match(pack, /束に入れなかったもの（見ていない）: docs\/rules.md「無い節」（節が無い）・docs\/missing.md（policyRef に無い）/)
  assert.deepEqual(out.plan.skillDesignTargets, ['plugins/p/skills/s/SKILL.md', 'plugins/p/skills/s/scripts/run.js'], 'helper.js は Workflow source でない')
  assert.equal(out.plan.digests, null)
  const ng = run('plan', { ...diffBody(fx), reviewers: REVIEWERS.map((r) => ({ ...r, id: r.id === 'skill-design' ? 'structure' : r.id })), stateDir: fx.stateDir })
  assert.equal(ng.code, CODES.plan)
})

test('plan: stateDir が無い・repo の中なら E_INPUT で拒否し、ファイルを書かない', (t) => {
  const fx = fixture(t)
  for (const [label, stateDir] of [['repo の中', path.join(fx.repo, 'docs')], ['repo そのもの', fx.repo], ['無い', path.join(fx.stateDir, 'nope')], ['相対', 'tmp']]) {
    const out = run('plan', { ...diffBody(fx), reviewers: REVIEWERS, stateDir })
    assert.equal(out.code, CODES.input, label)
  }
  assert.equal(git(fx.repo, 'status', '--porcelain'), '')
})

test('diff は head を checkout した clean な作業ツリーでだけ計画でき、変更・未追跡・別の HEAD・commit の欠けは E_PIN、計画の後の変化は pin が拾う', (t) => {
  const fx = fixture(t)
  const plan = () => run('plan', { ...diffBody(fx), reviewers: REVIEWERS, stateDir: fx.stateDir })
  const ok = plan()
  assert.equal(ok.exitCode, 0, ok.reason)
  const ref = signed({ planPath: ok.plan_path, planSum: ok.plan_sum })
  for (const [label, dirty, undo, pattern] of [
    ['追跡ファイルの変更', () => write(fx.repo, 'docs/a.md', 'dirty\n'), () => git(fx.repo, 'checkout', '-q', '--', 'docs/a.md'), /作業ツリー/],
    ['未追跡のファイル', () => write(fx.repo, 'docs/new.md', 'n\n'), () => rmSync(path.join(fx.repo, 'docs/new.md')), /作業ツリー/],
    ['別の HEAD', () => git(fx.repo, 'checkout', '-q', '--detach', fx.base), () => git(fx.repo, 'checkout', '-q', '--detach', fx.head), /HEAD/],
  ]) {
    dirty()
    const ng = plan()
    assert.equal(ng.code, CODES.pin, label)
    assert.equal(ng.causes.length, 1, label)
    assert.equal(ng.causes[0].by, 'user', `${label}: diff で作業ツリーを戻すのは利用者`)
    assert.match(ng.causes[0].action, /利用者/, `${label}: 次の手を CLI が返す`)
    assert.match(ng.reason, pattern, label)
    const pin = run('pin', ref)
    assert.equal(pin.pin.ok, false, `${label}: 計画の後に起きても pin が拾う`)
    undo()
  }
  assert.equal(run('pin', ref).pin.ok, true)
  const missing = run('plan', { ...diffBody(fx), headSha: 'e'.repeat(40), reviewers: REVIEWERS, stateDir: fx.stateDir })
  assert.equal(missing.code, CODES.pin)
  assert.match(missing.reason, /commit が無い/)
})

test('diff: Workflow source は置き場の中だけを内容で判定し、削除したものは base の版で判定する', (t) => {
  const fx = fixture(t)
  write(fx.repo, 'tests/fixtures/t/scripts/fixture.js', "export const meta = { name: 'f', description: 'd' }\n")
  git(fx.repo, 'rm', '-q', 'plugins/p/skills/s/scripts/run.js')
  git(fx.repo, 'add', '-A')
  git(fx.repo, 'commit', '-q', '-m', 'delete')
  const next = git(fx.repo, 'rev-parse', 'HEAD')
  const files = ['plugins/p/skills/s/scripts/run.js', 'tests/fixtures/t/scripts/fixture.js']
  const reviewers = [{ id: 'skill-design', focus: 'x', files: ['plugins/p/skills/s/scripts/run.js'] }, { id: 'docs', focus: 'y', files }]
  const out = run('plan', { repo: fx.repo, mode: 'diff', baseRef: fx.head, headSha: next, policyRef: fx.head, reviewers, stateDir: fx.stateDir })
  assert.equal(out.exitCode, 0, out.reason)
  assert.deepEqual(out.plan.skillDesignTargets, ['plugins/p/skills/s/scripts/run.js'])
  const without = run('plan', { repo: fx.repo, mode: 'diff', baseRef: fx.head, headSha: next, policyRef: fx.head, reviewers: reviewers.map((r) => ({ ...r, id: r.id === 'skill-design' ? 'other' : r.id })), stateDir: fx.stateDir })
  assert.equal(without.code, CODES.plan, '削除した Workflow source もスキル設計の観点に割り当てる')
})

test('diff: 移動・削除したファイルは元と先の両方の path をレビュー対象に入れる', (t) => {
  const fx = fixture(t)
  git(fx.repo, 'mv', 'docs/a.md', 'docs/moved.md')
  git(fx.repo, 'rm', '-q', 'plugins/p/skills/s/SKILL.md')
  git(fx.repo, 'commit', '-q', '-m', 'move')
  const moved = git(fx.repo, 'rev-parse', 'HEAD')
  const out = run('inventory', { repo: fx.repo, mode: 'diff', baseRef: fx.head, headSha: moved, policyRef: fx.head })
  assert.deepEqual(out.inventory.reviewable, ['docs/a.md', 'docs/moved.md', 'plugins/p/skills/s/SKILL.md'])
})

test('working_tree: staged・unstaged・untracked を含め、作業中の変更を外し、種類つきの SHA-256 を記録し、pin が内容の変化を拾う', (t) => {
  const fx = fixture(t)
  write(fx.repo, 'docs/a.md', 'unstaged\n')
  write(fx.repo, 'docs/new.md', 'untracked\n')
  write(fx.repo, 'docs/staged.md', 'staged\n')
  git(fx.repo, 'add', 'docs/staged.md')
  write(fx.repo, 'docs/mine.md', 'pre-existing\n')
  const reviewers = [
    { id: 'correctness', focus: 'x', files: ['docs/a.md', 'docs/new.md'] },
    { id: 'docs', focus: 'y', files: ['docs/staged.md'] },
  ]
  const out = run('plan', { repo: fx.repo, mode: 'working_tree', baseRef: fx.head, headSha: fx.head, policyRef: fx.head, preservedPaths: ['docs/mine.md'], reviewers, stateDir: fx.stateDir })
  assert.equal(out.exitCode, 0, out.reason)
  assert.deepEqual(out.plan.target.files, ['docs/a.md', 'docs/new.md', 'docs/staged.md'])
  assert.deepEqual(out.plan.preserved, ['docs/mine.md'])
  // 期待値は shasum -a 256 で求めた 'untracked\n' のバイト列の SHA-256 に種類を付けたもの。
  assert.equal(out.plan.digests['docs/new.md'], 'file:528eee7ba2c0adea12842fd3eab1088d4d8402d115182154b0baef559f2164f2')
  assert.deepEqual(Object.keys(out.plan.digests).sort(), out.plan.target.files)
  const ref = { planPath: out.plan_path, planSum: out.plan_sum }
  assert.equal(run('pin', signed(ref)).pin.ok, true)
  const pack = out.plan.policyPack.path
  const packText = readFileSync(pack, 'utf8')
  writeFileSync(pack, `${packText}x`)
  assert.match(run('pin', signed(ref)).pin.problems.join('\n'), /方針の束/, '束が計画の後に変わったら pin が拾う')
  writeFileSync(pack, packText)
  rmSync(pack)
  const gonePack = run('pin', signed(ref)).pin
  assert.equal(gonePack.ok, false, '束が消えたら pin が拾う')
  assert.deepEqual(gonePack.causes.map((c) => c.cause), ['pack'])
  writeFileSync(pack, packText)
  write(fx.repo, 'docs/new.md', 'changed during review\n')
  const pin = run('pin', signed(ref))
  assert.equal(pin.exitCode, 0)
  assert.equal(pin.pin.ok, false)
  assert.deepEqual(pin.pin.changed, ['docs/new.md'])
})

test('audit: scope の下の追跡・未追跡のファイルを列挙し、symlink を通る scope と存在しない scope を拒否する', (t) => {
  const fx = fixture(t)
  write(fx.repo, 'docs/untracked.md', 'u\n')
  rmSync(path.join(fx.repo, 'docs/a.md'))
  symlinkSync('docs', path.join(fx.repo, 'link'))
  const audit = (scope) => run('inventory', { repo: fx.repo, mode: 'audit', headSha: fx.head, policyRef: fx.head, scope })
  const inv = audit(['docs'])
  assert.equal(inv.exitCode, 0, inv.reason)
  assert.deepEqual(inv.inventory.reviewable, ['docs/guide.md', 'docs/rules.md', 'docs/untracked.md'], '作業ツリーに無い追跡ファイル（docs/a.md）は今の内容に無いので入れない')
  const whole = audit(['.'])
  assert.ok(whole.inventory.reviewable.includes('.github/workflows/claude_review.yml'))
  assert.ok(whole.inventory.reviewable.includes('plugins/p/docs-link'), '追跡中の symlink はリンク先の文字列として対象に入る')
  assert.ok(whole.inventory.excluded.includes('x/package-lock.json'))
  for (const [scope, pattern] of [[['link'], /symlink/], [['link/untracked.md'], /symlink/], [['plugins/p/docs-link/untracked.md'], /symlink/], [['nope'], /無い/]]) {
    const out = audit(scope)
    assert.equal(out.code, CODES.input, scope[0])
    assert.match(out.reason, pattern, scope[0])
  }
})

test('pin: 対象を集め直せない（scope が消えた）ときは pin.ok を落とし、計画の不一致は E_INPUT で拒否する', (t) => {
  const fx = fixture(t)
  const reviewers = [{ id: 'correctness', focus: 'x', files: ['docs/a.md'] }, { id: 'docs', focus: 'y', files: ['docs/a.md'] }]
  const out = run('plan', { repo: fx.repo, mode: 'audit', headSha: fx.head, policyRef: fx.head, scope: ['docs/a.md'], reviewers, stateDir: fx.stateDir })
  assert.equal(out.exitCode, 0, out.reason)
  const ref = { planPath: out.plan_path, planSum: out.plan_sum }
  rmSync(path.join(fx.repo, 'docs'), { recursive: true })
  const gone = run('pin', signed(ref))
  assert.equal(gone.exitCode, 0)
  assert.equal(gone.pin.ok, false)
  assert.deepEqual(gone.pin.causes.map((c) => c.cause), ['collect'])
  assert.match(gone.pin.problems.join('\n'), /scope/)
  for (const [label, body] of [
    ['planSum の違い', { ...ref, planSum: '00000000' }],
    ['planPath が無い', { planSum: ref.planSum }],
    ['planPath のファイルが無い', { ...ref, planPath: path.join(fx.stateDir, 'none.json') }],
  ]) {
    const r = run('pin', signed(body))
    assert.equal(r.code, CODES.input, label)
    assert.equal(r.retry, 'replan', `${label}: 前処理の 3 からやり直せば直り得る`)
  }
  const original = JSON.parse(readFileSync(out.plan_path, 'utf8'))
  for (const [label, patch] of [
    ['option に見える headSha', { headSha: '--output=x' }],
    ['target の欠け', { target: undefined }],
    ['excluded の型の違い', { excluded: 'x' }],
    ['audit の digests が null', { digests: null }],
    ['generatedNote の欠け', { generatedNote: undefined }],
  ]) {
    const tampered = { ...original, ...patch }
    const file = path.join(fx.stateDir, 'tampered.json')
    writeFileSync(file, JSON.stringify(tampered))
    assert.equal(run('pin', signed({ planPath: file, planSum: fnvSum(tampered) })).code, CODES.input, `${label}: 計画を使う前に検証し直す`)
  }
})

test('運搬役の操作は sum の無い・合わない入力を E_TRANSPORT で拒否し、壊れた入力と未知の操作は使い方の誤り、想定外の例外は E_INTERNAL にする', (t) => {
  const fx = fixture(t)
  const out = run('plan', { ...diffBody(fx), reviewers: REVIEWERS, stateDir: fx.stateDir })
  const ref = { planPath: out.plan_path, planSum: out.plan_sum }
  for (const [label, body] of [
    ['sum が無い', ref],
    ['sum が合わない', { ...ref, sum: '00000000' }],
    ['本文を 1 字変えた', { ...signed(ref), planSum: '11111111' }],
  ]) {
    const r = run('pin', body)
    assert.equal(r.exitCode, 1, label)
    assert.equal(r.code, CODES.transport, label)
  }
  assert.equal(run('pin', signed(ref)).pin.ok, true)
  for (const [argv, text] of [[['pin'], '{not json'], [['nope'], '{}'], [[], '{}'], [['pin', 'extra'], '{}']]) {
    const { exitCode, output } = main(argv, text)
    assert.equal(exitCode, 2, JSON.stringify(argv))
    assert.equal(JSON.parse(output).ok, false)
  }
  const broken = { ...defaultIo(), git: () => { throw new TypeError('boom') } }
  const internal = run('pin', signed(ref), broken)
  assert.equal(internal.code, CODES.internal)
  assert.equal(internal.retry, 'none')
})

test('exclude-paths と写しの書き先の読み取りは、形が合わなければ E_POLICY で止まる（git の失敗の E_IO と分ける）', () => {
  assert.deepEqual(readExcludePaths(WORKFLOW_YML), ['**/*.lock', '**/package-lock.json'])
  for (const yml of ['jobs: {}\n', `${WORKFLOW_YML}      exclude-paths: '["a"]'\n`, "      exclude-paths: 'not json'\n", "      exclude-paths: '[]'\n", "      exclude-paths: '[\"\"]'\n"]) {
    assert.throws(() => readExcludePaths(yml), (e) => e.code === CODES.policy, yml)
  }
  assert.deepEqual(parseCriteriaTool(TOOL), { skill: 'plugins/p/skills/s', constants: 'plugins/p/skills/s/scripts/bp/constants.mjs' })
  for (const [label, text] of [
    ['SKILL が変数を含む', TOOL.replace("path.join('plugins', 'p', 'skills', 's')", "path.join(BASE, 's')")],
    ['CRITERIA_DIR を import しない', TOOL.replace('CRITERIA_DIR, ', '')],
    ['書き先の式が違う', TOOL.replace('path.join(root, SKILL, CRITERIA_DIR)', 'path.join(root, CRITERIA_DIR)')],
    ['import 先がリポジトリの外', TOOL.replace("'../plugins/", "'../../plugins/")],
  ]) assert.throws(() => parseCriteriaTool(text), (e) => e.code === CODES.policy, label)
  assert.equal(parseCriteriaDir("export const CRITERIA_DIR = 'references/criteria';\n"), 'references/criteria')
  for (const text of ['', "export const CRITERIA_DIR = 'a';\nexport const CRITERIA_DIR = 'b';\n", 'export const CRITERIA_DIR = CONST;\n']) {
    assert.throws(() => parseCriteriaDir(text), (e) => e.code === CODES.policy, text)
  }
})

test('CLI の入口: stdin の JSON を受けて 1 行の JSON と終了符号を返す', (t) => {
  const fx = fixture(t)
  const ok = spawnSync(process.execPath, [CLI, 'inventory'], { input: JSON.stringify(diffBody(fx)) })
  assert.equal(ok.status, 0, ok.stderr.toString())
  assert.equal(ok.stdout.toString().trim().split('\n').length, 1)
  assert.equal(JSON.parse(ok.stdout.toString()).ok, true)
  const ng = spawnSync(process.execPath, [CLI, 'inventory'], { input: JSON.stringify({ ...diffBody(fx), baseRef: undefined }) })
  assert.equal(ng.status, 1)
  assert.equal(JSON.parse(ng.stdout.toString()).code, CODES.input)
})

test('policyRef に claude_review.yml や CRITERIA_DIR の import 先が無ければ E_POLICY（git の失敗の E_IO と分ける）', (t) => {
  for (const [label, file] of [['claude_review.yml', '.github/workflows/claude_review.yml'], ['import 先', 'plugins/p/skills/s/scripts/bp/constants.mjs']]) {
    const fx = fixture(t)
    git(fx.repo, 'rm', '-q', file)
    git(fx.repo, 'commit', '-q', '-m', 'rm')
    const head = git(fx.repo, 'rev-parse', 'HEAD')
    const out = run('inventory', { repo: fx.repo, mode: 'diff', baseRef: fx.head, headSha: head, policyRef: head })
    assert.equal(out.code, CODES.policy, label)
  }
})

test('working_tree・audit の symlinkMap は作業ツリーの symlink（追跡中・未追跡）から作り、計画の後の変化を pin が拾う', (t) => {
  const fx = fixture(t)
  symlinkSync('../docs/a.md', path.join(fx.repo, 'plugins/p/untracked-link'))
  rmSync(path.join(fx.repo, 'plugins/p/docs-link'))
  symlinkSync('../x', path.join(fx.repo, 'plugins/p/docs-link'))
  const reviewers = [{ id: 'correctness', focus: 'x', files: ['plugins/p/docs-link', 'plugins/p/untracked-link'] }, { id: 'docs', focus: 'y', files: ['plugins/p/docs-link'] }]
  const out = run('plan', { repo: fx.repo, mode: 'working_tree', baseRef: fx.head, headSha: fx.head, policyRef: fx.head, reviewers, stateDir: fx.stateDir })
  assert.equal(out.exitCode, 0, out.reason)
  assert.deepEqual(out.plan.symlinkMap, { 'plugins/p/docs-link': 'plugins/x', 'plugins/p/untracked-link': 'plugins/docs/a.md' }, '作業ツリーのリンク先で解決し、未追跡の link も入れる')
  const ref = signed({ planPath: out.plan_path, planSum: out.plan_sum })
  assert.equal(run('pin', ref).pin.ok, true)
  symlinkSync('../docs', path.join(fx.repo, 'plugins/p/another-link'))
  const pin = run('pin', ref).pin
  assert.equal(pin.ok, false)
  assert.match(pin.problems.join('\n'), /symlinkMap/)
})
