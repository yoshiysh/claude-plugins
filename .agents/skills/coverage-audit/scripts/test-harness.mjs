// テストの道具: 本物の Workflow source を native と同じ注入で走らせ、役は prompt と写しを読んで返す偽物にする。
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { main } from './ledger-cli.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const WF = path.join(HERE, 'coverage-audit.js')
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor
const BODY = readFileSync(WF, 'utf8').replace(/^export const meta = /, 'const meta = ')
const runBody = new AsyncFunction('agent', 'parallel', 'pipeline', 'phase', 'log', 'args', 'budget', BODY)

export function tmp(t) {
  const d = mkdtempSync(path.join(tmpdir(), 'coverage-audit-'))
  t.after(() => rmSync(d, { recursive: true, force: true }))
  return d
}
export function cli(...argv) {
  const r = main(argv)
  return { code: r.code, ...r.output }
}

// prompt の「写し: <file>」「行: s-e」が指す範囲の行を、担当が Read するのと同じく写しのファイルから読む。
function bodyLines(prompt) {
  const f = /^写し: (.+)$/m.exec(prompt)
  const r = /^行: (\d+)-(\d+)/m.exec(prompt)
  if (!f || !r) return []
  return readFileSync(f[1], 'utf8').split('\n').slice(Number(r[1]) - 1, Number(r[2]))
}
const usable = (l) => l.replace(/^#+\s*/, '').trim().length >= 14 && !/^#{1,6}\s/.test(l)
export const evidenceOf = (prompt) => bodyLines(prompt).filter(usable)
const jsonAfter = (prompt, head) => {
  const i = prompt.indexOf(head)
  const rest = prompt.slice(i + head.length).trimStart()
  const end = rest.indexOf('\n#')
  return JSON.parse(end < 0 ? rest : rest.slice(0, end))
}
export const requestOf = (prompt) => prompt.slice(prompt.indexOf('## 依頼文\n') + '## 依頼文\n'.length, prompt.indexOf('\n## 決定の記録')).trim()
export const goalIds = (prompt) => JSON.parse(prompt.slice(prompt.indexOf('## 項目の id（items に使う）\n') + '## 項目の id（items に使う）\n'.length).split('\n')[0])
export const groupItems = (prompt) => bodyLines(prompt).map((l) => JSON.parse(l))
// 計画役・統合役の prompt の「目標・受け入れ基準の id（goals に使う）」の一覧。
export const goalItemIdsOf = (prompt) => { const h = '### 目標・受け入れ基準の id（goals に使う）\n'; const i = prompt.indexOf(h); return i < 0 ? [] : JSON.parse(prompt.slice(i + h.length).split('\n')[0]) }
// 束の「受け入れ基準」「固定した制約」の節の項目の id（constraint_map に使う。目標の項目は含めない）。
export function constraintIdsOf(prompt) {
  const ids = []
  let on = false
  for (const l of prompt.split('\n')) {
    if (/^## /.test(l)) on = /^## (受け入れ基準|固定した制約)/.test(l)
    const m = on && /^ {2}- ([A-Z][A-Z0-9-]*\d[\w-]*): /.exec(l)
    if (m && !ids.includes(m[1])) ids.push(m[1])
  }
  return ids
}
// 観点の検証役の prompt（束を含む）の「### 本文（観点）」の観点。
export const unitOf = (prompt) => JSON.parse(prompt.slice(prompt.indexOf('### 本文（観点）\n') + '### 本文（観点）\n'.length).split('\n')[0])
// 閉じた問いの答え: Q1・Q2 と goals ごとの Q3。no にする問いを noFor(key) で選ぶ（key は Q1・Q2・Q3:<goal>）。引用は観点の手続き。
export function unitAnswers(prompt, noFor = () => false) {
  const u = unitOf(prompt)
  const qs = [{ question: 'Q1' }, { question: 'Q2' }, ...(u.goals || []).map((g) => ({ question: 'Q3', goal_id: g }))]
  return { unit_id: u.id, answers: qs.map((q) => ({ ...q, answer: noFor(q.question === 'Q3' ? `Q3:${q.goal_id}` : q.question) ? 'no' : 'yes', quote: u.procedure })) }
}
// 計画役・統合役の prompt の索引（1 行 1 資産、先頭の欄が資産の id）から、資産の id を読む。
export const indexIds = (prompt) => bodyLines(prompt).map((l) => l.split('\t')[0]).filter(Boolean)

// 担当が prompt の「束: <file>（hash …）」を Read するのと同じく、束の中身を prompt の後ろに足す（束の行は 写し:/行: と別の形）。
const withBriefs = (prompt) => [prompt, ...[...prompt.matchAll(/^束: (.+?)（hash /gm)].map((m) => readFileSync(m[1], 'utf8'))].join('\n')

// 既定の振る舞い: どの役も、検査を通る最小の返り値を返す。over[role] で差し替える（null を返すと欠測）。
// log の prompt は束を読んだ後の全文、raw は Workflow が渡した prompt そのもの。
export function mockAgent(over = {}, log = []) {
  return async (raw, opts) => {
    const prompt = withBriefs(raw)
    log.push({ label: opts.label, model: opts.model, effort: opts.effort, prompt, raw })
    const role = opts.label.replace(/[-（].*$/, '')
    const name = opts.label.split('（')[0]
    if (over[name]) { const r = over[name](prompt, opts, log); if (r !== undefined) return r }
    if (over[role]) { const r = over[role](prompt, opts, log); if (r !== undefined) return r }
    const lenses = [{ id: 'X1', name: '整合', procedure: '主張と根拠を対応づけて食い違いを探す', applies_to: indexIds(prompt), goals: goalItemIdsOf(prompt) }]
    if (role === 'goal') return { outcomes: [{ outcome: '依頼の全体', quotes: [{ source: 'request', quote: requestOf(prompt) }], items: goalIds(prompt) }] }
    if (role === 'plan') return { lenses, questions: [], constraint_map: constraintMap(prompt) }
    if (role === 'integrate') {
      const who = [...prompt.matchAll(/^### ([AB])（/gm)].map((m) => m[1])
      const prev = prompt.includes('### 前の計画')
      const src = prev ? ['P:X1'] : who.map((w) => `${w}:X1`)
      const defects = prompt.includes('### 欠陥（index') ? jsonAfter(prompt, '### 欠陥（index は配列の位置）') : []
      return { lenses, questions: [], constraint_map: constraintMap(prompt), source_map: src.map((s) => ({ source: s, merged_into: 'X1', dropped_reason: '' })), defect_responses: defects.map((d) => ({ defect_index: d.index, action: 'fixed', reason: '直した' })) }
    }
    if (role === 'verify' && opts.label.startsWith('verify-unit-')) return unitAnswers(prompt)
    if (role === 'read') return { cell_id: opts.label.slice('read-'.length).split('（')[0], evidence: evidenceOf(prompt), findings: [], outside_notes: [], none_reason: '手続きに沿って全て読み、該当が無かった' }
    if (role === 'verify') {
      const fs = jsonAfter(prompt, '### 指摘（index は配列の位置）')
      return { verdicts: fs.map((f) => ({ index: f.index, verdict: 'confirmed', reason: '本文が支える', quote: f.quote })) }
    }
    if (role === 'group') return { groups: [{ id: 'g1', root_cause: '根の原因', layer: '実装', keys: groupItems(prompt).map((x) => x.key), pattern: '' }], unassigned: [] }
    if (role === 'refute') return { group_id: 'g1', refuted: false, reason: '確かめられない' }
    throw new Error(`想定しない役: ${opts.label}`)
  }
}
function constraintMap(prompt) {
  const ids = constraintIdsOf(prompt)
  return ids.map((id) => ({ constraint_id: id, handled_by: ['purpose'] }))
}

// native の注入で Workflow source を 1 回流す。
export async function runWorkflow(args, agentFn) {
  const parallel = (ts) => Promise.all(ts.map((t) => Promise.resolve().then(t).catch(() => null)))
  const pipeline = (items, fn) => Promise.all(items.map((x) => Promise.resolve().then(() => fn(x)).catch(() => null)))
  return runBody(agentFn, parallel, pipeline, () => {}, () => {}, args, undefined)
}

// next → Workflow → ingest を止まるまで回す。run で Workflow の流し方（native の注入・runner）を差し替える。
export async function drive(state, agentFn, { run = runWorkflow, maxSteps = 30 } = {}) {
  const steps = []
  for (let i = 0; i < maxSteps; i++) {
    const n = cli('next', '--state', state)
    if (n.code !== 0 || n.stop) return { stop: n, steps }
    const args = JSON.parse(readFileSync(n.args_path, 'utf8'))
    const res = await run(args, agentFn)
    const rp = path.join(state, `result-${n.call_id}.json`)
    writeFileSync(rp, JSON.stringify(res))
    const g = cli('ingest', '--state', state, '--result', rp)
    steps.push({ step: n.step, args, res, ingest: g, argsBytes: Buffer.byteLength(readFileSync(n.args_path)) })
    if (g.code !== 0) return { stop: g, steps }
  }
  return { stop: null, steps }
}
