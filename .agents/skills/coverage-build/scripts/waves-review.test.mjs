// 差分の検証（33b475d..a90bb10）の指摘を直した後の振る舞いを固めるテスト。
// 1. 検査の呼び出しは、その波で claim した行が全て返る前に閉じない。検査の台帳の起動の記録の成否は Workflow の起動の結果と一致する。
// 2. 起動されなかった検査の呼び出しを閉じるときは、検査の台帳の会計を増やさない（reframe が keep のときも、段が変わるときも）。
// 3. 順序の門で決定が変わったとき、兄弟の行の提出を黙って捨てない。
// 4. 検査の波でも、受け持ちの外の書き込みを照らす（書かない段と同じ）。
// 5. 検査が limit で止まったとき、build の config（--audit-max-cycles・--audit-max-agents-total）で続けられ、止まった出力に続け方が載る。
// 外から見える口だけに依る: build-cli の next・claim・submit・ingest・config・answer、build.json と検査の台帳（stateDir/audit/state/ledger.json）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { cli as auditCli, fileResult } from '../../coverage-audit/scripts/blackboard-fixture.mjs'
import { act, archResult, auditPos, auditStateOf, claimArgv, cli, driveScript, isAuditStage, setup, specResult, walkTo } from './board-fixture.mjs'

const ledger = (state) => JSON.parse(readFileSync(path.join(state, 'build.json'), 'utf8'))
const auditLedger = (state) => JSON.parse(readFileSync(path.join(auditStateOf(state), 'ledger.json'), 'utf8'))
const writeTask = (task, result) => { mkdirSync(path.dirname(task.result_path), { recursive: true }); writeFileSync(task.result_path, JSON.stringify(result)) }
const ingest = (state, call, agents) => {
  const f = path.join(state, `res-${call}-${Math.random().toString(16).slice(2)}.json`)
  writeFileSync(f, JSON.stringify({ agents, tokens: null }))
  return cli('ingest', '--state', state, '--call', call, '--result', f)
}
const agentOf = (row, wave, ok = true) => ({ role: row.role, label: `${row.role}-${row.id}`, model: row.model, effort: row.effort, ok, stage: row.stage, wave })

// update で、線（100KB）を超える 2 つの対象を持つ台帳（現状の検査のファイルの段が 4 行の波になる）。auditMax は検査の起動数の上限。
async function bigUpdate(t, { auditMax = null } = {}) {
  const { d, repo } = setup(t, { mode: 'update' })
  const big = `${'大きい既にある本文の行です。'.repeat(20)}\n`.repeat(160)
  for (const f of ['x.md', 'y.md']) writeFileSync(path.join(repo, 'src', f), big)
  const state = path.join(d, 'state-big')
  const r = cli('init', '--state', state, '--mode', 'update', '--repo', repo, '--goal', path.join(d, 'goal.md'), '--request', path.join(d, 'request.md'),
    '--target', path.join(repo, 'src', 'x.md'), '--target', path.join(repo, 'src', 'y.md'))
  assert.equal(r.code, 0, JSON.stringify(r))
  const w = await walkTo(state, (wv) => wv.rows[0].stage === 'audit:file')
  assert.ok(w.wave && w.wave.rows.length >= 2, `ファイルの段が 2 行以上の波: ${JSON.stringify(w)}`)
  // 検査の起動数の上限を、ファイルの段の波で尽きる値にする（最初の行が出し終えた claim で、coverage-audit が limit の halt を返す）。
  if (auditMax) assert.equal(auditCli('config', '--state', auditStateOf(state), '--max-agents-total', String(auditMax(w))).code, 0)
  return { d, repo, state, ...w }
}

// ---------------- 1. 検査の呼び出しを、claim した行が返る前に閉じない ----------------

