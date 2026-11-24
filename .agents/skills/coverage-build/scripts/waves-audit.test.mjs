// 検査の段の枠のテスト（計画 effervescent-kindling-corbato の「coverage-build」5〜7、設計レビュー 1 回目の 5・8）。
// - 設計レビューに今の本文を参照（--context）で渡し、どの段でも入力（--input）を参照で渡す。design の観点の手続きは今の本文と目標に照らす。
// - --audit-phases（init・config）で検査を挟む段を選び、外した段を status と停止の報告に段ごとに出す。
// - init・answer --file で、目標・基準・制約の本文の path が repo に実在するのに --target・--input に無ければ拒む（coverage-audit の framePathProblems を使う）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { framePathProblems } from '../../coverage-audit/scripts/ledger-cli.mjs'
import { WORKFLOW_SOURCE } from './build-core.mjs'
import { act, auditPos, cli, driveScript, setup } from './board-fixture.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const status = (state) => cli('status', '--state', state)
const PHASES = ['baseline', 'design', 'impl']
const skippedOf = (x) => (Array.isArray(x && x.skipped_audits) ? x.skipped_audits.map((s) => s.phase) : null)

// ---------------- 5. 設計レビューに今の本文を渡す ----------------

test('参照: 検査の段ごとに、全文レビューの単位の索引に参照（context: true）が載る。design は update の対象と入力、ほかの段も入力を参照で持つ', async (t) => {
  const { d, repo, state } = setup(t, { mode: 'update' })
  const target = path.join(repo, 'src', 'old.mjs')
  const input = path.join(d, 'material.md')
  const seen = []
  const auditOver = {
    full_review: (task, ctx) => {
      const q = ctx.query(task)
      const units = (q.inputs && q.inputs.units) || []
      seen.push({ phase: (auditPos(state) || {}).phase, contexts: units.filter((u) => u.context).map((u) => path.resolve(u.path)), reads: units.filter((u) => !u.context).map((u) => path.resolve(u.path)) })
      return undefined
    },
  }
  const r = await driveScript(state, act({ arch: { units: 'chain' } }), { maxSteps: 4, auditOver })
  assert.equal(r.stop && r.stop.stop, 'complete', JSON.stringify(r.stop))
  const at = (phase) => seen.filter((x) => x.phase === phase)
  for (const phase of PHASES) assert.ok(at(phase).length, `${phase} の全文レビューが流れた: ${JSON.stringify(seen.map((x) => x.phase))}`)
  for (const x of at('design')) {
    assert.ok(x.contexts.includes(target), `design は update の対象を参照で持つ: ${JSON.stringify(x)}`)
    assert.ok(x.contexts.includes(input), `design は入力を参照で持つ: ${JSON.stringify(x)}`)
    assert.ok(!x.reads.includes(target), '対象は読む範囲（網羅）に入らない')
  }
  for (const x of [...at('baseline'), ...at('impl')]) assert.ok(x.contexts.includes(input), `${x.phase} も入力を参照で持つ: ${JSON.stringify(x)}`)
})

test('参照: design の観点の手続きは、設計の決定を今の本文（参照）と目標に照らし、変更後の文面の存在を求めない', async (t) => {
  const { state } = setup(t, { mode: 'update' })
  const procs = []
  const auditOver = { file: (task) => { if ((auditPos(state) || {}).phase === 'design') procs.push(...(task.lenses || []).map((l) => JSON.stringify(l.procedure))); return undefined } }
  const r = await driveScript(state, act({ arch: { units: 'chain' } }), { maxSteps: 4, auditOver })
  assert.ok(procs.length, `design のファイルの段が流れた: ${JSON.stringify(r.stop)}`)
  assert.ok(procs.some((p) => p.includes('今の本文') && p.includes('目標') && p.includes('変更後の文面の存在を求めない')), JSON.stringify(procs))
})

// ---------------- 6. --audit-phases ----------------

