// 横展開の収束: 束ね役が既存の横展開の観点に結ぶ（extends）か新しい型かを返し、新しい型のときだけ観点を作る。
// 新しい型が 0 件なら complete、上限の周で新しい型が残れば needs_input（未展開の型の群）で止まる。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { C } from './ledger-core.mjs'
import { WF, cli, evidenceOf, groupItems, mockAgent, runWorkflow, tmp } from './test-harness.mjs'

const DOC = `# 対象の文書

## 一つ目の節
この節は一つ目の主張を述べる本文の行である。
二行目もこの節の主張を補う本文の行として置く。

## 二つ目の節
この節は二つ目の主張を述べる本文の行である。
二行目もこの節の主張を補う本文の行として置く。
`
const Q1 = 'この節は一つ目の主張を述べる本文の行である。'
const Q2 = 'この節は二つ目の主張を述べる本文の行である。'
// 1 周目の型（横展開の観点 lat-G1-g1 になる）。根本原因と型の文は、args に載らないことを照らすため他の文と重ならない語にする。
const ROOT1 = '主張に根拠の文を添えない書き癖'
const PATTERN1 = '節ごとに主張の文を列挙し、それを支える根拠の文と一対一に照らす（横展開の型その一）'
const ROOT2 = '節の見出しと本文の主張がずれる別の書き癖'
const PATTERN2 = '節ごとに見出しの語を列挙し、本文の主張の語と照らす（横展開の型その二）'

function setup(t, extra = [], doc = DOC) {
  const d = tmp(t)
  writeFileSync(path.join(d, 'doc.md'), doc)
  writeFileSync(path.join(d, 'goal.md'), '- G1: 対象の文書の見落としを観点ごとに確かめた指摘の一覧 〔request: 対象の文書を観点ごとにレビューして、確かめた指摘を返してほしい〕\n')
  writeFileSync(path.join(d, 'request.md'), '対象の文書を観点ごとにレビューして、確かめた指摘を返してほしい')
  writeFileSync(path.join(d, 'lenses.json'), JSON.stringify([{ id: 'L1', name: '主張と根拠', procedure: '主張ごとに根拠の文を対応づけ、根拠の無い主張を探す' }]))
  const state = path.join(d, 'state')
  const r = cli('init', '--state', state, '--goal', path.join(d, 'goal.md'), '--request', path.join(d, 'request.md'), '--target', path.join(d, 'doc.md'), '--lenses', path.join(d, 'lenses.json'), ...extra)
  assert.equal(r.code, 0, JSON.stringify(r))
  return { d, state }
}
const ledger = (state) => JSON.parse(readFileSync(path.join(state, 'ledger.json'), 'utf8'))
const assetEnding = (state, tail) => Object.keys(ledger(state).assets).find((id) => id.endsWith(tail))
const finding = (claim, quote, layer = '実装') => ({ claim, quote, severity: 'MEDIUM', layer })
const readWith = (findingsFor) => (prompt, opts) => {
  const cell = opts.label.slice('read-'.length).split('（')[0]
  const fs = findingsFor(cell)
  if (fs === undefined) return undefined
  return { cell_id: cell, evidence: evidenceOf(prompt), findings: fs, outside_notes: [], none_reason: fs.length ? '' : '該当なし' }
}
// 担当が読む全ての写し: prompt の「束: <file>（hash」と「写し: <file>\n行: s-e」が指す中身を、prompt の後ろに足す。
// 既存の横展開の観点の一覧が、共通の束・別の束・別の写しのどれで渡っても見つけられるようにする。
function expandAll(prompt) {
  const out = [prompt]
  for (const m of prompt.matchAll(/^束: (.+?)（hash /gm)) out.push(readFileSync(m[1], 'utf8'))
  for (const m of prompt.matchAll(/^写し: (.+)\n行: (\d+)-(\d+)/gm)) out.push(readFileSync(m[1], 'utf8').split('\n').slice(Number(m[2]) - 1, Number(m[3])).join('\n'))
  return out.join('\n')
}
const lensIds = (L) => L.lenses.filter((l) => l.status !== 'gone').map((l) => l.id)
const liveCells = (L, lens) => Object.entries(L.cells).filter(([id, c]) => id.includes(`|${lens}|`) && c.status !== 'gone')
// 未展開の型の群の欄（upper_groups と同じく群の id の配列。要素が {id, …} でも id を読む）。
const lateralIds = (stop) => (Array.isArray(stop.lateral_groups) ? stop.lateral_groups.map((x) => (typeof x === 'string' ? x : x && x.id)) : null)

