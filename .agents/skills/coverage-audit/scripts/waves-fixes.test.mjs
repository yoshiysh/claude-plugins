// 波の実装（d428bd1）への差分の検証の指摘を、直した後の振る舞いとして固めるテスト。
// 2: 波の境目で、閉じた波の claim の 1 回も無い行を agent_missing として残し、同じ呼び出しの振り返りが読む（ingest は二重に足さない）。
// 3: 落ちた呼び出しを流し直すと、今の波（記録した中で最新の、閉じていない波）から続く。
// 4: wave_seq・contexts・target_gaps・repo の無い台帳は、init 以外のコマンドが拒む。
// 6: 環境の失敗は、呼び出しの全ての波で判じる。
// 7: 振り返りが 2 波以上に分かれるとき、先の波で読んだ単位の出来事を作り直さない。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  ROLES, argOf, cli, cliArgvOf, driveScript, project, readArgs, runScript, scriptAgent, status, tmp, wavesOf,
} from './blackboard-fixture.mjs'
import { MAX_ATTEMPTS } from './ledger-core.mjs'
import { standalone } from './launch-fixture.mjs'
import { noProposalAct, planAct } from './plan-roles.mjs'

const QA = 'この文書は台帳の lock を取ってから書き込むことを保証する。'
const QB = 'この文書は lock が書き込みを直列にすることを前提にする。'
const plain = (n) => `# ${n}\n\n## 節\n${n} の節は主張を一つだけ述べる本文の行である。\n`
const FILES = { 'a.md': `# A\n\n## 保証\n${QA}\n`, 'b.md': `# B\n\n## 前提\n${QB}\n`, 'c.md': plain('文書C'), 'd.md': plain('文書D') }
const FACTS = (p) => (path.basename(p) === 'a.md' ? { guarantees: [{ subject: '台帳の lock', quote: QA, confidence: 'high' }] } : path.basename(p) === 'b.md' ? { premises: [{ subject: 'lock', quote: QB, confidence: 'high' }] } : {})
const ledgerFile = (state) => path.join(state, 'ledger.json')
const ledger = (state) => JSON.parse(readFileSync(ledgerFile(state), 'utf8'))
const isJudge = (argv) => argOf(argv, 'stage') === 'global' && argOf(argv, 'model') === ROLES.global_judge.model && argOf(argv, 'effort') === ROLES.global_judge.effort
const eventIds = (text) => [...String(text).matchAll(/\[([^\]]+)\]/g)].map((m) => m[1])

// ---------------- 2. 波の境目の agent_missing を、同じ呼び出しの振り返りが読む ----------------

test('2. 波の境目で、閉じた波の claim の 1 回も無い行を agent_missing として残し、同じ呼び出しの振り返りの単位に入る。ingest は同じ行の agent_missing を二重に足さない', async (t) => {
  const { state } = standalone(t, FILES, { lenses: null })
  assert.equal(cli('config', '--state', state, '--workers', '2').code, 0)
  const retroTexts = []
  const a = planAct({ facts: FACTS, retro: (task) => { retroTexts.push(readFileSync(task.unit.file, 'utf8')); return undefined } })
  const log = []
  const inner = scriptAgent(a, log)
  // 判定役が 2 行ある最初の全体の段の波で、2 行目の役は claim せずに落ちる（1 行目が全ての意図を取る）。
  const seenJudge = new Map()
  let dead = null
  const fn = async (prompt, opts) => {
    const argv = cliArgvOf(prompt, 'claim')
    if (isJudge(argv)) {
      const w = argOf(argv, 'wave')
      const n = (seenJudge.get(w) || 0) + 1
      seenJudge.set(w, n)
      if (n === 2 && !dead) { dead = argOf(argv, 'worker'); throw new Error('時間の上限に当たった') }
    }
    return inner(prompt, opts)
  }
  fn.log = log
  const r = await driveScript(state, fn, { maxSteps: 1 })
  assert.ok(dead, `前提: 判定役が 2 行の全体の段の波がある: ${JSON.stringify([...seenJudge])}`)
  assert.equal(r.steps.length, 1)
  const stages = wavesOf(r.steps, log).map((w) => w.stage)
  assert.ok(stages.includes('retro'), `前提: 落ちた行のある波の後に、同じ呼び出しの振り返りが流れる: ${stages}`)
  const missing = status(state).events.filter((e) => e.kind === 'agent_missing' && new RegExp(`(^|[^0-9A-Za-z])${dead}([^0-9A-Za-z]|$)`).test(e.text))
  assert.equal(missing.length, 1, `落ちた行の agent_missing は 1 件（境目で足し、ingest は二重に足さない）: ${JSON.stringify(status(state).events.filter((e) => e.kind === 'agent_missing'))}`)
  assert.ok(retroTexts.some((x) => eventIds(x).includes(missing[0].id)), `同じ呼び出しの振り返りが、前の波の欠け（${missing[0].id}）を読む`)
})

