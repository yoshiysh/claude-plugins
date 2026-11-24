// 台帳の決定的な部分: 単位の列挙・ID・持ち越し・ファイルの段の結果の照合・事実・止める条件。
// 引用・計画・束ねなどの静的な照合の式は Workflow source の <checks> 区間にあり、ここはそれを読み込んで使う（写しを持たない）。
// ファイルの段の結果の照合（checkFileResult）はここが正本（B2: 照合するのは CLI だけ）。
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// Workflow source の置き場は公開の前後で変わる（best-practices §13「script の置き場」）: 未公開の間は呼ぶ core（metaUrl）の隣、
// 公開した後は plugin の workflows/（skills/<name>/scripts/ から 3 つ上）。先に見つかった方を返す。どちらにも無ければ止める。
// coverage-build の build-core.mjs も同じ規則で build-step.js を解くので、ここから import して使う。
export function workflowSource(file, metaUrl) {
  const candidates = [file, `../../../workflows/${file}`].map((p) => fileURLToPath(new URL(p, metaUrl)))
  const found = candidates.find((p) => existsSync(p))
  if (!found) throw new Error(`Workflow source ${file} が見つかりません: ${candidates.join(', ')}`)
  return found
}
export const WORKFLOW_SOURCE = workflowSource('coverage-audit.js', import.meta.url)
const SRC = readFileSync(WORKFLOW_SOURCE, 'utf8')
const BLOCK = SRC.slice(SRC.indexOf('// <checks>'), SRC.indexOf('// </checks>'))
export const C = new Function(`${BLOCK}
return { LIMITS, LAYERS, SEVERITIES, norm, fenceMask, quoteProblem, unitKey, unitText, checkGoals, checkPlan, checkUnitVerdict, unitDefects, checkGroups, UPPER, parseCited, citeSources, checkCited, checkGoalMap, goalGaps, readGoalFiles }`)()

export const MAX_ATTEMPTS = 2 // 同じ単位・担当・段の欠け（返らない・照合に落ちる）の上限。run をまたいで数える
// 観点の検証の欠陥を直す計画のやり直しの上限。計画 1 版目 → 検証 → 2 版目 → 検証でまだ欠陥なら、3 版目を作らずに利用者に返す（2 巡）。
// 2 巡で終わらないのは、目標の書き方か観点の作り方の誤りを疑う印（docs/design/skill-design-patterns.md の原則）。
const PLAN_ROUNDS = 1
const MAX_FAIL_STREAK = 2 // 全ての役が欠けた呼び出しがこの回数続いたら止める
// 単位の本文のバイト数（UTF-8）の上限（線）。「1 体の文脈に収まらない」を判じる唯一の線で、規模による分岐や調整した数値の線をほかに置かない
// （設計 docs/design/coverage-ledger-method.md の決定 9・11）。モデルの文脈の容量から決める物理的な上限として扱う（この式で判じる形は利用者の承認済み）。
// 線は、単位を読む役（READER_ROLES）の roles.json の context_tokens の最小値から 1 つの式で導く（lineOf）。大きいファイルを分ける処理も、全ての詰め合わせも、この 1 本を使う。
// 式: 指示・観点・目標・台帳から引く事実・出力・推論に 3/4 を残し、単位の本文には 1/4 までを当てる。token あたりのバイト数は前提として、
// 英語・コードで 3〜4 バイト、日本語（1 字 3 バイト）で 2〜3 バイトと置き、記号の多い本文も見込んで少ない側の 2 バイトで見積もる: context_tokens × 1/4 × 2。
// 既定は 1M token の 500,000 バイト（UNIT_MAX_BYTES）。比率と、Workflow の役が 1M の文脈で走ることは実測していない（run の記録の token で見直す。値を変えるのは roles.json）。
export const UNIT_MAX_BYTES = 500000
export const READER_ROLES = ['file_reader', 'full_reviewer', 'global_judge', 'confirmer']
const bytesOfTokens = (n) => Math.floor((n / 4) * 2)
// roles は線を決める役の名前（既定は READER_ROLES）。coverage-build は自分の単位を詰める役を渡し、同じ式で自分の役の線を導く。
export function lineOf(L, roles = READER_ROLES) {
  const ns = roles.map((r) => L && L.roles && L.roles[r] && L.roles[r].context_tokens).filter((n) => Number.isFinite(n) && n > 0)
  return ns.length ? bytesOfTokens(Math.min(...ns)) : UNIT_MAX_BYTES
}
// workers: 全体の段の 1 回の呼び出しで、役（判定役・確認役）ごとに起動する体数の上限（開いた意図の数より多くは起動しない）。
// 既定は 1 体で、1 体が claim を繰り返して意図を順に処理する（設計「モデルと費用」の起動の原則）。--workers は上書きとして残す。
// max_cycles: 今の回の始まりから数えた周の上限（安全網）。run の中の周は 1 つで、周を足すのは止まった後に対象が変わって読み直す回だけ。
const DEFAULT_CONFIG = { max_cycles: 2, max_agents_total: 600, workers: 1 }

// 仕組みの標準の観点（設計「観点の定義と持ち主」）。呼ぶ側の観点と計画役の提案に常に足す（和集合）。標準の 1 つは観点を絞らない通読にし、
// 固定した観点の外の欠陥を落とす副作用を和らげる。origin は standard（振り返りの観点の skill と分ける）。
export const STANDARD_LENSES = [
  { id: 'S1', name: '通読', procedure: '観点を絞らずに単位の全文を頭から通して読み、主張・決定・振る舞いを列挙して、固定した目標・受け入れ基準・制約と照らし、ほかの観点の手続きが列挙しない食い違い・抜け・誤りを探す' },
]
// 振り返りの観点。悪かった出来事を、網羅・正しさ・費用・層の 4 つの面から見る。
const RETRO_LENSES = [
  { id: 'R1', name: '網羅と測れたか', procedure: 'この段で何を網羅すべきだったか（対象・観点）を先に列挙し、出来事の記録と照らす。次に、効果や欠陥を後から測れる記録（同一性・根拠・件数）が残っているかを確かめる。' },
  { id: 'R2', name: '正しさと一貫性', procedure: 'この段の出力が、誤り・食い違い・確かめていない主張をそのまま次の段へ流していないかを、出来事の具体例で確かめる。読む役と検証役が分かれていたかも見る。' },
  { id: 'R3', name: '費用とモデル・effort', procedure: 'この段の起動数と欠測の内訳から、役の難しさに対してモデルと effort が過大か過小かを判定する。同じ結果をより少ない費用で得られた形があれば挙げる。' },
  { id: 'R4', name: '層と範囲', procedure: 'この段が目標の範囲と対象の層に合っていたか、範囲の外へ広がったか狭めすぎたか、欠陥を原因の層へ戻せたかを、出来事から判定する。' },
]

export const sha = (s) => createHash('sha256').update(String(s)).digest('hex')
const slug = (s) => s.toLowerCase().replace(/[`*_~[\]()<>#|:"'!?,.。、（）「」]/g, '').trim().replace(/\s+/g, '-') || 'section'
// 行の範囲（1 始まり・両端を含む）の本文と hash。資産・索引・束ねの全件で同じ式を使い、ingest が写しと照らす。
export const rangeText = (text, start, end) => String(text).split('\n').slice(start - 1, end).join('\n')
export const rangeHash = (text, start, end) => sha(rangeText(text, start, end)).slice(0, 16)

// ファイルを単位に分ける。単位は 1 ファイル 1 つで、id はファイルの path、範囲は 1 行目から最終行まで（見出しや宣言が多くても分けない）。
// 本文が UNIT_MAX_BYTES を超えるファイルだけを、構造の境目で同格の単位に分け、ファイルを隙間なく覆う。id は <path>#<位置>。
// - Markdown: 最も上の階層の見出しの境目で分け、収まる節は続く節と上限まで 1 つの単位に詰める。1 つの節だけで収まらなければ、その節を下の階層の見出しで分ける。
//   位置は単位の最初の行の見出しの経路（最初の見出しより前は _top）。code fence の中の # は見出しにしない。
// - JS・MJS: トップレベルの宣言の境目で分け、上限まで詰める。位置は最初の宣言の名前（宣言でない文は c<n>）。
// - 境目の無い所（見出しの無い節・宣言の無い大きい文・その他のファイル）: 空行の境目、それでも収まらなければ行の境目で分ける。位置は c<n>。
// 同じ位置は ~<k> で分ける。位置を行番号でなく構造から決めるので、大きさを変えない書き換えでは、書き換えた単位の外の id と hash は変わらない。
// 大きさが変わる書き換えは、前から詰めるので後ろの単位の境目を動かしうる（id と hash が変わり読み直す側に倒れる。費用だけの損）。
export function splitAssets(rel, text, max = UNIT_MAX_BYTES) {
  const lines = text.split('\n')
  const size = byteSizer(lines)
  if (size(0, lines.length) <= max) {
    if (!text.trim()) return []
    return [{ id: rel, path: rel, heading: '', trail: [], kind: 'file', start: 1, end: lines.length, text, hash: sha(text).slice(0, 16) }]
  }
  const groups = /\.(md|markdown)$/i.test(rel) ? mdGroups(lines, size, max) : /\.m?js$/i.test(rel) ? jsGroups(lines, size, max) : plainGroups(lines, 0, lines.length, size, '', { n: 1 }, max)
  const used = new Map()
  return groups.map((g) => {
    let id = `${rel}#${g.key}`
    const k = (used.get(id) || 0) + 1
    used.set(id, k)
    if (k > 1) id += `~${k}`
    const t = lines.slice(g.start, g.end).join('\n')
    return { id, path: rel, heading: g.heading || '', trail: g.trail || [], kind: g.kind, start: g.start + 1, end: g.end, text: t, hash: sha(t).slice(0, 16) }
  })
}

