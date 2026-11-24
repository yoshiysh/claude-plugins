// 単位 5 のテスト: 呼ぶ側（coverage-build）が段ごとの観点を coverage-audit に渡す（設計「既存のスキルへの組み込み」の渡すもの: 観点の中身）。
// reframe の --lenses で利用者の観点が差し替わり、観点の組の版が変わって単位が読み直しになる。
// あわせて、再レビューの記録（設計「再レビューと持ち越し」「完了と止める条件」「測り方」）: 持ち越した読みの印と数、指摘の出どころの分類、
// 全体の段で落とした数と確認で復活した数を、status と run の記録に残す。2 つのスキルのファイルを使うので tests/ に置く。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import * as cb from '../.agents/skills/coverage-build/scripts/test-harness.mjs'
import { auditPos } from '../.agents/skills/coverage-build/scripts/board-fixture.mjs'
import { lensSetVersion } from '../.agents/skills/coverage-audit/scripts/ledger-core.mjs'
import { behave, claimedTasks, cli, drive, project, status, unitLines, usable } from '../.agents/skills/coverage-audit/scripts/blackboard-fixture.mjs'

const ledgerOf = (state) => JSON.parse(readFileSync(path.join(state, 'ledger.json'), 'utf8'))
const L2 = { id: 'L2', name: '用語の一貫', procedure: '用語ごとに使われ方を並べ、意味の揺れを探す' }
const QA = 'この文書は台帳の lock を取ってから書き込むことを保証する。'
const QB = 'この文書は lock が書き込みを直列にすることを前提にする。'
const FILES = { 'a.md': `# A\n\n${QA}\n`, 'b.md': `# B\n\n${QB}\n` }
const argOf = (argv, k) => argv[argv.indexOf(`--${k}`) + 1]

// ---- 観点を渡す ----

// 書き換え（波の形）: 観点は argv の --lenses で main session に返さず、CLI が同じ process で coverage-audit の台帳に渡す。
// 渡った観点は、検査の役（ファイルの段）が claim で受け取る担当の lenses で確かめる（段は coverage-audit の段の位置から読む）。
test('coverage-build: 段ごとの観点を coverage-audit に渡し、ファイルの段の担当が段ごとに違う観点を受け取る', async (t) => {
  const { state } = cb.setup(t)
  const seen = {}
  const auditOver = { file: (task) => { const p = (auditPos(state) || {}).phase; (seen[p] = seen[p] || []).push(...task.lenses); return undefined } }
  const { stop } = await cb.drive(state, cb.mockAgent(), { auditOver })
  assert.equal(stop.stop, 'complete', JSON.stringify(stop))
  assert.deepEqual(Object.keys(seen).sort(), ['design', 'impl'])
  for (const [p, ls] of Object.entries(seen)) {
    assert.ok(ls.length >= 1, `${p}: 観点が 1 つ以上`)
    for (const l of ls) assert.ok(l.id && l.name && l.procedure, `${p}: 観点は id・name・procedure を持つ: ${JSON.stringify(l)}`)
  }
  const ids = (p) => [...new Set(seen[p].map((l) => l.id))].sort()
  assert.notDeepEqual(ids('design'), ids('impl'), '設計レビューと実装レビューで観点が違う')
})

