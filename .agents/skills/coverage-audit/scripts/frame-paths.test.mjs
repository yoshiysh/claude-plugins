// 目標の path の照合と、参照だけの資産（--context）のテスト（計画 effervescent-kindling-corbato の「coverage-audit」7・8、設計レビュー 1 回目の 8）。
// - init・reframe・answer --file: 目標・基準・制約の本文の path の形の語が repo（基準は cwd、または --repo）に実在するのに、--target にも --context にも無ければ problems で拒む。
//   実在しない path は照らさない。path の形の語は「/ を含み、拡張子で終わる語」（例: src/extra.md）。
// - --context <file>（init・reframe）: 写しの資産に context: true。網羅・todoUnits・全文レビューの範囲・skip に数えない。
//   判定役・確認役・全文レビューの query の単位の索引に載り、指摘の locations の unit に引けて引用が照らされる。読む役（file）の担当には載らない。
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { CLI, CRITERIA, GOAL, LENSES, claimedTasks, cli, drive, run, status, tmp } from './blackboard-fixture.mjs'
import { noProposalAct } from './plan-roles.mjs'

const DOC = '# 文書\n\n## 節\nこの節は対象の文書の主張を一つだけ述べる本文の行である。\n'
const REF = '# 参照\n\n## 決定\n参照の文書は、書き込みの前に必ず lock を取ると決めている。\n'
const REF_LINE = '参照の文書は、書き込みの前に必ず lock を取ると決めている。'
const REQUEST = '対象の文書を観点ごとにレビューしてほしい'
const put = (p, text) => { mkdirSync(path.dirname(p), { recursive: true }); writeFileSync(p, text); return p }
// repo の形の置き場: src/doc.md（対象）・src/extra.md（対象でない実在のファイル）・ref/decision.md（参照）。
function repo(t) {
  const d = tmp(t)
  return {
    d,
    doc: put(path.join(d, 'src', 'doc.md'), DOC),
    extra: put(path.join(d, 'src', 'extra.md'), '# 別\n\nこの文書は対象に渡さない別の文書の本文の行である。\n'),
    ref: put(path.join(d, 'ref', 'decision.md'), REF),
    request: put(path.join(d, 'request.md'), REQUEST),
    lenses: put(path.join(d, 'lenses.json'), JSON.stringify(LENSES)),
  }
}
// coverage-build から照合済みで渡す init（目標は引用を持たない 1 行 1 件）。
const checkedInit = (r, { goal = GOAL, criteria = CRITERIA, constraints = null, extra = [], repoArg = true, state = path.join(r.d, `state-${Math.random().toString(16).slice(2)}`) } = {}) => {
  const argv = ['init', '--state', state, '--goal', put(path.join(r.d, `goal-${path.basename(state)}.md`), goal), '--request', r.request, '--criteria', put(path.join(r.d, `criteria-${path.basename(state)}.md`), criteria),
    ...(constraints ? ['--constraints', put(path.join(r.d, `constraints-${path.basename(state)}.md`), constraints)] : []),
    '--lenses', r.lenses, '--target', r.doc, '--goal-checked', 'coverage-build', '--phase', 'impl', ...(repoArg ? ['--repo', r.d] : []), ...extra]
  return { state, out: run(...argv) }
}
const mentions = (s, word) => JSON.stringify(s.problems || []).includes(word)
// 単独で呼ぶ init（照合済みの印が無い。目標・基準・制約の各行は依頼文を引く）。path の照合はこの台帳だけに掛かる。
const cite = (text) => text.split('\n').filter((l) => l.trim()).map((l) => `${l} 〔request: ${REQUEST}〕`).join('\n') + '\n'
const SOLO_GOAL = '- G1: 対象の文書を観点ごとに確かめた指摘の一覧'
const soloInit = (r, { goal = SOLO_GOAL, criteria = null, constraints = null, extra = [], repoArg = true, state = path.join(r.d, `solo-${Math.random().toString(16).slice(2)}`) } = {}) => {
  const tag = path.basename(state)
  const argv = ['init', '--state', state, '--goal', put(path.join(r.d, `goal-${tag}.md`), cite(goal)), '--request', r.request,
    ...(criteria ? ['--criteria', put(path.join(r.d, `criteria-${tag}.md`), cite(criteria))] : []),
    ...(constraints ? ['--constraints', put(path.join(r.d, `constraints-${tag}.md`), cite(constraints))] : []),
    '--target', r.doc, ...(repoArg ? ['--repo', r.d] : []), ...extra]
  return { state, out: run(...argv) }
}

