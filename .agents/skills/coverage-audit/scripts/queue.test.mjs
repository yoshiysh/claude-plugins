// ファイルの段の担当（claim・submit）と呼び出しの開閉（next・ingest）、lock の契約。
// 単位をファイルにした台帳（設計「台帳と見たの記録」の B1〜B6）の上で、worker が claim で単位を取り、結果を書いて submit_cmd を流す。
// claim・submit・query の形の基本は blackboard.test.mjs が確かめる。ここでは、取り直し・出し直し・戻し・失敗の連続・写しの書き換え・lock を確かめる。
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { C, MAX_ATTEMPTS } from './ledger-core.mjs'
import { withLock } from './ledger-cli.mjs'
import { CLI, behave, cli, drive, fileResult, project, shellWords, status, tmp, workerLoop } from './blackboard-fixture.mjs'
import { passPlan } from './plan-roles.mjs'

const doc = (name) => `# ${name}\n\n## 節\n${name} の節は主張を一つだけ述べる本文の行である。\n二行目も ${name} の主張を補う本文の行として置く。\n`
const files = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`d${i}.md`, doc(`文書${i}`)]))
// 利用者の観点を渡し、目標を照合済みにした台帳。観点を渡しても計画役は足す観点の提案として流れるので、提案しない偽の計画役で計画の段を通し、
// 次の next がファイルの段になる所まで進める。
async function qsetup(t, { n = 2, workers = 3 } = {}) {
  const p = project(t, files(n))
  if (workers != null) { const c = cli('config', '--state', p.state, '--workers', String(workers)); assert.equal(c.code, 0, JSON.stringify(c)) }
  await passPlan(p.state)
  return p
}
const ledger = (state) => JSON.parse(readFileSync(path.join(state, 'ledger.json'), 'utf8'))
const bytes = (state) => readFileSync(path.join(state, 'ledger.json'), 'utf8')
function review(state) {
  const n = cli('next', '--state', state)
  assert.equal(n.code, 0, JSON.stringify(n))
  assert.equal(n.step, 'file', JSON.stringify(n))
  return { n, args: JSON.parse(readFileSync(n.args_path, 'utf8')) }
}
const claim = (state, call, worker) => cli('claim', '--state', state, '--call', call, '--worker', worker)
const submitOf = (c) => { const w = shellWords(c.submit_cmd); return cli(...w.slice(w.indexOf('submit'))) }
const writeResult = (task, obj) => { mkdirSync(path.dirname(task.result_path), { recursive: true }); writeFileSync(task.result_path, JSON.stringify(obj)) }
const unitOf = (state, id) => status(state).units.find((u) => u.id === id)
let seq = 0
const put = (d, obj) => { const f = path.join(d, `res-${++seq}.json`); writeFileSync(f, JSON.stringify(obj)); return f }
const okResult = (args, ok = true) => ({ agents: args.workers.map((w) => ({ role: w.role, label: `worker-${w.id}`, model: w.model, effort: w.effort, ok })), tokens: null })
const ingest = (state, d, args, res = okResult(args)) => cli('ingest', '--state', state, '--call', args.callId, '--result', put(d, res))
const missedBy = (L, kind, id) => L.events.some((e) => e.kind === kind && (e.ref === id || String(e.text).includes(id)))

// 別の node の process で CLI を流す（並べて流すときは Promise.all で同時に走らせる）。
function run(argv, { shell = null } = {}) {
  return new Promise((resolve) => {
    const p = shell ? spawn('sh', ['-c', shell]) : spawn(process.execPath, [CLI, ...argv])
    let out = ''
    let err = ''
    p.stdout.on('data', (b) => { out += b })
    p.stderr.on('data', (b) => { err += b })
    p.on('close', (code) => {
      let j = {}
      try { j = JSON.parse(out) } catch { j = { raw: out, stderr: err } }
      resolve({ code, ...j })
    })
  })
}

// ---------------- workers の行と config --workers ----------------

