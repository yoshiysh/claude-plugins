export const meta = {
  name: 'coverage-build-step',
  description: '台帳の段を波で順に流す。args の最初の波の行ごとに役を 1 体起動し、役は claim・query・submit で台帳と直接読み書きする。役が返す次の波の印（CLI が台帳に記録したもの）がある間、その行で次の波を起動する。検査の役（coverage-audit の役）も同じ波に並ぶ。返すのは起動の記録と tokens だけ',
  requirements: ['fresh-thread', 'workspace-write'],
  phases: [
    { title: 'design', detail: '目標の照合役・方式設計の役・詳細設計の役のどれかが、担当を取り、入力を台帳から引き、結果を台帳に出す' },
    { title: 'tests', detail: 'テストの担当が、文脈に収まる分の code の単位のテストを実装より先に書く' },
    { title: 'implement', detail: '実装の担当が、文脈に収まる分の単位を依存の順に書く' },
    { title: 'retro', detail: '振り返りの計画役・実行役・検証役のどれかが、意図を出すか、意図を確かめるか、結論の受理を決める' },
    { title: 'audit:<段>', detail: '検査の役（coverage-audit の計画役・観点の検証役・全文レビュー・読む役・判定役・確認役）が、検査の台帳の担当を build の CLI から取り、結果を出す' },
  ],
  limits: { maxAgents: 40, concurrency: 3, timeoutMs: 7200000, agentTimeoutMs: 3600000, maxOutputBytes: 4000000 },
}