// 1 周目: L1 が一つ目の節に指摘を出し、束ね役が新しい型（g1）を返して lat-G1-g1（二つ目の節に当たる）を作る。
// 2 周目: lat-G1-g1 の枡が二つ目の節に指摘を出し、束ね役は second(items, state) の群を返す。
function twoCycleAgent(state, second, log = []) {
  const groupPrompts = []
  const agentFn = mockAgent({
    read: readWith((cell) => {
      if (cell.endsWith('一つ目の節/p1|L1|p1')) return [finding('根拠が無い主張', Q1)]
      if (cell.includes('|lat-G1-g1|')) return [finding('同じ型の根拠が無い主張', Q2)]
      return undefined
    }),
    group: (prompt) => {
      const items = groupItems(prompt)
      groupPrompts.push({ lens: items[0].lens, prompt: expandAll(prompt) })
      if (items[0].lens === 'L1') return { groups: [{ id: 'g1', root_cause: ROOT1, layer: '実装', keys: items.map((x) => x.key), pattern: PATTERN1, applies_to: [assetEnding(state, '二つ目の節/p1')] }], unassigned: [] }
      return second(items, state)
    },
  }, log)
  return { agentFn, groupPrompts }
}
const extendsGroup = (items, extra = {}) => ({ groups: [{ id: 'g1', root_cause: ROOT1, layer: '実装', keys: items.map((x) => x.key), pattern: '', applies_to: [], extends: 'lat-G1-g1', ...extra }], unassigned: [] })
const newTypeGroup = (items, state) => ({ groups: [{ id: 'g1', root_cause: ROOT2, layer: '実装', keys: items.map((x) => x.key), pattern: PATTERN2, applies_to: [assetEnding(state, '一つ目の節/p1')] }], unassigned: [] })

// drive と同じく next → Workflow → ingest を回し、取り込みの後の台帳が until を満たしたら止める。
async function driveUntil(state, agentFn, until, maxSteps = 30) {
  const steps = []
  for (let i = 0; i < maxSteps; i++) {
    const n = cli('next', '--state', state)
    if (n.code !== 0 || n.stop) return { stop: n, steps }
    const args = JSON.parse(readFileSync(n.args_path, 'utf8'))
    const res = await runWorkflow(args, agentFn)
    const rp = path.join(state, `result-${n.call_id}.json`)
    writeFileSync(rp, JSON.stringify(res))
    const g = cli('ingest', '--state', state, '--result', rp)
    steps.push({ step: n.step, args, res, cycle: n.cycle, ingest: g })
    if (g.code !== 0) return { stop: g, steps }
    if (until(ledger(state))) return { stop: null, steps }
  }
  return { stop: null, steps }
}
const drive = (state, agentFn) => driveUntil(state, agentFn, () => false)

test('max_cycles の既定: --max-cycles を渡さない init の台帳は max_cycles 2', (t) => {
  const { state } = setup(t)
  assert.equal(ledger(state).config.max_cycles, 2)
})

test('束ね役の入力: 2 周目の束ね役は、既にある横展開の観点の id・型・根本原因を写しで受け取り、args にはその文を載せない', async (t) => {
  const { state } = setup(t, ['--max-cycles', '4'])
  const { agentFn, groupPrompts } = twoCycleAgent(state, extendsGroup)
  const { steps } = await drive(state, agentFn)
  const second = groupPrompts.find((g) => g.lens === 'lat-G1-g1')
  assert.ok(second, `2 周目の束ねまで進む: ${JSON.stringify(groupPrompts.map((g) => g.lens))}`)
  assert.ok(second.prompt.includes('lat-G1-g1'), '横展開の観点の id を渡す')
  assert.ok(second.prompt.includes(PATTERN1), '横展開の観点の型（手続き）を渡す')
  assert.ok(second.prompt.includes(ROOT1), '横展開の観点の根本原因を渡す')
  const groupArgs = steps.filter((s) => s.step === 'group').map((s) => JSON.stringify(s.args))
  assert.equal(groupArgs.length, 2)
  for (const a of groupArgs) {
    assert.ok(!a.includes(PATTERN1), 'args に型の文を載せない（写しで渡す）')
    assert.ok(!a.includes(ROOT1), 'args に根本原因の文を載せない（写しで渡す）')
  }
})