test('--audit-phases: 既定は baseline,design,impl で全て流し、外した段は無い（status と停止の報告の skipped_audits が空）', async (t) => {
  const { state } = setup(t, { mode: 'update' })
  const r = await driveScript(state, act({ arch: { units: 'chain' } }), { maxSteps: 4 })
  assert.equal(r.stop && r.stop.stop, 'complete', JSON.stringify(r.stop))
  assert.deepEqual(skippedOf(r.stop), [], `停止の報告: ${JSON.stringify(r.stop)}`)
  const s = status(state)
  assert.deepEqual(skippedOf(s), [], JSON.stringify(s.skipped_audits))
  for (const p of PHASES) assert.ok(s.audits && s.audits[p], `${p} を流した: ${JSON.stringify(s.audits)}`)
})

test('--audit-phases（init）: 外した段の検査は流さず、外したことを status と停止の報告に段ごとに理由つきで出す', async (t) => {
  const { state } = setup(t, { mode: 'update', extra: ['--audit-phases', 'impl'] })
  const seen = new Set()
  const auditOver = { full_review: () => { const p = auditPos(state); if (p) seen.add(p.phase); return undefined } }
  const r = await driveScript(state, act({ arch: { units: 'chain' } }), { maxSteps: 4, auditOver })
  assert.equal(r.stop && r.stop.stop, 'complete', JSON.stringify(r.stop))
  assert.deepEqual([...seen], ['impl'], '外した段の検査の役を起動しない')
  const s = status(state)
  assert.ok(s.audits && s.audits.impl && !s.audits.baseline && !s.audits.design, JSON.stringify(s.audits))
  for (const x of [s, r.stop]) {
    assert.deepEqual(skippedOf(x), ['baseline', 'design'], JSON.stringify(x.skipped_audits))
    assert.ok(x.skipped_audits.every((y) => typeof y.reason === 'string' && y.reason.length > 0), '段ごとの理由')
  }
})

test('--audit-phases（config）: 実行の途中で段を外せ、知らない段の名前は終了状態 2 で拒んで台帳を変えない。init でも知らない段は台帳を作らない', async (t) => {
  const { d, repo, state } = setup(t, { mode: 'update' })
  const before = readFileSync(path.join(state, 'build.json'), 'utf8')
  const bad = cli('config', '--state', state, '--audit-phases', 'design,nope')
  assert.equal(bad.code, 2, JSON.stringify(bad))
  assert.equal(readFileSync(path.join(state, 'build.json'), 'utf8'), before)
  const ok = cli('config', '--state', state, '--audit-phases', 'design,impl')
  assert.equal(ok.code, 0, JSON.stringify(ok))
  assert.deepEqual(skippedOf(status(state)), ['baseline'])
  const s2 = path.join(d, 'state-bad')
  const init = cli('init', '--state', s2, '--mode', 'update', '--repo', repo, '--goal', path.join(d, 'goal.md'), '--request', path.join(d, 'request.md'), '--target', path.join(repo, 'src', 'old.mjs'), '--audit-phases', 'baseline,later')
  assert.equal(init.code, 2, JSON.stringify(init))
  assert.ok(!existsSync(path.join(s2, 'build.json')), '台帳を作らない')
})

// ---------------- 7. path の照合 ----------------

// 目標の本文に repo の相対 path を書いた init の引数（create。--input と --target は呼ぶ側が足す）。
function pathGoal(d, repo, word, { criteria = false } = {}) {
  writeFileSync(path.join(d, 'request-p.md'), `${word} の値を直してほしい`)
  writeFileSync(path.join(d, 'goal-p.md'), criteria ? `- G1: 依頼の値を直す 〔request: ${word} の値を直してほしい〕\n` : `- G1: ${word} の値を直す 〔request: ${word} の値を直してほしい〕\n`)
  if (criteria) writeFileSync(path.join(d, 'criteria-p.md'), `- AC1: ${word} の値を直す 〔request: ${word} の値を直してほしい〕\n`)
  return ['--repo', repo, '--goal', path.join(d, 'goal-p.md'), '--request', path.join(d, 'request-p.md'), ...(criteria ? ['--criteria', path.join(d, 'criteria-p.md')] : [])]
}
const items = (f) => readFileSync(f, 'utf8').split('\n').filter((l) => l.startsWith('- ')).map((l) => { const m = /^- (\w+): (.*?)\s*〔/.exec(l); return { id: m[1], text: m[2] } })

