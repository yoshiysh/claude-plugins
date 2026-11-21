// coverage-build の import-audit が、本物の coverage-audit の CLI と Workflow source（役は偽物）が出す status をそのまま取り込めることを確かめる。
// 2 つのスキルのファイルを読むので、配布物に入らないリポジトリ直下の tests/ に置く。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { cli as auditCli, driveScript as auditDrive, scriptAgent } from '../.agents/skills/coverage-audit/scripts/blackboard-fixture.mjs'
import { planAct } from '../.agents/skills/coverage-audit/scripts/plan-roles.mjs'
import { cli, drive, mockAgent, setup } from '../.agents/skills/coverage-build/scripts/test-harness.mjs'

// coverage-audit の束ねの意図（確認役が取る）の偽物: 確定した指摘の事実（basis）の全件を 1 つの群に入れる。
const GROUPING = {
  group: (task, ctx) => { const q = ctx.query(task); return { groups: [{ id: 'g1', root_cause: '根の原因', layer: '詳細設計', keys: q.basis.map((f) => f.id) }], unassigned: [] } },
}

test('設計レビュー: coverage-audit の status を取り込み、指摘を単位と層へ結ぶ', async (t) => {
  const { state } = setup(t)
  const log = []
  const runAudit = async (phase, out) => {
    const a = out.audit
    assert.ok(Array.isArray(a.init_argv) && a.reframe_argv === undefined, '置き場に台帳が無いので init_argv')
    assert.equal(a.state, path.join(state, 'audit', 'state'))
    // coverage-build が書いた init の引数をそのまま渡す（照合済みの印を含む）。
    const init = auditCli(...a.init_argv)
    assert.equal(init.code, 0, JSON.stringify(init))
    // ファイルの段は 1 ファイル 1 単位。引用の文を本文に含む U1.md の単位にだけ、coverage-build が渡した設計の段の観点の指摘を 1 件書く。
    const quote = '入力を受け取り、決まった値を返す。'
    const once = { done: false }
    const facts = (p, lines) => {
      if (path.basename(p) !== 'U1.md' || !lines.some((l) => l.includes(quote))) return {}
      once.done = true
      return { findings: [{ claim: '値の決め方が基準に照らせない', quote, severity: 'HIGH', layer: '詳細設計' }] }
    }
    const r = await auditDrive(a.state, scriptAgent(planAct({ facts, ...GROUPING }), log), { maxSteps: 60 })
    assert.ok(once.done, '引用の文を本文に含む U1.md の単位に指摘を書いた')
    assert.ok(['complete', 'needs_input'].includes(r.stop.stop), JSON.stringify(r.stop))
    return auditCli('status', '--state', a.state)
  }
  const { steps } = await drive(state, mockAgent(), { audit: runAudit, maxSteps: 4 })
  assert.deepEqual(steps.map((s) => s.step), ['design', 'design', 'design', 'audit'])
  assert.equal(steps[3].ingest.code, 0, JSON.stringify(steps[3].ingest))
  const L = JSON.parse(readFileSync(path.join(state, 'build.json'), 'utf8'))
  const f = L.events.filter((e) => e.kind === 'finding')
  assert.equal(f.length, 1)
  assert.deepEqual([f[0].unit, f[0].layer, f[0].stage], ['U1', '設計', 'design_review'])
  assert.ok(!L.events.some((e) => e.kind === 'import_mismatch'), JSON.stringify(L.events))
  assert.equal(L.retro.due, true)
  assert.ok(log.length && !log.some((x) => x.label.startsWith('goal_checker-')), 'coverage-build が照合した目標を coverage-audit は照合し直さない')
  const AL = JSON.parse(readFileSync(path.join(steps[3].out.audit.state, 'ledger.json'), 'utf8'))
  assert.deepEqual(AL.criteria.map((c) => c.id), ['AC1'], '受け入れ基準は coverage-audit の基準の欄に入る')
  assert.deepEqual(AL.constraints.map((c) => c.id), ['D1'])
})

