// 台帳の決定的な部分（ledger-core）と、ファイルの段・計画の段の流れ（ledger-cli）。単位をファイルにした台帳（設計「台帳と見たの記録」の B1〜B6）の上で、
// 役の偽物が claim・query・submit で台帳と読み書きする（blackboard-fixture の drive・behave）。計画の段の役の偽物は、このファイルの planAct が
// query の inputs から作る（plan-roles.mjs）。全体の段の意図は intents.test.mjs、Workflow script は tests/ が確かめる。
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { C, MAX_ATTEMPTS, UNIT_MAX_BYTES, factId, jsHeads, retroAssets, splitAssets } from './ledger-core.mjs'
import { WF, behave, claimedTasks, cli, drive, fileResult, project, status, tmp } from './blackboard-fixture.mjs'
import { asIntegrated, goalsOfQ, lensPlan, onePlan, passPlan, planAct, unitAnswers } from './plan-roles.mjs'

const ledger = (state) => JSON.parse(readFileSync(path.join(state, 'ledger.json'), 'utf8'))
const doc = (name) => `# ${name}\n\n## 節\n${name} の節は主張を一つだけ述べる本文の行である。\n二行目も ${name} の主張を補う本文の行として置く。\n`
const TWO = { 'a.md': doc('一つ目の文書'), 'b.md': doc('二つ目の文書') }
const THREE = { ...TWO, 'c.md': doc('三つ目の文書') }
const REQUEST = '対象の文書を観点ごとにレビューしてほしい'
const steps = (calls) => calls.map((c) => c.next.step)
// 呼び出しごとの記録の後に台帳の計画の欠陥を写す（drive の onCall）。
const recordDefects = (state, out) => async (rec) => { out.push({ step: rec.next.step, defects: ledger(state).plan_defects }) }

// 計画役を走らせる台帳（利用者の観点を渡さない）。目標は coverage-build から照合済みで渡す。criteria は受け入れ基準の行（無ければ渡さない）。
const planned = (t, files = TWO, { criteria = null } = {}) => project(t, files, { lenses: null, goal: '- G1: 対象の文書の見落としを確かめた指摘の一覧\n', criteria })

// 単位の切り方の規則（1 ファイル 1 単位・上限・id・hash・覆い方）は unit.test.mjs が確かめる。ここでは境目の見つけ方の頑健さを確かめる。
// 範囲は 1 始まり・両端を含み、単位の本文はその範囲の行そのもの。単位はファイルを隙間も重なりもなく覆う。
const coversAll = (text, xs) => {
  const lines = text.split('\n')
  const sorted = [...xs].sort((a, b) => a.start - b.start)
  assert.equal(sorted[0].start, 1)
  for (let i = 1; i < sorted.length; i++) assert.equal(sorted[i].start, sorted[i - 1].end + 1, `${sorted[i - 1].id} → ${sorted[i].id} に隙間も重なりも無い`)
  assert.equal(sorted[sorted.length - 1].end, lines.length)
  for (const x of xs) assert.equal(x.text, lines.slice(x.start - 1, x.end).join('\n'), `${x.id} の本文は範囲の行`)
}

