import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { THREADS_QUERY, defaultIo, main } from './address-cli.mjs'
import { CODES, REPOSITORY, fnvSum } from './address-core.mjs'

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), 'address-cli.mjs')
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com',
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
}

function git(repo, ...args) {
  return execFileSync('git', ['-C', repo, ...args], { env: GIT_ENV }).toString('utf8').trim()
}

function tmp(t, prefix) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function write(repo, file, text) {
  mkdirSync(path.dirname(path.join(repo, file)), { recursive: true })
  writeFileSync(path.join(repo, file), text)
}

const user = (login) => ({ login })

// 偽の GitHub。gh の argv を受けて、実物の gh と同じ形（--paginate --slurp はページの配列）の JSON を返す。
function fakeGithub(fx) {
  const gh = {
    calls: [],
    repository: REPOSITORY,
    viewer: 'me',
    view: { number: 7, state: 'OPEN', isCrossRepository: false, headRefName: 'feat/x', headRefOid: fx.head, baseRefOid: fx.base },
    inline: [
      { id: 11, user: user('github-actions[bot]'), path: 'src/a.mjs', line: 1, in_reply_to_id: null, body: '[HIGH] a が 1 のまま', created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z', html_url: 'https://x/11' },
      { id: 21, user: user('github-actions[bot]'), path: 'src/a.mjs', line: null, original_line: 1, in_reply_to_id: null, body: '[LOW] 古い', created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z', html_url: 'https://x/21' },
    ],
    issues: [
      { id: 31, user: user('github-actions[bot]'), body: 'summary: README の古い記述', created_at: '2026-10-01T02:00:00Z', updated_at: '2026-10-01T02:00:00Z', html_url: 'https://x/31' },
    ],
    reviews: [{ id: 41, user: user('github-actions[bot]'), body: '', state: 'COMMENTED', submitted_at: '2026-10-01T00:00:00Z', html_url: 'https://x/41' }],
    threads: [
      { id: 'T11', isResolved: false, isOutdated: false, comments: { nodes: [{ databaseId: 11 }] } },
      { id: 'T21', isResolved: false, isOutdated: true, comments: { nodes: [{ databaseId: 21 }] } },
    ],
  }
  const half = (list) => [list.slice(0, 1), list.slice(1)]
  gh.run = (cwd, args) => {
    gh.calls.push({ cwd, args })
    const [a, b] = args
    if (a === 'repo' && b === 'view') return JSON.stringify({ nameWithOwner: gh.repository })
    if (a === 'pr' && b === 'view') return JSON.stringify(gh.view)
    if (a === 'api' && b === 'user') return JSON.stringify({ login: gh.viewer })
    if (a === 'api' && b === 'graphql') {
      return JSON.stringify(half(gh.threads).map((nodes, n) => ({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: n === 0, endCursor: `c${n}` }, nodes } } } } })))
    }
    if (a === 'api' && b === '--paginate') {
      const endpoint = args[3].replace(/\?per_page=100$/, '')
      const base = `repos/${REPOSITORY}/`
      const list = { [`${base}pulls/7/comments`]: gh.inline, [`${base}issues/7/comments`]: gh.issues, [`${base}pulls/7/reviews`]: gh.reviews }[endpoint]
      if (!list) throw new Error(`unexpected endpoint ${endpoint}`)
      return JSON.stringify(half(list))
    }
    throw new Error(`unexpected gh ${args.join(' ')}`)
  }
  gh.post = (place, body, id) => {
    if (place.kind === 'thread') gh.inline.push({ id, user: user(gh.viewer), path: 'src/a.mjs', line: 1, in_reply_to_id: place.reply_to, body, created_at: 'z', updated_at: 'z', html_url: `https://x/${id}` })
    else gh.issues.push({ id, user: user(gh.viewer), body, created_at: '2026-10-02T00:00:00Z', updated_at: 'z', html_url: `https://x/${id}` })
  }
  return gh
}

