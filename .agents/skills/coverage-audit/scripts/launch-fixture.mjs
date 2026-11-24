// 起動を減らした設計（docs/design/coverage-ledger-method.md「モデルと費用」の起動の原則、決定 16）のテストの道具。
// launch.test.mjs だけが使う。blackboard-fixture.mjs と plan-roles.mjs の既存の形と既定は変えず、ここに新しい役の結果の形を 1 か所にまとめる。
//
// ここで固定する下の層の決定（変えるときはこのファイルを直す）:
// - 役の名前: planner・unit_verifier・file_reader・global_judge・confirmer（roles.json の key）。振り返りの役の名前は固定しない（段 retro で見分ける）。
// - 段の名前（args.stage）: plan・unit_verify・file・global・retro。束ね・反証・統合・目標の照合の段（group・refute・integrate・goal_check）は無い。
// - 担当の種類（task.kind）:
//   plan（計画役 1 体。目標の照合も担う）: query の inputs は今の plan の inputs に、目標の照合が要るときだけ request・item_ids（今の goal_check の名前）を足したもの。
//     結果は { lenses, questions, constraint_map, outcomes?, defect_responses? }。outcomes は目標の照合が要るとき（inputs に item_ids があるとき）だけ、
//     今の checkGoalMap の形。defect_responses は inputs.defects があるとき（観点の検証役の欠陥から計画に戻ったとき）だけ。
//   unit_verify（観点の検証役 1 体。担当は計画の版で 1 つ）: query の inputs.lenses は確かめる観点の配列（変わった観点だけ）。
//     結果は { lenses: [{ unit_id, answers }] }（要素は今の 1 観点の結果の形）。
//   file（ファイルの段）: 1 体が詰め合わせの全ての単位を読む。task は今と同じく 1 単位（unit）を持ち、1 つの claim が返すか複数の claim で返すかは固定しない。
//   group（束ねの意図）: query の basis は確定した指摘の事実。結果は { groups: [{ id, root_cause, layer, keys: [事実の id] }], unassigned: [事実の id] }。
//     pattern・applies_to・extends は無い。
//   retro（振り返り）: task は file と同じ形（unit・lenses・obligations?）で、unit は出来事の写し。結果も file と同じ形。
// - status の欄: 振り返りの結果は status.retro.findings（claim を持つ要素の配列）。
// - query が返す事実のうち unit を持つものは、写しの file（stateDir/snap/ の下）と start・end を持つ。
//
// 今の実装の古い種類（goal_check・integrate・refute・lateral・1 観点の unit_verify・K<n> の group）にも既定を置く。
// 今の実装でも run が止まるまで進み、テストが assertion で落ちるようにするため（未知の種類で worker が止まって時間切れにならない）。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { behave, drive, launchesOf, project, unitLines, usable } from './blackboard-fixture.mjs'
import { asIntegrated, lensPlan, unitAnswers } from './plan-roles.mjs'

export const NEW_ROLES = ['planner', 'unit_verifier', 'file_reader', 'global_judge', 'confirmer']
export const GONE_ROLES = ['goal_checker', 'planner_a', 'planner_b', 'integrator', 'alias_judge', 'grouper', 'refuter_a', 'refuter_b']
export const GONE_STAGES = ['goal_check', 'integrate', 'group', 'refute']
const DONE_INTENTS = ['alias', 'subject', 'finding', 'premise', 'goal', 'confirm']

// 依頼文（project が書く request.md）を引用した単独の目標。coverage-build を通さない台帳（--goal-checked なし）に使う。
export const STANDALONE_GOAL = '- G1: 対象の文書を観点ごとに確かめた指摘の一覧 〔request: 対象の文書を観点ごとにレビューしてほしい〕\n'
export const standalone = (t, files, opts = {}) => project(t, files, { goalChecked: false, criteria: null, goal: STANDALONE_GOAL, ...opts })

// 計画役の結果。spec は lensPlan の観点の指定（既定は X1 を 1 つ足す）。outcomes は目標の照合が要るとき（inputs に item_ids がある）だけ付ける。
export function planResult(q, { spec = { X1: {} }, outcomes = null, questions = [] } = {}) {
  const ids = Object.keys(spec)
  const plan = lensPlan(spec, [ids.at(-1)])(q)
  return {
    ...asIntegrated(q, { ...plan, questions }),
    ...(Array.isArray(q.item_ids) ? { outcomes: outcomes ? outcomes(q) : [{ outcome: '依頼の全体', quotes: [{ source: 'request', quote: q.request }], items: q.item_ids }] } : {}),
    ...(Array.isArray(q.defects) ? { defect_responses: q.defects.map((d, i) => ({ defect_index: d.index ?? i, action: 'fixed', reason: '直した' })) } : {}),
  }
}
// 観点の検証役の結果。新しい形（inputs.lenses）と今の 1 観点の形（inputs.lens）の両方を作る。noFor(lens, key) で no にする問いを選ぶ。
export function verifyResult(q, noFor = () => false) {
  if (Array.isArray(q.lenses)) return { lenses: q.lenses.map((l) => unitAnswers(l, (k) => noFor(l, k))) }
  return unitAnswers(q.lens, (k) => noFor(q.lens, k))
}
// 束ねの結果。新しい形は basis の事実の id を keys にする。今の形（inputs.items の K<n>）にも答える。
export function groupResult(q, { layer = '実装', root_cause = '確定した指摘に共通する原因' } = {}) {
  if (q && q.inputs && Array.isArray(q.inputs.items)) return { groups: [{ id: 'g1', root_cause, layer, keys: q.inputs.items.map((x) => x.key), pattern: '', applies_to: [] }], unassigned: [] }
  const keys = ((q && q.basis) || []).map((f) => f.id)
  return { groups: [{ id: 'g1', root_cause, layer, keys }], unassigned: [] }
}
// 振り返りの結果（file と同じ形）。findings に振り返りの指摘を足せる（obligation は担当が義務を渡すときだけ付ける）。
export function retroResult(task, findings = []) {
  const lines = unitLines(task.unit)
  const q = lines.find(usable) || lines.find((l) => l.trim()) || ''
  const lens0 = task.lenses[0].id
  const ob0 = task.obligations && task.obligations[0] ? task.obligations[0].id : undefined
  const fs = findings.map((f) => ({ lens: lens0, quote: q, confidence: 'high', severity: 'HIGH', layer: '実装', ...(ob0 ? { obligation: ob0 } : {}), ...f }))
  return {
    seen: task.lenses.map((l) => ({ lens: l.id, answer: fs.some((f) => f.lens === l.id) ? 'found' : 'checked', quote: q })),
    findings: fs, references: [], guarantees: [], premises: [],
  }
}

