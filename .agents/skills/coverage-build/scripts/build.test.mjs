import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { C, findingPath, layerOf } from './build-core.mjs'
import { auditStatus, cli, defaultUnits, drive, mockAgent, runWorkflow, setup } from './test-harness.mjs'

const OK_CHECK = ['node', '-e', 'process.exit(0)']
const ledger = (state) => JSON.parse(readFileSync(path.join(state, 'build.json'), 'utf8'))
const order = (steps) => steps.map((s) => (s.phase ? `audit:${s.phase}` : s.step))

test('create: 設計 → 設計レビュー → テスト → 実装 → check → 実装レビューの順に回って完了する', async (t) => {
  const { state, repo } = setup(t, { checks: [OK_CHECK] })
  const { stop, steps } = await drive(state, mockAgent())
  assert.equal(stop.stop, 'complete', JSON.stringify(stop))
  assert.deepEqual(order(steps), ['design', 'audit:design', 'tests', 'implement', 'implement', 'checks', 'audit:impl'])
  // 依存の順: U1（code）が実装された後の呼び出しで U2（doc）を実装する。
  assert.deepEqual(steps.filter((s) => s.step === 'implement').map((s) => s.args.tasks.map((x) => x.unit_id)), [['U1'], ['U2']])
  assert.match(readFileSync(path.join(repo, 'test/a.test.mjs'), 'utf8'), /tests/)
  const L = ledger(state)
  assert.ok(L.agents.every((a) => a.model && a.effort), '起動ごとに model と effort を記録する')
})

test('update: 設計の前に既存の対象を検査し、その結果を設計の入力にする', async (t) => {
  const { state } = setup(t, { mode: 'update' })
  const audit = (phase) => (phase === 'baseline' ? auditStatus({ confirmed: [{ path: path.join(path.dirname(state), 'repo/src/old.mjs'), quote: '既にあるファイルの本文の行', layer: '実装', claim: '既存の欠陥' }], skip: ['x|purpose|p1'] }) : auditStatus())
  const log = []
  const { stop, steps } = await drive(state, mockAgent({}, log), { audit })
  assert.equal(stop.stop, 'complete', JSON.stringify(stop))
  assert.deepEqual(order(steps).slice(0, 3), ['design', 'audit:baseline', 'design'], '目標の照合 → 現状の検査 → 設計')
  assert.ok(!steps[0].args.arch && steps[0].args.goalBrief, '最初の呼び出しは目標の照合だけ')
  const brief = readFileSync(/Read で (\S+) を全て読む/.exec(log.find((x) => x.label === 'architect').prompt)[1], 'utf8')
  assert.match(brief, /既存の欠陥/)
  assert.match(brief, /x\|purpose\|p1/, '開示した枡も入力にする')
  assert.match(brief, /baseline-status\.json/, '現状の検査の全件も、読んだかを申告する入力にする')
})

test('update: 現状の検査で目標・方針の層の指摘が出たら、設計に進まず人間に返す', async (t) => {
  const { state } = setup(t, { mode: 'update' })
  const audit = () => auditStatus({ confirmed: [{ path: path.join(path.dirname(state), 'repo/src/old.mjs'), quote: '既にあるファイルの本文の行', layer: '要求' }] })
  const { stop, steps } = await drive(state, mockAgent(), { audit })
  assert.equal(stop.stop, 'needs_input')
  assert.equal(stop.human.length, 1)
  assert.deepEqual(order(steps), ['design', 'audit:baseline'])
})

test('update: 単位が既にある対象を書き換えても、現状の検査はやり直さない', async (t) => {
  const { state } = setup(t, { mode: 'update' })
  const over = { architect: (p) => {
    const brief = readFileSync(/Read で (\S+) を全て読む/.exec(p)[1], 'utf8')
    const units = defaultUnits(['AC1', 'D1'])
    units[1].paths = ['src/old.mjs']
    return { units, inputs_read: [...brief.matchAll(/^- (\/.+)$/gm)].map((m) => m[1]).filter((f) => /\.(md|mjs|json)$/.test(f)).map((f) => ({ path: f, quotes: [readFileSync(f, 'utf8').split('\n').find((l) => l.trim().length >= 14) || readFileSync(f, 'utf8').trim()] })), inputs_not_read: [], questions: [] }
  } }
  const { stop, steps } = await drive(state, mockAgent(over))
  assert.equal(stop.stop, 'complete', JSON.stringify(stop))
  assert.equal(order(steps).filter((x) => x === 'audit:baseline').length, 1)
})

