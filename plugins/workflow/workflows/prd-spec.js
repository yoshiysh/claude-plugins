export const meta = {
  name: 'prd-spec-run',
  description: '依頼を仕分けて流れを閉じ、前提を裁定してから要求・仕様を書き、監査と範囲を絞った再監査を収束するまで回す',
  whenToUse: 'prd-spec の SKILL.md から、workspace を作ったあとに名前（/workflow:prd-spec-run）で呼ぶ。needs_answers で止まったら回答を answers に逐語で書き、SKILL.md「## 中継」の「呼び直し」のとおりに同じ名前で呼び直す。args に打ち直す値は ID・件数・digest に限る（本文や JSON の本体は W に置く）',
  phases: [
    { title: 'Intake', detail: '段 1: planner が依頼を仕分け、流れを閉じ、未決と組を裁定する（1 体）' },
    { title: 'Resolve', detail: '段 3・3v: 段 1 の前提と裁定を plan reviewer が検証する（plan の照合を含む。差し戻しは 1 回）' },
    { title: 'Answers', detail: '段 3a・3b・3a\': 依頼者の回答を流れと裁定に当て、最初のゲートの後は回答で flow を組み直す' },
    { title: 'Draft', detail: '段 4: writer の単位ごとに初稿を書く（依存の向きに順番、独立な単位は並列）' },
    { title: 'Audit', detail: '段 5: writer reviewer を全文書に当て、whole reviewer がその指摘を確かめて文書をまたいで見る' },
    { title: 'Decide', detail: '段 6: 決定が要る指摘と新しい TBD を裁定する' },
    { title: 'Revise', detail: '段 7・8: 改稿し、変えた範囲だけを監査する（収束の条件と上限の定数で回す）' },
    { title: 'Report', detail: '段 9: 収束せずに止まったときは残った論点を保持規則にする（事後報告は司令塔が doc_check report で導出する）' },
  ],
}

// 段の順序・起動の条件・上限・返り値の検査と引き継ぎだけを持つ（schemas/role-map.md の prd-spec.js の行）。
// ファイルは読めないので、分岐に使う値はすべて agent の返り値から受け取り、next_args の state に載せる。
// state に載せるのは ID・件数・digest だけにする（why は references/workflow-io.md §1）。
// state は plain JSON に限る。Map・Set・class を pipeline / parallel の境界や返り値に載せると、runtime で中身が失われる。

// ROLE_OPTS: 全役に既定を置く。省略するとセッションの設定を継承し、全呼び出しが最重量で走って利用上限に達する。
// planner〜writer と 2 つの監査役は判断と生成を要する（知識作業では medium で high と同等の結果が出る）。flowCheck は判断を要しないが、
// 数 KB の stdout を逐語で写す。値は既定であって、E2 の実測で較正する。
const ROLE_OPTS = {
  planner: { model: 'opus', effort: 'medium' },
  planReviewer: { model: 'opus', effort: 'medium' },
  writer: { model: 'opus', effort: 'medium' },
  writerReviewer: { model: 'opus', effort: 'medium' },
  wholeReviewer: { model: 'opus', effort: 'medium' },
  flowCheck: { model: 'sonnet', effort: 'low' },
}

// ROLE_FILES: 役の名前から agents/ のファイル名（拡張子なし）。読む契約の節の表は doc_check の CONTRACT_SECTIONS が持ち、contract --role に
// このファイル名を渡す（節の一覧を script に写すと、片方だけ直されて役が読む節がずれる）。
const ROLE_FILES = {
  planner: 'planner',
  planReviewer: 'plan-reviewer',
  writer: 'writer',
  writerReviewer: 'writer-reviewer',
  wholeReviewer: 'whole-reviewer',
  flowCheck: 'flow-check',
}

// ROLE_OF・JOB: 呼び出しの種類（planner・resolver・verifier）から役と、planner の仕事の節。script の分岐（sha の照合・unchecked の印・
// 差し戻しの直し手）は呼び出しの種類で決まるので種類のまま持ち、model・effort・役のファイル・契約だけを役から引く。
// kind planner は 1 回の起動で仕事を続けて行う（段 1 は仕分け → 流れ → 裁定、settle と 3b は流れ → 裁定）。仕事の列は呼び出しが header に渡す。
const ROLE_OF = { resolver: 'planner', verifier: 'planReviewer' }
const roleOf = (kind) => ROLE_OF[kind] || kind
const JOB = { resolver: '裁定' }

// 網羅の監査 r1 の後の、改稿と範囲の再監査のパスの数（監査は r1 と r2 の 2 回、改稿は 1 回）。r1 の指摘が blocking を含まなければ改稿と
// 2 巡目を飛ばす（段 5 の lowOnly）。残った指摘は、輪を出た後の resolver が保持規則と Issue の文案にし、全件は report.md の節に載せる。
const MAX_AUDIT_PASSES = 1
const MAX_CHECK_REWORK = 3
const MAX_SETTLE_ROUNDS = 3
// 依頼者を止める回数の上限。内訳は、初稿の監査の後の段 6 で開く最初のゲート（collecting。そこまでに出た問いをまとめて聞く）、回答の反映
// （3a・3b）から出る続きの問いのゲート、改稿のパスの段 6 のゲート（MAX_AUDIT_PASSES 回）、最後の監査の後の延長のゲート（段 8 が延長に入ったときだけ）。問いを持ち越さない run では
// 最初のゲートが改稿のパスの段 6 を兼ねるので 1 回余る。答えを当てた段から出る続きの問いも同じ上限から引くので、問いと回答の連鎖はここで必ず終わる。
const MAX_GATES = 3 + MAX_AUDIT_PASSES
// NEXT_ARGS_MAX_CHARS: 司令塔が next_args を打ち直せる字数の上限（tests の NextArgsBudget と同じ値。tests が照合する）。収まるのはこれ未満で、
// 延長のパスは、そのゲートの next_args がこれ以上なら入らない（段 8・延長の段 6・延長の 3a'）。超える next_args を返すと、回答を当てて再開できない。
const NEXT_ARGS_MAX_CHARS = 8000
// FORMAL_LIMIT: 段の種類（5・8）ごとに、formal-method への依頼 a（と、反例の差し戻しの後の依頼 b）の組を何回行うかの上限。数えた値は state.formal_by。
// new・expand は formal-method を最大 4 回、existing（段 5 で送る単位が 0）は最大 2 回呼ぶ（利用者の決定）。全体で数えると、書き直しの経路で
// 最後の改稿の後の段 8 が上限で消える。延長のパスの 2 回目の段 8 は上限で依頼せず、そこで変わった単位は report.md が未検証として載せる。
const FORMAL_LIMIT = { 5: 1, 8: 1 }

const ENTRIES = ['new', 'existing', 'expand']
const STAGES = ['1', '3', '3a', '3b', '4', '5', '6', "3a'", '7', '8', '9']
const GATE_NAME = /^g([1-9]\d*)$/
const gateAnswers = (gate) => `answers/${gate}.md`

// ---------------------------------------------------------------- 純粋関数（tests が抽出して呼ぶ）
// PURE_BEGIN

// MODELS・EFFORTS: agent() の opts.model・opts.effort が受ける値（subagent の frontmatter の model の表と workflow の agent() の effort）。
// 完全な model ID（claude- で始まるもの）も受ける。inherit はその役の opts から model を外し、セッションの model を継承させる。
const MODELS = ['haiku', 'sonnet', 'opus', 'fable', 'inherit']
const MODEL_ID = /^claude-[a-z0-9][a-z0-9.-]*$/
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']

// RESOLUTION_ID: resolution の ID の形。doc_check の LEDGERS.resolutions.keyShape と同じ（tests が照合する）。合否と台帳の集合は
// この形で resolution と D- / F- を分けるので、形の外の ID を受け取ると、裁定したことが黙って消える。
const RESOLUTION_ID = /^RS-\d+$/

// DOC_KEY: 文書のキーの形。doc_check の DOC_KEY と同じ（tests が照合する）。existing_docs のキーは段 1 の入口の reset のコマンド文に
// そのまま入るので、形の外のキー（空白や ; を含むもの）を通すと、flow-check が別のコマンドを実行する。
const DOC_KEY = /^(requirements|specifications)\/([A-Za-z0-9][A-Za-z0-9._-]*)$/

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
    if (o.model !== undefined && !MODELS.includes(o.model) && !MODEL_ID.test(o.model)) throw new Error(`args.role_opts.${name}.model が不正です: "${o.model}"`)
    if (o.effort !== undefined && !EFFORTS.includes(o.effort)) throw new Error(`args.role_opts.${name}.effort が不正です: "${o.effort}"`)
    for (const k of Object.keys(o)) if (k !== 'model' && k !== 'effort') throw new Error(`args.role_opts.${name}.${k} は受け付けません（model と effort だけ）`)
    Object.assign(out[name], o)
    if (out[name].model === 'inherit') delete out[name].model
  }
  return out
}

const list = (xs) => (xs && xs.length ? xs.join(', ') : '（なし）')
const uniq = (xs) => [...new Set((xs || []).filter((x) => x !== undefined && x !== null && x !== ''))].sort()
const minus = (xs, ys) => {
  const drop = new Set(ys || [])
  return uniq(xs).filter((x) => !drop.has(x))
}

// VALUE_ABOUT: 価値の論点になりうる about の種類。verification は落ちた決定・要素の扱いで、依頼者に聞く論点ではない。
const VALUE_ABOUT = ['open', 'pair', 'finding', 'tbd']
const valueKey = (key) => VALUE_ABOUT.some((k) => String(key || '').startsWith(`${k}:`))
const domainAssessmentFailures = (fails, about) => (fails || []).filter((f) => String((about || {})[f.id] || '').startsWith('domain:'))