test('extends: 既存の横展開の観点に結ぶ群からは新しい観点を作らず、群に extends と指摘を記録し、新しい型が 0 件なので complete（次の周に進まない）', async (t) => {
  const { state } = setup(t)
  const { agentFn } = twoCycleAgent(state, extendsGroup)
  const { stop } = await drive(state, agentFn)
  assert.equal(stop.stop, 'complete', JSON.stringify(stop))
  const L = ledger(state)
  assert.ok(lensIds(L).includes('lat-G1-g1'), '1 周目の新しい型は観点にする')
  assert.ok(!L.lenses.some((l) => l.id.startsWith('lat-G2-')), `extends の群から観点を作らない: ${JSON.stringify(L.lenses.map((l) => l.id))}`)
  assert.ok(!Object.keys(L.cells).some((id) => id.includes('|lat-G2-')), 'extends の群から枡を作らない')
  const g = L.groups.find((x) => x.id === 'G2-g1')
  assert.ok(g, `2 周目の群を台帳に残す: ${JSON.stringify(L.groups.map((x) => x.id))}`)
  assert.equal(g.extends, 'lat-G1-g1', '群に extends を記録する')
  const latFinding = Object.keys(L.findings).find((id) => id.includes('|lat-G1-g1|'))
  assert.ok(latFinding && g.keys.includes(latFinding), '指摘をその群に結ぶ')
  assert.equal(L.cycle, 2, '新しい型が 0 件の周は次の周に進まない')
})

test('extends: pattern と applies_to を併せて返しても、extends のある群からは新しい観点も枡も作らない', async (t) => {
  const { state } = setup(t)
  const { agentFn } = twoCycleAgent(state, (items, st) => extendsGroup(items, { pattern: PATTERN2, applies_to: [assetEnding(st, '一つ目の節/p1')] }))
  await drive(state, agentFn)
  const L = ledger(state)
  assert.ok(lensIds(L).includes('lat-G1-g1'), '1 周目までは進む')
  assert.ok(!L.lenses.some((l) => l.id.startsWith('lat-G2-')), JSON.stringify(L.lenses.map((l) => l.id)))
  assert.ok(!Object.keys(L.cells).some((id) => id.includes('|lat-G2-')))
})

test('extends の照合: 実在しない観点の id や、横展開でない観点の id を指す群は受け付けず（rejected_grouping）、観点を作らない', async (t) => {
  for (const bad of ['lat-G9-zz', 'L1']) {
    const { state } = setup(t)
    const { agentFn } = twoCycleAgent(state, (items) => extendsGroup(items, { extends: bad }))
    await drive(state, agentFn)
    const L = ledger(state)
    assert.ok(lensIds(L).includes('lat-G1-g1'), `${bad}: 2 周目の束ねまで進む`)
    const rej = L.events.filter((e) => e.kind === 'rejected_grouping' && e.cycle === 2)
    assert.ok(rej.length >= 1, `${bad}: 2 周目の束ねを受け付けない: ${JSON.stringify(L.events.map((e) => [e.cycle, e.kind]))}`)
    assert.ok(rej.some((e) => e.text.includes(bad)), `${bad}: 拒否の理由に id を挙げる: ${JSON.stringify(rej.map((e) => e.text))}`)
    assert.ok(!L.groups.some((g) => g.cycle === 2), `${bad}: 受け付けない束ねの群を台帳に残さない`)
    assert.ok(!L.lenses.some((l) => l.id.startsWith('lat-G2-')))
  }
})

