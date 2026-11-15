// reframe（既にある台帳の枠の差し替え）と段（phase）、coverage-build から渡された台帳の振り返りの扱い。
// 期待は承認済みの計画の 7 と単位 E の指示から取る。CLI は in-process で流す（test-harness の cli）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { cli, drive, evidenceOf, groupItems, mockAgent, tmp } from './test-harness.mjs'

const DOC = `# 対象の文書

## 一つ目の節
この節は一つ目の主張を述べる本文の行である。
二行目もこの節の主張を補う本文の行として置く。

## 二つ目の節
この節は二つ目の主張を述べる本文の行である。
二行目もこの節の主張を補う本文の行として置く。
`
const DOC2 = `# 別の対象

## 実装の節
この節は実装の段で確かめる本文の行である。
二行目も実装の段の主張を補う本文の行として置く。
`
const REQUEST = '対象の文書を観点ごとにレビューして、確かめた指摘を返してほしい'

const ledger = (state) => JSON.parse(readFileSync(path.join(state, 'ledger.json'), 'utf8'))
const bytes = (state) => readFileSync(path.join(state, 'ledger.json'), 'utf8')
const status = (state) => { const s = cli('status', '--state', state); assert.equal(s.code, 0, JSON.stringify(s)); return s }

// coverage-build が渡すのと同じ形の入力（目標の冒頭の文 + 項目、基準・制約・決定の記録）を書く。name で別の組を作る。
function frameFiles(d, name, { lead, goal, criteria, constraints, decisions, request = REQUEST }) {
  const f = (k) => path.join(d, `${name}-${k}.md`)
  writeFileSync(f('goal'), `${lead}\n\n${goal.map((x) => `- ${x}`).join('\n')}\n`)
  writeFileSync(f('request'), `${request}\n`)
  writeFileSync(f('criteria'), `${criteria.map((x) => `- ${x}`).join('\n')}\n`)
  writeFileSync(f('constraints'), `${constraints.map((x) => `- ${x}`).join('\n')}\n`)
  writeFileSync(f('decisions'), `${decisions}\n`)
  return { goal: f('goal'), request: f('request'), criteria: f('criteria'), constraints: f('constraints'), decisions: f('decisions') }
}
const frameArgv = (fr) => ['--goal', fr.goal, '--request', fr.request, '--criteria', fr.criteria, '--constraints', fr.constraints, '--decisions', fr.decisions]
const DESIGN = { lead: '設計が次の固定した目標を満たすかを確かめる。', goal: ['G1: 対象の文書の見落としを確かめた指摘の一覧'], criteria: ['AC1: 主張ごとに根拠がある'], constraints: ['D1: 依存を足さない'], decisions: '- 依存を足さない' }
const IMPL = { lead: '実装が次の固定した目標を満たすかを確かめる。', goal: ['G1: 実装の見落としを確かめた指摘の一覧', 'G2: 実装の段の受け入れ'], criteria: ['AC2: 実装の段の主張ごとに根拠がある'], constraints: ['D2: 標準のモジュールだけを使う'], decisions: '- 標準のモジュールだけを使う', request: '実装を観点ごとにレビューして、確かめた指摘を返してほしい' }

// 計画を作る台帳（利用者の観点を渡さない）を、coverage-build から渡された形（照合済みの印・段）で作る。
function setup(t, { phase = 'design', extra = [] } = {}) {
  const d = tmp(t)
  writeFileSync(path.join(d, 'doc.md'), DOC)
  writeFileSync(path.join(d, 'doc2.md'), DOC2)
  const fr = frameFiles(d, 'design', DESIGN)
  const state = path.join(d, 'state')
  const r = cli('init', '--state', state, ...frameArgv(fr), '--target', path.join(d, 'doc.md'), '--goal-checked', 'coverage-build', '--phase', phase, ...extra)
  assert.equal(r.code, 0, JSON.stringify(r))
  return { d, state, fr, doc: path.join(d, 'doc.md'), doc2: path.join(d, 'doc2.md') }
}
function reframe(state, fr, targets, phase) {
  return cli('reframe', '--state', state, ...frameArgv(fr), ...targets.flatMap((f) => ['--target', f]), '--phase', phase)
}

