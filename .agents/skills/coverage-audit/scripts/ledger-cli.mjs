#!/usr/bin/env node
// 台帳を書く唯一の口。init → next →（Workflow が worker を起動し、worker が claim・query・submit で台帳と読み書きする）→ ingest を繰り返し、
// next が止まる条件を返したら終わる。役の出力は返り値・args・prompt で運ばず、submit で台帳に入る（設計の B1〜B6）。
import { randomUUID } from 'node:crypto'
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  ALIAS_ANSWERS, C, CONFIDENCES, MAX_ATTEMPTS, VERDICTS, addEvent, board, calibration, checkFileResult, coverage, currentFindings, decide, factsOf, goalIds, goalSources,
  lensSetVersion, lensesFor, needPlan, newLedger, obligations, openCycle, planAnswerKinds, phaseEvents, rangeHash, rangeText, readGoalFiles, readsSig, refresh, retroAssets, retroTodo, sha, splitAssets,
  startPhase, staticFacts, unitTextOf, carriedRead, provenance, runMetrics, FULL_REVIEW, syncFullReview, fullReviewStatus, sameLocationPairs,
  isTarget, lineOf, contextUnits, unitBytes, packUnitsTo,
} from './ledger-core.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WORKFLOW = path.join(HERE, 'coverage-audit.js')