test('新しい型が 0 件: 1 周目の束ねが型の無い群だけなら、横展開の枡を足さず、--max-cycles 1 でも limit でなく complete', async (t) => {
  const { state } = setup(t, ['--max-cycles', '1'])
  const agentFn = mockAgent({
    read: readWith((cell) => (cell.endsWith('一つ目の節/p1|L1|p1') ? [finding('根拠が無い主張', Q1)] : undefined)),
    group: (prompt) => ({ groups: [{ id: 'g1', root_cause: ROOT1, layer: '実装', keys: groupItems(prompt).map((x) => x.key), pattern: '', applies_to: [] }], unassigned: [] }),
  })
  const { stop, steps } = await drive(state, agentFn)
  assert.ok(steps.some((s) => s.step === 'group'), '束ねまで進む')
  assert.equal(stop.stop, 'complete', JSON.stringify(stop))
  const L = ledger(state)
  assert.ok(!L.lenses.some((l) => l.id.startsWith('lat-')))
  assert.ok(!Object.keys(L.cells).some((id) => id.includes('|lat-')))
  assert.equal(L.cycle, 1, '新しい型が 0 件の周は次の周に進まない')
})

test('上限の周: 既定の 2 周目の束ねで新しい型が残れば、観点を作らず needs_input で「横展開が収束しない」と未展開の群（lateral_groups）を返し、その群への answer の後は展開せずに記録して complete', async (t) => {
  const { state } = setup(t)
  const { agentFn } = twoCycleAgent(state, newTypeGroup)
  const { stop } = await drive(state, agentFn)
  assert.equal(stop.stop, 'needs_input', JSON.stringify(stop))
  assert.ok(stop.reasons.some((r) => /横展開/.test(r) && /収束しない/.test(r)), JSON.stringify(stop.reasons))
  assert.deepEqual(lateralIds(stop), ['G2-g1'], `未展開の型の群を返す: ${JSON.stringify(stop.lateral_groups)}`)
  assert.ok(!(stop.upper_groups || []).includes('G2-g1'), '層が実装の群は上の層の群にしない')
  const L = ledger(state)
  assert.ok(!L.lenses.some((l) => l.id.startsWith('lat-G2-')), `上限の周の新しい型から観点を作らない: ${JSON.stringify(L.lenses.map((l) => l.id))}`)
  assert.ok(!Object.keys(L.cells).some((id) => id.includes('|lat-G2-')), '上限の周の新しい型から枡を作らない')
  const g = L.groups.find((x) => x.id === 'G2-g1')
  assert.ok(g && g.pattern === PATTERN2, '未展開の型の群を台帳に残す')

  const a = cli('answer', '--state', state, '--id', 'G2-g1', '--text', '展開せずに記録する')
  assert.equal(a.code, 0, JSON.stringify(a))
  const n = cli('next', '--state', state)
  assert.equal(n.code, 0, JSON.stringify(n))
  assert.equal(n.stop, 'complete', `回答した未展開の型は展開せずに記録して complete: ${JSON.stringify(n)}`)
  const after = ledger(state)
  assert.ok(after.groups.some((x) => x.id === 'G2-g1' && x.pattern === PATTERN2), '未展開の群を記録に残す')
  assert.ok(after.answers.some((x) => x.id === 'G2-g1'), '未展開の群への回答を記録に残す')
  assert.ok(!after.lenses.some((l) => l.id.startsWith('lat-G2-')), '回答の後も展開しない')
})

test('上限の周: --max-cycles 1 なら 1 周目の束ねで新しい型が残った時点で needs_input（未展開の群）にし、観点を作らない', async (t) => {
  const { state } = setup(t, ['--max-cycles', '1'])
  const { agentFn } = twoCycleAgent(state, extendsGroup)
  const { stop } = await drive(state, agentFn)
  assert.equal(stop.stop, 'needs_input', JSON.stringify(stop))
  assert.ok(stop.reasons.some((r) => /横展開/.test(r) && /収束しない/.test(r)), JSON.stringify(stop.reasons))
  assert.deepEqual(lateralIds(stop), ['G1-g1'])
  const L = ledger(state)
  assert.ok(!L.lenses.some((l) => l.id.startsWith('lat-')), JSON.stringify(L.lenses.map((l) => l.id)))
  assert.ok(!Object.keys(L.cells).some((id) => id.includes('|lat-')))
})

