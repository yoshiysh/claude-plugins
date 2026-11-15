#!/usr/bin/env node
// 台帳を書く唯一の口。init → next →（Workflow）→ ingest を繰り返し、next が止まる条件を返したら終わる。
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  C, MAX_ATTEMPTS, addEvent, calibration, coverage, currentFindings, decide, estimate, goalIds, goalSources, lensVersion, needPlan, newLedger, openCycle, planAnswerKinds,
  phaseEvents, rangeHash, rangeText, readGoalFiles, refresh, releaseClaims, retroAssets, sha, splitAssets, startPhase, submitRead, submitVerify, withBlocks,
} from './ledger-core.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WORKFLOW = path.join(HERE, 'coverage-audit.js')

class Fail extends Error { constructor(msg, extra = {}) { super(msg); this.extra = extra } }
const MULTI = ['target']
const KNOWN = {
  init: ['state', 'goal', 'request', 'decisions', 'criteria', 'goal-checked', 'target', 'constraints', 'lenses', 'roles', 'seeds', 'k', 'max-cycles', 'max-agents-total', 'phase'],
  reframe: ['state', 'goal', 'request', 'decisions', 'criteria', 'constraints', 'target', 'phase'],
  next: ['state'], ingest: ['state', 'result'], status: ['state'], hint: ['state', 'text'], answer: ['state', 'id', 'text', 'file'], config: ['state', 'max-cycles', 'max-agents-total', 'workers'],
  claim: ['state', 'call', 'worker'], submit: ['state', 'call', 'cell', 'worker', 'result'],
}
function parse(argv) {
  const o = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) { o._.push(a); continue }
    const k = a.slice(2)
    const v = argv[i + 1]
    if (v === undefined || v.startsWith('--')) throw new Fail(`--${k} に値が無い`)
    i++
    if (MULTI.includes(k)) (o[k] = o[k] || []).push(v)
    else o[k] = v
  }
  const known = KNOWN[o._[0]]
  if (known) for (const k of Object.keys(o)) if (k !== '_' && !known.includes(k)) throw new Fail(`${o._[0]} が受け付けない引数: --${k}`)
  return o
}
const read = (p) => readFileSync(p, 'utf8')
const need = (o, k) => { if (!o[k]) throw new Fail(`--${k} が要る`); return o[k] }
// 数の引数は正の整数だけを受け付ける（NaN・0・小数・指数表記で上限や k が壊れた台帳を作らない）。
function posInts(o, keys) {
  const out = {}
  for (const [k, ck] of keys) {
    if (o[k] === undefined) continue
    if (!/^[1-9]\d*$/.test(o[k]) || !Number.isSafeInteger(Number(o[k]))) throw new Fail(`--${k} は正の整数: ${o[k]}`)
    out[ck] = Number(o[k])
  }
  return out
}
const ledgerPath = (dir) => path.join(dir, 'ledger.json')
function load(dir) {
  if (!existsSync(ledgerPath(dir))) throw new Fail(`台帳が無い: ${ledgerPath(dir)}（init を先に流す）`)
  const L = JSON.parse(read(ledgerPath(dir)))
  if (!L.goal || !Array.isArray(L.goal.items)) throw new Fail(`台帳の形式が古い（目標の項目と引用を持たない）: ${ledgerPath(dir)}。goal.md などを 1 行 1 件・引用つきに直し、新しい stateDir で init からやり直す`)
  if (!Number.isInteger(L.plan_seq)) throw new Fail(`台帳の形式が古い（計画の欠陥の id の連番を持たない）: ${ledgerPath(dir)}。新しい stateDir で init からやり直す`)
  if (!Array.isArray(L.lens_reviewed) || !Array.isArray(L.dropped_lenses)) throw new Fail(`台帳の形式が古い（観点の精査の記録を持たない）: ${ledgerPath(dir)}。新しい stateDir で init からやり直す`)
  if (!Number.isInteger(L.call_seq) || !Number.isInteger(L.config && L.config.workers)) throw new Fail(`台帳の形式が古い（review の待ち行列の通し番号と worker の数を持たない）: ${ledgerPath(dir)}。新しい stateDir で init からやり直す`)
  if (!L.phase_start || !L.phase_records || L.phase === undefined) throw new Fail(`台帳の形式が古い（段の記録を持たない）: ${ledgerPath(dir)}。新しい stateDir で init からやり直す`)
  return L
}
function writeAtomic(file, text) {
  mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, text)
  renameSync(tmp, file)
}
// 台帳を書くコマンドは、load から save までを stateDir/ledger.lock で囲む（並べて動く worker の claim・submit を直列にする）。
// lock は openSync の wx で取る。取れなければ短く眠って取り直し、LOCK_WAIT_MS を超えたら Fail にする（生きた lock は消さない）。
// mtime が LOCK_STALE_MS より前の lock は、落ちた process が残したものとして消してから取り直す。
const LOCK_WAIT_MS = 10000
const LOCK_STALE_MS = 60000
const LOCK_SLEEP_MS = 20
const nap = new Int32Array(new SharedArrayBuffer(4))
function withLock(dir, fn) {
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'ledger.lock')
  const t0 = Date.now()
  let fd = null
  while (fd === null) {
    try { fd = openSync(file, 'wx') } catch (e) {
      if (e.code !== 'EEXIST') throw e
      let age = null
      try { age = Date.now() - statSync(file).mtimeMs } catch (e2) { if (e2.code === 'ENOENT') continue; throw e2 }
      if (age > LOCK_STALE_MS) { rmSync(file, { force: true }); continue }
      if (Date.now() - t0 >= LOCK_WAIT_MS) throw new Fail(`台帳の lock を ${LOCK_WAIT_MS / 1000} 秒待っても取れない: ${file}（他の process が台帳を書いている。終わってから流し直す）`)
      Atomics.wait(nap, 0, 0, LOCK_SLEEP_MS)
    }
  }
  try {
    writeSync(fd, String(process.pid))
    closeSync(fd)
    return fn()
  } finally {
    rmSync(file, { force: true })
  }
}
// 書き込みは一時ファイルからの rename で 1 回に行う（途中で落ちても壊れた台帳を残さない）。
function save(dir, L) {
  L.rev += 1
  writeAtomic(ledgerPath(dir), JSON.stringify(L, null, 1))
}
const hints = (dir) => {
  const f = path.join(dir, 'hints.jsonl')
  return existsSync(f) ? read(f).split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []
}

// 写し: 担当が読む内容を stateDir/snap/ に内容の hash の名前で置く（同じ内容は同じファイル。call_id が決まる前に書ける）。
// 既にあるファイルの中身が名前の hash と違えば（書き換わった写し）書き直す。書き直さないと ingest の拒否から抜けられない。
const snapDir = (dir) => path.join(dir, 'snap')
function writeSnap(dir, text) {
  const name = sha(text).slice(0, 16)
  const file = path.join(snapDir(dir), `${name}.txt`)
  if (!existsSync(file) || sha(read(file)).slice(0, 16) !== name) writeAtomic(file, text)
  return file
}
// args の参照は写しのファイル名だけにする（stateDir の長い絶対 path を args に 1 回だけ載せ、Workflow source が結合する）。
const wholeRef = (file, text) => { const end = text.split('\n').length; return { snapshot: path.basename(file), start: 1, end, hash: rangeHash(text, 1, end) } }
// 対象の共通の基準ディレクトリ（末尾に区切りを付ける）。args の資産・枡の id と path はここからの相対にし、基準は 1 回だけ載せる。
// 台帳の id は絶対 path のまま（持ち越しの台帳を壊さない）。共通の先頭が無ければ空にして相対にしない。
function targetBase(files) {
  const parts = files.map((f) => path.dirname(f).split(path.sep))
  if (!parts.length) return ''
  let n = 0
  while (parts.every((p) => n < p.length && p[n] === parts[0][n])) n++
  const d = parts[0].slice(0, n).join(path.sep)
  return !n ? '' : d.endsWith(path.sep) ? d : d + path.sep
}
const short = (base, s) => (base && s.startsWith(base) ? s.slice(base.length) : s)