// ---------------- 3. 落ちた呼び出しを流し直す ----------------

test('3. 落ちた呼び出しを流し直す: 開いた呼び出しの next は今の波（記録した中で最新の、閉じていない波）の args を返し、その args で流し直すと続きから complete まで進む', async (t) => {
  const { state } = project(t, FILES)
  const n1 = cli('next', '--state', state)
  const args1 = readArgs(n1)
  assert.ok(args1.wave, JSON.stringify(args1))
  // 1 回目: 全文レビューの波の後で script が落ちた（新しい波を起動せずに終わった。ingest はまだ）。
  const log = []
  const stopAfterFR = (ret, entry) => (argOf(entry.claim, 'stage') === 'full_review' ? { notes: [] } : ret)
  await runScript(args1, scriptAgent(noProposalAct({ facts: FACTS }), log, { tamper: stopAfterFR }))
  const recorded = log.find((x) => argOf(x.claim, 'stage') === 'full_review').rec.next_wave
  assert.ok(recorded && recorded.rows[0].stage === 'file', `前提: 全文レビューの後の波を記録した: ${JSON.stringify(recorded)}`)
  // 開いた呼び出しの next: 同じ呼び出しで、今の波の args。
  const n2 = cli('next', '--state', state)
  assert.equal(n2.code, 0, JSON.stringify(n2))
  assert.equal(n2.call_id, n1.call_id, '同じ呼び出し')
  assert.equal(n2.step, 'file', `今の波の段: ${JSON.stringify(n2)}`)
  const args2 = readArgs(n2)
  assert.equal(args2.callId, args1.callId)
  assert.equal(String(args2.wave.id), String(recorded.id), '記録した中で最新の、閉じていない波')
  assert.deepEqual(args2.wave.rows, recorded.rows)
  // 流し直すと、続きから complete まで進む（最初の波の行が古い扱いで何も進まずに終わらない）。
  const log2 = []
  const res = await runScript(args2, scriptAgent(noProposalAct({ facts: FACTS }), log2))
  assert.ok(log2.some((x) => (x.rec.submits || []).length), '流し直した役が担当を出す')
  const f = path.join(state, 'result-rerun.json')
  writeFileSync(f, JSON.stringify(res))
  assert.equal(cli('ingest', '--state', state, '--call', args2.callId, '--result', f).code, 0)
  const n3 = cli('next', '--state', state)
  assert.equal(n3.stop, 'complete', `流し直した 1 回で complete: ${JSON.stringify(n3).slice(0, 300)}`)
  assert.equal(status(state).calls.length, 1)
})

test('3. 落ちた呼び出しを流し直す（波の途中で落ちた）: 今の波が閉じていなければ、next はその波の args を返し、流し直すと続きから進む', async (t) => {
  const { state } = project(t, FILES)
  const n1 = cli('next', '--state', state)
  const args1 = readArgs(n1)
  // 1 回目: 全文レビューの波の役が claim する前に落ちた。
  const log = []
  const inner = scriptAgent(noProposalAct({ facts: FACTS }), log)
  const fn = async (prompt, opts) => { if (opts.phase === 'full_review') throw new Error('落ちた'); return inner(prompt, opts) }
  await runScript(args1, fn)
  const n2 = cli('next', '--state', state)
  assert.equal(n2.call_id, n1.call_id)
  assert.equal(n2.step, 'full_review', JSON.stringify(n2))
  const args2 = readArgs(n2)
  assert.equal(args2.wave.rows[0].stage, 'full_review')
  const log2 = []
  const res = await runScript(args2, scriptAgent(noProposalAct({ facts: FACTS }), log2))
  const f = path.join(state, 'result-rerun2.json')
  writeFileSync(f, JSON.stringify(res))
  assert.equal(cli('ingest', '--state', state, '--call', args2.callId, '--result', f).code, 0)
  assert.equal(cli('next', '--state', state).stop, 'complete')
})