test('workers: ファイルの段は 1 単位に 1 体で、行は読む単位の数（workers の設定に縛られない）。既定の workers は 4。行は {id, role, model, effort} だけ', async (t) => {
  const five = await qsetup(t, { n: 5, workers: null })
  assert.equal(ledger(five.state).config.workers, 4)
  const rows = review(five.state).args.workers
  assert.equal(rows.length, 5, '単位が workers より多くても、単位の数だけ起動する')
  assert.ok(rows.every((w) => JSON.stringify(Object.keys(w).sort()) === JSON.stringify(['effort', 'id', 'model', 'role'])))
  const two = await qsetup(t, { n: 2, workers: null })
  assert.equal(review(two.state).args.workers.length, 2, '単位より多くは起動しない')
})

test('config --workers: 正の整数で worker の数を変え、次の全体の段の呼び出しの行の数に効く。正の整数でない値と maxAgents を超える値は終了状態 2 で台帳を変えない', async (t) => {
  const { state } = await qsetup(t, { n: 5, workers: null })
  const before = bytes(state)
  for (const v of ['0', '-1', '1.5', 'abc', String(C.LIMITS.maxAgents + 1)]) assert.equal(cli('config', '--state', state, '--workers', v).code, 2, v)
  assert.equal(bytes(state), before, '台帳を変えない')
  assert.equal(cli('config', '--state', state, '--workers', '2').code, 0)
  assert.equal(review(state).args.workers.length, 5, 'ファイルの段は 1 単位に 1 体')
  await drive(state, behave(), { maxSteps: 1 })
  const g = cli('next', '--state', state)
  assert.equal(g.step, 'global', JSON.stringify(g))
  const roles = JSON.parse(readFileSync(g.args_path, 'utf8')).workers.filter((w) => w.role === 'global_judge')
  assert.equal(roles.length, 2, '全体の段の行（主語の照合・指摘・前提・目標）は workers 件')
  assert.equal(cli('config', '--state', state, '--workers', String(C.LIMITS.maxAgents)).code, 0, 'maxAgents ちょうどは受け付ける')
})

// ---------------- claim ----------------

test('claim: 単位の並びの順に、取られていない単位を 1 つずつ渡し、読む単位が残らなければ done', async (t) => {
  const { state, paths } = await qsetup(t, { n: 2, workers: 3 })
  const { args } = review(state)
  const got = args.workers.map((w) => claim(state, args.callId, w.id))
  assert.deepEqual(got.map((c) => c.tasks[0].unit.id), [paths['d0.md'], paths['d1.md']])
  writeResult(got[0].tasks[0], fileResult(got[0].tasks[0]))
  assert.equal(submitOf(got[0]).results[0].ok, true)
  assert.equal(claim(state, args.callId, args.workers[0].id).done, true, '出し終えた worker は次の単位を取らない（1 単位に 1 体）')
})

test('claim の取り直し: 出し終えていない担当を持つ worker の claim は、新しい単位を取らずに同じ担当を返す。返す前に結果の path のファイルを消す', async (t) => {
  const { state } = await qsetup(t)
  const { args } = review(state)
  const w = args.workers[0].id
  const c1 = claim(state, args.callId, w)
  writeResult(c1.tasks[0], { stale: true })
  const c2 = claim(state, args.callId, w)
  assert.deepEqual(c2.tasks, c1.tasks, '同じ担当を同じ形で返す')
  assert.ok(!existsSync(c2.tasks[0].result_path), '古い結果のファイルを消す')
})

test('claim・submit の拒否: 開いた呼び出しが無い・違う --call・workers に無い worker は終了状態 2 で台帳を変えない', async (t) => {
  const { state } = await qsetup(t)
  const before = bytes(state)
  assert.equal(claim(state, 'ffffffffffff', 'f1').code, 2, 'next の前')
  assert.equal(bytes(state), before)
  const { args } = review(state)
  const opened = bytes(state)
  assert.equal(claim(state, 'ffffffffffff', args.workers[0].id).code, 2, '違う --call')
  assert.equal(claim(state, args.callId, 'no-such-worker').code, 2, 'workers に無い worker')
  assert.equal(cli('submit', '--state', state, '--call', args.callId, '--worker', 'no-such-worker').code, 2)
  assert.equal(cli('submit', '--state', state, '--call', args.callId, '--worker', args.workers[0].id, '--cell', 'x').code, 2, '1 枡ずつ出す --cell は無い')
  assert.equal(bytes(state), opened)
})