// 対象のファイルを今の内容で資産にし、同じ内容を写しに書く。消えた・読めない対象は返す（枡 0 件で完了にしない）。
function currentAssets(L, dir) {
  const missing = []
  const assets = []
  for (const f of L.targets) {
    if (!existsSync(f)) { missing.push(f); continue }
    const text = read(f)
    const snap = writeSnap(dir, text)
    assets.push(...splitAssets(f, text).map((a) => ({ ...a, snap })))
  }
  return { assets, missing }
}

// 段の名前（呼ぶ側の段。coverage-build は baseline・design・impl・review を渡す）。status の phases の key になる。
function phaseOf(o) {
  if (o.phase === undefined) return null
  if (!/^[a-z][a-z0-9_-]*$/.test(o.phase)) throw new Fail(`--phase は英小文字で始まる英小文字・数字・_・- の名前: ${o.phase}`)
  return o.phase
}
// 目標の冒頭の文・依頼文・決定の記録・基準・制約のファイルを読む（init と reframe で同じ形）。
function frameText(o) {
  return {
    goal: read(need(o, 'goal')).trim(), request: read(need(o, 'request')).trim(), decisions: o.decisions ? read(o.decisions).trim() : null,
    criteria: o.criteria ? read(o.criteria) : '', constraints: o.constraints ? read(o.constraints) : '',
  }
}

function cmdInit(o) {
  const dir = path.resolve(need(o, 'state'))
  if (existsSync(ledgerPath(dir))) throw new Fail(`台帳が既にある: ${ledgerPath(dir)}（持ち越すときは next を流す）`)
  const abs = (p) => path.resolve(p)
  const targets = (o.target || []).map(abs)
  if (!targets.length) throw new Fail('--target が要る')
  const missing = targets.filter((p) => !existsSync(p))
  if (missing.length) throw new Fail('読めない対象がある（台帳は作っていない。直して init をやり直す）', { stop: 'blocked', cause: 'input', missing })
  const lenses = o.lenses ? JSON.parse(read(o.lenses)) : []
  for (const l of lenses) if (!l.id || !l.name || !l.procedure || C.RESERVED_LENSES.includes(l.id)) throw new Fail(`観点の形が不正: ${JSON.stringify(l)}`)
  const roles = { ...JSON.parse(read(path.join(HERE, 'roles.json'))), ...(o.roles ? JSON.parse(read(o.roles)) : {}) }
  const config = posInts(o, [['k', 'k'], ['max-cycles', 'max_cycles'], ['max-agents-total', 'max_agents_total']])
  // 照合済みの印: coverage-build が目標を照合して渡したときだけ付く。付いていれば目標の照合（引用の照合と照合役）を流さない。
  const checkedBy = o['goal-checked'] ?? null
  if (checkedBy !== null && checkedBy !== 'coverage-build') throw new Fail(`--goal-checked は coverage-build だけ（目標を照合したスキル）: ${checkedBy}`)
  const phase = phaseOf(o)
  const text = frameText(o)
  const g = readGoalFiles(text, { checkedBy })
  if (g.problems.length) throw new Fail('目標・基準・制約に、引用の照合を通らない項目がある（台帳は作っていない。直して init をやり直す）', { problems: g.problems })
  const L = newLedger({
    goal: text.goal, goalItems: g.goal, checkedBy, phase, request: text.request, decisions: text.decisions, criteria: g.criteria, constraints: g.constraints,
    targets, lenses, config, roles, seeds: o.seeds ? JSON.parse(read(o.seeds)).map((s) => ({ ...s, path: abs(s.path) })) : [],
  })
  checkWorkers(L.config)
  withLock(dir, () => {
    if (existsSync(ledgerPath(dir))) throw new Fail(`台帳が既にある: ${ledgerPath(dir)}（持ち越すときは next を流す）`)
    save(dir, L)
  })
  return { ok: true, state: dir, phase, targets: targets.length, criteria: L.criteria.length, constraints: L.constraints.length, goal_checked_by: checkedBy, hint: `ヒントは node ${path.join(HERE, 'ledger-cli.mjs')} hint --state ${dir} --text "..." で足せる（実行中も止まっている間も）` }
}

// reframe: 既にある台帳の目標の冒頭の文・目標・基準・制約・依頼文・決定の記録・対象と段を差し替える（台帳と置き場は 1 つのまま）。
// 照合済みの印（coverage-build が目標を照合して渡した台帳）のある台帳だけを受け、印は残す。印の無い台帳の目標は answer で直す。
// 出ていく段の status の節を phase_records に写し、全ての枡を読み直しにして計画から作り直す（中身が同じでも読み直す）。
function cmdReframe(o) {
  const dir = path.resolve(need(o, 'state'))
  return withLock(dir, () => {
    const L = load(dir)
    if (!L.goal.checked_by) throw new Fail('照合済みの印の無い台帳は reframe できない（目標・基準・制約は answer で直す）')
    if (!L.phase) throw new Fail('段の記録の無い台帳は reframe できない（--phase を付けて init からやり直す）')
    const phase = phaseOf(o)
    if (!phase) throw new Fail('--phase が要る')
    const targets = (o.target || []).map((p) => path.resolve(p))
    if (!targets.length) throw new Fail('--target が要る')
    const missing = targets.filter((p) => !existsSync(p))
    if (missing.length) throw new Fail('読めない対象がある（台帳は変えていない）', { stop: 'blocked', cause: 'input', missing })
    const text = frameText(o)
    const g = readGoalFiles(text, { checkedBy: L.goal.checked_by })
    if (g.problems.length) throw new Fail('目標・基準・制約に、引用の照合を通らない項目がある（台帳は変えていない）', { problems: g.problems })
    const from = L.phase
    L.phase_records[from] = phaseSection(L)
    Object.assign(L, { goal: { ...L.goal, text: text.goal, items: g.goal, problems: [] }, request: text.request, decisions: text.decisions, criteria: g.criteria, constraints: g.constraints, targets })
    startPhase(L, phase)
    save(dir, L)
    return { ok: true, state: dir, from, phase, targets: targets.length, criteria: L.criteria.length, constraints: L.constraints.length, next: 'next を流す（計画から作り直し、全ての枡を読み直す）' }
  })
}