// 行の範囲（0 始まり・end を含まない）を '\n' で結んだ本文のバイト数。
function byteSizer(lines) {
  const pre = [0]
  for (const l of lines) pre.push(pre[pre.length - 1] + Buffer.byteLength(l, 'utf8') + 1)
  return (s, e) => (e > s ? pre[e] - pre[s] - 1 : 0)
}
// 境目で切った隣り合う片（{ start, end, ...}）を、上限まで前から詰めて単位にする。収まらない片は sub(片) が返す単位の列にそのまま置き換え、前後と詰めない。
function pack(pieces, size, sub, max = UNIT_MAX_BYTES) {
  const out = []
  let cur = null
  for (const p of pieces) {
    if (size(p.start, p.end) > max) {
      if (cur) out.push(cur)
      cur = null
      out.push(...sub(p))
      continue
    }
    if (cur && size(cur.start, p.end) <= max) { cur.end = p.end; continue }
    if (cur) out.push(cur)
    cur = { ...p }
  }
  if (cur) out.push(cur)
  return out
}
const blank = (l) => !l.trim()
// 境目の無い範囲: 空行の後の行を境目にして詰め、1 段落でも収まらなければ行ごとに詰める（1 行で上限を超える行は、その行だけの単位にする）。
function plainGroups(lines, start, end, size, prefix, seq, max = UNIT_MAX_BYTES) {
  const at = (s, e) => ({ key: `${prefix}c${seq.n++}`, kind: 'lines', start: s, end: e })
  const paras = []
  for (let i = start, s = start; i < end; i++) if (i + 1 === end || (blank(lines[i]) && !blank(lines[i + 1] ?? ''))) { paras.push({ start: s, end: i + 1 }); s = i + 1 }
  const byLine = (p) => pack(Array.from({ length: p.end - p.start }, (_, k) => ({ start: p.start + k, end: p.start + k + 1 })), size, (x) => [x], max)
  return pack(paras, size, byLine, max).map((g) => at(g.start, g.end))
}

function mdGroups(lines, size, max) {
  const fenced = C.fenceMask(lines)
  const heads = []
  const stack = []
  lines.forEach((l, i) => {
    const m = !fenced[i] && /^(#{1,6})\s+(.*)$/.exec(l)
    if (!m) return
    const lv = m[1].length
    const h = m[2].trim()
    while (stack.length && stack[stack.length - 1].lv >= lv) stack.pop()
    stack.push({ lv, s: slug(h), h })
    heads.push({ i, lv, key: stack.map((x) => x.s).join('/'), heading: h, trail: stack.map((x) => x.h) })
  })
  const headAt = new Map(heads.map((h) => [h.i, h]))
  const seq = { n: 1 }
  const label = (g) => {
    const h = headAt.get(g.start)
    return h ? { ...g, key: h.key, heading: h.heading, trail: h.trail, kind: 'section' } : { ...g, key: g.key || '_top', kind: g.kind || 'section' }
  }
  // 範囲の中（先頭の行を除く）で最も上の階層の見出しの境目で分ける。境目が無ければ空行・行の境目に降りる。
  const split = (s, e) => {
    const inner = heads.filter((h) => h.i > s && h.i < e)
    if (!inner.length) {
      const h = headAt.get(s)
      return plainGroups(lines, s, e, size, h ? `${h.key}/` : '', seq, max)
    }
    const lv = Math.min(...inner.map((h) => h.lv))
    const cuts = [s, ...inner.filter((h) => h.lv === lv).map((h) => h.i), e]
    const pieces = cuts.slice(0, -1).map((c, k) => ({ start: c, end: cuts[k + 1] })).filter((p) => p.end > p.start)
    return pack(pieces, size, (p) => split(p.start, p.end), max)
  }
  return split(0, lines.length).map(label)
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

// トップレベルの文の頭（境目）: 宣言は名前を持ち、宣言でない文は名前を持たない（続く宣言でない文は同じ頭にまとめる）。
// 宣言の直前のコメント行（空行を挟まない）は、その宣言の側に含める。最初の頭は 0 行目から始める。行は 0 始まり。
export function jsHeads(lines) {
  const { top, cmt } = jsTopLevel(lines)
  const isComment = (j) => cmt[j] || (top[j] && jsComment(lines[j]))
  const heads = []
  let last = -1 // 直前の境目の行（宣言の行そのもの）
  lines.forEach((l, i) => {
    if (!top[i] || blank(l) || /^\s/.test(l) || jsComment(l) || /^[)\]}.,;:?+\-*/%&|=<>]/.test(l)) return
    const m = JS_DECL.exec(l)
    const name = m && m[2] ? 'default' : m && m[4] ? m[4] : null
    if (!name && heads.length && !heads[heads.length - 1].name) { last = i; return }
    let s = i
    while (s - 1 > last && isComment(s - 1)) s--
    heads.push({ name, kind: name ? (m[2] ? 'export' : m[3].replace(/[\s*]/g, '')) : 'chunk', start: s })
    last = i
  })
  if (!heads.length) heads.push({ name: null, kind: 'chunk', start: 0 })
  else if (heads[0].start > 0) { if (heads[0].name) heads.unshift({ name: null, kind: 'chunk', start: 0 }); else heads[0].start = 0 }
  return heads
}
// トップレベルの文の境目で分けて詰める。1 つの文だけで収まらなければ、その文を空行・行の境目で分ける。
function jsGroups(lines, size, max) {
  const heads = jsHeads(lines)
  const seq = { n: 1 }
  const pieces = heads.map((h, k) => ({ start: h.start, end: k + 1 < heads.length ? heads[k + 1].start : lines.length, key: h.name || `c${seq.n++}`, kind: h.kind }))
  return pack(pieces, size, (p) => plainGroups(lines, p.start, p.end, size, `${p.key}/`, { n: 1 }, max), max)
}

export const readGoalFiles = C.readGoalFiles
export const goalIds = (L) => [...L.goal.items, ...L.criteria, ...L.constraints].map((c) => c.id)
export const goalSources = (L) => C.citeSources({ request: L.request, ...(L.decisions != null ? { decisions: L.decisions } : {}) })

