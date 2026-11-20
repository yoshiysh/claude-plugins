// 同じ id を含む資産を、同じ枡で読む振る舞い（--link・related・照合の範囲・読み直しの判定）。
// 期待は計画 P6 の「決まった振る舞い」から取る。CLI は in-process で流す（test-harness の cli）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { MAX_ASSET_LINES, rangeText, sha } from './ledger-core.mjs'
import { cli, constraintIdsOf, drive, evidenceOf, goalsOf, indexIds, mockAgent, tmp } from './test-harness.mjs'

const LINK = 'U\\d+S\\d+'
const L1 = { id: 'L1', name: '主張と根拠', procedure: '主張ごとに根拠の文を対応づけ、根拠の無い主張を探す' }
const REQUEST = '対象の文書を観点ごとにレビューして、確かめた指摘を返してほしい'

const DEF = `# 定義の文書

振る舞い U1S1 は、入力が空のときに空の結果を返すことを定める本文の行である。
二行目も U1S1 の補足として十分な長さの本文の行を置く。
`
const USE = `# 使う側の文書

この節は U1S1 を前提にして、空の入力の扱いを使う本文の行として述べる。
二行目もこの節の補足として十分な長さの本文の行を置く。
`
const OTHER = `# 無関係の文書

この節はどの振る舞いの識別子も含まない、無関係な本文の行を置いた段落である。
二行目も無関係な補足として十分な長さの本文の行を置く。
`
const doc = (title, lines) => `# ${title}\n\n${lines.join('\n')}\n`
const filler = (tag, n) => Array.from({ length: n }, (_, i) => `${tag} の ${i + 1} 行目として、本文の行に十分な長さの文を置く。`)

const ledger = (state) => JSON.parse(readFileSync(path.join(state, 'ledger.json'), 'utf8'))
const bytes = (state) => readFileSync(path.join(state, 'ledger.json'), 'utf8')
const idOf = (state, name) => Object.keys(ledger(state).assets).find((id) => id.includes(`/${name}#`))
const liveCells = (L) => Object.entries(L.cells).filter(([, c]) => c.status !== 'gone')

// files: [[名前, 本文], …]（対象の順）。目標を照合済みにし、利用者の観点を渡すので、最初の next は review になる。
// link が null なら --link を付けない。
function lsetup(t, { files, link = LINK, lenses = [L1], workers = 3, extra = [] }) {
  const d = tmp(t)
  for (const [name, text] of files) writeFileSync(path.join(d, name), text)
  writeFileSync(path.join(d, 'goal.md'), '- G1: 対象の文書の見落としを観点ごとに確かめた指摘の一覧\n')
  writeFileSync(path.join(d, 'request.md'), REQUEST)
  const lensArgs = []
  if (lenses) { writeFileSync(path.join(d, 'lenses.json'), JSON.stringify(lenses)); lensArgs.push('--lenses', path.join(d, 'lenses.json')) }
  const state = path.join(d, 'state')
  const argv = ['init', '--state', state, '--goal', path.join(d, 'goal.md'), '--request', path.join(d, 'request.md'), ...files.flatMap(([name]) => ['--target', path.join(d, name)]),
    ...lensArgs, '--goal-checked', 'coverage-build', ...(link === null ? [] : ['--link', link]), ...extra]
  const r = cli(...argv)
  assert.equal(r.code, 0, JSON.stringify(r))
  if (workers != null) assert.equal(cli('config', '--state', state, '--workers', String(workers)).code, 0)
  return { d, state, file: (name) => path.join(d, name) }
}
function review(state) {
  const n = cli('next', '--state', state)
  assert.equal(n.code, 0, JSON.stringify(n))
  assert.equal(n.step, 'review', JSON.stringify(n))
  return { n, args: JSON.parse(readFileSync(n.args_path, 'utf8')) }
}
const rows = (args, queue) => args.workers.filter((w) => w.queue === queue && w.pass === 1)
const claim = (state, call, worker) => cli('claim', '--state', state, '--call', call, '--worker', worker)
const claimer = (state, cell) => { const c = ledger(state).cells[cell]; return (c && c.claim && c.claim.worker) || 'no-claim' }
const submit = (state, call, cell, file) => cli('submit', '--state', state, '--call', call, '--cell', cell, '--worker', claimer(state, cell), '--result', file)
let seq = 0
const put = (d, obj) => { const f = path.join(d, `res-${++seq}.json`); writeFileSync(f, JSON.stringify(obj)); return f }
const evidence = (asset) => evidenceOf(`写し: ${asset.file}\n行: ${asset.start}-${asset.end}`)
const goodRead = (asset, findings = []) => ({ evidence: evidence(asset), findings, outside_notes: [], none_reason: findings.length ? '' : '手続きに沿って読み、該当が無かった' })
const finding = (claimText, quote) => ({ claim: claimText, quote, severity: 'MEDIUM', layer: '実装' })
const textOf = (r) => rangeText(readFileSync(r.file, 'utf8'), r.start, r.end)
const lineOf = (r) => evidence(r)[0]
// related の要素の形: 台帳の資産の id と、その資産の写しの範囲（担当が Read する範囲）。
const relatedOf = (state, ...ids) => ids.map((id) => { const a = ledger(state).assets[id]; return { id, file: a.snap, start: a.start, end: a.end } })