// args には担当が読む文（目標・基準・制約・依頼文・決定の記録・ヒント・回答・前の計画・欠陥・観点の手続き・束ねる指摘）を載せない。
// 文は呼び出しごとの束（brief）の写しに書き、args には写しの参照（path・行の範囲・hash）と、id・件数・設定だけを載せる。
const goalLines = (t) => String(t).split('\n').map((l) => `    ${l}`).join('\n')
const itemLines = (xs) => xs.map((c) => `  - ${c.id}: ${c.text}`).join('\n') || '  - なし'
function commonBrief(L, unread) {
  return `# 依頼の束（coverage-audit）
## 固定した目標（変えない。constraint_map の対象ではない）
${goalLines(L.goal.text)}
## 目標の項目（観点の goals で id を指し、part に本文の部分を逐語で引く）
${itemLines(L.goal.items)}
## 受け入れ基準（満たすかを確かめる。id で指す）
${itemLines(L.criteria)}
## 固定した制約（変えない。id で指す）
${itemLines(L.constraints)}
${unread.length ? `## 利用者のヒント（取り込む）\n${unread.map((h) => `- [${h.id}] ${h.text}`).join('\n')}\n` : ''}`
}
const briefRef = (dir, text) => wholeRef(writeSnap(dir, text), text)
const targetAssetIds = (L) => Object.keys(L.assets).filter((id) => !L.assets[id].retro)
// 計画の観点の goals が指す項目（目標と受け入れ基準。制約は constraint_map で受ける）。id の並びと、part を照らす本文。
const goalItems = (L) => [...L.goal.items, ...L.criteria]
const goalItemIds = (L) => goalItems(L).map((c) => c.id)
const goalTexts = (L) => Object.fromEntries(goalItems(L).map((c) => [c.id, c.text]))
// 計画の欠陥を足す。id は台帳の連番の P<n> で、統合をやり直して欠陥を戻しても前の番号を使い回さない（answer --id P<n> で指す）。
function addPlanDefect(L, d) {
  L.plan_seq += 1
  L.plan_defects.push({ id: `P${L.plan_seq}`, ...d })
}
// 持ち越しで資産が変わる（節が足される・見出しが変わる）と、計画の applies_to・excluded が実在しない資産を指すか、どちらにも入らない資産が出る。
// 枡を読む前に計画の欠陥として統合役に戻す。同じ欠陥は重ねない（同じ状態の next が同じ呼び出しを返すように）。
// 持ち越しは新しいやり直しの契機なので、欠陥を足したときはやり直しの数を戻す（前の run で上限に達した台帳が、答える先の無い needs_input で止まらないように）。
function checkCarriedPlan(L) {
  if (!needPlan(L) || !L.plan) return
  let added = 0
  for (const x of C.checkAppliesTo(L.plan.lenses, targetAssetIds(L), L.plan.excluded)) {
    if (L.plan_defects.some((d) => d.kind === 'static' && d.claim === x)) continue
    addPlanDefect(L, { unit_id: '', kind: 'static', claim: x, quote: '' })
    addEvent(L, 'plan', 'static_problem', x)
    added++
  }
  if (added) L.plan_rounds = 0
}
// 対象の索引: 1 行 1 資産で「資産の id・写しのファイル・行の範囲・見出し」（計画役・統合役・束ね役が資産の id を選ぶ）。
// 計画役の索引: 1 行 1 資産の 6 欄（id・写し・範囲・見出しの経路・種類・先頭の数語）。経路の無い資産は経路の欄を空にする。
// 先頭の数語は norm した本文の先頭から取る。欄の中にタブを残さない。
const INDEX_HEAD_WORDS = 8
const INDEX_HEAD_CHARS = 40
function indexRef(L, dir) {
  const texts = new Map()
  const textOf = (f) => { if (!texts.has(f)) texts.set(f, read(f)); return texts.get(f) }
  const cell = (s) => String(s ?? '').replace(/\t/g, ' ')
  const head = (a) => Array.from(C.norm(rangeText(textOf(a.snap), a.start, a.end)).split(' ').slice(0, INDEX_HEAD_WORDS).join(' ')).slice(0, INDEX_HEAD_CHARS).join('').trim()
  return briefRef(dir, Object.entries(L.assets).filter(([, a]) => !a.retro).map(([id, a]) => [id, a.snap, `${a.start}-${a.end}`, (a.trail || []).join(' > '), a.kind, head(a)].map(cell).join('\t')).join('\n'))
}
// review の worker の行: 回（pass）ごとに、読む役と検証役の待ち行列へ config.workers 体ずつ。役は p 回目が reader_p・verifier_p、無ければ reader_1・verifier。
const workerRole = (L, base, p) => (base === 'reader' ? (L.roles[`reader_${p}`] ? `reader_${p}` : 'reader_1') : L.roles[`verifier_${p}`] ? `verifier_${p}` : 'verifier')
function workerRows(L) {
  const out = []
  for (let p = 1; p <= L.config.k; p++) {
    for (const [queue, base, tag] of [['read', 'reader', 'r'], ['verify', 'verifier', 'v']]) {
      for (let i = 1; i <= L.config.workers; i++) out.push({ id: `${tag}${p}-${i}`, role: workerRole(L, base, p), pass: p, queue })
    }
  }
  return out
}
// 1 回の review の起動数（2 × k × workers）を maxAgents に収める。
function checkWorkers(config) {
  const n = 2 * config.k * config.workers
  if (n > C.LIMITS.maxAgents) throw new Fail(`review の 1 回の起動数 2 × k(${config.k}) × workers(${config.workers}) = ${n} が上限 maxAgents ${C.LIMITS.maxAgents} を超える（--workers を下げる）`)
}
function buildArgs(L, d, dir, unread) {
  const roles = Object.fromEntries(Object.entries(L.roles).map(([k, r]) => [k, { model: r.model, effort: r.effort }]))
  const tb = targetBase(L.targets)
  const base = { skillDir: path.dirname(HERE), stage: d.step, roles, criteriaIds: L.criteria.map((c) => c.id), constraintIds: L.constraints.map((c) => c.id), snapDir: snapDir(dir) + path.sep, targetBase: tb }
  const common = commonBrief(L, unread)
  if (d.step === 'plan') {
    const answers = L.answers.filter((a) => !L.answered.includes(a.id) && planAnswerKinds.includes(a.target_kind))
    const integrates = needPlan(L) && (!L.plan || L.plan_defects.length || answers.length)
    let index = null
    let lensIndex = null
    let units = []
    let reviewUnits = []
    let assetIds = null
    if (integrates) {
      assetIds = targetAssetIds(L).map((id) => short(tb, id))
      index = indexRef(L, dir)
    } else {
      // 統合し直さないときは、前の計画のうち精査を終えていない観点（reviewUnits）と検証済みでない観点（units）を、観点ごとの束で渡す。
      // args には観点の id・当てた資産の id・他の観点の id・goals の id だけを載せ、手続きと part の本文は束に入れる。
      // 精査役と検証役は、当てた資産の行を索引の写し（lensIndex）から読む。行の番号は assetIds の位置で決まる。
      const lenses = (L.plan && L.plan.lenses) || []
      const pick = (u) => JSON.stringify({ id: u.id, name: u.name, procedure: u.procedure })
      reviewUnits = lenses.filter((u) => !L.lens_reviewed.includes(u.id)).map((u) => {
        const others = lenses.filter((x) => x.id !== u.id)
        return { unit_id: u.id, key: C.unitKey(u), applies_to: (u.applies_to || []).map((id) => short(tb, id)), others: others.map((x) => x.id), brief: briefRef(dir, `${common}\n### 精査する観点\n${pick(u)}\n### 他の計画の観点（1 行 1 観点）\n${others.map(pick).join('\n') || '（無し）'}\n`) }
      })
      units = lenses.filter((u) => !L.verified_units.includes(C.unitKey(u)))
        .map((u) => ({ unit_id: u.id, key: C.unitKey(u), goals: (Array.isArray(u.goals) ? u.goals : []).map((g) => g && g.id), applies_to: (u.applies_to || []).map((id) => short(tb, id)), brief: briefRef(dir, `${common}\n### 本文（観点）\n${C.unitText(u)}\n`) }))
      if (reviewUnits.length || units.length) { assetIds = targetAssetIds(L).map((id) => short(tb, id)); lensIndex = indexRef(L, dir) }
    }
    // 束は役ごとに分け、各役にはその役が要る文だけを渡す（計画役・観点の検証役に前の欠陥や依頼文を見せない）。
    // brief: 共通の前提だけ（計画役・最初の統合役・この呼び出しで統合した観点の検証役）。goalBrief: 依頼文と決定の記録（目標の照合役）。
    // againBrief: 前の計画・欠陥・回答（見直しの統合役）。JSON は 1 行 1 件にして、1 行が長くならないようにする。
    const prevLensIds = ((L.plan && L.plan.lenses) || []).map((u) => u.id)
    const rows = (xs) => `[\n${xs.map((x) => JSON.stringify(x)).join(',\n')}\n]`
    const again = integrates && prevLensIds.length
      ? briefRef(dir, `${common}\n### 前の計画\n${JSON.stringify(L.plan, null, 1)}\n### 欠陥（index は配列の位置）\n${rows(L.plan_defects.map((x, i) => ({ index: i, ...x })))}\n### 利用者の回答\n${rows(answers)}\n`)
      : null
    return {
      ...base, brief: briefRef(dir, common), goalChecked: L.goal.checked, goalItemIds: goalItemIds(L),
      ...(L.goal.checked ? {} : { goalBrief: briefRef(dir, `${common}\n## 依頼文\n${L.request}\n## 決定の記録\n${L.decisions ?? '（無し）'}\n`), goalIds: goalIds(L) }),
      ...(again ? { againBrief: again } : {}), givenLensIds: L.lenses.filter((l) => l.origin === 'user').map((l) => l.id),
      prevLensIds, defectCount: L.plan_defects.length, answerIds: answers.map((a) => a.id), index, units, verifiedKeys: L.verified_units, ...(assetIds ? { assetIds } : {}),
      ...(lensIndex ? { lensIndex } : {}), ...(reviewUnits.length ? { reviewUnits } : {}),
    }
  }
  if (d.step === 'review') {
    // 枡の一覧は載せない（worker が claim で待ち行列から取る）。call_seq で、取りを戻した後や取り込んだ後の呼び出しを前の呼び出しと分ける。
    return { ...base, brief: briefRef(dir, common), call_seq: L.call_seq, workers: workerRows(L) }
  }
  if (d.step === 'group') {
    const found = currentFindings(L).filter((f) => f.verdict === 'confirmed' && f.cycle === L.cycle)
    const keys = C.groupKeys(found.length)
    const text = found.map((f, i) => JSON.stringify({ key: keys[i], finding: f.id, where: L.cells[f.cell].asset, lens: L.cells[f.cell].lens, claim: f.claim, quote: f.quote, severity: f.severity, layer: f.layer })).join('\n')
    return { ...base, brief: briefRef(dir, common), count: found.length, items: found.length ? briefRef(dir, text) : null, index: found.length ? indexRef(L, dir) : null }
  }
  throw new Fail(`未知の段: ${d.step}`)
}

