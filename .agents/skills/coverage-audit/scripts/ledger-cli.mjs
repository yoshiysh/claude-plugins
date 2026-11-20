#!/usr/bin/env node
// 台帳を書く唯一の口。init → next →（Workflow が worker を起動し、worker が claim・query・submit で台帳と読み書きする）→ ingest を繰り返し、
// next が止まる条件を返したら終わる。役の出力は返り値・args・prompt で運ばず、submit で台帳に入る（設計の B1〜B6）。
import { randomUUID } from 'node:crypto'
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  ALIAS_ANSWERS, C, CONFIDENCES, MAX_ATTEMPTS, VERDICTS, addEvent, atCycleCap, board, calibration, capCycles, checkFileResult, coverage, currentFindings, decide, factsOf, goalIds, goalSources, lateralGroups,
  lateralTypeIds, lensSetVersion, lensesFor, needPlan, newLedger, obligations, openCycle, planAnswerKinds, phaseEvents, rangeHash, rangeText, readGoalFiles, readsSig, refresh, retroAssets, sha, splitAssets,
  startPhase, staticFacts, targetLenses, todoUnits, unitTextOf, carriedRead, provenance, runMetrics,
} from './ledger-core.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WORKFLOW = path.join(HERE, 'coverage-audit.js')

class Fail extends Error { constructor(msg, extra = {}) { super(msg); this.extra = extra } }
const MULTI = ['target', 'fact']
const KNOWN = {
  init: ['state', 'goal', 'request', 'decisions', 'criteria', 'goal-checked', 'target', 'constraints', 'lenses', 'roles', 'seeds', 'max-cycles', 'max-agents-total', 'phase', 'link'],
  reframe: ['state', 'goal', 'request', 'decisions', 'criteria', 'constraints', 'target', 'phase', 'link', 'lenses'],
  next: ['state'], ingest: ['state', 'call', 'result'], status: ['state'], hint: ['state', 'text'], answer: ['state', 'id', 'text', 'file'], config: ['state', 'max-cycles', 'max-agents-total', 'workers'],
  claim: ['state', 'call', 'worker'], submit: ['state', 'call', 'worker'], query: ['state', 'call', 'worker', 'task', 'fact'],
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
  if (!Number.isInteger(L.call_seq) || !Number.isInteger(L.config && L.config.workers)) throw new Fail(`台帳の形式が古い（review の待ち行列の通し番号と worker の数を持たない）: ${ledgerPath(dir)}。新しい stateDir で init からやり直す`)
  if (!L.phase_start || !L.phase_records || L.phase === undefined) throw new Fail(`台帳の形式が古い（段の記録を持たない）: ${ledgerPath(dir)}。新しい stateDir で init からやり直す`)
  if (!Array.isArray(L.lenses) || L.lenses.some((l) => l.origin === 'skill' && !l.retro)) throw new Fail(`台帳の形式が古い（スキルの観点 purpose・layer を固定で持つ）: ${ledgerPath(dir)}。新しい stateDir で init からやり直す`)
  if (!Object.hasOwn(L, 'link')) throw new Fail(`台帳の形式が古い（関係する資産を結ぶ link の欄を持たない）: ${ledgerPath(dir)}。新しい stateDir で init からやり直す`)
  if (!Array.isArray(L.facts) || L.cells) throw new Fail(`台帳の形式が古い（資産 × 観点の枡を持つ）: ${ledgerPath(dir)}。新しい stateDir で init からやり直す`)
  if (!L.intent_attempts || !Array.isArray(L.lateral_types)) throw new Fail(`台帳の形式が古い（全体の段の意図の試行と横展開の型を持たない）: ${ledgerPath(dir)}。新しい stateDir で init からやり直す`)
  return L
}
function writeAtomic(file, text) {
  mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, text)
  renameSync(tmp, file)
}
// 役が最初の claim を流す入口（stateDir/ledger-cli.mjs）。args は {state, callId, stage, workers} だけ（B4）で CLI の置き場を運べないので、
// Workflow script は stateDir の下のこの名前を prompt に書く。中身は本物の CLI を絶対パスで import して流すだけで、判断も照合も持たない。
// plugin の置き場が変わっても古い path が残らないよう、init と next のたびに書き直す。
export const LAUNCHER = 'ledger-cli.mjs'
export const launcherText = () => `// 生成物: ${LAUNCHER} が init・next のたびに書き直す。本物の CLI を流すだけ。\nimport { runMain } from ${JSON.stringify(pathToFileURL(fileURLToPath(import.meta.url)).href)}\nrunMain(process.argv.slice(2))\n`
const writeLauncher = (dir) => writeAtomic(path.join(dir, LAUNCHER), launcherText())
// 台帳を書くコマンドは、load から save までを stateDir/ledger.lock で囲む（並べて動く worker の claim・submit を直列にする）。
// lock は openSync の wx で取る。取れなければ短く眠って取り直し、LOCK_WAIT_MS を超えたら台帳を変えずに Fail にする。古い lock も消さない（自動で奪うと 2 つの process が同時に書く窓ができる）。
// 止まるときの lock の mtime が LOCK_STALE_MS より前なら、落ちた process の残りかもしれないので、CLI が動いていないことを確かめてから手で消す案内を出す。
// lock には取得ごとの token を書き、終わるときは中身が自分の token のときだけ消す（他の process の lock を消さない）。
const LOCK_WAIT_MS = 10000
const LOCK_STALE_MS = 60000
const LOCK_SLEEP_MS = 20
const nap = new Int32Array(new SharedArrayBuffer(4))
export function withLock(dir, fn) {
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'ledger.lock')
  const t0 = Date.now()
  let fd = null
  while (fd === null) {
    try { fd = openSync(file, 'wx') } catch (e) {
      if (e.code !== 'EEXIST') throw e
      let age = null
      try { age = Date.now() - statSync(file).mtimeMs } catch (e2) { if (e2.code === 'ENOENT') continue; throw e2 }
      if (Date.now() - t0 >= LOCK_WAIT_MS) {
        throw new Fail(age > LOCK_STALE_MS
          ? `台帳の lock を ${LOCK_WAIT_MS / 1000} 秒待っても取れない: ${file}（mtime が ${LOCK_STALE_MS / 1000} 秒より前で、落ちた process の lock が残っている可能性がある。この台帳を使っている CLI が動いていないことを確かめてから、${file} を手で消して流し直す）`
          : `台帳の lock を ${LOCK_WAIT_MS / 1000} 秒待っても取れない: ${file}（他の process が台帳を書いている。終わってから流し直す）`)
      }
      Atomics.wait(nap, 0, 0, LOCK_SLEEP_MS)
    }
  }
  const token = `${process.pid}-${randomUUID()}`
  let open = true
  try {
    writeSync(fd, token)
    closeSync(fd)
    open = false
  } catch (e) {
    // 中身を照合できない lock は誰も消さないので、自分が作った lock をここで消す。
    if (open) try { closeSync(fd) } catch { /* 元の例外を投げる */ }
    rmSync(file, { force: true })
    throw e
  }
  try {
    return fn()
  } finally {
    let held = null
    try { held = readFileSync(file, 'utf8') } catch (e) { if (e.code !== 'ENOENT') throw e }
    if (held === token) rmSync(file, { force: true })
  }
}
// 書き込みは一時ファイルからの rename で 1 回に行う（途中で落ちても壊れた台帳を残さない）。
function save(dir, L) {
  // 確定した指摘と検証不能の指摘は、台帳の事実から導いた写しを findings に置く（status・answer・reframe の段の記録が読む）。
  if (L.facts) L.findings = Object.fromEntries(board(L).findings.list.map((f) => [f.id, { ...f, status: 'current' }]))
  L.rev += 1
  writeAtomic(ledgerPath(dir), JSON.stringify(L, null, 1))
}
// 段の位置（{ phase, phase_start }）を stateDir/phase.json に書く。init と、受け付けた reframe だけが、台帳を保存した直後に lock の中で書く。
// 呼ぶ側（coverage-build）は台帳（ledger.json）を読まず、このファイルを path で読んで、同じ段の reframe を二重に発行しない判定に使う。
const phasePath = (dir) => path.join(dir, 'phase.json')
const savePhase = (dir, L) => writeAtomic(phasePath(dir), JSON.stringify({ phase: L.phase, phase_start: L.phase_start }))
const hints = (dir) => {
  const f = path.join(dir, 'hints.jsonl')
  return existsSync(f) ? read(f).split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []
}

// 写し: 担当が読む内容を stateDir/snap/ に内容の hash の名前で置く（同じ内容は同じファイル）。
// 既にあるファイルの中身が名前の hash と違えば（書き換わった写し）書き直す。書き直さないと submit の拒否から抜けられない。
const snapDir = (dir) => path.join(dir, 'snap')
function writeSnap(dir, text) {
  const name = sha(text).slice(0, 16)
  const file = path.join(snapDir(dir), `${name}.txt`)
  if (!existsSync(file) || sha(read(file)).slice(0, 16) !== name) writeAtomic(file, text)
  return file
}
// 対象のファイルを今の内容で単位にし、同じ内容を写しに書く。消えた・読めない対象は返す（単位 0 件で完了にしない）。
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
// 関係する資産を結ぶ語の正規表現（--link）。無ければ null。正規表現として作れなければ拒否する（台帳を作らない・変えない）。
function linkOf(o) {
  if (o.link === undefined) return null
  try { new RegExp(o.link, 'g') } catch (e) { throw new Fail(`--link が正規表現として作れない: ${o.link}（${e.message}）`) }
  return o.link
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
  const lenses = readLenses(o)
  const roles = { ...JSON.parse(read(path.join(HERE, 'roles.json'))), ...(o.roles ? JSON.parse(read(o.roles)) : {}) }
  const config = posInts(o, [['max-cycles', 'max_cycles'], ['max-agents-total', 'max_agents_total']])
  // 照合済みの印: coverage-build が目標を照合して渡したときだけ付く。付いていれば目標の照合（引用の照合と照合役）を流さない。
  const checkedBy = o['goal-checked'] ?? null
  if (checkedBy !== null && checkedBy !== 'coverage-build') throw new Fail(`--goal-checked は coverage-build だけ（目標を照合したスキル）: ${checkedBy}`)
  const phase = phaseOf(o)
  const link = linkOf(o)
  const text = frameText(o)
  const g = readGoalFiles(text, { checkedBy })
  if (g.problems.length) throw new Fail('目標・基準・制約に、引用の照合を通らない項目がある（台帳は作っていない。直して init をやり直す）', { problems: g.problems })
  const L = newLedger({
    goal: text.goal, goalItems: g.goal, checkedBy, phase, link, request: text.request, decisions: text.decisions, criteria: g.criteria, constraints: g.constraints,
    targets, lenses, config, roles, seeds: o.seeds ? JSON.parse(read(o.seeds)).map((s) => ({ ...s, path: abs(s.path) })) : [],
  })
  checkWorkers(L.config)
  withLock(dir, () => {
    if (existsSync(ledgerPath(dir))) throw new Fail(`台帳が既にある: ${ledgerPath(dir)}（持ち越すときは next を流す）`)
    save(dir, L)
    savePhase(dir, L)
    writeLauncher(dir)
  })
  return { ok: true, state: dir, phase, targets: targets.length, criteria: L.criteria.length, constraints: L.constraints.length, goal_checked_by: checkedBy, hint: `ヒントは node ${path.join(HERE, 'ledger-cli.mjs')} hint --state ${dir} --text "..." で足せる（実行中も止まっている間も）` }
}