test('path の照合（init）: 目標・基準の本文の path が repo（--repo）に実在するのに --target・--input に無ければ拒み、台帳を作らない。問題の文は coverage-audit の framePathProblems と同じ', async (t) => {
  const { d, repo } = setup(t)
  for (const criteria of [false, true]) {
    const s = path.join(d, `state-reject-${criteria}`)
    const argv = pathGoal(d, repo, 'src/old.mjs', { criteria })
    const r = cli('init', '--state', s, '--mode', 'create', ...argv)
    assert.equal(r.code, 2, JSON.stringify(r))
    assert.ok(Array.isArray(r.problems) && r.problems.some((p) => p.includes('src/old.mjs')), JSON.stringify(r))
    const want = framePathProblems({ goal: items(path.join(d, 'goal-p.md')), criteria: criteria ? items(path.join(d, 'criteria-p.md')) : [], constraints: [] }, { repo, targets: [], contexts: [] })
    assert.ok(want.length && want.every((p) => r.problems.includes(p)), `framePathProblems の文をそのまま返す: ${JSON.stringify({ want, got: r.problems })}`)
    assert.ok(!existsSync(path.join(s, 'build.json')))
  }
})

test('path の照合（init）: --input にある path・update の --target にある path・repo に実在しない path は拒まない', async (t) => {
  const { d, repo } = setup(t)
  const old = path.join(repo, 'src', 'old.mjs')
  const cases = [
    ['input', ['--mode', 'create', ...pathGoal(d, repo, 'src/old.mjs'), '--input', old]],
    ['target', ['--mode', 'update', ...pathGoal(d, repo, 'src/old.mjs'), '--target', old]],
    ['missing', ['--mode', 'create', ...pathGoal(d, repo, 'src/none.mjs')]],
  ]
  for (const [name, argv] of cases) {
    const r = cli('init', '--state', path.join(d, `state-${name}`), ...argv)
    assert.equal(r.code, 0, `${name}: ${JSON.stringify(r)}`)
  }
})

test('path の照合（answer --file）: 直した目標の本文の path が repo に実在するのに --target・--input に無ければ拒み、台帳を変えない', async (t) => {
  const { d, state } = setup(t)
  const before = readFileSync(path.join(state, 'build.json'), 'utf8')
  writeFileSync(path.join(d, 'goal-new.md'), '- G1: 値を計算する関数と、その使い方の文書 〔request: 値を計算する関数を作り、使い方を書いてほしい〕\n- G2: src/old.mjs も直す 〔request: 値を計算する関数を作り、使い方を書いてほしい〕\n')
  const r = cli('answer', '--state', state, '--id', 'goal', '--file', path.join(d, 'goal-new.md'))
  assert.equal(r.code, 2, JSON.stringify(r))
  assert.ok(Array.isArray(r.problems) && r.problems.some((p) => p.includes('src/old.mjs')), JSON.stringify(r))
  assert.equal(readFileSync(path.join(state, 'build.json'), 'utf8'), before)
})

// ---------------- 1・7. coverage-audit の関数を import して使う（写しを持たない） ----------------

test('取り込みの形: build の CLI は coverage-audit の ledger-cli.mjs を同じ process で import し、path の照合の写しを持たない', () => {
  const src = readFileSync(path.join(HERE, 'build-cli.mjs'), 'utf8')
  const imports = [...src.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)].map((m) => ({ names: m[1].split(',').map((x) => x.trim().split(/\s+as\s+/)[0]), from: m[2] }))
  const audit = imports.filter((x) => x.from === '../../coverage-audit/scripts/ledger-cli.mjs')
  assert.ok(audit.length, `build-cli.mjs が coverage-audit の ledger-cli.mjs を import する: ${JSON.stringify(imports.map((x) => x.from))}`)
  assert.ok(audit.some((x) => x.names.includes('framePathProblems')), 'framePathProblems を import する')
  for (const f of [path.join(HERE, 'build-cli.mjs'), path.join(HERE, 'build-core.mjs'), WORKFLOW_SOURCE]) {
    const s = readFileSync(f, 'utf8')
    assert.ok(!/function\s+framePathProblems|PATH_TOKEN\s*=/.test(s), `${f} に path の照合の写しを置かない`)
  }
  assert.ok(!/spawnSync\([^)]*ledger-cli/.test(src), 'coverage-audit の CLI を子プロセスで流さない')
})
