export const meta = {
  name: 'prd-spec',
  description: '依頼を仕分けて流れを閉じ、前提を裁定してから要求・仕様を書き、監査と範囲を絞った再監査を収束するまで回す',
  whenToUse: 'prd-spec の SKILL.md から、workspace を作ったあとに呼ぶ。needs_answers で止まったら回答を answers に逐語で書き、next_args を references/workflow-io.md §3 のとおりに渡して再実行する。args に打ち直す値は ID・件数・digest に限る（本文や JSON の本体は W に置く）',
  phases: [
    { title: 'Intake', detail: '段 1: 依頼を確定・決定・未決に仕分け、分割と writer の単位を決める' },
    { title: 'Flow', detail: '段 2: 出典付きの流れを描き、閉包を検査する' },
    { title: 'Resolve', detail: '段 3・3v: 未決と組を裁定し、独立に検証する（差し戻しは 1 回）' },
    { title: 'Answers', detail: '段 3a・3b・3a\': 依頼者の回答を流れと裁定に当て、G0 の後は回答で flow を組み直す' },
    { title: 'Draft', detail: '段 4: writer の単位ごとに初稿を書く（依存の向きに順番、独立な単位は並列）' },
    { title: 'Audit', detail: '段 5: implementer・grounding を文書ごと、cross-doc を全文書で 1 回当てる' },
    { title: 'Decide', detail: '段 6: 決定が要る指摘と新しい TBD を裁定する' },
    { title: 'Revise', detail: '段 7・8: 改稿し、変えた範囲だけを監査する（収束の条件と上限の定数で回す）' },
    { title: 'Report', detail: '段 9: 収束せずに止まったときは残った論点を保持規則にする（事後報告は司令塔が doc_check report で導出する）' },
  ],
}

// 段の順序・起動の条件・上限・返り値の検査と引き継ぎだけを持つ（schemas/role-map.md の prd.js の行）。
// ファイルは読めないので、分岐に使う値はすべて agent の返り値から受け取り、next_args の state に載せる。
// state に載せるのは ID・件数・digest だけにする（why は references/workflow-io.md §1）。
// state は plain JSON に限る。Map・Set・class を pipeline / parallel の境界や返り値に載せると、runtime で中身が失われる。

// ROLE_OPTS: 全役に既定を置く。省略するとセッションの設定を継承し、全呼び出しが最重量で走って利用上限に達する。
const ROLE_OPTS = {
  intake: { model: 'opus', effort: 'medium' },
  flowFramer: { model: 'opus', effort: 'medium' },
  resolver: { model: 'opus', effort: 'medium' },
  verifier: { model: 'opus', effort: 'medium' },
  writer: { model: 'opus', effort: 'medium' },
  implementer: { model: 'opus', effort: 'high' },
  grounding: { model: 'opus', effort: 'high' },
  crossDoc: { model: 'sonnet', effort: 'medium' },
  flowCheck: { model: 'haiku', effort: 'low' },
}

const ROLE_FILES = {
  intake: 'intake.md',
  flowFramer: 'flow-framer.md',
  resolver: 'resolver.md',
  verifier: 'resolver-verifier.md',
  writer: 'writer.md',
  implementer: 'implementer.md',
  grounding: 'grounding.md',
  crossDoc: 'cross-doc.md',
  flowCheck: 'flow-check.md',
}

const CONTRACT_SECTIONS = {
  intake: ['§intake', '決定の台帳', '現物と既存実装の扱い', '不変条件の kind'],
  flowFramer: ['§flow-framer', 'flow.json の形', '不変条件の kind'],
  resolver: ['§resolver', '決定の台帳', '現物と既存実装の扱い', 'flow.json の形', '不変条件の kind'],
  verifier: ['§resolver-verifier', '決定の台帳', '現物と既存実装の扱い', 'flow.json の形', '不変条件の kind'],
  writer: ['§writer', '現物と既存実装の扱い'],
  implementer: ['監査役の共通節', '§implementer'],
  grounding: ['監査役の共通節', '§grounding', '現物と既存実装の扱い'],
  crossDoc: ['監査役の共通節', '§cross-doc'],
  flowCheck: ['§flow-check'],
}

// COMMON_SECTIONS: 書き込みの規則（put だけで書く・その場で更新する・tmp の所有）はここにだけ置く。役の節に写すと、
// 写しの無い役に規則が届かない。
const COMMON_SECTIONS = ['共通の約束', 'W のファイルと書き手']

// 上限は暴走を止めるためだけに置く。止まる条件は収束（残りが 0 か、減らなくなった）で、回数で打ち切ると連鎖が途中で止まるだけで項目は直らない。
const MAX_AUDIT_PASSES = 4
const MAX_CHECK_REWORK = 3
const MAX_SETTLE_ROUNDS = 3

const ENTRIES = ['new', 'existing', 'expand']
const STAGES = ['1', '2', '3', '3a', '3b', '4', '5', '6', "3a'", '7', '8', '9']
const GATE_ANSWERS = { g0: 'answers/g0.md', 'g0-2': 'answers/g0-2.md', g1: 'answers/g1.md' }

// ---------------------------------------------------------------- 純粋関数（tests が抽出して呼ぶ）
// PURE_BEGIN

const MODELS = ['haiku', 'sonnet', 'opus']
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']

// RESOLUTION_ID: resolution の ID の形。doc_check の LEDGERS.resolutions.keyShape と同じ（tests が照合する）。合否と台帳の集合は
// この形で resolution と D- / F- を分けるので、形の外の ID を受け取ると、裁定したことが黙って消える。
const RESOLUTION_ID = /^RS-\d+$/

// DIRECTIONS・ORIGINS: 契約の direction・origin の表と同じ集合（tests が照合する）。enum が無いと表の外の値が黙って通る。
const DIRECTIONS = ['relax', 'tighten', 'make_measurable', 'choose_one', 'merge_or_split', 'align_terms', 'add_trace', 'remove', 'document_decision']
const ORIGINS = ['input', 'flow', 'ledger', 'text']
const OPPOSITE = { tighten: 'relax', relax: 'tighten' }

// FIXERS_BY_CODE: doc_check flow の指摘の符号ごとに、所有表の中の書き込みだけで消せる役（fixers）と、flow-framer だけが消せる符号を
// settle の flow-framer に渡すときの行（handoff）。どの符号を flow-framer だけにするかは契約「## flow.json の形」の直し手が正。
const EITHER = { fixers: ['flowFramer', 'resolver'] }
const framerOnly = (handoff) => ({ fixers: ['flowFramer'], handoff })
const FIXERS_BY_CODE = {
  FLOW_SHAPE: EITHER,
  FLOW_BRANCH_OPEN: EITHER,
  FLOW_DANGLING: EITHER,
  FLOW_DEADEND: EITHER,
  FLOW_UNREACHABLE: EITHER,
  FLOW_NOSOURCE: framerOnly('出典が無い'),
  FLOW_SOURCE_SHAPE: EITHER,
  FLOW_SOURCE_UNKNOWN: EITHER,
  FLOW_CONSTRAINT_UNKNOWN: EITHER,
  FLOW_EFFECT_MISSING: EITHER,
  FLOW_DESTRUCTIVE_UNCONSTRAINED: framerOnly('縛る不変条件が無い'),
  FLOW_HISTORY: EITHER,
  FLOW_CASE_NOSOURCE: framerOnly('case の出典が無い'),
  FLOW_NO_TABLE: EITHER,
  FLOW_INPUT_FROM: EITHER,
  FLOW_FAIL_UNHANDLED: EITHER,
  FLOW_ON_FAIL_AS: EITHER,
  FLOW_INPUT_ON_FAIL: EITHER,
  FLOW_OBTAIN_MISSING: EITHER,
  FLOW_INPUT_UNKNOWN: EITHER,
  FLOW_UNKNOWN_CASE: EITHER,
  FLOW_CASE_BRANCH: EITHER,
  FLOW_BRANCH_UNUSED: EITHER,
  FLOW_DT_GAP: EITHER,
  FLOW_DT_OVERLAP: EITHER,
  FLOW_DT_VALUE: EITHER,
  FLOW_DT_SIZE: EITHER,
  FLOW_SAME_NEXT: EITHER,
}
const FRAMER_ONLY_CODES = Object.keys(FIXERS_BY_CODE).filter((c) => !FIXERS_BY_CODE[c].fixers.includes('resolver'))

// applyRoleOverrides: 未知の役割名や値は止める。黙って既定に落ちると、指定したつもりの配分が効かない。
function applyRoleOverrides(table, overrides) {
  const out = JSON.parse(JSON.stringify(table))
  for (const [name, o] of Object.entries(overrides || {})) {
    if (!out[name]) throw new Error(`args.role_opts の役割名が不明です: "${name}"（あるのは ${Object.keys(out).join(' / ')}）`)
    if (!o || typeof o !== 'object') throw new Error(`args.role_opts.${name} はオブジェクトで渡してください`)
    if (o.model !== undefined && !MODELS.includes(o.model)) throw new Error(`args.role_opts.${name}.model が不正です: "${o.model}"`)
    if (o.effort !== undefined && !EFFORTS.includes(o.effort)) throw new Error(`args.role_opts.${name}.effort が不正です: "${o.effort}"`)
    for (const k of Object.keys(o)) if (k !== 'model' && k !== 'effort') throw new Error(`args.role_opts.${name}.${k} は受け付けません（model と effort だけ）`)
    Object.assign(out[name], o)
  }
  return out
}

const list = (xs) => (xs && xs.length ? xs.join(', ') : '（なし）')
const uniq = (xs) => [...new Set((xs || []).filter((x) => x !== undefined && x !== null && x !== ''))].sort()
const minus = (xs, ys) => {
  const drop = new Set(ys || [])
  return uniq(xs).filter((x) => !drop.has(x))
}

// aboutKey: Set は state に載せられないので、閉じた論点の集合を about の文字列の配列で持つ。
function aboutKey(about) {
  if (!about || typeof about !== 'object') return null
  if (Array.isArray(about.pair) && about.pair.length === 2) return `pair:${[...about.pair].map(String).sort().join('|')}`
  for (const k of ['open', 'finding', 'tbd', 'verification']) if (about[k]) return `${k}:${about[k]}`
  return null
}

function resolverIds(r) {
  const items = [...(r.ruled || []), ...(r.questions || []), ...(r.holds || [])].filter((x) => x && x.id)
  const about = {}
  for (const x of items) about[x.id] = aboutKey(x.about)
  return { ids: uniq(items.map((x) => x.id)), about }
}

function missedTargets(targets, r) {
  const seen = new Set(Object.values(resolverIds(r).about).filter(Boolean))
  return uniq(targets).filter((t) => !seen.has(t))
}

function closedKeys(state) {
  const settled = new Set([...(state.passed || []), ...(state.answered || []), ...(state.holds || [])])
  return uniq(Object.entries(state.about || {}).filter(([id, k]) => k && settled.has(id)).map(([, k]) => k))
}

function settledOpenIds(state) {
  const settled = new Set(usableResolutions(state))
  return uniq(Object.entries(state.about || {}).filter(([id, k]) => k && k.startsWith('open:') && settled.has(id)).map(([, k]) => k.slice(5)))
}

function settledTerminals(openOnly, state) {
  const settled = new Set(settledOpenIds(state))
  return (openOnly || []).filter((x) => x && settled.has(x.open || x.constraint))
}

function openTbdOf(state) {
  const closed = new Set(closedKeys(state).filter((k) => k.startsWith('tbd:')).map((k) => k.slice(4)))
  return uniq(state.open_tbd || []).filter((id) => !closed.has(id))
}

// usableResolutions: 根拠にしてよい resolution。候補の選択で回答が当たった問いは、その候補が段 3 の検証を通っているので合格と同じに扱う。
// hold と回答待ちの問いは合格していても入れない（保持規則の output も回答を待つ output も、未決のまま残るのが正しい）。
function usableResolutions(state) {
  return minus(uniq([...(state.passed || []), ...(state.answered || [])]).filter((id) => RESOLUTION_ID.test(id)), [...(state.failed_ids || []), ...(state.holds || []), ...pendingQuestions(state)])
}

// invalidIds: 落ちた既定が差し戻しで問いや保持規則に変わり supersedes されなかったとき、これを渡さないと、
// 検証を通っていない決定が有効な根拠として writer に届く。failedFlow は最後の独立な doc_check flow の failed_current。
function invalidIds(state, failedFlow) {
  return {
    decisions: uniq([...(state.superseded || []), ...(state.failed_ids || []).filter((id) => /^D-/.test(id))]),
    flow: uniq(failedFlow),
  }
}

// verificationRulings・failedOpen: 不合格の要素のうち、止まらなかった run でもそのまま進むもの（検証の裁定が保持規則か、回答待ちの問い）を除いたもの。
// 残りは settle の flow-framer が直す（裁定が合格していればその裁定で、無ければ落ちた理由で）。
const verificationRulings = (state, el) => uniq(Object.entries(state.about || {}).filter(([, k]) => k === `verification:${el}`).map(([id]) => id))
function failedOpen(fc, state, asking) {
  const kept = new Set([...(state.holds || []), ...(asking ? pendingQuestions(state) : [])])
  return uniq(fc.failed_current).filter((el) => !verificationRulings(state, el).some((id) => kept.has(id)))
}

// unjudged: 今の版に合否の無い要素と resolution。書き換えていない不合格の要素は渡すと同じ理由で落ちるので数えない（直すのは settle）。
const unjudged = (fc) => ({ elements: minus(fc.unverified, fc.failed_current), resolutions: uniq(fc.resolutions.filter((x) => !x.verdict).map((x) => x.id)) })

// unconverted: 検証に落ちたまま question にも hold にもなっていない裁定。根拠にも保持規則にもならないまま台帳に残る。
const UNDECIDED = ['question', 'hold']
const unconverted = (fc) => fc.resolutions.filter((x) => x.verdict === 'fail' && !UNDECIDED.includes(x.ruling))

// unverifiedLeft: 段を出るときの不変条件（exitViolation）。unjudged に加えて、進めない不合格の要素（failedOpen）と unconverted と、
// 不合格の回答済みの問いも残さない。回答済みの問いは回答待ちにも変換にも根拠にも数えられず、論点は閉じたことになるので、決めたことが黙って消える。
function unverifiedLeft(fc, state, asking) {
  const { elements, resolutions } = unjudged(fc)
  const open = failedOpen(fc, state, asking)
  const failed = uniq(unconverted(fc).map((x) => x.id))
  const answered = new Set(state.answered || [])
  const answeredFail = uniq(fc.resolutions.filter((x) => x.verdict === 'fail' && answered.has(x.id)).map((x) => x.id))
  if (!elements.length && !open.length && !resolutions.length && !failed.length && !answeredFail.length) return null
  return `検証を通っていない要素: ${list(elements)} / 保持規則にも回答待ちにもならない不合格の要素: ${list(open)} / 合否の無い resolution: ${list(resolutions)} / 問いにも保持規則にもならない不合格の resolution: ${list(failed)} / 不合格の回答済みの問い: ${list(answeredFail)}`
}

function pendingQuestions(state) {
  return minus(state.questions || [], [...(state.answered || []), ...(state.holds || [])])
}

// unitWaves: 循環と未知の依存は止める（黙って並列にすると、依存する文書を互いの記述を知らないまま書き、矛盾を作る）。
function unitWaves(units) {
  const byId = {}
  for (const u of units || []) {
    if (!u || !u.id) throw new Error('writer の単位に id がありません')
    if (byId[u.id]) throw new Error(`writer の単位 ${u.id} が重複しています`)
    byId[u.id] = u
  }
  for (const u of units || []) {
    for (const d of u.depends_on || []) if (!byId[d]) throw new Error(`単位 ${u.id} の依存先 ${d} がありません`)
  }
  const waves = []
  const done = new Set()
  let rest = Object.keys(byId).sort()
  while (rest.length) {
    const ready = rest.filter((id) => (byId[id].depends_on || []).every((d) => done.has(d)))
    if (!ready.length) throw new Error(`writer の単位の依存が循環しています: ${rest.join(', ')}`)
    waves.push(ready)
    for (const id of ready) done.add(id)
    rest = rest.filter((id) => !done.has(id))
  }
  return waves
}

function docUnit(units, doc) {
  const u = (units || []).find((x) => (x.docs || []).includes(doc))
  return u ? u.id : null
}

function partitionFindings(findings) {
  const list = (findings || []).filter((f) => f && f.id)
  const groups = {}
  for (const f of list.filter((x) => x.route !== 'decision')) {
    const k = `${f.doc}\u0000${f.item_id}`
    if (!groups[k]) groups[k] = { item_id: f.item_id, doc: f.doc, findings: [] }
    groups[k].findings.push(f.id)
  }
  const bundles = Object.keys(groups)
    .sort()
    .map((k) => ({ ...groups[k], findings: uniq(groups[k].findings) }))
  return {
    bundles,
    decision: uniq(list.filter((f) => f.route === 'decision').map((f) => f.id)),
    blocking: uniq(list.filter((f) => f.blocking).map((f) => f.id)),
  }
}

// reversedFindings: 逆向きの指摘を writer に回すと、片側を直すたびに他方を壊す。
function reversedFindings(prevFindings, findings) {
  const key = (f) => `${f.doc}\u0000${f.item_id}`
  const before = new Set((prevFindings || []).filter((f) => f && OPPOSITE[f.direction]).map((f) => `${key(f)}\u0000${f.direction}`))
  return uniq((findings || []).filter((f) => f && f.id && OPPOSITE[f.direction] && before.has(`${key(f)}\u0000${OPPOSITE[f.direction]}`)).map((f) => f.id))
}

// toDecision: writer は本文しか直せないので、原因が本文の外にある指摘（origin が text 以外）と逆転した指摘を decision にする。
function toDecision(findings, reversed) {
  const rev = new Set(reversed || [])
  return (findings || []).filter((f) => f && f.id).map((f) => (f.origin !== 'text' || rev.has(f.id) ? { ...f, route: 'decision' } : f))
}

const itemKey = (f) => `${f.doc}#${f.item_id}`

// pending は指摘を 文書 → 項目 → ID で束ねて持ち、束・decision・blocking はそこから導く（写しを持つと next_args の上限を超える）。
// 指摘の欄は FINDING_DEFAULTS と違うものだけを持つ（next_args の字数は指摘の数に比例する）。
const FINDING_DEFAULTS = { blocking: true, route: 'writer', origin: 'text' }

