#!/usr/bin/env node
// 台帳を書く唯一の口。init → next →（Workflow）→ ingest を繰り返し、next が止まる条件を返したら終わる。
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  C, addEvent, calibration, coverage, currentFindings, decide, estimate, goalIds, goalSources, lensVersion, needPlan, newLedger, openCycle,
  rangeHash, rangeText, readGoalFiles, refresh, retroAssets, settleCell, sha, splitAssets, withBlocks,
} from './ledger-core.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WORKFLOW = path.join(HERE, 'coverage-audit.js')

class Fail extends Error { constructor(msg, extra = {}) { super(msg); this.extra = extra } }
const MULTI = ['target']
const KNOWN = {
  init: ['state', 'goal', 'request', 'decisions', 'criteria', 'goal-checked', 'target', 'constraints', 'lenses', 'roles', 'seeds', 'k', 'max-cycles', 'max-agents-total'],
  next: ['state'], ingest: ['state', 'result'], status: ['state'], hint: ['state', 'text'], answer: ['state', 'id', 'text', 'file'], config: ['state', 'max-cycles', 'max-agents-total'],
}
function parse(argv) {
  const o = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) { o._.push(a); continue }
    const k = a.slice(2)
    const v = argv[i + 1]
    if (v === undefined || v.startsWith('--')) throw new Fail(`--${k} に値が無い`)
    i++
    if (MULTI.includes(k)) (o[k] = o[k] || []).push(v)
    else o[k] = v
  }
  const known = KNOWN[o._[0]]
  if (known) for (const k of Object.keys(o)) if (k !== '_' && !known.includes(k)) throw new Fail(`${o._[0]} が受け付けない引数: --${k}`)
  return o
}
const read = (p) => readFileSync(p, 'utf8')
const need = (o, k) => { if (!o[k]) throw new Fail(`--${k} が要る`); return o[k] }
// 数の引数は正の整数だけを受け付ける（NaN・0・小数・指数表記で上限や k が壊れた台帳を作らない）。
function posInts(o, keys) {
  const out = {}
  for (const [k, ck] of keys) {
    if (o[k] === undefined) continue
    if (!/^[1-9]\d*$/.test(o[k]) || !Number.isSafeInteger(Number(o[k]))) throw new Fail(`--${k} は正の整数: ${o[k]}`)
    out[ck] = Number(o[k])
  }
  return out
}
const ledgerPath = (dir) => path.join(dir, 'ledger.json')
function load(dir) {
  if (!existsSync(ledgerPath(dir))) throw new Fail(`台帳が無い: ${ledgerPath(dir)}（init を先に流す）`)
  const L = JSON.parse(read(ledgerPath(dir)))
  if (!L.goal || !Array.isArray(L.goal.items)) throw new Fail(`台帳の形式が古い（目標の項目と引用を持たない）: ${ledgerPath(dir)}。goal.md などを 1 行 1 件・引用つきに直し、新しい stateDir で init からやり直す`)
  return L
}
function writeAtomic(file, text) {
  mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, text)
  renameSync(tmp, file)
}
// 書き込みは一時ファイルからの rename で 1 回に行う（途中で落ちても壊れた台帳を残さない）。
function save(dir, L) {
  L.rev += 1
  writeAtomic(ledgerPath(dir), JSON.stringify(L, null, 1))
}
const hints = (dir) => {
  const f = path.join(dir, 'hints.jsonl')
  return existsSync(f) ? read(f).split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []
}

// 写し: 担当が読む内容を stateDir/snap/ に内容の hash の名前で置く（同じ内容は同じファイル。call_id が決まる前に書ける）。
// 既にあるファイルの中身が名前の hash と違えば（書き換わった写し）書き直す。書き直さないと ingest の拒否から抜けられない。
const snapDir = (dir) => path.join(dir, 'snap')
function writeSnap(dir, text) {
  const name = sha(text).slice(0, 16)
  const file = path.join(snapDir(dir), `${name}.txt`)
  if (!existsSync(file) || sha(read(file)).slice(0, 16) !== name) writeAtomic(file, text)
  return file
}
const wholeRef = (file, text) => { const end = text.split('\n').length; return { snapshot: file, start: 1, end, hash: rangeHash(text, 1, end) } }

