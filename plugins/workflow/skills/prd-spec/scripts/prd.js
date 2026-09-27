export const meta = {
  name: 'prd-spec',
  description: '依頼を仕分けて流れを閉じ、前提を裁定してから要求・仕様を書き、監査と範囲を絞った再監査を上限 2 パスで回す',
  whenToUse: 'prd-spec の SKILL.md から、workspace を作ったあとに呼ぶ。needs_answers で止まったら回答を answers に逐語で書き、next_args をそのまま渡して再実行する',
  phases: [
    { title: 'Intake', detail: '段 1: 依頼を確定・決定・未決に仕分け、分割と writer の単位を決める' },
    { title: 'Flow', detail: '段 2: 出典付きの流れを描き、閉包を検査する' },
    { title: 'Resolve', detail: '段 3・3v: 未決と組を裁定し、独立に検証する（差し戻しは 1 回）' },
    { title: 'Answers', detail: '段 3a・3a\': 依頼者の回答を流れと裁定に当てる' },
    { title: 'Draft', detail: '段 4: writer の単位ごとに初稿を書く（依存の向きに順番、独立な単位は並列）' },
    { title: 'Audit', detail: '段 5: implementer・grounding を文書ごと、cross-doc を全文書で 1 回当てる' },
    { title: 'Decide', detail: '段 6: 決定が要る指摘と新しい TBD を裁定する' },
    { title: 'Revise', detail: '段 7・8: 改稿し、変えた範囲だけを監査する（上限 2 パス）' },
    { title: 'Report', detail: '段 9: 上限で止まったときは残った論点を保持規則にする（事後報告は司令塔が doc_check report で導出する）' },
  ],
}

// 段の順序・起動の条件・上限・返り値の検査と引き継ぎだけを持つ（schemas/role-map.md の prd.js の行）。
// ファイルは読めないので、分岐に使う値はすべて agent の返り値から受け取り、next_args の state に載せる。
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
  intake: ['§intake', '決定の台帳'],
  flowFramer: ['§flow-framer'],
  resolver: ['§resolver', '決定の台帳'],
  verifier: ['§resolver-verifier', '決定の台帳'],
  writer: ['§writer'],
  implementer: ['監査役の共通節', '§implementer'],
  grounding: ['監査役の共通節', '§grounding'],
  crossDoc: ['監査役の共通節', '§cross-doc'],
}

// COMMON_SECTIONS: 全役が役の節より前に読む節。書き込みの規則（put だけで書く・その場で更新する・tmp の所有）は
// ここにだけ置く。役の節に写すと、写しの無い役に規則が届かない（実測: 版コピーの禁止が writer.md にだけあった）。
const COMMON_SECTIONS = ['共通の約束', 'W のファイルと書き手']

// MAX_PASSES: 段 6 → 7 → 8 を回す上限（設計書 §1 の 8'）。2 パス目でも blocking が残れば blocked で止まる。
// 回数で切るのは、2 パス目の後には問いを聞くゲートも改稿の枠も残っていないからである。
const MAX_PASSES = 2

// FLOW_REWORK: flow-framer に閉包の欠陥を直させる回数。flow-framer は自分の内部で doc_check を 3 回まで
// 回してから返すので、ここでの 1 回は「返り値の flow が script の検査に落ちた」ときの差し戻しに限る。
const FLOW_REWORK = 1

const ENTRIES = ['new', 'existing', 'expand']
const STAGES = ['1', '2', '3', '3a', '4', '5', '6', "3a'", '7', '8', '9']
const GATE_ANSWERS = { g0: 'answers/g0.md', 'g0-2': 'answers/g0-2.md', g1: 'answers/g1.md' }

// ---------------------------------------------------------------- 純粋関数（tests が抽出して呼ぶ）
// PURE_BEGIN

const MODELS = ['haiku', 'sonnet', 'opus']
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']

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