export function newLedger({ goal, goalItems, checkedBy = null, phase = null, link = null, request, decisions = null, criteria = [], constraints, targets, contexts = [], repo = null, lenses, config, roles, seeds }) {
  return {
    // phase: 呼ぶ側の段（coverage-build の design・impl など）。phase_start: 今の段の始まりの周・起動数・出来事の数（上限と status の今の段はここから数える）。
    // phase_records: reframe で出ていった段の status の節（findings・groups・events）。
    // link: 関係する単位を結ぶ語の正規表現（文字列か null）。枠の一部で、init と reframe が置く（静的な検査に渡す。単位 3）。
    // assets: 単位（id → path・範囲・hash・写し・状態・試行・受理した読み）。facts: ファイルの段が足した事実（足すだけ。今の根拠は単位の受理した読みから導く）。
    version: 2, rev: 0, cycle: 1, phase, link, phase_start: { cycle: 1, agents: 0, events: 0 }, phase_records: {}, goal: { text: goal, items: goalItems, checked: !!checkedBy, checked_by: checkedBy, problems: [] }, request, decisions, criteria, constraints,
    // contexts: 参照だけの資産のファイル（--context）。網羅に数えず、判定役・確認役・全文レビューの索引に載せる。repo: 目標の本文の path を照らす基準。
    config: { ...DEFAULT_CONFIG, ...config }, roles, targets, contexts, repo, seeds: seeds || [],
    // wave_seq: 波の id の連番（呼び出しをまたいで増やす）。target_gaps: 計画役が no_target を付けた Q3 の欠陥（部分を受け持てる単位が対象に無い）。
    call_seq: 0, wave_seq: 0, plan: null, plan_rounds: 0, plan_defects: [], plan_seq: 0, plan_problems: [], target_gaps: [], verified_units: [], answers: [], answered: [],
    lenses: [...(lenses || []).map((l) => ({ id: l.id, name: l.name, procedure: l.procedure, origin: 'user' })), ...STANDARD_LENSES.map((l) => ({ ...l, origin: 'standard' })), ...RETRO_LENSES.map((l) => ({ ...l, origin: 'skill', retro: true }))],
    attempts: {}, env_attempts: {}, fail_streak: 0,
    // retro_findings: 振り返りの指摘（対象の指摘・事実・意図・群に入れない。status の retro に出す）。retro_made: 振り返りの単位を作った周。
    // findings・groups は事実から導いた確定した指摘と束ねの群の写し（保存のたびに CLI が書き直す）。
    assets: {}, facts: [], static: [], intent_attempts: {}, findings: {}, groups: [], events: [], retro_cycles: [], retro_findings: [], retro_made: null, saturation: [],
    calls: [], agents: [], hints_read: [], pending: null,
    // round_start: 今の回（init・reframe か、止まった後に対象が変わって読み直しを始めた周）の始まりの周。これより前の周の読みは持ち越し。
    // run_records: 止まるたびの run の記録（指摘の出どころの内訳・持ち越した読みの数・全体の段で落とした数と確認で復活した数）。
    round_start: 1, run_records: [],
    // full_review: 全文レビューの記録（読む範囲・その指紋と目標の版の sig・状態・試行・受理した読み）。読む範囲か sig が変われば next が作り直す。
    full_review: null,
  }
}

// 単位を読み直しにする（受理した読みと取りを外し、試行を戻す）。事実は消さず、受理した読みから外れるので今の根拠から外れる。
function resetUnit(a) {
  Object.assign(a, { state: 'unseen', attempts: 0, env_attempts: 0, reason: '', read: null, claim: null })
}

// 段を差し替える（reframe）。今の段の節を呼ぶ側が phase_records に写した後に呼ぶ。
// 計画・回答・試行を捨て、全ての単位を読み直しにし、今の指摘を退かせる（中身が同じでも読み直す）。束ねは今の段の判定から導くので、段が変われば今の群も無くなる。
// 周を 1 つ進めて段の始まりにする（前の段の周・起動数・出来事を、今の段の上限と status に数えない）。
// lenses を渡すと、利用者の観点をそれに差し替える（観点の組の版が変わる。単位はどのみち全て読み直しになる）。
export function startPhase(L, phase, { lenses = null } = {}) {
  Object.assign(L, {
    phase, plan: null, plan_rounds: 0, plan_defects: [], plan_problems: [], target_gaps: [], plan_skipped: false, verified_units: [], answers: [], answered: [],
    attempts: {}, env_attempts: {}, fail_streak: 0, pending: null, stopped: null, intent_attempts: {}, full_review: null,
  })
  L.lenses = L.lenses.filter((l) => l.origin === 'skill' || l.origin === 'user' || l.origin === 'standard')
  if (lenses) L.lenses = [...lenses.map((l) => ({ id: l.id, name: l.name, procedure: l.procedure, origin: 'user' })), ...L.lenses.filter((l) => l.origin !== 'user')]
  // 手続きが変わって全てを読み直すときも、受理した読みの hash と周を prior に残す（同じ単位の次の読みで、直しによる誤りと前からの見落としを分けるため）。
  for (const [id, a] of Object.entries(L.assets)) {
    if (a.retro) { delete L.assets[id]; continue }
    if (a.read) a.prior = { hash: a.hash, cycle: a.read.cycle }
    resetUnit(a)
  }
  for (const f of Object.values(L.findings)) if (f.status === 'current') f.status = 'superseded'
  L.cycle += 1
  L.phase_start = { cycle: L.cycle, agents: L.agents.length, events: L.events.length }
  L.round_start = L.cycle
}
// 今の段の出来事（段の始まりより後）。
export const phaseEvents = (L) => L.events.slice(L.phase_start.events)

export const targetLenses = (L) => L.lenses.filter((l) => !l.retro)
// 検査の対象の単位（振り返りの単位と、参照だけの単位（--context）を除く）。網羅・読む単位・全文レビューの範囲はこれだけを数える。
export const isTarget = (a) => !!a && !a.retro && !a.context
// 単位に渡す観点: 振り返りの単位は振り返りの観点、他の単位は対象の観点の全て（観点は一覧で全ての役に渡し、当てる単位を選ばない）。
export const lensesFor = (L, a) => (a && a.retro ? L.lenses.filter((l) => l.retro) : targetLenses(L))
// 観点の組の版: 渡す観点の id・名前・手続き。持ち越しは単位の hash とこの版がどちらも前と同じときだけ。
export const lensSetVersion = (L, a) => sha(JSON.stringify(lensesFor(L, a).map((l) => [l.id, l.name, l.procedure]).sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0)))).slice(0, 12)
// 義務: 指摘を結ぶ目標と受け入れ基準の項目。
export const obligations = (L) => [...L.goal.items, ...L.criteria].map((c) => ({ id: c.id, text: c.text }))

// 今のファイルの内容に台帳を合わせる（持ち越し）。hash か観点の組の版が変わった単位は読み直しにする。消えた単位は台帳から外す。
// partial は振り返りの単位を足すだけ（対象の単位を消さない）。
export function refresh(L, units, { partial = false } = {}) {
  const now = new Set(units.map((u) => u.id))
  const changes = { added: [], stale: [], gone: [] }
  for (const u of units) {
    const a = L.assets[u.id]
    const meta = { path: u.path, heading: u.heading, trail: u.trail || [], kind: u.kind, start: u.start, end: u.end, hash: u.hash, snap: u.snap, ...(u.text != null ? { bytes: Buffer.byteLength(u.text, 'utf8') } : {}), ...(u.retro ? { retro: true } : {}), ...(u.context ? { context: true } : {}) }
    // 参照（context）から対象に変わった単位は印を外す。
    if (a && !u.context) delete a.context
    if (!a) {
      L.assets[u.id] = { ...meta }
      resetUnit(L.assets[u.id])
      changes.added.push(u.id)
      continue
    }
    const changed = a.hash !== u.hash
    const before = a.read ? { hash: a.hash, cycle: a.read.cycle } : null
    Object.assign(a, meta)
    const lv = lensSetVersion(L, a)
    if (changed || (a.read && a.read.lens_version !== lv)) {
      if (a.state !== 'unseen') changes.stale.push(u.id)
      resetUnit(a)
      // 前に受理した読みがあった単位は、その読みの hash と周を prior に残す（指摘の出どころを指紋の照合だけで分けるため）。
      if (before) a.prior = before
    }
  }
  if (!partial) for (const id of Object.keys(L.assets)) if (!now.has(id) && !L.assets[id].retro) { changes.gone.push(id); delete L.assets[id] }
  return changes
}

const eventId = (L) => `E${L.cycle}-${L.events.filter((e) => e.cycle === L.cycle).length + 1}`
export function addEvent(L, stage, kind, text, ref = null) { L.events.push({ id: eventId(L), cycle: L.cycle, stage, kind, text, ref }) }

// 事実の id: 単位・種類・引用・主張（か主語）・義務・観点から決める（同じ中身は別の台帳でも同じ id。数え上げの番号を使わない）。
export const factId = (unit, type, f) => `F${sha(JSON.stringify([unit, type, C.norm(f.quote), C.norm(f.claim || f.subject || ''), f.obligation || '', f.lens || ''])).slice(0, 12)}`