// ---------------- submit ----------------

test('submit: 結果のファイルの無い担当は missing に挙げ、試行に数えず取ったままにする。後でファイルを書いて流し直すと受け付ける', async (t) => {
  const { state } = await qsetup(t)
  const { args } = review(state)
  const c = claim(state, args.callId, args.workers[0].id)
  const task = c.tasks[0]
  const s1 = submitOf(c)
  assert.deepEqual([s1.results, s1.missing], [[], [task.id]])
  assert.equal(ledger(state).assets[task.unit.id].attempts, 0)
  writeResult(task, fileResult(task))
  const s2 = submitOf(c)
  assert.deepEqual(s2.results.map((r) => [r.task, r.ok]), [[task.id, true]])
  assert.equal(unitOf(state, task.unit.id).state, 'seen')
})

test('submit: 照合に落ちた担当は理由を返して試行に数え、取りを保ち、結果のファイルを CLI が消す。直す前に流し直しても missing で、2 回目の試行に数えない', async (t) => {
  const { state } = await qsetup(t)
  const { args } = review(state)
  const c = claim(state, args.callId, args.workers[0].id)
  const task = c.tasks[0]
  writeResult(task, { ...fileResult(task), seen: [] })
  const s1 = submitOf(c)
  assert.equal(s1.results[0].ok, false)
  assert.ok(s1.results[0].problems.length > 0)
  assert.ok(!existsSync(task.result_path), '落ちた結果のファイルを消す')
  assert.equal(ledger(state).assets[task.unit.id].attempts, 1)
  const s2 = submitOf(c)
  assert.deepEqual(s2.missing, [task.id])
  assert.equal(ledger(state).assets[task.unit.id].attempts, 1)
  assert.ok(MAX_ATTEMPTS > 1)
})

test('submit: 取った後に写しが書き換わったら、終了状態 2 で台帳を変えずに拒否する（偽の引用の拒否と違い、試行に数えない）', async (t) => {
  const { state } = await qsetup(t)
  const { args } = review(state)
  const c = claim(state, args.callId, args.workers[0].id)
  const task = c.tasks[0]
  writeResult(task, fileResult(task))
  writeFileSync(task.unit.file, readFileSync(task.unit.file, 'utf8').replace('主張を一つだけ', '主張を二つだけ'))
  const before = bytes(state)
  assert.equal(submitOf(c).code, 2)
  assert.equal(bytes(state), before)
})

test('submit_cmd: claim が返す submit_cmd を shell でそのまま流すと、取った担当の結果を受け付ける', { skip: process.platform === 'win32' }, async (t) => {
  const { state } = await qsetup(t)
  const { args } = review(state)
  const c = claim(state, args.callId, args.workers[0].id)
  writeResult(c.tasks[0], fileResult(c.tasks[0]))
  const s = await run([], { shell: c.submit_cmd })
  assert.equal(s.code, 0, JSON.stringify(s))
  assert.deepEqual(s.results.map((r) => r.ok), [true])
})

// ---------------- 戻し（取ったまま提出されなかった担当） ----------------

test('next の冪等: 開いた呼び出しがある間の next は同じ callId と同じ args を返し、取りを外さない。前に取った担当はそのまま提出でき、閉じるのは ingest だけ', async (t) => {
  const { d, state } = await qsetup(t)
  const { n, args } = review(state)
  const raw = readFileSync(n.args_path, 'utf8')
  const c = claim(state, args.callId, args.workers[0].id)
  const again = review(state)
  assert.equal(again.n.call_id, n.call_id)
  assert.equal(again.n.args_path, n.args_path)
  assert.equal(readFileSync(again.n.args_path, 'utf8'), raw, 'args は同じバイト列')
  const L = ledger(state)
  assert.deepEqual(L.assets[c.tasks[0].unit.id].claim, { call: args.callId, worker: args.workers[0].id }, '取りを外さない')
  assert.equal(L.assets[c.tasks[0].unit.id].attempts, 0, '試行に数えない')
  writeResult(c.tasks[0], fileResult(c.tasks[0]))
  assert.deepEqual(submitOf(c).results.map((r) => r.ok), [true], '流し直しの前に取った担当を提出できる')
  assert.equal(ingest(state, d, args).code, 0)
  assert.notEqual(review(state).n.call_id, n.call_id, 'ingest で閉じた後の next は新しい呼び出し')
})