test('受け入れ基準・制約が無い update: coverage-audit に基準・制約の欄を渡さず、「AC1: なし」のような項目を作らない', async (t) => {
  const { d, repo } = setup(t, { mode: 'update' })
  const state = path.join(d, 'no-criteria')
  const init = cli('init', '--state', state, '--mode', 'update', '--repo', repo, '--goal', path.join(d, 'goal.md'), '--request', path.join(d, 'request.md'), '--target', path.join(repo, 'src', 'old.mjs'))
  assert.equal(init.code, 0, JSON.stringify(init))
  let audit = null
  const runAudit = async (phase, out) => {
    audit = out.audit
    return { stop: 'complete' }
  }
  await drive(state, mockAgent(), { audit: runAudit, maxSteps: 2 })
  assert.ok(audit, '現状の検査に進む')
  assert.equal(audit.criteria, undefined)
  assert.equal(audit.constraints, undefined)
  assert.ok(!audit.init_argv.includes('--criteria') && !audit.init_argv.includes('--constraints'), JSON.stringify(audit.init_argv))
  assert.equal(auditCli(...audit.init_argv).code, 0)
  const AL = JSON.parse(readFileSync(path.join(audit.state, 'ledger.json'), 'utf8'))
  assert.deepEqual([AL.criteria, AL.constraints], [[], []])
})

test('段をまたいで 1 つの台帳: 設計レビューは init、実装レビューは同じ置き場の台帳を reframe し、その段の status だけを取り込む', async (t) => {
  const { state } = setup(t)
  const calls = []
  const runAudit = async (phase, out) => {
    const a = out.audit
    const argv = a.init_argv || a.reframe_argv
    assert.ok(argv && !(a.init_argv && a.reframe_argv), `init_argv か reframe_argv のどちらか一方: ${JSON.stringify(a)}`)
    const r = auditCli(...argv)
    assert.equal(r.code, 0, JSON.stringify(r))
    calls.push({ phase, kind: argv[0], state: a.state, targets: a.targets })
    const d = await auditDrive(a.state, scriptAgent(planAct(GROUPING)), { maxSteps: 60 })
    assert.ok(['complete', 'needs_input'].includes(d.stop.stop), JSON.stringify(d.stop))
    return auditCli('status', '--state', a.state)
  }
  const { stop, steps } = await drive(state, mockAgent(), { audit: runAudit })
  assert.equal(stop.stop, 'complete', JSON.stringify(stop))
  assert.deepEqual(calls.map((c) => [c.phase, c.kind]), [['design', 'init'], ['impl', 'reframe']])
  assert.deepEqual([...new Set(calls.map((c) => c.state))], [path.join(state, 'audit', 'state')])
  const ledgers = readdirSync(state, { recursive: true }).map(String).filter((f) => path.basename(f) === 'ledger.json')
  assert.deepEqual(ledgers, [path.join('audit', 'state', 'ledger.json')], 'coverage-audit の台帳は 1 つ')
  const AL = JSON.parse(readFileSync(path.join(state, 'audit', 'state', 'ledger.json'), 'utf8'))
  assert.equal(AL.phase, 'impl')
  assert.ok(AL.phase_records && AL.phase_records.design, '設計レビューの節を同じ台帳に残す')
  assert.equal(AL.goal.checked_by, 'coverage-build')
  assert.deepEqual([...AL.targets].sort(), [...calls[1].targets].sort(), '対象を実装の段のものに差し替える')
  const imp = steps.filter((s) => s.step === 'audit').map((s) => s.ingest)
  assert.ok(imp.every((g) => g.code === 0), JSON.stringify(imp))
  assert.deepEqual(imp.map((g) => g.phase), ['design', 'impl'])
})

// ---- P14: 設計レビューの指摘を、束ねの群ごとに振り返る ----
import { importAudit } from '../.agents/skills/coverage-build/scripts/build-core.mjs'
import { MAX_ATTEMPTS } from '../.agents/skills/coverage-build/scripts/build-core.mjs'
import { auditStatus } from '../.agents/skills/coverage-build/scripts/test-harness.mjs'

