// 単位 4・5 の実装レビュー（HIGH）の回帰テスト。設計 docs/design/coverage-ledger-method.md の次の決定を確かめる。
// - H1「段の構成」: ファイルの段は 1 単位に 1 体（1 つの呼び出しで 1 worker に 1 単位だけ。起動数は未読の単位の数、上限は maxAgents と予算）。
// - H2「全体の段と確認」: 目標の判定の意図は、義務に結ばれた事実が無くても、単位の索引と載せなかった事実の id から判定できる。
// - H3「観点の定義と持ち主」: 観点は呼ぶ側・仕組みの標準（通読）・計画役の提案の和。観点を渡しても計画役は提案として流れる。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { behave, claimedTasks, cli, drive, project, status, unitLines, usable } from './blackboard-fixture.mjs'
import { planAct } from './plan-roles.mjs'

const ledgerOf = (state) => JSON.parse(readFileSync(path.join(state, 'ledger.json'), 'utf8'))
const THREE = {
  'a.md': '# A\n\nこの文書は台帳の lock を取ってから書き込むことを保証する。\n',
  'b.md': '# B\n\nこの文書は lock が書き込みを直列にすることを前提にする。\n',
  'c.md': '# C\n\nこの文書は三つ目の単位として置く本文の行である。\n',
}

// ---------------- H1 ----------------
test('H1: ファイルの段は 1 つの呼び出しで 1 worker に 1 単位だけを渡し、起動数は未読の単位の数（workers の設定に縛られない）', async (t) => {
  const { state } = project(t, THREE)
  assert.equal(cli('config', '--state', state, '--workers', '1').code, 0)
  const { stop, calls } = await drive(state, behave())
  assert.equal(stop.stop, 'complete', JSON.stringify(stop))
  const files = calls.filter((c) => c.args.stage === 'file')
  assert.equal(files.length, 1, '3 単位を 1 回の呼び出しで読む')
  assert.equal(files[0].args.workers.length, 3, '起動数は未読の単位の数')
  const per = new Map()
  for (const task of claimedTasks(files).filter((x) => x.kind === 'file')) per.set(task.worker, new Set([...(per.get(task.worker) || []), task.id]))
  assert.ok([...per.values()].every((s) => s.size === 1), `1 worker が 2 つ以上の単位を読んだ: ${JSON.stringify([...per].map(([w, s]) => [w, [...s]]))}`)
})

test('H1: ファイルの段の起動数は残りの予算（max-agents-total）に収め、残りの単位は次の呼び出しに回す', async (t) => {
  const { state } = project(t, THREE)
  // 計画の段（計画役 2 体・統合・観点の検証）を済ませる（4 体）。
  const { calls } = await drive(state, planAct(), { maxSteps: 3 })
  assert.deepEqual(calls.map((c) => c.args.stage), ['plan', 'integrate', 'unit_verify'])
  assert.equal(cli('config', '--state', state, '--max-agents-total', '6').code, 0)
  const n = cli('next', '--state', state)
  assert.equal(n.step, 'file', JSON.stringify(n))
  assert.equal(n.estimate_agents, 2, '見積もりは残りの予算（6 - 4）に収めた起動数')
  assert.equal(JSON.parse(readFileSync(n.args_path, 'utf8')).workers.length, 2)
})

// ---------------- H2 ----------------
// 本物の役と同じく、claim と query の出力だけから目標を判定する偽物。義務に結ばれた事実が無いときは、
// 載せなかった事実の id（omitted_ids）を --fact で引き直して支えにし、単位の索引（units）の写しを開いて引用する。
function goalFromLedger(task, ctx) {
  const q = ctx.query(task)
  const facts = [...(q.basis || []), ...(q.related || [])]
  if (facts.length) return { verdict: 'supported', support: [facts[0].id], quote: facts[0].quote }
  assert.ok(Array.isArray(q.omitted_ids), `query は載せなかった事実の id を返す: ${JSON.stringify(q)}`)
  assert.ok(Array.isArray(q.units) && q.units.length, `query は単位の索引を返す: ${JSON.stringify(q)}`)
  const u = q.units[0]
  const quote = unitLines(u).find(usable)
  if (task.intent.item === 'G2') {
    return { verdict: 'gap', quote, findings: [{ claim: '目標の抜け', locations: [{ unit: u.id, quote }], obligation: 'G2', confidence: 'high', severity: 'HIGH', layer: '実装' }] }
  }
  const more = ctx.query(task, q.omitted_ids.slice(0, 1))
  return { verdict: 'supported', support: more.facts.map((f) => f.id), quote: more.facts[0].quote }
}

