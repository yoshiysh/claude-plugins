// reframe（既にある台帳の枠の差し替え）と段（phase）、coverage-build から渡された台帳の振り返りの扱い。
// 役の偽物は blackboard-fixture の drive・behave で、計画の段の役（計画役・統合役・検証役）の既定の答えは plan-roles.mjs の planAct が query の inputs から作る。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { behave, cli, drive, fileResult, project, status } from './blackboard-fixture.mjs'
import { planAct } from './plan-roles.mjs'

const DOC = '# 対象の文書\n\n## 一つ目の節\nこの節は一つ目の主張を述べる本文の行である。\n二行目もこの節の主張を補う本文の行として置く。\n'
const DOC2 = '# 別の対象\n\n## 実装の節\nこの節は実装の段で確かめる本文の行である。\n二行目も実装の段の主張を補う本文の行として置く。\n'
const REQUEST = '対象の文書を観点ごとにレビューして、確かめた指摘を返してほしい'
const CITED_GOAL = '- G1: 対象の文書の見落としを観点ごとに確かめた指摘の一覧 〔request: 対象の文書を観点ごとにレビューしてほしい〕\n'

const ledger = (state) => JSON.parse(readFileSync(path.join(state, 'ledger.json'), 'utf8'))
const bytes = (state) => readFileSync(path.join(state, 'ledger.json'), 'utf8')
const steps = (calls) => calls.map((c) => c.next.step)

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

// 1 回だけ照合に落ちる提出（seen が空）を出すファイルの段。出来事（rejected_file）を作る。
const rejectOnce = () => { let bad = true; return (task) => { if (!bad) return undefined; bad = false; return { ...fileResult(task), seen: [] } } }

// 計画を作る台帳（利用者の観点を渡さない）を、coverage-build から渡された形（照合済みの印・段）で作る。
function setup(t, { phase = 'design' } = {}) {
  const p = project(t, { 'doc.md': DOC, 'doc2.md': DOC2 }, { lenses: null, criteria: null, goal: CITED_GOAL, goalChecked: false })
  const fr = frameFiles(p.d, 'design', DESIGN)
  const state = path.join(p.d, 'frame', 'state')
  const r = cli('init', '--state', state, ...frameArgv(fr), '--target', p.paths['doc.md'], '--goal-checked', 'coverage-build', '--phase', phase)
  assert.equal(r.code, 0, JSON.stringify(r))
  return { d: p.d, state, fr, doc: p.paths['doc.md'], doc2: p.paths['doc2.md'] }
}
function reframe(state, fr, targets, phase) {
  return cli('reframe', '--state', state, ...frameArgv(fr), ...targets.flatMap((f) => ['--target', f]), '--phase', phase)
}
const unitStates = (state) => status(state).units.map((u) => [u.id, u.state])
const ledgerFiles = (root) => readdirSync(root, { recursive: true }).map(String).filter((f) => path.basename(f) === 'ledger.json').map((f) => path.join(root, f))

test('reframe: 照合済みの印の無い台帳は終了状態 2 で拒否し、台帳を変えない', (t) => {
  const { d, state, paths } = project(t, { 'doc.md': DOC }, { goalChecked: false, criteria: null, goal: CITED_GOAL })
  const before = bytes(state)
  const r = reframe(state, frameFiles(d, 'impl', IMPL), [paths['doc.md']], 'impl')
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
  assert.equal((await drive(state, planAct())).stop.stop, 'complete')
  const fr = frameFiles(d, 'impl', IMPL)
  const r = reframe(state, fr, [doc2], 'impl')
  assert.equal(r.code, 0, JSON.stringify(r))
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
  const second = await drive(state, planAct())
  assert.equal(second.stop.stop, 'complete', JSON.stringify(second.stop))
  const planQ = second.calls.filter((c) => c.args.stage === 'plan').flatMap((c) => c.workers.flatMap((w) => w.queries.map((q) => q.out.inputs)))
  assert.ok(planQ.length && planQ.every((q) => !('item_ids' in q)), '照合済みの目標を照合し直さない（計画役に照合の入力を渡さない）')
  assert.deepEqual(unitStates(state), [[doc2, 'seen']], '差し替えた対象の単位だけが残る')
})

test('reframe: 全ての単位を読み直しにし、計画からやり直す', async (t) => {
  const { d, state, doc, doc2 } = setup(t)
  assert.equal((await drive(state, planAct())).stop.stop, 'complete')
  assert.deepEqual(unitStates(state), [[doc, 'seen']], '前の段で読み終えた単位がある（1 ファイル 1 単位）')
  assert.equal(reframe(state, frameFiles(d, 'impl', IMPL), [doc2], 'impl').code, 0)
  const n = cli('next', '--state', state)
  assert.equal(n.step, 'plan', '計画からやり直す')
  assert.deepEqual(unitStates(state), [[doc2, 'unseen']], '差し替えた対象の単位を読み終えた印なしで持つ')
  assert.equal(ledger(state).plan, null, '前の段の計画を持ち越さない（計画役から作り直す）')
})