class Fail extends Error { constructor(msg, extra = {}) { super(msg); this.extra = extra } }
const MULTI = ['target', 'context', 'fact', 'task']
const KNOWN = {
  init: ['state', 'goal', 'request', 'decisions', 'criteria', 'goal-checked', 'target', 'context', 'repo', 'constraints', 'lenses', 'roles', 'seeds', 'max-cycles', 'max-agents-total', 'phase', 'link'],
  reframe: ['state', 'goal', 'request', 'decisions', 'criteria', 'constraints', 'target', 'context', 'repo', 'phase', 'link', 'lenses'],
  next: ['state'], ingest: ['state', 'call', 'result'], status: ['state'], hint: ['state', 'text'], answer: ['state', 'id', 'text', 'file'], config: ['state', 'max-cycles', 'max-agents-total', 'workers'],
  claim: ['state', 'call', 'worker', 'wave', 'model', 'effort', 'stage'], submit: ['state', 'call', 'worker'], query: ['state', 'call', 'worker', 'task', 'fact'],
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
export function load(dir) {
  if (!existsSync(ledgerPath(dir))) throw new Fail(`台帳が無い: ${ledgerPath(dir)}（init を先に流す）`)
  const L = JSON.parse(read(ledgerPath(dir)))
  if (!L.goal || !Array.isArray(L.goal.items)) throw new Fail(`台帳の形式が古い（目標の項目と引用を持たない）: ${ledgerPath(dir)}。goal.md などを 1 行 1 件・引用つきに直し、新しい stateDir で init からやり直す`)
  if (!Number.isInteger(L.plan_seq)) throw new Fail(`台帳の形式が古い（計画の欠陥の id の連番を持たない）: ${ledgerPath(dir)}。新しい stateDir で init からやり直す`)
  if (!Number.isInteger(L.call_seq) || !Number.isInteger(L.config && L.config.workers)) throw new Fail(`台帳の形式が古い（review の待ち行列の通し番号と worker の数を持たない）: ${ledgerPath(dir)}。新しい stateDir で init からやり直す`)
  if (!L.phase_start || !L.phase_records || L.phase === undefined) throw new Fail(`台帳の形式が古い（段の記録を持たない）: ${ledgerPath(dir)}。新しい stateDir で init からやり直す`)
  if (!Array.isArray(L.lenses) || L.lenses.some((l) => l.origin === 'skill' && !l.retro)) throw new Fail(`台帳の形式が古い（スキルの観点 purpose・layer を固定で持つ）: ${ledgerPath(dir)}。新しい stateDir で init からやり直す`)
  if (!Object.hasOwn(L, 'link')) throw new Fail(`台帳の形式が古い（関係する資産を結ぶ link の欄を持たない）: ${ledgerPath(dir)}。新しい stateDir で init からやり直す`)
  if (!Array.isArray(L.facts) || L.cells) throw new Fail(`台帳の形式が古い（資産 × 観点の枡を持つ）: ${ledgerPath(dir)}。新しい stateDir で init からやり直す`)
  if (!L.intent_attempts) throw new Fail(`台帳の形式が古い（全体の段の意図の試行を持たない）: ${ledgerPath(dir)}。新しい stateDir で init からやり直す`)
  if (!Array.isArray(L.retro_findings) || Object.hasOwn(L, 'lateral_types')) throw new Fail(`台帳の形式が古い（横展開の型と束ねの反証を持ち、振り返りの指摘を対象の指摘と分けない）: ${ledgerPath(dir)}。新しい stateDir で init からやり直す`)
  if (!Object.hasOwn(L, 'full_review')) throw new Fail(`台帳の形式が古い（全文レビューの記録を持たない）: ${ledgerPath(dir)}。新しい stateDir で init からやり直す`)
  if (L.pending && L.pending.wave_id === undefined) throw new Fail(`台帳の形式が古い（開いた呼び出しが波の記録を持たない）: ${ledgerPath(dir)}。新しい stateDir で init からやり直す`)
  if (!Number.isInteger(L.wave_seq) || !Array.isArray(L.contexts) || !Array.isArray(L.target_gaps) || !Object.hasOwn(L, 'repo')) throw new Fail(`台帳の形式が古い（波の連番・参照・no_target の欠陥・path を照らす基準の欄を持たない）: ${ledgerPath(dir)}。新しい stateDir で init からやり直す`)
  return L
}
function writeAtomic(file, text) {
  mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, text)
  renameSync(tmp, file)
}
// 役が最初の claim を流す入口（stateDir/ledger-cli.mjs）。args は {state, callId, wave} だけ（B4）で CLI の置き場を運べないので、
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
export function save(dir, L) {
  // 確定した指摘と検証不能の指摘と束ねの群は、台帳の事実から導いた写しを findings・groups に置く（status・answer・reframe の段の記録が読む）。
  if (L.facts) {
    const B = board(L)
    L.findings = Object.fromEntries(B.findings.list.map((f) => [f.id, { ...f, status: 'current' }]))
    L.groups = B.groups
  }
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
// 対象と参照（--context）のファイルを今の内容で単位にし、同じ内容を写しに書く。消えた・読めないファイルは返す（単位 0 件で完了にしない）。
// 大きいファイルを分ける線は、詰め合わせと同じ lineOf（単位を読む役の文脈の大きさから導く 1 本）。参照の単位は context の印を持つ。
function currentAssets(L, dir) {
  const missing = []
  const assets = []
  const max = lineOf(L)
  for (const [f, ctx] of [...L.targets.map((x) => [x, false]), ...(L.contexts || []).map((x) => [x, true])]) {
    if (!existsSync(f)) { missing.push(f); continue }
    const text = read(f)
    const snap = writeSnap(dir, text)
    assets.push(...splitAssets(f, text, max).map((a) => ({ ...a, snap, ...(ctx ? { context: true } : {}) })))
  }
  return { assets, missing }
}
// 目標・基準・制約の本文の path の照合。path の形の語（/ を含み、拡張子で終わる語）が repo を基準に実在するファイルを指すのに、
// --target にも --context にも無ければ、問題の文を返す（書かれた語をそのまま載せる）。実在しない path は照らさない。
const PATH_TOKEN = /[A-Za-z0-9_.~/-]+/g
const pathWords = (text) => [...new Set((String(text ?? '').match(PATH_TOKEN) || []).map((w) => w.replace(/\.+$/, '')).filter((w) => w.includes('/') && /[^/.]\.[A-Za-z0-9]+$/.test(w)))]
// 照合済みの台帳（--goal-checked）では流さない。照らすのは呼ぶ側（coverage-build）で、自分の対象と入力でこの関数を import して使う（写しを持たない）。
export function framePathProblems(g, { repo, targets, contexts }) {
  const real = (p) => { try { return realpathSync(p) } catch { return path.resolve(p) } }
  const allowed = new Set([...targets, ...contexts].map(real))
  const out = []
  for (const [what, items] of [['目標', g.goal], ['受け入れ基準', g.criteria], ['制約', g.constraints]]) {
    for (const it of items || []) for (const w of pathWords(it.text)) {
      const p = path.resolve(repo, w)
      let file = false
      try { file = statSync(p).isFile() } catch { continue }
      if (file && !allowed.has(real(p))) out.push(`${what} ${it.id} の本文の path ${w} は repo（${repo}）に実在するのに、--target にも --context にも無い（対象に足すか、参照として --context に渡すか、本文から外す）`)
    }
  }
  return out
}
// 参照（--context）のファイル。読めないものと、対象と重なるものは拒む。
function contextsOf(o, targets) {
  const contexts = (o.context || []).map((p) => path.resolve(p))
  const missing = contexts.filter((p) => !existsSync(p))
  if (missing.length) throw new Fail('読めない参照（--context）がある（台帳は作っていない・変えていない）', { stop: 'blocked', cause: 'input', missing })
  const both = contexts.filter((p) => targets.includes(p))
  if (both.length) throw new Fail(`--target と --context に同じファイルがある: ${both.join(', ')}`)
  return contexts
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
  const contexts = contextsOf(o, targets)
  const repo = path.resolve(o.repo ?? process.cwd())
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
  const pp = checkedBy ? [] : framePathProblems(g, { repo, targets, contexts })
  if (g.problems.length || pp.length) throw new Fail('目標・基準・制約に、引用か path の照合を通らない項目がある（台帳は作っていない。直して init をやり直す）', { problems: [...g.problems, ...pp] })
  const L = newLedger({
    goal: text.goal, goalItems: g.goal, checkedBy, phase, link, request: text.request, decisions: text.decisions, criteria: g.criteria, constraints: g.constraints,
    targets, contexts, repo, lenses, config, roles, seeds: o.seeds ? JSON.parse(read(o.seeds)).map((s) => ({ ...s, path: abs(s.path) })) : [],
  })
  checkWorkers(L.config)
  withLock(dir, () => {
    if (existsSync(ledgerPath(dir))) throw new Fail(`台帳が既にある: ${ledgerPath(dir)}（持ち越すときは next を流す）`)
    save(dir, L)
    savePhase(dir, L)
    writeLauncher(dir)
  })
  return { ok: true, state: dir, phase, targets: targets.length, contexts: contexts.length, criteria: L.criteria.length, constraints: L.constraints.length, goal_checked_by: checkedBy, hint: `ヒントは node ${path.join(HERE, 'ledger-cli.mjs')} hint --state ${dir} --text "..." で足せる（実行中も止まっている間も）` }
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
    const contexts = contextsOf(o, targets)
    const repo = path.resolve(o.repo ?? L.repo)
    const text = frameText(o)
    const g = readGoalFiles(text, { checkedBy: L.goal.checked_by })
    // reframe は照合済みの台帳だけを受けるので、path は照らさない（照らすのは呼ぶ側）。
    if (g.problems.length) throw new Fail('目標・基準・制約に、引用の照合を通らない項目がある（台帳は変えていない）', { problems: g.problems })
    // --lenses があれば、新しい段の利用者の観点に差し替える（呼ぶ側が段ごとに観点を渡す）。無ければ今の利用者の観点を保つ。
    const lenses = o.lenses ? readLenses(o) : null
    const from = L.phase
    const before = procedureSig(L)
    const sec = phaseSection(L)
    Object.assign(L, { goal: { ...L.goal, text: text.goal, items: g.goal, problems: [] }, request: text.request, decisions: text.decisions, criteria: g.criteria, constraints: g.constraints, targets, contexts, repo, link })
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

// ---------------- 呼び出し（next が開き、波を claim が進め、ingest が閉じる） ----------------
// args は {state, callId, wave} だけにする（B4。wave は最初の波 {id, rows}）。担当が読む文は args にも prompt にも載せず、役が claim と query で台帳から引く（B1）。
// 1 つの波の行は全て同時に起動されるので、前の役の提出を読む役（観点の検証役・確認役）は次の波に置く。波の担当が尽きると、claim が台帳の状態から
// 次の波を決めて記録し（next_wave）、Workflow script がその行で次の波を起動する。止まる条件・時間・行の数の区切りでは、claim が halt を返す。
// 段・担当の種類から役の名前への対応は、ここと stageTasks・INTENT_ROLE の 1 か所に置く。役のモデルと effort の組は roles.json だけが持ち、
// CLI が波の行に写す（Workflow script は行の値を使い、役の名前で分岐しない）。
const FILE_ROLE = 'file_reader'
// 全文レビューの役（ファイルの段の読む役と別の役。いつも 1 体）。
const FR_ROLE = 'full_reviewer'
// 振り返りの読みはファイルの段と同じ組（出来事の写しを、振り返りの観点で全文読む）。
const RETRO_ROLE = FILE_ROLE
const goalItemIds = (L) => [...L.goal.items, ...L.criteria].map((c) => c.id)
const goalTexts = (L) => Object.fromEntries([...L.goal.items, ...L.criteria].map((c) => [c.id, c.text]))
// 既にある観点（呼ぶ側と仕組みの標準）。計画役は定義し直せず、制約の受け皿にできる。
const givenLenses = (L) => L.lenses.filter((l) => l.origin === 'user' || l.origin === 'standard')
const planCtx = (L) => ({ constraintIds: [...L.criteria, ...L.constraints].map((c) => c.id), lensesGiven: !needPlan(L), givenLensIds: givenLenses(L).map((l) => l.id), goalItemIds: goalItemIds(L), goalTexts: goalTexts(L) })
// 呼ぶ側の観点があるときの計画役の提案は足すだけなので、試行の上限まで出なければ提案なしで進め、出来事に残す（止めない）。
// 目標の照合が済んでいなければ飛ばさない（計画役が照合も担うので、飛ばすと照合が抜ける）。
function skipStuckPlan(L) {
  if (L.plan_skipped || needPlan(L) || !L.goal.checked || (L.attempts.plan || 0) < MAX_ATTEMPTS) return
  L.plan_skipped = true
  delete L.attempts.plan
  delete L.env_attempts.plan
  addEvent(L, 'plan', 'plan_skipped', `計画役の観点の提案が試行 ${MAX_ATTEMPTS} 回で出なかったので、呼ぶ側と標準の観点（${givenLenses(L).map((l) => l.id).join('・')}）で読み進める`)
}
// 計画の照合は Workflow source の checkPlan。観点は一覧で全ての単位に渡すので、当てる単位（applies_to・excluded）は持たない。
function planProblems(rep, ctx) {
  if (!rep || typeof rep !== 'object') return ['結果が object でない']
  return C.checkPlan(rep, ctx)
}
// 計画の欠陥を足す。id は台帳の連番の P<n> で、計画をやり直して欠陥を戻しても前の番号を使い回さない（answer --id P<n> で指す）。
function addPlanDefect(L, d) {
  L.plan_seq += 1
  L.plan_defects.push({ id: `P${L.plan_seq}`, ...d })
}
// 計画の観点を台帳の観点に写す（ファイルの段に渡す観点の一覧になる）。
function syncPlanLenses(L) {
  const plan = L.plan || { lenses: [] }
  L.lenses = [...L.lenses.filter((l) => l.origin !== 'plan'), ...(plan.lenses || []).map((l) => ({ ...l, origin: 'plan' }))]
}
// 全体の段は役の組（INTENT_ROWS）ごとに最大 workers 体を起動するので、1 回の呼び出しの起動数は 組の数 × workers ≤ maxAgents に収める。
function checkWorkers(config) {
  const n = INTENT_ROWS.length * config.workers
  if (n > C.LIMITS.maxAgents) throw new Fail(`全体の段の役の組の数 ${INTENT_ROWS.length} × workers(${config.workers}) = ${n} が上限 maxAgents ${C.LIMITS.maxAgents} を超える（--workers を ${Math.floor(C.LIMITS.maxAgents / INTENT_ROWS.length)} 以下にする）`)
}
// 段ごとの worker の行と、行に結んだ担当。ファイルの段と振り返りの担当は詰め合わせ（bundles）で行に結び、worker が claim で詰め合わせの単位を取る。
// 計画の段の担当は行に 1 つずつ結ぶ。akey は試行を数える鍵（stuck の id）。bytesOf(id) は単位の本文のバイト数（詰め合わせに使う）。
// cap は行の数の上限（1 以上）、idOf(tag) は呼び出しの中で重ならない行の id を返す。
function stageTasks(L, d, bytesOf, { cap, idOf }) {
  const one = (tag, role, task) => { const id = idOf(tag); return { rows: [{ id, role }], tasks: [{ ...task, worker: id }] } }
  if (d.step === 'global') return { ...globalRows(L, board(L), cap, idOf), tasks: [] }
  // ファイルの段と振り返りは、文脈に収まる分の単位を 1 体に詰める（設計「段の構成」、決定 16）。詰め合わせの数が起動数で、cap（maxAgents と残りの予算）に収める。残りは次の波か呼び出しで読む。
  if (d.step === 'file' || d.step === 'retro') {
    const packs = packUnitsTo(d.units, bytesOf, lineOf(L)).slice(0, Math.max(1, cap))
    const tag = d.step === 'file' ? 'f' : 'r'
    const rows = packs.map(() => ({ id: idOf(tag), role: d.step === 'file' ? FILE_ROLE : RETRO_ROLE }))
    return { rows, tasks: [], bundles: Object.fromEntries(rows.map((r, i) => [r.id, packs[i]])) }
  }
  // 全文レビュー: 読む範囲を 1 体が読む（--workers によらない）。担当は観点を持たない。
  if (d.step === FULL_REVIEW) return one('fr', FR_ROLE, { id: `${FULL_REVIEW}:${L.full_review.sig.slice(0, 12)}`, kind: FULL_REVIEW })
  if (d.step === 'plan') {
    const answers = L.answers.filter((a) => !L.answered.includes(a.id) && planAnswerKinds.includes(a.target_kind)).map((a) => a.id)
    return one('p', 'planner', { id: 'plan', kind: 'plan', akey: 'plan', goalCheck: !L.goal.checked, again: !!L.plan, defectCount: L.plan ? L.plan_defects.length : 0, defectKinds: L.plan ? L.plan_defects.map((x) => x.kind) : [], answerIds: answers })
  }
  // 観点の検証: 計画の版を担当にし、確かめていない観点の全てを 1 体が見る。
  const byId = new Map(((L.plan && L.plan.lenses) || []).map((u) => [u.id, u]))
  const keys = Object.fromEntries(d.lenses.map((id) => [id, C.unitKey(byId.get(id))]))
  return one('uv', 'unit_verifier', { id: `unit_verify:${sha(JSON.stringify(keys)).slice(0, 12)}`, kind: 'unit_verify', lenses: d.lenses, keys, akey: 'unit_verify' })
}

// ---------------- 全体の段（意図） ----------------
// 意図の種類ごとの役。名寄せ・主語の照合・指摘の判定・前提の消化・目標の判定は global_judge、確認と束ねは confirmer。
// 判定役 1 体が判定役の全ての種類の意図を順に処理し、確認役 1 体が確認の意図と、確認が全て閉じた後の束ねの意図を取る（起動の原則）。
const INTENT_ROLE = { alias: 'global_judge', subject: 'global_judge', finding: 'global_judge', premise: 'global_judge', goal: 'global_judge', confirm: 'confirmer', group: 'confirmer' }
const INTENT_ROWS = [['g', ['alias', 'subject', 'finding', 'premise', 'goal']], ['c', ['confirm', 'group']]]
// 今の段の残りの予算（起動数）。開いた呼び出しで既に出した行も引く。budgetLeft は呼び出しの最初の波に使い、少なくとも 1。
const budgetRemain = (L) => L.config.max_agents_total - (L.agents.length - L.phase_start.agents) - (L.pending ? L.pending.rows_total || 0 : 0)
const budgetLeft = (L) => Math.max(1, budgetRemain(L))
// 全体の段の行: 開いた意図のある種類の組ごとに、min(workers, 開いた意図の数) 体（既定は 1 体）。行の合計は cap（maxAgents と残りの予算）以下にする。
// 予算は INTENT_ROWS の順（g が先、c が後）に開いた意図のある組へ 1 行ずつ割り当て、余りを各組の上限まで足す。予算が尽きた組はこの呼び出しでは 0 行で、
// 開いた意図は次の波か呼び出しに回る（起動数が上限に達すれば decide が limit で止め、開いた意図を停止に載せる）。
// 波の中で受理された事実から増えた意図は、行のある組なら同じ波で取る（確認役は確認に続けて束ねを取る）。行の無い組の意図は次の波が取る。
function globalRows(L, B, cap, idOf) {
  const open = B.intents.filter((i) => i.state === 'open')
  const want = INTENT_ROWS.map(([, ks]) => Math.min(L.config.workers, open.filter((i) => ks.includes(i.kind)).length))
  let left = cap
  const got = want.map((w) => { const n = w > 0 && left > 0 ? 1 : 0; left -= n; return n })
  for (let j = 0; j < got.length; j++) { const n = Math.min(want[j] - got[j], left); got[j] += n; left -= n }
  const rows = []
  const kinds = {}
  INTENT_ROWS.forEach(([tag, ks], j) => {
    for (let k = 1; k <= got[j]; k++) { const id = idOf(tag); rows.push({ id, role: INTENT_ROLE[ks[0]] }); kinds[id] = ks }
  })
  return { rows, kinds }
}
const intentTaskId = (intent, call) => `${intent}@${call}`
// 目標の判定の担当に渡す単位の索引（id・path・写しの範囲）。義務に結ばれた事実が無くても、役が写しを開いて引用し、抜けの場所を書けるようにする。
// 参照（--context）の単位も context: true の印で載せる（網羅に数えないが、引用の根拠にできる）。
const unitIndex = (L) => Object.entries(L.assets).filter(([, a]) => !a.retro).map(([id, a]) => ({ id, path: a.path, file: a.snap, start: a.start, end: a.end, ...(a.context ? { context: true } : {}) }))
// query が返す載せなかった事実の id の上限（B6: 要約は上限と宣言を持つ）。超えた分の件数は omitted_more で宣言する。
const OMITTED_IDS_MAX = 200
// 全体の段と確認の担当は観点の一覧を使わない（観点はファイルの段の読みの手続き）ので、担当に載せない。
function intentTask(L, dir, call, w, it) {
  const tid = intentTaskId(it.id, call)
  const hs = hintsOf(dir, L.pending.hints)
  return {
    id: tid, kind: it.kind, result_path: resultPath(dir, call, w.id, tid), intent: { id: it.id, kind: it.kind, ...(it.item ? { item: it.item } : {}) },
    obligations: obligations(L),
    ...(it.kind === 'goal' ? { units: unitIndex(L) } : {}), ...(hs.length ? { hints: hs } : {}),
  }
}
// query が返す意図 1 件の入力（B1）。claim の束の量もこの形で測るので、query と claim はこの 1 か所から作る。
// same_location は同じ箇所の指摘の組（全文レビューとファイルの段の指摘で、同じ単位の引用が包含し合うもの）。指摘の判定と確認は対象の指摘を含む組、
// 束ねは根拠の中の組を持つ。組の相手の事実は related に足し、basis（意図の根拠）には入れない。同じ欠陥かは役が判じるので、まとめない。
function intentEntry(L, B, it, tid, pairs) {
  const pub = (ids) => ids.map((x) => B.facts.get(x)).filter(Boolean).map((f) => publicFact(L, f))
  const target = it.kind === 'finding' ? it.basis[0] : it.kind === 'confirm' ? it.target : null
  const same = it.kind === 'group' ? pairs.filter((p) => p.every((x) => it.basis.includes(x))) : target ? pairs.filter((p) => p.includes(target)) : []
  const partners = [...new Set(same.flat())].filter((x) => !it.basis.includes(x) && !it.related.includes(x))
  const ids = it.omitted_ids || []
  return {
    task: tid, kind: it.kind, intent: { id: it.id, kind: it.kind, ...(it.item ? { item: it.item } : {}) }, basis: pub(it.basis), related: pub([...it.related, ...partners]),
    omitted: it.omitted, omitted_ids: ids.slice(0, OMITTED_IDS_MAX), ...(ids.length > OMITTED_IDS_MAX ? { omitted_more: ids.length - OMITTED_IDS_MAX } : {}),
    ...(it.kind === 'goal' ? { units: unitIndex(L) } : {}), ...(same.length ? { same_location: same } : {}),
  }
}
// 束の量: query が返す根拠・関係する事実・単位の索引のバイト数（設計「全体の段と確認」。上限は線（lineOf）で、新しい線を置かない）。
const entryBytes = (e) => Buffer.byteLength(JSON.stringify({ basis: e.basis, related: e.related, ...(e.units ? { units: e.units } : {}) }))
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
// 場所（単位と逐語の引用）の照合。allowed を渡すと、その単位（全文レビューの読む範囲）の外の場所を拒む。
// unit を省いた場所は、引用が逐語で載る単位が探す範囲（allowed か、振り返りを除く対象の全ての単位）に 1 つだけなら、その単位を場所に書き込む
// （照合で決まるので役に書かせない。設計「役と制御の境界」）。複数にあれば、候補の単位を挙げて unit を求めて拒む。
function locationProblems(L, where, f, allowed = null) {
  const p = []
  const locs = Array.isArray(f && f.locations) ? f.locations : []
  if (!locs.length) p.push(`${where}: locations（単位と引用）が無い`)
  locs.forEach((l, k) => {
    if (l && typeof l === 'object' && (l.unit === undefined || l.unit === null || l.unit === '')) {
      const scope = allowed || Object.keys(L.assets).filter((id) => !L.assets[id].retro)
      const hits = scope.filter((u) => !quoteIn(L, l.quote, [u]))
      if (hits.length === 1) l.unit = hits[0]
      else if (hits.length > 1) { p.push(`${where}.locations[${k}]: 引用が複数の単位にあるので unit（単位の id）を書く。候補: ${hits.join(', ')}`); return }
      else { p.push(`${where}.locations[${k}]: unit を省いた引用が、どの単位の本文にも逐語で無い: ${quoteIn(L, l.quote, scope)}`); return }
    }
    if (!l || !L.assets[l.unit] || L.assets[l.unit].retro) { p.push(`${where}.locations[${k}]: 単位が台帳に無い: ${l && l.unit}`); return }
    if (allowed && !allowed.includes(l.unit)) { p.push(`${where}.locations[${k}]: 読む範囲の外の単位: ${l.unit}`); return }
    const e = quoteIn(L, l.quote, [l.unit])
    if (e) p.push(`${where}.locations[${k}]: ${e}`)
  })
  return p
}
// 全体の段が足す指摘と全文レビューの指摘（GlobalFinding）の照合: 主張・場所（単位と逐語の引用）・義務・確信度・原因の層。
function globalFindingProblems(L, fs, allowed = null) {
  const p = []
  const ob = obligations(L).map((o) => o.id)
  ;(Array.isArray(fs) ? fs : []).forEach((f, i) => {
    if (!isStr(f && f.claim)) p.push(`findings[${i}]: claim が空`)
    p.push(...locationProblems(L, `findings[${i}]`, f, allowed))
    if (!ob.includes(f && f.obligation)) p.push(`findings[${i}]: obligation は目標・受け入れ基準の id: ${f && f.obligation}`)
    if (!CONFIDENCES.includes(f && f.confidence)) p.push(`findings[${i}]: confidence は ${CONFIDENCES.join('・')} のどれか`)
    if (!C.LAYERS.includes(f && f.layer)) p.push(`findings[${i}]: layer（原因の層）は ${C.LAYERS.join('・')} のどれか`)
    if (f && f.severity !== undefined && !C.SEVERITIES.includes(f.severity)) p.push(`findings[${i}]: severity は ${C.SEVERITIES.join('・')} のどれか`)
  })
  return p
}
// 指摘を足せる意図の種類。
const ADDS_FINDINGS = ['subject', 'premise', 'goal']
// 意図の判定の照合。確認は、逐語でない引用では棄却も確定もできず、検証不能として受け取る（設計「全体の段と確認」の確認）。
function intentProblems(L, B, it, rep) {
  if (!rep || typeof rep !== 'object' || Array.isArray(rep)) return ['結果が object でない']
  const p = []
  // 目標の判定は、載せなかった事実（omitted_ids。--fact で引き直せる）も支えにできる。
  const visible = [...it.basis, ...it.related, ...(it.kind === 'goal' ? it.omitted_ids || [] : [])]
  const units = [...new Set(visible.map((id) => B.facts.get(id)).filter(Boolean).flatMap((f) => (f.paths && f.locations ? f.locations.map((l) => l.unit) : [f.unit])))]
  // 目標の判定は、単位の索引の全ての単位の本文で引用を照らす（抜けの場所は、結ばれた事実の無い単位にもありうる）。
  if (it.kind === 'goal') units.push(...Object.keys(L.assets).filter((id) => !L.assets[id].retro))
  // 束ね: 群の形と、群が持つ事実の id が根拠（確定した指摘）にちょうど 1 回ずつあるか（引用は持たない）。
  if (it.kind === 'group') return C.checkGroups(rep, it.basis)
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
    const toConfirm = bound && (it.kind === 'finding' ? rep.verdict === 'keep' : it.mode === 'dropped' ? rep.verdict === 'disagree' : it.mode === 'kept' && rep.verdict === 'agree')
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
  // 目標の判定が足す指摘の義務は、意図の項目で決まる（役が書いた値は上書きする）。
  if (it.kind === 'goal' && Array.isArray(rep.findings)) for (const f of rep.findings) if (f && typeof f === 'object') f.obligation = it.item
  if (ADDS_FINDINGS.includes(it.kind) && rep.findings !== undefined) p.push(...globalFindingProblems(L, rep.findings))
  return p
}
// 受理した判定を事実として足す。足した指摘も事実にし、判定の added に結ぶ。
function addJudgment(L, B, it, rep, w) {
  const P = L.pending
  const unverifiable = it.kind === 'confirm' && quoteIn(L, rep.quote, it.basis.map((id) => B.facts.get(id)).filter(Boolean).flatMap((f) => (f.locations ? f.locations.map((l) => l.unit) : [f.unit])))
  const jid = `J${sha(JSON.stringify([it.id, it.key, P.call_id, w.id, L.facts.length])).slice(0, 12)}`
  const fs = ADDS_FINDINGS.includes(it.kind) && Array.isArray(rep.findings) ? rep.findings : []
  const added = fs.map((f) => {
    const locs = f.locations.map((l) => ({ unit: l.unit, path: L.assets[l.unit].path, quote: l.quote }))
    return { id: `F${sha(JSON.stringify([it.id, it.key, C.norm(f.claim), locs.map((l) => [l.unit, C.norm(l.quote)])])).slice(0, 12)}`, type: 'finding', origin: it.kind, judgment: jid, claim: f.claim, quote: locs[0].quote, unit: locs[0].unit, path: locs[0].path, paths: [...new Set(locs.map((l) => l.path))], locations: locs, obligation: f.obligation, confidence: f.confidence, layer: f.layer, ...(f.severity ? { severity: f.severity } : {}), cycle: L.cycle }
  })
  const j = {
    id: jid, type: 'judgment', intent: it.id, kind: it.kind, key: it.key, phase: L.phase_start.cycle, cycle: L.cycle, verdict: unverifiable ? 'unverifiable' : ['alias', 'group'].includes(it.kind) ? undefined : rep.verdict,
    quote: rep.quote, ...(it.kind === 'group' ? { groups: rep.groups.map((g) => ({ id: g.id, root_cause: g.root_cause, layer: g.layer, keys: [...g.keys] })), unassigned: [...(rep.unassigned || [])] } : {}), ...(rep.reason ? { reason: rep.reason } : {}), ...(it.kind === 'alias' ? { same: rep.same, confidence: rep.confidence } : {}), ...(Array.isArray(rep.support) ? { support: rep.support } : {}),
    ...(rep.obligation ? { obligation: rep.obligation } : {}), ...(rep.layer ? { layer: rep.layer } : {}), ...((it.kind === 'goal' && rep.verdict === 'gap') || (it.kind === 'premise' && rep.verdict === 'unsatisfied') ? { reads: readsSig(L) } : {}),
    added: added.map((f) => f.id), call: P.call_id, worker: w.id, role: w.role, model: w.model, effort: w.effort,
  }
  L.facts.push(j, ...added.filter((f) => !L.facts.some((x) => x.id === f.id)))
  if (it.kind === 'confirm' && it.mode === 'dropped' && j.verdict === 'disagree') addEvent(L, 'global', 'restored', `${it.target}: 確認が落とした判定を誤りと判じたので復活させた`, it.target)
  if (it.kind === 'group') L.saturation.push({ cycle: L.cycle, confirmed: it.basis.length, groups: rep.groups.length })
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
function cmdNext(o) {
  const dir = path.resolve(need(o, 'state'))
  return withLock(dir, () => next(dir))
}
// 今の時刻（ミリ秒）。環境変数 COVERAGE_AUDIT_NOW_MS があればその値（テストで呼び出しの経過を差し替える）。next と claim がその都度読む。
const nowMs = () => { const v = process.env.COVERAGE_AUDIT_NOW_MS; return v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : Date.now() }
// 呼び出しの時間の区切り: 開いてからの経過がこれを超えたら、新しい波を起動せずに終える（残りの 1 体の時間の上限を残す）。
const CALL_BUDGET_MS = C.LIMITS.timeoutMs - C.LIMITS.agentTimeoutMs
// 段の間の決定的な遷移（周を開く・計画の提案を飛ばす・全文レビューの記録を合わせる・振り返りの単位を作る）を流し、次の 1 手か停止を決める。
// next（呼び出しを開くとき）と claim（波の担当を渡すか、次の波を決めるとき）が同じこの関数を流す。first は最初の周回の決定の前に 1 度だけ流す。
function advance(L, dir, { missing = [], first = null } = {}) {
  for (let i = 0; ; i++) {
    openCycle(L)
    skipStuckPlan(L)
    if (i === 0 && first) first()
    syncFullReview(L)
    const d = decide(L, { missingTargets: missing })
    if (d.stop || d.step !== 'retro') return d
    // 振り返り: coverage-build から渡された台帳（照合済みの印）は振り返りを作らず、済みの印だけを付ける（agent を起動しない）。
    // 単独のときは、周ごとに 1 回だけ、まだ振り返っていない出来事の写しを単位にし（対象の単位に数えない）、読む単位が無くなったら済みの印を付ける。
    if (L.goal.checked_by !== 'coverage-build' && L.retro_made !== L.cycle) {
      L.retro_made = L.cycle
      refresh(L, retroAssets(L).map((a) => ({ ...a, snap: writeSnap(dir, a.text) })), { partial: true })
    }
    d.units = L.goal.checked_by === 'coverage-build' ? [] : retroTodo(L)
    if (d.units.length) return d
    L.retro_cycles.push(L.cycle)
  }
}
// 波の欄（開いた呼び出しの今の波）。呼び出しの欄（call_id・opened_at・rows_total・launched など）と分けて差し替える。
const WAVE_KEYS = ['wave_id', 'step', 'workers', 'tasks', 'kinds', 'intent_claims', 'bundles', 'file_taken', 'claims', 'submits', 'accepted', 'worker_submits', 'done_rows', 'claimed_rows', 'stale', 'sig']
// 決定（d）から波を作る（id は記録するときに付ける）。行の id は呼び出しの中で重ならない連番。sig は段・役・担当の組の指紋（同じ波を記録し直さない）。
function makeWave(L, P, d, cap) {
  const { rows, tasks, kinds, bundles } = stageTasks(L, d, (id) => unitBytes(L, id), { cap, idOf: (tag) => `${tag}${++P.row_seq}` })
  const workers = rows.map((r) => ({ id: r.id, role: r.role, model: L.roles[r.role].model, effort: L.roles[r.role].effort, stage: d.step }))
  const sig = sha(JSON.stringify([d.step, rows.map((r) => r.role), bundles ? rows.map((r) => bundles[r.id]) : null, tasks.map((t) => t.id)])).slice(0, 16)
  return { step: d.step, workers, tasks, ...(kinds ? { kinds, intent_claims: {} } : {}), ...(bundles ? { bundles } : {}), claims: 0, submits: 0, accepted: 0, done_rows: [], claimed_rows: [], sig }
}
// 全文レビューにはヒントを渡さない（目標と読む範囲だけ）。ヒントはほかの段の波が読む（呼び出しで読んだヒントは ingest が既読にする）。
function addHints(L, dir, P, step) {
  if (step === FULL_REVIEW) return
  for (const h of hints(dir)) if (!L.hints_read.includes(h.id) && !P.hints.includes(h.id)) P.hints.push(h.id)
}
// 波を起動した（呼び出しを開いたか、記録した次の波の最初の claim が来た）ものとして今の波にする。行の数を呼び出しの和に足す。
function launchWave(P, W) {
  for (const k of WAVE_KEYS) delete P[k]
  Object.assign(P, W)
  P.rows_total += W.workers.length
  P.launched.push({ id: W.wave_id, step: W.step, workers: W.workers })
}
function next(dir) {
  const L = load(dir)
  writeLauncher(dir)
  // 開いた呼び出しがある間は、同じ呼び出し（同じ callId と args）を返す（冪等。B6）。閉じるのは ingest --call だけにし、
  // 司令塔が next を流し直しても、Workflow の実行中の claim・submit を壊さない。台帳は今の対象に合わせる（変わった単位だけが読み直しになり、
  // 変わっていない単位の取りは残る）。
  // 返す args は今の波（記録した次の波があればそれ、無ければ閉じていない今の波）。Workflow が途中で落ちても、流し直せば続きから進む。
  if (L.pending) {
    const P = L.pending
    const { assets } = currentAssets(L, dir)
    const changes = refresh(L, assets)
    L.static = staticFacts(L)
    const W = P.next || P
    let argsPath = P.args_path
    if (String(W.wave_id) !== String(P.launched[0].id)) {
      argsPath = path.join(dir, `call-${P.call_id}-w${W.wave_id}.json`)
      writeAtomic(argsPath, JSON.stringify({ state: dir, callId: P.call_id, wave: { id: W.wave_id, rows: W.workers } }))
    }
    save(dir, L)
    return { step: W.step, call_id: P.call_id, workflow: WORKFLOW, args_path: argsPath, estimate_agents: W.workers.length, limits: C.LIMITS, cycle: P.cycle, coverage: coverage(L), changes }
  }
  // blocked（failure）の後の next は、原因を直した再開として扱い、連続の数と環境の失敗に数えた試行を戻す。
  if (L.stopped && L.stopped.stop === 'blocked' && L.stopped.cause === 'failure') {
    L.fail_streak = 0
    for (const a of Object.values(L.assets)) if (a.env_attempts) { a.attempts -= a.env_attempts; a.env_attempts = 0; if (a.state === 'disclosed' && a.attempts < MAX_ATTEMPTS) { a.state = 'unseen'; a.reason = '' } }
    for (const [k, n] of Object.entries(L.env_attempts)) { L.attempts[k] -= n; if (L.attempts[k] <= 0) delete L.attempts[k] }
    L.env_attempts = {}
    reopenLostFullReview(L)
  }
  const { assets, missing } = currentAssets(L, dir)
  const changes = refresh(L, assets)
  L.static = staticFacts(L)
  // 止まった後に対象が変わったら、読み直しの新しい回を始める（設計「再レビューと持ち越し」）。今の回より前の周の読みは持ち越しになり、
  // 今回変わらなかった単位の前の読みの印（prior）は消す（前の回で変わった印を、次の回の出どころに持ち込まない）。
  const newRound = !!L.stopped && (changes.added.length + changes.stale.length + changes.gone.length) > 0
  const touched = new Set([...changes.added, ...changes.stale])
  const d = advance(L, dir, {
    missing,
    first: () => {
      if (!newRound) return
      L.round_start = L.cycle
      for (const [id, a] of Object.entries(L.assets)) if (!touched.has(id)) delete a.prior
      reopenLostFullReview(L)
    },
  })
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
  L.call_seq += 1
  const callId = sha(`${dir}|${L.call_seq}|${d.step}|${L.cycle}|${L.rev}`).slice(0, 12)
  const argsPath = path.join(dir, `call-${callId}.json`)
  // 呼び出しの記録: 開いた時刻（時間の区切り）・出した行の和（行の数の区切り）・起動した波・行の id の連番。今の波の欄は launchWave が置く。
  const P = { call_id: callId, args_path: argsPath, opened_at: nowMs(), cycle: L.cycle, events_at: L.events.length, hints: [], rows_total: 0, row_seq: 0, launched: [], waves_closed: 0, prev_submits: 0, next: null }
  L.pending = P
  addHints(L, dir, P, d.step)
  launchWave(P, { ...makeWave(L, P, d, Math.min(C.LIMITS.maxAgents, budgetLeft(L))), wave_id: ++L.wave_seq })
  const args = { state: dir, callId, wave: { id: P.wave_id, rows: P.workers } }
  writeAtomic(argsPath, JSON.stringify(args))
  // 止まっている間だけ status のファイルがある形にする（呼ぶ側が前の停止の status を取り込まない）。
  rmSync(statusPath(dir, L), { force: true })
  save(dir, L)
  return { step: d.step, call_id: callId, workflow: WORKFLOW, args_path: argsPath, estimate_agents: P.workers.length, limits: C.LIMITS, cycle: L.cycle, coverage: coverage(L), changes }
}

const bump = (L, k, env) => {
  L.attempts[k] = (L.attempts[k] || 0) + 1
  if (env) L.env_attempts[k] = (L.env_attempts[k] || 0) + 1
}
const clear = (L, k) => { delete L.attempts[k] }
const stageOf = (a) => (a && a.retro ? 'retro' : 'file')
// 単位を読む段（ファイルの段と振り返り）。claim は詰め合わせの単位を返し、query を拒む。
const READ_STEPS = ['file', 'retro']
// 今の波の会計を締める（波の境目: 次の波の最初の claim と、呼び出しを閉じる ingest）。取ったまま提出されなかった単位は試行に数えて取りを外し、
// 上限で理由つきの disclosed にする。提出されなかった計画の段の担当は、その鍵の試行に数える（env なら環境の失敗にも数え、blocked（failure）からの再開で戻す）。
// 段が変わって使わなくした波（stale）の担当は、staleWave が手放し済みなので数えない。
function closeWave(L, { env = false, lost = false } = {}) {
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
    if (t.done || t.void) continue
    // 全文レビュー: 試行は全文レビューの記録で数える（計画の段の stuck にしない）。返らなかったか試行の上限なら、読まなかったとして開示して先へ進む。
    if (t.kind === FULL_REVIEW) {
      const fr = L.full_review
      fr.attempts += 1
      addEvent(L, FULL_REVIEW, 'missing_full_review', `${t.id}: 全文レビューの担当が提出されなかった`, t.id)
      if (lost) failFullReview(L, '全文レビューの役が返らなかった', 'lost')
      else if (fr.attempts >= MAX_ATTEMPTS) failFullReview(L, `提出されないまま試行 ${fr.attempts} 回`, 'unsubmitted')
      continue
    }
    bump(L, t.akey, env)
    addEvent(L, 'plan', `missing_${t.kind}`, `${t.id}: 担当が提出されなかった`, t.id)
  }
  // 取ったまま提出されなかった意図（設計「完了と止める条件」の試行の数え方）:
  // - その呼び出しで 1 件以上出した役（受理か拒否かを問わない）の取り残しは、試行に数えずに手放す（拒否は submitIntent が既に数えている）。
  // - 1 件も出さなかった役が 2 件以上の束を持っていたら、試行に数えずに手放し、その役の種類の次の束の上限をその束の量の半分にする
  //   （1 回だけの submit では時間切れがほぼ 0 件の提出で起きるので、同じ束を繰り返して全てを判定できなかった意図にしない）。
  // - 1 件の束で 0 件のまま閉じたときだけ試行に数え、上限で判定できなかった意図として閉じる。
  // その種類で 1 件以上の提出があった呼び出しの後は、束の上限を線（lineOf）に戻す。
  if (P.step === 'global') {
    const B = board(L)
    const sent = (wid) => ((P.worker_submits || {})[wid] || 0) > 0
    const roleOf = (wid) => (P.workers.find((x) => x.id === wid) || {}).role
    const held = Object.entries(P.intent_claims || {}).filter(([id, c]) => !c.done && B.byId.get(id) && B.byId.get(id).state === 'open')
    const heldOf = (wid) => held.filter(([, c]) => c.worker === wid)
    L.bundle_caps = L.bundle_caps || {}
    const roleSent = new Set(P.workers.filter((w) => sent(w.id)).map((w) => w.role))
    for (const r of roleSent) delete L.bundle_caps[r]
    for (const w of P.workers) {
      const hs = heldOf(w.id)
      if (roleSent.has(w.role) || hs.length < 2) continue
      L.bundle_caps[w.role] = Math.floor(hs.reduce((n, [, c]) => n + (c.bytes || 0), 0) / 2)
    }
    for (const [id, c] of held) {
      const it = B.byId.get(id)
      if (sent(c.worker)) { addEvent(L, 'global', 'missing_intent', `${id}: 意図を取ったまま提出しなかった（同じ呼び出しで他の意図を出した役なので、試行に数えずに手放した）`, id); continue }
      if (heldOf(c.worker).length >= 2) { addEvent(L, 'global', 'missing_intent', `${id}: 束を取ったまま 1 件も提出しなかった（試行に数えずに手放し、${roleOf(c.worker)} の次の束の上限を半分にした）`, id); continue }
      addEvent(L, 'global', 'missing_intent', `${id}: 意図を取ったまま提出しなかった`, id)
      bumpIntent(L, it, '取ったまま提出されなかった')
    }
  }
}
// 呼び出しを閉じる（ingest）。今の波の会計を締め、記録したまま起動されなかった次の波は捨てる（会計に数えない。次の next が作り直す）。
export function closeCall(L, opts = {}) {
  closeWave(L, opts)
  L.pending = null
}
// 記録した次の波の最初の claim: 今の波の会計を締めてから、次の波を今の波にする。境目まで来た波は、役が担当を尽くして次の波の印を受け取ったので、
// 進みのあった波として扱う（環境の失敗に数えない）。
// 次の波が振り返りで、締めた会計が出来事を足したなら、振り返りの単位を作り直す（その周の出来事を全て振り返りに入れる。単位は記録の時点で作ったため）。
// 詰め合わせが行より増えた分は、次の波が読む。
// 閉じる波の claim の 1 回も無い行は、起動されたのに担当を取らなかった（落ちた）として agent_missing に残す（同じ呼び出しの後の振り返りが読む。
// ingest は同じ行に二重に足さない）。前の波に進みがあったかを、環境の失敗の判定（ingest）のために覚える。
function promote(L, dir) {
  const P = L.pending
  const at = L.events.length
  for (const w of P.workers) {
    if ((P.claimed_rows || []).includes(w.id)) continue
    const label = `${w.role}-${w.id}`
    addEvent(L, w.stage, 'agent_missing', `${label}（${w.model}/${w.effort}）: 波 ${P.wave_id} の役が claim を 1 回もしないまま、波が閉じた`, label)
    P.reported = [...(P.reported || []), `${P.wave_id}|${label}`]
  }
  // 環境の失敗の印（env_attempts）は、締める波ごとに、その波の進みで付ける。呼び出し全体の進み（progressed）で判じるのは fail_streak だけ。
  const moved = waveProgress(P)
  P.progressed = !!P.progressed || moved
  closeWave(L, { env: !moved })
  P.waves_closed += 1
  P.prev_submits += P.submits || 0
  if (P.next.step === 'retro' && L.events.length > at && L.goal.checked_by !== 'coverage-build') {
    // 読まなかった振り返りの単位だけを作り直す（読んだ単位とその出来事は作り直さない）。その単位の出来事と、新しく増えた出来事を並べ直す。
    // 作り直した単位は、同じ出来事を含んでいた元の単位の試行を引き継ぐ（取り残し続ければ MAX_ATTEMPTS で開示される）。
    const back = new Map()
    const idsOf = (id) => [...String(unitTextOf(L, id) || '').matchAll(/^\[([^\]]+)\]/gm)].map((m) => m[1])
    for (const [id, a] of Object.entries(L.assets)) {
      if (!a.retro || a.state !== 'unseen' || a.claim) continue
      for (const e of idsOf(id)) back.set(e, { attempts: a.attempts || 0, env: a.env_attempts || 0 })
      delete L.assets[id]
    }
    for (const e of L.events) if (back.has(e.id)) delete e.retro
    L.retro_made = null
    const d = advance(L, dir)
    for (const [id, a] of Object.entries(L.assets)) {
      if (!a.retro || a.state !== 'unseen' || a.read) continue
      const olds = idsOf(id).map((e) => back.get(e)).filter(Boolean)
      if (!olds.length) continue
      a.attempts = Math.max(a.attempts || 0, ...olds.map((x) => x.attempts))
      a.env_attempts = Math.max(a.env_attempts || 0, ...olds.map((x) => x.env))
    }
    const packs = d.step === 'retro' ? packUnitsTo(d.units, (id) => unitBytes(L, id), lineOf(L)) : []
    P.next.bundles = Object.fromEntries(P.next.workers.map((w, i) => [w.id, packs[i] || []]))
  }
  launchWave(P, P.next)
  P.next = null
}
// 段が変わった（記録した波の段が、その時の decide の段と合わない）波を使わなくする。まだ取られていない担当と取りを、試行に数えずに手放す
// （順序の門。前の段の担当を、段が変わった後に渡さない）。
function staleWave(L) {
  const P = L.pending
  if (P.stale) return
  P.stale = true
  for (const a of Object.values(L.assets)) if (a.claim && a.claim.call === P.call_id) a.claim = null
  for (const t of P.tasks || []) if (!t.done) { t.done = true; t.void = true }
  for (const c of Object.values(P.intent_claims || {})) c.done = true
  P.file_taken = Object.fromEntries(P.workers.map((w) => [w.id, true]))
}
// 波に進みがあったか（受理・提出。全体の段は claim も。全文レビューは環境の失敗に数えないので進みとする）。noProgress の裏返しで、起動の記録を使わない。
function waveProgress(P) {
  if (P.step === FULL_REVIEW) return true
  if (P.step === 'global') return !!P.claims || !!P.accepted
  if (READ_STEPS.includes(P.step)) return !!P.submits
  return !!P.accepted
}
// 単位を取れるか（読みの無い、取られていない、試行が上限に届いていない対象の単位）。
const claimable = (a) => !!a && !a.claim && a.state === 'unseen' && a.attempts < MAX_ATTEMPTS
// 今の波に、まだ done を受け取っていない行が取れる担当が残っているか（残っていれば、その行が取るので次の波を決めない）。
function pendingWork(L, P) {
  if (P.stale) return false
  const live = P.workers.filter((w) => !P.done_rows.includes(w.id))
  if (!live.length) return false
  if (READ_STEPS.includes(P.step)) return live.some((w) => !(P.file_taken || {})[w.id] && ((P.bundles || {})[w.id] || []).some((k) => claimable(L.assets[k])))
  if (P.step === 'global') {
    const open = board(L).intents.filter((i) => i.state === 'open' && !P.intent_claims[i.id])
    return live.some((w) => open.some((i) => (P.kinds[w.id] || []).includes(i.kind)))
  }
  return live.some((w) => (P.tasks || []).some((t) => t.worker === w.id && !t.done && !t.claimed))
}
// 次の波を決めて記録する（波の担当が尽きたときの claim の done に載せる）。止まる条件・時間・行の数の区切りでは halt を返す（新しい波を起動させない）。
// 行の数は maxAgents − この呼び出しで出した行と、残りの予算に収める。同じ中身の波を既に記録していれば、それを返す（中身が変われば新しい id で記録し直す）。
function nextWaveOf(L, dir, P, d) {
  // halt_kind は halt の種類（stop: 台帳が止まる条件・time: 時間の区切り・limit: 今の段の起動数の上限・rows: 呼び出しの行の数の区切り）。呼ぶ側が理由の文でなく欄で判じる。
  const halt = (reason, kind) => ({ halt: true, halt_kind: kind, reason })
  if (d.stop) return halt(`台帳が止まる条件に当たった（${d.stop}: ${(d.reasons || []).join(' / ')}）。新しい波は起動しない。呼ぶ側は ingest の後の next で結果を受け取る`, 'stop')
  const elapsed = nowMs() - P.opened_at
  if (elapsed > CALL_BUDGET_MS) return halt(`呼び出しを開いてからの経過 ${elapsed}ms が、時間の区切り timeoutMs − agentTimeoutMs（${CALL_BUDGET_MS}ms）を超えた。新しい波は起動しない。続きは次の呼び出しが進める`, 'time')
  const remain = budgetRemain(L)
  const cap = Math.min(C.LIMITS.maxAgents - P.rows_total, remain)
  if (cap <= 0) return halt(remain <= 0 ? `今の段の起動数が上限 ${L.config.max_agents_total} に達した。新しい波は起動しない。next が止まる理由を返す` : `この呼び出しで出した行の和 ${P.rows_total} が上限 maxAgents ${C.LIMITS.maxAgents} に達した。新しい波は起動しない。続きは次の呼び出しが進める`, remain <= 0 ? 'limit' : 'rows')
  const W = makeWave(L, P, d, cap)
  if (!P.next || P.next.sig !== W.sig) { addHints(L, dir, P, d.step); P.next = { ...W, wave_id: ++L.wave_seq } }
  return { next_wave: { id: P.next.wave_id, rows: P.next.workers } }
}

// 起動の記録を台帳に取り込む（段と波の印つき）。model・effort・段が台帳の波の記録と違う起動と、記録に無い波の起動は、欠けとして出来事に残す
// （その起動の提出は、claim が台帳の行と照らして既に拒んでいる）。
export function recordCall(L, P, res, failed) {
  const ag = Array.isArray(res.agents) ? res.agents : []
  for (const a of ag) {
    L.agents.push({ call_id: P.call_id, cycle: L.cycle, stage: a.stage ?? P.step, wave: a.wave ?? null, role: a.role, label: a.label, model: a.model, effort: a.effort, ok: !!a.ok })
    if (a.wave == null) continue
    const W = P.launched.find((x) => String(x.id) === String(a.wave))
    const row = W && (W.workers.find((w) => `${w.role}-${w.id}` === a.label) || W.workers.find((w) => w.role === a.role))
    if (!row) addEvent(L, a.stage || P.step, 'launch_mismatch', `${a.label}（${a.model}/${a.effort}）: 起動の記録の波 ${a.wave} の行が、台帳の起動した波の記録に無い`, a.label)
    else if (row.model !== a.model || row.effort !== a.effort || (a.stage != null && row.stage !== a.stage)) addEvent(L, row.stage, 'launch_mismatch', `${a.label}: 起動の記録（${a.stage}/${a.model}/${a.effort}）が台帳の波 ${a.wave} の行（${row.stage}/${row.model}/${row.effort}）と違う`, a.label)
  }
  const tokens = typeof res.tokens === 'number' && Number.isFinite(res.tokens) ? res.tokens : null
  L.calls.push({ call_id: P.call_id, cycle: L.cycle, step: P.launched[0].step, stages: P.launched.map((x) => x.step), waves: P.launched.length, agents: ag.length, failed: ag.filter((a) => !a.ok).length, submits: P.prev_submits + (P.submits || 0), tokens, tokens_note: tokens == null ? '消費量を run の中で読めない経路（runner など）' : 'この呼び出しの budget.spent() の差' })
  L.fail_streak = failed ? L.fail_streak + 1 : 0
  for (const a of ag) if (!a.ok && !(P.reported || []).includes(`${a.wave}|${a.label}`)) addEvent(L, a.stage || P.step, 'agent_missing', `${a.label}（${a.model}/${a.effort}）が返らなかったか不正な出力だった`, a.label)
}

// native Workflow の tasks の .output（返り値を result に包んだ形）も、そのまま受け付ける。包みの判定は coverage-build の build-cli.mjs と同じ。
export function unwrap(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return v
  return Object.hasOwn(v, 'result') && typeof v.summary === 'string' && typeof v.agentCount === 'number' ? v.result : v
}

// ingest: --call の呼び出しを閉じるだけ（B3）。返り値から読むのは起動の記録（agents）と tokens だけで、役の出力や集約は受け取らない（全て submit で台帳に入っている）。
// 進みの無かった呼び出しは環境の失敗に数える: claim が 1 度も無い全体の段、提出が 1 件も無い読む段（ファイルの段・振り返り）、全ての役が欠けて受理が 0 の計画の段
// （全体の段の行は開いた意図のある種類にだけ作るので、claim が無ければ worker が起動されていない。取った後に提出が無いのは意図の試行に数える）。
// 役が返らなくても（時間の上限など）、受理か提出があった呼び出しは環境の失敗にしない。
export function noProgress(P, ag) {
  const accepted = P.accepted || 0
  // 全文レビューの失敗は止める理由にしない（網羅はファイルの段が持つ。設計「段の構成」の全文レビュー）。
  if (P.step === FULL_REVIEW) return false
  if (P.step === 'global') return !P.claims && !accepted
  if (READ_STEPS.includes(P.step)) return !P.submits
  return !accepted && ag.length > 0 && ag.every((a) => !a.ok)
}
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
  // 記録した次の波が起動されたのに、どの行も claim しなかった（起動の記録にその波がある）なら、その波を今の波にしてから締める
  // （起動されたのに claim しない行は試行に数える。起動の記録の無い波は、起動されなかったので数えない）。
  if (P.next && ag.some((a) => a.wave != null && String(a.wave) === String(P.next.wave_id))) promote(L, dir)
  // 今の波（最後に起動した波）の起動の記録。波の印の無い記録は今の波のものとして読む。
  const cur = ag.filter((a) => a.wave == null || String(a.wave) === String(P.wave_id))
  // fail_streak に数えるのは、どの波にも進みが無かった呼び出しだけ（設計「モデルと費用」の起動の原則: 1 体の時間の上限に当たった残りは次の呼び出しが取る）。
  // 環境の失敗の印（env_attempts）は、今の波の進みで付ける（前の波に進みがあっても、進みの無い波の取り残しは環境の失敗の試行）:
  // - 全体の段: claim も受理も 0（worker が起動されなかった）。読む段（ファイルの段・振り返り）: submit が 0。計画の段: 全ての役が欠け、受理が 0。
  // 進みのあった呼び出しで返らなかった役は、取ったまま出していない担当の試行に数えるだけにする（closeWave）。
  const waveFailed = noProgress(P, cur)
  const allFailed = !P.progressed && waveFailed
  recordCall(L, P, r, allFailed)
  L.hints_read.push(...P.hints)
  const rejected = L.events.slice(P.events_at).filter((e) => e.kind.startsWith('rejected_')).map((e) => e.text)
  closeCall(L, { env: waveFailed, lost: cur.some((a) => !a.ok) })
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
// ファイルの段の担当: 1 単位（写しの範囲）と、全ての観点と、義務（目標・受け入れ基準）。他の役の書き込み（事実）は返さない。
// 振り返りの単位（出来事の写し）も同じ形で、kind は retro、観点は振り返りの観点。
function fileTask(L, dir, call, w, id) {
  const a = L.assets[id]
  const tid = fileTaskId(id)
  const hs = hintsOf(dir, L.pending.hints)
  return {
    id: tid, kind: a.retro ? 'retro' : 'file', result_path: resultPath(dir, call, w.id, tid), unit: { id, path: a.path, file: a.snap, start: a.start, end: a.end },
    lenses: lensesFor(L, a).map((l) => ({ id: l.id, name: l.name, procedure: l.procedure })), obligations: obligations(L), ...(hs.length ? { hints: hs } : {}),
  }
}
const boundTask = (dir, call, t) => ({ id: t.id, kind: t.kind, result_path: resultPath(dir, call, t.worker, t.id), ...(t.lenses ? { lenses: t.lenses } : {}) })

// claim: 波の行の担当を返す。--wave・--model・--effort・--stage は Workflow script が行の値を埋めた命令で、台帳の波の記録と照らす
// （違えば終了状態 2 で拒み、台帳を変えない。役が返り値の印を書き換えても、空の起動か早い停止になるだけ）。
// - 記録した次の波の最初の claim は波の境目: 今の波の会計を締めてから、次の波を今の波にする。前の波の行の claim は done だけを返す。
// - 順序の門: 波の段が、その時の decide の段と合わなければ、担当を渡さない（その波の取られていない担当を手放す）。
// - ファイルの段と振り返りは、行に結んだ詰め合わせの単位を全て取る（出し終えていない単位を持っていれば、それだけを同じ形で返す）。
//   全体の段は、自分の種類の開いた意図を束で取る（量は query が返す入力のバイト数の和で線まで）。計画の段は、行に結んだ担当を返す。
// 取る物が無ければ done。波のどの行にも取られていない担当が無くなった時点の done には、次の波（next_wave）か止まる印（halt と reason）を載せる。
// 返す前に結果の path の古いファイルを消す。
function cmdClaim(o) {
  const dir = path.resolve(need(o, 'state'))
  return withLock(dir, () => {
    const L = load(dir)
    const call = need(o, 'call')
    const worker = need(o, 'worker')
    const wave = need(o, 'wave')
    const got = { model: need(o, 'model'), effort: need(o, 'effort'), stage: need(o, 'stage') }
    const P = L.pending
    if (!P) throw new Fail(`開いた呼び出しが無い（呼び出し ${call} は閉じた。worker を終える）`)
    if (call !== P.call_id) throw new Fail(`呼び出しが違う: 今は ${P.call_id}、受け取ったのは ${call}（前の呼び出しは閉じた。worker を終える）`)
    const at = String(P.wave_id) === wave ? 'current' : P.next && String(P.next.wave_id) === wave ? 'next' : P.launched.some((x) => String(x.id) === wave) ? 'old' : null
    if (!at) throw new Fail(`台帳に記録の無い波: ${wave}（この呼び出しの波は ${[...P.launched.map((x) => x.id), ...(P.next ? [P.next.wave_id] : [])].join('・')}。返り値の次の波の印は書き換えずに返す）`)
    const rows = at === 'current' ? P.workers : at === 'next' ? P.next.workers : P.launched.find((x) => String(x.id) === wave).workers
    const w = rows.find((x) => x.id === worker)
    if (!w) throw new Fail(`波 ${wave} の行に無い worker: ${worker}`)
    const bad = Object.keys(got).filter((k) => got[k] !== w[k])
    if (bad.length) throw new Fail(`claim の行の値が台帳の波 ${wave} の記録と違う: ${bad.map((k) => `--${k} ${got[k]}（記録は ${w[k]}）`).join('・')}`)
    // 前の波の行: その波は締めたので、担当を渡さない。
    if (at === 'old') return { ok: true, done: true }
    if (at === 'next') promote(L, dir)
    P.claims += 1
    if (!P.claimed_rows.includes(w.id)) P.claimed_rows.push(w.id)
    const tasks = takeTasks(L, dir, w, advance(L, dir))
    if (tasks) {
      save(dir, L)
      for (const task of tasks) {
        mkdirSync(path.dirname(task.result_path), { recursive: true })
        rmSync(task.result_path, { force: true })
      }
      return { ok: true, tasks, submit_cmd: submitCmd(dir, P.call_id, w) }
    }
    if (!P.done_rows.includes(w.id)) P.done_rows.push(w.id)
    const out = pendingWork(L, P) ? {} : nextWaveOf(L, dir, P, advance(L, dir))
    save(dir, L)
    return { ok: true, done: true, ...out }
  })
}
// 今の波の行 w に渡す担当（無ければ null）。d はその時の decide（順序の門に使う）。
function takeTasks(L, dir, w, d) {
  const P = L.pending
  const call = P.call_id
  if (d.stop || d.step !== P.step) { staleWave(L); return null }
  if (READ_STEPS.includes(P.step)) {
    // 1 worker は 1 つの波で、行に結んだ詰め合わせの単位だけを読む。最初の claim で詰め合わせの単位を全て取り、
    // 出し終えていない単位があればそれだけを返し、全て出し終えた（受理か開示）後の claim は done を返す（同じ文脈で詰め合わせの外の単位を読ませない）。
    P.file_taken = P.file_taken || {}
    if (!P.file_taken[w.id]) {
      P.file_taken[w.id] = true
      for (const k of (P.bundles && P.bundles[w.id]) || []) { const a = L.assets[k]; if (claimable(a)) a.claim = { call, worker: w.id } }
    }
    const ids = Object.keys(L.assets).filter((k) => L.assets[k].claim && L.assets[k].claim.call === call && L.assets[k].claim.worker === w.id)
    return ids.length ? ids.map((id) => fileTask(L, dir, call, w, id)) : null
  }
  if (P.step === 'global') {
    // 出し終えていない意図を持っていればそれだけを返す（新しい意図を混ぜない）。無ければ自分の種類の開いた意図を、意図の並びの順で前から、
    // query が返す入力の量の和が線に収まる所まで束で取る（next-fit。1 件だけで超える意図は単独の束。設計の決定 16）。
    const B = board(L)
    const ids = []
    for (const k of Object.keys(P.intent_claims).filter((x) => P.intent_claims[x].worker === w.id && !P.intent_claims[x].done)) {
      const it = B.byId.get(k)
      if (!it || it.state !== 'open') P.intent_claims[k].done = true
      else ids.push(k)
    }
    if (!ids.length) {
      // 上限は、前の呼び出しで束を取って 0 件のまま閉じた役の種類なら、その束の量の半分（closeWave が台帳に置く）。無ければ線（lineOf）。
      const cap = (L.bundle_caps || {})[w.role] ?? lineOf(L)
      const pairs = sameLocationPairs(B.facts.values())
      let bytes = 0
      for (const it of B.intents.filter((i) => i.state === 'open' && (P.kinds[w.id] || []).includes(i.kind) && !P.intent_claims[i.id])) {
        const n = entryBytes(intentEntry(L, B, it, intentTaskId(it.id, call), pairs))
        if (ids.length && bytes + n > cap) break
        ids.push(it.id)
        bytes += n
        // 意図ごとの量を取りの記録に置く（0 件のまま閉じた束の量を closeWave が足し直す）。
        P.intent_claims[it.id] = { worker: w.id, done: false, bytes: n }
      }
    }
    return ids.length ? ids.map((id) => intentTask(L, dir, call, w, B.byId.get(id))) : null
  }
  const t = P.tasks.find((x) => x.worker === w.id && !x.done)
  if (!t) return null
  t.claimed = true
  return [boundTask(dir, call, t)]
}

// query: 担当が読む入力を台帳から引く（B1）。ファイルの段と振り返りの担当は拒む（他の役の書き込みを読まず、独立に読む）。
// 計画の段の担当には、その担当が要る文（目標・依頼文・索引・案・欠陥・回答・観点）だけを返す。--fact は今の根拠の事実を id で引く。
// 全体の段は --task を複数受け、取った束の意図の入力を --task の順に tasks で 1 回で返す（--task が 1 つなら 1 件の形）。どれかが担当に無ければ拒む。
function cmdQuery(o) {
  const dir = path.resolve(need(o, 'state'))
  return withLock(dir, () => {
    const L = load(dir)
    const w = pendingWorker(L, o)
    const P = L.pending
    const tids = need(o, 'task')
    if (READ_STEPS.includes(P.step) || tids.some((x) => x.startsWith('file:'))) throw new Fail('ファイルの段と振り返りの担当は query できない（他の役の書き込みを読まない。B1）')
    // 全文レビューの担当: 目標と読む範囲の単位の一覧だけを返す。事実（他の役の書き込み・前の run の指摘と判定）は引けない（B1）。
    if (P.step === FULL_REVIEW) {
      if (o.fact) throw new Fail('全文レビューの担当は --fact で事実を引けない（他の役の書き込みを読まない。B1）')
      const tid = oneTask(tids)
      const t = P.tasks.find((x) => x.id === tid && x.worker === w.id)
      if (!t) throw new Fail(`この worker の担当に無い: ${tid}`)
      return { ok: true, task: t.id, kind: t.kind, inputs: fullReviewInputs(L) }
    }
    const B = board(L)
    const facts = (o.fact || []).map((id) => { if (!B.facts.has(id)) throw new Fail(`今の根拠に無い事実: ${id}`); return publicFact(L, B.facts.get(id)) })
    if (P.step === 'global') {
      // 意図の根拠と関係する事実だけを返す（B1）。前の判定は今の根拠から外れているので返さない。載せなかった件数は omitted で宣言する。
      const its = tids.map((tid) => {
        const id = Object.keys(P.intent_claims).find((k) => intentTaskId(k, P.call_id) === tid && P.intent_claims[k].worker === w.id)
        if (!id) throw new Fail(`この worker が取った意図の担当に無い: ${tid}`)
        const it = B.byId.get(id)
        if (!it) throw new Fail(`意図が今の根拠から外れた: ${id}（next からやり直す）`)
        return [tid, it]
      })
      const pairs = sameLocationPairs(B.facts.values())
      const entries = its.map(([tid, it]) => intentEntry(L, B, it, tid, pairs))
      if (entries.length === 1) return { ok: true, ...entries[0], ...(o.fact ? { facts } : {}) }
      return { ok: true, tasks: entries, ...(o.fact ? { facts } : {}) }
    }
    const tid = oneTask(tids)
    const t = P.tasks.find((x) => x.id === tid && x.worker === w.id)
    if (!t) throw new Fail(`この worker の担当に無い: ${tid}`)
    return { ok: true, task: t.id, kind: t.kind, inputs: inputsOf(L, dir, t), ...(o.fact ? { facts } : {}) }
  })
}
const item = (c) => ({ id: c.id, text: c.text })
// 全体の段の外の担当は、--task を 1 つだけ受ける。
const oneTask = (tids) => { if (tids.length !== 1) throw new Fail(`この段の担当は --task を 1 つだけ受ける: ${tids.length} 個`); return tids[0] }
// 全文レビューの入力: 目標（冒頭の文・項目・基準・制約）と、読む範囲の単位（id・path・写しの file と範囲）。参照（--context）の単位は context: true で足す
// （読む範囲に数えないが、引用の根拠にできる）。観点・索引・ヒント・事実は載せない。
const fullReviewInputs = (L) => ({
  goal: L.goal.text, items: L.goal.items.map(item), criteria: L.criteria.map(item), constraints: L.constraints.map(item),
  units: [...L.full_review.range.map((id) => { const a = L.assets[id]; return { id, path: a.path, file: a.snap, start: a.start, end: a.end } }),
    ...contextUnits(L).map((id) => { const a = L.assets[id]; return { id, path: a.path, file: a.snap, start: a.start, end: a.end, context: true } })],
})
// 索引: 1 行 1 単位（id・写し・範囲・見出しの経路・種類・先頭の数語）。計画役と観点の検証役が手続きの当たる所を見る。
const INDEX_HEAD_WORDS = 8
const INDEX_HEAD_CHARS = 40
function indexRows(L, ids = null) {
  const texts = new Map()
  const textOf = (f) => { if (!texts.has(f)) texts.set(f, read(f)); return texts.get(f) }
  const head = (a) => Array.from(C.norm(rangeText(textOf(a.snap), a.start, a.end)).split(' ').slice(0, INDEX_HEAD_WORDS).join(' ')).slice(0, INDEX_HEAD_CHARS).join('').trim()
  return Object.entries(L.assets).filter(([id, a]) => isTarget(a) && (!ids || ids.includes(id))).map(([id, a]) => ({ id, file: a.snap, start: a.start, end: a.end, trail: (a.trail || []).join(' > '), kind: a.kind, head: head(a) }))
}
function inputsOf(L, dir, t) {
  const base = { goal: L.goal.text, items: L.goal.items.map(item), criteria: L.criteria.map(item), constraints: L.constraints.map(item), hints: hintsOf(dir, L.pending.hints) }
  // 計画役: 計画の入力に、目標の照合が要るとき（照合済みでない）だけ依頼文・決定の記録・項目の id を、計画の見直しのときだけ前の計画・欠陥・回答を足す。
  if (t.kind === 'plan') {
    return {
      ...base, index: indexRows(L), given_lenses: givenLenses(L).map((l) => ({ id: l.id, name: l.name, procedure: l.procedure })),
      ...(t.goalCheck ? { request: L.request, decisions: L.decisions, item_ids: goalIds(L) } : {}),
      ...(t.again ? { previous_plan: L.plan, defects: L.plan_defects.map((x, i) => ({ index: i, ...x })), answers: L.answers.filter((a) => t.answerIds.includes(a.id)) } : {}),
    }
  }
  // 観点の検証役: 計画の版の、確かめていない観点の全て。
  const lenses = (L.plan && L.plan.lenses) || []
  return { ...base, lenses: t.lenses.map((id) => lenses.find((x) => x.id === id)).filter(Boolean), index: indexRows(L) }
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
    if (READ_STEPS.includes(P.step)) {
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
        const r = t.kind === FULL_REVIEW ? submitFullReview(L, t, w, rep(f)) : submitBound(L, t, rep(f))
        if (r.problems.length) rmSync(f, { force: true })
        results.push({ task: t.id, ok: !r.problems.length, problems: r.problems, dropped: r.dropped, ...(r.notes ? { notes: r.notes } : {}) })
      }
    }
    if (results.length) {
      P.submits += results.length
      P.accepted = (P.accepted || 0) + results.filter((x) => x.ok).length
      // 役ごとの提出の数（受理か拒否かを問わない）。取ったまま出さなかった意図の数え方に使う（closeWave）。
      P.worker_submits = { ...(P.worker_submits || {}), [w.id]: ((P.worker_submits || {})[w.id] || 0) + results.length }
      save(dir, L)
    }
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
// 引用はその担当の単位の本文で照らすので、同じ詰め合わせの他の単位を引いた提出は拒む（設計「段の構成」）。
// 振り返りの単位の読みは事実にせず、振り返りの指摘（retro_findings）にだけ足す（対象の指摘・事実・意図・群に入れない）。
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
  if (a.retro) {
    for (const f of Array.isArray(rep.findings) ? rep.findings : []) L.retro_findings.push({ unit: id, read: readId, cycle: L.cycle, lens: f.lens, claim: f.claim, quote: f.quote, obligation: f.obligation, confidence: f.confidence, layer: f.layer, ...(f.severity ? { severity: f.severity } : {}) })
    return { problems: [], dropped: false }
  }
  const have = new Set(L.facts.map((f) => `${f.read}|${f.id}`))
  for (const f of factsOf(rep, { unit: id, path: a.path, read: readId, cycle: L.cycle })) if (!have.has(`${f.read}|${f.id}`)) L.facts.push(f)
  return { problems: [], dropped: false }
}

