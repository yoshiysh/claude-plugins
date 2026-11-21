// 新しい設計（台帳をブラックボードにする。docs/design/coverage-ledger-method.md）のテストの道具。
// 役の結果の形・claim / query / submit の argv など、テストが固定する下の層の決定は、ここ 1 か所にだけ置く（決定を変えるときはこのファイルを直す）。
// 古い test-harness.mjs（枡・applies_to・k を前提にする）には依存しない。CLI は ledger-cli.mjs を子プロセス（run）か in-process（cli）で流す。
//
// 固定する形（テストの前提）:
// - claim  --state S --call C --worker W            → { ok, done: true } | { ok, tasks: [Task], submit_cmd }
//   Task = { id, kind, result_path, unit?: { id, path, file, start, end }, lenses?: [{ id, name, procedure }], obligations?: [{ id, text }], intent?: { id, kind } }
//   kind は file・retro・alias・subject・finding・premise・goal・confirm・group と、計画の段の plan・unit_verify、全文レビューの full_review
// - query  --state S --call C --worker W --task T [--fact F ...] → { ok, basis: [Fact], related: [Fact], omitted: [id] } | { ok, facts: [Fact] }
//   Fact = { id, type, unit, path, quote, subject?, claim?, obligation?, ... }。omitted は載せなかった事実の件数（数）。ファイルの段の担当は終了状態 2 で拒む
//   goal の意図の related は、その項目の id を obligation に持つ事実だけ（結ばれていない保証は返さず、件数を omitted に宣言する）
// - submit --state S --call C --worker W            → { ok, results: [{ task, ok, problems, dropped }], missing: [task id] }
// - ingest --state S --call C --result F            （F は Workflow の返り値 { agents, tokens }）
// - 役の結果（result_path に書く JSON）
//   file:    { seen: [{ lens, answer: found|checked|not_applicable, quote }], findings: [{ lens, claim, quote, obligation, confidence, severity, layer }],
//              references: [{ claim, quote }], guarantees: [{ subject, quote, confidence, obligation? }], premises: [{ subject, quote, confidence, obligation? }] }
//              （保証・前提の obligation は任意で、義務の項目 id）
//   alias:   { same: yes|no|unsure, confidence, quote }
//   subject・finding・premise・goal・confirm: { verdict, quote, reason?, support?: [fact id], findings?: [GlobalFinding], obligation? }
//     finding の keep は obligation（義務の項目 id）が付いたときだけ確定し、付かなければ参考に入る（静的な検査の事実も同じ）
//     subject: consistent|conflict、finding: keep|drop、premise: satisfied|unsatisfied、goal: supported|gap、confirm: agree|disagree
//     GlobalFinding = { claim, locations: [{ unit, quote }], obligation, confidence, severity, layer }
//   group:   { groups: [{ id, root_cause, layer, keys: [事実の id] }], unassigned: [事実の id] }（basis は確定した指摘の事実）
//   confidence は high|medium|low
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as cliMod from './ledger-cli.mjs'

export const HERE = path.dirname(fileURLToPath(import.meta.url))
export const CLI = path.join(HERE, 'ledger-cli.mjs')
export const WF = path.join(HERE, 'coverage-audit.js')
export const ROLES = JSON.parse(readFileSync(path.join(HERE, 'roles.json'), 'utf8'))
export const INTENT_KINDS = ['alias', 'subject', 'finding', 'premise', 'goal', 'confirm', 'group']
export const INTENT_ID = /^(alias|subject|finding|premise|goal|confirm|group):[0-9a-f]+$/

export function tmp(t) {
  const d = mkdtempSync(path.join(tmpdir(), 'coverage-board-'))
  t.after(() => rmSync(d, { recursive: true, force: true }))
  return d
}
// 子プロセスで流す（振る舞いのテストの主）。
export function run(...argv) {
  const r = spawnSync(process.execPath, [CLI, ...argv], { encoding: 'utf8' })
  let out
  try { out = JSON.parse(r.stdout) } catch { out = { raw: r.stdout, stderr: r.stderr } }
  return { code: r.status, ...out }
}
// in-process で流す（多くの claim・submit を流す Workflow の駆動を速くする）。
export function cli(...argv) {
  const r = cliMod.main(argv)
  return { code: r.code, ...r.output }
}

