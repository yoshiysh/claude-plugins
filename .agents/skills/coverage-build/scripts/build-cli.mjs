#!/usr/bin/env node
// 台帳を書く唯一の口。init → next →（Workflow が波を順に流し、役が claim・query・submit で台帳と読み書きする / run-checks）→ ingest --call を繰り返し、
// next が止まる条件を返したら終わる（設計 docs/design/coverage-ledger-method.md「台帳と見たの記録」の B1〜B6）。
// 検査（現状の検査・設計レビュー・実装レビュー・review）は、同じ plugin の coverage-audit の CLI（ledger-cli.mjs）の関数を同じ process で流す。
// 検査の役の claim・query・submit の口もこの CLI で、この CLI が coverage-audit の台帳（stateDir/audit/state）に渡す。
import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, readdirSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  AUDIT_PHASES, C, MAX_ATTEMPTS, PHASES, TASK_ROLE, addEvent, attemptKey, decide, depsDone, dropIntent, dueEvents, dueGroups, examinedIntents, goalIds, implPending, importAudit, newLedger,
  applyRedo, ownedPaths, ownerOf, queuedIntents, readGoalFiles, redoSummary, renderDesign, route, rowIdsOf, settleRetro, sha, skippedAudits, submitTask, taskTitle, testsTodo, unitList, coverIds, WORKFLOW_SOURCE,
} from './build-core.mjs'
import {
  Fail, LOCK_SLEEP_MS, claimRow, closeCall as auditCloseCall, framePathProblems, launchMismatches, load as auditLoad, lockRefusal, main as auditMain, nap, noProgress as auditNoProgress,
  recordCall as auditRecordCall, resultPath, save as auditSave, submitCmd, unwrap, waveProgress as auditWaveProgress, withLock as auditWithLock, writeAtomic, writeLauncher,
} from '../../coverage-audit/scripts/ledger-cli.mjs'
import { lineOf, packUnitsTo } from '../../coverage-audit/scripts/ledger-core.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SKILL_DIR = path.dirname(HERE)
// どの段も同じ 1 つの Workflow source（書く役と書かない役を同じ波の列に並べる理由は references/ledger.md の「設計の型から変えた点」）。
const WORKFLOW = WORKFLOW_SOURCE
const CHECK_TIMEOUT_MS = 1800000

