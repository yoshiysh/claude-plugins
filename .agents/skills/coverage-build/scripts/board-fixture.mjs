// coverage-build の自分の Workflow を台帳（ブラックボード）の形にする設計のテストの道具
// （docs/design/coverage-ledger-method.md「台帳と見たの記録」の B1〜B6 と「coverage-build の自分の Workflow にも当てる」、
// 「モデルと費用」の起動の原則、計画 glimmering-squishing-moonbeam の「決めること」9〜12）。
// blackboard.test.mjs だけが使う。test-harness.mjs（返り値と args で内容を運ぶ形の道具。読み込むと今の Workflow source を compile する）には依存せず、
// setup・auditStatus・writeAuditStatus はそこから写す（source の形が変わっても、このファイルの読み込みで落ちないようにするため）。
// coverage-audit の blackboard-fixture.mjs と同じ形を写す（2 つのスキルは互いのファイルを読まないので import しない）。
//
// ここで固定する下の層の決定（変えるときはこのファイルを直す）:
// - 役の名前は今の roles.json の key のまま: goal_checker・architect・unit_designer・test_writer・implementer・retro_planner・retro_examiner・retro_verifier。
//   起動の数え方と結果の形は役で引く。args.stage の値と、担当の種類の名前（task.kind）は固定しない（不透明な文字列として扱う）。
// - Workflow source は next の出力の workflow の path をそのまま使う（段と source の対応は固定しない）。
// - args = { state, callId, stage, workers }。workers の行は { id, role, model, effort }（model・effort は台帳の役の値。既定は roles.json）。
//   script は行ごとに 1 体を起動する（行の数と役が、その呼び出しの起動のすべて）。
// - 返り値 = { agents, tokens }。agents の要素は { role, label, model, effort, ok }。
// - 役の prompt は、build-cli.mjs の claim の命令の行（`… build-cli.mjs claim --state S --call C --worker W`）を含む。CLI の置き場の path は固定しない。
// - claim  --state S --call C --worker W            → { ok, done: true } | { ok, tasks: [{ id, result_path, ... }], submit_cmd }
//   submit_cmd は `… build-cli.mjs submit --state S --call C --worker W` の形の命令（この道具は submit から後の語を流す）。
// - query  --state S --call C --worker W --task T   → { ok, inputs }。inputs は役ごとに次の欄を持つ（前の役の出力は台帳からここに出る）:
//     goal_checker:  request（依頼文）・decisions（決定の記録か null）・item_ids（目標・基準・制約の項目の id）
//     architect:     input_paths（読む入力の絶対 path）・cover_ids（covers に使う id）
//     unit_designer: unit（方式設計が決めた受け持ちの単位 { id, kind, title, responsibility, paths, tests, depends_on, covers, ... }）・rows（境界の行 id）
//     test_writer・implementer: unit（同じ）・paths（書いてよい repo からの相対 path）・repo（repo の絶対 path）
//     retro_planner:  events（悪かった出来事 [{ id, ... }]）・readable（look_at と evidence に使える絶対 path）
//     retro_examiner: intent（計画役の意図 { id, basis, hypothesis, layer, look_at }）
//     retro_verifier: intent（同じ）・exam（実行役の結論 { verdict, cause, layer, evidence }）
// - submit --state S --call C --worker W            → { ok, results: [{ task, ok, problems, dropped }], missing }
//   照合に落ちた担当は ok: false と理由（problems）。同じ体が result_path を書き直して同じ submit_cmd を流し直せる。
//   試行の上限（build-core.mjs の MAX_ATTEMPTS）に達した担当は dropped: true。
// - ingest --state S --call C --result F（F は返り値 { agents, tokens }）。呼び出しを閉じるだけ。閉じた呼び出しへの claim は終了状態 2。
// - 役の結果（result_path に書く JSON）は、今の Workflow の返り値の形のまま submit に移す:
//     goal_checker は GOAL_SCHEMA、architect は ARCH_SCHEMA、unit_designer は SPEC_SCHEMA（担当ごとに 1 単位）、
//     test_writer・implementer は { unit_id, written, notes, unresolved }（担当ごとに 1 単位）、
//     retro_planner は INTENTS_SCHEMA、retro_examiner は EXAM_SCHEMA（担当ごとに意図 1 件）、retro_verifier は JUDGE_SCHEMA（担当ごとに意図 1 件）。
//
// 今の実装（claim が無い・ingest が --call を受けない）でも道具は throw せず、止まった出力（stop）を返す。テストが assertion で落ちるようにするため。
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { main } from './build-cli.mjs'

