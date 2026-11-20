// 束ねと横展開（設計「全体の段と確認」の意図の表の横展開、「完了と止める条件」の周の上限）。
// 束ね役 1 体が確定した指摘を根本原因で束ね、反証役 2 体ずつの票を CLI が台帳の上で集める。新しい型は横展開の型になり、
// 型の当たる単位ごとに横展開の意図（kind lateral）ができる。既存の型に結ぶ群（extends）は型を作らない。新しい型が 0 件なら周を足さず complete、
// 上限の周で新しい型が残れば needs_input（未展開の型の群）で止まる。役の偽物は blackboard-fixture の behave で、束ね・反証・横展開の読みをここで足す。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { C } from './ledger-core.mjs'
import { behave, claimedTasks, cli, drive, project, status } from './blackboard-fixture.mjs'

const QA = 'この文書は一つ目の主張を述べるが根拠を書いていない本文の行である。'
const QB = 'この文書は二つ目の主張を述べるが根拠を書いていない本文の行である。'
const FILES = { 'a.md': `# A\n\n## 主張\n${QA}\n`, 'b.md': `# B\n\n## 主張\n${QB}\n` }
const ROOT1 = '主張に根拠の文を添えない書き癖'
const PATTERN1 = '節ごとに主張の文を列挙し、それを支える根拠の文と一対一に照らす（横展開の型その一）'
const ROOT2 = '節の見出しと本文の主張がずれる別の書き癖'
const PATTERN2 = '節ごとに見出しの語を列挙し、本文の主張の語と照らす（横展開の型その二）'
const ledger = (state) => JSON.parse(readFileSync(path.join(state, 'ledger.json'), 'utf8'))
const steps = (calls) => calls.map((c) => c.next.step)

// 1 周目: a のファイルの段の指摘を確定し、束ね役が second の 1 周目の群（既定は新しい型 g1。b に当たる）を返す。
// 2 周目: 横展開の意図が b を型で問い直して指摘を足し、確定した指摘を束ね役が second(items, inputs) の群で束ねる。
function agent({ second = () => null, first = null, refute = null, layer = '実装' } = {}) {
  const seen = { group: [], refute: [] }
  const act = behave({
    facts: (p) => (path.basename(p) === 'a.md' ? { findings: [{ claim: '根拠が無い主張', quote: QA, layer }] } : {}),
    group: (task, ctx) => {
      const q = ctx.query(task).inputs
      seen.group.push({ task, q })
      const keys = q.items.map((x) => x.key)
      if (!q.lateral.length) return first ? first(q) : { groups: [{ id: 'g1', root_cause: ROOT1, layer, keys, pattern: PATTERN1, applies_to: [q.index.find((r) => r.id.endsWith('b.md')).id] }], unassigned: [] }
      return second(q)
    },
    refute: (task, ctx) => {
      const q = ctx.query(task).inputs
      seen.refute.push({ task, q })
      return refute ? refute(task, q) : { group_id: task.group, refuted: false, reason: '記録の事実と合う' }
    },
    lateral: (task) => ({ verdict: 'found', quote: QB, findings: [{ claim: '同じ型の根拠が無い主張', locations: [{ unit: task.unit.id, quote: QB }], obligation: 'G1', confidence: 'high', severity: 'MEDIUM', layer }] }),
  })
  return { act, seen }
}
const extendsGroup = (q, extra = {}) => ({ groups: [{ id: 'g1', root_cause: ROOT1, layer: '実装', keys: q.items.map((x) => x.key), pattern: '', applies_to: [], extends: q.lateral[0].id, ...extra }], unassigned: [] })
const newTypeGroup = (q) => ({ groups: [{ id: 'g1', root_cause: ROOT2, layer: '実装', keys: q.items.map((x) => x.key), pattern: PATTERN2, applies_to: [q.index.find((r) => r.id.endsWith('a.md')).id] }], unassigned: [] })
const setup = (t, maxCycles = null) => {
  const p = project(t, FILES)
  if (maxCycles) assert.equal(cli('config', '--state', p.state, '--max-cycles', String(maxCycles)).code, 0)
  return p
}

test('max_cycles の既定: --max-cycles を渡さない init の台帳は max_cycles 2', (t) => {
  assert.equal(ledger(setup(t).state).config.max_cycles, 2)
})

