// 計画の段の止め方のテスト（計画 effervescent-kindling-corbato の「coverage-audit」4〜6、設計レビュー 1 回目の 6）。
// - Q1・Q2 の形: 計画の観点の procedure は { enumerate, compare_with }。空なら checkPlan が拒む。Q1・Q2 は検証役の問いとして残り、問う対象はその 2 つの欄。
// - PLAN_ROUNDS = 1: 計画 2 版の検証でも欠陥が残れば needs_input（plan_defects）。理由に「2 巡で終わらなかった」。answer --id P<n> で 1 巡だけ回る。
// - no_target: defect_responses の action に no_target。付けば計画をやり直さず needs_input（target_gaps）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { C } from './ledger-core.mjs'
import { argOf, cli, cliArgvOf, drive, runScript } from './blackboard-fixture.mjs'
import { standalone } from './launch-fixture.mjs'
import { onePlan, planAct, verifyAll } from './plan-roles.mjs'

const FILES = { 'doc.md': '# 文書\n\n## 節\nこの節は主張を一つだけ述べる本文の行である。\n' }
const goals = [{ id: 'G1', part: '見落とし' }]
const ctx = { constraintIds: [], lensesGiven: false, givenLensIds: [], goalItemIds: ['G1'] }
const lens = (procedure) => ({ id: 'X1', name: 'X1', procedure, goals })
const procProblems = (procedure) => C.checkPlan({ lenses: [lens(procedure)], questions: [], constraint_map: [] }, ctx).filter((p) => /procedure|enumerate|compare_with/.test(p))

// ---------------- Q1・Q2 の形 ----------------

test('Q1・Q2 の形: 計画の観点の procedure は {enumerate, compare_with} で、どちらも空でなければ受け付ける', () => {
  assert.deepEqual(procProblems({ enumerate: '本文の主張を列挙する', compare_with: '列挙した主張を目標と照らす' }), [])
})

test('Q1・Q2 の形: 文字列の procedure、enumerate か compare_with が空・欠けた procedure は checkPlan が拒む', () => {
  for (const [name, p] of [
    ['文字列', '主張と根拠を対応づけて食い違いを探す'],
    ['enumerate が空', { enumerate: '', compare_with: '列挙した主張を目標と照らす' }],
    ['compare_with が空', { enumerate: '本文の主張を列挙する', compare_with: '  ' }],
    ['compare_with が無い', { enumerate: '本文の主張を列挙する' }],
    ['enumerate が文字列でない', { enumerate: ['主張'], compare_with: '列挙した主張を目標と照らす' }],
  ]) assert.ok(procProblems(p).length >= 1, `${name} の procedure を受け付けた`)
})

test('Q1・Q2 は検証役の問いとして残り、問う対象は enumerate・compare_with の欄（観点の検証役の prompt）', async () => {
  const seen = []
  const fn = async (prompt, opts) => { seen.push({ prompt, opts }); return { notes: [] } }
  await runScript({ state: '/tmp/coverage-plan-gate', callId: 'c1', wave: { id: 1, rows: [{ id: 'uv1', role: 'unit_verifier', model: 'sonnet', effort: 'medium', stage: 'unit_verify' }] } }, fn)
  assert.equal(seen.length, 1, '観点の検証役を起動する')
  const p = seen[0].prompt
  assert.equal(argOf(cliArgvOf(p, 'claim'), 'stage'), 'unit_verify')
  const q1 = p.split('\n').find((l) => /Q1/.test(l))
  const q2 = p.split('\n').find((l) => /Q2/.test(l))
  assert.ok(q1 && /enumerate/.test(q1), `Q1 は enumerate の欄を問う: ${q1}`)
  assert.ok(q2 && /compare_with/.test(q2), `Q2 は compare_with の欄を問う: ${q2}`)
  assert.ok(/Q3/.test(p), 'Q3 も残る')
})

// ---------------- PLAN_ROUNDS = 1 ----------------

// 観点の検証役が、どの観点の Q3（goals の最初の要素）にも no と答える。計画役は欠陥を fixed と答えるが観点を変えない。
const stubborn = () => planAct({ unit_verify: (q) => verifyAll(q, (l, k) => k === 'Q3:0') })
const stagesOf = (calls) => calls.map((c) => c.stage)

test('PLAN_ROUNDS = 1: 計画 2 版の検証でも欠陥が残れば、3 版目を作らずに needs_input（plan_defects に P<n>・Q3 の引用）。理由は「2 巡で終わらなかった」と目標・観点の作り方を疑う旨', async (t) => {
  const { state } = standalone(t, FILES, { lenses: null })
  const { stop, calls } = await drive(state, stubborn(), { maxSteps: 12 })
  assert.equal(stop && stop.stop, 'needs_input', JSON.stringify(stop))
  const stages = stagesOf(calls)
  assert.equal(stages.filter((s) => s === 'plan').length, 2, `計画は 2 版まで: ${stages}`)
  assert.equal(stages.filter((s) => s === 'unit_verify').length, 2, `検証は 2 回: ${stages}`)
  assert.ok(Array.isArray(stop.plan_defects) && stop.plan_defects.length >= 1, JSON.stringify(stop))
  for (const d of stop.plan_defects) {
    assert.match(d.id, /^P\d+$/)
    assert.equal(d.kind, 'Q3')
    assert.ok(typeof d.quote === 'string' && d.quote.length > 0, `検証の答えの引用: ${JSON.stringify(d)}`)
  }
  const why = stop.reasons.join('\n')
  assert.match(why, /2 巡で終わらなかった/)
  assert.match(why, /目標の書き方|観点の作り方/)
})