function cmdNext(o) {
  const dir = path.resolve(need(o, 'state'))
  return withLock(dir, () => next(dir))
}
function next(dir) {
  const L = load(dir)
  // blocked（failure）の後の next は、原因を直した再開として扱い、連続の数を戻す。
  if (L.stopped && L.stopped.stop === 'blocked' && L.stopped.cause === 'failure') {
    L.fail_streak = 0
    for (const c of Object.values(L.cells)) if (c.env_attempts) { c.attempts -= c.env_attempts; c.env_attempts = 0; if (c.status === 'disclosed') c.status = 'unseen' }
    for (const [k, n] of Object.entries(L.env_attempts)) { L.attempts[k] -= n; if (L.attempts[k] <= 0) delete L.attempts[k] }
    L.env_attempts = {}
  }
  // 取り込み（ingest）を経ずに来た next: 取られたまま提出されなかった枡を戻し、前の呼び出しと別の呼び出しにする。
  if (releaseClaims(L)) L.call_seq += 1
  const { assets, missing } = currentAssets(L, dir)
  const changes = refresh(L, assets)
  if (!missing.length) checkCarriedPlan(L)
  for (;;) {
    openCycle(L)
    const d = decide(L, { missingTargets: missing })
    if (d.stop) {
      L.stopped = { ...d, cycle: L.cycle }
      L.pending = null
      save(dir, L)
      return { ...d, changes, coverage: coverage(L), next_args: d.stop === 'complete' ? null : { state: dir } }
    }
    // 静的に済む段（振り返りの資産を作る・束ねる物が無い）は agent を起動せずに進める。
    // coverage-build から渡された台帳（照合済みの印）は振り返りの資産を作らない。出来事は status の events で返し、coverage-build の探索グラフが受ける。
    if (d.step === 'retro') {
      if (L.goal.checked_by !== 'coverage-build') {
        const ra = retroAssets(L).map((a) => ({ ...a, snap: writeSnap(dir, a.text) }))
        refresh(L, ra, { partial: true })
      }
      L.retro_cycles.push(L.cycle)
      continue
    }
    const unread = hints(dir).filter((h) => !L.hints_read.includes(h.id))
    const args = buildArgs(L, d, dir, unread)
    if (d.step === 'group' && !args.count) { L.group_cycles.push(L.cycle); continue }
    const callId = sha(JSON.stringify(args)).slice(0, 12)
    args.callId = callId
    args.argsSum = C.argsSum(args)
    const est = estimate(d.step, args)
    const argsPath = path.join(dir, `call-${callId}.json`)
    writeAtomic(argsPath, JSON.stringify(args))
    // review の提出の数は呼び出しごとに数える（同じ呼び出しを返し直す next では数を保つ）。
    const submits = d.step === 'review' ? { submits: L.pending && L.pending.call_id === callId ? L.pending.submits || 0 : 0 } : {}
    L.pending = { call_id: callId, step: d.step, args_path: argsPath, hints: unread.map((h) => h.id), cycle: L.cycle, ...submits }
    save(dir, L)
    return { step: d.step, call_id: callId, workflow: WORKFLOW, args_path: argsPath, estimate_agents: Math.min(est, C.LIMITS.maxAgents), limits: C.LIMITS, cycle: L.cycle, coverage: coverage(L), changes }
  }
}

// args が指す写しを読み、範囲の hash が args と合うかを照らす。合わなければ受け取らない。
function readRef(dir, ref, what) {
  const file = path.resolve(snapDir(dir), String(ref.snapshot))
  if (path.dirname(file) !== snapDir(dir) || !existsSync(file)) throw new Fail(`${what} の写しが stateDir の写しの置き場に無い: ${ref.snapshot}`)
  const text = read(file)
  if (rangeHash(text, ref.start, ref.end) !== ref.hash) throw new Fail(`${what} の写しの hash が args と違う（写しが書き換わった。next からやり直す）: ${ref.snapshot}`)
  return rangeText(text, ref.start, ref.end)
}