test('起動数の上限: max_agents_total に達したら、今のまま limit で止める（needs_input にしない）', async (t) => {
  const { state } = setup(t, ['--max-agents-total', '1'])
  const { agentFn } = twoCycleAgent(state, newTypeGroup)
  const { stop } = await drive(state, agentFn)
  assert.equal(stop.stop, 'limit', JSON.stringify(stop))
  assert.ok(stop.reasons.some((r) => /起動数/.test(r)), JSON.stringify(stop.reasons))
})

test('周の上限を下げた台帳: 3 周目の途中の台帳に config --max-cycles 2 を当てて next を流すと、上限を超えた周の横展開の観点と枡が gone になり、元の群が未展開の型として needs_input で返る', async (t) => {
  const { state } = setup(t, ['--max-cycles', '4'])
  const { agentFn } = twoCycleAgent(state, newTypeGroup)
  // 2 周目の束ねで lat-G2-g1（3 周目の観点）を作らせ、3 周目の review の呼び出しを出した所で止める。
  await driveUntil(state, agentFn, (L) => L.lenses.some((l) => l.id === 'lat-G2-g1'))
  const pre = ledger(state)
  assert.ok(pre.lenses.some((l) => l.id === 'lat-G2-g1'), `3 周目の観点ができる: ${JSON.stringify(pre.lenses.map((l) => l.id))}`)
  const mid = cli('next', '--state', state)
  assert.equal(mid.step, 'review', `3 周目の review を出す: ${JSON.stringify(mid)}`)
  assert.ok(liveCells(ledger(state), 'lat-G2-g1').length >= 1, '3 周目の枡ができる')

  assert.equal(cli('config', '--state', state, '--max-cycles', '2').code, 0)
  const n = cli('next', '--state', state)
  assert.equal(n.code, 0, JSON.stringify(n))
  assert.equal(n.stop, 'needs_input', JSON.stringify(n))
  assert.ok(n.reasons.some((r) => /横展開/.test(r) && /収束しない/.test(r)), JSON.stringify(n.reasons))
  assert.deepEqual(lateralIds(n), ['G2-g1'], `上限を超えた周の観点を作った元の群を返す: ${JSON.stringify(n.lateral_groups)}`)
  const L = ledger(state)
  assert.ok(!lensIds(L).includes('lat-G2-g1'), '上限を超えた周の横展開の観点は gone（台帳から外すか status: gone）')
  assert.deepEqual(liveCells(L, 'lat-G2-g1'), [], '上限を超えた周の横展開の枡は gone')
  assert.ok(Object.entries(L.cells).some(([id, c]) => id.includes('|lat-G2-g1|') && c.status === 'gone'), '枡は消さずに gone にする')
  assert.ok(lensIds(L).includes('lat-G1-g1') && liveCells(L, 'lat-G1-g1').length >= 1, '上限の内の周の横展開の観点と枡は残す')
})

// 今の形式の台帳の欄（この直しの前の init・ingest が書く欄）。直しの後も、これだけを持つ台帳を load が受け付ける。
const LEDGER_KEYS_NOW = ['agents', 'answered', 'answers', 'assets', 'attempts', 'call_seq', 'calls', 'cells', 'config', 'constraints', 'criteria', 'cycle', 'decisions', 'dropped_lenses', 'env_attempts', 'events', 'fail_streak', 'findings', 'goal', 'group_cycles', 'groups', 'hints_read', 'lens_reviewed', 'lenses', 'link', 'pending', 'phase', 'phase_records', 'phase_start', 'plan', 'plan_defects', 'plan_problems', 'plan_rounds', 'plan_seq', 'request', 'retro_cycles', 'rev', 'roles', 'saturation', 'seeds', 'stopped', 'targets', 'verified_units', 'version']
const GROUP_KEYS_NOW = ['id', 'cycle', 'root_cause', 'layer', 'keys', 'pattern', 'status', 'votes']

const LENS_KEYS_NOW = ['id', 'name', 'procedure', 'applies_to', 'origin', 'version', 'retro']
const pick = (o, keys) => Object.fromEntries(Object.entries(o).filter(([k]) => keys.includes(k)))

