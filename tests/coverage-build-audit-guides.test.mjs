// coverage-build の Workflow source（build-step.js）が、検査の役の GUIDES を coverage-audit.js と同じ文の区間で持つことを照らす
// （計画 effervescent-kindling-corbato の「coverage-build」2。<goalmap> 区間の一致のテストと同じ型）。
// 区間は coverage-audit.js の今の文にある印で切る: 「const READ_RESULT = 」の行の頭から、「const QUOTED = 」の行の終わりまで
// （担当の種類ごとの結果の形・境界の規則・全体の段・計画の規則・全文レビュー・GUIDES・QUOTED）。build-step.js は同じ文をそのまま持つ。
// 2 つのスキルのファイルを読むので、配布物に入らないリポジトリ直下の tests/ に置く。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const BUILD_STEP = '.agents/skills/coverage-build/scripts/build-step.js'
const AUDIT_WF = '.agents/skills/coverage-audit/scripts/coverage-audit.js'
const src = (p) => readFileSync(path.join(ROOT, p), 'utf8')
const START = 'const READ_RESULT = '
const END = 'const QUOTED = '
function guidesBlock(text, where) {
  const s = text.indexOf(START)
  const e = text.indexOf(END)
  assert.ok(s >= 0 && e > s, `${where} に検査の役の GUIDES の区間（${START}〜${END}の行）がある`)
  const lineEnd = text.indexOf('\n', e)
  return text.slice(s, lineEnd < 0 ? text.length : lineEnd)
}

test('検査の役の GUIDES の区間は、coverage-audit.js と build-step.js で同じ文', () => {
  const audit = guidesBlock(src(AUDIT_WF), AUDIT_WF)
  const build = guidesBlock(src(BUILD_STEP), BUILD_STEP)
  assert.equal(build, audit)
})

// 検査の役の prompt: coverage-audit.js と build-step.js に同じ段の行を渡すと、結果の形の節（GUIDES の段の text）が同じで、
// build の側の claim の命令は build-cli.mjs を口にし、--stage は audit:<段>。
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor
const bodyOf = (text) => new AsyncFunction('agent', 'parallel', 'pipeline', 'phase', 'log', 'args', 'budget', text.replace(/^export const meta = /, 'const meta = '))
const parallel = (ts) => Promise.all(ts.map((t) => Promise.resolve().then(t).catch(() => null)))
const pipeline = (items, fn) => Promise.all(items.map((x, i) => Promise.resolve().then(() => fn(x, i)).catch(() => null)))
async function promptsOf(file, rows) {
  const seen = []
  const agent = async (prompt, opts) => { seen.push({ prompt, opts }); return { notes: [] } }
  await bodyOf(src(file))(agent, parallel, pipeline, () => {}, () => {}, { state: '/tmp/coverage-guides-x', callId: 'c1', wave: { id: 1, rows } }, undefined)
  return seen
}
const AUDIT_ROLES = JSON.parse(src('.agents/skills/coverage-audit/scripts/roles.json'))
const STAGE_ROLE = { plan: 'planner', unit_verify: 'unit_verifier', full_review: 'full_reviewer', file: 'file_reader', global: 'global_judge', retro: 'file_reader' }
const HEAD = '### 結果の形（担当の kind ごと。result_path に書く JSON）\n'
for (const [stage, role] of Object.entries(STAGE_ROLE)) {
  test(`検査の役の prompt（${stage}）: build-step.js は coverage-audit.js と同じ結果の形の節を載せ、claim の口は build-cli.mjs で --stage は audit:${stage}`, async () => {
    const row = (st) => ({ id: 'w1', role, model: AUDIT_ROLES[role].model, effort: AUDIT_ROLES[role].effort, stage: st })
    const [a] = await promptsOf(AUDIT_WF, [row(stage)])
    assert.ok(a && a.prompt.includes(HEAD), `coverage-audit.js の ${stage} の prompt に結果の形の節がある`)
    const section = a.prompt.slice(a.prompt.indexOf(HEAD))
    const [b] = await promptsOf(BUILD_STEP, [row(`audit:${stage}`)])
    assert.ok(b, `build-step.js が audit:${stage} の行の役を起動する`)
    assert.ok(b.prompt.includes(section), `build-step.js の prompt に coverage-audit.js と同じ結果の形の節がある（${stage}）`)
    const claim = b.prompt.split('\n').find((l) => /\sclaim\s/.test(l) && l.includes('--state'))
    assert.ok(claim && claim.includes('build-cli.mjs') && !claim.includes('ledger-cli.mjs'), `claim の口は build-cli.mjs: ${claim}`)
    assert.ok(claim.includes(`--stage 'audit:${stage}'`) || claim.includes(`--stage audit:${stage}`), claim)
    assert.deepEqual([b.opts.model, b.opts.effort], [AUDIT_ROLES[role].model, AUDIT_ROLES[role].effort])
  })
}
