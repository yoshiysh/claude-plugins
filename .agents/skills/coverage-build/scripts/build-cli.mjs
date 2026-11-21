#!/usr/bin/env node
// 台帳を書く唯一の口。init → next →（Workflow が worker を起動し、worker が claim・query・submit で台帳と読み書きする / coverage-audit / run-checks）
// → ingest --call / import-audit を繰り返し、next が止まる条件を返したら終わる（設計 docs/design/coverage-ledger-method.md「台帳と見たの記録」の B1〜B6）。
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  C, MAX_ATTEMPTS, PHASES, TASK_ROLE, addEvent, attemptKey, decide, depsDone, dropIntent, dueEvents, dueGroups, examinedIntents, goalIds, implPending, importAudit, newLedger,
  applyRedo, ownedPaths, ownerOf, packUnits, queuedIntents, readGoalFiles, redoSummary, renderDesign, route, rowIdsOf, settleRetro, sha, submitTask, taskTitle, testsTodo, unitList, coverIds,
} from './build-core.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SKILL_DIR = path.dirname(HERE)
// どの段も同じ 1 つの Workflow source（役は全て result_path を書いて submit を流すので、書かない run を分ける理由が無い）。
const WORKFLOW = path.join(HERE, 'build-step.js')
const CHECK_TIMEOUT_MS = 1800000

class Fail extends Error { constructor(msg, extra = {}) { super(msg); this.extra = extra } }
const MULTI = ['input', 'target', 'check']
const KNOWN = {
  init: ['state', 'mode', 'repo', 'goal', 'request', 'decisions', 'criteria', 'constraints', 'input', 'target', 'check', 'roles', 'max-cycles', 'max-agents-total', 'max-unit-rounds'],
  next: ['state'], ingest: ['state', 'call', 'result'], 'import-audit': ['state'], 'run-checks': ['state'], status: ['state'],
  claim: ['state', 'call', 'worker'], query: ['state', 'call', 'worker', 'task'], submit: ['state', 'call', 'worker'],
  hint: ['state', 'text'], answer: ['state', 'id', 'text', 'file'], dismiss: ['state', 'id', 'text'], config: ['state', 'max-cycles', 'max-agents-total', 'max-unit-rounds'],
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
function posInts(o, keys) {
  const out = {}
  for (const [k, ck] of keys) {
    if (o[k] === undefined) continue
    if (!/^[1-9]\d*$/.test(o[k]) || !Number.isSafeInteger(Number(o[k]))) throw new Fail(`--${k} は正の整数: ${o[k]}`)
    out[ck] = Number(o[k])
  }
  return out
}
const LIMIT_KEYS = [['max-cycles', 'max_cycles'], ['max-agents-total', 'max_agents_total'], ['max-unit-rounds', 'max_unit_rounds']]
const ledgerPath = (dir) => path.join(dir, 'build.json')
function load(dir) {
  if (!existsSync(ledgerPath(dir))) throw new Fail(`台帳が無い: ${ledgerPath(dir)}（init を先に流す）`)
  const L = JSON.parse(read(ledgerPath(dir)))
  if (!L.goal || !Array.isArray(L.goal.items)) throw new Fail(`台帳の形式が古い（目標の項目と引用を持たない）: ${ledgerPath(dir)}。goal.md などを 1 行 1 件・引用つきに直し、新しい stateDir で init からやり直す`)
  if (!Array.isArray(L.audit_events_seen)) throw new Fail(`台帳の形式が古い（coverage-audit の出来事の受けた記録を持たない）: ${ledgerPath(dir)}。新しい stateDir で init からやり直す`)
  if (!L.audit_groups || typeof L.audit_groups !== 'object') throw new Fail(`台帳の形式が古い（設計レビューの群を持たない）: ${ledgerPath(dir)}。新しい stateDir で init からやり直す`)
  if (L.arch && !Array.isArray(L.arch.contracts)) throw new Fail(`台帳の形式が古い（方式設計が境界の約束を持たない）: ${ledgerPath(dir)}。新しい stateDir で init からやり直す`)
  if (!Number.isInteger(L.call_seq)) throw new Fail(`台帳の形式が古い（役が claim・query・submit で読み書きする呼び出しの通し番号を持たない）: ${ledgerPath(dir)}。新しい stateDir で init からやり直す`)
  return L
}
function writeAtomic(file, text) {
  mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, text)
  renameSync(tmp, file)
}
function save(dir, L) { L.rev += 1; writeAtomic(ledgerPath(dir), JSON.stringify(L, null, 1)) }
const hints = (dir) => { const f = path.join(dir, 'hints.jsonl'); return existsSync(f) ? read(f).split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [] }
// 役が最初の claim を流す入口（stateDir/build-cli.mjs）。args は {state, callId, stage, workers} だけ（B4）で CLI の置き場を運べないので、
// Workflow source は stateDir の下のこの名前を prompt に書く。中身は本物の CLI を絶対パスで import して流すだけで、判断も照合も持たない。
// plugin の置き場が変わっても古い path が残らないよう、init と next のたびに書き直す。
export const LAUNCHER = 'build-cli.mjs'
export const launcherText = () => `// 生成物: ${LAUNCHER} が init・next のたびに書き直す。本物の CLI を流すだけ。\nimport { runMain } from ${JSON.stringify(pathToFileURL(fileURLToPath(import.meta.url)).href)}\nrunMain(process.argv.slice(2))\n`
const writeLauncher = (dir) => writeAtomic(path.join(dir, LAUNCHER), launcherText())
// 呼び出しを開く・閉じるコマンドと担当のコマンド（next・ingest・claim・query・submit）は、load から save までを stateDir/build.lock で囲む
// （並べて動く worker の claim・submit を直列にする）。lock は openSync の wx で取り、取れなければ短く眠って取り直し、LOCK_WAIT_MS を超えたら台帳を変えずに Fail にする。
// 古い lock は自動で消さない（奪うと 2 つの process が同時に書く窓ができる）。lock には取得ごとの token を書き、中身が自分の token のときだけ消す。
const LOCK_WAIT_MS = 10000
const LOCK_STALE_MS = 60000
const LOCK_SLEEP_MS = 20
const nap = new Int32Array(new SharedArrayBuffer(4))
function withLock(dir, fn) {
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'build.lock')
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
const abs = (L, rel) => path.join(L.repo, rel)
const fileHash = (p) => (existsSync(p) ? sha(read(p)).slice(0, 16) : null)
const fileKey = (ps) => sha([...ps].sort().map((p) => `${p}\0${fileHash(p) ?? 'missing'}`).join('\n')).slice(0, 16)
const designDir = (dir) => path.join(dir, 'design')
const designFiles = (L, dir) => Object.keys(renderDesign(L)).map((f) => path.join(designDir(dir), f))