export const SEEN_ANSWERS = ['found', 'checked', 'not_applicable']
export const CONFIDENCES = ['high', 'medium', 'low']
const isStr = (s) => typeof s === 'string' && s.trim().length > 0
const list = (a) => (Array.isArray(a) ? a : [])
// ファイルの段の結果の照合（B2: 照合するのは CLI だけ）。text は単位の本文。
// - seen: 渡した観点ごとにちょうど 1 つ、答えは閉じた集合（found・checked・not_applicable）、引用は本文に逐語（「問題なし」「該当なし」も引用が要る）。
// - findings: 渡した観点・主張・逐語の引用・義務（目標・受け入れ基準の id。結べないものは references に書く）・確信度（閉じた集合）・原因の層。found の観点は指摘を 1 つ以上持つ。
// - references: 主張と逐語の引用。guarantees・premises: 主語・逐語の引用・確信度。obligation は任意で、あれば義務の id。
export function checkFileResult(rep, { text, lensIds, obligationIds }) {
  if (!rep || typeof rep !== 'object' || Array.isArray(rep)) return ['結果が object でない']
  const p = []
  const quote = (where, q) => { const e = C.quoteProblem(q, text); if (e) p.push(`${where}: ${e}`) }
  const seen = list(rep.seen)
  for (const id of lensIds) {
    const n = seen.filter((x) => x && x.lens === id).length
    if (!n) p.push(`観点 ${id} の答え（seen）が無い`)
    if (n > 1) p.push(`観点 ${id} の答えが ${n} つある`)
  }
  seen.forEach((x, i) => {
    if (!x || !lensIds.includes(x.lens)) p.push(`seen[${i}]: 渡していない観点 ${x && x.lens}`)
    if (!SEEN_ANSWERS.includes(x && x.answer)) p.push(`seen[${i}]: answer は ${SEEN_ANSWERS.join('・')} のどれか: ${x && x.answer}`)
    quote(`seen[${i}]`, x && x.quote)
  })
  const findings = list(rep.findings)
  findings.forEach((f, i) => {
    if (!f || !lensIds.includes(f.lens)) p.push(`findings[${i}]: 渡していない観点 ${f && f.lens}`)
    if (!isStr(f && f.claim)) p.push(`findings[${i}]: claim が空`)
    quote(`findings[${i}]`, f && f.quote)
    if (!obligationIds.includes(f && f.obligation)) p.push(`findings[${i}]: obligation は目標・受け入れ基準の id（結べないものは references に書く）: ${f && f.obligation}`)
    if (!CONFIDENCES.includes(f && f.confidence)) p.push(`findings[${i}]: confidence は ${CONFIDENCES.join('・')} のどれか`)
    if (!C.LAYERS.includes(f && f.layer)) p.push(`findings[${i}]: layer（原因の層）は ${C.LAYERS.join('・')} のどれか`)
    if (f && f.severity !== undefined && !C.SEVERITIES.includes(f.severity)) p.push(`findings[${i}]: severity は ${C.SEVERITIES.join('・')} のどれか`)
  })
  for (const x of seen) if (x && x.answer === 'found' && !findings.some((f) => f && f.lens === x.lens)) p.push(`観点 ${x.lens} は found なのに指摘が無い`)
  list(rep.references).forEach((r, i) => {
    if (!isStr(r && r.claim)) p.push(`references[${i}]: claim が空`)
    quote(`references[${i}]`, r && r.quote)
  })
  for (const k of ['guarantees', 'premises']) list(rep[k]).forEach((g, i) => {
    if (!isStr(g && g.subject)) p.push(`${k}[${i}]: subject（主語）が空`)
    quote(`${k}[${i}]`, g && g.quote)
    if (!CONFIDENCES.includes(g && g.confidence)) p.push(`${k}[${i}]: confidence は ${CONFIDENCES.join('・')} のどれか`)
    if (g && g.obligation !== undefined && !obligationIds.includes(g.obligation)) p.push(`${k}[${i}]: obligation は目標・受け入れ基準の id: ${g.obligation}`)
  })
  return p
}
// 受理したファイルの段の結果から事実を作る（同じ中身の事実は 1 つ）。
export function factsOf(rep, { unit, path: p, read, cycle }) {
  const out = new Map()
  const add = (type, f, extra) => { const id = factId(unit, type, f); if (!out.has(id)) out.set(id, { id, type, unit, path: p, read, cycle, quote: f.quote, ...extra }) }
  for (const f of list(rep.findings)) add('finding', f, { claim: f.claim, lens: f.lens, obligation: f.obligation, confidence: f.confidence, layer: f.layer, ...(f.severity ? { severity: f.severity } : {}), origin: 'file' })
  for (const r of list(rep.references)) add('reference', r, { claim: r.claim, origin: 'file' })
  for (const [k, type] of [['guarantees', 'guarantee'], ['premises', 'premise']]) for (const g of list(rep[k])) add(type, g, { subject: g.subject, confidence: g.confidence, ...(g.obligation ? { obligation: g.obligation } : {}), origin: 'file' })
  return [...out.values()]
}

// ---------------- 全体の段: 静的な検査・意図・判定（探索グラフ） ----------------
// 事実（グラフの点）は CLI が受理したものだけで、意図（次に調べること）は今の根拠の事実から CLI が決定的に作る（設計「全体の段と確認」）。
// 台帳が持つのは、受理した事実（L.facts。判定も事実）と、意図ごとの試行（L.intent_attempts）だけで、
// 意図の一覧と状態・今の根拠・確定した指摘・束ねの群は、それらから毎回導く（B6: 状態は記録から導く）。
// 束ね（group）は、ほかの意図が全て閉じた後に作る全体の段の最後の意図で、確定した指摘を根拠に持つ。
export const INTENT_KINDS = ['alias', 'subject', 'finding', 'premise', 'goal', 'confirm', 'group']
export const VERDICTS = {
  subject: ['consistent', 'conflict'], finding: ['keep', 'drop'], premise: ['satisfied', 'unsatisfied'], goal: ['supported', 'gap'], confirm: ['agree', 'disagree'],
}
export const ALIAS_ANSWERS = ['yes', 'no', 'unsure']
const intentId = (kind, key) => `${kind}:${sha(JSON.stringify(key)).slice(0, 12)}`
const keyOf = (ids) => sha(JSON.stringify([...ids].sort())).slice(0, 16)
// 主語の名前の正規化（大文字小文字と空白を無視する）。正規化して同じ名前は同じ主語にし、名寄せにかけない。
const subjectName = (s) => String(s || '').toLowerCase().replace(/\s+/g, '')
// 名前が近い組: 正規化した名前が違い、片方がもう片方を含む（設計の下の層で決めること。字を共有しない組は近くない）。
const closeNames = (a, b) => a !== b && (a.includes(b) || b.includes(a))
// 落とした指摘の確認: 重い（HIGH）指摘は全件、他は事実の id の hash で決まる 1/4 の抜き取り（設計の下の層で決める率。決定的にする）。
const sampled = (f) => f.severity === 'HIGH' || parseInt(sha(f.id).slice(0, 2), 16) < 64
// 単位の本文（写しの範囲）。
export function unitTextOf(L, id) {
  const a = L.assets[id]
  if (!a || !a.snap) return null
  try { return rangeText(readFileSync(a.snap, 'utf8'), a.start, a.end) } catch { return null }
}

// 静的な検査: --link の id の形で、範囲で書いた参照（例: U1〜U3）を 1 件ずつに展開し、どの単位の本文にも（範囲の外に）書かれていない id を事実にする。
// 範囲を展開しない単独の参照は、存在する id と見分けられないので照らさない。結果は指摘の判定の意図にかけ、それだけで確定の指摘にしない。
export function staticFacts(L) {
  if (L.link == null) return []
  const one = new RegExp(L.link, 'g')
  const range = new RegExp(`(${L.link})\\s*[〜~～]\\s*(${L.link})`, 'g')
  const texts = Object.entries(L.assets).filter(([, a]) => isTarget(a)).map(([id, a]) => [id, a, unitTextOf(L, id) || ''])
  const present = new Set()
  for (const [, , t] of texts) for (const m of t.replace(range, ' ').matchAll(one)) present.add(m[0])
  const out = new Map()
  for (const [id, a, t] of texts) {
    for (const line of t.split('\n')) {
      for (const m of line.matchAll(range)) {
        const [x, y] = [/^(.*?)(\d+)$/.exec(m[1]), /^(.*?)(\d+)$/.exec(m[2])]
        if (!x || !y || x[1] !== y[1] || Number(y[2]) <= Number(x[2])) continue
        for (let n = Number(x[2]); n <= Number(y[2]); n++) {
          const ref = `${x[1]}${n}`
          if (present.has(ref)) continue
          const f = { quote: line, claim: `範囲の参照 ${m[0]} の ${ref} が、対象のどの単位にも無い` }
          const fid = factId(id, 'static', f)
          if (!out.has(fid)) out.set(fid, { id: fid, type: 'static', unit: id, path: a.path, quote: line, claim: f.claim, ref, origin: 'static' })
        }
      }
    }
  }
  return [...out.values()]
}

