// 新しい設計（台帳をブラックボードにする。docs/design/coverage-ledger-method.md）のテストの道具。
// 役の結果の形・claim / query / submit の argv など、テストが固定する下の層の決定は、ここ 1 か所にだけ置く（決定を変えるときはこのファイルを直す）。
// 古い test-harness.mjs（枡・applies_to・k を前提にする）には依存しない。CLI は ledger-cli.mjs を子プロセス（run）か in-process（cli）で流す。
//
// 固定する形（テストの前提）:
// - next の args: { state, callId, wave: { id, rows: [{ id, role, model, effort, stage }] } }（最初の波だけ。id は CLI の連番、行の id は呼び出しの中で一意）
//   形が違う args は rowsOf・waveIdOf が throw する。
// - claim  --state S --call C --worker W --wave N --model M --effort E --stage ST
//          → { ok, tasks: [Task], submit_cmd } | { ok, done: true, next_wave?: { id, rows }, halt?: true, reason? }
//   wave・worker・model・effort・stage が台帳の波の記録と違えば終了状態 2 で拒む（台帳を変えない）。
//   done は、その worker に渡す担当が尽きた印。波の全ての担当が尽きたら、次の波（next_wave）か止まる印（halt と理由）が載る。
// - 役の返り値（Workflow の WORKER_SCHEMA）: { notes, next_wave_id?, rows?, halt? }。最後の claim の next_wave・halt をそのまま返す。
//   Task = { id, kind, result_path, unit?: { id, path, file, start, end }, lenses?: [{ id, name, procedure }], obligations?: [{ id, text }], intent?: { id, kind } }
//   kind は file・retro・alias・subject・finding・premise・goal・confirm・group と、計画の段の plan・unit_verify、全文レビューの full_review
//   lenses はファイルの段と振り返りの担当だけが持つ。全体の段の claim は意図の束（量は UNIT_MAX_BYTES まで）を返す（束の形は batch-fixture.mjs が固定する）
// - query  --state S --call C --worker W --task T [--fact F ...] → { ok, basis: [Fact], related: [Fact], omitted: [id] } | { ok, facts: [Fact] }
//   全体の段は --task を複数受け、{ ok, tasks: [1 件の形から ok を除いたもの], facts? } を返す（batch-fixture.mjs）
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
import { WORKFLOW_SOURCE } from './ledger-core.mjs'

export const HERE = path.dirname(fileURLToPath(import.meta.url))
export const CLI = path.join(HERE, 'ledger-cli.mjs')
export const WF = WORKFLOW_SOURCE
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

// 波の口の読み方（args は { state, callId, wave: { id, rows } }。形が違えば throw する）。
const waveOf = (args) => {
  if (!args || !args.wave || !Array.isArray(args.wave.rows)) throw new Error(`args が波の形（{ state, callId, wave: { id, rows } }）でない: ${JSON.stringify(args)}`)
  return args.wave
}
export const rowsOf = (args) => waveOf(args).rows
export const waveIdOf = (args) => waveOf(args).id
// 行の段（行の stage）。
export const stageOf = (args, row = rowsOf(args)[0]) => row.stage
// 行の claim の命令の argv。波の id があれば --wave・--model・--effort・--stage を足す（script が prompt に埋める形と同じ）。
export const claimArgv = (state, call, row, waveId = null) => ['claim', '--state', state, '--call', call, '--worker', row.id,
  ...(waveId != null ? ['--wave', String(waveId), '--model', row.model, '--effort', row.effort, '--stage', row.stage] : [])]