// 設計の写しを台帳から書き直す（CLI だけが書く。消えた単位のファイルは消す）。
function writeDesign(L, dir) {
  const files = renderDesign(L)
  mkdirSync(designDir(dir), { recursive: true })
  for (const f of readdirSync(designDir(dir))) if (!(f in files)) rmSync(path.join(designDir(dir), f))
  for (const [f, t] of Object.entries(files)) if (!existsSync(path.join(designDir(dir), f)) || read(path.join(designDir(dir), f)) !== t) writeAtomic(path.join(designDir(dir), f), t)
}
function keysOf(L, dir) {
  return { baseline: fileKey(L.targets), review: fileKey(L.targets), design: fileKey(designFiles(L, dir)), impl: fileKey(ownedPaths(L).map((p) => abs(L, p))) }
}
// 担当の引用と取り込みの引用を照らすときに読んでよいファイル: stateDir の中、入力、対象、単位が持つファイル。
// 読める集合は呼ぶたびに今の台帳から作る（同じ ingest の中で方式設計が単位の持つファイルを変える）。
function reader(L, dir) {
  return (p) => {
    const ok = new Set([...L.inputs, ...L.targets, ...ownedPaths(L).map((x) => abs(L, x))])
    const f = path.isAbsolute(p) ? path.resolve(p) : abs(L, p)
    if (!(ok.has(f) || f.startsWith(dir + path.sep)) || !existsSync(f)) return null
    return read(f)
  }
}
// 詳細設計の premises の path に使ってよいもの: 入力と対象（絶対 path）と、単位が持つ既にあるファイル（repo からの相対 path）。
// 詳細設計の役の query の一覧と、submit の照合は同じこの関数から作る。
const premisePaths = (L) => [...L.inputs, ...L.targets, ...ownedPaths(L).filter((p) => existsSync(abs(L, p)))]
const archInputs = (L, dir) => [...L.inputs, ...(L.mode === 'update' ? L.targets : []), ...(L.baseline ? [path.join(dir, 'audit', 'baseline-status.json')] : [])]
const designPath = (dir, id) => path.join(designDir(dir), `${id}.md`)
const archPath = (dir) => path.join(designDir(dir), '_architecture.md')
const items = (xs) => xs.map((c) => `- ${c.id}: ${c.text}`).join('\n') || '- なし'
const listFiles = (d) => (existsSync(d) ? readdirSync(d, { recursive: true }).map((f) => path.join(d, String(f))).filter((f) => /\.(json|md|log)$/.test(f)) : [])

// coverage-audit に渡す入力を CLI が決定的に書く（司令塔が目標を言い換えない）。
// coverage-audit の台帳は stateDir/audit/state の 1 つに固定する。段の位置（phase.json）が無ければ init、あれば reframe で段と枠（目標・基準・制約・決定の記録・対象）を差し替える。
// reframe は全ての単位を読み直し、計画から作り直す。同じ段・同じ入力で返した reframe を流した後（coverage-audit が書く段の位置 phase.json の段の始まり phase_start が、
// reframe_argv を返したときの控えから変わった後）に next を流し直しても、argv を返し直さない（途中の検査と、coverage-audit の answer で足した A<n> を消さないため）。
// 流す前や、phase.json が読めず控えや今の値が分からない間は reframe_argv を返し直す（誤っても余分な reframe になるだけで、reframe を飛ばさない）。
// coverage-audit の台帳（ledger.json）は読まない。段の位置は coverage-audit が init と reframe で書く stateDir/phase.json（{ phase, phase_start }）だけから読む。
// init は、台帳ができて段が合えば続けさせる。入力が変われば reframe を返す。
// 目標はこのスキルが照合済みなので、init には照合済みの印（--goal-checked coverage-build）を付け、coverage-audit は照合を流さない。reframe は台帳の印を残す。
// 受け入れ基準（単位ごとの受け入れを含む）は制約と取り違えないよう、coverage-audit の基準の欄（criteria.md）で渡す。
// 基準・制約が 0 件なら、その欄のファイルも引数も渡さない（「- なし」を書くと coverage-audit が「AC1: なし」という項目として読む）。
export const auditState = (dir) => path.join(dir, 'audit', 'state')
// coverage-audit の段の位置のファイル。init が書くので、あれば台帳があるとみなす（init でなく reframe を返す）。
const auditPhaseFile = (state) => path.join(state, 'phase.json')
// coverage-audit が止まったときに書く status のファイル（中身は status の出力と同じ）。司令塔は status の出力を写さず、import-audit がこれを読む。
const auditStatusFile = (state, phase) => path.join(state, `status-${phase}.json`)
// phase.json が読めなければ undefined。読めれば段と、段の始まり（phase_start。plain object のときだけ正規化した文字列、それ以外は null）。
function auditPosOf(state) {
  let A
  try { A = JSON.parse(read(auditPhaseFile(state))) } catch { return undefined }
  if (A === null || typeof A !== 'object') return undefined
  const s = A.phase_start
  return { phase: A.phase, start: s !== null && typeof s === 'object' && !Array.isArray(s) ? C.canon(s) : null }
}
// 検査の段ごとの枠（目標のファイルの冒頭の文）と、coverage-audit に渡す観点（呼ぶ側が持つ領域の観点の中身）。観点の正本はここだけ。
// 観点は枠の文から作り、手続きは「何を列挙し、何と照らすか」で書く。coverage-audit は観点を一覧で全ての単位に渡し、計画役で観点を作らない。
const AUDIT_FRAMES = {
  baseline: {
    frame: '既存の対象を、次の固定した目標に照らして検査する。目標を果たすのに影響を受ける範囲、足りないもの、既存の欠陥を確かめる。',
    lens: { id: 'baseline-fit', name: '目標に照らした現状', procedure: '対象の主張と振る舞いを列挙し、固定した目標・受け入れ基準・制約と照らして、目標を果たすのに影響を受ける範囲、足りないもの、既存の欠陥を探す' },
  },
  review: {
    frame: '対象が、次の固定した目標・受け入れ基準・制約を満たすかを確かめる。',
    lens: { id: 'review-fit', name: '目標・基準・制約の充足', procedure: '対象の主張と振る舞いを列挙し、固定した目標・受け入れ基準・制約と照らして、満たしていないもの・食い違うものを探す' },
  },
  design: {
    frame: '設計（方式設計と単位ごとの詳細設計）が、次の固定した目標・受け入れ基準・制約を満たし、単位の分け方・依存・受け入れ・ケースが実装とテストに足りるかを確かめる。単位をまたぐ扱いは `_architecture.md` の境界の表にあり、設計の文書は行 id（`X<n>-<k>`）でそれを指す。前提の引用と照合の不変条件は script が照らし済みである。',
    lens: { id: 'design-fit', name: '設計の充足と実装への足り', procedure: '設計の決定（単位の分け方・依存・受け入れ・ケース）を列挙し、固定した目標・受け入れ基準・制約と照らして満たしていないものを探す。次に、各決定が実装とテストに足りるか（境界の表の行 id で単位をまたぐ扱いが決まっているか）を照らす' },
  },
  impl: {
    frame: '実装（各単位のファイルとテスト）が、次の固定した目標・受け入れ基準・制約と、単位ごとの受け入れ（基準の U<n>A<m>）を満たすかを確かめる。',
    lens: { id: 'impl-fit', name: '実装とテストの充足', procedure: '実装とテストの振る舞いを列挙し、固定した目標・受け入れ基準・制約と単位ごとの受け入れ（U<n>A<m>）と照らして、満たしていないもの・テストが確かめていないものを探す' },
  },
}
function prepAudit(L, dir, phase, keys) {
  const targets = phase === 'design' ? designFiles(L, dir) : phase === 'impl' ? ownedPaths(L).map((p) => abs(L, p)) : L.targets
  const frame = AUDIT_FRAMES[phase].frame
  const criteria = [...L.criteria, ...(phase === 'impl' ? unitList(L).flatMap((u) => u.acceptance) : [])]
  const files = {
    'goal.md': `${frame}\n\n${items(L.goal.items)}\n`, 'request.md': `${L.request}\n`,
    ...(criteria.length ? { 'criteria.md': `${items(criteria)}\n` } : {}), ...(L.constraints.length ? { 'constraints.md': `${items(L.constraints)}\n` } : {}),
    ...(L.decisions != null ? { 'decisions.md': `${L.decisions}\n` } : {}),
    'lenses.json': `${JSON.stringify([AUDIT_FRAMES[phase].lens])}\n`,
  }
  const inDir = path.join(dir, 'audit', 'in', phase)
  for (const f of existsSync(inDir) ? readdirSync(inDir) : []) if (!(f in files)) rmSync(path.join(inDir, f))
  for (const [f, t] of Object.entries(files)) writeAtomic(path.join(inDir, f), t)
  const state = auditState(dir)
  const inFile = (f) => path.join(inDir, f)
  const frameKey = sha(C.canon({ phase, targets: [...targets].sort(), files })).slice(0, 16)
  const exists = existsSync(auditPhaseFile(state))
  // 同じ段・同じ入力で返した argv を流した後（取り込みの前）なら、argv を返さずに続けさせる。init の枠（audit_start を持たない）は phase.json がその段にあれば流した後とみなし、
  // reframe の枠は phase.json の段の始まりが控え（audit_start）から変わったときだけ流した後とみなす。控えか今の値が分からなければ framed にしない。
  const F = L.audit_frame
  const same = !!F && F.phase === phase && F.key === frameKey
  const cur = exists ? auditPosOf(state) : undefined
  const framed = exists && same && !!cur && cur.phase === phase && cur.start !== null
    && (!Object.hasOwn(F, 'audit_start') || (typeof F.audit_start === 'string' && F.audit_start !== cur.start))
  if (!framed && !exists) L.audit_frame = { phase, key: frameKey }
  else if (!framed) {
    // 同じ枠の間は最初の控えを保つ（読めない phase.json や phase_start の無い phase.json で控えを置き換えない）。
    const keep = same && typeof F.audit_start === 'string' ? F.audit_start : null
    L.audit_frame = { phase, key: frameKey, audit_start: keep ?? (cur && cur.start !== null ? cur.start : null) }
  }
  L.pending = { step: 'audit', phase, key: keys[phase], audit_state: state }
  const audit = {
    state, goal: inFile('goal.md'), request: inFile('request.md'),
    ...Object.fromEntries(['criteria', 'constraints', 'decisions'].filter((k) => files[`${k}.md`]).map((k) => [k, inFile(`${k}.md`)])), targets,
  }
  // 設計レビューだけ、関係する資産を結ぶ id の型（境界の行・受け入れ・振る舞い）を --link で渡す。ほかの段では渡さない（reframe で link は null に戻る）。
  const frameArgv = [...['goal', 'request', 'criteria', 'constraints', 'decisions'].flatMap((k) => (audit[k] ? [`--${k}`, audit[k]] : [])), '--lenses', inFile('lenses.json'), ...targets.flatMap((f) => ['--target', f]), '--phase', phase, ...(phase === 'design' ? ['--link', C.LINK_PATTERN] : [])]
  if (framed) audit.framed = true
  else if (exists) audit.reframe_argv = ['reframe', '--state', state, ...frameArgv]
  else audit.init_argv = ['init', '--state', state, ...frameArgv, '--goal-checked', 'coverage-build']
  return {
    step: 'audit', phase, cycle: L.cycle, audit,
    then: framed
      ? `coverage-audit の台帳は既にこの段にある（argv は無い）。coverage-audit の next から止まるまで回し、import-audit --state ${dir} を流す（coverage-audit が止まったときに書く ${auditStatusFile(state, phase)} を CLI が読む）`
      : `coverage-audit の CLI に audit.${exists ? 'reframe_argv' : 'init_argv'} をそのまま渡し、coverage-audit を止まるまで回し、import-audit --state ${dir} を流す（coverage-audit が止まったときに書く ${auditStatusFile(state, phase)} を CLI が読む）`,
  }
}