// REQUIRES: from の入口ごとに、state に要る値。script はファイルを読めないので、ここに無ければ再開できない。
const REQUIRES = {
  1: [],
  2: ['units'],
  3: ['units', 'counts', 'flow'],
  '3a': ['units', 'flow', 'gate', 'questions'],
  4: ['units', 'flow'],
  5: ['units', 'flow'],
  6: ['units', 'flow', 'audit', 'pending', 'pass'],
  "3a'": ['units', 'flow', 'audit', 'pending', 'pass', 'gate', 'questions'],
  7: ['units', 'flow', 'audit', 'pending', 'pass'],
  8: ['units', 'flow', 'audit', 'pending', 'pass', 'revised'],
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

// ---------------------------------------------------------------- 流れの形と閉包（doc_check.mjs の写し）
// flow-framer と、回答を当てた resolver が返す flow 本体に、script 自身が閉包検査を当てる（C3）。
// import を書けないので doc_check.mjs の同区間を逐語で写す。一致は tests/test_formal_checks.py が検査する。
// FLOW_GRAPH_BEGIN
function flowGraphCompact(flow) {
  // 型の一覧は関数の中に置く（写し先の script が定義位置より前から呼んでも動くように。外の const は巻き上がらない）。
  const FLOW_TYPES = ['input', 'step', 'decision', 'output']
  const out = []
  const shape = (key, detail) => out.push({ c: 'FLOW_SHAPE', d: 'flow', a: [key, detail] })
  if (!flow || typeof flow !== 'object' || !Array.isArray(flow.elements)) {
    shape('elements', 'elements が配列ではない')
    return out
  }
  const kindNames = new Set()
  for (const k of Array.isArray(flow.kinds) ? flow.kinds : []) {
    if (!k || !k.name || !String(k.definition || '').trim()) shape(`kind-${(k && k.name) || '?'}`, '種類に name と definition が揃っていない')
    else kindNames.add(k.name)
  }
  if (!kindNames.size) shape('kinds', '要素の種類（kinds）が 1 つも定義されていない')
  if (!String(flow.closure || '').trim()) shape('closure', '一覧の外に要素が無いと言える根拠（closure）が無い')
  const byId = new Map()
  const noId = flow.elements.filter((el) => !el || !el.id).length
  if (noId) shape('id', `id の無い要素が ${noId} 件ある`)
  for (const el of flow.elements.filter((x) => x && x.id)) {
    if (byId.has(el.id)) shape(`dup-${el.id}`, `要素 ID ${el.id} が重複している`)
    byId.set(el.id, el)
    if (!FLOW_TYPES.includes(el.type)) shape(`type-${el.id}`, `${el.id} の type が ${FLOW_TYPES.join(' / ')} のいずれでもない`)
    if (!kindNames.has(el.kind)) shape(`kind-of-${el.id}`, `${el.id} の kind が kinds に定義されていない`)
    const branches = Array.isArray(el.branches) ? el.branches : []
    if (el.type === 'decision' && branches.length < 2) shape(`branches-${el.id}`, `判断 ${el.id} の値が 2 つ未満`)
    if (el.type !== 'decision' && branches.length) shape(`branches-${el.id}`, `判断でない ${el.id} が branches を持つ`)
  }
  const types = new Set([...byId.values()].map((el) => el.type))
  if (!types.has('input')) shape('no-input', '入力（type: input）が無い')
  if (!types.has('output')) shape('no-output', '出力（type: output）が無い')
  const nextOf = new Map()
  for (const el of byId.values()) {
    const targets = []
    for (const to of Array.isArray(el.next) ? el.next : []) targets.push(to)
    for (const b of el.type === 'decision' && Array.isArray(el.branches) ? el.branches : []) {
      if (!b || !b.next) out.push({ c: 'FLOW_BRANCH_OPEN', d: 'flow', a: [el.id, String((b && b.value) || '?')] })
      else targets.push(b.next)
    }
    for (const to of targets) {
      if (!byId.has(to)) out.push({ c: 'FLOW_DANGLING', d: 'flow', a: [el.id, to] })
    }
    nextOf.set(el.id, targets.filter((to) => byId.has(to)))
    if (el.type !== 'output' && el.type !== 'decision' && !targets.length) out.push({ c: 'FLOW_DEADEND', d: 'flow', a: [el.id] })
  }
  const seen = new Set()
  const queue = [...byId.values()].filter((el) => el.type === 'input').map((el) => el.id)
  while (queue.length) {
    const id = queue.shift()
    if (seen.has(id)) continue
    seen.add(id)
    queue.push(...(nextOf.get(id) || []))
  }
  if (types.has('input')) {
    for (const id of byId.keys()) if (!seen.has(id)) out.push({ c: 'FLOW_UNREACHABLE', d: 'flow', a: [id] })
  }
  return out
}
// FLOW_GRAPH_END

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
  properties: { flow: { type: 'object' }, open: INT, pairs: INT, flow_findings: INT, flow_digest: STR, conflicts_digest: STR },
  required: ['flow', 'open', 'pairs', 'flow_findings', 'flow_digest', 'conflicts_digest'],
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
    flow: { type: 'object' },
  },
  required: ['ruled', 'questions', 'holds', 'supersedes', 'free_text', 'routes', 'sha256'],
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
  },
  required: ['pass', 'fail', 'resolutions_sha256', 'decisions_sha256'],
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
        properties: { id: STR, doc: STR, item_id: STR, blocking: { type: 'boolean' }, route: { type: 'string', enum: ['writer', 'decision'] } },
        required: ['id', 'doc', 'item_id', 'blocking', 'route'],
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
const nextArgs = (from) => ({ ...BASE_ARGS, from, state: JSON.parse(JSON.stringify(state)) })

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
const blocked = (reason, rerunFrom, extra) => finish('blocked', { reason, next_args: rerunFrom ? nextArgs(rerunFrom) : null, ...extra })

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
    `- 根拠にしてよい resolution（合格・回答済み）: ${list(usableResolutions(state))}`,
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

