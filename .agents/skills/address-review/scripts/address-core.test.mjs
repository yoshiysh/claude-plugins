import test from 'node:test'
import assert from 'node:assert/strict'
import {
  AddressError, CODES, EXCLUSION_REASONS, buildItems, changedTargets, confirmPlacement, discussionOf, fixRequest, fnvSum, newState,
  planReplies, selectTargets, triageOf, unwrapWorkflowOutput,
} from './address-core.mjs'

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
      assert.throws(() => buildItems(r), (e) => e instanceof AddressError && e.code === CODES.io)
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
      name: '認証ユーザーの会話より前の会話は answered、後は対象',
      mutate: (r) => { r.issues.push({ id: 32, user: user('me'), body: '返答', created_at: '2026-10-01T02:30:00Z', updated_at: '2026-10-01T02:30:00Z', html_url: 'https://x/32' }) },
      opts: {}, items: ['thread:11', 'review:42'], excluded: { 'issue_comment:31': 'answered', 'issue_comment:32': 'viewer' },
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
      assert.throws(() => selectTargets(buildItems(raw()), { viewer: 'me', ...opts }), (e) => e.code === CODES.input)
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
  const st = newState({ repo: '/r', pr: 7, view: { baseRefOid: BASE }, head: HEAD, branch: 'feat/x', viewer: 'me', items, excluded: [] })
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

test('triageOf は sum・stateSum・status・並びを照らし、native の包みから取り出す', async (t) => {
  const items = selectTargets(buildItems(raw()), { viewer: 'me' }).items
  const { state, stateSum } = stateOf(items)
  const ok = items.map((i) => result(i.comment_id, 'decline'))
  assert.equal(triageOf(triageFor(stateSum, ok), state, stateSum).length, items.length)
  assert.equal(triageOf({ summary: 's', agentCount: 2, result: triageFor(stateSum, ok) }, state, stateSum).length, items.length)
  const cases = [
    { name: 'sum が合わない', triage: { ...triageFor(stateSum, ok), status: 'completed', results: ok.slice(1) }, code: CODES.input },
    { name: '別の state', triage: triageFor('00000000', ok), code: CODES.input },
    { name: 'needs_decision', triage: triageFor(stateSum, ok, 'needs_decision'), code: CODES.state },
    { name: 'triage_incomplete', triage: triageFor(stateSum, ok, 'triage_incomplete'), code: CODES.state },
    { name: '並びが違う', triage: triageFor(stateSum, [...ok].reverse()), code: CODES.input },
    { name: '欠けた', triage: triageFor(stateSum, ok.slice(1)), code: CODES.input },
    { name: '返信できない分類', triage: triageFor(stateSum, ok.map((r, n) => (n ? r : { ...r, classification: 'unverified' }))), code: CODES.state },
  ]
  for (const c of cases) {
    await t.test(c.name, () => assert.throws(() => triageOf(c.triage, state, stateSum), (e) => e.code === c.code))
  }
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
  const unfixed = planReplies(state, results, null)
  assert.deepEqual(unfixed.skipped, [{ comment_id: 'thread:11', reason: 'not_fixed' }])
  assert.deepEqual(unfixed.replies.map((r) => r.place.kind), ['conversation'])
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

test('unwrapWorkflowOutput は包みだけを開く', () => {
  assert.deepEqual(unwrapWorkflowOutput({ result: { a: 1 }, summary: 's', agentCount: 1 }), { a: 1 })
  assert.deepEqual(unwrapWorkflowOutput({ result: 1, summary: 's' }), { result: 1, summary: 's' })
  assert.equal(unwrapWorkflowOutput(null), null)
})
