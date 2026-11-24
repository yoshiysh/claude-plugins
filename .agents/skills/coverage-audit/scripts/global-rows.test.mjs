// 全体の段の 1 回の呼び出しの起動数（設計「モデルと費用」の起動の原則）。
// 全体の段は役の組（判定役 g と確認役 c。ledger-cli.mjs の INTENT_ROWS の 2 組）ごとに min(workers, 開いた意図の数) 行を作るので、
// 1 回の呼び出しの起動数は最大で 組の数 × workers になる。Workflow source（coverage-audit.js）は行を切り詰めず全て起動するので、
// 行の数を maxAgents に収めるのは CLI の責務で、CLI が次を守る:
// - config --workers は、組の数 × workers が maxAgents を超える値を拒む（終了状態 2、台帳を変えない）。
// - 全体の段の行の合計は、いつも min(maxAgents, 残りの予算) 以下（予算は超えてはいけない上限）。
// - 予算が開いた組の数より少ないときは、INTENT_ROWS の並び（g が先、c が後）の順に開いた組へ 1 行ずつ割り当て、予算が尽きた組はその呼び出しで 0 行（次へ回す）。
// - 予算に余りがあるときは、開いた意図のある組がどれも 1 行以上を持つ。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { C } from './ledger-core.mjs'
import { cli, project, rowsOf, readArgs } from './blackboard-fixture.mjs'
import { driveUntil } from './launch-fixture.mjs'
import { frAct, frFinding, loc } from './full-review-fixture.mjs'

// 全体の段の役の組の数（判定役 global_judge の g と、確認役 confirmer の c）。
const GROUPS = 2
const PER_GROUP_MAX = Math.floor(C.LIMITS.maxAgents / GROUPS)
const ledger = (state) => JSON.parse(readFileSync(path.join(state, 'ledger.json'), 'utf8'))
const bytes = (state) => readFileSync(path.join(state, 'ledger.json'), 'utf8')

test(`config --workers: 組の数（${GROUPS}）× workers が maxAgents を超える値は終了状態 2 で台帳を変えず、maxAgents に収まる最大の値は受け付ける`, (t) => {
  const { state } = project(t, { 'a.md': '# A\n\n## 節\nこの文書は主張を一つだけ述べる本文の行である。\n' })
  const before = bytes(state)
  for (const v of [PER_GROUP_MAX + 1, C.LIMITS.maxAgents]) {
    const r = cli('config', '--state', state, '--workers', String(v))
    assert.equal(r.code, 2, `--workers ${v}（起動は最大 ${GROUPS * v} 体）: ${JSON.stringify(r)}`)
    assert.match(String(r.error), /workers/, r.error)
  }
  assert.equal(bytes(state), before, '台帳を変えない')
  const ok = cli('config', '--state', state, '--workers', String(PER_GROUP_MAX))
  assert.equal(ok.code, 0, JSON.stringify(ok))
  assert.equal(ledger(state).config.workers, PER_GROUP_MAX)
})