function cmdInit(o) {
  const dir = path.resolve(need(o, 'state'))
  if (existsSync(ledgerPath(dir))) throw new Fail(`台帳が既にある: ${ledgerPath(dir)}（持ち越すときは next を流す）`)
  const mode = need(o, 'mode')
  if (!['create', 'update', 'review'].includes(mode)) throw new Fail(`--mode は create・update・review: ${mode}`)
  const repo = path.resolve(need(o, 'repo'))
  const inputs = (o.input || []).map((p) => path.resolve(p))
  const targets = (o.target || []).map((p) => path.resolve(p))
  if (mode !== 'create' && !targets.length) throw new Fail(`${mode} には既にある対象（--target）が要る`)
  if (mode === 'create' && targets.length) throw new Fail('create は対象を持たない（読む材料は --input で渡す）')
  const missing = [repo, ...inputs, ...targets].filter((p) => !existsSync(p))
  if (missing.length) throw new Fail('読めないファイルがある（台帳は作っていない）', { stop: 'blocked', cause: 'input', missing })
  const checks = (o.check || []).map((c, i) => {
    let argv
    try { argv = JSON.parse(c) } catch { throw new Fail(`--check は argv の JSON 配列: ${c}`) }
    if (!Array.isArray(argv) || !argv.length || argv.some((x) => typeof x !== 'string' || !x)) throw new Fail(`--check は空でない文字列の配列: ${c}`)
    return { id: `CHK${i + 1}`, argv }
  })
  if (mode === 'review' && checks.length) throw new Fail('review は check を流さない（実装しないので）')
  const roles = { ...JSON.parse(read(path.join(HERE, 'roles.json'))), ...(o.roles ? JSON.parse(read(o.roles)) : {}) }
  const text = {
    goal: read(need(o, 'goal')).trim(), request: read(need(o, 'request')).trim(), decisions: o.decisions ? read(o.decisions).trim() : null,
    criteria: o.criteria ? read(o.criteria) : '', constraints: o.constraints ? read(o.constraints) : '',
  }
  const g = readGoalFiles(text)
  if (g.problems.length) throw new Fail('目標・基準・制約に、引用の照合を通らない項目がある（台帳は作っていない。直して init をやり直す）', { problems: g.problems })
  const L = newLedger({
    mode, repo, goal: text.goal, goalItems: g.goal, request: text.request, decisions: text.decisions, criteria: g.criteria, constraints: g.constraints,
    inputs, targets, checks, config: posInts(o, LIMIT_KEYS), roles,
  })
  mkdirSync(dir, { recursive: true })
  save(dir, L)
  writeLauncher(dir)
  return { ok: true, state: dir, mode, hint: `ヒントは node ${path.join(HERE, 'build-cli.mjs')} hint --state ${dir} --text "..." で足せる（実行中も止まっている間も）` }
}