// 利用者（呼ぶ側）の観点のファイル（--lenses）。無ければ空。形（id・name・procedure）を照らす。
function readLenses(o) {
  const lenses = o.lenses ? JSON.parse(read(o.lenses)) : []
  if (!Array.isArray(lenses)) throw new Fail('--lenses は観点の配列の JSON')
  for (const l of lenses) if (!l || !l.id || !l.name || !l.procedure) throw new Fail(`観点の形が不正: ${JSON.stringify(l)}`)
  return lenses
}
// 検査の手続きの指紋: 利用者の観点・目標・基準・制約・決定の記録・link。同じなら、同じ段の reframe で読みを持ち越せる。
const procedureSig = (L) => sha(JSON.stringify([
  L.lenses.filter((l) => l.origin === 'user').map((l) => [l.id, l.name, l.procedure]), L.goal.text, L.goal.items.map((x) => [x.id, x.text]),
  L.criteria.map((x) => [x.id, x.text]), L.constraints.map((x) => [x.id, x.text]), L.decisions ?? null, L.link ?? null,
]))
// reframe: 既にある台帳の目標の冒頭の文・目標・基準・制約・依頼文・決定の記録・対象と段を差し替える（台帳と置き場は 1 つのまま）。
// 照合済みの印（coverage-build が目標を照合して渡した台帳）のある台帳だけを受け、印は残す。印の無い台帳の目標は answer で直す。
// 出ていく段の status の節を phase_records に写し、全ての単位を読み直しにして計画から作り直す（中身が同じでも読み直す）。
function cmdReframe(o) {
  const dir = path.resolve(need(o, 'state'))
  return withLock(dir, () => {
    const L = load(dir)
    if (!L.goal.checked_by) throw new Fail('照合済みの印の無い台帳は reframe できない（目標・基準・制約は answer で直す）')
    if (!L.phase) throw new Fail('段の記録の無い台帳は reframe できない（--phase を付けて init からやり直す）')
    const phase = phaseOf(o)
    if (!phase) throw new Fail('--phase が要る')
    // link は枠の一部: --link を持たない reframe は null にする。
    const link = linkOf(o)
    const targets = (o.target || []).map((p) => path.resolve(p))
    if (!targets.length) throw new Fail('--target が要る')
    const missing = targets.filter((p) => !existsSync(p))
    if (missing.length) throw new Fail('読めない対象がある（台帳は変えていない）', { stop: 'blocked', cause: 'input', missing })
    const text = frameText(o)
    const g = readGoalFiles(text, { checkedBy: L.goal.checked_by })
    if (g.problems.length) throw new Fail('目標・基準・制約に、引用の照合を通らない項目がある（台帳は変えていない）', { problems: g.problems })
    // --lenses があれば、新しい段の利用者の観点に差し替える（呼ぶ側が段ごとに観点を渡す）。無ければ今の利用者の観点を保つ。
    const lenses = o.lenses ? readLenses(o) : null
    const from = L.phase
    const before = procedureSig(L)
    const sec = phaseSection(L)
    Object.assign(L, { goal: { ...L.goal, text: text.goal, items: g.goal, problems: [] }, request: text.request, decisions: text.decisions, criteria: g.criteria, constraints: g.constraints, targets, link })
    if (lenses) L.lenses = [...lenses.map((l) => ({ id: l.id, name: l.name, procedure: l.procedure, origin: 'user' })), ...L.lenses.filter((l) => l.origin !== 'user')]
    // 同じ段で手続き（観点・目標・基準・制約・決定の記録・link）が同じ reframe は、全てを読み直しにしない（設計「再レビューと持ち越し」）。
    // 対象の差し替えは次の next の refresh が指紋で読み直す単位を決め、止まった後なら新しい回を始める（prior と持ち越しが効く）。
    // phase.json の段の始まりに reframes を数えて書き、呼ぶ側が同じ reframe を二重に発行しないようにする。
    const keep = from === phase && procedureSig(L) === before
    if (keep) L.phase_start = { ...L.phase_start, reframes: (L.phase_start.reframes || 0) + 1 }
    else {
      L.phase_records[from] = sec
      startPhase(L, phase)
    }
    save(dir, L)
    savePhase(dir, L)
    if (!keep) rmSync(statusPath(dir, L), { force: true })
    return {
      ok: true, state: dir, from, phase, kept: keep, targets: targets.length, criteria: L.criteria.length, constraints: L.constraints.length,
      next: keep ? 'next を流す（手続きが同じなので、内容の変わった単位だけを読み直す）' : 'next を流す（計画から作り直し、全ての単位を読み直す）',
    }
  })
}

// ---------------- 呼び出し（next が開き、ingest が閉じる） ----------------
// args は {state, callId, stage, workers} だけにする（B4）。担当が読む文は args にも prompt にも載せず、役が claim と query で台帳から引く（B1）。
// 1 つの呼び出しの worker は全て同時に起動されるので、前の役の提出を読む役（統合役・精査役・検証役）は次の呼び出しに置く。
// 段・担当の種類から役の名前への対応は、ここと stageTasks・INTENT_ROLE の 1 か所に置く。役のモデルと effort の組は roles.json だけが持ち、
// next が workers の行に写す（Workflow script は行の値を使い、役の名前で分岐しない）。
const FILE_ROLE = 'file_reader'
const goalItemIds = (L) => [...L.goal.items, ...L.criteria].map((c) => c.id)
const goalTexts = (L) => Object.fromEntries([...L.goal.items, ...L.criteria].map((c) => [c.id, c.text]))
// 既にある観点（呼ぶ側と仕組みの標準）。計画役は定義し直せず、制約の受け皿にできる。
const givenLenses = (L) => L.lenses.filter((l) => l.origin === 'user' || l.origin === 'standard')
const planCtx = (L) => ({ constraintIds: [...L.criteria, ...L.constraints].map((c) => c.id), lensesGiven: !needPlan(L), givenLensIds: givenLenses(L).map((l) => l.id), goalItemIds: goalItemIds(L), goalTexts: goalTexts(L) })
// 呼ぶ側の観点があるときの計画役の提案は足すだけなので、試行の上限まで出なければ提案なしで進め、出来事に残す（止めない）。
function skipStuckPlan(L) {
  if (L.plan_skipped || needPlan(L) || (L.attempts.plan || 0) < MAX_ATTEMPTS) return
  L.plan_skipped = true
  delete L.attempts.plan
  delete L.env_attempts.plan
  L.plan_drafts = null
  addEvent(L, 'plan', 'plan_skipped', `計画役の観点の提案が試行 ${MAX_ATTEMPTS} 回で出なかったので、呼ぶ側と標準の観点（${givenLenses(L).map((l) => l.id).join('・')}）で読み進める`)
}
// 計画の照合は Workflow source の checkPlan。観点は一覧で全ての単位に渡すので、当てる単位（applies_to・excluded）は持たない。
function planProblems(rep, ctx) {
  if (!rep || typeof rep !== 'object') return ['結果が object でない']
  return C.checkPlan(rep, ctx)
}
// 計画の欠陥を足す。id は台帳の連番の P<n> で、統合をやり直して欠陥を戻しても前の番号を使い回さない（answer --id P<n> で指す）。
function addPlanDefect(L, d) {
  L.plan_seq += 1
  L.plan_defects.push({ id: `P${L.plan_seq}`, ...d })
}
// 計画の観点を台帳の観点に写す（ファイルの段に渡す観点の一覧になる）。
function syncPlanLenses(L) {
  const plan = L.plan || { lenses: [] }
  L.lenses = [...L.lenses.filter((l) => l.origin !== 'plan'), ...(plan.lenses || []).map((l) => ({ ...l, origin: 'plan' }))]
}
// 1 回の呼び出しの起動数は workers ≤ maxAgents に収める。
function checkWorkers(config) {
  if (config.workers > C.LIMITS.maxAgents) throw new Fail(`ファイルの段の 1 回の起動数 workers(${config.workers}) が上限 maxAgents ${C.LIMITS.maxAgents} を超える（--workers を下げる）`)
}
// 段ごとの worker の行と、行に結んだ担当。ファイルの段の担当は結ばず、worker が claim で読む単位を 1 つずつ取る。
// 計画の段の担当は行に 1 つずつ結ぶ。akey は試行を数える鍵（stuck の id）。
function stageTasks(L, d) {
  const one = (id, role, task) => ({ rows: [{ id, role }], tasks: [{ ...task, worker: id }] })
  if (d.step === 'global') return { ...globalRows(L, board(L)), tasks: [] }
  if (d.step === 'group') return one('gr1', 'grouper', { id: 'group', kind: 'group', akey: `group:${L.cycle}`, items: confirmedThisCycle(L, board(L)).map((f) => f.id) })
  if (d.step === 'refute') {
    const gs = L.grouping.refute.map((id) => L.grouping.groups.find((g) => g.id === id))
    return {
      rows: gs.flatMap((g, i) => [{ id: `ra${i + 1}`, role: 'refuter_a' }, { id: `rb${i + 1}`, role: 'refuter_b' }]),
      tasks: gs.flatMap((g, i) => ['a', 'b'].map((who) => ({ id: `refute:${g.id}:${who}`, kind: 'refute', group: g.id, who, worker: `r${who}${i + 1}` }))),
    }
  }
  // ファイルの段は 1 単位に 1 体（設計「段の構成」）。起動数は未読の単位の数で、maxAgents と残りの予算に収める。残りは次の呼び出しで読む。
  if (d.step === 'file') return { rows: Array.from({ length: Math.max(1, Math.min(d.units.length, C.LIMITS.maxAgents, budgetLeft(L))) }, (_, i) => ({ id: `f${i + 1}`, role: FILE_ROLE })), tasks: [] }
  if (d.step === 'goal_check') return one('g1', 'goal_checker', { id: 'goal_check', kind: 'goal_check', akey: 'goal' })
  if (d.step === 'plan') return { rows: [{ id: 'pa', role: 'planner_a' }, { id: 'pb', role: 'planner_b' }], tasks: [{ id: 'plan:A', kind: 'plan', who: 'A', worker: 'pa' }, { id: 'plan:B', kind: 'plan', who: 'B', worker: 'pb' }] }
  if (d.step === 'integrate') {
    const answers = L.answers.filter((a) => !L.answered.includes(a.id) && planAnswerKinds.includes(a.target_kind)).map((a) => a.id)
    return one('i1', 'integrator', { id: 'integrate', kind: 'integrate', akey: 'plan', again: !!L.plan, answerIds: answers })
  }
  const byId = new Map(((L.plan && L.plan.lenses) || []).map((u) => [u.id, u]))
  const ids = d.lenses.slice(0, C.LIMITS.maxAgents)
  return {
    rows: ids.map((id, i) => ({ id: `uv${i + 1}`, role: 'unit_verifier' })),
    tasks: ids.map((id, i) => ({ id: `unit_verify:${id}`, kind: 'unit_verify', lens: id, key: C.unitKey(byId.get(id)), akey: `unit:${id}`, worker: `uv${i + 1}` })),
  }
}