function packFinding(f) {
  const out = {}
  for (const k of ['blocking', 'route', 'direction', 'origin']) if (f[k] !== FINDING_DEFAULTS[k]) out[k] = f[k]
  return out
}

function pendingFindings(p) {
  return Object.entries((p || {}).findings || {}).flatMap(([doc, items]) => Object.entries(items).flatMap(([item_id, fs]) => Object.entries(fs).map(([id, f]) => ({ id, doc, item_id, ...FINDING_DEFAULTS, ...f }))))
}

function pendingView(p, routes) {
  const findings = pendingFindings(p)
  const part = partitionFindings(findings.filter((f) => (routes || {})[itemKey(f)] !== 'exhausted'))
  const flow = (p || {}).flow || {}
  return {
    ...p,
    findings,
    bundles: part.bundles.map((b) => ((flow[b.doc] || {})[b.item_id] ? { ...b, flow: flow[b.doc][b.item_id] } : b)),
    decision: part.decision,
    blocking: uniq(findings.filter((f) => f.blocking).map((f) => f.id)),
  }
}

// canonicalText・fnv: prd.js は sha256 を計算できないので、next_args が打ち直しで変わっていないかをこの 2 つで照合する。
function canonicalText(v) {
  if (Array.isArray(v)) return `[${v.map(canonicalText).join(',')}]`
  if (v && typeof v === 'object') return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${k}:${canonicalText(v[k])}`).join(',')}}`
  return `${typeof v}:${String(v)}`
}

function fnv(text) {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0
  return h.toString(16).padStart(8, '0')
}

// ENV_ARGS: 司令塔が next_args で変えてよい欄（run のデータではない環境。どれを変えてよいかは references/workflow-io.md §3）。
// nextArgsHash はこれと state_hash の外をすべて覆う。state だけを覆うと workspace・existing_docs・from の写し間違いが通る。
// 最上位の空の配列・オブジェクトは欄が無いのと同じに扱う（prd.js がそう読むので、打ち直しで [] を落としても意味は変わらない）。
const ENV_ARGS = ['skillDir', 'role_opts']
const isEmpty = (v) => v === undefined || (Array.isArray(v) ? !v.length : v && typeof v === 'object' && !Object.keys(v).length)
const nextArgsHash = (a) => fnv(canonicalText(Object.fromEntries(Object.entries(a).filter(([k, v]) => k !== 'state_hash' && !ENV_ARGS.includes(k) && !isEmpty(v)))))

// reRaised: 既裁定の再出（定義は references/workflow-io.md §4 の段 8）。writer の適用の申告は読まない（生成した側の自己判定になる）。
// prevAgain（前のパスの再出）も裁定を持ち越す。持ち越さないと 2 回目の再出が新しい blocking として数えられる。
function reRaised(prevFindings, prevAgain, findings, state, changed) {
  const passed = new Set(state.passed || [])
  const rulings = {}
  for (const [id, k] of Object.entries(state.about || {})) if (k && k.startsWith('finding:') && passed.has(id)) rulings[k.slice(8)] = [...(rulings[k.slice(8)] || []), id]
  const key = (f) => `${itemKey(f)}\u0000${f.direction}`
  const ruled = {}
  const add = (f, ids) => {
    if (f && ids && ids.length) ruled[key(f)] = uniq([...(ruled[key(f)] || []), ...ids])
  }
  for (const f of prevFindings || []) add(f, rulings[f && f.id])
  // このパスの段 6 に渡した decision の指摘の裁定は、この段 7 で渡した。それ以外（前のパスの再出・尽きた項目の持ち越し）の裁定は前に渡し終えている。
  const decided = new Set(pendingView(state.pending, state.item_routes).decision)
  const given = new Set((prevFindings || []).filter((f) => f && decided.has(f.id) && rulings[f.id]).map(key))
  for (const f of prevAgain || []) add(f, f && f.rulings)
  const bundled = new Set(pendingView(state.pending, state.item_routes).bundles.map(itemKey))
  const onlyRuling = (f) => !((changed || {})[f.doc] || []).includes(f.item_id) || (!bundled.has(itemKey(f)) && given.has(key(f)))
  return (findings || [])
    .filter((f) => f && f.id && ruled[key(f)] && onlyRuling(f))
    .map((f) => ({ id: f.id, doc: f.doc, item_id: f.item_id, direction: f.direction, rulings: ruled[key(f)] }))
}

// recurringItems: 前のパスと今のパスの両方で blocking の項目。origin は問わない（text 由来でも 2 パス続けば改稿で直っていない）。
function recurringItems(prevFindings, findings, again) {
  const drop = new Set((again || []).map((x) => x.id))
  const blockingItems = (fs) => new Set((fs || []).filter((f) => f && f.blocking && !drop.has(f.id)).map(itemKey))
  const before = blockingItems(prevFindings)
  return uniq([...blockingItems(findings)].filter((k) => before.has(k)))
}

// routeRecurring: 回数で打ち切らず、改稿で直らない項目の経路を decision → hold → 尽きた、と進める。
function routeRecurring(recurring, state) {
  const nextOf = { decision: 'hold', hold: 'exhausted', exhausted: 'exhausted' }
  const out = {}
  for (const k of recurring || []) out[k] = nextOf[(state.item_routes || {})[k]] || 'decision'
  return out
}

// rework: 差し戻しのループはここにだけ置く。不合格の件数が 0 になるまで回し、前の回より減らなければ止める（同じ指摘を返し続ける
// 生成者を上限まで回さない）。
// defect.stop は差し戻しても直らない不合格（生成者のどの書き込みでも消えない）で、生成者に回さずに止める。
async function rework(first, defectOf, redo, limit) {
  let got = first
  let defect = defectOf(got)
  for (let i = 0; defect && !defect.stop && i < limit; i++) {
    const again = await redo(got, defect, i + 1)
    if (!again || again.error) return { got, defect, error: again && again.error ? again : null }
    const next = defectOf(again)
    const stalled = next && next.count >= defect.count
    got = again
    defect = next
    if (stalled) break
  }
  return { got, defect, error: null }
}

// closedInCycle: before で引かないと、前の cycle で写した裁定を次の cycle（G1 の後の 3a' など）で写し直す。
function closedInCycle(state, before, kind) {
  const done = new Set(before || [])
  const settled = new Set(usableResolutions(state).filter((id) => !done.has(id)))
  return uniq(Object.entries(state.about || {}).filter(([id, k]) => k && k.startsWith(`${kind}:`) && settled.has(id)).map(([, k]) => k.slice(kind.length + 1)))
}

// recurring: 再発した項目の ledger 由来の指摘も flow に写す（判定表の入力の次元として起こさないと、次のパスで同じ項目に戻る）。
function settledFlowFindings(pendingFindings, state, before, recurring) {
  const closed = new Set(closedInCycle(state, before, 'finding'))
  const toFlow = (f) => f.origin === 'flow' || (f.origin === 'ledger' && (recurring || {})[itemKey(f)])
  return uniq((pendingFindings || []).filter((f) => f && toFlow(f) && closed.has(f.id)).map((f) => f.id))
}

function rolesByItem(history, findings, role) {
  const out = JSON.parse(JSON.stringify(history || {}))
  for (const f of findings || []) {
    if (!f || !f.item_id) continue
    out[f.item_id] = uniq([...(out[f.item_id] || []), role])
  }
  return out
}

// scopedAuditPlan: grounding は新しく入った規範文を見るので、変えた文書すべてに起動する。先頭を指名するのは、
// 改稿の後は必ず 1 体以上起動し、木全体の diff の照合が飛ばないため。
function scopedAuditPlan(changes, roles) {
  const plan = []
  const docs = Object.keys(changes || {}).sort()
  let crossItems = []
  for (const doc of docs) {
    const items = uniq(changes[doc])
    plan.push({ role: 'grounding', doc, items })
    const im = items.filter((i) => (roles[i] || []).includes('implementer'))
    if (im.length) plan.push({ role: 'implementer', doc, items: im })
    crossItems = crossItems.concat(items.filter((i) => (roles[i] || []).includes('crossDoc')))
  }
  if (crossItems.length) plan.push({ role: 'crossDoc', doc: 'all', items: uniq(crossItems) })
  if (plan.length) plan[0].designated = true
  return plan
}

// undeclaredChanges: 生成した側だけに検証の範囲を決めさせないため、申告に無い項目には監査を追加で起動する。
function undeclaredChanges(diff, declared) {
  const all = uniq([...((diff && diff.changed) || []), ...((diff && diff.added) || []), ...((diff && diff.removed) || [])])
  return minus(all, declared)
}

// undeclaredByDoc: 監査は文書単位で起動するので、木全体の集合だけでは、何も申告しなかった単位の文書に監査が届かない。
function undeclaredByDoc(diff, changes, targetDocs) {
  const byDoc = diff && diff.by_doc
  const out = {}
  if (byDoc && typeof byDoc === 'object') {
    for (const doc of Object.keys(byDoc).sort()) {
      const extra = minus(undeclaredChanges(byDoc[doc], []), (changes && changes[doc]) || [])
      if (extra.length) out[doc] = extra
    }
    return out
  }
  const extra = undeclaredChanges(diff, uniq(Object.values(changes || {}).flat()))
  if (extra.length) for (const doc of uniq(targetDocs || [])) out[doc] = extra
  return out
}

function parseStdout(text) {
  if (text && typeof text === 'object') return text
  const s = String(text || '').trim()
  if (!s) return null
  const line = s.split('\n').filter((l) => l.trim().startsWith('{')).pop()
  try {
    return line ? JSON.parse(line) : null
  } catch {
    return null
  }
}

function planCheckOf(text) {
  const o = parseStdout(text)
  return o && Number.isInteger(o.findings) && typeof o.content_sha256 === 'string' && o.content_sha256 ? o : null
}

// flowCheckOf: rulings は doc_check flow --rulings の stdout（裁定と合否の resolutions を持つ）。台帳の集合と検証し残しはそこからだけ読むので、
// 生成者の stdout には求めない（全 resolution の行を毎回写すと、返り値の出力が台帳の大きさに比例して増える）。
function flowCheckOf(text, rulings = false) {
  const o = parseStdout(text)
  const ok = o && Number.isInteger(o.findings) && Number.isInteger(o.open) && typeof o.content_sha256 === 'string' && o.content_sha256
  if (!ok || ![...(rulings ? ['resolutions'] : []), 'unverified', 'failed_current', 'open_only', 'stale_refs', 'open_ids', 'pair_keys'].every((k) => Array.isArray(o[k]))) return null
  const codes = o.codes && typeof o.codes === 'object' && !Array.isArray(o.codes) ? Object.values(o.codes) : null
  return codes && codes.every(Array.isArray) && codes.reduce((n, xs) => n + xs.length, 0) === o.findings ? o : null
}

// splitFlowFindings: 生成者（役の名前）が消せる指摘の件数（own）と、settle の flow-framer に回す指摘（handoff）と、表に無い符号（unknown）。
function splitFlowFindings(fc, generator) {
  const out = { own: 0, handoff: [], unknown: [] }
  for (const [code, ats] of Object.entries(fc.codes).sort()) {
    const fixers = (FIXERS_BY_CODE[code] || {}).fixers
    if (!fixers) out.unknown.push(code)
    else if (fixers.includes(generator)) out.own += ats.length
    else out.handoff.push(...ats.map((at) => ({ code, at })))
  }
  return out
}

const flowFindings = (fc) => Object.entries(fc.codes).sort().flatMap(([code, ats]) => ats.map((at) => ({ code, at })))

// flowDefect: 生成者への差し戻しの件数は、生成者が消せる指摘だけで数える。表に無い符号は誰が消せるか分からないので、差し戻さずに止める。
function flowDefect(fc, generator, path) {
  if (!fc) return { count: Infinity, text: 'doc_check flow の stdout がありません' }
  const split = splitFlowFindings(fc, generator)
  if (split.unknown.length) return { count: Infinity, stop: true, text: `doc_check flow の指摘に直し手の表（FIXERS_BY_CODE）に無い符号があります: ${split.unknown.join(', ')}` }
  if (!split.own) return null
  const left = split.handoff.length ? `。${split.handoff.map((x) => `${x.at}（${x.code}）`).join(', ')} は flow-framer が settle で直すので触らない` : ''
  return { count: split.own, text: `doc_check flow の指摘が ${split.own} 件あります（${path}）${left}` }
}

function conflictsCheckOf(text) {
  const o = parseStdout(text)
  return o && Number.isInteger(o.pairs) && Array.isArray(o.pair_keys) ? o : null
}

// questionsDefect: 検査した ID まで照合するのは、別の ID の集合で通した stdout を合格として受け取らないため。
function questionsDefect(text, ids) {
  const o = parseStdout(text)
  if (!o || o.check !== true || !Array.isArray(o.ids) || !Number.isInteger(o.findings)) return { count: Infinity, text: 'doc_check questions --check の stdout がありません' }
  const unchecked = minus(ids, o.ids)
  if (unchecked.length) return { count: Infinity, text: `検査していない問いがあります: ${unchecked.join(', ')}` }
  if (o.findings > 0) return { count: o.findings, text: `形の不合格が ${o.findings} 件あります` }
  return null
}

// REQUIRES: from の入口ごとに、state に要る値。script はファイルを読めないので、ここに無ければ再開できない。
const REQUIRES = {
  1: [],
  2: ['units', 'plan_sha256'],
  3: ['units', 'flow_digest'],
  '3a': ['units', 'flow_digest', 'gate', 'questions'],
  '3b': ['units', 'flow_digest', 'gate', 'questions'],
  4: ['units', 'flow_digest'],
  5: ['units', 'flow_digest'],
  6: ['units', 'flow_digest', 'audit', 'pending', 'pass', 'settled_written'],
  "3a'": ['units', 'flow_digest', 'audit', 'pending', 'pass', 'settled_written', 'gate', 'questions'],
  7: ['units', 'flow_digest', 'audit', 'pending', 'pass', 'settled_written'],
  8: ['units', 'flow_digest', 'audit', 'pending', 'pass', 'settled_written', 'revised'],
  9: ['units', 'tree_digest'],
}
function stateErrors(from, state) {
  if (!Object.prototype.hasOwnProperty.call(REQUIRES, from)) return [`from "${from}" は段の境界ではありません（${Object.keys(REQUIRES).join(' / ')}）`]
  return REQUIRES[from].filter((k) => !state || state[k] === undefined || state[k] === null).map((k) => `from "${from}" には state.${k} が要ります`)
}

// runWithRetry: 応答しなかった呼び出しだけを 1 回出し直す。未実施は失敗であって「指摘 0 件」ではない。
// 複数件を出して全件が落ちたときは出し直さない（セッション上限・レート制限のような環境側の事情で、同じ実行の
// 中では結果が変わらない）。1 件だけのときは、全滅でも出し直す（母数 1 の全滅は環境側の証拠にならない）。
// 添字は runtime が渡すものを持ち回る。pipeline の返り値が入力順に並ぶ保証は文書化されていないので、位置から
// 逆算すると、並びが変わったときに成功した項目を出し直し、落ちた項目を出し直さない。
const runWithRetry = async (label, items, issue, ok) => {
  const run = (idxs, attempt) => pipeline(idxs, (i) => Promise.resolve(issue(items[i], attempt)).then((r) => ({ i, r })))
  const results = new Array(items.length).fill(null)
  for (const e of await run(items.map((_, i) => i), 1)) if (e) results[e.i] = e.r
  const missing = () => results.map((r, i) => (ok(r) ? -1 : i)).filter((i) => i >= 0)
  const failed = missing()
  if (!failed.length) return results
  if (items.length > 1 && failed.length === items.length) {
    log(`${label}: ${failed.length}/${items.length} 件すべてが応答しませんでした。環境側の事情と判断し、出し直しません。`)
    return results
  }
  log(`${label}: ${failed.length}/${items.length} 件が応答しなかったので出し直します`)
  for (const e of await run(failed, 2)) if (e && ok(e.r)) results[e.i] = e.r
  const left = missing()
  if (left.length) log(`${label}: 出し直しても ${left.length} 件が応答しませんでした`)
  return results
}

// PURE_END

const STR = { type: 'string' }
const INT = { type: 'integer', minimum: 0 }
const STRS = { type: 'array', items: STR }
const ABOUT = {
  type: 'object',
  properties: { open: STR, pair: { type: 'array', items: STR, minItems: 2, maxItems: 2 }, finding: STR, tbd: STR, verification: STR },
}
const RULED = { type: 'array', items: { type: 'object', properties: { id: STR, about: ABOUT }, required: ['id', 'about'] } }

const INTAKE_SCHEMA = {
  type: 'object',
  properties: {
    plan_check: STR,
    units: {
      type: 'array',
      minItems: 1,
      items: { type: 'object', properties: { id: STR, docs: { type: 'array', items: STR, minItems: 1 }, depends_on: STRS }, required: ['id', 'docs', 'depends_on'] },
    },
  },
  required: ['plan_check', 'units'],
}

const FLOW_CHECK_SCHEMA = { type: 'object', properties: { flow_check: STR, restore_check: STR }, required: ['flow_check'] }
const RESTORE_SCHEMA = { type: 'object', properties: { restore_check: STR }, required: ['restore_check'] }
const RESET_SCHEMA = { type: 'object', properties: { reset_check: STR }, required: ['reset_check'] }

const FLOW_SCHEMA = {
  type: 'object',
  properties: { flow_check: STR, conflicts_check: STR, questions_check: STR, plan_check: STR },
  required: ['flow_check', 'conflicts_check'],
}

const RESOLVER_SCHEMA = {
  type: 'object',
  properties: {
    ruled: RULED,
    questions: RULED,
    holds: RULED,
    supersedes: STRS,
    free_text: STRS,
    routes: { type: 'array', items: { type: 'object', properties: { id: STR, unit: STR }, required: ['id', 'unit'] } },
    resolutions_sha256: STR,
    flow_check: STR,
    conflicts_check: STR,
    questions_check: STR,
  },
  required: ['ruled', 'questions', 'holds', 'supersedes', 'free_text', 'routes', 'resolutions_sha256', 'flow_check'],
}

const VERIFIER_SCHEMA = {
  type: 'object',
  properties: {
    pass: STRS,
    fail: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: STR, kind: { type: 'string', enum: ['value_as_method', 'not_reproduced', 'insufficient_grounds', 'mapping'] }, reason: STR },
        required: ['id', 'kind', 'reason'],
      },
    },
    resolutions_sha256: STR,
    flow_check: STR,
  },
  required: ['pass', 'fail', 'resolutions_sha256', 'flow_check'],
}

