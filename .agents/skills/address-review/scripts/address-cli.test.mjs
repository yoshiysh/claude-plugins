import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { THREADS_QUERY, defaultIo, main, run } from './address-cli.mjs'
import { AddressError, CODES, NEXT, REPOSITORY, fnvSum, nextOfError } from './address-core.mjs'
import { siteOf, throwSites } from './throw-sites.mjs'

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
    const raw = gh.raw?.[`${a} ${b}`] ?? gh.raw?.[b]
    if (raw !== undefined) return raw
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
  git(repo, 'update-ref', 'refs/remotes/origin/main', base)
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

const CLI_URL = import.meta.resolve('./address-cli.mjs')
const hitSites = new Set()

// 拒否を run で直に受け、throw の箇所を記録して { code, next, reason } を返す（main は stack を落とすので使わない）。
function reject(fx, op, body) {
  return rejected(() => run(op, body, fx.io), op)
}

function rejected(fn, what = 'call') {
  try {
    fn()
  } catch (error) {
    assert.ok(error instanceof AddressError, String(error?.stack ?? error))
    const site = siteOf(error, CLI_URL)
    if (site) hitSites.add(site)
    return { code: error.code, next: nextOfError(error), reason: error.message }
  }
  assert.fail(`${what} が拒否しなかった`)
}

function triageOf(c, classify, extra = {}) {
  const results = c.state.items.map((i) => {
    const classification = classify(i)
    return {
      comment_id: i.comment_id, classification, reason: '確かめた', evidence: [{ path: 'src/a.mjs', line: 1, claim: 'a は 1' }],
      repair_paths: classification === 'fix' ? ['src/a.mjs'] : [], decision_questions: [], reply_draft: '確かめました。', limitation: '',
    }
  })
  const body = { status: 'completed', results, stateSum: c.state_sum, ...extra }
  if (body.status !== 'completed') delete body.results
  return { ...body, sum: fnvSum(body) }
}

const ref = (c) => ({ statePath: c.state_path, stateSum: c.state_sum })
const fixThread = (i) => (i.kind === 'thread' ? 'fix' : 'decline')
const accept = (fx, c, classify = () => 'decline') => cli(fx, 'triage-result', { ...ref(c), triage: triageOf(c, classify) })

test('collect は全ページを取り、既定の除外を名前だけ残して stateDir に書き、分類へ進む', (t) => {
  const fx = fixture(t)
  const c = collect(fx)
  assert.equal(c.ok, true, c.reason)
  assert.equal(c.next, 'classify')
  assert.deepEqual(c.state.items.map((i) => i.comment_id), ['thread:11', 'issue_comment:31'])
  assert.deepEqual(c.excluded, [{ comment_id: 'thread:21', reason: 'outdated' }])
  assert.equal(c.state.policyRef, fx.base)
  assert.equal(c.state.stopAfter, 'reply')
  assert.equal(fnvSum(JSON.parse(readFileSync(c.state_path, 'utf8'))), c.state_sum)
  const graphql = fx.gh.calls.filter((x) => x.args[1] === 'graphql')
  assert.equal(graphql.length, 1)
  assert.ok(graphql[0].args.includes(`query=${THREADS_QUERY}`))
  assert.ok(fx.gh.calls.filter((x) => x.args[1] === '--paginate').every((x) => x.args.includes('--slurp')))
})

test('collect は指摘が 0 件なら report、使えない decisions を外して返す', (t) => {
  const fx = fixture(t)
  fx.gh.inline = []
  fx.gh.threads = []
  fx.gh.issues = []
  const c = collect(fx, { decisions: { 'thread:11': '直す' } })
  assert.equal(c.next, 'report')
  assert.equal(c.items, 0)
  assert.deepEqual(c.dropped_decisions, [{ comment_id: 'thread:11', value: '直す', reason: 'not_in_state' }])
  const fy = fixture(t)
  const d = collect(fy, { decisions: { 'thread:11': '互換を捨てる', 'issue_comment:31': '' } })
  assert.deepEqual(d.state.decisions, { 'thread:11': '互換を捨てる' })
  assert.deepEqual(d.dropped_decisions.map((x) => x.reason), ['empty_or_not_text'])
})

