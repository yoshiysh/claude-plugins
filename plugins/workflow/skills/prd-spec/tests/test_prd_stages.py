"""workflows/prd-spec.js の段の経路の smoke テスト。

agent / pipeline / parallel / log / phase を stub にして prd-spec.js を node で走らせ、段の順序と
起動の条件と上限を確かめる。stub の agent は label で応答を返し分ける（label の形は
`<役>:<段や周回>:<対象>` で、prd-spec.js が付ける）。

押さえること（設計書 §4 の「移すテスト」）:
- 問い 0 件なら 1 回の run で done になる（resolver の段 3 も段 6 も起動しない。3v は必ず起動する）
- 段 3・3b・6 などのゲート（開いた順に g1, g2, …）で needs_answers になり、next_args をそのまま渡すと続きの段から走る
- 改稿と監査は収束（blocking 0）か上限（MAX_AUDIT_PASSES）で止まり、最後のパスの監査を飛ばさない
- writer の申告に無い変更 ID は、監査を追加で起動せず、writer reviewer の範囲（diff の指示）と undeclared に入る
- 任意の from から再実行すると、その段から進む。要る state が無ければ止まる
- 応答しなかった agent を「0 件」として扱わず、blocked にして、その段からの next_args を返す

構文の確認もここで行う。prd-spec.js は `export const meta` とトップレベルの return を持つので、
そのままでは `node --check` に通らない。`export ` を外し、本体を async 関数で包んでから確かめる。
"""

import json
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from prd_script import PRD_PATH as PRD  # noqa: E402
from test_prd_pure import WORKFLOW_IO, contract_values, value  # noqa: E402
from test_ledger import _exported  # noqa: E402
import stages_client  # noqa: E402

SKILL = Path(__file__).resolve().parents[1]

HARNESS = r"""
const spec = JSON.parse(process.argv[2])
// atReads: spec の *_at の段ごとに、stub が一度でも引いたか。run() はテストの中で一度も引かれない段を落とす（書いた経路を通らない空洞のテストを残さない）。
const atRaw = {}
const atSeen = {}
for (const [k, v] of Object.entries(spec)) {
  if (!k.endsWith('_at') || !v || typeof v !== 'object') continue
  const seen = (atSeen[k] = new Set())
  atRaw[k] = v
  spec[k] = new Proxy(v, Array.isArray(v)
    ? { get: (t, p) => (p === 'includes' ? (x) => (seen.add(String(x)), t.includes(x)) : t[p]) }
    : { get: (t, p) => (typeof p === 'string' && seen.add(p), t[p]), ownKeys: (t) => (Object.keys(t).forEach((x) => seen.add(x)), Reflect.ownKeys(t)) })
}
const atReads = () => Object.fromEntries(Object.entries(atRaw).map(([k, v]) => [k, Object.fromEntries((Array.isArray(v) ? v.map(String) : Object.keys(v)).map((x) => [x, atSeen[k].has(x)]))]))
const labels = []
const logs = []
let sha = 'rs-0'
const hash = (text) => {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0
  return h.toString(16).padStart(8, '0')
}
let reviseN = 0
let unappliedN = 0
const minusIds = (xs, drop) => xs.filter((x) => !drop.includes(x))
const nulls = new Set(spec.null_labels || [])
// long_digests: sha256・digest を実物と同じ 64 字にする（next_args の上限テストで字数を実測に合わせるため）。
const H = (x) => (spec.long_digests ? String(x).padEnd(64, '0') : x)
// disk: stub の W。flow.json の sha256、要素の版（書き換えるたびに 1 増える）、verifications.json の合否（F- は検証した版つき）、
// resolutions.json の about と ruling。doc_check flow の unverified・failed_current・resolutions は、段ごとの一覧ではなくここから wsFlow と同じ規則で出す
// （段ごとに一覧を書かせると、検証していない要素を verifier の後の stdout から消した世界をテストが書けてしまう）。
// spec.world があれば run をまたいで W のように残り、無ければ state から始める（state に載った ID は検証済みとして、about と ruling も state のとおりに置く）。
const fs = await import('node:fs')
// stampStdout: doc_check の CLI が stdout に付ける digest（stub の doc_check の stdout にも実物と同じ欄を付ける）。
const { stampStdout, rulingsCompact } = await import(spec.doc_check_url)
const saved = spec.world && fs.existsSync(spec.world) ? JSON.parse(fs.readFileSync(spec.world, 'utf8')) : null
const st0 = spec.args.state || {}
const aboutOf = (key) => {
  if (!key) return null
  const [kind, rest] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)]
  return kind === 'pair' ? { pair: rest.split('|') } : { [kind]: rest }
}
const rulingOf = (id) => ((st0.holds || []).includes(id) ? 'hold' : (st0.questions || []).includes(id) ? 'question' : 'internal')
let preexisting = new Set(Object.keys((saved && saved.rs) || {}))
const disk = saved || {
  flow: st0.flow_digest || null,
  els: {},
  verdicts: Object.fromEntries(Object.keys(st0.about || {}).map((id) => [id, (st0.failed_ids || []).includes(id) ? { verdict: 'fail', kind: 'insufficient_grounds' } : { verdict: 'pass' }])),
  rs: Object.fromEntries(Object.keys(st0.about || {}).map((id) => [id, { about: aboutOf(st0.about[id]), ruling: rulingOf(id), ...((st0.answered || []).includes(id) ? { has_answer: true } : {}) }])),
}
const persist = () => {
  if (spec.world) fs.writeFileSync(spec.world, JSON.stringify(disk))
}
// answers: 回答のファイル（answers/<ゲート>.md）ごとに `<ID>:` の行を持つ問い。write_answers は司令塔が呼び出しの前に書いた回答で、段 1 の reset が消す。
disk.answers = { ...(disk.answers || {}), ...(spec.write_answers || {}) }
// 回答を当てる段から next_args で始める run は、司令塔が呼び出しの前に回答を書いている（SKILL.md「## 中継」）。書いていない世界は write_answers で明示する。
const answeredBeforeCall = spec.write_answers === undefined && ['3a', "3a'"].includes(String(spec.args.from))
persist()
let flowSha = disk.flow
// cache の run は保存された結果を返した呼び出しで stubAgent を通らないので、resolutions.json の sha256 を W から読み直す（実物は台帳のファイルから出る）。
// world から始めた run も同じ（前の run の planner:1 が段 1 の token で書いた台帳は、段 3 の restore の後も W に残る）。
if ((spec.cache || saved) && disk.rs_sha) sha = disk.rs_sha
// 段の token（doc_check の put・del と同じ）: 台帳を書く役のプロンプトの「トークン:」の行。書く前に、その token の下で最初に書く
// 台帳の控え（disk の欄の組）を disk.tx[token] に取り、新しい token の最初の書き込みで他の token の控えを消す。
// restore は入口の flow-check のプロンプトの doc_check restore --token で、控えを戻して token の控えを消す。
// docs: 文書の本文の版（writer が書くたびに 1 増える）。本文は doc_check を通らないので、控えは doc_check backup だけが取る（段 4・7 の writer の
// 最初のコマンド。写しの取り直しの flow-check も同じコマンドを流す）。
const TX_KEYS = { flow: ['flow', 'els', 'cites'], verifications: ['verdicts'], resolutions: ['rs', 'rs_sha'], open: ['open_ids'], docs: ['docs'] }
let curToken = null
const BACKUP_CMD = /doc_check\.mjs backup --workspace \S+ ((?:--doc \S+ )+)--token (\S+?)`/
const backupKeys = (flags) => uniqSorted(String(flags).match(/[a-z]+\/[A-Za-z0-9._-]+/g) || [])
const uniqSorted = (xs) => [...new Set(xs)].sort()
const txOrd = (t) => {
  const m = /^t(\d+)(?:r(\d+))?$/.exec(t)
  return [Number(m[1]), Number(m[2] || 0)]
}
const touch = (ledger) => {
  if (!curToken) throw new Error(`${ledger} をトークンの無いプロンプトから書こうとしました（doc_check の put・del は token なしを拒否する）`)
  const [s0, r0] = txOrd(curToken)
  const later = Object.keys(disk.tx || {}).filter((t) => t !== curToken && (txOrd(t)[0] > s0 || (txOrd(t)[0] === s0 && txOrd(t)[1] > r0)))
  if (later.length) throw new Error(`${ledger}: token ${curToken} より後の token（${later.join(', ')}）の控えがあります（doc_check の put・del は何も書かずに止まる）`)
  disk.tx = Object.fromEntries(Object.entries(disk.tx || {}).filter(([t]) => t === curToken))
  const pre = (disk.tx[curToken] = disk.tx[curToken] || {})
  if (!(ledger in pre)) pre[ledger] = Object.fromEntries(TX_KEYS[ledger].map((k) => [k, disk[k] === undefined ? { absent: true } : { value: JSON.parse(JSON.stringify(disk[k])) }]))
}
const seqOf = (token) => Number(/^t(\d+)/.exec(token)[1])
// 文書の digest（doc_check backup・restore の stdout の digests・entry_digest・tree_digest）。版 ver の文書の digest は H(`d-<キー>-<ver>`)、本文の無い文書は null。
// entry_digest: spec.entry_digest があり、existing_docs の文書の版が基準（disk.entry_base: 段 1 の reset の時点の版）のままならその値、変わっていれば
// H('entry-x')、spec.entry_digest が無ければ null（reset が entry.json を書かない W）。tree_digest: 監査役が audited を返した時点の docs
// （disk.audited_docs: { <audited の digest>: docs }）のうち同じ docs の digest（後に記録したものから探す）、無ければ H('tree-x')。
// 基準はどちらも W に置く（world の run をまたいで残る。止まった run が書いた後の docs を、続きの run の開始時に基準にしない）。
const EXISTING_KEYS = (spec.args.existing_docs || []).map((d) => (typeof d === 'string' ? d : d.key))
const docsCanon = (docs) => JSON.stringify(Object.entries(docs || {}).filter(([, v]) => v).sort())
const docDigests = (docs, keys) => Object.fromEntries(keys.map((k) => [k, docs[k] ? H(`d-${k}-${docs[k]}`) : null]))
const entryDigestOf = (docs) => (!spec.entry_digest ? null : EXISTING_KEYS.every((k) => (docs[k] || 0) === ((disk.entry_base || {})[k] || 0)) ? spec.entry_digest : H('entry-x'))
const treeDigestOf = (docs) => (Object.entries(disk.audited_docs || {}).reverse().find(([, d]) => docsCanon(d) === docsCanon(docs)) || [H('tree-x')])[0]
const docsFields = (docs, keys) => ({ digests: docDigests(docs, keys), entry_digest: entryDigestOf(docs), tree_digest: treeDigestOf(docs) })
const recordAudited = (digest) => {
  const rest = Object.fromEntries(Object.entries(disk.audited_docs || {}).filter(([d]) => d !== digest))
  disk.audited_docs = { ...rest, [digest]: JSON.parse(JSON.stringify(disk.docs || {})) }
  persist()
}
// preImage: token の控えの版の docs（doc_check の「控えの版」。控えがあればその中身、控えが無ければ今の W）。
const preImage = (token) => {
  const x = (((disk.tx || {})[token] || {}).docs || {}).docs
  return x ? (x.absent ? {} : x.value) : disk.docs || {}
}
const backupStdout = (token, keys) => ({ backup: true, token, docs: keys, ...docsFields(preImage(token), keys) })
// reset の stub も監査役の stub も走らない run（next_args や手で組んだ state で段 4・7 から始める run）は、基準が W に無ければ開始時の docs を基準にする。
if (!disk.entry_base) disk.entry_base = Object.fromEntries(EXISTING_KEYS.map((k) => [k, (disk.docs || {})[k] || 0]))
if (st0.audit && !Object.hasOwn(disk.audited_docs || {}, st0.audit.digest)) disk.audited_docs = { ...(disk.audited_docs || {}), [st0.audit.digest]: JSON.parse(JSON.stringify(disk.docs || {})) }
persist()
// restore_docs_stdout_at: { <label>: [欄] }。restore の stdout から落とす欄（戻した後の文書の digest の無い stdout）。
const restoreTx = (token, label) => {
  const before = flowSha
  const pre = (disk.tx || {})[token]
  const drop = (o) => JSON.stringify(Object.fromEntries(Object.entries(o).filter(([k]) => !((spec.restore_docs_stdout_at || {})[label] || []).includes(k))))
  const present = () => Object.keys(disk.docs || {}).filter((k) => disk.docs[k]).sort()
  const prunedBy = pre ? [] : Object.keys(disk.tx || {}).filter((t) => seqOf(t) > seqOf(token)).sort()
  if (prunedBy.length) return drop({ token, restored: 0, files: [], pruned_by: prunedBy, flow_before: String(before), flow_after: String(before), ...docsFields(disk.docs || {}, present()) })
  for (const keys of Object.values(pre || {})) for (const [k, x] of Object.entries(keys)) if (x.absent) delete disk[k]; else disk[k] = x.value
  if (disk.tx) delete disk.tx[token]
  flowSha = disk.flow
  if (spec.cache) sha = disk.rs_sha || 'rs-0'
  preexisting = new Set(Object.keys(disk.rs || {}))
  persist()
  return drop({ token, restored: Object.keys(pre || {}).length, files: [], pruned_by: [], flow_before: String(before), flow_after: String(flowSha), ...docsFields(disk.docs || {}, present()) })
}
// fixedShas: doc_check の固定の文書の sha256。fixed_moved_at: { <監査の段 r<n>>: [文書キー] } の文書だけ、その段から後の値を変える。
const fixedShas = (keys, stage) => Object.fromEntries(keys.map((k) => [k, H(`fixed-${k}${stage && Object.entries(spec.fixed_moved_at || {}).some(([s, ks]) => Number(stage.slice(1)) >= Number(s.slice(1)) && ks.includes(k)) ? '-moved' : ''}`)]))
// reset: doc_check reset と同じく、S0 が書いたもののほか（台帳・控え）を消す。
const resetWorld = (keep, fixed) => {
  const removed = ['flow', 'els', 'verdicts', 'rs', 'open_ids', 'tx'].filter((k) => disk[k] !== undefined && disk[k] !== null)
  Object.assign(disk, { flow: null, els: {}, verdicts: {}, rs: {} })
  delete disk.cites
  delete disk.open_ids
  delete disk.tx
  delete disk.rs_sha
  if (disk.answers && Object.keys(disk.answers).length) removed.push('answers')
  disk.answers = {}
  if (spec.cache) sha = 'rs-0'
  // reset は --keep に無い文書を消す（残した文書の本文は S0 の版に戻らないが、stub は版を数えるだけなので残す）。
  const kept = keep ? keep.split(',') : []
  disk.docs = Object.fromEntries(Object.entries(disk.docs || {}).filter(([k]) => kept.includes(k)))
  disk.entry_base = Object.fromEntries(EXISTING_KEYS.map((k) => [k, disk.docs[k] || 0]))
  flowSha = null
  preexisting = new Set()
  persist()
  const keys = (x) => (x ? x.split(',').sort() : [])
  const fixedKeys = spec.reset_fixed || keys(fixed)
  return JSON.stringify({ reset: true, removed, kept: spec.reset_kept || keys(keep), fixed: fixedKeys, carried_tbd: spec.carried_tbd || {}, ...(spec.reset_no_fixed_sha ? {} : { fixed_sha256: fixedShas(fixedKeys, null) }), ...(spec.entry_digest ? { entry_digest: spec.entry_digest } : {}) })
}
const setFlow = (x) => {
  touch('flow')
  flowSha = x
  disk.flow = x
  persist()
}
const at = (key, stage) => (spec[key] || {})[stage]
if (spec.failed_current_at) throw new Error('failed_current_at は使わない（不合格は verifier の put と要素の版から出る）')
// rewrite: flow を書く役（planner の流れの仕事・flow を書く resolver）が unverified_at[段] の要素を書き換える。flow を書かない役の段に
// unverified_at があれば、その stdout から要素を消す世界を書いたことになるので止める。
const rewrite = (stage) => {
  if ((at('unverified_at', stage) || []).length) touch('flow')
  for (const id of at('unverified_at', stage) || []) disk.els[id] = (disk.els[id] ?? 0) + 1
  persist()
}
const readOnly = (stage) => {
  if (at('unverified_at', stage) !== undefined) throw new Error(`unverified_at["${stage}"] は flow を書かない役の段です（要素を書き換えるのは flow を書く役だけ）`)
}
const verdictAt = (id) => disk.verdicts[id] && disk.verdicts[id].v === disk.els[id] ? disk.verdicts[id].verdict : null
const put = (id, verdict, kind) => {
  touch('verifications')
  if (/^F-/.test(id) && disk.els[id] === undefined) {
    touch('flow')
    disk.els[id] = 0
  }
  const v = /^F-/.test(id) ? disk.els[id] : disk.rs[id] ? disk.rs[id].v ?? 0 : undefined
  const av = !/^F-/.test(id) && disk.rs[id] ? disk.rs[id].av ?? 0 : undefined
  disk.verdicts[id] = { verdict, ...(kind ? { kind } : {}), ...(v !== undefined ? { v } : {}), ...(av ? { av } : {}) }
  persist()
}
// resolution の版（書くたびに 1 増える）。av は候補の選択の回答（検証した候補の decision_text を value に写すだけ）で増える版。
// 合否の持ち越しは doc_check の carriesVerdict と同じ: 同じ版、問いと hold の不合格、候補の選択だけが違う問いの合格。
const writeRs = (id, row) => {
  touch('resolutions')
  disk.rs[id] = { ...row, v: disk.rs[id] ? (disk.rs[id].v ?? 0) + 1 : 0, ...(disk.rs[id] && disk.rs[id].av ? { av: disk.rs[id].av } : {}) }
}
// answered: 台帳の answer の有無（doc_check flow --rulings の has_answer）。回答を当てずに ruled で返す resolver は unanswered_ruled_at で書く。
const answerRs = (id, answered = true) => {
  touch('resolutions')
  disk.rs[id] = { ...disk.rs[id], av: (disk.rs[id].av ?? 0) + 1, ...(answered ? { has_answer: true } : {}) }
}
const rsVerdict = (id) => {
  const v = disk.verdicts[id]
  const r = disk.rs[id]
  if (!v) return null
  const sameV = (v.v ?? 0) === (r.v ?? 0)
  if (sameV && (v.av ?? 0) === (r.av ?? 0)) return v
  if (['hold', 'question'].includes(r.ruling) && v.verdict === 'fail') return v
  return r.ruling === 'question' && v.verdict === 'pass' && sameV ? v : null
}
// rulings: doc_check flow --rulings のときだけ resolutions を出す（プロンプトが --rulings を付け忘れた呼び出しの stdout は、script が受け取らない）。
// answer_holds: 依頼者のその問いへの回答を根拠にした hold として doc_check が数える ID（evidence がその ID の回答の節を引く）。台帳で hold のときだけ出す。
// 節は answers/g1.md の 1 行目（answerSection）。
const answerSection = (id) => ({ id, file: 'answers/g1.md', from: 1, to: 1 })
// spec_layer_ids: 台帳で layer が「手段」で upstream_revision の無い resolution（仕様書だけを書く run の仕様の論点）。doc_check flow --rulings と
// 同じく、ruling が question の行にだけ spec_layer: true を付ける（question でない行に付けると、script の取り違えを stub が隠す）。
const specLayer = (id) => ((spec.spec_layer_ids || []).includes(id) && disk.rs[id].ruling === 'question' ? { spec_layer: true } : {})
const rulingRowsOnDisk = () =>
  Object.keys(disk.rs).sort().map((id) => {
    const v = rsVerdict(id)
    return { id, about: disk.rs[id].about ?? null, ruling: disk.rs[id].ruling ?? null, has_answer: Boolean(disk.rs[id].has_answer), verdict: v ? v.verdict : null, ...(v && v.verdict === 'fail' ? { fail_kind: v.kind ?? null } : {}), ...specLayer(id) }
  })
// cites: 要素が出典に引く裁定（{ 要素: RS- }）。planner の流れの仕事が cites_at[流れの鍵] で書き、uncites_at[流れの鍵] で外す。
// unsettled_refs は doc_check の wsFlow と同じく W から出す: 引いた裁定の今の版が合格していない・hold・answer の無い question なら挙げる（設計 3.10）。
const unsettledRefs = () => Object.entries(disk.cites || {}).sort().filter(([, ref]) => {
  const r = disk.rs[ref]
  if (!r) return false
  const v = rsVerdict(ref)
  return !v || v.verdict !== 'pass' || r.ruling === 'hold' || (r.ruling === 'question' && !r.has_answer)
}).map(([el, ref]) => ({ el, ref }))
const onDisk = (rulings) => ({
  unsettled_refs: unsettledRefs(),
  answer_holds: (spec.answer_holds || []).filter((id) => disk.rs[id] && disk.rs[id].ruling === 'hold').sort().map(answerSection),
  unverified: Object.keys(disk.els).sort().filter((id) => verdictAt(id) !== 'pass'),
  failed_current: Object.keys(disk.els).sort().filter((id) => verdictAt(id) === 'fail'),
  ...(rulings ? {
    resolutions: rulingsCompact(rulingRowsOnDisk()),
  } : {}),
})
const asksRulings = (prompt) => /doc_check\.mjs flow --workspace \S+ --rulings`/.test(prompt)
// open_only_at・stale_refs_at・pair_keys_at・open_ids_at: 段（label の 2 つ目）ごとの doc_check flow / conflicts の stdout の一覧（要素の中身の事実）。
// flow_codes_at: 段ごとの指摘の符号と場所。無ければ件数の分だけ、flow を書くどの役にも直せる符号（FLOW_DANGLING）にする。
// latest: 最後に出した doc_check flow の stdout（W は 1 つなので、flow も台帳も書かない呼び出しの後にも残る）。flow.json を書かない resolver と
// flow-check は、自分の段の *_at が無ければこれを見る（書き換えたことは *_at か recheck_as で明示する）。
let latest = null
let writerDisk = null
const WORLD_AT = ['flow_codes_at', 'flow_findings_at', 'open_only_at', 'stale_refs_at', 'open_ids_at']
const explicitAt = (stage) => WORLD_AT.some((k) => at(k, stage) !== undefined)
// keep: 組は flow.json・decisions.json で決まり verifier は書かないので、verifier の stdout は既定で最後の世界の組を出す（verifier_pair_keys_at で上書き）。
// framer: open.json を書く流れの仕事（planner）の stdout か（O- の既定は framerOpens の上）。
const flowStdout = (count, sha, stage, keep, framer, rulings) => {
  const codes = at('flow_codes_at', stage) || (count ? { FLOW_DANGLING: Array.from({ length: count }, (_, i) => `F-8${String(i).padStart(2, '0')}`) } : {})
  const findings = Object.values(codes).reduce((n, xs) => n + xs.length, 0)
  latest = { findings, codes, open: spec.flow_open || 0, path: 'checks/flow.json', digest: 'fd', open_only: at('open_only_at', stage) || [], stale_refs: at('stale_refs_at', stage) || [], open_ids: at('open_ids_at', stage) || (framer ? (stage === 'framer' ? framerOpens() : []) : latest ? latest.open_ids : disk.open_ids || []), pair_keys: (keep && (at('verifier_pair_keys_at', stage) || (latest && latest.pair_keys))) || at('pair_keys_at', stage) || [] }
  return JSON.stringify({ ...latest, content_sha256: sha, ...onDisk(rulings) })
}
// open.json は planner の流れの仕事だけが書くので、その stdout の O- は open_ids_at（planner:1 は無ければ flow_open の件数）で決め、ほかの役の
// stdout は最後の世界の O- を出す。planner が足した O- は W（disk.open_ids）に残り、前の run の後の入口の flow-check もそれを数える。
// flow_open だけのときは、段 3 の resolver が返す裁定の about の O-（件数に足りなければ O-001 から）にする（段 3 が裁定し終えた W になる）。
const framerOpens = () => {
  if (at('open_ids_at', 'framer')) return at('open_ids_at', 'framer')
  const ruled3 = ['ruled_at', 'questions_at', 'holds_at'].flatMap((k) => at(k, '3') || []).map((id) => about(id).open).filter(Boolean)
  const pad = Array.from({ length: spec.flow_open || 0 }, (_, i) => `O-${String(i + 1).padStart(3, '0')}`)
  return [...new Set([...ruled3, ...pad])].slice(0, Math.max(spec.flow_open || 0, 0)).sort()
}
const latestStdout = (sha, rulings) => (latest ? JSON.stringify({ ...latest, content_sha256: sha, ...onDisk(rulings) }) : flowStdout(0, sha, null, false, false, rulings))
const conflictsStdout = (stage) => JSON.stringify({ pairs: (at('pair_keys_at', stage) || []).length, path: 'checks/conflicts.json', digest: 'c', pair_keys: at('pair_keys_at', stage) || [] })
const ids = (text, re) => [...new Set(String(text).match(re) || [])]
// questionsStdout: doc_check questions --check と同じく、answer の残った問いも不合格にする。broken は形の崩れた問い（先頭の 1 件）。
const questionsStdout = (asked, broken) => {
  const badIds = [...new Set([...(broken ? [asked[0]] : []), ...asked.filter((id) => disk.rs[id] && disk.rs[id].has_answer)])]
  const why = (id) => (disk.rs[id] && disk.rs[id].has_answer ? `${id}: 回答（answer）が残っています` : `${id}: 候補が 1 個です`)
  return JSON.stringify({ check: true, ids: asked, questions: asked.length - badIds.length, findings: badIds.length, bad_ids: badIds, bad: badIds.map(why) })
}
const about = (id) => (spec.about || {})[id] || { open: `O-${id}` }
// state から始めた W の open.json は、段 1 の planner が書いたものにする。
if (!saved && st0.flow_digest) disk.open_ids = framerOpens()
const TX_ROLES = ['planner', 'resolver', 'verifier', 'writer']
// plannedRan: この run で起動した planner の段（'1'・'3b'・'<段>-settle[-n]'）。保険の resolver（resolver:3・resolver:3b・resolver:<tag>-opens|-pairs）は、
// その planner が起動していれば（か planner_leaves_at にその段があれば）planner が残した ID（planner_leaves_at）だけを返す（同じ RS を二度返さない）。
const plannedRan = new Set()
const uniq = (xs) => [...new Set(xs)]
// planCovers: doc_check plan の stdout の covers。既定では仕様文書 specifications/<t> が同じ topic の requirements/<t> を実現する。
const planCovers = () => spec.covers || Object.fromEntries((spec.units || []).flatMap((u) => u.docs).filter((k) => k.startsWith('specifications/')).map((k) => [k, [`requirements/${k.split('/')[1]}`]]))

// planUnits: doc_check plan の stdout の units（plan.json の units の写し。script の state.units はここからだけ入る）。
const planUnits = () => spec.units || [{ id: 'U-1', docs: ['requirements/x'], depends_on: [] }]

// intakePart: 仕分けの仕事の返り値（planner:1 の plan_check）。plan_findings は label の別名（planner:1 → intake、planner:1:rework → intake:rework）で引く。
const intakePart = (key) => {
  const plan = (spec.plan_findings || {})[key]
  return { plan_check: plan === null ? '' : JSON.stringify({ findings: plan || 0, path: 'checks/plan.json', digest: 'p', content_sha256: H('plan'), covers: planCovers(), units: planUnits() }), ...(spec.intake_units ? { units: spec.intake_units } : {}) }
}
// framePart: 流れの仕事の返り値（flow_check・conflicts_check）。k は流れの鍵（planner:1 → framer、planner:3b → 3b-reframe、planner:<tag> → <tag>、
// 差し戻しは rework・3b-reframe-rework・<tag>-rework）。shaKey は書いた flow.json の sha の名前（差し戻しは元の起動と同じ名前。今の stub と同じ）。
const framePart = (prompt, k, shaKey) => {
  setFlow(H(`f-${shaKey}`))
  rewrite(k)
  // cites_at・uncites_at: 流れの仕事が要素の出典に書く（外す）裁定（{ 要素: RS- } と [要素]）。書いた要素は版が 1 増える。
  for (const [el, ref] of Object.entries(at('cites_at', k) || {})) {
    disk.cites = { ...(disk.cites || {}), [el]: ref }
    disk.els[el] = (disk.els[el] ?? 0) + 1
  }
  for (const el of at('uncites_at', k) || []) {
    if (disk.cites) delete disk.cites[el]
    disk.els[el] = (disk.els[el] ?? 0) + 1
  }
  const out = { flow_check: flowStdout(at('flow_findings_at', k) || (spec.broken_flow ? 1 : 0), flowSha, k, false, true), conflicts_check: conflictsStdout(k) }
  // lint_at: flow --lint を指示された流れの仕事の lint の件数（lint はこの stdout だけに載り、latest に入れない）。
  if (/doc_check\.mjs flow --workspace \S+ --lint`/.test(prompt) && at('lint_at', k) !== null) {
    const n = at('lint_at', k) || 0
    out.flow_check = JSON.stringify({ ...JSON.parse(out.flow_check), lint: n, lint_codes: n ? { LINT_OBTAIN_UNGROUNDED: Array.from({ length: n }, (_, i) => `F-9${String(i).padStart(2, '0')}`) } : {}, lint_path: 'checks/flow.lint.json' })
  }
  const opens = [...new Set([...(disk.open_ids || []), ...latest.open_ids])].sort()
  if (JSON.stringify(opens) !== JSON.stringify(disk.open_ids)) touch('open')
  disk.open_ids = opens
  persist()
  if ((spec.no_conflicts_check_at || []).includes(k)) delete out.conflicts_check
  return out
}
// askedIds: プロンプトの `questions --ids <ID,…> --check` の ID（複数あれば和）と、差し戻しの note が名指しした前の体の問い
// （「前の体が question にした <ID> も含める」。設計 3.3a の note の文）。
const askedIds = (prompt) => uniq([...[...String(prompt).matchAll(/--ids (\S+) --check/g)].flatMap((m) => ids(m[1], /RS-\d+/g)),
  ...ids((/前の体が question にした ([^\n]*?) も含める/.exec(String(prompt)) || [])[1], /RS-\d+/g)])
// resolve: 裁定の仕事（resolver と planner の裁定）。keys: 裁定の一覧（ruled_at など）を引く段の鍵（settle の planner は <tag>-opens と <tag>-pairs の和）。
// only: この ID だけを返す（保険の resolver）。drop: この ID を返さない（planner_leaves_at）。planner: flow を返さない裁定の仕事（stdout は流れの仕事のもの）。
const resolve = (prompt, stage, { keys = [stage], only = null, drop = [], planner = false } = {}) => {
  const atL = (key) => (keys.every((k) => at(key, k) === undefined) ? undefined : keys.flatMap((k) => at(key, k) || []))
  const keep = (id) => (!only || only.includes(id)) && !drop.includes(id)
  // fresh_ids: 新しく裁定する呼び出しは、前の run が W に残した ID を使わずに新しい ID を振る（実物の resolver は台帳の続きの番号を取る）。
  // 同じ ID を書き換える呼び出し（差し戻し・変換・保持規則への変換・回答の反映・形の修正）は ID を変えない。
  const renames = spec.fresh_ids && !/(-convert|-convert-kind|-toquestion|-(re)?hold|-questions(-\d+)?|-flow(-\d+)?|-fix)$/.test(stage) && !['3a', "3a'"].includes(stage)
  const fresh = (id) => (renames && preexisting.has(id) ? `RS-${Number(id.slice(3)) + 500}` : id)
  const as = (id) => ({ id: fresh(id), about: about(id) })
  const kept = (xs) => xs.filter(keep)
  // 変換（-convert）と書き換え直し（-convert-kind・-toquestion）は、その段の ruled_at・questions_at・holds_at が無ければ求められたとおりの種類で ID を返す（契約どおりの resolver）。
  const convert = /-(convert|convert-kind|toquestion)$/.test(stage) && ['ruled_at', 'questions_at', 'holds_at'].every((k) => atL(k) === undefined) ? [...prompt.matchAll(/- (RS-\d+) → (question|hold)/g)] : []
  // questions_seq_at: 同じ label の呼び出しごとに違う問いを返す（r1 の後の段 6 は裁定し、延長の段 6 は問いを返す、など）。尽きたら questions_at。
  const qseq = (spec.questions_seq_at || {})[stage]
  const q = [...((qseq && qseq.length ? qseq.shift() : atL('questions_at')) || []), ...convert.filter((m) => m[2] === 'question').map((m) => m[1])].filter(keep).map(as)
  // ruled_seq_at: 同じ label の呼び出しごとに違う裁定を返す（パスごとの段 6 など）。
  const seq = (spec.ruled_seq_at || {})[stage]
  // 差し戻し（-fix）は、その段の ruled_at・questions_at・holds_at・free_text_at が無ければ落ちた RS- を値の裁定で返す（根拠を補えた、契約どおりの resolver）。
  const fixed = /-fix$/.test(stage) && ['ruled_at', 'questions_at', 'holds_at', 'free_text_at'].every((k) => atL(k) === undefined) ? [...prompt.matchAll(/^- (RS-\d+): /gm)].map((m) => m[1]) : []
  const ruled = kept((seq && seq.length ? seq.shift() : atL('ruled_at')) || fixed).map(as)
  // 聞くゲートの無い問いの変換（-hold）は、holds_at が無ければ求められた ID をそのまま hold で返す（契約どおりの resolver）。
  const heldIds = atL('holds_at') || (/-(re)?hold$/.test(stage) ? ids((/ID は変えない: ([^\n]*)/.exec(prompt) || [])[1], /RS-\d+/g) : convert.filter((m) => m[2] === 'hold').map((m) => m[1]))
  const holds = kept(heldIds).map(as)
  // 回答を当てた問い（3a・3a' の ruled）は、同じ ID の question に answer を足すだけで ruling は question のまま（契約の question（answer あり））。
  const answers = ['3a', "3a'", '3a-fix'].includes(stage)
  const chose = (x, ruling) => answers && ruling === 'internal' && (disk.rs[x.id] || {}).ruling === 'question'
  const unanswered = atL('unanswered_ruled_at') || []
  // answered_by_at: ruled で返す裁定のうち、既にある回答を当てた answered_by の ID（回答の当たった問いではない）。
  const answeredBy = atL('answered_by_at') || []
  for (const [xs, ruling] of [[ruled, 'internal'], [q, 'question'], [holds, 'hold']]) for (const x of xs) chose(x, ruling) ? answerRs(x.id, !unanswered.includes(x.id)) : writeRs(x.id, { about: x.about, ruling: answeredBy.includes(x.id) ? 'answered_by' : ruling })
  const freeText = kept(atL('free_text_at') || [])
  for (const id of freeText) writeRs(id, { about: disk.rs[id] ? disk.rs[id].about : about(id), ruling: 'question', has_answer: true })
  // silent_answers_at: 回答を台帳に当てたが、返り値のどこにも載せなかった問い。
  for (const id of atL('silent_answers_at') || []) answerRs(id)
  // 問いの形の修正は、直した問いの question・options を書き換える（合格は持ち越さない）。
  if (/-questions(-\d+)?$/.test(stage)) for (const id of ids((/--ids (\S+) --check/.exec(prompt) || [])[1], /RS-\d+/g)) if (disk.rs[id] && !q.some((x) => x.id === id)) writeRs(id, { about: disk.rs[id].about, ruling: disk.rs[id].ruling })
  // orphans_at: 台帳に書いたが返さない hold（応答した呼び出しが返り値に載せなかった裁定。所有表の外の書き込みと同じく W にだけ残る）。
  for (const id of atL('orphans_at') || []) writeRs(id, { about: about(id), ruling: 'hold' })
  persist()
  // resolutions.json の sha256 は中身で決まる（同じ中身を書き直しても変わらない）。版の数（v・av）も中身に数える。
  sha = H(`rs-${hash(JSON.stringify(Object.entries(disk.rs).sort().map(([id, r]) => [id, r.about, r.ruling, r.v ?? 0, r.av ?? 0])))}`)
  disk.rs_sha = sha
  persist()
  const out = { ruled, questions: q, holds, supersedes: atL('supersedes_at') || [], free_text: freeText, ...(planner ? {} : { routes: atL('routes_at') || [] }), [spec.resolver_sha_key || 'resolutions_sha256']: sha }
  if (planner) return out
  // 検査する問いを script が名指ししたプロンプト（問いの形の修正・書き換え直しを写す呼び出し）は、その ID を検査する（契約どおりの resolver）。
  const named = /返る前に `[^`]*doc_check\.mjs questions --workspace \S+ --ids (RS-[^ `]+) --check`/.exec(prompt)
  const checked = at('questions_check_ids_at', stage) || (/-questions(-\d+)?$/.test(stage) ? ids((/--ids (\S+) --check/.exec(prompt) || [])[1], /RS-\d+/g) : named ? ids(named[1], /RS-\d+/g) : q.map((x) => x.id))
  if (checked.length) {
    out.questions_check = questionsStdout(checked, (spec.bad_questions_at || []).includes(stage))
  }
  const keepsFlow = prompt.includes('この呼び出しでは flow.json を書かない')
  const returnsFlow = ["3a", "3a'", '3a-fix'].includes(stage) || /-flow(-\d+)?$/.test(stage) || keepsFlow || at('flow_sha_at', stage) !== undefined
  if (keepsFlow) readOnly(stage)
  else if (returnsFlow && at('flow_sha_at', stage) !== undefined) rewrite(stage)
  else readOnly(stage)
  if (returnsFlow && !(spec.no_flow_check_at || []).includes(stage)) {
    if (at('flow_sha_at', stage) !== undefined) setFlow(H(at('flow_sha_at', stage)))
    // resolver_rulings_at: --rulings を付けて doc_check flow を実行した resolver（stdout に resolutions が載る）。
    const withRulings = (spec.resolver_rulings_at || []).includes(stage)
    // resolver_claims_sha_at: flow.json を書いたのに、stdout の content_sha256 に別の版（書く前の版など）を載せた resolver。
    const claimed = at('resolver_claims_sha_at', stage) !== undefined ? H(at('resolver_claims_sha_at', stage)) : flowSha
    out.flow_check = keepsFlow && !explicitAt(stage) ? latestStdout(claimed, withRulings) : flowStdout(at('flow_findings_at', stage) || 0, claimed, stage, false, false, withRulings)
    // claimed_answer_holds_at: 台帳に無い answer_holds を stdout に載せた resolver（保留の hold だと偽った申告）。
    if (at('claimed_answer_holds_at', stage)) out.flow_check = JSON.stringify({ ...JSON.parse(out.flow_check), answer_holds: at('claimed_answer_holds_at', stage).map(answerSection) })
    // resolver_lint_at: --lint を付けて doc_check flow を実行した resolver（stdout に lint の欄が載る）。
    if ((spec.resolver_lint_at || []).includes(stage)) out.flow_check = JSON.stringify({ ...JSON.parse(out.flow_check), lint: 1, lint_codes: { LINT_OBTAIN_UNGROUNDED: ['F-900'] }, lint_path: 'checks/flow.lint.json' })
    if (!keepsFlow && !(spec.no_conflicts_check_at || []).includes(stage)) out.conflicts_check = conflictsStdout(stage)
  }
  return out
}

// quotesOf: 指名された whole reviewer が実行する doc_check quotes の stdout（designated.quotes）。プロンプトに quotes のコマンドがあるときだけ返す。
// files はコマンドの --findings の名前、ids はその回の writer reviewer の指摘、tree_digest はその回の audited の digest（監査の間は誰も本文を書かない）。
// unquoted_at: { <監査の段 r<n>>: [ID] }。引用がどの原文にも無い（not_found）指摘。quotes_files_at・quotes_digest_at: files・tree_digest の差し替え
// （照らした findings か版が期待と違う stdout）。no_quotes_at: [r<n>]。quotes を返さない回。どの鍵もコマンドの有無によらず引く（quotes を指示しない
// script では、鍵を引かなかったことではなく、退けたか・integrity に出したかの照合で落ちる）。
const wrIds = {}
const quotesOf = (prompt, stage, n) => {
  const unquoted = at('unquoted_at', stage) || []
  const silent = (spec.no_quotes_at || []).includes(stage)
  const files0 = at('quotes_files_at', stage)
  const digest0 = at('quotes_digest_at', stage)
  const m = /doc_check\.mjs quotes --workspace \S+ --findings (\S+?)`/.exec(prompt)
  if (!m || silent) return {}
  const files = files0 !== undefined ? files0 : m[1].split(',')
  const digest = digest0 !== undefined ? H(digest0) : H(`a${n}`)
  const idsQ = wrIds[stage] || []
  return { quotes: JSON.stringify({ findings: idsQ.length, files, ids: idsQ, unquoted, path: `checks/quotes-${stage}.json`, tree_digest: digest }) }
}

// 形式検証の接続（workflow-io.md と agent-contracts.md「## 形式検証の事実」）。doc_check formal-request・formal-status の stdout は、label ではなくプロンプトのコマンドで返す
// （formal-request を実行させる呼び出しの label は設計が決めていない）。
// formal_request_at: { <rid>: 目標の数 | { goals, units } }。無い rid は送る単位 0（goals: 0）。
// formal_status_at: { <rid>: { outcome, counts, cex_docs, rid, fnv, units_digest_ok, tree_moved } }（rid・fnv は stdout の値の差し替え）。無い rid は outcome result・反例 0。
// request の fnv と tree_digest は disk.formal に控え、formal-status の照合の既定値にする（world が無い run は同じ式で求め直す）。
const formalFnv = (rid) => hash(`req-${rid}`)
const formalRequestStdout = (rid) => {
  const fr = at('formal_request_at', rid)
  const goals = fr === undefined ? 0 : typeof fr === 'number' ? fr : fr.goals
  const tree = treeDigestOf(disk.docs || {})
  if (goals) disk.formal = { ...(disk.formal || {}), [rid]: { fnv: formalFnv(rid), tree } }
  persist()
  return JSON.stringify({ rid, goals, units: goals ? (typeof fr === 'object' && fr.units) || 1 : 0, unsent: [], tree_digest: tree,
    ...(goals ? { request_digest: H(`rq-${rid}`), request_fnv: formalFnv(rid), cwd: '/tmp/prd-w.formal' } : {}) })
}
const formalStatusStdout = (rid) => {
  const base = (disk.formal || {})[rid] || { fnv: formalFnv(rid), tree: treeDigestOf(disk.docs || {}) }
  const st = at('formal_status_at', rid) || {}
  const counts = { verified: 0, counterexample: 0, overlap: 0, unverified: 0, undetected: 0, ...(st.counts || {}) }
  return JSON.stringify({ rid: st.rid ?? rid, fnv: st.fnv ?? base.fnv, units_digest_ok: st.units_digest_ok ?? true, outcome: st.outcome === undefined ? 'result' : st.outcome,
    tree_digest_request: base.tree, tree_digest_now: st.tree_moved ? H('tree-moved') : base.tree, counts, cex_docs: st.cex_docs ?? (counts.counterexample ? ['requirements/x'] : []) })
}
const formalParts = (prompt) => {
  const out = {}
  const req = /doc_check\.mjs formal-request [^`\n]*/.exec(prompt)
  const rid = (cmd) => (/--rid (\w+)/.exec(cmd) || [])[1]
  if (req) out.formal_check = formalRequestStdout(rid(req[0]))
  const status = /doc_check\.mjs formal-status [^`\n]*/.exec(prompt)
  if (status) out.formal_status = formalStatusStdout(rid(status[0]))
  return out
}
const KNOWN_ROLES = ['planner', 'resolver', 'flow-check', 'verifier', 'writer', 'writerReviewer', 'wholeReviewer']
function respond(prompt, label) {
  const extra = formalParts(prompt)
  if (Object.keys(extra).length && !KNOWN_ROLES.includes(label.split(':')[0])) return extra
  const out = respondCore(prompt, label)
  return out && typeof out === 'object' ? { ...out, ...extra } : out
}
function respondCore(prompt, label) {
  const base = label
  const [role, stage, target] = base.split(':')
  curToken = (/^トークン: (\S+)$/m.exec(prompt) || [])[1] || null
  if (TX_ROLES.includes(role) && !curToken) throw new Error(`${label}: 台帳を書く役のプロンプトにトークンがありません`)
  if (role === 'planner') {
    // planner: 1 回の起動で仕事を続けて行う（planner:1 は仕分け → 流れ → 裁定、planner:3b・planner:<段>-settle[-n] は流れ → 裁定）。
    // 仕事ごとに今の spec の鍵を読む: 仕分けは plan_findings[intake]、流れは framer・3b-reframe・<tag>、裁定は 3・3b・<tag>-opens と <tag>-pairs の和。
    // 差し戻し（planner:<…>:rework）は、仕分けは intake:rework、流れと裁定は流れの鍵に -rework を足したもの（planner:1:rework は rework）。
    const rework = target === 'rework'
    const pk = stage
    if (!rework) plannedRan.add(pk)
    const fk = pk === '1' ? (rework ? 'rework' : 'framer') : pk === '3b' ? (rework ? '3b-reframe-rework' : '3b-reframe') : rework ? `${pk}-rework` : pk
    const rk = rework ? [fk] : pk === '1' ? ['3'] : pk === '3b' ? ['3b'] : [`${pk}-opens`, `${pk}-pairs`]
    const out = pk === '1' ? intakePart(rework ? 'intake:rework' : 'intake') : {}
    Object.assign(out, framePart(prompt, fk, pk === '1' ? (rework ? 'rework' : 'framer') : pk === '3b' ? '3b-reframe' : pk))
    // planner_leaves_at: { <planner の段>: [RS-…] }。planner が裁定の鍵から除いて返す ID（about は世界に残り、script は残りとして保険の resolver に回す）。
    const leaves = rework ? [] : at('planner_leaves_at', pk) || []
    Object.assign(out, resolve(prompt, rk[0], { keys: rk, drop: leaves, planner: true }))
    // questions_check: プロンプトの --ids の ID（回答待ちの問い）と、この起動で question にした ID の和を 1 回検査する。
    const asked = at('questions_check_ids_at', rk[0]) || uniq([...askedIds(prompt), ...out.questions.map((x) => x.id)])
    if (asked.length) out.questions_check = questionsStdout(asked, [fk, ...rk].some((k) => (spec.bad_questions_at || []).includes(k)))
    // planner_sha_at: { <planner の段>: 名前 }。台帳と違う resolutions_sha256 を返す planner（裁定の欄が空でも sha を返すので、その値を取り込むかを確かめる）。
    if (!rework && at('planner_sha_at', pk) !== undefined) out.resolutions_sha256 = H(at('planner_sha_at', pk))
    return out
  }
  if (role === 'resolver') {
    // 保険の resolver: 同じ段の planner が起動した後（か planner_leaves_at にその段があるとき）は、planner が残した ID だけを、planner と同じ鍵から返す。
    const pk = stage === '3' ? '1' : stage === '3b' ? '3b' : (/^(.+-settle(?:-\d+)?)-(?:opens|pairs)$/.exec(stage) || [])[1]
    if (pk !== undefined && (plannedRan.has(pk) || Object.hasOwn(atRaw.planner_leaves_at || {}, pk))) {
      const keys = pk === '1' || pk === '3b' ? [stage] : [`${pk}-opens`, `${pk}-pairs`]
      return resolve(prompt, stage, { keys, only: at('planner_leaves_at', pk) || [] })
    }
    return resolve(prompt, stage)
  }
  if (role === 'flow-check') {
    // recheck_as: 変換の resolver の申告と違う世界を flow-check に見せる（resolver の stdout の過少申告）。無ければ最後の世界（latest）を見る。
    const k = (spec.recheck_as || {})[stage]
    readOnly(stage)
    // backup だけのプロンプト（writer の backup_check の写しの取り直しと同じコマンド）。同じ token の 2 回目は控えを取り直さず、控えの版を返す。
    const backup = BACKUP_CMD.exec(prompt)
    if (backup) {
      curToken = backup[2]
      touch('docs')
      persist()
      return { backup_check: JSON.stringify(backupStdout(backup[2], backupKeys(backup[1]))) }
    }
    const reset = /doc_check\.mjs reset --workspace \S+(?: --keep (\S+?))?(?: --fixed (\S+?))?`/.exec(prompt)
    if (reset) return (spec.no_reset_at || []).includes(base) ? {} : { reset_check: resetWorld(reset[1], reset[2]) }
    // 1 つのプロンプトの restore → flow → answers を順に実行する（入口の flow-check。restore は flow より先に W を戻す）。
    // flow の stdout はプロンプトが doc_check flow を挙げたときだけ返す（数え直さない flow-check の返り値に flow_check を載せない）。
    const out = {}
    const tx = /doc_check\.mjs restore --workspace \S+ --token (\S+?)`/.exec(prompt)
    if (tx && !(spec.no_restore_at || []).includes(base)) out.restore_check = restoreTx(tx[1], base)
    if (/doc_check\.mjs flow --workspace /.test(prompt)) {
      const rulings = asksRulings(prompt)
      out.flow_check = k ? flowStdout(at('flow_findings_at', k) || 0, flowSha, k, false, false, rulings) : latestStdout(flowSha, rulings)
    }
    const answers = /doc_check\.mjs answers --workspace \S+ --file (\S+) --ids (\S+?)`/.exec(prompt)
    if (answers) {
      const asked = [...new Set(answers[2].split(','))].sort()
      const has = disk.answers[answers[1]] ?? (answeredBeforeCall ? asked : undefined)
      // answers_free: 回答のファイルごとの、候補の label だけでない回答の節（doc_check answers の free）。
      const free = ((spec.answers_free || {})[answers[1]] || []).filter((x) => asked.includes(x.id))
      // answers_stdout: flow-check が返した answers の stdout（実行したコマンドと違う file・ids の stdout を返した世界）。
      out.answers_check = JSON.stringify(spec.answers_stdout || { file: answers[1], exists: Boolean(has), ids: asked, missing: asked.filter((id) => !(has || []).includes(id)), free })
    }
    return out
  }
  if (role === 'verifier') {
    const asked = ids(prompt.split('検証する resolution の ID:')[1].split('\n')[0], /RS-\d+/g)
    // fails_when_asked: 検証を求められたら必ず落ちる項目（検証に落ちた要素を渡し直したときの実物の振る舞い）。
    const whole = prompt.includes(spec.verify_all_mark) ? onDisk().unverified.filter((id) => !onDisk().failed_current.includes(id)) : []
    const fail = [...(at('verifier_fail', stage) || []), ...(spec.fails_when_asked || []).filter((f) => whole.includes(f.id) || new RegExp(`\\b${f.id}\\b`).test(prompt))]
    const failIds = fail.map((f) => f.id)
    const seen = at('verifier_flow_sha_at', stage) !== undefined ? H(at('verifier_flow_sha_at', stage)) : flowSha
    readOnly(stage)
    const listed = ids((prompt.split('あわせて検証する: flow.json の要素')[1] || '').split('\n')[0], /F-\d+/g)
    // 'unverified のうち failed_current に無い要素すべて'（prd-spec.js の VERIFY_ALL）は、実物の verifier と同じく最初の doc_check flow から対象を取る。
    const fromDisk = prompt.includes(spec.verify_all_mark) ? onDisk().unverified.filter((id) => !onDisk().failed_current.includes(id)) : []
    const all = fromDisk
    const askedFlow = [...new Set([...listed, ...all])].filter((i) => !failIds.includes(i) && !(at('ignores_at', stage) || []).includes(i))
    // unput_at: 合否を返したが verifications.json に put しなかった ID（verifier の過少な put）。ignores_at: 検証せず、返しもしない ID。
    const unput = [...(at('unput_at', stage) || []), ...(at('ignores_at', stage) || [])]
    for (const id of [...asked, ...askedFlow]) if (!failIds.includes(id) && !unput.includes(id)) put(id, 'pass')
    for (const f of fail) if (!unput.includes(f.id)) put(f.id, 'fail', f.kind)
    return {
      pass: [...asked.filter((i) => !failIds.includes(i)), ...askedFlow, ...(at('verifier_extra_pass', stage) || [])],
      fail,
      resolutions_sha256: at('verifier_resolutions_sha_at', stage) || sha,
      flow_check: flowStdout(at('verifier_flow_findings_at', stage) || 0, seen, stage, true, false, asksRulings(prompt)),
      // plan_seen: plan reviewer（段 3 の最初の検証）が実行した doc_check plan の stdout（null は返さない）。プロンプトに doc_check plan があるときだけ返す。
      ...(prompt.includes('doc_check.mjs plan ') && spec.plan_seen !== null ? { plan_check: (({ findings = 0, sha = 'plan', covers = planCovers(), units = planUnits() }) => JSON.stringify({ findings, path: 'checks/plan.json', digest: 'p', content_sha256: H(sha), covers, units }))(spec.plan_seen || {}) } : {}),
    }
  }
  if (role === 'writer') {
    // writerDisk: 最初の writer が起動した時点の W の検証の状態（検証を通っていない要素が writer に届いていないかを見る）。
    if (!writerDisk) writerDisk = onDisk(false)
    const revise = stage.endsWith('revise') || target === 'revise'
    // formal_changed: { <label>: [項目 ID] }。形式検証の反例の差し戻し（writer:<unit>:formal-<round>）の申告（既定は PR-X-001）。
    // formal_noop: [label]。差し戻しの writer が本文を変えない（申告も空）。
    const formalRw = /^formal-\d+$/.test(target || '')
    const noop = (spec.formal_noop || []).includes(label)
    const unit = stage
    const docs = (spec.units || [{ id: 'U-1', docs: ['requirements/x'] }]).find((u) => u.id === unit).docs
    // プロンプトが backup を挙げれば、最初のコマンドとして段の token で控えを取ってから書く（backup_after_edit: [label] は書いてから控える）。
    // writes_outside: { <label>: [文書キー] }。単位の外の文書にも書く writer。
    const backup = BACKUP_CMD.exec(prompt)
    if (backup && backup[2] !== curToken) throw new Error(`${label}: backup の token ${backup[2]} がプロンプトのトークン ${curToken} と違います`)
    const late = (spec.backup_after_edit || []).includes(label)
    if (backup && !late) touch('docs')
    const wrote = noop ? [] : uniq([...docs, ...((spec.writes_outside || {})[label] || [])])
    disk.docs = { ...(disk.docs || {}), ...Object.fromEntries(wrote.map((k) => [k, ((disk.docs || {})[k] ?? 0) + 1])) }
    if (backup && late) touch('docs')
    persist()
    // backup_stdout_at: { <label>: stdout の JSON }。writer が返す backup_check を差し替える（別の token・形の崩れ）。
    const told = spec.backup_stdout_at && spec.backup_stdout_at[label]
    const backupCheck = backup ? { backup_check: JSON.stringify(told !== undefined ? told : backupStdout(backup[2], backupKeys(backup[1]))) } : {}
    return {
      ...backupCheck,
      unit,
      docs: docs.map((key) => ({ key, digest: H(`w-${key}`), doc_check_findings: 0, doc_check_blocking: 0 })),
      // writer_changed_seq: パスごとの改稿の申告（label はパスをまたいで同じなので、呼ばれた順に取る）。
      changed_items: formalRw ? (noop ? [] : (spec.formal_changed || {})[label] || ['PR-X-001']) : revise ? (spec.writer_changed_seq ? spec.writer_changed_seq[reviseN++] : ((spec.writer_changed_by_unit || {})[unit] || spec.writer_changed || ['PR-X-001'])) : [],
      open_tbd: spec.open_tbd || [],
      new_tbd: revise ? spec.new_tbd_revise || [] : spec.new_tbd || [],
      // unapplied_seq: パスごとの改稿で当て損ねた指摘（呼ばれた順に取る）。
      applied_findings: revise ? minusIds(ids(prompt, /r\d+-[a-z]{2}-[A-Za-z0-9_.-]+-\d+/g), (spec.unapplied_seq || [])[unappliedN++] || []) : [],
      applied_routes: revise ? ids(prompt, /RT-\d+/g) : [],
      resolutions_sha256: sha,
    }
  }
  if (['writerReviewer', 'wholeReviewer'].includes(role)) {
    const n = Number(stage.slice(1))
    const byKey = spec.findings || {}
    // 詰め合わせの組（p1・p2…）には、その label で明示した指摘だけを返す（組ごとに同じ指摘を返すと ID が重なる）。
    const findings = (byKey[`${role}:${stage}:${target}`] || (target === 'all' ? byKey[`${role}:${stage}`] : null) || []).map((f) => ({ doc: 'requirements/x', item_id: 'PR-X-001', blocking: true, route: 'writer', direction: 'remove', origin: 'text', ...f }))
    const out = { path: `findings/${stage}-${role}.json`, findings }
    // wrIds: 回ごとに writer reviewer が返した指摘の ID（quote の照合の stdout の ids）。
    if (role === 'writerReviewer') wrIds[stage] = uniq([...(wrIds[stage] || []), ...findings.map((f) => f.id)])
    // rejected_at: { <監査の段 r<n>>: [ID] }。whole reviewer が退けるとして返す ID（script がそのうち何を退けるかを確かめる）。
    if (role === 'wholeReviewer' && Object.hasOwn(spec.rejected_at || {}, stage)) out.rejected = spec.rejected_at[stage]
    if (prompt.includes('あなたは指名された監査役')) {
      // files は snapshot の stdout に無い一覧で、script が一覧を notices に写したら next_args の上限テストが落ちるように置く。
      const listed = (count, kind) => Array.from({ length: count }, (_, i) => `tmp/writer__U-1__draft/${kind}-${String(i).padStart(3, '0')}.pre${i}.json`)
      const found = {
        stray: { count: (spec.stray_at || {})[stage] || 0, path: `checks/audited-${n}.stray.json`, files: listed((spec.stray_at || {})[stage] || 0, 'stray') },
        size_over: { count: (spec.size_over_at || {})[stage] || 0, path: `checks/audited-${n}.sizes.json`, files: listed((spec.size_over_at || {})[stage] || 0, 'size') },
        swept: { count: (spec.swept_at || {})[stage] || 0, path: `checks/audited-${n}.swept.json` },
      }
      // entry_digest_at: 監査の段（r<n>）ごとの doc の entry_digest。無ければ reset の値（spec.entry_digest）をそのまま返す。
      const entryDigest = Object.hasOwn(spec.entry_digest_at || {}, stage) ? spec.entry_digest_at[stage] : spec.entry_digest
      const docCheck = JSON.stringify({ blocking: (spec.doc_blocking_at || {})[stage] || 0, flow_refs: spec.doc_flow_refs || {}, ...(entryDigest ? { entry_digest: entryDigest } : {}) })
      const fixedFlag = /doc_check\.mjs snapshot [^`]* --fixed (\S+?)`/.exec(prompt)
      if (fixedFlag) found.fixed_sha256 = fixedShas(fixedFlag[1].split(','), stage)
      const quotes = quotesOf(prompt, stage, n)
      if (n === 1) {
        out.designated = { doc_check: docCheck, audited: JSON.stringify({ digest: H('a1'), ...found }), ...quotes }
        recordAudited(H('a1'))
      }
      else if ((spec.diff_error_at || []).includes(stage)) out.designated = { diff_error: 'doc_check diff: digest mismatch' }
      else {
        const changed = (spec.diff || {})[stage] || spec.writer_changed || ['PR-X-001']
        const firstDoc = (spec.units || [{ docs: ['requirements/x'] }])[0].docs[0]
        const byDoc = (spec.by_doc || {})[stage] || { [firstDoc]: { changed, added: [], removed: [] } }
        out.designated = {
          diff: { stdout: '{}', changed, added: [], removed: [], by_doc: byDoc },
          audited: JSON.stringify({ digest: H(`a${n}`), ...found }),
          doc_check: docCheck,
          tree_digest: JSON.stringify({ digest: H(`t${n}`) }),
          ...quotes,
        }
        recordAudited(H(`a${n}`))
      }
    }
    return out
  }
  throw new Error(`unknown label ${label}`)
}
// budget: runtime の budget と同じ形（total・spent()・remaining()）。agent を 1 回起動するたびに per_call（既定 1）を使い、spent() が
// total に達した後の agent() は throw する（runtime と同じ）。spec.budget が無ければ globalThis.budget を置かない（budget の無い実行環境。budgetOut は常に false）。
let spent = (spec.budget && spec.budget.spent) || 0
if (spec.budget) globalThis.budget = { total: spec.budget.total, spent: () => spent, remaining: () => (spec.budget.total == null ? Infinity : Math.max(0, spec.budget.total - spent)) }
const findingFiles = []
const prompts = []
let auditSchema = null
const optsSeen = {}
let resolverSchema = null
let attempted = 0
// stubErrors: stub の契約違反（知らない label・model / effort の無い呼び出し・meta.phases に無い phase）。script は agent() の例外を
// blocked に変えるので、ここに積んで run() が落とす（blocked の結果だけを見ると、違反が「止まるべき所で止まった」に化ける）。
const stubErrors = []
const phaseTitles = new Set(__meta.phases.map((p) => p.title))
// throw_labels: その label の agent() を例外で終わらせる（runtime の schema 検証の失敗などの、予算以外の例外）。
// cache: resumeFromRunId の再生（本家 WF「Resume after a pause」・WA「Resume」）。前の run の calls のうち、起動の順で label とプロンプトが
// 変わらない最長の前置きを保存された結果で返す（stubAgent を通さないので W に書かず、labels にも載らない）。結果を返さずに終わった呼び出しと、
// 最初に変わった呼び出しから後は live で走る。calls は起動の順の (label, prompt, 結果) で、次の run の cache に渡す。
const calls = []
const replayed = []
let live = !spec.cache
const agent = async (prompt, opts) => {
  if (!phaseTitles.has(opts.phase)) stubErrors.push(`${opts.label}: opts.phase「${opts.phase}」が meta.phases に無い`)
  const rec = { label: opts.label, prompt, opts: { ...opts }, result: null }
  const saved = live ? null : spec.cache[calls.length]
  calls.push(rec)
  if (!live && saved && saved.label === opts.label && saved.prompt === prompt && saved.result != null) {
    replayed.push(opts.label)
    rec.result = saved.result
    return saved.result
  }
  live = true
  if ((spec.throw_labels || []).includes(opts.label)) {
    attempted += 1
    labels.push(opts.label)
    throw new Error(`stub: ${opts.label} の例外`)
  }
  try {
    rec.result = await stubAgent(prompt, opts)
    return rec.result
  } catch (e) {
    if (e.message !== 'budget exhausted') stubErrors.push(`${opts.label}: ${e.message}`)
    throw e
  }
}
const stubAgent = async (prompt, opts) => {
  attempted += 1
  if (spec.budget && spec.budget.total != null && spent >= spec.budget.total) throw new Error('budget exhausted')
  spent += (spec.budget && spec.budget.per_call) || 1
  labels.push(opts.label)
  if (['writerReviewer', 'wholeReviewer'].includes(opts.label.split(':')[0])) auditSchema = opts.schema
  if (opts.label.startsWith('resolver:')) resolverSchema = opts.schema
  // tamper_before: その label の agent が動く前に、所有表の外の誰かが flow.json を書き換えたことにする。
  if ((spec.tamper_before || {})[opts.label] !== undefined) {
    flowSha = H(spec.tamper_before[opts.label])
    disk.flow = flowSha
    persist()
  }
  prompts.push({ label: opts.label, prompt })
  optsSeen[opts.label] = { model: opts.model ?? null, effort: opts.effort }
  const m = /findings\/(r\d+-[^\s/]+?)\.json に書き/.exec(prompt)
  if (m) findingFiles.push(m[1])
  // inherit_labels: role_opts の inherit で model を外した役の label の接頭辞（その役だけ model が無くてよい）。
  if (!opts.effort || (!opts.model && !(spec.inherit_labels || []).some((x) => opts.label.startsWith(x)))) throw new Error(`model / effort が無い呼び出し: ${opts.label}`)
  if (nulls.has(opts.label)) return null
  // silent_after_write: W に書いてから応答しない呼び出し（書き込みは残り、返り値は無い）。
  const got = opts.label.endsWith('-recopy') ? recopied(prompt) : stamped(respond(prompt, opts.label))
  return (spec.silent_after_write || []).includes(opts.label) ? null : corrupt(opts.label, got)
}
// STDOUT_KEYS: 返り値のうち doc_check の stdout を写す欄（designated の中も）。truth は最後に返した写す前の stdout で、取り直し（-recopy）は
// 同じ W で同じコマンドを実行し直すので、それをそのまま返す（取り直しの間に W を書く役はいない）。
const STDOUT_KEYS = ['flow_check', 'conflicts_check', 'plan_check', 'questions_check', 'answers_check', 'restore_check', 'reset_check', 'backup_check', 'doc_check', 'audited', 'tree_digest', 'quotes', 'formal_check', 'formal_status']
const truth = {}
const stampText = (text) => {
  const line = typeof text === 'string' && text.trim().startsWith('{') ? JSON.parse(text) : null
  return line && !Array.isArray(line) ? JSON.stringify(stampStdout(line)) : text
}
const stamped = (out) => {
  for (const o of [out, out && out.designated]) {
    if (!o || typeof o !== 'object') continue
    for (const k of STDOUT_KEYS) if (k in o) truth[k] = o[k] = stampText(o[k])
  }
  return out
}
const recopied = (prompt) => Object.fromEntries([...prompt.matchAll(/stdout を加工せずに (\w+) に入れる/g)].map(([, k]) => {
  if (!(k in truth)) throw new Error(`取り直しの ${k} を返した呼び出しがありません`)
  return [k, truth[k]]
}))
// corrupt: { <label>: { <欄>: 写し損ね } }。写し損ねは { literal: 返す文字列 }（壊れた JSON など）か { drop: <一覧の欄> }（一覧の先頭の要素を
// 落とした、JSON としては正しい写し。digest は元のまま）。落とす要素の無い一覧は写し損ねにならないので止める。
const corrupt = (label, got) => {
  const how = (spec.corrupt || {})[label]
  if (!how || !got) return got
  const out = JSON.parse(JSON.stringify(got))
  for (const [k, c] of Object.entries(how)) {
    const holder = k in out ? out : out.designated
    if (!holder || !(k in holder)) throw new Error(`${label}: 写し損ねにする ${k} を返していません`)
    if (c.literal !== undefined) holder[k] = c.literal
    else {
      const o = JSON.parse(holder[k])
      if (!Array.isArray(o[c.drop]) || !o[c.drop].length) throw new Error(`${label}: ${k} の ${c.drop} に落とす要素がありません`)
      o[c.drop] = o[c.drop].slice(1)
      holder[k] = JSON.stringify(o)
    }
  }
  return out
}
// runtime_pipeline: runtime の pipeline と同じく、throw した段をその項目の null にする（既定は throw をそのまま伝え、stub の契約違反を隠さない）。
const pipeline = async (items, stage) => Promise.all(items.map((it, i) => (spec.runtime_pipeline ? Promise.resolve().then(() => stage(it, it, i)).catch(() => null) : stage(it, it, i))))
const parallel = async (thunks) => Promise.all(thunks.map((t) => t()))
const log = (m) => logs.push(m)
const phase = (title) => {
  if (!phaseTitles.has(title)) stubErrors.push(`phase()「${title}」が meta.phases に無い`)
}
let result, error = null
try {
  result = await __main(spec.args, agent, pipeline, parallel, log, phase)
} catch (e) {
  error = String(e && e.message ? e.message : e)
}
console.log(JSON.stringify({ result, labels, logs, error, findingFiles, prompts, auditSchema, resolverSchema, disk: { ...onDisk(false), resolutions: rulingRowsOnDisk() }, writerDisk, docs: disk.docs || {}, opts: optsSeen, attempted, stubErrors, calls, replayed, atReads: atReads() }))
"""


def wrapped_source(patch=()):
    """patch: prd-spec.js の本文の (元, 置換) の組。script の欠陥を作って、欠陥を止める検査に届かせるためだけに使う。"""
    src = PRD.read_text(encoding="utf-8")
    for old, new in patch:
        assert src.count(old) == 1, old
        src = src.replace(old, new)
    assert src.startswith("export const meta = {"), "prd-spec.js は export const meta から始まる"
    body = src[len("export ") :]
    meta = body[: body.index("\n}\n") + 3].replace("const meta = ", "const __meta = ", 1)
    return (
        "async function __main(args, agent, pipeline, parallel, log, phase) {\n"
        + body
        + "\n}\n"
        + meta
        + HARNESS
    )


def _orig_run(spec, patch=()):
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "prd_harness.mjs"
        path.write_text(wrapped_source(patch), encoding="utf-8")
        out = subprocess.run(["node", str(path), json.dumps(spec)], capture_output=True, text=True, check=True)
    return json.loads(out.stdout)


def run(spec, patch=()):
    spec = {"verify_all_mark": VERIFY_ALL_MARK, "doc_check_url": (SKILL / "scripts" / "doc_check.mjs").as_uri(), **spec}
    got = stages_client.run_harness(spec, _orig_run, patch=patch)
    assert not got["stubErrors"], got["stubErrors"]
    _note_at_reads(got["atReads"])
    return got


def _note_at_reads(reads):
    """spec の *_at の段を、テストの中の run() のどれか 1 つでも stub が引いたかで数え、テストの終わりに引かれなかった段で落とす。

    同じ spec を段の手前で止まる run と続きの run で使い回すので、run ごとではなくテストごとに見る。"""
    frame = sys._getframe(2)
    while frame and not isinstance(frame.f_locals.get("self"), unittest.TestCase):
        frame = frame.f_back
    test = frame.f_locals["self"] if frame else None
    acc = {} if test is None else test.__dict__.get("_at_reads")
    if acc is None:
        acc = test._at_reads = {}
        test.addCleanup(_assert_at_read, acc)
    for key, stages in reads.items():
        for stage, read in stages.items():
            acc[(key, stage)] = acc.get((key, stage), False) or read
    if test is None:
        _assert_at_read(acc)


def _assert_at_read(acc):
    unread = sorted(f"{k}[{s!r}]" for (k, s), read in acc.items() if not read)
    assert not unread, f"spec に書いたのに stub が一度も引かなかった段（その経路を通っていない）: {', '.join(unread)}"


def args(**kw):
    """手で組んだ state には、prd-spec.js が next_args に付けるのと同じ state_hash を付ける。"""
    a = {"workspace": "/tmp/prd-w", "skillDir": str(SKILL), "entry": "new"}
    a.update(kw)
    if "state" in kw and "state_hash" not in kw:
        a["state_hash"] = value(f"nextArgsHash({json.dumps(a, ensure_ascii=False)})")
    return a


def const(name):
    return int(re.search(rf"const {name} = (\d+)", PRD.read_text(encoding="utf-8")).group(1))


MAX_AUDIT_PASSES = const("MAX_AUDIT_PASSES")
# MAX_GATES: prd-spec.js の `const MAX_GATES = <k> + MAX_AUDIT_PASSES` の値（式の k は本文から読む。k の内訳は
# Gates.test_聞ける回数の上限は監査のパスの数から決まる が本文と照合する）。
MAX_GATES = int(re.search(r"const MAX_GATES = (\d+) \+ MAX_AUDIT_PASSES\n", PRD.read_text(encoding="utf-8")).group(1)) + MAX_AUDIT_PASSES
LIMIT_WHY = f"依頼者に聞ける回数の上限（MAX_GATES = {MAX_GATES}）に達した"


def with_state(next_args, **state):
    """next_args の state の欄を書き換え、state_hash を付け直す（prd-spec.js が next_args に付けるのと同じ）。"""
    a = {k: v for k, v in next_args.items() if k != "state_hash"}
    a["state"] = {**a["state"], **state}
    a["state_hash"] = value(f"nextArgsHash({json.dumps(a, ensure_ascii=False)})")
    return a


def at_limit(next_args):
    """聞ける回数を使い切った（state.gates = MAX_GATES）next_args。その段では問いを聞けず、保持規則（holdLeft）にする。"""
    return with_state(next_args, gates=MAX_GATES)


def stage6_at_limit(spec):
    """spec の run を段 6 の最初の resolver で止め（応答しない）、その段 6 から聞ける回数を使い切った状態で始める next_args。"""
    stopped = run({**spec, "null_labels": ["resolver:6"]})["result"]
    assert (stopped["status"], stopped["next_args"]["from"]) == ("blocked", "6"), stopped
    return at_limit(stopped["next_args"])


def new_item_each_round(rounds, **extra):
    """監査 r1〜r<rounds> が、毎回別の項目に blocking を 1 件出す（再発にならない）。"""
    fs = {"writerReviewer:r1": [{"id": "r1-wr-all-001", **extra}]}
    for k in range(2, rounds + 1):
        fs[f"writerReviewer:r{k}"] = [{"id": f"r{k}-wr-all-{k:03d}", "item_id": f"PR-X-{k:03d}", **extra}]
    return fs


# VERIFY_ALL_MARK: prd-spec.js の VERIFY_ALL の文面の一部（verifier に W の unverified から検証させる指示。stub の verifier もこれで対象を取る）。
VERIFY_ALL_MARK = "unverified のうち failed_current に無い要素すべて"


def on_disk(world):
    """stub の W（spec.world）の検証の状態を、doc_check flow の unverified・failed_current と、resolutions の verdict が null の RS（no_verdict）と同じ規則で読む。"""
    d = json.loads(Path(world).read_text())
    at = lambda i: d["verdicts"].get(i, {}).get("verdict") if d["verdicts"].get(i, {}).get("v") == d["els"][i] else None
    def judged(i):
        v, r = d["verdicts"].get(i), d["rs"][i]
        if v is None:
            return False
        same = v.get("v", 0) == r.get("v", 0)
        if same and v.get("av", 0) == r.get("av", 0):
            return True
        if r.get("ruling") in ("hold", "question") and v["verdict"] == "fail":
            return True
        return r.get("ruling") == "question" and v["verdict"] == "pass" and same
    return {"unverified": sorted(i for i in d["els"] if at(i) != "pass"), "failed_current": sorted(i for i in d["els"] if at(i) == "fail"),
            "no_verdict": sorted(i for i in d["rs"] if not judged(i))}


def judged_by(test, r, label, el):
    """label の verifier が W の今の版に合否の無い要素すべて（VERIFY_ALL）を検証させられ、el が最後の W で今の版の合否を持つ。"""
    test.assertIn(VERIFY_ALL_MARK, nth_prompt(r, label, 0))
    test.assertTrue(el not in r["disk"]["unverified"] or el in r["disk"]["failed_current"], f"{el} が今の版で検証されていない")


def nth_prompt(r, label, n):
    return [p["prompt"] for p in r["prompts"] if p["label"] == label][n]


def ids_of_verifier(r, label):
    return re.findall(r"RS-\d+", nth_prompt(r, label, 0).split("検証する resolution の ID:")[1].split("\n")[0])


def has(labels, prefix):
    return any(l.startswith(prefix) for l in labels)


def assert_entry_answers(test, r, frm, gate, ids):
    """next_args で回答を当てる段（3a・3a'）から始めた run は、入口の flow-check が flow の後に回答のファイルも確かめ、単独の answers を起動しない。"""
    prompt = nth_prompt(r, f"flow-check:{frm}-entry", 0)
    flow = prompt.index("doc_check.mjs flow --workspace /tmp/prd-w --rulings`")
    answers = prompt.index(f"doc_check.mjs answers --workspace /tmp/prd-w --file answers/{gate}.md --ids {','.join(ids)}`")
    test.assertLess(flow, answers, "restore → flow → answers の順")
    test.assertIn("stdout を加工せずに answers_check に入れる", prompt[answers:])
    test.assertNotIn(f"flow-check:{gate}-answers", r["labels"])


BACKUP_LINE = re.compile(r"doc_check\.mjs backup --workspace /tmp/prd-w ((?:--doc \S+ )+)--token (\S+?)`")


def writer_backup(test, r, label, docs):
    """writer のプロンプトの最初のコマンドが、段の token（プロンプトのトークンの行）で全文書の控えを取る backup であること。返すのは token。"""
    prompt = nth_prompt(r, label, 0)
    m = BACKUP_LINE.search(prompt)
    test.assertIsNotNone(m, f"{label} のプロンプトに doc_check backup が無い")
    test.assertEqual(m.group(1).split(), [x for d in docs for x in ("--doc", d)])
    token = re.search(r"^トークン: (\S+)$", prompt, re.M).group(1)
    test.assertEqual(m.group(2), token, "段の token で控える")
    line = next(l for l in prompt.split("\n") if m.group(0) in l)
    test.assertIn("最初のコマンド", line)
    test.assertIn("backup_check に入れる", line)
    return token


def reasked_at_limit(world=None):
    """g1 の問い RS-001 を 3a が続きの問いにして、g2 で聞き直す止まり方。返す next_args は聞ける回数を使い切った（at_limit）もの。
    最初のゲートの後の 3a は裁定の反映を 3b に渡すので、回答を当てた段の settle と保持規則への変換を確かめるテストは、この後の
    3a（3b の後なので自分の settle を回し、上限なので問いを聞けない段）から始める。"""
    w = {"world": world} if world else {}
    g1 = run({"args": args(), "flow_open": 1, "questions_at": {"3": ["RS-001"]}, **w})["result"]
    g2 = run({"args": g1["next_args"], "questions_at": {"3a": ["RS-001"]}, **w})["result"]
    assert (g2["status"], g2.get("gate"), g2.get("question_ids")) == ("needs_answers", "g2", ["RS-001"]), g2
    return {**g2, "next_args": at_limit(g2["next_args"])}


@unittest.skipIf(shutil.which("node") is None, "node が無い環境ではスキップする")
class Syntax(unittest.TestCase):
    def test_包んだ本体がnode_checkに通る(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "prd_check.mjs"
            path.write_text(wrapped_source(), encoding="utf-8")
            r = subprocess.run(["node", "--check", str(path)], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)

    def test_禁止されたAPIを使っていない(self):
        src = PRD.read_text(encoding="utf-8")
        for bad in ("Date.now(", "Math.random(", "new Date()", "\nimport ", "require("):
            self.assertNotIn(bad, src)


@unittest.skipIf(shutil.which("node") is None, "node が無い環境ではスキップする")
class Stages(unittest.TestCase):
    def test_問い0件なら1回のrunでdoneになる(self):
        r = run({"args": args()})
        self.assertIsNone(r["error"])
        self.assertEqual(r["result"]["status"], "done")
        labels = r["labels"]
        self.assertEqual(labels[:3], ["flow-check:1-entry", "planner:1", "verifier:3v"], "段 1〜3 は planner 1 体と plan reviewer 1 体")
        self.assertFalse(has(labels, "resolver:3"), "open も組も 0 件なら段 3 の resolver は起動しない")
        self.assertTrue(has(labels, "verifier:3v"), "3v は open も組も 0 件でも必ず起動する")
        self.assertFalse(has(labels, "resolver:6"), "decision の指摘も新しい TBD も 0 件なら段 6 は起動しない")
        self.assertFalse(has(labels, "writer:U-1:revise"))
        self.assertFalse(has(labels, "resolver:9"), "事後報告は導出物なので生成する役を起動しない")
        self.assertEqual(r["result"]["report_path"], "/tmp/prd-w/report.md")
        self.assertIsNone(r["result"]["next_args"])

    def test_domain_assessmentが修正後も不合格ならtraceを残してwriter前に停止する(self):
        with tempfile.TemporaryDirectory() as tmp:
            world = str(Path(tmp) / "world.json")
            first = run({"args": args(), "flow_open": 1, "questions_at": {"3": ["RS-001"]}, "world": world})["result"]
            self.assertEqual(first["status"], "needs_answers")
            fail = {"id": "RS-051", "kind": "insufficient_grounds", "reason": "回答 signal が verdict を支えない"}
            stopped = run({
                "args": first["next_args"],
                "world": world,
                "about": {"RS-051": {"domain": "personal_data"}},
                "ruled_at": {"3a": ["RS-001", "RS-051"], "3a-fix": ["RS-001", "RS-051"]},
                "verifier_fail": {"3av": [fail], "3a-fixv": [fail]},
            })
            self.assertEqual(stopped["result"]["status"], "blocked")
            self.assertIn("domain assessment RS-051", stopped["result"]["reason"])
            self.assertNotIn("resolver:3a-convert", stopped["labels"])
            self.assertNotIn("writer:U-1:draft", stopped["labels"])
            disk = json.loads(Path(world).read_text())
            self.assertEqual(disk["rs"]["RS-051"]["about"], {"domain": "personal_data"})
            self.assertEqual(disk["verdicts"]["RS-051"]["verdict"], "fail")

    def test_合格したdomain_assessmentは回答の反映のresolverへIDで渡る(self):
        with tempfile.TemporaryDirectory() as tmp:
            world = str(Path(tmp) / "world.json")
            first = run({
                "args": args(),
                "flow_open": 1,
                "questions_at": {"3": ["RS-001"]},
                "ruled_at": {"3": ["RS-051"]},
                "about": {"RS-051": {"domain": "personal_data"}},
                "world": world,
            })["result"]
            self.assertEqual(first["status"], "needs_answers")
            self.assertIn("RS-051", first["next_args"]["state"]["passed"])
            r = run({"args": first["next_args"], "world": world, "ruled_at": {"3a": ["RS-001"]}})
            self.assertIsNone(r["error"])
            self.assertEqual(r["result"]["status"], "done")
            [resolver] = [p["prompt"] for p in r["prompts"] if p["label"] == "resolver:3a"]
            self.assertIn("有効な domain assessment: personal_data=RS-051", resolver)
            self.assertIn("--ledger resolutions --ids RS-051 --fields", resolver)
            self.assertIn("次の resolution ID: RS-052", resolver)

    def test_settleのdomain_assessmentが修正後も不合格なら変換せず停止する(self):
        destructive = {"FLOW_DESTRUCTIVE_UNCONSTRAINED": ["F-053"]}
        fail = [{"id": "RS-060", "kind": "insufficient_grounds", "reason": "回答 signal が verdict を支えない"}]
        r = run({
            "args": args(),
            "flow_open": 1,
            "flow_codes_at": {"3v": destructive},
            "open_ids_at": {"framer": ["O-RS-001"], "3-settle": ["O-060"]},
            "unverified_at": {"3-settle": ["F-053"]},
            "about": {"RS-060": {"domain": "personal_data"}},
            "ruled_at": {"3": ["RS-001"], "3-settle-opens": ["RS-060"]},
            "verifier_fail": {"3v-settle": fail, "3-settle-fixv": fail},
        })
        self.assertEqual(r["result"]["status"], "blocked", r["result"].get("reason"))
        self.assertIn("domain assessment RS-060", r["result"]["reason"])
        self.assertIn("resolver:3-settle-fix", r["labels"])
        self.assertIn("verifier:3-settle-fixv", r["labels"])
        self.assertNotIn("resolver:3-settle-convert", r["labels"])

    def test_段3の問いは初稿の監査の後のg1で聞きnext_argsで3aから書き直す(self):
        spec = {"args": args(), "flow_open": 1, "questions_at": {"3": ["RS-001"]}}
        r1 = run(spec)
        res = r1["result"]
        self.assertEqual(res["status"], "needs_answers")
        self.assertEqual(res["question_ids"], ["RS-001"])
        self.assertEqual((res["gate"], res["answers_path"]), ("g1", "/tmp/prd-w/answers/g1.md"))
        self.assertEqual(res["next_args"]["state"]["gates"], 1, "next_args の state は開いたゲートを数えた後の数")
        self.assertEqual(res["next_args"]["from"], "3a", "持ち越した問いで書いた初稿は回答を知らないので、回答を当てて組み直す段から入る")
        self.assertNotIn("deferred", res["next_args"]["state"], "ゲートを開いたら持ち越しの印は運ばない")
        labels = r1["labels"]
        self.assertTrue(has(labels, "writer:") and has(labels, "writerReviewer"), "段 3 の問いは聞かずに持ち越し、初稿と監査で出る問いと一緒に聞く")
        writer = next(p["prompt"] for p in r1["prompts"] if p["label"].startswith("writer:"))
        self.assertIn("回答待ちの問い RS-001", writer, "writer は持ち越した問いの論点を決めない")
        self.assertEqual(json.loads(json.dumps(res["next_args"])), res["next_args"])

        r2 = run({"args": res["next_args"], "ruled_at": {"3a": ["RS-001"]}})
        self.assertIsNone(r2["error"])
        self.assertEqual(r2["result"]["status"], "done")
        self.assertEqual(r2["labels"][:2], ["flow-check:3a-entry", "resolver:3a"], "段 3 以降から始める run は、最初に W を読み直し、同じ flow-check が回答を当てる前に回答のファイルを確かめる")
        assert_entry_answers(self, r2, "3a", "g1", ["RS-001"])
        self.assertFalse(has(r2["labels"], "planner:1"))
        self.assertNotIn("verifier:3av", r2["labels"], "候補の選択だけで flow も変わらなければ verifier を起動しない")
        self.assertIn("flow-check:3a", r2["labels"], "代わりに settle の flow-check が別の agent の stdout を取る")
        self.assertTrue(has(r2["labels"][r2["labels"].index("resolver:3a"):], "writer"), "回答の後に初稿を書き直す")

    def test_書き直した初稿の監査は前の監査の続きの回で指摘を出し段6に届く(self):
        # 同じ回の番号で監査し直すと指摘の ID が仮の初稿の監査と重なり、その指摘を閉じた裁定が新しい指摘も閉じたことになる。
        spec = {"args": args(), "flow_open": 1, "questions_at": {"3": ["RS-001"]},
                "findings": {"wholeReviewer:r1": [{"id": "r1-wh-all-001", "route": "decision"}], "wholeReviewer:r2": [{"id": "r2-wh-all-001", "route": "decision"}]},
                "about": {"RS-010": {"finding": "r1-wh-all-001"}, "RS-011": {"finding": "r2-wh-all-001"}}, "ruled_at": {"6": ["RS-010"]}}
        g1 = run(spec)
        self.assertEqual((g1["result"]["status"], g1["result"]["question_ids"]), ("needs_answers", ["RS-001"]), g1["result"].get("reason"))
        r2 = run({**spec, "args": g1["result"]["next_args"], "ruled_at": {"3a": ["RS-001"], "6": ["RS-011"]}})
        self.assertEqual(r2["result"]["status"], "done", r2["result"].get("reason"))
        self.assertIn("wholeReviewer:r2:all", r2["labels"], "書き直した初稿の監査は r2")
        self.assertNotIn("wholeReviewer:r1:all", r2["labels"])
        prompt = lambda label: next(p["prompt"] for p in r2["prompts"] if p["label"] == label)
        self.assertIn("r2-wh-all-001", prompt("resolver:6"), "書き直した初稿の監査の指摘が段 6 に届く")
        self.assertIn("--save audited-2", prompt("wholeReviewer:r2:all"))

    def test_自由記述の回答はverifierに通す(self):
        spec = {"args": args(), "flow_open": 1, "questions_at": {"3": ["RS-001"]}}
        res = run(spec)["result"]
        r2 = run({"args": res["next_args"], "free_text_at": {"3a": ["RS-001"]}})
        self.assertTrue(has(r2["labels"], "verifier:3av"))
        self.assertEqual(r2["result"]["status"], "done")

    def test_free_textだけに入れた回答が2回落ちると組み直しの前はg2の問いに上限ではholdになる(self):
        fail = {"id": "RS-001", "kind": "insufficient_grounds", "reason": "回答の文面から対応づけが読めない"}
        res = run({"args": args(), "flow_open": 1, "questions_at": {"3": ["RS-001"]}})["result"]
        rejected = run({
            "args": res["next_args"],
            "free_text_at": {"3a": ["RS-001"], "3a-fix": ["RS-001"]},
            "fails_when_asked": [fail],
            "questions_at": {"3a-convert": ["RS-001"]},
        })
        prompts = {p["label"]: p["prompt"] for p in rejected["prompts"]}
        self.assertIn("RS-001 → question（insufficient_grounds）", prompts["resolver:3a-convert"])
        self.assertIn("verifier:3a-convertv", rejected["labels"])
        self.assertEqual(rejected["result"]["status"], "blocked")
        self.assertIsNone(rejected["result"]["next_args"])
        self.assertIn("関連性・根拠の検証に落ちました", rejected["result"]["reason"])

        # A corrected question can pass the post-conversion verifier and reach g2; the failed first two judgments are stage-scoped.
        verifier_fail = {"3av": [fail], "3a-fixv": [fail]}
        g0 = run({
            "args": res["next_args"],
            "free_text_at": {"3a": ["RS-001"], "3a-fix": ["RS-001"]},
            "verifier_fail": verifier_fail,
            "questions_at": {"3a-convert": ["RS-001"]},
        })
        self.assertEqual(g0["result"]["status"], "needs_answers", g0["result"].get("reason"))
        self.assertEqual(g0["result"]["question_ids"], ["RS-001"])
        self.assertEqual(g0["result"]["answers_path"], "/tmp/prd-w/answers/g2.md")
        g02 = run({
            "args": at_limit(g0["result"]["next_args"]),
            "free_text_at": {"3a": ["RS-001"], "3a-fix": ["RS-001"]},
            "verifier_fail": verifier_fail,
            "holds_at": {"3a-convert": ["RS-001"]},
        })
        prompts = {p["label"]: p["prompt"] for p in g02["prompts"]}
        self.assertIn("RS-001 → hold（insufficient_grounds）", prompts["resolver:3a-convert"])
        self.assertEqual(g02["result"]["status"], "done")
        self.assertIn("RS-001", g02["result"]["holds"])
        self.assertEqual(g02["result"]["hold_drafts"], [])

    def test_free_textだけに入れた回答もverifierに通り回答済みになる(self):
        res = run({"args": args(), "flow_open": 1, "questions_at": {"3": ["RS-001"]}})["result"]
        r2 = run({"args": res["next_args"], "free_text_at": {"3a": ["RS-001"]}})
        prompts = {p["label"]: p["prompt"] for p in r2["prompts"]}
        self.assertIn("RS-001", prompts["verifier:3av"].split("検証する resolution の ID:")[1].split("\n")[0])
        self.assertEqual(r2["result"]["status"], "done")
        self.assertFalse(has(r2["labels"], "resolver:final"), "回答した問いを保持規則に変えない")

    def test_3vの不合格は1回だけ差し戻し残りは理由で分ける(self):
        fail = {"id": "RS-001", "kind": "value_as_method", "reason": "価値の判断を方法論で決めた"}
        spec = {
            "args": args(),
            "flow_open": 1,
            "ruled_at": {"3": ["RS-001"], "3-fix": ["RS-001"]},
            "verifier_fail": {"3v": [fail], "3-fixv": [fail]},
            "questions_at": {"3-convert": ["RS-001"]},
        }
        r = run(spec)
        labels = r["labels"]
        self.assertEqual(
            [l for l in labels if l.startswith(("resolver:", "verifier:"))],
            ["verifier:3v", "resolver:3-fix", "verifier:3-fixv", "resolver:3-convert", "verifier:3-convertv"],
            "値の差し戻しは 1 回で止め、問いへの変換は関連性と根拠を独立に検証する",
        )
        self.assertEqual(r["result"]["status"], "needs_answers", "価値の判断は問いになって g1 に届く")
        self.assertEqual(r["result"]["question_ids"], ["RS-001"])

    def test_問いへの変換後の独立検証に落ちた問いは利用者に提示せず停止する(self):
        fail = {"id": "RS-001", "kind": "insufficient_grounds", "reason": "案件内の信号が無く、問いの relevance を確認できない"}
        spec = {
            "args": args(),
            "flow_open": 1,
            "about": {"RS-001": {"open": "O-001"}},
            "ruled_at": {"3": ["RS-001"], "3-fix": ["RS-001"]},
            "verifier_fail": {"3v": [fail], "3-fixv": [fail], "3-convertv": [fail]},
            "questions_at": {"3-convert": ["RS-001"]},
        }
        r = run(spec)
        self.assertIn("verifier:3-convertv", r["labels"])
        verification = next(p["prompt"] for p in r["prompts"] if p["label"] == "verifier:3-convertv")
        self.assertIn("RS-001", verification.split("検証する resolution の ID:")[1].split("\n")[0])
        self.assertEqual(r["result"]["status"], "blocked")
        self.assertNotIn("question_ids", r["result"])
        self.assertIsNone(r["result"]["next_args"], "不合格の問いをゲートへ渡さず、同じ変換を自動再試行しない")
        self.assertIn("関連性・根拠の検証に落ちました", r["result"]["reason"])

    def test_実測で価値を決めた裁定は検証役が節を読んで落とし問いに変わる(self):
        # 前回の試走の RS-010: O-010 の失敗の行き先を measured（現行の挙動）で決め、3v を通って G1 まで残った形。
        fail = {"id": "RS-010", "kind": "value_as_method", "reason": "失敗の行き先を現行の挙動で決めた"}
        spec = {
            "args": args(),
            "flow_open": 1,
            "about": {"RS-010": {"open": "O-010"}},
            "ruled_at": {"3": ["RS-010"], "3-fix": ["RS-010"]},
            "verifier_fail": {"3v": [fail], "3-fixv": [fail]},
            "questions_at": {"3-convert": ["RS-010"]},
        }
        r = run(spec)
        prompts = {p["label"]: p["prompt"] for p in r["prompts"]}
        for label in ("planner:1", "verifier:3v", "verifier:3-fixv"):
            self.assertIn("\n## 現物と既存実装の扱い\n", _exported(f"m.contractText({json.dumps(contract_role(prompts[label]))})"), label)
        self.assertIn("RS-010 → question（value_as_method）", prompts["resolver:3-convert"])
        self.assertEqual(r["result"]["status"], "needs_answers")
        self.assertEqual(r["result"]["question_ids"], ["RS-010"])

    def test_差し戻しで合格すれば変換しない(self):
        fail = {"id": "RS-001", "kind": "insufficient_grounds", "reason": "出典が無い"}
        spec = {"args": args(), "flow_open": 1, "ruled_at": {"3": ["RS-001"], "3-fix": ["RS-001"]}, "verifier_fail": {"3v": [fail]}}
        r = run(spec)
        self.assertNotIn("resolver:3-convert", r["labels"])
        self.assertEqual(r["result"]["status"], "done")

    def test_resolutionのIDの形に合わないIDを返したresolverは段を止める(self):
        # 形の外の ID は合否の集合で resolution に数えられず、裁定が黙って消える。
        for name, kw in (("ruled", {"ruled_at": {"3": ["R-001"]}}), ("questions", {"questions_at": {"3": ["D-001"]}}),
                         ("free_text", {"ruled_at": {"3": ["RS-001"]}, "free_text_at": {"3": ["RS-X"]}})):
            with self.subTest(name):
                r = run({"args": args(), "flow_open": 1, **kw})
                bad = (kw.get("free_text_at") or kw.get("questions_at") or kw["ruled_at"])["3"][0]
                self.assertEqual((r["result"]["status"], r["result"]["next_args"]["from"]), ("blocked", "1"), "planner:1 の返り値は段 1 で検査する")
                self.assertIn(f"合わない ID を返しました: 「{bad}」", r["result"]["reason"])
                self.assertFalse(has(r["labels"], "verifier:"))

    def test_差し戻しのresolverが不合格の裁定を返さなければ止める(self):
        # 返らない裁定は v2 に渡らず、変換にも回らないまま failed_ids に残る。
        fail = [{"id": "RS-001", "kind": "insufficient_grounds", "reason": "r"}, {"id": "RS-002", "kind": "insufficient_grounds", "reason": "r"}]
        base = {"args": args(), "flow_open": 1, "verifier_fail": {"3v": fail}}
        for name, kw in (("ruled", {"ruled_at": {"3": ["RS-001", "RS-002"], "3-fix": ["RS-001", "RS-002"]}}),
                         ("question", {"ruled_at": {"3": ["RS-001", "RS-002"]}, "questions_at": {"3-fix": ["RS-001", "RS-002"]}})):
            with self.subTest(name):
                self.assertEqual(run({**base, **kw})["result"]["status"], "needs_answers" if "questions_at" in kw else "done")
        res = run({**base, "ruled_at": {"3": ["RS-001", "RS-002"], "3-fix": ["RS-001"]}})
        r = res["result"]
        self.assertEqual((r["status"], r["next_args"]["from"]), ("blocked", "3"), r.get("reason"))
        self.assertIn("段 3-fix: 求めた RS-002 を resolver が", r["reason"])
        self.assertFalse(has(res["labels"], "verifier:3-fixv"))

    def test_空文字のIDを返したresolverは段を止める(self):
        fail = [{"id": "RS-001", "kind": "insufficient_grounds", "reason": "r"}]
        res = run({"args": args(), "flow_open": 1, "ruled_at": {"3": ["RS-001"], "3-fix": ["RS-001"]}, "verifier_fail": {"3v": fail, "3-fixv": fail},
                   "holds_at": {"3-convert": ["RS-001", ""]}})
        r = res["result"]
        self.assertEqual((r["status"], r["next_args"]["from"]), ("blocked", "3"), r.get("reason"))
        self.assertIn("合わない ID を返しました: 「」", r["reason"])
        self.assertEqual([l for l in res["labels"] if l.startswith("flow-check:")], ["flow-check:1-entry"])

    def test_検証を求めていない裁定の合否は差し戻しにも変換にも回さない(self):
        # RS-099 は回答待ちの問い。検証を求めていない合否でその cycle の差し戻しや変換を起こすと、問いが保持規則に書き換わる。
        # W に put された合否は script の持つ合否（段 3 の合格）と違うので、検証を求めた verifier（3av-left）に検証させ直す。
        g0 = run({"args": args(), "flow_open": 1, "ruled_at": {"3": ["RS-001"]}, "questions_at": {"3": ["RS-099"]}})["result"]
        asked = {"id": "RS-001", "kind": "insufficient_grounds", "reason": "r"}
        unasked = {"id": "RS-099", "kind": "insufficient_grounds", "reason": "r"}
        full = run({"args": g0["next_args"], "ruled_at": {"3a-fix": ["RS-002"]}, "free_text_at": {"3a": ["RS-002"]},
                    "verifier_fail": {"3av": [{**asked, "id": "RS-002"}, unasked], "3a-fixv": [{**asked, "id": "RS-002"}, unasked]},
                    "questions_at": {"3a-convert": ["RS-002"]}, "null_labels": ["planner:3b"]})
        r = full["result"]
        self.assertEqual((r["status"], r["next_args"]["from"]), ("blocked", "3b"), r.get("reason"))
        state = r["next_args"]["state"]
        self.assertIn("RS-099", state["questions"])
        self.assertNotIn("RS-099", state.get("failed_ids", []), "検証を求めていない不合格を台帳の集合に入れない")
        self.assertNotIn("RS-099", state.get("holds", []))
        self.assertIn("RS-099", nth_prompt(full, "verifier:3av-left", 0).split("検証する resolution の ID:")[1].split("\n")[0])
        self.assertFalse([p for p in full["prompts"] if "RS-099 →" in p["prompt"]], "問いを変換に回さない")
        self.assertTrue(any("RS-099" in n and "合否に数えていない" in n for n in state["notices"]), state["notices"])
        # 合格の側も同じ。検証を求めていない RS-098 が合格に入ると、誰も検証していない resolution が根拠に使える集合に入る。
        passed = run({"args": g0["next_args"], "free_text_at": {"3a": ["RS-002"]}, "verifier_extra_pass": {"3av": ["RS-098"]},
                      "null_labels": ["planner:3b"]})["result"]
        st = passed["next_args"]["state"]
        self.assertIn("RS-002", st["passed"])
        self.assertNotIn("RS-098", st["passed"])
        self.assertEqual(sum("RS-098" in n for n in st["notices"]), 1)
        # 同じ行を持ち越した再実行でも行を重ねない（重ねると next_args が再実行のたびに伸びる）。
        carried = {k: v for k, v in g0["next_args"].items() if k != "state_hash"}
        carried["state"] = {**carried["state"], "notices": [n for n in st["notices"] if "RS-098" in n]}
        again = run({"args": {**carried, "state_hash": value(f"nextArgsHash({json.dumps(carried, ensure_ascii=False)})")},
                     "free_text_at": {"3a": ["RS-002"]}, "verifier_extra_pass": {"3av": ["RS-098"]}, "null_labels": ["planner:3b"]})
        self.assertIsNone(again["error"], again["error"])
        self.assertEqual(sum("RS-098" in n for n in again["result"]["next_args"]["state"]["notices"]), 1)

    def test_書いた後に同じIDで裁定し直した裁定は次の改稿のwriterに渡す(self):
        # 段 3 の検証の裁定 RS-005 は初稿で writer に渡った。段 6 のゲートの後の 3a' で F-100 がまた落ち、差し戻しは同じ about の RS-005 を
        # 書き直す（同じ論点に別の ID の裁定は put できない）。written に残すと、書き直した裁定がどの writer にも渡らずに done になる。
        F = [{"id": "F-100", "kind": "insufficient_grounds", "reason": "出典が無い"}]
        base = {"about": {"RS-005": {"verification": "F-100"}, "RS-010": {"finding": "r1-wh-all-001"}},
                "findings": {"wholeReviewer:r1": [{"id": "r1-wh-all-001", "route": "decision"}]},
                "verifier_fail": {"3v": F, "3a'v": F}, "ruled_at": {"3-fix": ["RS-005"], "3a'": ["RS-010"], "3a'-fix": ["RS-005"]},
                "unverified_at": {"3-settle": ["F-100"], "3a'": ["F-100"], "3a'-settle": ["F-100"]}, "flow_sha_at": {"3a'": "f-3a2"},
                "questions_at": {"6": ["RS-010"]}}
        g1 = run({**base, "args": args()})["result"]
        self.assertEqual((g1["status"], g1["next_args"]["state"]["settled_written"]), ("needs_answers", ["RS-005"]))
        r = run({**base, "args": g1["next_args"]})
        self.assertEqual(r["result"]["status"], "done", r["result"].get("reason"))
        self.assertIn("resolver:3a'-fix", r["labels"])
        [line] = [l for l in nth_prompt(r, "writer:U-1:revise", 0).split("\n") if l.startswith("前回の書き込みの後に決まった resolution")]
        self.assertIn("RS-005", line)

    def test_変換で求めていないIDを返したresolverは段を止める(self):
        fail = [{"id": "RS-001", "kind": "insufficient_grounds", "reason": "r"}]
        base = {"args": args(), "flow_open": 1, "ruled_at": {"3": ["RS-001", "RS-002"], "3-fix": ["RS-001"]}, "verifier_fail": {"3v": fail, "3-fixv": fail}}
        for name, kw in (("question", {"questions_at": {"3-convert": ["RS-001", "RS-002"]}}),
                         ("ruled", {"questions_at": {"3-convert": ["RS-001"]}, "ruled_at": {**base["ruled_at"], "3-convert": ["RS-003"]}})):
            with self.subTest(name):
                res = run({**base, **kw})
                self.assertFalse(has(res["labels"], "writer:"))
                r = res["result"]
                self.assertEqual((r["status"], r["next_args"]["from"]), ("blocked", "3"), r.get("reason"))
                self.assertIn("変換を求めていない", r["reason"])
                self.assertIn(kw.get("ruled_at", kw["questions_at"])["3-convert"][-1], r["reason"])

    def test_existingでもゲートとblockedの後の段6から再開できる(self):
        a = args(entry="existing", existing_docs=[{"key": "requirements/x", "fixed": False}])
        spec = {"args": a, "findings": {"wholeReviewer:r1": [{"id": "r1-wh-all-001", "route": "decision"}]}, "questions_at": {"6": ["RS-010"]}}
        g1 = run(spec)["result"]
        self.assertEqual((g1["status"], g1["next_args"]["from"]), ("needs_answers", "3a'"))
        self.assertEqual(g1["hold_drafts"], [])
        after = run({"args": g1["next_args"], "ruled_at": {"3a'": ["RS-010"]}})
        self.assertIsNone(after["error"], after["error"])
        self.assertEqual(after["result"]["status"], "done")
        stopped = run({**spec, "null_labels": ["resolver:6"]})["result"]
        self.assertEqual((stopped["status"], stopped["next_args"]["from"]), ("blocked", "6"))
        again = run({**spec, "args": stopped["next_args"]})
        self.assertIsNone(again["error"], again["error"])
        self.assertEqual(again["result"]["status"], "needs_answers")

    def test_段6のゲートは前に開いたゲートが無ければg1になる(self):
        spec = {
            "args": args(),
            "findings": {"wholeReviewer:r1": [{"id": "r1-wh-all-001", "route": "decision"}]},
            "questions_at": {"6": ["RS-010"]},
        }
        r1 = run(spec)
        res = r1["result"]
        self.assertEqual(res["status"], "needs_answers")
        self.assertEqual(res["answers_path"], "/tmp/prd-w/answers/g1.md")
        self.assertEqual(res["next_args"]["from"], "3a'")
        self.assertEqual(res["gate"], "g1", "段 3 でゲートを開いていないので、段 6 のゲートが最初のゲート")
        self.assertTrue(has(r1["labels"], "writer:U-1:draft"), "段 6 のゲートは初稿の後")

        r2 = run({"args": res["next_args"], "ruled_at": {"3a'": ["RS-010"]}})
        self.assertIsNone(r2["error"])
        self.assertEqual(r2["labels"][:2], ["flow-check:3a'-entry", "resolver:3a'"])
        assert_entry_answers(self, r2, "3a'", "g1", ["RS-010"])
        self.assertTrue(has(r2["labels"], "writer:U-1:revise"))
        self.assertTrue(has(r2["labels"], "writerReviewer:r2"), "最後の書き込みには範囲を絞った監査を当てる")
        self.assertEqual(r2["result"]["status"], "done")

    def test_writerの指摘は段6を起動せずに改稿へ届く(self):
        spec = {"args": args(), "findings": {"writerReviewer:r1": [{"id": "r1-wr-all-001"}]}}
        r = run(spec)
        self.assertFalse(has(r["labels"], "resolver:6"))
        self.assertTrue(has(r["labels"], "writer:U-1:revise"))
        self.assertTrue(has(r["labels"], "writerReviewer:r2"), "改稿した項目に監査を当て直す")
        self.assertEqual(r["result"]["status"], "done")

    def test_毎パス新しい項目にblockingが出続けるとパスの上限でblockedになり監査は飛ばさない(self):
        last = MAX_AUDIT_PASSES + 1
        spec = {"args": args(), "findings": new_item_each_round(last)}
        r = run(spec)
        res = r["result"]
        self.assertEqual((res["status"], res["stop_reason"], res["passes"], res["item_routes"]), ("blocked", "pass_limit", MAX_AUDIT_PASSES, {}))
        self.assertTrue(has(r["labels"], f"writerReviewer:r{last}"), "最後のパスの改稿の後も監査を当てる")
        self.assertFalse(has(r["labels"], f"writerReviewer:r{last + 1}"))
        self.assertEqual(sum(1 for l in r["labels"] if l.startswith("writer:U-1:revise")), MAX_AUDIT_PASSES)
        self.assertIn("resolver:final", r["labels"])
        self.assertEqual(res["remaining_blocking"], [f"r{last}-wr-all-{last:03d}"])
        self.assertEqual(res["report_path"], "/tmp/prd-w/report.md")
        [final] = [p["prompt"] for p in r["prompts"] if p["label"] == "resolver:final"]
        self.assertNotIn("report.md", final)
        silent = run({**spec, "null_labels": ["resolver:final"]})["result"]
        self.assertEqual((silent["status"], silent["report_path"]), ("blocked", "/tmp/prd-w/report.md"))

    def test_輪を出た後に作ったholdは文案で返し本文に入ったholdと分ける(self):
        last = MAX_AUDIT_PASSES + 1
        last_id = f"r{last}-wr-all-{last:03d}"
        limit = {
            "args": args(),
            "about": {"RS-051": {"finding": last_id}, "RS-050": {"finding": "r2-wr-all-101"}},
            "findings": new_item_each_round(last),
            "holds_at": {"final": ["RS-051"]},
        }
        # 聞ける段 6 は hold を作れない（script の指定の外の hold は blocked）ので、輪の中の hold は聞ける回数を使い切った段 6 で作る
        # （監査 r1 の decision の指摘を裁定する段 6。改稿は 1 回なので、輪の中の段 6 はこの 1 回だけ）。
        second_pass = {
            **limit,
            "about": {"RS-051": {"finding": last_id}, "RS-050": {"finding": "r1-wr-all-101"}},
            "findings": {**limit["findings"], "writerReviewer:r1": [*limit["findings"]["writerReviewer:r1"], {"id": "r1-wr-all-101", "item_id": "PR-X-101", "route": "decision"}]},
            "holds_at": {"6": ["RS-050"], "final": ["RS-051"]},
        }
        second_pass["args"] = stage6_at_limit(second_pass)
        for name, spec, holds in (("上限の経路", limit, []), ("輪の中の段 6 の hold の経路", second_pass, ["RS-050"])):
            with self.subTest(name):
                r = run(spec)
                res = r["result"]
                self.assertEqual(res["status"], "blocked")
                self.assertIn("resolver:final", r["labels"])
                self.assertEqual(res["holds"], holds)
                self.assertEqual(res["hold_drafts"], ["RS-051"])
                self.assertEqual(res["remaining_blocking"], [last_id], "文案にした指摘も本文には無いので残す")
                self.assertFalse(set(res["holds"]) & set(res["hold_drafts"]))
        revise = [p["prompt"] for p in run(second_pass)["prompts"] if p["label"].startswith("writer:U-1:revise")]
        self.assertIn("RS-050", revise[0], "輪の中の hold は段 7 で writer に渡る")

    def test_改稿のパスの段6の問いはゲートで聞き回答を当てて改稿と再監査を経てdoneになる(self):
        # RS-045 の形: 監査で初めて出た価値の問い。改稿のパスに段 7・8 が残っているので、位置で保持規則にせず聞く。
        spec = {
            "args": args(),
            "findings": {"writerReviewer:r1": [{"id": "r1-wr-all-001", "route": "decision"}]},
            "questions_at": {"6": ["RS-020"]},
            "ruled_at": {"3a'": ["RS-020"]},
        }
        # 段 6 で出た問いは、この run で最初に開くゲート g1 で聞く。
        r = run(spec)
        res = r["result"]
        self.assertEqual((res["status"], res["gate"], res["question_ids"]), ("needs_answers", "g1", ["RS-020"]), res.get("reason"))
        self.assertEqual((res["answers_path"], res["next_args"]["from"], res["next_args"]["state"]["pass"]), ("/tmp/prd-w/answers/g1.md", "3a'", 1))
        self.assertFalse(has(r["labels"], "writer:U-1:revise"), "改稿の前に止まる")
        self.assertFalse(has(r["labels"], "resolver:6-hold"))
        self.assertNotIn(LIMIT_WHY, nth_prompt(r, "resolver:6", 0))
        after = run({**spec, "args": res["next_args"]})
        done = after["result"]
        self.assertEqual(done["status"], "done", done.get("reason"))
        self.assertEqual(after["labels"][:2], ["flow-check:3a'-entry", "resolver:3a'"])
        assert_entry_answers(self, after, "3a'", "g1", ["RS-020"])
        self.assertTrue(has(after["labels"], "writer:U-1:revise"), "回答を当てた後に改稿する")
        self.assertTrue(has(after["labels"], "writerReviewer:r2"), "改稿の後に再監査する")
        self.assertNotIn("RS-020", done["holds"])
        self.assertFalse(has(after["labels"], "resolver:3a'-hold"))

    def test_上限に達していれば改稿のパスの段6の問いは保持規則になり上限を理由に渡す(self):
        spec = {
            "args": args(),
            "findings": {"writerReviewer:r1": [{"id": "r1-wr-all-001", "route": "decision"}]},
            "questions_at": {"6": ["RS-020"]},
        }
        r = run({**spec, "args": stage6_at_limit(spec)})
        res = r["result"]
        self.assertEqual(res["status"], "done", res.get("reason"))
        self.assertIn(LIMIT_WHY, nth_prompt(r, "resolver:6", 0), "段 6 の resolver にも、問いでなく hold にする理由として上限を渡す")
        self.assertIn("resolver:6-hold", r["labels"])
        self.assertIn(f"次の問いは依頼者に聞かない（{LIMIT_WHY}）", nth_prompt(r, "resolver:6-hold", 0))
        self.assertIn("RS-020", res["holds"])
        self.assertEqual(res["hold_drafts"], [])

    def test_申告に無い変更はwriter_reviewerのdiffの指示とundeclaredで監査の範囲に入る(self):
        spec = {
            "args": args(),
            "findings": {"writerReviewer:r1": [{"id": "r1-wr-all-001"}]},
            "writer_changed": ["PR-X-001"],
            "diff": {"r2": ["PR-X-001", "PR-X-009"]},
        }
        r = run(spec)
        res = r["result"]
        self.assertEqual(res["status"], "done", res.get("reason"))
        self.assertEqual([l for l in r["labels"] if ":r2:" in l], ["writerReviewer:r2:all", "wholeReviewer:r2:all"], "申告に無い変更で監査役を追加で起動しない")
        wr = nth_prompt(r, "writerReviewer:r2:all", 0)
        self.assertIn("範囲を絞った監査: writer の申告の項目は次のとおり（その項目の節から読む）。\n- requirements/x: PR-X-001", wr)
        self.assertRegex(wr, r"判定の前に `[^`]*doc_check\.mjs diff --workspace /tmp/prd-w --against audited-1 --expect a1` を実行し、結果ファイルの by_doc のうち自分の組の文書の changed・added の項目も範囲に足す")
        self.assertEqual(res["undeclared"], {"requirements/x": ["PR-X-009"]})
        self.assertTrue(any("申告に無い変更" in l and "PR-X-009" in l and "diff から範囲に足させた" in l for l in r["logs"]), r["logs"])

    def test_何も申告しなかった単位の変更も監査の範囲とundeclaredに入る(self):
        units = [
            {"id": "U-1", "docs": ["requirements/x"], "depends_on": []},
            {"id": "U-2", "docs": ["requirements/y"], "depends_on": []},
        ]
        spec = {
            "args": args(),
            "units": units,
            "findings": {
                "writerReviewer:r1:all": [
                    {"id": "r1-wr-all-001"},
                    {"id": "r1-wr-all-002", "doc": "requirements/y", "item_id": "PR-Y-001"},
                ],
            },
            "writer_changed_by_unit": {"U-1": ["PR-X-001"], "U-2": []},
            "diff": {"r2": ["PR-X-001", "PR-Y-003"]},
            "by_doc": {
                "r2": {
                    "requirements/x": {"changed": ["PR-X-001"], "added": [], "removed": []},
                    "requirements/y": {"changed": ["PR-Y-003"], "added": [], "removed": []},
                }
            },
        }
        r = run(spec)
        self.assertIsNone(r["error"], r["error"])
        wr = nth_prompt(r, "writerReviewer:r2:all", 0)
        # 申告の無い U-2 の文書も writer reviewer の組に入り、diff の by_doc で範囲が届く。
        self.assertIn("全文書: /tmp/prd-w/requirements-x.md、/tmp/prd-w/requirements-y.md とその .meta.json", wr)
        self.assertIn("- requirements/x: PR-X-001", wr)
        self.assertNotIn("- requirements/y:", wr, "申告に無い項目を申告として渡さない")
        self.assertIn("自分の組の文書の changed・added の項目も範囲に足す", wr)
        self.assertEqual(r["result"]["undeclared"], {"requirements/y": ["PR-Y-003"]})
        self.assertEqual(r["result"]["status"], "done")

    def test_diffのdigestが一致しなければblocked(self):
        spec = {
            "args": args(),
            "findings": {"writerReviewer:r1": [{"id": "r1-wr-all-001"}]},
            "diff_error_at": ["r2"],
        }
        r = run(spec)
        self.assertEqual(r["result"]["status"], "blocked")
        self.assertIn("digest", r["result"]["reason"])

    def test_任意のfromからその段に進む(self):
        state = {
            "units": [{"id": "U-1", "docs": ["requirements/x"], "depends_on": []}],
            "flow_digest": "f-framer",
        }
        # 段 5 は入口の後に、送る目標の有無を doc_check formal-request に決めさせる flow-check を 1 体起動する（workflow-io.md と agent-contracts.md「## 形式検証の事実」）。
        for frm, first in (("4", ["writer:U-1:draft"]), ("5", ["flow-check:5-formal-f1a", "writerReviewer:r1:all"]), ("3", ["verifier:3v"])):
            with self.subTest(frm=frm):
                # 段 3 は plan の照合を v1 で行うので、planner:1 の plan の版と covers を state に要る（REQUIRES）。
                st = {**state, "plan_sha256": "plan", "covers": {}} if frm == "3" else state
                r = run({"args": args(**{"from": frm, "state": st})})
                self.assertIsNone(r["error"])
                self.assertEqual(r["labels"][:1 + len(first)], [f"flow-check:{frm}-entry", *first])
                self.assertEqual(r["result"]["status"], "done")

    def test_打ち直して変わったnext_argsは止まる(self):
        na = run({"args": args(), "findings": {"wholeReviewer:r1": [{"id": "r1-wh-all-001", "route": "decision"}]}, "questions_at": {"6": ["RS-010"]}})["result"]["next_args"]
        self.assertTrue(na["state_hash"])
        for name, broken in (("state の値を変えた", {**na, "state": {**na["state"], "pass": na["state"]["pass"] + 1}}),
                             ("workspace を変えた", {**na, "workspace": "/tmp/prd-other"}),
                             ("existing_docs を変えた", {**na, "existing_docs": [{"key": "requirements/x", "fixed": False}]}),
                             ("from を変えた", {**na, "from": "7"}),
                             ("state_hash を落とした", {k: v for k, v in na.items() if k != "state_hash"})):
            with self.subTest(name):
                r = run({"args": broken, "ruled_at": {"3a'": ["RS-010"]}})
                self.assertIn("返った next_args を変えずに渡し直してください", r["error"] or "")
                self.assertEqual(r["labels"], [])
        # 環境の欄（ENV_ARGS）の変更と、同じ意味の打ち直し（空の existing_docs を落とす）は止めない。
        self.assertEqual(na["existing_docs"], [])
        for name, same in (("そのまま", na),
                           ("role_opts を変えた", {**na, "role_opts": {"writer": {"effort": "high"}}}),
                           ("skillDir を変えた", {**na, "skillDir": "/tmp/prd-spec-1.2.4"}),
                           ("空の existing_docs を落とした", {k: v for k, v in na.items() if k != "existing_docs"})):
            with self.subTest(name):
                r = run({"args": same, "ruled_at": {"3a'": ["RS-010"]}})
                self.assertIsNone(r["error"], r["error"])
                self.assertEqual(r["result"]["status"], "done")

    def test_変えたrole_optsとskillDirは次のnext_argsに載る(self):
        g0 = run({"args": args(), "flow_open": 1, "questions_at": {"3": ["RS-001"]}})["result"]["next_args"]
        changed = {**g0, "skillDir": "/tmp/prd-spec-1.2.4", "role_opts": {"writer": {"effort": "high"}}}
        res = run({"args": changed, "ruled_at": {"3a": ["RS-001"]}, "null_labels": ["writer:U-1:draft"]})
        self.assertIsNone(res["error"], res["error"])
        na = res["result"]["next_args"]
        self.assertEqual((res["result"]["status"], na["from"]), ("blocked", "4"), res["result"].get("reason"))
        self.assertEqual((na["skillDir"], na["role_opts"]), ("/tmp/prd-spec-1.2.4", {"writer": {"effort": "high"}}))
        self.assertIn("/tmp/prd-spec-1.2.4/", next(p["prompt"] for p in res["prompts"] if p["label"] == "writer:U-1:draft"))

    def test_段8で止まったnext_argsから再開すると当て損ねた指摘が次のパスへ持ち越される(self):
        findings = {"writerReviewer:r1": [{"id": "r1-wr-all-001"}, {"id": "r1-wr-all-002", "item_id": "PR-X-002"}]}
        auditor = "writerReviewer:r2:all"
        stopped = run({"args": args(), "findings": findings, "unapplied_seq": [["r1-wr-all-002"]], "null_labels": [auditor]})["result"]
        self.assertEqual((stopped["status"], stopped["next_args"]["from"]), ("blocked", "8"), stopped.get("reason"))
        self.assertEqual(stopped["next_args"]["state"]["revised"]["unapplied"], ["r1-wr-all-002"])
        # 持ち越した指摘は r2 の後も blocking なので再発して decision に回り、延長の段 6 が問いを出さないので輪を出る。段 8 が作った pending を返り値で見る。
        again = run({"args": stopped["next_args"]})
        self.assertIsNone(again["error"], again["error"])
        self.assertEqual(again["labels"][:3], ["flow-check:8-entry", "flow-check:8-formal-f2a", auditor], "段 8 の本体の最初に形式検証の依頼を決める")
        self.assertIn({"step": "formal-method:f2a", "fact": "no_formal_target", "ids": []}, again["result"]["skipped"])
        res = again["result"]
        self.assertEqual((res["status"], res["stop_reason"]), ("blocked", "pass_limit"), res.get("reason"))
        self.assertEqual(res["carried_blocking"], ["r1-wr-all-002"])
        self.assertIn("r1-wr-all-002", res["unreflected"])

    def test_差し戻しの再検証で合格した決定はwriterに無効として渡さない(self):
        r = run({"args": args(), "verifier_fail": {"3v": [{"id": "D-004", "kind": "unsupported", "reason": "r"}]}, "verifier_extra_pass": {"3-fixv": ["D-004"]}})
        self.assertIsNone(r["error"], r["error"])
        self.assertIn("resolver:3-fix", r["labels"])
        self.assertIn("無効な決定（覆された・検証に落ちた。根拠にしない）: （なし）", nth_prompt(r, "writer:U-1:draft", 0))

    def test_ゲートを開いた数を持たない版の段7のnext_argsは起動の前に止まる(self):
        # 位置で決めていたゲートの版は、段 4 より後の next_args にも gate（g1）を運び、開いた数を持たない。0 から数え直すと、次のゲートが
        # g1 を名乗り、前の回答のファイル answers/g1.md を上書きする。
        spec = {"findings": {"wholeReviewer:r1": [{"id": "r1-wh-all-001", "route": "decision"}]}, "questions_at": {"6": ["RS-010"]}, "ruled_at": {"3a'": ["RS-010"]}}
        g1 = run({"args": args(), **spec})["result"]
        stopped = run({"args": g1["next_args"], **spec, "null_labels": ["writer:U-1:revise"]})["result"]
        self.assertEqual((stopped["status"], stopped["next_args"]["from"], stopped["next_args"]["state"]["gates"]), ("blocked", "7", 1), stopped.get("reason"))
        legacy = {k: v for k, v in stopped["next_args"].items() if k != "state_hash"}
        legacy["state"] = {k: v for k, v in legacy["state"].items() if k != "gates"}
        legacy["state_hash"] = value(f"nextArgsHash({json.dumps(legacy, ensure_ascii=False)})")
        old = run({"args": legacy, **spec})
        self.assertIn("state.gate があるのに state.gates がありません", old["error"] or "")
        self.assertEqual(old["labels"], [])

    def test_要るstateが無いfromは止まる(self):
        r = run({"args": args(**{"from": "7", "state": {"units": []}})})
        self.assertIn("state.audit", r["error"])
        self.assertEqual(r["labels"], [])

    def test_reviewやupdateはentryに使えない(self):
        for bad in ("review", "update"):
            with self.subTest(bad=bad):
                r = run({"args": args(entry=bad)})
                self.assertIn("entry", r["error"])

    def test_応答しなかったwriterは0件にせずblockedにする(self):
        spec = {"args": args(), "null_labels": ["writer:U-1:draft"]}
        r = run(spec)
        res = r["result"]
        self.assertEqual(res["status"], "blocked")
        self.assertEqual(res["next_args"]["from"], "4")
        self.assertFalse(has(r["labels"], "writerReviewer"))

    def test_閉じていない流れでは初稿を始めない(self):
        r = run({"args": args(), "broken_flow": True})
        self.assertEqual(r["result"]["status"], "blocked")
        self.assertIn("planner:1:rework", r["labels"])
        self.assertFalse(has(r["labels"], "writer"))

    def test_依存のある単位は順番に書く(self):
        units = [
            {"id": "U-2", "docs": ["specifications/x"], "depends_on": ["U-1"]},
            {"id": "U-1", "docs": ["requirements/x"], "depends_on": []},
        ]
        r = run({"args": args(), "units": units})
        writers = [l for l in r["labels"] if l.startswith("writer:")]
        self.assertEqual(writers, ["writer:U-1:draft", "writer:U-2:draft"])

    def test_要求文書だけのrunでだけflow_framerに粒度の小節を指す(self):
        heading = "#### 要求文書だけのラン"
        framer = (Path(PRD).resolve().parents[1] / "skills" / "prd-spec" / "agents" / "planner.md").read_text()
        self.assertIn(f"\n{heading}\n", framer, "プロンプトが指す小節は planner.md に実在する")
        both = [{"id": "U-1", "docs": ["requirements/x", "specifications/x"], "depends_on": []}]
        # planner:1 は units を決める仕分けと同じ体で流れを描くので、script は起動の前に units を知らない。条件付きの行（plan.json の docs が
        # requirements だけなら）で小節を名前で指し、無条件の小節の指示（下の settle・3b の planner と同じ見出しの逐語）は載せない（設計 1.3）。
        for spec in ({"args": args()}, {"args": args(), "units": both}, self._expand()):
            first = nth_prompt(run(spec), "planner:1", 0)
            self.assertNotIn(heading, first, spec.get("units"))
            self.assertIn("requirements だけなら、流れは planner.md の「要求文書だけのラン」の小節で描く", first, spec.get("units"))

    def test_裁定の反映と回答での組み直しのflow_framerにも同じ判定で小節を指す(self):
        # frameFlow を通る 3 つの呼び出しのうち、段 2 以外の 2 つ（settle・3b-reframe）。
        heading = "#### 要求文書だけのラン"
        both = [{"id": "U-1", "docs": ["requirements/x", "specifications/x"], "depends_on": []}]
        for units, expected in ((None, True), (both, False)):
            u = {"units": units} if units else {}
            with self.subTest(units=units, call="3-settle"):
                r = run({"args": args(), **u, "flow_open": 1, "ruled_at": {"3": ["RS-001"]}, "verifier_flow_findings_at": {"3v": 1}})
                self.assertEqual(heading in nth_prompt(r, "planner:3-settle", 0), expected)
            with self.subTest(units=units, call="3b-reframe"):
                g0 = run({"args": args(), **u, "flow_open": 1, "ruled_at": {"3": ["RS-001"]}, "questions_at": {"3": ["RS-099"]}})["result"]
                r = run({"args": g0["next_args"], **u, "free_text_at": {"3a": ["RS-099"]}, "null_labels": ["planner:3b"]})
                self.assertEqual(heading in nth_prompt(r, "planner:3b", 0), expected)

    def test_段1の入口がWをS0の直後に戻したstdoutを返さなければintakeを起動しない(self):
        entry = "flow-check:1-entry"
        for name, kw in (("応答しない", {"null_labels": [entry]}), ("stdout が無い", {"no_reset_at": [entry]}),
                         ("固定の文書が違う", {"reset_fixed": ["requirements/other"]}), ("残した文書が違う", {"reset_kept": ["requirements/other"]}),
                         ("引き継いだ TBD が文書のキーごとでない", {"carried_tbd": ["TBD-RX-001"]}),
                         ("引き継いだ TBD の文書が残した文書に無い", {"carried_tbd": {"requirements/other": ["TBD-ROTHER-001"]}})):
            with self.subTest(name):
                r = run({"args": args(), **kw})
                self.assertFalse(has(r["labels"], "planner:1"), r["labels"])
                res = r["result"]
                self.assertEqual((res["status"], res["next_args"]["from"], res["next_args"]["state"]), ("blocked", "1", {}), res.get("reason"))
                self.assertIn(value("NOT_RUN") if name == "応答しない" else "doc_check reset", res["reason"])

    def _expand(self):
        a = args(entry="expand", existing_docs=[{"key": "requirements/x", "fixed": True}, {"key": "specifications/x", "fixed": False}])
        return {"args": a, "units": [{"id": "U-1", "docs": ["specifications/x"], "depends_on": []}]}

    def test_固定の文書が段1の入口から変わったら監査の段で止め再実行させない(self):
        finding = {"id": "r1-wr-all-001", "doc": "specifications/x", "item_id": "SP-X-001"}
        for at, stage, extra in (("r1", "5", {}), ("r2", "8", {"findings": {"writerReviewer:r1": [finding]}, "writer_changed": ["SP-X-001"]})):
            with self.subTest(stage):
                r = run({**self._expand(), **extra, "fixed_moved_at": {at: ["requirements/x"]}})
                res = r["result"]
                self.assertEqual((res["status"], res["next_args"]), ("blocked", None), res.get("reason"))
                self.assertIn("固定の文書 requirements/x が段 1 の入口から変わりました", res["reason"])
                self.assertTrue(any(f"--save audited-{at[1:]} --role auditor" in p["prompt"] and "--fixed requirements/x`" in p["prompt"] for p in r["prompts"]))
                self.assertTrue(any(f"audited-{at[1:]} の snapshot で照合" in line for line in res["integrity"]), res["integrity"])
        self.assertEqual(run(self._expand())["result"]["status"], "done")

    def test_仕様書だけを書くrunで段3に価値の問いが出たら聞かずに初稿の監査の後に要求文書の抜けとして止める(self):
        r = run({**self._expand(), "flow_open": 1, "questions_at": {"3": ["RS-001"]}})
        res = r["result"]
        self.assertEqual((res["status"], res["stop_reason"], res["question_ids"], res["next_args"]), ("blocked", "upstream_gap", ["RS-001"], None), res.get("reason"))
        self.assertEqual(res["questions_path"], "/tmp/prd-w/questions.md")
        self.assertIn("固定の要求文書に答えが見つからなかった価値の論点", res["reason"])
        self.assertFalse(res["resumable"])
        self.assertNotIn("gate", res)
        self.assertTrue(has(r["labels"], "writer:U-1:draft") and has(r["labels"], "writerReviewer"), "初稿と監査で出る論点も集めてから止まる")
        self.assertFalse(has(r["labels"], "writer:U-1:revise"), "答えの無い判断で改稿しない")
        auditor = next(p["prompt"] for p in r["prompts"] if p["label"].startswith("writerReviewer:"))
        self.assertIn("回答待ちの問い RS-001", auditor, "監査役は持ち越した問いの論点を指摘しない")

    def test_仕様書だけを書くrunは段3と段6の価値の問いをまとめて1回で返す(self):
        finding = {"id": "r1-wh-all-001", "route": "decision"}
        r = run({**self._expand(), "flow_open": 1, "questions_at": {"3": ["RS-001"], "6": ["RS-010"]}, "findings": {"wholeReviewer:r1": [finding]}})
        res = r["result"]
        self.assertEqual((res["status"], res["stop_reason"], res["question_ids"]), ("blocked", "upstream_gap", ["RS-001", "RS-010"]), res.get("reason"))
        decide = next(p["prompt"] for p in r["prompts"] if p["label"] == "resolver:6")
        self.assertIn("回答待ちの問い RS-001", decide, "段 6 は持ち越した問いと同じ論点を別の問いにしない")

    def test_仕様書だけを書くrunで段6に価値の問いが出ても止める(self):
        finding = {"id": "r1-wh-all-001", "route": "decision"}
        r = run({**self._expand(), "findings": {"wholeReviewer:r1": [finding]}, "questions_at": {"6": ["RS-010"]}})
        res = r["result"]
        self.assertEqual((res["status"], res["stop_reason"], res["question_ids"]), ("blocked", "upstream_gap", ["RS-010"]), res.get("reason"))
        self.assertTrue(has(r["labels"], "writer:U-1:draft"))
        self.assertFalse(has(r["labels"], "writer:U-1:revise"), "答えの無い判断で改稿しない")

    def test_書く仕様書が固定の要求文書を実現しないrunは今どおりゲートで聞く(self):
        # INDEX のために並べただけの無関係な固定の要求文書では止めない。
        a = args(entry="expand", existing_docs=[{"key": "requirements/billing", "fixed": True}, {"key": "specifications/auth", "fixed": False}])
        units = [{"id": "U-1", "docs": ["specifications/auth"], "depends_on": []}]
        for name, covers in (("covers が無い", {"specifications/auth": []}), ("固定でない要求文書を実現する", {"specifications/auth": ["requirements/auth"]})):
            with self.subTest(name):
                res = run({"args": a, "units": units, "covers": covers, "flow_open": 1, "questions_at": {"3": ["RS-001"]}})["result"]
                self.assertEqual((res["status"], res["gate"]), ("needs_answers", "g1"), res.get("reason"))

    def test_要求文書を書くrunと固定の要求文書の無いrunは今どおりゲートで聞く(self):
        for name, a, units in (
            ("要求文書も書く", args(entry="expand", existing_docs=[{"key": "requirements/a", "fixed": True}]),
             [{"id": "U-1", "docs": ["requirements/x", "specifications/x"], "depends_on": []}]),
            ("固定の要求文書が無い", args(), [{"id": "U-1", "docs": ["specifications/x"], "depends_on": []}]),
        ):
            with self.subTest(name):
                res = run({"args": a, "units": units, "flow_open": 1, "questions_at": {"3": ["RS-001"]}})["result"]
                self.assertEqual((res["status"], res["gate"]), ("needs_answers", "g1"), res.get("reason"))

    def test_監査のdocの入口のdigestがresetの値と違えば止める(self):
        # 入口（checks/entry.json）はどの指摘を blocking から外すかを決める。書き換わったまま数えると、生成者が自分の指摘を既存の指摘にできる。
        spec = {**self._expand(), "entry_digest": "e1"}
        ok = run(spec)["result"]
        self.assertNotEqual(ok["status"], "blocked", ok.get("reason"))
        for stage, got in (("r1", "e2"), ("r2", "e2"), ("r1", None)):
            with self.subTest(stage=stage, got=got):
                finding = {"id": "r1-wr-all-001", "doc": "specifications/x", "item_id": "SP-X-001"}
                r = run({**spec, "entry_digest_at": {stage: got}, "findings": {"writerReviewer:r1": [finding]}, "writer_changed": ["SP-X-001"]})["result"]
                self.assertEqual(r["status"], "blocked")
                self.assertIn("checks/entry.json", r["reason"])
                self.assertIsNone(r.get("next_args"), "段をやり直しても同じ入口なので再開させない")

    def test_固定の文書のsha256を返さないresetと基準の無い再開は止める(self):
        r = run({**self._expand(), "reset_no_fixed_sha": True})
        self.assertFalse(has(r["labels"], "planner:1"), r["labels"])
        self.assertEqual(r["result"]["next_args"]["from"], "1")
        a = {**self._expand()["args"], "from": "4", "state": {"units": [{"id": "U-1", "docs": ["specifications/x"], "depends_on": []}], "flow_digest": "f"}}
        a = args(**{k: v for k, v in a.items() if k not in ("state_hash",)})
        r = run({"args": a})
        self.assertIn("args.state.fixed_sha", r["error"] or "")
        self.assertEqual(r["attempted"], 0)

    def test_段1の入口はexisting_docsの文書を残させ固定の文書のmetaをresetに書き直させる(self):
        a = args(entry="expand", existing_docs=[{"key": "requirements/x", "fixed": True}, {"key": "requirements/a", "fixed": True}, {"key": "specifications/x", "fixed": False}])
        r = run({"args": a, "units": [{"id": "U-1", "docs": ["specifications/x"], "depends_on": []}]})
        self.assertIn("doc_check.mjs reset --workspace /tmp/prd-w --keep requirements/a,requirements/x,specifications/x --fixed requirements/a,requirements/x`", nth_prompt(r, "flow-check:1-entry", 0))
        self.assertEqual(r["labels"][:2], ["flow-check:1-entry", "planner:1"])
        self.assertEqual(r["result"]["status"], "done", r["result"].get("reason"))

    def test_保存した文書から引き継いだTBDはwriterが返さなくても開いたまま返る(self):
        # 固定の文書の TBD は誰も閉じない。writer の返り値だけから数えると、保存の index の --open-tbd から落ちて「未解決」から消える。
        r = run({**self._expand(), "carried_tbd": {"requirements/x": ["TBD-RX-001"]}})
        self.assertEqual(r["result"]["status"], "done", r["result"].get("reason"))
        self.assertEqual(r["result"]["open_tbd"], ["TBD-RX-001"])
        self.assertIn('--open-tbd "TBD-RX-001"', next(p["prompt"] for p in r["prompts"] if p["label"].startswith("writer:")))
        self.assertFalse(has(r["labels"], "resolver:6"), "固定の文書の TBD はこの run で閉じられないので、裁定に回さない")

    def test_書き換えてよい既存文書から引き継いだTBDは段6の裁定に回す(self):
        # 回さないと閉じる経路が無く、writer が meta から外しても open_tbd に残り続ける。
        r = run({**self._expand(), "carried_tbd": {"specifications/x": ["TBD-SX-001"]}})
        self.assertTrue(has(r["labels"], "resolver:6"), r["labels"])
        self.assertIn("TBD-SX-001", nth_prompt(r, "resolver:6", 0))

    def test_planの照合はplan_reviewerのstdoutで決まり違えば段1から(self):
        # 設計 6.3 の 2: 別の体（段 2 の flow-framer）が見ていた plan を、段 3 の最初の検証（verifier:3v）が実行して planner:1 の plan_check と照らす。
        ok = run({"args": args()})
        self.assertIn("doc_check.mjs plan ", nth_prompt(ok, "verifier:3v", 0), "最初の検証は doc_check plan も実行する")
        self.assertFalse(any("doc_check.mjs plan " in p["prompt"] for p in ok["prompts"] if p["label"].startswith("verifier:") and p["label"] != "verifier:3v"),
                         "plan の行は verifier:3v にだけある（-fixv・v-settle・v-left には無い）")
        fixv = run({"args": args(), "verifier_fail": {"3v": [{"id": "D-004", "kind": "unsupported", "reason": "r"}]}, "verifier_extra_pass": {"3-fixv": ["D-004"]}})
        self.assertIn("verifier:3-fixv", fixv["labels"])
        self.assertNotIn("doc_check.mjs plan ", nth_prompt(fixv, "verifier:3-fixv", 0))
        for name, seen, what in (("sha", {"sha": "plan-edited"}, "plan.json"), ("covers", {"covers": {"specifications/x": []}}, "covers"),
                                 ("findings", {"findings": 1}, "plan")):
            with self.subTest(name):
                spec = {**self._expand(), "plan_seen": seen} if name == "covers" else {"args": args(), "plan_seen": seen}
                r = run(spec)
                res = r["result"]
                self.assertEqual((res["status"], res["next_args"]["from"], res["next_args"]["state"]), ("blocked", "1", {}), "段 1 からの再実行は S0 の直後の W から始まるので state を運ばない")
                self.assertTrue(any(what in line and "planner" in line for line in res["integrity"]), res["integrity"])
                self.assertEqual(r["labels"][-1], "verifier:3v", "照合に落ちたら verifier:3v の後に agent を起動しない")
        missing = run({"args": args(), "plan_seen": None})["result"]
        self.assertEqual((missing["status"], missing["next_args"]["from"]), ("blocked", "3"), "plan の stdout を返さない verifier は段 3 からやり直す")

    def test_単位はplan_jsonのunitsだけから入りintakeの申告とflow_framerの検査で分かれない(self):
        # 単位を intake の返り値で別に受けると、doc_check（plan.json の units）と flow-framer への指示（state.units）で「仕様書を書くランか」が分かれる。
        both = [{"id": "U-1", "docs": ["requirements/x", "specifications/x"], "depends_on": []}]
        r = run({"args": args(), "units": both, "intake_units": [{"id": "U-1", "docs": ["requirements/x"], "depends_on": []}]})
        self.assertEqual(r["result"]["status"], "done", r["result"].get("reason"))
        self.assertEqual(r["result"]["docs"], ["requirements/x", "specifications/x"], "intake の返り値の units は読まない")
        self.assertFalse(any("### 要求文書だけのラン" in p["prompt"] for p in r["prompts"] if p["label"].startswith("planner")))
        moved = run({"args": args(), "units": both, "plan_seen": {"units": [{"id": "U-1", "docs": ["requirements/x"], "depends_on": []}]}})["result"]
        self.assertEqual((moved["status"], moved["next_args"]["from"]), ("blocked", "1"), moved.get("reason"))
        self.assertTrue(any("units" in line and "planner" in line for line in moved["integrity"]), moved["integrity"])
        bad = run({"args": args(), "units": [{"id": "U-1", "docs": [], "depends_on": []}]})
        self.assertEqual(bad["labels"], ["flow-check:1-entry", "planner:1", "planner:1:rework"], "units の形の崩れも plan の不合格として 1 回だけ差し戻す")
        self.assertIn("units が形", nth_prompt(bad, "planner:1:rework", 0))
        self.assertEqual((bad["result"]["status"], bad["result"]["next_args"]["from"]), ("blocked", "1"))

    def test_role_optsの未知の役割は止める(self):
        r = run({"args": args(role_opts={"checker": {"model": "opus"}})})
        self.assertIn("role_opts", r["error"])


TMP_DIR = re.compile(r"^作業用ディレクトリ: (\S+)$", re.M)
CONTRACT_ROLE = re.compile(r"doc_check\.mjs contract --workspace \S+ --role ([\w-]+) --part 1`")


def contract_role(prompt):
    """プロンプトが contract に渡す役のファイル名（読む節は doc_check の CONTRACT_SECTIONS が決める）。"""
    return CONTRACT_ROLE.search(prompt).group(1)


def tmp_dir(prompt):
    return TMP_DIR.search(prompt).group(1)


@unittest.skipIf(shutil.which("node") is None, "node が無い環境ではスキップする")
class CommonContract(unittest.TestCase):
    def test_書く役のプロンプトに共通の2節が出る(self):
        r = run({"args": args(), "flow_open": 1, "ruled_at": {"3": ["RS-001"]}})
        self.assertIsNone(r["error"], r["error"])
        roles = {p["label"].split(":")[0] for p in r["prompts"]}
        self.assertEqual(roles, {"flow-check", "planner", "verifier", "writer", "writerReviewer", "wholeReviewer"}, "段 1〜3 の裁定は planner がするので、裁定し漏らしの無い run に resolver は起動しない")
        texts = {}
        for p in r["prompts"]:
            role = contract_role(p["prompt"])
            self.assertIn(f"/agents/{role}.md の Read と", p["prompt"], p["label"])
            parts = _exported("m.CONTRACT_PARTS")
            self.assertEqual(len(re.findall(rf"contract --workspace \S+ --role {role} --part \d+`", p["prompt"])), parts, "断片を全部同じターンに並べる")
            text = texts.setdefault(role, _exported(f"m.contractText({json.dumps(role)})"))
            if role == "flow-check":
                # flow-check は何も書かないので、書き込みの規則（共通の 2 節）を配らない。
                self.assertNotIn("## 共通の約束\n", text, p["label"])
                continue
            self.assertTrue(text.startswith("## 共通の約束\n"), p["label"])
            self.assertIn("\n## W のファイルと書き手\n", text, p["label"])

    def test_stubのdoc_check_flowのstdoutは実物と同じ欄を持つ(self):
        # stub の stdout の形が実物からずれると、stub で通る判断が実物の stdout で通らない（欄を削ったときに片側だけ直る）。
        from test_doc_check_workspace import FIXTURE

        doc_check = SKILL / "scripts" / "doc_check.mjs"
        with tempfile.TemporaryDirectory() as tmp:
            ws = Path(tmp) / "w"
            shutil.copytree(FIXTURE, ws)
            real = {rulings: set(json.loads(subprocess.run(["node", str(doc_check), "flow", "--workspace", str(ws), *(["--rulings"] if rulings else [])], capture_output=True, text=True, check=True).stdout))
                    for rulings in (False, True)}
        r = run({"args": args(), "flow_open": 1, "ruled_at": {"3": ["RS-001"]}})
        got = {}
        for c in r["calls"]:
            text = (c["result"] or {}).get("flow_check")
            if text:
                got.setdefault("doc_check.mjs flow --workspace /tmp/prd-w --rulings`" in c["prompt"], {k for k in json.loads(text) if not k.startswith("lint")})
        self.assertEqual({k: sorted(v) for k, v in got.items()}, {k: sorted(v) for k, v in real.items()})

    def test_台帳を書く役のputの入力ファイルは自分の作業用ディレクトリを指す(self):
        r = run({"args": args(), "flow_open": 1, "ruled_at": {"3": ["RS-001"]}})
        writes = [p for p in r["prompts"] if "\n台帳を書く: " in p["prompt"]]
        self.assertTrue(writes)
        for p in writes:
            line = re.search(r"^台帳を書く: .*$", p["prompt"], re.M).group(0)
            self.assertIn(f"--input {tmp_dir(p['prompt'])}<名前>.json", line, p["label"])

    def test_並列に動く呼び出しは別の作業用ディレクトリを指す(self):
        # 文書が 5 つなら writer は 5 体、writer reviewer は組 p1・p2 の 2 体が並列に動く。
        units = [{"id": f"U-{i}", "docs": [f"requirements/d{i}"], "depends_on": []} for i in range(1, 6)]
        r = run({"args": args(), "units": units})
        by_label = {p["label"]: tmp_dir(p["prompt"]) for p in r["prompts"]}
        parallel = [f"writer:U-{i}:draft" for i in range(1, 6)] + ["writerReviewer:r1:p1", "writerReviewer:r1:p2", "wholeReviewer:r1:all"]
        dirs = [by_label[l] for l in parallel]
        self.assertEqual(len(set(dirs)), len(dirs), dirs)
        self.assertEqual(by_label["writerReviewer:r1:p1"], "/tmp/prd-w/tmp/writerReviewer__r1__p1/")

    def test_返り値の無いagentは出し直さず段を止めnext_argsで続けられる(self):
        # null は利用者の停止か runtime の出し直しの後の API エラーで、script が出し直すと利用者の停止を覆す。未実施は指摘 0 件にしない。
        cases = (("planner:1", "1", {}), ("writer:U-1:draft", "4", {}), ("writerReviewer:r1:all", "5", {}), ("wholeReviewer:r1:all", "5", {}),
                 ("resolver:3", "3", {"flow_open": 1, "ruled_at": {"3": ["RS-001"]}, "planner_leaves_at": {"1": ["RS-001"]}}), ("verifier:3v", "3", {}),
                 ("writer:U-1:revise", "7", {"findings": {"writerReviewer:r1": [{"id": "r1-wr-all-001"}]}}))
        for label, stage, extra in cases:
            with self.subTest(label):
                world = {"world": str(Path(self.tmp.name) / f"w-{stage}-{label.replace(':', '_').replace('/', '_')}.json")}
                r = run({"args": args(), **extra, **world, "null_labels": [label]})
                res = r["result"]
                self.assertEqual((res["status"], res["next_args"]["from"], res["stop_reason"]), ("blocked", stage, None), res.get("reason"))
                self.assertIn(value("NOT_RUN"), res["reason"])
                self.assertIn(label, res["reason"])
                self.assertEqual(r["labels"].count(label), 1, "出し直さない")
                again = run({**extra, **world, "args": res["next_args"]})
                self.assertEqual(again["result"]["status"], "done", again["result"].get("reason"))

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()

    def tearDown(self):
        self.tmp.cleanup()


@unittest.skipIf(shutil.which("node") is None, "node が無い環境ではスキップする")
class Notices(unittest.TestCase):
    def test_段5のstrayはnoticesに件数とパスだけが入りintegrityに入らない(self):
        r = run({"args": args(), "stray_at": {"r1": 100}})
        res = r["result"]
        self.assertEqual(res["status"], "done")
        self.assertEqual(len(res["notices"]), 1)
        self.assertIn("100 件", res["notices"][0])
        self.assertIn("/tmp/prd-w/checks/audited-1.stray.json", res["notices"][0])
        self.assertEqual(res["integrity"], [])

    def test_監査のsnapshotが消した作業用ディレクトリはnoticesに件数とパスが入る(self):
        res = run({"args": args(), "swept_at": {"r1": 3}})["result"]
        self.assertEqual(res["status"], "done")
        self.assertEqual(len(res["notices"]), 1)
        self.assertIn("3 件", res["notices"][0])
        self.assertIn("/tmp/prd-w/checks/audited-1.swept.json", res["notices"][0])
        self.assertEqual(res["integrity"], [])

    def test_段8のstrayはnoticesに入りintegrityに入らない(self):
        spec = {"args": args(), "findings": {"writerReviewer:r1": [{"id": "r1-wr-all-001"}]}, "stray_at": {"r2": 1}}
        r = run(spec)
        res = r["result"]
        self.assertEqual(res["status"], "done")
        self.assertTrue(any("checks/audited-2.stray.json" in n and "audited-2 の時点" in n for n in res["notices"]), res["notices"])
        self.assertEqual(res["integrity"], [])

    def test_SIZE_OVERはnoticesに入りintegrityに入らない(self):
        r = run({"args": args(), "size_over_at": {"r1": 2}})
        res = r["result"]
        self.assertEqual(len(res["notices"]), 1)
        self.assertIn("SIZE_BUDGET", res["notices"][0])
        self.assertIn("/tmp/prd-w/checks/audited-1.sizes.json", res["notices"][0])
        self.assertEqual(res["integrity"], [])

    def test_strayが無ければnoticesは空(self):
        self.assertEqual(run({"args": args()})["result"]["notices"], [])

    def test_指名された監査役のsnapshotに同じplanの全labelをliveで渡す(self):
        spec = {"args": args(), "findings": {"writerReviewer:r1": [{"id": "r1-wr-all-001"}]}}
        r = run(spec)
        by_label = {p["label"]: p["prompt"] for p in r["prompts"]}
        self.assertIn("--live writerReviewer__r1__all,wholeReviewer__r1__all --sweep", by_label["wholeReviewer:r1:all"])
        r2 = [l for l in r["labels"] if ":r2:" in l]
        live = ",".join(re.sub(r"[^A-Za-z0-9._-]+", "__", l) for l in r2)
        designated = [p for l, p in by_label.items() if ":r2:" in l and "あなたは指名された監査役" in p]
        self.assertEqual(len(designated), 1)
        self.assertIn(f"--save audited-2 --role auditor --live {live}", designated[0])

    def test_verifierの照合はresolutions_sha256で行う(self):
        r = run({"args": args(), "flow_open": 1, "ruled_at": {"3": ["RS-001"]}})
        self.assertEqual(r["result"]["integrity"], [])
        stale = run({"args": args(), "flow_open": 1, "ruled_at": {"3": ["RS-001"]}, "verifier_resolutions_sha_at": {"3v": "rs-old"}})
        self.assertTrue(any("resolutions.json（rs-old）" in x for x in stale["result"]["integrity"]), stale["result"]["integrity"])

    def test_resolutions_sha256を返さないresolverでは止まる(self):
        r = run({"args": args(), "flow_open": 1, "ruled_at": {"3": ["RS-001"]}, "resolver_sha_key": "sha256"})
        self.assertEqual(r["result"]["status"], "blocked")
        self.assertTrue(r["result"]["reason"].startswith("planner:1: "), r["result"]["reason"])
        self.assertIn("resolutions_sha256 を返しませんでした", r["result"]["reason"])
        self.assertEqual(r["labels"].count("planner:1"), 1, "済んだ put を二重に走らせない")
        self.assertFalse(has(r["labels"], "planner:1:rework"), "sha の欠けは stdout の差し戻しに回さない")
        self.assertFalse(has(r["labels"], "verifier:3v"), "照合できない版で検証に進まない")
        self.assertEqual(r["result"]["next_args"]["from"], "1")


# EVIDENCE: R16 の再々試走の run3 で、flow-check:3a（haiku）が doc_check flow --rulings の stdout を写し損ねた返り値（char 3195 で区切りが欠けた JSON）
# と、その run が返した next_args。
TRIAL = Path(__file__).resolve().parents[5] / "docs" / "trials" / "2026-09-29-prd-spec-cleanup-branches-rerun2" / "evidence"


def bad_literal(text):
    return {"literal": text}


@unittest.skipIf(shutil.which("node") is None, "node が無い環境ではスキップする")
class Transcription(unittest.TestCase):
    """doc_check の stdout の写し損ね（壊れた JSON・要素を落とした正しい JSON）は digest で見つけ、流し直してよいコマンドは別の label の
    flow-check で 1 回だけ取り直す。取り直しも合わなければ next_args を付けて止める。"""

    G0 = {"args": args(), "flow_open": 1, "questions_at": {"3": ["RS-001"]}}

    def _at_3a(self, **extra):
        res = run(self.G0)["result"]
        self.assertEqual(res["status"], "needs_answers")
        return run({"args": res["next_args"], "ruled_at": {"3a": ["RS-001"]}, **extra})

    def test_試走で写し損ねたflow_checkのstdoutは取り直して進む(self):
        evidence = json.loads((TRIAL / "flow-check-3a-bad-stdout.json").read_text(encoding="utf-8"))["result"]["flow_check"]
        with self.assertRaises(json.JSONDecodeError):
            json.loads(evidence)
        r = self._at_3a(corrupt={"flow-check:3a": {"flow_check": bad_literal(evidence)}})
        self.assertIsNone(r["error"])
        self.assertEqual(r["result"]["status"], "done", r["result"].get("reason"))
        i = r["labels"].index("flow-check:3a")
        self.assertEqual(r["labels"][i + 1], "flow-check:3a-recopy")
        self.assertIn("doc_check.mjs flow --workspace /tmp/prd-w --rulings`。stdout を加工せずに flow_check に入れる。", nth_prompt(r, "flow-check:3a-recopy", 0))

    def test_open_idsを1件落とした正しいJSONの写しはdigestで見つけて取り直す(self):
        r = self._at_3a(flow_open=1, corrupt={"flow-check:3a": {"flow_check": {"drop": "open_ids"}}})
        self.assertEqual(r["result"]["status"], "done", r["result"].get("reason"))
        self.assertIn("flow-check:3a-recopy", r["labels"], "形の検査だけでは要素を落とした写しが通る")

    def test_取り直しも合わなければchecksumの理由とnext_argsで止まり同じ段から続けられる(self):
        r = self._at_3a(flow_open=1, corrupt={"flow-check:3a": {"flow_check": {"drop": "open_ids"}}, "flow-check:3a-recopy": {"flow_check": bad_literal('{"findings": 0 "codes": {}}')}})
        res = r["result"]
        self.assertEqual(res["status"], "blocked")
        self.assertIn("checksum", res["reason"])
        self.assertIn("flow-check:3a-recopy", res["reason"])
        self.assertEqual(res["next_args"]["from"], "3a")
        self.assertEqual(r["labels"].count("flow-check:3a-recopy"), 1, "取り直しは 1 回だけ")
        again = run({"args": res["next_args"], "flow_open": 1, "ruled_at": {"3a": ["RS-001"]}, "corrupt": {"flow-check:3a-entry": {"restore_check": bad_literal('{"token": "t')}}})
        self.assertEqual(again["result"]["status"], "done", again["result"].get("reason"))
        self.assertEqual(again["labels"][:2], ["flow-check:3a-entry", "flow-check:3a-entry-recopy"])
        self.assertIn("doc_check.mjs restore --workspace /tmp/prd-w --token ", nth_prompt(again, "flow-check:3a-entry-recopy", 0))

    def test_判断する役の写し損ねは判断をやり直さずflow_checkで取り直す(self):
        plain = {"args": args()}
        cases = [
            (self.G0, "needs_answers", "verifier:3v", "flow_check", {"drop": "resolutions"}, "flow --workspace /tmp/prd-w --rulings`"),
            (plain, "done", "planner:1", "flow_check", bad_literal('{"findings": 0,'), "flow --workspace /tmp/prd-w --lint`"),
            (plain, "done", "planner:1", "conflicts_check", bad_literal('{"pairs": 0,'), "conflicts --workspace /tmp/prd-w`"),
            (plain, "done", "planner:1", "plan_check", bad_literal('{"findings": 0'), "plan --workspace /tmp/prd-w`"),
            (plain, "done", "wholeReviewer:r1:all", "doc_check", bad_literal('{"blocking": 0'), "doc --workspace /tmp/prd-w --open-tbd"),
        ]
        for spec, status, label, key, how, cmd in cases:
            with self.subTest(label=label, key=key):
                r = run({**spec, "corrupt": {label: {key: how}}})
                self.assertEqual(r["result"]["status"], status, r["result"].get("reason"))
                again = f"flow-check:{label.replace(':', '-')}-recopy"
                self.assertEqual(r["labels"].count(label), 1, "判断する役は起動し直さない")
                self.assertIn(cmd, nth_prompt(r, again, 0))
                self.assertIn(f"stdout を加工せずに {key} に入れる。", nth_prompt(r, again, 0))

    def test_引数を持つコマンドは呼び出しの場所が渡したコマンドで取り直す(self):
        r = run({"args": args(), "corrupt": {"flow-check:1-entry": {"reset_check": bad_literal('{"reset": true')}, "writer:U-1:draft": {"backup_check": bad_literal('{"backup": true')}}})
        self.assertEqual(r["result"]["status"], "done", r["result"].get("reason"))
        self.assertIn("doc_check.mjs reset --workspace /tmp/prd-w`", nth_prompt(r, "flow-check:1-entry-recopy", 0))
        self.assertIn("doc_check.mjs backup --workspace /tmp/prd-w --doc requirements/x --token ", nth_prompt(r, "flow-check:writer-U-1-draft-recopy", 0))
        self.assertEqual(r["labels"].count("writer:U-1:draft"), 1, "writer を起動し直さない")
        self.assertEqual(r["result"]["integrity"], [], "取り直した控えの stdout を照らす")
        q = run({**self.G0, "corrupt": {"planner:1": {"questions_check": {"drop": "ids"}}}})
        self.assertEqual(q["result"]["status"], "needs_answers", q["result"].get("reason"))
        self.assertFalse([l for l in q["labels"] if re.fullmatch(r"resolver:.*-questions", l)], "写し損ねを問いの形の不合格として resolver に差し戻さない")
        recopies = [p["prompt"] for p in q["prompts"] if re.fullmatch(r"flow-check:.+-recopy", p["label"])]
        self.assertTrue(any("questions --workspace /tmp/prd-w --ids RS-001 --check`" in x for x in recopies), "planner の問いの検査の stdout も取り直す")
        a = self._at_3a(corrupt={"flow-check:3a-entry": {"answers_check": {"drop": "ids"}}})
        self.assertEqual(a["result"]["status"], "done", a["result"].get("reason"))
        self.assertIn("answers --workspace /tmp/prd-w --file answers/g1.md --ids RS-001`", nth_prompt(a, "flow-check:3a-entry-recopy", 0))
        self.assertNotIn("flow-check:g1-answers", a["labels"], "取り直した入口の answers の stdout を使う")

    def test_段8のtree_digestの写し損ねは取り直して申告に無い変更を記録する(self):
        r = run({
            "args": args(),
            "findings": {"writerReviewer:r1": [{"id": "r1-wr-all-001"}]},
            "writer_changed": ["PR-X-001"],
            "diff": {"r2": ["PR-X-001", "PR-X-009"]},
            "corrupt": {"wholeReviewer:r2:all": {"tree_digest": bad_literal('{"digest": "t2"')}},
        })
        self.assertEqual(r["result"]["status"], "done", r["result"].get("reason"))
        self.assertEqual(r["labels"].count("wholeReviewer:r2:all"), 1, "判断する役は起動し直さない")
        self.assertIn("flow-check:wholeReviewer-r2-all-recopy", r["labels"])
        self.assertEqual(r["result"]["undeclared"], {"requirements/x": ["PR-X-009"]}, "写し損ねで申告に無い変更が黙って落ちた")

    def test_snapshotの写し損ねは取り直さずに段からやり直させる(self):
        r = run({"args": args(), "corrupt": {"wholeReviewer:r1:all": {"audited": bad_literal('{"digest": "a1"')}}})
        res = r["result"]
        self.assertEqual(res["status"], "blocked")
        self.assertIn("checksum", res["reason"])
        self.assertEqual(res["next_args"]["from"], "5")
        self.assertFalse(any(l.endswith("-recopy") for l in r["labels"]))

    def test_run3のnext_argsは開いたゲートの数が無ければ起動の前に止まり数を足せば最初のagentまで進む(self):
        # run3 は位置で決めていたゲート（G0-2 の後の 3a）の版の next_args で、state.gates を持たない。止まった 0.6.x の run は流し直す（互換の別名は作らない）。
        got = json.loads((TRIAL / "run-outputs" / "run3.output.json").read_text(encoding="utf-8"))["result"]["next_args"]
        old = run({"args": got})
        self.assertIn('from "3a" には state.gates が要ります', old["error"] or "")
        self.assertEqual(old["labels"], [])
        # 同じ規模の state に、今の版が同じ所（2 回目のゲートの後、組み直しの後の 3a）で付ける値を足すと、state_hash・REQUIRES・形の検査を通る。
        got = with_state(got, gate="g2", gates=2, reframed=True)
        r = run({"args": got, "null_labels": ["flow-check:3a-entry"]})
        self.assertIsNone(r["error"], "state_hash・REQUIRES・形の検査で止まった")
        self.assertEqual(r["labels"], ["flow-check:3a-entry"])
        self.assertIn(f"doc_check.mjs restore --workspace {got['workspace']} --token t6`", nth_prompt(r, "flow-check:3a-entry", 0))
        self.assertEqual(r["result"]["next_args"]["from"], "3a")


@unittest.skipIf(shutil.which("node") is None, "node が無い環境ではスキップする")
class FlowDigest(unittest.TestCase):
    def test_stateはflowの本体を持たずflow_frameの内容のsha256を運ぶ(self):
        res = run({"args": args(), "flow_open": 1, "questions_at": {"3": ["RS-001"]}})["result"]
        self.assertEqual(res["status"], "needs_answers")
        self.assertNotIn("flow", res["next_args"]["state"])
        self.assertEqual(res["next_args"]["state"]["flow_digest"], "f-framer")

    def test_verifierが見たflowの内容が違えばintegrityに入れてblocked(self):
        r = run({"args": args(), "verifier_flow_sha_at": {"3v": "f-other"}})
        res = r["result"]
        self.assertEqual(res["status"], "blocked")
        self.assertEqual(len(res["integrity"]), 1)
        self.assertIn("f-other", res["integrity"][0])
        self.assertFalse(has(r["labels"], "writer"))

    def test_誰もflowを書かないcycleのverifierの指摘はsettleのflow_framerに渡す(self):
        # flow.json は state.flow_digest のまま（誰も書いていない）なので、指摘は resolver の台帳の書き込みで出た。消せるのは flow-framer だけ。
        destructive = {"FLOW_DESTRUCTIVE_UNCONSTRAINED": ["F-053"]}
        for name, kw, line in (("どちらも消せる符号", {"verifier_flow_findings_at": {"3v": 1}}, "F-800: FLOW_DANGLING"),
                               ("flow-framer だけが消せる符号", {"flow_codes_at": {"3v": destructive}}, "F-053: 縛る不変条件が無い")):
            with self.subTest(name):
                r = run({"args": args(), "flow_open": 1, "ruled_at": {"3": ["RS-001"]}, **kw})
                labels = r["labels"]
                self.assertEqual(labels[labels.index("verifier:3v") + 1:][:2], ["planner:3-settle", "verifier:3v-settle"])
                self.assertIn(line, next(p["prompt"] for p in r["prompts"] if p["label"] == "planner:3-settle"))
                res = r["result"]
                self.assertEqual((res["status"], res["integrity"]), ("done", []), res.get("reason"))
        left = run({"args": args(), "flow_open": 1, "ruled_at": {"3": ["RS-001"]}, "flow_codes_at": {"3v": destructive, "3v-settle": destructive}})["result"]
        self.assertEqual((left["status"], left["next_args"]["from"]), ("blocked", "3"), "settle の verifier に残れば flow-framer の指摘として段の頭から")

    def _settle_world(self, g, kind, **kw):
        # settle の flow-framer の後に resolver が O-009 を裁定して台帳を書き、flow-framer の stdout に無かった F-053 の指摘が
        # settle の verifier の stdout にだけ出る（stub の世界。台帳の書き込みで指摘が出る経路は doc_check の invariantsOf が決める）。
        # g が無ければ段 3（聞ける段）、あれば聞ける回数を使い切った g2 の後の 3a（聞けない段）の settle。g1 の後の 3a は反映を 3b に渡すので settle を回さない。
        D = {"FLOW_DESTRUCTIVE_UNCONSTRAINED": ["F-053"]}
        s = "3" if g is None else "3a"
        start = {"args": args(), "flow_open": 1} if g is None else {"args": g["next_args"], "flow_sha_at": {"3a": "f-3a"}}
        ruled = {s: ["RS-001"], f"{s}-settle-opens": ["RS-009"]}
        # 差し戻し（<段>-settle-fix）も RS-009 を invariant でない裁定のまま返すので、その verifier にも同じ指摘が出て、同じ理由で落ちる。
        fail = [{"id": "RS-009", "kind": kind, "reason": "invariant でない"}]
        return {**start, "ruled_at": ruled, "flow_codes_at": {**({} if s == "3" else {s: D}), f"{s}v": D, f"{s}v-settle": D, f"{s}-settle-fixv": D, f"{s}-settle-convert": {}},
                "unverified_at": {f"{s}-settle": ["F-053"]}, "open_ids_at": {f"{s}-settle": ["O-009"]}, "about": {"RS-009": {"open": "O-009"}},
                "verifier_fail": {f"{s}v-settle": fail, f"{s}-settle-fixv": fail}, **kw}

    def test_settleの中で台帳の書き込みから出た指摘は裁定を変換してから次の回に渡す(self):
        # settle の verifier で止めると、その裁定を落とした合否が変換に届かず、同じ段からやり直しても同じ所で止まる。
        g02 = reasked_at_limit()
        for name, g, kind, returned, kept in (("聞ける段の value_as_method は問い", None, "value_as_method", "questions_at", "questions"),
                                              ("聞ける段では価値の論点の根拠不足も問い", None, "insufficient_grounds", "questions_at", "questions"),
                                              ("聞けない段は保持規則", g02, "value_as_method", "holds_at", "holds")):
            with self.subTest(name):
                s = "3" if g is None else "3a"
                r = run(self._settle_world(g, kind, **{returned: {f"{s}-settle-convert": ["RS-009"]}}))
                labels = r["labels"]
                # 問いへの変換は直後の verifier の stdout を判断に使う（flow-check で数え直さない）。保持規則だけへの変換は settle の flow-check が数え直す。
                expected = [f"resolver:{s}-settle-fix", f"verifier:{s}-settle-fixv", f"resolver:{s}-settle-convert", *([f"verifier:{s}-settle-convertv"] if kept == "questions" else [f"flow-check:{s}-settle-convert"])]
                start = labels.index(f"verifier:{s}v-settle") + 1
                self.assertEqual(labels[start:start + len(expected)], expected)
                convert = next(p["prompt"] for p in r["prompts"] if p["label"] == f"resolver:{s}-settle-convert")
                self.assertIn(f"RS-009 → {kept[:-1] if kept == 'holds' else 'question'}", convert)
                self.assertNotIn(f"planner:{s}-settle-2", labels, "保持か問いで O-009 が縛りに戻れば 1 回目で指摘は消える")
                res = r["result"]
                self.assertNotEqual(res["status"], "blocked", res.get("reason"))
                self.assertEqual(res["integrity"], [])
                self.assertIn("RS-009", res[kept] if kept == "holds" else res["next_args"]["state"]["questions"])
        asked = run(self._settle_world(g02, "value_as_method", questions_at={"3a-settle-convert": ["RS-009"]}))["result"]
        self.assertEqual((asked["status"], asked["next_args"]["from"]), ("blocked", "3a"), "聞けない段の変換は問いを返せない")

    def test_settleの差し戻しは裁定に触れる合格した裁定を指される(self):
        spec = self._settle_world(None, "insufficient_grounds", questions_at={"3-settle-convert": ["RS-009"]})
        spec = {**spec, "ruled_at": {**spec["ruled_at"], "3": ["RS-001", "RS-005"]}, "about": {**spec["about"], "RS-005": {"pair": ["F-053", "O-009"]}}}
        line = "- open:O-009: RS-005（pair:F-053|O-009）"
        self.assertIn(line, nth_prompt(run(spec), "resolver:3-settle-fix", 0))
        # 変異: fixFailed に指された根拠を渡さないと行が消える。
        mutated = run(spec, patch=[("reworkLines(fails), pointedLines(ownItems(ids, state)), ", "reworkLines(fails), ")])
        self.assertNotIn(line, nth_prompt(mutated, "resolver:3-settle-fix", 0))

    def test_settleの中で台帳が変わらなければverifierの指摘はflow_framerのものとして止める(self):
        # 台帳が同じなら、同じ flow.json で flow-framer の stdout に無かった指摘は flow-framer の過少申告である。
        spec = self._settle_world(reasked_at_limit(), "insufficient_grounds", open_ids_at={}, verifier_fail={})
        del spec["ruled_at"]["3a-settle-opens"], spec["flow_codes_at"]["3a-settle-convert"], spec["flow_codes_at"]["3a-settle-fixv"]
        r = run(spec)
        self.assertNotIn("resolver:3a-settle-opens", r["labels"])
        res = r["result"]
        self.assertEqual((res["status"], res["next_args"]["from"]), ("blocked", "3a"), res.get("reason"))
        self.assertIn("段 3av-settle: verifier の doc_check flow に指摘が 1 件あります", res["reason"])
        self.assertEqual(len(res["integrity"]), 1, res["integrity"])

    def test_settleの回ごとに台帳から出る指摘が残れば上限の回で止める(self):
        n = const("MAX_SETTLE_ROUNDS")
        g02 = reasked_at_limit()
        at = lambda i: {"FLOW_DESTRUCTIVE_UNCONSTRAINED": [f"F-{50 + k}" for k in range(n - i)]}
        tags = ["3a-settle"] + [f"3a-settle-{i + 1}" for i in range(1, n)]
        opens = [f"O-{10 + i}" for i in range(n)]
        spec = {"args": g02["next_args"], "ruled_at": {"3a": ["RS-001"], **{f"{t}-opens": [f"RS-{10 + i}"] for i, t in enumerate(tags)}},
                "about": {f"RS-{10 + i}": {"open": o} for i, o in enumerate(opens)},
                "open_ids_at": {t: opens[: i + 1] for i, t in enumerate(tags)},
                "flow_codes_at": {"3a": at(0), **{t.replace("3a-settle", "3av-settle"): at(i) for i, t in enumerate(tags)}}}
        r = run(spec)
        self.assertEqual([l for l in r["labels"] if l.startswith("planner:3a-settle")], [f"planner:{t}" for t in tags])
        res = r["result"]
        self.assertEqual((res["status"], res["next_args"]["from"]), ("blocked", "3a"), res.get("reason"))
        self.assertIn("裁定の反映の後も直っていません", res["reason"])
        self.assertEqual(res["integrity"], [])

    def test_3aで候補の選択だけでflowも変わらなければverifierを起動せずflow_checkが照合する(self):
        g0 = run({"args": args(), "flow_open": 1, "questions_at": {"3": ["RS-001"]}})["result"]
        r = run({"args": g0["next_args"], "ruled_at": {"3a": ["RS-001"]}})
        self.assertEqual([l for l in r["labels"] if l.startswith(("resolver:", "verifier:"))], ["resolver:3a", "verifier:3bv"])
        self.assertEqual(r["labels"][r["labels"].index("resolver:3a") + 1], "flow-check:3a", "resolver の stdout を別の agent が数え直す")
        self.assertEqual(r["result"]["status"], "done", r["result"].get("reason"))
        # 書き直した初稿の段 5（監査 r2）は送る目標が無ければ no_formal_target を残す。
        self.assertEqual(r["result"]["skipped"], [{"step": "verifier:3av", "fact": "unchanged", "ids": ["RS-001"]}, {"step": "formal-method:f2a", "fact": "no_formal_target", "ids": []}])

    def test_3a_dashでも候補の選択だけでflowも変わらなければverifierを起動しない(self):
        g1 = run({"args": args(), "findings": {"wholeReviewer:r1": [{"id": "r1-wh-all-001", "route": "decision"}]}, "questions_at": {"6": ["RS-010"]}})["result"]
        self.assertEqual(g1["next_args"]["from"], "3a'")
        r = run({"args": g1["next_args"], "ruled_at": {"3a'": ["RS-010"]}})
        self.assertNotIn("verifier:3a'v", r["labels"])
        self.assertEqual(r["labels"][r["labels"].index("resolver:3a'") + 1], "flow-check:3a'")
        self.assertEqual(r["result"]["status"], "done", r["result"].get("reason"))
        self.assertEqual(r["result"]["skipped"], [{"step": "verifier:3a'v", "fact": "unchanged", "ids": ["RS-010"]}, {"step": "formal-method:f2a", "fact": "no_formal_target", "ids": []}])

    def test_verifierを外した後も返らなかった裁定は同じ段で検証する(self):
        # 外す条件は resolver の stdout の要素しか見ない（resolutions は --rulings の stdout にしか無い）。返さずに書いた裁定は、settle の
        # flow-check が W から受け取り、verifyLeft の verifier が検証する。
        with tempfile.TemporaryDirectory() as tmp:
            world = str(Path(tmp) / "world.json")
            g0 = run({"args": args(), "flow_open": 1, "questions_at": {"3": ["RS-001"]}, "world": world})["result"]
            r = run({"args": g0["next_args"], "ruled_at": {"3a": ["RS-001"]}, "orphans_at": {"3a": ["RS-077"]}, "about": {"RS-077": {"open": "O-077"}}, "world": world})
            labels = r["labels"]
            self.assertNotIn("verifier:3av", labels)
            # 聞ける段（g1 の後の 3a）なので、返さずに書いた hold は問いに書き換え直させてから検証する。
            self.assertEqual(labels[labels.index("resolver:3a") + 1:][:4], ["flow-check:3a", "resolver:3a-left-toquestion", "flow-check:3a-left-toquestion", "verifier:3av-left"])
            res = r["result"]
            self.assertEqual(res["status"], "needs_answers", res.get("reason"))
            self.assertEqual(res["skipped"][0], {"step": "verifier:3av", "fact": "unchanged", "ids": ["RS-001"]})
            self.assertIn("RS-077", res["question_ids"])
            left = on_disk(world)
            self.assertEqual((left["unverified"], left["no_verdict"]), ([], []))

    def test_変えたものがあれば回答を当てた段のverifierを起動する(self):
        g0 = run({"args": args(), "flow_open": 1, "questions_at": {"3": ["RS-001"]}})["result"]
        now = g0["next_args"]["state"]["flow_digest"]
        cases = (
            ("resolver が flow を変えた", {"flow_sha_at": {"3a": "f-3a"}}),
            ("flow の版は同じだが今の版に合否の無い要素がある", {"flow_sha_at": {"3a": now}, "unverified_at": {"3a": ["F-061"]}}),
            ("自由記述の回答（検証する resolution がある）", {"ruled_at": {"3a": []}, "free_text_at": {"3a": ["RS-001"]}}),
        )
        for name, kw in cases:
            with self.subTest(name):
                r = run({"args": g0["next_args"], "ruled_at": {"3a": ["RS-001"]}, **kw})
                self.assertIn("verifier:3av", r["labels"])
                self.assertEqual((r["result"]["status"], r["result"]["skipped"]), ("done", [{"step": "formal-method:f2a", "fact": "no_formal_target", "ids": []}]), r["result"].get("reason"))

    def test_変えていないと申告したresolverがflowを変えていればflow_checkが止める(self):
        # verifier を外した後の照合は settle の flow-check が持つ。3a の resolver は flow.json を書けるので、所有表の外の書き込みにせず、
        # v1 が照合していた頃と同じく段からやり直せる blocked にする。
        g0 = run({"args": args(), "flow_open": 1, "questions_at": {"3": ["RS-001"]}})["result"]
        now = g0["next_args"]["state"]["flow_digest"]
        r = run({"args": g0["next_args"], "ruled_at": {"3a": ["RS-001"]}, "flow_sha_at": {"3a": "f-3a"}, "resolver_claims_sha_at": {"3a": now}})
        self.assertNotIn("verifier:3av", r["labels"])
        res = r["result"]
        self.assertEqual((res["status"], res["next_args"]["from"]), ("blocked", "3a"), res.get("reason"))
        self.assertNotIn("所有表の外", res["reason"])
        self.assertEqual(len(res["integrity"]), 1, res["integrity"])
        self.assertIn("flow-check（段 3a）", res["integrity"][0])

    def test_3aでflowを変えたresolverのsha256をverifierと照合する(self):
        g0 = run({"args": args(), "flow_open": 1, "questions_at": {"3": ["RS-001"]}})["result"]
        ok = run({"args": g0["next_args"], "ruled_at": {"3a": ["RS-001"]}, "flow_sha_at": {"3a": "f-3a"}})
        self.assertEqual(ok["result"]["status"], "done")
        stale = run({"args": g0["next_args"], "ruled_at": {"3a": ["RS-001"]}, "flow_sha_at": {"3a": "f-3a"}, "verifier_flow_sha_at": {"3av": "f-framer"}})
        self.assertEqual(stale["result"]["status"], "blocked")
        self.assertEqual(stale["result"]["next_args"]["from"], "3a")

    def test_3aでflowの指摘を返したresolverは件数が減らなければ差し戻しを止める(self):
        g0 = run({"args": args(), "flow_open": 1, "questions_at": {"3": ["RS-001"]}})["result"]
        fixed = run({"args": g0["next_args"], "ruled_at": {"3a": ["RS-001"]}, "flow_findings_at": {"3a": 2}})
        self.assertIn("resolver:3a-flow", fixed["labels"])
        self.assertEqual(fixed["result"]["status"], "done")
        broken = run({"args": g0["next_args"], "ruled_at": {"3a": ["RS-001"]}, "flow_findings_at": {"3a": 2, "3a-flow": 2}})
        self.assertEqual(broken["result"]["status"], "blocked")
        self.assertFalse(has(broken["labels"], "resolver:3a-flow-2"), "2 → 2 は進展が無いので 2 回目を出さない")
        fewer = run({"args": g0["next_args"], "ruled_at": {"3a": ["RS-001"]}, "flow_findings_at": {"3a": 2, "3a-flow": 1}})
        self.assertIn("resolver:3a-flow-2", fewer["labels"], "減っている間は差し戻す")
        self.assertEqual(fewer["result"]["status"], "done")
        self.assertFalse(has(broken["labels"], "verifier:3av"))

    def test_3aでflowのstdoutを返さないresolverは差し戻す(self):
        g0 = run({"args": args(), "flow_open": 1, "questions_at": {"3": ["RS-001"]}})["result"]
        r = run({"args": g0["next_args"], "ruled_at": {"3a": ["RS-001"]}, "no_flow_check_at": ["3a", "3a-flow"]})
        self.assertIn("resolver:3a-flow", r["labels"])
        self.assertEqual(r["result"]["status"], "blocked")


@unittest.skipIf(shutil.which("node") is None, "node が無い環境ではスキップする")
class QuestionsCheck(unittest.TestCase):
    """planner:1 の問いの形の不合格は、裁定を受け取る takeRulings が resolver:1-questions に 1 回だけ直させる（owner は 1。保険の resolver:3 の派生と分ける）。"""

    def test_形の検査に落ちた問いは1回差し戻し直ればneeds_answers(self):
        r = run({"args": args(), "flow_open": 1, "questions_at": {"3": ["RS-001"]}, "bad_questions_at": ["3"]})
        self.assertIn("resolver:1-questions", r["labels"])
        [again] = [p["prompt"] for p in r["prompts"] if p["label"] == "resolver:1-questions"]
        self.assertIn("questions --workspace /tmp/prd-w --ids RS-001 --check", again)
        self.assertEqual(r["result"]["status"], "needs_answers")
        self.assertEqual(r["result"]["question_ids"], ["RS-001"])

    def test_差し戻しでも直らなければblocked(self):
        r = run({"args": args(), "flow_open": 1, "questions_at": {"3": ["RS-001"]}, "bad_questions_at": ["3", "1-questions"]})
        self.assertEqual(r["result"]["status"], "blocked")
        self.assertEqual(r["result"]["next_args"]["from"], "3")
        self.assertEqual(sum(1 for l in r["labels"] if l.startswith("resolver:1-questions")), 1)

    def test_別の問いを検査したstdoutは合格にしない(self):
        r = run({"args": args(), "flow_open": 1, "questions_at": {"3": ["RS-001", "RS-002"]}, "questions_check_ids_at": {"3": ["RS-001"]}})
        [again] = [p["prompt"] for p in r["prompts"] if p["label"] == "resolver:1-questions"]
        self.assertIn("RS-002", again)
        self.assertEqual(r["result"]["status"], "needs_answers")

    def test_問いが無ければ検査を求めない(self):
        r = run({"args": args(), "flow_open": 1, "ruled_at": {"3": ["RS-001"]}})
        self.assertNotIn("resolver:1-questions", r["labels"])


@unittest.skipIf(shutil.which("node") is None, "node が無い環境ではスキップする")
class RerunFromTheSameStage(unittest.TestCase):
    """段の途中で止まり、返った next_args をそのまま渡して再実行すると、止まらなかった run と同じ状態になる。

    spec.world は W の flow.json に当たり、run をまたいで残る（stub が flow を state から組み直さない）。"""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.world = str(Path(self._tmp.name) / "world.json")

    def tearDown(self):
        self._tmp.cleanup()

    def _world(self, **kw):
        return {"world": self.world, **kw}

    def _resume(self, stopped, spec):
        res = stopped["result"]
        self.assertEqual(res["status"], "blocked", res)
        again = run({**spec, "args": res["next_args"]})
        self.assertIsNone(again["error"], again["error"])
        return again["result"]

    def _g0(self, **kw):
        return run({"args": args(), "flow_open": 1, "questions_at": {"3": ["RS-001", "RS-002"]}, **self._world(), **kw})["result"]

    def test_3aのverifierで止まっても候補の選択の回答を持ち越さない(self):
        self.maxDiff = None
        g0 = self._g0()
        spec = {"ruled_at": {"3a": ["RS-001", "RS-002"]}, "questions_at": {"3a": ["RS-003"]}, **self._world()}
        at_g0 = Path(self.world).read_text()
        whole = run({**spec, "args": g0["next_args"]})["result"]
        Path(self.world).write_text(at_g0)
        stopped = run({**spec, "args": g0["next_args"], "null_labels": ["verifier:3av"]})
        self.assertNotIn("answered", stopped["result"]["next_args"]["state"])
        resumed = self._resume(stopped, spec)
        self.assertEqual(resumed["status"], "needs_answers")
        self.assertEqual(resumed["next_args"], whole["next_args"])

    def test_問いの形の修正で候補を書き換えた問いは合格を持ち越さず検証し直してから根拠にする(self):
        # 3v で合格した RS-002 の候補の文を settle の形の修正が書き換える。合格を持ち越すと、検証していない decision_text が
        # g1 の候補の選択でそのまま value になり、writer の根拠に届く。
        spec = {"args": args(), "flow_open": 1, "ruled_at": {"3": ["RS-001"]}, "questions_at": {"3": ["RS-002"]},
                "open_only_at": {"3v": [{"el": "F-091", "open": "O-RS-001"}]}, "bad_questions_at": ["3-settle"], **self._world()}
        g0 = run(spec)
        self.assertEqual(g0["result"]["status"], "needs_answers", g0["result"].get("reason"))
        fixed = g0["labels"].index("resolver:3-settle-questions")
        asked = lambda x: x["prompt"].split("検証する resolution の ID:")[1].split("\n")[0]
        again = [x["label"] for x in g0["prompts"][fixed + 1:] if x["label"].startswith("verifier:") and "RS-002" in asked(x)]
        self.assertTrue(again, "形の修正で書き換えた問いを、g1 の前に検証し直す")
        d = json.loads(Path(self.world).read_text())
        self.assertEqual(d["verdicts"]["RS-002"]["v"], d["rs"]["RS-002"]["v"], "合否は書き換えた後の版に付いている")
        r = run({"ruled_at": {"3a": ["RS-002"]}, "args": g0["result"]["next_args"], **self._world()})
        self.assertEqual(r["result"]["status"], "done", r["result"].get("reason"))

    def test_blockedの同じ段の再実行だけが入口でその段のtokenの書き込みを取り消す(self):
        base = {**self._settle_world("6"), "verifier_fail": self._fails("6", self.FAIL_060)}
        label = "resolver:6-settle-convert"
        stopped = run({**base, "args": args(), "silent_after_write": [label], **self._world()})
        tx = stopped["result"]["next_args"]["state"]["tx"]
        token = f"t{tx['seq']}"
        self.assertEqual((tx["stage"], tx["restore"], tx["try"]), ("6", token, 1))
        written = [p for p in stopped["prompts"] if p["label"].split(":")[0] in ("resolver", "verifier", "planner", "writer") and p["label"] != "writer:U-1:draft"]
        stage6 = [p for p in written if (p["label"].split(":") + [""])[1].startswith("6")]
        self.assertTrue(stage6)
        self.assertEqual({p["label"] for p in stage6 if f"トークン: {token}\n" not in p["prompt"] + "\n"}, set(), "段 6 の台帳を書く役は同じ token で書く")
        self.assertEqual(list(json.loads(Path(self.world).read_text())["tx"]), [token], "新しい token の最初の書き込みが前の段の控えを消す")
        again = run({**base, "args": stopped["result"]["next_args"], **self._world()})
        entry = nth_prompt(again, "flow-check:6-entry", 0)
        self.assertIn(f"doc_check.mjs restore --workspace /tmp/prd-w --token {token}`", entry)
        self.assertLess(entry.index("restore"), entry.index("doc_check.mjs flow"), "flow を読む前に戻す")
        self.assertEqual((again["result"]["status"], again["result"]["question_ids"]), ("needs_answers", ["RS-060"]), again["result"].get("reason"))
        self.assertEqual(len(again["result"]["integrity"]), 0, "照合を通った flow の版から止まった run は flow を書いていない")
        self.assertFalse([p for p in again["prompts"] if p["label"].startswith("flow-check:") and p["label"] != "flow-check:6-entry" and "restore" in p["prompt"]])
        rewritten = [p["prompt"] for p in again["prompts"] if p["label"].startswith("resolver:6")]
        self.assertTrue(rewritten)
        self.assertFalse([p for p in rewritten if f"トークン: {token}r1\n" not in p + "\n"], "再実行は戻す token と別の token で書く")
        self.assertNotIn(token, json.loads(Path(self.world).read_text())["tx"], "再生が入口の restore を流し直しても戻す控えが無い（その run 自身の書き込みは戻らない）")
        # 返り値で次の段へ進む run（needs_answers の再開）は、前の段の token を restore しない。
        g0 = self._g0()
        r = run({"ruled_at": {"3a": ["RS-001", "RS-002"]}, "args": g0["next_args"], **self._world()})
        self.assertNotIn("restore", nth_prompt(r, "flow-check:3a-entry", 0))
        self.assertNotIn("restore", g0["next_args"]["state"]["tx"])
        self.assertEqual(nth_prompt(r, "resolver:3a", 0).count(f"トークン: t{g0['next_args']['state']['tx']['seq'] + 1}\n"), 1, "新しい段は新しい token")

    def test_再実行の入口の前に所有表の外でflowが書き換わればintegrityは1行(self):
        base = {**self._settle_world("6"), "verifier_fail": self._fails("6", self.FAIL_060)}
        label = "resolver:6-settle-convert"
        for name, stop in (("flow を書いた後", {"silent_after_write": [label]}), ("flow を書く前", {"null_labels": ["verifier:6v"]})):
            with self.subTest(stop=name):
                Path(self.world).unlink(missing_ok=True)
                stopped = run({**base, "args": args(), **stop, **self._world()})["result"]
                self.assertEqual(stopped["next_args"]["from"], "6", stopped.get("reason"))
                again = run({**base, "args": stopped["next_args"], "tamper_before": {"flow-check:6-entry": "outside"}, **self._world()})["result"]
                self.assertEqual(len(again["integrity"]), 1, again["integrity"])

    def test_段6の裁定を書いてから止まっても再実行はその論点のroutesを失わない(self):
        # routes は resolver の返り値からしか state に入らない。止まった run の裁定が W に残ると、再実行はその論点を resolver に渡さず、
        # その単位の改稿が落ちる。restore で裁定を戻せば、再実行の resolver が同じ論点を裁定し直して routes を返す。
        units = [{"id": "U-1", "docs": ["requirements/x"], "depends_on": []}, {"id": "U-2", "docs": ["requirements/y"], "depends_on": []}]
        fs = {"wholeReviewer:r1": [{"id": "r1-wh-all-001", "route": "decision"}, {"id": "r1-wh-all-002", "route": "decision", "doc": "requirements/y", "item_id": "PR-Y-001"}]}
        full = {"units": units, "findings": fs, "about": {"RS-010": {"finding": "r1-wh-all-001"}, "RS-011": {"finding": "r1-wh-all-002"}},
                "ruled_at": {"6": ["RS-010", "RS-011"]}, "routes_at": {"6": [{"id": "RT-010", "unit": "U-1"}, {"id": "RT-011", "unit": "U-2"}]}}
        whole = run({**full, "args": args(), **self._world()})
        Path(self.world).unlink(missing_ok=True)
        partial = {"ruled_at": {"6": ["RS-010"]}, "routes_at": {"6": [{"id": "RT-010", "unit": "U-1"}]}, "silent_after_write": ["resolver:6"]}
        stopped = run({**full, **partial, "args": args(), **self._world()})
        again = run({**full, "args": stopped["result"]["next_args"], **self._world()})
        self.assertIn("r1-wh-all-001, r1-wh-all-002", nth_prompt(again, "resolver:6", 0), "止まった run が裁定した論点も resolver に渡し直す")
        revised = lambda r: [l for l in r["labels"] if l.startswith("writer:") and l.endswith(":revise")]
        self.assertEqual(revised(again), revised(whole))
        self.assertEqual(revised(whole), ["writer:U-1:revise", "writer:U-2:revise"])

    def test_再実行がまた止まれば再実行の書いたtokenを戻す(self):
        base = {**self._settle_world("6"), "verifier_fail": self._fails("6", self.FAIL_060)}
        label = "resolver:6-settle-convert"
        stop = {"silent_after_write": [label]}
        stopped = run({**base, "args": args(), **stop, **self._world()})["result"]
        seq = stopped["next_args"]["state"]["tx"]["seq"]
        again = run({**base, "args": stopped["next_args"], **stop, **self._world()})["result"]
        self.assertEqual((again["status"], again["next_args"]["from"]), ("blocked", "6"), again.get("reason"))
        self.assertEqual({k: again["next_args"]["state"]["tx"][k] for k in ("seq", "try", "restore")}, {"seq": seq, "try": 2, "restore": f"t{seq}r1"})
        third = run({**base, "args": again["next_args"], **self._world()})
        self.assertIn(f"--token t{seq}r1`", nth_prompt(third, "flow-check:6-entry", 0))
        self.assertEqual(third["result"]["status"], "needs_answers", third["result"].get("reason"))

    def test_入口のflow_checkがrestoreのstdoutを返さなければ同じ段からやり直させる(self):
        base = {**self._settle_world("6"), "verifier_fail": self._fails("6", self.FAIL_060)}
        label = "resolver:6-settle-convert"
        stopped = run({**base, "args": args(), "null_labels": [label], **self._world()})
        before = Path(self.world).read_text()
        r = run({**base, "args": stopped["result"]["next_args"], "no_restore_at": ["flow-check:6-entry"], **self._world()})["result"]
        self.assertEqual((r["status"], r["next_args"]["from"]), ("blocked", "6"), r.get("reason"))
        self.assertIn("doc_check restore の stdout を返しませんでした", r["reason"])
        self.assertEqual(Path(self.world).read_text(), before, "戻せたか分からない W の上で段を始めない")
        was, now = stopped["result"]["next_args"]["state"]["tx"], r["next_args"]["state"]["tx"]
        self.assertEqual(now, {**was, "try": was["try"] + 1}, "戻したか分からないので、同じ token を戻させ直す")

    def test_形の検査に落ちた問いを持ち越さない(self):
        self.maxDiff = None
        spec = {"args": args(), "flow_open": 1, "questions_at": {"3": ["RS-001"]}, **self._world()}
        whole = run(spec)["result"]
        Path(self.world).unlink()
        stopped = run({**spec, "bad_questions_at": ["3", "1-questions"]})
        self.assertNotIn("RS-001", stopped["result"]["next_args"]["state"].get("questions", []))
        # planner:1 の問いは段 1 の token で書くので、段 3 の restore の後も W に残り、入口が受け取って形を検査し直す（resolver:3-entry-questions が
        # 問いを書き直すので台帳の版が 1 つ進み、stub が版から数える resolutions_sha256 だけが止まらなかった run と違う。実行して確かめた）。
        lean = lambda a: {**{k: v for k, v in a.items() if k != "state_hash"}, "state": {k: v for k, v in a["state"].items() if k != "resolutions_sha256"}}
        self.assertEqual(lean(self._resume(stopped, spec)["next_args"]), lean(whole["next_args"]))

    def test_段6のverifierで止まっても同じ状態から再開する(self):
        self.maxDiff = None
        spec = {
            "args": args(), **self._world(),
            "findings": {"wholeReviewer:r1": [{"id": "r1-wh-all-001", "route": "decision"}]},
            "ruled_at": {"6": ["RS-011"]}, "questions_at": {"6": ["RS-010"]},
        }
        whole = run(spec)["result"]
        Path(self.world).unlink()
        stopped = run({**spec, "null_labels": ["verifier:6v"]})
        self.assertEqual(stopped["result"]["next_args"]["from"], "6")
        self.assertEqual(self._resume(stopped, {k: v for k, v in spec.items() if k != "args"})["next_args"], whole["next_args"])

    def test_settleのflow_framerが書いた後に止まっても段の頭のflowから再開する(self):
        # settle の flow-framer が書き換えた flow.json は、再実行の入口の restore が段に入った時点の版に戻す。next_args の flow_digest は
        # 段に入った時点の版なので、入口の照合は所有表の中の書き込みを外の書き込みとして数えない。
        D = {"FLOW_DESTRUCTIVE_UNCONSTRAINED": ["F-053"]}
        stale = [{"el": "F-053", "ref": "D-003"}]
        common = {"about": {"RS-060": {"open": "O-060"}, "RS-010": {"finding": "r1-wh-all-001"}}}
        # 段ごとの世界。止まった run が settle で足した O-060 も restore で消え、再実行は止まらなかった run と同じく settle で足して裁定する。
        worlds = (("3", {"flow_open": 1, "ruled_at": {"3": ["RS-001"], "3-settle-opens": ["RS-060"]}, "flow_codes_at": {"3v": D}}),
                  ("3", {"ruled_at": {"3-settle-opens": ["RS-060"]}, "flow_codes_at": {"3v": D}}),
                  ("6", {"findings": {"wholeReviewer:r1": [{"id": "r1-wh-all-001", "route": "decision"}]}, "ruled_at": {"6": ["RS-010"], "6-settle-opens": ["RS-060"]},
                         "flow_codes_at": {"6": D, "6v": D}}))
        silent = lambda label: {"null_labels": [label]}
        for stage, world in worlds:
            spec = {**common, **world, "open_ids_at": {f"{stage}-settle": ["O-060"]}, "unverified_at": {f"{stage}-settle": ["F-053"]}, **self._world()}
            for name, stop in (("verifier が応答しない", silent(f"verifier:{stage}v-settle")), ("settle の planner が応答しない", silent(f"planner:{stage}-settle")),
                               # O-060 を足さない planner は裁定もしない（台帳が動かないので、verifier の指摘は planner の過少申告になる）。
                               ("flow-framer の指摘が残る", {"open_ids_at": {}, "flow_codes_at": {**world["flow_codes_at"], f"{stage}v-settle": D}, "planner_leaves_at": {f"{stage}-settle": ["RS-060"]}}),
                               ("flow-framer の flow が閉じない", {"flow_findings_at": {f"{stage}-settle": 1, f"{stage}-settle-rework": 1}}),
                               ("settle が収束しない", {"stale_refs_at": {f"{stage}v-settle": stale, f"{stage}v-settle-2": stale}}),
                               ("申告した O- が verifier と違う", {"open_ids_at": {f"{stage}-settle": ["O-060"], f"{stage}v-settle": ["O-060", "O-061"]}})):
                with self.subTest(stage=stage, world=sorted(world), stop=name):
                    Path(self.world).unlink(missing_ok=True)
                    stopped = run({**spec, "args": args(), **stop})
                    self.assertEqual(stopped["result"]["next_args"]["from"], stage, stopped["result"].get("reason"))
                    self.assertIn(f"planner:{stage}-settle", stopped["labels"])
                    again = run({**spec, "args": stopped["result"]["next_args"]})
                    resumed = again["result"]
                    self.assertEqual((resumed["status"], resumed["integrity"]), ("done", []), resumed.get("reason"))
                    d = json.loads(Path(self.world).read_text())
                    if "O-060" in d.get("open_ids", []):
                        self.assertEqual(d["rs"].get("RS-060", {}).get("about"), {"open": "O-060"}, "止まった run が足した O- は再実行でも裁定される")
                    # 所有表の外の書き込みは、入口の flow-check の後で最初に flow.json を照合する agent の前に入れる（writer は照合しない）。
                    first = again["labels"][1]
                    if first.startswith("writer:"):
                        continue
                    Path(self.world).unlink(missing_ok=True)
                    stopped = run({**spec, "args": args(), **stop})
                    tampered = self._resume(stopped, {**spec, "tamper_before": {first: "f-x"}})
                    self.assertEqual((tampered["status"], tampered["next_args"]), ("blocked", None), "再実行の間の所有表の外の書き込みは止める")
                    self.assertIn("所有表の外", tampered["reason"])

    def _left_on_disk(self):
        d = on_disk(self.world)
        return {"unverified": [x for x in d["unverified"] if x not in d["failed_current"]], "no_verdict": d["no_verdict"]}

    def test_止まったrunが書いて検証していないものは再実行が検証してから段を出る(self):
        # 検証の前に止まった run の書き込み（settle の flow-framer が直した要素・resolver が書いた裁定）は、再実行の入口の restore が段の頭の
        # 台帳に戻す。再実行は段の頭から検証し直し、止まらなかった run と同じ結果になる。
        D = {"FLOW_DESTRUCTIVE_UNCONSTRAINED": ["F-053"]}
        silent = lambda label: {"null_labels": [label]}
        g1 = {"findings": {"wholeReviewer:r1": [{"id": "r1-wh-all-001", "route": "decision"}]}}
        opens = {**g1, "about": {"RS-060": {"open": "O-060"}, "RS-010": {"finding": "r1-wh-all-001"}}, "ruled_at": {"6": ["RS-010"]},
                 "flow_codes_at": {"6": D, "6v": D}, "open_ids_at": {"6-settle": ["O-060"]}, "unverified_at": {"6-settle": ["F-053"]}}
        # 回答を当てる段では resolver が flow の stdout を返し、候補の選択だけなら verifier は起動しないので、世界はその stdout に置く。
        only = lambda st: {"about": {"RS-010": {"open": "O-010"}}, "open_only_at": {st if st == "3a'" else f"{st}v": [{"el": "F-004", "open": "O-010"}]},
                           "unverified_at": {f"{st}-settle": ["F-004"], f"{st}-settle-rework": ["F-004"]}}
        no_cc = lambda st: {"no_conflicts_check_at": [f"{st}-settle", f"{st}-settle-rework"]}
        stale = [{"el": "F-002", "ref": "D-001"}]
        hold = {"findings": {"writerReviewer:r1": [{"id": "r1-wr-all-001", "route": "decision"}]},
                "questions_at": {"6": ["RS-020"]}, "supersedes_at": {"6-hold": ["D-001"]}, "stale_refs_at": {"6-hold": stale, "6-holdv-left": stale}, "unverified_at": {"6-hold-settle": ["F-002"]}}
        cases = (
            ("段 6 の settle の verifier が応答しない（RS-060 は合格する裁定）", "6", {**opens, "ruled_at": {"6": ["RS-010"], "6-settle-opens": ["RS-060"]}},
             silent("verifier:6v-settle")),
            ("段 6 の settle の verifier が応答しない（RS-060 は問い）", "6", {**opens, "questions_at": {"6-settle-opens": ["RS-060"]}}, silent("verifier:6v-settle")),
            ("段 6 の flow-framer が conflicts を返さない", "6", {**g1, **only("6"), "ruled_at": {"6": ["RS-010"]}}, no_cc("6")),
            ("段 6 の flow-framer が書いてから応答しない", "6", {**opens, "ruled_at": {"6": ["RS-010"], "6-settle-opens": ["RS-060"]}},
             {"silent_after_write": ["planner:6-settle"]}),
            ("上限の段 6 の保持規則への変換の後の verifier が応答しない", "6", hold, silent("verifier:6-holdv-settle")),
        )
        for name, stage, base, stop in cases:
            with self.subTest(name):
                self._check_rerun(stage, base, stop, usable=["RS-060"] if "RS-060 は合格" in name else (), at_limit6=base is hold)
        # 段 6 のゲートの後の 3a' の settle で止まる（前回の probe2）。段 6 のゲートまでの run は同じ W で先に走らせる。
        name = "3a' の flow-framer が conflicts を返さない"
        with self.subTest(name):
            before = {**g1, "questions_at": {"6": ["RS-010"]}, "about": only("3a'")["about"]}
            base = {**only("3a'"), "ruled_at": {"3a'": ["RS-010"]}}
            self._check_rerun("3a'", base, no_cc("3a'"), before=before)

    def _check_rerun(self, stage, base, stop, before=None, usable=(), at_limit6=False):
        """at_limit6: 段 6 から聞ける回数を使い切った状態で始める（段 6 の問いを保持規則に変える経路）。"""
        def start():
            Path(self.world).unlink(missing_ok=True)
            if at_limit6:
                return stage6_at_limit({**base, "args": args(), **self._world()})
            if before is None:
                return args()
            g = run({**before, "args": args(), **self._world()})["result"]
            self.assertEqual(g["status"], "needs_answers", g.get("reason"))
            return g["next_args"]
        full = run({**base, "args": start(), **self._world()})
        whole = full["result"]
        for id_ in usable:
            self.assertIn(id_, next(l for l in nth_prompt(full, "writer:U-1:revise", -1).split("\n") if l.startswith("- 根拠にしてよい resolution")))
        self.assertEqual(self._left_on_disk(), {"unverified": [], "no_verdict": []}, "止まらなかった run は検証を通っていないものを残さない")
        stopped = run({**base, "args": start(), **stop, **self._world()})
        self.assertEqual(stopped["result"]["next_args"]["from"], stage, stopped["result"].get("reason"))
        self.assertNotEqual(self._left_on_disk(), {"unverified": [], "no_verdict": []}, "止まった run は検証の前の書き込みを W に残す")
        again = run({**base, **self._world(), "args": stopped["result"]["next_args"]})
        self.assertIsNone(again["error"], again["error"])
        resumed = again["result"]
        self.assertEqual((resumed["status"], resumed["holds"], resumed["hold_drafts"]), (whole["status"], whole["holds"], whole["hold_drafts"]), resumed.get("reason"))
        for id_ in usable:
            line = lambda r: next(l for l in nth_prompt(r, "writer:U-1:revise", -1).split("\n") if l.startswith("- 根拠にしてよい resolution"))
            self.assertIn(id_, line(again), "止まった run の裁定も、止まらなかった run と同じく根拠として writer に渡る")
        self.assertEqual(self._left_on_disk(), {"unverified": [], "no_verdict": []})
        wrote_unreturned = "silent_after_write" in stop
        self.assertEqual(len(resumed["integrity"]), 1 if wrote_unreturned else 0, "照合を通らなかった書き込みだけを integrity に数える")
        if wrote_unreturned:
            self.assertIn("段の入口の版", resumed["integrity"][0], "照合の前に止まった flow の書き込みは restore で戻したものとして数える")

    def test_返らなかった裁定は同じrunの中でもsettleの前に検証しstateに入れる(self):
        # 応答した resolver が書いたのに返さなかった裁定は、W にだけ残る。flow-check の resolutions（--rulings）から受け取って検証し、止まらなかった run と同じく保持規則に数える。
        spec = {"findings": {"writerReviewer:r1": [{"id": "r1-wr-all-001", "route": "decision"}]},
                "questions_at": {"6": ["RS-020"]}, "orphans_at": {"6-hold": ["RS-077"]}, "about": {"RS-077": {"open": "O-077"}}, **self._world()}
        # 段 6 の問いを保持規則に変える経路（聞ける回数の上限）で、保持規則への変換の resolver が返さなかった裁定。
        r = run({**spec, "args": stage6_at_limit({**spec, "args": args()})})
        res = r["result"]
        self.assertEqual(res["status"], "done", res.get("reason"))
        self.assertIn("verifier:6-holdv-left", r["labels"])
        self.assertIn("RS-077", res["holds"] + res["hold_drafts"])
        self.assertEqual(self._left_on_disk(), {"unverified": [], "no_verdict": []})
        # 段の本体の resolver が返さなかった裁定も、段をやり直させずに同じ run の settle の前に検証する。
        Path(self.world).unlink()
        main = run({"args": args(), "findings": {"wholeReviewer:r1": [{"id": "r1-wh-all-001", "route": "decision"}]}, "ruled_at": {"6": ["RS-010"]},
                    "orphans_at": {"6": ["RS-077"]}, "about": {"RS-077": {"open": "O-077"}}, **self._world()})
        # 段 6 は聞けるので、返さずに書いた hold は問いに書き換え直させてゲートで聞く。
        self.assertEqual(main["result"]["status"], "needs_answers", main["result"].get("reason"))
        self.assertIn("verifier:6v-left", main["labels"])
        self.assertIn("RS-077", main["result"]["question_ids"])
        self.assertEqual(self._left_on_disk(), {"unverified": [], "no_verdict": []})

    def test_直す役のいない段の入口で検証に落ちた要素があれば書く前に止める(self):
        stopped = run({"args": args(), "findings": {"writerReviewer:r1": [{"id": "r1-wr-all-001"}]}, "null_labels": ["writer:U-1:revise"], **self._world()})
        self.assertEqual(stopped["result"]["next_args"]["from"], "7", stopped["result"].get("reason"))
        d = json.loads(Path(self.world).read_text())
        d["els"]["F-070"] = 1
        Path(self.world).write_text(json.dumps(d))
        fail = [{"id": "F-070", "kind": "insufficient_grounds", "reason": "出典が無い"}]
        r = run({"args": stopped["result"]["next_args"], "fails_when_asked": fail, **self._world()})
        self.assertIn("verifier:7v-entry", r["labels"])
        self.assertFalse(has(r["labels"], "writer:"), "落ちた要素を根拠にしうる writer を起動しない")
        res = r["result"]
        self.assertEqual((res["status"], res["next_args"]), ("blocked", None), res.get("reason"))
        self.assertIn("段 7 の入口の flow に不合格の要素 F-070 があります（所有表の外の書き込み", res["reason"])

    def test_settleで落ちたまま止まった要素は再実行でも直させて止まる(self):
        # 止まらなかった run は settle で落ち続けた要素で止まる。再実行も同じ要素を W の不合格から拾って直させ、直らなければ同じく止まる（done にならない）。
        g1 = {"findings": {"wholeReviewer:r1": [{"id": "r1-wh-all-001", "route": "decision"}]}}
        fail = [{"id": "F-004", "kind": "insufficient_grounds", "reason": "出典が無い"}]
        base = {**g1, "about": {"RS-010": {"open": "O-010"}}, "ruled_at": {"6": ["RS-010"]}, "open_only_at": {"6v": [{"el": "F-004", "open": "O-010"}]},
                "unverified_at": {"6-settle": ["F-004"], "6-settle-2": ["F-004"]}, "fails_when_asked": fail, **self._world()}
        stopped = run({**base, "args": args()})
        self.assertEqual((stopped["result"]["status"], stopped["result"]["next_args"]["from"]), ("blocked", "6"), stopped["result"].get("reason"))
        self.assertEqual(on_disk(self.world)["failed_current"], ["F-004"])
        resumed = self._resume(stopped, base)
        self.assertEqual((resumed["status"], resumed["next_args"]["from"]), ("blocked", "6"), resumed.get("reason"))
        self.assertIn("不合格: F-004", resumed["reason"])

    def test_再実行の間のflowの書き換えは入口でintegrityに数えて検証し直す(self):
        # 版の食い違いで止めない。要素の合否は (id, digest) で持つので、書き換えた要素は unverified に戻り、段を出る前に検証される。
        spec = {"findings": {"wholeReviewer:r1": [{"id": "r1-wh-all-001", "route": "decision"}]}, "ruled_at": {"6": ["RS-010"]}, **self._world()}
        stopped = run({**spec, "args": args(), "null_labels": ["verifier:6v"]})
        resumed = run({**spec, "args": stopped["result"]["next_args"], "tamper_before": {"flow-check:6-entry": "f-x"}})["result"]
        self.assertEqual(resumed["status"], "done", resumed.get("reason"))
        self.assertEqual(len(resumed["integrity"]), 1)
        self.assertIn("段 6 の入口の flow.json（f-x）", resumed["integrity"][0])

    def test_入口で採ったWの版と行は同じ段の再実行のnext_argsに載る(self):
        # 入口で採った版を next_args が運ばないと、再実行の入口が同じ食い違いを数え直し、W の版と違う版を照合の基準にする。
        spec = {"findings": {"wholeReviewer:r1": [{"id": "r1-wh-all-001", "route": "decision"}]}, "ruled_at": {"6": ["RS-010"]}, **self._world()}
        stopped = run({**spec, "args": args(), "null_labels": ["verifier:6v"]})["result"]
        again = run({**spec, "args": stopped["next_args"], "tamper_before": {"flow-check:6-entry": "f-x"}, "null_labels": ["verifier:6v"]})["result"]
        self.assertEqual((again["status"], again["next_args"]["from"]), ("blocked", "6"), again.get("reason"))
        st = again["next_args"]["state"]
        self.assertEqual(st["flow_digest"], "f-x")
        self.assertEqual([l for l in st["integrity"] if "段 6 の入口の flow.json（f-x）" in l], again["integrity"])
        resumed = run({**spec, "args": again["next_args"]})["result"]
        self.assertEqual(resumed["status"], "done", resumed.get("reason"))
        self.assertEqual(len(resumed["integrity"]), 1, resumed["integrity"])

    def test_段3から始めたrunで生成者のいないflowの食い違いはnext_argsを付けず行を重ねない(self):
        # 段 1 から続く run は planner:1 が flow を書いたので段 1 からやり直す（PlannerStages）。段 3 から始めた run には flow を書く生成者がいない。
        state = {"units": [{"id": "U-1", "docs": ["requirements/x"], "depends_on": []}], "flow_digest": "f-framer", "plan_sha256": "plan", "covers": {}}
        r = run({"args": args(**{"from": "3", "state": state}), **self._world(), "tamper_before": {"verifier:3v": "f-x"}})["result"]
        self.assertEqual(r["status"], "blocked")
        self.assertIsNone(r["next_args"])
        self.assertIn("所有表の外", r["reason"])
        self.assertEqual(len(r["integrity"]), 1)

    def test_3aのflowの食い違いは同じ段の再実行で生成者が検査し直す(self):
        g0 = self._g0()
        at_g0 = Path(self.world).read_text()
        spec = {"ruled_at": {"3a": ["RS-001", "RS-002"]}, "questions_at": {"3a": ["RS-003"]}, **self._world()}
        stopped = run({**spec, "args": g0["next_args"], "tamper_before": {"verifier:3av": "f-x"}})
        self.assertEqual(stopped["result"]["next_args"]["from"], "3a")
        self.assertEqual(len(stopped["result"]["integrity"]), 1)
        resumed = self._resume(stopped, spec)
        self.assertEqual(resumed["status"], "needs_answers")
        self.assertEqual(len(resumed["integrity"]), 1, "所有表の外の書き込みは、再実行の入口でも integrity に数える")
        self.assertIn("段 3a の入口の flow.json（f-x）", resumed["integrity"][0])
        Path(self.world).write_text(at_g0)
        whole = run({**spec, "args": g0["next_args"], "tamper_before": {"flow-check:3a-entry": "f-x"}})["result"]
        drop = lambda na: {**na, "state": {k: v for k, v in na["state"].items() if k != "integrity"}, "state_hash": None}
        self.assertEqual(drop(resumed["next_args"]), drop(whole["next_args"]), "W の flow.json が f-x のまま止まらずに走った run と同じ")

    # 段の途中で作られて合否まで付いた resolution（settle の resolver の裁定・settle の verifier の合否）は、段の頭の state に無い。
    # 再実行は resolutions.json と verifications.json から、止まらなかった run が state に持つのと同じものを受け取る。
    D = {"FLOW_DESTRUCTIVE_UNCONSTRAINED": ["F-053"]}
    G1 = {"findings": {"wholeReviewer:r1": [{"id": "r1-wh-all-001", "route": "decision"}]}}
    FAIL_060 = [{"id": "RS-060", "kind": "insufficient_grounds", "reason": "根拠が無い"}]

    @staticmethod
    def _fails(stage, fail):
        # settle の verifier の不合格は 1 回差し戻され（<段>-settle-fix）、その verifier にも落ちて初めて変換に回る。
        return {f"{stage}v-settle": fail, f"{stage}-settle-fixv": fail}

    def _settle_world(self, stage):
        common = {"flow_codes_at": {**({} if stage == "3" else {stage: self.D}), f"{stage}v": self.D}, "open_ids_at": {f"{stage}-settle": ["O-060"]}, "unverified_at": {f"{stage}-settle": ["F-053"]}}
        if stage == "6":
            return {**self.G1, **common, "about": {"RS-060": {"open": "O-060"}, "RS-010": {"finding": "r1-wh-all-001"}}, "ruled_at": {"6": ["RS-010"], "6-settle-opens": ["RS-060"]}}
        return {**common, "flow_open": 1, "open_ids_at": {"framer": ["O-RS-001"], "3-settle": ["O-060"]}, "about": {"RS-060": {"open": "O-060"}}, "ruled_at": {"3": ["RS-001"], "3-settle-opens": ["RS-060"]}}

    def _w(self):
        d = json.loads(Path(self.world).read_text())
        d.pop("tx", None)
        return d

    def _usable(self, r):
        ps = [p["prompt"] for p in r["prompts"] if p["label"].startswith("writer:U-1:")]
        line = next(l for l in ps[-1].split("\n") if l.startswith("- 根拠にしてよい resolution"))
        return sorted(x for x in line.split(": ", 1)[1].split(", ") if x != "（なし）")

    def _ledger_consistent(self):
        d = json.loads(Path(self.world).read_text())
        failed = [i for i, r in d["rs"].items() if d["verdicts"].get(i, {}).get("verdict") == "fail" and r.get("ruling") not in ("hold", "question")]
        self.assertEqual(failed, [], "検証に落ちた裁定は、保持規則か問いに変わっている")
        self.assertEqual(self._left_on_disk(), {"unverified": [], "no_verdict": []})

    def _w_duplicate_abouts(self):
        """W の resolution の about の重複（問いで止まる run は writer に届かないので、W で数える）。"""
        keys = [json.dumps(r["about"], sort_keys=True) for r in json.loads(Path(self.world).read_text())["rs"].values()]
        return sorted(k for k in set(keys) if keys.count(k) > 1)

    def _compare(self, base, stop, start=None, again_kw=None):
        def begin():
            Path(self.world).unlink(missing_ok=True)
            return start() if start else args()
        whole = run({**base, "args": begin(), **self._world()})
        whole_w = self._w()
        stopped = run({**base, "args": begin(), **stop, **self._world()})
        self.assertEqual(stopped["result"]["status"], "blocked", stopped["result"].get("reason"))
        self.assertIsNotNone(stopped["result"]["next_args"], stopped["result"].get("reason"))
        again = run({**base, **(again_kw or {}), **self._world(), "args": stopped["result"]["next_args"]})
        self.assertIsNone(again["error"], again["error"])
        pick = lambda r: (r["result"]["status"], r["result"]["holds"], r["result"]["hold_drafts"], r["result"].get("question_ids"), (r["result"]["next_args"] or {}).get("from"))
        self.assertEqual(pick(again), pick(whole), again["result"].get("reason"))
        if not again_kw:
            self.assertEqual(self._w(), whole_w, "restore で段の頭に戻した W から、止まらなかった run と同じ W に着く")
        if has(whole["labels"], "writer:U-1:revise"):
            self.assertEqual(self._usable(again), self._usable(whole), "止まった run が合否まで付けた裁定も、止まらなかった run と同じく writer に渡る")
        self._ledger_consistent()
        return whole, again

    def test_settleで落ちた裁定の変換の前に止まっても再実行が変換する(self):
        for stage in ("6", "3"):
            base = {**self._settle_world(stage), "verifier_fail": self._fails(stage, self.FAIL_060)}
            label = f"resolver:{stage}-settle-convert"
            for name, stop in (("変換が応答しない", {"null_labels": [label]}), ("変換が書いてから応答しない", {"silent_after_write": [label]})):
                with self.subTest(stage=stage, stop=name):
                    whole, again = self._compare(base, stop)
                    # 聞ける段では、差し戻しの後も落ちた価値の論点（O-）は問いになる（保持規則にすると聞けば答えの出る論点が残る）。
                    self.assertEqual((whole["result"]["status"], whole["result"]["question_ids"]), ("needs_answers", ["RS-060"]))
        # 問いを返してよい段では、value_as_method の不合格は問いになる。入口の変換も段と同じく問いにする（入口だけ保持規則にしない）。
        for stage in ("6", "3"):
            base = {**self._settle_world(stage), "verifier_fail": self._fails(stage, [{**self.FAIL_060[0], "kind": "value_as_method"}])}
            label = f"resolver:{stage}-settle-convert"
            with self.subTest(stage=stage, kind="value_as_method"):
                whole, again = self._compare(base, {"null_labels": [label]})
                self.assertEqual((whole["result"]["status"], whole["result"]["question_ids"]), ("needs_answers", ["RS-060"]))

    def test_settleで合格した裁定の反映の前に止まっても再実行がflowに写す(self):
        for stage in ("6", "3"):
            world = self._settle_world(stage)
            base = {**world, "open_only_at": {f"{stage}v-settle": [{"el": "F-053", "constraint": "O-060"}]},
                    "unverified_at": {**world["unverified_at"], f"{stage}-settle-2": ["F-053"]}}
            with self.subTest(stage=stage):
                whole, again = self._compare(base, {"null_labels": [f"planner:{stage}-settle-2"]})
                wrote = lambda r: [p["label"] for p in r["prompts"] if p["label"].startswith("planner:") and "F-053 の O-060 ← RS-060" in p["prompt"]]
                self.assertTrue(wrote(whole))
                self.assertTrue(wrote(again), "合格した RS-060 を、F-053 の constrained_by の O-060 に差し替えさせる")
                if stage == "6":
                    self.assertIn("RS-060", self._usable(again))

    def test_段6で問いを返してsettleで止まっても再実行は段6のゲートで聞く(self):
        base = {**self._settle_world("6"), "ruled_at": {"6-settle-opens": ["RS-060"]}, "questions_at": {"6": ["RS-010"]}}
        whole, again = self._compare(base, {"null_labels": ["verifier:6v-settle"]})
        self.assertEqual((whole["result"]["status"], whole["result"]["question_ids"]), ("needs_answers", ["RS-010"]))

    def test_差し戻しが書き直してから止まった裁定は再実行が検証し直す(self):
        # 不合格の後に書き直した裁定は、前の不合格が付いたままだと変換され、止まらなかった run では合格する裁定が保持規則になる。
        fail = [{"id": "RS-010", "kind": "insufficient_grounds", "reason": "根拠が無い"}]
        base = {**self.G1, "about": {"RS-010": {"finding": "r1-wh-all-001"}}, "ruled_at": {"6": ["RS-010"], "6-fix": ["RS-010"]}, "verifier_fail": {"6v": fail}}
        whole, again = self._compare(base, {"silent_after_write": ["resolver:6-fix"]})
        self.assertEqual(self._usable(whole), ["RS-010"])
        self.assertIn("verifier:6-fixv", again["labels"], "restore で書き直しの前に戻った RS-010 を、段の本体の差し戻しが書き直して検証し直す")

    def test_入口と拾う側の呼び出しでもlabelは重ならない(self):
        # telemetry と再開の照合は label で呼び出しを引く。入口（<段>-entry・<段>v-entry）と、検証し残しを拾う verifier（<段>v-left・
        # <段>v-left-<n+1>）の label が段の本体の呼び出しと重なると、呼び出しを取り違える。
        base = {**self._settle_world("6"), **self._world()}
        stopped = run({**base, "args": args(), "null_labels": ["verifier:6v"]})
        self.assertEqual(stopped["result"]["next_args"]["from"], "6", stopped["result"].get("reason"))
        # 再実行の前に、所有表の外で要素 F-070 が書き換わる（止まった run は flow.json を書いていないので restore は戻さず、入口の verifyLeft が検証する）。
        d = json.loads(Path(self.world).read_text())
        d["els"]["F-070"] = 1
        Path(self.world).write_text(json.dumps(d))
        orphans = {"orphans_at": {"6": ["RS-077"], "6-settle-opens": ["RS-078"]}, "about": {**base["about"], "RS-077": {"open": "O-077"}, "RS-078": {"open": "O-078"}}}
        r = run({**base, "args": stopped["result"]["next_args"], **orphans, "flow_codes_at": {**base["flow_codes_at"], "6v-left": self.D}})
        # 段 6 は聞ける回数が残っていれば聞けるので、返さずに書いた hold（RS-077・RS-078）は問いに書き換え直させて段 6 のゲートで聞く。
        self.assertEqual(r["result"]["status"], "needs_answers", r["result"].get("reason"))
        cycle = [l for l in r["labels"] if l.split(":")[0] in ("resolver", "verifier", "planner", "flow-check")]
        for want in ("flow-check:6-entry", "verifier:6v-entry", "resolver:6", "verifier:6v", "verifier:6v-left", "planner:6-settle",
                     "verifier:6v-settle", "verifier:6v-left-2"):
            self.assertIn(want, cycle)
        self.assertEqual(len(cycle), len(set(cycle)), sorted(l for l in cycle if cycle.count(l) > 1))
        self._ledger_consistent()

    def test_段1からの再実行は止まった段の書き込みを残さずに止まらなかったrunと同じWに着く(self):
        # 止まった planner:1 が open.json に O-099 を足し、flow.json と resolutions.json を書いた。put はキー単位で足すので、戻さずに再実行すると O-099 が残る。
        # 段 1 からは入口の reset が戻す（段 2 は無い。planner:1 の差し戻しの後も落ちた run も段 1 から）。
        base = {"flow_open": 1, "ruled_at": {"3": ["RS-001"]}}
        left = {"open_ids_at": {"framer": ["O-001", "O-099"]}}
        for name, stop in (("plan の照合に落ちる", {**left, "plan_seen": {"sha": "plan-edited"}}), ("差し戻しの後も flow が閉じない", {**left, "flow_findings_at": {"framer": 1, "rework": 1}})):
            with self.subTest(name):
                whole, again = self._compare(base, stop)
                self.assertEqual(again["labels"][:2], ["flow-check:1-entry", "planner:1"])
                self.assertEqual(again["result"], whole["result"])

    def test_再利用したWで新しいrunを始めても前のランの台帳と控えを引き継がない(self):
        # 前のランは 段 6 のゲートまで進んだ（後の段の token の控え・裁定・合否が W に残る）。新しいランの最初の書き込みの token（t1）は、
        # 入口の reset が無いと後の token の控えに拒まれる。
        base = {"flow_open": 1, "ruled_at": {"3": ["RS-001"]}}
        whole = run({**base, "args": args(), **self._world()})
        whole_w = self._w()
        Path(self.world).unlink()
        prev = run({**self.G1, "args": args(), "questions_at": {"6": ["RS-010"]}, **self._world()})["result"]
        self.assertEqual(prev["status"], "needs_answers", prev.get("reason"))
        self.assertTrue(json.loads(Path(self.world).read_text())["tx"])
        again = run({**base, "args": args(), **self._world()})
        self.assertIsNone(again["error"], again["error"])
        self.assertEqual(again["result"], whole["result"])
        self.assertEqual(self._w(), whole_w)

    def test_戻す控えを後の段のtokenが消していればnext_argsを付けずに止まる(self):
        # 打ち間違えた token（t<seq+24>）の書き込みが、止まった段の控えを消した。黙って 0 件を戻すと、止まった run の書き込みの上で段が始まる。
        base = {**self._settle_world("6"), "verifier_fail": self._fails("6", self.FAIL_060)}
        label = "resolver:6-settle-convert"
        stopped = run({**base, "args": args(), "silent_after_write": [label], **self._world()})["result"]
        typo = f"t{stopped['next_args']['state']['tx']['seq'] + 24}"
        d = json.loads(Path(self.world).read_text())
        d["tx"] = {typo: {}}
        Path(self.world).write_text(json.dumps(d))
        r = run({**base, "args": stopped["next_args"], **self._world()})
        res = r["result"]
        self.assertEqual((res["status"], res["next_args"]), ("blocked", None), res.get("reason"))
        self.assertIn(typo, res["reason"])
        self.assertIn("S0 からやり直", res["reason"])
        self.assertEqual(r["labels"], ["flow-check:6-entry"], "戻せなかった W の上で段を始めない")
        self.assertEqual(json.loads(Path(self.world).read_text()), d)

    def test_flowを書かない段の再実行はtx_flowを運ばない(self):
        # tx.flow は restore が flow.json を戻したときの照合にだけ使う。段 8 の入口が所有表の外の flow の書き換えを取り込んでも、段 8 に flow を
        # 書く役はいないので、止まった再実行の next_args に載せない（載せると next_args の上限の見積もりが実際より大きくなる）。
        spec = {"findings": {"writerReviewer:r1": [{"id": "r1-wr-all-001"}]}, **self._world()}
        auditor = "writerReviewer:r2:all"
        stop = {"null_labels": [auditor]}
        first = run({**spec, "args": args(), **stop})["result"]
        self.assertEqual((first["status"], first["next_args"]["from"]), ("blocked", "8"), first.get("reason"))
        again = run({**spec, "args": first["next_args"], **stop, "tamper_before": {"flow-check:8-entry": "outside"}})["result"]
        self.assertEqual((again["status"], again["next_args"]["from"]), ("blocked", "8"), again.get("reason"))
        self.assertTrue(any("段 8 の入口の flow.json（outside）" in l for l in again["integrity"]), again["integrity"])
        self.assertNotIn("flow", again["next_args"]["state"]["tx"])

    def test_新しいIDを振るresolverでも再実行は裁定済みの論点を裁定し直さない(self):
        # 実物の resolver は再実行で前の run と別の ID を振る。止まった run の裁定が W に残ると、同じ about に使える裁定が 2 つできる。
        for stage in ("6", "3"):
            base = {**self._settle_world(stage), "verifier_fail": self._fails(stage, self.FAIL_060)}
            label = f"resolver:{stage}-settle-convert"
            stop = {"null_labels": [label]}
            with self.subTest(stage=stage):
                whole, again = self._compare(base, stop, again_kw={"fresh_ids": True})
                self.assertEqual(self._w_duplicate_abouts(), [])


@unittest.skipIf(shutil.which("node") is None, "node が無い環境ではスキップする")
class FailedHolds(unittest.TestCase):
    """hold のまま検証に落ちた保持規則は writer に渡さない。同じ ID で書き直させて検証し直し、書き直した直後にも落ちれば段の頭から。"""

    FAIL = [{"id": "RS-002", "kind": "insufficient_grounds", "reason": "保持規則が触れる項目が無い"}]

    def _g02(self):
        """g1 の回答を当てた 3a が続きの問い RS-002 を出して g2 で止まる。返す next_args は聞ける回数を使い切った（at_limit）もので、
        その 3a は残った問いを保持規則に変える（holdLeft）。"""
        g1 = run({"args": args(), "flow_open": 1, "questions_at": {"3": ["RS-001"]}})["result"]
        g2 = run({"args": g1["next_args"], "ruled_at": {"3a": ["RS-001"]}, "questions_at": {"3a": ["RS-002"]}})["result"]
        assert (g2["status"], g2["gate"]) == ("needs_answers", "g2"), g2
        return {**g2, "next_args": at_limit(g2["next_args"])}

    def _held(self, r):
        ps = [p["prompt"] for p in r["prompts"] if p["label"].startswith("writer:")]
        return [l for p in ps for l in p.split("\n") if l.startswith("- 保持規則として")]

    def test_保持規則への変換の後に落ちた保持規則は書き直して検証し直してからwriterに渡す(self):
        r = run({"args": self._g02()["next_args"], "verifier_fail": {"3a-holdv-left": self.FAIL}})
        labels = r["labels"]
        self.assertEqual(labels[labels.index("verifier:3a-holdv-left") + 1:][:2], ["resolver:3a-hold-left-rehold", "verifier:3a-hold-left-reholdv"])
        self.assertIn("ID は変えない: RS-002", nth_prompt(r, "resolver:3a-hold-left-rehold", 0))
        self.assertEqual(r["result"]["status"], "done", r["result"].get("reason"))
        self.assertEqual(r["result"]["holds"], ["RS-002"])
        self.assertLess(labels.index("verifier:3a-hold-left-reholdv"), labels.index("writer:U-1:draft"))

    def test_書き直しても落ちる保持規則はwriterに渡さず段の頭からやり直させる(self):
        g02 = self._g02()
        r = run({"args": g02["next_args"], "verifier_fail": {"3a-holdv-left": self.FAIL, "3a-hold-left-reholdv": self.FAIL}})
        res = r["result"]
        self.assertEqual((res["status"], res["next_args"]["from"]), ("blocked", "3a"), res.get("reason"))
        self.assertIn("RS-002 が書き直した後も検証に落ちました", res["reason"])
        self.assertFalse(has(r["labels"], "writer"))
        self.assertEqual(res["next_args"]["state"]["questions"], g02["next_args"]["state"]["questions"], "段に入った時点の state からやり直す")

    # 聞ける段では回答待ちの問いが次のゲートへ出るので、保持規則の書き直しは聞ける回数を使い切った g2 の後の 3a（_g02）で確かめる。
    def test_差し戻しの後も落ちた保持規則はもう書き直さない(self):
        # 3a で hold を返し、検証に落ちて差し戻しでも hold のまま落ちた。差し戻しが書き直しに当たるので、もう 1 回は回さない。
        r = run({"args": self._g02()["next_args"], "holds_at": {"3a": ["RS-002"], "3a-fix": ["RS-002"]}, "verifier_fail": {"3av": self.FAIL, "3a-fixv": self.FAIL}})
        res = r["result"]
        self.assertEqual((res["status"], res["next_args"]["from"]), ("blocked", "3a"), res.get("reason"))
        self.assertIn("RS-002 が書き直した後も検証に落ちました", res["reason"])
        self.assertFalse(has(r["labels"], "resolver:3a-fix-rehold"))
        self.assertFalse(has(r["labels"], "resolver:3a-convert"), "落ちた保持規則を、検証しない変換で保持規則に書き直さない")

    def test_差し戻しで初めて保持規則になって落ちたものは1回書き直させる(self):
        r = run({"args": self._g02()["next_args"], "free_text_at": {"3a": ["RS-002"]}, "holds_at": {"3a-fix": ["RS-002"]}, "verifier_fail": {"3av": self.FAIL, "3a-fixv": self.FAIL}})
        self.assertIn("resolver:3a-fix-rehold", r["labels"])
        self.assertFalse(has(r["labels"], "resolver:3a-convert"), "書き直して合格した保持規則を、検証しない変換で書き直さない")
        self.assertEqual(r["result"]["status"], "done", r["result"].get("reason"))
        self.assertEqual(r["result"]["holds"], ["RS-002"])

    def test_差し戻しで値の裁定に変えた元の保持規則は保持規則に数えない(self):
        # 3a の hold が 3av に落ち、差し戻しが値の裁定に変えた。W の ruling が hold でなくなった ID を holds に残すと、
        # 3a-fixv に落ちたときに変換されず「書き直した後も落ちた保持規則」で止まり、合格しても保持規則として返る。
        base = {"args": self._g02()["next_args"], "holds_at": {"3a": ["RS-002"]}, "ruled_at": {"3a-fix": ["RS-002"]}}
        failed = run({**base, "verifier_fail": {"3av": self.FAIL, "3a-fixv": self.FAIL}})
        self.assertEqual(failed["result"]["status"], "done", failed["result"].get("reason"))
        self.assertIn("resolver:3a-convert", failed["labels"])
        self.assertFalse(has(failed["labels"], "resolver:3a-fix-rehold"))
        passed = run({**base, "verifier_fail": {"3av": self.FAIL}})["result"]
        self.assertEqual((passed["status"], passed["holds"], passed["hold_drafts"]), ("done", [], []), passed.get("reason"))

    def test_settleのverifierに落ちた保持規則も変換せずに書き直させる(self):
        # 聞ける回数を使い切った段の settle の flow-framer が足した O-060 を、resolver が保持規則で閉じ、settle の verifier がそれを落とす。
        destructive = {"FLOW_DESTRUCTIVE_UNCONSTRAINED": ["F-053"]}
        fail = [{**self.FAIL[0], "id": "RS-060"}]
        r = run({"args": self._g02()["next_args"], "unverified_at": {"3a-hold-settle": ["F-053"]}, "flow_codes_at": {"3a-hold": destructive, "3a-holdv-left": destructive},
                 "open_ids_at": {"3a-hold-settle": ["O-060"]}, "about": {"RS-060": {"open": "O-060"}}, "holds_at": {"3a-hold-settle-opens": ["RS-060"]},
                 "verifier_fail": {"3a-holdv-settle": fail}})
        labels = r["labels"]
        self.assertEqual(labels[labels.index("verifier:3a-holdv-settle") + 1:][:2], ["resolver:3a-hold-settle-rehold", "verifier:3a-hold-settle-reholdv"])
        self.assertFalse(has(labels, "resolver:3a-hold-settle-convert"), "落ちた保持規則を、検証しない変換で書き直さない")
        self.assertEqual(r["result"]["status"], "done", r["result"].get("reason"))

    def test_書き直しを通らない経路があれば段の出口の不変条件が止める(self):
        patch = [("  const rh = await reholdFailed(stage, `${stage}-${tag}`, phaseTitle)\n  if (rh && rh.error) return rh\n  if (rh) {\n    fc = rh.fc\n    reconcile(fc)\n  }\n", "")]
        r = run({"args": self._g02()["next_args"], "verifier_fail": {"3a-holdv-left": self.FAIL}}, patch=patch)["result"]
        self.assertEqual((r["status"], r["next_args"]), ("blocked", None), r.get("reason"))
        self.assertIn("script の不変条件に反しました", r["reason"])
        self.assertIn("検証に落ちた保持規則 RS-002", r["reason"])


@unittest.skipIf(shutil.which("node") is None, "node が無い環境ではスキップする")
class ValuelessResolversKeepFlow(unittest.TestCase):
    """値を決めない resolver の呼び出し（変換・保持規則・問いの形の修正・輪を出た後）は flow.json を書かない。"""

    def _g02(self):
        """g1 の回答を当てた 3a が続きの問い RS-002 を出して g2 で止まる。返す next_args は聞ける回数を使い切った（at_limit）もので、
        その 3a は残った問いを保持規則に変える（holdLeft）。"""
        g1 = run({"args": args(), "flow_open": 1, "questions_at": {"3": ["RS-001"]}})["result"]
        g2 = run({"args": g1["next_args"], "ruled_at": {"3a": ["RS-001"]}, "questions_at": {"3a": ["RS-002"]}})["result"]
        assert (g2["status"], g2["gate"]) == ("needs_answers", "g2"), g2
        return {**g2, "next_args": at_limit(g2["next_args"])}

    def test_保持規則への変換がflowを変えなければ進む(self):
        r = run({"args": self._g02()["next_args"]})
        self.assertIn("resolver:3a-hold", r["labels"])
        [p] = [x["prompt"] for x in r["prompts"] if x["label"] == "resolver:3a-hold"]
        self.assertIn("flow.json を書かない", p)
        self.assertEqual(r["result"]["status"], "done")

    def test_保持規則への変換がflowを変えたらnext_argsを付けずにblocked(self):
        r = run({"args": self._g02()["next_args"], "flow_sha_at": {"3a-hold": "f-bad"}})["result"]
        self.assertEqual((r["status"], r["next_args"]), ("blocked", None))
        self.assertEqual(len(r["integrity"]), 1)

    def test_変換がflowを変えたらblocked(self):
        fail = {"id": "RS-001", "kind": "insufficient_grounds", "reason": "出典が無い"}
        spec = {"args": args(), "flow_open": 1, "ruled_at": {"3": ["RS-001"], "3-fix": ["RS-001"]}, "verifier_fail": {"3v": [fail], "3-fixv": [fail]},
                "questions_at": {"3-convert": ["RS-001"]}}
        self.assertEqual(run(spec)["result"]["status"], "needs_answers")
        r = run({**spec, "flow_sha_at": {"3-convert": "f-bad"}})["result"]
        self.assertEqual((r["status"], r["next_args"]), ("blocked", None))

    def test_問いの形の修正がflowを変えたらblocked(self):
        spec = {"args": args(), "flow_open": 1, "questions_at": {"3": ["RS-001"]}, "bad_questions_at": ["3"], "flow_sha_at": {"1-questions": "f-bad"}}
        r = run(spec)["result"]
        self.assertEqual((r["status"], r["next_args"]), ("blocked", None))

    def test_flowのstdoutを返さなければ同じ段から再実行できる(self):
        r = run({"args": self._g02()["next_args"], "no_flow_check_at": ["3a-hold"]})["result"]
        self.assertEqual((r["status"], r["next_args"]["from"]), ("blocked", "3a"))

    def test_変換の後のverifierが違うflowを見たらnext_argsを付けずにblocked(self):
        # 問いへの変換の後は flow-check を起動せず、直後の verifier の stdout を判断に使う（版の照合も verifier の stdout で行う）。
        fail = {"id": "RS-001", "kind": "insufficient_grounds", "reason": "出典が無い"}
        spec = {"args": args(), "flow_open": 1, "ruled_at": {"3": ["RS-001"], "3-fix": ["RS-001"]}, "verifier_fail": {"3v": [fail], "3-fixv": [fail]},
                "questions_at": {"3-convert": ["RS-001"]}}
        r = run({**spec, "verifier_flow_sha_at": {"3-convertv": "f-bad"}})["result"]
        self.assertEqual((r["status"], r["next_args"]), ("blocked", None))
        self.assertTrue(any("verifier（段 3-convertv）" in x for x in r["integrity"]), r["integrity"])
        silent = run({**spec, "null_labels": ["verifier:3-convertv"]})["result"]
        self.assertEqual((silent["status"], silent["next_args"]["from"]), ("blocked", "3"), "応答しない verifier は同じ段からやり直せる")

    def test_保持規則への変換は求めたIDだけをholdで返す(self):
        # 返らない問いは保持規則も無いまま文書に届き、ruled や求めていない ID は検証されないまま台帳に入る。
        for name, kw, want in (("返さない", {"holds_at": {"3a-hold": []}}, "RS-002 を resolver が hold に返しませんでした"),
                               ("問いで返す", {"holds_at": {"3a-hold": []}, "questions_at": {"3a-hold": ["RS-002"]}}, "RS-002 を resolver が hold に返しませんでした"),
                               ("求めていない ID", {"holds_at": {"3a-hold": ["RS-002", "RS-003"]}}, "変換を求めていない RS-003"),
                               ("ruled で足す", {"ruled_at": {"3a": ["RS-001"], "3a-hold": ["RS-004"]}}, "変換を求めていない RS-004")):
            with self.subTest(name):
                g02 = self._g02()
                r = run({"args": g02["next_args"], **kw})["result"]
                self.assertEqual((r["status"], r["next_args"]["from"]), ("blocked", "3a"), r.get("reason"))
                self.assertIn(want, r["reason"])
                self.assertNotIn("RS-002", r["next_args"]["state"].get("holds", []), "next_args は段に入った時点の state を渡す")
                self.assertNotIn("RS-002", r["hold_drafts"], "照合に落ちた返り値の hold を台帳の集合に入れない")


    def test_保持規則への変換の後の指摘はflow_checkのstdoutでsettleに渡る(self):
        # 保持規則への変換は台帳の kind を変えうる（不変条件の hold）。resolver の申告ではなく、その後の独立な stdout（flow-check と、
        # 書き換えた保持規則を検証する verifier）で settle に渡す。
        destructive = {"FLOW_DESTRUCTIVE_UNCONSTRAINED": ["F-053"]}
        for name, kw in (("申告どおり", {"flow_codes_at": {"3a-hold": destructive, "3a-holdv-left": destructive}}),
                         ("過少申告", {"flow_codes_at": {"3a-hold-seen": destructive, "3a-holdv-left": destructive}, "recheck_as": {"3a-hold": "3a-hold-seen"}})):
            with self.subTest(name):
                r = run({"args": self._g02()["next_args"], "unverified_at": {"3a-hold-settle": ["F-053"]}, **kw})
                labels = r["labels"]
                self.assertEqual(labels[labels.index("resolver:3a-hold") + 1:][:3], ["flow-check:3a-hold", "verifier:3a-holdv-left", "planner:3a-hold-settle"])
                [p] = [x["prompt"] for x in r["prompts"] if x["label"] == "planner:3a-hold-settle"]
                self.assertIn("F-053: 縛る不変条件が無い", p)
                self.assertEqual(r["result"]["status"], "done", r["result"].get("reason"))
                self.assertEqual(len(r["result"]["integrity"]), 0 if name == "申告どおり" else 1, r["result"]["integrity"])

    def _final(self, **kw):
        return run({"args": args(), "findings": new_item_each_round(MAX_AUDIT_PASSES + 1), **kw})["result"]

    def test_輪を出た後の変換がflowを変えたらその理由でblocked(self):
        ok = self._final()
        self.assertEqual((ok["status"], ok["integrity"]), ("blocked", []))
        rulings = self._final(resolver_rulings_at=["final"])
        self.assertEqual((rulings["status"], rulings["integrity"]), ("blocked", []), "--rulings を付けた resolver の stdout の resolutions は申告の食い違いにしない")
        r = self._final(flow_sha_at={"final": "f-bad"})
        self.assertEqual((r["status"], r["next_args"], len(r["integrity"])), ("blocked", None, 1))
        self.assertIn("flow.json が変わっています", r["reason"])
        self.assertEqual(r["report_path"], "/tmp/prd-w/report.md")

    def test_輪を出た後の変換の後のflowの残りはflow_checkのstdoutから理由に載る(self):
        # 輪を出た後は settle も writer も起動しないので、保持規則への変換で出た指摘と覆された決定を引く要素は理由で依頼者に渡す。
        left = {"flow_codes_at": {"final-seen": {"FLOW_DESTRUCTIVE_UNCONSTRAINED": ["F-053"]}}, "stale_refs_at": {"final-seen": [{"el": "F-002", "ref": "D-001"}]},
                "recheck_as": {"final": "final-seen"}}
        r = self._final(**left)
        self.assertEqual((r["status"], r["next_args"]), ("blocked", None))
        self.assertIn("flow の指摘: F-053（FLOW_DESTRUCTIVE_UNCONSTRAINED） / 覆された決定を引く要素: F-002（D-001）", r["reason"])
        self.assertEqual(len(r["integrity"]), 1, "resolver:final の申告は 0 件だった")
        clean = self._final()
        self.assertNotIn("flow に残ったもの", clean["reason"])
        for stop in ("null_labels", "throw_labels"):
            silent = self._final(**{stop: ["flow-check:final"]})
            self.assertEqual((silent["status"], silent["next_args"]["from"]), ("blocked", "8"), stop)

    def test_輪を出た後の変換がflowのstdoutを返さなければ段8からやり直す(self):
        r = self._final(no_flow_check_at=["final"])
        self.assertEqual((r["status"], r["next_args"]["from"]), ("blocked", "8"))

    def test_輪を出た後の変換が応答しなくてもflow_checkが台帳の後のflowを数えて理由に載せる(self):
        # 書いてから応答しなかった resolver の台帳の変更は、応答が無くても flow-check が数え直す。応答が無いのは申告の食い違いではない。
        # 例外で終わった resolver も、返り値の無い resolver と同じ扱いにする（段からやり直しても同じ所で止まる）。
        for stop, said in (("null_labels", "resolver:final が応答しなかった"), ("throw_labels", "resolver:final が例外で終わりました")):
            with self.subTest(stop):
                r = run({"args": args(), "findings": new_item_each_round(MAX_AUDIT_PASSES + 1), stop: ["resolver:final"],
                         "flow_codes_at": {"final-seen": {"FLOW_DESTRUCTIVE_UNCONSTRAINED": ["F-053"]}}, "recheck_as": {"final": "final-seen"}})
                self.assertIn("flow-check:final", r["labels"])
                res = r["result"]
                self.assertEqual((res["status"], res["next_args"], res["integrity"]), ("blocked", None, []))
                self.assertIn("flow の指摘: F-053（FLOW_DESTRUCTIVE_UNCONSTRAINED）", res["reason"])
                self.assertIn(said, res["reason"], "文案が無いことを 0 件の文案にしない")

    def test_保持規則への変換の後のsettleで問いを返せば段の頭からやり直す(self):
        # 保持規則への変換は段の最後に 1 回だけなので、その後の settle で生まれた問いは聞かれも hold にもされないまま done に届く。
        destructive = {"FLOW_DESTRUCTIVE_UNCONSTRAINED": ["F-053"]}
        spec = {"args": self._g02()["next_args"], "flow_codes_at": {"3a-hold": destructive, "3a-holdv-left": destructive}, "open_ids_at": {"3a-hold-settle": ["O-050"]},
                "about": {"RS-050": {"open": "O-050"}}}
        r = run({**spec, "questions_at": {"3a-hold-settle-opens": ["RS-050"]}})
        self.assertNotIn("verifier:3a-holdv-settle", r["labels"])
        res = r["result"]
        self.assertEqual((res["status"], res["next_args"]["from"]), ("blocked", "3a"), res.get("reason"))
        self.assertIn("RS-050 を resolver が ruled・hold 以外で返しました", res["reason"])
        held = run({**spec, "holds_at": {"3a-hold-settle-opens": ["RS-050"]}})["result"]
        self.assertEqual(held["status"], "done", held.get("reason"))
        self.assertIn("RS-050", held["holds"])


@unittest.skipIf(shutil.which("node") is None, "node が無い環境ではスキップする")
class StageExitInvariants(unittest.TestCase):
    """段の出口の不変条件は script の欠陥を止める。欠陥を作って届かせ、next_args を付けずに blocked で返ることを確かめる。"""

    # 段 6 の resolver が検証する ID を返さない（verifier が起動しない）経路。段を出る前の独立な数え直しは settle の independentFlow（flow-check:6）だけ。
    NO_VERIFIER = {"args": args(), "findings": {"wholeReviewer:r1": [{"id": "r1-wh-all-001", "route": "decision"}]}}
    SKIP_RECOUNT = ("  if (!unchecked) return { fc: verified }\n", "  if (true) return { fc: verified }\n")

    def test_flow_checkを通らない経路があれば段を出ずに止める(self):
        self.assertIn("flow-check:6", run(self.NO_VERIFIER)["labels"])
        r = run(self.NO_VERIFIER, patch=[self.SKIP_RECOUNT])
        self.assertIsNone(r["error"])
        self.assertNotIn("flow-check:6", r["labels"])
        res = r["result"]
        self.assertEqual((res["status"], res["next_args"]), ("blocked", None))
        self.assertIn("resolver:6 の後に doc_check flow を独立に実行し直さないまま段を出ようとしました", res["reason"])

    def test_flowを数え直さないflow_checkの応答はresolverの後の印を消さない(self):
        # flow を数え直さない flow-check（単独の answers）の応答が印を消すと、resolver の後の doc_check flow を誰も実行し直さないまま段を出られる。
        answers = ("  if (!unchecked) return { fc: verified }\n",
                   "  if (unchecked) await once('flow-check:6-answers', 'flowCheck', `実行する: \\`${cli('answers', '--file answers/g1.md --ids RS-001')}\\`。stdout を加工せずに answers_check に入れて返す。`, ANSWERS_SCHEMA, phaseTitle)\n"
                   "  if (!unchecked) return { fc: verified }\n")
        plain = run(self.NO_VERIFIER)
        r = run(self.NO_VERIFIER, patch=[answers])
        labels = r["labels"]
        self.assertIn("flow-check:6-answers", labels)
        self.assertEqual(labels[labels.index("flow-check:6-answers") + 1], "flow-check:6", "印が残るので数え直しを飛ばさない")
        self.assertEqual((r["result"]["status"], r["result"]["reason"]), (plain["result"]["status"], plain["result"]["reason"]))
        # 変異: flow_check の無い flow-check の応答でも印を消すと、数え直しが飛ぶ。
        mutated = run(self.NO_VERIFIER, patch=[answers, ("(role === 'flowCheck' && r.flow_check !== undefined)", "role === 'flowCheck'")])
        self.assertNotIn("flow-check:6", mutated["labels"])

    def test_回答待ちの問いを持ったまま聞くゲートの無い段へ出れば止める(self):
        spec = {"args": args(), "flow_open": 1, "questions_at": {"3": ["RS-001"]}}
        # 段 3 の出口の行は設計 3.5 の形（blocked(res.error, res.rerunFrom || (res.rerun === false ? null : '3'))）。
        onward = "'3'))\n  const onward = ENTRY === 'existing' ? '5' : '4'\n"
        r = run(spec, patch=[(onward + "  if (pendingQuestions(state).length) return needsAnswers('3a', onward)\n", onward)])
        self.assertFalse(has(r["labels"], "writer"))
        res = r["result"]
        self.assertEqual((res["status"], res["next_args"]), ("blocked", None))
        self.assertIn("回答待ちの問い RS-001 を", res["reason"])
        g0 = run(spec)["result"]
        self.assertEqual(g0["status"], "needs_answers", "聞くゲートへは問いを持って出る")
        carried = run({"args": g0["next_args"], "questions_at": {"3a": ["RS-002"]}, "ruled_at": {"3a": ["RS-001"]}})["result"]
        self.assertEqual((carried["status"], carried["question_ids"]), ("needs_answers", ["RS-002"]), "g1 の後の 3a は 3b へ問いを持ち越す")

    def test_検証に落ちたまま問いにも保持規則にもならない裁定を持って段を出れば止める(self):
        # settle の verifier が落とした RS-060 を、settle も verifyLeft も変換しないまま段を出る欠陥を作る。
        fail = [{"id": "RS-060", "kind": "insufficient_grounds", "reason": "r"}]
        D = {"FLOW_DESTRUCTIVE_UNCONSTRAINED": ["F-053"]}
        spec = {"args": args(), "findings": {"wholeReviewer:r1": [{"id": "r1-wh-all-001", "route": "decision"}]}, "about": {"RS-060": {"open": "O-060"}, "RS-010": {"finding": "r1-wh-all-001"}},
                "ruled_at": {"6": ["RS-010"], "6-settle-opens": ["RS-060"]}, "flow_codes_at": {"6": D, "6v": D}, "open_ids_at": {"6-settle": ["O-060"]},
                "unverified_at": {"6-settle": ["F-053"]}, "verifier_fail": {"6v-settle": fail}}
        self.assertEqual(run(spec)["result"]["status"], "done")
        broken = [("  const toFix = [...unconverted(fc).map(", "  const toFix = [...[].map("),
                  ("  if (toFix.length) {\n    const fe = await fixFailed(tag, tag,", "  if (false) {\n    const fe = await fixFailed(tag, tag,")]
        res = run(spec, patch=broken)["result"]
        self.assertEqual((res["status"], res["next_args"]), ("blocked", None), res.get("reason"))
        self.assertIn("問いにも保持規則にもならない不合格の resolution: RS-060", res["reason"])

    def test_不合格の回答済みの問いを持って段を出れば止める(self):
        # g1 で候補の選択で答えた RS-001 を、3b の verifier が検証を求められずに不合格にする（B1）。求めていない合否は数えずに
        # 検証させ直し、その検証も落とせば、回答済みの問いは回答待ちにも変換にも根拠にも数えられないので段を出さない。
        g0 = run({"args": args(), "flow_open": 1, "questions_at": {"3": ["RS-001", "RS-002"]}})["result"]
        fail = [{"id": "RS-001", "kind": "insufficient_grounds", "reason": "x"}]
        spec = {"ruled_at": {"3a": ["RS-001", "RS-002"]}, "verifier_fail": {"3bv": fail}, "args": g0["next_args"]}
        r = run(spec)
        rechecked = nth_prompt(r, "verifier:3bv-left", 0).split("検証する resolution の ID:")[1].split("\n")[0]
        self.assertIn("RS-001", rechecked, "求めていない不合格は数えずに検証させ直す")
        self.assertEqual(r["result"]["status"], "done", r["result"].get("reason"))
        self.assertIn("RS-001", next(l for l in nth_prompt(r, "writer:U-1:draft", 0).split("\n") if l.startswith("- 根拠にしてよい resolution")))
        again = run({**spec, "verifier_fail": {"3bv": fail, "3bv-left": fail}})["result"]
        self.assertEqual((again["status"], again["next_args"]), ("blocked", None), again.get("reason"))
        self.assertIn("不合格の回答済みの問い: RS-001", again["reason"])

    def test_検証を通っていないものを持ったまま段を出れば止める(self):
        # settle の verifier が F-053 を検証しないまま（W の unverified に残して）段を出る欠陥を作る。
        spec = {"args": args(), "flow_open": 1, "ruled_at": {"3": ["RS-001"]}, "open_only_at": {"3v": [{"el": "F-053", "open": "O-RS-001"}]},
                "unverified_at": {"3-settle": ["F-053"]}, "ignores_at": {"3v-settle": ["F-053"]}}
        broken = [("  if (unjudged(fc).elements.length || carry.length) {\n", "  if (false) {\n")]
        r = run(spec, patch=broken)
        res = r["result"]
        self.assertEqual((res["status"], res["next_args"]), ("blocked", None), res.get("reason"))
        self.assertIn("script の不変条件に反しました（段 3）: 検証を通っていないものを持ったまま段を出ようとしました（検証を通っていない要素: F-053", res["reason"])
        self.assertEqual(r["disk"]["unverified"], ["F-053"])
        # settle が W の不合格の要素を拾わない欠陥: 合格した検証の裁定を写さないまま、不合格の要素を持って段を出る。
        fail = [{"id": "F-003", "kind": "insufficient_grounds", "reason": "出典が無い"}]
        ruled = {"args": args(), "verifier_fail": {"3v": fail}, "ruled_at": {"3-fix": ["RS-005"]}, "about": {"RS-005": {"verification": "F-003"}}, "unverified_at": {"3-settle": ["F-003"]}}
        res = run(ruled, patch=[("  const failed = failedOpen(fc, state, true)\n  return {", "  const failed = []\n  return {")])["result"]
        self.assertEqual((res["status"], res["next_args"]), ("blocked", None), res.get("reason"))
        self.assertIn("保持規則にも回答待ちにもならない不合格の要素: F-003", res["reason"])


@unittest.skipIf(shutil.which("node") is None, "node が無い環境ではスキップする")
class ReflectIn3b(unittest.TestCase):
    """g1 の後の 3a は settle の裁定の反映（planner:3a-settle → resolver:3a-settle-* → verifier:3av-settle）を回さず、反映を
    3b-reframe に渡し、未裁定の組と O- は resolver:3b に、flow の検証は 3bv に 1 回にまとめる（prd-spec.js の REFLECT_STAGE）。
    3av は回答の適用（resolver:3a の裁定と書き込み）を検証し、g2・段 6 のゲートの後の 3a・3a' は後に 3b が無いので自分の settle を回す。"""

    FAIL = [{"id": "F-003", "kind": "insufficient_grounds", "reason": "出典が無い"}]
    SETTLE = ("planner:3a-settle", "resolver:3a-settle", "verifier:3av-settle")

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.world = str(Path(self._tmp.name) / "world.json")

    def tearDown(self):
        self._tmp.cleanup()

    def _spec(self, nargs, **kw):
        # 3a が RS-001 に回答を当てて O-RS-001 を閉じ（F-091 がそれだけを出典に持つ）、書き換えた F-003 が 3av と 3a-fixv に落ち、
        # 差し戻しがその検証の裁定 RS-005 を返して 3a-fixv に合格する。3a の settle なら写す反映は F-091 と F-003 の 2 つ。
        spec = {"args": nargs, "world": self.world, "ruled_at": {"3a": ["RS-001"], "3a-fix": ["RS-005"]}, "about": {"RS-005": {"verification": "F-003"}},
                "flow_sha_at": {"3a": "f-3a", "3a-fix": "f-3a2"}, "unverified_at": {"3a": ["F-003"], "3a-fix": ["F-003"], "3b-reframe": ["F-003", "F-091"]},
                "verifier_fail": {"3av": self.FAIL, "3a-fixv": self.FAIL}, "open_only_at": {"3a-fixv": [{"el": "F-091", "open": "O-RS-001"}]}}
        spec.update(kw)
        return spec

    def _g0(self):
        return run({"args": args(), "world": self.world, "flow_open": 1, "questions_at": {"3": ["RS-001"]}})["result"]

    def test_g1の後の3aはsettleを起動せず反映を3b_reframeに渡し3bvが1回で検証する(self):
        r = run(self._spec(self._g0()["next_args"]))
        labels = r["labels"]
        self.assertFalse([l for l in labels if l.startswith(self.SETTLE)], labels)
        self.assertEqual([l for l in labels if l.startswith(("resolver:", "verifier:", "planner:"))],
                         ["resolver:3a", "verifier:3av", "resolver:3a-fix", "verifier:3a-fixv", "planner:3b", "verifier:3bv"])
        reframe = nth_prompt(r, "planner:3b", 0)
        self.assertIn("3a の裁定も flow に写す", reframe)
        self.assertIn("F-091（O-RS-001 ← RS-001）", reframe, "閉じた O- を引く要素の書き換え")
        self.assertIn("F-003 ← RS-005", reframe, "流れに写す検証の裁定")
        judged_by(self, r, "verifier:3bv", "F-091")
        judged_by(self, r, "verifier:3bv", "F-003")
        self.assertEqual((r["disk"]["unverified"], r["disk"]["failed_current"]), ([], []))
        self.assertEqual(r["result"]["status"], "done", r["result"].get("reason"))

    def test_g2の後の3aは今どおり自分のsettleで反映し検証する(self):
        g02 = reasked_at_limit(self.world)
        r = run(self._spec(g02["next_args"], unverified_at={"3a": ["F-003"], "3a-fix": ["F-003"], "3a-settle": ["F-003", "F-091"]}))
        self.assertEqual([l for l in r["labels"] if l.startswith(("planner:", "verifier:3a"))],
                         ["verifier:3av", "verifier:3a-fixv", "planner:3a-settle", "verifier:3av-settle"])
        self.assertFalse(has(r["labels"], "planner:3b"), "g2 の後に 3b は無い")
        self.assertIn("F-003 ← RS-005", nth_prompt(r, "planner:3a-settle", 0))
        self.assertEqual(r["result"]["status"], "done", r["result"].get("reason"))

    def test_3b_reframeが写さなかった持ち越しの不合格の要素は3bのsettleが直して検証する(self):
        # 書き換えていない F-003 は変わっていないので 3bv では名指ししない（名指しすると 3bv の不合格が resolver:3b-fix に回り、合格済みの
        # 検証の裁定 RS-005 を裁定し直させる）。W に不合格のまま残るので、3b の settle が 3a の settle と同じ経路で写させて検証する。
        r = run(self._spec(self._g0()["next_args"], unverified_at={"3a": ["F-003"], "3a-fix": ["F-003"], "3b-reframe": ["F-091"], "3b-settle": ["F-003"]}))
        self.assertNotIn("F-003", nth_prompt(r, "verifier:3bv", 0))
        self.assertFalse(has(r["labels"], "resolver:3b-fix"))
        self.assertIn("F-003 ← RS-005", nth_prompt(r, "planner:3b-settle", 0))
        judged_by(self, r, "verifier:3bv-settle", "F-003")
        self.assertEqual(r["result"]["status"], "done", r["result"].get("reason"))
        self.assertEqual(r["writerDisk"]["failed_current"], [])

    def _g0_spec(self, **kw):
        return {"args": self._g0()["next_args"], "world": self.world, "ruled_at": {"3a": ["RS-001"]}, "flow_sha_at": {"3a": "f-3a"}, **kw}

    def test_閉じたOと覆された決定は3b_reframeに渡り開いたままのOは渡らない(self):
        only = [{"el": "F-091", "open": "O-RS-001"}, {"el": "F-092", "open": "O-RS-009"}]
        stale = [{"el": "F-002", "ref": "D-001"}]
        r = run(self._g0_spec(open_only_at={"3av": only}, stale_refs_at={"3av": stale}, unverified_at={"3b-reframe": ["F-091", "F-002"]}))
        reframe = nth_prompt(r, "planner:3b", 0)
        self.assertIn("F-091（O-RS-001 ← RS-001）", reframe)
        self.assertNotIn("F-092", reframe, "開いたままの O- の要素は直させない")
        self.assertIn("F-002 ← D-001", reframe, "覆された決定を引く要素")
        judged_by(self, r, "verifier:3bv", "F-091")
        judged_by(self, r, "verifier:3bv", "F-002")
        self.assertEqual(r["result"]["status"], "done", r["result"].get("reason"))

    def test_検証の裁定が保持規則の不合格の要素は3b_reframeに渡さない(self):
        fail = [{"id": "F-002", "kind": "insufficient_grounds", "reason": "出典が無い"}]
        g0 = run({"args": args(), "world": self.world, "flow_open": 1, "questions_at": {"3": ["RS-001"]}, "verifier_fail": {"3v": fail, "3-fixv": fail},
                  "holds_at": {"3-fix": ["RS-006"]}, "about": {"RS-006": {"verification": "F-002"}}})["result"]
        self.assertEqual(g0["status"], "needs_answers", g0.get("reason"))
        r = run({"args": g0["next_args"], "world": self.world, "about": {"RS-006": {"verification": "F-002"}}, "ruled_at": {"3a": ["RS-001"]}})
        reframe = nth_prompt(r, "planner:3b", 0)
        self.assertNotIn("検証に落ちた要素: F-002", reframe)
        self.assertNotIn("F-002 ←", reframe)
        self.assertEqual(r["result"]["status"], "done", r["result"].get("reason"))

    def test_3b_reframeの過少申告は3bvが止める(self):
        # 3b-reframe が 0 件と返した flow に、flow-framer だけが消せる指摘が 3bv の stdout にある。resolver:3b が台帳を書いていなければ
        # flow-framer の過少申告で、3a の settle の verifier と同じく止める。台帳が動いていれば台帳由来として 3b の settle に渡す。
        D = {"FLOW_DESTRUCTIVE_UNCONSTRAINED": ["F-053"]}
        r = run(self._g0_spec(flow_codes_at={"3bv": D}))
        self.assertFalse(has(r["labels"], "resolver:3b"))
        res = r["result"]
        self.assertEqual((res["status"], res["next_args"]["from"]), ("blocked", "3b"), res.get("reason"))
        self.assertIn("段 3bv: verifier の doc_check flow に指摘が 1 件あります", res["reason"])
        self.assertTrue(any("flowFramer（段 3bv）" in x for x in res["integrity"]), res["integrity"])
        moved = run(self._g0_spec(flow_codes_at={"3bv": D}, pair_keys_at={"3b-reframe": ["pair:D-010|F-035"]}, about={"RS-003": {"pair": ["D-010", "F-035"]}},
                                  ruled_at={"3a": ["RS-001"], "3b": ["RS-003"]}, unverified_at={"3b-settle": ["F-053"]}))
        self.assertIn("F-053: 縛る不変条件が無い", nth_prompt(moved, "planner:3b-settle", 0))
        self.assertEqual((moved["result"]["status"], moved["result"]["integrity"]), ("done", []), moved["result"].get("reason"))

    def test_渡せない不合格の要素があれば3aは自分のsettleで直す(self):
        # 3av が検証し残した F-060 を拾う verifier が落とした。検証の裁定が無いので 3b には渡さず、3a の settle が直させる。
        fail = [{"id": "F-060", "kind": "insufficient_grounds", "reason": "出典が無い"}]
        r = run(self._g0_spec(unverified_at={"3a": ["F-060"], "3a-settle": ["F-060"]}, ignores_at={"3av": ["F-060"]}, verifier_fail={"3av-left": fail}))
        self.assertIn("検証に落ちた要素: F-060", nth_prompt(r, "planner:3a-settle", 0))
        judged_by(self, r, "verifier:3av-settle", "F-060")
        self.assertNotIn("F-060", nth_prompt(r, "planner:3b", 0).split("回答を入力に加えて")[1])
        self.assertEqual(r["result"]["status"], "done", r["result"].get("reason"))

    def test_3aの出口は渡せない不合格の要素を持って3bへ出れば止める(self):
        # 3a の settle への戻り（渡せない不合格があれば 3a で直す）を外し、裁定の無い F-060 を持ったまま 3b へ出る欠陥を作る。
        # 出口の緩めは渡せる要素（reflectable）だけなので、段の出口の不変条件が止める。
        fail = [{"id": "F-060", "kind": "insufficient_grounds", "reason": "出典が無い"}]
        no_fallback = ("  if (reflectLater && failedOpen(checked.fc, state, true).every(reflectable)) {\n", "  if (reflectLater) {\n")
        r = run(self._g0_spec(unverified_at={"3a": ["F-060"]}, ignores_at={"3av": ["F-060"]}, verifier_fail={"3av-left": fail}), patch=[no_fallback])
        self.assertFalse(has(r["labels"], "planner:3a-settle"))
        self.assertFalse(has(r["labels"], "planner:3b"))
        res = r["result"]
        self.assertEqual((res["status"], res["next_args"]), ("blocked", None), res.get("reason"))
        self.assertIn("script の不変条件に反しました（段 3a）", res["reason"])
        self.assertIn("保持規則にも回答待ちにもならない不合格の要素: F-060", res["reason"])

    def test_3b以外の段の入口は検証の裁定を持つ不合格の要素でも止める(self):
        # 入口で不合格の要素を受け入れるのは REFLECT_STAGE だけ。検証の裁定（RS-070）を持つ F-070 でも、段 7 の入口では所有表の外の書き込みとして止める。
        stopped = run({"args": args(), "world": self.world, "findings": {"writerReviewer:r1": [{"id": "r1-wr-all-001"}]}, "null_labels": ["writer:U-1:revise"]})["result"]
        self.assertEqual(stopped["next_args"]["from"], "7", stopped.get("reason"))
        d = json.loads(Path(self.world).read_text())
        d["els"]["F-070"] = 1
        d["rs"]["RS-070"] = {"about": {"verification": "F-070"}, "ruling": "internal"}
        Path(self.world).write_text(json.dumps(d))
        fail = [{"id": "F-070", "kind": "insufficient_grounds", "reason": "出典が無い"}]
        r = run({"args": stopped["next_args"], "world": self.world, "fails_when_asked": fail})
        self.assertIn("RS-070", [x["id"] for x in r["disk"]["resolutions"]], "検証の裁定は台帳にある")
        self.assertFalse(has(r["labels"], "writer:"))
        res = r["result"]
        self.assertEqual((res["status"], res["next_args"]), ("blocked", None), res.get("reason"))
        self.assertIn("段 7 の入口の flow に不合格の要素 F-070 があります", res["reason"])

    def test_3bの入口は3aが渡せない不合格の要素を止める(self):
        stopped = run(self._spec(self._g0()["next_args"], null_labels=["verifier:3bv"]))["result"]
        self.assertEqual(stopped["next_args"]["from"], "3b", stopped.get("reason"))
        # 所有表の外の書き込み: 3b の入口の restore が戻す控えにも入れる（段に入る前に書かれた要素として残す）。
        d = json.loads(Path(self.world).read_text())
        d["els"]["F-070"] = 1
        for pre in d.get("tx", {}).values():
            if "flow" in pre:
                pre["flow"]["els"]["value"]["F-070"] = 1
        Path(self.world).write_text(json.dumps(d))
        fail = [{"id": "F-070", "kind": "insufficient_grounds", "reason": "出典が無い"}]
        r = run(self._spec(stopped["next_args"], ruled_at={}, flow_sha_at={}, verifier_fail={}, open_only_at={}, unverified_at={}, fails_when_asked=fail))
        self.assertFalse(has(r["labels"], "planner:3b"))
        res = r["result"]
        self.assertEqual((res["status"], res["next_args"]), ("blocked", None), res.get("reason"))
        self.assertIn("段 3b の入口の flow に不合格の要素 F-070 があります", res["reason"])

    def test_検証を通っていない要素も持ち越しの不合格の要素もwriterに届かない(self):
        r = run(self._spec(self._g0()["next_args"]))
        self.assertTrue(has(r["labels"], "writer:"))
        self.assertEqual((r["writerDisk"]["unverified"], r["writerDisk"]["failed_current"]), ([], []))
        # 変異: 3b を持たない 3a（g2 の後）も反映を渡すようにすると、段の出口の不変条件が次の段が REFLECT_STAGE でないことで止める。
        defer_always = ("    reflectLater: Boolean(nextStage),\n", "    reflectLater: true,\n")
        # 変異ごとに W を g2 の直後から作り直す（止まった run の W を次の run に持ち込まない）。
        def g02_spec():
            return self._spec(reasked_at_limit(self.world)["next_args"], unverified_at={"3a": ["F-003"], "3a-fix": ["F-003"]}, open_only_at={})
        stopped = run(g02_spec(), patch=[defer_always])
        self.assertFalse(has(stopped["labels"], "writer:"))
        res = stopped["result"]
        self.assertEqual((res["status"], res["next_args"]), ("blocked", None), res.get("reason"))
        self.assertIn("script の不変条件に反しました（段 3a）", res["reason"])
        self.assertIn("保持規則にも回答待ちにもならない不合格の要素: F-003", res["reason"])
        # 変異: 出口の不変条件を渡した段に限らず緩めると、落ちた F-003 が writer に届く（上の writerDisk の検査がそれを捉える）。
        leaky = run(g02_spec(), patch=[defer_always, ("  const open = failedOpen(fc, state, asking).filter((el) => !(reflectNext && reflectable(el)))\n", "  const open = []\n")])
        self.assertTrue(has(leaky["labels"], "writer:"))
        self.assertEqual(leaky["writerDisk"]["failed_current"], ["F-003"], "不変条件を緩めると不合格の要素が writer に届く")

    def test_3bで止まった再実行は入口で不合格の要素を止めずに3b_reframeへ反映を渡す(self):
        stopped = run(self._spec(self._g0()["next_args"], null_labels=["verifier:3bv"]))["result"]
        self.assertEqual((stopped["status"], stopped["next_args"]["from"]), ("blocked", "3b"), stopped.get("reason"))
        r = run(self._spec(stopped["next_args"], ruled_at={}, flow_sha_at={}, verifier_fail={}, open_only_at={}, unverified_at={"3b-reframe": ["F-003", "F-091"]}))
        self.assertEqual(r["labels"][0], "flow-check:3b-entry")
        self.assertIn("F-003 ← RS-005", nth_prompt(r, "planner:3b", 0), "入口で W から数え直した反映を渡す")
        judged_by(self, r, "verifier:3bv", "F-003")
        self.assertEqual(r["result"]["status"], "done", r["result"].get("reason"))
        self.assertEqual(r["writerDisk"]["failed_current"], [])


@unittest.skipIf(shutil.which("node") is None, "node が無い環境ではスキップする")
class FlowRecheck(unittest.TestCase):
    """flow を変えた呼び出しの後に、新しい組を resolver に、検証を通っていない要素を verifier に回す（A2）。
    裁定で閉じた O- だけを出典に持つ要素（前回の F-090・F-091）は、どの段でも planner:<段>-settle に直させる。"""

    def _g0(self):
        return run({"args": args(), "flow_open": 1, "questions_at": {"3": ["RS-001"]}})["result"]

    def _prompt(self, r, label):
        [p] = [x["prompt"] for x in r["prompts"] if x["label"] == label]
        return p

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.world = str(Path(self._tmp.name) / "world.json")

    def tearDown(self):
        self._tmp.cleanup()

    def _g0_failed(self, el):
        """段 3 で el が 3v と 3-fixv に落ち、差し戻しがその検証の裁定（RS-005）を hold にした g1。W は self.world に残る。"""
        fail = [{"id": el, "kind": "insufficient_grounds", "reason": "出典が無い"}]
        g0 = run({"args": args(), "world": self.world, "flow_open": 1, "questions_at": {"3": ["RS-001"]}, "verifier_fail": {"3v": fail, "3-fixv": fail},
                  "holds_at": {"3-fix": ["RS-005"]}, "about": {"RS-005": {"verification": el}}})["result"]
        self.assertEqual(g0["status"], "needs_answers", g0.get("reason"))
        self.assertEqual(on_disk(self.world)["failed_current"], [el])
        return g0

    def _g02_failed(self, el):
        """_g0_failed の後、3a が RS-001 を続きの問いにして g2 で聞き直す止まり方（その後の 3a は自分の settle を回す）。"""
        g0 = self._g0_failed(el)
        g02 = run({"args": g0["next_args"], "world": self.world, "questions_at": {"3a": ["RS-001"]}})["result"]
        self.assertEqual((g02["status"], g02["question_ids"]), ("needs_answers", ["RS-001"]), g02.get("reason"))
        return g0, g02

    def test_3aでflowが変わると新しい組はresolverに_unverifiedはverifierに渡る(self):
        spec = {"args": self._g0()["next_args"], "ruled_at": {"3a": ["RS-001"], "3a-pairs": ["RS-002"]}, "flow_sha_at": {"3a": "f-3a"},
                "pair_keys_at": {"3a": ["pair:D-001|F-099"]}, "unverified_at": {"3a": ["F-099"]}}
        r = run(spec)
        self.assertEqual([l for l in r["labels"] if l.startswith(("resolver:", "verifier:"))], ["resolver:3a", "resolver:3a-pairs", "verifier:3av", "verifier:3bv"])
        self.assertIn("pair:D-001|F-099", self._prompt(r, "resolver:3a-pairs"))
        v = self._prompt(r, "verifier:3av")
        self.assertIn(VERIFY_ALL_MARK, v)
        self.assertNotIn("F-099", r["disk"]["unverified"])
        self.assertIn("RS-002", v.split("検証する resolution の ID:")[1].split("\n")[0])
        self.assertEqual(r["result"]["status"], "done")
        self.assertIn("pair:D-001|F-099", r["result"]["missed"], "about に組が現れなければ裁定漏れに数える")

    def test_組の要素に合格した検証の裁定があればpairsのプロンプトがそれを指す(self):
        # 再々試走の E5b: resolver:3a-settle-pairs が、根拠一式の一覧にあった同じ要素の検証の裁定（RS-017）を読まずに、それと食い違う組の裁定を書いた。
        g0 = run({"args": args(), "flow_open": 1, "ruled_at": {"3": ["RS-017"]}, "questions_at": {"3": ["RS-001"]}, "about": {"RS-017": {"verification": "F-099"}}})["result"]
        self.assertEqual(g0["status"], "needs_answers", g0.get("reason"))
        spec = {"args": g0["next_args"], "ruled_at": {"3a": ["RS-001"], "3a-pairs": ["RS-002"]}, "flow_sha_at": {"3a": "f-3a"},
                "pair_keys_at": {"3a": ["pair:D-001|F-099"]}, "unverified_at": {"3a": ["F-099"]}}
        line = "- pair:D-001|F-099: RS-017（verification:F-099）"
        p = self._prompt(run(spec), "resolver:3a-pairs")
        self.assertIn(line, p)
        self.assertIn("get --workspace /tmp/prd-w --ledger resolutions --ids RS-017 --fields id,ruling,value", p)
        # 変異: 組の裁定の呼び出しに指された根拠を渡さないと、行が消える。
        mutated = run(spec, patch=[("    pointedLines(issueItems([...opens, ...pairs])),\n    askNote(allowQuestions),", "    askNote(allowQuestions),")])
        self.assertNotIn(line, self._prompt(mutated, "resolver:3a-pairs"))

    def test_候補のlabelだけでない回答は回答を当てるresolverに逐語で渡る(self):
        # 再々試走の E4: 「ある（自由欄に書く）」の後の自由欄がパスの先にしか無く、「無い」に当てた。
        g0 = self._g0()
        free = [{"id": "RS-001", "from": 1, "to": 2, "text": "ある（自由欄に書く）\n最初に書いた削除タグは不要"}]
        spec = {"args": g0["next_args"], "ruled_at": {"3a": ["RS-001"]}, "answers_free": {"answers/g1.md": free}}
        line = "- RS-001（L1〜L2）: 「ある（自由欄に書く）」「最初に書いた削除タグは不要」"
        self.assertIn(line, self._prompt(run(spec), "resolver:3a"))
        # 変異: 段の task に写さないと、resolver はパスしか受け取らない。
        mutated = run(spec, patch=[("      answerExcerpt(gate, pending),\n", "")])
        self.assertNotIn(line, self._prompt(mutated, "resolver:3a"))
        # label だけの回答は写さない（候補の decision_text で決まる）。
        self.assertNotIn("候補の label だけでない回答", self._prompt(run({**spec, "answers_free": {}}), "resolver:3a"))

    def test_対応づけで落ちた回答の差し戻しにも逐語が渡る(self):
        # mapping の差し戻しは回答の対応づけを直す呼び出しで、逐語が無いと同じ読み違いを言い直す。
        free = [{"id": "RS-001", "from": 1, "to": 2, "text": "ある（自由欄に書く）\n最初に書いた削除タグは不要"}]
        spec = {"args": self._g0()["next_args"], "free_text_at": {"3a": ["RS-001"]}, "answers_free": {"answers/g1.md": free},
                "verifier_fail": {"3av": [{"id": "RS-001", "kind": "mapping", "reason": "自由欄を読んでいない"}]}}
        line = "- RS-001（L1〜L2）: 「ある（自由欄に書く）」「最初に書いた削除タグは不要」"
        self.assertIn(line, self._prompt(run(spec), "resolver:3a-fix"))
        # 変異: 差し戻しのプロンプトに写さないと、パスしか届かない。
        mutated = run(spec, patch=[("opt.answered ? answerExcerpt(state.gate, v1.fail.map((f) => f.id)) : '', ", "")])
        self.assertNotIn(line, self._prompt(mutated, "resolver:3a-fix"))

    def test_段6の指摘は項目のtraceが指す要素の検証の裁定を指される(self):
        # decision の指摘だけの項目でも、項目の trace が指す要素（doc の flow_refs）から、その要素の検証の裁定を指す。
        spec = {"args": args(), "flow_open": 1, "ruled_at": {"3": ["RS-001", "RS-017"], "6": ["RS-010"]}, "about": {"RS-017": {"verification": "F-011"}},
                "doc_flow_refs": {"requirements/x": {"PR-X-001": ["F-011"]}},
                "findings": {"wholeReviewer:r1": [{"id": "r1-wh-all-001", "doc": "requirements/x", "item_id": "PR-X-001", "route": "decision"}]}}
        line = "- finding:r1-wh-all-001: RS-017（verification:F-011）"
        self.assertIn(line, self._prompt(run(spec), "resolver:6"))
        # 変異: 段 6 に指された根拠を渡さないと行が消える。
        mutated = run(spec, patch=[("      pointedLines([...findingItems(decision, state), ...issueItems(tbd.map((id) => `tbd:${id}`))]),\n", "")])
        self.assertNotIn(line, self._prompt(mutated, "resolver:6"))
        # 変異: decision の指摘の項目の flow refs を持たないと、要素から引けない。
        bundles_only = ("  for (const f of all) {\n    const ids = uniq((refs[f.doc] || {})[f.item_id])",
                        "  for (const f of all.filter((x) => x.route !== 'decision')) {\n    const ids = uniq((refs[f.doc] || {})[f.item_id])")
        self.assertNotIn(line, self._prompt(run(spec, patch=[bundles_only]), "resolver:6"))

    def test_未裁定の論点は生成者の申告でなくverifierが数えた組とOで確かめる(self):
        # 組と O- は flow.json・decisions.json・open.json で決まる。同じ flow.json を見た verifier の stdout と違えば、申告から漏れた論点が
        # 裁定されないまま進むので、段の頭からやり直す。
        g0 = self._g0()["next_args"]
        base = {"args": g0, "ruled_at": {"3a": ["RS-001"], "3a-pairs": ["RS-002"]}, "flow_sha_at": {"3a": "f-3a"}, "pair_keys_at": {"3a": ["pair:D-001|F-099"]},
                "about": {"RS-002": {"pair": ["D-001", "F-099"]}}}
        self.assertEqual(run(base)["result"]["integrity"], [])
        # settle の flow-framer は g2 の後の 3a で起動する（g1 の後の 3a は反映を 3b-reframe に渡す。その申告は下の reframe で照合する）。
        for name, kw, key in (("回答を当てた resolver の組", {"verifier_pair_keys_at": {"3av": ["pair:D-001|F-099", "pair:D-002|F-098"]}}, "pair_keys"),
                              ("settle の flow-framer の O-", {"args": reasked_at_limit()["next_args"], "flow_codes_at": {"3av": {"FLOW_DESTRUCTIVE_UNCONSTRAINED": ["F-053"]}},
                                                              "open_ids_at": {"3a-settle": ["O-009"], "3av-settle": ["O-009", "O-010"]},
                                                              "ruled_at": {**base["ruled_at"], "3a-settle-opens": ["RS-009"]}}, "open_ids")):
            with self.subTest(name):
                res = run({**base, **kw})["result"]
                self.assertEqual((res["status"], res["next_args"]["from"]), ("blocked", "3a"), res.get("reason"))
                self.assertIn(f"裁定に回した未裁定の論点（{key}）", res["reason"])
                self.assertEqual(len(res["integrity"]), 1, res["integrity"])
        reframe = run({"args": g0, "ruled_at": {"3a": ["RS-001"], "3b": ["RS-003"]}, "pair_keys_at": {"3b-reframe": ["pair:D-010|F-035"]},
                       "about": {"RS-003": {"pair": ["D-010", "F-035"]}}, "verifier_pair_keys_at": {"3bv": []}})["result"]
        self.assertEqual((reframe["status"], reframe["next_args"]["from"]), ("blocked", "3b"), reframe.get("reason"))
        self.assertIn("planner:3b の申告", reframe["reason"])

    def test_flowが変わらなければ組を検査し直さない(self):
        r = run({"args": self._g0()["next_args"], "ruled_at": {"3a": ["RS-001"]}, "pair_keys_at": {"3a": ["pair:D-001|F-099"]}})
        self.assertNotIn("resolver:3a-pairs", r["labels"])
        self.assertNotIn("verifier:3av", r["labels"])
        self.assertEqual(r["result"]["status"], "done", r["result"].get("reason"))

    def test_同じ呼び出しで裁定中の組は渡し直さない(self):
        # RS-005 はまだ verifier を通っていない（closedKeys に無い）が、about には入っている。
        spec = {"args": self._g0()["next_args"], "ruled_at": {"3a": ["RS-001", "RS-005"]}, "flow_sha_at": {"3a": "f-3a"},
                "about": {"RS-005": {"pair": ["F-099", "D-001"]}}, "pair_keys_at": {"3a": ["pair:D-001|F-099"]}}
        self.assertNotIn("resolver:3a-pairs", run(spec)["labels"])

    def test_組でないaboutの値は組の裁定として数えない(self):
        spec = {"args": self._g0()["next_args"], "ruled_at": {"3a": ["RS-001"]}, "flow_sha_at": {"3a": "f-3a"}, "pair_keys_at": {"3a": ["open:O-RS-001"]}}
        self.assertIn("resolver:3a-pairs", run(spec)["labels"])

    def test_自由記述の回答で閉じたOも同じcycleでsettleする(self):
        only = [{"el": "F-091", "open": "O-RS-001"}]
        g0 = run({"args": self._g0()["next_args"], "free_text_at": {"3a": ["RS-001"]}, "open_only_at": {"3av": only}, "unverified_at": {"3b-reframe": ["F-091"]}})
        self.assertFalse(has(g0["labels"], "planner:3a-settle"), "g1 の後の 3a は反映を 3b-reframe に渡す")
        self.assertIn("F-091（O-RS-001 ← RS-001）", self._prompt(g0, "planner:3b"))
        judged_by(self, g0, "verifier:3bv", "F-091")
        self.assertEqual(g0["result"]["status"], "done")
        g02 = run({"args": reasked_at_limit()["next_args"], "free_text_at": {"3a": ["RS-001"]}, "open_only_at": {"3av": only}})
        self.assertIn("planner:3a-settle", g02["labels"])
        self.assertEqual(g02["result"]["status"], "done")

    def test_flowを変えたのにconflictsのstdoutが無ければblocked(self):
        r = run({"args": self._g0()["next_args"], "ruled_at": {"3a": ["RS-001"]}, "flow_sha_at": {"3a": "f-3a"}, "no_conflicts_check_at": ["3a"]})
        self.assertNotIn("verifier:3av", r["labels"])
        self.assertEqual((r["result"]["status"], r["result"]["next_args"]["from"]), ("blocked", "3a"))

    def test_同じcycleで閉じたOだけを出典に持つ要素はsettleで直す(self):
        g0 = reasked_at_limit()
        only = [{"el": "F-091", "open": "O-RS-001"}, {"el": "F-092", "open": "O-RS-009"}]
        spec = {"args": g0["next_args"], "ruled_at": {"3a": ["RS-001"]}, "open_only_at": {"3a": only}, "unverified_at": {"3a-settle": ["F-091"]}}
        r = run(spec)
        self.assertEqual([l for l in r["labels"] if l.startswith(("resolver:", "verifier:", "planner"))],
                         ["resolver:3a", "planner:3a-settle", "verifier:3av-settle"])
        framer = self._prompt(r, "planner:3a-settle")
        self.assertIn("F-091（O-RS-001 ← RS-001）", framer)
        self.assertNotIn("F-092", framer, "開いたままの O- の要素は直させない")
        v = self._prompt(r, "verifier:3av-settle")
        judged_by(self, r, "verifier:3av-settle", "F-091")
        self.assertEqual(v.split("検証する resolution の ID:")[1].split("\n")[0].strip(), "（なし）")
        self.assertEqual(r["result"]["status"], "done")
        self.assertEqual(r["result"]["next_args"], None)

        # 2 回目の settle でも同じ件数が残る（減らない）ので止まる。unput は減らないのではなく、verifier の合否が put されていないので 1 回目の verifier で止まる。
        fail = [{"id": "F-091", "kind": "mapping", "reason": "r"}]
        same = ("裁定の反映の後も直っていません", "verifier:3av-settle-2")
        for left, (why, last) in (({"open_only_at": {"3a": only, "3av-settle": only[:1], "3av-settle-2": only[:1]}}, same),
                                  ({"unput_at": {"3av-settle": ["F-091"]}, "open_only_at": {"3a": only}}, ("F-091 が verifications.json に記録されていません", "verifier:3av-settle")),
                                  ({"verifier_fail": {"3av-settle": fail, "3av-settle-2": fail}, "open_only_at": {"3a": only}}, same)):
            with self.subTest(left=left):
                r = run({**spec, **left})
                stopped = r["result"]
                self.assertIn(why, stopped["reason"])
                self.assertEqual([l for l in r["labels"] if l.startswith(("verifier:", "planner"))][-1], last)
                if last == "verifier:3av-settle":
                    self.assertFalse(has(r["labels"], "planner:3a-settle-2"), "put の欠けで止まり 2 回目の settle に進まない")
                    self.assertTrue(any("F-091" in x for x in stopped["integrity"]))
                self.assertEqual((stopped["status"], stopped["next_args"]["from"]), ("blocked", "3a"))
                entry = lambda st: {k: v for k, v in st.items() if k != "tx"}
                self.assertEqual(entry(stopped["next_args"]["state"]), entry(g0["next_args"]["state"]), "段の頭の state からやり直す（W は再実行の入口の restore で段の頭に戻す）")
                framed = [l.split(":")[1] for l in r["labels"] if l.startswith("planner:3a-settle")][-1]
                seq = g0["next_args"]["state"]["tx"]["seq"] + 1
                tx = {"seq": seq, "stage": "3a", "try": 1, "restore": f"t{seq}", "flow": f"f-{framed}"}
                self.assertEqual(stopped["next_args"]["state"]["tx"], tx, "同じ段の token で restore させ、最後に照合を通った flow の版を添える")

    def test_caseの出典だけが閉じたOを指すときもsettleでそのマスを直す(self):
        spec = {"args": reasked_at_limit()["next_args"], "ruled_at": {"3a": ["RS-001"]}, "open_only_at": {"3a": [{"el": "F-004", "case": 2, "open": "O-RS-001"}]},
                "unverified_at": {"3a-settle": ["F-004"]}}
        r = run(spec)
        self.assertIn("F-004 の case 2（O-RS-001 ← RS-001）", self._prompt(r, "planner:3a-settle"))
        judged_by(self, r, "verifier:3av-settle", "F-004")
        self.assertEqual(r["result"]["status"], "done")
        same = spec["open_only_at"]["3a"]
        left = run({**spec, "open_only_at": {**spec["open_only_at"], "3av-settle": same, "3av-settle-2": same}})["result"]
        self.assertEqual(left["status"], "blocked")
        self.assertIn("F-004 の case 2", left["reason"])

    def test_書き換えていない不合格のFは検証に渡さずsettleは進む(self):
        # unverified と failed_current は stub ではなく、F-002 に fail を put した実際の W で doc_check flow を叩いた stdout から取る。
        with tempfile.TemporaryDirectory() as tmp:
            ws = Path(tmp) / "W"
            shutil.copytree(Path(__file__).resolve().parent / "fixtures" / "workspace", ws)
            cli = lambda *a, stdin=None: json.loads(subprocess.run(["node", str(SKILL / "scripts" / "doc_check.mjs"), *a, "--workspace", str(ws)],
                                                                   input=stdin, capture_output=True, text=True, check=True).stdout)
            shas = [cli("sha", "--ledger", x)["sha256"] for x in ("resolutions", "decisions")]
            cli("put", "--ledger", "verifications", "--expect-resolutions", shas[0], "--expect-decisions", shas[1], "--token", "t1",
                stdin=json.dumps({"items": [{"id": "F-002", "verdict": "fail", "fail_kind": "insufficient_grounds", "reason": "r"}]}))
            got = cli("flow")
        unverified, failed = got["unverified"], got["failed_current"]
        self.assertIn("F-002", unverified)
        self.assertEqual(failed, ["F-002"])
        rewritten = [x for x in unverified if x not in failed]
        fail = [{"id": "F-002", "kind": "insufficient_grounds", "reason": "出典が無い"}]
        g0, g02 = self._g02_failed("F-002")
        self.assertNotIn("F-002", g0["next_args"]["state"]["failed_ids"])
        only = [{"el": "F-003", "open": "O-RS-001"}]
        r = run({"args": g02["next_args"], "world": self.world, "about": {"RS-005": {"verification": "F-002"}}, "ruled_at": {"3a": ["RS-001"]}, "flow_sha_at": {"3a": "f-3a"}, "unverified_at": {"3a": rewritten, "3a-settle": rewritten},
                 "open_only_at": {"3av": only}, "fails_when_asked": fail})
        self.assertEqual(r["result"]["status"], "done", r["result"].get("reason"))
        self.assertEqual([l for l in r["labels"] if l.startswith(("resolver:", "verifier:", "planner"))],
                         ["resolver:3a", "verifier:3av", "planner:3a-settle", "verifier:3av-settle"], "保持規則の裁定がある不合格の F- は渡さないので、差し戻しも変換も起きない")
        for label in ("verifier:3av", "verifier:3av-settle"):
            self.assertNotIn("F-002", self._prompt(r, label))
        judged_by(self, r, "verifier:3av-settle", "F-003")

    def test_検証に落ちた要素でもsettleで直させたら必ず検証する(self):
        _, g02 = self._g02_failed("F-003")
        r = run({"args": g02["next_args"], "world": self.world, "ruled_at": {"3a": ["RS-001"]}, "open_only_at": {"3a": [{"el": "F-003", "open": "O-RS-001"}]},
                 "unverified_at": {"3a-settle": ["F-003"]}})
        judged_by(self, r, "verifier:3av-settle", "F-003")
        self.assertEqual(r["result"]["status"], "done")

    def _rewritten_after_fail(self):
        g0 = self._g0_failed("F-003")
        return run({"args": g0["next_args"], "world": self.world, "ruled_at": {"3a": ["RS-001"]}, "flow_sha_at": {"3a": "f-3a"},
                    "unverified_at": {"3a": ["F-003"]}})

    def test_verifierがWの検証を通っていない要素を残せば同じrunで検証し直させる(self):
        # script の一覧に無くても、W の今の版に合否の無い要素を残した verifier の後は、別の verifier（<段>v-left）に検証させてから進む。
        # 段を頭からやり直させると、検証 1 回の漏れで段のすべての呼び出しをやり直す。
        spec = {"args": args(), "flow_open": 1, "ruled_at": {"3": ["RS-001"]}, "open_only_at": {"3v": [{"el": "F-053", "open": "O-RS-001"}]},
                "unverified_at": {"3-settle": ["F-053"]}, "ignores_at": {"3v-settle": ["F-053"]}}
        r = run(spec)
        self.assertEqual(r["result"]["status"], "done", r["result"].get("reason"))
        self.assertIn("verifier:3v-left-2", r["labels"])
        self.assertEqual(r["disk"]["unverified"], [])
        # 拾う側の verifier も残せば、拾う役がもう無いので段をやり直させる。
        res = run({**spec, "ignores_at": {"3v-settle": ["F-053"], "3v-left-2": ["F-053"]}})["result"]
        self.assertEqual((res["status"], res["next_args"]["from"]), ("blocked", "3"), res.get("reason"))
        self.assertIn("今の版に合否の無い要素（F-053）", res["reason"])

    def test_不合格の後に書き換えた要素は次のverifierで検証する(self):
        r = self._rewritten_after_fail()
        self.assertIn(VERIFY_ALL_MARK, self._prompt(r, "verifier:3av"))
        self.assertEqual(r["disk"]["unverified"], [], "書き換えた F-003 は W の unverified から検証させる")
        self.assertEqual(r["result"]["status"], "done", r["result"].get("reason"))

    def test_差し戻しは落ちた要素ごとに検証の裁定を返させる(self):
        # 落ちた要素は問いにも保持規則にも変えられないので、{verification} の裁定が無いまま進むと、settle に写す値も進めてよい理由も無い。
        fail = [{"id": "F-003", "kind": "insufficient_grounds", "reason": "出典が無い"}]
        r = run({"args": self._g0()["next_args"], "ruled_at": {"3a": ["RS-001"]}, "flow_sha_at": {"3a": "f-3a", "3a-fix": "f-3a2"},
                 "unverified_at": {"3a": ["F-003"], "3a-fix": ["F-003"]}, "fails_when_asked": fail})
        self.assertNotIn("verifier:3a-fixv", r["labels"])
        res = r["result"]
        self.assertEqual((res["status"], res["next_args"]["from"]), ("blocked", "3a"))
        self.assertIn("F-003 の about を {verification} にした resolution", res["reason"])

    def test_検証の裁定が問いになった要素は回答の候補の選択でも検証してsettleで写す(self):
        # B2 の形: F-003 が 3av と 3a-fixv に落ち、その検証の裁定 RS-005 も value_as_method で落ちて問いになる。g2 の候補の選択で回答が当たっても、
        # RS-005 は検証に落ちた裁定なので verifier に通し、合格したら settle が F-003 に写して検証する。
        fail = [{"id": "F-003", "kind": "insufficient_grounds", "reason": "出典が無い"}]
        rs_fail = [{"id": "RS-005", "kind": "value_as_method", "reason": "価値の判断"}]
        spec = {"world": self.world, "about": {"RS-005": {"verification": "F-003"}}}
        g0 = run({"args": args(), "flow_open": 1, "questions_at": {"3": ["RS-001"]}, **spec})["result"]
        g02 = run({"args": g0["next_args"], **spec, "ruled_at": {"3a": ["RS-001"], "3a-fix": ["RS-005"]}, "flow_sha_at": {"3a": "f-3a", "3a-fix": "f-3a2"},
                   "unverified_at": {"3a": ["F-003"], "3a-fix": ["F-003"]}, "verifier_fail": {"3av": fail, "3a-fixv": fail + rs_fail}, "questions_at": {"3a-convert": ["RS-005"]}})
        res = g02["result"]
        self.assertEqual((res["status"], res["question_ids"]), ("needs_answers", ["RS-005"]), res.get("reason"))
        self.assertEqual(on_disk(self.world)["failed_current"], ["F-003"])
        r = run({"args": res["next_args"], **spec, "ruled_at": {"3a": ["RS-005"]}, "unverified_at": {"3a-settle": ["F-003"]}})
        self.assertNotIn("verifier:3av", r["labels"], "変換後の問いと候補は独立検証済みなので、選択を重ねて検証しない")
        self.assertIn("F-003 ← RS-005", self._prompt(r, "planner:3a-settle"))
        self.assertEqual(r["result"]["status"], "done", r["result"].get("reason"))
        self.assertEqual(on_disk(self.world)["unverified"], [])

    def test_書き換えて合格した要素をwriterに根拠にしない要素として渡さない(self):
        grounds = self._prompt(self._rewritten_after_fail(), "writer:U-1:draft")
        self.assertIn("出典が検証に落ちた流れの要素（この要素を根拠に規範を書かない）: （なし）", grounds)

    def _verification_ruled(self):
        fail = [{"id": "F-003", "kind": "insufficient_grounds", "reason": "出典が無い"}]
        return run({"args": args(), "verifier_fail": {"3v": fail}, "ruled_at": {"3-fix": ["RS-005"]}, "about": {"RS-005": {"verification": "F-003"}},
                    "unverified_at": {"3-settle": ["F-003"]}})

    def test_検証の裁定は同じ段のsettleでflowに写し検証する(self):
        r = self._verification_ruled()
        self.assertEqual([l for l in r["labels"] if l.startswith(("resolver:", "verifier:", "planner:"))],
                         ["planner:1", "verifier:3v", "resolver:3-fix", "verifier:3-fixv", "planner:3-settle", "verifier:3v-settle"])
        self.assertIn("F-003 ← RS-005", self._prompt(r, "planner:3-settle"))
        judged_by(self, r, "verifier:3v-settle", "F-003")
        self.assertEqual(r["result"]["status"], "done", r["result"].get("reason"))

    def test_検証の裁定を写した要素をwriterに根拠にしない要素として渡さない(self):
        grounds = self._prompt(self._verification_ruled(), "writer:U-1:draft")
        self.assertIn("出典が検証に落ちた流れの要素（この要素を根拠に規範を書かない）: （なし）", grounds)

    def test_書き換えなかった検証の裁定の要素もsettleの検証に回す(self):
        fail = [{"id": "F-003", "kind": "insufficient_grounds", "reason": "出典が無い"}]
        r = run({"args": args(), "verifier_fail": {"3v": fail}, "ruled_at": {"3-fix": ["RS-005"]}, "about": {"RS-005": {"verification": "F-003"}},
                 "unverified_at": {"3-settle": ["F-003"]}, "fails_when_asked": fail})
        self.assertNotIn("F-003", self._prompt(r, "verifier:3-fixv"))
        judged_by(self, r, "verifier:3v-settle", "F-003")
        self.assertEqual((r["result"]["status"], r["result"]["next_args"]["from"]), ("blocked", "3"))
        self.assertIn("不合格: F-003", r["result"]["reason"])

    def test_verifierが返したFの合否がverificationsに無ければblocked(self):
        fail = [{"id": "F-003", "kind": "insufficient_grounds", "reason": "出典が無い"}]
        unput = run({"args": args(), "flow_open": 1, "questions_at": {"3": ["RS-001"]}, "verifier_fail": {"3v": fail}, "unput_at": {"3v": ["F-003"]}})
        self.assertEqual([l for l in unput["labels"] if l.startswith(("resolver:", "verifier:"))], ["verifier:3v"], "planner:1 が問いを裁定したので段 3 の resolver は起動しない")
        passed = run({"args": self._g0()["next_args"], "ruled_at": {"3a": ["RS-001"]}, "flow_sha_at": {"3a": "f-3a"}, "unverified_at": {"3a": ["F-003"]}, "unput_at": {"3av": ["F-003"]}})
        self.assertIn("verifier:3av", passed["labels"])
        for name, r, frm in (("fail を put していない", unput, "3"), ("pass を put していない", passed, "3a")):
            with self.subTest(name):
                res = r["result"]
                self.assertEqual((res["status"], res["next_args"]["from"]), ("blocked", frm))
                self.assertIn("F-003", res["reason"])
                self.assertTrue(any("F-003" in line for line in res["integrity"]), res["integrity"])

    def test_決定の検証の裁定は覆した決定を引く要素が無ければsettleしない(self):
        fail = [{"id": "D-003", "kind": "insufficient_grounds", "reason": "出典が無い"}]
        r = run({"args": args(), "verifier_fail": {"3v": fail}, "ruled_at": {"3-fix": ["RS-005"]}, "about": {"RS-005": {"verification": "D-003"}}})
        self.assertFalse(has(r["labels"], "planner:3-settle"))
        self.assertEqual(r["result"]["status"], "done", r["result"].get("reason"))

    def test_覆された決定を引く要素はsettleで直し検証する(self):
        fail = [{"id": "D-003", "kind": "insufficient_grounds", "reason": "出典が無い"}]
        stale = [{"el": "F-002", "ref": "D-003"}]
        spec = {"args": args(), "verifier_fail": {"3v": fail}, "ruled_at": {"3-fix": ["RS-005"]}, "about": {"RS-005": {"verification": "D-003"}},
                "stale_refs_at": {"3-fixv": stale}, "unverified_at": {"3-settle": ["F-002"]}}
        r = run(spec)
        self.assertEqual([l for l in r["labels"] if l.startswith(("resolver:", "verifier:", "planner:"))],
                         ["planner:1", "verifier:3v", "resolver:3-fix", "verifier:3-fixv", "planner:3-settle", "verifier:3v-settle"])
        self.assertIn("F-002 ← D-003", self._prompt(r, "planner:3-settle"))
        judged_by(self, r, "verifier:3v-settle", "F-002")
        self.assertEqual(r["result"]["status"], "done", r["result"].get("reason"))
        left = run({**spec, "stale_refs_at": {"3-fixv": stale, "3v-settle": stale, "3v-settle-2": stale}})["result"]
        self.assertEqual((left["status"], left["next_args"]["from"]), ("blocked", "3"))
        self.assertIn("覆された決定を引く要素: F-002（D-003）", left["reason"])

    def test_差し戻しの後も落ちた要素は同じcycleの検証の裁定をsettleで写せば進む(self):
        fail = [{"id": "F-003", "kind": "insufficient_grounds", "reason": "出典が無い"}]
        spec = {"args": reasked_at_limit()["next_args"], "ruled_at": {"3a": ["RS-001"], "3a-fix": ["RS-005"]}, "about": {"RS-005": {"verification": "F-003"}},
                "flow_sha_at": {"3a": "f-3a", "3a-fix": "f-3a2"}, "unverified_at": {"3a": ["F-003"], "3a-fix": ["F-003"], "3a-settle": ["F-003"]},
                "verifier_fail": {"3av": fail, "3a-fixv": fail}}
        r = run(spec)
        self.assertEqual([l for l in r["labels"] if l.startswith(("resolver:3a", "verifier:3a", "planner:3a"))],
                         ["resolver:3a", "verifier:3av", "resolver:3a-fix", "verifier:3a-fixv", "planner:3a-settle", "verifier:3av-settle"], "要素は変換に渡さない")
        self.assertIn("F-003 ← RS-005", self._prompt(r, "planner:3a-settle"))
        self.assertEqual(r["result"]["status"], "done", r["result"].get("reason"))
        left = run({**spec, "verifier_fail": {**spec["verifier_fail"], "3av-settle": fail, "3av-settle-2": fail}})["result"]
        self.assertEqual((left["status"], left["next_args"]["from"]), ("blocked", "3a"), "settle の後も落ちたら止め、段の頭からやり直せる")
        self.assertIn("不合格: F-003", left["reason"])

    def test_変換と保持規則への変換で覆された決定もsettleで直す(self):
        stale = [{"el": "F-002", "ref": "D-001"}]
        rs_fail = [{"id": "RS-001", "kind": "insufficient_grounds", "reason": "出典が無い"}]
        convert = {"args": args(), "flow_open": 1, "ruled_at": {"3": ["RS-001"], "3-fix": ["RS-001"]}, "verifier_fail": {"3v": rs_fail, "3-fixv": rs_fail},
                   "questions_at": {"3-convert": ["RS-001"]}, "supersedes_at": {"3-convert": ["D-001"]}, "stale_refs_at": {"3-convert": stale},
                   "unverified_at": {"3-settle": ["F-002"]}}
        convert["stale_refs_at"]["3-convertv"] = stale
        hold = {"args": args(), "findings": {"writerReviewer:r1": [{"id": "r1-wr-all-001", "route": "decision"}]},
                "questions_at": {"6": ["RS-020"]}, "supersedes_at": {"6-hold": ["D-001"]}, "stale_refs_at": {"6-hold": stale, "6-holdv-left": stale},
                "unverified_at": {"6-hold-settle": ["F-002"]}}
        hold["args"] = stage6_at_limit(hold)
        for name, spec, framer, verifier, key, status in (("変換", convert, "planner:3-settle", "verifier:3v-settle", "3v-settle", "needs_answers"),
                                                          ("上限の段 6 の保持規則への変換", hold, "planner:6-hold-settle", "verifier:6-holdv-settle", "6-holdv-settle", "done")):
            with self.subTest(name):
                r = run(spec)
                self.assertIsNone(r["error"], r["error"])
                self.assertIn("F-002 ← D-001", self._prompt(r, framer))
                judged_by(self, r, verifier, "F-002")
                self.assertEqual(r["result"]["status"], status, r["result"].get("reason"))
                left = run({**spec, "stale_refs_at": {**spec["stale_refs_at"], key: stale, f"{key}-2": stale}})["result"]
                self.assertEqual(left["status"], "blocked")
                self.assertIn("覆された決定を引く要素: F-002（D-001）", left["reason"])

    def test_constrained_byの閉じた不変条件のOはsettleでRSに差し替えて検証する(self):
        # 段 2 で flow-framer が起こした kind invariant の O- を破壊的な工程が挙げ、段 3 の resolver が閉じた形。
        spec = {"args": args(), "flow_open": 1, "ruled_at": {"3": ["RS-001"]}, "open_only_at": {"3v": [{"el": "F-053", "constraint": "O-RS-001"}]}, "unverified_at": {"3-settle": ["F-053"]}}
        r = run(spec)
        self.assertEqual([l for l in r["labels"] if "settle" in l], ["planner:3-settle", "verifier:3v-settle"])
        self.assertIn("constrained_by の閉じた O-（要素 の O- ← 閉じた resolution）: F-053 の O-RS-001 ← RS-001", self._prompt(r, "planner:3-settle"))
        judged_by(self, r, "verifier:3v-settle", "F-053")
        self.assertEqual(r["result"]["status"], "done")
        same = spec["open_only_at"]["3v"]
        left = run({**spec, "open_only_at": {**spec["open_only_at"], "3v-settle": same, "3v-settle-2": same}})["result"]
        self.assertEqual(left["status"], "blocked")
        self.assertIn("閉じた未決を引く要素: F-053（O-RS-001）", left["reason"])
        held = run({**spec, "ruled_at": {}, "holds_at": {"3": ["RS-001"]}})
        self.assertFalse(has(held["labels"], "planner:3-settle"), "hold で閉じた不変条件の O- は未決のまま縛りに残る")

    def test_段3で閉じたOも同じcycleでsettleする(self):
        r = run({"args": args(), "flow_open": 1, "ruled_at": {"3": ["RS-001"]}, "open_only_at": {"3v": [{"el": "F-091", "open": "O-RS-001"}]}})
        self.assertIn("planner:3-settle", r["labels"])
        self.assertEqual(r["labels"][r["labels"].index("planner:3-settle") + 1], "verifier:3v-settle")
        self.assertEqual(r["result"]["status"], "done")

    def test_保持規則と回答待ちの問いで閉じたOではsettleしない(self):
        only = [{"el": "F-091", "open": "O-RS-001"}]
        held = run({"args": args(), "flow_open": 1, "holds_at": {"3": ["RS-001"]}, "open_only_at": {"3v": only}})
        self.assertFalse(has(held["labels"], "planner:3-settle"))
        asked = run({"args": args(), "flow_open": 1, "questions_at": {"3": ["RS-001"]}, "open_only_at": {"3v": only}})
        self.assertFalse(has(asked["labels"], "planner:3-settle"))
        self.assertEqual(asked["result"]["status"], "needs_answers")

    def test_段6でも同じ経路でsettleする(self):
        spec = {"args": args(), "findings": {"wholeReviewer:r1": [{"id": "r1-wh-all-001", "route": "decision"}]}, "ruled_at": {"6": ["RS-011"]},
                "open_only_at": {"6v": [{"el": "F-091", "open": "O-RS-011"}]}}
        r = run(spec)
        self.assertIn("planner:6-settle", r["labels"])
        self.assertEqual(r["labels"][r["labels"].index("planner:6-settle") + 1], "verifier:6v-settle")
        same = spec["open_only_at"]["6v"]
        stopped = run({**spec, "open_only_at": {"6v": same, "6v-settle": same, "6v-settle-2": same}})["result"]
        self.assertEqual((stopped["status"], stopped["next_args"]["from"]), ("blocked", "6"))

    def test_settleでflowが閉じなければ差し戻し件数が減らなければblocked(self):
        spec = {"args": args(), "flow_open": 1, "ruled_at": {"3": ["RS-001"]}, "open_only_at": {"3v": [{"el": "F-091", "open": "O-RS-001"}]}}
        fixed = run({**spec, "flow_findings_at": {"3-settle": 1}, "pair_keys_at": {"3-settle-rework": ["pair:D-001|F-099"]}})
        self.assertEqual([l for l in fixed["labels"] if "settle" in l],
                         ["planner:3-settle", "planner:3-settle:rework", "resolver:3-settle-pairs", "verifier:3v-settle"], "組は差し戻した後の stdout から読む")
        self.assertIn("指摘が 1 件", self._prompt(fixed, "planner:3-settle:rework"))
        self.assertEqual(fixed["result"]["status"], "done")
        broken = run({**spec, "flow_findings_at": {"3-settle": 1, "3-settle-rework": 1}})
        self.assertEqual([l for l in broken["labels"] if "settle" in l], ["planner:3-settle", "planner:3-settle:rework"])
        self.assertEqual((broken["result"]["status"], broken["result"]["next_args"]["from"]), ("blocked", "3"))


@unittest.skipIf(shutil.which("node") is None, "node が無い環境ではスキップする")
class FlowFixerRoutes(unittest.TestCase):
    """回答を当てた resolver に消せない flow の指摘（FIXERS_BY_CODE）は settle の flow-framer に回し、flow-framer が足した
    kind invariant の O- は同じ cycle の resolver（<段>-settle-opens）に回す（R6b）。"""

    DESTRUCTIVE = {"FLOW_DESTRUCTIVE_UNCONSTRAINED": ["F-053"]}

    def _prompt(self, r, label):
        [p] = [x["prompt"] for x in r["prompts"] if x["label"] == label]
        return p

    def _cycle(self, r):
        return [l for l in r["labels"] if l.startswith(("resolver:", "verifier:", "planner"))]

    def _spec(self, nargs, stage, **kw):
        # stage の resolver が破壊的な工程を足し（段 3 の resolver は flow を書かないので、台帳の書き込みで縛りが外れる）、生きている invariant が無い。
        # framer（既定は settle の flow-framer。g1 の後の 3a は反映を渡す 3b-reframe）が O-009 を足して縛る。answered は stage の resolver が裁定する ID。
        v = {"3": "3v", "3a": "3av", "3a'": "3a'v"}[stage]
        framer = kw.pop("framer", f"{stage}-settle")
        start = {"flow_open": 1} if stage == "3" else {"flow_sha_at": {stage: f"f-{stage}"}}
        spec = {"args": nargs, "ruled_at": {stage: [kw.pop("answered")]}, **start,
                "flow_codes_at": {**({} if stage == "3" else {stage: self.DESTRUCTIVE}), v: self.DESTRUCTIVE}, "unverified_at": {framer: ["F-053"]},
                "open_ids_at": {framer: ["O-009"]}, "about": {"RS-009": {"open": "O-009"}}}
        spec.update(kw)
        return spec

    def test_誰もflowを書かない段3と段6で台帳から出た縛りの無さも同じcycleで縛られ裁定される(self):
        # AC3: 段 3・6 の resolver は flow を書かない。台帳の書き込み（invariant の O- を invariant でない resolution で閉じる等）で出た
        # 縛りの無さは、どの段で生まれても settle の flow-framer が O- を足し、同じ cycle の resolver が裁定する。
        common = {"open_ids_at": {"3-settle": ["O-060"], "6-settle": ["O-060"]}, "about": {"RS-060": {"open": "O-060"}, "RS-010": {"finding": "r1-wh-all-001"}},
                  "unverified_at": {"3-settle": ["F-053"], "6-settle": ["F-053"]}}
        for stage, spec in (("3", {"flow_open": 1, "ruled_at": {"3": ["RS-001"], "3-settle-opens": ["RS-060"]}, "flow_codes_at": {"3v": self.DESTRUCTIVE}}),
                            ("6", {"findings": {"wholeReviewer:r1": [{"id": "r1-wh-all-001", "route": "decision"}]}, "ruled_at": {"6": ["RS-010"], "6-settle-opens": ["RS-060"]},
                                   "flow_codes_at": {"6": self.DESTRUCTIVE, "6v": self.DESTRUCTIVE}})):
            with self.subTest(stage=stage):
                r = run({"args": args(), **common, **spec})
                labels = r["labels"]
                self.assertEqual(labels[labels.index(f"verifier:{stage}v") + 1:][:2], [f"planner:{stage}-settle", f"verifier:{stage}v-settle"], "settle の planner が足した O- を同じ体で裁定する")
                self.assertFalse(has(labels, f"resolver:{stage}-settle-opens"))
                self.assertIn("F-053: 縛る不変条件が無い", self._prompt(r, f"planner:{stage}-settle"))
                self.assertIn("RS-060", self._prompt(r, f"verifier:{stage}v-settle").split("検証する resolution の ID:")[1].split("\n")[0])
                res = r["result"]
                self.assertEqual((res["status"], res["integrity"]), ("done", []), res.get("reason"))

    def test_保険のresolver_3bは裁定するopenに触れる合格した裁定を指される(self):
        # planner:3b が裁定し漏らした O-009 を保険の resolver:3b が裁定する（planner の起動の前には組が分からないので、指された根拠は保険にだけ渡る）。
        g0 = run({"args": args(), "flow_open": 1, "ruled_at": {"3": ["RS-005"]}, "questions_at": {"3": ["RS-001"]}, "about": {"RS-005": {"pair": ["F-053", "O-009"]}}})["result"]
        spec = self._spec(g0["next_args"], "3a", answered="RS-001", framer="3b-reframe", questions_at={"3b": ["RS-009"]}, planner_leaves_at={"3b": ["RS-009"]})
        line = "- open:O-009: RS-005（pair:F-053|O-009）"
        r = run(spec)
        self.assertEqual(self._cycle(r), ["resolver:3a", "verifier:3av", "planner:3b", "resolver:3b", "verifier:3bv"])
        self.assertIn(line, self._prompt(r, "resolver:3b"))
        self.assertNotIn("3a から持ち越した問い", self._prompt(r, "resolver:3b"), "持ち越した問いは planner:3b が扱い、保険の task は open と組だけ")

    def test_g1の後の3aで縛りの無い破壊的な工程は3bのflow_framerが縛りresolver_3bが問いにしてg2で聞く(self):
        # 3a の反映（flow の指摘）は 3a の settle を回さず 3b-reframe に渡し、足した O- は resolver:3b がまとめて裁定し、flow は 3bv だけが検証する。
        g0 = run({"args": args(), "flow_open": 1, "questions_at": {"3": ["RS-001"]}})["result"]
        r = run(self._spec(g0["next_args"], "3a", answered="RS-001", framer="3b-reframe", questions_at={"3b": ["RS-009"]}))
        self.assertEqual(self._cycle(r), ["resolver:3a", "verifier:3av", "planner:3b", "verifier:3bv"], "組み直しと足した O- の裁定は planner:3b 1 体")
        self.assertFalse(has(r["labels"], "resolver:3a-flow"), "resolver には消せない指摘を resolver に差し戻さない")
        self.assertIn("F-053: 縛る不変条件が無い", self._prompt(r, "planner:3b"))
        table = value("FIXERS_BY_CODE")
        leave = [l for l in self._prompt(r, "resolver:3a").split("\n") if "は触らない" in l]
        self.assertEqual(len(leave), 1, "回答を当てる resolver に、flow-framer に残す符号を最初のプロンプトで渡す")
        self.assertEqual(set(re.findall(r"FLOW_[A-Z_]+", leave[0])), {k for k, v in table.items() if "resolver" not in v["fixers"]})
        self.assertNotIn("question ではなく hold", self._prompt(r, "planner:3b"), "聞ける 3b の planner は問いを返してよい")
        self.assertIn("RS-009", self._prompt(r, "verifier:3bv").split("検証する resolution の ID:")[1].split("\n")[0])
        self.assertIn(VERIFY_ALL_MARK, self._prompt(r, "verifier:3bv"))
        self.assertNotIn("F-053", r["disk"]["unverified"], "flow-framer が直した要素は W の unverified から検証させる")
        res = r["result"]
        self.assertEqual((res["status"], res["question_ids"]), ("needs_answers", ["RS-009"]), res.get("reason"))
        self.assertEqual(res["answers_path"], "/tmp/prd-w/answers/g2.md")

    def test_3aの裁定で閉じたOはsettleの次の回でRSに差し替わり段を出る(self):
        # 2 回目の settle の flow-framer の後も O-009 は open.json にあるが、RS-009 が裁定済みなので resolver に渡し直さない。
        spec = self._spec(reasked_at_limit()["next_args"], "3a", answered="RS-001", ruled_at={"3a": ["RS-001"], "3a-settle-opens": ["RS-009"]},
                          open_only_at={"3av-settle": [{"el": "F-053", "constraint": "O-009"}]}, unverified_at={"3a-settle": ["F-053"], "3a-settle-2": ["F-053"]},
                          open_ids_at={"3a-settle": ["O-009"], "3a-settle-2": ["O-009"]})
        r = run(spec)
        self.assertEqual([l for l in r["labels"] if "settle" in l],
                         ["planner:3a-settle", "verifier:3av-settle", "planner:3a-settle-2", "verifier:3av-settle-2"])
        self.assertIn("F-053 の O-009 ← RS-009", self._prompt(r, "planner:3a-settle-2"))
        self.assertEqual(r["result"]["status"], "done", r["result"].get("reason"))
        self.assertLessEqual(sum(1 for l in r["labels"] if l.startswith("planner:3a-settle")), const("MAX_SETTLE_ROUNDS"))

    def test_上限の3a_dashでは縛る不変条件の未決はholdにする(self):
        g1 = run({"args": args(), "findings": {"wholeReviewer:r1": [{"id": "r1-wh-all-001", "route": "decision"}]}, "questions_at": {"6": ["RS-010"]}})["result"]
        self.assertEqual(g1["next_args"]["from"], "3a'")
        r = run(self._spec(at_limit(g1["next_args"]), "3a'", answered="RS-010", holds_at={"3a'-settle-opens": ["RS-009"]}))
        self.assertEqual(self._cycle(r)[:4], ["resolver:3a'", "verifier:3a'v", "planner:3a'-settle", "verifier:3a'v-settle"])
        self.assertIn("question ではなく hold", self._prompt(r, "planner:3a'-settle"), "聞けない段の settle の planner には hold にさせる")
        self.assertFalse(has(r["labels"], "planner:3a'-settle-2"), "hold の O- は保持規則として縛りに残る")
        self.assertEqual(r["result"]["status"], "done", r["result"].get("reason"))
        self.assertIn("RS-009", r["result"]["holds"])

    def test_resolverが消せる指摘は今どおりresolverに差し戻す(self):
        both = {"FLOW_DANGLING": ["F-054"], **self.DESTRUCTIVE}
        r = run(self._spec(reasked_at_limit()["next_args"], "3a", answered="RS-001", flow_codes_at={"3a": both, "3a-flow": self.DESTRUCTIVE, "3av": self.DESTRUCTIVE},
                           ruled_at={"3a": ["RS-001"], "3a-settle-opens": ["RS-009"]}))
        fix = self._prompt(r, "resolver:3a-flow")
        self.assertIn("指摘が 1 件", fix)
        self.assertIn("F-053（FLOW_DESTRUCTIVE_UNCONSTRAINED） は settle の planner が直す", fix)
        self.assertIn("planner:3a-settle", r["labels"])
        self.assertEqual(r["result"]["status"], "done", r["result"].get("reason"))

    def test_settleのplannerが裁定し漏らした新しい組と新しいOは1回の保険のresolverにまとめて渡す(self):
        r = run(self._spec(reasked_at_limit()["next_args"], "3a", answered="RS-001", ruled_at={"3a": ["RS-001"], "3a-settle-opens": ["RS-009", "RS-010"]},
                           pair_keys_at={"3a-settle": ["pair:F-053|RS-001"]}, about={"RS-009": {"open": "O-009"}, "RS-010": {"pair": ["F-053", "RS-001"]}},
                           planner_leaves_at={"3a-settle": ["RS-009", "RS-010"]}))
        self.assertEqual([l for l in r["labels"] if l.startswith("resolver:3a-settle")], ["resolver:3a-settle-opens"])
        task = self._prompt(r, "resolver:3a-settle-opens")
        self.assertIn("まだ裁定の無い組（/tmp/prd-w/checks/conflicts.json）: pair:F-053|RS-001", task)
        self.assertIn("まだ裁定の無い open: O-009（`node " + str(SKILL) + "/scripts/doc_check.mjs get --workspace /tmp/prd-w --ledger open --ids O-009`）", task)
        ids = self._prompt(r, "verifier:3av-settle").split("検証する resolution の ID:")[1].split("\n")[0]
        self.assertIn("RS-009", ids)
        self.assertIn("RS-010", ids)
        self.assertEqual(r["result"]["status"], "done", r["result"].get("reason"))

    def test_settleのplannerが組だけを裁定し漏らせば保険のpairsが1回起動する(self):
        # 設計 6.3 の 7: O- は planner が裁定し、組だけが残る。その組は保険の resolver:<tag>-pairs が裁定し、同じ settle の verifier に渡る。
        r = run(self._spec(reasked_at_limit()["next_args"], "3a", answered="RS-001", ruled_at={"3a": ["RS-001"], "3a-settle-opens": ["RS-009", "RS-010"]},
                           pair_keys_at={"3a-settle": ["pair:F-053|RS-001"]}, about={"RS-009": {"open": "O-009"}, "RS-010": {"pair": ["F-053", "RS-001"]}},
                           planner_leaves_at={"3a-settle": ["RS-010"]}))
        self.assertEqual([l for l in r["labels"] if l.startswith("resolver:3a-settle")], ["resolver:3a-settle-pairs"])
        task = self._prompt(r, "resolver:3a-settle-pairs")
        self.assertIn("まだ裁定の無い組（/tmp/prd-w/checks/conflicts.json）: pair:F-053|RS-001", task)
        self.assertNotIn("まだ裁定の無い open: ", task)
        ids = self._prompt(r, "verifier:3av-settle").split("検証する resolution の ID:")[1].split("\n")[0]
        self.assertIn("RS-009", ids, "planner の裁定も同じ verifier に渡る")
        self.assertIn("RS-010", ids, "保険の裁定も同じ verifier に渡る")
        self.assertEqual(r["result"]["status"], "done", r["result"].get("reason"))

    def test_表に無い符号は生成者に差し戻さずに止める(self):
        g0 = run({"args": args(), "flow_open": 1, "questions_at": {"3": ["RS-001"]}})["result"]
        r = run(self._spec(g0["next_args"], "3a", answered="RS-001", flow_codes_at={"3a": {"FLOW_NEW": ["F-053"]}}))
        self.assertFalse(has(r["labels"], "resolver:3a-flow"))
        self.assertFalse(has(r["labels"], "verifier:3av"))
        # 表は静的なので、同じ段をやり直しても同じ符号で止まる。やり直しの引数を返さない。
        self.assertEqual((r["result"]["status"], r["result"]["next_args"]), ("blocked", None))
        self.assertIn("FLOW_NEW", r["result"]["reason"])
        settle = run(self._spec(reasked_at_limit()["next_args"], "3a", answered="RS-001", flow_codes_at={"3a": self.DESTRUCTIVE, "3av": self.DESTRUCTIVE, "3a-settle": {"FLOW_NEW": ["F-053"]}}))
        self.assertFalse(has(settle["labels"], "planner:3a-settle:rework"))
        self.assertEqual((settle["result"]["status"], settle["result"]["next_args"]), ("blocked", None))
        self.assertIn("FLOW_NEW", settle["result"]["reason"])
        framer_run = run({"args": args(), "flow_codes_at": {"framer": {"FLOW_NEW": ["F-001"]}}})
        framer = framer_run["result"]
        self.assertFalse(has(framer_run["labels"], "planner:1:rework"), "表に無い符号は planner:1 にも差し戻さない")
        self.assertEqual((framer["status"], framer["next_args"]), ("blocked", None))
        self.assertIn("FLOW_NEW", framer["reason"])

    def _settle_fails(self, nargs, stage, fail, **kw):
        # settle の verifier の不合格は 1 回差し戻され、差し戻しの verifier（<段>-settle-fixv）にも落ちて初めて変換に回る。
        return run(self._spec(nargs, stage, verifier_fail={f"{stage}v-settle": [fail], f"{stage}-settle-fixv": [fail]}, **kw))

    def test_settleのverifierに落ちたOの裁定は上限の3a_dashでは保持規則に変えて段を出る(self):
        g1 = run({"args": args(), "findings": {"wholeReviewer:r1": [{"id": "r1-wh-all-001", "route": "decision"}]}, "questions_at": {"6": ["RS-010"]}})["result"]
        r = self._settle_fails(at_limit(g1["next_args"]), "3a'", {"id": "RS-009", "kind": "value_as_method", "reason": "r"}, answered="RS-010",
                               ruled_at={"3a'": ["RS-010"], "3a'-settle-opens": ["RS-009"]}, holds_at={"3a'-settle-convert": ["RS-009"]})
        self.assertEqual(self._cycle(r)[:7], ["resolver:3a'", "verifier:3a'v", "planner:3a'-settle", "verifier:3a'v-settle",
                                              "resolver:3a'-settle-fix", "verifier:3a'-settle-fixv", "resolver:3a'-settle-convert"])
        self.assertIn("RS-009 → hold（value_as_method）", self._prompt(r, "resolver:3a'-settle-convert"))
        self.assertFalse(has(r["labels"], "verifier:3a'v-settle-2"), "変換した裁定はもう検証しない")
        self.assertEqual(r["result"]["status"], "done", r["result"].get("reason"))
        self.assertIn("RS-009", r["result"]["holds"])

    def test_settleのverifierが回答待ちの問いを落としても変換しない(self):
        # 段 3 の resolver が RS-001 を裁定し RS-002 を問いにした（聞ける段の settle）。settle の verifier に RS-002 は渡していない。
        fails = [{"id": "RS-009", "kind": "value_as_method", "reason": "r"}, {"id": "RS-002", "kind": "insufficient_grounds", "reason": "r"}]
        r = run(self._spec(args(), "3", answered="RS-001", ruled_at={"3": ["RS-001"], "3-settle-opens": ["RS-009"]},
                           verifier_fail={"3v-settle": fails, "3-settle-fixv": fails[:1]}, questions_at={"3": ["RS-002"], "3-settle-convert": ["RS-009"]}))
        self.assertNotIn("RS-002", self._prompt(r, "resolver:3-settle-fix"))
        convert = self._prompt(r, "resolver:3-settle-convert")
        self.assertIn("RS-009 → question", convert)
        self.assertNotIn("RS-002", convert)
        res = r["result"]
        self.assertEqual(res["status"], "needs_answers", res.get("reason"))
        self.assertIn("RS-002", res["question_ids"])
        self.assertNotIn("RS-002", res["next_args"]["state"].get("failed_ids", []))

    def test_3bvが持ち越した回答待ちの問いを落としても変換しない(self):
        # g1 の問い RS-001・RS-002 のうち 3a で RS-001 だけに答えた。3a の反映で足した O-009 を resolver:3b が裁定し、3bv には RS-002 を渡していない。
        g0 = run({"args": args(), "flow_open": 1, "questions_at": {"3": ["RS-001", "RS-002"]}})["result"]
        fails = [{"id": "RS-009", "kind": "value_as_method", "reason": "r"}, {"id": "RS-002", "kind": "insufficient_grounds", "reason": "r"}]
        r = run(self._spec(g0["next_args"], "3a", answered="RS-001", framer="3b-reframe", ruled_at={"3a": ["RS-001"], "3b": ["RS-009"]},
                           verifier_fail={"3bv": fails, "3b-fixv": fails[:1]}, questions_at={"3b-convert": ["RS-009"]}))
        self.assertNotIn("RS-002", self._prompt(r, "resolver:3b-fix"))
        convert = self._prompt(r, "resolver:3b-convert")
        self.assertIn("RS-009 → question", convert)
        self.assertNotIn("RS-002", convert)
        res = r["result"]
        self.assertEqual(res["status"], "needs_answers", res.get("reason"))
        self.assertIn("RS-002", res["question_ids"])
        self.assertNotIn("RS-002", res["next_args"]["state"].get("failed_ids", []))

    def test_settleのverifierに落ちたOの裁定は聞ける段では問いにできる(self):
        r = self._settle_fails(args(), "3", {"id": "RS-009", "kind": "value_as_method", "reason": "r"}, answered="RS-001",
                               ruled_at={"3": ["RS-001"], "3-settle-opens": ["RS-009"]}, questions_at={"3-settle-convert": ["RS-009"]})
        self.assertIn("RS-009 → question（value_as_method）", self._prompt(r, "resolver:3-settle-convert"))
        res = r["result"]
        self.assertEqual((res["status"], res["question_ids"]), ("needs_answers", ["RS-009"]), res.get("reason"))

    def test_settleで変換した後もverifierが見た覆された決定を引く要素は次の回で直す(self):
        # 変換の resolver の stdout は stale_refs を申告していない。verifier の stdout にあった分を落とさない。
        r = self._settle_fails(args(), "3", {"id": "RS-009", "kind": "value_as_method", "reason": "r"}, answered="RS-001",
                               ruled_at={"3": ["RS-001"], "3-settle-opens": ["RS-009"]}, questions_at={"3-settle-convert": ["RS-009"]},
                               stale_refs_at={"3v-settle": [{"el": "F-053", "ref": "D-001"}], "3-settle-fixv": [{"el": "F-053", "ref": "D-001"}],
                                              "3-settle-convertv": [{"el": "F-053", "ref": "D-001"}]})
        self.assertIn("resolver:3-settle-convert", r["labels"])
        self.assertIn("F-053 ← D-001", self._prompt(r, "planner:3-settle-2"))

    def test_settleのverifierに落ちた組の裁定も止めずに変える(self):
        g1 = run({"args": args(), "findings": {"wholeReviewer:r1": [{"id": "r1-wh-all-001", "route": "decision"}]}, "questions_at": {"6": ["RS-010"]}})["result"]
        r = self._settle_fails(at_limit(g1["next_args"]), "3a'", {"id": "RS-011", "kind": "insufficient_grounds", "reason": "r"}, answered="RS-010",
                               open_ids_at={}, pair_keys_at={"3a'-settle": ["pair:F-053|RS-010"]}, about={"RS-011": {"pair": ["F-053", "RS-010"]}},
                               ruled_at={"3a'": ["RS-010"], "3a'-settle-pairs": ["RS-011"]}, holds_at={"3a'-settle-convert": ["RS-011"]})
        self.assertIn("planner:3a'-settle", r["labels"])
        self.assertNotIn("resolver:3a'-settle-pairs", r["labels"], "組は settle の planner が同じ体で裁定する")
        self.assertIn("RS-011 → hold（insufficient_grounds）", self._prompt(r, "resolver:3a'-settle-convert"))
        self.assertEqual(r["result"]["status"], "done", r["result"].get("reason"))

    def test_settleのverifierが独立に見つけた縛りの無さは台帳が変わらない回で残ればflow_framerの指摘として止める(self):
        # 1 回目は flow-framer の後に resolver が O-009 を裁定して台帳を変えたので、次の回の flow-framer に渡す。2 回目は台帳が変わらず、
        # flow-framer の stdout に無かった指摘は flow-framer 自身のもので、渡し直す先が無い。
        spec = self._spec(reasked_at_limit()["next_args"], "3a", answered="RS-001", ruled_at={"3a": ["RS-001"], "3a-settle-opens": ["RS-009"]},
                          flow_codes_at={"3a": self.DESTRUCTIVE, "3av": self.DESTRUCTIVE, "3av-settle": self.DESTRUCTIVE})
        passed = run(spec)
        self.assertIn("F-053: 縛る不変条件が無い", self._prompt(passed, "planner:3a-settle-2"))
        self.assertEqual(passed["result"]["status"], "done", passed["result"].get("reason"))
        r = run({**spec, "flow_codes_at": {**spec["flow_codes_at"], "3av-settle-2": self.DESTRUCTIVE}})
        self.assertEqual(r["result"]["status"], "blocked")
        self.assertIn("段 3av-settle-2: verifier の doc_check flow に指摘が 1 件", r["result"]["reason"])

    def test_変換の後のsettleに渡す指摘はflow_checkのstdoutから取る(self):
        # 変換が台帳を変えて縛りの無さが出たのに、変換の resolver の stdout は 0 件と申告した。差し戻しの verifier は変換の前に
        # 走ったので見ていない。別の agent（flow-check）の stdout から flow-framer（g1 の後の 3a は反映を渡す 3b-reframe）に渡し、
        # 申告との食い違いを integrity に残す。候補の選択だけの回答は verifier に渡さないので、自由記述の回答にして検証させる。
        g0 = run({"args": args(), "flow_open": 1, "questions_at": {"3": ["RS-001"]}})["result"]
        fail = [{"id": "RS-001", "kind": "insufficient_grounds", "reason": "r"}]
        spec = self._spec(g0["next_args"], "3a", answered="RS-001", framer="3b-reframe", ruled_at={"3a": [], "3a-fix": ["RS-001"], "3b": ["RS-009"]},
                          free_text_at={"3a": ["RS-001"]}, verifier_fail={"3av": fail, "3a-fixv": fail}, questions_at={"3a-convert": ["RS-001"]},
                          flow_codes_at={"3a-convertv": self.DESTRUCTIVE})
        r = run(spec)
        self.assertEqual(self._cycle(r)[4:7], ["resolver:3a-convert", "verifier:3a-convertv", "planner:3b"])
        self.assertEqual(r["labels"][r["labels"].index("resolver:3a-convert") + 1], "verifier:3a-convertv", "問いへの変換の後は flow-check で数え直さない")
        self.assertIn("F-053: 縛る不変条件が無い", self._prompt(r, "planner:3b"))
        # g1 の後の 3a は聞けるので、差し戻しの後も落ちた回答は g2 の問いになる。
        self.assertEqual((r["result"]["status"], r["result"]["question_ids"]), ("needs_answers", ["RS-001"]), r["result"].get("reason"))
        self.assertTrue(any("resolver（段 3a-convert）" in x and "codes・findings で違う" in x for x in r["result"]["integrity"]), r["result"]["integrity"])
        honest = run({**spec, "flow_codes_at": {"3a-convert": self.DESTRUCTIVE, "3a-convertv": self.DESTRUCTIVE}})["result"]
        self.assertEqual(honest["status"], "needs_answers", honest.get("reason"))
        self.assertEqual(honest["integrity"], [], "申告が一致すれば integrity に残さない")

    def test_settleの変換の後にflow_checkが見た指摘は次の回のsettleで直す(self):
        # settle の verifier は flow-framer が消せる指摘を 0 件にしてから通るので、残りに数える指摘は変換が台帳を変えて出たものだけ。
        seen = {"FLOW_DESTRUCTIVE_UNCONSTRAINED": ["F-071"]}
        spec = self._spec(args(), "3", answered="RS-001", ruled_at={"3": ["RS-001"], "3-settle-opens": ["RS-009"]},
                          verifier_fail={"3v-settle": [{"id": "RS-009", "kind": "value_as_method", "reason": "r"}], "3-settle-fixv": [{"id": "RS-009", "kind": "value_as_method", "reason": "r"}]},
                          questions_at={"3-settle-convert": ["RS-009"]})
        spec["flow_codes_at"] = {**spec["flow_codes_at"], "3-settle-convertv": seen}
        r = run(spec)
        self.assertNotIn("flow-check:3-settle-convert", r["labels"], "問いへの変換の後の verifier の stdout から次の回に渡す")
        self.assertIn("F-071: 縛る不変条件が無い", self._prompt(r, "planner:3-settle-2"))
        self.assertEqual(r["result"]["status"], "needs_answers", r["result"].get("reason"))
        self.assertEqual(r["result"]["question_ids"], ["RS-009"])

    def test_変換の後の指摘は符号によらずsettleのflow_framerに渡し表に無い符号では止める(self):
        # 変換の resolver は flow を書かないので、台帳を変えて出た指摘はどの符号でも flow-framer にしか直せない。
        # 段を出るときも settle の回の中と同じ規則で渡す（回答を当てた resolver が消せる符号でも止めない）。
        fail = [{"id": "RS-001", "kind": "insufficient_grounds", "reason": "r"}]
        # 過少申告: 変換の resolver の stdout は 0 件で、変換の後の verifier だけが見る。
        spec = {"args": args(), "flow_open": 1, "ruled_at": {"3": ["RS-001"], "3-fix": ["RS-001"]}, "verifier_fail": {"3v": fail, "3-fixv": fail},
                "questions_at": {"3-convert": ["RS-001"]}, "unverified_at": {"3-settle": ["F-002"]}}
        for said in ("申告どおり", "過少申告"):
            stages = ("3-convert", "3-convertv") if said == "申告どおり" else ("3-convertv",)
            with self.subTest(code="FLOW_DANGLING", said=said):
                code = {"FLOW_DANGLING": ["F-002"]}
                r = run({**spec, "flow_codes_at": {k: code for k in stages}})
                self.assertIn("F-002: FLOW_DANGLING", self._prompt(r, "planner:3-settle"))
                self.assertEqual(r["result"]["status"], "needs_answers", r["result"].get("reason"))
            with self.subTest(code="FLOW_NEW", said=said):
                code = {"FLOW_NEW": ["F-002"]}
                r = run({**spec, "flow_codes_at": {k: code for k in stages}})
                self.assertFalse(has(r["labels"], "planner:3-settle"), "誰が消せるか分からない符号は渡さない")
                self.assertEqual((r["result"]["status"], r["result"]["next_args"]), ("blocked", None))
                self.assertIn("直し手の表（FIXERS_BY_CODE）に無い符号があります: FLOW_NEW", r["result"]["reason"])

    def test_変換と問いの形の差し戻しの後はflow_checkを起動せず最後のresolverの申告と照合する(self):
        # 覆された決定は差し戻しの resolver（3-convert-questions）が書いた。変換の resolver の stdout と照合すると、正直な申告を
        # integrity に食い違いとして残す。照合の相手は変換の後の verifier の stdout で、settle はそこから 1 回だけ起動する。
        stale = [{"el": "F-002", "ref": "D-001"}]
        vam = [{"id": "RS-001", "kind": "value_as_method", "reason": "r"}]
        r = run({"args": args(), "flow_open": 1, "ruled_at": {"3": ["RS-001"], "3-fix": ["RS-001"]}, "verifier_fail": {"3v": vam, "3-fixv": vam},
                 "questions_at": {"3-convert": ["RS-001"]}, "bad_questions_at": ["3-convert"], "supersedes_at": {"3-convert-questions": ["D-001"]},
                 "stale_refs_at": {"3-convert-questions": stale, "3-convertv": stale}, "unverified_at": {"3-settle": ["F-002"]}})
        pre = r["labels"][: next(i for i, l in enumerate(r["labels"]) if l.startswith("writer:"))]
        self.assertEqual([l for l in pre if l.startswith("flow-check:")], ["flow-check:1-entry"])
        self.assertEqual([l for l in pre if l.startswith("planner:") and l != "planner:1"], ["planner:3-settle"])
        self.assertIn("F-002 ← D-001", self._prompt(r, "planner:3-settle"))
        self.assertEqual(r["result"]["integrity"], [])
        self.assertEqual(r["result"]["status"], "needs_answers", r["result"].get("reason"))

    def test_verifierを起動しない裁定の後もflow_checkのstdoutでsettleする(self):
        # 段 6 の resolver が検証する ID を返さなかった（対象を裁定し損ねた）ので verifier が起動しない。台帳は書いたので、flow-check が見る。
        spec = {"args": args(), "findings": {"wholeReviewer:r1": [{"id": "r1-wh-all-001", "route": "decision"}]},
                "flow_codes_at": {"6": self.DESTRUCTIVE}, "unverified_at": {"6-settle": ["F-053"]}}
        r = run(spec)
        labels = r["labels"]
        self.assertNotIn("verifier:6v", labels)
        self.assertEqual(labels[labels.index("resolver:6") + 1:][:3], ["flow-check:6", "planner:6-settle", "verifier:6v-settle"])
        self.assertIn("F-053: 縛る不変条件が無い", self._prompt(r, "planner:6-settle"))

    def test_変換で問いにもholdにも返らなかった裁定があれば止める(self):
        g1 = run({"args": args(), "findings": {"wholeReviewer:r1": [{"id": "r1-wh-all-001", "route": "decision"}]}, "questions_at": {"6": ["RS-010"]}})["result"]
        fail = {"id": "RS-009", "kind": "value_as_method", "reason": "r"}
        for name, kw in (("返さない", {"holds_at": {"3a'-settle-convert": []}}), ("裁定で返す", {"ruled_at": {"3a'": ["RS-010"], "3a'-settle-opens": ["RS-009"], "3a'-settle-convert": ["RS-009"]}}),
                         ("問いで返す", {"questions_at": {"3a'-settle-convert": ["RS-009"]}})):
            with self.subTest(settle=name):
                spec = {"answered": "RS-010", "ruled_at": {"3a'": ["RS-010"], "3a'-settle-opens": ["RS-009"]}, **kw}
                res = self._settle_fails(at_limit(g1["next_args"]), "3a'", fail, **spec)
                self.assertIn("resolver:3a'-settle-convert", res["labels"])
                self.assertFalse(has(res["labels"], "writer:"))
                r = res["result"]
                self.assertEqual((r["status"], r["next_args"]["from"]), ("blocked", "3a'"), r.get("reason"))
                self.assertIn("RS-009 を resolver が hold に返しませんでした", r["reason"], "聞ける回数を使い切った段の変換は hold だけを受け取る")
        rs = [{"id": "RS-001", "kind": "insufficient_grounds", "reason": "r"}]
        base = {"args": args(), "flow_open": 1, "ruled_at": {"3": ["RS-001"], "3-fix": ["RS-001"]}, "verifier_fail": {"3v": rs, "3-fixv": rs}}
        for name, kw in (("返さない", {"holds_at": {"3-convert": []}}), ("裁定で返す", {"ruled_at": {**base["ruled_at"], "3-convert": ["RS-001"]}})):
            with self.subTest(stage3=name):
                res = run({**base, **kw})
                self.assertFalse(has(res["labels"], "writer:"))
                r = res["result"]
                self.assertEqual((r["status"], r["next_args"]["from"]), ("blocked", "3"), r.get("reason"))
                self.assertIn("RS-001 を resolver が question にも hold にも返しませんでした", r["reason"])

    def test_変換の後のsettleに渡す閉じたOと覆された決定はverifierのstdoutから取る(self):
        rs = [{"id": "RS-001", "kind": "insufficient_grounds", "reason": "r"}]
        base = {"args": args(), "flow_open": 1, "ruled_at": {"3": ["RS-001", "RS-002"], "3-fix": ["RS-001"]}, "verifier_fail": {"3v": rs, "3-fixv": rs},
                "questions_at": {"3-convert": ["RS-001"]}, "unverified_at": {"3-settle": ["F-060"]}}
        for name, kw, line in (("open_only", {"open_only_at": {"3-fixv": [{"el": "F-060", "open": "O-RS-002"}], "3-convertv": [{"el": "F-060", "open": "O-RS-002"}]}}, "F-060（O-RS-002 ← RS-002）"),
                               ("stale_refs", {"stale_refs_at": {"3-fixv": [{"el": "F-060", "ref": "D-003"}], "3-convertv": [{"el": "F-060", "ref": "D-003"}]}}, "F-060 ← D-003")):
            with self.subTest(name):
                r = run({**base, **kw})
                self.assertIn("resolver:3-convert", r["labels"])
                self.assertIn(line, self._prompt(r, "planner:3-settle"))
                self.assertEqual(r["result"]["status"], "needs_answers", r["result"].get("reason"))
        r = self._settle_fails(args(), "3", {"id": "RS-009", "kind": "value_as_method", "reason": "r"}, answered="RS-001",
                               ruled_at={"3": ["RS-001"], "3-settle-opens": ["RS-009"]}, questions_at={"3-settle-convert": ["RS-009"]},
                               open_only_at={"3v-settle": [{"el": "F-060", "open": "O-RS-001"}], "3-settle-fixv": [{"el": "F-060", "open": "O-RS-001"}],
                                             "3-settle-convertv": [{"el": "F-060", "open": "O-RS-001"}]})
        self.assertIn("resolver:3-settle-convert", r["labels"])
        self.assertIn("F-060（O-RS-001 ← RS-001）", self._prompt(r, "planner:3-settle-2"))

    def test_重い段の経路でもlabelは重ならない(self):
        # telemetry と再開の照合は label で呼び出しを引くので、同じ段の中で label が重なると呼び出しを取り違える。
        # g1 の後の 3a は settle を回さず反映を 3b に渡すので、3a と 3b の label を合わせて見る。settle の label は聞ける段 3 で見る。
        g0 = run({"args": args(), "flow_open": 1, "questions_at": {"3": ["RS-001"]}})["result"]
        fail = [{"id": "RS-001", "kind": "value_as_method", "reason": "r"}]
        r = run(self._spec(
            g0["next_args"], "3a", answered="RS-001", framer="3b-reframe",
            ruled_at={"3a-fix": ["RS-001"], "3a-pairs": ["RS-002"], "3a-fix-pairs": ["RS-003"]}, free_text_at={"3a": ["RS-001"]},
            questions_at={"3a": ["RS-004"], "3a-fix": ["RS-005"], "3a-pairs": ["RS-006"], "3a-fix-pairs": ["RS-007"], "3a-convert": ["RS-001"], "3b": ["RS-009"]},
            bad_questions_at=["3a", "3a-fix", "3a-pairs", "3a-fix-pairs", "3a-convert", "3b"],
            verifier_fail={"3av": fail, "3a-fixv": fail},
            flow_sha_at={"3a": "f-3a", "3a-fix": "f-3a2"},
            pair_keys_at={"3a": ["pair:D-001|F-099"], "3a-fix": ["pair:D-001|F-099", "pair:D-002|F-098"]},
            about={"RS-002": {"pair": ["D-001", "F-099"]}, "RS-003": {"pair": ["D-002", "F-098"]}, "RS-009": {"open": "O-009"}},
            flow_codes_at={"3a": self.DESTRUCTIVE, "3a-fix": self.DESTRUCTIVE, "3av": self.DESTRUCTIVE, "3a-fixv": self.DESTRUCTIVE}))
        cycle = [l for l in r["labels"] if l.split(":")[0] in ("resolver", "verifier", "planner", "flow-check") and l.split(":")[1].startswith(("3a", "3b"))]
        for want in ("resolver:3a-pairs", "resolver:3a-fix-pairs", "resolver:3a-questions", "resolver:3a-fix-questions", "resolver:3a-pairs-questions",
                     "resolver:3a-convert-questions", "planner:3b", "resolver:3b-reframe-questions"):
            self.assertIn(want, cycle)
        self.assertFalse(any("settle" in l for l in cycle), cycle)
        self.assertEqual(len(cycle), len(set(cycle)), sorted(l for l in cycle if cycle.count(l) > 1))
        vam = [{"id": "RS-009", "kind": "value_as_method", "reason": "r"}]
        s3 = run(self._spec(args(), "3", answered="RS-001", questions_at={"3-settle-opens": ["RS-009"], "3-settle-convert": ["RS-009"]},
                            bad_questions_at=["3-settle-opens", "3-settle-convert"], verifier_fail={"3v-settle": vam, "3-settle-fixv": vam}))
        cycle = [l for l in s3["labels"] if l.split(":")[0] in ("resolver", "verifier", "planner", "flow-check") and ":" in l and l.split(":")[1].startswith("3")]
        for want in ("resolver:3-settle-questions", "resolver:3-settle-fix", "verifier:3-settle-fixv", "resolver:3-settle-convert", "resolver:3-settle-convert-questions"):
            self.assertIn(want, cycle)
        self.assertEqual(len(cycle), len(set(cycle)), sorted(l for l in cycle if cycle.count(l) > 1))


@unittest.skipIf(shutil.which("node") is None, "node が無い環境ではスキップする")
class DecidedNotHeld(unittest.TestCase):
    """入力・回答・合格した裁定で決まる論点と、依頼者に聞ける論点を保持規則にしない。"""

    STAGE6 = {
        "findings": {"writerReviewer:r1": [{"id": "r1-wr-all-001", "route": "decision"}]},
        "about": {"RS-020": {"finding": "r1-wr-all-001"}},
    }
    DECIDABLE = {"id": "RS-020", "kind": "decidable", "reason": "g1 の回答が同じ返し方を決めている", "source": "answers/g1.md#L3"}

    def _prompt(self, r, label):
        [p] = [x["prompt"] for x in r["prompts"] if x["label"] == label]
        return p

    def _at_limit6(self, **kw):
        # 聞ける回数を使い切った段 6（聞けない）が RS-020 を保持規則で返す。
        spec = {"args": args(), **self.STAGE6, "holds_at": {"6": ["RS-020"]}, **kw}
        return run({**spec, "args": stage6_at_limit(spec)})

    def test_聞ける段のsettleで根拠不足に落ちた裁定は1回差し戻しそれでも落ちれば問いにする(self):
        # 聞ける段の settle の verifier が insufficient_grounds で落とした裁定が、差し戻しの無いまま
        # 「hold（insufficient_grounds）」に変換され、変換の resolver が「この段では聞けない」と書いた。
        # g1 の後の 3a は settle を 3b に渡すので、同じ聞ける段の settle を段 3 で確かめる。
        fail = {"id": "RS-009", "kind": "insufficient_grounds", "reason": "input.md の L40 は O-009 を支えていない"}
        spec = {"args": args(), "flow_open": 1, "ruled_at": {"3": ["RS-001"], "3-settle-opens": ["RS-009"]},
                "flow_codes_at": {"3v": FlowFixerRoutes.DESTRUCTIVE}, "unverified_at": {"3-settle": ["F-053"]},
                "open_ids_at": {"3-settle": ["O-009"]}, "about": {"RS-009": {"open": "O-009"}}}
        fixed = run({**spec, "verifier_fail": {"3v-settle": [fail]}})
        labels = fixed["labels"]
        self.assertEqual(labels[labels.index("verifier:3v-settle") + 1:][:2], ["resolver:3-settle-fix", "verifier:3-settle-fixv"])
        fix = self._prompt(fixed, "resolver:3-settle-fix")
        self.assertIn("- RS-009: insufficient_grounds（input.md の L40 は O-009 を支えていない）", fix)
        self.assertIn("この段では依頼者に聞けるので、script が指定しない hold を作らない", fix)
        self.assertFalse(has(labels, "resolver:3-settle-convert"), "差し戻しで根拠を補えた裁定は変換しない")
        self.assertEqual(fixed["result"]["status"], "done", fixed["result"].get("reason"))
        self.assertNotIn("RS-009", fixed["result"]["holds"])
        failed = run({**spec, "verifier_fail": {"3v-settle": [fail], "3-settle-fixv": [fail]}, "questions_at": {"3-settle-convert": ["RS-009"]}})
        self.assertIn("- RS-009 → question（insufficient_grounds）", self._prompt(failed, "resolver:3-settle-convert"))
        res = failed["result"]
        self.assertEqual((res["status"], res["question_ids"]), ("needs_answers", ["RS-009"]), res.get("reason"))

    def test_上限の段6でdecidableに落ちた保持規則は差し戻しで決めて保持規則に残さない(self):
        r = self._at_limit6(verifier_fail={"6v": [self.DECIDABLE]})
        labels = r["labels"]
        self.assertEqual(labels[labels.index("verifier:6v") + 1:][:2], ["resolver:6-fix", "verifier:6-fixv"])
        fix = self._prompt(r, "resolver:6-fix")
        self.assertIn("- RS-020: decidable（g1 の回答が同じ返し方を決めている）（決める出典: answers/g1.md#L3）", fix)
        self.assertIn("decidable の項目は、その出典で値を決める", fix)
        self.assertFalse(has(labels, "resolver:6-fix-rehold"), "decidable は保持規則の文面の不合格ではないので書き直しに回さない")
        self.assertFalse(has(labels, "resolver:6-convert"))
        res = r["result"]
        self.assertEqual(res["status"], "done", res.get("reason"))
        self.assertNotIn("RS-020", res["holds"])
        [line] = [l for l in nth_prompt(r, "writer:U-1:revise", -1).split("\n") if l.startswith("- 根拠にしてよい resolution")]
        self.assertIn("RS-020", line)

    def test_差し戻しの後もdecidableに落ちれば聞くゲートが無い段では保持規則のまま変換を回さない(self):
        # 差し戻しは 1 回で、その verifier の不合格はもう差し戻さない（decidable と value_as_method の往復が起きない）。
        r = self._at_limit6(verifier_fail={"6v": [self.DECIDABLE], "6-fixv": [self.DECIDABLE]}, holds_at={"6": ["RS-020"], "6-fix": ["RS-020"]})
        labels = r["labels"]
        self.assertEqual(sum(l.startswith("resolver:6-fix") for l in labels), 1)
        self.assertFalse(has(labels, "resolver:6-convert"), "既に保持規則なので書き換えない")
        self.assertFalse(has(labels, "resolver:6-fix-rehold"))
        self.assertEqual(r["result"]["status"], "done", r["result"].get("reason"))
        self.assertIn("RS-020", r["result"]["holds"])

    def test_差し戻しの後もdecidableに落ちた問いは聞ける段では問いのまま聞く(self):
        fail = {"id": "RS-001", "kind": "decidable", "reason": "依頼文が決めている", "source": "input.md#L1"}
        r = run({"args": args(), "flow_open": 1, "questions_at": {"3": ["RS-001"], "3-fix": ["RS-001"]}, "verifier_fail": {"3v": [fail], "3-fixv": [fail]}})
        self.assertIn("resolver:3-fix", r["labels"])
        self.assertFalse(has(r["labels"], "resolver:3-convert"))
        res = r["result"]
        self.assertEqual((res["status"], res["question_ids"]), ("needs_answers", ["RS-001"]), res.get("reason"))

    def test_decidableの出典の書き方の揺れは揃えて受け取る(self):
        for src in ("/tmp/prd-w/answers/g1.md#L3", "W/answers/g1.md#L3", "answers/g1.md#L3-L5", "answers/g1.md#L3-5", "answers/g1.md:3", "answers/g1.md#l3",
                    "`answers/g1.md#L3`", "'answers/g1.md#L3'", '"answers/g1.md#L3"', "answers//g1.md#L3", "/tmp/prd-w//answers/g1.md#L3", "answers/g1.md#L03"):
            with self.subTest(src):
                r = self._at_limit6(verifier_fail={"6v": [{**self.DECIDABLE, "source": src}]})
                self.assertFalse(has(r["labels"], "verifier:6v-source"), "揃えれば受け取れるので聞き直さない")
                self.assertIn("（決める出典: answers/g1.md#L3）", self._prompt(r, "resolver:6-fix"))
                self.assertEqual(r["result"]["status"], "done", r["result"].get("reason"))
        self.assertIn("decidable の source の形（例）: `input.md#L12`", nth_prompt(r, "verifier:6v", 0))

    def test_固定の要求文書の行はdecidableの出典になり固定でない文書の行はならない(self):
        a = args(entry="existing", existing_docs=[{"key": "requirements/x", "fixed": False}, {"key": "requirements/a", "fixed": True}])
        r = self._at_limit6(args=a, verifier_fail={"6v": [{**self.DECIDABLE, "source": "W/requirements-a.md:40"}]})
        self.assertFalse(has(r["labels"], "verifier:6v-source"), "固定の要求文書の行は受け取れる")
        self.assertIn("（決める出典: requirements-a.md#L40）", self._prompt(r, "resolver:6-fix"))
        self.assertEqual(r["result"]["status"], "done", r["result"].get("reason"))
        hyphen = args(entry="existing", existing_docs=[{"key": "requirements/x", "fixed": False}, {"key": "requirements/research-rag", "fixed": True}])
        r = self._at_limit6(args=hyphen, verifier_fail={"6v": [{**self.DECIDABLE, "source": "requirements-research-rag.md#L3"}]})
        self.assertFalse(has(r["labels"], "verifier:6v-source"), "topic に - を含む固定の要求文書も受け取れる")
        bad = self._at_limit6(args=a, verifier_fail={"6v": [{**self.DECIDABLE, "source": "requirements-x.md#L40"}], "6v-source": [self.DECIDABLE]})
        self.assertIn("requirements-x.md#L40", self._prompt(bad, "verifier:6v-source"), "書き換えてよい文書の行は決める出典にならない")

    def test_固定の仕様書の行と仕様書を書くrunの現物の行はdecidableの出典になる(self):
        a = args(entry="existing", existing_docs=[{"key": "requirements/x", "fixed": False}, {"key": "specifications/a", "fixed": True}])
        r = self._at_limit6(args=a, verifier_fail={"6v": [{**self.DECIDABLE, "source": "specifications-a.md#L7"}]})
        self.assertFalse(has(r["labels"], "verifier:6v-source"), "固定の仕様書の行は受け取れる")
        repo = "/repo/src/holdings.py#L12"
        bad = self._at_limit6(args=a, verifier_fail={"6v": [{**self.DECIDABLE, "source": repo}], "6v-source": [self.DECIDABLE]})
        self.assertIn(repo, self._prompt(bad, "verifier:6v-source"), "要求文書だけを書く run では、現物の行は決める出典にならない")
        ok = self._at_limit6(units=[{"id": "U-1", "docs": ["requirements/x", "specifications/x"], "depends_on": []}], verifier_fail={"6v": [{**self.DECIDABLE, "source": repo}]})
        self.assertFalse(has(ok["labels"], "verifier:6v-source"), "仕様書を書く run では、実現の手段を定める現物の行を受け取る")
        self.assertIn(f"（決める出典: {repo}）", self._prompt(ok, "resolver:6-fix"))

    def test_揃えても受け取れないdecidableは同じverifierに1回だけ聞き直す(self):
        for name, fail, why in (
            ("出典なし", {k: v for k, v in self.DECIDABLE.items() if k != "source"}, "source（なし）"),
            ("出典の形の外（廃止したゲートの名前）", {**self.DECIDABLE, "source": "answers/g0.md#L3"}, "answers/g0.md#L3"),
            ("根拠にしてよくない RS", {**self.DECIDABLE, "source": "RS-999"}, "RS-999"),
            ("自分自身", {**self.DECIDABLE, "source": "RS-020"}, "RS-020"),
        ):
            with self.subTest(name):
                fixed = self._at_limit6(verifier_fail={"6v": [fail], "6v-source": [self.DECIDABLE]})
                self.assertIn(why, self._prompt(fixed, "verifier:6v-source"))
                self.assertIn("resolver:6-fix", fixed["labels"], "聞き直した返り値の decidable で差し戻す")
                self.assertEqual(fixed["result"]["status"], "done", fixed["result"].get("reason"))
                r = self._at_limit6(verifier_fail={"6v": [fail], "6v-source": [fail]})
                self.assertEqual(sum(l.startswith("verifier:6v-source") for l in r["labels"]), 1)
                res = r["result"]
                self.assertEqual((res["status"], res["next_args"]["from"]), ("blocked", "6"), res.get("reason"))
                self.assertIn("decidable が受け取れません", res["reason"])
                self.assertIn(why, res["reason"])
        valued = {"id": "RS-021", "kind": "decidable", "reason": "r", "source": "input.md#L1"}
        spec = {"args": args(), **self.STAGE6, "about": {"RS-021": {"finding": "r1-wr-all-001"}}, "ruled_at": {"6": ["RS-021"]}}
        res = run({**spec, "verifier_fail": {"6v": [valued], "6v-source": [valued]}})["result"]
        self.assertEqual(res["status"], "blocked", res.get("reason"))
        self.assertIn("RS-021 は回答待ちの問いでも保持規則でもない", res["reason"])
        self.assertEqual(run({**spec, "verifier_fail": {"6v": [valued]}})["result"]["status"], "done")

    def test_聞ける段でscriptの指定に無いholdは1回だけ問いに書き換え直させる(self):
        # 段 3 の裁定は planner:1 が返し、段 3 の takeRulings が resolver:1-toquestion に書き換え直させる（owner は 1）。
        for name, spec, frm, gate, gen, toq in (
            ("段 3", {"args": args(), "flow_open": 1, "holds_at": {"3": ["RS-001"]}}, "3", "3", "planner:1", "1-toquestion"),
            ("1 パス目の段 6", {"args": args(), "findings": {"wholeReviewer:r1": [{"id": "r1-wh-all-001", "route": "decision"}]},
                               "about": {"RS-010": {"finding": "r1-wh-all-001"}}, "holds_at": {"6": ["RS-010"]}}, "6", "6", "resolver:6", "6-toquestion"),
            # r2 の blocking の decision を裁定する延長の段 6（聞ける回数が残っている）。
            ("2 パス目の段 6", {"args": args(), "findings": {"writerReviewer:r1": [{"id": "r1-wr-all-001"}], "writerReviewer:r2": [{"id": "r2-wr-all-001", "route": "decision"}]},
                               "about": {"RS-020": {"finding": "r2-wr-all-001"}}, "holds_at": {"6": ["RS-020"]}}, "6", "6", "resolver:6", "6-toquestion"),
        ):
            with self.subTest(name):
                held = spec["holds_at"][gate][0]
                r = run(spec)
                labels = r["labels"]
                self.assertIn(gen, labels, r["result"].get("reason"))
                self.assertEqual(labels[labels.index(gen) + 1], f"resolver:{toq}")
                self.assertIn(f"- {held} → question", self._prompt(r, f"resolver:{toq}"))
                self.assertIn("script が指定しない hold を作らない", self._prompt(r, gen))
                res = r["result"]
                self.assertEqual((res["status"], res["question_ids"]), ("needs_answers", [held]), res.get("reason"))
                self.assertNotIn(held, res["next_args"]["state"].get("holds", []))
                stuck = run({**spec, "holds_at": {**spec["holds_at"], toq: [held]}})
                res = stuck["result"]
                self.assertEqual((res["status"], res["next_args"]["from"]), ("blocked", frm), res.get("reason"))
                self.assertIn("script が hold を指定していない", res["reason"])
                self.assertFalse([l for l in stuck["labels"] if l.startswith("verifier:") and l != "verifier:3v"], "受け取らずに止める")
        # 聞ける回数を使い切った段 6 は hold にしてよい。
        self.assertEqual(self._at_limit6()["result"]["status"], "done")

    def test_返り値に載せずに台帳に書いたholdも聞ける段では問いに書き換え直させる(self):
        # 3a（g1 の後）の resolver が RS-001 を候補の選択として返しながら、台帳には hold で書いた。
        g0 = run({"args": args(), "flow_open": 1, "questions_at": {"3": ["RS-001"]}})["result"]
        spec = {"args": g0["next_args"], "ruled_at": {"3a": ["RS-001"]}, "orphans_at": {"3a": ["RS-001"]}}
        r = run(spec)
        self.assertIn("- RS-001 → question", self._prompt(r, "resolver:3a-left-toquestion"))
        res = r["result"]
        self.assertEqual((res["status"], res["question_ids"]), ("needs_answers", ["RS-001"]), res.get("reason"))
        self.assertNotIn("RS-001", res["next_args"]["state"].get("holds", []))
        stuck = run({**spec, "holds_at": {"3a-left-toquestion": ["RS-001"]}})["result"]
        self.assertEqual((stuck["status"], stuck["next_args"]["from"]), ("blocked", "3a"), stuck.get("reason"))
        self.assertIn("問いに書き換え直させても hold のまま", stuck["reason"])
        # 書き換え直しを通らない経路があっても、段の出口で止める。
        patch = [("  const held = newHoldsInW(fc)\n", "  const held = []\n")]
        exit_ = run(spec, patch=patch)["result"]
        self.assertEqual((exit_["status"], exit_["next_args"]["from"]), ("blocked", "3a"), exit_.get("reason"))
        self.assertIn("script が hold を指定していない RS-001 を持ったまま段を出ようとしました", exit_["reason"])

    def test_依頼者が回答で保留を選んだholdは聞ける段でも問いに書き換え直させない(self):
        # g1 で RS-001 に「保留」と答えた依頼者に、3a の resolver が回答の行を引いて hold にした RS-001 を g2 で聞き直さない。
        # 保留かどうかは resolver の申告でなく、doc_check flow の answer_holds（台帳の evidence がその ID の回答の節を引く）で決める。
        g0 = run({"args": args(), "flow_open": 1, "questions_at": {"3": ["RS-001"]}})["result"]
        spec = {"args": g0["next_args"], "holds_at": {"3a": ["RS-001"]}}
        held = run({**spec, "answer_holds": ["RS-001"]})
        self.assertFalse([l for l in held["labels"] if l.endswith("-toquestion")], held["labels"])
        res = held["result"]
        self.assertEqual(res["status"], "done", res.get("reason"))
        self.assertIn("RS-001", res["holds"])
        # 回答の節を引かない hold（別の ID の回答の行を引いたものを含む）は、これまでどおり問いに書き換え直させて g2 で聞く。
        asked = run(spec)
        self.assertIn("resolver:3a-toquestion", asked["labels"])
        self.assertEqual((asked["result"]["status"], asked["result"]["question_ids"]), ("needs_answers", ["RS-001"]), asked["result"].get("reason"))
        # 返り値に載せずに台帳に書いた保留の hold も、段の途中と出口で問いに戻さない。
        orphan_spec = {"args": g0["next_args"], "ruled_at": {"3a": ["RS-001"]}, "orphans_at": {"3a": ["RS-001"]}, "answer_holds": ["RS-001"]}
        orphan = run(orphan_spec)
        self.assertFalse([l for l in orphan["labels"] if l.endswith("-toquestion")], orphan["labels"])
        self.assertEqual(orphan["result"]["status"], "done", orphan["result"].get("reason"))
        # 除外を外すと、返り値の hold も台帳にだけある hold も問いに書き換え直させる（除外が効いていることの確かめ）。
        unexempt = [(" || Boolean(fc && fc.answer_holds.some((x) => x.id === id))", "")]
        self.assertIn("resolver:3a-toquestion", run({**spec, "answer_holds": ["RS-001"]}, patch=unexempt)["labels"])
        self.assertIn("resolver:3a-left-toquestion", run(orphan_spec, patch=unexempt)["labels"])

    def test_resolverが保留のholdだと偽って申告しても台帳で決める(self):
        # 3a の resolver が、台帳では回答の節を引かない hold RS-001 を、stdout の answer_holds に載せて返した。早い書き換え直しは申告で飛ぶが、
        # 独立な doc_check flow（台帳）の answer_holds に無いので、W からの拾い直し（adopt）で問いに書き換え直させる。
        g0 = run({"args": args(), "flow_open": 1, "questions_at": {"3": ["RS-001"]}})["result"]
        r = run({"args": g0["next_args"], "holds_at": {"3a": ["RS-001"]}, "claimed_answer_holds_at": {"3a": ["RS-001"]}})
        res = r["result"]
        self.assertNotIn("resolver:3a-toquestion", r["labels"])
        self.assertNotIn("RS-001", res.get("holds") or [], (res["status"], res.get("reason"), r["labels"]))
        self.assertIn("resolver:3a-left-toquestion", r["labels"])
        self.assertEqual((res["status"], res["question_ids"]), ("needs_answers", ["RS-001"]), res.get("reason"))

    def test_依頼者の回答を根拠にしたholdの変換は出典で分ける(self):
        # g1 で答えた RS-001 を 3a が回答の節（answers/g1.md の 1 行目）を引いて hold にし、3av でも差し戻しの後の 3a-fixv でも decidable に落ちた。
        g0 = run({"args": args(), "flow_open": 1, "questions_at": {"3": ["RS-001"]}})["result"]

        def spec(source):
            fail = {"id": "RS-001", "kind": "decidable", "reason": "決まる", "source": source}
            return {"args": g0["next_args"], "holds_at": {"3a": ["RS-001"], "3a-fix": ["RS-001"]}, "answer_holds": ["RS-001"], "verifier_fail": {"3av": [fail], "3a-fixv": [fail]}}

        # 出典がほかの行なら、依頼者の保留を問いに戻さない（cycle の入口で問いだった ID でも）。
        other = spec("input.md#L1")
        r = run(other)
        self.assertFalse([l for l in r["labels"] if l.endswith(("-toquestion", "-convert"))], r["labels"])
        self.assertNotIn("RS-001", r["result"].get("question_ids") or [])
        self.assertIn("- RS-001 → question（decidable）", self._prompt(run(other, patch=[("allowQuestions && !answerHeld(f) && ", "allowQuestions && ")]), "resolver:3a-convert"))
        # 出典がその hold 自身の回答の節なら、回答は保留でなく実際の選択。差し戻しでも当てなかったので問いにする（hold のままだと回答が保持規則に化ける）。
        own = spec("answers/g1.md#L1")
        r = run(own)
        self.assertIn("- RS-001 → question（decidable）", self._prompt(r, "resolver:3a-convert"))
        self.assertIn("RS-001", r["result"]["question_ids"])
        self.assertFalse([l for l in run(own, patch=[(" && !answerChosen(f, seen)", "")])["labels"] if l.endswith("-convert")], "例外を外さないと hold のまま")

    def test_書き換え直しを写した返り値はほかの問いを残し同じIDを2つの種類に残さない(self):
        # planner:1 が RS-002 を問いに、RS-001 を指定の外の hold にした。書き換え直しは RS-001 だけを写す。
        r = run({"args": args(), "flow_open": 1, "questions_at": {"3": ["RS-002"]}, "holds_at": {"3": ["RS-001"]}})
        self.assertIn("questions --workspace /tmp/prd-w --ids RS-001,RS-002 --check", self._prompt(r, "resolver:1-toquestion"))
        self.assertNotIn("<question にした ID をカンマで>", self._prompt(r, "resolver:1-toquestion"))
        self.assertEqual(sorted(ids_of_verifier(r, "verifier:3v")), ["RS-001", "RS-002"], "写した返り値の問いを段の verifier に渡す")
        self.assertFalse([l for l in r["labels"] if l.endswith("-questions")], "写した返り値の問いは検査済みなので、W から拾い直さない")
        res = r["result"]
        self.assertEqual((res["status"], sorted(res["question_ids"])), ("needs_answers", ["RS-001", "RS-002"]), res.get("reason"))
        self.assertEqual(res["next_args"]["state"].get("holds", []), [])
        # 変換の種類の直しも同じ: RS-001（O-）は問いのまま、RS-005（検証の裁定）だけを hold に写す。
        f = [{"id": "F-003", "kind": "insufficient_grounds", "reason": "出典が無い"}]
        rs = [{"id": "RS-001", "kind": "insufficient_grounds", "reason": "r"}, {"id": "RS-005", "kind": "insufficient_grounds", "reason": "r"}]
        c = run({"args": args(), "flow_open": 1, "about": {"RS-005": {"verification": "F-003"}}, "ruled_at": {"3": ["RS-001"], "3-fix": ["RS-001", "RS-005"]},
                 "verifier_fail": {"3v": [rs[0], *f], "3-fixv": rs}, "questions_at": {"3-convert": ["RS-001", "RS-005"]}})
        self.assertIn("- RS-005 → hold", self._prompt(c, "resolver:3-convert-kind"))
        self.assertFalse([l for l in c["labels"] if l.endswith("-questions")], "写した返り値の問いは検査済みなので、W から拾い直さない")
        res = c["result"]
        self.assertEqual((res["status"], res["question_ids"], res["next_args"]["state"]["holds"]), ("needs_answers", ["RS-001"], ["RS-005"]), res.get("reason"))

    def test_書き換え直しでflowを変えたresolverは止める(self):
        r = run({"args": args(), "flow_open": 1, "holds_at": {"3": ["RS-001"]}, "resolver_claims_sha_at": {"1-toquestion": "f-other"}})["result"]
        self.assertEqual(r["status"], "blocked", r.get("reason"))
        self.assertIn("flow.json を変えました", r["reason"])

    def test_変換は指定した種類で返させる(self):
        # 検証の裁定（{verification}）の根拠不足は、聞ける段でも保持規則に変える（価値の論点ではない）。問いで返せば受け取らない。
        f = [{"id": "F-003", "kind": "insufficient_grounds", "reason": "出典が無い"}]
        rs = [{"id": "RS-005", "kind": "insufficient_grounds", "reason": "r"}]
        spec = {"args": args(), "about": {"RS-005": {"verification": "F-003"}}, "ruled_at": {"3-fix": ["RS-005"]}, "verifier_fail": {"3v": f, "3-fixv": f + rs}}
        held = run({**spec, "holds_at": {"3-convert": ["RS-005"]}})
        self.assertIn("- RS-005 → hold（insufficient_grounds）", self._prompt(held, "resolver:3-convert"))
        self.assertEqual(held["result"]["status"], "done", held["result"].get("reason"))
        swapped = run({**spec, "questions_at": {"3-convert": ["RS-005"]}})
        self.assertIn("- RS-005 → hold（insufficient_grounds）", self._prompt(swapped, "resolver:3-convert-kind"))
        self.assertEqual(swapped["result"]["status"], "done", swapped["result"].get("reason"))
        self.assertEqual(swapped["result"]["holds"], ["RS-005"])
        res = run({**spec, "questions_at": {"3-convert": ["RS-005"], "3-convert-kind": ["RS-005"]}})["result"]
        self.assertEqual((res["status"], res["next_args"]["from"]), ("blocked", "3"), res.get("reason"))
        self.assertIn("RS-005 を resolver が書き換え直しても指定と違う種類", res["reason"])

    def test_候補の選択として返した問いを台帳で問いでなくしていれば検証に回す(self):
        # 候補の選択は検証を飛ばして回答済みになる。台帳の上で問いでない裁定（answered_by など）に書き換えていれば、合否は持ち越されず
        # （doc_check の carriesVerdict）、verifyLeft が検証させる。stub では書き換えを返り値に載せない hold で作る。
        g0 = run({"args": args(), "flow_open": 1, "questions_at": {"3": ["RS-001"]}})["result"]
        r = run({"args": g0["next_args"], "ruled_at": {"3a": ["RS-001"]}, "orphans_at": {"3a": ["RS-001"]}})
        self.assertIn("RS-001", nth_prompt(r, "verifier:3av-left", 0).split("検証する resolution の ID:")[1].split("\n")[0])

    def test_検証し残しの拾い直しでdecidableに落ちた保持規則も1回差し戻す(self):
        # 返り値に載らなかった保持規則（W にだけある RS-001）を verifyLeft の verifier が拾い、決まる論点だと落とす。
        g0 = run({"args": args(), "flow_open": 1, "questions_at": {"3": ["RS-001"]}})["result"]
        fail = {"id": "RS-001", "kind": "decidable", "reason": "依頼文が決めている", "source": "input.md#L1"}
        r = run({"args": g0["next_args"], "ruled_at": {"3a": ["RS-001"]}, "orphans_at": {"3a": ["RS-001"]}, "verifier_fail": {"3av-left": [fail]}})
        labels = r["labels"]
        self.assertEqual(labels[labels.index("verifier:3av-left") + 1:][:2], ["resolver:3a-left-fix", "verifier:3a-left-fixv"])
        self.assertIn("- RS-001: decidable（依頼文が決めている）（決める出典: input.md#L1）", self._prompt(r, "resolver:3a-left-fix"))
        self.assertFalse(has(labels, "resolver:3a-left-convert"))
        self.assertNotIn("RS-001", r["result"]["holds"])
        self.assertEqual(r["result"]["status"], "done", r["result"].get("reason"))

    def test_聞ける段で差し戻しの後もdecidableに落ちた価値の論点の保持規則は問いにする(self):
        # 前の段から持ち越した保持規則 RS-050（O-050）を、g1 の後の 3a の入口の verifier が回答で決まると落とす。差し戻しでも保持規則のままなら、
        # 聞ける段なので問いにする（既に保持規則である ID を返すのは指定の外の新しい hold ではない）。
        g0 = run({"args": args(), "flow_open": 1, "questions_at": {"3": ["RS-001"]}})["result"]
        carried = {k: v for k, v in g0["next_args"].items() if k != "state_hash"}
        st = carried["state"]
        carried["state"] = {**st, "holds": [*st.get("holds", []), "RS-050"], "about": {**st["about"], "RS-050": "open:O-050"}}
        nargs = {**carried, "state_hash": value(f"nextArgsHash({json.dumps(carried, ensure_ascii=False)})")}
        fail = {"id": "RS-050", "kind": "decidable", "reason": "g1 の回答で決まる", "source": "answers/g1.md#L1"}
        r = run({"args": nargs, "ruled_at": {"3a": ["RS-001"]}, "holds_at": {"3a-entry-fix": ["RS-050"]},
                 "verifier_fail": {"3av-entry": [fail], "3a-entry-fixv": [fail]}})
        self.assertFalse([l for l in r["labels"] if l.endswith("-toquestion")], "既に保持規則の ID は指定の外の新しい hold ではない")
        self.assertIn("- RS-050 → question（decidable）", self._prompt(r, "resolver:3a-entry-convert"))
        self.assertIn("RS-050", r["result"]["question_ids"])

    def test_既にある回答を当てた裁定は候補の選択と違い検証しmappingで落ちれば差し戻す(self):
        # g1 の後の 3a: RS-001 は候補の選択（検証を飛ばす）、RS-021 は RS-001 の回答を新しい論点に当てた answered_by。
        g0 = run({"args": args(), "flow_open": 1, "questions_at": {"3": ["RS-001"]}})["result"]
        mapping = {"id": "RS-021", "kind": "mapping", "reason": "answers/g1.md の L3 は別の問いへの答え"}
        spec = {"args": g0["next_args"], "about": {"RS-021": {"tbd": "TBD-X-021"}}, "ruled_at": {"3a": ["RS-001", "RS-021"]}, "answered_by_at": {"3a": ["RS-021"]}}
        r = run(spec)
        self.assertEqual(ids_of_verifier(r, "verifier:3av"), ["RS-021"], "回答の当たった問いでない answered_by は検証を飛ばさない")
        self.assertEqual([x["ruling"] for x in r["disk"]["resolutions"] if x["id"] == "RS-021"], ["answered_by"])
        [line] = [l for l in nth_prompt(r, "writer:U-1:draft", 0).split("\n") if l.startswith("- 根拠にしてよい resolution")]
        self.assertIn("RS-021", line)
        failed = run({**spec, "verifier_fail": {"3av": [mapping], "3a-fixv": [mapping]}, "answered_by_at": {"3a": ["RS-021"], "3a-fix": ["RS-021"]}})
        self.assertIn("- RS-021: mapping（answers/g1.md の L3 は別の問いへの答え）", self._prompt(failed, "resolver:3a-fix"))
        self.assertIn("- RS-021 → question（mapping）", self._prompt(failed, "resolver:3a-convert"))

    def test_聞ける段でも落ちた要素の検証の裁定は保持規則にでき書き直しも回る(self):
        # 検証の裁定（{verification}）は価値の論点ではないので、差し戻しで hold にしてよく（script が指定する）、落ちれば書き直させる。
        f = [{"id": "F-003", "kind": "insufficient_grounds", "reason": "出典が無い"}]
        rs = [{"id": "RS-005", "kind": "insufficient_grounds", "reason": "保持規則が触れる項目が無い"}]
        r = run({"args": args(), "about": {"RS-005": {"verification": "F-003"}}, "holds_at": {"3-fix": ["RS-005"]}, "verifier_fail": {"3v": f, "3-fixv": rs}})
        self.assertIn("resolver:3-fix-rehold", r["labels"])
        self.assertEqual((r["result"]["status"], r["result"]["holds"]), ("done", ["RS-005"]), r["result"].get("reason"))

    def test_検証の裁定の保持規則はdecidableで落ち続けても聞ける段で問いにしない(self):
        # 落ちた要素の扱いは価値の論点ではないので、依頼者に問いとして出さない。
        f = [{"id": "F-003", "kind": "insufficient_grounds", "reason": "出典が無い"}]
        dec = [{"id": "RS-005", "kind": "decidable", "reason": "依頼文が決めている", "source": "input.md#L1"}]
        r = run({"args": args(), "about": {"RS-005": {"verification": "F-003"}}, "holds_at": {"3-fix": ["RS-005"]}, "verifier_fail": {"3v": f, "3-fixv": dec}})
        self.assertFalse(has(r["labels"], "resolver:3-convert"))
        self.assertEqual((r["result"]["status"], r["result"]["holds"]), ("done", ["RS-005"]), r["result"].get("reason"))

    def test_1パス目の段6の検証の裁定のholdは段7のwriterに渡る(self):
        f = [{"id": "F-003", "kind": "insufficient_grounds", "reason": "出典が無い"}]
        r = run({"args": args(), "findings": {"wholeReviewer:r1": [{"id": "r1-wh-all-001", "route": "decision"}]},
                 "about": {"RS-010": {"finding": "r1-wh-all-001"}, "RS-005": {"verification": "F-003"}},
                 "ruled_at": {"6": ["RS-010"]}, "holds_at": {"6-fix": ["RS-005"]}, "verifier_fail": {"6v": f}})
        self.assertEqual((r["result"]["status"], r["result"]["holds"]), ("done", ["RS-005"]), r["result"].get("reason"))
        [line] = [l for l in nth_prompt(r, "writer:U-1:revise", 0).split("\n") if l.startswith("- 保持規則として")]
        self.assertIn("RS-005", line)


@unittest.skipIf(shutil.which("node") is None, "node が無い環境ではスキップする")
class FindingRoutes(unittest.TestCase):
    """前のパスの指摘の受け渡し・direction の逆転・指摘の由来層（origin）の経路。"""

    ITEM = "PR-X-001"

    def _prompt(self, r, label):
        return next(p["prompt"] for p in r["prompts"] if p["label"] == label)

    LAST = MAX_AUDIT_PASSES + 1

    def _reversal(self, last_direction, last_blocking=True):
        # PR-X-001 への指摘は r1 では blocking にせず再発（両パスで blocking）と分け、パスは毎回別の項目の blocking で進める。
        # 最後の監査 r<LAST> だけが向きを last_direction にし、blocking を last_blocking にする。
        findings = {f"writerReviewer:r{k}": [{"id": f"r{k}-wr-all-001", "direction": "tighten" if k < self.LAST else last_direction, "blocking": k == self.LAST and last_blocking},
                                             {"id": f"r{k}-wr-all-{k + 1:03d}", "item_id": f"PR-X-{k + 1:03d}"}] for k in range(1, self.LAST + 1)}
        return run({"args": args(), "findings": findings})

    def test_前のパスと逆向きの指摘はdecisionになり裁定に届く(self):
        # 最後の監査の後の逆向きの blocking の指摘は、延長の段 6 が裁定しなければ、輪を出た後の resolver に届く。
        last = f"r{self.LAST}-wr-all-001"
        r = self._reversal("relax")
        self.assertIn(f"route が decision の指摘 {last}", self._prompt(r, "resolver:final"))
        same = self._reversal("tighten")
        self.assertFalse(has(same["labels"], "resolver:6"))
        self.assertNotIn(last, self._prompt(same, "resolver:final"))

    def test_2パス目の段6に前のパスと逆向きの指摘が届く(self):
        # r1 に向きのある指摘、r2 に逆向きの blocking の指摘を置くと、2 パス目（延長）の段 6 に decision として届く。
        last = f"r{self.LAST}-wr-all-001"
        relax = self._reversal("relax")
        self.assertTrue(has(relax["labels"], "resolver:6"), relax["result"].get("reason"))
        self.assertIn(f"route が decision の指摘 {last}", self._prompt(relax, "resolver:6"))
        self.assertFalse(has(self._reversal("tighten")["labels"], "resolver:6"))
        # blocking でない逆向きの指摘は、延長の段 6 にも輪を出た後の resolver にも渡らず、本文に反映していない指摘に残る。
        low = self._reversal("relax", last_blocking=False)
        self.assertFalse(has(low["labels"], "resolver:6"))
        self.assertNotIn(last, self._prompt(low, "resolver:final"))
        self.assertIn(last, low["result"]["unreflected"])

    def test_改稿で当て損ねた指摘は持ち越して上限で輪を出たらcarried_blockingに載る(self):
        findings = new_item_each_round(MAX_AUDIT_PASSES + 1)
        # 最後のパスの改稿が r<MAX_AUDIT_PASSES> の指摘を当て損ねると、持ち越した指摘は再発して decision に回る。延長の段 6 が問いを出さないので
        # 段 7 へ進まず、持ち越したまま輪を出る。
        missed = findings[f"writerReviewer:r{MAX_AUDIT_PASSES}"][0]["id"]
        res = run({"args": args(), "findings": findings, "unapplied_seq": [[]] * (MAX_AUDIT_PASSES - 1) + [[missed]]})["result"]
        self.assertEqual((res["status"], res["stop_reason"]), ("blocked", "pass_limit"), res.get("reason"))
        self.assertEqual(res["carried_blocking"], [missed])

    def test_段8の監査に同じ項目への前のパスの指摘のIDが入る(self):
        r = self._reversal("relax")
        for k in range(2, self.LAST + 1):
            self.assertIn(f"この文書への前のパスの指摘（範囲の項目のものを照らす）: r{k - 1}-wr-all-001", self._prompt(r, f"writerReviewer:r{k}:all"))
        self.assertNotIn("前のパスの指摘", self._prompt(r, "writerReviewer:r1:all"))

    def test_申告に無い項目への前のパスの指摘も段8のwriter_reviewerに届く(self):
        # 申告に無い変更は writer reviewer が diff で読むまで script に分からないので、組の文書の前の指摘を申告の項目に絞らずに渡す。
        r = run({"args": args(), "writer_changed": ["PR-X-001"],
                 "findings": {"writerReviewer:r1": [{"id": "r1-wr-all-001"},
                                                   {"id": "r1-wr-all-002", "item_id": "PR-X-002"}]}})
        self.assertIn("r1-wr-all-002", nth_prompt(r, "writerReviewer:r2:all", 0))

    def test_改稿のwriterに項目のtraceが指すflow要素のIDを渡す(self):
        r = run({"args": args(), "doc_flow_refs": {"requirements/x": {"PR-X-001": ["F-011", "F-010"]}, "requirements/y": {"PR-X-002": ["F-099"]}},
                 "findings": {"writerReviewer:r1": [{"id": "r1-wr-all-001"},
                                                 {"id": "r1-wr-all-002", "item_id": "PR-X-002"}]}})
        revise = self._prompt(r, "writer:U-1:revise")
        self.assertIn("- requirements/x PR-X-001: r1-wr-all-001（trace が指す flow 要素: F-010, F-011）", revise)
        self.assertIn("- requirements/x PR-X-002: r1-wr-all-002\n", revise, "別の文書の同じ項目 ID の要素は渡さない")
        self.assertNotIn("F-099", revise)
        none = self._prompt(run({"args": args(), "findings": {"writerReviewer:r1": [{"id": "r1-wr-all-001"}]}}), "writer:U-1:revise")
        self.assertNotIn("flow 要素", none, "flow_refs の無い項目では行を出さない")

    FLOW_FINDING = "r1-wr-all-001"

    def _flow_finding(self, **kw):
        spec = {"args": args(), "findings": {"writerReviewer:r1": [{"id": self.FLOW_FINDING, "route": "writer", "origin": "flow"}]},
                "ruled_at": {"6": ["RS-011"]}, "about": {"RS-011": {"finding": self.FLOW_FINDING}}, "unverified_at": {"6-settle": ["F-010"]}}
        spec.update(kw)
        return run(spec)

    def test_originがflowの指摘はwriterの束に入らず段6に届く(self):
        r = self._flow_finding()
        self.assertIn(f"route が decision の指摘 {self.FLOW_FINDING}", self._prompt(r, "resolver:6"))
        self.assertNotIn(self.FLOW_FINDING, self._prompt(r, "writer:U-1:revise"))
        self.assertEqual(r["result"]["status"], "done", r["result"].get("reason"))

    def test_originがflowの指摘の裁定はsettleでflowに写し変わった要素を検証する(self):
        r = self._flow_finding()
        settle = [l for l in r["labels"] if "settle" in l]
        self.assertEqual(settle, ["planner:6-settle", "verifier:6v-settle"], "閉じた O- が無くても起動する")
        self.assertIn(f"{self.FLOW_FINDING}（← RS-011）", self._prompt(r, "planner:6-settle"))
        judged_by(self, r, "verifier:6v-settle", "F-010")
        fail = [{"id": "F-010", "kind": "insufficient_grounds", "reason": "出典が無い"}]
        failed = self._flow_finding(verifier_fail={"3v": fail, "3-fixv": fail}, holds_at={"3-fix": ["RS-005"]},
                                    about={"RS-011": {"finding": self.FLOW_FINDING}, "RS-005": {"verification": "F-010"}})
        judged_by(self, failed, "verifier:6v-settle", "F-010")  # 検証に落ちた要素でも、指摘から直させて書き換えれば検証する
        text = run({**{"args": args()}, "findings": {"writerReviewer:r1": [{"id": self.FLOW_FINDING, "route": "decision", "origin": "text"}]},
                    "ruled_at": {"6": ["RS-011"]}, "about": {"RS-011": {"finding": self.FLOW_FINDING}}})
        self.assertFalse(has(text["labels"], "planner:6-settle"), "origin が text の指摘の裁定は flow に写さない")

    def test_段6のゲートの後の3aでは段6で写した指摘を写し直さない(self):
        g1 = self._flow_finding(questions_at={"6": ["RS-012"]})
        self.assertEqual(g1["result"]["status"], "needs_answers")
        self.assertIn("planner:6-settle", g1["labels"])
        r = run({"args": g1["result"]["next_args"], "ruled_at": {"3a'": ["RS-012"]}, "about": {"RS-011": {"finding": self.FLOW_FINDING}}})
        self.assertFalse(has(r["labels"], "planner:3a'-settle"))
        self.assertEqual(r["result"]["status"], "done", r["result"].get("reason"))

    def test_監査役の返り値のスキーマはdirectionとoriginを契約の値に絞る(self):
        item = run({"args": args()})["auditSchema"]["properties"]["findings"]["items"]
        self.assertEqual(sorted(item["properties"]["direction"]["enum"]), contract_values("direction"))
        self.assertEqual(sorted(item["properties"]["origin"]["enum"]), contract_values("origin"))
        self.assertLessEqual({"direction", "origin"}, set(item["required"]))


@unittest.skipIf(shutil.which("node") is None, "node が無い環境ではスキップする")
class PlannerLint(unittest.TestCase):
    """flow --lint は flow を起草する planner（planner:1・planner:3b）だけが自分のループで使う。返った stdout に lint が残れば、flow の指摘と
    一緒の 1 回の差し戻し（<label>:rework）に入り、それでも残れば notices に出して進む。控え（stash・unstash）は取らず、差し戻しで flow が
    閉じなくなれば段は止まる（設計 3.3a・6.4）。verifier・flow-check・settle・監査役の stdout と止まり方は変えない。"""

    SETTLE = {"flow_open": 1, "ruled_at": {"3": ["RS-001"]}, "open_only_at": {"3v": [{"el": "F-091", "open": "O-RS-001"}]}}
    LINT_COPY = re.compile(r"flow-check:.+-lint-(?:stash|unstash)")

    def _prompt(self, r, label):
        return next(p["prompt"] for p in r["prompts"] if p["label"] == label)

    def test_lintが残ったplanner_1は1回だけ差し戻し残ればnoticesに出して進む(self):
        plain = run({"args": args()})
        fixed = run({"args": args(), "lint_at": {"framer": 2}})
        self.assertEqual(plain["labels"][1], "planner:1")
        self.assertEqual(fixed["labels"], plain["labels"][:2] + ["planner:1:rework"] + plain["labels"][2:])
        self.assertIn("lint が 2 件", self._prompt(fixed, "planner:1:rework"))
        self.assertIn("「流れ」から直して返す", self._prompt(fixed, "planner:1:rework"), "lint だけが落ちたときは流れから直す")
        for key in ("status", "notices", "integrity"):
            self.assertEqual(fixed["result"][key], plain["result"][key], key)
        left = run({"args": args(), "lint_at": {"framer": 2, "rework": 1}})
        self.assertEqual(left["labels"], fixed["labels"], "差し戻しは 1 回きり")
        self.assertFalse([l for l in left["labels"] if self.LINT_COPY.fullmatch(l)], "控えの flow-check は起動しない")
        self.assertEqual(left["result"]["status"], "done", "lint は段を止めない")
        self.assertEqual(len(left["result"]["notices"]), 1)
        self.assertIn("1 件", left["result"]["notices"][0])
        self.assertIn("planner:1", left["result"]["notices"][0])

    def test_lintの欄の無いstdoutも1回だけ差し戻す(self):
        r = run({"args": args(), "lint_at": {"framer": None, "rework": None}})
        self.assertEqual(r["labels"].count("planner:1:rework"), 1)
        self.assertIn("lint の欄が無い", self._prompt(r, "planner:1:rework"))
        self.assertEqual(r["result"]["status"], "done")
        self.assertIn("lint の欄が無い", r["result"]["notices"][0])

    def test_lintの差し戻しでflowが閉じなくなれば戻さずに段1で止まる(self):
        # 設計 6.4: 控えに戻す経路（stash・unstash）を消したので、差し戻しで壊れた flow は blocked で止める。
        for findings in ({"rework": 1}, {"rework": 3}):
            with self.subTest(findings=findings):
                r = run({"args": args(), "lint_at": {"framer": 1}, "flow_findings_at": findings})
                self.assertEqual(r["labels"], ["flow-check:1-entry", "planner:1", "planner:1:rework"])
                res = r["result"]
                self.assertEqual((res["status"], res["next_args"]["from"], res["next_args"]["state"]), ("blocked", "1", {}), res.get("reason"))
                self.assertFalse([l for l in r["labels"] if self.LINT_COPY.fullmatch(l)])

    def test_lintを指示するのは起草のplannerとwriterだけ(self):
        r = run({"args": args(), **self.SETTLE, "lint_at": {"framer": 1}, "open_ids_at": {"rework": ["O-RS-001"]}})
        self.assertIn("planner:3-settle", r["labels"])
        with_lint = sorted({p["label"] for p in r["prompts"] if "--lint" in p["prompt"]})
        self.assertEqual(with_lint, ["planner:1", "planner:1:rework", "writer:U-1:draft"])
        g0 = run({"args": args(), "flow_open": 1, "questions_at": {"3": ["RS-001"]}})["result"]
        g02 = run({"args": g0["next_args"], "ruled_at": {"3a": ["RS-001"]}, "lint_at": {"3b-reframe": 1}})
        same = run({"args": g0["next_args"], "ruled_at": {"3a": ["RS-001"]}})
        added = ["planner:3b:rework"]
        self.assertEqual([l for l in g02["labels"] if l in added], added)
        self.assertEqual([l for l in g02["labels"] if l not in added], same["labels"])
        for key in ("status", "notices", "integrity"):
            self.assertEqual(g02["result"][key], same["result"][key], key)
        self.assertIn("--lint", self._prompt(g02, "planner:3b"))
        self.assertEqual([p["label"] for p in g02["prompts"] if "--lint" in p["prompt"] and p["label"].startswith(("verifier", "flow-check", "resolver"))], [])

    def test_3bのplannerのlintが残れば1回だけ差し戻しnoticesに出して進む(self):
        g0 = run({"args": args(), "flow_open": 1, "questions_at": {"3": ["RS-001"]}})["result"]
        r = run({"args": g0["next_args"], "ruled_at": {"3a": ["RS-001"]}, "lint_at": {"3b-reframe": 1, "3b-reframe-rework": 1}})
        self.assertEqual(r["labels"].count("planner:3b:rework"), 1)
        self.assertEqual(r["result"]["status"], "done", r["result"].get("reason"))
        self.assertEqual(len([n for n in r["result"]["notices"] if "planner:3b" in n and "1 件" in n]), 1, r["result"]["notices"])

    def test_lintを付けて実行したresolverのstdoutは申告の食い違いにしない(self):
        findings = new_item_each_round(MAX_AUDIT_PASSES + 1)
        r = run({"args": args(), "findings": findings, "resolver_lint_at": ["final"]})["result"]
        self.assertEqual((r["status"], r["integrity"]), ("blocked", []))

    def test_settleのplannerにはlintを指示しない(self):
        r = run({"args": args(), **self.SETTLE})
        self.assertNotIn("--lint", self._prompt(r, "planner:3-settle"))
        self.assertEqual(r["result"]["status"], "done")


@unittest.skipIf(shutil.which("node") is None, "node が無い環境ではスキップする")
class Reframe(unittest.TestCase):
    """g1 の回答で flow を組み直す段 3b と、追加の問いを g2 の 1 回に集める経路（A5）。"""

    def _g0(self, **kw):
        return run({"args": args(), "flow_open": 1, "questions_at": {"3": ["RS-001"]}, **kw})["result"]

    def _prompt(self, r, label):
        return next(p["prompt"] for p in r["prompts"] if p["label"] == label)

    def _cycle(self, labels):
        return [l for l in labels if l.startswith(("resolver:", "verifier:", "planner"))]

    def test_g1からg2を経て初稿に進む(self):
        g02 = run({"args": self._g0()["next_args"], "ruled_at": {"3a": ["RS-001"]}, "questions_at": {"3a": ["RS-002"]}})
        self.assertEqual(self._cycle(g02["labels"]), ["resolver:3a", "verifier:3av", "planner:3b", "verifier:3bv"], "3a で出た新しい問いは検証する")
        res = g02["result"]
        self.assertEqual((res["status"], res["answers_path"], res["next_args"]["from"]), ("needs_answers", "/tmp/prd-w/answers/g2.md", "3a"))
        r = run({"args": res["next_args"], "ruled_at": {"3a": ["RS-002"]}})
        self.assertEqual(self._cycle(r["labels"]), ["resolver:3a"], "g2 の回答の後は組み直さない")
        self.assertEqual(r["labels"][2:4], ["flow-check:3a", "writer:U-1:draft"], "入口の flow-check が回答のファイルも確かめ、本文の控えは writer が取る")
        writer_backup(self, r, "writer:U-1:draft", ["requirements/x"])
        self.assertEqual(r["result"]["status"], "done")

    def test_持ち越した問いだけでも3bはplannerとverifierの2体でskippedに載せない(self):
        # 設計 6.3 の 9: 持ち越した問いだけ（組も O- も無い）なら planner:3b が裁定せずに返し、問いは次のゲートで聞く。外した agent は無い。
        r = run({"args": self._g0()["next_args"], "ruled_at": {"3a": ["RS-001"]}, "questions_at": {"3a": ["RS-002"]}, "unverified_at": {"3b-reframe": ["F-040"]}})
        self.assertEqual([l for l in self._cycle(r["labels"]) if ":3b" in l], ["planner:3b", "verifier:3bv"])
        self.assertFalse(has(r["labels"], "resolver:3b"))
        self.assertFalse(has(r["labels"], "flow-framer"))
        judged_by(self, r, "verifier:3bv", "F-040")
        res = r["result"]
        self.assertEqual((res["status"], res["question_ids"]), ("needs_answers", ["RS-002"]), res.get("reason"))
        self.assertEqual(res["skipped"], [])

    def test_opensか組はplanner_3bが裁定し漏らした分だけ保険のresolver_3bに回す(self):
        for issue, about in (({"open_ids_at": {"3b-reframe": ["O-020"]}}, {"open": "O-020"}), ({"pair_keys_at": {"3b-reframe": ["pair:D-010|F-035"]}}, {"pair": ["D-010", "F-035"]})):
            base = {"args": self._g0()["next_args"], "ruled_at": {"3a": ["RS-001"], "3b": ["RS-020"]}, "questions_at": {"3a": ["RS-002"]}, "about": {"RS-020": about}, **issue}
            with self.subTest(issue=issue, left=False):
                r = run(base)
                self.assertFalse(has(r["labels"], "resolver:3b"), "planner:3b が同じ体で裁定する")
                self.assertIn("RS-020", ids_of_verifier(r, "verifier:3bv"))
                self.assertEqual(r["result"]["skipped"], [])
            with self.subTest(issue=issue, left=True):
                r = run({**base, "planner_leaves_at": {"3b": ["RS-020"]}})
                self.assertEqual([l for l in self._cycle(r["labels"]) if ":3b" in l], ["planner:3b", "resolver:3b", "verifier:3bv"])
                self.assertIn("RS-020", ids_of_verifier(r, "verifier:3bv"))
                self.assertEqual(r["result"]["skipped"], [])

    def test_持ち越した問いは組み直したflowで問いの形を検査する(self):
        spec = {"args": self._g0()["next_args"], "ruled_at": {"3a": ["RS-001"]}, "questions_at": {"3a": ["RS-002"]}}
        r = run(spec)
        self.assertIn("--ids RS-002 --check", self._prompt(r, "planner:3b"))
        self.assertFalse(has(r["labels"], "resolver:3b-reframe-questions"))
        fixed = run({**spec, "bad_questions_at": ["3b-reframe"]})
        self.assertIn("--ids RS-002 --check", self._prompt(fixed, "resolver:3b-reframe-questions"))
        self.assertEqual((fixed["result"]["status"], fixed["result"]["question_ids"]), ("needs_answers", ["RS-002"]))
        broken = run({**spec, "bad_questions_at": ["3b-reframe", "3b-reframe-questions"]})["result"]
        self.assertEqual((broken["status"], broken["next_args"]["from"]), ("blocked", "3b"))
        # 保険の resolver:3b が起動しても、持ち越しの問いは planner:3b の 1 回の検査が見たので、保険の後に検査し直させない。
        paired = run({**spec, "pair_keys_at": {"3b-reframe": ["pair:D-010|F-035"]}, "ruled_at": {"3a": ["RS-001"], "3b": ["RS-021"]},
                      "about": {"RS-021": {"pair": ["D-010", "F-035"]}}, "planner_leaves_at": {"3b": ["RS-021"]}})
        self.assertIn("resolver:3b", paired["labels"])
        self.assertNotIn("RS-002", self._prompt(paired, "resolver:3b"), "保険の task は open と組だけ")
        self.assertEqual(paired["result"]["question_ids"], ["RS-002"])

    def test_3aの問いと3bの問いを1回のg2で聞く(self):
        r = run({"args": self._g0()["next_args"], "ruled_at": {"3a": ["RS-001"]}, "questions_at": {"3a": ["RS-002"], "3b": ["RS-003"]},
                 "about": {"RS-003": {"pair": ["D-010", "F-035"]}}, "pair_keys_at": {"3b-reframe": ["pair:D-010|F-035"]}})
        self.assertNotIn("resolver:3a-hold", r["labels"])
        self.assertIn("RS-002", self._prompt(r, "planner:3b"), "持ち越した問いは planner:3b が扱う")
        self.assertFalse(has(r["labels"], "resolver:3b"))
        self.assertIn("根拠にしてよい resolution（合格・回答済み）: RS-001\n", self._prompt(r, "planner:3b"), "回答待ちの RS-002 は出典にさせない")
        self.assertEqual((r["result"]["status"], r["result"]["question_ids"]), ("needs_answers", ["RS-002", "RS-003"]))

    def test_3bで決まった問いはg2で聞かない(self):
        spec = {"args": self._g0()["next_args"], "ruled_at": {"3a": ["RS-001"], "3b": ["RS-002", "RS-005"]}, "questions_at": {"3a": ["RS-002"]},
                "about": {"RS-005": {"pair": ["D-010", "F-035"]}}, "pair_keys_at": {"3b-reframe": ["pair:D-010|F-035"]}}
        r = run(spec)
        self.assertIn("RS-002", self._prompt(r, "verifier:3bv").split("検証する resolution の ID:")[1].split("\n")[0])
        self.assertEqual(r["result"]["status"], "done")
        both = run({**spec, "questions_at": {"3a": ["RS-002"], "3b": ["RS-003"]}})["result"]
        self.assertEqual(both["question_ids"], ["RS-003"])

    def test_3bで問いが0件ならg2を出さない(self):
        r = run({"args": self._g0()["next_args"], "ruled_at": {"3a": ["RS-001"]}})
        self.assertNotIn("resolver:3b", r["labels"])
        self.assertEqual(r["result"]["status"], "done")
        self.assertEqual([x for x in r["result"]["skipped"] if x["step"] == "resolver:3b"], [], "持ち越した問いが無ければ外したことにしない")

    def test_上限に達した後の3aで出た問いは保持規則になる(self):
        g02 = run({"args": self._g0()["next_args"], "ruled_at": {"3a": ["RS-001"]}, "questions_at": {"3a": ["RS-002"]}})["result"]
        r = run({"args": at_limit(g02["next_args"]), "ruled_at": {"3a": ["RS-002"]}, "questions_at": {"3a": ["RS-003"]}})
        self.assertIn(f"{LIMIT_WHY}ので、価値に関わる新しい矛盾は hold にする", self._prompt(r, "resolver:3a"))
        self.assertIn(f"次の問いは依頼者に聞かない（{LIMIT_WHY}）", self._prompt(r, "resolver:3a-hold"))
        self.assertIn("resolver:3a-hold", r["labels"])
        self.assertFalse(has(r["labels"], "planner:3b"))
        self.assertEqual(r["result"]["status"], "done")
        self.assertIn("RS-003", r["result"]["holds"])

    def test_回答の後の保持規則への変換で覆された決定もsettleで直す(self):
        g02 = run({"args": self._g0()["next_args"], "ruled_at": {"3a": ["RS-001"]}, "questions_at": {"3a": ["RS-002"]}})["result"]
        stale = [{"el": "F-002", "ref": "D-001"}]
        spec = {"args": at_limit(g02["next_args"]), "ruled_at": {"3a": ["RS-002"]}, "questions_at": {"3a": ["RS-003"]}, "supersedes_at": {"3a-hold": ["D-001"]},
                "stale_refs_at": {"3a-hold": stale, "3a-holdv-left": stale}, "unverified_at": {"3a-hold-settle": ["F-002"]}}
        r = run(spec)
        self.assertIn("F-002 ← D-001", self._prompt(r, "planner:3a-hold-settle"))
        judged_by(self, r, "verifier:3a-holdv-settle", "F-002")
        self.assertEqual(r["result"]["status"], "done", r["result"].get("reason"))
        left = run({**spec, "stale_refs_at": {"3a-hold": stale, "3a-holdv-left": stale, "3a-holdv-settle": stale, "3a-holdv-settle-2": stale}})["result"]
        self.assertEqual((left["status"], left["next_args"]["from"]), ("blocked", "3a"))
        self.assertEqual(r["result"]["hold_drafts"], [])

    def test_組み直しで出たopenと組のうちplannerが裁定し漏らした分を保険のresolverに渡す(self):
        spec = {"args": self._g0()["next_args"], "ruled_at": {"3a": ["RS-001"], "3b": ["RS-005"]},
                "about": {"RS-005": {"open": "O-020"}},
                "open_ids_at": {"3b-reframe": ["O-020", "O-021", "O-RS-001"]},
                "pair_keys_at": {"3b-reframe": ["pair:D-010|F-035"]}}
        r = run(spec)
        task = self._prompt(r, "resolver:3b")
        self.assertIn("まだ裁定の無い open: O-021", task, "要素の出典に現れない O- も渡し、裁定済みの O-RS-001 と planner:3b が裁定した O-020 は渡さない")
        self.assertNotIn("O-020", next(l for l in task.split("\n") if l.startswith("- まだ裁定の無い open: ")))
        self.assertIn("pair:D-010|F-035", task)
        self.assertEqual(r["result"]["missed"], ["open:O-021", "pair:D-010|F-035"])

    def test_組み直したflowは解決が無くても3bvが照合する(self):
        spec = {"args": self._g0()["next_args"], "ruled_at": {"3a": ["RS-001"]}, "unverified_at": {"3b-reframe": ["F-040"]}}
        r = run(spec)
        v = self._prompt(r, "verifier:3bv")
        self.assertEqual(v.split("検証する resolution の ID:")[1].split("\n")[0].strip(), "（なし）")
        self.assertIn(VERIFY_ALL_MARK, v)
        self.assertNotIn("F-040", r["disk"]["unverified"])
        self.assertEqual(r["result"]["status"], "done")
        stale = run({**spec, "verifier_flow_sha_at": {"3bv": "f-framer"}})["result"]
        self.assertEqual((stale["status"], stale["next_args"]["from"]), ("blocked", "3b"))
        self.assertEqual(len(stale["integrity"]), 1)

    def test_組み直したflowが閉じなければ差し戻す(self):
        spec = {"args": self._g0()["next_args"], "ruled_at": {"3a": ["RS-001"]}}
        fixed = run({**spec, "flow_findings_at": {"3b-reframe": 1}})
        self.assertIn("planner:3b:rework", fixed["labels"])
        self.assertEqual(fixed["result"]["status"], "done")
        broken = run({**spec, "flow_findings_at": {"3b-reframe": 1, "3b-reframe-rework": 1}})
        self.assertEqual(sum(1 for l in broken["labels"] if l.startswith("planner:3b")), 1 + 1)
        self.assertFalse(has(broken["labels"], "verifier:3bv"))
        self.assertEqual((broken["result"]["status"], broken["result"]["next_args"]["from"]), ("blocked", "3b"))

    def test_flowを書く権限の無いresolverがflowを変えたら止まる(self):
        g0 = self._g0()
        cases = (
            # 保険の resolver（planner が裁定し漏らした組と O-）も flow を書かない。
            ({"args": g0["next_args"], "ruled_at": {"3a": ["RS-001"]}, "questions_at": {"3a": ["RS-002"], "3b": ["RS-002"]}, "pair_keys_at": {"3b-reframe": ["pair:D-010|F-035"]}, "flow_sha_at": {"3b": "f-evil"},
              "planner_leaves_at": {"3b": []}}, "resolver:3b"),
            ({"args": args(), "flow_open": 1, "ruled_at": {"3": ["RS-001"]}, "flow_sha_at": {"3": "f-evil"}, "planner_leaves_at": {"1": ["RS-001"]}}, "resolver:3"),
            ({"args": args(), "findings": {"wholeReviewer:r1": [{"id": "r1-wh-all-001", "route": "decision"}]}, "ruled_at": {"6": ["RS-011"]}, "flow_sha_at": {"6": "f-evil"}}, "resolver:6"),
        )
        for spec, label in cases:
            with self.subTest(label=label):
                r = run(spec)
                self.assertIn("この呼び出しでは flow.json を書かない", self._prompt(r, label))
                res = r["result"]
                self.assertEqual((res["status"], res["next_args"], len(res["integrity"])), ("blocked", None, 1))

    def test_入口で問いだったIDは差し戻し後も落ちたら問いに戻す(self):
        fail = [{"id": "RS-002", "kind": "insufficient_grounds", "reason": "組み直した flow からは言えない"}]
        r = run({"args": self._g0()["next_args"], "ruled_at": {"3a": ["RS-001"], "3b": ["RS-002", "RS-005"], "3b-fix": ["RS-002"]}, "questions_at": {"3a": ["RS-002"], "3b-convert": ["RS-002"]},
                 "about": {"RS-005": {"pair": ["D-010", "F-035"]}}, "pair_keys_at": {"3b-reframe": ["pair:D-010|F-035"]}, "verifier_fail": {"3bv": fail, "3b-fixv": fail}})
        self.assertIn("RS-002 → question（insufficient_grounds）", self._prompt(r, "resolver:3b-convert"))
        self.assertEqual((r["result"]["status"], r["result"]["question_ids"]), ("needs_answers", ["RS-002"]))

    def test_settleで生まれた組の問いも同じg2で聞く(self):
        spec = {"args": self._g0()["next_args"], "ruled_at": {"3a": ["RS-001"], "3b": ["RS-005"]}, "about": {"RS-005": {"open": "O-020"}, "RS-006": {"pair": ["D-001", "F-030"]}},
                "open_ids_at": {"3b-reframe": ["O-020"]}, "open_only_at": {"3bv": [{"el": "F-030", "open": "O-020"}]},
                "pair_keys_at": {"3b-settle": ["pair:D-001|F-030"]}, "questions_at": {"3b-settle-pairs": ["RS-006"]}}
        r = run(spec)
        self.assertNotIn("question ではなく hold", self._prompt(r, "planner:3b-settle"), "聞ける 3b の settle の planner は問いを返してよい")
        self.assertNotIn("resolver:3b-settle-pairs", r["labels"])
        self.assertEqual((r["result"]["status"], r["result"]["question_ids"]), ("needs_answers", ["RS-006"]))

    def test_settleの後に回答待ちの問いの形を検査し直す(self):
        # 段 3: RS-001 は合格して settle が走り、RS-002 は g1 で聞く問いとして残っている。
        spec = {"args": args(), "flow_open": 1, "ruled_at": {"3": ["RS-001"]}, "questions_at": {"3": ["RS-002"]},
                "open_only_at": {"3v": [{"el": "F-091", "open": "O-RS-001"}]}}
        r = run(spec)
        self.assertIn("--ids RS-002 --check", self._prompt(r, "planner:3-settle"))
        self.assertNotIn("resolver:3-settle-questions", r["labels"])
        self.assertEqual(r["result"]["question_ids"], ["RS-002"])
        fixed = run({**spec, "bad_questions_at": ["3-settle"]})
        self.assertIn("--ids RS-002 --check", self._prompt(fixed, "resolver:3-settle-questions"))
        self.assertEqual(fixed["result"]["status"], "needs_answers")
        broken = run({**spec, "bad_questions_at": ["3-settle", "3-settle-questions"]})["result"]
        self.assertEqual((broken["status"], broken["next_args"]["from"]), ("blocked", "3"))

    def test_resolverの返り値はflow_checkを必ず持つ(self):
        r = run({"args": args(), "flow_open": 1, "ruled_at": {"3": ["RS-001"]}, "planner_leaves_at": {"1": ["RS-001"]}})
        self.assertIn("resolver:3", r["labels"], "保険の resolver:3 も同じ schema")
        self.assertIn("flow_check", r["resolverSchema"]["required"])

    def test_段3bの途中で止まっても段の頭から再開できる(self):
        g0 = self._g0()
        spec = {"ruled_at": {"3a": ["RS-001"]}, "questions_at": {"3a": ["RS-002"], "3b": ["RS-003"]}, "about": {"RS-003": {"pair": ["D-010", "F-035"]}}, "pair_keys_at": {"3b-reframe": ["pair:D-010|F-035"]}}
        whole = run({**spec, "args": g0["next_args"]})["result"]
        left = {**spec, "planner_leaves_at": {"3b": ["RS-003"]}}
        whole_left = run({**left, "args": g0["next_args"]})["result"]
        for stop, sp, want in (("planner:3b", spec, whole), ("resolver:3b", left, whole_left), ("verifier:3bv", spec, whole)):
            with self.subTest(stop=stop):
                stopped = run({**sp, "args": g0["next_args"], "null_labels": [stop]})["result"]
                self.assertEqual((stopped["status"], stopped["next_args"]["from"]), ("blocked", "3b"))
                again = run({**sp, "args": stopped["next_args"]})
                self.assertIsNone(again["error"], again["error"])
                self.assertEqual(again["labels"][:2], ["flow-check:3b-entry", "planner:3b"])
                # resolutions_sha256 は stub が run ごとに数え直す値なので比べない。
                drop = lambda st: {k: v for k, v in st.items() if k != "resolutions_sha256"}
                self.assertEqual(drop(again["result"]["next_args"]["state"]), drop(want["next_args"]["state"]))

    def test_回答した問いを同じIDで続きの問いにするとg2で聞く(self):
        # 3a の resolver が RS-001 を続きの問いとして返し、3av がその問いの形を合格にした。合格だけを見て回答済みに数えると、
        # 回答待ちから落ち、g2 で聞かれない。
        r = run({"args": self._g0()["next_args"], "questions_at": {"3a": ["RS-001"]}})
        res = r["result"]
        self.assertIn("verifier:3av", r["labels"])
        self.assertEqual((res["status"], res.get("question_ids")), ("needs_answers", ["RS-001"]), res.get("reason"))
        self.assertNotIn("RS-001", res["next_args"]["state"].get("answered", []))

    def test_free_textがmappingで落ち差し戻しで続きの問いにしてもg2で聞く(self):
        # 差し戻しで問いに変えた ID が 3a-fixv に合格しても、回答が当たったことにはならない。
        fail = {"id": "RS-001", "kind": "mapping", "reason": "r"}
        r = run({"args": self._g0()["next_args"], "free_text_at": {"3a": ["RS-001"]},
                 "verifier_fail": {"3av": [fail]}, "questions_at": {"3a-fix": ["RS-001"]}})
        res = r["result"]
        self.assertIn("verifier:3a-fixv", r["labels"])
        usable = next(l for l in self._prompt(r, "planner:3b").split("\n") if l.startswith("- 根拠にしてよい resolution"))
        self.assertNotIn("RS-001", usable, "回答の無い問いを根拠に渡さない")
        self.assertEqual((res["status"], res.get("question_ids")), ("needs_answers", ["RS-001"]), res.get("reason"))

    def test_回答を返り値の種類で数えなくても台帳との照合がg2の前で止める(self):
        # 回答済みへの入れ方（resolveCycle）が合格だけを見る欠陥を作ると、段の出口の照合が台帳と script の食い違いで止める。
        broken = [("(res.passed || []).includes(id) && ANSWERED_KINDS.includes((res.kinds || {})[id])", "(res.passed || []).includes(id)")]
        res = run({"args": self._g0()["next_args"], "questions_at": {"3a": ["RS-001"]}}, patch=broken)["result"]
        self.assertEqual((res["status"], res["next_args"]["from"]), ("blocked", "3a"), res.get("reason"))
        self.assertIn("台帳にだけある: RS-001 / script にだけある: （なし）", res["reason"])


@unittest.skipIf(shutil.which("node") is None, "node が無い環境ではスキップする")
class PendingQuestionsLedger(unittest.TestCase):
    """回答待ちの問いの正本は台帳（ruling が question で answer の無い resolution）で、pendingQuestions はその写し。段の出口で照合し、
    食い違えばその段からやり直せる blocked にする（resolver の返り値と台帳の書き込みの食い違いで、同じ段をやり直せば直りうる）。"""

    def _g0(self, questions):
        return run({"args": args(), "flow_open": 1, "questions_at": {"3": questions}})["result"]

    def test_ruledで返したのに台帳に回答が無ければ3aの出口で止める(self):
        r = run({"args": self._g0(["RS-001"])["next_args"], "ruled_at": {"3a": ["RS-001"]}, "unanswered_ruled_at": {"3a": ["RS-001"]}})
        res = r["result"]
        self.assertFalse(has(r["labels"], "planner:3b"))
        self.assertEqual((res["status"], res["next_args"]["from"]), ("blocked", "3a"), res.get("reason"))
        self.assertIn("段 3a: 回答待ちの問いが台帳", res["reason"])
        self.assertIn("台帳にだけある: RS-001 / script にだけある: （なし）", res["reason"])

    def test_台帳に回答を当てたのに返さなければ3aの出口で止める(self):
        r = run({"args": self._g0(["RS-001", "RS-002"])["next_args"], "ruled_at": {"3a": ["RS-001"]}, "silent_answers_at": {"3a": ["RS-002"]}})
        res = r["result"]
        self.assertEqual((res["status"], res["next_args"]["from"]), ("blocked", "3a"), res.get("reason"))
        self.assertIn("台帳にだけある: （なし） / script にだけある: RS-002", res["reason"])

    def test_問いの形の直しで問いに戻した回答は候補の選択でも回答済みにしない(self):
        # 3a の resolver が RS-001 を候補の選択（ruled）で返し、RS-002 の形の直し（3a-questions）で RS-001 も続きの問いとして返す。
        # 最後に返した種類が問いなので、g2 で聞く（候補の選択の経路は種類を見ないと回答済みに入れ、段の出口の照合で止まる）。
        spec = {"args": self._g0(["RS-001"])["next_args"], "ruled_at": {"3a": ["RS-001"]}, "questions_at": {"3a": ["RS-002"], "3a-questions": ["RS-001", "RS-002"]},
                "bad_questions_at": ["3a"], "questions_check_ids_at": {"3a-questions": ["RS-001", "RS-002"]}}
        r = run(spec)
        self.assertIn("resolver:3a-questions", r["labels"])
        res = r["result"]
        self.assertEqual((res["status"], res.get("question_ids")), ("needs_answers", ["RS-001", "RS-002"]), res.get("reason"))
        self.assertIn("形の不合格が 1 件あります: RS-002: 候補が 1 個です", self._prompt(r, "resolver:3a-questions"), "問いの形の直しには不合格の理由を渡す")

    def _prompt(self, r, label):
        return next(p["prompt"] for p in r["prompts"] if p["label"] == label)

    def test_同じIDを2つの種類で返したresolverはその段で止める(self):
        res = run({"args": self._g0(["RS-001"])["next_args"], "ruled_at": {"3a": ["RS-001"]}, "questions_at": {"3a": ["RS-001"]}})["result"]
        self.assertEqual((res["status"], res["next_args"]["from"]), ("blocked", "3a"), res.get("reason"))
        self.assertIn("resolver:3a: resolver が RS-001 を ruled・questions・holds・free_text の 2 つ以上で返しました", res["reason"])

    def test_回答済みの問いを後の段で聞き直せばゲートで聞き直し_写しがずれればゲートの入口で止める(self):
        # g1 で答えた RS-001 を 3b の resolver が続きの問いとして返す。問いとして返した ID は回答待ちに戻る（absorbResolver）。
        spec = {"ruled_at": {"3a": ["RS-001"], "3b": ["RS-020"]}, "questions_at": {"3a": ["RS-002"], "3b": ["RS-001"]}, "open_ids_at": {"3b-reframe": ["O-020"]},
                "about": {"RS-020": {"open": "O-020"}}}
        g0 = self._g0(["RS-001"])
        ok = run({**spec, "args": g0["next_args"]})["result"]
        self.assertEqual((ok["status"], ok["question_ids"]), ("needs_answers", ["RS-001", "RS-002"]), ok.get("reason"))
        broken = [("  if (asked.some((id) => (state.answered || []).includes(id))) state.answered = minus(state.answered, asked)\n", "")]
        res = run({**spec, "args": g0["next_args"]}, patch=broken)["result"]
        self.assertEqual((res["status"], res["next_args"]["from"]), ("blocked", "3b"), res.get("reason"))
        self.assertIn("台帳にだけある: RS-001 / script にだけある: （なし）", res["reason"])

NEEDS_ANSWERS = re.compile(r"return needsAnswers\(([^)]*)\)")
FUNCTION = re.compile(r"^(?:async )?function (\w+)")


@unittest.skipIf(shutil.which("node") is None, "node が無い環境ではスキップする")
class Gates(unittest.TestCase):
    """ゲートは開いた順に g1, g2, … と名乗り、聞けるかは聞ける回数（MAX_GATES）が残っているかだけで決まる。
    問いを持って止まる段は段 3・3b・6 と、回答を当てる 3a（3b の後）・3a'。"""

    CROSS = {"wholeReviewer:r1": [{"id": "r1-wh-all-001", "route": "decision"}]}

    def test_needs_answersを返す呼び出しの場所を列挙する(self):
        src = PRD.read_text(encoding="utf-8")
        self.assertEqual(src.count("finish('needs_answers'"), 1)
        calls, fn = set(), None
        for line in src.splitlines():
            m = FUNCTION.match(line)
            fn = m.group(1) if m else fn
            calls |= {(fn, g) for g in NEEDS_ANSWERS.findall(line)}
        self.assertEqual(calls, {("stage3", "'3a', onward"), ("stage3b", "'3a', onward"), ("stage6", '"3a\'", \'7\''), ("stageApply", "stageId")}, "初稿の前の段は問いを持ち越して進む段（onward）を渡す")
        checks, fn = set(), None
        for line in src.splitlines():
            m = FUNCTION.match(line)
            fn = m.group(1) if m else fn
            if "await answersUnchecked(" in line:
                checks.add(fn)
        self.assertEqual(checks, {"needsAnswers", "stageApply"}, "回答のファイルを確かめずに needs_answers を返す経路か、回答を当てる経路がある")

    def test_聞ける回数の上限は監査のパスの数から決まる(self):
        src = PRD.read_text(encoding="utf-8")
        # 内訳: 初稿の監査の後の最初のゲート・回答の反映から出る続きの問いのゲート・延長のゲート（3）と、改稿のパスの段 6 のゲート（MAX_AUDIT_PASSES）。
        self.assertIn("const MAX_GATES = 3 + MAX_AUDIT_PASSES\n", src)
        self.assertEqual(MAX_GATES, 4, "監査を 2 回にしても聞ける回数は変えない")
        self.assertIn(f"const LIMIT_WHY = `依頼者に聞ける回数の上限（MAX_GATES = ${{MAX_GATES}}）に達した`", src)
        self.assertIn("const canAsk = () => (entryState.gates || 0) < MAX_GATES", src, "聞けるかは段の入口の数で決める")

    def test_最後のパスの段6の問いもゲートで聞く(self):
        findings = new_item_each_round(MAX_AUDIT_PASSES)
        findings[f"writerReviewer:r{MAX_AUDIT_PASSES}"][0]["route"] = "decision"
        r = run({"args": args(), "findings": findings, "questions_at": {"6": ["RS-020"]}})
        self.assertEqual([l for l in r["labels"] if l.startswith("resolver:6")], ["resolver:6"], "段 6 は最後のパスで初めて起動し、問いを保持規則に変えない")
        res = r["result"]
        self.assertEqual((res["status"], res["gate"], res["question_ids"]), ("needs_answers", "g1", ["RS-020"]), res.get("reason"))
        self.assertEqual((res["next_args"]["from"], res["next_args"]["state"]["pass"], res["next_args"]["state"]["gates"]), ("3a'", MAX_AUDIT_PASSES, 1))

    def test_3bの後の3aで出た続きの問いは次のゲートで聞く(self):
        g1 = run({"args": args(), "flow_open": 1, "questions_at": {"3": ["RS-001"]}})["result"]
        g2 = run({"args": g1["next_args"], "ruled_at": {"3a": ["RS-001"]}, "questions_at": {"3a": ["RS-002"]}})["result"]
        self.assertEqual((g2["gate"], g2["next_args"]["state"]["reframed"]), ("g2", True))
        r = run({"args": g2["next_args"], "ruled_at": {"3a": ["RS-002"]}, "questions_at": {"3a": ["RS-003"]}})
        g3 = r["result"]
        self.assertEqual((g3["status"], g3["gate"], g3["question_ids"]), ("needs_answers", "g3", ["RS-003"]), g3.get("reason"))
        self.assertEqual((g3["answers_path"], g3["next_args"]["from"], g3["next_args"]["state"]["gates"]), ("/tmp/prd-w/answers/g3.md", "3a", 3))
        self.assertFalse(has(r["labels"], "resolver:3a-hold"), "聞ける回数が残っているので保持規則に変えない")
        self.assertFalse(has(r["labels"], "planner:3b"), "組み直しは 1 回だけ")
        self.assertFalse(has(r["labels"], "writer"), "回答待ちの問いを持って初稿へ進まない")
        self.assertNotIn(LIMIT_WHY, nth_prompt(r, "resolver:3a", 0))
        done = run({"args": g3["next_args"], "ruled_at": {"3a": ["RS-003"]}})
        self.assertEqual(done["result"]["status"], "done", done["result"].get("reason"))
        self.assertEqual(done["labels"][:2], ["flow-check:3a-entry", "resolver:3a"])
        assert_entry_answers(self, done, "3a", "g3", ["RS-003"])
        self.assertNotIn("RS-003", done["result"]["holds"])

    def test_3a_dashで出た続きの問いは次のゲートで聞く(self):
        g1 = run({"args": args(), "findings": self.CROSS, "questions_at": {"6": ["RS-010"]}})["result"]
        self.assertEqual((g1["gate"], g1["next_args"]["from"]), ("g1", "3a'"))
        r = run({"args": g1["next_args"], "ruled_at": {"3a'": ["RS-010"]}, "questions_at": {"3a'": ["RS-011"]}})
        g2 = r["result"]
        self.assertEqual((g2["status"], g2["gate"], g2["question_ids"]), ("needs_answers", "g2", ["RS-011"]), g2.get("reason"))
        self.assertEqual((g2["answers_path"], g2["next_args"]["from"], g2["next_args"]["state"]["gates"]), ("/tmp/prd-w/answers/g2.md", "3a'", 2))
        self.assertFalse(has(r["labels"], "resolver:3a'-hold"))
        self.assertFalse(has(r["labels"], "writer:U-1:revise"), "回答待ちの問いを持って改稿へ進まない")
        done = run({"args": g2["next_args"], "ruled_at": {"3a'": ["RS-011"]}})
        self.assertEqual(done["result"]["status"], "done", done["result"].get("reason"))
        self.assertEqual(done["labels"][:2], ["flow-check:3a'-entry", "resolver:3a'"])
        assert_entry_answers(self, done, "3a'", "g2", ["RS-011"])
        self.assertTrue(has(done["labels"], "writer:U-1:revise"))

    def test_上限に達していれば3a_dashの続きの問いは保持規則になり上限を理由に渡す(self):
        g1 = run({"args": args(), "findings": self.CROSS, "questions_at": {"6": ["RS-010"]}})["result"]
        r = run({"args": at_limit(g1["next_args"]), "ruled_at": {"3a'": ["RS-010"]}, "questions_at": {"3a'": ["RS-011"]}})
        res = r["result"]
        self.assertEqual(res["status"], "done", res.get("reason"))
        self.assertIn(LIMIT_WHY, nth_prompt(r, "resolver:3a'", 0))
        self.assertIn(f"次の問いは依頼者に聞かない（{LIMIT_WHY}）", nth_prompt(r, "resolver:3a'-hold", 0))
        self.assertIn("RS-011", res["holds"])

    def test_next_argsで再開した後に開くゲートは前の回答のファイルと重ならない(self):
        runs = [run({"args": args(), "flow_open": 1, "questions_at": {"3": ["RS-001"]}})["result"]]
        for answered, asked in ((["RS-001"], ["RS-002"]), (["RS-002"], ["RS-003"])):
            runs.append(run({"args": runs[-1]["next_args"], "ruled_at": {"3a": answered}, "questions_at": {"3a": asked}})["result"])
        self.assertEqual([(x["status"], x["gate"]) for x in runs], [("needs_answers", "g1"), ("needs_answers", "g2"), ("needs_answers", "g3")])
        self.assertEqual([x["answers_path"] for x in runs], [f"/tmp/prd-w/answers/g{n}.md" for n in (1, 2, 3)], "前のゲートの回答を上書きしない")
        self.assertEqual([x["next_args"]["state"]["gates"] for x in runs], [1, 2, 3])
        self.assertEqual([x["question_ids"] for x in runs], [["RS-001"], ["RS-002"], ["RS-003"]])

    def test_組み直しの前の3aは3bへ持ち越し組み直しの後の3aは自分でゲートを開く(self):
        g1 = run({"args": args(), "flow_open": 1, "questions_at": {"3": ["RS-001"]}})["result"]
        self.assertNotIn("reframed", g1["next_args"]["state"], "段 3 のゲートは 3b の前")
        spec = {"ruled_at": {"3a": ["RS-001"]}, "questions_at": {"3a": ["RS-002"]}}
        before = run({"args": g1["next_args"], **spec})
        self.assertTrue(has(before["labels"], "planner:3b"), "3b の前の 3a は問いを 3b へ持ち越し、組み直した flow の問いと 1 回で聞く")
        self.assertEqual((before["result"]["gate"], before["result"]["next_args"]["state"]["reframed"]), ("g2", True))
        after = run({"args": with_state(g1["next_args"], reframed=True), **spec})
        self.assertFalse(has(after["labels"], "planner:3b"), "3b を通った run の 3a は組み直さない")
        res = after["result"]
        self.assertEqual((res["status"], res["gate"], res["question_ids"], res["next_args"]["from"]), ("needs_answers", "g2", ["RS-002"], "3a"), res.get("reason"))

    # 再発の筋書き: パス 1 の段 6 の問い RS-010（r1 の指摘への裁定）を g1 で聞き、回答の後の改稿の監査 r2 が同じ項目に指摘を出し直す（再発）。
    # r2 は最後の監査なので、再発した指摘は延長の段 6（2 パス目の段 6）に渡る。
    RECUR_ABOUT = {"RS-010": {"finding": "r1-wh-all-001"}, "RS-011": {"finding": "r2-wr-all-001"}}
    RECUR = {**CROSS, "writerReviewer:r2": [{"id": "r2-wr-all-001", "direction": "make_measurable"}]}
    REASKED = "前の裁定に回答か保持規則がある再発の指摘（planner.md の「段 6」）: r2-wr-all-001"

    def _recur_g1(self):
        g1 = run({"args": args(), "findings": self.RECUR, "about": self.RECUR_ABOUT, "questions_at": {"6": ["RS-010"]}})["result"]
        self.assertEqual((g1["gate"], g1["question_ids"]), ("g1", ["RS-010"]))
        return g1

    def test_回答済みの論点が次のパスで再発したら聞き直さず保持規則にする(self):
        # 延長の段 6 の resolver がそれでも問い RS-011 を返す。同じ論点を二度聞かないので、ゲートを開かずに hold にする（聞ける回数は残っている）。
        # 問いが残らないので、延長の段 6 は 7 へ進まずに finalHold（pass_limit）にし、本文に入らない hold は文案（hold_drafts）で返す。
        spec = {"args": self._recur_g1()["next_args"], "findings": self.RECUR, "about": self.RECUR_ABOUT, "ruled_at": {"3a'": ["RS-010"]}, "questions_at": {"6": ["RS-011"]}}
        r = run(spec)
        res = r["result"]
        self.assertNotEqual(res["status"], "needs_answers", "回答済みの論点の再発でゲートを開かない")
        self.assertEqual((res["status"], res["stop_reason"], res["passes"]), ("blocked", "pass_limit", MAX_AUDIT_PASSES + 1), res.get("reason"))
        second = nth_prompt(r, "resolver:6", 0)
        self.assertIn(self.REASKED, second)
        self.assertIn("resolver:6-hold", r["labels"])
        self.assertIn("次の問いは依頼者に聞かない（前の裁定に回答か保持規則がある項目の再発で、同じことを二度聞かない）", nth_prompt(r, "resolver:6-hold", 0))
        self.assertIn("RS-011", res["hold_drafts"], "延長の段 6 の hold は本文に入らないので文案で返す")
        self.assertNotIn("RS-011", res["holds"])
        self.assertNotIn(LIMIT_WHY, second, "聞ける回数は残っている")
        self.assertEqual(sum(1 for l in r["labels"] if l.startswith("writer:U-1:revise")), 1, "回答を当てた改稿だけで、延長の改稿はしない")
        self.assertFalse(has(r["labels"], "writerReviewer:r3"))
        self.assertNotIn("r2-wr-all-001", nth_prompt(r, "resolver:final", 0), "保持規則にした指摘を resolver:final に渡し直さない")

    def test_保持規則にした論点が次のパスで再発しても聞き直さない(self):
        # g1 で RS-010 に「保留」と答え、3a' の resolver が回答の節を引く hold にした（answer_holds。回答の無い保持規則なので state.answered には入らない）。
        # 延長の段 6 は聞ける段だが、保持規則にした論点の再発は聞き直さない。
        spec = {"findings": self.RECUR, "about": self.RECUR_ABOUT, "holds_at": {"3a'": ["RS-010"], "6": ["RS-011"]}, "answer_holds": ["RS-010"]}
        start = self._recur_g1()["next_args"]
        r = run({"args": start, **spec})
        res = r["result"]
        self.assertIn("RS-010", res["holds"], res.get("reason"))
        self.assertTrue(has(r["labels"], "resolver:6"), "延長の段 6 を開く")
        self.assertIn(self.REASKED, nth_prompt(r, "resolver:6", 0))
        self.assertNotIn(LIMIT_WHY, nth_prompt(r, "resolver:6", 0), "聞ける段で確かめる")
        # 対照: 回答のある裁定だけを見ると、保持規則にした論点の再発を聞き直しうる。
        only_answered = ("  const settled = new Set([...(state.answered || []), ...(state.holds || [])])\n", "  const settled = new Set(state.answered || [])\n")
        self.assertNotIn(self.REASKED, nth_prompt(run({"args": start, **spec}, patch=[only_answered]), "resolver:6", 0))

    def test_聞ける段のholdLeftはnewHoldsInWで止まらない(self):
        # 聞ける段（canAsk 真）の holdLeft が作った hold は、holdLeft 自身の orderHolds(ids) で script の指定になり、段の出口の newHoldsInW を通る。
        # 上の再発の経路では段 6 も再発の指摘の about を指定する（decide）ので、その指定を外した本文で holdLeft の指定だけが効くことを確かめる。
        g1 = self._recur_g1()
        self.assertLess(g1["next_args"]["state"]["gates"], MAX_GATES, "延長の段 6 は聞ける段")
        spec = {"args": g1["next_args"], "findings": self.RECUR, "about": self.RECUR_ABOUT, "ruled_at": {"3a'": ["RS-010"]}, "questions_at": {"6": ["RS-011"]}}
        by_about = ("  orderHolds([], [...reasked])\n", "  orderHolds([], [])\n")
        by_hold_left = ("  orderHolds(ids)\n  const label = `resolver:${stage}-hold`\n", "  const label = `resolver:${stage}-hold`\n")
        r = run(spec, patch=[by_about])
        res = r["result"]
        self.assertTrue(has(r["labels"], "resolver:6"), "延長の段 6 を開く")
        self.assertNotIn(LIMIT_WHY, nth_prompt(r, "resolver:6", 0))
        self.assertTrue(has(r["labels"], "resolver:6-hold"))
        self.assertEqual((res["status"], res["stop_reason"]), ("blocked", "pass_limit"), res.get("reason"))
        self.assertIn("RS-011", res["hold_drafts"])
        broken = run(spec, patch=[by_about, by_hold_left])["result"]
        # 対照: holdLeft が指定を入れないと、聞ける段の resolver の hold は script の指定の外として問いに書き換え直させられ、holdLeft が止まる。
        self.assertEqual((broken["status"], broken["stop_reason"]), ("blocked", None), broken.get("reason"))
        self.assertIn("RS-011 を resolver が hold に返しませんでした", broken["reason"])


def docs_units(n):
    """文書 requirements/d1〜d<n> を 1 つずつ持つ単位 U-1〜U-<n>。"""
    return [{"id": f"U-{i}", "docs": [f"requirements/d{i}"], "depends_on": []} for i in range(1, n + 1)]


@unittest.skipIf(shutil.which("node") is None, "node が無い環境ではスキップする")
class TwoReviewers(unittest.TestCase):
    """段 5・8 の監査は writer reviewer（文書の詰め合わせの組ごと）が返ってから whole reviewer（1 体・指名）が起動し、
    whole reviewer は同じ回の writer reviewer の指摘だけを退けられる（workflow-io.md §4 の段 5・段 8）。"""

    def _packed(self):
        # 5 文書: writer reviewer は p1（d1〜d4）と p2（d5）、どちらも r1 と r2 に指摘を出す。r1 は blocking で改稿に回し、r2 は blocking でない。
        f = lambda rid, d, blocking=True: {"id": rid, "doc": f"requirements/d{d}", "item_id": f"PR-D{d}-001", "blocking": blocking}
        changed = {f"U-{i}": [f"PR-D{i}-001"] if i in (1, 5) else [] for i in range(1, 6)}
        by_doc = {f"requirements/d{i}": {"changed": [f"PR-D{i}-001"], "added": [], "removed": []} for i in (1, 5)}
        return run({
            "args": args(), "units": docs_units(5),
            "findings": {"writerReviewer:r1:p1": [f("r1-wr-p1-001", 1)], "writerReviewer:r1:p2": [f("r1-wr-p2-001", 5)],
                         "writerReviewer:r2:p1": [f("r2-wr-p1-001", 1, False)], "writerReviewer:r2:p2": [f("r2-wr-p2-001", 5, False)]},
            "writer_changed_by_unit": changed, "diff": {"r2": ["PR-D1-001", "PR-D5-001"]}, "by_doc": {"r2": by_doc},
        })

    def test_whole_reviewerはwriter_reviewerがすべて返ってから起動しその指摘のIDを受け取る(self):
        r = self._packed()
        self.assertEqual(r["result"]["status"], "done", r["result"].get("reason"))
        labels = r["labels"]
        for n in (1, 2):
            with self.subTest(round=n):
                wr = [f"writerReviewer:r{n}:p1", f"writerReviewer:r{n}:p2"]
                self.assertLess(max(labels.index(l) for l in wr), labels.index(f"wholeReviewer:r{n}:all"))
                # 両方の組の ID が載るのは、両方の組の返り値を待ってから whole reviewer のプロンプトを組んだときだけ。
                files = f"/tmp/prd-w/findings/r{n}-wr-p1.json、/tmp/prd-w/findings/r{n}-wr-p2.json"
                self.assertIn(f"同じ回の writer reviewer の指摘: r{n}-wr-p1-001, r{n}-wr-p2-001（{files}）", nth_prompt(r, f"wholeReviewer:r{n}:all", 0))
                self.assertNotIn("同じ回の writer reviewer の指摘", nth_prompt(r, wr[0], 0))
        self.assertEqual(r["findingFiles"], ["r1-wr-p1", "r1-wr-p2", "r1-wh-all", "r2-wr-p1", "r2-wr-p2", "r2-wh-all"], "指摘のファイルは役と組で分かれ重ならない")

    def test_段8のwriter_reviewerは自分の組の文書の申告と前のパスの指摘だけを受け取る(self):
        r = self._packed()
        p1, p2 = nth_prompt(r, "writerReviewer:r2:p1", 0), nth_prompt(r, "writerReviewer:r2:p2", 0)
        self.assertIn("- requirements/d1: PR-D1-001", p1)
        self.assertNotIn("requirements/d5:", p1)
        self.assertIn("- requirements/d5: PR-D5-001", p2)
        self.assertIn("この文書への前のパスの指摘（範囲の項目のものを照らす）: r1-wr-p1-001", p1)
        self.assertNotIn("r1-wr-p2-001", p1)
        self.assertIn("この文書への前のパスの指摘（範囲の項目のものを照らす）: r1-wr-p2-001", p2)
        whole = nth_prompt(r, "wholeReviewer:r2:all", 0)
        self.assertIn("- requirements/d1: PR-D1-001\n- requirements/d5: PR-D5-001", whole, "whole reviewer の範囲は申告の全項目")

    def test_writer_reviewerは4文書までは1体で5文書から組に分かれwhole_reviewerは常に1体(self):
        for n, packs in ((1, {"all": [1]}), (4, {"all": [1, 2, 3, 4]}), (5, {"p1": [1, 2, 3, 4], "p2": [5]})):
            with self.subTest(docs=n):
                r = run({"args": args(), "units": docs_units(n)})
                self.assertEqual(r["result"]["status"], "done", r["result"].get("reason"))
                self.assertEqual([l for l in r["labels"] if ":r1:" in l], [f"writerReviewer:r1:{k}" for k in packs] + ["wholeReviewer:r1:all"])
                for pack, ds in packs.items():
                    files = "、".join(f"/tmp/prd-w/requirements-d{i}.md" for i in ds)
                    head = "全文書" if len(packs) == 1 else f"詰め合わせの組 {pack} の文書（ほかの文書は別の writer reviewer が見る）"
                    self.assertIn(f"{head}: {files} とその .meta.json", nth_prompt(r, f"writerReviewer:r1:{pack}", 0))
                whole = nth_prompt(r, "wholeReviewer:r1:all", 0)
                self.assertIn("全文書: " + "、".join(f"/tmp/prd-w/requirements-d{i}.md" for i in range(1, n + 1)), whole)
                live = ",".join([f"writerReviewer__r1__{k}" for k in packs] + ["wholeReviewer__r1__all"])
                self.assertIn(f"--live {live} --sweep", whole)

    def test_同じ回のwriter_reviewerの指摘を退けるとblockingにも改稿にも裁定にも回らずnoticesに出る(self):
        findings = {"writerReviewer:r1": [{"id": "r1-wr-all-001"}, {"id": "r1-wr-all-002", "item_id": "PR-X-002", "route": "decision"}]}
        both = run({"args": args(), "findings": findings, "rejected_at": {"r1": ["r1-wr-all-001", "r1-wr-all-002"]}})
        res = both["result"]
        self.assertEqual(res["status"], "done", res.get("reason"))
        self.assertFalse(has(both["labels"], "writer:U-1:revise"), "退けた writer の指摘を改稿に回した")
        self.assertFalse(has(both["labels"], "resolver:6"), "退けた decision の指摘を裁定に回した")
        self.assertIn("監査 r1: whole reviewer が writer reviewer の指摘 2 件を退けた: r1-wr-all-001, r1-wr-all-002（理由は /tmp/prd-w/findings/r1-wh-all.json の rejected）", res["notices"])
        self.assertEqual(res["integrity"], [])
        one = run({"args": args(), "findings": findings, "rejected_at": {"r1": ["r1-wr-all-002"]}})
        self.assertEqual(one["result"]["status"], "done", one["result"].get("reason"))
        self.assertFalse(has(one["labels"], "resolver:6"))
        revise = nth_prompt(one, "writer:U-1:revise", 0)
        self.assertIn("r1-wr-all-001", revise)
        self.assertNotIn("r1-wr-all-002", revise)
        self.assertIn("監査 r1: whole reviewer が writer reviewer の指摘 1 件を退けた: r1-wr-all-002（理由は /tmp/prd-w/findings/r1-wh-all.json の rejected）", one["result"]["notices"])

    def test_自分の指摘と前の回の指摘と知らないIDは退けずintegrityに1行出す(self):
        r = run({"args": args(), "findings": {"wholeReviewer:r1": [{"id": "r1-wh-all-001"}], "writerReviewer:r2": [{"id": "r2-wr-all-001", "item_id": "PR-X-002", "blocking": False}]},
                 "rejected_at": {"r1": ["r1-wh-all-001", "r9-wr-all-001"], "r2": ["r1-wh-all-001"]}})
        res = r["result"]
        self.assertIn("r1-wh-all-001", nth_prompt(r, "writer:U-1:revise", 0), "whole reviewer 自身の指摘は退けられず改稿に回る")
        self.assertEqual(res["integrity"], [
            "監査 r1: whole reviewer が同じ回の writer reviewer の指摘に無い ID を退けようとした（退けずに数えた）: r1-wh-all-001, r9-wr-all-001",
            "監査 r2: whole reviewer が同じ回の writer reviewer の指摘に無い ID を退けようとした（退けずに数えた）: r1-wh-all-001",
        ])
        self.assertFalse(any("を退けた" in n for n in res["notices"]), res["notices"])

    def test_段8で退けた指摘は再発に数えない(self):
        # r1 の decision の指摘を RS-010 で裁定した PR-X-001 に、r2 の writer reviewer が別の向きの blocking を出す（退けなければ再発）。
        spec = {"args": args(), "ruled_seq_at": {"6": [["RS-010"]]}, "about": {"RS-010": {"finding": "r1-wh-all-001"}},
                "findings": {"wholeReviewer:r1": [{"id": "r1-wh-all-001", "route": "decision", "direction": "remove"}],
                             "writerReviewer:r2": [{"id": "r2-wr-all-001", "direction": "make_measurable"}]}}
        kept = run(spec)["result"]
        self.assertEqual(kept["item_routes"], {"requirements/x#PR-X-001": "decision"}, "退けない指摘は再発に数える（この照合の前提）")
        r = run({**spec, "rejected_at": {"r2": ["r2-wr-all-001"]}})
        res = r["result"]
        self.assertEqual((res["status"], res["item_routes"], res["passes"]), ("done", {}, 1), res.get("reason"))
        self.assertEqual(r["labels"].count("resolver:6"), 1, "退けた指摘で 2 パス目の段 6 を起動しない")
        self.assertIn("監査 r2: whole reviewer が writer reviewer の指摘 1 件を退けた: r2-wr-all-001（理由は /tmp/prd-w/findings/r2-wh-all.json の rejected）", res["notices"])


@unittest.skipIf(shutil.which("node") is None, "node が無い環境ではスキップする")
class Convergence(unittest.TestCase):
    """改稿と監査は収束の条件で回し、改稿で直らない項目は経路を変える（段 R6）。"""

    KEY = "requirements/x#PR-X-001"

    DIRECTIONS = ["remove", "make_measurable", "choose_one", "align_terms", "add_trace"]

    def _recurring(self, rounds, **kw):
        # r1 の決定が要る指摘を段 6 が RS-010 で裁定し、同じ項目に r2 以降も毎回違う向きの blocking が出続ける（裁定の再出ではない）。
        # r2 の再発は延長の段 6 に渡り、延長の段 6 が問い RS-011 にして g1 で聞く。返すのは g1 の run と、回答を当てて 3a' から続けた run。
        findings = {"wholeReviewer:r1": [{"id": "r1-wh-all-001", "route": "decision", "direction": self.DIRECTIONS[0]}]}
        for k in range(2, rounds + 1):
            findings[f"writerReviewer:r{k}"] = [{"id": f"r{k}-wr-all-001", "direction": self.DIRECTIONS[k - 1]}]
        about = {"RS-010": {"finding": "r1-wh-all-001"}, "RS-011": {"finding": "r2-wr-all-001"}}
        spec = {"args": args(), "findings": findings, "about": about, "ruled_seq_at": {"6": [["RS-010"]]}, "questions_seq_at": {"6": [[], ["RS-011"]]}, **kw}
        g1 = run(spec)
        res = g1["result"]
        self.assertEqual((res["status"], res.get("gate"), res.get("question_ids")), ("needs_answers", "g1", ["RS-011"]), res.get("reason"))
        self.assertEqual((res["next_args"]["from"], res["next_args"]["state"]["pass"]), ("3a'", MAX_AUDIT_PASSES + 1))
        return g1, run({**spec, "args": res["next_args"], "ruled_at": {"3a'": ["RS-011"]}})

    def test_再発した項目は段6に前の指摘と裁定が渡りwriterに回らない(self):
        # r2 は最後の監査なので、再発した項目は延長の段 6（2 パス目の段 6）に渡る。
        g1, after = self._recurring(2)
        self.assertEqual(g1["result"]["item_routes"], {self.KEY: "decision"})
        second = nth_prompt(g1, "resolver:6", 1)
        self.assertIn(f"再発した項目（項目: 前のパスの指摘 ← その裁定）: {self.KEY}: r1-wh-all-001 ← RS-010", second)
        self.assertIn("route が decision の指摘 r2-wr-all-001", second)
        res = after["result"]
        self.assertEqual((res["status"], res["passes"], res["item_routes"]), ("done", MAX_AUDIT_PASSES + 1, {self.KEY: "decision"}), res.get("reason"))
        self.assertNotIn("r2-wr-all-001", nth_prompt(after, "writer:U-1:revise", 0))

    def test_裁定の後の再発は上限で輪を出て残りの裁定に回る(self):
        # r1 の裁定の後に r2 で再発した項目は延長の段 6 で聞き、回答を当てた後の r3 でまた再発すると、延長は 1 回きりなので段 6 に戻らず
        # 輪を出て resolver:final に渡る。
        last = "r3-wr-all-001"
        g1, stuck = self._recurring(3)
        res = stuck["result"]
        self.assertEqual((res["status"], res["stop_reason"], res["item_routes"], res["passes"]), ("blocked", "pass_limit", {self.KEY: "decision"}, MAX_AUDIT_PASSES + 1), res.get("reason"))
        self.assertIn("resolver:final", stuck["labels"])
        self.assertFalse(has(stuck["labels"], "resolver:6"), "延長の後に段 6 を開かない")
        self.assertFalse(has(stuck["labels"], "writerReviewer:r4"))
        self.assertEqual(res["remaining_blocking"], [last])
        # 残った指摘の全件は理由ではなく report.md の節に載せる（ID の集合は返り値の unreflected）。
        self.assertEqual(sorted(res["unreflected"]), [last])
        self.assertIn("全件は report.md の「本文に反映していない指摘」", res["reason"])
        self.assertNotIn(last, res["reason"], "理由に残った指摘の ID を並べない")
        self.assertIn(f"route が decision の指摘 {last}", nth_prompt(stuck, "resolver:final", 0))
        self.assertFalse(any(x in p["prompt"] for r in (g1, stuck) for p in r["prompts"] if p["label"].startswith("writer:") for x in ("r2-wr-all-001", last)),
                         "再発した項目の指摘は writer に回らない")
        self.assertIsNone(res["next_args"])

    def test_改稿に回すものが無いままblockingが残ればdoneにせずno_progressで止まる(self):
        r = run({"args": args(), "findings": {"wholeReviewer:r1": [{"id": "r1-wh-all-001", "route": "decision"}]}})
        res = r["result"]
        self.assertEqual((res["status"], res["stop_reason"], res["remaining_blocking"]), ("blocked", "no_progress", ["r1-wh-all-001"]), "段 6 が何も裁定しなかった")
        self.assertFalse(has(r["labels"], "writer:U-1:revise"))
        self.assertIn("resolver:final", r["labels"])

    def test_doc_checkのblockingだけが残るときは上限まで回す(self):
        fixed = run({"args": args(), "doc_blocking_at": {"r1": 1}})
        self.assertTrue(has(fixed["labels"], "writer:U-1:revise"), "doc_check の blocking だけでも改稿に回す")
        self.assertEqual((fixed["result"]["status"], fixed["result"]["passes"]), ("done", 1), fixed["result"].get("reason"))
        # 最後の監査で doc_check の指摘が増えても、進展なし（no_progress）にせず上限（pass_limit）で輪を出る。
        grew = run({"args": args(), "findings": new_item_each_round(MAX_AUDIT_PASSES), "doc_blocking_at": {f"r{MAX_AUDIT_PASSES + 1}": 1}})["result"]
        self.assertEqual((grew["status"], grew["stop_reason"], grew["passes"], grew["doc_blocking"]), ("blocked", "pass_limit", MAX_AUDIT_PASSES, 1), grew.get("reason"))
        stuck = run({"args": args(), "findings": {"writerReviewer:r1": [{"id": "r1-wr-all-001"}]},
                     "doc_blocking_at": {f"r{k}": 1 for k in range(1, MAX_AUDIT_PASSES + 2)}})["result"]
        self.assertEqual((stuck["status"], stuck["stop_reason"], stuck["passes"], stuck["doc_blocking"]), ("blocked", "pass_limit", MAX_AUDIT_PASSES, 1))
        self.assertIn("パスが上限", stuck["reason"])

    def _reraise(self, r2, r1_writer=False, **kw):
        # r1 の tighten を段 6 が RS-010 で裁定して合格し、改稿がそれを PR-X-001 に当てた。r2 の監査が r2 の指摘を返す。
        findings = {"wholeReviewer:r1": [{"id": "r1-wh-all-001", "route": "decision", "direction": "tighten"}], "writerReviewer:r2": r2}
        if r1_writer:
            findings["writerReviewer:r1"] = [{"id": "r1-wr-all-001"}]
        spec = {"args": args(), "findings": findings, "ruled_seq_at": {"6": [["RS-010"]]}, "about": {"RS-010": {"finding": "r1-wh-all-001"}},
                "writer_changed_seq": [["PR-X-001"]], "diff": {"r2": ["PR-X-001"]}}
        return run({**spec, **kw})

    def test_既裁定の再出は再発にもblockingにも数えずnoticesに出す(self):
        r = self._reraise([{"id": "r2-wr-all-001", "direction": "tighten"}])
        res = r["result"]
        self.assertEqual((res["status"], res["item_routes"]), ("done", {}), res.get("reason"))
        self.assertEqual([n for n in res["notices"] if "既裁定の再出" in n], ["監査 r2: 既裁定の再出（再発に数えない）: r2-wr-all-001 ← RS-010"])
        self.assertNotIn("r2-wr-all-001", res["unreflected"], "既裁定の再出は本文に反映していない指摘に含めない")
        turned = self._reraise([{"id": "r2-wr-all-001", "direction": "relax"}])
        # r2 は最後の監査なので、逆向きの指摘は輪を出た後の resolver に届く。
        self.assertIn("route が decision の指摘 r2-wr-all-001", nth_prompt(turned, "resolver:final", 0), "再出と逆向きの指摘は裁定に逆らうので writer に回さない")
        self.assertFalse(any("r2-wr-all-001" in x["prompt"] for x in turned["prompts"] if x["label"].startswith("writer:")))
        bundled = self._reraise([{"id": "r2-wr-all-001", "direction": "tighten"}], r1_writer=True)["result"]
        self.assertEqual(bundled["item_routes"], {self.KEY: "decision"}, "同じパスで writer の指摘も渡した項目の変更は、裁定を当てただけとは言えない")

    def test_裁定を渡したパスの変更はdoc_checkの直しと混ざっていても再出にする(self):
        same = self._reraise([{"id": "r2-wr-all-001", "direction": "tighten"}], doc_blocking_at={"r1": 1})["result"]
        self.assertIn("監査 r2: 既裁定の再出（再発に数えない）: r2-wr-all-001 ← RS-010", same["notices"],
                      "裁定を渡したパスの変更は、doc_check の直しと混ざっていても裁定を当てたのと見分けられないので再出にする")

    # 延長: r2 の blocking の decision（r2-wr-all-003）を延長の段 6 が問い RS-012 にし、回答を当てた後の改稿と監査 r3 で 2 パス目を回す。
    EXTEND = {"id": "r2-wr-all-003", "item_id": "PR-X-003", "route": "decision"}

    def _extended(self, spec, first_seq, then_seq):
        # spec の run を延長のゲート（g1、RS-012）で止め、回答を当てて 3a' から続ける。writer_changed_seq は run ごとに頭から取るので分けて渡す。
        g1 = run({**spec, "writer_changed_seq": first_seq})["result"]
        self.assertEqual((g1["status"], g1.get("question_ids")), ("needs_answers", ["RS-012"]), g1.get("reason"))
        self.assertEqual((g1["next_args"]["from"], g1["next_args"]["state"]["pass"]), ("3a'", MAX_AUDIT_PASSES + 1))
        return g1, run({**spec, "args": g1["next_args"], "writer_changed_seq": then_seq, "ruled_at": {"3a'": ["RS-012"]}})

    def test_前のパスの再出だけが持つ裁定の項目が変わった後の同じ向きの指摘はblockingにする(self):
        # RS-010 は 1 パス目に渡し終えた。延長のパスの改稿が PR-X-001 を変える（doc_check の直し・申告に無い変更・別の項目の指摘の改稿）。
        spec = {"args": args(), "ruled_seq_at": {"6": [["RS-010"]]}, "questions_seq_at": {"6": [[], ["RS-012"]]},
                "about": {"RS-010": {"finding": "r1-wh-all-001"}, "RS-012": {"finding": self.EXTEND["id"]}},
                "findings": {"wholeReviewer:r1": [{"id": "r1-wh-all-001", "route": "decision", "direction": "tighten"}],
                             "writerReviewer:r2": [{"id": "r2-wr-all-001", "direction": "tighten"}, {"id": "r2-wr-all-002", "item_id": "PR-X-002"}, self.EXTEND],
                             "writerReviewer:r3": [{"id": "r3-wr-all-001", "direction": "tighten"}]}}
        declared = [["PR-X-001"], ["PR-X-001", "PR-X-002"]]
        found = "r3-wr-all-001"
        for name, seq, extra in (
            ("doc_check の直し", declared, {"diff": {"r2": declared[0], "r3": declared[1]}, "doc_blocking_at": {"r2": 1}}),
            # 申告に無い PR-X-001 の変更は、whole reviewer の diff の by_doc から照合の範囲（reRaised の changed）に入る。
            ("申告に無い変更", [["PR-X-001"], ["PR-X-002"]], {"diff": {"r2": ["PR-X-001"], "r3": ["PR-X-001", "PR-X-002"]}, "doc_blocking_at": {"r2": 1}}),
            ("別の項目の指摘の改稿", declared, {"diff": {"r2": declared[0], "r3": declared[1]}}),
        ):
            with self.subTest(name):
                g1, after = self._extended({**spec, **extra}, seq[:1], seq[1:])
                self.assertIn("監査 r2: 既裁定の再出（再発に数えない）: r2-wr-all-001 ← RS-010", g1["notices"])
                res = after["result"]
                # r3 は延長の後の監査なので、blocking に数えた指摘は改稿に回らず、残った blocking として輪を出る。
                self.assertEqual((res["status"], res["stop_reason"], res["passes"]), ("blocked", "pass_limit", MAX_AUDIT_PASSES + 1), res.get("reason"))
                self.assertFalse(any(found in n for n in res["notices"]), res["notices"])
                self.assertIn(found, res["remaining_blocking"])

    def test_当て損ねて持ち越した指摘を段6が裁定して当てた後の同じ向きの指摘は再出にする(self):
        # r1 の writer の指摘を 1 パス目の改稿が当て損ね、r2 で再発して decision に回り、延長の段 6 が問い RS-010 にして g1 で聞き、
        # 回答を当てた延長の改稿が当てる。その後の r3 の同じ向きの指摘は、裁定の再出にする。
        spec = {"args": args(), "questions_at": {"6": ["RS-010"]}, "about": {"RS-010": {"finding": "r1-wr-all-001"}},
                "findings": {"writerReviewer:r1": [{"id": "r1-wr-all-001", "direction": "tighten"}],
                             "writerReviewer:r3": [{"id": "r3-wr-all-001", "direction": "tighten"}]},
                "writer_changed_seq": [["PR-X-001"]]}
        g1 = run({**spec, "unapplied_seq": [["r1-wr-all-001"]]})["result"]
        self.assertEqual((g1["status"], g1.get("question_ids")), ("needs_answers", ["RS-010"]), g1.get("reason"))
        self.assertEqual(g1["item_routes"], {self.KEY: "decision"}, "持ち越した指摘の再発は decision に回る")
        res = run({**spec, "args": g1["next_args"], "ruled_at": {"3a'": ["RS-010"]}})["result"]
        self.assertEqual((res["status"], res["passes"]), ("done", MAX_AUDIT_PASSES + 1), res.get("reason"))
        self.assertIn("監査 r3: 既裁定の再出（再発に数えない）: r3-wr-all-001 ← RS-010", res["notices"])

    def test_再出した項目を後で監査する監査役に前の裁定のIDを渡す(self):
        # r2 の再出（r2-wr-all-001 ← RS-010）の項目を、延長の改稿の後の監査 r3 が見る。
        spec = {"args": args(), "ruled_seq_at": {"6": [["RS-010"]]}, "questions_seq_at": {"6": [[], ["RS-012"]]},
                "about": {"RS-010": {"finding": "r1-wh-all-001"}, "RS-012": {"finding": self.EXTEND["id"]}},
                "findings": {"wholeReviewer:r1": [{"id": "r1-wh-all-001", "route": "decision", "direction": "tighten"}],
                             "writerReviewer:r2": [{"id": "r2-wr-all-001", "direction": "tighten"}, self.EXTEND]},
                "diff": {"r2": ["PR-X-001"], "r3": ["PR-X-001"]}}
        _, after = self._extended(spec, [["PR-X-001"]], [["PR-X-001"]])
        self.assertIn("この文書への前のパスの指摘を裁定した resolution: RS-010", nth_prompt(after, "writerReviewer:r3:all", 0))

    def test_planner_1のdoc_checkの差し戻しは1回で直れば通り直らなければ止まる(self):
        # 設計 3.3a: 上限は MAX_CHECK_REWORK でなく 1 回。減り続けても 2 回目の差し戻しは無い。
        fixed = run({"args": args(), "plan_findings": {"intake": 3, "intake:rework": 0}})
        self.assertEqual(fixed["labels"][:4], ["flow-check:1-entry", "planner:1", "planner:1:rework", "verifier:3v"])
        self.assertEqual(fixed["result"]["status"], "done")
        stuck = run({"args": args(), "plan_findings": {"intake": 3, "intake:rework": 1}})
        self.assertEqual(stuck["labels"], ["flow-check:1-entry", "planner:1", "planner:1:rework"], "減っても 2 回目は差し戻さない")
        self.assertEqual((stuck["result"]["status"], stuck["result"]["next_args"]["from"]), ("blocked", "1"))
        framed = run({"args": args(), "flow_findings_at": {"framer": 3, "rework": 0}})
        self.assertEqual([l for l in framed["labels"] if l.startswith("planner")], ["planner:1", "planner:1:rework"])
        self.assertEqual(framed["result"]["status"], "done")
        left = run({"args": args(), "flow_findings_at": {"framer": 3, "rework": 1}})
        self.assertEqual([l for l in left["labels"] if l.startswith("planner")], ["planner:1", "planner:1:rework"])
        self.assertEqual((left["result"]["status"], left["result"]["next_args"]["from"]), ("blocked", "1"))

    def _settle(self, counts):
        # 段 3 が閉じた O- を引く要素が、settle の回ごとに counts の数だけ残る。
        size = max(const("MAX_SETTLE_ROUNDS"), *counts)
        els = [{"el": f"F-{90 + i:03d}", "open": f"O-RS-{i:03d}"} for i in range(1, size + 1)]
        keys = ["3v-settle"] + [f"3v-settle-{n}" for n in range(2, len(counts) + 1)]
        return run({"args": args(), "flow_open": 1, "ruled_at": {"3": [f"RS-{i:03d}" for i in range(1, size + 1)]},
                    "open_only_at": {"3v": els, **{k: els[:c] for k, c in zip(keys, counts)}}})

    def test_settleは残りが減る間はMAX_SETTLE_ROUNDSまで回り減らなければ止まる(self):
        rounds = const("MAX_SETTLE_ROUNDS")
        verifiers = lambda r: [l for l in r["labels"] if l.startswith("verifier:3v-settle")]
        ok = self._settle([2, 1, 0])
        self.assertEqual(verifiers(ok), ["verifier:3v-settle", "verifier:3v-settle-2", "verifier:3v-settle-3"])
        self.assertIn("F-091", nth_prompt(ok, "planner:3-settle-2", 0))
        self.assertEqual(ok["result"]["status"], "done")
        limit = self._settle(list(range(rounds, 0, -1)))
        self.assertEqual(len(verifiers(limit)), rounds)
        self.assertEqual(limit["result"]["status"], "blocked")
        stuck = self._settle([2, 2, 0])
        self.assertEqual(verifiers(stuck), ["verifier:3v-settle", "verifier:3v-settle-2"])
        self.assertEqual((stuck["result"]["status"], stuck["result"]["next_args"]["from"]), ("blocked", "3"))

    def _questions_rework(self, **kw):
        stale = [{"el": "F-002", "ref": "D-001"}]
        return run({"args": args(), "flow_open": 1, "questions_at": {"3": ["RS-001"]}, "bad_questions_at": ["3"],
                    "supersedes_at": {"1-questions": ["D-001"]}, "stale_refs_at": {"1-questions": stale}, "unverified_at": {"3-settle": ["F-002"]}, **kw})

    def test_問いの形の差し戻しで覆された決定を引く要素は後のverifierのstdoutでsettleする(self):
        # 差し戻しの resolver の後に verifier が doc_check flow を実行するので、settle はその resolver の申告を読まずに verifier の stdout で決まる。
        stale = [{"el": "F-002", "ref": "D-001"}]
        r = self._questions_rework(stale_refs_at={"1-questions": stale, "3v": stale})
        labels = [l for l in r["labels"] if l.startswith(("resolver:", "verifier:", "planner:", "flow-check:"))]
        self.assertEqual(labels[:6], ["flow-check:1-entry", "planner:1", "resolver:1-questions", "verifier:3v", "planner:3-settle", "verifier:3v-settle"])
        self.assertIn("F-002 ← D-001", nth_prompt(r, "planner:3-settle", 0))
        self.assertEqual(r["result"]["status"], "needs_answers")
        # 過大申告: 1-questions の stdout だけが stale_refs を出し、後の verifier（3v）の世界には無い。
        told = self._questions_rework()
        self.assertFalse(has(told["labels"], "planner:3-settle"), "resolver だけが申告した stale_refs では settle しない")

    def test_出口のsettleの後は同じ段のsettleがその後のflowを見て同じ要素を写し直さない(self):
        stale = [{"el": "F-002", "ref": "D-001"}]
        vam = [{"id": "RS-001", "kind": "value_as_method", "reason": "r"}]
        r = run({"args": args(), "flow_open": 1, "ruled_at": {"3": ["RS-001"], "3-fix": ["RS-001"]}, "verifier_fail": {"3v": vam, "3-fixv": vam},
                 "questions_at": {"3-convert": ["RS-001"]}, "bad_questions_at": ["3-convert"], "supersedes_at": {"3-convert-questions": ["D-001"]},
                 "stale_refs_at": {"3-convert": stale, "3-convert-questions": stale, "3-convertv": stale}, "unverified_at": {"3-settle": ["F-002"]}})
        self.assertIn("resolver:3-convert-questions", r["labels"])
        self.assertEqual([l for l in r["labels"] if l.startswith("planner:") and l != "planner:1"], ["planner:3-settle"])
        self.assertEqual(r["result"]["status"], "needs_answers")

    def _settle_at_6(self, **kw):
        # 段 6 が O- を閉じ、その O- を引く要素を settle が直す。
        findings = {"wholeReviewer:r1": [{"id": "r1-wh-all-001", "route": "decision", "direction": "remove"}]}
        spec = {"args": args(), "findings": findings, "ruled_seq_at": {"6": [["RS-010", "RS-090"]]}, "about": {"RS-010": {"finding": "r1-wh-all-001"}},
                "open_only_at": {"6v": [{"el": "F-091", "open": "O-RS-090"}]}}
        spec.update(kw)
        return run(spec)

    def test_settleのlabelは再開で変わらない(self):
        whole = self._settle_at_6()
        settles = lambda r: [l for l in r["labels"] if "settle" in l]
        self.assertEqual(settles(whole), ["planner:6-settle", "verifier:6v-settle"])
        stopped = self._settle_at_6(null_labels=["verifier:6v-settle"])["result"]
        self.assertEqual((stopped["status"], stopped["next_args"]["from"]), ("blocked", "6"), stopped.get("reason"))
        resumed = self._settle_at_6(args=stopped["next_args"])
        self.assertEqual(resumed["result"]["status"], "done", resumed["result"].get("reason"))
        self.assertEqual(settles(resumed), ["planner:6-settle", "verifier:6v-settle"])

    def _settle_each_pass(self, **kw):
        # 1 パス目の段 6 と延長の段 6 が、それぞれ O- を閉じ、その O- を引く要素を settle が直す。r2 の指摘は同じ項目の再発で decision に回り、
        # 延長の段 6 が値で決める（問いが無いので、延長の段 6 の後は finalHold で止まる）。
        about = {"RS-010": {"finding": "r1-wh-all-001"}, "RS-011": {"finding": "r2-wr-all-001"}}
        findings = {"wholeReviewer:r1": [{"id": "r1-wh-all-001", "route": "decision", "direction": "remove"}],
                    "writerReviewer:r2": [{"id": "r2-wr-all-001", "direction": "make_measurable"}]}
        spec = {"args": args(), "findings": findings, "ruled_seq_at": {"6": [["RS-010", "RS-090"], ["RS-011", "RS-091"]]}, "about": about,
                "open_only_at": {"6v": [{"el": "F-091", "open": "O-RS-090"}, {"el": "F-092", "open": "O-RS-091"}]},
                "writer_changed_seq": [["PR-X-001"]], "diff": {"r2": ["PR-X-001"]}}
        spec.update(kw)
        return run(spec)

    def test_settleのlabelは延長のパスでも再開でも変わらない(self):
        # 延長で 1 run に段 6 が 2 回走っても、settle の label はパスによらず同じ（resume が保存された結果を label で引くため）。
        whole = self._settle_each_pass()
        settles = lambda r: [l for l in r["labels"] if "settle" in l]
        self.assertTrue(has(whole["labels"], "resolver:final"), whole["result"].get("reason"))
        self.assertEqual((whole["result"]["status"], whole["result"]["passes"]), ("blocked", MAX_AUDIT_PASSES + 1), whole["result"].get("reason"))
        self.assertEqual(settles(whole), ["planner:6-settle", "verifier:6v-settle"] * 2)
        stopped = self._settle_each_pass(null_labels=["writerReviewer:r2:all"])["result"]
        self.assertEqual((stopped["status"], stopped["next_args"]["from"]), ("blocked", "8"), stopped.get("reason"))
        resumed = self._settle_each_pass(args=stopped["next_args"], ruled_seq_at={"6": [["RS-011", "RS-091"]]}, open_only_at={"6v": [{"el": "F-092", "open": "O-RS-091"}]})
        self.assertEqual((resumed["result"]["status"], resumed["result"]["stop_reason"]), ("blocked", "pass_limit"), resumed["result"].get("reason"))
        self.assertEqual(settles(resumed), ["planner:6-settle", "verifier:6v-settle"])

    def test_settleの中の差し戻しの出口ではsettleを入れ子にしない(self):
        spec = {"args": args(), "flow_open": 1, "ruled_at": {"3": ["RS-001"]}, "questions_at": {"3": ["RS-002"]},
                "open_only_at": {"3v": [{"el": "F-091", "open": "O-RS-001"}]}, "bad_questions_at": ["3-settle"],
                "supersedes_at": {"3-settle-questions": ["D-001"]}, "stale_refs_at": {"3-settle-questions": [{"el": "F-002", "ref": "D-001"}]}}
        r = run(spec)
        self.assertIn("resolver:3-settle-questions", r["labels"])
        self.assertFalse(any("settle-settle" in l for l in r["labels"]), r["labels"])


@unittest.skipIf(shutil.which("node") is None, "node が無い環境ではスキップする")
class LowOnly(unittest.TestCase):
    """監査 r1 の指摘が blocking を含まず、他に改稿の理由も無ければ、段 6〜8 を飛ばして段 9 へ進む（low_only。workflow-io.md §4 の段 5）。
    飛ばした指摘は本文に反映しないまま、返り値の unreflected と skipped で開示する。"""

    LOW = {"writerReviewer:r1": [{"id": "r1-wr-all-001", "blocking": False}], "wholeReviewer:r1": [{"id": "r1-wh-all-001", "item_id": "PR-X-002", "blocking": False}]}
    EXISTING = args(entry="existing", existing_docs=[{"key": "requirements/x", "fixed": False}])

    def _skipped(self, res):
        return [s for s in res["skipped"] if s["fact"] == "low_only"]

    def test_blockingでない指摘だけなら改稿と2巡目の監査を飛ばしてdoneにする(self):
        r = run({"args": args(), "findings": self.LOW})
        res = r["result"]
        self.assertEqual((res["status"], res["passes"], res["tree_digest"]), ("done", 1, "a1"), res.get("reason"))
        self.assertFalse(has(r["labels"], "resolver:6"))
        self.assertFalse(has(r["labels"], "writer:U-1:revise"))
        self.assertFalse(has(r["labels"], "writerReviewer:r2"))
        self.assertFalse(has(r["labels"], "wholeReviewer:r2"))
        [skip] = self._skipped(res)
        self.assertEqual((skip["step"], sorted(skip["ids"])), ("writerReviewer:r2:all", ["r1-wh-all-001", "r1-wr-all-001"]))
        self.assertEqual(sorted(res["unreflected"]), ["r1-wh-all-001", "r1-wr-all-001"], "本文に反映していない指摘の全件")
        self.assertIsNone(res["next_args"])

    def test_指摘が0件ならskippedに積まない(self):
        r = run({"args": args()})
        res = r["result"]
        self.assertEqual(res["status"], "done", res.get("reason"))
        self.assertEqual(self._skipped(res), [])
        self.assertEqual(res["unreflected"], [])
        self.assertFalse(has(r["labels"], "writerReviewer:r2"))

    def test_改稿の理由が1つでもあれば飛ばさない(self):
        # 土台（blocking でない指摘だけ）から 1 点だけ変える。
        blocking = {**self.LOW, "writerReviewer:r1": [*self.LOW["writerReviewer:r1"], {"id": "r1-wr-all-002", "item_id": "PR-X-003"}]}
        for name, extra, launched in (
            ("blocking の指摘 1 件", {"findings": blocking}, "writerReviewer:r2"),
            ("doc_check の blocking 1 件", {"doc_blocking_at": {"r1": 1}}, "writerReviewer:r2"),
            ("新しい TBD", {"new_tbd": ["TBD-RX-001"]}, "resolver:6"),
            ("existing で段 3 の裁定がある（まだ本文に入っていない）", {"args": self.EXISTING, "flow_open": 1, "ruled_at": {"3": ["RS-001"]}}, "writerReviewer:r2"),
        ):
            with self.subTest(name):
                r = run({"args": args(), "findings": self.LOW, **extra})
                res = r["result"]
                self.assertEqual(self._skipped(res), [], res.get("reason"))
                self.assertTrue(has(r["labels"], launched), r["labels"])
        # 持ち越した問い（段 3 の回答待ち）があれば、初稿の監査の後のゲートで聞く。
        asked = run({"args": args(), "findings": self.LOW, "flow_open": 1, "questions_at": {"3": ["RS-001"]}})
        res = asked["result"]
        self.assertEqual((res["status"], res["gate"], res["question_ids"]), ("needs_answers", "g1", ["RS-001"]), res.get("reason"))
        self.assertTrue(has(asked["labels"], "writerReviewer:r1"), "仮の初稿の監査の後に止まる")
        self.assertEqual(self._skipped(res), [])

    def test_docのstdoutが無ければdoc_checkのblockingを数えられないので飛ばさない(self):
        # 指名された whole reviewer が doc の stdout の代わりに JSON の行の無い値（失敗したコマンドの stderr）を返した。写し損ねではないので取り直さない。
        r = run({"args": args(), "findings": self.LOW, "corrupt": {"wholeReviewer:r1:all": {"doc_check": {"literal": "doc_check doc: plan.json がありません"}}}})
        res = r["result"]
        self.assertEqual(self._skipped(res), [], res.get("reason"))
        self.assertTrue(has(r["labels"], "writerReviewer:r2"), r["labels"])

    def test_当てていないroutesがあれば飛ばさない(self):
        # 段 3 の問いを持ち越した run: 仮の初稿の監査 r1 の後の段 6 が RT-010 を返し、ゲートの後に初稿を書き直した。書き直しの writer は
        # routes を当てないので、書き直した初稿の監査 r2 が blocking でない指摘だけでも、段 7 で RT-010 を当てる。
        findings = {"wholeReviewer:r1": [{"id": "r1-wh-all-001", "route": "decision"}], "writerReviewer:r2": [{"id": "r2-wr-all-001", "blocking": False}]}
        g1 = run({"args": args(), "flow_open": 1, "questions_at": {"3": ["RS-001"]}, "findings": findings, "about": {"RS-010": {"finding": "r1-wh-all-001"}},
                  "ruled_at": {"6": ["RS-010"]}, "routes_at": {"6": [{"id": "RT-010", "unit": "U-1"}]}})["result"]
        self.assertEqual((g1["status"], g1["question_ids"]), ("needs_answers", ["RS-001"]), g1.get("reason"))
        r = run({"args": g1["next_args"], "findings": findings, "ruled_at": {"3a": ["RS-001"]}})
        res = r["result"]
        self.assertEqual(res["status"], "done", res.get("reason"))
        self.assertEqual(self._skipped(res), [])
        self.assertIn("RT-010", nth_prompt(r, "writer:U-1:revise", 0), "当てていない routes を段 7 で当てる")
        self.assertTrue(has(r["labels"], "writerReviewer:r3"))

    def test_existingで裁定が無くblockingでない指摘だけなら飛ばす(self):
        r = run({"args": self.EXISTING, "findings": self.LOW})
        res = r["result"]
        self.assertEqual(res["status"], "done", res.get("reason"))
        self.assertFalse(has(r["labels"], "writer:"), "existing は段 4 を通らず、段 5 の後も書かない")
        self.assertEqual(len(self._skipped(res)), 1)

    def test_routeがdecisionでblockingでない指摘は裁定せずunreflectedに残す(self):
        r = run({"args": args(), "findings": {"wholeReviewer:r1": [{"id": "r1-wh-all-001", "route": "decision", "blocking": False}]}})
        res = r["result"]
        self.assertEqual(res["status"], "done", res.get("reason"))
        self.assertFalse(has(r["labels"], "resolver:6"))
        self.assertFalse(has(r["labels"], "resolver:final"))
        self.assertEqual(res["unreflected"], ["r1-wh-all-001"])
        self.assertEqual(res["holds"] + res["hold_drafts"], [], "保持規則にもしない")

    def test_段5と段9の境界でbudgetに達したnext_argsから再開してもunreflectedは同じ(self):
        whole = run({"args": args(), "findings": self.LOW})
        n = len(whole["labels"])
        cut = run({"args": args(), "findings": self.LOW, "budget": {"total": n}})["result"]
        self.assertEqual((cut["status"], cut["stop_reason"], cut["next_args"]["from"]), ("blocked", "budget", "9"), cut.get("reason"))
        self.assertIn("pending", cut["next_args"]["state"])
        again = run({"args": cut["next_args"], "findings": self.LOW})
        self.assertEqual(again["labels"], [], "段 9 は agent を起動しない")
        res = again["result"]
        self.assertEqual(res["status"], "done", res.get("reason"))
        self.assertEqual(sorted(res["unreflected"]), sorted(whole["result"]["unreflected"]))


@unittest.skipIf(shutil.which("node") is None, "node が無い環境ではスキップする")
class AuditTwice(unittest.TestCase):
    """監査は網羅の r1 と範囲の再監査の r2 の 2 回、改稿は 1 回（MAX_AUDIT_PASSES = 1）。r2 の後に writer で直せる blocking が残れば finalHold（pass_limit）。
    r2 の後に blocking の decision の論点が残ったときの延長は Extension が見る。"""

    def test_改稿は1回で監査はr2までにしr2の後に残ればpass_limitで止まる(self):
        self.assertEqual(MAX_AUDIT_PASSES, 1)
        r = run({"args": args(), "findings": new_item_each_round(2)})
        res = r["result"]
        self.assertEqual((res["status"], res["stop_reason"], res["passes"]), ("blocked", "pass_limit", 1), res.get("reason"))
        self.assertEqual(sum(1 for l in r["labels"] if l.startswith("writer:U-1:revise")), 1)
        self.assertTrue(has(r["labels"], "writerReviewer:r2"))
        self.assertFalse(has(r["labels"], "writerReviewer:r3"))
        self.assertIn("resolver:final", r["labels"])
        self.assertEqual((res["remaining_blocking"], sorted(res["unreflected"])), (["r2-wr-all-002"], ["r2-wr-all-002"]))
        self.assertIn("全件は report.md の「本文に反映していない指摘」", res["reason"])
        self.assertIsNone(res["next_args"])

    def test_r2の後にblockingが無ければblockingでない指摘を残してdoneにする(self):
        r = run({"args": args(), "findings": {"writerReviewer:r1": [{"id": "r1-wr-all-001"}], "writerReviewer:r2": [{"id": "r2-wr-all-002", "item_id": "PR-X-002", "blocking": False}]}})
        res = r["result"]
        self.assertEqual((res["status"], res["passes"]), ("done", 1), res.get("reason"))
        self.assertEqual(res["unreflected"], ["r2-wr-all-002"])
        self.assertFalse(any(s["fact"] == "low_only" for s in res["skipped"]), "low_only は r1 の後だけに効く")

    def test_finalHoldのどの経路の返り値にもunreflectedが載る(self):
        base = {"args": args(), "findings": new_item_each_round(2)}
        for name, extra, frm in (
            ("通常", {}, None),
            ("resolver:final の後に flow.json が変わった（flowKept）", {"flow_sha_at": {"final": "f-bad"}}, None),
            ("resolver:final の後の flow-check が別の版を数えた（independentFlow）", {"tamper_before": {"flow-check:final": "outside"}}, None),
        ):
            with self.subTest(name):
                res = run({**base, **extra})["result"]
                self.assertEqual(res["status"], "blocked", res.get("reason"))
                self.assertEqual((res["next_args"] or {}).get("from"), frm, res.get("reason"))
                self.assertEqual((res["report_path"], res["unreflected"], res["remaining_blocking"]), ("/tmp/prd-w/report.md", ["r2-wr-all-002"], ["r2-wr-all-002"]))


@unittest.skipIf(shutil.which("node") is None, "node が無い環境ではスキップする")
class Extension(unittest.TestCase):
    """最後の監査 r2 の後に、まだ裁定の無い blocking の decision の指摘か新しい TBD が残り、聞ける回数があれば、延長のパス
    （段 6 → ゲート → 3a' → 7 → 8、監査 r3）で依頼者に聞く（設計 §1D）。延長は回答を当てた後の 1 回きりで、延長の段 6 が問いを出さなければ
    7 へ進まずに finalHold（pass_limit）にする。延長と resolver:final に渡すのは blocking の decision だけ。"""

    R1 = {"writerReviewer:r1": [{"id": "r1-wr-all-001"}]}
    DEC = {"id": "r2-wr-all-002", "item_id": "PR-X-002", "route": "decision"}
    DEC2 = {"id": "r2-wr-all-003", "item_id": "PR-X-003", "route": "decision"}

    def _findings(self, *r2, r3=None):
        fs = {**self.R1, "writerReviewer:r2": list(r2)}
        if r3 is not None:
            fs["writerReviewer:r3"] = r3
        return fs

    def _revises(self, r):
        return sum(1 for l in r["labels"] if l.startswith("writer:U-1:revise"))

    def _asked(self, res, ids):
        self.assertEqual((res["status"], res.get("gate"), res.get("question_ids")), ("needs_answers", "g1", ids), res.get("reason"))
        self.assertEqual((res["next_args"]["from"], res["next_args"]["state"]["pass"]), ("3a'", MAX_AUDIT_PASSES + 1), "延長のパスは pass 2")

    def test_r2のblockingのdecisionは延長の段6で聞き回答の後に改稿とr3の監査を1回だけ回す(self):
        spec = {"args": args(), "findings": self._findings(self.DEC), "about": {"RS-020": {"finding": self.DEC["id"]}}, "questions_at": {"6": ["RS-020"]}}
        r = run(spec)
        self._asked(r["result"], ["RS-020"])
        self.assertEqual([l for l in r["labels"] if l.startswith("resolver:6")], ["resolver:6"], "r1 の後の段 6 は decision が無く起動しない。起動したのは延長の段 6")
        self.assertIn(f"route が decision の指摘 {self.DEC['id']}", nth_prompt(r, "resolver:6", 0))
        self.assertNotIn(LIMIT_WHY, nth_prompt(r, "resolver:6", 0))
        self.assertNotIn("resolver:final", r["labels"], "聞ける論点は保持規則にしない")
        self.assertEqual(self._revises(r), 1)
        self.assertFalse(has(r["labels"], "writerReviewer:r3"))
        r3_dec = {"id": "r3-wr-all-004", "item_id": "PR-X-004", "route": "decision"}
        for name, r3, want in (
            ("r3 で 0 件", [], ("done", None)),
            ("r3 に writer の blocking が残る", [{"id": "r3-wr-all-004", "item_id": "PR-X-004"}], ("blocked", "pass_limit")),
            ("r3 に blocking の decision が残る（延長は 1 回きり）", [r3_dec], ("blocked", "pass_limit")),
        ):
            with self.subTest(name):
                after = run({**spec, "args": r["result"]["next_args"], "findings": self._findings(self.DEC, r3=r3), "ruled_at": {"3a'": ["RS-020"]}})
                res = after["result"]
                self.assertEqual(after["labels"][:2], ["flow-check:3a'-entry", "resolver:3a'"])
                assert_entry_answers(self, after, "3a'", "g1", ["RS-020"])
                self.assertEqual(self._revises(after), 1, "回答を当てた後に 1 回だけ改稿する")
                self.assertTrue(has(after["labels"], "writerReviewer:r3"), "延長の改稿の後に監査 r3 を当てる")
                self.assertFalse(has(after["labels"], "writerReviewer:r4"))
                self.assertFalse(has(after["labels"], "resolver:6"), "延長は 1 回きりで、r3 の後に段 6 を開かない")
                self.assertEqual((res["status"], res["stop_reason"], res["passes"]), (*want, 2), res.get("reason"))
                if res["status"] == "blocked":
                    self.assertIn("resolver:final", after["labels"])
                    self.assertEqual(res["remaining_blocking"], [r3[0]["id"]])
                    self.assertIsNone(res["next_args"])
                if r3 and r3[0].get("route") == "decision":
                    self.assertIn(f"route が decision の指摘 {r3_dec['id']}", nth_prompt(after, "resolver:final", 0), "延長の後に残った decision は保持規則にする")

    def test_延長の段6が問いを出さなければ改稿もr3の監査もせずにpass_limitで止まり裁定した指摘はresolver_finalに渡さない(self):
        spec = {"args": args(), "findings": self._findings(self.DEC, self.DEC2), "about": {"RS-021": {"finding": self.DEC["id"]}}, "ruled_at": {"6": ["RS-021"]}}
        r = run(spec)
        res = r["result"]
        self.assertEqual((res["status"], res["stop_reason"], res["passes"]), ("blocked", "pass_limit", 2), res.get("reason"))
        self.assertEqual([l for l in r["labels"] if l.startswith("resolver:6")], ["resolver:6"], "延長の段 6 は起動する")
        self.assertEqual(self._revises(r), 1, "回答の無いまま改稿を増やさない")
        self.assertFalse(has(r["labels"], "writerReviewer:r3"), "回答の無いまま監査を増やさない")
        final = nth_prompt(r, "resolver:final", 0)
        self.assertIn(f"route が decision の指摘 {self.DEC2['id']}", final, "延長の段 6 が裁定しなかった blocking の decision は保持規則にする")
        self.assertNotIn(self.DEC["id"], final, "延長の段 6 が裁定した指摘を渡し直すと、同じ論点に 2 つ目の裁定を put させる")
        self.assertEqual(sorted(res["unreflected"]), [self.DEC["id"], self.DEC2["id"]], "ruled で決めた値も本文には入っていない")
        self.assertIsNone(res["next_args"])

    def test_延長の段6の問いとruledが混ざれば回答の後の改稿に両方の裁定を渡す(self):
        about = {"RS-020": {"finding": self.DEC["id"]}, "RS-021": {"finding": self.DEC2["id"]}}
        spec = {"args": args(), "findings": self._findings(self.DEC, self.DEC2), "about": about, "questions_at": {"6": ["RS-020"]}, "ruled_at": {"6": ["RS-021"]}}
        g = run(spec)
        self._asked(g["result"], ["RS-020"])
        self.assertEqual(self._revises(g), 1, "ruled があっても回答の前に改稿しない")
        after = run({**spec, "args": g["result"]["next_args"], "ruled_at": {"3a'": ["RS-020"]}})
        res = after["result"]
        self.assertEqual(res["status"], "done", res.get("reason"))
        revise = nth_prompt(after, "writer:U-1:revise", 0)
        self.assertIn("RS-020", revise, "回答を当てた裁定")
        self.assertIn("RS-021", revise, "延長の段 6 が ruled で決めた裁定")
        self.assertTrue(has(after["labels"], "writerReviewer:r3"))

    def test_r2にwriterのblockingとblockingでないdecisionだけなら延長せずresolver_finalにも渡さない(self):
        low = {**self.DEC2, "blocking": False}
        r = run({"args": args(), "findings": self._findings({"id": "r2-wr-all-002", "item_id": "PR-X-002"}, low)})
        res = r["result"]
        self.assertEqual((res["status"], res["stop_reason"], res["passes"]), ("blocked", "pass_limit", 1), res.get("reason"))
        self.assertFalse(has(r["labels"], "resolver:6"), "writer で直せる blocking だけでは延長しない")
        self.assertNotIn(low["id"], nth_prompt(r, "resolver:final", 0), "blocking でない decision は保持規則にしない")
        self.assertEqual(sorted(res["unreflected"]), ["r2-wr-all-002", low["id"]])

    def test_改稿で出た新しいTBDも延長の段6に渡す(self):
        r = run({"args": args(), "findings": self.R1, "new_tbd_revise": ["TBD-RX-001"]})
        res = r["result"]
        self.assertEqual([l for l in r["labels"] if l.startswith("resolver:6")], ["resolver:6"])
        self.assertIn("TBD-RX-001", nth_prompt(r, "resolver:6", 0))
        self.assertEqual((res["status"], res["stop_reason"]), ("blocked", "pass_limit"), res.get("reason"))
        self.assertFalse(has(r["labels"], "writerReviewer:r3"))

    def test_延長の段6から入ったfinalHoldはresolver_finalのholdを問いに書き換え直させない(self):
        # 延長の段 6 は聞ける段なので、そこから入った finalHold の resolver:final の hold は、聞ける段の「script が指定しない hold」の検査に
        # 掛かりうる。輪を出た後は聞かない（closing）ので、書き換え直させずに文案（hold_drafts）で返す。
        about = {"RS-021": {"finding": self.DEC["id"]}, "RS-030": {"finding": self.DEC2["id"]}}
        spec = {"args": args(), "findings": self._findings(self.DEC, self.DEC2), "about": about, "ruled_at": {"6": ["RS-021"]}, "holds_at": {"final": ["RS-030"]}}
        r = run(spec)
        res = r["result"]
        self.assertEqual((res["status"], res["stop_reason"]), ("blocked", "pass_limit"), res.get("reason"))
        self.assertTrue(has(r["labels"], "resolver:6"), "延長の段 6 から finalHold に入る")
        self.assertIn("resolver:final", r["labels"])
        self.assertNotIn("resolver:final-toquestion", r["labels"])
        self.assertIn("RS-030", res["hold_drafts"])
        # 対照: closing を外すと、resolver:final の hold が問いに書き換え直させられ、文案が残らない。
        broken = run(spec, patch=[("  closing = true\n", "")])
        self.assertIn("resolver:final-toquestion", broken["labels"])
        self.assertNotIn("RS-030", broken["result"]["hold_drafts"])

    def test_聞ける回数が尽きていれば延長せずblockingのdecisionをresolver_finalで保持規則にする(self):
        spec = {"args": args(), "findings": self._findings(self.DEC)}
        stopped = run({**spec, "null_labels": ["writerReviewer:r2:all"]})["result"]
        self.assertEqual((stopped["status"], stopped["next_args"]["from"]), ("blocked", "8"), stopped.get("reason"))
        limit = run({**spec, "args": at_limit(stopped["next_args"])})
        res = limit["result"]
        self.assertEqual((res["status"], res["stop_reason"], res["passes"]), ("blocked", "pass_limit", 1), res.get("reason"))
        self.assertFalse(has(limit["labels"], "resolver:6"), "聞けないので延長しない")
        self.assertIn(f"route が decision の指摘 {self.DEC['id']}", nth_prompt(limit, "resolver:final", 0))
        # 対照: 同じ段 8 から聞ける回数を残して始めると延長の段 6 を開く。
        self.assertTrue(has(run({**spec, "args": stopped["next_args"]})["labels"], "resolver:6"))


@unittest.skipIf(shutil.which("node") is None, "node が無い環境ではスキップする")
class SpecOnlyQuestions(unittest.TestCase):
    """仕様書だけを書く run でも、仕様の論点（ruling が question・layer が「手段」・upstream_revision が無く、plan reviewer が合格にした問い。
    doc_check flow --rulings の行の spec_layer）は依頼者に聞き、要求の論点が 1 件でもあれば upstream_gap で止める（設計 §2）。
    stub では spec_layer_ids の ID が、台帳で layer が「手段」で upstream_revision の無い resolution である。"""

    SPEC = {"id": "r1-wh-all-001", "doc": "specifications/x", "item_id": "SP-X-001", "route": "decision"}
    ASK_LAYER = "仕様書だけを書く run: 問いには `layer` を付ける"
    CHECK_LAYER = "問いの `layer` を確かめる（plan-reviewer.md）"

    def _expand(self, **kw):
        a = args(entry="expand", existing_docs=[{"key": "requirements/x", "fixed": True}, {"key": "specifications/x", "fixed": False}])
        return {"args": a, "units": [{"id": "U-1", "docs": ["specifications/x"], "depends_on": []}], **kw}

    def test_段3の仕様の論点は初稿の監査の後のg1で聞き回答の後の続きの問いは持ち越さずに聞く(self):
        spec = self._expand(flow_open=1, questions_at={"3": ["RS-001"]}, spec_layer_ids=["RS-001", "RS-002"])
        # 最初のゲートの前は、今と同じく問いを持ち越して初稿と監査で出る論点も集める。持ち越すので state.deferred が立つ。
        stopped = run({**spec, "null_labels": ["writerReviewer:r1:all"]})["result"]
        self.assertEqual((stopped["status"], stopped["next_args"]["from"]), ("blocked", "5"), stopped.get("reason"))
        self.assertIs(stopped["next_args"]["state"].get("deferred"), True, "仕様書だけの run も持ち越しを記録し、ゲートの後に 3a から初稿を書き直す")
        r = run(spec)
        res = r["result"]
        self.assertEqual((res["status"], res.get("gate"), res.get("question_ids")), ("needs_answers", "g1", ["RS-001"]), res.get("reason"))
        self.assertEqual(res["next_args"]["from"], "3a")
        self.assertTrue(has(r["labels"], "writer:U-1:draft") and has(r["labels"], "writerReviewer:r1"), "初稿と監査で出る論点も集めてから聞く")
        self.assertFalse(has(r["labels"], "writer:U-1:revise"))
        # 回答の反映から出た続きの問い（仕様の論点。3a が出して組み直しの 3b へ渡す）は、最初のゲートの後なので持ち越さずにすぐ聞く
        # （初稿を書き直す前に止まる）。
        cont = {**spec, "args": res["next_args"], "ruled_at": {"3a": ["RS-001"]}, "questions_at": {"3a": ["RS-002"]}}
        g2 = run(cont)
        res2 = g2["result"]
        self.assertEqual((res2["status"], res2.get("gate"), res2.get("question_ids")), ("needs_answers", "g2", ["RS-002"]), res2.get("reason"))
        self.assertEqual(res2["next_args"]["from"], "3a")
        self.assertFalse(has(g2["labels"], "writer"), "回答待ちの問いを持って初稿へ進まない")
        self.assertFalse(has(g2["labels"], "writerReviewer"))
        done = run({**spec, "args": res2["next_args"], "ruled_at": {"3a": ["RS-002"]}})
        self.assertEqual(done["result"]["status"], "done", done["result"].get("reason"))
        self.assertTrue(has(done["labels"], "writer:U-1:draft"), "回答の後に初稿を書き直す")
        self.assertEqual([l for l in done["labels"] if l.startswith("writerReviewer:")], ["writerReviewer:r2:all"], "書き直した初稿の監査は 1 回だけ")

    def test_要求の論点が1件でもあれば要求の論点だけをupstream_gapで返す(self):
        r = run(self._expand(flow_open=2, questions_at={"3": ["RS-001", "RS-002"]}, spec_layer_ids=["RS-001"]))
        res = r["result"]
        self.assertEqual((res["status"], res["stop_reason"], res["question_ids"], res["next_args"]), ("blocked", "upstream_gap", ["RS-002"], None), res.get("reason"))
        self.assertIn("仕様書の範囲の問い 1 件", res["reason"])
        self.assertIn("要求文書を改訂した後の run で聞く", res["reason"])
        self.assertNotIn("gate", res)
        # 対照: 全部が仕様の論点ならゲートで聞く。
        both = run(self._expand(flow_open=2, questions_at={"3": ["RS-001", "RS-002"]}, spec_layer_ids=["RS-001", "RS-002"]))["result"]
        self.assertEqual((both["status"], both.get("question_ids")), ("needs_answers", ["RS-001", "RS-002"]), both.get("reason"))

    def test_延長の段6でも仕様の論点だけなら聞き要求の論点ならupstream_gapにする(self):
        findings = {"writerReviewer:r1": [{"id": "r1-wr-all-001", "doc": "specifications/x", "item_id": "SP-X-001"}],
                    "writerReviewer:r2": [{"id": "r2-wr-all-002", "doc": "specifications/x", "item_id": "SP-X-002", "route": "decision"}]}
        base = self._expand(findings=findings, writer_changed=["SP-X-001"], diff={"r2": ["SP-X-001"]}, about={"RS-020": {"finding": "r2-wr-all-002"}}, questions_at={"6": ["RS-020"]})
        up = run(base)["result"]
        self.assertEqual((up["status"], up["stop_reason"], up.get("question_ids"), up["next_args"]), ("blocked", "upstream_gap", ["RS-020"], None), up.get("reason"))
        asked = run({**base, "spec_layer_ids": ["RS-020"]})["result"]
        self.assertEqual((asked["status"], asked.get("gate"), asked.get("question_ids")), ("needs_answers", "g1", ["RS-020"]), asked.get("reason"))
        self.assertEqual((asked["next_args"]["from"], asked["next_args"]["state"]["pass"]), ("3a'", MAX_AUDIT_PASSES + 1))

    def test_延長の段6で字数の上限を超えても要求の論点はupstream_gapにする(self):
        # 要求の論点は字数の上限より先に upstream_gap にする（保持規則にすると、要求文書に無い判断が仕様書の本文にだけ入る）。延長の段 6 の
        # 字数の判定だけを真にする patch で、上限を超えた形を作る。
        findings = {"writerReviewer:r1": [{"id": "r1-wr-all-001", "doc": "specifications/x", "item_id": "SP-X-001"}],
                    "writerReviewer:r2": [{"id": "r2-wr-all-002", "doc": "specifications/x", "item_id": "SP-X-002", "route": "decision"}]}
        base = self._expand(findings=findings, writer_changed=["SP-X-001"], diff={"r2": ["SP-X-001"]}, about={"RS-020": {"finding": "r2-wr-all-002"}}, questions_at={"6": ["RS-020"]})
        over = ("const over = extended && pendingQuestions(state).length > 0 && extensionOver(state)", "const over = extended && pendingQuestions(state).length > 0")
        up = run(base, patch=[over])
        res = up["result"]
        self.assertEqual((res["status"], res["stop_reason"], res.get("question_ids"), res["next_args"]), ("blocked", "upstream_gap", ["RS-020"], None), res.get("reason"))
        self.assertFalse(has(up["labels"], "resolver:6-hold"), "要求の論点を保持規則にしない")
        # 対照: 仕様の論点なら、上限を超えるので聞かずに保持規則にして輪を出る。
        spec_q = run({**base, "spec_layer_ids": ["RS-020"]}, patch=[over])
        res2 = spec_q["result"]
        self.assertEqual((res2["status"], res2["stop_reason"]), ("blocked", "pass_limit"), res2.get("reason"))
        self.assertIn("resolver:6-hold", spec_q["labels"])
        self.assertIn("延長すると next_args が打ち直しの上限", nth_prompt(spec_q, "resolver:6-hold", 0))

    def test_聞ける回数を使い切った後も要求の論点はupstream_gapにする(self):
        # 聞けない段でも、仕様書だけを書く run の要求の論点は question のまま受け取り、保持規則にせずに upstream_gap にする（C-b の前と同じ扱い）。
        spec = self._expand(findings={"wholeReviewer:r1": [self.SPEC]}, about={"RS-010": {"finding": self.SPEC["id"]}}, questions_at={"6": ["RS-010"]})
        start = stage6_at_limit(spec)
        r = run({**spec, "args": start})
        res = r["result"]
        self.assertIn(LIMIT_WHY, nth_prompt(r, "resolver:6", 0), "聞けない段で確かめる")
        self.assertIn("仕様書だけを書く run: `layer: 要求` の問いは hold にせず question のまま返す", nth_prompt(r, "resolver:6", 0))
        self.assertEqual((res["status"], res["stop_reason"], res.get("question_ids"), res["next_args"]), ("blocked", "upstream_gap", ["RS-010"], None), res.get("reason"))
        self.assertFalse(has(r["labels"], "resolver:6-hold"))
        self.assertFalse(has(r["labels"], "writer:U-1:revise"), "要求の論点を本文に入れない")
        # 対照: 仕様の論点なら、聞けないので保持規則にして改稿へ進む。
        held = run({**spec, "args": start, "spec_layer_ids": ["RS-010"]})
        self.assertIn("resolver:6-hold", held["labels"], held["result"].get("reason"))
        self.assertNotEqual(held["result"].get("stop_reason"), "upstream_gap")
        # 対照: 仕様書だけの run でなければ、聞けない段の問いは今どおり受け取らない。
        other = {"findings": {"wholeReviewer:r1": [{"id": "r1-wh-all-001", "route": "decision"}]}, "about": {"RS-010": {"finding": "r1-wh-all-001"}}, "questions_at": {"6": ["RS-010"]}}
        plain = run({"args": stage6_at_limit({"args": args(), **other}), **other})
        self.assertNotIn("仕様書だけを書く run", nth_prompt(plain, "resolver:6", 0))
        self.assertNotEqual(plain["result"].get("stop_reason"), "upstream_gap")

    def test_最初のゲートの後は回答待ちの問いを持って段を出ればexitViolationが止める(self):
        # 持ち越し（carrying）を最初のゲートの前に限る。ゲートを開いた後の仕様書だけの run が、聞くゲートを通らずに問いを持って段を出たら止める。
        spec = self._expand(findings={"wholeReviewer:r1": [self.SPEC]}, about={"RS-010": {"finding": self.SPEC["id"]}}, questions_at={"6": ["RS-010"]}, spec_layer_ids=["RS-010"])
        stopped = run({**spec, "null_labels": ["resolver:6"]})["result"]
        self.assertEqual((stopped["status"], stopped["next_args"]["from"]), ("blocked", "6"), stopped.get("reason"))
        leak = ("needsAnswers(\"3a'\", '7')", "'7'")
        res = run({**spec, "args": with_state(stopped["next_args"], gates=1)}, patch=[leak])["result"]
        self.assertEqual(res["status"], "blocked", res.get("reason"))
        self.assertIn("回答待ちの問い RS-010 を、聞くゲートも保持規則への変換も通らないまま段を出ようとしました", res["reason"])

    def test_layerの不合格を受け取り差し戻しに載せる(self):
        kinds = re.search(r"^const FAIL_KINDS = \[(.*)\]$", PRD.read_text(encoding="utf-8"), re.M).group(1)
        self.assertIn("'layer'", kinds, "verifier の schema の enum（FAIL_KINDS）に layer がある")
        contract = (SKILL / "schemas" / "agent-contracts.md").read_text(encoding="utf-8")
        lines = contract.splitlines()
        start = next(i for i, l in enumerate(lines) if l.startswith("- `fail_kind`: "))
        # 項目は折り返して次の行へ続くので、次の項目か空行の手前までを 1 つの定義として読む。
        end = next((i for i in range(start + 1, len(lines)) if lines[i].startswith("- ") or not lines[i].strip()), len(lines))
        definition = "\n".join(lines[start:end])
        self.assertIn("`layer` = ", definition, "契約の fail_kind の定義に layer の意味がある")
        fail = {"id": "RS-001", "kind": "layer", "reason": "どの候補でも固定の要求文書の文が変わる"}
        r = run(self._expand(flow_open=1, questions_at={"3": ["RS-001"], "3-fix": ["RS-001"]}, spec_layer_ids=["RS-001"], verifier_fail={"3v": [fail]}))
        self.assertEqual([l for l in r["labels"] if l.startswith(("resolver:3", "verifier:3"))][:3], ["verifier:3v", "resolver:3-fix", "verifier:3-fixv"], "一般の差し戻しの経路を通る")
        self.assertIn("- RS-001: layer（どの候補でも固定の要求文書の文が変わる）", nth_prompt(r, "resolver:3-fix", 0))
        res = r["result"]
        self.assertEqual((res["status"], res.get("question_ids")), ("needs_answers", ["RS-001"]), res.get("reason"))

    def test_仕様書だけのrunだけ裁定と検証のプロンプトで問いのlayerを求める(self):
        spec = {"findings": {"wholeReviewer:r1": [self.SPEC]}, "about": {"RS-010": {"finding": self.SPEC["id"]}}, "questions_at": {"6": ["RS-010"]}}
        only = run(self._expand(**spec, spec_layer_ids=["RS-010"]))
        self.assertIn(self.ASK_LAYER, nth_prompt(only, "resolver:6", 0))
        for label in ("verifier:3v", "verifier:6v"):
            self.assertIn(self.CHECK_LAYER, nth_prompt(only, label, 0), label)
        other = run({"args": args(), **spec, "findings": {"wholeReviewer:r1": [{"id": "r1-wh-all-001", "route": "decision"}]}})
        self.assertEqual(other["result"]["status"], "needs_answers", other["result"].get("reason"))
        self.assertNotIn(self.ASK_LAYER, nth_prompt(other, "resolver:6", 0))
        for label in ("verifier:3v", "verifier:6v"):
            self.assertNotIn(self.CHECK_LAYER, nth_prompt(other, label, 0), "仕様書だけの run でなければ layer の fail を出させない")


@unittest.skipIf(shutil.which("node") is None, "node が無い環境ではスキップする")
class StaticQuoteReject(unittest.TestCase):
    """指名された whole reviewer が判定の前に doc_check quotes を実行し、script は quote がどの原文にも無い（not_found）writer reviewer の
    指摘を退ける（workflow-io.md §4 の段 5・段 8）。照合の stdout が期待と合わなければ退けずに integrity に 1 行出す。"""

    TWO = {"writerReviewer:r1": [{"id": "r1-wr-all-001"}, {"id": "r1-wr-all-002", "item_id": "PR-X-002"}]}
    NOTE = "監査 r1: 引用がどの原文にも無い writer reviewer の指摘 1 件を退けた: r1-wr-all-002（/tmp/prd-w/checks/quotes-r1.json）"

    def _quote_notes(self, res):
        return [n for n in res["notices"] if "引用がどの原文にも無い" in n]

    def test_段5の指名にquotesのコマンドをdocの後に置きスキーマに欄がある(self):
        r = run({"args": args(), "units": docs_units(5), "findings": {"writerReviewer:r1:p1": [{"id": "r1-wr-p1-001", "doc": "requirements/d1", "item_id": "PR-D1-001"}]}})
        prompt = nth_prompt(r, "wholeReviewer:r1:all", 0)
        quotes = prompt.index("doc_check.mjs quotes --workspace /tmp/prd-w --findings r1-wr-p1,r1-wr-p2` → designated.quotes")
        self.assertLess(prompt.index("doc_check.mjs doc --workspace /tmp/prd-w"), quotes)
        self.assertLess(quotes, prompt.index("doc_check.mjs snapshot --workspace /tmp/prd-w --save audited-1"))
        self.assertIn("quotes", r["auditSchema"]["properties"]["designated"]["properties"])
        r8 = nth_prompt(r, "wholeReviewer:r2:all", 0)
        quotes8 = r8.index("doc_check.mjs quotes --workspace /tmp/prd-w --findings r2-wr-p1,r2-wr-p2` → designated.quotes")
        self.assertLess(r8.index("doc_check.mjs diff --workspace /tmp/prd-w --against audited-1"), quotes8)
        self.assertLess(quotes8, r8.index("doc_check.mjs snapshot --workspace /tmp/prd-w --save audited-2"))

    def test_引用が無い指摘はblockingにも改稿にも入らずnoticesに出る(self):
        r = run({"args": args(), "findings": self.TWO, "unquoted_at": {"r1": ["r1-wr-all-002"]}})
        res = r["result"]
        self.assertEqual(res["status"], "done", res.get("reason"))
        revise = nth_prompt(r, "writer:U-1:revise", 0)
        self.assertIn("r1-wr-all-001", revise)
        self.assertNotIn("r1-wr-all-002", revise)
        self.assertEqual(self._quote_notes(res), [self.NOTE])
        self.assertNotIn("r1-wr-all-002", res["unreflected"], "退けた指摘は本文に反映していない指摘に含めない")
        self.assertEqual(res["integrity"], [])
        # 退けた 1 件だけなら blocking は残らず、改稿も 2 巡目も無い。
        only = run({"args": args(), "findings": {"writerReviewer:r1": [{"id": "r1-wr-all-002", "item_id": "PR-X-002"}]}, "unquoted_at": {"r1": ["r1-wr-all-002"]}})
        self.assertFalse(has(only["labels"], "writer:U-1:revise"))
        self.assertEqual((only["result"]["status"], only["result"]["unreflected"]), ("done", []))

    def test_whole_reviewerのrejectedと重なるIDはquotesの行にだけ出る(self):
        three = {"writerReviewer:r1": [*self.TWO["writerReviewer:r1"], {"id": "r1-wr-all-003", "item_id": "PR-X-003"}]}
        res = run({"args": args(), "findings": three, "unquoted_at": {"r1": ["r1-wr-all-002"]}, "rejected_at": {"r1": ["r1-wr-all-002", "r1-wr-all-003"]}})["result"]
        self.assertEqual(self._quote_notes(res), [self.NOTE])
        self.assertIn("監査 r1: whole reviewer が writer reviewer の指摘 1 件を退けた: r1-wr-all-003（理由は /tmp/prd-w/findings/r1-wh-all.json の rejected）", res["notices"])
        self.assertEqual(res["integrity"], [])

    def test_照合のstdoutが期待と合わなければ退けずにintegrityに1行出す(self):
        for name, extra, why in (
            ("照らした findings が違う", {"quotes_files_at": {"r1": ["r1-wr-p9"]}}, "照らした findings が期待と違う"),
            ("照合の版が監査の基準と違う", {"quotes_digest_at": {"r1": "a-other"}}, "照合の版が監査の基準と違う"),
            ("quotes を返さない", {"no_quotes_at": ["r1"]}, "quote の照合の stdout が無い"),
        ):
            with self.subTest(name):
                r = run({"args": args(), "findings": self.TWO, "unquoted_at": {"r1": ["r1-wr-all-002"]}, **extra})
                res = r["result"]
                self.assertIn("r1-wr-all-002", nth_prompt(r, "writer:U-1:revise", 0), "退けない向きに倒す")
                self.assertEqual(self._quote_notes(res), [])
                self.assertEqual(len(res["integrity"]), 1, res["integrity"])
                self.assertIn(why, res["integrity"][0])

    def test_同じ回のwriter_reviewerの指摘に無いIDは退けない(self):
        findings = {**self.TWO, "wholeReviewer:r1": [{"id": "r1-wh-all-001", "item_id": "PR-X-003"}]}
        r = run({"args": args(), "findings": findings, "unquoted_at": {"r1": ["r1-wr-all-009", "r1-wh-all-001"]}})
        res = r["result"]
        revise = nth_prompt(r, "writer:U-1:revise", 0)
        for id_ in ("r1-wr-all-001", "r1-wr-all-002", "r1-wh-all-001"):
            self.assertIn(id_, revise)
        self.assertEqual(self._quote_notes(res), [])

    def test_写し損ねたquotesは取り直して退ける(self):
        self.assertIn("doc_check.mjs quotes --workspace /tmp/prd-w --findings r1-wr-all`", nth_prompt(run({"args": args(), "findings": self.TWO}), "wholeReviewer:r1:all", 0))
        r = run({"args": args(), "findings": self.TWO, "unquoted_at": {"r1": ["r1-wr-all-002"]},
                 "corrupt": {"wholeReviewer:r1:all": {"quotes": {"drop": "unquoted"}}}})
        self.assertIn("doc_check.mjs quotes --workspace /tmp/prd-w --findings r1-wr-all`", nth_prompt(r, "flow-check:wholeReviewer-r1-all-recopy", 0))
        self.assertEqual(self._quote_notes(r["result"]), [self.NOTE])

    def test_段8でも引用が無い指摘を退ける(self):
        findings = {"writerReviewer:r1": [{"id": "r1-wr-all-001"}], "writerReviewer:r2": [{"id": "r2-wr-all-002", "item_id": "PR-X-002"}]}
        kept = run({"args": args(), "findings": findings})["result"]
        self.assertEqual(kept["status"], "blocked", "退けなければ r2 の blocking が残る（この照合の前提）")
        res = run({"args": args(), "findings": findings, "unquoted_at": {"r2": ["r2-wr-all-002"]}})["result"]
        self.assertEqual((res["status"], res["unreflected"]), ("done", []), res.get("reason"))
        self.assertEqual(self._quote_notes(res), ["監査 r2: 引用がどの原文にも無い writer reviewer の指摘 1 件を退けた: r2-wr-all-002（/tmp/prd-w/checks/quotes-r2.json）"])


@unittest.skipIf(shutil.which("node") is None, "node が無い環境ではスキップする")
class PlannerStages(unittest.TestCase):
    """段 1〜3・settle・3b の生成側を planner 1 体の起動にまとめた形（設計 A-C2 の 6.3）。

    planner:1 は仕分け → 流れ → 裁定を 1 体で行い、段 3 は planner の裁定を resolver なしで受け取って verifier:3v から始める。
    settle と 3b の planner は流れ → 裁定を 1 体で行い、裁定し漏らした組と O- だけを保険の resolver に回す。"""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.world = str(Path(self._tmp.name) / "world.json")

    def tearDown(self):
        self._tmp.cleanup()

    D = {"FLOW_DESTRUCTIVE_UNCONSTRAINED": ["F-053"]}
    SETTLE = {"flow_open": 1, "ruled_at": {"3": ["RS-001"]}, "open_only_at": {"3v": [{"el": "F-091", "open": "O-RS-001"}]}}

    def test_段1から3はplanner_1とverifier_3vの2体でplannerの裁定を検証する(self):
        r = run({"args": args(), "flow_open": 1, "ruled_at": {"3": ["RS-001"]}})
        self.assertEqual(r["labels"][:3], ["flow-check:1-entry", "planner:1", "verifier:3v"])
        self.assertFalse([l for l in r["labels"] if l in ("intake", "flow-framer", "resolver:3") or l.startswith(("intake:", "flow-framer:"))], r["labels"])
        self.assertEqual(ids_of_verifier(r, "verifier:3v"), ["RS-001"], "planner:1 の裁定が verifier:3v の検証する ID に載る")
        self.assertEqual(r["result"]["status"], "done", r["result"].get("reason"))

    def test_planner_1の差し戻しは不合格をまとめて1回でやり直す範囲をプロンプトで決める(self):
        plan = run({"args": args(), "plan_findings": {"intake": 2}})
        self.assertEqual(plan["labels"][:4], ["flow-check:1-entry", "planner:1", "planner:1:rework", "verifier:3v"])
        rework = nth_prompt(plan, "planner:1:rework", 0)
        self.assertIn("doc_check plan の指摘が 2 件", rework)
        self.assertIn("「仕分け」から直して返す", rework, "plan が落ちていれば仕分けから")
        self.assertIn("doc_check.mjs plan --workspace", rework)
        self.assertEqual(plan["result"]["status"], "done")
        flow = run({"args": args(), "flow_findings_at": {"framer": 1}})
        rework = nth_prompt(flow, "planner:1:rework", 0)
        self.assertIn("「流れ」から直して返す", rework, "plan が通っていれば流れから")
        self.assertNotIn("「仕分け」から", rework)
        both = run({"args": args(), "plan_findings": {"intake": 2}, "flow_findings_at": {"framer": 1}})
        self.assertEqual(both["labels"].count("planner:1:rework"), 1, "不合格ごとに起動しない")
        rework = nth_prompt(both, "planner:1:rework", 0)
        self.assertIn("doc_check plan の指摘が 2 件", rework)
        self.assertIn("指摘が 1 件", rework)
        self.assertIn("「仕分け」から直して返す", rework)
        for name, kw in (("plan が直らない", {"plan_findings": {"intake": 1, "intake:rework": 1}}), ("plan の stdout が無い", {"plan_findings": {"intake": None, "intake:rework": None}}),
                         ("flow が直らない", {"flow_findings_at": {"framer": 1, "rework": 1}}), ("差し戻しが応答しない", {"plan_findings": {"intake": 1}, "null_labels": ["planner:1:rework"]})):
            with self.subTest(name):
                r = run({"args": args(), **kw})
                self.assertEqual(r["labels"], ["flow-check:1-entry", "planner:1", "planner:1:rework"], "2 回目の差し戻しは無い")
                res = r["result"]
                self.assertEqual((res["status"], res["next_args"]["from"], res["next_args"]["state"]), ("blocked", "1", {}), res.get("reason"))

    def test_流れからの差し戻しは仕分けの結果を前の体から引き継ぎplan_checkを求めない(self):
        # flow だけが落ちた差し戻しの体は仕分けをやり直さない。plan_check を返さなくても、前の体の plan_check で進む（plan は段 3 の plan reviewer が照らし直す）。
        r = run({"args": args(), "flow_findings_at": {"framer": 1}, "plan_findings": {"intake:rework": None}})
        self.assertEqual(r["labels"][:4], ["flow-check:1-entry", "planner:1", "planner:1:rework", "verifier:3v"])
        rework = nth_prompt(r, "planner:1:rework", 0)
        self.assertNotIn("doc_check.mjs plan --workspace", rework, "流れからやり直す体に plan の実行を求めない")
        self.assertIn("plan_check は返さない", rework)
        self.assertEqual(r["result"]["status"], "done", r["result"].get("reason"))
        # 仕分けからの差し戻しは plan_check を求め、返さなければ止まる（引き継がない）。
        plan = run({"args": args(), "plan_findings": {"intake": 1, "intake:rework": None}})
        self.assertIn("doc_check.mjs plan --workspace", nth_prompt(plan, "planner:1:rework", 0))
        self.assertEqual((plan["result"]["status"], plan["result"]["next_args"]["from"]), ("blocked", "1"))

    def test_verifierのschemaはplan_checkを任意の欄として宣言する(self):
        # 段 3 の最初の検証が返す plan_check を schema が宣言しないと、宣言外の欄を落とす runtime では全ての run が 3v の plan の照合で止まる。
        src = PRD.read_text(encoding="utf-8")
        body = src[src.index("const VERIFIER_SCHEMA = {"):]
        body = body[: body.index("\n}\n")]
        props = body[body.index("properties: {"): body.rindex("\n  required:")]
        self.assertRegex(props, r"\n    plan_check: STR,")
        self.assertNotIn("plan_check", body[body.rindex("\n  required:"):])

    def test_差し戻しの体の裁定は元の裁定と合わさり同じIDは差し戻しの種類になる(self):
        r = run({"args": args(), "flow_open": 2, "ruled_at": {"3": ["RS-002"], "rework": ["RS-001"]}, "questions_at": {"3": ["RS-001"]},
                 "flow_findings_at": {"framer": 1}, "open_ids_at": {"rework": ["O-RS-001", "O-RS-002"]}})
        rework = nth_prompt(r, "planner:1:rework", 0)
        self.assertIn("前の体が question にした RS-001", rework, "questions --check に前の体の問いも含めさせる")
        self.assertIn("前の体が書いた裁定は resolutions.json にある", rework)
        self.assertEqual(sorted(ids_of_verifier(r, "verifier:3v")), ["RS-001", "RS-002"], "両方の体の裁定を検証する")
        res = r["result"]
        self.assertEqual(res["status"], "done", "差し戻しの体が RS-001 を値の裁定にしたので、問いとしては聞かない")
        self.assertNotIn("RS-001", (res.get("next_args") or {}).get("state", {}).get("questions", []))

    def test_段3で止まった再実行は入口でplannerの裁定を受け取りverifier_3vから進む(self):
        spec = {"flow_open": 1, "ruled_at": {"3": ["RS-001"]}, "world": self.world}
        whole = run({"args": args(), **spec})
        Path(self.world).unlink()
        stopped_run = run({"args": args(), **spec, "null_labels": ["verifier:3v"]})
        stopped = stopped_run["result"]
        self.assertEqual((stopped["status"], stopped["next_args"]["from"]), ("blocked", "3"), stopped.get("reason"))
        self.assertEqual(stopped["next_args"]["state"]["tx"]["restore"], "t2", "段 3 の token の書き込みだけを戻す（planner:1 の t1 の書き込みは残る）")
        self.assertIn("RS-001", [x["id"] for x in stopped_run["disk"]["resolutions"]])
        again = run({"args": stopped["next_args"], **spec})
        self.assertEqual(again["labels"][:3], ["flow-check:3-entry", "verifier:3v-entry", "verifier:3v"])
        self.assertFalse(has(again["labels"], "planner:1"))
        self.assertFalse(has(again["labels"], "resolver:3"), "planner が裁定した組と O- は W の about にあるので裁定し直さない")
        self.assertIn("RS-001", ids_of_verifier(again, "verifier:3v-entry"))
        self.assertEqual((again["result"]["status"], again["result"]["integrity"]), (whole["result"]["status"], whole["result"]["integrity"]), again["result"].get("reason"))
        # 段 1 の出口（段の境界）で budget に達した next_args（from 3）も、同じ入口で W から裁定を受け取る。
        Path(self.world).unlink()
        n = whole["labels"].index("verifier:3v")
        cut = run({"args": args(), **spec, "budget": {"total": n}})["result"]
        self.assertEqual((cut["status"], cut["stop_reason"], cut["next_args"]["from"]), ("blocked", "budget", "3"), cut.get("reason"))
        self.assertFalse(cut["next_args"]["state"].get("tx", {}).get("restore"), "段の境界では済んだ段を戻さない")
        resumed = run({"args": cut["next_args"], **spec})
        self.assertEqual(resumed["labels"][:3], ["flow-check:3-entry", "verifier:3v-entry", "verifier:3v"])
        self.assertEqual(resumed["result"]["status"], "done", resumed["result"].get("reason"))

    def test_planner_1の申告に無い組はverifier_3vの後に止まり再実行のresolver_3が裁定する(self):
        spec = {"flow_open": 1, "ruled_at": {"3": ["RS-001", "RS-002"]}, "about": {"RS-002": {"pair": ["D-001", "F-099"]}}, "planner_leaves_at": {"1": ["RS-002"]},
                "verifier_pair_keys_at": {"3v": ["pair:D-001|F-099"]}, "world": self.world}
        first = run({"args": args(), **spec})
        res = first["result"]
        self.assertEqual((res["status"], res["next_args"]["from"]), ("blocked", "3"), res.get("reason"))
        self.assertIn("裁定に回した未裁定の論点（pair_keys）", res["reason"])
        self.assertIn("planner:1", res["reason"])
        self.assertEqual(len(res["integrity"]), 1, res["integrity"])
        self.assertFalse(has(first["labels"], "resolver:3"))
        # 再実行の入口の flow-check は W の組（D-001|F-099）を数える（stub は組を W に持たないので、入口の stdout の世界を名指しする）。
        again = run({"args": res["next_args"], **{k: v for k, v in spec.items() if k != "verifier_pair_keys_at"},
                     "recheck_as": {"3-entry": "3-entry-seen"}, "pair_keys_at": {"3-entry-seen": ["pair:D-001|F-099"]}})
        self.assertIn("resolver:3", again["labels"], "段 3 から始めた run は今の resolver:3 の経路で裁定する")
        self.assertIn("pair:D-001|F-099", nth_prompt(again, "resolver:3", 0))
        self.assertIn("RS-002", ids_of_verifier(again, "verifier:3v"))
        self.assertEqual(again["result"]["status"], "done", again["result"].get("reason"))

    def test_settleのplannerの差し戻しは1回で直らなければ同じ段から再実行が2体分の書き込みを戻す(self):
        spec = {**self.SETTLE, "world": self.world}
        fixed = run({"args": args(), **spec, "flow_findings_at": {"3-settle": 1}})
        self.assertEqual([l for l in fixed["labels"] if "settle" in l], ["planner:3-settle", "planner:3-settle:rework", "verifier:3v-settle"])
        self.assertIn("「流れ」から直して返す", nth_prompt(fixed, "planner:3-settle:rework", 0), "settle は仕分けを持たないので常に流れから")
        self.assertEqual(fixed["result"]["status"], "done", fixed["result"].get("reason"))
        Path(self.world).unlink()
        stopped = run({"args": args(), **spec, "flow_findings_at": {"3-settle": 1, "3-settle-rework": 1}})
        self.assertEqual([l for l in stopped["labels"] if "settle" in l], ["planner:3-settle", "planner:3-settle:rework"])
        res = stopped["result"]
        self.assertEqual((res["status"], res["next_args"]["from"]), ("blocked", "3"), res.get("reason"))
        token = res["next_args"]["state"]["tx"]["restore"]
        again = run({"args": res["next_args"], **spec})
        self.assertIn(f"doc_check.mjs restore --workspace /tmp/prd-w --token {token}`", nth_prompt(again, "flow-check:3-entry", 0))
        self.assertEqual((again["result"]["status"], again["result"]["integrity"]), ("done", []), again["result"].get("reason"))

    def test_settleの生成者の区別は起動の前の台帳と比べ差し戻しの体の裁定でも台帳が動いたことにする(self):
        # verifier:3v-settle の stdout に、settle の planner が消せる指摘（F-053）がある。台帳が動いていれば台帳由来として次の回に渡し、動いていなければ過少申告で止める。
        base = {"flow_open": 1, "ruled_at": {"3": ["RS-001"]}, "flow_codes_at": {"3v": self.D, "3v-settle": self.D},
                "unverified_at": {"3-settle": ["F-053"], "3-settle-rework": ["F-053"], "3-settle-2": ["F-053"]}}
        for name, kw in (("元の起動が裁定した", {"ruled_at": {**base["ruled_at"], "3-settle-opens": ["RS-009"]}}),
                         ("差し戻しの体だけが裁定した", {"ruled_at": {**base["ruled_at"], "3-settle-rework": ["RS-009"]}, "flow_findings_at": {"3-settle": 1}})):
            with self.subTest(name):
                r = run({"args": args(), **base, **kw})
                self.assertIn("planner:3-settle-2", r["labels"], "台帳が動いた回の指摘は次の回の planner に渡す")
                self.assertIn("F-053: 縛る不変条件が無い", nth_prompt(r, "planner:3-settle-2", 0))
                self.assertEqual(r["result"]["integrity"], [], r["result"]["integrity"])
        r = run({"args": args(), **base})
        res = r["result"]
        self.assertEqual((res["status"], res["next_args"]["from"]), ("blocked", "3"), res.get("reason"))
        self.assertIn("段 3v-settle: verifier の doc_check flow に指摘が 1 件あります", res["reason"])
        self.assertEqual(len(res["integrity"]), 1, res["integrity"])

    def test_裁定の欄が空のplannerが返した台帳のshaは取り込まず過少申告の判定を外さない(self):
        base = {"flow_open": 1, "ruled_at": {"3": ["RS-001"]}, "flow_codes_at": {"3v": self.D, "3v-settle": self.D}, "unverified_at": {"3-settle": ["F-053"]}}
        r = run({"args": args(), **base, "planner_sha_at": {"3-settle": "rs-claimed"}})
        res = r["result"]
        self.assertEqual((res["status"], res["next_args"]["from"]), ("blocked", "3"), res.get("reason"))
        self.assertIn("段 3v-settle: verifier の doc_check flow に指摘が 1 件あります", res["reason"], "自己申告の sha で台帳が動いたことにしない")
        self.assertNotEqual(res["next_args"]["state"].get("resolutions_sha256"), "rs-claimed")
        self.assertFalse([x for x in res["integrity"] if "rs-claimed" in x], "空の返り値の sha は照合の基準に入らない")

    def test_段3でplannerが新しく出した問いは入口の問いに数えず価値の論点でなければ保持規則に変える(self):
        # 入口で回答待ちだった問いは takeRulings の前の集合で決まる。planner の新しい問いを入口の問いに数えると、価値の論点でない（about が verification の）
        # RS-001 まで convertFailed が問いに変え、convertv の検証に回す。
        f = {"id": "RS-001", "kind": "insufficient_grounds", "reason": "r"}
        r = run({"args": args(), "questions_at": {"3": ["RS-001"], "3-fix": ["RS-001"]}, "about": {"RS-001": {"verification": "F-001"}},
                 "verifier_fail": {"3v": [f], "3-fixv": [f]}})
        self.assertIn("RS-001 → hold（insufficient_grounds）", nth_prompt(r, "resolver:3-convert", 0))
        self.assertNotIn("verifier:3-convertv", r["labels"])
        res = r["result"]
        self.assertEqual(res["status"], "done", res.get("reason"))
        self.assertIn("RS-001", res["holds"])
        # 変異: 入口の問いを takeRulings の後に数えると、RS-001 が問いに変わる。
        late = ("  const wasQuestion = new Set(pendingQuestions(state))\n  let given = []\n", "  let given = []\n")
        moved = ("    given = t.ids\n  }\n", "    given = t.ids\n  }\n  const wasQuestion = new Set(pendingQuestions(state))\n")
        mutated = run({"args": args(), "questions_at": {"3": ["RS-001"], "3-fix": ["RS-001"]}, "about": {"RS-001": {"verification": "F-001"}},
                       "verifier_fail": {"3v": [f], "3-fixv": [f]}}, patch=[late, moved])
        self.assertIn("RS-001 → question（insufficient_grounds）", nth_prompt(mutated, "resolver:3-convert", 0))

    def test_plannerの後のverifierが別のflowを見れば段3は段1から_settleは同じ段から(self):
        r = run({"args": args(), "flow_open": 1, "ruled_at": {"3": ["RS-001"]}, "verifier_flow_sha_at": {"3v": "f-other"}})
        res = r["result"]
        self.assertEqual((res["status"], res["next_args"]["from"]), ("blocked", "1"), "flow を書いたのは段 1 の planner なので段 3 の restore では戻らない")
        self.assertIn("planner:1", res["reason"])
        self.assertTrue(any("f-other" in x and "planner:1" in x for x in res["integrity"]), res["integrity"])
        self.assertFalse(has(r["labels"], "resolver:3-fix"))
        settle = run({"args": args(), **self.SETTLE, "verifier_flow_sha_at": {"3v-settle": "f-other"}})["result"]
        self.assertEqual((settle["status"], settle["next_args"]["from"]), ("blocked", "3"), settle.get("reason"))
        self.assertTrue(any("f-other" in x for x in settle["integrity"]), settle["integrity"])

    def test_検証を通っていない自分の裁定を出典に書いたplannerはverifierのstdoutで止める(self):
        # 設計 3.10 の 1: planner が裁定の後に flow を書き、flow を実行し直して返すと sha の照合は通る。独立な verifier の stdout の unsettled_refs で拾う。
        fail = [{"id": "RS-060", "kind": "insufficient_grounds", "reason": "r"}]
        settle = run({"args": args(), **self.SETTLE, "about": {"RS-060": {"open": "O-060"}}, "ruled_at": {**self.SETTLE["ruled_at"], "3-settle-opens": ["RS-060"]},
                      "cites_at": {"3-settle": {"F-053": "RS-060"}}, "verifier_fail": {"3v-settle": fail}})
        res = settle["result"]
        self.assertEqual((res["status"], res["next_args"]["from"]), ("blocked", "3"), res.get("reason"))
        self.assertTrue(any("planner:3-settle" in x and "RS-060" in x and "F-053" in x for x in res["integrity"]), res["integrity"])
        self.assertFalse(has(settle["labels"], "resolver:3-settle-fix"), "裁定の差し戻しに進まずに止める")
        stage1 = run({"args": args(), "flow_open": 1, "ruled_at": {"3": ["RS-001"]}, "cites_at": {"framer": {"F-001": "RS-001"}},
                      "verifier_fail": {"3v": [{"id": "RS-001", "kind": "insufficient_grounds", "reason": "r"}]}})["result"]
        self.assertEqual((stage1["status"], stage1["next_args"]["from"]), ("blocked", "1"), stage1.get("reason"))
        self.assertTrue(any("planner:1" in x and "RS-001" in x and "F-001" in x for x in stage1["integrity"]), stage1["integrity"])
        # 合格した裁定を出典に書くのは settle の正しい写しで、止めない。
        ok = run({"args": args(), **self.SETTLE, "cites_at": {"3-settle": {"F-091": "RS-001"}}})
        self.assertEqual((ok["result"]["status"], ok["result"]["integrity"]), ("done", []), ok["result"].get("reason"))

    def test_前の段の裁定が問いに変わった後も要素が引いていれば次の流れの仕事に直させる(self):
        # 設計 3.10 の 2: 段 3 の settle が合格した RS-001 を F-091 の出典に写した。g1 の後の 3a が RS-001 を続きの問いにすると、F-091 は
        # answer の無い問いを引く。3a の planner の裁定ではないので止めず、stale_refs と同じく流れの仕事（g1 の後は planner:3b）に直させる。
        g0 = run({"args": args(), **self.SETTLE, "questions_at": {"3": ["RS-002"]}, "cites_at": {"3-settle": {"F-091": "RS-001"}}, "world": self.world})["result"]
        self.assertEqual(g0["status"], "needs_answers", g0.get("reason"))
        r = run({"args": g0["next_args"], "world": self.world, "ruled_at": {"3a": ["RS-002"]}, "questions_at": {"3a": ["RS-001"]},
                 "uncites_at": {"3b-reframe": ["F-091"]}})
        self.assertIn("F-091 ← RS-001", nth_prompt(r, "planner:3b", 0))
        res = r["result"]
        self.assertEqual(res["integrity"], [], res["integrity"])
        self.assertEqual((res["status"], res["question_ids"]), ("needs_answers", ["RS-001"]), res.get("reason"))
        self.assertEqual(r["disk"]["unsettled_refs"], [], "直した後の W には決まっていない裁定を引く要素が無い")


# NEXT_ARGS_MAX_CHARS: 司令塔が打ち直す next_args の上限（json.dumps(ensure_ascii=False) の字数）。根拠は 2026-09-27 の試走の
# G1 の next_args のうち flow 以外が 6,998 字だったこと。後の段が state を増やしても上げない（増えた分は ID・件数・digest に絞る）。
NEXT_ARGS_MAX_CHARS = 8_000
# 見ていないもの: 項目が NextArgsBudget.ITEMS_N を超える規模と、文書・単位が 2 つ以上の形。項目の数のほかの件数（問い・resolution・
# D- の合格・当て損ね・項目ごとの指摘と flow 要素）は NextArgsBudget の fixture で固定しているので、それが増えた形も見ていない。


_FORMAL_NOTICES = {}


def formal_entry_notice(rid="f1a"):
    """入口の取り込み（formalEntry）が notices に足す、形式検証の 1 行（実物の script が書いた行を読む）。"""
    if "entry" not in _FORMAL_NOTICES:
        first = run({"args": args(), "formal_request_at": {"f1a": 3}})["result"]
        assert first["status"] == "needs_formal", first.get("reason")
        done = run({"args": first["next_args"]})["result"]
        lines = [n for n in done["notices"] if "f1a" in n]
        assert len(lines) == 1, done["notices"]
        _FORMAL_NOTICES["entry"] = lines[0]
    return _FORMAL_NOTICES["entry"].replace("f1a", rid)


def formal_off_notice():
    """formal: false の run が notices に足す 1 行（noteFormalOff）。"""
    if "off" not in _FORMAL_NOTICES:
        on = set(run({"args": args()})["result"]["notices"])
        [line] = [n for n in run({"args": args(formal=False)})["result"]["notices"] if n not in on]
        _FORMAL_NOTICES["off"] = line
    return _FORMAL_NOTICES["off"]


def formal_notices_worst():
    """next_args の notices に形式検証が足しうる行の最悪の形: 依頼の数の上限（f1a・f1b・f2a・f2b）の取り込みの行と、formal: false の 1 行の多い方。"""
    entry = [formal_entry_notice(r) for r in ("f1a", "f1b", "f2a", "f2b")]
    off = [formal_off_notice()]
    size = lambda xs: len(json.dumps(xs, ensure_ascii=False))
    return entry if size(entry) >= size(off) else off


@unittest.skipIf(shutil.which("node") is None, "node が無い環境ではスキップする")
class NextArgsBudget(unittest.TestCase):
    """試走の G1 の規模（問い 13・resolution 28・D- の合格 55・単位 1）で項目を ITEMS_N まで増やし、stray 100 件と
    SIZE_OVER のある snapshot を通ってから、g1・g2・g3（段 6）と段 8、延長のゲート（g4）と延長の段 8 で止まった next_args が上限に収まる。"""

    DOC = "requirements/cleanup-branches"
    # SKILL_DIR: next_args の skillDir は install 先のパスで、字数に入る。checkout の場所で測ると、置き場所ごとに境界が動く。
    SKILL_DIR = "/Users/someone/.claude/plugins/cache/yoshiysh-claude-plugins/workflow/10.10.10/skills/prd-spec"
    # ITEMS_N: 上限に収まる項目の数の境界。ITEMS_N で収まり ITEMS_N + 1 の段 8 の最悪の形で超えることを両方確かめるので、
    # next_args の増減が境界をまたげば落ちる。1 項目分に満たない増減は落ちないので、再開で読まない値が載っていないことは
    # _assert_lean が欄ごとに見る。値は指摘の ID が r<n>-wr-all-<連番> の形のときの実測。
    # 形式検証の欄（workflow-io.md と agent-contracts.md「## 形式検証の事実」 の formal・formal_by と、notices の取り込みの行 4 つ）を最悪の形で足すと、31 項目の段 8（existing・当て損ね 7 件）が
    # 8059 字で上限を超え、30 項目で 7932 字に収まる（実測）。そのため 30 にした。
    ITEMS_N = 30
    UNAPPLIED = 7
    # R: 段 3 の問いを持ち越した run の、回答の後に書き直した初稿の監査の回（仮の初稿の監査が r1）。
    R = 2

    @staticmethod
    def _rs(a, b):
        return [f"RS-{i:03d}" for i in range(a, b + 1)]

    def _item(self, i):
        return f"PR-CLEANUP-BRANCHES-{i:03d}"

    def _writer(self, k, item):
        return {"id": f"r{self.R}-wr-all-{k:03d}", "doc": self.DOC, "item_id": item, "route": "writer"}

    def _writer_items(self, n):
        # 試走の実データの偏り: writer の指摘は最後の項目以外に 1 件ずつ、先頭 5 項目には 2 件ずつ。最後の項目には decision の指摘 3 件。
        return [self._item(i) for i in range(1, n) for _ in range(2 if i <= 5 else 1)]

    def _common(self, n):
        decision = lambda k: {"id": f"r{self.R}-wh-all-{k:03d}", "doc": self.DOC, "item_id": self._item(n), "route": "decision"}
        return {"units": [{"id": "U-1", "docs": [self.DOC], "depends_on": []}], "long_digests": True, "stray_at": {f"r{self.R}": 100}, "size_over_at": {f"r{self.R}": 2},
                "doc_flow_refs": {self.DOC: {self._item(i): [f"F-{10 * i + j:03d}" for j in range(3)] for i in range(1, n + 1)}},
                "findings": {f"writerReviewer:r{self.R}": [self._writer(k + 1, it) for k, it in enumerate(self._writer_items(n))], f"wholeReviewer:r{self.R}": [decision(k) for k in (1, 2, 3)]},
                "routes_at": {"6": [{"id": f"RT-{i:03d}", "unit": "U-1"} for i in range(1, 4)]}}

    def _args(self, **kw):
        return args(skillDir=self.SKILL_DIR, **kw)

    def _chars(self, next_args):
        """段の token（state.tx）を、その next_args の段（from）の再実行の最悪の形にし、形式検証の欄（formal・formal_by）を最悪の形で足した字数。再実行を重ねると try と restore が伸び、
        flow を書く段では tx.flow（止まった run が最後に照合を通した flow の digest）が付く。段 8 は flow を書かないので付かない
        （RerunFromTheSameStage.test_flowを書かない段の再実行はtx_flowを運ばない）。"""
        tx = next_args["state"]["tx"]
        stage = next_args["from"]
        worst = {**tx, "stage": stage, "try": 9, "restore": f"t{tx['seq']}r8", **({} if stage == "8" else {"flow": "f" * 64})}
        # 形式検証の欄（workflow-io.md と agent-contracts.md「## 形式検証の事実」）の最悪の形: 取り込む前の rid と fnv の 8 字、段 5・8 の両方で依頼した回数。
        # notices には、入口の取り込みが足す行を依頼の数の上限（f1a・f1b・f2a・f2b）だけ足した形と、formal: false の run の 1 行の多い方を足す。
        formal = {"formal": {"rid": "f9b", "fnv": "x" * 8}, "formal_by": {"5": 1, "8": 1}}
        notices = [*next_args["state"].get("notices", []), *formal_notices_worst()]
        return len(json.dumps({**next_args, "state": {**next_args["state"], "tx": worst, **formal, "notices": notices}}, ensure_ascii=False))

    def _gates(self, a, n):
        rs, common = self._rs, self._common(n)
        units = common["units"]
        g0 = run({"args": a, "units": units, "flow_open": 1, "long_digests": True, "ruled_at": {"3": rs(1, 12)}, "questions_at": {"3": rs(13, 21)},
                  "verifier_extra_pass": {"3v": [f"D-{i:03d}" for i in range(1, 56)]}})["result"]
        g02 = run({"args": g0["next_args"], "units": units, "long_digests": True, "ruled_at": {"3a": rs(13, 21)}, "questions_at": {"3a": ["RS-022"]}})["result"]
        g1 = run({"args": g02["next_args"], **common, "ruled_at": {"3a": ["RS-022"], "6": rs(26, 28)}, "questions_at": {"6": rs(23, 25)}})["result"]
        return g0, g02, g1

    def _stage8(self, entry, n, unapplied):
        # 段 6 のゲート（g3）の回答を当て、改稿の後の監査役が応答しない。existing は段 5 が settled_written を空にするので、全 resolution を改稿に渡す。
        a = self._args() if entry == "new" else self._args(entry="existing", existing_docs=[{"key": self.DOC, "fixed": False}])
        g1 = self._gates(a, n)[2]
        auditor = f"writerReviewer:r{self.R + 1}:all"
        ids = [self._writer(k + 1, it)["id"] for k, it in enumerate(self._writer_items(n))][:unapplied]
        res = run({"args": g1["next_args"], **self._common(n), "ruled_at": {"3a'": self._rs(23, 25)}, "null_labels": [auditor], "unapplied_seq": [ids]})["result"]
        self.assertEqual((res["status"], res["next_args"]["from"]), ("blocked", "8"), res.get("reason"))
        self.assertEqual(res["next_args"]["state"]["revised"]["unapplied"], ids)
        self._assert_lean(res["next_args"]["state"])
        return self._chars(res["next_args"])

    def _size(self, res):
        self.assertEqual(res["status"], "needs_answers", res.get("reason"))
        self._assert_lean(res["next_args"]["state"])
        return self._chars(res["next_args"])

    def _assert_lean(self, state):
        # 段 3 より後の next_args には、再開で読まない値（段を過ぎた plan_sha256・D- の合格）が無い。
        self.assertNotIn("plan_sha256", state)
        self.assertTrue(state["passed"])
        self.assertEqual([i for i in state["passed"] if not re.fullmatch(r"RS-\d+", i)], [])

    def test_各ゲートのnext_argsが上限に収まる(self):
        g0, g02, g1 = self._gates(self._args(), self.ITEMS_N)
        state = g1["next_args"]["state"]
        self.assertEqual(len(state["questions"]), 13)
        self.assertEqual(len(state["about"]), 28)
        self.assertEqual(state["passed"], sorted(state["about"]), "D- の合格は運ばない")
        packed = state["pending"]["findings"][self.DOC]
        self.assertEqual((len(packed), sum(len(fs) for fs in packed.values())), (self.ITEMS_N, len(self._writer_items(self.ITEMS_N)) + 3))
        flow = state["pending"]["flow"][self.DOC]
        # decision の指摘だけの最後の項目も持つ（段 6 の指された根拠が、項目の trace が指す要素で引く）。
        self.assertEqual((len(flow), {len(v) for v in flow.values()}), (self.ITEMS_N, {3}))
        self.assertEqual(len(state["units"]), 1)
        self.assertTrue(any("100 件" in n for n in state["notices"]) and any("SIZE_BUDGET" in n for n in state["notices"]), state["notices"])
        for gate, res in (("g1", g0), ("g2", g02), ("g3", g1)):
            with self.subTest(gate=gate):
                self.assertEqual(res["gate"], gate, "段 3・3b・6 の順に開いたゲート")
                self.assertLess(self._size(res), NEXT_ARGS_MAX_CHARS)

    def test_最後のパスの途中で止まったnext_argsも上限に収まる(self):
        # 3 項目が毎パス再発して裁定に回り、別の項目にも毎パス blocking が出て進む。最後のパスの監査役が応答しない。
        units = [{"id": "U-1", "docs": [self.DOC], "depends_on": []}]
        items = [f"PR-CLEANUP-BRANCHES-{i:03d}" for i in range(1, 4)]
        finding = lambda k, n, item: {"id": f"r{k}-wr-all-{n:03d}", "doc": self.DOC, "item_id": item}
        findings = {}
        for k in range(1, MAX_AUDIT_PASSES + 1):
            findings[f"writerReviewer:r{k}"] = [finding(k, n + 1, it) for n, it in enumerate(items)] + [finding(k, 10 + k, f"PR-CLEANUP-BRANCHES-1{k:02d}")]
        auditor = f"writerReviewer:r{MAX_AUDIT_PASSES + 1}:all"
        res = run({"args": self._args(), "units": units, "long_digests": True, "findings": findings, "null_labels": [auditor]})["result"]
        self.assertEqual((res["status"], res["next_args"]["from"]), ("blocked", "8"), res.get("reason"))
        state = res["next_args"]["state"]
        self.assertEqual(state["pass"], MAX_AUDIT_PASSES)
        # 再発の経路は 2 回目以降の監査の後に付く。改稿のパスが 1 回なら、最後のパスの段 8 の途中にはまだ無い。
        routes = {f"{self.DOC}#{it}": "decision" for it in items} if MAX_AUDIT_PASSES > 1 else {}
        self.assertEqual(state.get("item_routes", {}), routes)
        self.assertLess(self._chars(res["next_args"]), NEXT_ARGS_MAX_CHARS)

    def test_段8で裁定を持って止まったnext_argsも上限に収まる(self):
        # 改稿が writer の指摘のうち UNAPPLIED 件を当て損ねた形も見る（当て損ねは次のパスへ持ち越す）。
        for entry in ("new", "existing"):
            for unapplied in (0, self.UNAPPLIED):
                with self.subTest(entry=entry, unapplied=unapplied):
                    self.assertLess(self._stage8(entry, self.ITEMS_N, unapplied), NEXT_ARGS_MAX_CHARS)

    def _stage6(self, entry, n):
        # 書き直した初稿の監査の後の段 6 の resolver が応答しない（改稿のパスは 1 回なので、輪の中の段 6 はこの 1 回だけ）。
        # 段 6 は flow を書く段なので、最悪の tx は tx.flow を持つ。
        a = self._args() if entry == "new" else self._args(entry="existing", existing_docs=[{"key": self.DOC, "fixed": False}])
        g02 = self._gates(a, n)[1]
        res = run({"args": g02["next_args"], **self._common(n), "ruled_at": {"3a": ["RS-022"], "6": self._rs(26, 28)}, "questions_at": {"6": self._rs(23, 25)},
                   "null_labels": ["resolver:6"]})["result"]
        self.assertEqual((res["status"], res["next_args"]["from"], res["next_args"]["state"]["pass"]), ("blocked", "6", 1), res.get("reason"))
        self._assert_lean(res["next_args"]["state"])
        return self._chars(res["next_args"])

    def _extension(self, entry, n):
        # 延長の経路（設計 §1D）: g3 の回答を当てた改稿の後の監査 r<R+1> が、先頭 3 項目に blocking の decision を出す（改稿が当て損ねた
        # UNAPPLIED 件も持ち越す）。延長の段 6 が問い RS-029〜031 を返して g4 で止まり（from 3a'、pass 2）、その回答を当てた延長の改稿の後の
        # 監査 r<R+2> の監査役が応答しない。返すのは、延長のゲートと延長の段 8 の next_args の字数。
        a = self._args() if entry == "new" else self._args(entry="existing", existing_docs=[{"key": self.DOC, "fixed": False}])
        g1 = self._gates(a, n)[2]
        common = self._common(n)
        decision = [{"id": f"r{self.R + 1}-wr-all-{k:03d}", "doc": self.DOC, "item_id": self._item(k), "route": "decision"} for k in (1, 2, 3)]
        # 延長の段 6 も、パス 1 の段 6 と同じく routes を 3 件返す（ID は新しく振る）。
        ext = {**common, "findings": {**common["findings"], f"writerReviewer:r{self.R + 1}": decision},
               "routes_at": {"6": [{"id": f"RT-{i:03d}", "unit": "U-1"} for i in range(4, 7)]}}
        ids = [self._writer(k + 1, it)["id"] for k, it in enumerate(self._writer_items(n))][:self.UNAPPLIED]
        gate = run({"args": g1["next_args"], **ext, "ruled_at": {"3a'": self._rs(23, 25)}, "questions_at": {"6": self._rs(29, 31)}, "unapplied_seq": [ids]})["result"]
        self.assertEqual((gate["status"], gate.get("gate")), ("needs_answers", "g4"), gate.get("reason"))
        self.assertEqual((gate["next_args"]["from"], gate["next_args"]["state"]["pass"]), ("3a'", 2))
        self._assert_lean(gate["next_args"]["state"])
        auditor = f"writerReviewer:r{self.R + 2}:all"
        s8 = run({"args": gate["next_args"], **ext, "ruled_at": {"3a'": self._rs(29, 31)}, "null_labels": [auditor], "unapplied_seq": [ids]})["result"]
        self.assertEqual((s8["status"], s8["next_args"]["from"], s8["next_args"]["state"]["pass"]), ("blocked", "8", 2), s8.get("reason"))
        self._assert_lean(s8["next_args"]["state"])
        return self._chars(gate["next_args"]), self._chars(s8["next_args"])

    def test_延長のゲートと延長の段8のnext_argsも上限に収まる(self):
        for entry in ("new", "existing"):
            with self.subTest(entry=entry):
                gate, s8 = self._extension(entry, self.ITEMS_N)
                self.assertLess(gate, NEXT_ARGS_MAX_CHARS)
                self.assertLess(s8, NEXT_ARGS_MAX_CHARS)

    def test_段8が境界を決める最悪の段である(self):
        # 境界（ITEMS_N + 1 で超える）は段 8 でだけ測る。tx.flow を持つ段 6 の再実行か延長の経路（延長のゲート・延長の段 8）が段 8 より大きければ、
        # 境界はその形が決める。
        for entry in ("new", "existing"):
            with self.subTest(entry=entry):
                worst = self._stage8(entry, self.ITEMS_N + 1, self.UNAPPLIED)
                self.assertLessEqual(self._stage6(entry, self.ITEMS_N + 1), worst)
                for name, size in zip(("延長のゲート", "延長の段 8"), self._extension(entry, self.ITEMS_N + 1)):
                    self.assertLessEqual(size, worst, name)

    def test_打ち直しの上限はprd_specのNEXT_ARGS_MAX_CHARSと同じ(self):
        # 延長に入るかを prd-spec.js が同じ上限で決める（測り直したら両方を変える）。
        src = PRD.read_text(encoding="utf-8")
        self.assertEqual(int(re.search(r"^const NEXT_ARGS_MAX_CHARS = (\d+)$", src, re.M).group(1)), NEXT_ARGS_MAX_CHARS)

    def test_scriptの最悪の形の字数は_charsと同じ(self):
        # prd-spec.js が延長に入るかを測る worstNextArgsChars は、ここの _chars と同じ値を返す（境界の近くでも、script が延長に入れば
        # このテストの測り方でも上限に収まる）。実際のゲート・段 8 の next_args と、エスケープの要る文字列を持つ形で照らす。
        g0, g02, g1 = self._gates(self._args(), 4)
        s8 = run({"args": g1["next_args"], **self._common(4), "ruled_at": {"3a'": self._rs(23, 25)}, "null_labels": [f"writerReviewer:r{self.R + 1}:all"]})["result"]
        self.assertEqual((s8["status"], s8["next_args"]["from"]), ("blocked", "8"), "tx.flow の付かない段 8 の形も照らす")
        tricky = {**g1["next_args"], "state": {**g1["next_args"]["state"], "notices": ['引用 "a\\b"\n\t改行', "\u0001\u001f\b\f\r", "日本語・F-001"], "x": [[], {}, None, True, 0.5, -3]}}
        for name, na in (("g1", g0["next_args"]), ("g2", g02["next_args"]), ("g3", g1["next_args"]), ("段 8", s8["next_args"]), ("エスケープ", tricky)):
            with self.subTest(name):
                self.assertEqual(value(f"worstNextArgsChars({json.dumps(na, ensure_ascii=False)})"), self._chars(na))

    def test_延長のゲートのnext_argsが上限を超えるなら延長せずにfinalHoldで止まる(self):
        # 最悪の延長の形: g3 の回答を当てた改稿の後の監査 r<R+1> が、先頭 3 項目の blocking の decision に加えて、全項目に writer の blocking を
        # 出す。全項目が再発して decision に回り、延長のゲートの next_args は上限を大きく超える（実測で約 15000 字）。超える next_args は
        # 打ち直せないので、延長せずに finalHold（pass_limit）で止まり、next_args を付けない。
        for entry in ("new", "existing"):
            with self.subTest(entry=entry):
                a = self._args() if entry == "new" else self._args(entry="existing", existing_docs=[{"key": self.DOC, "fixed": False}])
                g1 = self._gates(a, self.ITEMS_N)[2]
                common = {k: v for k, v in self._common(self.ITEMS_N).items() if k not in ("stray_at", "size_over_at", "routes_at")}
                decision = [{"id": f"r{self.R + 1}-wr-all-{k:03d}", "doc": self.DOC, "item_id": self._item(k), "route": "decision"} for k in (1, 2, 3)]
                writers = [{"id": f"r{self.R + 1}-wr-all-{k + 4:03d}", "doc": self.DOC, "item_id": it, "route": "writer"} for k, it in enumerate(self._writer_items(self.ITEMS_N))]
                r = run({"args": g1["next_args"], **common, "findings": {**common["findings"], f"writerReviewer:r{self.R + 1}": decision + writers}, "ruled_at": {"3a'": self._rs(23, 25)}})
                res = r["result"]
                self.assertEqual((res["status"], res["stop_reason"], res["passes"]), ("blocked", "pass_limit", 1), res.get("reason"))
                self.assertIn("延長すると next_args が打ち直しの上限（NEXT_ARGS_MAX_CHARS", res["reason"])
                self.assertIsNone(res["next_args"])
                self.assertFalse(has(r["labels"], "resolver:6"), "延長の段 6 を開かない")
                self.assertIn("resolver:final", r["labels"])

    def test_項目がITEMS_Nを超えると段8の最悪の形は上限を超える(self):
        self.assertGreaterEqual(self._stage8("existing", self.ITEMS_N + 1, self.UNAPPLIED), NEXT_ARGS_MAX_CHARS)


# 段ごとに、その段を通るシナリオと、その段で最初に起動する agent の label。
STAGE_CASES = {
    "1": ({}, "planner:1"),
    # 段 3 は planner:1 の裁定を受け取り verifier:3v から始まる。段 3 から始める run の入口は W の裁定（planner:1 が書いた RS-001）を受け取り、
    # verifier:3v-entry に検証させてから段の本体へ進む（設計 2.3）。
    "3": ({"flow_open": 1, "ruled_at": {"3": ["RS-001"]}}, "verifier:3v", ["verifier:3v-entry"]),
    "4": ({}, "writer:U-1:draft"),
    # 段 5・8 は入口の後に、送る目標の有無を決める flow-check（formal-request）を起動してから監査役へ進む（workflow-io.md と agent-contracts.md「## 形式検証の事実」）。
    "5": ({}, "writerReviewer:r1:all", ["flow-check:5-formal-f1a"]),
    "6": ({"findings": {"wholeReviewer:r1": [{"id": "r1-wh-all-001", "route": "decision"}]}, "ruled_at": {"6": ["RS-010"]}}, "resolver:6"),
    "7": ({"findings": {"writerReviewer:r1": [{"id": "r1-wr-all-001"}]}}, "writer:U-1:revise"),
    "8": ({"findings": {"writerReviewer:r1": [{"id": "r1-wr-all-001"}]}}, "writerReviewer:r2:all", ["flow-check:8-formal-f2a"]),
}


@unittest.skipIf(shutil.which("node") is None, "node が無い環境ではスキップする")
class EveryEntry(unittest.TestCase):
    """各 from の入口で、要る値が next_args.state から得られることを実際に走らせて確かめる。

    その段の最初の agent を応答させずに blocked にし、返った next_args を変えずに渡すと done まで進むこと。
    REQUIRES は手で書いた表なので、値が抜けていると再開は blocked ではなく TypeError で落ちる。
    """

    def _recover(self, spec, label, stage, checked=()):
        broken = run({**spec, "null_labels": [label]})
        self.assertIsNone(broken["error"], broken["error"])
        res = broken["result"]
        self.assertEqual(res["status"], "blocked", res)
        self.assertEqual(res["next_args"]["from"], stage)
        again = run({**{k: v for k, v in spec.items() if k != "args"}, "args": res["next_args"]})
        self.assertIsNone(again["error"], again["error"])
        head = [f"flow-check:{stage}-entry", *checked, label]
        self.assertEqual(again["labels"][: len(head)], head, "段 1 の入口は W を S0 の直後に戻し、段 3 以降の入口は W を読み直す（回答を当てる段は同じ flow-check が回答のファイルも確かめる）")
        if stage in ("3a", "3a'"):
            self.assertIn("doc_check.mjs answers --workspace /tmp/prd-w --file answers/", nth_prompt(again, f"flow-check:{stage}-entry", 0))
        return again["result"]

    def test_各段から再開できる(self):
        # 段 3 は止まった run と再開した run で W を持ち越す（段 3 の再開は、段 1 の planner:1 が段 1 の token で書いた裁定を W から受け取る）。
        for stage, (extra, label, *checked) in STAGE_CASES.items():
            with self.subTest(stage=stage), tempfile.TemporaryDirectory() as d:
                w = {"world": str(Path(d) / "world.json")} if stage == "3" else {}
                self.assertEqual(self._recover({"args": args(), **extra, **w}, label, stage, *checked)["status"], "done")

    def test_段9から再開すると誰も起動せずにdoneになる(self):
        units = [{"id": "U-1", "docs": ["requirements/x"], "depends_on": []}]
        r = run({"args": args(**{"from": "9", "state": {"units": units, "tree_digest": "t2", "pending": {}}})})
        self.assertIsNone(r["error"], r["error"])
        self.assertEqual(r["labels"], [])
        self.assertEqual((r["result"]["status"], r["result"]["report_path"], r["result"]["tree_digest"], r["result"]["unreflected"]), ("done", "/tmp/prd-w/report.md", "t2", []))
        # 本文に反映していない指摘は段 9 が state.pending から返すので、pending の無い state からは始めない。
        bare = run({"args": args(**{"from": "9", "state": {"units": units, "tree_digest": "t2"}})})
        self.assertIn('from "9" には state.pending が要ります', bare["error"] or "")
        self.assertEqual(bare["labels"], [])

    def test_回答の反映の段から再開できる(self):
        g0 = run({"args": args(), "flow_open": 1, "questions_at": {"3": ["RS-001"]}})["result"]
        done = self._recover({"args": g0["next_args"], "ruled_at": {"3a": ["RS-001"]}}, "resolver:3a", "3a")
        self.assertEqual(done["status"], "done")
        done = self._recover({"args": g0["next_args"], "ruled_at": {"3a": ["RS-001"]}}, "planner:3b", "3b")
        self.assertEqual(done["status"], "done")
        spec = {"args": args(), "findings": {"wholeReviewer:r1": [{"id": "r1-wh-all-001", "route": "decision"}]}, "questions_at": {"6": ["RS-010"]}}
        g1 = run(spec)["result"]
        done = self._recover({"args": g1["next_args"], "ruled_at": {"3a'": ["RS-010"]}}, "resolver:3a'", "3a'")
        self.assertEqual(done["status"], "done")



@unittest.skipIf(shutil.which("node") is None, "node が無い環境ではスキップする")
class OfficialAlignment(unittest.TestCase):
    """Workflow の本家の規範（agent() の null・budget・args・pipeline・model の値）に合わせた扱い。"""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.world = str(Path(self._tmp.name) / "world.json")

    def tearDown(self):
        self._tmp.cleanup()

    def test_budgetに達していればagentを起動せずstop_reasonをbudgetにして止める(self):
        r = run({"args": args(), "budget": {"total": 5, "spent": 5}})
        res = r["result"]
        self.assertEqual((r["labels"], r["attempted"]), ([], 0), "達した後の agent() は throw するので起動しない")
        self.assertEqual((res["status"], res["stop_reason"], res["next_args"]["from"]), ("blocked", "budget", "1"), res.get("reason"))

    def test_budgetのtotalが0ならagentを起動せずstop_reasonをbudgetにして止める(self):
        # 目標が無いときの total は null。0 を「目標なし」と読むと、使える token の無い run が上限なしで走る。
        r = run({"args": args(), "budget": {"total": 0}})
        res = r["result"]
        self.assertEqual((r["labels"], r["attempted"]), ([], 0))
        self.assertEqual((res["status"], res["stop_reason"], res["next_args"]["from"]), ("blocked", "budget", "1"), res.get("reason"))

    def test_予算以外のagentの例外は落ちずにその段からのnext_argsでblockedにする(self):
        spec = {"flow_open": 1, "ruled_at": {"3": ["RS-001"]}}
        for label, stage in (("verifier:3v", "3"), ("planner:1", "1")):
            with self.subTest(label):
                Path(self.world).unlink(missing_ok=True)
                r = run({"args": args(), **spec, "world": self.world, "throw_labels": [label]})
                self.assertIsNone(r["error"], r["error"])
                res = r["result"]
                self.assertEqual((res["status"], res["next_args"]["from"], res["stop_reason"]), ("blocked", stage, None), res.get("reason"))
                self.assertIn(f"stub: {label} の例外", res["reason"])
                again = run({"args": res["next_args"], **spec, "world": self.world})["result"]
                self.assertEqual(again["status"], "done", again.get("reason"))

    def test_scriptが作ったschemaの誤りはagentを起動せず再実行できないblockedにする(self):
        # 逐次の呼び出し（planner:1）と、runtime が throw を null にする pipeline の中（段 5 の監査役）。planner の呼び出しの本文は設計 3.2 の planCall の形。
        cases = (
            ("planner:1", "once(label, 'planner', prompt(label), PLANNER_SCHEMA, phaseTitle, cmds)", "once(label, 'planner', prompt(label), { ...PLANNER_SCHEMA }, phaseTitle, cmds)", "1"),
            ("監査役", "      schema: AUDIT_SCHEMA,\n", "      schema: { ...AUDIT_SCHEMA },\n", "5"),
        )
        for name, old, new, stage in cases:
            with self.subTest(name):
                r = run({"args": args(), "runtime_pipeline": True}, patch=[(old, new)])
                self.assertIsNone(r["error"], r["error"])
                res = r["result"]
                self.assertEqual((res["status"], res["next_args"], res["resumable"]), ("blocked", None, False), res.get("reason"))
                self.assertIn(f"script の不変条件に反しました（段 {stage}）", res["reason"])
                self.assertIn("opts.schema が起動の前に検査した schema でない", res["reason"])
                role = "planner" if stage == "1" else "writerReviewer"
                self.assertFalse([l for l in r["labels"] if l.split(":")[0] == role], "schema の誤った呼び出しは agent を起動しない")

    def test_agentに渡すschemaは起動の前に検査した定数だけ(self):
        # callDefect は schema を同一のオブジェクトで照合するので、定数を広げた・その場で組んだ schema は呼び出しの時に止まる。
        src = PRD.read_text(encoding="utf-8")
        code = "\n".join(l for l in src.split("\n") if not l.strip().startswith("//"))
        registered = set(re.search(r"const SCHEMAS = \{ ([^}]+) \}", code).group(1).split(", "))
        defined = set(re.findall(r"^const ([A-Z_]+_SCHEMA) = ", code, re.M))
        self.assertEqual(registered, defined)
        self.assertNotRegex(code, r"schema:\s*\{|\.\.\.[A-Z_]+_SCHEMA")

    def test_schemaの定数かrole_optsの既定の誤りはagentを起動する前にrunを止める(self):
        for old, new in (
            ("const STR = { type: 'string' }\n", "const STR = { type: 'string', format: 'x' }\n"),
            ("  flowCheck: { model: 'sonnet', effort: 'low' },\n", "  flowCheck: { model: 'sonnet', effort: 'lowest' },\n"),
        ):
            with self.subTest(new.strip()):
                r = run({"args": args()}, patch=[(old, new)])
                self.assertIn("script の欠陥", r["error"] or "")
                self.assertEqual(r["attempted"], 0)

    def test_budgetのtotalがnullかbudgetが無ければ影響しない(self):
        for kw in ({"budget": {"total": None}}, {}):
            with self.subTest(kw=kw):
                self.assertEqual(run({"args": args(), **kw})["result"]["status"], "done")

    def test_budgetが段の途中か境界で尽きたら止まりnext_argsで続けてdoneになる(self):
        spec = {"flow_open": 1, "ruled_at": {"3": ["RS-001"]}, "findings": {"writerReviewer:r1": [{"id": "r1-wr-all-001"}]}}
        full = run({"args": args(), **spec})["labels"]
        # 5 文書なら writer reviewer の組 p1・p2 が並列に動く。
        packed = {**spec, "units": docs_units(5)}
        full5 = run({"args": args(), **packed})["labels"]
        # 段の途中（逐次の呼び出し・並列の 2 体目・writer reviewer の後の whole reviewer）と、段の境界（段 5 の最初の起動の前）。
        # 段 3 は planner:1 の裁定を受け取って verifier:3v から始まるので、段 3 の途中の逐次の呼び出しは、planner:1 が裁定し漏らした O- を裁定する保険の resolver:3 の後に置く。
        left = {**spec, "planner_leaves_at": {"1": ["RS-001"]}}
        full_left = run({"args": args(), **left})["labels"]
        cases = (("段 3 の verifier の前", left, full_left.index("verifier:3v"), "3", True),
                 ("段 5 の並列の 2 体目", packed, full5.index("writerReviewer:r1:p2"), "5", True),
                 ("段 5 の whole reviewer の前", spec, full.index("wholeReviewer:r1:all"), "5", True),
                 ("段 5 の入口", spec, full.index("flow-check:5-formal-f1a"), "5", False))
        for name, spec, n, stage, mid in cases:
            with self.subTest(name):
                Path(self.world).unlink(missing_ok=True)
                stopped = run({"args": args(), **spec, "world": self.world, "budget": {"total": n}, "runtime_pipeline": True})
                res = stopped["result"]
                self.assertEqual((len(stopped["labels"]), stopped["attempted"]), (n, n))
                self.assertEqual((res["status"], res["stop_reason"], res["next_args"]["from"]), ("blocked", "budget", stage), res.get("reason"))
                # 段の途中なら段の台帳を戻して同じ段をやり直し、段の境界なら済んだ段を戻さずに次の段から始める。
                self.assertEqual(bool(res["next_args"]["state"].get("tx", {}).get("restore")), mid, res["next_args"]["state"].get("tx"))
                again = run({"args": res["next_args"], **spec, "world": self.world})["result"]
                self.assertEqual(again["status"], "done", again.get("reason"))

    def test_STOP_REASONSはworkflow_ioの3節のstop_reasonの値と同じ(self):
        line = next(l for l in WORKFLOW_IO.read_text(encoding="utf-8").split("\n") if l.strip().startswith('"stop_reason":'))
        self.assertEqual(re.findall(r"`([a-z_]+)`", line), value("STOP_REASONS"))

    def test_SKIP_FACTSはworkflow_ioの3節のskippedのfactの値と同じ(self):
        line = next(l for l in WORKFLOW_IO.read_text(encoding="utf-8").split("\n") if l.strip().startswith('"skipped":'))
        fact = line.split('"fact":')[1].split('"ids"')[0]
        self.assertEqual(re.findall(r"`([a-z_]+)`", fact), value("SKIP_FACTS"))

    def test_agentを呼ぶ場所は1つだけ(self):
        code = "\n".join(l for l in PRD.read_text(encoding="utf-8").split("\n") if not l.strip().startswith("//"))
        self.assertEqual(len(re.findall(r"(?<![\w.])agent\(", code)), 1, "budget の確かめ（call）を通らない agent() を作らない")

    def test_文字列のargsは止める(self):
        r = run({"args": json.dumps(args())})
        self.assertIn("JSON の値", r["error"])
        self.assertEqual(r["labels"], [])

    def test_申告に無い変更の一覧を打ち切って見せたら残りの件数を書く(self):
        items = [f"PR-X-{i:03d}" for i in range(1, 9)]
        r = run({"args": args(), "findings": {"writerReviewer:r1": [{"id": "r1-wr-all-001"}]}, "writer_changed": ["PR-X-001"], "diff": {"r2": items}})
        line = next(l for l in r["logs"] if "申告に無い変更" in l)
        self.assertIn("ほか 2 件（全件は返り値の undeclared）", line)
        self.assertEqual(r["result"]["undeclared"], {"requirements/x": items[1:]})

    def test_role_optsはfableと完全なmodelIDとinheritを受ける(self):
        opts = {"writer": {"model": "fable"}, "wholeReviewer": {"model": "claude-opus-5-5"}, "writerReviewer": {"model": "inherit", "effort": "low"}}
        r = run({"args": args(role_opts=opts), "inherit_labels": ["writerReviewer:"]})
        self.assertIsNone(r["error"], r["error"])
        self.assertEqual(r["result"]["status"], "done")
        self.assertEqual(r["opts"]["writer:U-1:draft"]["model"], "fable")
        self.assertEqual(r["opts"]["wholeReviewer:r1:all"]["model"], "claude-opus-5-5")
        self.assertEqual(r["opts"]["writerReviewer:r1:all"], {"model": None, "effort": "low"}, "inherit はセッションの model を継承させる")
        for bad in ("gpt-5", "claude opus"):
            with self.subTest(bad=bad):
                self.assertIn("model が不正", run({"args": args(role_opts={"writer": {"model": bad}})})["error"])

    def test_監査役の2役の既定はopusのmediumで旧い役名のrole_optsは止まる(self):
        r = run({"args": args()})
        for label in ("writerReviewer:r1:all", "wholeReviewer:r1:all"):
            with self.subTest(label=label):
                self.assertEqual(r["opts"][label], {"model": "opus", "effort": "medium"})
        for old in ("implementer", "grounding", "crossDoc"):
            with self.subTest(old=old):
                bad = run({"args": args(role_opts={old: {"model": "opus"}})})
                self.assertIn(f'args.role_opts の役割名が不明です: "{old}"', bad["error"] or "")
                self.assertEqual(bad["attempted"], 0)

    def test_planの役は1回の起動で仕事を続けて行いplannerの既定と役のファイルを使い旧い役名のrole_optsは止まる(self):
        # 仕分け・流れ・裁定は planner の仕事で、planner:1 は 1 回の起動で続けて行う（設計 1.1・1.3）。model・effort・役のファイル・契約は役から引く。
        r = run({"args": args(), "flow_open": 1, "ruled_at": {"3": ["RS-001"]}})
        planner_md = (Path(PRD).resolve().parents[1] / "skills" / "prd-spec" / "agents" / "planner.md").read_text()
        self.assertFalse([l for l in r["labels"] if l.split(":")[0] in ("intake", "flow-framer")], "仕事ごとの起動は無い")
        self.assertEqual(r["opts"]["planner:1"], {"model": "opus", "effort": "medium"})
        prompt = nth_prompt(r, "planner:1", 0)
        self.assertIn("/agents/planner.md の Read", prompt)
        self.assertIn("contract --workspace /tmp/prd-w --role planner --part 3", prompt)
        self.assertIn("仕事: 仕分け → 流れ → 裁定（同じ体で続けて行う。agents/planner.md の「## 続けて行う仕事」と各仕事の節）", prompt)
        for job in ("続けて行う仕事", "仕分け", "流れ", "裁定"):
            self.assertIn(f"\n## {job}\n", planner_md, f"プロンプトが指す節「{job}」は planner.md に実在する")
        verifier = nth_prompt(r, "verifier:3v", 0)
        self.assertEqual(r["opts"]["verifier:3v"], {"model": "opus", "effort": "medium"})
        self.assertIn("/agents/plan-reviewer.md の Read", verifier)
        self.assertNotIn("仕事: ", verifier)
        # 既定がどの役も同じなので、上書きが役ごとに届くことで、どの役から引いたかを確かめる。
        # 1 つの仕事の起動（保険の resolver:3）は今の文の仕事の行のまま（設計 1.3）。
        left = {"flow_open": 1, "ruled_at": {"3": ["RS-001"]}, "planner_leaves_at": {"1": ["RS-001"]}}
        ins = run({"args": args(), **left})
        self.assertEqual(ins["opts"]["resolver:3"], {"model": "opus", "effort": "medium"})
        self.assertIn("仕事: 裁定（agents/planner.md の「## 裁定」の節）", nth_prompt(ins, "resolver:3", 0))
        self.assertIn("contract --workspace /tmp/prd-w --role planner --part 3", nth_prompt(ins, "resolver:3", 0))
        over = run({"args": args(role_opts={"planner": {"effort": "high"}, "planReviewer": {"model": "sonnet"}}), **left})
        for label in ("planner:1", "resolver:3"):
            self.assertEqual(over["opts"][label], {"model": "opus", "effort": "high"}, label)
        self.assertEqual(over["opts"]["verifier:3v"], {"model": "sonnet", "effort": "medium"})
        for old in ("intake", "flowFramer", "resolver", "verifier"):
            with self.subTest(old=old):
                bad = run({"args": args(role_opts={old: {"model": "opus"}})})
                self.assertIn(f'args.role_opts の役割名が不明です: "{old}"', bad["error"] or "")
                self.assertEqual(bad["attempted"], 0)

    def test_headerは役に依らない行を先頭に同じ文字列で並べる(self):
        r = run({"args": args(), "flow_open": 1, "ruled_at": {"3": ["RS-001"]}, "findings": {"writerReviewer:r1": [{"id": "r1-wr-all-001"}]}})
        heads = {"\n".join(p["prompt"].split("\n")[:3]) for p in r["prompts"]}
        self.assertEqual(heads, {f"W（workspace）: /tmp/prd-w\nSKILL_DIR: {SKILL}\nentry: new"})
        roles = {p["label"].split(":")[0] for p in r["prompts"]}
        self.assertLessEqual({"planner", "verifier", "writer", "writerReviewer", "wholeReviewer", "flow-check"}, roles)

    def test_existing_docsのキーの形とfixedを検査してからコマンドに埋め込む(self):
        for doc in ({"key": "requirements/x; rm -rf ~", "fixed": False}, {"key": "requirements/x"}, {"key": "notes/x", "fixed": True}, "requirements/x"):
            with self.subTest(doc=doc):
                r = run({"args": args(entry="existing", existing_docs=[doc])})
                self.assertIn("args.existing_docs", r["error"])
                self.assertEqual(r["labels"], [])

    def test_DOC_KEYはdoc_checkの文書のキーの形と同じ(self):
        self.assertEqual(value("DOC_KEY.source"), _exported("m.DOC_KEY.source"))

    def test_段4と7の再実行は止まったrunが書いた文書の本文も段に入った時点へ戻す(self):
        # writer は本文を Edit で書き doc_check を通らないので、writer が最初のコマンドで取った backup の控えを入口の restore が戻す。
        # 再実行の入口は restore の stdout の文書の digest を段の入口の本文と照らし、戻った本文なら止めずに進む。
        units = [{"id": "U-1", "docs": ["requirements/x"], "depends_on": []}, {"id": "U-2", "docs": ["requirements/y"], "depends_on": []}]
        fs = {"writerReviewer:r1:all": [{"id": "r1-wr-all-001"}]}
        for stage, label, extra in (("4", "writer:U-2:draft", {}), ("7", "writer:U-1:revise", {"findings": fs})):
            with self.subTest(stage=stage):
                spec = {"units": units, **extra, "world": self.world}
                Path(self.world).unlink(missing_ok=True)
                whole = run({"args": args(), **spec})
                self.assertEqual(whole["result"]["status"], "done", whole["result"].get("reason"))
                Path(self.world).unlink()
                stopped = run({"args": args(), **spec, "silent_after_write": [label]})["result"]
                self.assertEqual(stopped["next_args"]["from"], stage, stopped.get("reason"))
                again = run({"args": stopped["next_args"], **spec})
                self.assertEqual(again["result"]["status"], "done", again["result"].get("reason"))
                self.assertEqual(again["docs"], whole["docs"], "止まった run が書いた本文の上から書き直さない")
                self.assertEqual(again["result"]["integrity"], [], again["result"]["integrity"])
                self.assertFalse([l for l in again["labels"] if re.fullmatch(r"flow-check:.+-backup", l)], "控えは writer が取る")
                self.assertNotIn("doc_check.mjs backup", nth_prompt(again, f"flow-check:{stage}-entry", 0), "入口は tx を書かない（restore より先に流されると戻す控えを消す）")
                first = next(l for l in again["labels"] if l.startswith("writer:"))
                token = writer_backup(self, again, first, ["requirements/x", "requirements/y"])
                self.assertRegex(token, r"^t\d+r\d+$", "再実行の writer は再実行の書く token で控えを取り直す")

    def test_段7は改稿しない単位の文書も控える(self):
        # 改稿する単位の文書だけを控えると、writer が単位の外の文書に書いたとき、再実行の restore がその文書を戻せない。
        units = [{"id": "U-1", "docs": ["requirements/x"], "depends_on": []}, {"id": "U-2", "docs": ["requirements/y"], "depends_on": []}]
        r = run({"args": args(), "units": units, "findings": {"writerReviewer:r1:all": [{"id": "r1-wr-all-001"}]}})
        self.assertEqual(r["result"]["status"], "done", r["result"].get("reason"))
        self.assertNotIn("writer:U-2:revise", r["labels"])
        self.assertIn("--doc requirements/x --doc requirements/y --token", nth_prompt(r, "writer:U-1:revise", 0))

    def test_intakeの単位の文書のキーの形を検査する(self):
        r = run({"args": args(), "units": [{"id": "U-1", "docs": ["requirements/x --token t9"], "depends_on": []}]})
        res = r["result"]
        self.assertEqual((res["status"], res["next_args"]["from"]), ("blocked", "1"), res.get("reason"))
        self.assertIn("文書のキーの形", res["reason"])

    # 段 7 の入口（reconcile）の後に verifier の起動しない経路で、W の ruling と合否を state に写すこと。W は所有表の外で書き換える。
    def _stopped_at_7(self):
        spec = {"flow_open": 1, "ruled_at": {"3": ["RS-001"]}, "findings": {"writerReviewer:r1": [{"id": "r1-wr-all-001"}]}, "world": self.world}
        stopped = run({"args": args(), **spec, "null_labels": ["writer:U-1:revise"]})["result"]
        self.assertEqual(stopped["next_args"]["from"], "7", stopped.get("reason"))
        return spec, stopped["next_args"]

    def _edit(self, next_args, world, **state):
        d = json.loads(Path(self.world).read_text())
        world(d)
        Path(self.world).write_text(json.dumps(d))
        a = {k: v for k, v in next_args.items() if k != "state_hash"}
        a["state"] = {**a["state"], **state}
        a["state_hash"] = value(f"nextArgsHash({json.dumps(a, ensure_ascii=False)})")
        return a

    @staticmethod
    def _line(r, head):
        return next(l for l in nth_prompt(r, "writer:U-1:revise", 0).split("\n") if l.startswith(head))

    def test_入口で書き直しを見つけたresolutionは書き込み済みから外してwriterに渡し直す(self):
        spec, na = self._stopped_at_7()
        self.assertIn("RS-001", na["state"]["settled_written"])
        a = self._edit(na, lambda d: d["rs"]["RS-001"].update(v=1))
        r = run({**spec, "args": a})
        self.assertEqual(r["result"]["status"], "done", r["result"].get("reason"))
        self.assertIn("verifier:7v-entry", r["labels"])
        self.assertIn("RS-001", self._line(r, "前回の書き込みの後に決まった resolution:"))

    def test_入口でWのrulingがholdでなくなった裁定は保持規則に数えない(self):
        spec, na = self._stopped_at_7()
        about = {**na["state"]["about"], "RS-099": "open:O-099"}
        world = lambda d: (d["rs"].__setitem__("RS-099", {"about": {"open": "O-099"}, "ruling": "internal"}), d["verdicts"].__setitem__("RS-099", {"verdict": "pass"}))
        a = self._edit(na, world, about=about, holds=["RS-099"], passed=[*na["state"]["passed"], "RS-099"])
        r = run({**spec, "args": a})
        self.assertEqual(r["result"]["status"], "done", r["result"].get("reason"))
        self.assertNotIn("verifier:7v-entry", r["labels"], "W の合否は script の持つ合否と同じなので検証し直さない")
        self.assertIn("RS-099", self._line(r, "- 根拠にしてよい resolution"))
        self.assertNotIn("RS-099", self._line(r, "- 保持規則として規範文で書く resolution"))

    def test_入口でWのrulingが値の裁定になった問いは回答待ちに数えない(self):
        spec, na = self._stopped_at_7()
        about = {**na["state"]["about"], "RS-098": "open:O-098"}
        world = lambda d: (d["rs"].__setitem__("RS-098", {"about": {"open": "O-098"}, "ruling": "internal"}), d["verdicts"].__setitem__("RS-098", {"verdict": "pass"}))
        a = self._edit(na, world, about=about, questions=["RS-098"], passed=[*na["state"]["passed"], "RS-098"])
        r = run({**spec, "args": a})
        self.assertEqual(r["result"]["status"], "done", r["result"].get("reason"))
        self.assertIn("RS-098", self._line(r, "- 根拠にしてよい resolution"))


@unittest.skipIf(shutil.which("node") is None, "node が無い環境ではスキップする")
class SameSessionResume(unittest.TestCase):
    """同じセッションの再開（resumeFromRunId）。stub の cache が、前の run の起動の順で label とプロンプトが変わらない最長の前置きを
    保存された結果で返し、結果の無い呼び出しと最初に変わった呼び出しから後を live で走らせる（本家 WF「Resume after a pause」）。

    ゲートの後は元の run の args の gates_answered にゲートと聞いた問いの ID を足し、blocked の後は元の run の args のまま呼び直す（SKILL.md「## 中継」）。"""

    # ゲートを開く段ごとの題材: (止まるゲート, run ごとの stub の応答（最後の要素が回答を当てた後の run）)。stub は段の名前で応答を返し分けるので、
    # g2 の後にもう一度走る 3a には別の run の応答を渡す。段 6 の題材は前にゲートを開かないので、段 6 のゲートも g1 になる。
    GATES = {
        "段 3": ("g1", [{"flow_open": 1, "questions_at": {"3": ["RS-001"]}}, {"ruled_at": {"3a": ["RS-001"]}}]),
        "段 3b": ("g2", [{"flow_open": 1, "questions_at": {"3": ["RS-001"]}}, {"ruled_at": {"3a": ["RS-001"]}, "questions_at": {"3a": ["RS-002"]}}, {"ruled_at": {"3a": ["RS-002"]}}]),
        "段 6": ("g1", [{"findings": {"wholeReviewer:r1": [{"id": "r1-wh-all-001", "route": "decision"}]}, "questions_at": {"6": ["RS-010"]}}, {"ruled_at": {"3a'": ["RS-010"]}}]),
        "3b の後の 3a": ("g3", [{"flow_open": 1, "questions_at": {"3": ["RS-001"]}}, {"ruled_at": {"3a": ["RS-001"]}, "questions_at": {"3a": ["RS-002"]}},
                                {"ruled_at": {"3a": ["RS-002"]}, "questions_at": {"3a": ["RS-003"]}}, {"ruled_at": {"3a": ["RS-003"]}}]),
    }

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()

    def tearDown(self):
        self._tmp.cleanup()

    def _w(self, name):
        return str(Path(self._tmp.name) / f"{name}.json")

    @staticmethod
    def _answer(res):
        """needs_answers の問いのすべてに回答を書いた体の write_answers。"""
        return {f"answers/{res['gate']}.md": res["question_ids"]}

    def _resumed(self, gate, world):
        """ゲートごとに回答を書いた体で、元の run の args の gates_answered に返ったゲートと question_ids を足して resume し続けた run の列。"""
        runs = []
        gates = {}
        for spec in self.GATES[gate][1]:
            extra = {}
            if runs:
                res = runs[-1]["result"]
                gates = {**gates, res["gate"]: res["question_ids"]}
                extra = {"cache": runs[-1]["calls"], "write_answers": self._answer(res)}
            a = {**args(), "gates_answered": gates} if gates else args()
            runs.append(run({"args": a, **spec, "world": world, **extra}))
        return runs

    def _via_next_args(self, gate, world):
        runs = []
        for spec in self.GATES[gate][1]:
            runs.append(run({"args": runs[-1]["result"]["next_args"] if runs else args(), **spec, "world": world}))
        return runs

    def test_ゲートより前のagentのプロンプトとoptsはgates_answeredの有無で変わらない(self):
        for name, (gate, _) in self.GATES.items():
            with self.subTest(name):
                stopped, passed = self._resumed(name, self._w(f"{gate}-{len(name)}-a"))[-2:]
                self.assertEqual((stopped["result"]["status"], stopped["result"]["answers_path"]), ("needs_answers", f"/tmp/prd-w/answers/{gate}.md"), stopped["result"].get("reason"))
                n = len(stopped["calls"])
                self.assertEqual(passed["calls"][n]["label"], f"flow-check:{gate}-answers", "問いが聞いたものと同じなので、回答のファイルを確かめに進む")
                strip = lambda cs: [(c["label"], c["prompt"], c["opts"]) for c in cs]
                self.assertEqual(strip(passed["calls"][:n]), strip(stopped["calls"]), "変わると、その agent と後の agent がすべて live で走り直す（stub の cache は label とプロンプトだけを見るので opts も比べる）")
                first = stopped["calls"][0]
                self.assertEqual(first["label"], "flow-check:1-entry")
                self.assertIn("doc_check.mjs reset", first["prompt"], "live で走り直すと W を S0 の直後に戻し、書いた回答を消す")

    def test_gates_answeredで呼び直すとゲートより前は保存された結果が返り回答を当てる段からliveで走る(self):
        for name, (gate, _) in self.GATES.items():
            with self.subTest(name):
                runs = self._resumed(name, self._w(f"{gate}-{len(name)}-r"))
                stopped, resumed = runs[-2], runs[-1]
                res = resumed["result"]
                self.assertEqual(res["status"], "done", res.get("reason"))
                self.assertNotIn("gates_answered", res["next_args"] or {})
                self.assertEqual(resumed["replayed"], [c["label"] for c in stopped["calls"]], "ゲートより前はすべて保存された結果")
                self.assertEqual(resumed["labels"][0], f"flow-check:{gate}-answers", resumed["labels"])
                self.assertTrue(resumed["labels"][1].startswith("resolver:3a"), resumed["labels"])

                # next_args で呼び直した run と同じ段を同じ順で走る。どちらも回答のファイルを確かめてから当てる。next_args の run は入口で W を読み直し、
                # 同じ flow-check が回答のファイルも確かめる（単独の answers を起動しない）。resume は入口を通らないので単独の answers を起動する。
                via = self._via_next_args(name, self._w(f"{gate}-{len(name)}-f"))
                frm = via[-2]["result"]["next_args"]["from"]
                self.assertEqual(via[-1]["labels"][0], f"flow-check:{frm}-entry")
                assert_entry_answers(self, via[-1], frm, via[-2]["result"]["gate"], via[-2]["result"]["question_ids"])
                self.assertEqual(resumed["labels"][1:], via[-1]["labels"][1:])
                keys = ("status", "holds", "hold_drafts", "open_tbd", "integrity", "missed", "passes", "notices")
                self.assertEqual({k: res[k] for k in keys}, {k: via[-1]["result"][k] for k in keys})

    def test_gates_answeredで複数のゲートをまたいでresumeしてもゲートの名前がずれない(self):
        runs = self._resumed("3b の後の 3a", self._w("chain"))
        stops = [x["result"] for x in runs[:-1]]
        self.assertEqual([(x["status"], x["gate"]) for x in stops], [("needs_answers", "g1"), ("needs_answers", "g2"), ("needs_answers", "g3")],
                         "resume は同じ段を同じ順に通るので、回答済みのゲートも同じ名前で数え直す")
        self.assertEqual([x["question_ids"] for x in stops], [["RS-001"], ["RS-002"], ["RS-003"]])
        self.assertEqual([x["answers_path"] for x in stops], [f"/tmp/prd-w/answers/g{n}.md" for n in (1, 2, 3)])
        last = runs[-1]
        self.assertEqual(last["result"]["status"], "done", last["result"].get("reason"))
        self.assertEqual([l for l in last["labels"] if l.endswith("-answers")], ["flow-check:g3-answers"], "前のゲートの回答は保存された結果で越え、最後のゲートの回答だけを確かめる")

    def test_回答済みのゲートを通った印はその段の出口にだけ効く(self):
        spec = {"flow_open": 1, "questions_at": {"3": ["RS-001"], "3a": ["RS-002"]}, "ruled_at": {"3a": ["RS-001"]}}
        onward = "'3b')\n  const onward = ENTRY === 'existing' ? '5' : '4'\n"
        skip = [(onward + "  if (pendingQuestions(state).length) return needsAnswers('3a', onward)\n", onward)]
        world = self._w("p")
        stopped = run({"args": args(), **spec, "world": world}, patch=skip)
        r = run({"args": {**args(), "gates_answered": {"g1": ["RS-001"]}}, **spec, "world": world, "cache": stopped["calls"], "write_answers": self._answer(stopped["result"])}, patch=skip)
        res = r["result"]
        self.assertTrue(has(r["labels"], "resolver:3a"), "g1 は回答済みなので通る")
        self.assertEqual((res["status"], res["next_args"]), ("blocked", None), res.get("reason"))
        self.assertIn("回答待ちの問い RS-002 を", res["reason"], "g1 を通った印を後の段に持ち越すと、聞かずに出る段を止められない")

    def test_gates_answeredの形が違うと起動の前に止まる(self):
        # g0・g0-2 は位置で決めていた頃のゲートの名前で、今は開いた順の g1〜g<MAX_GATES> だけを受け取る。
        for bad in (["g1"], "g1", {"g0": ["RS-001"]}, {"g0-2": ["RS-001"]}, {f"g{MAX_GATES + 1}": ["RS-001"]}, {"g01": ["RS-001"]}, {"G1": ["RS-001"]},
                    {"g1": []}, {"g1": ["x"]}, {"g1": True}, {"g1": [None]}):
            with self.subTest(bad=bad):
                r = run({"args": {**args(), "gates_answered": bad}})
                self.assertIn("args.gates_answered", r["error"] or "")
                self.assertEqual(r["labels"], [])
        # 上限の番号のゲートは受け取る（形の検査は起動の前なので、起動した agent があれば検査を通った）。
        ok = run({"args": {**args(), "gates_answered": {f"g{MAX_GATES}": ["RS-001"]}}})
        self.assertIsNone(ok["error"], ok["error"])
        self.assertTrue(ok["labels"])

    def test_next_argsから始めたrunもgates_answeredを足してresumeでき返るnext_argsはgates_answeredを持たない(self):
        # 段 3 の問いを持ち越すので r1 は仮の初稿の監査。書き直した初稿の監査の後の最後のパスの段 6 が問いを出す。
        findings = new_item_each_round(MAX_AUDIT_PASSES + 1)
        findings[f"writerReviewer:r{MAX_AUDIT_PASSES + 1}"][0]["route"] = "decision"
        spec = {"flow_open": 1, "questions_at": {"3": ["RS-001"], "6": ["RS-020"]}, "findings": findings, "ruled_at": {"3a": ["RS-001"], "3a'": ["RS-020"]}}
        world = self._w("x")
        g0 = run({"args": args(), **spec, "world": world})["result"]
        self.assertEqual((g0["gate"], g0["question_ids"]), ("g1", ["RS-001"]), g0.get("reason"))
        cross = run({"args": g0["next_args"], **spec, "world": world})
        self.assertEqual((cross["result"]["status"], cross["result"]["answers_path"]), ("needs_answers", "/tmp/prd-w/answers/g2.md"), "g1 を開いた run の段 6 のゲートは g2")
        resumed = run({"args": {**g0["next_args"], "gates_answered": {"g2": ["RS-020"]}}, **spec, "world": world, "cache": cross["calls"], "write_answers": self._answer(cross["result"])})
        self.assertIsNone(resumed["error"], resumed["error"])
        self.assertEqual(resumed["result"]["status"], "done", resumed["result"].get("reason"))
        self.assertEqual(resumed["replayed"], [c["label"] for c in cross["calls"]])
        first = run({"args": args(), **spec, "world": self._w("y")})
        g1 = run({"args": {**args(), "gates_answered": {"g1": ["RS-001"]}}, **spec, "world": self._w("y"), "cache": first["calls"], "write_answers": self._answer(first["result"])})["result"]
        self.assertEqual((g1["status"], g1["gate"]), ("needs_answers", "g2"), g1.get("reason"))
        self.assertNotIn("gates_answered", g1["next_args"], "セッションを跨ぐ再開は from で始めるので、ゲートを通った印を運ばない")

    def test_resumeがゲートより前で保存された結果から外れると今の問いを聞き直す(self):
        spec = {"findings": {"wholeReviewer:r1": [{"id": "r1-wh-all-001", "route": "decision"}]}, "questions_at": {"6": ["RS-010"]}}
        world = self._w("m")
        stopped = run({"args": args(), **spec, "world": world})
        self.assertEqual(stopped["result"]["question_ids"], ["RS-010"])
        # pipeline の起動の順・追い出しなどで resolver:6 の保存された結果が使えず、live の resolver が新しい ID で問いを出し直す。
        missed = [{**c, "result": None} if c["label"] == "resolver:6" else c for c in stopped["calls"]]
        a = {**args(), "gates_answered": {"g1": ["RS-010"]}}
        again = run({"args": a, **spec, "world": world, "cache": missed, "fresh_ids": True, "write_answers": self._answer(stopped["result"])})
        res = again["result"]
        self.assertEqual((res["status"], res["gate"], res["resumable"]), ("needs_answers", "g1", True), res.get("reason"))
        self.assertIn("RS-510", res["question_ids"], "聞いたのと違う問いには、古い回答を当てずに聞き直す（W に残った前の run の問いも数える）")
        self.assertIn("resolver:6", again["labels"])
        self.assertFalse(has(again["labels"], "flow-check:g1-answers") or has(again["labels"], "resolver:3a'"), again["labels"])
        # 今の問いを聞いて、その ID で resume し直すと進む。
        done = run({"args": {**args(), "gates_answered": {"g1": res["question_ids"]}}, **spec, "ruled_at": {"3a'": res["question_ids"]}, "world": world, "cache": again["calls"], "write_answers": self._answer(res)})
        self.assertEqual(done["result"]["status"], "done", done["result"].get("reason"))
        self.assertEqual(done["labels"][0], "flow-check:g1-answers")

    def test_最初の呼び出しで外れてresetが回答を消したらゲートを越えずnext_argsで呼び直させる(self):
        spec = {"flow_open": 1, "questions_at": {"3": ["RS-001"]}}
        world = self._w("f")
        stopped = run({"args": args(), **spec, "world": world})
        missed = [{**stopped["calls"][0], "result": None}, *stopped["calls"][1:]]
        a = {**args(), "gates_answered": {"g1": ["RS-001"]}}
        again = run({"args": a, **spec, "world": world, "cache": missed, "write_answers": self._answer(stopped["result"])})
        self.assertEqual(again["labels"][0], "flow-check:1-entry", "reset が live で走り、書いた回答を消す")
        res = again["result"]
        self.assertEqual((res["status"], res["question_ids"]), ("needs_answers", ["RS-001"]), res.get("reason"))
        self.assertFalse(res["resumable"], "resume すると落ちた検査の保存された結果が返り、同じ所で止まり続ける")
        self.assertIn("ファイルがありません", res["reason"])
        self.assertEqual(again["labels"][-1], "flow-check:g1-answers")
        self.assertFalse(has(again["labels"], "resolver:3a"), "問いの ID が同じでも、回答の無いまま当てる段へ進まない")
        # 聞き直した回答を書いて next_args で呼び直すと進む。
        done = run({"args": res["next_args"], **spec, "ruled_at": {"3a": ["RS-001"]}, "world": world, "write_answers": self._answer(res)})
        self.assertEqual(done["result"]["status"], "done", done["result"].get("reason"))

    def test_回答のファイルが一部の問いに答えていなければゲートを越えない(self):
        spec = {"flow_open": 2, "questions_at": {"3": ["RS-001", "RS-002"]}}
        world = self._w("c")
        stopped = run({"args": args(), **spec, "world": world})
        ids = stopped["result"]["question_ids"]
        self.assertEqual(ids, ["RS-001", "RS-002"])
        again = run({"args": {**args(), "gates_answered": {"g1": ids}}, **spec, "world": world, "cache": stopped["calls"], "write_answers": {"answers/g1.md": ["RS-001"]}})
        res = again["result"]
        self.assertEqual((res["status"], res["resumable"]), ("needs_answers", False), res.get("reason"))
        self.assertIn("RS-002", res["reason"])
        self.assertEqual(again["labels"], ["flow-check:g1-answers"])

    def test_聞いた問いと数が同じでもIDが違えば回答のファイルを見ずに聞き直す(self):
        spec = {"flow_open": 1, "questions_at": {"3": ["RS-001"]}}
        world = self._w("s")
        stopped = run({"args": args(), **spec, "world": world})
        self.assertEqual(stopped["result"]["question_ids"], ["RS-001"])
        again = run({"args": {**args(), "gates_answered": {"g1": ["RS-002"]}}, **spec, "world": world, "cache": stopped["calls"], "write_answers": {"answers/g1.md": ["RS-002"]}})
        res = again["result"]
        self.assertEqual((res["status"], res["question_ids"], res["resumable"]), ("needs_answers", ["RS-001"], True), res.get("reason"))
        self.assertIn("違います", res["reason"])
        self.assertFalse(has(again["labels"], "flow-check:g1-answers") or has(again["labels"], "resolver:3a"), "数だけ比べると、聞いていない問いの回答を今の問いに当てる")

    def test_聞いた問いの順序が逆でもIDが同じならゲートを通る(self):
        spec = {"flow_open": 2, "questions_at": {"3": ["RS-001", "RS-002"]}}
        world = self._w("order")
        stopped = run({"args": args(), **spec, "world": world})
        ids = stopped["result"]["question_ids"]
        self.assertEqual(ids, ["RS-001", "RS-002"])
        reversed_ids = ["RS-002", "RS-001"]
        again = run({"args": {**args(), "gates_answered": {"g1": reversed_ids}}, **spec, "world": world, "cache": stopped["calls"],
                     "write_answers": {"answers/g1.md": ["RS-001", "RS-002"]}, "ruled_at": {"3a": ["RS-001", "RS-002"]}})
        self.assertEqual(again["result"]["status"], "done", again["result"].get("reason"))

    def test_next_argsで回答を当てる段から始めても回答のファイルが問いに答えていなければ当てない(self):
        g0 = run({"args": args(), "flow_open": 2, "questions_at": {"3": ["RS-001", "RS-002"]}})["result"]
        g1 = run({"args": args(), "findings": {"wholeReviewer:r1": [{"id": "r1-wh-all-001", "route": "decision"}]}, "questions_at": {"6": ["RS-010"]}})["result"]
        cases = (("段 3 のゲートの回答が無い", g0, {}, "ファイルがありません", "resolver:3a"),
                 ("段 3 のゲートの回答が一部だけ", g0, {"answers/g1.md": ["RS-001"]}, "RS-002", "resolver:3a"),
                 ("段 6 のゲートの回答が無い", g1, {}, "ファイルがありません", "resolver:3a'"))
        for name, stopped, written, why, apply in cases:
            with self.subTest(name):
                r = run({"args": stopped["next_args"], "write_answers": written})
                res = r["result"]
                self.assertEqual((res["status"], res["gate"], res["resumable"]), ("needs_answers", stopped["gate"], False), res.get("reason"))
                self.assertEqual((res["question_ids"], res["next_args"]["from"]), (stopped["question_ids"], stopped["next_args"]["from"]))
                self.assertIn(why, res["reason"])
                frm = stopped["next_args"]["from"]
                self.assertEqual(r["labels"], [f"flow-check:{frm}-entry"], "入口の flow-check が回答のファイルも確かめる")
                assert_entry_answers(self, r, frm, stopped["gate"], stopped["question_ids"])
                self.assertFalse(has(r["labels"], apply), "回答の無い問いを resolver が当てると、依頼者の言っていない回答が裁定になる")

    def test_next_argsで3aから始めたrunをg2の後にresumeしても回答のファイルは1回だけ確かめる(self):
        g0 = run({"args": args(), "flow_open": 1, "questions_at": {"3": ["RS-001"]}})["result"]
        world = self._w("g")
        stopped = run({"args": g0["next_args"], "ruled_at": {"3a": ["RS-001"]}, "questions_at": {"3a": ["RS-002"]}, "world": world})
        res = stopped["result"]
        self.assertEqual((res["status"], res["gate"], res["question_ids"]), ("needs_answers", "g2", ["RS-002"]), res.get("reason"))
        resumed = run({"args": {**g0["next_args"], "gates_answered": {"g2": ["RS-002"]}}, "ruled_at": {"3a": ["RS-002"]}, "world": world,
                       "cache": stopped["calls"], "write_answers": self._answer(res)})
        self.assertEqual(resumed["result"]["status"], "done", resumed["result"].get("reason"))
        self.assertEqual([l for l in resumed["labels"] if l.endswith("-answers")], ["flow-check:g2-answers"],
                         "ゲートで確かめた回答を、同じ run の 2 回目の 3a の入口でもう一度確かめない（入口の検査は run の最初の段だけ）")

    def test_回答の検査のstdoutが実行させたコマンドのものでなければゲートを越えない(self):
        spec = {"flow_open": 2, "questions_at": {"3": ["RS-001", "RS-002"]}}
        world = self._w("e")
        stopped = run({"args": args(), **spec, "world": world})
        ids = stopped["result"]["question_ids"]
        for name, echo in (("ほかの問い", {"file": "answers/g1.md", "exists": True, "ids": ["RS-001"], "missing": [], "free": []}),
                           ("ほかのファイル", {"file": "answers/g2.md", "exists": True, "ids": ids, "missing": [], "free": []}),
                           # free の無い写しを通すと、候補の label だけでない回答の逐語が resolver に届かないまま回答を当てる。
                           ("free の無い写し", {"file": "answers/g1.md", "exists": True, "ids": ids, "missing": []})):
            with self.subTest(name):
                again = run({"args": {**args(), "gates_answered": {"g1": ids}}, **spec, "world": world, "cache": stopped["calls"],
                             "write_answers": self._answer(stopped["result"]), "answers_stdout": echo})
                res = again["result"]
                self.assertEqual((res["status"], res["resumable"]), ("needs_answers", False), res.get("reason"))
                self.assertIn("doc_check answers の stdout", res["reason"])

    def test_blockedの後のresumeは失敗したagentから後だけを走らせrestoreしない(self):
        spec = {"flow_open": 1, "ruled_at": {"3": ["RS-001"]}}
        world = self._w("b")
        stopped = run({"args": args(), **spec, "world": world, "null_labels": ["verifier:3v"]})
        res = stopped["result"]
        self.assertEqual((res["status"], res["resumable"], res["next_args"]["from"]), ("blocked", True, "3"), res.get("reason"))
        self.assertTrue(res["next_args"]["state"]["tx"]["restore"], "next_args の経路は restore で段の入口へ戻す")
        resumed = run({"args": args(), **spec, "world": world, "cache": stopped["calls"]})
        self.assertEqual(resumed["result"]["status"], "done", resumed["result"].get("reason"))
        self.assertEqual(resumed["replayed"], [l for l in stopped["labels"] if l != "verifier:3v"])
        self.assertEqual(resumed["labels"][0], "verifier:3v")
        self.assertEqual(resumed["result"]["integrity"], [])
        self.assertFalse(any("doc_check.mjs restore" in c["prompt"] for c in resumed["calls"]), "元の run の args には restore の token が無い")

    def test_restoreで始めたrunのresumeは入口のrestoreを流し直しても止まったrunの書き込みを戻さない(self):
        spec = {"flow_open": 1, "ruled_at": {"3": ["RS-001"]}}
        world = self._w("r")
        first = run({"args": args(), **spec, "world": world, "null_labels": ["verifier:3v"]})["result"]
        rerun = first["next_args"]
        token = rerun["state"]["tx"]["restore"]
        for name, stop, live in (("入口の後で止まった", {"null_labels": ["verifier:3v"]}, "verifier:3v"),
                                 ("入口が restore の後に応答しなかった", {"silent_after_write": ["flow-check:3-entry"]}, "flow-check:3-entry")):
            with self.subTest(name):
                Path(world).unlink()
                run({"args": args(), **spec, "world": world, "null_labels": ["verifier:3v"]})
                stopped = run({"args": rerun, **spec, "world": world, **stop})
                self.assertEqual((stopped["result"]["status"], stopped["result"]["resumable"]), ("blocked", True), stopped["result"].get("reason"))
                self.assertIn(f"restore --workspace /tmp/prd-w --token {token}`", stopped["calls"][0]["prompt"])
                resumed = run({"args": rerun, **spec, "world": world, "cache": stopped["calls"]})
                self.assertEqual(resumed["result"]["status"], "done", resumed["result"].get("reason"))
                self.assertEqual(resumed["labels"][0], live)
                self.assertEqual(resumed["result"]["integrity"], [])
                if live == "flow-check:3-entry":
                    # 最初の restore が控えを消しているので、流し直した restore は何も戻さない（実物の doc_check は test_ledger が押さえる）。
                    self.assertIn(f'"token":"{token}","restored":0', json.dumps(resumed["calls"][0]["result"], ensure_ascii=False).replace("\\", "").replace(" ", ""))

    def test_失敗したagentの無いblockedはresumableでなくresumeしても同じ所で止まる(self):
        spec = {"flow_open": 1, "ruled_at": {"3": ["RS-001"]}}
        world = self._w("n")
        stopped = run({"args": args(), **spec, "world": world, "null_labels": ["verifier:3v"]})["result"]
        checked = run({"args": stopped["next_args"], **spec, "world": world, "no_restore_at": ["flow-check:3-entry"]})
        res = checked["result"]
        self.assertEqual((res["status"], res["resumable"]), ("blocked", False), res.get("reason"))
        self.assertTrue(res["next_args"], "next_args の経路ではやり直せる")
        again = run({"args": stopped["next_args"], **spec, "world": world, "cache": checked["calls"]})
        self.assertEqual((again["labels"], again["result"]["reason"]), ([], res["reason"]), "完了した agent はすべて保存された結果を返す")

    def test_resumableはneeds_answersとbudgetで止まったblockedで真(self):
        self.assertTrue(run({"args": args(), "flow_open": 1, "questions_at": {"3": ["RS-001"]}})["result"]["resumable"])
        self.assertTrue(run({"args": args(), "budget": {"total": 0}})["result"]["resumable"])
        self.assertFalse(run({"args": args()})["result"]["resumable"])


@unittest.skipIf(shutil.which("node") is None, "node が無い環境ではスキップする")
class WriterBackup(unittest.TestCase):
    """段 4・7 の writer は最初のコマンドで全文書の控え（doc_check backup）を段の token で取り、script は返った stdout の控えの digest を
    段の入口の本文と照らす（違えば integrity に 1 行足して段を進める）。同じ段の再実行の入口は restore の stdout の、戻した後の文書の digest を
    照らし、段の入口の本文に戻らなければ止まる（既存の文書が違えば next_args なし、段 4 で新しく生まれた文書だけなら段 1 から）。"""

    UNITS = [{"id": "U-1", "docs": ["requirements/x"], "depends_on": []}, {"id": "U-2", "docs": ["requirements/y"], "depends_on": []}]
    FS = {"findings": {"writerReviewer:r1:all": [{"id": "r1-wr-all-001"}]}}
    # expand: existing_docs の固定でない文書を段 4 の writer が書く。reset は entry.json を書き、その digest が state.entry_digest に入る。
    EXPAND = {"args": args(entry="expand", existing_docs=[{"key": "requirements/x", "fixed": False}]), "entry_digest": "e0"}
    NO_DOCS = ["digests", "entry_digest", "tree_digest"]

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.world = str(Path(self._tmp.name) / "world.json")

    def tearDown(self):
        self._tmp.cleanup()

    def _stop(self, spec, label, **extra):
        """W を新しくして、label の writer が書いた後に応答しない run を走らせ、その result を返す（同じ段からの next_args を持つ）。"""
        Path(self.world).unlink(missing_ok=True)
        res = run({"args": args(), **spec, "world": self.world, "silent_after_write": [label], **extra})["result"]
        self.assertEqual((res["status"], res["next_args"]["from"]), ("blocked", label_stage(label)), res.get("reason"))
        return res

    def _again(self, spec, stopped, **extra):
        return run({**{k: v for k, v in spec.items() if k != "args"}, "args": stopped["next_args"], "world": self.world, **extra})

    def test_writerは最初のコマンドで全文書の控えを同じtokenで取りflow_checkに控えさせない(self):
        r = run({"args": args(), "units": self.UNITS})
        self.assertEqual(r["result"]["status"], "done", r["result"].get("reason"))
        self.assertFalse([l for l in r["labels"] if re.fullmatch(r"flow-check:.+-backup", l)], r["labels"])
        tokens = {writer_backup(self, r, label, ["requirements/x", "requirements/y"]) for label in ("writer:U-1:draft", "writer:U-2:draft")}
        self.assertEqual(len(tokens), 1, "どの writer も段の token で控える（同じ token の 2 回目は控えを取り直さない）")
        self.assertEqual(r["result"]["integrity"], [])

    def test_書いてから取った控えはintegrityに残し段を進める(self):
        for name, spec, label in (("段 4 の新しい文書", {"args": args()}, "writer:U-1:draft"),
                                  ("段 4 の既存の文書", self.EXPAND, "writer:U-1:draft"),
                                  ("段 7", {"args": args(), **self.FS}, "writer:U-1:revise")):
            with self.subTest(name):
                self.assertEqual(run(spec)["result"]["integrity"], [], "控えてから書けば integrity に残らない")
                res = run({**spec, "backup_after_edit": [label]})["result"]
                self.assertEqual(res["status"], "done", res.get("reason"))
                self.assertEqual(len(res["integrity"]), 1, res["integrity"])
                self.assertIn(f"{label} の doc_check backup", res["integrity"][0])

    def test_書いてから控えて止まった段の再実行は入口で止まり後の役を起動しない(self):
        for name, spec, label, frm in (("段 7", {"args": args(), **self.FS}, "writer:U-1:revise", None),
                                       ("段 4 の既存の文書", self.EXPAND, "writer:U-1:draft", None),
                                       ("段 4 の新しい文書だけ", {"args": args()}, "writer:U-1:draft", "1")):
            with self.subTest(name):
                stopped = self._stop(spec, label, backup_after_edit=[label])
                again = self._again(spec, stopped)
                res = again["result"]
                stage = label_stage(label)
                self.assertEqual(again["labels"], [f"flow-check:{stage}-entry"], "戻らない本文の上で検証も改稿も回さない")
                self.assertEqual(res["status"], "blocked", res.get("reason"))
                if frm is None:
                    self.assertIsNone(res["next_args"], "reset は既存の文書の本文を残すので、段 1 からでも段の入口の本文に戻らない")
                    self.assertIn("S0", res["reason"])
                else:
                    self.assertEqual((res["next_args"]["from"], res["next_args"]["state"]), ("1", {}), "段 1 の入口の reset が新しく生まれた文書を消す")

    def test_問いを持ち越して2回目の初稿を書く段4の再実行は監査の基準の木で照らす(self):
        # 段 3 の問いを持ち越した run は g1 → 3a → 3b を経て段 4 にもう一度入る。1 回目の初稿の文書が W にあるので、段 4 の入口の本文は
        # 「existing_docs に無い文書が無い」ではなく、直前の監査の基準（state.audit.digest）の木である。
        first = {"flow_open": 1, "questions_at": {"3": ["RS-001"]}}
        second = {"ruled_at": {"3a": ["RS-001"]}}
        label = "writer:U-1:draft"

        def g1():
            Path(self.world).unlink(missing_ok=True)
            res = run({"args": args(), **first, "world": self.world})["result"]
            self.assertEqual((res["status"], res["next_args"]["from"]), ("needs_answers", "3a"), res.get("reason"))
            self.assertIn("audit", res["next_args"]["state"])
            return res["next_args"]

        with self.subTest("止まらない run"):
            whole = run({"args": g1(), **second, "world": self.world})
            self.assertEqual(whole["result"]["status"], "done", whole["result"].get("reason"))
            self.assertEqual(whole["labels"].count(label), 1)
            writer_backup(self, whole, label, ["requirements/x"])
            self.assertEqual(whole["result"]["integrity"], [], "1 回目の初稿の文書が W にあっても、控えは段の入口の本文と合う")
        with self.subTest("応答しない writer の再実行"):
            stopped = run({"args": g1(), **second, "world": self.world, "silent_after_write": [label]})["result"]
            self.assertEqual((stopped["status"], stopped["next_args"]["from"]), ("blocked", "4"), stopped.get("reason"))
            again = run({"args": stopped["next_args"], **second, "world": self.world})
            self.assertEqual(again["result"]["status"], "done", again["result"].get("reason"))
            self.assertEqual(again["result"]["integrity"], [], again["result"]["integrity"])
            self.assertEqual(again["docs"], whole["docs"], "止まった run が書いた本文の上から書き直さない")
        with self.subTest("控えの前に書いて止まった writer の再実行"):
            stopped = run({"args": g1(), **second, "world": self.world, "silent_after_write": [label], "backup_after_edit": [label]})["result"]
            self.assertEqual((stopped["status"], stopped["next_args"]["from"]), ("blocked", "4"), stopped.get("reason"))
            again = run({"args": stopped["next_args"], **second, "world": self.world})
            res = again["result"]
            self.assertEqual(again["labels"], ["flow-check:4-entry"], "戻らない本文の上で書き直さない")
            self.assertEqual((res["status"], res["next_args"]), ("blocked", None), res.get("reason"))
            self.assertIn("S0", res["reason"], "監査の基準の木と違えば bornOnly にせず S0 から")

    def test_restoreのstdoutに文書のdigestが無ければ段4と7は同じ段から止まり他の段の入口は止まらない(self):
        for spec, label in (({"args": args()}, "writer:U-1:draft"), ({"args": args(), **self.FS}, "writer:U-1:revise")):
            stage = label_stage(label)
            with self.subTest(stage=stage):
                stopped = self._stop(spec, label)
                res = self._again(spec, stopped, restore_docs_stdout_at={f"flow-check:{stage}-entry": self.NO_DOCS})["result"]
                self.assertEqual((res["status"], (res["next_args"] or {}).get("from")), ("blocked", stage), res.get("reason"))
                self.assertIn("digest", res["reason"])
        g0 = run({"args": args(), "flow_open": 1, "questions_at": {"3": ["RS-001"]}})["result"]
        stopped = run({"args": g0["next_args"], "ruled_at": {"3a": ["RS-001"]}, "null_labels": ["resolver:3a"]})["result"]
        self.assertEqual(stopped["next_args"]["from"], "3a", stopped.get("reason"))
        res = run({"args": stopped["next_args"], "ruled_at": {"3a": ["RS-001"]}, "restore_docs_stdout_at": {"flow-check:3a-entry": self.NO_DOCS}})["result"]
        self.assertEqual(res["status"], "done", res.get("reason"))

    def test_単位の外の文書に書いて止まったwriterの書き込みも再実行が戻す(self):
        # 単位の文書だけを控えると、単位の外の文書（段 7 では改稿しない単位の文書）に控えが無いか、書いた後の本文が控えになる。
        for spec, label in (({"units": self.UNITS}, "writer:U-1:draft"), ({"units": self.UNITS, **self.FS}, "writer:U-1:revise")):
            stage = label_stage(label)
            with self.subTest(stage=stage):
                Path(self.world).unlink(missing_ok=True)
                whole = run({"args": args(), **spec, "world": self.world})
                self.assertEqual(whole["result"]["status"], "done", whole["result"].get("reason"))
                stopped = self._stop(spec, label, writes_outside={label: ["requirements/y"]})
                again = self._again({"args": args(), **spec}, stopped)
                self.assertEqual(again["result"]["status"], "done", again["result"].get("reason"))
                self.assertEqual(again["docs"], whole["docs"], "止まった run が単位の外に書いた本文の上から書き直さない")
                self.assertEqual(again["result"]["integrity"], [], again["result"]["integrity"])

    def test_形の違う控えのstdoutはintegrityに残し写しの崩れは1回だけ取り直す(self):
        other = {"backup": True, "token": "t99", "docs": ["requirements/x"], "digests": {"requirements/x": None}, "entry_digest": None, "tree_digest": "tree-x"}
        r = run({"args": args(), "backup_stdout_at": {"writer:U-1:draft": other}})
        res = r["result"]
        self.assertEqual(res["status"], "done", res.get("reason"))
        self.assertEqual(len(res["integrity"]), 1, res["integrity"])
        self.assertIn("writer:U-1:draft の doc_check backup", res["integrity"][0])
        self.assertNotIn("flow-check:writer-U-1-draft-recopy", r["labels"], "checksum に合う写しは取り直さない（別の token の控えは自己申告の食い違い）")
        broken = bad_literal('{"backup": true')
        r = run({"args": args(), "corrupt": {"writer:U-1:draft": {"backup_check": broken}, "flow-check:writer-U-1-draft-recopy": {"backup_check": broken}}})
        res = r["result"]
        self.assertEqual((res["status"], res["next_args"]["from"]), ("blocked", "4"), res.get("reason"))
        self.assertIn("checksum", res["reason"])
        self.assertEqual(r["labels"].count("flow-check:writer-U-1-draft-recopy"), 1)


def label_stage(label):
    return "4" if label.endswith(":draft") else "7"


@unittest.skipIf(shutil.which("node") is None, "node が無い環境ではスキップする")
class EntryAnswers(unittest.TestCase):
    """next_args で 3a・3a' から始めた run は入口の flow-check に answers も実行させ、回答を当てる段はその stdout を使う（設計 B §3.4）。"""

    def test_入口の後に回答待ちの問いが変わればゲートのanswersを単独で起動する(self):
        # 入口の verifyLeft が W から問いを受け取ると（reconcile の adopted）、入口で確かめた ID と回答待ちの問いが合わない。
        with tempfile.TemporaryDirectory() as d:
            world = str(Path(d) / "world.json")
            g0 = run({"args": args(), "flow_open": 1, "questions_at": {"3": ["RS-001"]}, "world": world})["result"]
            self.assertEqual(g0["question_ids"], ["RS-001"], g0.get("reason"))
            w = json.loads(Path(world).read_text())
            w["rs"]["RS-002"] = {"about": {"open": "O-002"}, "ruling": "question"}
            Path(world).write_text(json.dumps(w))
            r = run({"args": g0["next_args"], "ruled_at": {"3a": ["RS-001"]}, "world": world, "write_answers": {"answers/g1.md": ["RS-001", "RS-002"]}})
        self.assertIn("--file answers/g1.md --ids RS-001`", nth_prompt(r, "flow-check:3a-entry", 0), "入口は next_args の回答待ちの問いで確かめる")
        self.assertIn("flow-check:g1-answers", r["labels"])
        self.assertIn("--file answers/g1.md --ids RS-001,RS-002`", nth_prompt(r, "flow-check:g1-answers", 0))


@unittest.skipIf(shutil.which("node") is None, "node が無い環境ではスキップする")
class ConvertWithoutFlowCheck(unittest.TestCase):
    """問いへの変換の後は flow-check で数え直さず、直後の verifier（<段>-convertv）の stdout を判断に使い、resolver の申告をそれと照らす（設計 B §3.6）。"""

    FAIL = {"id": "RS-001", "kind": "insufficient_grounds", "reason": "出典が無い"}
    SPEC = {"args": args(), "flow_open": 1, "ruled_at": {"3": ["RS-001"], "3-fix": ["RS-001"]}, "verifier_fail": {"3v": [FAIL], "3-fixv": [FAIL]},
            "questions_at": {"3-convert": ["RS-001"]}}

    def test_問いへの変換の後はflow_checkを起動せずverifierに検証させる(self):
        r = run(self.SPEC)
        labels = r["labels"]
        i = labels.index("resolver:3-convert")
        self.assertEqual(labels[i:i + 2], ["resolver:3-convert", "verifier:3-convertv"])
        self.assertFalse([l for l in labels if re.fullmatch(r"flow-check:3-convert.*", l)], labels)
        self.assertEqual((r["result"]["status"], r["result"]["integrity"]), ("needs_answers", []), r["result"].get("reason"))

    def test_verifierのputで変わる合否の欄の違いはintegrityに残さない(self):
        # verifier は verifications.json を put してから flow を実行するので、合否を読む欄（unverified・failed_current・unsettled_refs・
        # stale_refs）は変換の resolver の stdout と正当に違いうる。ここでは resolver の時点の stale_refs が verifier の put の後に消えた世界。
        r = run({**self.SPEC, "stale_refs_at": {"3-convert": [{"el": "F-002", "ref": "D-001"}]}})
        self.assertEqual((r["result"]["status"], r["result"]["integrity"]), ("needs_answers", []), r["result"].get("reason"))
        # 変異: 合否の欄も照らすと、正直な申告を食い違いとして残す。
        mutated = run({**self.SPEC, "stale_refs_at": {"3-convert": [{"el": "F-002", "ref": "D-001"}]}},
                      patch=[("`verifier（段 ${owner}-convertv）`, VERDICT_KEYS)", "`verifier（段 ${owner}-convertv）`)")])
        self.assertTrue(any("stale_refs で違う" in x for x in mutated["result"]["integrity"]), mutated["result"]["integrity"])

    def test_変換のresolverの申告がverifierのstdoutと違えばintegrityに残す(self):
        # verifier の put で変わらない欄（open_ids）の食い違いは resolver の過少・過大な申告である。
        r = run({**self.SPEC, "open_ids_at": {"3-convert": ["O-099", "O-RS-001"], "3-convertv": ["O-RS-001"]}})
        res = r["result"]
        self.assertEqual(res["status"], "needs_answers", res.get("reason"))
        lines = [x for x in res["integrity"] if "resolver（段 3-convert）" in x]
        self.assertEqual(len(lines), 1, res["integrity"])
        self.assertIn("verifier（段 3-convertv）", lines[0])
        self.assertIn("open_ids で違う", lines[0])


def fnv(text):
    """prd-spec.js・doc_check の stdout_fnv と同じ FNV-1a（UTF-16 の code unit ごと）。stub の formal-request は request_fnv を fnv('req-<rid>') にする。"""
    h = 0x811C9DC5
    for i in range(0, len(text.encode("utf-16-le")), 2):
        unit = int.from_bytes(text.encode("utf-16-le")[i:i + 2], "little")
        h = ((h ^ unit) * 0x01000193) & 0xFFFFFFFF
    return f"{h:08x}"


def auditors(labels):
    return [l for l in labels if l.split(":")[0] in ("writerReviewer", "wholeReviewer")]


def formal_prompts(r, cmd, rid=None):
    """doc_check の formal-request・formal-status を実行させたプロンプト（rid を渡せばその --rid のもの）。"""
    return [p for p in r["prompts"] if re.search(rf"doc_check\.mjs {cmd} [^`\n]*", p["prompt"])
            and (rid is None or re.search(rf"doc_check\.mjs {cmd} [^`\n]*--rid {rid}\b", p["prompt"]))]


@unittest.skipIf(shutil.which("node") is None, "node が無い環境ではスキップする")
class FormalGate(unittest.TestCase):
    """workflow-io.md と agent-contracts.md「## 形式検証の事実」: 段 5・8 の本体の最初で formal-method へ戻る（needs_formal）経路と、取り込み・差し戻し・依頼 b。
    stub の doc_check formal-request・formal-status は、label ではなくプロンプトのコマンドで返す（HARNESS の formalParts）。"""

    R1 = {"writerReviewer:r1": [{"id": "r1-wr-all-001"}]}

    def _first(self, **kw):
        spec = {"args": args(), "formal_request_at": {"f1a": 3}, **kw}
        r = run(spec)
        res = r["result"]
        self.assertEqual(res["status"], "needs_formal", res.get("reason"))
        return spec, r, res

    # 1
    def test_段5は送る目標があればneeds_formalで戻り監査役を起動しない(self):
        _, r, res = self._first()
        fr = res["formal_request"]
        self.assertEqual((fr["rid"], fr["request_path"], fr["units"], fr["goals"]), ("f1a", "/tmp/prd-w/fm/f1a/request.json", 1, 3))
        self.assertEqual((fr["request_digest"], fr["cwd"]), ("rq-f1a", "/tmp/prd-w.formal"), "formal-request の stdout の値を写す")
        self.assertEqual(res["next_args"]["from"], "5")
        self.assertEqual(res["next_args"]["state"]["formal"], {"rid": "f1a", "fnv": fnv("req-f1a")}, "取り込む前は rid と request_fnv の 8 字だけ")
        self.assertEqual(res["next_args"]["state"]["formal_by"], {"5": 1})
        self.assertIs(res["resumable"], False, "needs_formal は resume せず next_args で呼び直す")
        self.assertEqual(auditors(r["labels"]), [], "監査役の前に戻る")
        self.assertTrue(has(r["labels"], "writer:U-1:draft"), "writer の後に戻る")
        self.assertTrue(formal_prompts(r, "formal-request", "f1a"))

    # 2
    def test_next_argsで始めると入口でformal_statusを照らし反例が無ければ監査役へ進む(self):
        spec, _, res = self._first()
        r = run({**spec, "args": res["next_args"]})
        self.assertIsNone(r["error"], r["error"])
        out = r["result"]
        self.assertEqual(out["status"], "done", out.get("reason"))
        [entry] = formal_prompts(r, "formal-status", "f1a")
        self.assertTrue(entry["label"].startswith("flow-check:"), "入口の flow-check が formal-status を実行する")
        self.assertLess(r["labels"].index(entry["label"]), r["labels"].index(auditors(r["labels"])[0]))
        self.assertTrue(has(r["labels"], "writerReviewer:r1"))
        self.assertFalse(has(r["labels"], "writer:U-1:formal"), "反例が 0 なら差し戻さない")
        self.assertTrue(any("result" in n for n in out["notices"]), out["notices"])

    # 3
    def test_反例があれば差し戻しのwriterを1体だけ起動して依頼bで戻る(self):
        spec, _, res = self._first(formal_request_at={"f1a": 3, "f1b": 1},
                                   formal_status_at={"f1a": {"counts": {"counterexample": 2}}, "f1b": {"counts": {"counterexample": 1}}})
        r = run({**spec, "args": res["next_args"]})
        b = r["result"]
        self.assertEqual([l for l in r["labels"] if l.startswith("writer:")], ["writer:U-1:formal-1"])
        self.assertEqual(auditors(r["labels"]), [], "差し戻しは reviewer の前")
        prompt = nth_prompt(r, "writer:U-1:formal-1", 0)
        self.assertIn("ST-FORMAL-CEX-", prompt)
        self.assertIn("fm/facts.json", prompt)
        writer_backup(self, r, "writer:U-1:formal-1", ["requirements/x"])
        self.assertEqual((b["status"], b["formal_request"]["rid"], b["next_args"]["from"]), ("needs_formal", "f1b", "5"), b.get("reason"))
        self.assertEqual(b["next_args"]["state"]["formal"], {"rid": "f1b", "fnv": fnv("req-f1b")})
        self.assertEqual(b["next_args"]["state"]["formal_by"], {"5": 1}, "依頼 b は上限に数えない")
        last = run({**spec, "args": b["next_args"]})
        self.assertIsNone(last["error"], last["error"])
        self.assertFalse(has(last["labels"], "writer:U-1:formal"), "依頼 b の反例は差し戻さない（差し戻し 1 回）")
        self.assertTrue(has(last["labels"], "writerReviewer:r1"), "残った反例は blocking のまま reviewer へ進む")
        self.assertNotEqual(last["result"]["status"], "needs_formal")
        self.assertTrue(formal_prompts(last, "formal-status", "f1b"))

    def test_差し戻しのwriterが何も変えなければ依頼bを作らずに監査役へ進む(self):
        spec, _, res = self._first(formal_status_at={"f1a": {"counts": {"counterexample": 1}}}, formal_noop=["writer:U-1:formal-1"])
        r = run({**spec, "args": res["next_args"]})
        self.assertTrue(has(r["labels"], "writer:U-1:formal-1"))
        self.assertNotEqual(r["result"]["status"], "needs_formal", r["result"].get("reason"))
        self.assertTrue(has(r["labels"], "writerReviewer:r1"))

    # 4
    def test_送る目標が無ければ戻らずno_formal_targetを残す(self):
        r = run({"args": args()})
        res = r["result"]
        self.assertEqual(res["status"], "done", res.get("reason"))
        self.assertIn({"step": "formal-method:f1a", "fact": "no_formal_target", "ids": []}, res["skipped"])
        self.assertTrue(formal_prompts(r, "formal-request", "f1a"), "依頼を作るかは doc_check が決める")

    def test_formal_falseなら依頼せずformal_unavailableを残しnext_argsに写す(self):
        on = run({"args": args()})["result"]
        r = run({"args": args(formal=False)})
        res = r["result"]
        self.assertEqual(res["status"], "done", res.get("reason"))
        self.assertEqual(formal_prompts(r, "formal-request") + formal_prompts(r, "formal-status"), [])
        self.assertIn({"step": "formal-method", "fact": "formal_unavailable", "ids": []}, res["skipped"])
        self.assertEqual(len(set(res["notices"]) - set(on["notices"])), 1, "notices に 1 行足す")
        g = run({"args": args(formal=False), "findings": {"wholeReviewer:r1": [{"id": "r1-wh-all-001", "route": "decision"}]}, "questions_at": {"6": ["RS-010"]}})["result"]
        self.assertEqual(g["status"], "needs_answers", g.get("reason"))
        self.assertIs(g["next_args"]["formal"], False, "formal は BASE_ARGS で next_args に写る")
        again = run({"args": g["next_args"], "ruled_at": {"3a'": ["RS-010"]}})
        self.assertIsNone(again["error"], again["error"])
        self.assertEqual(formal_prompts(again, "formal-request"), [], "呼び直しでも formal: false のまま")

    # 5
    def test_持ち越した問いで書いた段5は依頼せず書き直した段5で依頼する(self):
        spec = {"args": args(), "flow_open": 1, "questions_at": {"3": ["RS-001"]}}
        r = run(spec)
        g1 = r["result"]
        self.assertEqual((g1["status"], g1.get("gate")), ("needs_answers", "g1"), g1.get("reason"))
        self.assertTrue(has(r["labels"], "writerReviewer:r1"), "持ち越した問いのまま初稿を書いて監査した")
        self.assertEqual(formal_prompts(r, "formal-request"), [], "捨てる初稿の段 5 では依頼しない")
        self.assertNotIn("formal_by", g1["next_args"]["state"])
        rewritten = run({"args": g1["next_args"], "ruled_at": {"3a": ["RS-001"]}, "formal_request_at": {"f2a": 2}})
        res = rewritten["result"]
        self.assertEqual((res["status"], res["formal_request"]["rid"]), ("needs_formal", "f2a"), res.get("reason"))
        self.assertEqual(res["next_args"]["state"]["formal_by"], {"5": 1})

    # 6
    def test_existingは段8で依頼aと差し戻しと依頼bを回し差し戻しの申告をrevisedに足す(self):
        a = args(entry="existing", existing_docs=[{"key": "requirements/x", "fixed": False}])
        spec = {"args": a, "findings": self.R1, "formal_request_at": {"f2a": 2, "f2b": 1},
                "formal_status_at": {"f2a": {"counts": {"counterexample": 1}}, "f2b": {"counts": {"counterexample": 1}}},
                "formal_changed": {"writer:U-1:formal-2": ["PR-X-077"]}}
        r1 = run(spec)
        s8 = r1["result"]
        self.assertIn({"step": "formal-method:f1a", "fact": "no_formal_target", "ids": []}, s8["skipped"], "existing の段 5 は送る単位が 0")
        self.assertEqual((s8["status"], s8["formal_request"]["rid"], s8["next_args"]["from"]), ("needs_formal", "f2a", "8"), s8.get("reason"))
        self.assertEqual(s8["next_args"]["state"]["formal_by"], {"8": 1})
        self.assertTrue(has(r1["labels"], "writer:U-1:revise"))
        self.assertFalse(has(r1["labels"], "writerReviewer:r2"))
        r2 = run({**spec, "args": s8["next_args"]})
        b = r2["result"]
        self.assertEqual([l for l in r2["labels"] if l.startswith("writer:")], ["writer:U-1:formal-2"])
        self.assertEqual((b["status"], b["formal_request"]["rid"], b["next_args"]["from"]), ("needs_formal", "f2b", "8"), b.get("reason"))
        self.assertIn("PR-X-077", b["next_args"]["state"]["revised"]["changes"]["requirements/x"], "差し戻しの changed_items を段 8 の申告に足す")
        r3 = run({**spec, "args": b["next_args"]})
        self.assertIsNone(r3["error"], r3["error"])
        self.assertTrue(has(r3["labels"], "writerReviewer:r2"))
        self.assertFalse(has(r3["labels"], "writer:U-1:formal"))
        self.assertTrue(r3["result"]["undeclared"] == {} or "PR-X-077" not in json.dumps(r3["result"]["undeclared"]), "差し戻しの変更を申告に無い変更に数えない")

    def test_延長の2回目の段8は依頼しない(self):
        dec = {"id": "r2-wr-all-002", "item_id": "PR-X-002", "route": "decision"}
        spec = {"args": args(), "findings": {**self.R1, "writerReviewer:r2": [dec]}, "about": {"RS-020": {"finding": dec["id"]}},
                "questions_at": {"6": ["RS-020"]}, "formal_request_at": {"f2a": 1}}
        s8 = run(spec)["result"]
        self.assertEqual((s8["status"], s8["formal_request"]["rid"]), ("needs_formal", "f2a"), s8.get("reason"))
        g = run({**spec, "args": s8["next_args"]})["result"]
        self.assertEqual((g["status"], g["next_args"]["from"]), ("needs_answers", "3a'"), g.get("reason"))
        after = run({**spec, "args": g["next_args"], "ruled_at": {"3a'": ["RS-020"]}})
        self.assertIsNone(after["error"], after["error"])
        self.assertTrue(has(after["labels"], "writerReviewer:r3"), "延長の段 8 まで進む")
        self.assertEqual(formal_prompts(after, "formal-request"), [], "FORMAL_LIMIT[8] を使い切った延長の段 8 は依頼しない")
        self.assertNotEqual(after["result"]["status"], "needs_formal")

    # 7
    def test_入口の照合に落ちると決めたnext_argsの有無でblockedになる(self):
        spec, _, res = self._first()
        broken = '{"rid":'
        cases = [
            ("checksum に 2 回落ちる", {"corrupt": {"flow-check:5-entry": {"formal_status": {"literal": broken}}, "flow-check:5-entry-recopy": {"formal_status": {"literal": broken}}}}, "5"),
            ("rid が違う", {"formal_status_at": {"f1a": {"rid": "f9a"}}}, None),
            ("fnv が違う", {"formal_status_at": {"f1a": {"fnv": "deadbeef"}}}, None),
            ("units_digest_ok が偽", {"formal_status_at": {"f1a": {"units_digest_ok": False}}}, None),
            ("outcome が null", {"formal_status_at": {"f1a": {"outcome": None}}}, "5"),
            ("文書が変わった", {"formal_status_at": {"f1a": {"tree_moved": True}}}, None),
        ]
        for name, kw, rerun in cases:
            with self.subTest(name):
                r = run({**spec, **kw, "args": res["next_args"]})
                out = r["result"]
                self.assertEqual(out["status"], "blocked", out.get("reason"))
                self.assertEqual(auditors(r["labels"]), [])
                self.assertEqual(None if out["next_args"] is None else out["next_args"]["from"], rerun, out.get("reason"))
                if name == "outcome が null":
                    self.assertIn("formal-import", out["reason"])

    def test_結果の無いoutcomeは進み未検証をnoticesに残す(self):
        spec, _, res = self._first()
        for outcome in ("no_result", "provisional", "rejected"):
            with self.subTest(outcome):
                r = run({**spec, "formal_status_at": {"f1a": {"outcome": outcome, "counts": {"unverified": 3}}}, "args": res["next_args"]})
                out = r["result"]
                self.assertEqual(out["status"], "done", out.get("reason"))
                self.assertTrue(has(r["labels"], "writerReviewer:r1"))
                self.assertTrue(any(outcome in n for n in out["notices"]), out["notices"])

    # 8
    def test_取り込んだ後に止まった再実行は入口で照らし直し差し戻しからやり直す(self):
        spec, _, res = self._first(formal_request_at={"f1a": 3, "f1b": 1}, formal_status_at={"f1a": {"counts": {"counterexample": 1}}})
        stopped = run({**spec, "args": res["next_args"], "null_labels": ["writer:U-1:formal-1"]})["result"]
        self.assertEqual((stopped["status"], stopped["next_args"]["from"]), ("blocked", "5"), stopped.get("reason"))
        again = run({**spec, "args": stopped["next_args"]})
        self.assertTrue(formal_prompts(again, "formal-status", "f1a"), "入口で同じ rid の formal-status を照らし直す")
        self.assertTrue(has(again["labels"], "writer:U-1:formal-1"), "差し戻しからやり直す")
        out = again["result"]
        self.assertEqual((out["status"], out["formal_request"]["rid"]), ("needs_formal", "f1b"), out.get("reason"))
        self.assertEqual(out["next_args"]["state"]["formal_by"], {"5": 1}, "やり直しで formal_by を増やさない")

    # 9
    def test_持ち越す段5でneeds_formalを返してもexitViolationに落ちない(self):
        # 仕様書だけを書く run は、最初のゲートまで carrying() が真（state.deferred が無くても）。その段 5 が needs_formal を返す。
        a = args(entry="expand", existing_docs=[{"key": "requirements/x", "fixed": True}, {"key": "specifications/x", "fixed": False}])
        r = run({"args": a, "units": [{"id": "U-1", "docs": ["specifications/x"], "depends_on": []}], "formal_request_at": {"f1a": 2}})
        res = r["result"]
        self.assertEqual(res["status"], "needs_formal", res.get("reason"))
        self.assertNotIn("不変条件", res.get("reason") or "")

    # 10
    def test_needs_formalの後のneeds_answersから再開でき形式検証の状態を保つ(self):
        spec, _, res = self._first(findings={"wholeReviewer:r1": [{"id": "r1-wh-all-001", "route": "decision"}]}, questions_at={"6": ["RS-010"]})
        g = run({**spec, "args": res["next_args"]})["result"]
        self.assertEqual((g["status"], g["next_args"]["from"]), ("needs_answers", "3a'"), g.get("reason"))
        self.assertEqual(g["next_args"]["state"]["formal"], {"rid": "f1a", "ok": 1})
        self.assertEqual(g["next_args"]["state"]["formal_by"], {"5": 1})
        after = run({**spec, "args": g["next_args"], "ruled_at": {"3a'": ["RS-010"]}})
        self.assertIsNone(after["error"], after["error"])
        self.assertNotEqual(after["result"]["status"], "blocked", after["result"].get("reason"))

    # 11
    def test_formal_requestのstdoutがchecksumに2回落ちるとblocked(self):
        # JSON としては読めるが stdout_fnv の無い写し（checksum に合わない）を、取り直しでも返す。
        bad = {"formal_check": {"literal": json.dumps({"rid": "f1a", "goals": 3})}}
        r = run({"args": args(), "corrupt": {"flow-check:5-formal-f1a": bad, "flow-check:5-formal-f1a-recopy": bad}})
        res = r["result"]
        self.assertEqual((res["status"], res["next_args"]["from"]), ("blocked", "5"), res.get("reason"))
        self.assertEqual(auditors(r["labels"]), [])
        self.assertTrue(any(l.endswith("-recopy") for l in r["labels"]), "取り直しを 1 回だけ行う")

    # 再検証の後に決めた直し方 3
    def test_取り込みの行はWの絶対パスを含まない短い固定の形(self):
        line = formal_entry_notice()
        self.assertNotIn("/tmp/prd-w", line, "notices の行に W の絶対パスを入れない（next_args の字数が W の置き場所で動く）")
        self.assertNotIn("facts.json", line)
        many = {"f1a": {"counts": {"verified": 12345, "unverified": 678}}}
        other = run({"args": args(), "formal_request_at": {"f1a": 3}, "formal_status_at": many})["result"]
        done = run({"args": other["next_args"], "formal_status_at": many})["result"]
        [line2] = [n for n in done["notices"] if "f1a" in n]
        self.assertEqual(len(line2), len(line), "件数で長さの変わらない固定の形")

    # 再検証の後に決めた直し方 2
    def test_差し戻しはcex_docsの文書を持つ単位のwriterだけを起動する(self):
        units = [{"id": "U-1", "docs": ["requirements/x"], "depends_on": []}, {"id": "U-2", "docs": ["specifications/x"], "depends_on": ["U-1"]}]
        spec, _, res = self._first(units=units, formal_status_at={"f1a": {"counts": {"counterexample": 1}, "cex_docs": ["specifications/x"]}})
        r = run({**spec, "args": res["next_args"]})
        self.assertEqual([l for l in r["labels"] if ":formal-" in l and l.startswith("writer:")], ["writer:U-2:formal-1"])

    # 差分の検証の後に決めた直し方 4
    def test_formalを途中で変えたnext_argsは受け付けない(self):
        # formal は最初の呼び出しで決める（SKILL.md）。次のどちらかで守る: next_args の打ち直しとして拒む（ENV_ARGS から外して state_hash に入れる）
        # か、formal を変えた next_args を明示の理由で拒む。どちらでも、変えた next_args では段を進めない。
        spec = {"findings": {"wholeReviewer:r1": [{"id": "r1-wh-all-001", "route": "decision"}]}, "questions_at": {"6": ["RS-010"]}}
        for name, first, changed in (("false にした", args(), False), ("付けていた false を外した", args(formal=False), None)):
            with self.subTest(name):
                g = run({"args": first, **spec})["result"]
                self.assertEqual(g["status"], "needs_answers", g.get("reason"))
                na = {k: v for k, v in g["next_args"].items() if k != "formal"}
                if changed is not None:
                    na["formal"] = changed
                # 段を進めないので、3a' の resolver の返りは spec に置かない（置くと一度も引かれない段として落ちる）
                r = run({"args": na})
                res = r.get("result")
                rejected_as_edit = "返った next_args を変えずに渡し直してください" in (r.get("error") or "")
                rejected_by_reason = res is not None and res["status"] == "blocked" and "formal" in (res.get("reason") or "")
                self.assertTrue(rejected_as_edit or rejected_by_reason, (r.get("error"), res and res.get("reason")))
                self.assertFalse(has(r["labels"], "writer:"), "変えた next_args で段を進めない")

    # 差分の検証の後に決めた直し方 7
    def test_formal_falseのrunはreportに行わなかったと書かせる値を返す(self):
        # 司令塔が formal-off を実行しなかった W でも、report.md が「形式検証を行わなかった」と書けるように、script の返り値が
        # doc_check report に渡す値（formal_off: 理由）を持つ。formal-method を使った run は持たない。
        off = run({"args": args(formal=False)})["result"]
        self.assertEqual(off["status"], "done", off.get("reason"))
        self.assertTrue(off.get("formal_off"), "formal: false の run は report に渡す formal_off を返す")
        on = run({"args": args()})["result"]
        self.assertFalse(on.get("formal_off"))
        skill = (SKILL / "SKILL.md").read_text(encoding="utf-8")
        self.assertTrue([l for l in skill.split("\n") if "doc_check.mjs report" in l and "--formal-off" in l], "司令塔が report に formal_off を渡す手順が SKILL.md にある")

    # 13
    def test_SKIP_FACTSに形式検証の2つの値がある(self):
        self.assertLessEqual({"no_formal_target", "formal_unavailable"}, set(value("SKIP_FACTS")))


if __name__ == "__main__":
    unittest.main()