// <checks> ここから </checks> までは CLI（build-core.mjs）が同じ文を読み込んで使う。静的な照合の正本はここだけ。
// native Workflow は本体に meta を渡さないので写しを置く（一致は tests/coverage-build-workflow.test.mjs が照らす）。
// agentTimeoutMs は 1 体が文脈に収まる分の単位を続けて受け持つ（実装の担当が最も長い）ので、1 単位 1 体のときより長くする。
const LIMITS = { maxAgents: 40, concurrency: 3, timeoutMs: 7200000, agentTimeoutMs: 3600000, maxOutputBytes: 4000000 }
const QUOTE_MIN = 12
const MAX_UNIT_PATHS = 3 // 1 単位が持つファイル（成果物・テストそれぞれ）の上限。1 体に任せる量を小さくする
// 方式設計の照合（checkArch）が保証する不変条件。_architecture.md に描き、文書はこれを参照する（中身を写さない）。
const ARCH_INVARIANTS = [
  'kind は doc か code',
  `paths は 1〜${MAX_UNIT_PATHS} 件`,
  `code の単位の tests は 1〜${MAX_UNIT_PATHS} 件`,
  'doc の単位は tests と test_uses を持たない',
  '1 つのファイルは 1 つの単位だけが持つ',
  '境界の行は、使う単位ごとに扱いを 1 つずつ持つ',
]
// id の形。境界の約束 X<n>、その行 X<n>-<k>（行の位置から決める）、振る舞い U<n>S<k>、受け入れ U<n>A<k>、写し C<n>。
const ID_SHAPE = { contract: 'X\\d+', row: 'X\\d+-\\d+', behavior: 'U\\d+S\\d+', accept: 'U\\d+A\\d+', copy: 'C\\d+' }
const isId = (kind, s) => new RegExp(`^${ID_SHAPE[kind]}$`).test(String(s))
// 設計レビューへ --link で渡す、資産を結ぶ id の正規表現（境界の行・受け入れ・振る舞い）。
const LINK_PATTERN = [ID_SHAPE.row, ID_SHAPE.accept, ID_SHAPE.behavior].join('|')
// 決めきらない語。詳細設計の本文に現れたら、allowed_optional の引用で覆わない限り欠けにする。「など」「場合は」は列挙の省略と条件の書き出しに正しく現れるので入れない。
const VAGUE_WORDS = ['してよい', 'してもよい', 'しても良い', '必要に応じて', '適切に', '場合によっては', 'なるべく', '可能なら', 'できれば']
const MAX_SPEC_LINES = 80 // 1 単位の詳細設計の行数の上限。coverage-audit の 1 体が 1 回で読める大きさに収める
const AUDIT_LAYERS = ['方針', '要求', '方式設計', '詳細設計', '実装']
const LAYERS = ['目標', '設計', '実装', '進め方']
// coverage-audit の層を、戻す先の層に写す。全数は tests で照らす。
const LAYER_MAP = { 方針: '目標', 要求: '目標', 方式設計: '設計', 詳細設計: '設計', 実装: '実装' }
const VERDICTS = ['supported', 'refuted', 'unclear']
const isStr = (s) => typeof s === 'string' && s.trim().length > 0
const arr = (a) => (Array.isArray(a) ? a : [])
// 値を key の順に並べた JSON（台帳の hash に使う）。
const canon = (v) => (Array.isArray(v) ? `[${v.map(canon).join(',')}]` : v && typeof v === 'object' ? `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}` : JSON.stringify(v))
const stripNums = (s) => String(s ?? '').replace(/(^|\n)[ \t]*\d+(\| ?|\t)/g, '$1')
const norm = (s) => stripNums(s).replace(/\s+/g, ' ').trim()
// 短い引用は、本文の全体か、本文の空でない 1 行の全体を引くときだけ受け付ける。
const wholeLine = (n, text) => String(text).split('\n').some((l) => l.trim() && norm(l) === n)
function quoteProblem(q, text) {
  const n = norm(q)
  if (!n) return '引用が空'
  if (n.length < QUOTE_MIN && n !== norm(text) && !wholeLine(n, text)) return `引用が ${QUOTE_MIN} 字未満`
  if (!norm(text).includes(n)) return '引用が本文に逐語で無い'
  return null
}
const isRel = (p) => isStr(p) && !p.startsWith('/') && !p.includes('\\') && !p.split('/').some((s) => s === '..' || s === '.' || s === '')
// 依存の順（波）。循環か実在しない依存があれば null。
function waves(units) {
  const ids = new Set(units.map((u) => u.id))
  if (units.some((u) => arr(u.depends_on).some((d) => !ids.has(d) || d === u.id))) return null
  const out = []
  const done = new Set()
  while (done.size < units.length) {
    const w = units.filter((u) => !done.has(u.id) && arr(u.depends_on).every((d) => done.has(d))).map((u) => u.id)
    if (!w.length) return null
    w.forEach((id) => done.add(id))
    out.push(w)
  }
  return out
}
// 方式設計の形: 単位の id・種類・持つファイルの重なり・依存の循環・基準と制約の受け皿・入力を読んだかの申告。
function checkArch(a, ctx) {
  if (!a || typeof a !== 'object') return ['返り値が無い']
  const p = []
  const units = arr(a.units)
  if (!units.length) p.push('単位が 0 件')
  const ids = new Set()
  const owned = new Map()
  for (const u of units) {
    if (!/^U[1-9]\d*$/.test(String(u && u.id))) { p.push(`単位の id が U<数> でない: ${u && u.id}`); continue }
    if (ids.has(u.id)) p.push(`単位の id の重複: ${u.id}`)
    ids.add(u.id)
    if (!['doc', 'code'].includes(u.kind)) p.push(`${u.id}: kind は doc か code`)
    if (!isStr(u.title) || !isStr(u.responsibility)) p.push(`${u.id}: title か responsibility が空`)
    const ps = arr(u.paths)
    const ts = arr(u.tests)
    if (!ps.length || ps.length > MAX_UNIT_PATHS) p.push(`${u.id}: paths は 1〜${MAX_UNIT_PATHS} 件`)
    if (u.kind === 'code' && (!ts.length || ts.length > MAX_UNIT_PATHS)) p.push(`${u.id}: code の単位の tests は 1〜${MAX_UNIT_PATHS} 件（テストは別の担当が先に書く）`)
    if (u.kind === 'doc' && ts.length) p.push(`${u.id}: doc の単位は tests を持たない`)
    for (const f of [...ps, ...ts]) {
      if (!isRel(f)) p.push(`${u.id}: repo からの相対 path でない: ${f}`)
      else if (owned.has(f)) p.push(`${f} を ${owned.get(f)} と ${u.id} の 2 つが持つ`)
      else owned.set(f, u.id)
    }
    if (!arr(u.covers).length) p.push(`${u.id}: covers が空（どの基準・制約に効くかが無い）`)
    for (const c of arr(u.covers)) if (!ctx.coverIds.includes(c)) p.push(`${u.id}: 実在しない基準・制約: ${c}`)
  }
  if (units.length && !p.length && !waves(units)) p.push('depends_on に循環か実在しない単位がある')
  // 依存の閉包（depends_on を辿って届く単位。自分は含めない）。
  const byId = new Map(units.filter((u) => u && ids.has(u.id)).map((u) => [u.id, u]))
  const closure = (id) => {
    const out = new Set()
    const stack = [...arr(byId.get(id) && byId.get(id).depends_on)]
    while (stack.length) { const d = stack.pop(); if (out.has(d) || !byId.has(d)) continue; out.add(d); stack.push(...arr(byId.get(d).depends_on)) }
    out.delete(id)
    return out
  }
  // テストの前提（test_uses）: 他の単位のファイルを前提にするなら、その単位が依存の閉包にあること。doc の単位は持たない。
  const testUses = new Set()
  for (const u of byId.values()) {
    if (!Array.isArray(u.test_uses)) { p.push(`${u.id}: test_uses が配列でない`); continue }
    if (u.kind === 'doc' && u.test_uses.length) p.push(`${u.id}: doc の単位は test_uses を持たない`)
    const cl = closure(u.id)
    for (const f of u.test_uses) {
      testUses.add(f)
      const o = owned.get(f)
      if (o && o !== u.id && !cl.has(o)) p.push(`${u.id}: test_uses の ${f} は ${o} が持つが、${o} が依存の閉包に無い（逆向きの依存）`)
    }
  }
  // 境界の約束（contracts）: 作る側の値 × 使う単位ごとの扱いの決定表。
  if (!Array.isArray(a.contracts)) p.push('contracts が配列でない')
  else {
    const xids = new Set()
    for (const c of a.contracts) {
      const cid = c && c.id
      if (!isId('contract', cid)) p.push(`境界の約束の id が X<数> でない: ${cid}`)
      else if (xids.has(cid)) p.push(`境界の約束の id の重複: ${cid}`)
      xids.add(cid)
      if (!c || typeof c !== 'object') continue
      if (!isStr(c.subject)) p.push(`${cid}: subject が空`)
      if (!byId.has(c.producer)) p.push(`${cid}: producer が実在しない単位: ${c.producer}`)
      const cons = Array.isArray(c.consumers) ? c.consumers : []
      if (!cons.length) p.push(`${cid}: consumers が空`)
      if (new Set(cons).size !== cons.length) p.push(`${cid}: consumers に重複がある`)
      for (const u of cons) {
        if (!byId.has(u)) p.push(`${cid}: consumers に実在しない単位: ${u}`)
        else if (u === c.producer) p.push(`${cid}: consumers が producer を含む`)
        else if (byId.has(c.producer) && !closure(u).has(c.producer)) p.push(`${cid}: ${u} の依存の閉包に producer ${c.producer} が無い`)
      }
      const rows = Array.isArray(c.rows) ? c.rows : []
      if (!rows.length) p.push(`${cid}: rows が空`)
      const values = new Set()
      rows.forEach((r, i) => {
        const rid = `${cid}-${i + 1}`
        if (!r || typeof r !== 'object') { p.push(`${rid}: 行が object でない`); return }
        if (!isStr(r.value) || !isStr(r.producer_does)) p.push(`${rid}: value か producer_does が空`)
        else if (values.has(norm(r.value))) p.push(`${rid}: 同じ約束の中で value が重複: ${r.value}`)
        if (isStr(r.value)) values.add(norm(r.value))
        if (!Array.isArray(r.handling)) { p.push(`${rid}: handling が配列でない`); return }
        const hs = r.handling.map((h) => h && h.unit)
        for (const u of cons) if (hs.filter((x) => x === u).length !== 1) p.push(`${rid}: 使う単位 ${u} の扱いがちょうど 1 つでない`)
        for (const u of new Set(hs)) if (!cons.includes(u)) p.push(`${rid}: 使う単位でない ${u} の扱いがある`)
        for (const h of r.handling) if (!isStr(h && h.does)) p.push(`${rid}: ${h && h.unit} の扱い（does）が空`)
      })
    }
  }
  // 正本と写し（copies）: 一致を照らすテストは、どれかの単位の tests か test_uses にあること。
  if (!Array.isArray(a.copies)) p.push('copies が配列でない')
  else {
    const tests = new Set([...byId.values()].flatMap((u) => arr(u.tests)))
    const cids = new Set()
    for (const c of a.copies) {
      const cid = c && c.id
      if (!isId('copy', cid)) p.push(`写しの id が C<数> でない: ${cid}`)
      else if (cids.has(cid)) p.push(`写しの id の重複: ${cid}`)
      cids.add(cid)
      if (!c || typeof c !== 'object') continue
      if (!isStr(c.rule)) p.push(`${cid}: rule が空`)
      const cps = Array.isArray(c.copies) ? c.copies : []
      for (const f of [c.canonical, ...cps, c.check]) if (!isRel(f)) p.push(`${cid}: repo からの相対 path でない: ${f}`)
      if (!cps.length) p.push(`${cid}: copies が空`)
      if (cps.includes(c.canonical)) p.push(`${cid}: copies が canonical を含む`)
      if (isRel(c.check) && !tests.has(c.check) && !testUses.has(c.check)) p.push(`${cid}: 一致を照らすテスト ${c.check} が、どの単位の tests にも test_uses にも無い`)
    }
  }
  for (const c of ctx.coverIds) if (!units.some((u) => arr(u.covers).includes(c))) p.push(`基準・制約 ${c} の受け皿の単位が無い`)
  const seen = new Map()
  for (const r of arr(a.inputs_read)) { seen.set(r.path, (seen.get(r.path) || 0) + 1); if (!arr(r.quotes).length) p.push(`入力 ${r.path} を読んだ証拠の引用が無い`) }
  for (const r of arr(a.inputs_not_read)) { seen.set(r.path, (seen.get(r.path) || 0) + 1); if (!isStr(r.reason)) p.push(`入力 ${r.path} を読まない理由が空`) }
  for (const [k, n] of seen) if (!ctx.inputs.includes(k)) p.push(`入力に無い path: ${k}`); else if (n > 1) p.push(`入力 ${k} が 2 回以上ある`)
  for (const f of ctx.inputs) if (!seen.has(f)) p.push(`入力 ${f} を読んだか読まないかの申告が無い`)
  const qids = new Set()
  for (const q of arr(a.questions)) { if (!isStr(q.id) || qids.has(q.id)) p.push(`質問の id が空か重複: ${q.id}`); qids.add(q.id); if (!isStr(q.why_value_judgment)) p.push(`質問 ${q.id} に価値判断の理由が無い`) }
  return p
}
// 詳細設計の形: 振る舞い（behaviors）と受け入れ・ケース・境界の行の結び、分け方（partitions）、前提（premises・unverified）、決めきらない語。
// ctx は { rowIds, readable }。rowIds はその単位が producer か consumer の境界の行 id（無ければ空）。readable を渡したときだけ premises の path を照らす。
function checkSpec(rep, unit, ctx = {}) {
  if (!rep || typeof rep !== 'object') return ['返り値が無い']
  const p = []
  const rowIds = arr(ctx && ctx.rowIds)
  const readable = ctx && Array.isArray(ctx.readable) ? ctx.readable : null
  if (rep.unit_id !== unit.id) p.push(`unit_id が違う: ${rep.unit_id}`)
  if (!isStr(rep.spec)) p.push('spec が空')
  else if (String(rep.spec).split('\n').length > MAX_SPEC_LINES) p.push(`spec が ${MAX_SPEC_LINES} 行を超える（単位を分けるのは方式設計の仕事。ここでは詰める）`)
  const acc = arr(rep.acceptance)
  if (!acc.length || acc.some((x) => !isStr(x))) p.push('acceptance が空か空の行を含む')
  for (const k of ['behaviors', 'partitions', 'premises', 'unverified', 'allowed_optional']) if (!Array.isArray(rep[k])) p.push(`${k} が配列でない`)
  const cases = arr(rep.cases)
  if (unit.kind === 'code' && !cases.length) p.push('code の単位なのに cases が空（テストの担当が書くケース）')
  // 受け入れの位置（1 から）を指す整数の配列か。
  const badAccepts = (a) => !Array.isArray(a) || !a.length || a.some((n) => !Number.isInteger(n) || n < 1 || n > acc.length)
  const behaviors = arr(rep.behaviors)
  if (Array.isArray(rep.behaviors) && !behaviors.length) p.push('behaviors が空')
  behaviors.forEach((b, i) => {
    const sid = `${unit.id}S${i + 1}`
    if (!b || typeof b !== 'object') { p.push(`${sid}: 振る舞いが object でない`); return }
    if (!isStr(b.text)) p.push(`${sid}: text が空`)
    if (badAccepts(b.accepts)) p.push(`${sid}: accepts が空か、受け入れの位置（1〜${acc.length}）に無い値を含む`)
    if (!Array.isArray(b.rows)) p.push(`${sid}: rows が配列でない`)
    for (const r of arr(b.rows)) if (!rowIds.includes(r)) p.push(`${sid}: 境界の行 ${r} はこの単位の行に無い`)
  })
  for (const r of rowIds) if (!behaviors.some((b) => arr(b && b.rows).includes(r))) p.push(`境界の行 ${r} を受ける振る舞いが無い`)
  acc.forEach((_, i) => { if (!behaviors.some((b) => arr(b && b.accepts).includes(i + 1))) p.push(`受け入れ ${unit.id}A${i + 1} がどの振る舞いの accepts にも無い`) })
  cases.forEach((c, i) => {
    const cid = `${unit.id}C${i + 1}`
    if (!isStr(c && c.condition) || !isStr(c && c.expect)) p.push(`${cid}: condition か expect が空`)
    if (badAccepts(c && c.accepts)) p.push(`${cid}: accepts が空か、受け入れの位置（1〜${acc.length}）に無い値を含む`)
    if (!Array.isArray(c && c.covers)) p.push(`${cid}: covers が配列でない`)
  })
  if (unit.kind === 'code') acc.forEach((_, i) => { if (!cases.some((c) => arr(c && c.accepts).includes(i + 1))) p.push(`受け入れ ${unit.id}A${i + 1} がどのケースの accepts にも無い`) })
  // 分け方: 値はケースの covers（<name>=<value>）で全て覆う。
  const parts = new Map()
  arr(rep.partitions).forEach((pt, i) => {
    const name = pt && pt.name
    if (!isStr(name)) { p.push(`partitions[${i}]: name が空`); return }
    if (parts.has(name)) p.push(`partitions の name が重複: ${name}`)
    const vs = Array.isArray(pt.values) ? pt.values : null
    if (!vs || vs.length < 2 || vs.some((v) => !isStr(v))) p.push(`partitions の ${name}: values が 2 件未満か空の値を含む`)
    parts.set(name, new Set(arr(vs)))
  })
  const covered = new Set()
  for (const c of cases) for (const cv of arr(c && c.covers)) {
    const k = String(cv).indexOf('=')
    const name = k < 0 ? null : String(cv).slice(0, k)
    if (name == null || !parts.has(name) || !parts.get(name).has(String(cv).slice(k + 1))) p.push(`ケースの covers が partitions に無い: ${cv}`)
    else covered.add(cv)
  }
  for (const [name, vs] of parts) for (const v of vs) if (!covered.has(`${name}=${v}`)) p.push(`分け方の値 ${name}=${v} をどのケースも覆わない`)
  arr(rep.premises).forEach((x, i) => {
    if (!isStr(x && x.claim) || !isStr(x && x.path) || !isStr(x && x.quote)) p.push(`premises[${i}]: claim・path・quote のどれかが空`)
    else if (readable && !readable.includes(x.path)) p.push(`premises[${i}]: 読める path に無い: ${x.path}`)
  })
  arr(rep.unverified).forEach((x, i) => { if (!isStr(x && x.claim) || !isStr(x && x.if_broken)) p.push(`unverified[${i}]: claim か if_broken が空`) })
  // 決めきらない語: 照らす本文の出現ごとに、その位置を含む allowed_optional の引用があるか。
  const texts = [rep.spec, ...acc, ...behaviors.map((b) => b && b.text), ...cases.flatMap((c) => [c && c.condition, c && c.expect])].filter(isStr).map(norm)
  const quotes = []
  arr(rep.allowed_optional).forEach((o, i) => {
    const q = norm(o && o.quote)
    if (!q) { p.push(`allowed_optional[${i}]: quote が空`); return }
    if (!isStr(o.why)) p.push(`allowed_optional[${i}]: why が空`)
    if (!VAGUE_WORDS.some((w) => q.includes(w))) p.push(`allowed_optional[${i}]: 引用が決めきらない語を含まない`)
    if (!texts.some((t) => t.includes(q))) p.push(`allowed_optional[${i}]: 引用が本文に逐語で無い`)
    quotes.push(q)
  })
  const spans = (t, s) => { const out = []; for (let k = t.indexOf(s); k >= 0; k = t.indexOf(s, k + 1)) out.push(k); return out }
  for (const t of texts) for (const w of VAGUE_WORDS) for (const at of spans(t, w)) {
    if (!quotes.some((q) => spans(t, q).some((k) => k <= at && at + w.length <= k + q.length))) p.push(`決めきらない語「${w}」が allowed_optional に無い箇所にある: ${t.slice(Math.max(0, at - 12), at + w.length + 12)}`)
  }
  return p
}
// 振り返りの意図の形と根拠。known は根拠に使える id の Set（CLI が台帳の due の出来事・事実・群の id から作る）。
function checkIntents(rep, known) {
  if (!rep || typeof rep !== 'object') return ['返り値が無い']
  const p = []
  const has = (b) => known instanceof Set && known.has(b)
  arr(rep.intents).forEach((it, i) => {
    if (!arr(it && it.basis).length) p.push(`intents[${i}]: basis が空`)
    for (const b of arr(it && it.basis)) if (!has(b)) p.push(`intents[${i}]: 実在しない事実: ${b}`)
    if (!isStr(it && it.hypothesis)) p.push(`intents[${i}]: hypothesis が空`)
    if (!LAYERS.includes(it && it.layer)) p.push(`intents[${i}]: layer が不正`)
    if (!arr(it && it.look_at).length) p.push(`intents[${i}]: look_at が空`)
  })
  return p
}
function checkExam(rep) {
  if (!rep || typeof rep !== 'object') return ['返り値が無い']
  const p = []
  if (!VERDICTS.includes(rep.verdict)) p.push('verdict が不正')
  if (rep.verdict === 'supported') {
    if (!isStr(rep.cause)) p.push('cause が空')
    if (!LAYERS.includes(rep.layer)) p.push('layer が不正')
    if (!arr(rep.evidence).length) p.push('支持したのに evidence が空')
    arr(rep.evidence).forEach((e, i) => { if (!isStr(e && e.path) || !isStr(e && e.quote)) p.push(`evidence[${i}]: path か quote が空`) })
  }
  return p
}
const checkJudge = (rep) => (!rep || typeof rep.accept !== 'boolean' || !isStr(rep.reason) ? ['accept か reason が無い'] : [])
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
// 役の結果（担当の result_path に書く JSON）の形。役の prompt に載せ、CLI の submit が照合の式（check*）の前に形を照らす。
const GOAL_SCHEMA = { type: 'object', properties: { outcomes: { type: 'array', items: { type: 'object', properties: { outcome: { type: 'string' }, quotes: { type: 'array', items: { type: 'object', properties: { source: { type: 'string', enum: ['request', 'decisions'] }, quote: { type: 'string' } }, required: ['source', 'quote'] } }, items: { type: 'array', items: { type: 'string' } } }, required: ['outcome', 'quotes', 'items'] } } }, required: ['outcomes'] }
const ARCH_SCHEMA = {
  type: 'object',
  properties: {
    units: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, kind: { type: 'string', enum: ['doc', 'code'] }, title: { type: 'string' }, responsibility: { type: 'string' }, paths: { type: 'array', items: { type: 'string' } }, tests: { type: 'array', items: { type: 'string' } }, test_uses: { type: 'array', items: { type: 'string' } }, depends_on: { type: 'array', items: { type: 'string' } }, covers: { type: 'array', items: { type: 'string' } } }, required: ['id', 'kind', 'title', 'responsibility', 'paths', 'tests', 'test_uses', 'depends_on', 'covers'] } },
    inputs_read: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, quotes: { type: 'array', items: { type: 'string' } } }, required: ['path', 'quotes'] } },
    inputs_not_read: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, reason: { type: 'string' } }, required: ['path', 'reason'] } },
    questions: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, question: { type: 'string' }, why_value_judgment: { type: 'string' }, options: { type: 'array', items: { type: 'string' } } }, required: ['id', 'question', 'why_value_judgment', 'options'] } },
    contracts: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, subject: { type: 'string' }, producer: { type: 'string' }, consumers: { type: 'array', items: { type: 'string' } }, rows: { type: 'array', items: { type: 'object', properties: { value: { type: 'string' }, producer_does: { type: 'string' }, handling: { type: 'array', items: { type: 'object', properties: { unit: { type: 'string' }, does: { type: 'string' } }, required: ['unit', 'does'] } } }, required: ['value', 'producer_does', 'handling'] } } }, required: ['id', 'subject', 'producer', 'consumers', 'rows'] } },
    copies: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, rule: { type: 'string' }, canonical: { type: 'string' }, copies: { type: 'array', items: { type: 'string' } }, check: { type: 'string' } }, required: ['id', 'rule', 'canonical', 'copies', 'check'] } },
  },
  required: ['units', 'inputs_read', 'inputs_not_read', 'questions', 'contracts', 'copies'],
}
const SPEC_SCHEMA = {
  type: 'object',
  properties: {
    unit_id: { type: 'string' },
    spec: { type: 'string' },
    acceptance: { type: 'array', items: { type: 'string' } },
    behaviors: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' }, accepts: { type: 'array', items: { type: 'integer' } }, rows: { type: 'array', items: { type: 'string' } } }, required: ['text', 'accepts', 'rows'] } },
    partitions: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, values: { type: 'array', items: { type: 'string' } } }, required: ['name', 'values'] } },
    cases: { type: 'array', items: { type: 'object', properties: { condition: { type: 'string' }, expect: { type: 'string' }, accepts: { type: 'array', items: { type: 'integer' } }, covers: { type: 'array', items: { type: 'string' } } }, required: ['condition', 'expect', 'accepts', 'covers'] } },
    premises: { type: 'array', items: { type: 'object', properties: { claim: { type: 'string' }, path: { type: 'string' }, quote: { type: 'string' } }, required: ['claim', 'path', 'quote'] } },
    unverified: { type: 'array', items: { type: 'object', properties: { claim: { type: 'string' }, if_broken: { type: 'string' } }, required: ['claim', 'if_broken'] } },
    allowed_optional: { type: 'array', items: { type: 'object', properties: { quote: { type: 'string' }, why: { type: 'string' } }, required: ['quote', 'why'] } },
  },
  required: ['unit_id', 'spec', 'acceptance', 'behaviors', 'partitions', 'cases', 'premises', 'unverified', 'allowed_optional'],
}
const INTENTS_SCHEMA = { type: 'object', properties: { intents: { type: 'array', items: { type: 'object', properties: { basis: { type: 'array', items: { type: 'string' } }, hypothesis: { type: 'string' }, layer: { type: 'string', enum: LAYERS }, look_at: { type: 'array', items: { type: 'string' } } }, required: ['basis', 'hypothesis', 'layer', 'look_at'] } } }, required: ['intents'] }
const EXAM_SCHEMA = { type: 'object', properties: { verdict: { type: 'string', enum: VERDICTS }, cause: { type: 'string' }, layer: { type: 'string', enum: LAYERS }, evidence: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, quote: { type: 'string' } }, required: ['path', 'quote'] } } }, required: ['verdict', 'cause', 'layer', 'evidence'] }
const JUDGE_SCHEMA = { type: 'object', properties: { accept: { type: 'boolean' }, reason: { type: 'string' } }, required: ['accept', 'reason'] }
const WRITE_SCHEMA = { type: 'object', properties: { unit_id: { type: 'string' }, written: { type: 'array', items: { type: 'string' } }, notes: { type: 'string' }, unresolved: { type: 'array', items: { type: 'string' } } }, required: ['unit_id', 'written', 'notes', 'unresolved'] }
// 結果が schema の形（type・required・enum）に合わないところ。合わない結果は照合の式に渡さずに拒む（欠けた欄で台帳の描画が落ちないため）。
function shapeProblems(v, s, at = '結果') {
  if (!s) return []
  if (s.enum && !s.enum.includes(v)) return [`${at} が ${s.enum.join('・')} のどれでもない: ${JSON.stringify(v)}`]
  if (s.type === 'object') {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return [`${at} が object でない`]
    const p = arr(s.required).filter((k) => !Object.hasOwn(v, k)).map((k) => `${at}.${k} が無い`)
    for (const [k, sub] of Object.entries(s.properties || {})) if (Object.hasOwn(v, k)) p.push(...shapeProblems(v[k], sub, `${at}.${k}`))
    return p
  }
  if (s.type === 'array') return Array.isArray(v) ? v.flatMap((x, i) => shapeProblems(x, s.items, `${at}[${i}]`)) : [`${at} が配列でない`]
  if (s.type === 'string') return typeof v === 'string' ? [] : [`${at} が文字列でない`]
  if (s.type === 'integer') return Number.isInteger(v) ? [] : [`${at} が整数でない`]
  if (s.type === 'boolean') return typeof v === 'boolean' ? [] : [`${at} が真偽値でない`]
  return []
}
// 役ごとの結果の形（役の名前は roles.json の key）。
const RESULT_SCHEMAS = { goal_checker: GOAL_SCHEMA, architect: ARCH_SCHEMA, unit_designer: SPEC_SCHEMA, test_writer: WRITE_SCHEMA, implementer: WRITE_SCHEMA, retro_planner: INTENTS_SCHEMA, retro_examiner: EXAM_SCHEMA, retro_verifier: JUDGE_SCHEMA }
// </checks>

