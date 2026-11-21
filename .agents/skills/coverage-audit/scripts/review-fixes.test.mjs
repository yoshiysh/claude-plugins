// 単位 1〜3 の実装レビュー（HIGH）の回帰テスト。台帳の事実を直接組んで board（ledger-core）の導出を確かめ、照合は CLI の流れで確かめる。
// H1 ファイルの段の指摘の確定の経路（横展開をやめた後も、指摘の判定の 1 つだけ）、H2 落とした指摘の確認が検証不能のとき、H3 前提が満たされていない判定の持ち越し、H4 確定した指摘の原因の層。
import test from 'node:test'
import assert from 'node:assert/strict'
import { board, newLedger, readsSig } from './ledger-core.mjs'
import { behave, cli, drive, project, status } from './blackboard-fixture.mjs'

const PH = 1
function mk() {
  const L = newLedger({ goal: 'g', goalItems: [{ id: 'G1', text: 'x' }], request: 'r', criteria: [], constraints: [], targets: [], lenses: [{ id: 'L1', name: 'n', procedure: 'p' }], config: {}, roles: {} })
  for (const u of ['a', 'b', 'c']) L.assets[u] = { path: u, state: 'seen', read: { id: `R${u}` }, start: 1, end: 1, hash: 'h' }
  return L
}
const judge = (L, it, verdict, extra = {}) => L.facts.push({ id: `J${L.facts.length}`, type: 'judgment', intent: it.id, kind: it.kind, key: it.key, phase: PH, verdict, added: [], ...extra })
// ファイルの段が指摘 FF（重い指摘）を書いた台帳。
function fileLedger() {
  const L = mk()
  L.facts.push({ id: 'FF', type: 'finding', origin: 'file', unit: 'b', path: 'b', read: 'Rb', claim: 'c', quote: 'q', obligation: 'G1', layer: '実装', confidence: 'high', severity: 'HIGH', lens: 'L1' })
  return L
}

test('H1 ファイルの段の指摘: 確定に至る経路は指摘の判定の 1 つだけで、added の確認にかけない。落とした後の確認の disagree だけが復活させ、agree なら落ちたまま', () => {
  for (const [confirmVerdict, kept] of [['disagree', true], ['agree', false]]) {
    const L = fileLedger()
    let B = board(L)
    assert.ok(!B.intents.some((i) => i.kind === 'confirm' && i.mode === 'added'), 'ファイルの段の指摘を added の確認にかけない')
    const fi = B.intents.find((i) => i.kind === 'finding' && i.basis[0] === 'FF')
    assert.ok(fi, 'ファイルの段の指摘は指摘の判定にかける')
    judge(L, fi, 'drop')
    B = board(L)
    const ci = B.intents.find((i) => i.kind === 'confirm' && i.target === 'FF')
    assert.equal(ci.mode, 'dropped')
    judge(L, ci, confirmVerdict)
    B = board(L)
    assert.equal(B.findings.list.some((f) => f.id === 'FF' && f.verdict === 'confirmed'), kept, `落とした後の確認が ${confirmVerdict}`)
  }
  // 残す判定なら確定し、同じ対象に added の確認の意図が別にできて逆に読まれることは無い。確認の意図が無いので、次は束ねの意図だけが開く。
  const L = fileLedger()
  judge(L, board(L).intents.find((i) => i.kind === 'finding'), 'keep')
  let B = board(L)
  assert.ok(B.findings.list.some((f) => f.id === 'FF' && f.verdict === 'confirmed'))
  assert.ok(!B.intents.some((i) => i.kind === 'confirm'))
  assert.ok(!B.intents.some((i) => i.kind === 'group'), '開いた意図（目標の判定）がある間は束ねの意図を作らない')
  judge(L, B.intents.find((i) => i.kind === 'goal'), 'supported', { support: ['FF'] })
  B = board(L)
  assert.deepEqual(B.intents.filter((i) => i.state === 'open').map((i) => [i.kind, i.basis]), [['group', ['FF']]], 'ほかの意図が全て閉じたら束ねの意図が開き、根拠は確定した指摘')
})

test('H2 落とした指摘の確認が検証不能（逐語でない引用）なら、黙って消さず検証不能の指摘として出す', () => {
  const L = mk()
  L.facts.push({ id: 'FA', type: 'finding', origin: 'file', unit: 'a', path: 'a', read: 'Ra', claim: 'c', quote: 'q', obligation: 'G1', layer: '実装', confidence: 'high', severity: 'HIGH', lens: 'L1' })
  judge(L, board(L).intents.find((i) => i.kind === 'finding'), 'drop')
  judge(L, board(L).intents.find((i) => i.kind === 'confirm'), 'unverifiable')
  const B = board(L)
  assert.deepEqual(B.findings.list.map((f) => [f.id, f.verdict]), [['FA', 'unverifiable']])
})

