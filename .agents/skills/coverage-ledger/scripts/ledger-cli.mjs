#!/usr/bin/env node
// 台帳を書く唯一の口。init → next →（Workflow）→ ingest を繰り返し、next が止まる条件を返したら終わる。
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  C, MAX_ATTEMPTS, MAX_ROUTE_BATCHES, PLAN_ROUNDS, ROUTE_BATCH, UPPER,
  addEvent, calibration, coverage, currentFindings, decide, estimate, newLedger, parseConstraints, refresh, retroAssets, settleCell, sha, splitAssets, splitItems,
} from './ledger-core.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WORKFLOW = path.join(HERE, 'coverage-ledger.js')
const WRITING = path.join(HERE, '..', 'references', 'writing.md')

class Fail extends Error { constructor(msg, extra = {}) { super(msg); this.extra = extra } }
function parse(argv) {
  const o = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) { o._.push(a); continue }
    const k = a.slice(2)
    const v = argv[i + 1]
    if (v === undefined || v.startsWith('--')) throw new Fail(`--${k} に値が無い`)
    i++
    if (['target', 'input'].includes(k)) (o[k] = o[k] || []).push(v)
    else o[k] = v
  }
  return o
}
const read = (p) => readFileSync(p, 'utf8')
const need = (o, k) => { if (!o[k]) throw new Fail(`--${k} が要る`); return o[k] }
const ledgerPath = (dir) => path.join(dir, 'ledger.json')
function load(dir) {
  if (!existsSync(ledgerPath(dir))) throw new Fail(`台帳が無い: ${ledgerPath(dir)}（init を先に流す）`)
  return JSON.parse(read(ledgerPath(dir)))
}
// 書き込みは一時ファイルからの rename で 1 回に行う（途中で落ちても壊れた台帳を残さない）。
function save(dir, L) {
  L.rev += 1
  const tmp = `${ledgerPath(dir)}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(L, null, 1))
  renameSync(tmp, ledgerPath(dir))
}
function writeAtomic(file, text) {
  mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, text)
  renameSync(tmp, file)
}
const hints = (dir) => {
  const f = path.join(dir, 'hints.jsonl')
  return existsSync(f) ? read(f).split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []
}

// 対象のファイルを今の内容で資産にする。消えた・読めない対象は返す（枡 0 件で完了にしない）。
function currentAssets(L) {
  const files = L.mode === 'create' ? (L.written || existsSync(L.artifact) ? [L.artifact] : []) : L.targets
  const missing = []
  const assets = []
  for (const f of files) {
    if (!existsSync(f)) { missing.push(f); continue }
    assets.push(...splitAssets(f, read(f)))
  }
  return { assets, missing }
}
const assetById = (L, id) => {
  const a = L.assets[id]
  if (!a) return null
  if (a.retro) return { id, ...a }
  if (!existsSync(a.path)) return null
  return splitAssets(a.path, read(a.path)).find((x) => x.id === id) || null
}

function cmdInit(o) {
  const dir = path.resolve(need(o, 'state'))
  if (existsSync(ledgerPath(dir))) throw new Fail(`台帳が既にある: ${ledgerPath(dir)}（持ち越すときは next を流す）`)
  const mode = need(o, 'mode')
  if (!['review', 'create'].includes(mode)) throw new Fail(`--mode は review か create: ${mode}`)
  const abs = (p) => path.resolve(p)
  const targets = (o.target || []).map(abs)
  const artifact = o.artifact ? abs(o.artifact) : null
  if (mode === 'review' && !targets.length) throw new Fail('review には --target が要る')
  if (mode === 'create' && !artifact) throw new Fail('create には --artifact が要る')
  const missing = [...targets, ...(o.input || []).map((s) => abs(s.split('::')[0]))].filter((p) => !existsSync(p))
  if (artifact && !existsSync(path.dirname(artifact))) missing.push(path.dirname(artifact))
  if (missing.length) throw new Fail('読めない入力がある', { stop: 'blocked', cause: 'input', missing })
  const items = []
  ;(o.input || []).forEach((s, n) => {
    const [p, prefix = `I${n + 1}-`, ref] = s.split('::')
    items.push(...splitItems(abs(p), read(abs(p)), prefix, ref !== 'ref'))
  })
  const ids = items.map((i) => i.id)
  if (new Set(ids).size !== ids.length) throw new Fail('入力の id が重複している（--input の ::PREFIX で分ける）')
  const lenses = o.lenses ? JSON.parse(read(o.lenses)) : []
  for (const l of lenses) if (!l.id || !l.name || !l.procedure || C.RESERVED_LENSES.includes(l.id)) throw new Fail(`観点の形が不正: ${JSON.stringify(l)}`)
  const roles = { ...JSON.parse(read(path.join(HERE, 'roles.json'))), ...(o.roles ? JSON.parse(read(o.roles)) : {}) }
  const config = {}
  for (const [k, ck] of [['k', 'k'], ['max-cycles', 'max_cycles'], ['max-sections', 'max_sections'], ['max-agents-total', 'max_agents_total']]) if (o[k]) config[ck] = Number(o[k])
  const L = newLedger({
    mode, goal: read(need(o, 'goal')).trim(), request: read(need(o, 'request')).trim(), constraints: o.constraints ? parseConstraints(read(o.constraints)) : [],
    targets, artifact, items, lenses, config, roles, seeds: o.seeds ? JSON.parse(read(o.seeds)).map((s) => ({ ...s, path: abs(s.path) })) : [],
  })
  mkdirSync(dir, { recursive: true })
  save(dir, L)
  return { ok: true, state: dir, items: items.length, routable: items.filter((i) => i.routable).length, constraints: L.constraints.length, hint: `ヒントは node ${path.join(HERE, 'ledger-cli.mjs')} hint --state ${dir} --text "..." で足せる（実行中も止まっている間も）` }
}

const lensForCell = (L, id) => {
  const l = L.lenses.find((x) => x.id === id)
  return { id: l.id, name: l.name, procedure: l.procedure, items: l.items || [] }
}
function buildArgs(L, d, dir, unread) {
  const base = { skillDir: path.dirname(HERE), goal: L.goal.text, constraints: L.constraints, roles: L.roles, hints: unread, mode: L.mode }
  const textOf = Object.fromEntries(L.items.map((i) => [i.id, i.text]))
  if (d.step === 'plan') {
    const unrouted = L.items.filter((i) => i.routable && !L.routes.some((r) => r.input_id === i.id))
    const batches = []
    for (let s = 0; s < unrouted.length && batches.length < MAX_ROUTE_BATCHES; s += ROUTE_BATCH) batches.push(unrouted.slice(s, s + ROUTE_BATCH).map((i) => ({ id: i.id, kind: i.kind, text: i.text })))
    const answers = L.answers.filter((a) => !L.answered.includes(a.id) && a.target_kind === 'question')
    const integrates = (L.mode === 'create' || !L.lenses.some((l) => l.origin === 'user')) && (!L.plan || L.plan_defects.length || answers.length)
    // 振り分けが残る間は単位の同一性（送られた入力の集合）が変わるので、単位の検証は振り分けが済む呼び出しまで待つ。
    const verifyUnits = unrouted.length <= batches.flat().length
    // args は呼び出し側が運ぶので、その呼び出しで使う分だけを載せる（索引は計画役・統合役が走るときだけ、全文は単位を検証するときだけ）。
    return {
      ...base, stage: 'plan', request: L.request, goalChecked: L.goal.checked, givenLenses: L.lenses.filter((l) => l.origin === 'user').map((l) => ({ id: l.id, name: l.name })),
      prevPlan: L.plan, planDefects: L.plan_defects, answers,
      index: integrates ? L.items.map((i) => ({ id: i.id, kind: i.routable ? i.kind : `${i.kind}・参照`, head: i.text.replace(/\s+/g, ' ').slice(0, 160) })) : [],
      routeBatches: batches, prevRoutes: L.routes, itemTexts: verifyUnits ? Object.fromEntries(L.items.filter((i) => i.routable).map((i) => [i.id, i.text])) : {}, verifiedKeys: L.verified_units,
      verifyUnits,
    }
  }
  if (d.step === 'generate') {
    const issues = L.plan.issues || []
    const pending = issues.filter((i) => !L.proposals[i.id] || (L.issue_defects[i.id] || []).length)
    const cap = Math.floor((C.LIMITS.maxAgents - 2) / 2)
    const batch = pending.slice(0, cap).map((i) => ({ ...i, items: L.routes.filter((r) => r.dest === 'issue' && r.target === i.id).map((r) => ({ id: r.input_id, kind: L.items.find((x) => x.id === r.input_id).kind, text: textOf[r.input_id] })), defects: L.issue_defects[i.id] || [], prev: L.proposals[i.id] || null }))
    return {
      ...base, stage: 'generate', issues: batch, accepted: Object.fromEntries(Object.entries(L.proposals).filter(([k]) => !batch.some((b) => b.id === k))),
      allIssueIds: issues.map((i) => i.id), issueTitles: issues.map((i) => ({ id: i.id, title: i.title, question: i.question })), writeAfter: pending.length <= cap,
      maxSections: L.config.max_sections, writing: existsSync(WRITING) ? read(WRITING) : '', prevMarkdown: L.written && existsSync(L.artifact) ? read(L.artifact) : '', writerDefects: L.writer_defects,
    }
  }
  if (d.step === 'review') {
    const cap = Math.floor(C.LIMITS.maxAgents / C.PER_CELL)
    const cells = []
    for (const id of d.cells) {
      if (cells.length >= cap) break
      const c = L.cells[id]
      const a = assetById(L, c.asset)
      if (!a) continue
      cells.push({ cell_id: id, path: a.path, start: a.start, text: a.text, hash: a.hash, blocks: a.blocks, need: a.need, pass: c.pass, lens: lensForCell(L, c.lens) })
    }
    return { ...base, stage: 'review', cells }
  }
  if (d.step === 'group') {
    const items = currentFindings(L).filter((f) => f.verdict === 'confirmed' && f.cycle === L.cycle).map((f) => ({ key: f.id, where: L.cells[f.cell].asset, lens: L.cells[f.cell].lens, claim: f.claim, quote: f.quote, severity: f.severity, layer: f.layer }))
    return { ...base, stage: 'group', items }
  }
  throw new Fail(`未知の段: ${d.step}`)
}

function cmdNext(o) {
  const dir = path.resolve(need(o, 'state'))
  const L = load(dir)
  // blocked（failure）の後の next は、原因を直した再開として扱い、連続の数を戻す。
  if (L.stopped && L.stopped.stop === 'blocked' && L.stopped.cause === 'failure') {
    L.fail_streak = 0
    for (const c of Object.values(L.cells)) if (c.env_attempts) { c.attempts -= c.env_attempts; c.env_attempts = 0; if (c.status === 'disclosed') c.status = 'unseen' }
    for (const [k, n] of Object.entries(L.env_attempts)) { L.attempts[k] -= n; if (L.attempts[k] <= 0) delete L.attempts[k] }
    L.env_attempts = {}
  }
  const { assets, missing } = currentAssets(L)
  const changes = refresh(L, assets)
  for (;;) {
    const d = decide(L, { missingTargets: missing })
    if (d.stop) {
      L.stopped = { ...d, cycle: L.cycle }
      L.pending = null
      save(dir, L)
      return { ...d, changes, coverage: coverage(L), next_args: d.stop === 'complete' ? null : { state: dir } }
    }
    // 静的に済む段（振り返りの資産を作る・束ねる物が無い）は agent を起動せずに進める。
    if (d.step === 'retro') {
      const ra = retroAssets(L)
      refresh(L, ra, { partial: true })
      L.retro_cycles.push(L.cycle)
      continue
    }
    const unread = hints(dir).filter((h) => !L.hints_read.includes(h.id))
    const args = buildArgs(L, d, dir, unread)
    if (d.step === 'group' && !args.items.length) { L.group_cycles.push(L.cycle); continue }
    if (d.step === 'review' && !args.cells.length) throw new Fail('読み直す枡があるのに資産を作れない', { cells: d.cells })
    const callId = sha(JSON.stringify(args)).slice(0, 12)
    args.callId = callId
    args.argsSum = C.argsSum(args)
    const est = estimate(d.step, args)
    const argsPath = path.join(dir, `call-${callId}.json`)
    writeAtomic(argsPath, JSON.stringify(args))
    L.pending = { call_id: callId, step: d.step, args_path: argsPath, hints: unread.map((h) => h.id), cycle: L.cycle }
    save(dir, L)
    return { step: d.step, call_id: callId, workflow: WORKFLOW, args_path: argsPath, estimate_agents: Math.min(est, C.LIMITS.maxAgents), limits: C.LIMITS, cycle: L.cycle, coverage: coverage(L), changes }
  }
}

function recordCall(L, res, step) {
  const ag = Array.isArray(res.agents) ? res.agents : []
  for (const a of ag) L.agents.push({ call_id: res.call_id, cycle: L.cycle, stage: step, role: a.role, label: a.label, model: a.model, effort: a.effort, ok: !!a.ok })
  L.calls.push({ call_id: res.call_id, cycle: L.cycle, step, agents: ag.length, failed: ag.filter((a) => !a.ok).length, tokens: res.tokens ?? null, tokens_note: res.tokens == null ? '消費量を run の中で読めない経路（runner など）' : 'native budget.spent()' })
  L.fail_streak = ag.length && ag.every((a) => !a.ok) ? L.fail_streak + 1 : 0
  for (const a of ag) if (!a.ok) addEvent(L, step, 'agent_missing', `${a.label}（${a.model}/${a.effort}）が返らなかったか不正な出力だった`, a.label)
}
// 全ての役が欠けた呼び出しの試行は env_attempts にも数え、blocked（failure）から再開したときに戻す（直して再開した run が即開示しないように）。
let allFailed = false
const bump = (L, k) => {
  L.attempts[k] = (L.attempts[k] || 0) + 1
  if (allFailed) L.env_attempts[k] = (L.env_attempts[k] || 0) + 1
}
const clear = (L, k) => { delete L.attempts[k] }

function ingestPlan(L, res, args) {
  const ctx = { mode: L.mode, constraintIds: L.constraints.map((c) => c.id), lensesGiven: args.givenLenses.length > 0, givenLensIds: args.givenLenses.map((l) => l.id) }
  if (res.goal_check !== undefined && !args.goalChecked) {
    const g = res.goal_check
    if (g && g.ok) { L.goal.checked = true; L.goal.problems = []; clear(L, 'goal') }
    else if (g) {
      const valid = (g.problems || []).filter((p) => !C.quoteProblem(p.quote, L.request))
      if (valid.length) L.goal.problems = valid
      else { bump(L, 'goal'); addEvent(L, 'plan', 'rejected_goal_check', '目標の照合が不合格としたが、依頼文の引用が合わない') }
    } else bump(L, 'goal')
  }
  if (res.status === 'blocked') { bump(L, 'plan'); addEvent(L, 'plan', 'blocked', res.reason || 'plan が止まった'); return }
  // 統合役がこの呼び出しで走ったときだけ、計画を受け取り直す（走らなければ前の計画のまま）。
  const integrated = (L.mode === 'create' || !ctx.lensesGiven) && (!args.prevPlan || args.planDefects.length || args.answers.length)
  if (integrated && res.plan) {
    if (args.prevPlan) L.plan_rounds += 1
    L.plan_defects = []
    L.plan = res.plan
    const p = C.checkPlan(res.plan, ctx)
    L.plan_problems = p
    for (const x of p) { L.plan_defects.push({ unit_id: '', kind: 'static', claim: x, quote: '' }); addEvent(L, 'plan', 'static_problem', x) }
    for (const a of args.answers) L.answered.push(a.id)
    const valid = new Set([...(L.plan.issues || []).map((i) => i.id), ...(L.plan.lenses || []).map((l) => l.id), ...(L.plan.questions || []).map((q) => q.id), ...C.RESERVED_LENSES, ...ctx.givenLensIds, ...ctx.constraintIds])
    L.routes = L.routes.filter((r) => !['issue', 'lens', 'user', 'upper_layer', 'fixed'].includes(r.dest) || valid.has(r.target))
  }
  const plan = L.plan || { issues: [], lenses: [], questions: [] }
  const ids = { issueIds: (plan.issues || []).map((i) => i.id), lensIds: [...C.RESERVED_LENSES, ...ctx.givenLensIds, ...(plan.lenses || []).map((l) => l.id)], questionIds: (plan.questions || []).map((q) => q.id), constraintIds: ctx.constraintIds }
  const sent = new Map(args.routeBatches.flat().map((i) => [i.id, i]))
  const byItem = new Map()
  for (const r of res.routes || []) if (sent.has(r.input_id)) byItem.set(r.input_id, [...(byItem.get(r.input_id) || []), r])
  for (const [id, it] of sent) {
    const rs = byItem.get(id) || []
    const p = rs.length === 1 ? C.checkRoutes({ routes: rs }, [it], ids) : [rs.length ? '行き先が 2 つ以上' : '行き先が無い']
    if (p.length) { bump(L, `route:${id}`); addEvent(L, 'plan', 'rejected_route', `${id}: ${p.join(' / ')}`, id) }
    else { L.routes = L.routes.filter((r) => r.input_id !== id); L.routes.push({ input_id: id, dest: rs[0].dest, target: rs[0].target, reason: rs[0].reason }); clear(L, `route:${id}`) }
  }
  const units = new Map([...(plan.issues || []), ...(plan.lenses || [])].map((u) => [u.id, u]))
  const textOf = Object.fromEntries(L.items.map((i) => [i.id, i.text]))
  for (const uc of res.unit_checks || []) {
    const u = units.get(uc.unit_id)
    if (!u || uc.key !== C.unitKey(u, L.routes)) continue // 計画か振り分けが変わった後の検証は使わない
    const p = C.checkUnitVerdict(uc.result, u.id, C.unitText(u, L.routes, textOf))
    if (p.length) { bump(L, `unit:${u.id}`); addEvent(L, 'plan', 'rejected_unit_check', `${u.id}: ${p.join(' / ')}`, u.id); continue }
    clear(L, `unit:${u.id}`)
    if (uc.result.defects.length) for (const d of uc.result.defects) { L.plan_defects.push({ unit_id: u.id, ...d }); addEvent(L, 'plan', 'unit_defect', `${u.id}: ${d.claim}`, u.id) }
    else L.verified_units.push(uc.key)
  }
  // 計画の観点と、観点へ送られた入力（規準）を台帳の観点に写す。変われば枡は古くなる。
  const keep = L.lenses.filter((l) => l.origin !== 'plan')
  L.lenses = [...keep, ...(plan.lenses || []).map((l) => ({ ...l, origin: 'plan' }))]
  for (const l of L.lenses) {
    if (l.retro) continue
    l.items = L.routes.filter((r) => r.dest === 'lens' && r.target === l.id).map((r) => ({ id: r.input_id, text: textOf[r.input_id] }))
    l.version = sha(JSON.stringify([l.name, l.procedure, l.items])).slice(0, 12)
  }
}

function ingestGenerate(L, res, args) {
  for (const it of args.issues) {
    const got = (res.proposals || []).find((x) => x.issue_id === it.id)
    const p = got ? C.checkProposal(got.result, it, it.items) : ['案が返らなかった']
    if (p.length) { bump(L, `issue:${it.id}`); addEvent(L, 'generate', 'rejected_proposal', `${it.id}: ${p.join(' / ')}`, it.id); continue }
    clear(L, `issue:${it.id}`)
    L.proposals[it.id] = got.result
    L.issue_defects[it.id] = []
    got.result.open_questions_for_user.forEach((q, n) => { L.plan.questions = L.plan.questions || []; const id = `PQ-${it.id}-${n + 1}`; if (!L.plan.questions.some((x) => x.id === id)) L.plan.questions.push({ id, question: q, why_value_judgment: `論点 ${it.id} の実行役が挙げた`, options: [] }) })
  }
  if (!args.writeAfter) return
  const w = res.writer && res.writer.result
  const issueIds = (L.plan.issues || []).map((i) => i.id)
  const p = w ? C.checkWriter(w, issueIds, L.config.max_sections, args.writerDefects.length) : [res.missing && res.missing.length ? `案の揃わない論点: ${res.missing.join(', ')}` : '書き手が返らなかった']
  if (p.length) { bump(L, 'writer'); addEvent(L, 'generate', 'rejected_writer', p.join(' / ')); return }
  clear(L, 'writer')
  writeAtomic(L.artifact, w.markdown.endsWith('\n') ? w.markdown : `${w.markdown}\n`)
  L.written = true
  L.sections = w.sections
  for (const c of w.conflicts_between_issues) addEvent(L, 'generate', 'conflict', c)
  for (const r of w.defect_responses) {
    const d = args.writerDefects[r.defect_index]
    if (d && L.findings[d.id]) L.findings[d.id].fix = r.action
    if (r.action === 'rejected') addEvent(L, 'generate', 'writer_rejected', `${d && d.id}: ${r.reason}`, d && d.id)
  }
  L.writer_defects = []
}

function ingestReview(L, res, args) {
  const rows = new Map((res.cells || []).map((r) => [r.cell_id, r]))
  for (const sent of args.cells) {
    const c = L.cells[sent.cell_id]
    if (!c || c.status === 'gone') continue
    const row = rows.get(sent.cell_id)
    if (!row) continue // 走らなかった枡は試行に数えず、次の呼び出しで渡す
    const a = assetById(L, c.asset)
    if (a && a.hash !== sent.hash) continue // 読んだ後に対象が変わった。次の next で古い印が付く
    const before = c.attempts
    settleCell(L, sent.cell_id, row, a ? { ...a, cell_id: sent.cell_id } : null)
    if (allFailed && c.attempts > before) c.env_attempts = (c.env_attempts || 0) + c.attempts - before
  }
}

function ingestGroup(L, res, args) {
  const keys = args.items.map((x) => x.key)
  const g = res.grouping
  const p = res.status === 'blocked' ? [res.reason] : C.checkGroups(g, keys)
  if (p.length) {
    bump(L, `group:${L.cycle}`)
    addEvent(L, 'group', 'rejected_grouping', p.join(' / '))
    return
  }
  clear(L, `group:${L.cycle}`)
  const judged = new Map((res.judged || []).map((j) => [j.group.id, j]))
  for (const gr of g.groups) {
    const j = judged.get(gr.id)
    const status = j ? j.status : 'unverified'
    const id = `G${L.cycle}-${gr.id}`
    L.groups.push({ id, cycle: L.cycle, root_cause: gr.root_cause, layer: gr.layer, keys: gr.keys, pattern: gr.pattern, status, votes: j ? j.votes : [] })
    if (status === 'refuted') continue
    // 横展開: 確かめた欠陥の型を、全ての対象の資産へ問い直す観点にする（重さで絞らない）。
    if (gr.pattern && gr.pattern.trim()) {
      const l = { id: `lat-${id}`, name: `横展開: ${gr.root_cause}`.slice(0, 120), procedure: gr.pattern, origin: `lateral:${id}`, items: [] }
      l.version = sha(JSON.stringify([l.name, l.procedure, l.items])).slice(0, 12)
      if (!L.lenses.some((x) => x.id === l.id)) L.lenses.push(l)
    }
  }
  // create では、上の層でない確かめた欠陥を、節から論点へ戻して直させる（D6）。
  if (L.mode === 'create') {
    const fix = currentFindings(L).filter((f) => f.verdict === 'confirmed' && !f.fix && !UPPER.includes(f.layer) && !L.assets[L.cells[f.cell].asset]?.retro)
    for (const f of fix) {
      const a = L.assets[L.cells[f.cell].asset]
      const secs = L.sections.filter((s) => (a.trail || []).some((h) => C.norm(h) === C.norm(s.heading)))
      const d = { id: f.id, where: a.heading || a.path, claim: f.claim, quote: f.quote, layer: f.layer }
      for (const s of secs) for (const i of s.issue_ids) (L.issue_defects[i] = L.issue_defects[i] || []).push(d)
      L.writer_defects.push(d)
      f.fix = 'sent'
      L.findings[f.id].fix = 'sent'
    }
  }
  L.saturation.push({ cycle: L.cycle, confirmed_new: keys.length, groups: g.groups.length, lateral_lenses: g.groups.filter((x) => x.pattern && x.pattern.trim()).length })
  L.group_cycles.push(L.cycle)
  L.cycle += 1
}

function cmdIngest(o) {
  const dir = path.resolve(need(o, 'state'))
  const L = load(dir)
  const res = JSON.parse(read(need(o, 'result')))
  if (!L.pending) throw new Fail('受け取る呼び出しが無い（next を先に流す）')
  if (!res || res.call_id !== L.pending.call_id || res.stage !== L.pending.step) throw new Fail(`呼び出しが違う: 待っているのは ${L.pending.step}/${L.pending.call_id}、受け取ったのは ${res && res.stage}/${res && res.call_id}`)
  const args = JSON.parse(read(L.pending.args_path))
  recordCall(L, res, L.pending.step)
  allFailed = Array.isArray(res.agents) && res.agents.length > 0 && res.agents.every((a) => !a.ok)
  if (res.status === 'blocked' && res.reason === 'args の検査に落ちた') throw new Fail('Workflow が args を拒否した（args_path のファイルの中身を書き換えずに渡し直す）', { problems: res.problems })
  ;({ plan: ingestPlan, generate: ingestGenerate, review: ingestReview, group: ingestGroup })[L.pending.step](L, res, args)
  L.hints_read.push(...L.pending.hints)
  L.pending = null
  save(dir, L)
  return { ok: true, cycle: L.cycle, coverage: coverage(L), next: 'next を流す' }
}

function cmdStatus(o) {
  const dir = path.resolve(need(o, 'state'))
  const L = load(dir)
  const cur = currentFindings(L)
  const by = (k) => cur.reduce((m, f) => ({ ...m, [f[k]]: (m[f[k]] || 0) + 1 }), {})
  const roles = {}
  for (const a of L.agents) { const k = `${a.role}|${a.model}|${a.effort}`; roles[k] = roles[k] || { launched: 0, failed: 0 }; roles[k].launched++; if (!a.ok) roles[k].failed++ }
  return {
    mode: L.mode, cycle: L.cycle, stopped: L.stopped || null, pending: L.pending, coverage: coverage(L),
    skip: Object.entries(L.cells).filter(([, c]) => c.status === 'disclosed').map(([id, c]) => ({ cell: id, problems: c.problems })),
    findings: { by_verdict: by('verdict'), by_layer: by('layer'), confirmed: cur.filter((f) => f.verdict === 'confirmed').map((f) => ({ id: f.id, severity: f.severity, layer: f.layer, claim: f.claim, quote: f.quote, fix: f.fix })), unverifiable: cur.filter((f) => f.verdict === 'unverifiable').map((f) => ({ id: f.id, claim: f.claim })) },
    outside_notes: Object.entries(L.cells).filter(([, c]) => (c.outside_notes || []).length).map(([id, c]) => ({ cell: id, notes: c.outside_notes })),
    groups: L.groups.map((g) => ({ id: g.id, status: g.status, layer: g.layer, root_cause: g.root_cause, lateral: !!(g.pattern && g.pattern.trim()) })),
    saturation: L.saturation, calibration: calibration(L), agents_by_role: roles, calls: L.calls,
    events_not_in_retro: L.events.filter((e) => !e.retro).map((e) => ({ id: e.id, stage: e.stage, kind: e.kind })),
    questions: ((L.plan && L.plan.questions) || []).filter((q) => !L.answers.some((a) => a.id === q.id)),
  }
}

function cmdHint(o) {
  const dir = path.resolve(need(o, 'state'))
  const L = load(dir)
  if (L.stopped && L.stopped.stop === 'complete') throw new Fail('完了した台帳にはヒントを足せない（読まれない）')
  const id = `H${hints(dir).length + 1}`
  appendFileSync(path.join(dir, 'hints.jsonl'), `${JSON.stringify({ id, text: need(o, 'text') })}\n`)
  return { ok: true, id }
}

function cmdAnswer(o) {
  const dir = path.resolve(need(o, 'state'))
  const L = load(dir)
  const id = need(o, 'id')
  const text = need(o, 'text')
  if (id === 'goal') { L.goal = { text, checked: false, problems: [] }; clear(L, 'goal') }
  else {
    const isQ = ((L.plan && L.plan.questions) || []).some((q) => q.id === id)
    const known = isQ || L.findings[id] || L.groups.some((g) => g.id === id) || id.startsWith('attempts:')
    if (!known) throw new Fail(`台帳に無い id: ${id}`)
    if (id.startsWith('attempts:')) clear(L, id.slice('attempts:'.length))
    L.answers.push({ id, text, target_kind: isQ ? 'question' : 'finding' })
    if (isQ) L.constraints.push({ id: `A-${id}`, text: `${id} への利用者の回答: ${text}` })
  }
  save(dir, L)
  return { ok: true }
}

function cmdConfig(o) {
  const dir = path.resolve(need(o, 'state'))
  const L = load(dir)
  for (const [k, ck] of [['max-cycles', 'max_cycles'], ['max-agents-total', 'max_agents_total']]) if (o[k]) L.config[ck] = Number(o[k])
  save(dir, L)
  return { ok: true, config: L.config }
}

export function main(argv) {
  try {
    const o = parse(argv)
    const cmd = o._[0]
    const f = { init: cmdInit, next: cmdNext, ingest: cmdIngest, status: cmdStatus, hint: cmdHint, answer: cmdAnswer, config: cmdConfig }[cmd]
    if (!f) throw new Fail(`使い方: ledger-cli.mjs <init|next|ingest|status|hint|answer|config> --state DIR ...（未知のコマンド: ${cmd}）`)
    return { code: 0, output: f(o) }
  } catch (e) {
    if (e instanceof Fail) return { code: 2, output: { ok: false, error: e.message, ...e.extra } }
    return { code: 1, output: { ok: false, error: String(e && e.stack || e) } }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = main(process.argv.slice(2))
  process.stdout.write(`${JSON.stringify(r.output, null, 1)}\n`)
  process.exitCode = r.code
}
