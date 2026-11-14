// 台帳の決定的な部分: 単位・hash・次の 1 手・受け入れ・振り返りのグラフ・層への戻し・coverage-audit の取り込み。
// 役の出力の静的な照合は build-step.js の <checks> 区間が正本で、ここはそれを読み込んで使う（写しを持たない）。
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

const SRC = readFileSync(new URL('./build-step.js', import.meta.url), 'utf8')
export const C = new Function(`${SRC.slice(SRC.indexOf('// <checks>'), SRC.indexOf('// </checks>'))}
return { LIMITS, MAX_UNIT_PATHS, MAX_SPEC_LINES, AUDIT_LAYERS, LAYERS, LAYER_MAP, canon, norm, argsSum, quoteProblem, waves, checkArch, checkSpec, checkIntents, checkExam, checkJudge, parseCited, citeSources, checkCited, checkGoalMap, goalGaps, readGoalFiles }`)()
const WSRC = readFileSync(new URL('./build-write.js', import.meta.url), 'utf8')
const wl = WSRC.indexOf('const LIMITS')
export const WRITE_LIMITS = new Function(`${WSRC.slice(wl, WSRC.indexOf('\n', wl))}; return LIMITS`)()

export const MAX_ATTEMPTS = 2 // 同じ段・単位の欠け（返らない・照合に落ちる）の上限。run をまたいで数える
export const DRY_ROUNDS = 2 // 振り返りで新しい原因が受理されない周がこの回数続いたら止める
export const RETRO_MAX_ROUNDS = 4 // 1 回の振り返りの周の上限
const MAX_FAIL_STREAK = 2 // 全ての役が欠けた呼び出しがこの回数続いたら止める
const DEFAULT_CONFIG = { max_cycles: 4, max_agents_total: 400, max_unit_rounds: 2 }
const RANK = { 目標: 0, 設計: 1, 実装: 2 } // 上流ほど小さい。進め方は成果物の層でなく、報告だけにする
// 成果物でなく進め方の出来事（原因が確かめられなければ進め方として報告に回す）。
const PROCESS_KINDS = ['agent_missing', 'rejected_output', 'not_seen', 'write_outside', 'import_mismatch', 'input_not_read', 'unit_removed', 'audit_internal']
export const PHASES = ['baseline', 'design', 'impl', 'review']

export const sha = (s) => createHash('sha256').update(String(s)).digest('hex')
const arr = (a) => (Array.isArray(a) ? a : [])

export const readGoalFiles = C.readGoalFiles
export const goalIds = (L) => [...L.goal.items, ...L.criteria, ...L.constraints].map((c) => c.id)
export const goalSources = (L) => C.citeSources({ request: L.request, ...(L.decisions != null ? { decisions: L.decisions } : {}) })

export function newLedger({ mode, repo, goal, goalItems, request, decisions, criteria, constraints, inputs, targets, checks, config, roles }) {
  return {
    version: 1, rev: 0, mode, repo, cycle: 1, goal: { text: goal, items: goalItems, checked: false, problems: [] }, request, decisions, criteria, constraints, inputs, targets, checks,
    config: { ...DEFAULT_CONFIG, ...config }, roles, arch: null, need_arch: mode !== 'review', arch_rounds: 0, arch_causes: [], units: {}, audits: {}, baseline: null,
    checks_run: null, events: [], facts: [], intents: [], retro: { rounds: 0, dry: 0, due: false }, human: [], answers: [], notes: [], routes: [],
    attempts: {}, fail_streak: 0, agents: [], calls: [], hints_read: [], pending: null, stopped: null,
  }
}

const unitFields = (u) => ({ id: u.id, kind: u.kind, title: u.title, responsibility: u.responsibility, paths: u.paths, tests: u.tests, depends_on: u.depends_on, covers: u.covers })
export const designHash = (u) => sha(C.canon({ ...unitFields(u), spec: u.spec, acceptance: u.acceptance, cases: u.cases })).slice(0, 16)
export const unitList = (L) => arr(L.arch && L.arch.units).map((id) => L.units[id]).filter(Boolean)
export const ownedPaths = (L) => unitList(L).flatMap((u) => [...u.paths, ...u.tests])
export function ownerOf(L, rel) {
  for (const u of unitList(L)) { if (u.paths.includes(rel)) return { unit: u.id, test: false }; if (u.tests.includes(rel)) return { unit: u.id, test: true } }
  return { unit: null, test: false }
}
export const coverIds = (L) => [...L.criteria, ...L.constraints].map((c) => c.id)
const dependents = (L, id) => {
  const out = new Set([id])
  for (let grew = true; grew;) { grew = false; for (const u of unitList(L)) if (!out.has(u.id) && u.depends_on.some((d) => out.has(d))) { out.add(u.id); grew = true } }
  return [...out]
}

