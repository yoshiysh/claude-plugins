export const meta = {
  name: 'coverage-audit-step',
  description: '台帳の 1 段（plan・review・group のどれか）を 1 回だけ流し、生の結果と起動の記録を返す。台帳を書くのは呼び出し側の CLI',
  requirements: ['read-only', 'fresh-thread'],
  phases: [
    { title: 'plan', detail: '目標の照合・独立な計画役 2 体・統合・観点の精査（N1・N2）・観点ごとの閉じた問い' },
    { title: 'review', detail: '読む役の worker が待ち行列から資産を取り、枡ごとに提出する → 全て終わってから、別のモデル・反証側の検証役の worker が指摘のある枡を取る' },
    { title: 'group', detail: '確かめた指摘を根本原因で束ね、別のモデル 2 体で反証する' },
  ],
  limits: { maxAgents: 60, concurrency: 3, timeoutMs: 12000000, agentTimeoutMs: 600000, maxOutputBytes: 4000000 },
}

// <checks> ここから </checks> までは CLI（ledger-core.mjs）が同じ文を読み込んで使う。静的な照合の正本はここだけ。
// native Workflow は本体に meta を渡さないので写しを置く（一致は tests/coverage-audit-workflow.test.mjs が照らす）。
const LIMITS = { maxAgents: 60, concurrency: 3, timeoutMs: 12000000, agentTimeoutMs: 600000, maxOutputBytes: 4000000 }
const QUOTE_MIN = 12
const LAYERS = ['方針', '要求', '方式設計', '詳細設計', '実装']
const SEVERITIES = ['HIGH', 'MEDIUM', 'LOW']
const VERDICTS = ['confirmed', 'refuted', 'unverifiable']
const DEFECT_ACTIONS = ['fixed', 'rejected']
const RESERVED_LENSES = ['purpose', 'layer']
const isStr = (s) => typeof s === 'string' && s.trim().length > 0
const arr = (a) => (Array.isArray(a) ? a : [])
// 値を key の順に並べた JSON にして FNV-1a を取る。args の写し違いの検出と、観点の同一性に使う。
const canon = (v) => (Array.isArray(v) ? `[${v.map(canon).join(',')}]` : v && typeof v === 'object' ? `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}` : JSON.stringify(v))
function fnv(s) {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
  return h.toString(16).padStart(8, '0')
}
const argsSum = (a) => fnv(canon(Object.fromEntries(Object.entries(a).filter(([k]) => k !== 'argsSum'))))
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
function blocksHit(quotes, asset) {
  const lines = String(asset.text).split('\n')
  const hit = new Set()
  for (const q of quotes) {
    if (quoteProblem(q, asset.text)) continue
    asset.blocks.forEach(([s, e], i) => { if (norm(lines.slice(s, e + 1).join('\n')).includes(norm(q))) hit.add(i) })
  }
  return hit
}
// 読みの形だけの照合。Workflow は本文を持たないので、ここまでを Workflow の中で照らしてやり直させる。
// 枡の id は script が持つ値を正とし、読む役には写させない（長い id を写すと先頭を落として返すため）。
function checkReadShape(rep) {
  if (!rep || typeof rep !== 'object') return ['返り値が無い']
  const p = []
  if (!arr(rep.evidence).length && !arr(rep.findings).length) p.push('読んだ証拠の引用が無い')
  arr(rep.findings).forEach((f, i) => {
    if (!isStr(f && f.claim)) p.push(`findings[${i}]: claim が空`)
    if (!isStr(f && f.quote)) p.push(`findings[${i}]: quote が空`)
    if (!SEVERITIES.includes(f && f.severity)) p.push(`findings[${i}]: severity が不正`)
    if (!LAYERS.includes(f && f.layer)) p.push(`findings[${i}]: layer が不正`)
  })
  if (!arr(rep.findings).length && !isStr(rep.none_reason)) p.push('指摘が無いのに none_reason が空')
  return p
}
// 読みの全ての照合。CLI の ingest が、args の hash と合う写しの本文に対して使う。
function checkRead(rep, asset) {
  const p = checkReadShape(rep)
  if (!rep || typeof rep !== 'object') return p
  arr(rep.evidence).forEach((q, i) => { const e = quoteProblem(q, asset.text); if (e) p.push(`evidence[${i}]: ${e}`) })
  arr(rep.findings).forEach((f, i) => { const e = quoteProblem(f && f.quote, asset.text); if (e) p.push(`findings[${i}]: ${e}`) })
  const hit = blocksHit([...arr(rep.evidence), ...arr(rep.findings).map((f) => f && f.quote)], asset)
  if (hit.size < asset.need) p.push(`読んだ証拠の引用が ${asset.need} 区画のうち ${hit.size} 区画にしか無い`)
  return p
}
function checkVerify(rep, n) {
  if (!rep || typeof rep !== 'object') return ['返り値が無い']
  const p = []
  const seen = new Set()
  for (const v of arr(rep.verdicts)) {
    if (!Number.isInteger(v && v.index) || v.index < 0 || v.index >= n) { p.push(`実在しない指摘への判定: ${v && v.index}`); continue }
    if (seen.has(v.index)) p.push(`判定の重複: ${v.index}`)
    seen.add(v.index)
    if (!VERDICTS.includes(v.verdict)) p.push(`判定 ${v.index} の verdict が不正`)
    if (!isStr(v.reason)) p.push(`判定 ${v.index} の理由が空`)
  }
  for (let i = 0; i < n; i++) if (!seen.has(i)) p.push(`判定の無い指摘: ${i}`)
  return p
}
// 確定・棄却は、検証役の引用が本文に逐語であるときだけ効く。偽の引用での棄却では指摘を消さない。
function settleVerdict(v, text) {
  if (!v || !VERDICTS.includes(v.verdict)) return 'unverifiable'
  if (v.verdict !== 'unverifiable' && quoteProblem(v.quote, text)) return 'unverifiable'
  return v.verdict
}
// 観点の同一性: 中身が変われば検証し直す。
const unitKey = (u) => fnv(canon(u))
const unitText = (u) => JSON.stringify(u)
// 計画の観点を当てる資産（applies_to）と除く資産（excluded）の照合。applies_to の id の実在、どの観点も 1 つ以上の資産に当たるか、
// 全ての資産が「計画の観点の applies_to を合わせたもの」か excluded のどちらか一方にちょうど 1 回入るか（applies_to には複数の観点から入ってよい）。
// assetIds を渡さないと形だけを照らす。CLI は ingest と、持ち越しで資産が変わった next で照らす。
function checkAppliesTo(lenses, assetIds, excluded) {
  const p = []
  const known = Array.isArray(assetIds) ? new Set(assetIds) : null
  const hit = new Set()
  for (const l of arr(lenses)) {
    if (!Array.isArray(l && l.applies_to) || !l.applies_to.every(isStr)) { p.push(`観点 ${l && l.id} の applies_to が資産の id の配列でない`); continue }
    if (!l.applies_to.length) p.push(`観点 ${l.id} がどの資産にも当たらない（applies_to が空）`)
    for (const id of l.applies_to) {
      if (known && !known.has(id)) p.push(`観点 ${l.id} の applies_to に実在しない資産: ${id}`)
      hit.add(id)
    }
  }
  if (excluded !== undefined && !Array.isArray(excluded)) p.push('excluded が配列でない')
  const ex = new Set()
  for (const x of arr(excluded)) {
    const id = x && x.asset
    if (!isStr(id)) { p.push('excluded の asset が空'); continue }
    if (!isStr(x.reason)) p.push(`excluded の ${id} に reason が無い`)
    if (known && !known.has(id)) p.push(`excluded に実在しない資産: ${id}`)
    if (ex.has(id)) p.push(`excluded に 2 回以上ある資産: ${id}`)
    if (hit.has(id)) p.push(`applies_to と excluded の両方にある資産: ${id}`)
    ex.add(id)
  }
  if (known) for (const id of known) if (!hit.has(id) && !ex.has(id)) p.push(`applies_to にも excluded にも無い資産: ${id}`)
  return p
}
// 計画の観点が受け持つ目標の部分（goals: [{id, part}]）の照合。id の実在、part が空でないこと、どの観点の goals も空でないこと、
// 全ての目標・受け入れ基準がどれかの計画の観点の goals に入ること。goalTexts（id → 本文）を渡すと part が本文に逐語であるかも照らす。
// 被覆は計画の観点だけで数える。goalItemIds を渡さないと形だけを照らす（Workflow は本文を持たないので逐語かは CLI の ingest が照らす）。
function checkGoals(lenses, goalItemIds, goalTexts) {
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
  if (known) for (const id of known) if (!hit.has(id)) p.push(`どの観点の goals にも無い目標・受け入れ基準: ${id}`)
  return p
}
function checkPlan(L, ctx) {
  if (!L || typeof L !== 'object') return ['返り値が無い']
  const p = []
  const ids = new Set()
  const add = (id, what) => { if (!isStr(id)) p.push(`${what} の id が空`); else if (ids.has(id)) p.push(`id の重複: ${id}`); ids.add(id) }
  for (const l of arr(L.lenses)) {
    add(l.id, '観点')
    if (RESERVED_LENSES.includes(l.id) || arr(ctx.givenLensIds).includes(l.id)) p.push(`観点 ${l.id} は既にある観点で、計画役は定義し直せない`)
    if (!isStr(l.procedure)) p.push(`観点 ${l.id} の procedure が空`)
  }
  for (const q of arr(L.questions)) { add(q.id, '質問'); if (!isStr(q.why_value_judgment)) p.push(`質問 ${q.id} に価値判断の理由が無い`) }
  if (!ctx.lensesGiven && !arr(L.lenses).length) p.push('観点が 0 件')
  p.push(...checkAppliesTo(L.lenses, ctx.assetIds, L.excluded))
  if (!ctx.lensesGiven || arr(L.lenses).length) p.push(...checkGoals(L.lenses, ctx.goalItemIds, ctx.goalTexts))
  const units = new Set([...arr(L.lenses).map((l) => l.id), ...RESERVED_LENSES, ...arr(ctx.givenLensIds)])
  const mapped = new Set()
  for (const m of arr(L.constraint_map)) {
    if (!arr(ctx.constraintIds).includes(m.constraint_id)) { p.push(`実在しない制約: ${m.constraint_id}`); continue }
    mapped.add(m.constraint_id)
    const hs = arr(m.handled_by)
    if (!hs.length) p.push(`制約 ${m.constraint_id} の受け皿が空`)
    for (const h of hs) if (!units.has(h)) p.push(`制約 ${m.constraint_id} の受け皿が実在しない: ${h}`)
  }
  for (const c of arr(ctx.constraintIds)) if (!mapped.has(c)) p.push(`制約 ${c} の受け皿が無い`)
  if (ctx.sources) {
    const seen = new Set()
    for (const s of arr(L.source_map)) {
      if (!ctx.sources.includes(s.source)) p.push(`source_map に元に無い単位: ${s.source}`)
      seen.add(s.source)
      if (isStr(s.merged_into) === isStr(s.dropped_reason)) p.push(`${s.source} は統合先か落とす理由のどちらか 1 つだけを持つ`)
      if (isStr(s.merged_into) && !ids.has(s.merged_into)) p.push(`${s.source} の統合先が無い: ${s.merged_into}`)
    }
    for (const s of ctx.sources) if (!seen.has(s)) p.push(`source_map に無い元の単位: ${s}`)
  }
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
// 観点の精査役に聞く閉じた問い。N1 は観点が当てた資産ごと、N2 は他の計画の観点ごとに聞く。
const LENS_QUESTIONS = {
  N1: 'この資産に、手続きが列挙するものがあるか',
  N2: 'この観点と、同じものを列挙し、同じものと照らすか',
}
// 精査の答えの照合: { lens_id, n1: [{asset, answer, quote}], n2: [{lens, answer, quote_self?, quote_other?}] }。
// N1 は lens.applies_to の資産ごと、N2 は otherIds（自分を除く他の計画の観点）ごとに 1 つずつ。過不足・重複・yes/no 以外は受け付けない。
// N1 の引用はその資産の本文に、N2 の yes の quote_self は自分の手続きに、quote_other は相手の手続きに逐語であること。
// texts（{assets: id → 本文, procedures: 観点の id → 手続き}）を渡さないと引用の形だけを照らす（逐語かは CLI の ingest が照らす）。
function checkLensReview(rep, lens, otherIds, texts) {
  if (!rep || typeof rep !== 'object') return ['返り値が無い']
  const p = []
  const id = lens && lens.id
  if (rep.lens_id !== id) p.push(`lens_id が違う: ${rep.lens_id}`)
  if (!Array.isArray(rep.n1)) p.push('n1 が配列でない')
  if (!Array.isArray(rep.n2)) p.push('n2 が配列でない')
  const quoteIn = (q, t) => (!texts ? (isStr(q) ? null : '引用が空') : isStr(t) ? quoteProblem(q, t) : '照らす本文が無い')
  const want1 = new Set(arr(lens && lens.applies_to))
  const seen1 = new Set()
  arr(rep.n1).forEach((a, i) => {
    const k = a && a.asset
    if (!want1.has(k)) { p.push(`n1[${i}]: 当てていない資産への答え: ${k}`); return }
    if (seen1.has(k)) p.push(`n1[${i}]: 答えの重複: ${k}`)
    seen1.add(k)
    if (!ANSWERS.includes(a.answer)) p.push(`n1[${i}]（${k}）: answer が yes・no でない`)
    const e = quoteIn(a.quote, texts && texts.assets && texts.assets[k])
    if (e) p.push(`n1[${i}]（${k}）: ${e}`)
  })
  for (const k of want1) if (!seen1.has(k)) p.push(`N1 の答えの無い資産: ${k}`)
  const want2 = new Set(arr(otherIds).filter((x) => x !== id))
  const seen2 = new Set()
  arr(rep.n2).forEach((a, i) => {
    const k = a && a.lens
    if (!want2.has(k)) { p.push(`n2[${i}]: 聞いていない観点への答え: ${k}`); return }
    if (seen2.has(k)) p.push(`n2[${i}]: 答えの重複: ${k}`)
    seen2.add(k)
    if (!ANSWERS.includes(a.answer)) p.push(`n2[${i}]（${k}）: answer が yes・no でない`)
    if (a.answer !== 'yes') return
    const procs = (texts && texts.procedures) || {}
    for (const [f, owner] of [['quote_self', id], ['quote_other', k]]) {
      const e = quoteIn(a[f], procs[owner])
      if (e) p.push(`n2[${i}]（${k}）の ${f}: ${e}`)
    }
  })
  for (const k of want2) if (!seen2.has(k)) p.push(`N2 の答えの無い観点: ${k}`)
  return p
}
// 束ねの照合。全 key がちょうど 1 つの群に入るか、層の値、既存の型に結ぶ群（extends）がある横展開の観点を指すか、
// 新しい型（extends が無く pattern がある）の群が当てる資産（applies_to）を空でなく挙げるか。extends のある群は型を作らないので applies_to を照らさない。
// assetIds を渡すと applies_to の id の実在も照らす（Workflow は資産の一覧を持たないので形だけ、CLI の ingest が実在まで照らす）。
// lateralIds は今ある横展開の観点の id（lat- で始まる）。extends はこの中の id だけを受け付ける。
function checkGroups(rep, keys, assetIds, lateralIds) {
  if (!rep || typeof rep !== 'object') return ['返り値が無い']
  const p = []
  const count = new Map()
  const gids = new Set()
  for (const g of arr(rep.groups)) {
    if (!isStr(g.id) || gids.has(g.id)) p.push(`群の id が空か重複: ${g.id}`)
    gids.add(g.id)
    if (!isStr(g.root_cause)) p.push(`群 ${g.id} の root_cause が空`)
    if (!LAYERS.includes(g.layer)) p.push(`群 ${g.id} の layer が不正`)
    for (const k of arr(g.keys)) count.set(k, (count.get(k) || 0) + 1)
    if (g.extends !== undefined && g.extends !== '' && (!isStr(g.extends) || !g.extends.startsWith('lat-') || (Array.isArray(lateralIds) && !lateralIds.includes(g.extends)))) p.push(`群 ${g.id} の extends が今ある横展開の観点の id でない: ${g.extends}`)
    else if (isStr(g.extends)) continue
    if (isStr(g.pattern)) {
      if (!Array.isArray(g.applies_to) || !g.applies_to.length || !g.applies_to.every(isStr)) p.push(`群 ${g.id} は型（pattern）があるのに、当てる資産（applies_to）が資産の id の空でない配列でない`)
      else if (Array.isArray(assetIds)) for (const id of g.applies_to) if (!assetIds.includes(id)) p.push(`群 ${g.id} の applies_to に実在しない資産: ${id}`)
    }
  }
  for (const k of arr(rep.unassigned)) count.set(k, (count.get(k) || 0) + 1)
  for (const k of count.keys()) if (!keys.includes(k)) p.push(`実在しない key: ${k}`)
  for (const k of keys) if (!count.has(k)) p.push(`どの群にも無い key: ${k}`)
  for (const [k, n] of count) if (n > 1) p.push(`2 つ以上の群にある key: ${k}`)
  return p
}
// 束ねに渡す指摘の key。指摘は写しのファイルで渡すので、args には件数だけを載せる。
const groupKeys = (n) => Array.from({ length: n }, (_, i) => `K${i + 1}`)
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

const A = typeof args === 'string' ? JSON.parse(args) : args
const agents = []
// agent の失敗（throw）も null に揃え、起動の記録を残す（欠測を黙って落とさない）。
async function call(role, label, prompt, schema) {
  const r = A.roles[role]
  let out = null
  try { out = await agent(prompt, { label, phase: A.stage, schema, model: r.model, effort: r.effort }) } catch (e) { log(`${label}: agent が失敗した（${String((e && e.message) || e).slice(0, 160)}）`) }
  agents.push({ role, label, model: r.model, effort: r.effort, ok: out != null })
  return out
}
// 静的な検査に落ちたら、欠けを添えて 1 回だけやり直す。
async function checked(role, label, prompt, schema, check) {
  let r = await call(role, label, prompt, schema)
  let p = check(r)
  if (p.length) {
    const r2 = await call(role, `${label}（やり直し）`, `${prompt}\n\n## 前回の返り値と、静的な検査で見つかった欠け\n欠けを全て直した返り値の全体を返す。\n${p.map((x) => `- ${x}`).join('\n')}\n\n前回の返り値: ${JSON.stringify(r)}`, schema)
    const p2 = check(r2)
    if (r2) { r = r2; p = p2 }
  }
  return { result: r, problems: p }
}
const tokens = () => (typeof budget !== 'undefined' && budget && typeof budget.spent === 'function' ? budget.spent() : null)
const done = (body) => ({ stage: A.stage, call_id: A.callId, ...body, agents, tokens: tokens(), limits: LIMITS })

const argProblems = []
if (!A || typeof A !== 'object') argProblems.push('args が object でない')
else {
  if (!['plan', 'review', 'group'].includes(A.stage)) argProblems.push(`stage が不正: ${A.stage}`)
  if (!A.roles || typeof A.roles !== 'object') argProblems.push('roles が無い')
  if (A.argsSum !== argsSum(A)) argProblems.push('args の写しが next の出力と違う（argsSum が合わない）')
}
if (argProblems.length) return { stage: A && A.stage, call_id: A && A.callId, status: 'blocked', reason: 'args の検査に落ちた', problems: argProblems, agents: [] }

// 写しのファイルの読み方。本文は args に載らないので、担当が Read で自分の範囲だけを読む。
// args の写しは stateDir の写しの置き場（snapDir）からのファイル名、資産・枡の id と path は対象の基準（targetBase）からの相対で載る。担当に渡すときに結合する。
const snapOf = (r) => `${A.snapDir || ''}${r.snapshot}`
const targetOf = (c) => (c.retro ? c.path : `${A.targetBase || ''}${c.path}`)
const rangeOf = (r) => `写し: ${snapOf(r)}\n行: ${r.start}-${r.end}（Read の offset=${r.start}, limit=${r.end - r.start + 1}。この範囲の外は読まない）`
// 担当が読む文（目標・基準・制約・ヒント、段ごとの依頼文・前の計画・欠陥・回答・観点の手続き）は束（brief）の写しにあり、args には参照だけがある。
const COMMON = (b) => `
## 共通の前提
- 目的: 対象を資産 × 観点の枡に分けて網羅的に検査し、見落としと見ていない所を台帳に残す。検査だけをし、対象を直さない・書かない。あなたはその中の 1 つの役で、受け持ち以外を読まない。
- 依頼の束: まず Read で下のファイルを全て読む。固定した目標（変えない。constraint_map の対象ではない）・受け入れ基準と固定した制約（id で指す）・利用者のヒント（あれば取り込む）と、この役に要る文はそこにある。束に無いことを推測で埋めない。
束: ${snapOf(b)}（hash ${b.hash}）
- ファイルは変えない。結果は返り値だけで返す。読めなかったものは推測で埋めず、そう書く。
- 引用は読んだ本文からの逐語の写しにする（行番号は含めない）。引用は script が機械で照合し、合わないものは受け付けない。
`

// ---------------- plan（独立な 2 体 → 統合 → 観点ごとの検証） ----------------
const UNIT_PROPS = {
  lenses: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, procedure: { type: 'string' }, applies_to: { type: 'array', items: { type: 'string' } }, goals: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, part: { type: 'string' } }, required: ['id', 'part'] } } }, required: ['id', 'name', 'procedure', 'applies_to', 'goals'] } },
  excluded: { type: 'array', items: { type: 'object', properties: { asset: { type: 'string' }, reason: { type: 'string' } }, required: ['asset', 'reason'] } },
  questions: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, question: { type: 'string' }, why_value_judgment: { type: 'string' }, options: { type: 'array', items: { type: 'string' } } }, required: ['id', 'question', 'why_value_judgment', 'options'] } },
  constraint_map: { type: 'array', items: { type: 'object', properties: { constraint_id: { type: 'string' }, handled_by: { type: 'array', items: { type: 'string' } } }, required: ['constraint_id', 'handled_by'] } },
}
const PLAN_SCHEMA = { type: 'object', properties: UNIT_PROPS, required: Object.keys(UNIT_PROPS) }
const INTEGRATED_SCHEMA = {
  type: 'object',
  properties: {
    ...UNIT_PROPS,
    source_map: { type: 'array', items: { type: 'object', properties: { source: { type: 'string' }, merged_into: { type: 'string' }, dropped_reason: { type: 'string' } }, required: ['source', 'merged_into', 'dropped_reason'] } },
    defect_responses: { type: 'array', items: { type: 'object', properties: { defect_index: { type: 'integer' }, action: { type: 'string', enum: DEFECT_ACTIONS }, reason: { type: 'string' } }, required: ['defect_index', 'action', 'reason'] } },
  },
  required: [...Object.keys(UNIT_PROPS), 'source_map', 'defect_responses'],
}
const GOAL_SCHEMA = { type: 'object', properties: { outcomes: { type: 'array', items: { type: 'object', properties: { outcome: { type: 'string' }, quotes: { type: 'array', items: { type: 'object', properties: { source: { type: 'string', enum: ['request', 'decisions'] }, quote: { type: 'string' } }, required: ['source', 'quote'] } }, items: { type: 'array', items: { type: 'string' } } }, required: ['outcome', 'quotes', 'items'] } } }, required: ['outcomes'] }
const LENS_REVIEW_SCHEMA = { type: 'object', properties: { lens_id: { type: 'string' }, n1: { type: 'array', items: { type: 'object', properties: { asset: { type: 'string' }, answer: { type: 'string', enum: ANSWERS }, quote: { type: 'string' } }, required: ['asset', 'answer', 'quote'] } }, n2: { type: 'array', items: { type: 'object', properties: { lens: { type: 'string' }, answer: { type: 'string', enum: ANSWERS }, quote_self: { type: 'string' }, quote_other: { type: 'string' } }, required: ['lens', 'answer'] } } }, required: ['lens_id', 'n1', 'n2'] }
const UNIT_VERDICT_SCHEMA = { type: 'object', properties: { unit_id: { type: 'string' }, answers: { type: 'array', items: { type: 'object', properties: { question: { type: 'string', enum: Object.keys(UNIT_QUESTIONS) }, goal_index: { type: 'integer' }, goal_id: { type: 'string' }, answer: { type: 'string', enum: ANSWERS }, quote: { type: 'string' } }, required: ['question', 'answer', 'quote'] } } }, required: ['unit_id', 'answers'] }

