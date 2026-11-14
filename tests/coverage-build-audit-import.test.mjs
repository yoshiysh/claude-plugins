// coverage-build の import-audit が、本物の coverage-audit の CLI と Workflow source（役は偽物）が出す status をそのまま取り込めることを確かめる。
// 2 つのスキルのファイルを読むので、配布物に入らないリポジトリ直下の tests/ に置く。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { cli as auditCli, drive as auditDrive, evidenceOf, mockAgent as auditAgent } from '../.agents/skills/coverage-audit/scripts/test-harness.mjs'
import { cli, drive, mockAgent, setup } from '../.agents/skills/coverage-build/scripts/test-harness.mjs'

test('設計レビュー: coverage-audit の status を取り込み、指摘を単位と層へ結ぶ', async (t) => {
  const { state } = setup(t)
  const log = []
  const runAudit = async (phase, out) => {
    const a = out.audit
    assert.equal(a.initialized, false)
    // coverage-build が書いた init の引数をそのまま渡す（照合済みの印を含む）。
    const init = auditCli(...a.init_argv)
    assert.equal(init.code, 0, JSON.stringify(init))
    const once = { done: false }
    const agentFn = auditAgent({
      read: (p, o) => {
        if (once.done || !o.label.includes('U1.md') || !o.label.includes('|purpose|')) return undefined
        once.done = true
        return { cell_id: o.label.slice(5).split('（')[0], evidence: evidenceOf(p), findings: [{ claim: '値の決め方が基準に照らせない', quote: '入力を受け取り、決まった値を返す。', severity: 'HIGH', layer: '詳細設計' }], outside_notes: [], none_reason: '' }
      },
    }, log)
    const r = await auditDrive(a.state, agentFn)
    assert.ok(['complete', 'needs_input'].includes(r.stop.stop), JSON.stringify(r.stop))
    return auditCli('status', '--state', a.state)
  }
  const { steps } = await drive(state, mockAgent(), { audit: runAudit, maxSteps: 2 })
  assert.deepEqual(steps.map((s) => s.step), ['design', 'audit'])
  assert.equal(steps[1].ingest.code, 0, JSON.stringify(steps[1].ingest))
  const L = JSON.parse(readFileSync(path.join(state, 'build.json'), 'utf8'))
  const f = L.events.filter((e) => e.kind === 'finding')
  assert.equal(f.length, 1)
  assert.deepEqual([f[0].unit, f[0].layer, f[0].stage], ['U1', '設計', 'design_review'])
  assert.ok(!L.events.some((e) => e.kind === 'import_mismatch'), JSON.stringify(L.events))
  assert.equal(L.retro.due, true)
  assert.ok(log.length && !log.some((x) => x.label.startsWith('goal-check')), 'coverage-build が照合した目標を coverage-audit は照合し直さない')
  const AL = JSON.parse(readFileSync(path.join(steps[1].out.audit.state, 'ledger.json'), 'utf8'))
  assert.deepEqual(AL.criteria.map((c) => c.id), ['AC1'], '受け入れ基準は coverage-audit の基準の欄に入る')
  assert.deepEqual(AL.constraints.map((c) => c.id), ['D1'])
})

test('受け入れ基準・制約が無い update: coverage-audit に基準・制約の欄を渡さず、「AC1: なし」のような項目を作らない', async (t) => {
  const { d, repo } = setup(t, { mode: 'update' })
  const state = path.join(d, 'no-criteria')
  const init = cli('init', '--state', state, '--mode', 'update', '--repo', repo, '--goal', path.join(d, 'goal.md'), '--request', path.join(d, 'request.md'), '--target', path.join(repo, 'src', 'old.mjs'))
  assert.equal(init.code, 0, JSON.stringify(init))
  let audit = null
  const runAudit = async (phase, out) => {
    audit = out.audit
    return { stop: 'complete' }
  }
  await drive(state, mockAgent(), { audit: runAudit, maxSteps: 2 })
  assert.ok(audit, '現状の検査に進む')
  assert.equal(audit.criteria, undefined)
  assert.equal(audit.constraints, undefined)
  assert.ok(!audit.init_argv.includes('--criteria') && !audit.init_argv.includes('--constraints'), JSON.stringify(audit.init_argv))
  assert.equal(auditCli(...audit.init_argv).code, 0)
  const AL = JSON.parse(readFileSync(path.join(audit.state, 'ledger.json'), 'utf8'))
  assert.deepEqual([AL.criteria, AL.constraints], [[], []])
})