// 設計の写し: 方式設計 1 枚と単位ごとに 1 枚。coverage-audit の資産と単位が 1 対 1 で結び付くように分ける。
export function renderDesign(L) {
  if (!L.arch) return {}
  const us = unitList(L)
  const files = {
    '_architecture.md': [`# 方式設計`, '', '| 単位 | 種類 | 責務 | 持つファイル | テスト | 依存 | 効く基準・制約 |', '|---|---|---|---|---|---|---|',
      ...us.map((u) => `| ${u.id} ${u.title} | ${u.kind} | ${u.responsibility} | ${u.paths.join('<br>')} | ${u.tests.join('<br>') || '-'} | ${u.depends_on.join(', ') || '-'} | ${u.covers.join(', ')} |`)].join('\n') + '\n',
  }
  for (const u of us) {
    // 見出しは 1 つだけにする（coverage-audit は見出しごとに資産を切るので、単位が 1 つの資産になり、短い節の枡が増えない）。
    files[`${u.id}.md`] = [`# ${u.id}: ${u.title}`, '', `**責務**: ${u.responsibility}`, '', `**持つファイル**: ${u.paths.join(', ')}`, ...(u.tests.length ? ['', `**テスト（実装より先に別の担当が書く）**: ${u.tests.join(', ')}`] : []),
      '', '**仕様**', '', u.spec || '（未設計）', '', '**受け入れ**', '', ...u.acceptance.map((a) => `- ${a.id}: ${a.text}`), ...(u.cases.length ? ['', '**ケース**', '', '| 条件 | 期待 |', '|---|---|', ...u.cases.map((c) => `| ${c.condition} | ${c.expect} |`)] : [])].join('\n') + '\n'
  }
  return files
}

const eventId = (L) => `E${L.events.length + 1}`
export function addEvent(L, e) { const ev = { id: eventId(L), cycle: L.cycle, retro: null, unit: null, test: false, layer: null, ...e }; L.events.push(ev); return ev }
export const dueEvents = (L) => L.events.filter((e) => !e.retro)
// 受理した原因（事実）が、どの出来事を根拠に辿るか。
function coveredBy(L) {
  const facts = new Map(L.facts.map((f) => [f.id, f]))
  const memo = new Map()
  const evOf = (id, seen = new Set()) => {
    if (!facts.has(id)) return new Set([id])
    if (memo.has(id)) return memo.get(id)
    if (seen.has(id)) return new Set()
    seen.add(id)
    const s = new Set(facts.get(id).basis.flatMap((b) => [...evOf(b, seen)]))
    memo.set(id, s)
    return s
  }
  const by = new Map()
  for (const f of L.facts) for (const e of evOf(f.id)) by.set(e, [...(by.get(e) || []), f])
  return by
}
export function retroConcluded(L) {
  const due = dueEvents(L)
  if (!due.length) return true
  const by = coveredBy(L)
  return due.every((e) => by.has(e.id)) || L.retro.dry >= DRY_ROUNDS || L.retro.rounds >= RETRO_MAX_ROUNDS
}

// 出来事ごとに戻す層を決める。振り返りの原因は層を上げられるが、下げられない（監査の層より下には戻さない）。
export function layerOf(e, facts) {
  const fl = facts.map((f) => f.layer)
  const art = [...fl, e.layer].filter((x) => x in RANK).sort((a, b) => RANK[a] - RANK[b])
  if (art.length) return art[0]
  if (fl.includes('進め方') || PROCESS_KINDS.includes(e.kind)) return '進め方'
  return null
}