// ---------------- 呼び出し（next が開き、ingest が閉じる） ----------------
// args は {state, callId, stage, workers} だけにする（B4）。担当が読む文は args にも prompt にも載せず、役が claim と query で台帳から引く（B1）。
// 1 つの呼び出しの worker は全て同時に起動されるので、前の役の提出を読む役（詳細設計・実行役・検証役）は次の呼び出しに置く。1 つの呼び出しの役は 1 つの段に属す。
// 担当の種類から役の名前への対応は build-core.mjs の TASK_ROLE の 1 か所。役のモデルと effort の組は roles.json だけが持ち、next が workers の行に写す
// （Workflow source は行の値を使い、役の名前で分岐しない）。
const WRITE_STEPS = ['tests', 'implement']
const UNIT_TASKS = ['spec', 'tests', 'implement']
const INTENT_TASKS = ['exam', 'judge']
// 単位の担当が読むファイルの本文のバイト数（詰め合わせに使う）。単位の設計の写しと、段が読む単位のファイル（あるものだけ）。
// 入力・方式設計の写しのように全ての単位の担当が読むものは 1 体が 1 回読むので数えない。
function unitBytes(L, dir, u, task) {
  const own = task === 'spec' ? u.paths : task === 'tests' ? u.tests : [...u.paths, ...u.tests]
  return [designPath(dir, u.id), ...own.map((p) => abs(L, p))].reduce((n, f) => n + (existsSync(f) ? statSync(f).size : 0), 0)
}
// 今の段の残りの予算（起動数）。1 回の呼び出しの行の数をこれに収める（少なくとも 1）。
const budgetLeft = (L) => Math.max(1, L.config.max_agents_total - L.agents.length)
// 段の行（worker）と担当。担当は行に結び、worker は claim で自分の行の担当を取る。
// - 目標の照合・方式設計・振り返りの計画: 担当 1 つを 1 体。
// - 詳細設計・テスト・実装: 単位の並びで前から UNIT_MAX_BYTES まで 1 体に詰める（packUnits）。テストを書く役と実装する役は段が違うので別の体。
//   実装は依存がそろった単位だけを claim で渡す（1 体が前の単位を出した後に、次の単位を取り直す）。
// - 振り返りの実行と検証: 今の周の確かめる意図（検証は実行役が支持した意図）の全てを 1 体。
function stageCall(L, dir, d) {
  const role = TASK_ROLE[d.task]
  const row = (tag, i) => ({ id: `${tag}${i + 1}`, role })
  if (['goal', 'arch', 'plan'].includes(d.task)) {
    const r = row(d.task[0], 0)
    return { rows: [r], tasks: [{ id: d.task === 'plan' ? `plan:${L.cycle}:${L.retro.rounds + 1}` : d.task, kind: d.task, worker: r.id }] }
  }
  if (INTENT_TASKS.includes(d.task)) {
    const r = row(d.task === 'exam' ? 'x' : 'v', 0)
    return { rows: [r], tasks: (d.task === 'exam' ? queuedIntents(L) : examinedIntents(L)).map((it) => ({ id: `${d.task}:${it.id}`, kind: d.task, intent: it.id, worker: r.id })) }
  }
  const units = d.task === 'spec' ? unitList(L).filter((u) => u.need_design) : d.task === 'tests' ? testsTodo(L) : implPending(L)
  // 実装は、呼び出しを開いた時に依存がそろった単位を 1 つも持たない詰め合わせを起動しない（最初の claim が done になる体を起こさない）。その単位は次の呼び出しで渡る。
  const packs = packUnits(units.map((u) => u.id), (id) => unitBytes(L, dir, L.units[id], d.task))
    .filter((ids) => d.task !== 'implement' || ids.some((id) => depsDone(L, L.units[id])))
    .slice(0, Math.min(C.LIMITS.maxAgents, budgetLeft(L)))
  const rows = packs.map((_, i) => row({ spec: 'd', tests: 't', implement: 'i' }[d.task], i))
  const tasks = packs.flatMap((ids, i) => ids.map((id) => ({ id: `${d.task}:${id}`, kind: d.task, unit: id, worker: rows[i].id, ...(WRITE_STEPS.includes(d.task) ? { paths: d.task === 'tests' ? L.units[id].tests : L.units[id].paths } : {}) })))
  return { rows, tasks }
}
const callOut = (P) => ({ step: P.step, call_id: P.call_id, workflow: WORKFLOW, args_path: P.args_path, estimate_agents: P.workers.length, limits: C.LIMITS, cycle: P.cycle })

function cmdNext(o) {
  const dir = path.resolve(need(o, 'state'))
  return withLock(dir, () => next(dir))
}
function next(dir) {
  const L = load(dir)
  writeLauncher(dir)
  // 開いた呼び出しがある間は、同じ呼び出し（同じ callId と args）を返す（冪等。B6）。閉じるのは ingest --call だけにし、
  // 司令塔が next を流し直しても、Workflow の実行中の claim・submit を壊さない。
  if (L.pending && L.pending.call_id) return callOut(L.pending)
  // blocked（failure）の後の next は、原因を直した再開として扱い、連続の数と、進みの無かった呼び出しで増えた試行を戻す。
  if (L.stopped && L.stopped.stop === 'blocked' && L.stopped.cause === 'failure') {
    L.fail_streak = 0
    for (const [k, n] of Object.entries(L.env_attempts || {})) if (k in L.attempts) { L.attempts[k] -= n; if (L.attempts[k] <= 0) delete L.attempts[k] }
    L.env_attempts = {}
    // 意図の担当も、進みの無かった呼び出しで数えた試行を戻し、それで上限を下回る意図は判定できずに閉じた状態から待ちに戻す。
    for (const it of L.intents) {
      if (!it.env_tries) continue
      it.tries = Math.max(0, (it.tries || 0) - it.env_tries)
      it.env_tries = 0
      if (it.status === 'undecided' && it.tries < MAX_ATTEMPTS && it.undecided_from) Object.assign(it, { status: it.undecided_from, why: '', undecided_from: null })
    }
  }
  for (;;) {
    writeDesign(L, dir)
    const keys = keysOf(L, dir)
    const missing = [...L.inputs, ...L.targets].filter((p) => !existsSync(p))
    settleRetro(L)
    const d = decide(L, { keys, missing })
    if (d.stop) {
      L.stopped = { ...d, cycle: L.cycle }
      L.pending = null
      save(dir, L)
      return { ...d, cycle: L.cycle, routes: L.mode === 'review' ? L.routes : undefined, next_args: d.stop === 'complete' ? null : { state: dir } }
    }
    if (d.step === 'route') { route(L); continue } // 静的な段: agent を起動しない
    L.stopped = null
    if (d.step === 'audit') { const out = prepAudit(L, dir, d.phase, keys); save(dir, L); return out }
    if (d.step === 'checks') {
      L.pending = { step: 'checks', key: keys.impl }
      save(dir, L)
      return { step: 'checks', cycle: L.cycle, checks: L.checks, then: `run-checks --state ${dir} を background で流し、終わるまで待つ` }
    }
    const unread = hints(dir).filter((h) => !L.hints_read.includes(h.id))
    const { rows, tasks } = stageCall(L, dir, d)
    L.call_seq += 1
    const callId = sha(`${dir}|${L.call_seq}|${d.step}|${L.cycle}|${L.rev}`).slice(0, 12)
    const workers = rows.map((r) => ({ id: r.id, role: r.role, model: L.roles[r.role].model, effort: L.roles[r.role].effort }))
    const args = { state: dir, callId, stage: d.step, workers }
    const argsPath = path.join(dir, `call-${callId}.json`)
    writeAtomic(argsPath, JSON.stringify(args))
    // before: 呼び出しを開いた時の、単位のファイル・入力・対象の hash（絶対 path）。書く段は受け持ちの外の変更を、書かない段は全ての変更を照らす。
    // opened_at: 開いた時刻。開いた時に単位に結ばれていなかったファイル（方式設計が後から持たせるもの）は、mtime がこれ以後なら呼び出しの中で書かれたとみなす。
    L.pending = {
      call_id: callId, step: d.step, task: d.task, args_path: argsPath, workers, tasks: tasks.map((t) => ({ ...t, claimed: false, done: false, accepted: false })),
      hints: unread.map((h) => h.id), cycle: L.cycle, events_at: L.events.length, claims: {}, submits: 0, accepted: 0, before: hashesNow(L), opened_at: Date.now(),
    }
    save(dir, L)
    return callOut(L.pending)
  }
}
// 単位のファイル・入力・対象の今の hash（絶対 path → hash か null）。
const watched = (L) => [...new Set([...ownedPaths(L).map((p) => abs(L, p)), ...L.inputs, ...L.targets])]
const hashesNow = (L) => Object.fromEntries(watched(L).map((f) => [f, fileHash(f)]))
// 呼び出しを開いた時に照らしていたファイル（before の key）のうち、その後に変わったもので、書いてよい集合（呼び出しの書く担当の paths の全て）の外のもの
// （repo の中は相対 path で示す）。呼び出しの中で方式設計が新しく持たせたファイルは、開いた時の中身を知らないので照らさない。
function outsideChanges(L, P) {
  const allowed = new Set((P.tasks || []).flatMap((t) => (t.paths || []).map((p) => abs(L, p))))
  const changed = Object.keys(P.before).filter((f) => P.before[f] !== fileHash(f) && !allowed.has(f))
  return changed.map((f) => (f.startsWith(L.repo + path.sep) ? path.relative(L.repo, f) : f))
}