// ---------------- path の照合（単独で呼ぶ台帳だけ。照合済みの台帳は呼ぶ側の build が自分の対象と入力で照らす） ----------------

test('path の照合（init・単独）: 目標の本文が、repo に実在し --target にも --context にも無い path を挙げれば problems で拒み、台帳を作らない', (t) => {
  const r = repo(t)
  const { state, out } = soloInit(r, { goal: '- G1: src/extra.md の手順も確かめた指摘の一覧' })
  assert.equal(out.code, 2, JSON.stringify(out))
  assert.ok(mentions(out, 'src/extra.md'), `problems に path を挙げる: ${JSON.stringify(out)}`)
  assert.equal(status(state).code, 2, '台帳を作らない')
})

test('path の照合（init・単独）: 基準・制約の本文の path も照らす', (t) => {
  const r = repo(t)
  const a = soloInit(r, { criteria: '- AC1: 指摘は src/extra.md の規則にも結ぶ' })
  assert.equal(a.out.code, 2, JSON.stringify(a.out))
  assert.ok(mentions(a.out, 'src/extra.md'))
  const c = soloInit(r, { constraints: '- D1: src/extra.md の形を変えない' })
  assert.equal(c.out.code, 2, JSON.stringify(c.out))
  assert.ok(mentions(c.out, 'src/extra.md'))
})

test('path の照合（init・単独）: 実在しない path は照らさず、--target か --context にある path は受け付ける', (t) => {
  const r = repo(t)
  assert.equal(soloInit(r, { goal: '- G1: src/none.md の手順も確かめた指摘の一覧' }).out.code, 0, '実在しない path は照らさない')
  assert.equal(soloInit(r, { goal: '- G1: src/doc.md の手順を確かめた指摘の一覧' }).out.code, 0, '対象の path は受け付ける')
  assert.equal(soloInit(r, { goal: '- G1: ref/decision.md の決定に照らした指摘の一覧', extra: ['--context', r.ref] }).out.code, 0, '参照に渡した path は受け付ける')
  assert.equal(soloInit(r, { goal: '- G1: src/extra.md の手順も確かめた指摘の一覧', extra: ['--context', r.extra] }).out.code, 0)
})

test('path の照合（init・単独）: --repo が無ければ cwd を基準にする', (t) => {
  const r = repo(t)
  const state = path.join(r.d, 'state-cwd')
  const g = put(path.join(r.d, 'goal-cwd.md'), cite('- G1: src/extra.md の手順も確かめた指摘の一覧'))
  const p = spawnSync(process.execPath, [CLI, 'init', '--state', state, '--goal', g, '--request', r.request, '--target', r.doc], { cwd: r.d, encoding: 'utf8' })
  assert.equal(p.status, 2, p.stdout)
  assert.match(p.stdout, /src\/extra\.md/)
})

test('照合済みの台帳（--goal-checked coverage-build）: init は目標・基準・制約の path を照らさない（照らすのは呼ぶ側の build）', (t) => {
  const r = repo(t)
  for (const x of [
    { goal: '- G1: src/extra.md の手順も確かめた指摘の一覧\n' },
    { criteria: '- AC1: 指摘は src/extra.md の規則にも結ぶ\n' },
    { constraints: '- D1: src/extra.md の形を変えない\n' },
  ]) {
    const { out } = checkedInit(r, x)
    assert.equal(out.code, 0, `照合済みの台帳で path を照らした: ${JSON.stringify(x)} → ${JSON.stringify(out)}`)
  }
  // --repo を渡さない（cwd が repo）ときも照らさない。
  const state = path.join(r.d, 'state-checked-cwd')
  const g = put(path.join(r.d, 'goal-checked-cwd.md'), '- G1: src/extra.md の手順も確かめた指摘の一覧\n')
  const p = spawnSync(process.execPath, [CLI, 'init', '--state', state, '--goal', g, '--request', r.request, '--lenses', r.lenses, '--target', r.doc, '--goal-checked', 'coverage-build', '--phase', 'impl'], { cwd: r.d, encoding: 'utf8' })
  assert.equal(p.status, 0, p.stdout)
})