test('collect は扱えない PR・作業ツリー・入力を拒否し、next を返して何も書かない', async (t) => {
  const cases = [
    { name: '別のリポジトリ', code: CODES.pin, next: 'report', setup: (fx) => { fx.gh.repository = 'other/repo' } },
    { name: 'merged', code: CODES.pin, next: 'report', setup: (fx) => { fx.gh.view.state = 'MERGED' } },
    { name: 'fork の head', code: CODES.pin, next: 'report', setup: (fx) => { fx.gh.view.isCrossRepository = true } },
    { name: 'HEAD が PR の head と違う', code: CODES.pin, next: 'report', setup: (fx) => { fx.gh.view.headRefOid = fx.base } },
    { name: 'detached HEAD', code: CODES.pin, next: 'report', setup: (fx) => { git(fx.repo, 'switch', '-q', '--detach') } },
    { name: '方針の版 origin/main が手元に無い', code: CODES.pin, next: 'fetch_and_retry', setup: (fx) => { git(fx.repo, 'update-ref', '-d', 'refs/remotes/origin/main') } },
    { name: '作業ツリーに commit していない変更がある', code: CODES.pin, next: 'report', setup: (fx) => { write(fx.repo, 'src/a.mjs', 'export const a = 3\n') } },
    { name: '作業ツリーに未追跡のファイルがある', code: CODES.pin, next: 'report', setup: (fx) => { write(fx.repo, 'notes/todo.md', 'x\n') } },
    { name: 'stateDir が repo の中の ..x', code: CODES.input, next: 'fix_input', body: (fx) => { mkdirSync(path.join(fx.repo, '..x')); return { stateDir: path.join(fx.repo, '..x') } } },
    { name: 'stateDir が無い', code: CODES.input, next: 'fix_input', body: (fx) => ({ stateDir: path.join(fx.stateDir, 'none') }) },
    { name: 'stateDir を前の run が使った', code: CODES.state, next: 'fix_input', setup: (fx) => { writeFileSync(path.join(fx.stateDir, 'address-review-state.json'), '{}') }, keep: true },
    { name: 'pr が整数でない', code: CODES.input, next: 'fix_input', body: () => ({ pr: '7' }) },
    { name: 'repo が相対パス', code: CODES.input, next: 'fix_input', body: () => ({ repo: 'x' }) },
    { name: 'stopAfter が列挙に無い', code: CODES.input, next: 'fix_input', body: () => ({ stopAfter: 'merge' }) },
    { name: 'gh の認証ユーザーが取れない', code: CODES.io, next: 'retry', setup: (fx) => { fx.gh.viewer = '' } },
    { name: 'gh の応答が JSON でない', code: CODES.io, next: 'retry', setup: (fx) => { fx.gh.raw = { 'repo view': 'not json' } } },
    { name: 'reviewThreads の応答の形が違う', code: CODES.io, next: 'retry', setup: (fx) => { fx.gh.raw = { graphql: '[{}]' } } },
  ]
  for (const c of cases) {
    await t.test(c.name, (t) => {
      const fx = fixture(t)
      c.setup?.(fx)
      const out = reject(fx, 'collect', { repo: fx.repo, pr: 7, stateDir: fx.stateDir, ...(c.body?.(fx) ?? {}) })
      assert.deepEqual([out.code, out.next], [c.code, c.next], out.reason)
      if (!c.keep) assert.equal(existsSync(path.join(fx.stateDir, 'address-review-state.json')), false)
    })
  }
})

test('triage-result は分類の結果と stopAfter から next を返し、fix があれば依頼の文を組む', async (t) => {
  const cases = [
    ['fix があり返信まで', 'reply', fixThread, 'implement'],
    ['fix があり push まで', 'push', fixThread, 'implement'],
    ['fix があり分類だけ', 'classify', fixThread, 'report'],
    ['fix が無く返信まで', 'reply', () => 'decline', 'recheck'],
    ['fix が無く verify まで', 'verify', () => 'decline', 'report'],
  ]
  for (const [name, stopAfter, classify, next] of cases) {
    await t.test(name, (t) => {
      const fx = fixture(t)
      const c = collect(fx, { stopAfter })
      const out = accept(fx, c, classify)
      assert.equal(out.ok, true, out.reason)
      assert.equal(out.next, next)
      if (next === 'implement') {
        assert.deepEqual(out.fix_ids, ['thread:11'])
        assert.match(out.request, /> \[HIGH\] a が 1 のまま/)
      }
      if (next === 'recheck') assert.equal(out.fixCommit, null)
    })
  }
})