const DQUOTE = '入力を受け取り、決まった値を返す。'
const GS = 'c1:design:G1-GS'
const GX = 'c1:design:G2-XX'
const RC_GS = '値の決め方を設計が書いていない'
const RC_XX = '境界の約束の行が詳細設計に写されていない'
const ledgerOf = (state) => JSON.parse(readFileSync(path.join(state, 'build.json'), 'utf8'))
// coverage-audit の status の群。status の groups の形（id・layer・root_cause・keys。束ねに反証と横展開は無い）のまま。
const auditGroup = (id, root_cause, layer = '詳細設計') => ({ id, layer, root_cause, keys: [] })
const G1 = auditGroup('G1-GS', RC_GS)
const G2 = auditGroup('G2-XX', RC_XX)
// fs: [{ claim, groups? }]。groups は status の確定指摘の `groups`（群の id の配列）。groups の無い件は欄ごと持たない。
function groupedStatus(state, phase, fs, groups) {
  const st = auditStatus({ phase, confirmed: fs.map((f) => ({ path: path.join(state, 'design', 'U1.md'), quote: DQUOTE, layer: '詳細設計', claim: f.claim })) })
  fs.forEach((f, i) => { if (f.groups) st.findings.confirmed[i].groups = f.groups })
  st.groups = groups
  st.phases[phase].groups = groups
  return st
}
const THREE = [{ claim: '指摘A: 値の決め方が書かれていない', groups: ['G1-GS'] }, { claim: '指摘B: 約束の行が写されていない', groups: ['G1-GS', 'G2-XX'] }, { claim: '指摘C: 群に入らない欠陥' }]
// 設計の段を回して、設計レビューの status を取り込んだ状態（次は retro）にする。
async function afterDesignReview(t, fs = THREE, groups = [G1, G2], { agent = mockAgent(), maxSteps = 4 } = {}) {
  const s = setup(t)
  const audit = async (phase) => groupedStatus(s.state, phase, fs, groups)
  const r = await drive(s.state, agent, { audit, maxSteps })
  for (const st of r.steps) assert.equal(st.ingest.code, 0, JSON.stringify(st.ingest))
  return { ...s, ...r }
}
const evOf = (L, claim) => L.events.find((e) => e.kind === 'finding' && e.text.startsWith(claim))

test('P14-1: importAudit は確定指摘の groups を `c<周>:<段>:<群の id>` にして出来事の groups に入れる（groups の無い件は空の配列）', async (t) => {
  const { state } = await afterDesignReview(t)
  const L = ledgerOf(state)
  const f = L.events.filter((e) => e.kind === 'finding')
  assert.equal(f.length, 3)
  assert.deepEqual(evOf(L, THREE[0].claim).groups, [GS])
  assert.deepEqual(evOf(L, THREE[1].claim).groups, [GS, GX])
  assert.deepEqual(evOf(L, THREE[2].claim).groups, [], 'groups の無い件は空の配列（欄は持つ）')
})

test('P14-1: 群の根本原因・層は台帳の新しい欄 audit_groups（id → { root_cause, layer }）に 1 回だけ置く。init の台帳は空で持つ', async (t) => {
  const s = setup(t)
  assert.deepEqual(ledgerOf(s.state).audit_groups, {}, 'init した台帳は audit_groups を空で持つ')
  const { state } = await afterDesignReview(t)
  const L = ledgerOf(state)
  assert.deepEqual(Object.keys(L.audit_groups).sort(), [GS, GX].sort(), '2 件が同じ群に入っても 1 つ。キーは出来事の groups と同じ id')
  assert.equal(L.audit_groups[GS].root_cause, RC_GS)
  assert.equal(L.audit_groups[GX].root_cause, RC_XX)
  // 層の値は coverage-audit の層（詳細設計）か、それを coverage-build の層に直した値（設計）のどちらか。
  for (const id of [GS, GX]) assert.ok(['詳細設計', '設計'].includes(L.audit_groups[id].layer), L.audit_groups[id].layer)
  assert.ok(!JSON.stringify(L.events).includes(RC_GS), '根本原因を出来事ごとに写さない（audit_groups に 1 回だけ）')
})