const WRITER_SCHEMA = {
  type: 'object',
  properties: {
    unit: STR,
    docs: {
      type: 'array',
      items: { type: 'object', properties: { key: STR, digest: STR, doc_check_findings: INT, doc_check_blocking: INT }, required: ['key', 'digest', 'doc_check_findings', 'doc_check_blocking'] },
    },
    changed_items: STRS,
    open_tbd: STRS,
    new_tbd: STRS,
    applied_findings: STRS,
    applied_routes: STRS,
    resolutions_sha256: STR,
  },
  required: ['unit', 'docs', 'changed_items', 'open_tbd', 'new_tbd', 'applied_findings', 'applied_routes', 'resolutions_sha256'],
}

const AUDIT_SCHEMA = {
  type: 'object',
  properties: {
    path: STR,
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: STR,
          doc: STR,
          item_id: STR,
          blocking: { type: 'boolean' },
          route: { type: 'string', enum: ['writer', 'decision'] },
          direction: { type: 'string', enum: DIRECTIONS },
          origin: { type: 'string', enum: ORIGINS },
        },
        required: ['id', 'doc', 'item_id', 'blocking', 'route', 'direction', 'origin'],
      },
    },
    designated: {
      type: 'object',
      properties: {
        doc_check: STR,
        diff: {
          type: 'object',
          properties: {
            stdout: STR,
            changed: STRS,
            added: STRS,
            removed: STRS,
            by_doc: { type: 'object', additionalProperties: { type: 'object', properties: { changed: STRS, added: STRS, removed: STRS }, required: ['changed', 'added', 'removed'] } },
          },
          required: ['stdout', 'changed', 'added', 'removed', 'by_doc'],
        },
        diff_error: STR,
        audited: STR,
        tree_digest: STR,
      },
    },
  },
  required: ['path', 'findings'],
}

const input = (typeof args === 'string' ? JSON.parse(args) : args) || {}
const W = String(input.workspace || '').replace(/\/+$/, '')
const SKILL_DIR = String(input.skillDir || '').replace(/\/+$/, '')
const ENTRY = input.entry || 'new'
const FROM = String(input.from || '1')
if (!W.startsWith('/')) throw new Error('args.workspace に workspace の絶対パスを渡してください（S0 で作ったもの）')
if (!SKILL_DIR.startsWith('/')) throw new Error('args.skillDir にこのスキルの絶対パスを渡してください')
if (!ENTRIES.includes(ENTRY)) throw new Error(`args.entry は ${ENTRIES.join(' / ')} のどれかです（review / update は使わない）: "${ENTRY}"`)
if (!STAGES.includes(FROM)) throw new Error(`args.from は段の境界（${STAGES.join(' / ')}）のどれかです: "${FROM}"`)
const EXISTING = Array.isArray(input.existing_docs) ? input.existing_docs : []
if (ENTRY !== 'new' && !EXISTING.length) throw new Error(`entry "${ENTRY}" には args.existing_docs（W に置いた既存文書のキーと fixed）が要ります`)
const FIXED_KEYS = uniq(EXISTING.filter((d) => d.fixed).map((d) => d.key))
const KEEP_KEYS = uniq(EXISTING.map((d) => d.key))
const OPTS = applyRoleOverrides(ROLE_OPTS, input.role_opts)
if (input.state !== undefined && input.state_hash !== nextArgsHash(input)) {
  throw new Error('args が next_args の版と違います（state_hash が合いません）。環境の欄（ENV_ARGS）のほかは、返った next_args を変えずに渡し直してください（references/workflow-io.md §3）')
}
const state = JSON.parse(JSON.stringify(input.state || {}))
const startErrors = stateErrors(FROM, state)
if (startErrors.length) throw new Error(`再開に要る値が args.state にありません: ${startErrors.join(' / ')}`)

const BASE_ARGS = { workspace: W, skillDir: SKILL_DIR, entry: ENTRY, existing_docs: EXISTING, role_opts: input.role_opts || {} }
const argsFrom = (from, st) => {
  const out = { ...BASE_ARGS, from, state: JSON.parse(JSON.stringify(st)) }
  return { ...out, state_hash: nextArgsHash(out) }
}
const nextArgs = (from) => argsFrom(from, state)

let running = null
let entryState = null

// 段の token と restore の扱いは references/workflow-io.md §3 が正。token は state から決める（nonce はプロンプトのキャッシュを壊す）。
// 書く token（try で変わる）を戻す token と別にするのは、resumeFromRunId の再生が入口の restore を流し直しても、その run の書き込みを戻さないため。
const ENTRY_CHECK = REQUIRES[FROM].includes('flow_digest')
const RESUME_TX = state.tx && state.tx.restore && state.tx.stage === FROM ? state.tx : null
if (RESUME_TX && !(Number.isInteger(RESUME_TX.try) && RESUME_TX.try > 0)) throw new Error('args.state.tx の try が再実行の回数ではありません（返った next_args を変えずに渡し直してください）')
// txTry は state.tx に置かない（段を出た後の next_args を止まらなかった run と同じにする）。
let txTry = 0
const txToken = () => `t${state.tx.seq}${txTry ? `r${txTry}` : ''}`
const TX_ROLES = ['intake', 'flowFramer', 'resolver', 'verifier', 'writer']

function finish(status, extra) {
  const written = new Set(state.settled_written || [])
  const holds = uniq(state.holds || [])
  return {
    status,
    questions_path: null,
    report_path: null,
    next_args: null,
    open_tbd: openTbdOf(state),
    holds: holds.filter((id) => written.has(id)),
    hold_drafts: holds.filter((id) => !written.has(id)),
    missed: uniq(state.missed || []),
    integrity: state.integrity || [],
    notices: state.notices || [],
    undeclared: state.undeclared || {},
    stop_reason: null,
    passes: state.pass || 0,
    item_routes: state.item_routes || {},
    ...extra,
  }
}
// blocked で同じ段からやり直させるときは、その段に入った時点の state を渡す（W は再実行の入口の restore で段に入った時点に戻る）。
// tx.flow は止まった run が最後に照合を通した flow の版で、段に入った時点の版と同じなら載せない（next_args の上限）。
// 入口の restore が返る前に止まったら W は戻っていないかもしれないので、前の回の戻す token と版を渡し直す。
// tx.flow を読むのは restore が flow.json を戻したときの照合だけなので、flow を書く役のいない段（段 2 と settle を持つ段の外）には載せない。
let restorePending = Boolean(RESUME_TX)
const writesFlow = (stage) => stage === '2' || Object.hasOwn(ASKS, stage)
const rerunFlow = () => (!writesFlow(running) ? undefined : restorePending ? RESUME_TX.flow : state.flow_digest !== entryState.flow_digest ? state.flow_digest : undefined)
const rerunTx = () => {
  const flow = rerunFlow()
  return { ...entryState.tx, try: txTry + 1, restore: restorePending ? RESUME_TX.restore : txToken(), ...(flow !== undefined ? { flow } : {}) }
}
// 段 1 からの再実行は state を持たない。段 1 の入口の reset が W を S0 の直後に戻すので、止まった run の state を運ぶと W と食い違う。
const rerunArgs = (from) => (from === '1' ? argsFrom('1', {}) : argsFrom(from, from === running ? { ...entryState, tx: rerunTx() } : state))
const blocked = (reason, rerunFrom, extra) => finish('blocked', { reason, next_args: rerunFrom ? rerunArgs(rerunFrom) : null, ...extra })

const noteIntegrity = (line) => {
  state.integrity = uniq([...(state.integrity || []), line])
}

// ---------------------------------------------------------------- プロンプトの部品（本文も JSON も埋め込まずパスで渡す）

const fileKey = (s) => String(s).replace(/[^A-Za-z0-9._-]+/g, '__')

// header: 作業用ディレクトリは起動の label ごとに分ける。役と段の組で分けると、同じ波の writer や文書ごとの
// 監査役が同じディレクトリを使い、片方の後片付けが他方の作業中のファイルを消す。
function header(role, stage, label) {
  return [
    `最初に ${SKILL_DIR}/agents/${ROLE_FILES[role]} を Read し、その指示に従う。`,
    `ファイルと返り値の形は ${SKILL_DIR}/schemas/agent-contracts.md の ${[...COMMON_SECTIONS, ...CONTRACT_SECTIONS[role]].map((s) => `「## ${s}」`).join('・')} を正とする。見出しを Grep で探し、その節だけを offset/limit で Read する（全体を読むと以後の全ターンに載り続ける）。`,
    `W（workspace）: ${W}`,
    `SKILL_DIR: ${SKILL_DIR}`,
    `entry: ${ENTRY}`,
    `段: ${stage}`,
    `作業用ディレクトリ: ${W}/tmp/${fileKey(label)}/`,
    ...(TX_ROLES.includes(role) ? [`トークン: ${txToken()}`] : []),
  ].join('\n')
}

function groundsBlock() {
  return [
    '根拠一式（パス）:',
    `- ${W}/input.md、${W}/answers/*.md、${W}/decisions.json、${W}/resolutions.json、${W}/flow.json、${W}/plan.json`,
    `- 根拠にしてよい resolution（合格・回答済み）: ${list(usableResolutions(state))}`,
    `- 保持規則として規範文で書く resolution（hold）: ${list(uniq(state.holds))}`,
    `- 無効な決定（覆された・検証に落ちた。根拠にしない）: ${list(invalidIds(state, failedFlow).decisions)}`,
    `- 出典が検証に落ちた流れの要素（この要素を根拠に規範を書かない）: ${list(invalidIds(state, failedFlow).flow)}`,
    `- 開いている TBD: ${list(openTbdOf(state))}`,
  ].join('\n')
}

function existingNote() {
  if (ENTRY === 'new') return ''
  const rows = EXISTING.map((d) => `- ${d.key}${d.fixed ? '（fixed: 固定の入力。書き換えない）' : ''}`)
  return ['既存文書（W に置いてある。topic を維持する）:', ...rows].join('\n')
}

const cli = (mode, rest) => `node ${SKILL_DIR}/scripts/doc_check.mjs ${mode} --workspace ${W}${rest ? ` ${rest}` : ''}`
const RULINGS_FLOW = cli('flow', '--rulings')

// unchecked: 最後の独立な doc_check flow（verifier か flow-check が実行したもの）より後に起動した resolver の label と stdout。
// resolver はどの呼び出しでも台帳を書き、台帳の kind・supersedes・hold は flow.json を変えずに flow の指摘と stale_refs を変える。
// 印は起動の前に付ける（書いてから応答しなかった resolver の後も flow-check が数え直す）。判断に使う stdout は independentFlow だけが返し、
// 段の境界で印が残っていれば止める（段を回す loop）。
// 呼び出しの場所ごとに flow-check を足す形にすると、足し忘れた呼び出しの後の判断が resolver の自己申告で決まる。
let unchecked = null

// seen: 最後に受け取った独立な doc_check flow の stdout（verifier か flow-check が実行したもの）。flow か台帳を書く役の起動で消える。
// 段を出るときの不変条件（exitViolation）はこれで確かめる。
// wrote: この run で flow か台帳を書く役を起動したか。seen が無いまま段を出るとき、書いていれば、書いたものを独立な stdout で確かめていない。
// failedFlow: 最後に見た独立な stdout の failed_current。writer に「根拠にしない要素」として渡す（state に写すと、止まった run の後で W と食い違う）。
// carry: W の resolution のうち、今の版に合否が無いか、script の持つ合否（passed・failed_ids）と合わないもの（reconcile が置く）。次の verifier に検証させる。
let seen = null
let wrote = false
let failedFlow = []
let carry = []
// holdFails: hold のまま続けて検証に落ちた回数（ID ごと。合格で消す）。落ちた保持規則は writer に渡すと検証を通っていない規範文が本文に入るので、1 回目は
// reholdFailed が書き直させて検証し直し、続けて 2 回目に落ちれば止める。変換（convertFailed）で hold になった裁定の不合格は、値の裁定が落ちたもので
// 保持規則の検証ではないので数えない（変換した分はもう検証しない）。
const holdFails = {}
const see = (fc) => {
  seen = fc
  failedFlow = fc.failed_current
}

// reconcile: 同じ run の中で返り値の届かなかった裁定（出し直した resolver の 1 回目が書いたもの）の about と ruling を W から受け取り、
// 今の版に合否の無い resolution と、script の持つ合否が今の版の合否と合わない resolution（検証の後に書き換えたもの・受け取っていないもの・
// 求めていない合否が W にあるもの）を passed・failed_ids から外して carry にする。W の合否を passed・failed_ids に足すことはしない: 足すと、検証を求めていない合否が
// 回答済みの問いを不合格にし、根拠からも回答待ちからも黙って消す。合否は、検証を求めた verifier の返り値（absorbVerifier）からだけ入る。
// 返すのは、ここで初めて state に入った問い（返り値で受け取っていないので、形の検査を通っていない）。
function reconcile(fc) {
  const rs = fc.resolutions.filter((x) => RESOLUTION_ID.test(x.id))
  const where = (pred) => rs.filter(pred).map((x) => x.id)
  if (rs.length) state.about = { ...(state.about || {}), ...Object.fromEntries(rs.map((x) => [x.id, aboutKey(x.about)])) }
  const known = new Set(state.questions || [])
  const adopted = where((x) => x.ruling === 'question' && !known.has(x.id))
  if (adopted.length) state.questions = uniq([...(state.questions || []), ...adopted])
  holdsFromW(fc)
  const passed = new Set(state.passed || [])
  const failed = new Set(state.failed_ids || [])
  const held = (id) => (passed.has(id) ? 'pass' : failed.has(id) ? 'fail' : null)
  carry = where((x) => !x.verdict || x.verdict !== held(x.id))
  if (carry.length) {
    state.passed = minus(state.passed, carry)
    state.failed_ids = minus(state.failed_ids, carry)
  }
  forget(carry)
  return adopted
}

// holdsFromW: state.holds を W の今の ruling に合わせる。差し戻しや回答で hold でなくなった ID を残すと、保持規則として数えられ、
// 検証に落ちても変換に回らず、書き直しの回数（holdFails）で止まる。W に無い ID は、W から判断できないので残す。
function holdsFromW(fc) {
  const rs = fc.resolutions.filter((x) => RESOLUTION_ID.test(x.id))
  const notHold = rs.filter((x) => x.ruling !== 'hold').map((x) => x.id)
  const next = minus([...(state.holds || []), ...rs.filter((x) => x.ruling === 'hold').map((x) => x.id)], notHold)
  if (canonicalText(next) !== canonicalText(uniq(state.holds))) state.holds = next
  for (const id of notHold) delete holdFails[id]
}

// forget: 書き直した resolution は、前の書き込みで writer に渡した版ではない。written に残すと、書き直した裁定が改稿のどの writer にも渡らない。
function forget(ids) {
  if (state.settled_written && ids.length) state.settled_written = minus(state.settled_written, ids)
}

// once: resolutions_sha256 の無い resolver の返り値を受け取ると、verifier・writer との照合が黙って飛ぶ。出し直すと
// 済んだ put（flow の put / del を含む）を二重に走らせるので、段を頭からやり直させる。
async function once(label, role, prompt, schema, phaseTitle) {
  if (role === 'resolver') unchecked = { tag: label.replace(/^resolver:/, ''), responded: false, claimed: null }
  if (role === 'resolver' || role === 'flowFramer') {
    seen = null
    wrote = true
  }
  const [r] = await runWithRetry(label, [label], (_, attempt) => agent(prompt, { ...OPTS[role], schema, phase: phaseTitle, label: attempt > 1 ? `${label}#retry` : label }), (x) => Boolean(x))
  if (r && role === 'resolver') unchecked = { ...unchecked, responded: true, claimed: flowCheckOf(r.flow_check) }
  if (r && (role === 'verifier' || role === 'flowCheck')) unchecked = null
  if (r && role === 'resolver' && !r.resolutions_sha256) throw Object.assign(new Error(`${label}: resolver が resolutions_sha256 を返しませんでした`), { rerunStage: true })
  const badIds = r && role === 'resolver' ? [...(r.ruled || []), ...(r.questions || []), ...(r.holds || [])].map((x) => x && x.id).concat(r.free_text || []).filter((id) => !RESOLUTION_ID.test(id)) : []
  if (badIds.length) throw Object.assign(new Error(`${label}: resolver が resolution の ID の形（${RESOLUTION_ID.source}）に合わない ID を返しました: ${badIds.map((id) => `「${id}」`).join(', ')}`), { rerunStage: true })
  return r || null
}

// reRuled: 回答を当てる呼び出しでない resolver が ruled に入れた問いは、問いでなくなった（3b で組み直した flow から決まった）。
// 3a・3a' の ruled は回答が当たった問いなので、ここでは引かない。
// free_text は ruled に無くても検証に回す。回答の対応づけは解釈を含み、合格しないと回答済みにならない。
function absorbResolver(r, reRuled) {
  const { ids: aboutIds, about } = resolverIds(r)
  const ids = uniq([...aboutIds, ...(r.free_text || [])])
  state.about = { ...(state.about || {}), ...about }
  state.questions = minus(uniq([...(state.questions || []), ...(r.questions || []).map((x) => x.id)]), reRuled ? (r.ruled || []).map((x) => x.id) : [])
  state.holds = uniq([...(state.holds || []), ...(r.holds || []).map((x) => x.id)])
  state.superseded = uniq([...(state.superseded || []), ...(r.supersedes || [])])
  const seenRoutes = new Set((state.routes || []).map((x) => `${x.unit}|${x.id}`))
  state.routes = [...(state.routes || []), ...(r.routes || []).filter((x) => !seenRoutes.has(`${x.unit}|${x.id}`)).map((x) => ({ unit: x.unit, id: x.id }))]
  state.resolutions_sha256 = r.resolutions_sha256
  forget(ids)
  return ids
}