// lock の待ちが切れた拒否（終了状態 3）。台帳は変えておらず、同じ命令を流し直せば続きから進む。
class Busy extends Fail { constructor(msg, extra = {}) { super(msg, { ...extra, busy: true }) } }
const MULTI = ['input', 'target', 'check', 'task', 'fact']
const KNOWN = {
  init: ['state', 'mode', 'repo', 'goal', 'request', 'decisions', 'criteria', 'constraints', 'input', 'target', 'check', 'roles', 'max-cycles', 'max-agents-total', 'max-unit-rounds', 'audit-phases'],
  next: ['state'], ingest: ['state', 'call', 'result'], 'run-checks': ['state'], status: ['state'],
  claim: ['state', 'call', 'worker', 'wave', 'model', 'effort', 'stage'], query: ['state', 'call', 'worker', 'task', 'fact'], submit: ['state', 'call', 'worker'],
  hint: ['state', 'text'], answer: ['state', 'id', 'text', 'file'], dismiss: ['state', 'id', 'text'], config: ['state', 'max-cycles', 'max-agents-total', 'max-unit-rounds', 'audit-phases', 'audit-max-cycles', 'audit-max-agents-total'],
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
// 検査の台帳（coverage-audit）の上限。build の config で受け、検査の台帳の config（--max-cycles・--max-agents-total）に渡す。
const AUDIT_LIMIT_KEYS = [['audit-max-cycles', 'max-cycles'], ['audit-max-agents-total', 'max-agents-total']]
// 検査を挟む段（--audit-phases）。baseline・design・impl の名前をカンマで並べる。知らない名前・空は拒む（台帳を作らない・変えない）。
function auditPhasesOf(o) {
  if (o['audit-phases'] === undefined) return null
  const xs = String(o['audit-phases']).split(',').map((x) => x.trim()).filter(Boolean)
  const bad = xs.filter((x) => !AUDIT_PHASES.includes(x))
  if (!xs.length || bad.length) throw new Fail(`--audit-phases は ${AUDIT_PHASES.join('・')} をカンマで並べたもの（知らない段: ${bad.join(', ') || '空'}）`)
  return AUDIT_PHASES.filter((p) => xs.includes(p))
}
const ledgerPath = (dir) => path.join(dir, 'build.json')
function load(dir) {
  if (!existsSync(ledgerPath(dir))) throw new Fail(`台帳が無い: ${ledgerPath(dir)}（init を先に流す）`)
  const L = JSON.parse(read(ledgerPath(dir)))
  if (!L.goal || !Array.isArray(L.goal.items)) throw new Fail(`台帳の形式が古い（目標の項目と引用を持たない）: ${ledgerPath(dir)}。goal.md などを 1 行 1 件・引用つきに直し、新しい stateDir で init からやり直す`)
  if (!Array.isArray(L.audit_events_seen)) throw new Fail(`台帳の形式が古い（coverage-audit の出来事の受けた記録を持たない）: ${ledgerPath(dir)}。新しい stateDir で init からやり直す`)
  if (!L.audit_groups || typeof L.audit_groups !== 'object') throw new Fail(`台帳の形式が古い（設計レビューの群を持たない）: ${ledgerPath(dir)}。新しい stateDir で init からやり直す`)
  if (L.arch && !Array.isArray(L.arch.contracts)) throw new Fail(`台帳の形式が古い（方式設計が境界の約束を持たない）: ${ledgerPath(dir)}。新しい stateDir で init からやり直す`)
  if (!Number.isInteger(L.call_seq)) throw new Fail(`台帳の形式が古い（役が claim・query・submit で読み書きする呼び出しの通し番号を持たない）: ${ledgerPath(dir)}。新しい stateDir で init からやり直す`)
  if (!Number.isInteger(L.wave_seq) || !Array.isArray(L.audit_phases) || (L.pending && L.pending.call_id && L.pending.wave_id === undefined)) throw new Fail(`台帳の形式が古い（波の連番・検査を挟む段・開いた呼び出しの波の記録を持たない）: ${ledgerPath(dir)}。新しい stateDir で init からやり直す`)
  return L
}
function save(dir, L) { L.rev += 1; writeAtomic(ledgerPath(dir), JSON.stringify(L, null, 1)) }
const hints = (dir) => { const f = path.join(dir, 'hints.jsonl'); return existsSync(f) ? read(f).split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [] }
// 役が最初の claim を流す入口（stateDir/build-cli.mjs）。中身と書き直す時は coverage-audit の writeLauncher と同じで、名前とこの CLI の path を渡す。
export const LAUNCHER = 'build-cli.mjs'
const CLI_PATH = fileURLToPath(import.meta.url)
const writeBuildLauncher = (dir) => writeLauncher(dir, LAUNCHER, CLI_PATH)
// 呼び出しを開く・閉じるコマンドと担当のコマンド（next・ingest・claim・query・submit）は、load から save までを stateDir/build.lock で囲む
// （coverage-audit の withLock に lock の名前を渡す。待ち・古い lock の拒否・token の扱いは同じ）。
// 検査の台帳を読み書きするときは、build.lock を持ったまま coverage-audit の CLI が stateDir/audit/state/ledger.lock を取る（lock の順は build → audit）。
const BUILD_LOCK = 'build.lock'
const withLock = (dir, fn) => auditWithLock(dir, fn, BUILD_LOCK)
// 役の claim・query・submit の lock の待ち。claim は次の波を作るときに、検査の台帳の init・reframe・next（対象の全ての読み直しと写し）と取り込みを
// lock の中で流すので、対象が大きいと withLock の 1 回の待ち（LOCK_WAIT_MS）を超えうる。待ちは、役の Bash のコマンドが流れられる時間（既定の上限 2 分）に
// 収める WORKER_LOCK_WAIT_MS まで取り直し、切れたら終了状態 3（台帳は変えていない。役は同じ命令を流し直す）で返す（拒んで担当を失わせない）。
// lock が空くまでは自分で待ち、空いた時だけ withLock を流すので、内側の withLock の待ちは取り合いに負けたときだけ（その分だけ上限を越えうるので、上限は 2 分から 20 秒を残す）。
// 環境変数 COVERAGE_BUILD_LOCK_WAIT_MS（ミリ秒）は、テストで待ちの全体を短くする口。
export const WORKER_LOCK_WAIT_MS = 90000
const workerLockWait = () => { const v = Number(process.env.COVERAGE_BUILD_LOCK_WAIT_MS); return Number.isFinite(v) && v > 0 ? Math.min(v, WORKER_LOCK_WAIT_MS) : WORKER_LOCK_WAIT_MS }
function withWorkerLock(dir, fn) {
  const wait = workerLockWait()
  const file = path.join(dir, BUILD_LOCK)
  const t0 = Date.now()
  // fn の中で取る検査の台帳の lock の待ちが切れた拒否は、build.lock の取り合いと分けるため Busy にして投げ直す（取り直さない）。
  const inner = () => {
    try { return fn() } catch (e) {
      if (e instanceof Fail && e.extra && e.extra.busy && !(e instanceof Busy)) throw new Busy(`lock の待ちが切れた（検査の台帳の lock: ${e.message}）。台帳は変えていない（取った担当は失われない）。同じ命令を流し直す`)
      throw e
    }
  }
  for (;;) {
    if (!existsSync(file)) {
      try { return withLock(dir, inner) } catch (e) { if (!(e instanceof Fail) || !(e.extra && e.extra.busy) || e instanceof Busy) throw e }
    }
    if (Date.now() - t0 >= wait) {
      let age = null
      try { age = Date.now() - statSync(file).mtimeMs } catch (e) { if (e.code === 'ENOENT') continue; throw e }
      // 古い lock は流し直しても空かないので、終了状態 2 で手で消す案内を返す（coverage-audit の lockRefusal）。
      const r = lockRefusal(file, age, wait)
      if (!(r.extra && r.extra.busy)) throw r
      throw new Busy(`lock の待ちが切れた（${wait}ms 待っても ${file} を取れない。他の process が台帳を書いている）。台帳は変えていない（取った担当は失われない）。同じ命令を流し直す`)
    }
    Atomics.wait(nap, 0, 0, LOCK_SLEEP_MS)
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
// 読める集合は呼ぶたびに今の台帳から作る（同じ呼び出しの中で方式設計が単位の持つファイルを変える）。
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

// ---------------- 検査（coverage-audit の関数を同じ process で流す） ----------------
// coverage-audit の台帳は stateDir/audit/state の 1 つに固定する。台帳が無ければ init、あれば reframe で段と枠（目標・基準・制約・決定の記録・観点・対象・参照）を差し替える。
// 同じ段・同じ枠のまま（取り込みの前）なら reframe し直さない（途中の検査と、coverage-audit の answer で足した A<n> を消さないため）。取り込んだ後は枠の控えを消し、
// 次にその段を検査するときは reframe する（coverage-audit は同じ段で手続きが同じなら、内容の変わった単位だけを読み直す）。
// 目標はこのスキルが照合済みなので、init には照合済みの印（--goal-checked coverage-build）を付け、coverage-audit は照合を流さない。reframe は台帳の印を残す。
// 受け入れ基準（単位ごとの受け入れを含む）は制約と取り違えないよう、coverage-audit の基準の欄（criteria.md）で渡す。
// 基準・制約が 0 件なら、その欄のファイルも引数も渡さない（「- なし」を書くと coverage-audit が「AC1: なし」という項目として読む）。
// 参照（--context）: どの段も入力（--input）を、update の設計レビューはそれに加えて update の対象（今の本文）を渡す。参照は網羅に数えず、引用の根拠にできる。
export const auditState = (dir) => path.join(dir, 'audit', 'state')
const AUDIT_ROLE_PREFIX = 'audit:'
const auditStageOf = (st) => (typeof st === 'string' && st.startsWith(AUDIT_ROLE_PREFIX) ? st.slice(AUDIT_ROLE_PREFIX.length) : null)
// 検査の段ごとの枠（目標のファイルの冒頭の文）と、coverage-audit に渡す観点（呼ぶ側が持つ領域の観点の中身）。観点の正本はここだけ。
// 観点は枠の文から作り、手続きは「何を列挙し、何と照らすか」で書く。coverage-audit は観点を一覧で全ての単位に渡す。
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
    lens: { id: 'design-fit', name: '設計の充足と実装への足り', procedure: '設計の決定（単位の分け方・依存・受け入れ・ケース）を列挙し、今の本文（参照）と固定した目標・受け入れ基準・制約に照らして、満たしていないものを探す。変更後の文面の存在を求めない（設計は変更を決めるもので、変更後の文面はまだ無い）。次に、各決定が実装とテストに足りるか（境界の表の行 id で単位をまたぐ扱いが決まっているか）を照らす' },
  },
  impl: {
    frame: '実装（各単位のファイルとテスト）が、次の固定した目標・受け入れ基準・制約と、単位ごとの受け入れ（基準の U<n>A<m>）を満たすかを確かめる。',
    lens: { id: 'impl-fit', name: '実装とテストの充足', procedure: '実装とテストの振る舞いを列挙し、固定した目標・受け入れ基準・制約と単位ごとの受け入れ（U<n>A<m>）と照らして、満たしていないもの・テストが確かめていないものを探す' },
  },
}
// coverage-audit の CLI のコマンドを同じ process で流す（子プロセスにしない）。終了状態 0 以外は理由を付けて Fail にする（build の台帳は変えない）。
function audit(cmd, argv, what = cmd) {
  const r = auditMain([cmd, ...argv])
  if (r.code === 3) throw new Busy(`lock の待ちが切れた（検査の台帳の lock: ${r.output && r.output.error}）。台帳は変えていない（取った担当は失われない）。同じ命令を流し直す`)
  if (r.code !== 0) throw new Fail(`coverage-audit の ${what} が拒んだ: ${r.output && r.output.error}`, { audit: r.output })
  return r.output
}
// 段の枠: 対象・参照・coverage-audit に渡すファイルの中身・枠の指紋。
function frameOf(L, dir, phase) {
  const targets = phase === 'design' ? designFiles(L, dir) : phase === 'impl' ? ownedPaths(L).map((p) => abs(L, p)) : L.targets
  const contexts = [...new Set([...L.inputs, ...(phase === 'design' && L.mode === 'update' ? L.targets : [])])].filter((p) => !targets.includes(p))
  const criteria = [...L.criteria, ...(phase === 'impl' ? unitList(L).flatMap((u) => u.acceptance) : [])]
  const files = {
    'goal.md': `${AUDIT_FRAMES[phase].frame}\n\n${items(L.goal.items)}\n`, 'request.md': `${L.request}\n`,
    ...(criteria.length ? { 'criteria.md': `${items(criteria)}\n` } : {}), ...(L.constraints.length ? { 'constraints.md': `${items(L.constraints)}\n` } : {}),
    ...(L.decisions != null ? { 'decisions.md': `${L.decisions}\n` } : {}),
    'lenses.json': `${JSON.stringify([AUDIT_FRAMES[phase].lens])}\n`,
  }
  return { targets, contexts, files, key: sha(C.canon({ phase, targets: [...targets].sort(), contexts: [...contexts].sort(), files })).slice(0, 16) }
}
// 検査の台帳をこの段の枠にする（無ければ init、枠が変わっていれば reframe）。開いたままの検査の呼び出しがあれば、reframe の前に閉じる。
function ensureFrame(L, dir, phase, P) {
  const state = auditState(dir)
  const F = frameOf(L, dir, phase)
  const exists = existsSync(path.join(state, 'ledger.json'))
  if (exists && L.audit_frame && L.audit_frame.phase === phase && L.audit_frame.key === F.key) return
  const inDir = path.join(dir, 'audit', 'in', phase)
  for (const f of existsSync(inDir) ? readdirSync(inDir) : []) if (!(f in F.files)) rmSync(path.join(inDir, f))
  for (const [f, t] of Object.entries(F.files)) writeAtomic(path.join(inDir, f), t)
  const inFile = (f) => path.join(inDir, f)
  // 設計レビューだけ、関係する資産を結ぶ id の型（境界の行・受け入れ・振る舞い）を --link で渡す。ほかの段では渡さない（reframe で link は null に戻る）。
  const argv = [
    '--state', state, ...['goal', 'request', 'criteria', 'constraints', 'decisions'].flatMap((k) => (F.files[`${k}.md`] ? [`--${k}`, inFile(`${k}.md`)] : [])),
    '--lenses', inFile('lenses.json'), ...F.targets.flatMap((f) => ['--target', f]), ...F.contexts.flatMap((f) => ['--context', f]),
    '--repo', L.repo, '--phase', phase, ...(phase === 'design' ? ['--link', C.LINK_PATTERN] : []),
  ]
  if (exists) {
    closeOpenAudit(L, dir, P)
    audit('reframe', argv)
  } else audit('init', [...argv, '--goal-checked', 'coverage-build'])
  applyAuditConfig(L, dir)
  L.audit_frame = { phase, key: F.key, target_key: keysOf(L, dir)[phase] }
}
// 開いたままの検査の呼び出しを、reframe の前に閉じる（前の枠の呼び出しを残さない）。どの行も claim していない（起動されなかった）呼び出しは、
// 会計（試行・出来事・calls・fail_streak・全文レビューの試行）に数えずに捨てる。claim のあった呼び出しは coverage-audit の ingest で閉じる。
function closeOpenAudit(L, dir, P) {
  const state = auditState(dir)
  const call = auditWithLock(state, () => {
    const AL = auditLoad(state)
    const AP = AL.pending
    if (!AP) return null
    if ((AP.claims || 0) === 0 && (AP.waves_closed || 0) === 0) { AL.pending = null; auditSave(state, AL); return null }
    return AP.call_id
  })
  if (call) auditIngest(dir, call, [])
  if (P) for (const c of P.audit_calls || []) if (c.call === call) c.closed = true
}
// 検査が止まった（coverage-audit の claim が halt を返した）呼び出しを、その波で claim した行が全て done を受け取った後に閉じる。
// coverage-audit の ingest と同じ順（recordCall → closeCall）で、その呼び出しの段のうちに起動の記録（agents・calls・fail_streak）と会計を締める
// （段が変わった後に記録を入れると、新しい段の起動数・周・出来事に数えてしまうため）。この時点で Workflow の成否は分からないので、
// claim した行を返った（ok）として入れ、build の ingest が Workflow の起動の記録の成否に直す（patchStoppedAudit）。中身は coverage-audit の関数のまま。
function closeStoppedAudit(dir, P, entry) {
  const state = auditState(dir)
  const agents = P.launched.filter((x) => x.audit && x.audit.call === entry.call).flatMap((W) => W.workers.filter((w) => (W.claimed || []).includes(w.id))
    .map((w) => ({ role: w.role, label: `${w.role}-${W.audit.ids[w.id]}`, model: w.model, effort: w.effort, ok: true, stage: auditStageOf(w.stage), wave: W.audit.wave })))
  auditWithLock(state, () => {
    const AL = auditLoad(state)
    const AP = AL.pending
    if (!AP || AP.call_id !== entry.call) return
    const cur = agents.filter((a) => String(a.wave) === String(AP.wave_id))
    const waveFailed = auditNoProgress(AP, cur)
    auditRecordCall(AL, AP, { agents, tokens: null }, !AP.progressed && waveFailed)
    AL.hints_read.push(...(AP.hints || []))
    auditCloseCall(AL, { env: waveFailed, lost: false })
    auditSave(state, AL)
    entry.recorded_at = { call: AP.call_id }
  })
  entry.closed = true
}
// 閉じた検査の呼び出しの起動の記録の成否を、Workflow の起動の記録（build の ingest が受けたもの）に直す。記録の位置（段）は変えず、新しい記録・出来事は足さない
// （欠けの出来事は build の台帳の agent_missing に 1 件だけ残る）。
function patchStoppedAudit(dir, entry, agents) {
  const state = auditState(dir)
  auditWithLock(state, () => {
    const AL = auditLoad(state)
    for (const a of agents) {
      const x = AL.agents.find((y) => y.call_id === entry.call && y.label === a.label && String(y.wave) === String(a.wave))
      if (x) x.ok = !!a.ok
    }
    const c = AL.calls.find((y) => y.call_id === entry.call)
    if (c) c.failed = AL.agents.filter((y) => y.call_id === entry.call && !y.ok).length
    auditSave(state, AL)
  })
  entry.recorded = true
}
// build の config で受けた検査の上限を、検査の台帳に渡す（台帳がまだ無ければ、作った後に渡す）。
function applyAuditConfig(L, dir) {
  const c = L.audit_config || {}
  const argv = AUDIT_LIMIT_KEYS.flatMap(([, k]) => (c[k] !== undefined ? [`--${k}`, String(c[k])] : []))
  if (argv.length && existsSync(path.join(auditState(dir), 'ledger.json'))) audit('config', ['--state', auditState(dir), ...argv])
}
// 検査の呼び出しを閉じる（coverage-audit の ingest）。agents は起動の記録を coverage-audit の行の印（label・段・波）に直したもの。
function auditIngest(dir, call, agents) {
  const f = path.join(auditState(dir), `result-build-${call}.json`)
  writeAtomic(f, JSON.stringify({ agents, tokens: null }))
  return audit('ingest', ['--state', auditState(dir), '--call', call, '--result', f])
}
// 検査が止まった（coverage-audit の next が stop を返した）ときの取り込み。complete と、上の層の指摘・検証不能だけの needs_input は取り込み、
// それ以外（利用者への問い・試行の上限・計画の欠陥・blocked・limit）は取り込まずに台帳に残し、decide が止める（audit_halt）。
const AUDIT_ASKS = ['stuck', 'questions', 'target_gaps', 'plan_defects', 'goal_gaps']
function importStop(L, dir, phase, n) {
  const asks = AUDIT_ASKS.filter((k) => Array.isArray(n[k]) && n[k].length)
  if (!['complete', 'needs_input'].includes(n.stop) || asks.length) {
    const ids = [...(n.questions || []).map((q) => q.id), ...(n.plan_defects || []).map((x) => x.id), ...(n.target_gaps || []).map((x) => x.id), ...(n.stuck || []).map((k) => `attempts:${k}`)]
    L.audit_halt = { phase, stop: n.stop, cause: n.cause || null, reasons: n.reasons || [], state: auditState(dir), status_path: n.status_path || null, ids, ...Object.fromEntries(asks.map((k) => [k, n[k]])),
      ...(n.stop === 'limit' ? { then: `検査の上限で止まった。上限を上げるなら CLI config --state ${dir} --audit-max-agents-total N（周の上限は --audit-max-cycles N）を流してから next を流す` } : {}) }
    return
  }
  let status
  try { status = JSON.parse(read(n.status_path)) } catch (e) { throw new Fail(`coverage-audit の status のファイルを読めない: ${n.status_path}（${e.message}）`) }
  if (!status || status.phase !== phase) throw new Fail(`検査の段と違う段の status（検査の段は ${phase}、status は ${status && status.phase}）`)
  const designD = designDir(dir)
  const unitOfPath = (f) => {
    if (path.dirname(f) === designD) { const m = /^(U\d+)\.md$/.exec(path.basename(f)); return { unit: m ? m[1] : null, test: false } }
    return ownerOf(L, path.relative(L.repo, f))
  }
  let base
  // 取り込みの規則（終わっていない検査・途中の呼び出し・読み終えていない単位を拒む）に落ちたら、取り込まずに止まった記録にする。
  try { base = importAudit(L, status, phase, { readText: reader(L, dir), unitOfPath }) } catch (e) {
    L.audit_halt = { phase, stop: n.stop, cause: 'import', reasons: [...(n.reasons || []), `取り込めない: ${e.message}`], state: auditState(dir), status_path: n.status_path || null, ids: [] }
    return
  }
  writeAtomic(path.join(dir, 'audit', `${phase}-status.json`), JSON.stringify(status, null, 1))
  const key = L.audit_frame && L.audit_frame.target_key
  L.audit_frame = null
  // metrics は coverage-audit の run の指標（指摘の出どころの内訳・持ち越した読みの数・全体の段で落とした数と確認で復活した数）。
  L.audits[phase] = { imported: key, state: auditState(dir), cycle: L.cycle, not_seen: base.not_seen, findings: (status.findings && status.findings.confirmed || []).length, references: base.references, metrics: status.metrics || null }
  if (phase !== 'baseline') L.retro.due = true
}
// 検査の段の波を作る。台帳をこの段の枠にし、coverage-audit の next を流す。止まれば取り込んで { imported }（呼ぶ側は次の決定へ進む）。
// 呼び出しが開けば、その今の波の行を build の行（id は build の呼び出しの中で重ならない名前、stage は audit:<段>）にして返す。
// 検査の呼び出しは開いたままにする（起動しなかった波を会計に数えない。開いている間の coverage-audit の next は同じ呼び出しの今の波を返す）。
function auditWave(L, dir, P, phase, tags) {
  for (let i = 0; i < 3; i++) {
    ensureFrame(L, dir, phase, P)
    const n = audit('next', ['--state', auditState(dir)])
    if (n.stop) {
      // 検査に渡した後に対象が変わったら、取り込まずに読み直させる（coverage-audit の next が変わった単位を読み直す）。
      writeDesign(L, dir)
      const now = keysOf(L, dir)[phase]
      if (L.audit_frame && L.audit_frame.target_key !== now) { L.audit_frame.target_key = now; continue }
      importStop(L, dir, phase, n)
      return { imported: true }
    }
    const a = JSON.parse(read(n.args_path))
    if (!(P.audit_calls || []).some((c) => c.call === a.callId)) P.audit_calls = [...(P.audit_calls || []), { call: a.callId, phase, closed: false }]
    return { wave: auditWaveOf(P, phase, a.callId, a.wave, tags) }
  }
  throw new Fail(`検査（${phase}）の対象が検査の間に変わり続けた（next からやり直す）`)
}
// coverage-audit の波（{id, rows}）を build の波にする。行の id は build の呼び出しの中で重ならない q<段の頭><番号>（coverage-audit の行の id は呼び出しごとに数え直すので写さない）。
function auditWaveOf(P, phase, call, wave, tags) {
  const ids = {}
  const workers = wave.rows.map((r) => {
    const tag = `q${r.stage.replace(/[^a-z]/g, '').slice(0, 2)}`
    const id = `${tag}${(tags[tag] = (tags[tag] || 0) + 1)}`
    ids[id] = r.id
    return { id, role: r.role, model: r.model, effort: r.effort, stage: `${AUDIT_ROLE_PREFIX}${r.stage}` }
  })
  return { step: 'audit', task: null, phase, workers, audit: { call, wave: wave.id, ids }, claims: 0, submits: 0, accepted: 0, claimed_rows: [], done_rows: [], sig: sha(JSON.stringify(['audit', call, wave.id])).slice(0, 16) }
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
  const auditPhases = auditPhasesOf(o)
  const roles = { ...JSON.parse(read(path.join(HERE, 'roles.json'))), ...(o.roles ? JSON.parse(read(o.roles)) : {}) }
  const text = {
    goal: read(need(o, 'goal')).trim(), request: read(need(o, 'request')).trim(), decisions: o.decisions ? read(o.decisions).trim() : null,
    criteria: o.criteria ? read(o.criteria) : '', constraints: o.constraints ? read(o.constraints) : '',
  }
  const g = readGoalFiles(text)
  // 目標・基準・制約の本文の path が repo に実在するのに、対象（--target）にも入力（--input）にも無ければ拒む（coverage-audit の照合をそのまま使う）。
  const pp = framePathProblems(g, { repo, targets, contexts: inputs })
  if (g.problems.length || pp.length) throw new Fail('目標・基準・制約に、引用か path の照合を通らない項目がある（台帳は作っていない。直して init をやり直す）', { problems: [...g.problems, ...pp] })
  const L = newLedger({
    mode, repo, goal: text.goal, goalItems: g.goal, request: text.request, decisions: text.decisions, criteria: g.criteria, constraints: g.constraints,
    inputs, targets, checks, config: posInts(o, LIMIT_KEYS), roles, auditPhases,
  })
  mkdirSync(dir, { recursive: true })
  save(dir, L)
  writeBuildLauncher(dir)
  return { ok: true, state: dir, mode, audit_phases: L.audit_phases, hint: `ヒントは node ${path.join(HERE, 'build-cli.mjs')} hint --state ${dir} --text "..." で足せる（実行中も止まっている間も）` }
}

// ---------------- 呼び出し（next が開き、波を claim が進め、ingest が閉じる） ----------------
// args は {state, callId, wave} だけにする（B4。wave は最初の波 {id, rows}）。担当が読む文は args にも prompt にも載せず、役が claim と query で台帳から引く（B1）。
// 1 つの波の行は全て同時に起動されるので、前の役の提出を読む役（詳細設計・実行役・検証役）は次の波に置く。1 つの波の役は 1 つの段に属す。
// 波の担当が尽きると、claim が台帳の状態から次の波を決めて記録し（next_wave）、Workflow script がその行で次の波を起動する。
// check（CLI の外で流す）・止まる条件・時間・行の数の区切りでは、claim が halt を返す。
// 担当の種類から役の名前への対応は build-core.mjs の TASK_ROLE の 1 か所。役のモデルと effort の組は roles.json だけが持ち、CLI が波の行に写す
// （Workflow source は行の値を使い、役の名前で分岐しない）。検査の役の行は coverage-audit が作る（coverage-audit の roles.json の値）。
const WRITE_STEPS = ['tests', 'implement']
const UNIT_TASKS = ['spec', 'tests', 'implement']
const INTENT_TASKS = ['exam', 'judge']
// 今の時刻（ミリ秒）。環境変数 COVERAGE_BUILD_NOW_MS があればその値（テストで呼び出しの経過を差し替える）。呼び出しの時間の区切りにだけ使う
// （ファイルの mtime と比べる波の開始の時刻は、本物の時刻で持つ）。
const nowMs = () => { const v = process.env.COVERAGE_BUILD_NOW_MS; return v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : Date.now() }
// 呼び出しの時間の区切り: 開いてからの経過がこれを超えたら、新しい波を起動せずに終える（残りの 1 体の時間の上限を残す）。
const CALL_BUDGET_MS = C.LIMITS.timeoutMs - C.LIMITS.agentTimeoutMs
// 単位の担当が読むファイルの本文のバイト数（詰め合わせに使う）。単位の設計の写しと、段が読む単位のファイル（あるものだけ）。
// 入力・方式設計の写しのように全ての単位の担当が読むものは 1 体が 1 回読むので数えない。
function unitBytes(L, dir, u, task) {
  const own = task === 'spec' ? u.paths : task === 'tests' ? u.tests : [...u.paths, ...u.tests]
  return [designPath(dir, u.id), ...own.map((p) => abs(L, p))].reduce((n, f) => n + (existsSync(f) ? statSync(f).size : 0), 0)
}
// 残りの予算（起動数）。開いた呼び出しで既に出した行も引く。
const budgetRemain = (L, P) => L.config.max_agents_total - L.agents.length - (P ? P.rows_total || 0 : 0)
// 今の波で取ったまま出し終えていない担当の鍵（次の波に同じ担当を重ねない）。
const inFlight = (P) => new Set((P && P.tasks ? P.tasks : []).filter((t) => t.claimed && !t.done).map((t) => t.unit || t.intent).filter(Boolean))
// 段の行（worker）と担当。担当は行に結び、worker は claim で自分の行の担当を取る。行の id は呼び出しの中で役の頭ごとに数える（tags）。
// - 目標の照合・方式設計・振り返りの計画: 担当 1 つを 1 体。
// - 詳細設計・テスト・実装: 単位の並びで前から線（役の context_tokens から coverage-audit の lineOf が導く）まで 1 体に詰める（packUnitsTo）。テストを書く役と実装する役は段が違うので別の体。
//   実装は依存がそろった単位だけを claim で渡す（1 体が前の単位を出した後に、次の単位を取り直す）。
// - 振り返りの実行と検証: 今の周の確かめる意図（検証は実行役が支持した意図）の全てを 1 体。
// cap は行の数の上限（1 以上）。今の波で出し終えていない担当は除く（その行が出す）。
function buildWave(L, dir, P, d, cap, tags) {
  const role = TASK_ROLE[d.task]
  const busy = P && P.step === d.step && P.task === d.task ? inFlight(P) : new Set()
  const row = (tag) => ({ id: `${tag}${(tags[tag] = (tags[tag] || 0) + 1)}`, role, model: L.roles[role].model, effort: L.roles[role].effort, stage: d.step })
  let rows = []
  let tasks = []
  if (['goal', 'arch', 'plan'].includes(d.task)) {
    const r = row(d.task[0])
    rows = [r]
    tasks = [{ id: d.task === 'plan' ? `plan:${L.cycle}:${L.retro.rounds + 1}` : d.task, kind: d.task, worker: r.id }]
  } else if (INTENT_TASKS.includes(d.task)) {
    const its = (d.task === 'exam' ? queuedIntents(L) : examinedIntents(L)).filter((it) => !busy.has(it.id))
    if (its.length) {
      const r = row(d.task === 'exam' ? 'x' : 'v')
      rows = [r]
      tasks = its.map((it) => ({ id: `${d.task}:${it.id}`, kind: d.task, intent: it.id, worker: r.id }))
    }
  } else {
    const units = (d.task === 'spec' ? unitList(L).filter((u) => u.need_design) : d.task === 'tests' ? testsTodo(L) : implPending(L)).filter((u) => !busy.has(u.id))
    // 実装は、依存がそろった単位を 1 つも持たない詰め合わせを起動しない（最初の claim が done になる体を起こさない）。その単位は次の波か呼び出しで渡る。
    const packs = packUnitsTo(units.map((u) => u.id), (id) => unitBytes(L, dir, L.units[id], d.task), lineOf(L, [role]))
      .filter((ids) => d.task !== 'implement' || ids.some((id) => depsDone(L, L.units[id])))
      .slice(0, Math.max(1, cap))
    rows = packs.map(() => row({ spec: 'd', tests: 't', implement: 'i' }[d.task]))
    tasks = packs.flatMap((ids, i) => ids.map((id) => ({ id: `${d.task}:${id}`, kind: d.task, unit: id, worker: rows[i].id, ...(WRITE_STEPS.includes(d.task) ? { paths: d.task === 'tests' ? L.units[id].tests : L.units[id].paths } : {}) })))
  }
  const sig = sha(JSON.stringify([d.step, d.task, rows.map((r) => r.role), tasks.map((t) => [t.id, rows.findIndex((r) => r.id === t.worker)])])).slice(0, 16)
  return { step: d.step, task: d.task, phase: null, workers: rows, tasks: tasks.map((t) => ({ ...t, claimed: false, done: false, accepted: false })), claims: {}, submits: 0, accepted: 0, claimed_rows: [], done_rows: [], sig }
}
// 決定 d の波を作る（cap は行の数の上限、tags は行の id の連番の写しで、波を記録したときだけ呼び出しに戻す）。検査の段は coverage-audit の波。
// 返すのは { wave } か、検査が止まって取り込んだ（{ imported }）か。
function waveFor(L, dir, P, d, cap, tags) {
  if (d.step === 'audit') return auditWave(L, dir, P, d.phase, tags)
  return { wave: buildWave(L, dir, P, d, cap, tags) }
}
// 波の欄（開いた呼び出しの今の波）。呼び出しの欄（call_id・opened_at・rows_total・launched など）と分けて差し替える。
const WAVE_KEYS = ['wave_id', 'step', 'task', 'phase', 'workers', 'tasks', 'audit', 'claims', 'submits', 'accepted', 'claimed_rows', 'done_rows', 'stale', 'sig', 'before', 'started']
// 単位のファイル・入力・対象の今の hash（絶対 path → hash か null）。
const watched = (L) => [...new Set([...ownedPaths(L).map((p) => abs(L, p)), ...L.inputs, ...L.targets])]
const hashesNow = (L) => Object.fromEntries(watched(L).map((f) => [f, fileHash(f)]))
// 波を起動した（呼び出しを開いたか、記録した次の波の最初の claim が来た）ものとして今の波にする。行の数を呼び出しの和に足す。
// 波は、起動の時点の単位のファイル・入力・対象の hash（before）と時刻（started。本物の時刻）を持つ（受け持ちの外の変更は波ごとに照らす。検査の波も同じ）。
function launchWave(L, P, W) {
  for (const k of WAVE_KEYS) delete P[k]
  Object.assign(P, W, { before: hashesNow(L), started: Date.now() })
  P.rows_total += W.workers.length
  P.launched.push({ id: W.wave_id, step: W.step, workers: W.workers, claimed: [], ...(W.audit ? { audit: { call: W.audit.call, wave: W.audit.wave, ids: W.audit.ids } } : {}) })
}
const addHints = (L, dir, P) => { for (const h of hints(dir)) if (!L.hints_read.includes(h.id) && !P.hints.includes(h.id)) P.hints.push(h.id) }
// 呼び出しの区切り（時間・行の数）。当たれば halt の理由、当たらなければ null。n は足す行の数。
function callLimit(L, P, n = 1) {
  const elapsed = nowMs() - P.opened_at
  if (elapsed > CALL_BUDGET_MS) return `呼び出しを開いてからの経過 ${elapsed}ms が、時間の区切り timeoutMs − agentTimeoutMs（${CALL_BUDGET_MS}ms）を超えた。新しい波は起動しない。続きは次の呼び出しが進める`
  const remain = budgetRemain(L, P)
  const cap = Math.min(C.LIMITS.maxAgents - P.rows_total, remain)
  if (cap < n) return remain < n ? `起動数が上限 ${L.config.max_agents_total} に達する。新しい波は起動しない。next が止まる理由を返す` : `この呼び出しで出した行の和 ${P.rows_total} に次の波の ${n} 行を足すと上限 maxAgents ${C.LIMITS.maxAgents} を超える。新しい波は起動しない。続きは次の呼び出しが進める`
  return null
}
// 次の波を決めて記録する（波の担当が尽きたときの claim の done に載せる）。止まる条件・check・時間・行の数の区切りでは halt を返す（新しい波を起動させない）。
// 行の数は maxAgents − この呼び出しで出した行と、残りの予算に収める。同じ中身の波を既に記録していれば、それを返す（中身が変われば新しい id で記録し直す）。
// 検査の段の波を作るときは、その前に検査の台帳の init・reframe を済ませ、検査が止まっていれば取り込んで、次の決定へ進む。
function nextWaveOf(L, dir, P, d) {
  const halt = (reason) => ({ halt: true, reason })
  for (let guard = 0; guard < 20; guard++) {
    if (d.stop) return halt(`台帳が止まる条件に当たった（${d.stop}: ${(d.reasons || []).join(' / ')}）。新しい波は起動しない。呼ぶ側は ingest の後の next で結果を受け取る`)
    if (d.step === 'checks') return halt('機械の検査（check）を流す段に来た。check は Workflow の外で流すので、新しい波は起動しない。呼ぶ側は ingest の後の next で checks を受け取り、run-checks を流してから次の呼び出しへ進む')
    const lim = callLimit(L, P)
    if (lim) return halt(lim)
    const tags = { ...P.tags }
    const r = waveFor(L, dir, P, d, Math.min(C.LIMITS.maxAgents - P.rows_total, budgetRemain(L, P)), tags)
    if (r.imported) { d = advance(L, dir); continue }
    const W = r.wave
    if (!W.workers.length) return {}
    const lim2 = callLimit(L, P, W.workers.length)
    if (lim2) return halt(lim2)
    if (!P.next || P.next.sig !== W.sig) {
      addHints(L, dir, P)
      P.tags = tags
      P.next = { ...W, wave_id: ++L.wave_seq }
    }
    return { next_wave: { id: P.next.wave_id, rows: P.next.workers } }
  }
  throw new Fail('次の波を決められない（検査の取り込みが繰り返された）')
}
// 段の間の決定的な遷移（設計の写しを書く・振り返りの巡を閉じる・振り返りの結論を層へ戻す）を流し、次の 1 手か停止を決める。
// next（呼び出しを開くとき）と claim（波の担当を渡すか、次の波を決めるとき）が同じこの関数を流す。検査の取り込みは、検査の段の波を作るときに流す（auditWave）。
function advance(L, dir) {
  for (;;) {
    writeDesign(L, dir)
    const keys = keysOf(L, dir)
    const missing = [...L.inputs, ...L.targets].filter((p) => !existsSync(p))
    settleRetro(L)
    const d = decide(L, { keys, missing })
    if (d.step === 'route') { route(L); continue } // 静的な段: agent を起動しない
    return d
  }
}
const callOut = (P, W, argsPath) => ({ step: W.step === 'audit' ? `audit:${W.phase}` : W.step, call_id: P.call_id, workflow: WORKFLOW, args_path: argsPath, estimate_agents: W.workers.length, limits: C.LIMITS, cycle: P.cycle })
const stopOut = (L, dir, d) => ({ ...d, cycle: L.cycle, routes: L.mode === 'review' ? L.routes : undefined, skipped_audits: skippedAudits(L), next_args: d.stop === 'complete' ? null : { state: dir } })

function cmdNext(o) {
  const dir = path.resolve(need(o, 'state'))
  return withLock(dir, () => next(dir))
}
function next(dir) {
  const L = load(dir)
  writeBuildLauncher(dir)
  // 開いた呼び出しがある間は、同じ呼び出しを返す（冪等。B6）。閉じるのは ingest --call だけにし、司令塔が next を流し直しても、
  // Workflow の実行中の claim・submit を壊さない。返す args は今の波（記録した次の波があればそれ、無ければ閉じていない今の波）。
  if (L.pending && L.pending.call_id) {
    const P = L.pending
    const W = P.next || P
    let argsPath = P.args_path
    if (String(W.wave_id) !== String(P.launched[0].id)) {
      argsPath = path.join(dir, `call-${P.call_id}-w${W.wave_id}.json`)
      writeAtomic(argsPath, JSON.stringify({ state: dir, callId: P.call_id, wave: { id: W.wave_id, rows: W.workers } }))
    }
    return callOut(P, W, argsPath)
  }
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
  // 検査が取り込めずに止まった記録は、next のたびに外し、検査の台帳から止まった理由を読み直す（利用者が答えた・上限を変えた後に続ける）。
  L.audit_halt = null
  for (let guard = 0; guard < 20; guard++) {
    const d = advance(L, dir)
    if (d.stop) {
      L.stopped = { ...d, cycle: L.cycle }
      L.pending = null
      save(dir, L)
      return stopOut(L, dir, d)
    }
    L.stopped = null
    if (d.step === 'checks') {
      L.pending = { step: 'checks', key: keysOf(L, dir).impl }
      save(dir, L)
      return { step: 'checks', cycle: L.cycle, checks: L.checks, then: `run-checks --state ${dir} を background で流し、終わるまで待つ` }
    }
    const callId = sha(`${dir}|${L.call_seq + 1}|${d.step}|${L.cycle}|${L.rev}`).slice(0, 12)
    // 呼び出しの記録: 開いた時刻（時間の区切り）・出した行の和（行の数の区切り）・起動した波・行の id の連番・開いた検査の呼び出し。今の波の欄は launchWave が置く。
    const P = { call_id: callId, args_path: path.join(dir, `call-${callId}.json`), opened_at: nowMs(), cycle: L.cycle, events_at: L.events.length, hints: [], rows_total: 0, tags: {}, launched: [], next: null, progressed: false, prev_submits: 0, audit_calls: [] }
    const tags = {}
    const r = waveFor(L, dir, P, d, Math.max(1, Math.min(C.LIMITS.maxAgents, budgetRemain(L, null))), tags)
    if (r.imported) continue
    L.call_seq += 1
    P.tags = tags
    L.pending = P
    addHints(L, dir, P)
    launchWave(L, P, { ...r.wave, wave_id: ++L.wave_seq })
    writeAtomic(P.args_path, JSON.stringify({ state: dir, callId, wave: { id: P.wave_id, rows: P.workers } }))
    save(dir, L)
    return callOut(P, P, P.args_path)
  }
  throw new Fail('次の 1 手を決められない（検査の取り込みが繰り返された）')
}
// 呼び出しを開いた時に照らしていたファイル（今の波の before の key）のうち、その後に変わったもので、書いてよい集合（波の書く担当の paths の全て）の外のもの
// （repo の中は相対 path で示す）。波の中で方式設計が新しく持たせたファイルは、開いた時の中身を知らないので照らさない。
function outsideChanges(L, P) {
  const allowed = new Set((P.tasks || []).flatMap((t) => (t.paths || []).map((p) => abs(L, p))))
  const changed = Object.keys(P.before || {}).filter((f) => P.before[f] !== fileHash(f) && !allowed.has(f))
  return changed.map((f) => (f.startsWith(L.repo + path.sep) ? path.relative(L.repo, f) : f))
}

// 波を起動した時に照らしていなかったファイルで、起動した後に書かれた（mtime が started 以後の）もの。repo の作業ツリーを丸ごと控えないための近似で、
// 起動する直前（同じミリ秒）に書かれたファイルや、mtime を保つ書き方は見分けられない。
function freshFile(L, P, rel) {
  const f = abs(L, rel)
  if (Object.hasOwn(P.before || {}, f) || !existsSync(f)) return false
  return statSync(f).mtimeMs >= P.started
}

// repo に既にディレクトリとして在るか（symlink は辿る）。無い path は false。
function isDirIn(L, rel) {
  try { return statSync(abs(L, rel)).isDirectory() } catch (e) { if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return false; throw e }
}

// 起動の記録を台帳に取り込む（段と波の印つき）。model・effort・段が台帳の波の記録と違う起動と、記録に無い波の起動は、欠けとして出来事に残す
// （列挙は coverage-audit の launchMismatches。その起動の提出は、claim が台帳の行と照らして既に拒んでいる）。
function recordCall(L, P, res, failed) {
  const ag = Array.isArray(res.agents) ? res.agents : []
  for (const a of ag) L.agents.push({ call_id: P.call_id, cycle: L.cycle, stage: a.stage ?? P.step, wave: a.wave ?? null, role: a.role, label: a.label, model: a.model, effort: a.effort, ok: !!a.ok })
  for (const x of launchMismatches(P, ag)) addEvent(L, { stage: x.stage, kind: 'launch_mismatch', text: x.text })
  const tokens = typeof res.tokens === 'number' && Number.isFinite(res.tokens) ? res.tokens : null
  L.calls.push({ call_id: P.call_id, cycle: L.cycle, step: P.launched[0].step, stages: P.launched.map((x) => x.step), waves: P.launched.length, agents: ag.length, failed: ag.filter((a) => !a.ok).length, submits: P.prev_submits + (P.submits || 0), tokens, tokens_note: tokens == null ? '消費量を run の中で読めない経路（runner など）' : 'この呼び出しの budget.spent() の差' })
  L.fail_streak = failed ? L.fail_streak + 1 : 0
  for (const a of ag) if (!a.ok) addEvent(L, { stage: a.stage || P.step, kind: 'agent_missing', text: `${a.label}（${a.model}/${a.effort}）が返らなかったか、不正な出力だった` })
}

// 担当の試行を 1 つ数える。単位と段の担当は L.attempts（上限で stuck → needs_input）、意図ごとの担当は意図の tries（上限で意図を閉じる）。
// env は進みの無かった波（blocked（failure）から再開したときに戻す）。上限に達したら true。
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
// 波に進みがあったか。build の波は提出が 1 件でもあったか。検査の波は coverage-audit の waveProgress に、段（行の stage の audit: の後ろ）と、
// この CLI を通った claim・提出・受理の数を渡して判じる。
function waveProgress(P) {
  if (P.step !== 'audit') return !!P.submits
  return auditWaveProgress({ step: auditStageOf(P.workers[0] && P.workers[0].stage), claims: P.claims, submits: P.submits, accepted: P.accepted })
}
// 今の build の波の会計を締める（波の境目: 次の波の最初の claim と、呼び出しを閉じる ingest）。中身は前の形の呼び出しの閉じ方（closeCall）と同じで、
// それを波ごとに流す（開始の hash と書いてよい paths は波ごと）。出し終えていない担当のうち、手を付けた（query か submit のあった）担当だけを試行に数える。
// claim は自分の行の担当を一度に返すので、時間の上限などで手を付けずに終わった担当は数えない（次の波か呼び出しで渡る）。
// 書く段も書かない段も、受け持ちの外のファイルの変更を照らし、あれば出来事にする。書く段はその波で受理した単位を受け付けない。
// 書かない段で単位の持つファイルが変わったら、その単位のテストと実装を無効にし、書く段の担当が中身を書き直すまで受理しない（tainted）。
// 検査の波の担当の会計は coverage-audit が持つので、ここでは受け持ちの外の変更だけを照らす（検査の役は repo を書かない段なので、書かない段と同じ扱い）。
// 順序の門で使わなくした波（stale）の、取られなかった担当は手放し済みなので数えない。
function closeWave(L, P, env) {
  const tasks = P.tasks || []
  for (const t of tasks) {
    if (t.done || t.void || !t.touched) continue
    bumpTask(L, t, '提出されなかった', env)
  }
  // 同じ波の後の担当が、共有の fixture として受理済みの単位のテストのファイルを直すことがある。実装の照合は波の終わりの中身で取り直す。
  for (const t of tasks.filter((x) => x.accepted && x.kind === 'tests' && L.units[x.unit])) {
    const u = L.units[t.unit]
    if (u.tests_for === u.design_hash) u.tests_hash = Object.fromEntries(u.tests.map((f) => [f, fileHash(abs(L, f))]))
  }
  const outside = outsideChanges(L, P)
  if (outside.length) {
    addEvent(L, { stage: P.step === 'audit' ? `audit:${P.phase}` : P.step, kind: 'write_outside', text: `受け持ちの外のファイルが変わった: ${outside.join(', ')}（${WRITE_STEPS.includes(P.step) ? 'この波で受理した単位を受け付けない' : 'そのファイルを持つ単位のテストと実装を書く段で書き直す'}）` })
    for (const t of tasks.filter((x) => x.accepted && WRITE_STEPS.includes(x.kind) && L.units[x.unit])) {
      const u = L.units[t.unit]
      if (t.kind === 'tests') Object.assign(u, { tests_for: null, tests_hash: {} })
      else Object.assign(u, { impl_for: null, impl_hash: {} })
      bumpTask(L, t, '受け持ちの外のファイルが変わった波', env)
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
}
// 記録した次の波の最初の claim: 今の波の会計を締めてから、次の波を今の波にする。環境の失敗の印（env_attempts）は、締める波ごとに、その波の進みで付ける。
// 呼び出し全体の進み（progressed）で判じるのは fail_streak だけ。
function promote(L, P) {
  const moved = waveProgress(P)
  P.progressed = !!P.progressed || moved
  closeWave(L, P, !moved)
  P.prev_submits += P.submits || 0
  launchWave(L, P, P.next)
  P.next = null
}
// 段が変わった（記録した波の段が、その時の decide の段と合わない）波を使わなくする。まだ取られていない担当を、試行に数えずに手放す
// （順序の門。前の段の担当を、段が変わった後に渡さない）。既に渡した担当は手放さない: その提出は submit が照らし、受理か理由つきの拒否になる
// （出さずに終われば、波を締めるときに試行に数える）。検査の波の担当は coverage-audit の呼び出しに残り、ingest が閉じる。
function staleWave(P) {
  if (P.stale) return
  P.stale = true
  for (const t of P.tasks || []) if (!t.done && !t.claimed) { t.done = true; t.void = true }
}
// 今の波に、まだ done を受け取っていない行が取れる担当が残っているか（残っていれば、その行が取るので次の波を決めない）。
function pendingWork(P) {
  if (P.stale) return false
  const live = P.workers.filter((w) => !P.done_rows.includes(w.id))
  return live.some((w) => (P.tasks || []).some((t) => t.worker === w.id && !t.done && !t.claimed))
}

// ingest: --call の呼び出しを閉じるだけ（B3）。返り値から読むのは起動の記録（agents）と tokens だけで、役の出力は受け取らない（全て submit で台帳に入っている）。
// どの波にも提出が無い呼び出しは進みが無かったとして環境の失敗に数える（全ての役が欠けた、または担当を取らずに返った）。続けば blocked（failure）で止まる。
// 開いたままの検査の呼び出しは、その呼び出しの検査の役の起動の記録で閉じる（coverage-audit の ingest）。どの波も起動していない検査の呼び出しは閉じずに残す
// （起動しなかった波を会計に数えない。次の呼び出しが同じ検査の今の波から続ける）。
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
    const ag = Array.isArray(r.agents) ? r.agents : []
    // 記録した次の波が起動された（起動の記録にその波がある）なら、その波を今の波にしてから締める。起動の記録の無い次の波は、起動されなかったので数えない。
    if (P.next && ag.some((a) => a.wave != null && String(a.wave) === String(P.next.wave_id))) promote(L, P)
    const waveFailed = !waveProgress(P)
    const allFailed = !P.progressed && waveFailed
    recordCall(L, P, r, allFailed)
    L.hints_read.push(...P.hints)
    for (const c of P.audit_calls || []) {
      if (c.closed && (c.recorded || !c.recorded_at)) continue
      const waves = P.launched.filter((x) => x.audit && x.audit.call === c.call)
      if (!waves.length) continue
      const mine = ag.flatMap((a) => {
        const W = waves.find((x) => String(x.id) === String(a.wave))
        if (!W) return []
        const row = W.workers.find((w) => `${w.role}-${w.id}` === a.label) || W.workers.find((w) => w.role === a.role)
        return row ? [{ role: a.role, label: `${a.role}-${W.audit.ids[row.id]}`, model: a.model, effort: a.effort, ok: a.ok, stage: auditStageOf(a.stage) ?? auditStageOf(row.stage), wave: W.audit.wave }] : []
      })
      if (c.closed) { patchStoppedAudit(dir, c, mine); continue }
      const st = audit('status', ['--state', auditState(dir)])
      if (!st.pending || st.pending.call_id !== c.call) continue
      auditIngest(dir, c.call, mine)
      c.closed = true
    }
    closeWave(L, P, waveFailed)
    L.pending = null
    save(dir, L)
    // 受け付けなかった提出（rejected_output・write_outside）の理由。ok は「呼び出しを閉じた」ことを指す。
    const rejected = L.events.slice(P.events_at).filter((e) => e.kind === 'rejected_output' || e.kind === 'write_outside').map((e) => e.text)
    return { ok: true, cycle: L.cycle, ...(rejected.length ? { rejected } : {}), next: 'next を流す' }
  })
}

