// テストの道具: 本物の Workflow source を native と同じ注入で走らせ、役は prompt と写しを読んで返す偽物にする。
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
// 束の節（## 見出し）ごとの項目の行「  - <id>: <本文>」を読む。heads は節の見出しの先頭の文字列。
function itemsIn(prompt, heads) {
  const out = []
  let on = false
  for (const l of prompt.split('\n')) {
    if (/^## /.test(l)) on = heads.some((h) => l.startsWith(`## ${h}`))
    const m = on && /^ {2}- ([A-Z][A-Z0-9-]*\d[\w-]*): (.*)$/.exec(l)
    if (m && !out.some((x) => x.id === m[1])) out.push({ id: m[1], text: m[2] })
  }
  return out
}
// 束の「目標の項目」「受け入れ基準」の項目（観点の goals に使う）。part に本文をそのまま使えば逐語の照合を通る。
export const goalItemsOf = (prompt) => itemsIn(prompt, ['目標の項目', '受け入れ基準'])
export const goalsOf = (prompt) => goalItemsOf(prompt).map((g) => ({ id: g.id, part: g.text }))
// 束の「受け入れ基準」「固定した制約」の節の項目の id（constraint_map に使う。目標の項目は含めない）。
export const constraintIdsOf = (prompt) => itemsIn(prompt, ['受け入れ基準', '固定した制約']).map((x) => x.id)
// 観点の検証役の prompt（束を含む）の「### 本文（観点）」の観点。
export const unitOf = (prompt) => JSON.parse(prompt.slice(prompt.indexOf('### 本文（観点）\n') + '### 本文（観点）\n'.length).split('\n')[0])
// 閉じた問いの答え: Q1・Q2 と、goals の要素ごとの Q3（goal_index は goals の位置）。
// no にする問いを noFor(key) で選ぶ（key は Q1・Q2・Q3:<goal_index>）。引用は観点の手続き。
export function unitAnswers(prompt, noFor = () => false) {
  const u = unitOf(prompt)
  const qs = [{ question: 'Q1' }, { question: 'Q2' }, ...(u.goals || []).map((g, i) => ({ question: 'Q3', goal_index: i, goal_id: g.id }))]
  return { unit_id: u.id, answers: qs.map((q) => ({ ...q, answer: noFor(q.question === 'Q3' ? `Q3:${q.goal_index}` : q.question) ? 'no' : 'yes', quote: u.procedure })) }
}
// 計画役・統合役の prompt の索引（1 行 1 資産、先頭の欄が資産の id）から、資産の id を読む。
export const indexIds = (prompt) => bodyLines(prompt).map((l) => l.split('\t')[0]).filter(Boolean)

// 観点の精査役（label は lens-review-<観点の id>）の問いの行「- N1（asset: <資産の id>）」「- N2（lens: <観点の id>）」を読む。
export const lensIdOf = (opts) => opts.label.slice('lens-review-'.length).split('（')[0]
export function lensQuestions(prompt) {
  const uniq = (xs) => [...new Set(xs)]
  return {
    assets: uniq([...prompt.matchAll(/^- N1（asset: (.+?)）/gm)].map((m) => m[1])),
    others: uniq([...prompt.matchAll(/^- N2（lens: (.+?)）/gm)].map((m) => m[1])),
  }
}
// 索引の行（id・写し・範囲 …のタブ区切り）を、prompt の行と、prompt が指す全ての写しの範囲から探し、その資産の本文の行を読む。
// 問いの資産の id が対象の基準からの相対でも引けるよう、末尾の一致も見る。
function assetLines(prompt, id) {
  const refs = [...prompt.matchAll(/^写し: (.+)\n行: (\d+)-(\d+)/gm)].flatMap((m) => readFileSync(m[1], 'utf8').split('\n').slice(Number(m[2]) - 1, Number(m[3])))
  const rows = [...prompt.split('\n'), ...refs].map((l) => l.split('\t')).filter((c) => c.length >= 3 && /^\d+-\d+$/.test(c[2]))
  const row = rows.find((c) => c[0] === id) || rows.find((c) => c[0].endsWith(id))
  if (!row) return []
  const [s, e] = row[2].split('-').map(Number)
  return readFileSync(row[1], 'utf8').split('\n').slice(s - 1, e)
}
// 精査役の答え: N1 は当てた資産ごと、N2 は他の計画の観点ごと。引用は資産の本文の行。
// no にする N1 の資産を n1No(asset) で、yes にする N2 の観点を n2Yes(lens)（{quote_self, quote_other} を返す）で選ぶ。
export function lensAnswers(prompt, opts, { n1No = () => false, n2Yes = () => null } = {}) {
  const { assets, others } = lensQuestions(prompt)
  return {
    lens_id: lensIdOf(opts),
    n1: assets.map((a) => {
      const ls = assetLines(prompt, a)
      const quote = ls.find(usable) || ls.find((l) => l.trim()) || ''
      return { asset: a, answer: n1No(a) ? 'no' : 'yes', quote }
    }),
    n2: others.map((o) => { const y = n2Yes(o); return y ? { lens: o, answer: 'yes', ...y } : { lens: o, answer: 'no' } }),
  }
}

// 担当が prompt の「束: <file>（hash …）」を Read するのと同じく、束の中身を prompt の後ろに足す（束の行は 写し:/行: と別の形）。
const withBriefs = (prompt) => [prompt, ...[...prompt.matchAll(/^束: (.+?)（hash /gm)].map((m) => readFileSync(m[1], 'utf8'))].join('\n')

// shell の語に分ける（'…' と "…" と \ の escape だけを扱う）。worker が流す CLI の命令を読むのに使う。
export function shellWords(line) {
  const out = []
  let cur = null
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (/\s/.test(ch)) { if (cur !== null) { out.push(cur); cur = null } continue }
    cur = cur ?? ''
    if (ch === "'") { const j = line.indexOf("'", i + 1); cur += line.slice(i + 1, j < 0 ? line.length : j); i = j < 0 ? line.length : j; continue }
    if (ch === '"') {
      for (i++; i < line.length && line[i] !== '"'; i++) cur += line[i] === '\\' && i + 1 < line.length ? line[++i] : line[i]
      continue
    }
    if (ch === '\\' && i + 1 < line.length) { cur += line[++i]; continue }
    cur += ch
  }
  if (cur !== null) out.push(cur)
  return out
}
// 文の中の ledger-cli.mjs の命令（例: node …/ledger-cli.mjs claim --state … --call … --worker …）から、コマンド名と --引数の組を読む。
export function cliArgvOf(text, cmd) {
  for (const line of String(text).split('\n')) {
    if (!line.includes('ledger-cli.mjs')) continue
    const w = shellWords(line.replace(/`/g, ' '))
    const i = w.indexOf(cmd)
    if (i < 0) continue
    const out = [cmd]
    for (let j = i + 1; j + 1 < w.length && w[j].startsWith('--'); j += 2) out.push(w[j], w[j + 1])
    return out
  }
  return null
}
const argOf = (argv, k) => argv[argv.indexOf(`--${k}`) + 1]

// 長く動く worker の偽物: prompt の claim の命令を in-process の CLI で流し、取った資産の枡ごとに、
// 枡 1 つ分の擬似の prompt（写しの範囲・観点の束・検証では指摘）で読む役（label read-<cell_id>）か検証役（verify-<cell_id>）を呼ぶ。
// 結果を result_path に書き、submit_cmd を in-process で流す。拒否されたら 1 回だけ呼び直して出し直す。null の枡は提出せず（欠測）、その worker はそこで終える。
// claim が空を返したら終わる。log.claims に claim の出力、log.workers に worker の起動と終わりの位置（log の長さ）を残す。
async function fakeWorker(raw, opts, claimArgv, self, log) {
  const claims = (log.claims = log.claims || [])
  const span = { label: opts.label, worker: argOf(claimArgv, 'worker'), call: argOf(claimArgv, 'call'), model: opts.model, start: log.length - 1, end: null }
  ;(log.workers = log.workers || []).push(span)
  let assets = 0, submitted = 0, rejected = 0
  const notes = []
  let quit = false
  for (let guard = 0; guard < 500 && !quit; guard++) {
    const c = cli(...claimArgv)
    claims.push({ worker: span.worker, out: c })
    if (c.code !== 0) { notes.push(`claim が拒否された: ${c.error}`); break }
    if (c.done) break
    assets++
    for (const cell of c.cells) {
      const verify = Array.isArray(cell.findings)
      const label = `${verify ? 'verify' : 'read'}-${cell.cell_id}`
      const pseudo = `## ${verify ? '検証役' : '読む役'}（枡 ${cell.cell_id} だけ）
観点: ${cell.lens}
束: ${cell.brief}（hash -）
### 本文の範囲（元のファイル: ${c.asset.path}）
写し: ${c.asset.file}
行: ${c.asset.start}-${c.asset.end}
${verify ? `### 指摘（index は配列の位置）\n${JSON.stringify(cell.findings.map((f, i) => ({ index: i, ...f })))}\n` : ''}`
      const one = (lab) => self(pseudo, { label: lab, phase: opts.phase, model: opts.model, effort: opts.effort, fromWorker: true })
      let r = await one(label)
      // 出さない枡が出たら、その worker はそこで終える（未提出の claim を持つ worker の claim し直しは同じ枡を返すので、続けると回り続ける）。
      if (r == null) { notes.push(`${cell.cell_id} を出さずに終えた`); quit = true; break }
      for (let tries = 0; r != null && tries < 2; tries++) {
        mkdirSync(path.dirname(cell.result_path), { recursive: true })
        writeFileSync(cell.result_path, JSON.stringify(r))
        const sa = cliArgvOf(cell.submit_cmd, 'submit')
        if (!sa) throw new Error(`submit_cmd に submit の命令が無い: ${cell.submit_cmd}`)
        const s = cli(...sa)
        if (s.code !== 0) { notes.push(`submit が拒否された: ${s.error}`); break }
        if (s.ok) { submitted++; break }
        rejected++
        if (s.dropped) break
        r = await one(`${label}（出し直し）`)
      }
    }
  }
  span.end = log.length
  return { assets, submitted, rejected, notes }
}

// 既定の振る舞い: どの役も、検査を通る最小の返り値を返す。over[role] で差し替える（null を返すと欠測）。
// prompt に ledger-cli.mjs の claim の命令がある役は長く動く worker として扱い、over.worker だけで差し替える（読む役・検証役の枡ごとの差し替えは over.read・over.verify）。
// log の prompt は束を読んだ後の全文、raw は Workflow が渡した prompt そのもの。
export function mockAgent(over = {}, log = []) {
  const self = async (raw, opts) => {
    const prompt = withBriefs(raw)
    log.push({ label: opts.label, model: opts.model, effort: opts.effort, prompt, raw })
    const claimArgv = cliArgvOf(prompt, 'claim')
    if (claimArgv) {
      if (over.worker) { const r = over.worker(prompt, opts, log); if (r !== undefined) return r }
      return fakeWorker(raw, opts, claimArgv, self, log)
    }
    const role = opts.label.replace(/[-（].*$/, '')
    const name = opts.label.split('（')[0]
    // 枡ごとの読む役・検証役は、偽の worker の中からだけ呼ばれる（Workflow が枡ごとに起動する前の形は受け付けない）。
    if ((role === 'read' || (role === 'verify' && !opts.label.startsWith('verify-unit-'))) && !opts.fromWorker) throw new Error(`review の段が worker の形でない（枡ごとの役を Workflow が直接起動した）: ${opts.label}`)
    if (over[name]) { const r = over[name](prompt, opts, log); if (r !== undefined) return r }
    if (over[role]) { const r = over[role](prompt, opts, log); if (r !== undefined) return r }
    const lenses = [{ id: 'X1', name: '整合', procedure: '主張と根拠を対応づけて食い違いを探す', applies_to: indexIds(prompt), goals: goalsOf(prompt) }]
    if (role === 'goal') return { outcomes: [{ outcome: '依頼の全体', quotes: [{ source: 'request', quote: requestOf(prompt) }], items: goalIds(prompt) }] }
    if (role === 'plan') return { lenses, excluded: [], questions: [], constraint_map: constraintMap(prompt) }
    if (role === 'integrate') {
      const who = [...prompt.matchAll(/^### ([AB])（/gm)].map((m) => m[1])
      const prev = prompt.includes('### 前の計画')
      const src = prev ? ['P:X1'] : who.map((w) => `${w}:X1`)
      const defects = prompt.includes('### 欠陥（index') ? jsonAfter(prompt, '### 欠陥（index は配列の位置）') : []
      return { lenses, excluded: [], questions: [], constraint_map: constraintMap(prompt), source_map: src.map((s) => ({ source: s, merged_into: 'X1', dropped_reason: '' })), defect_responses: defects.map((d) => ({ defect_index: d.index, action: 'fixed', reason: '直した' })) }
    }
    if (role === 'verify' && opts.label.startsWith('verify-unit-')) return unitAnswers(prompt)
    // 観点の精査役の既定: N1 は全て yes、N2 は全て no。
    if (role === 'lens' && opts.label.startsWith('lens-review-')) return lensAnswers(prompt, opts)
    if (role === 'read') return { cell_id: opts.label.slice('read-'.length).split('（')[0], evidence: evidenceOf(prompt), findings: [], outside_notes: [], none_reason: '手続きに沿って全て読み、該当が無かった' }
    if (role === 'verify') {
      const fs = jsonAfter(prompt, '### 指摘（index は配列の位置）')
      return { verdicts: fs.map((f) => ({ index: f.index, verdict: 'confirmed', reason: '本文が支える', quote: f.quote })) }
    }
    if (role === 'group') return { groups: [{ id: 'g1', root_cause: '根の原因', layer: '実装', keys: groupItems(prompt).map((x) => x.key), pattern: '', applies_to: [] }], unassigned: [] }
    if (role === 'refute') return { group_id: 'g1', refuted: false, reason: '確かめられない' }
    throw new Error(`想定しない役: ${opts.label}`)
  }
  return self
}
function constraintMap(prompt) {
  return constraintIdsOf(prompt).map((id) => ({ constraint_id: id, handled_by: ['purpose'] }))
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