test('横展開の意図: 1 周目の新しい型は横展開の型になり、型の当たる単位ごとに lateral の意図ができる。横展開の読みが足した指摘は指摘の判定を通って確定し（origin: lateral）、2 周目の束ねに渡る', async (t) => {
  const { state, paths } = setup(t, 4)
  const { act, seen } = agent({ second: (q) => extendsGroup(q) })
  const { stop, calls } = await drive(state, act)
  assert.equal(stop.stop, 'complete', JSON.stringify(stop))
  const L = ledger(state)
  assert.deepEqual(L.lateral_types.map((x) => [x.id, x.applies_to]), [['lat-G1-g1', [paths['b.md']]]])
  const lat = claimedTasks(calls).filter((x) => x.kind === 'lateral')
  assert.deepEqual(lat.map((x) => [x.unit.path, x.type.id, x.type.pattern]), [[paths['b.md'], 'lat-G1-g1', PATTERN1]], '型の当たる単位を型で問い直す')
  assert.match(lat[0].intent.id, /^lateral:[0-9a-f]+$/)
  const s = status(state)
  assert.ok(s.findings.confirmed.some((f) => f.origin === 'lateral' && f.claim === '同じ型の根拠が無い主張'), JSON.stringify(s.findings.confirmed))
  assert.ok(s.intents.some((i) => i.kind === 'finding' && i.state === 'closed' && s.facts.find((f) => f.id === i.basis[0]).origin === 'lateral'), '横展開の読みの指摘も指摘の判定にかける')
  // 2 周目の束ね役は、既にある横展開の型の id・型・根本原因を query で受け取り、args にはその文を載せない。
  const q2 = seen.group[1].q
  assert.deepEqual(q2.lateral, [{ id: 'lat-G1-g1', pattern: PATTERN1, root_cause: ROOT1 }])
  for (const c of calls) for (const x of [PATTERN1, ROOT1]) assert.ok(!JSON.stringify(c.args).includes(x), 'args に型の文を載せない')
})

test('extends: 既存の横展開の型に結ぶ群からは新しい型を作らず、群に extends と指摘を記録し、新しい型が 0 件なので次の周に進まずに complete', async (t) => {
  const { state } = setup(t, 4)
  const { act } = agent({ second: (q) => extendsGroup(q) })
  const { stop } = await drive(state, act)
  assert.equal(stop.stop, 'complete', JSON.stringify(stop))
  const L = ledger(state)
  assert.deepEqual(L.lateral_types.map((x) => x.id), ['lat-G1-g1'], 'extends の群から型を作らない')
  const g = L.groups.find((x) => x.cycle === 2)
  assert.equal(g.extends, 'lat-G1-g1')
  assert.equal(g.status, 'linked', '既存の型に結ぶだけの群は反証にかけない')
  const latFinding = status(state).findings.confirmed.find((f) => f.origin === 'lateral')
  assert.ok(latFinding && g.keys.includes(latFinding.id), '指摘をその群に結ぶ')
  assert.equal(L.cycle, 2, '新しい型が 0 件の周は次の周に進まない')
})

test('extends: pattern と applies_to を併せて返しても、extends のある群からは新しい型も横展開の意図も作らない', async (t) => {
  const { state, paths } = setup(t, 4)
  const { act } = agent({ second: (q) => extendsGroup(q, { pattern: PATTERN2, applies_to: [paths['a.md']] }) })
  const { stop, calls } = await drive(state, act)
  assert.equal(stop.stop, 'complete', JSON.stringify(stop))
  assert.deepEqual(ledger(state).lateral_types.map((x) => x.id), ['lat-G1-g1'])
  assert.equal(claimedTasks(calls).filter((x) => x.kind === 'lateral').length, 1)
})

test('extends の照合: 実在しない型の id や、横展開でない観点の id を指す群は受け付けず（rejected_grouping）、試行の上限でその周の束ねを開示して閉じ、止めずに complete', async (t) => {
  for (const bad of ['lat-G9-zz', 'L1']) {
    const { state } = setup(t, 4)
    const { act } = agent({ second: (q) => extendsGroup(q, { extends: bad }) })
    const { stop } = await drive(state, act)
    assert.equal(stop.stop, 'complete', `${bad}: ${JSON.stringify(stop)}`)
    const L = ledger(state)
    const rej = L.events.filter((e) => e.cycle === 2 && e.kind === 'rejected_grouping')
    assert.ok(rej.length >= 1 && rej.some((e) => e.text.includes(bad)), `${bad}: 拒否の理由に id を挙げる: ${JSON.stringify(rej)}`)
    assert.ok(L.events.some((e) => e.kind === 'group_undecided'), `${bad}: 束ねを判定できなかったことを出来事に残す`)
    assert.ok(!L.groups.some((g) => g.cycle === 2), `${bad}: 受け付けない束ねの群を台帳に残さない`)
    assert.deepEqual(L.lateral_types.map((x) => x.id), ['lat-G1-g1'])
  }
})

