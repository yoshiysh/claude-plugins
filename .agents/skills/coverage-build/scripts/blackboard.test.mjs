// coverage-build の自分の Workflow を台帳（ブラックボード）の形にするテスト（計画 glimmering-squishing-moonbeam の「決めること」9〜12）。
// 設計の箇所: docs/design/coverage-ledger-method.md「台帳と見たの記録」（B1〜B6 と「coverage-build の自分の Workflow にも当てる」）、
// 「役と制御の境界」、「モデルと費用」（起動の原則）。
// 役の偽物・結果の形・CLI の argv は board-fixture.mjs の 1 か所に置く。起動の数は、本物の Workflow source が起動した役の記録で数える。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { MAX_ATTEMPTS } from './build-core.mjs'
import {
  ALL_ROLES, ROLES, STAGE_ROLES, act, archResult, auditWithEvent, cli, driveScript, examResult, roleCounts, setup, specResult, stageOfRole, tasksOf, unitEvents, verdictsOf,
} from './board-fixture.mjs'

const ledgerText = (state) => readFileSync(path.join(state, 'build.json'), 'utf8')
const status = (state) => cli('status', '--state', state)
const callsWith = (steps, role) => steps.filter((s) => s.args && (s.args.workers || []).some((w) => w.role === role))
// 小さい対象を complete まで回す（振り返りを 1 回起こす）。
async function smallRun(t, over = {}, { mode = 'create', audit = auditWithEvent() } = {}) {
  const s = setup(t, { mode })
  const r = await driveScript(s.state, act({ plan: { n: 2 }, ...over }), { audit })
  return { ...s, ...r }
}
const stopOf = (r) => JSON.stringify(r.stop).slice(0, 600)

// ---------------- 全体の起動数 ----------------

test('起動数: 小さい対象（code 2・doc 1、依存なし）を complete まで回すと、design は goal_checker・architect・unit_designer が各 1、tests は test_writer 1、implement は implementer 1、retro は planner・examiner・verifier が各 1', async (t) => {
  const r = await smallRun(t)
  assert.equal(r.stop && r.stop.stop, 'complete', stopOf(r))
  assert.deepEqual(roleCounts(r.launches), Object.fromEntries(ALL_ROLES.map((x) => [x, 1])), `役ごとの起動: ${JSON.stringify(roleCounts(r.launches))}`)
  const recorded = (status(r.state).calls || []).reduce((n, c) => n + c.agents, 0)
  assert.equal(recorded, r.launches.length, '台帳の起動の記録（calls）も同じ数')
})

// ---------------- 9. 台帳の規則（B1〜B6） ----------------

test('9. B4 args: どの呼び出しの args もちょうど {state, callId, stage, workers}。workers の行は {id, role, model, effort} で、model・effort は roles.json の役の値。1 つの呼び出しの役は 1 つの段に属す', async (t) => {
  const r = await smallRun(t)
  const calls = r.steps.filter((s) => s.args)
  assert.ok(calls.length > 0, stopOf(r))
  for (const s of calls) {
    assert.deepEqual(Object.keys(s.args).sort(), ['callId', 'stage', 'state', 'workers'], `args に束の参照・id の一覧・argsSum を載せない（${s.step}）: ${Object.keys(s.args).join(', ')}`)
    assert.equal(s.args.state, r.state)
    assert.equal(s.args.callId, s.next.call_id)
    assert.ok(Array.isArray(s.args.workers) && s.args.workers.length > 0, `${s.step}: workers が空`)
    for (const w of s.args.workers) {
      assert.deepEqual(Object.keys(w).sort(), ['effort', 'id', 'model', 'role'], JSON.stringify(w))
      assert.ok(ROLES[w.role], `roles.json に無い役: ${w.role}`)
      assert.deepEqual([w.model, w.effort], [ROLES[w.role].model, ROLES[w.role].effort], w.role)
    }
    assert.equal(new Set(s.args.workers.map((w) => w.id)).size, s.args.workers.length, 'worker の id は重ならない')
    assert.equal(new Set(s.args.workers.map((w) => stageOfRole(w.role))).size, 1, `1 つの呼び出しに段をまたぐ役を置かない: ${s.args.workers.map((w) => w.role)}`)
  }
  assert.equal(r.stop && r.stop.stop, 'complete', stopOf(r))
})