// 役の偽物。over の key と受ける値:
// - plan(inputs, task)・unit_verify(inputs, task)・group(query の出力, task)・retro(task, ctx): 結果を返す（undefined なら既定）。
// - file・意図の種類（alias・subject・finding・premise・goal・confirm）と facts: blackboard-fixture の behave にそのまま渡す。
// - planOpts: planResult の options。retroFindings: 振り返りの既定の結果に足す指摘。groupOpts: groupResult の options。
export function act(over = {}) {
  const passthrough = Object.fromEntries(Object.entries(over).filter(([k]) => k === 'facts' || k === 'file' || DONE_INTENTS.includes(k)))
  const base = behave(passthrough)
  return async (task, ctx) => {
    const inputsOf = () => { const q = ctx.query(task); return q.inputs || q }
    if (task.kind === 'plan' || task.kind === 'integrate') {
      const q = inputsOf()
      const r = over.plan ? over.plan(q, task) : undefined
      return r !== undefined ? r : planResult(q, over.planOpts)
    }
    if (task.kind === 'goal_check') {
      const q = inputsOf()
      const o = over.planOpts && over.planOpts.outcomes
      return { outcomes: o ? o(q) : [{ outcome: '依頼の全体', quotes: [{ source: 'request', quote: q.request }], items: q.item_ids }] }
    }
    if (task.kind === 'unit_verify') {
      const q = inputsOf()
      const r = over.unit_verify ? over.unit_verify(q, task) : undefined
      return r !== undefined ? r : verifyResult(q)
    }
    if (task.kind === 'group') {
      const q = ctx.query(task)
      const r = over.group ? over.group(q, task) : undefined
      return r !== undefined ? r : groupResult(q, over.groupOpts)
    }
    if (task.kind === 'refute') return { group_id: task.group, refuted: false, reason: '確かめられない' }
    if (task.kind === 'lateral') return { verdict: 'none', quote: (unitLines(task.unit).find(usable) || '') }
    if (task.kind === 'retro') {
      const r = over.retro ? over.retro(task, ctx) : undefined
      return r !== undefined ? r : retroResult(task, over.retroFindings || [])
    }
    // 今の実装の振り返り（retro: の単位をファイルの段が読む）は file の既定で答える。
    if (task.kind === 'file' && task.unit && String(task.unit.id).startsWith('retro:')) return retroResult(task, over.retroFindings || [])
    return base(task, ctx)
  }
}

// next → 波（行ごとに 1 体）→ ingest を、止まるか until(rec) が真になるまで回す（in-process）。rec は波ごとに 1 件で、形は blackboard-fixture.mjs の drive。
export const driveUntil = (state, a, { until = () => false, maxSteps = 40 } = {}) => drive(state, a, { until, maxSteps })

// driveScript の steps と scriptAgent の log から、起動した 1 体ごとに並べる（形は blackboard-fixture.mjs の launchesOf）。
export { launchesOf }
// driveUntil の calls（波ごと）から、worker ごとに { stage, role, call, worker, tasks（取った担当を平らに）, submits } を並べる。
export function workersOf(calls) {
  return calls.flatMap((c) => c.workers.map((w) => ({
    stage: c.stage, role: w.role, call: c.args.callId, worker: w.worker,
    tasks: w.claims.flatMap((cl) => cl.tasks || []), submits: w.submits, queries: w.queries,
  })))
}

// ASCII の行で bytes バイト前後の Markdown を作る（見出し 1 行と、引用に使える本文の行）。行は名前を含むので単位ごとに違う。
export function sizedDoc(name, bytes) {
  const head = `# ${name}\n\n`
  const rows = []
  let n = Buffer.byteLength(head)
  for (let i = 0; n < bytes; i++) {
    const l = `- ${name} line ${String(i).padStart(6, '0')}: this body line is part of the packing check text.\n`
    rows.push(l)
    n += Buffer.byteLength(l)
  }
  return head + rows.join('')
}
export const writeFile = (p, text) => { mkdirSync(path.dirname(p), { recursive: true }); writeFileSync(p, text) }
