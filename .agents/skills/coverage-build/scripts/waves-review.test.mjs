// 差分の検証（33b475d..a90bb10）の指摘を直した後の振る舞いを固めるテスト。
// 1. 検査の呼び出しは、その波で claim した行が全て返る前に閉じない。検査の台帳の起動の記録の成否は Workflow の起動の結果と一致する。
// 2. 起動されなかった検査の呼び出しを閉じるときは、検査の台帳の会計を増やさない（reframe が keep のときも、段が変わるときも）。
// 3. 順序の門で決定が変わったとき、兄弟の行の提出を黙って捨てない。
// 4. 検査の波でも、受け持ちの外の書き込みを照らす（書かない段と同じ）。
// 5. 検査が limit で止まったとき、build の config（--audit-max-cycles・--audit-max-agents-total）で続けられ、止まった出力に続け方が載る。
// 外から見える口だけに依る: build-cli の next・claim・submit・ingest・config・answer、build.json と検査の台帳（stateDir/audit/state/ledger.json）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { cli as auditCli, fileResult } from '../../coverage-audit/scripts/blackboard-fixture.mjs'
import { UNIT_MAX_BYTES } from '../../coverage-audit/scripts/ledger-core.mjs'
import { act, archResult, auditPos, auditStateOf, claimArgv, cli, driveScript, isAuditStage, setup, specResult, walkTo, workerLoop } from './board-fixture.mjs'

const ledger = (state) => JSON.parse(readFileSync(path.join(state, 'build.json'), 'utf8'))
const auditLedger = (state) => JSON.parse(readFileSync(path.join(auditStateOf(state), 'ledger.json'), 'utf8'))
const writeTask = (task, result) => { mkdirSync(path.dirname(task.result_path), { recursive: true }); writeFileSync(task.result_path, JSON.stringify(result)) }
const ingest = (state, call, agents) => {
  const f = path.join(state, `res-${call}-${Math.random().toString(16).slice(2)}.json`)
  writeFileSync(f, JSON.stringify({ agents, tokens: null }))
  return cli('ingest', '--state', state, '--call', call, '--result', f)
}
const agentOf = (row, wave, ok = true) => ({ role: row.role, label: `${row.role}-${row.id}`, model: row.model, effort: row.effort, ok, stage: row.stage, wave })