// ---------------- 1. --link（init・reframe） ----------------

test('1. init: --link の正規表現を台帳の link に文字列で置き、渡さなければ null にする', (t) => {
  const withLink = lsetup(t, { files: [['def.md', DEF]] })
  assert.equal(ledger(withLink.state).link, LINK)
  const without = lsetup(t, { files: [['def.md', DEF]], link: null })
  assert.ok('link' in ledger(without.state), 'link の欄は null でも持つ')
  assert.equal(ledger(without.state).link, null)
})

test('1. init: 正規表現として作れない --link は終了状態 2 で拒否し、台帳を作らない', (t) => {
  const d = tmp(t)
  writeFileSync(path.join(d, 'def.md'), DEF)
  writeFileSync(path.join(d, 'goal.md'), '- G1: 対象の文書の見落としを観点ごとに確かめた指摘の一覧\n')
  writeFileSync(path.join(d, 'request.md'), REQUEST)
  const argv = (state, link) => ['init', '--state', state, '--goal', path.join(d, 'goal.md'), '--request', path.join(d, 'request.md'), '--target', path.join(d, 'def.md'), '--goal-checked', 'coverage-build', '--link', link]
  const good = cli(...argv(path.join(d, 'good'), LINK))
  assert.equal(good.code, 0, `作れる正規表現は受け付ける: ${JSON.stringify(good)}`)
  const state = path.join(d, 'state')
  const r = cli(...argv(state, '('))
  assert.equal(r.code, 2, JSON.stringify(r))
  assert.equal(r.ok, false)
  assert.ok(!existsSync(path.join(state, 'ledger.json')), '台帳を作らない')
})

// reframe の入力は coverage-build が渡す形（目標の冒頭の文 + 項目）。
function frame(d, name, request = REQUEST) {
  const f = (k) => path.join(d, `${name}-${k}.md`)
  writeFileSync(f('goal'), '実装が次の固定した目標を満たすかを確かめる。\n\n- G1: 実装の見落としを確かめた指摘の一覧\n')
  writeFileSync(f('request'), `${request}\n`)
  writeFileSync(f('criteria'), '- AC1: 主張ごとに根拠がある\n')
  writeFileSync(f('constraints'), '- D1: 依存を足さない\n')
  writeFileSync(f('decisions'), '- 依存を足さない\n')
  return ['--goal', f('goal'), '--request', f('request'), '--criteria', f('criteria'), '--constraints', f('constraints'), '--decisions', f('decisions')]
}
function reframeSetup(t, link) {
  const d = tmp(t)
  writeFileSync(path.join(d, 'def.md'), DEF)
  writeFileSync(path.join(d, 'use.md'), USE)
  const state = path.join(d, 'state')
  const r = cli('init', '--state', state, ...frame(d, 'design'), '--target', path.join(d, 'def.md'), '--target', path.join(d, 'use.md'), '--goal-checked', 'coverage-build', '--phase', 'design', ...(link ? ['--link', link] : []))
  assert.equal(r.code, 0, JSON.stringify(r))
  return { d, state, targets: ['--target', path.join(d, 'def.md'), '--target', path.join(d, 'use.md')] }
}

