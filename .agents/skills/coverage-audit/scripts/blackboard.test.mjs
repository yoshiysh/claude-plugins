// 単位 2 のテスト: claim / submit / query を全ての役に広げ、台帳をブラックボードにする（設計「台帳と見たの記録」の B1〜B6）。
// ここではファイルの段（文脈に収まる分の単位を 1 体に詰める）と、next の args・ingest・query の規則を確かめる。全体の段の意図は intents.test.mjs（単位 3）、
// 本物の Workflow source の返り値と prompt は tests/coverage-audit-blackboard-workflow.test.mjs（単位 4）。
// 役の結果の形と argv は blackboard-fixture.mjs の先頭にまとめてある。CLI は子プロセス（run）で流し、多くの役を流す所だけ in-process（cli）にする。
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import * as core from './ledger-core.mjs'
import { CLI, LENSES, OBLIGATIONS, ROLES, behave, claimedTasks, drive, fileResult, project, run, shellWords, status, workerLoop } from './blackboard-fixture.mjs'
import { passPlan } from './plan-roles.mjs'

const A_MD = '# A\n\n## 保証\nこの文書は台帳の lock を取ってから書き込むことを保証する。\n\n## 補足\n補足の段落の本文の行は、上の保証の理由を述べる。\n'
const B_MD = '# B\n\n## 前提\nこの文書は書き込みが直列になることを前提にする本文の行である。\n'
const C_MJS = '// 書き込みの口\nexport function write(x) {\n  return x // 書き込む値をそのまま返す実装の行\n}\n'
const FILES = { 'a.md': A_MD, 'b.md': B_MD, 'c.mjs': C_MJS }
const TWO_LENSES = [...LENSES, { id: 'L2', name: '境界', procedure: '入力と出力の境界ごとに、扱いが書かれているかを確かめる' }]

// next を流して呼び出しを 1 つ開き、args を返す。
function open(state) {
  const n = run('next', '--state', state)
  assert.equal(n.code, 0, JSON.stringify(n))
  assert.ok(!n.stop, `呼び出しが開かない: ${JSON.stringify(n)}`)
  assert.ok(n.args_path, JSON.stringify(n))
  return { n, args: JSON.parse(readFileSync(n.args_path, 'utf8')) }
}
const claim = (state, call, worker) => run('claim', '--state', state, '--call', call, '--worker', worker)
function submitOf(state, c) {
  const w = shellWords(String(c.submit_cmd || ''))
  assert.ok(w.includes('submit'), `claim の出力に submit_cmd が無い: ${JSON.stringify(c)}`)
  return run(...w.slice(w.indexOf('submit')))
}
const writeResult = (task, r) => { mkdirSync(path.dirname(task.result_path), { recursive: true }); writeFileSync(task.result_path, JSON.stringify(r)) }
const cleanResult = (args) => ({ agents: args.workers.map((w) => ({ role: w.role, label: `worker-${w.id}`, model: w.model, effort: w.effort, ok: true })), tokens: null })
function ingest(state, call, res) {
  const f = path.join(state, `result-${call}-${Math.random().toString(16).slice(2)}.json`)
  writeFileSync(f, JSON.stringify(res))
  return run('ingest', '--state', state, '--call', call, '--result', f)
}
// ファイルの段の担当を 1 つ取る（取れるまで args の worker を順に試す）。
function claimFile(state, args) {
  for (const w of args.workers) {
    const c = claim(state, args.callId, w.id)
    assert.equal(c.code, 0, JSON.stringify(c))
    if (c.tasks && c.tasks.length) return { c, w, task: c.tasks[0] }
  }
  assert.fail(`ファイルの段（kind file）の担当が取れない: ${JSON.stringify(claim(state, args.callId, args.workers[0].id)).slice(0, 300)}`)
}

