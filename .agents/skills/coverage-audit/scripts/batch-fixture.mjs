// 全体の段の受け渡しを意図の束にする設計（docs/design/coverage-ledger-method.md の決定 16、B1・B2、役と制御の境界の「静的に決まるもの」、
// 完了と止める条件の試行の数え方）のテストの道具。batch.test.mjs だけが使う。
// blackboard-fixture.mjs・launch-fixture.mjs・full-review-fixture.mjs の既存の形と既定は変えず、束の受け渡しで固定する形をここ 1 か所に置く。
//
// ここで固定する下の層の決定（変えるときはこのファイルを直す）:
// - claim（全体の段の g 行・c 行）: { ok, tasks: [Task], submit_cmd }。tasks は意図ごとに 1 件（result_path も意図ごと）で、
//   今の Task から lenses を除いた形（obligations・intent・hints・goal の units は今のまま）。
//   出し終えていない意図を持つ worker の claim は、その意図だけを返す（新しい意図を混ぜない）。
// - 束の量: 意図ごとの JSON.stringify({ basis, related, units? }) のバイト数の和（basis・related は query が返す公開の事実、units は goal の意図の単位の索引）。
//   和が UNIT_MAX_BYTES を超えない所まで、意図の並びの順で前から詰める（next-fit）。1 件だけで超える意図は単独の束。
// - query: --task が 1 つなら今の形のまま（{ ok, task, kind, intent, basis, related, omitted, omitted_ids, units?, facts? }）。
//   --task が 2 つ以上なら { ok, tasks: [今の 1 件の形から ok を除いたもの（--task の順）] , facts? }。
//   どれか 1 つでもこの worker の担当に無ければ、終了状態 2 で拒む。ファイルの段・振り返りの担当は今のまま拒む。
// - submit: 今の形（{ ok, results: [{ task, intent, ok, problems, dropped }], missing }）のまま、束の全ての結果を 1 回で受ける。
// - 同じ箇所の指摘の組: query の 1 件の形に same_location: [[事実の id, 事実の id], …] を足す（組が無ければ省くか空）。
//   組は、全文レビューの指摘の場所とファイルの段の指摘が同じ単位で、正規化した引用が包含し合うもの。
//   finding・confirm の意図は対象の指摘を含む組、group の意図は basis の中の組を持つ。組の相手の事実は related か facts に載せる（basis は意図の根拠のままにし、相手を入れない）。
// - locations[].unit の引き当て: 探す範囲は対象の全ての単位（振り返りを除く。全文レビューは読む範囲）。曖昧なときの problems は、候補の単位の id を全て含む。
// - goal の意図が足す指摘の obligation: 役が省いても別の id を書いても、意図の item になる（上書き）。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { cli, shellWords, status, workerLoop, readArgs, rowsOf, claimFor } from './blackboard-fixture.mjs'