test('9. B3 返り値: Workflow の返り値はちょうど {agents, tokens}。script は args の workers の行ごとにちょうど 1 体を起動し、行と同じ役で記録する', async (t) => {
  const r = await smallRun(t)
  const calls = r.steps.filter((s) => s.args)
  assert.ok(calls.length > 0, stopOf(r))
  for (const s of calls) {
    assert.deepEqual(Object.keys(s.res || {}).sort(), ['agents', 'tokens'], `返り値に役の出力を載せない（${s.step}）: ${Object.keys(s.res || {}).join(', ')}`)
    const rows = (s.args.workers || []).map((w) => w.role).sort()
    assert.deepEqual(s.launches.map((l) => l.role).sort(), rows, `起動は args の行のとおり（${s.step}）。script が照合・やり直し・役を選ばない`)
    assert.deepEqual(s.res.agents.map((a) => a.role).sort(), rows, `${s.step}: agents の記録`)
    for (const a of s.res.agents) assert.deepEqual(Object.keys(a).sort(), ['effort', 'label', 'model', 'ok', 'role'], JSON.stringify(a))
  }
  assert.equal(r.stop && r.stop.stop, 'complete', stopOf(r))
})

test('9. CLI の claim・query・submit: 開いた呼び出しで claim は担当（id・result_path）と submit_cmd を返し、query は担当の入力を返し、submit は担当ごとの判定を返す。閉じた呼び出しの claim は終了状態 2 で台帳を変えない', async (t) => {
  const { state } = setup(t)
  const n = cli('next', '--state', state)
  assert.equal(n.code, 0, JSON.stringify(n))
  const args = JSON.parse(readFileSync(n.args_path, 'utf8'))
  const w = (args.workers || [])[0]
  assert.ok(w, `args に workers の行が無い: ${Object.keys(args)}`)
  const c = cli('claim', '--state', state, '--call', args.callId, '--worker', w.id)
  assert.equal(c.code, 0, JSON.stringify(c))
  assert.ok(Array.isArray(c.tasks) && c.tasks.length > 0, JSON.stringify(c))
  for (const task of c.tasks) { assert.equal(typeof task.id, 'string'); assert.equal(typeof task.result_path, 'string') }
  assert.match(String(c.submit_cmd), /build-cli\.mjs.*submit/)
  const q = cli('query', '--state', state, '--call', args.callId, '--worker', w.id, '--task', c.tasks[0].id)
  assert.equal(q.code, 0, JSON.stringify(q))
  assert.ok(q.inputs && typeof q.inputs === 'object', JSON.stringify(q))
  const s = cli('submit', '--state', state, '--call', args.callId, '--worker', w.id)
  assert.equal(s.code, 0, JSON.stringify(s))
  assert.ok(Array.isArray(s.results) || Array.isArray(s.missing), JSON.stringify(s))
  // 呼び出しを閉じた後の書き込み（遅れて届いたもの）。
  const f = path.join(state, 'result-close.json')
  writeFileSync(f, JSON.stringify({ agents: [], tokens: null }))
  const g = cli('ingest', '--state', state, '--call', args.callId, '--result', f)
  assert.equal(g.code, 0, JSON.stringify(g))
  const before = ledgerText(state)
  const late = cli('claim', '--state', state, '--call', args.callId, '--worker', w.id)
  assert.equal(late.code, 2, `閉じた呼び出しの claim は拒む: ${JSON.stringify(late)}`)
  assert.equal(ledgerText(state), before, '台帳を変えない')
})