// shell の語に分ける（'…' と "…" と \ の escape だけ）。claim の出力の submit_cmd と、prompt の claim の命令を読む。
export function shellWords(line) {
  const out = []
  let cur = null
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (/\s/.test(ch)) { if (cur !== null) { out.push(cur); cur = null } continue }
    cur = cur ?? ''
    if (ch === "'") { const j = line.indexOf("'", i + 1); cur += line.slice(i + 1, j < 0 ? line.length : j); i = j < 0 ? line.length : j; continue }
    if (ch === '"') { for (i++; i < line.length && line[i] !== '"'; i++) cur += line[i] === '\\' && i + 1 < line.length ? line[++i] : line[i]; continue }
    if (ch === '\\' && i + 1 < line.length) { cur += line[++i]; continue }
    cur += ch
  }
  if (cur !== null) out.push(cur)
  return out
}
// 文の中の ledger-cli.mjs の命令から、コマンド名と --引数の組を読む（無ければ null）。
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
export const argOf = (argv, k) => (argv && argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : undefined)

export const LENSES = [{ id: 'L1', name: '主張と根拠', procedure: '主張ごとに根拠を対応づけ、根拠の無い主張を探す' }]
export const GOAL = '- G1: 対象の文書を観点ごとに確かめた指摘の一覧\n- G2: 目標の抜けを確かめた結果\n'
export const CRITERIA = '- AC1: 指摘は目標か受け入れ基準に結ぶ\n'
export const OBLIGATIONS = ['G1', 'G2', 'AC1']

// 対象のファイル（{ 名前: 本文 }）を書いて init する。既定は coverage-build から照合済みの目標（目標の照合の役を流さない）と、利用者の観点 L1。
export function project(t, files, { lenses = LENSES, goal = GOAL, criteria = CRITERIA, phase = null, link = null, goalChecked = true, extra = [] } = {}) {
  const d = tmp(t)
  const paths = {}
  for (const [name, text] of Object.entries(files)) {
    const p = path.join(d, 'src', name)
    mkdirSync(path.dirname(p), { recursive: true })
    writeFileSync(p, text)
    paths[name] = p
  }
  writeFileSync(path.join(d, 'goal.md'), goal)
  writeFileSync(path.join(d, 'request.md'), '対象の文書を観点ごとにレビューしてほしい')
  if (criteria) writeFileSync(path.join(d, 'criteria.md'), criteria)
  if (lenses) writeFileSync(path.join(d, 'lenses.json'), JSON.stringify(lenses))
  const state = path.join(d, 'state')
  const argv = ['init', '--state', state, '--goal', path.join(d, 'goal.md'), '--request', path.join(d, 'request.md'),
    ...(criteria ? ['--criteria', path.join(d, 'criteria.md')] : []), ...(lenses ? ['--lenses', path.join(d, 'lenses.json')] : []),
    ...Object.values(paths).flatMap((p) => ['--target', p]), ...(goalChecked ? ['--goal-checked', 'coverage-build'] : []),
    ...(phase ? ['--phase', phase] : []), ...(link ? ['--link', link] : []), ...extra]
  const r = run(...argv)
  if (r.code !== 0) throw new Error(`init が通らない: ${JSON.stringify(r)}`)
  return { d, state, paths }
}

export const status = (state) => run('status', '--state', state)
// 本文の行のうち、引用に使える行（14 字以上で見出しでも fence でもない）。
export const usable = (l) => l.trim().length >= 14 && !/^#{1,6}\s/.test(l) && !/^\s*(```|~~~)/.test(l)
export const unitLines = (u) => readFileSync(u.file, 'utf8').split('\n').slice(u.start - 1, u.end)