test('reframe: 段と手続き（観点・目標・基準・制約・決定の記録）が同じなら全てを読み直さず（kept）、読み終えた印を持ち越して計画もやり直さない。手続きが変われば全てを読み直し、計画からやり直す', async (t) => {
  const { d, state, fr, doc } = setup(t)
  assert.equal((await drive(state, planAct())).stop.stop, 'complete')
  assert.deepEqual(unitStates(state), [[doc, 'seen']])
  const same = reframe(state, fr, [doc], 'design')
  assert.equal(same.code, 0)
  assert.equal(same.kept, true)
  assert.deepEqual(unitStates(state), [[doc, 'seen']], '中身（単位の hash）も手続きも同じなら読み終えた印を残す（設計「再レビューと持ち越し」）')
  const again = await drive(state, planAct())
  assert.equal(again.stop.stop, 'complete', JSON.stringify(again.stop))
  assert.ok(!steps(again.calls).includes('plan') && !steps(again.calls).includes('file'), `計画も読みもやり直さない: ${steps(again.calls)}`)
  // 手続き（目標）が変わる reframe は、全ての単位を読み直し、計画からやり直す。
  const changed = reframe(state, frameFiles(d, 'design2', { ...DESIGN, goal: ['G1: 対象の文書の見落としを確かめた指摘の一覧', 'G9: 新しく足した目標'] }), [doc], 'design')
  assert.equal(changed.code, 0)
  assert.equal(changed.kept, false)
  assert.deepEqual(unitStates(state), [[doc, 'unseen']])
  const second = await drive(state, planAct())
  assert.equal(second.stop.stop, 'complete', JSON.stringify(second.stop))
  assert.equal(steps(second.calls)[0], 'plan', '計画からやり直す')
  assert.ok(steps(second.calls).includes('file'), '単位を読み直す')
  assert.ok(status(state).facts.every((f) => f.cycle === ledger(state).cycle), '前の段の読みの事実は今の根拠に残らない')
})

test('reframe: 出ていく段の status の節を phase_records に写し、status は段ごとに分け、今の段の events だけを上に出す', async (t) => {
  const { d, state, doc2 } = setup(t)
  const first = await drive(state, planAct({ file: rejectOnce() }))
  assert.equal(first.stop.stop, 'complete', JSON.stringify(first.stop))
  const s1 = status(state)
  assert.equal(s1.phase, 'design')
  const events1 = s1.events.map((e) => e.id)
  assert.ok(s1.events.some((e) => e.kind === 'rejected_file'), JSON.stringify(s1.events))
  assert.ok(s1.events.every((e) => e.id && e.stage && e.kind && typeof e.text === 'string'), '出来事は id・stage・kind・text を持つ')
  assert.equal(reframe(state, frameFiles(d, 'impl', IMPL), [doc2], 'impl').code, 0)
  const rec = ledger(state).phase_records
  assert.ok(rec && rec.design, '出ていく段の節を phase_records に写す')
  assert.deepEqual(rec.design.events.map((e) => e.id), events1)
  const second = await drive(state, planAct())
  assert.equal(second.stop.stop, 'complete', JSON.stringify(second.stop))
  const s2 = status(state)
  assert.equal(s2.phase, 'impl')
  assert.deepEqual(Object.keys(s2.phases).sort(), ['design', 'impl'])
  assert.deepEqual(s2.phases.design, ledger(state).phase_records.design, '前の段の節は写したまま')
  assert.ok(!s2.events.some((e) => events1.includes(e.id)), '前の段の出来事を今の段に出さない')
})

test('reframe: 周と起動数の上限は段の始まり（reframe の時点）から数える', async (t) => {
  const { d, state, doc, doc2 } = setup(t)
  assert.equal((await drive(state, planAct())).stop.stop, 'complete')
  const spent = ledger(state).agents.length
  assert.ok(spent > 0)
  assert.equal(cli('config', '--state', state, '--max-agents-total', String(spent), '--max-cycles', '1').code, 0)
  assert.equal(cli('next', '--state', state).stop, 'limit', '同じ段のうちは、それまでの起動数で上限に届く')
  assert.equal(reframe(state, frameFiles(d, 'impl', IMPL), [doc2], 'impl').code, 0)
  // 段 2 も段 1 と同じ数を起動する。上限を段 1 の起動数より大きく 2 倍より小さくすると、段の始まりから数えれば complete、通算で数えれば limit になる。
  const cap = spent + Math.max(1, Math.floor(spent / 2))
  assert.ok(cap > spent && cap < 2 * spent, `上限 ${cap} は段 1 の起動数 ${spent} と、その 2 倍の間`)
  assert.equal(cli('config', '--state', state, '--max-agents-total', String(cap)).code, 0)
  const second = await drive(state, planAct())
  assert.equal(second.stop.stop, 'complete', `前の段の周と起動数を新しい段の上限に数えない: ${JSON.stringify(second.stop)}`)
  assert.ok(ledger(state).agents.length > cap, '段 2 の起動数は、通算なら上限を超える数（見分けられる）')
  assert.equal(reframe(state, frameFiles(d, 'review', DESIGN), [doc], 'review').code, 0)
  assert.equal(cli('config', '--state', state, '--max-agents-total', '1').code, 0)
  const third = await drive(state, planAct())
  assert.equal(third.stop.stop, 'limit', JSON.stringify(third.stop))
  assert.ok(third.calls.length >= 1, '段の始まりからの起動数で止まる（始まりで止まらない）')
})

