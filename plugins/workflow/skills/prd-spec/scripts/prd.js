export const meta = {
  name: 'prd-spec',
  description: '依頼を仕分けて流れを閉じ、前提を裁定してから要求・仕様を書き、監査と範囲を絞った再監査を上限 2 パスで回す',
  whenToUse: 'prd-spec の SKILL.md から、workspace を作ったあとに呼ぶ。needs_answers で止まったら回答を answers に逐語で書き、next_args をそのまま渡して再実行する。args に打ち直す値は ID・件数・digest に限る（本文や JSON の本体は W に置く）',
  phases: [
    { title: 'Intake', detail: '段 1: 依頼を確定・決定・未決に仕分け、分割と writer の単位を決める' },
    { title: 'Flow', detail: '段 2: 出典付きの流れを描き、閉包を検査する' },
    { title: 'Resolve', detail: '段 3・3v: 未決と組を裁定し、独立に検証する（差し戻しは 1 回）' },
    { title: 'Answers', detail: '段 3a・3b・3a\': 依頼者の回答を流れと裁定に当て、G0 の後は回答で flow を組み直す' },
    { title: 'Draft', detail: '段 4: writer の単位ごとに初稿を書く（依存の向きに順番、独立な単位は並列）' },
    { title: 'Audit', detail: '段 5: implementer・grounding を文書ごと、cross-doc を全文書で 1 回当てる' },
    { title: 'Decide', detail: '段 6: 決定が要る指摘と新しい TBD を裁定する' },
    { title: 'Revise', detail: '段 7・8: 改稿し、変えた範囲だけを監査する（上限 2 パス）' },
    { title: 'Report', detail: '段 9: 上限で止まったときは残った論点を保持規則にする（事後報告は司令塔が doc_check report で導出する）' },
  ],
}

// 段の順序・起動の条件・上限・返り値の検査と引き継ぎだけを持つ（schemas/role-map.md の prd.js の行）。
// ファイルは読めないので、分岐に使う値はすべて agent の返り値から受け取り、next_args の state に載せる。
// state に載せるのは ID・件数・digest だけにする（why は references/workflow-io.md §1）。
// state は plain JSON に限る。Map・Set・class を pipeline / parallel の境界や返り値に載せると、runtime で
// 中身が失われる（実測: `.get is not a function` で落ちた）。

// ROLE_OPTS: 全役に既定を置く。省略するとセッションの設定を継承し、全呼び出しが最重量で走って利用上限に
// 達した実測がある。司令塔は args.role_opts で上書きできる。
const ROLE_OPTS = {
  intake: { model: 'opus', effort: 'medium' },
  flowFramer: { model: 'opus', effort: 'medium' },
  resolver: { model: 'opus', effort: 'medium' },
  verifier: { model: 'opus', effort: 'medium' },
  writer: { model: 'opus', effort: 'medium' },
  implementer: { model: 'opus', effort: 'high' },
  grounding: { model: 'opus', effort: 'high' },
  crossDoc: { model: 'sonnet', effort: 'medium' },
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
}

const CONTRACT_SECTIONS = {
  intake: ['§intake', '決定の台帳', '現物と既存実装の扱い'],
  flowFramer: ['§flow-framer'],
  resolver: ['§resolver', '決定の台帳', '現物と既存実装の扱い'],
  verifier: ['§resolver-verifier', '決定の台帳', '現物と既存実装の扱い'],
  writer: ['§writer', '現物と既存実装の扱い'],
  implementer: ['監査役の共通節', '§implementer'],
  grounding: ['監査役の共通節', '§grounding', '現物と既存実装の扱い'],
  crossDoc: ['監査役の共通節', '§cross-doc'],
}

// COMMON_SECTIONS: 全役が役の節より前に読む節。書き込みの規則（put だけで書く・その場で更新する・tmp の所有）は
// ここにだけ置く。役の節に写すと、写しの無い役に規則が届かない（実測: 版コピーの禁止が writer.md にだけあった）。
const COMMON_SECTIONS = ['共通の約束', 'W のファイルと書き手']

// MAX_PASSES: 段 6 → 7 → 8 を回す上限（設計書 §1 の 8'）。2 パス目でも blocking が残れば blocked で止まる。
// 回数で切るのは、2 パス目の後には問いを聞くゲートも改稿の枠も残っていないからである。
const MAX_PASSES = 2

// CHECK_REWORK: 生成者が返した doc_check の stdout（flow の指摘・問いの形の検査）が不合格のとき、差し戻す回数。生成者は自分の内部で doc_check を回してから
// 返すので、ここでの 1 回は「返した doc_check の stdout が不合格だった」ときの差し戻しに限る。
const CHECK_REWORK = 1

const ENTRIES = ['new', 'existing', 'expand']
const STAGES = ['1', '2', '3', '3a', '3b', '4', '5', '6', "3a'", '7', '8', '9']
const GATE_ANSWERS = { g0: 'answers/g0.md', 'g0-2': 'answers/g0-2.md', g1: 'answers/g1.md' }

// ---------------------------------------------------------------- 純粋関数（tests が抽出して呼ぶ）
// PURE_BEGIN

const MODELS = ['haiku', 'sonnet', 'opus']
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']

// DIRECTIONS・ORIGINS: 契約の direction・origin の表と同じ集合（tests が照合する）。enum が無いと表の外の値が黙って通る。
const DIRECTIONS = ['relax', 'tighten', 'make_measurable', 'choose_one', 'merge_or_split', 'align_terms', 'add_trace', 'remove', 'document_decision']
const ORIGINS = ['input', 'flow', 'ledger', 'text']
const OPPOSITE = { tighten: 'relax', relax: 'tighten' }

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

const uniq = (xs) => [...new Set((xs || []).filter((x) => x !== undefined && x !== null && x !== ''))].sort()
const minus = (xs, ys) => {
  const drop = new Set(ys || [])
  return uniq(xs).filter((x) => !drop.has(x))
}

// aboutKey: resolution の about（{open} / {pair:[a,b]} / {finding} / {tbd} / {verification}）を 1 本の文字列にする。
// 閉じた論点の集合をこの形で state に持つ（Set は state に載せられないので、配列と文字列で表す）。
function aboutKey(about) {
  if (!about || typeof about !== 'object') return null
  if (Array.isArray(about.pair) && about.pair.length === 2) return `pair:${[...about.pair].map(String).sort().join('|')}`
  for (const k of ['open', 'finding', 'tbd', 'verification']) if (about[k]) return `${k}:${about[k]}`
  return null
}

// resolverIds: resolver の返り値に現れた resolution の ID と、その about の対応。
function resolverIds(r) {
  const items = [...(r.ruled || []), ...(r.questions || []), ...(r.holds || [])].filter((x) => x && x.id)
  const about = {}
  for (const x of items) about[x.id] = aboutKey(x.about)
  return { ids: uniq(items.map((x) => x.id)), about }
}

// missedTargets: 渡した対象（about の文字列）のうち、返り値のどの about にも現れないもの。裁定漏れとして数える。
function missedTargets(targets, r) {
  const seen = new Set(Object.values(resolverIds(r).about).filter(Boolean))
  return uniq(targets).filter((t) => !seen.has(t))
}

// closedKeys: 決定台帳に入った（合格した・回答で決まった・保持規則になった）resolution の about の集合。
// 開いている TBD と、裁定済みの論点の算出に使う。
function closedKeys(state) {
  const settled = new Set([...(state.passed || []), ...(state.answered || []), ...(state.holds || [])])
  return uniq(Object.entries(state.about || {}).filter(([id, k]) => k && settled.has(id)).map(([, k]) => k))
}

