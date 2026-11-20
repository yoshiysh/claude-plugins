// スキルの観点（purpose・layer）を台帳に固定で入れず、要るときだけ計画役に計画の観点として切らせる振る舞い。
// 期待は単位の指示（スキルの観点を計画役に切らせる）の「決まった振る舞い」1〜5 から取る。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { C } from './ledger-core.mjs'
import { cli, tmp } from './test-harness.mjs'
import { driveScript, scriptAgent } from './blackboard-fixture.mjs'
import { planAct } from './plan-roles.mjs'

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
test('1. init: 台帳の観点に purpose・layer を固定で入れず、利用者の観点・仕組みの標準の観点（通読 S1）・振り返りの観点 R1〜R4 だけを持つ', (t) => {
  const given = ledger(setup(t, { lenses: [L1, L2] }).state)
  assert.ok(!given.lenses.some((l) => ['purpose', 'layer'].includes(l.id)), `purpose・layer が無い: ${JSON.stringify(given.lenses.map((l) => l.id))}`)
  assert.deepEqual(given.lenses.filter((l) => !l.retro).map((l) => [l.id, l.origin]), [['L1', 'user'], ['L2', 'user'], ['S1', 'standard']], '振り返りの外は利用者の観点と標準の観点だけ')
  assert.deepEqual(given.lenses.filter((l) => l.retro).map((l) => l.id), ['R1', 'R2', 'R3', 'R4'], '振り返りの観点 R1〜R4 は残す')
  assert.ok(given.lenses.filter((l) => l.origin === 'skill').every((l) => l.retro), 'origin skill の観点は振り返りの観点だけ')
  const planned = ledger(setup(t).state)
  assert.deepEqual(planned.lenses.filter((l) => !l.retro).map((l) => [l.id, l.origin]), [['S1', 'standard']], '計画の経路では、計画の前の台帳に振り返りの外の観点は標準の観点だけ')
  assert.deepEqual(planned.lenses.filter((l) => l.retro).map((l) => l.id), ['R1', 'R2', 'R3', 'R4'])
})

// ---------------- 2. 計画役・統合役の説明 ----------------
test('2. 計画役 A・B と統合役の説明: purpose・layer はスキルが持つので作らない旨の文が無く、目的と層の見方は要るときだけ計画の観点として切る旨がある', async (t) => {
  const { state } = setup(t)
  const log = []
  const { stop } = await driveScript(state, scriptAgent(planAct(), log))
  assert.equal(stop.stop, 'complete', JSON.stringify(stop))
  // 役の label は <役の名前>-<worker の id>（Workflow script が workers の行から付ける）。
  for (const role of ['planner_a', 'planner_b', 'integrator']) {
    const x = log.find((e) => e.label.startsWith(`${role}-`))
    assert.ok(x, `${role} が起動される`)
    const p = x.prompt
    for (const old of ['はスキルが持ち', '全ての資産に当たるので作らない', 'purpose・layer を含めどの観点でも読まず']) assert.ok(!p.includes(old), `${role} の説明に古い文「${old}」が無い`)
    // 趣旨だけを照らす: 目的と層の見方を、要るときだけ計画の観点として切る（同じ行に書く）。
    const line = p.split('\n').find((l) => l.includes('計画の観点として切る'))
    assert.ok(line, `${role} の説明に「計画の観点として切る」旨がある`)
    assert.ok(line.includes('目的') && line.includes('層') && line.includes('だけ'), `${role}: 目的と層の見方を要るときだけ切る旨: ${line}`)
  }
})

// ---------------- 3. 計画が id purpose・layer の観点を返す ----------------
// 流れ（精査・閉じた問いを通り、ファイルの段に計画の観点として渡る）と 4. lenses.json の経路は ledger.test.mjs が台帳の上の役で確かめる。
test('3. 静的な照合: 計画の観点の id が purpose・layer でも、constraint_map の受け皿が purpose でも拒否しない', () => {
  const goals = [{ id: 'G1', part: '見落とし' }]
  const lenses = [
    { id: 'purpose', name: '目的', procedure: '主張ごとに目標を対応づける', goals },
    { id: 'layer', name: '層', procedure: '内容ごとに層を判定する', goals },
  ]
  const ctx = { constraintIds: ['AC1'], lensesGiven: false, givenLensIds: [], goalItemIds: ['G1'] }
  assert.deepEqual(C.checkPlan({ lenses, questions: [], constraint_map: [{ constraint_id: 'AC1', handled_by: ['purpose'] }] }, ctx), [])
  // 計画に無い id を受け皿にすれば、purpose でも実在しない受け皿になる（予約の id として通さない）。
  const only = [lenses[1]]
  assert.ok(C.checkPlan({ lenses: only, questions: [], constraint_map: [{ constraint_id: 'AC1', handled_by: ['purpose'] }] }, ctx).some((x) => x.includes('受け皿が実在しない: purpose')))
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
// 境界: 計画の観点（origin plan）の id が purpose でも古い台帳としない。ledger.test.mjs の purpose・layer の流れが next・ingest で台帳を何度も読み、complete まで進むことで確かめる。