// ファイルの段の今の根拠の事実（単位の受理した読みが足した事実）。
export const fileFacts = (L) => L.facts.filter((f) => f.origin === 'file' && (() => { const a = L.assets[f.unit]; return a && !a.retro && a.read && a.read.id === f.read })())
// 今の読みの組（無いことの判定の根拠）: どれかの単位の読みが変われば、無いことの判定を開き直す。
export const readsSig = (L) => sha(JSON.stringify(Object.entries(L.assets).filter(([, a]) => isTarget(a)).map(([id, a]) => [id, a.read ? a.read.id : null]).sort())).slice(0, 16)

// 台帳から、今の根拠の事実・意図（状態つき）・確定した指摘を導く。
export function board(L) {
  const phase = L.phase_start.cycle
  const facts = new Map()
  const put = (f) => { if (!facts.has(f.id)) facts.set(f.id, f) }
  for (const f of fileFacts(L)) put(f)
  for (const f of fullReviewFacts(L)) put(f)
  for (const f of L.static || []) put(f)
  const judgments = L.facts.filter((f) => f.type === 'judgment' && f.phase === phase)
  const added = new Map(L.facts.filter((f) => f.type === 'finding' && f.judgment).map((f) => [f.id, f]))
  const att = L.intent_attempts || {}
  const rs = readsSig(L)
  const intents = []
  const byId = new Map()
  // 意図を足し、今の判定（根拠が同じで今の段の判定）と状態を決める。判定が今なら、その判定が足した事実も今の根拠に入れる。
  const add = (kind, key, basis, extra = {}) => {
    const id = intentId(kind, key)
    if (byId.has(id)) return byId.get(id)
    // 根拠の鍵は、根拠の事実と、それを足した読み（か判定）の組。単位を読み直せば、中身の同じ事実でも鍵が変わり、意図を開き直す。
    const k = keyOf(basis.map((x) => { const f = facts.get(x); return `${x}@${(f && (f.read || f.judgment)) || ''}` }))
    // 無いことを根拠にした判定（目標の抜け・前提が満たされていない）は、どれかの単位の読みが変われば開き直す（設計「再レビューと持ち越し」）。
    const valid = (j) => {
      if (j.key !== k) return false
      if (kind === 'goal') return j.verdict === 'supported' ? (j.support || []).every((s) => facts.has(s)) : j.reads === rs
      if (kind === 'premise' && j.verdict === 'unsatisfied') return j.reads === rs
      return true
    }
    const j = judgments.filter((x) => x.intent === id && valid(x)).at(-1) || null
    const a = att[id] && att[id].key === k ? att[id] : null
    const it = { id, kind, basis: [...basis], key: k, state: j ? 'closed' : a && a.n >= MAX_ATTEMPTS ? 'undecided' : 'open', judgment: j, ...(a && a.n >= MAX_ATTEMPTS && !j ? { reason: a.reason } : {}), related: [], omitted: 0, ...extra }
    intents.push(it)
    byId.set(id, it)
    if (j) { put(j); for (const fid of j.added || []) if (added.has(fid)) put(added.get(fid)) }
    return it
  }
  // 主語: 保証と前提の主語を正規化した名前で束ねる。
  const subj = new Map()
  for (const f of facts.values()) if (f.type === 'guarantee' || f.type === 'premise') { const n = subjectName(f.subject); if (!subj.has(n)) subj.set(n, []); subj.get(n).push(f) }
  const names = [...subj.keys()].sort()
  // 名寄せ: 名前の近い組ごと。同じ（yes）なら主語を統合し、不明（unsure）と判定できなかった組は統合せずに組の主語の照合を作る。
  const parent = new Map(names.map((n) => [n, n]))
  const root = (n) => { while (parent.get(n) !== n) n = parent.get(n); return n }
  const unsurePairs = []
  const aliasOpen = new Set()
  for (let i = 0; i < names.length; i++) for (let k = i + 1; k < names.length; k++) {
    const [x, y] = [names[i], names[k]]
    if (!closeNames(x, y)) continue
    const it = add('alias', [x, y], [...subj.get(x), ...subj.get(y)].map((f) => f.id), { names: [x, y] })
    if (it.state === 'open') { aliasOpen.add(x); aliasOpen.add(y); continue }
    const same = it.judgment && it.judgment.same
    if (same === 'yes') parent.set(root(x), root(y))
    else if (same !== 'no') unsurePairs.push([x, y])
  }
  const groups = new Map()
  for (const n of names) { const r = root(n); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(n) }
  const factsOfNames = (ns) => ns.flatMap((n) => subj.get(n))
  const subjectSets = []
  for (const ns of groups.values()) if (new Set(factsOfNames(ns).map((f) => f.unit)).size >= 2) subjectSets.push(ns)
  for (const [x, y] of unsurePairs) subjectSets.push([...new Set([...groups.get(root(x)), ...groups.get(root(y))])])
  const seenSets = new Set()
  for (const ns of subjectSets) {
    const sorted = [...ns].sort()
    const sk = JSON.stringify(sorted)
    if (seenSets.has(sk)) continue
    seenSets.add(sk)
    // 主語の照合は、その主語に関わる名寄せが全て閉じてから開く（作らない）。
    if (sorted.some((n) => aliasOpen.has(n))) continue
    add('subject', sorted, factsOfNames(sorted).map((f) => f.id), { names: sorted })
  }
  // 前提の消化: 他の単位に同じ主語（統合の後）の保証がある前提ごと。候補の保証も根拠に持ち、どちらの単位が変わっても開き直す。
  for (const p of [...facts.values()].filter((f) => f.type === 'premise')) {
    const n = subjectName(p.subject)
    if (aliasOpen.has(n)) continue
    const ns = groups.get(root(n))
    const cands = factsOfNames(ns).filter((f) => f.type === 'guarantee' && f.unit !== p.unit)
    if (cands.length) add('premise', [p.id], [p.id, ...cands.map((f) => f.id)])
  }
  // 指摘の判定: 全文レビューの指摘・ファイルの段の指摘・静的な検査の結果の 1 件ごと。
  const base = [...facts.values()].filter((f) => (f.type === 'finding' && (f.origin === 'file' || f.origin === FULL_REVIEW)) || f.type === 'static')
  for (const f of base) add('finding', [f.id], [f.id])
  // 目標の判定: 目標と受け入れ基準の項目ごと。根拠は持たず、その項目を obligation に持つ事実を関係する事実にする。
  for (const g of [...L.goal.items, ...L.criteria]) add('goal', [g.id], [], { item: g.id })
  // 確認: 全体の段が足した指摘の全件と、落とした指摘（重いものは全件、他は抜き取り）。意図の鍵は対象と種類（added・kept・dropped）の組。
  // 全文レビューの指摘は、判定役が残したもの（kept）も落としたもの（dropped）も、重さによらず全件を確認にかける（設計「段の構成」の全文レビュー）。
  for (const it of [...intents]) {
    const j = it.judgment
    if (!j) continue
    for (const fid of j.added || []) if (facts.has(fid)) add('confirm', ['added', fid], [fid, j.id], { target: fid, mode: 'added' })
    if (it.kind !== 'finding') continue
    const f = facts.get(it.basis[0])
    if (!f) continue
    const mode = j.verdict === 'drop' ? 'dropped' : 'kept'
    if (f.origin === FULL_REVIEW || (mode === 'dropped' && sampled(f))) add('confirm', [mode, f.id], [f.id, j.id], { target: f.id, mode })
  }
  // 関係する事実: 目標の判定は、その項目を obligation に持つ事実だけ。結ばれていない保証は返さず、件数を omitted に宣言する。
  const all = [...facts.values()]
  for (const it of intents) {
    if (it.kind !== 'goal') continue
    it.related = all.filter((f) => ['guarantee', 'premise', 'finding'].includes(f.type) && f.obligation === it.item).map((f) => f.id)
    const left = all.filter((f) => f.type === 'guarantee' && f.obligation !== it.item).map((f) => f.id)
    it.omitted = left.length
    it.omitted_ids = left
  }
  const findings = deriveFindings(L, facts, intents)
  // 束ね: ほかの意図が全て閉じ（開示して閉じたものを含む）、確定した指摘があれば、確定した指摘の事実を根拠に 1 つ作る。
  // 根拠の鍵は確定した指摘の組なので、持ち越しで確定した指摘が変われば開き直す。
  const confirmedIds = findings.list.filter((f) => f.verdict === 'confirmed').map((f) => f.id)
  let bundles = []
  if (confirmedIds.length && !intents.some((i) => i.state === 'open')) {
    const it = add('group', ['group'], confirmedIds)
    if (it.judgment) bundles = (it.judgment.groups || []).map((g) => ({ id: groupId(it.judgment, g), cycle: it.judgment.cycle, root_cause: g.root_cause, layer: g.layer, keys: [...g.keys] }))
  }
  return { facts, intents, byId, findings, groups: bundles }
}
// 同じ箇所の指摘の組: 全文レビューの指摘の場所と、ファイルの段の指摘が同じ単位で、正規化した引用が包含し合う組（[全文レビューの指摘, ファイルの段の指摘] の id）。
// 包含は照合で決まるので CLI が求め、同じ欠陥かは役が判じる（まとめず、出どころを残す。設計「役と制御の境界」）。facts は今の根拠の事実。
export function sameLocationPairs(facts) {
  const fs = [...facts].filter((f) => f.type === 'finding')
  const contains = (x, y) => !!x && !!y && (x.includes(y) || y.includes(x))
  const out = []
  for (const a of fs.filter((f) => f.origin === FULL_REVIEW)) {
    for (const b of fs.filter((f) => f.origin === 'file')) {
      const qb = C.norm(b.quote || '')
      if ((a.locations || []).some((l) => l.unit === b.unit && contains(C.norm(l.quote || ''), qb))) out.push([a.id, b.id])
    }
  }
  return out
}
// 束ねの群の id: 判定の周と、役が付けた群の id（answer --id で指す）。
const groupId = (j, g) => `G${j.cycle}-${g.id}`

