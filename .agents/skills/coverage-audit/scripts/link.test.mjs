// 関係する単位を結ぶ語の正規表現（--link）を台帳の枠として持つ振る舞い（init・reframe・古い台帳）。
// link は静的な検査に渡す ID の形として残し（設計「段の構成」）、同じ枡で関係する資産を一緒に読ませる related の束は作らない（単位をファイルにしたため）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { behave, cli, drive, status, tmp } from './blackboard-fixture.mjs'

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
const ledger = (state) => JSON.parse(readFileSync(path.join(state, 'ledger.json'), 'utf8'))
const bytes = (state) => readFileSync(path.join(state, 'ledger.json'), 'utf8')
// files: [[名前, 本文], …]（対象の順）。目標を照合済みにし、利用者の観点を渡すので、最初の next はファイルの段になる。
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
  writeFileSync(path.join(d, 'lenses.json'), JSON.stringify([L1]))
  const r = cli('init', '--state', state, ...frame(d, 'design'), '--target', path.join(d, 'def.md'), '--target', path.join(d, 'use.md'), '--lenses', path.join(d, 'lenses.json'), '--goal-checked', 'coverage-build', '--phase', 'design', ...(link ? ['--link', link] : []))
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

test('1. reframe: link を付けて reframe しても、全ての単位を読み直す（中身が同じでも）', async (t) => {
  const { d, state, targets } = reframeSetup(t, LINK)
  const first = await drive(state, behave())
  assert.equal(first.stop.stop, 'complete', JSON.stringify(first.stop))
  assert.ok(status(state).units.every((u) => u.state === 'seen'))
  const r = cli('reframe', '--state', state, ...frame(d, 'impl'), ...targets, '--phase', 'impl', '--link', LINK)
  assert.equal(r.code, 0, JSON.stringify(r))
  const units = status(state).units
  assert.ok(units.length === 2 && units.every((u) => u.state === 'unseen'), '全ての単位が読み直し')
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