test('B4 args: next の args は {state, callId, stage, workers} だけ。workers の行は {id, role, model, effort} で、model・effort は roles.json の役の値', async (t) => {
  const { state } = project(t, FILES)
  await passPlan(state)
  const { n, args } = open(state)
  assert.deepEqual(Object.keys(args).sort(), ['callId', 'stage', 'state', 'workers'], `args に台帳の写しや argsSum を載せない: ${Object.keys(args).join(', ')}`)
  assert.equal(args.state, state)
  assert.equal(args.callId, n.call_id)
  assert.ok(Array.isArray(args.workers) && args.workers.length > 0)
  for (const w of args.workers) {
    assert.deepEqual(Object.keys(w).sort(), ['effort', 'id', 'model', 'role'], JSON.stringify(w))
    assert.ok(ROLES[w.role], `roles.json に無い役: ${w.role}`)
    assert.deepEqual([w.model, w.effort], [ROLES[w.role].model, ROLES[w.role].effort], w.role)
  }
  assert.equal(new Set(args.workers.map((w) => w.id)).size, args.workers.length, 'worker の id は重ならない')
  assert.ok(!readFileSync(n.args_path, 'utf8').includes(LENSES[0].procedure), 'args に観点の手続きなど担当が読む文を載せない')
})

test('claim（ファイルの段）: 担当は詰め合わせの単位ごとに 1 つ（ファイルの全文の範囲）と全ての観点と義務（目標・受け入れ基準）の一覧。小さい対象は 1 つの詰め合わせで、他の役の書き込み（事実）は返さない', async (t) => {
  const { state, paths } = project(t, FILES, { lenses: TWO_LENSES })
  await passPlan(state)
  const { args } = open(state)
  assert.equal(args.workers.length, 1, '全体が UNIT_MAX_BYTES 以下なので詰め合わせは 1 つ（1 体）')
  const { c } = claimFile(state, args)
  assert.equal(c.tasks.length, Object.keys(FILES).length, '詰め合わせの単位ごとに 1 担当')
  assert.deepEqual(c.tasks.map((x) => x.unit.path).sort(), Object.values(paths).sort(), '担当は互いに違う単位')
  for (const task of c.tasks) {
    assert.equal(task.kind, 'file')
    assert.equal(typeof task.id, 'string')
    assert.equal(typeof task.result_path, 'string')
    const own = task.unit.path
    assert.equal(task.unit.start, 1)
    assert.equal(task.unit.end, readFileSync(own, 'utf8').split('\n').length, 'ファイルの全文の範囲')
    assert.deepEqual(readFileSync(task.unit.file, 'utf8'), readFileSync(own, 'utf8'), '写しは単位の本文')
    assert.deepEqual(task.lenses.map((l) => l.id), ['L1', 'L2', 'S1'], '観点は一覧で全て渡す（呼ぶ側の観点と標準の観点 S1。当てる単位を選ばない）')
    assert.deepEqual(task.obligations.map((o) => o.id), OBLIGATIONS)
    assert.deepEqual(Object.keys(task).filter((k) => !['id', 'kind', 'result_path', 'unit', 'lenses', 'obligations', 'hints'].includes(k)), [], `事実・根拠など他の役の書き込みを返さない: ${Object.keys(task)}`)
  }
  assert.equal(new Set(c.tasks.map((x) => x.result_path)).size, c.tasks.length, '結果の path は担当ごとに違う')
})

// 1 つで UNIT_MAX_BYTES の半分を超える 3 つのファイル（どの 2 つも 1 つの詰め合わせに収まらない）。
const bigDoc = (n) => `# ${n}\n\n${Array.from({ length: 700 }, (_, i) => `- ${n} の本文の ${String(i).padStart(4, '0')} 行目は、詰め合わせを分ける大きさを作るための行である。`).join('\n')}\n`
test('claim: 詰め合わせが分かれると行も分かれ、並べて流した claim は互いに違う単位を返す（lock で直列にする）', async (t) => {
  const BIG = { 'a.md': bigDoc('A'), 'b.md': bigDoc('B'), 'c.md': bigDoc('C') }
  for (const x of Object.values(BIG)) assert.ok(Buffer.byteLength(x) * 2 > core.UNIT_MAX_BYTES && Buffer.byteLength(x) < core.UNIT_MAX_BYTES)
  const { state } = project(t, BIG)
  await passPlan(state)
  const { args } = open(state)
  assert.equal(args.workers.length, 3, `詰め合わせが 3 つなので 3 体: ${args.workers.length}`)
  const one = (w) => new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, 'claim', '--state', state, '--call', args.callId, '--worker', w.id])
    let out = ''
    p.stdout.on('data', (b) => { out += b })
    p.on('close', () => resolve(JSON.parse(out)))
  })
  const rs = await Promise.all(args.workers.map(one))
  const units = rs.flatMap((r) => (r.tasks || []).map((x) => x.unit.id))
  assert.equal(units.length, 3, JSON.stringify(rs).slice(0, 400))
  assert.equal(new Set(units).size, 3, `同じ単位を 2 体に渡さない: ${units}`)
})