test('新しい型が 0 件: 1 周目の束ねが型の無い群だけなら、横展開の意図を足さず、--max-cycles 1 でも limit でなく complete', async (t) => {
  const { state } = setup(t, 1)
  const { act } = agent({ first: (q) => ({ groups: [{ id: 'g1', root_cause: ROOT1, layer: '実装', keys: q.items.map((x) => x.key), pattern: '', applies_to: [] }], unassigned: [] }) })
  const { stop, calls } = await drive(state, act)
  assert.ok(steps(calls).includes('group'), '束ねまで進む')
  assert.equal(stop.stop, 'complete', JSON.stringify(stop))
  assert.deepEqual(ledger(state).lateral_types, [])
  assert.ok(!claimedTasks(calls).some((x) => x.kind === 'lateral'))
  assert.equal(ledger(state).cycle, 1, '新しい型が 0 件の周は次の周に進まない')
})

test('上限の周: 既定の 2 周目の束ねで新しい型が残れば、型を作らず needs_input で「横展開が収束しない」と未展開の群（lateral_groups）を返し、その群への answer の後は展開せずに記録して complete', async (t) => {
  const { state } = setup(t)
  const { act } = agent({ second: newTypeGroup })
  const { stop } = await drive(state, act)
  assert.equal(stop.stop, 'needs_input', JSON.stringify(stop))
  assert.ok(stop.reasons.some((r) => /横展開/.test(r) && /収束しない/.test(r)), JSON.stringify(stop.reasons))
  assert.deepEqual(stop.lateral_groups, ['G2-g1'])
  assert.ok(!(stop.upper_groups || []).includes('G2-g1'), '層が実装の群は上の層の群にしない')
  const L = ledger(state)
  assert.ok(!L.lateral_types.some((x) => x.id === 'lat-G2-g1'), '上限の周の新しい型から型を作らない')
  assert.ok(L.groups.some((g) => g.id === 'G2-g1' && g.pattern === PATTERN2), '未展開の型の群を台帳に残す')
  assert.equal(cli('answer', '--state', state, '--id', 'G2-g1', '--text', '展開せずに記録する').code, 0)
  const n = cli('next', '--state', state)
  assert.equal(n.stop, 'complete', `回答した未展開の型は展開せずに記録して complete: ${JSON.stringify(n)}`)
  assert.ok(!ledger(state).lateral_types.some((x) => x.id === 'lat-G2-g1'), '回答の後も展開しない')
})

test('上限の周: --max-cycles 1 なら 1 周目の束ねで新しい型が残った時点で needs_input（未展開の群）にし、型を作らない', async (t) => {
  const { state } = setup(t, 1)
  const { act } = agent()
  const { stop } = await drive(state, act)
  assert.equal(stop.stop, 'needs_input', JSON.stringify(stop))
  assert.deepEqual(stop.lateral_groups, ['G1-g1'])
  assert.deepEqual(ledger(state).lateral_types, [])
})

test('周の上限を下げた台帳: 3 周目の途中の台帳に config --max-cycles 2 を当てて next を流すと、上限を超えた周の横展開の型と意図が外れ、元の群が未展開の型として needs_input で返る', async (t) => {
  const { state } = setup(t, 3)
  const { act } = agent({ second: (q) => (q.lateral.length === 1 ? newTypeGroup(q) : extendsGroup(q)) })
  // 3 周目の横展開の意図ができるまで回す。
  let calls = []
  for (let i = 0; i < 30 && ledger(state).cycle < 3; i++) calls = calls.concat((await drive(state, act, { maxSteps: 1 })).calls)
  const pre = ledger(state)
  assert.equal(pre.cycle, 3)
  assert.deepEqual(pre.lateral_types.map((x) => x.id), ['lat-G1-g1', 'lat-G2-g1'])
  assert.ok(status(state).intents.some((i) => i.kind === 'lateral' && i.state === 'open'), '3 周目の横展開の意図が開いている')
  assert.equal(cli('config', '--state', state, '--max-cycles', '2').code, 0)
  const n = cli('next', '--state', state)
  assert.equal(n.stop, 'needs_input', JSON.stringify(n))
  assert.ok(n.reasons.some((r) => /横展開/.test(r) && /収束しない/.test(r)), JSON.stringify(n.reasons))
  assert.deepEqual(n.lateral_groups, ['G2-g1'], '上限を超えた周の型を作った元の群を返す')
  const L = ledger(state)
  assert.deepEqual(L.lateral_types.map((x) => x.id), ['lat-G1-g1'], '上限の内の周の型は残す')
  assert.equal(L.cycle, 2)
  assert.ok(!status(state).intents.some((i) => i.kind === 'lateral' && i.state === 'open'), '外した型の意図は残らない')
  assert.ok(calls.length > 0)
})