// ---------------- 4. 旧い形の台帳は通さない ----------------

for (const key of ['wave_seq', 'contexts', 'target_gaps', 'repo']) {
  test(`4. 旧い形の台帳: ${key} の無い台帳は、init 以外のコマンドが「形式が古い」で拒み、空の値で補わない`, (t) => {
    const { state } = project(t, FILES)
    const L = ledger(state)
    assert.ok(Object.hasOwn(L, key), `前提: 今の init は ${key} を書く`)
    delete L[key]
    const raw = JSON.stringify(L)
    writeFileSync(ledgerFile(state), raw)
    for (const argv of [['status', '--state', state], ['next', '--state', state], ['config', '--state', state, '--workers', '1']]) {
      const r = cli(...argv)
      assert.equal(r.code, 2, `${argv[0]}: ${JSON.stringify(r).slice(0, 200)}`)
      assert.match(String(r.error), /形式が古い/, argv[0])
    }
    assert.equal(readFileSync(ledgerFile(state), 'utf8'), raw, '台帳を補って書き直さない')
  })
}

// ---------------- 6. 環境の失敗は呼び出しの全ての波で判じる ----------------

test('6. 環境の失敗: 呼び出しの前の波に進み（受理・提出）があれば、最後の波で読む役が落ちても fail_streak に数えない', async (t) => {
  const { state } = project(t, FILES)
  const a = noProposalAct({ facts: FACTS, file: () => { throw new Error('読む役が落ちた') } })
  const log = []
  const r = await driveScript(state, scriptAgent(a, log), { maxSteps: 1 })
  const stages = wavesOf(r.steps, log).map((w) => w.stage)
  assert.deepEqual(stages, ['plan', 'full_review', 'file'], `前提: 計画と全文レビューの波に進みがあり、ファイルの段の波で落ちる: ${stages}`)
  const L = ledger(state)
  assert.equal(L.fail_streak, 0, '前の波に進みのあった呼び出しは fail_streak に数えない')
  // 落ちた波で取ったまま出さなかった単位の環境の試行は、波ごとの印で数える（下の「環境の失敗の印は波ごと」が固める）。
})

test('6. 環境の失敗（守り）: どの波にも進みの無い呼び出しは、今のとおり fail_streak に数える', async (t) => {
  const { state } = project(t, FILES)
  // 計画・全文レビューを済ませてから、ファイルの段だけの呼び出しで落とす。
  const first = await driveScript(state, scriptAgent(noProposalAct({ facts: FACTS }), [], { tamper: (ret, e) => (argOf(e.claim, 'stage') === 'full_review' ? { notes: [] } : ret) }), { maxSteps: 1 })
  assert.equal(first.steps.length, 1)
  const log = []
  const r = await driveScript(state, scriptAgent(noProposalAct({ file: () => { throw new Error('読む役が落ちた') } }), log), { maxSteps: 1 })
  assert.deepEqual(wavesOf(r.steps, log).map((w) => w.stage), ['file'])
  assert.equal(ledger(state).fail_streak, 1)
})

// ---------------- 7. 振り返りの作り直しで読み直さない ----------------