test('reframe: 台帳は 1 つのまま（置き場を増やさない）', async (t) => {
  const { d, state, doc, doc2 } = setup(t)
  await drive(state, planAct())
  assert.equal(reframe(state, frameFiles(d, 'impl', IMPL), [doc2], 'impl').code, 0)
  await drive(state, planAct())
  assert.equal(reframe(state, frameFiles(d, 'review', DESIGN), [doc], 'review').code, 0)
  await drive(state, planAct())
  assert.deepEqual(ledgerFiles(path.join(d, 'frame')), [path.join(state, 'ledger.json')])
})

test('振り返り: --goal-checked coverage-build の台帳は振り返りの単位（retro:）を作らず、出来事を status の events で返す', async (t) => {
  const { state } = setup(t)
  const r = await drive(state, planAct({ file: rejectOnce() }))
  assert.equal(r.stop.stop, 'complete', JSON.stringify(r.stop))
  assert.ok(!Object.keys(ledger(state).assets).some((id) => id.startsWith('retro:')), '振り返りの単位を作らない')
  assert.ok(status(state).events.some((e) => e.kind === 'rejected_file'), '出来事は status の events で返す')
})

test('振り返り: 印の無い台帳では、同じ出来事から振り返りの単位を作り、振り返りの段で振り返りの観点（R1〜R4）の担当として読む。対象の単位に数えない', async (t) => {
  const { state } = project(t, { 'doc.md': DOC }, { goalChecked: false, criteria: null, goal: CITED_GOAL })
  const r = await drive(state, planAct({ file: rejectOnce() }))
  assert.equal(r.stop.stop, 'complete', JSON.stringify(r.stop))
  const retro = Object.entries(ledger(state).assets).filter(([id]) => id.startsWith('retro:'))
  assert.ok(retro.length && retro.every(([, a]) => a.state === 'seen'), JSON.stringify(retro.map(([id, a]) => [id, a.state])))
  const rc = r.calls.filter((c) => c.args.stage === 'retro')
  assert.equal(rc.length, 1, `振り返りの段は 1 回: ${r.calls.map((c) => c.args.stage)}`)
  const tasks = rc.flatMap((c) => c.workers.flatMap((w) => w.claims.flatMap((cl) => cl.tasks || [])))
  assert.ok(tasks.length && tasks.every((x) => x.kind === 'retro' && x.unit.id.startsWith('retro:') && x.lenses.map((l) => l.id).join() === 'R1,R2,R3,R4'), JSON.stringify(tasks.map((x) => [x.kind, x.unit.id])))
  assert.ok(!r.calls.filter((c) => c.args.stage === 'file').some((c) => c.workers.some((w) => w.claims.some((cl) => (cl.tasks || []).some((x) => x.unit.id.startsWith('retro:'))))), 'ファイルの段は振り返りの単位を読まない')
  assert.ok(!status(state).units.some((u) => u.id.startsWith('retro:')), 'status の units は対象の単位だけ')
  assert.equal(status(state).coverage.units, 1, '振り返りの単位は対象の単位に数えない')
})

test('reframe: 前の段の上の層の指摘・群・検証不能の指摘で、今の段を止めない（前の段の節には残る）', async (t) => {
  const { d, state, doc2 } = setup(t)
  const Q = 'この節は一つ目の主張を述べる本文の行である。'
  const group = (task, ctx) => { const q = ctx.query(task); return { groups: [{ id: 'g1', root_cause: '方針の根の原因', layer: '方針', keys: q.basis.map((f) => f.id) }], unassigned: [] } }
  const facts = (p) => (path.basename(p) === 'doc.md' ? { findings: [{ claim: '方針の欠陥の主張', quote: Q, layer: '方針' }] } : {})
  const first = await drive(state, planAct({ facts, group }))
  assert.equal(first.stop.stop, 'needs_input', JSON.stringify(first.stop))
  assert.ok(first.stop.upper.length >= 1 && first.stop.upper_groups.length >= 1, JSON.stringify(first.stop))
  assert.equal(reframe(state, frameFiles(d, 'impl', IMPL), [doc2], 'impl').code, 0)
  const second = await drive(state, planAct())
  assert.equal(second.stop.stop, 'complete', `前の段の upper・upper_groups を今の段の判断に入れない: ${JSON.stringify(second.stop)}`)
  const s = status(state)
  assert.ok(s.phases.design.groups.some((g) => g.layer === '方針'), '前の段の群は前の段の節に残る')
  assert.ok(s.phases.design.findings.confirmed.some((f) => f.claim === '方針の欠陥の主張'), '前の段の指摘は前の段の節に残る')
  assert.deepEqual(s.findings.confirmed, [])
})