test('review: 目標を照合してから作らずに検査し、振り返りで決めた層を報告するだけ', async (t) => {
  const { state } = setup(t, { mode: 'review' })
  const audit = () => auditStatus({ confirmed: [{ path: path.join(path.dirname(state), 'repo/src/old.mjs'), quote: '既にあるファイルの本文の行', layer: '詳細設計' }] })
  const { stop, steps } = await drive(state, mockAgent(), { audit })
  assert.equal(stop.stop, 'complete')
  assert.deepEqual(order(steps), ['design', 'audit:review', 'retro', 'retro'])
  assert.ok(steps[0].args.goalBrief && !steps[0].args.arch, 'review でも目標の照合はこのスキルで行う')
  assert.equal(stop.routes[0].layer, '設計')
  assert.ok(!steps.some((s) => ['tests', 'implement'].includes(s.step)))
})

test('層の写像は coverage-audit の 5 つの層の全てを 3 つの層へ送る', () => {
  assert.deepEqual(Object.keys(C.LAYER_MAP).sort(), [...C.AUDIT_LAYERS].sort())
  assert.deepEqual(C.AUDIT_LAYERS.map((l) => C.LAYER_MAP[l]), ['目標', '目標', '設計', '設計', '実装'])
  // 振り返りは層を上げられるが下げられない。
  assert.equal(layerOf({ layer: '実装' }, [{ layer: '設計' }]), '設計')
  assert.equal(layerOf({ layer: '設計' }, [{ layer: '実装' }]), '設計')
  assert.equal(layerOf({ layer: null, kind: 'check_failed' }, []), null)
  assert.equal(layerOf({ layer: null, kind: 'agent_missing' }, []), '進め方')
})

test('設計の欠陥は単位と依存する単位を設計からやり直し、args に前の設計の本文を載せない', async (t) => {
  const { state } = setup(t)
  let n = 0
  const audit = (phase) => (phase === 'design' && n++ === 0 ? auditStatus({ confirmed: [{ path: path.join(state, 'design', 'U1.md'), quote: '入力を受け取り、決まった値を返す。', layer: '詳細設計' }] }) : auditStatus())
  const { stop, steps } = await drive(state, mockAgent(), { audit })
  assert.equal(stop.stop, 'complete', JSON.stringify(stop))
  const designs = steps.filter((s) => s.step === 'design')
  assert.equal(designs.length, 2)
  assert.deepEqual(designs[1].args.units.map((u) => u.unit_id), ['U1', 'U2'], 'U2 は U1 に依存するのでやり直す')
  const text = JSON.stringify(designs[1].args)
  assert.ok(!text.includes('入力を受け取り'), '前の設計の本文は args に無い（束の path と hash だけ）')
  assert.ok(designs[1].argsBytes < 4000, `args は小さい: ${designs[1].argsBytes}`)
  const L = ledger(state)
  assert.equal(L.units.U1.rounds, 1)
  assert.equal(L.cycle, 2)
})

test('実装の欠陥は単位の実装へ戻し、テストの欠陥はテストから書き直す', async (t) => {
  const { state } = setup(t)
  let n = 0
  const audit = (phase) => (phase === 'impl' && n++ === 0 ? auditStatus({ confirmed: [{ path: path.join(path.dirname(state), 'repo/test/a.test.mjs'), quote: 'export const value = 2', layer: '実装' }] }) : auditStatus())
  const { stop, steps } = await drive(state, mockAgent(), { audit })
  assert.equal(stop.stop, 'complete', JSON.stringify(stop))
  assert.deepEqual(order(steps).slice(5), ['audit:impl', 'retro', 'retro', 'tests', 'implement', 'audit:impl'])
})

test('目標の層の欠陥・層の決まらない check の失敗は needs_input で人間に返し、answer で方式設計からやり直す', async (t) => {
  const { state } = setup(t, { checks: [['node', '-e', 'process.exit(3)']] })
  const { stop } = await drive(state, mockAgent())
  assert.equal(stop.stop, 'needs_input')
  assert.equal(stop.human[0].reason, '原因の層を決められない')
  assert.match(stop.human[0].text, /exit 3/)
  assert.equal(cli('answer', '--state', state, '--id', stop.human[0].id, '--text', 'check を直す').code, 0)
  const L = ledger(state)
  assert.equal(L.need_arch, true)
  assert.ok(L.constraints.some((c) => c.text.includes('check を直す')))
})

