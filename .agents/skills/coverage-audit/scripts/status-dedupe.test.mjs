// status の確定指摘のまとめと、束ねの群の載せ方（計画 P7）。
// 台帳は init で作り、指摘と群は ledger.json へ直接置く（観点の数だけ同じ指摘ができた状態を、読む役の実行なしに作る）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { cli, tmp } from './test-harness.mjs'

const QUOTE = '入力が空のときは空の結果を返す、と本文の行が定めている。'
const CLAIM = '空の入力の扱いが、使う側の節に書かれていない'
const ledgerFile = (state) => path.join(state, 'ledger.json')
const ledger = (state) => JSON.parse(readFileSync(ledgerFile(state), 'utf8'))

// 台帳を作る。返す a・b は資産の id に当たる文字列（指摘の id の最初の `|` の前）。
function setup(t, phase = null) {
  const d = tmp(t)
  for (const n of ['a.md', 'b.md']) writeFileSync(path.join(d, n), `# ${n}\n\n${QUOTE}\n二行目も本文の行として十分な長さの文を置く。\n`)
  writeFileSync(path.join(d, 'goal.md'), '- G1: 対象の文書の見落としを観点ごとに確かめた指摘の一覧\n')
  writeFileSync(path.join(d, 'request.md'), '対象の文書を観点ごとにレビューして、確かめた指摘を返してほしい')
  const state = path.join(d, 'state')
  const r = cli('init', '--state', state, '--goal', path.join(d, 'goal.md'), '--request', path.join(d, 'request.md'),
    '--target', path.join(d, 'a.md'), '--target', path.join(d, 'b.md'), '--goal-checked', 'coverage-build', ...(phase ? ['--phase', phase] : []))
  assert.equal(r.code, 0, JSON.stringify(r))
  // 資産は next が作るので、ここでは指摘の id の前半に使う文字列だけを置く（status は資産の id を指摘の id から取る）。
  return { state, a: `${path.join(d, 'a.md')}#s1`, b: `${path.join(d, 'b.md')}#s1` }
}

// 指摘 1 件。cell は `資産|観点|周`、id は `cell#hash`。
const finding = (cell, over = {}) => ({
  cell, cycle: 1, claim: CLAIM, quote: QUOTE, severity: 'MEDIUM', layer: '設計', verdict: 'confirmed', verdict_reason: '本文で確かめた', status: 'current', ...over,
})
// fs: [[id, 指摘], …]、groups: 群（id・keys など）。群は事実から導いた束ねの群の写し（L.groups）で、反証の状態は持たない。
function put(state, fs, groups = []) {
  const L = ledger(state)
  for (const [id, f] of fs) L.findings[id] = f
  for (const g of groups) L.groups.push({ cycle: 1, root_cause: '空の入力の扱いを使う側が書いていない', layer: '設計', ...g })
  writeFileSync(ledgerFile(state), JSON.stringify(L, null, 1))
}
const status = (state) => {
  const s = cli('status', '--state', state)
  assert.equal(s.code ?? 0, 0, JSON.stringify(s))
  return s
}
const confirmedIds = (s) => s.findings.confirmed.map((f) => f.ids)

test('P7-1: 資産・norm した quote と claim・layer が同じ確定指摘は、観点が違っても 1 件にまとまる', (t) => {
  const { state, a } = setup(t)
  put(state, [
    [`${a}|L1|p1#aaaa000001`, finding(`${a}|L1|p1`)],
    [`${a}|L2|p1#aaaa000002`, finding(`${a}|L2|p1`)],
    [`${a}|L3|p1#aaaa000003`, finding(`${a}|L3|p1`)],
  ])
  const s = status(state)
  assert.equal(s.findings.confirmed.length, 1, JSON.stringify(s.findings.confirmed))
  assert.deepEqual(s.findings.confirmed[0].ids, [`${a}|L1|p1#aaaa000001`, `${a}|L2|p1#aaaa000002`, `${a}|L3|p1#aaaa000003`])
})

test('P7-1: 空白の数・改行・前後の空白だけが違う quote・claim は同じ（C.norm した値で照らす）', (t) => {
  const { state, a } = setup(t)
  const q = 'when the input is empty the result is empty'
  const c = 'the empty input case is not written in the using section'
  put(state, [
    [`${a}|L1|p1#aaaa000001`, finding(`${a}|L1|p1`, { quote: q, claim: c })],
    [`${a}|L2|p1#aaaa000002`, finding(`${a}|L2|p1`, { quote: `  when the   input is empty\nthe result is empty\n`, claim: `${c.replace('empty input', 'empty  input')} ` })],
  ])
  const s = status(state)
  assert.equal(s.findings.confirmed.length, 1, JSON.stringify(s.findings.confirmed))
  assert.equal(s.findings.confirmed[0].ids.length, 2)
})