// settledOpenIds: 合格か回答で値が決まった open の ID。hold と回答待ちの問いは、verifier に合格していても入れない
// （保持規則の output も、回答を待つ output も、未決のまま残るのが正しい）。
function settledOpenIds(state) {
  const settled = new Set(settledIds(state))
  return uniq(Object.entries(state.about || {}).filter(([id, k]) => k && k.startsWith('open:') && settled.has(id)).map(([, k]) => k.slice(5)))
}

function settledIds(state) {
  return minus(usableResolutions(state), [...(state.holds || []), ...pendingQuestions(state)])
}

// settledTerminals: doc_check flow の open_only（出典が {open} だけの要素と O- の組）のうち、O- が裁定で閉じた組。
function settledTerminals(openOnly, state) {
  const settled = new Set(settledOpenIds(state))
  return (openOnly || []).filter((x) => x && settled.has(x.open))
}

// openTbdOf: writer が申告した開いている TBD から、裁定で閉じたものを除く。
function openTbdOf(state) {
  const closed = new Set(closedKeys(state).filter((k) => k.startsWith('tbd:')).map((k) => k.slice(4)))
  return uniq(state.open_tbd || []).filter((id) => !closed.has(id))
}

// usableResolutions: writer と監査役が根拠にしてよい resolution。verifier が合格させたものと、候補の選択で
// 回答が当たったもの（その候補は段 3 の検証を通っている）。保持規則は別に渡す（規範文として書くもの）。
function usableResolutions(state) {
  return minus(uniq([...(state.passed || []), ...(state.answered || [])]).filter((id) => /^RS-/.test(id)), state.failed_ids || [])
}

// invalidIds: writer と監査役に「根拠にしない」と渡す ID。supersedes で覆された決定に加え、verifier に落ちたまま
// 合格していない intake の既定（D-）と、出典が検証に落ちた流れの要素（F-）。落ちた既定が差し戻しで問いや保持規則に
// 変わり supersedes されなかったとき、これを渡さないと、検証を通っていない決定が有効な根拠として writer に届く。
function invalidIds(state) {
  const failed = minus(state.failed_ids || [], state.passed || [])
  return {
    decisions: uniq([...(state.superseded || []), ...failed.filter((id) => /^D-/.test(id))]),
    flow: failed.filter((id) => /^F-/.test(id)),
  }
}

// pendingQuestions: 依頼者にまだ聞いていない、または回答が当たっていない問い。
function pendingQuestions(state) {
  return minus(state.questions || [], [...(state.answered || []), ...(state.holds || [])])
}

// unitWaves: writer の単位を依存の向きに並べ、同じ波の単位は並列に書く。循環と未知の依存は止める
// （黙って並列にすると、依存する文書を互いの記述を知らないまま書き、矛盾を作る）。
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

// docUnit: 文書キーから、その文書を持つ単位の ID。
function docUnit(units, doc) {
  const u = (units || []).find((x) => (x.docs || []).includes(doc))
  return u ? u.id : null
}

// partitionFindings: 監査の指摘を route で分ける。writer の指摘は項目 ID ごとに束ねて writer へ直接渡し
// （段 6 が起動しなくても届く）、decision の指摘は resolver に渡す。
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

// reversedFindings: 前のパスの同じ文書・項目への指摘と逆の direction を持つ指摘の ID。writer に回すと、片側を直すたびに
// 他方を壊す（A3 の実例: r2 の tighten と r3 の relax）。
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

// settledFlowFindings: origin が flow の指摘のうち、before（cycle に入った時点で決まっていた resolution）の後に合格か回答で
// 裁定が決まったもの。resolver は flow.json を書かないので、裁定を flow に写すのは settle である。before で引かないと、
// 同じ pending を持つ次の cycle（G1 の後の 3a'）で同じ指摘を写し直す。
function settledFlowFindings(pendingFindings, state, before) {
  const done = new Set(before || [])
  const settled = new Set(settledIds(state).filter((id) => !done.has(id)))
  const closed = new Set(Object.entries(state.about || {}).filter(([id, k]) => k && k.startsWith('finding:') && settled.has(id)).map(([, k]) => k.slice(8)))
  return uniq((pendingFindings || []).filter((f) => f && f.origin === 'flow' && closed.has(f.id)).map((f) => f.id))
}

// rolesByItem: 項目ごとに、指摘を出した観点の一覧。範囲を絞った監査で、その項目にどの観点を当て直すかを決める。
function rolesByItem(history, findings, role) {
  const out = JSON.parse(JSON.stringify(history || {}))
  for (const f of findings || []) {
    if (!f || !f.item_id) continue
    out[f.item_id] = uniq([...(out[f.item_id] || []), role])
  }
  return out
}

// scopedAuditPlan: 段 8 の監査の起動表。変えた項目がある文書だけに起動する。grounding は新しく入った規範文を
// 見るので変えた文書すべてに、implementer と cross-doc はその観点が指摘を出した項目が変わったときだけ起動する。
// 最初の grounding を指名する（改稿の後は必ず 1 体以上起動するので、木全体の diff の照合は飛ばない）。
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

// undeclaredChanges: 木全体の diff に現れたのに、writer が申告しなかった項目キー。生成した側だけに検証の範囲を
// 決めさせないため、この項目には監査を追加で起動する。
function undeclaredChanges(diff, declared) {
  const all = uniq([...((diff && diff.changed) || []), ...((diff && diff.added) || []), ...((diff && diff.removed) || [])])
  return minus(all, declared)
}

// undeclaredByDoc: 申告に無い変更を、変更の起きた文書ごとに返す（{doc: [項目キー]}）。監査は文書単位で起動するので、
// 木全体の集合だけでは、何も申告しなかった単位の文書に監査が届かない。diff の by_doc を読み、各文書の変更から
// その文書の申告（changes[doc]）を引く。by_doc が無いときは、木全体の申告漏れを改稿の対象になった全文書に当てる。
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

// parseStdout: 指名された監査役が加工せずに返した doc_check の stdout（1 行の JSON）を読む。
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

// flowCheckOf: doc_check flow の stdout。件数と flow.json の内容の sha256 が読めないものは null（不合格として扱う）。
function flowCheckOf(text) {
  const o = parseStdout(text)
  const ok = o && Number.isInteger(o.findings) && Number.isInteger(o.open) && typeof o.content_sha256 === 'string' && o.content_sha256
  return ok && Array.isArray(o.unverified) && Array.isArray(o.open_only) && Array.isArray(o.open_ids) ? o : null
}

// conflictsCheckOf: doc_check conflicts の stdout。組の件数と、about と同じ形の組のキーが読めないものは null。
function conflictsCheckOf(text) {
  const o = parseStdout(text)
  return o && Number.isInteger(o.pairs) && Array.isArray(o.pair_keys) ? o : null
}

// questionsCheckFailure: doc_check questions --check の stdout が、問いにした ID を全部検査して不合格 0 件なら null。
// 検査した ID まで照合するのは、別の ID の集合で通した stdout を合格として受け取らないため。
function questionsCheckFailure(text, ids) {
  const o = parseStdout(text)
  if (!o || o.check !== true || !Array.isArray(o.ids) || !Number.isInteger(o.findings)) return 'doc_check questions --check の stdout がありません'
  const unchecked = minus(ids, o.ids)
  if (unchecked.length) return `検査していない問いがあります: ${unchecked.join(', ')}`
  if (o.findings > 0) return `形の不合格が ${o.findings} 件あります`
  return null
}