// 振り返りの結論を、原因の層へ戻す。指摘の箇所だけを直す経路は無い（単位の設計か実装を丸ごとやり直す）。
export function route(L) {
  const by = coveredBy(L)
  const redo = { arch: false, design: new Set(), tests: new Set(), impl: new Set() }
  const causes = new Map()
  const note = (k, s) => causes.set(k, [...(causes.get(k) || []), s])
  for (const e of dueEvents(L)) {
    const fs = by.get(e.id) || []
    const layer = layerOf(e, fs)
    e.retro = L.cycle
    L.routes.push({ event: e.id, cycle: L.cycle, layer, unit: e.unit, by: fs.length ? fs.map((f) => f.id) : e.layer ? 'audit' : 'none' })
    if (L.mode === 'review') continue // 確かめるだけ。戻す先は報告に載せる
    const why = `${e.id}: ${e.text}${fs.length ? `（原因: ${fs.map((f) => `${f.id} ${f.cause}`).join(' / ')}）` : ''}`
    const human = (reason) => L.human.push({ id: e.id, reason, text: e.text })
    if (layer === null) human('原因の層を決められない')
    else if (layer === '目標') human('目標・方針の層の欠陥')
    else if (layer === '進め方') L.notes.push(why)
    else if (layer === '設計') { if (e.unit && L.units[e.unit]) { redo.design.add(e.unit); note(e.unit, why) } else { redo.arch = true; note('arch', why) } }
    else if (e.unit && L.units[e.unit]) { (e.test ? redo.tests : redo.impl).add(e.unit); note(e.unit, why) }
    else human('実装の欠陥だが、どの単位のものか決まらない')
  }
  const touched = new Set()
  if (redo.arch) { L.need_arch = true; L.arch_rounds += 1; L.arch_causes = causes.get('arch') }
  for (const id of redo.design) for (const d of dependents(L, id)) { L.units[d].need_design = true; touched.add(d) }
  for (const id of redo.tests) { L.units[id].tests_for = null; L.units[id].impl_for = null; touched.add(id) }
  for (const id of redo.impl) { L.units[id].impl_for = null; touched.add(id) }
  for (const id of touched) { const u = L.units[id]; u.rounds += 1; u.causes = causes.get(id) || [`上流の単位の設計がやり直しになった`] }
  if (L.arch_rounds > L.config.max_unit_rounds && redo.arch) L.human.push({ id: 'rounds:arch', reason: `方式設計のやり直しが ${L.config.max_unit_rounds} 回を超えた`, text: arr(L.arch_causes).join(' / ') })
  for (const id of touched) if (L.units[id].rounds > L.config.max_unit_rounds) L.human.push({ id: `rounds:${id}`, reason: `単位 ${id} のやり直しが ${L.config.max_unit_rounds} 回を超えた`, text: L.units[id].causes.join(' / ') })
  // やり直した後は、中身が同じでもレビューと check をやり直す（同じ欠陥が残れば、もう一度戻して上限で止まる）。
  if (redo.arch || touched.size) { L.cycle += 1; delete L.audits.impl; L.checks_run = null }
  if (redo.arch || redo.design.size) delete L.audits.design
  L.retro = { rounds: 0, dry: 0, due: false }
}

const answered = (L, id) => L.answers.some((a) => a.id === id)
export const testsTodo = (L) => unitList(L).filter((u) => u.kind === 'code' && !u.need_design && u.design_hash && u.tests_for !== u.design_hash)
export function implTodo(L) {
  const ready = (u) => !u.need_design && u.design_hash && u.impl_for !== u.design_hash && (u.kind === 'doc' || u.tests_for === u.design_hash)
    && u.depends_on.every((d) => L.units[d] && L.units[d].impl_for === L.units[d].design_hash)
  return unitList(L).filter(ready)
}