test('台帳の形式: 3 周目の途中の、今の形式の欄だけを持つ台帳（cb-goal3 と同じ形）を load は拒否せず、config --max-cycles 2 → next で未展開の群の needs_input になる', async (t) => {
  const { state } = setup(t, ['--max-cycles', '4'])
  const { agentFn } = twoCycleAgent(state, newTypeGroup)
  await driveUntil(state, agentFn, (L) => L.lenses.some((l) => l.id === 'lat-G2-g1'))
  assert.equal(cli('next', '--state', state).step, 'review', '3 周目の review を出す')
  const L = ledger(state)
  assert.ok(L.groups.length >= 2 && L.lenses.some((l) => l.id === 'lat-G2-g1'))
  // この直しで足してよい欄は群の extends だけ。台帳・群・観点の欄を今の形式に落とし、形式の印は今の値にする。
  const old = { ...pick(L, LEDGER_KEYS_NOW), version: 1 }
  old.groups = L.groups.map((g) => pick(g, GROUP_KEYS_NOW))
  old.lenses = L.lenses.map((l) => pick(l, LENS_KEYS_NOW))
  writeFileSync(path.join(state, 'ledger.json'), JSON.stringify(old))
  const s = cli('status', '--state', state)
  assert.equal(s.code, 0, JSON.stringify(s))
  assert.equal(cli('config', '--state', state, '--max-cycles', '2').code, 0)
  const n = cli('next', '--state', state)
  assert.equal(n.code, 0, JSON.stringify(n))
  assert.equal(n.stop, 'needs_input', JSON.stringify(n))
  assert.deepEqual(lateralIds(n), ['G2-g1'], JSON.stringify(n.lateral_groups))
})

// ---- P10: 既存の型に結ぶ群（extends）は反証しない ----

// 2 周目の横展開の観点が確かめる二つ目の節に、行を 5 つ置く（2 周目の束ねが 5 件以上の指摘を受け取れるようにする）。
const LINES2 = [1, 2, 3, 4, 5].map((n) => `二つ目の節の第${n}の主張を述べる本文の行である。`)
const DOC5 = `# 対象の文書

## 一つ目の節
${Q1}
二行目もこの節の主張を補う本文の行として置く。

## 二つ目の節
${LINES2.join('\n')}
`
const refuteLabels = (log, from = 0) => log.slice(from).map((e) => e.label).filter((l) => l.startsWith('refute-'))

// 1 周目は L1 が一つ目の節に 1 件、束ね役が新しい型 g1 を返す。2 周目は lat-G1-g1 が二つ目の節の 5 行に 1 件ずつ指摘し、束ね役は second(items, state) の群を返す。
// 2 周目の束ねの呼び出しの時点の log の長さを marks.second に残す（それより後の refute-* が 2 周目の反証役の起動）。
function fiveFindingAgent(state, second, log = []) {
  const marks = {}
  const agentFn = mockAgent({
    read: readWith((cell) => {
      if (cell.endsWith('一つ目の節/p1|L1|p1')) return [finding('根拠が無い主張', Q1)]
      if (cell.includes('|lat-G1-g1|')) return LINES2.map((q, i) => finding(`同じ型の根拠が無い主張その${i + 1}`, q))
      return undefined
    }),
    group: (prompt) => {
      const items = groupItems(prompt)
      if (items[0].lens === 'L1') return { groups: [{ id: 'g1', root_cause: ROOT1, layer: '実装', keys: items.map((x) => x.key), pattern: PATTERN1, applies_to: [assetEnding(state, '二つ目の節/p1')] }], unassigned: [] }
      marks.second = log.length
      return second(items, state)
    },
  }, log)
  return { agentFn, marks }
}
// 2 周目の指摘を、群の定義 defs（{ id, layer, extends?, pattern?, applies_to? }）の並びへ 1 件ずつ割り当てる（最後の群が残りを取る）。
const splitGroups = (items, defs, state) => ({
  groups: defs.map((d, i) => ({
    id: d.id,
    root_cause: `${ROOT2}（${d.id}）`,
    layer: d.layer,
    keys: items.filter((_, j) => (i === defs.length - 1 ? j >= i : j === i)).map((x) => x.key),
    pattern: d.pattern ?? '',
    applies_to: d.pattern ? [assetEnding(state, '一つ目の節/p1')] : [],
    ...(d.extends ? { extends: d.extends } : {}),
  })),
  unassigned: [],
})
const group2Done = (L) => L.groups.some((g) => g.cycle === 2)

