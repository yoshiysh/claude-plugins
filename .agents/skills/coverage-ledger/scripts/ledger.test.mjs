import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { C, MAX_ATTEMPTS, findingId, splitAssets, splitItems } from './ledger-core.mjs'
import { cli, drive, evidenceOf, jsonAfter, mockAgent, runWorkflow, tmp } from './test-harness.mjs'

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
  writeFileSync(path.join(d, 'goal.md'), '対象の文書の見落としを観点ごとに確かめた指摘の一覧')
  writeFileSync(path.join(d, 'request.md'), '対象の文書を観点ごとにレビューして、確かめた指摘を返してほしい')
  writeFileSync(path.join(d, 'lenses.json'), JSON.stringify([{ id: 'L1', name: '主張と根拠', procedure: '主張ごとに根拠の文を対応づけ、根拠の無い主張を探す' }]))
  const state = path.join(d, 'state')
  const r = cli('init', '--state', state, '--mode', 'review', '--goal', path.join(d, 'goal.md'), '--request', path.join(d, 'request.md'), '--target', path.join(d, 'doc.md'), '--lenses', path.join(d, 'lenses.json'), ...extra)
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

test('入力: jsonl は 1 行 1 項目、Markdown は見出しごと。要約せず全文を持つ', () => {
  const j = splitItems('/x/in.jsonl', '{"id":"G01","text":"一つ目"}\n{"text":"二つ目","routable":false}\n', 'P')
  assert.deepEqual(j.map((i) => [i.id, i.routable, i.text]), [['G01', true, '一つ目'], ['P2', false, '二つ目']])
  const m = splitItems('/x/in.md', '前文\n# A\nあ\n# B\nい', 'M')
  assert.deepEqual(m.map((i) => i.id), ['M0', 'M1', 'M2'])
})

test('引用の照合: 短い・無い・見出しだけは読んだ証拠にならず、行番号は外して照らす', () => {
  const text = '# 見出しの文字列はここに十分な長さで\n本文の一行目はこのように続いていく。'
  assert.match(C.quoteProblem('短い', text), /字未満/)
  assert.match(C.quoteProblem('本文に無い長い文字列をここに書く', text), /逐語で無い/)
  assert.match(C.quoteProblem('見出しの文字列はここに十分な長さで', text), /見出しだけ/)
  assert.equal(C.quoteProblem('2| 本文の一行目はこのように', text), null)
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
  assert.ok(log.filter((x) => x.label.startsWith('read-')).every((x) => !x.prompt.includes('二つ目の主張') || !x.prompt.includes('一つ目の主張') || x.label.includes('#対象の文書|')), '1 体に渡す本文は自分の枡の資産だけ')
})