// absorbVerifier: 違う flow を見た合否を台帳の集合に入れると、検証していない版の合格が残る。
// flow の食い違いを同じ段のやり直しで直せるのは、この段の生成者が flow の stdout を返した（flowChecked）ときだけである。
// そうでない段（例: resolver が起動しない段 3）でやり直しても、flow.json も state.flow_digest も変わらず同じ所で止まる。
// generator: この cycle で flow.json を書いた役（null は誰も書いていない）。その役に消せない指摘は settle の flow-framer が直すので、
// ここでは止めない。誰も書いていなければ、指摘は台帳の書き込みで出たもので、flow-framer にしか直せない。
// ledgerMoved: settle の flow-framer が返した後に台帳が変わったか（settle の外では null）。flow-framer の返した stdout は指摘 0 件でしか
// 受け取らないので、変わっていればこの stdout の指摘は台帳の書き込みで出たもので、生成者に差し戻しても消えず settle の次の回に渡す。
// 変わっていなければ生成者の過少申告である。
function absorbVerifier(v, expectedSha, stage, flowChecked, generator, ledgerMoved = null) {
  const fc = flowCheckOf(v.flow_check, true)
  if (!fc) return { error: `resolver-verifier（段 ${stage}）が doc_check flow の stdout を返しませんでした`, rerun: true }
  if (fc.content_sha256 !== state.flow_digest) {
    noteIntegrity(`verifier（段 ${stage}）が検査した flow.json（${fc.content_sha256}）が、生成者が検査した版（${state.flow_digest}）と違う`)
    const noFixer = flowChecked ? '' : '。この段には flow を書く生成者がいないので、同じ段からやり直しても直らない。所有表の外で flow.json を書いたものを確かめる'
    return { error: `段 ${stage}: verifier が検査した flow.json が、生成者が doc_check flow で検査した版と違います${noFixer}`, rerun: flowChecked }
  }
  const told = claimedIssues
  claimedIssues = null
  const differ = told ? ['pair_keys', ...(told.open_ids ? ['open_ids'] : [])].filter((k) => canonicalText(uniq(told[k]).sort()) !== canonicalText(uniq(fc[k]).sort())) : []
  if (differ.length) {
    noteIntegrity(`${told.by} が申告した ${differ.join('・')} が、verifier（段 ${stage}）の doc_check flow の stdout と違う`)
    return { error: `段 ${stage}: 裁定に回した未裁定の論点（${differ.join('・')}）が、verifier が同じ flow.json で数えたものと違います（${told.by} の申告）`, rerun: true }
  }
  const split = splitFlowFindings(fc, generator)
  if (split.unknown.length) return { error: `段 ${stage}: verifier の doc_check flow に直し手の表（FIXERS_BY_CODE）に無い符号があります: ${split.unknown.join(', ')}`, rerun: false }
  if (ledgerMoved) split.own = 0
  if (split.own && ledgerMoved === false) noteIntegrity(`${generator}（段 ${stage}）が返した doc_check flow の stdout に無い指摘が、同じ flow.json と台帳の verifier の stdout にある`)
  if (split.own) return { error: `段 ${stage}: verifier の doc_check flow に指摘が ${split.own} 件あります（${W}/checks/flow.json）`, rerun: true }
  const onlyFlow = (ids) => (ids || []).filter((id) => /^F-/.test(id))
  const unrecorded = [
    ...onlyFlow((v.fail || []).map((f) => f.id)).filter((id) => !fc.failed_current.includes(id)),
    ...onlyFlow(v.pass).filter((id) => fc.unverified.includes(id)),
  ]
  if (unrecorded.length) {
    noteIntegrity(`verifier（段 ${stage}）が返した F- の合否（${unrecorded.join(', ')}）が、doc_check flow の stdout（verifications.json の今の版）に無い`)
    return { error: `段 ${stage}: verifier が返した F- の合否 ${unrecorded.join(', ')} が verifications.json に記録されていません（put しなかったか、put の前に doc_check flow を実行した）`, rerun: true }
  }
  const notFlow = (ids) => (ids || []).filter((id) => !/^F-/.test(id))
  const failIds = notFlow((v.fail || []).map((f) => f.id))
  holdsFromW(fc)
  const held = new Set(state.holds || [])
  for (const id of failIds) if (held.has(id)) holdFails[id] = (holdFails[id] || 0) + 1
  for (const id of v.pass || []) delete holdFails[id]
  // passed は resolution だけを持つ。D- の合格は次の行で failed_ids から引けば足り、運ぶと next_args が決定の数に比例して増える。
  state.passed = minus(uniq([...(state.passed || []), ...(v.pass || []).filter((id) => RESOLUTION_ID.test(id))]), failIds)
  state.failed_ids = minus(uniq([...(state.failed_ids || []), ...failIds]), v.pass || [])
  see(fc)
  if (expectedSha && v.resolutions_sha256 !== expectedSha) {
    noteIntegrity(`verifier が検証した resolutions.json（${v.resolutions_sha256}）が、resolver が書き終えた版（${expectedSha}）と違う`)
  }
  return null
}

function resolverPrompt(label, stage, task) {
  return [
    header('resolver', stage, label),
    groundsBlock(),
    `${W}/checks/conflicts.json、${W}/open.json、${W}/verifications.json、${W}/precedent.json も読む。`,
    existingNote(),
    task,
    `問いを出したら、返る前に \`${cli('questions', '--ids <question にした ID をカンマで> --check')}\` を実行し、stdout を加工せずに questions_check に入れる。`,
  ]
    .filter(Boolean)
    .join('\n\n')
}

// keepFlow: flow.json を書く権限の無い resolver の呼び出し（回答を当てる 3a・3a' 以外のすべて）。呼び出しの後の flow.json が
// state.flow_digest のままかを、その stdout で照合する（flowKept）。stdout を任意にすると、書き換えた版の stdout を返した
// 呼び出しが新しい digest として受け入れられ、verifier もその版と一致して通る。
const keepFlow = (task, why = '後に flow を照合する verifier が起動しない') =>
  `${task}\n\nこの呼び出しでは flow.json を書かない（${why}）。返る前に \`${cli('flow')}\` を実行し、stdout を加工せずに flow_check に入れる。`

// flowExtra: VERIFY_ALL の外でも検証させる要素（settle で直させたのに書き換えなかった不合格の要素）。
const flowExtra = (must) => (must.length ? `あわせて検証する: flow.json の要素 ${list(must)} の source（decision は各 case の source も。書き換えていなくても）。これらの F- も pass / fail に入れる。` : '')

// flowKept: flow.json を変えていたら同じ段をやり直しても元に戻らないので、rerun を付けない。
function flowKept(stage, ret) {
  const fc = flowCheckOf(ret.flow_check)
  if (!fc) return { error: `resolver（段 ${stage}）が doc_check flow の stdout を返しませんでした`, rerun: true }
  if (fc.content_sha256 === state.flow_digest) return null
  noteIntegrity(`resolver（段 ${stage}）の後の flow.json（${fc.content_sha256}）が、検証を通った版（${state.flow_digest}）と違う`)
  return { error: `段 ${stage}: flow.json を書く権限の無い resolver の呼び出しの後で flow.json が変わっています。所有表の外で flow.json を書いたものを確かめる`, rerun: false }
}

// VERIFY_ALL: 検証する要素は W から取らせる。script は書き換えた要素を返り値でしか知らないので、一覧だけにすると、応答の前に書いて出し直された
// 呼び出しの書き込みや所有表の外の書き込みを、誰も検証しないまま通す。
const VERIFY_ALL = `検証の最初に \`${cli('flow')}\` を実行し、その unverified のうち failed_current に無い要素すべての source（decision は各 case の source も）を検証して、その F- も pass / fail に入れる。`

function verifierPrompt(label, stage, ids, extra) {
  return [
    header('verifier', stage, label),
    `検証する resolution の ID: ${list(ids)}`,
    VERIFY_ALL,
    extra || '',
    `検証の最後に \`${RULINGS_FLOW}\` を実行し、stdout を加工せずに flow_check に入れる。`,
  ]
    .filter(Boolean)
    .join('\n\n')
}

// askVerifier: 検証を求めていない resolution の合否は数えない。数えると、回答待ちの問いが差し戻しと変換で保持規則に書き換わり、
// 回答済みの問いは不合格の集合に入って黙って消える。W に put された合否が script の持つ合否と違えば、reconcile が carry にして検証させ直す。
async function askVerifier(label, stage, given, extra, phaseTitle) {
  const ids = uniq([...given, ...carry])
  const v = await once(label, 'verifier', verifierPrompt(label, stage, ids, extra), VERIFIER_SCHEMA, phaseTitle)
  if (!v) return null
  carry = minus(carry, [...v.pass, ...v.fail.map((f) => f.id)])
  const unasked = (id) => RESOLUTION_ID.test(id) && !ids.includes(id)
  const dropped = uniq([...v.pass, ...v.fail.map((f) => f.id)].filter(unasked))
  if (dropped.length) state.notices = uniq([...(state.notices || []), `verifier（${label}）が検証を求めていない ${list(dropped)} の合否を返した（合否に数えていない）`])
  return { ...v, pass: v.pass.filter((id) => !unasked(id)), fail: v.fail.filter((f) => !unasked(f.id)) }
}

// 変換した分はもう検証しない（検証のループを増やすと、差し戻しの上限が意味を失う）。
// resolver が doc_check flow の stdout を返したら、検証する ID が無くても verifier を起動する。flow の閉包は、生成者の
// stdout と別の agent の stdout の照合でしか script から確かめられない。
async function resolveCycle(stage, opt) {
  const before = usableResolutions(state)
  const res = await ruleAndVerify(stage, opt)
  if (res.error) return res
  // 自由記述の回答は、対応づけが verifier に合格して初めて回答が当たったことになる。
  if (opt.answered) state.answered = uniq([...(state.answered || []), ...opt.answered.filter((id) => (res.passed || []).includes(id))])
  const se = await settle(stage, res.verified || null, opt.phase, before, opt.allowQuestions)
  if (se) return se
  return res
}

const takeFlow = async (stage, r, phaseTitle, writesFlow, required) => (writesFlow ? applyReturnedFlow(stage, r, phaseTitle, required) : flowKept(stage, r) || { checked: false })

async function ruleAndVerify(stage, opt) {
  const phaseTitle = opt.phase
  const writesFlow = Boolean(opt.answered)
  const entryDigest = state.flow_digest
  const flowWriter = () => (state.flow_digest !== entryDigest ? 'resolver' : null)
  const asTask = (t) => (writesFlow ? `${t}\n\ndoc_check flow の指摘のうち ${FRAMER_ONLY_CODES.join('・')} は触らない（settle の flow-framer が open.json に起票して直す。resolver.md の「回答の反映」）。` : keepFlow(t, '裁定を flow に写すのは flow-framer である'))
  const wasQuestion = new Set(pendingQuestions(state))
  let ids = []
  let flowChecked = Boolean(opt.flowChanged)
  if (opt.task) {
    const label = `resolver:${stage}`
    const r = await once(label, 'resolver', resolverPrompt(label, stage, asTask(opt.task)), RESOLVER_SCHEMA, phaseTitle)
    if (!r) return { error: `resolver（段 ${stage}）が応答しませんでした` }
    ids = absorbResolver(r, !writesFlow)
    if (opt.targets) state.missed = uniq([...(state.missed || []), ...missedTargets(opt.targets, r)])
    const fe = await takeFlow(stage, r, phaseTitle, writesFlow, Boolean(opt.requireFlow))
    if (fe.error) return fe
    flowChecked = flowChecked || fe.checked
    const qe = await checkQuestions(stage, stage, r, phaseTitle, opt.recheck)
    if (qe) return qe
    if (opt.answered) {
      const free = new Set(r.free_text || [])
      // 検証に落ちて問いに変えた裁定は、候補が検証を通っていないので、候補の選択でも verifier に回す。
      const failed = new Set(state.failed_ids || [])
      const byOption = (r.ruled || []).map((x) => x.id).filter((id) => opt.answered.includes(id) && !free.has(id) && !failed.has(id))
      state.answered = uniq([...(state.answered || []), ...byOption])
      ids = minus(ids, byOption)
    }
    if (fe.changed) {
      const pe = await ruleUnruled(stage, stage, fe.conflicts, null, phaseTitle, opt.allowQuestions)
      if (pe.error) return pe
      ids = uniq([...ids, ...pe.ids])
    }
  }
  if (!ids.length && !carry.length && !opt.verifyExtra && !flowChecked) return { ok: true, passed: [] }
  const v1Label = `verifier:${stage}v`
  const v1 = await askVerifier(v1Label, `${stage}v`, ids, opt.verifyExtra || '', phaseTitle)
  if (!v1) return { error: `resolver-verifier（段 ${stage}v）が応答しませんでした` }
  const ve1 = absorbVerifier(v1, state.resolutions_sha256, `${stage}v`, flowChecked, flowWriter())
  if (ve1) return ve1
  let verified = flowCheckOf(v1.flow_check, true)
  if (!v1.fail.length) return { ok: true, passed: v1.pass, verified }

  const rework = v1.fail.map((f) => `- ${f.id}: ${f.kind}（${f.reason}）`).join('\n')
  const r2Label = `resolver:${stage}'`
  const r2 = await once(
    r2Label,
    'resolver',
    resolverPrompt(r2Label, `${stage}'（差し戻し）`, asTask(`verifier が不合格にした項目だけを 1 回直す（resolver.md の「差し戻し」）。D- / F- の項目は about を {verification} にした resolution で置き換える。\n${rework}${opt.allowQuestions ? '' : '\nこの段では依頼者に聞けないので、question ではなく hold にする。'}`)),
    RESOLVER_SCHEMA,
    phaseTitle
  )
  if (!r2) return { error: `resolver（段 ${stage}' の差し戻し）が応答しませんでした` }
  const unfixed = unreturned(`${stage}'`, r2, v1.fail.map((f) => f.id).filter((id) => RESOLUTION_ID.test(id)), ['ruled', 'questions', 'holds', 'free_text'])
  if (unfixed) return { error: unfixed }
  // 落ちた要素は問いにも保持規則にも変えられないので、{verification} の裁定が無いと settle に写す値も、進めてよい理由も無い。
  const ruledAbout = new Set(Object.values(resolverIds(r2).about))
  const unruledEls = v1.fail.map((f) => f.id).filter((id) => /^F-/.test(id) && !ruledAbout.has(`verification:${id}`))
  if (unruledEls.length) return { error: `段 ${stage}': 検証に落ちた要素 ${list(unruledEls)} の about を {verification} にした resolution を resolver が返しませんでした`, rerun: true }
  let ids2 = absorbResolver(r2, !writesFlow)
  const fe2 = await takeFlow(`${stage}'`, r2, phaseTitle, writesFlow, false)
  if (fe2.error) return fe2
  flowChecked = flowChecked || fe2.checked
  const qe2 = await checkQuestions(stage, `${stage}'`, r2, phaseTitle, null)
  if (qe2) return qe2
  if (fe2.changed) {
    const pe2 = await ruleUnruled(stage, `${stage}'`, fe2.conflicts, null, phaseTitle, opt.allowQuestions)
    if (pe2.error) return pe2
    ids2 = uniq([...ids2, ...pe2.ids])
  }
  const v2Label = `verifier:${stage}v'`
  const v2 = await askVerifier(v2Label, `${stage}v'`, ids2, '', phaseTitle)
  if (!v2) return { error: `resolver-verifier（段 ${stage}v' の再検証）が応答しませんでした` }
  const ve2 = absorbVerifier(v2, state.resolutions_sha256, `${stage}v'`, flowChecked, flowWriter())
  if (ve2) return ve2
  verified = flowCheckOf(v2.flow_check, true)
  const passed = uniq([...minus(v1.pass, v2.fail.map((f) => f.id)), ...v2.pass])
  const rh = await reholdFailed(stage, `${stage}'`, phaseTitle)
  if (rh && rh.error) return rh
  if (rh) verified = rh.fc
  // 変換は resolution を question か hold に書き換えるだけで、決定や flow の要素は変えられない。落ちた要素は settle が直させる（failedOpen）。
  const toConvert = v2.fail.filter((f) => RESOLUTION_ID.test(f.id) && !(state.holds || []).includes(f.id))
  if (!toConvert.length) return { ok: true, passed, verified }
  const ce = await convertFailed(stage, stage, toConvert, phaseTitle, opt.allowQuestions, wasQuestion)
  if (ce) return ce
  return { ok: true, passed, verified }
}

// independentFlow: 判断（settle の起動・残りの数え上げ・直す役の割り当て）に使う doc_check flow の stdout。最後の verifier の後に
// resolver を起動していたら（unchecked）、その resolver と別の agent（flow-check）に実行し直させ、その stdout だけを使う。
// verifier の stdout があれば、閉じた O- を引く要素（open_only）はそこから取る。その後の resolver は flow と合格の集合を変えない
// （変換と保持規則への変換は onlyAsked、flow は flowKept で確かめる）。
async function independentFlow(verified, phaseTitle) {
  if (!unchecked) return { fc: verified }
  const { tag, responded, claimed } = unchecked
  const label = `flow-check:${tag}`
  const x = await once(label, 'flowCheck', [header('flowCheck', tag, label), `実行する: \`${RULINGS_FLOW}\`。stdout を加工せずに flow_check に入れて返す。`].join('\n\n'), FLOW_CHECK_SCHEMA, phaseTitle)
  const fc = x && flowCheckOf(x.flow_check, true)
  if (!fc) return { error: `flow-check（段 ${tag}）が doc_check flow の stdout を返しませんでした`, rerun: true }
  if (fc.content_sha256 !== state.flow_digest) {
    noteIntegrity(`flow-check（段 ${tag}）が検査した flow.json（${fc.content_sha256}）が、検証を通った版（${state.flow_digest}）と違う`)
    return { error: `段 ${tag}: resolver の後に flow.json が変わっています。所有表の外で flow.json を書いたものを確かめる`, rerun: false }
  }
  const unknown = Object.keys(fc.codes).filter((code) => !FIXERS_BY_CODE[code])
  if (unknown.length) return { error: `段 ${tag}: flow-check の doc_check flow に直し手の表（FIXERS_BY_CODE）に無い符号があります: ${unknown.join(', ')}`, rerun: false }
  see(fc)
  const { resolutions: _, ...plain } = fc
  const differ = !responded ? [] : claimed ? uniq([...Object.keys(plain), ...Object.keys(claimed)].filter((k) => canonicalText(plain[k]) !== canonicalText(claimed[k]))) : ['stdout']
  if (differ.length) noteIntegrity(`resolver（段 ${tag}）が返した doc_check flow の stdout が、flow-check が同じ flow.json で実行した stdout と ${differ.join('・')} で違う`)
  if (!verified) return { fc }
  const stale = [...verified.stale_refs, ...fc.stale_refs.filter((x) => !verified.stale_refs.some((y) => y.el === x.el && y.ref === x.ref))]
  return { fc: { ...fc, open_only: verified.open_only, stale_refs: stale } }
}

