// 台帳の決定的な部分: 資産の列挙・ID・枡・持ち越し・受け入れ・止める条件・見積もり。
// 役の出力の静的な照合は Workflow source の <checks> 区間が正本で、ここはそれを読み込んで使う（写しを持たない）。
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

const SRC = readFileSync(new URL('./coverage-audit.js', import.meta.url), 'utf8')
const BLOCK = SRC.slice(SRC.indexOf('// <checks>'), SRC.indexOf('// </checks>'))
export const C = new Function(`${BLOCK}
return { LIMITS, RESERVED_LENSES, norm, argsSum, fenceMask, quoteProblem, checkRead, checkVerify, settleVerdict, unitKey, unitText, checkAppliesTo, checkGoals, checkPlan, checkUnitVerdict, unitDefects, LENS_QUESTIONS, checkLensReview, checkGroups, groupKeys, parseCited, citeSources, checkCited, checkGoalMap, goalGaps, readGoalFiles }`)()

export const MAX_ATTEMPTS = 2 // 同じ枡・段の欠け（読めない・照合に落ちる）の上限。run をまたいで数える
const PLAN_ROUNDS = 2 // 欠陥を直す統合のやり直しの上限
const MAX_FAIL_STREAK = 2 // 全ての役が欠けた呼び出しがこの回数続いたら止める
const CHUNK_LINES = 80 // 宣言・見出しで切らない所を切る行数
export const MAX_ASSET_LINES = 120 // 1 体が読む範囲の行数の上限。超える節は切る
const BLOCK_LINES = 40 // 読んだ証拠の区画のおよその行数
export const MAX_BLOCKS = 4 // 1 つの資産で引用を求める区画の数の上限
const UPPER = ['方針', '要求']
// workers: review の 1 回の呼び出しで、回と待ち行列（読む・検証）ごとに起動する worker の数。行の数は 2 × k × workers。
const DEFAULT_CONFIG = { k: 1, max_cycles: 2, max_agents_total: 600, workers: 4 }

// スキルが持つ観点。目的の観点（固定した目標に照らす）と、層の観点。
const SKILL_LENSES = [
  { id: 'purpose', name: '目的と固定した制約', procedure: 'この部分の主張ごとに、固定した目標と制約のどれに効くかを対応づけてから、効かない主張、制約と食い違う主張、目標に要るのに書かれていないことを探す。' },
  { id: 'layer', name: '層と範囲', procedure: 'この部分の内容ごとに層（方針・要求・方式設計・詳細設計・実装）を判定してから、対象の層より上の決め直し、下の層の細部の書き過ぎ、範囲の外への広がり、上の層へ戻すべき欠陥を探す。' },
]
// 振り返りの観点。悪かった出来事を、網羅・正しさ・費用・層の 4 つの面から見る。
const RETRO_LENSES = [
  { id: 'R1', name: '網羅と測れたか', procedure: 'この段で何を網羅すべきだったか（対象・観点）を先に列挙し、出来事の記録と照らす。次に、効果や欠陥を後から測れる記録（同一性・根拠・件数）が残っているかを確かめる。' },
  { id: 'R2', name: '正しさと一貫性', procedure: 'この段の出力が、誤り・食い違い・確かめていない主張をそのまま次の段へ流していないかを、出来事の具体例で確かめる。読む役と検証役が分かれていたかも見る。' },
  { id: 'R3', name: '費用とモデル・effort', procedure: 'この段の起動数と欠測の内訳から、役の難しさに対してモデルと effort が過大か過小かを判定する。同じ結果をより少ない費用で得られた形があれば挙げる。' },
  { id: 'R4', name: '層と範囲', procedure: 'この段が目標の範囲と対象の層に合っていたか、範囲の外へ広がったか狭めすぎたか、欠陥を原因の層へ戻せたかを、出来事から判定する。' },
]