// REQUIRES: from の入口ごとに、state に要る値。script はファイルを読めないので、ここに無ければ再開できない。
const REQUIRES = {
  1: [],
  2: ['units'],
  3: ['units', 'counts', 'flow_digest'],
  '3a': ['units', 'flow_digest', 'gate', 'questions'],
  '3b': ['units', 'flow_digest', 'gate', 'questions'],
  4: ['units', 'flow_digest'],
  5: ['units', 'flow_digest'],
  6: ['units', 'flow_digest', 'audit', 'pending', 'pass'],
  "3a'": ['units', 'flow_digest', 'audit', 'pending', 'pass', 'gate', 'questions'],
  7: ['units', 'flow_digest', 'audit', 'pending', 'pass'],
  8: ['units', 'flow_digest', 'audit', 'pending', 'pass', 'revised'],
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

// ---------------------------------------------------------------- 返り値のスキーマ（受け取った時点で検査する）

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
    decisions: INT,
    open: INT,
    decisions_sha256: STR,
    units: {
      type: 'array',
      minItems: 1,
      items: { type: 'object', properties: { id: STR, docs: { type: 'array', items: STR, minItems: 1 }, depends_on: STRS }, required: ['id', 'docs', 'depends_on'] },
    },
  },
  required: ['decisions', 'open', 'decisions_sha256', 'units'],
}

const FLOW_SCHEMA = {
  type: 'object',
  properties: { flow_check: STR, conflicts_check: STR, questions_check: STR },
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
    sha256: STR,
    flow_check: STR,
    conflicts_check: STR,
    questions_check: STR,
  },
  required: ['ruled', 'questions', 'holds', 'supersedes', 'free_text', 'routes', 'sha256', 'flow_check'],
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
    decisions_sha256: STR,
    flow_check: STR,
  },
  required: ['pass', 'fail', 'resolutions_sha256', 'decisions_sha256', 'flow_check'],
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

// ---------------------------------------------------------------- 入口

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
const OPTS = applyRoleOverrides(ROLE_OPTS, input.role_opts)
const state = JSON.parse(JSON.stringify(input.state || {}))
const startErrors = stateErrors(FROM, state)
if (startErrors.length) throw new Error(`再開に要る値が args.state にありません: ${startErrors.join(' / ')}`)

const BASE_ARGS = { workspace: W, skillDir: SKILL_DIR, entry: ENTRY, existing_docs: EXISTING, role_opts: input.role_opts || {} }
const argsFrom = (from, st) => ({ ...BASE_ARGS, from, state: JSON.parse(JSON.stringify(st)) })
const nextArgs = (from) => argsFrom(from, state)

// running・entryState: いま走っている段と、その段に入った時点の state。
let running = null
let entryState = null

function finish(status, extra) {
  return {
    status,
    questions_path: null,
    report_path: null,
    next_args: null,
    open_tbd: openTbdOf(state),
    holds: uniq(state.holds || []),
    missed: uniq(state.missed || []),
    integrity: state.integrity || [],
    notices: state.notices || [],
    undeclared: state.undeclared || {},
    ...extra,
  }
}
// blocked で同じ段からやり直させるときは、その段に入った時点の state を渡す。段の途中で足した値（候補の選択で当たった
// 回答・形の検査に落ちた問い・integrity の行）を持ち越すと、再実行が止まらなかった run と違う状態から始まる。
const blocked = (reason, rerunFrom, extra) =>
  finish('blocked', { reason, next_args: rerunFrom ? argsFrom(rerunFrom, rerunFrom === running ? entryState : state) : null, ...extra })

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
  ].join('\n')
}

const list = (xs) => (xs && xs.length ? xs.join(', ') : '（なし）')

function groundsBlock() {
  return [
    '根拠一式（パス）:',
    `- ${W}/input.md、${W}/answers/*.md、${W}/decisions.json、${W}/resolutions.json、${W}/flow.json、${W}/plan.json`,
    `- 根拠にしてよい resolution（合格・回答済み）: ${list(minus(usableResolutions(state), pendingQuestions(state)))}`,
    `- 保持規則として規範文で書く resolution（hold）: ${list(uniq(state.holds))}`,
    `- 無効な決定（覆された・検証に落ちた。根拠にしない）: ${list(invalidIds(state).decisions)}`,
    `- 出典が検証に落ちた流れの要素（この要素を根拠に規範を書かない）: ${list(invalidIds(state).flow)}`,
    `- 開いている TBD: ${list(openTbdOf(state))}`,
  ].join('\n')
}

function existingNote() {
  if (ENTRY === 'new') return ''
  const rows = EXISTING.map((d) => `- ${d.key}${d.fixed ? '（fixed: 固定の入力。書き換えない）' : ''}`)
  return ['既存文書（W に置いてある。topic を維持する）:', ...rows].join('\n')
}

const cli = (mode, rest) => `node ${SKILL_DIR}/scripts/doc_check.mjs ${mode} --workspace ${W}${rest ? ` ${rest}` : ''}`

async function once(label, role, prompt, schema, phaseTitle) {
  const [r] = await runWithRetry(label, [label], (_, attempt) => agent(prompt, { ...OPTS[role], schema, phase: phaseTitle, label: attempt > 1 ? `${label}#retry` : label }), (x) => Boolean(x))
  return r || null
}

// ---------------------------------------------------------------- 裁定の台帳（resolver と verifier の返り値の取り込み）

// reRuled: 回答を当てる呼び出しでない resolver が ruled に入れた問いは、問いでなくなった（3b で組み直した flow から決まった）。
// 3a・3a' の ruled は回答が当たった問いなので、ここでは引かない。
function absorbResolver(r, reRuled) {
  const { ids, about } = resolverIds(r)
  state.about = { ...(state.about || {}), ...about }
  state.known = uniq([...(state.known || []), ...ids])
  state.questions = minus(uniq([...(state.questions || []), ...(r.questions || []).map((x) => x.id)]), reRuled ? (r.ruled || []).map((x) => x.id) : [])
  state.holds = uniq([...(state.holds || []), ...(r.holds || []).map((x) => x.id)])
  state.superseded = uniq([...(state.superseded || []), ...(r.supersedes || [])])
  const seenRoutes = new Set((state.routes || []).map((x) => `${x.unit}|${x.id}`))
  state.routes = [...(state.routes || []), ...(r.routes || []).filter((x) => !seenRoutes.has(`${x.unit}|${x.id}`)).map((x) => ({ unit: x.unit, id: x.id }))]
  if (r.sha256) state.resolutions_sha256 = r.sha256
  return ids
}