test('照合済みの台帳（reframe）: 差し替える目標の本文の path を照らさない', (t) => {
  const r = repo(t)
  const { state, out } = checkedInit(r)
  assert.equal(out.code, 0, JSON.stringify(out))
  const g = put(path.join(r.d, 'goal-reframe.md'), '- G1: src/extra.md の手順も確かめた指摘の一覧\n')
  const rf = cli('reframe', '--state', state, '--goal', g, '--request', r.request, '--target', r.doc, '--phase', 'design', '--repo', r.d)
  assert.equal(rf.code, 0, JSON.stringify(rf))
})

test('path の照合（answer --file・単独）: 直した目標の本文の path も照らす（基準は init の --repo）', (t) => {
  const r = repo(t)
  const state = path.join(r.d, 'state-answer')
  const g = put(path.join(r.d, 'goal-a.md'), `- G1: 対象の文書を観点ごとに確かめた指摘の一覧 〔request: ${REQUEST}〕\n`)
  const init = cli('init', '--state', state, '--goal', g, '--request', r.request, '--target', r.doc, '--repo', r.d)
  assert.equal(init.code, 0, JSON.stringify(init))
  const g2 = put(path.join(r.d, 'goal-a2.md'), `- G1: src/extra.md と対象の文書を確かめた指摘の一覧 〔request: ${REQUEST}〕\n`)
  const bad = cli('answer', '--state', state, '--id', 'goal', '--file', g2)
  assert.equal(bad.code, 2, JSON.stringify(bad))
  assert.ok(mentions(bad, 'src/extra.md'))
  const g3 = put(path.join(r.d, 'goal-a3.md'), `- G1: src/none.md と対象の文書を確かめた指摘の一覧 〔request: ${REQUEST}〕\n`)
  assert.equal(cli('answer', '--state', state, '--id', 'goal', '--file', g3).code, 0, '実在しない path は照らさない')
})

// ---------------- --context ----------------