test('9. B3・B5 ingest は呼び出しを閉じるだけ: 返り値に役の出力（goal_check・arch・specs・results・exams）を詰めても台帳の単位・目標の照合・事実は変わらない。違う --call は終了状態 2 で台帳を変えない', async (t) => {
  const { state, d } = setup(t)
  const n = cli('next', '--state', state)
  assert.equal(n.code, 0, JSON.stringify(n))
  const args = JSON.parse(readFileSync(n.args_path, 'utf8'))
  const callId = args.callId || n.call_id
  const wrong = path.join(state, 'result-wrong.json')
  writeFileSync(wrong, JSON.stringify({ agents: [], tokens: null }))
  const before = ledgerText(state)
  const w = cli('ingest', '--state', state, '--call', `${callId}x`, '--result', wrong)
  assert.equal(w.code, 2, JSON.stringify(w))
  assert.equal(ledgerText(state), before, '違う --call は台帳を変えない')
  // 正しい --call と {agents, tokens} の形は受ける。
  const stuffed = path.join(state, 'result-stuffed.json')
  const arch = archResult({ input_paths: [path.join(d, 'material.md')], cover_ids: ['AC1', 'D1'] })
  writeFileSync(stuffed, JSON.stringify({
    agents: [], tokens: null, stage: args.stage, call_id: callId,
    goal_check: { result: { outcomes: [{ outcome: '依頼の全体', quotes: [{ source: 'request', quote: '値を計算する関数を作り、使い方を書いてほしい' }], items: ['G1', 'AC1', 'D1'] }] }, problems: [] },
    arch: { result: arch, problems: [] }, specs: [], results: [], exams: [],
  }))
  const before2 = status(state)
  const g = cli('ingest', '--state', state, '--call', callId, '--result', stuffed)
  if (g.code === 0) {
    const after = status(state)
    assert.deepEqual(after.units, before2.units, '返り値の方式設計で単位を作らない')
    assert.equal(after.goal_checked, before2.goal_checked, '返り値の目標の照合を取り込まない')
    assert.deepEqual(after.facts, before2.facts)
  } else assert.equal(g.code, 2, JSON.stringify(g))
  // 呼び出しが閉じても役が台帳に何も書いていないので、次の next は同じ仕事を開く。その呼び出しは {agents, tokens} の形で閉じられる。
  const n2 = cli('next', '--state', state)
  assert.equal(n2.code, 0, JSON.stringify(n2))
  assert.ok(!n2.stop, JSON.stringify(n2))
  const clean = path.join(state, 'result-clean.json')
  writeFileSync(clean, JSON.stringify({ agents: [], tokens: null }))
  const g2 = cli('ingest', '--state', state, '--call', JSON.parse(readFileSync(n2.args_path, 'utf8')).callId || n2.call_id, '--result', clean)
  assert.equal(g2.code, 0, `ingest は --call と {agents, tokens} を受ける: ${JSON.stringify(g2)}`)
  assert.equal(status(state).goal_checked, false)
})

// update で回し、目標・依頼文・入力と対象の本文・前の役の出力が、役の prompt と args に無いことを見る。
const MARK_ARCH = 'MARK-ARCH-方式設計の役が決めた責務'
const MARK_PLAN = 'MARK-PLAN-振り返りの計画役の仮説'
const MARK_EXAM = 'MARK-EXAM-振り返りの実行役の結論'
const markedOver = {
  arch: { patch: (us) => us.map((u, i) => (i === 0 ? { ...u, responsibility: MARK_ARCH } : u)) },
  plan: { n: 2, hypothesis: (i) => `${MARK_PLAN} ${i + 1}` },
  exam: { cause: MARK_EXAM },
}
const EMBEDDED = {
  目標: '値を計算する関数と、その使い方の文書',
  依頼文: '値を計算する関数を作り、使い方を書いてほしい',
  入力の本文: '材料の本文の行。値は入力に 1 を足して返す。',
  対象の本文: '既にあるファイルの本文の行',
  方式設計の出力: MARK_ARCH,
  計画役の意図: MARK_PLAN,
  実行役の結論: MARK_EXAM,
}

