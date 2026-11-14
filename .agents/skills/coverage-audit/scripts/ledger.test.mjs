import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { C, MAX_ASSET_LINES, MAX_ATTEMPTS, MAX_BLOCKS, findingId, retroAssets, splitAssets } from './ledger-core.mjs'
import { cli, drive, evidenceOf, groupItems, mockAgent, runWorkflow, tmp } from './test-harness.mjs'

const DOC = `# 対象の文書

## 一つ目の節
この節は一つ目の主張を述べる本文の行である。
二行目もこの節の主張を補う本文の行として置く。

## 二つ目の節
この節は二つ目の主張を述べる本文の行である。
二行目もこの節の主張を補う本文の行として置く。
`

function setup(t, extra = [], doc = DOC) {
  const d = tmp(t)
  writeFileSync(path.join(d, 'doc.md'), doc)
  writeFileSync(path.join(d, 'goal.md'), '- G1: 対象の文書の見落としを観点ごとに確かめた指摘の一覧 〔request: 対象の文書を観点ごとにレビューして、確かめた指摘を返してほしい〕\n')
  writeFileSync(path.join(d, 'request.md'), '対象の文書を観点ごとにレビューして、確かめた指摘を返してほしい')
  writeFileSync(path.join(d, 'lenses.json'), JSON.stringify([{ id: 'L1', name: '主張と根拠', procedure: '主張ごとに根拠の文を対応づけ、根拠の無い主張を探す' }]))
  const state = path.join(d, 'state')
  const r = cli('init', '--state', state, '--goal', path.join(d, 'goal.md'), '--request', path.join(d, 'request.md'), '--target', path.join(d, 'doc.md'), '--lenses', path.join(d, 'lenses.json'), ...extra)
  assert.equal(r.code, 0, JSON.stringify(r))
  return { d, state, doc: path.join(d, 'doc.md') }
}
const ledger = (state) => JSON.parse(readFileSync(path.join(state, 'ledger.json'), 'utf8'))
const finding = (claim, quote, layer = '実装') => ({ claim, quote, severity: 'MEDIUM', layer })
const readWith = (findingsFor) => (prompt, opts) => {
  const cell = opts.label.slice('read-'.length).split('（')[0]
  const fs = findingsFor(cell, prompt)
  if (fs === undefined) return undefined
  return { cell_id: cell, evidence: evidenceOf(prompt), findings: fs, outside_notes: [], none_reason: fs.length ? '' : '該当なし' }
}