test('submit（ファイルの段）: 観点ごとの「見た」・逐語の引用・義務に結んだ指摘・保証と前提を受理し、単位を seen にして事実を台帳に足す', async (t) => {
  const { state, paths } = project(t, FILES)
  await passPlan(state)
  const { args } = open(state)
  const { c, task } = claimFile(state, args)
  const lines = readFileSync(task.unit.file, 'utf8').split('\n')
  const q = lines.find((l) => l.trim().length >= 14 && !l.startsWith('#'))
  const r = fileResult(task, { facts: () => ({ findings: [{ claim: '根拠の無い主張がある', quote: q }], references: [{ claim: '言い回しが固い', quote: q }], guarantees: [{ subject: '書き込みの順序', quote: q, confidence: 'high' }], premises: [{ subject: '直列の書き込み', quote: q, confidence: 'medium' }] }) })
  writeResult(task, r)
  const s = submitOf(state, c)
  assert.equal(s.code, 0, JSON.stringify(s))
  assert.deepEqual(s.results.map((x) => [x.task, x.ok]), [[task.id, true]], JSON.stringify(s))
  const st = status(state)
  assert.equal(st.units.find((u) => u.id === task.unit.id).state, 'seen')
  const mine = st.facts.filter((f) => f.unit === task.unit.id)
  for (const type of ['finding', 'reference', 'guarantee', 'premise']) assert.ok(mine.some((f) => f.type === type), `事実の type ${type} が無い: ${JSON.stringify(mine)}`)
  assert.ok(mine.every((f) => f.path === task.unit.path))
  assert.ok(Object.values(paths).includes(task.unit.path))
  assert.ok(!st.findings.confirmed.length, 'ファイルの段の指摘は全体の段の判定を通るまで確定しない')
  assert.ok(Array.isArray(st.references) && st.references.some((x) => x.claim === '言い回しが固い'), '参考は status の references で開示する')
  assert.ok(!st.references.some((x) => x.claim === '根拠の無い主張がある'), '参考の一覧に指摘を混ぜない')
})