test('coverage-audit: reframe の --lenses で利用者の観点が差し替わり、観点の組の版が変わって全ての単位が読み直しになる。--lenses の無い reframe は観点を保つ', async (t) => {
  const { d, state, paths } = project(t, FILES, { phase: 'design' })
  const { stop } = await drive(state, behave())
  assert.equal(stop.stop, 'complete', JSON.stringify(stop))
  const before = ledgerOf(state)
  const v0 = lensSetVersion(before, before.assets[paths['a.md']])
  writeFileSync(path.join(d, 'l2.json'), JSON.stringify([L2]))
  const frame = ['--goal', path.join(d, 'goal.md'), '--request', path.join(d, 'request.md'), '--criteria', path.join(d, 'criteria.md'), ...Object.values(paths).flatMap((p) => ['--target', p])]
  const r = cli('reframe', '--state', state, ...frame, '--phase', 'impl', '--lenses', path.join(d, 'l2.json'))
  assert.equal(r.code, 0, JSON.stringify(r))
  const after = ledgerOf(state)
  assert.deepEqual(after.lenses.filter((l) => l.origin === 'user').map((l) => l.id), ['L2'], '利用者の観点が L2 に差し替わる')
  assert.ok(after.lenses.some((l) => l.retro), '振り返りの観点は残す')
  assert.notEqual(lensSetVersion(after, after.assets[paths['a.md']]), v0, '観点の組の版が変わる')
  assert.ok(Object.values(after.assets).every((a) => a.state === 'unseen' && !a.read), '全ての単位が読み直し')
  // 計画役（観点を渡したときも足す観点の提案として流れる）を通して、ファイルの段に差し替えた観点が渡る（L1 は渡らない）。
  const { calls } = await drive(state, behave())
  const lensIds = claimedTasks(calls).filter((x) => x.kind === 'file').map((x) => x.lenses.map((l) => l.id))
  assert.ok(lensIds.length && lensIds.every((ids) => ids.includes('L2') && !ids.includes('L1')), `ファイルの段に差し替えた観点が渡る: ${JSON.stringify(lensIds)}`)
  // --lenses の無い reframe は、今の利用者の観点を保つ。
  const g = cli('reframe', '--state', state, ...frame, '--phase', 'review')
  assert.equal(g.code, 0, JSON.stringify(g))
  assert.deepEqual(ledgerOf(state).lenses.filter((l) => l.origin === 'user').map((l) => l.id), ['L2'])
})

// ---- 再レビューの記録 ----

test('持ち越し: 止まった後に対象が変わったら新しい回を始め、変わらない単位の読みは持ち越しの印を付けて新しく読んだ単位と分けて数える', async (t) => {
  const { state, paths } = project(t, FILES)
  assert.equal((await drive(state, behave())).stop.stop, 'complete')
  const s1 = status(state)
  assert.deepEqual(s1.metrics.reads, { fresh: 2, carried: 0 }, '1 回目は全て新しく読んだ')
  writeFileSync(paths['b.md'], `# B\n\n${QB}\nこの行は直しで足した本文の行である。\n`)
  assert.equal((await drive(state, behave())).stop.stop, 'complete')
  const s2 = status(state)
  assert.deepEqual(s2.metrics.reads, { fresh: 1, carried: 1 })
  assert.deepEqual(s2.units.filter((u) => u.carried).map((u) => u.path), [paths['a.md']], '変わらない単位にだけ持ち越しの印')
  assert.ok(s2.metrics.round_start > s1.metrics.round_start, '新しい回の始まりの周が進む')
  // run の記録は止まるたびに 1 件。
  assert.deepEqual(s2.run_records.map((r) => [r.stop, r.reads.carried]), [['complete', 0], ['complete', 1]])
})

test('指摘の出どころ: 変わった単位の指摘は直しによる誤り（fix）。全体の段が足した指摘は、場所が変わらない単位でも、足した意図の根拠に変わった単位の事実があれば fix', async (t) => {
  const { state, paths } = project(t, FILES)
  const round = { n: 1 }
  // a.md は「台帳の lock」を保証し、b.md はそれを前提にする（前提の消化の意図が a.md と b.md の事実を根拠に持つ）。
  const facts = (p, lines) => {
    if (path.basename(p) === 'a.md') return { guarantees: [{ subject: '台帳の lock', quote: QA, confidence: 'high' }] }
    const premises = [{ subject: '台帳の lock', quote: QB, confidence: 'high' }]
    if (round.n === 1) return { premises, findings: [{ claim: '1 回目の指摘', quote: lines.find(usable), severity: 'HIGH' }] }
    return { premises, findings: [{ claim: '直しで入った誤りの指摘', quote: lines.find(usable), severity: 'HIGH' }] }
  }
  // 2 回目は b.md を読み直したので前提の消化の意図が開き直る。そこで、変わっていない a.md の保証の抜けを指摘として足す（関わる単位は a.md だけ）。
  const premise = (task) => {
    if (round.n !== 2) return undefined
    return { verdict: 'unsatisfied', quote: QA, findings: [{ claim: '前から見落としていた抜け', locations: [{ unit: paths['a.md'], quote: QA }], obligation: 'G2', confidence: 'high', severity: 'HIGH', layer: '実装' }] }
  }
  assert.equal((await drive(state, behave({ facts, premise }))).stop.stop, 'complete')
  const first = status(state).findings.confirmed
  assert.deepEqual(first.map((f) => [f.claim, f.provenance]), [['1 回目の指摘', 'new']])
  round.n = 2
  writeFileSync(paths['b.md'], `# B\n\n${QB}\nこの行は直しで足した本文の行である。\n`)
  assert.equal((await drive(state, behave({ facts, premise }))).stop.stop, 'complete')
  const s = status(state)
  const by = Object.fromEntries(s.findings.confirmed.map((f) => [f.claim, f.provenance]))
  assert.equal(by['直しで入った誤りの指摘'], 'fix')
  // 抜けの場所は変わっていない a.md だが、足した前提の消化の意図は変わった b.md の前提を根拠に持つ（ファイルをまたぐ指摘は関わる単位のどれかが変われば fix）。
  assert.equal(by['前から見落としていた抜け'], 'fix')
  assert.equal(s.metrics.provenance.fix, 2)
  assert.equal(s.metrics.provenance.missed, 0)
})

