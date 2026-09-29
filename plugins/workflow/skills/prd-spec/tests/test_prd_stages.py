"""scripts/prd.js の段の経路の smoke テスト。

agent / pipeline / parallel / log / phase を stub にして prd.js を node で走らせ、段の順序と
起動の条件と上限を確かめる。stub の agent は label で応答を返し分ける（label の形は
`<役>:<段や周回>:<対象>` で、prd.js が付ける）。

押さえること（設計書 §4 の「移すテスト」）:
- 問い 0 件なら 1 回の run で done になる（resolver の段 3 も段 6 も起動しない。3v は必ず起動する）
- G0・G1 で needs_answers になり、next_args をそのまま渡すと続きの段から走る
- 改稿と監査は収束（blocking 0・進展なし）か上限（MAX_AUDIT_PASSES）で止まり、最後のパスの監査を飛ばさない
- writer の申告に無い変更 ID があれば、変更の起きた文書に監査が追加で起動する
- 任意の from から再実行すると、その段から進む。要る state が無ければ止まる
- 応答しなかった agent を「0 件」として扱わず、blocked にして、その段からの next_args を返す

構文の確認もここで行う。prd.js は `export const meta` とトップレベルの return を持つので、
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
from test_prd_pure import WORKFLOW_IO, contract_values, value  # noqa: E402
from test_ledger import _exported  # noqa: E402

SKILL = Path(__file__).resolve().parents[1]
PRD = SKILL / "scripts" / "prd.js"

HARNESS = r"""
const spec = JSON.parse(process.argv[2])
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
  rs: Object.fromEntries(Object.keys(st0.about || {}).map((id) => [id, { about: aboutOf(st0.about[id]), ruling: rulingOf(id) }])),
}
const persist = () => {
  if (spec.world) fs.writeFileSync(spec.world, JSON.stringify(disk))
}
let flowSha = disk.flow
// 段の token（doc_check の put・del と同じ）: 台帳を書く役のプロンプトの「トークン:」の行。書く前に、その token の下で最初に書く
// 台帳の控え（disk の欄の組）を disk.tx[token] に取り、新しい token の最初の書き込みで他の token の控えを消す。
// restore は入口の flow-check のプロンプトの doc_check restore --token で、控えを戻して token の控えを消す。
// docs: 文書の本文の版（writer が書くたびに 1 増える）。本文は doc_check を通らないので、控えは段 4・7 の flow-check の backup だけが取る。
const TX_KEYS = { flow: ['flow', 'els'], verifications: ['verdicts'], resolutions: ['rs'], open: ['open_ids'], docs: ['docs'] }
let curToken = null
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
const restoreTx = (token) => {
  const before = flowSha
  const pre = (disk.tx || {})[token]
  const prunedBy = pre ? [] : Object.keys(disk.tx || {}).filter((t) => seqOf(t) > seqOf(token)).sort()
  if (prunedBy.length) return JSON.stringify({ token, restored: 0, files: [], pruned_by: prunedBy, flow_before: String(before), flow_after: String(before) })
  for (const keys of Object.values(pre || {})) for (const [k, x] of Object.entries(keys)) if (x.absent) delete disk[k]; else disk[k] = x.value
  if (disk.tx) delete disk.tx[token]
  flowSha = disk.flow
  preexisting = new Set(Object.keys(disk.rs || {}))
  persist()
  return JSON.stringify({ token, restored: Object.keys(pre || {}).length, files: [], pruned_by: [], flow_before: String(before), flow_after: String(flowSha) })
}
// reset: doc_check reset と同じく、S0 が書いたもののほか（台帳・控え）を消す。
const resetWorld = (keep, fixed) => {
  const removed = ['flow', 'els', 'verdicts', 'rs', 'open_ids', 'tx'].filter((k) => disk[k] !== undefined && disk[k] !== null)
  Object.assign(disk, { flow: null, els: {}, verdicts: {}, rs: {} })
  delete disk.open_ids
  delete disk.tx
  // reset は --keep に無い文書を消す（残した文書の本文は S0 の版に戻らないが、stub は版を数えるだけなので残す）。
  const kept = keep ? keep.split(',') : []
  disk.docs = Object.fromEntries(Object.entries(disk.docs || {}).filter(([k]) => kept.includes(k)))
  flowSha = null
  preexisting = new Set()
  persist()
  const keys = (x) => (x ? x.split(',').sort() : [])
  return JSON.stringify({ reset: true, removed, kept: spec.reset_kept || keys(keep), fixed: spec.reset_fixed || keys(fixed) })
}
const setFlow = (x) => {
  touch('flow')
  flowSha = x
  disk.flow = x
  persist()
}
const at = (key, stage) => (spec[key] || {})[stage]
if (spec.failed_current_at) throw new Error('failed_current_at は使わない（不合格は verifier の put と要素の版から出る）')
// rewrite: flow を書く役（flow-framer・flow を書く resolver）が unverified_at[段] の要素を書き換える。flow を書かない役の段に
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
const answerRs = (id) => {
  touch('resolutions')
  disk.rs[id] = { ...disk.rs[id], av: (disk.rs[id].av ?? 0) + 1 }
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
const onDisk = (rulings) => ({
  unverified: Object.keys(disk.els).sort().filter((id) => verdictAt(id) !== 'pass'),
  failed_current: Object.keys(disk.els).sort().filter((id) => verdictAt(id) === 'fail'),
  ...(rulings ? {
    resolutions: Object.keys(disk.rs).sort().map((id) => {
      const v = rsVerdict(id)
      return { id, about: disk.rs[id].about ?? null, ruling: disk.rs[id].ruling ?? null, verdict: v ? v.verdict : null, ...(v && v.verdict === 'fail' ? { fail_kind: v.kind ?? null } : {}) }
    }),
  } : {}),
})
const asksRulings = (prompt) => /doc_check\.mjs flow --workspace \S+ --rulings`/.test(prompt)
// open_only_at・stale_refs_at・pair_keys_at・open_ids_at: 段（label の 2 つ目）ごとの doc_check flow / conflicts の stdout の一覧（要素の中身の事実）。
// flow_codes_at: 段ごとの指摘の符号と場所。無ければ件数の分だけ、flow を書くどの役にも直せる符号（FLOW_DANGLING）にする。
// latest: 最後に出した doc_check flow の stdout（W は 1 つなので、flow も台帳も書かない呼び出しの後にも残る）。flow.json を書かない resolver と
// flow-check は、自分の段の *_at が無ければこれを見る（書き換えたことは *_at か recheck_as で明示する）。
let latest = null
const WORLD_AT = ['flow_codes_at', 'flow_findings_at', 'open_only_at', 'stale_refs_at', 'open_ids_at']
const explicitAt = (stage) => WORLD_AT.some((k) => at(k, stage) !== undefined)
// keep: 組は flow.json・decisions.json で決まり verifier は書かないので、verifier の stdout は既定で最後の世界の組を出す（verifier_pair_keys_at で上書き）。
// framer: open.json を書く flow-framer の stdout か（O- の既定は framerOpens の上）。
const flowStdout = (count, sha, stage, keep, framer, rulings) => {
  const codes = at('flow_codes_at', stage) || (count ? { FLOW_DANGLING: Array.from({ length: count }, (_, i) => `F-8${String(i).padStart(2, '0')}`) } : {})
  const findings = Object.values(codes).reduce((n, xs) => n + xs.length, 0)
  latest = { findings, codes, open: spec.flow_open || 0, path: 'checks/flow.json', digest: 'fd', open_only: at('open_only_at', stage) || [], stale_refs: at('stale_refs_at', stage) || [], open_ids: at('open_ids_at', stage) || (framer ? (stage === 'framer' ? framerOpens() : []) : latest ? latest.open_ids : disk.open_ids || []), pair_keys: (keep && (at('verifier_pair_keys_at', stage) || (latest && latest.pair_keys))) || at('pair_keys_at', stage) || [] }
  return JSON.stringify({ ...latest, content_sha256: sha, ...onDisk(rulings) })
}
// open.json は flow-framer だけが書くので、flow-framer の stdout の O- は open_ids_at（段 2 は無ければ flow_open の件数）で決め、ほかの役の
// stdout は最後の世界の O- を出す。flow-framer が足した O- は W（disk.open_ids）に残り、前の run の後の入口の flow-check もそれを数える。
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
const about = (id) => (spec.about || {})[id] || { open: `O-${id}` }
// state から始めた W の open.json は、段 2 の flow-framer が書いたものにする。
if (!saved && st0.flow_digest) disk.open_ids = framerOpens()
const TX_ROLES = ['intake', 'flow-framer', 'resolver', 'verifier', 'writer']
function respond(prompt, label) {
  const base = label.replace(/#retry$/, '')
  const [role, stage, target] = base.split(':')
  curToken = (/^トークン: (\S+)$/m.exec(prompt) || [])[1] || null
  if (TX_ROLES.includes(role) && !curToken) throw new Error(`${label}: 台帳を書く役のプロンプトにトークンがありません`)
  if (role === 'intake') {
    const plan = (spec.plan_findings || {})[base]
    return { plan_check: plan === null ? '' : JSON.stringify({ findings: plan || 0, path: 'checks/plan.json', digest: 'p', content_sha256: H('plan') }), units: spec.units || [{ id: 'U-1', docs: ['requirements/x'], depends_on: [] }] }
  }
  if (role === 'flow-framer') {
    setFlow(H(`f-${stage || 'framer'}`))
    const k = target ? `${stage}-${target}` : stage || 'framer'
    rewrite(k)
    const out = { flow_check: flowStdout(at('flow_findings_at', k) || (spec.broken_flow ? 1 : 0), flowSha, k, false, true), conflicts_check: conflictsStdout(k) }
    const opens = [...new Set([...(disk.open_ids || []), ...latest.open_ids])].sort()
    if (JSON.stringify(opens) !== JSON.stringify(disk.open_ids)) touch('open')
    disk.open_ids = opens
    persist()
    if ((spec.no_conflicts_check_at || []).includes(k)) delete out.conflicts_check
    // plan_seen: flow-framer が実行した doc_check plan の stdout（null は返さない）。
    if (prompt.includes('doc_check.mjs plan ') && spec.plan_seen !== null) {
      const seen = spec.plan_seen || {}
      out.plan_check = JSON.stringify({ findings: seen.findings || 0, path: 'checks/plan.json', digest: 'p', content_sha256: H(seen.sha || 'plan') })
    }
    const asked = ids((/--ids (\S+) --check/.exec(prompt) || [])[1], /RS-\d+/g)
    if (asked.length) {
      const bad = (spec.bad_questions_at || []).includes(k) ? 1 : 0
      out.questions_check = JSON.stringify({ check: true, ids: asked, questions: asked.length - bad, findings: bad, bad_ids: bad ? [asked[0]] : [] })
    }
    return out
  }
  if (role === 'resolver') {
    // fresh_ids: 新しく裁定する呼び出しは、前の run が W に残した ID を使わずに新しい ID を振る（実物の resolver は台帳の続きの番号を取る）。
    // 同じ ID を書き換える呼び出し（差し戻し・変換・保持規則への変換・回答の反映・形の修正）は ID を変えない。
    const renames = spec.fresh_ids && !/(-convert|-(re)?hold|-questions(-\d+)?|-flow(-\d+)?|')$/.test(stage) && !['3a', "3a'"].includes(stage)
    const fresh = (id) => (renames && preexisting.has(id) ? `RS-${Number(id.slice(3)) + 500}` : id)
    const as = (id) => ({ id: fresh(id), about: about(id) })
    // 変換（-convert）は、その段の ruled_at・questions_at・holds_at が無ければ求められたとおりの種類で ID を返す（契約どおりの resolver）。
    const convert = /-convert$/.test(stage) && ['ruled_at', 'questions_at', 'holds_at'].every((k) => at(k, stage) === undefined) ? [...prompt.matchAll(/- (RS-\d+) → (question|hold)/g)] : []
    const q = [...(at('questions_at', stage) || []), ...convert.filter((m) => m[2] === 'question').map((m) => m[1])].map(as)
    // ruled_seq_at: 同じ label の呼び出しごとに違う裁定を返す（パスごとの段 6 など）。
    const seq = (spec.ruled_seq_at || {})[stage]
    const ruled = ((seq && seq.length ? seq.shift() : at('ruled_at', stage)) || []).map(as)
    // 聞くゲートの無い問いの変換（-hold）は、holds_at が無ければ求められた ID をそのまま hold で返す（契約どおりの resolver）。
    const heldIds = at('holds_at', stage) || (/-(re)?hold$/.test(stage) ? ids((/ID は変えない: ([^\n]*)/.exec(prompt) || [])[1], /RS-\d+/g) : convert.filter((m) => m[2] === 'hold').map((m) => m[1]))
    const holds = heldIds.map(as)
    // 回答を当てた問い（3a・3a' の ruled）は、同じ ID の question に answer を足すだけで ruling は question のまま（契約の question（answer あり））。
    const answers = ['3a', "3a'"].includes(stage)
    const chose = (x, ruling) => answers && ruling === 'internal' && (disk.rs[x.id] || {}).ruling === 'question'
    for (const [xs, ruling] of [[ruled, 'internal'], [q, 'question'], [holds, 'hold']]) for (const x of xs) chose(x, ruling) ? answerRs(x.id) : writeRs(x.id, { about: x.about, ruling })
    for (const id of at('free_text_at', stage) || []) writeRs(id, { about: disk.rs[id] ? disk.rs[id].about : about(id), ruling: 'question' })
    // 問いの形の修正は、直した問いの question・options を書き換える（合格は持ち越さない）。
    if (/-questions(-\d+)?$/.test(stage)) for (const id of ids((/--ids (\S+) --check/.exec(prompt) || [])[1], /RS-\d+/g)) if (disk.rs[id] && !q.some((x) => x.id === id)) writeRs(id, { about: disk.rs[id].about, ruling: disk.rs[id].ruling })
    // orphans_at: 台帳に書いたが返さない hold（応答した呼び出しが返り値に載せなかった裁定。所有表の外の書き込みと同じく W にだけ残る）。
    for (const id of at('orphans_at', stage) || []) writeRs(id, { about: about(id), ruling: 'hold' })
    persist()
    // resolutions.json の sha256 は中身で決まる（同じ中身を書き直しても変わらない）。版の数（v・av）も中身に数える。
    sha = H(`rs-${hash(JSON.stringify(Object.entries(disk.rs).sort().map(([id, r]) => [id, r.about, r.ruling, r.v ?? 0, r.av ?? 0])))}`)
    const out = { ruled, questions: q, holds, supersedes: at('supersedes_at', stage) || [], free_text: at('free_text_at', stage) || [], routes: at('routes_at', stage) || [], [spec.resolver_sha_key || 'resolutions_sha256']: sha }
    const checked = at('questions_check_ids_at', stage) || (/-questions(-\d+)?$/.test(stage) ? ids((/--ids (\S+) --check/.exec(prompt) || [])[1], /RS-\d+/g) : q.map((x) => x.id))
    if (checked.length) {
      const bad = (spec.bad_questions_at || []).includes(stage) ? 1 : 0
      out.questions_check = JSON.stringify({ check: true, ids: checked, questions: checked.length - bad, findings: bad, bad_ids: bad ? [checked[0]] : [] })
    }
    const keepsFlow = prompt.includes('この呼び出しでは flow.json を書かない')
    const returnsFlow = ["3a", "3a'"].includes(stage) || /-flow(-\d+)?$/.test(stage) || keepsFlow || at('flow_sha_at', stage) !== undefined
    if (keepsFlow) readOnly(stage)
    else if (returnsFlow && at('flow_sha_at', stage) !== undefined) rewrite(stage)
    else readOnly(stage)
    if (returnsFlow && !(spec.no_flow_check_at || []).includes(stage)) {
      if (at('flow_sha_at', stage) !== undefined) setFlow(H(at('flow_sha_at', stage)))
      // resolver_rulings_at: --rulings を付けて doc_check flow を実行した resolver（stdout に resolutions が載る）。
      const withRulings = (spec.resolver_rulings_at || []).includes(stage)
      out.flow_check = keepsFlow && !explicitAt(stage) ? latestStdout(flowSha, withRulings) : flowStdout(at('flow_findings_at', stage) || 0, flowSha, stage, false, false, withRulings)
      if (!keepsFlow && !(spec.no_conflicts_check_at || []).includes(stage)) out.conflicts_check = conflictsStdout(stage)
    }
    return out
  }
  if (role === 'flow-check') {
    // recheck_as: 変換の resolver の申告と違う世界を flow-check に見せる（resolver の stdout の過少申告）。無ければ最後の世界（latest）を見る。
    const k = (spec.recheck_as || {})[stage]
    readOnly(stage)
    const backup = /doc_check\.mjs backup --workspace \S+ ((?:--doc \S+ )+)--token (\S+?)`/.exec(prompt)
    if (backup) {
      if ((spec.no_backup_at || []).includes(base)) return {}
      curToken = backup[2]
      touch('docs')
      persist()
      return { backup_check: JSON.stringify({ backup: true, token: backup[2], docs: ids(backup[1], /[a-z]+\/[A-Za-z0-9._-]+/g).sort() }) }
    }
    const reset = /doc_check\.mjs reset --workspace \S+(?: --keep (\S+?))?(?: --fixed (\S+?))?`/.exec(prompt)
    if (reset) return (spec.no_reset_at || []).includes(base) ? {} : { reset_check: resetWorld(reset[1], reset[2]) }
    const tx = /doc_check\.mjs restore --workspace \S+ --token (\S+?)`/.exec(prompt)
    const restored = tx && !(spec.no_restore_at || []).includes(base) ? { restore_check: restoreTx(tx[1]) } : {}
    const rulings = asksRulings(prompt)
    return { ...restored, flow_check: k ? flowStdout(at('flow_findings_at', k) || 0, flowSha, k, false, false, rulings) : latestStdout(flowSha, rulings) }
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
    // 'unverified のうち failed_current に無い要素すべて'（prd.js の VERIFY_ALL）は、実物の verifier と同じく最初の doc_check flow から対象を取る。
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
    }
  }
  if (role === 'writer') {
    const revise = stage.endsWith('revise') || target === 'revise'
    const unit = stage
    const docs = (spec.units || [{ id: 'U-1', docs: ['requirements/x'] }]).find((u) => u.id === unit).docs
    disk.docs = { ...(disk.docs || {}), ...Object.fromEntries(docs.map((k) => [k, ((disk.docs || {})[k] ?? 0) + 1])) }
    persist()
    return {
      unit,
      docs: docs.map((key) => ({ key, digest: H(`w-${key}`), doc_check_findings: 0, doc_check_blocking: 0 })),
      // writer_changed_seq: パスごとの改稿の申告（label はパスをまたいで同じなので、呼ばれた順に取る）。
      changed_items: revise ? (spec.writer_changed_seq ? spec.writer_changed_seq[reviseN++] : ((spec.writer_changed_by_unit || {})[unit] || spec.writer_changed || ['PR-X-001'])) : [],
      open_tbd: spec.open_tbd || [],
      new_tbd: revise ? spec.new_tbd_revise || [] : spec.new_tbd || [],
      // unapplied_seq: パスごとの改稿で当て損ねた指摘（呼ばれた順に取る）。
      applied_findings: revise ? minusIds(ids(prompt, /r\d+-[a-z]{2}x?-[A-Za-z0-9_.-]+-\d+/g), (spec.unapplied_seq || [])[unappliedN++] || []) : [],
      applied_routes: revise ? ids(prompt, /RT-\d+/g) : [],
      resolutions_sha256: sha,
    }
  }
  if (['implementer', 'grounding', 'crossDoc'].includes(role)) {
    const n = Number(stage.slice(1))
    const byKey = spec.findings || {}
    // 追加の監査役（label の末尾が :extra）には、その label で明示した指摘だけを返す（1 体目と同じ指摘を返すと ID が重なる）。
    const findings = (base.endsWith(':extra') ? byKey[base] || [] : byKey[`${role}:${stage}:${target}`] || byKey[`${role}:${stage}`] || []).map((f) => ({ doc: 'requirements/x', item_id: 'PR-X-001', blocking: true, route: 'writer', direction: 'remove', origin: 'text', ...f }))
    const out = { path: `findings/${stage}-${role}.json`, findings }
    if (prompt.includes('あなたは指名された監査役')) {
      // files は snapshot の stdout に無い一覧で、script が一覧を notices に写したら next_args の上限テストが落ちるように置く。
      const listed = (count, kind) => Array.from({ length: count }, (_, i) => `tmp/writer__U-1__draft/${kind}-${String(i).padStart(3, '0')}.pre${i}.json`)
      const found = {
        stray: { count: (spec.stray_at || {})[stage] || 0, path: `checks/audited-${n}.stray.json`, files: listed((spec.stray_at || {})[stage] || 0, 'stray') },
        size_over: { count: (spec.size_over_at || {})[stage] || 0, path: `checks/audited-${n}.sizes.json`, files: listed((spec.size_over_at || {})[stage] || 0, 'size') },
      }
      const docCheck = JSON.stringify({ blocking: (spec.doc_blocking_at || {})[stage] || 0, flow_refs: spec.doc_flow_refs || {} })
      if (n === 1) out.designated = { doc_check: docCheck, audited: JSON.stringify({ digest: H('a1'), ...found }) }
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
        }
      }
    }
    return out
  }
  throw new Error(`unknown label ${label}`)
}
// budget: runtime の budget と同じ形（total・spent()・remaining()）。agent を 1 回起動するたびに per_call（既定 1）を使い、spent() が
// total に達した後の agent() は throw する（runtime と同じ）。spec.budget が無ければ globalThis.budget を置かない（Codex の runner と同じ）。
let spent = (spec.budget && spec.budget.spent) || 0
if (spec.budget) globalThis.budget = { total: spec.budget.total, spent: () => spent, remaining: () => (spec.budget.total == null ? Infinity : Math.max(0, spec.budget.total - spent)) }
// hold_until_extra: その label の監査役を、追加の監査役（:extra）が起動するまで返さない（1.5 秒で諦め、held_timeout に残す）。
let releaseExtra
const extraStarted = new Promise((r) => (releaseExtra = r))
let heldTimeout = false
const findingFiles = []
const prompts = []
let auditSchema = null
const optsSeen = {}
let resolverSchema = null
let attempted = 0
const agent = async (prompt, opts) => {
  attempted += 1
  if (spec.budget && spec.budget.total != null && spent >= spec.budget.total) throw new Error('budget exhausted')
  spent += (spec.budget && spec.budget.per_call) || 1
  labels.push(opts.label)
  if (opts.label.endsWith(':extra')) releaseExtra()
  if (spec.hold_until_extra === opts.label) heldTimeout = await Promise.race([extraStarted.then(() => false), new Promise((r) => setTimeout(() => r(true), 1500))])
  if (['implementer', 'grounding', 'crossDoc'].includes(opts.label.split(':')[0])) auditSchema = opts.schema
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
  if (m && !opts.label.endsWith('#retry')) findingFiles.push(m[1])
  // inherit_labels: role_opts の inherit で model を外した役の label の接頭辞（その役だけ model が無くてよい）。
  if (!opts.effort || (!opts.model && !(spec.inherit_labels || []).some((x) => opts.label.startsWith(x)))) throw new Error(`model / effort が無い呼び出し: ${opts.label}`)
  if (nulls.has(opts.label)) return null
  // silent_after_write: W に書いてから応答しない呼び出し（書き込みは残り、返り値は無い）。
  const got = respond(prompt, opts.label)
  return (spec.silent_after_write || []).includes(opts.label) ? null : got
}
// runtime_pipeline: runtime の pipeline と同じく、throw した段をその項目の null にする（既定は throw をそのまま伝え、stub の契約違反を隠さない）。
const pipeline = async (items, stage) => Promise.all(items.map((it, i) => (spec.runtime_pipeline ? Promise.resolve().then(() => stage(it, it, i)).catch(() => null) : stage(it, it, i))))
const parallel = async (thunks) => Promise.all(thunks.map((t) => t()))
const log = (m) => logs.push(m)
const phase = () => {}
let result, error = null
try {
  result = await __main(spec.args, agent, pipeline, parallel, log, phase)
} catch (e) {
  error = String(e && e.message ? e.message : e)
}
console.log(JSON.stringify({ result, labels, logs, error, findingFiles, prompts, auditSchema, resolverSchema, disk: onDisk(true), docs: disk.docs || {}, heldTimeout, opts: optsSeen, attempted }))
"""


def wrapped_source(patch=()):
    """patch: prd.js の本文の (元, 置換) の組。script の欠陥を作って、欠陥を止める検査に届かせるためだけに使う。"""
    src = PRD.read_text(encoding="utf-8")
    for old, new in patch:
        assert src.count(old) == 1, old
        src = src.replace(old, new)
    assert src.startswith("export const meta = {"), "prd.js は export const meta から始まる"
    body = src[len("export ") :]
    return (
        "async function __main(args, agent, pipeline, parallel, log, phase) {\n"
        + body
        + "\n}\n"
        + HARNESS
    )


def run(spec, patch=()):
    spec = {"verify_all_mark": VERIFY_ALL_MARK, **spec}
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "prd_harness.mjs"
        path.write_text(wrapped_source(patch), encoding="utf-8")
        out = subprocess.run(["node", str(path), json.dumps(spec)], capture_output=True, text=True, check=True)
    return json.loads(out.stdout)


def args(**kw):
    """手で組んだ state には、prd.js が next_args に付けるのと同じ state_hash を付ける。"""
    a = {"workspace": "/tmp/prd-w", "skillDir": str(SKILL), "entry": "new"}
    a.update(kw)
    if "state" in kw and "state_hash" not in kw:
        a["state_hash"] = value(f"nextArgsHash({json.dumps(a, ensure_ascii=False)})")
    return a


def const(name):
    return int(re.search(rf"const {name} = (\d+)", PRD.read_text(encoding="utf-8")).group(1))


MAX_AUDIT_PASSES = const("MAX_AUDIT_PASSES")


def new_item_each_round(rounds, **extra):
    """監査 r1〜r<rounds> が、毎回別の項目に blocking を 1 件出す（再発にならない）。"""
    fs = {"implementer:r1": [{"id": "r1-im-requirements__x-001", **extra}]}
    for k in range(2, rounds + 1):
        fs[f"grounding:r{k}"] = [{"id": f"r{k}-gr-requirements__x-{k:03d}", "item_id": f"PR-X-{k:03d}", **extra}]
    return fs


# VERIFY_ALL_MARK: prd.js の VERIFY_ALL の文面の一部（verifier に W の unverified から検証させる指示。stub の verifier もこれで対象を取る）。
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


def has(labels, prefix):
    return any(l.startswith(prefix) for l in labels)


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
        self.assertEqual(labels[:2], ["flow-check:1-entry", "intake"])
        self.assertFalse(has(labels, "resolver:3"), "open も組も 0 件なら段 3 の resolver は起動しない")
        self.assertTrue(has(labels, "verifier:3v"), "3v は open も組も 0 件でも必ず起動する")
        self.assertFalse(has(labels, "resolver:6"), "decision の指摘も新しい TBD も 0 件なら段 6 は起動しない")
        self.assertFalse(has(labels, "writer:U-1:revise"))
        self.assertFalse(has(labels, "resolver:9"), "事後報告は導出物なので生成する役を起動しない")
        self.assertEqual(r["result"]["report_path"], "/tmp/prd-w/report.md")
        self.assertIsNone(r["result"]["next_args"])

    def test_G0でneeds_answersになりnext_argsで続きから走る(self):
        spec = {"args": args(), "flow_open": 1, "questions_at": {"3": ["RS-001"]}}
        r1 = run(spec)
        res = r1["result"]
        self.assertEqual(res["status"], "needs_answers")
        self.assertEqual(res["question_ids"], ["RS-001"])
        self.assertEqual(res["answers_path"], "/tmp/prd-w/answers/g0.md")
        self.assertEqual(res["next_args"]["from"], "3a")
        self.assertFalse(has(r1["labels"], "writer"), "問いがあれば初稿の前に止まる")
        self.assertEqual(json.loads(json.dumps(res["next_args"])), res["next_args"])

        r2 = run({"args": res["next_args"], "ruled_at": {"3a": ["RS-001"]}})
        self.assertIsNone(r2["error"])
        self.assertEqual(r2["result"]["status"], "done")
        self.assertEqual(r2["labels"][:2], ["flow-check:3a-entry", "resolver:3a"], "段 3 以降から始める run は、最初に W を読み直す")
        self.assertFalse(has(r2["labels"], "intake"))
        self.assertIn("verifier:3av", r2["labels"], "回答を flow に当てた段では、候補の選択だけでも verifier が flow を照合する")

    def test_自由記述の回答はverifierに通す(self):
        spec = {"args": args(), "flow_open": 1, "questions_at": {"3": ["RS-001"]}}
        res = run(spec)["result"]
        r2 = run({"args": res["next_args"], "ruled_at": {"3a": ["RS-001"]}, "free_text_at": {"3a": ["RS-001"]}})
        self.assertTrue(has(r2["labels"], "verifier:3av"))
        self.assertEqual(r2["result"]["status"], "done")

    def test_free_textだけに入れた回答が2回落ちるとG0ではG0_2の問いにG0_2ではholdになる(self):
        fail = {"id": "RS-001", "kind": "insufficient_grounds", "reason": "回答の文面から対応づけが読めない"}
        res = run({"args": args(), "flow_open": 1, "questions_at": {"3": ["RS-001"]}})["result"]
        g0 = run({
            "args": res["next_args"],
            "free_text_at": {"3a": ["RS-001"], "3a'": ["RS-001"]},
            "fails_when_asked": [fail],
            "questions_at": {"3a-convert": ["RS-001"]},
        })
        prompts = {p["label"]: p["prompt"] for p in g0["prompts"]}
        self.assertIn("RS-001 → question（insufficient_grounds）", prompts["resolver:3a-convert"])
        self.assertEqual(g0["result"]["status"], "needs_answers")
        self.assertEqual(g0["result"]["question_ids"], ["RS-001"])
        self.assertEqual(g0["result"]["answers_path"], "/tmp/prd-w/answers/g0-2.md")

        g02 = run({
            "args": g0["result"]["next_args"],
            "free_text_at": {"3a": ["RS-001"], "3a'": ["RS-001"]},
            "fails_when_asked": [fail],
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
            "ruled_at": {"3": ["RS-001"], "3'": ["RS-001"]},
            "verifier_fail": {"3v": [fail], "3v'": [fail]},
            "questions_at": {"3-convert": ["RS-001"]},
        }
        r = run(spec)
        labels = r["labels"]
        self.assertEqual(
            [l for l in labels if l.startswith(("resolver:", "verifier:"))],
            ["resolver:3", "verifier:3v", "resolver:3'", "verifier:3v'", "resolver:3-convert"],
            "差し戻しは 1 回きりで、変換の後に検証を回さない",
        )
        self.assertEqual(r["result"]["status"], "needs_answers", "価値の判断は問いになって G0 に届く")
        self.assertEqual(r["result"]["question_ids"], ["RS-001"])

    def test_実測で価値を決めた裁定は検証役が節を読んで落とし問いに変わる(self):
        # 前回の試走の RS-010: O-010 の失敗の行き先を measured（現行の挙動）で決め、3v を通って G1 まで残った形。
        fail = {"id": "RS-010", "kind": "value_as_method", "reason": "失敗の行き先を現行の挙動で決めた"}
        spec = {
            "args": args(),
            "flow_open": 1,
            "about": {"RS-010": {"open": "O-010"}},
            "ruled_at": {"3": ["RS-010"], "3'": ["RS-010"]},
            "verifier_fail": {"3v": [fail], "3v'": [fail]},
            "questions_at": {"3-convert": ["RS-010"]},
        }
        r = run(spec)
        prompts = {p["label"]: p["prompt"] for p in r["prompts"]}
        for label in ("resolver:3", "verifier:3v", "verifier:3v'"):
            self.assertIn("「## 現物と既存実装の扱い」", prompts[label], label)
        self.assertIn("RS-010 → question（value_as_method）", prompts["resolver:3-convert"])
        self.assertEqual(r["result"]["status"], "needs_answers")
        self.assertEqual(r["result"]["question_ids"], ["RS-010"])

    def test_差し戻しで合格すれば変換しない(self):
        fail = {"id": "RS-001", "kind": "insufficient_grounds", "reason": "出典が無い"}
        spec = {"args": args(), "flow_open": 1, "ruled_at": {"3": ["RS-001"], "3'": ["RS-001"]}, "verifier_fail": {"3v": [fail]}}
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
                self.assertEqual((r["result"]["status"], r["result"]["next_args"]["from"]), ("blocked", "3"), r["result"].get("reason"))
                self.assertIn(f"合わない ID を返しました: 「{bad}」", r["result"]["reason"])
                self.assertFalse(has(r["labels"], "verifier:"))

    def test_差し戻しのresolverが不合格の裁定を返さなければ止める(self):
        # 返らない裁定は v2 に渡らず、変換にも回らないまま failed_ids に残る。
        fail = [{"id": "RS-001", "kind": "insufficient_grounds", "reason": "r"}, {"id": "RS-002", "kind": "insufficient_grounds", "reason": "r"}]
        base = {"args": args(), "flow_open": 1, "verifier_fail": {"3v": fail}}
        for name, kw in (("ruled", {"ruled_at": {"3": ["RS-001", "RS-002"], "3'": ["RS-001", "RS-002"]}}),
                         ("question と hold", {"ruled_at": {"3": ["RS-001", "RS-002"]}, "questions_at": {"3'": ["RS-001"]}, "holds_at": {"3'": ["RS-002"]}})):
            with self.subTest(name):
                self.assertEqual(run({**base, **kw})["result"]["status"], "needs_answers" if "questions_at" in kw else "done")
        res = run({**base, "ruled_at": {"3": ["RS-001", "RS-002"], "3'": ["RS-001"]}})
        r = res["result"]
        self.assertEqual((r["status"], r["next_args"]["from"]), ("blocked", "3"), r.get("reason"))
        self.assertIn("段 3': 求めた RS-002 を resolver が", r["reason"])
        self.assertFalse(has(res["labels"], "verifier:3v'"))

    def test_空文字のIDを返したresolverは段を止める(self):
        fail = [{"id": "RS-001", "kind": "insufficient_grounds", "reason": "r"}]
        res = run({"args": args(), "flow_open": 1, "ruled_at": {"3": ["RS-001"], "3'": ["RS-001"]}, "verifier_fail": {"3v": fail, "3v'": fail},
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
        full = run({"args": g0["next_args"], "ruled_at": {"3a": ["RS-002"], "3a'": ["RS-002"]}, "free_text_at": {"3a": ["RS-002"]},
                    "verifier_fail": {"3av": [{**asked, "id": "RS-002"}, unasked], "3av'": [{**asked, "id": "RS-002"}, unasked]},
                    "holds_at": {"3a-convert": ["RS-002"]}, "null_labels": ["flow-framer:3b-reframe", "flow-framer:3b-reframe#retry"]})
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
        passed = run({"args": g0["next_args"], "ruled_at": {"3a": ["RS-002"]}, "free_text_at": {"3a": ["RS-002"]}, "verifier_extra_pass": {"3av": ["RS-098"]},
                      "null_labels": ["flow-framer:3b-reframe", "flow-framer:3b-reframe#retry"]})["result"]
        st = passed["next_args"]["state"]
        self.assertIn("RS-002", st["passed"])
        self.assertNotIn("RS-098", st["passed"])
        self.assertEqual(sum("RS-098" in n for n in st["notices"]), 1)
        # 同じ行を持ち越した再実行でも行を重ねない（重ねると next_args が再実行のたびに伸びる）。
        carried = {k: v for k, v in g0["next_args"].items() if k != "state_hash"}
        carried["state"] = {**carried["state"], "notices": [n for n in st["notices"] if "RS-098" in n]}
        again = run({"args": {**carried, "state_hash": value(f"nextArgsHash({json.dumps(carried, ensure_ascii=False)})")}, "ruled_at": {"3a": ["RS-002"]},
                     "free_text_at": {"3a": ["RS-002"]}, "verifier_extra_pass": {"3av": ["RS-098"]}, "null_labels": ["flow-framer:3b-reframe", "flow-framer:3b-reframe#retry"]})
        self.assertIsNone(again["error"], again["error"])
        self.assertEqual(sum("RS-098" in n for n in again["result"]["next_args"]["state"]["notices"]), 1)

    def test_書いた後に同じIDで裁定し直した裁定は次の改稿のwriterに渡す(self):
        # 段 3 の検証の裁定 RS-005 は初稿で writer に渡った。G1 の後の 3a' で F-100 がまた落ち、差し戻しは同じ about の RS-005 を
        # 書き直す（同じ論点に別の ID の裁定は put できない）。written に残すと、書き直した裁定がどの writer にも渡らずに done になる。
        F = [{"id": "F-100", "kind": "insufficient_grounds", "reason": "出典が無い"}]
        base = {"about": {"RS-005": {"verification": "F-100"}, "RS-010": {"finding": "r1-cd-all-001"}},
                "findings": {"crossDoc:r1": [{"id": "r1-cd-all-001", "route": "decision"}]},
                "verifier_fail": {"3v": F, "3a'v": F}, "ruled_at": {"3'": ["RS-005"], "3a'": ["RS-010"], "3a''": ["RS-005"]},
                "unverified_at": {"3-settle": ["F-100"], "3a'": ["F-100"], "3a'-settle": ["F-100"]}, "flow_sha_at": {"3a'": "f-3a2"},
                "questions_at": {"6": ["RS-010"]}}
        g1 = run({**base, "args": args()})["result"]
        self.assertEqual((g1["status"], g1["next_args"]["state"]["settled_written"]), ("needs_answers", ["RS-005"]))
        r = run({**base, "args": g1["next_args"]})
        self.assertEqual(r["result"]["status"], "done", r["result"].get("reason"))
        self.assertIn("resolver:3a''", r["labels"])
        [line] = [l for l in nth_prompt(r, "writer:U-1:revise", 0).split("\n") if l.startswith("前回の書き込みの後に決まった resolution")]
        self.assertIn("RS-005", line)

    def test_変換で求めていないIDを返したresolverは段を止める(self):
        fail = [{"id": "RS-001", "kind": "insufficient_grounds", "reason": "r"}]
        base = {"args": args(), "flow_open": 1, "ruled_at": {"3": ["RS-001", "RS-002"], "3'": ["RS-001"]}, "verifier_fail": {"3v": fail, "3v'": fail}}
        for name, kw in (("hold", {"holds_at": {"3-convert": ["RS-001", "RS-002"]}}),
                         ("ruled", {"holds_at": {"3-convert": ["RS-001"]}, "ruled_at": {**base["ruled_at"], "3-convert": ["RS-003"]}})):
            with self.subTest(name):
                res = run({**base, **kw})
                self.assertFalse(has(res["labels"], "writer:"))
                r = res["result"]
                self.assertEqual((r["status"], r["next_args"]["from"]), ("blocked", "3"), r.get("reason"))
                self.assertIn("変換を求めていない", r["reason"])
                self.assertIn(kw.get("ruled_at", kw["holds_at"])["3-convert"][-1], r["reason"])

    def test_existingでもゲートとblockedの後の段6から再開できる(self):
        a = args(entry="existing", existing_docs=[{"key": "requirements/x", "fixed": False}])
        spec = {"args": a, "findings": {"crossDoc:r1": [{"id": "r1-cd-all-001", "route": "decision"}]}, "questions_at": {"6": ["RS-010"]}}
        g1 = run(spec)["result"]
        self.assertEqual((g1["status"], g1["next_args"]["from"]), ("needs_answers", "3a'"))
        self.assertEqual(g1["hold_drafts"], [])
        after = run({"args": g1["next_args"], "ruled_at": {"3a'": ["RS-010"]}})
        self.assertIsNone(after["error"], after["error"])
        self.assertEqual(after["result"]["status"], "done")
        stopped = run({**spec, "null_labels": ["resolver:6", "resolver:6#retry"]})["result"]
        self.assertEqual((stopped["status"], stopped["next_args"]["from"]), ("blocked", "6"))
        again = run({**spec, "args": stopped["next_args"]})
        self.assertIsNone(again["error"], again["error"])
        self.assertEqual(again["result"]["status"], "needs_answers")

    def test_G1でneeds_answersになる(self):
        spec = {
            "args": args(),
            "findings": {"crossDoc:r1": [{"id": "r1-cd-all-001", "route": "decision"}]},
            "questions_at": {"6": ["RS-010"]},
        }
        r1 = run(spec)
        res = r1["result"]
        self.assertEqual(res["status"], "needs_answers")
        self.assertEqual(res["answers_path"], "/tmp/prd-w/answers/g1.md")
        self.assertEqual(res["next_args"]["from"], "3a'")
        self.assertTrue(has(r1["labels"], "writer:U-1:draft"), "G1 は初稿の後")

        r2 = run({"args": res["next_args"], "ruled_at": {"3a'": ["RS-010"]}})
        self.assertIsNone(r2["error"])
        self.assertEqual(r2["labels"][:2], ["flow-check:3a'-entry", "resolver:3a'"])
        self.assertTrue(has(r2["labels"], "writer:U-1:revise"))
        self.assertTrue(has(r2["labels"], "grounding:r2"), "最後の書き込みには範囲を絞った監査を当てる")
        self.assertEqual(r2["result"]["status"], "done")

    def test_writerの指摘は段6を起動せずに改稿へ届く(self):
        spec = {"args": args(), "findings": {"implementer:r1": [{"id": "r1-im-requirements__x-001"}]}}
        r = run(spec)
        self.assertFalse(has(r["labels"], "resolver:6"))
        self.assertTrue(has(r["labels"], "writer:U-1:revise"))
        self.assertTrue(has(r["labels"], "implementer:r2"), "指摘を出した観点を変えた項目に当て直す")
        self.assertEqual(r["result"]["status"], "done")

    def test_毎パス新しい項目にblockingが出続けるとパスの上限でblockedになり監査は飛ばさない(self):
        last = MAX_AUDIT_PASSES + 1
        spec = {"args": args(), "findings": new_item_each_round(last)}
        r = run(spec)
        res = r["result"]
        self.assertEqual((res["status"], res["stop_reason"], res["passes"], res["item_routes"]), ("blocked", "pass_limit", MAX_AUDIT_PASSES, {}))
        self.assertTrue(has(r["labels"], f"grounding:r{last}"), "最後のパスの改稿の後も監査を当てる")
        self.assertFalse(has(r["labels"], f"grounding:r{last + 1}"))
        self.assertEqual(sum(1 for l in r["labels"] if l.startswith("writer:U-1:revise")), MAX_AUDIT_PASSES)
        self.assertIn("resolver:final", r["labels"])
        self.assertEqual(res["remaining_blocking"], [f"r{last}-gr-requirements__x-{last:03d}"])
        self.assertEqual(res["report_path"], "/tmp/prd-w/report.md")
        [final] = [p["prompt"] for p in r["prompts"] if p["label"] == "resolver:final"]
        self.assertNotIn("report.md", final)
        silent = run({**spec, "null_labels": ["resolver:final", "resolver:final#retry"]})["result"]
        self.assertEqual((silent["status"], silent["report_path"]), ("blocked", "/tmp/prd-w/report.md"))

    def test_輪を出た後に作ったholdは文案で返し本文に入ったholdと分ける(self):
        last = MAX_AUDIT_PASSES + 1
        last_id = f"r{last}-gr-requirements__x-{last:03d}"
        limit = {
            "args": args(),
            "about": {"RS-051": {"finding": last_id}, "RS-050": {"finding": "r1-cd-all-001"}},
            "findings": new_item_each_round(last),
            "holds_at": {"final": ["RS-051"]},
        }
        first_pass = {
            **limit,
            "findings": {**limit["findings"], "crossDoc:r1": [{"id": "r1-cd-all-001", "route": "decision"}]},
            "holds_at": {"6": ["RS-050"], "final": ["RS-051"]},
        }
        for name, spec, holds in (("上限の経路", limit, []), ("1 パス目の hold の経路", first_pass, ["RS-050"])):
            with self.subTest(name):
                r = run(spec)
                res = r["result"]
                self.assertEqual(res["status"], "blocked")
                self.assertIn("resolver:final", r["labels"])
                self.assertEqual(res["holds"], holds)
                self.assertEqual(res["hold_drafts"], ["RS-051"])
                self.assertEqual(res["remaining_blocking"], [last_id], "文案にした指摘も本文には無いので残す")
                self.assertFalse(set(res["holds"]) & set(res["hold_drafts"]))
        revise = [p["prompt"] for p in run(first_pass)["prompts"] if p["label"].startswith("writer:U-1:revise")]
        self.assertIn("RS-050", revise[0], "1 パス目の hold は段 7 で writer に渡る")

    def test_2パス目の問いは保持規則にしてゲートにしない(self):
        spec = {
            "args": args(),
            "findings": {
                "implementer:r1": [{"id": "r1-im-requirements__x-001"}],
                "grounding:r2": [{"id": "r2-gr-requirements__x-001", "route": "decision"}],
            },
            "questions_at": {"6": ["RS-020"]},
        }
        # 1 パス目の段 6 は decision が 0 件で起動しない。2 パス目の段 6 で出た問いは hold に変える。
        r = run(spec)
        self.assertEqual(r["result"]["status"], "done")
        self.assertIn("resolver:6-hold", r["labels"])
        self.assertIn("RS-020", r["result"]["holds"])
        self.assertEqual(r["result"]["hold_drafts"], [])

    def test_申告に無い変更があれば監査を追加で起動する(self):
        spec = {
            "args": args(),
            "findings": {"implementer:r1": [{"id": "r1-im-requirements__x-001", "blocking": False}]},
            "writer_changed": ["PR-X-001"],
            "diff": {"r2": ["PR-X-001", "PR-X-009"]},
        }
        r = run(spec)
        extra = [l for l in r["labels"] if l.endswith(":extra")]
        self.assertTrue(extra, "申告に無い PR-X-009 に監査が追加で起動していない")
        self.assertTrue(any(l.startswith("implementer:") for l in extra))
        self.assertTrue(any(l.startswith("grounding:") for l in extra))
        self.assertEqual(r["result"]["status"], "done")

    def test_何も申告しなかった単位の変更にもその文書で監査を追加で起動する(self):
        units = [
            {"id": "U-1", "docs": ["requirements/x"], "depends_on": []},
            {"id": "U-2", "docs": ["requirements/y"], "depends_on": []},
        ]
        spec = {
            "args": args(),
            "units": units,
            "findings": {
                "implementer:r1:requirements/x": [{"id": "r1-im-requirements__x-001", "blocking": False}],
                "implementer:r1:requirements/y": [
                    {"id": "r1-im-requirements__y-001", "doc": "requirements/y", "item_id": "PR-Y-001", "blocking": False}
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
        extra = [l for l in r["labels"] if l.endswith(":extra")]
        self.assertIn("implementer:r2:requirements/y:extra", extra, "申告しなかった U-2 の文書に監査が届いていない")
        self.assertIn("grounding:r2:requirements/y:extra", extra)
        self.assertFalse(any(":requirements/x:" in l for l in extra), "申告どおりの文書に追加の監査は要らない")
        self.assertEqual(r["result"]["undeclared"], {"requirements/y": ["PR-Y-003"]})
        self.assertEqual(r["result"]["status"], "done")

    def test_追加の監査役は1体目の指摘ファイルを上書きしない(self):
        spec = {
            "args": args(),
            "findings": {"implementer:r1": [{"id": "r1-im-requirements__x-001", "blocking": False}]},
            "writer_changed": ["PR-X-001"],
            "diff": {"r2": ["PR-X-001", "PR-X-009"]},
        }
        files = run(spec)["findingFiles"]
        self.assertEqual(len(files), len(set(files)), f"指摘ファイルが重なっている: {files}")
        self.assertIn("r2-grx-requirements__x", files)
        # キーが -extra で終わる文書の 1 体目とも重ならない。
        docs = ["requirements/x", "requirements/x-extra"]
        by_doc = {"r2": {"requirements/x": {"changed": ["PR-X-001", "PR-X-009"], "added": [], "removed": []}, "requirements/x-extra": {"changed": ["PR-X-001"], "added": [], "removed": []}}}
        files = run({**spec, "units": [{"id": "U-1", "docs": docs, "depends_on": []}], "by_doc": by_doc})["findingFiles"]
        self.assertIn("r2-gr-requirements__x-extra", files)
        self.assertIn("r2-grx-requirements__x", files)
        self.assertEqual(len(files), len(set(files)), f"指摘ファイルが重なっている: {files}")

    def test_diffのdigestが一致しなければblocked(self):
        spec = {
            "args": args(),
            "findings": {"implementer:r1": [{"id": "r1-im-requirements__x-001"}]},
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
        for frm, first in (("4", "flow-check:4-backup"), ("5", "implementer:r1:requirements/x"), ("3", "verifier:3v")):
            with self.subTest(frm=frm):
                r = run({"args": args(**{"from": frm, "state": state})})
                self.assertIsNone(r["error"])
                self.assertEqual(r["labels"][:2], [f"flow-check:{frm}-entry", first])
                self.assertEqual(r["result"]["status"], "done")

    def test_打ち直して変わったnext_argsは止まる(self):
        na = run({"args": args(), "findings": {"crossDoc:r1": [{"id": "r1-cd-all-001", "route": "decision"}]}, "questions_at": {"6": ["RS-010"]}})["result"]["next_args"]
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
        res = run({"args": changed, "ruled_at": {"3a": ["RS-001"]}, "null_labels": ["writer:U-1:draft", "writer:U-1:draft#retry"]})
        self.assertIsNone(res["error"], res["error"])
        na = res["result"]["next_args"]
        self.assertEqual((res["result"]["status"], na["from"]), ("blocked", "4"), res["result"].get("reason"))
        self.assertEqual((na["skillDir"], na["role_opts"]), ("/tmp/prd-spec-1.2.4", {"writer": {"effort": "high"}}))
        self.assertIn("/tmp/prd-spec-1.2.4/", next(p["prompt"] for p in res["prompts"] if p["label"] == "writer:U-1:draft"))

    def test_段8で止まったnext_argsから再開すると当て損ねた指摘が次のパスへ持ち越される(self):
        findings = {"implementer:r1": [{"id": "r1-im-requirements__x-001"}, {"id": "r1-im-requirements__x-002", "item_id": "PR-X-002"}]}
        auditor = "grounding:r2:requirements/x"
        stopped = run({"args": args(), "findings": findings, "unapplied_seq": [["r1-im-requirements__x-002"]], "null_labels": [auditor, f"{auditor}#retry"]})["result"]
        self.assertEqual((stopped["status"], stopped["next_args"]["from"]), ("blocked", "8"), stopped.get("reason"))
        self.assertEqual(stopped["next_args"]["state"]["revised"]["unapplied"], ["r1-im-requirements__x-002"])
        # 持ち越した指摘は 2 パス続けて blocking なので段 6 に回る。そこで止め、段 8 が作った pending を next_args で見る。
        again = run({"args": stopped["next_args"], "null_labels": ["resolver:6", "resolver:6#retry"]})
        self.assertIsNone(again["error"], again["error"])
        self.assertEqual(again["labels"][:2], ["flow-check:8-entry", auditor])
        res = again["result"]
        self.assertEqual(res["status"], "blocked", res.get("reason"))
        self.assertEqual(res["next_args"]["from"], "6")
        self.assertEqual(res["next_args"]["state"]["pending"]["carried"], ["r1-im-requirements__x-002"])

    def test_差し戻しの再検証で合格した決定はwriterに無効として渡さない(self):
        r = run({"args": args(), "verifier_fail": {"3v": [{"id": "D-004", "kind": "unsupported", "reason": "r"}]}, "verifier_extra_pass": {"3v'": ["D-004"]}})
        self.assertIsNone(r["error"], r["error"])
        self.assertIn("resolver:3'", r["labels"])
        self.assertIn("無効な決定（覆された・検証に落ちた。根拠にしない）: （なし）", nth_prompt(r, "writer:U-1:draft", 0))

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
        spec = {"args": args(), "null_labels": ["writer:U-1:draft", "writer:U-1:draft#retry"]}
        r = run(spec)
        res = r["result"]
        self.assertEqual(res["status"], "blocked")
        self.assertEqual(res["next_args"]["from"], "4")
        self.assertFalse(has(r["labels"], "implementer"))

    def test_閉じていない流れでは初稿を始めない(self):
        r = run({"args": args(), "broken_flow": True})
        self.assertEqual(r["result"]["status"], "blocked")
        self.assertIn("flow-framer:rework", r["labels"])
        self.assertFalse(has(r["labels"], "writer"))

    def test_依存のある単位は順番に書く(self):
        units = [
            {"id": "U-2", "docs": ["specifications/x"], "depends_on": ["U-1"]},
            {"id": "U-1", "docs": ["requirements/x"], "depends_on": []},
        ]
        r = run({"args": args(), "units": units})
        writers = [l for l in r["labels"] if l.startswith("writer:")]
        self.assertEqual(writers, ["writer:U-1:draft", "writer:U-2:draft"])

    def test_段1の入口がWをS0の直後に戻したstdoutを返さなければintakeを起動しない(self):
        entry = "flow-check:1-entry"
        for name, kw in (("応答しない", {"null_labels": [entry, f"{entry}#retry"]}), ("stdout が無い", {"no_reset_at": [entry]}),
                         ("固定の文書が違う", {"reset_fixed": ["requirements/other"]}), ("残した文書が違う", {"reset_kept": ["requirements/other"]})):
            with self.subTest(name):
                r = run({"args": args(), **kw})
                self.assertFalse(has(r["labels"], "intake"), r["labels"])
                res = r["result"]
                self.assertEqual((res["status"], res["next_args"]["from"], res["next_args"]["state"]), ("blocked", "1", {}), res.get("reason"))
                self.assertIn(value("NOT_RUN") if name == "応答しない" else "doc_check reset", res["reason"])

    def test_段1の入口はexisting_docsの文書を残させ固定の文書のmetaをresetに書き直させる(self):
        a = args(entry="expand", existing_docs=[{"key": "requirements/x", "fixed": True}, {"key": "requirements/a", "fixed": True}, {"key": "specifications/x", "fixed": False}])
        r = run({"args": a, "units": [{"id": "U-1", "docs": ["specifications/x"], "depends_on": []}]})
        self.assertIn("doc_check.mjs reset --workspace /tmp/prd-w --keep requirements/a,requirements/x,specifications/x --fixed requirements/a,requirements/x`", nth_prompt(r, "flow-check:1-entry", 0))
        self.assertEqual(r["labels"][:2], ["flow-check:1-entry", "intake"])
        self.assertEqual(r["result"]["status"], "done", r["result"].get("reason"))

    def test_intakeのplan_checkに指摘があれば1回だけ差し戻す(self):
        fixed = run({"args": args(), "plan_findings": {"intake": 2}})
        self.assertEqual(fixed["labels"][:4], ["flow-check:1-entry", "intake", "intake:rework", "flow-framer"])
        rework = next(p["prompt"] for p in fixed["prompts"] if p["label"] == "intake:rework")
        self.assertIn("doc_check plan の指摘が 2 件", rework)
        self.assertIn("doc_check.mjs plan --workspace", rework)
        self.assertEqual(fixed["result"]["status"], "done")
        for spec in ({"intake": 1, "intake:rework": 1}, {"intake": None, "intake:rework": None}):
            with self.subTest(plan_findings=spec):
                broken = run({"args": args(), "plan_findings": spec})
                self.assertEqual(broken["labels"], ["flow-check:1-entry", "intake", "intake:rework"])
                self.assertEqual((broken["result"]["status"], broken["result"]["next_args"]["from"]), ("blocked", "1"))

    def test_intakeの検査の後にplan_jsonが変わればblockedで段1から(self):
        ok = run({"args": args()})
        self.assertIn("doc_check.mjs plan ", next(p["prompt"] for p in ok["prompts"] if p["label"] == "flow-framer"))
        changed = run({"args": args(), "plan_seen": {"sha": "plan-edited"}})["result"]
        self.assertEqual((changed["status"], changed["next_args"]["from"], changed["next_args"]["state"]), ("blocked", "1", {}), "段 1 からの再実行は S0 の直後の W から始まるので state を運ばない")
        self.assertTrue(any("plan.json" in line for line in changed["integrity"]))
        found = run({"args": args(), "plan_seen": {"findings": 1}})["result"]
        self.assertEqual((found["status"], found["next_args"]["from"]), ("blocked", "1"))
        missing = run({"args": args(), "plan_seen": None})["result"]
        self.assertEqual((missing["status"], missing["next_args"]["from"]), ("blocked", "2"))

    def test_role_optsの未知の役割は止める(self):
        r = run({"args": args(role_opts={"checker": {"model": "opus"}})})
        self.assertIn("role_opts", r["error"])


TMP_DIR = re.compile(r"^作業用ディレクトリ: (\S+)$", re.M)


def tmp_dir(prompt):
    return TMP_DIR.search(prompt).group(1)


@unittest.skipIf(shutil.which("node") is None, "node が無い環境ではスキップする")
class CommonContract(unittest.TestCase):
    def test_全役のプロンプトに共通の2節が出る(self):
        r = run({"args": args(), "flow_open": 1, "ruled_at": {"3": ["RS-001"]}})
        self.assertIsNone(r["error"], r["error"])
        roles = {p["label"].split(":")[0] for p in r["prompts"]}
        self.assertEqual(roles, {"flow-check", "intake", "flow-framer", "resolver", "verifier", "writer", "implementer", "grounding", "crossDoc"})
        for p in r["prompts"]:
            self.assertIn("「## 共通の約束」・「## W のファイルと書き手」", p["prompt"], p["label"])

    def test_並列に動く呼び出しは別の作業用ディレクトリを指す(self):
        units = [
            {"id": "U-1", "docs": ["requirements/x"], "depends_on": []},
            {"id": "U-2", "docs": ["requirements/y"], "depends_on": []},
        ]
        r = run({"args": args(), "units": units})
        by_label = {p["label"]: tmp_dir(p["prompt"]) for p in r["prompts"]}
        parallel = ["writer:U-1:draft", "writer:U-2:draft", "implementer:r1:requirements/x", "grounding:r1:requirements/x",
                    "implementer:r1:requirements/y", "grounding:r1:requirements/y", "crossDoc:r1:all"]
        dirs = [by_label[l] for l in parallel]
        self.assertEqual(len(set(dirs)), len(dirs), dirs)
        self.assertEqual(by_label["grounding:r1:requirements/x"], "/tmp/prd-w/tmp/grounding__r1__requirements__x/")

    def test_返り値の無いagentは出し直さず段を止めnext_argsで続けられる(self):
        # null は利用者の停止か runtime の出し直しの後の API エラーで、script が出し直すと利用者の停止を覆す。未実施は指摘 0 件にしない。
        cases = (("intake", "1", {}), ("writer:U-1:draft", "4", {}), ("grounding:r1:requirements/x", "5", {}),
                 ("resolver:3", "3", {"flow_open": 1, "ruled_at": {"3": ["RS-001"]}}), ("verifier:3v", "3", {}),
                 ("writer:U-1:revise", "7", {"findings": {"implementer:r1": [{"id": "r1-im-requirements__x-001"}]}}))
        for label, stage, extra in cases:
            with self.subTest(label):
                world = {"world": str(Path(self.tmp.name) / f"w-{stage}-{label.replace(':', '_').replace('/', '_')}.json")}
                r = run({"args": args(), **extra, **world, "null_labels": [label]})
                res = r["result"]
                self.assertEqual((res["status"], res["next_args"]["from"], res["stop_reason"]), ("blocked", stage, None), res.get("reason"))
                self.assertIn(value("NOT_RUN"), res["reason"])
                self.assertIn(label, res["reason"])
                self.assertEqual(r["labels"].count(label), 1, "出し直さない")
                self.assertFalse(any(l.endswith("#retry") for l in r["labels"]))
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

    def test_段8のstrayはnoticesに入りintegrityに入らない(self):
        spec = {"args": args(), "findings": {"implementer:r1": [{"id": "r1-im-requirements__x-001", "blocking": False}]}, "stray_at": {"r2": 1}}
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
        spec = {"args": args(), "findings": {"implementer:r1": [{"id": "r1-im-requirements__x-001", "blocking": False}]}}
        r = run(spec)
        by_label = {p["label"]: p["prompt"] for p in r["prompts"]}
        self.assertIn("--live implementer__r1__requirements__x,grounding__r1__requirements__x,crossDoc__r1__all", by_label["crossDoc:r1:all"])
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
        self.assertEqual(r["result"]["reason"], "resolver:3: resolver が resolutions_sha256 を返しませんでした")
        self.assertNotIn("resolver:3#retry", r["labels"], "済んだ put を二重に走らせない")
        self.assertFalse(has(r["labels"], "verifier:3v"), "照合できない版で検証に進まない")
        self.assertEqual(r["result"]["next_args"]["from"], "3")


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
                               ("flow-framer だけが消せる符号", {"flow_codes_at": {"3": destructive, "3v": destructive}}, "F-053: 縛る不変条件が無い")):
            with self.subTest(name):
                r = run({"args": args(), "flow_open": 1, "ruled_at": {"3": ["RS-001"]}, **kw})
                labels = r["labels"]
                self.assertEqual(labels[labels.index("verifier:3v") + 1:][:2], ["flow-framer:3-settle", "verifier:3v-settle"])
                self.assertIn(line, next(p["prompt"] for p in r["prompts"] if p["label"] == "flow-framer:3-settle"))
                res = r["result"]
                self.assertEqual((res["status"], res["integrity"]), ("done", []), res.get("reason"))
        left = run({"args": args(), "flow_open": 1, "ruled_at": {"3": ["RS-001"]}, "flow_codes_at": {"3v": destructive, "3v-settle": destructive}})["result"]
        self.assertEqual((left["status"], left["next_args"]["from"]), ("blocked", "3"), "settle の verifier に残れば flow-framer の指摘として段の頭から")

    def _settle_world(self, g, kind, **kw):
        # settle の flow-framer の後に resolver が O-009 を裁定して台帳を書き、flow-framer の stdout に無かった F-053 の指摘が
        # settle の verifier の stdout にだけ出る（stub の世界。台帳の書き込みで指摘が出る経路は doc_check の invariantsOf が決める）。
        D = {"FLOW_DESTRUCTIVE_UNCONSTRAINED": ["F-053"]}
        ruled = {"3a": g["next_args"]["state"]["questions"], "3a-settle-opens": ["RS-009"]}
        return {"args": g["next_args"], "ruled_at": ruled, "flow_sha_at": {"3a": "f-3a"}, "flow_codes_at": {"3a": D, "3av": D, "3av-settle": D, "3a-settle-convert": {}},
                "unverified_at": {"3a-settle": ["F-053"]}, "open_ids_at": {"3a-settle": ["O-009"]}, "about": {"RS-009": {"open": "O-009"}},
                "verifier_fail": {"3av-settle": [{"id": "RS-009", "kind": kind, "reason": "invariant でない"}]}, **kw}

    def test_settleの中で台帳の書き込みから出た指摘は裁定を変換してから次の回に渡す(self):
        # settle の verifier で止めると、その裁定を落とした合否が変換に届かず、同じ段からやり直しても同じ所で止まる。
        g0 = run({"args": args(), "flow_open": 1, "questions_at": {"3": ["RS-001"]}})["result"]
        g02 = run({"args": g0["next_args"], "ruled_at": {"3a": ["RS-001"]}, "questions_at": {"3a": ["RS-002"]}})["result"]
        for name, g, kind, returned, kept in (("聞ける段の value_as_method は問い", g0, "value_as_method", "questions_at", "questions"),
                                              ("聞ける段のそれ以外は保持規則", g0, "insufficient_grounds", "holds_at", "holds"),
                                              ("聞けない段は保持規則", g02, "value_as_method", "holds_at", "holds")):
            with self.subTest(name):
                r = run(self._settle_world(g, kind, **{returned: {"3a-settle-convert": ["RS-009"]}}))
                labels = r["labels"]
                self.assertEqual(labels[labels.index("verifier:3av-settle") + 1:][:2], ["resolver:3a-settle-convert", "flow-check:3a-settle-convert"])
                convert = next(p["prompt"] for p in r["prompts"] if p["label"] == "resolver:3a-settle-convert")
                self.assertIn(f"RS-009 → {kept[:-1] if kept == 'holds' else 'question'}", convert)
                self.assertNotIn("flow-framer:3a-settle-2", labels, "保持か問いで O-009 が縛りに戻れば 1 回目で指摘は消える")
                res = r["result"]
                self.assertNotEqual(res["status"], "blocked", res.get("reason"))
                self.assertEqual(res["integrity"], [])
                self.assertIn("RS-009", res[kept] if kept == "holds" else res["next_args"]["state"]["questions"])
        asked = run(self._settle_world(g02, "value_as_method", questions_at={"3a-settle-convert": ["RS-009"]}))["result"]
        self.assertEqual((asked["status"], asked["next_args"]["from"]), ("blocked", "3a"), "聞けない段の変換は問いを返せない")

    def test_settleの中で台帳が変わらなければverifierの指摘はflow_framerのものとして止める(self):
        # 台帳が同じなら、同じ flow.json で flow-framer の stdout に無かった指摘は flow-framer の過少申告である。
        g0 = run({"args": args(), "flow_open": 1, "questions_at": {"3": ["RS-001"]}})["result"]
        spec = self._settle_world(g0, "insufficient_grounds", open_ids_at={}, verifier_fail={})
        r = run(spec)
        self.assertNotIn("resolver:3a-settle-opens", r["labels"])
        res = r["result"]
        self.assertEqual((res["status"], res["next_args"]["from"]), ("blocked", "3a"), res.get("reason"))
        self.assertIn("段 3av-settle: verifier の doc_check flow に指摘が 1 件あります", res["reason"])
        self.assertEqual(len(res["integrity"]), 1, res["integrity"])

    def test_settleの回ごとに台帳から出る指摘が残れば上限の回で止める(self):
        n = const("MAX_SETTLE_ROUNDS")
        g0 = run({"args": args(), "flow_open": 1, "questions_at": {"3": ["RS-001"]}})["result"]
        at = lambda i: {"FLOW_DESTRUCTIVE_UNCONSTRAINED": [f"F-{50 + k}" for k in range(n - i)]}
        tags = ["3a-settle"] + [f"3a-settle-{i + 1}" for i in range(1, n)]
        opens = [f"O-{10 + i}" for i in range(n)]
        spec = {"args": g0["next_args"], "ruled_at": {"3a": ["RS-001"], **{f"{t}-opens": [f"RS-{10 + i}"] for i, t in enumerate(tags)}},
                "about": {f"RS-{10 + i}": {"open": o} for i, o in enumerate(opens)},
                "open_ids_at": {t: opens[: i + 1] for i, t in enumerate(tags)},
                "flow_codes_at": {"3av": at(0), **{t.replace("3a-settle", "3av-settle"): at(i) for i, t in enumerate(tags)}}}
        r = run(spec)
        self.assertEqual([l for l in r["labels"] if l.startswith("flow-framer:3a-settle")], [f"flow-framer:{t}" for t in tags])
        res = r["result"]
        self.assertEqual((res["status"], res["next_args"]["from"]), ("blocked", "3a"), res.get("reason"))
        self.assertIn("裁定の反映の後も直っていません", res["reason"])
        self.assertEqual(res["integrity"], [])

    def test_3aでは候補の選択だけでもverifierが起動する(self):
        g0 = run({"args": args(), "flow_open": 1, "questions_at": {"3": ["RS-001"]}})["result"]
        r = run({"args": g0["next_args"], "ruled_at": {"3a": ["RS-001"]}})
        self.assertEqual([l for l in r["labels"] if l.startswith(("resolver:", "verifier:"))], ["resolver:3a", "verifier:3av", "verifier:3bv"])
        self.assertEqual(r["result"]["status"], "done")

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
    def test_形の検査に落ちた問いは1回差し戻し直ればneeds_answers(self):
        r = run({"args": args(), "flow_open": 1, "questions_at": {"3": ["RS-001"]}, "bad_questions_at": ["3"]})
        self.assertIn("resolver:3-questions", r["labels"])
        [again] = [p["prompt"] for p in r["prompts"] if p["label"] == "resolver:3-questions"]
        self.assertIn("questions --workspace /tmp/prd-w --ids RS-001 --check", again)
        self.assertEqual(r["result"]["status"], "needs_answers")
        self.assertEqual(r["result"]["question_ids"], ["RS-001"])

    def test_差し戻しでも直らなければblocked(self):
        r = run({"args": args(), "flow_open": 1, "questions_at": {"3": ["RS-001"]}, "bad_questions_at": ["3", "3-questions"]})
        self.assertEqual(r["result"]["status"], "blocked")
        self.assertEqual(r["result"]["next_args"]["from"], "3")
        self.assertEqual(sum(1 for l in r["labels"] if l.startswith("resolver:3-questions")), 1)

    def test_別の問いを検査したstdoutは合格にしない(self):
        r = run({"args": args(), "flow_open": 1, "questions_at": {"3": ["RS-001", "RS-002"]}, "questions_check_ids_at": {"3": ["RS-001"]}})
        [again] = [p["prompt"] for p in r["prompts"] if p["label"] == "resolver:3-questions"]
        self.assertIn("RS-002", again)
        self.assertEqual(r["result"]["status"], "needs_answers")

    def test_問いが無ければ検査を求めない(self):
        r = run({"args": args(), "flow_open": 1, "ruled_at": {"3": ["RS-001"]}})
        self.assertNotIn("resolver:3-questions", r["labels"])


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
        stopped = run({**spec, "args": g0["next_args"], "null_labels": ["verifier:3av", "verifier:3av#retry"]})
        self.assertNotIn("answered", stopped["result"]["next_args"]["state"])
        resumed = self._resume(stopped, spec)
        self.assertEqual(resumed["status"], "needs_answers")
        self.assertEqual(resumed["next_args"], whole["next_args"])

    def test_問いの形の修正で候補を書き換えた問いは合格を持ち越さず検証し直してから根拠にする(self):
        # 3v で合格した RS-002 の候補の文を settle の形の修正が書き換える。合格を持ち越すと、検証していない decision_text が
        # G0 の候補の選択でそのまま value になり、writer の根拠に届く。
        spec = {"args": args(), "flow_open": 1, "ruled_at": {"3": ["RS-001"]}, "questions_at": {"3": ["RS-002"]},
                "open_only_at": {"3v": [{"el": "F-091", "open": "O-RS-001"}]}, "bad_questions_at": ["3-settle"], **self._world()}
        g0 = run(spec)
        self.assertEqual(g0["result"]["status"], "needs_answers", g0["result"].get("reason"))
        fixed = g0["labels"].index("resolver:3-settle-questions")
        asked = lambda x: x["prompt"].split("検証する resolution の ID:")[1].split("\n")[0]
        again = [x["label"] for x in g0["prompts"][fixed + 1:] if x["label"].startswith("verifier:") and "RS-002" in asked(x)]
        self.assertTrue(again, "形の修正で書き換えた問いを、G0 の前に検証し直す")
        d = json.loads(Path(self.world).read_text())
        self.assertEqual(d["verdicts"]["RS-002"]["v"], d["rs"]["RS-002"]["v"], "合否は書き換えた後の版に付いている")
        r = run({"ruled_at": {"3a": ["RS-002"]}, "args": g0["result"]["next_args"], **self._world()})
        self.assertEqual(r["result"]["status"], "done", r["result"].get("reason"))

    def test_blockedの同じ段の再実行だけが入口でその段のtokenの書き込みを取り消す(self):
        base = {**self._settle_world("6"), "verifier_fail": {"6v-settle": self.FAIL_060}}
        label = "resolver:6-settle-convert"
        stopped = run({**base, "args": args(), "silent_after_write": [label, f"{label}#retry"], **self._world()})
        tx = stopped["result"]["next_args"]["state"]["tx"]
        token = f"t{tx['seq']}"
        self.assertEqual((tx["stage"], tx["restore"], tx["try"]), ("6", token, 1))
        written = [p for p in stopped["prompts"] if p["label"].split(":")[0] in ("resolver", "verifier", "flow-framer", "writer") and p["label"] != "writer:U-1:draft"]
        stage6 = [p for p in written if (p["label"].split(":") + [""])[1].startswith("6")]
        self.assertTrue(stage6)
        self.assertEqual({p["label"] for p in stage6 if f"トークン: {token}\n" not in p["prompt"] + "\n"}, set(), "段 6 の台帳を書く役は同じ token で書く")
        self.assertEqual(list(json.loads(Path(self.world).read_text())["tx"]), [token], "新しい token の最初の書き込みが前の段の控えを消す")
        again = run({**base, "args": stopped["result"]["next_args"], **self._world()})
        entry = nth_prompt(again, "flow-check:6-entry", 0)
        self.assertIn(f"doc_check.mjs restore --workspace /tmp/prd-w --token {token}`", entry)
        self.assertLess(entry.index("restore"), entry.index("doc_check.mjs flow"), "flow を読む前に戻す")
        self.assertEqual(again["result"]["status"], "done", again["result"].get("reason"))
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
        base = {**self._settle_world("6"), "verifier_fail": {"6v-settle": self.FAIL_060}}
        label = "resolver:6-settle-convert"
        for name, stop in (("flow を書いた後", {"silent_after_write": [label, f"{label}#retry"]}), ("flow を書く前", {"null_labels": ["verifier:6v", "verifier:6v#retry"]})):
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
        fs = {"crossDoc:r1": [{"id": "r1-cd-all-001", "route": "decision"}, {"id": "r1-cd-all-002", "route": "decision", "doc": "requirements/y", "item_id": "PR-Y-001"}]}
        full = {"units": units, "findings": fs, "about": {"RS-010": {"finding": "r1-cd-all-001"}, "RS-011": {"finding": "r1-cd-all-002"}},
                "ruled_at": {"6": ["RS-010", "RS-011"]}, "routes_at": {"6": [{"id": "RT-010", "unit": "U-1"}, {"id": "RT-011", "unit": "U-2"}]}}
        whole = run({**full, "args": args(), **self._world()})
        Path(self.world).unlink(missing_ok=True)
        partial = {"ruled_at": {"6": ["RS-010"]}, "routes_at": {"6": [{"id": "RT-010", "unit": "U-1"}]}, "silent_after_write": ["resolver:6", "resolver:6#retry"]}
        stopped = run({**full, **partial, "args": args(), **self._world()})
        again = run({**full, "args": stopped["result"]["next_args"], **self._world()})
        self.assertIn("r1-cd-all-001, r1-cd-all-002", nth_prompt(again, "resolver:6", 0), "止まった run が裁定した論点も resolver に渡し直す")
        revised = lambda r: [l for l in r["labels"] if l.startswith("writer:") and l.endswith(":revise")]
        self.assertEqual(revised(again), revised(whole))
        self.assertEqual(revised(whole), ["writer:U-1:revise", "writer:U-2:revise"])

    def test_再実行がまた止まれば再実行の書いたtokenを戻す(self):
        base = {**self._settle_world("6"), "verifier_fail": {"6v-settle": self.FAIL_060}}
        label = "resolver:6-settle-convert"
        stop = {"silent_after_write": [label, f"{label}#retry"]}
        stopped = run({**base, "args": args(), **stop, **self._world()})["result"]
        seq = stopped["next_args"]["state"]["tx"]["seq"]
        again = run({**base, "args": stopped["next_args"], **stop, **self._world()})["result"]
        self.assertEqual((again["status"], again["next_args"]["from"]), ("blocked", "6"), again.get("reason"))
        self.assertEqual({k: again["next_args"]["state"]["tx"][k] for k in ("seq", "try", "restore")}, {"seq": seq, "try": 2, "restore": f"t{seq}r1"})
        third = run({**base, "args": again["next_args"], **self._world()})
        self.assertIn(f"--token t{seq}r1`", nth_prompt(third, "flow-check:6-entry", 0))
        self.assertEqual(third["result"]["status"], "done", third["result"].get("reason"))

    def test_入口のflow_checkがrestoreのstdoutを返さなければ同じ段からやり直させる(self):
        base = {**self._settle_world("6"), "verifier_fail": {"6v-settle": self.FAIL_060}}
        label = "resolver:6-settle-convert"
        stopped = run({**base, "args": args(), "null_labels": [label, f"{label}#retry"], **self._world()})
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
        stopped = run({**spec, "bad_questions_at": ["3", "3-questions"]})
        self.assertNotIn("RS-001", stopped["result"]["next_args"]["state"].get("questions", []))
        self.assertEqual(self._resume(stopped, spec)["next_args"], whole["next_args"])

    def test_段6のverifierで止まっても同じ状態から再開する(self):
        self.maxDiff = None
        spec = {
            "args": args(), **self._world(),
            "findings": {"crossDoc:r1": [{"id": "r1-cd-all-001", "route": "decision"}]},
            "ruled_at": {"6": ["RS-011"]}, "questions_at": {"6": ["RS-010"]},
        }
        whole = run(spec)["result"]
        Path(self.world).unlink()
        stopped = run({**spec, "null_labels": ["verifier:6v", "verifier:6v#retry"]})
        self.assertEqual(stopped["result"]["next_args"]["from"], "6")
        self.assertEqual(self._resume(stopped, {k: v for k, v in spec.items() if k != "args"})["next_args"], whole["next_args"])

    def test_settleのflow_framerが書いた後に止まっても段の頭のflowから再開する(self):
        # settle の flow-framer が書き換えた flow.json は、再実行の入口の restore が段に入った時点の版に戻す。next_args の flow_digest は
        # 段に入った時点の版なので、入口の照合は所有表の中の書き込みを外の書き込みとして数えない。
        D = {"FLOW_DESTRUCTIVE_UNCONSTRAINED": ["F-053"]}
        stale = [{"el": "F-053", "ref": "D-003"}]
        common = {"about": {"RS-060": {"open": "O-060"}, "RS-010": {"finding": "r1-cd-all-001"}}}
        # 段ごとの世界。止まった run が settle で足した O-060 も restore で消え、再実行は止まらなかった run と同じく settle で足して裁定する。
        worlds = (("3", {"flow_open": 1, "ruled_at": {"3": ["RS-001"], "3-settle-opens": ["RS-060"]}, "flow_codes_at": {"3": D, "3v": D}}),
                  ("3", {"ruled_at": {"3-settle-opens": ["RS-060"]}, "flow_codes_at": {"3v": D}}),
                  ("6", {"findings": {"crossDoc:r1": [{"id": "r1-cd-all-001", "route": "decision"}]}, "ruled_at": {"6": ["RS-010"], "6-settle-opens": ["RS-060"]},
                         "flow_codes_at": {"6": D, "6v": D}}))
        silent = lambda label: {"null_labels": [label, f"{label}#retry"]}
        for stage, world in worlds:
            spec = {**common, **world, "open_ids_at": {f"{stage}-settle": ["O-060"]}, "unverified_at": {f"{stage}-settle": ["F-053"]}, **self._world()}
            for name, stop in (("verifier が応答しない", silent(f"verifier:{stage}v-settle")), ("resolver が応答しない", silent(f"resolver:{stage}-settle-opens")),
                               ("flow-framer の指摘が残る", {"open_ids_at": {}, "flow_codes_at": {**world["flow_codes_at"], f"{stage}v-settle": D}}),
                               ("flow-framer の flow が閉じない", {"flow_findings_at": {f"{stage}-settle": 1, f"{stage}-settle-rework": 1}}),
                               ("settle が収束しない", {"stale_refs_at": {f"{stage}v-settle": stale, f"{stage}v-settle-2": stale}}),
                               ("申告した O- が verifier と違う", {"open_ids_at": {f"{stage}-settle": ["O-060"], f"{stage}v-settle": ["O-060", "O-061"]}})):
                with self.subTest(stage=stage, world=sorted(world), stop=name):
                    Path(self.world).unlink(missing_ok=True)
                    stopped = run({**spec, "args": args(), **stop})
                    self.assertEqual(stopped["result"]["next_args"]["from"], stage, stopped["result"].get("reason"))
                    self.assertIn(f"flow-framer:{stage}-settle", stopped["labels"])
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
        silent = lambda label: {"null_labels": [label, f"{label}#retry"]}
        g1 = {"findings": {"crossDoc:r1": [{"id": "r1-cd-all-001", "route": "decision"}]}}
        opens = {**g1, "about": {"RS-060": {"open": "O-060"}, "RS-010": {"finding": "r1-cd-all-001"}}, "ruled_at": {"6": ["RS-010"]},
                 "flow_codes_at": {"6": D, "6v": D}, "open_ids_at": {"6-settle": ["O-060"]}, "unverified_at": {"6-settle": ["F-053"]}}
        only = lambda st: {"about": {"RS-010": {"open": "O-010"}}, "open_only_at": {f"{st}v": [{"el": "F-004", "open": "O-010"}]},
                           "unverified_at": {f"{st}-settle": ["F-004"], f"{st}-settle-rework": ["F-004"]}}
        no_cc = lambda st: {"no_conflicts_check_at": [f"{st}-settle", f"{st}-settle-rework"]}
        stale = [{"el": "F-002", "ref": "D-001"}]
        hold = {"findings": {"implementer:r1": [{"id": "r1-im-requirements__x-001"}], "grounding:r2": [{"id": "r2-gr-requirements__x-001", "route": "decision"}]},
                "questions_at": {"6": ["RS-020"]}, "supersedes_at": {"6-hold": ["D-001"]}, "stale_refs_at": {"6-hold": stale, "6-holdv-left": stale}, "unverified_at": {"6-hold-settle": ["F-002"]}}
        cases = (
            ("段 6 の settle の verifier が応答しない（RS-060 は合格する裁定）", "6", {**opens, "ruled_at": {"6": ["RS-010"], "6-settle-opens": ["RS-060"]}},
             silent("verifier:6v-settle")),
            ("段 6 の settle の verifier が応答しない（RS-060 は hold）", "6", {**opens, "holds_at": {"6-settle-opens": ["RS-060"]}}, silent("verifier:6v-settle")),
            ("段 6 の flow-framer が conflicts を返さない", "6", {**g1, **only("6"), "ruled_at": {"6": ["RS-010"]}}, no_cc("6")),
            ("段 6 の flow-framer が書いてから応答しない", "6", {**opens, "ruled_at": {"6": ["RS-010"], "6-settle-opens": ["RS-060"]}},
             {"silent_after_write": ["flow-framer:6-settle", "flow-framer:6-settle#retry"]}),
            ("2 パス目の段 6 の保持規則への変換の後の verifier が応答しない", "6", hold, silent("verifier:6-holdv-settle")),
        )
        for name, stage, base, stop in cases:
            with self.subTest(name):
                self._check_rerun(stage, base, stop, usable=["RS-060"] if "RS-060 は合格" in name else ())
        # G1 の後の 3a' の settle で止まる（前回の probe2）。G1 までの run は同じ W で先に走らせる。
        name = "3a' の flow-framer が conflicts を返さない"
        with self.subTest(name):
            before = {**g1, "questions_at": {"6": ["RS-010"]}, "about": only("3a'")["about"]}
            base = {**only("3a'"), "ruled_at": {"3a'": ["RS-010"]}}
            self._check_rerun("3a'", base, no_cc("3a'"), before=before)

    def _check_rerun(self, stage, base, stop, before=None, usable=()):
        def start():
            Path(self.world).unlink(missing_ok=True)
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
        spec = {"findings": {"implementer:r1": [{"id": "r1-im-requirements__x-001"}], "grounding:r2": [{"id": "r2-gr-requirements__x-001", "route": "decision"}]},
                "questions_at": {"6": ["RS-020"]}, "orphans_at": {"6-hold": ["RS-077"]}, "about": {"RS-077": {"open": "O-077"}}, **self._world()}
        r = run({**spec, "args": args()})
        res = r["result"]
        self.assertEqual(res["status"], "done", res.get("reason"))
        self.assertIn("verifier:6-holdv-left", r["labels"])
        self.assertIn("RS-077", res["holds"] + res["hold_drafts"])
        self.assertEqual(self._left_on_disk(), {"unverified": [], "no_verdict": []})
        # 段の本体の resolver が返さなかった裁定も、段をやり直させずに同じ run の settle の前に検証する。
        Path(self.world).unlink()
        main = run({"args": args(), "findings": {"crossDoc:r1": [{"id": "r1-cd-all-001", "route": "decision"}]}, "ruled_at": {"6": ["RS-010"]},
                    "orphans_at": {"6": ["RS-077"]}, "about": {"RS-077": {"open": "O-077"}}, **self._world()})
        self.assertEqual(main["result"]["status"], "done", main["result"].get("reason"))
        self.assertIn("verifier:6v-left", main["labels"])
        self.assertIn("RS-077", main["result"]["holds"])
        self.assertEqual(self._left_on_disk(), {"unverified": [], "no_verdict": []})

    def test_直す役のいない段の入口で検証に落ちた要素があれば書く前に止める(self):
        stopped = run({"args": args(), "findings": {"implementer:r1": [{"id": "r1-im-requirements__x-001"}]}, "null_labels": ["writer:U-1:revise", "writer:U-1:revise#retry"], **self._world()})
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
        g1 = {"findings": {"crossDoc:r1": [{"id": "r1-cd-all-001", "route": "decision"}]}}
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
        spec = {"findings": {"crossDoc:r1": [{"id": "r1-cd-all-001", "route": "decision"}]}, "ruled_at": {"6": ["RS-010"]}, **self._world()}
        stopped = run({**spec, "args": args(), "null_labels": ["verifier:6v", "verifier:6v#retry"]})
        resumed = run({**spec, "args": stopped["result"]["next_args"], "tamper_before": {"flow-check:6-entry": "f-x"}})["result"]
        self.assertEqual(resumed["status"], "done", resumed.get("reason"))
        self.assertEqual(len(resumed["integrity"]), 1)
        self.assertIn("段 6 の入口の flow.json（f-x）", resumed["integrity"][0])

    def test_入口で採ったWの版と行は同じ段の再実行のnext_argsに載る(self):
        # 入口で採った版を next_args が運ばないと、再実行の入口が同じ食い違いを数え直し、W の版と違う版を照合の基準にする。
        spec = {"findings": {"crossDoc:r1": [{"id": "r1-cd-all-001", "route": "decision"}]}, "ruled_at": {"6": ["RS-010"]}, **self._world()}
        stopped = run({**spec, "args": args(), "null_labels": ["verifier:6v"]})["result"]
        again = run({**spec, "args": stopped["next_args"], "tamper_before": {"flow-check:6-entry": "f-x"}, "null_labels": ["verifier:6v"]})["result"]
        self.assertEqual((again["status"], again["next_args"]["from"]), ("blocked", "6"), again.get("reason"))
        st = again["next_args"]["state"]
        self.assertEqual(st["flow_digest"], "f-x")
        self.assertEqual([l for l in st["integrity"] if "段 6 の入口の flow.json（f-x）" in l], again["integrity"])
        resumed = run({**spec, "args": again["next_args"]})["result"]
        self.assertEqual(resumed["status"], "done", resumed.get("reason"))
        self.assertEqual(len(resumed["integrity"]), 1, resumed["integrity"])

    def test_段3で生成者のいないflowの食い違いはnext_argsを付けず行を重ねない(self):
        r = run({"args": args(), **self._world(), "tamper_before": {"verifier:3v": "f-x"}})["result"]
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
    G1 = {"findings": {"crossDoc:r1": [{"id": "r1-cd-all-001", "route": "decision"}]}}
    FAIL_060 = [{"id": "RS-060", "kind": "insufficient_grounds", "reason": "根拠が無い"}]

    def _settle_world(self, stage):
        common = {"flow_codes_at": {stage: self.D, f"{stage}v": self.D}, "open_ids_at": {f"{stage}-settle": ["O-060"]}, "unverified_at": {f"{stage}-settle": ["F-053"], f"{stage}-settle-2": ["F-053"]}}
        if stage == "6":
            return {**self.G1, **common, "about": {"RS-060": {"open": "O-060"}, "RS-010": {"finding": "r1-cd-all-001"}}, "ruled_at": {"6": ["RS-010"], "6-settle-opens": ["RS-060"]}}
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

    def _live_abouts(self, r):
        """writer に渡った resolution（根拠・保持規則）の about の重複。"""
        d = json.loads(Path(self.world).read_text())
        ps = [p["prompt"] for p in r["prompts"] if p["label"].startswith("writer:U-1:")]
        held = next(l for l in ps[-1].split("\n") if l.startswith("- 保持規則として"))
        live = self._usable(r) + [x for x in held.split(": ", 1)[1].split(", ") if x != "（なし）"]
        keys = [json.dumps(d["rs"][i]["about"], sort_keys=True) for i in live]
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
            base = {**self._settle_world(stage), "verifier_fail": {f"{stage}v-settle": self.FAIL_060}}
            label = f"resolver:{stage}-settle-convert"
            for name, stop in (("変換が応答しない", {"null_labels": [label, f"{label}#retry"]}), ("変換が書いてから応答しない", {"silent_after_write": [label, f"{label}#retry"]})):
                with self.subTest(stage=stage, stop=name):
                    whole, again = self._compare(base, stop)
                    self.assertEqual(whole["result"]["holds"], ["RS-060"])
        # 問いを返してよい段では、value_as_method の不合格は問いになる。入口の変換も段と同じく問いにする（入口だけ保持規則にしない）。
        for stage in ("6", "3"):
            base = {**self._settle_world(stage), "verifier_fail": {f"{stage}v-settle": [{**self.FAIL_060[0], "kind": "value_as_method"}]}}
            label = f"resolver:{stage}-settle-convert"
            with self.subTest(stage=stage, kind="value_as_method"):
                whole, again = self._compare(base, {"null_labels": [label, f"{label}#retry"]})
                self.assertEqual((whole["result"]["status"], whole["result"]["question_ids"]), ("needs_answers", ["RS-060"]))

    def test_settleで合格した裁定の反映の前に止まっても再実行がflowに写す(self):
        for stage in ("6", "3"):
            base = {**self._settle_world(stage), "open_only_at": {f"{stage}v-settle": [{"el": "F-053", "constraint": "O-060"}]}}
            with self.subTest(stage=stage):
                whole, again = self._compare(base, {"null_labels": [f"flow-framer:{stage}-settle-2", f"flow-framer:{stage}-settle-2#retry"]})
                wrote = lambda r: [p["label"] for p in r["prompts"] if p["label"].startswith("flow-framer:") and "F-053 の O-060 ← RS-060" in p["prompt"]]
                self.assertTrue(wrote(whole))
                self.assertTrue(wrote(again), "合格した RS-060 を、F-053 の constrained_by の O-060 に差し替えさせる")
                if stage == "6":
                    self.assertIn("RS-060", self._usable(again))

    def test_段6で問いを返してsettleで止まっても再実行はG1で聞く(self):
        base = {**self._settle_world("6"), "ruled_at": {"6-settle-opens": ["RS-060"]}, "questions_at": {"6": ["RS-010"]}}
        whole, again = self._compare(base, {"null_labels": ["verifier:6v-settle", "verifier:6v-settle#retry"]})
        self.assertEqual((whole["result"]["status"], whole["result"]["question_ids"]), ("needs_answers", ["RS-010"]))

    def test_差し戻しが書き直してから止まった裁定は再実行が検証し直す(self):
        # 不合格の後に書き直した裁定は、前の不合格が付いたままだと変換され、止まらなかった run では合格する裁定が保持規則になる。
        fail = [{"id": "RS-010", "kind": "insufficient_grounds", "reason": "根拠が無い"}]
        base = {**self.G1, "about": {"RS-010": {"finding": "r1-cd-all-001"}}, "ruled_at": {"6": ["RS-010"], "6'": ["RS-010"]}, "verifier_fail": {"6v": fail}}
        whole, again = self._compare(base, {"silent_after_write": ["resolver:6'", "resolver:6'#retry"]})
        self.assertEqual(self._usable(whole), ["RS-010"])
        self.assertIn("verifier:6v'", again["labels"], "restore で書き直しの前に戻った RS-010 を、段の本体の差し戻しが書き直して検証し直す")

    def test_入口と拾う側の呼び出しでもlabelは重ならない(self):
        # telemetry と再開の照合は label で呼び出しを引く。入口（<段>-entry・<段>v-entry）と、検証し残しを拾う verifier（<段>v-left・
        # <段>v-left-<n+1>）の label が段の本体の呼び出しと重なると、呼び出しを取り違える。
        base = {**self._settle_world("6"), **self._world()}
        stopped = run({**base, "args": args(), "null_labels": ["verifier:6v", "verifier:6v#retry"]})
        self.assertEqual(stopped["result"]["next_args"]["from"], "6", stopped["result"].get("reason"))
        # 再実行の前に、所有表の外で要素 F-070 が書き換わる（止まった run は flow.json を書いていないので restore は戻さず、入口の verifyLeft が検証する）。
        d = json.loads(Path(self.world).read_text())
        d["els"]["F-070"] = 1
        Path(self.world).write_text(json.dumps(d))
        orphans = {"orphans_at": {"6": ["RS-077"], "6-settle-opens": ["RS-078"]}, "about": {**base["about"], "RS-077": {"open": "O-077"}, "RS-078": {"open": "O-078"}}}
        r = run({**base, "args": stopped["result"]["next_args"], **orphans, "flow_codes_at": {**base["flow_codes_at"], "6v-left": self.D}})
        self.assertEqual(r["result"]["status"], "done", r["result"].get("reason"))
        cycle = [l for l in r["labels"] if l.split(":")[0] in ("resolver", "verifier", "flow-framer", "flow-check")]
        for want in ("flow-check:6-entry", "verifier:6v-entry", "resolver:6", "verifier:6v", "verifier:6v-left", "flow-framer:6-settle",
                     "verifier:6v-settle", "verifier:6v-left-2"):
            self.assertIn(want, cycle)
        self.assertEqual(len(cycle), len(set(cycle)), sorted(l for l in cycle if cycle.count(l) > 1))
        self._ledger_consistent()

    def test_段1と段2からの再実行は止まった段の書き込みを残さずに止まらなかったrunと同じWに着く(self):
        # 止まった flow-framer が open.json に O-099 を足し、flow.json を書いた。put はキー単位で足すので、戻さずに再実行すると O-099 が残る。
        # 段 1 からは入口の reset が、段 2 からは入口の restore が戻す。
        base = {"flow_open": 1, "ruled_at": {"3": ["RS-001"]}}
        left = {"open_ids_at": {"framer": ["O-001", "O-099"]}}
        for frm, stop in (("1", {**left, "plan_seen": {"sha": "plan-edited"}}), ("2", {**left, "flow_findings_at": {"framer": 1, "rework": 1}})):
            with self.subTest(frm=frm):
                whole, again = self._compare(base, stop)
                self.assertEqual(again["labels"][:2], [f"flow-check:{frm}-entry", "intake" if frm == "1" else "flow-framer"])
                self.assertEqual(again["result"], whole["result"])

    def test_再利用したWで新しいrunを始めても前のランの台帳と控えを引き継がない(self):
        # 前のランは G1 まで進んだ（後の段の token の控え・裁定・合否が W に残る）。新しいランの最初の書き込みの token（t1）は、
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
        base = {**self._settle_world("6"), "verifier_fail": {"6v-settle": self.FAIL_060}}
        label = "resolver:6-settle-convert"
        stopped = run({**base, "args": args(), "silent_after_write": [label, f"{label}#retry"], **self._world()})["result"]
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
        spec = {"findings": {"implementer:r1": [{"id": "r1-im-requirements__x-001", "blocking": False}]}, **self._world()}
        auditor = "grounding:r2:requirements/x"
        stop = {"null_labels": [auditor, f"{auditor}#retry"]}
        first = run({**spec, "args": args(), **stop})["result"]
        self.assertEqual((first["status"], first["next_args"]["from"]), ("blocked", "8"), first.get("reason"))
        again = run({**spec, "args": first["next_args"], **stop, "tamper_before": {"flow-check:8-entry": "outside"}})["result"]
        self.assertEqual((again["status"], again["next_args"]["from"]), ("blocked", "8"), again.get("reason"))
        self.assertTrue(any("段 8 の入口の flow.json（outside）" in l for l in again["integrity"]), again["integrity"])
        self.assertNotIn("flow", again["next_args"]["state"]["tx"])

    def test_新しいIDを振るresolverでも再実行は裁定済みの論点を裁定し直さない(self):
        # 実物の resolver は再実行で前の run と別の ID を振る。止まった run の裁定が W に残ると、同じ about に使える裁定が 2 つできる。
        for stage in ("6", "3"):
            base = {**self._settle_world(stage), "verifier_fail": {f"{stage}v-settle": self.FAIL_060}}
            label = f"resolver:{stage}-settle-convert"
            stop = {"null_labels": [label, f"{label}#retry"]}
            with self.subTest(stage=stage):
                whole, again = self._compare(base, stop, again_kw={"fresh_ids": True})
                self.assertEqual(self._live_abouts(again), [])


@unittest.skipIf(shutil.which("node") is None, "node が無い環境ではスキップする")
class FailedHolds(unittest.TestCase):
    """hold のまま検証に落ちた保持規則は writer に渡さない。同じ ID で書き直させて検証し直し、書き直した直後にも落ちれば段の頭から。"""

    FAIL = [{"id": "RS-002", "kind": "insufficient_grounds", "reason": "保持規則が触れる項目が無い"}]

    def _g02(self):
        g0 = run({"args": args(), "flow_open": 1, "questions_at": {"3": ["RS-001"]}})["result"]
        return run({"args": g0["next_args"], "ruled_at": {"3a": ["RS-001"]}, "questions_at": {"3a": ["RS-002"]}})["result"]

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

    def test_差し戻しの後も落ちた保持規則はもう書き直さない(self):
        # 段 3 で hold を返し、検証に落ちて差し戻しでも hold のまま落ちた。差し戻しが書き直しに当たるので、もう 1 回は回さない。
        fail = [{**self.FAIL[0], "id": "RS-001"}]
        r = run({"args": args(), "flow_open": 1, "holds_at": {"3": ["RS-001"], "3'": ["RS-001"]}, "verifier_fail": {"3v": fail, "3v'": fail}})
        res = r["result"]
        self.assertEqual((res["status"], res["next_args"]["from"]), ("blocked", "3"), res.get("reason"))
        self.assertIn("RS-001 が書き直した後も検証に落ちました", res["reason"])
        self.assertFalse(has(r["labels"], "resolver:3'-rehold"))
        self.assertFalse(has(r["labels"], "resolver:3-convert"), "落ちた保持規則を、検証しない変換で保持規則に書き直さない")

    def test_差し戻しで初めて保持規則になって落ちたものは1回書き直させる(self):
        fail = [{**self.FAIL[0], "id": "RS-001"}]
        r = run({"args": args(), "flow_open": 1, "ruled_at": {"3": ["RS-001"]}, "holds_at": {"3'": ["RS-001"]}, "verifier_fail": {"3v": fail, "3v'": fail}})
        self.assertIn("resolver:3'-rehold", r["labels"])
        self.assertFalse(has(r["labels"], "resolver:3-convert"), "書き直して合格した保持規則を、検証しない変換で書き直さない")
        self.assertEqual(r["result"]["status"], "done", r["result"].get("reason"))
        self.assertEqual(r["result"]["holds"], ["RS-001"])

    def test_差し戻しで値の裁定に変えた元の保持規則は保持規則に数えない(self):
        # 段 3 の hold が 3v に落ち、差し戻しが値の裁定（internal）に変えた。W の ruling が hold でなくなった ID を holds に残すと、
        # 3v' に落ちたときに変換されず「書き直した後も落ちた保持規則」で止まり、合格しても保持規則として返る。
        fail = [{**self.FAIL[0], "id": "RS-001"}]
        base = {"args": args(), "flow_open": 1, "holds_at": {"3": ["RS-001"]}, "ruled_at": {"3'": ["RS-001"]}}
        failed = run({**base, "verifier_fail": {"3v": fail, "3v'": fail}})
        self.assertEqual(failed["result"]["status"], "done", failed["result"].get("reason"))
        self.assertIn("resolver:3-convert", failed["labels"])
        self.assertFalse(has(failed["labels"], "resolver:3'-rehold"))
        passed = run({**base, "verifier_fail": {"3v": fail}})["result"]
        self.assertEqual((passed["status"], passed["holds"], passed["hold_drafts"]), ("done", [], []), passed.get("reason"))

    def test_settleのverifierに落ちた保持規則も変換せずに書き直させる(self):
        # 聞けない段の settle の flow-framer が足した O-060 を、resolver が保持規則で閉じ、settle の verifier がそれを落とす。
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
        g0 = run({"args": args(), "flow_open": 1, "questions_at": {"3": ["RS-001"]}})["result"]
        return run({"args": g0["next_args"], "ruled_at": {"3a": ["RS-001"]}, "questions_at": {"3a": ["RS-002"]}})["result"]

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
        spec = {"args": args(), "flow_open": 1, "ruled_at": {"3": ["RS-001"], "3'": ["RS-001"]}, "verifier_fail": {"3v": [fail], "3v'": [fail]},
                "holds_at": {"3-convert": ["RS-001"]}}
        self.assertEqual(run(spec)["result"]["status"], "done")
        r = run({**spec, "flow_sha_at": {"3-convert": "f-bad"}})["result"]
        self.assertEqual((r["status"], r["next_args"]), ("blocked", None))

    def test_問いの形の修正がflowを変えたらblocked(self):
        spec = {"args": args(), "flow_open": 1, "questions_at": {"3": ["RS-001"]}, "bad_questions_at": ["3"], "flow_sha_at": {"3-questions": "f-bad"}}
        r = run(spec)["result"]
        self.assertEqual((r["status"], r["next_args"]), ("blocked", None))

    def test_flowのstdoutを返さなければ同じ段から再実行できる(self):
        r = run({"args": self._g02()["next_args"], "no_flow_check_at": ["3a-hold"]})["result"]
        self.assertEqual((r["status"], r["next_args"]["from"]), ("blocked", "3a"))

    def test_変換の後のflow_checkが違うflowを見たらnext_argsを付けずにblocked(self):
        fail = {"id": "RS-001", "kind": "insufficient_grounds", "reason": "出典が無い"}
        spec = {"args": args(), "flow_open": 1, "ruled_at": {"3": ["RS-001"], "3'": ["RS-001"]}, "verifier_fail": {"3v": [fail], "3v'": [fail]},
                "holds_at": {"3-convert": ["RS-001"]}}
        r = run({**spec, "tamper_before": {"flow-check:3-convert": "f-bad"}})["result"]
        self.assertEqual((r["status"], r["next_args"]), ("blocked", None))
        self.assertTrue(any("flow-check（段 3-convert）" in x for x in r["integrity"]), r["integrity"])
        silent = run({**spec, "null_labels": ["flow-check:3-convert", "flow-check:3-convert#retry"]})["result"]
        self.assertEqual((silent["status"], silent["next_args"]["from"]), ("blocked", "3"), "応答しない flow-check は同じ段からやり直せる")

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
                self.assertEqual(labels[labels.index("resolver:3a-hold") + 1:][:3], ["flow-check:3a-hold", "verifier:3a-holdv-left", "flow-framer:3a-hold-settle"])
                [p] = [x["prompt"] for x in r["prompts"] if x["label"] == "flow-framer:3a-hold-settle"]
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
        silent = self._final(null_labels=["flow-check:final", "flow-check:final#retry"])
        self.assertEqual((silent["status"], silent["next_args"]["from"]), ("blocked", "8"))

    def test_輪を出た後の変換がflowのstdoutを返さなければ段8からやり直す(self):
        r = self._final(no_flow_check_at=["final"])
        self.assertEqual((r["status"], r["next_args"]["from"]), ("blocked", "8"))

    def test_輪を出た後の変換が応答しなくてもflow_checkが台帳の後のflowを数えて理由に載せる(self):
        # 書いてから応答しなかった resolver の台帳の変更は、応答が無くても flow-check が数え直す。応答が無いのは申告の食い違いではない。
        silent = ["resolver:final", "resolver:final#retry"]
        r = run({"args": args(), "findings": new_item_each_round(MAX_AUDIT_PASSES + 1), "null_labels": silent,
                 "flow_codes_at": {"final-seen": {"FLOW_DESTRUCTIVE_UNCONSTRAINED": ["F-053"]}}, "recheck_as": {"final": "final-seen"}})
        self.assertIn("flow-check:final", r["labels"])
        res = r["result"]
        self.assertEqual((res["status"], res["next_args"], res["integrity"]), ("blocked", None, []))
        self.assertIn("flow の指摘: F-053（FLOW_DESTRUCTIVE_UNCONSTRAINED）", res["reason"])
        self.assertIn("resolver:final が応答しなかった", res["reason"], "文案が無いことを 0 件の文案にしない")

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

    def test_flow_checkを通らない経路があれば段を出ずに止める(self):
        fail = [{"id": "RS-001", "kind": "insufficient_grounds", "reason": "r"}]
        spec = {"args": args(), "flow_open": 1, "ruled_at": {"3": ["RS-001"], "3'": ["RS-001"]}, "verifier_fail": {"3v": fail, "3v'": fail},
                "holds_at": {"3-convert": ["RS-001"]}}
        self.assertEqual(run(spec)["result"]["status"], "done")
        r = run(spec, patch=[("  if (!unchecked) return { fc: verified }\n", "  if (true) return { fc: verified }\n")])
        self.assertIsNone(r["error"])
        self.assertNotIn("flow-check:3-convert", r["labels"])
        res = r["result"]
        self.assertEqual((res["status"], res["next_args"]), ("blocked", None))
        self.assertIn("script の不変条件に反しました（段 3）: resolver:3-", res["reason"])
        self.assertIn("の後に doc_check flow を独立に実行し直さないまま", res["reason"])

    def test_回答待ちの問いを持ったまま聞くゲートの無い段へ出れば止める(self):
        spec = {"args": args(), "flow_open": 1, "questions_at": {"3": ["RS-001"]}}
        r = run(spec, patch=[("  if (pendingQuestions(state).length) return needsAnswers('g0', '3a')\n", "")])
        self.assertFalse(has(r["labels"], "writer"))
        res = r["result"]
        self.assertEqual((res["status"], res["next_args"]), ("blocked", None))
        self.assertIn("回答待ちの問い RS-001 を", res["reason"])
        g0 = run(spec)["result"]
        self.assertEqual(g0["status"], "needs_answers", "聞くゲートへは問いを持って出る")
        carried = run({"args": g0["next_args"], "questions_at": {"3a": ["RS-002"]}, "ruled_at": {"3a": ["RS-001"]}})["result"]
        self.assertEqual((carried["status"], carried["question_ids"]), ("needs_answers", ["RS-002"]), "G0 の後の 3a は 3b へ問いを持ち越す")

    def test_検証に落ちたまま問いにも保持規則にもならない裁定を持って段を出れば止める(self):
        # settle の verifier が落とした RS-060 を、settle も verifyLeft も変換しないまま段を出る欠陥を作る。
        fail = [{"id": "RS-060", "kind": "insufficient_grounds", "reason": "r"}]
        D = {"FLOW_DESTRUCTIVE_UNCONSTRAINED": ["F-053"]}
        spec = {"args": args(), "findings": {"crossDoc:r1": [{"id": "r1-cd-all-001", "route": "decision"}]}, "about": {"RS-060": {"open": "O-060"}, "RS-010": {"finding": "r1-cd-all-001"}},
                "ruled_at": {"6": ["RS-010"], "6-settle-opens": ["RS-060"]}, "flow_codes_at": {"6": D, "6v": D}, "open_ids_at": {"6-settle": ["O-060"]},
                "unverified_at": {"6-settle": ["F-053"]}, "verifier_fail": {"6v-settle": fail}}
        self.assertEqual(run(spec)["result"]["status"], "done")
        broken = [("  const toConvert = unconverted(fc).map(", "  const toConvert = [].map("),
                  ("  const ce = toConvert.length ? await convertFailed(tag, tag, toConvert, phaseTitle, allowQuestions) : null\n", "  const ce = null\n")]
        res = run(spec, patch=broken)["result"]
        self.assertEqual((res["status"], res["next_args"]), ("blocked", None), res.get("reason"))
        self.assertIn("問いにも保持規則にもならない不合格の resolution: RS-060", res["reason"])

    def test_不合格の回答済みの問いを持って段を出れば止める(self):
        # G0 で候補の選択で答えた RS-001 を、3b の verifier が検証を求められずに不合格にする（B1）。求めていない合否は数えずに
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
        ruled = {"args": args(), "verifier_fail": {"3v": fail}, "ruled_at": {"3'": ["RS-005"]}, "about": {"RS-005": {"verification": "F-003"}}, "unverified_at": {"3-settle": ["F-003"]}}
        res = run(ruled, patch=[("  const failed = failedOpen(fc, state, true)\n  const first", "  const failed = []\n  const first")])["result"]
        self.assertEqual((res["status"], res["next_args"]), ("blocked", None), res.get("reason"))
        self.assertIn("保持規則にも回答待ちにもならない不合格の要素: F-003", res["reason"])


@unittest.skipIf(shutil.which("node") is None, "node が無い環境ではスキップする")
class FlowRecheck(unittest.TestCase):
    """flow を変えた呼び出しの後に、新しい組を resolver に、検証を通っていない要素を verifier に回す（A2）。
    裁定で閉じた O- だけを出典に持つ要素（前回の F-090・F-091）は、どの段でも flow-framer:<段>-settle に直させる。"""

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
        """段 3 で el が 3v と 3v' に落ち、差し戻しがその検証の裁定（RS-005）を hold にした G0。W は self.world に残る。"""
        fail = [{"id": el, "kind": "insufficient_grounds", "reason": "出典が無い"}]
        g0 = run({"args": args(), "world": self.world, "flow_open": 1, "questions_at": {"3": ["RS-001"]}, "verifier_fail": {"3v": fail, "3v'": fail},
                  "holds_at": {"3'": ["RS-005"]}, "about": {"RS-005": {"verification": el}}})["result"]
        self.assertEqual(g0["status"], "needs_answers", g0.get("reason"))
        self.assertEqual(on_disk(self.world)["failed_current"], [el])
        return g0

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

    def test_未裁定の論点は生成者の申告でなくverifierが数えた組とOで確かめる(self):
        # 組と O- は flow.json・decisions.json・open.json で決まる。同じ flow.json を見た verifier の stdout と違えば、申告から漏れた論点が
        # 裁定されないまま進むので、段の頭からやり直す。
        g0 = self._g0()["next_args"]
        base = {"args": g0, "ruled_at": {"3a": ["RS-001"], "3a-pairs": ["RS-002"]}, "flow_sha_at": {"3a": "f-3a"}, "pair_keys_at": {"3a": ["pair:D-001|F-099"]},
                "about": {"RS-002": {"pair": ["D-001", "F-099"]}}}
        self.assertEqual(run(base)["result"]["integrity"], [])
        for name, kw, key in (("回答を当てた resolver の組", {"verifier_pair_keys_at": {"3av": ["pair:D-001|F-099", "pair:D-002|F-098"]}}, "pair_keys"),
                              ("settle の flow-framer の O-", {"flow_codes_at": {"3av": {"FLOW_DESTRUCTIVE_UNCONSTRAINED": ["F-053"]}},
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
        self.assertIn("flow-framer:3b-reframe の申告", reframe["reason"])

    def test_flowが変わらなければ組を検査し直さない(self):
        r = run({"args": self._g0()["next_args"], "ruled_at": {"3a": ["RS-001"]}, "pair_keys_at": {"3a": ["pair:D-001|F-099"]}})
        self.assertNotIn("resolver:3a-pairs", r["labels"])
        self.assertNotIn("F-099", self._prompt(r, "verifier:3av"))

    def test_同じ呼び出しで裁定中の組は渡し直さない(self):
        # RS-005 はまだ verifier を通っていない（closedKeys に無い）が、about には入っている。
        spec = {"args": self._g0()["next_args"], "ruled_at": {"3a": ["RS-001", "RS-005"]}, "flow_sha_at": {"3a": "f-3a"},
                "about": {"RS-005": {"pair": ["F-099", "D-001"]}}, "pair_keys_at": {"3a": ["pair:D-001|F-099"]}}
        self.assertNotIn("resolver:3a-pairs", run(spec)["labels"])

    def test_組でないaboutの値は組の裁定として数えない(self):
        spec = {"args": self._g0()["next_args"], "ruled_at": {"3a": ["RS-001"]}, "flow_sha_at": {"3a": "f-3a"}, "pair_keys_at": {"3a": ["open:O-RS-001"]}}
        self.assertIn("resolver:3a-pairs", run(spec)["labels"])

    def test_自由記述の回答で閉じたOも同じcycleでsettleする(self):
        spec = {"args": self._g0()["next_args"], "ruled_at": {"3a": ["RS-001"]}, "free_text_at": {"3a": ["RS-001"]},
                "open_only_at": {"3av": [{"el": "F-091", "open": "O-RS-001"}]}}
        r = run(spec)
        self.assertIn("flow-framer:3a-settle", r["labels"])
        self.assertEqual(r["result"]["status"], "done")

    def test_flowを変えたのにconflictsのstdoutが無ければblocked(self):
        r = run({"args": self._g0()["next_args"], "ruled_at": {"3a": ["RS-001"]}, "flow_sha_at": {"3a": "f-3a"}, "no_conflicts_check_at": ["3a"]})
        self.assertNotIn("verifier:3av", r["labels"])
        self.assertEqual((r["result"]["status"], r["result"]["next_args"]["from"]), ("blocked", "3a"))

    def test_同じcycleで閉じたOだけを出典に持つ要素はsettleで直す(self):
        g0 = self._g0()
        only = [{"el": "F-091", "open": "O-RS-001"}, {"el": "F-092", "open": "O-RS-009"}]
        spec = {"args": g0["next_args"], "ruled_at": {"3a": ["RS-001"]}, "open_only_at": {"3av": only}, "unverified_at": {"3a-settle": ["F-091"]}}
        r = run(spec)
        self.assertEqual([l for l in r["labels"] if l.startswith(("resolver:", "verifier:", "flow-framer"))],
                         ["resolver:3a", "verifier:3av", "flow-framer:3a-settle", "verifier:3av-settle", "flow-framer:3b-reframe", "verifier:3bv"])
        framer = self._prompt(r, "flow-framer:3a-settle")
        self.assertIn("F-091（O-RS-001 ← RS-001）", framer)
        self.assertNotIn("F-092", framer, "開いたままの O- の要素は直させない")
        v = self._prompt(r, "verifier:3av-settle")
        judged_by(self, r, "verifier:3av-settle", "F-091")
        self.assertEqual(v.split("検証する resolution の ID:")[1].split("\n")[0].strip(), "（なし）")
        self.assertEqual(r["result"]["status"], "done")
        self.assertEqual(r["result"]["next_args"], None)

        # 2 回目の settle でも同じ件数が残る（減らない）ので止まる。
        fail = [{"id": "F-091", "kind": "mapping", "reason": "r"}]
        for left in ({"open_only_at": {"3av": only, "3av-settle": only[:1], "3av-settle-2": only[:1]}},
                     {"unput_at": {"3av-settle": ["F-091"], "3av-settle-2": ["F-091"]}, "open_only_at": {"3av": only}},
                     {"verifier_fail": {"3av-settle": fail, "3av-settle-2": fail}, "open_only_at": {"3av": only}}):
            with self.subTest(left=left):
                r = run({**spec, **left})
                stopped = r["result"]
                self.assertEqual((stopped["status"], stopped["next_args"]["from"]), ("blocked", "3a"))
                entry = lambda st: {k: v for k, v in st.items() if k != "tx"}
                self.assertEqual(entry(stopped["next_args"]["state"]), entry(g0["next_args"]["state"]), "段の頭の state からやり直す（W は再実行の入口の restore で段の頭に戻す）")
                framed = [l.split(":")[1] for l in r["labels"] if l.startswith("flow-framer:3a-settle")][-1]
                seq = g0["next_args"]["state"]["tx"]["seq"] + 1
                tx = {"seq": seq, "stage": "3a", "try": 1, "restore": f"t{seq}", "flow": f"f-{framed}"}
                self.assertEqual(stopped["next_args"]["state"]["tx"], tx, "同じ段の token で restore させ、最後に照合を通った flow の版を添える")

    def test_caseの出典だけが閉じたOを指すときもsettleでそのマスを直す(self):
        spec = {"args": self._g0()["next_args"], "ruled_at": {"3a": ["RS-001"]}, "open_only_at": {"3av": [{"el": "F-004", "case": 2, "open": "O-RS-001"}]},
                "unverified_at": {"3a-settle": ["F-004"]}}
        r = run(spec)
        self.assertIn("F-004 の case 2（O-RS-001 ← RS-001）", self._prompt(r, "flow-framer:3a-settle"))
        judged_by(self, r, "verifier:3av-settle", "F-004")
        self.assertEqual(r["result"]["status"], "done")
        same = spec["open_only_at"]["3av"]
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
        g0 = self._g0_failed("F-002")
        self.assertNotIn("F-002", g0["next_args"]["state"]["failed_ids"])
        only = [{"el": "F-003", "open": "O-RS-001"}]
        r = run({"args": g0["next_args"], "world": self.world, "about": {"RS-005": {"verification": "F-002"}}, "ruled_at": {"3a": ["RS-001"]}, "flow_sha_at": {"3a": "f-3a"}, "unverified_at": {"3a": rewritten, "3a-settle": rewritten},
                 "open_only_at": {"3av": only}, "fails_when_asked": fail})
        self.assertEqual(r["result"]["status"], "done", r["result"].get("reason"))
        self.assertEqual([l for l in r["labels"] if l.startswith(("resolver:", "verifier:", "flow-framer"))],
                         ["resolver:3a", "verifier:3av", "flow-framer:3a-settle", "verifier:3av-settle", "flow-framer:3b-reframe", "verifier:3bv"], "保持規則の裁定がある不合格の F- は渡さないので、差し戻しも変換も起きない")
        for label in ("verifier:3av", "verifier:3av-settle"):
            self.assertNotIn("F-002", self._prompt(r, label))
        judged_by(self, r, "verifier:3av-settle", "F-003")

    def test_検証に落ちた要素でもsettleで直させたら必ず検証する(self):
        g0 = self._g0_failed("F-003")
        r = run({"args": g0["next_args"], "world": self.world, "ruled_at": {"3a": ["RS-001"]}, "open_only_at": {"3av": [{"el": "F-003", "open": "O-RS-001"}]},
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
        r = run({"args": self._g0()["next_args"], "ruled_at": {"3a": ["RS-001"]}, "flow_sha_at": {"3a": "f-3a", "3a'": "f-3a2"},
                 "unverified_at": {"3a": ["F-003"], "3a'": ["F-003"]}, "fails_when_asked": fail})
        self.assertNotIn("verifier:3av'", r["labels"])
        res = r["result"]
        self.assertEqual((res["status"], res["next_args"]["from"]), ("blocked", "3a"))
        self.assertIn("F-003 の about を {verification} にした resolution", res["reason"])

    def test_検証の裁定が問いになった要素は回答の候補の選択でも検証してsettleで写す(self):
        # B2 の形: F-003 が 3av と 3av' に落ち、その検証の裁定 RS-005 も value_as_method で落ちて問いになる。G0-2 の候補の選択で回答が当たっても、
        # RS-005 は検証に落ちた裁定なので verifier に通し、合格したら settle が F-003 に写して検証する。
        fail = [{"id": "F-003", "kind": "insufficient_grounds", "reason": "出典が無い"}]
        rs_fail = [{"id": "RS-005", "kind": "value_as_method", "reason": "価値の判断"}]
        spec = {"world": self.world, "about": {"RS-005": {"verification": "F-003"}}}
        g0 = run({"args": args(), "flow_open": 1, "questions_at": {"3": ["RS-001"]}, **spec})["result"]
        g02 = run({"args": g0["next_args"], **spec, "ruled_at": {"3a": ["RS-001"], "3a'": ["RS-005"]}, "flow_sha_at": {"3a": "f-3a", "3a'": "f-3a2"},
                   "unverified_at": {"3a": ["F-003"], "3a'": ["F-003"]}, "verifier_fail": {"3av": fail, "3av'": fail + rs_fail}, "questions_at": {"3a-convert": ["RS-005"]}})
        res = g02["result"]
        self.assertEqual((res["status"], res["question_ids"]), ("needs_answers", ["RS-005"]), res.get("reason"))
        self.assertEqual(on_disk(self.world)["failed_current"], ["F-003"])
        r = run({"args": res["next_args"], **spec, "ruled_at": {"3a": ["RS-005"]}, "unverified_at": {"3a-settle": ["F-003"]}})
        self.assertIn("RS-005", self._prompt(r, "verifier:3av").split("検証する resolution の ID:")[1].split("\n")[0], "落ちた裁定への候補の選択は検証を通す")
        self.assertIn("F-003 ← RS-005", self._prompt(r, "flow-framer:3a-settle"))
        self.assertEqual(r["result"]["status"], "done", r["result"].get("reason"))
        self.assertEqual(on_disk(self.world)["unverified"], [])

    def test_書き換えて合格した要素をwriterに根拠にしない要素として渡さない(self):
        grounds = self._prompt(self._rewritten_after_fail(), "writer:U-1:draft")
        self.assertIn("出典が検証に落ちた流れの要素（この要素を根拠に規範を書かない）: （なし）", grounds)

    def _verification_ruled(self):
        fail = [{"id": "F-003", "kind": "insufficient_grounds", "reason": "出典が無い"}]
        return run({"args": args(), "verifier_fail": {"3v": fail}, "ruled_at": {"3'": ["RS-005"]}, "about": {"RS-005": {"verification": "F-003"}},
                    "unverified_at": {"3-settle": ["F-003"]}})

    def test_検証の裁定は同じ段のsettleでflowに写し検証する(self):
        r = self._verification_ruled()
        self.assertEqual([l for l in r["labels"] if l.startswith(("resolver:", "verifier:", "flow-framer:"))],
                         ["verifier:3v", "resolver:3'", "verifier:3v'", "flow-framer:3-settle", "verifier:3v-settle"])
        self.assertIn("F-003 ← RS-005", self._prompt(r, "flow-framer:3-settle"))
        judged_by(self, r, "verifier:3v-settle", "F-003")
        self.assertEqual(r["result"]["status"], "done", r["result"].get("reason"))

    def test_検証の裁定を写した要素をwriterに根拠にしない要素として渡さない(self):
        grounds = self._prompt(self._verification_ruled(), "writer:U-1:draft")
        self.assertIn("出典が検証に落ちた流れの要素（この要素を根拠に規範を書かない）: （なし）", grounds)

    def test_書き換えなかった検証の裁定の要素もsettleの検証に回す(self):
        fail = [{"id": "F-003", "kind": "insufficient_grounds", "reason": "出典が無い"}]
        r = run({"args": args(), "verifier_fail": {"3v": fail}, "ruled_at": {"3'": ["RS-005"]}, "about": {"RS-005": {"verification": "F-003"}},
                 "unverified_at": {"3-settle": ["F-003"]}, "fails_when_asked": fail})
        self.assertNotIn("F-003", self._prompt(r, "verifier:3v'"))
        judged_by(self, r, "verifier:3v-settle", "F-003")
        self.assertEqual((r["result"]["status"], r["result"]["next_args"]["from"]), ("blocked", "3"))
        self.assertIn("不合格: F-003", r["result"]["reason"])

    def test_verifierが返したFの合否がverificationsに無ければblocked(self):
        fail = [{"id": "F-003", "kind": "insufficient_grounds", "reason": "出典が無い"}]
        unput = run({"args": args(), "flow_open": 1, "questions_at": {"3": ["RS-001"]}, "verifier_fail": {"3v": fail}, "unput_at": {"3v": ["F-003"]}})
        self.assertEqual([l for l in unput["labels"] if l.startswith(("resolver:", "verifier:"))], ["resolver:3", "verifier:3v"])
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
        r = run({"args": args(), "verifier_fail": {"3v": fail}, "ruled_at": {"3'": ["RS-005"]}, "about": {"RS-005": {"verification": "D-003"}}})
        self.assertFalse(has(r["labels"], "flow-framer:3-settle"))
        self.assertEqual(r["result"]["status"], "done", r["result"].get("reason"))

    def test_覆された決定を引く要素はsettleで直し検証する(self):
        fail = [{"id": "D-003", "kind": "insufficient_grounds", "reason": "出典が無い"}]
        stale = [{"el": "F-002", "ref": "D-003"}]
        spec = {"args": args(), "verifier_fail": {"3v": fail}, "ruled_at": {"3'": ["RS-005"]}, "about": {"RS-005": {"verification": "D-003"}},
                "stale_refs_at": {"3v'": stale}, "unverified_at": {"3-settle": ["F-002"]}}
        r = run(spec)
        self.assertEqual([l for l in r["labels"] if l.startswith(("resolver:", "verifier:", "flow-framer:"))],
                         ["verifier:3v", "resolver:3'", "verifier:3v'", "flow-framer:3-settle", "verifier:3v-settle"])
        self.assertIn("F-002 ← D-003", self._prompt(r, "flow-framer:3-settle"))
        judged_by(self, r, "verifier:3v-settle", "F-002")
        self.assertEqual(r["result"]["status"], "done", r["result"].get("reason"))
        left = run({**spec, "stale_refs_at": {"3v'": stale, "3v-settle": stale, "3v-settle-2": stale}})["result"]
        self.assertEqual((left["status"], left["next_args"]["from"]), ("blocked", "3"))
        self.assertIn("覆された決定を引く要素: F-002（D-003）", left["reason"])

    def test_差し戻しの後も落ちた要素は同じcycleの検証の裁定をsettleで写せば進む(self):
        fail = [{"id": "F-003", "kind": "insufficient_grounds", "reason": "出典が無い"}]
        spec = {"args": self._g0()["next_args"], "ruled_at": {"3a": ["RS-001"], "3a'": ["RS-005"]}, "about": {"RS-005": {"verification": "F-003"}},
                "flow_sha_at": {"3a": "f-3a", "3a'": "f-3a2"}, "unverified_at": {"3a": ["F-003"], "3a'": ["F-003"], "3a-settle": ["F-003"]},
                "verifier_fail": {"3av": fail, "3av'": fail}}
        r = run(spec)
        self.assertEqual([l for l in r["labels"] if l.startswith(("resolver:3a", "verifier:3a", "flow-framer:3a"))],
                         ["resolver:3a", "verifier:3av", "resolver:3a'", "verifier:3av'", "flow-framer:3a-settle", "verifier:3av-settle"], "要素は変換に渡さない")
        self.assertIn("F-003 ← RS-005", self._prompt(r, "flow-framer:3a-settle"))
        self.assertEqual(r["result"]["status"], "done", r["result"].get("reason"))
        left = run({**spec, "verifier_fail": {**spec["verifier_fail"], "3av-settle": fail, "3av-settle-2": fail}})["result"]
        self.assertEqual((left["status"], left["next_args"]["from"]), ("blocked", "3a"), "settle の後も落ちたら止め、段の頭からやり直せる")
        self.assertIn("不合格: F-003", left["reason"])

    def test_変換と保持規則への変換で覆された決定もsettleで直す(self):
        stale = [{"el": "F-002", "ref": "D-001"}]
        rs_fail = [{"id": "RS-001", "kind": "insufficient_grounds", "reason": "出典が無い"}]
        convert = {"args": args(), "flow_open": 1, "ruled_at": {"3": ["RS-001"], "3'": ["RS-001"]}, "verifier_fail": {"3v": rs_fail, "3v'": rs_fail},
                   "holds_at": {"3-convert": ["RS-001"]}, "supersedes_at": {"3-convert": ["D-001"]}, "stale_refs_at": {"3-convert": stale},
                   "unverified_at": {"3-settle": ["F-002"]}}
        hold = {"args": args(), "findings": {"implementer:r1": [{"id": "r1-im-requirements__x-001"}], "grounding:r2": [{"id": "r2-gr-requirements__x-001", "route": "decision"}]},
                "questions_at": {"6": ["RS-020"]}, "supersedes_at": {"6-hold": ["D-001"]}, "stale_refs_at": {"6-hold": stale, "6-holdv-left": stale},
                "unverified_at": {"6-hold-settle": ["F-002"]}}
        for name, spec, framer, verifier, key in (("変換", convert, "flow-framer:3-settle", "verifier:3v-settle", "3v-settle"),
                                                  ("段 6 の保持規則への変換", hold, "flow-framer:6-hold-settle", "verifier:6-holdv-settle", "6-holdv-settle")):
            with self.subTest(name):
                r = run(spec)
                self.assertIsNone(r["error"], r["error"])
                self.assertIn("F-002 ← D-001", self._prompt(r, framer))
                judged_by(self, r, verifier, "F-002")
                self.assertEqual(r["result"]["status"], "done", r["result"].get("reason"))
                left = run({**spec, "stale_refs_at": {**spec["stale_refs_at"], key: stale, f"{key}-2": stale}})["result"]
                self.assertEqual(left["status"], "blocked")
                self.assertIn("覆された決定を引く要素: F-002（D-001）", left["reason"])

    def test_constrained_byの閉じた不変条件のOはsettleでRSに差し替えて検証する(self):
        # 段 2 で flow-framer が起こした kind invariant の O- を破壊的な工程が挙げ、段 3 の resolver が閉じた形。
        spec = {"args": args(), "flow_open": 1, "ruled_at": {"3": ["RS-001"]}, "open_only_at": {"3v": [{"el": "F-053", "constraint": "O-RS-001"}]}, "unverified_at": {"3-settle": ["F-053"]}}
        r = run(spec)
        self.assertEqual([l for l in r["labels"] if "settle" in l], ["flow-framer:3-settle", "verifier:3v-settle"])
        self.assertIn("constrained_by の閉じた O-（要素 の O- ← 閉じた resolution）: F-053 の O-RS-001 ← RS-001", self._prompt(r, "flow-framer:3-settle"))
        judged_by(self, r, "verifier:3v-settle", "F-053")
        self.assertEqual(r["result"]["status"], "done")
        same = spec["open_only_at"]["3v"]
        left = run({**spec, "open_only_at": {**spec["open_only_at"], "3v-settle": same, "3v-settle-2": same}})["result"]
        self.assertEqual(left["status"], "blocked")
        self.assertIn("閉じた未決を引く要素: F-053（O-RS-001）", left["reason"])
        held = run({**spec, "ruled_at": {}, "holds_at": {"3": ["RS-001"]}})
        self.assertFalse(has(held["labels"], "flow-framer:3-settle"), "hold で閉じた不変条件の O- は未決のまま縛りに残る")

    def test_段3で閉じたOも同じcycleでsettleする(self):
        r = run({"args": args(), "flow_open": 1, "ruled_at": {"3": ["RS-001"]}, "open_only_at": {"3v": [{"el": "F-091", "open": "O-RS-001"}]}})
        self.assertIn("flow-framer:3-settle", r["labels"])
        self.assertEqual(r["labels"][r["labels"].index("flow-framer:3-settle") + 1], "verifier:3v-settle")
        self.assertEqual(r["result"]["status"], "done")

    def test_保持規則と回答待ちの問いで閉じたOではsettleしない(self):
        only = [{"el": "F-091", "open": "O-RS-001"}]
        held = run({"args": args(), "flow_open": 1, "holds_at": {"3": ["RS-001"]}, "open_only_at": {"3v": only}})
        self.assertFalse(has(held["labels"], "flow-framer:3-settle"))
        asked = run({"args": args(), "flow_open": 1, "questions_at": {"3": ["RS-001"]}, "open_only_at": {"3v": only}})
        self.assertFalse(has(asked["labels"], "flow-framer:3-settle"))
        self.assertEqual(asked["result"]["status"], "needs_answers")

    def test_段6でも同じ経路でsettleする(self):
        spec = {"args": args(), "findings": {"crossDoc:r1": [{"id": "r1-cd-all-001", "route": "decision"}]}, "ruled_at": {"6": ["RS-011"]},
                "open_only_at": {"6v": [{"el": "F-091", "open": "O-RS-011"}]}}
        r = run(spec)
        self.assertIn("flow-framer:6-settle", r["labels"])
        self.assertEqual(r["labels"][r["labels"].index("flow-framer:6-settle") + 1], "verifier:6v-settle")
        same = spec["open_only_at"]["6v"]
        stopped = run({**spec, "open_only_at": {"6v": same, "6v-settle": same, "6v-settle-2": same}})["result"]
        self.assertEqual((stopped["status"], stopped["next_args"]["from"]), ("blocked", "6"))

    def test_settleでflowが閉じなければ差し戻し件数が減らなければblocked(self):
        spec = {"args": args(), "flow_open": 1, "ruled_at": {"3": ["RS-001"]}, "open_only_at": {"3v": [{"el": "F-091", "open": "O-RS-001"}]}}
        fixed = run({**spec, "flow_findings_at": {"3-settle": 1}, "pair_keys_at": {"3-settle-rework": ["pair:D-001|F-099"]}})
        self.assertEqual([l for l in fixed["labels"] if "settle" in l],
                         ["flow-framer:3-settle", "flow-framer:3-settle:rework", "resolver:3-settle-pairs", "verifier:3v-settle"], "組は差し戻した後の stdout から読む")
        self.assertIn("指摘が 1 件", self._prompt(fixed, "flow-framer:3-settle:rework"))
        self.assertEqual(fixed["result"]["status"], "done")
        broken = run({**spec, "flow_findings_at": {"3-settle": 1, "3-settle-rework": 1}})
        self.assertEqual([l for l in broken["labels"] if "settle" in l], ["flow-framer:3-settle", "flow-framer:3-settle:rework"])
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
        return [l for l in r["labels"] if l.startswith(("resolver:", "verifier:", "flow-framer"))]

    def _spec(self, nargs, stage, **kw):
        # stage の resolver が破壊的な工程を足し、生きている invariant が無い。settle の flow-framer が O-009 を足して縛る。
        v = "3av" if stage == "3a" else "3a'v"
        spec = {"args": nargs, "ruled_at": {stage: [kw.pop("answered")]}, "flow_sha_at": {stage: f"f-{stage}"},
                "flow_codes_at": {stage: self.DESTRUCTIVE, v: self.DESTRUCTIVE}, "unverified_at": {f"{stage}-settle": ["F-053"]},
                "open_ids_at": {f"{stage}-settle": ["O-009"]}, "about": {"RS-009": {"open": "O-009"}}}
        spec.update(kw)
        return spec

    def test_誰もflowを書かない段3と段6で台帳から出た縛りの無さも同じcycleで縛られ裁定される(self):
        # AC3: 段 3・6 の resolver は flow を書かない。台帳の書き込み（invariant の O- を invariant でない resolution で閉じる等）で出た
        # 縛りの無さは、どの段で生まれても settle の flow-framer が O- を足し、同じ cycle の resolver が裁定する。
        common = {"open_ids_at": {"3-settle": ["O-060"], "6-settle": ["O-060"]}, "about": {"RS-060": {"open": "O-060"}, "RS-010": {"finding": "r1-cd-all-001"}},
                  "unverified_at": {"3-settle": ["F-053"], "6-settle": ["F-053"]}}
        for stage, spec in (("3", {"flow_open": 1, "ruled_at": {"3": ["RS-001"], "3-settle-opens": ["RS-060"]}, "flow_codes_at": {"3": self.DESTRUCTIVE, "3v": self.DESTRUCTIVE}}),
                            ("6", {"findings": {"crossDoc:r1": [{"id": "r1-cd-all-001", "route": "decision"}]}, "ruled_at": {"6": ["RS-010"], "6-settle-opens": ["RS-060"]},
                                   "flow_codes_at": {"6": self.DESTRUCTIVE, "6v": self.DESTRUCTIVE}})):
            with self.subTest(stage=stage):
                r = run({"args": args(), **common, **spec})
                labels = r["labels"]
                self.assertEqual(labels[labels.index(f"verifier:{stage}v") + 1:][:3], [f"flow-framer:{stage}-settle", f"resolver:{stage}-settle-opens", f"verifier:{stage}v-settle"])
                self.assertIn("F-053: 縛る不変条件が無い", self._prompt(r, f"flow-framer:{stage}-settle"))
                self.assertIn("RS-060", self._prompt(r, f"verifier:{stage}v-settle").split("検証する resolution の ID:")[1].split("\n")[0])
                res = r["result"]
                self.assertEqual((res["status"], res["integrity"]), ("done", []), res.get("reason"))

    def test_G0の後の3aで縛りの無い破壊的な工程はflow_framerが縛りresolverが問いにできる(self):
        g0 = run({"args": args(), "flow_open": 1, "questions_at": {"3": ["RS-001"]}})["result"]
        r = run(self._spec(g0["next_args"], "3a", answered="RS-001", questions_at={"3a-settle-opens": ["RS-009"]}))
        self.assertEqual(self._cycle(r)[:5], ["resolver:3a", "verifier:3av", "flow-framer:3a-settle", "resolver:3a-settle-opens", "verifier:3av-settle"])
        self.assertFalse(has(r["labels"], "resolver:3a-flow"), "resolver には消せない指摘を resolver に差し戻さない")
        self.assertIn("F-053: 縛る不変条件が無い", self._prompt(r, "flow-framer:3a-settle"))
        table = value("FIXERS_BY_CODE")
        leave = [l for l in self._prompt(r, "resolver:3a").split("\n") if "は触らない" in l]
        self.assertEqual(len(leave), 1, "回答を当てる resolver に、flow-framer に残す符号を最初のプロンプトで渡す")
        self.assertEqual(set(re.findall(r"FLOW_[A-Z_]+", leave[0])), {k for k, v in table.items() if "resolver" not in v["fixers"]})
        opens = self._prompt(r, "resolver:3a-settle-opens")
        self.assertIn("まだ裁定の無い open", opens)
        self.assertIn("O-009", opens)
        self.assertNotIn("question ではなく hold", opens)
        self.assertIn("RS-009", self._prompt(r, "verifier:3av-settle").split("検証する resolution の ID:")[1].split("\n")[0])
        self.assertIn(VERIFY_ALL_MARK, self._prompt(r, "verifier:3av-settle"))
        self.assertNotIn("F-053", r["disk"]["unverified"], "flow-framer が直した要素は W の unverified から検証させる")
        res = r["result"]
        self.assertEqual((res["status"], res["question_ids"]), ("needs_answers", ["RS-009"]), res.get("reason"))
        self.assertEqual(res["answers_path"], "/tmp/prd-w/answers/g0-2.md")

    def test_3aの裁定で閉じたOはsettleの次の回でRSに差し替わり段を出る(self):
        g0 = run({"args": args(), "flow_open": 1, "questions_at": {"3": ["RS-001"]}})["result"]
        # 2 回目の settle の flow-framer の後も O-009 は open.json にあるが、RS-009 が裁定済みなので resolver に渡し直さない。
        spec = self._spec(g0["next_args"], "3a", answered="RS-001", ruled_at={"3a": ["RS-001"], "3a-settle-opens": ["RS-009"]},
                          open_only_at={"3av-settle": [{"el": "F-053", "constraint": "O-009"}]}, unverified_at={"3a-settle": ["F-053"], "3a-settle-2": ["F-053"]},
                          open_ids_at={"3a-settle": ["O-009"], "3a-settle-2": ["O-009"]})
        r = run(spec)
        self.assertEqual([l for l in r["labels"] if "settle" in l],
                         ["flow-framer:3a-settle", "resolver:3a-settle-opens", "verifier:3av-settle", "flow-framer:3a-settle-2", "verifier:3av-settle-2"])
        self.assertIn("F-053 の O-009 ← RS-009", self._prompt(r, "flow-framer:3a-settle-2"))
        self.assertEqual(r["result"]["status"], "done", r["result"].get("reason"))
        self.assertLessEqual(sum(1 for l in r["labels"] if l.startswith("flow-framer:3a-settle")), const("MAX_SETTLE_ROUNDS"))

    def test_3a_dashでは縛る不変条件の未決はholdにする(self):
        g1 = run({"args": args(), "findings": {"crossDoc:r1": [{"id": "r1-cd-all-001", "route": "decision"}]}, "questions_at": {"6": ["RS-010"]}})["result"]
        self.assertEqual(g1["next_args"]["from"], "3a'")
        r = run(self._spec(g1["next_args"], "3a'", answered="RS-010", holds_at={"3a'-settle-opens": ["RS-009"]}))
        self.assertEqual(self._cycle(r)[:5], ["resolver:3a'", "verifier:3a'v", "flow-framer:3a'-settle", "resolver:3a'-settle-opens", "verifier:3a'v-settle"])
        self.assertIn("question ではなく hold", self._prompt(r, "resolver:3a'-settle-opens"))
        self.assertFalse(has(r["labels"], "flow-framer:3a'-settle-2"), "hold の O- は保持規則として縛りに残る")
        self.assertEqual(r["result"]["status"], "done", r["result"].get("reason"))
        self.assertIn("RS-009", r["result"]["holds"])

    def test_resolverが消せる指摘は今どおりresolverに差し戻す(self):
        g0 = run({"args": args(), "flow_open": 1, "questions_at": {"3": ["RS-001"]}})["result"]
        both = {"FLOW_DANGLING": ["F-054"], **self.DESTRUCTIVE}
        r = run(self._spec(g0["next_args"], "3a", answered="RS-001", flow_codes_at={"3a": both, "3a-flow": self.DESTRUCTIVE, "3av": self.DESTRUCTIVE},
                           ruled_at={"3a": ["RS-001"], "3a-settle-opens": ["RS-009"]}))
        fix = self._prompt(r, "resolver:3a-flow")
        self.assertIn("指摘が 1 件", fix)
        self.assertIn("F-053（FLOW_DESTRUCTIVE_UNCONSTRAINED） は flow-framer が settle で直す", fix)
        self.assertIn("flow-framer:3a-settle", r["labels"])
        self.assertEqual(r["result"]["status"], "done", r["result"].get("reason"))

    def test_settleが新しい組と新しいOを作ったら1回のresolverにまとめて渡す(self):
        g0 = run({"args": args(), "flow_open": 1, "questions_at": {"3": ["RS-001"]}})["result"]
        r = run(self._spec(g0["next_args"], "3a", answered="RS-001", ruled_at={"3a": ["RS-001"], "3a-settle-opens": ["RS-009", "RS-010"]},
                           pair_keys_at={"3a-settle": ["pair:F-053|RS-001"]}, about={"RS-009": {"open": "O-009"}, "RS-010": {"pair": ["F-053", "RS-001"]}}))
        self.assertEqual([l for l in r["labels"] if l.startswith("resolver:3a-settle")], ["resolver:3a-settle-opens"])
        task = self._prompt(r, "resolver:3a-settle-opens")
        self.assertIn("まだ裁定の無い組（/tmp/prd-w/checks/conflicts.json）: pair:F-053|RS-001", task)
        self.assertIn("まだ裁定の無い open（/tmp/prd-w/open.json）: O-009", task)
        ids = self._prompt(r, "verifier:3av-settle").split("検証する resolution の ID:")[1].split("\n")[0]
        self.assertIn("RS-009", ids)
        self.assertIn("RS-010", ids)
        self.assertEqual(r["result"]["status"], "done", r["result"].get("reason"))

    def test_表に無い符号は生成者に差し戻さずに止める(self):
        g0 = run({"args": args(), "flow_open": 1, "questions_at": {"3": ["RS-001"]}})["result"]
        r = run(self._spec(g0["next_args"], "3a", answered="RS-001", flow_codes_at={"3a": {"FLOW_NEW": ["F-053"]}}))
        self.assertFalse(has(r["labels"], "resolver:3a-flow"))
        self.assertFalse(has(r["labels"], "verifier:3av"))
        # 表は静的なので、同じ段をやり直しても同じ符号で止まる。やり直しの引数を返さない。
        self.assertEqual((r["result"]["status"], r["result"]["next_args"]), ("blocked", None))
        self.assertIn("FLOW_NEW", r["result"]["reason"])
        settle = run(self._spec(g0["next_args"], "3a", answered="RS-001", flow_codes_at={"3a": self.DESTRUCTIVE, "3av": self.DESTRUCTIVE, "3a-settle": {"FLOW_NEW": ["F-053"]}}))
        self.assertFalse(has(settle["labels"], "flow-framer:3a-settle:rework"))
        self.assertEqual((settle["result"]["status"], settle["result"]["next_args"]), ("blocked", None))
        self.assertIn("FLOW_NEW", settle["result"]["reason"])
        framer = run({"args": args(), "flow_codes_at": {"framer": {"FLOW_NEW": ["F-001"]}}})["result"]
        self.assertEqual((framer["status"], framer["next_args"]), ("blocked", None))
        self.assertIn("FLOW_NEW", framer["reason"])

    def _settle_fails(self, nargs, stage, fail, **kw):
        v = "3av-settle" if stage == "3a" else "3a'v-settle"
        return run(self._spec(nargs, stage, verifier_fail={v: [fail]}, **kw))

    def test_settleのverifierに落ちたOの裁定は3a_dashでは保持規則に変えて段を出る(self):
        g1 = run({"args": args(), "findings": {"crossDoc:r1": [{"id": "r1-cd-all-001", "route": "decision"}]}, "questions_at": {"6": ["RS-010"]}})["result"]
        r = self._settle_fails(g1["next_args"], "3a'", {"id": "RS-009", "kind": "value_as_method", "reason": "r"}, answered="RS-010",
                               ruled_at={"3a'": ["RS-010"], "3a'-settle-opens": ["RS-009"]}, holds_at={"3a'-settle-convert": ["RS-009"]})
        self.assertEqual(self._cycle(r)[:6], ["resolver:3a'", "verifier:3a'v", "flow-framer:3a'-settle", "resolver:3a'-settle-opens", "verifier:3a'v-settle", "resolver:3a'-settle-convert"])
        self.assertIn("RS-009 → hold（value_as_method）", self._prompt(r, "resolver:3a'-settle-convert"))
        self.assertFalse(has(r["labels"], "verifier:3a'v-settle-2"), "変換した裁定はもう検証しない")
        self.assertEqual(r["result"]["status"], "done", r["result"].get("reason"))
        self.assertIn("RS-009", r["result"]["holds"])

    def test_settleのverifierが回答待ちの問いを落としても変換しない(self):
        # G0 の問い RS-001・RS-002 のうち 3a で RS-001 だけに答えた。settle の verifier に RS-002 は渡していない。
        g0 = run({"args": args(), "flow_open": 1, "questions_at": {"3": ["RS-001", "RS-002"]}})["result"]
        fails = [{"id": "RS-009", "kind": "value_as_method", "reason": "r"}, {"id": "RS-002", "kind": "insufficient_grounds", "reason": "r"}]
        r = run(self._spec(g0["next_args"], "3a", answered="RS-001", ruled_at={"3a": ["RS-001"], "3a-settle-opens": ["RS-009"]},
                           verifier_fail={"3av-settle": fails}, questions_at={"3a-settle-convert": ["RS-009"], "3b": ["RS-002"]}))
        convert = self._prompt(r, "resolver:3a-settle-convert")
        self.assertIn("RS-009 → question", convert)
        self.assertNotIn("RS-002", convert)
        res = r["result"]
        self.assertEqual(res["status"], "needs_answers", res.get("reason"))
        self.assertIn("RS-002", res["question_ids"])
        self.assertNotIn("RS-002", res["next_args"]["state"].get("failed_ids", []))

    def test_settleのverifierに落ちたOの裁定はG0の後の3aでは問いにできる(self):
        g0 = run({"args": args(), "flow_open": 1, "questions_at": {"3": ["RS-001"]}})["result"]
        r = self._settle_fails(g0["next_args"], "3a", {"id": "RS-009", "kind": "value_as_method", "reason": "r"}, answered="RS-001",
                               ruled_at={"3a": ["RS-001"], "3a-settle-opens": ["RS-009"]}, questions_at={"3a-settle-convert": ["RS-009"]})
        self.assertIn("RS-009 → question（value_as_method）", self._prompt(r, "resolver:3a-settle-convert"))
        res = r["result"]
        self.assertEqual((res["status"], res["question_ids"]), ("needs_answers", ["RS-009"]), res.get("reason"))

    def test_settleで変換した後もverifierが見た覆された決定を引く要素は次の回で直す(self):
        # 変換の resolver の stdout は stale_refs を申告していない。verifier の stdout にあった分を落とさない。
        g0 = run({"args": args(), "flow_open": 1, "questions_at": {"3": ["RS-001"]}})["result"]
        r = self._settle_fails(g0["next_args"], "3a", {"id": "RS-009", "kind": "value_as_method", "reason": "r"}, answered="RS-001",
                               ruled_at={"3a": ["RS-001"], "3a-settle-opens": ["RS-009"]}, questions_at={"3a-settle-convert": ["RS-009"]},
                               stale_refs_at={"3av-settle": [{"el": "F-053", "ref": "D-001"}]})
        self.assertIn("resolver:3a-settle-convert", r["labels"])
        self.assertIn("F-053 ← D-001", self._prompt(r, "flow-framer:3a-settle-2"))

    def test_settleのverifierに落ちた組の裁定も止めずに変える(self):
        g1 = run({"args": args(), "findings": {"crossDoc:r1": [{"id": "r1-cd-all-001", "route": "decision"}]}, "questions_at": {"6": ["RS-010"]}})["result"]
        r = self._settle_fails(g1["next_args"], "3a'", {"id": "RS-011", "kind": "insufficient_grounds", "reason": "r"}, answered="RS-010",
                               open_ids_at={}, pair_keys_at={"3a'-settle": ["pair:F-053|RS-010"]}, about={"RS-011": {"pair": ["F-053", "RS-010"]}},
                               ruled_at={"3a'": ["RS-010"], "3a'-settle-pairs": ["RS-011"]}, holds_at={"3a'-settle-convert": ["RS-011"]})
        self.assertIn("resolver:3a'-settle-pairs", r["labels"])
        self.assertIn("RS-011 → hold（insufficient_grounds）", self._prompt(r, "resolver:3a'-settle-convert"))
        self.assertEqual(r["result"]["status"], "done", r["result"].get("reason"))

    def test_settleのverifierが独立に見つけた縛りの無さは台帳が変わらない回で残ればflow_framerの指摘として止める(self):
        # 1 回目は flow-framer の後に resolver が O-009 を裁定して台帳を変えたので、次の回の flow-framer に渡す。2 回目は台帳が変わらず、
        # flow-framer の stdout に無かった指摘は flow-framer 自身のもので、渡し直す先が無い。
        g0 = run({"args": args(), "flow_open": 1, "questions_at": {"3": ["RS-001"]}})["result"]
        spec = self._spec(g0["next_args"], "3a", answered="RS-001", ruled_at={"3a": ["RS-001"], "3a-settle-opens": ["RS-009"]},
                          flow_codes_at={"3a": self.DESTRUCTIVE, "3av": self.DESTRUCTIVE, "3av-settle": self.DESTRUCTIVE})
        passed = run(spec)
        self.assertIn("F-053: 縛る不変条件が無い", self._prompt(passed, "flow-framer:3a-settle-2"))
        self.assertEqual(passed["result"]["status"], "done", passed["result"].get("reason"))
        r = run({**spec, "flow_codes_at": {**spec["flow_codes_at"], "3av-settle-2": self.DESTRUCTIVE}})
        self.assertEqual(r["result"]["status"], "blocked")
        self.assertIn("段 3av-settle-2: verifier の doc_check flow に指摘が 1 件", r["result"]["reason"])

    def test_変換の後のsettleに渡す指摘はflow_checkのstdoutから取る(self):
        # 変換が台帳を変えて縛りの無さが出たのに、変換の resolver の stdout は 0 件と申告した。差し戻しの verifier は変換の前に
        # 走ったので見ていない。別の agent（flow-check）の stdout から flow-framer に渡し、申告との食い違いを integrity に残す。
        # 候補の選択だけの回答は verifier に渡さないので、自由記述の回答にして検証させる。
        g0 = run({"args": args(), "flow_open": 1, "questions_at": {"3": ["RS-001"]}})["result"]
        fail = [{"id": "RS-001", "kind": "insufficient_grounds", "reason": "r"}]
        spec = self._spec(g0["next_args"], "3a", answered="RS-001", ruled_at={"3a": ["RS-001"], "3a'": ["RS-001"], "3a-settle-opens": ["RS-009"]},
                          free_text_at={"3a": ["RS-001"]}, verifier_fail={"3av": fail, "3av'": fail}, holds_at={"3a-convert": ["RS-001"]},
                          flow_codes_at={"3a-convert-seen": self.DESTRUCTIVE}, recheck_as={"3a-convert": "3a-convert-seen"})
        r = run(spec)
        self.assertEqual(self._cycle(r)[4:6], ["resolver:3a-convert", "flow-framer:3a-settle"])
        self.assertEqual(r["labels"][r["labels"].index("resolver:3a-convert") + 1], "flow-check:3a-convert")
        self.assertIn("F-053: 縛る不変条件が無い", self._prompt(r, "flow-framer:3a-settle"))
        self.assertEqual(r["result"]["status"], "done", r["result"].get("reason"))
        self.assertTrue(any("resolver（段 3a-convert）" in x and "codes・findings で違う" in x for x in r["result"]["integrity"]), r["result"]["integrity"])
        honest = run({**spec, "flow_codes_at": {"3a-convert": self.DESTRUCTIVE}, "recheck_as": {}})["result"]
        self.assertEqual(honest["status"], "done", honest.get("reason"))
        self.assertEqual(honest["integrity"], [], "申告が一致すれば integrity に残さない")

    def test_settleの変換の後にflow_checkが見た指摘は次の回のsettleで直す(self):
        # settle の verifier は flow-framer が消せる指摘を 0 件にしてから通るので、残りに数える指摘は変換が台帳を変えて出たものだけ。
        g0 = run({"args": args(), "flow_open": 1, "questions_at": {"3": ["RS-001"]}})["result"]
        seen = {"FLOW_DESTRUCTIVE_UNCONSTRAINED": ["F-071"]}
        spec = self._spec(g0["next_args"], "3a", answered="RS-001", ruled_at={"3a": ["RS-001"], "3a-settle-opens": ["RS-009"]},
                          verifier_fail={"3av-settle": [{"id": "RS-009", "kind": "value_as_method", "reason": "r"}]},
                          questions_at={"3a-settle-convert": ["RS-009"]}, recheck_as={"3a-settle-convert": "3a-settle-convert-seen"})
        spec["flow_codes_at"] = {**spec["flow_codes_at"], "3a-settle-convert-seen": seen}
        r = run(spec)
        self.assertIn("flow-check:3a-settle-convert", r["labels"])
        self.assertIn("F-071: 縛る不変条件が無い", self._prompt(r, "flow-framer:3a-settle-2"))
        self.assertEqual(r["result"]["status"], "needs_answers", r["result"].get("reason"))
        self.assertEqual(r["result"]["question_ids"], ["RS-009"])

    def test_変換の後の指摘は符号によらずsettleのflow_framerに渡し表に無い符号では止める(self):
        # 変換の resolver は flow を書かないので、台帳を変えて出た指摘はどの符号でも flow-framer にしか直せない。
        # 段を出るときも settle の回の中と同じ規則で渡す（回答を当てた resolver が消せる符号でも止めない）。
        fail = [{"id": "RS-001", "kind": "insufficient_grounds", "reason": "r"}]
        # 過少申告: 変換の resolver の stdout は 0 件で、flow-check だけが見る。
        for seen in ("3-convert", "3-convert-seen"):
            spec = {"args": args(), "flow_open": 1, "ruled_at": {"3": ["RS-001"], "3'": ["RS-001"]}, "verifier_fail": {"3v": fail, "3v'": fail},
                    "holds_at": {"3-convert": ["RS-001"]}, "recheck_as": {"3-convert": seen}, "unverified_at": {"3-settle": ["F-002"]}}
            with self.subTest(code="FLOW_DANGLING", seen=seen):
                r = run({**spec, "flow_codes_at": {seen: {"FLOW_DANGLING": ["F-002"]}}})
                self.assertIn("F-002: FLOW_DANGLING", self._prompt(r, "flow-framer:3-settle"))
                self.assertEqual(r["result"]["status"], "done", r["result"].get("reason"))
            with self.subTest(code="FLOW_NEW", seen=seen):
                r = run({**spec, "flow_codes_at": {seen: {"FLOW_NEW": ["F-002"]}}})
                self.assertFalse(has(r["labels"], "flow-framer:3-settle"), "誰が消せるか分からない符号は渡さない")
                self.assertEqual((r["result"]["status"], r["result"]["next_args"]), ("blocked", None))
                self.assertIn("直し手の表（FIXERS_BY_CODE）に無い符号があります: FLOW_NEW", r["result"]["reason"])

    def test_変換と問いの形の差し戻しの後はflow_checkを1回だけ起動し最後のresolverの申告と照合する(self):
        # 覆された決定は差し戻しの resolver（3-convert-questions）が書いた。変換の resolver の stdout と照合すると、正直な申告を
        # integrity に食い違いとして残す。settle は flow-check の stdout から 1 回だけ起動する。
        stale = [{"el": "F-002", "ref": "D-001"}]
        vam = [{"id": "RS-001", "kind": "value_as_method", "reason": "r"}]
        r = run({"args": args(), "flow_open": 1, "ruled_at": {"3": ["RS-001"], "3'": ["RS-001"]}, "verifier_fail": {"3v": vam, "3v'": vam},
                 "questions_at": {"3-convert": ["RS-001"]}, "bad_questions_at": ["3-convert"], "supersedes_at": {"3-convert-questions": ["D-001"]},
                 "stale_refs_at": {"3-convert-questions": stale}, "unverified_at": {"3-settle": ["F-002"]}})
        self.assertEqual([l for l in r["labels"] if l.startswith("flow-check:")], ["flow-check:1-entry", "flow-check:3-convert-questions"])
        self.assertEqual([l for l in r["labels"] if l.startswith("flow-framer:")], ["flow-framer:3-settle"])
        self.assertIn("F-002 ← D-001", self._prompt(r, "flow-framer:3-settle"))
        self.assertEqual(r["result"]["integrity"], [])
        self.assertEqual(r["result"]["status"], "needs_answers", r["result"].get("reason"))

    def test_verifierを起動しない裁定の後もflow_checkのstdoutでsettleする(self):
        # 段 6 の resolver が検証する ID を返さなかった（対象を裁定し損ねた）ので verifier が起動しない。台帳は書いたので、flow-check が見る。
        spec = {"args": args(), "findings": {"crossDoc:r1": [{"id": "r1-cd-all-001", "route": "decision"}]},
                "flow_codes_at": {"6": self.DESTRUCTIVE}, "unverified_at": {"6-settle": ["F-053"]}}
        r = run(spec)
        labels = r["labels"]
        self.assertNotIn("verifier:6v", labels)
        self.assertEqual(labels[labels.index("resolver:6") + 1:][:3], ["flow-check:6", "flow-framer:6-settle", "verifier:6v-settle"])
        self.assertIn("F-053: 縛る不変条件が無い", self._prompt(r, "flow-framer:6-settle"))

    def test_変換で問いにもholdにも返らなかった裁定があれば止める(self):
        g1 = run({"args": args(), "findings": {"crossDoc:r1": [{"id": "r1-cd-all-001", "route": "decision"}]}, "questions_at": {"6": ["RS-010"]}})["result"]
        fail = {"id": "RS-009", "kind": "value_as_method", "reason": "r"}
        for name, kw in (("返さない", {"holds_at": {"3a'-settle-convert": []}}), ("裁定で返す", {"ruled_at": {"3a'": ["RS-010"], "3a'-settle-opens": ["RS-009"], "3a'-settle-convert": ["RS-009"]}}),
                         ("問いで返す", {"questions_at": {"3a'-settle-convert": ["RS-009"]}})):
            with self.subTest(settle=name):
                spec = {"answered": "RS-010", "ruled_at": {"3a'": ["RS-010"], "3a'-settle-opens": ["RS-009"]}, **kw}
                res = self._settle_fails(g1["next_args"], "3a'", fail, **spec)
                self.assertIn("resolver:3a'-settle-convert", res["labels"])
                self.assertFalse(has(res["labels"], "writer:"))
                r = res["result"]
                self.assertEqual((r["status"], r["next_args"]["from"]), ("blocked", "3a'"), r.get("reason"))
                self.assertIn("RS-009 を resolver が hold に返しませんでした", r["reason"], "聞けない段の変換は hold だけを受け取る")
        rs = [{"id": "RS-001", "kind": "insufficient_grounds", "reason": "r"}]
        base = {"args": args(), "flow_open": 1, "ruled_at": {"3": ["RS-001"], "3'": ["RS-001"]}, "verifier_fail": {"3v": rs, "3v'": rs}}
        for name, kw in (("返さない", {"holds_at": {"3-convert": []}}), ("裁定で返す", {"ruled_at": {**base["ruled_at"], "3-convert": ["RS-001"]}})):
            with self.subTest(stage3=name):
                res = run({**base, **kw})
                self.assertFalse(has(res["labels"], "writer:"))
                r = res["result"]
                self.assertEqual((r["status"], r["next_args"]["from"]), ("blocked", "3"), r.get("reason"))
                self.assertIn("RS-001 を resolver が question にも hold にも返しませんでした", r["reason"])

    def test_変換の後のsettleに渡す閉じたOと覆された決定はverifierのstdoutから取る(self):
        rs = [{"id": "RS-001", "kind": "insufficient_grounds", "reason": "r"}]
        base = {"args": args(), "flow_open": 1, "ruled_at": {"3": ["RS-001", "RS-002"], "3'": ["RS-001"]}, "verifier_fail": {"3v": rs, "3v'": rs},
                "holds_at": {"3-convert": ["RS-001"]}, "unverified_at": {"3-settle": ["F-060"]}}
        for name, kw, line in (("open_only", {"open_only_at": {"3v'": [{"el": "F-060", "open": "O-RS-002"}]}}, "F-060（O-RS-002 ← RS-002）"),
                               ("stale_refs", {"stale_refs_at": {"3v'": [{"el": "F-060", "ref": "D-003"}]}}, "F-060 ← D-003")):
            with self.subTest(name):
                r = run({**base, **kw})
                self.assertIn("resolver:3-convert", r["labels"])
                self.assertIn(line, self._prompt(r, "flow-framer:3-settle"))
                self.assertEqual(r["result"]["status"], "done", r["result"].get("reason"))
        g0 = run({"args": args(), "flow_open": 1, "questions_at": {"3": ["RS-001"]}})["result"]
        r = self._settle_fails(g0["next_args"], "3a", {"id": "RS-009", "kind": "value_as_method", "reason": "r"}, answered="RS-001",
                               ruled_at={"3a": ["RS-001"], "3a-settle-opens": ["RS-009"]}, questions_at={"3a-settle-convert": ["RS-009"]},
                               open_only_at={"3av-settle": [{"el": "F-060", "open": "O-RS-001"}]})
        self.assertIn("resolver:3a-settle-convert", r["labels"])
        self.assertIn("F-060（O-RS-001 ← RS-001）", self._prompt(r, "flow-framer:3a-settle-2"))

    def test_重い段の経路でもlabelは重ならない(self):
        # telemetry と再開の照合は label で呼び出しを引くので、同じ段の中で label が重なると呼び出しを取り違える。
        g0 = run({"args": args(), "flow_open": 1, "questions_at": {"3": ["RS-001"]}})["result"]
        fail = [{"id": "RS-001", "kind": "value_as_method", "reason": "r"}]
        r = run(self._spec(
            g0["next_args"], "3a", answered="RS-001",
            ruled_at={"3a": ["RS-001"], "3a'": ["RS-001"], "3a-pairs": ["RS-002"], "3a'-pairs": ["RS-003"]}, free_text_at={"3a": ["RS-001"]},
            questions_at={"3a": ["RS-004"], "3a'": ["RS-005"], "3a-pairs": ["RS-006"], "3a'-pairs": ["RS-007"], "3a-convert": ["RS-001"], "3a-settle-opens": ["RS-009"],
                          "3a-settle-convert": ["RS-009"]},
            bad_questions_at=["3a", "3a'", "3a-pairs", "3a'-pairs", "3a-convert", "3a-settle-opens", "3a-settle-convert"],
            verifier_fail={"3av": fail, "3av'": fail, "3av-settle": [{"id": "RS-009", "kind": "value_as_method", "reason": "r"}]},
            flow_sha_at={"3a": "f-3a", "3a'": "f-3a2"},
            pair_keys_at={"3a": ["pair:D-001|F-099"], "3a'": ["pair:D-001|F-099", "pair:D-002|F-098"]},
            about={"RS-002": {"pair": ["D-001", "F-099"]}, "RS-003": {"pair": ["D-002", "F-098"]}, "RS-009": {"open": "O-009"}},
            flow_codes_at={"3a": self.DESTRUCTIVE, "3a'": self.DESTRUCTIVE, "3av": self.DESTRUCTIVE, "3av'": self.DESTRUCTIVE}))
        cycle = [l for l in r["labels"] if l.split(":")[0] in ("resolver", "verifier", "flow-framer", "flow-check") and l.split(":")[1].startswith("3a")]
        for want in ("resolver:3a-pairs", "resolver:3a'-pairs", "resolver:3a-questions", "resolver:3a'-questions", "resolver:3a-pairs-questions",
                     "resolver:3a-convert-questions", "resolver:3a-settle-opens-questions", "resolver:3a-settle-convert", "resolver:3a-settle-convert-questions",
                     "flow-check:3a-convert-questions", "flow-check:3a-settle-convert-questions"):
            self.assertIn(want, cycle)
        self.assertEqual(len(cycle), len(set(cycle)), sorted(l for l in cycle if cycle.count(l) > 1))


@unittest.skipIf(shutil.which("node") is None, "node が無い環境ではスキップする")
class FindingRoutes(unittest.TestCase):
    """前のパスの指摘の受け渡し・direction の逆転・指摘の由来層（origin）の経路。"""

    ITEM = "PR-X-001"

    def _prompt(self, r, label):
        return next(p["prompt"] for p in r["prompts"] if p["label"] == label)

    def _reversal(self, r3_direction):
        # PR-X-001 への指摘は non-blocking にして再発（両パスで blocking）と分け、パスは別の項目の blocking で進める。
        return run({"args": args(), "findings": {
            "implementer:r1": [{"id": "r1-im-requirements__x-001"}],
            "grounding:r2": [{"id": "r2-gr-requirements__x-001", "direction": "tighten", "blocking": False},
                             {"id": "r2-gr-requirements__x-002", "item_id": "PR-X-002"}],
            "grounding:r3": [{"id": "r3-gr-requirements__x-001", "direction": r3_direction, "blocking": False},
                             {"id": "r3-gr-requirements__x-003", "item_id": "PR-X-003"}],
        }})

    def test_前のパスと逆向きの指摘はdecisionになり段6に届く(self):
        r = self._reversal("relax")
        self.assertIn("route が decision の指摘 r3-gr-requirements__x-001", self._prompt(r, "resolver:6"))
        self.assertFalse(has(self._reversal("tighten")["labels"], "resolver:6"))

    def test_段8の監査に同じ項目への前のパスの指摘のIDが入る(self):
        r = self._reversal("relax")
        self.assertIn("同じ項目への前のパスの指摘: r1-im-requirements__x-001", self._prompt(r, "grounding:r2:requirements/x"))
        self.assertIn("同じ項目への前のパスの指摘: r2-gr-requirements__x-001", self._prompt(r, "grounding:r3:requirements/x"))
        self.assertNotIn("前のパスの指摘", self._prompt(r, "grounding:r1:requirements/x"))

    def test_改稿のwriterに項目のtraceが指すflow要素のIDを渡す(self):
        r = run({"args": args(), "doc_flow_refs": {"requirements/x": {"PR-X-001": ["F-011", "F-010"]}, "requirements/y": {"PR-X-002": ["F-099"]}},
                 "findings": {"implementer:r1": [{"id": "r1-im-requirements__x-001", "blocking": False},
                                                 {"id": "r1-im-requirements__x-002", "item_id": "PR-X-002", "blocking": False}]}})
        revise = self._prompt(r, "writer:U-1:revise")
        self.assertIn("- requirements/x PR-X-001: r1-im-requirements__x-001（trace が指す flow 要素: F-010, F-011）", revise)
        self.assertIn("- requirements/x PR-X-002: r1-im-requirements__x-002\n", revise, "別の文書の同じ項目 ID の要素は渡さない")
        self.assertNotIn("F-099", revise)
        none = self._prompt(run({"args": args(), "findings": {"implementer:r1": [{"id": "r1-im-requirements__x-001", "blocking": False}]}}), "writer:U-1:revise")
        self.assertNotIn("flow 要素", none, "flow_refs の無い項目では行を出さない")

    FLOW_FINDING = "r1-im-requirements__x-001"

    def _flow_finding(self, **kw):
        spec = {"args": args(), "findings": {"implementer:r1": [{"id": self.FLOW_FINDING, "route": "writer", "origin": "flow", "blocking": False}]},
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
        self.assertEqual(settle, ["flow-framer:6-settle", "verifier:6v-settle"], "閉じた O- が無くても起動する")
        self.assertIn(f"{self.FLOW_FINDING}（← RS-011）", self._prompt(r, "flow-framer:6-settle"))
        judged_by(self, r, "verifier:6v-settle", "F-010")
        fail = [{"id": "F-010", "kind": "insufficient_grounds", "reason": "出典が無い"}]
        failed = self._flow_finding(verifier_fail={"3v": fail, "3v'": fail}, holds_at={"3'": ["RS-005"]},
                                    about={"RS-011": {"finding": self.FLOW_FINDING}, "RS-005": {"verification": "F-010"}})
        judged_by(self, failed, "verifier:6v-settle", "F-010")  # 検証に落ちた要素でも、指摘から直させて書き換えれば検証する
        text = run({**{"args": args()}, "findings": {"implementer:r1": [{"id": self.FLOW_FINDING, "route": "decision", "origin": "text", "blocking": False}]},
                    "ruled_at": {"6": ["RS-011"]}, "about": {"RS-011": {"finding": self.FLOW_FINDING}}})
        self.assertFalse(has(text["labels"], "flow-framer:6-settle"), "origin が text の指摘の裁定は flow に写さない")

    def test_G1の後の3aでは段6で写した指摘を写し直さない(self):
        g1 = self._flow_finding(questions_at={"6": ["RS-012"]})
        self.assertEqual(g1["result"]["status"], "needs_answers")
        self.assertIn("flow-framer:6-settle", g1["labels"])
        r = run({"args": g1["result"]["next_args"], "ruled_at": {"3a'": ["RS-012"]}, "about": {"RS-011": {"finding": self.FLOW_FINDING}}})
        self.assertFalse(has(r["labels"], "flow-framer:3a'-settle"))
        self.assertEqual(r["result"]["status"], "done", r["result"].get("reason"))

    def test_監査役の返り値のスキーマはdirectionとoriginを契約の値に絞る(self):
        item = run({"args": args()})["auditSchema"]["properties"]["findings"]["items"]
        self.assertEqual(sorted(item["properties"]["direction"]["enum"]), contract_values("direction"))
        self.assertEqual(sorted(item["properties"]["origin"]["enum"]), contract_values("origin"))
        self.assertLessEqual({"direction", "origin"}, set(item["required"]))


@unittest.skipIf(shutil.which("node") is None, "node が無い環境ではスキップする")
class Reframe(unittest.TestCase):
    """G0 の回答で flow を組み直す段 3b と、追加の問いを G0-2 の 1 回に集める経路（A5）。"""

    def _g0(self, **kw):
        return run({"args": args(), "flow_open": 1, "questions_at": {"3": ["RS-001"]}, **kw})["result"]

    def _prompt(self, r, label):
        return next(p["prompt"] for p in r["prompts"] if p["label"] == label)

    def _cycle(self, labels):
        return [l for l in labels if l.startswith(("resolver:", "verifier:", "flow-framer"))]

    def test_G0からG0_2を経て初稿に進む(self):
        g02 = run({"args": self._g0()["next_args"], "ruled_at": {"3a": ["RS-001"]}, "questions_at": {"3a": ["RS-002"], "3b": ["RS-002"]}})
        self.assertEqual(self._cycle(g02["labels"]), ["resolver:3a", "verifier:3av", "flow-framer:3b-reframe", "resolver:3b", "verifier:3bv"])
        res = g02["result"]
        self.assertEqual((res["status"], res["answers_path"], res["next_args"]["from"]), ("needs_answers", "/tmp/prd-w/answers/g0-2.md", "3a"))
        r = run({"args": res["next_args"], "ruled_at": {"3a": ["RS-002"]}})
        self.assertEqual(self._cycle(r["labels"]), ["resolver:3a", "verifier:3av"], "G0-2 の回答の後は組み直さない")
        self.assertEqual(r["labels"][3:5], ["flow-check:4-backup", "writer:U-1:draft"], "writer の前に本文の控えを取る")
        self.assertEqual(r["result"]["status"], "done")

    def test_持ち越した問いは3bの後にも問いの形を検査する(self):
        r = run({"args": self._g0()["next_args"], "ruled_at": {"3a": ["RS-001"]}, "questions_at": {"3a": ["RS-002"]}})
        self.assertIn("--ids RS-002 --check", self._prompt(r, "resolver:3b-questions"), "返さなかった持ち越しの問いも検査させる")
        self.assertEqual(r["result"]["question_ids"], ["RS-002"])
        broken = run({"args": self._g0()["next_args"], "ruled_at": {"3a": ["RS-001"]}, "questions_at": {"3a": ["RS-002"]}, "bad_questions_at": ["3b-questions", "3b-questions-2"]})["result"]
        self.assertEqual((broken["status"], broken["next_args"]["from"]), ("blocked", "3b"))

    def test_3aの問いと3bの問いを1回のG0_2で聞く(self):
        r = run({"args": self._g0()["next_args"], "ruled_at": {"3a": ["RS-001"]}, "questions_at": {"3a": ["RS-002"], "3b": ["RS-003"]}})
        self.assertNotIn("resolver:3a-hold", r["labels"])
        self.assertIn("RS-002", self._prompt(r, "resolver:3b"))
        self.assertIn("根拠にしてよい resolution（合格・回答済み）: RS-001\n", self._prompt(r, "flow-framer:3b-reframe"), "回答待ちの RS-002 は出典にさせない")
        self.assertEqual((r["result"]["status"], r["result"]["question_ids"]), ("needs_answers", ["RS-002", "RS-003"]))

    def test_3bで決まった問いはG0_2で聞かない(self):
        spec = {"args": self._g0()["next_args"], "ruled_at": {"3a": ["RS-001"], "3b": ["RS-002"]}, "questions_at": {"3a": ["RS-002"]}}
        r = run(spec)
        self.assertIn("RS-002", self._prompt(r, "verifier:3bv").split("検証する resolution の ID:")[1].split("\n")[0])
        self.assertEqual(r["result"]["status"], "done")
        both = run({**spec, "questions_at": {"3a": ["RS-002"], "3b": ["RS-003"]}})["result"]
        self.assertEqual(both["question_ids"], ["RS-003"])

    def test_3bで問いが0件ならG0_2を出さない(self):
        r = run({"args": self._g0()["next_args"], "ruled_at": {"3a": ["RS-001"]}})
        self.assertNotIn("resolver:3b", r["labels"])
        self.assertEqual(r["result"]["status"], "done")

    def test_G0_2の後に出た問いは保持規則になる(self):
        g02 = run({"args": self._g0()["next_args"], "ruled_at": {"3a": ["RS-001"]}, "questions_at": {"3a": ["RS-002"]}})["result"]
        r = run({"args": g02["next_args"], "ruled_at": {"3a": ["RS-002"]}, "questions_at": {"3a": ["RS-003"]}})
        self.assertIn("依頼者にはもう聞けない", self._prompt(r, "resolver:3a"))
        self.assertIn("resolver:3a-hold", r["labels"])
        self.assertFalse(has(r["labels"], "flow-framer:3b"))
        self.assertEqual(r["result"]["status"], "done")
        self.assertIn("RS-003", r["result"]["holds"])

    def test_回答の後の保持規則への変換で覆された決定もsettleで直す(self):
        g02 = run({"args": self._g0()["next_args"], "ruled_at": {"3a": ["RS-001"]}, "questions_at": {"3a": ["RS-002"]}})["result"]
        stale = [{"el": "F-002", "ref": "D-001"}]
        spec = {"args": g02["next_args"], "ruled_at": {"3a": ["RS-002"]}, "questions_at": {"3a": ["RS-003"]}, "supersedes_at": {"3a-hold": ["D-001"]},
                "stale_refs_at": {"3a-hold": stale, "3a-holdv-left": stale}, "unverified_at": {"3a-hold-settle": ["F-002"]}}
        r = run(spec)
        self.assertIn("F-002 ← D-001", self._prompt(r, "flow-framer:3a-hold-settle"))
        judged_by(self, r, "verifier:3a-holdv-settle", "F-002")
        self.assertEqual(r["result"]["status"], "done", r["result"].get("reason"))
        left = run({**spec, "stale_refs_at": {"3a-hold": stale, "3a-holdv-left": stale, "3a-holdv-settle": stale, "3a-holdv-settle-2": stale}})["result"]
        self.assertEqual((left["status"], left["next_args"]["from"]), ("blocked", "3a"))
        self.assertEqual(r["result"]["hold_drafts"], [])

    def test_組み直しで出たopenと組をresolverに渡す(self):
        spec = {"args": self._g0()["next_args"], "ruled_at": {"3a": ["RS-001"], "3b": ["RS-005"]},
                "about": {"RS-005": {"open": "O-020"}},
                "open_ids_at": {"3b-reframe": ["O-020", "O-021", "O-RS-001"]},
                "pair_keys_at": {"3b-reframe": ["pair:D-010|F-035"]}}
        r = run(spec)
        task = self._prompt(r, "resolver:3b")
        self.assertIn("まだ裁定の無い open: O-020, O-021", task, "要素の出典に現れない O- も渡し、裁定済みの O-RS-001 は渡さない")
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
        self.assertIn("flow-framer:3b-reframe:rework", fixed["labels"])
        self.assertEqual(fixed["result"]["status"], "done")
        broken = run({**spec, "flow_findings_at": {"3b-reframe": 1, "3b-reframe-rework": 1}})
        self.assertEqual(sum(1 for l in broken["labels"] if l.startswith("flow-framer:3b-reframe")), 1 + 1)
        self.assertFalse(has(broken["labels"], "verifier:3bv"))
        self.assertEqual((broken["result"]["status"], broken["result"]["next_args"]["from"]), ("blocked", "3b"))

    def test_flowを書く権限の無いresolverがflowを変えたら止まる(self):
        g0 = self._g0()
        cases = (
            ({"args": g0["next_args"], "ruled_at": {"3a": ["RS-001"]}, "questions_at": {"3a": ["RS-002"], "3b": ["RS-002"]}, "flow_sha_at": {"3b": "f-evil"}}, "resolver:3b"),
            ({"args": args(), "flow_open": 1, "ruled_at": {"3": ["RS-001"]}, "flow_sha_at": {"3": "f-evil"}}, "resolver:3"),
            ({"args": args(), "findings": {"crossDoc:r1": [{"id": "r1-cd-all-001", "route": "decision"}]}, "ruled_at": {"6": ["RS-011"]}, "flow_sha_at": {"6": "f-evil"}}, "resolver:6"),
        )
        for spec, label in cases:
            with self.subTest(label=label):
                r = run(spec)
                self.assertIn("この呼び出しでは flow.json を書かない", self._prompt(r, label))
                res = r["result"]
                self.assertEqual((res["status"], res["next_args"], len(res["integrity"])), ("blocked", None, 1))

    def test_入口で問いだったIDは差し戻し後も落ちたら問いに戻す(self):
        fail = [{"id": "RS-002", "kind": "insufficient_grounds", "reason": "組み直した flow からは言えない"}]
        r = run({"args": self._g0()["next_args"], "ruled_at": {"3a": ["RS-001"], "3b": ["RS-002"], "3b'": ["RS-002"]}, "questions_at": {"3a": ["RS-002"], "3b-convert": ["RS-002"]},
                 "verifier_fail": {"3bv": fail, "3bv'": fail}})
        self.assertIn("RS-002 → question（insufficient_grounds）", self._prompt(r, "resolver:3b-convert"))
        self.assertEqual((r["result"]["status"], r["result"]["question_ids"]), ("needs_answers", ["RS-002"]))

    def test_settleで生まれた組の問いも同じG0_2で聞く(self):
        spec = {"args": self._g0()["next_args"], "ruled_at": {"3a": ["RS-001"], "3b": ["RS-005"]}, "about": {"RS-005": {"open": "O-020"}},
                "open_ids_at": {"3b-reframe": ["O-020"]}, "open_only_at": {"3bv": [{"el": "F-030", "open": "O-020"}]},
                "pair_keys_at": {"3b-settle": ["pair:D-001|F-030"]}, "questions_at": {"3b-settle-pairs": ["RS-006"]}}
        r = run(spec)
        self.assertNotIn("question ではなく hold", self._prompt(r, "resolver:3b-settle-pairs"))
        self.assertEqual((r["result"]["status"], r["result"]["question_ids"]), ("needs_answers", ["RS-006"]))

    def test_settleの後に回答待ちの問いの形を検査し直す(self):
        # 段 3: RS-001 は合格して settle が走り、RS-002 は G0 で聞く問いとして残っている。
        spec = {"args": args(), "flow_open": 1, "ruled_at": {"3": ["RS-001"]}, "questions_at": {"3": ["RS-002"]},
                "open_only_at": {"3v": [{"el": "F-091", "open": "O-RS-001"}]}}
        r = run(spec)
        self.assertIn("--ids RS-002 --check", self._prompt(r, "flow-framer:3-settle"))
        self.assertNotIn("resolver:3-settle-questions", r["labels"])
        self.assertEqual(r["result"]["question_ids"], ["RS-002"])
        fixed = run({**spec, "bad_questions_at": ["3-settle"]})
        self.assertIn("--ids RS-002 --check", self._prompt(fixed, "resolver:3-settle-questions"))
        self.assertEqual(fixed["result"]["status"], "needs_answers")
        broken = run({**spec, "bad_questions_at": ["3-settle", "3-settle-questions"]})["result"]
        self.assertEqual((broken["status"], broken["next_args"]["from"]), ("blocked", "3"))

    def test_resolverの返り値はflow_checkを必ず持つ(self):
        r = run({"args": args(), "flow_open": 1, "ruled_at": {"3": ["RS-001"]}})
        self.assertIn("flow_check", r["resolverSchema"]["required"])

    def test_段3bの途中で止まっても段の頭から再開できる(self):
        g0 = self._g0()
        spec = {"ruled_at": {"3a": ["RS-001"]}, "questions_at": {"3a": ["RS-002"], "3b": ["RS-003"]}}
        whole = run({**spec, "args": g0["next_args"]})["result"]
        for stop in ("flow-framer:3b-reframe", "resolver:3b", "verifier:3bv"):
            with self.subTest(stop=stop):
                stopped = run({**spec, "args": g0["next_args"], "null_labels": [stop, f"{stop}#retry"]})["result"]
                self.assertEqual((stopped["status"], stopped["next_args"]["from"]), ("blocked", "3b"))
                again = run({**spec, "args": stopped["next_args"]})
                self.assertIsNone(again["error"], again["error"])
                self.assertEqual(again["labels"][:2], ["flow-check:3b-entry", "flow-framer:3b-reframe"])
                # resolutions_sha256 は stub が run ごとに数え直す値なので比べない。
                drop = lambda st: {k: v for k, v in st.items() if k != "resolutions_sha256"}
                self.assertEqual(drop(again["result"]["next_args"]["state"]), drop(whole["next_args"]["state"]))


NEEDS_ANSWERS = re.compile(r"needsAnswers\('([^']+)'")
FUNCTION = re.compile(r"^(?:async )?function (\w+)")


@unittest.skipIf(shutil.which("node") is None, "node が無い環境ではスキップする")
class Gates(unittest.TestCase):
    """needs_answers になる経路は G0（段 3）・G0-2（段 3b）・G1（段 6）の 3 つだけ。"""

    def test_needs_answersを返す呼び出しの場所を列挙する(self):
        src = PRD.read_text(encoding="utf-8")
        self.assertEqual(src.count("finish('needs_answers'"), 1)
        calls, fn = set(), None
        for line in src.splitlines():
            m = FUNCTION.match(line)
            fn = m.group(1) if m else fn
            calls |= {(fn, g) for g in NEEDS_ANSWERS.findall(line)}
        self.assertEqual(calls, {("stage3", "g0"), ("stage3b", "g0-2"), ("stage6", "g1")})

    def test_3パス目以降の段6の問いもゲートにせず保持規則にする(self):
        findings = new_item_each_round(3)
        findings["grounding:r3"][0]["route"] = "decision"
        r = run({"args": args(), "findings": findings, "questions_at": {"6": ["RS-020"]}})
        self.assertEqual([l for l in r["labels"] if l.startswith("resolver:6")], ["resolver:6", "resolver:6-hold"], "段 6 は 3 パス目で初めて起動する")
        self.assertEqual(r["result"]["status"], "done")
        self.assertIn("RS-020", r["result"]["holds"])


@unittest.skipIf(shutil.which("node") is None, "node が無い環境ではスキップする")
class Convergence(unittest.TestCase):
    """改稿と監査は収束の条件で回し、改稿で直らない項目は経路を変える（段 R6）。"""

    KEY = "requirements/x#PR-X-001"

    DIRECTIONS = ["remove", "make_measurable", "choose_one", "align_terms", "add_trace"]

    def _recurring(self, rounds, extra=None, **kw):
        # r1 の決定が要る指摘を段 6 が RS-010 で裁定し、同じ項目に r2 以降も毎回違う向きの blocking が出続ける（裁定の再出ではない）。
        findings = {"crossDoc:r1": [{"id": "r1-cd-all-001", "route": "decision", "direction": self.DIRECTIONS[0]}]}
        for k in range(2, rounds + 1):
            findings[f"grounding:r{k}"] = [{"id": f"r{k}-gr-requirements__x-001", "direction": self.DIRECTIONS[k - 1]}] + (extra or {}).get(k, [])
        rulings = {f"RS-01{k}": {"finding": f"r{k + 1}-gr-requirements__x-001" if k else "r1-cd-all-001"} for k in range(rounds)}
        return run({"args": args(), "findings": findings, "ruled_seq_at": {"6": [[rs] for rs in rulings]}, "about": rulings, **kw})

    def test_再発した項目は段6に前の指摘と裁定が渡りwriterに回らない(self):
        r = self._recurring(2)
        self.assertEqual(r["result"]["status"], "done")
        self.assertEqual(r["result"]["item_routes"], {self.KEY: "decision"})
        second = nth_prompt(r, "resolver:6", 1)
        self.assertIn(f"再発した項目（項目: 前のパスの指摘 ← その裁定）: {self.KEY}: r1-cd-all-001 ← RS-010", second)
        self.assertIn("route が decision の指摘 r2-gr-requirements__x-001", second)
        self.assertNotIn("r2-gr-requirements__x-001", nth_prompt(r, "writer:U-1:revise", 1))

    def test_decisionの後の再発はholdを指示しholdの後は尽きてno_progressで止まる(self):
        r = self._recurring(3)
        self.assertIn("再発が続いた項目の指摘（hold にする）: r3-gr-requirements__x-001", nth_prompt(r, "resolver:6", 2))
        self.assertEqual(r["result"]["item_routes"], {self.KEY: "hold"})
        stuck = self._recurring(4)
        res = stuck["result"]
        self.assertEqual((res["status"], res["stop_reason"], res["item_routes"], res["passes"]), ("blocked", "no_progress", {self.KEY: "exhausted"}, 3))
        self.assertIn("resolver:final", stuck["labels"])
        self.assertEqual(res["remaining_blocking"], ["r4-gr-requirements__x-001"])
        self.assertIn(f"尽きた項目: {self.KEY}", res["reason"])
        self.assertIsNone(res["next_args"])

    def test_尽きた項目があっても新しいTBDがあれば進展なしにしない(self):
        res = self._recurring(4, new_tbd_revise=["TBD-X-001"])["result"]
        self.assertEqual((res["stop_reason"], res["item_routes"]), ("pass_limit", {self.KEY: "exhausted"}), "新しい TBD は段 6 が閉じうる")

    def test_改稿に回すものが無いままblockingが残ればdoneにせずno_progressで止まる(self):
        r = run({"args": args(), "findings": {"crossDoc:r1": [{"id": "r1-cd-all-001", "route": "decision"}]}})
        res = r["result"]
        self.assertEqual((res["status"], res["stop_reason"], res["remaining_blocking"]), ("blocked", "no_progress", ["r1-cd-all-001"]), "段 6 が何も裁定しなかった")
        self.assertFalse(has(r["labels"], "writer:U-1:revise"))
        self.assertIn("resolver:final", r["labels"])

    def test_尽きた項目の指摘は監査されなくても残り次のパスで消えない(self):
        # PR-X-001 は r4 で尽き、同じ r4 の PR-X-002 で 4 パス目に進む。4 パス目の改稿は PR-X-002 だけを変え、r5 は何も出さない。
        seq = [["PR-X-001"], ["PR-X-001"], ["PR-X-001"], ["PR-X-002"]]
        r = self._recurring(4, extra={4: [{"id": "r4-gr-requirements__x-002", "item_id": "PR-X-002"}]},
                            writer_changed_seq=seq, diff={f"r{i + 2}": c for i, c in enumerate(seq)})
        res = r["result"]
        self.assertEqual((res["status"], res["stop_reason"], res["passes"]), ("blocked", "no_progress", MAX_AUDIT_PASSES))
        self.assertEqual(res["remaining_blocking"], ["r4-gr-requirements__x-001"])
        self.assertIn(f"尽きた項目: {self.KEY}", res["reason"])

    def _exhausted_cd(self, seq, diff, r5=None):
        # r1〜r4 の crossDoc が PR-X-001 に毎回違う向きの blocking を出して尽き、r4 の PR-X-002 で 4 パス目に進む。
        findings = {"crossDoc:r1": [{"id": "r1-cd-all-001", "route": "decision", "direction": self.DIRECTIONS[0]}]}
        for k in range(2, 5):
            findings[f"crossDoc:r{k}"] = [{"id": f"r{k}-cd-all-001", "direction": self.DIRECTIONS[k - 1]}]
        findings["grounding:r4"] = [{"id": "r4-gr-requirements__x-002", "item_id": "PR-X-002"}]
        findings.update(r5 or {})
        rulings = {f"RS-01{k}": {"finding": f"r{k + 1}-cd-all-001"} for k in range(4)}
        return run({"args": args(), "findings": findings, "ruled_seq_at": {"6": [[rs] for rs in rulings]}, "about": rulings,
                    "writer_changed_seq": seq, "diff": diff})["result"]

    def test_尽きた項目は指摘を出した役が再監査して指摘しなければ落ちる(self):
        seq = [["PR-X-001"]] * 3 + [["PR-X-001", "PR-X-002"]]
        res = self._exhausted_cd(seq, {f"r{i + 2}": c for i, c in enumerate(seq)})
        self.assertEqual((res["status"], res["item_routes"]), ("done", {self.KEY: "exhausted"}))

    def test_尽きた項目は指摘を出した役が再監査しなければ他の役が監査しても落ちない(self):
        # 4 パス目の申告は PR-X-002 だけで、PR-X-001 の変更は申告に無い。追加の監査は implementer と grounding で（grounding は PR-X-001 に別の指摘を出す）、crossDoc は見ていない。
        seq = [["PR-X-001"]] * 3 + [["PR-X-002"]]
        diff = {f"r{i + 2}": c for i, c in enumerate(seq)}
        diff["r5"] = ["PR-X-001", "PR-X-002"]
        other = {"grounding:r5:requirements/x:extra": [{"id": "r5-grx-requirements__x-001", "blocking": False}]}
        res = self._exhausted_cd(seq, diff, other)
        self.assertEqual((res["status"], res["stop_reason"], res["remaining_blocking"]), ("blocked", "no_progress", ["r4-cd-all-001"]))
        self.assertEqual(res["carried_blocking"], ["r4-cd-all-001"], "最後のパスの監査が出した指摘ではない")

    def test_doc_checkのblockingだけが残るときは上限まで回す(self):
        fixed = run({"args": args(), "findings": {"implementer:r1": [{"id": "r1-im-requirements__x-001"}]}, "doc_blocking_at": {"r2": 1}})["result"]
        self.assertEqual((fixed["status"], fixed["passes"]), ("done", 2), "doc_check が増えても 1 パス目で進展なしにしない")
        stuck = run({"args": args(), "findings": {"implementer:r1": [{"id": "r1-im-requirements__x-001"}]},
                     "doc_blocking_at": {f"r{k}": 1 for k in range(1, MAX_AUDIT_PASSES + 2)}})["result"]
        self.assertEqual((stuck["status"], stuck["stop_reason"], stuck["passes"], stuck["doc_blocking"]), ("blocked", "pass_limit", MAX_AUDIT_PASSES, 1))
        self.assertIn("パスが上限", stuck["reason"])

    def _reraise(self, r3, writer_changed_seq=None, r1_writer=False):
        # r1 の tighten を段 6 が RS-010 で裁定して合格し、1 パス目の改稿がそれを PR-X-001 に当てた。r2・r3 の監査が同じ向きで指摘し直す。
        findings = {
            "crossDoc:r1": [{"id": "r1-cd-all-001", "route": "decision", "direction": "tighten"}],
            "grounding:r2": [{"id": "r2-gr-requirements__x-001", "direction": "tighten"}, {"id": "r2-gr-requirements__x-002", "item_id": "PR-X-002"}],
            "grounding:r3": r3,
        }
        if r1_writer:
            findings["implementer:r1"] = [{"id": "r1-im-requirements__x-001"}]
        spec = {"args": args(), "findings": findings, "ruled_seq_at": {"6": [["RS-010"]]}, "about": {"RS-010": {"finding": "r1-cd-all-001"}}}
        seq = writer_changed_seq or [["PR-X-001"], ["PR-X-002"]]
        return run({**spec, "writer_changed_seq": seq, "diff": {f"r{i + 2}": c for i, c in enumerate(seq)}})

    def test_既裁定の再出は再発にもblockingにも数えずnoticesに出す(self):
        r = self._reraise([{"id": "r3-gr-requirements__x-001", "direction": "tighten"}])
        res = r["result"]
        self.assertEqual((res["status"], res["item_routes"]), ("done", {}), "2 回続けて再出しても数えない")
        self.assertEqual([n for n in res["notices"] if "既裁定の再出" in n],
                         ["監査 r2: 既裁定の再出（再発に数えない）: r2-gr-requirements__x-001 ← RS-010",
                          "監査 r3: 既裁定の再出（再発に数えない）: r3-gr-requirements__x-001 ← RS-010"])
        self.assertNotIn("r2-gr-requirements__x-001", nth_prompt(r, "writer:U-1:revise", 1))
        turned = self._reraise([{"id": "r3-gr-requirements__x-001", "direction": "relax"}])
        self.assertEqual(turned["result"]["item_routes"], {}, "r2 の再出は blocking に数えていないので、r3 は再発ではない")
        self.assertIn("route が decision の指摘 r3-gr-requirements__x-001", nth_prompt(turned, "resolver:6", 1), "再出と逆向きの指摘は裁定に逆らうので writer に回さない")
        self.assertFalse(any("r3-gr-requirements__x-001" in x["prompt"] for x in turned["prompts"] if x["label"].startswith("writer:")))
        bundled = self._reraise([], r1_writer=True)["result"]
        self.assertEqual(bundled["item_routes"], {self.KEY: "decision"}, "同じパスで writer の指摘も渡した項目の変更は、裁定を当てただけとは言えない")

    def test_前のパスの再出だけが持つ裁定の項目が変わった後の同じ向きの指摘はblockingにする(self):
        # RS-010 は 1 パス目に渡し終えた。2 パス目の改稿が PR-X-001 を変える（doc_check の直し・申告に無い変更・別の項目の指摘の改稿）。
        spec = {"args": args(), "ruled_seq_at": {"6": [["RS-010"]]}, "about": {"RS-010": {"finding": "r1-cd-all-001"}},
                "findings": {"crossDoc:r1": [{"id": "r1-cd-all-001", "route": "decision", "direction": "tighten"}],
                             "grounding:r2": [{"id": "r2-gr-requirements__x-001", "direction": "tighten"}, {"id": "r2-gr-requirements__x-002", "item_id": "PR-X-002"}],
                             "grounding:r3": [{"id": "r3-gr-requirements__x-001", "direction": "tighten"}]}}
        declared = [["PR-X-001"], ["PR-X-001", "PR-X-002"]]
        r3 = spec["findings"]["grounding:r3"]
        extra_r3 = {**spec["findings"], "grounding:r3": [], "grounding:r3:requirements/x:extra": [{**r3[0], "id": "r3-grx-requirements__x-001"}]}
        for name, extra, found in (
            ("doc_check の直し", {"writer_changed_seq": declared, "diff": {"r2": declared[0], "r3": declared[1]}, "doc_blocking_at": {"r2": 1}}, r3[0]["id"]),
            ("申告に無い変更", {"writer_changed_seq": [["PR-X-001"], ["PR-X-002"]], "diff": {"r2": ["PR-X-001"], "r3": ["PR-X-001", "PR-X-002"]}, "doc_blocking_at": {"r2": 1},
                                "findings": extra_r3}, "r3-grx-requirements__x-001"),
            ("別の項目の指摘の改稿", {"writer_changed_seq": declared, "diff": {"r2": declared[0], "r3": declared[1]}}, r3[0]["id"]),
        ):
            with self.subTest(name):
                r = run({**spec, **extra})
                res = r["result"]
                self.assertEqual((res["status"], res["passes"]), ("done", 3))
                self.assertFalse(any(found in n for n in res["notices"]), res["notices"])
                self.assertIn(found, nth_prompt(r, "writer:U-1:revise", 2))
        same = run({**spec, "writer_changed_seq": [["PR-X-001"], ["PR-X-002"]], "diff": {"r2": ["PR-X-001"], "r3": ["PR-X-002"]}, "doc_blocking_at": {"r1": 1}})["result"]
        self.assertIn("監査 r2: 既裁定の再出（再発に数えない）: r2-gr-requirements__x-001 ← RS-010", same["notices"],
                      "裁定を渡したパスの変更は、doc_check の直しと混ざっていても裁定を当てたのと見分けられないので再出にする")

    def test_当て損ねて持ち越した指摘を段6が裁定して当てた後の同じ向きの指摘は再出にする(self):
        # r1 の writer の指摘を 1 パス目の改稿が当て損ね、r2 で再発して decision に回り、2 パス目の段 6 が RS-010 で裁定して同じパスの改稿が当てる。
        spec = {"args": args(), "ruled_seq_at": {"6": [["RS-010"]]}, "about": {"RS-010": {"finding": "r1-im-requirements__x-001"}},
                "findings": {"implementer:r1": [{"id": "r1-im-requirements__x-001", "direction": "tighten"}],
                             "implementer:r3": [{"id": "r3-im-requirements__x-001", "direction": "tighten"}]},
                "unapplied_seq": [["r1-im-requirements__x-001"]], "writer_changed_seq": [["PR-X-001"]] * 3}
        res = run(spec)["result"]
        self.assertEqual((res["status"], res["passes"]), ("done", 2), res.get("reason"))
        self.assertIn("監査 r3: 既裁定の再出（再発に数えない）: r3-im-requirements__x-001 ← RS-010", res["notices"])

    def test_再出した項目を後で監査する監査役に前の裁定のIDを渡す(self):
        r = self._reraise([], [["PR-X-001"], ["PR-X-001"]])
        self.assertIn("同じ項目への前のパスの指摘を裁定した resolution: RS-010", nth_prompt(r, "grounding:r3:requirements/x", 0))

    def test_毎パスの監査がdoc_checkの差し戻しで3から1から0に進めば通り3から3で止まる(self):
        fixed = run({"args": args(), "plan_findings": {"intake": 3, "intake:rework": 1, "intake:rework-2": 0}})
        self.assertEqual(fixed["labels"][:5], ["flow-check:1-entry", "intake", "intake:rework", "intake:rework-2", "flow-framer"])
        self.assertEqual(fixed["result"]["status"], "done")
        stuck = run({"args": args(), "plan_findings": {"intake": 3, "intake:rework": 3, "intake:rework-2": 0}})
        self.assertEqual(stuck["labels"], ["flow-check:1-entry", "intake", "intake:rework"])
        self.assertEqual((stuck["result"]["status"], stuck["result"]["next_args"]["from"]), ("blocked", "1"))
        framed = run({"args": args(), "flow_findings_at": {"framer": 3, "rework": 1, "rework-2": 0}})
        self.assertEqual([l for l in framed["labels"] if l.startswith("flow-framer")], ["flow-framer", "flow-framer:rework", "flow-framer:rework-2"])
        self.assertEqual(framed["result"]["status"], "done")

    def _settle(self, counts):
        # 段 3 が RS-001〜003 で閉じた O- を引く要素が、settle の回ごとに counts の数だけ残る。
        els = [{"el": f"F-09{i}", "open": f"O-RS-00{i}"} for i in range(1, 4)]
        keys = ["3v-settle"] + [f"3v-settle-{n}" for n in range(2, len(counts) + 1)]
        return run({"args": args(), "flow_open": 1, "ruled_at": {"3": ["RS-001", "RS-002", "RS-003"]},
                    "open_only_at": {"3v": els, **{k: els[:c] for k, c in zip(keys, counts)}}})

    def test_settleは残りが減る間はMAX_SETTLE_ROUNDSまで回り減らなければ止まる(self):
        rounds = const("MAX_SETTLE_ROUNDS")
        verifiers = lambda r: [l for l in r["labels"] if l.startswith("verifier:3v-settle")]
        ok = self._settle([2, 1, 0])
        self.assertEqual(verifiers(ok), ["verifier:3v-settle", "verifier:3v-settle-2", "verifier:3v-settle-3"])
        self.assertIn("F-091", nth_prompt(ok, "flow-framer:3-settle-2", 0))
        self.assertEqual(ok["result"]["status"], "done")
        limit = self._settle([3, 2, 1, 0])
        self.assertEqual(len(verifiers(limit)), rounds)
        self.assertEqual(limit["result"]["status"], "blocked")
        stuck = self._settle([2, 2, 0])
        self.assertEqual(verifiers(stuck), ["verifier:3v-settle", "verifier:3v-settle-2"])
        self.assertEqual((stuck["result"]["status"], stuck["result"]["next_args"]["from"]), ("blocked", "3"))

    def _questions_rework(self, **kw):
        stale = [{"el": "F-002", "ref": "D-001"}]
        return run({"args": args(), "flow_open": 1, "questions_at": {"3": ["RS-001"]}, "bad_questions_at": ["3"],
                    "supersedes_at": {"3-questions": ["D-001"]}, "stale_refs_at": {"3-questions": stale}, "unverified_at": {"3-settle": ["F-002"]}, **kw})

    def test_問いの形の差し戻しで覆された決定を引く要素は後のverifierのstdoutでsettleする(self):
        # 差し戻しの resolver の後に verifier が doc_check flow を実行するので、settle はその resolver の申告を読まずに verifier の stdout で決まる。
        stale = [{"el": "F-002", "ref": "D-001"}]
        r = self._questions_rework(stale_refs_at={"3-questions": stale, "3v": stale})
        labels = [l for l in r["labels"] if l.startswith(("resolver:", "verifier:", "flow-framer:", "flow-check:"))]
        self.assertEqual(labels[:6], ["flow-check:1-entry", "resolver:3", "resolver:3-questions", "verifier:3v", "flow-framer:3-settle", "verifier:3v-settle"])
        self.assertIn("F-002 ← D-001", nth_prompt(r, "flow-framer:3-settle", 0))
        self.assertEqual(r["result"]["status"], "needs_answers")
        # 過大申告: 3-questions の stdout だけが stale_refs を出し、後の verifier（3v）の世界には無い。
        told = self._questions_rework()
        self.assertFalse(has(told["labels"], "flow-framer:3-settle"), "resolver だけが申告した stale_refs では settle しない")

    def test_出口のsettleの後は同じ段のsettleがその後のflowを見て同じ要素を写し直さない(self):
        stale = [{"el": "F-002", "ref": "D-001"}]
        vam = [{"id": "RS-001", "kind": "value_as_method", "reason": "r"}]
        r = run({"args": args(), "flow_open": 1, "ruled_at": {"3": ["RS-001"], "3'": ["RS-001"]}, "verifier_fail": {"3v": vam, "3v'": vam},
                 "questions_at": {"3-convert": ["RS-001"]}, "bad_questions_at": ["3-convert"], "supersedes_at": {"3-convert-questions": ["D-001"]},
                 "stale_refs_at": {"3-convert": stale, "3-convert-questions": stale}, "unverified_at": {"3-settle": ["F-002"]}})
        self.assertIn("resolver:3-convert-questions", r["labels"])
        self.assertEqual([l for l in r["labels"] if l.startswith("flow-framer:")], ["flow-framer:3-settle"])
        self.assertEqual(r["result"]["status"], "needs_answers")

    def _settle_each_pass(self, **kw):
        # 段 6 が毎パス O- を閉じ、その O- を引く要素を settle が直す。
        about = {"RS-010": {"finding": "r1-cd-all-001"}, "RS-011": {"finding": "r2-gr-requirements__x-001"}}
        findings = {"crossDoc:r1": [{"id": "r1-cd-all-001", "route": "decision", "direction": "remove"}],
                    "grounding:r2": [{"id": "r2-gr-requirements__x-001", "direction": "make_measurable"}]}
        spec = {"args": args(), "findings": findings, "ruled_seq_at": {"6": [["RS-010", "RS-090"], ["RS-011", "RS-091"]]}, "about": about,
                "open_only_at": {"6v": [{"el": "F-091", "open": "O-RS-090"}, {"el": "F-092", "open": "O-RS-091"}]},
                "writer_changed_seq": [["PR-X-001"], ["PR-X-001"]], "diff": {"r2": ["PR-X-001"], "r3": ["PR-X-001"]}}
        spec.update(kw)
        return run(spec)

    def test_settleのlabelはパスと再開で変わらない(self):
        whole = self._settle_each_pass()
        settles = lambda r: [l for l in r["labels"] if "settle" in l]
        self.assertEqual(settles(whole), ["flow-framer:6-settle", "verifier:6v-settle"] * 2)
        stopped = self._settle_each_pass(null_labels=["grounding:r2:requirements/x", "grounding:r2:requirements/x#retry"])["result"]
        resumed = self._settle_each_pass(args=stopped["next_args"], ruled_seq_at={"6": [["RS-011", "RS-091"]]})
        self.assertEqual(resumed["result"]["status"], "done")
        self.assertEqual(settles(resumed), ["flow-framer:6-settle", "verifier:6v-settle"])

    def test_settleの中の差し戻しの出口ではsettleを入れ子にしない(self):
        spec = {"args": args(), "flow_open": 1, "ruled_at": {"3": ["RS-001"]}, "questions_at": {"3": ["RS-002"]},
                "open_only_at": {"3v": [{"el": "F-091", "open": "O-RS-001"}]}, "bad_questions_at": ["3-settle"],
                "supersedes_at": {"3-settle-questions": ["D-001"]}, "stale_refs_at": {"3-settle-questions": [{"el": "F-002", "ref": "D-001"}]}}
        r = run(spec)
        self.assertIn("resolver:3-settle-questions", r["labels"])
        self.assertFalse(any("settle-settle" in l for l in r["labels"]), r["labels"])


# NEXT_ARGS_MAX_CHARS: 司令塔が打ち直す next_args の上限（json.dumps(ensure_ascii=False) の字数）。根拠は 2026-09-27 の試走の
# G1 の next_args のうち flow 以外が 6,998 字だったこと。後の段が state を増やしても上げない（増えた分は ID・件数・digest に絞る）。
NEXT_ARGS_MAX_CHARS = 8_000
# 見ていないもの: 項目が NextArgsBudget.ITEMS_N を超える規模と、文書・単位が 2 つ以上の形。項目の数のほかの件数（問い・resolution・
# D- の合格・当て損ね・項目ごとの指摘と flow 要素）は NextArgsBudget の fixture で固定しているので、それが増えた形も見ていない。


@unittest.skipIf(shutil.which("node") is None, "node が無い環境ではスキップする")
class NextArgsBudget(unittest.TestCase):
    """試走の G1 の規模（問い 13・resolution 28・D- の合格 55・単位 1）で項目を ITEMS_N まで増やし、stray 100 件と
    SIZE_OVER のある snapshot を通ってから、G0・G0-2・G1 と段 8 で止まった next_args が上限に収まる。"""

    DOC = "requirements/cleanup-branches"
    # SKILL_DIR: next_args の skillDir は install 先のパスで、字数に入る。checkout の場所で測ると、置き場所ごとに境界が動く。
    SKILL_DIR = "/Users/someone/.claude/plugins/cache/yoshiysh-claude-plugins/workflow/10.10.10/skills/prd-spec"
    # ITEMS_N: 上限に収まる項目の数の境界。ITEMS_N で収まり ITEMS_N + 1 の段 8 の最悪の形で超えることを両方確かめるので、
    # next_args の増減が境界をまたげば落ちる。1 項目分に満たない増減は落ちないので、再開で読まない値が載っていないことは
    # _assert_lean が欄ごとに見る。
    ITEMS_N = 19
    UNAPPLIED = 7

    @staticmethod
    def _rs(a, b):
        return [f"RS-{i:03d}" for i in range(a, b + 1)]

    def _item(self, i):
        return f"PR-CLEANUP-BRANCHES-{i:03d}"

    def _writer(self, k, item):
        return {"id": f"r1-im-requirements__cleanup-branches-{k:03d}", "doc": self.DOC, "item_id": item, "route": "writer"}

    def _writer_items(self, n):
        # 試走の実データの偏り: writer の指摘は最後の項目以外に 1 件ずつ、先頭 5 項目には 2 件ずつ。最後の項目には decision の指摘 3 件。
        return [self._item(i) for i in range(1, n) for _ in range(2 if i <= 5 else 1)]

    def _common(self, n):
        decision = lambda k: {"id": f"r1-cd-all-{k:03d}", "doc": self.DOC, "item_id": self._item(n), "route": "decision"}
        return {"units": [{"id": "U-1", "docs": [self.DOC], "depends_on": []}], "long_digests": True, "stray_at": {"r1": 100}, "size_over_at": {"r1": 2},
                "doc_flow_refs": {self.DOC: {self._item(i): [f"F-{10 * i + j:03d}" for j in range(3)] for i in range(1, n + 1)}},
                "findings": {"implementer:r1": [self._writer(k + 1, it) for k, it in enumerate(self._writer_items(n))], "crossDoc:r1": [decision(k) for k in (1, 2, 3)]},
                "routes_at": {"6": [{"id": f"RT-{i:03d}", "unit": "U-1"} for i in range(1, 4)]}}

    def _args(self, **kw):
        return args(skillDir=self.SKILL_DIR, **kw)

    def _chars(self, next_args):
        """段の token（state.tx）を、その next_args の段（from）の再実行の最悪の形にした字数。再実行を重ねると try と restore が伸び、
        flow を書く段では tx.flow（止まった run が最後に照合を通した flow の digest）が付く。段 8 は flow を書かないので付かない
        （RerunFromTheSameStage.test_flowを書かない段の再実行はtx_flowを運ばない）。"""
        tx = next_args["state"]["tx"]
        stage = next_args["from"]
        worst = {**tx, "stage": stage, "try": 9, "restore": f"t{tx['seq']}r8", **({} if stage == "8" else {"flow": "f" * 64})}
        return len(json.dumps({**next_args, "state": {**next_args["state"], "tx": worst}}, ensure_ascii=False))

    def _gates(self, a, n):
        rs, common = self._rs, self._common(n)
        units = common["units"]
        g0 = run({"args": a, "units": units, "flow_open": 1, "long_digests": True, "ruled_at": {"3": rs(1, 12)}, "questions_at": {"3": rs(13, 21)},
                  "verifier_extra_pass": {"3v": [f"D-{i:03d}" for i in range(1, 56)]}})["result"]
        g02 = run({"args": g0["next_args"], "units": units, "long_digests": True, "ruled_at": {"3a": rs(13, 21)}, "questions_at": {"3a": ["RS-022"]}})["result"]
        g1 = run({"args": g02["next_args"], **common, "ruled_at": {"3a": ["RS-022"], "6": rs(26, 28)}, "questions_at": {"6": rs(23, 25)}})["result"]
        return g0, g02, g1

    def _stage8(self, entry, n, unapplied):
        # G1 の回答を当て、改稿の後の監査役が応答しない。existing は段 5 が settled_written を空にするので、全 resolution を改稿に渡す。
        a = self._args() if entry == "new" else self._args(entry="existing", existing_docs=[{"key": self.DOC, "fixed": False}])
        g1 = self._gates(a, n)[2]
        auditor = f"grounding:r2:{self.DOC}"
        ids = [self._writer(k + 1, it)["id"] for k, it in enumerate(self._writer_items(n))][:unapplied]
        res = run({"args": g1["next_args"], **self._common(n), "ruled_at": {"3a'": self._rs(23, 25)}, "null_labels": [auditor, auditor + "#retry"], "unapplied_seq": [ids]})["result"]
        self.assertEqual((res["status"], res["next_args"]["from"]), ("blocked", "8"), res.get("reason"))
        self.assertEqual(res["next_args"]["state"]["revised"]["unapplied"], ids)
        self._assert_lean(res["next_args"]["state"])
        return self._chars(res["next_args"])

    def _size(self, res):
        self.assertEqual(res["status"], "needs_answers", res.get("reason"))
        self._assert_lean(res["next_args"]["state"])
        return self._chars(res["next_args"])

    def _assert_lean(self, state):
        # 段 2 より後の next_args には、再開で読まない値（段を過ぎた plan_sha256・D- の合格）が無い。
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
        self.assertEqual((len(flow), {len(v) for v in flow.values()}), (self.ITEMS_N - 1, {3}))
        self.assertEqual(len(state["units"]), 1)
        self.assertTrue(any("100 件" in n for n in state["notices"]) and any("SIZE_BUDGET" in n for n in state["notices"]), state["notices"])
        for gate, res in (("G0", g0), ("G0-2", g02), ("G1", g1)):
            with self.subTest(gate=gate):
                self.assertLess(self._size(res), NEXT_ARGS_MAX_CHARS)

    def test_最後のパスの途中で止まったnext_argsも上限に収まる(self):
        # 3 項目が毎パス再発して尽きるまで経路を変え、別の項目にも毎パス blocking が出て進む。最後のパスの監査役が応答しない。
        units = [{"id": "U-1", "docs": [self.DOC], "depends_on": []}]
        items = [f"PR-CLEANUP-BRANCHES-{i:03d}" for i in range(1, 4)]
        finding = lambda k, n, item: {"id": f"r{k}-gr-requirements__cleanup-branches-{n:03d}", "doc": self.DOC, "item_id": item}
        findings = {}
        for k in range(1, MAX_AUDIT_PASSES + 1):
            role = "implementer" if k == 1 else "grounding"
            findings[f"{role}:r{k}"] = [finding(k, n + 1, it) for n, it in enumerate(items)] + [finding(k, 10 + k, f"PR-CLEANUP-BRANCHES-1{k:02d}")]
        auditor = f"grounding:r{MAX_AUDIT_PASSES + 1}:{self.DOC}"
        res = run({"args": self._args(), "units": units, "long_digests": True, "findings": findings, "null_labels": [auditor, f"{auditor}#retry"]})["result"]
        self.assertEqual((res["status"], res["next_args"]["from"]), ("blocked", "8"), res.get("reason"))
        state = res["next_args"]["state"]
        self.assertEqual(state["pass"], MAX_AUDIT_PASSES)
        self.assertEqual(state["item_routes"], {f"{self.DOC}#{it}": "exhausted" for it in items})
        self.assertLess(self._chars(res["next_args"]), NEXT_ARGS_MAX_CHARS)

    def test_段8で裁定を持って止まったnext_argsも上限に収まる(self):
        # 改稿が writer の指摘のうち UNAPPLIED 件を当て損ねた形も見る（当て損ねは次のパスへ持ち越す）。
        for entry in ("new", "existing"):
            for unapplied in (0, self.UNAPPLIED):
                with self.subTest(entry=entry, unapplied=unapplied):
                    self.assertLess(self._stage8(entry, self.ITEMS_N, unapplied), NEXT_ARGS_MAX_CHARS)

    def _stage6(self, entry, n):
        # 2 パス目の監査が decision の指摘を出し、段 6 の resolver が応答しない。段 6 は flow を書く段なので、最悪の tx は tx.flow を持つ。
        a = self._args() if entry == "new" else self._args(entry="existing", existing_docs=[{"key": self.DOC, "fixed": False}])
        g1 = self._gates(a, n)[2]
        common = self._common(n)
        decision = [{"id": f"r2-gr-requirements__cleanup-branches-{k:03d}", "doc": self.DOC, "item_id": self._item(k), "route": "decision"} for k in (1, 2, 3)]
        ids = [self._writer(k + 1, it)["id"] for k, it in enumerate(self._writer_items(n))][:self.UNAPPLIED]
        res = run({"args": g1["next_args"], **common, "findings": {**common["findings"], "grounding:r2": decision}, "ruled_at": {"3a'": self._rs(23, 25)},
                   "null_labels": ["resolver:6", "resolver:6#retry"], "unapplied_seq": [ids]})["result"]
        self.assertEqual((res["status"], res["next_args"]["from"], res["next_args"]["state"]["pass"]), ("blocked", "6", 2), res.get("reason"))
        self._assert_lean(res["next_args"]["state"])
        return self._chars(res["next_args"])

    def test_段8が境界を決める最悪の段である(self):
        # 境界（ITEMS_N + 1 で超える）は段 8 でだけ測る。tx.flow を持つ段 6 の再実行（2 パス目）が段 8 より大きければ、境界は段 6 が決める。
        for entry in ("new", "existing"):
            with self.subTest(entry=entry):
                self.assertLessEqual(self._stage6(entry, self.ITEMS_N + 1), self._stage8(entry, self.ITEMS_N + 1, self.UNAPPLIED))

    def test_項目がITEMS_Nを超えると段8の最悪の形は上限を超える(self):
        self.assertGreaterEqual(self._stage8("existing", self.ITEMS_N + 1, self.UNAPPLIED), NEXT_ARGS_MAX_CHARS)


# 段ごとに、その段を通るシナリオと、その段で最初に起動する agent の label。
STAGE_CASES = {
    "1": ({}, "intake"),
    "2": ({}, "flow-framer"),
    "3": ({"flow_open": 1, "ruled_at": {"3": ["RS-001"]}}, "resolver:3"),
    "4": ({}, "flow-check:4-backup"),
    "5": ({}, "implementer:r1:requirements/x"),
    "6": ({"findings": {"crossDoc:r1": [{"id": "r1-cd-all-001", "route": "decision", "blocking": False}]}, "ruled_at": {"6": ["RS-010"]}}, "resolver:6"),
    "7": ({"findings": {"implementer:r1": [{"id": "r1-im-requirements__x-001", "blocking": False}]}}, "flow-check:7-backup"),
    "8": ({"findings": {"implementer:r1": [{"id": "r1-im-requirements__x-001", "blocking": False}]}}, "grounding:r2:requirements/x"),
}


@unittest.skipIf(shutil.which("node") is None, "node が無い環境ではスキップする")
class EveryEntry(unittest.TestCase):
    """各 from の入口で、要る値が next_args.state から得られることを実際に走らせて確かめる。

    その段の最初の agent を応答させずに blocked にし、返った next_args を変えずに渡すと done まで進むこと。
    REQUIRES は手で書いた表なので、値が抜けていると再開は blocked ではなく TypeError で落ちる。
    """

    def _recover(self, spec, label, stage):
        broken = run({**spec, "null_labels": [label, f"{label}#retry"]})
        self.assertIsNone(broken["error"], broken["error"])
        res = broken["result"]
        self.assertEqual(res["status"], "blocked", res)
        self.assertEqual(res["next_args"]["from"], stage)
        again = run({**{k: v for k, v in spec.items() if k != "args"}, "args": res["next_args"]})
        self.assertIsNone(again["error"], again["error"])
        self.assertEqual(again["labels"][:2], [f"flow-check:{stage}-entry", label], "段 1 の入口は W を S0 の直後に戻し、段 2 の入口は段の控えを戻し、段 3 以降の入口は W を読み直す")
        return again["result"]

    def test_各段から再開できる(self):
        for stage, (extra, label) in STAGE_CASES.items():
            with self.subTest(stage=stage):
                self.assertEqual(self._recover({"args": args(), **extra}, label, stage)["status"], "done")

    def test_段9から再開すると誰も起動せずにdoneになる(self):
        r = run({"args": args(**{"from": "9", "state": {"units": [{"id": "U-1", "docs": ["requirements/x"], "depends_on": []}], "tree_digest": "t2"}})})
        self.assertIsNone(r["error"], r["error"])
        self.assertEqual(r["labels"], [])
        self.assertEqual((r["result"]["status"], r["result"]["report_path"], r["result"]["tree_digest"]), ("done", "/tmp/prd-w/report.md", "t2"))

    def test_回答の反映の段から再開できる(self):
        g0 = run({"args": args(), "flow_open": 1, "questions_at": {"3": ["RS-001"]}})["result"]
        done = self._recover({"args": g0["next_args"], "ruled_at": {"3a": ["RS-001"]}}, "resolver:3a", "3a")
        self.assertEqual(done["status"], "done")
        done = self._recover({"args": g0["next_args"], "ruled_at": {"3a": ["RS-001"]}}, "flow-framer:3b-reframe", "3b")
        self.assertEqual(done["status"], "done")
        spec = {"args": args(), "findings": {"crossDoc:r1": [{"id": "r1-cd-all-001", "route": "decision"}]}, "questions_at": {"6": ["RS-010"]}}
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

    def test_budgetのtotalがnullかbudgetが無ければ影響しない(self):
        for kw in ({"budget": {"total": None}}, {}):
            with self.subTest(kw=kw):
                self.assertEqual(run({"args": args(), **kw})["result"]["status"], "done")

    def test_budgetが段の途中か境界で尽きたら止まりnext_argsで続けてdoneになる(self):
        spec = {"flow_open": 1, "ruled_at": {"3": ["RS-001"]}, "findings": {"implementer:r1": [{"id": "r1-im-requirements__x-001"}]}}
        full = run({"args": args(), **spec})["labels"]
        # 段の途中（逐次の呼び出し・並列の 2 体目）と、段の境界（段 5 の最初の起動の前）。
        cases = (("段 3 の verifier の前", full.index("verifier:3v"), "3", True), ("段 5 の並列の 2 体目", full.index("grounding:r1:requirements/x"), "5", True),
                 ("段 5 の入口", full.index("implementer:r1:requirements/x"), "5", False))
        for name, n, stage, mid in cases:
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

    def test_agentを呼ぶ場所は1つだけ(self):
        code = "\n".join(l for l in PRD.read_text(encoding="utf-8").split("\n") if not l.strip().startswith("//"))
        self.assertEqual(len(re.findall(r"(?<![\w.])agent\(", code)), 1, "budget の確かめ（call）を通らない agent() を作らない")

    def test_文字列のargsは止める(self):
        r = run({"args": json.dumps(args())})
        self.assertIn("JSON の値", r["error"])
        self.assertEqual(r["labels"], [])

    def test_追加の監査役は指名された監査役の返り値だけを待って起動する(self):
        spec = {"args": args(), "findings": {"implementer:r1": [{"id": "r1-im-requirements__x-001", "blocking": False}]},
                "writer_changed": ["PR-X-001"], "diff": {"r2": ["PR-X-001", "PR-X-009"]}, "hold_until_extra": "implementer:r2:requirements/x"}
        r = run(spec)
        self.assertEqual(r["result"]["status"], "done", r["result"].get("reason"))
        self.assertFalse(r["heldTimeout"], "他の監査役の返りを待ってから追加の監査役を起動した")

    def test_追加の監査の対象を打ち切って見せたら残りの件数を書く(self):
        items = [f"PR-X-{i:03d}" for i in range(1, 9)]
        r = run({"args": args(), "findings": {"implementer:r1": [{"id": "r1-im-requirements__x-001", "blocking": False}]}, "writer_changed": ["PR-X-001"], "diff": {"r2": items}})
        line = next(l for l in r["logs"] if "申告に無い変更" in l)
        self.assertIn("ほか 2 件（全件は返り値の undeclared）", line)
        self.assertEqual(r["result"]["undeclared"], {"requirements/x": items[1:]})

    def test_role_optsはfableと完全なmodelIDとinheritを受ける(self):
        opts = {"writer": {"model": "fable"}, "crossDoc": {"model": "claude-opus-5-5"}, "grounding": {"model": "inherit", "effort": "low"}}
        r = run({"args": args(role_opts=opts), "inherit_labels": ["grounding:"]})
        self.assertIsNone(r["error"], r["error"])
        self.assertEqual(r["result"]["status"], "done")
        self.assertEqual(r["opts"]["writer:U-1:draft"]["model"], "fable")
        self.assertEqual(r["opts"]["crossDoc:r1:all"]["model"], "claude-opus-5-5")
        self.assertEqual(r["opts"]["grounding:r1:requirements/x"], {"model": None, "effort": "low"}, "inherit はセッションの model を継承させる")
        for bad in ("gpt-5", "claude opus"):
            with self.subTest(bad=bad):
                self.assertIn("model が不正", run({"args": args(role_opts={"writer": {"model": bad}})})["error"])

    def test_headerは役に依らない行を先頭に同じ文字列で並べる(self):
        r = run({"args": args(), "flow_open": 1, "ruled_at": {"3": ["RS-001"]}, "findings": {"implementer:r1": [{"id": "r1-im-requirements__x-001"}]}})
        heads = {"\n".join(p["prompt"].split("\n")[:3]) for p in r["prompts"]}
        self.assertEqual(heads, {f"W（workspace）: /tmp/prd-w\nSKILL_DIR: {SKILL}\nentry: new"})
        roles = {p["label"].split(":")[0] for p in r["prompts"]}
        self.assertLessEqual({"intake", "flow-framer", "resolver", "verifier", "writer", "implementer", "grounding", "crossDoc", "flow-check"}, roles)

    def test_existing_docsのキーの形とfixedを検査してからコマンドに埋め込む(self):
        for doc in ({"key": "requirements/x; rm -rf ~", "fixed": False}, {"key": "requirements/x"}, {"key": "notes/x", "fixed": True}, "requirements/x"):
            with self.subTest(doc=doc):
                r = run({"args": args(entry="existing", existing_docs=[doc])})
                self.assertIn("args.existing_docs", r["error"])
                self.assertEqual(r["labels"], [])

    def test_DOC_KEYはdoc_checkの文書のキーの形と同じ(self):
        self.assertEqual(value("DOC_KEY.source"), _exported("m.DOC_KEY.source"))

    def test_段4と7の再実行は止まったrunが書いた文書の本文も段に入った時点へ戻す(self):
        # writer は本文を Edit で書き doc_check を通らないので、writer の前の backup の控えを入口の restore が戻す。
        units = [{"id": "U-1", "docs": ["requirements/x"], "depends_on": []}, {"id": "U-2", "docs": ["requirements/y"], "depends_on": []}]
        fs = {"implementer:r1:requirements/x": [{"id": "r1-im-requirements__x-001"}]}
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
                labels = again["labels"]
                self.assertLess(labels.index(f"flow-check:{stage}-backup"), min(i for i, l in enumerate(labels) if l.startswith("writer:")))

    def test_本文の控えのstdoutが無ければwriterを起動しない(self):
        r = run({"args": args(), "no_backup_at": ["flow-check:4-backup"]})
        res = r["result"]
        self.assertEqual((res["status"], res["next_args"]["from"]), ("blocked", "4"), res.get("reason"))
        self.assertFalse(has(r["labels"], "writer:"))
        self.assertIn("doc_check backup", res["reason"])

    def test_intakeの単位の文書のキーの形を検査する(self):
        r = run({"args": args(), "units": [{"id": "U-1", "docs": ["requirements/x --token t9"], "depends_on": []}]})
        res = r["result"]
        self.assertEqual((res["status"], res["next_args"]["from"]), ("blocked", "1"), res.get("reason"))
        self.assertIn("文書のキーの形", res["reason"])

    # 段 7 の入口（reconcile）の後に verifier の起動しない経路で、W の ruling と合否を state に写すこと。W は所有表の外で書き換える。
    def _stopped_at_7(self):
        spec = {"flow_open": 1, "ruled_at": {"3": ["RS-001"]}, "findings": {"implementer:r1": [{"id": "r1-im-requirements__x-001"}]}, "world": self.world}
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

if __name__ == "__main__":
    unittest.main()