// ---------------- 起動（B1〜B4） ----------------
// args は {state, callId, wave} だけ（wave は最初の波 {id, rows}。行は {id, role, model, effort, stage}）。script は波の行ごとに役を 1 体起動し、
// 役の prompt には担当を取る命令（行の --wave・--model・--effort・--stage を埋める）と手順・役の指示・結果の形だけを置く。
// build の役の行の stage は design・tests・implement・retro。検査の役（coverage-audit の役）の行の stage は `audit:<coverage-audit の段>` で、
// 検査の役の claim・query・submit の口も同じ build-cli.mjs（CLI が coverage-audit の関数を同じ process で流す）。
// 入力（目標・依頼文・本文・前の役の出力）は prompt に載せず、役が claim と query で台帳から引く。出力は役が submit で台帳に書く。
// 波の役が尽きると、CLI が台帳に記録した次の波の印（next_wave_id と rows）か止まる印（halt）を claim が返し、役はそれをそのまま返り値で返す。
// script は、返ってきた中で最大の next_wave_id の行で次の波を起動する。halt があれば起動しない。印は制御の印で、内容を運ばない。
// 印を書き換えても、CLI が claim で台帳の記録に照らして拒むので、空の起動か早い停止になるだけ。行の数と時間の区切りは CLI が決める（script は時刻を読まず、行を切り詰めない）。
// script は役の出力を受け取らず、照合・やり直し・役の選択をしない（B5）。返すのは起動の記録（agents）と tokens だけ（B3）。
const A = typeof args === 'string' ? JSON.parse(args) : args
const agents = []
// 消費量は、本体の始めと返す直前の 2 回の budget.spent() の読みの差。どちらかが数でなければ null。
const spentNow = () => { const v = typeof budget !== 'undefined' && budget && typeof budget.spent === 'function' ? budget.spent() : null; return typeof v === 'number' && Number.isFinite(v) ? v : null }
const spentStart = spentNow()
const tokens = () => { const end = spentNow(); return spentStart === null || end === null ? null : end - spentStart }