// ---------------- 担当（worker が Bash で流す claim・query・submit） ----------------
// どれも、今開いている呼び出し（pending）の --call と、今の波の行の --worker からだけ受け付ける。外れたら台帳を変えずに拒否する（終了状態 2）。
// 検査の波の行は、coverage-audit の台帳の同じ担当に渡す（--call・--worker・--wave を coverage-audit の呼び出し・行・波に直す）。
function pendingWorker(L, o) {
  const call = need(o, 'call')
  const worker = need(o, 'worker')
  if (!L.pending || !L.pending.call_id) throw new Fail(`開いた呼び出しが無い（呼び出し ${call} は閉じた。worker を終える）`)
  if (call !== L.pending.call_id) throw new Fail(`呼び出しが違う: 今は ${L.pending.call_id}、受け取ったのは ${call}（前の呼び出しは閉じた。worker を終える）`)
  const w = L.pending.workers.find((x) => x.id === worker)
  if (!w) throw new Fail(`この呼び出しの今の波の行に無い worker: ${worker}`)
  return w
}
// worker が今取れる担当: 自分の行の、出し終えていない担当（実装は依存がそろった単位だけ）。
const claimable = (L, P, w) => P.tasks.filter((t) => t.worker === w.id && !t.done && (t.kind !== 'implement' || (L.units[t.unit] && depsDone(L, L.units[t.unit]))))
const publicTask = (dir, P, t) => ({ id: t.id, kind: t.kind, result_path: resultPath(dir, P.call_id, t.worker, t.id), ...(t.unit ? { unit: t.unit } : {}), ...(t.intent ? { intent: t.intent } : {}) })