test('H2: 保証が義務に結ばれていなくても、目標の判定の意図は単位の索引と載せなかった事実の id から supported か gap で閉じる（判定できない意図にならない）', async (t) => {
  const { state } = project(t, THREE)
  const facts = (p, lines) => ({ bind: false, guarantees: [{ subject: `${path.basename(p)} の主張`, quote: lines.find(usable), confidence: 'high' }] })
  const { stop } = await drive(state, behave({ facts, goal: goalFromLedger }))
  assert.equal(stop.stop, 'complete', JSON.stringify(stop))
  const s = status(state)
  const goals = s.intents.filter((i) => i.kind === 'goal')
  assert.equal(goals.length, 3)
  assert.ok(goals.every((i) => i.state === 'closed'), `目標の判定の意図が閉じない: ${JSON.stringify(goals)}`)
  assert.deepEqual(s.undecided, [])
  assert.ok(s.findings.confirmed.some((f) => f.claim === '目標の抜け'), 'gap の指摘は場所（単位と引用）を持って確定する')
})

test('H2: 目標の判定の意図の claim の担当は単位の索引を持ち、query の omitted は件数と引き直せる id の両方', async (t) => {
  const { state } = project(t, THREE)
  const facts = () => ({ bind: false, guarantees: [] })
  const seen = []
  const goal = (task, ctx) => { seen.push({ task, q: ctx.query(task) }); return null }
  await drive(state, behave({ facts: (p, lines) => ({ ...facts(), guarantees: [{ subject: 's', quote: lines.find(usable), confidence: 'high' }] }), goal }), { maxSteps: 4 })
  assert.ok(seen.length > 0)
  for (const { task, q } of seen) {
    assert.ok(Array.isArray(task.units) && task.units.every((u) => u.id && u.file && u.start && u.end && u.path), `担当の units: ${JSON.stringify(task.units)}`)
    assert.equal(q.omitted, q.omitted_ids.length + (q.omitted_more || 0), 'omitted は件数で、id は omitted_ids に（上限を超えた分は omitted_more で宣言）')
  }
})

// ---------------- H3 ----------------
test('H3: 観点を渡しても、仕組みの標準の観点（通読）を常に和に入れ、計画役は足す観点の提案として流れる', async (t) => {
  const { state } = project(t, THREE)
  const L0 = ledgerOf(state)
  const std = L0.lenses.filter((l) => l.origin === 'standard')
  assert.equal(std.length, 1, `仕組みの標準の観点が 1 つ: ${JSON.stringify(L0.lenses.map((l) => [l.id, l.origin]))}`)
  const given = []
  const act = planAct({
    plan: (q) => { given.push(q.given_lenses); return undefined },
    integrate: (q) => undefined,
  })
  const { stop, calls } = await drive(state, act)
  assert.equal(stop.stop, 'complete', JSON.stringify(stop))
  assert.ok(calls.some((c) => c.args.stage === 'plan'), '観点を渡しても計画役が流れる')
  assert.ok(given.length && given.every((g) => Array.isArray(g) && g.some((l) => l.id === 'L1') && g.some((l) => l.id === std[0].id)), `計画役は既にある観点（呼ぶ側・標準）を引く: ${JSON.stringify(given)}`)
  const fileLenses = claimedTasks(calls).filter((x) => x.kind === 'file').map((x) => x.lenses.map((l) => l.id).sort())
  assert.ok(fileLenses.length && fileLenses.every((ids) => ids.includes('L1') && ids.includes(std[0].id) && ids.includes('X1')), `ファイルの段の観点は 3 者の和: ${JSON.stringify(fileLenses)}`)
})

test('H3: 観点を渡したときの計画役の提案が出なくても（返らない・照合に落ちる）、呼ぶ側と標準の観点で読み進め、提案が無かったことを開示する', async (t) => {
  const { state } = project(t, THREE)
  const { stop, calls } = await drive(state, behave())
  assert.equal(stop.stop, 'complete', JSON.stringify(stop))
  assert.ok(calls.some((c) => c.args.stage === 'plan'))
  assert.ok(ledgerOf(state).events.some((e) => e.kind === 'plan_skipped'), '計画役の提案が無かったことを出来事に残す')
  const fileLenses = claimedTasks(calls).filter((x) => x.kind === 'file').map((x) => x.lenses.map((l) => l.id))
  assert.ok(fileLenses.every((ids) => ids.includes('L1') && ids.length === 2), JSON.stringify(fileLenses))
})