test('1. 検査の呼び出し: 最初の行の claim で coverage-audit が halt を返しても、担当を持つ兄弟の行の submit は受理され、検査の台帳の起動の記録の成否は Workflow の起動の結果と一致する', async (t) => {
  // plan・unit_verify・full_review の 3 行と、ファイルの段の行の数で上限に届く。
  const s = await bigUpdate(t, { auditMax: (w) => 3 + w.wave.rows.length })
  const rows = s.wave.rows
  const claims = rows.map((r) => cli(...claimArgv(s.state, s.call, r, s.wave.id)))
  for (const c of claims) assert.ok(c.code === 0 && c.tasks && c.tasks.length, JSON.stringify(c))
  // 最初の行が出し終えて done を受け取る（coverage-audit は起動数の上限で halt を返す）。
  for (const tk of claims[0].tasks) writeTask(tk, fileResult(tk))
  assert.equal(cli('submit', '--state', s.state, '--call', s.call, '--worker', rows[0].id).code, 0)
  const done0 = cli(...claimArgv(s.state, s.call, rows[0], s.wave.id))
  assert.equal(done0.done, true, JSON.stringify(done0))
  // 兄弟の行は、取った担当を出せる（呼び出しを閉じていない）。
  for (const [i, r] of rows.entries()) {
    if (i === 0) continue
    for (const tk of claims[i].tasks) writeTask(tk, fileResult(tk))
    const sub = cli('submit', '--state', s.state, '--call', s.call, '--worker', r.id)
    assert.equal(sub.code, 0, `${r.id} の submit: ${JSON.stringify(sub)}`)
    assert.ok(sub.results.length && sub.results.every((x) => x.ok), `${r.id} の提出は受理される: ${JSON.stringify(sub.results)}`)
    const dn = cli(...claimArgv(s.state, s.call, r, s.wave.id))
    assert.equal(dn.done, true, JSON.stringify(dn))
  }
  // Workflow の起動の結果: 最後の行の役は返らなかった（ok: false）。検査の台帳にもその成否で残る（claim したことで ok: true と決め打ちしない）。
  const last = rows.at(-1)
  const g = ingest(s.state, s.call, rows.map((r) => agentOf(r, s.wave.id, r !== last)))
  assert.equal(g.code, 0, JSON.stringify(g))
  const files = (auditLedger(s.state).agents || []).filter((a) => a.stage === 'file')
  assert.equal(files.length, rows.length, JSON.stringify(auditLedger(s.state).agents))
  assert.deepEqual(files.map((a) => !!a.ok).sort(), rows.map((r) => r !== last).sort(), `検査の台帳の成否: ${JSON.stringify(files)}`)
})

test('1. 検査の呼び出し（守り）: 全文レビューの役が担当を取ったまま返らなければ、検査の台帳の全文レビューは lost で失敗になる', async (t) => {
  const { state } = setup(t, { mode: 'update' })
  const w = await walkTo(state, (wv) => wv.rows[0].stage === 'audit:full_review')
  assert.ok(w.wave, JSON.stringify(w))
  const row = w.wave.rows[0]
  const c = cli(...claimArgv(state, w.call, row, w.wave.id))
  assert.ok(c.tasks && c.tasks.length, JSON.stringify(c))
  assert.equal(ingest(state, w.call, [agentOf(row, w.wave.id, false)]).code, 0)
  const fr = auditLedger(state).full_review
  assert.equal(fr && fr.cause, 'lost', JSON.stringify(fr))
})

// ---------------- 2. 起動されなかった検査の呼び出しを閉じるときは、検査の台帳を増やさない ----------------