async function planStage() {
  phase('plan')
  const ctx = { constraintIds: [...arr(A.criteriaIds), ...arr(A.constraintIds)], lensesGiven: arr(A.givenLensIds).length > 0, givenLensIds: arr(A.givenLensIds), goalItemIds: arr(A.goalItemIds), ...(Array.isArray(A.assetIds) ? { assetIds: A.assetIds.map((id) => `${A.targetBase || ''}${id}`) } : {}) }
  const out = { goal_check: null, planners: null, plan: null, plan_problems: [], unit_checks: [] }
  // 目標の照合: 依頼文と決定の記録が求める成果を挙げ、どの項目が受け止めるかを返す（呼ぶ側が照合済みなら goalChecked で流さない）。
  if (!A.goalChecked) {
    // 引用が依頼文・決定の記録に逐語かは、本文を持つ CLI の ingest が照らす（ここでは形と id だけ）。
    out.goal_check = (await checked('goal_checker', 'goal-check', `${COMMON(A.goalBrief)}
## あなたの役: 目標の照合役
束の「## 依頼文」と「## 決定の記録」から、利用者が求めている成果を全て挙げる（件数は決めない。同じ成果を重ねない）。成果ごとに、根拠の逐語の引用（quotes。source は依頼文なら request、決定の記録なら decisions）と、その成果を受け止めている目標・受け入れ基準・制約の項目の id（items）を返す。受け止めている項目が無ければ items を空にする。
項目が依頼に無いものを足したか・範囲を狭めたか・手順かは判定しない（項目ごとの引用は script が照らし済み）。
## 項目の id（items に使う）
${JSON.stringify(arr(A.goalIds))}`, GOAL_SCHEMA, (r) => checkGoalMap(r, arr(A.goalIds)))).result
  }
  // 統合するか（索引があるか）は CLI が決める。前の計画があれば見直し、無ければ独立な 2 体から作る。
  if (!ctx.lensesGiven && A.index) {
    const RULES = `
### 観点の規則
- 観点の数・例・型枠は与えない。目標と対象の中身から切る。
- 観点（lenses）: 対象を資産（Markdown は frontmatter と節の中の段落・箇条書き・表・コードのブロック、JS は宣言と宣言の無い所の行の塊、その他は行の塊）ごとに見るときの手続き（何を列挙し、何と照らすか）。観点 purpose（目的）と layer（層と範囲）はスキルが持ち、除いた資産（excluded）の外の全ての資産に当たるので作らない。
- 当てる資産（applies_to）: 観点ごとに、その観点で確かめることが目標とその資産の中身に関係する資産を、下の索引の資産の id で全て挙げる。関係の無い資産には当てない（関係の無い組を見ても見落としは減らない）。
- 除く資産（excluded）: どの観点の確かめることも関係しない資産を、理由（reason）と共に挙げる。除いた資産は purpose・layer を含めどの観点でも読まず、除いたことを開示する。全ての資産は、どれかの観点の applies_to か excluded のどちらか一方にちょうど 1 回入れる。script が id の実在とこの被覆を照らす。
- 受け持つ目標（goals）: 観点ごとに、その観点の手続きで果たされたかを確かめる目標・受け入れ基準の部分を {id, part} で挙げる。id は束の「## 目標の項目」「## 受け入れ基準」の id、part はその本文からの逐語の引用で、この観点が受け持つ部分だけを示す（複合の目標は部分ごとに別の要素にし、別の観点に分けてよい）。受け持たない目標を goals に入れない。どの目標・受け入れ基準も、どれかの観点の goals に入れる。script が id の実在・part の逐語・被覆を照らす。
- 受け入れ基準と固定した制約の全てに、受け皿の観点を constraint_map で付ける（constraint_id に基準か制約の id）。
- 利用者への質問（questions）: 価値判断が要り、制約で答えが出ていないものだけ。`
    const INDEX = `### 対象の索引（1 行 1 資産のタブ区切り: 資産の id・写しのファイル・行の範囲・見出しの経路・種類・先頭の数語）\n${A.index ? `${rangeOf(A.index)}\n各行の写しと範囲を Read で開けば資産の本文を読める。観点を切るのに要る所だけを読む。` : '（無し）'}`
    let integ
    if (!arr(A.prevLensIds).length) {
      const planPrompt = (who) => `${COMMON(A.brief)}
## あなたの役: 計画役 ${who}
もう 1 体の計画役が同じ目標と対象から独立に作る。相手の結果は見ない。後で統合役が調停する。観点と当てる資産の組が、検査の分母（枡）になる。
${RULES}
${INDEX}`
      const check = (r) => checkPlan(r, ctx)
      const [pa, pb] = await parallel([
        () => checked('planner_a', 'plan-A', planPrompt('A'), PLAN_SCHEMA, check),
        () => checked('planner_b', 'plan-B', planPrompt('B'), PLAN_SCHEMA, check),
      ])
      out.planners = { A: pa, B: pb }
      const ok = [['A', pa], ['B', pb]].filter(([, x]) => x && x.result)
      if (!ok.length) return { ...out, status: 'blocked', reason: '計画役が 2 体とも返らなかった' }
      const sources = ok.flatMap(([w, x]) => arr(x.result.lenses).map((u) => `${w}:${u.id}`))
      integ = await checked('integrator', 'integrate', `${COMMON(A.brief)}
## あなたの役: 統合役
互いを見ずに作った ${ok.map(([w]) => w).join(' と ')} を 1 つにする。どちらかを丸ごと採らず、目標と対象に照らして決める。全ての元の観点に、統合先（merged_into）か落とす理由（dropped_reason）を source_map で付ける。片方にしか無い観点を黙って落とさない。観点を併せるときは当てる資産（applies_to）も併せ、元のどちらかが当てた資産を黙って落とさない。
${RULES}
${INDEX}
${ok.map(([w, x]) => `### ${w}（静的な検査の残り ${x.problems.length} 件${x.problems.length ? ': ' + x.problems.join(' / ') : ''}）\n${JSON.stringify(x.result)}`).join('\n')}
（defect_responses は空の配列にする）`, INTEGRATED_SCHEMA, (r) => checkPlan(r, { ...ctx, sources }))
    } else {
      const defectCount = Number(A.defectCount) || 0
      integ = await checked('integrator', 'integrate-again', `${COMMON(A.againBrief)}
## あなたの役: 統合役（前の計画の見直し）
前の計画（束の「### 前の計画」）に、観点ごとの検証役の閉じた問いの no と script の静的な照合から作った欠陥（束の「### 欠陥」。${defectCount} 件。id は P<n>）と、利用者の回答（束の「### 利用者の回答」。${arr(A.answerIds).length} 件。計画の質問か欠陥の id への回答）がある。欠陥の主張が正しいとは限らない。全ての欠陥について目標と対象に照らし、直した（fixed）か根拠を挙げて退けた（rejected）かを defect_responses に返す。重さで選ばない。閉じた問い（kind が Q1・Q2・Q3・N2）の答えから作った欠陥を rejected にしても欠陥を退けたことにはならず、その観点は次の検証・精査で同じ問いに答え直される。前の計画の applies_to と excluded は、観点の精査（N1）で資産を外した後の形で、外した資産の excluded の理由は N1 から始まる。欠陥に関係しない観点は id も中身も変えない（変えた観点と、欠陥の残る観点だけが検証し直される）。
${RULES}
${INDEX}
（source_map は前の計画の観点を「P:<id>」で全て挙げる: ${arr(A.prevLensIds).map((id) => `P:${id}`).join(', ')}）`, INTEGRATED_SCHEMA, (r) => checkPlan(r, { ...ctx, sources: arr(A.prevLensIds).map((id) => `P:${id}`), defectCount }))
    }
    out.plan = integ.result
    out.plan_problems = integ.problems
    if (!integ.result) return { ...out, status: 'blocked', reason: '統合役が返らなかった' }
  }
  // 観点の精査（N1・N2）→ 観点の検証（Q1〜Q3）の順に、どちらも新しい context の役が閉じた問いに答える。
  // この呼び出しで統合した計画は返り値の本文で渡し、前の計画は CLI が書いた観点ごとの束（reviewUnits・units）で渡す。
  // 資産の本文は、索引の写しの行（資産の写しと範囲）から担当が Read で読む。args の資産の id は対象の基準からの相対なので、基準を付けて使う。
  const TB = A.targetBase || ''
  const fullId = (id) => (String(id).startsWith(TB) ? String(id) : `${TB}${id}`)
  const IDX = A.index || A.lensIndex || null
  const ROW = new Map(arr(A.assetIds).map((id, i) => [fullId(id), i + 1]))
  const indexRows = (ids) => {
    if (!IDX) return '（索引が無い）'
    const ns = [...new Set(arr(ids).map((id) => ROW.get(fullId(id))).filter(Number.isInteger))].sort((a, b) => a - b)
    const runs = []
    for (const n of ns) { const r = runs[runs.length - 1]; if (r && r[1] === n - 1) r[1] = n; else runs.push([n, n]) }
    return runs.map(([s, e]) => `写し: ${snapOf(IDX)}\n行: ${s}-${e}（Read の offset=${s}, limit=${e - s + 1}）`).join('\n') || '（当てた資産の行が索引に無い）'
  }
  const pick = (u) => ({ id: u.id, name: u.name, procedure: u.procedure })
  const planLenses = out.plan ? arr(out.plan.lenses) : []
  const reviews = out.plan
    ? planLenses.map((u) => ({ unit_id: u.id, key: unitKey(u), applies_to: arr(u.applies_to).map(fullId), others: planLenses.filter((x) => x.id !== u.id).map((x) => x.id), text: JSON.stringify(pick(u)), othersText: planLenses.filter((x) => x.id !== u.id).map((x) => JSON.stringify(pick(x))).join('\n') }))
    : arr(A.reviewUnits).map((r) => ({ unit_id: r.unit_id, key: r.key, applies_to: arr(r.applies_to).map(fullId), others: arr(r.others), brief: r.brief }))
  // 1 観点の最悪の起動数は、精査とやり直しの 2 体と、検証とやり直しの 2 体。
  const maxReviews = Math.max(0, Math.floor((LIMITS.maxAgents - agents.length) / 4))
  const toReview = reviews.slice(0, maxReviews)
  const lensChecks = await pipeline(toReview, (r) => checked('lens_reviewer', `lens-review-${r.unit_id}`, `${COMMON(r.brief || A.brief)}
## あなたの役: 観点の精査役（観点 ${r.unit_id} だけを見る）
観点が要るかを、下の閉じた問いだけに yes か no で答える。問いの外のこと（手続きの細部の良し悪し・観点の大きさ・目標の受け持ち）は判定しない。欠陥を自由に挙げない。作った者の説明を信じず、資産と手続きの本文に書いてあることだけで答える。
- N1 は資産ごとに: ${LENS_QUESTIONS.N1}。下の索引の行から資産の写しと行の範囲を読み、その範囲を Read で読んで答える。yes なら列挙するものの箇所、no なら資産の中身を示す箇所を、その資産の本文から逐語で quote に引く。
- N2 は他の観点ごとに: ${LENS_QUESTIONS.N2}。yes なら、同じものを列挙し同じものと照らすことを示す箇所を、この観点の手続きから quote_self に、相手の手続きから quote_other に逐語で引く。no なら引用は要らない。
引用は script が照合する（N1 はその資産の本文、N2 はそれぞれの手続き）。
### 問い（n1・n2 に 1 つずつ返す。lens_id は ${r.unit_id}）
${r.applies_to.map((a) => `- N1（asset: ${a}）: ${LENS_QUESTIONS.N1}`).join('\n') || '- N1: 当てた資産が無い'}
${r.others.map((o) => `- N2（lens: ${o}）: ${LENS_QUESTIONS.N2}`).join('\n') || '- N2: 他の計画の観点が無いので聞かない'}
### 当てた資産の索引の行（id・写し・行の範囲・見出しの経路・種類・先頭の数語のタブ区切り）
${indexRows(r.applies_to)}
${r.text != null ? `### 精査する観点\n${r.text}\n### 他の計画の観点（1 行 1 観点）\n${r.othersText || '（無し）'}` : '精査する観点と他の計画の観点の本文は、束の「### 精査する観点」「### 他の計画の観点」にある。'}`, LENS_REVIEW_SCHEMA, (x) => checkLensReview(x, { id: r.unit_id, applies_to: r.applies_to }, r.others)).then((x) => ({ unit_id: r.unit_id, key: r.key, ...x })))
  out.lens_reviews = lensChecks.map((x, i) => x || { unit_id: toReview[i].unit_id, key: toReview[i].key, result: null, problems: ['pipeline が null を返した'] })
  out.lenses_not_reviewed = reviews.slice(maxReviews).map((r) => r.unit_id)
  // 精査の結果から、検証する観点を決める。精査を受け付けなかった観点と、N1 の no で資産を外す観点はこの呼び出しで検証しない
  // （前の計画の観点は束の本文が外す前の形なので、次の呼び出しで外した後の形を検証する）。この呼び出しで統合した観点は外した後の形を検証する。
  // 全ての資産が N1 の no の観点は落ちるので検証しない。
  const reviewOf = new Map(out.lens_reviews.map((x) => [x.unit_id, x]))
  const pruned = new Map()
  const holdBack = new Set(out.lenses_not_reviewed)
  for (const r of reviews) {
    const x = reviewOf.get(r.unit_id)
    if (!x) continue
    if (!x.result || x.problems.length) { holdBack.add(r.unit_id); continue }
    const no = new Set(arr(x.result.n1).filter((a) => a.answer === 'no').map((a) => a.asset))
    if (!no.size) continue
    const u = planLenses.find((l) => l.id === r.unit_id)
    const left = u ? arr(u.applies_to).filter((a) => !no.has(fullId(a))) : []
    if (!u || !left.length) { holdBack.add(r.unit_id); continue }
    pruned.set(r.unit_id, { ...u, applies_to: left })
  }
  const verified = new Set(arr(A.verifiedKeys))
  const units = (out.plan
    ? planLenses.map((u) => pruned.get(u.id) || u).filter((u) => !verified.has(unitKey(u))).map((u) => ({ unit_id: u.id, key: unitKey(u), goals: arr(u.goals), applies_to: arr(u.applies_to), text: unitText(u) }))
    : arr(A.units).map((u) => ({ unit_id: u.unit_id, key: u.key, goals: arr(u.goals), applies_to: arr(u.applies_to), brief: u.brief }))).filter((u) => !holdBack.has(u.unit_id))
  const maxUnits = Math.max(0, Math.floor((LIMITS.maxAgents - agents.length) / 2))
  const toVerify = units.slice(0, maxUnits)
  const checks = await pipeline(toVerify, (u) => checked('unit_verifier', `verify-unit-${u.unit_id}`, `${COMMON(u.brief || A.brief)}
## あなたの役: 観点の検証役（観点 ${u.unit_id} だけを見る）
下の閉じた問いだけに yes か no で答える。問いの外のこと（観点の大きさ・問いの数・層・制約との矛盾・当てる資産の当否・手続きの細部の良し悪し）は判定しない（細部は枡を読んだ結果で直す）。欠陥を自由に挙げない。作った者の説明を信じず、観点の本文に書いてあることだけで答える。
答えごとに、観点の本文からの逐語の引用を quote に付ける（yes なら根拠の箇所、no なら足りない手続きの箇所）。script が照合する。
### 問い（answers に 1 つずつ返す。Q3 は goal_index に観点の goals の位置、goal_id にその要素の id を入れる）
- Q1: ${UNIT_QUESTIONS.Q1}
- Q2: ${UNIT_QUESTIONS.Q2}
${u.goals.length ? u.goals.map((g, i) => `- Q3（goal_index: ${i}, goal_id: ${goalIdOf(g)}）: ${UNIT_QUESTIONS.Q3}（部分は観点の goals[${i}].part）`).join('\n') : '- Q3: 観点に goals が無いので聞かない'}
目標・受け入れ基準の本文は束にある。手続きが何に当たるかは、下の当てた資産の索引の行（見出しの経路・種類・先頭の数語）で見る。資産の本文は読まない。
### 当てた資産の索引の行（id・写し・行の範囲・見出しの経路・種類・先頭の数語のタブ区切り）
${indexRows(u.applies_to)}
${u.text != null ? `### 本文（観点）\n${u.text}` : '観点の本文は束の「### 本文（観点）」にある。'}`, UNIT_VERDICT_SCHEMA, (r) => checkUnitVerdict(r, u.unit_id, u.goals, u.text)).then((x) => ({ unit_id: u.unit_id, key: u.key, ...x })))
  out.unit_checks = checks.map((x, i) => x || { unit_id: toVerify[i].unit_id, key: toVerify[i].key, result: null, problems: ['pipeline が null を返した'] })
  out.units_not_verified = [...units.slice(maxUnits).map((u) => u.unit_id), ...[...holdBack].filter((id) => !units.some((u) => u.unit_id === id))]
  return { ...out, status: 'ok' }
}

// ---------------- review（待ち行列から枡を取る、長く動く worker） ----------------
// worker は CLI の claim で資産と枡を取り、枡ごとに結果のファイルを書いて submit で 1 つずつ出す。照合は CLI の submit が写しの本文に対して行う。
// 読む役の worker と検証役の worker は混ぜない。検証役は、全ての回の読む役の worker が終わってから起動する（読んだ指摘が待ち行列に揃ってから取る）。
const READ_SCHEMA = {
  type: 'object',
  properties: {
    evidence: { type: 'array', items: { type: 'string' } },
    findings: { type: 'array', items: { type: 'object', properties: { claim: { type: 'string' }, quote: { type: 'string' }, severity: { type: 'string', enum: SEVERITIES }, layer: { type: 'string', enum: LAYERS } }, required: ['claim', 'quote', 'severity', 'layer'] } },
    outside_notes: { type: 'array', items: { type: 'string' } },
    none_reason: { type: 'string' },
  },
  required: ['evidence', 'findings', 'outside_notes', 'none_reason'],
}
const VERIFY_SCHEMA = { type: 'object', properties: { verdicts: { type: 'array', items: { type: 'object', properties: { index: { type: 'integer' }, verdict: { type: 'string', enum: VERDICTS }, reason: { type: 'string' }, quote: { type: 'string' } }, required: ['index', 'verdict', 'reason', 'quote'] } } }, required: ['verdicts'] }
const WORKER_SCHEMA = { type: 'object', properties: { assets: { type: 'integer' }, submitted: { type: 'integer' }, rejected: { type: 'integer' }, notes: { type: 'array', items: { type: 'string' } } }, required: ['assets', 'submitted', 'rejected', 'notes'] }
// shell の 1 語にする（' は '\'' に置き換える）。
const sq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`
async function reviewStage() {
  phase('review')
  const ws = arr(A.workers)
  // stateDir は写しの置き場（stateDir/snap/）の親。args に stateDir を 2 回載せない。
  const stateDir = String(A.snapDir || '').replace(/[\\/]+$/, '').replace(/[\\/][^\\/]*$/, '')
  const cli = `${A.skillDir}/scripts/ledger-cli.mjs`
  const prompt = (w) => {
    const verify = w.queue === 'verify'
    return `${COMMON(A.brief)}
## あなたの役: ${verify ? '検証役（反証側）' : '読む役'}の worker（id ${w.id}、${w.pass} 回目）
待ち行列から${verify ? '指摘のある枡を 1 つずつ' : 'まだ読んでいない資産を 1 つずつ'}取り、枡ごとに結果を出す。台帳を書くのは CLI だけで、あなたは下の命令を Bash で流す。
### 取る命令（この行をそのまま Bash で流す。出力は JSON）
node ${sq(cli)} claim --state ${sq(stateDir)} --call ${sq(A.callId)} --worker ${sq(w.id)}
### 手順
1. 取る命令を流す。出力が done: true なら、手順を終えて返り値を返す。
2. 出力の asset.file を、asset.start から asset.end の行の範囲だけ Read で 1 回読む（offset=asset.start, limit=asset.end - asset.start + 1。この範囲の外は読まない）。
3. 出力の cells の枡ごとに、次を順に行う。枡ごとに、その枡の束（cells[].brief。観点の名前と手続き）を Read で読み、その観点だけで判断する。
4. その枡の結果を JSON で cells[].result_path に書き（Write ツールか、shell なら \`>|\` で上書きして書く）、cells[].submit_cmd をそのまま Bash で流す。出力の ok が false なら、problems の理由を読んで直した結果を書き直し、submit_cmd を流し直す。dropped が true なら、その枡は諦めて次の枡へ進む。命令が終了状態 2 で拒否されたら、error を notes に書いて次の枡へ進む。
5. その資産の枡を全て出してから 1 に戻る（出し終える前に claim を流すと、まだ出していない同じ枡が返る）。claim が done を返すまで繰り返す。claim が、出せなかった枡（submit が終了状態 2 で拒否した枡）を返し直したら、notes に書いて終える。
前の枡の結果（読み・指摘・判定）を、次の枡に持ち込まない。枡ごとに、その枡の束と資産の本文だけから判断する。
${verify ? `### 結果の形（検証役）
cells[].findings の指摘はどれも誤りかもしれないという前提で、資産の本文に当たって確かめる。指摘ごと（index は findings の位置）に confirmed（本文が主張を支える）・refuted（本文が主張を否定する）・unverifiable（本文だけでは決められない）を返す。confirmed と refuted には、決め手になった本文の逐語の引用を quote に付ける（引用が合わない判定は unverifiable として扱われる）。
JSON Schema: ${JSON.stringify(VERIFY_SCHEMA)}` : `### 結果の形（読む役）
- 資産の範囲を手続きに沿って確かめる。asset.blocks の区画（写しの行の範囲）のそれぞれから 1 つ以上、逐語の引用を evidence に挙げる（読んだ証拠。script が区画ごとに照合する）。evidence の各要素には本文の逐語の写しだけを入れ、区画名・行番号・説明・括弧を付けない（見出しの行だけは証拠にならない）。
- 観点に当たる欠陥を、逐語の引用（quote）・重さ・原因の層（${LAYERS.join('・')}）と共に findings に返す。層は、直すべき層を選ぶ（本文の層とは限らない）。重さで絞らない。
- 観点の外で気づいたことは指摘にせず outside_notes に書く。指摘が無ければ、確かめたことを none_reason に書く。
JSON Schema: ${JSON.stringify(READ_SCHEMA)}`}
### 返り値
取った資産の数（assets）・受け付けられた枡の数（submitted）・ok が false で返された提出の数（rejected）・気づいたこと（notes。命令が流せなかった・拒否されたなど）。`
  }
  const run = (list) => parallel(list.map((w) => () => call(w.role, `worker-${w.queue}-${w.id}`, prompt(w), WORKER_SCHEMA).then((r) => ({ worker: w.id, queue: w.queue, pass: w.pass, result: r }))))
  const readers = await run(ws.filter((w) => w.queue === 'read'))
  const verifiers = await run(ws.filter((w) => w.queue === 'verify'))
  return { status: 'ok', workers: [...readers, ...verifiers].filter(Boolean) }
}

// ---------------- group（根本原因で束ね、反証する） ----------------
const GROUP_SCHEMA = {
  type: 'object',
  properties: {
    groups: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, root_cause: { type: 'string' }, layer: { type: 'string', enum: LAYERS }, keys: { type: 'array', items: { type: 'string' } }, pattern: { type: 'string' }, applies_to: { type: 'array', items: { type: 'string' } }, extends: { type: 'string' } }, required: ['id', 'root_cause', 'layer', 'keys', 'pattern', 'applies_to'] } },
    unassigned: { type: 'array', items: { type: 'string' } },
  },
  required: ['groups', 'unassigned'],
}
const REFUTE_SCHEMA = { type: 'object', properties: { group_id: { type: 'string' }, refuted: { type: 'boolean' }, reason: { type: 'string' } }, required: ['group_id', 'refuted', 'reason'] }
async function groupStage() {
  phase('group')
  const keys = groupKeys(A.count)
  const g = await checked('grouper', 'group', `${COMMON(A.brief)}
## あなたの役: 束ね役
下の写しの全件（この周に確かめた指摘。振り返りで確かめた悪かった出来事を含む。1 行 1 件の JSON で key を持つ）を根本原因で束ねる。症状でなく原因で束ね、全ての key（K1〜K${A.count}）をちょうど 1 つの群に入れる（入れられないものは unassigned）。重さで絞らない。群ごとに、直すべき層（${LAYERS.join('・')}）を選び、同じ型の欠陥を資産へ問い直すための手続き（何を列挙し、何と照らすか）を pattern に書き、その型が当たる資産を下の索引の資産の id で applies_to に全て挙げる（全件の where の資産に限らない。型にならない群は pattern を空文字、applies_to を空の配列にする）。
群が、下の「既にある横展開の観点」のどれかと同じ型（同じ根本原因で、同じ手続きで問い直せる）の例なら、extends にその観点の id を書き、pattern を空文字、applies_to を空の配列にする（その型は展開済みなので、新しい観点を作らない）。どれとも違う新しい型のときだけ extends を空文字にして pattern を書く。
### 全件
${rangeOf(A.items)}
### 対象の索引（1 行 1 資産のタブ区切り: 資産の id・写しのファイル・行の範囲・見出しの経路・種類・先頭の数語。applies_to に使う）
${A.index ? `${rangeOf(A.index)}` : '（無し）'}
### 既にある横展開の観点（1 行 1 観点の JSON: id・型の手続き pattern・根本原因 root_cause。extends に使う）
${A.lateral ? `${rangeOf(A.lateral)}` : '（無し）'}`, GROUP_SCHEMA, (r) => checkGroups(r, keys, undefined, arr(A.lateralIds)))
  if (!g.result) return { status: 'blocked', reason: '束ね役が返らなかった', problems: g.problems }
  const groups = arr(g.result.groups).slice(0, Math.floor((LIMITS.maxAgents - agents.length) / 2))
  const refPrompt = (gr) => `${COMMON(A.brief)}
## あなたの役: 反証役
下の根本原因の主張が誤りではないかを探す。記録の事実と合わない・原因でなく症状の言い換え・固定した制約の蒸し返し、のどれかなら refuted=true。確かめられなければ refuted=false とし、理由に「確かめられない」と書く。
### 群 ${gr.id}（層: ${gr.layer}）
根本原因: ${gr.root_cause}
含むもの（key）: ${arr(gr.keys).join(', ')}
### key の中身（写しの中のその key の行だけを見る）
${rangeOf(A.items)}`
  const judged = await pipeline(groups, (gr) => parallel([
    () => call('refuter_a', `refute-${gr.id}-a`, refPrompt(gr), REFUTE_SCHEMA),
    () => call('refuter_b', `refute-${gr.id}-b`, refPrompt(gr), REFUTE_SCHEMA),
  ]).then((vs) => {
    const v = vs.filter(Boolean)
    const n = v.filter((x) => x.refuted).length
    return { group: gr, votes: v, status: v.length < 2 ? 'unverified' : n === 2 ? 'refuted' : n === 1 ? 'split' : 'kept' }
  }))
  return { status: 'ok', grouping: g.result, grouping_problems: g.problems, judged: judged.filter(Boolean), not_refuted: arr(g.result.groups).slice(groups.length).map((x) => x.id) }
}

const body = A.stage === 'plan' ? await planStage() : A.stage === 'review' ? await reviewStage() : await groupStage()
return done(body)