// claim: 波の行の担当を返す。--wave・--model・--effort・--stage は Workflow script が行の値を埋めた命令で、台帳の波の記録と照らす
// （違えば終了状態 2 で拒み、台帳を変えない。役が返り値の印を書き換えても、空の起動か早い停止になるだけ）。
// - 記録した次の波の最初の claim は波の境目: 今の波の会計を締めてから、次の波を今の波にする。前の波の行の claim は done だけを返す。
// - 順序の門: 波の段・担当の種類（検査の波は検査の段）が、その時の decide と合わなければ、担当を渡さない（その波の出し終えていない担当を手放す）。
// - build の波は、自分の行の出し終えていない担当を全て返す（照合に落ちて出し直す担当も、同じ id で返す）。検査の波は coverage-audit の claim の担当を返す。
// 取る物が無ければ done。波のどの行にも取られていない担当が無くなった時点の done には、次の波（next_wave）か止まる印（halt と reason）を載せる。
// 返す前に結果の path の古いファイルを消す。
function cmdClaim(o) {
  const dir = path.resolve(need(o, 'state'))
  return withWorkerLock(dir, () => {
    const L = load(dir)
    const call = need(o, 'call')
    const worker = need(o, 'worker')
    const wave = need(o, 'wave')
    const got = { model: need(o, 'model'), effort: need(o, 'effort'), stage: need(o, 'stage') }
    const P = L.pending
    const { at, w } = claimRow(P, { call, worker, wave, got })
    // 前の波の行: その波は締めたので、担当を渡さない。
    if (at === 'old') return { ok: true, done: true }
    if (at === 'next') promote(L, P)
    if (!P.claimed_rows.includes(w.id)) P.claimed_rows.push(w.id)
    const cur = P.launched.find((x) => String(x.id) === String(P.wave_id))
    if (cur && !cur.claimed.includes(w.id)) cur.claimed.push(w.id)
    const d = advance(L, dir)
    const gate = !d.stop && (P.step === 'audit' ? d.step === 'audit' && d.phase === P.phase : d.step === P.step && d.task === P.task)
    if (!gate) staleWave(P)
    if (gate && P.step === 'audit') return auditClaim(L, dir, P, w)
    if (gate) {
      P.claims[w.id] = (P.claims[w.id] || 0) + 1
      const ts = claimable(L, P, w)
      for (const t of ts) t.claimed = true
      if (ts.length) {
        save(dir, L)
        const tasks = ts.map((t) => publicTask(dir, P, t))
        for (const t of tasks) { mkdirSync(path.dirname(t.result_path), { recursive: true }); rmSync(t.result_path, { force: true }) }
        return { ok: true, tasks, submit_cmd: submitCmd(dir, P.call_id, w, CLI_PATH) }
      }
    }
    if (!P.done_rows.includes(w.id)) P.done_rows.push(w.id)
    const out = pendingWork(P) ? {} : nextWaveOf(L, dir, P, d)
    save(dir, L)
    return { ok: true, done: true, ...out }
  })
}
// 検査の波の行の claim: coverage-audit の claim を、coverage-audit の呼び出し・行・波で流す。担当があれば submit の命令をこの CLI のものにして返す。
// coverage-audit の done が次の波を持てば、build の次の波として記録する（呼び出しの区切りを先に照らす）。止まる印（halt）なら、build の区切りに当たらなければ
// 検査の呼び出しを閉じ、coverage-audit の next で止まった検査を取り込み、build の次の決定の波へ進む（build の区切りに当たれば halt。検査の呼び出しは ingest が閉じる）。
function auditClaim(L, dir, P, w) {
  const A = P.audit
  const c = audit('claim', ['--state', auditState(dir), '--call', A.call, '--worker', A.ids[w.id], '--wave', String(A.wave), '--model', w.model, '--effort', w.effort, '--stage', auditStageOf(w.stage)], 'claim')
  P.claims += 1
  if (!c.done) { save(dir, L); return { ok: true, tasks: c.tasks, submit_cmd: submitCmd(dir, P.call_id, w, CLI_PATH) } }
  if (!P.done_rows.includes(w.id)) P.done_rows.push(w.id)
  let out = {}
  if (c.next_wave) {
    const lim = callLimit(L, P, c.next_wave.rows.length)
    if (lim) out = { halt: true, reason: lim }
    else {
      const same = P.next && P.next.audit && P.next.audit.call === A.call && String(P.next.audit.wave) === String(c.next_wave.id)
      if (!same) {
        const tags = { ...P.tags }
        const W = auditWaveOf(P, P.phase, A.call, c.next_wave, tags)
        addHints(L, dir, P)
        P.tags = tags
        P.next = { ...W, wave_id: ++L.wave_seq }
      }
      out = { next_wave: { id: P.next.wave_id, rows: P.next.workers } }
    }
  } else if (c.halt) {
    const lim = callLimit(L, P)
    if (lim) out = { halt: true, reason: lim }
    // 検査の台帳が止まる条件に当たった halt（halt_kind が stop）でなければ（検査の起動数・行の数・時間の区切り）、build の呼び出しもここで区切る。
    // 検査の呼び出しは build の ingest が Workflow の起動の記録で閉じ、次の呼び出しの coverage-audit の next が止まる理由（limit など）を返す。
    else if (c.halt_kind !== 'stop') out = { halt: true, reason: `検査（coverage-audit）が区切った: ${c.reason}` }
    else {
      // 検査の呼び出しは、この波で claim した行が全て done を受け取るまで閉じない（兄弟の行の提出を受け付け続ける）。最後の行の done で閉じ、次の決定へ進む。
      const cur = P.launched.find((x) => String(x.id) === String(P.wave_id))
      const waiting = ((cur && cur.claimed) || []).filter((id) => !P.done_rows.includes(id))
      if (!waiting.length) {
        const entry = (P.audit_calls || []).find((x) => x.call === A.call)
        if (entry && !entry.closed) closeStoppedAudit(dir, P, entry)
        out = nextWaveOf(L, dir, P, advance(L, dir))
      }
    }
  }
  save(dir, L)
  return { ok: true, done: true, ...out }
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
// query: 担当が読む入力を台帳から引く（B1）。自分の行の担当だけ。検査の波の行は coverage-audit の query に渡す（--task は複数、--fact も受ける）。
function cmdQuery(o) {
  const dir = path.resolve(need(o, 'state'))
  return withWorkerLock(dir, () => {
    const L = load(dir)
    const w = pendingWorker(L, o)
    const P = L.pending
    const tids = need(o, 'task')
    if (P.step === 'audit') {
      return audit('query', ['--state', auditState(dir), '--call', P.audit.call, '--worker', P.audit.ids[w.id], ...tids.flatMap((x) => ['--task', x]), ...(o.fact || []).flatMap((x) => ['--fact', x])], 'query')
    }
    if (o.fact) throw new Fail('build の担当は --fact を受けない（--fact は検査の役の口）')
    if (tids.length !== 1) throw new Fail(`build の担当は --task を 1 つだけ受ける: ${tids.length} 個`)
    const t = P.tasks.find((x) => x.id === tids[0] && x.worker === w.id)
    if (!t) throw new Fail(`この worker の担当に無い: ${tids[0]}`)
    const inputs = inputsOf(L, dir, P, t)
    if (!t.touched) { t.touched = true; save(dir, L) }
    return { ok: true, task: t.id, kind: t.kind, inputs }
  })
}

// submit: その worker の、取って出し終えていない担当のうち、結果の path にファイルがある担当を照らす（無い担当は missing）。
// 照合に落ちた提出は理由を返して試行に数え（ok: false）、取ったままにして同じ体が出し直せるようにする。上限に達したら諦める（dropped: true）。
// 検査の波の行は coverage-audit の submit に渡し、判定の数だけ build の波の提出に数える（呼び出しの進みの判定に使う）。
function cmdSubmit(o) {
  const dir = path.resolve(need(o, 'state'))
  return withWorkerLock(dir, () => {
    const L = load(dir)
    const w = pendingWorker(L, o)
    const P = L.pending
    if (P.step === 'audit') {
      const s = audit('submit', ['--state', auditState(dir), '--call', P.audit.call, '--worker', P.audit.ids[w.id]], 'submit')
      const rs = Array.isArray(s.results) ? s.results : []
      if (rs.length) { P.submits += rs.length; P.accepted += rs.filter((x) => x.ok).length; save(dir, L) }
      return s
    }
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
      const problems = submitTask(L, t, rep, { inputs: archInputs(L, dir), readText: reader(L, dir), readable: premisePaths(L), looks: readableOf(L, dir), after, outside, fresh: (rel) => freshFile(L, P, rel), isDir: (rel) => isDirIn(L, rel), before: Object.fromEntries(Object.entries(P.before || {}).filter(([f]) => f.startsWith(L.repo + path.sep)).map(([f, h]) => [path.relative(L.repo, f), h])) })
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
    audit_phases: L.audit_phases, skipped_audits: skippedAudits(L), audit_halt: L.audit_halt || null,
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

// answer: 目標・受け入れ基準・制約・決定の記録はファイルの中身を置き換え、引用と path を照らし直してから目標の照合をやり直す。
// それ以外の id への回答は、利用者の言葉として決定の記録に足し、その行を引用する制約にして方式設計からやり直す。dismiss は記録だけ。
// 検査が利用者に返した id（検査の止まった記録 audit_halt の ids）への answer は、coverage-audit の台帳の answer に渡す。
const GOAL_FILES = { goal: 'goal', criteria: 'criteria', constraints: 'constraints', decisions: 'decisions' }
const itemsText = (xs) => xs.map((c) => `- ${c.id}: ${c.text}${c.cites.map((q) => ` 〔${q.source}: ${q.quote}〕`).join('')}`).join('\n')
// 回答から作る制約の id: 目標・基準・制約の id に無い最小の A<n>（利用者が書いた A<n> や、coverage-build から渡った A<n> と重ねない）。
const freeAnswerId = (ids) => { let n = 1; while (ids.includes(`A${n}`)) n++; return `A${n}` }
function cmdAnswer(o, dismiss = false) {
  const dir = path.resolve(need(o, 'state'))
  return withLock(dir, () => answer(dir, o, dismiss))
}
function answer(dir, o, dismiss) {
  const L = load(dir)
  const id = need(o, 'id')
  if (id in GOAL_FILES) {
    if (dismiss) throw new Fail(`${id} は dismiss できない`)
    const body = o.file ? read(o.file) : need(o, 'text')
    const text = { goal: L.goal.text, request: L.request, decisions: L.decisions, criteria: itemsText(L.criteria), constraints: itemsText(L.constraints), [id]: id === 'goal' || id === 'decisions' ? body.trim() : body }
    const g = readGoalFiles(text)
    const pp = framePathProblems(g, { repo: L.repo, targets: L.targets, contexts: L.inputs })
    if (g.problems.length || pp.length) throw new Fail(`直した ${id} が引用か path の照合を通らない（台帳は変えていない）`, { problems: [...g.problems, ...pp] })
    Object.assign(L, { goal: { text: text.goal, items: g.goal, checked: false, problems: [] }, decisions: text.decisions, criteria: g.criteria, constraints: g.constraints, need_arch: L.mode !== 'review' })
    delete L.attempts.goal
    for (const p of ['design', 'impl', 'review']) delete L.audits[p] // 照らす目標・基準が変わったので、中身が同じでもレビューをやり直す
    save(dir, L)
    return { ok: true, next: '目標の照合からやり直す。next を流す' }
  }
  const text = need(o, 'text')
  if (L.audit_halt && (L.audit_halt.ids || []).includes(id)) {
    if (dismiss) throw new Fail(`${id} は検査（coverage-audit）が返した id なので dismiss できない。answer で答える`)
    const r = audit('answer', ['--state', auditState(dir), '--id', id, '--text', text], 'answer')
    L.answers.push({ id: `audit:${id}`, text, dismiss: false })
    L.audit_halt = null
    save(dir, L)
    return { ...r, ok: true, audit: true, next: '検査を続ける。next を流す' }
  }
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
  const auditConfig = posInts(o, AUDIT_LIMIT_KEYS)
  const phases = auditPhasesOf(o)
  return withLock(dir, () => {
    const L = load(dir)
    Object.assign(L.config, config)
    if (phases) L.audit_phases = phases
    L.audit_config = { ...(L.audit_config || {}), ...auditConfig }
    // 検査の台帳が既にあれば今渡す（無ければ、init の後に ensureFrame が渡す）。
    if (Object.keys(auditConfig).length) applyAuditConfig(L, dir)
    save(dir, L)
    return { ok: true, config: L.config, audit_config: L.audit_config, audit_phases: L.audit_phases, skipped_audits: skippedAudits(L) }
  })
}

export function main(argv) {
  try {
    const o = parse(argv)
    const cmd = o._[0]
    const f = { init: cmdInit, next: cmdNext, ingest: cmdIngest, 'run-checks': cmdRunChecks, status: cmdStatus, hint: cmdHint, answer: (x) => cmdAnswer(x), dismiss: (x) => cmdAnswer(x, true), config: cmdConfig, claim: cmdClaim, query: cmdQuery, submit: cmdSubmit }[cmd]
    if (!f) throw new Fail(`使い方: build-cli.mjs <${Object.keys(KNOWN).join('|')}> --state DIR ...（未知のコマンド: ${cmd}）`)
    return { code: 0, output: f(o) }
  } catch (e) {
    if (e instanceof Fail) return { code: e.extra && e.extra.busy ? 3 : 2, output: { ok: false, error: e.message, ...e.extra } }
    return { code: 1, output: { ok: false, error: String((e && e.stack) || e) } }
  }
}

// 入口（この CLI を直接流すときと、stateDir の入口 build-cli.mjs から流すとき）。
export function runMain(argv) {
  const r = main(argv)
  process.stdout.write(`${JSON.stringify(r.output, null, 1)}\n`)
  process.exitCode = r.code
}

// symlink 経由（.claude/skills -> .agents/skills）で流しても一致させる。import.meta.url は実体の path になる。
if (process.argv[1] && realpathSync(path.resolve(process.argv[1])) === fileURLToPath(import.meta.url)) runMain(process.argv.slice(2))
