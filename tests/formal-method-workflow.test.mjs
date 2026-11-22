// formal-method の Workflow script（plugins/verification/workflows/formal-method-agents.js）を、native と同じ注入（agent・parallel・pipeline・phase・log・args・budget）で流す。
// 契約: artifact-formats.md「Workflow の返り値」（{agents, tokens} だけ）、SKILL.md「担当の起動」（args は call.args_path の JSON のまま）。
// 役は偽物で、prompt に書かれた claim の命令（run の領域の入口）を読むだけで、CLI は流さない。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const WF = path.resolve(import.meta.dirname, '../plugins/verification/workflows/formal-method-agents.js')
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor
const BODY = readFileSync(WF, 'utf8').replace(/^export const meta = /, 'const meta = ')
const runBody = new AsyncFunction('agent', 'parallel', 'pipeline', 'phase', 'log', 'args', 'budget', BODY)
function runScript(args, agentFn, { budget } = {}) {
  const parallel = (ts) => Promise.all(ts.map((t) => Promise.resolve().then(t).catch(() => null)))
  const pipeline = (items, fn) => Promise.all(items.map((x) => Promise.resolve().then(() => fn(x)).catch(() => null)))
  const logs = []
  return runBody(agentFn, parallel, pipeline, () => {}, (m) => logs.push(m), args, budget).then((res) => ({ res, logs }))
}
const ARGS = {
  state: '/tmp/fm-run/runs/r1', callId: 'call-001', stage: '確認',
  workers: [{ id: 'w01', role: 'fidelity-reviewer', model: 'opus', effort: 'high' }, { id: 'w02', role: 'cause-analyst', model: 'opus', effort: 'high' }],
}

test('SP-FORMALMETHOD-013 Workflow の返り値: workers の行ごとに 1 体を行の model・effort で起動し、返り値は {agents, tokens} だけ。tokens は budget.spent() の差', async () => {
  const seen = []
  let spent = 1000
  const budget = { spent: () => spent }
  const agentFn = async (prompt, opts) => { seen.push({ prompt, opts }); spent += 250; return { notes: [] } }
  const { res } = await runScript(ARGS, agentFn, { budget })
  assert.deepEqual(Object.keys(res).sort(), ['agents', 'tokens'])
  assert.equal(res.tokens, 500)
  assert.deepEqual(res.agents.map((a) => [a.role, a.model, a.effort, a.ok]), [['fidelity-reviewer', 'opus', 'high', true], ['cause-analyst', 'opus', 'high', true]])
  assert.deepEqual(seen.map((x) => [x.opts.model, x.opts.effort]), [['opus', 'high'], ['opus', 'high']])
  for (const [i, w] of ARGS.workers.entries()) {
    const p = seen[i].prompt
    // claim の命令は run の領域の入口を流し、その呼び出しと自分の worker を持つ。資料や成果物の内容は prompt に載らない
    assert.ok(p.includes(`'${ARGS.state}/formal-method-cli.mjs' claim`), p)
    assert.ok(p.includes(JSON.stringify({ run_dir: ARGS.state, call_id: ARGS.callId, worker: w.id })), p)
    for (const step of ['query_cmd', 'submit_cmd', 'result_path', 'instructions']) assert.ok(p.includes(step), `${step} の手順`)
  }
})

test('SP-FORMALMETHOD-013 Workflow の返り値: budget が無いか数でなければ tokens は null、agent が失敗した行は ok: false で起動の記録に残る', async () => {
  const agentFn = async (_p, opts) => { if (opts.label.endsWith('w02')) throw new Error('落ちた'); return { notes: [] } }
  for (const budget of [undefined, { spent: () => 'x' }]) {
    const { res } = await runScript(ARGS, agentFn, { budget })
    assert.equal(res.tokens, null)
    assert.deepEqual(res.agents.map((a) => a.ok), [true, false])
  }
})

test('SP-FORMALMETHOD-013 Workflow の args: 壊れた args では起動せず、空の起動の記録を返す', async () => {
  for (const bad of [{ ...ARGS, stage: '実行' }, { ...ARGS, workers: [] }, { ...ARGS, callId: '' }, { batch_id: 'b1', tasks: [] }]) {
    let n = 0
    const { res, logs } = await runScript(bad, async () => { n += 1; return { notes: [] } })
    assert.equal(n, 0)
    assert.deepEqual(res, { agents: [], tokens: null })
    assert.ok(logs.some((m) => m.includes('args の検査に落ちた')))
  }
})

test('SP-FORMALMETHOD-013 Workflow の prompt: 担当は submit の next で続けて next の done: true で終え（終わりの claim を流さない）、query は <query_cmd> <task_id>、生成物は scratch_dir に Write か >| で書く', async () => {
  const seen = []
  await runScript(ARGS, async (prompt) => { seen.push(prompt); return { notes: [] } })
  for (const p of seen) {
    for (const s of ['next', 'done: true', 'claim を流し直さない', '<query_cmd> <task_id>', 'return_schemas', 'scratch_dir', '>|', 'Write']) assert.ok(p.includes(s), `prompt に ${s} が無い`)
    assert.ok(!p.includes('claim が done を返すまで'), '終わりの claim を求めない')
    assert.ok(!p.includes('return_schema が'), 'task ごとの return_schema を前提にしない')
  }
})