test('1. reframe: --link で link を差し替え、--link を持たない reframe は link を null にする（link は枠の一部）', (t) => {
  const { d, state, targets } = reframeSetup(t, LINK)
  assert.equal(ledger(state).link, LINK)
  const a = cli('reframe', '--state', state, ...frame(d, 'impl1'), ...targets, '--phase', 'impl', '--link', 'X\\d+')
  assert.equal(a.code, 0, JSON.stringify(a))
  assert.equal(ledger(state).link, 'X\\d+')
  const b = cli('reframe', '--state', state, ...frame(d, 'impl2'), ...targets, '--phase', 'review')
  assert.equal(b.code, 0, JSON.stringify(b))
  assert.equal(ledger(state).link, null, '--link の無い reframe は link を残さない')
})

test('1. reframe: 正規表現として作れない --link は終了状態 2 で拒否し、台帳を変えない', (t) => {
  const { d, state, targets } = reframeSetup(t, LINK)
  const before = bytes(state)
  const r = cli('reframe', '--state', state, ...frame(d, 'impl'), ...targets, '--phase', 'impl', '--link', '[')
  assert.equal(r.code, 2, JSON.stringify(r))
  assert.equal(r.ok, false)
  assert.equal(bytes(state), before)
})

test('1. reframe: link を付けて reframe しても、全ての枡を読み直す（中身が同じでも）', async (t) => {
  const { d, state, targets } = reframeSetup(t, LINK)
  const first = await drive(state, mockAgent())
  assert.equal(first.stop.stop, 'complete', JSON.stringify(first.stop))
  assert.ok(liveCells(ledger(state)).length > 0)
  const r = cli('reframe', '--state', state, ...frame(d, 'impl'), ...targets, '--phase', 'impl', '--link', LINK)
  assert.equal(r.code, 0, JSON.stringify(r))
  assert.ok(liveCells(ledger(state)).every(([, c]) => c.status === 'unseen'), '全ての枡が読み直し')
})

// ---------------- 6. 古い台帳 ----------------

test('6. 台帳に link の欄が無ければ、台帳の形式が古いとして終了状態 2 で拒否し、台帳を変えない（next・status）', (t) => {
  const { state } = lsetup(t, { files: [['def.md', DEF]] })
  const L = ledger(state)
  delete L.link
  writeFileSync(path.join(state, 'ledger.json'), JSON.stringify(L, null, 1))
  const before = bytes(state)
  for (const argv of [['next', '--state', state], ['status', '--state', state]]) {
    const r = cli(...argv)
    assert.equal(r.code, 2, `${argv[0]}: ${JSON.stringify(r)}`)
    assert.equal(r.ok, false)
    assert.match(r.error, /台帳の形式が古い/, argv[0])
    assert.match(r.error, /新しい stateDir で init からやり直す/, argv[0])
  }
  assert.equal(bytes(state), before)
})

// ---------------- 2・3. related ----------------

test('2・3. claim（読む役）: link の一致の語を共有する他の資産を related として返し、共有しない資産は返さない。related の要素は id・file・start・end', (t) => {
  const { state } = lsetup(t, { files: [['def.md', DEF], ['use.md', USE], ['other.md', OTHER]] })
  const { n, args } = review(state)
  const c = claim(state, n.call_id, rows(args, 'read')[0].id)
  assert.equal(c.code, 0, JSON.stringify(c))
  assert.equal(c.asset.id, idOf(state, 'def.md'), '先頭の資産を取る')
  assert.deepEqual(c.related, relatedOf(state, idOf(state, 'use.md')), JSON.stringify(c.related))
  assert.deepEqual(c.related_not_given, [])
  assert.ok(c.related.every((r) => existsSync(r.file)))
  assert.ok(textOf(c.related[0]).includes('この節は U1S1 を前提にして'), 'file の start〜end の行が関係する資産の本文')
  // 使う側から見れば、定める側が related。
  const u = claim(state, n.call_id, rows(args, 'read')[1].id)
  assert.equal(u.asset.id, idOf(state, 'use.md'))
  assert.deepEqual(u.related, relatedOf(state, idOf(state, 'def.md')))
  // どの語も共有しない資産には related が無い。
  const o = claim(state, n.call_id, rows(args, 'read')[2].id)
  assert.equal(o.asset.id, idOf(state, 'other.md'))
  assert.deepEqual(o.related, [])
  assert.deepEqual(o.related_not_given, [])
})

