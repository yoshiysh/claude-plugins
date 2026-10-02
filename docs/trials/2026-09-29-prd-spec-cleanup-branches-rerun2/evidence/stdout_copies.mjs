// journal の result にある doc_check の stdout の写しを、prd-spec.js（7d06d97）の parseStdout と同じ規則で判定する。
// usage: node stdout_copies.mjs <evidence dir> > stdout-copies.json
import fs from 'node:fs'

const E = process.argv[2]
const RUNS = ['wf_f413a4a5-c3e', 'wf_0f45ed55-8ba']

function canonicalText(v) {
  if (Array.isArray(v)) return `[${v.map(canonicalText).join(',')}]`
  if (v && typeof v === 'object') return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${k}:${canonicalText(v[k])}`).join(',')}}`
  return `${typeof v}:${String(v)}`
}
function fnv(text) {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0
  return h.toString(16).padStart(8, '0')
}
function status(text) {
  const line = String(text || '').trim().split('\n').filter((l) => l.trim().startsWith('{')).pop()
  if (!line) return null
  let o
  try {
    o = JSON.parse(line)
  } catch {
    return 'bad_json'
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return 'bad_json'
  const { stdout_fnv: sum, ...body } = o
  if (sum === undefined) return 'no_fnv'
  return sum === fnv(canonicalText(body)) ? 'ok' : 'fnv_mismatch'
}

const models = {}
for (let i = 1; i <= 5; i++) {
  const d = JSON.parse(fs.readFileSync(`${E}/run-outputs/run${i}.output.json`, 'utf8'))
  for (const a of d.workflowProgress) if (a.type === 'workflow_agent' && a.tokens != null) models[a.agentId] = { run: i, model: a.model }
}

const out = []
function walk(v, path, meta) {
  if (typeof v === 'string') {
    const s = status(v)
    if (s) out.push({ ...meta, field: path, chars: v.length, status: s })
  } else if (v && typeof v === 'object' && !Array.isArray(v)) {
    for (const [k, x] of Object.entries(v)) walk(x, path ? `${path}.${k}` : k, meta)
  }
}
for (const wf of RUNS) {
  const label = {}
  for (const line of fs.readFileSync(`${E}/journal-${wf}.jsonl`, 'utf8').split('\n')) {
    if (!line.trim()) continue
    const d = JSON.parse(line)
    if (d.type === 'started') label[d.agentId] = d.label
    if (d.type === 'result' && d.result && typeof d.result === 'object') {
      for (const [k, v] of Object.entries(d.result)) {
        if (['findings', 'path', 'units', 'ruled', 'questions', 'holds', 'routes', 'pass', 'fail', 'docs', 'changed_items', 'applied_findings', 'applied_routes'].includes(k)) continue
        walk(v, k, { wf, agent: d.agentId, label: label[d.agentId], run: models[d.agentId].run, model: models[d.agentId].model })
      }
    }
  }
}
process.stdout.write(JSON.stringify(out, null, 1) + '\n')