export const sha = (s) => createHash('sha256').update(String(s)).digest('hex')
// 観点の版: 名前・手続きと、当てる資産（applies_to。計画の観点だけが持つ）。持たない観点の版は名前と手続きだけで決まる。
export const lensVersion = (l) => sha(JSON.stringify(Array.isArray(l.applies_to) ? [l.name, l.procedure, [...new Set(l.applies_to)].sort()] : [l.name, l.procedure])).slice(0, 12)
// 観点がその資産に当たるか。applies_to を持たない観点（スキルの観点・利用者の観点・横展開の観点）は全ての資産に当たる。
export const appliesTo = (l, assetId) => !Array.isArray(l.applies_to) || l.applies_to.includes(assetId)
const slug = (s) => s.toLowerCase().replace(/[`*_~[\]()<>#|:"'!?,.。、（）「」]/g, '').trim().replace(/\s+/g, '-') || 'section'
// 行の範囲（1 始まり・両端を含む）の本文と hash。資産・索引・束ねの全件で同じ式を使い、ingest が写しと照らす。
export const rangeText = (text, start, end) => String(text).split('\n').slice(start - 1, end).join('\n')
export const rangeHash = (text, start, end) => sha(rangeText(text, start, end)).slice(0, 16)

// 読んだ証拠の区画: 本文を need 個の窓に分け、各窓から 1 つは引用させる。
export function withBlocks(a) {
  const n = a.text.split('\n').length
  const need = Math.min(MAX_BLOCKS, Math.max(1, Math.ceil(n / BLOCK_LINES)))
  const size = Math.ceil(n / need)
  const blocks = []
  for (let s = 0; s < n; s += size) blocks.push([s, Math.min(n, s + size) - 1])
  return { ...a, blocks, need: blocks.length }
}

// ファイルを資産に分ける。行がずれても同じ中身は同じ id になるよう、id は中身の位置（見出しの経路・宣言の名前）から決める。
// - Markdown: frontmatter（_frontmatter）と、節の中の段落・箇条書き・表・コードのブロック（<見出しの経路>/<種類><序数>。最初の見出しより前は _top）。
//   目次（リンクだけの箇条書きの節）と本文の無い節は資産にしない。範囲は見出しの行と前後の空行を含まない。
// - JS・MJS: トップレベルの宣言（<名前>。直前のコメント行を含む）と、宣言の無い所の行の塊（c<n>）。
// - それ以外: 行の塊（c<n>）。
// どの形も MAX_ASSET_LINES を超える範囲は /c<n> で切り、同じ id は ~<k> で分ける。
export function splitAssets(rel, text) {
  const lines = text.split('\n')
  const parts = /\.(md|markdown)$/i.test(rel) ? mdParts(lines) : /\.m?js$/i.test(rel) ? jsParts(lines) : chunkParts(lines, 0, lines.length, { n: 1 })
  const out = []
  const used = new Map()
  for (const p of parts) {
    const len = p.end - p.start
    for (let s = p.start, n = 1; s < p.end; s += MAX_ASSET_LINES, n++) {
      let id = `${rel}#${p.key}${len > MAX_ASSET_LINES ? `/c${n}` : ''}`
      const k = (used.get(id) || 0) + 1
      used.set(id, k)
      if (k > 1) id += `~${k}`
      const e = Math.min(p.end, s + MAX_ASSET_LINES)
      const t = lines.slice(s, e).join('\n')
      if (!t.trim()) continue
      out.push(withBlocks({ id, path: rel, heading: p.heading || '', trail: p.trail || [], kind: p.kind, start: s + 1, end: e, text: t, hash: sha(t).slice(0, 16) }))
    }
  }
  return out
}

// 行の塊（start..end は 0 始まり・end を含まない）。c の序数は呼ぶ側が持つ（ファイルの中で通し番号）。
function chunkParts(lines, start, end, seq) {
  const out = []
  for (let s = start; s < end; s += CHUNK_LINES) out.push({ key: `c${seq.n++}`, kind: 'chunk', start: s, end: Math.min(end, s + CHUNK_LINES) })
  return out
}
const blank = (l) => !l.trim()
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+/
const LINK_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+\[[^\]]*\]\([^)]*\)\s*$/