// absorbVerifier: 合否を取り込む前に、verifier が自分で実行した doc_check flow を照合する。違う flow を見た合否を
// 台帳の集合に入れると、検証していない版の合格が残る。照合に落ちたら { error, rerun } を返す（null なら取り込んだ）。
// flow の食い違いを同じ段のやり直しで直せるのは、この段の生成者が flow の stdout を返した（flowChecked）ときだけである。
// そうでない段（例: resolver が起動しない段 3）でやり直しても、flow.json も state.flow_digest も変わらず同じ所で止まる。
function absorbVerifier(v, expectedSha, stage, flowChecked) {
  const fc = flowCheckOf(v.flow_check)
  if (!fc) return { error: `resolver-verifier（段 ${stage}）が doc_check flow の stdout を返しませんでした`, rerun: true }
  const noFixer = flowChecked ? '' : '。この段には flow を書く生成者がいないので、同じ段からやり直しても直らない。所有表の外で flow.json を書いたものを確かめる'
  if (fc.content_sha256 !== state.flow_digest) {
    noteIntegrity(`verifier（段 ${stage}）が検査した flow.json（${fc.content_sha256}）が、生成者が検査した版（${state.flow_digest}）と違う`)
    return { error: `段 ${stage}: verifier が検査した flow.json が、生成者が doc_check flow で検査した版と違います${noFixer}`, rerun: flowChecked }
  }
  if (fc.findings !== 0) return { error: `段 ${stage}: verifier の doc_check flow に指摘が ${fc.findings} 件あります（${W}/checks/flow.json）${noFixer}`, rerun: flowChecked }
  const failIds = (v.fail || []).map((f) => f.id)
  state.passed = minus(uniq([...(state.passed || []), ...(v.pass || [])]), failIds)
  state.failed_ids = minus(uniq([...(state.failed_ids || []), ...failIds]), v.pass || [])
  if (expectedSha && v.resolutions_sha256 !== expectedSha) {
    noteIntegrity(`verifier が検証した resolutions.json（${v.resolutions_sha256}）が、resolver が書き終えた版（${expectedSha}）と違う`)
  }
  return null
}

// resolverPrompt / verifierPrompt: 段ごとの対象はプロンプトで指定する（ID の一覧だけ。中身は W から読む）。
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

// flowExtra: flow を変えた呼び出しの後、検証を通った版から変わった要素（unverified）の出典を verifier に回す。検証に落ちた
// 要素（保持規則に変換済み）は、pass が無いので unverified に残り続ける。渡すたびに落ちて差し戻しと変換が回るので除く
// （その要素は invalidIds で「根拠にしない」と writer に渡っている）。must は、それでも必ず検証させる要素。
const toVerify = (unverified, must) => uniq([...minus(unverified || [], invalidIds(state).flow), ...(must || [])])
const flowExtra = (unverified, must) => {
  const ids = toVerify(unverified, must)
  return ids.length ? `あわせて検証する: flow.json の要素 ${list(ids)} の source（decision は各 case の source も）。これらの F- も pass / fail に入れる。` : ''
}

// flowKept: keepFlow の呼び出しが flow.json を変えていなければ null。変えていたら同じ段をやり直しても元に戻らないので、
// rerun を付けない。
function flowKept(stage, ret) {
  const fc = flowCheckOf(ret.flow_check)
  if (!fc) return { error: `resolver（段 ${stage}）が doc_check flow の stdout を返しませんでした`, rerun: true }
  if (fc.content_sha256 === state.flow_digest) return null
  noteIntegrity(`resolver（段 ${stage}）の後の flow.json（${fc.content_sha256}）が、検証を通った版（${state.flow_digest}）と違う`)
  return { error: `段 ${stage}: flow.json を書く権限の無い resolver の呼び出しの後で flow.json が変わっています。所有表の外で flow.json を書いたものを確かめる`, rerun: false }
}

function verifierPrompt(label, stage, ids, extra) {
  return [
    header('verifier', stage, label),
    `検証する resolution の ID: ${list(ids)}`,
    extra || '',
    '合格は pass に、不合格は fail に入れる。書き直さない。',
    `検証の最後に \`${cli('flow')}\` を実行し、stdout を加工せずに flow_check に入れる（script が生成者の実行した stdout と照合する）。`,
  ]
    .filter(Boolean)
    .join('\n\n')
}

// resolveCycle: resolver → verifier → 不合格の差し戻し 1 回 → 再検証。それでも不合格なら理由で分ける:
// 価値の判断を方法論として決めた（value_as_method）か、cycle の入口で問いだった → 問い（聞けないときは保持規則）、それ以外 → 保持規則。
// 変換した分はもう検証しない（検証のループを増やすと、差し戻しの上限が意味を失う）。
// resolver が doc_check flow の stdout を返したら、検証する ID が無くても verifier を起動する。flow の閉包は、生成者の
// stdout と別の agent の stdout の照合でしか script から確かめられない。
// 最後の verifier の後に、裁定で閉じた O- だけを出典に持つ要素と、origin が flow の指摘の裁定を flow-framer に写させる
// （settle）。どの段でも同じにする。
async function resolveCycle(stage, opt) {
  const before = settledIds(state)
  const res = await ruleAndVerify(stage, opt)
  if (res.error) return res
  // 自由記述の回答は、対応づけが verifier に合格して初めて回答が当たったことになる。
  if (opt.answered) state.answered = uniq([...(state.answered || []), ...opt.answered.filter((id) => (res.passed || []).includes(id))])
  if (!res.lastFlow) return res
  const se = await settle(stage, res.lastFlow, opt.phase, before, opt.allowQuestions)
  return se || res
}

const takeFlow = async (stage, r, phaseTitle, writesFlow, required) => (writesFlow ? applyReturnedFlow(stage, r, phaseTitle, required) : flowKept(stage, r) || { checked: false })

async function ruleAndVerify(stage, opt) {
  const phaseTitle = opt.phase
  const writesFlow = Boolean(opt.answered)
  const asTask = (t) => (writesFlow ? t : keepFlow(t, '裁定を flow に写すのは flow-framer である'))
  const wasQuestion = new Set(pendingQuestions(state))
  let ids = []
  let flowChecked = Boolean(opt.flowChanged)
  let unverified = []
  if (opt.task) {
    const label = `resolver:${stage}`
    const r = await once(label, 'resolver', resolverPrompt(label, stage, asTask(opt.task)), RESOLVER_SCHEMA, phaseTitle)
    if (!r) return { error: `resolver（段 ${stage}）が応答しませんでした` }
    ids = absorbResolver(r, !writesFlow)
    if (opt.targets) state.missed = uniq([...(state.missed || []), ...missedTargets(opt.targets, r)])
    const fe = await takeFlow(stage, r, phaseTitle, writesFlow, Boolean(opt.requireFlow))
    if (fe.error) return fe
    flowChecked = flowChecked || fe.checked
    const qe = await checkQuestions(stage, r, phaseTitle, opt.recheck)
    if (qe) return qe
    if (opt.answered) {
      const free = new Set(r.free_text || [])
      const byOption = (r.ruled || []).map((x) => x.id).filter((id) => opt.answered.includes(id) && !free.has(id))
      state.answered = uniq([...(state.answered || []), ...byOption])
      ids = minus(ids, byOption)
    }
    if (fe.changed) {
      const pe = await recheckPairs(stage, fe.conflicts, phaseTitle, opt.allowQuestions)
      if (pe.error) return pe
      ids = uniq([...ids, ...pe.ids])
      unverified = fe.unverified
    }
  }
  if (!ids.length && !opt.verifyExtra && !flowChecked) return { ok: true, passed: [] }
  const v1Label = `verifier:${stage}v`
  const extra1 = [opt.verifyExtra, flowExtra(unverified)].filter(Boolean).join('\n\n')
  const v1 = await once(v1Label, 'verifier', verifierPrompt(v1Label, `${stage}v`, ids, extra1), VERIFIER_SCHEMA, phaseTitle)
  if (!v1) return { error: `resolver-verifier（段 ${stage}v）が応答しませんでした` }
  const ve1 = absorbVerifier(v1, state.resolutions_sha256, `${stage}v`, flowChecked)
  if (ve1) return ve1
  let lastFlow = flowCheckOf(v1.flow_check)
  if (!v1.fail.length) return { ok: true, passed: v1.pass, lastFlow }

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
  let ids2 = absorbResolver(r2, !writesFlow)
  const fe2 = await takeFlow(`${stage}'`, r2, phaseTitle, writesFlow, false)
  if (fe2.error) return fe2
  flowChecked = flowChecked || fe2.checked
  const qe2 = await checkQuestions(stage, r2, phaseTitle)
  if (qe2) return qe2
  if (fe2.changed) {
    const pe2 = await recheckPairs(stage, fe2.conflicts, phaseTitle, opt.allowQuestions)
    if (pe2.error) return pe2
    ids2 = uniq([...ids2, ...pe2.ids])
  }
  const v2Label = `verifier:${stage}v'`
  const v2 = await once(v2Label, 'verifier', verifierPrompt(v2Label, `${stage}v'`, ids2, fe2.changed ? flowExtra(fe2.unverified) : ''), VERIFIER_SCHEMA, phaseTitle)
  if (!v2) return { error: `resolver-verifier（段 ${stage}v' の再検証）が応答しませんでした` }
  const ve2 = absorbVerifier(v2, state.resolutions_sha256, `${stage}v'`, flowChecked)
  if (ve2) return ve2
  lastFlow = flowCheckOf(v2.flow_check)
  const passed = uniq([...minus(v1.pass, v2.fail.map((f) => f.id)), ...v2.pass])
  if (!v2.fail.length) return { ok: true, passed, lastFlow }

  const convert = v2.fail
    .map((f) => `- ${f.id} → ${(f.kind === 'value_as_method' || wasQuestion.has(f.id)) && opt.allowQuestions ? 'question' : 'hold'}（${f.kind}）`)
    .join('\n')
  log(`段 ${stage}: 差し戻し後も ${v2.fail.length} 件が不合格。理由で問いと保持規則に分けます（検証はもう回しません）`)
  const r3Label = `resolver:${stage}-convert`
  const r3 = await once(
    r3Label,
    'resolver',
    resolverPrompt(r3Label, `${stage}（変換）`, keepFlow(`次の項目は差し戻し後も不合格だった。値を決めずに、指定のとおり question（候補と影響を付ける）か hold（保持規則と Issue の文案）に書き換える。ID は変えない。\n${convert}`)),
    RESOLVER_SCHEMA,
    phaseTitle
  )
  if (!r3) return { error: `resolver（段 ${stage} の変換）が応答しませんでした` }
  absorbResolver(r3)
  const ke3 = flowKept(`${stage}-convert`, r3)
  if (ke3) return ke3
  const qe3 = await checkQuestions(stage, r3, phaseTitle)
  if (qe3) return qe3
  return { ok: true, passed, lastFlow }
}

