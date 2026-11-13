// 台帳の決定的な部分: 資産の列挙・ID・枡・持ち越し・受け入れ・止める条件・見積もり。
// 役の出力の静的な照合は Workflow source の <checks> 区間が正本で、ここはそれを読み込んで使う（写しを持たない）。
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const SRC = readFileSync(new URL('./coverage-ledger.js', import.meta.url), 'utf8')
const BLOCK = SRC.slice(SRC.indexOf('// <checks>'), SRC.indexOf('// </checks>'))
export const C = new Function(`${BLOCK}
return { LIMITS, PER_CELL, QUOTE_MIN, LAYERS, SEVERITIES, VERDICTS, DESTS, RESERVED_LENSES, norm, argsSum, quoteProblem, checkRead, checkVerify, settleVerdict, unitKey, unitText, checkPlan, checkRoutes, checkUnitVerdict, checkProposal, checkWriter, checkGroups }`)()

export const MAX_ATTEMPTS = 2 // 同じ枡の欠け（読めない・照合に落ちる）の上限。run をまたいで数える
export const PLAN_ROUNDS = 2 // 欠陥を直す統合のやり直しの上限
export const CHUNK_LINES = 80 // 見出しの無いファイルを切る行数
export const MAX_ASSET_LINES = 120 // 1 体に渡す本文の上限（G17）。超える節は切る
export const ROUTE_BATCH = 15 // 振り分け役 1 体に渡す入力の件数
export const MAX_ROUTE_BATCHES = 10
export const UPPER = ['方針', '要求']
export const DEFAULT_CONFIG = { k: 1, max_cycles: 4, max_sections: 12, max_agents_total: 600 }

// スキルが持つ観点。目的の観点（目標の固定を review にも当てる）と、層の観点（G06）。
export const SKILL_LENSES = [
  { id: 'purpose', name: '目的と固定した制約', procedure: 'この部分の主張ごとに、固定した目標と制約のどれに効くかを対応づけてから、効かない主張、制約と食い違う主張、目標に要るのに書かれていないことを探す。' },
  { id: 'layer', name: '層と範囲', procedure: 'この部分の内容ごとに層（方針・要求・方式設計・詳細設計・実装）を判定してから、成果物の層より上の決め直し、下の層の細部の書き過ぎ、範囲の外への広がり、上の層へ戻すべき欠陥を探す。' },
]
// 振り返りの観点（振り返りの Workflow の L1〜L4 を一般化）。
export const RETRO_LENSES = [
  { id: 'R1', name: '網羅と測れたか', procedure: 'この段で何を網羅すべきだったか（対象・観点・入力）を先に列挙し、出来事の記録と照らす。次に、効果や欠陥を後から測れる記録（同一性・根拠・件数）が残っているかを確かめる。' },
  { id: 'R2', name: '正しさと一貫性', procedure: 'この段の出力が、誤り・食い違い・確かめていない主張をそのまま次の段へ流していないかを、出来事の具体例で確かめる。生成と検証が分かれていたかも見る。' },
  { id: 'R3', name: '費用とモデル・effort', procedure: 'この段の起動数と欠測の内訳から、役の難しさに対してモデルと effort が過大か過小かを判定する。同じ結果をより少ない費用で得られた形があれば挙げる。' },
  { id: 'R4', name: '層と範囲', procedure: 'この段が目標の範囲と成果物の層に合っていたか、範囲の外へ広がったか狭めすぎたか、欠陥を原因の層へ戻せたかを、出来事から判定する。' },
]