// unreturned: 求めた ID を resolver が求めた種類で返したか。台帳の集合に入れる前に確かめる。返らない ID はどの検証にも変換にも
// 回らず、合否も保持規則も無いまま台帳に残る。
const KIND_WORDS = { ruled: 'ruled', questions: 'question', holds: 'hold', free_text: 'free_text' }
const idsOf = (r, k) => (r[k] || []).map((x) => (typeof x === 'string' ? x : x && x.id))
function unreturned(stage, r, asked, kinds) {
  const got = kinds.flatMap((k) => idsOf(r, k))
  const missing = asked.filter((id) => !got.includes(id))
  return missing.length ? `段 ${stage}: 求めた ${list(missing)} を resolver が ${kinds.map((k) => `${KIND_WORDS[k]} ${kinds.length > 1 ? 'にも' : 'に'}`).join(' ')}返しませんでした` : null
}

// onlyAsked: ID を question か hold に変える呼び出しの返り値の決まりは契約 §resolver。
function onlyAsked(stage, r, asked, kinds) {
  const missing = unreturned(stage, r, asked, kinds)
  if (missing) return missing
  const extra = uniq(['ruled', 'questions', 'holds'].flatMap((k) => idsOf(r, k).filter((id) => !kinds.includes(k) || !asked.includes(id))))
  if (extra.length) return `段 ${stage}: 変換を求めていない ${list(extra)} を resolver が返しました（この呼び出しは求めた ID を ${kinds.map((k) => KIND_WORDS[k]).join(' か ')} にするだけ）`
  return null
}

// answerKinds: 値を決めずに返す種類。聞けない段の question は、聞くゲートにも保持規則への変換（holdLeft は段の最後に 1 回）にも
// 届かないまま回答待ちで残るので、聞けない段の settle の中の resolver からは受け取らない。
const answerKinds = (allowQuestions) => (allowQuestions ? ['questions', 'holds'] : ['holds'])

function outsideKinds(stage, r, kinds) {
  const extra = uniq(['ruled', 'questions', 'holds'].filter((k) => !kinds.includes(k)).flatMap((k) => idsOf(r, k)))
  return extra.length ? `段 ${stage}: ${list(extra)} を resolver が ${kinds.map((k) => KIND_WORDS[k]).join('・')} 以外で返しました（この段では依頼者に聞けない）` : null
}

// convertFailed: 検証に落ちた裁定（RS-）を、値を決めずに理由で question か hold に書き換える。変換した分はもう検証しない
// （検証のループを増やすと、差し戻しの上限が意味を失う）。
// wasQuestion: 差し戻しの cycle の入口で回答待ちだった問い。settle の verifier の合否は askVerifier がその回に裁定した ID に限るので渡さない。
async function convertFailed(stage, owner, fails, phaseTitle, allowQuestions, wasQuestion = new Set()) {
  const convert = fails.map((f) => `- ${f.id} → ${(f.kind === 'value_as_method' || wasQuestion.has(f.id)) && allowQuestions ? 'question' : 'hold'}（${f.kind}）`).join('\n')
  log(`段 ${owner}: 検証に落ちた ${fails.length} 件を、理由で問いと保持規則に分けます（検証はもう回しません）`)
  const label = `resolver:${owner}-convert`
  const r = await once(
    label,
    'resolver',
    resolverPrompt(label, `${owner}（変換）`, keepFlow(`次の項目は検証に落ちた。値を決めずに、指定のとおり question（候補と影響を付ける）か hold（保持規則と Issue の文案）に書き換える。ID は変えない。\n${convert}`)),
    RESOLVER_SCHEMA,
    phaseTitle
  )
  if (!r) return { error: `resolver（段 ${owner} の変換）が応答しませんでした` }
  const bad = onlyAsked(owner, r, fails.map((f) => f.id), answerKinds(allowQuestions))
  if (bad) return { error: bad }
  absorbResolver(r)
  return flowKept(`${owner}-convert`, r) || checkQuestions(stage, `${owner}-convert`, r, phaseTitle, null)
}

// claimedIssues: 未裁定の論点を選ぶのに使った組と O- は、flow を書いた生成者の自己申告である。組と O- は flow.json・decisions.json・
// open.json だけで決まり、その後の resolver も verifier も書かないので、次の verifier の doc_check flow（同じ flow.json と照合済み）と
// 一致しなければ、申告から漏れた論点が裁定されないまま進む。照合は absorbVerifier の 1 か所で行う。
let claimedIssues = null
const claimIssues = (by, pairKeys, openIds) => {
  claimedIssues = { by, pair_keys: pairKeys, open_ids: openIds || null }
}

// unruled: about の種類（pair: / open:）ごとに、どの resolution の about にもまだ無いキー。同じ呼び出しで裁定中の論点（まだ
// 合格していない）も about には入っているので、closedKeys だけで引くと裁定中の論点を二重に渡す。
const unruled = (keys, kind) => {
  const known = new Set(Object.values(state.about || {}).filter((k) => k && k.startsWith(`${kind}:`)))
  return uniq(keys).filter((k) => !known.has(k))
}

// unruledIssues: flow を書いた後の、まだどの resolution の about にも無い O- と組。3b の組み直しの後も settle の後も、この集合を裁定に回す。
const unruledIssues = (openIds, pairKeys) => ({ opens: unruled((openIds || []).map((id) => `open:${id}`), 'open'), pairs: unruled(pairKeys, 'pair') })

// ruleUnruled: 組は要素の id・label・constrained_by で決まるので、回答や裁定の反映で要素を足すと、まだ誰も裁定していない組が生まれる。
// settle の flow-framer は open.json に O- を足しうる（kind が invariant の O- で破壊的な工程を縛る）ので、その O- も同じ呼び出しで裁定に回す。
// openIds を渡すのは open.json を書く flow-framer の後だけ（resolver は open.json を書かない。それ以外は null）。
async function ruleUnruled(stage, owner, conflictsText, openIds, phaseTitle, allowQuestions) {
  const cc = conflictsCheckOf(conflictsText)
  if (!cc) return { error: `段 ${stage}: flow を変えた呼び出しが doc_check conflicts の stdout を返しませんでした`, rerun: true }
  claimIssues(`段 ${owner} で flow を書いた生成者`, cc.pair_keys, openIds)
  return ruleIssues(stage, owner, cc.pair_keys, openIds, phaseTitle, allowQuestions)
}

// ruleIssues: pairKeys・openIds のうち、どの resolution の about にも無い組と O- を 1 回の resolver に裁定させる。
async function ruleIssues(stage, owner, pairKeys, openIds, phaseTitle, allowQuestions) {
  const { opens, pairs } = unruledIssues(openIds, pairKeys)
  if (!opens.length && !pairs.length) return { ids: [] }
  const tag = opens.length ? 'opens' : 'pairs'
  const label = `resolver:${owner}-${tag}`
  const task = [
    `flow を変えた後に、まだ裁定の無い論点がある。これだけを裁定する（resolver.md の「flow を変えた後の未裁定の論点」）。`,
    pairs.length ? `- まだ裁定の無い組（${W}/checks/conflicts.json）: ${list(pairs)}` : '',
    opens.length ? `- まだ裁定の無い open（${W}/open.json）: ${list(opens.map((k) => k.slice(5)))}` : '',
    allowQuestions ? '' : 'この段では依頼者に聞けないので、question ではなく hold にする。',
  ]
    .filter(Boolean)
    .join('\n')
  const r = await once(label, 'resolver', resolverPrompt(label, `${owner}（未裁定の論点）`, keepFlow(task, '組と未決の裁定は flow を変えない')), RESOLVER_SCHEMA, phaseTitle)
  if (!r) return { error: `resolver（段 ${owner} の未裁定の論点）が応答しませんでした` }
  const outside = outsideKinds(`${owner}-${tag}`, r, ['ruled', ...answerKinds(allowQuestions)])
  if (outside) return { error: outside }
  const ids = absorbResolver(r)
  state.missed = uniq([...(state.missed || []), ...missedTargets([...opens, ...pairs], r)])
  const kept = flowKept(`${owner}-${tag}`, r)
  if (kept) return kept
  const qe = await checkQuestions(stage, `${owner}-${tag}`, r, phaseTitle, null)
  if (qe) return qe
  return { ids }
}

const FRAME_RUN = `実行する: \`${cli('flow')}\` を 0 件になるまで（3 回まで）、最後に \`${cli('conflicts')}\`。最後に実行した 2 つの stdout を加工せずに flow_check と conflicts_check に入れる。`

const reworkLabel = (label, n) => (n === 1 ? label : `${label}-${n}`)

async function frameFlow(label, lines, phaseTitle) {
  const prompt = (l) => lines(l).filter(Boolean).join('\n\n')
  const read = (x) => ({ fc: flowCheckOf(x.flow_check), cc: conflictsCheckOf(x.conflicts_check), conflicts: x.conflicts_check, questions_check: x.questions_check, plan_check: x.plan_check })
  const defectOf = (x) => {
    const { fc, cc } = read(x)
    return flowDefect(fc, 'flowFramer', `${W}/checks/flow.json`) || (cc ? null : { count: Infinity, text: 'doc_check conflicts の stdout がありません' })
  }
  const r = await once(label, 'flowFramer', prompt(label), FLOW_SCHEMA, phaseTitle)
  if (!r) return { error: `${label} が応答しませんでした` }
  const done = await rework(r, defectOf, (_, d, n) => {
    const l = reworkLabel(`${label}:rework`, n)
    return once(l, 'flowFramer', `${prompt(l)}\n\n返した stdout が不合格だった: ${d.text}。直して返す。`, FLOW_SCHEMA, phaseTitle)
  }, MAX_CHECK_REWORK)
  const got = read(done.got)
  // 閉じていない版でも W の flow.json は flow-framer が書いた版で、照合を通った書き込みとして入口の照合（enterFromDisk）に渡す。
  if (got.fc) state.flow_digest = got.fc.content_sha256
  if (done.defect) return { error: `flow が閉じていません: ${done.defect.text}`, rerun: !done.defect.stop }
  return got
}

// settle: 閉じた O- を出典に持つ「未決」の終端は閉包の検査を通るので、ここで拒否しないと未決のまま文書に届く。
// 値を決める呼び出しではないので resolver にしない（段 3・6 の resolver は flow を書かない）。
// about の種類のうち open・finding・verification を写し、supersedes で覆された決定を引く要素（stale_refs）も直させる。pair は見ない
// （flow を変えた後の新しい組は ruleUnruled が裁定に回すが、組の裁定を flow に写す経路は無い）。tbd は writer が本文で閉じる。
// flow の指摘（codes）はすべて flow-framer に渡す。verifier の stdout に残る指摘は生成者に消せないもの（符号か、台帳の書き込みで出たもの）
// だけで（生成者が消せる分は absorbVerifier が止める）、flow-check の stdout にはその後の resolver が台帳を変えて出た指摘も出る。どちらも flow-framer にしか直せない。
// 残りが 0 になるまで回し、減らなければ止める。
// 不合格の要素（failedOpen）は W の verifications.json から取る。この cycle で閉じた裁定から取ると、前の cycle で回答待ちだった検証の裁定が
// 回答で閉じた要素を、誰も直さないまま段を出る。検証の裁定（D- は stale_refs に出るので F- だけ）が合格していれば、その裁定を写させ、
// 無ければ落ちた理由で直させる。
async function settle(stage, verified, phaseTitle, before, allowQuestions) {
  const checked = await verifyLeft(stage, 'left', verified, phaseTitle, allowQuestions)
  if (checked.error) return checked
  if (!checked.fc) return null
  const fc = checked.fc
  const settled = new Set(usableResolutions(state))
  const ruled = (el) => verificationRulings(state, el).some((id) => settled.has(id))
  const failed = failedOpen(fc, state, true)
  const first = {
    left: settledTerminals(fc.open_only, state),
    found: settledFlowFindings(pendingFindings(state.pending), state, before, (state.pending || {}).recurring),
    verdicts: failed.filter(ruled),
    stale: fc.stale_refs,
    handoff: flowFindings(fc),
    redo: failed.filter((el) => !ruled(el)),
  }
  if (!first.left.length && !first.found.length && !first.verdicts.length && !first.stale.length && !first.handoff.length && !first.redo.length) return null
  const r1 = await settleRound(stage, 1, first, phaseTitle, allowQuestions)
  if (r1.error) return r1
  const done = await rework(r1, (x) => x.residual, (x, _, n) => settleRound(stage, n + 1, x.next, phaseTitle, allowQuestions), MAX_SETTLE_ROUNDS - 1)
  if (done.error) return done.error
  return done.defect ? { error: `段 ${stage}: 裁定の反映の後も直っていません（${done.defect.text}）` } : null
}

// adopt: 独立な stdout を state に写し（reconcile）、ここで初めて受け取った問いの形を検査させる。返り値で受け取った問いは返る前に
// 検査されているが、W から受け取った問いは誰も検査していない。形の崩れた問いは、ゲートで司令塔が導出するときに初めて落ち、戻る段が無い。
async function adopt(stage, tag, fc, phaseTitle) {
  const adopted = reconcile(fc)
  if (!adopted.length) return { fc }
  const qe = await checkQuestions(stage, `${stage}-${tag}`, {}, phaseTitle, adopted)
  if (qe) return qe
  const again = await independentFlow(fc, phaseTitle)
  if (again.fc) reconcile(again.fc)
  return again
}

// verifyLeft: 判断に使う stdout（independentFlow）を取って W の裁定を state に写し（reconcile）、今の版に合否の無い要素か carry が
// 残っていれば verifier に検証させ、検証に落ちたまま問いにも保持規則にもなっていない裁定（unconverted）を変換する（書き直す役は起動しない）。
// 残るのは、応答の前に台帳を書いた resolver を出し直したとき、前の verifier が W の対象を検証し残したとき、問いの形の修正が検証した問いを
// 書き換えたとき、所有表の外の書き込みがあったときである。段を頭からやり直させずにここで拾う。ここの verifier の検証し残しは拾う役がもう無いので、
// 段をやり直させる。
async function verifyLeft(stage, tag, verified, phaseTitle, allowQuestions) {
  const now = await independentFlow(verified, phaseTitle)
  if (now.error || !now.fc) return now
  const took = await adopt(stage, tag, now.fc, phaseTitle)
  if (took.error) return took
  let fc = took.fc
  if (unjudged(fc).elements.length || carry.length) {
    const v = await askVerifier(`verifier:${stage}v-${tag}`, `${stage}v（検証を通っていないもの）`, [], '', phaseTitle)
    if (!v) return { error: `resolver-verifier（段 ${stage}v-${tag}）が応答しませんでした`, rerun: true }
    const ve = absorbVerifier(v, null, `${stage}v-${tag}`, false, null)
    if (ve) return ve
    state.resolutions_sha256 = v.resolutions_sha256
    fc = flowCheckOf(v.flow_check, true)
    reconcile(fc)
    const elements = unjudged(fc).elements
    if (elements.length || carry.length) {
      return { error: `段 ${stage}: verifier の後も、今の版に合否の無い要素（${list(elements)}）か、合否が W の今の版と合わない resolution（${list(carry)}）が残っています（${W}/verifications.json）`, rerun: true }
    }
  }
  const rh = await reholdFailed(stage, `${stage}-${tag}`, phaseTitle)
  if (rh && rh.error) return rh
  if (rh) {
    fc = rh.fc
    reconcile(fc)
  }
  const toConvert = unconverted(fc).map((x) => ({ id: x.id, kind: x.fail_kind || '理由は verifications.json' }))
  if (!toConvert.length) return { fc }
  const ce = await convertFailed(stage, `${stage}-${tag}`, toConvert, phaseTitle, allowQuestions)
  if (ce) return ce
  const after = await independentFlow(fc, phaseTitle)
  if (after.fc) reconcile(after.fc)
  return after
}