// unruled: about の種類（pair: / open:）ごとに、どの resolution の about にもまだ無いキー。同じ呼び出しで裁定中の論点（まだ
// 合格していない）も about には入っているので、closedKeys だけで引くと裁定中の論点を二重に渡す。
const unruled = (keys, kind) => {
  const known = new Set(Object.values(state.about || {}).filter((k) => k && k.startsWith(`${kind}:`)))
  return uniq(keys).filter((k) => !known.has(k))
}

// recheckPairs: flow を変えた呼び出しの後の conflicts の組のうち、まだ裁定の無いもの。組は要素の id・label・constrained_by で決まるので、
// 回答や裁定の反映で要素を足すと、まだ誰も裁定していない組が生まれる。
async function recheckPairs(stage, conflictsText, phaseTitle, allowQuestions) {
  const cc = conflictsCheckOf(conflictsText)
  if (!cc) return { error: `段 ${stage}: flow を変えた呼び出しが doc_check conflicts の stdout を返しませんでした`, rerun: true }
  const fresh = unruled(cc.pair_keys, 'pair')
  if (!fresh.length) return { ids: [] }
  const label = `resolver:${stage}-pairs`
  const task = `flow を変えた後の ${W}/checks/conflicts.json に、まだ裁定の無い組がある。この組だけを裁定する（組を探し足さない）: ${list(fresh)}${allowQuestions ? '' : '\nこの段では依頼者に聞けないので、question ではなく hold にする。'}`
  const r = await once(label, 'resolver', resolverPrompt(label, `${stage}（新しい組）`, keepFlow(task, '組の裁定は flow を変えない')), RESOLVER_SCHEMA, phaseTitle)
  if (!r) return { error: `resolver（段 ${stage} の新しい組）が応答しませんでした` }
  const ids = absorbResolver(r)
  state.missed = uniq([...(state.missed || []), ...missedTargets(fresh, r)])
  const kept = flowKept(`${stage}-pairs`, r)
  if (kept) return kept
  const qe = await checkQuestions(stage, r, phaseTitle)
  if (qe) return qe
  return { ids }
}

const FRAME_RUN = `実行する: \`${cli('flow')}\` を 0 件になるまで（3 回まで）、最後に \`${cli('conflicts')}\`。最後に実行した 2 つの stdout を加工せずに flow_check と conflicts_check に入れる。`

// frameFlow: flow-framer を起動し、返った stdout が不合格なら CHECK_REWORK の回数だけ差し戻す。合格したら flow.json の内容の
// sha256 を state.flow_digest にする（後に続く verifier の stdout と照合する）。段 2・3b・settle で同じ扱いにする。
async function frameFlow(label, lines, phaseTitle) {
  const prompt = (l) => lines(l).filter(Boolean).join('\n\n')
  const read = (x) => ({ fc: flowCheckOf(x.flow_check), cc: conflictsCheckOf(x.conflicts_check), conflicts: x.conflicts_check, questions_check: x.questions_check })
  const defect = ({ fc, cc }) =>
    !fc ? 'doc_check flow の stdout がありません' : fc.findings > 0 ? `doc_check flow の指摘が ${fc.findings} 件あります（${W}/checks/flow.json）` : !cc ? 'doc_check conflicts の stdout がありません' : null
  const r = await once(label, 'flowFramer', prompt(label), FLOW_SCHEMA, phaseTitle)
  if (!r) return { error: `${label} が応答しませんでした` }
  let got = read(r)
  for (let i = 0; defect(got) && i < CHECK_REWORK; i++) {
    const again = await once(`${label}:rework`, 'flowFramer', `${prompt(`${label}:rework`)}\n\n返した stdout が不合格だった: ${defect(got)}。直して返す。`, FLOW_SCHEMA, phaseTitle)
    if (!again) break
    got = read(again)
  }
  if (defect(got)) return { error: `flow が閉じていません: ${defect(got)}` }
  state.flow_digest = got.fc.content_sha256
  return got
}