export const sha = (s) => createHash('sha256').update(String(s)).digest('hex')
const lensVersion = (l) => sha(JSON.stringify([l.name, l.procedure, l.items || []])).slice(0, 12)
const slug = (s) => s.toLowerCase().replace(/[`*_~[\]()<>#:"'!?,.。、（）「」]/g, '').trim().replace(/\s+/g, '-') || 'section'

// 読んだ証拠の区画: 本文を need 個の窓に分け、各窓から 1 つは引用させる（M5）。
function withBlocks(a) {
  const n = a.text.split('\n').length
  const need = Math.min(4, Math.max(1, Math.ceil(n / 40)))
  const size = Math.ceil(n / need)
  const blocks = []
  for (let s = 0; s < n; s += size) blocks.push([s, Math.min(n, s + size) - 1])
  return { ...a, blocks, need: blocks.length }
}

// ファイルを資産に分ける。見出しのある Markdown は見出しの経路を ID にし（行がずれても同じ節は同じ ID）、それ以外は行の塊。
export function splitAssets(rel, text) {
  const lines = text.split('\n')
  const parts = []
  if (/\.(md|markdown)$/i.test(rel) && lines.some((l) => /^#{1,6}\s/.test(l))) {
    const stack = []
    let cur = { key: '_top', heading: '', start: 0 }
    const flush = (end) => { if (end > cur.start || cur.key !== '_top') parts.push({ ...cur, end }) }
    lines.forEach((l, i) => {
      const m = /^(#{1,6})\s+(.*)$/.exec(l)
      if (!m) return
      flush(i)
      const lv = m[1].length
      while (stack.length && stack[stack.length - 1].lv >= lv) stack.pop()
      stack.push({ lv, s: slug(m[2]), h: m[2].trim() })
      cur = { key: stack.map((x) => x.s).join('/'), heading: m[2].trim(), trail: stack.map((x) => x.h), start: i }
    })
    flush(lines.length)
  } else {
    for (let s = 0, n = 1; s < lines.length; s += CHUNK_LINES, n++) parts.push({ key: `c${n}`, heading: '', start: s, end: Math.min(lines.length, s + CHUNK_LINES) })
  }
  const out = []
  const used = new Map()
  for (const p of parts) {
    for (let s = p.start, n = 1; s < p.end; s += MAX_ASSET_LINES, n++) {
      let id = `${rel}#${p.key}${p.end - p.start > MAX_ASSET_LINES ? `/c${n}` : ''}`
      const k = (used.get(id) || 0) + 1
      used.set(id, k)
      if (k > 1) id += `~${k}`
      const t = lines.slice(s, Math.min(p.end, s + MAX_ASSET_LINES)).join('\n')
      if (!t.split('\n').some((l) => l.trim() && !/^#{1,6}\s/.test(l))) continue // 見出しだけの塊は読む本文が無い
      out.push(withBlocks({ id, path: rel, heading: p.heading, trail: p.trail || [], start: s + 1, text: t, hash: sha(t).slice(0, 16) }))
    }
  }
  return out
}

// 材料を ID・種類・出所・全文付きの項目に分ける（build-inputs.mjs の一般化）。要約は入れない。
export function splitItems(file, text, prefix, routable = true) {
  const items = []
  const add = (id, kind, t, lines, r = routable) => { if (String(t).trim()) items.push({ id, kind, routable: r, text: String(t).trim(), source: { path: file, lines } }) }
  if (/\.jsonl$/i.test(file)) {
    text.split('\n').forEach((l, i) => {
      if (!l.trim()) return
      const o = JSON.parse(l)
      add(o.id || `${prefix}${i + 1}`, o.kind || prefix, typeof o.text === 'string' ? o.text : JSON.stringify(o), [i + 1, i + 1], o.routable === undefined ? routable : !!o.routable)
    })
  } else if (/\.(md|markdown)$/i.test(file) && /^#{1,6}\s/m.test(text)) {
    const L = text.split('\n')
    const heads = L.map((l, i) => (/^#{1,6}\s/.test(l) ? i : -1)).filter((i) => i >= 0)
    if (heads[0] > 0) add(`${prefix}0`, 'section', L.slice(0, heads[0]).join('\n'), [1, heads[0]])
    heads.forEach((h, k) => { const e = k + 1 < heads.length ? heads[k + 1] : L.length; add(`${prefix}${k + 1}`, 'section', L.slice(h, e).join('\n'), [h + 1, e]) })
  } else add(`${prefix}1`, 'file', text, [1, text.split('\n').length])
  return items
}

// 制約: 「- 」で始まる行を 1 件にする。「D1: ...」のように id で始まればその id を使う。
export function parseConstraints(text) {
  const out = []
  for (const l of text.split('\n')) {
    const m = /^-\s+(.*)$/.exec(l)
    if (!m) continue
    const idm = /^([A-Z][A-Z0-9]*\d)[:：]\s*(.*)$/.exec(m[1])
    out.push(idm ? { id: idm[1], text: idm[2] } : { id: `K${out.length + 1}`, text: m[1] })
  }
  const ids = out.map((c) => c.id)
  if (new Set(ids).size !== ids.length) throw new Error('制約の id が重複している')
  return out
}

export function newLedger({ mode, goal, request, constraints, targets, artifact, items, lenses, config, roles, seeds }) {
  const L = {
    version: 1, rev: 0, mode, cycle: 1, goal: { text: goal, checked: false, problems: [] }, request, constraints,
    config: { ...DEFAULT_CONFIG, ...config }, roles, targets, artifact: artifact || null, items, seeds: seeds || [],
    plan: null, plan_rounds: 0, plan_defects: [], plan_problems: [], routes: [], verified_units: [], answers: [], answered: [],
    proposals: {}, issue_defects: {}, writer_defects: [], sections: [], written: false,
    lenses: [...SKILL_LENSES.map((l) => ({ ...l, origin: 'skill' })), ...(lenses || []).map((l) => ({ ...l, origin: 'user' })), ...RETRO_LENSES.map((l) => ({ ...l, origin: 'skill', retro: true }))],
    attempts: {}, env_attempts: {}, fail_streak: 0,
    assets: {}, cells: {}, findings: {}, events: [], groups: [], retro_cycles: [], group_cycles: [], saturation: [],
    calls: [], agents: [], hints_read: [], pending: null,
  }
  for (const l of L.lenses) l.version = lensVersion(l)
  return L
}

const targetLenses = (L) => L.lenses.filter((l) => !l.retro)
// 今のファイルの内容に台帳を合わせる。変わった資産・観点の枡は古い印を付けて読み直す（持ち越し）。
export function refresh(L, assets, { partial = false } = {}) {
  const now = new Map(assets.map((a) => [a.id, a]))
  const changes = { added: [], stale: [], gone: [] }
  for (const a of assets) {
    if (!L.assets[a.id]) changes.added.push(a.id)
    L.assets[a.id] = { path: a.path, heading: a.heading, trail: a.trail || [], start: a.start, hash: a.hash, ...(a.retro ? { retro: true, text: a.text, blocks: a.blocks, need: a.need } : {}) }
  }
  if (!partial) for (const id of Object.keys(L.assets)) if (!now.has(id) && !L.assets[id].retro) { changes.gone.push(id); delete L.assets[id] }
  const wantLens = new Map(L.lenses.map((l) => [l.id, l]))
  for (const a of assets) {
    for (const l of a.retro ? L.lenses.filter((x) => x.retro) : targetLenses(L)) {
      for (let p = 1; p <= L.config.k; p++) {
        const id = `${a.id}|${l.id}|p${p}`
        const c = L.cells[id]
        if (!c) { L.cells[id] = { asset: a.id, lens: l.id, pass: p, status: 'unseen', asset_hash: a.hash, lens_version: l.version, attempts: 0, problems: [], outside_notes: [] }; continue }
        if (c.status === 'gone' || c.asset_hash !== a.hash || c.lens_version !== l.version) {
          if (c.status !== 'unseen') changes.stale.push(id)
          Object.assign(c, { status: 'unseen', asset_hash: a.hash, lens_version: l.version, attempts: 0, problems: [] })
          for (const f of Object.values(L.findings)) if (f.cell === id && f.status === 'current') f.status = 'superseded'
        }
      }
    }
  }
  for (const [id, c] of Object.entries(L.cells)) {
    const a = L.assets[c.asset]
    if ((!a || !wantLens.has(c.lens)) && c.status !== 'gone') {
      c.status = 'gone'
      for (const f of Object.values(L.findings)) if (f.cell === id && f.status === 'current') f.status = 'gone'
    }
  }
  return changes
}

export const eventId = (L) => `E${L.cycle}-${L.events.filter((e) => e.cycle === L.cycle).length + 1}`
export function addEvent(L, stage, kind, text, ref = null) { L.events.push({ id: eventId(L), cycle: L.cycle, stage, kind, text, ref }) }
// 同じ枡の別々の指摘を 1 件に潰さない（H4）: 枡・引用・主張から決める。
export const findingId = (cell, f) => `${cell}#${sha(`${C.norm(f.quote)}|${C.norm(f.claim)}`).slice(0, 10)}`

export function coverage(L) {
  const live = Object.entries(L.cells).filter(([, c]) => c.status !== 'gone')
  const by = (s) => live.filter(([, c]) => c.status === s).map(([id]) => id)
  // settled は「読みを受け付け、指摘があれば全て検証役が判定した」。指摘の無い枡は検証役を通っていない（見ただけ）ので別に数える。
  const settled = live.filter(([, c]) => c.status === 'settled')
  return { cells: live.length, settled: settled.length, settled_with_verifier: settled.filter(([, c]) => c.verifier).length, settled_no_findings: settled.filter(([, c]) => !c.verifier).length, disclosed: by('disclosed'), pending: [...by('unseen'), ...by('seen')] }
}
export const currentFindings = (L) => Object.entries(L.findings).filter(([, f]) => f.status === 'current').map(([id, f]) => ({ id, ...f }))
const needUnits = (L) => L.mode === 'create' || !L.lenses.some((l) => l.origin === 'user')
const routable = (L) => L.items.filter((i) => i.routable)

// 次の 1 手か停止を、台帳だけから決める（探索グラフの意図は台帳から導く）。
export function decide(L, { missingTargets = [] } = {}) {
  const stop = (kind, reasons, extra = {}) => ({ stop: kind, reasons, ...extra })
  if (missingTargets.length) return stop('blocked', [`対象が読めない: ${missingTargets.join(', ')}`], { cause: 'input' })
  if (L.fail_streak >= 2) return stop('blocked', [`全ての役が欠けた呼び出しが ${L.fail_streak} 回続いた`], { cause: 'failure' })
  if (L.cycle > L.config.max_cycles) return stop('limit', [`周が上限 ${L.config.max_cycles} に達した。上限を上げる入力で再開する`])
  const spent = L.agents.length
  if (spent >= L.config.max_agents_total) return stop('limit', [`起動数が上限 ${L.config.max_agents_total} に達した（${spent}）。上限を上げる入力で再開する`])
  if (L.goal.problems.length && !L.goal.checked) return stop('needs_input', ['固定した目標が依頼文と合わない'], { goal_problems: L.goal.problems })
  const stuck = Object.entries(L.attempts).filter(([, n]) => n >= MAX_ATTEMPTS).map(([k]) => k)
  if (stuck.length) return stop('needs_input', ['試行の上限まで欠けた段がある'], { stuck })
  const unrouted = routable(L).filter((i) => !L.routes.some((r) => r.input_id === i.id))
  const planUnits = L.plan ? [...(L.plan.issues || []), ...(L.plan.lenses || [])] : []
  const unverified = planUnits.filter((u) => !L.verified_units.includes(C.unitKey(u, L.routes)))
  const newAnswers = L.answers.filter((a) => !L.answered.includes(a.id) && a.target_kind === 'question')
  if (L.plan_defects.length && L.plan_rounds >= PLAN_ROUNDS && !newAnswers.length) return stop('needs_input', [`計画の欠陥が統合のやり直し ${PLAN_ROUNDS} 回で消えない`], { plan_defects: L.plan_defects })
  if (!L.goal.checked || (needUnits(L) && !L.plan) || L.plan_defects.length || unrouted.length || unverified.length || newAnswers.length) return { step: 'plan' }
  const openQ = ((L.plan && L.plan.questions) || []).filter((q) => !L.answers.some((a) => a.id === q.id))
  if (openQ.length) return stop('needs_input', ['利用者への質問がある'], { questions: openQ })
  if (L.mode === 'create') {
    const pending = (L.plan.issues || []).filter((i) => !L.proposals[i.id] || (L.issue_defects[i.id] || []).length)
    if (pending.length || !L.written || L.writer_defects.length) return { step: 'generate' }
  }
  const cov = coverage(L)
  const todo = Object.entries(L.cells).filter(([, c]) => ['unseen', 'seen'].includes(c.status) && c.attempts < MAX_ATTEMPTS).map(([id]) => id)
  if (todo.length) return { step: 'review', cells: todo }
  if (!L.retro_cycles.includes(L.cycle)) return { step: 'retro' }
  if (!L.group_cycles.includes(L.cycle)) return { step: 'group' }
  // ここまで来たら、この周にやることは無い。
  const cur = currentFindings(L)
  const upper = cur.filter((f) => f.verdict === 'confirmed' && UPPER.includes(f.layer) && !L.answers.some((a) => a.id === f.id))
  const upperGroups = L.groups.filter((g) => g.status !== 'refuted' && UPPER.includes(g.layer) && !L.answers.some((a) => a.id === g.id))
  const unverifiable = cur.filter((f) => f.verdict === 'unverifiable' && !L.answers.some((a) => a.id === f.id))
  const rejected = cur.filter((f) => f.fix === 'rejected' && !L.answers.some((a) => a.id === f.id))
  const live = cov.cells
  if (!live) return stop('blocked', ['枡が 0 件（対象が空か、全て消えた）'], { cause: 'target' })
  if (!cov.settled) return stop('blocked', ['読みを受け付けた枡が 1 つも無い（全ての役が欠けたか、照合に落ち続けた）'], { cause: 'failure', disclosed: cov.disclosed })
  if (upper.length || upperGroups.length || unverifiable.length || rejected.length) {
    return stop('needs_input', [
      ...(upper.length || upperGroups.length ? ['上の層（方針・要求）が原因の欠陥は、自動で直さず利用者に返す'] : []),
      ...(unverifiable.length ? [`検証不能の指摘 ${unverifiable.length} 件`] : []),
      ...(rejected.length ? [`書き手が退けた指摘 ${rejected.length} 件`] : []),
    ], { upper: upper.map((f) => f.id), upper_groups: upperGroups.map((g) => g.id), unverifiable: unverifiable.map((f) => f.id), rejected: rejected.map((f) => f.id) })
  }
  return stop('complete', ['全ての枡が確かめられたか開示され、読み直す枡が 0 件'], { disclosed: cov.disclosed })
}

// 起動の前に最悪の起動数を見積もる（G18）。1 回の呼び出しは LIMITS.maxAgents に収める。
export function estimate(step, args) {
  if (step === 'review') return args.cells.length * C.PER_CELL
  // plan は単位の数が計画役の後で決まるので、単位の検証が残りの枠を全て使う最悪を見積もる。
  if (step === 'plan') return C.LIMITS.maxAgents
  if (step === 'generate') return 2 * args.issues.length + (args.writeAfter ? 2 : 0)
  if (step === 'group') return 2 + 2 * args.items.length
  return 0
}

// 確かめた枡の印は、読みと検証の両方が静的な検査を通ったときだけ付ける。
export function settleCell(L, cellId, row, asset) {
  const c = L.cells[cellId]
  const readP = asset ? C.checkRead(row.read, asset) : ['資産が消えた']
  if (readP.length) {
    c.attempts += 1
    c.problems = readP
    addEvent(L, asset && asset.retro ? 'retro' : 'review', row.read ? 'rejected_read' : 'missing_read', `${cellId}: ${readP.join(' / ')}`, cellId)
    if (c.attempts >= MAX_ATTEMPTS) { c.status = 'disclosed'; addEvent(L, 'control', 'disclosed', `${cellId} を試行 ${c.attempts} 回で開示に倒した`, cellId) }
    return
  }
  const fs = row.read.findings || []
  if (fs.length) {
    const vp = C.checkVerify(row.verify, fs.length)
    if (vp.length) {
      c.status = 'seen'
      c.attempts += 1
      c.problems = vp.map((x) => `検証: ${x}`)
      addEvent(L, 'review', row.verify ? 'rejected_verify' : 'missing_verify', `${cellId}: ${vp.join(' / ')}`, cellId)
      if (c.attempts >= MAX_ATTEMPTS) { c.status = 'disclosed'; addEvent(L, 'control', 'disclosed', `${cellId} の検証が試行 ${c.attempts} 回で揃わず開示に倒した`, cellId) }
      return
    }
  }
  for (const f of Object.values(L.findings)) if (f.cell === cellId && f.status === 'current') f.status = 'superseded'
  fs.forEach((f, i) => {
    const v = (row.verify.verdicts || []).find((x) => x.index === i)
    const verdict = C.settleVerdict(v, asset.text)
    const id = findingId(cellId, f)
    L.findings[id] = { cell: cellId, cycle: L.cycle, claim: f.claim, quote: f.quote, severity: f.severity, layer: f.layer, verdict, verdict_reason: v ? v.reason : '', status: 'current', fix: null }
    if (verdict !== 'confirmed') addEvent(L, 'review', verdict, `${id}: ${f.claim}（${v ? v.reason : '判定なし'}）`, id)
    else if (L.mode === 'create' && !asset.retro) addEvent(L, 'generate', 'defect', `${id}: ${f.claim}`, id)
  })
  Object.assign(c, { status: 'settled', verifier: fs.length > 0, problems: [], outside_notes: row.read.outside_notes || [], none_reason: row.read.none_reason || '' })
}

// 振り返りの資産: この周の悪かった出来事を段ごとに 1 資産にし、出来事ごとに区画を作る（全件を引用させる）。
export function retroAssets(L) {
  // まだ振り返っていない出来事を全て拾う（前の周の振り返りの後に起きた出来事も、次の周で拾う）。
  const ev = L.events.filter((e) => !e.retro)
  for (const e of ev) e.retro = L.cycle
  const stages = [...new Set(ev.map((e) => e.stage))].sort()
  return stages.map((s) => {
    const es = ev.filter((e) => e.stage === s)
    const lines = []
    const blocks = []
    for (const e of es) { const t = `[${e.id}] (${e.kind}) ${e.text}`.split('\n'); blocks.push([lines.length, lines.length + t.length - 1]); lines.push(...t) }
    const text = lines.join('\n')
    return { id: `retro:c${L.cycle}:${s}`, path: `retro:c${L.cycle}:${s}`, heading: s, start: 1, text, hash: sha(text).slice(0, 16), retro: true, blocks, need: blocks.length }
  })
}

// 較正: 利用者が仕込んだ既知の欠陥（seeds）を、観点・読む役ごとに何件拾えたか（再現率）。
export function calibration(L) {
  if (!L.seeds.length) return null
  const rows = {}
  for (const s of L.seeds) {
    for (const [id, f] of Object.entries(L.findings)) {
      if (f.status !== 'current') continue
      const c = L.cells[f.cell]
      const a = L.assets[c.asset]
      if (!a || a.path !== s.path || (s.lens && c.lens !== s.lens)) continue
      const q = C.norm(f.quote), sq = C.norm(s.quote)
      if (!(q.includes(sq) || sq.includes(q))) continue
      const k = `${c.lens}|reader_${c.pass}`
      rows[k] = rows[k] || new Set()
      rows[k].add(s.quote)
    }
  }
  const per = {}
  for (const l of targetLenses(L)) for (let p = 1; p <= L.config.k; p++) {
    const k = `${l.id}|reader_${p}`
    const rel = L.seeds.filter((s) => !s.lens || s.lens === l.id).length
    if (rel) per[k] = { found: rows[k] ? rows[k].size : 0, seeds: rel }
  }
  return per
}

export const resolveAbs = (p) => path.resolve(p)
