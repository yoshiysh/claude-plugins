export const meta = {
  name: 'coverage-audit-step',
  description: '台帳の 1 段を 1 回だけ流す。args の workers の行ごとに役を 1 体起動し、役は claim・query・submit で台帳と直接読み書きする。返すのは起動の記録と tokens だけ',
  requirements: ['fresh-thread', 'workspace-write'],
  phases: [
    { title: 'plan', detail: '計画役 1 体が、目標の照合（照合済みでないとき）と観点の計画をする。観点の検証の欠陥があれば計画を直す' },
    { title: 'unit_verify', detail: '観点の検証役 1 体が、計画の版の確かめていない観点の全てに、閉じた問い（Q1〜Q3）で答える' },
    { title: 'full_review', detail: '全文レビューの役 1 体が、読む範囲の全ての単位を観点に縛られずに目標だけを手に読み、指摘と参考を書く（網羅に数えない）' },
    { title: 'file', detail: '読む役が文脈に収まる分の単位の詰め合わせを取り、単位ごとに全文を全ての観点で読み、指摘・保証と前提・観点ごとの見たを書く' },
    { title: 'global', detail: '判定役と確認役が意図を取り、根拠と関係する事実だけを引いて判定する（名寄せ・主語の照合・指摘の判定・前提・目標・確認・束ね）' },
    { title: 'retro', detail: '単独で呼ばれたときだけ、振り返りの役 1 体が全ての出来事を読み、対象の指摘と分けて振り返りを書く' },
  ],
  limits: { maxAgents: 60, concurrency: 3, timeoutMs: 12000000, agentTimeoutMs: 600000, maxOutputBytes: 4000000 },
}