function absorbResolver(r) {
  const { ids, about } = resolverIds(r)
  state.about = { ...(state.about || {}), ...about }
  state.known = uniq([...(state.known || []), ...ids])
  state.questions = uniq([...(state.questions || []), ...(r.questions || []).map((x) => x.id)])
  state.holds = uniq([...(state.holds || []), ...(r.holds || []).map((x) => x.id)])
  state.superseded = uniq([...(state.superseded || []), ...(r.supersedes || [])])
  const seenRoutes = new Set((state.routes || []).map((x) => `${x.unit}|${x.id}`))
  state.routes = [...(state.routes || []), ...(r.routes || []).filter((x) => !seenRoutes.has(`${x.unit}|${x.id}`)).map((x) => ({ unit: x.unit, id: x.id }))]
  if (r.sha256) state.resolutions_sha256 = r.sha256
  return ids
}

function absorbVerifier(v, expectedSha) {
  const failIds = (v.fail || []).map((f) => f.id)
  state.passed = minus(uniq([...(state.passed || []), ...(v.pass || [])]), failIds)
  state.failed_ids = minus(uniq([...(state.failed_ids || []), ...failIds]), v.pass || [])
  if (expectedSha && v.resolutions_sha256 !== expectedSha) {
    state.integrity = [...(state.integrity || []), `verifier が検証した resolutions.json（${v.resolutions_sha256}）が、resolver が書き終えた版（${expectedSha}）と違う`]
  }
}

// checkFlow: 返り値の flow に閉包検査を当てる。欠陥の一覧（空なら合格）を返す。
function flowDefects(flow) {
  return flowGraphCompact(flow).map((f) => `${f.c} ${(f.a || []).join(' ')}`)
}

// resolverPrompt / verifierPrompt: 段ごとの対象はプロンプトで指定する（ID の一覧だけ。中身は W から読む）。
function resolverPrompt(label, stage, task) {
  return [header('resolver', stage, label), groundsBlock(), `${W}/checks/conflicts.json、${W}/open.json、${W}/verifications.json、${W}/precedent.json も読む。`, existingNote(), task]
    .filter(Boolean)
    .join('\n\n')
}

function verifierPrompt(label, stage, ids, extra) {
  return [header('verifier', stage, label), `検証する resolution の ID: ${list(ids)}`, extra || '', '合格は pass に、不合格は fail に入れる。書き直さない。'].filter(Boolean).join('\n\n')
}