test('指摘の出どころ: 手続き（観点）が変わって全てを読み直すときも前の読みの印を残し、内容の変わらない単位の新しい指摘は前からの見落とし（missed）', async (t) => {
  const { d, state, paths } = project(t, FILES, { phase: 'design' })
  assert.equal((await drive(state, behave())).stop.stop, 'complete')
  writeFileSync(path.join(d, 'l2.json'), JSON.stringify([L2]))
  const frame = ['--goal', path.join(d, 'goal.md'), '--request', path.join(d, 'request.md'), '--criteria', path.join(d, 'criteria.md'), ...Object.values(paths).flatMap((p) => ['--target', p])]
  const r = cli('reframe', '--state', state, ...frame, '--phase', 'design', '--lenses', path.join(d, 'l2.json'))
  assert.equal(r.code, 0, JSON.stringify(r))
  assert.equal(r.kept, false, '観点が変わったので全てを読み直す')
  const facts = (p, lines) => (path.basename(p) === 'a.md' ? { findings: [{ claim: '新しい観点で見つけた前からの欠陥', quote: lines.find(usable), severity: 'HIGH' }] } : {})
  assert.equal((await drive(state, behave({ facts }))).stop.stop, 'complete')
  const f = status(state).findings.confirmed.find((x) => x.claim === '新しい観点で見つけた前からの欠陥')
  assert.equal(f && f.provenance, 'missed')
})

test('reframe: 同じ段で手続きが同じなら全てを読み直さず（kept）、読みを持ち越し、内容の変わった単位だけを読み直す', async (t) => {
  const { d, state, paths } = project(t, FILES, { phase: 'design' })
  assert.equal((await drive(state, behave())).stop.stop, 'complete')
  const start = JSON.parse(readFileSync(path.join(state, 'phase.json'), 'utf8')).phase_start
  writeFileSync(paths['b.md'], `# B\n\n${QB}\nこの行は直しで足した本文の行である。\n`)
  const frame = ['--goal', path.join(d, 'goal.md'), '--request', path.join(d, 'request.md'), '--criteria', path.join(d, 'criteria.md'), '--lenses', path.join(d, 'lenses.json'), ...Object.values(paths).flatMap((p) => ['--target', p])]
  const r = cli('reframe', '--state', state, ...frame, '--phase', 'design')
  assert.equal(r.code, 0, JSON.stringify(r))
  assert.equal(r.kept, true)
  assert.notDeepEqual(JSON.parse(readFileSync(path.join(state, 'phase.json'), 'utf8')).phase_start, start, '呼ぶ側が reframe を流した後と分かるよう、段の位置のファイルが変わる')
  const { calls } = await drive(state, behave())
  assert.deepEqual(claimedTasks(calls).filter((x) => x.kind === 'file').map((x) => x.unit.path), [paths['b.md']], '変わった単位だけを読み直す')
  assert.deepEqual(status(state).metrics.reads, { fresh: 1, carried: 1 })
})