// 落ちる提出: 照合（逐語の引用・全ての観点の答え・閉じた集合・義務の実在・原因の層）に落ちれば、理由を返して試行に数える。
const BAD = [
  ['観点の答えが欠ける', (r) => ({ ...r, seen: r.seen.slice(1) })],
  ['見たの引用が本文に逐語で無い', (r) => ({ ...r, seen: r.seen.map((x) => ({ ...x, quote: '本文に無い引用の文をここに書いておく' })) })],
  ['見たの答えが閉じた集合の外', (r) => ({ ...r, seen: r.seen.map((x) => ({ ...x, answer: 'ok' })) })],
  ['問題なしに引用が無い', (r) => ({ ...r, seen: r.seen.map((x) => ({ ...x, quote: '' })) })],
  ['指摘の義務が目標・基準に無い', (r) => ({ ...r, findings: [{ ...r.findings[0], obligation: 'G9' }] })],
  ['指摘に義務が無い（参考は references に書く）', (r) => ({ ...r, findings: [{ ...r.findings[0], obligation: undefined }] })],
  ['指摘の確信度が閉じた集合の外', (r) => ({ ...r, findings: [{ ...r.findings[0], confidence: 0.9 }] })],
  ['指摘の原因の層が無い', (r) => ({ ...r, findings: [{ ...r.findings[0], layer: undefined }] })],
  ['found の観点に指摘が無い', (r) => ({ ...r, findings: [] })],
  ['保証に主語が無い', (r) => ({ ...r, guarantees: [{ subject: '', quote: r.seen[1].quote, confidence: 'high' }] })],
  ['保証の義務（任意の obligation）が目標・基準に無い', (r) => ({ ...r, guarantees: [{ subject: '書き込みの順序', quote: r.seen[1].quote, confidence: 'high', obligation: 'G9' }] })],
]
for (const [name, broken] of BAD) {
  test(`submit（ファイルの段）の拒否: ${name}なら ok: false と理由を返し、単位は unseen のまま`, async (t) => {
    const { state } = project(t, FILES, { lenses: TWO_LENSES })
    await passPlan(state)
    const { args } = open(state)
    const { c, task } = claimFile(state, args)
    const lines = readFileSync(task.unit.file, 'utf8').split('\n')
    const q = lines.find((l) => l.trim().length >= 14 && !l.startsWith('#'))
    const good = fileResult(task, { facts: () => ({ findings: [{ claim: '根拠の無い主張がある', quote: q }] }) })
    writeResult(task, broken(good))
    const s = submitOf(state, c)
    assert.equal(s.code, 0, JSON.stringify(s))
    const res = s.results.find((x) => x.task === task.id)
    assert.ok(res && res.ok === false && res.problems.length > 0, JSON.stringify(s))
    assert.equal(status(state).units.find((u) => u.id === task.unit.id).state, 'unseen')
  })
}

test(`submit（ファイルの段）: 落ち続ける単位は試行の上限（MAX_ATTEMPTS = 2）で disclosed にし、理由を status に開示する`, async (t) => {
  assert.equal(core.MAX_ATTEMPTS, 2, '試行の上限は ledger-core の MAX_ATTEMPTS の 2 回（新しい定数を作らない）')
  const { state } = project(t, FILES)
  await passPlan(state)
  const { args } = open(state)
  const { c, w, task } = claimFile(state, args)
  writeResult(task, { ...fileResult(task), seen: [] })
  const s1 = submitOf(state, c)
  assert.equal(s1.results[0].dropped, false)
  const c2 = claim(state, args.callId, w.id)
  assert.equal(c2.tasks[0].id, task.id, '出し終えていない担当は claim し直しても同じ担当を返す')
  writeResult(c2.tasks[0], { ...fileResult(task), seen: [] })
  const s2 = submitOf(state, c2)
  assert.equal(s2.results[0].dropped, true, JSON.stringify(s2))
  const u = status(state).units.find((x) => x.id === task.unit.id)
  assert.equal(u.state, 'disclosed')
  assert.ok(typeof u.reason === 'string' && u.reason.length > 0, `見られなかった理由: ${JSON.stringify(u)}`)
})

test('B1 query: ファイルの段の担当の id では query を拒否し（終了状態 2）、--fact で他の単位の事実を引くことも拒否する。台帳は変えない', async (t) => {
  const { state } = project(t, FILES)
  await passPlan(state)
  const { args } = open(state)
  // 1 つ目の単位を出して事実を台帳に足す。
  const first = claimFile(state, args)
  writeResult(first.task, fileResult(first.task))
  assert.equal(submitOf(state, first.c).code, 0)
  const fact = status(state).facts.find((f) => f.unit === first.task.unit.id)
  assert.ok(fact, '1 つ目の単位の事実がある')
  const second = claimFile(state, args)
  assert.notEqual(second.task.unit.id, first.task.unit.id)
  const before = JSON.stringify(status(state))
  const q1 = run('query', '--state', state, '--call', args.callId, '--worker', second.w.id, '--task', second.task.id)
  assert.equal(q1.code, 2, `ファイルの段は他の単位の書き込みを読まない: ${JSON.stringify(q1)}`)
  const q2 = run('query', '--state', state, '--call', args.callId, '--worker', second.w.id, '--task', second.task.id, '--fact', fact.id)
  assert.equal(q2.code, 2, JSON.stringify(q2))
  assert.equal(JSON.stringify(status(state)), before)
})