// ---------------- 全体の段（意図）と束ね・反証 ----------------
// 意図の種類ごとの役。名寄せは alias_judge、主語の照合・指摘の判定・前提の消化・目標の判定は global_judge、確認は confirmer。
// 横展開は型を 1 つの単位の全文に当てて読み直すので、ファイルの段と同じ file_reader にする。
const INTENT_ROLE = { alias: 'alias_judge', subject: 'global_judge', finding: 'global_judge', premise: 'global_judge', goal: 'global_judge', lateral: FILE_ROLE, confirm: 'confirmer' }
const INTENT_ROWS = [['a', ['alias']], ['g', ['subject', 'finding', 'premise', 'goal']], ['c', ['confirm']], ['x', ['lateral']]]
// 1 体が 1 つの担当だけを取る種類（横展開は型を 1 つの単位の全文に当てて読み直すので、ファイルの段と同じく 1 単位に 1 体）。
const ONE_PER_WORKER = ['lateral']
// 今の段の残りの予算（起動数）。1 回の呼び出しの起動数をこれに収める（少なくとも 1）。
const budgetLeft = (L) => Math.max(1, L.config.max_agents_total - (L.agents.length - L.phase_start.agents))
// 全体の段の行: 開いた意図のある種類の組ごとに、min(workers, 開いた意図の数) 体。呼び出しの中で受理された事実から増えた意図は、行のある組なら同じ呼び出しで取る。
function globalRows(L, B) {
  const open = B.intents.filter((i) => i.state === 'open')
  const rows = []
  const kinds = {}
  for (const [tag, ks] of INTENT_ROWS) {
    const count = open.filter((i) => ks.includes(i.kind)).length
    const n = ks.every((k) => ONE_PER_WORKER.includes(k)) ? Math.min(count, C.LIMITS.maxAgents, Math.max(1, budgetLeft(L) - rows.length)) : Math.min(L.config.workers, count)
    for (let k = 1; k <= n; k++) { rows.push({ id: `${tag}${k}`, role: INTENT_ROLE[ks[0]] }); kinds[`${tag}${k}`] = ks }
  }
  return { rows, kinds }
}
const intentTaskId = (intent, call) => `${intent}@${call}`
// 目標の判定の担当に渡す単位の索引（id・path・写しの範囲）。義務に結ばれた事実が無くても、役が写しを開いて引用し、抜けの場所を書けるようにする。
const unitIndex = (L) => Object.entries(L.assets).filter(([, a]) => !a.retro).map(([id, a]) => ({ id, path: a.path, file: a.snap, start: a.start, end: a.end }))
// query が返す載せなかった事実の id の上限（B6: 要約は上限と宣言を持つ）。超えた分の件数は omitted_more で宣言する。
const OMITTED_IDS_MAX = 200
function intentTask(L, dir, call, w, it) {
  const tid = intentTaskId(it.id, call)
  const t = L.lateral_types.find((x) => x.id === it.type)
  const a = it.unit ? L.assets[it.unit] : null
  const hs = hintsOf(dir, L.pending.hints)
  return {
    id: tid, kind: it.kind, result_path: resultPath(dir, call, w.id, tid), intent: { id: it.id, kind: it.kind, ...(it.item ? { item: it.item } : {}) },
    lenses: targetLenses(L).map((l) => ({ id: l.id, name: l.name, procedure: l.procedure })), obligations: obligations(L),
    ...(a ? { unit: { id: it.unit, path: a.path, file: a.snap, start: a.start, end: a.end } } : {}), ...(it.kind === 'goal' ? { units: unitIndex(L) } : {}), ...(t ? { type: { id: t.id, pattern: t.pattern, root_cause: t.root_cause } } : {}), ...(hs.length ? { hints: hs } : {}),
  }
}
// 意図の試行: 根拠の鍵が変われば数え直す。上限で判定できなかった意図（undecided）として理由つきで閉じる。
function bumpIntent(L, it, reason, stage = 'global') {
  const a = L.intent_attempts[it.id] && L.intent_attempts[it.id].key === it.key ? L.intent_attempts[it.id] : { key: it.key, n: 0 }
  a.n += 1
  a.reason = reason
  L.intent_attempts[it.id] = a
  if (a.n >= MAX_ATTEMPTS) addEvent(L, stage, 'undecided', `${it.id}: 試行 ${a.n} 回で判定できなかった意図として閉じた（${reason}）`, it.id)
  return a.n >= MAX_ATTEMPTS
}
// 引用がどれかの単位の本文に逐語か。
function quoteIn(L, q, units) {
  let first = null
  for (const u of new Set(units)) {
    const t = unitTextOf(L, u)
    if (t == null) continue
    const e = C.quoteProblem(q, t)
    if (!e) return null
    first = first || e
  }
  return first || '引用を照らす単位が無い'
}
const isStr = (s) => typeof s === 'string' && s.trim().length > 0
// 全体の段が足す指摘（GlobalFinding）の照合: 主張・場所（単位と逐語の引用）・義務・確信度・原因の層。onlyUnit を渡すと場所はその単位だけ。
function globalFindingProblems(L, fs, onlyUnit = null) {
  const p = []
  const ob = obligations(L).map((o) => o.id)
  ;(Array.isArray(fs) ? fs : []).forEach((f, i) => {
    if (!isStr(f && f.claim)) p.push(`findings[${i}]: claim が空`)
    const locs = Array.isArray(f && f.locations) ? f.locations : []
    if (!locs.length) p.push(`findings[${i}]: locations（単位と引用）が無い`)
    locs.forEach((l, k) => {
      if (!l || !L.assets[l.unit] || (onlyUnit && l.unit !== onlyUnit)) { p.push(`findings[${i}].locations[${k}]: 単位が台帳に無い: ${l && l.unit}`); return }
      const e = quoteIn(L, l.quote, [l.unit])
      if (e) p.push(`findings[${i}].locations[${k}]: ${e}`)
    })
    if (!ob.includes(f && f.obligation)) p.push(`findings[${i}]: obligation は目標・受け入れ基準の id: ${f && f.obligation}`)
    if (!CONFIDENCES.includes(f && f.confidence)) p.push(`findings[${i}]: confidence は ${CONFIDENCES.join('・')} のどれか`)
    if (!C.LAYERS.includes(f && f.layer)) p.push(`findings[${i}]: layer（原因の層）は ${C.LAYERS.join('・')} のどれか`)
    if (f && f.severity !== undefined && !C.SEVERITIES.includes(f.severity)) p.push(`findings[${i}]: severity は ${C.SEVERITIES.join('・')} のどれか`)
  })
  return p
}
// 意図の判定の照合。確認は、逐語でない引用では棄却も確定もできず、検証不能として受け取る（設計「全体の段と確認」の確認）。
function intentProblems(L, B, it, rep) {
  if (!rep || typeof rep !== 'object' || Array.isArray(rep)) return ['結果が object でない']
  const p = []
  // 目標の判定は、載せなかった事実（omitted_ids。--fact で引き直せる）も支えにできる。
  const visible = [...it.basis, ...it.related, ...(it.kind === 'goal' ? it.omitted_ids || [] : [])]
  const units = [...new Set(visible.map((id) => B.facts.get(id)).filter(Boolean).flatMap((f) => (f.paths && f.locations ? f.locations.map((l) => l.unit) : [f.unit])))]
  if (it.kind === 'lateral') units.push(it.unit)
  // 目標の判定は、単位の索引の全ての単位の本文で引用を照らす（抜けの場所は、結ばれた事実の無い単位にもありうる）。
  if (it.kind === 'goal') units.push(...Object.keys(L.assets).filter((id) => !L.assets[id].retro))
  if (it.kind === 'alias') {
    if (!ALIAS_ANSWERS.includes(rep.same)) p.push(`same は ${ALIAS_ANSWERS.join('・')} のどれか: ${rep.same}`)
    if (!CONFIDENCES.includes(rep.confidence)) p.push(`confidence は ${CONFIDENCES.join('・')} のどれか`)
  } else {
    if (!VERDICTS[it.kind].includes(rep.verdict)) p.push(`verdict は ${VERDICTS[it.kind].join('・')} のどれか: ${rep.verdict}`)
    if ((it.kind === 'finding' || it.kind === 'confirm') && !isStr(rep.reason)) p.push('reason が空')
  }
  // 確定に至る判定（義務に結んだ指摘を残す keep・落とした指摘を復活させる disagree）は、対象の指摘が原因の層を持たなければ layer を必須にする。
  // 判定が付ける obligation と layer は、閉じた集合で照らす（設計: 指摘は原因の層を必ず持つ）。
  if (it.kind === 'finding' || it.kind === 'confirm') {
    if (rep.obligation !== undefined && !obligations(L).some((o) => o.id === rep.obligation)) p.push(`obligation は目標・受け入れ基準の id: ${rep.obligation}`)
    if (rep.layer !== undefined && !C.LAYERS.includes(rep.layer)) p.push(`layer（原因の層）は ${C.LAYERS.join('・')} のどれか: ${rep.layer}`)
    const f = B.facts.get(it.kind === 'finding' ? it.basis[0] : it.target)
    const prev = it.kind === 'confirm' ? B.intents.find((x) => x.kind === 'finding' && x.basis[0] === it.target) : null
    // 義務に結べない指摘は確定せず参考になるので、層は求めない。
    const bound = (f && f.obligation) || rep.obligation || (prev && prev.judgment && prev.judgment.obligation)
    const toConfirm = bound && (it.kind === 'finding' ? rep.verdict === 'keep' : it.mode === 'dropped' && rep.verdict === 'disagree')
    const hasLayer = (f && f.layer) || (prev && prev.judgment && prev.judgment.layer)
    if (toConfirm && !hasLayer && rep.layer === undefined) p.push('この指摘は原因の層を持たないので、確定に至る判定は layer（原因の層）を付ける')
  }
  if (it.kind === 'confirm') return p
  const e = quoteIn(L, rep.quote, units)
  if (e) p.push(`quote: ${e}`)
  if (it.kind === 'goal' && rep.verdict === 'supported') {
    const s = Array.isArray(rep.support) ? rep.support : []
    if (!s.length) p.push('supported には支えの事実の id（support）が要る')
    for (const id of s) if (!visible.includes(id)) p.push(`support に根拠・関係する事実に無い id: ${id}`)
  }
  if (['subject', 'premise', 'goal', 'lateral'].includes(it.kind) && rep.findings !== undefined) p.push(...globalFindingProblems(L, rep.findings, it.kind === 'lateral' ? it.unit : null))
  return p
}
// 受理した判定を事実として足す。足した指摘も事実にし、判定の added に結ぶ。
function addJudgment(L, B, it, rep, w) {
  const P = L.pending
  const unverifiable = it.kind === 'confirm' && quoteIn(L, rep.quote, it.basis.map((id) => B.facts.get(id)).filter(Boolean).flatMap((f) => (f.locations ? f.locations.map((l) => l.unit) : [f.unit])))
  const jid = `J${sha(JSON.stringify([it.id, it.key, P.call_id, w.id, L.facts.length])).slice(0, 12)}`
  const fs = ['subject', 'premise', 'goal', 'lateral'].includes(it.kind) && Array.isArray(rep.findings) ? rep.findings : []
  const added = fs.map((f) => {
    const locs = f.locations.map((l) => ({ unit: l.unit, path: L.assets[l.unit].path, quote: l.quote }))
    return { id: `F${sha(JSON.stringify([it.id, it.key, C.norm(f.claim), locs.map((l) => [l.unit, C.norm(l.quote)])])).slice(0, 12)}`, type: 'finding', origin: it.kind, judgment: jid, claim: f.claim, quote: locs[0].quote, unit: locs[0].unit, path: locs[0].path, paths: [...new Set(locs.map((l) => l.path))], locations: locs, obligation: f.obligation, confidence: f.confidence, layer: f.layer, ...(f.severity ? { severity: f.severity } : {}), ...(it.kind === 'lateral' ? { lens: it.type } : {}), cycle: L.cycle }
  })
  const j = {
    id: jid, type: 'judgment', intent: it.id, kind: it.kind, key: it.key, phase: L.phase_start.cycle, cycle: L.cycle, verdict: unverifiable ? 'unverifiable' : it.kind === 'alias' ? undefined : rep.verdict,
    quote: rep.quote, ...(rep.reason ? { reason: rep.reason } : {}), ...(it.kind === 'alias' ? { same: rep.same, confidence: rep.confidence } : {}), ...(Array.isArray(rep.support) ? { support: rep.support } : {}),
    ...(rep.obligation ? { obligation: rep.obligation } : {}), ...(rep.layer ? { layer: rep.layer } : {}), ...((it.kind === 'goal' && rep.verdict === 'gap') || (it.kind === 'premise' && rep.verdict === 'unsatisfied') ? { reads: readsSig(L) } : {}),
    added: added.map((f) => f.id), call: P.call_id, worker: w.id, role: w.role, model: w.model, effort: w.effort,
  }
  L.facts.push(j, ...added.filter((f) => !L.facts.some((x) => x.id === f.id)))
  if (it.kind === 'confirm' && it.mode === 'dropped' && j.verdict === 'disagree') addEvent(L, 'global', 'restored', `${it.target}: 確認が落とした判定を誤りと判じたので復活させた`, it.target)
  if (it.kind === 'alias' && rep.same === 'unsure') addEvent(L, 'global', 'alias_unsure', `${it.id}: 名寄せが不明のまま（${(it.names || []).join(' / ')}）`, it.id)
}