// 次の 1 手か停止を、台帳と今のファイルの hash（keys）だけから決める。
export function decide(L, { keys = {}, missing = [] } = {}) {
  const stop = (kind, reasons, extra = {}) => ({ stop: kind, reasons, ...extra })
  if (missing.length) return stop('blocked', [`読めないファイル: ${missing.join(', ')}`], { cause: 'input' })
  if (L.fail_streak >= MAX_FAIL_STREAK) return stop('blocked', [`全ての役が欠けた呼び出しが ${L.fail_streak} 回続いた`], { cause: 'failure' })
  if (L.cycle > L.config.max_cycles) return stop('limit', [`周が上限 ${L.config.max_cycles} を超えた`])
  if (L.agents.length >= L.config.max_agents_total) return stop('limit', [`起動数が上限 ${L.config.max_agents_total} に達した（${L.agents.length}）`])
  if (L.goal.problems.length) return stop('needs_input', ['依頼文・決定の記録が求める成果のうち、目標・基準・制約のどの項目も受け止めていないものがある'], { goal_gaps: L.goal.problems })
  const stuck = Object.entries(L.attempts).filter(([, n]) => n >= MAX_ATTEMPTS).map(([k]) => k)
  if (stuck.length) return stop('needs_input', ['試行の上限まで欠けた段がある'], { stuck })
  const human = L.human.filter((h) => !answered(L, h.id))
  if (human.length) return stop('needs_input', ['人間が決める欠陥がある（目標・方針の層、層を決められない、やり直しの上限）'], { human })
  const openQ = arr(L.arch && L.arch.questions).filter((q) => !answered(L, q.id))
  if (openQ.length) return stop('needs_input', ['利用者への質問がある'], { questions: openQ })
  if (L.retro.due) return retroConcluded(L) ? { step: 'route' } : { step: 'retro' }
  const audited = (p) => L.audits[p] && L.audits[p].imported === keys[p]
  if (L.mode === 'review' && !L.goal.checked) return { step: 'design' } // 目標の照合だけ（照合はこのスキルの 1 か所で行い、coverage-audit には照合済みとして渡す）
  if (L.mode === 'review') return audited('review') ? stop('complete', ['対象を検査し、振り返りで戻す先の層を決めた（確かめるだけで直さない）']) : { step: 'audit', phase: 'review' }
  // update: 目標の固定 → 現状の検査 → 設計。現状の検査は 1 度だけ（実装で対象が変わった後に、変わった対象を現状として検査し直さない）。
  if (L.mode === 'update' && !L.goal.checked) return { step: 'design' }
  if (L.mode === 'update' && !L.audits.baseline) return { step: 'audit', phase: 'baseline' }
  if (!L.goal.checked || L.need_arch || unitList(L).some((u) => u.need_design)) return { step: 'design' }
  if (!audited('design')) return { step: 'audit', phase: 'design' }
  if (testsTodo(L).length) return { step: 'tests' }
  if (implTodo(L).length) return { step: 'implement' }
  if (unitList(L).some((u) => u.impl_for !== u.design_hash)) return stop('blocked', ['実装の残った単位があるのに、依存が揃わず進めない'], { cause: 'failure' })
  if (L.checks.length && (!L.checks_run || L.checks_run.key !== keys.impl)) return { step: 'checks' }
  if (!audited('impl')) return { step: 'audit', phase: 'impl' }
  return stop('complete', ['全ての単位を設計・実装し、設計レビューと実装レビューを通し、戻す欠陥が残っていない'])
}

// 起動の前に最悪の起動数を見積もる。
export function estimate(step, args) {
  if (step === 'design') return C.LIMITS.maxAgents
  if (step === 'retro') return C.LIMITS.maxAgents
  return args.tasks.length
}

export function ingestDesign(L, res, args, readText) {
  const bump = (k, text, unit = null) => { L.attempts[k] = (L.attempts[k] || 0) + 1; addEvent(L, { stage: 'design', kind: 'rejected_output', text, unit }) }
  // 目標の照合: 照合役が挙げた成果の引用・項目の id を照らし、どの項目にも受け止められていない成果があれば人間に返す。
  if (args.goalBrief) {
    const g = res.goal_check
    const p = C.checkGoalMap(g, args.goalIds, goalSources(L))
    if (p.length) bump('goal', `目標の照合: ${p.join(' / ')}`)
    else {
      delete L.attempts.goal
      L.goal.problems = C.goalGaps(g)
      L.goal.checked = !L.goal.problems.length
    }
  }
  if (args.arch) {
    const a = res.arch && res.arch.result
    const p = a ? C.checkArch(a, args.arch.ctx) : ['方式設計が返らなかった']
    if (a && !p.length) for (const r of a.inputs_read) { const t = readText(r.path); for (const q of r.quotes) { const e = t == null ? '入力が読めない' : C.quoteProblem(q, t); if (e) p.push(`入力 ${r.path}: ${e}`) } }
    if (p.length) { bump('arch', `方式設計: ${p.join(' / ')}`); return }
    delete L.attempts.arch
    const ids = a.units.map((u) => u.id)
    for (const id of Object.keys(L.units)) if (!ids.includes(id)) { addEvent(L, { stage: 'design', kind: 'unit_removed', text: `単位 ${id} が方式設計から消えた（持っていたファイルは残る）` }); delete L.units[id] }
    for (const u of a.units) {
      const old = L.units[u.id] || { spec: '', acceptance: [], cases: [], design_hash: null, tests_for: null, impl_for: null, tests_hash: {}, impl_hash: {}, rounds: 0, causes: [] }
      L.units[u.id] = { ...old, ...unitFields(u), need_design: true }
    }
    L.arch = { units: ids, inputs_read: a.inputs_read, inputs_not_read: a.inputs_not_read, questions: a.questions }
    for (const r of a.inputs_not_read) addEvent(L, { stage: 'design', kind: 'input_not_read', text: `入力 ${r.path} を読まずに設計した（${r.reason}）` })
    L.need_arch = false
  }
  for (const s of arr(res.specs)) {
    const u = L.units[s.unit_id]
    if (!u || !u.need_design) continue
    const p = s.result ? C.checkSpec(s.result, u) : ['詳細設計が返らなかった']
    if (p.length) { bump(`design:${u.id}`, `${u.id} の詳細設計: ${p.join(' / ')}`, u.id); continue }
    delete L.attempts[`design:${u.id}`]
    Object.assign(u, { spec: s.result.spec, acceptance: s.result.acceptance.map((t, i) => ({ id: `${u.id}A${i + 1}`, text: t })), cases: s.result.cases, need_design: false })
    u.design_hash = designHash(u)
  }
}