// <checks> ここから </checks> までは CLI（ledger-core.mjs）が同じ文を読み込んで使う。静的な照合の正本はここだけ。
// native Workflow は本体に meta を渡さないので写しを置く（一致は tests/coverage-audit-workflow.test.mjs が照らす）。
const LIMITS = { maxAgents: 60, concurrency: 3, timeoutMs: 12000000, agentTimeoutMs: 600000, maxOutputBytes: 4000000 }
const QUOTE_MIN = 12
const LAYERS = ['方針', '要求', '方式設計', '詳細設計', '実装']
const UPPER = ['方針', '要求'] // 上の層。ここに原因がある確定指摘・群は呼び手の判断を待つ（needs_input）
const SEVERITIES = ['HIGH', 'MEDIUM', 'LOW']
const DEFECT_ACTIONS = ['fixed', 'rejected']
const isStr = (s) => typeof s === 'string' && s.trim().length > 0
const arr = (a) => (Array.isArray(a) ? a : [])
// 値を key の順に並べた JSON にして FNV-1a を取る。観点の同一性に使う。
const canon = (v) => (Array.isArray(v) ? `[${v.map(canon).join(',')}]` : v && typeof v === 'object' ? `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}` : JSON.stringify(v))
function fnv(s) {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
  return h.toString(16).padStart(8, '0')
}
// 行番号は外して照らす（「N| 」の形と、Read の「   N\t」の形）。
const stripNums = (s) => String(s ?? '').replace(/(^|\n)[ \t]*\d+(\| ?|\t)/g, '$1')
const norm = (s) => stripNums(s).replace(/\s+/g, ' ').trim()
// 短い引用は、本文の全体か、本文の空でない 1 行の全体を引くときだけ受け付ける。
const wholeLine = (n, text) => String(text).split('\n').some((l) => l.trim() && norm(l) === n)
// 行ごとに code fence の中か（開きと閉じの行を含む）。閉じは開きと同じ文字で開き以上の長さの行だけ。閉じない fence は終わりまで。
// 資産の切り方（ledger-core の splitAssets）と見出しだけの引用の判定が同じ式を使う。
function fenceMask(lines) {
  const out = []
  let open = null
  for (const l of lines) {
    if (open) {
      out.push(true)
      const c = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(l)
      if (c && c[1][0] === open[0] && c[1].length >= open.length) open = null
      continue
    }
    const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(l)
    const opens = !!m && !(m[1][0] === '`' && m[2].includes('`'))
    if (opens) open = m[1]
    out.push(opens)
  }
  return out
}
// 本文を引く役に渡す引用の規則の文（quoteProblem が受け付ける引用を述べる。字数は QUOTE_MIN から作る）。quoteProblem で照らす引用を返す役の prompt だけが埋め込む。
const QUOTE_RULE = `引用は ${QUOTE_MIN} 字以上にする。${QUOTE_MIN} 字未満の短い引用は、本文の全体か、本文の空でない 1 行の全体を引くときだけ受け付ける。見出しの行だけの引用は証拠にならない。結果の中の引用の 1 つでも合わなければ、その提出ごと拒まれる。`
function quoteProblem(q, text) {
  const n = norm(q)
  const body = norm(text)
  if (!n) return '引用が空'
  if (n.length < QUOTE_MIN && n !== body && !wholeLine(n, text)) return `引用が ${QUOTE_MIN} 字未満`
  if (!body.includes(n)) return '引用が本文に逐語で無い'
  const ls = String(text).split('\n')
  const fenced = fenceMask(ls)
  const headings = ls.filter((l, i) => !fenced[i] && /^#{1,6}\s/.test(l)).map((l) => norm(l.replace(/^#{1,6}\s*/, '')))
  if (headings.includes(n.replace(/^#{1,6}\s*/, '')) && n !== body) return '見出しだけの引用は読んだ証拠にならない'
  return null
}
// 観点の同一性: 中身が変われば検証し直す。
const unitKey = (u) => fnv(canon(u))
const unitText = (u) => JSON.stringify(u)
// 計画の観点が受け持つ目標の部分（goals: [{id, part}]）の照合。id の実在、part が空でないこと、どの観点の goals も空でないこと、
// 全ての目標・受け入れ基準がどれかの計画の観点の goals に入ること。goalTexts（id → 本文）を渡すと part が本文に逐語であるかも照らす。
// 被覆は計画の観点だけで数える。goalItemIds を渡さないと形だけを照らす（Workflow は本文を持たないので逐語かは CLI の ingest が照らす）。
// cover が false なら、全ての目標・基準がどれかの観点に入るかは照らさない（観点が渡されて計画役が足す観点だけを出すとき。既にある観点が全てを受け持つ）。
function checkGoals(lenses, goalItemIds, goalTexts, { cover = true } = {}) {
  const p = []
  const known = Array.isArray(goalItemIds) ? new Set(goalItemIds) : null
  const hit = new Set()
  for (const l of arr(lenses)) {
    const gs = l && l.goals
    if (!Array.isArray(gs) || !gs.every((g) => g && typeof g === 'object' && isStr(g.id))) { p.push(`観点 ${l && l.id} の goals が {id, part} の配列でない`); continue }
    if (!gs.length) p.push(`観点 ${l.id} の goals が空`)
    gs.forEach((g, i) => {
      if (known && !known.has(g.id)) p.push(`観点 ${l.id} の goals[${i}] に実在しない目標・受け入れ基準: ${g.id}`)
      if (!isStr(g.part)) p.push(`観点 ${l.id} の goals[${i}]（${g.id}）の part が空`)
      else if (goalTexts && isStr(goalTexts[g.id]) && !norm(goalTexts[g.id]).includes(norm(g.part))) p.push(`観点 ${l.id} の goals[${i}]（${g.id}）の part が本文に逐語で無い: ${norm(g.part).slice(0, 40)}`)
      hit.add(g.id)
    })
  }
  if (known && cover) for (const id of known) if (!hit.has(id)) p.push(`どの観点の goals にも無い目標・受け入れ基準: ${id}`)
  return p
}
function checkPlan(L, ctx) {
  if (!L || typeof L !== 'object') return ['返り値が無い']
  const p = []
  const ids = new Set()
  const add = (id, what) => { if (!isStr(id)) p.push(`${what} の id が空`); else if (ids.has(id)) p.push(`id の重複: ${id}`); ids.add(id) }
  for (const l of arr(L.lenses)) {
    add(l.id, '観点')
    if (arr(ctx.givenLensIds).includes(l.id)) p.push(`観点 ${l.id} は既にある観点で、計画役は定義し直せない`)
    if (!isStr(l.procedure)) p.push(`観点 ${l.id} の procedure が空`)
  }
  for (const q of arr(L.questions)) { add(q.id, '質問'); if (!isStr(q.why_value_judgment)) p.push(`質問 ${q.id} に価値判断の理由が無い`) }
  if (!ctx.lensesGiven && !arr(L.lenses).length) p.push('観点が 0 件')
  if (!ctx.lensesGiven || arr(L.lenses).length) p.push(...checkGoals(L.lenses, ctx.goalItemIds, ctx.goalTexts, { cover: !ctx.lensesGiven }))
  const units = new Set([...arr(L.lenses).map((l) => l.id), ...arr(ctx.givenLensIds)])
  const mapped = new Set()
  for (const m of arr(L.constraint_map)) {
    if (!arr(ctx.constraintIds).includes(m.constraint_id)) { p.push(`実在しない制約: ${m.constraint_id}`); continue }
    mapped.add(m.constraint_id)
    const hs = arr(m.handled_by)
    if (!hs.length) p.push(`制約 ${m.constraint_id} の受け皿が空`)
    for (const h of hs) if (!units.has(h)) p.push(`制約 ${m.constraint_id} の受け皿が実在しない: ${h}`)
  }
  for (const c of arr(ctx.constraintIds)) if (!mapped.has(c)) p.push(`制約 ${c} の受け皿が無い`)
  // 閉じた問いの no から作った欠陥（ctx.defectKinds が Q1〜Q3）への rejected も、fixed と同じく受け付ける。
  // rejected は欠陥を退けたことにならない: その観点は検証済みにならないので、次の検証で同じ問いに答え直し、no ならまた欠陥になる。
  if (ctx.defectCount) {
    const got = new Set()
    for (const d of arr(L.defect_responses)) {
      if (got.has(d.defect_index)) p.push(`欠陥 ${d.defect_index} への応答の重複`)
      got.add(d.defect_index)
      if (!DEFECT_ACTIONS.includes(d.action) || !isStr(d.reason)) p.push(`欠陥 ${d.defect_index} への応答が不正`)
    }
    for (let i = 0; i < ctx.defectCount; i++) if (!got.has(i)) p.push(`欠陥 ${i} への応答が無い`)
  }
  return p
}
// 観点の検証役に聞く閉じた問い。Q3 は観点の goals の要素（goal_index）ごとに聞く。答えの no だけが計画の欠陥になる。
const UNIT_QUESTIONS = {
  Q1: '手続きが「何を列挙するか」を書いているか',
  Q2: '手続きが「列挙したものを何と照らすか」を書いているか',
  Q3: 'この手続きで、この部分が果たされたかを確かめられるか',
}
const ANSWERS = ['yes', 'no']
// goals は {id, part} の配列か、id の配列（Workflow が CLI の束で観点を受けるとき。part の本文は束にある）。
const goalIdOf = (g) => (typeof g === 'string' ? g : g && g.id)
// 期待する答えの組: Q1・Q2 を 1 つずつ、Q3 を goals の要素ごとに 1 つずつ（goal_index は要素の位置、goal_id はその要素の id）。
// 過不足と自由な欠陥（defects）は受け付けない。text を渡さないと引用の形だけを照らす（逐語かは CLI の ingest が照らす）。
function checkUnitVerdict(rep, unitId, goals, text) {
  if (!rep || typeof rep !== 'object') return ['返り値が無い']
  const p = []
  if (rep.unit_id !== unitId) p.push(`unit_id が違う: ${rep.unit_id}`)
  if ('defects' in rep) p.push('自由な欠陥（defects）は受け付けない。閉じた問いの答え（answers）だけを返す')
  if (!Array.isArray(rep.answers)) p.push('answers が配列でない')
  const gs = arr(goals)
  const want = new Set(['Q1', 'Q2', ...gs.map((_, i) => `Q3:${i}`)])
  const seen = new Set()
  arr(rep.answers).forEach((a, i) => {
    const k = a && a.question === 'Q3' ? `Q3:${a.goal_index}` : a && a.question
    if (!want.has(k)) { p.push(`answers[${i}]: 聞いていない問い: ${k}`); return }
    if (seen.has(k)) p.push(`answers[${i}]: 答えの重複: ${k}`)
    seen.add(k)
    if (a.question === 'Q3' && a.goal_id !== goalIdOf(gs[a.goal_index])) p.push(`answers[${i}]: goal_id が goals[${a.goal_index}] の id（${goalIdOf(gs[a.goal_index])}）と違う: ${a.goal_id}`)
    if (!ANSWERS.includes(a.answer)) p.push(`answers[${i}]: answer が yes・no でない`)
    const e = text == null ? (isStr(a.quote) ? null : '引用が空') : quoteProblem(a.quote, text)
    if (e) p.push(`answers[${i}]: ${e}`)
  })
  for (const k of want) if (!seen.has(k)) p.push(`答えの無い問い: ${k}`)
  return p
}
// no の答えを計画の欠陥にする（照合を通った返り値にだけ使う）。Q3 は受け持つ目標の id と部分を持つ。
const unitDefects = (rep, unitId, goals) => arr(rep && rep.answers).filter((a) => a.answer === 'no').map((a) => {
  if (a.question !== 'Q3') return { unit_id: unitId, kind: a.question, claim: `${a.question}: ${UNIT_QUESTIONS[a.question]} → no`, quote: a.quote }
  const g = arr(goals)[a.goal_index]
  const part = g && typeof g === 'object' ? g.part : undefined
  return { unit_id: unitId, kind: 'Q3', goal_id: a.goal_id, ...(part !== undefined ? { part } : {}), claim: `Q3（${a.goal_id}${part !== undefined ? `: ${part}` : ''}）: ${UNIT_QUESTIONS.Q3} → no`, quote: a.quote }
})
// 束ねの照合。全 key（確定した指摘の事実の id）がちょうど 1 つの群か unassigned に入るか、群の id・根本原因・層の値。
function checkGroups(rep, keys) {
  if (!rep || typeof rep !== 'object') return ['返り値が無い']
  const p = []
  const count = new Map()
  const gids = new Set()
  if (!Array.isArray(rep.groups)) p.push('groups が配列でない')
  for (const g of arr(rep.groups)) {
    if (!g || typeof g !== 'object') { p.push('群が object でない'); continue }
    if (!isStr(g.id) || gids.has(g.id)) p.push(`群の id が空か重複: ${g.id}`)
    gids.add(g.id)
    if (!isStr(g.root_cause)) p.push(`群 ${g.id} の root_cause が空`)
    if (!LAYERS.includes(g.layer)) p.push(`群 ${g.id} の layer が不正`)
    if (!arr(g.keys).length) p.push(`群 ${g.id} の keys が空`)
    for (const k of arr(g.keys)) count.set(k, (count.get(k) || 0) + 1)
  }
  for (const k of arr(rep.unassigned)) count.set(k, (count.get(k) || 0) + 1)
  for (const k of count.keys()) if (!keys.includes(k)) p.push(`実在しない key: ${k}`)
  for (const k of keys) if (!count.has(k)) p.push(`どの群にも無い key: ${k}`)
  for (const [k, n] of count) if (n > 1) p.push(`2 つ以上の群にある key: ${k}`)
  return p
}
// <goalmap> 目標・基準・制約の引用と、目標の照合役の返り値の静的な照合。coverage-build と coverage-audit の Workflow source に同じ文がある
// （2 つのスキルは互いのファイルを読まないので写しを置く。一致は tests/coverage-build-goalmap.test.mjs が照らす）。norm・isStr・arr だけを使う。
const CITE_MIN = 12
const CITE_TAIL = /〔\s*([A-Za-z]+)\s*[:：]\s*([^〔〕]*?)\s*〕\s*$/
// 1 行 1 件:「- ID: 本文 〔request: 逐語の引用〕」。引用は行の末尾に 1 つ以上並べ、引用元は request（依頼文）か decisions（決定の記録）。
// 空行と見出しの行は読み飛ばし、それ以外の「- 」で始まらない行は prose に行番号を返す（受け付けるかは呼び出し側が決める）。
function parseCited(text, prefix) {
  const items = []
  const problems = []
  const prose = []
  String(text ?? '').split('\n').forEach((line, i) => {
    if (!line.trim() || /^#{1,6}\s/.test(line)) return
    const m = /^-\s+(.*)$/.exec(line)
    if (!m) { prose.push(i + 1); return }
    let body = m[1].trim()
    const cites = []
    for (let c; (c = CITE_TAIL.exec(body));) {
      cites.unshift({ source: c[1], quote: c[2] })
      body = body.slice(0, c.index).trim()
    }
    const idm = /^([A-Z][A-Z0-9]*\d)[:：]\s*(.*)$/.exec(body)
    items.push({ ...(idm ? { id: idm[1], text: idm[2] } : { id: `${prefix}${items.length + 1}`, text: body }), cites })
  })
  const ids = items.map((x) => x.id)
  for (const id of new Set(ids.filter((x, i) => ids.indexOf(x) !== i))) problems.push(`${prefix} の id が重複している: ${id}`)
  return { items, problems, prose }
}
// 引用元の本文。sources は { request: 文字列, decisions: 文字列 }（decisions は無ければ省く）。
// 短い引用は、引用元の 1 件（依頼文の全体か、依頼文の空でない 1 行、決定の記録の 1 行）の全体を引くときだけ受け付ける（前後の空白は除く）。
function citeSources(sources) {
  const out = {}
  for (const [k, t] of Object.entries(sources || {})) {
    if (typeof t !== 'string') continue
    const bullets = t.split('\n').map((l) => /^-\s+(.*)$/.exec(l)).filter(Boolean).map((m) => m[1].replace(/^[A-Z][A-Z0-9]*\d[:：]\s*/, ''))
    const rows = k === 'request' ? t.split('\n').filter((l) => l.trim()) : []
    out[k] = { text: norm(t), whole: [norm(t), ...[...bullets, ...rows].map(norm)] }
  }
  return out
}
// 目標の照合役に渡す引用の規則の文（citeProblem が受け付ける引用を述べる。字数は CITE_MIN から作る）。両スキルの goal_checker の prompt が埋め込む。
const CITE_RULE = `引用は ${CITE_MIN} 字以上にする。${CITE_MIN} 字未満の短い引用は、引用元の 1 件の全体を引くときだけ受け付ける。1 件とは、依頼文の全体、依頼文の空でない 1 行、決定の記録の 1 行で、決定の記録では行頭の「- 」を除く。決定の記録の短い行は、その行の全体を引く。`
function citeProblem(c, src) {
  const s = src[c && c.source]
  if (!s) return `引用元が ${Object.keys(src).join('・')} のどれでもない: ${c && c.source}`
  const n = norm(c.quote)
  if (!n) return '引用が空'
  if (!s.text.includes(n)) return `引用が ${c.source} に逐語で無い: ${n.slice(0, 40)}`
  if (n.length < CITE_MIN && !s.whole.includes(n)) return `引用が ${CITE_MIN} 字未満（引用元の 1 件の全体を引くときを除く。依頼文は空でない 1 行の全体も 1 件）: ${n}`
  return null
}
// 項目ごとに、引用が 1 つ以上あり、全ての引用が引用元に逐語であるか。
function checkCited(items, src) {
  const p = []
  for (const it of arr(items)) {
    if (!isStr(it.text)) p.push(`${it.id}: 本文が空`)
    if (!arr(it.cites).length) p.push(`${it.id}: 引用が無い（行の末尾に〔request: …〕か〔decisions: …〕を付ける）`)
    for (const c of arr(it.cites)) { const e = citeProblem(c, src); if (e) p.push(`${it.id}: ${e}`) }
  }
  return p
}
// 目標の照合役の返り値: 依頼文と決定の記録から求められている成果を引用つきで列挙し、受け止める項目の id を付ける。
// src を渡すと引用も照らす（Workflow は本文を持たないので形と id だけ、CLI が引用まで照らす）。
function checkGoalMap(rep, ids, src) {
  if (!rep || typeof rep !== 'object') return ['返り値が無い']
  const p = []
  const os = arr(rep.outcomes)
  if (!os.length) p.push('成果が 0 件（依頼文と決定の記録から、求められている成果を全て挙げる）')
  os.forEach((o, i) => {
    if (!isStr(o && o.outcome)) p.push(`outcomes[${i}]: outcome が空`)
    if (!arr(o && o.quotes).length) p.push(`outcomes[${i}]: 引用が無い`)
    if (src) arr(o && o.quotes).forEach((c, j) => { const e = citeProblem(c, src); if (e) p.push(`outcomes[${i}].quotes[${j}]: ${e}`) })
    for (const id of arr(o && o.items)) if (!arr(ids).includes(id)) p.push(`outcomes[${i}]: 実在しない項目の id: ${id}`)
  })
  return p
}
// どの項目にも受け止められていない成果（落とした要求）。
const goalGaps = (rep) => arr(rep && rep.outcomes).filter((o) => !arr(o.items).length).map((o) => ({ outcome: o.outcome, quotes: o.quotes }))
// 目標・基準・制約のファイルを読み、引用を照らす（init と answer が使う。problems が空でなければ台帳を変えない）。
// checkedBy（呼ぶ側のスキルが照合済み）のときは引用を照らさず、目標のファイルの「- 」で始まらない行を呼ぶ側の書いた検査の枠として受け付ける。
function readGoalFiles({ goal, criteria = '', constraints = '', request, decisions = null }, { checkedBy = null } = {}) {
  const g = parseCited(goal, 'G')
  const a = parseCited(criteria, 'AC')
  const d = parseCited(constraints, 'D')
  const files = [...(checkedBy ? [] : [['goal.md', g]]), ['criteria.md', a], ['constraints.md', d], ...(decisions != null && !checkedBy ? [['decisions.md', parseCited(decisions, 'K')]] : [])]
  const problems = [...g.problems, ...a.problems, ...d.problems, ...files.flatMap(([f, x]) => x.prose.map((n) => `${f} の ${n} 行目が「- 」で始まらない（1 行 1 件で書く）`))]
  const all = [...g.items, ...a.items, ...d.items]
  const ids = all.map((x) => x.id)
  for (const id of new Set(ids.filter((x, i) => ids.indexOf(x) !== i))) problems.push(`目標・基準・制約の id が重なる: ${id}`)
  if (!g.items.length) problems.push('goal.md に目標が 1 件も無い')
  if (!checkedBy) problems.push(...checkCited(all, citeSources({ request, ...(decisions != null ? { decisions } : {}) })))
  return { goal: g.items, criteria: a.items, constraints: d.items, problems }
}
// </goalmap>
// </checks>

// ---------------- 起動（B1〜B4） ----------------
// args は {state, callId, stage, workers} だけ。script は workers の行ごとに役を 1 体起動し、役の prompt には担当を取る命令と手順・結果の形だけを置く。
// 入力（目標・依頼文・本文・前の役の出力・事実）は prompt に載せず、役が claim と query で台帳から引く。出力は役が submit で台帳に書く。
// script は役の出力を受け取らず、加工も集約もしない（B5）。返すのは起動の記録（agents）と tokens だけ（B3）。
const A = typeof args === 'string' ? JSON.parse(args) : args
const agents = []
// 消費量は、本体の始めと返す直前の 2 回の budget.spent() の読みの差。どちらかが数でなければ null。
const spentNow = () => { const v = typeof budget !== 'undefined' && budget && typeof budget.spent === 'function' ? budget.spent() : null; return typeof v === 'number' && Number.isFinite(v) ? v : null }
const spentStart = spentNow()
const tokens = () => { const end = spentNow(); return spentStart === null || end === null ? null : end - spentStart }

// shell の 1 語にする（' は '\'' に置き換える）。
const sq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`
// CLI の入口。args で CLI の置き場を運ばないので、CLI が init・next のたびに stateDir に書く入口（本物の CLI を流すだけ）を使う。
// 2 回目からの提出は、claim が返す submit_cmd（本物の CLI の絶対パス）をそのまま流す。
const cliOf = (state) => `${String(state).replace(/[\\/]+$/, '')}/ledger-cli.mjs`
const LAYER_LIST = LAYERS.join('・')
const SEV_LIST = SEVERITIES.join('・')

const COMMON = `
## 共通の前提
- 目的: 対象のファイルを、固定した目標と観点の一覧に照らして網羅的に検査し、確かめた指摘と、見ていない所を台帳に残す。検査だけをし、対象を直さない。あなたはその中の 1 つの役で、取った担当の外を読まない。
- 台帳を書くのは CLI だけ。あなたの入力は claim と query の出力と、そこが指す写しのファイルにあり、出力は結果の JSON を result_path に書いて submit で出す。返り値で内容を返さない。
- 対象のファイルと写しを変えない。書いてよいのは、claim が渡した result_path だけ。
- 読めなかったもの・判定できなかったものは推測で埋めない。CLI の出力に無いことを前提にしない。
- 引用は読んだ本文からの逐語の写しにする（行番号は含めない）。CLI が照合し、合わない提出は理由つきで拒む。
`
// 担当を取って出す手順。query の許し方で 2 の文が変わる（ファイルの段と振り返りは他の役の書き込みを読まず、独立に読む。
// 全文レビューは query で目標と読む範囲だけを引き、事実は引かない）。
const STEP_QUERY = '入力を query で引く。命令は claim と同じ --state・--call・--worker に --task <担当の id> を足した query（例: node … query --state … --call … --worker … --task <id>）。事実の id で細部を引き直すときは --fact <事実の id> を足す（何度でもよい）。原文は写しで開く。索引の行・担当の unit・事実・指摘の場所が持つ写しの file を、start から end の行の範囲のうち要る箇所だけ Read で開く（対象の本体は開かない）'
const STEP_INPUTS = '入力を query で引く。命令は claim と同じ --state・--call・--worker に --task <担当の id> を足した query（例: node … query --state … --call … --worker … --task <id>）。--fact は付けない（この段は他の役の書き込みを読まず、CLI も拒む）。inputs の units の単位ごとに、写しの file を start から end の行の範囲の全文で Read で読む（offset=start, limit=end - start + 1。対象の本体は開かない）'
// 全体の段: claim は意図の束を返す。ターンのたびに伸びた文脈を読み直すのが費用の元なので、束の入力を 1 回の query で引き、結果を全て書いてから 1 回 submit する（設計の決定 16）。
const STEP_BATCH = '取った全ての担当の入力を、1 回の query で引く。命令は claim と同じ --state・--call・--worker に、担当ごとの --task <担当の id> を全て足した query（例: node … query --state … --call … --worker … --task <id1> --task <id2>）。出力の tasks は --task の順に担当ごとの入力（--task が 1 つなら 1 件の形のまま）。事実の id で細部を引き直すときは --fact <事実の id> を足す（何度でもよい）。原文は写しで開く。事実・指摘の場所・単位の索引が持つ写しの file を、start から end の行の範囲のうち判定に要る箇所だけ Read で開く（対象の本体は開かない）'
const STEP_NONE = 'その担当の unit の file を、start から end の行の範囲だけ Read で読む（offset=start, limit=end - start + 1）。この段は query を流さない（他の役の書き込みを読まず、独立に読む。CLI も拒む）'
const loop = (w, query) => `
### 担当を取る命令（この行をそのまま Bash で流す。出力は JSON）
node ${sq(cliOf(A.state))} claim --state ${sq(A.state)} --call ${sq(A.callId)} --worker ${sq(w.id)}
### 手順
1. 取る命令を流す。出力が done: true なら、手順を終えて返り値を返す。命令が終了状態 2 で拒まれたら（呼び出しが閉じたなど）、error を notes に書いて終える。
2. ${query === 'batch' ? STEP_BATCH : `出力の tasks の担当ごとに、${query === 'inputs' ? STEP_INPUTS : query ? STEP_QUERY : STEP_NONE}`}。
3. 担当の kind の節（下の「結果の形」）に従って判断し、結果の JSON を担当の result_path に Write ツールで書く。
4. ${query === 'batch' ? '取った全ての担当の result_path を書いてから、claim の出力の submit_cmd を 1 回だけ Bash で流す（担当ごとに流さない。やり取りの回数を増やすと、そのたびに伸びた文脈を読み直す）。出力の results は出した担当ごとの判定、missing はまだ結果のファイルが無い担当。' : '担当の result_path に書けたら、その都度 claim の出力の submit_cmd をそのまま Bash で流す（全ての担当を書き終えるのを待たない。時間の上限に当たっても、出した担当は台帳に残る）。出力の results は出した担当ごとの判定、missing はまだ結果のファイルが無い担当（後で書いて流し直せばよい）。'}
   ok が false の担当だけ、problems の理由を読んで直した結果を result_path に書き直し、${query === 'batch' ? '書き直した担当の全てを書いてから' : ''}同じ submit_cmd を流し直す（落ちた担当のファイルは CLI が消す。受理された担当は書き直さない）。dropped が true の担当は諦める。
5. 1 に戻る。claim が done を返すまで繰り返す。出し終えていない担当があると、claim は同じ担当を返す。それを直せないときは notes に書いて終える。
前の担当の判断を次の担当に持ち込まない。担当ごとに、その担当の入力だけから判断する。
### 返り値
気づいたこと（notes。命令が流せなかった・拒まれた・諦めた担当など）だけ。内容（指摘・判定）は返り値に書かない。`

// ---------------- 担当の種類ごとの結果の形 ----------------
const READ_RESULT = `- seen: 観点ごとにちょうど 1 つ { lens, answer, quote }。answer は found（指摘がある）・checked（手続きで確かめ、指摘が無い）・not_applicable（この単位に手続きが列挙するものが無い）。どの answer にも、確かめた箇所の逐語の引用を quote に付ける。
- findings: 観点に当たる欠陥ごとに { lens, claim, quote, obligation, confidence, severity, layer }。obligation は結ぶ義務の id（結べないものは findings に入れず references に書く）。confidence は high・medium・low。severity は ${SEV_LIST}。layer は直すべき原因の層（${LAYER_LIST}。本文の層とは限らない）。重さで絞らない。found の観点は指摘を 1 つ以上持つ。
- references: 義務に結べない気づき { claim, quote }。`
// 抜けを数える前の判断。ファイルの段・全文レビュー・全体の段（足す・判定する・確かめる）で同じ文を共有する。
const BOUNDARY_RULE = `#### 境界の答えを抜けと数えない
対象が、ある責務を対象の外（別の層・別の部品・呼ぶ側）に明示して預けている所と、対象に含めないと明示している所は、その境界の答えであって抜けではない。預け先の中身が対象に無いことは、検査の範囲の外のことである。抜けとして数えるのは、目標・要求・仕様がその責務を対象の中で果たすことを求めているときだけで、その求めを claim に逐語で引く（求めが単位の本文にあれば、その箇所も引用の場所に足す）。預け方や範囲の外し方が目標・要求・仕様と食い違うなら、抜けでなく食い違いとして指摘する。正しい対象を、要求に満たないと判じる誤りが起きやすいため。`
const FILE_GUIDE = `#### kind: file（1 つの単位の全文を、全ての観点で読む）
claim は、文脈に収まる分の単位を詰めた担当を返す。担当ごとに 1 つの単位で、全ての担当を読む。担当の lenses（観点の一覧。手続きは「何を列挙し、何と照らすか」）、obligations（義務: 目標・受け入れ基準の id と本文）、hints（利用者のヒント。あれば取り込む）を使う。単位の全文を読んでから、観点ごとに手続きで確かめる。結果は単位ごとに書く。
${READ_RESULT}
- guarantees: この単位が保証していること { subject, quote, confidence, obligation? }（subject は主語の名前。他の単位と照らす鍵になるので、本文の呼び方で短く書く）。
- premises: この単位が前提にしていること（他の所で満たされるはずのこと）{ subject, quote, confidence, obligation? }。
引用は全てその担当の単位の本文から取る。同じ担当の束の他の単位の本文を引いた提出は拒まれる。単位をまたぐ食い違いに気づいたら、気づいた側の単位の前提（相手の単位が満たすべきこと）として書く（またぐ指摘は全体の段が判定する）。
${BOUNDARY_RULE}`
const FACTS_NOTE = `入力は担当ごとに、query の basis（意図の根拠の事実）と related（関係する事実）と omitted（載せなかった件数）・omitted_ids（載せなかった事実の id。上限を超えた件数は omitted_more）と、あれば same_location（同じ箇所の指摘の組: 全文レビューの指摘とファイルの段の指摘で、同じ単位の引用が包含し合う事実の id の組。相手の事実は related にある）。same_location の組は、同じ欠陥を述べているかを判定の材料にする（主張が違う組もある）。重なっていること自体を、指摘を落とす理由にしない。事実は id・type・unit・quote と、原文を開く写しの file・start・end などを持つ（ファイルをまたぐ指摘は locations の要素ごとに持つ）。omitted が 0 でなければ、要る細部を --fact <id> で引き直す。原文は、事実の写しの file を start から end の範囲のうち要る箇所だけ Read で開く。目標の判定の担当は、units（単位の索引）の写しの file と start〜end も開ける。引用は、引く事実の unit（単位の id。大きいファイルを分けた単位は <path>#<位置>）の本文から取る（CLI はその単位の本文で照らす）。前の役の主張を正しいと仮定しない。`
const JUDGE_FINDING = `findings（足す指摘）の要素は { claim, locations: [{ unit?, quote }], obligation, confidence, severity, layer }。quote は単位の本文の逐語の引用。unit（事実の unit・単位の id）は、同じ引用が複数の単位にあるときだけ書けばよい（1 つの単位にしか無ければ CLI が引き当て、複数にあれば候補を挙げて拒む）。obligation は義務の id（goal の担当では CLI が担当の項目にするので書かなくてよい）、confidence は high・medium・low、severity は ${SEV_LIST}、layer は原因の層（${LAYER_LIST}）。`
const GLOBAL_GUIDE = `${FACTS_NOTE}
${BOUNDARY_RULE}主語の照合と前提の消化では、この規則で境界の答えと判じた明示（目標・要求・仕様がその責務を対象の中で果たすことを求めておらず、預け方が求めと食い違わないもの）だけを consistent・satisfied にし、その明示の文を quote にする。求めと食い違うなら conflict・unsatisfied にし、この規則の食い違いの指摘を findings に足す。
#### kind: alias（名寄せ。主語の組が同じものを指すか）
{ same: yes|no|unsure, confidence: high|medium|low, quote }。basis の事実の本文の呼び方と使われ方だけで判じ、決められなければ unsure にする。quote は判断の決め手の逐語の引用。
#### kind: subject（2 つ以上の単位にまたがる主語の照合）
{ verdict: consistent|conflict, quote, findings? }。主語を述べる事実どうしが食い違う・境界で抜ける・前提と保証が噛み合わないなら conflict にして、矛盾・境界の指摘を findings に足す。${JUDGE_FINDING}
#### kind: finding（全文レビューの指摘・ファイルの段の指摘・静的な検査の結果の 1 件を、全体の文脈で残すか落とすか）
{ verdict: keep|drop, reason, quote, obligation?, layer? }。本文と関係する事実に当たって、主張が成り立ち目標に効くなら keep、誤り・無意味・他の所で解消済みなら drop。理由と決め手の逐語の引用を付ける。指摘が義務に結ばれていなければ、結べるときだけ obligation に義務の id を付ける（付かない keep は参考に入る）。指摘が原因の層を持たなければ、keep には layer（${LAYER_LIST}）を付ける。
#### kind: premise（前提が他の単位で満たされているか）
{ verdict: satisfied|unsatisfied, quote, findings? }。満たす保証があれば satisfied にして、その逐語の引用を付ける。無ければ unsatisfied にして、満たされていないことの指摘を findings に足す。${JUDGE_FINDING}
#### kind: goal（目標・受け入れ基準の項目 1 つが支えられているか）
{ verdict: supported|gap, quote, support?, findings? }。担当と query の出力の units（単位の索引: id・path・写しの file と start〜end）で、項目を支える箇所を探す。related が空でも、omitted_ids の事実を --fact で引き直して支えにでき、units の写しを開いて引用できる。supported なら、支えの事実の id（basis・related・omitted_ids にある id だけ）を support に挙げる。gap なら抜けの指摘を findings に足す（unit を書くときは units の id）。${JUDGE_FINDING}
#### kind: confirm（全体の段が足した指摘、全文レビューの指摘への判定、落とした指摘の確認）
{ verdict: agree|disagree, reason, quote, obligation?, layer? }。basis の対象の指摘と、それへの判定を、本文に当たって確かめる。判定が正しければ agree、誤りなら disagree（落とした指摘への disagree はその指摘を復活させる。全文レビューの指摘を残した判定への disagree は、その指摘を確定させない）。落とす判定ほど厳しく見る。境界や対象の中の抜けを主張する指摘への判定は、上の「境界の答えを抜けと数えない」に照らし、対象にその責務の明示の預けや範囲の外しが無いかを本文で探してから判じる。明示があり、対象の中で果たすことを求める目標・要求・仕様の逐語が無ければ、全体の段が足した判定と残した判定には disagree、落とした判定には agree。その逐語があれば、落とした判定には disagree（復活）。決め手の逐語の引用を付ける（合わない引用の判定は検証不能として扱われる）。復活させる指摘が原因の層を持たなければ layer（${LAYER_LIST}）を、義務に結ばれていなければ obligation を付ける。
#### kind: group（束ね。確認が全て閉じた後の、全体の段の最後の意図）
query の basis（確定した指摘の事実）を根本原因で束ねる。症状でなく原因で束ね、全ての事実の id をちょうど 1 つの群に入れる（入れられないものは unassigned）。重さで絞らない。
結果は { groups: [{ id, root_cause, layer, keys: [事実の id] }], unassigned: [事実の id] }。layer は直すべき層（${LAYER_LIST}）。`
const PLAN_RULES = `### 観点の規則
- 観点の数・例・型枠は与えない。目標と対象の中身から切る。観点は一覧で全ての単位（ファイル）に渡すので、当てる単位は選ばない。
- 既にある観点: query の inputs の given_lenses（呼ぶ側が渡した観点と、仕組みの標準の観点）は必ず使われる。定義し直さず、id を重ねない。given_lenses に呼ぶ側の観点があるときは、足りない観点だけを足す提案をする（足す観点が無ければ lenses を空にしてよい。目標の被覆は既にある観点が受け持つ）。
- 観点（lenses）: { id, name, procedure, goals }。procedure は単位を読むときの手続き（何を列挙し、何と照らすか）。
- 目的（固定した目標・制約に照らす）と層（方針・要求・方式設計・詳細設計・実装の層と範囲）の見方は、要る単位があるときだけ計画の観点として切る。切った観点もほかの観点と同じく goals を持ち、閉じた問いを通る。
- 受け持つ目標（goals）: 観点ごとに、その観点の手続きで果たされたかを確かめる目標・受け入れ基準の部分を {id, part} で挙げる。id は query の items（目標の項目）か criteria（受け入れ基準）の id、part はその本文からの逐語の引用で、この観点が受け持つ部分だけを示す（複合の目標は部分ごとに別の要素にし、別の観点に分けてよい）。given_lenses に呼ぶ側の観点が無いときは、どの目標・受け入れ基準も、どれかの観点の goals に入れる。CLI が id の実在・part の逐語・被覆を照らす。
- 受け入れ基準と固定した制約（criteria・constraints）の全てに、受け皿の観点を constraint_map で付ける（{ constraint_id, handled_by: [観点の id] }。given_lenses の id も受け皿にできる）。
- 利用者への質問（questions）: 価値判断が要り、制約で答えが出ていないものだけ { id, question, why_value_judgment, options }。
- 入力の index は 1 行 1 単位（id・写しの file・start〜end・見出しの経路・種類・先頭の数語）。観点を切るのに要る単位だけ、写しの範囲を Read で開く。`
const FULL_REVIEW_GUIDE = `#### kind: full_review（全文レビュー。読む範囲の全ての単位を、目標だけを手に通して読む）
query の inputs は goal（目標の冒頭の文）・items（目標の項目）・criteria（受け入れ基準）・constraints（制約）と、units（読む範囲の単位: id・path・写しの file と start〜end）だけ。観点の一覧は渡らない。観点に縛られず、units の全ての単位の全文を読んでから、目標・受け入れ基準・制約に照らして、誤り・食い違い・抜け・単位をまたぐ矛盾を探す。重さで絞らない。
結果は { findings, references }。
- findings: 欠陥ごとに { claim, locations: [{ unit, quote }], obligation, confidence, severity, layer }。locations は 1 つ以上で、複数の単位を引用してよい（単位をまたぐ欠陥は関わる単位ごとに場所を書く）。unit は inputs の units の id（読む範囲の外の単位を引いた提出は拒まれる）、quote はその単位の本文の逐語の引用。obligation は結ぶ義務の id（items か criteria の id。結べないものは findings に入れず references に書く）。confidence は high・medium・low。severity は ${SEV_LIST}。layer は直すべき原因の層（${LAYER_LIST}。本文の層とは限らない）。
- references: 義務に結べない気づき { claim, locations: [{ unit, quote }] }。
- 保証・前提（guarantees・premises）と観点ごとの見た（seen）は書かない（保証・前提を書いた提出は拒まれる）。
${BOUNDARY_RULE}`
const GUIDES = {
  plan: { query: true, text: `#### kind: plan（計画役。目標の照合と観点の計画を 1 体で担う）
結果は { lenses, questions, constraint_map } に、次の 2 つを要るときだけ足す。
- 目標の照合（query の inputs に item_ids があるときだけ）: inputs の request（依頼文）と decisions（決定の記録）から、利用者が求めている成果を全て挙げる（件数は決めない。同じ成果を重ねない）。outcomes: [{ outcome, quotes: [{ source: request|decisions, quote }], items: [項目の id] }]。items は、その成果を受け止めている目標・受け入れ基準・制約の項目の id（inputs の item_ids の中だけ）。受け止めている項目が無ければ items を空にする（その回の計画は使われず、利用者に返る）。項目が依頼に無いものを足したか・範囲を狭めたかは判定しない（項目ごとの引用は CLI が照らし済み）。outcomes の引用の規則:
${CITE_RULE}
- 計画の見直し（inputs に previous_plan があるとき）: defects（観点の検証役の閉じた問いの no と CLI の静的な照合から作った欠陥。index は配列の位置）と answers（利用者の回答）がある。欠陥の主張が正しいとは限らない。全ての欠陥について目標と対象に照らし、直した（fixed）か根拠を挙げて退けた（rejected）かを、defect_responses: [{ defect_index, action: fixed|rejected, reason }] で返す。重さで選ばない。閉じた問いの答えから作った欠陥を rejected にしても、その観点は次の検証で同じ問いに答え直される。欠陥に関係しない観点は id も中身も変えない（変えた観点だけが確かめ直される）。
${PLAN_RULES}` },
  unit_verify: { query: true, text: `#### kind: unit_verify（観点の検証役。計画の版の、確かめていない観点の全てを見る）
query の inputs の lenses（観点の本文の配列）の観点ごとに、下の閉じた問いだけに yes か no で答える。問いの外のこと（観点の大きさ・層・制約との矛盾・手続きの細部の良し悪し）は判定しない。欠陥を自由に挙げない。作った者の説明を信じず、観点の本文に書いてあることだけで答える。観点ごとに、その観点の本文だけから答える。
- Q1: ${UNIT_QUESTIONS.Q1}
- Q2: ${UNIT_QUESTIONS.Q2}
- Q3: 観点の goals の要素ごとに、${UNIT_QUESTIONS.Q3}（goal_index に要素の位置、goal_id にその要素の id を入れる）
結果は { lenses: [{ unit_id: <観点の id>, answers: [{ question: Q1|Q2|Q3, goal_index?, goal_id?, answer: yes|no, quote }] }] }（inputs の lenses の観点ごとにちょうど 1 つ）。quote はその観点の本文（name・procedure・goals の part）からの逐語の引用（yes なら根拠の箇所、no なら足りない手続きの箇所）。inputs の index は手続きが何に当たるかを見るためで、単位の本文は読まない。` },
  full_review: { query: 'inputs', text: FULL_REVIEW_GUIDE },
  file: { query: false, text: FILE_GUIDE },
  global: { query: 'batch', text: GLOBAL_GUIDE },
  retro: { query: false, text: `#### kind: retro（振り返り。この検査の進め方の出来事を読む）
担当の unit は、この検査の出来事（拒否・返らなかった役・判定できなかった意図・不明の名寄せなど）を 1 行 1 件で並べた写し。担当の lenses（振り返りの観点）で、進め方の悪かった所を探す。対象のファイルの欠陥は探さない（振り返りの指摘は対象の指摘とは別の欄に出る）。結果の形はファイルの段と同じ。
${READ_RESULT}
- guarantees・premises: 空の配列にする。
引用は全てその担当の unit の本文から取る。` },
}
// 結果に本文の逐語の引用を持ち、CLI が quoteProblem で照らす段。これらの役の prompt にだけ QUOTE_RULE を載せる。
const QUOTED = ['unit_verify', 'full_review', 'file', 'global', 'retro']

const promptOf = (w, g) => `${COMMON}
## あなたの役（${w.role}、worker ${w.id}、段 ${A.stage}）
この段の担当を CLI から取り、結果を CLI に出す。取る担当の数は決めない。claim が done を返すまで続ける。
${loop(w, g.query)}
### 結果の形（担当の kind ごと。result_path に書く JSON）
${g.text}${QUOTED.includes(A.stage) ? `
### 引用の規則（submit が照合する）
${QUOTE_RULE}` : ''}`

const WORKER_SCHEMA = { type: 'object', properties: { notes: { type: 'array', items: { type: 'string' } } }, required: ['notes'] }
// 行ごとに 1 体。モデルと effort は行の値（正本は roles.json で、next が行に写す）。agent の失敗（throw）も起動の記録に残す。
async function launch(w, g) {
  const label = `${w.role}-${w.id}`
  let out = null
  try { out = await agent(promptOf(w, g), { label, phase: A.stage, schema: WORKER_SCHEMA, model: w.model, effort: w.effort }) } catch (e) { log(`${label}: agent が失敗した（${String((e && e.message) || e).slice(0, 160)}）`) }
  agents.push({ role: w.role, label, model: w.model, effort: w.effort, ok: out != null })
}

const argProblems = []
if (!A || typeof A !== 'object') argProblems.push('args が object でない')
else {
  if (!Object.hasOwn(GUIDES, A.stage)) argProblems.push(`stage が不正: ${A.stage}`)
  if (typeof A.state !== 'string' || !A.state) argProblems.push('state が無い')
  if (typeof A.callId !== 'string' || !A.callId) argProblems.push('callId が無い')
  if (!Array.isArray(A.workers) || !A.workers.every((w) => w && isStr(w.id) && isStr(w.role) && isStr(w.model) && isStr(w.effort))) argProblems.push('workers が {id, role, model, effort} の配列でない')
}
// args が壊れていれば起動しない（起動の記録が空の呼び出しとして ingest が閉じる）。
if (argProblems.length) log(`args の検査に落ちた: ${argProblems.join(' / ')}`)
else {
  phase(A.stage)
  const g = GUIDES[A.stage]
  await parallel(A.workers.slice(0, LIMITS.maxAgents).map((w) => () => launch(w, g)))
}
return { agents, tokens: tokens() }