async function settleRound(stage, n, m, phaseTitle, allowQuestions) {
  const tag = reworkLabel(`${stage}-settle`, n)
  const settled = new Set(usableResolutions(state))
  const closers = (key) => uniq(Object.entries(state.about || {}).filter(([id, k]) => k === key && settled.has(id)).map(([id]) => id))
  const recurring = (state.pending || {}).recurring || {}
  const recurFound = m.found.filter((id) => pendingFindings(state.pending).some((f) => f.id === id && recurring[itemKey(f)]))
  // settle が del した要素を、回答待ちの問いの候補の flow_refs が指したままだと、ゲートで司令塔の doc_check questions が止まり、戻る段が無い。
  const waiting = pendingQuestions(state)
  const got = await frameFlow(`flow-framer:${tag}`, (label) => [
    header('flowFramer', `${stage}（裁定の反映${n > 1 ? ` ${n} 回目` : ''}）`, label),
    `裁定を flow に写す（flow-framer.md の「裁定の反映」）。`,
    m.left.some((x) => x.open) ? `要素（閉じた O- ← 閉じた resolution）: ${m.left.filter((x) => x.open).map((x) => `${x.el}${x.case ? ` の case ${x.case}` : ''}（${x.open} ← ${list(closers(`open:${x.open}`))}）`).join(', ')}` : '',
    m.left.some((x) => x.constraint) ? `constrained_by の閉じた O-（要素 の O- ← 閉じた resolution）: ${m.left.filter((x) => x.constraint).map((x) => `${x.el} の ${x.constraint} ← ${list(closers(`open:${x.constraint}`))}`).join(', ')}` : '',
    m.found.length ? `指摘（ID ← それを裁定した resolution）: ${m.found.map((id) => `${id}（← ${list(closers(`finding:${id}`))}）`).join(', ')}` : '',
    recurFound.length ? `このうち ${list(recurFound)} は改稿で直らず再発した項目の指摘である。その項目の振る舞いを判定表の入力の次元として起こす。` : '',
    m.verdicts.length ? `検証の裁定（要素 ← 裁定した resolution）: ${m.verdicts.map((id) => `${id} ← ${list(closers(`verification:${id}`))}`).join(', ')}` : '',
    m.stale.length ? `覆された決定か検証に落ちた不変条件を出典か constrained_by に持つ要素（要素 ← その決定）: ${m.stale.map((x) => `${x.el} ← ${x.ref}`).join(', ')}` : '',
    m.redo.length ? `検証に落ちた要素（理由は ${W}/verifications.json）: ${list(m.redo)}` : '',
    m.handoff.length ? `flow の指摘（要素: 何が無いか か符号。直し方は ${W}/checks/flow.json の fix）: ${m.handoff.map((x) => `${x.at}: ${FIXERS_BY_CODE[x.code].handoff || x.code}`).join(', ')}` : '',
    FRAME_RUN,
    waiting.length ? `続けて \`${cli('questions', `--ids ${waiting.join(',')} --check`)}\` を実行する（返し方は §flow-framer の返り値）。` : '',
  ], phaseTitle)
  if (got.error) return { error: `段 ${stage}（裁定の反映）: ${got.error}`, rerun: got.rerun }
  const ledgerAtFrame = state.resolutions_sha256
  const qe = await checkQuestions(tag, tag, { questions_check: got.questions_check }, phaseTitle, waiting)
  if (qe) return qe
  const fc = got.fc
  const pe = await ruleUnruled(tag, tag, got.conflicts, fc.open_ids, phaseTitle, allowQuestions)
  if (pe.error) return pe
  const vLabel = `verifier:${reworkLabel(`${stage}v-settle`, n)}`
  // 書き換えた要素は VERIFY_ALL が検証させる。直させたのに書き換えなかった不合格の要素は VERIFY_ALL から外れるので、名指しで検証させる。
  const asked = new Set([...m.left.map((x) => x.el), ...m.verdicts, ...m.stale.map((x) => x.el), ...m.redo])
  const v = await askVerifier(vLabel, `${stage}v（裁定の反映）`, pe.ids, flowExtra(fc.failed_current.filter((id) => asked.has(id))), phaseTitle)
  if (!v) return { error: `resolver-verifier（段 ${stage}v の裁定の反映）が応答しませんでした` }
  const ve = absorbVerifier(v, state.resolutions_sha256, reworkLabel(`${stage}v-settle`, n), true, 'flowFramer', state.resolutions_sha256 !== ledgerAtFrame)
  if (ve) return ve
  let vfc = flowCheckOf(v.flow_check, true)
  // flow-framer に直せない裁定（RS-）の不合格は、段 3 の差し戻しの後と同じく問いか保持規則に変える。止めると、縛る不変条件の O- を
  // 足した破壊的な工程が、裁定が落ちただけで blocked になる。
  const rh = await reholdFailed(stage, tag, phaseTitle)
  if (rh && rh.error) return rh
  if (rh) vfc = rh.fc
  const toConvert = v.fail.filter((f) => RESOLUTION_ID.test(f.id) && !(state.holds || []).includes(f.id))
  const failed = v.fail.map((f) => f.id).filter((id) => !RESOLUTION_ID.test(id))
  const ce = toConvert.length ? await convertFailed(tag, tag, toConvert, phaseTitle, allowQuestions) : null
  if (ce) return ce
  const now = await verifyLeft(stage, reworkLabel('left', n + 1), vfc, phaseTitle, allowQuestions)
  if (now.error) return now
  const after = now.fc
  const stale = after.stale_refs
  const still = settledTerminals(after.open_only, state)
  const found = flowFindings(after)
  const count = still.length + stale.length + failed.length + found.length
  const text = `閉じた未決を引く要素: ${list(still.map((x) => `${x.el}${x.case ? ` の case ${x.case}` : ''}（${x.open || x.constraint}）`))} / 覆された決定を引く要素: ${list(stale.map((x) => `${x.el}（${x.ref}）`))} / 不合格: ${list(failed)} / flow の指摘: ${list(found.map((x) => `${x.at}（${x.code}）`))}`
  if (failed.some((id) => !/^F-/.test(id))) return { error: `段 ${stage}: 裁定の反映の後も直っていません（${text}）` }
  return {
    residual: count ? { count, text } : null,
    next: { left: still, found: [], verdicts: [], stale, handoff: found, redo: failed },
  }
}

// reholdFailed: hold のまま検証に落ちた保持規則を、同じ ID のまま書き直させて検証し直す（resolver.md の「保持規則の書き直し」）。
// 書き直しても落ちるか、前に書き直した（差し戻しを含む）後に落ちたものがあれば、段の頭からやり直させる。
async function reholdFailed(stage, owner, phaseTitle) {
  const failing = Object.keys(holdFails).sort()
  if (!failing.length) return null
  const again = failing.filter((id) => holdFails[id] > 1)
  const stuck = (ids) => ({ error: `段 ${stage}: 保持規則 ${list(ids)} が書き直した後も検証に落ちました（${W}/verifications.json）。検証に落ちた保持規則は writer に渡さない`, rerun: true })
  if (again.length) return stuck(again)
  const label = `resolver:${owner}-rehold`
  const r = await once(label, 'resolver', resolverPrompt(label, `${owner}（保持規則の書き直し）`, keepFlow(`次の保持規則は検証に落ちた（理由は ${W}/verifications.json）。値を決めずに、hold（保持規則・Issue の文案・触れる項目 ID）を落ちた理由で書き直す。ID は変えない: ${list(failing)}`)), RESOLVER_SCHEMA, phaseTitle)
  if (!r) return { error: `resolver（段 ${owner} の保持規則の書き直し）が応答しませんでした` }
  const bad = onlyAsked(`${owner}-rehold`, r, failing, ['holds'])
  if (bad) return { error: bad }
  absorbResolver(r)
  const kept = flowKept(`${owner}-rehold`, r)
  if (kept) return kept
  const vLabel = `verifier:${owner}-reholdv`
  const v = await askVerifier(vLabel, `${owner}v（保持規則の書き直し）`, failing, '', phaseTitle)
  if (!v) return { error: `resolver-verifier（段 ${owner}-reholdv）が応答しませんでした`, rerun: true }
  const ve = absorbVerifier(v, state.resolutions_sha256, `${owner}-reholdv`, false, null)
  if (ve) return ve
  const still = failing.filter((id) => holdFails[id])
  if (still.length) return stuck(still)
  return { fc: flowCheckOf(v.flow_check, true) }
}

// holdLeft: 聞くゲートが残っていない問いを保持規則に変える。
async function holdLeft(stage, ids, phaseTitle) {
  const label = `resolver:${stage}-hold`
  const r = await once(label, 'resolver', resolverPrompt(label, `${stage}（保持規則への変換）`, keepFlow(`次の問いにはもう聞くゲートが残っていない。hold（保持規則・Issue の文案・触れる項目 ID）に書き換える。ID は変えない: ${list(ids)}`)), RESOLVER_SCHEMA, phaseTitle)
  if (!r) return { error: `resolver（段 ${stage} の保持規則への変換）が応答しませんでした` }
  const bad = onlyAsked(`${stage}-hold`, r, ids, ['holds'])
  if (bad) return { error: bad }
  absorbResolver(r)
  return flowKept(`${stage}-hold`, r) || settle(`${stage}-hold`, null, phaseTitle, usableResolutions(state), false)
}

async function applyReturnedFlow(stage, ret, phaseTitle, required) {
  const given = ret.flow_check !== undefined && ret.flow_check !== null
  if (!given && !required) return { checked: false }
  const defectOf = (x) => flowDefect(flowCheckOf(x.flow_check), 'resolver', `${W}/checks/flow.json`)
  const done = await rework(ret, defectOf, async (_, d, n) => {
    const label = reworkLabel(`resolver:${stage}-flow`, n)
    const again = await once(
      label,
      'resolver',
      resolverPrompt(label, `${stage}（flow の修正）`, `flow.json が閉じていない。${d.text}。その指摘だけを直す（裁定の中身は変えない）。最後に \`${cli('flow')}\` と \`${cli('conflicts')}\` を実行し、stdout を加工せずに flow_check と conflicts_check に入れて返す。`),
      RESOLVER_SCHEMA,
      phaseTitle
    )
    if (again) absorbResolver(again)
    return again
  }, MAX_CHECK_REWORK)
  const fc = flowCheckOf(done.got.flow_check)
  if (!fc) return { error: `段 ${stage}: resolver が doc_check flow の stdout を返しませんでした` }
  if (done.defect) return { error: `段 ${stage}: 回答を当てた flow が閉じていません（${done.defect.text}）`, rerun: !done.defect.stop }
  const changed = fc.content_sha256 !== state.flow_digest
  state.flow_digest = fc.content_sha256
  return { checked: true, changed, fc, conflicts: done.got.conflicts_check }
}

// ゲートで司令塔が導出するまで形を検査しないと、落ちたときに戻る段が無く、run の外で止まる。
// recheck: 返り値の questions に無くても検査させる問い（3b が組み直した flow に合わせて直す、持ち越した問い）。裁定か hold に
// 変えたものは除く。
// owner: 問いの形の修正の label に付ける段。同じ段の中で問いを返す呼び出しは複数あり、label が重なると telemetry と再開の照合が
// 呼び出しを取り違える。
async function checkQuestions(stage, owner, r, phaseTitle, recheck) {
  const settledNow = [...(r.ruled || []), ...(r.holds || [])].map((x) => x && x.id)
  let target = minus(uniq([...(r.questions || []).map((x) => x && x.id), ...(recheck || [])]), settledNow)
  if (!target.length) return null
  const done = await rework(r, (x) => (target.length ? questionsDefect(x.questions_check, target) : null), async (_, d, n) => {
    const label = reworkLabel(`resolver:${owner}-questions`, n)
    const again = await once(
      label,
      'resolver',
      resolverPrompt(
        label,
        `${owner}（問いの形の修正）`,
        keepFlow(`問い ${list(target)} が問いの形の検査を通っていない（${d.text}）。その問いの question・options だけを直し（裁定の中身は変えない）、\`${cli('questions', `--ids ${target.join(',')} --check`)}\` の stdout を加工せずに questions_check に入れて返す。`)
      ),
      RESOLVER_SCHEMA,
      phaseTitle
    )
    if (!again) return { error: `resolver（段 ${owner} の問いの形の修正）が応答しませんでした` }
    absorbResolver(again)
    const kept = flowKept(`${owner}-questions`, again)
    if (kept) return kept
    target = minus(uniq([...target, ...(again.questions || []).map((x) => x && x.id)]), (again.holds || []).map((x) => x && x.id))
    return again
  }, MAX_CHECK_REWORK)
  if (done.error) return done.error
  return done.defect ? { error: `段 ${stage}: 問いの形が検査を通りません（${done.defect.text}）` } : null
}

function needsAnswers(gate, from) {
  state.gate = gate
  const ids = pendingQuestions(state)
  return finish('needs_answers', {
    questions_path: `${W}/questions.md`,
    questions_json_path: `${W}/questions.json`,
    answers_path: `${W}/${GATE_ANSWERS[gate]}`,
    question_ids: ids,
    next_args: nextArgs(from),
  })
}

// resetEntry: 段 1 から始める run（新しい run も、段 1 からの再実行も）は、W を S0 の直後に戻した stdout を見てから intake を起動する。
// 戻さずに始めると、前のランや止まった段 1・2 の台帳の要素と欄が、再実行の put（キー単位で足す）の後にも残る。
async function resetEntry() {
  const label = 'flow-check:1-entry'
  const flags = [KEEP_KEYS.length ? `--keep ${KEEP_KEYS.join(',')}` : '', FIXED_KEYS.length ? `--fixed ${FIXED_KEYS.join(',')}` : ''].filter(Boolean).join(' ')
  const x = await once(label, 'flowCheck', [header('flowCheck', '1', label), `実行する: \`${cli('reset', flags)}\`。stdout を加工せずに reset_check に入れて返す。`].join('\n\n'), RESET_SCHEMA, PHASE_OF[1])
  const rc = parseStdout(x && x.reset_check)
  if (rc && rc.reset === true && Array.isArray(rc.removed) && canonicalText(rc.kept) === canonicalText(KEEP_KEYS) && canonicalText(rc.fixed) === canonicalText(FIXED_KEYS)) return null
  return blocked(`flow-check（段 1 の入口）が W を S0 の直後に戻した doc_check reset の stdout（残した文書 ${list(KEEP_KEYS)}、固定の文書 ${list(FIXED_KEYS)}）を返しませんでした（existing_docs の文書が W に無いと、reset は何も消さずに止まる）`, '1')
}

async function stage1() {
  const entry = await resetEntry()
  if (entry) return entry
  const prompt = (label) =>
    [
      header('intake', '1', label),
      `読む: ${W}/input.md、${W}/precedent.json（とそこに並ぶファイル）`,
      existingNote(),
      `書く: decisions.json・plan.json・open.json。返る前に \`${cli('plan')}\` を実行して指摘を直し、最後の stdout を加工せずに plan_check に入れる。`,
    ]
      .filter(Boolean)
      .join('\n\n')
  const defectOf = (x) => {
    const pc = planCheckOf(x.plan_check)
    if (!pc) return { count: Infinity, text: 'doc_check plan の stdout がありません' }
    return pc.findings > 0 ? { count: pc.findings, text: `doc_check plan の指摘が ${pc.findings} 件あります（${W}/checks/plan.json）` } : null
  }
  const first = await once('intake', 'intake', prompt('intake'), INTAKE_SCHEMA, 'Intake')
  if (!first) return blocked('intake が応答しませんでした', '1')
  const done = await rework(first, defectOf, (_, d, n) => {
    const l = reworkLabel('intake:rework', n)
    return once(l, 'intake', `${prompt(l)}\n\n返した stdout が不合格だった: ${d.text}。直して返す。`, INTAKE_SCHEMA, 'Intake')
  }, MAX_CHECK_REWORK)
  if (done.defect) return blocked(`intake の出力が検査を通りません: ${done.defect.text}`, '1')
  const r = done.got
  try {
    unitWaves(r.units)
  } catch (e) {
    return blocked(`intake の writer の単位が不正です: ${e.message}`, '1')
  }
  const inUnits = new Set(r.units.flatMap((u) => u.docs))
  const fixed = EXISTING.filter((d) => d.fixed).map((d) => d.key)
  const wrongFixed = fixed.filter((k) => inUnits.has(k))
  const lost = EXISTING.filter((d) => !d.fixed && !inUnits.has(d.key)).map((d) => d.key)
  if (wrongFixed.length) return blocked(`固定の文書が writer の単位に入っています: ${wrongFixed.join(', ')}`, '1')
  if (lost.length) return blocked(`既存文書がどの writer の単位にも入っていません（topic を変えると改稿が別名の新規執筆に化ける）: ${lost.join(', ')}`, '1')
  state.units = r.units.map((u) => ({ id: u.id, docs: uniq(u.docs), depends_on: uniq(u.depends_on) }))
  state.plan_sha256 = planCheckOf(r.plan_check).content_sha256
  return '2'
}

async function stage2() {
  const planSha = state.plan_sha256
  delete state.plan_sha256
  const got = await frameFlow('flow-framer', (label) => [
    header('flowFramer', '2', label),
    `読む: ${W}/input.md、${W}/decisions.json、${W}/precedent.json、${W}/open.json`,
    existingNote(),
    FRAME_RUN,
    `続けて \`${cli('plan')}\` を実行し、stdout を加工せずに plan_check に入れる。`,
  ], 'Flow')
  if (got.error) return blocked(`初稿を始めません（writer には flow を直す手段が無い）: ${got.error}`, got.rerun === false ? null : '2')
  // plan_check を intake の申告だけにすると、検査の後に書き換えた plan.json が通る。別の agent が実行した stdout と照合する。
  const pc = planCheckOf(got.plan_check)
  if (!pc) return blocked('flow-framer が doc_check plan の stdout を返しませんでした', '2')
  if (pc.content_sha256 !== planSha || pc.findings > 0) {
    if (pc.content_sha256 !== planSha) noteIntegrity(`flow-framer が検査した plan.json（${pc.content_sha256}）が、intake が検査した版（${planSha}）と違う`)
    return blocked(`plan.json が intake の検査を通った版ではありません（doc_check plan の指摘 ${pc.findings} 件。${W}/checks/plan.json）`, '1')
  }
  framed = { open_ids: got.fc.open_ids, pair_keys: got.cc.pair_keys }
  return '3'
}

// ASKS: settle を持つ段と、その段で依頼者に問いを返してよいか。入口の変換（enterFromDisk）も同じ値で回す（入口だけ聞けないことにすると、
// 段の本体では問いになる不合格が、入口では保持規則になる）。
const ASKS = { 3: () => true, '3a': () => state.gate === 'g0', '3b': () => true, 6: () => state.pass === 1, "3a'": () => state.gate === 'g0' }

// framed: 段 2 の flow-framer が数えた O- と組（段 3 の裁定の対象）。入口から始めた run は、入口の独立な stdout（seen）から数える。
let framed = null

async function stage3() {
  const src = seen || framed
  if (!seen) claimIssues('flow-framer（段 2）', src.pair_keys, src.open_ids)
  const { opens, pairs } = unruledIssues(src.open_ids, src.pair_keys)
  const res = await resolveCycle('3', {
    phase: 'Resolve',
    task: opens.length || pairs.length
      ? [
          `段 3（resolver.md の「段 3」）:`,
          `- まだ裁定の無い open（${W}/open.json）: ${list(opens.map((k) => k.slice(5)))}`,
          `- まだ裁定の無い組（${W}/checks/conflicts.json）: ${list(pairs)}`,
        ].join('\n')
      : null,
    verifyExtra:
      'あわせて検証する: decisions.json の source が default / precedent の決定と kind が invariant の決定すべて。これらの D- も pass / fail に入れる（open も組も 0 件でも省かない。intake の既定が残るため）。',
    allowQuestions: ASKS[3](),
  })
  if (res.error) return blocked(res.error, res.rerun === false ? null : '3')
  if (pendingQuestions(state).length) return needsAnswers('g0', '3a')
  return ENTRY === 'existing' ? '5' : '4'
}

