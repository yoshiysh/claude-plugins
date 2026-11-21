// テストの道具: 本物の Workflow source（build-step.js）を native と同じ注入で走らせ、役は担当を claim し、query の入力から結果を作って submit する偽物にする。
// blackboard.test.mjs は自分の道具（board-fixture.mjs）を使う。ここはそれ以外のテストが使う（役の差し替えの鍵は前の形のまま: goal-check・architect・design-U1 など）。
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { C } from './build-core.mjs'
import { main } from './build-cli.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const SOURCE = path.join(HERE, 'build-step.js')
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor
const body = new AsyncFunction('agent', 'parallel', 'pipeline', 'phase', 'log', 'args', 'budget', readFileSync(SOURCE, 'utf8').replace(/^export const meta = /, 'const meta = '))
const arr = (a) => (Array.isArray(a) ? a : [])

export function tmp(t) {
  const d = mkdtempSync(path.join(tmpdir(), 'coverage-build-'))
  t.after(() => rmSync(d, { recursive: true, force: true }))
  return d
}
export function cli(...argv) {
  const r = main(argv)
  return { code: r.code, ...r.output }
}
const firstLine = (f) => readFileSync(f, 'utf8').split('\n').find((l) => l.trim().length >= 14) || readFileSync(f, 'utf8').trim()
export const quoteOf = firstLine

// 既定の方式設計: code の単位 U1 と、それに依存する doc の単位 U2。
export const defaultUnits = (cover) => [
  { id: 'U1', kind: 'code', title: '計算', responsibility: '値を計算する', paths: ['src/a.mjs'], tests: ['test/a.test.mjs'], test_uses: [], depends_on: [], covers: cover },
  { id: 'U2', kind: 'doc', title: '説明', responsibility: '使い方を書く', paths: ['docs/a.md'], tests: [], test_uses: [], depends_on: ['U1'], covers: cover },
]
// 既定の方式設計の返り値（query の inputs から作る）。
export const archOf = (q, units = defaultUnits(arr(q.cover_ids))) => ({ units, inputs_read: arr(q.input_paths).map((p) => ({ path: p, quotes: [firstLine(p)] })), inputs_not_read: [], questions: [], contracts: [], copies: [] })

// 役の既定の結果。q は query の inputs。
export function defaultResult(role, q) {
  if (role === 'goal_checker') return { outcomes: [{ outcome: '依頼の全体', quotes: [{ source: 'request', quote: q.request }], items: q.item_ids }] }
  if (role === 'architect') return archOf(q)
  if (role === 'unit_designer') return { unit_id: q.unit.id, spec: '入力を受け取り、決まった値を返す。', acceptance: ['値を返す'], behaviors: [{ text: '値を返す', accepts: [1], rows: [] }], partitions: [], premises: [], unverified: [], allowed_optional: [], cases: [{ condition: '入力が 1', expect: '2 を返す', accepts: [1], covers: [] }] }
  if (role === 'test_writer' || role === 'implementer') {
    const head = role === 'test_writer' ? 'tests' : 'implement'
    for (const p of q.paths) { mkdirSync(path.dirname(path.join(q.repo, p)), { recursive: true }); writeFileSync(path.join(q.repo, p), `// ${head} ${p}\nexport const value = 2\n`) }
    return { unit_id: q.unit.id, written: q.paths, notes: '', unresolved: [] }
  }
  if (role === 'retro_planner') return { intents: [] }
  if (role === 'retro_examiner') return { verdict: 'unclear', cause: '', layer: '実装', evidence: [] }
  if (role === 'retro_verifier') return { accept: true, reason: '記録が支える' }
  throw new Error(`想定しない役: ${role}`)
}
// 担当の差し替えの鍵（前の形の label の頭）。先の鍵ほど細かい。意図の担当は、計画役が出した巡の中の位置で数える（retro-exam-0 が巡の最初の意図）。
function keysOf(role, q, state) {
  if (role === 'goal_checker') return ['goal-check']
  if (role === 'architect') return ['architect']
  if (role === 'unit_designer') return [`design-${q.unit.id}`, 'design']
  if (role === 'test_writer') return [`tests-${q.unit.id}`, 'tests']
  if (role === 'implementer') return [`implement-${q.unit.id}`, 'implement']
  if (role === 'retro_planner') return ['retro-plan']
  const L = JSON.parse(readFileSync(path.join(state, 'build.json'), 'utf8'))
  const it = L.intents.find((x) => x.id === q.intent.id)
  const i = L.intents.filter((x) => x.cycle === it.cycle && x.round === it.round).findIndex((x) => x.id === it.id)
  return role === 'retro_examiner' ? [`retro-exam-${i}`, 'retro-exam'] : [`retro-judge-${i}`, 'retro-judge']
}