// 確定した指摘と参考を導く。確定は義務に結ばれたものだけで、結べないものは参考にする。
// - ファイルの段・静的な検査の指摘: 指摘の判定が keep なら確定（静的な検査は判定が義務を足したときだけ）。drop で、確認が disagree なら復活して確定。
// - 全文レビューの指摘: 確認を通ったものだけを確定する。keep への確認が agree なら確定、drop への確認が disagree なら復活して確定。
// - 全体の段が足した指摘: 確認が agree なら確定、disagree なら確定しない。確認の引用が逐語でなければ検証不能。
// - 落とした指摘の確認が検証不能（逐語でない引用）なら、黙って落とさず検証不能の指摘として出す（落とす側を厳しくする）。
// - 確定には義務と原因の層が要る。復活のときは、指摘の判定と確認の判定の義務・層も使う。層が無いものは確定にしない（参考にする）。
function deriveFindings(L, facts, intents) {
  const confirmOf = new Map(intents.filter((i) => i.kind === 'confirm').map((i) => [`${i.mode}|${i.target}`, i]))
  // 関わる単位: 指摘の場所の単位と、全体の段が足した指摘ではそれを足した意図の根拠と関係する事実の単位（出どころの分類に使う。設計「再レビューと持ち越し」）。
  const byJudgment = new Map(intents.filter((i) => i.judgment).map((i) => [i.judgment.id, i]))
  const unitsOf = (x) => (x ? (Array.isArray(x.locations) ? x.locations.map((l) => l.unit) : [x.unit]) : [])
  const involved = (f) => {
    const it = f.judgment ? byJudgment.get(f.judgment) : null
    const ctx = it ? [...it.basis, ...it.related].flatMap((id) => unitsOf(facts.get(id))) : []
    return [...new Set([...unitsOf(f), ...ctx, ...(it && it.unit ? [it.unit] : [])])].filter(Boolean)
  }
  const out = []
  const refs = []
  const shape = (f, verdict, js, extra = {}) => ({
    id: f.id, verdict, claim: f.claim, quote: f.quote, paths: f.paths || [f.path], obligation: f.obligation || js.map((j) => j && j.obligation).find(Boolean), confidence: f.confidence,
    severity: f.severity, layer: f.layer || js.map((j) => j && j.layer).find(Boolean), origin: f.origin, cycle: (js.at(-1) && js.at(-1).cycle) || L.cycle,
    units: involved(f), ...extra,
  })
  const ref = (f) => ({ id: f.id, unit: f.unit, path: f.path, claim: f.claim, quote: f.quote, origin: f.origin })
  // 場所が参照（--context）の単位だけにある指摘は、対象の欠陥と言えないので確定させず、参考にする（場所の 1 つ以上が対象の単位にあれば確定しうる）。
  const onlyContext = (f) => { const us = unitsOf(f); return us.length > 0 && us.every((u) => L.assets[u] && L.assets[u].context) }
  const confirmed = (x, f) => (x.obligation && C.LAYERS.includes(x.layer) && !onlyContext(f) ? out.push(x) : refs.push(ref(x)))
  // 検証不能も、場所が参照だけの指摘は対象の欠陥の候補にならないので、unverifiable に入れず参考に回す（それを理由に止めない）。
  const unverif = (x, f) => (onlyContext(f) ? refs.push(ref(x)) : out.push(x))
  for (const it of intents) {
    if (it.kind !== 'finding' || !it.judgment) continue
    const f = facts.get(it.basis[0])
    const j = it.judgment
    const fr = f.origin === FULL_REVIEW
    if (j.verdict === 'keep' && !fr) { confirmed(shape(f, 'confirmed', [j]), f); continue }
    const c = confirmOf.get(`${j.verdict === 'keep' ? 'kept' : 'dropped'}|${f.id}`)
    if (!c || !c.judgment) continue
    if (j.verdict === 'keep') {
      if (c.judgment.verdict === 'agree') confirmed(shape(f, 'confirmed', [j, c.judgment]), f)
      else if (c.judgment.verdict === 'unverifiable') unverif(shape(f, 'unverifiable', [j, c.judgment]), f)
      continue
    }
    if (c.judgment.verdict === 'disagree') confirmed(shape(f, 'confirmed', [j, c.judgment], { restored: true }), f)
    else if (c.judgment.verdict === 'unverifiable') unverif(shape(f, 'unverifiable', [j, c.judgment], { dropped: true }), f)
  }
  for (const f of facts.values()) {
    if (f.type !== 'finding' || !f.judgment) continue
    const c = confirmOf.get(`added|${f.id}`)
    if (!c || !c.judgment) continue
    if (c.judgment.verdict === 'unverifiable') unverif(shape(f, 'unverifiable', [c.judgment]), f)
    else if (c.judgment.verdict === 'agree') confirmed(shape(f, 'confirmed', [c.judgment]), f)
  }
  return { list: out, references: refs }
}
// 今の根拠の事実（ファイルの段・静的な検査・今の判定と、その判定が足した指摘）。
export const currentFacts = (L) => [...board(L).facts.values()]

export const currentFindings = (L) => Object.entries(L.findings).filter(([, f]) => f.status === 'current').map(([id, f]) => ({ id, ...f }))
export const needPlan = (L) => !L.lenses.some((l) => l.origin === 'user')
// 計画役を流すか。観点は呼ぶ側・標準・計画役の提案の和なので、呼ぶ側が観点を渡しても計画役は足す観点の提案として流す。
// 呼ぶ側の観点があって提案が試行の上限まで出なかったときだけ、提案なしで進める（plan_skipped。next が出来事に残す）。
export const planWanted = (L) => !L.plan_skipped
// 計画の段で取り込む回答: 計画の質問への回答と、計画の欠陥（P<n>）への回答。
export const planAnswerKinds = ['question', 'plan_defect']
// ファイルの段で読む単位: 読みの無い（unseen）・試行が上限に届いていない対象の単位（対象から外すファイルは、対象の指定から外す）。
const unread = (a) => a.state === 'unseen' && a.attempts < MAX_ATTEMPTS
export const todoUnits = (L) => Object.entries(L.assets).filter(([, a]) => isTarget(a) && unread(a)).map(([id]) => id)
// 振り返りの段で読む単位（出来事の写し）。対象の単位に数えない。
export const retroTodo = (L) => Object.entries(L.assets).filter(([, a]) => a.retro && unread(a)).map(([id]) => id)

// 詰め合わせ: 単位の並び（ids の順）で前から、本文のバイト数の和が線（max。lineOf）に収まる所まで 1 つの担当に詰める（next-fit。前に戻って詰めない）。
// 線は大きいファイルを分ける基準と同じ 1 つで、新しい線を置かない（設計「段の構成」、決定 9・11・16）。bytesOf(id) は単位の本文のバイト数。
export function packUnitsTo(ids, bytesOf, max) {
  const out = []
  let cur = null
  for (const id of ids) {
    const n = bytesOf(id)
    if (cur && cur.bytes + n <= max) { cur.ids.push(id); cur.bytes += n; continue }
    cur = { ids: [id], bytes: n }
    out.push(cur)
  }
  return out.map((x) => x.ids)
}