function fixture(t) {
  const repo = tmp(t, 'address-cli-repo-')
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'commit.gpgsign', 'false')
  write(repo, 'src/a.mjs', 'export const a = 1\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'base')
  const base = git(repo, 'rev-parse', 'HEAD')
  git(repo, 'switch', '-q', '-c', 'feat/x')
  write(repo, 'README.md', 'r\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'head')
  const head = git(repo, 'rev-parse', 'HEAD')
  const fx = { repo, base, head, stateDir: tmp(t, 'address-cli-state-') }
  fx.gh = fakeGithub(fx)
  const real = defaultIo()
  fx.io = { ...real, gh: (cwd, args) => fx.gh.run(cwd, args) }
  return fx
}

const cli = (fx, op, body) => {
  const r = main([op], JSON.stringify(body), fx.io)
  return { ...JSON.parse(r.output), exitCode: r.exitCode }
}
const collect = (fx, extra = {}) => cli(fx, 'collect', { repo: fx.repo, pr: 7, stateDir: fx.stateDir, ...extra })

function triageOf(c, classify) {
  const results = c.state.items.map((i) => {
    const classification = classify(i)
    return {
      comment_id: i.comment_id, classification, reason: '確かめた', evidence: [{ path: 'src/a.mjs', line: 1, claim: 'a は 1' }],
      repair_paths: classification === 'fix' ? ['src/a.mjs'] : [], decision_questions: [], reply_draft: '確かめました。', limitation: '',
    }
  })
  const body = { status: 'completed', results, stateSum: c.state_sum }
  return { ...body, sum: fnvSum(body) }
}

const ref = (c) => ({ statePath: c.state_path, stateSum: c.state_sum })

test('collect は全ページを取り、既定の除外を名前だけ残して stateDir に書く', (t) => {
  const fx = fixture(t)
  const c = collect(fx)
  assert.equal(c.ok, true, c.reason)
  assert.deepEqual(c.state.items.map((i) => i.comment_id), ['thread:11', 'issue_comment:31'])
  assert.deepEqual(c.excluded, [{ comment_id: 'thread:21', reason: 'outdated' }])
  assert.equal(c.state.policyRef, fx.base)
  assert.equal(c.state.head, fx.head)
  assert.equal(fnvSum(JSON.parse(readFileSync(c.state_path, 'utf8'))), c.state_sum)
  const graphql = fx.gh.calls.filter((x) => x.args[1] === 'graphql')
  assert.equal(graphql.length, 1)
  assert.ok(graphql[0].args.includes(`query=${THREADS_QUERY}`))
  assert.ok(fx.gh.calls.filter((x) => x.args[1] === '--paginate').every((x) => x.args.includes('--slurp')))
})

test('collect は扱えない PR・作業ツリー・stateDir を拒否し、何も書かない', async (t) => {
  const cases = [
    { name: '別のリポジトリ', code: CODES.pin, setup: (fx) => { fx.gh.repository = 'other/repo' } },
    { name: 'merged', code: CODES.pin, setup: (fx) => { fx.gh.view.state = 'MERGED' } },
    { name: 'closed', code: CODES.pin, setup: (fx) => { fx.gh.view.state = 'CLOSED' } },
    { name: 'fork の head', code: CODES.pin, setup: (fx) => { fx.gh.view.isCrossRepository = true } },
    { name: 'HEAD が PR の head と違う', code: CODES.pin, setup: (fx) => { fx.gh.view.headRefOid = fx.base } },
    { name: 'branch が違う', code: CODES.pin, setup: (fx) => { git(fx.repo, 'switch', '-q', '-c', 'other') } },
    { name: 'detached HEAD', code: CODES.pin, setup: (fx) => { git(fx.repo, 'switch', '-q', '--detach') } },
    { name: 'base の commit が手元に無い', code: CODES.pin, setup: (fx) => { fx.gh.view.baseRefOid = 'd'.repeat(40) } },
    { name: 'stateDir が repo の中', code: CODES.input, body: (fx) => ({ stateDir: fx.repo }) },
    { name: 'stateDir が無い', code: CODES.input, body: (fx) => ({ stateDir: path.join(fx.stateDir, 'none') }) },
    { name: 'pr が整数でない', code: CODES.input, body: () => ({ pr: '7' }) },
    { name: 'repo が相対パス', code: CODES.input, body: () => ({ repo: 'x' }) },
    { name: 'PR に無い include', code: CODES.input, body: () => ({ include: ['thread:999'] }) },
    { name: '投稿者の無いコメント', code: CODES.io, setup: (fx) => { fx.gh.issues[0].user = null } },
  ]
  for (const c of cases) {
    await t.test(c.name, (t) => {
      const fx = fixture(t)
      c.setup?.(fx)
      const out = collect(fx, c.body?.(fx) ?? {})
      assert.equal(out.ok, false)
      assert.equal(out.code, c.code, out.reason)
      assert.equal(out.exitCode, 1)
      assert.equal(existsSync(path.join(fx.stateDir, 'address-review-state.json')), false)
    })
  }
})

test('同じ stateDir での 2 回目の collect は拒否する（1 周に 1 回）', (t) => {
  const fx = fixture(t)
  assert.equal(collect(fx).ok, true)
  const again = collect(fx)
  assert.equal(again.code, CODES.state)
})

test('fix-request は fix の指摘だけの依頼の文を返し、fix が無ければ null', (t) => {
  const fx = fixture(t)
  const c = collect(fx)
  const out = cli(fx, 'fix-request', { ...ref(c), triage: triageOf(c, (i) => (i.kind === 'thread' ? 'fix' : 'decline')) })
  assert.equal(out.ok, true, out.reason)
  assert.deepEqual(out.fix_ids, ['thread:11'])
  assert.match(out.request, /> \[HIGH\] a が 1 のまま/)
  const none = cli(fx, 'fix-request', { ...ref(c), triage: triageOf(c, () => 'decline') })
  assert.equal(none.request, null)
  const tampered = cli(fx, 'fix-request', { ...ref(c), stateSum: '00000000', triage: triageOf(c, () => 'decline') })
  assert.equal(tampered.code, CODES.input)
})

test('fix-request は triagePath の native の包みを受け付け、両方の指定を拒否する', (t) => {
  const fx = fixture(t)
  const c = collect(fx)
  const file = path.join(fx.stateDir, 'triage.output')
  const triage = triageOf(c, () => 'decline')
  writeFileSync(file, JSON.stringify({ summary: 's', agentCount: 2, result: triage }))
  assert.equal(cli(fx, 'fix-request', { ...ref(c), triagePath: file }).ok, true)
  assert.equal(cli(fx, 'fix-request', { ...ref(c), triagePath: file, triage }).code, CODES.input)
})

function postAll(fx, out) {
  out.replies.forEach((r, n) => {
    const payload = JSON.parse(readFileSync(r.input_path, 'utf8'))
    fx.gh.post(payload.in_reply_to ? { kind: 'thread', reply_to: payload.in_reply_to } : { kind: 'conversation' }, payload.body, 1000 + n)
  })
}

test('修正の無い run: recheck が返信の本文を組み、confirm-replies が 1 回だけ付いたことを確かめる', (t) => {
  const fx = fixture(t)
  const c = collect(fx)
  const triage = triageOf(c, () => 'decline')
  const out = cli(fx, 'recheck', { ...ref(c), triage, fixCommit: null })
  assert.equal(out.ok, true, out.reason)
  assert.deepEqual(out.replies.map((r) => r.endpoint), [`repos/${REPOSITORY}/pulls/7/comments`, `repos/${REPOSITORY}/issues/7/comments`])
  const thread = JSON.parse(readFileSync(out.replies[0].input_path, 'utf8'))
  assert.deepEqual(Object.keys(thread).sort(), ['body', 'in_reply_to'])
  assert.equal(thread.in_reply_to, 11)
  assert.ok(thread.body.startsWith('@github-actions[bot] 確かめました。'))
  assert.match(thread.body, /根拠: src\/a\.mjs:1/)
  assert.deepEqual(out.blocked, [])
  postAll(fx, out)
  const confirm = cli(fx, 'confirm-replies', ref(c))
  assert.equal(confirm.passed, true, JSON.stringify(confirm))
  assert.equal(confirm.confirmed.length, 2)
  fx.gh.post({ kind: 'thread', reply_to: 11 }, thread.body, 2000)
  const dup = cli(fx, 'confirm-replies', ref(c))
  assert.equal(dup.passed, false)
  assert.deepEqual(dup.duplicated.map((d) => d.posted), [[1000, 2000]])
})

test('confirm-replies は recheck の前と、無い statePath を拒否する', (t) => {
  const fx = fixture(t)
  const c = collect(fx)
  assert.equal(cli(fx, 'confirm-replies', ref(c)).code, CODES.state)
  assert.equal(cli(fx, 'confirm-replies', { ...ref(c), statePath: path.join(fx.stateDir, 'none.json') }).code, CODES.input)
})

test('recheck は 1 回だけ（2 回目は返信を組み直さない）', (t) => {
  const fx = fixture(t)
  const c = collect(fx)
  const triage = triageOf(c, () => 'decline')
  assert.equal(cli(fx, 'recheck', { ...ref(c), triage, fixCommit: null }).ok, true)
  assert.equal(cli(fx, 'recheck', { ...ref(c), triage, fixCommit: null }).code, CODES.state)
})

function commitFix(fx) {
  write(fx.repo, 'src/a.mjs', 'export const a = 2\n')
  git(fx.repo, 'commit', '-q', '-am', 'fix')
  return git(fx.repo, 'rev-parse', 'HEAD')
}

test('修正の run: push した commit が PR の head で 1 つだけなら、fix の返信に SHA と path を載せる', (t) => {
  const fx = fixture(t)
  const c = collect(fx)
  const triage = triageOf(c, (i) => (i.kind === 'thread' ? 'fix' : 'decline'))
  const sha = commitFix(fx)
  fx.gh.view.headRefOid = sha
  fx.gh.threads[0].isOutdated = true
  const out = cli(fx, 'recheck', { ...ref(c), triage, fixCommit: sha })
  assert.equal(out.ok, true, out.reason)
  const thread = JSON.parse(readFileSync(out.replies[0].input_path, 'utf8'))
  assert.match(thread.body, new RegExp(`修正: ${sha}（src/a\\.mjs）`))
  assert.deepEqual(out.skipped, [])
})

test('recheck は head と議論の変化で返信を止める', async (t) => {
  const cases = [
    { name: '修正が無いのに head が動いた', fix: false, setup: (fx) => { fx.gh.view.headRefOid = commitFix(fx) }, code: CODES.state },
    { name: 'push した commit が PR の head でない', fix: true, setup: (fx, sha) => { fx.gh.view.headRefOid = fx.head; return sha }, code: CODES.state },
    {
      name: 'collect の head からの commit が 2 つ',
      fix: true,
      setup: (fx) => {
        write(fx.repo, 'x.md', 'x\n')
        git(fx.repo, 'add', '-A')
        git(fx.repo, 'commit', '-q', '-m', 'other')
        const sha = git(fx.repo, 'rev-parse', 'HEAD')
        fx.gh.view.headRefOid = sha
        return sha
      },
      code: CODES.state,
    },
    { name: 'PR が merged になった', fix: false, setup: (fx) => { fx.gh.view.state = 'MERGED' }, code: CODES.pin },
    { name: 'fixCommit が無い', fix: false, body: { fixCommit: undefined }, code: CODES.input },
    { name: 'fix が無いのに fixCommit がある', fix: false, classify: () => 'decline', body: { fixCommit: 'e'.repeat(40) }, code: CODES.input },
  ]
  for (const c of cases) {
    await t.test(c.name, (t) => {
      const fx = fixture(t)
      const col = collect(fx)
      const triage = triageOf(col, c.classify ?? ((i) => (i.kind === 'thread' ? 'fix' : 'decline')))
      let fixCommit = null
      if (c.fix) {
        fixCommit = commitFix(fx)
        fx.gh.view.headRefOid = fixCommit
      }
      const override = c.setup?.(fx, fixCommit)
      if (override) fixCommit = override
      const body = { ...ref(col), triage, fixCommit, ...(c.body ?? {}) }
      const out = cli(fx, 'recheck', body)
      assert.equal(out.code, c.code, out.reason)
      assert.equal(existsSync(path.join(fx.stateDir, 'address-review-replies.json')), false)
    })
  }
  await t.test('返信先の thread に新しい返信が付いたら、その返信だけを blocked にする', (t) => {
    const fx = fixture(t)
    const col = collect(fx)
    fx.gh.inline.push({ id: 12, user: user('alice'), path: 'src/a.mjs', line: 1, in_reply_to_id: 11, body: '追記', created_at: 'z', updated_at: 'z', html_url: 'https://x/12' })
    fx.gh.issues.push({ id: 32, user: user('bob'), body: '新しい指摘', created_at: '2026-10-03T00:00:00Z', updated_at: 'z', html_url: 'https://x/32' })
    const out = cli(fx, 'recheck', { ...ref(col), triage: triageOf(col, () => 'decline'), fixCommit: null })
    assert.equal(out.ok, true, out.reason)
    assert.deepEqual(out.blocked, [{ comment_ids: ['thread:11'], changed: [{ comment_id: 'thread:11', reason: 'discussion_changed' }] }])
    assert.deepEqual(out.replies.map((r) => r.comment_ids), [['issue_comment:31']])
    assert.deepEqual(out.new_items, ['issue_comment:32'])
  })
  await t.test('修正を push できなかった run は fix の指摘に返信しない', (t) => {
    const fx = fixture(t)
    const col = collect(fx)
    const out = cli(fx, 'recheck', { ...ref(col), triage: triageOf(col, (i) => (i.kind === 'thread' ? 'fix' : 'decline')), fixCommit: null })
    assert.deepEqual(out.skipped, [{ comment_id: 'thread:11', reason: 'not_fixed' }])
    assert.deepEqual(out.replies.map((r) => r.comment_ids), [['issue_comment:31']])
  })
})

test('gh に渡す argv にコメントの本文が入らず、shell を通らない', (t) => {
  const fx = fixture(t)
  fx.gh.inline[0].body = '`rm -rf /`; $(touch pwned) "\' 本文'
  const c = collect(fx)
  assert.equal(c.ok, true)
  cli(fx, 'recheck', { ...ref(c), triage: triageOf(c, () => 'decline'), fixCommit: null })
  for (const call of fx.gh.calls) assert.ok(call.args.every((a) => !a.includes('rm -rf')), call.args.join(' '))
  assert.equal(existsSync(path.join(fx.repo, 'pwned')), false)
})

test('CLI は使い方と JSON の誤りを exit 2 で返す', () => {
  for (const [argv, input] of [[['nope'], '{}'], [['collect', 'x'], '{}'], [['collect'], 'not json'], [['collect'], '[]']]) {
    const r = spawnSync(process.execPath, [CLI, ...argv], { input, encoding: 'utf8' })
    assert.equal(r.status, 2, r.stdout)
    assert.equal(JSON.parse(r.stdout).code, CODES.input)
  }
})
