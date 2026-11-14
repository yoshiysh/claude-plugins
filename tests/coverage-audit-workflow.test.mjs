// coverage-audit の Workflow source が Codex の runner（dynamic-workflow-runner の runtime）でも動くことを、偽の backend で確かめる。
// 偽の backend は担当と同じく写しのファイルを読む。実際の Codex の worker が stateDir の写しを読めるかは、このテストでは確かめていない。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { Workflow } from '../plugins/workflow/skills/dynamic-workflow-runner/scripts/runtime/runtime.mjs'
import { readSourceMetadata } from '../plugins/workflow/skills/dynamic-workflow-runner/scripts/runtime/source.mjs'
import { C } from '../.agents/skills/coverage-audit/scripts/ledger-core.mjs'
import { WF, cli, drive, evidenceOf, mockAgent, tmp } from '../.agents/skills/coverage-audit/scripts/test-harness.mjs'

const META = readSourceMetadata(readFileSync(WF, 'utf8'))
const ROLES = JSON.parse(readFileSync(path.join(path.dirname(WF), 'roles.json'), 'utf8'))

const backend = (agentFn) => ({ capabilities: ['read-only', 'fresh-thread'], run: (prompt, options) => agentFn(prompt, options) })
const viaRunner = (t) => (args, agentFn) => Workflow({ scriptPath: WF, args }, { backend: backend(agentFn), runDir: path.join(tmp(t), 'run'), trustedSource: true, ...META.limits })

function reviewSetup(t) {
  const d = tmp(t)
  writeFileSync(path.join(d, 'doc.md'), '# 文書\n\n## 一つ目の節\nこの節は一つ目の主張を述べる本文の行である。\n\n## 二つ目の節\nこの節は二つ目の主張を述べる本文の行である。\n')
  writeFileSync(path.join(d, 'goal.md'), '- G1: 文書を観点ごとに確かめた指摘の一覧 〔request: 文書を観点ごとにレビューしてほしい〕\n')
  writeFileSync(path.join(d, 'request.md'), '文書を観点ごとにレビューしてほしい')
  writeFileSync(path.join(d, 'lenses.json'), JSON.stringify([{ id: 'L1', name: '主張と根拠', procedure: '主張ごとに根拠を対応づける' }]))
  const state = path.join(d, 'state')
  assert.equal(cli('init', '--state', state, '--goal', path.join(d, 'goal.md'), '--request', path.join(d, 'request.md'), '--target', path.join(d, 'doc.md'), '--lenses', path.join(d, 'lenses.json')).code, 0)
  return state
}

test('meta: limits の写しが本体と一致し、最悪の起動数が maxAgents に収まる', () => {
  assert.deepEqual({ ...META.limits }, { ...C.LIMITS })
  assert.deepEqual([...META.requirements], ['read-only', 'fresh-thread'])
  assert.ok(Math.floor(C.LIMITS.maxAgents / C.PER_CELL) * C.PER_CELL <= C.LIMITS.maxAgents)
  assert.ok(1 + 4 + 2 <= C.LIMITS.maxAgents, 'plan の固定部分（目標・計画役 2 体とやり直し・統合とやり直し）が収まる')
  for (const role of ['goal_checker', 'planner_a', 'planner_b', 'integrator', 'unit_verifier', 'reader_1', 'verifier', 'grouper', 'refuter_a', 'refuter_b']) {
    assert.ok(ROLES[role] && ROLES[role].model && ROLES[role].effort, `roles.json に ${role} の model と effort がある`)
  }
  assert.notEqual(ROLES.planner_a.model, ROLES.planner_b.model, '独立な計画役は別のモデル')
  // p 回目の読む役（reader_p、無ければ reader_1）と検証役（verifier_p、無ければ verifier）は別のモデル。
  for (const p of [1, 2, 3].filter((n) => n === 1 || ROLES[`reader_${n}`])) {
    const r = ROLES[`reader_${p}`] || ROLES.reader_1
    const v = ROLES[`verifier_${p}`] || ROLES.verifier
    assert.notEqual(r.model, v.model, `${p} 回目の読む役と検証役は別のモデル`)
  }
})

test('runner: review の流れが最後まで回り、全ての枡を確かめて完了する', async (t) => {
  const state = reviewSetup(t)
  const { stop } = await drive(state, mockAgent(), { run: viaRunner(t) })
  assert.equal(stop.stop, 'complete', JSON.stringify(stop))
  assert.equal(stop.coverage.settled, 6)
})

test('runner: schema に合わない出力は null になり、欠測として試行に数える', async (t) => {
  const state = reviewSetup(t)
  const bad = mockAgent({ read: (p, o) => (o.label.includes('一つ目の節|purpose') ? { cell_id: 1 } : undefined) })
  const { stop } = await drive(state, bad, { run: viaRunner(t) })
  assert.equal(stop.stop, 'complete')
  assert.equal(stop.disclosed.length, 1)
  assert.ok(stop.disclosed[0].includes('一つ目の節|purpose'))
})

test('runner: 計画・読み・振り返り・束ねが回り、上の層の欠陥は needs_input で返す', async (t) => {
  const state = reviewSetup(t)
  const once = { done: false }
  const agentFn = mockAgent({
    read: (p, o) => {
      if (once.done || !o.label.includes('二つ目の節|purpose')) return undefined
      once.done = true
      return { cell_id: o.label.slice(5).split('（')[0], evidence: evidenceOf(p), findings: [{ claim: '目標に効かない', quote: 'この節は二つ目の主張を述べる本文の行である。', severity: 'LOW', layer: '要求' }], outside_notes: ['観点の外の気づき'], none_reason: '' }
    },
  })
  const { stop, steps } = await drive(state, agentFn, { run: viaRunner(t) })
  assert.equal(stop.stop, 'needs_input', '要求の層の欠陥は利用者に返す')
  assert.equal(stop.upper.length, 1)
  assert.deepEqual([...new Set(steps.map((s) => s.step))], ['plan', 'review', 'group'])
  assert.ok(steps.every((s) => s.res.tokens === null), 'runner では消費量を読めないので null')
  const status = cli('status', '--state', state)
  assert.equal(status.outside_notes.length, 1)
})