test('9. B1 埋め込まない: 役の prompt と args に、目標・依頼文・本文・前の役の出力（方式設計・計画役の意図・実行役の結論）が無く、prompt は claim の命令を持つ', async (t) => {
  const r = await smallRun(t, markedOver, { mode: 'update' })
  assert.equal(r.stop && r.stop.stop, 'complete', stopOf(r))
  assert.ok(r.launches.length > 0)
  for (const l of r.launches) {
    assert.ok(l.claim, `役の prompt に build-cli.mjs claim の命令が無い: ${l.label}`)
    for (const [what, text] of Object.entries(EMBEDDED)) assert.ok(!String(l.prompt).includes(text), `${l.label} の prompt に${what}を埋め込まない`)
  }
  for (const s of r.steps.filter((x) => x.argsText)) for (const [what, text] of Object.entries(EMBEDDED)) assert.ok(!s.argsText.includes(text), `${s.step} の args に${what}を載せない`)
})

test('9. B1 台帳から引く: 前の役の出力は次の役の query に出る（方式設計 → 詳細設計、計画役の意図 → 実行役、実行役の結論 → 検証役）', async (t) => {
  const r = await smallRun(t, markedOver)
  assert.equal(r.stop && r.stop.stop, 'complete', stopOf(r))
  const queried = (role) => JSON.stringify(r.launches.filter((l) => l.role === role).flatMap((l) => (l.rec ? l.rec.queries.map((q) => q.out) : [])))
  assert.ok(queried('unit_designer').includes(MARK_ARCH), '詳細設計の役の query に方式設計の単位の定義が出る')
  assert.ok(queried('retro_examiner').includes(MARK_PLAN), '実行役の query に計画役の意図が出る')
  assert.ok(queried('retro_verifier').includes(MARK_PLAN) && queried('retro_verifier').includes(MARK_EXAM), '検証役の query に意図と実行役の結論が出る')
})

test('9. 検証役の起動は CLI が next で決める: 実行役の結論が全て unclear なら検証役の行を持つ呼び出しは開かない', async (t) => {
  const r = await smallRun(t, { exam: { verdict: 'unclear' } })
  assert.equal(r.stop && r.stop.stop, 'complete', stopOf(r))
  assert.ok((roleCounts(r.launches).retro_examiner || 0) >= 1, `実行役は起動する: ${JSON.stringify(roleCounts(r.launches))}`)
  assert.equal(callsWith(r.steps, 'retro_verifier').length, 0, '支持された結論が無いので検証役を起動しない')
})

test('9. 検証役の起動は CLI が next で決める: 2 件の意図のうち 1 件だけが supported なら、検証役の行を持つ呼び出しは 1 つで、検証役はその 1 件だけを取る', async (t) => {
  const r = await smallRun(t, { plan: { n: 2, hypothesis: (i) => (i === 0 ? '支持される仮説' : '決まらない仮説') }, exam: (q) => (String(q.intent && q.intent.hypothesis).startsWith('支持') ? {} : { verdict: 'unclear' }) })
  assert.equal(r.stop && r.stop.stop, 'complete', stopOf(r))
  const calls = callsWith(r.steps, 'retro_verifier')
  assert.equal(calls.length, 1, `検証役の呼び出し: ${calls.length}`)
  const verifiers = r.launches.filter((l) => l.role === 'retro_verifier')
  assert.equal(verifiers.length, 1)
  assert.equal(tasksOf(verifiers[0]).length, 1, `検証役が取る担当は supported の 1 件だけ: ${JSON.stringify(tasksOf(verifiers[0]))}`)
})

// ---------------- 10. やり直しで起動しない ----------------

// 最初の提出（ctx.attempt が 1）だけ静的な照合に落ちる役の偽物。2 回目からは既定の結果（undefined）。
const BAD_FIRST = {
  architect: { why: 'code の単位の tests が空', bad: (q) => archResult(q, { patch: (us) => us.map((u) => (u.kind === 'code' ? { ...u, tests: [] } : u)) }) },
  unit_designer: { why: 'acceptance が空', bad: (q) => ({ ...specResult(q), acceptance: [] }) },
  retro_examiner: { why: 'evidence の引用が本文に無い', bad: (q) => ({ ...examResult(q), evidence: [{ path: q.intent.look_at[0], quote: 'この文は読んだファイルのどこにも無い文である' }] }) },
}

