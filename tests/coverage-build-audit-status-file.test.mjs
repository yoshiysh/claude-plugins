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

// 書き換え（波の形）: main session の import-audit は無くなり、検査の結果は build の CLI が同じ process で取り込む。
// status-<段>.json を path で読む経路（--status を受けない・ファイルが無ければ拒む）は消えたので、取り込みの口が無いことと、
// 取り込みの規則（指摘を単位へ結ぶ・判定できなかった意図を出来事にする）を、波の中で流れる本物の coverage-audit の関数で確かめる。
const MARK = 'MARKER-設計の U1 の指摘'
const markFacts = (p, lines) => (path.basename(p) === 'U1.md' ? { findings: [{ claim: MARK, quote: lines.find(usable), layer: '詳細設計' }] } : {})
const buildOf = (state) => JSON.parse(readFileSync(path.join(state, 'build.json'), 'utf8'))

test('取り込み: build-cli は import-audit を持たず（終了状態 2）、波の中で流れた検査の指摘を path（paths）から単位へ結んで取り込む', async (t) => {
  const { state } = cb.setup(t)
  const r0 = cb.cli('import-audit', '--state', state)
  assert.equal(r0.code, 2, JSON.stringify(r0))
  const { steps } = await cb.drive(state, cb.mockAgent(), { audit: () => null, auditOver: { facts: markFacts }, maxSteps: 4 })
  assert.equal(steps.at(-1) && steps.at(-1).step, 'audit', JSON.stringify(steps.map((s) => s.step)))
  const ev = buildOf(state).events.filter((e) => e.kind === 'finding')
  assert.ok(ev.some((e) => e.text.includes(MARK) && e.unit === 'U1' && e.stage === 'design_review'), `指摘を path（paths）から単位へ結ぶ: ${JSON.stringify(ev)}`)
  assert.ok(!buildOf(state).events.some((e) => e.kind === 'import_mismatch'), JSON.stringify(buildOf(state).events.filter((e) => e.kind === 'import_mismatch')))
})

test('取り込み: 試行の上限で判定できなかった意図（undecided）を含む検査を取り込み、その意図の id を出来事として開示する', async (t) => {
  const { state } = cb.setup(t)
  const target = { id: null }
  const goal = (task) => { if (target.id && task.intent.id !== target.id) return undefined; target.id = task.intent.id; return null }
  const { steps } = await cb.drive(state, cb.mockAgent(), { audit: () => null, auditOver: { facts: markFacts, goal }, maxSteps: 4 })
  assert.equal(steps.at(-1) && steps.at(-1).step, 'audit', JSON.stringify(steps.map((s) => s.step)))
  assert.ok(target.id, '目標の意図を判定しなかった')
  assert.ok(buildOf(state).events.some((e) => String(e.text).includes(target.id)), '判定できなかった意図を探索グラフの出来事として残す')
})