// resolveCycle: resolver → verifier → 不合格の差し戻し 1 回 → 再検証。それでも不合格なら理由で分ける:
// 価値の判断を方法論として決めた（value_as_method）→ 問い（聞けないときは保持規則）、それ以外 → 保持規則。
// 変換した分はもう検証しない（検証のループを増やすと、差し戻しの上限が意味を失う）。
async function resolveCycle(stage, opt) {
  const phaseTitle = opt.phase
  let ids = []
  if (opt.task) {
    const label = `resolver:${stage}`
    const r = await once(label, 'resolver', resolverPrompt(label, stage, opt.task), RESOLVER_SCHEMA, phaseTitle)
    if (!r) return { error: `resolver（段 ${stage}）が応答しませんでした` }
    ids = absorbResolver(r)
    if (opt.targets) state.missed = uniq([...(state.missed || []), ...missedTargets(opt.targets, r)])
    const fe = await applyReturnedFlow(stage, r, phaseTitle)
    if (fe) return { error: fe }
    if (opt.answered) {
      const free = new Set(r.free_text || [])
      const byOption = (r.ruled || []).map((x) => x.id).filter((id) => opt.answered.includes(id) && !free.has(id))
      state.answered = uniq([...(state.answered || []), ...byOption])
      ids = minus(ids, byOption)
    }
  }
  if (!ids.length && !opt.verifyExtra) return { ok: true, passed: [] }
  const v1Label = `verifier:${stage}v`
  const v1 = await once(v1Label, 'verifier', verifierPrompt(v1Label, `${stage}v`, ids, opt.verifyExtra), VERIFIER_SCHEMA, phaseTitle)
  if (!v1) return { error: `resolver-verifier（段 ${stage}v）が応答しませんでした` }
  absorbVerifier(v1, state.resolutions_sha256)
  if (!v1.fail.length) return { ok: true, passed: v1.pass }

  const rework = v1.fail.map((f) => `- ${f.id}: ${f.kind}（${f.reason}）`).join('\n')
  const r2Label = `resolver:${stage}'`
  const r2 = await once(
    r2Label,
    'resolver',
    resolverPrompt(r2Label, `${stage}'（差し戻し）`, `verifier が不合格にした項目だけを 1 回直す（resolver.md の「差し戻し」）。D- / F- の項目は about を {verification} にした resolution で置き換える。\n${rework}${opt.allowQuestions ? '' : '\nこの段では依頼者に聞けないので、question ではなく hold にする。'}`),
    RESOLVER_SCHEMA,
    phaseTitle
  )
  if (!r2) return { error: `resolver（段 ${stage}' の差し戻し）が応答しませんでした` }
  const ids2 = absorbResolver(r2)
  const fe2 = await applyReturnedFlow(stage, r2, phaseTitle)
  if (fe2) return { error: fe2 }
  const v2Label = `verifier:${stage}v'`
  const v2 = await once(v2Label, 'verifier', verifierPrompt(v2Label, `${stage}v'`, ids2), VERIFIER_SCHEMA, phaseTitle)
  if (!v2) return { error: `resolver-verifier（段 ${stage}v' の再検証）が応答しませんでした` }
  absorbVerifier(v2, state.resolutions_sha256)
  const passed = uniq([...minus(v1.pass, v2.fail.map((f) => f.id)), ...v2.pass])
  if (!v2.fail.length) return { ok: true, passed }

  const convert = v2.fail
    .map((f) => `- ${f.id} → ${f.kind === 'value_as_method' && opt.allowQuestions ? 'question' : 'hold'}（${f.kind}）`)
    .join('\n')
  log(`段 ${stage}: 差し戻し後も ${v2.fail.length} 件が不合格。理由で問いと保持規則に分けます（検証はもう回しません）`)
  const r3Label = `resolver:${stage}-convert`
  const r3 = await once(
    r3Label,
    'resolver',
    resolverPrompt(r3Label, `${stage}（変換）`, `次の項目は差し戻し後も不合格だった。値を決めずに、指定のとおり question（候補と影響を付ける）か hold（保持規則と Issue の文案）に書き換える。ID は変えない。\n${convert}`),
    RESOLVER_SCHEMA,
    phaseTitle
  )
  if (!r3) return { error: `resolver（段 ${stage} の変換）が応答しませんでした` }
  absorbResolver(r3)
  return { ok: true, passed }
}