function recordCall(L, res, step, failed) {
  const ag = Array.isArray(res.agents) ? res.agents : []
  for (const a of ag) L.agents.push({ call_id: res.call_id, cycle: L.cycle, stage: step, role: a.role, label: a.label, model: a.model, effort: a.effort, ok: !!a.ok })
  L.calls.push({ call_id: res.call_id, cycle: L.cycle, step, agents: ag.length, failed: ag.filter((a) => !a.ok).length, tokens: res.tokens ?? null, tokens_note: res.tokens == null ? '消費量を run の中で読めない経路（runner など）' : 'native budget.spent()' })
  L.fail_streak = failed ? L.fail_streak + 1 : 0
  for (const a of ag) if (!a.ok) addEvent(L, step, 'agent_missing', `${a.label}（${a.model}/${a.effort}）が返らなかったか不正な出力だった`, a.label)
}
// 全ての役が欠けた呼び出しの試行は env_attempts にも数え、blocked（failure）から再開したときに戻す（直して再開した run が即開示しないように）。
let allFailed = false
const bump = (L, k) => {
  L.attempts[k] = (L.attempts[k] || 0) + 1
  if (allFailed) L.env_attempts[k] = (L.env_attempts[k] || 0) + 1
}
const clear = (L, k) => { delete L.attempts[k] }

function ingestPlan(L, res, args) {
  const ctx = { constraintIds: [...L.criteria, ...L.constraints].map((c) => c.id), lensesGiven: args.givenLensIds.length > 0, givenLensIds: args.givenLensIds, assetIds: targetAssetIds(L), goalItemIds: goalItemIds(L), goalTexts: goalTexts(L) }
  // 目標の照合: 照合役が挙げた成果の引用と項目の id を照らし、どの項目にも受け止められていない成果を人間に返す。
  if (!args.goalChecked) {
    const g = res.goal_check
    const p = C.checkGoalMap(g, args.goalIds, goalSources(L))
    if (p.length) { bump(L, 'goal'); addEvent(L, 'plan', 'rejected_goal_check', `目標の照合: ${p.join(' / ')}`) }
    else { clear(L, 'goal'); L.goal.problems = C.goalGaps(g); L.goal.checked = !L.goal.problems.length }
  }
  if (res.status === 'blocked') { bump(L, 'plan'); addEvent(L, 'plan', 'blocked', res.reason || 'plan が止まった'); return }
  // 統合役がこの呼び出しで走ったときだけ、計画を受け取り直す（走らなければ前の計画のまま）。
  if (args.index && res.plan) {
    if (L.plan) L.plan_rounds += 1
    L.plan_defects = []
    L.plan = res.plan
    // 計画を変えたら全体を検証し直す: 統合のたびに全ての観点を精査し直し、落とした観点の記録も今の計画のものにする。
    L.lens_reviewed = []
    L.dropped_lenses = []
    const p = C.checkPlan(res.plan, ctx)
    L.plan_problems = p
    for (const x of p) { addPlanDefect(L, { unit_id: '', kind: 'static', claim: x, quote: '' }); addEvent(L, 'plan', 'static_problem', x) }
    L.answered.push(...args.answerIds)
  }
  // 静的な欠陥のある計画（実在しない資産を当てるなど）には精査を当てない。統合のやり直しで直った計画を精査する。
  if (L.plan && needPlan(L) && !L.plan_defects.some((d) => d.kind === 'static')) applyLensReviews(L, res, ctx)
  const plan = L.plan || { lenses: [], questions: [] }
  const units = new Map((plan.lenses || []).map((u) => [u.id, u]))
  for (const uc of res.unit_checks || []) {
    const u = units.get(uc.unit_id)
    if (!u || uc.key !== C.unitKey(u)) continue // 計画が変わった後の検証は使わない
    // 閉じた問いの答えだけを受け付け、no の答えだけを欠陥にする（自由な欠陥の列挙は受け付けない）。
    const goals = Array.isArray(u.goals) ? u.goals : []
    const p = C.checkUnitVerdict(uc.result, u.id, goals, C.unitText(u))
    if (p.length) { bump(L, `unit:${u.id}`); addEvent(L, 'plan', 'rejected_unit_check', `${u.id}: ${p.join(' / ')}`, u.id); continue }
    clear(L, `unit:${u.id}`)
    const ds = C.unitDefects(uc.result, u.id, goals)
    if (ds.length) for (const d of ds) { addPlanDefect(L, d); addEvent(L, 'plan', 'unit_defect', `${u.id}: ${d.claim}`, u.id) }
    else L.verified_units.push(uc.key)
  }
  // 計画の観点を台帳の観点に写す。変われば枡は古くなる。
  L.lenses = [...L.lenses.filter((l) => l.origin !== 'plan'), ...(plan.lenses || []).map((l) => ({ ...l, origin: 'plan' }))]
  for (const l of L.lenses) l.version = lensVersion(l)
}

// 観点の精査（N1・N2）を照らして計画に当てる。受け付けた精査だけが効き、受け付けなかった精査は試行（attempts:lens:<id>）に数える。
// - N1 の no: その資産を観点の applies_to から外す。どの計画の観点の applies_to にも残らない資産は、理由に N1 を書いて excluded に移す（統合には戻さない）。
//   applies_to が空になった観点は計画から落とし（constraint_map の handled_by からも外す）、dropped_lenses で開示する。
//   落とした観点だけが受け皿だった目標・基準・制約は、外した後の計画の静的な照合の外れとして P<n> の欠陥にし、統合に戻す。
// - N2 の yes: 観点の組ごとに 1 件の P<n> の欠陥にし、統合に戻す（両方向の yes も 1 件）。
function applyLensReviews(L, res, ctx) {
  const plan = L.plan
  const lenses = plan.lenses || []
  const byId = new Map(lenses.map((u) => [u.id, u]))
  const procedures = Object.fromEntries(lenses.map((u) => [u.id, u.procedure]))
  const tb = targetBase(L.targets)
  const full = (id) => (L.assets[id] ? id : `${tb}${id}`)
  const texts = new Map()
  const assetText = (id) => {
    const a = L.assets[id]
    if (!a) return null
    if (!texts.has(a.snap)) texts.set(a.snap, read(a.snap))
    return rangeText(texts.get(a.snap), a.start, a.end)
  }
  const removed = new Map()
  const pairs = []
  for (const lr of res.lens_reviews || []) {
    const u = byId.get(lr.unit_id)
    if (!u || lr.key !== C.unitKey(u) || L.lens_reviewed.includes(u.id)) continue // 計画が変わった後の精査と、精査済みの観点は使わない
    const r = lr.result
    const rep = r && typeof r === 'object' ? { ...r, n1: Array.isArray(r.n1) ? r.n1.map((x) => (x && typeof x === 'object' && typeof x.asset === 'string' ? { ...x, asset: full(x.asset) } : x)) : r.n1 } : r
    const others = lenses.filter((x) => x.id !== u.id).map((x) => x.id)
    const assets = Object.fromEntries((u.applies_to || []).map((id) => [id, assetText(id)]).filter(([, t]) => t != null))
    const p = C.checkLensReview(rep, u, others, { assets, procedures })
    if (p.length) { bump(L, `lens:${u.id}`); addEvent(L, 'plan', 'rejected_lens_review', `${u.id}: ${p.join(' / ')}`, u.id); continue }
    clear(L, `lens:${u.id}`)
    L.lens_reviewed.push(u.id)
    const no = rep.n1.filter((x) => x.answer === 'no').map((x) => x.asset)
    if (no.length) removed.set(u.id, no)
    for (const x of rep.n2) if (x.answer === 'yes') pairs.push({ a: u.id, b: x.lens, quote_self: x.quote_self, quote_other: x.quote_other })
  }
  const dropped = new Set()
  if (removed.size) {
    for (const [id, xs] of removed) {
      const u = byId.get(id)
      u.applies_to = u.applies_to.filter((a) => !xs.includes(a))
      addEvent(L, 'plan', 'lens_n1_removed', `${id}: N1（${C.LENS_QUESTIONS.N1}）の no で ${xs.join(', ')} を applies_to から外した`, id)
      if (!u.applies_to.length) dropped.add(id)
    }
    plan.lenses = lenses.filter((u) => !dropped.has(u.id))
    for (const id of dropped) {
      L.dropped_lenses.push({ id, name: byId.get(id).name, reason: `N1: 当てた資産の全てに、手続きが列挙するものが無い` })
      addEvent(L, 'plan', 'lens_dropped', `${id}: 当てた資産が N1 で全て外れたので計画から落とした`, id)
    }
    for (const m of plan.constraint_map || []) if (Array.isArray(m.handled_by)) m.handled_by = m.handled_by.filter((h) => !dropped.has(h))
    const still = new Set(plan.lenses.flatMap((u) => u.applies_to || []))
    const moved = new Map()
    for (const [id, xs] of removed) for (const a of xs) if (!still.has(a)) moved.set(a, [...(moved.get(a) || []), id])
    plan.excluded = [...(plan.excluded || []), ...[...moved].map(([asset, ids]) => ({ asset, reason: `N1: 観点 ${ids.join('・')} の手続きが列挙するものが、この資産に無い` }))]
    if (dropped.size) for (const x of C.checkPlan(plan, ctx)) {
      addPlanDefect(L, { unit_id: '', kind: 'lens_dropped', dropped: [...dropped], claim: `${x}（観点の精査の N1 で ${[...dropped].join('・')} を落としたため）`, quote: '' })
      addEvent(L, 'plan', 'static_problem', x)
    }
  }
  const seen = new Set(L.plan_defects.filter((d) => d.kind === 'N2').map((d) => d.lenses.join('|')))
  for (const x of pairs) {
    if (dropped.has(x.a) || dropped.has(x.b)) continue
    const key = [x.a, x.b].sort().join('|')
    if (seen.has(key)) continue
    seen.add(key)
    addPlanDefect(L, { unit_id: x.a, kind: 'N2', lenses: [x.a, x.b].sort(), claim: `N2: 観点 ${x.a} と ${x.b} は、同じものを列挙し、同じものと照らす（1 つに併せるか、列挙するものか照らすものを分ける）`, quote: x.quote_self, quote_other: x.quote_other })
    addEvent(L, 'plan', 'unit_defect', `${x.a}: N2 で ${x.b} と重なる`, x.a)
  }
}