test('横展開: 確かめた欠陥の型を、全ての資産へ新しい観点として問い直す', async (t) => {
  const { state } = setup(t)
  let lateralSeen = 0
  const agentFn = mockAgent({
    read: readWith((cell) => (cell.endsWith('一つ目の節|L1|p1') ? [finding('根拠が無い主張', 'この節は一つ目の主張を述べる本文の行である。')] : (cell.includes('|lat-') ? (lateralSeen++, []) : undefined))),
    group: (prompt) => ({ groups: [{ id: 'g1', root_cause: '根拠を書かない', layer: '実装', keys: jsonAfter(prompt, '### 全件').map((x) => x.key), pattern: '主張ごとに根拠を対応づけ、根拠の無い主張を探す（横展開）' }], unassigned: [] }),
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
  const { stop } = await drive(state, mockAgent({ read: (p, o) => (o.label.includes('一つ目の節|purpose') && n++ < 2 ? { cell_id: o.label.slice(5).split('（')[0], evidence: ['本文に無い引用をここに書いている'], findings: [], outside_notes: [], none_reason: 'x' } : undefined) }))
  assert.equal(stop.stop, 'complete')
  const L = ledger(state)
  const c = Object.entries(L.cells).find(([id]) => id.includes('一つ目の節|purpose'))[1]
  assert.equal(c.status, 'settled')
  assert.equal(c.attempts, 1, 'やり直しの 2 体とも落ちた 1 回目の呼び出しだけが試行に数える')
})

test('検証役の却下: 検証が揃わない枡は読み直しに戻り、次で確かめられる（H1）', async (t) => {
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

test('全件失敗: 全ての役が欠けた呼び出しが続けば blocked で、complete にしない（H2）', async (t) => {
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

test('不正な出力（振り分け）: 同じ入力の行き先が 2 回とも照合に落ちたら needs_input で返す', async (t) => {
  const { d, state } = setup(t)
  writeFileSync(path.join(d, 'rules.jsonl'), '{"id":"R1","text":"主張には必ず根拠の文を添えるという規準"}\n')
  rmSync(path.join(state, 'ledger.json'))
  assert.equal(cli('init', '--state', state, '--mode', 'review', '--goal', path.join(d, 'goal.md'), '--request', path.join(d, 'request.md'), '--target', path.join(d, 'doc.md'), '--lenses', path.join(d, 'lenses.json'), '--input', path.join(d, 'rules.jsonl')).code, 0)
  const { stop } = await drive(state, mockAgent({ route: () => ({ routes: [{ input_id: 'R1', dest: 'lens', target: 'L1', reason: '', quote: '入力に無い引用の文字列をここに書く' }] }) }))
  assert.equal(stop.stop, 'needs_input')
  assert.deepEqual(stop.stuck, ['route:R1'])
})

test('規準の受け渡し: 観点へ送られた入力の全文が、その観点の枡を読む役に届く', async (t) => {
  const { d, state } = setup(t)
  writeFileSync(path.join(d, 'rules.jsonl'), '{"id":"R1","text":"主張には必ず根拠の文を添えるという規準"}\n')
  rmSync(path.join(state, 'ledger.json'))
  assert.equal(cli('init', '--state', state, '--mode', 'review', '--goal', path.join(d, 'goal.md'), '--request', path.join(d, 'request.md'), '--target', path.join(d, 'doc.md'), '--lenses', path.join(d, 'lenses.json'), '--input', path.join(d, 'rules.jsonl')).code, 0)
  const log = []
  const { stop } = await drive(state, mockAgent({ route: (p) => ({ routes: [{ input_id: 'R1', dest: 'lens', target: 'L1', reason: '', quote: '主張には必ず根拠の文を添える' }] }) }, log))
  assert.equal(stop.stop, 'complete', JSON.stringify(stop))
  const reads = log.filter((x) => x.label.startsWith('read-'))
  assert.ok(reads.filter((x) => x.label.includes('|L1|')).every((x) => x.prompt.includes('根拠の文を添えるという規準')))
  assert.ok(reads.filter((x) => !x.label.includes('|L1|')).every((x) => !x.prompt.includes('根拠の文を添えるという規準')))
})

test('検証不能: 検証不能の指摘は消えず、完了にせず needs_input で返す（H3）', async (t) => {
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

test('同じ枡の複数の指摘: 種別が同じでも引用か主張が違えば別の指摘として残る（H4）', async (t) => {
  const { state } = setup(t)
  const two = [finding('一つ目の欠陥', 'この節は一つ目の主張を述べる本文の行である。'), finding('二つ目の欠陥', '二行目もこの節の主張を補う本文の行として置く。')]
  await drive(state, mockAgent({ read: readWith((cell) => (cell.endsWith('一つ目の節|L1|p1') ? two : undefined)) }))
  const L = ledger(state)
  const ids = Object.keys(L.findings).filter((k) => k.includes('一つ目の節|L1|p1'))
  assert.equal(ids.length, 2)
  assert.notEqual(findingId('c', two[0]), findingId('c', two[1]))
})

test('上の層: 方針・要求が原因の欠陥は直さず needs_input で返す（H5）', async (t) => {
  const { state } = setup(t)
  const { stop } = await drive(state, mockAgent({ read: readWith((cell) => (cell.endsWith('一つ目の節|purpose|p1') ? [finding('要求が足りない', 'この節は一つ目の主張を述べる本文の行である。', '要求')] : undefined)) }))
  assert.equal(stop.stop, 'needs_input')
  assert.equal(stop.upper.length, 1)
})

test('持ち越し: 変わった節の枡だけ古い印が付いて読み直され、消えた対象は blocked（H6）', async (t) => {
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

test('受け取り: 待っている呼び出しと違う結果は受け付けない（古い run の遅れた書き込みを防ぐ）', async (t) => {
  const { state, d } = setup(t)
  const n = cli('next', '--state', state)
  writeFileSync(path.join(d, 'r.json'), JSON.stringify({ stage: n.step, call_id: 'deadbeef0000', agents: [] }))
  const g = cli('ingest', '--state', state, '--result', path.join(d, 'r.json'))
  assert.equal(g.code, 2)
  assert.match(g.error, /呼び出しが違う/)
  assert.equal(cli('next', '--state', state).call_id, n.call_id, '同じ状態からの next は同じ呼び出しを返す（運び直せる）')
})

test('args の写し: 運ぶ途中で書き換わった args は Workflow が役を起動せずに拒否する', async (t) => {
  const { state } = setup(t)
  const n = cli('next', '--state', state)
  const args = JSON.parse(readFileSync(n.args_path, 'utf8'))
  const log = []
  const res = await runWorkflow({ ...args, goal: `${args.goal}（書き換え）` }, mockAgent({}, log))
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

test('create: 計画（独立な 2 体・統合・振り分け・単位ごとの検証）→ 依存の順の案 → 書き手 → レビュー → 直す', async (t) => {
  const d = tmp(t)
  writeFileSync(path.join(d, 'goal.md'), '入力から設計の文書を作る')
  writeFileSync(path.join(d, 'request.md'), '入力の項目を全て扱って設計の文書を作ってほしい')
  writeFileSync(path.join(d, 'constraints.md'), '- D1: 特定のスキルに依存させない\n')
  writeFileSync(path.join(d, 'in.jsonl'), ['{"id":"R1","text":"一つ目の入力の項目の全文がここに書いてある"}', '{"id":"R2","text":"二つ目の入力の項目の全文がここに書いてある"}'].join('\n'))
  const state = path.join(d, 'state')
  const art = path.join(d, 'out.md')
  assert.equal(cli('init', '--state', state, '--mode', 'create', '--goal', path.join(d, 'goal.md'), '--request', path.join(d, 'request.md'), '--constraints', path.join(d, 'constraints.md'), '--artifact', art, '--input', path.join(d, 'in.jsonl')).code, 0)
  const log = []
  let fixed = false
  const agentFn = mockAgent({
    read: readWith((cell) => (!fixed && cell.endsWith('一つ目の節|X1|p1') ? [finding('決定の理由が無い', 'この節は論点一つ目の決定を書いた本文の行である。', '方式設計')] : undefined)),
    write: (p) => { if (p.includes('成果物に戻ってきた欠陥')) fixed = true },
  }, log)
  const { stop, steps } = await drive(state, async (p, o) => {
    const r = await agentFn(p, o)
    if (o.label === 'write' && fixed && r && r.markdown) r.markdown = r.markdown.replace('決定を書いた本文の行である。', '決定と理由を書いた本文の行である。')
    return r
  })
  assert.equal(stop.stop, 'complete', JSON.stringify(stop))
  const kinds = steps.map((s) => s.step)
  assert.deepEqual(kinds.slice(0, 3), ['plan', 'generate', 'review'])
  assert.ok(kinds.includes('group'))
  assert.equal(kinds.filter((k) => k === 'generate').length, 2, '確かめた欠陥を論点へ戻して直す')
  const labels = log.map((x) => x.label)
  assert.ok(labels.includes('plan-A') && labels.includes('plan-B') && labels.includes('integrate'))
  assert.ok(labels.some((l) => l.startsWith('route-')) && labels.some((l) => l.startsWith('verify-unit-')))
  const t2 = log.find((x) => x.label === 'propose-T2')
  assert.ok(t2.prompt.includes('T1 の決定'), '依存のある論点に上流の案の中身が渡る')
  assert.ok(log.findIndex((x) => x.label === 'propose-T1') < log.findIndex((x) => x.label === 'propose-T2'))
  const t1 = log.filter((x) => x.label === 'propose-T1')
  assert.equal(t1.length, 2, '欠陥で戻した論点の実行役は 2 回走る')
  assert.ok(!t1[0].prompt.includes('### 前の案'), '初回には前の案が無い')
  const back = t1[1].prompt.split('### 前の案')[1] || ''
  assert.ok(back.includes('T1 の決定'), '欠陥で戻した論点の実行役に前の案（決定の文）が渡る')
  assert.ok(!back.startsWith('\nnull'), '前の案が null で渡らない')
  const L = ledger(state)
  assert.ok(L.written)
  assert.match(readFileSync(art, 'utf8'), /決定と理由を書いた/)
  assert.ok(Object.values(L.findings).some((f) => f.fix === 'fixed'))
})

test('create: 単位の検証が欠陥を出し続けたら、統合のやり直しの上限で needs_input', async (t) => {
  const d = tmp(t)
  writeFileSync(path.join(d, 'goal.md'), '入力から設計の文書を作る')
  writeFileSync(path.join(d, 'request.md'), '入力の項目を全て扱って設計の文書を作ってほしい')
  const state = path.join(d, 'state')
  assert.equal(cli('init', '--state', state, '--mode', 'create', '--goal', path.join(d, 'goal.md'), '--request', path.join(d, 'request.md'), '--artifact', path.join(d, 'out.md')).code, 0)
  const { stop } = await drive(state, mockAgent({ verify: (p, o) => (o.label.startsWith('verify-unit-T1') ? { unit_id: 'T1', defects: [{ kind: '大きすぎる', claim: '問いが 2 つある', quote: '"question":"q1"' }] } : undefined) }))
  assert.equal(stop.stop, 'needs_input')
  assert.ok(stop.plan_defects.length >= 1)
})