test('triage-result は止まった分類を利用者の判断・呼び直し・報告に振り分け、呼び直しを CLI が数える', (t) => {
  const fx = fixture(t)
  const c = collect(fx)
  const decide = cli(fx, 'triage-result', { ...ref(c), triage: triageOf(c, () => 'decline', { status: 'needs_decision', questions: [{ comment_id: 'thread:11', questions: ['どちら'] }] }) })
  assert.equal(decide.next, 'decide')
  assert.deepEqual(decide.questions, [{ comment_id: 'thread:11', questions: ['どちら'] }])
  const lost = triageOf(c, () => 'decline', { status: 'triage_incomplete', reason: 'triager-unavailable' })
  assert.equal(cli(fx, 'triage-result', { ...ref(c), triage: lost }).next, 'classify_again')
  assert.equal(cli(fx, 'triage-result', { ...ref(c), triage: lost }).next, 'report')
  const head = triageOf(c, () => 'decline', { status: 'triage_incomplete', reason: 'triager-head-mismatch', observedHead: 'x' })
  const out = cli(fx, 'triage-result', { ...ref(c), triage: head })
  assert.deepEqual([out.next, out.observedHead], ['report', 'x'])
})

test('triage-result は分類を 1 回だけ受け入れ、triagePath の native の包みを受け付ける', (t) => {
  const fx = fixture(t)
  const c = collect(fx)
  const file = path.join(fx.stateDir, 'triage.output')
  const triage = triageOf(c, () => 'decline')
  writeFileSync(file, JSON.stringify({ summary: 's', agentCount: 2, result: triage }))
  assert.equal(cli(fx, 'triage-result', { ...ref(c), triagePath: file }).next, 'recheck')
  assert.deepEqual(Object.values(reject(fx, 'triage-result', { ...ref(c), triage })).slice(0, 2), [CODES.state, 'report'])
})

test('triage-result の入力の誤りは fix_input', async (t) => {
  const fx = fixture(t)
  const c = collect(fx)
  const file = path.join(fx.stateDir, 'x.output')
  writeFileSync(file, '{}')
  const cases = [
    ['triage と triagePath の両方', { triage: triageOf(c, () => 'decline'), triagePath: file }],
    ['無い triagePath', { triagePath: path.join(fx.stateDir, 'none') }],
    ['triage が無い', {}],
    ['stateSum が違う', { stateSum: '00000000', triage: triageOf(c, () => 'decline') }],
    ['statePath が無い', { statePath: path.join(fx.stateDir, 'none.json'), triage: triageOf(c, () => 'decline') }],
  ]
  for (const [name, body] of cases) {
    await t.test(name, () => {
      const out = reject(fx, 'triage-result', { ...ref(c), ...body })
      assert.deepEqual([out.code, out.next], [CODES.input, 'fix_input'], out.reason)
    })
  }
  await t.test('記録が壊れている', () => {
    writeFileSync(path.join(fx.stateDir, 'address-review-triage.json'), JSON.stringify({ stateSum: c.state_sum, retries: 0, accepted: null, sum: 'x' }))
    assert.deepEqual(Object.values(reject(fx, 'triage-result', { ...ref(c), triage: triageOf(c, () => 'decline') })).slice(0, 2), [CODES.state, 'report'])
  })
})