// review の取り込み: 枡は submit で 1 つずつ受け付け済み。取られたまま提出されなかった枡を戻し、呼び出しの通し番号を進める。
// 提出が 1 件も無い呼び出しは、全ての役が欠けた呼び出しと同じく環境の失敗に数える（allFailed）。
function ingestReview(L) {
  releaseClaims(L, { env: allFailed })
  L.call_seq += 1
}

function ingestGroup(L, res, args, dir) {
  const ids = readRef(dir, args.items, '束ねの全件').split('\n').map((l) => JSON.parse(l).finding)
  const keys = C.groupKeys(args.count)
  const g = res.grouping
  const p = res.status === 'blocked' ? [res.reason] : C.checkGroups(g, keys, targetAssetIds(L))
  if (p.length) {
    bump(L, `group:${L.cycle}`)
    addEvent(L, 'group', 'rejected_grouping', p.join(' / '))
    return
  }
  clear(L, `group:${L.cycle}`)
  const judged = new Map((res.judged || []).map((j) => [j.group.id, j]))
  const toId = (k) => ids[keys.indexOf(k)]
  for (const gr of g.groups) {
    const j = judged.get(gr.id)
    const status = j ? j.status : 'unverified'
    const id = `G${L.cycle}-${gr.id}`
    L.groups.push({ id, cycle: L.cycle, root_cause: gr.root_cause, layer: gr.layer, keys: gr.keys.map(toId), pattern: gr.pattern, status, votes: j ? j.votes : [] })
    if (status === 'refuted') continue
    // 横展開: 確かめた欠陥の型を、束ね役が返した型の当たる資産（applies_to）へ問い直す観点にする（重さで絞らない。計画が除いた資産には枡を作らない）。
    if (gr.pattern && gr.pattern.trim()) {
      const l = { id: `lat-${id}`, name: `横展開: ${gr.root_cause}`.slice(0, 120), procedure: gr.pattern, applies_to: [...new Set(gr.applies_to)], origin: `lateral:${id}` }
      l.version = lensVersion(l)
      if (!L.lenses.some((x) => x.id === l.id)) L.lenses.push(l)
    }
  }
  L.saturation.push({ cycle: L.cycle, confirmed_new: keys.length, groups: g.groups.length, lateral_lenses: g.groups.filter((x) => x.pattern && x.pattern.trim()).length })
  L.group_cycles.push(L.cycle)
  L.cycle += 1
}

// native Workflow の tasks の .output（返り値を result に包んだ形）も、そのまま受け付ける。包みの判定は coverage-build の build-cli.mjs と同じ。
export function unwrap(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return v
  return Object.hasOwn(v, 'result') && typeof v.summary === 'string' && typeof v.agentCount === 'number' ? v.result : v
}

function cmdIngest(o) {
  const dir = path.resolve(need(o, 'state'))
  return withLock(dir, () => ingest(dir, o))
}
function ingest(dir, o) {
  const L = load(dir)
  const res = unwrap(JSON.parse(read(need(o, 'result'))))
  if (!L.pending) throw new Fail('受け取る呼び出しが無い（next を先に流す）')
  if (!res || res.call_id !== L.pending.call_id || res.stage !== L.pending.step) throw new Fail(`呼び出しが違う: 待っているのは ${L.pending.step}/${L.pending.call_id}、受け取ったのは ${res && res.stage}/${res && res.call_id}`)
  const args = JSON.parse(read(L.pending.args_path))
  if (res.status === 'blocked' && res.reason === 'args の検査に落ちた') throw new Fail('Workflow が args を拒否した（args_path のファイルの中身を書き換えずに渡し直す）', { problems: res.problems })
  // 写しの照合を先に済ませる（合わなければ台帳を変えずに拒否する）。
  const briefs = [args.brief, args.goalBrief, args.againBrief, ...(args.cells || []).map((c) => c.brief), ...(args.units || []).map((u) => u.brief), ...(args.reviewUnits || []).map((u) => u.brief)].filter(Boolean)
  for (const r of [...(args.cells || []), ...(args.index ? [args.index] : []), ...(args.lensIndex ? [args.lensIndex] : []), ...(args.items ? [args.items] : []), ...briefs]) readRef(dir, r, r.cell_id || '索引・全件・束')
  const seen = L.events.length
  allFailed = (Array.isArray(res.agents) && res.agents.length > 0 && res.agents.every((a) => !a.ok)) || (L.pending.step === 'review' && !L.pending.submits)
  recordCall(L, res, L.pending.step, allFailed)
  ;({ plan: ingestPlan, review: ingestReview, group: ingestGroup })[L.pending.step](L, res, args, dir)
  L.hints_read.push(...L.pending.hints)
  L.pending = null
  save(dir, L)
  // 受け付けなかった出力（rejected_*）の理由。ok は「呼び出しを台帳に取り込んだ」ことを指す。
  const rejected = L.events.slice(seen).filter((e) => e.kind.startsWith('rejected_')).map((e) => e.text)
  return { ok: true, cycle: L.cycle, coverage: coverage(L), ...(rejected.length ? { rejected } : {}), next: 'next を流す' }
}