// 意図の判定の提出: 照合を通れば判定を事実として足し、取りを閉じる。落ちれば理由を返して試行に数え、取りを保って出し直させる。
// 上限に達したら判定できなかった意図として閉じる（dropped）。止めずに他の意図を進める。
function submitIntent(L, id, w, rep) {
  const B = board(L)
  const c = L.pending.intent_claims[id]
  const it = B.byId.get(id)
  if (!it || it.state !== 'open') { c.done = true; return { problems: ['意図が今の根拠から外れたか、既に閉じた'], dropped: true } }
  const p = intentProblems(L, B, it, rep)
  if (p.length) {
    addEvent(L, 'global', `rejected_${it.kind}`, `${id}: ${p.join(' / ')}`, id)
    if (bumpIntent(L, it, `照合に落ちた提出: ${p.join(' / ')}`)) { c.done = true; return { problems: p, dropped: true } }
    return { problems: p, dropped: false }
  }
  addJudgment(L, B, it, rep, w)
  c.done = true
  return { problems: [], dropped: false }
}
// 束ね: この周に確定した指摘を根本原因で束ねる（束ね役 1 体）。群ごとに反証役 2 体の票を CLI が集めて、群の状態を決める。
const confirmedThisCycle = (L, B) => B.findings.list.filter((f) => f.verdict === 'confirmed' && f.cycle === L.cycle)
function groupItems(L, ids) {
  const B = board(L)
  const keys = C.groupKeys(ids.length)
  return ids.map((id, i) => { const f = B.findings.list.find((x) => x.id === id) || {}; return { key: keys[i], finding: id, paths: f.paths, claim: f.claim, quote: f.quote, severity: f.severity, layer: f.layer, obligation: f.obligation } })
}
// 束ねを諦める（試行の上限）: この周の束ねを開示して閉じ、止めずに進める。
function giveUpGrouping(L, reason) {
  L.grouping = null
  if (!L.group_cycles.includes(L.cycle)) L.group_cycles.push(L.cycle)
  addEvent(L, 'group', 'group_undecided', `周 ${L.cycle} の束ねを判定できずに開示して閉じた（${reason}）`)
}
// 群の票を集めて群を決め、新しい型から横展開の型を作る（上限の周では作らず、群だけを残して needs_input で返す）。
function finalizeGrouping(L) {
  const G = L.grouping
  if (!G) return
  const keys = C.groupKeys(G.ids.length)
  const toId = (k) => G.ids[keys.indexOf(k)]
  const cap = atCycleCap(L)
  let made = 0
  for (const gr of G.groups) {
    const votes = Object.values(G.votes[gr.id] || {})
    const n = votes.filter((v) => v.refuted).length
    const status = C.linkOnly(gr) ? 'linked' : !G.refute.includes(gr.id) || votes.length < 2 ? 'unverified' : n === 2 ? 'refuted' : n === 1 ? 'split' : 'kept'
    const id = `G${G.cycle}-${gr.id}`
    const ext = isStr(gr.extends) ? gr.extends : null
    const keep = cap && !ext && isStr(gr.pattern) ? { applies_to: [...new Set(gr.applies_to)] } : {}
    L.groups.push({ id, cycle: G.cycle, root_cause: gr.root_cause, layer: gr.layer, keys: (gr.keys || []).map(toId), pattern: gr.pattern, status, votes, ...(ext ? { extends: ext } : {}), ...keep })
    if (status === 'refuted' || ext || cap || !isStr(gr.pattern)) continue
    if (addLateral(L, id, { ...gr, keys: (gr.keys || []).map(toId) })) made += 1
  }
  L.saturation.push({ cycle: G.cycle, confirmed_new: G.ids.length, groups: G.groups.length, lateral_types: made })
  L.grouping = null
  if (!L.group_cycles.includes(G.cycle)) L.group_cycles.push(G.cycle)
  if (made) L.cycle += 1
}