test('戻し: 取ったまま提出されない単位は呼び出しを閉じる ingest で試行に数え、MAX_ATTEMPTS に届いたら見られなかった理由つきの disclosed にする。閉じた呼び出しの claim は拒む', async (t) => {
  const { d, state } = await qsetup(t, { n: 1, workers: 1 })
  let id = null
  let last = null
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    const { args } = review(state)
    id = claim(state, args.callId, args.workers[0].id).tasks[0].unit.id
    assert.equal(ingest(state, d, args).code, 0)
    assert.ok(missedBy(ledger(state), 'missing_read', id))
    last = args
  }
  assert.equal(claim(state, last.callId, last.workers[0].id).code, 2)
  const u = unitOf(state, id)
  assert.equal(u.state, 'disclosed')
  assert.match(u.reason, /提出しなかった/)
})

test('戻し（ingest）: その呼び出しの ingest が、提出されなかった担当の取りを外して試行に数える。提出を受けた呼び出しなので全件失敗には数えない', async (t) => {
  const { d, state } = await qsetup(t, { n: 2, workers: 2 })
  const { args } = review(state)
  const c0 = claim(state, args.callId, args.workers[0].id)
  writeResult(c0.tasks[0], fileResult(c0.tasks[0]))
  assert.equal(submitOf(c0).code, 0)
  const c1 = claim(state, args.callId, args.workers[1].id)
  const g = ingest(state, d, args)
  assert.equal(g.code, 0, JSON.stringify(g))
  const L = ledger(state)
  assert.equal(L.assets[c1.tasks[0].unit.id].attempts, 1)
  assert.equal(L.assets[c1.tasks[0].unit.id].claim, null)
  assert.equal(L.fail_streak, 0)
})

test('提出が 1 件も無い呼び出し: 全ての役が欠けた呼び出しと同じく fail_streak と env_attempts に数え、続けば blocked（failure）。直して再開すれば試行が戻り完了する', async (t) => {
  const { d, state } = await qsetup(t, { n: 1, workers: 1 })
  for (let i = 0; i < 2; i++) {
    const { args } = review(state)
    claim(state, args.callId, args.workers[0].id)
    assert.equal(ingest(state, d, args).code, 0)
  }
  const n = cli('next', '--state', state)
  assert.equal(n.stop, 'blocked', JSON.stringify(n))
  assert.equal(n.cause, 'failure')
  const { stop } = await drive(state, behave())
  assert.equal(stop.stop, 'complete', JSON.stringify(stop))
  assert.ok(status(state).units.every((u) => u.state === 'seen'), '環境の失敗に数えた試行は戻り、開示に倒さない')
})

test('worker: workers の行ごとに claim を done まで流すと、1 回の呼び出しで全ての単位が seen になる', async (t) => {
  const { d, state } = await qsetup(t, { n: 3, workers: 2 })
  const { args } = review(state)
  for (const w of args.workers) await workerLoop({ state, call: args.callId, worker: w.id, role: w.role }, behave(), [])
  assert.equal(ingest(state, d, args).code, 0)
  assert.ok(status(state).units.every((u) => u.state === 'seen'))
  assert.equal(cli('next', '--state', state).step, 'global', 'ファイルの段の後は全体の段')
})

// ---------------- lock ----------------

