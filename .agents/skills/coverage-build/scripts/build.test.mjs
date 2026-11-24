import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { C, MAX_ATTEMPTS, RETRO_MAX_ROUNDS, UNIT_MAX_BYTES, findingPath, importAudit, layerOf, retroConcluded } from './build-core.mjs'
import { archOf, auditStatus, cli, defaultUnits, drive, mockAgent, runWorkflow, setup } from './test-harness.mjs'
import { act as boardAct, auditPos, driveScript } from './board-fixture.mjs'

const OK_CHECK = ['node', '-e', 'process.exit(0)']
const ledger = (state) => JSON.parse(readFileSync(path.join(state, 'build.json'), 'utf8'))
const order = (steps) => steps.map((s) => (s.phase ? `audit:${s.phase}` : s.step))

test('create: 設計 → 設計レビュー → テスト → 実装 → check → 実装レビューの順に回って完了する', async (t) => {
  const { state, repo } = setup(t, { checks: [OK_CHECK] })
  const log = []
  const { stop, steps } = await drive(state, mockAgent({}, log))
  assert.equal(stop.stop, 'complete', JSON.stringify(stop))
  assert.deepEqual(order(steps), ['design', 'design', 'design', 'audit:design', 'tests', 'implement', 'checks', 'audit:impl'])
  assert.deepEqual(steps.filter((s) => s.step === 'design').map((s) => s.task), ['goal', 'arch', 'spec'], '目標の照合 → 方式設計 → 詳細設計（前の役の出力を読む役は次の呼び出し）')
  // 依存の順: 実装の 1 体が U1（code）を出して受理された後に、U2（doc）を取り直す。
  assert.deepEqual(log.filter((x) => x.role === 'implementer').map((x) => x.label), ['implement-U1', 'implement-U2'])
  assert.match(readFileSync(path.join(repo, 'test/a.test.mjs'), 'utf8'), /tests/)
  const L = ledger(state)
  assert.ok(L.agents.every((a) => a.model && a.effort), '起動ごとに model と effort を記録する')
})

test('update: 設計の前に既存の対象を検査し、その結果を設計の入力にする', async (t) => {
  const { state } = setup(t, { mode: 'update' })
  const audit = (phase) => (phase === 'baseline' ? auditStatus({ phase, confirmed: [{ path: path.join(path.dirname(state), 'repo/src/old.mjs'), quote: '既にあるファイルの本文の行', layer: '実装', claim: '既存の欠陥' }] }) : auditStatus({ phase }))
  const log = []
  const { stop, steps } = await drive(state, mockAgent({}, log), { audit })
  assert.equal(stop.stop, 'complete', JSON.stringify(stop))
  assert.deepEqual(order(steps).slice(0, 3), ['design', 'audit:baseline', 'design'], '目標の照合 → 現状の検査 → 設計')
  assert.equal(steps[0].task, 'goal', '最初の呼び出しは目標の照合だけ')
  const q = log.find((x) => x.label === 'architect').inputs
  assert.match(JSON.stringify(q.baseline), /既存の欠陥/)
  assert.ok(q.input_paths.some((f) => /baseline-status\.json$/.test(f)), '現状の検査の全件も、読んだかを申告する入力にする')
})

// 開示（skip）は偽の status で渡せないので、coverage-audit のファイルの段の役が対象の単位を出し直しても照合に落ちる形で起こす。
test('update: 現状の検査が開示した見ていない単位も、設計の入力にする', async (t) => {
  // 対象を 2 つにする（受理した単位が 1 つも無い検査は開示でなく blocked で止まるので、old.mjs だけを読めない単位にする）。
  const { d, repo } = setup(t, { mode: 'update' })
  writeFileSync(path.join(repo, 'src', 'other.mjs'), 'export const other = 1 // もう 1 つの既にあるファイルの行\n')
  const state = path.join(d, 'state-two')
  const init = cli('init', '--state', state, '--mode', 'update', '--repo', repo, ...['goal', 'request', 'decisions', 'criteria', 'constraints'].flatMap((k) => [`--${k}`, path.join(d, `${k}.md`)]),
    '--input', path.join(d, 'material.md'), '--target', path.join(repo, 'src', 'old.mjs'), '--target', path.join(repo, 'src', 'other.mjs'))
  assert.equal(init.code, 0, JSON.stringify(init))
  const log = []
  const bad = { seen: [], findings: [], references: [], guarantees: [], premises: [] }
  const { stop } = await drive(state, mockAgent({}, log), { auditOver: { file: (task) => (path.basename(task.unit.path) === 'old.mjs' ? bad : undefined) }, maxSteps: 3 })
  const a = log.find((x) => x.label === 'architect')
  assert.ok(a, `方式設計に進む: ${JSON.stringify(stop)}`)
  assert.ok(a.inputs.baseline && a.inputs.baseline.not_seen.length >= 1, `開示した単位も入力にする: ${JSON.stringify(a.inputs.baseline)}`)
})

test('update: 現状の検査で目標・方針の層の指摘が出たら、設計に進まず人間に返す', async (t) => {
  const { state } = setup(t, { mode: 'update' })
  const audit = (phase) => auditStatus({ phase, confirmed: [{ path: path.join(path.dirname(state), 'repo/src/old.mjs'), quote: '既にあるファイルの本文の行', layer: '要求' }] })
  const { stop, steps } = await drive(state, mockAgent(), { audit })
  assert.equal(stop.stop, 'needs_input')
  assert.equal(stop.human.length, 1)
  assert.deepEqual(order(steps), ['design', 'audit:baseline'])
})

test('update: 単位が既にある対象を書き換えても、現状の検査はやり直さない', async (t) => {
  const { state } = setup(t, { mode: 'update' })
  const over = { architect: (p, o) => {
    const units = defaultUnits(['AC1', 'D1'])
    units[1].paths = ['src/old.mjs']
    return archOf(o.inputs, units)
  } }
  const { stop, steps } = await drive(state, mockAgent(over))
  assert.equal(stop.stop, 'complete', JSON.stringify(stop))
  assert.equal(order(steps).filter((x) => x === 'audit:baseline').length, 1)
})