export const HERE = path.dirname(fileURLToPath(import.meta.url))
export const ROLES = JSON.parse(readFileSync(path.join(HERE, 'roles.json'), 'utf8'))
// 段（起動の数を数える括り）と、その段の役。
export const STAGE_ROLES = {
  design: ['goal_checker', 'architect', 'unit_designer'],
  tests: ['test_writer'],
  implement: ['implementer'],
  retro: ['retro_planner', 'retro_examiner', 'retro_verifier'],
}
export const ALL_ROLES = Object.values(STAGE_ROLES).flat()
export const stageOfRole = (role) => Object.keys(STAGE_ROLES).find((s) => STAGE_ROLES[s].includes(role)) || null

const arr = (a) => (Array.isArray(a) ? a : [])
let SEQ = 0
const tick = () => ++SEQ

export function cli(...argv) {
  const r = main(argv)
  return { code: r.code, ...r.output }
}
// shell の語に分ける（'…' と "…" と \ の escape だけ）。
export function shellWords(line) {
  const out = []
  let cur = null
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (/\s/.test(ch)) { if (cur !== null) { out.push(cur); cur = null } continue }
    cur = cur ?? ''
    if (ch === "'") { const j = line.indexOf("'", i + 1); cur += line.slice(i + 1, j < 0 ? line.length : j); i = j < 0 ? line.length : j; continue }
    if (ch === '"') { for (i++; i < line.length && line[i] !== '"'; i++) cur += line[i] === '\\' && i + 1 < line.length ? line[++i] : line[i]; continue }
    if (ch === '\\' && i + 1 < line.length) { cur += line[++i]; continue }
    cur += ch
  }
  if (cur !== null) out.push(cur)
  return out
}
// 文の中の build-cli.mjs の命令から、コマンド名と --引数の組を読む（無ければ null）。
export function cliArgvOf(text, cmd) {
  for (const line of String(text).split('\n')) {
    if (!line.includes('build-cli.mjs')) continue
    const w = shellWords(line.replace(/`/g, ' '))
    const i = w.indexOf(cmd)
    if (i < 0) continue
    const out = [cmd]
    for (let j = i + 1; j + 1 < w.length && w[j].startsWith('--'); j += 2) out.push(w[j], w[j + 1])
    return out
  }
  return null
}
export const argOf = (argv, k) => (argv && argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : undefined)

// ---------------- 対象と偽の coverage-audit（test-harness.mjs の setup・auditStatus・writeAuditStatus の写し） ----------------
export function tmp(t) {
  const d = mkdtempSync(path.join(tmpdir(), 'coverage-build-board-'))
  t.after(() => rmSync(d, { recursive: true, force: true }))
  return d
}
// 小さな repo と依頼を用意して init する。
export function setup(t, { mode = 'create', checks = [], extra = [] } = {}) {
  const d = tmp(t)
  const repo = path.join(d, 'repo')
  mkdirSync(path.join(repo, 'src'), { recursive: true })
  writeFileSync(path.join(repo, 'src', 'old.mjs'), 'export const old = 1 // 既にあるファイルの本文の行\n')
  writeFileSync(path.join(d, 'request.md'), '値を計算する関数を作り、使い方を書いてほしい')
  writeFileSync(path.join(d, 'decisions.md'), '- 入力が 1 なら 2 を返す\n- 依存を足さない\n')
  writeFileSync(path.join(d, 'goal.md'), '- G1: 値を計算する関数と、その使い方の文書 〔request: 値を計算する関数を作り、使い方を書いてほしい〕\n')
  writeFileSync(path.join(d, 'criteria.md'), '- AC1: 入力が 1 なら 2 を返す 〔decisions: 入力が 1 なら 2 を返す〕\n')
  writeFileSync(path.join(d, 'constraints.md'), '- D1: 依存を足さない 〔decisions: 依存を足さない〕\n')
  writeFileSync(path.join(d, 'material.md'), '# 材料\n\n材料の本文の行。値は入力に 1 を足して返す。\n')
  const state = path.join(d, 'state')
  const argv = ['init', '--state', state, '--mode', mode, '--repo', repo, '--goal', path.join(d, 'goal.md'), '--request', path.join(d, 'request.md'),
    '--decisions', path.join(d, 'decisions.md'), '--criteria', path.join(d, 'criteria.md'), '--constraints', path.join(d, 'constraints.md'), '--input', path.join(d, 'material.md'),
    ...(mode === 'create' ? [] : ['--target', path.join(repo, 'src', 'old.mjs')]), ...checks.flatMap((c) => ['--check', JSON.stringify(c)]), ...extra]
  const r = cli(...argv)
  if (r.code !== 0) throw new Error(JSON.stringify(r))
  return { d, repo, state }
}
// coverage-audit が止まったときに書く status-<段>.json の中身の偽物（指摘は無く、events だけを足せる）。
export function auditStatus({ phase, events = [], stop = 'complete' } = {}) {
  const section = { findings: { confirmed: [], unverifiable: [] }, groups: [], events }
  return { phase, stopped: { stop }, pending: null, coverage: { units: 1, seen: 1, disclosed: [], pending: [] }, skip: [], references: [], undecided: [], ...section, phases: { [phase]: section } }
}
export function writeAuditStatus(auditState, phase, status) {
  mkdirSync(auditState, { recursive: true })
  writeFileSync(path.join(auditState, `status-${phase}.json`), JSON.stringify(status))
}

// ---------------- 役の既定の結果 ----------------
// 引用に使える行（14 字以上で見出しでない行）。
export const quoteOf = (file) => {
  const t = readFileSync(file, 'utf8')
  return t.split('\n').find((l) => l.trim().length >= 14 && !/^#/.test(l.trim())) || t.trim()
}
// 方式設計の単位の組。cover は covers に使う id。
export const UNIT_SETS = {
  // code 2・doc 1、依存なし（小さい対象。どの段も 1 体で足りる）。
  three: (cover) => [
    { id: 'U1', kind: 'code', title: '計算', responsibility: '値を計算する', paths: ['src/a.mjs'], tests: ['test/a.test.mjs'], test_uses: [], depends_on: [], covers: cover },
    { id: 'U2', kind: 'code', title: '整形', responsibility: '値を整形する', paths: ['src/b.mjs'], tests: ['test/b.test.mjs'], test_uses: [], depends_on: [], covers: cover },
    { id: 'U3', kind: 'doc', title: '説明', responsibility: '使い方を書く', paths: ['docs/a.md'], tests: [], test_uses: [], depends_on: [], covers: cover },
  ],
  // U2（doc）が U1（code）に依存する。
  chain: (cover) => [
    { id: 'U1', kind: 'code', title: '計算', responsibility: '値を計算する', paths: ['src/a.mjs'], tests: ['test/a.test.mjs'], test_uses: [], depends_on: [], covers: cover },
    { id: 'U2', kind: 'doc', title: '説明', responsibility: '使い方を書く', paths: ['docs/a.md'], tests: [], test_uses: [], depends_on: ['U1'], covers: cover },
  ],
}
export const goalResult = (q) => ({ outcomes: [{ outcome: '依頼の全体', quotes: [{ source: 'request', quote: q.request }], items: q.item_ids }] })
export const archResult = (q, { units = 'three', patch = (us) => us } = {}) => ({
  units: patch(UNIT_SETS[units](arr(q.cover_ids))),
  inputs_read: arr(q.input_paths).map((p) => ({ path: p, quotes: [quoteOf(p)] })),
  inputs_not_read: [], questions: [], contracts: [], copies: [],
})
export const specResult = (q) => ({
  unit_id: q.unit.id, spec: '入力を受け取り、決まった値を返す。', acceptance: ['値を返す'],
  behaviors: [{ text: '値を返す', accepts: [1], rows: arr(q.rows) }], partitions: [], premises: [], unverified: [], allowed_optional: [],
  cases: [{ condition: '入力が 1', expect: '2 を返す', accepts: [1], covers: [] }],
})
export function writeResult(q, role) {
  for (const p of q.paths) {
    const f = path.join(q.repo, p)
    mkdirSync(path.dirname(f), { recursive: true })
    writeFileSync(f, `// ${role} ${p}\nexport const value = 2 // ${role} が書いた本文の行\n`)
  }
  return { unit_id: q.unit.id, written: q.paths, notes: '', unresolved: [] }
}
// look_at に使う読めるファイル（実装のファイル src/a.mjs を優先し、無ければ引用できる行のある最初のもの）。
export const pickReadable = (readable) => arr(readable).find((p) => /src[\\/]a\.mjs$/.test(p) && existsSync(p)) || arr(readable).find((p) => existsSync(p) && /\.(mjs|md)$/.test(p))
export const planResult = (q, { n = 1, hypothesis = (i) => `進め方の仮説 ${i + 1}` } = {}) => ({
  intents: arr(q.events).length ? Array.from({ length: n }, (_, i) => ({ basis: [q.events[0].id], hypothesis: hypothesis(i), layer: '進め方', look_at: [pickReadable(q.readable)] })) : [],
})
export function examResult(q, { verdict = 'supported', cause = '進め方の原因' } = {}) {
  if (verdict !== 'supported') return { verdict, cause: '', layer: '実装', evidence: [] }
  const f = q.intent.look_at[0]
  return { verdict, cause, layer: '進め方', evidence: [{ path: f, quote: quoteOf(f) }] }
}
export const judgeResult = () => ({ accept: true, reason: '記録が支える' })

// 役の偽物。over[role](inputs, task, ctx) が undefined 以外を返せば、それを結果にする（null は書かない）。ctx.attempt はその担当を書く何回目か（1 から）、ctx.problems は前の submit の理由。
// over.arch・over.plan・over.exam は既定の結果の options（archResult・planResult・examResult）。
export function act(over = {}) {
  return async (role, task, ctx) => {
    const q = ctx.inputs()
    if (over[role]) { const r = over[role](q, task, ctx); if (r !== undefined) return r }
    if (role === 'goal_checker') return goalResult(q)
    if (role === 'architect') return archResult(q, over.arch)
    if (role === 'unit_designer') return specResult(q)
    if (role === 'test_writer' || role === 'implementer') return writeResult(q, role)
    if (role === 'retro_planner') return planResult(q, over.plan)
    if (role === 'retro_examiner') return examResult(q, typeof over.exam === 'function' ? over.exam(q) : over.exam)
    if (role === 'retro_verifier') return judgeResult(q)
    return null
  }
}

// 1 体の worker: claim が done を返すまで、取った担当の結果を書いて submit_cmd を流す。照合に落ちた担当は、同じ体が書き直して出し直す。
// 記録 rec = { call, worker, role, claims, queries, submits, errors }。各記録は通しの番号 seq を持つ（呼び出しをまたいで順を比べる）。
export async function workerLoop({ state, call, worker, role }, a, exec = cli) {
  const rec = { call, worker, role, claims: [], queries: [], submits: [], errors: [] }
  const tries = {}
  const problems = {}
  for (let guard = 0; guard < 40; guard++) {
    const c = exec('claim', '--state', state, '--call', call, '--worker', worker)
    rec.claims.push({ seq: tick(), out: c })
    if (c.code !== 0 || c.done || !Array.isArray(c.tasks) || !c.tasks.length) break
    let wrote = 0
    for (const task of c.tasks) {
      tries[task.id] = (tries[task.id] || 0) + 1
      const ctx = {
        attempt: tries[task.id], problems: problems[task.id] || [],
        inputs: () => {
          const q = exec('query', '--state', state, '--call', call, '--worker', worker, '--task', task.id)
          rec.queries.push({ seq: tick(), task: task.id, out: q })
          return (q.code === 0 && q.inputs) || {}
        },
      }
      let r = null
      try { r = await a(role, task, ctx) } catch (e) { rec.errors.push(`${task.id}: 役の偽物が結果を作れない（${String((e && e.message) || e).slice(0, 200)}）`) }
      if (r == null || !task.result_path) continue
      mkdirSync(path.dirname(task.result_path), { recursive: true })
      writeFileSync(task.result_path, JSON.stringify(r))
      wrote++
    }
    if (!wrote) break
    const words = shellWords(String(c.submit_cmd || ''))
    const i = words.indexOf('submit')
    if (i < 0) { rec.errors.push(`claim の出力に submit の命令が無い: ${c.submit_cmd}`); break }
    const s = exec(...words.slice(i))
    rec.submits.push({ seq: tick(), tasks: c.tasks.map((x) => x.id), out: s })
    if (s.code !== 0) break
    for (const x of arr(s.results)) if (x && !x.ok) problems[x.task] = arr(x.problems)
  }
  return rec
}

// 本物の Workflow source を native と同じ注入で走らせる（source は next の出力の workflow）。throw は返り値 { error } にする。
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor
const bodies = new Map()
export async function runScript(file, args, agentFn, { budget } = {}) {
  try {
    if (!bodies.has(file)) bodies.set(file, new AsyncFunction('agent', 'parallel', 'pipeline', 'phase', 'log', 'args', 'budget', readFileSync(file, 'utf8').replace(/^export const meta = /, 'const meta = ')))
    const parallel = (ts) => Promise.all(ts.map((t) => Promise.resolve().then(t).catch(() => null)))
    const pipeline = (items, fn) => Promise.all(items.map((x, i) => Promise.resolve().then(() => fn(x, i)).catch(() => null)))
    return await bodies.get(file)(agentFn, parallel, pipeline, () => {}, () => {}, args, budget)
  } catch (e) {
    return { error: String((e && e.message) || e) }
  }
}

// next → Workflow source（役は prompt の claim の命令で台帳と読み書きする）/ 偽の coverage-audit / run-checks → ingest --call を止まるまで回す。
// audit(phase, out) は coverage-audit の status を返す。返すのは { stop, steps, launches }。
// steps の要素は { step, next, args, argsText, res, ingest, launches }（audit・checks の段は { step, phase, ingest }）。
// launches は起動した 1 体ごとの { label, model, effort, prompt, claim, call, worker, role, stage, rec, error }。
export async function driveScript(state, a, { audit = (phase) => auditStatus({ phase }), maxSteps = 40 } = {}) {
  const steps = []
  const launches = []
  const roles = new Map()
  const agentFn = async (prompt, opts) => {
    const claim = cliArgvOf(prompt, 'claim')
    const call = argOf(claim, 'call')
    const worker = argOf(claim, 'worker')
    const role = claim ? roles.get(`${call}\0${worker}`) || null : null
    const entry = { label: opts && opts.label, model: opts && opts.model, effort: opts && opts.effort, prompt, claim, call, worker, role, stage: stageOfRole(role), rec: null, error: null }
    launches.push(entry)
    if (!claim) { entry.error = `役の prompt に build-cli.mjs claim の命令が無い: ${entry.label}`; return { notes: [] } }
    entry.rec = await workerLoop({ state: argOf(claim, 'state'), call, worker, role }, a)
    return { notes: [] }
  }
  for (let i = 0; i < maxSteps; i++) {
    const n = cli('next', '--state', state)
    if (n.code !== 0 || n.stop) return { stop: n, steps, launches }
    if (n.step === 'audit') {
      writeAuditStatus(n.audit.state, n.phase, await audit(n.phase, n))
      const g = cli('import-audit', '--state', state)
      steps.push({ step: 'audit', phase: n.phase, ingest: g })
      if (g.code !== 0) return { stop: g, steps, launches }
      continue
    }
    if (n.step === 'checks') {
      const g = cli('run-checks', '--state', state)
      steps.push({ step: 'checks', ingest: g })
      if (g.code !== 0) return { stop: g, steps, launches }
      continue
    }
    const argsText = readFileSync(n.args_path, 'utf8')
    const args = JSON.parse(argsText)
    for (const w of arr(args.workers)) roles.set(`${args.callId}\0${w.id}`, w.role)
    const from = launches.length
    const res = await runScript(n.workflow, args, agentFn)
    const f = path.join(state, `result-${args.callId || n.call_id}.json`)
    writeFileSync(f, JSON.stringify(res ?? null))
    const g = cli('ingest', '--state', state, '--call', String(args.callId || n.call_id), '--result', f)
    steps.push({ step: n.step, next: n, args, argsText, res, ingest: g, launches: launches.slice(from) })
    if (g.code !== 0) return { stop: g, steps, launches }
  }
  return { stop: null, steps, launches }
}

// ---------------- 記録の読み方 ----------------
// 役ごとの起動数。
export const roleCounts = (launches) => launches.reduce((m, x) => ({ ...m, [x.role || '(役なし)']: (m[x.role || '(役なし)'] || 0) + 1 }), {})
// 起動 1 体が取った担当（claim の tasks を平らに）。各担当に、query が返した受け持ちの単位の id を付ける。
export function tasksOf(launch) {
  const rec = launch.rec
  if (!rec) return []
  const unitOf = (id) => { const q = rec.queries.find((x) => x.task === id && x.out && x.out.inputs); return q ? (q.out.inputs.unit && q.out.inputs.unit.id) || null : null }
  const seen = new Map()
  for (const c of rec.claims) for (const t of arr(c.out && c.out.tasks)) if (!seen.has(t.id)) seen.set(t.id, { id: t.id, seq: c.seq, unit: unitOf(t.id) })
  return [...seen.values()]
}
// 担当の submit の判定を順に（{ seq, ok, problems, dropped }）。
export const verdictsOf = (launch, taskId) => (launch.rec ? launch.rec.submits.flatMap((s) => arr(s.out && s.out.results).filter((r) => r && r.task === taskId).map((r) => ({ seq: s.seq, ok: !!r.ok, problems: arr(r.problems), dropped: !!r.dropped }))) : [])
// 単位 unit の担当を role の起動が初めて受け取った claim の seq と、その担当が初めて受理された submit の seq。
export function unitEvents(launches, role, unit) {
  let claimed = null
  let accepted = null
  for (const l of launches.filter((x) => x.role === role)) {
    for (const t of tasksOf(l).filter((x) => x.unit === unit)) {
      if (claimed === null || t.seq < claimed) claimed = t.seq
      const ok = verdictsOf(l, t.id).find((v) => v.ok)
      if (ok && (accepted === null || ok.seq < accepted)) accepted = ok.seq
    }
  }
  return { claimed, accepted }
}
// 一度だけ（最初の impl の検査で）coverage-audit の出来事を 1 件返す偽の coverage-audit。振り返りを起こすが、層を持たないので戻しは進め方（やり直しの周を増やさない）。
export function auditWithEvent(text = 'coverage-audit の読む役の提出が一度拒まれた') {
  let n = 0
  return (phase) => (phase === 'impl' && n++ === 0
    ? auditStatus({ phase, events: [{ id: 'AE1', stage: 'file', kind: 'rejected', text }] })
    : auditStatus({ phase }))
}