// ---------------- 全文レビュー（設計の決定 17、段の構成の「全文レビュー」） ----------------
// 段・担当の種類・事実の origin・出来事の段の名前。1 体が目標と読む範囲の単位だけを手に、観点に縛られずに読む。網羅（カバレッジ）に数えない。
export const FULL_REVIEW = 'full_review'
// 単位の並び（対象の指定の順、ファイルの中は行の順）。全文レビューの読む範囲はこの順で前から詰める。
const unitOrder = (L) => {
  const at = new Map(L.targets.map((p, i) => [p, i]))
  const pos = (a) => (at.has(a.path) ? at.get(a.path) : L.targets.length)
  return Object.entries(L.assets).filter(([, a]) => isTarget(a)).sort(([, x], [, y]) => pos(x) - pos(y) || x.start - y.start).map(([id]) => id)
}
// 参照だけの単位（--context）の id。全文レビューと判定役の索引に context: true で載り、指摘の場所に引ける。
export const contextUnits = (L) => Object.entries(L.assets).filter(([, a]) => !a.retro && a.context).map(([id]) => id)
export const unitBytes = (L, id) => { const a = L.assets[id]; return Number.isInteger(a.bytes) ? a.bytes : Buffer.byteLength(unitTextOf(L, id) || '', 'utf8') }
// 目標の版: 全文レビューの query が返す目標の欄（冒頭の文・項目・基準・制約）。観点は入れない（観点が変わっただけでは読み直さない）。
const goalVersion = (L) => sha(JSON.stringify([L.goal.text, ...[L.goal.items, L.criteria, L.constraints].map((xs) => xs.map((x) => [x.id, x.text]))])).slice(0, 12)
// 読む範囲: 単位の並びで前から線に収まる所まで（ファイルの段の最初の詰め合わせと同じ packUnits）。sig は範囲の単位の指紋と目標の版（参照があれば参照の指紋も）。
export function fullReviewScope(L) {
  const range = packUnitsTo(unitOrder(L), (id) => unitBytes(L, id), lineOf(L))[0] || []
  const ctx = contextUnits(L).sort().map((id) => [id, L.assets[id].hash])
  return { range, sig: sha(JSON.stringify([range.map((id) => [id, L.assets[id].hash]), goalVersion(L), ...(ctx.length ? [ctx] : [])])).slice(0, 16) }
}
// 記録を今の範囲に合わせる（sig が変われば試行と読みを捨てて作り直す。前の読みの事実は記録に残し、今の根拠から外れる）。
export function syncFullReview(L) {
  const s = fullReviewScope(L)
  if (!L.full_review || L.full_review.sig !== s.sig) L.full_review = { sig: s.sig, range: s.range, state: 'open', attempts: 0, read: null }
  return L.full_review
}
const fullReviewSettled = (L, s = fullReviewScope(L)) => !!L.full_review && L.full_review.sig === s.sig && ['read', 'failed'].includes(L.full_review.state)
// 全文レビューの今の根拠の事実（今の sig で受理した読みが足した指摘と参考）。
export function fullReviewFacts(L) {
  const fr = L.full_review
  if (!fr || fr.state !== 'read' || !fr.read || fr.sig !== fullReviewScope(L).sig) return []
  return L.facts.filter((f) => f.origin === FULL_REVIEW && f.read === fr.read.id)
}
// status の開示: 読んだ単位と読まなかった単位（範囲の外と、失敗・まだ読んでいない範囲）。網羅（skip・disclosed）と別の一覧。
export function fullReviewStatus(L) {
  const fr = L.full_review
  const read = fr && fr.state === 'read' && fullReviewSettled(L) ? [...fr.range] : []
  return { read, unread: unitOrder(L).filter((id) => !read.includes(id)), ...(fr ? { state: fr.state, ...(fr.reason ? { reason: fr.reason } : {}), ...(fr.cause ? { cause: fr.cause } : {}) } : {}) }
}

export function coverage(L) {
  const live = Object.entries(L.assets).filter(([, a]) => isTarget(a))
  const by = (s) => live.filter(([, a]) => a.state === s).map(([id]) => id)
  return { units: live.length, seen: by('seen').length, disclosed: by('disclosed'), pending: by('unseen') }
}

// この周の振り返り（coverage-build から呼ばれたときは、作らないことの印）が済んだ後に読む単位か開いた意図が出た（持ち越しで対象が変わった）ら、次の周を開く。
// run の中では周を足さない（横展開を持たない。設計「完了と止める条件」）。
export function openCycle(L) {
  if (L.retro_cycles.includes(L.cycle) && (todoUnits(L).length || board(L).intents.some((i) => i.state === 'open'))) { L.cycle += 1; return true }
  return false
}

// 周の上限は、今の回の始まり（round_start。init・reframe か、止まった後に対象が変わって読み直しを始めた周）から数える。
const roundBase = (L) => Math.max(L.round_start ?? L.phase_start.cycle, L.phase_start.cycle)

// 次の 1 手か停止を、台帳だけから決める（next と claim の advance が流す）。計画の段は役ごとの波（計画役 → 観点の検証役）に分ける
// （1 つの波の worker は全て同時に起動されるので、前の役の提出を待つ役は次の波に置く）。
export function decide(L, { missingTargets = [] } = {}) {
  // 停止には、開いたままの意図と、判定できずに開示して閉じた意図を必ず載せる（上限で止まったことを完了と取り違えない）。
  const stop = (kind, reasons, extra = {}) => {
    const B = board(L)
    return { stop: kind, reasons, ...extra, open_intents: B.intents.filter((i) => i.state === 'open').map((i) => i.id), undecided: B.intents.filter((i) => i.state === 'undecided').map((i) => ({ id: i.id, kind: i.kind, reason: i.reason })) }
  }
  if (missingTargets.length) return stop('blocked', [`対象が読めない: ${missingTargets.join(', ')}`], { cause: 'input' })
  if (L.fail_streak >= MAX_FAIL_STREAK) return stop('blocked', [`全ての役が欠けた呼び出しが ${L.fail_streak} 回続いた`], { cause: 'failure' })
  // 周と起動数は、今の段の始まり（init か reframe）から数える。
  if (L.cycle - roundBase(L) + 1 > L.config.max_cycles) return stop('limit', [`周が上限 ${L.config.max_cycles} を超えた。上限を上げる入力で再開する`])
  const spent = L.agents.length - L.phase_start.agents
  if (spent >= L.config.max_agents_total) return stop('limit', [`起動数が上限 ${L.config.max_agents_total} に達した（${spent}）。上限を上げる入力で再開する`])
  if (L.goal.problems.length && !L.goal.checked) return stop('needs_input', ['依頼文・決定の記録が求める成果のうち、目標・基準・制約のどの項目も受け止めていないものがある'], { goal_gaps: L.goal.problems })
  // 計画の段（計画役・観点の検証）の試行の上限は利用者に返す。
  const stuck = Object.entries(L.attempts).filter(([, n]) => n >= MAX_ATTEMPTS).map(([k]) => k)
  if (stuck.length) return stop('needs_input', ['試行の上限まで欠けた段がある'], { stuck })
  // 目標の照合は計画役が担う（照合済みでなければ、計画の段を流す）。
  if (!L.goal.checked) return { step: 'plan' }
  const newAnswers = L.answers.filter((a) => !L.answered.includes(a.id) && planAnswerKinds.includes(a.target_kind))
  // 計画役が no_target を付けた Q3 の欠陥（部分を受け持てる単位が対象に無い）: 計画をやり直さずに返す。P<n> に答えると計画の段を 1 巡回す。
  const gaps = (L.target_gaps || []).filter((g) => !L.answers.some((a) => a.id === g.id))
  if (gaps.length) return stop('needs_input', ['観点の検証の欠陥のうち、目標の部分を受け持てる単位が対象に無いもの（no_target）がある。目標か対象を直すか、P<n> に直し方・受け入れ方を答える'], { target_gaps: gaps })
  if (planWanted(L)) {
    if (L.plan_defects.length && L.plan_rounds >= PLAN_ROUNDS && !newAnswers.length) {
      return stop('needs_input', [
        `計画の欠陥が計画のやり直し ${PLAN_ROUNDS} 回（計画 ${PLAN_ROUNDS + 1} 版とその検証の ${PLAN_ROUNDS + 1} 巡）で消えない。${PLAN_ROUNDS + 1} 巡で終わらなかったので、目標の書き方か、スキルの観点の作り方を疑う`,
        ...L.plan_defects.map((d) => `${d.id}: ${d.claim}${d.quote ? `（検証の答えの引用: ${d.quote}）` : ''}`),
      ], { plan_defects: L.plan_defects })
    }
    if (!L.plan || L.plan_defects.length || newAnswers.length) return { step: 'plan' }
    const lenses = L.plan.lenses || []
    // 観点の検証（Q1〜Q3）を通っていない観点を検証する（観点が変わらなければ検証し直さない）。当てる単位を選ばないので、観点の精査（N1・N2）は持たない。
    const unverified = lenses.filter((u) => !L.verified_units.includes(C.unitKey(u)))
    if (unverified.length) return { step: 'unit_verify', lenses: unverified.map((u) => u.id) }
  }
  const openQ = ((L.plan && L.plan.questions) || []).filter((q) => !L.answers.some((a) => a.id === q.id))
  if (openQ.length) return stop('needs_input', ['利用者への質問がある'], { questions: openQ })
  // 全文レビュー: 計画の段の後、ファイルの段の前に 1 回。読む範囲・その指紋・目標の版が前と同じで、読んだか失敗して開示したなら流さない。
  const fr = fullReviewScope(L)
  if (fr.range.length && !fullReviewSettled(L, fr)) return { step: FULL_REVIEW, units: fr.range }
  const todo = todoUnits(L)
  if (todo.length) return { step: 'file', units: todo }
  const B = board(L)
  // 全体の段: 開いた意図が 0 になるまで（受理された事実から CLI が意図を足す。束ねは最後の意図）。
  const open = B.intents.filter((i) => i.state === 'open')
  if (open.length) return { step: 'global', intents: open.map((i) => i.id) }
  // 振り返り（単独で呼ばれたときだけ。対象の指摘と分ける）。next が単位を作り、読む単位が無くなったら済みの印を付ける。
  if (!L.retro_cycles.includes(L.cycle)) return { step: 'retro', units: retroTodo(L) }
  // ここまで来たら、この周にやることは無い。
  const cov = coverage(L)
  const answered = (id) => L.answers.some((a) => a.id === id)
  const cur = B.findings.list
  const upper = cur.filter((f) => f.verdict === 'confirmed' && C.UPPER.includes(f.layer) && !answered(f.id))
  const upperGroups = B.groups.filter((g) => C.UPPER.includes(g.layer) && !answered(g.id))
  const unverifiable = cur.filter((f) => f.verdict === 'unverifiable' && !answered(f.id))
  if (!cov.units) return stop('blocked', ['単位が 0 件（対象が空か、全て除いた）'], { cause: 'target' })
  if (!cov.seen) return stop('blocked', ['読みを受け付けた単位が 1 つも無い（全ての役が欠けたか、照合に落ち続けた）'], { cause: 'failure', disclosed: cov.disclosed })
  if (upper.length || upperGroups.length || unverifiable.length) {
    return stop('needs_input', [
      ...(upper.length || upperGroups.length ? ['上の層（方針・要求）が原因の欠陥・束は、呼ぶ側が直す前に利用者が判断する'] : []),
      ...(unverifiable.length ? [`検証不能の指摘 ${unverifiable.length} 件`] : []),
    ], { upper: upper.map((f) => f.id), upper_groups: upperGroups.map((g) => g.id), unverifiable: unverifiable.map((f) => f.id) })
  }
  return stop('complete', ['全ての単位を見たか見られなかった理由を開示し、開いた意図が 0 になった'], { disclosed: cov.disclosed })
}