test('7. 振り返りが 2 波以上に分かれるとき、先の波で読んだ単位の出来事を作り直さず、新しく増えた出来事（と読まなかった単位）だけを次の波で読む', async (t) => {
  const d = tmp(t)
  const roles = path.join(d, 'roles-small.json')
  // 線 600 バイト: 振り返りの出来事の写しが 2 つの単位（[E1..E3]・[E4, E5]）に分かれ、後の単位に新しい出来事の入る余りがある大きさ。
  writeFileSync(roles, JSON.stringify({ file_reader: { ...ROLES.file_reader, context_tokens: 1200 } }))
  const { state } = standalone(t, FILES, { lenses: null, extra: ['--roles', roles] })
  // 出来事を作る: どのファイルの単位も 1 回目の提出は照合に落ちる。
  const rejectedOnce = new Set()
  const reads = []
  let abandoned = null
  const a = planAct({
    facts: FACTS,
    file: (task) => { if (rejectedOnce.has(task.unit.id)) return undefined; rejectedOnce.add(task.unit.id); return { seen: [], findings: [], references: [], guarantees: [], premises: [] } },
    retro: (task) => {
      const after = !!abandoned && status(state).events.some((e) => e.kind === 'missing_read' && e.text.includes(abandoned))
      reads.push({ unit: task.unit.id, ids: eventIds(readFileSync(task.unit.file, 'utf8')), after })
      if (!abandoned) { abandoned = task.unit.id; return null }
      return undefined
    },
  })
  const log = []
  const r = await driveScript(state, scriptAgent(a, log), { maxSteps: 2 })
  const retroWaves = wavesOf(r.steps, log).filter((w) => w.stage === 'retro')
  assert.ok(retroWaves.length >= 2, `前提: 振り返りが 2 波以上: ${wavesOf(r.steps, log).map((w) => `${w.stage}:${w.rows.length}`)}`)
  assert.ok(retroWaves[0].rows.length >= 2, '前提: 先の振り返りの波は 2 行以上（取り残した行と読んだ行）')
  const before = reads.filter((x) => !x.after)
  const later = reads.filter((x) => x.after)
  assert.ok(later.length >= 1, `前提: 境目の後に振り返りを読む: ${JSON.stringify(reads)}`)
  const readFirst = new Set(before.filter((x) => x.unit !== abandoned).flatMap((x) => x.ids))
  const laterIds = later.flatMap((x) => x.ids)
  assert.ok(readFirst.size >= 1, '前提: 先の波で読んだ単位がある')
  assert.deepEqual(laterIds.filter((id) => readFirst.has(id)), [], '先の波で読んだ単位の出来事を、次の波で読み直さない')
  const miss = status(state).events.find((e) => e.kind === 'missing_read' && e.text.includes(abandoned))
  assert.ok(miss && laterIds.includes(miss.id), '新しく増えた出来事（取り残しの missing_read）を次の波で読む')
  const abandonedIds = before.find((x) => x.unit === abandoned).ids
  assert.ok(abandonedIds.every((id) => laterIds.includes(id)), '読まなかった単位の出来事は次の波で読む')
})

// ---------------- 1（2 回目の検証）. 環境の失敗の印は、締める波ごとに、その波の進みで付ける ----------------

const ONE = { 'a.md': `# A\n\n## 保証\n${QA}\n` }
test('環境の失敗の印は波ごと: 前の波に進みがあっても、後の波で取ったまま出さなかった単位は環境の失敗の試行に数える（fail_streak には数えない）', async (t) => {
  const { state } = project(t, ONE)
  const log = []
  const r = await driveScript(state, scriptAgent(noProposalAct({ facts: FACTS, file: () => { throw new Error('読む役が落ちた') } }), log), { maxSteps: 1 })
  assert.deepEqual(wavesOf(r.steps, log).map((w) => w.stage), ['plan', 'full_review', 'file'], '前提: 計画と全文レビューの波に進みがあり、ファイルの段の波で取ったまま落ちる')
  const L = ledger(state)
  assert.equal(L.fail_streak, 0, '呼び出し全体に進みがあるので fail_streak には数えない')
  const a = Object.values(L.assets).find((x) => !x.retro && !x.context)
  assert.equal(a.attempts, 1)
  assert.equal(a.env_attempts, 1, `進みの無い波で取ったまま出さなかった単位は、環境の失敗の試行: ${JSON.stringify(a)}`)
})

test('環境の失敗の印は波ごと: 環境の失敗が続けば blocked で止まり、開示を抱えたまま complete に進まない。blocked から再開すれば試行が戻り、読み直せる', async (t) => {
  const { state } = project(t, ONE)
  let failing = true
  let failsAfterResume = 0
  const a = noProposalAct({ facts: FACTS, file: (task) => { if (failing) throw new Error('読む役が落ちた'); if (failsAfterResume-- > 0) throw new Error('もう 1 回落ちた'); return undefined } })
  const first = await driveScript(state, scriptAgent(a, []), { maxSteps: 8 })
  assert.equal(first.stop && first.stop.stop, 'blocked', `環境の失敗が続けば blocked: ${JSON.stringify(first.stop).slice(0, 300)}`)
  assert.equal(first.stop.cause, 'failure')
  // 再開: 環境の失敗に数えた試行が全て戻る（前の波に進みがあった呼び出しの試行も環境の失敗に数えたので）。もう 1 回落ちても単位は開示されず、次で読める。
  failing = false
  failsAfterResume = 1
  const once = await driveScript(state, scriptAgent(a, []), { maxSteps: 1 })
  assert.equal(once.steps.length, 1)
  const u = status(state).units[0]
  assert.equal(u.state, 'unseen', `再開の後に 1 回落ちても開示しない（試行が全て戻った）: ${JSON.stringify(u)}`)
  const again = await driveScript(state, scriptAgent(a, []), { maxSteps: 8 })
  assert.equal(again.stop && again.stop.stop, 'complete', `再開で試行が戻り、読み直して complete: ${JSON.stringify(again.stop).slice(0, 300)}`)
  assert.equal(again.stop.coverage.seen, 1, '単位を読んだ')
  assert.deepEqual(again.stop.coverage.disclosed, [], '開示を抱えたまま complete に進まない')
})