// 今の段の status の節: 指摘・束ね・出来事。reframe で出ていく段の節は、この形のまま phase_records に写す。
function phaseSection(L) {
  const cur = currentFindings(L)
  const by = (k) => cur.reduce((m, f) => ({ ...m, [f[k]]: (m[f[k]] || 0) + 1 }), {})
  return {
    findings: { by_verdict: by('verdict'), by_layer: by('layer'), confirmed: cur.filter((f) => f.verdict === 'confirmed').map((f) => ({ id: f.id, severity: f.severity, layer: f.layer, claim: f.claim, quote: f.quote })), unverifiable: cur.filter((f) => f.verdict === 'unverifiable').map((f) => ({ id: f.id, claim: f.claim })) },
    groups: L.groups.map((g) => ({ id: g.id, status: g.status, layer: g.layer, root_cause: g.root_cause, lateral: !!(g.pattern && g.pattern.trim()) })),
    events: phaseEvents(L).map((e) => ({ id: e.id, stage: e.stage, kind: e.kind, text: e.text })),
  }
}

function cmdStatus(o) {
  const dir = path.resolve(need(o, 'state'))
  const L = load(dir)
  const sec = phaseSection(L)
  const roles = {}
  for (const a of L.agents) { const k = `${a.role}|${a.model}|${a.effort}`; roles[k] = roles[k] || { launched: 0, failed: 0 }; roles[k].launched++; if (!a.ok) roles[k].failed++ }
  return {
    // 上の階層の findings・groups・events は今の段のもの。phases は段ごとの節（出ていった段は phase_records の写し）。
    phase: L.phase, phases: { ...L.phase_records, ...(L.phase ? { [L.phase]: sec } : {}) },
    cycle: L.cycle, stopped: L.stopped || null, pending: L.pending, coverage: coverage(L),
    // 計画が除いた資産（どの観点の枡も作らない）。見ていない所として開示する。
    excluded: needPlan(L) && L.plan ? (L.plan.excluded || []).map((x) => ({ asset: x.asset, reason: x.reason })) : [],
    // 観点の精査（N1）で当てた資産が全て外れ、今の計画から落とした観点。
    dropped_lenses: L.dropped_lenses,
    skip: Object.entries(L.cells).filter(([, c]) => c.status === 'disclosed').map(([id, c]) => ({ cell: id, problems: c.problems })),
    findings: sec.findings,
    outside_notes: Object.entries(L.cells).filter(([, c]) => (c.outside_notes || []).length).map(([id, c]) => ({ cell: id, notes: c.outside_notes })),
    groups: sec.groups, events: sec.events,
    saturation: L.saturation, calibration: calibration(L), agents_by_role: roles, calls: L.calls,
    events_not_in_retro: L.events.filter((e) => !e.retro).map((e) => ({ id: e.id, stage: e.stage, kind: e.kind })),
    questions: ((L.plan && L.plan.questions) || []).filter((q) => !L.answers.some((a) => a.id === q.id)),
  }
}

function cmdHint(o) {
  const dir = path.resolve(need(o, 'state'))
  return withLock(dir, () => hint(dir, o))
}
function hint(dir, o) {
  const L = load(dir)
  if (L.stopped && L.stopped.stop === 'complete') throw new Fail('完了した台帳にはヒントを足せない（読まれない）')
  const id = `H${hints(dir).length + 1}`
  appendFileSync(path.join(dir, 'hints.jsonl'), `${JSON.stringify({ id, text: need(o, 'text') })}\n`)
  return { ok: true, id }
}

function cmdAnswer(o) {
  const dir = path.resolve(need(o, 'state'))
  return withLock(dir, () => answer(dir, o))
}
function answer(dir, o) {
  const L = load(dir)
  const id = need(o, 'id')
  // 目標・受け入れ基準・制約・決定の記録はファイルの中身を置き換え、引用を照らし直してから目標の照合をやり直す。
  if (['goal', 'criteria', 'constraints', 'decisions'].includes(id)) {
    if (L.goal.checked_by) throw new Fail(`この台帳の目標は ${L.goal.checked_by} が照合して渡した。${L.goal.checked_by} の台帳で直す`)
    const body = o.file ? read(o.file) : need(o, 'text')
    const itemsText = (xs) => xs.map((c) => `- ${c.id}: ${c.text}${c.cites.map((q) => ` 〔${q.source}: ${q.quote}〕`).join('')}`).join('\n')
    const text = { goal: L.goal.text, request: L.request, decisions: L.decisions, criteria: itemsText(L.criteria), constraints: itemsText(L.constraints), [id]: ['goal', 'decisions'].includes(id) ? body.trim() : body }
    const g = readGoalFiles(text)
    if (g.problems.length) throw new Fail(`直した ${id} が引用の照合を通らない（台帳は変えていない）`, { problems: g.problems })
    Object.assign(L, { goal: { text: text.goal, items: g.goal, checked: false, checked_by: null, problems: [] }, decisions: text.decisions, criteria: g.criteria, constraints: g.constraints })
    clear(L, 'goal')
    // 基準・制約の id が変われば、計画の受け皿が合わなくなる。静的な欠陥として統合役に直させる。
    const ctx = { constraintIds: [...L.criteria, ...L.constraints].map((c) => c.id), lensesGiven: !needPlan(L), givenLensIds: L.lenses.filter((l) => l.origin === 'user').map((l) => l.id), goalItemIds: goalItemIds(L), goalTexts: goalTexts(L) }
    if (L.plan) for (const x of C.checkPlan(L.plan, ctx)) addPlanDefect(L, { unit_id: '', kind: 'static', claim: x, quote: '' })
    save(dir, L)
    return { ok: true, next: '目標の照合からやり直す。next を流す' }
  }
  const text = need(o, 'text')
  const isQ = ((L.plan && L.plan.questions) || []).some((q) => q.id === id)
  // 計画の欠陥（P<n>）への回答は、計画の質問への回答と同じく決定の記録と制約にし、統合からやり直す。指せるのは今の欠陥だけ。
  const isP = !isQ && L.plan_defects.some((d) => d.id === id)
  const known = isQ || isP || L.findings[id] || L.groups.some((g) => g.id === id) || id.startsWith('attempts:')
  if (!known) throw new Fail(`台帳に無い id: ${id}`)
  if (id.startsWith('attempts:')) clear(L, id.slice('attempts:'.length))
  L.answers.push({ id, text, target_kind: isQ ? 'question' : isP ? 'plan_defect' : 'finding' })
  if (isQ || isP) {
    // 回答は利用者の言葉として決定の記録に足し、その行を引用する制約にする（引用の無い項目を作らない）。
    const said = `${id} への利用者の回答: ${text.replace(/\s*\n\s*/g, ' ')}`
    L.decisions = `${L.decisions != null ? `${L.decisions}\n` : ''}- ${said}`
    // id は目標・基準・制約の id に無い最小の A<n>（coverage-build から渡った A<n> や、利用者が書いた A<n> と重ねない）。
    const used = [...L.goal.items, ...L.criteria, ...L.constraints].map((c) => c.id)
    let n = 1
    while (used.includes(`A${n}`)) n++
    L.constraints.push({ id: `A${n}`, text: said, cites: [{ source: 'decisions', quote: said }] })
  }
  save(dir, L)
  return { ok: true }
}