// 指摘を返す読む役（1 つの枡だけ）と、指摘の主張で判定を変える検証役。
// 主張に「退ける」を含む指摘は refuted、「確かめられない」は unverifiable、他は confirmed。
const verdictOf = (claim) => (claim.includes('退ける') ? 'refuted' : claim.includes('確かめられない') ? 'unverifiable' : 'confirmed')
function findingsAgent({ claims, layer = '実装', groupLayer = null }, log = []) {
  const once = { done: false }
  return mockAgent({
    read: (p, o) => {
      const ev = evidenceOf(p)
      if (once.done || !ev.length) return undefined
      once.done = true
      return { cell_id: o.label.slice('read-'.length).split('（')[0], evidence: ev, findings: claims.map((c) => ({ claim: c, quote: ev[0], severity: 'HIGH', layer })), outside_notes: [], none_reason: '' }
    },
    verify: (p, o) => {
      if (o.label.startsWith('verify-unit-')) return undefined
      const head = '### 指摘（index は配列の位置）\n'
      const fs = JSON.parse(p.slice(p.indexOf(head) + head.length).split('\n')[0])
      return { verdicts: fs.map((f) => ({ index: f.index, verdict: verdictOf(f.claim), reason: '判定の理由', quote: f.quote })) }
    },
    ...(groupLayer ? { group: (p) => ({ groups: [{ id: 'g1', root_cause: '方針の根の原因', layer: groupLayer, keys: groupItems(p).map((x) => x.key), pattern: '', applies_to: [] }], unassigned: [] }) } : {}),
  }, log)
}

const liveCells = (L) => Object.entries(L.cells).filter(([, c]) => c.status !== 'gone')
const ledgerFiles = (root) => readdirSync(root, { recursive: true }).map(String).filter((f) => path.basename(f) === 'ledger.json').map((f) => path.join(root, f))

test('reframe: 照合済みの印の無い台帳は終了状態 2 で拒否し、台帳を変えない', (t) => {
  const d = tmp(t)
  writeFileSync(path.join(d, 'doc.md'), DOC)
  writeFileSync(path.join(d, 'goal.md'), `- G1: 対象の文書の見落としを観点ごとに確かめた指摘の一覧 〔request: ${REQUEST}〕\n`)
  writeFileSync(path.join(d, 'request.md'), REQUEST)
  const state = path.join(d, 'state')
  assert.equal(cli('init', '--state', state, '--goal', path.join(d, 'goal.md'), '--request', path.join(d, 'request.md'), '--target', path.join(d, 'doc.md')).code, 0)
  const before = bytes(state)
  const fr = frameFiles(d, 'impl', IMPL)
  const r = reframe(state, fr, [path.join(d, 'doc.md')], 'impl')
  assert.equal(r.code, 2, JSON.stringify(r))
  assert.equal(bytes(state), before, '拒否した reframe は台帳を変えない')
})

test('reframe: --phase の無い reframe は拒否し、台帳を変えない', (t) => {
  const { state, fr, doc } = setup(t)
  const before = bytes(state)
  const r = cli('reframe', '--state', state, ...frameArgv(fr), '--target', doc)
  assert.equal(r.code, 2, JSON.stringify(r))
  assert.equal(bytes(state), before)
})