for (const [role, b] of Object.entries(BAD_FIRST)) {
  test(`10. やり直し（${role}）: 照合に落ちた提出（${b.why}）は submit が理由を付けて拒み、同じ体が直して出し直す。その役の起動は 1 体で、やり直しの起動は無い`, async (t) => {
    const over = { [role]: (q, task, ctx) => (ctx.attempt === 1 ? b.bad(q) : undefined) }
    const r = await smallRun(t, over)
    assert.equal(r.stop && r.stop.stop, 'complete', stopOf(r))
    const mine = r.launches.filter((l) => l.role === role)
    const rejected = mine.flatMap((l) => tasksOf(l).map((x) => ({ l, x, v: verdictsOf(l, x.id) }))).filter((y) => y.v.some((v) => !v.ok))
    assert.ok(rejected.length > 0, `submit が拒んだ提出が無い（照合を submit で行う）: ${JSON.stringify(mine.map((l) => l.rec && l.rec.submits.map((s) => s.out)))}`)
    for (const { l, x, v } of rejected) {
      assert.ok(v[0] && !v[0].ok && v[0].problems.length > 0, `最初の提出は理由つきで拒む: ${JSON.stringify(v)}`)
      assert.ok(v.some((y) => y.ok), `同じ体（${l.worker}）が出し直して受理される: ${JSON.stringify(v)}`)
      const holders = r.launches.filter((o) => tasksOf(o).some((y) => y.id === x.id))
      assert.equal(holders.length, 1, `拒まれた担当を取ったのは 1 体だけ: ${holders.map((o) => o.label)}`)
    }
    assert.ok(r.launches.every((l) => !String(l.label).includes('やり直し')), `やり直しの起動: ${r.launches.map((l) => l.label)}`)
    if (role === 'retro_examiner') assert.equal(mine.length, roleCounts(r.launches).retro_planner, '振り返りの巡ごとに実行役は 1 体')
    else {
      const clean = await smallRun(t)
      const pick = (c) => Object.fromEntries(STAGE_ROLES.design.map((x) => [x, c[x] || 0]))
      assert.deepEqual(pick(roleCounts(r.launches)), pick(roleCounts(clean.launches)), 'design の起動数はやり直しで増えない')
      assert.equal(mine.length, 1)
    }
  })
}

test(`10. 試行の上限: 落ち続ける方式設計の提出は MAX_ATTEMPTS（${MAX_ATTEMPTS}）回で諦め（dropped）、未完了として needs_input で開示する。方式設計の役の起動は 1 体のまま`, async (t) => {
  const bad = (q) => archResult(q, { patch: (us) => us.map((u) => (u.kind === 'code' ? { ...u, tests: [] } : u)) })
  const r = await smallRun(t, { architect: bad })
  assert.equal(r.stop && r.stop.stop, 'needs_input', stopOf(r))
  assert.match(JSON.stringify(r.stop.stuck || r.stop), /arch/, `開示に方式設計が出る: ${stopOf(r)}`)
  const arch = r.launches.filter((l) => l.role === 'architect')
  assert.equal(arch.length, 1, `方式設計の役の起動: ${arch.length}`)
  const v = tasksOf(arch[0]).flatMap((x) => verdictsOf(arch[0], x.id))
  assert.equal(v.filter((x) => !x.ok).length, MAX_ATTEMPTS, `拒んだ提出の数: ${JSON.stringify(v)}`)
  assert.ok(v.at(-1) && v.at(-1).dropped, `上限の提出は dropped: ${JSON.stringify(v)}`)
})

// ---------------- 11. 詰める ----------------