test('2・3. claim（検証役）: 読む役と同じ related と related_not_given を返す', (t) => {
  const { state, d } = lsetup(t, { files: [['def.md', DEF], ['use.md', USE], ['other.md', OTHER]] })
  const { n, args } = review(state)
  const r = claim(state, n.call_id, rows(args, 'read')[0].id)
  const [q1] = evidence(r.asset)
  assert.equal(submit(state, n.call_id, r.cells[0].cell_id, put(d, goodRead(r.asset, [finding('使う側と食い違う', q1)]))).ok, true)
  const v = claim(state, n.call_id, rows(args, 'verify')[0].id)
  assert.equal(v.code, 0, JSON.stringify(v))
  assert.ok(!v.done)
  assert.equal(v.asset.id, r.asset.id)
  assert.deepEqual(v.related, relatedOf(state, idOf(state, 'use.md')))
  assert.deepEqual(v.related_not_given, [])
})

test('2・3. link が null なら、同じ語を共有する資産があっても related は空で related_not_given も空', (t) => {
  const { state, d } = lsetup(t, { files: [['def.md', DEF], ['use.md', USE]], link: null })
  const { n, args } = review(state)
  const r = claim(state, n.call_id, rows(args, 'read')[0].id)
  assert.deepEqual(r.related, [])
  assert.deepEqual(r.related_not_given, [])
  const [q1] = evidence(r.asset)
  assert.equal(submit(state, n.call_id, r.cells[0].cell_id, put(d, goodRead(r.asset, [finding('指摘', q1)]))).ok, true)
  const v = claim(state, n.call_id, rows(args, 'verify')[0].id)
  assert.deepEqual(v.related, [])
  assert.deepEqual(v.related_not_given, [])
})

test('2. related の並び: 共有する語の数（異なる語の数）の多い順、同じなら資産の並びの順。語の出現回数では並べない', (t) => {
  const { state } = lsetup(t, {
    link: 'U1S\\d',
    files: [
      ['a.md', doc('定める文書', ['U1S1 と U1S2 と U1S3 を定める本文の行として十分な長さの文を置く。'])],
      ['b.md', doc('一語を何度も使う文書', ['U1S1 を前提にする。U1S1 を前提にする。U1S1 を前提にする。U1S1 を前提にする本文の行。'])],
      ['c.md', doc('三語を使う文書', ['U1S1 と U1S2 と U1S3 を全て前提にする本文の行として十分な長さの文を置く。'])],
      ['d.md', doc('二語を使う文書', ['U1S2 と U1S3 を前提にする本文の行として十分な長さの文を置く。'])],
      ['e.md', doc('一語を使う文書', ['U1S1 を前提にする本文の行として十分な長さの文を置く。'])],
      ['f.md', doc('無関係の文書', ['どの識別子も含まない本文の行として十分な長さの文を置く。'])],
    ],
  })
  const { n, args } = review(state)
  const c = claim(state, n.call_id, rows(args, 'read')[0].id)
  assert.equal(c.asset.id, idOf(state, 'a.md'))
  // c（3 語）→ d（2 語）→ b・e（どちらも 1 語。資産の並びで b が先）。f は共有しない。
  assert.deepEqual(c.related.map((r) => r.id), ['c.md', 'd.md', 'b.md', 'e.md'].map((x) => idOf(state, x)))
})