test('lock: 並べて流した claim は互いに違う単位を返し、並べて流した submit は全て台帳に残る（失われた更新が無い）', async (t) => {
  const { state } = await qsetup(t, { n: 6, workers: 6 })
  const { args } = review(state)
  const cs = await Promise.all(args.workers.map((w) => run(['claim', '--state', state, '--call', args.callId, '--worker', w.id])))
  assert.equal(new Set(cs.map((c) => c.tasks[0].unit.id)).size, 6)
  for (const c of cs) writeResult(c.tasks[0], fileResult(c.tasks[0]))
  const ss = await Promise.all(cs.map((c) => run([], { shell: c.submit_cmd })))
  assert.ok(ss.every((s) => s.code === 0 && s.results[0].ok), JSON.stringify(ss))
  assert.ok(status(state).units.every((u) => u.state === 'seen'))
})

test('lock: 並べて流した hint は互いに違う id を受け取る', async (t) => {
  const { state } = await qsetup(t)
  const outs = await Promise.all(Array.from({ length: 6 }, (_, i) => run(['hint', '--state', state, '--text', `ヒント ${i}`])))
  for (const o of outs) assert.equal(o.code, 0, JSON.stringify(o))
  assert.equal(new Set(outs.map((o) => o.id)).size, outs.length)
})

// 生きた lock も古い lock も消さずに上限まで待って止まり、古い lock のときだけ手で消す案内を出す。2 つのケースは別の stateDir で同時に流す（待ちは 10 秒のまま）。
const LOCK_AGES = [
  { name: '生きた lock（mtime が 60 秒より新しい）', content: String(process.pid), ageSec: 0, maxCycles: '9', stale: false },
  { name: '古い lock（mtime が 60 秒より前）', content: 'x', ageSec: 120, maxCycles: '6', stale: true },
]
test('lock: 生きた lock でも古い lock でも消さず、待つ時間が上限（10 秒）を超えたら Fail（終了状態 2）で、台帳を変えない。古い lock のときだけ手で消す案内を出す', { timeout: 60000 }, async (t) => {
  const cases = await Promise.all(LOCK_AGES.map(async (c) => {
    const { state } = await qsetup(t)
    const lock = path.join(state, 'ledger.lock')
    writeFileSync(lock, c.content)
    if (c.ageSec) { const old = (Date.now() - c.ageSec * 1000) / 1000; utimesSync(lock, old, old) }
    return { ...c, state, lock, before: bytes(state) }
  }))
  const outs = await Promise.all(cases.map(async (c) => {
    const t0 = Date.now()
    const r = await run(['config', '--state', c.state, '--max-cycles', c.maxCycles])
    return { r, took: Date.now() - t0 }
  }))
  cases.forEach((c, i) => {
    const { r, took } = outs[i]
    assert.equal(r.code, 2, `${c.name}: ${JSON.stringify(r)}`)
    assert.ok(took >= 9000, `${c.name}: 上限まで待つ（${took} ms）`)
    assert.ok(took < 30000, `${c.name}: 上限を超えて待たない（${took} ms）`)
    assert.equal(bytes(c.state), c.before, `${c.name}: 台帳を変えない`)
    assert.ok(existsSync(c.lock), `${c.name}: lock を消さない`)
    assert.equal(readFileSync(c.lock, 'utf8'), c.content, `${c.name}: lock を取り直さない`)
    assert.ok(r.error.includes(c.lock), `${c.name}: lock の path を示す: ${r.error}`)
    if (c.stale) {
      for (const w of ['落ちた process', 'CLI が動いていない', '手で消']) assert.ok(r.error.includes(w), `${c.name}: 案内に「${w}」: ${r.error}`)
    } else {
      assert.ok(r.error.includes('他の process が台帳を書いている'), `${c.name}: ${r.error}`)
      for (const w of ['手で消', '落ちた process']) assert.ok(!r.error.includes(w), `${c.name}: 案内を出さない「${w}」: ${r.error}`)
    }
  })
})

test('lock: コマンドは成功しても失敗しても lock を残さない', async (t) => {
  const { state } = await qsetup(t)
  const lock = path.join(state, 'ledger.lock')
  const c = cli('config', '--state', state, '--max-cycles', '5')
  assert.equal(c.code, 0, JSON.stringify(c))
  assert.equal(ledger(state).config.max_cycles, 5)
  assert.ok(!existsSync(lock), '成功の後に lock を残さない')
  const { n } = review(state)
  assert.ok(!existsSync(lock))
  assert.equal(claim(state, n.call_id, 'no-such-worker').code, 2)
  assert.ok(!existsSync(lock), 'Fail の後にも lock を残さない')
})