// settle: 最後の verifier の open_only のうち、O- が合格か回答で閉じた組を、flow-framer に裁定どおり直させる。閉じた O- を
// 出典に持つ「未決」の終端は閉包の検査を通るので、ここで拒否しないと未決のまま文書に届く（前回の F-090・F-091）。
// 値を決める呼び出しではないので resolver にしない（段 3・6 の resolver は flow を書かない）。
async function settle(stage, lastFlow, phaseTitle, before, allowQuestions) {
  const left = settledTerminals(lastFlow.open_only, state)
  const found = settledFlowFindings((state.pending || {}).findings, state, before)
  if (!left.length && !found.length) return null
  const settled = new Set(settledIds(state))
  const closers = (key) => uniq(Object.entries(state.about || {}).filter(([id, k]) => k === key && settled.has(id)).map(([id]) => id))
  // settle が del した要素を、回答待ちの問いの候補の flow_refs が指したままだと、ゲートで司令塔の doc_check questions が止まり、戻る段が無い。
  const waiting = pendingQuestions(state)
  const got = await frameFlow(`flow-framer:${stage}-settle`, (label) => [
    header('flowFramer', `${stage}（裁定の反映）`, label),
    `裁定を flow に写す（flow-framer.md の「裁定の反映」）。`,
    left.length ? `要素（閉じた O- ← 閉じた resolution）: ${left.map((x) => `${x.el}${x.case ? ` の case ${x.case}` : ''}（${x.open} ← ${list(closers(`open:${x.open}`))}）`).join(', ')}` : '',
    found.length ? `指摘（ID ← それを裁定した resolution）: ${found.map((id) => `${id}（← ${list(closers(`finding:${id}`))}）`).join(', ')}` : '',
    `resolution の中身は ${W}/resolutions.json から ID で読む。裁定の中身は変えない。`,
    FRAME_RUN,
    waiting.length ? `続けて \`${cli('questions', `--ids ${waiting.join(',')} --check`)}\` を実行し、stdout を加工せずに questions_check に入れる（問いは直さない）。` : '',
  ], phaseTitle)
  if (got.error) return { error: `段 ${stage}（裁定の反映）: ${got.error}` }
  const qe = await checkQuestions(`${stage}-settle`, { questions_check: got.questions_check }, phaseTitle, waiting)
  if (qe) return qe
  const fc = got.fc
  const pe = await recheckPairs(`${stage}-settle`, got.conflicts, phaseTitle, allowQuestions)
  if (pe.error) return pe
  const vLabel = `verifier:${stage}v-settle`
  // 指摘から直す要素は flow-framer が選ぶので、script には分からない。そのときは変わった要素をすべて検証させる。
  const fixed = found.length ? fc.unverified : uniq(left.map((x) => x.el)).filter((id) => fc.unverified.includes(id))
  const target = toVerify(fc.unverified, fixed)
  const v = await once(vLabel, 'verifier', verifierPrompt(vLabel, `${stage}v（裁定の反映）`, pe.ids, flowExtra(fc.unverified, fixed)), VERIFIER_SCHEMA, phaseTitle)
  if (!v) return { error: `resolver-verifier（段 ${stage}v の裁定の反映）が応答しませんでした` }
  const ve = absorbVerifier(v, state.resolutions_sha256, `${stage}v-settle`, true)
  if (ve) return ve
  const vfc = flowCheckOf(v.flow_check)
  const still = settledTerminals(vfc.open_only, state).map((x) => `${x.el}${x.case ? ` の case ${x.case}` : ''}（${x.open}）`)
  const unchecked = target.filter((id) => vfc.unverified.includes(id))
  const failed = v.fail.map((f) => f.id)
  if (!still.length && !unchecked.length && !failed.length) return null
  return {
    error: `段 ${stage}: 裁定の反映の後も直っていません（閉じた未決だけを出典に持つ要素: ${list(still)} / 検証を通っていない要素: ${list(unchecked)} / 不合格: ${list(failed)}）`,
  }
}

// applyReturnedFlow: resolver が返した doc_check flow の stdout を読む。指摘が残れば CHECK_REWORK の回数だけ差し戻し、
// 0 件になったら flow.json の内容の sha256 を state.flow_digest にする（後に続く verifier の stdout と照合する）。
// required の段（回答を flow に当てる 3a・3a'）では、stdout が無いことも不合格にする。
async function applyReturnedFlow(stage, ret, phaseTitle, required) {
  const given = ret.flow_check !== undefined && ret.flow_check !== null
  if (!given && !required) return { checked: false }
  let last = ret
  let fc = flowCheckOf(ret.flow_check)
  for (let i = 0; (!fc || fc.findings > 0) && i < CHECK_REWORK; i++) {
    const label = `resolver:${stage}-flow`
    const what = fc ? `flow.json が閉じていない。${W}/checks/flow.json の指摘（${fc.findings} 件）だけを直す（裁定の中身は変えない）。` : 'doc_check flow の stdout が返っていない。'
    const again = await once(
      label,
      'resolver',
      resolverPrompt(label, `${stage}（flow の修正）`, `${what}最後に \`${cli('flow')}\` と \`${cli('conflicts')}\` を実行し、stdout を加工せずに flow_check と conflicts_check に入れて返す。`),
      RESOLVER_SCHEMA,
      phaseTitle
    )
    if (!again) break
    absorbResolver(again)
    last = again
    fc = flowCheckOf(again.flow_check)
  }
  if (!fc) return { error: `段 ${stage}: resolver が doc_check flow の stdout を返しませんでした` }
  if (fc.findings > 0) return { error: `段 ${stage}: 回答を当てた flow が閉じていません（doc_check flow ${fc.findings} 件。${W}/checks/flow.json）` }
  const changed = fc.content_sha256 !== state.flow_digest
  state.flow_digest = fc.content_sha256
  return { checked: true, changed, unverified: fc.unverified, conflicts: last.conflicts_check }
}