test('reframe: 目標の冒頭の文・目標・基準・制約・依頼文・決定の記録・対象を差し替え、照合済みの印を残し、段を記録する', async (t) => {
  const { d, state, doc2 } = setup(t)
  assert.equal(ledger(state).phase, 'design', 'init の段を記録する')
  const first = await drive(state, mockAgent())
  assert.equal(first.stop.stop, 'complete', JSON.stringify(first.stop))
  const fr = frameFiles(d, 'impl', IMPL)
  const r = reframe(state, fr, [doc2], 'impl')
  assert.equal(r.code, 0, JSON.stringify(r))
  assert.equal(r.ok, true)
  const L = ledger(state)
  assert.equal(L.phase, 'impl')
  assert.equal(L.goal.text, readFileSync(fr.goal, 'utf8').trim(), '目標の冒頭の文ごと差し替える')
  assert.deepEqual(L.goal.items.map((g) => g.id), ['G1', 'G2'])
  assert.deepEqual(L.criteria.map((c) => c.id), ['AC2'])
  assert.deepEqual(L.constraints.map((c) => c.id), ['D2'])
  assert.equal(L.request, IMPL.request)
  assert.equal(L.decisions, IMPL.decisions)
  assert.deepEqual(L.targets, [doc2])
  assert.equal(L.goal.checked_by, 'coverage-build', '照合済みの印を残す')
  assert.equal(L.goal.checked, true)
  const log = []
  const second = await drive(state, mockAgent({}, log))
  assert.equal(second.stop.stop, 'complete', JSON.stringify(second.stop))
  assert.ok(!log.some((x) => x.label.startsWith('goal')), '照合済みの目標を照合し直さない')
  const live = liveCells(ledger(state)).filter(([id]) => !id.startsWith('retro:'))
  assert.ok(live.length > 0)
  assert.ok(live.every(([id]) => id.startsWith(`${doc2}#`)), `差し替えた対象の枡だけが残る: ${live.map(([id]) => id).join(', ')}`)
})

test('reframe: 全ての枡を読み直しにし、計画からやり直す', async (t) => {
  const { d, state, doc2 } = setup(t)
  const first = await drive(state, mockAgent())
  assert.equal(first.stop.stop, 'complete', JSON.stringify(first.stop))
  assert.ok(liveCells(ledger(state)).some(([, c]) => c.status === 'settled'), '前の段で読み終えた枡がある')
  assert.equal(reframe(state, frameFiles(d, 'impl', IMPL), [doc2], 'impl').code, 0)
  const L = ledger(state)
  assert.ok(Object.values(L.cells).every((c) => ['unseen', 'gone'].includes(c.status)), `読み終えた印を残さない: ${JSON.stringify(Object.values(L.cells).map((c) => c.status))}`)
  const n = cli('next', '--state', state)
  assert.equal(n.code, 0, JSON.stringify(n))
  assert.equal(n.step, 'plan', '計画からやり直す')
  const args = JSON.parse(readFileSync(n.args_path, 'utf8'))
  assert.deepEqual(args.prevLensIds, [], '前の段の計画を持ち越さない（計画役から作り直す）')
  assert.ok(!args.againBrief && args.index, '前の計画の見直しでなく、索引から計画を作る')
})

test('reframe: 目標・基準・制約・対象・段が同じでも、全ての枡を読み直し、計画からやり直す', async (t) => {
  const { state, fr, doc } = setup(t)
  const first = await drive(state, mockAgent())
  assert.equal(first.stop.stop, 'complete', JSON.stringify(first.stop))
  const settled = liveCells(ledger(state)).filter(([, c]) => c.status === 'settled').map(([id]) => id)
  assert.ok(settled.length > 0)
  const r = reframe(state, fr, [doc], 'design')
  assert.equal(r.code, 0, JSON.stringify(r))
  assert.ok(Object.values(ledger(state).cells).every((c) => ['unseen', 'gone'].includes(c.status)), '中身が同じでも読み終えた印を残さない')
  const log = []
  const second = await drive(state, mockAgent({}, log))
  assert.equal(second.stop.stop, 'complete', JSON.stringify(second.stop))
  assert.equal(second.steps[0].step, 'plan', '計画からやり直す')
  assert.ok(log.some((x) => x.label.startsWith('plan-A')) && log.some((x) => x.label.startsWith('integrate')))
  const read = new Set(log.filter((x) => x.label.startsWith('read-')).map((x) => x.label.slice('read-'.length).split('（')[0]))
  const live = liveCells(ledger(state)).filter(([id]) => !id.startsWith('retro:'))
  assert.ok(read.size >= live.length, `全ての枡を読み直す（読んだ ${read.size}、枡 ${live.length}）`)
})