// 対象のファイルを今の内容で資産にし、同じ内容を写しに書く。消えた・読めない対象は返す（枡 0 件で完了にしない）。
function currentAssets(L, dir) {
  const missing = []
  const assets = []
  for (const f of L.targets) {
    if (!existsSync(f)) { missing.push(f); continue }
    const text = read(f)
    const snap = writeSnap(dir, text)
    assets.push(...splitAssets(f, text).map((a) => ({ ...a, snap })))
  }
  return { assets, missing }
}

function cmdInit(o) {
  const dir = path.resolve(need(o, 'state'))
  if (existsSync(ledgerPath(dir))) throw new Fail(`台帳が既にある: ${ledgerPath(dir)}（持ち越すときは next を流す）`)
  const abs = (p) => path.resolve(p)
  const targets = (o.target || []).map(abs)
  if (!targets.length) throw new Fail('--target が要る')
  const missing = targets.filter((p) => !existsSync(p))
  if (missing.length) throw new Fail('読めない対象がある（台帳は作っていない。直して init をやり直す）', { stop: 'blocked', cause: 'input', missing })
  const lenses = o.lenses ? JSON.parse(read(o.lenses)) : []
  for (const l of lenses) if (!l.id || !l.name || !l.procedure || C.RESERVED_LENSES.includes(l.id)) throw new Fail(`観点の形が不正: ${JSON.stringify(l)}`)
  const roles = { ...JSON.parse(read(path.join(HERE, 'roles.json'))), ...(o.roles ? JSON.parse(read(o.roles)) : {}) }
  const config = posInts(o, [['k', 'k'], ['max-cycles', 'max_cycles'], ['max-agents-total', 'max_agents_total']])
  // 照合済みの印: coverage-build が目標を照合して渡したときだけ付く。付いていれば目標の照合（引用の照合と照合役）を流さない。
  const checkedBy = o['goal-checked'] ?? null
  if (checkedBy !== null && checkedBy !== 'coverage-build') throw new Fail(`--goal-checked は coverage-build だけ（目標を照合したスキル）: ${checkedBy}`)
  const text = {
    goal: read(need(o, 'goal')).trim(), request: read(need(o, 'request')).trim(), decisions: o.decisions ? read(o.decisions).trim() : null,
    criteria: o.criteria ? read(o.criteria) : '', constraints: o.constraints ? read(o.constraints) : '',
  }
  const g = readGoalFiles(text, { checkedBy })
  if (g.problems.length) throw new Fail('目標・基準・制約に、引用の照合を通らない項目がある（台帳は作っていない。直して init をやり直す）', { problems: g.problems })
  const L = newLedger({
    goal: text.goal, goalItems: g.goal, checkedBy, request: text.request, decisions: text.decisions, criteria: g.criteria, constraints: g.constraints,
    targets, lenses, config, roles, seeds: o.seeds ? JSON.parse(read(o.seeds)).map((s) => ({ ...s, path: abs(s.path) })) : [],
  })
  mkdirSync(dir, { recursive: true })
  save(dir, L)
  return { ok: true, state: dir, targets: targets.length, criteria: L.criteria.length, constraints: L.constraints.length, goal_checked_by: checkedBy, hint: `ヒントは node ${path.join(HERE, 'ledger-cli.mjs')} hint --state ${dir} --text "..." で足せる（実行中も止まっている間も）` }
}

