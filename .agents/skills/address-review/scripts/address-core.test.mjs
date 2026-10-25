import test from 'node:test'
import assert from 'node:assert/strict'
import {
  AddressError, CODES, EXCLUSION_REASONS, answeredMark, buildItems, changedTargets, confirmPlacement, discussionOf, fixRequest, fnvSum, newState,
  planReplies, selectTargets, unwrapWorkflowOutput, readTriage, triageNext, fixNext, confirmNext, splitDecisions, nextOfError,
  NEXT, NEXT_BY_CODE, TRIAGE_RETRIES,
} from './address-core.mjs'
import { siteOf, throwSites } from './throw-sites.mjs'

const CORE_URL = import.meta.resolve('./address-core.mjs')
const hitSites = new Set()

// AddressError の拒否を受け、code と next を照らし、throw の箇所を記録する。
function throwsAddress(fn, code, next) {
  let error = null
  try {
    fn()
  } catch (e) {
    error = e
  }
  assert.ok(error instanceof AddressError, String(error?.stack ?? 'throw しなかった'))
  assert.deepEqual([error.code, nextOfError(error)], [code, next], error.message)
  const site = siteOf(error, CORE_URL)
  if (site) hitSites.add(site)
}

const BASE = 'b'.repeat(40)
const HEAD = 'a'.repeat(40)
const FIX = 'c'.repeat(40)
const user = (login) => ({ login })