test('B4 callId: ingest で閉じた呼び出しの claim・submit・query は終了状態 2 で拒み、台帳を変えない（遅れて届いた書き込み）', async (t) => {
  const { state } = project(t, FILES)
  await passPlan(state)
  const { args } = open(state)
  const { c, w, task } = claimFile(state, args)
  writeResult(task, fileResult(task))
  const g = ingest(state, args.callId, cleanResult(args))
  assert.equal(g.code, 0, JSON.stringify(g))
  const before = JSON.stringify(status(state))
  assert.equal(submitOf(state, c).code, 2, '閉じた呼び出しへの submit')
  assert.equal(claim(state, args.callId, w.id).code, 2, '閉じた呼び出しへの claim')
  assert.equal(run('query', '--state', state, '--call', args.callId, '--worker', w.id, '--task', task.id).code, 2, '閉じた呼び出しへの query')
  assert.equal(JSON.stringify(status(state)), before)
})

test('B3 ingest: --call で呼び出しを指して閉じる。返り値は {agents, tokens} だけで受け付け、違う --call は終了状態 2 で台帳を変えない', async (t) => {
  const { state } = project(t, FILES)
  await passPlan(state)
  const { args } = open(state)
  const before = JSON.stringify(status(state))
  const wrong = ingest(state, 'ffffffffffff', cleanResult(args))
  assert.equal(wrong.code, 2, JSON.stringify(wrong))
  assert.equal(JSON.stringify(status(state)), before)
  const g = ingest(state, args.callId, cleanResult(args))
  assert.equal(g.code, 0, `返り値 {agents, tokens} だけで呼び出しを閉じる: ${JSON.stringify(g)}`)
  assert.equal(status(state).pending, null)
})

test('B3・B5 ingest は呼び出しを閉じるだけ: 返り値に指摘・事実・判定を詰めても、台帳の単位・事実・指摘・参考は ingest の前と同じ（または拒否）', async (t) => {
  const { state } = project(t, FILES)
  await passPlan(state)
  const { args } = open(state)
  for (const w of args.workers) await workerLoop({ state, call: args.callId, worker: w.id, role: w.role }, behave(), [])
  const pick = (s) => JSON.stringify({ units: s.units, facts: s.facts, findings: s.findings, references: s.references })
  const before = pick(status(state))
  const PAD = '返り値に詰めた偽の指摘'
  const g = ingest(state, args.callId, { ...cleanResult(args), status: 'ok', findings: [{ claim: PAD, quote: '偽の引用の文をここに書いておく' }], facts: [{ id: 'F999', type: 'finding', claim: PAD }], judged: [{ intent: 'goal:0', verdict: 'gap' }], workers: [{ worker: 'x', result: { submitted: 99 } }] })
  assert.ok(g.code === 0 || (g.code === 2 && !/受け付けない引数/.test(String(g.error))), `--call を持つ ingest として扱い、詰めた返り値を受け取らないか拒否する: ${JSON.stringify(g)}`)
  const after = status(state)
  if (g.code === 0) assert.equal(pick(after), before, '返り値の中身で台帳を変えない')
  assert.ok(!JSON.stringify(after).includes(PAD))
})

test('持ち越し: 全ての単位を見た後に 1 つのファイルだけが変われば、ファイルの段で取られるのはその単位だけ', async (t) => {
  const { state, paths } = project(t, FILES)
  await passPlan(state)
  const first = await drive(state, behave(), { maxSteps: 1 })
  assert.equal(first.calls.length, 1)
  const st0 = status(state)
  assert.ok(Array.isArray(st0.units) && st0.units.every((u) => u.state === 'seen'), JSON.stringify(st0.units))
  writeFileSync(paths['b.md'], B_MD.replace('前提にする本文の行', '前提にすると書き換えた本文の行'))
  const rest = await drive(state, behave(), { maxSteps: 30 })
  const files = claimedTasks(rest.calls).filter((x) => x.kind === 'file').map((x) => x.unit.path)
  assert.deepEqual([...new Set(files)], [paths['b.md']], `変わっていない単位は読み直さない: ${files}`)
  assert.equal(status(state).units.find((u) => u.path === paths['b.md']).state, 'seen')
})