function cmdNext(o) {
  const dir = path.resolve(need(o, 'state'))
  return withLock(dir, () => next(dir))
}
function next(dir) {
  const L = load(dir)
  writeLauncher(dir)
  // 開いた呼び出しがある間は、同じ呼び出し（同じ callId と args）を返す（冪等。B6）。閉じるのは ingest --call だけにし、
  // 司令塔が next を流し直しても、Workflow の実行中の claim・submit を壊さない。台帳は今の対象に合わせる（変わった単位だけが読み直しになり、
  // 変わっていない単位の取りは残る）。
  if (L.pending) {
    const P = L.pending
    const { assets } = currentAssets(L, dir)
    const changes = refresh(L, assets)
    L.static = staticFacts(L)
    save(dir, L)
    return { step: P.step, call_id: P.call_id, workflow: WORKFLOW, args_path: P.args_path, estimate_agents: P.workers.length, limits: C.LIMITS, cycle: P.cycle, coverage: coverage(L), changes }
  }
  // blocked（failure）の後の next は、原因を直した再開として扱い、連続の数と環境の失敗に数えた試行を戻す。
  if (L.stopped && L.stopped.stop === 'blocked' && L.stopped.cause === 'failure') {
    L.fail_streak = 0
    for (const a of Object.values(L.assets)) if (a.env_attempts) { a.attempts -= a.env_attempts; a.env_attempts = 0; if (a.state === 'disclosed' && a.attempts < MAX_ATTEMPTS) { a.state = 'unseen'; a.reason = '' } }
    for (const [k, n] of Object.entries(L.env_attempts)) { L.attempts[k] -= n; if (L.attempts[k] <= 0) delete L.attempts[k] }
    L.env_attempts = {}
  }
  const { assets, missing } = currentAssets(L, dir)
  capCycles(L)
  expandLateral(L)
  const changes = refresh(L, assets)
  L.static = staticFacts(L)
  // 止まった後に対象が変わったら、読み直しの新しい回を始める（設計「再レビューと持ち越し」）。今の回より前の周の読みは持ち越しになり、
  // 今回変わらなかった単位の前の読みの印（prior）は消す（前の回で変わった印を、次の回の出どころに持ち込まない）。
  let newRound = !!L.stopped && (changes.added.length + changes.stale.length + changes.gone.length) > 0
  const touched = new Set([...changes.added, ...changes.stale])
  for (;;) {
    openCycle(L)
    skipStuckPlan(L)
    if (newRound) {
      L.round_start = L.cycle
      for (const [id, a] of Object.entries(L.assets)) if (!touched.has(id)) delete a.prior
      newRound = false
    }
    const d = decide(L, { missingTargets: missing })
    if (d.stop) {
      L.stopped = { ...d, cycle: L.cycle }
      // run の記録: 止まるたびに 1 件（同じ呼び出しの数のまま同じ停止を返し直すときは足さない）。
      L.run_records = L.run_records || []
      const last = L.run_records.at(-1)
      if (!last || last.call_seq !== L.call_seq || last.stop !== d.stop) L.run_records.push({ call_seq: L.call_seq, stop: d.stop, ...runMetrics(L) })
      save(dir, L)
      // どの停止でも、status と同じ中身を stateDir/status-<段>.json に書く（呼ぶ側は status の出力を写さず、このファイルを path で読む）。
      writeAtomic(statusPath(dir, L), JSON.stringify(statusOf(L)))
      return { ...d, changes, coverage: coverage(L), status_path: statusPath(dir, L), next_args: d.stop === 'complete' ? null : { state: dir } }
    }
    // 静的に済む段は agent を起動せずに進める。coverage-build から渡された台帳（照合済みの印）は振り返りの単位を作らない。
    if (d.step === 'retro') {
      if (L.goal.checked_by !== 'coverage-build') refresh(L, retroAssets(L).map((a) => ({ ...a, snap: writeSnap(dir, a.text) })), { partial: true })
      L.retro_cycles.push(L.cycle)
      continue
    }
    // この周に確定した指摘が無ければ束ねない（agent を起動しない）。
    if (d.step === 'group' && !confirmedThisCycle(L, board(L)).length) {
      L.group_cycles.push(L.cycle)
      continue
    }
    const unread = hints(dir).filter((h) => !L.hints_read.includes(h.id))
    const { rows, tasks, kinds } = stageTasks(L, d)
    L.call_seq += 1
    const callId = sha(`${dir}|${L.call_seq}|${d.step}|${L.cycle}|${L.rev}`).slice(0, 12)
    const workers = rows.map((r) => ({ id: r.id, role: r.role, model: L.roles[r.role].model, effort: L.roles[r.role].effort }))
    const args = { state: dir, callId, stage: d.step, workers }
    const argsPath = path.join(dir, `call-${callId}.json`)
    writeAtomic(argsPath, JSON.stringify(args))
    // 止まっている間だけ status のファイルがある形にする（呼ぶ側が前の停止の status を取り込まない）。
    rmSync(statusPath(dir, L), { force: true })
    L.pending = { call_id: callId, step: d.step, args_path: argsPath, workers, tasks, ...(kinds ? { kinds, intent_claims: {} } : {}), hints: unread.map((h) => h.id), cycle: L.cycle, events_at: L.events.length, claims: 0, submits: 0 }
    save(dir, L)
    return { step: d.step, call_id: callId, workflow: WORKFLOW, args_path: argsPath, estimate_agents: workers.length, limits: C.LIMITS, cycle: L.cycle, coverage: coverage(L), changes }
  }
}

const bump = (L, k, env) => {
  L.attempts[k] = (L.attempts[k] || 0) + 1
  if (env) L.env_attempts[k] = (L.env_attempts[k] || 0) + 1
}
const clear = (L, k) => { delete L.attempts[k] }
const stageOf = (a) => (a && a.retro ? 'retro' : 'file')
// 開いた呼び出しを閉じる。取ったまま提出されなかった単位は試行に数えて取りを外し、上限で理由つきの disclosed にする。
// 提出されなかった計画の段の担当は、その鍵の試行に数える（env なら環境の失敗にも数え、blocked（failure）からの再開で戻す）。
function closeCall(L, { env = false } = {}) {
  const P = L.pending
  if (!P) return
  for (const [id, a] of Object.entries(L.assets)) {
    if (!a.claim || a.claim.call !== P.call_id) continue
    a.claim = null
    a.attempts += 1
    if (env) a.env_attempts = (a.env_attempts || 0) + 1
    addEvent(L, stageOf(a), 'missing_read', `${id}: 読む役が取ったまま提出しなかった`, id)
    if (a.attempts >= MAX_ATTEMPTS) {
      a.state = 'disclosed'
      a.reason = `読む役が取ったまま提出しなかった（試行 ${a.attempts} 回）`
      addEvent(L, 'control', 'disclosed', `${id} を試行 ${a.attempts} 回で開示に倒した`, id)
    }
  }
  for (const t of P.tasks || []) {
    if (t.done || t.kind === 'plan' || t.kind === 'refute') continue
    bump(L, t.akey, env)
    addEvent(L, t.kind === 'group' ? 'group' : 'plan', `missing_${t.kind}`, `${t.id}: 担当が提出されなかった`, t.id)
    if (t.kind === 'group' && L.attempts[t.akey] >= MAX_ATTEMPTS) giveUpGrouping(L, `束ね役の試行 ${L.attempts[t.akey]} 回`)
  }
  // 取ったまま提出されなかった意図は試行に数え、上限で判定できなかった意図として閉じる。
  if (P.step === 'global') {
    const B = board(L)
    for (const [id, c] of Object.entries(P.intent_claims || {})) {
      if (c.done) continue
      const it = B.byId.get(id)
      if (!it || it.state !== 'open') continue
      addEvent(L, 'global', 'missing_intent', `${id}: 意図を取ったまま提出しなかった`, id)
      bumpIntent(L, it, '取ったまま提出されなかった')
    }
  }
  // 反証の票はここで集める（返らなかった票は数えず、2 票に足りない群は unverified）。
  if (P.step === 'refute') finalizeGrouping(L)
  // 計画役は 2 体のどちらかの案があれば統合に進む。どちらも無ければ計画の試行に数える。
  if (P.step === 'plan') {
    if (L.plan_drafts && Object.keys(L.plan_drafts.drafts).length) L.plan_drafts.closed = true
    else { L.plan_drafts = null; bump(L, 'plan', env); addEvent(L, 'plan', 'blocked', '計画役が 2 体とも案を出さなかった') }
  }
  L.pending = null
}

function recordCall(L, P, res, failed) {
  const ag = Array.isArray(res.agents) ? res.agents : []
  for (const a of ag) L.agents.push({ call_id: P.call_id, cycle: L.cycle, stage: P.step, role: a.role, label: a.label, model: a.model, effort: a.effort, ok: !!a.ok })
  const tokens = typeof res.tokens === 'number' && Number.isFinite(res.tokens) ? res.tokens : null
  L.calls.push({ call_id: P.call_id, cycle: L.cycle, step: P.step, agents: ag.length, failed: ag.filter((a) => !a.ok).length, submits: P.submits, tokens, tokens_note: tokens == null ? '消費量を run の中で読めない経路（runner など）' : 'この呼び出しの budget.spent() の差' })
  L.fail_streak = failed ? L.fail_streak + 1 : 0
  for (const a of ag) if (!a.ok) addEvent(L, P.step, 'agent_missing', `${a.label}（${a.model}/${a.effort}）が返らなかったか不正な出力だった`, a.label)
}

// native Workflow の tasks の .output（返り値を result に包んだ形）も、そのまま受け付ける。包みの判定は coverage-build の build-cli.mjs と同じ。
export function unwrap(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return v
  return Object.hasOwn(v, 'result') && typeof v.summary === 'string' && typeof v.agentCount === 'number' ? v.result : v
}

// ingest: --call の呼び出しを閉じるだけ（B3）。返り値から読むのは起動の記録（agents）と tokens だけで、役の出力や集約は受け取らない（全て submit で台帳に入っている）。
// 全ての役が欠けた呼び出しと、提出が 1 件も無いファイルの段の呼び出しと、claim が 1 度も無い全体の段の呼び出しは、環境の失敗に数える
// （全体の段の行は開いた意図のある種類にだけ作るので、claim が無ければ worker が起動されていない。取った後に提出が無いのは意図の試行に数える）。
function cmdIngest(o) {
  const dir = path.resolve(need(o, 'state'))
  return withLock(dir, () => ingest(dir, o))
}
function ingest(dir, o) {
  const L = load(dir)
  const call = need(o, 'call')
  const P = L.pending
  if (!P || P.call_id !== call) throw new Fail(`閉じる呼び出しが違うか、既に閉じている: 開いているのは ${P ? `${P.step}/${P.call_id}` : '無し'}、受け取ったのは ${call}`)
  const res = unwrap(JSON.parse(read(need(o, 'result'))))
  const r = res && typeof res === 'object' ? res : {}
  const ag = Array.isArray(r.agents) ? r.agents : []
  const allFailed = (ag.length > 0 && ag.every((a) => !a.ok)) || (P.step === 'file' && !P.submits) || (P.step === 'global' && !P.claims)
  recordCall(L, P, r, allFailed)
  L.hints_read.push(...P.hints)
  const rejected = L.events.slice(P.events_at).filter((e) => e.kind.startsWith('rejected_')).map((e) => e.text)
  closeCall(L, { env: allFailed })
  save(dir, L)
  return { ok: true, cycle: L.cycle, coverage: coverage(L), ...(rejected.length ? { rejected } : {}), next: 'next を流す' }
}