// G0 の回答で出た問いは hold にせず 3b へ持ち越す。3b が組み直した flow から出る問いと 1 回の G0-2 で聞くためで、ここで hold に
// すると聞けたはずの問いが保持規則になる。G0-2 と G1 の後には聞くゲートが残っていない。
async function stageApply(stageId) {
  const gate = state.gate
  const pending = pendingQuestions(state)
  const allowQuestions = ASKS[stageId]()
  const res = await resolveCycle(stageId, {
    phase: 'Answers',
    task: [
      `段 ${stageId}: ${W}/${GATE_ANSWERS[gate]} の回答を、問い ${list(pending)} に当てる（resolver.md の「回答の反映」）。`,
      `実行する: \`${cli('flow')}\`（flow.json を変えなくても）→ flow_check。flow.json を変えたら \`${cli('conflicts')}\` → conflicts_check。`,
      allowQuestions ? '反映で価値に関わる新しい矛盾が出たら question にする。' : '依頼者にはもう聞けない。価値に関わる新しい矛盾は hold にする。',
    ].join('\n'),
    answered: pending,
    allowQuestions,
    requireFlow: true,
  })
  if (res.error) return blocked(res.error, res.rerun === false ? null : stageId)
  if (allowQuestions) return '3b'
  const left = pendingQuestions(state)
  if (left.length) {
    const he = await holdLeft(stageId, left, 'Answers')
    if (he) return blocked(he.error, he.rerun === false ? null : stageId)
  }
  if (stageId === "3a'") return '7'
  return ENTRY === 'existing' ? '5' : '4'
}

async function stage3b() {
  const reframe = await frameFlow('flow-framer:3b-reframe', (label) => [
    header('flowFramer', '3b（回答での組み直し）', label),
    groundsBlock(),
    `${W}/open.json も読む。`,
    existingNote(),
    '回答を入力に加えて flow を組み直す（flow-framer.md の「回答での組み直し」）。',
    FRAME_RUN,
  ], 'Answers')
  if (reframe.error) return blocked(`段 3b: ${reframe.error}`, reframe.rerun === false ? null : '3b')
  claimIssues('flow-framer:3b-reframe', reframe.cc.pair_keys, reframe.fc.open_ids)
  const { opens, pairs } = unruledIssues(reframe.fc.open_ids, reframe.cc.pair_keys)
  const carried = pendingQuestions(state)
  const res = await resolveCycle('3b', {
    phase: 'Answers',
    task:
      opens.length || pairs.length || carried.length
        ? [
            `段 3b（resolver.md の「回答での組み直しの後」）:`,
            `- まだ裁定の無い open: ${list(opens.map((k) => k.slice(5)))}`,
            `- まだ裁定の無い組（${W}/checks/conflicts.json）: ${list(pairs)}`,
            `- 3a から持ち越した問い: ${list(carried)}`,
          ].join('\n')
        : null,
    targets: [...opens, ...pairs, ...carried.map((id) => (state.about || {})[id]).filter(Boolean)],
    recheck: carried,
    flowChanged: true,
    allowQuestions: ASKS['3b'](),
  })
  if (res.error) return blocked(res.error, res.rerun === false ? null : '3b')
  if (pendingQuestions(state).length) return needsAnswers('g0-2', '3a')
  return ENTRY === 'existing' ? '5' : '4'
}

const writerLabel = (unit, mode) => `writer:${unit.id}:${mode}`

function writerPrompt(unit, mode, extra) {
  const deps = state.units.filter((u) => (unit.depends_on || []).includes(u.id)).flatMap((u) => u.docs)
  return [
    header('writer', mode === 'draft' ? '4（初稿）' : '7（改稿）', writerLabel(unit, mode)),
    groundsBlock(),
    `担当の単位: ${unit.id}（文書: ${list(unit.docs)}）。書くのは ${unit.docs.map((k) => `${W}/${k.replace('/', '-')}.md とその .meta.json`).join('、')} だけ。`,
    deps.length ? `依存先の単位の文書（読むだけ）: ${deps.map((k) => `${W}/${k.replace('/', '-')}.md`).join('、')}` : '',
    existingNote(),
    `doc_check の内部ループ: \`${cli('doc', `--doc <キー> --open-tbd "${openTbdOf(state).join(',')}"`)}\`（3 回まで）。最後に \`${cli('tree-digest', '--doc <キー>')}\` の digest を返す。`,
    extra || '',
  ]
    .filter(Boolean)
    .join('\n\n')
}

function absorbWriter(r) {
  for (const d of r.docs || []) state.docs = { ...(state.docs || {}), [d.key]: d.digest }
  state.open_tbd = uniq([...(state.open_tbd || []), ...(r.open_tbd || [])])
  state.new_tbd = uniq([...(state.new_tbd || []), ...(r.new_tbd || [])])
  if (state.resolutions_sha256 && r.resolutions_sha256 !== state.resolutions_sha256) {
    noteIntegrity(`writer ${r.unit} が読んだ resolutions.json（${r.resolutions_sha256}）が、台帳の最新（${state.resolutions_sha256}）と違う`)
  }
}

async function stage4() {
  const waves = unitWaves(state.units)
  for (const wave of waves) {
    const units = wave.map((id) => state.units.find((u) => u.id === id))
    const results = await runWithRetry(
      `初稿（${wave.join(', ')}）`,
      units,
      (u, attempt) => agent(writerPrompt(u, 'draft'), { ...OPTS.writer, schema: WRITER_SCHEMA, phase: 'Draft', label: `${writerLabel(u, 'draft')}${attempt > 1 ? '#retry' : ''}` }),
      (x) => Boolean(x)
    )
    const missing = units.filter((_, i) => !results[i]).map((u) => u.id)
    if (missing.length) return blocked(`writer が応答しませんでした（${missing.join(', ')}）。一度も書かれていない単位を監査に回しません`, '4')
    for (const r of results) absorbWriter(r)
  }
  state.settled_written = uniq([...usableResolutions(state), ...(state.holds || [])])
  return '5'
}

function auditorPrompt(role, doc, round, opt) {
  const docs = auditDocs()
  const prev = uniq(pendingFindings(state.pending).filter((f) => (opt.items || []).includes(f.item_id)).map((f) => f.id))
  const ruled = uniq(((state.pending || {}).again || []).filter((f) => (opt.items || []).includes(f.item_id)).flatMap((f) => f.rulings))
  const target = doc === 'all' ? `全文書: ${docs.map((k) => `${W}/${k.replace('/', '-')}.md`).join('、')}、${W}/plan.json` : `文書: ${W}/${doc.replace('/', '-')}.md とその .meta.json`
  const lines = [
    header(role, opt.stage, opt.label),
    groundsBlock(),
    target,
    existingNote(),
    opt.items ? `範囲を絞った監査: 対象は項目 ${list(opt.items)}（その項目の節から読む）。` : '',
    opt.items && prev.length ? `同じ項目への前のパスの指摘: ${list(prev)}（中身は ${W}/findings/*.json から ID で読む）` : '',
    opt.items && ruled.length ? `同じ項目への前のパスの指摘を裁定した resolution: ${list(ruled)}（中身は ${W}/resolutions.json から ID で読む）` : '',
    `指摘は ${W}/findings/${findingsName(role, doc, round, opt.extra)}.json に書き、ID の振り方は契約の「### 指摘の形」に従う。`,
  ]
  if (opt.designated) lines.push(`あなたは指名された監査役である。${opt.designated}`)
  return lines.filter(Boolean).join('\n\n')
}
const ROLE_TAG = { implementer: 'im', grounding: 'gr', crossDoc: 'cd' }
// 追加の監査役は役の印に x を付ける（文書の側に付けると、キーが -extra で終わる文書の 1 体目と名前が重なる）。
const findingsName = (role, doc, round, extra) => `r${round}-${ROLE_TAG[role]}${extra ? 'x' : ''}-${doc === 'all' ? 'all' : fileKey(doc)}`
const auditorLabel = (p, round) => `${p.role}:r${round}:${p.doc}${p.extra ? ':extra' : ''}`

// liveDirs: 指名された監査役が snapshot を取る間も、同じ plan の他の監査役が作業用ディレクトリを使っている。
function liveDirs(plan, round) {
  return plan.map((p) => fileKey(auditorLabel(p, round))).join(',')
}

// noteAudited: 所有表に無いファイルと分量の目安の超過は照合の食い違いではない所見なので、integrity ではなく
// notices に置く（integrity の件数は goal_selector の R4 が照合の食い違いとして数える）。一覧は載せず件数とパスだけにする。
function noteAudited(audited, label) {
  const found = [
    ['stray', 'W に所有表に無いファイル'],
    ['size_over', '分量の目安（SIZE_BUDGET）を超えたファイル'],
  ]
  for (const [key, what] of found) {
    const f = audited[key]
    if (f && Number.isInteger(f.count) && f.count > 0) state.notices = [...(state.notices || []), `監査の基準 ${label} の時点で、${what}が ${f.count} 件あった（${W}/${f.path}）`]
  }
}

function auditDocs() {
  return uniq(state.units.flatMap((u) => u.docs))
}

async function runAuditors(plan, round, stage) {
  const results = await runWithRetry(
    `監査 r${round}`,
    plan,
    (p, attempt) =>
      agent(auditorPrompt(p.role, p.doc, round, { stage, items: p.items, designated: p.designatedText, extra: p.extra, label: auditorLabel(p, round) }), {
        ...OPTS[p.role],
        schema: AUDIT_SCHEMA,
        phase: stage === '5' ? 'Audit' : 'Revise',
        label: `${auditorLabel(p, round)}${attempt > 1 ? '#retry' : ''}`,
      }),
    (x) => Boolean(x)
  )
  const missing = plan.filter((_, i) => !results[i]).map((p) => `${p.role}@${p.doc}`)
  return { results, missing }
}

function recordFindings(plan, results) {
  const all = []
  plan.forEach((p, i) => {
    const fs = (results[i] && results[i].findings) || []
    state.roles_by_item = rolesByItem(state.roles_by_item, fs, p.role)
    all.push(...fs)
  })
  return all
}

async function stage5() {
  state.pass = 1
  // existing は段 4 を通らず、この run の裁定をまだどの writer にも渡していない。
  if (ENTRY === 'existing') state.settled_written = []
  const docs = auditDocs()
  const plan = [
    ...docs.flatMap((doc) => [
      { role: 'implementer', doc },
      { role: 'grounding', doc },
    ]),
    { role: 'crossDoc', doc: 'all' },
  ]
  plan[plan.length - 1].designatedText = [
    `監査の判定とは別に、次を実行して stdout を加工せずに designated に入れる。`,
    `最初に: \`${cli('doc', `--open-tbd "${openTbdOf(state).join(',')}"`)}\` → designated.doc_check`,
    `最後に: \`${cli('snapshot', `--save audited-1 --role auditor --live ${liveDirs(plan, 1)}`)}\` → designated.audited`,
  ].join('\n')
  const { results, missing } = await runAuditors(plan, 1, '5')
  if (missing.length) return blocked(`監査役が応答しませんでした（${missing.join(', ')}）。未実施を指摘 0 件として扱いません`, '5')
  const cd = results[results.length - 1]
  const audited = parseStdout(cd.designated && cd.designated.audited)
  const docCheck = parseStdout(cd.designated && cd.designated.doc_check)
  if (!audited || !audited.digest) return blocked('cross-doc が監査の基準（audited-1 の snapshot）を返しませんでした。どの版を監査したかの記録が無いまま進めません', '5')
  state.audit = { n: 1, digest: audited.digest }
  state.tree_digest = audited.digest
  noteAudited(audited, 'audited-1')
  const findings = recordFindings(plan, results)
  setPending(findings, docCheck, [])
  return '6'
}

// recurring: 再発した項目と、その項目への前のパスの指摘（段 6 に渡す）。again: 既裁定の再出。経路にも blocking にも入れず、次のパスの
// 照合のために裁定の ID だけを持ち越す。尽きた項目の指摘は経路に回さず、blocking には残す。
function setPending(findings, docCheck, carried, opt = {}) {
  const drop = new Set((opt.again || []).map((x) => x.id))
  const recurring = opt.recurring || {}
  const kept = [...findings, ...carried].filter((f) => f && !drop.has(f.id))
  const all = toDecision(kept, [...(opt.reversed || []), ...kept.filter((f) => recurring[itemKey(f)]).map((f) => f.id)])
  const refs = (docCheck && docCheck.flow_refs) || {}
  const flow = {}
  for (const b of partitionFindings(all.filter((f) => (state.item_routes || {})[itemKey(f)] !== 'exhausted')).bundles) {
    const ids = uniq((refs[b.doc] || {})[b.item_id])
    if (ids.length) flow[b.doc] = { ...(flow[b.doc] || {}), [b.item_id]: ids }
  }
  const packed = {}
  for (const f of all) {
    packed[f.doc] = packed[f.doc] || {}
    packed[f.doc][f.item_id] = { ...(packed[f.doc][f.item_id] || {}), [f.id]: packFinding({ ...f, blocking: Boolean(f.blocking) }) }
  }
  state.pending = {
    findings: packed,
    flow,
    doc_blocking: docCheck && Number.isInteger(docCheck.blocking) ? docCheck.blocking : 0,
    carried: uniq(carried.filter((f) => f && f.blocking && !drop.has(f.id)).map((f) => f.id)),
    recurring,
    again: (opt.again || []).map((x) => ({ id: x.id, doc: x.doc, item_id: x.item_id, direction: x.direction, rulings: x.rulings })),
  }
}

// 裁定に回すのは、どの resolution の about にも無い指摘と TBD だけにする（unruled）。前のパスで裁定した指摘が pending に残っていて
// 渡し直すと、同じ論点に 2 つ目の裁定を put させることになり、doc_check が拒んで段が止まる。回答待ちの問いは、裁定に回すものが無くても
// 聞くか保持規則にする。
async function stage6() {
  const decision = unruled(pendingView(state.pending, state.item_routes).decision.map((id) => `finding:${id}`), 'finding').map((k) => k.slice(8))
  const tbd = unruled((state.new_tbd || []).map((id) => `tbd:${id}`), 'tbd').map((k) => k.slice(4))
  const allowQuestions = ASKS[6]()
  if (decision.length || tbd.length) {
    const res = await decide(decision, tbd, allowQuestions)
    if (res.error) return blocked(res.error, res.rerun === false ? null : '6')
  }
  state.new_tbd = []
  if (pendingQuestions(state).length) {
    if (allowQuestions) return needsAnswers('g1', "3a'")
    const he = await holdLeft('6', pendingQuestions(state), 'Decide')
    if (he) return blocked(he.error, he.rerun === false ? null : '6')
  }
  return '7'
}

function decide(decision, tbd, allowQuestions) {
  const rec = state.pending.recurring || {}
  const routeOf = (k) => (state.item_routes || {})[k]
  const redecide = Object.keys(rec).filter((k) => routeOf(k) === 'decision')
  const toHold = uniq(pendingFindings(state.pending).filter((f) => rec[itemKey(f)] && routeOf(itemKey(f)) === 'hold').map((f) => f.id))
  const rulingsOf = (ids) => uniq(Object.entries(state.about || {}).filter(([, k]) => ids.some((id) => k === `finding:${id}`)).map(([id]) => id))
  return resolveCycle('6', {
    phase: 'Decide',
    task: [
      `段 6（resolver.md の「段 6」）: route が decision の指摘 ${list(decision)}（中身は ${W}/findings/*.json から ID で読む）、writer の meta の新しい TBD ${list(tbd)}。`,
      redecide.length ? `再発した項目（項目: 前のパスの指摘 ← その裁定）: ${redecide.map((k) => `${k}: ${list(rec[k])} ← ${list(rulingsOf(rec[k]))}`).join(' / ')}` : '',
      toHold.length ? `再発が続いた項目の指摘（hold にする）: ${list(toHold)}` : '',
      allowQuestions ? '' : "2 パス目以降なので、問いを聞くゲートが残っていない。価値の判断は question ではなく hold にする（resolver.md の「8'」）。",
    ]
      .filter(Boolean)
      .join('\n'),
    targets: [...decision.map((id) => `finding:${id}`), ...tbd.map((id) => `tbd:${id}`)],
    allowQuestions,
  })
}

async function stage7() {
  const p = pendingView(state.pending, state.item_routes)
  const routesByUnit = {}
  for (const { unit, id } of state.routes || []) routesByUnit[unit] = uniq([...(routesByUnit[unit] || []), id])
  const applied = new Set(state.applied_routes || [])
  // 前回の書き込みの後に決まった裁定（合格・回答・保持規則）。routes は段 6 で resolver が起動したときにしか無く、
  // 問いを保持規則に変えたときや G1 の回答を当てたときは載らないことがある。載らない分を落とすと、決まったことや
  // 決まっていないことが文書に入らないまま保存される。routes が無ければ全単位に渡し、各 writer が自分の分を当てる。
  const newSettled = minus(uniq([...usableResolutions(state), ...(state.holds || [])]), state.settled_written || [])
  const anyRoutes = state.units.some((u) => (routesByUnit[u.id] || []).some((id) => !applied.has(id)))
  const targets = state.units
    .map((u) => ({
      unit: u,
      bundles: p.bundles.filter((b) => u.docs.includes(b.doc)),
      routes: (routesByUnit[u.id] || []).filter((id) => !applied.has(id)),
    }))
    .filter((t) => t.bundles.length || t.routes.length || p.doc_blocking > 0 || (newSettled.length && !anyRoutes))
  if (!targets.length) {
    // blocking が残ったまま 9 へ進むと、止まる条件を通らずに done になる（尽きた項目・段 6 が裁定しなかった指摘）。
    if (p.blocking.length) return finalHold(p.blocking.length, [], 'no_progress', '改稿に回せる指摘も裁定も無いまま blocking が残った', '7')
    log('改稿する指摘も裁定も無いので、改稿と再監査を飛ばします（最後の書き込みは段 5 で全体を監査済み）')
    return '9'
  }
  const results = await runWithRetry(
    '改稿',
    targets,
    (t, attempt) => {
      const before = t.unit.docs.map((k) => `${k}: ${state.docs && state.docs[k] ? state.docs[k] : `${W}/checks/audited-${state.audit.n}.snapshot.json の docs["${k}"].digest`}`)
      const extra = [
        `改稿前の digest（照合してから書き始める）:\n${before.map((x) => `- ${x}`).join('\n')}`,
        `writer の指摘（項目ごとに束ねたもの。中身は ${W}/findings/*.json から ID で読む）:\n${t.bundles.map((b) => `- ${b.doc} ${b.item_id}: ${b.findings.join(', ')}${b.flow ? `（trace が指す flow 要素: ${b.flow.join(', ')}）` : ''}`).join('\n') || '（なし）'}`,
        `routes.json の担当の ID: ${list(t.routes)}`,
        p.doc_blocking > 0 ? `${W}/checks/doc.json に doc_check の指摘が ${p.doc_blocking} 件ある。自分の文書の分を直す。` : '',
        newSettled.length ? `前回の書き込みの後に決まった resolution: ${list(newSettled)}。自分の文書に関わるものを当てる。` : '',
      ]
        .filter(Boolean)
        .join('\n\n')
      return agent(writerPrompt(t.unit, 'revise', extra), { ...OPTS.writer, schema: WRITER_SCHEMA, phase: 'Revise', label: `${writerLabel(t.unit, 'revise')}${attempt > 1 ? '#retry' : ''}` })
    },
    (x) => Boolean(x)
  )
  const missing = targets.filter((_, i) => !results[i]).map((t) => t.unit.id)
  if (missing.length) return blocked(`改稿の writer が応答しませんでした（${missing.join(', ')}）`, '7')
  const changes = {}
  let unapplied = []
  targets.forEach((t, i) => {
    const r = results[i]
    absorbWriter(r)
    if (r.changed_items && r.changed_items.length) for (const k of t.unit.docs) changes[k] = uniq([...(changes[k] || []), ...r.changed_items])
    const gave = t.bundles.flatMap((b) => b.findings)
    unapplied = unapplied.concat(minus(gave, r.applied_findings))
    state.applied_routes = uniq([...(state.applied_routes || []), ...(r.applied_routes || [])])
  })
  if (!Object.keys(changes).length) for (const t of targets) for (const k of t.unit.docs) changes[k] = []
  const carried = p.findings.filter((f) => unapplied.includes(f.id))
  if (carried.length) log(`改稿で当たらなかった指摘が ${carried.length} 件ある。次のパスへ持ち越します`)
  state.settled_written = uniq([...usableResolutions(state), ...(state.holds || [])])
  state.revised = { changes, unapplied: uniq(carried.map((f) => f.id)), docs: uniq(targets.flatMap((t) => t.unit.docs)) }
  return '8'
}