// shell の 1 語にする（' は '\'' に置き換える）。
const sq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`
// CLI の入口。args で CLI の置き場を運ばないので、CLI が init・next のたびに stateDir に書く入口（本物の CLI を流すだけ）を使う。
// 2 回目からの提出と query は、claim が返す submit_cmd（本物の CLI の絶対パス）から作る。
const cliOf = (state) => `${String(state).replace(/[\\/]+$/, '')}/build-cli.mjs`
// build の役の段と、検査の役の段の印（行の stage の頭）。
const BUILD_STAGES = ['design', 'tests', 'implement', 'retro']
const AUDIT_STAGE = 'audit:'
const auditStageOf = (st) => (typeof st === 'string' && st.startsWith(AUDIT_STAGE) ? st.slice(AUDIT_STAGE.length) : null)
const claimLine = (w, waveId) => `node ${sq(cliOf(A.state))} claim --state ${sq(A.state)} --call ${sq(A.callId)} --worker ${sq(w.id)} --wave ${sq(waveId)} --model ${sq(w.model)} --effort ${sq(w.effort)} --stage ${sq(w.stage)}`
const RETURN_RULE = `### 返り値
気づいたこと（notes。命令が流せなかった・拒まれた・諦めた担当など）と、最後の claim の done の出力にある制御の印だけ。
- 出力に next_wave があれば、next_wave_id に next_wave.id を、rows に next_wave.rows を、書き換えずにそのまま入れる。
- 出力の halt が true なら、halt に true を入れる（reason は notes に写してよい）。
内容は返り値に書かない。`

const COMMON = `
## 共通の前提
- 目的: 作る・直す作業を「目標の固定 → 設計 → 設計レビュー → 実装 → 実装レビュー」の段で回し、見落としを構造で減らす。あなたはその中の 1 つの役で、取った担当の外を書かない・決め直さない。
- 台帳を書くのは CLI だけ。あなたの入力は claim と query の出力と、そこが指す path のファイルにある。出力は結果の JSON を担当の result_path に書いて submit で出す。返り値で内容を返さない。
- 読めなかったもの・決められないものは推測で埋めない。CLI の出力に無いことを前提にしない。
- 自分で検証の agent を起こさない。検証は別の段が行う。
`
const loop = (w, waveId) => `
### 担当を取る命令（この行をそのまま Bash で流す。出力は JSON）
${claimLine(w, waveId)}
### 手順
1. 取る命令を流す。出力が done: true なら、手順を終えて返り値を返す（下の「返り値」）。命令が終了状態 2 で拒まれたら（呼び出しが閉じた・波の記録と合わないなど）、error を notes に書いて終える。
2. 出力の tasks の担当ごとに、入力を query で引く。命令は、claim の出力の submit_cmd の submit を query に替え、末尾に --task <担当の id> を足したもの。出力の inputs が担当の入力で、そこにある path のファイルを Read で読む。
3. 下の「あなたの役」に従って判断し（書く役は受け持ちのファイルを書き）、結果の JSON を担当の result_path に Write ツールで書く。
4. 担当の result_path に書けたら、その都度 submit_cmd をそのまま Bash で流す。出力の results は出した担当ごとの判定、missing はまだ結果のファイルが無い担当。
   ok が false の担当だけ、problems の理由を読んで直した結果を result_path に書き直し、同じ submit_cmd を流し直す（落ちた担当のファイルは CLI が消す）。dropped が true の担当は諦める。