function cmdConfig(o) {
  const dir = path.resolve(need(o, 'state'))
  const config = posInts(o, [['max-cycles', 'max_cycles'], ['max-agents-total', 'max_agents_total'], ['workers', 'workers']])
  return withLock(dir, () => {
    const L = load(dir)
    checkWorkers({ ...L.config, ...config })
    Object.assign(L.config, config)
    save(dir, L)
    return { ok: true, config: L.config }
  })
}

// ---------------- review の待ち行列（worker が Bash で流す） ----------------
// claim と submit は、今の review の呼び出し（pending）の中でだけ、args の workers の行の worker から受け付ける。外れたら台帳を変えずに拒否する。
function reviewWorker(L, o) {
  const call = need(o, 'call')
  const worker = need(o, 'worker')
  if (!L.pending) throw new Fail('今は review の呼び出しが無い（取り込みの後か next の前）。worker を終える')
  if (L.pending.step !== 'review') throw new Fail(`今の呼び出しは review でない: ${L.pending.step}`)
  if (call !== L.pending.call_id) throw new Fail(`呼び出しが違う: 今は ${L.pending.call_id}、受け取ったのは ${call}（前の呼び出しは終わった。worker を終える）`)
  const args = JSON.parse(read(L.pending.args_path))
  const w = (args.workers || []).find((x) => x.id === worker)
  if (!w) throw new Fail(`この呼び出しの workers に無い worker: ${worker}`)
  return w
}
const sq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`
const CLI_PATH = fileURLToPath(import.meta.url)

// 待ち行列から取る。読む役は、まだ読んでいない資産を 1 つと、その回の当たる観点の全ての枡。検証役は、指摘のある枡を 1 つとその枡の指摘だけ。
// 取れるのは claim の無い枡と、試行が上限に届いていない枡だけ。本文と他の枡の指摘は返さない（worker が写しを読む）。
// その worker がこの呼び出しでまだ提出していない枡を持っていれば、新しく取らずにその枡を同じ形で返し直す（前の資産の一覧を見失わせない）。
// 結果の path は待ち行列と worker ごとに分け、返す前に既にあるファイルを消す（読む役の古い結果を検証役が受け取らない）。
function cmdClaim(o) {
  const dir = path.resolve(need(o, 'state'))
  return withLock(dir, () => {
    const L = load(dir)
    const w = reviewWorker(L, o)
    const call = L.pending.call_id
    const held = Object.entries(L.cells).filter(([, c]) => c.claim && c.claim.call === call && c.claim.worker === w.id)
    let picked = held
    if (!held.length) {
      const free = Object.entries(L.cells).filter(([, c]) => c.pass === w.pass && !c.claim && c.attempts < MAX_ATTEMPTS && L.assets[c.asset]
        && (w.queue === 'read' ? c.status === 'unseen' : c.status === 'seen' && !!c.read))
      if (!free.length) return { ok: true, done: true }
      picked = w.queue === 'read' ? free.filter(([, c]) => c.asset === free[0][1].asset) : [free[0]]
    }
    const assetId = picked[0][1].asset
    const a = L.assets[assetId]
    const resDir = path.join(dir, 'results', call, w.queue, w.id)
    mkdirSync(resDir, { recursive: true })
    const cells = picked.map(([id, c]) => {
      const l = L.lenses.find((x) => x.id === c.lens)
      c.claim = { call, worker: w.id }
      const rp = path.join(resDir, `${sha(id).slice(0, 16)}.json`)
      rmSync(rp, { force: true })
      const cmd = [process.execPath, CLI_PATH, 'submit', '--state', dir, '--call', call, '--cell', id, '--worker', w.id, '--result', rp].map(sq).join(' ')
      return {
        cell_id: id, lens: c.lens, brief: writeSnap(dir, `## 観点\n観点: ${l.name}\n手続き: ${l.procedure}\n`), result_path: rp, submit_cmd: cmd,
        ...(w.queue === 'verify' ? { findings: c.read.findings.map((f) => ({ claim: f.claim, quote: f.quote, severity: f.severity, layer: f.layer })) } : {}),
      }
    })
    save(dir, L)
    return { ok: true, asset: { id: assetId, path: a.path, file: a.snap, start: a.start, end: a.end, blocks: a.blocks.map(([bs, be]) => [a.start + bs, a.start + be]) }, cells }
  })
}

// 枡を 1 つ出す。照合（引用・区画・判定）は ingest の照合と同じで、落ちたら理由を返して試行に数える（上限で開示に倒し dropped）。
// 写しの hash の食い違い・claim の無い枡・別の worker の枡は、台帳を変えずに拒否する（終了状態 2）。
function cmdSubmit(o) {
  const dir = path.resolve(need(o, 'state'))
  return withLock(dir, () => {
    const L = load(dir)
    const w = reviewWorker(L, o)
    const id = need(o, 'cell')
    const c = L.cells[id]
    if (!c) throw new Fail(`台帳に無い枡: ${id}`)
    if (!c.claim) throw new Fail(`取られていない枡（claim が無い）: ${id}（claim で取った枡だけを出す。受理の後と、開示に倒した後は出し直せない）`)
    if (c.claim.worker !== w.id || c.claim.call !== L.pending.call_id) throw new Fail(`別の worker が取った枡: ${id}（取ったのは ${c.claim.worker}）`)
    const a = L.assets[c.asset]
    const file = need(o, 'result')
    if (!existsSync(file)) throw new Fail(`結果のファイルが無い: ${file}`)
    const text = a && existsSync(a.snap) ? read(a.snap) : null
    if (text == null || rangeHash(text, a.start, a.end) !== a.hash) throw new Fail(`写しの hash が台帳と違う（写しが書き換わった。next からやり直す）: ${a ? a.snap : c.asset}`)
    let rep = null
    try { rep = JSON.parse(read(file)) } catch { rep = null }
    const asset = { ...withBlocks({ text: rangeText(text, a.start, a.end) }), retro: !!a.retro }
    const r = c.status === 'seen' && c.read ? submitVerify(L, id, rep, asset) : submitRead(L, id, rep, asset)
    L.pending.submits = (L.pending.submits || 0) + 1
    save(dir, L)
    return r.problems.length ? { ok: false, cell: id, problems: r.problems, dropped: r.dropped } : { ok: true, cell: id, status: L.cells[id].status }
  })
}

export function main(argv) {
  try {
    const o = parse(argv)
    const cmd = o._[0]
    const f = { init: cmdInit, reframe: cmdReframe, next: cmdNext, ingest: cmdIngest, status: cmdStatus, hint: cmdHint, answer: cmdAnswer, config: cmdConfig, claim: cmdClaim, submit: cmdSubmit }[cmd]
    if (!f) throw new Fail(`使い方: ledger-cli.mjs <init|reframe|next|ingest|status|hint|answer|config|claim|submit> --state DIR ...（未知のコマンド: ${cmd}）`)
    return { code: 0, output: f(o) }
  } catch (e) {
    if (e instanceof Fail) return { code: 2, output: { ok: false, error: e.message, ...e.extra } }
    return { code: 1, output: { ok: false, error: String(e && e.stack || e) } }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = main(process.argv.slice(2))
  process.stdout.write(`${JSON.stringify(r.output, null, 1)}\n`)
  process.exitCode = r.code
}