// args には担当が読む文（目標・基準・制約・依頼文・決定の記録・ヒント・回答・前の計画・欠陥・観点の手続き・束ねる指摘）を載せない。
// 文は呼び出しごとの束（brief）の写しに書き、args には写しの参照（path・行の範囲・hash）と、id・件数・設定だけを載せる。
const goalLines = (t) => String(t).split('\n').map((l) => `    ${l}`).join('\n')
const itemLines = (xs) => xs.map((c) => `  - ${c.id}: ${c.text}`).join('\n') || '  - なし'
function commonBrief(L, unread) {
  return `# 依頼の束（coverage-audit）
## 固定した目標（変えない。constraint_map の対象ではない）
${goalLines(L.goal.text)}
## 受け入れ基準（満たすかを確かめる。id で指す）
${itemLines(L.criteria)}
## 固定した制約（変えない。id で指す）
${itemLines(L.constraints)}
${unread.length ? `## 利用者のヒント（取り込む）\n${unread.map((h) => `- [${h.id}] ${h.text}`).join('\n')}\n` : ''}`
}
const briefRef = (dir, text) => wholeRef(writeSnap(dir, text), text)
function buildArgs(L, d, dir, unread) {
  const roles = Object.fromEntries(Object.entries(L.roles).map(([k, r]) => [k, { model: r.model, effort: r.effort }]))
  const base = { skillDir: path.dirname(HERE), stage: d.step, roles, criteriaIds: L.criteria.map((c) => c.id), constraintIds: L.constraints.map((c) => c.id) }
  const common = commonBrief(L, unread)
  if (d.step === 'plan') {
    const answers = L.answers.filter((a) => !L.answered.includes(a.id) && a.target_kind === 'question')
    const integrates = needPlan(L) && (!L.plan || L.plan_defects.length || answers.length)
    let index = null
    let units = []
    if (integrates) {
      const text = Object.entries(L.assets).filter(([, a]) => !a.retro).map(([id, a]) => `${id}\t${a.snap}\t${a.start}-${a.end}\t${(a.trail || []).join(' > ') || a.heading}`).join('\n')
      index = briefRef(dir, text)
    } else {
      // 統合し直さないときは、前の計画のうち中身が変わって検証していない観点だけを、観点ごとの束で渡す。
      units = ((L.plan && L.plan.lenses) || []).filter((u) => !L.verified_units.includes(C.unitKey(u)))
        .map((u) => ({ unit_id: u.id, key: C.unitKey(u), brief: briefRef(dir, `${common}\n### 本文（観点）\n${C.unitText(u)}\n`) }))
    }
    // 束は役ごとに分け、各役にはその役が要る文だけを渡す（計画役・観点の検証役に前の欠陥や依頼文を見せない）。
    // brief: 共通の前提だけ（計画役・最初の統合役・この呼び出しで統合した観点の検証役）。goalBrief: 依頼文と決定の記録（目標の照合役）。
    // againBrief: 前の計画・欠陥・回答（見直しの統合役）。JSON は 1 行 1 件にして、1 行が長くならないようにする。
    const prevLensIds = ((L.plan && L.plan.lenses) || []).map((u) => u.id)
    const rows = (xs) => `[\n${xs.map((x) => JSON.stringify(x)).join(',\n')}\n]`
    const again = integrates && prevLensIds.length
      ? briefRef(dir, `${common}\n### 前の計画\n${JSON.stringify(L.plan, null, 1)}\n### 欠陥（index は配列の位置）\n${rows(L.plan_defects.map((x, i) => ({ index: i, ...x })))}\n### 利用者の回答\n${rows(answers)}\n`)
      : null
    return {
      ...base, brief: briefRef(dir, common), goalChecked: L.goal.checked,
      ...(L.goal.checked ? {} : { goalBrief: briefRef(dir, `${common}\n## 依頼文\n${L.request}\n## 決定の記録\n${L.decisions ?? '（無し）'}\n`), goalIds: goalIds(L) }),
      ...(again ? { againBrief: again } : {}), givenLensIds: L.lenses.filter((l) => l.origin === 'user').map((l) => l.id),
      prevLensIds, defectCount: L.plan_defects.length, answerIds: answers.map((a) => a.id), index, units, verifiedKeys: L.verified_units,
    }
  }
  if (d.step === 'review') {
    const cap = Math.floor(C.LIMITS.maxAgents / C.PER_CELL)
    const cells = []
    for (const id of d.cells) {
      if (cells.length >= cap) break
      const c = L.cells[id]
      const a = L.assets[c.asset]
      if (!a) continue
      const l = L.lenses.find((x) => x.id === c.lens)
      cells.push({ cell_id: id, path: a.path, snapshot: a.snap, start: a.start, end: a.end, hash: a.hash, blocks: a.blocks.map(([s, e]) => [a.start + s, a.start + e]), pass: c.pass, lens: l.id, brief: briefRef(dir, `${common}\n## 観点\n観点: ${l.name}\n手続き: ${l.procedure}\n`) })
    }
    return { ...base, cells }
  }
  if (d.step === 'group') {
    const found = currentFindings(L).filter((f) => f.verdict === 'confirmed' && f.cycle === L.cycle)
    const keys = C.groupKeys(found.length)
    const text = found.map((f, i) => JSON.stringify({ key: keys[i], finding: f.id, where: L.cells[f.cell].asset, lens: L.cells[f.cell].lens, claim: f.claim, quote: f.quote, severity: f.severity, layer: f.layer })).join('\n')
    return { ...base, brief: briefRef(dir, common), count: found.length, items: found.length ? briefRef(dir, text) : null }
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
  const { assets, missing } = currentAssets(L, dir)
  const changes = refresh(L, assets)
  for (;;) {
    openCycle(L)
    const d = decide(L, { missingTargets: missing })
    if (d.stop) {
      L.stopped = { ...d, cycle: L.cycle }
      L.pending = null
      save(dir, L)
      return { ...d, changes, coverage: coverage(L), next_args: d.stop === 'complete' ? null : { state: dir } }
    }
    // 静的に済む段（振り返りの資産を作る・束ねる物が無い）は agent を起動せずに進める。
    if (d.step === 'retro') {
      const ra = retroAssets(L).map((a) => ({ ...a, snap: writeSnap(dir, a.text) }))
      refresh(L, ra, { partial: true })
      L.retro_cycles.push(L.cycle)
      continue
    }
    const unread = hints(dir).filter((h) => !L.hints_read.includes(h.id))
    const args = buildArgs(L, d, dir, unread)
    if (d.step === 'group' && !args.count) { L.group_cycles.push(L.cycle); continue }
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

// args が指す写しを読み、範囲の hash が args と合うかを照らす。合わなければ受け取らない。
function readRef(dir, ref, what) {
  const file = path.resolve(String(ref.snapshot))
  if (path.dirname(file) !== snapDir(dir) || !existsSync(file)) throw new Fail(`${what} の写しが stateDir の写しの置き場に無い: ${ref.snapshot}`)
  const text = read(file)
  if (rangeHash(text, ref.start, ref.end) !== ref.hash) throw new Fail(`${what} の写しの hash が args と違う（写しが書き換わった。next からやり直す）: ${ref.snapshot}`)
  return rangeText(text, ref.start, ref.end)
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
  const ctx = { constraintIds: [...L.criteria, ...L.constraints].map((c) => c.id), lensesGiven: args.givenLensIds.length > 0, givenLensIds: args.givenLensIds }
  // 目標の照合: 照合役が挙げた成果の引用と項目の id を照らし、どの項目にも受け止められていない成果を人間に返す。
  if (!args.goalChecked) {
    const g = res.goal_check
    const p = C.checkGoalMap(g, args.goalIds, goalSources(L))
    if (p.length) { bump(L, 'goal'); addEvent(L, 'plan', 'rejected_goal_check', `目標の照合: ${p.join(' / ')}`) }
    else { clear(L, 'goal'); L.goal.problems = C.goalGaps(g); L.goal.checked = !L.goal.problems.length }
  }
  if (res.status === 'blocked') { bump(L, 'plan'); addEvent(L, 'plan', 'blocked', res.reason || 'plan が止まった'); return }
  // 統合役がこの呼び出しで走ったときだけ、計画を受け取り直す（走らなければ前の計画のまま）。
  if (args.index && res.plan) {
    if (L.plan) L.plan_rounds += 1
    L.plan_defects = []
    L.plan = res.plan
    const p = C.checkPlan(res.plan, ctx)
    L.plan_problems = p
    for (const x of p) { L.plan_defects.push({ unit_id: '', kind: 'static', claim: x, quote: '' }); addEvent(L, 'plan', 'static_problem', x) }
    L.answered.push(...args.answerIds)
  }
  const plan = L.plan || { lenses: [], questions: [] }
  const units = new Map((plan.lenses || []).map((u) => [u.id, u]))
  for (const uc of res.unit_checks || []) {
    const u = units.get(uc.unit_id)
    if (!u || uc.key !== C.unitKey(u)) continue // 計画が変わった後の検証は使わない
    const p = C.checkUnitVerdict(uc.result, u.id, C.unitText(u))
    if (p.length) { bump(L, `unit:${u.id}`); addEvent(L, 'plan', 'rejected_unit_check', `${u.id}: ${p.join(' / ')}`, u.id); continue }
    clear(L, `unit:${u.id}`)
    if (uc.result.defects.length) for (const d of uc.result.defects) { L.plan_defects.push({ unit_id: u.id, ...d }); addEvent(L, 'plan', 'unit_defect', `${u.id}: ${d.claim}`, u.id) }
    else L.verified_units.push(uc.key)
  }
  // 計画の観点を台帳の観点に写す。変われば枡は古くなる。
  L.lenses = [...L.lenses.filter((l) => l.origin !== 'plan'), ...(plan.lenses || []).map((l) => ({ ...l, origin: 'plan' }))]
  for (const l of L.lenses) l.version = lensVersion(l)
}

function ingestReview(L, res, args, dir) {
  const rows = new Map((res.cells || []).map((r) => [r.cell_id, r]))
  for (const sent of args.cells) {
    const c = L.cells[sent.cell_id]
    if (!c || c.status === 'gone') continue
    const row = rows.get(sent.cell_id)
    if (!row) continue // 走らなかった枡は試行に数えず、次の呼び出しで渡す
    const a = L.assets[c.asset]
    if (!a || a.hash !== sent.hash) continue // 読んだ後に対象が変わった。次の next で古い印が付く
    const before = c.attempts
    const text = readRef(dir, sent, sent.cell_id)
    settleCell(L, sent.cell_id, row, { ...withBlocks({ text }), cell_id: sent.cell_id, retro: !!a.retro })
    if (allFailed && c.attempts > before) c.env_attempts = (c.env_attempts || 0) + c.attempts - before
  }
}

function ingestGroup(L, res, args, dir) {
  const ids = readRef(dir, args.items, '束ねの全件').split('\n').map((l) => JSON.parse(l).finding)
  const keys = C.groupKeys(args.count)
  const g = res.grouping
  const p = res.status === 'blocked' ? [res.reason] : C.checkGroups(g, keys)
  if (p.length) {
    bump(L, `group:${L.cycle}`)
    addEvent(L, 'group', 'rejected_grouping', p.join(' / '))
    return
  }
  clear(L, `group:${L.cycle}`)
  const judged = new Map((res.judged || []).map((j) => [j.group.id, j]))
  const toId = (k) => ids[keys.indexOf(k)]
  for (const gr of g.groups) {
    const j = judged.get(gr.id)
    const status = j ? j.status : 'unverified'
    const id = `G${L.cycle}-${gr.id}`
    L.groups.push({ id, cycle: L.cycle, root_cause: gr.root_cause, layer: gr.layer, keys: gr.keys.map(toId), pattern: gr.pattern, status, votes: j ? j.votes : [] })
    if (status === 'refuted') continue
    // 横展開: 確かめた欠陥の型を、全ての対象の資産へ問い直す観点にする（重さで絞らない）。
    if (gr.pattern && gr.pattern.trim()) {
      const l = { id: `lat-${id}`, name: `横展開: ${gr.root_cause}`.slice(0, 120), procedure: gr.pattern, origin: `lateral:${id}` }
      l.version = lensVersion(l)
      if (!L.lenses.some((x) => x.id === l.id)) L.lenses.push(l)
    }
  }
  L.saturation.push({ cycle: L.cycle, confirmed_new: keys.length, groups: g.groups.length, lateral_lenses: g.groups.filter((x) => x.pattern && x.pattern.trim()).length })
  L.group_cycles.push(L.cycle)
  L.cycle += 1
}

// native Workflow の tasks の .output（返り値を result に包んだ形）も、そのまま受け付ける。包みの判定は coverage-build の build-cli.mjs と同じ。
export function unwrap(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return v
  return Object.hasOwn(v, 'result') && typeof v.summary === 'string' && typeof v.agentCount === 'number' ? v.result : v
}

function cmdIngest(o) {
  const dir = path.resolve(need(o, 'state'))
  const L = load(dir)
  const res = unwrap(JSON.parse(read(need(o, 'result'))))
  if (!L.pending) throw new Fail('受け取る呼び出しが無い（next を先に流す）')
  if (!res || res.call_id !== L.pending.call_id || res.stage !== L.pending.step) throw new Fail(`呼び出しが違う: 待っているのは ${L.pending.step}/${L.pending.call_id}、受け取ったのは ${res && res.stage}/${res && res.call_id}`)
  const args = JSON.parse(read(L.pending.args_path))
  if (res.status === 'blocked' && res.reason === 'args の検査に落ちた') throw new Fail('Workflow が args を拒否した（args_path のファイルの中身を書き換えずに渡し直す）', { problems: res.problems })
  // 写しの照合を先に済ませる（合わなければ台帳を変えずに拒否する）。
  const briefs = [args.brief, args.goalBrief, args.againBrief, ...(args.cells || []).map((c) => c.brief), ...(args.units || []).map((u) => u.brief)].filter(Boolean)
  for (const r of [...(args.cells || []), ...(args.index ? [args.index] : []), ...(args.items ? [args.items] : []), ...briefs]) readRef(dir, r, r.cell_id || '索引・全件・束')
  recordCall(L, res, L.pending.step)
  const seen = L.events.length
  allFailed = Array.isArray(res.agents) && res.agents.length > 0 && res.agents.every((a) => !a.ok)
  ;({ plan: ingestPlan, review: ingestReview, group: ingestGroup })[L.pending.step](L, res, args, dir)
  L.hints_read.push(...L.pending.hints)
  L.pending = null
  save(dir, L)
  // 受け付けなかった出力（rejected_*）の理由。ok は「呼び出しを台帳に取り込んだ」ことを指す。
  const rejected = L.events.slice(seen).filter((e) => e.kind.startsWith('rejected_')).map((e) => e.text)
  return { ok: true, cycle: L.cycle, coverage: coverage(L), ...(rejected.length ? { rejected } : {}), next: 'next を流す' }
}

function cmdStatus(o) {
  const dir = path.resolve(need(o, 'state'))
  const L = load(dir)
  const cur = currentFindings(L)
  const by = (k) => cur.reduce((m, f) => ({ ...m, [f[k]]: (m[f[k]] || 0) + 1 }), {})
  const roles = {}
  for (const a of L.agents) { const k = `${a.role}|${a.model}|${a.effort}`; roles[k] = roles[k] || { launched: 0, failed: 0 }; roles[k].launched++; if (!a.ok) roles[k].failed++ }
  return {
    cycle: L.cycle, stopped: L.stopped || null, pending: L.pending, coverage: coverage(L),
    skip: Object.entries(L.cells).filter(([, c]) => c.status === 'disclosed').map(([id, c]) => ({ cell: id, problems: c.problems })),
    findings: { by_verdict: by('verdict'), by_layer: by('layer'), confirmed: cur.filter((f) => f.verdict === 'confirmed').map((f) => ({ id: f.id, severity: f.severity, layer: f.layer, claim: f.claim, quote: f.quote })), unverifiable: cur.filter((f) => f.verdict === 'unverifiable').map((f) => ({ id: f.id, claim: f.claim })) },
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
  // 目標・受け入れ基準・制約・決定の記録はファイルの中身を置き換え、引用を照らし直してから目標の照合をやり直す。
  if (['goal', 'criteria', 'constraints', 'decisions'].includes(id)) {
    if (L.goal.checked_by) throw new Fail(`この台帳の目標は ${L.goal.checked_by} が照合して渡した。${L.goal.checked_by} の台帳で直す`)
    const body = o.file ? read(o.file) : need(o, 'text')
    const itemsText = (xs) => xs.map((c) => `- ${c.id}: ${c.text}${c.cites.map((q) => ` 〔${q.source}: ${q.quote}〕`).join('')}`).join('\n')
    const text = { goal: L.goal.text, request: L.request, decisions: L.decisions, criteria: itemsText(L.criteria), constraints: itemsText(L.constraints), [id]: ['goal', 'decisions'].includes(id) ? body.trim() : body }
    const g = readGoalFiles(text)
    if (g.problems.length) throw new Fail(`直した ${id} が引用の照合を通らない（台帳は変えていない）`, { problems: g.problems })
    Object.assign(L, { goal: { text: text.goal, items: g.goal, checked: false, checked_by: null, problems: [] }, decisions: text.decisions, criteria: g.criteria, constraints: g.constraints })
    clear(L, 'goal')
    // 基準・制約の id が変われば、計画の受け皿が合わなくなる。静的な欠陥として統合役に直させる。
    const ctx = { constraintIds: [...L.criteria, ...L.constraints].map((c) => c.id), lensesGiven: !needPlan(L), givenLensIds: L.lenses.filter((l) => l.origin === 'user').map((l) => l.id) }
    if (L.plan) for (const x of C.checkPlan(L.plan, ctx)) L.plan_defects.push({ unit_id: '', kind: 'static', claim: x, quote: '' })
    save(dir, L)
    return { ok: true, next: '目標の照合からやり直す。next を流す' }
  }
  const text = need(o, 'text')
  const isQ = ((L.plan && L.plan.questions) || []).some((q) => q.id === id)
  const known = isQ || L.findings[id] || L.groups.some((g) => g.id === id) || id.startsWith('attempts:')
  if (!known) throw new Fail(`台帳に無い id: ${id}`)
  if (id.startsWith('attempts:')) clear(L, id.slice('attempts:'.length))
  L.answers.push({ id, text, target_kind: isQ ? 'question' : 'finding' })
  if (isQ) {
    // 回答は利用者の言葉として決定の記録に足し、その行を引用する制約にする（引用の無い項目を作らない）。
    const said = `${id} への利用者の回答: ${text.replace(/\s*\n\s*/g, ' ')}`
    L.decisions = `${L.decisions != null ? `${L.decisions}\n` : ''}- ${said}`
    L.constraints.push({ id: `A${L.answers.length}`, text: said, cites: [{ source: 'decisions', quote: said }] })
  }
  save(dir, L)
  return { ok: true }
}

function cmdConfig(o) {
  const dir = path.resolve(need(o, 'state'))
  const config = posInts(o, [['max-cycles', 'max_cycles'], ['max-agents-total', 'max_agents_total']])
  const L = load(dir)
  Object.assign(L.config, config)
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