// 書き込みの段の照合: 呼び出しの前後の hash で、受け持ちの外の変更と、書くはずのファイルの欠けを見る。
export function ingestWrite(L, res, args, before, after) {
  const stage = args.stage
  const allowed = new Set(args.tasks.flatMap((t) => t.paths))
  const outside = Object.keys({ ...before, ...after }).filter((p) => before[p] !== after[p] && !allowed.has(p))
  if (outside.length) addEvent(L, { stage, kind: 'write_outside', text: `受け持ちの外のファイルが変わった: ${outside.join(', ')}（この呼び出しの単位を全て受け付けない）` })
  const rows = new Map(arr(res.results).map((r) => [r.unit_id, r.result]))
  for (const t of args.tasks) {
    const u = L.units[t.unit_id]
    if (!u) continue
    const r = rows.get(t.unit_id)
    const p = []
    if (!r) p.push('返らなかった')
    else {
      if (r.unit_id !== t.unit_id) p.push(`unit_id が違う: ${r.unit_id}`)
      for (const w of arr(r.written)) if (!t.paths.includes(w)) p.push(`受け持ちの外を書いたと申告した: ${w}`)
    }
    for (const f of t.paths) if (after[f] == null) p.push(`${f} が無い`)
    if (stage === 'implement') for (const f of u.tests) if (after[f] !== u.tests_hash[f]) p.push(`テストのファイル ${f} がテストの担当の書いた内容と違う`)
    if (outside.length) p.push('受け持ちの外のファイルが変わった呼び出し')
    const k = `${stage}:${u.id}`
    if (p.length) { L.attempts[k] = (L.attempts[k] || 0) + 1; addEvent(L, { stage, kind: r ? 'rejected_output' : 'agent_missing', unit: u.id, text: `${u.id}: ${p.join(' / ')}` }); continue }
    delete L.attempts[k]
    const pick = (fs) => Object.fromEntries(fs.map((f) => [f, after[f]]))
    if (stage === 'tests') Object.assign(u, { tests_for: u.design_hash, tests_hash: pick(u.tests) })
    else Object.assign(u, { impl_for: u.design_hash, impl_hash: pick(u.paths) })
    if (arr(r.unresolved).length) addEvent(L, { stage, kind: 'unresolved', unit: u.id, test: stage === 'tests', text: `${u.id} が果たせなかったこと: ${r.unresolved.join(' / ')}` })
  }
}

