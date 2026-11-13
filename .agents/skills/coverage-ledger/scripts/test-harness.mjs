// テストの道具: 本物の Workflow source を native と同じ注入で走らせ、役は prompt を読んで返す偽物にする。
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { main } from './ledger-cli.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const WF = path.join(HERE, 'coverage-ledger.js')
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor
const BODY = readFileSync(WF, 'utf8').replace(/^export const meta = /, 'const meta = ')
const runBody = new AsyncFunction('agent', 'parallel', 'pipeline', 'phase', 'log', 'args', 'budget', BODY)

export function tmp(t) {
  const d = mkdtempSync(path.join(tmpdir(), 'coverage-ledger-'))
  t.after(() => rmSync(d, { recursive: true, force: true }))
  return d
}
export function cli(...argv) {
  const r = main(argv)
  return { code: r.code, ...r.output }
}

// 本文の「N| 行」を取り出す。
export const bodyLines = (prompt) => prompt.split('\n').map((l) => /^(\d+)\| (.*)$/.exec(l)).filter(Boolean).map((m) => m[2])
const usable = (l) => l.replace(/^#+\s*/, '').trim().length >= 14 && !/^#{1,6}\s/.test(l)
export const evidenceOf = (prompt) => bodyLines(prompt).filter(usable)
export const jsonAfter = (prompt, head) => {
  const i = prompt.indexOf(head)
  const rest = prompt.slice(i + head.length).trimStart()
  const end = rest.indexOf('\n#')
  return JSON.parse(end < 0 ? rest : rest.slice(0, end))
}
export const itemsIn = (prompt) => [...prompt.matchAll(/^#### (\S+)(?: \[[^\]]*\])?\n([^\n]+)/gm)].map((m) => ({ id: m[1], text: m[2] }))

// 既定の振る舞い: どの役も、検査を通る最小の返り値を返す。over[role] で差し替える（null を返すと欠測）。
export function mockAgent(over = {}, log = []) {
  return async (prompt, opts) => {
    log.push({ label: opts.label, model: opts.model, effort: opts.effort, prompt })
    const role = opts.label.replace(/[-（].*$/, '')
    const name = opts.label.split('（')[0]
    if (over[name]) { const r = over[name](prompt, opts, log); if (r !== undefined) return r }
    if (over[role]) { const r = over[role](prompt, opts, log); if (r !== undefined) return r }
    if (role === 'goal') return { ok: true, problems: [] }
    if (role === 'plan') return { issues: [{ id: 'T1', title: '一つ目', question: 'q1', why: 'w', depends_on: [] }, { id: 'T2', title: '二つ目', question: 'q2', why: 'w', depends_on: ['T1'] }], lenses: [{ id: 'X1', name: '整合', procedure: '主張と根拠を対応づけて食い違いを探す' }], questions: [], constraint_map: constraintMap(prompt) }
    if (role === 'integrate') {
      const sources = [...prompt.matchAll(/"id":"(T\d|X\d)"/g)].map((m) => m[1])
      const who = [...prompt.matchAll(/^### ([AB])（/gm)].map((m) => m[1])
      const prev = prompt.includes('### 前の計画')
      const src = prev ? [...new Set(sources)].map((id) => `P:${id}`) : who.flatMap((w) => ['T1', 'T2', 'X1'].map((id) => `${w}:${id}`))
      const defects = prompt.includes('### 欠陥（index') ? jsonAfter(prompt, '### 欠陥（index は配列の位置）') : []
      return { issues: [{ id: 'T1', title: '一つ目', question: 'q1', why: 'w', depends_on: [] }, { id: 'T2', title: '二つ目', question: 'q2', why: 'w', depends_on: ['T1'] }], lenses: [{ id: 'X1', name: '整合', procedure: '主張と根拠を対応づけて食い違いを探す' }], questions: [], constraint_map: constraintMap(prompt), source_map: src.map((s) => ({ source: s, merged_into: s.split(':')[1], dropped_reason: '' })), defect_responses: defects.map((d) => ({ defect_index: d.index, action: 'fixed', reason: '直した' })) }
    }
    if (role === 'route') return { routes: itemsIn(prompt).map((it, n) => ({ input_id: it.id, dest: prompt.includes('"issues":[{') ? 'issue' : 'lens', target: prompt.includes('"issues":[{') ? (n % 2 ? 'T2' : 'T1') : (/"lenses":\["([^"]+)"/.exec(prompt) || [])[1] || 'purpose', reason: '', quote: it.text.slice(0, 20) })) }
    if (role === 'verify' && opts.label.startsWith('verify-unit-')) return { unit_id: opts.label.slice('verify-unit-'.length).split('（')[0], defects: [] }
    if (role === 'propose') {
      const id = /実行役（論点 (\S+) だけ）/.exec(prompt)[1]
      return { issue_id: id, decision: `${id} の決定`, rationale: '理由', alternatives: [], assumptions: [], read: itemsIn(prompt).map((it) => ({ input_id: it.id, quote: it.text.slice(0, 20) })), open_questions_for_user: [] }
    }
    if (role === 'write') {
      const defects = prompt.includes('成果物に戻ってきた欠陥') ? jsonAfter(prompt, '（index は配列の位置。全てに fixed か rejected と理由を返す）') : []
      return { markdown: '# 成果物\n\n## 一つ目の節\n\nこの節は論点一つ目の決定を書いた本文の行である。\n\n## 二つ目の節\n\nこの節は論点二つ目の決定を書いた本文の行である。\n', sections: [{ heading: '一つ目の節', issue_ids: ['T1'] }, { heading: '二つ目の節', issue_ids: ['T2'] }], conflicts_between_issues: [], defect_responses: defects.map((d) => ({ defect_index: d.index, action: 'fixed', reason: '直した' })) }
    }
    if (role === 'read') return { cell_id: opts.label.slice('read-'.length).split('（')[0], evidence: evidenceOf(prompt), findings: [], outside_notes: [], none_reason: '手続きに沿って全て読み、該当が無かった' }
    if (role === 'verify') {
      const fs = jsonAfter(prompt, '### 指摘（index は配列の位置）')
      return { verdicts: fs.map((f) => ({ index: f.index, verdict: 'confirmed', reason: '本文が支える', quote: f.quote })) }
    }
    if (role === 'group') {
      const items = jsonAfter(prompt, '### 全件')
      return { groups: [{ id: 'g1', root_cause: '根の原因', layer: '実装', keys: items.map((x) => x.key), pattern: '' }], unassigned: [] }
    }
    if (role === 'refute') return { group_id: 'g1', refuted: false, reason: '確かめられない' }
    throw new Error(`想定しない役: ${opts.label}`)
  }
}
function constraintMap(prompt) {
  const ids = [...prompt.matchAll(/^ {2}- ([A-Z][A-Z0-9-]*\d[\w-]*): /gm)].map((m) => m[1])
  return ids.map((id) => ({ constraint_id: id, handled_by: ['purpose'] }))
}

export async function runWorkflow(args, agentFn) {
  const parallel = (ts) => Promise.all(ts.map((t) => Promise.resolve().then(t).catch(() => null)))
  const pipeline = (items, fn) => Promise.all(items.map((x) => Promise.resolve().then(() => fn(x)).catch(() => null)))
  return runBody(agentFn, parallel, pipeline, () => {}, () => {}, args, undefined)
}

// next → Workflow → ingest を止まるまで回す。
export async function drive(state, agentFn, maxSteps = 30) {
  const steps = []
  for (let i = 0; i < maxSteps; i++) {
    const n = cli('next', '--state', state)
    if (n.code !== 0 || n.stop) return { stop: n, steps }
    const args = JSON.parse(readFileSync(n.args_path, 'utf8'))
    const res = await runWorkflow(args, agentFn)
    const rp = path.join(state, `result-${n.call_id}.json`)
    writeFileSync(rp, JSON.stringify(res))
    const g = cli('ingest', '--state', state, '--result', rp)
    steps.push({ step: n.step, args, res, ingest: g })
    if (g.code !== 0) return { stop: g, steps }
  }
  return { stop: null, steps }
}