// 再開の戻しは、blocked（failure）の直後の next の 1 回だけ。再開の後に開いた呼び出しが閉じた後の next では戻さない。
const readerDown = () => noProposalAct({ facts: FACTS, file: () => { throw new Error('読む役が落ちた') } })
async function blockedByFailure(t) {
  const { state } = project(t, ONE)
  const first = await driveScript(state, scriptAgent(readerDown(), []), { maxSteps: 8 })
  assert.equal(first.stop && first.stop.stop, 'blocked', `前提: 環境の失敗が続けば blocked: ${JSON.stringify(first.stop).slice(0, 300)}`)
  assert.equal(first.stop.cause, 'failure')
  return state
}
const fileUnit = (L) => Object.values(L.assets).find((x) => !x.retro && !x.context)

test('再開の戻しは一度だけ: 再開の後の呼び出しが環境の失敗で閉じたら、次の next は fail_streak と環境の失敗の試行を戻さない', async (t) => {
  const state = await blockedByFailure(t)
  const once = await driveScript(state, scriptAgent(readerDown(), []), { maxSteps: 1 })
  assert.equal(once.steps.length, 1, '前提: 再開で呼び出しを 1 回開いて閉じた')
  const before = ledger(state)
  assert.equal(before.fail_streak, 1, `前提: 再開の後の進みの無い呼び出しを数えた: ${before.fail_streak}`)
  assert.equal(fileUnit(before).env_attempts, 1, `前提: 環境の失敗の試行を数えた: ${JSON.stringify(fileUnit(before))}`)
  const n = cli('next', '--state', state)
  assert.equal(n.code, 0)
  const after = ledger(state)
  assert.equal(after.fail_streak, 1, '再開の後の next では、再開の後に数えた fail_streak を戻さない')
  assert.equal(fileUnit(after).env_attempts, 1, '再開の後の next では、再開の後に数えた環境の失敗の試行を戻さない')
  assert.equal(fileUnit(after).attempts, fileUnit(before).attempts, '再開の後の next では、単位の試行を減らさない')
})

test('再開の後も環境の失敗が続けば、予算の上限まで回らずに再び blocked（cause: failure）で止まる', async (t) => {
  const state = await blockedByFailure(t)
  const r = await driveScript(state, scriptAgent(readerDown(), []), { maxSteps: 8 })
  assert.equal(r.stop && r.stop.stop, 'blocked', `再開の後も環境の失敗が続けば blocked で止まる（${r.steps.length} 回の呼び出しで止まらなかった）: ${JSON.stringify(r.stop).slice(0, 300)}`)
  assert.equal(r.stop.cause, 'failure')
})

test('呼び出しが開いている間の status の stopped は、前の停止（blocked）を示さない', async (t) => {
  const state = await blockedByFailure(t)
  const n = cli('next', '--state', state)
  assert.equal(n.code, 0)
  assert.ok(n.call_id && !n.stop, `前提: 再開で呼び出しを開いた: ${JSON.stringify(n).slice(0, 200)}`)
  assert.equal(status(state).stopped, null, '開いた呼び出しがある間は止まっていない')
})

// ---------------- 2（2 回目の検証）. 振り返りの単位を作り直すときの端のケース ----------------