// 既定の役の振る舞い。over で種類ごとに差し替える（関数が undefined を返せば既定、null を返せば出さない）。
// over.facts(path, lines, task) は、ファイルの段が書く { guarantees, premises, findings, references, bind } を返す。
// 既定では、義務の項目ごとに 1 件、その項目を obligation に持つ保証を足す（目標の判定の query が引ける事実を作る）。bind: false で足さない。
export function behave(over = {}) {
  return (task, ctx) => {
    const o = over[task.kind]
    if (o) { const r = o(task, ctx); if (r !== undefined) return r }
    if (task.kind === 'file' || task.kind === 'retro') return fileResult(task, over)
    // 全文レビュー（計画の段の後・ファイルの段の前に 1 体）: 既定は指摘も参考も書かない（全文レビューの振る舞いは full-review-fixture.mjs が持つ）。
    if (task.kind === 'full_review') return { findings: [], references: [] }
    if (!INTENT_KINDS.includes(task.kind)) return null
    const q = ctx.query(task)
    const facts = [...(q.basis || []), ...(q.related || [])]
    const quote = (facts.find((f) => f && f.quote) || {}).quote || ''
    if (task.kind === 'alias') return { same: 'unsure', confidence: 'low', quote }
    if (task.kind === 'subject') return { verdict: 'consistent', quote }
    if (task.kind === 'finding') return { verdict: 'keep', reason: '本文が主張を支える', quote }
    if (task.kind === 'premise') return { verdict: 'satisfied', quote }
    if (task.kind === 'goal') return { verdict: 'supported', support: facts.slice(0, 1).map((f) => f.id), quote }
    if (task.kind === 'confirm') return { verdict: 'agree', reason: '本文が判定を支える', quote }
    // 束ね: 確定した指摘の全てを 1 つの群に入れる。
    if (task.kind === 'group') return { groups: [{ id: 'g1', root_cause: '確定した指摘に共通する原因', layer: '実装', keys: (q.basis || []).map((f) => f.id) }], unassigned: [] }
    return null
  }
}
export function fileResult(task, over = {}) {
  const lines = unitLines(task.unit)
  const q = lines.find(usable) || lines.find((l) => l.trim()) || ''
  const extra = (over.facts && over.facts(task.unit.path, lines, task)) || {}
  const lens0 = task.lenses[0].id
  const ob0 = task.obligations[0].id
  const findings = (extra.findings || []).map((f) => ({ lens: lens0, obligation: ob0, confidence: 'high', severity: 'HIGH', layer: '実装', ...f }))
  return {
    seen: task.lenses.map((l) => ({ lens: l.id, answer: findings.some((f) => f.lens === l.id) ? 'found' : 'checked', quote: q })),
    findings,
    references: extra.references || [],
    guarantees: [...(extra.guarantees || []), ...(extra.bind === false ? [] : task.obligations.map((o) => ({ subject: `${path.basename(task.unit.path)} の本文`, quote: q, confidence: 'high', obligation: o.id })))],
    premises: extra.premises || [],
  }
}

// 1 体の worker: claim が done を返すまで、取った担当の結果を書いて submit_cmd を流す。log に claim・query・submit の出力を残す。
export async function workerLoop({ state, call, worker, role }, act, log = [], exec = cli) {
  const rec = { worker, role, claims: [], submits: [], queries: [] }
  log.push(rec)
  const ctx = {
    query: (task, facts = []) => {
      const q = exec('query', '--state', state, '--call', call, '--worker', worker, '--task', task.id, ...facts.flatMap((f) => ['--fact', f]))
      rec.queries.push({ task: task.id, kind: task.kind, out: q })
      return q.code === 0 ? q : { basis: [], related: [] }
    },
    state, call, worker,
  }
  for (let guard = 0; guard < 300; guard++) {
    const c = exec('claim', '--state', state, '--call', call, '--worker', worker)
    rec.claims.push(c)
    if (c.code !== 0 || c.done || !Array.isArray(c.tasks) || !c.tasks.length) break
    let wrote = 0
    for (const task of c.tasks) {
      const r = await act(task, ctx)
      if (r == null) continue
      mkdirSync(path.dirname(task.result_path), { recursive: true })
      writeFileSync(task.result_path, JSON.stringify(r))
      wrote++
    }
    if (!wrote) break
    const words = shellWords(String(c.submit_cmd || ''))
    const i = words.indexOf('submit')
    if (i < 0) throw new Error(`claim の submit_cmd に submit の命令が無い: ${c.submit_cmd}`)
    const s = exec(...words.slice(i))
    rec.submits.push({ tasks: c.tasks.map((x) => ({ id: x.id, kind: x.kind })), out: s })
    if (s.code !== 0) break
  }
  return rec
}