test('review: 目標を照合してから作らずに検査し、振り返りで決めた層を報告するだけ', async (t) => {
  const { state } = setup(t, { mode: 'review' })
  const audit = (phase) => auditStatus({ phase, confirmed: [{ path: path.join(path.dirname(state), 'repo/src/old.mjs'), quote: '既にあるファイルの本文の行', layer: '詳細設計' }] })
  const { stop, steps } = await drive(state, mockAgent(), { audit })
  assert.equal(stop.stop, 'complete')
  assert.deepEqual(order(steps), ['design', 'audit:review', 'retro', 'retro'])
  assert.equal(steps[0].task, 'goal', 'review でも目標の照合はこのスキルで行う')
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

test('設計の欠陥は単位と依存する単位を設計からやり直し、args に前の設計の本文を載せない（前の設計は query の previous の path で渡る）', async (t) => {
  const { state } = setup(t)
  let n = 0
  const audit = (phase) => (phase === 'design' && n++ === 0 ? auditStatus({ phase, confirmed: [{ path: path.join(state, 'design', 'U1.md'), quote: '入力を受け取り、決まった値を返す。', layer: '詳細設計' }] }) : auditStatus({ phase }))
  const log = []
  const { stop, steps } = await drive(state, mockAgent({}, log), { audit })
  assert.equal(stop.stop, 'complete', JSON.stringify(stop))
  const designs = steps.filter((s) => s.task === 'spec')
  assert.equal(designs.length, 2)
  const redo = log.filter((x) => x.role === 'unit_designer').slice(2)
  assert.deepEqual(redo.map((x) => x.inputs.unit.id), ['U1', 'U2'], 'U2 は U1 に依存するのでやり直す')
  assert.ok(redo.every((x) => x.inputs.previous && x.inputs.previous.endsWith(`${x.inputs.unit.id}.md`)), '前の設計は path で渡る')
  const text = JSON.stringify(designs[1].args)
  assert.ok(!text.includes('入力を受け取り'), '前の設計の本文は args に無い')
  // drive の step の args は波ごとの見え方（行と波の id）。本物の args の key は blackboard.test.mjs の B4 が照らす。
  assert.deepEqual(Object.keys(designs[1].args).sort(), ['callId', 'stage', 'state', 'wave', 'workers'])
  const L = ledger(state)
  assert.equal(L.units.U1.rounds, 1)
  assert.equal(L.cycle, 2)
})

test('実装の欠陥は単位の実装へ戻し、テストの欠陥はテストから書き直す', async (t) => {
  const { state } = setup(t)
  let n = 0
  const audit = (phase) => (phase === 'impl' && n++ === 0 ? auditStatus({ phase, confirmed: [{ path: path.join(path.dirname(state), 'repo/test/a.test.mjs'), quote: 'export const value = 2', layer: '実装' }] }) : auditStatus({ phase }))
  const { stop, steps } = await drive(state, mockAgent(), { audit })
  assert.equal(stop.stop, 'complete', JSON.stringify(stop))
  assert.deepEqual(order(steps).slice(6), ['audit:impl', 'retro', 'retro', 'tests', 'implement', 'audit:impl'])
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
  const audit = (phase) => (phase === 'impl' && n++ === 0 ? auditStatus({ phase, confirmed: [{ path: path.join(path.dirname(state), 'repo/src/a.mjs'), quote: 'export const value = 2', layer: '実装' }] }) : auditStatus({ phase }))
  let plans = 0
  const over = {
    'retro-plan': (p, o) => {
      if (!o.inputs.events.some((e) => e.stage === 'impl_review' && e.kind === 'finding')) return undefined
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
  const p = C.checkArch({ units: us, inputs_read: [{ path: '/m.md', quotes: [] }], inputs_not_read: [], questions: [], contracts: [], copies: [] }, ctx)
  assert.ok(p.some((x) => x.includes('2 つが持つ')))
  assert.ok(p.some((x) => x.includes('D1 の受け皿')))
  assert.ok(p.some((x) => x.includes('引用が無い')))
  const us2 = defaultUnits(['AC1', 'D1'])
  us2[0].depends_on = ['U2']
  assert.ok(C.checkArch({ units: us2, inputs_read: [], inputs_not_read: [{ path: '/m.md', reason: '要らない' }], questions: [], contracts: [], copies: [] }, ctx).some((x) => x.includes('循環')))
  assert.ok(C.checkArch({ units: [{ ...us2[1], depends_on: [], paths: ['/abs', 'a/../b'] }], inputs_read: [], inputs_not_read: [], questions: [], contracts: [], copies: [] }, ctx).some((x) => x.includes('相対 path')))
})

test('方式設計の入力の引用が本文に無ければ、試行に数えて設計を受け付けない', async (t) => {
  const { state } = setup(t)
  const over = { architect: (p) => ({ units: defaultUnits(['AC1', 'D1']), inputs_read: [{ path: path.join(path.dirname(state), 'material.md'), quotes: ['材料に書かれていない架空の一文'] }], inputs_not_read: [], questions: [], contracts: [], copies: [] }) }
  const { stop } = await drive(state, mockAgent(over))
  assert.equal(stop.stop, 'needs_input')
  assert.deepEqual(stop.stuck, ['arch'])
})

// 取り込みは CLI の中で importAudit を流す。終わっていない検査を拒む規則と、
// 引用の合わない指摘を欠陥として戻さない規則は importAudit の振る舞いなので、importAudit に偽の status を渡して確かめる。
test('取り込み（importAudit）: 終わっていない検査を拒否し、引用の合わない指摘は欠陥として戻さず進め方の出来事にする', (t) => {
  const { state } = setup(t)
  const L = ledger(state)
  const text = '# U1\n\n入力を受け取り、決まった値を返す。\n'
  const io = { readText: () => text, unitOfPath: () => ({ unit: 'U1', test: false }) }
  assert.throws(() => importAudit(L, auditStatus({ phase: 'design', stop: 'needs_input', pending: ['c1'] }), 'design', io), /読み終えていない単位/)
  assert.throws(() => importAudit(L, auditStatus({ phase: 'design', stop: 'blocked' }), 'design', io), /終わっていない/)
  assert.throws(() => importAudit(L, { ...auditStatus({ phase: 'design' }), pending: { call_id: 'x', step: 'group' } }, 'design', io), /途中にある/, '前の停止の記録が残っていても、途中の検査は受けない')
  importAudit(L, auditStatus({ phase: 'design', confirmed: [{ path: path.join(state, 'design', 'U1.md'), quote: '設計に無い架空の引用の一文', layer: '詳細設計' }] }), 'design', io)
  const e = L.events.find((x) => x.kind === 'import_mismatch')
  assert.ok(e, JSON.stringify(L.events))
  assert.ok(!L.events.some((x) => x.kind === 'finding'), '欠陥として戻さない')
  assert.equal(layerOf(e, L.facts), '進め方')
})

test('指摘の path は paths の先頭（引用はその単位の本文にある）。paths の無い指摘は対象のファイルでない', () => {
  assert.equal(findingPath({ id: 'F0123456789ab', paths: ['/a/b#c.md', '/x/y.mjs'] }), '/a/b#c.md', 'ファイルをまたぐ指摘は先頭の path に結ぶ')
  assert.equal(findingPath({ id: 'F0123456789ab', paths: ['/x/y.mjs'] }), '/x/y.mjs')
  assert.equal(findingPath({ id: 'F0123456789ab', paths: [] }), null)
  assert.equal(findingPath({ id: 'F0123456789ab' }), null, 'paths の無い指摘（coverage-audit 自身の振り返りなど）は対象のファイルでない')
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
  assert.match(cli('ingest', '--state', state, '--call', 'x', '--result', path.join(d, 'goal.md')).error, /Workflow の呼び出しが無い/)
  assert.match(cli('answer', '--state', state, '--id', 'X9', '--text', 'a').error, /台帳に無い id/)
  assert.match(C.parseCited('- D1: a\n- D1: b', 'D').problems.join(), /重複/)
})

test('ingest は待っていない call_id を拒み、壊れた args の Workflow は役を起動せずに起動の記録を空で返す', async (t) => {
  const { state } = setup(t)
  const n = cli('next', '--state', state)
  const f = path.join(state, 'r.json')
  writeFileSync(f, JSON.stringify({ agents: [], tokens: null }))
  assert.match(cli('ingest', '--state', state, '--call', 'other', '--result', f).error, /閉じる呼び出しが違う/)
  const args = JSON.parse(readFileSync(n.args_path, 'utf8'))
  const launched = []
  // 壊れた行は args の最初の波の行（wave.rows）で渡す。
  const res = await runWorkflow({ ...args, wave: { id: args.wave ? args.wave.id : 1, rows: [{ id: 'g1', role: 'no_such_role', model: 'sonnet', effort: 'medium', stage: 'design' }] } }, async (p, o) => { launched.push(o.label); return { notes: [] } })
  assert.deepEqual(res, { agents: [], tokens: null })
  assert.deepEqual(launched, [])
})

test('上限: 起動数の上限で limit、やり直しの上限を超えたら人間に返す', async (t) => {
  const { state } = setup(t, { extra: ['--max-agents-total', '2'] })
  const { stop } = await drive(state, mockAgent())
  assert.equal(stop.stop, 'limit')
  const s = setup(t, { extra: ['--max-unit-rounds', '1', '--max-cycles', '10'] }) // やり直しの上限（周の上限でなく）を確かめるので、周の上限は上げておく
  const audit = (phase) => (phase === 'impl' ? auditStatus({ phase, confirmed: [{ path: path.join(s.repo, 'src/a.mjs'), quote: 'export const value = 2', layer: '実装' }] }) : auditStatus({ phase }))
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
  const a = steps[1].out.audit
  assert.equal(a.state, path.join(state, 'audit', 'state'), '置き場は固定の 1 つ')
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
  assert.equal(second.steps[0].task, 'goal', '直した後の最初の呼び出しは目標の照合')
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

// CLI が同じ process で coverage-audit の台帳（stateDir/audit/state）を作る。渡したものは検査の台帳で確かめる。
test('coverage-audit に渡すもの: 照合済みの印と、受け入れ基準を制約と別の欄で渡す', async (t) => {
  const { state } = setup(t)
  const { steps } = await drive(state, mockAgent(), { maxSteps: 4 })
  assert.equal(steps[3].phase, 'design')
  const AL = auditLedger(state)
  assert.equal(AL.goal.checked_by, 'coverage-build', '照合済みの印')
  assert.deepEqual(AL.criteria.map((c) => c.id), ['AC1'], '受け入れ基準は基準の欄')
  assert.deepEqual(AL.constraints.map((c) => c.id), ['D1'], '基準を制約の欄に混ぜない')
  assert.ok(AL.decisions && AL.decisions.includes('依存を足さない'), '決定の記録も渡す')
})
const auditLedger = (state) => JSON.parse(readFileSync(path.join(state, 'audit', 'state', 'ledger.json'), 'utf8'))

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
  const g = cli('ingest', '--state', state, '--call', n.call_id, '--result', rp)
  assert.equal(g.code, 0, JSON.stringify(g))
  assert.equal(g.ok, true)
  assert.equal(g.rejected.length, MAX_ATTEMPTS, '同じ体が上限まで出し直し、拒んだ提出ごとに理由が載る')
  for (const x of g.rejected) assert.match(x, /目標の照合.*逐語で無い/)
  assert.match(g.next, /next を流す/)
  const { state: s2 } = setup(t)
  const n2 = cli('next', '--state', s2)
  const rp2 = path.join(s2, 'result-ok.json')
  writeFileSync(rp2, JSON.stringify(await runWorkflow(JSON.parse(readFileSync(n2.args_path, 'utf8')), mockAgent())))
  const ok = cli('ingest', '--state', s2, '--call', n2.call_id, '--result', rp2)
  assert.equal(ok.code, 0)
  assert.equal(ok.rejected, undefined, '受け付けた出力だけなら rejected を載せない')
})

test('上限: やり直しの上限に答えた後にまた上限を超えたら、もう一度 needs_input で人間に返す', async (t) => {
  const s = setup(t, { extra: ['--max-unit-rounds', '1', '--max-cycles', '10'] })
  const audit = (phase) => (phase === 'impl' ? auditStatus({ phase, confirmed: [{ path: path.join(s.repo, 'src/a.mjs'), quote: 'export const value = 2', layer: '実装' }] }) : auditStatus({ phase }))
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

// ---------------- coverage-audit の台帳を 1 つに固定する（計画の 7） ----------------
// CLI が同じ process で coverage-audit の台帳を init・reframe する。置き場の固定・段ごとの reframe・段（--phase）は、検査の台帳（stateDir/audit/state）と段の位置で確かめる。
const AUDIT_STATE = (state) => path.join(state, 'audit', 'state')
const hashDirs = (state) => (existsSync(path.join(state, 'audit')) ? readdirSync(path.join(state, 'audit')).filter((f) => /^(baseline|design|impl|review)-[0-9a-f]+$/.test(f)) : [])
const ledgerFiles = (state) => readdirSync(state, { recursive: true }).map(String).filter((f) => path.basename(f) === 'ledger.json')
// 検査の計画役が担当を取るたびに、coverage-audit の段の位置（段・段の始まり）を残す（検査の 1 回ごとに 1 件）。
const phaseProbe = (state, seen) => ({ plan: () => { seen.push(auditPos(state)); return undefined } })

test('coverage-audit の置き場: 段をまたいでも stateDir/audit/state の 1 つに固定し、hash で分けない', async (t) => {
  const { state } = setup(t, { checks: [OK_CHECK] })
  const seen = []
  const { stop } = await drive(state, mockAgent(), { auditOver: phaseProbe(state, seen) })
  assert.equal(stop.stop, 'complete', JSON.stringify(stop))
  assert.deepEqual(seen.map((x) => x && x.phase), ['design', 'impl'])
  const L = ledger(state)
  for (const p of ['design', 'impl']) assert.equal(L.audits[p].state, AUDIT_STATE(state), `${p}: 台帳の取り込みの記録も同じ置き場`)
  assert.deepEqual(ledgerFiles(state), [path.join('audit', 'state', 'ledger.json')], '検査の台帳は 1 つ')
  assert.deepEqual(hashDirs(state), [], '段と hash の置き場を作らない')
})

test('検査の台帳: 設計レビューで init し、実装レビューは同じ台帳を reframe して段と対象を差し替え、照合済みの印を残す', async (t) => {
  const { state, repo } = setup(t)
  const { stop } = await drive(state, mockAgent())
  assert.equal(stop.stop, 'complete', JSON.stringify(stop))
  const AL = JSON.parse(readFileSync(path.join(AUDIT_STATE(state), 'ledger.json'), 'utf8'))
  assert.equal(AL.phase, 'impl')
  assert.ok(AL.phase_records && AL.phase_records.design, '設計レビューの節を同じ台帳に残す')
  assert.equal(AL.goal.checked_by, 'coverage-build', 'reframe は台帳の照合済みの印を残す')
  assert.deepEqual([...AL.targets].sort(), ['docs/a.md', 'src/a.mjs', 'test/a.test.mjs'].map((f) => path.join(repo, f)).sort(), '対象は今の段（実装）のもの')
})

test('検査の台帳: 現状の検査（baseline）と review でも、その段で検査する', async (t) => {
  for (const mode of ['update', 'review']) {
    const { state } = setup(t, { mode })
    const seen = []
    await drive(state, mockAgent(), { auditOver: phaseProbe(state, seen), maxSteps: 3 })
    assert.ok(seen.length, `${mode}: 検査に進む`)
    assert.equal(seen[0].phase, mode === 'update' ? 'baseline' : 'review', mode)
    assert.deepEqual(ledgerFiles(state), [path.join('audit', 'state', 'ledger.json')])
  }
})

test('answer で制約が足されても、coverage-audit の置き場は増えず、同じ台帳を reframe し、足した制約を渡す', async (t) => {
  const { state } = setup(t, { checks: [['node', '-e', 'process.exit(3)']] })
  const seen = []
  const first = await drive(state, mockAgent(), { auditOver: phaseProbe(state, seen) })
  assert.equal(first.stop.stop, 'needs_input', JSON.stringify(first.stop))
  assert.equal(cli('answer', '--state', state, '--id', first.stop.human[0].id, '--text', 'check を直す').code, 0)
  const n = seen.length
  await drive(state, mockAgent(), { auditOver: phaseProbe(state, seen) })
  const after = seen.slice(n)
  assert.ok(after.some((x) => x.phase === 'design'), '回答の後に設計レビューをやり直す')
  assert.deepEqual(ledgerFiles(state), [path.join('audit', 'state', 'ledger.json')])
  assert.deepEqual(hashDirs(state), [])
  const AL = JSON.parse(readFileSync(path.join(AUDIT_STATE(state), 'ledger.json'), 'utf8'))
  assert.ok(AL.constraints.some((c) => c.text.includes('check を直す')), '足した制約を渡す')
})

// 検査の途中で呼び出しが閉じたときに、次の呼び出しが同じ検査を作り直さずに続けることを確かめる。
test('流し直し: 検査の段の途中で呼び出しが閉じても、次の呼び出しは同じ検査を段の始まりを作り直さずに続け、complete まで進む', async (t) => {
  const { state } = setup(t)
  let pos = null
  // 最初の検査の計画役の波の後で、次の波を起動せずに呼び出しを閉じる。
  const tamper = (ret, entry) => { if (!pos && entry.stage === 'audit:plan') { pos = auditPos(state); return { notes: [] } } return ret }
  const r1 = await driveScript(state, boardAct(), { maxSteps: 1, tamper })
  assert.ok(pos && pos.phase === 'design', JSON.stringify(r1.launches.map((x) => x.stage)))
  let resumed = null
  const r2 = await driveScript(state, boardAct(), { maxSteps: 3, onLaunch: (x) => { if (!resumed && String(x.stage).startsWith('audit:')) resumed = { stage: x.stage, pos: auditPos(state) } } })
  assert.equal(r2.stop && r2.stop.stop, 'complete', JSON.stringify(r2.stop))
  assert.ok(resumed, '次の呼び出しで検査を続ける')
  assert.notEqual(resumed.stage, 'audit:plan', '受理した計画をやり直さない')
  assert.deepEqual(resumed.pos, pos, '段の始まりを作り直さない（同じ段・同じ phase_start）')
})

// 取り込みは CLI の中で、検査の台帳の今の段の status を importAudit に渡す。段ごとの取り込みの規則は importAudit で確かめる。
test('取り込み（importAudit）: その段の status の節だけを取り込み、前の段の節（phases の他の段）の指摘と出来事は取り込まない', (t) => {
  const { state } = setup(t)
  const L = ledger(state)
  const io = { readText: () => 'export const value = 2\n入力を受け取り、決まった値を返す。\n', unitOfPath: () => ({ unit: 'U1', test: false }) }
  const designFinding = { path: path.join(state, 'design', 'U1.md'), quote: '入力を受け取り、決まった値を返す。', layer: '詳細設計', claim: '前の段の指摘' }
  const old = { id: 'E0-9', stage: 'review', kind: 'refuted', text: '前の段の監査の出来事の文' }
  const ev = { id: 'E1-1', stage: 'review', kind: 'refuted', text: '監査の中で退けた指摘の出来事の文' }
  const prev = auditStatus({ phase: 'design', confirmed: [designFinding], events: [old] }).phases.design
  importAudit(L, auditStatus({ phase: 'impl', events: [ev], others: { design: prev } }), 'impl', io)
  assert.ok(!L.events.some((e) => e.kind === 'finding'), '前の段（phases.design）の指摘を実装レビューの指摘として取り込まない')
  assert.ok(L.events.some((e) => e.text.includes(ev.text)), `coverage-audit の出来事を受ける: ${JSON.stringify(L.events.map((e) => e.text))}`)
  assert.ok(!L.events.some((e) => e.text.includes(old.text)), '前の段の節の出来事は受けない')
})

test('create: 受け入れ基準・制約が 0 件なら、目標の id を covers の受け皿にし、方式設計を「covers が空」で拒否しない', async (t) => {
  const { d, repo } = setup(t)
  const state = path.join(d, 'no-cover')
  const init = cli('init', '--state', state, '--mode', 'create', '--repo', repo, '--goal', path.join(d, 'goal.md'), '--request', path.join(d, 'request.md'), '--input', path.join(d, 'material.md'))
  assert.equal(init.code, 0, JSON.stringify(init))
  const log = []
  const over = { architect: (p, o) => archOf(o.inputs, defaultUnits(['G1'])) }
  const { steps } = await drive(state, mockAgent(over, log), { maxSteps: 4 })
  assert.deepEqual(log.find((x) => x.role === 'architect').inputs.cover_ids, ['G1'], '基準・制約が無いときは目標の id が受け皿')
  const L = ledger(state)
  assert.ok(!L.events.some((e) => e.kind === 'rejected_output' && /covers|受け皿|実在しない基準/.test(e.text)), JSON.stringify(L.events))
  assert.deepEqual(L.units.U1.covers, ['G1'])
  assert.ok(order(steps).includes('audit:design'), `設計レビューへ進む: ${order(steps).join(', ')}`)
})

// ---------------- 繰り返しを 2 回で打ち切る（周の上限・振り返りの巡の上限） ----------------
const HERE = path.dirname(new URL(import.meta.url).pathname)

test('繰り返しの既定値: 振り返りの巡の上限は 2、周の上限は 2。巡の上限に達したら、原因に辿られない出来事があっても振り返りを終える', (t) => {
  assert.equal(RETRO_MAX_ROUNDS, 2)
  assert.equal(ledger(setup(t).state).config.max_cycles, 2)
  const L = (rounds) => ({ events: [{ id: 'E1', retro: null }], facts: [], retro: { rounds, dry: 0, due: true } })
  assert.equal(retroConcluded(L(1)), false, '1 巡では終えない')
  assert.equal(retroConcluded(L(2)), true, '2 巡で終える')
})

// 台帳の印（やり直しを当てると変わるもの）。route の前後で比べる。
const marks = (L) => ({
  cycle: L.cycle, need_arch: L.need_arch, arch_rounds: L.arch_rounds, arch_causes: L.arch_causes, checks_run: L.checks_run,
  units: Object.fromEntries(Object.entries(L.units).map(([id, u]) => [id, { need_design: u.need_design, tests_for: u.tests_for, impl_for: u.impl_for, rounds: u.rounds, causes: u.causes }])),
  audits: Object.fromEntries(Object.entries(L.audits).map(([k, a]) => [k, a.imported])),
})
// 止まるまで 1 手ずつ進め、止まる直前の（route を流す next の前の）台帳を返す。
// before は、止まる直前の step を流す前の台帳。route は claim の時点の advance で走るので、最後の波の役の claim の中で
// route が済み、その呼び出しの後の next が止まる。止まる next だけを流した回（step が無い）は、1 つ前の回の前の台帳を before にする。
async function driveToStop(state, agentFn, opts) {
  let prev = null
  for (let i = 0; i < 80; i++) {
    const before = ledger(state)
    const r = await drive(state, agentFn, { ...opts, maxSteps: 1 })
    if (r.stop) return { ...r, before: r.steps.length || !prev ? before : prev }
    prev = before
  }
  throw new Error('止まらない')
}
const implFinding = (s) => (phase) => (phase === 'impl' ? auditStatus({ phase, confirmed: [{ path: path.join(s.repo, 'src/a.mjs'), quote: 'export const value = 2', layer: '実装' }] }) : auditStatus({ phase }))
const designFinding = (s) => (phase) => (phase === 'design' ? auditStatus({ phase, confirmed: [{ path: path.join(s.state, 'design', 'U1.md'), quote: '入力を受け取り、決まった値を返す。', layer: '詳細設計' }] }) : auditStatus({ phase }))
const archFinding = (s) => (phase) => (phase === 'design' ? auditStatus({ phase, confirmed: [{ path: path.join(s.state, 'design', '_architecture.md'), quote: '| U1 計算 | code | 値を計算する |', layer: '方式設計' }] }) : auditStatus({ phase }))
const humanIds = (L) => L.human.map((h) => h.id)

test('周の上限: やり直しを当てると周が上限を超えるとき、当てずに保留し、limit でなく needs_input で cycles#<周> を返す', async (t) => {
  const s = setup(t)
  const r = await driveToStop(s.state, mockAgent(), { audit: implFinding(s) })
  assert.equal(r.stop.stop, 'needs_input', JSON.stringify(r.stop))
  const h = r.stop.human.find((x) => x.id === 'cycles#2')
  assert.ok(h, JSON.stringify(r.stop.human))
  assert.match(h.reason, /2 周で収束しない/)
  assert.match(h.text, /U1/, '待っているやり直しの単位')
  assert.match(h.text, /実装/, '待っているやり直しの層')
  assert.match(h.text, /欠陥/, 'やり直しの原因（出来事の中身）')
  const L = ledger(s.state)
  assert.ok(L.pending_redo, 'やり直しを保留する')
  assert.deepEqual(marks(L), marks(r.before), '単位の印・arch_rounds・L.cycle・L.audits・checks_run は route の前と同じ')
  assert.deepEqual(humanIds(L), ['cycles#2'], 'rounds: など当てるはずだった human 項目は足さず、cycles# だけが増える')
  assert.ok(L.events.every((e) => e.retro), '出来事の retro の印は付ける')
  assert.ok(L.routes.length > r.before.routes.length, 'L.routes の記録は付ける')
  assert.deepEqual(L.retro, { rounds: 0, dry: 0, due: false, open: null }, '振り返りの状態は戻す（戻さないと route をもう一度出す）')
  const again = cli('next', '--state', s.state)
  assert.equal(again.stop, 'needs_input', 'もう一度 next を流しても同じ')
  assert.ok(again.human.some((x) => x.id === 'cycles#2'))
  const L2 = ledger(s.state)
  assert.equal(L2.routes.length, L.routes.length, 'route をもう一度流さない')
  assert.equal(L2.human.length, L.human.length)
  assert.deepEqual(marks(L2), marks(r.before))
})

test('周の上限: 設計の欠陥（単位の設計のやり直し）も、方式設計のやり直しも、当てずに保留する', async (t) => {
  const d = setup(t)
  const rd = await driveToStop(d.state, mockAgent(), { audit: designFinding(d) })
  assert.equal(rd.stop.stop, 'needs_input', JSON.stringify(rd.stop))
  const hd = rd.stop.human.find((x) => x.id === 'cycles#2')
  assert.ok(hd, JSON.stringify(rd.stop.human))
  assert.match(hd.text, /U1/)
  assert.match(hd.text, /設計/)
  assert.deepEqual(marks(ledger(d.state)), marks(rd.before))
  assert.ok(ledger(d.state).pending_redo)

  const a = setup(t)
  const ra = await driveToStop(a.state, mockAgent(), { audit: archFinding(a) })
  assert.equal(ra.stop.stop, 'needs_input', JSON.stringify(ra.stop))
  const ha = ra.stop.human.find((x) => x.id === 'cycles#2')
  assert.ok(ha, JSON.stringify(ra.stop.human))
  assert.match(ha.text, /方式設計|arch/, '方式設計のやり直しだと分かる')
  const La = ledger(a.state)
  assert.equal(La.arch_rounds, 1, '保留したやり直しは arch_rounds を進めない')
  assert.equal(La.need_arch, false)
  assert.deepEqual(marks(La), marks(ra.before))
  assert.ok(La.pending_redo)
})

test('周の上限: config で上限を上げても保留は当てない。answer か dismiss をするまで needs_input のまま', async (t) => {
  const s = setup(t)
  const r = await driveToStop(s.state, mockAgent(), { audit: implFinding(s) })
  assert.equal(r.stop.stop, 'needs_input')
  const c = cli('config', '--state', s.state, '--max-cycles', '10')
  assert.equal(c.code, 0)
  assert.equal(c.config.max_cycles, 10, '上限を上げる経路は残す')
  const n = cli('next', '--state', s.state)
  assert.equal(n.stop, 'needs_input', JSON.stringify(n))
  assert.ok(n.human.some((x) => x.id === 'cycles#2'))
  const L = ledger(s.state)
  assert.ok(L.pending_redo, '保留は消えない')
  assert.deepEqual(marks(L), marks(r.before), '保留は当たらない')
})

test('周の上限: cycles#<周> への answer は保留をそのまま当て、決定の記録・制約に足さず、1 周だけ進む', async (t) => {
  const s = setup(t)
  const r = await driveToStop(s.state, mockAgent(), { audit: implFinding(s) })
  assert.equal(r.stop.stop, 'needs_input')
  const pre = ledger(s.state)
  const a = cli('answer', '--state', s.state, '--id', 'cycles#2', '--text', 'もう 1 周やる')
  assert.equal(a.code, 0, JSON.stringify(a))
  const L = ledger(s.state)
  assert.ok(!L.pending_redo, '保留は消える')
  assert.equal(L.decisions, pre.decisions, '決定の記録に足さない')
  assert.deepEqual(L.constraints, pre.constraints, '制約に足さない')
  assert.equal(L.need_arch, pre.need_arch, '方式設計からやり直さない')
  // 上限を超えない route を流した後と同じ印
  assert.equal(L.cycle, pre.cycle + 1)
  assert.equal(L.units.U1.impl_for, null)
  assert.equal(L.units.U1.rounds, pre.units.U1.rounds + 1)
  assert.equal(L.audits.impl, undefined)
  assert.equal(L.checks_run, null)
  assert.ok(L.units.U1.causes.length > 0)
  // 次の next は実装の段から 1 周だけ進み、直れば完了する
  const done = await drive(s.state, mockAgent(), { audit: (phase) => auditStatus({ phase }) })
  assert.equal(done.steps[0].step, 'implement', JSON.stringify(done.steps.map((x) => x.step)))
  assert.equal(done.stop.stop, 'complete', JSON.stringify(done.stop))
})

test('周の上限: answer の後にまた上限を超えたら、周の番号が違う id で再び needs_input を返す。同じ id に答え直しても上限は増えない', async (t) => {
  const s = setup(t)
  const first = await driveToStop(s.state, mockAgent(), { audit: implFinding(s) })
  assert.ok(first.stop.human.some((x) => x.id === 'cycles#2'))
  assert.equal(cli('answer', '--state', s.state, '--id', 'cycles#2', '--text', 'もう 1 周やる').code, 0)
  const second = await driveToStop(s.state, mockAgent(), { audit: implFinding(s) })
  assert.equal(second.stop.stop, 'needs_input', JSON.stringify(second.stop))
  assert.deepEqual(second.stop.human.map((x) => x.id), ['cycles#3'], '答えた cycles#2 は出さず、次の周の id で返す')
  assert.deepEqual(marks(ledger(s.state)), marks(second.before), '2 周目の保留も当てない')
  assert.ok(ledger(s.state).pending_redo)
  // 同じ id にもう一度答えても、上限は増えず、新しい保留も当たらない
  cli('answer', '--state', s.state, '--id', 'cycles#2', '--text', 'もう一度')
  const L = ledger(s.state)
  assert.deepEqual(marks(L), marks(second.before))
  assert.ok(L.pending_redo)
  const n = cli('next', '--state', s.state)
  assert.equal(n.stop, 'needs_input', JSON.stringify(n))
  assert.ok(n.human.some((x) => x.id === 'cycles#3'))
})

test('周の上限: 上限は max_cycles に answer した cycles# の件数を足したもの（max_cycles を init で上げても同じ式）', async (t) => {
  const s = setup(t, { extra: ['--max-cycles', '3', '--max-unit-rounds', '10'] })
  const first = await driveToStop(s.state, mockAgent(), { audit: implFinding(s) })
  assert.deepEqual(first.stop.human.map((x) => x.id), ['cycles#3'], '3 周まで進んで、4 周目を保留する')
  assert.equal(ledger(s.state).cycle, 3)
  assert.equal(cli('answer', '--state', s.state, '--id', 'cycles#3', '--text', '進める').code, 0)
  assert.equal(ledger(s.state).cycle, 4, '上限が 4 になり、保留は当たる')
  const second = await driveToStop(s.state, mockAgent(), { audit: implFinding(s) })
  assert.deepEqual(second.stop.human.map((x) => x.id), ['cycles#4'], '5 周目は 4 を超えるので保留する')
})

test('周の上限: 保留に rounds: の human 項目も含め、answer で当てたときに足す', async (t) => {
  const s = setup(t, { extra: ['--max-unit-rounds', '1'] })
  const r = await driveToStop(s.state, mockAgent(), { audit: implFinding(s) })
  assert.deepEqual(r.stop.human.map((x) => x.id), ['cycles#2'], '保留の間は rounds: を足さない')
  assert.equal(ledger(s.state).units.U1.rounds, 1)
  assert.equal(cli('answer', '--state', s.state, '--id', 'cycles#2', '--text', '進める').code, 0)
  const L = ledger(s.state)
  assert.equal(L.units.U1.rounds, 2)
  assert.ok(L.human.some((h) => h.id.startsWith('rounds:U1#')), JSON.stringify(L.human))
  const n = cli('next', '--state', s.state)
  assert.equal(n.stop, 'needs_input')
  assert.ok(n.human.some((h) => h.id.startsWith('rounds:U1#')))
})

test('周の上限: cycles#<周> の dismiss は保留を当てずに捨て、上限を増やさず、notes に捨てたやり直しを記録する', async (t) => {
  const s = setup(t)
  const r = await driveToStop(s.state, mockAgent(), { audit: implFinding(s) })
  assert.equal(r.stop.stop, 'needs_input')
  const pre = ledger(s.state)
  const dm = cli('dismiss', '--state', s.state, '--id', 'cycles#2', '--text', 'このまま先へ')
  assert.equal(dm.code, 0, JSON.stringify(dm))
  const L = ledger(s.state)
  assert.ok(!L.pending_redo, '保留は捨てる')
  assert.deepEqual(marks(L), marks(r.before), '台帳は route の前と同じ印')
  assert.equal(L.notes.length, pre.notes.length + 1, 'notes が 1 件増える')
  assert.match(L.notes[L.notes.length - 1], /U1/, '捨てたやり直しの要約（単位）')
  assert.equal(L.decisions, pre.decisions)
  assert.deepEqual(L.constraints, pre.constraints)
  // やり直しの無い段から進む（実装レビューまで済んでいるので完了する）
  const done = await drive(s.state, mockAgent(), { audit: (phase) => auditStatus({ phase }) })
  assert.equal(done.stop.stop, 'complete', JSON.stringify(done.stop))
  assert.equal(done.steps.length, 0)
})

test('周の上限: 設計レビューの欠陥の保留を dismiss したら、設計レビューの取り込みの記録を残し、テストの段から進む', async (t) => {
  const s = setup(t)
  const r = await driveToStop(s.state, mockAgent(), { audit: designFinding(s) })
  assert.equal(r.stop.stop, 'needs_input')
  assert.equal(cli('dismiss', '--state', s.state, '--id', 'cycles#2', '--text', 'このまま先へ').code, 0)
  const L = ledger(s.state)
  assert.ok(L.audits.design, '設計レビューの取り込みの記録は残る')
  assert.deepEqual(marks(L), marks(r.before))
  const n = await drive(s.state, mockAgent(), { audit: (phase) => auditStatus({ phase }), maxSteps: 1 })
  assert.equal(n.steps[0].step, 'tests', JSON.stringify(n.steps.map((x) => x.step)))
})

test('周の上限: dismiss は上限を増やさない。捨てた後にまた超えるやり直しが出たら、もう一度 needs_input で止める', async (t) => {
  const s = setup(t)
  const first = await driveToStop(s.state, mockAgent(), { audit: implFinding(s) })
  assert.equal(first.stop.stop, 'needs_input')
  assert.equal(cli('dismiss', '--state', s.state, '--id', 'cycles#2', '--text', 'このまま先へ').code, 0)
  assert.equal(ledger(s.state).cycle, 2)
  writeFileSync(path.join(s.repo, 'src/a.mjs'), '// 変えた\nexport const value = 2\n') // 実装が変わったので、実装レビューをやり直す
  const second = await driveToStop(s.state, mockAgent(), { audit: implFinding(s) })
  assert.equal(second.stop.stop, 'needs_input', JSON.stringify(second.stop))
  assert.ok(second.stop.human.some((h) => h.id.startsWith('cycles#')), '捨てた id と同じ周でも、新しい保留は未回答として返す')
  const L = ledger(s.state)
  assert.equal(L.cycle, 2, '上限は増えていない')
  assert.ok(L.pending_redo)
})

test('周の上限: 文書（SKILL.md・references/ledger.md）が cycles#<周>・保留・limit の範囲を書く', () => {
  const skill = readFileSync(path.join(HERE, '..', 'SKILL.md'), 'utf8')
  const ledgerDoc = readFileSync(path.join(HERE, '..', 'references', 'ledger.md'), 'utf8')
  assert.match(skill, /cycles#/)
  assert.match(ledgerDoc, /cycles#/)
  assert.match(ledgerDoc, /pending_redo/)
  const limitRow = ledgerDoc.split('\n').find((l) => l.startsWith('| limit |'))
  assert.ok(limitRow, 'limit の行がある')
  assert.ok(!/max_cycles|周/.test(limitRow), `limit の行から周の上限を外す（起動数の上限だけ）: ${limitRow}`)
})

// ---------------- 詰め合わせが 2 つ以上になるとき（UNIT_MAX_BYTES を超える単位） ----------------
test('詰める: 単位のファイルが UNIT_MAX_BYTES を超えると単位の並びで前から詰め合わせを分け（決定的）、起動した体はどれも最初の claim で担当を受け取る。依存がそろわない詰め合わせの体は起動しない', async (t) => {
  const s = setup(t)
  const big = 'x'.repeat(Math.ceil(UNIT_MAX_BYTES * 0.6)) + '\n'
  mkdirSync(path.join(s.repo, 'docs'), { recursive: true })
  writeFileSync(path.join(s.repo, 'src', 'big.mjs'), `// 大きい既にあるファイル\n${big}`)
  writeFileSync(path.join(s.repo, 'docs', 'big.md'), `大きい既にある文書の本文の行\n${big}`)
  const arch = (p, o) => {
    const [u1, u2] = defaultUnits(['AC1', 'D1'])
    return archOf(o.inputs, [{ ...u1, paths: ['src/big.mjs'] }, { ...u2, paths: ['docs/big.md'] }])
  }
  const log = []
  const { stop, steps } = await drive(s.state, mockAgent({ architect: arch }, log))
  assert.equal(stop.stop, 'complete', JSON.stringify(stop))
  const workerOf = (prompt) => /--worker '([^']+)'/.exec(prompt)[1]
  // 1 つの呼び出しが複数の波を流すので、起動は呼び出しと波（--wave）で引く。
  const inStep = (c) => (x) => x.prompt.includes(`--call '${c.args.callId}'`) && (c.args.wave == null || x.prompt.includes(`--wave '${c.args.wave}'`))
  const calls = steps.filter((x) => x.args)
  for (const c of calls) {
    const ids = c.args.workers.map((w) => w.id)
    const used = [...new Set(log.filter(inStep(c)).map((x) => workerOf(x.prompt)))]
    assert.deepEqual(used.sort(), [...ids].sort(), `${c.task}: 起動した体はどれも担当を受け取る（最初の claim が done の体を起こさない）`)
  }
  const spec = calls.find((c) => c.task === 'spec')
  assert.deepEqual(spec.args.workers.map((w) => w.id), ['d1', 'd2'], '詳細設計は 2 つの詰め合わせ')
  assert.deepEqual(log.filter(inStep(spec)).map((x) => [workerOf(x.prompt), x.inputs.unit.id]), [['d1', 'U1'], ['d2', 'U2']], '単位の並びで前から詰める')
  const impl = calls.filter((c) => c.task === 'implement')
  assert.deepEqual(impl.map((c) => c.args.workers.length), [1, 1], '依存のある U2 の詰め合わせは、U1 の実装の後の呼び出しで起動する')
  assert.deepEqual(log.filter((x) => x.role === 'implementer').map((x) => x.inputs.unit.id), ['U1', 'U2'])
})

test('振り返りの実行役: evidence に自分の結果のファイル（stateDir の results）を引いた結論は、引用が合っても受け付けず、上限で判定できずに閉じる（undecided）', async (t) => {
  const { state } = setup(t)
  let n = 0
  const audit = (phase) => (phase === 'impl' && n++ === 0 ? auditStatus({ phase, confirmed: [{ path: path.join(path.dirname(state), 'repo/src/a.mjs'), quote: 'export const value = 2', layer: '実装' }] }) : auditStatus({ phase }))
  const CAUSE = '自分の結果のファイルを引いて通そうとする原因の文'
  const over = {
    'retro-plan': (p, o) => (o.inputs.events.some((e) => e.kind === 'finding') ? { intents: [{ basis: [o.inputs.events[0].id], hypothesis: '自分を引く', layer: '設計', look_at: [o.inputs.readable[0]] }] } : undefined),
    'retro-exam': (p, o) => ({ verdict: 'supported', cause: CAUSE, layer: '設計', evidence: [{ path: o.task.result_path, quote: CAUSE }] }),
  }
  await drive(state, mockAgent(over), { audit })
  const L = ledger(state)
  const it = L.intents.find((x) => x.hypothesis === '自分を引く')
  assert.ok(it, '意図を受ける')
  assert.equal(it.status, 'undecided', JSON.stringify(it))
  assert.match(it.why, /振り返りの読めるファイルの一覧の外/)
  assert.ok(!L.facts.some((f) => f.cause === CAUSE), '原因にしない')
})

// ---------------- 実装レビューの指摘（H1〜H3）の回帰 ----------------
test('H1: 同じ呼び出しで U1 のテストを受理した後、後の担当が U1 のテストのファイルを共有の fixture として直しても、実装の照合は呼び出しの終わりの中身で行い stuck にしない', async (t) => {
  const s = setup(t)
  const arch = (p, o) => archOf(o.inputs, defaultUnits(['AC1', 'D1']).map((u) => (u.id === 'U2' ? { ...u, kind: 'code', paths: ['src/b.mjs'], tests: ['test/b.test.mjs'], depends_on: [] } : u)))
  const over = {
    architect: arch,
    'tests-U2': (p, o) => {
      // U1 を先に出して受理させてから、U1 のテストのファイルを fixture として直す。
      // 提出の口は prompt の claim の命令の --call・--worker から作る（台帳の pending の形に依らない）。
      const call = /--call '([^']+)'/.exec(p)[1]
      const w = /--worker '([^']+)'/.exec(p)[1]
      const r1 = cli('submit', '--state', s.state, '--call', call, '--worker', w)
      assert.ok(r1.results.some((x) => x.task === 'tests:U1' && x.ok), JSON.stringify(r1))
      writeFileSync(path.join(s.repo, 'test/a.test.mjs'), '// 共有の fixture を直した\nexport const value = 2\n')
      return undefined
    },
  }
  const { stop } = await drive(s.state, mockAgent(over))
  assert.equal(stop.stop, 'complete', JSON.stringify(stop))
  assert.ok(!ledger(s.state).events.some((e) => e.kind === 'rejected_output'), JSON.stringify(ledger(s.state).events))
})

const implFindingOnce = (state) => { let n = 0; return (phase) => (phase === 'impl' && n++ === 0 ? auditStatus({ phase, confirmed: [{ path: path.join(path.dirname(state), 'repo/src/a.mjs'), quote: 'export const value = 2', layer: '実装' }] }) : auditStatus({ phase })) }
const supportedExam = (state) => ({ verdict: 'supported', cause: '設計が値を決めていない', layer: '進め方', evidence: [{ path: path.join(state, 'design', 'U1.md'), quote: '入力を受け取り、決まった値を返す。' }] })
const planTwo = (p, o) => (o.inputs.events.some((e) => e.kind === 'finding') ? { intents: [0, 1].map((i) => ({ basis: [o.inputs.events[0].id], hypothesis: `仮説 ${i}`, layer: '進め方', look_at: ['x'] })) } : undefined)

test('H2: 環境の失敗（実行役が手を付けて提出せずに返る）が続いて閉じた意図は undecided（退けたのではない）になり、blocked（failure）から再開すると待ちに戻って確かめ直す', async (t) => {
  const { state } = setup(t)
  // fail_streak は呼び出し全体で数える（前の波に進みのある呼び出しは数えない）。環境の失敗が続く形として、
  // 計画役が意図を出した後は、実行役と計画役の両方が手を付けて提出せずに返る（進みの無い呼び出しが続く）。
  let fail = true
  let planned = false
  const agent = mockAgent({
    'retro-plan': (p, o) => { if (fail && planned) return null; const r = planTwo(p, o); if (r) planned = true; return r },
    'retro-exam': () => (fail ? null : supportedExam(state)),
  })
  const audit = implFindingOnce(state)
  const first = await drive(state, agent, { audit })
  assert.equal(first.stop.stop, 'blocked', JSON.stringify(first.stop))
  assert.equal(first.stop.cause, 'failure')
  const its = ledger(state).intents.filter((i) => i.hypothesis.startsWith('仮説'))
  assert.deepEqual(its.map((i) => i.status), ['undecided', 'undecided'], '判定できずに閉じた意図は rejected・refuted と区別する')
  fail = false
  const second = await drive(state, agent, { audit })
  assert.equal(second.stop.stop, 'complete', JSON.stringify(second.stop))
  const L = ledger(state)
  assert.deepEqual(L.intents.filter((i) => i.hypothesis.startsWith('仮説') && i.cycle === 1).map((i) => i.status), ['accepted', 'accepted'], '再開で環境の失敗の分を戻し、確かめ直す')
})

test('H2: 時間の上限で手を付けずに終わった意図の担当は試行に数えず、次の呼び出しで渡す', async (t) => {
  const { state } = setup(t)
  const base = mockAgent({ 'retro-plan': planTwo, 'retro-exam': () => supportedExam(state) })
  let cut = true
  // 実行役の 1 体目は、最初の担当だけを出して返る（時間の上限に当たった体）。
  const agent = async (prompt, opts) => {
    if (!cut || !String(opts.label).startsWith('retro_examiner-')) return base(prompt, opts)
    cut = false
    const line = prompt.split('\n').find((l) => l.includes('build-cli.mjs') && / claim /.test(l))
    const argv = [...line.matchAll(/'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2])
    const c = cli(...argv.slice(argv.indexOf('claim')))
    const task = c.tasks[0]
    // query と submit は --state・--call・--worker だけ（claim の --wave・--model・--effort・--stage を渡さない）。
    const who = ['state', 'call', 'worker'].flatMap((k) => [`--${k}`, argv[argv.indexOf(`--${k}`) + 1]])
    cli('query', ...who, '--task', task.id)
    mkdirSync(path.dirname(task.result_path), { recursive: true })
    writeFileSync(task.result_path, JSON.stringify(supportedExam(state)))
    cli('submit', ...who)
    return null
  }
  const { stop } = await drive(state, agent, { audit: implFindingOnce(state) })
  assert.equal(stop.stop, 'complete', JSON.stringify(stop))
  const its = ledger(state).intents.filter((i) => i.hypothesis.startsWith('仮説') && i.cycle === 1 && i.round === 1)
  assert.deepEqual(its.map((i) => [i.status, i.tries || 0]), [['accepted', 0], ['accepted', 0]], '手を付けなかった担当は試行に数えず、次の呼び出しで確かめる')
})

test('H3: 書かない段（詳細設計）の役が単位のテストと実装のファイルを書いても受理せず、書く段の担当が書き直すまでテストと実装を受け付けない', async (t) => {
  const s = setup(t)
  const DESIGNER = '// 詳細設計の役が書いた中身\n'
  const writeBoth = (p, o) => {
    if (o.inputs.unit.id === 'U1') for (const f of ['test/a.test.mjs', 'src/a.mjs']) { mkdirSync(path.dirname(path.join(s.repo, f)), { recursive: true }); writeFileSync(path.join(s.repo, f), DESIGNER) }
    return undefined
  }
  // 書く段の担当が書き直す: 既定の偽物が書き直して完了する。
  const ok = await drive(s.state, mockAgent({ design: writeBoth }))
  assert.equal(ok.stop.stop, 'complete', JSON.stringify(ok.stop))
  assert.ok(ledger(s.state).events.some((e) => e.kind === 'write_outside' && e.stage === 'design'))
  for (const f of ['test/a.test.mjs', 'src/a.mjs']) assert.notEqual(readFileSync(path.join(s.repo, f), 'utf8'), DESIGNER, `${f} は書く段の担当が書き直した`)
  // 書く段の担当が書き直さない: 詳細設計の役の中身のまま受理しない（試行の上限で stuck）。
  const s2 = setup(t)
  const lazy = (p, o) => ({ unit_id: o.inputs.unit.id, written: o.inputs.paths, notes: '', unresolved: [] })
  const r = await drive(s2.state, mockAgent({ design: (p, o) => { if (o.inputs.unit.id === 'U1') for (const f of ['test/a.test.mjs', 'src/a.mjs']) { mkdirSync(path.dirname(path.join(s2.repo, f)), { recursive: true }); writeFileSync(path.join(s2.repo, f), DESIGNER) } return undefined }, 'tests-U1': lazy }))
  assert.equal(r.stop.stop, 'needs_input', JSON.stringify(r.stop))
  assert.ok(r.stop.stuck.includes('tests:U1'), JSON.stringify(r.stop))
  assert.equal(ledger(s2.state).units.U1.tests_for, null)
})

test('H3: 方式設計の役が、新しく単位に持たせるテストと実装のファイルを書いてから設計を出しても、書く段の担当が書き直すまで受理しない（既にあったファイルは対象にしない）', async (t) => {
  const ARCH = '// 方式設計の役が書いた中身\n'
  const archWriting = (repo) => (p, o) => {
    for (const f of ['src/a.mjs', 'test/a.test.mjs', 'docs/a.md']) { mkdirSync(path.dirname(path.join(repo, f)), { recursive: true }); writeFileSync(path.join(repo, f), ARCH) }
    return archOf(o.inputs)
  }
  const lazy = (p, o) => ({ unit_id: o.inputs.unit.id, written: o.inputs.paths, notes: '', unresolved: [] })
  // 書く段の担当が書き直さない: 中身のまま受理しない。
  const s = setup(t)
  const r = await drive(s.state, mockAgent({ architect: archWriting(s.repo), tests: lazy, implement: lazy }))
  assert.equal(r.stop.stop, 'needs_input', JSON.stringify(r.stop))
  assert.ok(r.stop.stuck.includes('tests:U1'), JSON.stringify(r.stop))
  const L = ledger(s.state)
  assert.deepEqual([...L.units.U1.tainted].sort(), ['src/a.mjs', 'test/a.test.mjs'])
  assert.ok(L.events.some((e) => e.kind === 'write_outside' && e.stage === 'design' && e.unit === 'U1'))
  // 書く段の担当が書き直す: 完了し、ファイルは書く段の担当の中身。
  const s2 = setup(t)
  const ok = await drive(s2.state, mockAgent({ architect: archWriting(s2.repo) }))
  assert.equal(ok.stop.stop, 'complete', JSON.stringify(ok.stop))
  for (const f of ['src/a.mjs', 'test/a.test.mjs', 'docs/a.md']) assert.notEqual(readFileSync(path.join(s2.repo, f), 'utf8'), ARCH, f)
  assert.ok(Object.values(ledger(s2.state).units).every((u) => !(u.tainted || []).length))
  // 呼び出しを開く前からあったファイルを単位に持たせても tainted にしない（update の対象など）。
  const s3 = setup(t, { mode: 'update' })
  const keep = (p, o) => { const us = defaultUnits(['AC1', 'D1']); us[1].paths = ['src/old.mjs']; return archOf(o.inputs, us) }
  const r3 = await drive(s3.state, mockAgent({ architect: keep }))
  assert.equal(r3.stop.stop, 'complete', JSON.stringify(r3.stop))
  assert.ok(!ledger(s3.state).events.some((e) => e.kind === 'write_outside'))
})