test('reframe: 出ていく段の status の節を phase_records に写し、status は段ごとに分け、今の段の findings・groups・events だけを上に出す', async (t) => {
  const { d, state, doc2 } = setup(t)
  const first = await drive(state, findingsAgent({ claims: ['残す指摘の主張', '退ける指摘の主張'] }))
  assert.equal(first.stop.stop, 'complete', JSON.stringify(first.stop))
  const s1 = status(state)
  assert.equal(s1.phase, 'design')
  const confirmed1 = s1.findings.confirmed.map((f) => f.id)
  assert.equal(confirmed1.length, 1, JSON.stringify(s1.findings))
  assert.ok(s1.groups.length >= 1, '前の段で束ねた群がある')
  const events1 = s1.events.map((e) => e.id)
  assert.ok(s1.events.some((e) => e.kind === 'refuted'), `退けた指摘の出来事を status の events で返す: ${JSON.stringify(s1.events)}`)
  assert.ok(s1.events.every((e) => e.id && e.stage && e.kind && typeof e.text === 'string'), '出来事は id・stage・kind・text を持つ')

  assert.equal(reframe(state, frameFiles(d, 'impl', IMPL), [doc2], 'impl').code, 0)
  const rec = ledger(state).phase_records
  assert.ok(rec && rec.design, '出ていく段の節を phase_records に写す')
  assert.deepEqual(rec.design.findings.confirmed.map((f) => f.id), confirmed1)
  assert.deepEqual(rec.design.events.map((e) => e.id), events1)
  assert.ok(rec.design.groups.length >= 1)

  const second = await drive(state, mockAgent())
  assert.equal(second.stop.stop, 'complete', JSON.stringify(second.stop))
  const s2 = status(state)
  assert.equal(s2.phase, 'impl')
  assert.deepEqual(Object.keys(s2.phases).sort(), ['design', 'impl'])
  assert.deepEqual(s2.phases.design, ledger(state).phase_records.design, '前の段の節は写したまま')
  assert.deepEqual(s2.findings.confirmed, [], '前の段の指摘を今の段に出さない')
  assert.deepEqual(s2.groups, [], '前の段の群を今の段に出さない')
  assert.ok(!s2.events.some((e) => events1.includes(e.id)), '前の段の出来事を今の段に出さない')
  assert.deepEqual(s2.phases.impl.findings.confirmed, s2.findings.confirmed)
})

test('reframe: 前の段の上の層の指摘・群・検証不能の指摘で、今の段を止めない', async (t) => {
  const { d, state, doc2 } = setup(t)
  const first = await drive(state, findingsAgent({ claims: ['方針の欠陥の主張', '確かめられない主張'], layer: '方針', groupLayer: '方針' }))
  assert.equal(first.stop.stop, 'needs_input', JSON.stringify(first.stop))
  assert.ok(first.stop.upper.length >= 1 && first.stop.upper_groups.length >= 1 && first.stop.unverifiable.length >= 1, JSON.stringify(first.stop))
  assert.equal(reframe(state, frameFiles(d, 'impl', IMPL), [doc2], 'impl').code, 0)
  const second = await drive(state, mockAgent())
  assert.equal(second.stop.stop, 'complete', `前の段の upper・upper_groups・unverifiable を今の段の判断に入れない: ${JSON.stringify(second.stop)}`)
  const s = status(state)
  assert.ok(s.phases.design.groups.some((g) => g.layer === '方針'), '前の段の群は前の段の節に残る')
})