// fixture の大きさは線の既定（UNIT_MAX_BYTES）に比例させる（100KB の線で作った大きさの倍率）。
const S = UNIT_MAX_BYTES / 100000
// update で、線を超える 2 つの対象を持つ台帳（現状の検査のファイルの段が 4 行の波になる）。auditMax は検査の起動数の上限。
async function bigUpdate(t, { auditMax = null } = {}) {
  const { d, repo } = setup(t, { mode: 'update' })
  const big = `${'大きい既にある本文の行です。'.repeat(20)}\n`.repeat(160 * S)
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
  const big = `${'大きい既にある本文の行です。'.repeat(20)}\n`.repeat(120 * S)
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

// ---------------- B. 閉じた検査の呼び出しの起動の記録は、その呼び出しの段に数える ----------------

test('B. 現状の検査を止まった時点で閉じた後、同じ build の呼び出しで設計レビューへ段が変わっても、閉じた呼び出しの起動の記録・calls・agent_missing を設計レビューの段に数えず、build の振り返りに同じ欠けを 2 件入れない', async (t) => {
  const { d, repo } = setup(t, { mode: 'update' })
  const big = `${'大きい既にある本文の行です。'.repeat(20)}\n`.repeat(160 * S)
  for (const f of ['x.md', 'y.md']) writeFileSync(path.join(repo, 'src', f), big)
  const state = path.join(d, 'state-b')
  assert.equal(cli('init', '--state', state, '--mode', 'update', '--repo', repo, '--goal', path.join(d, 'goal.md'), '--request', path.join(d, 'request.md'),
    '--target', path.join(repo, 'src', 'x.md'), '--target', path.join(repo, 'src', 'y.md')).code, 0)
  // 現状の検査のファイルの段の 1 行は、担当を出し終えた後に返らない（起動の記録は ok: false）。兄弟の行が次の波を運び、検査は complete まで進む。
  // 同じ呼び出しで方式設計・詳細設計の後に設計レビューの計画役の波まで流し、その次の波を起動せずに呼び出しを閉じる（設計レビューの途中で ingest）。
  let failed = null
  let dropped = false
  const phaseNow = () => (auditPos(state) || {}).phase
  const r1 = await driveScript(state, act({ arch: { units: 'chain' } }), {
    maxSteps: 1,
    failAgent: (e) => { if (!failed && e.stage === 'audit:file' && phaseNow() === 'baseline') { failed = e.label; return true } return false },
    tamper: (ret, e) => { if (!dropped && e.stage === 'audit:plan' && phaseNow() === 'design') { dropped = true; return { notes: [] } } return ret },
  })
  assert.ok(failed && dropped, `現状の検査の行を落とし、設計レビューの途中で閉じた: ${r1.launches.map((x) => x.stage)}`)
  const AL = auditLedger(state)
  assert.equal(AL.phase, 'design')
  const lost = AL.agents.findIndex((a) => !a.ok)
  assert.ok(lost >= 0, `検査の台帳に落ちた起動の記録がある: ${JSON.stringify(AL.agents)}`)
  const baselineCall = AL.agents[lost].call_id
  const mine = AL.agents.map((a, i) => [a, i]).filter(([a]) => a.call_id === baselineCall)
  assert.ok(mine.every(([, i]) => i < AL.phase_start.agents), `閉じた現状の検査の呼び出しの起動の記録を、設計レビューの起動数（phase_start.agents ${AL.phase_start.agents} から後）に数えない: ${JSON.stringify(mine.map(([a, i]) => [i, a.stage, a.ok]))}`)
  const call = (AL.calls || []).find((c) => c.call_id === baselineCall)
  assert.ok(call, '閉じた呼び出しの calls は残る')
  assert.notEqual(call.cycle, AL.phase_start.cycle, `閉じた呼び出しの calls は設計レビューの段（周 ${AL.phase_start.cycle}）に数えない: ${JSON.stringify(call)}`)
  assert.ok(!AL.events.slice(AL.phase_start.events).some((e) => e.kind === 'agent_missing'), `設計レビューの段の出来事に、現状の検査の欠けを入れない: ${JSON.stringify(AL.events.slice(AL.phase_start.events))}`)
  assert.equal(AL.fail_streak, 0)
  // 続けて complete まで進めても、build の振り返りに同じ欠けの agent_missing は 1 件（build のものと、検査の audit_internal の写しの 2 件にしない）。
  const r2 = await driveScript(state, act({ arch: { units: 'chain' } }), { maxSteps: 4 })
  assert.equal(r2.stop && r2.stop.stop, 'complete', JSON.stringify(r2.stop))
  const L = ledger(state)
  const missing = L.events.filter((e) => e.kind === 'agent_missing' || (e.kind === 'audit_internal' && /agent_missing/.test(e.text)))
  assert.equal(missing.length, 1, `同じ欠けを 1 件だけ: ${JSON.stringify(missing.map((e) => [e.kind, e.text]))}`)
})

// ---------------- D. 検査の波の進み（fail_streak と blocked） ----------------
// 呼び出しの最初の波が検査の段 st の波のとき、その波の役の手の付け方で、build の台帳の進みの無い呼び出し（fail_streak）に数えるかが決まる:
// 全文レビューは手を付けなくても進みとする・全体の段は claim か受理・読む段（file）は提出・計画の段は受理。2 回続けば blocked（failure）。
// retro・unit_verify の段は build から届かない（build は観点を渡し、目標を照合済みにして検査を始める）ので、ここでは扱わない。
// 道具: update の 1 回目の呼び出しを、段 st の波を記録した claim の返り値を halt に書き換えて閉じ、次の next が開く呼び出しの最初の波を段 st の波にする。
async function firstWaveAt(t, st) {
  const { state } = setup(t, { mode: 'update' })
  let cut = false
  const tamper = (ret) => (Array.isArray(ret.rows) && ret.rows.length && ret.rows[0].stage === `audit:${st}` ? ((cut = true), { notes: [], halt: true }) : ret)
  const r1 = await driveScript(state, act(), { maxSteps: 1, tamper })
  assert.ok(cut, `1 回目の呼び出しで段 ${st} の波を記録した: ${r1.launches.map((x) => x.stage)}`)
  assert.equal(ledger(state).fail_streak, 0, '1 回目の呼び出しは進みがある')
  const n = cli('next', '--state', state)
  assert.equal(n.code, 0, JSON.stringify(n))
  const args = JSON.parse(readFileSync(n.args_path, 'utf8'))
  assert.equal(args.wave.rows[0].stage, `audit:${st}`, `2 回目の呼び出しの最初の波は段 ${st}: ${JSON.stringify(args.wave.rows)}`)
  return { state, args }
}
// 波の最初の行が、手の付け方 how（none: claim しない・claim: claim だけ・reject: claim して照合に落ちる結果を出す）で動き、呼び出しを閉じる。
function playAndIngest(state, args, how) {
  const row = args.wave.rows[0]
  if (how !== 'none') {
    const c = cli(...claimArgv(state, args.callId, row, args.wave.id))
    assert.equal(c.code, 0, JSON.stringify(c))
    assert.ok(c.tasks && c.tasks.length, `担当を取る: ${JSON.stringify(c)}`)
    if (how === 'reject') {
      for (const task of c.tasks) writeTask(task, {})
      const s = cli('submit', '--state', state, '--call', args.callId, '--worker', row.id)
      assert.equal(s.code, 0, JSON.stringify(s))
      assert.ok(s.results.length && s.results.every((x) => !x.ok), `照合に落ちる: ${JSON.stringify(s.results)}`)
    }
  }
  const g = ingest(state, args.callId, args.wave.rows.map((w) => agentOf(w, args.wave.id)))
  assert.equal(g.code, 0, JSON.stringify(g))
}
for (const c of [
  { st: 'full_review', how: 'none', streak: 0, why: '全文レビューは手を付けなくても進み' },
  { st: 'global', how: 'claim', streak: 0, why: '全体の段は claim で進み' },
  { st: 'global', how: 'none', streak: 1, why: '全体の段で claim も受理も無ければ進みなし' },
  { st: 'file', how: 'reject', streak: 0, why: '読む段は提出（照合に落ちても）で進み' },
  { st: 'file', how: 'claim', streak: 1, why: '読む段で提出が無ければ進みなし' },
  { st: 'plan', how: 'reject', streak: 1, why: '計画の段は受理が無ければ、提出があっても進みなし' },
]) {
  test(`D. 検査の波の進み: 段 ${c.st} の波だけの呼び出しで、役が ${c.how} なら fail_streak は ${c.streak}（${c.why}）`, async (t) => {
    const { state, args } = await firstWaveAt(t, c.st)
    playAndIngest(state, args, c.how)
    assert.equal(ledger(state).fail_streak, c.streak)
  })
}
test('D. 検査の波の進み: 進みの無い検査の波だけの呼び出しが 2 回続けば、next は blocked（failure）で止まる', async (t) => {
  const { state, args } = await firstWaveAt(t, 'plan')
  playAndIngest(state, args, 'reject')
  assert.equal(ledger(state).fail_streak, 1)
  const n = cli('next', '--state', state)
  assert.equal(n.code, 0, JSON.stringify(n))
  const args2 = JSON.parse(readFileSync(n.args_path, 'utf8'))
  assert.equal(args2.wave.rows[0].stage, 'audit:plan', JSON.stringify(args2.wave.rows))
  playAndIngest(state, args2, 'reject')
  assert.equal(ledger(state).fail_streak, 2)
  const stop = cli('next', '--state', state)
  assert.equal(stop.stop, 'blocked', JSON.stringify(stop))
  assert.equal(stop.cause, 'failure', JSON.stringify(stop))
  assert.ok((stop.reasons || []).some((x) => /提出が 1 件も無い呼び出しが 2 回続いた/.test(x)), `build の台帳の進みの無い呼び出しで止まる: ${JSON.stringify(stop.reasons)}`)
})

// ---------------- A. 検査の台帳を直に読み書きする経路の拒否も、build の CLI の終了状態で返す ----------------
// build の CLI が coverage-audit の関数（lock・読み込み・保存）を直に流す経路で、検査の台帳の lock の待ちが切れたら終了状態 3（流し直す）、
// 検査の台帳を読めない（形式が古い）なら終了状態 2 と ok: false で返す。どちらもスタックを出さず（終了状態 1 にしない）、build の台帳を変えない。
// 経路 1: 詳細設計の波の最後の claim が、次の波（設計レビュー）を作るときに検査の台帳の枠を差し替える（開いた検査の呼び出しを閉じる）。
// 経路 2: ingest が、同じ呼び出しで止まった時点で閉じた検査の呼び出しの起動の記録を直す。
const stackFree = (r) => assert.ok(!/\n\s+at /.test(String(r.error)), `スタックを出さない（終了状態 1 の形にしない）: ${r.error}`)
const auditLedgerBytes = (state) => readFileSync(path.join(auditStateOf(state), 'ledger.json'), 'utf8')
const buildBytes = (state) => readFileSync(path.join(state, 'build.json'), 'utf8')
// update の現状の検査を終えて、詳細設計の波の手前まで進める（検査の台帳はあり、build の台帳の検査の枠は外れている = 次の検査の段は枠を差し替える）。
async function toSpecWave(t) {
  const { state } = setup(t, { mode: 'update' })
  const w = await walkTo(state, (wv) => wv.rows.some((r) => r.role === 'unit_designer'))
  assert.ok(w.wave, `詳細設計の波まで進む: ${JSON.stringify(w)}`)
  assert.ok(existsSync(path.join(auditStateOf(state), 'ledger.json')), '検査の台帳がある')
  assert.equal(ledger(state).audit_frame, null, '現状の検査を取り込んで枠は外れている（次の検査は枠を差し替える）')
  return { state, ...w }
}
// 波の行を偽の役で流し、claim ごとに前後の build の台帳を控える。0 以外で返った claim の記録を返す。
async function runSpecRows(state, call, wave) {
  const calls = []
  const exec = (...argv) => {
    const before = argv[0] === 'claim' ? buildBytes(state) : null
    const r = cli(...argv)
    if (argv[0] === 'claim') calls.push({ argv, before, after: buildBytes(state), r })
    return r
  }
  for (const row of wave.rows) await workerLoop({ state, call, worker: row.id, role: row.role, argv: claimArgv(state, call, row, wave.id) }, act(), exec)
  return calls.filter((c) => c.r.code !== 0)
}
test('A. 検査の台帳の lock の待ちが切れたら（経路 1: 枠の差し替え）、claim は終了状態 3 で build の台帳も検査の台帳も変えず、lock が空いた後に流し直せば設計レビューの波へ進む', { timeout: 60000 }, async (t) => {
  const { state, call, wave } = await toSpecWave(t)
  const lock = path.join(auditStateOf(state), 'ledger.lock')
  writeFileSync(lock, 'other-process-token')
  const audit0 = auditLedgerBytes(state)
  const bad = await runSpecRows(state, call, wave)
  assert.equal(bad.length, 1, `次の波を作る claim だけが拒まれる: ${JSON.stringify(bad.map((c) => c.r))}`)
  const [c] = bad
  assert.equal(c.r.code, 3, JSON.stringify(c.r))
  assert.equal(c.r.ok, false)
  stackFree(c.r)
  assert.equal(c.after, c.before, 'build の台帳を変えない')
  assert.equal(auditLedgerBytes(state), audit0, '検査の台帳を変えない')
  assert.equal(readFileSync(lock, 'utf8'), 'other-process-token', '他の process の lock を奪わない')
  rmSync(lock)
  const again = cli(...c.argv)
  assert.equal(again.code, 0, JSON.stringify(again))
  assert.equal(again.done, true, JSON.stringify(again))
  assert.ok(again.next_wave && isAuditStage(again.next_wave.rows[0].stage), `流し直すと設計レビューの波を返す: ${JSON.stringify(again)}`)
})

test('A. 検査の台帳の形式が古ければ（経路 1: 枠の差し替え）、claim は終了状態 2 と ok: false で理由を返し、build の台帳を変えない', async (t) => {
  const { state, call, wave } = await toSpecWave(t)
  const f = path.join(auditStateOf(state), 'ledger.json')
  const AL = JSON.parse(readFileSync(f, 'utf8'))
  delete AL.full_review
  writeFileSync(f, JSON.stringify(AL))
  const audit0 = auditLedgerBytes(state)
  const bad = await runSpecRows(state, call, wave)
  assert.equal(bad.length, 1, `次の波を作る claim だけが拒まれる: ${JSON.stringify(bad.map((c) => c.r))}`)
  const [c] = bad
  assert.equal(c.r.code, 2, JSON.stringify(c.r))
  assert.equal(c.r.ok, false)
  stackFree(c.r)
  assert.match(String(c.r.error), /形式が古い/)
  assert.equal(c.after, c.before, 'build の台帳を変えない')
  assert.equal(auditLedgerBytes(state), audit0, '検査の台帳を変えない')
})

test('A. 検査の台帳の形式が古ければ（経路 2: 止まった時点で閉じた検査の呼び出しの記録を直す ingest）、ingest は終了状態 2 と ok: false で返し、build の台帳を変えない', async (t) => {
  const { state } = setup(t, { mode: 'update' })
  const w = await walkTo(state, (wv) => wv.rows.some((r) => r.role === 'architect'))
  assert.ok(w.wave, `方式設計の波まで進む: ${JSON.stringify(w)}`)
  const P = ledger(state).pending
  assert.ok((P.audit_calls || []).some((x) => x.closed && x.recorded_at && !x.recorded), `同じ呼び出しで止まった時点で閉じた検査の呼び出しがある: ${JSON.stringify(P.audit_calls)}`)
  const f = path.join(auditStateOf(state), 'ledger.json')
  const AL = JSON.parse(readFileSync(f, 'utf8'))
  delete AL.full_review
  writeFileSync(f, JSON.stringify(AL))
  const agents = P.launched.flatMap((W) => W.workers.map((row) => agentOf(row, W.id)))
  const before = buildBytes(state)
  const g = ingest(state, w.call, agents)
  assert.equal(g.code, 2, JSON.stringify(g))
  assert.equal(g.ok, false)
  stackFree(g)
  assert.match(String(g.error), /形式が古い/)
  assert.equal(buildBytes(state), before, 'build の台帳を変えない')
})
