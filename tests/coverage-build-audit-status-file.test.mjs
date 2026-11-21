// 単位 5 のテスト: coverage-audit は止まったときに stateDir/status-<段>.json を書き、coverage-build の import-audit はそのファイルを path で読む
// （司令塔が status の出力を写して --status で渡す経路を無くす）。試行の上限で開示して閉じた意図（undecided）を含む complete も取り込める。
// 設計「既存のスキルへの組み込み」の coverage-build との受け渡し（取り込み）と「完了と止める条件」の試行の上限。2 つのスキルを使うので tests/ に置く。
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import * as cb from '../.agents/skills/coverage-build/scripts/test-harness.mjs'
import { behave, cli as auditCli, drive as auditDrive, project, run, status, usable } from '../.agents/skills/coverage-audit/scripts/blackboard-fixture.mjs'

const QA = 'この文書は台帳の lock を取ってから書き込むことを保証する。'
const FILES = { 'a.md': `# A\n\n## 保証\n${QA}\n` }
const statusFile = (state, phase) => path.join(state, `status-${phase}.json`)
const withoutCode = ({ code, ...rest }) => rest

test('status-<段>.json: 止まる前は書かず、complete で止まったら stateDir/status-<段>.json に status と同じ中身を書く', async (t) => {
  const { state } = project(t, FILES, { phase: 'design' })
  auditCli('next', '--state', state)
  assert.ok(!existsSync(statusFile(state, 'design')), '止まる前は書かない')
  const { stop } = await auditDrive(state, behave())
  assert.equal(stop.stop, 'complete', JSON.stringify(stop))
  assert.ok(existsSync(statusFile(state, 'design')), `止まったら書く: ${statusFile(state, 'design')}`)
  assert.deepEqual(JSON.parse(readFileSync(statusFile(state, 'design'), 'utf8')), withoutCode(status(state)))
})

test('status-<段>.json: limit で止まったときも書き、停止の種類と開いたままの意図が残る', async (t) => {
  const { state } = project(t, FILES, { phase: 'impl' })
  assert.equal(run('config', '--state', state, '--workers', '1', '--max-agents-total', '1').code, 0)
  const { stop } = await auditDrive(state, behave())
  assert.equal(stop.stop, 'limit', JSON.stringify(stop))
  const s = JSON.parse(readFileSync(statusFile(state, 'impl'), 'utf8'))
  assert.equal(s.stopped.stop, 'limit')
  assert.equal(s.phase, 'impl')
  assert.ok((s.intents || []).some((i) => i.state === 'open'), '開いたままの意図を開示する')
})

// coverage-build の next を、最初の audit（設計レビュー）を返すまで回す（Workflow の段は偽の役で流す）。
async function untilAudit(state) {
  for (let i = 0; i < 20; i++) {
    const n = cb.cli('next', '--state', state)
    assert.equal(n.code, 0, JSON.stringify(n))
    if (n.step === 'audit') return n
    assert.ok(!n.stop, JSON.stringify(n))
    const args = JSON.parse(readFileSync(n.args_path, 'utf8'))
    const res = await cb.runWorkflow(args, cb.mockAgent())
    const f = path.join(state, `result-${n.call_id}.json`)
    writeFileSync(f, JSON.stringify(res))
    assert.equal(cb.cli('ingest', '--state', state, '--call', n.call_id, '--result', f).code, 0)
  }
  throw new Error('audit に届かない')
}
const MARK = 'MARKER-設計の U1 の指摘'
// 本物の coverage-audit を coverage-build の init_argv で始め、偽の役で止まるまで回す。U1.md のファイルの段が指摘を 1 件書く。
async function runRealAudit(n, over = {}) {
  const r = auditCli(...n.audit.init_argv)
  assert.equal(r.code, 0, JSON.stringify(r))
  const act = behave({
    facts: (p, lines) => (path.basename(p) === 'U1.md' ? { findings: [{ claim: MARK, quote: lines.find(usable), layer: '詳細設計' }] } : {}),
    ...over,
  })
  return auditDrive(n.audit.state, act)
}
const buildOf = (state) => JSON.parse(readFileSync(path.join(state, 'build.json'), 'utf8'))

test('import-audit: --status を受け付けず（終了状態 2）、coverage-audit の置き場の status-<段>.json を自分で読んで取り込む。next の案内も status の保存を求めない', async (t) => {
  const { state } = cb.setup(t)
  const n = await untilAudit(state)
  assert.ok(!String(n.then).includes('--status'), `司令塔に status の出力を保存して渡させない: ${n.then}`)
  const { stop } = await runRealAudit(n)
  assert.equal(stop.stop, 'complete', JSON.stringify(stop))
  const f = path.join(state, 'copied-status.json')
  writeFileSync(f, JSON.stringify(auditCli('status', '--state', n.audit.state)))
  assert.equal(cb.cli('import-audit', '--state', state, '--status', f).code, 2, '--status は受け付けない引数')
  const g = cb.cli('import-audit', '--state', state)
  assert.equal(g.code, 0, JSON.stringify(g))
  const ev = buildOf(state).events.filter((e) => e.kind === 'finding')
  assert.ok(ev.some((e) => e.text.includes(MARK) && e.unit === 'U1' && e.stage === 'design_review'), `指摘を path（paths）から単位へ結ぶ: ${JSON.stringify(ev)}`)
  assert.ok(!buildOf(state).events.some((e) => e.kind === 'import_mismatch'), JSON.stringify(buildOf(state).events.filter((e) => e.kind === 'import_mismatch')))
})

test('import-audit: coverage-audit が止まる前（status-<段>.json が無い）は終了状態 2 で拒み、取り込みを待ったままにする', async (t) => {
  const { state } = cb.setup(t)
  const n = await untilAudit(state)
  assert.equal(auditCli(...n.audit.init_argv).code, 0)
  const g = cb.cli('import-audit', '--state', state)
  assert.equal(g.code, 2, JSON.stringify(g))
  assert.ok(String(g.error).includes(path.join(n.audit.state, 'status-design.json')), `読みに行ったファイルの path を理由に示す: ${g.error}`)
  assert.equal(buildOf(state).pending.step, 'audit')
})

test('import-audit: 試行の上限で判定できなかった意図（undecided）を含む complete を取り込み、その意図の id を出来事として開示する', async (t) => {
  const { state } = cb.setup(t)
  const n = await untilAudit(state)
  const target = { id: null }
  const { stop } = await runRealAudit(n, { goal: (task) => { if (target.id && task.intent.id !== target.id) return undefined; target.id = task.intent.id; return null } })
  assert.equal(stop.stop, 'complete', JSON.stringify(stop))
  const s = JSON.parse(readFileSync(statusFile(n.audit.state, 'design'), 'utf8'))
  assert.ok((s.undecided || []).some((u) => u.id === target.id), JSON.stringify(s.undecided))
  const g = cb.cli('import-audit', '--state', state)
  assert.equal(g.code, 0, JSON.stringify(g))
  assert.ok(buildOf(state).events.some((e) => String(e.text).includes(target.id)), '判定できなかった意図を探索グラフの出来事として残す')
})