export const G_KINDS = ['alias', 'subject', 'finding', 'premise', 'goal']
export const C_KINDS = ['confirm', 'group']
export const ledger = (state) => JSON.parse(readFileSync(path.join(state, 'ledger.json'), 'utf8'))
export const argsOf = (n) => readArgs(n)
export const openOf = (state, kinds) => status(state).intents.filter((i) => i.state === 'open' && kinds.includes(i.kind))
export const intentIds = (c) => (c.tasks || []).map((x) => x.intent && x.intent.id)
export const writeResult = (task, r) => { mkdirSync(path.dirname(task.result_path), { recursive: true }); writeFileSync(task.result_path, JSON.stringify(r)) }
export const claimOf = (state, args, w) => claimFor(state, args.callId, w.id)
export const submitOf = (c) => { const ws = shellWords(String(c.submit_cmd)); return cli(...ws.slice(ws.indexOf('submit'))) }
// 1 件ずつの query の口（今の形）。役の偽物（behave）が使う。
export const ctxOf = (state, args, w) => ({
  query: (task, facts = []) => { const q = cli('query', '--state', state, '--call', args.callId, '--worker', w.id, '--task', task.id, ...facts.flatMap((f) => ['--fact', f])); return q.code === 0 ? q : { basis: [], related: [] } },
  state, call: args.callId, worker: w.id,
})
// 呼び出しを閉じる（全ての役が返った形の返り値）。
export function ingestOk(state, args) {
  const res = { agents: rowsOf(args).map((w) => ({ role: w.role, label: `worker-${w.id}`, model: w.model, effort: w.effort, ok: true })), tokens: null }
  const f = path.join(state, `result-${args.callId}.json`)
  writeFileSync(f, JSON.stringify(res))
  return cli('ingest', '--state', state, '--call', args.callId, '--result', f)
}
// 全体の段の呼び出しが開くまで、ほかの段の呼び出しを worker（1 件ずつの workerLoop）で流す。開いた全体の段の next と args を返す（worker は起動しない）。
export async function toGlobal(state, act, maxSteps = 20) {
  for (let i = 0; i < maxSteps; i++) {
    const n = cli('next', '--state', state)
    if (n.code !== 0 || n.stop) throw new Error(`全体の段まで進まない: ${JSON.stringify(n)}`)
    const args = argsOf(n)
    if (args.stage === 'global') return { n, args }
    for (const w of rowsOf(args)) await workerLoop({ state, call: args.callId, worker: w.id, role: w.role }, act, [])
    const g = ingestOk(state, args)
    if (g.code !== 0) throw new Error(`ingest が通らない: ${JSON.stringify(g)}`)
  }
  throw new Error('全体の段が開かない')
}
// 束の worker: claim → 取った全ての担当の結果を書く → submit を 1 回、を done まで繰り返す。claims と submits を返す。
// 1 件ずつの query（今の形）で役の偽物を動かすので、今の実装でも止まらずに回る（束の形の確かめは assertion が担う）。
export async function batchWorker(state, args, w, act, { maxClaims = 60 } = {}) {
  const ctx = ctxOf(state, args, w)
  const rec = { claims: [], submits: [] }
  for (let i = 0; i < maxClaims; i++) {
    const c = claimOf(state, args, w)
    if (c.code !== 0 || c.done || !Array.isArray(c.tasks) || !c.tasks.length) break
    rec.claims.push(c)
    let wrote = 0
    for (const task of c.tasks) {
      const r = await act(task, ctx)
      if (r == null) continue
      writeResult(task, r)
      wrote++
    }
    if (!wrote) break
    const s = submitOf(c)
    rec.submits.push(s)
    if (s.code !== 0) break
  }
  return rec
}
// 束の量（固定した測り方）: 意図ごとの JSON.stringify({ basis, related, units? }) のバイト数。
export const entryBytes = (e) => Buffer.byteLength(JSON.stringify({ basis: e.basis || [], related: e.related || [], ...(e.units ? { units: e.units } : {}) }))
// status から、goal の意図の query が返すはずの量を見積もる（fixture の大きさの前提を確かめるため）。
export function goalBytes(state, item) {
  const s = status(state)
  const related = s.facts.filter((f) => ['guarantee', 'premise', 'finding'].includes(f.type) && f.obligation === item)
  const units = s.units.map((u) => ({ id: u.id, path: u.path, file: u.file, start: u.start, end: u.end }))
  return entryBytes({ basis: [], related, units })
}
// 主語の名前: 長さが同じで先頭が違うので、どの 2 つも包含し合わない（名寄せの意図を作らない）。pad で事実を大きくする。
export const bigSubject = (item, k, pad) => `s-${item}-${String(k).padStart(4, '0')}-${'x'.repeat(pad)}`
// 1 つの単位に、義務の項目ごとに count[item] 件の保証を書く（同じ引用・別の主語）。goal の意図の related の大きさを決める。
export const bigGuarantees = (quote, counts, pad) => Object.entries(counts).flatMap(([item, n]) => Array.from({ length: n }, (_, k) => ({ subject: bigSubject(item, k, pad), quote, confidence: 'high', obligation: item })))
