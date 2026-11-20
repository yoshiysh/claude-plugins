// スキルの観点（purpose・layer）を台帳に固定で入れず、要るときだけ計画役に計画の観点として切らせる振る舞い。
// 期待は単位の指示（スキルの観点を計画役に切らせる）の「決まった振る舞い」1〜5 から取る。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { C } from './ledger-core.mjs'
import { cli, constraintIdsOf, drive, goalsOf, indexIds, mockAgent, tmp } from './test-harness.mjs'

const DOC = `# 対象の文書

## 一つ目の節
この節は一つ目の主張を述べる本文の行である。
二行目もこの節の主張を補う本文の行として置く。

## 二つ目の節
この節は二つ目の主張を述べる本文の行である。
二行目もこの節の主張を補う本文の行として置く。
`
const L1 = { id: 'L1', name: '主張と根拠', procedure: '主張ごとに根拠の文を対応づけ、根拠の無い主張を探す' }
const L2 = { id: 'L2', name: '用語の一貫', procedure: '用語ごとに使われ方を並べ、意味の揺れを探す' }
const ledger = (state) => JSON.parse(readFileSync(path.join(state, 'ledger.json'), 'utf8'))
const targetIds = (L) => Object.keys(L.assets).filter((id) => !L.assets[id].retro)
const liveCells = (L) => Object.values(L.cells).filter((c) => c.status !== 'gone')

// lenses を渡すと利用者の観点の経路（計画を作らない）、渡さないと計画の経路。criteria を渡すと受け入れ基準を足す。
function setup(t, { lenses = null, criteria = [] } = {}) {
  const d = tmp(t)
  writeFileSync(path.join(d, 'doc.md'), DOC)
  writeFileSync(path.join(d, 'goal.md'), '- G1: 対象の文書の見落としを確かめた指摘の一覧 〔request: 対象の文書をレビューしてほしい〕\n')
  writeFileSync(path.join(d, 'request.md'), '対象の文書をレビューしてほしい')
  const extra = []
  if (lenses) {
    writeFileSync(path.join(d, 'lenses.json'), JSON.stringify(lenses))
    extra.push('--lenses', path.join(d, 'lenses.json'))
  }
  if (criteria.length) {
    writeFileSync(path.join(d, 'criteria.md'), criteria.map((c) => `- ${c} 〔request: 対象の文書をレビューしてほしい〕\n`).join(''))
    extra.push('--criteria', path.join(d, 'criteria.md'))
  }
  const state = path.join(d, 'state')
  const r = cli('init', '--state', state, '--goal', path.join(d, 'goal.md'), '--request', path.join(d, 'request.md'), '--target', path.join(d, 'doc.md'), ...extra)
  assert.equal(r.code, 0, JSON.stringify(r))
  return { d, state }
}

// ---------------- 1. init の観点 ----------------
test('1. init: 台帳の観点に purpose・layer を固定で入れず、利用者の観点と振り返りの観点 R1〜R4 だけを持つ', (t) => {
  const given = ledger(setup(t, { lenses: [L1, L2] }).state)
  assert.ok(!given.lenses.some((l) => ['purpose', 'layer'].includes(l.id)), `purpose・layer が無い: ${JSON.stringify(given.lenses.map((l) => l.id))}`)
  assert.deepEqual(given.lenses.filter((l) => !l.retro).map((l) => [l.id, l.origin]), [['L1', 'user'], ['L2', 'user']], '振り返りの外は利用者の観点だけ')
  assert.deepEqual(given.lenses.filter((l) => l.retro).map((l) => l.id), ['R1', 'R2', 'R3', 'R4'], '振り返りの観点 R1〜R4 は残す')
  assert.ok(given.lenses.filter((l) => l.origin === 'skill').every((l) => l.retro), 'origin skill の観点は振り返りの観点だけ')
  const planned = ledger(setup(t).state)
  assert.deepEqual(planned.lenses.filter((l) => !l.retro), [], '計画の経路では、計画の前の台帳に振り返りの外の観点が無い')
  assert.deepEqual(planned.lenses.filter((l) => l.retro).map((l) => l.id), ['R1', 'R2', 'R3', 'R4'])
})