// 呼び出しを開いた時に照らしていなかったファイルで、開いた後に書かれた（mtime が opened_at 以後の）もの。repo の作業ツリーを丸ごと控えないための近似で、
// 開く直前（同じミリ秒）に書かれたファイルや、mtime を保つ書き方は見分けられない。
function freshFile(L, P, rel) {
  const f = abs(L, rel)
  if (Object.hasOwn(P.before, f) || !existsSync(f)) return false
  return statSync(f).mtimeMs >= P.opened_at
}

// native Workflow の tasks の .output（返り値を result に包んだ形）も、そのまま受け付ける。
export function unwrap(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return v
  return Object.hasOwn(v, 'result') && typeof v.summary === 'string' && typeof v.agentCount === 'number' ? v.result : v
}

function recordCall(L, P, res, failed) {
  const ag = Array.isArray(res.agents) ? res.agents : []
  for (const a of ag) L.agents.push({ call_id: P.call_id, cycle: L.cycle, stage: P.step, role: a.role, label: a.label, model: a.model, effort: a.effort, ok: !!a.ok })
  const tokens = typeof res.tokens === 'number' && Number.isFinite(res.tokens) ? res.tokens : null
  L.calls.push({ call_id: P.call_id, cycle: L.cycle, step: P.step, agents: ag.length, failed: ag.filter((a) => !a.ok).length, submits: P.submits, tokens, tokens_note: tokens == null ? '消費量を run の中で読めない経路（runner など）' : 'この呼び出しの budget.spent() の差' })
  L.fail_streak = failed ? L.fail_streak + 1 : 0
  for (const a of ag) if (!a.ok) addEvent(L, { stage: P.step, kind: 'agent_missing', text: `${a.label}（${a.model}/${a.effort}）が返らなかったか、不正な出力だった` })
}

// 担当の試行を 1 つ数える。単位と段の担当は L.attempts（上限で stuck → needs_input）、意図ごとの担当は意図の tries（上限で意図を閉じる）。
// env は進みの無かった呼び出し（blocked（failure）から再開したときに戻す）。上限に達したら true。
function bumpTask(L, t, reason, env = false) {
  const k = attemptKey(t)
  if (k) {
    L.attempts[k] = (L.attempts[k] || 0) + 1
    if (env) L.env_attempts[k] = (L.env_attempts[k] || 0) + 1
    return L.attempts[k] >= MAX_ATTEMPTS
  }
  const it = L.intents.find((x) => x.id === t.intent)
  if (!it) return true
  it.tries = (it.tries || 0) + 1
  if (env) it.env_tries = (it.env_tries || 0) + 1
  if (it.tries < MAX_ATTEMPTS) return false
  dropIntent(L, t, `試行 ${it.tries} 回で受理できなかった（${reason}）`)
  return true
}
// 開いた呼び出しを閉じる。出し終えていない担当のうち、手を付けた（query か submit のあった）担当だけを試行に数える。
// claim は自分の行の担当を一度に返すので、時間の上限などで手を付けずに終わった担当は数えない（次の呼び出しで渡る）。
// 誰も手を付けずに返る呼び出しが続けば、提出の無い呼び出しとして fail_streak が blocked（failure）で止める。
// 書く段も書かない段も、受け持ちの外のファイルの変更を照らし、あれば出来事にする。書く段はその呼び出しで受理した単位を受け付けない。
// 書かない段で単位の持つファイルが変わったら、その単位のテストと実装を無効にし、書く段の担当が中身を書き直すまで受理しない（tainted）。
function closeCall(L, P, env) {
  for (const t of P.tasks) {
    if (t.done || !t.touched) continue
    bumpTask(L, t, '提出されなかった', env)
  }
  // 同じ呼び出しの後の担当が、共有の fixture として受理済みの単位のテストのファイルを直すことがある。実装の照合は呼び出しの終わりの中身で取り直す。
  for (const t of P.tasks.filter((x) => x.accepted && x.kind === 'tests' && L.units[x.unit])) {
    const u = L.units[t.unit]
    if (u.tests_for === u.design_hash) u.tests_hash = Object.fromEntries(u.tests.map((f) => [f, fileHash(abs(L, f))]))
  }
  const outside = outsideChanges(L, P)
  if (outside.length) {
    addEvent(L, { stage: P.step, kind: 'write_outside', text: `受け持ちの外のファイルが変わった: ${outside.join(', ')}（${WRITE_STEPS.includes(P.step) ? 'この呼び出しで受理した単位を受け付けない' : 'そのファイルを持つ単位のテストと実装を書く段で書き直す'}）` })
    for (const t of P.tasks.filter((x) => x.accepted && WRITE_STEPS.includes(x.kind) && L.units[x.unit])) {
      const u = L.units[t.unit]
      if (t.kind === 'tests') Object.assign(u, { tests_for: null, tests_hash: {} })
      else Object.assign(u, { impl_for: null, impl_hash: {} })
      bumpTask(L, t, '受け持ちの外のファイルが変わった呼び出し', env)
    }
    if (!WRITE_STEPS.includes(P.step)) {
      for (const rel of outside) {
        const o = ownerOf(L, rel)
        if (!o.unit) continue
        const u = L.units[o.unit]
        Object.assign(u, { tests_for: null, tests_hash: {}, impl_for: null, impl_hash: {}, tainted: [...new Set([...(u.tainted || []), rel])] })
      }
    }
  }
  L.env_attempts = L.env_attempts || {}
  for (const k of Object.keys(L.env_attempts)) if (!(k in L.attempts)) delete L.env_attempts[k]
  L.pending = null
}

// ingest: --call の呼び出しを閉じるだけ（B3）。返り値から読むのは起動の記録（agents）と tokens だけで、役の出力は受け取らない（全て submit で台帳に入っている）。
// 提出が 1 件も無い呼び出しは進みが無かったとして環境の失敗に数える（全ての役が欠けた、または担当を取らずに返った）。続けば blocked（failure）で止まる。
function cmdIngest(o) {
  const dir = path.resolve(need(o, 'state'))
  return withLock(dir, () => {
    const L = load(dir)
    const call = need(o, 'call')
    const P = L.pending
    if (!P || !P.call_id) throw new Fail(`受け取る Workflow の呼び出しが無い（next を先に流す。受け取ったのは ${call}）`)
    if (P.call_id !== call) throw new Fail(`閉じる呼び出しが違うか、既に閉じている: 開いているのは ${P.step}/${P.call_id}、受け取ったのは ${call}`)
    const res = unwrap(JSON.parse(read(need(o, 'result'))))
    const r = res && typeof res === 'object' && !Array.isArray(res) ? res : {}
    const failed = !P.submits
    recordCall(L, P, r, failed)
    L.hints_read.push(...P.hints)
    closeCall(L, P, failed)
    save(dir, L)
    // 受け付けなかった提出（rejected_output・write_outside）の理由。ok は「呼び出しを閉じた」ことを指す。
    const rejected = L.events.slice(P.events_at).filter((e) => e.kind === 'rejected_output' || e.kind === 'write_outside').map((e) => e.text)
    return { ok: true, cycle: L.cycle, ...(rejected.length ? { rejected } : {}), next: 'next を流す' }
  })
}