test('P7-1: layer が違えば、資産・quote・claim が同じでもまとめない', (t) => {
  const { state, a } = setup(t)
  put(state, [
    [`${a}|L1|p1#aaaa000001`, finding(`${a}|L1|p1`, { layer: '設計' })],
    [`${a}|L2|p1#aaaa000002`, finding(`${a}|L2|p1`, { layer: '実装' })],
  ])
  const s = status(state)
  assert.equal(s.findings.confirmed.length, 2, JSON.stringify(s.findings.confirmed))
  assert.deepEqual(s.findings.confirmed.map((f) => f.layer).sort(), ['実装', '設計'])
})

test('P7-5: 資産が違う指摘、quote が違う指摘、claim が違う指摘はまとめない', (t) => {
  const { state, a, b } = setup(t)
  put(state, [
    [`${a}|L1|p1#aaaa000001`, finding(`${a}|L1|p1`)],
    [`${b}|L1|p1#bbbb000001`, finding(`${b}|L1|p1`)],
    [`${a}|L2|p1#aaaa000002`, finding(`${a}|L2|p1`, { quote: `${QUOTE}（別の行）` })],
    [`${a}|L3|p1#aaaa000003`, finding(`${a}|L3|p1`, { claim: `${CLAIM}（別の主張）` })],
  ])
  const s = status(state)
  assert.equal(s.findings.confirmed.length, 4, JSON.stringify(s.findings.confirmed))
})

test('P7-2: まとめた 1 件の id は最初の指摘の id、severity も最初のもの。全ての id が ids に入る', (t) => {
  const { state, a } = setup(t)
  put(state, [
    [`${a}|L1|p1#aaaa000001`, finding(`${a}|L1|p1`, { severity: 'HIGH' })],
    [`${a}|L2|p1#aaaa000002`, finding(`${a}|L2|p1`, { severity: 'LOW' })],
  ])
  const [f] = status(state).findings.confirmed
  assert.equal(f.id, `${a}|L1|p1#aaaa000001`)
  assert.equal(f.severity, 'HIGH')
  assert.deepEqual(f.ids, [`${a}|L1|p1#aaaa000001`, `${a}|L2|p1#aaaa000002`])
})

test('P7-2: まとまらない 1 件も ids（配列）を持ち、中身は自分の id だけ', (t) => {
  const { state, a } = setup(t)
  put(state, [[`${a}|L1|p1#aaaa000001`, finding(`${a}|L1|p1`)]])
  const [f] = status(state).findings.confirmed
  assert.deepEqual(f.ids, [f.id])
  assert.equal(f.id, `${a}|L1|p1#aaaa000001`)
})

test('P7-1: 検証できなかった指摘（unverifiable）も、同じ組ならまとめて ids を持つ。layer が違えばまとめない', (t) => {
  const { state, a } = setup(t)
  put(state, [
    [`${a}|L1|p1#aaaa000001`, finding(`${a}|L1|p1`, { verdict: 'unverifiable' })],
    [`${a}|L2|p1#aaaa000002`, finding(`${a}|L2|p1`, { verdict: 'unverifiable' })],
    [`${a}|L3|p1#aaaa000003`, finding(`${a}|L3|p1`, { verdict: 'unverifiable', layer: '実装' })],
  ])
  const u = status(state).findings.unverifiable
  assert.equal(u.length, 2, JSON.stringify(u))
  assert.deepEqual(u[0].ids, [`${a}|L1|p1#aaaa000001`, `${a}|L2|p1#aaaa000002`])
  assert.equal(u[0].id, `${a}|L1|p1#aaaa000001`)
  assert.deepEqual(u[1].ids, [`${a}|L3|p1#aaaa000003`])
})

test('P7-1: 確定と検証できなかったは別の一覧で、互いにまとめない', (t) => {
  const { state, a } = setup(t)
  put(state, [
    [`${a}|L1|p1#aaaa000001`, finding(`${a}|L1|p1`)],
    [`${a}|L2|p1#aaaa000002`, finding(`${a}|L2|p1`, { verdict: 'unverifiable' })],
  ])
  const s = status(state)
  assert.equal(s.findings.confirmed.length, 1)
  assert.equal(s.findings.unverifiable.length, 1)
})

test('P7-4: by_verdict と by_layer は、まとめた後の件数を数える', (t) => {
  const { state, a, b } = setup(t)
  put(state, [
    // 設計層の確定 3 件が 1 件にまとまる。
    [`${a}|L1|p1#aaaa000001`, finding(`${a}|L1|p1`)],
    [`${a}|L2|p1#aaaa000002`, finding(`${a}|L2|p1`)],
    [`${a}|L3|p1#aaaa000003`, finding(`${a}|L3|p1`)],
    // 実装層の確定 1 件（別の資産）。
    [`${b}|L1|p1#bbbb000001`, finding(`${b}|L1|p1`, { layer: '実装' })],
    // 検証できなかった 2 件が 1 件にまとまる（設計層）。
    [`${a}|L4|p1#aaaa000004`, finding(`${a}|L4|p1`, { verdict: 'unverifiable', claim: '別の主張で確かめられない' })],
    [`${a}|L5|p1#aaaa000005`, finding(`${a}|L5|p1`, { verdict: 'unverifiable', claim: '別の主張で確かめられない' })],
  ])
  const s = status(state)
  assert.equal(s.findings.by_verdict.confirmed, 2, JSON.stringify(s.findings.by_verdict))
  assert.equal(s.findings.by_verdict.unverifiable, 1, JSON.stringify(s.findings.by_verdict))
  assert.equal(s.findings.by_layer['設計'], 2, JSON.stringify(s.findings.by_layer))
  assert.equal(s.findings.by_layer['実装'], 1, JSON.stringify(s.findings.by_layer))
})