test('11. 詰める: 詳細設計・テスト・実装の役は、それぞれ 1 体が全ての単位を取る（テストは code の単位だけ）。テストの役と実装の役は別の体で、実装はテストの受理の後', async (t) => {
  const r = await smallRun(t)
  assert.equal(r.stop && r.stop.stop, 'complete', stopOf(r))
  const units = (role) => r.launches.filter((l) => l.role === role).map((l) => tasksOf(l).map((x) => x.unit).sort())
  assert.deepEqual(units('unit_designer'), [['U1', 'U2', 'U3']], '詳細設計は 1 体が 3 単位')
  assert.deepEqual(units('test_writer'), [['U1', 'U2']], 'テストは 1 体が code の 2 単位')
  assert.deepEqual(units('implementer'), [['U1', 'U2', 'U3']], '実装は 1 体が 3 単位')
  const tw = r.launches.filter((l) => l.role === 'test_writer')
  const im = r.launches.filter((l) => l.role === 'implementer')
  for (const a of tw) for (const b of im) assert.ok(a !== b && `${a.call}/${a.worker}` !== `${b.call}/${b.worker}`, 'テストの役と実装の役は別の体')
  // 書いてよい path（query の inputs.paths）: テストの役はテストのファイルだけ、実装の役は成果物のファイルだけ。
  const pathsOf = (ls) => ls.flatMap((l) => (l.rec ? l.rec.queries.flatMap((q) => (q.out && q.out.inputs && q.out.inputs.paths) || []) : []))
  assert.deepEqual(pathsOf(tw).sort(), ['test/a.test.mjs', 'test/b.test.mjs'])
  assert.deepEqual(pathsOf(im).sort(), ['docs/a.md', 'src/a.mjs', 'src/b.mjs'])
  for (const u of ['U1', 'U2']) {
    const tests = unitEvents(r.launches, 'test_writer', u)
    const impl = unitEvents(r.launches, 'implementer', u)
    assert.ok(tests.accepted !== null && impl.claimed !== null && impl.claimed > tests.accepted, `${u} の実装はテストの受理の後に渡す: ${JSON.stringify({ tests, impl })}`)
  }
})

test('11. 依存の順: U2 が U1 に依存するなら、U2 の実装の担当は U1 の実装の受理の後にだけ渡す。実装の呼び出しはどれも実装の役 1 体', async (t) => {
  const r = await smallRun(t, { arch: { units: 'chain' } })
  assert.equal(r.stop && r.stop.stop, 'complete', stopOf(r))
  const u1 = unitEvents(r.launches, 'implementer', 'U1')
  const u2 = unitEvents(r.launches, 'implementer', 'U2')
  assert.ok(u1.accepted !== null && u2.claimed !== null && u2.claimed > u1.accepted, `依存がそろった単位だけを渡す: ${JSON.stringify({ u1, u2 })}`)
  for (const s of callsWith(r.steps, 'implementer')) assert.equal(s.args.workers.length, 1, '実装の呼び出しの行は 1 つ')
  assert.ok((roleCounts(r.launches).implementer || 0) <= 2, `実装の役の起動は依存の段の数まで: ${roleCounts(r.launches).implementer}`)
})

test('11. 詰める（振り返り）: 計画役の 2 件の意図を実行役 1 体が両方取り、支持された 2 件の結論を検証役 1 体が両方取る', async (t) => {
  const r = await smallRun(t)
  assert.equal(r.stop && r.stop.stop, 'complete', stopOf(r))
  const ex = r.launches.filter((l) => l.role === 'retro_examiner')
  const vf = r.launches.filter((l) => l.role === 'retro_verifier')
  assert.equal(ex.length, 1)
  assert.equal(vf.length, 1)
  assert.equal(tasksOf(ex[0]).length, 2, '実行役は 2 件の意図を取る')
  assert.equal(tasksOf(vf[0]).length, 2, '検証役は 2 件の結論を取る')
  assert.notEqual(`${ex[0].call}/${ex[0].worker}`, `${vf[0].call}/${vf[0].worker}`, '実行役と検証役は別の体')
  assert.equal((status(r.state).facts || []).length, 2, '受理した原因は 2 件')
})

// ---------------- 12. モデル ----------------

test('12. roles.json: 8 つの役があり、Opus / high の役が無い。テストを書く役と実装する役、振り返りの実行役と検証役は別のモデル', () => {
  for (const x of ALL_ROLES) assert.ok(ROLES[x] && ROLES[x].model && ROLES[x].effort && ROLES[x].why, `roles.json に ${x} が無い`)
  for (const [k, v] of Object.entries(ROLES)) assert.ok(!(v.model === 'opus' && v.effort === 'high'), `Opus / high の役: ${k}`)
  assert.notEqual(ROLES.test_writer.model, ROLES.implementer.model)
  assert.notEqual(ROLES.retro_examiner.model, ROLES.retro_verifier.model)
})