5. 1 に戻る。claim が done を返すまで繰り返す。出し終えていない担当があると、claim は同じ担当を返す。依存の順で後に回した担当は、前の担当が受理された後の claim で渡る。
前の担当の判断を次の担当に持ち込まない。担当ごとに、その担当の入力だけから判断する。
${RETURN_RULE}`

// ---------------- build の役ごとの指示 ----------------
// 照合の規則の文（CITE_RULE・VAGUE_WORDS・MAX_SPEC_LINES・LAYERS）は <checks> 区間の値から作る。写しを書かない。
const READ_ONLY = '- repo のファイルを書かない・消さない。書いてよいのは担当の result_path だけ。'
const BUILD_GUIDES = {
  goal_checker: `## あなたの役: 目標の照合役
query の inputs の依頼文（request）と利用者の決定の記録（decisions）から、利用者が求めている成果を全て挙げる（件数は決めない。同じ成果を重ねない）。成果ごとに、根拠の逐語の引用（quotes。source は依頼文なら request、決定の記録なら decisions）と、その成果を受け止めている目標・受け入れ基準・制約の項目の id（items。inputs の item_ids から選ぶ）を返す。受け止めている項目が無ければ items を空にする。
項目が依頼に無いものを足したか・範囲を狭めたか・手順かは判定しない（項目ごとの引用は init が照らし済み）。
${CITE_RULE}
${READ_ONLY}`,
  architect: `## あなたの役: 方式設計の役
目標を、1 体が 1 回で設計・実装・検査できる大きさの単位に分ける。単位の数・例・型枠は与えない。query の inputs の目標・基準・制約と、input_paths の入力の中身から切る。前の方式設計（previous）があれば読み、戻ってきた原因（causes）を除くように切り直す。
- 単位ごとに、持つファイル（paths。repo からの相対 path）、code の単位ならテストのファイル（tests。実装とは別の担当が先に書く）、依存（depends_on）、効く基準・制約の id（covers。inputs の cover_ids から選ぶ）を決める。1 つのファイルは 1 つの単位だけが持つ。
- 単位をまたぐ値は、約束ごとに contracts に挙げる（id は X<数>）。作る単位（producer）と使う単位（consumers。producer に depends_on で依存する）を決め、作る側が返しうる全ての値（正常・失敗・空・上限に達したとき・呼び直しで前の呼び出しが残したもの）を 1 行ずつ rows にし、行ごとに使う単位ごとの扱い（handling）を書く。片側だけの約束は、使う側の扱いが単位ごとにぶれるため。
- copies は、同じ規則・約束の文を 2 つ以上のファイルに置くときだけ挙げ、正本（canonical）・写し・一致を照らすテスト（check）を決める。参照で済むなら写しを置かない。一致を照らす手段の無い写しは食い違うため。
- 単位ごとに、そのテストが前提にする自分の paths・tests の外のファイルを test_uses に挙げる。変更で落ちうる既存のテストは、それを tests か test_uses に持つ単位（持ち主）を決める。持ち主の無いテストは誰も直さないため。
- 書く粒度は単位・責務・境界まで。関数名・内部の印・prompt の文面は詳細設計に任せる。
- 全ての基準と制約に受け皿の単位を付ける。
- input_paths の入力は全て、読んだなら逐語の引用（inputs_read）、読まないなら理由（inputs_not_read）を返す。引用は CLI が照らす。
- 利用者への質問（questions）は、価値判断が要り、基準・制約で答えが出ていないものだけ。
${READ_ONLY}`,
  unit_designer: `## あなたの役: 詳細設計の役（担当ごとに単位 1 つ）
query の inputs の unit（方式設計が決めた受け持ちの単位）と architecture（方式設計の写し）を読み、受け持ちの単位の振る舞い・入出力・境界の条件を spec に書く（${MAX_SPEC_LINES} 行まで）。前の詳細設計（previous）と戻ってきた原因（causes）があれば、原因を除くように設計し直す。受け入れの条件（acceptance）は外から確かめられる文で 1 行 1 件。code の単位なら、テストの担当が書くケース（cases: 条件と期待）を、条件ごとに漏れなく挙げる。ケースの期待値は実装から取らず、基準と spec から決める。受け持ちの外の単位は決め直さない。
- behaviors: 振る舞いを 1 件ずつ挙げ、確かめる受け入れの位置（accepts。acceptance の 1 から数えた位置）と、受ける境界の行 id（rows。inputs の rows の X<n>-<行の位置>）を付ける。受け持ちの単位が作るか使う境界の行は、全てどれかの振る舞いで受ける。spec の文だけの振る舞いは受け入れから落ちるため。
- partitions と cases: 件数の 0・1・上限ちょうど・上限 + 1、未設定、mode や引数の組を分け方（partitions）に挙げ、ケースの covers（<name>=<value>）で全ての値を覆う。ケースには確かめる受け入れの位置（accepts）を付ける。期待は、比べる対象を持つ観測できる文にする。
- premises と unverified: 既存のファイルや外の部品の振る舞いを前提にするときは、入力の逐語の引用（premises: 主張・path・引用）で書く。確かめていない前提は、崩れたときの扱いと共に unverified に書く。「要らない」と判断した入力に頼る前提も同じ。
- premises の path は、inputs の premise_paths の一覧の path をそのまま書く。CLI はこの一覧と文字列で照らすので、同じファイルでも別の path（repo の相対 path と入力の写しの絶対 path など）では落ちる。
- 一覧に無いファイルや外の部品の振る舞いを前提にするときは、premises に書かず unverified に、崩れたときの扱いと共に書く。premises に書くと submit が詳細設計ごと拒む。
- 決めきらない語（${VAGUE_WORDS.map((w) => `「${w}」`).join('')}）で選択を実装の担当に残さない。役の権限を定めるときだけ、その箇所の逐語の引用と理由を allowed_optional に挙げる。
${READ_ONLY}`,
  test_writer: `## あなたの役: テストの担当（担当ごとに単位 1 つ）
