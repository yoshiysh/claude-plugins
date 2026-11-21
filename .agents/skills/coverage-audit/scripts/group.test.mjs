// 束ねと上限（設計「全体の段と確認」の束ね、「完了と止める条件」の安全網）。横展開と束ねの反証は持たない（launch.test.mjs が確かめる）。
// ここに残すのは、横展開のテスト（lateral.test.mjs）から、横展開と反証に依らない上限と UPPER の置き場の確かめ。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { C } from './ledger-core.mjs'
import { behave, cli, drive, project } from './blackboard-fixture.mjs'

const QA = 'この文書は一つ目の主張を述べるが根拠を書いていない本文の行である。'
const QB = 'この文書は二つ目の主張を述べるが根拠を書いていない本文の行である。'
const FILES = { 'a.md': `# A\n\n## 主張\n${QA}\n`, 'b.md': `# B\n\n## 主張\n${QB}\n` }
const ledger = (state) => JSON.parse(readFileSync(path.join(state, 'ledger.json'), 'utf8'))
const act = behave({ facts: (p) => (path.basename(p) === 'a.md' ? { findings: [{ claim: '根拠が無い主張', quote: QA }] } : {}) })

test('max_cycles の既定: --max-cycles を渡さない init の台帳は max_cycles 2', (t) => {
  assert.equal(ledger(project(t, FILES).state).config.max_cycles, 2)
})

test('起動数の上限: max_agents_total に達したら、今のまま limit で止める（needs_input にしない）', async (t) => {
  const { state } = project(t, FILES)
  assert.equal(cli('config', '--state', state, '--max-agents-total', '3').code, 0)
  const { stop } = await drive(state, act)
  assert.equal(stop.stop, 'limit', JSON.stringify(stop))
  assert.ok(stop.reasons.some((r) => /起動数/.test(r)), JSON.stringify(stop.reasons))
})

test('P10-1: UPPER（方針・要求）は <checks> 区間が持ち、ledger-core は C から読む（自前の定義を持たない）', () => {
  assert.deepEqual([...C.UPPER], ['方針', '要求'])
  const src = readFileSync(new URL('./coverage-audit.js', import.meta.url), 'utf8')
  const block = src.slice(src.indexOf('// <checks>'), src.indexOf('// </checks>'))
  assert.match(block, /\bconst UPPER\b/, '<checks> 区間に UPPER を置く')
  const core = readFileSync(new URL('./ledger-core.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(core, /\b(const|let|var) UPPER\b/, 'ledger-core に UPPER の写しを持たない')
})