// applyReturnedFlow: resolver が回答を flow に当てたとき、返った flow に閉包検査を当て直す。
async function applyReturnedFlow(stage, r, phaseTitle) {
  if (!r.flow) return null
  let defects = flowDefects(r.flow)
  let flow = r.flow
  for (let i = 0; defects.length && i < FLOW_REWORK; i++) {
    const label = `resolver:${stage}-flow`
    const again = await once(
      label,
      'resolver',
      resolverPrompt(label, `${stage}（flow の修正）`, `回答を当てた flow.json が閉じていない。次の欠陥だけを直し、更新後の flow 本体を返す（裁定の中身は変えない）。\n${defects.map((d) => `- ${d}`).join('\n')}`),
      RESOLVER_SCHEMA,
      phaseTitle
    )
    if (!again || !again.flow) break
    absorbResolver(again)
    flow = again.flow
    defects = flowDefects(flow)
  }
  if (defects.length) return `段 ${stage}: 回答を当てた flow が閉じていません（${defects.slice(0, 5).join(' / ')}）`
  state.flow = flow
  return null
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
  const base = (label) =>
    [
      header('flowFramer', '2', label),
      `読む: ${W}/input.md、${W}/decisions.json、${W}/precedent.json、${W}/open.json`,
      existingNote(),
      `実行する: \`${cli('flow')}\` を 0 件になるまで（3 回まで）、最後に \`${cli('conflicts')}\`。`,
    ]
      .filter(Boolean)
      .join('\n\n')
  const label = 'flow-framer'
  let r = await once(label, 'flowFramer', base(label), FLOW_SCHEMA, 'Flow')
  if (!r) return blocked('flow-framer が応答しませんでした', '2')
  let defects = flowDefects(r.flow)
  for (let i = 0; (defects.length || r.flow_findings > 0) && i < FLOW_REWORK; i++) {
    const reworkLabel = `${label}:rework`
    const again = await once(
      reworkLabel,
      'flowFramer',
      `${base(reworkLabel)}\n\n返した flow が閉じていない。次の欠陥と ${W}/checks/flow.json の指摘（${r.flow_findings} 件）を直して返す:\n${defects.map((d) => `- ${d}`).join('\n') || '（script の検査は 0 件）'}`,
      FLOW_SCHEMA,
      'Flow'
    )
    if (!again) break
    r = again
    defects = flowDefects(r.flow)
  }
  if (defects.length || r.flow_findings > 0) {
    return blocked(`流れが閉じていません。初稿を始めません（writer には flow を直す手段が無い）: ${defects.slice(0, 5).join(' / ') || `doc_check flow ${r.flow_findings} 件`}`, '2')
  }
  state.flow = r.flow
  state.counts = { ...state.counts, open: r.open, pairs: r.pairs }
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
      'あわせて検証する: decisions.json の source が default / precedent の決定すべてと、flow.json の全要素の source。これらの ID（D- / F-）も pass / fail に入れる（open も組も 0 件でも省かない。intake の既定が残るため）。',
    allowQuestions: true,
  })
  if (res.error) return blocked(res.error, '3')
  if (pendingQuestions(state).length) return needsAnswers('g0', '3a')
  return ENTRY === 'existing' ? '5' : '4'
}