test('coverage-build の経路: 設計レビュー → 直し → 設計レビューで、2 回目は読みを持ち越し、指摘を carried・fix・missed に分ける', async (t) => {
  const { state } = cb.setup(t)
  const round = { n: 0 }
  // 直しの設計（2 回目の U1 の詳細設計）は本文を変える。
  let designs = 0
  const agent = cb.mockAgent({ 'design-U1': () => { designs += 1; return designs > 1 ? { unit_id: 'U1', spec: '入力を受け取り、決まった値を返す。直しで境界の扱いを足した。', acceptance: ['値を返す'], behaviors: [{ text: '値を返す', accepts: [1], rows: [] }], partitions: [], premises: [], unverified: [], allowed_optional: [], cases: [{ condition: '入力が 1', expect: '2 を返す', accepts: [1], covers: [] }] } : undefined } })
  const statuses = []
  // 本物の coverage-audit を流す。保証は義務に結ばない（目標の判定は単位の索引と載せなかった事実から判定する）。
  // 1 回目: U1 に指摘、目標は U1 の保証で支える。2 回目: U1 に指摘（fix）、目標は U1 を読み直したので開き直り、変わらない U2 の抜けを足す（missed）。
  const facts = (p, lines) => {
    const q = lines.find(usable)
    // U1 の保証は回ごとに主語が変わる（読み直した U1 の事実は前の事実と別の id になり、前の支えが今の根拠から外れる）。
    const subject = path.basename(p) === 'U1.md' ? `U1 の決定 ${round.n}` : `${path.basename(p)} の決定`
    const out = { bind: false, guarantees: [{ subject, quote: q, confidence: 'high' }] }
    if (path.basename(p) === 'U1.md') out.findings = [{ claim: `U1 の指摘 ${round.n}`, quote: q, layer: '詳細設計' }]
    return out
  }
  const goal = (task, ctx) => {
    const q = ctx.query(task)
    const ids = q.omitted_ids || []
    const all = ids.length ? ctx.query(task, ids).facts : []
    const u1 = all.find((f) => path.basename(f.path) === 'U1.md')
    if (round.n === 1) return u1 ? { verdict: 'supported', support: [u1.id], quote: u1.quote } : undefined
    const u2 = q.units.find((u) => path.basename(u.path) === 'U2.md')
    const quote = unitLines(u2).find(usable)
    return { verdict: 'gap', quote, findings: [{ claim: `U2 の前からの抜け（${task.intent.item}）`, locations: [{ unit: u2.id, quote }], obligation: task.intent.item, confidence: 'high', severity: 'HIGH', layer: '詳細設計' }] }
  }
  // 書き換え（波の形）: 検査は build の呼び出しの波に並ぶ。検査の 1 回の始まりごとに audit が 1 回呼ばれるので、そこで回を数える。
  // 結果は build が取り込んだ記録（audits の metrics と、指摘の出来事の provenance）で確かめる。
  const audit = (phase) => { round.n += 1; statuses.push(phase); return null }
  await cb.drive(state, agent, { audit, auditOver: { facts, goal }, maxSteps: 40 })
  assert.ok(statuses.filter((x) => x === 'design').length >= 2, `設計レビューが 2 回: ${JSON.stringify(statuses)}`)
  const L = JSON.parse(readFileSync(path.join(state, 'build.json'), 'utf8'))
  assert.ok(L.audits.design.metrics.reads.carried >= 1, `2 回目は変わらない単位の読みを持ち越す: ${JSON.stringify(L.audits.design.metrics)}`)
  const by = Object.fromEntries(L.events.filter((e) => e.kind === 'finding' && e.stage === 'design_review').map((e) => [e.text.split('（')[0], e.provenance]))
  assert.equal(by['U1 の指摘 2'], 'fix', JSON.stringify(by))
  assert.ok(Object.entries(by).some(([c, p]) => c.startsWith('U2 の前からの抜け') && p === 'missed'), JSON.stringify(by))
})

test('全体の段の集計: 全体の段で落とした指摘の数と、確認で復活させた数を status と run の記録に残す', async (t) => {
  const { state } = project(t, FILES)
  const facts = (p, lines) => (path.basename(p) === 'a.md' ? { findings: [{ claim: '落とされて復活する指摘', quote: lines.find(usable), severity: 'HIGH' }] } : {})
  const act = behave({
    facts,
    finding: () => ({ verdict: 'drop', reason: '全体の文脈では無意味と判じた', quote: QA }),
    confirm: () => ({ verdict: 'disagree', reason: '本文が指摘を支えるので落とす判定は誤り', quote: QA }),
  })
  assert.equal((await drive(state, act)).stop.stop, 'complete')
  const s = status(state)
  assert.deepEqual(s.metrics.global, { dropped: 1, restored: 1 })
  assert.deepEqual(s.run_records.at(-1).global, { dropped: 1, restored: 1 })
  assert.ok(s.findings.confirmed.some((f) => f.claim === '落とされて復活する指摘'), '復活した指摘は確定する')
})