query の inputs の design（単位の設計の写し）のケースを全て、実装より先にテストとして書く。期待値は設計と基準から決め、実装を見て合わせない。まだ実装が無いので、テストが落ちるのは正しい。同じ呼び出しで取った単位のテストは、fixture を共有してよい（共有するファイルは、同じ呼び出しのどれかの担当の inputs.paths の中に置く）。
- 書いてよいのは inputs の paths（repo からの相対。repo は inputs の repo）だけ。他のファイルは書かない・消さない。
- 書いた path を written に、果たせなかったことを unresolved に返す。written にはその担当の inputs.paths だけを書く（共有のファイルは、それを paths に持つ担当の written に書く）。`,
  implementer: `## あなたの役: 実装の担当（担当ごとに単位 1 つ）
query の inputs の design（単位の設計の写し）に沿って受け持ちのファイルを書く。inputs の tests（別の担当が先に書いたテスト）は読むだけで変えない（CLI が変更を照らす）。依存する単位（depends）は読むだけ。前の回の欠陥と原因（causes）があれば、指摘の箇所だけを繕わず、原因を除くように受け持ち全体を設計に合わせて作り直す。
- 書いてよいのは inputs の paths（repo からの相対。repo は inputs の repo）だけ。他のファイルは書かない・消さない。
- 書いた path を written に、果たせなかったことを unresolved に返す。`,
  retro_planner: `## あなたの役: 振り返りの計画役
query の inputs の悪かった出来事（events。群ごとの見出しは groups）と、受理済みの原因（facts）と、この振り返りで試した意図（tried）を読み、「原因はこれか」という意図を返す。意図ごとに、根拠にした事実の id（basis。出来事・事実・群の id）、仮説（hypothesis）、原因と考える層（${LAYERS.join('・')}）、確かめるのに読むファイル（look_at。inputs の readable から選ぶ）を付ける。群の id を根拠にすると、その群の全ての出来事を辿る。
- 前提が満たされ、互いに重ならない意図を全て出す。件数は決めない。
- 受理済みの原因から、さらに上流の原因（その原因の原因）を問う意図も出してよい。層は目標 → 設計 → 実装 の順に上流。進め方はこのスキルの段の構成・役・検査の欠け。
- 既に退けられた意図（tried の status が rejected・refuted）を同じ根拠で繰り返さない。status が undecided の意図は、試行の上限で判定できずに閉じたもので、退けたのではない（同じ仮説を出し直してよい）。試すものが無ければ intents を空にする。
${READ_ONLY}`,
  retro_examiner: `## あなたの役: 振り返りの実行役（担当ごとに意図 1 件）
query の inputs の intent の look_at のファイルを読み、仮説が記録で支えられるか（supported）、記録が否定するか（refuted）、決められないか（unclear）を返す。supported なら、原因（cause）と層と、決め手になった本文の逐語の引用を path つきで evidence に返す（CLI が照らす）。
${READ_ONLY}`,
  retro_verifier: `## あなたの役: 振り返りの検証役（反証側。担当ごとに意図 1 件の結論だけ）
query の inputs の exam（実行役の結論）は誤りかもしれないという前提で、evidence の path を読み直して確かめる。原因でなく症状の言い換え、記録と合わない、層の取り違え、固定した目標・制約の蒸し返し、のどれかなら accept=false。
${READ_ONLY}`,
}

const promptOf = (w, waveId) => `${COMMON}
## 段 ${w.stage}、worker ${w.id}（${w.role}）、波 ${waveId}
この段の担当を CLI から取り、結果を CLI に出す。取る担当の数は決めない。claim が done を返すまで続ける。
${loop(w, waveId)}
${BUILD_GUIDES[w.role]}
### 結果の形（担当の result_path に書く JSON。JSON Schema）
${JSON.stringify(RESULT_SCHEMAS[w.role])}`

// ---------------- 検査の役（coverage-audit の役）の指示 ----------------
// 結果の形と規則の文は、coverage-audit.js の READ_RESULT の宣言の行から QUOTED の宣言の行までと同じ文を持つ（一致は tests/coverage-build-audit-guides.test.mjs が照らす）。
// その文が使う値（層・重さの並び、閉じた問い、引用の規則）は coverage-audit.js の値の写し。層は coverage-audit の 5 つの層（<checks> の AUDIT_LAYERS）。
const LAYER_LIST = AUDIT_LAYERS.join('・')
const SEV_LIST = ['HIGH', 'MEDIUM', 'LOW'].join('・')
const UNIT_QUESTIONS = {
  Q1: '手続きの enumerate が「何を列挙するか」を書いているか',
  Q2: '手続きの compare_with が「列挙したものを何と照らすか」を書いているか',
  Q3: 'この手続きで、この部分が果たされたかを確かめられるか',
}
const QUOTE_RULE = `引用は ${QUOTE_MIN} 字以上にする。${QUOTE_MIN} 字未満の短い引用は、本文の全体か、本文の空でない 1 行の全体を引くときだけ受け付ける。見出しの行だけの引用は証拠にならない。結果の中の引用の 1 つでも合わなければ、その提出ごと拒まれる。`
const AUDIT_COMMON = `
## 共通の前提
- 目的: 対象のファイルを、固定した目標と観点の一覧に照らして網羅的に検査し、確かめた指摘と、見ていない所を台帳に残す。検査だけをし、対象を直さない。あなたはその中の 1 つの役で、取った担当の外を読まない。
- 台帳を書くのは CLI だけ。あなたの入力は claim と query の出力と、そこが指す写しのファイルにあり、出力は結果の JSON を result_path に書いて submit で出す。返り値で内容を返さない。
- 対象のファイルと写しを変えない。書いてよいのは、claim が渡した result_path だけ。
- 読めなかったもの・判定できなかったものは推測で埋めない。CLI の出力に無いことを前提にしない。
- 引用は読んだ本文からの逐語の写しにする（行番号は含めない）。CLI が照合し、合わない提出は理由つきで拒む。
`
// 担当を取って出す手順。query の許し方で 2 の文が変わる（ファイルの段と振り返りは他の役の書き込みを読まず、独立に読む。全文レビューは目標と読む範囲だけを引く）。
const STEP_QUERY = '入力を query で引く。命令は claim と同じ --state・--call・--worker に --task <担当の id> を足した query（例: node … query --state … --call … --worker … --task <id>）。事実の id で細部を引き直すときは --fact <事実の id> を足す（何度でもよい）。原文は写しで開く。索引の行・担当の unit・事実・指摘の場所が持つ写しの file を、start から end の行の範囲のうち要る箇所だけ Read で開く（対象の本体は開かない）'
const STEP_INPUTS = '入力を query で引く。命令は claim と同じ --state・--call・--worker に --task <担当の id> を足した query（例: node … query --state … --call … --worker … --task <id>）。--fact は付けない（この段は他の役の書き込みを読まず、CLI も拒む）。inputs の units の単位ごとに、写しの file を start から end の行の範囲の全文で Read で読む（offset=start, limit=end - start + 1。対象の本体は開かない）'
const STEP_BATCH = '取った全ての担当の入力を、1 回の query で引く。命令は claim と同じ --state・--call・--worker に、担当ごとの --task <担当の id> を全て足した query（例: node … query --state … --call … --worker … --task <id1> --task <id2>）。出力の tasks は --task の順に担当ごとの入力（--task が 1 つなら 1 件の形のまま）。事実の id で細部を引き直すときは --fact <事実の id> を足す（何度でもよい）。原文は写しで開く。事実・指摘の場所・単位の索引が持つ写しの file を、start から end の行の範囲のうち判定に要る箇所だけ Read で開く（対象の本体は開かない）'
const STEP_NONE = 'その担当の unit の file を、start から end の行の範囲だけ Read で読む（offset=start, limit=end - start + 1）。この段は query を流さない（他の役の書き込みを読まず、独立に読む。CLI も拒む）'
const auditLoop = (w, waveId, query) => `
### 担当を取る命令（この行をそのまま Bash で流す。出力は JSON）
${claimLine(w, waveId)}
### 手順
1. 取る命令を流す。出力が done: true なら、手順を終えて返り値を返す（下の「返り値」）。命令が終了状態 2 で拒まれたら（呼び出しが閉じた・波の記録と合わないなど）、error を notes に書いて終える。
2. ${query === 'batch' ? STEP_BATCH : `出力の tasks の担当ごとに、${query === 'inputs' ? STEP_INPUTS : query ? STEP_QUERY : STEP_NONE}`}。
3. 担当の kind の節（下の「結果の形」）に従って判断し、結果の JSON を担当の result_path に Write ツールで書く。
4. ${query === 'batch' ? '取った全ての担当の result_path を書いてから、claim の出力の submit_cmd を 1 回だけ Bash で流す（担当ごとに流さない。やり取りの回数を増やすと、そのたびに伸びた文脈を読み直す）。出力の results は出した担当ごとの判定、missing はまだ結果のファイルが無い担当。' : '担当の result_path に書けたら、その都度 claim の出力の submit_cmd をそのまま Bash で流す（全ての担当を書き終えるのを待たない。時間の上限に当たっても、出した担当は台帳に残る）。出力の results は出した担当ごとの判定、missing はまだ結果のファイルが無い担当（後で書いて流し直せばよい）。'}
   ok が false の担当だけ、problems の理由を読んで直した結果を result_path に書き直し、${query === 'batch' ? '書き直した担当の全てを書いてから' : ''}同じ submit_cmd を流し直す（落ちた担当のファイルは CLI が消す。受理された担当は書き直さない）。dropped が true の担当は諦める。