test('P10-1: UPPER（方針・要求）は <checks> 区間が持ち、ledger-core は C から読む（自前の定義を持たない）', () => {
  assert.deepEqual([...C.UPPER], ['方針', '要求'])
  const src = readFileSync(WF, 'utf8')
  const block = src.slice(src.indexOf('// <checks>'), src.indexOf('// </checks>'))
  assert.match(block, /\bconst UPPER\b/, '<checks> 区間に UPPER を置く')
  const core = readFileSync(path.join(path.dirname(WF), 'ledger-core.mjs'), 'utf8')
  assert.doesNotMatch(core, /\b(const|let|var) UPPER\b/, 'ledger-core に UPPER の写しを持たない')
  assert.match(core, /C\.UPPER/, 'ledger-core は C から UPPER を読む')
})

test('P10-2: extends を持ち層が UPPER でない群は反証役に渡さない（反証役の起動 0）。judged にも載せない', async (t) => {
  const { state } = setup(t, [], DOC5)
  const log = []
  const { agentFn, marks } = fiveFindingAgent(state, (items) => extendsGroup(items), log)
  const { steps } = await drive(state, agentFn)
  assert.ok(marks.second, '2 周目の束ねまで進む')
  assert.equal(refuteLabels(log, marks.second).length, 0, `extends の群は反証しない: ${JSON.stringify(refuteLabels(log, marks.second))}`)
  const g2 = steps.filter((s) => s.step === 'group')[1]
  assert.ok(g2, '2 周目の束ねの結果がある')
  assert.ok(!g2.res.judged.some((j) => j.group.id === 'g1'), JSON.stringify(g2.res.judged.map((j) => j.group.id)))
  // 1 周目の新しい型の群は今のまま 2 体で反証する。
  assert.equal(refuteLabels(log, 0).length, 2)
})

test('P10-2: それ以外の群（上の層の extends・新しい型・型にならない群）は今のまま 2 体ずつで反証する', async (t) => {
  const { state } = setup(t, ['--max-cycles', '4'], DOC5)
  const log = []
  const defs = [
    { id: 'g1', layer: '実装', extends: 'lat-G1-g1' },
    { id: 'g2', layer: '方針', extends: 'lat-G1-g1' },
    { id: 'g3', layer: '要求', extends: 'lat-G1-g1' },
    { id: 'g4', layer: '実装', pattern: PATTERN2 },
    { id: 'g5', layer: '実装' },
  ]
  const { agentFn, marks } = fiveFindingAgent(state, (items, st) => splitGroups(items, defs, st), log)
  const { steps } = await driveUntil(state, agentFn, group2Done)
  assert.ok(marks.second, '2 周目の束ねまで進む')
  const labels = refuteLabels(log, marks.second).sort()
  assert.deepEqual(labels, ['refute-g2-a', 'refute-g2-b', 'refute-g3-a', 'refute-g3-b', 'refute-g4-a', 'refute-g4-b', 'refute-g5-a', 'refute-g5-b'], JSON.stringify(labels))
  const g2 = steps.filter((s) => s.step === 'group')[1]
  assert.deepEqual(g2.res.judged.map((j) => j.group.id).sort(), ['g2', 'g3', 'g4', 'g5'])
})

test('P10-3: 反証しなかった群の status は linked。観点も枡も作らず、status の groups に linked と extends が出る', async (t) => {
  const { state } = setup(t, [], DOC5)
  const { agentFn } = fiveFindingAgent(state, (items) => extendsGroup(items))
  const { stop } = await drive(state, agentFn)
  assert.equal(stop.stop, 'complete', JSON.stringify(stop))
  const L = ledger(state)
  const g = L.groups.find((x) => x.id === 'G2-g1')
  assert.ok(g, JSON.stringify(L.groups.map((x) => x.id)))
  assert.equal(g.status, 'linked')
  assert.equal(g.extends, 'lat-G1-g1')
  assert.deepEqual(g.votes, [], '反証していないので票は無い')
  assert.ok(!L.lenses.some((l) => l.id.startsWith('lat-G2-')), '観点を作らない')
  assert.ok(!Object.keys(L.cells).some((id) => id.includes('|lat-G2-')), '枡を作らない')
  const s = cli('status', '--state', state)
  const sg = s.groups.find((x) => x.id === 'G2-g1')
  assert.equal(sg.status, 'linked')
  assert.equal(sg.extends, 'lat-G1-g1')
  assert.equal(sg.lateral, false)
  // 1 周目の新しい型の群は、反証の結果の status（kept 等）のまま。
  assert.notEqual(s.groups.find((x) => x.id === 'G1-g1').status, 'linked')
})