// aboutKey: Set は state に載せられないので、閉じた論点の集合を about の文字列の配列で持つ。
function aboutKey(about) {
  if (!about || typeof about !== 'object') return null
  if (Array.isArray(about.pair) && about.pair.length === 2) return `pair:${[...about.pair].map(String).sort().join('|')}`
  for (const k of ['open', 'finding', 'tbd', 'verification', 'domain']) if (about[k]) return `${k}:${about[k]}`
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

// keyMembers: about のキー（aboutKey の形）が指す ID。組は両側。
function keyMembers(key) {
  const s = String(key || '')
  const at = s.indexOf(':')
  if (at < 0) return []
  return s.slice(0, at) === 'pair' ? s.slice(at + 1).split('|') : [s.slice(at + 1)]
}

// pointedGrounds: 裁定する論点ごとに、同じ要素・不変条件・項目に触れる根拠にしてよい resolution。根拠を一覧のパスと ID の列だけで渡すと、
// 同じ要素の検証の裁定を読まずに、それと食い違う裁定を書く。script はファイルを読めないので state の about だけから引く。触れる ID は
// 論点のキーの ID と、そのうち RS- が閉じた論点の ID（1 段だけ）と、指摘ならその項目と項目の trace が指す flow の要素。要素の source が引く裁定と
// 問いの候補の flow_refs は state に無いので引かない。items: [{ key, self }]。self は差し戻しで直す ID の配列（直すものを根拠に挙げない）。
function pointedGrounds(items, state) {
  const about = state.about || {}
  const pending = state.pending || {}
  const itemOf = {}
  for (const f of pendingFindings(pending)) itemOf[f.id] = itemKey(f)
  for (const [k, ids] of Object.entries(pending.recurring || {})) for (const id of ids || []) itemOf[id] = itemOf[id] || k
  const flowOf = (k) => ((pending.flow || {})[k.slice(0, k.indexOf('#'))] || {})[k.slice(k.indexOf('#') + 1)] || []
  const expand = (ids) => ids.flatMap((id) => (itemOf[id] ? [id, `item:${itemOf[id]}`, ...flowOf(itemOf[id])] : [id]))
  const usable = usableResolutions(state)
  return items
    .map(({ key, self }) => {
      const skip = new Set(self || [])
      const members = keyMembers(key)
      const touched = new Set(expand([...members, ...members.filter((m) => RESOLUTION_ID.test(m)).flatMap((m) => keyMembers(about[m]))]))
      const hits = usable.filter((id) => !skip.has(id) && (touched.has(id) || expand(keyMembers(about[id])).some((m) => touched.has(m))))
      return { key, grounds: hits.map((id) => ({ id, about: about[id] || null })) }
    })
    .filter((x) => x.key && x.grounds.length)
}

// ownItems: 差し戻しの項目の pointedGrounds の items。落ちた要素・決定の検証の裁定は、差し戻しが同じ ID のまま直すものなので、根拠に指さない
// （前の版で合格したまま根拠一式に残っていても、その要素が落ちた理由そのものでありうる）。
const ownItems = (ids, state) =>
  (ids || []).map((id) => (RESOLUTION_ID.test(id) ? { key: (state.about || {})[id], self: [id] } : { key: `verification:${id}`, self: [id, ...verificationRulings(state, id)] }))

// findingItems: 段 6 の指摘の pointedGrounds の items。route が decision の再発した項目（裁定し直す項目）では、前のパスでその項目の指摘を閉じた
// 裁定を指さない（改稿で直らなかった裁定を「食い違うな」と指すと、項目の次元をまとめて裁定し直す代わりに保持規則へ寄る。その裁定は decide の
// 再発した項目の行で別に渡る）。
function findingItems(ids, state) {
  const pending = state.pending || {}
  const itemOf = Object.fromEntries(pendingFindings(pending).map((f) => [f.id, itemKey(f)]))
  const before = (id) => (pending.recurring || {})[itemOf[id]] || []
  return (ids || []).map((id) => ({ key: `finding:${id}`, self: Object.entries(state.about || {}).filter(([, k]) => before(id).some((x) => k === `finding:${x}`)).map(([rs]) => rs) }))
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
const unjudgedElements = (fc) => minus(fc.unverified, fc.failed_current)
const unjudged = (fc) => ({ elements: unjudgedElements(fc), resolutions: uniq(fc.resolutions.filter((x) => !x.verdict).map((x) => x.id)) })

// unconverted: 検証に落ちたまま question にも hold にもなっていない裁定。根拠にも保持規則にもならないまま台帳に残る。
const UNDECIDED = ['question', 'hold']
const unconverted = (fc) => fc.resolutions.filter((x) => x.verdict === 'fail' && !UNDECIDED.includes(x.ruling))

// unverifiedLeft: 段を出るときの不変条件（exitViolation）。unjudged に加えて、進めない不合格の要素（failedOpen）と unconverted と、
// 不合格の回答済みの問いも残さない。回答済みの問いは回答待ちにも変換にも根拠にも数えられず、論点は閉じたことになるので、決めたことが黙って消える。
// reflectNext: 不合格の要素の反映を次の段（REFLECT_STAGE）に渡した出口。unjudged は緩めない（渡すのは検証し終えたものだけ）。
function unverifiedLeft(fc, state, asking, reflectNext) {
  const { elements, resolutions } = unjudged(fc)
  const open = failedOpen(fc, state, asking).filter((el) => !(reflectNext && reflectable(el)))
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

function pendingView(p) {
  const findings = pendingFindings(p)
  const part = partitionFindings(findings)
  const flow = (p || {}).flow || {}
  return {
    ...p,
    findings,
    bundles: part.bundles.map((b) => ((flow[b.doc] || {})[b.item_id] ? { ...b, flow: flow[b.doc][b.item_id] } : b)),
    decision: part.decision,
    blocking: uniq(findings.filter((f) => f.blocking).map((f) => f.id)),
  }
}

// canonicalText・fnv: この script は sha256 を計算できないので、next_args が打ち直しで変わっていないかをこの 2 つで照合する。
// jsonChars: 区切りに空白を入れた JSON（`, ` と `: `。Python の json.dumps の既定と同じ）の字数。文字列は作らずに数える（プロンプトに JSON を
// 埋め込まないため）。非 ASCII は写したままの字数で、制御文字は \u00XX の 6 字で数える。
const jsonStrChars = (t) => 2 + t.length + (t.match(/["\\\n\r\t\b\f]/g) || []).length + 5 * (t.match(/[\u0000-\u0007\u000b\u000e-\u001f]/g) || []).length
function jsonChars(v) {
  if (Array.isArray(v)) return 2 + 2 * Math.max(v.length - 1, 0) + v.reduce((n, x) => n + jsonChars(x === undefined || typeof x === 'function' ? null : x), 0)
  if (v && typeof v === 'object') {
    const ks = Object.keys(v).filter((k) => v[k] !== undefined && typeof v[k] !== 'function')
    return 2 + 2 * Math.max(ks.length - 1, 0) + ks.reduce((n, k) => n + jsonStrChars(k) + 2 + jsonChars(v[k]), 0)
  }
  if (typeof v === 'string') return jsonStrChars(v)
  return v === null || (typeof v === 'number' && !Number.isFinite(v)) ? 4 : String(v).length
}
const FORMAL_OUTCOMES = ['result', 'rejected', 'provisional', 'no_result']
// formalEntryNotice: 入口の取り込み（formalEntry）が notices に足す 1 行。W の絶対パスも件数も入れず（件数は fm/facts.json と report.md にある）、
// outcome を最も長い語の幅に詰めて、rid が同じ桁なら長さが変わらない形にする（next_args の字数を見積もれるようにする）。
const FORMAL_OUTCOME_WIDTH = Math.max(...FORMAL_OUTCOMES.map((o) => o.length))
const formalEntryNotice = (rid, outcome) => `形式検証 ${rid} の取り込み: ${String(outcome).padEnd(FORMAL_OUTCOME_WIDTH)}`
// FORMAL_OFF_NOTICE: args.formal が false の run が notices に足す 1 行（noteFormalOff）。
const FORMAL_OFF_NOTICE = '形式検証を行わない run（args.formal が false）。report.md の「形式検証」の節に開示する'
// FORMAL_WORST: next_args の state に載る形式検証の欄の最悪の形（取り込む前の rid と fnv の 8 字、段 5・8 の両方で依頼した回数）と、notices に
// 足しうる行の最悪の形（依頼の数の上限 f1a・f1b・f2a・f2b の取り込みの行と、FORMAL_OFF_NOTICE の 1 行の長い方）。worstNextArgsChars が足す。
// この足し分で、tests の NextArgsBudget.ITEMS_N は 32 から 30 に下がった（実測: 31 項目の段 8（existing・当て損ね 7 件）の最悪の形が 8059 字で
// 上限を超え、30 項目で 7932 字に収まる）。測った値で決まる境界なので、欄か行の形を変えたら測り直す。
const FORMAL_WORST = { formal: { rid: 'f9b', fnv: 'x'.repeat(8) }, formal_by: { 5: 1, 8: 1 } }
const FORMAL_WORST_NOTICES = (() => {
  const entry = ['f1a', 'f1b', 'f2a', 'f2b'].map((rid) => formalEntryNotice(rid, 'result'))
  return jsonChars(entry) >= jsonChars([FORMAL_OFF_NOTICE]) ? entry : [FORMAL_OFF_NOTICE]
})()
// worstNextArgsChars: next_args を、その段（from）の再実行の最悪の形にした字数（tests の NextArgsBudget._chars と同じ測り方。tests が照合する）。
// 再実行を重ねると tx の try と restore が伸び、flow を書く段（段 8 のほか）では tx.flow（flow の digest）が付く。形式検証の欄は FORMAL_WORST の形で足す。
function worstNextArgsChars(a) {
  const tx = (a.state && a.state.tx) || {}
  const worst = { ...tx, stage: a.from, try: 9, restore: `t${tx.seq}r8`, ...(a.from === '8' ? {} : { flow: 'f'.repeat(64) }) }
  return jsonChars({ ...a, state: { ...a.state, tx: worst, ...FORMAL_WORST, notices: [...((a.state && a.state.notices) || []), ...FORMAL_WORST_NOTICES] } })
}

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
// 最上位の空の配列・オブジェクトは欄が無いのと同じに扱う（この script がそう読むので、打ち直しで [] を落としても意味は変わらない）。
// formal（args.formal）は最初の呼び出しで決め、途中で変えない（SKILL.md「## 中継」）。ここに入れず state_hash に数えるので、変えた next_args は止まる。
const ENV_ARGS = ['skillDir', 'role_opts']
// RESUME_ARGS: resumeFromRunId で呼び直すときに元の run の args へ足す欄。next_args には載らないので hash の外に置く（入れると、next_args から
// 始めた run の resume が state_hash で止まる）。
const RESUME_ARGS = ['gates_answered']
const isEmpty = (v) => v === undefined || (Array.isArray(v) ? !v.length : v && typeof v === 'object' && !Object.keys(v).length)
const nextArgsHash = (a) => fnv(canonicalText(Object.fromEntries(Object.entries(a).filter(([k, v]) => k !== 'state_hash' && !ENV_ARGS.includes(k) && !RESUME_ARGS.includes(k) && !isEmpty(v)))))

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
  // このパスの段 6 に渡した decision の指摘の裁定は、この段 7 で渡した。それ以外（前のパスの再出）の裁定は前に渡し終えている。
  const decided = new Set(pendingView(state.pending).decision)
  const given = new Set((prevFindings || []).filter((f) => f && decided.has(f.id) && rulings[f.id]).map(key))
  for (const f of prevAgain || []) add(f, f && f.rulings)
  const bundled = new Set(pendingView(state.pending).bundles.map(itemKey))
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

// routeRecurring: 改稿で直らない項目（再発）は writer に回さず、裁定（decision）に回す。裁定の後にまた再発した項目は、MAX_AUDIT_PASSES で
// 輪を出た後の finalHold が保持規則と Issue の文案にする。
function routeRecurring(recurring) {
  const out = {}
  for (const k of recurring || []) out[k] = 'decision'
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
    if (again.error) return { got, defect, error: again }
    const next = defectOf(again)
    const stalled = next && next.count >= defect.count
    got = again
    defect = next
    if (stalled) break
  }
  return { got, defect, error: null }
}

// closedInCycle: before で引かないと、前の cycle で写した裁定を次の cycle（改稿のパスのゲートの後の 3a' など）で写し直す。
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

// undeclaredChanges: 生成した側だけに検証の範囲を決めさせないため、申告に無い項目も監査の範囲に入れる。
function undeclaredChanges(diff, declared) {
  const all = uniq([...((diff && diff.changed) || []), ...((diff && diff.added) || []), ...((diff && diff.removed) || [])])
  return minus(all, declared)
}

// undeclaredByDoc: 申告は単位ごとなので、木全体の集合だけでは、何も申告しなかった単位の文書の変更を文書に結び付けられない。
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

// STDOUT_FNV: doc_check が stdout に付ける、本体の digest の欄（doc_check の STDOUT_FNV と同じ。tests が照合する）。
const STDOUT_FNV = 'stdout_fnv'
const BAD_JSON = Symbol('bad json')
function stdoutRaw(text) {
  if (text && typeof text === 'object') return text
  const line = String(text || '').trim().split('\n').filter((l) => l.trim().startsWith('{')).pop()
  if (!line) return null
  try {
    return JSON.parse(line)
  } catch {
    return BAD_JSON
  }
}

// parseStdout: agent は stdout を手で写すので、写しの本体から digest を計算し直し、合わない写し（壊れた JSON・要素の欠けた一覧）は
// 受け取らない。形を検査するだけだと、一覧から 1 件落とした写しが正しい stdout として通る。返す本体に STDOUT_FNV は載せない
// （--rulings の有無で違う stdout どうしを欄ごとに比べる呼び出しがある）。
function parseStdout(text) {
  const o = stdoutRaw(text)
  if (!o || o === BAD_JSON || typeof o !== 'object' || Array.isArray(o)) return null
  const { [STDOUT_FNV]: sum, ...body } = o
  return typeof sum === 'string' && sum === fnv(canonicalText(body)) ? body : null
}

// copyFault: JSON の行はあるのに受け取れない（写し損ね）。JSON の行の無い値（失敗したコマンドの stderr）は写し損ねではなく、これまでの経路で扱う。
const copyFault = (text) => stdoutRaw(text) !== null && !parseStdout(text)

// units は plan.json の units をそのまま写したもので、state.units の唯一の出所（doc_check の writesSpecOf と同じ材料）。
function planCheckOf(text) {
  const o = parseStdout(text)
  const strs = (v) => Array.isArray(v) && v.every((k) => typeof k === 'string')
  const coversOk = (c) => c && typeof c === 'object' && !Array.isArray(c) && Object.values(c).every(strs)
  const unitsOk = (u) => Array.isArray(u) && u.length > 0 && u.every((x) => isMap(x) && typeof x.id === 'string' && strs(x.docs) && x.docs.length > 0 && strs(x.depends_on))
  return o && Number.isInteger(o.findings) && typeof o.content_sha256 === 'string' && o.content_sha256 && coversOk(o.covers) && unitsOk(o.units) ? o : null
}
const unitsOf = (pc) => pc.units.map((u) => ({ id: u.id, docs: uniq(u.docs), depends_on: uniq(u.depends_on) }))

// rulingRows: doc_check flow --rulings の resolutions（ruling・has_answer・verdict・fail_kind の組ごとに束ねたもの。束ね方は doc_check の rulingsCompact）を
// resolution ごとの行 {id, about, ruling, has_answer, verdict}（不合格は fail_kind も、仕様の論点の問いは spec_layer: true も）に戻す。形の外の組が 1 つでもあれば null。並びは ID の番号順にする
// （束ねた順のままだと、合否が変わっただけで行の並びが変わり、state の holds・questions の並びと next_args が揺れる）。
const VERDICTS = ['pass', 'fail', null]
const isMap = (x) => Boolean(x) && typeof x === 'object' && !Array.isArray(x)
const idOrder = (a, b) => {
  const [m, n] = [a, b].map((id) => (RESOLUTION_ID.test(id) ? Number(id.slice(3)) : Infinity))
  return m - n || (a < b ? -1 : a > b ? 1 : 0)
}
function rulingRows(groups) {
  if (!Array.isArray(groups)) return null
  const rows = []
  for (const g of groups) {
    if (!isMap(g) || typeof g.has_answer !== 'boolean' || !VERDICTS.includes(g.verdict) || Object.hasOwn(g, 'fail_kind') !== (g.verdict === 'fail') || !isMap(g.about)) return null
    if (Object.hasOwn(g, 'spec_layer') && g.spec_layer !== true) return null
    for (const [id, about] of Object.entries(g.about)) {
      if (about !== null && !isMap(about)) return null
      rows.push({ id, about, ruling: g.ruling ?? null, has_answer: g.has_answer, verdict: g.verdict, ...(g.verdict === 'fail' ? { fail_kind: g.fail_kind } : {}), ...(g.spec_layer ? { spec_layer: true } : {}) })
    }
  }
  if (new Set(rows.map((x) => x.id)).size !== rows.length) return null
  return rows.sort((a, b) => idOrder(a.id, b.id))
}

// flowCheckOf: rulings は doc_check flow --rulings の stdout（裁定と合否の resolutions を持つ）。台帳の集合と検証し残しはそこからだけ読むので、
// 生成者の stdout には求めない（全 resolution の行を毎回写すと、返り値の出力が台帳の大きさに比例して増える）。resolutions は、あれば
// --rulings の有無によらず行に戻す（--rulings を付けて実行した生成者の stdout も、ほかの stdout と同じ形で読む）。
function flowCheckOf(text, rulings = false) {
  const o = parseStdout(text)
  const ok = o && Number.isInteger(o.findings) && Number.isInteger(o.open) && typeof o.content_sha256 === 'string' && o.content_sha256
  if (!ok || !['answer_holds', 'unverified', 'failed_current', 'open_only', 'stale_refs', 'unsettled_refs', 'open_ids', 'pair_keys'].every((k) => Array.isArray(o[k]))) return null
  const rows = o.resolutions === undefined ? undefined : rulingRows(o.resolutions)
  if (rows === null || (rulings && !rows)) return null
  if (!o.answer_holds.every((x) => x && typeof x.id === 'string' && typeof x.file === 'string' && Number.isInteger(x.from) && Number.isInteger(x.to))) return null
  const codes = o.codes && typeof o.codes === 'object' && !Array.isArray(o.codes) ? Object.values(o.codes) : null
  if (!codes || !codes.every(Array.isArray) || codes.reduce((n, xs) => n + xs.length, 0) !== o.findings) return null
  return rows ? { ...o, resolutions: rows } : o
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

// flowDefect: 生成者への差し戻しの件数は、生成者が消せる指摘だけで数える。fixer は生成者に消せない指摘を直す役の呼び名。表に無い符号は誰が消せるか分からないので、差し戻さずに止める。
function flowDefect(fc, generator, path, fixer) {
  if (!fc) return { count: Infinity, text: 'doc_check flow の stdout がありません' }
  const split = splitFlowFindings(fc, generator)
  if (split.unknown.length) return { count: Infinity, stop: true, text: `doc_check flow の指摘に直し手の表（FIXERS_BY_CODE）に無い符号があります: ${split.unknown.join(', ')}` }
  if (!split.own) return null
  const left = split.handoff.length ? `。${split.handoff.map((x) => `${x.at}（${x.code}）`).join(', ')} は ${fixer} が直すので触らない` : ''
  return { count: split.own, text: `doc_check flow の指摘が ${split.own} 件あります（${path}）${left}` }
}

function conflictsCheckOf(text) {
  const o = parseStdout(text)
  return o && Number.isInteger(o.pairs) && Array.isArray(o.pair_keys) ? o : null
}

// questionsDefect: 検査した ID まで照合するのは、別の ID の集合で通した stdout を合格として受け取らないため。
function questionsDefect(text, ids) {
  const o = parseStdout(text)
  if (!o || o.check !== true || !Array.isArray(o.ids) || !Number.isInteger(o.findings) || !Array.isArray(o.bad) || o.bad.length !== o.findings) return { count: Infinity, text: 'doc_check questions --check の stdout がありません' }
  const unchecked = minus(ids, o.ids)
  if (unchecked.length) return { count: Infinity, text: `検査していない問いがあります: ${unchecked.join(', ')}` }
  if (o.findings > 0) return { count: o.findings, text: `形の不合格が ${o.findings} 件あります: ${o.bad.join(' / ')}` }
  return null
}

// REQUIRES: from の入口ごとに、state に要る値。script はファイルを読めないので、ここに無ければ再開できない。
const REQUIRES = {
  1: [],
  3: ['units', 'flow_digest', 'plan_sha256', 'covers'],
  '3a': ['units', 'flow_digest', 'gate', 'gates', 'questions'],
  '3b': ['units', 'flow_digest', 'gate', 'gates', 'questions'],
  4: ['units', 'flow_digest'],
  5: ['units', 'flow_digest'],
  6: ['units', 'flow_digest', 'audit', 'pending', 'pass', 'settled_written'],
  "3a'": ['units', 'flow_digest', 'audit', 'pending', 'pass', 'settled_written', 'gate', 'gates', 'questions'],
  7: ['units', 'flow_digest', 'audit', 'pending', 'pass', 'settled_written'],
  8: ['units', 'flow_digest', 'audit', 'pending', 'pass', 'settled_written', 'revised'],
  9: ['units', 'tree_digest', 'pending'],
}
function stateErrors(from, state) {
  if (!Object.prototype.hasOwnProperty.call(REQUIRES, from)) return [`from "${from}" は段の境界ではありません（${Object.keys(REQUIRES).join(' / ')}）`]
  return REQUIRES[from].filter((k) => !state || state[k] === undefined || state[k] === null).map((k) => `from "${from}" には state.${k} が要ります`)
}

// runEach: 各項目を 1 回だけ起動する。null（利用者が止めたか、runtime の出し直しの後も API エラーだった）を script は出し直さない:
// 利用者の停止を覆し、API エラーは runtime が既に出し直している。未実施は「指摘 0 件」ではないので、呼び出し側が段を止める。
// 添字は runtime が渡すものを持ち回る。pipeline の返り値が入力順に並ぶ保証は文書化されていないので、位置から逆算すると、
// 並びが変わったときに別の項目の結果を読む。
const runEach = async (items, issue) => {
  const results = new Array(items.length).fill(null)
  for (const e of await pipeline(items.map((_, i) => i), (i) => Promise.resolve(issue(items[i])).then((r) => ({ i, r })))) if (e) results[e.i] = e.r
  return results
}

// NOT_RUN: null の呼び出しの理由。script からは利用者の停止と API エラーを区別できないので、両方を書く。
const NOT_RUN_WHY = '利用者が止めたか、runtime の出し直しの後も API エラーだった。script は出し直さない'
const NOT_RUN = `応答しませんでした（${NOT_RUN_WHY}。この段からやり直せる（呼び直し方は SKILL.md「## 中継」））`

// STOP_REASONS: 返り値の stop_reason の閉集合（references/workflow-io.md §3。tests が照合する）。budget は token の目標（budget.total）に
// 達して agent を起動できなくなったとき。upstream_gap は仕様書だけを書く run（specOnly）で、初稿の監査の裁定（段 6）までに価値の問いが出たとき。
const STOP_REASONS = ['pass_limit', 'no_progress', 'budget', 'upstream_gap']

// SKIP_FACTS: 返り値の skipped の fact の閉集合（references/workflow-io.md §3。tests が照合する）。skipped は制御の流れの記録なので、
// W の状態の所見（notices）に混ぜず、state にも載せない（next_args を増やさない）。
// no_formal_target: 段 5・8 の formal-request の送る単位が 0（step は formal-method:<rid>）。formal_unavailable: args.formal が false（step は formal-method）。
const SKIP = { unchanged: 'unchanged', low_only: 'low_only', no_formal_target: 'no_formal_target', formal_unavailable: 'formal_unavailable' }
const SKIP_FACTS = Object.values(SKIP)
const skipped = []

// schemaDefects・callDefect: script が作る schema と opts の誤り（script の欠陥）を agent() の前に見分ける。見分けないと runtime が
// その呼び出しを例外にし、再実行できる blocked に化けて、同じ所で同じ理由の失敗を繰り返す（references/workflow-io.md §5）。
// 受ける keyword は今の schema が使うものだけにする（runtime が受けるかを確かめた集合ではない）。
const SCHEMA_KEYWORDS = {
  object: ['type', 'properties', 'required', 'additionalProperties'],
  array: ['type', 'items', 'minItems', 'maxItems'],
  string: ['type', 'enum'],
  integer: ['type', 'minimum'],
  boolean: ['type'],
}
function schemaDefects(schema, at = '$') {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return [`${at}: schema がオブジェクトでない`]
  const allowed = SCHEMA_KEYWORDS[schema.type]
  if (!allowed) return [`${at}: type「${schema.type}」は受けない`]
  const out = Object.keys(schema).filter((k) => !allowed.includes(k)).map((k) => `${at}: ${schema.type} に keyword「${k}」は受けない`)
  if (schema.type === 'object') {
    const props = schema.properties
    if (props === undefined ? schema.additionalProperties === undefined : !props || typeof props !== 'object' || Array.isArray(props)) out.push(`${at}: properties が無いかオブジェクトでない`)
    else if (props) for (const [k, v] of Object.entries(props)) out.push(...schemaDefects(v, `${at}.${k}`))
    if (schema.required !== undefined) {
      if (!Array.isArray(schema.required)) out.push(`${at}: required が配列でない`)
      else for (const k of schema.required) if (!props || !Object.hasOwn(props, k)) out.push(`${at}: required の「${k}」が properties に無い`)
    }
    if (schema.additionalProperties !== undefined) out.push(...schemaDefects(schema.additionalProperties, `${at}.*`))
  }
  if (schema.type === 'array') {
    if (schema.items === undefined) out.push(`${at}: items が無い`)
    else out.push(...schemaDefects(schema.items, `${at}[]`))
    for (const k of ['minItems', 'maxItems']) if (schema[k] !== undefined && !(Number.isInteger(schema[k]) && schema[k] >= 0)) out.push(`${at}: ${k} が 0 以上の整数でない`)
  }
  if (schema.type === 'string' && schema.enum !== undefined && !(Array.isArray(schema.enum) && schema.enum.length && schema.enum.every((x) => typeof x === 'string'))) out.push(`${at}: enum が文字列の配列でない`)
  if (schema.type === 'integer' && schema.minimum !== undefined && !Number.isInteger(schema.minimum)) out.push(`${at}: minimum が整数でない`)
  return out
}
const CALL_OPTS = ['model', 'effort', 'schema', 'phase', 'label']
// known: { schemas: 起動の前に検査した schema の Set }。schema は同一のオブジェクトであることで照合する（script の外から来る値では
// ないので、検査済みの定数を渡したかだけを見る）。phase の title は runtime の例外にならないので見ない（tests が meta.phases と照合する）。
function callDefect(prompt, opts, known) {
  if (!opts || typeof opts !== 'object') return 'opts がオブジェクトでない'
  const out = Object.keys(opts).filter((k) => !CALL_OPTS.includes(k)).map((k) => `opts.${k} は渡さない`)
  if (typeof prompt !== 'string' || !prompt.trim()) out.push('プロンプトが空')
  if (typeof opts.label !== 'string' || !opts.label) out.push('opts.label が無い')
  if (typeof opts.phase !== 'string' || !opts.phase) out.push('opts.phase が無い')
  if (!known.schemas.has(opts.schema)) out.push('opts.schema が起動の前に検査した schema でない')
  if (opts.model !== undefined && !MODELS.includes(opts.model) && !MODEL_ID.test(opts.model)) out.push(`opts.model「${opts.model}」は受けない`)
  if (opts.model === 'inherit') out.push('opts.model に inherit を渡さない（applyRoleOverrides が外す）')
  if (!EFFORTS.includes(opts.effort)) out.push(`opts.effort「${opts.effort}」は受けない`)
  return out.length ? out.join(' / ') : null
}

// ownsFlowOf: verifier を外した cycle の後の flow の食い違いを段のやり直しにしてよいのは、最後に起動した resolver が回答を当てた
// その段の呼び出し（flow.json を書ける）のときだけ。問いの形の修正のような後続の resolver は flow.json を書けない。
const ownsFlowOf = (unchecked, stage) => Boolean(unchecked) && unchecked.tag === stage
// PURE_END

const STR = { type: 'string' }
const INT = { type: 'integer', minimum: 0 }
const STRS = { type: 'array', items: STR }
const ABOUT = {
  type: 'object',
  properties: { open: STR, pair: { type: 'array', items: STR, minItems: 2, maxItems: 2 }, finding: STR, tbd: STR, verification: STR, domain: STR },
}
const RULED = { type: 'array', items: { type: 'object', properties: { id: STR, about: ABOUT }, required: ['id', 'about'] } }

const FLOW_CHECK_SCHEMA = { type: 'object', properties: { flow_check: STR, restore_check: STR, answers_check: STR, formal_status: STR }, required: ['flow_check'] }
// FORMAL_CHECK_SCHEMA: 段 5・8 の本体の最初に flow-check が実行する doc_check formal-request の stdout。
const FORMAL_CHECK_SCHEMA = { type: 'object', properties: { formal_check: STR }, required: ['formal_check'] }
const RESET_SCHEMA = { type: 'object', properties: { reset_check: STR }, required: ['reset_check'] }
const ANSWERS_SCHEMA = { type: 'object', properties: { answers_check: STR }, required: ['answers_check'] }
const RECOPY_SCHEMA = {
  type: 'object',
  properties: { flow_check: STR, conflicts_check: STR, plan_check: STR, questions_check: STR, answers_check: STR, restore_check: STR, reset_check: STR, backup_check: STR, doc_check: STR, tree_digest: STR, quotes: STR, formal_check: STR, formal_status: STR },
}

// PLANNER_SCHEMA: 流れと裁定を同じ起動で行う planner の返り値（流れの stdout と §resolver の裁定の欄。routes は持たない）。flow_check・conflicts_check は
// 裁定の前に実行した stdout、plan_check は planner:1 の仕分けの stdout、questions_check は回答待ちの問いとこの起動の問いを合わせた 1 回の検査。
const PLANNER_SCHEMA = {
  type: 'object',
  properties: {
    flow_check: STR,
    conflicts_check: STR,
    plan_check: STR,
    questions_check: STR,
    ruled: RULED,
    questions: RULED,
    holds: RULED,
    supersedes: STRS,
    free_text: STRS,
    resolutions_sha256: STR,
  },
  required: ['flow_check', 'conflicts_check', 'ruled', 'questions', 'holds', 'supersedes', 'free_text', 'resolutions_sha256'],
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

// FAIL_KINDS: verifier の不合格の種類（意味は契約「## 決定の台帳」の verifications.json）。decidable だけが決める出典（source）を持つ。
const FAIL_KINDS = ['value_as_method', 'not_reproduced', 'insufficient_grounds', 'mapping', 'decidable', 'layer']
const VERIFIER_SCHEMA = {
  type: 'object',
  properties: {
    pass: STRS,
    fail: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: STR, kind: { type: 'string', enum: FAIL_KINDS }, reason: STR, source: STR },
        required: ['id', 'kind', 'reason'],
      },
    },
    resolutions_sha256: STR,
    flow_check: STR,
    // plan_check: 段 3 の最初の検証だけが返す doc_check plan の stdout（planner:1 の plan の照合。PLAN_LINE）。
    plan_check: STR,
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
    backup_check: STR,
  },
  required: ['unit', 'docs', 'changed_items', 'open_tbd', 'new_tbd', 'applied_findings', 'applied_routes', 'resolutions_sha256', 'backup_check'],
}

const AUDIT_SCHEMA = {
  type: 'object',
  properties: {
    path: STR,
    rejected: STRS,
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
        quotes: STR,
      },
    },
  },
  required: ['path', 'findings'],
}

if (typeof args === 'string') throw new Error('args は JSON の値（オブジェクト）で渡してください。JSON を文字列にした args は受け付けません（references/workflow-io.md §1）')
const input = args || {}
const W = String(input.workspace || '').replace(/\/+$/, '')
const SKILL_DIR = String(input.skillDir || '').replace(/\/+$/, '')
const ENTRY = input.entry || 'new'
const FROM = String(input.from || '1')
if (!W.startsWith('/')) throw new Error('args.workspace に workspace の絶対パスを渡してください（S0 で作ったもの）')
if (!SKILL_DIR.startsWith('/')) throw new Error('args.skillDir にこのスキルの絶対パスを渡してください')
if (!ENTRIES.includes(ENTRY)) throw new Error(`args.entry は ${ENTRIES.join(' / ')} のどれかです（既存文書の監査と改訂は existing）: "${ENTRY}"`)
if (!STAGES.includes(FROM)) throw new Error(`args.from は段の境界（${STAGES.join(' / ')}）のどれかです: "${FROM}"`)
const EXISTING = Array.isArray(input.existing_docs) ? input.existing_docs : []
const badDocs = EXISTING.filter((d) => !d || typeof d !== 'object' || typeof d.key !== 'string' || !DOC_KEY.test(d.key) || typeof d.fixed !== 'boolean')
if (badDocs.length) throw new Error(`args.existing_docs の要素は { key: "<requirements|specifications>/<topic>"（${DOC_KEY.source}）, fixed: true|false } です（合わない要素の key: ${badDocs.map((d) => String(d && d.key)).join(', ')}）`)
if (ENTRY !== 'new' && !EXISTING.length) throw new Error(`entry "${ENTRY}" には args.existing_docs（W に置いた既存文書のキーと fixed）が要ります`)
const FIXED_KEYS = uniq(EXISTING.filter((d) => d.fixed).map((d) => d.key))
const KEEP_KEYS = uniq(EXISTING.map((d) => d.key))
const OPTS = applyRoleOverrides(ROLE_OPTS, input.role_opts)
const SCHEMAS = { FLOW_CHECK_SCHEMA, FORMAL_CHECK_SCHEMA, RESET_SCHEMA, ANSWERS_SCHEMA, RECOPY_SCHEMA, PLANNER_SCHEMA, RESOLVER_SCHEMA, VERIFIER_SCHEMA, WRITER_SCHEMA, AUDIT_SCHEMA }
const KNOWN_CALL = { schemas: new Set(Object.values(SCHEMAS)) }
{
  const defects = [
    ...Object.entries(SCHEMAS).flatMap(([name, schema]) => schemaDefects(schema, name)),
    ...Object.entries(OPTS).map(([role, o]) => callDefect('-', { ...o, schema: PLANNER_SCHEMA, phase: 'Intake', label: role }, KNOWN_CALL)).filter(Boolean),
  ]
  if (defects.length) throw new Error(`script の欠陥（schema か役の opts。prd-spec.js を直すまで run を続けない）: ${defects.join(' / ')}`)
}
// GATES_ANSWERED: 回答を書き終えたゲートと、そのゲートで聞いた問いの ID。プロンプトに入れない（入れると resume でゲートより前の agent が
// 保存された結果から外れ、段 1 の reset が live で走って W を消す）。
const GATES_ANSWERED = input.gates_answered === undefined ? {} : input.gates_answered
if (
  !GATES_ANSWERED || typeof GATES_ANSWERED !== 'object' || Array.isArray(GATES_ANSWERED) ||
  Object.entries(GATES_ANSWERED).some(([g, ids]) => !GATE_NAME.test(g) || Number(GATE_NAME.exec(g)[1]) > MAX_GATES || !Array.isArray(ids) || !ids.length || ids.some((id) => typeof id !== 'string' || !RESOLUTION_ID.test(id)))
) {
  throw new Error(`args.gates_answered は { <ゲート（g1〜g${MAX_GATES}）>: [<needs_answers の question_ids>] } です: ${canonicalText(GATES_ANSWERED)}`)
}
if (input.state !== undefined && input.state_hash !== nextArgsHash(input)) {
  throw new Error('args が next_args の版と違います（state_hash が合いません）。環境の欄（ENV_ARGS）のほかは、返った next_args を変えずに渡し直してください（references/workflow-io.md §3）')
}
const state = JSON.parse(JSON.stringify(input.state || {}))
const startErrors = stateErrors(FROM, state)
// ゲートを g0・g0-2・g1 と名乗っていた版の state には開いた数が無い。0 から数え直すと、次のゲートが前の回答のファイルを同じ名前で上書きする。
if (state.gate !== undefined && state.gates === undefined) startErrors.push('state.gate があるのに state.gates がありません（ゲートを開いた数を持たない版の next_args です。S0 から流し直してください）')
if (startErrors.length) throw new Error(`再開に要る値が args.state にありません: ${startErrors.join(' / ')}`)
// 固定の文書の照合の基準は段 1 の入口の reset だけが作る。基準の無い run を通すと、照合が黙って飛ぶ。
if (FROM !== '1' && canonicalText(Object.keys(state.fixed_sha || {})) !== canonicalText(FIXED_KEYS)) {
  throw new Error(`args.state.fixed_sha（固定の文書 ${list(FIXED_KEYS)} の段 1 の入口の sha256）が existing_docs と合いません。返った next_args を変えずに渡すか、段 1 から始めてください`)
}

if (input.formal !== undefined && input.formal !== false) throw new Error(`args.formal は false だけを受け付けます（formal-method を使わないとき。使うときは欄を付けない）: ${canonicalText(input.formal)}`)
const BASE_ARGS = { workspace: W, skillDir: SKILL_DIR, entry: ENTRY, existing_docs: EXISTING, role_opts: input.role_opts || {}, ...(input.formal === false ? { formal: false } : {}) }
const argsFrom = (from, st) => {
  const out = { ...BASE_ARGS, from, state: JSON.parse(JSON.stringify(st)) }
  return { ...out, state_hash: nextArgsHash(out) }
}
const nextArgs = (from) => argsFrom(from, state)
// extensionOver: 延長のゲート（from 3a'、ゲートを 1 つ開いた state）で返すことになる next_args が上限を超えるか。st は延長の段 6 の入口の state。
// 段の token（tx）は、ゲートを開く段 6 の seq（段 8 から測るときは次の段の分）を 1 つ先に見積もる（桁が増える向き。延長しない側に倒す）。
const extensionOver = (st) => {
  const seq = ((st.tx || {}).seq || 0) + 1
  return worstNextArgsChars(argsFrom("3a'", { ...st, tx: { ...(st.tx || {}), seq }, gates: (st.gates || 0) + 1, gate: `g${(st.gates || 0) + 1}` })) >= NEXT_ARGS_MAX_CHARS
}
const OVER_WHY = `延長すると next_args が打ち直しの上限（NEXT_ARGS_MAX_CHARS = ${NEXT_ARGS_MAX_CHARS}）を超えるので延長しない`

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
const TX_ROLES = ['planner', 'resolver', 'verifier', 'writer']

// failedCalls: 結果を返さずに終わった agent() の数。resume は完了した agent を保存された結果で返すので、失敗した agent が無い blocked を
// resume すると同じ結果を同じ所で返す（resumable が false）。
let failedCalls = 0
// scriptDefect: call() が agent() の前に見つけた script の欠陥（最初の 1 件）。
let scriptDefect = null

function finish(status, extra) {
  if (extra && extra.stop_reason != null && !STOP_REASONS.includes(extra.stop_reason)) throw new Error(`stop_reason "${extra.stop_reason}" は STOP_REASONS（${STOP_REASONS.join(' / ')}）にありません`)
  const written = new Set(state.settled_written || [])
  const holds = uniq(state.holds || [])
  const out = {
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
    skipped,
    // formal_off: formal: false の run が report に渡す値（司令塔が doc_check report --formal-off に渡す。SKILL.md「## 保存と事後報告」）。
    ...(input.formal === false ? { formal_off: true } : {}),
    ...extra,
  }
  const retry = Boolean(out.next_args) && (failedCalls > 0 || out.stop_reason === 'budget')
  return { ...out, resumable: out.resumable ?? (status === 'needs_answers' || (status === 'blocked' && retry)) }
}
// blocked で同じ段からやり直させるときは、その段に入った時点の state を渡す（W は再実行の入口の restore で段に入った時点に戻る）。
// tx.flow は止まった run が最後に照合を通した flow の版で、段に入った時点の版と同じなら載せない（next_args の上限）。
// 入口の restore が返る前に止まったら W は戻っていないかもしれないので、前の回の戻す token と版を渡し直す。
// tx.flow を読むのは restore が flow.json を戻したときの照合だけなので、flow を書く役のいない段（settle を持つ段の外）には載せない。
let restorePending = Boolean(RESUME_TX)
const writesFlow = (stage) => Object.hasOwn(ASKS, stage)
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
// 行は run の中で変わらないもの → 役で決まるもの → 呼び出しで決まるものの順に並べる。前半が同じ呼び出しどうしは prompt の先頭が揃い、
// キャッシュが効く。jobs: planner の仕事の列（1 つなら今の節を指す文、2 つ以上なら続けて行う順）。
const jobLine = (jobs) =>
  jobs.length > 1
    ? `仕事: ${jobs.join(' → ')}（同じ体で続けて行う。agents/planner.md の「## 続けて行う仕事」と各仕事の節）`
    : `仕事: ${jobs[0]}（agents/planner.md の「## ${jobs[0]}」の節）`
function header(role, stage, label, jobs = JOB[role] ? [JOB[role]] : []) {
  return [
    `W（workspace）: ${W}`,
    `SKILL_DIR: ${SKILL_DIR}`,
    `entry: ${ENTRY}`,
    `台帳を ID で引くとき: \`${GET_TEMPLATE}\`（台帳の名前と欄: \`${cli('describe')}\`）`,
    `台帳を全件読むとき: \`${VIEW_TEMPLATE}\``,
    `最初の 1 ターンで ${SKILL_DIR}/agents/${ROLE_FILES[roleOf(role)]}.md の Read と ${contractCmds(roleOf(role))} を並べて実行する。前者の指示に従い、ファイルと返り値の形は後者の stdout をつなげた契約の節を正とする。`,
    ...(jobs.length ? [jobLine(jobs)] : []),
    `段: ${stage}`,
    `作業用ディレクトリ: ${W}/tmp/${fileKey(label)}/`,
    ...(TX_ROLES.includes(role)
      ? [`トークン: ${txToken()}`, `台帳を書く: \`${cli('put', `--ledger <台帳> --token ${txToken()} --input ${W}/tmp/${fileKey(label)}/<名前>.json`)}\`（または標準入力）`]
      : []),
  ].join('\n')
}

function groundsBlock() {
  return [
    '根拠一式（パス。丸ごと読むか ID で引くかは契約「## 共通の約束」の表）:',
    `- ${W}/input.md、${W}/answers/*.md、${W}/decisions.json、${W}/resolutions.json、${W}/flow.json、${W}/plan.json`,
    `- 根拠にしてよい resolution（合格・回答済み）: ${list(usableResolutions(state))}`,
    `- 保持規則として規範文で書く resolution（hold）: ${list(uniq(state.holds))}`,
    `- 無効な決定（覆された・検証に落ちた。根拠にしない）: ${list(invalidIds(state, failedFlow).decisions)}`,
    `- 出典が検証に落ちた流れの要素（この要素を根拠に規範を書かない）: ${list(invalidIds(state, failedFlow).flow)}`,
    `- 開いている TBD: ${list(openTbdOf(state))}`,
  ].join('\n')
}

// pointedLines: 論点ごとの指された根拠（pointedGrounds）。根拠一式の一覧は写さない（ID と about だけ。値は get で読ませる）。
function pointedLines(items) {
  const got = pointedGrounds(items, state)
  if (!got.length) return ''
  const ids = uniq(got.flatMap((x) => x.grounds.map((g) => g.id)))
  return [
    `指された根拠（同じ要素・不変条件・項目に触れる、根拠にしてよい resolution。値は \`${getCli('resolutions', ids)} --fields id,ruling,value\` で読む。扱いは planner.md の「指された根拠」）:`,
    ...got.map((x) => `- ${x.key}: ${x.grounds.map((g) => `${g.id}（${g.about || 'about なし'}）`).join('、')}`),
  ].join('\n')
}
const issueItems = (keys) => (keys || []).map((key) => ({ key }))

function existingNote() {
  if (ENTRY === 'new') return ''
  const rows = EXISTING.map((d) => `- ${d.key}${d.fixed ? '（fixed: 固定の入力。書き換えない）' : ''}`)
  return ['既存文書（W に置いてある。topic を維持する）:', ...rows].join('\n')
}

function domainAssessmentNote() {
  const usable = new Set(usableResolutions(state))
  const rows = Object.entries(state.about || {})
    .filter(([id, about]) => usable.has(id) && String(about || '').startsWith('domain:'))
    .map(([id, about]) => ({ id, aspect: about.slice('domain:'.length) }))
    .sort((a, b) => a.aspect.localeCompare(b.aspect))
  const knownIds = Object.keys(state.about || {}).filter((id) => RESOLUTION_ID.test(id)).map((id) => Number(id.slice(3)))
  const next = `RS-${String(Math.max(0, ...knownIds) + 1).padStart(3, '0')}`
  if (!rows.length) return `現在の domain assessment はありません。新しい評価を作るときの次の resolution ID は ${next} です。`
  const ids = rows.map((r) => r.id)
  return [
    `有効な domain assessment: ${rows.map((r) => `${r.aspect}=${r.id}`).join('、')}`,
    `内容を読む: \`${getCli('resolutions', ids)} --fields id,about,value,supersedes,domain_assessment\`。新しい信号が同じ軸の状態を変える場合は、ここに示す同じ ID を更新する。`,
    `新しい軸の評価を作るときの次の resolution ID: ${next}`,
  ].join('\n')
}

// CONTRACT_PARTS: doc_check の CONTRACT_PARTS と同じ（tests が照合する）。契約の節は Bash の出力の上限ごとに分かれて出るので、全部を同じターンに並べる。
const CONTRACT_PARTS = 3
const contractCmds = (role) => Array.from({ length: CONTRACT_PARTS }, (_, i) => `\`${cli('contract', `--role ${ROLE_FILES[role]} --part ${i + 1}`)}\``).join('・')
const cli = (mode, rest) => `node ${SKILL_DIR}/scripts/doc_check.mjs ${mode} --workspace ${W}${rest ? ` ${rest}` : ''}`
const GET_TEMPLATE = cli('get', '--ledger <台帳> --ids <ID,…>')
const VIEW_TEMPLATE = cli('view', '--ledger <台帳> [--fields <欄,…>]')
const getCli = (ledger, ids) => cli('get', `--ledger ${ledger} --ids ${ids.join(',')}`)
const FINDINGS_READ = `中身の読み方は契約の「### 指摘の形」。ファイルは ${W}/findings/`
const questionsCheck = (ids) => cli('questions', `--ids ${ids.join(',')} --check`)
const RULINGS_FLOW = cli('flow', '--rulings')

// unchecked: 最後の独立な doc_check flow（verifier か flow-check が実行したもの）より後に起動した resolver の label と stdout。
// resolver はどの呼び出しでも台帳を書き、台帳の kind・supersedes・hold は flow.json を変えずに flow の指摘と stale_refs を変える。
// 印は起動の前に付ける（書いてから応答しなかった resolver:final の後も flow-check が数え直す。ほかの呼び出しの null は段を止める）。判断に使う stdout は independentFlow と、問いへの変換の後の verifier（convertFailed）が返し、
// 段の境界で印が残っていれば止める（段を回す loop）。
// 呼び出しの場所ごとに flow-check を足す形にすると、足し忘れた呼び出しの後の判断が resolver の自己申告で決まる。
// ownsFlow: flow.json を書ける resolver の cycle で verifier を外した（unchanged）。flow-check が版の食い違いを見つけても所有表の外の書き込みとは限らず、
// 外す前の v1 の照合（absorbVerifier）と同じく段をやり直せる。
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
// 保持規則の検証ではないので数えない。
const holdFails = {}
const see = (fc) => {
  seen = fc
  failedFlow = fc.failed_current
}

// reconcile: 返り値に載らなかった裁定（応答した resolver が書いたのに返さなかったもの・所有表の外の書き込み）の about と ruling を W から受け取り、
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
  rulingsFromW(fc)
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

// rulingsFromW: state.holds と state.questions を W の今の ruling に合わせる。差し戻しや回答で hold でなくなった ID を残すと、保持規則として
// 数えられ、検証に落ちても変換に回らず、書き直しの回数（holdFails）で止まる。値の裁定になった問いを残すと、回答待ちとして数えられ、
// 誰にも聞かれないまま段の出口で止まる（hold になった問いは残す: 回答待ちからは holds が引く）。W に無い ID は、W から判断できないので残す。
function rulingsFromW(fc) {
  const rs = fc.resolutions.filter((x) => RESOLUTION_ID.test(x.id))
  const notHold = rs.filter((x) => x.ruling !== 'hold').map((x) => x.id)
  const next = minus([...(state.holds || []), ...rs.filter((x) => x.ruling === 'hold').map((x) => x.id)], notHold)
  if (canonicalText(next) !== canonicalText(uniq(state.holds))) state.holds = next
  for (const id of notHold) delete holdFails[id]
  const valued = rs.filter((x) => x.ruling && !UNDECIDED.includes(x.ruling)).map((x) => x.id)
  const asked = minus(state.questions, valued)
  if (canonicalText(asked) !== canonicalText(uniq(state.questions))) state.questions = asked
}

// forget: 書き直した resolution は、前の書き込みで writer に渡した版ではない。written に残すと、書き直した裁定が改稿のどの writer にも渡らない。
function forget(ids) {
  if (state.settled_written && ids.length) state.settled_written = minus(state.settled_written, ids)
}

// budgetOut: token の目標（budget.total）に達したか。達した後の agent() は throw するので、起動の前に見て、stop_reason を budget にして止める
// （見ないと throw が null になり、「応答しませんでした」の blocked に化ける）。目標が無いときの total は null で、0 は「使える token が無い」
// なので達した扱いにする。budget の無い実行環境では常に false。
const budgetOut = () => typeof budget !== 'undefined' && Boolean(budget) && budget.total != null && budget.remaining() <= 0
const budgetStop = (what) => Object.assign(new Error(`token の目標（budget.total）に達したので、${what} を起動できません。目標を上げてこの段からやり直す（呼び直し方は SKILL.md「## 中継」）`), { budgetStop: true })
// notRun: 起動したのに返り値の無い呼び出し。段をやり直させる（段を回す loop が blocked にする）。
const notRun = (what) => (budgetOut() ? budgetStop(what) : Object.assign(new Error(`${what} が${NOT_RUN}`), { rerunStage: true }))

// call: agent() を呼ぶ場所はここだけにする（budget の確かめを通らない呼び出しを作らない。tests が数える）。
// script が作ったプロンプト・schema・opts の誤りは agent() の前に止め、scriptDefect に積む。pipeline の中の throw は runtime が null にするので、
// 段を回す loop が scriptDefect を見て next_args の無い blocked にする（再実行しても同じ所で止まる）。
// それを通った後の agent() の例外（返り値の schema の検証の失敗など）は runtime の側の失敗なので、返り値の無い呼び出しと同じく段から
// やり直せる blocked にする。agentThrew は、null でも止めない finalHold が例外を null と同じに読むための印。
async function call(prompt, opts) {
  const defect = callDefect(prompt, opts, KNOWN_CALL)
  if (defect) {
    const label = opts && opts.label
    scriptDefect = scriptDefect || `${label}: ${defect}`
    throw Object.assign(new Error(`${label}: ${defect}`), { scriptDefect: true })
  }
  if (budgetOut()) throw budgetStop(opts.label)
  try {
    const r = await agent(prompt, opts)
    if (r == null) failedCalls += 1
    return r
  } catch (e) {
    if (budgetOut()) throw budgetStop(opts.label)
    failedCalls += 1
    throw Object.assign(new Error(`${opts.label} が例外で終わりました（${e && e.message ? e.message : e}）。原因を除いてからこの段からやり直す（呼び直し方は SKILL.md「## 中継」）`), { rerunStage: true, agentThrew: true })
  }
}

// issue: 返り値の無い呼び出しは null で返す（段を止めずに続ける呼び出しは finalHold だけ）。
// resolutions_sha256 の無い resolver の返り値を受け取ると、verifier・writer との照合が黙って飛ぶ。出し直すと
// 済んだ put（flow の put / del を含む）を二重に走らせるので、段を頭からやり直させる。
// planner（流れと裁定を同じ起動で行う）は裁定の欄の検査を resolver と同じく受けるが、unchecked の印は付けない（後に必ず verifier が起動する）。
// 聞ける段の指定の外の hold は takeRulings が段の state のもとで書き換え直させる。
async function issue(label, role, prompt, schema, phaseTitle, cmds) {
  const rules = role === 'resolver' || role === 'planner'
  if (role === 'resolver') unchecked = { tag: label.replace(/^resolver:/, ''), responded: false, claimed: null }
  if (rules) {
    seen = null
    wrote = true
  }
  const got = await call(prompt, { ...OPTS[roleOf(role)], schema, phase: phaseTitle, label })
  if (!got && budgetOut()) throw budgetStop(label)
  const r = got && (await recopy(label, got, { ...copyCmds(role), ...cmds }, phaseTitle))
  if (r && role === 'resolver') unchecked = { ...unchecked, responded: true, claimed: flowCheckOf(r.flow_check) }
  // flow を数え直さない flow-check（段 1 の入口の reset、単独の answers）は印を消さない。
  if (r && (role === 'verifier' || (role === 'flowCheck' && r.flow_check !== undefined))) unchecked = null
  if (r && rules && !r.resolutions_sha256) throw Object.assign(new Error(`${label}: ${role} が resolutions_sha256 を返しませんでした`), { rerunStage: true })
  const badIds = r && rules ? [...(r.ruled || []), ...(r.questions || []), ...(r.holds || [])].map((x) => x && x.id).concat(r.free_text || []).filter((id) => !RESOLUTION_ID.test(id)) : []
  if (badIds.length) throw Object.assign(new Error(`${label}: ${role} が resolution の ID の形（${RESOLUTION_ID.source}）に合わない ID を返しました: ${badIds.map((id) => `「${id}」`).join(', ')}`), { rerunStage: true })
  // 1 つの ID は 1 つの種類でしか返せない（問いと回答の両方で返すと、回答待ちか回答済みかが返り値から決まらない）。
  if (r && rules) noTwice(label, r)
  const unordered = r && role === 'resolver' ? unorderedHolds(r) : []
  if (!unordered.length) return r || null
  const stop = () => Object.assign(new Error(`${label}: 依頼者に聞ける段 ${running} で、script が hold を指定していない ${list(unordered)} を resolver が hold で返しました（聞ける段の価値の判断は question にする。planner.md「### 裁定の種類」）`), { rerunStage: true })
  if (label.endsWith(TO_QUESTION)) throw stop()
  return holdsToQuestions(label, r, unordered, phaseTitle, stop)
}

// noTwice: 1 つの ID は 1 つの種類でしか返せない（問いと回答の両方で返すと、回答待ちか回答済みかが返り値から決まらない）。書き換え直しを
// 写した返り値にも当てる（写し方を誤ると、同じ ID が hold と question の両方に残る）。
function noTwice(label, r) {
  const twice = uniq(Object.keys(KIND_WORDS).flatMap((k) => uniq(idsOf(r, k))).filter((id, i, xs) => xs.indexOf(id) !== i))
  if (twice.length) throw Object.assign(new Error(`${label}: resolver が ${list(twice)} を ruled・questions・holds・free_text の 2 つ以上で返しました（契約 §resolver の返り値）`), { rerunStage: true })
}

// rewriteHolds: 聞ける段で指定の外の hold になった ID だけを、同じ段の resolver に問いに書き換え直させる（1 回だけ。まだ hold なら止める）。
// checkIds: questions --check に渡す問い（返り値に写したあとの問いすべて）。
const TO_QUESTION = '-toquestion'
async function rewriteHolds(l, ids, checkIds, phaseTitle, stop) {
  const lines = ids.map((id) => `- ${id} → question`).join('\n')
  const task = keepFlow(`この段では依頼者に聞けるので、script が指定していない hold は受け取れない。次の ID を、値を決めずに question（候補と影響を付ける）に書き換え直す（ID は変えない。欄の消し方は planner.md の「差し戻し」）。返り値の questions にはこの ID だけを入れる。\n${lines}`)
  const r2 = await issue(l, 'resolver', resolverPrompt(l, `${running}（hold を問いに）`, task, checkIds), RESOLVER_SCHEMA, phaseTitle, { questions_check: questionsCheck(checkIds) })
  if (!r2) throw notRun(l)
  if (onlyAsked(l, r2, ids, ['questions'])) throw stop()
  return r2
}

// holdsToQuestions: 返り値の指定の外の hold を書き換え直させ、その ID の分だけを返り値に写す（ほかの ID の裁定は最初の返り値のまま）。
// flow_check は書き換え直しの stdout を使う（台帳が変わった後の指摘）ので、flow.json が同じ版かを確かめる（conflicts_check は最初の返り値のまま使う）。
// also: 同じ questions --check に含める回答待ちの問い（写した返り値の questions_check が、後の形の検査に足りるように）。
async function holdsToQuestions(label, r, ids, phaseTitle, stop, also = []) {
  const l = `${label}${TO_QUESTION}`
  const r2 = await rewriteHolds(l, ids, uniq([...idsOf(r, 'questions'), ...ids, ...also]), phaseTitle, stop)
  const [before, after] = [flowCheckOf(r.flow_check), flowCheckOf(r2.flow_check)]
  if (!after || (before && after.content_sha256 !== before.content_sha256)) {
    noteIntegrity(`${l} の後の flow.json（${after && after.content_sha256}）が、書き換え直す前の版（${before && before.content_sha256}）と違う`)
    throw Object.assign(new Error(`${l}: hold を問いに書き換え直す resolver が flow.json を変えました（この呼び出しは flow.json を書かない）`), { rerunStage: true })
  }
  const merged = { ...r, holds: (r.holds || []).filter((x) => !ids.includes(x && x.id)), questions: [...(r.questions || []), ...r2.questions], resolutions_sha256: r2.resolutions_sha256, flow_check: r2.flow_check, questions_check: r2.questions_check }
  noTwice(l, merged)
  return merged
}

// newHoldsInW: この段に入ってから W に現れた hold のうち、script が指定していないもの。返り値に載せずに台帳に書いた hold は unorderedHolds を
// 通らないので、W から数える（数えないと、聞ける段で依頼者に聞かれないまま保持規則になる）。
function newHoldsInW(fc) {
  if (!asksNow()) return []
  const before = new Set(entryState.holds || [])
  return uniq(fc.resolutions.filter((x) => RESOLUTION_ID.test(x.id) && x.ruling === 'hold' && !before.has(x.id) && !designatedHold(x.id, x.about, fc)).map((x) => x.id))
}

// holdOrders: この段で script が hold を指定した ID と論点（about のキー）。聞ける段（ASKS）で resolver が新しく hold にしてよいのはこれだけ。
// 聞ける段の hold は、聞けば答えの出る論点を依頼者に届けずに保持規則にする。段の入口で空にする。
let holdOrders = { ids: new Set(), abouts: new Set() }
const orderHolds = (ids, abouts = []) => {
  for (const id of ids) holdOrders.ids.add(id)
  for (const k of abouts) holdOrders.abouts.add(k)
}
// closing: finalHold に入った（輪を出て、残った論点を保持規則にする）。その後は依頼者に聞かない。
let closing = false
const asksNow = () => !closing && Object.hasOwn(ASKS, running) && ASKS[running]()
// designatedHold: 聞ける段で resolver が新しく hold にしてよい ID。script の指定（holdOrders）と、依頼者のその問いへの回答を根拠にした hold
// （doc_check flow の answer_holds）。後者を問いに書き換えると、保留と答えた依頼者に聞き直す。unorderedHolds に渡す fc は resolver 自身の stdout なので
// 早い書き換え直しは申告で飛びうる。台帳で決めるのは、独立な stdout を渡す adopt と段の出口の newHoldsInW である。
const designatedHold = (id, about, fc) => holdOrders.ids.has(id) || holdOrders.abouts.has(aboutKey(about)) || Boolean(fc && fc.answer_holds.some((x) => x.id === id))
// answerChosen: decidable の出典がその hold 自身の回答の節の中にある（verifier がその回答を保留でなく実際の選択と読んだ）。
const answerChosen = (f, fc) => {
  const m = f.kind === 'decidable' && /^(.+)#L([1-9]\d*)$/.exec(String(f.source || ''))
  return Boolean(m && fc && fc.answer_holds.some((x) => x.id === f.id && x.file === m[1] && x.from <= Number(m[2]) && Number(m[2]) <= x.to))
}
function unorderedHolds(r) {
  if (!asksNow()) return []
  const held = new Set(state.holds || [])
  const fc = flowCheckOf(r.flow_check)
  return uniq((r.holds || []).filter((x) => x && !held.has(x.id) && !designatedHold(x.id, x.about, fc)).map((x) => x.id))
}

// recopy: doc_check の stdout の写しが copyFault なら、同じコマンドを flow-check に別の label で 1 回だけ実行させて取り直す。cmds は返り値の
// 欄ごとのコマンドで、流し直してよいもの（references/workflow-io.md §3 の「doc_check の stdout の写しが checksum に合わなければ」の項の表）に限る。判断する役（resolver・verifier・監査役）を
// 起動し直して写しを取らない（判断ごとやり直すことになる）。取り直しも合わなければ段からやり直させる。issue を通さないのは、resolver の flow の
// 取り直しで unchecked の印を消さないため（消すと independentFlow が飛ぶ）。
const recopyLabel = (label) => (label.startsWith('flow-check:') ? `${label}-recopy` : `flow-check:${label.replace(/:/g, '-')}-recopy`)
async function recopy(label, x, cmds, phaseTitle) {
  const bad = Object.keys(cmds).filter((k) => cmds[k] && copyFault(x[k]))
  if (!bad.length) return x
  const l = recopyLabel(label)
  const lines = bad.map((k) => `実行する: \`${cmds[k]}\`。stdout を加工せずに ${k} に入れる。`)
  const again = await call([header('flowCheck', running, l), ...lines].join('\n\n'), { ...OPTS.flowCheck, schema: RECOPY_SCHEMA, phase: phaseTitle, label: l })
  if (!again) throw notRun(l)
  const still = bad.filter((k) => !parseStdout(again[k]))
  if (still.length) {
    throw Object.assign(new Error(`${label} と ${l} が返した doc_check の stdout（${still.join('・')}）の写しが 2 回とも checksum（${STDOUT_FNV}）に合いませんでした（壊れた JSON か、欄や要素を欠いた写し）。受け取らずに止めます。この段から next_args で呼び直してください`), { rerunStage: true })
  }
  return { ...x, ...Object.fromEntries(bad.map((k) => [k, again[k]])) }
}

// copyCmds: 役の返り値の欄のうち、引数が呼び出しで変わらないコマンドの stdout。answers・backup・questions --check は呼び出しの場所が渡す。
const copyCmds = (role) => ({
  flow_check: role === 'verifier' || role === 'flowCheck' ? RULINGS_FLOW : cli('flow'),
  conflicts_check: cli('conflicts'),
  plan_check: cli('plan'),
  restore_check: RESUME_TX ? cli('restore', `--token ${RESUME_TX.restore}`) : null,
  reset_check: cli('reset', RESET_FLAGS),
})

// once: 返り値の無い呼び出しは段を止める。
async function once(label, role, prompt, schema, phaseTitle, cmds) {
  const r = await issue(label, role, prompt, schema, phaseTitle, cmds)
  if (!r) throw notRun(label)
  return r
}

// reRuled: 回答を当てる呼び出しでない resolver が ruled に入れた問いは、問いでなくなった（3b で組み直した flow から決まった）。
// 3a・3a' の ruled は回答が当たった問いなので、ここでは引かない。
// free_text は検証に回す。回答の対応づけは解釈を含み、合格しないと回答済みにならない。
// cycleKinds: ruleAndVerify の cycle の中で resolver が ID ごとに最後に返した種類。差し戻し・flow の直し・問いの形の直しの返り値も
// absorbResolver を通るので、ここで記録すれば記録漏れの呼び出しを作れない。
let cycleKinds = {}
function absorbResolver(r, reRuled) {
  for (const k of Object.keys(KIND_WORDS)) for (const id of idsOf(r, k)) cycleKinds[id] = k
  const { ids: aboutIds, about } = resolverIds(r)
  const ids = uniq([...aboutIds, ...(r.free_text || [])])
  state.about = { ...(state.about || {}), ...about }
  const asked = (r.questions || []).map((x) => x.id)
  state.questions = minus(uniq([...(state.questions || []), ...asked]), reRuled ? (r.ruled || []).map((x) => x.id) : [])
  // 問いとして返した ID は、前に回答が当たっていても今は回答待ちである（同じ ID の続きの問い。planner.md の「回答の反映」）。
  if (asked.some((id) => (state.answered || []).includes(id))) state.answered = minus(state.answered, asked)
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
// planned: この cycle の planner の label（by）と裁定（ids）。verifier の stdout の unsettled_refs がそれを引けば、planner が検証を通っていない
// 自分の裁定を flow に書いた（裁定を flow に写すのは検証の後の別の起動）。rerunFrom はその書き込みを戻せる段（段 3 の planner:1 は段 1）。
function absorbVerifier(v, expectedSha, stage, flowChecked, generator, ledgerMoved = null, planned = null) {
  const fc = flowCheckOf(v.flow_check, true)
  if (!fc) return { error: `plan reviewer（段 ${stage}）が doc_check flow の stdout を返しませんでした`, rerun: true }
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
  const own = planned ? fc.unsettled_refs.filter((x) => planned.ids.includes(x.ref)) : []
  if (own.length) {
    for (const x of own) noteIntegrity(`${planned.by} が、検証を通っていない裁定 ${x.ref} を要素 ${x.el} の出典に書いた（verifier（段 ${stage}）の doc_check flow の unsettled_refs）`)
    const where = { ...(planned.rerunFrom ? { rerunFrom: planned.rerunFrom } : { rerun: true }) }
    return { error: `段 ${stage}: ${planned.by} が、検証を通っていない自分の裁定を flow の要素の出典に書きました（${own.map((x) => `${x.el} ← ${x.ref}`).join(', ')}。裁定を flow に写すのは検証の後の別の起動）`, ...where }
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
  const undecidable = (v.fail || []).map((f) => decidableDefect(f, fc)).filter(Boolean)
  if (undecidable.length) return { error: `段 ${stage}: verifier の decidable が受け取れません（${undecidable.join(' / ')}）`, rerun: true }
  const notFlow = (ids) => (ids || []).filter((id) => !/^F-/.test(id))
  const failIds = notFlow((v.fail || []).map((f) => f.id))
  rulingsFromW(fc)
  const held = new Set(state.holds || [])
  // decidable は保持規則の文面の不合格ではなく、保持規則にしたこと自体の不合格なので、書き直し（reholdFailed）ではなく差し戻しに回す。
  const reheld = notFlow((v.fail || []).filter((f) => f.kind !== 'decidable').map((f) => f.id))
  for (const id of reheld) if (held.has(id)) holdFails[id] = (holdFails[id] || 0) + 1
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

// decidableDefect: decidable は「入力・回答・合格した裁定で値が決まるのに、問いか保持規則にした」の不合格である。決める出典が無い decidable は、
// 差し戻された resolver に決める材料を渡せず、同じ問いか保持規則が言い直されるだけになる。値のある裁定への decidable は種類の取り違え。
// deciding: verifier が書いた出典を決まった形に揃える（囲みの ` と引用符・// ・W の絶対パス・W/・行の範囲・:n・小文字の l・行の頭の 0）。揃えても形の外なら askVerifier が聞き直す。
function deciding(src) {
  let s = String(src ?? '').trim().replace(/^[`'"「]+|[`'"」]+$/g, '').trim().replace(/\/{2,}/g, '/')
  if (s.startsWith(`${W}/`)) s = s.slice(W.length + 1)
  s = s.replace(/^(?:W|\.)\//, '').replace(/:(\d+)(?:-\d+)?$/, '#L$1')
  return s.replace(/#[lL]0*(\d+)(?:-[lL]?\d+)?$/, '#L$1')
}
const DECIDING_EXAMPLE = '`input.md#L12`・`answers/g1.md#L3`・`requirements-auth.md#L40`（固定の文書）・`/repo/src/auth.py#L12`（仕様書を書く run の現物）・`RS-004`（行の範囲は最初の行だけ）'
const DECIDING_FILE = /^(?:input\.md|answers\/g[1-9]\d*\.md)#L[1-9]\d*$/
// 固定の文書は別のランで承認された決定なので、その行で値が決まる論点を問いにも保持規則にもしない（仕様書だけを書く run では、問いが
// upstream_gap になる）。仕様書を書く run では、現物（対象リポジトリの行）も実現の手段を決める出典になる（契約「## 現物と既存実装の扱い」）。
const fixedDocLine = (src) => { const m = /^((?:requirements|specifications)-[^/#]+)\.md#L[1-9]\d*$/.exec(src); return Boolean(m) && FIXED_KEYS.includes(m[1].replace('-', '/')) }
// writesSpec: doc_check の writesSpecOf の写し（同じ材料の plan.json の units に当てる）。判定の結果を state で運ぶと、next_args が
// 打ち直しの上限（test_prd_stages の NEXT_ARGS_MAX_CHARS）を超えるので、1 行の述語を写している。
const writesSpec = () => auditDocs().some((k) => k.startsWith('specifications/'))
const repoLine = (src) => writesSpec() && /^\/[^#]+#L[1-9]\d*$/.test(src)
function decidableDefect(f, fc) {
  if (!f || f.kind !== 'decidable') return null
  const row = fc.resolutions.find((x) => x.id === f.id)
  if (!row || !(row.ruling === 'hold' || (row.ruling === 'question' && !row.has_answer))) return `${f.id} は回答待ちの問いでも保持規則でもない`
  const src = typeof f.source === 'string' ? deciding(f.source) : ''
  if (DECIDING_FILE.test(src) || fixedDocLine(src) || repoLine(src)) return null
  if (RESOLUTION_ID.test(src) && src !== f.id && usableResolutions(state).includes(src)) return null
  return `${f.id} の source（${f.source == null ? 'なし' : f.source}）を決める出典として受け取れない（形の例: ${DECIDING_EXAMPLE}。RS- は根拠にしてよい resolution に限る）`
}

// checkIds: questions --check に渡す問いを script が決める呼び出し（書き換え直した分を前の返り値に写すもの）。
function resolverPrompt(label, stage, task, checkIds) {
  const domainContext = task && /plan\.domain|domain assessment/i.test(task) ? domainAssessmentNote() : ''
  return [
    header('resolver', stage, label),
    groundsBlock(),
    `${W}/checks/conflicts.json、${W}/precedent.json も読む。`,
    existingNote(),
    domainContext,
    task,
    checkIds
      ? `返る前に \`${questionsCheck(checkIds)}\` を実行し、stdout を加工せずに questions_check に入れる。`
      : `問いを出したら、返る前に \`${questionsCheck(['<question にした ID をカンマで>'])}\` を実行し、stdout を加工せずに questions_check に入れる。`,
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

// VERIFY_ALL: 検証する要素は W から取らせる。script は書き換えた要素を返り値でしか知らないので、一覧だけにすると、返り値に載せずに書いた
// 呼び出しの書き込みや所有表の外の書き込みを、誰も検証しないまま通す。
const VERIFY_ALL = `検証の最初に \`${cli('flow')}\` を実行し、その unverified のうち failed_current に無い要素すべての source（decision は各 case の source も）を検証して、その F- も pass / fail に入れる。`

function verifierPrompt(label, stage, ids, extra) {
  return [
    header('verifier', stage, label),
    `検証する resolution の ID: ${list(ids)}`,
    `根拠にしてよい resolution（合格・回答済み。decidable の source に挙げてよい）: ${list(usableResolutions(state))}`,
    `decidable の source の形（例）: ${DECIDING_EXAMPLE}`,
    VERIFY_ALL,
    specOnly() ? '仕様書だけを書く run である。問いの `layer` を確かめる（plan-reviewer.md）。' : '',
    extra || '',
    `検証の最後に \`${RULINGS_FLOW}\` を実行し、stdout を加工せずに flow_check に入れる。`,
  ]
    .filter(Boolean)
    .join('\n\n')
}

// askVerifier: 検証を求めていない resolution の合否は数えない。数えると、回答待ちの問いが差し戻しと変換で保持規則に書き換わり、
// 回答済みの問いは不合格の集合に入って黙って消える。W に put された合否が script の持つ合否と違えば、reconcile が carry にして検証させ直す。
// decidable を受け取れない返り値（形の外の出典・値のある裁定への decidable）は、同じ verifier に 1 回だけ聞き直す。止めると、出典の書き方だけで段が止まる。
async function askVerifier(label, stage, given, extra, phaseTitle) {
  const ids = uniq([...given, ...carry])
  const undecidable = (x) => {
    const fc = flowCheckOf(x.flow_check, true)
    const bad = fc ? x.fail.map((f) => decidableDefect(f, fc)).filter(Boolean) : []
    return bad.length ? { count: bad.length, text: bad.join(' / ') } : null
  }
  const ask = (l, note) => once(l, 'verifier', [verifierPrompt(l, stage, ids, extra), note].filter(Boolean).join('\n\n'), VERIFIER_SCHEMA, phaseTitle)
  const done = await rework(await ask(label, ''), undecidable, (_, d, n) => ask(reworkLabel(`${label}-source`, n), `前の返り値の decidable を受け取れなかった（${d.text}）。出典を例の形で書くか、値のある裁定なら decidable にせずに検証し直して返す。`), 1)
  const v = { ...done.got, fail: done.got.fail.map((f) => (f.kind === 'decidable' && typeof f.source === 'string' ? { ...f, source: deciding(f.source) } : f)) }
  carry = minus(carry, [...v.pass, ...v.fail.map((f) => f.id)])
  const unasked = (id) => RESOLUTION_ID.test(id) && !ids.includes(id)
  const dropped = uniq([...v.pass, ...v.fail.map((f) => f.id)].filter(unasked))
  if (dropped.length) state.notices = uniq([...(state.notices || []), `verifier（${label}）が検証を求めていない ${list(dropped)} の合否を返した（合否に数えていない）`])
  return { ...v, pass: v.pass.filter((id) => !unasked(id)), fail: v.fail.filter((f) => !unasked(f.id)) }
}

const ANSWERED_KINDS = ['ruled', 'free_text']
// 変換後の question は関連性と根拠を独立 verifier に再検証させるが、不合格後に resolver へ再度差し戻さない。
// resolver が doc_check flow の stdout を返したら、検証する ID が無くても verifier を起動する。flow の閉包は、生成者の
// stdout と別の agent の stdout の照合でしか script から確かめられない。例外は unchanged のときだけで、そのときは
// settle の independentFlow の flow-check が別の agent の stdout を取る。
async function resolveCycle(stage, opt) {
  const before = usableResolutions(state)
  const res = await ruleAndVerify(stage, opt)
  if (res.error) return res
  // 自由記述の回答は、対応づけが verifier に合格して初めて回答が当たったことになる。合格は問いの形の合格でもありうるので、この cycle の
  // resolver が最後に回答として返した（ANSWERED_KINDS）ものに限る。差し戻しで続きの問いに変えた ID を入れると、次のゲートで聞かれずに落ちる。
  if (opt.answered) state.answered = uniq([...(state.answered || []), ...opt.answered.filter((id) => (res.passed || []).includes(id) && ANSWERED_KINDS.includes((res.kinds || {})[id]))])
  const se = await settle(stage, res.verified || null, opt.phase, before, opt.allowQuestions, opt.reflectLater)
  if (se) return se
  return res
}

// unchanged: 回答を当てた resolver が、検証する resolution も flow の変更も持ち込まず、今の版に合否の無い要素も無い（依頼者の「変えたものの
// 再検証は AI の判断で飛ばさない」に触れないよう、変えたものが無いという事実だけで決める）。flow が段の入口の版のままなら、その版は前の段の出口
// （exitViolation の seen）か入口の enterFromDisk で別の agent が照合している。changed を見るのは、flow を変えた cycle の ruleUnruled が残す
// claimedIssues を、この cycle の verifier 以外に照合させないためでもある。生成者の自己申告で外すが、settle の independentFlow が flow-check に
// 数え直させ、verifyLeft が reconcile で carry を数え直して残りを検証させる。
const unchanged = (fe, ids) => Boolean(fe && fe.fc) && !fe.changed && !ids.length && !unjudgedElements(fe.fc).length

const takeFlow = async (stage, r, phaseTitle, writesFlow, required) => (writesFlow ? applyReturnedFlow(stage, r, phaseTitle, required) : flowKept(stage, r) || { checked: false })

async function ruleAndVerify(stage, opt) {
  const phaseTitle = opt.phase
  const writesFlow = Boolean(opt.answered)
  const entryDigest = state.flow_digest
  // framed: cycle の前に planner が flow を書いた（planner:3b）ときの起動の前の台帳の版。resolver が書かなければその書き込みとして照合し、settle と同じく
  // 台帳が動いたかで流れの仕事の過少申告と台帳由来の指摘を分ける（null にすると過少申告が settle へ素通りする）。
  // given: 生成者（planner）が既に裁定し、state に取り込んだ ID（v1 に検証させる）。planned: その planner の label と裁定（unsettled_refs の照合）。
  // flowFrom: flow.json を書いた前の段の planner（段 3 の planner:1）。v1 の flow がその返した版と違えば、この段の restore では戻らないので段 1 からやり直させる。
  // checkPlan: v1 の返り値に当てる追加の照合（段 3 の plan）。wasQuestion: cycle の入口で回答待ちだった問い（planner の裁定を受け取る前に数えたもの）。
  const flowWriter = () => (state.flow_digest !== entryDigest ? 'resolver' : opt.framed ? 'flowFramer' : null)
  const ledgerMoved = () => (flowWriter() === 'flowFramer' ? state.resolutions_sha256 !== opt.framed.ledger : null)
  const asTask = (t) => (writesFlow ? `${t}\n\ndoc_check flow の指摘のうち ${FRAMER_ONLY_CODES.join('・')} は触らない（${reflector(running)} が open.json に起票して直す。planner.md の「回答の反映」）。` : keepFlow(t, '裁定を flow に写すのは settle の planner である'))
  const wasQuestion = opt.wasQuestion || new Set(pendingQuestions(state))
  let ids = uniq(opt.given || [])
  let flowChecked = Boolean(opt.flowChanged)
  let returned = null
  let byOption = []
  cycleKinds = {}
  const kinds = cycleKinds
  if (opt.task) {
    const label = `resolver:${stage}`
    const r = await once(label, 'resolver', resolverPrompt(label, stage, asTask(opt.task)), RESOLVER_SCHEMA, phaseTitle)
    ids = uniq([...ids, ...absorbResolver(r, !writesFlow)])
    if (opt.targets) state.missed = uniq([...(state.missed || []), ...missedTargets(opt.targets, r)])
    const fe = await takeFlow(stage, r, phaseTitle, writesFlow, Boolean(opt.requireFlow))
    if (fe.error) return fe
    flowChecked = flowChecked || fe.checked
    returned = fe
    const qe = await checkQuestions(stage, stage, r, phaseTitle, opt.recheck)
    if (qe) return qe
    if (opt.answered) {
      // 検証に落ちて問いに変えた裁定は、候補が検証を通っていないので、候補の選択でも verifier に回す。
      const failed = new Set(state.failed_ids || [])
      byOption = (r.ruled || []).map((x) => x.id).filter((id) => opt.answered.includes(id) && !failed.has(id) && kinds[id] === 'ruled')
      state.answered = uniq([...(state.answered || []), ...byOption])
      ids = minus(ids, byOption)
    }
    if (fe.changed) {
      const pe = await ruleUnruled(stage, stage, fe.conflicts, null, phaseTitle, opt.allowQuestions)
      if (pe.error) return pe
      ids = uniq([...ids, ...pe.ids])
    }
  }
  if (!ids.length && !carry.length && !opt.verifyExtra && !flowChecked) return { ok: true, passed: [], kinds }
  const v1Label = `verifier:${stage}v`
  if (unchanged(returned, ids)) {
    skipped.push({ step: v1Label, fact: SKIP.unchanged, ids: byOption })
    unchecked = { ...unchecked, ownsFlow: ownsFlowOf(unchecked, stage) }
    return { ok: true, passed: [], kinds }
  }
  const v1 = await askVerifier(v1Label, `${stage}v`, ids, opt.verifyExtra || '', phaseTitle)
  const v1fc = opt.flowFrom ? flowCheckOf(v1.flow_check, true) : null
  if (v1fc && v1fc.content_sha256 !== state.flow_digest) {
    noteIntegrity(`verifier（段 ${stage}v）が検査した flow.json（${v1fc.content_sha256}）が、${opt.flowFrom} が返した版（${state.flow_digest}）と違う`)
    return { error: `段 ${stage}v: verifier が検査した flow.json が、${opt.flowFrom} が doc_check flow で検査した版と違います（${opt.flowFrom} が返した後に flow.json が書かれた）。段 1 からやり直す`, rerunFrom: '1' }
  }
  const ve1 = absorbVerifier(v1, state.resolutions_sha256, `${stage}v`, flowChecked, flowWriter(), ledgerMoved(), opt.planned)
  if (ve1) return ve1
  if (opt.checkPlan) {
    const pe = opt.checkPlan(v1)
    if (pe) return pe
  }
  let verified = flowCheckOf(v1.flow_check, true)
  if (!v1.fail.length) return { ok: true, passed: v1.pass, verified, kinds }

  const fix = fixOf(stage)
  // 落ちた決定・要素の検証の裁定は価値の論点ではない（落ちた出典の扱い）ので、変換と同じく聞ける段でも保持規則にしてよい。
  orderHolds([], v1.fail.filter((f) => !RESOLUTION_ID.test(f.id)).map((f) => `verification:${f.id}`))
  const r2Label = `resolver:${fix}`
  const r2 = await once(
    r2Label,
    'resolver',
    resolverPrompt(r2Label, `${fix}（差し戻し）`, asTask([`verifier が不合格にした項目だけを 1 回直す（planner.md の「差し戻し」）。D- / F- の項目は about を {verification} にした resolution で置き換える。`, reworkLines(v1.fail), pointedLines(ownItems(v1.fail.map((f) => f.id), state)), opt.answered ? answerExcerpt(state.gate, v1.fail.map((f) => f.id)) : '', `${askNote(opt.allowQuestions)}${DECIDABLE_NOTE}`].filter(Boolean).join('\n'))),
    RESOLVER_SCHEMA,
    phaseTitle
  )
  const unfixed = unreturned(fix, r2, v1.fail.map((f) => f.id).filter((id) => RESOLUTION_ID.test(id)), Object.keys(KIND_WORDS))
  if (unfixed) return { error: unfixed }
  // 落ちた要素は問いにも保持規則にも変えられないので、{verification} の裁定が無いと settle に写す値も、進めてよい理由も無い。
  const ruledAbout = new Set(Object.values(resolverIds(r2).about))
  const unruledEls = v1.fail.map((f) => f.id).filter((id) => /^F-/.test(id) && !ruledAbout.has(`verification:${id}`))
  if (unruledEls.length) return { error: `段 ${fix}: 検証に落ちた要素 ${list(unruledEls)} の about を {verification} にした resolution を resolver が返しませんでした`, rerun: true }
  let ids2 = absorbResolver(r2, !writesFlow)
  const fe2 = await takeFlow(fix, r2, phaseTitle, writesFlow, false)
  if (fe2.error) return fe2
  flowChecked = flowChecked || fe2.checked
  const qe2 = await checkQuestions(stage, fix, r2, phaseTitle, null)
  if (qe2) return qe2
  if (fe2.changed) {
    const pe2 = await ruleUnruled(stage, fix, fe2.conflicts, null, phaseTitle, opt.allowQuestions)
    if (pe2.error) return pe2
    ids2 = uniq([...ids2, ...pe2.ids])
  }
  const v2Label = `verifier:${fix}v`
  const v2 = await askVerifier(v2Label, `${fix}v`, ids2, '', phaseTitle)
  const ve2 = absorbVerifier(v2, state.resolutions_sha256, `${fix}v`, flowChecked, flowWriter(), ledgerMoved())
  if (ve2) return ve2
  verified = flowCheckOf(v2.flow_check, true)
  let passed = uniq([...minus(v1.pass, v2.fail.map((f) => f.id)), ...v2.pass])
  const rh = await reholdFailed(stage, fix, phaseTitle)
  if (rh && rh.error) return rh
  if (rh) verified = rh.fc
  const domainFailures = domainAssessmentFailures(v2.fail, state.about)
  if (domainFailures.length) return { error: `段 ${stage}: domain assessment ${list(domainFailures.map((f) => f.id))} の独立検証が修正後も失敗しました。無効な質問や保持規則に変換せず run を停止します`, rerun: false }
  // 変換は resolution を question か hold に書き換えるだけで、決定や flow の要素は変えられない。落ちた要素は settle が直させる（failedOpen）。
  const toConvert = convertible(v2.fail)
  if (!toConvert.length) return { ok: true, passed, verified, kinds }
  const ce = await convertFailed(stage, stage, toConvert, phaseTitle, opt.allowQuestions, wasQuestion)
  if (ce && ce.error) return ce
  if (ce) {
    verified = ce.fc
    passed = uniq([...passed, ...(ce.passed || [])])
  }
  return { ok: true, passed, verified, kinds }
}

// reworkLines・askNote: 差し戻しのプロンプト。段の本体（ruleAndVerify）と settle・verifyLeft（fixFailed）で同じ文面にする。askNote は
// 裁定を返すどの呼び出しにも付ける（聞ける段で指定の外の hold を返すと、issue が問いに書き換え直させる）。
// decidable は決める出典を渡さないと、差し戻された resolver が同じ問いか保持規則を言い直すだけになる。
const reworkLines = (fails) => fails.map((f) => `- ${f.id}: ${f.kind}${f.reason ? `（${f.reason}）` : ''}${f.kind === 'decidable' ? `（決める出典: ${f.source}）` : ''}`).join('\n')
const askNote = (allowQuestions) =>
  allowQuestions
    ? `この段では依頼者に聞けるので、script が指定しない hold を作らない（根拠を補えない価値の判断は question にする）。${specOnly() ? `\n${SPEC_LAYER_NOTE}` : ''}`
    : `この段では依頼者に聞けないので、根拠を補えない価値の判断は question ではなく hold にする。${specOnly() ? `\n${SPEC_REQ_NOTE}` : ''}`
// SPEC_LAYER_NOTE: 仕様書だけを書く run の問いの layer。手段の問いだけを依頼者に聞き、ほかは要求文書の抜け（upstream_gap）にする（needsAnswers）。
const SPEC_LAYER_NOTE = '仕様書だけを書く run: 問いには `layer` を付ける（契約 §resolver）。'
// SPEC_REQ_NOTE: 聞けない段でも、仕様書だけを書く run の要求の論点は question のまま返させる（script が upstream_gap にする。requirementGap）。
const SPEC_REQ_NOTE = '仕様書だけを書く run: `layer: 要求` の問いは hold にせず question のまま返す（契約 §resolver）。'
const DECIDABLE_NOTE = 'decidable の項目は、その出典で値を決める。'

// convertible: 差し戻しの後も落ちた裁定のうち、変換に回すもの。hold のまま落ちた保持規則は書き直し（reholdFailed）に回すが、decidable で
// 落ちた保持規則は文面の誤りではないので変換に回す（聞ける段で価値の論点なら問いにする）。
const convertible = (fails) => fails.filter((f) => RESOLUTION_ID.test(f.id) && (f.kind === 'decidable' || !(state.holds || []).includes(f.id)))

// fixFailed: settle と verifyLeft の verifier に落ちた裁定（RS-）を、段の本体の差し戻しと同じく 1 回だけ直させて検証し直し、domain assessment 以外で
// まだ落ちるものを変換する。domain assessment は修正後も不合格なら下のガードで blocked にする。直さずに変換すると、補えた根拠や決まっていた値が問いや保持規則になる。
// 問いに変えたものは `convertFailed` の後続 verifier が関連性と根拠を再検証し、さらに resolver へは差し戻さない。
async function fixFailed(stage, owner, fails, phaseTitle, allowQuestions) {
  const ids = uniq(fails.map((f) => f.id))
  const label = `resolver:${owner}-fix`
  const r = await once(
    label,
    'resolver',
    resolverPrompt(label, `${owner}（差し戻し）`, keepFlow([`verifier が不合格にした項目だけを 1 回直す（planner.md の「差し戻し」。理由は \`${getCli('verifications', ids)}\`）。`, reworkLines(fails), pointedLines(ownItems(ids, state)), answerExcerpt(state.gate, ids), `${askNote(allowQuestions)}${DECIDABLE_NOTE}`].filter(Boolean).join('\n'))),
    RESOLVER_SCHEMA,
    phaseTitle
  )
  const bad = onlyAsked(`${owner}-fix`, r, ids, ['ruled', ...takenKinds(allowQuestions)])
  if (bad) return { error: bad }
  absorbResolver(r)
  const kept = flowKept(`${owner}-fix`, r)
  if (kept) return kept
  const qe = await checkQuestions(stage, `${owner}-fix`, r, phaseTitle, null)
  if (qe) return qe
  const v = await askVerifier(`verifier:${owner}-fixv`, `${owner}v（差し戻し）`, ids, '', phaseTitle)
  const ve = absorbVerifier(v, state.resolutions_sha256, `${owner}-fixv`, false, null)
  if (ve) return ve
  let fc = flowCheckOf(v.flow_check, true)
  const rh = await reholdFailed(stage, `${owner}-fix`, phaseTitle)
  if (rh && rh.error) return rh
  if (rh) fc = rh.fc
  const domainFailures = domainAssessmentFailures(v.fail, state.about)
  if (domainFailures.length) return { error: `段 ${stage}: domain assessment ${list(domainFailures.map((f) => f.id))} の独立検証が修正後も失敗しました。無効な質問や保持規則に変換せず run を停止します`, rerun: false }
  const ce = await convertFailed(stage, owner, convertible(v.fail), phaseTitle, allowQuestions)
  if (ce && ce.error) return ce
  return { fc: ce ? ce.fc : fc }
}

// independentFlow: 判断（settle の起動・残りの数え上げ・直す役の割り当て）に使う doc_check flow の stdout。最後の verifier の後に
// resolver を起動していたら（unchecked）、その resolver と別の agent（flow-check）に実行し直させ、その stdout だけを使う。
// verifier の stdout があれば、閉じた O- を引く要素（open_only）はそこから取る。その後の resolver は flow と合格の集合を変えない
// （変換と保持規則への変換は onlyAsked、flow は flowKept で確かめる）。
async function independentFlow(verified, phaseTitle) {
  if (!unchecked) return { fc: verified }
  const { tag, responded, claimed, ownsFlow } = unchecked
  const label = `flow-check:${tag}`
  const x = await once(label, 'flowCheck', [header('flowCheck', tag, label), `実行する: \`${RULINGS_FLOW}\`。stdout を加工せずに flow_check に入れて返す。`].join('\n\n'), FLOW_CHECK_SCHEMA, phaseTitle)
  const fc = x && flowCheckOf(x.flow_check, true)
  if (!fc) return { error: `flow-check（段 ${tag}）が doc_check flow の stdout を返しませんでした`, rerun: true }
  if (fc.content_sha256 !== state.flow_digest) {
    noteIntegrity(`flow-check（段 ${tag}）が検査した flow.json（${fc.content_sha256}）が、検証を通った版（${state.flow_digest}）と違う`)
    if (ownsFlow) return { error: `段 ${tag}: W の flow.json が、resolver が申告した版ではありません（この版は検証していません）`, rerun: true }
    return { error: `段 ${tag}: resolver の後に flow.json が変わっています。所有表の外で flow.json を書いたものを確かめる`, rerun: false }
  }
  const unknown = Object.keys(fc.codes).filter((code) => !FIXERS_BY_CODE[code])
  if (unknown.length) return { error: `段 ${tag}: flow-check の doc_check flow に直し手の表（FIXERS_BY_CODE）に無い符号があります: ${unknown.join(', ')}`, rerun: false }
  see(fc)
  // resolutions は --rulings、lint の欄は --lint の実行にだけ出るので、両側から外して比べる（付けて実行しても申告の食い違いにしない）。
  if (responded) noteClaim(tag, claimed, fc, 'flow-check')
  if (!verified) return { fc }
  const stale = [...verified.stale_refs, ...fc.stale_refs.filter((x) => !verified.stale_refs.some((y) => y.el === x.el && y.ref === x.ref))]
  return { fc: { ...fc, open_only: verified.open_only, stale_refs: stale } }
}

// noteClaim: resolver の申告した doc_check flow の stdout（said）を、別の役が同じ flow.json で実行した stdout（fc）と欄ごとに照らす。
// resolutions は --rulings、lint の欄は --lint の実行にだけ出るので、両側から外して比べる（付けて実行しても申告の食い違いにしない）。
// drop: 照らさない欄（問いへの変換の後の verifier は verifications.json を put してから flow を実行するので、合否を読む欄は正当に違いうる）。
const VERDICT_KEYS = ['unverified', 'failed_current', 'unsettled_refs', 'stale_refs']
function noteClaim(tag, said, fc, who, drop = []) {
  const plain = (o) => Object.fromEntries(Object.entries(o).filter(([k]) => k !== 'resolutions' && !k.startsWith('lint') && !drop.includes(k)))
  const [ran, told] = [plain(fc), said && plain(said)]
  const differ = told ? uniq([...Object.keys(ran), ...Object.keys(told)].filter((k) => canonicalText(ran[k]) !== canonicalText(told[k]))) : ['stdout']
  if (differ.length) noteIntegrity(`resolver（段 ${tag}）が返した doc_check flow の stdout が、${who} が同じ flow.json で実行した stdout と ${differ.join('・')} で違う`)
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
// takenKinds: 裁定の呼び出し（段の本体・settle・差し戻し）から受け取る種類。仕様書だけを書く run では、聞けない段でも question を受け取る
// （要求の論点を段の出口で upstream_gap にするため。仕様の論点の問いは段の最後の holdLeft が保持規則にする）。変換は指定どおりの種類だけ。
const takenKinds = (allowQuestions) => answerKinds(allowQuestions || specOnly())

function outsideKinds(stage, r, kinds) {
  const extra = uniq(['ruled', 'questions', 'holds'].filter((k) => !kinds.includes(k)).flatMap((k) => idsOf(r, k)))
  return extra.length ? `段 ${stage}: ${list(extra)} を resolver が ${kinds.map((k) => KIND_WORDS[k]).join('・')} 以外で返しました（この段では依頼者に聞けない）` : null
}

// convertFailed: 差し戻しの後も検証に落ちた裁定（RS-）を、値を決めずに question か hold に書き換える。question は独立 verifier に relevance と根拠を
// 再検証させ、落ちたら run を止める（根拠不足の裁定を問いに変えるだけで検証を迂回できると、質問条件を満たさない問いがゲートに届く）。聞ける段では、価値の論点（VALUE_ABOUT）・価値の判断・cycle の入口で問いだった ID を
// question にする。hold にすると、依頼者に聞けば答えの出る論点が保持規則になる。検証の裁定（{verification}）は decidable でも価値の論点ではない。
// 依頼者の回答を根拠にした hold（answer_holds。designatedHold）は hold のまま変える（問いにすると、保留と答えた依頼者に聞き直す）。ただし decidable の
// 出典がその回答の節なら回答は実際の選択で、差し戻しで当てさせても hold のままなので、これまでどおり問いにする（hold のままだと依頼者の回答が保持規則に化ける）。
// decidable で落ちたものは値の無い裁定（回答待ちの問いか保持規則。decidableDefect が verifier の stdout で確かめた）なので、既にその種類なら書き換えない。
// wasQuestion: 差し戻しの cycle の入口で回答待ちだった問い。settle の verifier の合否は askVerifier がその回に裁定した ID に限るので渡さない。
async function convertFailed(stage, owner, fails, phaseTitle, allowQuestions, wasQuestion = new Set()) {
  const answerHeld = (f) => Boolean(seen && seen.answer_holds.some((x) => x.id === f.id)) && !answerChosen(f, seen)
  const to = (f) => (allowQuestions && !answerHeld(f) && (f.kind === 'value_as_method' || wasQuestion.has(f.id) || valueKey((state.about || {})[f.id])) ? 'question' : 'hold')
  const already = (f) => f.kind === 'decidable' && (to(f) === 'hold') === (state.holds || []).includes(f.id)
  const todo = uniq(fails.filter((f) => !already(f)).map((f) => f.id)).map((id) => fails.find((f) => f.id === id))
  if (!todo.length) return null
  orderHolds(todo.filter((f) => to(f) === 'hold').map((f) => f.id))
  const convert = todo.map((f) => `- ${f.id} → ${to(f)}（${f.kind}）`).join('\n')
  log(`段 ${owner}: 検証に落ちた ${todo.length} 件を、理由で問いと保持規則に分けます`)
  const label = `resolver:${owner}-convert`
  const r = await once(
    label,
    'resolver',
    resolverPrompt(label, `${owner}（変換）`, keepFlow(`次の項目は検証に落ちた。値を決めずに、指定のとおり question（候補と影響を付ける）か hold（保持規則と Issue の文案）に書き換える。ID は変えない。\n${convert}`)),
    RESOLVER_SCHEMA,
    phaseTitle
  )
  const bad = onlyAsked(owner, r, todo.map((f) => f.id), answerKinds(allowQuestions))
  if (bad) return { error: bad }
  const kindOf = (f) => (to(f) === 'question' ? 'questions' : 'holds')
  const swappedIn = (x, fs) => fs.filter((f) => !idsOf(x, kindOf(f)).includes(f.id))
  let got = r
  const swapped = swappedIn(r, todo)
  if (swapped.length) {
    // 指定と違う種類で返したら 1 回だけ書き換え直させ、その ID の分だけを返り値に写す。
    const l = `resolver:${owner}-convert-kind`
    const ids = swapped.map((f) => f.id)
    const asked = uniq([...idsOf(r, 'questions').filter((id) => !ids.includes(id)), ...swapped.filter((f) => to(f) === 'question').map((f) => f.id)])
    const r2 = await once(l, 'resolver', resolverPrompt(l, `${owner}（変換の種類の直し）`, keepFlow(`次の項目を指定と違う種類で返した。値を決めずに、指定のとおりに書き換え直す。ID は変えない。\n${swapped.map((f) => `- ${f.id} → ${to(f)}（${f.kind}）`).join('\n')}`), asked.length ? asked : null), RESOLVER_SCHEMA, phaseTitle)
    const bad2 = onlyAsked(`${owner}-convert-kind`, r2, ids, answerKinds(allowQuestions))
    if (bad2) return { error: bad2 }
    const still = swappedIn(r2, swapped).map((f) => f.id)
    if (still.length) return { error: `段 ${owner}: ${list(still)} を resolver が書き換え直しても指定と違う種類（question と hold）で返しました` }
    const keep = (k) => [...(r[k] || []).filter((x) => !ids.includes(x && x.id)), ...(r2[k] || [])]
    got = { ...r, questions: keep('questions'), holds: keep('holds'), resolutions_sha256: r2.resolutions_sha256, flow_check: r2.flow_check, questions_check: asked.length ? r2.questions_check : r.questions_check }
    noTwice(l, got)
  }
  absorbResolver(got)
  const kept = flowKept(`${owner}-convert`, got)
  if (kept) return kept
  const qe = await checkQuestions(stage, `${owner}-convert`, got, phaseTitle, null)
  if (qe) return qe
  const questions = todo.filter((f) => to(f) === 'question').map((f) => f.id)
  if (!questions.length) return null
  // 問いへの変換の後は flow-check で数え直さず、直後の verifier の stdout を判断に使う（absorbVerifier が版・符号・see を行う）。
  // resolver の申告は verifier の issue が unchecked を消す前に取り、verifier の put で変わらない欄で照らす（VERDICT_KEYS を外す）。
  const claim = unchecked && unchecked.responded ? { tag: unchecked.tag, said: unchecked.claimed } : null
  const labelV = `verifier:${owner}-convertv`
  const v = await askVerifier(labelV, `${owner}v（問いへの変換）`, questions, '', phaseTitle)
  const ve = absorbVerifier(v, state.resolutions_sha256, `${owner}-convertv`, false, null)
  if (ve) return ve
  if (claim) noteClaim(claim.tag, claim.said, flowCheckOf(v.flow_check, true), `verifier（段 ${owner}-convertv）`, VERDICT_KEYS)
  const rejected = v.fail.filter((f) => questions.includes(f.id))
  if (rejected.length) {
    return { error: `段 ${stage}: 問いへの変換後も関連性・根拠の検証に落ちました（${rejected.map((f) => `${f.id}: ${f.kind}${f.reason ? `（${f.reason}）` : ''}`).join(' / ')}）。条件を満たす質問として確認できるまで依頼者に提示できません`, rerun: false }
  }
  const missing = minus(questions, v.pass)
  if (missing.length) return { error: `段 ${stage}: 問いへの変換後の独立検証が合格を返しませんでした（${list(missing)}）。確認できるまで依頼者に提示できません`, rerun: false }
  return { fc: flowCheckOf(v.flow_check, true), passed: v.pass.filter((id) => questions.includes(id)) }
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
    `flow を変えた後に、まだ裁定の無い論点がある。これだけを裁定する（planner.md の「flow を変えた後の未裁定の論点」）。`,
    pairs.length ? `- まだ裁定の無い組（${W}/checks/conflicts.json）: ${list(pairs)}` : '',
    opens.length ? `- まだ裁定の無い open: ${list(opens.map((k) => k.slice(5)))}（\`${getCli('open', opens.map((k) => k.slice(5)))}\`）` : '',
    pointedLines(issueItems([...opens, ...pairs])),
    askNote(allowQuestions),
  ]
    .filter(Boolean)
    .join('\n')
  const r = await once(label, 'resolver', resolverPrompt(label, `${owner}（未裁定の論点）`, keepFlow(task, '組と未決の裁定は flow を変えない')), RESOLVER_SCHEMA, phaseTitle)
  const outside = outsideKinds(`${owner}-${tag}`, r, ['ruled', ...takenKinds(allowQuestions)])
  if (outside) return { error: outside }
  const ids = absorbResolver(r)
  state.missed = uniq([...(state.missed || []), ...missedTargets([...opens, ...pairs], r)])
  const kept = flowKept(`${owner}-${tag}`, r)
  if (kept) return kept
  const qe = await checkQuestions(stage, `${owner}-${tag}`, r, phaseTitle, null)
  if (qe) return qe
  return { ids }
}

// frameRun: lint は flow を起草する planner（planner:1・planner:3b）だけに付ける。settle の planner は裁定を写すだけで、lint で要素を
// 書き換えさせると <段>v-settle が検証する要素が増え、settle の収束（MAX_SETTLE_ROUNDS）が変わる。流れの仕事の後に同じ体が裁定するので、
// 返す 2 つの stdout は裁定の前のもの（裁定で台帳から出る指摘を流れの仕事の不合格にしない）。
const FLOW_THEN_RULE = '流れを閉じてから裁定に移る。裁定の後は flow.json・open.json・plan.json・decisions.json を書かない（その裁定を flow に写すのは、検証の後の別の起動）。'
const frameRun = (lint) =>
  lint
    ? `実行する: \`${cli('flow', '--lint')}\` を findings と lint の両方が 0 件になるまで（3 回まで。lint の直し方は ${W}/checks/flow.lint.json の fix）、最後に \`${cli('conflicts')}\`。最後に実行した 2 つの stdout を加工せずに flow_check と conflicts_check に入れる。${FLOW_THEN_RULE}`
    : `実行する: \`${cli('flow')}\` を 0 件になるまで（3 回まで）、最後に \`${cli('conflicts')}\`。最後に実行した 2 つの stdout を加工せずに flow_check と conflicts_check に入れる。${FLOW_THEN_RULE}`

const reworkLabel = (label, n) => (n === 1 ? label : `${label}-${n}`)
// fixOf: v1 の不合格の差し戻しの段名。段名（STAGES）に 3a' があるので、`'` を足す形にすると段 3a の差し戻しと段 3a' の本体が同じ label になり、
// label だけを持つ journal の started から起動の理由を分けられない。
const fixOf = (stage) => `${stage}-fix`

// lintOf: lint の件数（欄が無ければ null）。lint_codes の件数の和と合わない写しも受け取らない。
function lintOf(fc) {
  if (!fc || !Number.isInteger(fc.lint) || !fc.lint_codes || typeof fc.lint_codes !== 'object' || Array.isArray(fc.lint_codes)) return null
  const codes = Object.values(fc.lint_codes)
  return codes.every(Array.isArray) && codes.reduce((n, xs) => n + xs.length, 0) === fc.lint ? fc.lint : null
}

// ruleLine・plannerQuestions: planner の裁定の仕事の行と、問いの検査の行。questions --check は回答待ちの問い（waiting）とこの起動で question にした ID を
// 合わせて 1 回にする（別々に実行させると、どちらかの stdout だけが返る）。resolutions_sha256 は何も書かなくても返させる（返り値の検査が要る）。
const ruleLine = (what) => `裁定: ${what}指された根拠は、根拠一式の「根拠にしてよい resolution」から自分で引く。返る前に \`${cli('sha', `--ledger resolutions`)}\` を実行し、その sha256 を resolutions_sha256 に入れる（何も書かなくても）。`
const plannerQuestions = (waiting) =>
  waiting.length
    ? `返る前に、回答待ちの問い ${list(waiting)} とこの起動で question にした ID を合わせて 1 回 \`${questionsCheck(waiting)}\` を実行し（question にした ID があれば --ids に足す）、stdout を加工せずに questions_check に入れる。`
    : `問いを出したら、返る前に \`${questionsCheck(['<question にした ID をカンマで>'])}\` を実行し、stdout を加工せずに questions_check に入れる。`

// planCall: 流れと裁定を同じ起動で行う planner の呼び出し（段 1 は仕分けも）。返った stdout が plan（plan のとき）・flow・conflicts・lint（lint のとき）の検査に
// 落ちれば、不合格をまとめて 1 回だけ差し戻し（planRework）、それでも plan か flow か conflicts が落ちれば止める。lint だけが残ったときは止めずに notices に出す
// （lint は生成者の自己点検で、止める判断は verifier の flow の検査が持つ）。差し戻しで flow が閉じなくなっても前の版には戻さない（戻す控えを取らない）。
// 表に無い符号（stop）は誰が消せるか分からないので差し戻さずに止める。lines は label を受ける（差し戻しは header の label と作業用ディレクトリを組み直す）。
// specNote: 仕様書を書かない run では、flow の要素は要求文書の要求になる。発生源の無い要素は doc_check が振らず NC_FLOW_NO_ORIGIN に回す（prd-and-spec.md §11.1）ので、
// 描く範囲を絞らせる。writesSpec は state.units を読むので、units の無い段 1 は外し、段 1 のプロンプトが条件付きの行を持つ。
async function planCall(label, lines, phaseTitle, { lint = false, plan = false, specNote = true } = {}) {
  // redo: 差し戻しでやり直す範囲（'仕分け' か '流れ'。元の起動は null）。流れからの差し戻しには仕分けの行を載せない（lines が redo で決める）。
  const prompt = (l, redo = null) => {
    const [head, ...rest] = lines(l, redo)
    return [head, specNote && !writesSpec() ? '作る文書は要求文書だけなので、planner.md の「#### 要求文書だけのラン」で描く。' : null, ...rest].filter(Boolean).join('\n\n')
  }
  const cmds = lint ? { flow_check: cli('flow', '--lint') } : undefined
  const faults = (x) => {
    const out = []
    if (plan) {
      const pc = planCheckOf(x.plan_check)
      if (!pc) out.push({ kind: 'plan', text: 'doc_check plan の stdout が無いか、plan.json の units が形（id・空でない docs・depends_on）を満たしません' })
      else if (pc.findings > 0) out.push({ kind: 'plan', text: `doc_check plan の指摘が ${pc.findings} 件あります（${W}/checks/plan.json）` })
    }
    const fc = flowCheckOf(x.flow_check)
    const fd = flowDefect(fc, 'flowFramer', `${W}/checks/flow.json`, reflector(running))
    if (fd) out.push({ kind: 'flow', text: fd.text, stop: Boolean(fd.stop) })
    if (!conflictsCheckOf(x.conflicts_check)) out.push({ kind: 'conflicts', text: 'doc_check conflicts の stdout がありません' })
    const n = lint && fc ? lintOf(fc) : 0
    if (n !== 0) out.push({ kind: 'lint', n, text: n === null ? `\`${cli('flow', '--lint')}\` の stdout ではない（lint の欄が無い）` : `doc_check flow --lint の lint が ${n} 件あります（${W}/checks/flow.lint.json）` })
    return out
  }
  let x = await once(label, 'planner', prompt(label), PLANNER_SCHEMA, phaseTitle, cmds)
  let f = faults(x)
  const stopNow = f.filter((d) => d.stop)
  if (!stopNow.length && f.length) x = await planRework(label, prompt, x, f, phaseTitle, cmds)
  const fc = flowCheckOf(x.flow_check)
  // 閉じていない版でも W の flow.json は planner が書いた版で、照合を通った書き込みとして入口の照合（enterFromDisk）に渡す。
  if (fc) state.flow_digest = fc.content_sha256
  f = stopNow.length ? stopNow : faults(x)
  const stops = f.filter((d) => d.kind !== 'lint')
  if (stops.length) return { error: `${stopNow.length ? '' : '差し戻しの後も'}検査に落ちました: ${stops.map((d) => d.text).join(' / ')}`, rerun: !stops.some((d) => d.stop) }
  const left = f.find((d) => d.kind === 'lint')
  if (left) state.notices = [...(state.notices || []), `${label} が lint を残して返した（${left.n === null ? 'lint の欄が無い' : `${left.n} 件。${W}/checks/flow.lint.json`}。verifier の検査は変わらない）`]
  return { fc, cc: conflictsCheckOf(x.conflicts_check), r: x }
}

// planRework: 不合格をまとめた 1 回の差し戻し。plan が落ちていれば仕分けから、ほかは流れから直させる。前の体の裁定は resolutions.json に残っているので
// 書き直させず、直した flow でまだ裁定の無い組と O- だけを裁定させ、返り値の裁定の欄にはこの体で書いた ID だけを入れさせる（mergeRulings が合わせる）。
async function planRework(label, prompt, first, f, phaseTitle, cmds) {
  const l = `${label}:rework`
  const from = f.some((d) => d.kind === 'plan') ? '仕分け' : '流れ'
  const asked = idsOf(first, 'questions')
  const note = [
    `返した stdout が不合格だった: ${f.map((d) => d.text).join(' / ')}。`,
    `「${from}」から直して返す（planner.md の「## 続けて行う仕事」の差し戻し）。前の体が書いた裁定は resolutions.json にある。書き直さず、`,
    `直した flow でまだ裁定の無い組と O- だけを裁定し、返り値の裁定の欄にはこの体で書いた（書き直した）ID だけを入れる。`,
    asked.length ? `questions --check には前の体が question にした ${list(asked)} も含める。` : '',
  ].join('')
  const again = await once(l, 'planner', `${prompt(l, from)}\n\n${note}`, PLANNER_SCHEMA, phaseTitle, cmds)
  const merged = mergeRulings(l, first, again)
  // 流れからの差し戻しは仕分けをやり直さないので、仕分けの結果（plan_check）は前の体の返り値のものを使う（plan.json は段 3 の plan reviewer が照らし直す）。
  return from === '流れ' && first.plan_check !== undefined ? { ...merged, plan_check: first.plan_check } : merged
}

// mergeRulings: 差し戻しの返り値に元の返り値の裁定を合わせる。stdout の欄と resolutions_sha256 は差し戻しの値、裁定の欄は元の返り値から差し戻しに
// 現れる ID を除いて差し戻しを足す（同じ ID は差し戻しの種類が勝つ）。
function mergeRulings(l, first, again) {
  const redone = new Set(Object.keys(KIND_WORDS).flatMap((k) => idsOf(again, k)))
  const merged = { ...again, supersedes: uniq([...(first.supersedes || []), ...(again.supersedes || [])]) }
  for (const k of Object.keys(KIND_WORDS)) merged[k] = [...(first[k] || []).filter((x) => !redone.has(typeof x === 'string' ? x : x && x.id)), ...(again[k] || [])]
  noTwice(l, merged)
  return merged
}

// takeRulings: planner の返り値の裁定を state に取り込む（issue が resolver の返り値に行う後処理と同じ: 聞ける段の指定の外の hold の書き換え直し・
// 聞けない段の問いの拒否・問いの形の検査）。owner は書き換え直しと形の修正の label（resolver:<owner>-toquestion・-questions）で、保険の resolver の派生と
// 重ならないものにする。回答の節を持ちうる ID（recheck と回答済みの問い）の hold は、planner の stdout が裁定の前のもので answer_holds に載らないので
// 早い書き換え直しから外し、段の出口の adopt（独立な stdout）に任せる。裁定の欄が空の返り値は取り込まない（自己申告の sha で台帳が動いたことにしない）。
async function takeRulings(stage, owner, r, phaseTitle, { allowQuestions, recheck = null, reRuled = false, targets = [] } = {}) {
  let got = r
  const late = new Set([...(recheck || []), ...(state.answered || [])])
  const unordered = unorderedHolds(r).filter((id) => !late.has(id))
  if (unordered.length) {
    const l = `resolver:${owner}`
    const stop = () => Object.assign(new Error(`${l}: 依頼者に聞ける段 ${running} で、script が hold を指定していない ${list(unordered)} を planner が hold で返しました（聞ける段の価値の判断は question にする。planner.md「### 裁定の種類」）`), { rerunStage: true })
    got = await holdsToQuestions(l, r, unordered, phaseTitle, stop, minus(recheck, [...idsOf(r, 'ruled'), ...idsOf(r, 'holds'), ...idsOf(r, 'free_text')]))
  }
  const outside = outsideKinds(owner, got, ['ruled', ...takenKinds(allowQuestions)])
  if (outside) return { error: outside }
  const ruledNothing = [...Object.keys(KIND_WORDS), 'supersedes'].every((k) => !(got[k] || []).length)
  const ids = ruledNothing ? [] : absorbResolver(got, reRuled)
  if (targets.length) state.missed = uniq([...(state.missed || []), ...missedTargets(targets, got)])
  const qe = await checkQuestions(stage, owner, got, phaseTitle, recheck)
  if (qe) return qe
  return { ids }
}

// staleOf: settle の planner に直させる出典の食い違い。覆された決定を引く要素（stale_refs）と、決まっていない裁定を引く要素（unsettled_refs。
// 前の段の裁定が検証に落ちた・問いや保持規則に変わった後も引いている）。その cycle の planner の裁定を引くものは、ここに来る前に absorbVerifier が止める。
const staleOf = (fc) => {
  const seenRefs = new Set(fc.stale_refs.map((x) => `${x.el}|${x.ref}`))
  return [...fc.stale_refs, ...(fc.unsettled_refs || []).filter((x) => !seenRefs.has(`${x.el}|${x.ref}`))]
}

function reflection(fc, before) {
  const settled = new Set(usableResolutions(state))
  const ruled = (el) => verificationRulings(state, el).some((id) => settled.has(id))
  const failed = failedOpen(fc, state, true)
  return {
    left: settledTerminals(fc.open_only, state),
    found: settledFlowFindings(pendingFindings(state.pending), state, before, (state.pending || {}).recurring),
    verdicts: failed.filter(ruled),
    stale: staleOf(fc),
    handoff: flowFindings(fc),
    redo: failed.filter((el) => !ruled(el)),
  }
}
const reflects = (m) => Object.values(m).some((xs) => xs.length)

// reflectLines: 裁定の反映のプロンプトの行。settle の planner と、3a の反映を引き受ける planner:3b で同じ文面にする。
function reflectLines(m) {
  const settled = new Set(usableResolutions(state))
  const closers = (key) => uniq(Object.entries(state.about || {}).filter(([id, k]) => k === key && settled.has(id)).map(([id]) => id))
  const recurring = (state.pending || {}).recurring || {}
  const recurFound = m.found.filter((id) => pendingFindings(state.pending).some((f) => f.id === id && recurring[itemKey(f)]))
  return [
    m.left.some((x) => x.open) ? `要素（閉じた O- ← 閉じた resolution）: ${m.left.filter((x) => x.open).map((x) => `${x.el}${x.case ? ` の case ${x.case}` : ''}（${x.open} ← ${list(closers(`open:${x.open}`))}）`).join(', ')}` : '',
    m.left.some((x) => x.constraint) ? `constrained_by の閉じた O-（要素 の O- ← 閉じた resolution）: ${m.left.filter((x) => x.constraint).map((x) => `${x.el} の ${x.constraint} ← ${list(closers(`open:${x.constraint}`))}`).join(', ')}` : '',
    m.found.length ? `指摘（ID ← それを裁定した resolution）: ${m.found.map((id) => `${id}（← ${list(closers(`finding:${id}`))}）`).join(', ')}（${FINDINGS_READ}）` : '',
    recurFound.length ? `このうち ${list(recurFound)} は改稿で直らず再発した項目の指摘である。その項目の振る舞いを判定表の入力の次元として起こす。` : '',
    m.verdicts.length ? `検証の裁定（要素 ← 裁定した resolution）: ${m.verdicts.map((id) => `${id} ← ${list(closers(`verification:${id}`))}`).join(', ')}` : '',
    m.stale.length ? `覆された決定か検証に落ちた不変条件を出典か constrained_by に持つ要素（要素 ← その決定）: ${m.stale.map((x) => `${x.el} ← ${x.ref}`).join(', ')}` : '',
    m.redo.length ? `検証に落ちた要素: ${list(m.redo)}（理由は \`${getCli('verifications', m.redo)}\`）` : '',
    m.handoff.length ? `flow の指摘（要素: 何が無いか か符号。直し方は ${W}/checks/flow.json の fix）: ${m.handoff.map((x) => `${x.at}: ${FIXERS_BY_CODE[x.code].handoff || x.code}`).join(', ')}` : '',
  ]
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
// reflectLater: 反映を REFLECT_STAGE に渡す（渡せない不合格の要素があれば渡さずにここで直す）。
async function settle(stage, verified, phaseTitle, before, allowQuestions, reflectLater = false) {
  const checked = await verifyLeft(stage, 'left', verified, phaseTitle, allowQuestions)
  if (checked.error) return checked
  if (!checked.fc) return null
  if (reflectLater && failedOpen(checked.fc, state, true).every(reflectable)) {
    reflectFc = checked.fc
    return null
  }
  const first = reflection(checked.fc, before)
  if (!reflects(first)) return null
  const r1 = await settleRound(stage, 1, first, phaseTitle, allowQuestions)
  if (r1.error) return r1
  const done = await rework(r1, (x) => x.residual, (x, _, n) => settleRound(stage, n + 1, x.next, phaseTitle, allowQuestions), MAX_SETTLE_ROUNDS - 1)
  if (done.error) return done.error
  return done.defect ? { error: `段 ${stage}: 裁定の反映の後も直っていません（${done.defect.text}）` } : null
}

// adopt: 独立な stdout を state に写し（reconcile）、ここで初めて受け取った問いの形を検査させる。返り値で受け取った問いは返る前に
// 検査されているが、W から受け取った問いは誰も検査していない。形の崩れた問いは、ゲートで司令塔が導出するときに初めて落ち、戻る段が無い。
// 聞ける段で返り値に載らずに W に現れた指定の外の hold も、ここで問いに書き換え直させる（newHoldsInW）。
async function adopt(stage, tag, fc, phaseTitle) {
  const adopted = reconcile(fc)
  const held = newHoldsInW(fc)
  if (!adopted.length && !held.length) return { fc }
  if (held.length) {
    const l = `resolver:${stage}-${tag}${TO_QUESTION}`
    const stop = () => Object.assign(new Error(`${l}: 依頼者に聞ける段 ${running} で、script が hold を指定していない ${list(held)} が台帳にあり、問いに書き換え直させても hold のままです`), { rerunStage: true })
    const r2 = await rewriteHolds(l, held, held, phaseTitle, stop)
    absorbResolver(r2)
    const kept = flowKept(`${stage}-${tag}${TO_QUESTION}`, r2)
    if (kept) return kept
  }
  const qe = adopted.length ? await checkQuestions(stage, `${stage}-${tag}`, {}, phaseTitle, adopted) : null
  if (qe) return qe
  const again = await independentFlow(fc, phaseTitle)
  if (again.fc) reconcile(again.fc)
  const still = again.fc ? newHoldsInW(again.fc) : []
  if (still.length) return { error: `段 ${stage}: 依頼者に聞ける段で、script が hold を指定していない ${list(still)} が台帳に残っています`, rerun: true }
  return again
}

// verifyLeft: 判断に使う stdout（independentFlow）を取って W の裁定を state に写し（reconcile）、今の版に合否の無い要素か carry が
// 残っていれば verifier に検証させ、検証に落ちたまま問いにも保持規則にもなっていない裁定（unconverted）と decidable で落ちた問い・保持規則を
// 1 回だけ差し戻して、まだ落ちるものを変換する（fixFailed）。
// 残るのは、resolver が返り値に載せずに台帳を書いたとき、前の verifier が W の対象を検証し残したとき、問いの形の修正が検証した問いを
// 書き換えたとき、所有表の外の書き込みがあったときである。段を頭からやり直させずにここで拾う。ここの verifier の検証し残しは拾う役がもう無いので、
// 段をやり直させる。
async function verifyLeft(stage, tag, verified, phaseTitle, allowQuestions) {
  const now = await independentFlow(verified, phaseTitle)
  if (now.error || !now.fc) return now
  const took = await adopt(stage, tag, now.fc, phaseTitle)
  if (took.error) return took
  let fc = took.fc
  let decided = []
  if (unjudged(fc).elements.length || carry.length) {
    const v = await askVerifier(`verifier:${stage}v-${tag}`, `${stage}v（検証を通っていないもの）`, [], '', phaseTitle)
    const ve = absorbVerifier(v, null, `${stage}v-${tag}`, false, null)
    if (ve) return ve
    state.resolutions_sha256 = v.resolutions_sha256
    fc = flowCheckOf(v.flow_check, true)
    reconcile(fc)
    decided = v.fail.filter((f) => f.kind === 'decidable' && RESOLUTION_ID.test(f.id))
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
  const toFix = [...unconverted(fc).map((x) => ({ id: x.id, kind: x.fail_kind || '理由は verifications.json' })), ...decided]
  if (!toFix.length) return { fc }
  const fe = await fixFailed(stage, `${stage}-${tag}`, toFix, phaseTitle, allowQuestions)
  if (fe.error) return fe
  const after = await independentFlow(fe.fc, phaseTitle)
  if (after.fc) reconcile(after.fc)
  return after
}

// settleRound: settle の planner が裁定を flow に写し（流れ）、流れを変えた後のまだ裁定の無い組と O- を同じ体で裁定する（裁定）。裁定し漏らした分だけを
// 保険の resolver（ruleIssues）に回す。ledgerAtCall は起動の前の台帳の版で、流れの仕事は resolutions を書かないので、動いていれば裁定の仕事か後の resolver の
// 書き込みである（差し戻しの体だけが裁定しても「台帳が動いた」）。
async function settleRound(stage, n, m, phaseTitle, allowQuestions) {
  const tag = reworkLabel(`${stage}-settle`, n)
  const label = `planner:${tag}`
  const waiting = pendingQuestions(state)
  const ledgerAtCall = state.resolutions_sha256
  const got = await planCall(label, (l) => [
    header('planner', `${stage}（裁定の反映${n > 1 ? ` ${n} 回目` : ''}）`, l, ['流れ', '裁定']),
    groundsBlock(),
    `${W}/checks/conflicts.json、${W}/precedent.json も読む。`,
    existingNote(),
    `流れ: 裁定を flow に写す（planner.md の「裁定の反映」）。`,
    ...reflectLines(m),
    frameRun(false),
    ruleLine('流れの最後の stdout の open_ids と conflicts の pair_keys のうち、resolutions.json のどの resolution の about にも無いものがあれば裁定する（planner.md の「flow を変えた後の未裁定の論点」）。無ければ裁定しない。'),
    askNote(allowQuestions),
    plannerQuestions(waiting),
  ], phaseTitle)
  if (got.error) return { error: `段 ${stage}（裁定の反映）: ${got.error}`, rerun: got.rerun }
  claimIssues(label, got.cc.pair_keys, got.fc.open_ids)
  const t = await takeRulings(tag, tag, got.r, phaseTitle, { allowQuestions, recheck: waiting })
  if (t.error) return t
  const fc = got.fc
  const pe = await ruleIssues(tag, tag, got.cc.pair_keys, fc.open_ids, phaseTitle, allowQuestions)
  if (pe.error) return pe
  const vLabel = `verifier:${reworkLabel(`${stage}v-settle`, n)}`
  // 書き換えた要素は VERIFY_ALL が検証させる。直させたのに書き換えなかった不合格の要素は VERIFY_ALL から外れるので、名指しで検証させる。
  const asked = new Set([...m.left.map((x) => x.el), ...m.verdicts, ...m.stale.map((x) => x.el), ...m.redo])
  const v = await askVerifier(vLabel, `${stage}v（裁定の反映）`, uniq([...t.ids, ...pe.ids]), flowExtra(fc.failed_current.filter((id) => asked.has(id))), phaseTitle)
  const ve = absorbVerifier(v, state.resolutions_sha256, reworkLabel(`${stage}v-settle`, n), true, 'flowFramer', state.resolutions_sha256 !== ledgerAtCall, { by: label, ids: t.ids })
  if (ve) return ve
  let vfc = flowCheckOf(v.flow_check, true)
  // flow-framer に直せない裁定（RS-）の不合格は、段の本体と同じく 1 回差し戻し、まだ落ちれば問いか保持規則に変える（fixFailed）。止めると、
  // 縛る不変条件の O- を足した破壊的な工程が、裁定が落ちただけで blocked になる。
  const rh = await reholdFailed(stage, tag, phaseTitle)
  if (rh && rh.error) return rh
  if (rh) vfc = rh.fc
  const toFix = convertible(v.fail)
  const failed = v.fail.map((f) => f.id).filter((id) => !RESOLUTION_ID.test(id))
  if (toFix.length) {
    const fe = await fixFailed(tag, tag, toFix, phaseTitle, allowQuestions)
    if (fe.error) return fe
    vfc = fe.fc
  }
  const now = await verifyLeft(stage, reworkLabel('left', n + 1), vfc, phaseTitle, allowQuestions)
  if (now.error) return now
  const after = now.fc
  const stale = staleOf(after)
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

// reholdFailed: hold のまま検証に落ちた保持規則を、同じ ID のまま書き直させて検証し直す（planner.md の「保持規則の書き直し」）。
// 書き直しても落ちるか、前に書き直した（差し戻しを含む）後に落ちたものがあれば、段の頭からやり直させる。
async function reholdFailed(stage, owner, phaseTitle) {
  const failing = Object.keys(holdFails).sort()
  if (!failing.length) return null
  const again = failing.filter((id) => holdFails[id] > 1)
  const stuck = (ids) => ({ error: `段 ${stage}: 保持規則 ${list(ids)} が書き直した後も検証に落ちました（${W}/verifications.json）。検証に落ちた保持規則は writer に渡さない`, rerun: true })
  if (again.length) return stuck(again)
  const label = `resolver:${owner}-rehold`
  const r = await once(label, 'resolver', resolverPrompt(label, `${owner}（保持規則の書き直し）`, keepFlow(`次の保持規則は検証に落ちた（理由は \`${getCli('verifications', failing)}\`）。値を決めずに、hold（保持規則・Issue の文案・触れる項目 ID）を落ちた理由で書き直す。ID は変えない: ${list(failing)}`)), RESOLVER_SCHEMA, phaseTitle)
  const bad = onlyAsked(`${owner}-rehold`, r, failing, ['holds'])
  if (bad) return { error: bad }
  absorbResolver(r)
  const kept = flowKept(`${owner}-rehold`, r)
  if (kept) return kept
  const vLabel = `verifier:${owner}-reholdv`
  const v = await askVerifier(vLabel, `${owner}v（保持規則の書き直し）`, failing, '', phaseTitle)
  const ve = absorbVerifier(v, state.resolutions_sha256, `${owner}-reholdv`, false, null)
  if (ve) return ve
  const still = failing.filter((id) => holdFails[id])
  if (still.length) return stuck(still)
  return { fc: flowCheckOf(v.flow_check, true) }
}

// holdLeft: 依頼者に聞かない問いを保持規則に変える。why はその理由（聞ける回数の上限か、回答済みの論点の再発）。
// 聞ける段でも呼ぶので、script の指定として holdOrders に入れる（入れないと newHoldsInW が段の出口で止める）。
async function holdLeft(stage, ids, phaseTitle, why) {
  orderHolds(ids)
  const label = `resolver:${stage}-hold`
  const r = await once(label, 'resolver', resolverPrompt(label, `${stage}（保持規則への変換）`, keepFlow(`次の問いは依頼者に聞かない（${why}）。hold（保持規則・Issue の文案・触れる項目 ID）に書き換える。ID は変えない: ${list(ids)}`)), RESOLVER_SCHEMA, phaseTitle)
  const bad = onlyAsked(`${stage}-hold`, r, ids, ['holds'])
  if (bad) return { error: bad }
  absorbResolver(r)
  return flowKept(`${stage}-hold`, r) || settle(`${stage}-hold`, null, phaseTitle, usableResolutions(state), false)
}

async function applyReturnedFlow(stage, ret, phaseTitle, required) {
  const given = ret.flow_check !== undefined && ret.flow_check !== null
  if (!given && !required) return { checked: false }
  const defectOf = (x) => flowDefect(flowCheckOf(x.flow_check), 'resolver', `${W}/checks/flow.json`, reflector(running))
  const done = await rework(ret, defectOf, async (_, d, n) => {
    const label = reworkLabel(`resolver:${stage}-flow`, n)
    const again = await once(
      label,
      'resolver',
      resolverPrompt(label, `${stage}（flow の修正）`, `flow.json が閉じていない。${d.text}。その指摘だけを直す（裁定の中身は変えない）。最後に \`${cli('flow')}\` と \`${cli('conflicts')}\` を実行し、stdout を加工せずに flow_check と conflicts_check に入れて返す。`),
      RESOLVER_SCHEMA,
      phaseTitle
    )
    absorbResolver(again)
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
// recheck: 返り値の questions に無くても検査させる問い（flow を書き換えた後の回答待ちの問い・W から初めて受け取った問い）。裁定か hold に
// 変えたものは除く。
// owner: 問いの形の修正の label に付ける段。同じ段の中で問いを返す呼び出しは複数あり、label が重なると telemetry と再開の照合が
// 呼び出しを取り違える。
async function checkQuestions(stage, owner, r, phaseTitle, recheck) {
  const settledNow = [...(r.ruled || []), ...(r.holds || [])].map((x) => x && x.id)
  let target = minus(uniq([...(r.questions || []).map((x) => x && x.id), ...(recheck || [])]), settledNow)
  if (!target.length) return null
  const clean = (label, x) => recopy(label, x, { questions_check: questionsCheck(target) }, phaseTitle)
  const done = await rework(await clean(`flow-check:${owner}-questions`, r), (x) => (target.length ? questionsDefect(x.questions_check, target) : null), async (_, d, n) => {
    const label = reworkLabel(`resolver:${owner}-questions`, n)
    const again = await once(
      label,
      'resolver',
      resolverPrompt(
        label,
        `${owner}（問いの形の修正）`,
        keepFlow(`問い ${list(target)} が問いの形の検査を通っていない（${d.text}）。その問いの question・options だけを直し（裁定の中身は変えない。理由が answer の残りなら、契約「## 決定の台帳」の回答待ちの問いの項のとおり answer と value に null を送る）、\`${questionsCheck(target)}\` の stdout を加工せずに questions_check に入れて返す。`)
      ),
      RESOLVER_SCHEMA,
      phaseTitle
    )
    absorbResolver(again)
    const kept = flowKept(`${owner}-questions`, again)
    if (kept) return kept
    target = minus(uniq([...target, ...(again.questions || []).map((x) => x && x.id)]), (again.holds || []).map((x) => x && x.id))
    return clean(label, again)
  }, MAX_CHECK_REWORK)
  if (done.error) return done.error
  return done.defect ? { error: `段 ${stage}: 問いの形が検査を通りません（${done.defect.text}）` } : null
}

// gatePassed: 回答済みのゲート（args.gates_answered）を通った段。聞くゲートを通ったのと同じく、回答待ちの問いを持って段を出てよい（exitViolation）。
let gatePassed = null

// collecting: 最初のゲートを開く前の、段 6 より前の段。問いを見つけた段ごとに止めると、後の段（初稿・監査）でしか見えない論点が次のゲートか
// 次の run に回り、依頼者を止める回数と要求文書の改訂が、論点の見つかった段の数だけ増える（実測: 仕様書だけの run が初稿の前の 3 問で止まり、
// 要求文書を改訂して起こし直した run が初稿の監査で 4 問目に止まった）。初稿の監査は全文書を読むので、最初のゲート（仕様書だけを書く run で
// 要求の論点があれば upstream_gap）は、その裁定の段 6 で開く。
const collecting = () => running !== '6' && gatesOpened() === 0
// carrying: 持ち越した問いを持って、最初のゲートまでの段を通っている。聞くゲートを通ったのと同じく、回答待ちの問いを持って段を出てよい
// （exitViolation）。仕様書だけを書く run の項は最初のゲートの前に限る: ゲートの後も真のままだと、3b の続きの問いが持ち越しになって
// 初稿の書き直しと段 5 の監査が繰り返され、回答待ちの検査も外れる。
const carrying = () => (specOnly() && gatesOpened() === 0) || Boolean(state.deferred)

// needsAnswers: 開いた順に g1, g2, … と名乗る。resume も next_args の再開も同じ段を同じ順に通るので、同じ名前になる。
// gates_answered のゲートを越えるのは、今の問いが聞いた問いと同じで、回答のファイルがそのすべてに答えているときだけ。
// resume が保存された結果から外れると（pipeline の起動の順・追い出し・runtime の違い）run は live で走り直し、違う問いに古い回答を当てるか、
// 段 1 の reset が消した回答の無いまま進む。onward は、問いを持ち越すとき（collecting）に進む段。持ち越した問いで書いた初稿は回答を
// 知らないので、最初のゲートの後は 3a から入り、組み直した flow で書き直す（state.deferred）。
async function needsAnswers(from, onward) {
  if (onward && collecting()) {
    state.deferred = true
    return onward
  }
  const gap = requirementGap()
  if (gap) return gap
  if (state.deferred) {
    from = '3a'
    delete state.deferred
  }
  state.gates = gatesOpened() + 1
  const gate = `g${state.gates}`
  state.gate = gate
  const ids = pendingQuestions(state)
  const asked = GATES_ANSWERED[gate]
  if (!asked) return answersStop(gate, from, ids, {})
  if (canonicalText(uniq(asked)) !== canonicalText(uniq(ids))) {
    return answersStop(gate, from, ids, { reason: `gates_answered.${gate}（${list(asked)}）が今の問い（${list(ids)}）と違います（resume が保存された結果から外れて live で走り直した）。今の問いを聞き直してください` })
  }
  const unanswered = await answersUnchecked(gate, from, ids)
  if (unanswered) return unanswered
  gatePassed = gate
  return from
}

// specOnly: 書く文書がすべて仕様書で、そのどれもが固定の要求文書を実現する（plan の covers）run。価値の判断は要求文書が持ち、問いにして
// よいのは価値の判断だけなので、この run で出る問いは要求文書の抜けである。聞いて仕様書に書くと、要求文書に無い判断が仕様書にだけ入り、
// 仕様項目が要求に辿れなくなる。covers を見ないと、INDEX のために並べただけの無関係な固定の文書で、聞けば済む run まで止まる。
const fixedRequirements = () => new Set(EXISTING.filter((d) => d.fixed && String(d.key).startsWith('requirements/')).map((d) => d.key))
// plan の前（planner:1 のプロンプトを作る時点）は run の種類が分からないので偽にする（planner.md が問いの layer の付け方を静的に持つ）。
const specOnly = () => {
  if (!state.units) return false
  const docs = auditDocs()
  const fixed = fixedRequirements()
  return docs.length > 0 && docs.every((k) => k.startsWith('specifications/') && ((state.covers || {})[k] || []).some((r) => fixed.has(r)))
}

// specQuestion: 仕様の論点の問い。最後に受け取った独立な flow --rulings の stdout（seen）の行が spec_layer（ruling が question、layer が
// 手段、upstream_revision が無い。doc_check の wsFlow）を持ち、verifier が合格にしたもの。seen か行が無ければ要求の論点に倒す。
const specQuestion = (id) => Boolean(seen && seen.resolutions && seen.resolutions.some((x) => x.id === id && x.spec_layer === true && x.verdict === 'pass'))

// requirementGap: 仕様書だけを書く run の回答待ちの問いに要求の論点（specQuestion でないもの）があれば、upstream_gap の結果を返す。
// ゲートを開くか保持規則にするかの判定（next_args の字数・聞ける回数）より先に当てる: 要求の論点を保持規則にすると、要求文書に無い判断が
// 仕様書の本文にだけ入る。upstream_gap は next_args を付けないので、字数の上限とは関わらない。
function requirementGap() {
  if (!specOnly()) return null
  const up = pendingQuestions(state).filter((id) => !specQuestion(id))
  return up.length ? upstreamGap(up) : null
}

// upstreamGap: 仕様書だけを書く run が、要求の論点 ids をまとめて返す（question_ids は要求の論点だけ）。要求文書を直すと固定の文書の sha が変わり、
// この run は再開できないので next_args を付けない。
function upstreamGap(ids) {
  const spec = minus(pendingQuestions(state), ids)
  const deferredSpec = spec.length ? `。仕様書の範囲の問い ${spec.length} 件（${list(spec)}）は、要求文書を改訂した後の run で聞く` : ''
  return finish('blocked', {
    reason: `仕様書だけを書く run で、固定の要求文書に答えが見つからなかった価値の論点が ${ids.length} 件出ました（${list(ids)}）。仕様書では決めずに、初稿と監査を終えるまでに出た論点をまとめて返します。要求文書を改訂してから仕様書を起こし直してください${deferredSpec}`,
    stop_reason: 'upstream_gap',
    questions_path: `${W}/questions.md`,
    questions_json_path: `${W}/questions.json`,
    question_ids: ids,
  })
}

function answersStop(gate, from, ids, extra) {
  return finish('needs_answers', {
    gate,
    questions_path: `${W}/questions.md`,
    questions_json_path: `${W}/questions.json`,
    answers_path: `${W}/${gateAnswers(gate)}`,
    question_ids: ids,
    next_args: nextArgs(from),
    ...extra,
  })
}

// answersUnchecked: 回答を当てる段に入る前に、回答のファイルが問いのすべてに答えているかを doc_check answers で確かめる。gates_answered の
// resume と next_args の再開（段 3a・3a' から始める run）の両方が通る。落ちたら resumable を偽にする: resume すると落ちた検査の保存された結果が
// 返り、同じ所で止まり続ける。
// entryAnswers: next_args で 3a・3a' から始めた run の入口の flow-check が返した answers の stdout（state に載せない）。入口の後に回答待ちの問いが
// 変われば（入口の verifyLeft が W から問いを受け取った）使わずに単独で起動する。
let entryAnswers = null
async function answersUnchecked(gate, from, ids) {
  const label = `flow-check:${gate}-answers`
  const cmd = cli('answers', `--file ${gateAnswers(gate)} --ids ${ids.join(',')}`)
  const pre = entryAnswers && entryAnswers.gate === gate && canonicalText(entryAnswers.ids) === canonicalText(uniq(ids)) ? entryAnswers.text : undefined
  entryAnswers = null
  const x = pre !== undefined ? { answers_check: pre } : await once(label, 'flowCheck', [header('flowCheck', from, label), `実行する: \`${cmd}\`。stdout を加工せずに answers_check に入れて返す。`].join('\n\n'), ANSWERS_SCHEMA, PHASE_OF[from], { answers_check: cmd })
  const ac = parseStdout(x && x.answers_check)
  const echoed = ac && ac.file === gateAnswers(gate) && canonicalText(ac.ids) === canonicalText(uniq(ids)) && Array.isArray(ac.missing) && Array.isArray(ac.free)
  if (echoed && !ac.missing.length) {
    answersFree[gate] = ac.free
    return null
  }
  const why = !echoed ? 'doc_check answers の stdout が返りませんでした' : ac.exists !== true ? 'ファイルがありません（段 1 の reset が消したことがある）' : `回答の行の無い問い ${list(ac.missing)}`
  return answersStop(gate, from, ids, { reason: `${W}/${gateAnswers(gate)}: ${why}。問いを聞き直して回答を書き、next_args で呼び直してください`, resumable: false })
}

// answersFree: ゲートごとの、候補の label だけでない回答の節の逐語（doc_check answers の free）。回答を当てる resolver のプロンプトに写す。
// state に載せない（W の回答のファイルから導ける）。
const answersFree = {}

// answerExcerpt: ids のうち、候補の label だけでない回答の逐語。パスだけを渡すと「ある（自由欄に書く）」の後の行を読み落とし、選ばなかった候補に当てる。
function answerExcerpt(gate, ids) {
  const rows = (answersFree[gate] || []).filter((x) => ids.includes(x.id))
  if (!rows.length) return ''
  return [
    `候補の label だけでない回答（${gateAnswers(gate)} の逐語。doc_check answers の stdout から写した。当て方は planner.md の「回答の反映」）:`,
    ...rows.map((x) => `- ${x.id}（L${x.from}${x.to > x.from ? `〜L${x.to}` : ''}）: ${x.text.split('\n').map((l) => `「${l}」`).join('')}`),
  ].join('\n')
}

// resetEntry: 段 1 から始める run（新しい run も、段 1 からの再実行も）は、W を S0 の直後に戻した stdout を見てから planner:1 を起動する。
// 戻さずに始めると、前のランや止まった段 1 の台帳の要素と欄が、再実行の put（キー単位で足す）の後にも残る。
const RESET_FLAGS = [KEEP_KEYS.length ? `--keep ${KEEP_KEYS.join(',')}` : '', FIXED_KEYS.length ? `--fixed ${FIXED_KEYS.join(',')}` : ''].filter(Boolean).join(' ')
async function resetEntry() {
  const label = 'flow-check:1-entry'
  const x = await once(label, 'flowCheck', [header('flowCheck', '1', label), `実行する: \`${cli('reset', RESET_FLAGS)}\`。stdout を加工せずに reset_check に入れて返す。`].join('\n\n'), RESET_SCHEMA, PHASE_OF[1])
  const rc = parseStdout(x && x.reset_check)
  const shas = rc && rc.fixed_sha256
  const shaOk = shas && typeof shas === 'object' && canonicalText(Object.keys(shas)) === canonicalText(FIXED_KEYS) && Object.values(shas).every((v) => typeof v === 'string' && v)
  // carried_tbd は保存した文書から引き継いだ開いている TBD（文書のキーごと）。writer の返り値だけから数えると、writer を起動しない文書（固定の文書・
  // 改稿の無い既存文書）の TBD が open_tbd と INDEX から消える。書き換えてよい文書のものは新しい TBD と同じく段 6 の裁定に回す（回さないと閉じる経路が無い）。
  const carried = rc && rc.carried_tbd
  const carriedOk = carried && typeof carried === 'object' && !Array.isArray(carried) &&
    Object.entries(carried).every(([key, ids]) => KEEP_KEYS.includes(key) && Array.isArray(ids) && ids.length && ids.every((id) => typeof id === 'string' && id))
  if (rc && rc.reset === true && Array.isArray(rc.removed) && canonicalText(rc.kept) === canonicalText(KEEP_KEYS) && canonicalText(rc.fixed) === canonicalText(FIXED_KEYS) && shaOk && carriedOk) {
    if (FIXED_KEYS.length) state.fixed_sha = shas
    // entry_digest: 入口（checks/entry.json）の digest。doc_check はこれで既存の指摘を決めるので、監査の doc の値と照らす（entryMoved）。
    if (typeof rc.entry_digest === 'string' && rc.entry_digest) state.entry_digest = rc.entry_digest
    const all = Object.values(carried).flat()
    const editable = Object.entries(carried).filter(([key]) => !FIXED_KEYS.includes(key)).flatMap(([, ids]) => ids)
    if (all.length) state.open_tbd = uniq([...(state.open_tbd || []), ...all])
    if (editable.length) state.new_tbd = uniq([...(state.new_tbd || []), ...editable])
    return null
  }
  return blocked(`flow-check（段 1 の入口）が W を S0 の直後に戻した doc_check reset の stdout（残した文書 ${list(KEEP_KEYS)}、固定の文書 ${list(FIXED_KEYS)}）を返しませんでした（existing_docs の文書が W に無いと、reset は何も消さずに止まる）`, '1')
}

// entryMoved: 段 1 の入口で reset が返した entry_digest と、監査の doc_check の entry_digest が違えば、入口が書き換わっている。
// 入口はどの指摘を blocking から外すかを決めるので、書き換わったまま数えると、生成者が自分の指摘を既存の指摘にできる。
function entryMoved(docCheck) {
  if (!state.entry_digest) return null
  if (docCheck && docCheck.entry_digest === state.entry_digest) return null
  return `監査の doc_check の入口（checks/entry.json）の digest が段 1 の reset の値 ${state.entry_digest} と違います（${docCheck ? docCheck.entry_digest || '無い' : 'doc_check の stdout が無い'}）。既存の指摘を決める入口が書き換わっているので、数えた blocking を信用できません。段 1 からやり直してください`
}

// FIXED_FLAG・fixedMoved: 監査の snapshot に固定の文書の sha256 を返させ、段 1 の入口の値と照合する。固定の文書を書く役はいないので、
// 変わっていれば別のランの承認を迂回した書き込みで、どの段からやり直しても本文は戻らない（reset は W の本文を残す）。
const FIXED_FLAG = FIXED_KEYS.length ? ` --fixed ${FIXED_KEYS.join(',')}` : ''
function fixedMoved(audited, label) {
  if (!FIXED_KEYS.length) return null
  const got = audited.fixed_sha256
  if (!got || typeof got !== 'object') return { error: `監査役が ${label} の snapshot の fixed_sha256（固定の文書 ${list(FIXED_KEYS)} の sha256）を返しませんでした`, rerun: true }
  const moved = FIXED_KEYS.filter((k) => got[k] !== state.fixed_sha[k])
  if (!moved.length) return null
  noteIntegrity(`固定の文書 ${moved.join(', ')} の本文か meta が、段 1 の入口から変わった（${label} の snapshot で照合）`)
  return { error: `固定の文書 ${moved.join(', ')} が段 1 の入口から変わりました（所有表の外の書き込み）。W の本文を existing_docs の source から doc_check place で置き直し、段 1 から始めてください`, rerun: false }
}

// stage1: planner:1 が 1 体で依頼を仕分け（plan.json・decisions・open）、流れを閉じ（flow.json）、未決と組を裁定する（resolutions）。裁定は段 3 の
// state に入れる（段 1 の state に入れると、回答待ちの問いを持って段を出ることになり、聞ける段の hold の検査も段 1 では効かない）。
async function stage1() {
  const entry = await resetEntry()
  if (entry) return entry
  const got = await planCall('planner:1', (l, redo) => [
    header('planner', '1', l, ['仕分け', '流れ', '裁定']),
    groundsBlock(),
    `読む: ${W}/input.md、${W}/precedent.json（とそこに並ぶファイル）`,
    existingNote(),
    redo === '流れ'
      ? '仕分け: 前の体の結果のまま（plan.json・decisions.json は書かず、plan_check は返さない）。'
      : `仕分け: plan.json と、put で \`--ledger decisions\`・\`--ledger open\` を書く。\`${cli('plan')}\` を指摘が 0 件になるまで実行し（3 回まで）、最後の stdout を加工せずに plan_check に入れる。`,
    `流れ: ${frameRun(true)}`,
    '仕分けで plan.json の docs が requirements だけなら、流れは planner.md の「要求文書だけのラン」の小節で描く。',
    ruleLine('流れの最後の stdout の open_ids と conflicts の pair_keys のうち、resolutions.json のどの resolution の about にも無いものを裁定する（planner.md の「段ごとの仕事」の段 1）。'),
    askNote(ASKS[3]()),
    plannerQuestions([]),
  ], 'Intake', { lint: true, plan: true, specNote: false })
  if (got.error) return blocked(`初稿を始めません: ${got.error}`, got.rerun === false ? null : '1')
  const pc = planCheckOf(got.r.plan_check)
  const units = unitsOf(pc)
  try {
    unitWaves(units)
  } catch (e) {
    return blocked(`planner:1 の writer の単位が不正です: ${e.message}`, '1')
  }
  // 単位の文書のキーは段 4・7 の本文の控え（doc_check backup）のコマンド文に入る。
  const badKeys = uniq(units.flatMap((u) => u.docs).filter((k) => !DOC_KEY.test(k)))
  if (badKeys.length) return blocked(`planner:1 の writer の単位に文書のキーの形（${DOC_KEY.source}）でない文書があります: ${badKeys.join(', ')}`, '1')
  const inUnits = new Set(units.flatMap((u) => u.docs))
  const fixed = EXISTING.filter((d) => d.fixed).map((d) => d.key)
  const wrongFixed = fixed.filter((k) => inUnits.has(k))
  const lost = EXISTING.filter((d) => !d.fixed && !inUnits.has(d.key)).map((d) => d.key)
  if (wrongFixed.length) return blocked(`固定の文書が writer の単位に入っています: ${wrongFixed.join(', ')}`, '1')
  if (lost.length) return blocked(`既存文書がどの writer の単位にも入っていません（topic を変えると改稿が別名の新規執筆に化ける）: ${lost.join(', ')}`, '1')
  state.units = units
  state.plan_sha256 = pc.content_sha256
  state.covers = pc.covers
  planned = got
  return '3'
}

// ASKS: settle を持つ段と、その段で依頼者に問いを返してよいか。聞けるかは段の位置やパスではなく、聞ける回数（MAX_GATES）が残っているかで決める
// （位置で決めると、同じ論点が見つかった時期だけで問いにも保持規則にもなる）。入口の変換（enterFromDisk）も同じ値で回す（入口だけ聞けないことに
// すると、段の本体では問いになる不合格が、入口では保持規則になる）。数は段の入口の値を使う: 段の中でゲートを開いた後に偽になると、その段の出口の
// newHoldsInW の検査が抜ける。
const gatesOpened = () => state.gates || 0
const canAsk = () => (entryState.gates || 0) < MAX_GATES
const ASKS = { 3: canAsk, '3a': canAsk, '3b': canAsk, 6: canAsk, "3a'": canAsk }
const LIMIT_WHY = `依頼者に聞ける回数の上限（MAX_GATES = ${MAX_GATES}）に達した`

// REFLECT_STAGE: 聞ける回答の段（3b の組み直しの前の 3a）が settle の裁定の反映を回さずに渡す段。planner:3b は同じ回答で flow を組み直すので、3a の反映も
// そこで書かせ、未裁定の組と O- の裁定も planner:3b に、flow の検証は 3bv に 1 回にまとめる（別々に回すと同じ回答の反映を 2 回書いて 2 回検証する）。
// 3a は回答を当てた resolver の書き込みを 3av と verifyLeft で検証し終えてから出るので、渡すのは検証に落ちた要素と未反映の裁定だけで、
// 検証を通っていない書き込みは渡らない。渡した不合格の要素は 3b の出口の不変条件（緩めない）が止めるので、writer（段 4）には届かない。
const REFLECT_STAGE = '3b'
const defersReflection = (stage) => stage === '3a' && !state.reframed
// 流れの仕事の直し手の呼び名（差し戻しのプロンプトの「… が直すので触らない」）。settle の流れの仕事は settle の planner が行う。
const reflector = (stage) => (defersReflection(stage) ? `planner:${REFLECT_STAGE}` : 'settle の planner')
// reflectable: 3a が渡せる不合格の要素。3a の verifier に落ちた F- には差し戻しが必ず検証の裁定を返す（ruleAndVerify）ので、裁定の無い不合格は
// 3a の書き込みではなく、渡さずに 3a の settle で直す（REFLECT_STAGE の入口では所有表の外の書き込みとして止める）。
const reflectable = (el) => verificationRulings(state, el).length > 0
// reflectFc: 3a が反映を渡した判断の stdout（verifyLeft の返した fc）。3a が自分の settle を回したときは null（渡すものが無い）。3b から始めた run は
// 入口の verifyLeft の fc を使う。state に載せない（W から導ける）。
let reflectFc = null

// planned: 段 1 の planner:1 の返り値（流れの stdout と裁定。メモリだけ）。段 3 はこの裁定を resolver なしで受け取る。段 3 から始めた run には無く、
// 入口の独立な stdout（seen）から未裁定の組と O- を数えて resolver:3 に裁定させる。
let planned = null

// PLAN_LINE・planMoved: plan の照合。planner:1 の申告だけにすると、検査の後に書き換えた plan.json が通る。段 3 の最初の検証で plan reviewer が
// 実行した stdout と照らす（covers・units も planner:1 の写した stdout だけから入るので、同じ照合に含める。specOnly・writesSpec が読む）。
const PLAN_LINE = `検証の最後に \`${cli('plan')}\` も実行し、stdout を加工せずに plan_check に入れる。`
function planMoved(v, planSha) {
  const pc = planCheckOf(v.plan_check)
  if (!pc) return { error: 'plan reviewer（段 3v）が doc_check plan の stdout を返しませんでした', rerun: true }
  const coversMoved = canonicalText(pc.covers) !== canonicalText(state.covers)
  const unitsMoved = canonicalText(unitsOf(pc)) !== canonicalText(state.units)
  if (pc.content_sha256 === planSha && !pc.findings && !coversMoved && !unitsMoved) return null
  if (pc.content_sha256 !== planSha) noteIntegrity(`plan reviewer が検査した plan.json（${pc.content_sha256}）が、planner:1 が検査した版（${planSha}）と違う`)
  else if (coversMoved) noteIntegrity(`plan reviewer が返した plan の covers が、planner:1 が返した covers と違う（${canonicalText(pc.covers)} / ${canonicalText(state.covers)}）`)
  else if (unitsMoved) noteIntegrity(`plan reviewer が返した plan の units が、planner:1 が返した units と違う（${canonicalText(unitsOf(pc))} / ${canonicalText(state.units)}）`)
  else noteIntegrity(`plan reviewer が検査した plan.json に doc_check plan の指摘が ${pc.findings} 件ある（planner:1 は 0 件の stdout を返した）`)
  return { error: `plan.json が planner:1 の検査を通った版ではありません（doc_check plan の指摘 ${pc.findings} 件。${W}/checks/plan.json）`, rerunFrom: '1' }
}

async function stage3() {
  const planSha = state.plan_sha256
  delete state.plan_sha256
  const p = planned
  planned = null
  // 回答待ちの問いは planner の裁定を受け取る前に数える（planner の新しい問いを cycle の入口の問いに数えない）。
  const wasQuestion = new Set(pendingQuestions(state))
  let given = []
  if (p) {
    claimIssues('planner:1', p.cc.pair_keys, p.fc.open_ids)
    const t = await takeRulings('3', '1', p.r, 'Resolve', { allowQuestions: ASKS[3](), reRuled: true })
    if (t.error) return blocked(t.error, t.rerun === false ? null : '3')
    given = t.ids
  }
  const src = p ? { open_ids: p.fc.open_ids, pair_keys: p.cc.pair_keys } : seen
  const { opens, pairs } = unruledIssues(src.open_ids, src.pair_keys)
  const res = await resolveCycle('3', {
    phase: 'Resolve',
    given,
    task: opens.length || pairs.length
      ? [
          `段 3（planner.md の「段ごとの仕事」の段 3。プロンプトが渡した ID だけを裁定する）:`,
          `- まだ裁定の無い open: ${list(opens.map((k) => k.slice(5)))}${opens.length ? `（\`${getCli('open', opens.map((k) => k.slice(5)))}\`）` : ''}`,
          `- まだ裁定の無い組（${W}/checks/conflicts.json）: ${list(pairs)}`,
          pointedLines(issueItems([...opens, ...pairs])),
          askNote(ASKS[3]()),
        ]
          .filter(Boolean)
          .join('\n')
      : null,
    verifyExtra: [
      'あわせて検証する: decisions.json の source が default / precedent の決定と kind が invariant の決定すべて。これらの D- も pass / fail に入れる（open も組も 0 件でも省かない。仕分けの既定が残るため）。',
      PLAN_LINE,
    ].join('\n\n'),
    checkPlan: (v) => planMoved(v, planSha),
    wasQuestion,
    flowFrom: p ? 'planner:1' : null,
    planned: p ? { by: 'planner:1', ids: given, rerunFrom: '1' } : null,
    allowQuestions: ASKS[3](),
  })
  if (res.error) return blocked(res.error, res.rerunFrom || (res.rerun === false ? null : '3'))
  const onward = ENTRY === 'existing' ? '5' : '4'
  if (pendingQuestions(state).length) return needsAnswers('3a', onward)
  return onward
}

// 3b の組み直しの前の 3a で出た問いは 3b へ持ち越す。3b が組み直した flow から出る問いと 1 回のゲートで聞くためで、裁定の反映も 3b へ渡す
// （REFLECT_STAGE）。ほかの回答の段で出た続きの問いは、聞ける回数が残っていれば次のゲートで聞き、残っていなければ保持規則にする。
async function stageApply(stageId) {
  const gate = state.gate
  const pending = pendingQuestions(state)
  // 回答の逐語はこの stdout にしか無い。ゲートを越えた run（needsAnswers で取った）のほか、入口から始めた run もここで取る。
  if (!answersFree[gate]) {
    const unanswered = await answersUnchecked(gate, stageId, pending)
    if (unanswered) return unanswered
  }
  const allowQuestions = ASKS[stageId]()
  const nextStage = defersReflection(stageId) ? REFLECT_STAGE : null
  const res = await resolveCycle(stageId, {
    phase: 'Answers',
    task: [
      `段 ${stageId}: ${W}/${gateAnswers(gate)} の回答を、問い ${list(pending)} に当てる（planner.md の「回答の反映」）。`,
      answerExcerpt(gate, pending),
      `同じ回答で、初期 plan.domain の verdict / categories を変える具体的な signal があれば about.domain の effective assessment を作成または更新する。初期 verdict は該当・非該当・未評価のいずれでもよい。signal が無ければ変更しない。`,
      `実行する: \`${cli('flow')}\`（flow.json を変えなくても）→ flow_check。flow.json を変えたら \`${cli('conflicts')}\` → conflicts_check。`,
      allowQuestions ? `反映で価値に関わる新しい矛盾が出たら question にする。${askNote(true)}` : `${LIMIT_WHY}ので、価値に関わる新しい矛盾は hold にする（planner.md の「8'」）。${specOnly() ? SPEC_REQ_NOTE : ''}`,
    ]
      .filter(Boolean)
      .join('\n'),
    answered: pending,
    allowQuestions,
    requireFlow: true,
    reflectLater: Boolean(nextStage),
  })
  if (res.error) return blocked(res.error, res.rerun === false ? null : stageId)
  if (nextStage) return nextStage
  const left = pendingQuestions(state)
  if (left.length) {
    const gap = requirementGap()
    if (gap) return gap
    // 延長の 3a' から出た続きの問いのゲートも、延長のゲートと同じく next_args の字数を測る。
    const over = stageId === "3a'" && state.pass > MAX_AUDIT_PASSES && extensionOver(state)
    if (allowQuestions && !over) return needsAnswers(stageId)
    const he = await holdLeft(stageId, left, 'Answers', over ? OVER_WHY : LIMIT_WHY)
    if (he) return blocked(he.error, he.rerun === false ? null : stageId)
  }
  if (stageId === "3a'") return '7'
  return ENTRY === 'existing' ? '5' : '4'
}

// stage3b: planner:3b が回答で flow を組み直し（3a の反映も同じ書き込みで）、組み直した flow のまだ裁定の無い組と O- と 3a から持ち越した問いを
// 同じ体で裁定する。裁定し漏らした組と O- だけを保険の resolver:3b に回す。持ち越した問いだけなら planner は裁定せずに返し、問いは次のゲートで聞く
// （決まっていたかの判定は依頼者の回答に委ねる。推測で埋めない）。組み直した flow は flowChanged で verifier:3bv が照合する。
async function stage3b() {
  state.reframed = true
  const waiting = pendingQuestions(state)
  const carriedIn = reflectFc ? reflection(reflectFc, null) : null
  const wasQuestion = new Set(waiting)
  // framedAt: 起動の前の台帳の版。planner の裁定か保険の resolver で台帳が動けば、3bv の指摘は台帳由来として settle に渡し、動かなければ過少申告として止める。
  const framedAt = { ledger: state.resolutions_sha256 }
  const got = await planCall('planner:3b', (l) => [
    header('planner', '3b（回答での組み直し）', l, ['流れ', '裁定']),
    groundsBlock(),
    `${W}/open.json、${W}/checks/conflicts.json、${W}/precedent.json も読む。`,
    existingNote(),
    '流れ: 回答を入力に加えて flow を組み直す（planner.md の「回答での組み直し」）。',
    ...(carriedIn && reflects(carriedIn) ? ['組み直しと同じ書き込みで、3a の裁定も flow に写す（planner.md の「裁定の反映」）。', ...reflectLines(carriedIn)] : []),
    frameRun(true),
    ruleLine(`組み直しの後、まだ裁定の無い open・組があれば、それと 3a から持ち越した問い ${list(waiting)} を裁定する（planner.md の「回答での組み直しの後（3b）」）。無ければ裁定しない。`),
    pointedLines(ownItems(waiting, state)),
    `回答で組み直した flow に初期 plan.domain の verdict / categories を変える新しいユーザー由来の signal が現れた場合は、domain assessment を同じ resolution ID で更新する。新しい signal が無ければ触らない。`,
    domainAssessmentNote(),
    askNote(ASKS['3b']()),
    plannerQuestions(waiting),
  ], 'Answers', { lint: true })
  if (got.error) return blocked(`段 3b: ${got.error}`, got.rerun === false ? null : '3b')
  claimIssues('planner:3b', got.cc.pair_keys, got.fc.open_ids)
  const before = unruledIssues(got.fc.open_ids, got.cc.pair_keys)
  // 持ち越した問いの裁定漏れは、裁定する組か O- があった（裁定の仕事を行った）ときだけ数える（今の resolver:3b と同じ）。
  const targets = before.opens.length || before.pairs.length ? waiting.map((id) => (state.about || {})[id]).filter(Boolean) : []
  const t = await takeRulings('3b', '3b-reframe', got.r, 'Answers', { allowQuestions: ASKS['3b'](), recheck: waiting, reRuled: true, targets })
  if (t.error) return blocked(t.error, t.rerun === false ? null : '3b')
  const { opens, pairs } = unruledIssues(got.fc.open_ids, got.cc.pair_keys)
  const res = await resolveCycle('3b', {
    phase: 'Answers',
    given: t.ids,
    task:
      opens.length || pairs.length
        ? [
            `段 3b（planner.md の「回答での組み直しの後」）: planner:3b が裁定し漏らした論点だけを裁定する。`,
            `- まだ裁定の無い open: ${list(opens.map((k) => k.slice(5)))}`,
            `- まだ裁定の無い組（${W}/checks/conflicts.json）: ${list(pairs)}`,
            pointedLines(issueItems([...opens, ...pairs])),
            askNote(ASKS['3b']()),
          ]
            .filter(Boolean)
            .join('\n')
        : null,
    targets: [...opens, ...pairs],
    recheck: null,
    wasQuestion,
    flowChanged: true,
    framed: framedAt,
    planned: { by: 'planner:3b', ids: t.ids },
    allowQuestions: ASKS['3b'](),
  })
  if (res.error) return blocked(res.error, res.rerun === false ? null : '3b')
  const onward = ENTRY === 'existing' ? '5' : '4'
  if (pendingQuestions(state).length) return needsAnswers('3a', onward)
  return onward
}

const writerLabel = (unit, mode) => `writer:${unit.id}:${mode}`

// waitingNote: 持ち越した回答待ちの問い（collecting）。writer が決めると依頼者の判断の置き換えになり、監査役が「決まっていない」と指摘すると
// 同じ論点の問いがもう 1 つ立つ。
const WAITING_DO = { writer: '本文で決めず、TBD にも起票しない', auditor: '決まっていないことを指摘にしない', resolver: '同じ論点か、候補が互いを縛る論点を別の問いにしない' }
function waitingNote(role) {
  const ids = pendingQuestions(state)
  return ids.length ? `回答待ちの問い ${list(ids)}（中身は \`${getCli('resolutions', ids)}\`）の論点は依頼者の回答で決まる。${WAITING_DO[role]}。` : ''
}

function writerPrompt(unit, mode, extra) {
  const deps = state.units.filter((u) => (unit.depends_on || []).includes(u.id)).flatMap((u) => u.docs)
  return [
    header('writer', mode === 'draft' ? '4（初稿）' : mode.startsWith('formal-') ? `${running}（形式検証の反例の差し戻し）` : '7（改稿）', writerLabel(unit, mode)),
    groundsBlock(),
    `最初のコマンド（Write・Edit・put より前）: \`${backupCmd()}\`。stdout を加工せずに backup_check に入れる。控えを取る前に書いた本文は、この段の再実行で戻せない。`,
    `担当の単位: ${unit.id}（文書: ${list(unit.docs)}）。書くのは ${unit.docs.map((k) => `${W}/${k.replace('/', '-')}.md とその .meta.json`).join('、')} だけ。`,
    deps.length ? `依存先の単位の文書（読むだけ）: ${deps.map((k) => `${W}/${k.replace('/', '-')}.md`).join('、')}` : '',
    existingNote(),
    waitingNote('writer'),
    `doc_check の内部ループ: \`${cli('doc', `--doc <キー> --lint --open-tbd "${openTbdOf(state).join(',')}"`)}\`（findings と lint の両方を直す。3 回まで）。最後に \`${cli('tree-digest', '--doc <キー>')}\` の digest を返す。`,
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

// backupCmd: writer は本文を Edit で書き doc_check を通らないので、段 4・7 の writer はどれも最初のコマンドで段の token の控えを全文書について取る
// （doc_check backup）。txBegin は同じ token・同じファイルの 2 回目から何もしないので、どの文書も最初に書いた writer の控えが段の入口の本文になる。
// 控えが無いと、blocked の後の同じ段の再実行の入口の restore が本文を戻せない（references/workflow-io.md §3）。
const backupCmd = () => cli('backup', `${uniq(auditDocs()).sort().map((k) => `--doc ${k}`).join(' ')} --token ${txToken()}`)

// docsShaped: backup・restore の stdout の文書の digest（digests・entry_digest・tree_digest）の形。keys があれば digests のキーがちょうどそれ（backup）。
const docsShaped = (o, keys = null) => Boolean(o) && isMap(o.digests) && (!keys || canonicalText(Object.keys(o.digests).sort()) === canonicalText(keys))
  && Object.values(o.digests).every((v) => v === null || (typeof v === 'string' && Boolean(v)))
  && (o.entry_digest === null || (typeof o.entry_digest === 'string' && Boolean(o.entry_digest))) && typeof o.tree_digest === 'string' && Boolean(o.tree_digest)
// docsMoved: 文書が段の入口の本文と違う理由（同じなら null）。最初の段 4 の入口: existing_docs に無い単位の文書は無く（reset が消す）、既存の文書は
// 段 1 の reset の直後のまま（state.entry_digest）。段 7 の入口と、最初のゲートの後に書き直す段 4 の入口（state.deferred で初稿を監査した後）:
// 直前の監査の snapshot の木（state.audit.digest。その後の段は文書を書かない）。digests に無いキーは本文が無い。
// bornOnly: 違うのが最初の段 4 で新しく生まれた文書だけ（段 1 の入口の reset が消すので段 1 から戻せる）。
function docsMoved(stage, o) {
  if (stage === '4' && !state.audit) {
    const born = auditDocs().filter((k) => !KEEP_KEYS.includes(k) && o.digests[k] != null)
    const moved = (o.entry_digest ?? null) !== (state.entry_digest ?? null)
    const why = [...born.map((k) => `${k} がある`), ...(moved ? [`既存の文書の digest ${o.entry_digest} が段 1 の reset の値 ${state.entry_digest ?? null} と違う`] : [])]
    return why.length ? { text: `段 4 の入口の本文と違う（${why.join('・')}）`, bornOnly: !moved } : null
  }
  return o.tree_digest === state.audit.digest ? null : { text: `木 ${o.tree_digest} が段 ${stage} の入口の監査の基準 audited-${state.audit.n}（${state.audit.digest}）と違う`, bornOnly: false }
}
// noteBackup: writer の返した backup の stdout（自己申告）を照らす。違えば integrity に 1 行足して段は進める（控えが要るのはこの段を同じ段から
// 再実行するときだけで、その正否は再実行の入口で別の体が写す restore の stdout で決まる）。
// moved: 照らす先（既定は段の入口の本文。形式検証の差し戻しでは formal-status の tree_digest_request）。
function noteBackup(stage, label, text, moved = docsMoved) {
  const keys = uniq(auditDocs()).sort()
  const bc = parseStdout(text)
  const shaped = bc && bc.backup === true && bc.token === txToken() && canonicalText(bc.docs) === canonicalText(keys) && docsShaped(bc, keys)
  const m = shaped && moved(stage, bc)
  // 控えの版は、その文書に最初に控えを取った writer の時点で決まる（並列なら別の writer のことがある）ので、誰が書いたかは断定しない。
  const d = !shaped ? `token ${txToken()} で文書 ${list(keys)} の控えを取った stdout ではない` : m ? `この token の控えの版が${m.text}` : null
  if (d) noteIntegrity(`${label} の doc_check backup（token ${txToken()}）: ${d}（この段が止まって同じ段から再実行すると、入口の照合で止まりうる）`)
}
// writerBackups: writer の backup_check の写しが checksum に合わなければ取り直し（recopy）、照らす。
async function writerBackups(stage, labels, results, phaseTitle, moved) {
  for (let i = 0; i < results.length; i++) {
    results[i] = await recopy(labels[i], results[i], { backup_check: backupCmd() }, phaseTitle)
    noteBackup(stage, labels[i], results[i].backup_check, moved)
  }
}

// designatedCmds: 指名された監査役の doc と tree-digest と quotes は読むだけなので取り直す。snapshot --save は監査の基準を書き直し、--live の一覧も
// 監査役の実行中の値なので、取り直さずに段からやり直させる（snapshotFault）。
const quotesCmd = (round, packs) => cli('quotes', `--findings ${packs.map((p) => findingsName(p, round)).join(',')}`)
const designatedCmds = (round, packs) => ({ doc_check: cli('doc', `--open-tbd "${openTbdOf(state).join(',')}"`), tree_digest: cli('tree-digest'), quotes: quotesCmd(round, packs) })
const snapshotFault = (d) => (d && copyFault(d.audited) ? `（snapshot の stdout の写しが checksum（${STDOUT_FNV}）に合いません。snapshot は基準を書き直すので取り直しません）` : '')

async function stage4() {
  const waves = unitWaves(state.units)
  for (const wave of waves) {
    const units = wave.map((id) => state.units.find((u) => u.id === id))
    const results = await runEach(units, (u) => call(writerPrompt(u, 'draft'), { ...OPTS.writer, schema: WRITER_SCHEMA, phase: 'Draft', label: writerLabel(u, 'draft') }))
    const missing = units.filter((_, i) => !results[i]).map((u) => writerLabel(u, 'draft'))
    // 一度も書かれていない単位を監査に回さない。
    if (missing.length) throw notRun(missing.join(', '))
    await writerBackups('4', units.map((u) => writerLabel(u, 'draft')), results, 'Draft')
    for (const r of results) absorbWriter(r)
  }
  state.settled_written = uniq([...usableResolutions(state), ...(state.holds || [])])
  return '5'
}

// REVIEW_MAX_BYTES・DOC_BYTES: writer reviewer 1 体が読む文書の上限と、1 文書の分量の目安（doc_check の SIZE_BUDGET.document と同じ。tests が
// 照合する）。script はファイルの大きさを読めず、agent に申告させた値は検査できないので、文書の数で静的に決める。全文書が上限に収まる間は 1 体にする。
const REVIEW_MAX_BYTES = 100000
const DOC_BYTES = 23378
const DOCS_PER_REVIEW = Math.max(1, Math.floor(REVIEW_MAX_BYTES / DOC_BYTES))
// reviewPacks: writer reviewer の組。文書の並びの順に前から詰め、組が 1 つなら名前は all。whole reviewer は文書をまたぐ矛盾を見るので分けない。
function reviewPacks(docs) {
  const groups = []
  for (let i = 0; i < docs.length; i += DOCS_PER_REVIEW) groups.push(docs.slice(i, i + DOCS_PER_REVIEW))
  return groups.map((ds, i) => ({ role: 'writerReviewer', pack: groups.length === 1 ? 'all' : `p${i + 1}`, docs: ds }))
}
const wholePlan = () => ({ role: 'wholeReviewer', pack: 'all', docs: auditDocs() })
const ROLE_TAG = { writerReviewer: 'wr', wholeReviewer: 'wh' }
const findingsName = (p, round) => `r${round}-${ROLE_TAG[p.role]}-${p.pack}`
const auditorLabel = (p, round) => `${p.role}:r${round}:${p.pack}`
const docFile = (k) => `${W}/${k.replace('/', '-')}.md`

// auditorPrompt: opt.changes は段 8 の writer の申告（文書ごとの項目）、opt.diff は段 8 の writer reviewer が判定の前に実行する diff、
// opt.reviewed は whole reviewer に渡す同じ回の writer reviewer の指摘。
function auditorPrompt(p, round, opt) {
  const all = auditDocs()
  const whole = p.role === 'wholeReviewer'
  const declared = opt.changes ? p.docs.filter((d) => (opt.changes[d] || []).length).map((d) => `- ${d}: ${list(uniq(opt.changes[d]))}`) : []
  // 前のパスの指摘は組の文書のもの全部を渡す。申告に無い変更の項目は writer reviewer が diff で読むまで script に分からないので、申告の項目に
  // 絞ると、その項目への前の指摘と裁定が届かない。
  const inPack = (f) => opt.changes && p.docs.includes(f.doc)
  const prev = uniq(pendingFindings(state.pending).filter(inPack).map((f) => f.id))
  const ruled = uniq(((state.pending || {}).again || []).filter(inPack).flatMap((f) => f.rulings))
  const target = whole
    ? `全文書: ${all.map(docFile).join('、')}、${W}/plan.json`
    : `${p.docs.length === all.length ? '全文書' : `詰め合わせの組 ${p.pack} の文書（ほかの文書は別の writer reviewer が見る）`}: ${p.docs.map(docFile).join('、')} とその .meta.json`
  const lines = [
    header(p.role, opt.stage, opt.label),
    groundsBlock(),
    target,
    existingNote(),
    waitingNote('auditor'),
    opt.changes ? `範囲を絞った監査: writer の申告の項目は次のとおり（その項目の節から読む）。\n${declared.join('\n') || '（なし）'}` : '',
    opt.diff ? `判定の前に \`${opt.diff}\` を実行し、結果ファイルの by_doc のうち自分の組の文書の changed・added の項目も範囲に足す（申告に無い変更。exit 3 なら判定せずに findings: [] を返す。契約 §writer-reviewer）。` : '',
    prev.length ? `この文書への前のパスの指摘（範囲の項目のものを照らす）: ${list(prev)}（${FINDINGS_READ}）` : '',
    ruled.length ? `この文書への前のパスの指摘を裁定した resolution: ${list(ruled)}（中身は \`${getCli('resolutions', ruled)}\`）` : '',
    opt.reviewed
      ? `同じ回の writer reviewer の指摘: ${list(opt.reviewed.ids)}（${opt.reviewed.files.map((f) => `${W}/findings/${f}.json`).join('、')}）。確かめて、退けるものを rejected に返す（agents/whole-reviewer.md「writer reviewer の指摘を確かめる」）。`
      : '',
    `指摘は ${W}/findings/${findingsName(p, round)}.json に書き、ID の振り方は契約の「### 指摘の形」に従う。`,
    formalAuditNote(),
  ]
  if (opt.designated) lines.push(`あなたは指名された監査役である。${opt.designated}`)
  return lines.filter(Boolean).join('\n\n')
}

// liveDirs: 指名された whole reviewer が snapshot を取るとき、同じ段の writer reviewer の作業用ディレクトリも残す（並列だった以前と同じく、
// その段の監査役の tmp を --sweep で消さず stray にも数えない）。snapshot の --sweep はここに無い label の作業用ディレクトリを消す。
function liveDirs(plan, round) {
  return plan.map((p) => fileKey(auditorLabel(p, round))).join(',')
}

// noteAudited: 所有表に無いファイルと分量の目安の超過は照合の食い違いではない所見なので、integrity ではなく
// notices に置く（integrity の件数は goal_selector の R4 が照合の食い違いとして数える）。一覧は載せず件数とパスだけにする。
function noteAudited(audited, label) {
  const found = [
    ['stray', 'W に所有表に無いファイル'],
    ['swept', '作業用ディレクトリに残っていて消したもの'],
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

// runAuditors: 未実施の監査を「指摘 0 件」にしないため、返り値の無い監査役は missing に挙げる（呼び出した段が止める）。
async function runAuditors(plan, round, stage, opt = {}) {
  const results = await runEach(plan, (p) =>
    call(auditorPrompt(p, round, { ...opt, stage, designated: p.designatedText, label: auditorLabel(p, round) }), {
      ...OPTS[p.role],
      schema: AUDIT_SCHEMA,
      phase: stage === '5' ? 'Audit' : 'Revise',
      label: auditorLabel(p, round),
    })
  )
  const missing = plan.filter((_, i) => !results[i]).map((p) => auditorLabel(p, round))
  return { results, missing }
}

// reviewed: whole reviewer に渡す、同じ回の writer reviewer の指摘のファイルと ID。
const reviewed = (packs, results, round) => ({ files: packs.map((p) => findingsName(p, round)), ids: uniq(results.flatMap((r) => ((r && r.findings) || []).map((f) => f.id))) })

// staticUnquoted: 指名された whole reviewer が判定の前に実行した doc_check quotes の stdout から、quote がどの原文にも無い（not_found）同じ回の
// writer reviewer の指摘の ID。照らした findings か版が期待と違うか stdout が無ければ、退けずに integrity に 1 行足す（静的な退けは LLM の判断を
// 通らないので、退けない向きに倒す）。同じ回の writer reviewer の返り値に無い ID は照らせないので退けない。
function staticUnquoted(d, audited, packs, results, round) {
  const note = (why) => {
    noteIntegrity(`監査 r${round}: ${why}ので、quote の照合で指摘を退けなかった`)
    return []
  }
  const q = parseStdout(d && d.quotes)
  const expected = packs.map((p) => findingsName(p, round))
  if (!q || !Array.isArray(q.files) || !Array.isArray(q.unquoted)) return note('quote の照合の stdout が無い')
  if (canonicalText([...q.files].sort()) !== canonicalText([...expected].sort())) return note('照らした findings が期待と違う')
  if (q.tree_digest !== audited.digest) return note('照合の版が監査の基準と違う')
  const own = new Set(results.flatMap((r) => (r && r.findings) || []).map((f) => f.id))
  return uniq(q.unquoted.filter((id) => own.has(id)))
}

// auditFindings: その回の指摘の集合。whole reviewer が退けたのは同じ回の writer reviewer の指摘の ID だけで、それ以外の ID は退けない（自分の
// 指摘・前の回の指摘を退けると、blocking を監査役が自分で消せる）。unquoted は quote の照合で静的に退ける ID（staticUnquoted）。
// 退けた指摘は経路・再発・逆向きの判定より前に外す。
function auditFindings(packs, results, whole, round, unquoted = []) {
  const fromWriter = results.flatMap((r) => (r && r.findings) || [])
  const own = new Set(fromWriter.map((f) => f.id))
  const asked = uniq((whole && whole.rejected) || [])
  const stray = asked.filter((id) => !own.has(id))
  const statics = new Set(unquoted)
  const rejected = asked.filter((id) => own.has(id) && !statics.has(id))
  if (stray.length) noteIntegrity(`監査 r${round}: whole reviewer が同じ回の writer reviewer の指摘に無い ID を退けようとした（退けずに数えた）: ${list(stray)}`)
  if (rejected.length) state.notices = [...(state.notices || []), `監査 r${round}: whole reviewer が writer reviewer の指摘 ${rejected.length} 件を退けた: ${list(rejected)}（理由は ${W}/findings/${findingsName(wholePlan(), round)}.json の rejected）`]
  if (unquoted.length) state.notices = [...(state.notices || []), `監査 r${round}: 引用がどの原文にも無い writer reviewer の指摘 ${unquoted.length} 件を退けた: ${list(unquoted)}（${W}/checks/quotes-r${round}.json）`]
  const out = new Set([...rejected, ...unquoted])
  return [...fromWriter.filter((f) => !out.has(f.id)), ...((whole && whole.findings) || [])]
}

// ---------------------------------------------------------------- 形式検証（formal-method）への依頼と取り込み
// 段 5・8 の本体の最初（writer の後・監査役の前）で、doc_check formal-request が送る単位を静的に決め、送る単位があれば needs_formal で返る。
// 司令塔が formal-method を回して formal-import で結果を W に置き、next_args で呼び直す（resume は使わない。入口の flow-check が取り込みを照らす）。
// 取り込んだ結果に反例があれば、監査役の前に、その文書の writer へ 1 回だけ差し戻し（formalRework）、変わった単位だけをもう 1 回依頼する（依頼 b）。
// 依頼 b の後に残る反例は、doc_check の ST-FORMAL-CEX- として blocking のまま監査と輪の止め方に進む。正本は references/workflow-io.md §4 の段 5・8。
const formalRid = (round, phase) => `f${round}${phase}`
const formalRound = (rid) => Number(String(rid).slice(1, -1))
const formalPhase = (rid) => String(rid).slice(-1)
// entryFormal: 入口の flow-check が返した formal-status の stdout を照らした値（state に載せない。entryAnswers と同じ扱い）。
let entryFormal = null
let formalOffNoted = false
const FORMAL_COUNTS = ['verified', 'counterexample', 'overlap', 'unverified', 'undetected']

// formalCheckOf: formal-request の stdout。rid が違うか、送る単位があるのに依頼の digest・fnv・cwd が無ければ受け取らない。
function formalCheckOf(text, rid) {
  const o = parseStdout(text)
  if (!o || o.rid !== rid || !Number.isInteger(o.goals) || !Number.isInteger(o.units) || typeof o.tree_digest !== 'string') return null
  if (o.goals > 0 && !(typeof o.request_fnv === 'string' && /^[0-9a-f]{8}$/.test(o.request_fnv) && typeof o.request_digest === 'string' && o.request_digest && typeof o.cwd === 'string' && o.cwd)) return null
  return o
}
// formalStatusOf: formal-status の stdout。取り込んだ後（outcome が null でない）は counts を持つ。
function formalStatusOf(text) {
  const o = parseStdout(text)
  if (!o || typeof o.rid !== 'string' || typeof o.fnv !== 'string' || typeof o.units_digest_ok !== 'boolean' || !Array.isArray(o.cex_docs)) return null
  if (typeof o.tree_digest_request !== 'string' || typeof o.tree_digest_now !== 'string') return null
  if (o.outcome !== null && (!FORMAL_OUTCOMES.includes(o.outcome) || !isMap(o.counts) || !FORMAL_COUNTS.every((k) => Number.isInteger(o.counts[k])))) return null
  return o
}
// formalEntryRid: next_args で段 5・8 から始めた run の入口で照らす依頼。取り込む前の依頼と、取り込んだ後でも同じ回の依頼（差し戻しの後に止まった
// 再実行は、入口で照らし直して差し戻しからやり直す）。
function formalEntryRid(from) {
  const f = state.formal
  if (input.formal === false || !['5', '8'].includes(from) || !f || !f.rid) return null
  const round = state.audit ? state.audit.n + 1 : 1
  return !f.ok || formalRound(f.rid) === round ? f.rid : null
}

function noteFormalOff() {
  if (formalOffNoted) return
  formalOffNoted = true
  skipped.push({ step: 'formal-method', fact: SKIP.formal_unavailable, ids: [] })
  if (!(state.notices || []).includes(FORMAL_OFF_NOTICE)) state.notices = [...(state.notices || []), FORMAL_OFF_NOTICE]
}

// formalGate: 段 5・8 の本体の最初。返り値は段の返り値（needs_formal か blocked）か null（監査役へ進む）。
// 持ち越した問いのまま書いた段 5（state.deferred。最初のゲートの後に書き直す初稿）は依頼せず、上限にも数えない。
async function formalGate(stage, round) {
  if (input.formal === false) {
    noteFormalOff()
    return null
  }
  if (stage === '5' && state.deferred) return null
  const f = state.formal
  const phase = f && f.ok && formalRound(f.rid) === round ? formalPhase(f.rid) : null
  if (phase === 'b') return null
  if (phase === 'a') {
    // 依頼 a を取り込んだ直後（入口で ok にした）。反例が無ければ監査役へ。差し戻しの後の依頼 b は上限に数えない。
    if (!entryFormal || entryFormal.rid !== f.rid || !entryFormal.counts.counterexample) return null
    await formalRework(stage, round, entryFormal)
    return formalRequest(stage, round, 'b')
  }
  if (((state.formal_by || {})[stage] || 0) >= FORMAL_LIMIT[stage]) return null
  return formalRequest(stage, round, 'a')
}

// formalRequest: flow-check に doc_check formal-request を実行させる。送る単位が無ければ戻らない（skipped に no_formal_target）。
// 送る単位を決めるのは doc_check（差し戻しの writer が何も変えなかったかも、依頼 b の送る単位の数で決まる。writer の申告では決めない）。
async function formalRequest(stage, round, phase) {
  const rid = formalRid(round, phase)
  const label = `flow-check:${stage}-formal-${rid}`
  const cmd = cli('formal-request', `--rid ${rid} --stage ${stage} --phase ${phase}`)
  const r = await once(label, 'flowCheck', [header('flowCheck', stage, label), `実行する: \`${cmd}\`。stdout を加工せずに formal_check に入れて返す。`].join('\n\n'), FORMAL_CHECK_SCHEMA, PHASE_OF[stage], { formal_check: cmd })
  const fr = formalCheckOf(r.formal_check, rid)
  if (!fr) return blocked(`flow-check（段 ${stage}）が ${rid} の doc_check formal-request の stdout を返しませんでした`, stage)
  if (!fr.goals) {
    skipped.push({ step: `formal-method:${rid}`, fact: SKIP.no_formal_target, ids: [] })
    state.formal = { rid, ok: 1 }
    return null
  }
  state.formal = { rid, fnv: fr.request_fnv }
  if (phase === 'a') state.formal_by = { ...(state.formal_by || {}), [stage]: ((state.formal_by || {})[stage] || 0) + 1 }
  return finish('needs_formal', {
    formal_request: { rid, request_path: `${W}/fm/${rid}/request.json`, request_digest: fr.request_digest, cwd: fr.cwd, units: fr.units, goals: fr.goals },
    next_args: nextArgs(stage),
    resumable: false,
  })
}

// formalRework: 依頼 a の反例のある文書（cex_docs）を持つ単位の writer を、段 7 と同じ改稿のプロンプトで 1 回だけ起動する（label writer:<unit>:formal-<回>）。
// 控えの照らす先は依頼の木（段 5 には state.audit が無いことがある）。段 8 では申告を state.revised.changes に足す（足さないと段 8 の diff で
// 申告に無い変更に数えられる）。
async function formalRework(stage, round, st) {
  const cex = new Set(st.cex_docs)
  const targets = state.units.filter((u) => u.docs.some((k) => cex.has(k)))
  if (!targets.length) return
  const mode = `formal-${round}`
  const labelOf = (u) => writerLabel(u, mode)
  const extra = [
    `形式検証の反例の差し戻し（${st.rid}）: doc_check の \`ST-FORMAL-CEX-\` の指摘を直す（事実は ${W}/fm/facts.json。指摘は内部ループの doc の findings に出る）。他の指摘には当てない（契約「## 形式検証の事実」）。`,
    '直した項目を changed_items に入れる。',
  ].join('\n\n')
  const results = await runEach(targets, (u) => call(writerPrompt(u, mode, extra), { ...OPTS.writer, schema: WRITER_SCHEMA, phase: PHASE_OF[stage], label: labelOf(u) }))
  const missing = targets.filter((_, i) => !results[i]).map(labelOf)
  if (missing.length) throw notRun(missing.join(', '))
  const moved = (_, o) => (o.tree_digest === st.tree_digest_request ? null : { text: `木 ${o.tree_digest} が ${st.rid} の依頼の木（${st.tree_digest_request}）と違う`, bornOnly: false })
  await writerBackups(stage, targets.map(labelOf), results, PHASE_OF[stage], moved)
  targets.forEach((u, i) => {
    const r = results[i]
    absorbWriter(r)
    if (stage !== '8' || !(r.changed_items && r.changed_items.length)) return
    const changes = { ...state.revised.changes }
    for (const k of u.docs) changes[k] = uniq([...(changes[k] || []), ...r.changed_items])
    state.revised = { ...state.revised, changes, docs: uniq([...(state.revised.docs || []), ...u.docs]) }
  })
}

// formalAuditNote: 形式検証の事実を監査役に渡す 1 行（依頼した run だけ）。判定し直さないものと、ふだんどおり判定するものを分ける。
function formalAuditNote() {
  if (!state.formal_by || !Object.keys(state.formal_by).length) return ''
  return `形式検証の事実: ${W}/fm/facts.json（どの判定を意味で判定し直さないかは契約「## 形式検証の事実」の監査役の項）。`
}

async function stage5() {
  // 最初のゲートの後に書き直した初稿の監査は、持ち越した問いのまま書いた初稿の監査の経路を引き継がない（項目は書き直しで別物になる）。
  // 回の番号は前の監査の続きにする。同じ回の番号で監査すると指摘の ID が前の監査の指摘と重なり、その指摘を閉じた裁定が新しい指摘も閉じたことに
  // なって（unruled）、新しい指摘が段 6 に届かない。
  const round = state.audit ? state.audit.n + 1 : 1
  // 形式検証は writer の後・監査役の前（formalGate）。needs_formal の next_args の state を、段の入口の state と形式検証の欄だけの違いにするため、
  // state を書き換える行（pass・item_routes・reframed）より前に置く。
  const formal = await formalGate('5', round)
  if (formal) return formal
  state.pass = 1
  const base = `audited-${round}`
  delete state.item_routes
  // 組み直しの印は初稿の前の 3a だけが読む。この先の next_args に運ぶと、読まれない値が字数を使う。
  delete state.reframed
  // existing は段 4 を通らず、この run の裁定をまだどの writer にも渡していない。
  if (ENTRY === 'existing') state.settled_written = []
  const packs = reviewPacks(auditDocs())
  const whole = wholePlan()
  const wr = await runAuditors(packs, round, '5')
  if (wr.missing.length) throw notRun(wr.missing.join(', '))
  whole.designatedText = [
    `監査の判定とは別に、次を実行して stdout を加工せずに designated に入れる。`,
    `最初に: \`${cli('doc', `--open-tbd "${openTbdOf(state).join(',')}"`)}\` → designated.doc_check、続けて（判定の前に）\`${quotesCmd(round, packs)}\` → designated.quotes`,
    `最後に: \`${cli('snapshot', `--save ${base} --role auditor --live ${liveDirs([...packs, whole], round)} --sweep${FIXED_FLAG}`)}\` → designated.audited`,
  ].join('\n')
  const wh = await runAuditors([whole], round, '5', { reviewed: reviewed(packs, wr.results, round) })
  if (wh.missing.length) throw notRun(wh.missing.join(', '))
  const wv = wh.results[0]
  if (wv.designated) wv.designated = await recopy(auditorLabel(whole, round), wv.designated, designatedCmds(round, packs), 'Audit')
  const audited = parseStdout(wv.designated && wv.designated.audited)
  const docCheck = parseStdout(wv.designated && wv.designated.doc_check)
  if (!audited || !audited.digest) return blocked(`whole reviewer が監査の基準（${base} の snapshot）を返しませんでした${snapshotFault(wv.designated)}。どの版を監査したかの記録が無いまま進めません`, '5')
  const moved1 = fixedMoved(audited, base)
  if (moved1) return blocked(moved1.error, moved1.rerun ? '5' : null)
  const entry1 = entryMoved(docCheck)
  if (entry1) return blocked(entry1, null)
  state.audit = { n: round, digest: audited.digest }
  state.tree_digest = audited.digest
  noteAudited(audited, base)
  setPending(auditFindings(packs, wr.results, wv, round, staticUnquoted(wv.designated, audited, packs, wr.results, round)), docCheck, [])
  // lowOnly: 指摘が blocking を含まず、改稿の理由（doc_check の blocking・新しい TBD・回答待ちの問い・本文にまだ入っていない裁定・当てていない
  // routes）も無ければ、段 6〜8 を飛ばして 9 へ進む。blocking でない指摘（route が decision のものも）は裁定せず、本文に反映しないまま
  // unreflected で開示する。doc の stdout が無ければ doc_check の blocking を数えられないので飛ばさない（退けない向きと同じく、安全側に倒す）。
  const p = pendingView(state.pending)
  const unwritten = minus(uniq([...usableResolutions(state), ...(state.holds || [])]), state.settled_written || [])
  const applied = new Set(state.applied_routes || [])
  const unrouted = (state.routes || []).filter((x) => !applied.has(x.id))
  const lowOnly = Boolean(docCheck) && !p.blocking.length && !p.doc_blocking && !(state.new_tbd || []).length && !pendingQuestions(state).length && !unwritten.length && !unrouted.length
  if (lowOnly) {
    if (p.findings.length) skipped.push({ step: auditorLabel(packs[0], round + 1), fact: SKIP.low_only, ids: p.findings.map((f) => f.id) })
    log(`監査 r${round} の指摘が blocking を含まないので、改稿と 2 巡目の監査を飛ばします（残した指摘 ${p.findings.length} 件）`)
    return '9'
  }
  return '6'
}

// recurring: 再発した項目と、その項目への前のパスの指摘（段 6 に渡す）。again: 既裁定の再出。経路にも blocking にも入れず、次のパスの
// 照合のために裁定の ID だけを持ち越す。
function setPending(findings, docCheck, carried, opt = {}) {
  const drop = new Set((opt.again || []).map((x) => x.id))
  const recurring = opt.recurring || {}
  const kept = [...findings, ...carried].filter((f) => f && !drop.has(f.id))
  const all = toDecision(kept, [...(opt.reversed || []), ...kept.filter((f) => recurring[itemKey(f)]).map((f) => f.id)])
  const refs = (docCheck && docCheck.flow_refs) || {}
  // decision の指摘の項目も持つ: 段 6 の指された根拠（pointedGrounds）が、項目の trace が指す要素の検証の裁定を引く。
  const flow = {}
  for (const f of all) {
    const ids = uniq((refs[f.doc] || {})[f.item_id])
    if (ids.length) flow[f.doc] = { ...(flow[f.doc] || {}), [f.item_id]: ids }
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
// 延長のパス（state.pass > MAX_AUDIT_PASSES。最後の監査の後に聞く 1 回）では、blocking の decision だけを渡す。blocking でない decision は
// 裁定せずに report.md の節に残す（段 5 の lowOnly と同じ扱い）。
async function stage6() {
  const extended = state.pass > MAX_AUDIT_PASSES
  const decision = extended ? blockingDecision(pendingView(state.pending)) : unruled(pendingView(state.pending).decision.map((id) => `finding:${id}`), 'finding').map((k) => k.slice(8))
  const tbd = unruled((state.new_tbd || []).map((id) => `tbd:${id}`), 'tbd').map((k) => k.slice(4))
  const allowQuestions = ASKS[6]()
  const reasked = new Set(answeredRecurrences(decision).map((id) => `finding:${id}`))
  if (decision.length || tbd.length) {
    const res = await decide(decision, tbd, allowQuestions, reasked)
    if (res.error) return blocked(res.error, res.rerun === false ? null : '6')
  }
  const left = extended ? remainingBlocking() : null
  state.new_tbd = []
  const again = pendingQuestions(state).filter((id) => reasked.has((state.about || {})[id]))
  if (again.length) {
    const he = await holdLeft('6', again, 'Decide', '前の裁定に回答か保持規則がある項目の再発で、同じことを二度聞かない')
    if (he) return blocked(he.error, he.rerun === false ? null : '6')
  }
  // 仕様書だけを書く run の要求の論点は、字数・聞ける回数の判定より先に upstream_gap にする（requirementGap）。
  const gap = pendingQuestions(state).length ? requirementGap() : null
  if (gap) return gap
  // 延長の段 6 の裁定で state が増えるので、ゲートの next_args をここでも測る。超えるなら問いを保持規則にして輪を出る。
  const over = extended && pendingQuestions(state).length > 0 && extensionOver(state)
  if (pendingQuestions(state).length) {
    if (allowQuestions && !over) return needsAnswers("3a'", '7')
    const he = await holdLeft('6', pendingQuestions(state), 'Decide', over ? OVER_WHY : LIMIT_WHY)
    if (he) return blocked(he.error, he.rerun === false ? null : '6')
  }
  // 延長で問いが無ければ 7 へ進まない。上限を越えて改稿と監査を延ばすのは、依頼者の回答を当てる 1 回だけである。
  // 延長の段 6 が入口の論点（新しい TBD など）をすべて値で決めると、残りの数は 0 になる。そのときは延長に入った論点の数で書く。
  if (extended) return finalHold(left.blocking || decision.length + tbd.length, left.newTbd, 'pass_limit', over ? `最後の監査の後の延長のパスで、${OVER_WHY}` : '最後の監査の後の延長のパスで、段 6 が依頼者への問いを出さなかった', '6')
  return '7'
}

// blockingDecision: まだ裁定の無い、blocking で route が decision の指摘。延長のパスの段 6・延長するかの判定（段 8）・resolver:final に渡す。
// 裁定済みのものを渡し直すと、同じ論点に 2 つ目の裁定を put させることになり、doc_check が拒む。
const blockingDecision = (p) => unruled(p.findings.filter((f) => f.blocking && f.route === 'decision').map((f) => `finding:${f.id}`), 'finding').map((k) => k.slice(8))

// remainingBlocking: 監査の後に残った blocking の数（新しい TBD を含む）と、まだ閉じていない新しい TBD。段 8 と延長の段 6 の出口で同じ式を使う。
// 改稿で新しく起票された TBD も、裁定されないまま終わると「開いたまま完了」になるので、blocking と同じく数える。
function remainingBlocking() {
  const newTbd = minus(state.new_tbd || [], closedKeys(state).filter((k) => k.startsWith('tbd:')).map((k) => k.slice(4)))
  const now = pendingView(state.pending)
  return { newTbd, blocking: now.blocking.length + now.doc_blocking + newTbd.length }
}

const rulingsOfFindings = (ids) => uniq(Object.entries(state.about || {}).filter(([, k]) => ids.some((id) => k === `finding:${id}`)).map(([id]) => id))

// answeredRecurrences: 再発した項目のうち、前のパスの指摘の裁定に依頼者の回答か保持規則があるものの今の指摘。同じ論点を二度聞くと、依頼者を
// 止める回数を増やすだけで答えは変わらない（保留と答えた論点も、上限で聞けなかった論点も同じ）ので、回答を当てるか保持規則にする。段 3・3b で答えた問い（about が open・組）と同じ論点の新しい指摘は、
// 項目の再発に数えられないので、verifier の decidable（回答で決まる論点を問いにした）が止める。
function answeredRecurrences(decision) {
  const rec = state.pending.recurring || {}
  const settled = new Set([...(state.answered || []), ...(state.holds || [])])
  const items = new Set(Object.keys(rec).filter((k) => rulingsOfFindings(rec[k]).some((id) => settled.has(id))))
  return uniq(pendingFindings(state.pending).filter((f) => decision.includes(f.id) && items.has(itemKey(f))).map((f) => f.id))
}

function decide(decision, tbd, allowQuestions, reasked) {
  const rec = state.pending.recurring || {}
  const redecide = Object.keys(rec)
  orderHolds([], [...reasked])
  return resolveCycle('6', {
    phase: 'Decide',
    task: [
      `段 6（planner.md の「段 6」）: route が decision の指摘 ${list(decision)}（${FINDINGS_READ}）、meta の新しい TBD（保存した文書から引き継いだ TBD を含む） ${list(tbd)}。`,
      redecide.length ? `再発した項目（項目: 前のパスの指摘 ← その裁定）: ${redecide.map((k) => `${k}: ${list(rec[k])} ← ${list(rulingsOfFindings(rec[k]))}`).join(' / ')}` : '',
      reasked.size ? `前の裁定に回答か保持規則がある再発の指摘（planner.md の「段 6」）: ${list([...reasked].map((k) => k.slice(8)))}` : '',
      pointedLines([...findingItems(decision, state), ...issueItems(tbd.map((id) => `tbd:${id}`))]),
      waitingNote('resolver'),
      allowQuestions ? askNote(true) : `${LIMIT_WHY}ので、価値の判断は question ではなく hold にする（planner.md の「8'」）。${specOnly() ? SPEC_REQ_NOTE : ''}`,
    ]
      .filter(Boolean)
      .join('\n'),
    targets: [...decision.map((id) => `finding:${id}`), ...tbd.map((id) => `tbd:${id}`)],
    allowQuestions,
  })
}

async function stage7() {
  const p = pendingView(state.pending)
  const routesByUnit = {}
  for (const { unit, id } of state.routes || []) routesByUnit[unit] = uniq([...(routesByUnit[unit] || []), id])
  const applied = new Set(state.applied_routes || [])
  // 前回の書き込みの後に決まった裁定（合格・回答・保持規則）。routes は段 6 で resolver が起動したときにしか無く、
  // 問いを保持規則に変えたときや改稿のパスのゲートの回答を当てたときは載らないことがある。載らない分を落とすと、決まったことや
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
    // blocking が残ったまま 9 へ進むと、止まる条件を通らずに done になる（段 6 が裁定しなかった指摘）。
    if (p.blocking.length) return finalHold(p.blocking.length, [], 'no_progress', '改稿に回せる指摘も裁定も無いまま blocking が残った', '7')
    log('改稿する指摘も裁定も無いので、改稿と再監査を飛ばします（最後の書き込みは段 5 で全体を監査済み）')
    return '9'
  }
  const results = await runEach(targets, (t) => {
    const before = t.unit.docs.map((k) => `${k}: ${state.docs && state.docs[k] ? state.docs[k] : `${W}/checks/audited-${state.audit.n}.snapshot.json の docs["${k}"].digest`}`)
    const extra = [
      `改稿前の digest（照合してから書き始める）:\n${before.map((x) => `- ${x}`).join('\n')}`,
      `writer の指摘（項目ごとに束ねたもの。${FINDINGS_READ}）:\n${t.bundles.map((b) => `- ${b.doc} ${b.item_id}: ${b.findings.join(', ')}${b.flow ? `（trace が指す flow 要素: ${b.flow.join(', ')}）` : ''}`).join('\n') || '（なし）'}`,
      `routes の担当の ID: ${list(t.routes)}${t.routes.length ? `（\`${getCli('routes', t.routes)}\`）` : ''}`,
      p.doc_blocking > 0 ? `${W}/checks/doc.json に doc_check の指摘が ${p.doc_blocking} 件ある。自分の文書の分を直す。` : '',
      newSettled.length ? `前回の書き込みの後に決まった resolution: ${list(newSettled)}。自分の文書に関わるものを当てる。` : '',
    ]
      .filter(Boolean)
      .join('\n\n')
    return call(writerPrompt(t.unit, 'revise', extra), { ...OPTS.writer, schema: WRITER_SCHEMA, phase: 'Revise', label: writerLabel(t.unit, 'revise') })
  })
  const missing = targets.filter((_, i) => !results[i]).map((t) => writerLabel(t.unit, 'revise'))
  if (missing.length) throw notRun(missing.join(', '))
  await writerBackups('7', targets.map((t) => writerLabel(t.unit, 'revise')), results, 'Revise')
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
  const formal = await formalGate('8', round)
  if (formal) return formal
  const { changes } = state.revised
  const packs = reviewPacks(auditDocs())
  const whole = wholePlan()
  const diffCmd = cli('diff', `--against audited-${n} --expect ${state.audit.digest}`)
  // 範囲は writer の申告に、申告に無い変更（diff）を足したもの。writer reviewer は判定の前に同じ diff を実行して自分の組の文書の範囲を読み、
  // whole reviewer は指名されて diff の結果を返す（監査の間は誰も本文を書かないので、2 体の見る diff は同じ）。
  const wr = await runAuditors(packs, round, '8', { changes, diff: diffCmd })
  if (wr.missing.length) throw notRun(wr.missing.join(', '))
  whole.designatedText = [
    '監査の判定とは別に、次を実行して stdout を加工せずに designated に入れる。',
    `最初に（判定の前に）: \`${diffCmd}\`。${W}/checks/diff-audited-${n}.json の changed・added・removed・by_doc を designated.diff に入れる（exit 3 なら designated.diff_error）。続けて（判定の前に）\`${quotesCmd(round, packs)}\` → designated.quotes`,
    `最後に: \`${cli('snapshot', `--save audited-${round} --role auditor --live ${liveDirs([...packs, whole], round)} --sweep${FIXED_FLAG}`)}\` → designated.audited、\`${cli('doc', `--open-tbd "${openTbdOf(state).join(',')}"`)}\` → designated.doc_check、\`${cli('tree-digest')}\` → designated.tree_digest`,
  ].join('\n')
  const wh = await runAuditors([whole], round, '8', { changes, reviewed: reviewed(packs, wr.results, round) })
  if (wh.missing.length) throw notRun(wh.missing.join(', '))
  const first = wh.results[0]
  if (first.designated) first.designated = await recopy(auditorLabel(whole, round), first.designated, designatedCmds(round, packs), 'Revise')
  const d = first.designated || {}
  if (d.diff_error) return blocked(`監査の基準 audited-${n} の digest が一致しません。基準が差し替わっているので、この監査が何と比べたのか分かりません: ${d.diff_error}`, null)
  if (!d.diff) return blocked('指名された監査役が diff の結果を返しませんでした', '8')
  const audited = parseStdout(d.audited)
  const tree = parseStdout(d.tree_digest)
  if (!(audited && audited.digest && tree && tree.digest)) return blocked(`指名された監査役が audited-${round} の snapshot か tree-digest を返しませんでした${snapshotFault(d)}`, '8')
  const moved = fixedMoved(audited, `audited-${round}`)
  if (moved) return blocked(moved.error, moved.rerun ? '8' : null)
  const extra = undeclaredByDoc(d.diff, changes, state.revised.docs || Object.keys(changes))
  const extraDocs = Object.keys(extra)
  if (extraDocs.length) {
    const shown = (doc) => `${doc}: ${extra[doc].slice(0, 5).join(', ')}${extra[doc].length > 5 ? ` ほか ${extra[doc].length - 5} 件（全件は返り値の undeclared）` : ''}`
    log(`writer の申告に無い変更がある（${extraDocs.map(shown).join(' / ')}）。writer reviewer と whole reviewer に diff から範囲に足させた（script は実際に見たかを確かめない）`)
  }
  const undeclared = { ...(state.undeclared || {}) }
  for (const doc of extraDocs) undeclared[doc] = uniq([...(undeclared[doc] || []), ...extra[doc]])
  state.undeclared = undeclared
  state.audit = { n: round, digest: audited.digest }
  state.tree_digest = tree.digest
  noteAudited(audited, `audited-${round}`)
  const findings = auditFindings(packs, wr.results, first, round, staticUnquoted(d, audited, packs, wr.results, round))
  const docCheck = parseStdout(d.doc_check)
  const entryN = entryMoved(docCheck)
  if (entryN) return blocked(entryN, null)
  // 進展は前後のパスの指摘と doc_check の件数だけから決める（agent の自己申告を読まない）。
  const prev = pendingView(state.pending)
  const carried = prev.findings.filter((f) => state.revised.unapplied.includes(f.id))
  const changed = { ...changes }
  for (const doc of extraDocs) changed[doc] = uniq([...(changed[doc] || []), ...extra[doc]])
  const again = reRaised(prev.findings, prev.again, findings, state, changed)
  if (again.length) {
    const line = `監査 r${round}: 既裁定の再出（再発に数えない）: ${again.map((x) => `${x.id} ← ${x.rulings.join(', ')}`).join(' / ')}`
    state.notices = [...(state.notices || []), line]
    log(line)
  }
  const recurring = recurringItems(prev.findings, [...findings, ...carried], again)
  state.item_routes = { ...(state.item_routes || {}), ...routeRecurring(recurring) }
  const recurPrev = {}
  for (const k of recurring) recurPrev[k] = uniq(prev.findings.filter((f) => itemKey(f) === k).map((f) => f.id))
  // 既裁定の再出も直前のパスの指摘なので、逆向きの判定には入れる（外すと、裁定に逆らう向きの指摘が writer に届く）。
  setPending(findings, docCheck, carried, { reversed: reversedFindings([...prev.findings, ...(prev.again || [])], findings), recurring: recurPrev, again })
  const { newTbd, blocking } = remainingBlocking()
  if (!blocking) return '9'
  // MAX_AUDIT_PASSES = 1 ではこの分岐を通らない。定数を戻せるように残す。
  if (state.pass < MAX_AUDIT_PASSES) {
    state.pass += 1
    log(`blocking が ${blocking} 件残った（新しい TBD ${newTbd.length} 件を含む。経路を変えた項目 ${list(recurring)}）。段 6 → 7 → 8 をもう 1 パス回します（${state.pass}/${MAX_AUDIT_PASSES}）`)
    return '6'
  }
  // 延長: 最後の監査の後に、まだ裁定の無い blocking の decision か新しい TBD が残り、聞ける回数があれば、延長のパスで依頼者に聞く
  // （段 6 → ゲート → 3a' → 7 → 8）。延長は 1 回きりで、その後に残れば下の finalHold で止まる。
  const asking = blockingDecision(pendingView(state.pending)).length + newTbd.length
  const over = state.pass === MAX_AUDIT_PASSES && asking > 0 && canAsk() && extensionOver({ ...state, pass: state.pass + 1 })
  if (state.pass === MAX_AUDIT_PASSES && asking && canAsk() && !over) {
    state.pass += 1
    log(`監査 r${round} の後に決定が要る論点が ${asking} 件残った（新しい TBD ${newTbd.length} 件を含む）。延長のパスで段 6 に渡し、問いがあれば回答を当てて改稿と監査を 1 回だけ延ばします`)
    return '6'
  }
  const why =
    state.pass > MAX_AUDIT_PASSES
      ? `回答を反映した後の監査 r${round} でも blocking が残った（延長は 1 回きり）`
      : `改稿と監査のパスが上限（MAX_AUDIT_PASSES = ${MAX_AUDIT_PASSES}）に達した${over ? `（${OVER_WHY}）` : asking ? `（${LIMIT_WHY}ので延長しない）` : ''}`
  return finalHold(blocking, newTbd, 'pass_limit', why, '8')
}

// finalHold: 改稿と監査の輪を出たので文書に反映せず、決定が要るものを保持規則と Issue の文案に変える。
// 渡す decision は blocking でまだ裁定の無いものだけで（blockingDecision）、blocking でない decision は report.md の節に残す。
// 延長の段 6 から呼ぶと聞ける段の中で走るが、輪を出た後は聞かないので、resolver:final の hold を問いに書き換え直させない（closing）。
async function finalHold(blocking, newTbd, stopReason, why, stage) {
  phase('Report')
  closing = true
  const p = pendingView(state.pending)
  const decision = blockingDecision(p)
  const routes = state.item_routes || {}
  const label = 'resolver:final'
  // 輪を出た後の blocked は同じ段をやり直しても同じ所で止まるので、返り値が無くても段を止め直さず、文案が無いことを理由に載せる。
  const prompt = resolverPrompt(
    label,
    '改稿の輪を出た後（blocked）',
    keepFlow(
      [
        `${why}。blocking が ${blocking} 件残った。文書は直さない。`,
        decision.length || newTbd.length
          ? `route が decision の指摘 ${list(decision)} と新しい TBD ${list(newTbd)} を hold にする（planner.md の「8'」）。`
          : '',
      ]
        .filter(Boolean)
        .join('\n')
    )
  )
  let r = null
  let threw = null
  try {
    r = await issue(label, 'resolver', prompt, RESOLVER_SCHEMA, 'Report')
  } catch (e) {
    if (!(e && e.agentThrew)) throw e
    threw = e.message
  }
  if (r) absorbResolver(r)
  const report = { report_path: `${W}/report.md`, remaining_blocking: p.blocking, carried_blocking: p.carried, doc_blocking: p.doc_blocking, tree_digest: state.tree_digest, stop_reason: stopReason, unreflected: unreflectedIds() }
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
  const rerouted = list(Object.keys(routes))
  const noDrafts = r ? '' : `。${threw || `${label} が応答しなかった（${NOT_RUN_WHY}）`}ので、残った論点の保持規則と Issue の文案はありません`
  return blocked(`${why}。blocking が ${blocking} 件残りました（全件は report.md の「本文に反映していない指摘」。再発で裁定に回した項目: ${rerouted}）${flowLeft}${noDrafts}`, null, report)
}

// unreflectedIds: 本文に反映していない指摘の全件（blocking によらない）。退けた指摘と既裁定の再出は pending に入らないので含まない。
// 司令塔が doc_check report --findings に渡し、report.md の節の中身は doc_check が W の findings から引く。
const unreflectedIds = () => pendingFindings(state.pending).map((f) => f.id)

// stage9: 事後報告は resolutions からの導出物なので、生成する役を起動しない。report.md は司令塔が doc_check report で作る。
async function stage9() {
  return finish('done', { report_path: `${W}/report.md`, tree_digest: state.tree_digest, docs: auditDocs(), fixed_docs: FIXED_KEYS, unreflected: unreflectedIds() })
}

const PHASE_OF = { 1: 'Intake', 3: 'Resolve', '3a': 'Answers', '3b': 'Answers', 4: 'Draft', 5: 'Audit', 6: 'Decide', "3a'": 'Answers', 7: 'Revise', 8: 'Revise', 9: 'Report' }
const STAGE_FNS = { 1: stage1, 3: stage3, '3a': () => stageApply('3a'), '3b': stage3b, 4: stage4, 5: stage5, 6: stage6, "3a'": () => stageApply("3a'"), 7: stage7, 8: stage8, 9: stage9 }

// exitViolation: 段を出るときの不変条件。破ると、数え直していない台帳の flow の指摘か、誰にも聞かれない問いを持ったまま次の段が走る。
// 回答待ちの問いを持って出てよいのは、聞くゲート（needs_answers）か回答済みのゲート（gatePassed）を通る段と、問いを持ち越している段（carrying）と、組み直しの後の問いと一緒に聞くために 3b へ持ち越す 3a だけ。
// 不合格の要素を持って出てよいのは、反映を REFLECT_STAGE に渡す 3a だけで、渡せる要素（reflectable）に限る（REFLECT_STAGE の出口では緩めない）。
function exitViolation(from, r) {
  if (unchecked) return `resolver:${unchecked.tag} の後に doc_check flow を独立に実行し直さないまま段を出ようとしました（independentFlow を通らない経路があります）`
  const reflectNext = defersReflection(from) && r === REFLECT_STAGE
  const asking = r.status === 'needs_answers' || gatePassed !== null || carrying() || reflectNext
  const waiting = asking ? [] : pendingQuestions(state)
  if (waiting.length) return `回答待ちの問い ${list(waiting)} を、聞くゲートも保持規則への変換も通らないまま段を出ようとしました`
  const failedHolds = Object.keys(holdFails).sort()
  if (failedHolds.length) return `検証に落ちた保持規則 ${list(failedHolds)} を、書き直して検証し直さないまま段を出ようとしました（writer に渡すと検証を通っていない規範文が本文に入る）`
  if (from === '1') return null
  if (!seen) return wrote ? 'flow か台帳を書いた後に、doc_check flow を独立に実行しないまま段を出ようとしました' : null
  const left = unverifiedLeft(seen, state, asking, reflectNext)
  return left ? `検証を通っていないものを持ったまま段を出ようとしました（${left}）` : null
}

// questionsDrift: 回答待ちの問いの正本は台帳（ruling が question で answer の無い resolution）で、pendingQuestions はその写しである。
// 写しがずれると、聞くべき問いがゲートで黙って落ちるか、答えた問いを聞き直す。ゲートは段の返り値としてだけ入るので（needsAnswers）、
// 段の出口ごとに最後の独立な stdout（seen）と照合すれば、ゲートの入口も含む。
function questionsDrift() {
  if (!seen) return null
  const ledger = uniq(seen.resolutions.filter((x) => RESOLUTION_ID.test(x.id) && x.ruling === 'question' && !x.has_answer).map((x) => x.id))
  const script = pendingQuestions(state)
  const [onlyLedger, onlyScript] = [minus(ledger, script), minus(script, ledger)]
  if (!onlyLedger.length && !onlyScript.length) return null
  return `回答待ちの問いが台帳（ruling が question で answer の無い resolution）と script の数えたものとで違います（台帳にだけある: ${list(onlyLedger)} / script にだけある: ${list(onlyScript)}）。resolver の返り値と台帳の書き込みが食い違っています`
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
// formalEntry: 入口の formal-status を state.formal と照らす。版の食い違い（rid・fnv・依頼のファイル・文書の木）は同じ next_args で直らないので
// next_args を付けずに止め、取り込みの前（outcome が null）だけ同じ段の next_args を付ける。通れば state.formal を取り込んだ印にする。
function formalEntry(from, text) {
  const f = state.formal
  const st = formalStatusOf(text)
  if (!st) return blocked(`flow-check（段 ${from} の入口）が ${f.rid} の doc_check formal-status の stdout を返しませんでした`, from)
  if (st.rid !== f.rid || (f.fnv !== undefined && st.fnv !== f.fnv) || !st.units_digest_ok) {
    return blocked(`段 ${from} の入口: 形式検証の依頼 ${f.rid} が next_args の版と違います（formal-status の rid ${st.rid}・fnv ${st.fnv}・units_digest_ok ${st.units_digest_ok}）。依頼を作り直すため、返った next_args を変えずに渡すか、S0 からやり直してください`, null)
  }
  if (st.outcome === null) return blocked(`段 ${from} の入口: 形式検証の依頼 ${f.rid} の結果が W にありません。doc_check formal-import を実行してから、同じ next_args で呼び直す（SKILL.md「## 中継」）`, from)
  if (st.tree_digest_now !== st.tree_digest_request) {
    return blocked(`段 ${from} の入口: 文書の木（${st.tree_digest_now}）が、形式検証の依頼 ${f.rid} を作ったときの木（${st.tree_digest_request}）と違います（依頼の後に所有表の外で文書が書き換わった）。S0 からやり直してください`, null)
  }
  entryFormal = st
  state.formal = { rid: f.rid, ok: 1 }
  // 段に入った時点の state にも入れる（この段の再実行は、同じ rid を入口で照らし直して差し戻しからやり直す）。
  entryState.formal = state.formal
  state.notices = [...(state.notices || []), formalEntryNotice(f.rid, st.outcome)]
  return null
}

async function enterFromDisk(from) {
  const label = `flow-check:${from}-entry`
  const restoring = restorePending ? RESUME_TX.restore : null
  const restore = restoring ? `最初に実行する: \`${cli('restore', `--token ${restoring}`)}\`。stdout を加工せずに restore_check に入れる。続けて ` : ''
  // 回答を当てる段（3a・3a'）の入口は、flow の後に回答のファイルも確かめる（answersUnchecked がこの stdout を使い、単独の answers を起動しない）。
  const answering = ['3a', "3a'"].includes(from) && pendingQuestions(state).length > 0
  const answersCmd = answering ? cli('answers', `--file ${gateAnswers(state.gate)} --ids ${pendingQuestions(state).join(',')}`) : null
  // 段 5・8 の入口は、形式検証の依頼の取り込みも照らす（formalEntryRid。照らした値は entryFormal）。
  const formalRidAt = formalEntryRid(from)
  const statusCmd = formalRidAt ? cli('formal-status', `--rid ${formalRidAt}`) : null
  const flowLine = answering
    ? `${restore}実行する: \`${RULINGS_FLOW}\`。stdout を加工せずに flow_check に入れる。続けて実行する: \`${answersCmd}\`。stdout を加工せずに answers_check に入れる。すべて返す。`
    : statusCmd
      ? `${restore}実行する: \`${RULINGS_FLOW}\`。stdout を加工せずに flow_check に入れる。続けて実行する: \`${statusCmd}\`。stdout を加工せずに formal_status に入れる。すべて返す。`
      : `${restore}実行する: \`${RULINGS_FLOW}\`。stdout を加工せずに flow_check に入れて返す。`
  const entryCmds = { ...(answering ? { answers_check: answersCmd } : {}), ...(statusCmd ? { formal_status: statusCmd } : {}) }
  const x = await once(label, 'flowCheck', [header('flowCheck', from, label), flowLine].join('\n\n'), FLOW_CHECK_SCHEMA, PHASE_OF[from], Object.keys(entryCmds).length ? entryCmds : undefined)
  if (restoring) {
    const re = restored(from, x)
    if (re) return re
  }
  // 段 4・7 の再実行の入口: 戻した後の本文が段の入口の本文と違えば、戻らない本文の上で検証も改稿も回さない（references/workflow-io.md §3）。
  if (restoring && ['4', '7'].includes(from)) {
    const rc = parseStdout(x.restore_check)
    if (!docsShaped(rc)) return blocked(`flow-check（段 ${from} の入口）の doc_check restore の stdout に、戻した後の文書の digest がありません`, from)
    const m = docsMoved(from, rc)
    if (m && m.bornOnly) return blocked(`段 4 の入口: restore の後の文書が${m.text}。止まった run の writer が控えの前に新しい文書を書いたので、同じ段からでは消えない。段 1 の入口の reset が消すので段 1 からやり直す`, '1')
    if (m) return blocked(`段 ${from} の入口: restore の後の文書が${m.text}。止まった run の writer が控えの前に本文を書いたので、同じ段から再実行しても段の入口の本文に戻らない（reset は既存の文書の本文を残す）。S0 からやり直す（existing_docs の文書を doc_check place で置き直す）`, null)
  }
  if (statusCmd) {
    const blockedBy = formalEntry(from, x.formal_status)
    if (blockedBy) return blockedBy
  }
  if (answering) entryAnswers = { gate: state.gate, ids: uniq(pendingQuestions(state)), text: x.answers_check }
  const fc = x && flowCheckOf(x.flow_check, true)
  if (!fc) return blocked(`flow-check（段 ${from} の入口）が doc_check flow の stdout を返しませんでした`, from)
  if (fc.content_sha256 !== state.flow_digest) {
    const line = `段 ${from} の入口の flow.json（${fc.content_sha256}）が、next_args の版（${state.flow_digest}）と違う（所有表の外の書き込み。検証を通っていない要素は段に入る前に検証する）`
    noteIntegrity(line)
    state.flow_digest = fc.content_sha256
    // 入口で採った版と integrity の行は段に入った時点の state に入れる（検証の合否は入れない: 再実行の restore が戻す）。入れないと、
    // この段の再実行の next_args が古い版を運び、再実行の入口が同じ食い違いをもう一度数える。
    entryState.flow_digest = state.flow_digest
    entryState.integrity = uniq([...(entryState.integrity || []), line])
  }
  see(fc)
  const left = await verifyLeft(from, 'entry', fc, PHASE_OF[from], Boolean(ASKS[from] && ASKS[from]()))
  if (left.error) return blocked(left.error, left.rerun === false ? null : from)
  // REFLECT_STAGE の入口の渡せる不合格の要素（reflectable）は 3a が渡した反映で、段の最初の flow-framer が引き受ける。
  const open = failedOpen(left.fc, state, true).filter((el) => !(from === REFLECT_STAGE && reflectable(el)))
  if (open.length) return blocked(`段 ${from} の入口の flow に不合格の要素 ${list(open)} があります（所有表の外の書き込み。${W}/verifications.json）`, null)
  if (from === REFLECT_STAGE) reflectFc = left.fc
  return null
}

let next = FROM
let outcome = null
while (outcome === null) {
  // 段の境界で止めるので、next_args は次の段から始める（その段の token を決める前。段を出た run の台帳は戻さない）。
  if (budgetOut()) {
    outcome = finish('blocked', { reason: `token の目標（budget.total）に達したので、段 ${next} を始めません。目標を上げて段 ${next} から続ける（呼び直し方は SKILL.md「## 中継」）`, stop_reason: 'budget', next_args: nextArgs(next) })
    break
  }
  const resuming = RESUME_TX && running === null
  if (!resuming) restorePending = false
  txTry = resuming ? RESUME_TX.try : 0
  state.tx = resuming ? { seq: RESUME_TX.seq, stage: next } : { seq: ((state.tx || {}).seq || 0) + 1, stage: next }
  running = next
  holdOrders = { ids: new Set(), abouts: new Set() }
  gatePassed = null
  entryState = JSON.parse(JSON.stringify(state))
  let r
  try {
    phase(PHASE_OF[next])
    r = next !== FROM || !ENTRY_CHECK ? null : await enterFromDisk(FROM)
    if (!r) r = await STAGE_FNS[next]()
  } catch (e) {
    if (scriptDefect) r = null
    else if (e && e.budgetStop) r = blocked(e.message, running, { stop_reason: 'budget' })
    else if (e && e.rerunStage) r = blocked(e.message, running)
    else throw e
  }
  // 不変条件の違反は script の欠陥で、同じ段からやり直しても同じ所で破るので next_args を付けない。
  if (scriptDefect) r = blocked(`script の不変条件に反しました（段 ${running}）: ${scriptDefect}`, null)
  const violation = r.status === 'blocked' ? null : exitViolation(running, r)
  if (violation) r = blocked(`script の不変条件に反しました（段 ${running}）: ${violation}`, null)
  const drift = r.status === 'blocked' ? null : questionsDrift()
  if (drift) r = blocked(`段 ${running}: ${drift}`, running)
  const unasked = r.status === 'blocked' || !seen ? [] : newHoldsInW(seen)
  if (unasked.length) r = blocked(`段 ${running}: 依頼者に聞ける段で、script が hold を指定していない ${list(unasked)} を持ったまま段を出ようとしました`, running)
  if (typeof r === 'string') next = r
  else outcome = r
}
return outcome