// ---------------- 担当（worker が Bash で流す claim・query・submit） ----------------
// どれも、今開いている呼び出し（pending）の --call と、その args の workers の行の --worker からだけ受け付ける。外れたら台帳を変えずに拒否する（終了状態 2）。
function pendingWorker(L, o) {
  const call = need(o, 'call')
  const worker = need(o, 'worker')
  if (!L.pending || !L.pending.call_id) throw new Fail(`開いた呼び出しが無い（呼び出し ${call} は閉じた。worker を終える）`)
  if (call !== L.pending.call_id) throw new Fail(`呼び出しが違う: 今は ${L.pending.call_id}、受け取ったのは ${call}（前の呼び出しは閉じた。worker を終える）`)
  const w = L.pending.workers.find((x) => x.id === worker)
  if (!w) throw new Fail(`この呼び出しの workers に無い worker: ${worker}`)
  return w
}
const sq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`
const CLI_PATH = fileURLToPath(import.meta.url)
const resultPath = (dir, call, worker, taskId) => path.join(dir, 'results', call, worker, `${sha(taskId).slice(0, 16)}.json`)
const submitCmd = (dir, call, w) => [process.execPath, CLI_PATH, 'submit', '--state', dir, '--call', call, '--worker', w.id].map(sq).join(' ')
// worker が今取れる担当: 自分の行の、出し終えていない担当（実装は依存がそろった単位だけ）。
const claimable = (L, P, w) => P.tasks.filter((t) => t.worker === w.id && !t.done && (t.kind !== 'implement' || (L.units[t.unit] && depsDone(L, L.units[t.unit]))))
const publicTask = (dir, P, t) => ({ id: t.id, kind: t.kind, result_path: resultPath(dir, P.call_id, t.worker, t.id), ...(t.unit ? { unit: t.unit } : {}), ...(t.intent ? { intent: t.intent } : {}) })

// claim: 自分の行の、出し終えていない担当を全て返す（照合に落ちて出し直す担当も、同じ id で返す）。取る物が無ければ done。返す前に結果の path の古いファイルを消す。
function cmdClaim(o) {
  const dir = path.resolve(need(o, 'state'))
  return withLock(dir, () => {
    const L = load(dir)
    const w = pendingWorker(L, o)
    const P = L.pending
    P.claims[w.id] = (P.claims[w.id] || 0) + 1
    const ts = claimable(L, P, w)
    for (const t of ts) t.claimed = true
    save(dir, L)
    if (!ts.length) return { ok: true, done: true }
    const tasks = ts.map((t) => publicTask(dir, P, t))
    for (const t of tasks) { mkdirSync(path.dirname(t.result_path), { recursive: true }); rmSync(t.result_path, { force: true }) }
    return { ok: true, tasks, submit_cmd: submitCmd(dir, P.call_id, w) }
  })
}

const unitDef = (u) => ({ id: u.id, kind: u.kind, title: u.title, responsibility: u.responsibility, paths: u.paths, tests: u.tests, test_uses: u.test_uses, depends_on: u.depends_on, covers: u.covers })
const intentDef = (it) => ({ id: it.id, basis: it.basis, hypothesis: it.hypothesis, layer: it.layer, look_at: it.look_at })
const itemOf = (c) => ({ id: c.id, text: c.text })
// 現状の検査（coverage-audit）の結果の要約。全件は input_paths の baseline-status.json。
const baselineOf = (L) => (L.baseline ? { findings: L.baseline.findings.map((f) => ({ layer: f.layer, claim: f.claim, path: f.path, quote: f.quote })), not_seen: L.baseline.not_seen, unverifiable: L.baseline.unverifiable.map((f) => ({ id: f.id, claim: f.claim })), references: (L.baseline.references || []).map((r) => ({ claim: r.claim, path: r.path, quote: r.quote })) } : null)
// 振り返りの読めるファイル（look_at と evidence はこの中から。submit も evidence をこの一覧で照らす）。stateDir の台帳・args・役の結果のファイルは入れない
// （実行役が自分の結果のファイルを引いて引用の照合を通すのを防ぐ）。
const readableOf = (L, dir) => [...designFiles(L, dir), ...ownedPaths(L).map((p) => abs(L, p)), ...L.inputs, ...L.targets, ...listFiles(path.join(dir, 'audit')), ...listFiles(path.join(dir, 'checks'))]
// 担当の入力（query の inputs）。前の役の出力（方式設計 → 詳細設計、計画役 → 実行役 → 検証役）は台帳からここに出る（B1）。
function inputsOf(L, dir, P, t) {
  const hs = hints(dir).filter((h) => P.hints.includes(h.id))
  const base = { mode: L.mode, repo: L.repo, goal: L.goal.text, items: L.goal.items.map(itemOf), criteria: L.criteria.map(itemOf), constraints: L.constraints.map(itemOf), writing: path.join(SKILL_DIR, 'references', 'writing.md'), hints: hs }
  const said = { request: L.request, decisions: L.decisions }
  if (t.kind === 'goal') return { ...base, ...said, item_ids: goalIds(L) }
  if (t.kind === 'arch') return { ...base, ...said, input_paths: archInputs(L, dir), cover_ids: coverIds(L), baseline: baselineOf(L), previous: L.arch ? archPath(dir) : null, causes: L.arch ? L.arch_causes || [] : [] }
  if (UNIT_TASKS.includes(t.kind)) {
    const u = L.units[t.unit]
    if (!u) throw new Fail(`単位が方式設計から消えた: ${t.unit}（next からやり直す）`)
    if (t.kind === 'spec') return { ...base, ...said, unit: unitDef(u), rows: rowIdsOf(L, u.id), architecture: archPath(dir), input_paths: archInputs(L, dir), premise_paths: premisePaths(L), baseline: baselineOf(L), previous: u.design_hash ? designPath(dir, u.id) : null, causes: u.causes }
    return {
      ...base, unit: unitDef(u), paths: t.paths, repo: L.repo, design: designPath(dir, u.id), architecture: archPath(dir), tests: t.kind === 'implement' ? u.tests : [],
      depends: u.depends_on.map((x) => L.units[x]).filter(Boolean).map((x) => ({ id: x.id, design: designPath(dir, x.id), paths: x.paths })), causes: u.causes,
    }
  }
  if (t.kind === 'plan') {
    return {
      ...base,
      events: dueEvents(L).map((e) => ({ id: e.id, stage: e.stage, kind: e.kind, layer: e.layer, unit: e.unit, test: e.test, groups: e.groups || [], text: e.text })),
      groups: dueGroups(L).map((g) => ({ id: g, layer: (L.audit_groups[g] || {}).layer || null, root_cause: (L.audit_groups[g] || {}).root_cause || null })),
      facts: L.facts.map((f) => ({ id: f.id, layer: f.layer, cause: f.cause, basis: f.basis })),
      tried: L.intents.filter((i) => i.cycle === L.cycle).map((i) => ({ ...intentDef(i), status: i.status, why: i.why })), readable: readableOf(L, dir),
    }
  }
  const it = L.intents.find((x) => x.id === t.intent)
  if (!it) throw new Fail(`意図が台帳に無い: ${t.intent}`)
  return t.kind === 'exam' ? { ...base, intent: intentDef(it) } : { ...base, intent: intentDef(it), exam: it.exam }
}
// query: 担当が読む入力を台帳から引く（B1）。自分の行の担当だけ。
function cmdQuery(o) {
  const dir = path.resolve(need(o, 'state'))
  return withLock(dir, () => {
    const L = load(dir)
    const w = pendingWorker(L, o)
    const P = L.pending
    const tid = need(o, 'task')
    const t = P.tasks.find((x) => x.id === tid && x.worker === w.id)
    if (!t) throw new Fail(`この worker の担当に無い: ${tid}`)
    const inputs = inputsOf(L, dir, P, t)
    if (!t.touched) { t.touched = true; save(dir, L) }
    return { ok: true, task: t.id, kind: t.kind, inputs }
  })
}

// submit: その worker の、取って出し終えていない担当のうち、結果の path にファイルがある担当を照らす（無い担当は missing）。
// 照合に落ちた提出は理由を返して試行に数え（ok: false）、取ったままにして同じ体が出し直せるようにする。上限に達したら諦める（dropped: true）。
function cmdSubmit(o) {
  const dir = path.resolve(need(o, 'state'))
  return withLock(dir, () => {
    const L = load(dir)
    const w = pendingWorker(L, o)
    const P = L.pending
    const results = []
    const missing = []
    for (const t of P.tasks.filter((x) => x.worker === w.id && x.claimed && !x.done)) {
      const f = resultPath(dir, P.call_id, w.id, t.id)
      if (!existsSync(f)) { missing.push(t.id); continue }
      t.touched = true
      let rep = null
      try { rep = JSON.parse(read(f)) } catch { rep = null }
      const write = WRITE_STEPS.includes(t.kind)
      const outside = write ? outsideChanges(L, P) : []
      if (outside.length) addEvent(L, { stage: P.step, kind: 'write_outside', unit: t.unit || null, text: `受け持ちの外のファイルが変わった: ${outside.join(', ')}（${t.unit} を受け付けない）` })
      const after = write ? Object.fromEntries(ownedPaths(L).map((p) => [p, fileHash(abs(L, p))])) : {}
      const problems = submitTask(L, t, rep, { inputs: archInputs(L, dir), readText: reader(L, dir), readable: premisePaths(L), looks: readableOf(L, dir), after, outside, fresh: (rel) => freshFile(L, P, rel), before: Object.fromEntries(Object.entries(P.before).filter(([f]) => f.startsWith(L.repo + path.sep)).map(([f, h]) => [path.relative(L.repo, f), h])) })
      let dropped = false
      if (problems.length) {
        rmSync(f, { force: true })
        if (attemptKey(t)) addEvent(L, { stage: P.step, kind: 'rejected_output', unit: t.unit || null, text: `${taskTitle(t)}: ${problems.join(' / ')}` })
        dropped = bumpTask(L, t, problems.join(' / '))
        if (dropped) t.done = true
      } else {
        Object.assign(t, { done: true, accepted: true })
        const k = attemptKey(t)
        if (k) { delete L.attempts[k]; delete L.env_attempts[k] }
      }
      results.push({ task: t.id, ok: !problems.length, problems, dropped })
    }
    if (results.length) { P.submits += results.length; P.accepted += results.filter((x) => x.ok).length; save(dir, L) }
    return { ok: true, results, missing }
  })
}

function cmdImportAudit(o) {
  const dir = path.resolve(need(o, 'state'))
  const L = load(dir)
  const p = L.pending
  if (!p || p.step !== 'audit') throw new Fail('取り込む coverage-audit が無い（next が audit を返した後に流す）')
  const file = auditStatusFile(p.audit_state, p.phase)
  if (!existsSync(file)) throw new Fail(`coverage-audit の status のファイルが無い: ${file}（coverage-audit を止まるまで回してから流す）`, { phase: p.phase, status_path: file })
  let status
  try { status = unwrap(JSON.parse(read(file))) } catch (e) { throw new Fail(`coverage-audit の status のファイルを読めない: ${file}（${e.message}）`, { phase: p.phase, status_path: file }) }
  // coverage-audit の status は段ごとに分かれる。上の階層は今の段の節なので、待っている段と同じ段の status だけを受ける。
  if (!status || status.phase !== p.phase) throw new Fail(`待っている段と違う段の status（待っているのは ${p.phase}、受け取ったのは ${status && status.phase}）。coverage-audit の台帳をこの段にしてから（next の audit の argv）流し直す`, { phase: p.phase })
  writeDesign(L, dir)
  const now = keysOf(L, dir)[p.phase]
  if (now !== p.key) throw new Fail('検査に渡した後に対象が変わった（next からやり直す）', { phase: p.phase })
  const designD = designDir(dir)
  const unitOfPath = (f) => {
    if (path.dirname(f) === designD) { const m = /^(U\d+)\.md$/.exec(path.basename(f)); return { unit: m ? m[1] : null, test: false } }
    return ownerOf(L, path.relative(L.repo, f))
  }
  let base
  try { base = importAudit(L, status, p.phase, { readText: reader(L, dir), unitOfPath }) } catch (e) { throw new Fail(e.message) }
  writeAtomic(path.join(dir, 'audit', `${p.phase}-status.json`), JSON.stringify(status, null, 1))
  L.audit_frame = null
  // metrics は coverage-audit の run の指標（指摘の出どころの内訳・持ち越した読みの数・全体の段で落とした数と確認で復活した数）。
  L.audits[p.phase] = { imported: p.key, state: p.audit_state, cycle: L.cycle, not_seen: base.not_seen, findings: (status.findings && status.findings.confirmed || []).length, references: base.references, metrics: status.metrics || null }
  if (p.phase !== 'baseline') L.retro.due = true
  L.pending = null
  save(dir, L)
  return { ok: true, phase: p.phase, imported_findings: L.audits[p.phase].findings, not_seen: base.not_seen.length, next: 'next を流す' }
}

function cmdRunChecks(o) {
  const dir = path.resolve(need(o, 'state'))
  const L = load(dir)
  if (!L.pending || L.pending.step !== 'checks') throw new Fail('流す check が無い（next が checks を返した後に流す）')
  if (keysOf(L, dir).impl !== L.pending.key) throw new Fail('next の後に実装のファイルが変わった（next からやり直す）')
  const results = []
  for (const c of L.checks) {
    const r = spawnSync(c.argv[0], c.argv.slice(1), { cwd: L.repo, encoding: 'utf8', timeout: CHECK_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 })
    const out = `${r.stdout || ''}${r.stderr || ''}${r.error ? `\n${r.error.message}` : ''}`
    const log = path.join(dir, 'checks', `${c.id}.log`)
    writeAtomic(log, out)
    const code = r.status ?? -1
    results.push({ id: c.id, argv: c.argv, code, log })
    if (code !== 0) addEvent(L, { stage: 'checks', kind: 'check_failed', text: `${c.id} ${JSON.stringify(c.argv)} が exit ${code} で失敗した（出力: ${log}。末尾: ${out.slice(-600).replace(/\s+/g, ' ')}）` })
  }
  if (keysOf(L, dir).impl !== L.pending.key) throw new Fail('check の実行中に実装のファイルが変わった（記録しない。next からやり直す）')
  L.checks_run = { key: L.pending.key, cycle: L.cycle, results }
  if (results.some((r) => r.code !== 0)) L.retro.due = true
  L.pending = null
  save(dir, L)
  return { ok: true, passed: results.every((r) => r.code === 0), results }
}

function cmdStatus(o) {
  const dir = path.resolve(need(o, 'state'))
  const L = load(dir)
  const roles = {}
  for (const a of L.agents) { const k = `${a.role}|${a.model}|${a.effort}`; roles[k] = roles[k] || { launched: 0, failed: 0 }; roles[k].launched++; if (!a.ok) roles[k].failed++ }
  return {
    mode: L.mode, cycle: L.cycle, stopped: L.stopped, pending: L.pending, goal_checked: L.goal.checked,
    units: unitList(L).map((u) => ({ id: u.id, kind: u.kind, title: u.title, designed: !!u.design_hash && !u.need_design, tests: u.kind === 'code' ? u.tests_for === u.design_hash : null, implemented: u.impl_for === u.design_hash, rounds: u.rounds })),
    audits: Object.fromEntries(PHASES.filter((p) => L.audits[p]).map((p) => [p, { cycle: L.audits[p].cycle, findings: L.audits[p].findings, not_seen: L.audits[p].not_seen, references: L.audits[p].references || [], metrics: L.audits[p].metrics || null }])),
    checks: L.checks_run, routes: L.routes, facts: L.facts.map((f) => ({ id: f.id, layer: f.layer, cause: f.cause, basis: f.basis })),
    human: L.human.map((h) => ({ ...h, answered: L.answers.some((a) => a.id === h.id) })), notes: L.notes,
    events_not_in_retro: dueEvents(L).map((e) => ({ id: e.id, stage: e.stage, kind: e.kind })), agents_by_role: roles, calls: L.calls,
  }
}

function cmdHint(o) {
  const dir = path.resolve(need(o, 'state'))
  const L = load(dir)
  if (L.stopped && L.stopped.stop === 'complete') throw new Fail('完了した台帳にはヒントを足せない（読まれない）')
  const id = `H${hints(dir).length + 1}`
  appendFileSync(path.join(dir, 'hints.jsonl'), `${JSON.stringify({ id, text: need(o, 'text') })}\n`)
  return { ok: true, id }
}

// answer: 目標・受け入れ基準・制約・決定の記録はファイルの中身を置き換え、引用を照らし直してから目標の照合をやり直す。
// それ以外の id への回答は、利用者の言葉として決定の記録に足し、その行を引用する制約にして方式設計からやり直す。dismiss は記録だけ。
const GOAL_FILES = { goal: 'goal', criteria: 'criteria', constraints: 'constraints', decisions: 'decisions' }
const itemsText = (xs) => xs.map((c) => `- ${c.id}: ${c.text}${c.cites.map((q) => ` 〔${q.source}: ${q.quote}〕`).join('')}`).join('\n')
// 回答から作る制約の id: 目標・基準・制約の id に無い最小の A<n>（利用者が書いた A<n> や、coverage-build から渡った A<n> と重ねない）。
const freeAnswerId = (ids) => { let n = 1; while (ids.includes(`A${n}`)) n++; return `A${n}` }
function cmdAnswer(o, dismiss = false) {
  const dir = path.resolve(need(o, 'state'))
  const L = load(dir)
  const id = need(o, 'id')
  if (id in GOAL_FILES) {
    if (dismiss) throw new Fail(`${id} は dismiss できない`)
    const body = o.file ? read(o.file) : need(o, 'text')
    const text = { goal: L.goal.text, request: L.request, decisions: L.decisions, criteria: itemsText(L.criteria), constraints: itemsText(L.constraints), [id]: id === 'goal' || id === 'decisions' ? body.trim() : body }
    const g = readGoalFiles(text)
    if (g.problems.length) throw new Fail(`直した ${id} が引用の照合を通らない（台帳は変えていない）`, { problems: g.problems })
    Object.assign(L, { goal: { text: text.goal, items: g.goal, checked: false, problems: [] }, decisions: text.decisions, criteria: g.criteria, constraints: g.constraints, need_arch: L.mode !== 'review' })
    delete L.attempts.goal
    for (const p of ['design', 'impl', 'review']) delete L.audits[p] // 照らす目標・基準が変わったので、中身が同じでもレビューをやり直す
    save(dir, L)
    return { ok: true, next: '目標の照合からやり直す。next を流す' }
  }
  const text = need(o, 'text')
  const isQ = (L.arch && L.arch.questions || []).some((q) => q.id === id)
  const known = isQ || L.human.some((h) => h.id === id) || id.startsWith('attempts:')
  if (!known) throw new Fail(`台帳に無い id: ${id}`)
  if (id.startsWith('cycles#')) { // 周の上限: answer は保留したやり直しを当てて上限を 1 増やし、dismiss は当てずに捨てる
    const p = L.pending_redo
    if (!p || p.id !== id) throw new Fail(`${id} に保留したやり直しが無い（答え済みか捨て済み。台帳は変えていない）`)
    L.answers.push({ id, text, dismiss })
    L.pending_redo = null
    if (dismiss) L.notes.push(`${id} を dismiss し、保留したやり直しを捨てた: ${redoSummary(p)}`)
    else applyRedo(L, p)
    save(dir, L)
    return { ok: true }
  }
  if (id.startsWith('attempts:')) delete L.attempts[id.slice('attempts:'.length)]
  const rounds = id.startsWith('rounds:') ? id.slice('rounds:'.length).split('#')[0] : null // rounds:<単位か arch>#<周>
  if (rounds === 'arch') L.arch_rounds = 0
  else if (rounds && L.units[rounds]) L.units[rounds].rounds = 0
  L.answers.push({ id, text, dismiss })
  if (!dismiss && !id.startsWith('attempts:') && !id.startsWith('rounds:')) {
    const said = `${id} への利用者の回答: ${text.replace(/\s*\n\s*/g, ' ')}`
    L.decisions = `${L.decisions != null ? `${L.decisions}\n` : ''}- ${said}`
    L.constraints.push({ id: freeAnswerId(goalIds(L)), text: said, cites: [{ source: 'decisions', quote: said }] })
    if (L.mode !== 'review') L.need_arch = true
  }
  save(dir, L)
  return { ok: true }
}

function cmdConfig(o) {
  const dir = path.resolve(need(o, 'state'))
  const config = posInts(o, LIMIT_KEYS)
  const L = load(dir)
  Object.assign(L.config, config)
  save(dir, L)
  return { ok: true, config: L.config }
}

export function main(argv) {
  try {
    const o = parse(argv)
    const cmd = o._[0]
    const f = { init: cmdInit, next: cmdNext, ingest: cmdIngest, 'import-audit': cmdImportAudit, 'run-checks': cmdRunChecks, status: cmdStatus, hint: cmdHint, answer: (x) => cmdAnswer(x), dismiss: (x) => cmdAnswer(x, true), config: cmdConfig, claim: cmdClaim, query: cmdQuery, submit: cmdSubmit }[cmd]
    if (!f) throw new Fail(`使い方: build-cli.mjs <${Object.keys(KNOWN).join('|')}> --state DIR ...（未知のコマンド: ${cmd}）`)
    return { code: 0, output: f(o) }
  } catch (e) {
    if (e instanceof Fail) return { code: 2, output: { ok: false, error: e.message, ...e.extra } }
    return { code: 1, output: { ok: false, error: String((e && e.stack) || e) } }
  }
}

// 入口（この CLI を直接流すときと、stateDir の入口 build-cli.mjs から流すとき）。
export function runMain(argv) {
  const r = main(argv)
  process.stdout.write(`${JSON.stringify(r.output, null, 1)}\n`)
  process.exitCode = r.code
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runMain(process.argv.slice(2))
