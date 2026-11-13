// coverage-ledger の Workflow source が Codex の runner（dynamic-workflow-runner の runtime）でも動くことを、偽の backend で確かめる。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Workflow } from '../plugins/workflow/skills/dynamic-workflow-runner/scripts/runtime/runtime.mjs'
import { readSourceMetadata } from '../plugins/workflow/skills/dynamic-workflow-runner/scripts/runtime/source.mjs'
import { C } from '../.agents/skills/coverage-ledger/scripts/ledger-core.mjs'
import { WF, cli, evidenceOf, mockAgent } from '../.agents/skills/coverage-ledger/scripts/test-harness.mjs'

const META = readSourceMetadata(readFileSync(WF, 'utf8'))
const ROLES = JSON.parse(readFileSync(path.join(path.dirname(WF), 'roles.json'), 'utf8'))

function tmp(t) {
  const d = mkdtempSync(path.join(tmpdir(), 'coverage-ledger-runner-'))
  t.after(() => rmSync(d, { recursive: true, force: true }))
  return d
}
const backend = (agentFn) => ({ capabilities: ['read-only', 'fresh-thread'], run: (prompt, options) => agentFn(prompt, options) })

async function driveRunner(t, state, agentFn) {
  const steps = []
  for (let i = 0; i < 30; i++) {
    const n = cli('next', '--state', state)
    if (n.code !== 0 || n.stop) return { stop: n, steps }
    const args = JSON.parse(readFileSync(n.args_path, 'utf8'))
    const res = await Workflow({ scriptPath: WF, args }, { backend: backend(agentFn), runDir: path.join(tmp(t), 'run'), trustedSource: true, ...META.limits })
    const rp = path.join(state, `result-${n.call_id}.json`)
    writeFileSync(rp, JSON.stringify(res))
    const g = cli('ingest', '--state', state, '--result', rp)
    steps.push({ step: n.step, res })
    if (g.code !== 0) return { stop: g, steps }
  }
  return { stop: null, steps }
}

function reviewSetup(t) {
  const d = tmp(t)
  writeFileSync(path.join(d, 'doc.md'), '# 文書\n\n## 一つ目の節\nこの節は一つ目の主張を述べる本文の行である。\n\n## 二つ目の節\nこの節は二つ目の主張を述べる本文の行である。\n')
  writeFileSync(path.join(d, 'goal.md'), '文書を観点ごとに確かめた指摘の一覧')
  writeFileSync(path.join(d, 'request.md'), '文書を観点ごとにレビューしてほしい')
  writeFileSync(path.join(d, 'lenses.json'), JSON.stringify([{ id: 'L1', name: '主張と根拠', procedure: '主張ごとに根拠を対応づける' }]))
  const state = path.join(d, 'state')
  assert.equal(cli('init', '--state', state, '--mode', 'review', '--goal', path.join(d, 'goal.md'), '--request', path.join(d, 'request.md'), '--target', path.join(d, 'doc.md'), '--lenses', path.join(d, 'lenses.json')).code, 0)
  return state
}

test('meta: limits の写しが本体と一致し、最悪の起動数が maxAgents に収まる', () => {
  assert.deepEqual({ ...META.limits }, { ...C.LIMITS })
  assert.deepEqual([...META.requirements], ['read-only', 'fresh-thread'])
  assert.ok(Math.floor(C.LIMITS.maxAgents / C.PER_CELL) * C.PER_CELL <= C.LIMITS.maxAgents)
  assert.ok(1 + 4 + 2 + 2 * 10 <= C.LIMITS.maxAgents, 'plan の固定部分（目標・計画役 2 体・統合・振り分け 10 束）が収まる')
  for (const role of ['goal_checker', 'planner_a', 'planner_b', 'integrator', 'router', 'unit_verifier', 'proposer', 'writer', 'reader_1', 'verifier', 'grouper', 'refuter_a', 'refuter_b']) {
    assert.ok(ROLES[role] && ROLES[role].model && ROLES[role].effort, `roles.json に ${role} の model と effort がある`)
  }
  assert.notEqual(ROLES.planner_a.model, ROLES.planner_b.model, '独立な計画役は別のモデル')
  assert.notEqual(ROLES.reader_1.model, ROLES.verifier.model, '読む役と検証役は別のモデル')
})

test('runner: review の流れが最後まで回り、全ての枡を確かめて完了する', async (t) => {
  const state = reviewSetup(t)
  const { stop } = await driveRunner(t, state, mockAgent())
  assert.equal(stop.stop, 'complete', JSON.stringify(stop))
  assert.equal(stop.coverage.settled, 6)
})

test('runner: schema に合わない出力は null になり、欠測として試行に数える', async (t) => {
  const state = reviewSetup(t)
  const bad = mockAgent({ read: (p, o) => (o.label.includes('一つ目の節|purpose') ? { cell_id: 1 } : undefined) })
  const { stop } = await driveRunner(t, state, bad)
  assert.equal(stop.stop, 'complete')
  assert.equal(stop.disclosed.length, 1)
  assert.ok(stop.disclosed[0].includes('一つ目の節|purpose'))
})

test('runner: create の流れ（plan・generate・review・retro・group）が回る', async (t) => {
  const d = tmp(t)
  writeFileSync(path.join(d, 'goal.md'), '入力から設計の文書を作る')
  writeFileSync(path.join(d, 'request.md'), '入力の項目を全て扱って設計の文書を作ってほしい')
  writeFileSync(path.join(d, 'in.jsonl'), '{"id":"R1","text":"一つ目の入力の項目の全文がここに書いてある"}\n')
  const state = path.join(d, 'state')
  assert.equal(cli('init', '--state', state, '--mode', 'create', '--goal', path.join(d, 'goal.md'), '--request', path.join(d, 'request.md'), '--artifact', path.join(d, 'out.md'), '--input', path.join(d, 'in.jsonl')).code, 0)
  const once = { done: false }
  const agentFn = mockAgent({
    read: (p, o) => {
      if (once.done || !o.label.includes('二つ目の節|purpose')) return undefined
      once.done = true
      return { cell_id: o.label.slice(5).split('（')[0], evidence: evidenceOf(p), findings: [{ claim: '目標に効かない', quote: 'この節は論点二つ目の決定を書いた本文の行である。', severity: 'LOW', layer: '要求' }], outside_notes: ['観点の外の気づき'], none_reason: '' }
    },
  })
  const { stop, steps } = await driveRunner(t, state, agentFn)
  assert.equal(stop.stop, 'needs_input', '要求の層の欠陥は利用者に返す')
  assert.equal(stop.upper.length, 1)
  assert.deepEqual([...new Set(steps.map((s) => s.step))], ['plan', 'generate', 'review', 'group'])
  assert.ok(steps.every((s) => s.res.tokens === null), 'runner では消費量を読めないので null')
  const status = cli('status', '--state', state)
  assert.equal(status.outside_notes.length, 1)
})
