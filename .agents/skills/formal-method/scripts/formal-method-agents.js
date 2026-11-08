export const meta = {
  name: 'formal-method-agents',
  description: 'formal-method の CLI が出した batch の task を 1 つずつ起動し、task ごとの起動の結末と受け取った値を返す',
  whenToUse: 'formal-method スキルの司令塔が、CLI の status が run_agents のときに tasks.json の batch_id と tasks を args に渡して呼ぶ。args が無いと起動直後に落ちるため直接は起動しない',
  requirements: ['fresh-thread', 'workspace-write'],
  phases: [
    { title: '起動', detail: 'CLI が決めた task を、決めた model と effort のまま起動する' },
    { title: '返却', detail: 'task ごとに returned・missing・error を分けて返す' },
  ],
}

// この script は判断しない。起動する task・model・effort・schema は CLI の run-daemon が tasks.json に決め、
// 担当の結論は run-daemon が各 task の return_path から読む。ここで値を選んだり返り値を読んだりすると、
// 決定的な照合を経ない経路ができる。返すのは artifact-formats.md の「Workflow の返り値」の閉じた形だけである。

const input = typeof args === 'string' ? JSON.parse(args) : args
if (!input || typeof input !== 'object') throw new Error('args に tasks.json の batch_id と tasks をそのまま渡す')
const batchId = input.batch_id
const tasks = input.tasks
if (typeof batchId !== 'string' || batchId.length === 0) throw new Error('args.batch_id に tasks.json の batch_id をそのまま渡す')
if (!Array.isArray(tasks) || tasks.length === 0) throw new Error('args.tasks に tasks.json の tasks をそのまま渡す')
tasks.forEach((t, i) => {
  if (!t || typeof t !== 'object' || typeof t.task_id !== 'string' || typeof t.prompt !== 'string'
    || typeof t.model !== 'string' || typeof t.effort !== 'string'
    || !t.output_schema || typeof t.output_schema !== 'object') {
    throw new Error(`args.tasks[${i}] は task_id・prompt・model・effort・output_schema を持つ（tasks.json の task をそのまま渡す）`)
  }
})

// run-daemon は、この 5 つが tasks.json と一致するときだけ batch の返り値を使う。司令塔が args へ移した値を照合するため、加工せずに返す。
const received = (t) => ({ task_id: t.task_id, prompt: t.prompt, model: t.model, effort: t.effort, output_schema: t.output_schema })

phase('起動')
// task は互いに独立で、1 batch の数は CLI が AGENT_BATCH_MAX 以下に抑えている。全件を揃えてから見る処理は無いので pipeline にする。
// 段の中で例外を捕まえ、例外と欠測を区別して返す（段が throw すると pipeline は null に変え、区別できなくなる）。
const outcomes = await pipeline(tasks, async (t) => {
  try {
    const out = await agent(t.prompt, { model: t.model, effort: t.effort, schema: t.output_schema, label: t.task_id, phase: '起動' })
    return out === null || out === undefined ? { status: 'missing' } : { status: 'returned' }
  } catch (e) {
    return { status: 'error', error: String(e && e.message ? e.message : e).slice(0, 1000) }
  }
})

phase('返却')
// 全ての task を 1 つずつ返す。欠けた task を落とすと、task の集合が tasks.json と食い違い、batch の全ての返り値が使われなくなる。
const results = tasks.map((t, i) => {
  const o = outcomes[i]
  if (!o) return { task_id: t.task_id, status: 'missing', received: received(t) }
  if (o.status === 'error') return { task_id: t.task_id, status: 'error', received: received(t), error: o.error }
  return { task_id: t.task_id, status: o.status, received: received(t) }
})
const count = (s) => results.filter((r) => r.status === s).length
log(`batch ${batchId}: returned ${count('returned')}・missing ${count('missing')}・error ${count('error')}（全 ${results.length} 件）`)
results.filter((r) => r.status !== 'returned').forEach((r) => log(`${r.task_id}: ${r.status}${r.error ? `（${r.error}）` : ''}`))
return { batch_id: batchId, results }