// Workflow を通さずに next → worker（args.workers の行ごとに 1 体）→ ingest を止まるまで回す。CLI の振る舞いのテストに使う。
// onCall(rec) は各呼び出しの ingest の後に呼ぶ（status を見るため）。
export async function drive(state, act, { maxSteps = 40, onCall = null, exec = cli } = {}) {
  const calls = []
  for (let i = 0; i < maxSteps; i++) {
    const n = exec('next', '--state', state)
    if (n.code !== 0 || n.stop) return { stop: n, calls }
    const args = JSON.parse(readFileSync(n.args_path, 'utf8'))
    const rec = { next: n, args, workers: [] }
    for (const w of args.workers || []) await workerLoop({ state: args.state, call: args.callId, worker: w.id, role: w.role }, act, rec.workers, exec)
    const res = { agents: (args.workers || []).map((w) => ({ role: w.role, label: `worker-${w.id}`, model: w.model, effort: w.effort, ok: true })), tokens: null }
    const f = path.join(state, `result-${args.callId}.json`)
    writeFileSync(f, JSON.stringify(res))
    rec.ingest = exec('ingest', '--state', state, '--call', args.callId, '--result', f)
    calls.push(rec)
    if (onCall) await onCall(rec)
    if (rec.ingest.code !== 0) return { stop: rec.ingest, calls }
  }
  return { stop: null, calls }
}

// 本物の Workflow source を native と同じ注入で走らせる。
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor
const BODY = readFileSync(WF, 'utf8').replace(/^export const meta = /, 'const meta = ')
const runBody = new AsyncFunction('agent', 'parallel', 'pipeline', 'phase', 'log', 'args', 'budget', BODY)
export function runScript(args, agentFn, { budget } = {}) {
  const parallel = (ts) => Promise.all(ts.map((t) => Promise.resolve().then(t).catch(() => null)))
  const pipeline = (items, fn) => Promise.all(items.map((x) => Promise.resolve().then(() => fn(x)).catch(() => null)))
  return runBody(agentFn, parallel, pipeline, () => {}, () => {}, args, budget)
}
// Workflow が起動する役の偽物: prompt の claim の命令を読み、workerLoop で台帳と読み書きする。prompt は log に残す。
// prompt に claim の命令が無い役は、内容を返り値か prompt で運ぶ形なので失敗にする。
export function scriptAgent(act, log = []) {
  return async (prompt, opts) => {
    const entry = { label: opts.label, model: opts.model, effort: opts.effort, prompt, claim: cliArgvOf(prompt, 'claim') }
    log.push(entry)
    if (!entry.claim) throw new Error(`役の prompt に ledger-cli.mjs claim の命令が無い: ${opts.label}`)
    entry.rec = await workerLoop({ state: argOf(entry.claim, 'state'), call: argOf(entry.claim, 'call'), worker: argOf(entry.claim, 'worker'), role: null }, act, [])
    return { notes: [] }
  }
}
// next → Workflow source → ingest を止まるまで回す。runWf で native の注入か runner を選ぶ。
export async function driveScript(state, agentFn, { runWf = runScript, maxSteps = 40 } = {}) {
  const steps = []
  for (let i = 0; i < maxSteps; i++) {
    const n = cli('next', '--state', state)
    if (n.code !== 0 || n.stop) return { stop: n, steps }
    const args = JSON.parse(readFileSync(n.args_path, 'utf8'))
    const res = await runWf(args, agentFn)
    const f = path.join(state, `result-${n.call_id}.json`)
    writeFileSync(f, JSON.stringify(res))
    const g = cli('ingest', '--state', state, '--call', args.callId, '--result', f)
    steps.push({ next: n, args, res, ingest: g })
    if (g.code !== 0) return { stop: g, steps }
  }
  return { stop: null, steps }
}

// claim の記録から、取った担当を平らに並べる。
export const claimedTasks = (calls) => calls.flatMap((c, ci) => c.workers.flatMap((w) => w.claims.flatMap((cl) => (cl.tasks || []).map((t) => ({ ...t, call: ci, worker: w.worker, role: w.role })))))
export const submitResults = (calls) => calls.flatMap((c) => c.workers.flatMap((w) => w.submits.flatMap((s) => (s.out.results || []))))