// 3a / 3a': 回答を当てる。候補の選択はそのまま当て、候補の外の自由記述だけを verifier に通す。
async function stageApply(stageId) {
  phase('Answers')
  const gate = state.gate
  const pending = pendingQuestions(state)
  const followup = gate === 'g0' && !state.g0_followup_used
  const res = await resolveCycle(stageId, {
    phase: 'Answers',
    task: [
      `段 ${stageId}: ${W}/${GATE_ANSWERS[gate]} の回答を、問い ${list(pending)} に当てる（resolver.md の「回答の反映」）。`,
      '候補を選んだ回答は flow_effect と decision_text をそのまま当てる。候補の外の自由記述は問いに対応づけ、その ID を free_text に入れる。',
      '回答が当たった問いは ruled に入れる（ID は変えない）。flow.json を変えたら、更新後の flow 本体を返す。',
      followup
        ? '反映で価値に関わる新しい矛盾が出たら、続きの問いを 1 回だけ question にしてよい。'
        : '続きの問いはもう聞けない。価値に関わる新しい矛盾は hold にする。',
    ].join('\n'),
    answered: pending,
    allowQuestions: followup,
  })
  if (res.error) return blocked(res.error, stageId)
  // 自由記述の回答は、対応づけが verifier に合格して初めて回答が当たったことになる。
  state.answered = uniq([...(state.answered || []), ...pending.filter((id) => (res.passed || []).includes(id))])
  if (gate === 'g0') state.g0_followup_used = true
  const left = pendingQuestions(state)
  if (left.length && followup) return needsAnswers('g0-2', stageId)
  if (left.length) {
    const label = `resolver:${stageId}-hold`
    const r = await once(
      label,
      'resolver',
      resolverPrompt(label, `${stageId}（保持規則への変換）`, `次の問いにはもう聞くゲートが残っていない。hold（保持規則・Issue の文案・触れる項目 ID）に書き換える。ID は変えない: ${list(left)}`),
      RESOLVER_SCHEMA,
      'Answers'
    )
    if (!r) return blocked(`resolver（段 ${stageId} の保持規則への変換）が応答しませんでした`, stageId)
    absorbResolver(r)
    state.holds = uniq([...(state.holds || []), ...left])
  }
  if (stageId === "3a'") return '7'
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
    state.integrity = [...(state.integrity || []), `writer ${r.unit} が読んだ resolutions.json（${r.resolutions_sha256}）が、台帳の最新（${state.resolutions_sha256}）と違う`]
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
  const target = doc === 'all' ? `全文書: ${docs.map((k) => `${W}/${k.replace('/', '-')}.md`).join('、')}、${W}/plan.json` : `文書: ${W}/${doc.replace('/', '-')}.md とその .meta.json`
  const lines = [
    header(role, opt.stage, opt.label),
    groundsBlock(),
    target,
    existingNote(),
    ENTRY === 'existing' ? '既存文書には trace が無い。既存の本文はそれ自身を原本として扱い、このランで変えた文だけを根拠の有無で見る。' : '',
    opt.items ? `範囲を絞った監査: 対象は項目 ${list(opt.items)}（その項目の節から読む）。` : '',
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

function setPending(findings, docCheck, carried) {
  const p = partitionFindings([...findings, ...carried])
  state.pending = {
    bundles: p.bundles,
    decision: p.decision,
    blocking: p.blocking,
    doc_blocking: docCheck && Number.isInteger(docCheck.blocking) ? docCheck.blocking : 0,
    findings: [...findings, ...carried].filter((f) => f && f.id).map((f) => ({ id: f.id, doc: f.doc, item_id: f.item_id, blocking: Boolean(f.blocking), route: f.route })),
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
  if (res.error) return blocked(res.error, '6')
  state.new_tbd = []
  if (pendingQuestions(state).length) {
    if (allowQuestions) return needsAnswers('g1', "3a'")
    const label = 'resolver:6-hold'
    const r = await once(
      label,
      'resolver',
      resolverPrompt(label, '6（保持規則への変換）', `次の問いには聞くゲートが残っていない。hold に書き換える。ID は変えない: ${list(pendingQuestions(state))}`),
      RESOLVER_SCHEMA,
      'Decide'
    )
    if (!r) return blocked('resolver（段 6 の保持規則への変換）が応答しませんでした', '6')
    state.holds = uniq([...(state.holds || []), ...pendingQuestions(state)])
    absorbResolver(r)
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
        `writer の指摘（項目ごとに束ねたもの。中身は ${W}/findings/*.json から ID で読む）:\n${t.bundles.map((b) => `- ${b.doc} ${b.item_id}: ${b.findings.join(', ')}`).join('\n') || '（なし）'}`,
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
  setPending(findings, docCheck, carried)
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
      [
        `上限の ${MAX_PASSES} パスを使い切り、blocking が ${blocking} 件残った。文書は直さない。`,
        decision.length || newTbd.length
          ? `route が decision の指摘 ${list(decision)} と新しい TBD ${list(newTbd)} を hold にし、hold.item_ids にその論点に触れる項目 ID、hold.issue_draft に Issue の文案を書く。`
          : '',
      ]
        .filter(Boolean)
        .join('\n')
    ),
    RESOLVER_SCHEMA,
    'Report'
  )
  if (r) absorbResolver(r)
  return blocked(`${MAX_PASSES} パスの改稿と監査の後も blocking が ${blocking} 件残りました`, null, {
    report_path: r ? `${W}/report.md` : null,
    remaining_blocking: state.pending.blocking,
    doc_blocking: state.pending.doc_blocking,
    tree_digest: state.tree_digest,
  })
}

// stage9: 事後報告は resolutions からの導出物なので、生成する役を起動しない。report.md は司令塔が doc_check report で作る。
async function stage9() {
  phase('Report')
  return finish('done', { report_path: `${W}/report.md`, tree_digest: state.tree_digest, docs: auditDocs(), fixed_docs: EXISTING.filter((d) => d.fixed).map((d) => d.key) })
}

// ---------------------------------------------------------------- 実行

const STAGE_FNS = { 1: stage1, 2: stage2, 3: stage3, '3a': () => stageApply('3a'), 4: stage4, 5: stage5, 6: stage6, "3a'": () => stageApply("3a'"), 7: stage7, 8: stage8, 9: stage9 }

let next = FROM
let outcome = null
while (outcome === null) {
  const r = await STAGE_FNS[next]()
  if (typeof r === 'string') next = r
  else outcome = r
}
return outcome