test('P14-1: 群の id に周と段の名前を付ける（audit の群の id は段の始まりごとに数え直されるので、周・段をまたいで別の群として残る）', (t) => {
  const { state } = setup(t)
  const L = ledgerOf(state)
  const text = `# U1\n\n${DQUOTE}\n`
  const io = { readText: () => text, unitOfPath: () => ({ unit: 'U1', test: false }) }
  const fs = [{ claim: '同じ id の群に入る指摘', groups: ['G1-GS'] }]
  importAudit(L, groupedStatus(state, 'design', fs, [auditGroup('G1-GS', '1 周目の根本原因')]), 'design', io)
  importAudit(L, groupedStatus(state, 'impl', fs, [auditGroup('G1-GS', '1 周目の実装の根本原因', '実装')]), 'impl', io)
  L.cycle = 2
  importAudit(L, groupedStatus(state, 'design', fs, [auditGroup('G1-GS', '2 周目の根本原因')]), 'design', io)
  const groupsOfEvents = L.events.filter((e) => e.kind === 'finding').map((e) => e.groups)
  assert.deepEqual(groupsOfEvents, [['c1:design:G1-GS'], ['c1:impl:G1-GS'], ['c2:design:G1-GS']])
  assert.deepEqual(Object.keys(L.audit_groups).sort(), ['c1:design:G1-GS', 'c1:impl:G1-GS', 'c2:design:G1-GS'])
  assert.equal(L.audit_groups['c1:design:G1-GS'].root_cause, '1 周目の根本原因')
  assert.equal(L.audit_groups['c2:design:G1-GS'].root_cause, '2 周目の根本原因', '周が違えば同じ id でも別の群')
  assert.equal(L.audit_groups['c1:impl:G1-GS'].root_cause, '1 周目の実装の根本原因', '段が違えば同じ id でも別の群')
})

// 次に返す retro の args と、計画役の担当の query の inputs（呼び出しは進めない。担当は claim で取るだけで提出しない）。
function planQuery(state) {
  const n = cli('next', '--state', state)
  assert.equal(n.step, 'retro', JSON.stringify(n))
  const args = JSON.parse(readFileSync(n.args_path, 'utf8'))
  const w = args.workers[0]
  assert.equal(w.role, 'retro_planner')
  const c = cli('claim', '--state', state, '--call', args.callId, '--worker', w.id)
  const q = cli('query', '--state', state, '--call', args.callId, '--worker', w.id, '--task', c.tasks[0].id)
  assert.equal(q.code, 0, JSON.stringify(q))
  return { args, inputs: q.inputs }
}

test('P14-2: 計画役の query は、出来事ごとに群の id（groups）を持ち、群の一覧（groups）に id・層・根本原因を 1 回ずつ持つ。2 つの群に入る出来事は両方の id を持ち、群の無い出来事は空', async (t) => {
  const { state } = await afterDesignReview(t)
  const L = ledgerOf(state)
  const { inputs } = planQuery(state)
  const evGroups = (claim) => inputs.events.find((e) => e.id === evOf(L, claim).id).groups
  assert.deepEqual(evGroups(THREE[0].claim), [GS])
  assert.deepEqual(evGroups(THREE[1].claim), [GS, GX], '2 つ以上の群に入る出来事は、その全ての群の id を持つ')
  assert.deepEqual(evGroups(THREE[2].claim), [], '群の無い出来事')
  assert.deepEqual(inputs.groups.map((g) => g.id).sort(), [GS, GX].sort(), '群の一覧は出来事が持つ群の id（1 回ずつ）')
  assert.equal(inputs.groups.find((g) => g.id === GS).root_cause, RC_GS)
  assert.equal(inputs.groups.find((g) => g.id === GX).root_cause, RC_XX)
  for (const g of inputs.groups) assert.ok(['詳細設計', '設計'].includes(g.layer), g.layer)
})