// ---------------- 2. 計画役・統合役の説明 ----------------
test('2. 計画役 A・B と統合役の説明: purpose・layer はスキルが持つので作らない旨の文が無く、目的と層の見方は要るときだけ計画の観点として切る旨がある', async (t) => {
  const { state } = setup(t)
  const log = []
  const { stop } = await drive(state, mockAgent({}, log))
  assert.equal(stop.stop, 'complete', JSON.stringify(stop))
  for (const label of ['plan-A', 'plan-B', 'integrate']) {
    const x = log.find((e) => e.label === label)
    assert.ok(x, `${label} が起動される`)
    const p = x.raw
    for (const old of ['はスキルが持ち', '全ての資産に当たるので作らない', 'purpose・layer を含めどの観点でも読まず']) assert.ok(!p.includes(old), `${label} の説明に古い文「${old}」が無い`)
    // 趣旨だけを照らす: 目的と層の見方を、要るときだけ計画の観点として切る（同じ行に書く）。
    const line = p.split('\n').find((l) => l.includes('計画の観点として切る'))
    assert.ok(line, `${label} の説明に「計画の観点として切る」旨がある`)
    assert.ok(line.includes('目的') && line.includes('層') && line.includes('だけ'), `${label}: 目的と層の見方を要るときだけ切る旨: ${line}`)
  }
})

