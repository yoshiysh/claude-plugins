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

// 検査の役の prompt の全体（共通の前提・担当を取る命令・手順・返り値・結果の形）: build-step.js が写しとして持つ AUDIT_COMMON・STEP_*・auditLoop も、
// coverage-audit.js と同じ文であること。同じ行（段だけ build の側は audit:<段>）から作った 2 つの prompt は、CLI の入口の path（build-cli.mjs と
// ledger-cli.mjs）と、段の名前の audit: の前置きを除いて一致する。
const normalize = (prompt, stage) => prompt.replace(/\/(build|ledger)-cli\.mjs/g, '/<CLI>').replaceAll(`audit:${stage}`, stage)
for (const [stage, role] of Object.entries(STAGE_ROLE)) {
  test(`検査の役の prompt の全体（${stage}）: build-step.js と coverage-audit.js は、CLI の入口の path と段の前置きを除いて同じ文`, async () => {
    const row = (st) => ({ id: 'w1', role, model: AUDIT_ROLES[role].model, effort: AUDIT_ROLES[role].effort, stage: st })
    const [a] = await promptsOf(AUDIT_WF, [row(stage)])
    const [b] = await promptsOf(BUILD_STEP, [row(`audit:${stage}`)])
    assert.ok(a && b, `両方の source が ${stage} の役を起動する`)
    assert.ok(a.prompt.includes('/ledger-cli.mjs') && b.prompt.includes('/build-cli.mjs'), 'それぞれの CLI の入口を使う')
    assert.equal(normalize(b.prompt, stage), normalize(a.prompt, stage))
  })
}

// 波のループの写し: build-step.js の行の形（ROW_SCHEMA・WORKER_SCHEMA）・波の id の検査（waveIdOk）・波を順に流すループは、coverage-audit.js の写し。
// 区間は両ファイルの「// <wave-loop>」の行と「// </wave-loop>」の行の間（印の行は含めない）。各印はちょうど 1 つで、始まりが終わりより前。
// 照らす本文: 区間の行から、行全体が // の注釈の行と、rowsOk の宣言の文（「const rowsOk =」の行と、それに続く字下げした継続の行）を除いたもの。
// 違ってよいのは rowsOk の宣言だけ（build は build の段の行も受ける）。rowsOk が使う補助（build の rowOk など）は区間の外に置くか、同じ文にする。
// launch の呼び方・args の検査の文言なども、区間の中にある限り同じ文でなければならない。
const WAVE_START = '// <wave-loop>'
const WAVE_END = '// </wave-loop>'
function waveLoopBlock(text, where) {
  const lines = text.split('\n')
  const starts = lines.flatMap((l, i) => (l.trim() === WAVE_START ? [i] : []))
  const ends = lines.flatMap((l, i) => (l.trim() === WAVE_END ? [i] : []))
  assert.equal(starts.length, 1, `${where} に「${WAVE_START}」の行がちょうど 1 つある（${starts.length} 個）`)
  assert.equal(ends.length, 1, `${where} に「${WAVE_END}」の行がちょうど 1 つある（${ends.length} 個）`)
  assert.ok(starts[0] < ends[0], `${where} の「${WAVE_START}」は「${WAVE_END}」より前`)
  const body = lines.slice(starts[0] + 1, ends[0])
  const out = []
  for (let i = 0; i < body.length; i++) {
    if (/^\s*\/\//.test(body[i])) continue
    if (/^const rowsOk\s*=/.test(body[i])) {
      while (i + 1 < body.length && /^\s+\S/.test(body[i + 1])) i++
      continue
    }
    out.push(body[i])
  }
  return out.join('\n')
}

test('波のループの写し: build-step.js と coverage-audit.js の <wave-loop> 区間は、rowsOk の宣言を除いて同じ文で、行の形・波の id の検査・波のループを含む', () => {
  const audit = waveLoopBlock(src(AUDIT_WF), AUDIT_WF)
  const build = waveLoopBlock(src(BUILD_STEP), BUILD_STEP)
  for (const [where, block] of [[AUDIT_WF, audit], [BUILD_STEP, build]]) {
    for (const head of ['const ROW_SCHEMA = ', 'const WORKER_SCHEMA = ', 'const waveIdOk = ', 'for (;;) {']) {
      assert.ok(block.includes(head), `${where} の <wave-loop> 区間に「${head}」がある`)
    }
  }
  assert.equal(build, audit)
})