test('P14-2: 群を持つ出来事が無いとき、群の一覧は空で、出来事は全て groups が空', async (t) => {
  const { state } = await afterDesignReview(t, [{ claim: '指摘D: 群に入らない欠陥' }], [])
  const { inputs } = planQuery(state)
  assert.deepEqual(inputs.groups, [])
  assert.ok(inputs.events.every((e) => e.groups.length === 0))
  assert.ok(inputs.events.some((e) => e.text.includes('指摘D: 群に入らない欠陥')))
})

test('P14-2: retro の args に群の id も根本原因の文も載せない（計画役は query で引く）', async (t) => {
  const { state } = await afterDesignReview(t)
  const { args } = planQuery(state)
  const text = JSON.stringify(args)
  assert.deepEqual(Object.keys(args).sort(), ['callId', 'stage', 'state', 'workers'])
  for (const w of [RC_GS, GS, GX]) assert.ok(!text.includes(w), `args に載せない: ${w}`)
})

// retro の偽の役: 計画役は basis を 1 つだけ持つ意図を 1 件返し、実行役は layer の原因を返す（setup の stateDir は repo と同じ親の state）。
function groupRetroAgent(basis, layer = '設計') {
  return mockAgent({
    'retro-plan': () => ({ intents: [{ basis: [basis], hypothesis: '群の根本原因が設計に残っている', layer, look_at: ['U1.md'] }] }),
    'retro-exam': (prompt, o) => ({ verdict: 'supported', cause: '設計が値の決め方を書いていない', layer, evidence: [{ path: path.join(path.dirname(o.inputs.repo), 'state', 'design', 'U1.md'), quote: DQUOTE }] }),
  })
}
const TWO_IN_G1 = [{ claim: '指摘A: 値の決め方が書かれていない', groups: ['G1-GS'] }, { claim: '指摘B: 約束の行が写されていない', groups: ['G1-GS'] }]

test('P14-3: basis に群の id を書いた事実は、その群の全ての出来事を覆う。1 件ずつ挙げなくても振り返りを終えて route へ進み、全ての出来事が事実の層で戻る', async (t) => {
  const { state } = await afterDesignReview(t, TWO_IN_G1, [G1], { agent: groupRetroAgent(GS), maxSteps: 7 })
  const L = ledgerOf(state)
  assert.equal(L.intents.length, 1, '群の id を根拠にした意図を台帳に受ける')
  assert.equal(L.intents[0].status, 'accepted')
  assert.deepEqual(L.facts.map((f) => f.basis), [[GS]])
  assert.equal(L.retro.rounds, 1)
  const n = cli('next', '--state', state)
  assert.notEqual(n.step, 'retro', `E1・E2 は群 ${GS} を辿る事実で覆われているので 1 巡で終える: ${JSON.stringify(n)}`)
  const R = ledgerOf(state)
  assert.deepEqual(R.routes.map((r) => r.event).sort(), ['E1', 'E2'])
  for (const r of R.routes) assert.deepEqual([r.layer, r.by], ['設計', ['F1']], `${r.event} は事実 F1 で覆われ、その層（設計）へ戻る`)
})

test('P14-3: 群の id を basis に持つ事実の層で、その群の全ての出来事の戻す層が決まる（目標の層なら全て人間へ返す）', async (t) => {
  const { state } = await afterDesignReview(t, TWO_IN_G1, [G1], { agent: groupRetroAgent(GS, '目標'), maxSteps: 7 })
  cli('next', '--state', state)
  const R = ledgerOf(state)
  assert.deepEqual(R.routes.map((r) => [r.event, r.layer, r.by]), [['E1', '目標', ['F1']], ['E2', '目標', ['F1']]])
  assert.deepEqual(R.human.filter((h) => ['E1', 'E2'].includes(h.id)).map((h) => h.id).sort(), ['E1', 'E2'])
})