// 全文レビューを読まなかったとして開示する（出来事に残し、後の段へ進む。止めない）。
// cause は失敗の種類: lost（役が返らなかった。環境の失敗）・unsubmitted（返ったが提出が無いまま試行の上限）・rejected（照合に落ち続けた）。
function failFullReview(L, reason, cause) {
  Object.assign(L.full_review, { state: 'failed', reason, cause })
  addEvent(L, FULL_REVIEW, 'full_review_failed', `全文レビューを読まなかったとして開示し、先へ進む（${reason}）`)
}
// 役が返らなかった（lost）ことで失敗した全文レビューを読み直しにする。blocked（failure）からの再開と、止まった後の新しい回の始まりに流す
// （環境の失敗に数えた試行を戻す一般の規則と同じ）。照合に落ち続けた失敗（rejected・unsubmitted）は戻さない。
function reopenLostFullReview(L) {
  const fr = L.full_review
  if (!fr || fr.state !== 'failed' || fr.cause !== 'lost') return
  Object.assign(fr, { state: 'open', attempts: 0, reason: undefined, cause: undefined })
  addEvent(L, FULL_REVIEW, 'full_review_reopened', '役が返らなかった全文レビューを、再開で読み直しにした')
}
// 全文レビューの結果の照合: 指摘は全体の段が足す指摘と同じ形（場所は読む範囲の単位だけ）、参考は主張と場所。保証・前提は書かない。
function fullReviewProblems(L, rep, range) {
  if (!rep || typeof rep !== 'object' || Array.isArray(rep)) return ['結果が object でない']
  const p = []
  for (const k of ['guarantees', 'premises']) if (rep[k] !== undefined && !(Array.isArray(rep[k]) && !rep[k].length)) p.push(`${k}: 全文レビューは保証・前提を書かない（名寄せと意図の索引はファイルの段が作る）`)
  if (!Array.isArray(rep.findings)) p.push('findings が配列でない')
  if (rep.references !== undefined && !Array.isArray(rep.references)) p.push('references が配列でない')
  p.push(...globalFindingProblems(L, rep.findings, range))
  ;(Array.isArray(rep.references) ? rep.references : []).forEach((r, i) => {
    if (!isStr(r && r.claim)) p.push(`references[${i}]: claim が空`)
    p.push(...locationProblems(L, `references[${i}]`, r, range))
  })
  return p
}
// 全文レビューの提出: 照合を通れば、受理した読みを記録に置き、指摘と参考を事実にする（origin: full_review。引用した全ての単位を場所に持つ）。
// 落ちた提出は試行に数えて出し直させ、上限に達したら読まなかったとして開示する。
function submitFullReview(L, t, w, rep) {
  const fr = L.full_review
  const p = fullReviewProblems(L, rep, [...fr.range, ...contextUnits(L)])
  if (p.length) {
    fr.attempts += 1
    addEvent(L, FULL_REVIEW, 'rejected_full_review', `${t.id}: ${p.join(' / ')}`, t.id)
    if (fr.attempts < MAX_ATTEMPTS) return { problems: p, dropped: false }
    t.done = true
    failFullReview(L, `照合に落ちた提出が ${fr.attempts} 回`, 'rejected')
    return { problems: p, dropped: true }
  }
  t.done = true
  const readId = `R${sha(JSON.stringify([FULL_REVIEW, fr.sig, L.pending.call_id, w.id])).slice(0, 12)}`
  Object.assign(fr, { state: 'read', reason: undefined, read: { id: readId, cycle: L.cycle, call: L.pending.call_id, worker: w.id, role: w.role, model: w.model, effort: w.effort } })
  const fact = (type, x, extra) => {
    const locs = x.locations.map((l) => ({ unit: l.unit, path: L.assets[l.unit].path, quote: l.quote }))
    const id = `F${sha(JSON.stringify([FULL_REVIEW, type, C.norm(x.claim), locs.map((l) => [l.unit, C.norm(l.quote)]), x.obligation || ''])).slice(0, 12)}`
    return { id, type, origin: FULL_REVIEW, read: readId, claim: x.claim, quote: locs[0].quote, unit: locs[0].unit, path: locs[0].path, paths: [...new Set(locs.map((l) => l.path))], locations: locs, cycle: L.cycle, ...extra }
  }
  const have = new Set(L.facts.map((f) => `${f.read}|${f.id}`))
  const add = (f) => { const k = `${f.read}|${f.id}`; if (!have.has(k)) { have.add(k); L.facts.push(f) } }
  for (const f of rep.findings) add(fact('finding', f, { obligation: f.obligation, confidence: f.confidence, layer: f.layer, ...(f.severity ? { severity: f.severity } : {}) }))
  for (const r of rep.references || []) add(fact('reference', r, {}))
  return { problems: [], dropped: false }
}

