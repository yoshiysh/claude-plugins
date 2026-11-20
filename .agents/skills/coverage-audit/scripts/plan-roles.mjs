// テストの道具: 計画の段の役（目標の照合・計画役・統合役・観点の検証役）の偽物。query の inputs から、照合を通る最小の答えを作る。
// blackboard-fixture.mjs の behave に、計画の段の種類の振る舞いを足して返す（fixture の既存の形と既定は変えない）。
import { behave } from './blackboard-fixture.mjs'

export const LENS_PROC = { X1: '主張と根拠を対応づけて食い違いを探す', X2: '用語ごとに定義の文を対応づけ、定義の無い用語を探す', X3: '手順ごとに前提の文を対応づけ、前提の無い手順を探す' }
// 観点が受け持つ目標の部分: 全ての目標・受け入れ基準の本文の全体。
export const goalsOfQ = (q) => [...q.items, ...q.criteria].map((g) => ({ id: g.id, part: g.text }))
// 統合役の欄: 元の観点を source_map に写し（元の観点が計画に無ければ落とす理由を付ける）、欠陥は全て fixed にする。計画役（sources が無い）にはそのまま返す。
export function asIntegrated(q, plan) {
  if (!q.sources) return plan
  return {
    ...plan,
    source_map: q.sources.map((s) => { const id = s.split(':')[1]; return plan.lenses.some((l) => l.id === id) ? { source: s, merged_into: id, dropped_reason: '' } : { source: s, merged_into: '', dropped_reason: '計画から外した観点' } }),
    defect_responses: (q.defects || []).map((d) => ({ defect_index: d.index, action: 'fixed', reason: '直した' })),
  }
}
// 観点の一覧の計画。spec は { 観点の id: { goals?: (goal) => boolean } }（goals が無ければ全ての目標・基準を受け持つ）。handledBy は全ての基準・制約の受け皿。
// 観点は一覧で全ての単位に渡すので、当てる単位（applies_to）は持たない。
export const lensPlan = (spec, handledBy = [Object.keys(spec).at(-1)]) => (q) => asIntegrated(q, {
  lenses: Object.entries(spec).map(([id, s]) => ({ id, name: id, procedure: LENS_PROC[id], goals: goalsOfQ(q).filter(s.goals || (() => true)) })),
  questions: [],
  constraint_map: [...q.criteria, ...q.constraints].map((c) => ({ constraint_id: c.id, handled_by: handledBy })),
})
export const onePlan = lensPlan({ X1: {} }, ['X1'])
// 観点の検証役の答え: Q1・Q2 と goals の要素ごとの Q3。no にする問いを noFor(key) で選ぶ（key は Q1・Q2・Q3:<goal_index>）。
export const unitAnswers = (u, noFor = () => false) => ({
  unit_id: u.id,
  answers: [{ question: 'Q1' }, { question: 'Q2' }, ...(u.goals || []).map((g, i) => ({ question: 'Q3', goal_index: i, goal_id: g.id }))]
    .map((x) => ({ ...x, answer: noFor(x.question === 'Q3' ? `Q3:${x.goal_index}` : x.question) ? 'no' : 'yes', quote: u.procedure })),
})
const PLAN_KINDS = ['goal_check', 'plan', 'integrate', 'unit_verify']
// 計画の段の役の振る舞いを足した behave。over の計画の段の種類（goal_check・plan・integrate・unit_verify）の関数は (inputs, task) を受け、
// undefined を返せば既定、null を返せば出さない。それ以外の over（file・facts・意図の種類など）は fixture の behave にそのまま渡す。
export function planAct(over = {}) {
  const defaults = {
    goal_check: (q) => ({ outcomes: [{ outcome: '依頼の全体', quotes: [{ source: 'request', quote: q.request }], items: q.item_ids }] }),
    plan: (q) => onePlan(q),
    integrate: (q) => onePlan(q),
    unit_verify: (q) => unitAnswers(q.lens),
  }
  const rest = Object.fromEntries(Object.entries(over).filter(([k]) => !PLAN_KINDS.includes(k)))
  const wrap = Object.fromEntries(PLAN_KINDS.map((k) => [k, (task, ctx) => {
    const q = ctx.query(task).inputs
    const r = over[k] ? over[k](q, task) : undefined
    return r !== undefined ? r : defaults[k](q, task)
  }]))
  return behave({ ...rest, ...wrap })
}

// 観点を渡した台帳（--lenses）の計画の段を、足す観点を提案しない偽の計画役で通す（計画役は観点を渡しても提案として流れる。設計「観点の定義と持ち主」）。
// 提案しない計画: 観点を足さず、受け入れ基準・制約の受け皿は既にある観点（given_lenses）の先頭にする。
export const noProposal = (q) => asIntegrated(q, {
  lenses: [], questions: [],
  constraint_map: [...q.criteria, ...q.constraints].map((c) => ({ constraint_id: c.id, handled_by: [q.given_lenses[0].id] })),
})
export const noProposalAct = (over = {}) => planAct({ plan: noProposal, integrate: noProposal, ...over })
// 計画の段（計画役 2 体 → 統合）を noProposalAct で流し、計画を受理した所で止める（次の next がファイルの段を開く。ここでは開かない）。
// 流した呼び出しの記録を返す。
export async function passPlan(state, { maxSteps = 6 } = {}) {
  const { drive } = await import('./blackboard-fixture.mjs')
  const { readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const ledger = () => JSON.parse(readFileSync(join(state, 'ledger.json'), 'utf8'))
  const calls = []
  for (let i = 0; i < maxSteps; i++) {
    const L = ledger()
    if (L.plan && !L.plan_defects.length && !L.pending) return calls
    const r = await drive(state, noProposalAct(), { maxSteps: 1 })
    calls.push(...r.calls)
    if (r.stop) return calls
  }
  return calls
}