// 振り返りの単位: まだ振り返っていない出来事を、全ての段にわたって 1 行 1 件で並べ、本文が線（lineOf）に収まるよう行の境目で前から詰めて単位に分ける。
// 単位は振り返りの役 1 体が全て読む（収まらない分だけ詰め合わせが増える）。本文は呼び出し側が写しに書く。
export function retroAssets(L) {
  const ev = L.events.filter((e) => !e.retro)
  for (const e of ev) e.retro = L.cycle
  if (!ev.length) return []
  const lines = ev.map((e) => `[${e.id}] (${e.stage}/${e.kind}) ${String(e.text).replace(/\s*\n\s*/g, ' / ')}`)
  const size = byteSizer(lines)
  const chunks = pack(lines.map((_, k) => ({ start: k, end: k + 1 })), size, (x) => [x], lineOf(L))
  return chunks.map((c, n) => {
    const text = lines.slice(c.start, c.end).join('\n')
    // 同じ周に作り直すとき（振り返りが 2 波以上に分かれ、読まなかった単位を作り直す）は、読んだ単位の id と重ねない。
    const base = `retro:c${L.cycle}${chunks.length > 1 ? `/c${n + 1}` : ''}`
    let id = base
    for (let k = 2; L.assets && L.assets[id]; k++) id = `${base}~${k}`
    return { id, path: id, heading: 'retro', trail: [], kind: 'retro', start: 1, end: text.split('\n').length, text, hash: sha(text).slice(0, 16), retro: true }
  })
}

// ---------------- 再レビューの記録（設計「再レビューと持ち越し」「測り方」の run の指標） ----------------
// 持ち越した読み: 今の回の始まりより前の周に受理し、そのまま残っている読み。新しく読んだ単位と分けて数える。
export const carriedRead = (L, a) => !!(a && a.state === 'seen' && a.read && a.read.cycle < (L.round_start ?? 1))
export function readCounts(L) {
  const live = Object.entries(L.assets).filter(([, a]) => isTarget(a) && a.state === 'seen')
  const carried = live.filter(([, a]) => carriedRead(L, a)).map(([id]) => id)
  return { fresh: live.length - carried.length, carried: carried.length, carried_units: carried }
}
// 指摘の出どころ（指紋の照合だけで決める）。関わる単位（ファイルをまたぐ指摘は全ての単位）で判じる。
// - carried: 前の回に確定した指摘が、根拠が変わらずに残っているもの。
// - fix（直しによる誤り）: 関わる単位のどれかの内容が、前の回の読みから変わったもの。
// - missed（前からの見落とし）: 関わる単位がどれも内容が変わらず、前の回に見ていたもの。
// - new: 関わる単位を、この段で初めて見たもの（前の回が無い）。
export function provenance(L, f) {
  if ((f.cycle ?? L.cycle) < (L.round_start ?? 1)) return 'carried'
  const as = (f.units || []).map((u) => L.assets[u]).filter(Boolean)
  if (as.some((a) => a.prior && a.prior.hash !== a.hash)) return 'fix'
  if (as.length && as.every((a) => a.prior || carriedRead(L, a))) return 'missed'
  return 'new'
}
// 全体の段で落とした指摘の数と、確認で復活させた数（今の根拠の判定から数える）。
export function globalCounts(B) {
  const dropped = B.intents.filter((i) => i.kind === 'finding' && i.judgment && i.judgment.verdict === 'drop').length
  const restored = B.intents.filter((i) => i.kind === 'confirm' && i.mode === 'dropped' && i.judgment && i.judgment.verdict === 'disagree').length
  return { dropped, restored }
}
// run の指標: 確定した指摘の出どころの内訳・持ち越した読みの数・全体の段の落とした数と復活した数。
export function runMetrics(L, B = board(L)) {
  const by = { new: 0, missed: 0, fix: 0, carried: 0 }
  for (const f of B.findings.list) if (f.verdict === 'confirmed') by[provenance(L, f)] += 1
  const r = readCounts(L)
  return { cycle: L.cycle, round_start: L.round_start ?? 1, provenance: by, reads: { fresh: r.fresh, carried: r.carried }, global: globalCounts(B) }
}

// 較正: 利用者が仕込んだ既知の欠陥（seeds）を、観点ごとに何件拾えたか（再現率）。今の根拠のファイルの段の指摘だけで数える
// （観点を持たない全文レビューの指摘と全体の段が足した指摘は入れない）。
export function calibration(L) {
  if (!L.seeds.length) return null
  const rows = {}
  for (const s of L.seeds) {
    for (const f of currentFacts(L)) {
      if (f.type !== 'finding' || f.origin !== 'file' || f.path !== s.path || (s.lens && f.lens !== s.lens)) continue
      const q = C.norm(f.quote), sq = C.norm(s.quote)
      if (!(q.includes(sq) || sq.includes(q))) continue
      rows[f.lens] = rows[f.lens] || new Set()
      rows[f.lens].add(s.quote)
    }
  }
  const per = {}
  for (const l of targetLenses(L)) {
    const rel = L.seeds.filter((s) => !s.lens || s.lens === l.id).length
    if (rel) per[l.id] = { found: rows[l.id] ? rows[l.id].size : 0, seeds: rel }
  }
  return per
}