// 振り返りの 1 周の受け入れ。原因（事実）は、実行役の引用が本文に逐語であり、別の検証役が受理したものだけ。
export function ingestRetro(L, res, args, readText) {
  L.retro.rounds += 1
  const p = res.intents ? C.checkIntents(res.intents, args.knownIds) : ['意図が返らなかった']
  if (p.length) { L.attempts.retro = (L.attempts.retro || 0) + 1; addEvent(L, { stage: 'retro', kind: 'rejected_output', text: `振り返りの計画: ${p.join(' / ')}` }); }
  else delete L.attempts.retro
  const intents = p.length ? [] : arr(res.intents.intents)
  const exams = new Map(arr(res.exams).map((x) => [x.index, x]))
  let added = 0
  intents.forEach((it, i) => {
    const id = `I${L.intents.length + 1}`
    const x = exams.get(i)
    let status = 'not_run'
    let why = ''
    if (x) {
      const ep = C.checkExam(x.exam)
      if (ep.length) { status = 'rejected'; why = ep.join(' / ') }
      else if (x.exam.verdict !== 'supported') status = x.exam.verdict
      else {
        for (const e of x.exam.evidence) { const t = readText(e.path); const q = t == null ? '読めないか、読める範囲の外' : C.quoteProblem(e.quote, t); if (q) ep.push(`${e.path}: ${q}`) }
        if (ep.length) { status = 'rejected'; why = ep.join(' / ') }
        else if (C.checkJudge(x.judge).length || !x.judge.accept) { status = 'refuted'; why = x.judge ? x.judge.reason : '検証役が返らなかった' }
        else {
          status = 'accepted'
          L.facts.push({ id: `F${L.facts.length + 1}`, cycle: L.cycle, basis: it.basis, cause: x.exam.cause, layer: x.exam.layer, evidence: x.exam.evidence, intent: id })
          added += 1
        }
      }
    }
    L.intents.push({ id, cycle: L.cycle, ...it, status, why })
  })
  L.retro.dry = added ? 0 : L.retro.dry + 1
}

// coverage-audit の指摘の id（枡#hash、枡は 資産|観点|回、資産は path#見出し）から path を取る。
// coverage-audit 自身の振り返りの資産（retro:c<周>:<段>）は対象のファイルでないので null。
export function findingPath(id) {
  const cell = String(id).slice(0, String(id).lastIndexOf('#'))
  const asset = cell.split('|')[0]
  if (asset.startsWith('retro:') || !asset.includes('#')) return null
  return asset.slice(0, asset.lastIndexOf('#'))
}

// coverage-audit の status の出力を取り込む。終わった検査だけを受け、引用を今の本文に照らし、指摘を単位と層へ結ぶ。
export function importAudit(L, status, phase, { readText, unitOfPath }) {
  const st = status && status.stopped
  if (!st || !['complete', 'needs_input'].includes(st.stop)) throw new Error(`coverage-audit が終わっていない（stopped: ${st ? st.stop : 'なし'}）。coverage-audit の「止まったとき」に従ってから取り込む`)
  if (status.pending != null) throw new Error('coverage-audit の呼び出しが途中にある（stopped は前の停止の記録）。coverage-audit を止まるまで回してから取り込む')
  if (arr(status.coverage && status.coverage.pending).length) throw new Error(`coverage-audit に読み終えていない枡が ${status.coverage.pending.length} 件ある。coverage-audit を続けてから取り込む`)
  const stage = `${phase}_review`
  const base = { findings: [], unverifiable: [], not_seen: arr(status.skip).map((s) => s.cell) }
  for (const f of arr(status.findings && status.findings.confirmed)) {
    const path = findingPath(f.id)
    if (path === null) { addEvent(L, { stage, kind: 'audit_internal', text: `coverage-audit の進め方の指摘 ${f.id}: ${f.claim}` }); continue }
    const t = readText(path)
    const q = t == null ? '対象が読めない' : C.quoteProblem(f.quote, t)
    const layer = C.LAYER_MAP[f.layer]
    if (q || !layer) { addEvent(L, { stage, kind: 'import_mismatch', text: `${f.id}: ${q || `層が不正: ${f.layer}`}` }); continue }
    if (phase === 'baseline') {
      base.findings.push({ id: f.id, path, layer, claim: f.claim, quote: f.quote })
      if (layer === '目標') L.human.push({ id: `B${L.human.length + 1}`, reason: '現状の検査で目標・方針の層の欠陥が出た（設計に進まない）', text: `${f.claim}（${path}: ${f.quote}）` })
      continue
    }
    const m = unitOfPath(path)
    addEvent(L, { stage, kind: 'finding', layer, unit: m.unit, test: m.test, text: `${f.claim}（${path}: 「${f.quote}」）`, ref: f.id })
  }
  for (const f of arr(status.findings && status.findings.unverifiable)) {
    if (phase === 'baseline') base.unverifiable.push(f)
    else addEvent(L, { stage, kind: 'unverifiable', text: `検証不能の指摘 ${f.id}: ${f.claim}`, ref: f.id })
  }
  if (phase === 'baseline') L.baseline = base
  else for (const c of base.not_seen) addEvent(L, { stage, kind: 'not_seen', text: `見ていない枡（開示）: ${c}` })
  return base
}