function raw() {
  return {
    inline: [
      { id: 11, user: user('github-actions[bot]'), path: 'src/a.mjs', line: 3, in_reply_to_id: null, body: '[HIGH] a が 1 のまま', created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z', html_url: 'https://x/11' },
      { id: 12, user: user('alice'), path: 'src/a.mjs', line: 3, in_reply_to_id: 11, body: '同意', created_at: '2026-10-01T01:00:00Z', updated_at: '2026-10-01T01:00:00Z', html_url: 'https://x/12' },
      { id: 21, user: user('github-actions[bot]'), path: 'src/b.mjs', line: null, original_line: 7, in_reply_to_id: null, body: '[LOW] b', created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z', html_url: 'https://x/21' },
    ],
    issues: [
      { id: 31, user: user('github-actions[bot]'), body: 'summary: 変更していない行の問題', created_at: '2026-10-01T02:00:00Z', updated_at: '2026-10-01T02:00:00Z', html_url: 'https://x/31' },
    ],
    reviews: [
      { id: 41, user: user('github-actions[bot]'), body: '', state: 'COMMENTED', submitted_at: '2026-10-01T00:00:00Z', html_url: 'https://x/41' },
      { id: 42, user: user('bob'), body: '全体として README も直して', state: 'COMMENTED', submitted_at: '2026-10-01T03:00:00Z', html_url: 'https://x/42' },
    ],
    threads: [
      { id: 'T11', isResolved: false, isOutdated: false, comments: { nodes: [{ databaseId: 11 }] } },
      { id: 'T21', isResolved: false, isOutdated: true, comments: { nodes: [{ databaseId: 21 }] } },
    ],
  }
}

test('buildItems は thread・会話・本文のある review を 1 つの一覧にし、本文の無い review を落とす', () => {
  const items = buildItems(raw())
  assert.deepEqual(items.map((i) => i.comment_id), ['thread:11', 'thread:21', 'issue_comment:31', 'review:42'])
  const t = items[0]
  assert.equal(t.thread_id, 'T11')
  assert.equal(t.reply_to, 11)
  assert.deepEqual(t.replies.map((r) => r.id), [12])
  assert.equal(items[1].line, 7, 'line が null なら original_line を使う')
  assert.equal(items[1].outdated, true)
})

test('buildItems は応答の食い違いを E_IO で拒否する', async (t) => {
  const cases = [
    { name: 'root に thread が無い', mutate: (r) => { r.threads.pop() } },
    { name: '返信先の root が無い', mutate: (r) => { r.inline.push({ ...r.inline[1], id: 13, in_reply_to_id: 99 }) } },
    { name: 'thread の最初のコメントの databaseId が無い', mutate: (r) => { r.threads[0].comments.nodes = [] } },
    { name: '投稿者の login が無い', mutate: (r) => { r.issues[0].user = null } },
  ]
  for (const c of cases) {
    await t.test(c.name, () => {
      const r = raw()
      c.mutate(r)
      throwsAddress(() => buildItems(r), CODES.io, 'retry')
    })
  }
})

test('selectTargets の既定の除外と include・only', async (t) => {
  const base = raw()
  const cases = [
    { name: '既定: outdated を外す', mutate: () => {}, opts: {}, items: ['thread:11', 'issue_comment:31', 'review:42'], excluded: { 'thread:21': 'outdated' } },
    { name: '解決済みは outdated より先に resolved', mutate: (r) => { r.threads[1].isResolved = true }, opts: {}, excluded: { 'thread:21': 'resolved' } },
    { name: '認証ユーザーの root は viewer', mutate: (r) => { r.inline[0].user = user('me') }, opts: {}, excluded: { 'thread:11': 'viewer' } },
    { name: '最後の返信が認証ユーザーなら answered', mutate: (r) => { r.inline[1].user = user('me') }, opts: {}, excluded: { 'thread:11': 'answered' } },
    {
      name: '会話は認証ユーザーの返信の印が挙げたものだけが answered で、時刻では外さない',
      mutate: (r) => { r.issues.push({ id: 32, user: user('me'), body: `返答\n\n${answeredMark(['issue_comment:31'])}`, created_at: '2026-10-09T00:00:00Z', updated_at: 'z', html_url: 'https://x/32' }) },
      opts: {}, items: ['thread:11', 'review:42'], excluded: { 'issue_comment:31': 'answered', 'issue_comment:32': 'viewer' },
    },
    {
      name: '印の無い認証ユーザーの会話は、それより前の会話を外さない',
      mutate: (r) => { r.issues.push({ id: 32, user: user('me'), body: '別件のメモ', created_at: '2026-10-09T00:00:00Z', updated_at: 'z', html_url: 'https://x/32' }) },
      opts: {}, items: ['thread:11', 'issue_comment:31', 'review:42'], excluded: { 'issue_comment:32': 'viewer' },
    },
    { name: 'include は既定の除外を外す', mutate: () => {}, opts: { include: ['thread:21'] }, items: ['thread:11', 'thread:21', 'issue_comment:31', 'review:42'], excluded: {} },
    { name: 'only は他を not_selected にする', mutate: () => {}, opts: { only: ['review:42'] }, items: ['review:42'], excluded: { 'thread:11': 'not_selected', 'thread:21': 'not_selected', 'issue_comment:31': 'not_selected' } },
  ]
  for (const c of cases) {
    await t.test(c.name, () => {
      const r = structuredClone(base)
      c.mutate(r)
      const out = selectTargets(buildItems(r), { viewer: 'me', ...c.opts })
      if (c.items) assert.deepEqual(out.items.map((i) => i.comment_id), c.items)
      for (const [id, reason] of Object.entries(c.excluded)) assert.deepEqual(out.excluded.find((e) => e.comment_id === id), { comment_id: id, reason })
      if (c.items) assert.equal(out.items.length + out.excluded.length, buildItems(r).length)
      for (const e of out.excluded) assert.ok(Object.hasOwn(EXCLUSION_REASONS, e.reason))
    })
  }
  await t.test('PR に無い id と配列でない値は E_INPUT', () => {
    for (const opts of [{ include: ['thread:999'] }, { only: ['x'] }, { include: 'thread:11' }]) {
      throwsAddress(() => selectTargets(buildItems(raw()), { viewer: 'me', ...opts }), CODES.input, 'fix_input')
    }
  })
})

test('議論の snapshot は push で変わる outdated と行を含めず、返信・編集・resolve を含める', async (t) => {
  const [item] = buildItems(raw())
  const sum = fnvSum(discussionOf(item))
  const cases = [
    { name: 'outdated', patch: { outdated: true }, same: true },
    { name: '行', patch: { line: 99 }, same: true },
    { name: '本文の編集', patch: { body: '変えた', updated_at: 'z' }, same: false },
    { name: 'resolve', patch: { resolved: true }, same: false },
    { name: '新しい返信', patch: { replies: [...item.replies, { id: 13, author: 'bob', body: 'x', updated_at: 'z' }] }, same: false },
  ]
  for (const c of cases) {
    await t.test(c.name, () => assert.equal(fnvSum(discussionOf({ ...item, ...c.patch })) === sum, c.same))
  }
})

function stateOf(items) {
  const st = newState({ repo: '/r', pr: 7, view: { baseRefOid: BASE }, head: HEAD, branch: 'feat/x', policyRef: BASE, viewer: 'me', items, excluded: [] })
  return { state: st, stateSum: fnvSum(st) }
}

const result = (comment_id, classification, extra = {}) => ({
  comment_id, classification, reason: '確かめた', evidence: [{ path: 'src/a.mjs', line: 3, claim: 'a は 1' }],
  repair_paths: classification === 'fix' ? ['src/a.mjs'] : [], decision_questions: [], reply_draft: '確かめました。', limitation: '', ...extra,
})

function triageFor(stateSum, results, status = 'completed') {
  const body = { status, results, stateSum }
  return { ...body, sum: fnvSum(body) }
}

test('readTriage は sum・stateSum・status・並びを照らし、native の包みから取り出す', async (t) => {
  const items = selectTargets(buildItems(raw()), { viewer: 'me' }).items
  const { state, stateSum } = stateOf(items)
  const ok = items.map((i) => result(i.comment_id, 'decline'))
  assert.equal(readTriage(triageFor(stateSum, ok), state, stateSum).results.length, items.length)
  assert.equal(readTriage({ summary: 's', agentCount: 2, result: triageFor(stateSum, ok) }, state, stateSum).results.length, items.length)
  assert.equal(readTriage(triageFor(stateSum, undefined, 'needs_decision'), state, stateSum).status, 'needs_decision')
  const cases = [
    { name: 'sum が合わない', triage: { ...triageFor(stateSum, ok), results: ok.slice(1) } },
    { name: '別の state', triage: triageFor('00000000', ok) },
    { name: '知らない status', triage: triageFor(stateSum, ok, 'done') },
    { name: '並びが違う', triage: triageFor(stateSum, [...ok].reverse()) },
    { name: '欠けた', triage: triageFor(stateSum, ok.slice(1)) },
    { name: 'completed なのに返信できない分類', triage: triageFor(stateSum, ok.map((r, n) => (n ? r : { ...r, classification: 'unverified' }))) },
    { name: '返り値でない', triage: null },
  ]
  for (const c of cases) {
    await t.test(c.name, () => throwsAddress(() => readTriage(c.triage, state, stateSum), CODES.input, 'fix_input'))
  }
})

const stopState = (stopAfter) => ({ stopAfter })
const fixes = (cls) => ({ status: 'completed', results: [result('a', cls)] })

test('triageNext は status・reason・呼び直しの回数・stopAfter から次の手を 1 つ決める', async (t) => {
  const cases = [
    ['needs_decision は利用者の判断', { status: 'needs_decision' }, 'reply', 0, 'decide'],
    ['agent が返らなかった 1 回目は呼び直す', { status: 'triage_incomplete', reason: 'triager-unavailable' }, 'reply', 0, 'classify_again'],
    ['並びが崩れた 1 回目は呼び直す', { status: 'triage_incomplete', reason: 'verifier-ids-mismatch' }, 'reply', 0, 'classify_again'],
    ['呼び直しの上限に達したら報告', { status: 'triage_incomplete', reason: 'verifier-unavailable' }, 'reply', TRIAGE_RETRIES, 'report'],
    ['head の食い違いは呼び直さない', { status: 'triage_incomplete', reason: 'triager-head-mismatch' }, 'reply', 0, 'report'],
    ['分類の食い違いは呼び直さない', { status: 'triage_incomplete', reason: 'verification-disagrees' }, 'reply', 0, 'report'],
    ['分類だけで止める', fixes('fix'), 'classify', 0, 'report'],
    ['fix があれば修正', fixes('fix'), 'verify', 0, 'implement'],
    ['fix が無く返信まで', fixes('decline'), 'reply', 0, 'recheck'],
    ['fix が無く push まで', fixes('decline'), 'push', 0, 'report'],
    ['fix が無く verify まで', fixes('decline'), 'verify', 0, 'report'],
  ]
  for (const [name, triage, stopAfter, used, next] of cases) {
    await t.test(name, () => assert.equal(triageNext(triage, stopState(stopAfter), used).next, next))
  }
})

test('fixNext は verify の結果と stopAfter から次の手を決める', async (t) => {
  const passed = { passed: true, actual: ['src/a.mjs'] }
  const cases = [
    ['直して verify まで', { verify: passed }, 'verify', 'report'],
    ['直して push まで', { verify: passed }, 'push', 'commit_push'],
    ['直して返信まで', { verify: passed }, 'reply', 'commit_push'],
    ['verify 不通過で返信まで', { verify: { passed: false, actual: ['x'] } }, 'reply', 'recheck'],
    ['no_change で返信まで', { verify: { passed: true, actual: [] } }, 'reply', 'recheck'],
    ['止まって返信まで', { stopped: 'needs_replan' }, 'reply', 'recheck'],
    ['止まって push まで', { stopped: 'needs_replan' }, 'push', 'report'],
    ['no_change で verify まで', { verify: { passed: true, actual: [] } }, 'verify', 'report'],
  ]
  for (const [name, input, stopAfter, next] of cases) {
    await t.test(name, () => {
      const out = fixNext(stopState(stopAfter), input)
      assert.equal(out.next, next)
      if (next === 'recheck') assert.equal(out.fixCommit, null)
    })
  }
})

test('confirmNext は 1 回目の missing を待って読み直し、2 回目に投稿し直し、3 回目は報告する', async (t) => {
  const p = (missing, duplicated = []) => ({ missing, duplicated, misplaced: [], confirmed: [] })
  const cases = [
    ['全て付いた', p([]), 1, true, 'report'],
    ['1 回目の missing', p([1]), 1, false, 'wait_and_retry'],
    ['2 回目の missing', p([1]), 2, false, 'repost'],
    ['3 回目の missing', p([1]), 3, false, 'report'],
    ['missing が無く二重だけ', p([], [1]), 1, false, 'report'],
  ]
  for (const [name, placement, attempt, passed, next] of cases) {
    await t.test(name, () => assert.deepEqual(confirmNext(placement, attempt), { passed, next }))
  }
})

test('splitDecisions は state に無い id と空・文字列でない値を外して返す', () => {
  const items = [{ comment_id: 'thread:11' }, { comment_id: 'review:42' }]
  assert.deepEqual(splitDecisions(undefined, items), { kept: {}, dropped: [] })
  assert.deepEqual(splitDecisions({ 'thread:11': '直す', 'review:42': ' ', 'thread:9': 'x', 'review:43': 1 }, items), {
    kept: { 'thread:11': '直す' },
    dropped: [
      { comment_id: 'review:42', value: ' ', reason: 'empty_or_not_text' },
      { comment_id: 'thread:9', value: 'x', reason: 'not_in_state' },
      { comment_id: 'review:43', value: 1, reason: 'not_in_state' },
    ],
  })
  throwsAddress(() => splitDecisions([], items), CODES.input, 'fix_input')
})

test('NEXT_BY_CODE は全ての CODES に NEXT の値を割り当てる', () => {
  assert.deepEqual(Object.keys(NEXT_BY_CODE).sort(), Object.values(CODES).sort())
  for (const next of Object.values(NEXT_BY_CODE)) assert.ok(Object.hasOwn(NEXT, next), next)
})

test('fixRequest は fix の指摘だけから依頼の文を組み、本文をデータとして引用する', () => {
  const items = selectTargets(buildItems(raw()), { viewer: 'me' }).items
  const { state } = stateOf(items)
  assert.deepEqual(fixRequest(state, items.map((i) => result(i.comment_id, 'decline'))), { request: null, fix_ids: [], commit_message: null })
  const out = fixRequest(state, items.map((i, n) => result(i.comment_id, n === 0 ? 'fix' : 'out_of_scope')))
  assert.deepEqual(out.fix_ids, ['thread:11'])
  assert.match(out.request, /> \[HIGH\] a が 1 のまま/)
  assert.match(out.request, /直す path: src\/a\.mjs/)
  assert.doesNotMatch(out.request, /summary: 変更していない行/)
  assert.match(out.commit_message, /PR #7/)
})

test('planReplies は thread に @login つきで、会話には 1 件にまとめて返し、直していない fix を飛ばす', () => {
  const items = selectTargets(buildItems(raw()), { viewer: 'me' }).items
  const { state } = stateOf(items)
  const results = [result('thread:11', 'fix'), result('issue_comment:31', 'decline'), result('review:42', 'out_of_scope', { evidence: [{ path: 'README.md', line: 1, claim: 'c' }] })]
  const fixed = planReplies(state, results, { commit: FIX, paths: ['src/a.mjs'] })
  assert.equal(fixed.replies.length, 2)
  const [thread, conversation] = fixed.replies
  assert.deepEqual(thread.place, { kind: 'thread', reply_to: 11 })
  assert.equal(thread.payload.in_reply_to, 11)
  assert.ok(thread.payload.body.startsWith('@github-actions[bot] '))
  assert.match(thread.payload.body, new RegExp(`修正: ${FIX}（src/a\\.mjs）`))
  assert.equal(thread.endpoint, 'repos/yoshiysh/claude-plugins/pulls/7/comments')
  assert.deepEqual(conversation.comment_ids, ['issue_comment:31', 'review:42'])
  assert.equal(conversation.endpoint, 'repos/yoshiysh/claude-plugins/issues/7/comments')
  assert.ok(conversation.payload.body.startsWith('@github-actions[bot] @bob\n\n'))
  assert.match(conversation.payload.body, /根拠: README\.md:1/)
  assert.equal(conversation.payload.in_reply_to, undefined)
  assert.ok(conversation.payload.body.endsWith(answeredMark(['issue_comment:31', 'review:42'])))
  const unfixed = planReplies(state, results, null)
  assert.deepEqual(unfixed.skipped, [{ comment_id: 'thread:11', reason: 'not_fixed' }])
  assert.deepEqual(unfixed.replies.map((r) => r.place.kind), ['conversation'])
})

test('次の run は、返した会話の指摘だけを外し、直さずに飛ばした指摘と後から来た指摘を残す', () => {
  const r = raw()
  r.issues.push({ id: 33, user: user('bob'), body: '会話の fix の指摘', created_at: '2026-10-01T02:10:00Z', updated_at: 'x', html_url: 'https://x/33' })
  const items = selectTargets(buildItems(r), { viewer: 'me' }).items
  const { state } = stateOf(items)
  const results = items.map((i) => result(i.comment_id, ['thread:11', 'issue_comment:33'].includes(i.comment_id) ? 'fix' : 'decline'))
  const [conversation] = planReplies(state, results, null).replies
  r.issues.push({ id: 34, user: user('bob'), body: 'collect の後に来た指摘', created_at: '2026-10-01T02:20:00Z', updated_at: 'x', html_url: 'https://x/34' })
  r.issues.push({ id: 35, user: user('me'), body: conversation.payload.body, created_at: '2026-10-01T03:00:00Z', updated_at: 'x', html_url: 'https://x/35' })
  const next = selectTargets(buildItems(r), { viewer: 'me' })
  assert.deepEqual(next.items.map((i) => i.comment_id), ['thread:11', 'issue_comment:33', 'issue_comment:34'])
  assert.deepEqual(next.excluded.filter((e) => e.reason === 'answered').map((e) => e.comment_id), ['issue_comment:31', 'review:42'])
})

test('changedTargets は返信先の議論の変化と消失だけを返す', () => {
  const items = selectTargets(buildItems(raw()), { viewer: 'me' }).items
  const { state } = stateOf(items)
  const replies = [{ comment_ids: ['thread:11'] }, { comment_ids: ['issue_comment:31', 'review:42'] }]
  assert.deepEqual(changedTargets(state, buildItems(raw()), replies), [])
  const r = raw()
  r.inline.push({ ...r.inline[1], id: 14, body: '追記' })
  r.issues = []
  r.threads[0].isOutdated = true
  assert.deepEqual(changedTargets(state, buildItems(r), replies), [
    { comment_id: 'thread:11', reason: 'discussion_changed' },
    { comment_id: 'issue_comment:31', reason: 'missing' },
  ])
})

test('confirmPlacement は正しい場所に 1 回だけ付いたかを、改行の違いを無視して数える', () => {
  const thread = { comment_ids: ['thread:11'], place: { kind: 'thread', reply_to: 11 }, payload: { body: '@a x\n\ny' } }
  const conv = { comment_ids: ['issue_comment:31'], place: { kind: 'conversation' }, payload: { body: '@b z' } }
  const inline = [{ id: 100, in_reply_to_id: 11, body: '@a x\r\n\r\ny\n' }]
  const ok = confirmPlacement([thread, conv], inline, [{ id: 200, body: '@b z' }])
  assert.deepEqual(ok.confirmed.map((e) => e.posted), [[100], [200]])
  const bad = confirmPlacement([thread, conv], [...inline, { id: 101, in_reply_to_id: 11, body: '@a x\n\ny' }, { id: 102, in_reply_to_id: 21, body: '@b z' }], [])
  assert.deepEqual(bad.duplicated.map((e) => e.posted), [[100, 101]])
  assert.deepEqual(bad.missing.map((e) => e.comment_ids), [['issue_comment:31']])
  assert.deepEqual(bad.misplaced.map((e) => e.elsewhere), [[102]])
})

test('confirmPlacement は同じ本文を別々の thread へ正しく返したものを誤った場所としない', () => {
  const a = { comment_ids: ['thread:11'], place: { kind: 'thread', reply_to: 11 }, payload: { body: '@bot 同じ' }, input_path: '/s/reply-1.json' }
  const b = { comment_ids: ['thread:21'], place: { kind: 'thread', reply_to: 21 }, payload: { body: '@bot 同じ' }, input_path: '/s/reply-2.json' }
  const out = confirmPlacement([a, b], [{ id: 100, in_reply_to_id: 11, body: '@bot 同じ' }, { id: 101, in_reply_to_id: 21, body: '@bot 同じ' }], [])
  assert.deepEqual(out.misplaced, [])
  assert.deepEqual(out.confirmed.map((e) => e.posted), [[100], [101]])
  const half = confirmPlacement([a, b], [{ id: 100, in_reply_to_id: 11, body: '@bot 同じ' }], [])
  assert.deepEqual(half.missing, [{ comment_ids: ['thread:21'], input_path: '/s/reply-2.json', posted: [] }])
})

test('unwrapWorkflowOutput は包みだけを開く', () => {
  assert.deepEqual(unwrapWorkflowOutput({ result: { a: 1 }, summary: 's', agentCount: 1 }), { a: 1 })
  assert.deepEqual(unwrapWorkflowOutput({ result: 1, summary: 's' }), { result: 1, summary: 's' })
  assert.equal(unwrapWorkflowOutput(null), null)
})

// このファイルの最後に置く（ここまでの拒否の箇所が集まっている）。
test('address-core.mjs の全ての throw new AddressError の箇所を、拒否のケースが 1 回以上通る', () => {
  const sites = throwSites(CORE_URL)
  assert.ok(sites.length > 0)
  assert.deepEqual(sites.filter((line) => !hitSites.has(line)), [], 'テストのケースが通っていない throw の行（箇所を足したらケースを足す）')
})