async function stage8() {
  const n = state.audit.n
  const round = n + 1
  const { changes } = state.revised
  const plan = scopedAuditPlan(changes, state.roles_by_item || {})
  const designatedText = [
    '監査の判定とは別に、次を実行して stdout を加工せずに designated に入れる。',
    `最初に（判定の前に）: \`${cli('diff', `--against audited-${n} --expect ${state.audit.digest}`)}\`。${W}/checks/diff-audited-${n}.json の changed・added・removed・by_doc を designated.diff に入れる（exit 3 なら designated.diff_error）。`,
    `最後に: \`${cli('snapshot', `--save audited-${round} --role auditor --live ${liveDirs(plan, round)}`)}\` → designated.audited、\`${cli('doc', `--open-tbd "${openTbdOf(state).join(',')}"`)}\` → designated.doc_check、\`${cli('tree-digest')}\` → designated.tree_digest`,
  ].join('\n')
  plan[0].designatedText = designatedText
  const first = await runAuditors(plan, round, '8')
  if (first.missing.length) return blocked(`範囲を絞った監査の監査役が応答しませんでした（${first.missing.join(', ')}）`, '8')
  const d = first.results[0].designated || {}
  if (d.diff_error) return blocked(`監査の基準 audited-${n} の digest が一致しません。基準が差し替わっているので、この監査が何と比べたのか分かりません: ${d.diff_error}`, null)
  if (!d.diff) return blocked('指名された監査役が diff の結果を返しませんでした', '8')
  const audited = parseStdout(d.audited)
  const tree = parseStdout(d.tree_digest)
  if (!audited || !audited.digest || !tree || !tree.digest) return blocked(`指名された監査役が audited-${round} の snapshot か tree-digest を返しませんでした`, '8')

  let allPlan = plan
  let allResults = first.results
  const extra = undeclaredByDoc(d.diff, changes, state.revised.docs || Object.keys(changes))
  const extraDocs = Object.keys(extra)
  if (extraDocs.length) {
    log(`writer の申告に無い変更がある（${extraDocs.map((doc) => `${doc}: ${extra[doc].slice(0, 5).join(', ')}`).join(' / ')}）。その文書の項目に implementer と grounding を追加で起動します`)
    const extraPlan = extraDocs.flatMap((doc) => [
      { role: 'implementer', doc, items: extra[doc], extra: true },
      { role: 'grounding', doc, items: extra[doc], extra: true },
    ])
    const more = await runAuditors(extraPlan, round, '8')
    if (more.missing.length) return blocked(`追加の監査役が応答しませんでした（${more.missing.join(', ')}）`, '8')
    allPlan = plan.concat(extraPlan)
    allResults = first.results.concat(more.results)
  }
  const undeclared = { ...(state.undeclared || {}) }
  for (const doc of extraDocs) undeclared[doc] = uniq([...(undeclared[doc] || []), ...extra[doc]])
  state.undeclared = undeclared
  state.audit = { n: round, digest: audited.digest }
  state.tree_digest = tree.digest
  noteAudited(audited, `audited-${round}`)
  const findings = recordFindings(allPlan, allResults)
  const docCheck = parseStdout(d.doc_check)
  // 進展は前後のパスの指摘と doc_check の件数だけから決める（agent の自己申告を読まない）。
  const prev = pendingView(state.pending, state.item_routes)
  const carried = prev.findings.filter((f) => state.revised.unapplied.includes(f.id))
  const changed = { ...changes }
  for (const doc of extraDocs) changed[doc] = uniq([...(changed[doc] || []), ...extra[doc]])
  const again = reRaised(prev.findings, prev.again, findings, state, changed)
  if (again.length) {
    const line = `監査 r${round}: 既裁定の再出（再発に数えない）: ${again.map((x) => `${x.id} ← ${x.rulings.join(', ')}`).join(' / ')}`
    state.notices = [...(state.notices || []), line]
    log(line)
  }
  // 指摘ごとの役は持たず roles_by_item で代える（next_args の上限に収めるため）。
  const reaudited = (f) => (state.roles_by_item[f.item_id] || []).every((role) => allPlan.some((p) => p.role === role && (p.doc === 'all' || p.doc === f.doc) && (p.items || []).includes(f.item_id)))
  const stuck = prev.findings.filter((f) => f.blocking && (state.item_routes || {})[itemKey(f)] === 'exhausted' && !reaudited(f))
  const recurring = recurringItems(prev.findings, [...findings, ...carried], again)
  state.item_routes = { ...(state.item_routes || {}), ...routeRecurring(recurring, state) }
  const recurPrev = {}
  for (const k of recurring) recurPrev[k] = uniq(prev.findings.filter((f) => itemKey(f) === k).map((f) => f.id))
  // 既裁定の再出も直前のパスの指摘なので、逆向きの判定には入れる（外すと、裁定に逆らう向きの指摘が writer に届く）。
  setPending(findings, docCheck, [...carried, ...stuck], { reversed: reversedFindings([...prev.findings, ...(prev.again || [])], findings), recurring: recurPrev, again })
  // 改稿で新しく起票された TBD も、裁定されないまま終わると「開いたまま完了」になる。blocking と同じく
  // もう 1 パスの理由にする。
  const newTbd = minus(state.new_tbd || [], closedKeys(state).filter((k) => k.startsWith('tbd:')).map((k) => k.slice(4)))
  const now = pendingView(state.pending, state.item_routes)
  const blocking = now.blocking.length + now.doc_blocking + newTbd.length
  if (!blocking) return '9'
  // 新しい TBD は段 6 が閉じうるので、残っていれば進展なしにしない。
  const items = uniq(now.findings.filter((f) => f.blocking).map(itemKey))
  // 指摘の blocking が無く doc_check の blocking だけが残るときは、writer が直せるので上限まで回す。
  const exhausted = items.length > 0 && items.every((k) => state.item_routes[k] === 'exhausted')
  if (!newTbd.length && exhausted && now.doc_blocking >= (prev.doc_blocking || 0)) {
    return finalHold(blocking, newTbd, 'no_progress', '残った blocking の項目がすべて経路を変え尽くし（尽きた項目）、doc_check の blocking も減らなかった', '8')
  }
  if (state.pass >= MAX_AUDIT_PASSES) return finalHold(blocking, newTbd, 'pass_limit', `改稿と監査のパスが上限（MAX_AUDIT_PASSES = ${MAX_AUDIT_PASSES}）に達した`, '8')
  state.pass += 1
  log(`blocking が ${blocking} 件残った（新しい TBD ${newTbd.length} 件を含む。経路を変えた項目 ${list(recurring)}）。段 6 → 7 → 8 をもう 1 パス回します（${state.pass}/${MAX_AUDIT_PASSES}）`)
  return '6'
}

// finalHold: 改稿と監査の輪を出たので文書に反映せず、決定が要るものを保持規則と Issue の文案に変える。
async function finalHold(blocking, newTbd, stopReason, why, stage) {
  phase('Report')
  const p = pendingView(state.pending, state.item_routes)
  const decision = p.decision
  const routes = state.item_routes || {}
  const label = 'resolver:final'
  const r = await once(
    label,
    'resolver',
    resolverPrompt(
      label,
      '改稿の輪を出た後（blocked）',
      keepFlow(
        [
          `${why}。blocking が ${blocking} 件残った。文書は直さない。`,
          decision.length || newTbd.length
            ? `route が decision の指摘 ${list(decision)} と新しい TBD ${list(newTbd)} を hold にする（resolver.md の「8'」）。`
            : '',
        ]
          .filter(Boolean)
          .join('\n')
      )
    ),
    RESOLVER_SCHEMA,
    'Report'
  )
  if (r) absorbResolver(r)
  const report = { report_path: `${W}/report.md`, remaining_blocking: p.blocking, carried_blocking: p.carried, doc_blocking: p.doc_blocking, tree_digest: state.tree_digest, stop_reason: stopReason }
  if (r) {
    const kept = flowKept('final', r)
    if (kept) return blocked(kept.error, kept.rerun ? stage : null, report)
  }
  // 輪を出た後は settle も writer も起動しないので、保持規則への変換で出た flow の残りは理由に載せて依頼者に渡す。
  const now = await independentFlow(null, 'Report')
  if (now.error) return blocked(now.error, now.rerun ? stage : null, report)
  const fc = now.fc
  const flowLeft = fc && (fc.findings || fc.stale_refs.length)
    ? `。保持規則への変換の後の flow に残ったもの（flow の指摘: ${list(flowFindings(fc).map((x) => `${x.at}（${x.code}）`))} / 覆された決定を引く要素: ${list(fc.stale_refs.map((x) => `${x.el}（${x.ref}）`))}）`
    : ''
  const byRoute = (route) => list(Object.keys(routes).filter((k) => (routes[k] === 'exhausted') === (route === 'exhausted')))
  return blocked(`${why}。blocking が ${blocking} 件残りました（尽きた項目: ${byRoute('exhausted')} / 経路を変えた項目: ${byRoute('rerouted')}）${flowLeft}`, null, report)
}

// stage9: 事後報告は resolutions からの導出物なので、生成する役を起動しない。report.md は司令塔が doc_check report で作る。
async function stage9() {
  return finish('done', { report_path: `${W}/report.md`, tree_digest: state.tree_digest, docs: auditDocs(), fixed_docs: FIXED_KEYS })
}

const PHASE_OF = { 1: 'Intake', 2: 'Flow', 3: 'Resolve', '3a': 'Answers', '3b': 'Answers', 4: 'Draft', 5: 'Audit', 6: 'Decide', "3a'": 'Answers', 7: 'Revise', 8: 'Revise', 9: 'Report' }
const STAGE_FNS = { 1: stage1, 2: stage2, 3: stage3, '3a': () => stageApply('3a'), '3b': stage3b, 4: stage4, 5: stage5, 6: stage6, "3a'": () => stageApply("3a'"), 7: stage7, 8: stage8, 9: stage9 }

// exitViolation: 段を出るときの不変条件。破ると、数え直していない台帳の flow の指摘か、誰にも聞かれない問いを持ったまま次の段が走る。
// 回答待ちの問いを持って出てよいのは、聞くゲート（needs_answers）と、G0-2 で一緒に聞くために 3b へ持ち越す 3a だけ。
function exitViolation(from, r) {
  if (unchecked) return `resolver:${unchecked.tag} の後に doc_check flow を独立に実行し直さないまま段を出ようとしました（independentFlow を通らない経路があります）`
  const asking = r.status === 'needs_answers' || (from === '3a' && r === '3b')
  const waiting = asking ? [] : pendingQuestions(state)
  if (waiting.length) return `回答待ちの問い ${list(waiting)} を、聞くゲートも保持規則への変換も通らないまま段を出ようとしました`
  const failedHolds = Object.keys(holdFails).sort()
  if (failedHolds.length) return `検証に落ちた保持規則 ${list(failedHolds)} を、書き直して検証し直さないまま段を出ようとしました（writer に渡すと検証を通っていない規範文が本文に入る）`
  if (['1', '2'].includes(from)) return null
  if (!seen) return wrote ? 'flow か台帳を書いた後に、doc_check flow を独立に実行しないまま段を出ようとしました' : null
  const left = unverifiedLeft(seen, state, asking)
  return left ? `検証を通っていないものを持ったまま段を出ようとしました（${left}）` : null
}

// restoreEntry: flow.json の版を state に持たない段（段 2）の同じ段の再実行の入口。restore だけを実行させる（flow.json がまだ無いことがある）。
async function restoreEntry(from) {
  const label = `flow-check:${from}-entry`
  const x = await once(label, 'flowCheck', [header('flowCheck', from, label), `実行する: \`${cli('restore', `--token ${RESUME_TX.restore}`)}\`。stdout を加工せずに restore_check に入れて返す。`].join('\n\n'), RESTORE_SCHEMA, PHASE_OF[from])
  return restored(from, x)
}

// restored: restore の stdout を確かめる。控えが後の段の token の書き込みで消えていれば（pruned_by）、W を段の入口に戻せず、同じ next_args で
// やり直しても同じ所で止まるので next_args を付けない。
function restored(from, x) {
  const token = RESUME_TX.restore
  const rc = parseStdout(x && x.restore_check)
  if (!rc || rc.token !== token || typeof rc.flow_before !== 'string' || typeof rc.flow_after !== 'string' || !Array.isArray(rc.pruned_by)) {
    return blocked(`flow-check（段 ${from} の入口）が token ${token} の doc_check restore の stdout を返しませんでした`, from)
  }
  if (rc.pruned_by.length) {
    return blocked(`段 ${from} の入口: token ${token} の控えが、後の段の token（${rc.pruned_by.join(', ')}）の書き込みで消えています（打ち間違えた token か、古い next_args）。W を段の入口に戻せないので、S0 からやり直してください（段 1 の入口の reset が tx/ を消す）`, null)
  }
  restorePending = false
  const accepted = RESUME_TX.flow ?? state.flow_digest
  if (rc.flow_before !== rc.flow_after && rc.flow_before !== accepted) {
    noteIntegrity(`段 ${from} の restore の前の flow.json（${rc.flow_before}）が最後に照合を通った版（${accepted}）と違った（照合の前に止まった書き込みか、所有表の外の書き込み）。段の入口の版（${rc.flow_after}）に戻した`)
  }
  return null
}

// enterFromDisk: 段 3 以降から始める run は、最初に W を読み直す。blocked の後の同じ段の再実行は、その前に restore で止まった run の
// 台帳の書き込みを取り消すので、W の台帳は next_args の state と同じ段の入口の版になる（references/workflow-io.md §3）。needs_answers の再開も、
// 止まった run が段を出たときの W のまま（answers だけが増える）。違うのは所有表の外の書き込みだけで、flow.json の版が違えば integrity に 1 行足して
// W の版を使い、今の版に合否の無い要素と resolution を段の本体と同じ verifyLeft で検証させる。それでも不合格の要素が残れば、直す役が
// 段の本体に来るとは限らないので止める。
async function enterFromDisk(from) {
  const label = `flow-check:${from}-entry`
  const restoring = restorePending ? RESUME_TX.restore : null
  const restore = restoring ? `最初に実行する: \`${cli('restore', `--token ${restoring}`)}\`。stdout を加工せずに restore_check に入れる。続けて ` : ''
  const x = await once(label, 'flowCheck', [header('flowCheck', from, label), `${restore}実行する: \`${RULINGS_FLOW}\`。stdout を加工せずに flow_check に入れて返す。`].join('\n\n'), FLOW_CHECK_SCHEMA, PHASE_OF[from])
  if (restoring) {
    const re = restored(from, x)
    if (re) return re
  }
  const fc = x && flowCheckOf(x.flow_check, true)
  if (!fc) return blocked(`flow-check（段 ${from} の入口）が doc_check flow の stdout を返しませんでした`, from)
  if (fc.content_sha256 !== state.flow_digest) {
    noteIntegrity(`段 ${from} の入口の flow.json（${fc.content_sha256}）が、next_args の版（${state.flow_digest}）と違う（所有表の外の書き込み。検証を通っていない要素は段に入る前に検証する）`)
    state.flow_digest = fc.content_sha256
  }
  see(fc)
  const left = await verifyLeft(from, 'entry', fc, PHASE_OF[from], Boolean(ASKS[from] && ASKS[from]()))
  if (left.error) return blocked(left.error, left.rerun === false ? null : from)
  const open = failedOpen(left.fc, state, true)
  if (open.length) return blocked(`段 ${from} の入口の flow に不合格の要素 ${list(open)} があります（所有表の外の書き込み。${W}/verifications.json）`, null)
  return null
}

let next = FROM
let outcome = null
while (outcome === null) {
  const resuming = RESUME_TX && running === null
  if (!resuming) restorePending = false
  txTry = resuming ? RESUME_TX.try : 0
  state.tx = resuming ? { seq: RESUME_TX.seq, stage: next } : { seq: ((state.tx || {}).seq || 0) + 1, stage: next }
  running = next
  entryState = JSON.parse(JSON.stringify(state))
  let r
  try {
    phase(PHASE_OF[next])
    r = next !== FROM ? null : ENTRY_CHECK ? await enterFromDisk(FROM) : restorePending ? await restoreEntry(FROM) : null
    if (!r) r = await STAGE_FNS[next]()
  } catch (e) {
    if (!(e && e.rerunStage)) throw e
    r = blocked(e.message, running)
  }
  // 不変条件の違反は script の欠陥で、同じ段からやり直しても同じ所で破るので next_args を付けない。
  const violation = r.status === 'blocked' ? null : exitViolation(running, r)
  if (violation) r = blocked(`script の不変条件に反しました（段 ${running}）: ${violation}`, null)
  if (typeof r === 'string') next = r
  else outcome = r
}
return outcome