// 判定役と確認役の両方に開いた意図が複数ある全体の段の呼び出しを作る。
// ファイルの段の指摘（判定役の finding の意図）を 4 ファイルに 1 件ずつ、全文レビューの指摘（確認役の confirm の意図）を 4 件置く。
const line = (n, i) => `この文書${n}は${i}番目の主張を述べるが根拠を書いていない本文の行である。`
const FILES = Object.fromEntries(['A', 'B', 'C', 'D'].map((n) => [`${n.toLowerCase()}.md`, `# ${n}\n\n## 主張\n${line(n, 1)}\n${line(n, 2)}\n`]))
const act = frAct({
  facts: (p) => { const n = path.basename(p, '.md').toUpperCase(); return { findings: [{ claim: `ファイルの段の指摘 ${n}`, quote: line(n, 1), severity: 'HIGH' }] } },
  frFindings: (units) => ['A', 'B', 'C', 'D'].map((n) => frFinding(`全文レビューの指摘 ${n}`, [loc(units, `${n.toLowerCase()}.md`, line(n, 2))])),
})
// 確認の意図は判定役が全文レビューの指摘を判定した後に開くので、全体の段の 1 回目の呼び出しでは、判定役（1 行）に全文レビューの指摘の判定だけを出させ、
// ほかの判定役の意図（ファイルの段の指摘・目標など）は出させずに開いたまま残す。2 回目の呼び出しの手前で、両方の組に開いた意図が複数ある。
const FR_ONLY = async (task, ctx) => {
  if (['alias', 'subject', 'premise', 'goal'].includes(task.kind)) return null
  if (task.kind === 'finding' && !((ctx.query(task).basis || []).some((f) => f && f.origin === 'full_review'))) return null
  return act(task, ctx)
}
// 両方の組に開いた意図がある全体の段の呼び出しの手前まで流し、今の段で使った起動数を返す。その呼び出しはまだ開かない。
async function toGlobal(t, workers) {
  const { state } = project(t, FILES)
  const r = await driveUntil(state, act, { until: (rec) => rec.stage === 'file' })
  assert.equal(r.stop, null, JSON.stringify(r.stop))
  const g1 = await driveUntil(state, FR_ONLY, { maxSteps: 1 })
  assert.equal(g1.calls.length, 1, JSON.stringify(g1.stop))
  assert.equal(g1.calls[0].stage, 'global', '全体の段の 1 回目の呼び出し')
  assert.deepEqual(g1.calls[0].rows.map((w) => w.role), ['global_judge'], '1 回目は判定役の組だけに開いた意図がある')
  assert.equal(cli('config', '--state', state, '--workers', String(workers)).code, 0)
  const L = ledger(state)
  return { state, spent: L.agents.length - L.phase_start.agents }
}
function globalCall(state) {
  const n = cli('next', '--state', state)
  assert.equal(n.code, 0, JSON.stringify(n))
  assert.equal(n.step, 'global', JSON.stringify(n))
  const rows = rowsOf(readArgs(n))
  return { g: rows.filter((w) => w.role === 'global_judge'), c: rows.filter((w) => w.role === 'confirmer'), rows }
}

test('全体の段: 予算に余裕があれば、組ごとに min(workers, 開いた意図の数) 行で、判定役と確認役の両方が 1 行以上（前提の確かめ）', async (t) => {
  const { state } = await toGlobal(t, 3)
  const { g, c, rows } = globalCall(state)
  assert.equal(g.length, 3, JSON.stringify(rows))
  assert.equal(c.length, 3, JSON.stringify(rows))
  assert.ok(rows.length <= C.LIMITS.maxAgents)
})

// 両方の組に開いた意図が 4 件以上あり、workers は 5。予算ごとの各組の行の数の下限（予算 1 では c は 0 行と決まる）。
const BUDGETS = [
  { left: 3, g: 1, c: 1 },
  { left: 2, g: 1, c: 1 },
  { left: 1, g: 1, c: 0, exact: true },
]
for (const b of BUDGETS) {
  test(`全体の段: 残りの予算が ${b.left} のとき、行の合計は min(maxAgents, 残りの予算) 以下で、${b.exact ? 'g（先の組）が 1 行・c が 0 行' : '開いた意図のある組はどれも 1 行以上'}`, async (t) => {
    const { state, spent } = await toGlobal(t, 5)
    assert.equal(cli('config', '--state', state, '--max-agents-total', String(spent + b.left)).code, 0)
    const { g, c, rows } = globalCall(state)
    const ids = JSON.stringify(rows.map((w) => w.id))
    const cap = Math.min(C.LIMITS.maxAgents, b.left)
    assert.ok(rows.length <= cap, `行の合計 ${rows.length} は ${cap} 以下（予算を超えない）: ${ids}`)
    if (b.exact) {
      assert.equal(g.length, 1, `予算が開いた組の数より少ないとき、先の組（g）に 1 行: ${ids}`)
      assert.equal(c.length, 0, `予算が尽きた組（c）は 0 行で次へ回す: ${ids}`)
    } else {
      assert.ok(g.length >= b.g, `判定役の組（開いた意図がある）は 0 行にならない: ${ids}`)
      assert.ok(c.length >= b.c, `確認役の組（開いた意図がある）は 0 行にならない: ${ids}`)
    }
  })
}