function mdParts(lines) {
  const parts = []
  let i = 0
  // frontmatter は 1 行目が --- で、閉じる --- があるときだけ。
  if (lines[0] === '---') {
    const close = lines.indexOf('---', 1)
    if (close > 0) { parts.push({ key: '_frontmatter', kind: 'frontmatter', start: 0, end: close + 1 }); i = close + 1 }
  }
  const fenced = [...Array(i).fill(false), ...C.fenceMask(lines.slice(i))]
  const isHeading = (j) => !fenced[j] && /^#{1,6}\s/.test(lines[j])
  const stack = []
  let sec = { key: '_top', heading: '', trail: [], blocks: [] }
  const sections = [sec]
  while (i < lines.length) {
    const l = lines[i]
    if (isHeading(i)) {
      const m = /^(#{1,6})\s+(.*)$/.exec(l)
      const h = m ? m[2].trim() : l.replace(/^#+\s*/, '').trim()
      const lv = m ? m[1].length : 1
      while (stack.length && stack[stack.length - 1].lv >= lv) stack.pop()
      stack.push({ lv, s: slug(h), h })
      sec = { key: stack.map((x) => x.s).join('/'), heading: h, trail: stack.map((x) => x.h), blocks: [] }
      sections.push(sec)
      i++
      continue
    }
    if (blank(l)) { i++; continue }
    const start = i
    let kind = 'code'
    if (fenced[start]) {
      // fence は開きと閉じの行を含める。閉じない fence は文書の終わりまで。
      const open = /^ {0,3}(`{3,}|~{3,})/.exec(lines[start])[1]
      i = start + 1
      while (i < lines.length) {
        const c = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(lines[i])
        i++
        if (c && c[1][0] === open[0] && c[1].length >= open.length) break
      }
    } else {
      kind = /^\s*\|/.test(l) ? 'table' : LIST_ITEM.test(l) ? 'list' : 'p'
      i++
      for (;;) {
        while (i < lines.length && !blank(lines[i]) && !isHeading(i) && !fenced[i]) i++
        if (kind !== 'list') break
        // 空行で区切られていても、次の空でない行が箇条書きの項目なら同じ list にする。
        let j = i
        while (j < lines.length && blank(lines[j])) j++
        if (j > i && j < lines.length && !isHeading(j) && !fenced[j] && LIST_ITEM.test(lines[j])) { i = j; continue }
        break
      }
    }
    let end = i
    while (end > start && blank(lines[end - 1])) end--
    sec.blocks.push({ kind, start, end })
  }
  for (const s of sections) {
    if (!s.blocks.length) continue
    // 目次: リンクだけの箇条書きだけの節（入れ子の項目も含め、空でない行が全てリンクだけの項目）。
    const toc = s.blocks.every((b) => b.kind === 'list' && lines.slice(b.start, b.end).every((l) => blank(l) || LINK_ITEM.test(l)))
    if (toc) continue
    const seq = {}
    for (const b of s.blocks) {
      seq[b.kind] = (seq[b.kind] || 0) + 1
      parts.push({ key: `${s.key}/${b.kind}${seq[b.kind]}`, heading: s.heading, trail: s.trail, kind: b.kind, start: b.start, end: b.end })
    }
  }
  return parts.sort((a, b) => a.start - b.start)
}

// JS の行頭の状態を数える: 各行の頭が、トップレベル（括弧・テンプレート文字列・コメント・文字列の外）か。
// 正規表現のリテラルは、直前の記号か語から割り算と見分ける（文字クラスの中の / と ` を読み飛ばす）。
function jsTopLevel(lines) {
  const src = lines.join('\n')
  const top = [true]
  const cmt = [false] // 行の頭がブロックコメントの中か
  const stack = []
  let prev = ''
  let word = ''
  const regexAfter = /^(?:return|typeof|case|in|of|new|delete|void|throw|else|do|yield|await|instanceof)$/
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (ch === '\n') { top.push(!stack.length); cmt.push(false); continue }
    const inTmpl = stack[stack.length - 1] === '`'
    if (inTmpl) {
      if (ch === '\\') { if (src[i + 1] === '\n') { i++; top.push(false); cmt.push(false) } else i++; continue }
      if (ch === '`') { stack.pop(); prev = '`'; word = ''; continue }
      if (ch === '$' && src[i + 1] === '{') { stack.push('${'); i++; prev = '{'; word = '' }
      continue
    }
    if (/\s/.test(ch)) continue
    if (ch === '/' && src[i + 1] === '/') { while (i + 1 < src.length && src[i + 1] !== '\n') i++; continue }
    if (ch === '/' && src[i + 1] === '*') {
      i += 2
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') { top.push(false); cmt.push(true) } i++ }
      i++
      continue
    }
    if (ch === "'" || ch === '"') {
      i++
      while (i < src.length && src[i] !== ch && src[i] !== '\n') { if (src[i] === '\\') i++; i++ }
      prev = ch; word = ''
      continue
    }
    if (ch === '`') { stack.push('`'); continue }
    if (ch === '/' && (!prev || /[(,=:[!&|?{};+\-*%<>~^]/.test(prev) || regexAfter.test(word))) {
      let cls = false
      i++
      while (i < src.length && src[i] !== '\n') {
        if (src[i] === '\\') { i += 2; continue }
        if (src[i] === '[') cls = true
        else if (src[i] === ']') cls = false
        else if (src[i] === '/' && !cls) break
        i++
      }
      while (/[a-z]/i.test(src[i + 1] || '')) i++
      prev = ')'; word = ''
      continue
    }
    if (ch === '{' || ch === '(' || ch === '[') stack.push(ch)
    else if (ch === '}' || ch === ')' || ch === ']') stack.pop()
    if (/[\w$]/.test(ch)) word = prev && /[\w$]/.test(prev) ? word + ch : ch
    else word = ''
    prev = ch
  }
  return { top, cmt }
}
const JS_DECL = /^(export\s+)?(?:(default)\b|(?:async\s+)?(function\b\s*\*?|class\b|const\b|let\b|var\b)\s*([A-Za-z_$][\w$]*)?)/
const jsComment = (l) => /^\s*(\/\/|\/\*|\*)/.test(l)

// トップレベルの宣言の境目で切る。宣言でない文は c<n> の塊にし、続く宣言の無い文は同じ塊にまとめる。
function jsParts(lines) {
  const { top, cmt } = jsTopLevel(lines)
  const isComment = (j) => cmt[j] || (top[j] && jsComment(lines[j]))
  const heads = []
  let last = -1 // 直前の境目の行（宣言の行そのもの）
  lines.forEach((l, i) => {
    if (!top[i] || blank(l) || /^\s/.test(l) || jsComment(l) || /^[)\]}.,;:?+\-*/%&|=<>]/.test(l)) return
    const m = JS_DECL.exec(l)
    const name = m && m[2] ? 'default' : m && m[4] ? m[4] : null
    if (!name && heads.length && !heads[heads.length - 1].name) { last = i; return }
    // 宣言の直前のコメント行（空行を挟まない）は、その宣言の資産に含める。
    let s = i
    while (s - 1 > last && isComment(s - 1)) s--
    heads.push({ name, kind: name ? (m[2] ? 'export' : m[3].replace(/[\s*]/g, '')) : 'chunk', start: s })
    last = i
  })
  if (!heads.length) heads.push({ name: null, kind: 'chunk', start: 0 })
  else if (heads[0].start > 0) { if (heads[0].name) heads.unshift({ name: null, kind: 'chunk', start: 0 }); else heads[0].start = 0 }
  const parts = []
  const seq = { n: 1 }
  heads.forEach((h, k) => {
    let end = k + 1 < heads.length ? heads[k + 1].start : lines.length
    while (end > h.start && blank(lines[end - 1])) end--
    if (end <= h.start) return
    if (h.name) parts.push({ key: h.name, kind: h.kind, start: h.start, end })
    else parts.push(...chunkParts(lines, h.start, end, seq))
  })
  return parts
}

export const readGoalFiles = C.readGoalFiles
export const goalIds = (L) => [...L.goal.items, ...L.criteria, ...L.constraints].map((c) => c.id)
export const goalSources = (L) => C.citeSources({ request: L.request, ...(L.decisions != null ? { decisions: L.decisions } : {}) })

export function newLedger({ goal, goalItems, checkedBy = null, phase = null, request, decisions = null, criteria = [], constraints, targets, lenses, config, roles, seeds }) {
  const L = {
    // phase: 呼ぶ側の段（coverage-build の design・impl など）。phase_start: 今の段の始まりの周・起動数・出来事の数（上限と status の今の段はここから数える）。
    // phase_records: reframe で出ていった段の status の節（findings・groups・events）。
    version: 1, rev: 0, cycle: 1, phase, phase_start: { cycle: 1, agents: 0, events: 0 }, phase_records: {}, goal: { text: goal, items: goalItems, checked: !!checkedBy, checked_by: checkedBy, problems: [] }, request, decisions, criteria, constraints,
    config: { ...DEFAULT_CONFIG, ...config }, roles, targets, seeds: seeds || [],
    call_seq: 0, plan: null, plan_rounds: 0, plan_defects: [], plan_seq: 0, plan_problems: [], verified_units: [], lens_reviewed: [], dropped_lenses: [], answers: [], answered: [],
    lenses: [...SKILL_LENSES.map((l) => ({ ...l, origin: 'skill' })), ...(lenses || []).map((l) => ({ id: l.id, name: l.name, procedure: l.procedure, origin: 'user' })), ...RETRO_LENSES.map((l) => ({ ...l, origin: 'skill', retro: true }))],
    attempts: {}, env_attempts: {}, fail_streak: 0,
    assets: {}, cells: {}, findings: {}, events: [], groups: [], retro_cycles: [], group_cycles: [], saturation: [],
    calls: [], agents: [], hints_read: [], pending: null,
  }
  for (const l of L.lenses) l.version = lensVersion(l)
  return L
}

// 段を差し替える（reframe）。今の段の節を呼ぶ側が phase_records に写した後に呼ぶ。
// 計画・回答・横展開の観点・束ね・試行を捨て、全ての枡を読み直しにし、今の指摘を退かせる（中身が同じでも読み直す）。
// 周を 1 つ進めて段の始まりにする（前の段の周・起動数・出来事を、今の段の上限と status に数えない）。
export function startPhase(L, phase) {
  Object.assign(L, {
    phase, plan: null, plan_rounds: 0, plan_defects: [], plan_problems: [], verified_units: [], lens_reviewed: [], dropped_lenses: [], answers: [], answered: [],
    groups: [], attempts: {}, env_attempts: {}, fail_streak: 0, pending: null, stopped: null,
  })
  L.lenses = L.lenses.filter((l) => l.origin === 'skill' || l.origin === 'user')
  for (const [id, a] of Object.entries(L.assets)) if (a.retro) delete L.assets[id]
  for (const c of Object.values(L.cells)) {
    for (const k of ['read', 'claim', 'verifier', 'none_reason']) delete c[k]
    Object.assign(c, { status: c.status === 'gone' || !L.assets[c.asset] ? 'gone' : 'unseen', attempts: 0, env_attempts: 0, problems: [], outside_notes: [] })
  }
  for (const f of Object.values(L.findings)) if (f.status === 'current') f.status = 'superseded'
  L.cycle += 1
  L.phase_start = { cycle: L.cycle, agents: L.agents.length, events: L.events.length }
}
// 今の段の出来事（段の始まりより後）。
export const phaseEvents = (L) => L.events.slice(L.phase_start.events)

const targetLenses = (L) => L.lenses.filter((l) => !l.retro)
// 今のファイルの内容に台帳を合わせる。変わった資産・観点の枡は古い印を付けて読み直す（持ち越し）。
// 計画が除いた資産（excluded）は applies_to より優先し、purpose・layer・横展開を含めどの観点の枡も作らない（既にある枡は gone にする）。
export function refresh(L, assets, { partial = false } = {}) {
  const now = new Map(assets.map((a) => [a.id, a]))
  const ex = excludedIds(L)
  const want = (l, assetId) => !ex.has(assetId) && appliesTo(l, assetId)
  const changes = { added: [], stale: [], gone: [] }
  for (const a of assets) {
    if (!L.assets[a.id]) changes.added.push(a.id)
    L.assets[a.id] = { path: a.path, heading: a.heading, trail: a.trail || [], kind: a.kind, start: a.start, end: a.end, hash: a.hash, snap: a.snap, blocks: a.blocks, need: a.need, ...(a.retro ? { retro: true } : {}) }
  }
  if (!partial) for (const id of Object.keys(L.assets)) if (!now.has(id) && !L.assets[id].retro) { changes.gone.push(id); delete L.assets[id] }
  const wantLens = new Map(L.lenses.map((l) => [l.id, l]))
  for (const a of assets) {
    for (const l of a.retro ? L.lenses.filter((x) => x.retro) : targetLenses(L).filter((x) => want(x, a.id))) {
      for (let p = 1; p <= L.config.k; p++) {
        const id = `${a.id}|${l.id}|p${p}`
        const c = L.cells[id]
        if (!c) { L.cells[id] = { asset: a.id, lens: l.id, pass: p, status: 'unseen', asset_hash: a.hash, lens_version: l.version, attempts: 0, problems: [], outside_notes: [] }; continue }
        if (c.status === 'gone' || c.asset_hash !== a.hash || c.lens_version !== l.version) {
          if (c.status !== 'unseen') changes.stale.push(id)
          Object.assign(c, { status: 'unseen', asset_hash: a.hash, lens_version: l.version, attempts: 0, problems: [] })
          delete c.read
          delete c.claim
          for (const f of Object.values(L.findings)) if (f.cell === id && f.status === 'current') f.status = 'superseded'
        }
      }
    }
  }
  for (const [id, c] of Object.entries(L.cells)) {
    const a = L.assets[c.asset]
    const l = wantLens.get(c.lens)
    if ((!a || !l || (!a.retro && !want(l, c.asset))) && c.status !== 'gone') {
      c.status = 'gone'
      delete c.read
      delete c.claim
      for (const f of Object.values(L.findings)) if (f.cell === id && f.status === 'current') f.status = 'gone'
    }
  }
  return changes
}

const eventId = (L) => `E${L.cycle}-${L.events.filter((e) => e.cycle === L.cycle).length + 1}`
export function addEvent(L, stage, kind, text, ref = null) { L.events.push({ id: eventId(L), cycle: L.cycle, stage, kind, text, ref }) }
// 同じ枡の別々の指摘を 1 件に潰さない: 枡・引用・主張から決める。
export const findingId = (cell, f) => `${cell}#${sha(`${C.norm(f.quote)}|${C.norm(f.claim)}`).slice(0, 10)}`

export function coverage(L) {
  const live = Object.entries(L.cells).filter(([, c]) => c.status !== 'gone')
  const by = (s) => live.filter(([, c]) => c.status === s).map(([id]) => id)
  // settled は「読みを受け付け、指摘があれば全て検証役が判定した」。指摘の無い枡は検証役を通っていない（見ただけ）ので別に数える。
  const settled = live.filter(([, c]) => c.status === 'settled')
  return { cells: live.length, settled: settled.length, settled_with_verifier: settled.filter(([, c]) => c.verifier).length, settled_no_findings: settled.filter(([, c]) => !c.verifier).length, disclosed: by('disclosed'), pending: [...by('unseen'), ...by('seen')] }
}
export const currentFindings = (L) => Object.entries(L.findings).filter(([, f]) => f.status === 'current').map(([id, f]) => ({ id, ...f }))
export const needPlan = (L) => !L.lenses.some((l) => l.origin === 'user')
// 計画が除いた資産の id（利用者の観点を渡した台帳は計画を作らないので空）。
export const excludedIds = (L) => new Set(needPlan(L) && L.plan && Array.isArray(L.plan.excluded) ? L.plan.excluded.map((x) => x && x.asset) : [])
// 計画の段で取り込む回答: 計画の質問への回答と、計画の欠陥（P<n>）への回答。
export const planAnswerKinds = ['question', 'plan_defect']
const todoCells = (L) => Object.entries(L.cells).filter(([, c]) => ['unseen', 'seen'].includes(c.status) && c.attempts < MAX_ATTEMPTS).map(([id]) => id)

// この周の振り返りと束ねが済んだ後に読む枡が出た（持ち越しで対象が変わった）ら、次の周を開く。
// 開かなければ、新しい指摘が振り返り・束ね・横展開を通らずに complete になる。
export function openCycle(L) {
  if (L.retro_cycles.includes(L.cycle) && L.group_cycles.includes(L.cycle) && todoCells(L).length) { L.cycle += 1; return true }
  return false
}

// 横展開の収束。束ねが新しい型を返したときだけ観点を作り、次の周に進む（新しい型が 0 件なら周を進めず complete に向かう）。
// 今の周が上限の周（段の始まりから max_cycles 周目）なら、新しい型を展開せずに群だけを残し、needs_input で利用者に返す。
export const atCycleCap = (L) => L.cycle - L.phase_start.cycle + 1 >= L.config.max_cycles
export const lateralLensIds = (L) => L.lenses.filter((l) => String(l.origin || '').startsWith('lateral:')).map((l) => l.id)
// 展開していない新しい型の群: 型があり、既存の型に結ばず、反証されず、横展開の観点が無く、回答の無い群（台帳の欄から導く）。
export function lateralGroups(L) {
  const live = new Set(L.lenses.map((l) => l.id))
  return L.groups.filter((g) => g.pattern && g.pattern.trim() && !g.extends && g.status !== 'refuted' && !live.has(`lat-${g.id}`) && !L.answers.some((a) => a.id === g.id))
}
// 上限を下げた台帳（config --max-cycles）: 上限の周より後の周に当てる横展開の観点（上限の周以降の束ねが作った観点）を外し、
// 周を上限の周に戻す。外した観点の枡と指摘は、続く refresh が gone にする。作った元の群は lateralGroups が返す。
export function capCycles(L) {
  const cap = L.phase_start.cycle + L.config.max_cycles - 1
  if (L.cycle <= cap) return false
  const over = new Set(L.groups.filter((g) => g.cycle >= cap).map((g) => `lateral:${g.id}`))
  const drop = L.lenses.filter((l) => over.has(l.origin)).map((l) => l.id)
  if (!drop.length) return false
  // 外す観点の当たる資産は元の群に残し、上限を上げた後の next が展開し直せるようにする。
  for (const l of L.lenses) if (over.has(l.origin)) { const g = L.groups.find((x) => `lateral:${x.id}` === l.origin); if (g) g.applies_to = l.applies_to }
  L.lenses = L.lenses.filter((l) => !over.has(l.origin))
  const from = L.cycle
  L.cycle = cap
  L.retro_cycles = L.retro_cycles.filter((c) => c <= cap)
  L.group_cycles = L.group_cycles.filter((c) => c <= cap)
  addEvent(L, 'control', 'cycle_cap', `周の上限 ${L.config.max_cycles} を超えた周（${from}）の横展開の観点を外し、周 ${cap} に戻した: ${drop.join(', ')}`)
  return true
}

// 次の 1 手か停止を、台帳だけから決める。
export function decide(L, { missingTargets = [] } = {}) {
  const stop = (kind, reasons, extra = {}) => ({ stop: kind, reasons, ...extra })
  if (missingTargets.length) return stop('blocked', [`対象が読めない: ${missingTargets.join(', ')}`], { cause: 'input' })
  if (L.fail_streak >= MAX_FAIL_STREAK) return stop('blocked', [`全ての役が欠けた呼び出しが ${L.fail_streak} 回続いた`], { cause: 'failure' })
  // 周と起動数は、今の段の始まり（init か reframe）から数える。
  if (L.cycle - L.phase_start.cycle + 1 > L.config.max_cycles) return stop('limit', [`周が上限 ${L.config.max_cycles} を超えた。上限を上げる入力で再開する`])
  const spent = L.agents.length - L.phase_start.agents
  if (spent >= L.config.max_agents_total) return stop('limit', [`起動数が上限 ${L.config.max_agents_total} に達した（${spent}）。上限を上げる入力で再開する`])
  if (L.goal.problems.length && !L.goal.checked) return stop('needs_input', ['依頼文・決定の記録が求める成果のうち、目標・基準・制約のどの項目も受け止めていないものがある'], { goal_gaps: L.goal.problems })
  const stuck = Object.entries(L.attempts).filter(([, n]) => n >= MAX_ATTEMPTS).map(([k]) => k)
  if (stuck.length) return stop('needs_input', ['試行の上限まで欠けた段がある'], { stuck })
  const unverified = ((L.plan && L.plan.lenses) || []).filter((u) => !L.verified_units.includes(C.unitKey(u)))
  // 精査（N1・N2）を終えていない計画の観点（統合のたびに全て精査し直す）。残る間は枡を読む段に進まない。
  const unreviewed = needPlan(L) ? ((L.plan && L.plan.lenses) || []).filter((u) => !L.lens_reviewed.includes(u.id)) : []
  const newAnswers = L.answers.filter((a) => !L.answered.includes(a.id) && planAnswerKinds.includes(a.target_kind))
  if (L.plan_defects.length && L.plan_rounds >= PLAN_ROUNDS && !newAnswers.length) return stop('needs_input', [`計画の欠陥が統合のやり直し ${PLAN_ROUNDS} 回で消えない`], { plan_defects: L.plan_defects })
  if (!L.goal.checked || (needPlan(L) && !L.plan) || L.plan_defects.length || unverified.length || unreviewed.length || newAnswers.length) return { step: 'plan' }
  const openQ = ((L.plan && L.plan.questions) || []).filter((q) => !L.answers.some((a) => a.id === q.id))
  if (openQ.length) return stop('needs_input', ['利用者への質問がある'], { questions: openQ })
  const cov = coverage(L)
  const todo = todoCells(L)
  if (todo.length) return { step: 'review', cells: todo }
  if (!L.retro_cycles.includes(L.cycle)) return { step: 'retro' }
  if (!L.group_cycles.includes(L.cycle)) return { step: 'group' }
  // ここまで来たら、この周にやることは無い。
  const answered = (id) => L.answers.some((a) => a.id === id)
  const cur = currentFindings(L)
  const upper = cur.filter((f) => f.verdict === 'confirmed' && UPPER.includes(f.layer) && !answered(f.id))
  const upperGroups = L.groups.filter((g) => g.status !== 'refuted' && UPPER.includes(g.layer) && !answered(g.id))
  const unverifiable = cur.filter((f) => f.verdict === 'unverifiable' && !answered(f.id))
  const lateral = lateralGroups(L)
  if (!cov.cells) return stop('blocked', ['枡が 0 件（対象が空か、全て消えた）'], { cause: 'target' })
  if (!cov.settled) return stop('blocked', ['読みを受け付けた枡が 1 つも無い（全ての役が欠けたか、照合に落ち続けた）'], { cause: 'failure', disclosed: cov.disclosed })
  if (upper.length || upperGroups.length || unverifiable.length || lateral.length) {
    return stop('needs_input', [
      ...(upper.length || upperGroups.length ? ['上の層（方針・要求）が原因の欠陥・束は、呼ぶ側が直す前に利用者が判断する'] : []),
      ...(unverifiable.length ? [`検証不能の指摘 ${unverifiable.length} 件`] : []),
      ...(lateral.length ? [`横展開が周の上限 ${L.config.max_cycles} で収束しない（展開していない新しい型の群 ${lateral.length} 件）。群ごとに、展開せずに記録するかを利用者が判断する`] : []),
    ], { upper: upper.map((f) => f.id), upper_groups: upperGroups.map((g) => g.id), unverifiable: unverifiable.map((f) => f.id), lateral_groups: lateral.map((g) => g.id) })
  }
  return stop('complete', ['全ての枡が確かめられたか開示され、読み直す枡が 0 件'], { disclosed: cov.disclosed })
}

// 起動の前に最悪の起動数を見積もる。1 回の呼び出しは LIMITS.maxAgents に収める。
export function estimate(step, args) {
  // review は workers の行ごとに 1 体（行の数は config --workers が maxAgents に収める）。
  if (step === 'review') return args.workers.length
  // plan は観点の数が計画役の後で決まるので、観点の検証が残りの枠を全て使う最悪を見積もる。
  if (step === 'plan') return C.LIMITS.maxAgents
  if (step === 'group') return 2 + 2 * args.count
  return 0
}

// 枡の提出の受け入れ（submit）。asset は写しから作った本文と区画を持つ。読みと検証は別の提出で、どちらも静的な検査を通ったときだけ進める。
// 落ちた提出は試行に数え、上限に達したら開示に倒す（dropped）。返り値は { problems, dropped }（problems が空なら受理）。
function rejectCell(L, cellId, stage, kind, problems, text) {
  const c = L.cells[cellId]
  c.attempts += 1
  c.problems = problems
  addEvent(L, stage, kind, `${cellId}: ${problems.join(' / ')}`, cellId)
  if (c.attempts < MAX_ATTEMPTS) return { problems, dropped: false }
  c.status = 'disclosed'
  delete c.claim
  addEvent(L, 'control', 'disclosed', `${cellId} ${text}${c.attempts} 回で開示に倒した`, cellId)
  return { problems, dropped: true }
}
// 枡の読みと、指摘への判定を確かめた結果として残す（指摘の無い読みは verdicts を持たない）。
function settle(L, cellId, read, verdicts, stage, text) {
  const c = L.cells[cellId]
  const fs = read.findings || []
  for (const f of Object.values(L.findings)) if (f.cell === cellId && f.status === 'current') f.status = 'superseded'
  fs.forEach((f, i) => {
    const v = (verdicts || []).find((x) => x.index === i)
    const verdict = C.settleVerdict(v, text)
    const id = findingId(cellId, f)
    L.findings[id] = { cell: cellId, cycle: L.cycle, claim: f.claim, quote: f.quote, severity: f.severity, layer: f.layer, verdict, verdict_reason: v ? v.reason : '', status: 'current' }
    if (verdict !== 'confirmed') addEvent(L, stage, verdict, `${id}: ${f.claim}（${v ? v.reason : '判定なし'}）`, id)
  })
  Object.assign(c, { status: 'settled', verifier: fs.length > 0, problems: [], outside_notes: read.outside_notes || [], none_reason: read.none_reason || '' })
  delete c.read
  delete c.claim
}
// 読みの提出: 指摘が無ければ確かめた枡にし、指摘があれば読みを保って検証の待ち行列（status seen）へ回す。
export function submitRead(L, cellId, rep, asset) {
  const stage = asset.retro ? 'retro' : 'review'
  const p = C.checkRead(rep, asset)
  if (p.length) return rejectCell(L, cellId, stage, 'rejected_read', p, 'を試行 ')
  const read = { evidence: rep.evidence || [], findings: rep.findings || [], outside_notes: rep.outside_notes || [], none_reason: rep.none_reason || '' }
  if (!read.findings.length) { settle(L, cellId, read, [], stage, asset.text); return { problems: [], dropped: false } }
  const c = L.cells[cellId]
  Object.assign(c, { status: 'seen', read, problems: [] })
  delete c.claim
  return { problems: [], dropped: false }
}
// 検証の提出: 保った読みの指摘ごとの判定を照らし、揃えば指摘を確かめた枡にする。
export function submitVerify(L, cellId, rep, asset) {
  const stage = asset.retro ? 'retro' : 'review'
  const c = L.cells[cellId]
  const p = C.checkVerify(rep, c.read.findings.length)
  if (p.length) return rejectCell(L, cellId, stage, 'rejected_verify', p.map((x) => `検証: ${x}`), 'の検証が揃わず試行 ')
  settle(L, cellId, c.read, rep.verdicts, stage, asset.text)
  return { problems: [], dropped: false }
}
// 取られたまま提出されなかった枡を戻す（ingest と、ingest を経ない next が使う）。読む役の枡は unseen のまま、検証の枡は読みを保ったまま claim を外し、
// どちらも試行に数える（env なら環境の失敗にも数える）。上限に達したら開示に倒す。戻した枡の数を返す。
export function releaseClaims(L, { env = false } = {}) {
  let n = 0
  for (const [id, c] of Object.entries(L.cells)) {
    if (!c.claim) continue
    delete c.claim
    n++
    if (!['unseen', 'seen'].includes(c.status)) continue
    const verify = c.status === 'seen'
    const stage = L.assets[c.asset] && L.assets[c.asset].retro ? 'retro' : 'review'
    c.attempts += 1
    if (env) c.env_attempts = (c.env_attempts || 0) + 1
    addEvent(L, stage, verify ? 'missing_verify' : 'missing_read', `${id}: ${verify ? '検証役' : '読む役'}が取ったまま提出しなかった`, id)
    if (c.attempts >= MAX_ATTEMPTS) { c.status = 'disclosed'; addEvent(L, 'control', 'disclosed', `${id} を試行 ${c.attempts} 回で開示に倒した`, id) }
  }
  return n
}

// 振り返りの資産: まだ振り返っていない出来事を、段ごとに 1 行 1 件で並べ、MAX_ASSET_LINES 行ごとの資産に分ける。
// 区画は通常の資産と同じ式（withBlocks）で、1 体に全ての出来事の引用を求めない。本文は呼び出し側が写しに書く。
export function retroAssets(L) {
  const ev = L.events.filter((e) => !e.retro)
  for (const e of ev) e.retro = L.cycle
  const out = []
  for (const s of [...new Set(ev.map((e) => e.stage))].sort()) {
    const lines = ev.filter((e) => e.stage === s).map((e) => `[${e.id}] (${e.kind}) ${String(e.text).replace(/\s*\n\s*/g, ' / ')}`)
    const chunks = Math.ceil(lines.length / MAX_ASSET_LINES)
    for (let n = 0; n < chunks; n++) {
      const text = lines.slice(n * MAX_ASSET_LINES, (n + 1) * MAX_ASSET_LINES).join('\n')
      const id = `retro:c${L.cycle}:${s}${chunks > 1 ? `/c${n + 1}` : ''}`
      out.push(withBlocks({ id, path: id, heading: s, start: 1, end: text.split('\n').length, text, hash: sha(text).slice(0, 16), retro: true }))
    }
  }
  return out
}

// 較正: 利用者が仕込んだ既知の欠陥（seeds）を、観点・読む役ごとに何件拾えたか（再現率）。
export function calibration(L) {
  if (!L.seeds.length) return null
  const rows = {}
  for (const s of L.seeds) {
    for (const f of Object.values(L.findings)) {
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