test('reframe: 周と起動数の上限は段の始まり（reframe の時点）から数える', async (t) => {
  const { d, state, doc2 } = setup(t)
  const first = await drive(state, mockAgent())
  assert.equal(first.stop.stop, 'complete', JSON.stringify(first.stop))
  const spent = ledger(state).agents.length
  assert.ok(spent > 0)
  assert.equal(cli('config', '--state', state, '--max-agents-total', String(spent), '--max-cycles', '1').code, 0)
  const before = cli('next', '--state', state)
  assert.equal(before.stop, 'limit', '同じ段のうちは、それまでの起動数で上限に届く')
  assert.equal(reframe(state, frameFiles(d, 'impl', IMPL), [doc2], 'impl').code, 0)
  // 段 2 も段 1 と同じ数を起動する。上限を段 1 の起動数より大きく 2 倍より小さくすると、
  // 段の始まりから数えれば complete、通算で数えれば limit になり、2 つの数え方を見分けられる。
  const cap = spent + Math.max(1, Math.floor(spent / 2))
  assert.ok(cap > spent && cap < 2 * spent, `上限 ${cap} は段 1 の起動数 ${spent} と、その 2 倍の間`)
  assert.equal(cli('config', '--state', state, '--max-agents-total', String(cap)).code, 0)
  const second = await drive(state, mockAgent())
  assert.equal(second.stop.stop, 'complete', `前の段の周と起動数を新しい段の上限に数えない: ${JSON.stringify(second.stop)}`)
  const phase2 = ledger(state).agents.length - spent
  assert.ok(phase2 > cap - spent, `段 2 の起動数 ${phase2} は、通算なら上限 ${cap} を超える数（見分けられる）`)
  // 段の中では上限が効く。
  assert.equal(reframe(state, frameFiles(d, 'review', DESIGN), [path.join(d, 'doc.md')], 'review').code, 0)
  assert.equal(cli('config', '--state', state, '--max-agents-total', '1').code, 0)
  const third = await drive(state, mockAgent())
  assert.equal(third.stop.stop, 'limit', JSON.stringify(third.stop))
  assert.ok(third.steps.length >= 1, '段の始まりからの起動数で止まる（始まりで止まらない）')
})

test('reframe: 台帳は 1 つのまま（置き場を増やさない）', async (t) => {
  const { d, state, doc2 } = setup(t)
  await drive(state, mockAgent())
  const ledgerPath = path.join(state, 'ledger.json')
  assert.equal(reframe(state, frameFiles(d, 'impl', IMPL), [doc2], 'impl').code, 0)
  await drive(state, mockAgent())
  assert.equal(reframe(state, frameFiles(d, 'review', DESIGN), [path.join(d, 'doc.md')], 'review').code, 0)
  await drive(state, mockAgent())
  assert.deepEqual(ledgerFiles(d), [ledgerPath])
})

test('振り返り: --goal-checked coverage-build の台帳は振り返りの資産（retro:）を作らず、出来事を status の events で返す', async (t) => {
  const { state } = setup(t)
  const log = []
  const r = await drive(state, findingsAgent({ claims: ['残す指摘の主張', '退ける指摘の主張'] }, log))
  assert.equal(r.stop.stop, 'complete', JSON.stringify(r.stop))
  const L = ledger(state)
  assert.ok(!Object.keys(L.assets).some((id) => id.startsWith('retro:')), `振り返りの資産を作らない: ${Object.keys(L.assets).filter((id) => id.startsWith('retro:')).join(', ')}`)
  assert.ok(!Object.keys(L.cells).some((id) => id.startsWith('retro:')))
  assert.ok(!log.some((x) => x.label.includes('retro:')), '振り返りの枡を読ませない')
  const s = status(state)
  assert.ok(s.events.some((e) => e.kind === 'refuted'), `出来事は status の events で返す: ${JSON.stringify(s.events)}`)
  // 束ねは残す（検査の一部）。
  assert.ok(log.some((x) => x.label.startsWith('group')), '束ねは残す')
  assert.ok(s.groups.length >= 1)
})

test('振り返り: 印の無い台帳では、同じ出来事から振り返りの資産を作る（印のある台帳だけが作らない）', async (t) => {
  const d = tmp(t)
  writeFileSync(path.join(d, 'doc.md'), DOC)
  writeFileSync(path.join(d, 'goal.md'), `- G1: 対象の文書の見落としを観点ごとに確かめた指摘の一覧 〔request: ${REQUEST}〕\n`)
  writeFileSync(path.join(d, 'request.md'), REQUEST)
  const state = path.join(d, 'state')
  assert.equal(cli('init', '--state', state, '--goal', path.join(d, 'goal.md'), '--request', path.join(d, 'request.md'), '--target', path.join(d, 'doc.md')).code, 0)
  await drive(state, findingsAgent({ claims: ['残す指摘の主張', '退ける指摘の主張'] }))
  assert.ok(Object.keys(ledger(state).assets).some((id) => id.startsWith('retro:')))
})