test('P14-3: 群に入らない出来事は群の id の事実では覆われない。覆われない出来事が残る間は振り返りを続ける', async (t) => {
  const { state } = await afterDesignReview(t, THREE, [G1, G2], { agent: groupRetroAgent(GS), maxSteps: 7 })
  const L = ledgerOf(state)
  assert.equal(L.facts.length, 1)
  assert.equal(L.retro.rounds, 1)
  const n = cli('next', '--state', state)
  assert.equal(n.step, 'retro', `群の無い指摘 C（と群 G2-XX だけの出来事）は覆われていないので次の巡へ: ${JSON.stringify(n)}`)
})

test('P14-3: CLI の submit は台帳の群の id で照らす。台帳に無い群の id を根拠にした意図は残さず、理由を付けて拒む', async (t) => {
  const s = setup(t)
  const audit = async (phase) => groupedStatus(s.state, phase, THREE, [G1, G2])
  const agent = mockAgent({ 'retro-plan': () => ({ intents: [{ basis: ['c1:design:G9-NO'], hypothesis: '照らす', layer: '設計', look_at: ['x'] }] }) })
  const r = await drive(s.state, agent, { audit, maxSteps: 5 })
  for (const st of r.steps) assert.equal(st.ingest.code, 0, JSON.stringify(st.ingest))
  assert.equal(r.steps.at(-1).task, 'plan')
  const L = ledgerOf(s.state)
  assert.equal(L.intents.length, 0, '台帳に無い群の id を根拠にした計画の意図は残さない')
  assert.equal(L.attempts.retro, MAX_ATTEMPTS, '同じ体が出し直し、上限まで試行に数える')
  assert.ok(L.events.some((e) => e.stage === 'retro' && e.kind === 'rejected_output' && e.text.includes('c1:design:G9-NO')))
  // 周と段を付けていない id も、群の id ではない。
  const s2 = setup(t)
  await drive(s2.state, mockAgent({ 'retro-plan': () => ({ intents: [{ basis: ['G1-GS'], hypothesis: '照らす', layer: '設計', look_at: ['x'] }] }) }), { audit: async (phase) => groupedStatus(s2.state, phase, THREE, [G1, G2]), maxSteps: 5 })
  assert.equal(ledgerOf(s2.state).intents.length, 0)
})

test('P14-4: 出来事の id・件数・kind・層・単位は、群があっても無くても同じ（groups の欄だけが増える）', async (t) => {
  const a = await afterDesignReview(t)
  const b = await afterDesignReview(t, THREE.map((f) => ({ claim: f.claim })), [])
  const shape = (x) => ledgerOf(x.state).events.map((e) => [e.id, e.stage, e.kind, e.layer, e.unit, e.test, e.text.replaceAll(x.state, '<state>'), e.ref.replaceAll(x.state, '<state>')])
  const withG = ledgerOf(a.state)
  const plain = ledgerOf(b.state)
  assert.deepEqual(shape(a), shape(b))
  assert.ok(plain.events.filter((e) => e.kind === 'finding').every((e) => Array.isArray(e.groups) && e.groups.length === 0), '群の無い status でも groups は空の配列')
})

test('P14-5: audit_groups の欄を持たない台帳は、既存の文に揃えて拒否する（移行しない）', async (t) => {
  const { state } = setup(t)
  const L = ledgerOf(state)
  delete L.audit_groups
  writeFileSync(path.join(state, 'build.json'), JSON.stringify(L, null, 1))
  for (const argv of [['next', '--state', state], ['status', '--state', state]]) {
    const r = cli(...argv)
    assert.notEqual(r.code, 0, JSON.stringify(r))
    assert.ok(r.error.includes('台帳の形式が古い（設計レビューの群を持たない）'), r.error)
    assert.ok(r.error.includes('新しい stateDir で init からやり直す'), r.error)
  }
  assert.equal(JSON.parse(readFileSync(path.join(state, 'build.json'), 'utf8')).audit_groups, undefined, '移行して書き足さない')
})