// ---------------- 担当（worker が Bash で流す claim・query・submit） ----------------
// どれも、今開いている呼び出し（pending）の --call と、その args の workers の行の --worker からだけ受け付ける。外れたら台帳を変えずに拒否する（終了状態 2）。
function pendingWorker(L, o) {
  const call = need(o, 'call')
  const worker = need(o, 'worker')
  if (!L.pending) throw new Fail(`開いた呼び出しが無い（呼び出し ${call} は閉じた。worker を終える）`)
  if (call !== L.pending.call_id) throw new Fail(`呼び出しが違う: 今は ${L.pending.call_id}、受け取ったのは ${call}（前の呼び出しは閉じた。worker を終える）`)
  const w = L.pending.workers.find((x) => x.id === worker)
  if (!w) throw new Fail(`この呼び出しの workers に無い worker: ${worker}`)
  return w
}
const sq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`
const CLI_PATH = fileURLToPath(import.meta.url)
const resultPath = (dir, call, worker, taskId) => path.join(dir, 'results', call, worker, `${sha(taskId).slice(0, 16)}.json`)
const submitCmd = (dir, call, w) => [process.execPath, CLI_PATH, 'submit', '--state', dir, '--call', call, '--worker', w.id].map(sq).join(' ')
const fileTaskId = (unitId) => `file:${sha(unitId).slice(0, 12)}`
const hintsOf = (dir, ids) => hints(dir).filter((h) => ids.includes(h.id))
// ファイルの段の担当: 1 単位（写しの範囲）と、全ての観点と、義務（目標・受け入れ基準）。他の単位の本文・id・事実は返さない。
function fileTask(L, dir, call, w, id) {
  const a = L.assets[id]
  const tid = fileTaskId(id)
  const hs = hintsOf(dir, L.pending.hints)
  return {
    id: tid, kind: 'file', result_path: resultPath(dir, call, w.id, tid), unit: { id, path: a.path, file: a.snap, start: a.start, end: a.end },
    lenses: lensesFor(L, a).map((l) => ({ id: l.id, name: l.name, procedure: l.procedure })), obligations: obligations(L), ...(hs.length ? { hints: hs } : {}),
  }
}
const boundTask = (dir, call, t) => ({ id: t.id, kind: t.kind, result_path: resultPath(dir, call, t.worker, t.id), ...(t.lens ? { lens: t.lens } : {}), ...(t.who ? { who: t.who } : {}), ...(t.group ? { group: t.group } : {}) })

// claim: ファイルの段は、まだ読んでいない単位を 1 つ取る（出し終えていない担当を持っていれば、それを同じ形で返す）。計画の段は、行に結んだ担当を返す。
// 取る物が無ければ done。返す前に結果の path の古いファイルを消す。
function cmdClaim(o) {
  const dir = path.resolve(need(o, 'state'))
  return withLock(dir, () => {
    const L = load(dir)
    const w = pendingWorker(L, o)
    const P = L.pending
    const call = P.call_id
    P.claims += 1
    let task = null
    if (P.step === 'file') {
      // 1 worker は 1 つの呼び出しで 1 単位だけを読む。出し終えた（受理か開示）後の claim は done を返す（同じ文脈で次の単位を読ませない）。
      P.file_taken = P.file_taken || {}
      let id = Object.keys(L.assets).find((k) => L.assets[k].claim && L.assets[k].claim.call === call && L.assets[k].claim.worker === w.id)
      if (!id && !P.file_taken[w.id]) {
        id = todoUnits(L).find((k) => !L.assets[k].claim)
        if (id) { L.assets[id].claim = { call, worker: w.id }; P.file_taken[w.id] = id }
      }
      if (id) task = fileTask(L, dir, call, w, id)
    } else if (P.step === 'global') {
      // 出し終えていない意図を持っていればそれを返し、無ければ自分の種類の開いた意図を 1 つ取る（取る順は意図の並び）。
      const B = board(L)
      let id = Object.keys(P.intent_claims).find((k) => P.intent_claims[k].worker === w.id && !P.intent_claims[k].done)
      if (id && (!B.byId.get(id) || B.byId.get(id).state !== 'open')) { P.intent_claims[id].done = true; id = null }
      const onlyOne = (P.kinds[w.id] || []).every((k) => ONE_PER_WORKER.includes(k)) && Object.values(P.intent_claims).some((c) => c.worker === w.id)
      if (!id && !onlyOne) {
        const it = B.intents.find((i) => i.state === 'open' && (P.kinds[w.id] || []).includes(i.kind) && !P.intent_claims[i.id])
        if (it) { id = it.id; P.intent_claims[id] = { worker: w.id, done: false } }
      }
      if (id) task = intentTask(L, dir, call, w, B.byId.get(id))
    } else {
      const t = P.tasks.find((x) => x.worker === w.id && !x.done)
      if (t) { t.claimed = true; task = boundTask(dir, call, t) }
    }
    save(dir, L)
    if (!task) return { ok: true, done: true }
    mkdirSync(path.dirname(task.result_path), { recursive: true })
    rmSync(task.result_path, { force: true })
    return { ok: true, tasks: [task], submit_cmd: submitCmd(dir, call, w) }
  })
}

// query: 担当が読む入力を台帳から引く（B1）。ファイルの段の担当は拒む（他の単位の書き込みを読まず、独立に読む）。
// 計画の段の担当には、その担当が要る文（目標・依頼文・索引・案・欠陥・回答・観点）だけを返す。--fact は今の根拠の事実を id で引く。
function cmdQuery(o) {
  const dir = path.resolve(need(o, 'state'))
  return withLock(dir, () => {
    const L = load(dir)
    const w = pendingWorker(L, o)
    const P = L.pending
    const tid = need(o, 'task')
    if (P.step === 'file' || tid.startsWith('file:')) throw new Fail('ファイルの段の担当は query できない（他の単位の書き込みを読まない。B1）')
    const B = board(L)
    const facts = (o.fact || []).map((id) => { if (!B.facts.has(id)) throw new Fail(`今の根拠に無い事実: ${id}`); return publicFact(B.facts.get(id)) })
    if (P.step === 'global') {
      // 意図の根拠と関係する事実だけを返す（B1）。前の判定は今の根拠から外れているので返さない。載せなかった件数は omitted で宣言する。
      const id = Object.keys(P.intent_claims).find((k) => intentTaskId(k, P.call_id) === tid && P.intent_claims[k].worker === w.id)
      if (!id) throw new Fail(`この worker が取った意図の担当に無い: ${tid}`)
      const it = B.byId.get(id)
      if (!it) throw new Fail(`意図が今の根拠から外れた: ${id}（next からやり直す）`)
      const pub = (ids) => ids.map((x) => B.facts.get(x)).filter(Boolean).map(publicFact)
      const ids = it.omitted_ids || []
      return {
        ok: true, task: tid, kind: it.kind, intent: { id: it.id, kind: it.kind, ...(it.item ? { item: it.item } : {}) }, basis: pub(it.basis), related: pub(it.related),
        omitted: it.omitted, omitted_ids: ids.slice(0, OMITTED_IDS_MAX), ...(ids.length > OMITTED_IDS_MAX ? { omitted_more: ids.length - OMITTED_IDS_MAX } : {}),
        ...(it.kind === 'goal' ? { units: unitIndex(L) } : {}), ...(o.fact ? { facts } : {}),
      }
    }
    const t = P.tasks.find((x) => x.id === tid && x.worker === w.id)
    if (!t) throw new Fail(`この worker の担当に無い: ${tid}`)
    return { ok: true, task: t.id, kind: t.kind, inputs: inputsOf(L, dir, t), ...(o.fact ? { facts } : {}) }
  })
}
const item = (c) => ({ id: c.id, text: c.text })
// 索引: 1 行 1 単位（id・写し・範囲・見出しの経路・種類・先頭の数語）。計画役・統合役・精査役・検証役が単位を選ぶ。
const INDEX_HEAD_WORDS = 8
const INDEX_HEAD_CHARS = 40
function indexRows(L, ids = null) {
  const texts = new Map()
  const textOf = (f) => { if (!texts.has(f)) texts.set(f, read(f)); return texts.get(f) }
  const head = (a) => Array.from(C.norm(rangeText(textOf(a.snap), a.start, a.end)).split(' ').slice(0, INDEX_HEAD_WORDS).join(' ')).slice(0, INDEX_HEAD_CHARS).join('').trim()
  return Object.entries(L.assets).filter(([id, a]) => !a.retro && (!ids || ids.includes(id))).map(([id, a]) => ({ id, file: a.snap, start: a.start, end: a.end, trail: (a.trail || []).join(' > '), kind: a.kind, head: head(a) }))
}
function inputsOf(L, dir, t) {
  const base = { goal: L.goal.text, items: L.goal.items.map(item), criteria: L.criteria.map(item), constraints: L.constraints.map(item), hints: hintsOf(dir, L.pending.hints) }
  if (t.kind === 'goal_check') return { ...base, request: L.request, decisions: L.decisions, item_ids: goalIds(L) }
  if (t.kind === 'plan') return { ...base, index: indexRows(L), given_lenses: givenLenses(L).map((l) => ({ id: l.id, name: l.name, procedure: l.procedure })) }
  if (t.kind === 'integrate') {
    const given = { given_lenses: givenLenses(L).map((l) => ({ id: l.id, name: l.name, procedure: l.procedure })) }
    if (!t.again) {
      const drafts = Object.fromEntries(Object.entries(L.plan_drafts.drafts).map(([who, x]) => [who, { plan: x.plan, problems: x.problems }]))
      return { ...base, ...given, index: indexRows(L), drafts, sources: Object.entries(drafts).flatMap(([who, x]) => (x.plan.lenses || []).map((u) => `${who}:${u.id}`)) }
    }
    return { ...base, ...given, index: indexRows(L), previous_plan: L.plan, defects: L.plan_defects.map((x, i) => ({ index: i, ...x })), answers: L.answers.filter((a) => t.answerIds.includes(a.id)), sources: ((L.plan && L.plan.lenses) || []).map((u) => `P:${u.id}`) }
  }
  if (t.kind === 'group') return { ...base, items: groupItems(L, t.items), index: indexRows(L), lateral: L.lateral_types.map((x) => ({ id: x.id, pattern: x.pattern, root_cause: x.root_cause })) }
  if (t.kind === 'refute') {
    const g = L.grouping.groups.find((x) => x.id === t.group)
    const items = groupItems(L, L.grouping.ids)
    return { ...base, group: { id: g.id, root_cause: g.root_cause, layer: g.layer, keys: g.keys }, items: items.filter((x) => (g.keys || []).includes(x.key)) }
  }
  const lenses = (L.plan && L.plan.lenses) || []
  const u = lenses.find((x) => x.id === t.lens)
  return { ...base, lens: u, index: indexRows(L) }
}

// submit: その worker がこの呼び出しで取って、まだ出し終えていない担当のうち、結果の path にファイルがある担当を出す（無い担当は missing）。
// 照合に落ちた提出は理由を返して試行に数え（ok: false）、取ったままにして出し直せるようにする。上限に達したら開示に倒す（dropped: true）。
function cmdSubmit(o) {
  const dir = path.resolve(need(o, 'state'))
  return withLock(dir, () => {
    const L = load(dir)
    const w = pendingWorker(L, o)
    const P = L.pending
    const call = P.call_id
    const results = []
    const missing = []
    const rep = (f) => { try { return JSON.parse(read(f)) } catch { return null } }
    if (P.step === 'file') {
      for (const id of Object.keys(L.assets).filter((k) => L.assets[k].claim && L.assets[k].claim.call === call && L.assets[k].claim.worker === w.id)) {
        const task = fileTask(L, dir, call, w, id)
        if (!existsSync(task.result_path)) { missing.push(task.id); continue }
        const r = submitFile(L, id, task, w, rep(task.result_path))
        if (r.problems.length) rmSync(task.result_path, { force: true })
        results.push({ task: task.id, unit: id, ok: !r.problems.length, problems: r.problems, dropped: r.dropped })
      }
    } else if (P.step === 'global') {
      for (const id of Object.keys(P.intent_claims).filter((k) => P.intent_claims[k].worker === w.id && !P.intent_claims[k].done)) {
        const tid = intentTaskId(id, call)
        const f = resultPath(dir, call, w.id, tid)
        if (!existsSync(f)) { missing.push(tid); continue }
        const r = submitIntent(L, id, w, rep(f))
        if (r.problems.length) rmSync(f, { force: true })
        results.push({ task: tid, intent: id, ok: !r.problems.length, problems: r.problems, dropped: r.dropped })
      }
    } else {
      for (const t of P.tasks.filter((x) => x.worker === w.id && !x.done)) {
        const f = resultPath(dir, call, w.id, t.id)
        if (!existsSync(f)) { missing.push(t.id); continue }
        const r = submitBound(L, t, rep(f))
        if (r.problems.length) rmSync(f, { force: true })
        results.push({ task: t.id, ok: !r.problems.length, problems: r.problems, dropped: r.dropped, ...(r.notes ? { notes: r.notes } : {}) })
      }
    }
    if (results.length) { P.submits += results.length; save(dir, L) }
    return { ok: true, results, missing }
  })
}

// 単位の本文（写しの範囲）。写しの hash が台帳と違えば受け付けない。
function unitText(L, id) {
  const a = L.assets[id]
  const text = existsSync(a.snap) ? read(a.snap) : null
  if (text == null || rangeHash(text, a.start, a.end) !== a.hash) throw new Fail(`写しの hash が台帳と違う（写しが書き換わった。next からやり直す）: ${a.snap}`)
  return rangeText(text, a.start, a.end)
}
// ファイルの段の提出: 照合を通れば、受理した読み（版・実行役の条件・観点ごとの答えと引用）を単位に置き、事実を足して seen にする。
function submitFile(L, id, task, w, rep) {
  const a = L.assets[id]
  const p = checkFileResult(rep, { text: unitText(L, id), lensIds: task.lenses.map((l) => l.id), obligationIds: task.obligations.map((x) => x.id) })
  if (p.length) {
    a.attempts += 1
    addEvent(L, stageOf(a), 'rejected_file', `${id}: ${p.join(' / ')}`, id)
    if (a.attempts < MAX_ATTEMPTS) return { problems: p, dropped: false }
    Object.assign(a, { state: 'disclosed', claim: null, reason: `照合に落ちた提出が ${a.attempts} 回: ${p.join(' / ')}` })
    addEvent(L, 'control', 'disclosed', `${id} を試行 ${a.attempts} 回で開示に倒した`, id)
    return { problems: p, dropped: true }
  }
  const lv = lensSetVersion(L, a)
  const readId = `R${sha(JSON.stringify([id, a.hash, lv, L.pending.call_id, w.id])).slice(0, 12)}`
  a.read = { id: readId, hash: a.hash, lens_version: lv, cycle: L.cycle, call: L.pending.call_id, worker: w.id, role: w.role, model: w.model, effort: w.effort, seen: rep.seen.map((x) => ({ lens: x.lens, answer: x.answer, quote: x.quote })) }
  Object.assign(a, { state: 'seen', claim: null, reason: '' })
  const have = new Set(L.facts.map((f) => `${f.read}|${f.id}`))
  for (const f of factsOf(rep, { unit: id, path: a.path, read: readId, cycle: L.cycle })) if (!have.has(`${f.read}|${f.id}`)) L.facts.push(f)
  return { problems: [], dropped: false }
}

// 計画の段の提出。照合の式は Workflow source の <checks>（C）を使う。
// 計画役と統合役は、落ちたら 1 回だけ出し直させ（今の検査のやり直しと同じ）、出し直しでも残る外れは案に添えて受け取る（統合役の外れは計画の欠陥 P<n> になる）。
// 目標の照合役・精査役・検証役は、落ちた提出をその鍵の試行に数え、上限で担当を閉じる（stuck → needs_input）。
function submitBound(L, t, rep) {
  t.tries = (t.tries || 0) + 1
  if (t.kind === 'group') {
    const keys = C.groupKeys(t.items.length)
    const p = rep && typeof rep === 'object' ? C.checkGroups(rep, keys, Object.keys(L.assets).filter((id) => !L.assets[id].retro), lateralTypeIds(L)) : ['結果が object でない']
    if (p.length) {
      bump(L, t.akey, false)
      addEvent(L, 'group', 'rejected_grouping', p.join(' / '))
      if (L.attempts[t.akey] >= MAX_ATTEMPTS) { t.done = true; giveUpGrouping(L, `束ね役の試行 ${L.attempts[t.akey]} 回`); return { problems: p, dropped: true } }
      return { problems: p, dropped: false }
    }
    clear(L, t.akey)
    const refute = rep.groups.filter((g) => !C.linkOnly(g)).map((g) => g.id).slice(0, Math.floor(C.LIMITS.maxAgents / 2))
    L.grouping = { cycle: L.cycle, groups: rep.groups, ids: t.items, refute, votes: {} }
    t.done = true
    if (!refute.length) finalizeGrouping(L)
    return { problems: [], dropped: false }
  }
  if (t.kind === 'refute') {
    const p = !rep || typeof rep !== 'object' ? ['結果が object でない'] : [...(rep.group_id !== t.group ? [`group_id は ${t.group}`] : []), ...(typeof rep.refuted !== 'boolean' ? ['refuted は true か false'] : []), ...(isStr(rep.reason) ? [] : ['reason が空'])]
    if (p.length) { addEvent(L, 'group', 'rejected_refute', `${t.id}: ${p.join(' / ')}`, t.id); if (t.tries >= MAX_ATTEMPTS) t.done = true; return { problems: p, dropped: t.done } }
    L.grouping.votes[t.group] = { ...(L.grouping.votes[t.group] || {}), [t.who]: { refuted: rep.refuted, reason: rep.reason } }
    t.done = true
    return { problems: [], dropped: false }
  }
  const ctx = planCtx(L)
  const reject = (kind, p) => {
    bump(L, t.akey, false)
    addEvent(L, 'plan', kind, `${t.id}: ${p.join(' / ')}`, t.id)
    if (L.attempts[t.akey] >= MAX_ATTEMPTS) { t.done = true; return { problems: p, dropped: true } }
    return { problems: p, dropped: false }
  }
  if (t.kind === 'goal_check') {
    const p = C.checkGoalMap(rep, goalIds(L), goalSources(L))
    if (p.length) return reject('rejected_goal_check', p)
    clear(L, 'goal')
    L.goal.problems = C.goalGaps(rep)
    L.goal.checked = !L.goal.problems.length
    t.done = true
    return { problems: [], dropped: false }
  }
  if (t.kind === 'plan') {
    const p = planProblems(rep, ctx)
    if (p.length && (t.tries < MAX_ATTEMPTS || !rep || typeof rep !== 'object')) { addEvent(L, 'plan', 'rejected_plan', `${t.id}: ${p.join(' / ')}`, t.id); return { problems: p, dropped: false } }
    L.plan_drafts = L.plan_drafts || { drafts: {}, closed: false }
    L.plan_drafts.drafts[t.who] = { plan: rep, problems: p }
    t.done = true
    return { problems: [], dropped: false, ...(p.length ? { notes: p } : {}) }
  }
  if (t.kind === 'integrate') {
    const sources = t.again ? ((L.plan && L.plan.lenses) || []).map((u) => `P:${u.id}`) : Object.entries(L.plan_drafts.drafts).flatMap(([who, x]) => (x.plan.lenses || []).map((u) => `${who}:${u.id}`))
    const p = planProblems(rep, { ...ctx, sources, ...(t.again ? { defectCount: L.plan_defects.length } : {}) })
    if (p.length && (t.tries < MAX_ATTEMPTS || !rep || typeof rep !== 'object')) { addEvent(L, 'plan', 'rejected_integrate', `${t.id}: ${p.join(' / ')}`, t.id); return { problems: p, dropped: false } }
    clear(L, 'plan')
    if (L.plan) L.plan_rounds += 1
    L.plan_defects = []
    L.plan = rep
    // 計画を変えたら全体を検証し直す: 統合のたびに全ての観点を精査し直し、落とした観点の記録も今の計画のものにする。
    L.plan_problems = planProblems(rep, ctx)
    for (const x of L.plan_problems) { addPlanDefect(L, { unit_id: '', kind: 'static', claim: x, quote: '' }); addEvent(L, 'plan', 'static_problem', x) }
    L.answered.push(...t.answerIds)
    L.plan_drafts = null
    syncPlanLenses(L)
    t.done = true
    return { problems: [], dropped: false }
  }
  const lenses = (L.plan && L.plan.lenses) || []
  const u = lenses.find((x) => x.id === t.lens)
  // 計画が変わった後の担当は使わない（次の呼び出しで今の観点を精査・検証する）。
  if (!u || C.unitKey(u) !== t.key) { t.done = true; return { problems: ['計画が変わった後の担当（今の計画の観点と違う）'], dropped: true } }
  const goals = Array.isArray(u.goals) ? u.goals : []
  const p = C.checkUnitVerdict(rep, u.id, goals, C.unitText(u))
  if (p.length) return reject('rejected_unit_check', p)
  clear(L, t.akey)
  const ds = C.unitDefects(rep, u.id, goals)
  if (ds.length) for (const d of ds) { addPlanDefect(L, d); addEvent(L, 'plan', 'unit_defect', `${u.id}: ${d.claim}`, u.id) }
  else L.verified_units.push(t.key)
  t.done = true
  return { problems: [], dropped: false }
}
// 新しい型の群から横展開の型を作る（既にあれば作らない）。型の当たる単位ごとに、型を問い直す横展開の意図ができる（board）。
// 根拠は型を作った確定した指摘で、足した読みは元の読みと区別して記録する（指摘の origin は lateral）。
function addLateral(L, id, gr) {
  const t = { id: `lat-${id}`, group: id, root_cause: gr.root_cause, pattern: gr.pattern, applies_to: [...new Set(gr.applies_to)].filter((u) => L.assets[u]), findings: (gr.keys || []).filter(Boolean), cycle: L.cycle }
  if (L.lateral_types.some((x) => x.id === t.id)) return false
  L.lateral_types.push(t)
  return true
}
// 上限の周で展開しなかった今の周の群は、config --max-cycles で上限を上げた後の next が展開し、次の周を開く（回答した群は展開しない）。
function expandLateral(L) {
  if (atCycleCap(L) || !L.group_cycles.includes(L.cycle)) return false
  const gs = lateralGroups(L).filter((g) => g.cycle === L.cycle)
  let made = 0
  for (const g of gs) if (Array.isArray(g.applies_to) && g.applies_to.length && addLateral(L, g.id, g)) made += 1
  if (made) L.cycle += 1
  return made > 0
}

// 今の段の status の節: 指摘・束ね・出来事。reframe で出ていく段の節は、この形のまま phase_records に写す。
// 判定・単位・norm した quote と claim・layer が同じ今の指摘を 1 件にまとめる。
function mergedFindings(L) {
  const m = new Map()
  for (const f of currentFindings(L)) {
    const k = JSON.stringify([f.verdict, Array.isArray(f.paths) ? [...f.paths].sort().join('\n') : f.id.split('|')[0], C.norm(f.quote), C.norm(f.claim), f.layer])
    if (m.has(k)) m.get(k).ids.push(f.id)
    else m.set(k, { ...f, ids: [f.id] })
  }
  return [...m.values()]
}
function phaseSection(L) {
  const cur = mergedFindings(L)
  const by = (k) => cur.reduce((m, f) => ({ ...m, [f[k]]: (m[f[k]] || 0) + 1 }), {})
  const groupsOf = (ids) => L.groups.filter((g) => g.status !== 'refuted' && (g.keys || []).some((k) => ids.includes(k))).map((g) => g.id)
  return {
    findings: { by_verdict: by('verdict'), by_layer: by('layer'), confirmed: cur.filter((f) => f.verdict === 'confirmed').map((f) => ({ id: f.id, ids: f.ids, severity: f.severity, layer: f.layer, claim: f.claim, quote: f.quote, ...(f.paths ? { paths: f.paths, obligation: f.obligation, confidence: f.confidence, origin: f.origin, provenance: provenance(L, f) } : {}), groups: [...new Set(groupsOf(f.ids))] })), unverifiable: cur.filter((f) => f.verdict === 'unverifiable').map((f) => ({ id: f.id, ids: f.ids, claim: f.claim })) },
    groups: L.groups.map((g) => ({ id: g.id, status: g.status, layer: g.layer, root_cause: g.root_cause, lateral: (L.lateral_types || []).some((t) => t.id === `lat-${g.id}`), ...(g.extends ? { extends: g.extends } : {}) })),
    events: phaseEvents(L).map((e) => ({ id: e.id, stage: e.stage, kind: e.kind, text: e.text })),
  }
}
// 事実の公開の形（受理した読みの id は載せない）。
const publicFact = (f) => { const { read: _r, ...rest } = f; return rest }
// 単位の一覧（振り返りの単位を除く）。disclosed は見られなかった理由（reason）を持つ。
// carried は持ち越した読み（今の回より前の周に受理した読み）の印。
function unitsOf(L) {
  return Object.entries(L.assets).filter(([, a]) => !a.retro).map(([id, a]) => ({ id, path: a.path, file: a.snap, start: a.start, end: a.end, hash: a.hash, state: a.state, ...(a.state === 'disclosed' ? { reason: a.reason } : {}), ...(carriedRead(L, a) ? { carried: true } : {}) }))
}
// 止まったときに書く status のファイル。段が無い台帳（呼ぶ側が段を渡さない）は status.json。
export const statusPath = (dir, L) => path.join(dir, L.phase ? `status-${L.phase}.json` : 'status.json')
function cmdStatus(o) {
  const dir = path.resolve(need(o, 'state'))
  return statusOf(load(dir))
}
function statusOf(L) {
  const sec = phaseSection(L)
  const roles = {}
  for (const a of L.agents) { const k = `${a.role}|${a.model}|${a.effort}`; roles[k] = roles[k] || { launched: 0, failed: 0 }; roles[k].launched++; if (!a.ok) roles[k].failed++ }
  const B = board(L)
  const facts = [...B.facts.values()]
  return {
    // 上の階層の findings・groups・events は今の段のもの。phases は段ごとの節（出ていった段は phase_records の写し）。
    phase: L.phase, phases: { ...L.phase_records, ...(L.phase ? { [L.phase]: sec } : {}) },
    cycle: L.cycle, stopped: L.stopped || null, pending: L.pending ? { call_id: L.pending.call_id, step: L.pending.step } : null, coverage: coverage(L), units: unitsOf(L),
    skip: Object.entries(L.assets).filter(([, a]) => a.state === 'disclosed').map(([id, a]) => ({ unit: id, reason: a.reason })),
    // 今の根拠の事実（ファイルの段の指摘の候補・保証・前提・参考）。指摘の候補は全体の段の判定を通るまで findings に入らない。
    facts: facts.map(publicFact), references: [...facts.filter((f) => f.type === 'reference').map((f) => ({ id: f.id, unit: f.unit, path: f.path, claim: f.claim, quote: f.quote, origin: f.origin })), ...B.findings.references],
    // 全体の段の意図（根拠の事実の id と状態）と、判定できずに開示して閉じた意図（理由つき）。
    intents: B.intents.map((i) => ({ id: i.id, kind: i.kind, basis: i.basis, state: i.state, ...(i.item ? { item: i.item } : {}), ...(i.reason ? { reason: i.reason } : {}) })),
    undecided: B.intents.filter((i) => i.state === 'undecided').map((i) => ({ id: i.id, kind: i.kind, reason: i.reason })),
    lateral_types: L.lateral_types.map((t) => ({ id: t.id, root_cause: t.root_cause, applies_to: t.applies_to, cycle: t.cycle })),
    findings: sec.findings, groups: sec.groups, events: sec.events,
    saturation: L.saturation, calibration: calibration(L), agents_by_role: roles, calls: L.calls,
    // run の指標（今の値）と、止まるたびの run の記録。
    metrics: runMetrics(L, B), run_records: L.run_records || [],
    events_not_in_retro: L.events.filter((e) => !e.retro).map((e) => ({ id: e.id, stage: e.stage, kind: e.kind })),
    questions: ((L.plan && L.plan.questions) || []).filter((q) => !L.answers.some((a) => a.id === q.id)),
  }
}

function cmdHint(o) {
  const dir = path.resolve(need(o, 'state'))
  return withLock(dir, () => {
    const L = load(dir)
    if (L.stopped && L.stopped.stop === 'complete') throw new Fail('完了した台帳にはヒントを足せない（読まれない）')
    const id = `H${hints(dir).length + 1}`
    appendFileSync(path.join(dir, 'hints.jsonl'), `${JSON.stringify({ id, text: need(o, 'text') })}\n`)
    return { ok: true, id }
  })
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
    if (L.plan) for (const x of planProblems(L.plan, planCtx(L))) addPlanDefect(L, { unit_id: '', kind: 'static', claim: x, quote: '' })
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

export function main(argv) {
  try {
    const o = parse(argv)
    const cmd = o._[0]
    const f = { init: cmdInit, reframe: cmdReframe, next: cmdNext, ingest: cmdIngest, status: cmdStatus, hint: cmdHint, answer: cmdAnswer, config: cmdConfig, claim: cmdClaim, query: cmdQuery, submit: cmdSubmit }[cmd]
    if (!f) throw new Fail(`使い方: ledger-cli.mjs <init|reframe|next|ingest|status|hint|answer|config|claim|query|submit> --state DIR ...（未知のコマンド: ${cmd}）`)
    return { code: 0, output: f(o) }
  } catch (e) {
    if (e instanceof Fail) return { code: 2, output: { ok: false, error: e.message, ...e.extra } }
    return { code: 1, output: { ok: false, error: String(e && e.stack || e) } }
  }
}

// 命令として流す（直に流すときと、stateDir の入口 LAUNCHER から流すときの両方）。
export function runMain(argv) {
  const r = main(argv)
  process.stdout.write(`${JSON.stringify(r.output, null, 1)}\n`)
  process.exitCode = r.code
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runMain(process.argv.slice(2))