// 検査の台帳の会計（試行・出来事の欠けの種類・calls・fail_streak・全文レビューの試行）。
const acct = (AL) => ({
  attempts: AL.attempts, env_attempts: AL.env_attempts, intent_attempts: AL.intent_attempts, fail_streak: AL.fail_streak, calls: (AL.calls || []).length,
  failures: (AL.events || []).filter((e) => /missing|lost|failed/.test(e.kind)).map((e) => e.kind), full_review_attempts: (AL.full_review && AL.full_review.attempts) || 0,
})
// 現状の検査の最初の波（計画役）を記録したところで、その波を起動せずに build の呼び出しを閉じる。
async function dropFirstAudit(t) {
  const s = setup(t, { mode: 'update' })
  const w = await walkTo(s.state, (wv) => isAuditStage(wv.rows[0].stage))
  assert.ok(w.wave && w.wave.rows[0].stage === 'audit:plan', JSON.stringify(w))
  assert.equal(ingest(s.state, w.call, []).code, 0)
  return { ...s, before: acct(auditLedger(s.state)) }
}
for (const c of [
  {
    name: '同じ段の reframe（keep。制約を足して目標の照合からやり直す）',
    change: (s) => {
      writeFileSync(path.join(s.d, 'constraints-2.md'), '- D1: 依存を足さない 〔decisions: 依存を足さない〕\n- D2: 入力が 1 なら 2 を返す 〔decisions: 入力が 1 なら 2 を返す〕\n')
      assert.equal(cli('answer', '--state', s.state, '--id', 'constraints', '--file', path.join(s.d, 'constraints-2.md')).code, 0)
    },
    phase: 'baseline',
  },
  {
    name: '段が変わる reframe（--audit-phases で現状の検査を外し、設計レビューへ）',
    change: (s) => assert.equal(cli('config', '--state', s.state, '--audit-phases', 'design,impl').code, 0),
    phase: 'design',
  },
]) {
  test(`2. 起動されなかった検査の呼び出しを reframe の前に閉じても、検査の台帳の試行・欠けの出来事・calls・fail_streak・全文レビューの試行を増やさない: ${c.name}`, async (t) => {
    const s = await dropFirstAudit(t)
    c.change(s)
    const w = await walkTo(s.state, (wv) => isAuditStage(wv.rows[0].stage))
    assert.ok(w.wave, JSON.stringify(w))
    assert.equal((auditPos(s.state) || {}).phase, c.phase)
    assert.deepEqual(acct(auditLedger(s.state)), s.before)
  })
}

// ---------------- 3. 順序の門で決定が変わったとき、兄弟の行の提出を黙って捨てない ----------------

test('3. 順序の門: 詳細設計の 2 行の波で、ある行の単位が試行の上限で stuck になっても、兄弟の行が取って書いた単位は受理される（黙って捨てない）', async (t) => {
  const { repo, state } = setup(t)
  const big = `${'大きい既にある本文の行です。'.repeat(20)}\n`.repeat(120)
  mkdirSync(path.join(repo, 'docs'), { recursive: true })
  writeFileSync(path.join(repo, 'docs', 'big1.md'), big)
  writeFileSync(path.join(repo, 'docs', 'big2.md'), big)
  const units = (cover) => [1, 2].map((i) => ({ id: `U${i}`, kind: 'doc', title: `文書 ${i}`, responsibility: '使い方を書く', paths: [`docs/big${i}.md`], tests: [], test_uses: [], depends_on: [], covers: cover }))
  const a = act({ architect: (q) => archResult(q, { patch: () => units(q.cover_ids || []) }) })
  const w = await walkTo(state, (wv) => wv.rows[0].role === 'unit_designer', { a })
  assert.ok(w.wave && w.wave.rows.length === 2, JSON.stringify(w))
  const [r1, r2] = w.wave.rows
  const c1 = cli(...claimArgv(state, w.call, r1, w.wave.id))
  const c2 = cli(...claimArgv(state, w.call, r2, w.wave.id))
  assert.ok(c1.tasks && c2.tasks, JSON.stringify({ c1, c2 }))
  const query = (r, tk) => cli('query', '--state', state, '--call', w.call, '--worker', r.id, '--task', tk.id).inputs
  // 1 行目は照合に落ち続けて上限で諦める（U1 は stuck）。
  for (let i = 0; i < 2; i++) {
    for (const tk of c1.tasks) writeTask(tk, { ...specResult(query(r1, tk)), acceptance: [] })
    cli('submit', '--state', state, '--call', w.call, '--worker', r1.id)
  }
  // 1 行目が done を受け取る（その時の decide は stuck で止まる）。
  assert.equal(cli(...claimArgv(state, w.call, r1, w.wave.id)).done, true)
  // 2 行目は取った担当を書いて出す。
  for (const tk of c2.tasks) writeTask(tk, specResult(query(r2, tk)))
  const sub = cli('submit', '--state', state, '--call', w.call, '--worker', r2.id)
  assert.equal(sub.code, 0, JSON.stringify(sub))
  assert.ok(sub.results.length === c2.tasks.length && sub.results.every((x) => x.ok), `兄弟の行の提出は受理される: ${JSON.stringify(sub)}`)
  const L = ledger(state)
  assert.equal(L.units.U2.need_design, false, 'U2 の詳細設計は受理された')
  assert.ok(L.units.U2.design_hash)
})

