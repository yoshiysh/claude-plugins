export const meta = {
  name: 'coverage-build-write',
  description: '書き込む段（tests・implement のどれか）を 1 回だけ流す。単位ごとに 1 体が受け持ちのファイルだけを書き、書いた path を返す。照合と記録は呼び出し側の CLI',
  requirements: ['fresh-thread', 'workspace-write'],
  phases: [
    { title: 'tests', detail: '単位ごとに、実装より先にテストを書く' },
    { title: 'implement', detail: '単位ごとに、設計に沿って受け持ちのファイルを書く' },
  ],
  limits: { maxAgents: 12, concurrency: 3, timeoutMs: 7200000, agentTimeoutMs: 1800000, maxOutputBytes: 4000000 },
}

// 書き込む run には書く役だけを置く（runner は役ごとに書き込みの権限を分けられない）。読む役・検証役は build-step.js。
// native Workflow は本体に meta を渡さないので写しを置く（一致は tests/coverage-build-workflow.test.mjs が照らす）。
const LIMITS = { maxAgents: 12, concurrency: 3, timeoutMs: 7200000, agentTimeoutMs: 1800000, maxOutputBytes: 4000000 }
const arr = (a) => (Array.isArray(a) ? a : [])
// <sum> 値を key の順に並べた JSON の FNV-1a。args の写し違いの検出に使う（build-step.js と build-write.js に同じ文がある）。
const canon = (v) => (Array.isArray(v) ? `[${v.map(canon).join(',')}]` : v && typeof v === 'object' ? `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}` : JSON.stringify(v))
function fnv(s) {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
  return h.toString(16).padStart(8, '0')
}
const argsSum = (a) => fnv(canon(Object.fromEntries(Object.entries(a).filter(([k]) => k !== 'argsSum'))))
// </sum>

const A = typeof args === 'string' ? JSON.parse(args) : args
const agents = []
const tokens = () => (typeof budget !== 'undefined' && budget && typeof budget.spent === 'function' ? budget.spent() : null)
const argProblems = []
if (!A || typeof A !== 'object') argProblems.push('args が object でない')
else {
  if (!['tests', 'implement'].includes(A.stage)) argProblems.push(`stage が不正: ${A.stage}`)
  if (!A.roles || typeof A.roles !== 'object') argProblems.push('roles が無い')
  if (arr(A.tasks).length > LIMITS.maxAgents) argProblems.push(`tasks が ${LIMITS.maxAgents} 件を超える`)
  if (A.argsSum !== argsSum(A)) argProblems.push('args の写しが next の出力と違う（argsSum が合わない）')
}
if (argProblems.length) return { stage: A && A.stage, call_id: A && A.callId, status: 'blocked', reason: 'args の検査に落ちた', problems: argProblems, agents: [] }

const ROLE = A.stage === 'tests' ? 'test_writer' : 'implementer'
const SCHEMA = { type: 'object', properties: { unit_id: { type: 'string' }, written: { type: 'array', items: { type: 'string' } }, notes: { type: 'string' }, unresolved: { type: 'array', items: { type: 'string' } } }, required: ['unit_id', 'written', 'notes', 'unresolved'] }
const WHAT = A.stage === 'tests'
  ? '設計のケースを全て、実装より先にテストとして書く。期待値は設計と基準から決め、実装を見て合わせない。まだ実装が無いので、テストが落ちるのは正しい。'
  : '設計に沿って受け持ちのファイルを書く。テストのファイルは読むだけで変えない（別の担当が書いた検査で、CLI が変更を照らす）。前の回の欠陥と原因が束にあれば、指摘の箇所だけを繕わず、原因を除くように受け持ち全体を設計に合わせて作り直す。'

phase(A.stage)
const rows = await pipeline(arr(A.tasks), async (t) => {
  let out = null
  try {
    out = await agent(`## 依頼の束
まず Read で ${t.brief.path} を全て読む（hash ${t.brief.hash}）。目的・固定した目標と基準と制約・単位の設計・読むファイルはそこにある。
## あなたの役: ${ROLE === 'test_writer' ? 'テストの担当' : '実装の担当'}（単位 ${t.unit_id} だけ）
${WHAT}
- 書いてよいのは次の path だけ（repo からの相対）: ${t.paths.join(', ')}。他のファイルは書かない・消さない。
- 自分で検証の agent を起こさない。検証は別の段が行う。
- 書いた path を written に、果たせなかったことを unresolved に返す。`, { label: `${A.stage}-${t.unit_id}`, phase: A.stage, schema: SCHEMA, model: A.roles[ROLE].model, effort: A.roles[ROLE].effort })
  } catch (e) { log(`${t.unit_id}: agent が失敗した（${String((e && e.message) || e).slice(0, 160)}）`) }
  agents.push({ role: ROLE, label: `${A.stage}-${t.unit_id}`, model: A.roles[ROLE].model, effort: A.roles[ROLE].effort, ok: out != null })
  return { unit_id: t.unit_id, result: out }
})
return { stage: A.stage, call_id: A.callId, status: 'ok', results: rows.map((r, i) => r || { unit_id: A.tasks[i].unit_id, result: null }), agents, tokens: tokens(), limits: LIMITS }