test('record-fix は verify の結果と stopAfter から next を返す', async (t) => {
  const passed = { ok: true, op: 'verify', passed: true, problems: [], actual: ['src/a.mjs'] }
  const cases = [
    ['直して返信まで', 'reply', { verify: passed }, 'commit_push'],
    ['直して push まで', 'push', { verify: passed }, 'commit_push'],
    ['直して verify まで', 'verify', { verify: passed }, 'report'],
    ['no_change で返信まで', 'reply', { verify: { ...passed, actual: [] } }, 'recheck'],
    ['不通過で返信まで', 'reply', { verify: { ...passed, passed: false } }, 'recheck'],
    ['止まって push まで', 'push', { stopped: 'needs_replan' }, 'report'],
  ]
  for (const [name, stopAfter, input, next] of cases) {
    await t.test(name, (t) => {
      const fx = fixture(t)
      const c = collect(fx, { stopAfter })
      accept(fx, c, fixThread)
      const out = cli(fx, 'record-fix', { ...ref(c), ...input })
      assert.equal(out.next, next, out.reason)
      if (next === 'commit_push') assert.deepEqual([out.branch, /PR #7/.test(out.commit_message)], ['feat/x', true])
    })
  }
})

test('record-fix の拒否', async (t) => {
  const cases = [
    ['分類を受け入れる前', null, {}, CODES.state, 'report'],
    ['fix の無い run', () => 'decline', { stopped: 'x' }, CODES.state, 'report'],
    ['verify と stopped の両方', fixThread, { verify: { passed: true, actual: [] }, stopped: 'x' }, CODES.input, 'fix_input'],
    ['verify の形が違う', fixThread, { verify: { passed: 'yes' } }, CODES.input, 'fix_input'],
    ['stopped が空', fixThread, { stopped: ' ' }, CODES.input, 'fix_input'],
  ]
  for (const [name, classify, input, code, next] of cases) {
    await t.test(name, (t) => {
      const fx = fixture(t)
      const c = collect(fx)
      if (classify) accept(fx, c, classify)
      assert.deepEqual(Object.values(reject(fx, 'record-fix', { ...ref(c), ...input })).slice(0, 2), [code, next])
    })
  }
})

function postAll(fx, out) {
  out.replies.forEach((r, n) => {
    const payload = JSON.parse(readFileSync(r.input_path, 'utf8'))
    fx.gh.post(payload.in_reply_to ? { kind: 'thread', reply_to: payload.in_reply_to } : { kind: 'conversation' }, payload.body, 1000 + n)
  })
}

test('修正の無い run: recheck が返信の本文を組んで post、confirm-replies が 1 回だけ付いたことを確かめる', (t) => {
  const fx = fixture(t)
  const c = collect(fx)
  accept(fx, c)
  const out = cli(fx, 'recheck', { ...ref(c), fixCommit: null })
  assert.equal(out.next, 'post', out.reason)
  assert.deepEqual(out.replies.map((r) => r.endpoint), [`repos/${REPOSITORY}/pulls/7/comments`, `repos/${REPOSITORY}/issues/7/comments`])
  const thread = JSON.parse(readFileSync(out.replies[0].input_path, 'utf8'))
  assert.deepEqual(Object.keys(thread).sort(), ['body', 'in_reply_to'])
  assert.ok(thread.body.startsWith('@github-actions[bot] 確かめました。'))
  assert.match(thread.body, /根拠: src\/a\.mjs:1/)
  postAll(fx, out)
  const confirm = cli(fx, 'confirm-replies', ref(c))
  assert.deepEqual([confirm.passed, confirm.next, confirm.confirmed.length], [true, 'report', 2])
  fx.gh.post({ kind: 'thread', reply_to: 11 }, thread.body, 2000)
  const dup = cli(fx, 'confirm-replies', ref(c))
  assert.deepEqual([dup.passed, dup.next], [false, 'report'])
  assert.deepEqual(dup.duplicated.map((d) => d.posted), [[1000, 2000]])
})

test('confirm-replies は missing を 1 回目は待たせ、2 回目は投稿し直させ、3 回目は報告させる', (t) => {
  const fx = fixture(t)
  const c = collect(fx)
  accept(fx, c)
  const out = cli(fx, 'recheck', { ...ref(c), fixCommit: null })
  postAll(fx, { replies: out.replies.slice(0, 1) })
  const first = cli(fx, 'confirm-replies', ref(c))
  assert.equal(first.next, 'wait_and_retry')
  assert.deepEqual(first.missing.map((m) => m.input_path), [out.replies[1].input_path])
  const second = cli(fx, 'confirm-replies', ref(c))
  assert.equal(second.next, 'repost')
  assert.equal(cli(fx, 'confirm-replies', ref(c)).next, 'report')
  const payload = JSON.parse(readFileSync(second.missing[0].input_path, 'utf8'))
  fx.gh.post({ kind: 'conversation' }, payload.body, 3000)
  const done = cli(fx, 'confirm-replies', ref(c))
  assert.deepEqual([done.passed, done.next], [true, 'report'])
})

test('confirm-replies は recheck の前と壊れた記録を拒否する', (t) => {
  const fx = fixture(t)
  const c = collect(fx)
  assert.deepEqual(Object.values(reject(fx, 'confirm-replies', ref(c))).slice(0, 2), [CODES.state, 'report'])
  writeFileSync(path.join(fx.stateDir, 'address-review-replies.json'), JSON.stringify({ stateSum: c.state_sum, replies: [], confirmations: 0, sum: 'x' }))
  assert.deepEqual(Object.values(reject(fx, 'confirm-replies', ref(c))).slice(0, 2), [CODES.state, 'report'])
})

function commitFix(fx) {
  write(fx.repo, 'src/a.mjs', 'export const a = 2\n')
  git(fx.repo, 'commit', '-q', '-am', 'fix')
  return git(fx.repo, 'rev-parse', 'HEAD')
}

test('修正の run: push した commit が PR の head で親が collect の head なら、fix の返信に SHA と path を載せる', (t) => {
  const fx = fixture(t)
  const c = collect(fx)
  accept(fx, c, fixThread)
  const sha = commitFix(fx)
  fx.gh.view.headRefOid = sha
  fx.gh.threads[0].isOutdated = true
  const out = cli(fx, 'recheck', { ...ref(c), fixCommit: sha })
  assert.equal(out.next, 'post', out.reason)
  const thread = JSON.parse(readFileSync(out.replies[0].input_path, 'utf8'))
  assert.match(thread.body, new RegExp(`修正: ${sha}（src/a\\.mjs）`))
})

test('recheck は stopAfter が push なら push を確かめた後に report', (t) => {
  const fx = fixture(t)
  const c = collect(fx, { stopAfter: 'push' })
  accept(fx, c, fixThread)
  const sha = commitFix(fx)
  fx.gh.view.headRefOid = sha
  const out = cli(fx, 'recheck', { ...ref(c), fixCommit: sha })
  assert.deepEqual([out.next, out.pushed], ['report', sha])
  assert.equal(existsSync(path.join(fx.stateDir, 'address-review-replies.json')), false)
})

test('recheck は head と議論の変化で返信を止める', async (t) => {
  const cases = [
    { name: '修正が無いのに head が動いた', fix: false, setup: (fx) => { fx.gh.view.headRefOid = commitFix(fx) }, code: CODES.state, next: 'report' },
    { name: 'push した commit が PR の head でない', fix: true, setup: (fx, sha) => { fx.gh.view.headRefOid = 'f'.repeat(40); return sha }, code: CODES.state, next: 'report' },
    { name: 'push が GitHub に反映されていない', fix: true, setup: (fx, sha) => { fx.gh.view.headRefOid = fx.head; return sha }, code: CODES.state, next: 'wait_and_retry' },
    {
      name: '修正の commit の親が collect の head でない',
      fix: true,
      setup: (fx) => {
        const sha = git(fx.repo, 'commit-tree', `${fx.head}^{tree}`, '-p', fx.base, '-m', 'side')
        fx.gh.view.headRefOid = sha
        return sha
      },
      code: CODES.state,
      next: 'report',
    },
    { name: 'PR が merged になった', fix: false, setup: (fx) => { fx.gh.view.state = 'MERGED' }, code: CODES.pin, next: 'report' },
    { name: 'fixCommit が無い', fix: false, body: { fixCommit: undefined }, code: CODES.input, next: 'fix_input' },
    { name: 'fix が無いのに fixCommit がある', fix: false, classify: () => 'decline', body: { fixCommit: 'e'.repeat(40) }, code: CODES.input, next: 'fix_input' },
  ]
  for (const c of cases) {
    await t.test(c.name, (t) => {
      const fx = fixture(t)
      const col = collect(fx)
      accept(fx, col, c.classify ?? fixThread)
      let fixCommit = null
      if (c.fix) {
        fixCommit = commitFix(fx)
        fx.gh.view.headRefOid = fixCommit
      }
      const override = c.setup?.(fx, fixCommit)
      if (override) fixCommit = override
      const out = reject(fx, 'recheck', { ...ref(col), fixCommit, ...(c.body ?? {}) })
      assert.deepEqual([out.code, out.next], [c.code, c.next], out.reason)
      assert.equal(existsSync(path.join(fx.stateDir, 'address-review-replies.json')), false)
    })
  }
  await t.test('分類を受け入れる前と 2 回目は拒否する', (t) => {
    const fx = fixture(t)
    const col = collect(fx)
    assert.deepEqual(Object.values(reject(fx, 'recheck', { ...ref(col), fixCommit: null })).slice(0, 2), [CODES.state, 'report'])
    accept(fx, col)
    assert.equal(cli(fx, 'recheck', { ...ref(col), fixCommit: null }).next, 'post')
    assert.deepEqual(Object.values(reject(fx, 'recheck', { ...ref(col), fixCommit: null })).slice(0, 2), [CODES.state, 'report'])
  })
  await t.test('返信先の thread に新しい返信が付いたら、その返信だけを blocked にする', (t) => {
    const fx = fixture(t)
    const col = collect(fx)
    accept(fx, col)
    fx.gh.inline.push({ id: 12, user: user('alice'), path: 'src/a.mjs', line: 1, in_reply_to_id: 11, body: '追記', created_at: 'z', updated_at: 'z', html_url: 'https://x/12' })
    fx.gh.issues.push({ id: 32, user: user('bob'), body: '新しい指摘', created_at: '2026-10-03T00:00:00Z', updated_at: 'z', html_url: 'https://x/32' })
    const out = cli(fx, 'recheck', { ...ref(col), fixCommit: null })
    assert.deepEqual(out.blocked, [{ comment_ids: ['thread:11'], changed: [{ comment_id: 'thread:11', reason: 'discussion_changed' }] }])
    assert.deepEqual(out.replies.map((r) => r.comment_ids), [['issue_comment:31']])
    assert.deepEqual(out.new_items, ['issue_comment:32'])
  })
  await t.test('返す返信が残らなければ report', (t) => {
    const fx = fixture(t)
    const col = collect(fx)
    accept(fx, col, fixThread)
    fx.gh.issues[0].body = '編集した'
    const out = cli(fx, 'recheck', { ...ref(col), fixCommit: null })
    assert.deepEqual([out.next, out.replies, out.skipped.map((x) => x.comment_id)], ['report', [], ['thread:11']])
  })
})

test('collect・recheck は gh の argv にコメントの本文を入れない', (t) => {
  const fx = fixture(t)
  fx.gh.inline[0].body = '`rm -rf /`; $(touch pwned) "\' 本文'
  const c = collect(fx)
  accept(fx, c)
  cli(fx, 'recheck', { ...ref(c), fixCommit: null })
  for (const call of fx.gh.calls) assert.ok(call.args.every((a) => !a.includes('rm -rf')), call.args.join(' '))
})

test('defaultIo の gh と git は argv をそのまま実行ファイルに渡し、shell を通らない', (t) => {
  const bin = tmp(t, 'address-cli-bin-')
  const cwd = tmp(t, 'address-cli-cwd-')
  const log = path.join(bin, 'argv.json')
  // 受けた argv を記録するだけの偽の gh と git。PATH の先頭に置き、本物を呼ばない。
  for (const name of ['gh', 'git']) {
    writeFileSync(path.join(bin, name), `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)))\nprocess.stdout.write('{}')\n`, { mode: 0o755 })
  }
  const saved = process.env.PATH
  process.env.PATH = `${bin}${path.delimiter}${saved}`
  t.after(() => { process.env.PATH = saved })
  const hostile = '`touch pwned1`; $(touch pwned2) "\' | touch pwned3 && echo x'
  const io = defaultIo()
  io.gh(cwd, ['api', hostile, '-f', `query=${hostile}`])
  assert.deepEqual(JSON.parse(readFileSync(log, 'utf8')), ['api', hostile, '-f', `query=${hostile}`])
  io.git(cwd, ['log', hostile])
  assert.deepEqual(JSON.parse(readFileSync(log, 'utf8')), ['-C', cwd, 'log', hostile])
  for (const f of ['pwned1', 'pwned2', 'pwned3']) {
    assert.equal(existsSync(path.join(cwd, f)), false)
    assert.equal(existsSync(path.join(process.cwd(), f)), false)
  }
})

test('E_IO の reason は失敗した gh・git の argv を示し、query の本文だけを省く', (t) => {
  const bin = tmp(t, 'address-cli-bin-')
  for (const name of ['gh', 'git']) writeFileSync(path.join(bin, name), `#!${process.execPath}\nprocess.stderr.write('boom')\nprocess.exit(2)\n`, { mode: 0o755 })
  const saved = process.env.PATH
  process.env.PATH = `${bin}${path.delimiter}${saved}`
  t.after(() => { process.env.PATH = saved })
  const io = defaultIo()
  const g = rejected(() => io.git('/r', ['rev-list', '--parents', 'x']))
  assert.deepEqual([g.code, g.next], [CODES.io, 'retry'])
  assert.ok(g.reason.includes('git -C /r rev-list --parents x が失敗した: boom'), g.reason)
  const h = rejected(() => io.gh('/', ['api', 'graphql', '-f', `query=${THREADS_QUERY}`, '-F', 'number=7']))
  assert.ok(h.reason.includes('gh api graphql -f query=… -F number=7 が失敗した') && !h.reason.includes('reviewThreads'), h.reason)
})

test('CLI は使い方と JSON の誤りを exit 2 で返す', () => {
  for (const [argv, input] of [[['nope'], '{}'], [['collect', 'x'], '{}'], [['collect'], 'not json'], [['collect'], '[]']]) {
    const r = spawnSync(process.execPath, [CLI, ...argv], { input, encoding: 'utf8' })
    assert.equal(r.status, 2, r.stdout)
    assert.equal(JSON.parse(r.stdout).code, CODES.input)
  }
})

test('CLI の拒否の出力は全て next を持つ（使い方の誤り・知らない op・CLI の不具合）', (t) => {
  for (const [argv, input] of [[['nope'], '{}'], [['collect', 'x'], '{}'], [['collect'], 'not json'], [['collect'], '[]']]) {
    const out = JSON.parse(main(argv, input).output)
    assert.deepEqual([out.code, out.next], [CODES.input, 'fix_input'])
  }
  const fx = fixture(t)
  assert.deepEqual(Object.values(reject(fx, 'nope', {})).slice(0, 2), [CODES.input, 'fix_input'])
  const broken = { ...fx.io, gh: () => { throw new Error('bug') } }
  const out = JSON.parse(main(['collect'], JSON.stringify({ repo: fx.repo, pr: 7, stateDir: fx.stateDir }), broken).output)
  assert.deepEqual([out.code, out.next], [CODES.internal, 'report'])
})

test('全ての出力の next は NEXT の値', (t) => {
  for (const next of ['classify', 'classify_again', 'decide', 'implement', 'commit_push', 'recheck', 'post', 'repost', 'retry', 'wait_and_retry', 'fetch_and_retry', 'fix_input', 'report']) {
    assert.ok(Object.hasOwn(NEXT, next), next)
  }
  assert.equal(Object.keys(NEXT).length, 13, 'NEXT に値を足したら、その値を返すケースをこのファイルに足す')
})

// このファイルの最後に置く（node:test はファイルの中の top-level の test を順に流すので、ここまでの拒否の箇所が集まっている）。
test('address-cli.mjs の全ての throw new AddressError の箇所を、拒否のケースが 1 回以上通る', () => {
  const sites = throwSites(CLI_URL)
  assert.ok(sites.length > 0)
  assert.deepEqual(sites.filter((line) => !hitSites.has(line)), [], 'テストのケースが通っていない throw の行（箇所を足したらケースを足す）')
})
