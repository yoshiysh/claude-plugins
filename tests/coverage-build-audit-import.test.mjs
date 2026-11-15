// coverage-build の import-audit が、本物の coverage-audit の CLI と Workflow source（役は偽物）が出す status をそのまま取り込めることを確かめる。
// 2 つのスキルのファイルを読むので、配布物に入らないリポジトリ直下の tests/ に置く。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { cli as auditCli, drive as auditDrive, evidenceOf, mockAgent as auditAgent } from '../.agents/skills/coverage-audit/scripts/test-harness.mjs'
import { cli, drive, mockAgent, setup } from '../.agents/skills/coverage-build/scripts/test-harness.mjs'

test('設計レビュー: coverage-audit の status を取り込み、指摘を単位と層へ結ぶ', async (t) => {
  const { state } = setup(t)
  const log = []
  const runAudit = async (phase, out) => {
    const a = out.audit
    assert.ok(Array.isArray(a.init_argv) && a.reframe_argv === undefined, '置き場に台帳が無いので init_argv')
    assert.equal(a.state, path.join(state, 'audit', 'state'))
    // coverage-build が書いた init の引数をそのまま渡す（照合済みの印を含む）。
    const init = auditCli(...a.init_argv)
    assert.equal(init.code, 0, JSON.stringify(init))
    // 資産は見出しの下のブロックで切られるので、引用の文を本文に含む U1.md の資産の purpose の枡を 1 つだけ選ぶ。
    const quote = '入力を受け取り、決まった値を返す。'
    const once = { done: false }
    const agentFn = auditAgent({
      read: (p, o) => {
        if (once.done || !o.label.includes('U1.md') || !o.label.includes('|purpose|') || !evidenceOf(p).some((l) => l.includes(quote))) return undefined
        once.done = true
        return { cell_id: o.label.slice(5).split('（')[0], evidence: evidenceOf(p), findings: [{ claim: '値の決め方が基準に照らせない', quote, severity: 'HIGH', layer: '詳細設計' }], outside_notes: [], none_reason: '' }
      },
    }, log)
    const r = await auditDrive(a.state, agentFn)
    assert.ok(once.done, '引用の文を本文に含む U1.md の purpose の枡に指摘を返した')
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

test('段をまたいで 1 つの台帳: 設計レビューは init、実装レビューは同じ置き場の台帳を reframe し、その段の status だけを取り込む', async (t) => {
  const { state } = setup(t)
  const calls = []
  const runAudit = async (phase, out) => {
    const a = out.audit
    const argv = a.init_argv || a.reframe_argv
    assert.ok(argv && !(a.init_argv && a.reframe_argv), `init_argv か reframe_argv のどちらか一方: ${JSON.stringify(a)}`)
    const r = auditCli(...argv)
    assert.equal(r.code, 0, JSON.stringify(r))
    calls.push({ phase, kind: argv[0], state: a.state, targets: a.targets })
    const d = await auditDrive(a.state, auditAgent())
    assert.ok(['complete', 'needs_input'].includes(d.stop.stop), JSON.stringify(d.stop))
    return auditCli('status', '--state', a.state)
  }
  const { stop, steps } = await drive(state, mockAgent(), { audit: runAudit })
  assert.equal(stop.stop, 'complete', JSON.stringify(stop))
  assert.deepEqual(calls.map((c) => [c.phase, c.kind]), [['design', 'init'], ['impl', 'reframe']])
  assert.deepEqual([...new Set(calls.map((c) => c.state))], [path.join(state, 'audit', 'state')])
  const ledgers = readdirSync(state, { recursive: true }).map(String).filter((f) => path.basename(f) === 'ledger.json')
  assert.deepEqual(ledgers, [path.join('audit', 'state', 'ledger.json')], 'coverage-audit の台帳は 1 つ')
  const AL = JSON.parse(readFileSync(path.join(state, 'audit', 'state', 'ledger.json'), 'utf8'))
  assert.equal(AL.phase, 'impl')
  assert.ok(AL.phase_records && AL.phase_records.design, '設計レビューの節を同じ台帳に残す')
  assert.equal(AL.goal.checked_by, 'coverage-build')
  assert.deepEqual([...AL.targets].sort(), [...calls[1].targets].sort(), '対象を実装の段のものに差し替える')
  const imp = steps.filter((s) => s.step === 'audit').map((s) => s.ingest)
  assert.ok(imp.every((g) => g.code === 0), JSON.stringify(imp))
  assert.deepEqual(imp.map((g) => g.phase), ['design', 'impl'])
})