// 計画の段の提出。照合の式は Workflow source の <checks>（C）を使う。
// 計画役: 目標の照合（照合済みでないとき）の外れは試行に数えて拒み、上限で担当を閉じる（stuck → needs_input）。
// 計画の外れは 1 回だけ出し直させ、出し直しでも残る外れは計画の欠陥 P<n> として受け取る（次の計画の段で直させる）。
// 観点の検証役: 落ちた提出を試行に数え、上限で担当を閉じる（stuck → needs_input）。
function submitBound(L, t, rep) {
  t.tries = (t.tries || 0) + 1
  const ctx = planCtx(L)
  const reject = (kind, p) => {
    bump(L, t.akey, false)
    addEvent(L, 'plan', kind, `${t.id}: ${p.join(' / ')}`, t.id)
    if (L.attempts[t.akey] >= MAX_ATTEMPTS) { t.done = true; return { problems: p, dropped: true } }
    return { problems: p, dropped: false }
  }
  if (t.kind === 'plan') {
    if (!rep || typeof rep !== 'object' || Array.isArray(rep)) return reject('rejected_plan', ['結果が object でない'])
    if (t.goalCheck) {
      const g = C.checkGoalMap(rep, goalIds(L), goalSources(L))
      if (g.length) return reject('rejected_plan', g.map((x) => `目標の照合: ${x}`))
    }
    const p = planProblems(rep, { ...ctx, ...(t.again ? { defectCount: t.defectCount, defectKinds: t.defectKinds } : {}) })
    if (p.length && t.tries < MAX_ATTEMPTS) { addEvent(L, 'plan', 'rejected_plan', `${t.id}: ${p.join(' / ')}`, t.id); return { problems: p, dropped: false } }
    clear(L, t.akey)
    t.done = true
    if (t.goalCheck) {
      L.goal.problems = C.goalGaps(rep)
      L.goal.checked = !L.goal.problems.length
      // 目標の穴があれば、その回の計画（質問を含む）は使わない（needs_input で利用者に返す）。
      if (!L.goal.checked) { addEvent(L, 'plan', 'goal_gaps', `目標の照合で、受け止める項目の無い成果が ${L.goal.problems.length} 件ある。この回の計画は使わない`); return { problems: [], dropped: false } }
    }
    if (L.plan) L.plan_rounds += 1
    // no_target を付けた Q3 の欠陥（部分を受け持てる単位が対象に無い）は、計画をやり直さずに呼ぶ側へ返す（decide が needs_input の target_gaps にする）。
    L.target_gaps = t.again ? (Array.isArray(rep.defect_responses) ? rep.defect_responses : []).filter((x) => x && x.action === 'no_target').map((x) => {
      const d = L.plan_defects[x.defect_index]
      return d ? { id: d.id, goal_id: d.goal_id ?? null, lens: d.unit_id || null, reason: x.reason, quote: d.quote } : null
    }).filter(Boolean) : []
    for (const g of L.target_gaps) addEvent(L, 'plan', 'target_gap', `${g.id}（${g.lens} の ${g.goal_id}）: 部分を受け持てる単位が対象に無い（${g.reason}）`, g.id)
    L.plan_defects = []
    L.plan = { lenses: rep.lenses, questions: rep.questions, constraint_map: rep.constraint_map }
    // 受理した計画の観点は観点の検証を通す（前に提案なしで進めた印を外す。目標の照合をやり直して計画が入ったとき、検証を飛ばさない）。
    L.plan_skipped = false
    // 計画を変えたら全体を照らし直す: 残った静的な外れは計画の欠陥にし、次の計画の段で直させる。
    L.plan_problems = planProblems(L.plan, ctx)
    for (const x of L.plan_problems) { addPlanDefect(L, { unit_id: '', kind: 'static', claim: x, quote: '' }); addEvent(L, 'plan', 'static_problem', x) }
    L.answered.push(...t.answerIds)
    syncPlanLenses(L)
    return { problems: [], dropped: false }
  }
  // 観点の検証: 計画の版の観点ごとにちょうど 1 つの答えの組を照らす。計画が変わった後の担当は使わない（次の呼び出しで今の観点を検証する）。
  const lenses = (L.plan && L.plan.lenses) || []
  const us = t.lenses.map((id) => lenses.find((x) => x.id === id))
  if (us.some((u, i) => !u || C.unitKey(u) !== t.keys[t.lenses[i]])) { t.done = true; return { problems: ['計画が変わった後の担当（今の計画の観点と違う）'], dropped: true } }
  const got = rep && typeof rep === 'object' && Array.isArray(rep.lenses) ? rep.lenses : null
  const p = []
  if (!got) p.push('lenses（観点ごとの答えの組の配列）が無い')
  else {
    for (const x of got) if (!x || !t.lenses.includes(x.unit_id)) p.push(`lenses に渡していない観点: ${x && x.unit_id}`)
    for (const u of us) {
      const rs = got.filter((x) => x && x.unit_id === u.id)
      if (rs.length !== 1) { p.push(`観点 ${u.id} の答えの組が ${rs.length} つある（ちょうど 1 つ）`); continue }
      p.push(...C.checkUnitVerdict(rs[0], u.id, Array.isArray(u.goals) ? u.goals : [], C.unitText(u)).map((x) => `${u.id}: ${x}`))
    }
  }
  if (p.length) return reject('rejected_unit_check', p)
  clear(L, t.akey)
  for (const u of us) {
    const goals = Array.isArray(u.goals) ? u.goals : []
    const ds = C.unitDefects(got.find((x) => x.unit_id === u.id), u.id, goals)
    if (ds.length) for (const d of ds) { addPlanDefect(L, d); addEvent(L, 'plan', 'unit_defect', `${u.id}: ${d.claim}`, u.id) }
    else L.verified_units.push(C.unitKey(u))
  }
  t.done = true
  return { problems: [], dropped: false }
}