// ---------------- 4. 検査の波でも、受け持ちの外の書き込みを照らす ----------------

test('4. 検査の波: 検査の役が単位のファイルを書き換えたら、書かない段と同じく出来事（write_outside）に残し、その単位の実装を書く段で書き直す', async (t) => {
  const { repo, state } = setup(t)
  let wrote = false
  const auditOver = {
    file: () => {
      if (!wrote && (auditPos(state) || {}).phase === 'impl') { wrote = true; writeFileSync(path.join(repo, 'src', 'a.mjs'), 'export const value = 3 // 検査の役が書き換えた行\n') }
      return undefined
    },
  }
  const r = await driveScript(state, act(), { auditOver, maxSteps: 4 })
  assert.ok(wrote, '実装レビューのファイルの段に届いた')
  const L = ledger(state)
  const ev = L.events.filter((e) => e.kind === 'write_outside' && e.text.includes('src/a.mjs'))
  assert.ok(ev.length >= 1, `受け持ちの外の変更の出来事: ${JSON.stringify(L.events.map((e) => [e.kind, e.text]))}`)
  // U1 の実装は、検査の後に実装の担当が書き直す（書き換えた中身のまま受理しない）。
  const implU1 = r.launches.filter((x) => x.role === 'implementer').flatMap((x) => x.rec.queries.filter((q) => q.out.inputs && q.out.inputs.unit && q.out.inputs.unit.id === 'U1'))
  assert.ok(implU1.length >= 2, `U1 の実装を書き直す: ${implU1.length}`)
  assert.doesNotMatch(readFileSync(path.join(repo, 'src', 'a.mjs'), 'utf8'), /検査の役が書き換えた/)
})

// ---------------- 5. 検査が limit で止まったとき、build の口で続けられる ----------------

test('5. 検査の上限: build の config で検査の上限（--audit-max-agents-total・--audit-max-cycles）を渡せ、検査が limit で止まった出力に続け方が載り、上限を上げると next が続く', async (t) => {
  const { state } = setup(t, { mode: 'update' })
  const bad = cli('config', '--state', state, '--audit-max-agents-total', '0')
  assert.equal(bad.code, 2, `正の整数でない値は拒む: ${JSON.stringify(bad)}`)
  assert.equal(cli('config', '--state', state, '--audit-max-cycles', '3').code, 0)
  assert.equal(cli('config', '--state', state, '--audit-max-agents-total', '2').code, 0)
  const r1 = await driveScript(state, act({ arch: { units: 'chain' } }), { maxSteps: 4 })
  assert.equal(r1.stop && r1.stop.stop, 'limit', JSON.stringify(r1.stop))
  const text = JSON.stringify(r1.stop)
  assert.match(text, /coverage-audit|検査/, '検査の上限で止まったことが分かる')
  assert.match(text, /config/, '続け方（build の config）が載る')
  assert.match(text, /--audit-max-agents-total/, '上げる上限の引数が載る')
  assert.equal(cli('config', '--state', state, '--audit-max-agents-total', '400').code, 0)
  const r2 = await driveScript(state, act({ arch: { units: 'chain' } }), { maxSteps: 4 })
  assert.equal(r2.stop && r2.stop.stop, 'complete', JSON.stringify(r2.stop))
})