test('PLAN_ROUNDS = 1: answer --id P<n> で計画の段をもう 1 巡だけ回し、まだ欠陥が残ればまた止まる。答えずに config で上限だけを変えても回さない', async (t) => {
  const { state } = standalone(t, FILES, { lenses: null })
  const first = await drive(state, stubborn(), { maxSteps: 12 })
  assert.equal(first.stop && first.stop.stop, 'needs_input', JSON.stringify(first.stop))
  assert.equal(stagesOf(first.calls).filter((s) => s === 'plan').length, 2, `計画は 2 版まで: ${stagesOf(first.calls)}`)
  // 答えずに上限だけを変える: 計画を回さない。
  assert.equal(cli('config', '--state', state, '--max-cycles', '5', '--max-agents-total', '900').code, 0)
  const idle = await drive(state, stubborn(), { maxSteps: 12 })
  assert.equal(idle.stop && idle.stop.stop, 'needs_input', JSON.stringify(idle.stop))
  assert.equal(idle.calls.length, 0, `答えずに回さない: ${stagesOf(idle.calls)}`)
  // P<n> に答える: もう 1 巡（計画 1 版・検証 1 回）だけ回る。
  const pid = first.stop.plan_defects[0].id
  assert.equal(cli('answer', '--state', state, '--id', pid, '--text', 'この欠陥は受け入れる').code, 0)
  const again = await drive(state, stubborn(), { maxSteps: 12 })
  assert.equal(again.stop && again.stop.stop, 'needs_input', JSON.stringify(again.stop))
  assert.deepEqual(stagesOf(again.calls), ['plan', 'unit_verify'], '回答で 1 巡だけ')
})

// ---------------- no_target（Q3 の早い止め） ----------------

test('no_target: checkPlan は defect_responses の action に no_target を受け付ける（fixed・rejected と同じく reason が要る）', () => {
  const ok = C.checkPlan({ ...onePlanStatic(), defect_responses: [{ defect_index: 0, action: 'no_target', reason: '部分を受け持てる単位が対象に無い' }] }, { ...ctx, defectCount: 1 })
  assert.deepEqual(ok.filter((p) => /欠陥 0/.test(p)), [], JSON.stringify(ok))
  const bad = C.checkPlan({ ...onePlanStatic(), defect_responses: [{ defect_index: 0, action: 'no_target', reason: '' }] }, { ...ctx, defectCount: 1 })
  assert.ok(bad.some((p) => /欠陥 0/.test(p)), 'reason が空なら拒む')
})
function onePlanStatic() {
  return { lenses: [lens({ enumerate: '本文の主張を列挙する', compare_with: '列挙した主張を目標と照らす' })], questions: [], constraint_map: [] }
}

test('no_target: 計画役が Q3 の欠陥に no_target を付けたら、計画をやり直さず needs_input（target_gaps に欠陥の P<n> と理由）で返す', async (t) => {
  const { state } = standalone(t, FILES, { lenses: null })
  const REASON = '対象に、この部分を受け持てる単位が無い'
  const a = planAct({
    unit_verify: (q) => verifyAll(q, (l, k) => k === 'Q3:0'),
    plan: (q) => (Array.isArray(q.defects) ? { ...onePlan(q), defect_responses: q.defects.map((d) => ({ defect_index: d.index, action: 'no_target', reason: REASON })) } : undefined),
  })
  const { stop, calls } = await drive(state, a, { maxSteps: 12 })
  assert.equal(stop && stop.stop, 'needs_input', JSON.stringify(stop))
  assert.ok(Array.isArray(stop.target_gaps) && stop.target_gaps.length >= 1, JSON.stringify(stop))
  for (const g of stop.target_gaps) {
    assert.match(String(g.id), /^P\d+$/, JSON.stringify(g))
    assert.equal(g.reason, REASON)
    assert.ok(g.goal_id, '受け持てない目標の id')
  }
  const stages = stagesOf(calls)
  assert.equal(stages.filter((s) => s === 'plan').length, 2, `no_target を返した計画の後に計画を作り直さない: ${stages}`)
  assert.equal(stages.filter((s) => s === 'unit_verify').length, 1, `no_target の後に検証しない: ${stages}`)
  assert.ok(!stop.plan_defects || !stop.plan_defects.length || stop.target_gaps.length, 'target_gaps で返す')
})