// finally の時点の lock の中身ごとに、消すか・fn の結果を通すかを確かめる。
const BOOM = new Error('boom')
const LOCK_ENDS = [
  { name: '自分の token のまま', act: () => {}, left: null },
  { name: '他の中身に上書き', act: (lock) => writeFileSync(lock, 'other'), left: () => 'other' },
  { name: '自分の token の末尾に文字を足した中身に上書き', act: (lock) => writeFileSync(lock, `${readFileSync(lock, 'utf8')}z`), left: (seen) => `${seen}z` },
  { name: 'fn の中で消す', act: (lock) => rmSync(lock), left: null },
  { name: '他の中身に上書きして fn が投げる', act: (lock) => { writeFileSync(lock, 'other'); throw BOOM }, left: () => 'other', throws: BOOM },
]
for (const c of LOCK_ENDS) {
  test(`withLock: finally の lock の中身が「${c.name}」のとき、自分の token と完全に一致するときだけ消し、fn の結果をそのまま通す`, (t) => {
    const dir = tmp(t)
    const lock = path.join(dir, 'ledger.lock')
    let seen = null
    const fn = () => { seen = readFileSync(lock, 'utf8'); c.act(lock); return 'value' }
    if (c.throws) assert.throws(() => withLock(dir, fn), (e) => e === c.throws, 'fn が投げた例外をそのまま投げる')
    else assert.equal(withLock(dir, fn), 'value')
    if (c.left === null) assert.ok(!existsSync(lock), 'lock は無い')
    else assert.equal(readFileSync(lock, 'utf8'), c.left(seen), 'lock はその中身のまま残る')
  })
}

test('withLock: lock には取得ごとに違う、空でない token を書く', async (t) => {
  const dir = tmp(t)
  const lock = path.join(dir, 'ledger.lock')
  const seen = [withLock(dir, () => readFileSync(lock, 'utf8')), withLock(dir, () => readFileSync(lock, 'utf8'))]
  for (const s of seen) assert.ok(typeof s === 'string' && s.length > 0, JSON.stringify(seen))
  assert.notEqual(seen[0], seen[1])
})


test('全体の段: claim が 1 度も無い呼び出し（worker が起動されなかった）が続けば blocked（failure）で、同じ呼び出しを開き続けない', async (t) => {
  const { d, state } = await qsetup(t, { n: 2, workers: 2 })
  await drive(state, behave(), { maxSteps: 1 })
  for (let i = 0; i < 2; i++) {
    const n = cli('next', '--state', state)
    assert.equal(n.step, 'global', JSON.stringify(n))
    assert.equal(ingest(state, d, JSON.parse(readFileSync(n.args_path, 'utf8'))).code, 0)
  }
  const n = cli('next', '--state', state)
  assert.equal(n.stop, 'blocked', JSON.stringify(n))
  assert.equal(n.cause, 'failure')
})

test('ヒント（全体の段）: ファイルの段の後に足したヒントは、次の呼び出しの意図の担当に届き、ingest の後に既読になる', async (t) => {
  const { state } = await qsetup(t, { n: 2, workers: 2 })
  await drive(state, behave(), { maxSteps: 1 })
  assert.equal(cli('hint', '--state', state, '--text', '主語の照合は慎重に').code, 0)
  const r = await drive(state, behave(), { maxSteps: 1 })
  const tasks = r.calls[0].workers.flatMap((w) => w.claims.flatMap((c) => c.tasks || []))
  assert.equal(r.calls[0].next.step, 'global')
  assert.ok(tasks.length && tasks.every((x) => x.intent && (x.hints || []).some((h) => h.text === '主語の照合は慎重に')), JSON.stringify(tasks.map((x) => x.hints)))
  assert.ok(ledger(state).hints_read.includes('H1'))
})