// 1 体の worker: claim が done を返すまで、取った担当の結果を書いて submit_cmd を流す。log に claim・query・submit の出力を残す。
// argv を渡すと、claim はその argv をそのまま流す（prompt の claim の命令を書き換えずに流す）。無ければ --state・--call・--worker だけ。
// 最後の claim の next_wave・halt を rec に残す（役の返り値になる）。
export async function workerLoop({ state, call, worker, role, argv = null }, act, log = [], exec = cli) {
  const rec = { worker, role, claims: [], submits: [], queries: [], next_wave: null, halt: false }
  log.push(rec)
  const ctx = {
    query: (task, facts = []) => {
      const q = exec('query', '--state', state, '--call', call, '--worker', worker, '--task', task.id, ...facts.flatMap((f) => ['--fact', f]))
      rec.queries.push({ task: task.id, kind: task.kind, out: q })
      return q.code === 0 ? q : { basis: [], related: [] }
    },
    state, call, worker,
  }
  // argv が無ければ、readArgs で覚えた呼び出しの行から claim の命令を作る（claimFor と同じ）。
  const claimCmd = argv || claimArgvFor(state, call, worker)
  for (let guard = 0; guard < 300; guard++) {
    const c = exec(...claimCmd)
    rec.claims.push(c)
    if (c.code === 0 && c.done) { rec.next_wave = c.next_wave || null; rec.halt = !!c.halt; break }
    if (c.code !== 0 || !Array.isArray(c.tasks) || !c.tasks.length) break
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
// 返ってきた next_wave のうち id の最大のもの（script と同じ選び方）。halt が 1 つでもあれば null。
export function nextWaveOf(recs) {
  if (recs.some((r) => r && r.halt)) return null
  const ws = recs.map((r) => r && r.next_wave).filter((w) => w && w.id != null)
  return ws.length ? ws.reduce((a, b) => (Number(b.id) > Number(a.id) ? b : a)) : null
}

// Workflow を通さずに next → 波（行ごとに 1 体の worker）→ ingest を止まるまで回す。CLI の振る舞いのテストに使う。
// 1 つの呼び出しの中では、script と同じく、返ってきた最大の id の next_wave の行で次の波を流す（halt か next_wave が無ければ終えて ingest）。
// 返す calls は波ごとに 1 件: { next（呼び出しを開いた next の出力）, args（その呼び出しの args）, wave, stage, rows, workers, ingest（呼び出しを閉じた後に付く）}。
// maxSteps は流す波の数の上限。until(rec) が真になった波の後は新しい波を流さずに呼び出しを閉じて返す（記録だけの波は次の next が作り直す）。
// onCall(rec) は各波の後に呼ぶ（呼び出しの最後の波は ingest の後）。
export async function drive(state, act, { maxSteps = 40, onCall = null, exec = cli, until = null } = {}) {
  const calls = []
  let n = null
  while (calls.length < maxSteps) {
    n = exec('next', '--state', state)
    if (n.code !== 0 || n.stop) return { stop: n, calls }
    const args = readArgs(n)
    const mine = []
    let wave = { id: waveIdOf(args), rows: rowsOf(args) }
    let stop = false
    for (;;) {
      const rec = { next: mine.length ? null : n, args, wave: wave.id, stage: stageOf(args, wave.rows[0]), rows: wave.rows, workers: [] }
      for (const w of wave.rows) await workerLoop({ state: args.state, call: args.callId, worker: w.id, role: w.role, argv: claimArgv(args.state, args.callId, w, wave.id) }, act, rec.workers, exec)
      mine.push(rec)
      calls.push(rec)
      if (until && until(rec)) stop = true
      const nw = nextWaveOf(rec.workers)
      if (stop || !nw || calls.length >= maxSteps) break
      if (onCall) await onCall(rec)
      wave = { id: nw.id, rows: nw.rows || [] }
    }
    const res = { agents: mine.flatMap((r) => r.rows.map((w) => ({ role: w.role, label: `worker-${w.id}`, model: w.model, effort: w.effort, ok: true, stage: w.stage, wave: r.wave }))), tokens: null }
    const f = path.join(state, `result-${args.callId}.json`)
    writeFileSync(f, JSON.stringify(res))
    const g = exec('ingest', '--state', state, '--call', args.callId, '--result', f)
    for (const r of mine) r.ingest = g
    if (onCall) await onCall(mine.at(-1))
    if (g.code !== 0) return { stop: g, calls }
    if (stop) return { stop: null, calls }
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
// Workflow が起動する役の偽物: prompt の claim の命令を読み、その argv のまま workerLoop で台帳と読み書きする。prompt と返り値は log に残す。
// prompt に claim の命令が無い役は、内容を返り値か prompt で運ぶ形なので失敗にする。
// 返り値は { notes, next_wave_id?, rows?, halt? }（最後の claim の next_wave・halt をそのまま運ぶ）。tamper(ret, entry) で書き換えた返り値を返せる。
export function scriptAgent(act, log = [], { tamper = null } = {}) {
  const fn = async (prompt, opts) => {
    const entry = { label: opts.label, model: opts.model, effort: opts.effort, phase: opts.phase, schema: opts.schema, prompt, claim: cliArgvOf(prompt, 'claim') }
    log.push(entry)
    if (!entry.claim) throw new Error(`役の prompt に ledger-cli.mjs claim の命令が無い: ${opts.label}`)
    entry.rec = await workerLoop({ state: argOf(entry.claim, 'state'), call: argOf(entry.claim, 'call'), worker: argOf(entry.claim, 'worker'), role: null, argv: entry.claim }, act, [])
    let ret = { notes: [] }
    if (entry.rec.halt) ret.halt = true
    else if (entry.rec.next_wave) ret = { ...ret, next_wave_id: entry.rec.next_wave.id, rows: entry.rec.next_wave.rows }
    if (tamper) ret = tamper(ret, entry) ?? ret
    entry.ret = ret
    return ret
  }
  fn.log = log
  return fn
}
// next → Workflow source → ingest を止まるまで回す。runWf で native の注入か runner を選ぶ。steps は呼び出しごとに 1 件。
// agentFn が scriptAgent なら、各 step に、その呼び出しで起動した役（launches: { stage, role, wave, worker, ... }）を付ける。
export async function driveScript(state, agentFn, { runWf = runScript, maxSteps = 40 } = {}) {
  const steps = []
  for (let i = 0; i < maxSteps; i++) {
    const n = cli('next', '--state', state)
    if (n.code !== 0 || n.stop) return { stop: n, steps }
    const args = readArgs(n)
    const at = agentFn.log ? agentFn.log.length : 0
    const res = await runWf(args, agentFn)
    const f = path.join(state, `result-${n.call_id}.json`)
    writeFileSync(f, JSON.stringify(res))
    const g = cli('ingest', '--state', state, '--call', args.callId, '--result', f)
    const step = { next: n, args, res, ingest: g }
    if (agentFn.log) step.launches = launchesOf([step], agentFn.log.slice(at))
    steps.push(step)
    if (g.code !== 0) return { stop: g, steps }
  }
  return { stop: null, steps }
}
// driveScript の steps と scriptAgent の log から、起動した 1 体ごとに { stage, role, call, wave, worker, claims, queries, submits, ret } を並べる。
// 段は prompt の claim の --stage、役は波の行（args の最初の波と、役が返した next_wave の行）から引く。
export function launchesOf(steps, log) {
  const rows = new Map()
  const key = (call, wave, worker) => `${call}|${wave ?? ''}|${worker}`
  for (const s of steps) {
    const w0 = waveIdOf(s.args)
    for (const r of rowsOf(s.args)) rows.set(key(s.args.callId, w0, r.id), { ...r, stage: stageOf(s.args, r) })
  }
  for (const x of log) {
    const call = argOf(x.claim, 'call')
    const nw = x.rec && x.rec.next_wave
    if (nw) for (const r of nw.rows || []) rows.set(key(call, nw.id, r.id), r)
  }
  // 渡した steps の呼び出しの役だけを並べる（log は全ての呼び出しの役を持つことがある）。
  const calls = new Set(steps.map((s) => s.args.callId))
  return log.filter((x) => calls.has(argOf(x.claim, 'call'))).map((x) => {
    const call = argOf(x.claim, 'call')
    const worker = argOf(x.claim, 'worker')
    const wave = argOf(x.claim, 'wave') ?? null
    const row = rows.get(key(call, wave, worker))
    return {
      stage: argOf(x.claim, 'stage') ?? (row && row.stage), role: row && row.role, call, wave, worker, model: x.model, effort: x.effort,
      claims: (x.rec && x.rec.claims) || [], queries: (x.rec && x.rec.queries) || [], submits: (x.rec && x.rec.submits) || [], ret: x.ret,
    }
  })
}

// claim の記録から、取った担当を平らに並べる。
export const claimedTasks = (calls) => calls.flatMap((c, ci) => c.workers.flatMap((w) => w.claims.flatMap((cl) => (cl.tasks || []).map((t) => ({ ...t, call: ci, worker: w.worker, role: w.role })))))
export const submitResults = (calls) => calls.flatMap((c) => c.workers.flatMap((w) => w.submits.flatMap((s) => (s.out.results || []))))
// driveScript の steps と scriptAgent の log から、流れた波ごとに { call, wave, stage, rows: [起動した 1 体（launchesOf の形）] } を並べる（起動の順）。
// 1 つの呼び出しが複数の段の波を流すので、段ごとの数は呼び出し（step）でなく波で数える。
export function wavesOf(steps, log) {
  const out = []
  for (const x of launchesOf(steps, log)) {
    let w = out.find((o) => o.call === x.call && o.wave === x.wave)
    if (!w) out.push((w = { call: x.call, wave: x.wave, stage: x.stage, rows: [] }))
    w.rows.push(x)
  }
  return out
}
// Workflow の返り値の起動の記録（agents）の段を、起動の順に並べる（記録の stage）。
// prompt を受ける前に落ちた役（log に残らない役）も数えるときに使う。
export const agentStages = (steps) => steps.flatMap((s) => ((s.res && s.res.agents) || []).map((a) => a.stage))
// 手で流すテストの口: next の出力から args を読み（呼び出しの id で覚える）、worker の id から、その行の claim の命令を作って流す。
// 行が見つからない（違う --call・行に無い worker を試す）ときは --state・--call・--worker だけを流す。
const OPENED = new Map()
export function readArgs(n) {
  const a = JSON.parse(readFileSync(n.args_path, 'utf8'))
  OPENED.set(a.callId, a)
  return a
}
export function claimArgvFor(state, call, worker) {
  const a = OPENED.get(call)
  const row = a && rowsOf(a).find((r) => r.id === worker)
  return row ? claimArgv(state, call, row, waveIdOf(a)) : ['claim', '--state', state, '--call', call, '--worker', worker]
}
export const claimFor = (state, call, worker, exec = cli) => exec(...claimArgvFor(state, call, worker))
