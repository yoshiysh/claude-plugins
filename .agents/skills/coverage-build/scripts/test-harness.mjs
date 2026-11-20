// テストの道具: 本物の Workflow source を native と同じ注入で走らせ、役は束（brief）を読んで返す偽物にする。
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { main } from './build-cli.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const SOURCES = { step: path.join(HERE, 'build-step.js'), write: path.join(HERE, 'build-write.js') }
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor
const bodies = Object.fromEntries(Object.entries(SOURCES).map(([k, f]) => [k, new AsyncFunction('agent', 'parallel', 'pipeline', 'phase', 'log', 'args', 'budget', readFileSync(f, 'utf8').replace(/^export const meta = /, 'const meta = '))]))

export function tmp(t) {
  const d = mkdtempSync(path.join(tmpdir(), 'coverage-build-'))
  t.after(() => rmSync(d, { recursive: true, force: true }))
  return d
}
export function cli(...argv) {
  const r = main(argv)
  return { code: r.code, ...r.output }
}

const briefOf = (prompt) => { const m = /Read で (\S+) を全て読む/.exec(prompt); return m ? readFileSync(m[1], 'utf8') : '' }
const section = (brief, head) => { const i = brief.indexOf(`## ${head}`); if (i < 0) return ''; const rest = brief.slice(i + head.length + 3); const e = rest.indexOf('\n## '); return e < 0 ? rest : rest.slice(0, e) }
export const idsIn = (text) => [...text.matchAll(/^- ([A-Z][A-Z0-9]*\d): /gm)].map((m) => m[1])
export const inputsOf = (brief) => [...section(brief, '入力').matchAll(/^- (\/.+)$/gm)].map((m) => m[1])
const firstLine = (f) => readFileSync(f, 'utf8').split('\n').find((l) => l.trim().length >= 14) || readFileSync(f, 'utf8').trim()
export const requestOf = (brief) => section(brief, '依頼文').split('\n').slice(1).join('\n').trim()
export const repoOf = (brief) => /repo（相対 path の起点）: (.+)$/m.exec(brief)[1]

// 既定の方式設計: code の単位 U1 と、それに依存する doc の単位 U2。
export const defaultUnits = (cover) => [
  { id: 'U1', kind: 'code', title: '計算', responsibility: '値を計算する', paths: ['src/a.mjs'], tests: ['test/a.test.mjs'], test_uses: [], depends_on: [], covers: cover },
  { id: 'U2', kind: 'doc', title: '説明', responsibility: '使い方を書く', paths: ['docs/a.md'], tests: [], test_uses: [], depends_on: ['U1'], covers: cover },
]

// 既定の振る舞い: どの役も検査を通る最小の返り値を返す。over[label の頭] で差し替える（undefined なら既定、null は欠測）。
export function mockAgent(over = {}, log = []) {
  return async (prompt, opts) => {
    log.push({ label: opts.label, model: opts.model, effort: opts.effort, prompt })
    const head = opts.label.split('（')[0]
    const role = head.replace(/-U\d+$|-\d+$/, '')
    for (const k of [head, role]) if (over[k]) { const r = over[k](prompt, opts, log); if (r !== undefined) return r }
    const brief = briefOf(prompt)
    if (role === 'goal-check') return { outcomes: [{ outcome: '依頼の全体', quotes: [{ source: 'request', quote: requestOf(brief) }], items: [...idsIn(section(brief, '固定した目標')), ...idsIn(section(brief, '受け入れ基準')), ...idsIn(section(brief, '固定した制約'))] }] }
    if (role === 'architect') {
      const cover = [...idsIn(section(brief, '受け入れ基準')), ...idsIn(section(brief, '固定した制約'))]
      return { units: defaultUnits(cover), inputs_read: inputsOf(brief).map((p) => ({ path: p, quotes: [firstLine(p)] })), inputs_not_read: [], questions: [], contracts: [], copies: [] }
    }
    if (role === 'design') return { unit_id: head.slice('design-'.length), spec: '入力を受け取り、決まった値を返す。', acceptance: ['値を返す'], behaviors: [{ text: '値を返す', accepts: [1], rows: [] }], partitions: [], premises: [], unverified: [], allowed_optional: [], cases: [{ condition: '入力が 1', expect: '2 を返す', accepts: [1], covers: [] }] }
    if (role === 'tests' || role === 'implement') {
      const paths = /書いてよいのは次の path だけ（repo からの相対）: ([^。]+)。/.exec(prompt)[1].split(', ')
      const repo = repoOf(brief)
      for (const p of paths) { mkdirSync(path.dirname(path.join(repo, p)), { recursive: true }); writeFileSync(path.join(repo, p), `// ${role} ${p}\nexport const value = 2\n`) }
      return { unit_id: head.slice(role.length + 1), written: paths, notes: '', unresolved: [] }
    }
    if (role === 'retro-plan') return { intents: [] }
    if (role === 'retro-exam') return { verdict: 'unclear', cause: '', layer: '実装', evidence: [] }
    if (role === 'retro-judge') return { accept: true, reason: '記録が支える' }
    throw new Error(`想定しない役: ${opts.label}`)
  }
}

// budget: native が注入する消費量の計器（spent() を持つ）。省略は注入しない経路（runner など）。
// shape: pipeline の callback に渡す引数の形。runner は (item, index)、native は (prevResult, originalItem, index)（1 段なら prevResult は item）。
export async function runWorkflow(args, agentFn, { shape = 'runner', budget } = {}) {
  const parallel = (ts) => Promise.all(ts.map((t) => Promise.resolve().then(t).catch(() => null)))
  const call = shape === 'native' ? (fn, x, i) => fn(x, x, i) : (fn, x, i) => fn(x, i)
  const pipeline = (items, fn) => Promise.all(items.map((x, i) => Promise.resolve().then(() => call(fn, x, i)).catch(() => null)))
  const body = ['tests', 'implement'].includes(args.stage) ? bodies.write : bodies.step
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

// next → Workflow / 偽の coverage-audit / run-checks → ingest を止まるまで回す。audit(phase, out) は status を返す。
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
    const res = await run(args, agentFn)
    const rp = path.join(state, `result-${n.call_id}.json`)
    writeFileSync(rp, JSON.stringify(wrap ? { result: res, summary: 'done', agentCount: (res.agents || []).length } : res))
    const g = cli('ingest', '--state', state, '--result', rp)
    steps.push({ step: n.step, args, res, ingest: g, argsBytes: n.args_bytes })
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