test('P10-3: 反証した群（上の層の extends・新しい型・型にならない群）の status は反証の結果のまま（linked にしない）', async (t) => {
  const { state } = setup(t, ['--max-cycles', '4'], DOC5)
  const defs = [
    { id: 'g1', layer: '実装', extends: 'lat-G1-g1' },
    { id: 'g2', layer: '方針', extends: 'lat-G1-g1' },
    { id: 'g3', layer: '実装', pattern: PATTERN2 },
    { id: 'g4', layer: '実装' },
  ]
  const { agentFn } = fiveFindingAgent(state, (items, st) => splitGroups(items, defs, st))
  await driveUntil(state, agentFn, group2Done)
  const by = Object.fromEntries(ledger(state).groups.filter((g) => g.cycle === 2).map((g) => [g.id, g]))
  assert.equal(by['G2-g1'].status, 'linked')
  for (const id of ['G2-g2', 'G2-g3', 'G2-g4']) {
    assert.equal(by[id].status, 'kept', `${id}: ${JSON.stringify(by[id])}`)
    assert.equal(by[id].votes.length, 2, `${id}: 2 体の票を残す`)
  }
  assert.equal(by['G2-g2'].extends, 'lat-G1-g1', '上の層の extends の群も extends を残す')
})

test('P10-4: 上の層の extends の群は反証されなければ今のまま upper_groups で needs_input、反証されれば外れる。実装層の linked の群は止めない', async (t) => {
  const kept = setup(t, [], DOC5)
  const a = fiveFindingAgent(kept.state, (items) => extendsGroup(items, { layer: '方針' }))
  const r1 = await drive(kept.state, a.agentFn)
  assert.equal(r1.stop.stop, 'needs_input', JSON.stringify(r1.stop))
  assert.deepEqual(r1.stop.upper_groups, ['G2-g1'], JSON.stringify(r1.stop))

  const refuted = setup(t, [], DOC5)
  const over = mockAgent({
    read: readWith((cell) => {
      if (cell.endsWith('一つ目の節/p1|L1|p1')) return [finding('根拠が無い主張', Q1)]
      if (cell.includes('|lat-G1-g1|')) return LINES2.map((q, i) => finding(`同じ型の根拠が無い主張その${i + 1}`, q))
      return undefined
    }),
    group: (prompt) => {
      const items = groupItems(prompt)
      return items[0].lens === 'L1'
        ? { groups: [{ id: 'g1', root_cause: ROOT1, layer: '実装', keys: items.map((x) => x.key), pattern: PATTERN1, applies_to: [assetEnding(refuted.state, '二つ目の節/p1')] }], unassigned: [] }
        : extendsGroup(items, { layer: '方針' })
    },
    refute: (prompt, opts) => (opts.label.startsWith('refute-g1-') && ledger(refuted.state).cycle === 2 ? { group_id: 'g1', refuted: true, reason: '原因でなく症状の言い換え' } : undefined),
  })
  const r2 = await drive(refuted.state, over)
  assert.equal(r2.stop.stop, 'complete', `反証された上の層の群は止めない: ${JSON.stringify(r2.stop)}`)
  assert.equal(ledger(refuted.state).groups.find((g) => g.id === 'G2-g1').status, 'refuted')

  const impl = setup(t, [], DOC5)
  const c = fiveFindingAgent(impl.state, (items) => extendsGroup(items))
  const r3 = await drive(impl.state, c.agentFn)
  assert.equal(r3.stop.stop, 'complete', JSON.stringify(r3.stop))
  assert.deepEqual(r3.stop.upper_groups || [], [])
})