// 今の段の status の節: 指摘・束ね・出来事。reframe で出ていく段の節は、この形のまま phase_records に写す。
// 判定・単位・norm した quote と claim・layer・出どころが同じ今の指摘を 1 件にまとめる（全文レビューとファイルの段の重なりは、出どころを残すためまとめない）。
function mergedFindings(L) {
  const m = new Map()
  for (const f of currentFindings(L)) {
    const k = JSON.stringify([f.verdict, Array.isArray(f.paths) ? [...f.paths].sort().join('\n') : f.id.split('|')[0], C.norm(f.quote), C.norm(f.claim), f.layer, f.origin ?? null])
    if (m.has(k)) m.get(k).ids.push(f.id)
    else m.set(k, { ...f, ids: [f.id] })
  }
  return [...m.values()]
}
function phaseSection(L) {
  const cur = mergedFindings(L)
  const gs = L.groups || []
  const by = (k) => cur.reduce((m, f) => ({ ...m, [f[k]]: (m[f[k]] || 0) + 1 }), {})
  const groupsOf = (ids) => gs.filter((g) => (g.keys || []).some((k) => ids.includes(k))).map((g) => g.id)
  return {
    findings: { by_verdict: by('verdict'), by_layer: by('layer'), confirmed: cur.filter((f) => f.verdict === 'confirmed').map((f) => ({ id: f.id, ids: f.ids, severity: f.severity, layer: f.layer, claim: f.claim, quote: f.quote, ...(f.paths ? { paths: f.paths, obligation: f.obligation, confidence: f.confidence, origin: f.origin, provenance: provenance(L, f) } : {}), groups: [...new Set(groupsOf(f.ids))] })), unverifiable: cur.filter((f) => f.verdict === 'unverifiable').map((f) => ({ id: f.id, ids: f.ids, claim: f.claim })) },
    groups: gs.map((g) => ({ id: g.id, layer: g.layer, root_cause: g.root_cause, keys: g.keys })),
    events: phaseEvents(L).map((e) => ({ id: e.id, stage: e.stage, kind: e.kind, text: e.text })),
  }
}
// 事実の公開の形（受理した読みの id は載せない）。単位を持つ事実と場所には、原文を開くための写しの file と範囲（start・end）を載せる（B1）。
const snapOf = (L, unit) => { const a = unit && L.assets[unit]; return a && a.snap ? { file: a.snap, start: a.start, end: a.end } : {} }
const publicFact = (L, f) => {
  const { read: _r, ...rest } = f
  return { ...rest, ...(f.unit ? snapOf(L, f.unit) : {}), ...(Array.isArray(f.locations) ? { locations: f.locations.map((l) => ({ ...l, ...snapOf(L, l.unit) })) } : {}) }
}
// 単位の一覧（振り返りの単位を除く）。disclosed は見られなかった理由（reason）を持つ。
// carried は持ち越した読み（今の回より前の周に受理した読み）の印。
function unitsOf(L) {
  return Object.entries(L.assets).filter(([, a]) => isTarget(a)).map(([id, a]) => ({ id, path: a.path, file: a.snap, start: a.start, end: a.end, hash: a.hash, state: a.state, ...(a.state === 'disclosed' ? { reason: a.reason } : {}), ...(carriedRead(L, a) ? { carried: true } : {}) }))
}
// 止まったときに書く status のファイル。段が無い台帳（呼ぶ側が段を渡さない）は status.json。
export const statusPath = (dir, L) => path.join(dir, L.phase ? `status-${L.phase}.json` : 'status.json')
function cmdStatus(o) {
  const dir = path.resolve(need(o, 'state'))
  return statusOf(load(dir))
}
function statusOf(L) {
  const B = board(L)
  const sec = phaseSection(L)
  const roles = {}
  for (const a of L.agents) { const k = `${a.role}|${a.model}|${a.effort}`; roles[k] = roles[k] || { launched: 0, failed: 0 }; roles[k].launched++; if (!a.ok) roles[k].failed++ }
  const facts = [...B.facts.values()]
  return {
    // 上の階層の findings・groups・events は今の段のもの。phases は段ごとの節（出ていった段は phase_records の写し）。
    phase: L.phase, phases: { ...L.phase_records, ...(L.phase ? { [L.phase]: sec } : {}) },
    cycle: L.cycle, stopped: L.stopped || null, pending: L.pending ? { call_id: L.pending.call_id, step: L.pending.step, wave: L.pending.wave_id } : null, coverage: coverage(L), units: unitsOf(L),
    // 参照（--context）の単位。網羅・skip・全文レビューの範囲に数えない。
    context: contextUnits(L).map((id) => { const a = L.assets[id]; return { id, path: a.path, file: a.snap, start: a.start, end: a.end } }),
    // 全文レビューの読んだ単位と読まなかった単位（網羅と別の一覧。skip・coverage に数えない）。
    full_review: fullReviewStatus(L),
    skip: Object.entries(L.assets).filter(([, a]) => isTarget(a) && a.state === 'disclosed').map(([id, a]) => ({ unit: id, reason: a.reason })),
    // 今の根拠の事実（ファイルの段の指摘の候補・保証・前提・参考）。指摘の候補は全体の段の判定を通るまで findings に入らない。
    facts: facts.map((f) => publicFact(L, f)), references: [...facts.filter((f) => f.type === 'reference').map((f) => ({ id: f.id, unit: f.unit, path: f.path, claim: f.claim, quote: f.quote, origin: f.origin })), ...B.findings.references],
    // 全体の段の意図（根拠の事実の id と状態）と、判定できずに開示して閉じた意図（理由つき）。
    intents: B.intents.map((i) => ({ id: i.id, kind: i.kind, basis: i.basis, state: i.state, ...(i.item ? { item: i.item } : {}), ...(i.reason ? { reason: i.reason } : {}) })),
    undecided: B.intents.filter((i) => i.state === 'undecided').map((i) => ({ id: i.id, kind: i.kind, reason: i.reason })),
    // 振り返り（単独で呼ばれたときだけ）: 出来事の写しの単位と、振り返りの指摘。対象の指摘・事実・参考・意図・群とは別の欄。
    retro: { units: Object.entries(L.assets).filter(([, a]) => a.retro).map(([id, a]) => ({ id, file: a.snap, start: a.start, end: a.end, state: a.state, ...(a.state === 'disclosed' ? { reason: a.reason } : {}) })), findings: L.retro_findings.map(({ read: _r, ...f }) => f) },
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
    // 目標・基準・制約の本文の path は、init の --repo（無ければ init の cwd）を基準に照らす。
    const pp = framePathProblems(g, { repo: L.repo, targets: L.targets, contexts: L.contexts })
    if (g.problems.length || pp.length) throw new Fail(`直した ${id} が引用か path の照合を通らない（台帳は変えていない）`, { problems: [...g.problems, ...pp] })
    Object.assign(L, { goal: { text: text.goal, items: g.goal, checked: false, checked_by: null, problems: [] }, decisions: text.decisions, criteria: g.criteria, constraints: g.constraints })
    // 目標の照合は計画役が担うので、計画の段の試行を戻す（照合の外れで stuck になっていても、直した目標で照合し直せる）。
    clear(L, 'plan')
    // 基準・制約の id が変われば、計画の受け皿が合わなくなる。静的な欠陥として計画役に直させる。
    if (L.plan) for (const x of planProblems(L.plan, planCtx(L))) addPlanDefect(L, { unit_id: '', kind: 'static', claim: x, quote: '' })
    save(dir, L)
    return { ok: true, next: '目標の照合からやり直す。next を流す' }
  }
  const text = need(o, 'text')
  const isQ = ((L.plan && L.plan.questions) || []).some((q) => q.id === id)
  // 計画の欠陥（P<n>）への回答は、計画の質問への回答と同じく決定の記録と制約にし、計画からやり直す。指せるのは今の欠陥だけ。
  const isP = !isQ && (L.plan_defects.some((d) => d.id === id) || (L.target_gaps || []).some((g) => g.id === id))
  const known = isQ || isP || L.findings[id] || board(L).groups.some((g) => g.id === id) || id.startsWith('attempts:')
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
// symlink 経由（.claude/skills -> .agents/skills）で流しても一致させる。import.meta.url は実体の path になる。
if (process.argv[1] && realpathSync(path.resolve(process.argv[1])) === fileURLToPath(import.meta.url)) runMain(process.argv.slice(2))