test('H2 流れ: 落とした重い指摘の確認の引用が逐語で無ければ、complete にせず needs_input の unverifiable で開示する', async (t) => {
  const Q = 'この文書は落とされる指摘の根拠になる本文の行である。'
  const { state } = project(t, { 'a.md': `# A\n\n## 節\n${Q}\n` })
  const act = behave({
    facts: () => ({ findings: [{ claim: '落とされる指摘', quote: Q, severity: 'HIGH' }] }),
    finding: (task, ctx) => (ctx.query(task).basis.some((f) => f.claim === '落とされる指摘') ? { verdict: 'drop', reason: '全体の文脈では問題にならない', quote: Q } : undefined),
    confirm: () => ({ verdict: 'disagree', reason: '本文で確かめた', quote: 'どの単位の本文にも無い確認の引用の文である' }),
  })
  const { stop } = await drive(state, act)
  assert.equal(stop.stop, 'needs_input', JSON.stringify(stop))
  assert.equal(stop.unverifiable.length, 1)
  assert.ok(status(state).findings.unverifiable.some((f) => f.id === stop.unverifiable[0]))
})

test('H3 前提が満たされていない判定は、関わらない単位の読みが変わっても開き直す（無いことの判定）。満たされている判定は開き直さない', () => {
  for (const [verdict, reopened] of [['unsatisfied', true], ['satisfied', false]]) {
    const L = mk()
    L.facts.push({ id: 'P', type: 'premise', origin: 'file', unit: 'a', path: 'a', read: 'Ra', subject: 'lock', quote: 'q' })
    L.facts.push({ id: 'G', type: 'guarantee', origin: 'file', unit: 'b', path: 'b', read: 'Rb', subject: 'lock', quote: 'q' })
    const pi = board(L).intents.find((i) => i.kind === 'premise')
    judge(L, pi, verdict, verdict === 'unsatisfied' ? { reads: readsSig(L) } : {})
    assert.equal(board(L).byId.get(pi.id).state, 'closed')
    L.assets.c.read = { id: 'Rc2' }
    assert.equal(board(L).byId.get(pi.id).state, reopened ? 'open' : 'closed', verdict)
  }
})

test('H4 確定した指摘は原因の層を必ず持つ: 層の無い指摘を残す判定・不正な層の判定では確定にしない（board）', () => {
  for (const layer of [undefined, 'bogus']) {
    const L = mk()
    L.static = [{ id: 'S1', type: 'static', unit: 'a', path: 'a', quote: 'q', claim: 'c', origin: 'static' }]
    judge(L, board(L).intents.find((i) => i.kind === 'finding'), 'keep', { obligation: 'G1', ...(layer ? { layer } : {}) })
    const B = board(L)
    assert.deepEqual(B.findings.list, [], `layer=${layer} では確定しない`)
    assert.ok(B.findings.references.some((r) => r.id === 'S1'), '参考として開示する')
  }
})

test('H4 照合: 指摘の判定の layer は閉じた集合で照らし、層の無い静的な検査の事実を残す判定は layer を必須にする。付ければ確定する（origin: static）', async (t) => {
  const D1 = 'U1 は入力を受け取る単位の定義の本文である。'
  const R = 'この節は U1〜U2 の全てを満たすことを求める本文である。'
  for (const [layer, ok] of [[undefined, false], ['bogus', false], ['詳細設計', true]]) {
    const { state } = project(t, { 'def.md': `# 定義\n\n## U1\n${D1}\n`, 'ref.md': `# 参照\n\n## 範囲\n${R}\n` }, { link: 'U\\d+' })
    const finding = (task, ctx) => (ctx.query(task).basis.some((f) => f.type === 'static') ? { verdict: 'keep', reason: '範囲の参照が実在しない id を含む', quote: R, obligation: 'G1', ...(layer ? { layer } : {}) } : undefined)
    const { stop, calls } = await drive(state, behave({ finding }))
    assert.equal(stop.stop, 'complete', JSON.stringify(stop))
    const rejected = calls.flatMap((c) => c.workers.flatMap((w) => w.submits.flatMap((s) => s.out.results || []))).filter((r) => r.ok === false && r.problems.some((p) => /layer/.test(p)))
    assert.equal(rejected.length > 0, !ok, `layer=${layer}: 拒否`)
    const c = status(state).findings.confirmed.find((f) => f.origin === 'static')
    assert.equal(!!c, ok, `layer=${layer}: 確定`)
    if (c) assert.equal(c.layer, '詳細設計')
  }
  assert.ok(cli)
})