test('2. related の行の合計は MAX_ASSET_LINES まで（ちょうどは入る）。入らない資産は related_not_given に id で残し、並びの順に並べる', (t) => {
  const { state } = lsetup(t, {
    link: 'U1S\\d',
    files: [
      ['a.md', doc('定める文書', ['U1S1 と U1S2 を定める本文の行として十分な長さの文を置く。'])],
      ['b.md', doc('長い文書', ['U1S1 と U1S2 を前提にする本文の行として十分な長さの文を置く。', ...filler('長い文書', MAX_ASSET_LINES - 1)])],
      ['c.md', doc('短い文書 1', ['U1S1 を前提にする。', ...filler('短い文書 1', 4)])],
      ['d.md', doc('短い文書 2', ['U1S2 を前提にする。', ...filler('短い文書 2', 4)])],
    ],
  })
  const { n, args } = review(state)
  const b = ledger(state).assets[idOf(state, 'b.md')]
  assert.equal(b.end - b.start + 1, MAX_ASSET_LINES, '長い文書は 1 資産でちょうど MAX_ASSET_LINES 行')
  const c = claim(state, n.call_id, rows(args, 'read')[0].id)
  assert.equal(c.asset.id, idOf(state, 'a.md'))
  assert.deepEqual(c.related.map((r) => r.id), [idOf(state, 'b.md')], 'b（2 語・120 行）が先に入って枠を使い切る')
  assert.deepEqual(c.related_not_given, [idOf(state, 'c.md'), idOf(state, 'd.md')])
  const lines = c.related.reduce((s, r) => s + (r.end - r.start + 1), 0)
  assert.ok(lines <= MAX_ASSET_LINES)
})