test('P7-1: 今の段の指摘（status が current）だけを数える。古い指摘はまとめにも ids にも入らない', (t) => {
  const { state, a } = setup(t)
  put(state, [
    [`${a}|L1|p1#aaaa000001`, finding(`${a}|L1|p1`)],
    [`${a}|L2|p1#aaaa000002`, finding(`${a}|L2|p1`, { status: 'stale' })],
  ])
  const [f] = status(state).findings.confirmed
  assert.deepEqual(f.ids, [`${a}|L1|p1#aaaa000001`])
})

test('P7-3: 確定指摘の各件は、ids のどれかを keys に含む群の id を groups に持つ（束ねに反証は無いので、群は全て載る）', (t) => {
  const { state, a, b } = setup(t)
  const [i1, i2, i3] = [`${a}|L1|p1#aaaa000001`, `${a}|L2|p1#aaaa000002`, `${a}|L3|p1#aaaa000003`]
  const j1 = `${b}|L1|p1#bbbb000001`
  put(state, [
    [i1, finding(`${a}|L1|p1`)], [i2, finding(`${a}|L2|p1`)], [i3, finding(`${a}|L3|p1`, { claim: '別の主張を持つ別の指摘' })],
    [j1, finding(`${b}|L1|p1`)],
  ], [
    // i2（まとめた件の 2 番目の id）だけを keys に持つ群も、その件に載る。
    { id: 'G1-g1', keys: [i2, i3] },
    { id: 'G1-g3', keys: [i1] },
  ])
  const s = status(state)
  const byFirst = Object.fromEntries(s.findings.confirmed.map((f) => [f.id, f]))
  assert.deepEqual([...byFirst[i1].groups].sort(), ['G1-g1', 'G1-g3'], JSON.stringify(byFirst[i1]))
  assert.ok(s.groups.every((g) => !('status' in g) && !('extends' in g) && !('lateral' in g)), '群は反証の状態・横展開の欄を持たない')
  assert.deepEqual(byFirst[i3].groups, ['G1-g1'])
  assert.deepEqual(byFirst[j1].groups, [], '群に含まれない指摘は空の配列')
})

test('P7-3: 群の keys が、まとめた件の複数の id を含んでも、その群の id は 1 回だけ載る（重なりを除く）', (t) => {
  const { state, a } = setup(t)
  const [i1, i2] = [`${a}|L1|p1#aaaa000001`, `${a}|L2|p1#aaaa000002`]
  put(state, [[i1, finding(`${a}|L1|p1`)], [i2, finding(`${a}|L2|p1`)]],
    [{ id: 'G1-g1', keys: [i1, i2] }, { id: 'G1-g2', keys: [i2] }])
  const [f] = status(state).findings.confirmed
  assert.deepEqual([...f.groups].sort(), ['G1-g1', 'G1-g2'])
})

test('P7-3: groups の id は status の groups の id のまま', (t) => {
  const { state, a } = setup(t)
  const i1 = `${a}|L1|p1#aaaa000001`
  put(state, [[i1, finding(`${a}|L1|p1`)]], [{ id: 'G2-g7', keys: [i1] }])
  const s = status(state)
  assert.ok(s.groups.some((g) => g.id === 'G2-g7'))
  assert.deepEqual(s.findings.confirmed[0].groups, ['G2-g7'])
})

test('P7-3: 群が 1 つも無ければ、各件の groups は空の配列', (t) => {
  const { state, a } = setup(t)
  put(state, [[`${a}|L1|p1#aaaa000001`, finding(`${a}|L1|p1`)]])
  assert.deepEqual(status(state).findings.confirmed[0].groups, [])
})

test('P7: phases の今の段の findings も、上の階層の findings と同じ形（ids・groups を持つ）', (t) => {
  const { state, a } = setup(t, 'design')
  const i1 = `${a}|L1|p1#aaaa000001`
  put(state, [[i1, finding(`${a}|L1|p1`)], [`${a}|L2|p1#aaaa000002`, finding(`${a}|L2|p1`)]], [{ id: 'G1-g1', keys: [i1] }])
  const s = status(state)
  assert.equal(s.phase, ledger(state).phase)
  assert.deepEqual(s.phases[s.phase].findings, s.findings)
})