test('資産: 見出しの経路が ID で、前に行が増えても変わらない節は同じ ID と hash', () => {
  const a = splitAssets('/x/doc.md', DOC)
  const b = splitAssets('/x/doc.md', `前置きの行を足した\n\n${DOC}`)
  const pick = (xs) => Object.fromEntries(xs.map((x) => [x.id, x.hash]))
  assert.deepEqual(Object.keys(pick(a)), ['/x/doc.md#対象の文書/一つ目の節', '/x/doc.md#対象の文書/二つ目の節'])
  for (const [id, h] of Object.entries(pick(a))) if (id.endsWith('の節')) assert.equal(pick(b)[id], h)
  const long = splitAssets('/x/a.txt', Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n'))
  assert.deepEqual(long.map((x) => [x.id, x.start]), [['/x/a.txt#c1', 1], ['/x/a.txt#c2', 81], ['/x/a.txt#c3', 161]])
  assert.ok(long.every((x) => x.need === x.blocks.length && x.need >= 1))
})

test('振り返りの資産: 多数の出来事は 1 段でも本文の上限ごとに分け、引用を求める区画は通常の資産と同じ上限', () => {
  const events = Array.from({ length: 300 }, (_, i) => ({ id: `E1-${i + 1}`, cycle: 1, stage: 'review', kind: 'missing_read', text: i === 7 ? `二行に渡る出来事 ${i}\n続きの行` : `枡 ${i} の読みが返らなかった出来事` }))
  const ra = retroAssets({ cycle: 1, events })
  assert.equal(ra.length, Math.ceil(300 / MAX_ASSET_LINES))
  assert.equal(new Set(ra.map((a) => a.id)).size, ra.length)
  assert.ok(ra.every((a) => a.text.split('\n').length <= MAX_ASSET_LINES && a.need <= MAX_BLOCKS && a.need === a.blocks.length))
  assert.equal(ra.reduce((n, a) => n + a.text.split('\n').length, 0), 300, '1 出来事 1 行で、全ての出来事がどれかの資産にある')
  assert.ok(ra.some((a) => a.text.includes('二行に渡る出来事 7 / 続きの行')))
  assert.ok(events.every((e) => e.retro === 1))
  const one = retroAssets({ cycle: 2, events: [{ id: 'E2-1', cycle: 2, stage: 'plan', kind: 'blocked', text: '計画の段が止まった出来事' }] })
  assert.deepEqual(one.map((a) => [a.id, a.need]), [['retro:c2:plan', 1]])
})

test('引用の照合: 短い・無い・見出しだけは読んだ証拠にならず、行番号は外して照らす', () => {
  const text = '# 見出しの文字列はここに十分な長さで\n本文の一行目はこのように続いていく。'
  assert.match(C.quoteProblem('短い', text), /字未満/)
  assert.match(C.quoteProblem('本文に無い長い文字列をここに書く', text), /逐語で無い/)
  assert.match(C.quoteProblem('見出しの文字列はここに十分な長さで', text), /見出しだけ/)
  assert.equal(C.quoteProblem('2| 本文の一行目はこのように', text), null)
  assert.equal(C.quoteProblem('     2\t本文の一行目はこのように', text), null, 'Read の行番号の形も外す')
  const asset = { cell_id: 'c', text: Array.from({ length: 80 }, (_, i) => `これは ${i} 行目の本文の文字列です`).join('\n'), blocks: [[0, 39], [40, 79]], need: 2 }
  const half = { cell_id: 'c', evidence: ['これは 1 行目の本文の文字列です'], findings: [], outside_notes: [], none_reason: 'なし' }
  assert.match(C.checkRead(half, asset).join(), /2 区画のうち 1 区画/)
  assert.deepEqual(C.checkRead({ ...half, evidence: [...half.evidence, 'これは 70 行目の本文の文字列です'] }, asset), [])
})

test('検証不能: 偽の引用での棄却・確定は指摘を消さず unverifiable にする', () => {
  assert.equal(C.settleVerdict({ verdict: 'refuted', quote: '本文に無い偽の引用の文字列', reason: 'r' }, '本文の文字列はこれだけ'), 'unverifiable')
  assert.equal(C.settleVerdict({ verdict: 'refuted', quote: '本文の文字列はこれだけ', reason: 'r' }, '本文の文字列はこれだけ'), 'refuted')
})

test('正常: 目標の照合 → 全ての枡を読み確かめ → 振り返り → 完了。役ごとのモデル・effort を記録する', async (t) => {
  const { state } = setup(t)
  const log = []
  const { stop, steps } = await drive(state, mockAgent({}, log))
  assert.equal(stop.stop, 'complete', JSON.stringify(stop))
  assert.deepEqual(steps.map((s) => s.step), ['plan', 'review'])
  const L = ledger(state)
  assert.equal(stop.coverage.cells, 6) // 2 資産 × 3 観点（purpose・layer・L1）× k=1。見出しだけの塊は資産にしない
  assert.equal(stop.coverage.settled, 6)
  assert.equal(stop.coverage.settled_with_verifier, 0, '指摘の無い枡は検証役を通っていないと数える')
  assert.ok(L.goal.checked)
  assert.ok(L.agents.every((a) => a.model && a.effort && a.role))
  assert.equal(L.calls[0].tokens, null)
  assert.match(L.calls[0].tokens_note, /読めない/)
  assert.ok(log.every((x) => !x.prompt.includes('一つ目の主張を述べる') && !x.prompt.includes('二つ目の主張を述べる')), 'prompt に対象の本文を載せない（担当が写しを読む）')
  assert.ok(steps.every((s) => !JSON.stringify(s.args).includes('主張を述べる')), 'args に対象の本文を載せない')
})

test('横展開: 確かめた欠陥の型を、全ての資産へ新しい観点として問い直す', async (t) => {
  const { state } = setup(t)
  let lateralSeen = 0
  const agentFn = mockAgent({
    read: readWith((cell) => (cell.endsWith('一つ目の節|L1|p1') ? [finding('根拠が無い主張', 'この節は一つ目の主張を述べる本文の行である。')] : (cell.includes('|lat-') ? (lateralSeen++, []) : undefined))),
    group: (prompt) => ({ groups: [{ id: 'g1', root_cause: '根拠を書かない', layer: '実装', keys: groupItems(prompt).map((x) => x.key), pattern: '主張ごとに根拠を対応づけ、根拠の無い主張を探す（横展開）' }], unassigned: [] }),
  })
  const { stop } = await drive(state, agentFn)
  assert.equal(stop.stop, 'complete', JSON.stringify(stop))
  const L = ledger(state)
  assert.equal(L.groups[0].status, 'kept')
  assert.ok(L.lenses.some((l) => l.id === 'lat-G1-g1'))
  assert.equal(lateralSeen, 2, '横展開の観点は全ての資産に当たる')
  assert.equal(L.saturation[0].confirmed_new, 1)
})

test('欠測: 返らない枡は試行を数え、上限で開示に倒し、他の枡は確かめて完了する', async (t) => {
  const { state } = setup(t)
  const target = '#対象の文書/二つ目の節|L1|p1'
  const { stop } = await drive(state, mockAgent({ read: (p, o) => (o.label.includes(target) ? null : undefined) }))
  assert.equal(stop.stop, 'complete')
  assert.equal(stop.disclosed.length, 1)
  assert.ok(stop.disclosed[0].endsWith(target))
  const L = ledger(state)
  assert.equal(L.cells[stop.disclosed[0]].attempts, MAX_ATTEMPTS)
  assert.ok(L.events.some((e) => e.kind === 'missing_read'))
})

test('不正な出力: 偽の引用の読みは受け付けず、読み直す', async (t) => {
  const { state } = setup(t)
  let n = 0
  const { stop } = await drive(state, mockAgent({ read: (p, o) => (o.label.includes('一つ目の節|purpose') && n++ < 1 ? { cell_id: o.label.slice(5).split('（')[0], evidence: ['本文に無い引用をここに書いている'], findings: [], outside_notes: [], none_reason: 'x' } : undefined) }))
  assert.equal(stop.stop, 'complete')
  const L = ledger(state)
  const c = Object.entries(L.cells).find(([id]) => id.includes('一つ目の節|purpose'))[1]
  assert.equal(c.status, 'settled')
  assert.equal(c.attempts, 1, '偽の引用は ingest が写しに照らして落とし、試行に数えて次の呼び出しで読み直す')
  assert.ok(L.events.some((e) => e.kind === 'rejected_read'))
})

test('検証役の却下: 検証が揃わない枡は読み直しに戻り、次で確かめられる', async (t) => {
  const { state } = setup(t)
  let v = 0
  const agentFn = mockAgent({
    read: readWith((cell) => (cell.endsWith('一つ目の節|L1|p1') ? [finding('根拠が無い主張', 'この節は一つ目の主張を述べる本文の行である。')] : undefined)),
    verify: (p, o) => (o.label.startsWith('verify-unit-') ? undefined : v++ < 2 ? null : undefined),
  })
  const { stop, steps } = await drive(state, agentFn)
  assert.equal(stop.stop, 'complete', JSON.stringify(stop))
  assert.ok(steps.filter((s) => s.step === 'review').length >= 2)
  const L = ledger(state)
  const id = Object.keys(L.cells).find((k) => k.endsWith('一つ目の節|L1|p1'))
  assert.equal(L.cells[id].status, 'settled')
  assert.equal(L.cells[id].verifier, true)
  assert.equal(Object.values(L.findings).filter((f) => f.status === 'current' && f.verdict === 'confirmed').length, 1)
})

test('全件失敗: 全ての役が欠けた呼び出しが続けば blocked で、complete にしない', async (t) => {
  const { state } = setup(t)
  const dead = async () => null
  const { stop } = await drive(state, dead)
  assert.equal(stop.stop, 'blocked')
  assert.equal(stop.cause, 'failure')
  const L = ledger(state)
  assert.ok(Object.entries(L.attempts).every(([k, n]) => L.env_attempts[k] === n), '環境の失敗による試行は区別して数える')
  assert.ok(Object.values(L.cells).every((c) => (c.env_attempts || 0) === c.attempts))
  const again = await drive(state, mockAgent())
  assert.equal(again.stop.stop, 'complete', '原因を直して再開した run は読み直して完了する')
  assert.deepEqual(again.stop.disclosed, [])
})

test('検証不能: 検証不能の指摘は消えず、完了にせず needs_input で返す', async (t) => {
  const { state } = setup(t)
  const agentFn = mockAgent({
    read: readWith((cell) => (cell.endsWith('二つ目の節|purpose|p1') ? [finding('目標に効かない', 'この節は二つ目の主張を述べる本文の行である。')] : undefined)),
    verify: (p, o) => (o.label.startsWith('verify-unit-') ? undefined : { verdicts: [{ index: 0, verdict: 'refuted', reason: '違う', quote: '偽の引用で反証しようとしている文字列' }] }),
  })
  const { stop } = await drive(state, agentFn)
  assert.equal(stop.stop, 'needs_input')
  assert.equal(stop.unverifiable.length, 1)
  const a = cli('answer', '--state', state, '--id', stop.unverifiable[0], '--text', '費用をかけずに既知の未確認として残す')
  assert.equal(a.code, 0)
  assert.equal(cli('next', '--state', state).stop, 'complete')
})

test('同じ枡の複数の指摘: 種別が同じでも引用か主張が違えば別の指摘として残る', async (t) => {
  const { state } = setup(t)
  const two = [finding('一つ目の欠陥', 'この節は一つ目の主張を述べる本文の行である。'), finding('二つ目の欠陥', '二行目もこの節の主張を補う本文の行として置く。')]
  await drive(state, mockAgent({ read: readWith((cell) => (cell.endsWith('一つ目の節|L1|p1') ? two : undefined)) }))
  const L = ledger(state)
  const ids = Object.keys(L.findings).filter((k) => k.includes('一つ目の節|L1|p1'))
  assert.equal(ids.length, 2)
  assert.notEqual(findingId('c', two[0]), findingId('c', two[1]))
})

test('上の層: 方針・要求が原因の欠陥はcomplete にせず needs_input で返す（直すのは呼ぶ側）', async (t) => {
  const { state } = setup(t)
  const { stop } = await drive(state, mockAgent({ read: readWith((cell) => (cell.endsWith('一つ目の節|purpose|p1') ? [finding('要求が足りない', 'この節は一つ目の主張を述べる本文の行である。', '要求')] : undefined)) }))
  assert.equal(stop.stop, 'needs_input')
  assert.equal(stop.upper.length, 1)
})

test('持ち越し: 変わった節の枡だけ古い印が付いて読み直され、消えた対象は blocked', async (t) => {
  const { state, doc } = setup(t)
  const log = []
  assert.equal((await drive(state, mockAgent({}, log))).stop.stop, 'complete')
  writeFileSync(doc, DOC.replace('二つ目の主張を述べる', '二つ目の主張を書き換えて述べる'))
  const before = log.length
  const { stop } = await drive(state, mockAgent({}, log))
  assert.equal(stop.stop, 'complete')
  const reread = log.slice(before).filter((x) => x.label.startsWith('read-')).map((x) => x.label)
  assert.equal(reread.length, 3, '変わった 1 節 × 3 観点だけ')
  assert.ok(reread.every((l) => l.includes('二つ目の節')))
  rmSync(doc)
  const n = cli('next', '--state', state)
  assert.equal(n.stop, 'blocked')
  assert.equal(n.cause, 'input')
})

test('数の引数: 正の整数でない --k・上限は init も config も Fail（終了状態 2）で、台帳を変えない', (t) => {
  const { d, state } = setup(t)
  const base = ['--goal', path.join(d, 'goal.md'), '--request', path.join(d, 'request.md'), '--target', path.join(d, 'doc.md')]
  for (const [k, v] of [['k', '0'], ['k', 'abc'], ['max-cycles', '1.5'], ['max-cycles', '-1'], ['max-agents-total', 'NaN'], ['k', '1e2'], ['k', '']]) {
    const s2 = path.join(d, `state-${k}-${v}`)
    const r = cli('init', '--state', s2, ...base, `--${k}`, v)
    assert.equal(r.code, 2, `${k}=${v}: ${JSON.stringify(r)}`)
    assert.ok(!existsSync(path.join(s2, 'ledger.json')), `${k}=${v} で台帳を作らない`)
  }
  const before = ledger(state).config
  for (const [k, v] of [['max-cycles', '0'], ['max-agents-total', 'NaN'], ['max-cycles', '2.5']]) assert.equal(cli('config', '--state', state, `--${k}`, v).code, 2, `${k}=${v}`)
  assert.deepEqual(ledger(state).config, before)
  assert.equal(cli('config', '--state', state, '--max-cycles', '7').config.max_cycles, 7)
})

test('受け取り: 待っている呼び出しと違う結果は受け付けない（古い run の遅れた書き込みを防ぐ）', async (t) => {
  const { state, d } = setup(t)
  const n = cli('next', '--state', state)
  writeFileSync(path.join(d, 'r.json'), JSON.stringify({ stage: n.step, call_id: 'deadbeef0000', agents: [] }))
  const g = cli('ingest', '--state', state, '--result', path.join(d, 'r.json'))
  assert.equal(g.code, 2)
  assert.match(g.error, /呼び出しが違う/)
  assert.equal(cli('next', '--state', state).call_id, n.call_id, '同じ状態からの next は同じ呼び出しを返す（運び直せる）')
})

test('ingest: native Workflow の出力ファイル（result に包んだ形）をそのまま受け付け、包みに似た形は包みとして外さない', async (t) => {
  const { state, d } = setup(t)
  const n = cli('next', '--state', state)
  const res = await runWorkflow(JSON.parse(readFileSync(n.args_path, 'utf8')), mockAgent())
  const before = readFileSync(path.join(state, 'ledger.json'), 'utf8')
  // 包みの印（summary が文字列・agentCount が数）が欠けた形は外さず、呼び出しが違うとして拒否し、台帳を変えない。
  for (const [name, near] of [['no-count', { summary: 'done', result: res }], ['str-count', { summary: 'done', agentCount: '3', result: res }], ['no-summary', { agentCount: 3, result: res }]]) {
    writeFileSync(path.join(d, `${name}.json`), JSON.stringify(near))
    const g = cli('ingest', '--state', state, '--result', path.join(d, `${name}.json`))
    assert.equal(g.code, 2, name)
    assert.match(g.error, /呼び出しが違う/, name)
  }
  assert.equal(readFileSync(path.join(state, 'ledger.json'), 'utf8'), before)
  writeFileSync(path.join(d, 'task.output'), JSON.stringify({ summary: 'coverage-audit-step を流した', agentCount: res.agents.length, logs: [], result: res }))
  const g = cli('ingest', '--state', state, '--result', path.join(d, 'task.output'))
  assert.equal(g.code, 0, JSON.stringify(g))
  // 包んでいない返り値も今どおり受け付ける。
  const n2 = cli('next', '--state', state)
  writeFileSync(path.join(d, 'plain.json'), JSON.stringify(await runWorkflow(JSON.parse(readFileSync(n2.args_path, 'utf8')), mockAgent())))
  assert.equal(cli('ingest', '--state', state, '--result', path.join(d, 'plain.json')).code, 0)
})

test('束の写し: 束が書き換わったら ingest は台帳を変えずに拒否する', async (t) => {
  const { state, d } = setup(t)
  const n = cli('next', '--state', state)
  const args = JSON.parse(readFileSync(n.args_path, 'utf8'))
  writeFileSync(path.join(d, 'r.json'), JSON.stringify(await runWorkflow(args, mockAgent())))
  writeFileSync(args.brief.snapshot, `${readFileSync(args.brief.snapshot, 'utf8')}書き足し\n`)
  const before = readFileSync(path.join(state, 'ledger.json'), 'utf8')
  const g = cli('ingest', '--state', state, '--result', path.join(d, 'r.json'))
  assert.equal(g.code, 2)
  assert.match(g.error, /hash が args と違う/)
  assert.equal(readFileSync(path.join(state, 'ledger.json'), 'utf8'), before)
})

test('args の写し: 運ぶ途中で書き換わった args は Workflow が役を起動せずに拒否する', async (t) => {
  const { state } = setup(t)
  const n = cli('next', '--state', state)
  const args = JSON.parse(readFileSync(n.args_path, 'utf8'))
  const log = []
  const res = await runWorkflow({ ...args, criteriaIds: [...args.criteriaIds, 'AC9'] }, mockAgent({}, log))
  assert.equal(res.status, 'blocked')
  assert.match(res.problems.join(), /argsSum/)
  assert.equal(log.length, 0)
})

test('ヒント: 次の呼び出しの全ての役に届き、受け取った後に既読になる', async (t) => {
  const { state } = setup(t)
  assert.equal(cli('hint', '--state', state, '--text', '二つ目の節は特に慎重に').code, 0)
  const log = []
  await drive(state, mockAgent({}, log))
  assert.ok(log[0].prompt.includes('二つ目の節は特に慎重に'))
  assert.deepEqual(ledger(state).hints_read, ['H1'])
  assert.ok(!log.at(-1).prompt.includes('二つ目の節は特に慎重に'))
})

test('上限: 1 回の呼び出しの枡は LIMITS に収まり、残りは次の呼び出しに回る（切り捨てない）', async (t) => {
  const many = `# 文書\n${Array.from({ length: 12 }, (_, i) => `\n## 節${i}\nこの節 ${i} は本文の行として十分な長さを持っている。`).join('\n')}\n`
  const { state } = setup(t, [], many)
  const { stop, steps } = await drive(state, mockAgent())
  assert.equal(stop.stop, 'complete')
  const reviews = steps.filter((s) => s.step === 'review')
  assert.ok(reviews.length >= 3)
  for (const s of reviews) assert.ok(s.args.cells.length * C.PER_CELL <= C.LIMITS.maxAgents)
  assert.equal(stop.coverage.settled, stop.coverage.cells)
})


test('持ち越し: complete の後に対象が変わったら周を進め、新しい指摘も振り返りと束ねを通る', async (t) => {
  const { state, doc } = setup(t)
  assert.equal((await drive(state, mockAgent())).stop.stop, 'complete')
  const cycle = ledger(state).cycle
  writeFileSync(doc, DOC.replace('二つ目の主張を述べる', '二つ目の主張を書き換えて述べる'))
  let grouped = []
  const agentFn = mockAgent({
    read: readWith((cell) => (cell.endsWith('二つ目の節|L1|p1') ? [finding('根拠が無い', 'この節は二つ目の主張を書き換えて述べる本文の行である。')] : undefined)),
    group: (p) => { grouped = groupItems(p); return undefined },
  })
  const { stop, steps } = await drive(state, agentFn)
  assert.equal(stop.stop, 'complete', JSON.stringify(stop))
  assert.deepEqual(steps.map((s) => s.step), ['review', 'group'], '変わった枡を読み、悪かった出来事が無いので振り返りは静的に済み、束ねる')
  assert.equal(grouped.length, 1)
  assert.match(grouped[0].claim, /根拠が無い/)
  const L = ledger(state)
  assert.ok(L.cycle > cycle + 1, '持ち越しの周を開き、束ねの後に次の周へ進む')
  assert.ok(L.retro_cycles.includes(cycle + 1) && L.group_cycles.includes(cycle + 1))
})

test('写し: args の hash と写しが違えば ingest は台帳を変えずに拒否する', async (t) => {
  const { state } = setup(t)
  const first = await drive(state, mockAgent(), { maxSteps: 1 })
  assert.equal(first.steps[0].step, 'plan')
  const n = cli('next', '--state', state)
  assert.equal(n.step, 'review')
  const args = JSON.parse(readFileSync(n.args_path, 'utf8'))
  const res = await runWorkflow(args, mockAgent())
  writeFileSync(args.cells[0].snapshot, readFileSync(args.cells[0].snapshot, 'utf8').replace('一つ目の主張', '書き換えた主張'))
  const rp = path.join(state, 'r.json')
  writeFileSync(rp, JSON.stringify(res))
  const before = readFileSync(path.join(state, 'ledger.json'), 'utf8')
  const g = cli('ingest', '--state', state, '--result', rp)
  assert.equal(g.code, 2)
  assert.match(g.error, /hash が args と違う/)
  assert.equal(readFileSync(path.join(state, 'ledger.json'), 'utf8'), before)
  // next からやり直すと、書き換わった写しを書き直して同じ呼び出しを返し、受け取れる。
  const again = cli('next', '--state', state)
  assert.equal(again.call_id, n.call_id)
  assert.match(readFileSync(args.cells[0].snapshot, 'utf8'), /一つ目の主張/)
  writeFileSync(rp, JSON.stringify(await runWorkflow(args, mockAgent())))
  assert.equal(cli('ingest', '--state', state, '--result', rp).code, 0)
  const L = ledger(state)
  assert.ok(args.cells.every((c) => L.cells[c.cell_id].status === 'settled'))
})

test('args の大きさ: 対象が大きくても args は本文を含まず ARGS_MAX_BYTES 以下', async (t) => {
  const ARGS_MAX_BYTES = 32 * 1024
  const MARK = 'ZQX本文の印ZQX'
  const big = `# 大きな文書\n${Array.from({ length: 60 }, (_, i) => `\n## 節${i}\n${Array.from({ length: 30 }, (_, j) => `${MARK} 節 ${i} の ${j} 行目は本文として十分な長さを持つ。`).join('\n')}`).join('\n')}\n`
  const { state } = setup(t, ['--max-agents-total', '5000'], big)
  const { stop, steps } = await drive(state, mockAgent({
    read: readWith((cell, p) => (cell.endsWith('節3|L1|p1') ? [finding('根拠が無い', evidenceOf(p)[0])] : undefined)),
  }), { maxSteps: 200 })
  assert.equal(stop.stop, 'complete', JSON.stringify(stop))
  assert.deepEqual([...new Set(steps.map((s) => s.step))].sort(), ['group', 'plan', 'review'])
  for (const s of steps) {
    assert.ok(s.argsBytes <= ARGS_MAX_BYTES, `${s.step} の args が ${s.argsBytes} バイト`)
    assert.ok(!JSON.stringify(s.args).includes(MARK), `${s.step} の args に本文が載っている`)
  }
})

// 文の長さ・件数（ヒント・回答・計画の欠陥・指摘）を s 倍にした run を、同じ手順で流す。
// 最初の plan、計画の欠陥でやり直す plan、回答・ヒントの多い plan、目標を answer で直した後の plan、横展開の観点の review、多数の指摘の group を通る。
async function scaledRun(t, s) {
  const M = `ZQX${'利用者の長い文'.repeat(20 * s)}ZQX`
  const d = tmp(t)
  const req = `対象の文書をレビューしてほしい。${M}`
  writeFileSync(path.join(d, 'doc.md'), DOC)
  writeFileSync(path.join(d, 'request.md'), `${req}\n依頼文だけにある一文 RQONLY`)
  writeFileSync(path.join(d, 'goal.md'), `- G1: ${M}の指摘の一覧 〔request: ${req}〕\n`)
  writeFileSync(path.join(d, 'criteria.md'), `- AC1: ${M}を満たす 〔request: ${req}〕\n`)
  writeFileSync(path.join(d, 'decisions.md'), `- ${M}を守る\n`)
  writeFileSync(path.join(d, 'constraints.md'), `- D1: ${M}を守る 〔decisions: ${M}を守る〕\n`)
  const state = path.join(d, 'state')
  const inArgs = ['--goal', 'goal.md', '--request', 'request.md', '--criteria', 'criteria.md', '--decisions', 'decisions.md', '--constraints', 'constraints.md'].map((x, i) => (i % 2 ? path.join(d, x) : x))
  assert.equal(cli('init', '--state', state, ...inArgs, '--target', path.join(d, 'doc.md')).code, 0)
  for (let i = 0; i < s; i++) assert.equal(cli('hint', '--state', state, '--text', `${M}ヒント${i}`).code, 0)
  const proc = `${M}主張ごとに根拠の文を対応づける`
  const lenses = [{ id: 'X1', name: `${M}整合`, procedure: proc }]
  const cmap = (p) => [...p.matchAll(/^ {2}- ([A-Z][A-Z0-9]*\d): /gm)].map((m) => ({ constraint_id: m[1], handled_by: ['X1'] }))
  const qs = Array.from({ length: s }, (_, i) => ({ id: `Q${i + 1}`, question: `${M}問${i}`, why_value_judgment: `${M}理由`, options: [`${M}案`] }))
  let unitDefects = true
  let manyFindings = true
  const log = []
  const agentFn = mockAgent({
    plan: (p) => ({ lenses, questions: [], constraint_map: cmap(p) }),
    integrate: (p) => {
      const again = p.includes('### 前の計画')
      const defects = p.includes('### 欠陥（index') ? JSON.parse(p.split('### 欠陥（index は配列の位置）\n')[1].split('\n#')[0]) : []
      return { lenses, questions: p.includes(`${M}回答`) ? [] : qs, constraint_map: cmap(p), source_map: (again ? ['P:X1'] : ['A:X1', 'B:X1']).map((x) => ({ source: x, merged_into: 'X1', dropped_reason: '' })), defect_responses: defects.map((x) => ({ defect_index: x.index, action: 'fixed', reason: '直した' })) }
    },
    verify: (p, o) => {
      if (!o.label.startsWith('verify-unit-') || !unitDefects) return undefined
      unitDefects = false
      return { unit_id: 'X1', defects: Array.from({ length: s }, (_, i) => ({ kind: `${M}大きすぎる`, claim: `${M}欠陥${i}`, quote: proc })) }
    },
    read: readWith((cell, p) => {
      if (!manyFindings || !cell.endsWith('一つ目の節|X1|p1')) return undefined
      manyFindings = false
      return Array.from({ length: 3 * s }, (_, i) => finding(`${M}指摘${i}`, evidenceOf(p)[0]))
    }),
    group: (p) => ({ groups: [{ id: 'g1', root_cause: `${M}原因`, layer: '実装', keys: groupItems(p).map((x) => x.key), pattern: `${M}横展開の手続き` }], unassigned: [] }),
  }, log)
  const calls = []
  let goalFixed = false
  for (let i = 0; i < 40; i++) {
    const n = cli('next', '--state', state)
    assert.equal(n.code, 0, JSON.stringify(n))
    if (n.stop === 'needs_input' && n.questions) {
      for (const q of n.questions) assert.equal(cli('answer', '--state', state, '--id', q.id, '--text', `${M}回答`).code, 0)
      continue
    }
    if (n.stop) { calls.stop = n; break }
    const raw = readFileSync(n.args_path, 'utf8')
    const args = JSON.parse(raw)
    const res = await runWorkflow(args, agentFn)
    const rp = path.join(state, `result-${n.call_id}.json`)
    writeFileSync(rp, JSON.stringify(res))
    const g = cli('ingest', '--state', state, '--result', rp)
    assert.equal(g.code, 0, JSON.stringify(g))
    const L = ledger(state)
    calls.push({ step: n.step, raw, bytes: Buffer.byteLength(raw), lateral: (args.cells || []).some((c) => /\|lat-/.test(c.cell_id)), defects: L.plan_defects.length, answers: L.answers.length })
    // 回答を計画に取り込んだ後に、目標を answer で直す（目標の照合からやり直す plan を通す）。
    if (!goalFixed && L.answered.length >= s) {
      goalFixed = true
      writeFileSync(path.join(d, 'goal2.md'), `- G1: ${M}の指摘の一覧を直した 〔request: ${req}〕\n`)
      assert.equal(cli('answer', '--state', state, '--id', 'goal', '--file', path.join(d, 'goal2.md')).code, 0)
      calls.at(-1).goalAnswered = true
    }
  }
  return { M, calls, log, L: ledger(state) }
}

test('args の大きさ: 担当が読む文は全て束の写しに入り、args は文の長さ・件数・周の数に比例して増えない', async (t) => {
  const small = await scaledRun(t, 1)
  const big = await scaledRun(t, 20)
  assert.deepEqual(big.calls.map((c) => c.step), small.calls.map((c) => c.step), '同じ手順を通る')
  const steps = big.calls.map((c) => c.step)
  const plans = big.calls.filter((c) => c.step === 'plan').map((c) => ({ ...c, args: JSON.parse(c.raw) }))
  assert.ok(plans[0].args.index && !plans[0].args.prevLensIds.length && !plans[0].args.goalChecked, '最初の plan')
  assert.ok(plans.some((c) => c.args.defectCount >= 20), '計画の欠陥でやり直す plan')
  assert.ok(plans.some((c) => c.args.answerIds.length >= 20), '回答の多い plan')
  const afterGoal = big.calls.findIndex((c) => c.goalAnswered)
  assert.ok(afterGoal >= 0 && big.calls[afterGoal + 1].step === 'plan' && JSON.parse(big.calls[afterGoal + 1].raw).goalIds, '目標を answer で直した後の plan')
  assert.ok(big.calls.some((c) => c.lateral), '横展開の観点の review を通る')
  assert.ok(steps.includes('group'), '束ねを通る')
  assert.ok(big.L.answers.length >= 20 && big.L.groups.length >= 1)
  assert.ok(Object.values(big.L.findings).length >= 60, '多数の指摘を束ねる')
  // 役ごとの束: 計画役・観点の検証役は依頼文・前の欠陥を読まず、目標の照合役は前の計画を読まない。
  const by = (re) => big.log.filter((x) => re.test(x.label))
  assert.ok(by(/^integrate-again/).some((x) => x.prompt.includes(`${big.M}欠陥0`)) && by(/^integrate-again/).some((x) => x.prompt.includes(`${big.M}回答`)), "見直しの統合役は欠陥と回答を読む")
  for (const x of [...by(/^plan-[AB]/), ...by(/^integrate$/), ...by(/^verify-unit-/)]) {
    assert.ok(!x.prompt.includes('RQONLY') && !x.prompt.includes(`${big.M}欠陥0`) && !x.prompt.includes('### 前の計画'), `${x.label} が要らない文を読む`)
  }
  assert.ok(by(/^goal-check/).length >= 2 && by(/^goal-check/).every((x) => x.prompt.includes('RQONLY') && !x.prompt.includes('### 前の計画')))
  for (const [i, c] of big.calls.entries()) {
    assert.ok(!c.raw.includes('ZQX'), `${i}: ${c.step} の args に担当が読む文が載っている（${c.bytes} バイト）`)
    // 件数で増えるのは id と数だけ（文の長さは 20 倍）。
    assert.ok(c.bytes <= small.calls[i].bytes + 2048, `${i}: ${c.step} の args が ${small.calls[i].bytes} から ${c.bytes} バイトに増えた`)
  }
})

test('k=2: 各回の読む役と検証役は別のモデルで起動する', async (t) => {
  const { state } = setup(t, ['--k', '2'])
  const log = []
  const { stop } = await drive(state, mockAgent({ read: readWith((cell) => (cell.endsWith('一つ目の節|L1|p1') || cell.endsWith('一つ目の節|L1|p2') ? [finding('根拠が無い主張', 'この節は一つ目の主張を述べる本文の行である。')] : undefined)) }, log))
  assert.equal(stop.stop, 'complete', JSON.stringify(stop))
  for (const p of [1, 2]) {
    const r = log.find((x) => x.label === `read-${Object.keys(ledger(state).cells).find((k) => k.endsWith(`一つ目の節|L1|p${p}`))}`)
    const v = log.find((x) => x.label === `verify-${Object.keys(ledger(state).cells).find((k) => k.endsWith(`一つ目の節|L1|p${p}`))}`)
    assert.ok(r && v, `p${p} の読みと検証が走る`)
    assert.notEqual(r.model, v.model, `p${p} の読む役と検証役のモデル`)
  }
})

test('init: 外した引数（--mode・--input など）と読めない対象は台帳を作らずに拒否する', (t) => {
  const { d } = setup(t)
  const base = ['--goal', path.join(d, 'goal.md'), '--request', path.join(d, 'request.md'), '--target', path.join(d, 'doc.md')]
  for (const extra of [['--mode', 'review'], ['--input', path.join(d, 'doc.md')], ['--artifact', path.join(d, 'x.md')]]) {
    const s2 = path.join(d, `state${extra[0]}`)
    assert.equal(cli('init', '--state', s2, ...base, ...extra).code, 2, extra[0])
    assert.ok(!existsSync(path.join(s2, 'ledger.json')))
  }
  const s3 = path.join(d, 'state-missing')
  const r = cli('init', '--state', s3, ...base, '--target', path.join(d, 'nothing.md'))
  assert.equal(r.code, 2)
  assert.equal(r.cause, 'input')
  assert.ok(!existsSync(path.join(s3, 'ledger.json')), 'init で読めなければ台帳は作られない')
})

test('計画: 観点の検証が欠陥を出し続けたら、統合のやり直しの上限で needs_input', async (t) => {
  const d = tmp(t)
  writeFileSync(path.join(d, 'doc.md'), DOC)
  writeFileSync(path.join(d, 'goal.md'), '- G1: 対象の文書の見落としを確かめた指摘の一覧 〔request: 対象の文書をレビューしてほしい〕\n')
  writeFileSync(path.join(d, 'request.md'), '対象の文書をレビューしてほしい')
  const state = path.join(d, 'state')
  assert.equal(cli('init', '--state', state, '--goal', path.join(d, 'goal.md'), '--request', path.join(d, 'request.md'), '--target', path.join(d, 'doc.md')).code, 0)
  const log = []
  const { stop } = await drive(state, mockAgent({ verify: (p, o) => (o.label.startsWith('verify-unit-X1') ? { unit_id: 'X1', defects: [{ kind: '大きすぎる', claim: '問いが 2 つある', quote: '"procedure":"主張と根拠を対応づけて' }] } : undefined) }, log))
  assert.equal(stop.stop, 'needs_input', JSON.stringify(stop))
  assert.ok(stop.plan_defects.length >= 1)
  const labels = log.map((x) => x.label)
  assert.ok(labels.includes('plan-A') && labels.includes('plan-B') && labels.includes('integrate') && labels.includes('integrate-again'))
  const idx = log.find((x) => x.label === 'plan-A').prompt
  assert.match(idx, /^写し: .*snap/m, '計画役に渡す索引は写しのファイルの参照')
  assert.ok(!idx.includes('一つ目の主張を述べる'))
})

// ---------------- 目標の固定と照合 ----------------
test('init: 引用の無い項目と、依頼文・決定の記録に無い引用を拒否し、台帳を作らない', (t) => {
  const { d } = setup(t)
  const base = (s) => ['--state', path.join(d, s), '--request', path.join(d, 'request.md'), '--target', path.join(d, 'doc.md')]
  writeFileSync(path.join(d, 'g-none.md'), '- G1: 対象の文書の見落としを観点ごとに確かめた指摘の一覧\n')
  writeFileSync(path.join(d, 'g-fake.md'), '- G1: 指摘の一覧 〔request: 依頼文のどこにも無い架空の一文である〕\n')
  writeFileSync(path.join(d, 'c-fake.md'), '- D1: 本文を直さない 〔decisions: 本文を直さない〕\n')
  for (const [s, extra, re] of [['none', ['--goal', path.join(d, 'g-none.md')], /G1: 引用が無い/], ['fake', ['--goal', path.join(d, 'g-fake.md')], /逐語で無い/], ['nodec', ['--goal', path.join(d, 'goal.md'), '--constraints', path.join(d, 'c-fake.md')], /D1: 引用元が/]]) {
    const r = cli('init', ...base(s), ...extra)
    assert.equal(r.code, 2, s)
    assert.match(JSON.stringify(r.problems), re, s)
    assert.ok(!existsSync(path.join(d, s, 'ledger.json')))
  }
  writeFileSync(path.join(d, 'decisions.md'), '- 本文を直さない\n')
  assert.equal(cli('init', ...base('dec'), '--goal', path.join(d, 'goal.md'), '--constraints', path.join(d, 'c-fake.md'), '--decisions', path.join(d, 'decisions.md')).code, 0, '決定の記録の 1 行の全体は短くても引ける')
})

test('目標の照合（単独）: 照合役が走り、受け止められていない成果は needs_input で成果と引用を返す。偽の引用は受け付けない', async (t) => {
  const { state } = setup(t)
  const log = []
  const quote = '対象の文書を観点ごとにレビューして、確かめた指摘を返してほしい'
  const { stop } = await drive(state, mockAgent({ goal: () => ({ outcomes: [{ outcome: '確かめた指摘', quotes: [{ source: 'request', quote }], items: [] }] }) }, log))
  assert.ok(log.some((x) => x.label === 'goal-check'), '単独で呼んだときは照合する')
  assert.equal(stop.stop, 'needs_input', JSON.stringify(stop))
  assert.deepEqual(stop.goal_gaps, [{ outcome: '確かめた指摘', quotes: [{ source: 'request', quote }] }])
  const { state: s2 } = setup(t)
  const r = await drive(s2, mockAgent({ goal: () => ({ outcomes: [{ outcome: '架空', quotes: [{ source: 'request', quote: '依頼文に無い架空の成果を求める一文' }], items: ['G1'] }] }) }))
  assert.equal(r.stop.stop, 'needs_input')
  assert.deepEqual(r.stop.stuck, ['goal'])
  assert.equal(ledger(s2).goal.checked, false, '偽の引用の照合では合格にしない')
})

test('目標の照合（coverage-build から）: --goal-checked で照合を流さず、引用の無い項目も受け、基準を制約と別の欄に持つ', async (t) => {
  const { d } = setup(t)
  writeFileSync(path.join(d, 'g.md'), '設計が次の目標を満たすかを確かめる。\n\n- G1: 値を計算する関数\n')
  writeFileSync(path.join(d, 'ac.md'), '- AC1: 入力が 1 なら 2 を返す\n- U1A1: 値を返す\n')
  writeFileSync(path.join(d, 'c.md'), '- D1: 依存を足さない\n')
  const state = path.join(d, 'checked')
  const r = cli('init', '--state', state, '--goal', path.join(d, 'g.md'), '--request', path.join(d, 'request.md'), '--criteria', path.join(d, 'ac.md'), '--constraints', path.join(d, 'c.md'), '--target', path.join(d, 'doc.md'), '--goal-checked', 'coverage-build')
  assert.equal(r.code, 0, JSON.stringify(r))
  assert.equal(cli('init', '--state', path.join(d, 'x'), '--goal', path.join(d, 'g.md'), '--request', path.join(d, 'request.md'), '--target', path.join(d, 'doc.md'), '--goal-checked', 'someone').code, 2, '印は coverage-build だけ')
  const log = []
  const { stop, steps } = await drive(state, mockAgent({}, log))
  assert.equal(stop.stop, 'complete', JSON.stringify(stop))
  assert.ok(!log.some((x) => x.label.startsWith('goal-check')), '照合を流さない')
  const L = ledger(state)
  assert.deepEqual(L.criteria.map((c) => c.id), ['AC1', 'U1A1'])
  assert.deepEqual(L.constraints.map((c) => c.id), ['D1'])
  const plan = log.find((x) => x.label === 'plan-A').prompt
  assert.match(plan, /受け入れ基準[^\n]*\n {2}- AC1: /)
  assert.ok(steps[0].res.plan.constraint_map.some((m) => m.constraint_id === 'AC1'), '基準にも受け皿の観点を付ける')
})

test('answer: 目標・基準・制約・決定の記録はファイルで直し、引用を照らしてから照合をやり直す', async (t) => {
  const { d, state } = setup(t)
  await drive(state, mockAgent())
  writeFileSync(path.join(d, 'g2.md'), '- G1: 指摘の一覧 〔request: 依頼文のどこにも無い架空の一文である〕\n')
  assert.equal(cli('answer', '--state', state, '--id', 'goal', '--file', path.join(d, 'g2.md')).code, 2)
  assert.equal(ledger(state).goal.checked, true, '拒否した直しは台帳を変えない')
  writeFileSync(path.join(d, 'g3.md'), '- G1: 確かめた指摘の一覧 〔request: 確かめた指摘を返してほしい〕\n')
  assert.equal(cli('answer', '--state', state, '--id', 'goal', '--file', path.join(d, 'g3.md')).code, 0)
  assert.equal(ledger(state).goal.checked, false)
  const log = []
  await drive(state, mockAgent({}, log))
  assert.ok(log.some((x) => x.label === 'goal-check'))
  assert.equal(ledger(state).goal.checked, true)
})

test('引用の短さ: 依頼文の空でない 1 行の全体は短くても引ける。行の一部は引けない', (t) => {
  const { d } = setup(t)
  writeFileSync(path.join(d, 'request.md'), '対象の文書を観点ごとにレビューして、確かめた指摘を返してほしい。\n\n  直してやり直す  \n')
  const src = C.citeSources({ request: readFileSync(path.join(d, 'request.md'), 'utf8') })
  const q = (quote) => C.checkGoalMap({ outcomes: [{ outcome: '成果', quotes: [{ source: 'request', quote }], items: ['G1'] }] }, ['G1'], src)
  assert.deepEqual(q('直してやり直す'), [])
  assert.match(q('直して')[0], /字未満/)
  writeFileSync(path.join(d, 'goal-short.md'), '- G1: 直してやり直す 〔request: 直してやり直す〕\n')
  const r = cli('init', '--state', path.join(d, 'short'), '--goal', path.join(d, 'goal-short.md'), '--request', path.join(d, 'request.md'), '--target', path.join(d, 'doc.md'))
  assert.equal(r.code, 0, JSON.stringify(r))
})

test('ingest: 受け付けなかった出力があれば、その理由を出力の rejected に載せる（受け付けたときは載せない）', async (t) => {
  const { state, d } = setup(t)
  const n = cli('next', '--state', state)
  const fake = { outcome: '架空', quotes: [{ source: 'request', quote: '依頼文に無い架空の成果を求める一文' }], items: ['G1'] }
  const res = await runWorkflow(JSON.parse(readFileSync(n.args_path, 'utf8')), mockAgent({ goal: () => ({ outcomes: [fake] }) }))
  writeFileSync(path.join(d, 'bad.json'), JSON.stringify(res))
  const g = cli('ingest', '--state', state, '--result', path.join(d, 'bad.json'))
  assert.equal(g.code, 0, JSON.stringify(g))
  assert.equal(g.ok, true)
  assert.ok(g.rejected.length >= 1 && /目標の照合.*逐語で無い/.test(g.rejected.join('\n')), JSON.stringify(g.rejected))
  const { state: s2, d: d2 } = setup(t)
  const n2 = cli('next', '--state', s2)
  writeFileSync(path.join(d2, 'ok.json'), JSON.stringify(await runWorkflow(JSON.parse(readFileSync(n2.args_path, 'utf8')), mockAgent())))
  const ok = cli('ingest', '--state', s2, '--result', path.join(d2, 'ok.json'))
  assert.equal(ok.code, 0)
  assert.equal(ok.rejected, undefined)
})

test('ingest: Workflow が args を拒否した結果は、呼び出しの違いでなく args の拒否として案内する', async (t) => {
  const { state, d } = setup(t)
  const n = cli('next', '--state', state)
  const args = JSON.parse(readFileSync(n.args_path, 'utf8'))
  const res = await runWorkflow({ ...args, criteriaIds: [...(args.criteriaIds || []), 'AC9'] }, mockAgent())
  assert.equal(res.status, 'blocked')
  writeFileSync(path.join(d, 'r.json'), JSON.stringify(res))
  const g = cli('ingest', '--state', state, '--result', path.join(d, 'r.json'))
  assert.equal(g.code, 2)
  assert.match(g.error, /args を拒否/)
})

test('answer: 質問への回答から作る制約の id は、既にある基準・制約の id と重ならない', async (t) => {
  const { d } = setup(t)
  writeFileSync(path.join(d, 'g.md'), '- G1: 値を計算する関数\n')
  writeFileSync(path.join(d, 'c.md'), '- D1: 依存を足さない\n- A1: coverage-build の回答から来た制約\n')
  const state = path.join(d, 'qa')
  assert.equal(cli('init', '--state', state, '--goal', path.join(d, 'g.md'), '--request', path.join(d, 'request.md'), '--constraints', path.join(d, 'c.md'), '--target', path.join(d, 'doc.md'), '--goal-checked', 'coverage-build').code, 0)
  const qs = [{ id: 'Q1', question: 'どちらにするか', why_value_judgment: '価値の判断', options: ['甲', '乙'] }]
  const base = mockAgent()
  const agentFn = async (prompt, opts) => {
    const r = await base(prompt, opts)
    if (opts.label.startsWith('integrate') && !ledger(state).answers.length) return { ...r, questions: qs }
    return r
  }
  const { stop } = await drive(state, agentFn)
  assert.equal(stop.stop, 'needs_input', JSON.stringify(stop))
  assert.deepEqual(stop.questions.map((q) => q.id), ['Q1'])
  assert.equal(cli('answer', '--state', state, '--id', 'Q1', '--text', '甲にする').code, 0)
  const ids = ledger(state).constraints.map((c) => c.id)
  assert.equal(new Set(ids).size, ids.length, JSON.stringify(ids))
  assert.deepEqual(ids, ['D1', 'A1', 'A2'])
})