test('起動数の上限: max_agents_total に達したら、今のまま limit で止める（needs_input にしない）', async (t) => {
  const { state } = setup(t)
  assert.equal(cli('config', '--state', state, '--max-agents-total', '3').code, 0)
  const { act } = agent()
  const { stop } = await drive(state, act)
  assert.equal(stop.stop, 'limit', JSON.stringify(stop))
  assert.ok(stop.reasons.some((r) => /起動数/.test(r)), JSON.stringify(stop.reasons))
})

// ---------------- 反証（P10）: 群ごとに反証役 2 体の票を CLI が集める ----------------

test('P10-1: UPPER（方針・要求）は <checks> 区間が持ち、ledger-core は C から読む（自前の定義を持たない）', () => {
  assert.deepEqual([...C.UPPER], ['方針', '要求'])
  const src = readFileSync(new URL('./coverage-audit.js', import.meta.url), 'utf8')
  const block = src.slice(src.indexOf('// <checks>'), src.indexOf('// </checks>'))
  assert.match(block, /\bconst UPPER\b/, '<checks> 区間に UPPER を置く')
  const core = readFileSync(new URL('./ledger-core.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(core, /\b(const|let|var) UPPER\b/, 'ledger-core に UPPER の写しを持たない')
})

test('P10-2: 新しい型の群は反証役 2 体（refuter_a・refuter_b）の呼び出しにかけ、既存の型に結ぶだけの群（層が UPPER でない extends）は反証にかけない', async (t) => {
  const { state } = setup(t, 4)
  const { act, seen } = agent({ second: (q) => extendsGroup(q) })
  const { calls } = await drive(state, act)
  const refuteCalls = calls.filter((c) => c.next.step === 'refute')
  assert.equal(refuteCalls.length, 1, '1 周目の新しい型の群だけを反証にかける')
  assert.deepEqual(refuteCalls[0].args.workers.map((w) => w.role).sort(), ['refuter_a', 'refuter_b'])
  assert.ok(seen.refute.every((x) => x.q.group.id === 'g1' && x.q.items.length === 1), '反証役は群とその key の指摘だけを引く')
  const L = ledger(state)
  assert.equal(L.groups.find((g) => g.id === 'G1-g1').status, 'kept', '2 票とも反証しなければ kept')
  assert.equal(L.groups.find((g) => g.id === 'G2-g1').status, 'linked')
})

test('P10-3: 反証の票の集約は CLI が行う。2 票とも反証すれば refuted で型を作らず、1 票なら split、票が足りなければ unverified', async (t) => {
  for (const [votes, status_, typed] of [[[true, true], 'refuted', false], [[true, false], 'split', true], [[true, null], 'unverified', true]]) {
    const { state } = setup(t, 4)
    const { act } = agent({ second: (q) => extendsGroup(q), refute: (task) => { const v = votes[task.id.endsWith(':a') ? 0 : 1]; return v === null ? null : { group_id: task.group, refuted: v, reason: v ? '症状の言い換え' : '記録の事実と合う' } } })
    await drive(state, act)
    const L = ledger(state)
    const g = L.groups.find((x) => x.id === 'G1-g1')
    assert.equal(g.status, status_, JSON.stringify(g))
    assert.equal(L.lateral_types.some((x) => x.id === 'lat-G1-g1'), typed, `${status_}: 型を作るか`)
  }
})

test('P10-4: 上の層の群は、反証されなければ upper_groups で needs_input、2 票とも反証されれば外れて complete', async (t) => {
  for (const [refuted, stopKind] of [[false, 'needs_input'], [true, 'complete']]) {
    const { state } = setup(t, 4)
    const first = (q) => ({ groups: [{ id: 'g1', root_cause: ROOT1, layer: '方針', keys: q.items.map((x) => x.key), pattern: '', applies_to: [] }], unassigned: [] })
    const { act } = agent({ first, refute: (task) => ({ group_id: task.group, refuted, reason: refuted ? '症状の言い換え' : '記録の事実と合う' }) })
    const { stop } = await drive(state, act)
    assert.equal(stop.stop, stopKind, JSON.stringify(stop))
    if (!refuted) assert.deepEqual(stop.upper_groups, ['G1-g1'])
  }
})