5. 1 に戻る。claim が done を返すまで繰り返す。出し終えていない担当があると、claim は同じ担当を返す。それを直せないときは notes に書いて終える。
前の担当の判断を次の担当に持ち込まない。担当ごとに、その担当の入力だけから判断する。
${RETURN_RULE}`

// <audit-guides> coverage-audit.js と同じ文（検査の役の結果の形・境界の規則・全体の段・計画の規則・全文レビュー・GUIDES・QUOTED）
const READ_RESULT = `- seen: 観点ごとにちょうど 1 つ { lens, answer, quote }。answer は found（指摘がある）・checked（手続きで確かめ、指摘が無い）・not_applicable（この単位に手続きが列挙するものが無い）。どの answer にも、確かめた箇所の逐語の引用を quote に付ける。
- findings: 観点に当たる欠陥ごとに { lens, claim, quote, obligation, confidence, severity, layer }。obligation は結ぶ義務の id（結べないものは findings に入れず references に書く）。confidence は high・medium・low。severity は ${SEV_LIST}。layer は直すべき原因の層（${LAYER_LIST}。本文の層とは限らない）。重さで絞らない。found の観点は指摘を 1 つ以上持つ。
- references: 義務に結べない気づき { claim, quote }。`
// 抜けを数える前の判断。ファイルの段・全文レビュー・全体の段（足す・判定する・確かめる）で同じ文を共有する。
const BOUNDARY_RULE = `#### 境界の答えを抜けと数えない
対象が、ある責務を対象の外（別の層・別の部品・呼ぶ側）に明示して預けている所と、対象に含めないと明示している所は、その境界の答えであって抜けではない。預け先の中身が対象に無いことは、検査の範囲の外のことである。抜けとして数えるのは、目標・要求・仕様がその責務を対象の中で果たすことを求めているときだけで、その求めを claim に逐語で引く（求めが単位の本文にあれば、その箇所も引用の場所に足す）。預け方や範囲の外し方が目標・要求・仕様と食い違うなら、抜けでなく食い違いとして指摘する。正しい対象を、要求に満たないと判じる誤りが起きやすいため。`
const FILE_GUIDE = `#### kind: file（1 つの単位の全文を、全ての観点で読む）
claim は、文脈に収まる分の単位を詰めた担当を返す。担当ごとに 1 つの単位で、全ての担当を読む。担当の lenses（観点の一覧。手続きは「何を列挙し、何と照らすか」で、計画の観点は enumerate と compare_with の欄に分けて書いてある）、obligations（義務: 目標・受け入れ基準の id と本文）、hints（利用者のヒント。あれば取り込む）を使う。単位の全文を読んでから、観点ごとに手続きで確かめる。結果は単位ごとに書く。
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
{ verdict: supported|gap, quote, support?, findings? }。担当と query の出力の units（単位の索引: id・path・写しの file と start〜end。context: true の単位は参照で、検査の対象でないが引用できる）で、項目を支える箇所を探す。related が空でも、omitted_ids の事実を --fact で引き直して支えにでき、units の写しを開いて引用できる。supported なら、支えの事実の id（basis・related・omitted_ids にある id だけ）を support に挙げる。gap なら抜けの指摘を findings に足す（unit を書くときは units の id）。${JUDGE_FINDING}
#### kind: confirm（全体の段が足した指摘、全文レビューの指摘への判定、落とした指摘の確認）
{ verdict: agree|disagree, reason, quote, obligation?, layer? }。basis の対象の指摘と、それへの判定を、本文に当たって確かめる。判定が正しければ agree、誤りなら disagree（落とした指摘への disagree はその指摘を復活させる。全文レビューの指摘を残した判定への disagree は、その指摘を確定させない）。落とす判定ほど厳しく見る。境界や対象の中の抜けを主張する指摘への判定は、上の「境界の答えを抜けと数えない」に照らし、対象にその責務の明示の預けや範囲の外しが無いかを本文で探してから判じる。明示があり、対象の中で果たすことを求める目標・要求・仕様の逐語が無ければ、全体の段が足した判定と残した判定には disagree、落とした判定には agree。その逐語があれば、落とした判定には disagree（復活）。決め手の逐語の引用を付ける（合わない引用の判定は検証不能として扱われる）。復活させる指摘が原因の層を持たなければ layer（${LAYER_LIST}）を、義務に結ばれていなければ obligation を付ける。
#### kind: group（束ね。確認が全て閉じた後の、全体の段の最後の意図）
query の basis（確定した指摘の事実）を根本原因で束ねる。症状でなく原因で束ね、全ての事実の id をちょうど 1 つの群に入れる（入れられないものは unassigned）。重さで絞らない。
結果は { groups: [{ id, root_cause, layer, keys: [事実の id] }], unassigned: [事実の id] }。layer は直すべき層（${LAYER_LIST}）。`
const PLAN_RULES = `### 観点の規則
- 観点の数・例・型枠は与えない。目標と対象の中身から切る。観点は一覧で全ての単位（ファイル）に渡すので、当てる単位は選ばない。
- 既にある観点: query の inputs の given_lenses（呼ぶ側が渡した観点と、仕組みの標準の観点）は必ず使われる。定義し直さず、id を重ねない。given_lenses に呼ぶ側の観点があるときは、足りない観点だけを足す提案をする（足す観点が無ければ lenses を空にしてよい。目標の被覆は既にある観点が受け持つ）。
- 観点（lenses）: { id, name, procedure, goals }。procedure は単位を読むときの手続きで、{ enumerate: 何を列挙するか, compare_with: 列挙したものを何と照らすか } の 2 つの欄を、どちらも空でない文で書く（CLI が形を照らす）。
- 目的（固定した目標・制約に照らす）と層（方針・要求・方式設計・詳細設計・実装の層と範囲）の見方は、要る単位があるときだけ計画の観点として切る。切った観点もほかの観点と同じく goals を持ち、閉じた問いを通る。
- 受け持つ目標（goals）: 観点ごとに、その観点の手続きで果たされたかを確かめる目標・受け入れ基準の部分を {id, part} で挙げる。id は query の items（目標の項目）か criteria（受け入れ基準）の id、part はその本文からの逐語の引用で、この観点が受け持つ部分だけを示す（複合の目標は部分ごとに別の要素にし、別の観点に分けてよい）。given_lenses に呼ぶ側の観点が無いときは、どの目標・受け入れ基準も、どれかの観点の goals に入れる。CLI が id の実在・part の逐語・被覆を照らす。
- 受け入れ基準と固定した制約（criteria・constraints）の全てに、受け皿の観点を constraint_map で付ける（{ constraint_id, handled_by: [観点の id] }。given_lenses の id も受け皿にできる）。
- 利用者への質問（questions）: 価値判断が要り、制約で答えが出ていないものだけ { id, question, why_value_judgment, options }。
- 入力の index は 1 行 1 単位（id・写しの file・start〜end・見出しの経路・種類・先頭の数語）。観点を切るのに要る単位だけ、写しの範囲を Read で開く。`
const FULL_REVIEW_GUIDE = `#### kind: full_review（全文レビュー。読む範囲の全ての単位を、目標だけを手に通して読む）
query の inputs は goal（目標の冒頭の文）・items（目標の項目）・criteria（受け入れ基準）・constraints（制約）と、units（読む範囲の単位: id・path・写しの file と start〜end）だけ。context: true の単位は参照（検査の対象でない今の本文や決定の記録）で、読む範囲に数えないが、照らす根拠として読み、引用してよい。観点の一覧は渡らない。観点に縛られず、units の全ての単位の全文を読んでから、目標・受け入れ基準・制約に照らして、誤り・食い違い・抜け・単位をまたぐ矛盾を探す。重さで絞らない。
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
- 計画の見直し（inputs に previous_plan があるとき）: defects（観点の検証役の閉じた問いの no と CLI の静的な照合から作った欠陥。index は配列の位置）と answers（利用者の回答）がある。欠陥の主張が正しいとは限らない。全ての欠陥について目標と対象に照らし、直した（fixed）か根拠を挙げて退けた（rejected）か、Q3 の欠陥で、その部分を受け持てる単位が対象に無い（no_target）かを、defect_responses: [{ defect_index, action: fixed|rejected|no_target, reason }] で返す。重さで選ばない。閉じた問いの答えから作った欠陥を rejected にしても、その観点は次の検証で同じ問いに答え直される。no_target は観点を直しても解けない欠陥なので、計画はやり直さず、理由が呼ぶ側に返る（reason に、対象に何が無いかを書く）。欠陥に関係しない観点は id も中身も変えない（変えた観点だけが確かめ直される）。
${PLAN_RULES}` },
  unit_verify: { query: true, text: `#### kind: unit_verify（観点の検証役。計画の版の、確かめていない観点の全てを見る）