test('--context: 参照の単位は網羅・全文レビューの範囲・skip に数えず、読む役の担当に載らない。全文レビューと判定役の query の索引には context: true で載り、指摘の場所に引けて引用が照らされる。場所が参照だけの指摘は確定せず参考に入り、対象の単位にも場所を持つ指摘は確定しうる', async (t) => {
  const r = repo(t)
  const { state, out } = checkedInit(r, { extra: ['--context', r.ref] })
  assert.equal(out.code, 0, JSON.stringify(out))
  let frInputs = null
  let goalUnits = null
  let tries = 0
  const CLAIM = 'CTX-参照の決定に照らした抜けの指摘'
  const MIXED = 'MIX-参照の決定と対象の本文をまたぐ抜けの指摘'
  const DOC_LINE = 'この節は対象の文書の主張を一つだけ述べる本文の行である。'
  const a = noProposalAct({
    full_review: (task, ctx) => { frInputs = ctx.query(task).inputs; return undefined },
    goal: (task, ctx) => {
      const q = ctx.query(task)
      goalUnits = q.units || []
      const cu = goalUnits.find((u) => u.context === true)
      const du = goalUnits.find((u) => u.path === r.doc)
      if (!cu || !du || task.intent.item !== 'G1') return undefined
      tries += 1
      // 1 回目は参照の本文に無い引用（照合に落ちる）、2 回目は参照の本文の逐語の引用。
      const quote = tries === 1 ? '参照の文書のどこにも無い引用の文をここに書く' : REF_LINE
      return { verdict: 'gap', quote: REF_LINE, findings: [
        { claim: CLAIM, locations: [{ unit: cu.id, quote }], confidence: 'high', severity: 'HIGH', layer: '実装' },
        { claim: MIXED, locations: [{ unit: cu.id, quote: REF_LINE }, { unit: du.id, quote: DOC_LINE }], confidence: 'high', severity: 'HIGH', layer: '実装' },
      ] }
    },
  })
  const { stop, calls } = await drive(state, a, { maxSteps: 40 })
  assert.equal(stop && stop.stop, 'complete', JSON.stringify(stop))
  const s = status(state)
  // 網羅に数えない。
  assert.equal(stop.coverage.units, 1, `網羅は対象の単位だけ: ${JSON.stringify(stop.coverage)}`)
  assert.ok(!JSON.stringify(stop.coverage).includes(r.ref))
  assert.ok(!s.skip.some((x) => String(x.unit).includes('decision')), 'skip に数えない')
  // 読む役の担当に載らない。
  const files = claimedTasks(calls).filter((x) => x.kind === 'file')
  assert.ok(files.length >= 1 && files.every((x) => x.unit.path !== r.ref), `読む役に参照を渡さない: ${files.map((x) => x.unit.path)}`)
  // 全文レビューの範囲に数えないが、索引には載る。
  const ctxUnits = (frInputs && frInputs.units || []).filter((u) => u.context === true)
  assert.ok(ctxUnits.length >= 1 && ctxUnits.every((u) => u.path === r.ref), `全文レビューの query の索引に参照が context: true で載る: ${JSON.stringify(frInputs && frInputs.units)}`)
  const fr = s.full_review || {}
  assert.ok(![...(fr.read || []), ...(fr.unread || [])].some((id) => ctxUnits.some((u) => u.id === id)), `全文レビューの範囲（read・unread）に数えない: ${JSON.stringify(fr)}`)
  // 判定役の索引に載り、指摘の場所に引ける。
  assert.ok(goalUnits && goalUnits.some((u) => u.context === true && u.path === r.ref), `判定役の query の索引に参照が載る: ${JSON.stringify(goalUnits)}`)
  assert.equal(tries, 2, '1 回目の引用は照合に落ち、出し直した')
  const rejected = calls.flatMap((c) => c.workers.flatMap((w) => w.submits.flatMap((x) => x.out.results || []))).filter((x) => x.ok === false)
  assert.ok(rejected.some((x) => x.problems.some((p) => /逐語/.test(p))), `参照の本文に無い引用は拒む: ${JSON.stringify(rejected)}`)
  // 場所が参照の単位だけの指摘は確定させず、参考（references）に入れる。
  assert.ok(!s.findings.confirmed.some((f) => f.claim === CLAIM), `場所が参照だけの指摘を確定させた: ${JSON.stringify(s.findings.confirmed.map((f) => f.claim))}`)
  assert.ok(s.references.some((x) => x.claim === CLAIM), `場所が参照だけの指摘は参考に入る: ${JSON.stringify(s.references.map((x) => x.claim))}`)
  // 場所の 1 つ以上が対象の単位にある指摘は確定しうる（参照の引用も根拠に使える）。
  const hit = s.findings.confirmed.find((f) => f.claim === MIXED)
  assert.ok(hit, `対象の単位にも場所を持つ指摘が確定する: ${JSON.stringify(s.findings.confirmed.map((f) => f.claim))}`)
  assert.ok((hit.paths || []).includes(r.ref) && (hit.paths || []).includes(r.doc), JSON.stringify(hit))
})

test('--context（reframe）: 段を変えて参照を差し替えられ、参照は網羅に数えない', async (t) => {
  const r = repo(t)
  const { state, out } = checkedInit(r)
  assert.equal(out.code, 0, JSON.stringify(out))
  const g = put(path.join(r.d, 'goal-ctx.md'), GOAL)
  const rf = cli('reframe', '--state', state, '--goal', g, '--request', r.request, '--target', r.doc, '--context', r.ref, '--phase', 'design', '--repo', r.d)
  assert.equal(rf.code, 0, JSON.stringify(rf))
  const { stop } = await drive(state, noProposalAct(), { maxSteps: 40 })
  assert.equal(stop && stop.stop, 'complete', JSON.stringify(stop))
  assert.equal(stop.coverage.units, 1)
})