// ---------------- 3. 計画が id purpose・layer の観点を返す ----------------
// 計画役・統合役が、観点 purpose を 1 つ目の資産に、layer を 2 つ目の資産に当てる計画を返す。どちらも全ての目標・基準を受け持つ。
const ID_PLAN = ['purpose', 'layer']
const idPlan = (p) => {
  const [a, b] = indexIds(p)
  const goals = goalsOf(p)
  const lenses = [
    { id: 'purpose', name: '目的と固定した制約', procedure: 'この部分の主張ごとに、固定した目標と制約のどれに効くかを対応づけてから、効かない主張を探す。', applies_to: [a], goals },
    { id: 'layer', name: '層と範囲', procedure: 'この部分の内容ごとに層を判定してから、対象の層より上の決め直しを探す。', applies_to: [b], goals },
  ]
  const src = p.includes('### 前の計画') ? ID_PLAN.map((id) => `P:${id}`) : [...p.matchAll(/^### ([AB])（/gm)].flatMap((m) => ID_PLAN.map((id) => `${m[1]}:${id}`))
  const defects = p.includes('### 欠陥（index') ? JSON.parse(p.split('### 欠陥（index は配列の位置）\n')[1].split('\n#')[0]) : []
  return {
    lenses, excluded: [], questions: [], constraint_map: constraintIdsOf(p).map((id) => ({ constraint_id: id, handled_by: ['purpose'] })),
    source_map: src.map((s) => ({ source: s, merged_into: s.split(':')[1], dropped_reason: '' })),
    defect_responses: defects.map((d) => ({ defect_index: d.index, action: 'fixed', reason: '直した' })),
  }
}

test('3. 静的な照合: 計画の観点の id が purpose・layer でも、constraint_map の受け皿が purpose でも拒否しない', () => {
  const goals = [{ id: 'G1', part: '見落とし' }]
  const lenses = [
    { id: 'purpose', name: '目的', procedure: '主張ごとに目標を対応づける', applies_to: ['a#1'], goals },
    { id: 'layer', name: '層', procedure: '内容ごとに層を判定する', applies_to: ['a#2'], goals },
  ]
  const ctx = { constraintIds: ['AC1'], lensesGiven: false, givenLensIds: [], assetIds: ['a#1', 'a#2'], goalItemIds: ['G1'] }
  assert.deepEqual(C.checkPlan({ lenses, excluded: [], questions: [], constraint_map: [{ constraint_id: 'AC1', handled_by: ['purpose'] }] }, ctx), [])
  // 計画に無い id を受け皿にすれば、purpose でも実在しない受け皿になる（予約の id として通さない）。
  const only = [{ ...lenses[1], applies_to: ['a#1', 'a#2'] }]
  assert.ok(C.checkPlan({ lenses: only, excluded: [], questions: [], constraint_map: [{ constraint_id: 'AC1', handled_by: ['purpose'] }] }, ctx).some((x) => x.includes('受け皿が実在しない: purpose')))
})

test('3. 計画が id purpose・layer の観点を返しても受け付け、ほかの計画の観点と同じく精査・閉じた問いを通り、当てた資産にだけ枡を作る', async (t) => {
  const { state } = setup(t, { criteria: ['AC1: 指摘ごとに本文の引用を付ける'] })
  const log = []
  const { stop } = await drive(state, mockAgent({ plan: idPlan, integrate: idPlan }, log))
  assert.equal(stop.stop, 'complete', JSON.stringify(stop))
  const L = ledger(state)
  assert.deepEqual(L.plan_defects, [], '計画の欠陥にしない')
  assert.deepEqual(L.lenses.filter((l) => !l.retro).map((l) => [l.id, l.origin]), [['purpose', 'plan'], ['layer', 'plan']], '計画の観点として台帳に入る')
  for (const id of ID_PLAN) {
    assert.ok(log.some((x) => x.label === `lens-review-${id}`), `${id} は観点の精査（N1・N2）を通る`)
    assert.ok(log.some((x) => x.label.startsWith(`verify-unit-${id}`)), `${id} は閉じた問い（Q1〜Q3）を通る`)
  }
  const [a, b] = targetIds(L)
  assert.deepEqual(liveCells(L).map((c) => [c.asset, c.lens]).sort(), [[a, 'purpose'], [b, 'layer']].sort(), '当てた組の枡だけを作る（全ての資産には当てない）')
})

// ---------------- 4. lenses.json の経路 ----------------
test('4. lenses.json の経路: 利用者の観点だけを全ての資産に当て、purpose・layer の枡を作らない', async (t) => {
  const { state } = setup(t, { lenses: [L1, L2] })
  const log = []
  const { stop } = await drive(state, mockAgent({}, log))
  assert.equal(stop.stop, 'complete', JSON.stringify(stop))
  const L = ledger(state)
  const assets = targetIds(L)
  assert.equal(assets.length, 2)
  const live = liveCells(L).filter((c) => !L.assets[c.asset].retro)
  assert.equal(live.length, assets.length * 2, '資産の数 × 利用者の観点の数 × k=1')
  assert.ok(live.every((c) => ['L1', 'L2'].includes(c.lens)), `利用者の観点の枡だけ: ${JSON.stringify([...new Set(live.map((c) => c.lens))])}`)
  for (const a of assets) for (const l of ['L1', 'L2']) assert.ok(live.some((c) => c.asset === a && c.lens === l), `${a} に ${l} の枡がある`)
  assert.ok(!log.some((x) => /\|(purpose|layer)\|/.test(x.label)), 'purpose・layer の枡を読まない')
})

// ---------------- 5. 古い台帳 ----------------
test('5. 古い台帳: origin skill で振り返りでない観点（purpose・layer）を持つ台帳は、形式が古いとして拒否し init からやり直させる', (t) => {
  const { state } = setup(t, { lenses: [L1] })
  // 境界: 新しく init した台帳（R1〜R4 は origin skill・retro）は受け付ける。
  const ok = cli('next', '--state', state)
  assert.equal(ok.code, 0, JSON.stringify(ok))
  const L = ledger(state)
  L.lenses = [
    { id: 'purpose', name: '目的と固定した制約', procedure: '主張ごとに目標を対応づける', origin: 'skill', version: 'x' },
    { id: 'layer', name: '層と範囲', procedure: '内容ごとに層を判定する', origin: 'skill', version: 'y' },
    ...L.lenses,
  ]
  writeFileSync(path.join(state, 'ledger.json'), JSON.stringify(L))
  const before = readFileSync(path.join(state, 'ledger.json'), 'utf8')
  for (const cmd of ['next', 'status']) {
    const r = cli(cmd, '--state', state)
    assert.equal(r.code, 2, `${cmd}: ${JSON.stringify(r)}`)
    assert.match(r.error, /台帳の形式が古い/, cmd)
    assert.match(r.error, /新しい stateDir で init からやり直す/, cmd)
  }
  assert.equal(readFileSync(path.join(state, 'ledger.json'), 'utf8'), before, '拒否した台帳を移行・変更しない')
})
// 境界: 計画の観点（origin plan）の id が purpose でも古い台帳としない。3 の drive が next・ingest で台帳を何度も読み、complete まで進むことで確かめる。