test('単位の境目（Markdown）: 分ける大きいファイルでも、code fence の中の # の行では切らず、fence の後の本当の見出しでは切れる', () => {
  // fence の中に # で始まる行を多く持つ節を並べ、上限の数倍にする。
  const sec = (i) => [`## 節 ${i}`, '', '```sh', ...Array.from({ length: 40 }, (_, k) => `# 注釈の行 ${i}-${k} は見出しではなく、コードの中のコメントである`), '```', '', `節 ${i} の fence の後の本文の行は、ここに続けて書く。`, ''].join('\n')
  const head = '# 文書\n\n'
  let text = head
  for (let i = 0; Buffer.byteLength(text, 'utf8') < 3 * UNIT_MAX_BYTES; i++) text += sec(i)
  const xs = splitAssets('/x/doc.md', text)
  assert.ok(xs.length > 1, '上限を超えるので分ける')
  coversAll(text, xs)
  const lines = text.split('\n')
  for (const x of xs) {
    assert.ok(Buffer.byteLength(x.text, 'utf8') <= UNIT_MAX_BYTES, x.id)
    assert.match(lines[x.start - 1], /^#{1,2} (文書|節 \d+)$/, `${x.id} は fence の外の見出しの行から始まる: ${lines[x.start - 1]}`)
    assert.ok(!x.id.includes('注釈'), x.id)
  }
})

test('単位の境目（JS・MJS）: テンプレート文字列とブロックコメントの中の、行頭から始まる function・export・const の行は境目にしない', () => {
  const src = [
    'const T = `', //  1
    'function notReal() {}', //  2
    'export const notX = 1', //  3
    'const notY = 2', //  4
    '`', //  5
    '', //  6
    '/*', //  7
    'export function notZ() {}', //  8
    'const notW = 3', //  9
    '*/', // 10
    '', // 11
    'function real() {', // 12
    '  return T', // 13
    '}', // 14
    '',
  ].join('\n')
  const heads = jsHeads(src.split('\n'))
  const names = heads.map((h) => h.name)
  for (const bad of ['notReal', 'notX', 'notY', 'notZ', 'notW']) assert.ok(!names.includes(bad), `${bad} は宣言でない（${names.join(',')}）`)
  assert.deepEqual(heads.map((h) => [h.name, h.start]), [['T', 0], ['real', 11]], '境目は T（1 行目）と real（12 行目）だけ（空行を挟むブロックコメントは real に含めない）')
  for (const rel of ['/x/t.js', '/x/t.mjs']) assert.deepEqual(splitAssets(rel, src).map((x) => [x.id, x.start, x.end]), [[rel, 1, 15]], `${rel}: 収まるファイルは 1 単位`)
})

test('単位の境目（JS）: この repo の coverage-audit.js は宣言の名前で境目が取れ、行頭から始まる長いテンプレート文字列の中に境目を作らない', () => {
  const text = readFileSync(WF, 'utf8')
  const heads = jsHeads(text.split('\n'))
  const names = heads.map((h) => h.name).filter(Boolean)
  assert.equal(heads[0].name, 'meta')
  assert.equal(heads[0].start, 0)
  for (const k of ['meta', 'LIMITS', 'quoteProblem', 'COMMON', 'GUIDES', 'launch']) assert.ok(names.includes(k), `${k} の境目がある（${names.slice(0, 12).join(',')}…）`)
  // 行頭から始まるテンプレート文字列の中の行で切っていれば、宣言でない語が名前になる。名前は全て、本文の行頭の宣言の名前。
  const declared = new Set([...text.matchAll(/^(?:export\s+)?(?:async\s+)?(?:function\s*\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]))
  for (const n of names) assert.ok(declared.has(n), `${n} は宣言の名前`)
  const xs = splitAssets(WF, text)
  if (Buffer.byteLength(text, 'utf8') <= UNIT_MAX_BYTES) assert.deepEqual(xs.map((x) => x.id), [WF], '収まるので 1 ファイル 1 単位')
  else coversAll(text, xs)
})

test('単位の境目（境目の無い所）: 宣言も見出しも無い大きいファイルは空行・行の境目で分け、各単位は上限以下で隙間なく覆う', () => {
  const text = Array.from({ length: Math.ceil((3 * UNIT_MAX_BYTES) / 60) }, (_, i) => `// line ${i} は境目の無いファイルを埋める行である`).join('\n')
  for (const rel of ['/x/n.js', '/x/a.txt']) {
    const xs = splitAssets(rel, text)
    assert.ok(xs.length > 1, rel)
    coversAll(text, xs)
    assert.ok(xs.every((x) => Buffer.byteLength(x.text, 'utf8') <= UNIT_MAX_BYTES), rel)
    assert.equal(new Set(xs.map((x) => x.id)).size, xs.length, `${rel}: id は重ならない`)
  }
})

test('振り返りの単位: 多数の出来事は 1 段でも本文が UNIT_MAX_BYTES に収まるよう行の境目で分ける', () => {
  const filler = 'の読みが返らなかった出来事の説明を長く書いた本文である'.repeat(20)
  const events = Array.from({ length: 300 }, (_, i) => ({ id: `E1-${i + 1}`, cycle: 1, stage: 'review', kind: 'missing_read', text: i === 7 ? `二行に渡る出来事 ${i}\n続きの行` : `枡 ${i} ${filler}` }))
  const ra = retroAssets({ cycle: 1, events })
  assert.ok(ra.length > 1, '上限を超える出来事は分ける')
  assert.equal(new Set(ra.map((a) => a.id)).size, ra.length)
  assert.ok(ra.every((a) => Buffer.byteLength(a.text, 'utf8') <= UNIT_MAX_BYTES && a.retro === true && a.start === 1))
  assert.equal(ra.reduce((n, a) => n + a.text.split('\n').length, 0), 300, '1 出来事 1 行で、全ての出来事がどれかの資産にある')
  assert.ok(ra.some((a) => a.text.includes('二行に渡る出来事 7 / 続きの行')))
  assert.ok(events.every((e) => e.retro === 1))
  const one = retroAssets({ cycle: 2, events: [{ id: 'E2-1', cycle: 2, stage: 'plan', kind: 'blocked', text: '計画の段が止まった出来事' }] })
  assert.deepEqual(one.map((a) => [a.id, a.start, a.end]), [['retro:c2:plan', 1, 1]])
})

test('引用の照合: code fence の中の # で始まる行は見出しと見なさず引用でき、fence の外の見出しだけの引用は今のまま拒否する', () => {
  const text = '## 外の見出しの文字列はここに十分な長さで\n```sh\n# 設定の例を示すコメントの行である\necho hi\n```\n本文の行はここに十分な長さで続いていく。'
  assert.equal(C.quoteProblem('# 設定の例を示すコメントの行である', text), null)
  assert.equal(C.quoteProblem('設定の例を示すコメントの行である', text), null)
  assert.match(C.quoteProblem('外の見出しの文字列はここに十分な長さで', text), /見出しだけ/)
})

test('引用の照合: 短い・無い・見出しだけは読んだ証拠にならず、行番号は外して照らす', () => {
  const text = '# 見出しの文字列はここに十分な長さで\n本文の一行目はこのように続いていく。'
  assert.match(C.quoteProblem('短い', text), /字未満/)
  assert.match(C.quoteProblem('本文に無い長い文字列をここに書く', text), /逐語で無い/)
  assert.match(C.quoteProblem('見出しの文字列はここに十分な長さで', text), /見出しだけ/)
  assert.equal(C.quoteProblem('2| 本文の一行目はこのように', text), null)
  assert.equal(C.quoteProblem('     2\t本文の一行目はこのように', text), null, 'Read の行番号の形も外す')
  const short = '前の行の本文はここまでの長さで続く。\n  記録と持ち越し  \n後の行の本文はここからの長さで続く。'
  assert.equal(C.quoteProblem('記録と持ち越し', short), null, '範囲の空でない 1 行の全体なら短くてよい')
  assert.equal(C.quoteProblem('82| 記録と持ち越し', short), null, '行番号を付けた 1 行の全体も同じ')
  assert.match(C.quoteProblem('記録と持ち', short), /字未満/, '行の一部の短い引用は拒否する')
  assert.match(C.quoteProblem('前の行の本文', short), /字未満/, '長い行の一部の短い引用も拒否する')
})

// ---------------- 事実の id ----------------

test('事実の id: 単位・種類・引用・主張から決まり、同じ中身は同じ id、引用か主張が違えば別の事実になる（数え上げの番号を使わない）', async (t) => {
  const q = 'この文書の本文の行は事実の id を確かめるための引用である。'
  const base = { quote: q, claim: '根拠の無い主張がある', obligation: 'G1', lens: 'L1' }
  assert.equal(factId('/x/a.md', 'finding', base), factId('/x/a.md', 'finding', { ...base, quote: `  ${q}\n` }), '空白の違いは同じ（C.norm で照らす）')
  for (const other of [{ ...base, quote: `${q}続き` }, { ...base, claim: '別の主張がある' }, { ...base, obligation: 'G2' }]) assert.notEqual(factId('/x/a.md', 'finding', base), factId('/x/a.md', 'finding', other))
  assert.notEqual(factId('/x/a.md', 'finding', base), factId('/x/b.md', 'finding', base), '単位が違えば別')
  assert.notEqual(factId('/x/a.md', 'finding', base), factId('/x/a.md', 'reference', base), '種類が違えば別')
  // 2 つの台帳で同じ対象を同じように読むと、同じ事実の id の集合になる。
  const facts = () => ({ findings: [{ claim: '根拠の無い主張がある', quote: '一つ目の文書 の節は主張を一つだけ述べる本文の行である。' }, { claim: '別の主張がある', quote: '一つ目の文書 の節は主張を一つだけ述べる本文の行である。' }] })
  const { d, state, paths } = project(t, { 'a.md': doc('一つ目の文書') })
  const state2 = path.join(d, 'state2')
  assert.equal(cli('init', '--state', state2, '--goal', path.join(d, 'goal.md'), '--request', path.join(d, 'request.md'), '--criteria', path.join(d, 'criteria.md'), '--lenses', path.join(d, 'lenses.json'), '--target', paths['a.md'], '--goal-checked', 'coverage-build').code, 0)
  const ids = []
  for (const s of [state, state2]) {
    await drive(s, behave({ facts }))
    ids.push(status(s).facts.filter((f) => f.origin === 'file').map((f) => f.id).sort())
  }
  assert.deepEqual(ids[0], ids[1])
  assert.equal(ids[0].filter((id) => id).length, new Set(ids[0]).size)
})

// ---------------- ファイルの段の流れ ----------------

test('正常: ファイルの段で全ての単位を読み、complete。役ごとのモデル・effort を起動と受理した読みに記録する', async (t) => {
  const { state } = project(t, THREE)
  // 観点を渡しても計画役は提案として流れる。提案しない偽の計画役で計画の段を通してから、ファイルの段に進む。
  await passPlan(state)
  const { stop, calls } = await drive(state, behave())
  assert.equal(stop.stop, 'complete', JSON.stringify(stop))
  assert.deepEqual(steps(calls)[0], 'file')
  assert.ok(steps(calls).slice(1).every((s) => s === 'global'), `ファイルの段の後は全体の段: ${steps(calls)}`)
  const L = ledger(state)
  assert.ok(Object.values(L.assets).every((a) => a.state === 'seen' && a.read && a.read.role === 'file_reader' && a.read.model && a.read.effort))
  assert.ok(L.agents.length > 0 && L.agents.every((a) => a.model === L.roles[a.role].model && a.effort === L.roles[a.role].effort))
  assert.ok(L.agents.filter((a) => a.stage === 'file').every((a) => a.role === 'file_reader'))
  assert.deepEqual(stop.coverage.pending, [])
  assert.equal(stop.coverage.seen, 3)
})

test('欠測: 返らない単位は試行を数え、上限で理由つきの disclosed にし、他の単位は読んで complete（開示した単位を完了から隠さない）', async (t) => {
  const { state, paths } = project(t, THREE)
  const act = behave({ file: (task) => (task.unit.path === paths['b.md'] ? null : undefined) })
  const { stop } = await drive(state, act)
  assert.equal(stop.stop, 'complete', JSON.stringify(stop))
  assert.deepEqual(stop.disclosed, [paths['b.md']])
  const b = status(state).units.find((u) => u.path === paths['b.md'])
  assert.equal(b.state, 'disclosed')
  assert.ok(b.reason.length > 0)
  assert.equal(ledger(state).assets[paths['b.md']].attempts, MAX_ATTEMPTS)
})

test('全件失敗: 全ての役が欠けた呼び出しが続けば blocked（failure）で complete にしない', async (t) => {
  const { state } = project(t, TWO)
  const { stop } = await drive(state, () => null)
  assert.equal(stop.stop, 'blocked', JSON.stringify(stop))
  assert.equal(stop.cause, 'failure')
})

test('持ち越し: 対象のファイルが消えたら blocked（input）で、読めない対象を返す', async (t) => {
  const { state, paths } = project(t, TWO)
  assert.equal((await drive(state, behave())).stop.stop, 'complete')
  writeFileSync(paths['a.md'], doc('書き換えた文書'))
  const { rmSync } = await import('node:fs')
  rmSync(paths['b.md'])
  const n = cli('next', '--state', state)
  assert.equal(n.stop, 'blocked', JSON.stringify(n))
  assert.equal(n.cause, 'input')
  assert.match(n.reasons.join(), /b\.md/)
})

test('ヒント: 次の呼び出しのファイルの段の担当に届き、ingest の後に既読になる', async (t) => {
  const { state, paths } = project(t, TWO)
  await passPlan(state)
  assert.equal(cli('hint', '--state', state, '--text', '二つ目の文書は特に慎重に').code, 0)
  const first = await drive(state, behave(), { maxSteps: 1 })
  const tasks = claimedTasks(first.calls).filter((x) => x.kind === 'file')
  assert.ok(tasks.length && tasks.every((x) => (x.hints || []).some((h) => h.text === '二つ目の文書は特に慎重に')))
  assert.deepEqual(ledger(state).hints_read, ['H1'])
  writeFileSync(paths['a.md'], doc('書き換えた文書'))
  const second = await drive(state, behave(), { maxSteps: 1 })
  assert.ok(claimedTasks(second.calls).every((x) => !x.hints), '既読のヒントは渡さない')
})

test('ingest: native Workflow の出力ファイル（result に包んだ形）をそのまま受け付け、包みに似た形は包みとして外さない', (t) => {
  for (const [wrap, n] of [[(r) => ({ result: r, summary: '要約', agentCount: r.agents.length }), 1], [(r) => ({ result: r, summary: 1 }), 0]]) {
    const { d, state } = project(t, TWO)
    const nx = cli('next', '--state', state)
    const args = JSON.parse(readFileSync(nx.args_path, 'utf8'))
    const f = path.join(d, `wrapped-${n}.json`)
    writeFileSync(f, JSON.stringify(wrap({ agents: [{ role: args.workers[0].role, label: 'w', model: 'm', effort: 'e', ok: true }], tokens: 5 })))
    const g = cli('ingest', '--state', state, '--call', args.callId, '--result', f)
    assert.equal(g.code, 0, JSON.stringify(g))
    assert.equal(ledger(state).calls.at(-1).agents, n, n ? '包みを外して起動の記録を読む' : '包みに似た形は外さない')
  }
})

test('ingest: 受け付けなかった提出があれば、その理由を出力の rejected に載せる（受け付けたときは載せない）', async (t) => {
  const { state } = project(t, TWO)
  await passPlan(state)
  let bad = true
  const act = behave({ file: (task) => { if (!bad) return undefined; bad = false; return { ...fileResult(task), seen: [] } } })
  const r = await drive(state, act, { maxSteps: 1 })
  assert.ok(r.calls[0].ingest.rejected.some((x) => /答え（seen）が無い/.test(x)), JSON.stringify(r.calls[0].ingest))
  const { state: s2 } = project(t, TWO)
  await passPlan(s2)
  const ok = await drive(s2, behave(), { maxSteps: 1 })
  assert.equal(ok.calls[0].ingest.rejected, undefined)
})

// ---------------- init と目標 ----------------

test('init: 外した引数（--mode・--input・--k など）と読めない対象は台帳を作らずに拒否する', (t) => {
  const { d, paths } = project(t, TWO)
  const base = ['--goal', path.join(d, 'goal.md'), '--request', path.join(d, 'request.md'), '--target', paths['a.md']]
  for (const extra of [['--mode', 'review'], ['--input', paths['a.md']], ['--artifact', path.join(d, 'x.md')], ['--k', '1']]) {
    const s2 = path.join(d, `state${extra[0]}`)
    assert.equal(cli('init', '--state', s2, ...base, ...extra).code, 2, extra[0])
    assert.ok(!existsSync(path.join(s2, 'ledger.json')))
  }
  const s3 = path.join(d, 'state-missing')
  const r = cli('init', '--state', s3, ...base, '--target', path.join(d, 'nothing.md'))
  assert.equal(r.code, 2)
  assert.equal(r.cause, 'input')
  assert.ok(!existsSync(path.join(s3, 'ledger.json')))
})

test('数の引数: 正の整数でない上限は init も config も Fail（終了状態 2）で、台帳を変えない', (t) => {
  const { d, state, paths } = project(t, TWO)
  const base = ['--goal', path.join(d, 'goal.md'), '--request', path.join(d, 'request.md'), '--target', paths['a.md']]
  for (const [k, v] of [['max-cycles', '0'], ['max-cycles', '-1'], ['max-cycles', '1.5'], ['max-agents-total', 'NaN'], ['max-agents-total', '1e2'], ['max-cycles', '']]) {
    const s2 = path.join(d, `state-${k}-${v}`)
    assert.equal(cli('init', '--state', s2, ...base, `--${k}`, v).code, 2, `${k}=${v}`)
    assert.ok(!existsSync(path.join(s2, 'ledger.json')), `${k}=${v} で台帳を作らない`)
  }
  const before = readFileSync(path.join(state, 'ledger.json'), 'utf8')
  for (const [k, v] of [['max-cycles', '0'], ['max-agents-total', 'NaN'], ['max-cycles', '2.5'], ['workers', '-1']]) assert.equal(cli('config', '--state', state, `--${k}`, v).code, 2, `${k}=${v}`)
  assert.equal(readFileSync(path.join(state, 'ledger.json'), 'utf8'), before, '台帳を変えない')
  assert.equal(cli('config', '--state', state, '--max-cycles', '7').config.max_cycles, 7)
})

test('init: 引用の無い項目と、依頼文・決定の記録に無い引用を拒否し、台帳を作らない', (t) => {
  const { d, paths } = project(t, TWO)
  const base = (s) => ['--state', path.join(d, s), '--request', path.join(d, 'request.md'), '--target', paths['a.md']]
  writeFileSync(path.join(d, 'g-none.md'), '- G1: 対象の文書の見落としを観点ごとに確かめた指摘の一覧\n')
  writeFileSync(path.join(d, 'g-fake.md'), '- G1: 指摘の一覧 〔request: 依頼文のどこにも無い架空の一文である〕\n')
  writeFileSync(path.join(d, 'g-ok.md'), `- G1: 指摘の一覧 〔request: ${REQUEST}〕\n`)
  writeFileSync(path.join(d, 'c-fake.md'), '- D1: 本文を直さない 〔decisions: 本文を直さない〕\n')
  for (const [s, extra, re] of [['none', ['--goal', path.join(d, 'g-none.md')], /G1: 引用が無い/], ['fake', ['--goal', path.join(d, 'g-fake.md')], /逐語で無い/], ['nodec', ['--goal', path.join(d, 'g-ok.md'), '--constraints', path.join(d, 'c-fake.md')], /D1: 引用元が/]]) {
    const r = cli('init', ...base(s), ...extra)
    assert.equal(r.code, 2, s)
    assert.match(JSON.stringify(r.problems), re, s)
    assert.ok(!existsSync(path.join(d, s, 'ledger.json')))
  }
  writeFileSync(path.join(d, 'decisions.md'), '- 本文を直さない\n')
  assert.equal(cli('init', ...base('dec'), '--goal', path.join(d, 'g-ok.md'), '--constraints', path.join(d, 'c-fake.md'), '--decisions', path.join(d, 'decisions.md')).code, 0, '決定の記録の 1 行の全体は短くても引ける')
})

test('引用の短さ: 依頼文の空でない 1 行の全体は短くても引ける。行の一部は引けない', (t) => {
  const { d, paths } = project(t, TWO)
  writeFileSync(path.join(d, 'request.md'), `${REQUEST}。\n\n  直してやり直す  \n`)
  const src = C.citeSources({ request: readFileSync(path.join(d, 'request.md'), 'utf8') })
  const q = (quote) => C.checkGoalMap({ outcomes: [{ outcome: '成果', quotes: [{ source: 'request', quote }], items: ['G1'] }] }, ['G1'], src)
  assert.deepEqual(q('直してやり直す'), [])
  assert.match(q('直して')[0], /字未満/)
  writeFileSync(path.join(d, 'goal-short.md'), '- G1: 直してやり直す 〔request: 直してやり直す〕\n')
  assert.equal(cli('init', '--state', path.join(d, 'short'), '--goal', path.join(d, 'goal-short.md'), '--request', path.join(d, 'request.md'), '--target', paths['a.md']).code, 0)
})

// 目標を照合していない台帳（単独で呼んだとき）。利用者の観点を渡すので計画の段は通らない。
const unchecked = (t) => project(t, TWO, { goalChecked: false, criteria: null, goal: `- G1: 対象の文書を観点ごとに確かめた指摘の一覧 〔request: ${REQUEST}〕\n` })

test('目標の照合（単独）: 照合役の担当が走り、受け止められていない成果は needs_input で成果と引用を返す。偽の引用は受け付けず、試行の上限で stuck', async (t) => {
  const { state } = unchecked(t)
  const { stop, calls } = await drive(state, planAct({ goal_check: () => ({ outcomes: [{ outcome: '確かめた指摘', quotes: [{ source: 'request', quote: REQUEST }], items: [] }] }) }))
  assert.equal(steps(calls)[0], 'goal_check')
  assert.equal(stop.stop, 'needs_input', JSON.stringify(stop))
  assert.deepEqual(stop.goal_gaps, [{ outcome: '確かめた指摘', quotes: [{ source: 'request', quote: REQUEST }] }])
  const { state: s2 } = unchecked(t)
  const r = await drive(s2, planAct({ goal_check: () => ({ outcomes: [{ outcome: '架空', quotes: [{ source: 'request', quote: '依頼文に無い架空の成果を求める一文' }], items: ['G1'] }] }) }))
  assert.equal(r.stop.stop, 'needs_input')
  assert.deepEqual(r.stop.stuck, ['goal'])
  assert.equal(ledger(s2).goal.checked, false, '偽の引用の照合では合格にしない')
  // 照合役の query は依頼文と項目の id を返し、ファイルの段に進んだ後の担当は依頼文を受け取らない。
  const { state: s3 } = unchecked(t)
  const ok = await drive(s3, planAct())
  assert.equal(ok.stop.stop, 'complete', JSON.stringify(ok.stop))
  const q = ok.calls[0].workers[0].queries[0].out
  assert.equal(q.inputs.request, REQUEST)
  assert.deepEqual(q.inputs.item_ids, ['G1'])
  assert.ok(!JSON.stringify(claimedTasks(ok.calls.slice(1))).includes(REQUEST))
})

test('目標の照合（coverage-build から）: --goal-checked で照合を流さず、引用の無い項目も受け、基準を制約と別の欄に持ち、計画役に基準の受け皿を求める', async (t) => {
  const { d, paths } = project(t, TWO)
  writeFileSync(path.join(d, 'g.md'), '設計が次の目標を満たすかを確かめる。\n\n- G1: 値を計算する関数\n')
  writeFileSync(path.join(d, 'ac.md'), '- AC1: 入力が 1 なら 2 を返す\n- U1A1: 値を返す\n')
  writeFileSync(path.join(d, 'c.md'), '- D1: 依存を足さない\n')
  const state = path.join(d, 'checked')
  const r = cli('init', '--state', state, '--goal', path.join(d, 'g.md'), '--request', path.join(d, 'request.md'), '--criteria', path.join(d, 'ac.md'), '--constraints', path.join(d, 'c.md'), '--target', paths['a.md'], '--target', paths['b.md'], '--goal-checked', 'coverage-build')
  assert.equal(r.code, 0, JSON.stringify(r))
  assert.equal(cli('init', '--state', path.join(d, 'x'), '--goal', path.join(d, 'g.md'), '--request', path.join(d, 'request.md'), '--target', paths['a.md'], '--goal-checked', 'someone').code, 2, '印は coverage-build だけ')
  const { stop, calls } = await drive(state, planAct())
  assert.equal(stop.stop, 'complete', JSON.stringify(stop))
  assert.ok(!steps(calls).includes('goal_check'), '照合を流さない')
  const L = ledger(state)
  assert.deepEqual(L.criteria.map((c) => c.id), ['AC1', 'U1A1'])
  assert.deepEqual(L.constraints.map((c) => c.id), ['D1'])
  const q = calls[0].workers[0].queries[0].out.inputs
  assert.deepEqual(q.criteria.map((c) => c.id), ['AC1', 'U1A1'])
  assert.ok(L.plan.constraint_map.some((m) => m.constraint_id === 'AC1'), '基準にも受け皿の観点を付ける')
})

test('answer: 目標・基準・制約・決定の記録はファイルで直し、引用を照らしてから照合をやり直す', async (t) => {
  const { d, state } = unchecked(t)
  await drive(state, planAct())
  writeFileSync(path.join(d, 'g2.md'), '- G1: 指摘の一覧 〔request: 依頼文のどこにも無い架空の一文である〕\n')
  assert.equal(cli('answer', '--state', state, '--id', 'goal', '--file', path.join(d, 'g2.md')).code, 2)
  assert.equal(ledger(state).goal.checked, true, '拒否した直しは台帳を変えない')
  writeFileSync(path.join(d, 'g3.md'), '- G1: 確かめた指摘の一覧 〔request: 観点ごとにレビューしてほしい〕\n')
  assert.equal(cli('answer', '--state', state, '--id', 'goal', '--file', path.join(d, 'g3.md')).code, 0)
  assert.equal(ledger(state).goal.checked, false)
  const { calls } = await drive(state, planAct())
  assert.equal(steps(calls)[0], 'goal_check')
  assert.equal(ledger(state).goal.checked, true)
})


// ---------------- 計画の段（利用者が観点を渡さない） ----------------

test('計画の段: 計画役 2 体 → 統合 → 観点の検証 → ファイルの段の順に、役ごとの呼び出しで進み、各役は担当の入力を query で引く', async (t) => {
  const { state } = planned(t)
  const { stop, calls } = await drive(state, planAct())
  assert.equal(stop.stop, 'complete', JSON.stringify(stop))
  assert.deepEqual(steps(calls).slice(0, 4), ['plan', 'integrate', 'unit_verify', 'file'])
  assert.deepEqual(calls.slice(0, 4).map((c) => c.args.workers.map((w) => w.role)), [['planner_a', 'planner_b'], ['integrator'], ['unit_verifier'], ['file_reader', 'file_reader']])
  const q = (i) => calls[i].workers[0].queries[0].out.inputs
  assert.deepEqual(q(0).index.map((r) => r.id), Object.keys(ledger(state).assets), '計画役の索引は 1 行 1 単位')
  assert.ok(!JSON.stringify(q(0)).includes('主張を補う本文の行'), '索引は単位の本文を載せない（写しの参照と先頭の数語だけ）')
  assert.deepEqual(Object.keys(q(1).drafts).sort(), ['A', 'B'], '統合役は 2 体の案を引く')
  assert.deepEqual(q(1).sources, ['A:X1', 'B:X1'])
  assert.deepEqual(q(2).lens.goals.map((g) => g.id), ['G1'])
  assert.deepEqual(q(2).index.map((r) => r.id), Object.keys(ledger(state).assets), '観点の検証役は全ての単位の索引を引く（当てる単位を選ばない）')
  // ファイルの段の担当は、仕組みの標準の観点（S1）と計画の観点の和を受け取る。
  assert.ok(claimedTasks(calls).filter((x) => x.kind === 'file').every((x) => JSON.stringify(x.lenses.map((l) => l.id)) === '["S1","X1"]'))
  assert.equal(ledger(state).verified_units.length, 1)
})

test('計画の段: 計画役が 2 体とも案を出さなければ計画の試行に数え、試行の上限で stuck（needs_input）。片方だけでも統合に進む', async (t) => {
  const { state } = planned(t)
  const none = await drive(state, planAct({ plan: () => null }))
  assert.equal(none.stop.stop, 'needs_input', JSON.stringify(none.stop))
  assert.ok(none.stop.stuck.includes('plan'))
  const { state: s2 } = planned(t)
  const one = await drive(s2, planAct({ plan: (q, task) => (task.who === 'B' ? null : undefined) }))
  assert.equal(one.stop.stop, 'complete', JSON.stringify(one.stop))
  assert.deepEqual(one.calls[1].workers[0].queries[0].out.inputs.sources, ['A:X1'])
})

// 計画の観点の照合（goals・閉じた問い）の式は Workflow source の <checks> にある。ここでは式そのものを確かめる。
test('計画の静的な欠陥: 照合に落ちる計画は統合役に 1 回出し直させ、残る外れは計画の欠陥（P<n>）にして見直しの統合に戻し、消えなければファイルの段に進まずに needs_input', async (t) => {
  const { state } = planned(t)
  const bad = (q) => ({ ...onePlan(q), constraint_map: [], questions: [{ id: 'Q1', question: 'どちらにするか', options: ['甲'] }] })
  const { stop, calls } = await drive(state, planAct({ plan: bad, integrate: bad }))
  assert.equal(stop.stop, 'needs_input', JSON.stringify(stop))
  assert.ok(stop.plan_defects.some((x) => x.kind === 'static' && /^P\d+$/.test(x.id) && /価値判断の理由が無い/.test(x.claim)), JSON.stringify(stop.plan_defects))
  assert.ok(steps(calls).filter((x) => x === 'integrate').length >= 2, '見直しの統合に戻る')
  assert.ok(!steps(calls).includes('file'), '受け付けない計画でファイルの段に進まない')
  const integ = calls.find((c) => c.next.step === 'integrate').workers[0]
  assert.equal(integ.submits.length, 2, '外れのある統合は 1 回出し直させてから受け取る')
  assert.equal(integ.submits[0].out.results[0].ok, false)
})

test('計画の観点: 当てる単位（applies_to）を持たない計画を受け付け、観点は一覧で全ての単位に渡す', async (t) => {
  const { state, paths } = planned(t, THREE)
  const { stop, calls } = await drive(state, planAct({ plan: lensPlan({ X1: {}, X2: {} }), integrate: lensPlan({ X1: {}, X2: {} }) }))
  assert.equal(stop.stop, 'complete', JSON.stringify(stop))
  assert.ok(ledger(state).plan.lenses.every((l) => l.applies_to === undefined))
  const files = claimedTasks(calls).filter((x) => x.kind === 'file')
  assert.deepEqual(files.map((x) => x.unit.path).sort(), Object.values(paths).sort())
  assert.ok(files.every((x) => x.lenses.map((l) => l.id).join() === 'S1,X1,X2'), '標準の観点と計画の観点の和')
})

const GOAL_TEXTS = { G1: '対象の文書の見落としを確かめた指摘の一覧', AC1: '指摘ごとに本文の引用を付ける' }
const goalLens = (id, goals) => ({ id, name: id, procedure: '主張ごとに根拠の文を列挙し、目標と照らす', goals })
test('goals: {id, part} の part が本文に逐語で、全ての目標・基準がどれかの観点に入る計画だけを受け付ける', () => {
  const ids = Object.keys(GOAL_TEXTS)
  const has = (ps, ...res) => ps.some((x) => res.every((r) => (typeof r === 'string' ? x.includes(r) : r.test(x))))
  const ok = [goalLens('X1', [{ id: 'G1', part: '見落としを確かめた' }]), goalLens('X2', [{ id: 'AC1', part: '本文の引用' }])]
  assert.deepEqual(C.checkGoals(ok, ids, GOAL_TEXTS), [])
  assert.deepEqual(C.checkGoals([goalLens('X1', [{ id: 'G1', part: '見落としを確かめた' }, { id: 'G1', part: '指摘の一覧' }, { id: 'AC1', part: '本文の引用' }])], ids, GOAL_TEXTS), [])
  const cases = [
    ['part が本文に逐語でない', C.checkGoals([goalLens('X1', [{ id: 'G1', part: '本文のどこにも無い部分' }, { id: 'AC1', part: '本文の引用' }])], ids, GOAL_TEXTS), ['X1', /逐語/]],
    ['実在しない目標', C.checkGoals([...ok, goalLens('X3', [{ id: 'G9', part: '何か' }])], ids, GOAL_TEXTS), ['G9', /実在しない/]],
    ['受け皿の無い目標', C.checkGoals([ok[0]], ids, GOAL_TEXTS), ['AC1', /どの観点の goals にも無い/]],
    ['goals が空', C.checkGoals([...ok, goalLens('X3', [])], ids, GOAL_TEXTS), ['X3', /空/]],
  ]
  for (const [name, ps, want] of cases) assert.ok(has(ps, ...want), `${name}: ${JSON.stringify(ps)}`)
})

test('goals: 逐語でない part と、どの観点の goals にも入らない受け入れ基準は、計画の静的な欠陥（P<n>）で、消えなければファイルの段に進まずに needs_input', async (t) => {
  const { state } = planned(t)
  const bad = (q) => { const r = onePlan(q); r.lenses[0].goals = [{ id: 'G1', part: '目標の本文のどこにも無い部分の文字列' }]; return r }
  const r1 = await drive(state, planAct({ plan: bad, integrate: bad }))
  assert.equal(r1.stop.stop, 'needs_input', JSON.stringify(r1.stop))
  assert.ok(r1.stop.plan_defects.some((x) => x.kind === 'static' && /逐語/.test(x.claim)))
  assert.ok(!steps(r1.calls).includes('file'))
  const { state: s2 } = planned(t, TWO, { criteria: '- AC1: 指摘ごとに本文の引用を付ける\n' })
  const onlyG1 = (q) => { const r = onePlan(q); r.lenses[0].goals = r.lenses[0].goals.filter((g) => g.id === 'G1'); return r }
  const r2 = await drive(s2, planAct({ plan: onlyG1, integrate: onlyG1 }))
  assert.equal(r2.stop.stop, 'needs_input', JSON.stringify(r2.stop))
  assert.ok(r2.stop.plan_defects.some((x) => x.kind === 'static' && x.claim.includes('AC1') && /どの観点の goals にも無い/.test(x.claim)), JSON.stringify(r2.stop.plan_defects))
})

test('閉じた問い: Q1・Q2 と goals の要素ごとの Q3 に過不足なく答えたものだけを受け付け、no の答えだけが欠陥になる', () => {
  const u = goalLens('X1', [{ id: 'G1', part: '見落としを確かめた' }, { id: 'G1', part: '指摘の一覧' }, { id: 'AC1', part: '本文の引用' }])
  const text = C.unitText(u)
  const yes = unitAnswers(u)
  assert.deepEqual(C.checkUnitVerdict(yes, 'X1', u.goals, text), [])
  assert.deepEqual(C.unitDefects(yes, 'X1', u.goals), [])
  const no = unitAnswers(u, (k) => k === 'Q2' || k === 'Q3:1')
  const ds = C.unitDefects(no, 'X1', u.goals)
  assert.deepEqual(ds.map((d) => [d.unit_id, d.kind, d.goal_id, d.part]), [['X1', 'Q2', undefined, undefined], ['X1', 'Q3', 'G1', '指摘の一覧']])
  const bad = (ans, extra = {}) => C.checkUnitVerdict({ ...yes, ...extra, answers: ans }, 'X1', u.goals, text).join(' / ')
  assert.match(bad(yes.answers, { defects: [{ kind: '大きすぎる', claim: '問いが 2 つある', quote: u.procedure }] }), /自由な欠陥/)
  assert.match(bad(yes.answers.filter((a) => a.goal_index !== 2)), /答えの無い問い: Q3/)
  assert.match(bad([...yes.answers, yes.answers[0]]), /答えの重複: Q1/)
  assert.match(bad(yes.answers.map((a, i) => (i ? a : { ...a, quote: '観点の本文に無い偽の引用の文字列' }))), /逐語で無い/)
})

test('閉じた問い: 自由な欠陥の返り値は受け付けず（rejected_unit_check）、試行の上限で stuck（unit:X1）。計画の欠陥にしない', async (t) => {
  const { state } = planned(t)
  const free = (q) => ({ ...unitAnswers(q.lens), defects: [{ kind: '大きすぎる', claim: '問いが 2 つある', quote: q.lens.procedure }] })
  const { stop } = await drive(state, planAct({ unit_verify: free }))
  assert.equal(stop.stop, 'needs_input', JSON.stringify(stop))
  assert.ok(stop.stuck.includes('unit:X1'), JSON.stringify(stop))
  const L = ledger(state)
  assert.ok(!L.plan_defects.some((x) => /問いが 2 つある/.test(x.claim)))
  assert.ok(L.events.some((e) => e.kind === 'rejected_unit_check' && /自由な欠陥/.test(e.text)))
})

test('閉じた問い: 観点の検証役が返らなければ試行に数え、次の呼び出しで同じ観点を検証し直して受理する', async (t) => {
  const { state } = planned(t)
  let n = 0
  const { stop, calls } = await drive(state, planAct({ unit_verify: () => (n++ === 0 ? null : undefined) }))
  assert.equal(stop.stop, 'complete', JSON.stringify(stop))
  assert.deepEqual(steps(calls).filter((s) => s === 'unit_verify').length, 2)
  assert.equal(ledger(state).verified_units.length, 1)
})

test('plan_defects の id: P1 から連番で付き、統合のやり直しで欠陥を戻しても前の番号を使い回さない。やり直しの上限で needs_input', async (t) => {
  const { state } = planned(t)
  const rec = []
  const { stop } = await drive(state, planAct({ unit_verify: (q) => unitAnswers(q.lens, (k) => k === 'Q3:0') }), { onCall: recordDefects(state, rec) })
  assert.equal(stop.stop, 'needs_input', JSON.stringify(stop))
  const all = [...new Set(rec.flatMap((r) => r.defects.map((d) => d.id)))]
  assert.ok(all.length >= 3, JSON.stringify(all))
  assert.deepEqual(all.map((id) => Number(id.slice(1))), all.map((_, i) => i + 1), `新しい欠陥へ次の番号を付ける: ${JSON.stringify(all)}`)
  const q3 = rec.find((r) => r.defects.length).defects[0]
  assert.deepEqual([q3.unit_id, q3.kind, q3.goal_id, q3.part], ['X1', 'Q3', 'G1', '対象の文書の見落としを確かめた指摘の一覧'])
  assert.deepEqual(stop.plan_defects.map((d) => d.id), rec.at(-1).defects.map((d) => d.id))
})

test('integrator: 閉じた問いの no から作った欠陥を rejected で退けても、観点を検証し直し、yes なら欠陥は消えてファイルの段に進み、no ならまた欠陥（新しい P<n>）になる', async (t) => {
  for (const later of ['yes', 'no']) {
    const { state } = planned(t)
    let first = true
    const act = planAct({
      integrate: (q) => (q.defects ? { ...onePlan(q), source_map: q.sources.map((s) => ({ source: s, merged_into: 'X1', dropped_reason: '' })), defect_responses: q.defects.map((d) => ({ defect_index: d.index, action: 'rejected', reason: '手続きは列挙するものを書いている' })) } : undefined),
      unit_verify: (q) => { const no = first || later === 'no'; first = false; return unitAnswers(q.lens, (k) => no && k === 'Q1') },
    })
    const rec = []
    const { stop, calls } = await drive(state, act, { onCall: recordDefects(state, rec) })
    const after = steps(calls).slice(steps(calls).lastIndexOf('integrate'))
    assert.ok(after.includes('unit_verify'), `${later}: 退けた欠陥の観点を、中身が変わらなくても検証し直す: ${steps(calls)}`)
    if (later === 'yes') {
      assert.equal(stop.stop, 'complete', JSON.stringify(stop))
      assert.ok(steps(calls).includes('file'))
    } else {
      assert.equal(stop.stop, 'needs_input', JSON.stringify(stop))
      const ids = [...new Set(rec.flatMap((r) => r.defects.map((d) => d.id)))]
      assert.ok(ids.length >= 2, '新しい欠陥は新しい id')
      assert.ok(!steps(calls).includes('file'))
    }
  }
})

test('answer --id P<n>: 計画の欠陥への回答は決定の記録と制約になり、停止を外して統合からやり直す。統合役は回答を query で引く', async (t) => {
  const { state } = planned(t)
  const act = planAct({ unit_verify: (q) => unitAnswers(q.lens, (k) => k === 'Q1') })
  const { stop } = await drive(state, act)
  assert.equal(stop.stop, 'needs_input', JSON.stringify(stop))
  const pid = stop.plan_defects[0].id
  assert.equal(cli('next', '--state', state).stop, 'needs_input', '回答の前は止まったまま')
  assert.equal(cli('answer', '--state', state, '--id', 'P999', '--text', '答え').code, 2)
  assert.notEqual(pid, 'P1')
  assert.equal(cli('answer', '--state', state, '--id', 'P1', '--text', '答え').code, 2, '前の統合の欠陥の id は今の欠陥でない')
  const said = 'X1 の手続きに列挙するものを書き足して直す'
  assert.equal(cli('answer', '--state', state, '--id', pid, '--text', said).code, 0)
  const L = ledger(state)
  assert.ok(L.decisions.includes(said))
  assert.ok(L.constraints.some((c) => /^A\d+$/.test(c.id) && c.text.includes(said)))
  const again = await drive(state, act)
  assert.equal(again.calls[0].next.step, 'integrate', '回答で停止が外れ、統合からやり直す')
  const q = again.calls[0].workers[0].queries[0].out.inputs
  assert.ok(q.answers.some((a) => a.id === pid && a.text === said), '見直しの統合役が回答を引く')
  assert.equal(again.stop.stop, 'needs_input', '欠陥が残れば、また止まる')
  assert.ok(again.stop.plan_defects.every((d) => Number(d.id.slice(1)) > Number(pid.slice(1))))
})

test('answer: 質問への回答から作る制約の id は、既にある基準・制約の id と重ならない', async (t) => {
  const { d, state: _s, paths } = planned(t)
  writeFileSync(path.join(d, 'g.md'), '- G1: 値を計算する関数\n')
  writeFileSync(path.join(d, 'c.md'), '- D1: 依存を足さない\n- A1: coverage-build の回答から来た制約\n')
  const state = path.join(d, 'qa')
  assert.equal(cli('init', '--state', state, '--goal', path.join(d, 'g.md'), '--request', path.join(d, 'request.md'), '--constraints', path.join(d, 'c.md'), '--target', paths['a.md'], '--goal-checked', 'coverage-build').code, 0)
  const qs = [{ id: 'Q1', question: 'どちらにするか', why_value_judgment: '価値の判断', options: ['甲', '乙'] }]
  const withQ = (q) => (ledger(state).answers.length ? undefined : { ...onePlan(q), questions: qs })
  const { stop } = await drive(state, planAct({ integrate: withQ }))
  assert.equal(stop.stop, 'needs_input', JSON.stringify(stop))
  assert.deepEqual(stop.questions.map((q) => q.id), ['Q1'])
  assert.equal(cli('answer', '--state', state, '--id', 'Q1', '--text', '甲にする').code, 0)
  assert.deepEqual(ledger(state).constraints.map((c) => c.id), ['D1', 'A1', 'A2'])
})

// ---------------- 計画の観点の id と、利用者の観点の経路（lenses.test.mjs から移した流れ） ----------------

test('計画が id purpose・layer の観点を返しても受け付け、ほかの計画の観点と同じく閉じた問いを通り、ファイルの段に計画の観点として渡る', async (t) => {
  const { state, paths } = planned(t, TWO, { criteria: '- AC1: 指摘ごとに本文の引用を付ける\n' })
  const PROC = { purpose: 'この部分の主張ごとに、固定した目標と制約のどれに効くかを対応づけてから、効かない主張を探す。', layer: 'この部分の内容ごとに層を判定してから、対象の層より上の決め直しを探す。' }
  const idPlan = (q) => asIntegrated(q, { lenses: ['purpose', 'layer'].map((id) => ({ id, name: id, procedure: PROC[id], goals: goalsOfQ(q) })), questions: [], constraint_map: [...q.criteria, ...q.constraints].map((c) => ({ constraint_id: c.id, handled_by: ['purpose'] })) })
  const { stop, calls } = await drive(state, planAct({ plan: idPlan, integrate: idPlan }))
  assert.equal(stop.stop, 'complete', JSON.stringify(stop))
  const L = ledger(state)
  assert.deepEqual(L.plan_defects, [], '計画の欠陥にしない')
  assert.deepEqual(L.lenses.filter((l) => !l.retro).map((l) => [l.id, l.origin]), [['S1', 'standard'], ['purpose', 'plan'], ['layer', 'plan']], '計画の観点として台帳に入る（標準の観点と並ぶ）')
  assert.equal(calls.find((c) => c.next.step === 'unit_verify').args.workers.length, 2, '閉じた問いは観点ごとに起動される')
  const files = claimedTasks(calls).filter((x) => x.kind === 'file')
  assert.deepEqual(files.map((x) => x.unit.path).sort(), [paths['a.md'], paths['b.md']].sort())
  assert.ok(files.every((x) => x.lenses.map((l) => l.id).join() === 'S1,purpose,layer'), '観点は一覧で全ての単位に渡す')
})

test('lenses.json の経路: 利用者の観点と仕組みの標準の観点を全ての単位に渡し、purpose・layer の観点を作らない', async (t) => {
  const L2 = { id: 'L2', name: '用語の一貫', procedure: '用語ごとに使われ方を並べ、意味の揺れを探す' }
  const { state } = project(t, TWO, { lenses: [{ id: 'L1', name: '主張と根拠', procedure: '主張ごとに根拠の文を対応づけ、根拠の無い主張を探す' }, L2] })
  const { stop, calls } = await drive(state, behave())
  assert.equal(stop.stop, 'complete', JSON.stringify(stop))
  const files = claimedTasks(calls).filter((x) => x.kind === 'file')
  assert.equal(files.length, 2)
  assert.ok(files.every((x) => x.lenses.map((l) => l.id).join() === 'L1,L2,S1'), JSON.stringify(files.map((x) => x.lenses.map((l) => l.id))))
  assert.ok(!ledger(state).lenses.some((l) => ['purpose', 'layer'].includes(l.id)))
})

// ---------------- 確定した指摘が要る止め方と持ち越し（全体の段の判定を通った指摘） ----------------
const QA1 = '一つ目の文書 の節は主張を一つだけ述べる本文の行である。'
const withFinding = (layer) => ({ facts: (p) => (path.basename(p) === 'a.md' ? { findings: [{ claim: '根拠が無い主張', quote: QA1, layer }] } : {}) })

test('上の層: 原因が方針・要求の層にある確定した指摘は complete にせず needs_input（upper）で返し、answer の後は complete（直すのは呼ぶ側）', async (t) => {
  const { state } = project(t, TWO)
  const { stop } = await drive(state, behave(withFinding('要求')))
  assert.equal(stop.stop, 'needs_input', JSON.stringify(stop))
  assert.equal(stop.upper.length, 1)
  assert.ok(status(state).findings.confirmed.some((f) => f.id === stop.upper[0] && f.layer === '要求'))
  assert.equal(cli('answer', '--state', state, '--id', stop.upper[0], '--text', '要求を直してから回し直す').code, 0)
  assert.equal(cli('next', '--state', state).stop, 'complete')
})

test('検証不能: 確認の引用が根拠の本文に逐語で無ければ、棄却も確定もせず検証不能（unverifiable）にし、complete にせず needs_input で返す', async (t) => {
  const { state, paths } = project(t, TWO)
  const subject = (task, ctx) => {
    const q = ctx.query(task)
    const locs = q.basis.filter((f) => f.quote).map((f) => ({ unit: f.unit, quote: f.quote }))
    return { verdict: 'conflict', quote: locs[0].quote, findings: [{ claim: '主語の扱いが食い違う', locations: locs, obligation: 'G1', confidence: 'high', severity: 'HIGH', layer: '方式設計' }] }
  }
  const facts = (p) => ({ guarantees: [{ subject: '書き込みの順序', quote: readFileSync(p, 'utf8').split('\n')[3], confidence: 'high' }] })
  const confirm = () => ({ verdict: 'disagree', reason: '本文で確かめた', quote: 'どの単位の本文にも無い確認の引用の文である' })
  const { stop } = await drive(state, behave({ facts, subject, confirm }))
  assert.equal(stop.stop, 'needs_input', JSON.stringify(stop))
  assert.equal(stop.unverifiable.length, 1, JSON.stringify(stop))
  const s = status(state)
  assert.deepEqual(s.findings.unverifiable.map((f) => f.id), stop.unverifiable)
  assert.ok(!s.findings.confirmed.some((f) => f.claim === '主語の扱いが食い違う'), '検証不能を確定にしない')
  assert.ok(paths['a.md'])
})

test('横展開の照合: pattern があるのに applies_to を返さない束ねは受け付けず（rejected_grouping）、横展開の型を作らない', async (t) => {
  const { state } = project(t, TWO)
  const group = (task, ctx) => { const q = ctx.query(task).inputs; return { groups: [{ id: 'g1', root_cause: '根の原因', layer: '実装', keys: q.items.map((x) => x.key), pattern: '主張ごとに根拠を対応づける', applies_to: [] }], unassigned: [] } }
  const { stop } = await drive(state, behave({ ...withFinding('実装'), group }))
  assert.equal(stop.stop, 'complete', JSON.stringify(stop))
  const L = ledger(state)
  assert.ok(L.events.some((e) => e.kind === 'rejected_grouping' && /applies_to/.test(e.text)))
  assert.deepEqual(L.lateral_types, [])
})

test('持ち越し: complete の後に対象が変わったら周を進め、新しい指摘も全体の段・束ねを通る', async (t) => {
  const { state, paths } = project(t, TWO)
  const grouped = []
  const group = (task, ctx) => { const q = ctx.query(task).inputs; grouped.push(q.items.map((x) => x.claim)); return { groups: [{ id: 'g1', root_cause: '根の原因', layer: '実装', keys: q.items.map((x) => x.key), pattern: '', applies_to: [] }], unassigned: [] } }
  const refute = (task) => ({ group_id: task.group, refuted: false, reason: '記録の事実と合う' })
  const first = await drive(state, behave({ ...withFinding('実装'), group, refute }))
  assert.equal(first.stop.stop, 'complete', JSON.stringify(first.stop))
  assert.equal(ledger(state).cycle, 1)
  writeFileSync(paths['b.md'], `${doc('二つ目の文書')}\n## 足した節\n足した節は新しい主張を根拠なしに述べる本文の行である。\n`)
  const facts = (p) => (path.basename(p) === 'b.md' ? { findings: [{ claim: '足した節に根拠が無い', quote: '足した節は新しい主張を根拠なしに述べる本文の行である。' }] } : withFinding('実装').facts(p))
  const second = await drive(state, behave({ facts, group, refute }))
  assert.equal(second.stop.stop, 'complete', JSON.stringify(second.stop))
  assert.equal(ledger(state).cycle, 2, '持ち越しで周を進める')
  assert.ok(steps(second.calls).includes('global') && steps(second.calls).includes('group'))
  assert.ok(grouped.at(-1).includes('足した節に根拠が無い'), '新しい指摘も束ねを通る')
  assert.ok(status(state).findings.confirmed.some((f) => f.claim === '足した節に根拠が無い'))
})