test('振り返り: 実在しない事実を根拠にした意図と、引用が合わない結論は受理しない。受理した原因は層を上げる', async (t) => {
  const { state } = setup(t)
  let n = 0
  const audit = (phase) => (phase === 'impl' && n++ === 0 ? auditStatus({ confirmed: [{ path: path.join(path.dirname(state), 'repo/src/a.mjs'), quote: 'export const value = 2', layer: '実装' }] }) : auditStatus())
  let plans = 0
  const over = {
    'retro-plan': (p) => {
      if (!/\[impl_review\/finding/.test(readFileSync(/Read で (\S+) を全て読む/.exec(p)[1], 'utf8'))) return undefined
      plans += 1
      if (plans === 1) return { intents: [{ basis: ['E999'], hypothesis: '架空', layer: '設計', look_at: ['x'] }] }
      if (plans === 2) return { intents: [{ basis: ['E1'], hypothesis: '偽の引用', layer: '設計', look_at: ['x'] }, { basis: ['E1'], hypothesis: '設計が値を決めていない', layer: '設計', look_at: ['x'] }] }
      return { intents: [] }
    },
    'retro-exam-0': () => ({ verdict: 'supported', cause: '偽', layer: '目標', evidence: [{ path: path.join(state, 'design', 'U1.md'), quote: 'この文は設計のどこにも無い文である' }] }),
    'retro-exam-1': () => ({ verdict: 'supported', cause: '設計が値を決めていない', layer: '設計', evidence: [{ path: path.join(state, 'design', 'U1.md'), quote: '入力を受け取り、決まった値を返す。' }] }),
  }
  const { stop, steps } = await drive(state, mockAgent(over), { audit })
  const L = ledger(state)
  assert.ok(L.intents.length >= 2)
  assert.deepEqual(L.facts.map((f) => f.layer), ['設計'], '偽の引用の結論（目標）は受理しない')
  const r = L.routes.find((x) => x.event === 'E1')
  assert.equal(r.layer, '設計', '監査の層（実装）より上流の原因へ戻す')
  assert.ok(steps.filter((s) => s.step === 'design').length >= 2, '設計からやり直す')
  assert.equal(stop.stop, 'complete', JSON.stringify(stop))
})

test('実装の担当がテストのファイルを変えたら、その回を受け付けない', async (t) => {
  const { state, repo } = setup(t)
  const over = { 'implement-U1': () => { writeFileSync(path.join(repo, 'test/a.test.mjs'), 'changed'); return undefined } }
  const { stop } = await drive(state, mockAgent(over))
  assert.equal(stop.stop, 'needs_input')
  assert.ok(stop.stuck.includes('implement:U1'))
  assert.ok(ledger(state).events.some((e) => e.kind === 'write_outside'))
})

test('方式設計の静的な検査: 循環・受け皿の無い基準・2 つの単位が持つファイル・読んだ証拠の無い入力を拒否する', () => {
  const ctx = { coverIds: ['AC1', 'D1'], inputs: ['/m.md'] }
  const us = defaultUnits(['AC1'])
  us[0].depends_on = ['U2']
  us[1].paths = ['src/a.mjs']
  const p = C.checkArch({ units: us, inputs_read: [{ path: '/m.md', quotes: [] }], inputs_not_read: [], questions: [] }, ctx)
  assert.ok(p.some((x) => x.includes('2 つが持つ')))
  assert.ok(p.some((x) => x.includes('D1 の受け皿')))
  assert.ok(p.some((x) => x.includes('引用が無い')))
  const us2 = defaultUnits(['AC1', 'D1'])
  us2[0].depends_on = ['U2']
  assert.ok(C.checkArch({ units: us2, inputs_read: [], inputs_not_read: [{ path: '/m.md', reason: '要らない' }], questions: [] }, ctx).some((x) => x.includes('循環')))
  assert.ok(C.checkArch({ units: [{ ...us2[1], depends_on: [], paths: ['/abs', 'a/../b'] }], inputs_read: [], inputs_not_read: [], questions: [] }, ctx).some((x) => x.includes('相対 path')))
})

test('方式設計の入力の引用が本文に無ければ、試行に数えて設計を受け付けない', async (t) => {
  const { state } = setup(t)
  const over = { architect: (p) => ({ units: defaultUnits(['AC1', 'D1']), inputs_read: [{ path: path.join(path.dirname(state), 'material.md'), quotes: ['材料に書かれていない架空の一文'] }], inputs_not_read: [], questions: [] }) }
  const { stop } = await drive(state, mockAgent(over))
  assert.equal(stop.stop, 'needs_input')
  assert.deepEqual(stop.stuck, ['arch'])
})

test('取り込み: 終わっていない検査を拒否し、引用の合わない指摘は欠陥として戻さない', async (t) => {
  const { state } = setup(t)
  const first = await drive(state, mockAgent(), { audit: () => auditStatus({ stop: 'needs_input', pending: ['c1'] }) })
  assert.equal(first.stop.code, 2)
  assert.match(first.stop.error, /読み終えていない枡/)
  const f = path.join(state, 'bad.json')
  writeFileSync(f, JSON.stringify(auditStatus({ stop: 'blocked' })))
  assert.match(cli('import-audit', '--state', state, '--status', f).error, /終わっていない/)
  writeFileSync(f, JSON.stringify({ ...auditStatus(), pending: { call_id: 'x', step: 'group' } }))
  assert.match(cli('import-audit', '--state', state, '--status', f).error, /途中にある/, '前の停止の記録が残っていても、途中の検査は受けない')
  const second = await drive(state, mockAgent(), { audit: (ph) => auditStatus(ph === 'design' ? { confirmed: [{ path: path.join(state, 'design', 'U1.md'), quote: '設計に無い架空の引用の一文', layer: '設計' }] } : {}) })
  assert.equal(second.stop.stop, 'complete', JSON.stringify(second.stop))
  const L = ledger(state)
  assert.ok(L.events.some((e) => e.kind === 'import_mismatch'))
  assert.equal(L.routes.find((r) => L.events.find((e) => e.id === r.event).kind === 'import_mismatch').layer, '進め方')
})

test('指摘の id から path を取る（見出しの key・回を含む）', () => {
  assert.equal(findingPath('/a/b#c.md#sec/sub~2|purpose|p1#abc'), '/a/b#c.md')
  assert.equal(findingPath('/x/y.mjs#c1|L1|p2#0123456789'), '/x/y.mjs')
  assert.equal(findingPath('retro:c1:review|R1|p1#0123456789'), null, 'coverage-audit 自身の振り返りの枡は対象のファイルでない')
})

test('native の .output（result に包んだ形）をそのまま ingest できる', async (t) => {
  const { state } = setup(t)
  const { stop } = await drive(state, mockAgent(), { wrap: true })
  assert.equal(stop.stop, 'complete', JSON.stringify(stop))
})

test('CLI の入力の誤りは台帳を作らずに拒否する', (t) => {
  const { d, state } = setup(t)
  assert.equal(cli('init', '--state', state, '--mode', 'create').code, 2, '既にある台帳')
  const s2 = path.join(d, 's2')
  const base = ['--state', s2, '--repo', d, '--goal', path.join(d, 'goal.md'), '--request', path.join(d, 'request.md')]
  assert.match(cli('init', ...base, '--mode', 'build').error, /--mode/)
  assert.match(cli('init', ...base, '--mode', 'update').error, /--target/)
  assert.match(cli('init', ...base, '--mode', 'create', '--check', '"make"').error, /配列/)
  assert.match(cli('init', ...base, '--mode', 'create', '--max-cycles', '0').error, /正の整数/)
  assert.match(cli('init', ...base, '--mode', 'create', '--input', '/no/such').error, /読めない/)
  assert.match(cli('next', '--state', state, '--bogus', 'x').error, /受け付けない/)
  assert.match(cli('ingest', '--state', state, '--result', path.join(d, 'goal.md')).error, /Workflow の呼び出しが無い/)
  assert.match(cli('answer', '--state', state, '--id', 'X9', '--text', 'a').error, /台帳に無い id/)
  assert.match(C.parseCited('- D1: a\n- D1: b', 'D').problems.join(), /重複/)
})

test('ingest は待っていない call_id と、書き換えた args を拒否する', async (t) => {
  const { state } = setup(t)
  const n = cli('next', '--state', state)
  const f = path.join(state, 'r.json')
  writeFileSync(f, JSON.stringify({ stage: 'design', call_id: 'other' }))
  assert.match(cli('ingest', '--state', state, '--result', f).error, /呼び出しが違う/)
  const args = JSON.parse(readFileSync(n.args_path, 'utf8'))
  const { runWorkflow } = await import('./test-harness.mjs')
  const res = await runWorkflow({ ...args, goalBrief: { path: '/x', hash: 'y' } }, mockAgent())
  assert.equal(res.status, 'blocked')
  writeFileSync(f, JSON.stringify(res))
  assert.match(cli('ingest', '--state', state, '--result', f).error, /args を拒否/)
})

test('上限: 起動数の上限で limit、やり直しの上限を超えたら人間に返す', async (t) => {
  const { state } = setup(t, { extra: ['--max-agents-total', '2'] })
  const { stop } = await drive(state, mockAgent())
  assert.equal(stop.stop, 'limit')
  const s = setup(t, { extra: ['--max-unit-rounds', '1'] })
  const audit = (phase) => (phase === 'impl' ? auditStatus({ confirmed: [{ path: path.join(s.repo, 'src/a.mjs'), quote: 'export const value = 2', layer: '実装' }] }) : auditStatus())
  const r = await drive(s.state, mockAgent(), { audit })
  assert.equal(r.stop.stop, 'needs_input')
  const h = r.stop.human.find((x) => x.id.startsWith('rounds:U1'))
  assert.ok(h)
  assert.equal(cli('answer', '--state', s.state, '--id', h.id, '--text', '続ける').code, 0)
  assert.equal(ledger(s.state).units.U1.rounds, 0)
})

test('持ち越し: 完了の後に実装のファイルが変わったら、check と実装レビューだけをやり直す', async (t) => {
  const { state, repo } = setup(t, { checks: [OK_CHECK] })
  await drive(state, mockAgent())
  writeFileSync(path.join(repo, 'docs/a.md'), '人が直した\n')
  const { stop, steps } = await drive(state, mockAgent())
  assert.equal(stop.stop, 'complete')
  assert.deepEqual(order(steps), ['checks', 'audit:impl'])
  assert.equal(steps[1].out.audit.initialized, false, 'テストの偽の検査は台帳を作らないので false（本物は同じ置き場を使い回す）')
})

// ---------------- 目標の固定と照合 ----------------
test('init: 引用の無い項目と、依頼文・決定の記録に無い引用を拒否し、台帳を作らない', (t) => {
  const { d } = setup(t)
  const base = (s) => ['--state', path.join(d, s), '--mode', 'create', '--repo', d, '--request', path.join(d, 'request.md'), '--decisions', path.join(d, 'decisions.md')]
  const cases = [
    ['no-cite', '- G1: 値を計算する関数と、その使い方の文書\n', /G1: 引用が無い/],
    ['fake', '- G1: 値を計算する関数と、その使い方の文書 〔request: 依頼文のどこにも無い架空の一文である〕\n', /request に逐語で無い/],
    ['bad-src', '- G1: 値を計算する関数 〔memo: 値を計算する関数を作り、使い方を書いてほしい〕\n', /引用元が/],
    ['prose', '値を計算する関数と、その使い方の文書\n', /「- 」で始まらない/],
  ]
  for (const [s, text, re] of cases) {
    writeFileSync(path.join(d, `goal-${s}.md`), text)
    const r = cli('init', ...base(s), '--goal', path.join(d, `goal-${s}.md`))
    assert.equal(r.code, 2, s)
    assert.match(JSON.stringify(r.problems || r.error), re, s)
    assert.ok(!existsSync(path.join(d, s, 'build.json')), `${s}: 台帳を作らない`)
  }
  writeFileSync(path.join(d, 'c-bad.md'), '- D1: 依存を足さない 〔decisions: 依存を足さない〕\n')
  const r = cli('init', '--state', path.join(d, 'nodec'), '--mode', 'create', '--repo', d, '--request', path.join(d, 'request.md'), '--goal', path.join(d, 'goal.md'), '--constraints', path.join(d, 'c-bad.md'))
  assert.equal(r.code, 2, '決定の記録を渡さずに decisions を引けない')
  assert.match(JSON.stringify(r.problems), /D1: 引用元が/)
})

test('目標の照合: どの項目にも受け止められていない成果があれば、その成果と引用を needs_input で返す', async (t) => {
  const { state } = setup(t)
  const over = { 'goal-check': () => ({ outcomes: [
    { outcome: '値を計算する関数', quotes: [{ source: 'request', quote: '値を計算する関数を作り、使い方を書いてほしい' }], items: ['G1'] },
    { outcome: '依存を足さない', quotes: [{ source: 'decisions', quote: '依存を足さない' }], items: [] },
  ] }) }
  const { stop, steps } = await drive(state, mockAgent(over))
  assert.equal(stop.stop, 'needs_input', JSON.stringify(stop))
  assert.deepEqual(stop.goal_gaps, [{ outcome: '依存を足さない', quotes: [{ source: 'decisions', quote: '依存を足さない' }] }])
  assert.deepEqual(order(steps), ['design'])
  assert.equal(ledger(state).goal.checked, false)
})

test('目標の照合: 偽の引用・実在しない項目の id の返り値は受け付けず、合格にも needs_input の成果にもしない', async (t) => {
  const { state } = setup(t)
  const fake = { outcome: '架空の成果', quotes: [{ source: 'request', quote: '依頼文に無い架空の成果を求める一文' }], items: [] }
  const { stop } = await drive(state, mockAgent({ 'goal-check': () => ({ outcomes: [fake] }) }))
  assert.equal(stop.stop, 'needs_input')
  assert.deepEqual(stop.stuck, ['goal'], '照合役の出力の欠けとして試行に数える')
  assert.equal(stop.goal_gaps, undefined, '偽の引用の成果は落とした要求として返さない')
  const L = ledger(state)
  assert.equal(L.goal.checked, false)
  assert.ok(L.events.some((e) => e.kind === 'rejected_output' && /逐語で無い/.test(e.text)))
  const { state: s2 } = setup(t)
  const bad = { outcomes: [{ outcome: '関数', quotes: [{ source: 'request', quote: '値を計算する関数を作り、使い方を書いてほしい' }], items: ['G9'] }] }
  const r2 = await drive(s2, mockAgent({ 'goal-check': () => bad }))
  assert.deepEqual(r2.stop.stuck, ['goal'])
  assert.ok(ledger(s2).events.some((e) => /実在しない項目の id: G9/.test(e.text)))
})

test('answer: 受け入れ基準・制約・決定の記録を直せ、直したら照合からやり直す。引用が合わない直しは台帳を変えずに拒否する', async (t) => {
  const { d, state } = setup(t)
  let gap = true
  const over = { 'goal-check': (p) => (gap ? { outcomes: [{ outcome: '依存を足さない', quotes: [{ source: 'decisions', quote: '依存を足さない' }], items: [] }] } : undefined) }
  const first = await drive(state, mockAgent(over))
  assert.equal(first.stop.stop, 'needs_input')
  writeFileSync(path.join(d, 'bad.md'), '- D1: 依存を足さない 〔decisions: 決定の記録に無い架空の決定の文〕\n')
  const rev = ledger(state).rev
  const bad = cli('answer', '--state', state, '--id', 'constraints', '--file', path.join(d, 'bad.md'))
  assert.equal(bad.code, 2)
  assert.equal(ledger(state).rev, rev, '拒否した直しは台帳を変えない')
  writeFileSync(path.join(d, 'c2.md'), '- D1: 依存を足さない 〔decisions: 依存を足さない〕\n- D2: 標準のモジュールだけを使う 〔decisions: 標準のモジュールだけを使う〕\n')
  writeFileSync(path.join(d, 'dec2.md'), '- 入力が 1 なら 2 を返す\n- 依存を足さない\n- 標準のモジュールだけを使う\n')
  assert.equal(cli('answer', '--state', state, '--id', 'constraints', '--file', path.join(d, 'c2.md')).code, 2, '決定の記録に無い引用は、決定の記録を先に直すまで拒否する')
  assert.equal(cli('answer', '--state', state, '--id', 'decisions', '--file', path.join(d, 'dec2.md')).code, 0)
  assert.equal(cli('answer', '--state', state, '--id', 'constraints', '--file', path.join(d, 'c2.md')).code, 0)
  writeFileSync(path.join(d, 'ac2.md'), '- AC1: 入力が 1 なら 2 を返す 〔decisions: 入力が 1 なら 2 を返す〕\n')
  assert.equal(cli('answer', '--state', state, '--id', 'criteria', '--file', path.join(d, 'ac2.md')).code, 0)
  const L = ledger(state)
  assert.equal(L.goal.checked, false)
  assert.deepEqual(L.goal.problems, [])
  assert.deepEqual(L.constraints.map((c) => c.id), ['D1', 'D2'])
  gap = false
  const second = await drive(state, mockAgent(over))
  assert.equal(second.stop.stop, 'complete', JSON.stringify(second.stop))
  assert.ok(second.steps[0].args.goalBrief, '直した後の最初の呼び出しは目標の照合を含む')
})

test('answer: 質問への回答は決定の記録に足し、その回答を引用する制約にする（引用の無い項目を作らない）', async (t) => {
  const { state } = setup(t, { checks: [['node', '-e', 'process.exit(3)']] })
  const { stop } = await drive(state, mockAgent())
  assert.equal(cli('answer', '--state', state, '--id', stop.human[0].id, '--text', 'check を直す').code, 0)
  const L = ledger(state)
  const a = L.constraints.find((c) => c.text.includes('check を直す'))
  assert.ok(a.cites.length && a.cites.every((c) => c.source === 'decisions'))
  assert.deepEqual(C.checkCited(L.constraints, C.citeSources({ request: L.request, decisions: L.decisions })), [])
})

test('coverage-audit に渡すもの: 照合済みの印と、受け入れ基準を制約と別の欄で渡す', async (t) => {
  const { state } = setup(t)
  const { steps } = await drive(state, mockAgent(), { maxSteps: 2 })
  const a = steps[1].out.audit
  assert.equal(steps[1].phase, 'design')
  assert.match(readFileSync(a.criteria, 'utf8'), /^- AC1: /m)
  assert.doesNotMatch(readFileSync(a.constraints, 'utf8'), /AC1/, '基準を制約の欄に混ぜない')
  assert.deepEqual(a.init_argv.slice(a.init_argv.indexOf('--goal-checked'), a.init_argv.indexOf('--goal-checked') + 2), ['--goal-checked', 'coverage-build'])
  for (const k of ['goal', 'request', 'decisions', 'criteria', 'constraints']) assert.ok(a.init_argv.includes(a[k]), k)
})

test('引用の短さ: 依頼文の空でない 1 行の全体は短くても引ける。行の一部・行をまたぐ短い引用は引けない', async (t) => {
  const { d, repo } = setup(t)
  writeFileSync(path.join(d, 'request.md'), '値を計算する関数を作り、使い方を書いてほしい。\n\n  直してやり直す  \nなお依存は足さない\n')
  const src = C.citeSources({ request: readFileSync(path.join(d, 'request.md'), 'utf8') })
  const q = (quote) => C.checkGoalMap({ outcomes: [{ outcome: '成果', quotes: [{ source: 'request', quote }], items: ['G1'] }] }, ['G1'], src)
  assert.deepEqual(q('直してやり直す'), [], '前後の空白を除いた 1 行の全体')
  assert.deepEqual(q('なお依存は足さない'), [])
  assert.match(q('直して')[0], /字未満/, '行の一部は短いと拒否する')
  assert.match(q('直してやり直す なお')[0], /字未満|逐語/, '行をまたぐ短い引用は拒否する')
  // init でも、短い 1 行の全体を引く目標を受け付ける。
  writeFileSync(path.join(d, 'goal.md'), '- G1: 直してやり直す 〔request: 直してやり直す〕\n')
  const state = path.join(d, 'state2')
  const r = cli('init', '--state', state, '--mode', 'create', '--repo', repo, '--goal', path.join(d, 'goal.md'), '--request', path.join(d, 'request.md'),
    '--decisions', path.join(d, 'decisions.md'), '--criteria', path.join(d, 'criteria.md'), '--constraints', path.join(d, 'constraints.md'))
  assert.equal(r.code, 0, JSON.stringify(r))
  // 目標の照合役がその行を引いても、返り値の全体を受け付ける。
  const over = { 'goal-check': () => ({ outcomes: [{ outcome: '直してやり直す', quotes: [{ source: 'request', quote: '直してやり直す' }], items: ['G1', 'AC1', 'D1'] }] }) }
  const { steps } = await drive(state, mockAgent(over))
  assert.equal(ledger(state).goal.checked, true, JSON.stringify(steps[0] && steps[0].ingest))
  assert.ok(!ledger(state).events.some((e) => e.kind === 'rejected_output'))
})

test('ingest: 受け付けなかった出力があれば、その理由を出力の rejected に載せる（受け付けたときは載せない）', async (t) => {
  const { state } = setup(t)
  const n = cli('next', '--state', state)
  const fake = { outcome: '架空の成果', quotes: [{ source: 'request', quote: '依頼文に無い架空の成果を求める一文' }], items: [] }
  const args = JSON.parse(readFileSync(n.args_path, 'utf8'))
  const res = await runWorkflow(args, mockAgent({ 'goal-check': () => ({ outcomes: [fake] }) }))
  const rp = path.join(state, 'result-bad.json')
  writeFileSync(rp, JSON.stringify(res))
  const g = cli('ingest', '--state', state, '--result', rp)
  assert.equal(g.code, 0, JSON.stringify(g))
  assert.equal(g.ok, true)
  assert.equal(g.rejected.length, 1)
  assert.match(g.rejected[0], /目標の照合.*逐語で無い/)
  assert.match(g.next, /next を流す/)
  const { state: s2 } = setup(t)
  const n2 = cli('next', '--state', s2)
  const rp2 = path.join(s2, 'result-ok.json')
  writeFileSync(rp2, JSON.stringify(await runWorkflow(JSON.parse(readFileSync(n2.args_path, 'utf8')), mockAgent())))
  const ok = cli('ingest', '--state', s2, '--result', rp2)
  assert.equal(ok.code, 0)
  assert.equal(ok.rejected, undefined, '受け付けた出力だけなら rejected を載せない')
})

test('上限: やり直しの上限に答えた後にまた上限を超えたら、もう一度 needs_input で人間に返す', async (t) => {
  const s = setup(t, { extra: ['--max-unit-rounds', '1', '--max-cycles', '10'] })
  const audit = (phase) => (phase === 'impl' ? auditStatus({ confirmed: [{ path: path.join(s.repo, 'src/a.mjs'), quote: 'export const value = 2', layer: '実装' }] }) : auditStatus())
  const first = await drive(s.state, mockAgent(), { audit })
  assert.equal(first.stop.stop, 'needs_input', JSON.stringify(first.stop))
  const h1 = first.stop.human.find((h) => h.id.startsWith('rounds:U1'))
  assert.ok(h1, JSON.stringify(first.stop.human))
  assert.equal(cli('answer', '--state', s.state, '--id', h1.id, '--text', '続ける').code, 0)
  assert.equal(ledger(s.state).units.U1.rounds, 0)
  const second = await drive(s.state, mockAgent(), { audit })
  assert.equal(second.stop.stop, 'needs_input', JSON.stringify(second.stop))
  const h2 = second.stop.human.find((h) => h.id.startsWith('rounds:U1'))
  assert.ok(h2 && h2.id !== h1.id, '超えた回ごとに別の id で返す')
})

test('全件失敗から再開: 全ての役が欠けた呼び出しで増えた試行を戻し、原因を直した run は完了する', async (t) => {
  const { state } = setup(t)
  const dead = await drive(state, async () => null)
  assert.equal(dead.stop.stop, 'blocked', JSON.stringify(dead.stop))
  assert.equal(dead.stop.cause, 'failure')
  const again = await drive(state, mockAgent())
  assert.equal(again.stop.stop, 'complete', JSON.stringify(again.stop))
})

test('answer: 回答から作る制約の id は、既にある目標・基準・制約の id と重ならない', async (t) => {
  const { d, state } = setup(t, { checks: [['node', '-e', 'process.exit(3)']] })
  const { stop } = await drive(state, mockAgent())
  assert.equal(stop.stop, 'needs_input', JSON.stringify(stop))
  writeFileSync(path.join(d, 'c-a1.md'), '- D1: 依存を足さない 〔decisions: 依存を足さない〕\n- A1: 入力が 1 なら 2 を返す 〔decisions: 入力が 1 なら 2 を返す〕\n')
  assert.equal(cli('answer', '--state', state, '--id', 'constraints', '--file', path.join(d, 'c-a1.md')).code, 0)
  assert.equal(cli('answer', '--state', state, '--id', stop.human[0].id, '--text', 'check を直す').code, 0)
  const ids = ledger(state).constraints.map((c) => c.id)
  assert.deepEqual(ids, ['D1', 'A1', 'A2'])
})

for (const shape of ['runner', 'native']) {
  test(`振り返り: pipeline の callback の引数の形（${shape}）に依らず、全ての意図を実行して結果を意図に結ぶ`, async (t) => {
    const { state } = setup(t)
    let n = 0
    const audit = (phase) => (phase === 'impl' && n++ === 0 ? auditStatus({ confirmed: [{ path: path.join(path.dirname(state), 'repo/src/a.mjs'), quote: 'export const value = 2', layer: '実装' }] }) : auditStatus())
    let planned = false
    const log = []
    const over = {
      'retro-plan': (p) => {
        const m = /^- (E\d+) \[impl_review\/finding/m.exec(readFileSync(/Read で (\S+) を全て読む/.exec(p)[1], 'utf8'))
        if (!m || planned) return undefined
        planned = true
        return { intents: [{ basis: [m[1]], hypothesis: '一つ目の仮説', layer: '実装', look_at: ['x'] }, { basis: [m[1]], hypothesis: '二つ目の仮説', layer: '実装', look_at: ['x'] }] }
      },
    }
    await drive(state, mockAgent(over, log), { audit, run: (args, fn) => runWorkflow(args, fn, { shape }) })
    assert.ok(planned)
    const labels = log.map((x) => x.label.split('（')[0]).filter((l) => l.startsWith('retro-exam'))
    assert.deepEqual([...new Set(labels)].sort(), ['retro-exam-0', 'retro-exam-1'])
    const its = ledger(state).intents.filter((i) => /の仮説$/.test(i.hypothesis))
    assert.equal(its.length, 2)
    assert.ok(its.every((i) => i.status !== 'not_run'), JSON.stringify(its))
  })
}