// checkQuestions: 問いを出した resolver が返る前に実行した questions --check を確かめる。不合格なら 1 回だけ差し戻す。
// ゲートで司令塔が導出するまで形を検査しないと、落ちたときに戻る段が無く、run の外で止まる。
// recheck: 返り値の questions に無くても検査させる問い（3b が組み直した flow に合わせて直す、持ち越した問い）。裁定か hold に
// 変えたものは除く。
async function checkQuestions(stage, r, phaseTitle, recheck) {
  const settledNow = [...(r.ruled || []), ...(r.holds || [])].map((x) => x && x.id)
  const asked = minus(uniq([...(r.questions || []).map((x) => x && x.id), ...(recheck || [])]), settledNow)
  if (!asked.length) return null
  let failure = questionsCheckFailure(r.questions_check, asked)
  let target = asked
  for (let i = 0; failure && i < CHECK_REWORK; i++) {
    const label = `resolver:${stage}-questions`
    const again = await once(
      label,
      'resolver',
      resolverPrompt(
        label,
        `${stage}（問いの形の修正）`,
        keepFlow(`問い ${list(target)} が問いの形の検査を通っていない（${failure}）。その問いの question・options だけを直し（裁定の中身は変えない）、\`${cli('questions', `--ids ${target.join(',')} --check`)}\` の stdout を加工せずに questions_check に入れて返す。`)
      ),
      RESOLVER_SCHEMA,
      phaseTitle
    )
    if (!again) return { error: `resolver（段 ${stage} の問いの形の修正）が応答しませんでした` }
    absorbResolver(again)
    const kept = flowKept(`${stage}-questions`, again)
    if (kept) return kept
    target = minus(uniq([...target, ...(again.questions || []).map((x) => x && x.id)]), (again.holds || []).map((x) => x && x.id))
    failure = target.length ? questionsCheckFailure(again.questions_check, target) : null
  }
  return failure ? { error: `段 ${stage}: 問いの形が検査を通りません（${failure}）` } : null
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

// ---------------------------------------------------------------- 段

async function stage1() {
  phase('Intake')
  const label = 'intake'
  const prompt = [
    header('intake', '1', label),
    `読む: ${W}/input.md、${W}/precedent.json（とそこに並ぶファイル）`,
    existingNote(),
    '書く: decisions.json・plan.json・open.json。返り値は件数と writer の単位だけ。',
  ]
    .filter(Boolean)
    .join('\n\n')
  const r = await once(label, 'intake', prompt, INTAKE_SCHEMA, 'Intake')
  if (!r) return blocked('intake が応答しませんでした', '1')
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
  state.decisions_sha256 = r.decisions_sha256
  state.counts = { decisions: r.decisions, open: r.open, pairs: 0 }
  return '2'
}

async function stage2() {
  phase('Flow')
  const got = await frameFlow('flow-framer', (label) => [
    header('flowFramer', '2', label),
    `読む: ${W}/input.md、${W}/decisions.json、${W}/precedent.json、${W}/open.json`,
    existingNote(),
    FRAME_RUN,
  ], 'Flow')
  if (got.error) return blocked(`初稿を始めません（writer には flow を直す手段が無い）: ${got.error}`, '2')
  state.counts = { ...state.counts, open: got.fc.open, pairs: got.cc.pairs }
  return '3'
}

async function stage3() {
  phase('Resolve')
  const hasTargets = state.counts.open + state.counts.pairs > 0
  const res = await resolveCycle('3', {
    phase: 'Resolve',
    task: hasTargets
      ? `段 3: open.json の全件と checks/conflicts.json の組の全件を裁定する（組を探し足さない）。open ${state.counts.open} 件、組 ${state.counts.pairs} 件。`
      : null,
    verifyExtra:
      'あわせて検証する: decisions.json の source が default / precedent の決定すべてと、flow.json の全要素の source（decision は各 case の source も）。これらの ID（D- / F-）も pass / fail に入れる（open も組も 0 件でも省かない。intake の既定が残るため）。',
    allowQuestions: true,
  })
  if (res.error) return blocked(res.error, res.rerun === false ? null : '3')
  if (pendingQuestions(state).length) return needsAnswers('g0', '3a')
  return ENTRY === 'existing' ? '5' : '4'
}

// 3a / 3a': 回答を当てる。候補の選択はそのまま当て、候補の外の自由記述だけを verifier に通す。
// G0 の回答で出た問いは hold にせず 3b へ持ち越す。3b が組み直した flow から出る問いと 1 回の G0-2 で聞くためで、ここで hold に
// すると聞けたはずの問いが保持規則になる。G0-2 と G1 の後には聞くゲートが残っていない。
async function stageApply(stageId) {
  phase('Answers')
  const gate = state.gate
  const pending = pendingQuestions(state)
  const allowQuestions = gate === 'g0'
  const res = await resolveCycle(stageId, {
    phase: 'Answers',
    task: [
      `段 ${stageId}: ${W}/${GATE_ANSWERS[gate]} の回答を、問い ${list(pending)} に当てる（resolver.md の「回答の反映」）。`,
      '候補を選んだ回答は flow_effect と decision_text をそのまま当てる。候補の外の自由記述は問いに対応づけ、その ID を free_text に入れる。',
      `回答が当たった問いは ruled に入れる（ID は変えない）。最後に \`${cli('flow')}\` を実行し（flow.json を変えなくても実行する）、stdout を加工せずに flow_check に入れる。flow.json を変えたら、続けて \`${cli('conflicts')}\` を実行し、stdout を加工せずに conflicts_check に入れる。`,
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
    const label = `resolver:${stageId}-hold`
    const r = await once(
      label,
      'resolver',
      resolverPrompt(label, `${stageId}（保持規則への変換）`, keepFlow(`次の問いにはもう聞くゲートが残っていない。hold（保持規則・Issue の文案・触れる項目 ID）に書き換える。ID は変えない: ${list(left)}`)),
      RESOLVER_SCHEMA,
      'Answers'
    )
    if (!r) return blocked(`resolver（段 ${stageId} の保持規則への変換）が応答しませんでした`, stageId)
    absorbResolver(r)
    const kept = flowKept(`${stageId}-hold`, r)
    if (kept) return blocked(kept.error, kept.rerun ? stageId : null)
    state.holds = uniq([...(state.holds || []), ...left])
  }
  if (stageId === "3a'") return '7'
  return ENTRY === 'existing' ? '5' : '4'
}

// 3b: G0 の回答を入力に加えて flow-framer が flow を組み直し、組み直した flow から出た論点と 3a で出た問いを resolver が裁定する。
// 残った問いだけを G0-2 で 1 回聞く。
async function stage3b() {
  phase('Answers')
  const reframe = await frameFlow('flow-framer:3b-reframe', (label) => [
    header('flowFramer', '3b（回答での組み直し）', label),
    groundsBlock(),
    `${W}/open.json も読む。`,
    existingNote(),
    '回答を入力に加えて flow を組み直す（flow-framer.md の「回答での組み直し」）。',
    FRAME_RUN,
  ], 'Answers')
  if (reframe.error) return blocked(`段 3b: ${reframe.error}`, '3b')
  const opens = unruled(reframe.fc.open_ids.map((id) => `open:${id}`), 'open')
  const pairs = unruled(reframe.cc.pair_keys, 'pair')
  const carried = pendingQuestions(state)
  const res = await resolveCycle('3b', {
    phase: 'Answers',
    task:
      opens.length || pairs.length || carried.length
        ? [
            `段 3b: 回答で組み直した flow について裁定する（論点を探し足さない）。`,
            `- まだ裁定の無い open: ${list(opens.map((k) => k.slice(5)))}`,
            `- まだ裁定の無い組（${W}/checks/conflicts.json）: ${list(pairs)}`,
            `- 回答を待っている問い: ${list(carried)}。組み直した flow と回答で決まるなら同じ ID のまま裁定に変えて ruled に入れる。決まらないなら、候補（flow_refs・flow_effect）を組み直した flow に合わせて put し直し、questions に入れる（questions --check にも含める）。`,
          ].join('\n')
        : null,
    targets: [...opens, ...pairs, ...carried.map((id) => (state.about || {})[id]).filter(Boolean)],
    recheck: carried,
    verifyExtra: flowExtra(reframe.fc.unverified),
    flowChanged: true,
    allowQuestions: true,
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
  phase('Draft')
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
  const prev = uniq(((state.pending || {}).findings || []).filter((f) => (opt.items || []).includes(f.item_id)).map((f) => f.id))
  const target = doc === 'all' ? `全文書: ${docs.map((k) => `${W}/${k.replace('/', '-')}.md`).join('、')}、${W}/plan.json` : `文書: ${W}/${doc.replace('/', '-')}.md とその .meta.json`
  const lines = [
    header(role, opt.stage, opt.label),
    groundsBlock(),
    target,
    existingNote(),
    ENTRY === 'existing' ? '既存文書には trace が無い。既存の本文はそれ自身を原本として扱い、このランで変えた文だけを根拠の有無で見る。' : '',
    opt.items ? `範囲を絞った監査: 対象は項目 ${list(opt.items)}（その項目の節から読む）。` : '',
    opt.items && prev.length ? `同じ項目への前のパスの指摘: ${list(prev)}（中身は ${W}/findings/*.json から ID で読む）` : '',
    `指摘は ${W}/findings/${findingsName(role, doc, round, opt.extra)}.json に書き、ID はこのファイル名（.json を除く）に -001 からの連番を付けて振る（同じ段で同じ文書に 2 体目が起動することがあり、ファイル名が違えば ID も重ならない）。返り値の findings には doc も入れる。`,
  ]
  if (opt.designated) lines.push(`あなたは指名された監査役である。${opt.designated}`)
  return lines.filter(Boolean).join('\n\n')
}
const ROLE_TAG = { implementer: 'im', grounding: 'gr', crossDoc: 'cd' }
const findingsName = (role, doc, round, extra) => `r${round}-${ROLE_TAG[role]}-${doc === 'all' ? 'all' : fileKey(doc)}${extra ? '-extra' : ''}`
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
  phase('Audit')
  state.pass = 1
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

function setPending(findings, docCheck, carried, reversed) {
  const all = toDecision([...findings, ...carried], reversed)
  const p = partitionFindings(all)
  const refs = (docCheck && docCheck.flow_refs) || {}
  state.pending = {
    bundles: p.bundles.map((b) => {
      const flow = uniq((refs[b.doc] || {})[b.item_id])
      return flow.length ? { ...b, flow } : b
    }),
    decision: p.decision,
    blocking: p.blocking,
    doc_blocking: docCheck && Number.isInteger(docCheck.blocking) ? docCheck.blocking : 0,
    findings: all.map((f) => ({ id: f.id, doc: f.doc, item_id: f.item_id, blocking: Boolean(f.blocking), route: f.route, direction: f.direction, origin: f.origin })),
  }
}

async function stage6() {
  phase('Decide')
  const decision = state.pending.decision || []
  const tbd = minus(state.new_tbd || [], closedKeys(state).filter((k) => k.startsWith('tbd:')).map((k) => k.slice(4)))
  if (!decision.length && !tbd.length) return '7'
  const allowQuestions = state.pass === 1
  const res = await resolveCycle('6', {
    phase: 'Decide',
    task: [
      `段 6: route が decision の指摘 ${list(decision)}（中身は ${W}/findings/*.json から ID で読む）と、writer の meta の新しい TBD ${list(tbd)} を裁定する。`,
      '続けて、この段で裁定した resolution を単位と項目ごとに routes.json にまとめる。route が writer の指摘は扱わない。',
      allowQuestions ? '' : "これは最後のパスで、問いを聞くゲートが残っていない。価値の判断は question ではなく hold にする（resolver.md の「8'」）。",
    ]
      .filter(Boolean)
      .join('\n'),
    targets: [...decision.map((id) => `finding:${id}`), ...tbd.map((id) => `tbd:${id}`)],
    allowQuestions,
  })
  if (res.error) return blocked(res.error, res.rerun === false ? null : '6')
  state.new_tbd = []
  if (pendingQuestions(state).length) {
    if (allowQuestions) return needsAnswers('g1', "3a'")
    const label = 'resolver:6-hold'
    const r = await once(
      label,
      'resolver',
      resolverPrompt(label, '6（保持規則への変換）', keepFlow(`次の問いには聞くゲートが残っていない。hold に書き換える。ID は変えない: ${list(pendingQuestions(state))}`)),
      RESOLVER_SCHEMA,
      'Decide'
    )
    if (!r) return blocked('resolver（段 6 の保持規則への変換）が応答しませんでした', '6')
    state.holds = uniq([...(state.holds || []), ...pendingQuestions(state)])
    absorbResolver(r)
    const kept = flowKept('6-hold', r)
    if (kept) return blocked(kept.error, kept.rerun ? '6' : null)
  }
  return '7'
}

async function stage7() {
  phase('Revise')
  const p = state.pending
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
        `routes.json の担当の ID: ${list(t.routes)}（当てるのは、根拠にしてよい resolution と保持規則だけ）`,
        p.doc_blocking > 0 ? `${W}/checks/doc.json に doc_check の指摘が ${p.doc_blocking} 件ある。自分の文書の分を直す。` : '',
        newSettled.length ? `前回の書き込みの後に決まった resolution: ${list(newSettled)}。自分の文書に関わるものを当てる（hold は保持規則の規範文として書く）。` : '',
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
  state.revised = { changes, carried, docs: uniq(targets.flatMap((t) => t.unit.docs)) }
  return '8'
}

async function stage8() {
  phase('Revise')
  const n = state.audit.n
  const round = n + 1
  const { changes, carried } = state.revised
  const plan = scopedAuditPlan(changes, state.roles_by_item || {})
  const designatedText = [
    '監査の判定とは別に、次を実行して stdout を加工せずに designated に入れる。',
    `最初に（判定の前に）: \`${cli('diff', `--against audited-${n} --expect ${state.audit.digest}`)}\`。${W}/checks/diff-audited-${n}.json の changed・added・removed・by_doc を designated.diff に入れる。exit 3 で終わったら、それ以上進めず stderr を designated.diff_error に入れて返す。`,
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
  setPending(findings, docCheck, carried, reversedFindings(state.pending.findings, findings))
  // 改稿で新しく起票された TBD も、裁定されないまま終わると「開いたまま完了」になる。blocking と同じく
  // もう 1 パスの理由にする。
  const newTbd = minus(state.new_tbd || [], closedKeys(state).filter((k) => k.startsWith('tbd:')).map((k) => k.slice(4)))
  const blocking = state.pending.blocking.length + state.pending.doc_blocking + newTbd.length
  if (!blocking) return '9'
  if (state.pass < MAX_PASSES) {
    state.pass += 1
    log(`blocking が ${blocking} 件残った（新しい TBD ${newTbd.length} 件を含む）。段 6 → 7 → 8 をもう 1 パス回します（${state.pass}/${MAX_PASSES}）`)
    return '6'
  }
  return finalHold(blocking, newTbd)
}

// finalHold: 2 パス目の監査の後に残った blocking。改稿の枠が残っていないので文書に反映せず、決定が要るものは
// 保持規則と Issue の文案（触れる項目 ID 付き）に変えて blocked で返す。残った blocking の一覧は返り値にだけ置く。
async function finalHold(blocking, newTbd) {
  phase('Report')
  const decision = state.pending.decision || []
  const label = 'resolver:final'
  const r = await once(
    label,
    'resolver',
    resolverPrompt(
      label,
      '上限の後（blocked）',
      keepFlow(
        [
          `上限の ${MAX_PASSES} パスを使い切り、blocking が ${blocking} 件残った。文書は直さない。`,
          decision.length || newTbd.length
            ? `route が decision の指摘 ${list(decision)} と新しい TBD ${list(newTbd)} を hold にし、hold.item_ids にその論点に触れる項目 ID、hold.issue_draft に Issue の文案を書く。`
            : '',
        ]
          .filter(Boolean)
          .join('\n')
      )
    ),
    RESOLVER_SCHEMA,
    'Report'
  )
  const report = { report_path: `${W}/report.md`, remaining_blocking: state.pending.blocking, doc_blocking: state.pending.doc_blocking, tree_digest: state.tree_digest }
  if (r) {
    absorbResolver(r)
    const kept = flowKept('final', r)
    if (kept) return blocked(kept.error, kept.rerun ? '8' : null, report)
  }
  return blocked(`${MAX_PASSES} パスの改稿と監査の後も blocking が ${blocking} 件残りました`, null, report)
}

// stage9: 事後報告は resolutions からの導出物なので、生成する役を起動しない。report.md は司令塔が doc_check report で作る。
async function stage9() {
  phase('Report')
  return finish('done', { report_path: `${W}/report.md`, tree_digest: state.tree_digest, docs: auditDocs(), fixed_docs: EXISTING.filter((d) => d.fixed).map((d) => d.key) })
}

// ---------------------------------------------------------------- 実行

const STAGE_FNS = { 1: stage1, 2: stage2, 3: stage3, '3a': () => stageApply('3a'), '3b': stage3b, 4: stage4, 5: stage5, 6: stage6, "3a'": () => stageApply("3a'"), 7: stage7, 8: stage8, 9: stage9 }

let next = FROM
let outcome = null
while (outcome === null) {
  running = next
  entryState = JSON.parse(JSON.stringify(state))
  const r = await STAGE_FNS[next]()
  if (typeof r === 'string') next = r
  else outcome = r
}
return outcome