// 振り返りが 2 波以上に分かれる場面（テスト 7 と同じ）を流す。abandon(ids) が真の単位は読まずに取り残す。
async function retroScene(t, abandon, maxSteps = 2) {
  const d = tmp(t)
  const roles = path.join(d, 'roles-small.json')
  writeFileSync(roles, JSON.stringify({ file_reader: { ...ROLES.file_reader, context_tokens: 1200 } }))
  const { state } = standalone(t, FILES, { lenses: null, extra: ['--roles', roles] })
  const rejectedOnce = new Set()
  const reads = []
  const a = planAct({
    facts: FACTS,
    file: (task) => { if (rejectedOnce.has(task.unit.id)) return undefined; rejectedOnce.add(task.unit.id); return { seen: [], findings: [], references: [], guarantees: [], premises: [] } },
    retro: (task) => {
      const ids = eventIds(readFileSync(task.unit.file, 'utf8'))
      const drop = abandon(ids, reads)
      reads.push({ unit: task.unit.id, ids, dropped: drop })
      return drop ? null : undefined
    },
  })
  const log = []
  const r = await driveScript(state, scriptAgent(a, log), { maxSteps })
  return { state, r, log, reads }
}
const firstOnce = (ids, reads) => !reads.length

test('振り返りの作り直し (a): 作り直した単位の id は、同じ周で読み終えた単位の id と重ならず、読んだ単位の読みの記録は消えない', async (t) => {
  const { state, reads } = await retroScene(t, firstOnce)
  const accepted = reads.filter((x, i) => !x.dropped && reads.findIndex((y) => y.unit === x.unit) === i)
  assert.ok(accepted.length >= 1 && reads.some((x) => x.dropped), `前提: 取り残した単位と読んだ単位がある: ${JSON.stringify(reads)}`)
  // 読んだ単位の id が、後で別の本文の単位として読まれない（重なれば同じ id で違う出来事を読むことになる）。
  for (const x of accepted) {
    const later = reads.filter((y) => y.unit === x.unit && y !== x)
    assert.deepEqual(later.map((y) => y.ids), [], `読み終えた単位の id ${x.unit} を作り直しに使った: ${JSON.stringify(later)}`)
  }
  const units = status(state).retro.units
  for (const x of accepted) {
    const u = units.find((y) => y.id === x.unit)
    assert.ok(u && u.state === 'seen', `読んだ単位の読みの記録が残る: ${x.unit} → ${JSON.stringify(u)}`)
    assert.deepEqual(eventIds(readFileSync(u.file, 'utf8')), x.ids, '読んだ単位の写しは読んだときの出来事のまま')
  }
})

test('振り返りの作り直し (b): どの出来事も、振り返りの単位か events_not_in_retro のどちらかに出る（本文の無い単位で消えない）', async (t) => {
  const { state } = await retroScene(t, firstOnce)
  const s = status(state)
  const inRetro = new Set(s.retro.units.flatMap((u) => eventIds(readFileSync(u.file, 'utf8'))))
  const outside = new Set(s.events_not_in_retro.map((e) => e.id))
  for (const u of s.retro.units) assert.ok(readFileSync(u.file, 'utf8').trim().length > 0, `本文の無い振り返りの単位: ${u.id}`)
  const lost = s.events.filter((e) => e.stage !== 'retro' && !inRetro.has(e.id) && !outside.has(e.id))
  assert.deepEqual(lost.map((e) => e.id), [], `振り返りの単位にも events_not_in_retro にも無い出来事: ${JSON.stringify(lost)}`)
})

test('振り返りの作り直し (c): 作り直した単位の試行は元の単位の試行を引き継ぎ、取り残し続ければ MAX_ATTEMPTS で開示される', async (t) => {
  let target = null
  const abandon = (ids) => { if (!target) target = ids[0]; return ids.includes(target) }
  const { state, reads } = await retroScene(t, abandon, 3)
  const tries = reads.filter((x) => x.ids.includes(target))
  assert.equal(tries.length, MAX_ATTEMPTS, `同じ出来事を含む単位を読ませた回数は MAX_ATTEMPTS（${MAX_ATTEMPTS}）まで: ${JSON.stringify(tries)}`)
  const units = status(state).retro.units
  const holder = units.filter((u) => eventIds(readFileSync(u.file, 'utf8')).includes(target))
  assert.ok(holder.length >= 1 && holder.every((u) => u.state === 'disclosed'), `取り残し続けた出来事の単位は開示される: ${JSON.stringify(holder)}`)
})