const words = (line) => [...line.matchAll(/'((?:[^']|'\\'')*)'|(\S+)/g)].map((m) => (m[1] !== undefined ? m[1].replace(/'\\''/g, "'") : m[2]))
const claimArgv = (prompt) => {
  const line = String(prompt).split('\n').find((l) => l.includes('build-cli.mjs') && /\sclaim\s/.test(l))
  if (!line) return null
  const w = words(line)
  return w.slice(w.indexOf('claim'))
}
const opt = (argv, k) => argv[argv.indexOf(`--${k}`) + 1]

// 役の偽物（Workflow の agent に渡す）。prompt の claim の命令で担当を取り、担当ごとに query の入力から結果を作り、result_path に書いて submit を流す。
// 照合に落ちた担当は、同じ体が作り直して出し直す。over[鍵](prompt, opts, log) が undefined 以外を返せばそれを結果にし、null なら結果を書かない（欠測）。
// opts は { label（鍵）, role, model, effort, schema（役の結果の形）, inputs（query の inputs）, task, attempt（その担当を書く何回目か）, problems（前の submit の理由） }。
// log には担当ごとに { label, role, model, effort, prompt, inputs, task } を足す。
export function mockAgent(over = {}, log = []) {
  return async (prompt, opts) => {
    const argv = claimArgv(prompt)
    if (!argv) throw new Error(`役の prompt に claim の命令が無い: ${opts && opts.label}`)
    const state = opt(argv, 'state')
    const role = String(opts.label).replace(/-[^-]+$/, '')
    const tries = {}
    const problems = {}
    for (let guard = 0; guard < 40; guard++) {
      const c = cli(...argv)
      if (c.code !== 0 || c.done || !arr(c.tasks).length) break
      let wrote = 0
      for (const task of c.tasks) {
        tries[task.id] = (tries[task.id] || 0) + 1
        const q = cli('query', ...argv.slice(1), '--task', task.id)
        const inputs = q.inputs || {}
        const keys = keysOf(role, { ...inputs, intent: inputs.intent }, state)
        log.push({ label: keys[0], role, model: opts.model, effort: opts.effort, prompt, inputs, task })
        const o = { label: keys[0], role, model: opts.model, effort: opts.effort, schema: C.RESULT_SCHEMAS[role], inputs, task, attempt: tries[task.id], problems: problems[task.id] || [] }
        let r
        for (const k of keys) if (over[k]) { r = over[k](prompt, o, log); if (r !== undefined) break }
        if (r === undefined) r = defaultResult(role, inputs)
        if (r === null) continue
        mkdirSync(path.dirname(task.result_path), { recursive: true })
        writeFileSync(task.result_path, JSON.stringify(r))
        wrote++
      }
      if (!wrote) break
      const w = words(c.submit_cmd)
      const s = cli(...w.slice(w.indexOf('submit')))
      if (s.code !== 0) break
      for (const x of arr(s.results)) if (!x.ok) problems[x.task] = x.problems
    }
    return { notes: [] }
  }
}

// budget: native が注入する消費量の計器（spent() を持つ）。省略は注入しない経路（runner など）。
export async function runWorkflow(args, agentFn, { budget } = {}) {
  const parallel = (ts) => Promise.all(ts.map((t) => Promise.resolve().then(t).catch(() => null)))
  const pipeline = (items, fn) => Promise.all(items.map((x, i) => Promise.resolve().then(() => fn(x, i)).catch(() => null)))
  return body(agentFn, parallel, pipeline, () => {}, () => {}, args, budget)
}

// coverage-audit の status の偽物（coverage-audit が止まったときに書く status-<段>.json の中身と同じ形）。confirmed は [{path, quote, layer, claim}]。
// phase はその検査の段（coverage-audit の台帳が記録する段）。指摘は path（paths）・義務・確信度・原因の層・出どころを持ち、id は事実の id（F<hex>）。
// skip は見られなかった単位の id、pending は読み終えていない単位の id。今の段の節（findings・groups・events）を上の階層と phases[phase] の両方に置き、
// others で前の段の節（phase_records の写し）を足せる。references は参考、undecided は試行の上限で判定できずに閉じた意図。
export function auditStatus({ phase, confirmed = [], unverifiable = [], skip = [], stop = 'complete', pending = [], events = [], groups = [], others = {}, references = [], undecided = [] } = {}) {
  if (!phase) throw new Error('auditStatus には phase が要る（coverage-audit の status は段ごとに分かれる）')
  const section = {
    findings: {
      confirmed: confirmed.map((f, i) => ({ id: `F${String(i).padStart(12, '0')}`, ids: [`F${String(i).padStart(12, '0')}`], severity: 'HIGH', layer: f.layer, claim: f.claim || '欠陥', quote: f.quote, paths: [f.path], obligation: 'G1', confidence: 'high', origin: 'file', provenance: 'new', groups: [] })),
      unverifiable,
    },
    groups, events,
  }
  return {
    phase, stopped: { stop }, pending: null, coverage: { units: 1 + pending.length + skip.length, seen: 1, disclosed: skip, pending },
    skip: skip.map((unit) => ({ unit, reason: '試行の上限' })), references, undecided, ...section, phases: { ...others, [phase]: section },
  }
}
// coverage-audit が止まったときに書く status のファイル（import-audit が読む）。
export const auditStatusPath = (auditState, phase) => path.join(auditState, `status-${phase}.json`)
export function writeAuditStatus(auditState, phase, status) {
  mkdirSync(auditState, { recursive: true })
  writeFileSync(auditStatusPath(auditState, phase), JSON.stringify(status))
}

// next → Workflow / 偽の coverage-audit / run-checks → ingest --call を止まるまで回す。audit(phase, out) は status を返す。
// steps の要素は Workflow の段が { step, task（next の担当の種類。台帳の pending から）, args, res, ingest }、audit は { step, phase, out, ingest }、checks は { step, ingest }。
export async function drive(state, agentFn, { audit = (phase) => auditStatus({ phase }), run = runWorkflow, maxSteps = 40, wrap = false } = {}) {
  const steps = []
  for (let i = 0; i < maxSteps; i++) {
    const n = cli('next', '--state', state)
    if (n.code !== 0 || n.stop) return { stop: n, steps }
    if (n.step === 'audit') {
      // 偽の coverage-audit が止まったときと同じく、置き場に status-<段>.json を書いてから取り込む（--status は無い）。
      writeAuditStatus(n.audit.state, n.phase, await audit(n.phase, n))
      const g = cli('import-audit', '--state', state)
      steps.push({ step: 'audit', phase: n.phase, out: n, ingest: g })
      if (g.code !== 0) return { stop: g, steps }
      continue
    }
    if (n.step === 'checks') {
      const g = cli('run-checks', '--state', state)
      steps.push({ step: 'checks', ingest: g })
      if (g.code !== 0) return { stop: g, steps }
      continue
    }
    const args = JSON.parse(readFileSync(n.args_path, 'utf8'))
    const task = JSON.parse(readFileSync(path.join(state, 'build.json'), 'utf8')).pending.task
    const res = await run(args, agentFn)
    const rp = path.join(state, `result-${n.call_id}.json`)
    writeFileSync(rp, JSON.stringify(wrap ? { result: res, summary: 'done', agentCount: (res.agents || []).length } : res))
    const g = cli('ingest', '--state', state, '--call', n.call_id, '--result', rp)
    steps.push({ step: n.step, task, args, res, ingest: g })
    if (g.code !== 0) return { stop: g, steps }
  }
  return { stop: null, steps }
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