test('2. related は計画が除いた資産を含まず、その資産は related_not_given にも挙げない', async (t) => {
  const d = tmp(t)
  for (const [name, text] of [['a.md', DEF], ['b.md', USE], ['c.md', doc('もう一つの使う側', ['この節も U1S1 を前提にして、別の観点で本文の行を述べる十分な長さの文を置く。'])]]) writeFileSync(path.join(d, name), text)
  writeFileSync(path.join(d, 'goal.md'), '- G1: 対象の文書の見落としを観点ごとに確かめた指摘の一覧\n')
  writeFileSync(path.join(d, 'request.md'), REQUEST)
  const state = path.join(d, 'state')
  const r = cli('init', '--state', state, '--goal', path.join(d, 'goal.md'), '--request', path.join(d, 'request.md'), ...['a.md', 'b.md', 'c.md'].flatMap((f) => ['--target', path.join(d, f)]), '--goal-checked', 'coverage-build', '--link', LINK)
  assert.equal(r.code, 0, JSON.stringify(r))
  // 観点 X1 を a・c に当て、b を除く計画。
  const plan = (p) => {
    const [a, b, c] = indexIds(p)
    const lenses = [{ id: 'X1', name: '整合', procedure: '主張と根拠を対応づけて食い違いを探す', applies_to: [a, c], goals: goalsOf(p) }]
    const src = p.includes('### 前の計画') ? ['P:X1'] : [...p.matchAll(/^### ([AB])（/gm)].map((m) => `${m[1]}:X1`)
    return { lenses, excluded: [{ asset: b, reason: '目標に関係しない節' }], questions: [], constraint_map: constraintIdsOf(p).map((id) => ({ constraint_id: id, handled_by: ['X1'] })), source_map: src.map((s) => ({ source: s, merged_into: 'X1', dropped_reason: '' })), defect_responses: [] }
  }
  const log = []
  const { stop } = await drive(state, mockAgent({ plan, integrate: plan }, log))
  assert.equal(stop.stop, 'complete', JSON.stringify(stop))
  const idB = idOf(state, 'b.md')
  const idA = idOf(state, 'a.md')
  const idC = idOf(state, 'c.md')
  const claims = (log.claims || []).map((x) => x.out).filter((o) => o.asset)
  const ofA = claims.find((o) => o.asset.id === idA)
  assert.ok(ofA, 'a の資産を取った')
  assert.deepEqual(ofA.related.map((x) => x.id), [idC], '除いた b は related に入らない')
  assert.deepEqual(ofA.related_not_given, [])
  assert.ok(claims.every((o) => ![...o.related, ...o.related_not_given.map((id) => ({ id }))].some((x) => x.id === idB)), '除いた資産はどの claim の related にも related_not_given にも出ない')
})

test('2. related は振り返りの資産（retro:…）を関係の元にも先にもしない', (t) => {
  const { state } = lsetup(t, { files: [['def.md', DEF], ['use.md', USE], ['other.md', OTHER]], workers: null })
  // 出来事の文は指摘の id を含み、link の語を含みうる。振り返りの資産とその枡（R1）を台帳に足す（coverage-build を通さない台帳が振り返りで作るのと同じ形）。
  const text = '[E1-1] (refuted) x.md#abc: U1S1 を定める節が無い（本文が否定する）'
  const retroId = 'retro:c1:review'
  mkdirSync(path.join(state, 'snap'), { recursive: true })
  const snap = path.join(state, 'snap', `${sha(text).slice(0, 16)}.txt`)
  writeFileSync(snap, text)
  const L = ledger(state)
  L.assets[retroId] = { path: retroId, heading: 'review', trail: [], kind: 'chunk', start: 1, end: 1, hash: sha(text).slice(0, 16), snap, blocks: [[0, 0]], need: 1, retro: true }
  const r1 = L.lenses.find((l) => l.id === 'R1')
  L.cells[`${retroId}|R1|p1`] = { asset: retroId, lens: 'R1', pass: 1, status: 'unseen', asset_hash: L.assets[retroId].hash, lens_version: r1.version, attempts: 0, problems: [], outside_notes: [] }
  writeFileSync(path.join(state, 'ledger.json'), JSON.stringify(L, null, 1))
  const { n, args } = review(state)
  const got = {}
  for (const w of rows(args, 'read')) {
    const c = claim(state, n.call_id, w.id)
    assert.equal(c.code, 0, JSON.stringify(c))
    if (!c.done) got[c.asset.id] = c
  }
  assert.ok(got[retroId], '振り返りの資産も取られる')
  assert.deepEqual(got[retroId].related, [], '振り返りの資産は関係の元にしない（語を共有する資産があっても related は空）')
  assert.deepEqual(got[retroId].related_not_given, [])
  assert.deepEqual(got[idOf(state, 'def.md')].related.map((x) => x.id), [idOf(state, 'use.md')], '振り返りの資産は関係の先にもしない')
  assert.deepEqual(got[idOf(state, 'use.md')].related.map((x) => x.id), [idOf(state, 'def.md')])
})

// ---------------- 3. prompt ----------------

test('3. worker の prompt（読む役・検証役）: 不在や食い違いを主張する前に related の範囲を読むこと、読まなかった related（related_not_given）に頼らないことを伝える', async (t) => {
  const { state } = lsetup(t, { files: [['def.md', DEF], ['use.md', USE]], workers: 2 })
  const log = []
  const { stop } = await drive(state, mockAgent({}, log))
  assert.equal(stop.stop, 'complete', JSON.stringify(stop))
  const ws = log.filter((x) => /ledger-cli\.mjs.* claim /.test(x.prompt))
  assert.ok(ws.some((x) => x.label.includes('worker-read')) && ws.some((x) => x.label.includes('worker-verify')), '読む役と検証役の worker の prompt')
  for (const x of ws) {
    assert.match(x.prompt, /related/, `${x.label}: related を読む指示`)
    assert.match(x.prompt, /related_not_given/, `${x.label}: 読まなかった related に頼らない指示`)
    assert.match(x.prompt, /不在/, `${x.label}: 不在の主張の前に読む`)
    assert.match(x.prompt, /食い違い/, `${x.label}: 食い違いの主張の前に読む`)
  }
})

// ---------------- 4. 照合の範囲 ----------------

test('4. 読む役: evidence の引用が related の本文にしか無ければ、提出ごと拒まれ試行に数える（照合は asset の本文だけ）', (t) => {
  const { state, d } = lsetup(t, { files: [['def.md', DEF], ['use.md', USE]] })
  const { n, args } = review(state)
  const r = claim(state, n.call_id, rows(args, 'read')[0].id)
  const relLine = lineOf(r.related[0])
  const bad = { ...goodRead(r.asset), evidence: [...evidence(r.asset), relLine] }
  const s = submit(state, n.call_id, r.cells[0].cell_id, put(d, bad))
  assert.equal(s.code, 0, JSON.stringify(s))
  assert.equal(s.ok, false, JSON.stringify(s))
  assert.ok(s.problems.length)
  assert.equal(ledger(state).cells[r.cells[0].cell_id].attempts, 1)
})

test('4. 読む役: 指摘の quote が related の本文にしか無ければ拒まれる（指摘の場所は asset に置く）', (t) => {
  const { state, d } = lsetup(t, { files: [['def.md', DEF], ['use.md', USE]] })
  const { n, args } = review(state)
  const r = claim(state, n.call_id, rows(args, 'read')[0].id)
  const relLine = lineOf(r.related[0])
  const s = submit(state, n.call_id, r.cells[0].cell_id, put(d, goodRead(r.asset, [finding('使う側の記述が定義と食い違う', relLine)])))
  assert.equal(s.ok, false, JSON.stringify(s))
  assert.ok(s.problems.some((p) => /findings\[0\]/.test(p)), JSON.stringify(s.problems))
  assert.equal(ledger(state).cells[r.cells[0].cell_id].status, 'unseen', '読みは受理されない')
})

// def.md の資産に 2 つの指摘を出して検証の待ち行列へ回し、検証役が取った枡を返す。
function toVerify(t, opts) {
  const { state, d } = lsetup(t, opts)
  const { n, args } = review(state)
  const r = claim(state, n.call_id, rows(args, 'read')[0].id)
  const [q1, q2] = evidence(r.asset)
  const s = submit(state, n.call_id, r.cells[0].cell_id, put(d, goodRead(r.asset, [finding('使う側が定義を前提にしていない', q1), finding('使う側の扱いが定義と食い違う', q2)])))
  assert.equal(s.ok, true, JSON.stringify(s))
  const v = claim(state, n.call_id, rows(args, 'verify')[0].id)
  assert.equal(v.code, 0, JSON.stringify(v))
  assert.equal(v.cells[0].findings.length, 2)
  return { state, d, n, v, x: v.cells[0], related: v.related }
}
const verdictsFor = (quotes) => ({ verdicts: quotes.map((q, index) => ({ index, verdict: 'confirmed', reason: '本文が支える', quote: q })) })
const findingsOf = (state) => Object.values(ledger(state).findings).filter((f) => f.status === 'current')

test('4. 検証役: verdict の quote が related の本文に逐語であれば効く。asset にも related にも無い本文の引用は unverifiable', (t) => {
  const { state, d, n, x, related } = toVerify(t, { files: [['def.md', DEF], ['use.md', USE], ['other.md', OTHER]] })
  assert.equal(related.length, 1)
  const outside = evidenceOf(`写し: ${ledger(state).assets[idOf(state, 'other.md')].snap}\n行: ${ledger(state).assets[idOf(state, 'other.md')].start}-${ledger(state).assets[idOf(state, 'other.md')].end}`)[0]
  const s = submit(state, n.call_id, x.cell_id, put(d, verdictsFor([lineOf(related[0]), outside])))
  assert.equal(s.ok, true, JSON.stringify(s))
  const fs = findingsOf(state)
  assert.equal(fs.find((f) => f.claim === '使う側が定義を前提にしていない').verdict, 'confirmed', 'related の本文の引用は効く')
  assert.equal(fs.find((f) => f.claim === '使う側の扱いが定義と食い違う').verdict, 'unverifiable', 'どの本文にも無い引用は効かない')
})

test('4. 検証役: asset の本文の引用は今までどおり効く', (t) => {
  const { state, d, n, x } = toVerify(t, { files: [['def.md', DEF], ['use.md', USE]] })
  const s = submit(state, n.call_id, x.cell_id, put(d, verdictsFor(x.findings.map((f) => f.quote))))
  assert.equal(s.ok, true, JSON.stringify(s))
  assert.ok(findingsOf(state).every((f) => f.verdict === 'confirmed'))
})

test('4. 検証役: link が null なら related が無いので、他の資産の本文の引用は効かず unverifiable', (t) => {
  const { state, d, n, x } = toVerify(t, { files: [['def.md', DEF], ['use.md', USE]], link: null })
  const a = ledger(state).assets[idOf(state, 'use.md')]
  const useLine = evidenceOf(`写し: ${a.snap}\n行: ${a.start}-${a.end}`)[0]
  const s = submit(state, n.call_id, x.cell_id, put(d, verdictsFor([useLine, useLine])))
  assert.equal(s.ok, true, JSON.stringify(s))
  assert.ok(findingsOf(state).every((f) => f.verdict === 'unverifiable'), JSON.stringify(findingsOf(state).map((f) => f.verdict)))
})

// ---------------- 5. 読み直しの判定 ----------------

async function settled(t, files) {
  const s = lsetup(t, { files })
  const first = await drive(s.state, mockAgent())
  assert.equal(first.stop.stop, 'complete', JSON.stringify(first.stop))
  assert.ok(liveCells(ledger(s.state)).every(([, c]) => c.status === 'settled'))
  return s
}
const cellsOf = (state, name) => liveCells(ledger(state)).filter(([, c]) => c.asset === idOf(state, name))
const unseen = (state, name) => cellsOf(state, name).filter(([, c]) => c.status === 'unseen').length

test('5. 変わっていない台帳の next は読み直さない（完了のまま）', async (t) => {
  const { state } = await settled(t, [['def.md', DEF], ['use.md', USE], ['other.md', OTHER]])
  const n = cli('next', '--state', state)
  assert.equal(n.stop, 'complete', JSON.stringify(n))
})

test('5. related の本文が変われば、asset の本文が同じでもその枡は読み直しになる。関係の無い資産の枡は読み直さない', async (t) => {
  const { state, file } = await settled(t, [['def.md', DEF], ['use.md', USE], ['other.md', OTHER]])
  const hashDef = ledger(state).assets[idOf(state, 'def.md')].hash
  writeFileSync(file('use.md'), USE.replace('空の入力の扱いを使う', '空の入力の扱いを変えて使う'))
  const n = cli('next', '--state', state)
  assert.equal(n.code, 0, JSON.stringify(n))
  assert.equal(n.step, 'review', JSON.stringify(n))
  const L = ledger(state)
  assert.equal(L.assets[idOf(state, 'def.md')].hash, hashDef, 'def の本文は変わっていない')
  assert.ok(cellsOf(state, 'def.md').length && unseen(state, 'def.md') === cellsOf(state, 'def.md').length, 'related（use）が変わったので def の枡は読み直し')
  assert.ok(unseen(state, 'use.md') > 0, 'use 自身も読み直し')
  assert.equal(unseen(state, 'other.md'), 0, '関係の無い資産の枡は読み直さない')
})

test('5. 語を共有する資産が増えて related の組が変われば、その枡は読み直しになる', async (t) => {
  const { state, file } = await settled(t, [['def.md', DEF], ['use.md', USE], ['other.md', OTHER]])
  writeFileSync(file('other.md'), OTHER.replace('どの振る舞いの識別子も含まない', 'U1S1 を前提にする'))
  const n = cli('next', '--state', state)
  assert.equal(n.code, 0, JSON.stringify(n))
  assert.equal(n.step, 'review', JSON.stringify(n))
  assert.ok(unseen(state, 'def.md') === cellsOf(state, 'def.md').length && unseen(state, 'def.md') > 0, 'def の related に other が加わったので読み直し')
  assert.ok(unseen(state, 'use.md') === cellsOf(state, 'use.md').length && unseen(state, 'use.md') > 0, 'use の related にも other が加わったので読み直し')
})

test('5. link が null なら、他の資産が変わっても asset の本文が同じ枡は読み直さない（従来どおり）', async (t) => {
  const s = lsetup(t, { files: [['def.md', DEF], ['use.md', USE]], link: null })
  const first = await drive(s.state, mockAgent())
  assert.equal(first.stop.stop, 'complete', JSON.stringify(first.stop))
  writeFileSync(s.file('use.md'), USE.replace('空の入力の扱いを使う', '空の入力の扱いを変えて使う'))
  const n = cli('next', '--state', s.state)
  assert.equal(n.step, 'review', JSON.stringify(n))
  assert.equal(unseen(s.state, 'def.md'), 0)
  assert.ok(unseen(s.state, 'use.md') > 0)
})