query の inputs の lenses（観点の本文の配列）の観点ごとに、下の閉じた問いだけに yes か no で答える。問いの外のこと（観点の大きさ・層・制約との矛盾・手続きの細部の良し悪し）は判定しない。欠陥を自由に挙げない。作った者の説明を信じず、観点の本文に書いてあることだけで答える。観点ごとに、その観点の本文だけから答える。
- Q1: ${UNIT_QUESTIONS.Q1}
- Q2: ${UNIT_QUESTIONS.Q2}
- Q3: 観点の goals の要素ごとに、${UNIT_QUESTIONS.Q3}（goal_index に要素の位置、goal_id にその要素の id を入れる）
結果は { lenses: [{ unit_id: <観点の id>, answers: [{ question: Q1|Q2|Q3, goal_index?, goal_id?, answer: yes|no, quote }] }] }（inputs の lenses の観点ごとにちょうど 1 つ）。quote はその観点の本文（name・procedure の enumerate と compare_with・goals の part）からの逐語の引用（yes なら根拠の箇所、no なら足りない手続きの箇所）。inputs の index は手続きが何に当たるかを見るためで、単位の本文は読まない。` },
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
// </audit-guides>

const auditPromptOf = (w, waveId) => {
  const st = auditStageOf(w.stage)
  const g = GUIDES[st]
  return `${AUDIT_COMMON}
## あなたの役（${w.role}、worker ${w.id}、段 ${w.stage}、波 ${waveId}）
この段の担当を CLI から取り、結果を CLI に出す。取る担当の数は決めない。claim が done を返すまで続ける。
${auditLoop(w, waveId, g.query)}
### 結果の形（担当の kind ごと。result_path に書く JSON）
${g.text}${QUOTED.includes(st) ? `
### 引用の規則（submit が照合する）
${QUOTE_RULE}` : ''}`
}

// 返り値は notes と、最後の claim が返した制御の印（next_wave_id・rows・halt。任意）だけ。
const ROW_SCHEMA = { type: 'object', properties: { id: { type: 'string' }, role: { type: 'string' }, model: { type: 'string' }, effort: { type: 'string' }, stage: { type: 'string' } } }
const WORKER_SCHEMA = { type: 'object', properties: { notes: { type: 'array', items: { type: 'string' } }, next_wave_id: { type: 'integer' }, rows: { type: 'array', items: ROW_SCHEMA }, halt: { type: 'boolean' } }, required: ['notes'] }
// 行ごとに 1 体。モデルと effort は行の値（正本は roles.json で、CLI が行に写す）。agent の失敗（throw）も起動の記録に残す。起動の記録は段と波を持つ。
async function launch(w, waveId) {
  const label = `${w.role}-${w.id}`
  const prompt = auditStageOf(w.stage) ? auditPromptOf(w, waveId) : promptOf(w, waveId)
  let out = null
  try { out = await agent(prompt, { label, phase: w.stage, schema: WORKER_SCHEMA, model: w.model, effort: w.effort }) } catch (e) { log(`${label}: agent が失敗した（${String((e && e.message) || e).slice(0, 160)}）`) }
  agents.push({ role: w.role, label, model: w.model, effort: w.effort, stage: w.stage, wave: waveId, ok: out != null })
  return out
}

// 波の id（CLI の連番）と行の形。build の段の行は build の役、検査の段の行は coverage-audit の段の名前（GUIDES の key）を持つ。id は波の中で重ならない。
const waveIdOk = (id) => Number.isSafeInteger(typeof id === 'string' && /^\d+$/.test(id) ? Number(id) : id)
const rowOk = (w) => !!w && isStr(w.id) && isStr(w.role) && isStr(w.model) && isStr(w.effort) && isStr(w.stage)
  && (auditStageOf(w.stage) !== null ? Object.hasOwn(GUIDES, auditStageOf(w.stage)) : BUILD_STAGES.includes(w.stage) && Object.hasOwn(BUILD_GUIDES, w.role))
const rowsOk = (rows) => Array.isArray(rows) && rows.length > 0 && rows.every(rowOk) && new Set(rows.map((w) => w.id)).size === rows.length
const argProblems = []
if (!A || typeof A !== 'object') argProblems.push('args が object でない')
else {
  if (typeof A.state !== 'string' || !A.state) argProblems.push('state が無い')
  if (typeof A.callId !== 'string' || !A.callId) argProblems.push('callId が無い')
  if (!A.wave || typeof A.wave !== 'object') argProblems.push('wave が無い')
  else {
    if (!waveIdOk(A.wave.id)) argProblems.push(`wave の id が整数でない: ${A.wave.id}`)
    if (!rowsOk(A.wave.rows)) argProblems.push('wave の rows が {id, role, model, effort, stage} の配列でない（build の段は roles.json の役、検査の段は audit:<coverage-audit の段>。id は重ならない）')
  }
}
// args が壊れていれば起動しない（起動の記録が空の呼び出しとして ingest が閉じる）。
if (argProblems.length) log(`args の検査に落ちた: ${argProblems.join(' / ')}`)
else {
  // 波を順に流す。次の波は、返り値の中で最大の next_wave_id の行（id は今の波より大きく、行の形が正しいときだけ）。halt が 1 つでもあれば起動しない。
  let wave = { id: Number(A.wave.id), rows: A.wave.rows }
  for (;;) {
    for (const st of new Set(wave.rows.map((w) => w.stage))) phase(st)
    const outs = await parallel(wave.rows.map((w) => () => launch(w, wave.id)))
    const rets = (Array.isArray(outs) ? outs : []).filter((r) => r && typeof r === 'object')
    if (rets.some((r) => r.halt === true)) { log(`波 ${wave.id} の役が止まる印を返したので、新しい波を起動しない`); break }
    const cands = rets.filter((r) => waveIdOk(r.next_wave_id))
    if (!cands.length) break
    const best = cands.reduce((a, b) => (Number(b.next_wave_id) > Number(a.next_wave_id) ? b : a))
    if (!(Number(best.next_wave_id) > wave.id) || !rowsOk(best.rows)) { log(`波 ${wave.id} の後の次の波の印が不正なので起動しない（id ${best.next_wave_id}）`); break }
    wave = { id: Number(best.next_wave_id), rows: best.rows }
  }
}
return { agents, tokens: tokens() }
