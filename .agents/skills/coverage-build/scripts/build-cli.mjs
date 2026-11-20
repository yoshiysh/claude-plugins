#!/usr/bin/env node
// 台帳を書く唯一の口。init → next →（Workflow / coverage-audit / run-checks）→ ingest / import-audit を繰り返し、next が止まる条件を返したら終わる。
import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  C, PHASES, WRITE_LIMITS, addEvent, decide, dueEvents, dueGroups, estimate, queuedIntents, goalIds, implTodo, importAudit, ingestDesign, ingestRetro, ingestWrite, newLedger,
  applyRedo, ownedPaths, ownerOf, readGoalFiles, redoSummary, renderDesign, route, rowIdsOf, sha, testsTodo, unitList, coverIds,
} from './build-core.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SKILL_DIR = path.dirname(HERE)
const WF = { design: 'build-step.js', retro: 'build-step.js', tests: 'build-write.js', implement: 'build-write.js' }
const CHECK_TIMEOUT_MS = 1800000

class Fail extends Error { constructor(msg, extra = {}) { super(msg); this.extra = extra } }
const MULTI = ['input', 'target', 'check']
const KNOWN = {
  init: ['state', 'mode', 'repo', 'goal', 'request', 'decisions', 'criteria', 'constraints', 'input', 'target', 'check', 'roles', 'max-cycles', 'max-agents-total', 'max-unit-rounds'],
  next: ['state'], ingest: ['state', 'result'], 'import-audit': ['state'], 'run-checks': ['state'], status: ['state'],
  hint: ['state', 'text'], answer: ['state', 'id', 'text', 'file'], dismiss: ['state', 'id', 'text'], config: ['state', 'max-cycles', 'max-agents-total', 'max-unit-rounds'],
}
function parse(argv) {
  const o = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) { o._.push(a); continue }
    const k = a.slice(2)
    const v = argv[i + 1]
    if (v === undefined || v.startsWith('--')) throw new Fail(`--${k} に値が無い`)
    i++
    if (MULTI.includes(k)) (o[k] = o[k] || []).push(v)
    else o[k] = v
  }
  const known = KNOWN[o._[0]]
  if (known) for (const k of Object.keys(o)) if (k !== '_' && !known.includes(k)) throw new Fail(`${o._[0]} が受け付けない引数: --${k}`)
  return o
}
const read = (p) => readFileSync(p, 'utf8')
const need = (o, k) => { if (!o[k]) throw new Fail(`--${k} が要る`); return o[k] }
function posInts(o, keys) {
  const out = {}
  for (const [k, ck] of keys) {
    if (o[k] === undefined) continue
    if (!/^[1-9]\d*$/.test(o[k]) || !Number.isSafeInteger(Number(o[k]))) throw new Fail(`--${k} は正の整数: ${o[k]}`)
    out[ck] = Number(o[k])
  }
  return out
}
const LIMIT_KEYS = [['max-cycles', 'max_cycles'], ['max-agents-total', 'max_agents_total'], ['max-unit-rounds', 'max_unit_rounds']]
const ledgerPath = (dir) => path.join(dir, 'build.json')
function load(dir) {
  if (!existsSync(ledgerPath(dir))) throw new Fail(`台帳が無い: ${ledgerPath(dir)}（init を先に流す）`)
  const L = JSON.parse(read(ledgerPath(dir)))
  if (!L.goal || !Array.isArray(L.goal.items)) throw new Fail(`台帳の形式が古い（目標の項目と引用を持たない）: ${ledgerPath(dir)}。goal.md などを 1 行 1 件・引用つきに直し、新しい stateDir で init からやり直す`)
  if (!Array.isArray(L.audit_events_seen)) throw new Fail(`台帳の形式が古い（coverage-audit の出来事の受けた記録を持たない）: ${ledgerPath(dir)}。新しい stateDir で init からやり直す`)
  if (!L.audit_groups || typeof L.audit_groups !== 'object') throw new Fail(`台帳の形式が古い（設計レビューの群を持たない）: ${ledgerPath(dir)}。新しい stateDir で init からやり直す`)
  if (L.arch && !Array.isArray(L.arch.contracts)) throw new Fail(`台帳の形式が古い（方式設計が境界の約束を持たない）: ${ledgerPath(dir)}。新しい stateDir で init からやり直す`)
  return L
}
function writeAtomic(file, text) {
  mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, text)
  renameSync(tmp, file)
}
function save(dir, L) { L.rev += 1; writeAtomic(ledgerPath(dir), JSON.stringify(L, null, 1)) }
const hints = (dir) => { const f = path.join(dir, 'hints.jsonl'); return existsSync(f) ? read(f).split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [] }
// 束（brief）の写し: 内容の hash の名前で置く。args にはこのファイル名と hash だけを載せる（写しの置き場 snapDir は args に 1 回だけ載り、Workflow source が結合する）。
function writeSnap(dir, text) {
  const name = sha(text).slice(0, 16)
  const file = path.join(dir, 'snap', `${name}.md`)
  if (!existsSync(file) || sha(read(file)).slice(0, 16) !== name) writeAtomic(file, text)
  return { path: path.basename(file), hash: name }
}
const abs = (L, rel) => path.join(L.repo, rel)
const fileHash = (p) => (existsSync(p) ? sha(read(p)).slice(0, 16) : null)
const fileKey = (ps) => sha([...ps].sort().map((p) => `${p}\0${fileHash(p) ?? 'missing'}`).join('\n')).slice(0, 16)
const designDir = (dir) => path.join(dir, 'design')
const designFiles = (L, dir) => Object.keys(renderDesign(L)).map((f) => path.join(designDir(dir), f))

// 設計の写しを台帳から書き直す（CLI だけが書く。消えた単位のファイルは消す）。
function writeDesign(L, dir) {
  const files = renderDesign(L)
  mkdirSync(designDir(dir), { recursive: true })
  for (const f of readdirSync(designDir(dir))) if (!(f in files)) rmSync(path.join(designDir(dir), f))
  for (const [f, t] of Object.entries(files)) if (!existsSync(path.join(designDir(dir), f)) || read(path.join(designDir(dir), f)) !== t) writeAtomic(path.join(designDir(dir), f), t)
}
function keysOf(L, dir) {
  return { baseline: fileKey(L.targets), review: fileKey(L.targets), design: fileKey(designFiles(L, dir)), impl: fileKey(ownedPaths(L).map((p) => abs(L, p))) }
}
// 担当の引用と取り込みの引用を照らすときに読んでよいファイル: stateDir の中、入力、対象、単位が持つファイル。
// 読める集合は呼ぶたびに今の台帳から作る（同じ ingest の中で方式設計が単位の持つファイルを変える）。
function reader(L, dir) {
  return (p) => {
    const ok = new Set([...L.inputs, ...L.targets, ...ownedPaths(L).map((x) => abs(L, x))])
    const f = path.isAbsolute(p) ? path.resolve(p) : abs(L, p)
    if (!(ok.has(f) || f.startsWith(dir + path.sep)) || !existsSync(f)) return null
    return read(f)
  }
}
// 詳細設計の premises の path に使ってよいもの: 入力と対象（絶対 path）と、単位が持つ既にあるファイル（repo からの相対 path）。
// 取り込みの照合と束の一覧は同じこの関数から作る。units: false は単位がまだ決まっていない（方式設計と同じ呼び出し）ときで、入力と対象だけを返す。
const premisePaths = (L, { units = true } = {}) => [...L.inputs, ...L.targets, ...(units ? ownedPaths(L).filter((p) => existsSync(abs(L, p))) : [])]
// 詳細設計の束に載せる、premises に引ける path の一覧の節。
function premiseText(L, units) {
  const rule = units ? '' : '\n加えて、方式設計で決めた単位（全ての単位）の paths・tests のうち既にあるファイルを、repo からの相対 path（paths・tests に書いた文字列のまま）で引いてよい。'
  return `## premises に引ける path（この一覧の path をそのまま書く。一覧に無いものは unverified に）\n${premisePaths(L, { units }).map((p) => `- ${p}`).join('\n') || '- なし'}${rule}\n`
}

const items = (xs) => xs.map((c) => `- ${c.id}: ${c.text}`).join('\n') || '- なし'
function common(L, unread) {
  return `# 依頼の束（coverage-build）
このスキルは、作る・直す作業を「目標の固定 → 設計 → 設計レビュー → 実装 → 実装レビュー」で回し、見落としを構造で減らす。あなたはその中の 1 つの役で、受け持ち以外を書かない・決め直さない。
- mode: ${L.mode}
- repo（相対 path の起点）: ${L.repo}
## 固定した目標（変えない）
${L.goal.text}
## 受け入れ基準（id で指す）
${items(L.criteria)}
## 固定した制約（id で指す。蒸し返さない）
${items(L.constraints)}
## 依頼文（利用者の言葉のまま）
${L.request}
${L.decisions != null ? `## 利用者の決定の記録（利用者の言葉のまま）\n${L.decisions}\n` : ''}## 文書を書くときの規則
${path.join(SKILL_DIR, 'references', 'writing.md')} を読む（表・図・散文の使い分け）。
${unread.length ? `## 利用者のヒント（取り込む）\n${unread.map((h) => `- [${h.id}] ${h.text}`).join('\n')}\n` : ''}`
}
// 振り返りの束の悪かった出来事: 群ごとに見出し 1 行（群の id・層・根本原因）とその群の出来事、群の無い出来事はその後。
// 2 つ以上の群に入る出来事は、本文を最初の群の下に 1 回だけ出し、他の群の下には id だけを置く。
function eventsByGroup(L, due) {
  const line = (e) => `- ${e.id} [${e.stage}/${e.kind}${e.layer ? `/監査の層: ${e.layer}` : ''}${e.unit ? `/${e.unit}${e.test ? ' のテスト' : ''}` : ''}] ${e.text}`
  const shown = new Map()
  const out = []
  for (const g of dueGroups(L)) {
    const ag = L.audit_groups[g] || {}
    out.push(`### 群 ${g} [${ag.layer || '層なし'}] 根本原因: ${ag.root_cause || 'なし'}`)
    for (const e of due.filter((x) => (x.groups || []).includes(g))) {
      out.push(shown.has(e.id) ? `- ${e.id}: 本文は群 ${shown.get(e.id)} の下` : line(e))
      if (!shown.has(e.id)) shown.set(e.id, g)
    }
  }
  const rest = due.filter((e) => !shown.has(e.id))
  if (rest.length) out.push('### 群の無い出来事', ...rest.map(line))
  return out.join('\n')
}
const archInputs = (L, dir) => [...L.inputs, ...(L.mode === 'update' ? L.targets : []), ...(L.baseline ? [path.join(dir, 'audit', 'baseline-status.json')] : [])]
function baselineText(L) {
  if (!L.baseline) return ''
  const b = L.baseline
  return `## 現状の検査（coverage-audit）の結果\n確かめた指摘と見ていない単位。影響の範囲と既存の欠陥として設計に入れる（全件は ${'baseline-status.json'}）。\n${b.findings.map((f) => `- [${f.layer}] ${f.claim}（${f.path}: 「${f.quote}」）`).join('\n') || '- 指摘なし'}\n### 見ていない単位（開示。見たとして扱わない）\n${b.not_seen.map((c) => `- ${c}`).join('\n') || '- なし'}\n### 検証不能の指摘\n${b.unverifiable.map((f) => `- ${f.id}: ${f.claim}`).join('\n') || '- なし'}\n### 参考（目標・受け入れ基準に結べない気づき。欠陥として扱わない）\n${(b.references || []).map((r) => `- ${r.claim}（${r.path}: 「${r.quote}」）`).join('\n') || '- なし'}\n`
}
const designPath = (dir, id) => path.join(designDir(dir), `${id}.md`)
function unitWriteBrief(L, dir, u, stage, unread) {
  const deps = u.depends_on.map((d) => L.units[d])
  return `${common(L, unread)}
## 受け持ち: 単位 ${u.id}（${u.title}）
- 設計: ${designPath(dir, u.id)}（Read で読む）
- 方式設計: ${path.join(designDir(dir), '_architecture.md')}
- 書いてよいファイル: ${(stage === 'tests' ? u.tests : u.paths).join(', ')}
${stage === 'implement' && u.tests.length ? `- 読むだけのテスト（別の担当が先に書いた。変えない）: ${u.tests.join(', ')}\n` : ''}${deps.length ? `## 依存する単位（読むだけ）\n${deps.map((d) => `- ${d.id}: 設計 ${designPath(dir, d.id)}、ファイル ${d.paths.join(', ')}`).join('\n')}\n` : ''}${u.causes.length ? `## 前の回で確かめた欠陥と原因（手がかり。箇所だけを繕わない）\n${u.causes.map((c) => `- ${c}`).join('\n')}\n` : ''}`
}
function buildArgs(L, d, dir, unread) {
  const roles = Object.fromEntries(Object.entries(L.roles).map(([k, r]) => [k, { model: r.model, effort: r.effort }]))
  const base = { skillDir: SKILL_DIR, stage: d.step, roles, snapDir: path.join(dir, 'snap') + path.sep }
  if (d.step === 'design') {
    const inputs = archInputs(L, dir)
    const inputText = `## 入力（全て、読んだか読まないかを申告する）\n${inputs.map((p) => `- ${p}`).join('\n') || '- なし'}\n${baselineText(L)}`
    const args = { ...base, units: [], unitDefs: {} }
    if (!L.goal.checked) Object.assign(args, { goalBrief: writeSnap(dir, common(L, unread)), goalIds: goalIds(L) })
    if (L.mode === 'update' && !L.audits.baseline) return args // 目標の照合だけ。設計は現状の検査の後
    if (L.need_arch) {
      const prev = L.arch ? `## 前の方式設計（読むだけ。やり直す理由は下）\n${path.join(designDir(dir), '_architecture.md')}\n## 戻ってきた原因\n${(L.arch_causes || []).map((c) => `- ${c}`).join('\n') || '- 目標・基準・制約が変わった'}\n` : ''
      args.arch = { brief: writeSnap(dir, `${common(L, unread)}\n${inputText}\n${prev}`), ctx: { coverIds: coverIds(L), inputs }, unitBrief: writeSnap(dir, `${common(L, unread)}\n${inputText}\n${premiseText(L, false)}`) }
    } else {
      for (const u of unitList(L).filter((x) => x.need_design)) {
        args.units.push({ unit_id: u.id, brief: writeSnap(dir, `${common(L, unread)}\n${inputText}\n${premiseText(L, true)}## 方式設計\n${path.join(designDir(dir), '_architecture.md')}\n## 受け持ち: 単位 ${u.id}\n${JSON.stringify({ id: u.id, kind: u.kind, title: u.title, responsibility: u.responsibility, paths: u.paths, tests: u.tests, depends_on: u.depends_on, covers: u.covers })}\n${u.design_hash ? `## 前の詳細設計（読むだけ）\n${designPath(dir, u.id)}\n` : ''}${u.causes.length ? `## 戻ってきた原因\n${u.causes.map((c) => `- ${c}`).join('\n')}\n` : ''}`) })
        args.unitDefs[u.id] = { id: u.id, kind: u.kind, rows: rowIdsOf(L, u.id) } // 境界の行 id だけ。行の文は方式設計の写しにある
      }
    }
    return args
  }
  if (d.step === 'retro') {
    const due = dueEvents(L)
    // 前の呼び出しで起動の枠に入らなかった意図。1 回の呼び出しの起動の枠（maxAgents の 1/3）に入る件数まで、意図の順に流す。
    const carry = queuedIntents(L).slice(0, Math.floor(C.LIMITS.maxAgents / 3))
    const readable = [...designFiles(L, dir), ...ownedPaths(L).map((p) => abs(L, p)), ...L.inputs, ...L.targets, ...listFiles(path.join(dir, 'audit')), ...listFiles(path.join(dir, 'checks'))]
    const text = `${common(L, unread)}
## 悪かった出来事（事実。この振り返りで原因を辿る。群の id を根拠にすると、その群の全ての出来事を辿る）
${eventsByGroup(L, due)}
## 受理済みの原因（事実）
${L.facts.map((f) => `- ${f.id} [${f.layer}] ${f.cause}（根拠: ${f.basis.join(', ')}）`).join('\n') || '- なし'}
## この振り返りで試した意図
${L.intents.filter((i) => i.cycle === L.cycle).map((i) => `- ${i.id} [${i.status}] ${i.hypothesis}（根拠: ${i.basis.join(', ')}）${i.why ? ` — ${i.why}` : ''}`).join('\n') || '- なし'}
## 読めるファイル（look_at と evidence はこの中から）
${readable.map((p) => `- ${p}`).join('\n')}
${carry.length ? `## 流す意図（前の呼び出しで起動の枠に入らなかったもの。実行役・検証役は名指しされた 1 件だけを読む）\n${carry.map((i) => `- ${i.id}: ${JSON.stringify({ basis: i.basis, hypothesis: i.hypothesis, layer: i.layer, look_at: i.look_at })}`).join('\n')}\n` : ''}`
    // 根拠に使える id は範囲で渡す（due の出来事は台帳の末尾に続く。事実は件数。群は due の出来事が持つ群の id）。
    const num = (e) => Number(e.id.slice(1))
    const known = { events: due.length ? [num(due[0]), num(due[due.length - 1])] : [1, 0], facts: L.facts.length, groups: dueGroups(L) }
    return { ...base, brief: writeSnap(dir, text), known, ...(carry.length ? { carry: carry.map((i) => i.id) } : {}) }
  }
  const us = (d.step === 'tests' ? testsTodo(L) : implTodo(L)).slice(0, WRITE_LIMITS.maxAgents)
  return { ...base, tasks: us.map((u) => ({ unit_id: u.id, brief: writeSnap(dir, unitWriteBrief(L, dir, u, d.step, unread)), paths: d.step === 'tests' ? u.tests : u.paths })) }
}
const listFiles = (d) => (existsSync(d) ? readdirSync(d, { recursive: true }).map((f) => path.join(d, String(f))).filter((f) => /\.(json|md|log)$/.test(f) && !f.includes(`${path.sep}snap${path.sep}`)) : [])

// coverage-audit に渡す入力を CLI が決定的に書く（司令塔が目標を言い換えない）。
// coverage-audit の台帳は stateDir/audit/state の 1 つに固定する。段の位置（phase.json）が無ければ init、あれば reframe で段と枠（目標・基準・制約・決定の記録・対象）を差し替える。
// reframe は全ての単位を読み直し、計画から作り直す。同じ段・同じ入力で返した reframe を流した後（coverage-audit が書く段の位置 phase.json の段の始まり phase_start が、
// reframe_argv を返したときの控えから変わった後）に next を流し直しても、argv を返し直さない（途中の検査と、coverage-audit の answer で足した A<n> を消さないため）。
// 流す前や、phase.json が読めず控えや今の値が分からない間は reframe_argv を返し直す（誤っても余分な reframe になるだけで、reframe を飛ばさない）。
// coverage-audit の台帳（ledger.json）は読まない。段の位置は coverage-audit が init と reframe で書く stateDir/phase.json（{ phase, phase_start }）だけから読む。
// init は、台帳ができて段が合えば続けさせる。入力が変われば reframe を返す。
// 目標はこのスキルが照合済みなので、init には照合済みの印（--goal-checked coverage-build）を付け、coverage-audit は照合を流さない。reframe は台帳の印を残す。
// 受け入れ基準（単位ごとの受け入れを含む）は制約と取り違えないよう、coverage-audit の基準の欄（criteria.md）で渡す。
// 基準・制約が 0 件なら、その欄のファイルも引数も渡さない（「- なし」を書くと coverage-audit が「AC1: なし」という項目として読む）。
export const auditState = (dir) => path.join(dir, 'audit', 'state')
// coverage-audit の段の位置のファイル。init が書くので、あれば台帳があるとみなす（init でなく reframe を返す）。
const auditPhaseFile = (state) => path.join(state, 'phase.json')
// coverage-audit が止まったときに書く status のファイル（中身は status の出力と同じ）。司令塔は status の出力を写さず、import-audit がこれを読む。
const auditStatusFile = (state, phase) => path.join(state, `status-${phase}.json`)
// phase.json が読めなければ undefined。読めれば段と、段の始まり（phase_start。plain object のときだけ正規化した文字列、それ以外は null）。
function auditPosOf(state) {
  let A
  try { A = JSON.parse(read(auditPhaseFile(state))) } catch { return undefined }
  if (A === null || typeof A !== 'object') return undefined
  const s = A.phase_start
  return { phase: A.phase, start: s !== null && typeof s === 'object' && !Array.isArray(s) ? C.canon(s) : null }
}
// 検査の段ごとの枠（目標のファイルの冒頭の文）と、coverage-audit に渡す観点（呼ぶ側が持つ領域の観点の中身）。観点の正本はここだけ。
// 観点は枠の文から作り、手続きは「何を列挙し、何と照らすか」で書く。coverage-audit は観点を一覧で全ての単位に渡し、計画役で観点を作らない。
const AUDIT_FRAMES = {
  baseline: {
    frame: '既存の対象を、次の固定した目標に照らして検査する。目標を果たすのに影響を受ける範囲、足りないもの、既存の欠陥を確かめる。',
    lens: { id: 'baseline-fit', name: '目標に照らした現状', procedure: '対象の主張と振る舞いを列挙し、固定した目標・受け入れ基準・制約と照らして、目標を果たすのに影響を受ける範囲、足りないもの、既存の欠陥を探す' },
  },
  review: {
    frame: '対象が、次の固定した目標・受け入れ基準・制約を満たすかを確かめる。',
    lens: { id: 'review-fit', name: '目標・基準・制約の充足', procedure: '対象の主張と振る舞いを列挙し、固定した目標・受け入れ基準・制約と照らして、満たしていないもの・食い違うものを探す' },
  },
  design: {
    frame: '設計（方式設計と単位ごとの詳細設計）が、次の固定した目標・受け入れ基準・制約を満たし、単位の分け方・依存・受け入れ・ケースが実装とテストに足りるかを確かめる。単位をまたぐ扱いは `_architecture.md` の境界の表にあり、設計の文書は行 id（`X<n>-<k>`）でそれを指す。前提の引用と照合の不変条件は script が照らし済みである。',
    lens: { id: 'design-fit', name: '設計の充足と実装への足り', procedure: '設計の決定（単位の分け方・依存・受け入れ・ケース）を列挙し、固定した目標・受け入れ基準・制約と照らして満たしていないものを探す。次に、各決定が実装とテストに足りるか（境界の表の行 id で単位をまたぐ扱いが決まっているか）を照らす' },
  },
  impl: {
    frame: '実装（各単位のファイルとテスト）が、次の固定した目標・受け入れ基準・制約と、単位ごとの受け入れ（基準の U<n>A<m>）を満たすかを確かめる。',
    lens: { id: 'impl-fit', name: '実装とテストの充足', procedure: '実装とテストの振る舞いを列挙し、固定した目標・受け入れ基準・制約と単位ごとの受け入れ（U<n>A<m>）と照らして、満たしていないもの・テストが確かめていないものを探す' },
  },
}
function prepAudit(L, dir, phase, keys) {
  const targets = phase === 'design' ? designFiles(L, dir) : phase === 'impl' ? ownedPaths(L).map((p) => abs(L, p)) : L.targets
  const frame = AUDIT_FRAMES[phase].frame
  const criteria = [...L.criteria, ...(phase === 'impl' ? unitList(L).flatMap((u) => u.acceptance) : [])]
  const files = {
    'goal.md': `${frame}\n\n${items(L.goal.items)}\n`, 'request.md': `${L.request}\n`,
    ...(criteria.length ? { 'criteria.md': `${items(criteria)}\n` } : {}), ...(L.constraints.length ? { 'constraints.md': `${items(L.constraints)}\n` } : {}),
    ...(L.decisions != null ? { 'decisions.md': `${L.decisions}\n` } : {}),
    'lenses.json': `${JSON.stringify([AUDIT_FRAMES[phase].lens])}\n`,
  }
  const inDir = path.join(dir, 'audit', 'in', phase)
  for (const f of existsSync(inDir) ? readdirSync(inDir) : []) if (!(f in files)) rmSync(path.join(inDir, f))
  for (const [f, t] of Object.entries(files)) writeAtomic(path.join(inDir, f), t)
  const state = auditState(dir)
  const inFile = (f) => path.join(inDir, f)
  const frameKey = sha(C.canon({ phase, targets: [...targets].sort(), files })).slice(0, 16)
  const exists = existsSync(auditPhaseFile(state))
  // 同じ段・同じ入力で返した argv を流した後（取り込みの前）なら、argv を返さずに続けさせる。init の枠（audit_start を持たない）は phase.json がその段にあれば流した後とみなし、
  // reframe の枠は phase.json の段の始まりが控え（audit_start）から変わったときだけ流した後とみなす。控えか今の値が分からなければ framed にしない。
  const F = L.audit_frame
  const same = !!F && F.phase === phase && F.key === frameKey
  const cur = exists ? auditPosOf(state) : undefined
  const framed = exists && same && !!cur && cur.phase === phase && cur.start !== null
    && (!Object.hasOwn(F, 'audit_start') || (typeof F.audit_start === 'string' && F.audit_start !== cur.start))
  if (!framed && !exists) L.audit_frame = { phase, key: frameKey }
  else if (!framed) {
    // 同じ枠の間は最初の控えを保つ（読めない phase.json や phase_start の無い phase.json で控えを置き換えない）。
    const keep = same && typeof F.audit_start === 'string' ? F.audit_start : null
    L.audit_frame = { phase, key: frameKey, audit_start: keep ?? (cur && cur.start !== null ? cur.start : null) }
  }
  L.pending = { step: 'audit', phase, key: keys[phase], audit_state: state }
  const audit = {
    state, goal: inFile('goal.md'), request: inFile('request.md'),
    ...Object.fromEntries(['criteria', 'constraints', 'decisions'].filter((k) => files[`${k}.md`]).map((k) => [k, inFile(`${k}.md`)])), targets,
  }
  // 設計レビューだけ、関係する資産を結ぶ id の型（境界の行・受け入れ・振る舞い）を --link で渡す。ほかの段では渡さない（reframe で link は null に戻る）。
  const frameArgv = [...['goal', 'request', 'criteria', 'constraints', 'decisions'].flatMap((k) => (audit[k] ? [`--${k}`, audit[k]] : [])), '--lenses', inFile('lenses.json'), ...targets.flatMap((f) => ['--target', f]), '--phase', phase, ...(phase === 'design' ? ['--link', C.LINK_PATTERN] : [])]
  if (framed) audit.framed = true
  else if (exists) audit.reframe_argv = ['reframe', '--state', state, ...frameArgv]
  else audit.init_argv = ['init', '--state', state, ...frameArgv, '--goal-checked', 'coverage-build']
  return {
    step: 'audit', phase, cycle: L.cycle, audit,
    then: framed
      ? `coverage-audit の台帳は既にこの段にある（argv は無い）。coverage-audit の next から止まるまで回し、import-audit --state ${dir} を流す（coverage-audit が止まったときに書く ${auditStatusFile(state, phase)} を CLI が読む）`
      : `coverage-audit の CLI に audit.${exists ? 'reframe_argv' : 'init_argv'} をそのまま渡し、coverage-audit を止まるまで回し、import-audit --state ${dir} を流す（coverage-audit が止まったときに書く ${auditStatusFile(state, phase)} を CLI が読む）`,
  }
}

function cmdInit(o) {
  const dir = path.resolve(need(o, 'state'))
  if (existsSync(ledgerPath(dir))) throw new Fail(`台帳が既にある: ${ledgerPath(dir)}（持ち越すときは next を流す）`)
  const mode = need(o, 'mode')
  if (!['create', 'update', 'review'].includes(mode)) throw new Fail(`--mode は create・update・review: ${mode}`)
  const repo = path.resolve(need(o, 'repo'))
  const inputs = (o.input || []).map((p) => path.resolve(p))
  const targets = (o.target || []).map((p) => path.resolve(p))
  if (mode !== 'create' && !targets.length) throw new Fail(`${mode} には既にある対象（--target）が要る`)
  if (mode === 'create' && targets.length) throw new Fail('create は対象を持たない（読む材料は --input で渡す）')
  const missing = [repo, ...inputs, ...targets].filter((p) => !existsSync(p))
  if (missing.length) throw new Fail('読めないファイルがある（台帳は作っていない）', { stop: 'blocked', cause: 'input', missing })
  const checks = (o.check || []).map((c, i) => {
    let argv
    try { argv = JSON.parse(c) } catch { throw new Fail(`--check は argv の JSON 配列: ${c}`) }
    if (!Array.isArray(argv) || !argv.length || argv.some((x) => typeof x !== 'string' || !x)) throw new Fail(`--check は空でない文字列の配列: ${c}`)
    return { id: `CHK${i + 1}`, argv }
  })
  if (mode === 'review' && checks.length) throw new Fail('review は check を流さない（実装しないので）')
  const roles = { ...JSON.parse(read(path.join(HERE, 'roles.json'))), ...(o.roles ? JSON.parse(read(o.roles)) : {}) }
  const text = {
    goal: read(need(o, 'goal')).trim(), request: read(need(o, 'request')).trim(), decisions: o.decisions ? read(o.decisions).trim() : null,
    criteria: o.criteria ? read(o.criteria) : '', constraints: o.constraints ? read(o.constraints) : '',
  }
  const g = readGoalFiles(text)
  if (g.problems.length) throw new Fail('目標・基準・制約に、引用の照合を通らない項目がある（台帳は作っていない。直して init をやり直す）', { problems: g.problems })
  const L = newLedger({
    mode, repo, goal: text.goal, goalItems: g.goal, request: text.request, decisions: text.decisions, criteria: g.criteria, constraints: g.constraints,
    inputs, targets, checks, config: posInts(o, LIMIT_KEYS), roles,
  })
  mkdirSync(dir, { recursive: true })
  save(dir, L)
  return { ok: true, state: dir, mode, hint: `ヒントは node ${path.join(HERE, 'build-cli.mjs')} hint --state ${dir} --text "..." で足せる（実行中も止まっている間も）` }
}

function cmdNext(o) {
  const dir = path.resolve(need(o, 'state'))
  const L = load(dir)
  // blocked（failure）の後の next は、原因を直した再開として扱い、連続の数と、全ての役が欠けた呼び出しで増えた試行を戻す。
  if (L.stopped && L.stopped.stop === 'blocked' && L.stopped.cause === 'failure') {
    L.fail_streak = 0
    for (const [k, n] of Object.entries(L.env_attempts || {})) if (k in L.attempts) { L.attempts[k] -= n; if (L.attempts[k] <= 0) delete L.attempts[k] }
    L.env_attempts = {}
  }
  for (;;) {
    writeDesign(L, dir)
    const keys = keysOf(L, dir)
    const missing = [...L.inputs, ...L.targets].filter((p) => !existsSync(p))
    const d = decide(L, { keys, missing })
    if (d.stop) {
      L.stopped = { ...d, cycle: L.cycle }
      L.pending = null
      save(dir, L)
      return { ...d, cycle: L.cycle, routes: L.mode === 'review' ? L.routes : undefined, next_args: d.stop === 'complete' ? null : { state: dir } }
    }
    if (d.step === 'route') { route(L); continue } // 静的な段: agent を起動しない
    L.stopped = null
    if (d.step === 'audit') { const out = prepAudit(L, dir, d.phase, keys); save(dir, L); return out }
    if (d.step === 'checks') {
      L.pending = { step: 'checks', key: keys.impl }
      save(dir, L)
      return { step: 'checks', cycle: L.cycle, checks: L.checks, then: `run-checks --state ${dir} を background で流し、終わるまで待つ` }
    }
    const unread = hints(dir).filter((h) => !L.hints_read.includes(h.id))
    const args = buildArgs(L, d, dir, unread)
    args.callId = sha(JSON.stringify(args)).slice(0, 12)
    args.argsSum = C.argsSum(args)
    const argsPath = path.join(dir, `call-${args.callId}.json`)
    writeAtomic(argsPath, JSON.stringify(args))
    const write = ['tests', 'implement'].includes(d.step)
    L.pending = { call_id: args.callId, step: d.step, args_path: argsPath, hints: unread.map((h) => h.id), cycle: L.cycle, ...(write ? { before: hashesNow(L) } : {}) }
    save(dir, L)
    return { step: d.step, call_id: args.callId, workflow: path.join(HERE, WF[d.step]), args_path: argsPath, args_bytes: Buffer.byteLength(JSON.stringify(args)), estimate_agents: estimate(d.step, args), cycle: L.cycle }
  }
}
const hashesNow = (L) => Object.fromEntries(ownedPaths(L).map((p) => [p, fileHash(abs(L, p))]))

// native Workflow の tasks の .output（返り値を result に包んだ形）も、そのまま受け付ける。
export function unwrap(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return v
  return Object.hasOwn(v, 'result') && typeof v.summary === 'string' && typeof v.agentCount === 'number' ? v.result : v
}

function recordCall(L, res, step) {
  const ag = Array.isArray(res.agents) ? res.agents : []
  for (const a of ag) L.agents.push({ call_id: res.call_id, cycle: L.cycle, stage: step, role: a.role, label: a.label, model: a.model, effort: a.effort, ok: !!a.ok })
  L.calls.push({ call_id: res.call_id, cycle: L.cycle, step, agents: ag.length, failed: ag.filter((a) => !a.ok).length, tokens: res.tokens ?? null, tokens_note: res.tokens == null ? '消費量を run の中で読めない経路（runner など）' : 'この呼び出しの budget.spent() の差' })
  L.fail_streak = ag.length && ag.every((a) => !a.ok) ? L.fail_streak + 1 : 0
  for (const a of ag) if (!a.ok) addEvent(L, { stage: step, kind: 'agent_missing', text: `${a.label}（${a.model}/${a.effort}）が返らなかったか、schema に合わない出力だった` })
}

function cmdIngest(o) {
  const dir = path.resolve(need(o, 'state'))
  const L = load(dir)
  const p = L.pending
  if (!p || !p.call_id) throw new Fail('受け取る Workflow の呼び出しが無い（next を先に流す）')
  const res = unwrap(JSON.parse(read(need(o, 'result'))))
  if (!res || res.call_id !== p.call_id || res.stage !== p.step) throw new Fail(`呼び出しが違う: 待っているのは ${p.step}/${p.call_id}、受け取ったのは ${res && res.stage}/${res && res.call_id}`)
  if (res.status === 'blocked' && res.reason === 'args の検査に落ちた') throw new Fail('Workflow が args を拒否した（args_path のファイルの中身を書き換えずに渡し直す）', { problems: res.problems })
  const args = JSON.parse(read(p.args_path))
  recordCall(L, res, p.step)
  const seen = L.events.length
  const before = { ...L.attempts }
  if (p.step === 'design') ingestDesign(L, res, args, reader(L, dir), () => premisePaths(L))
  else if (p.step === 'retro') ingestRetro(L, res, args, reader(L, dir))
  else ingestWrite(L, res, args, p.before, hashesNow(L))
  // 全ての役が欠けた呼び出しで増えた試行は env_attempts にも数え、blocked（failure）から再開したときに戻す（coverage-audit と同じ）。
  L.env_attempts = L.env_attempts || {}
  const ag = Array.isArray(res.agents) ? res.agents : []
  if (ag.length && ag.every((a) => !a.ok)) for (const [k, n] of Object.entries(L.attempts)) if (n > (before[k] || 0)) L.env_attempts[k] = (L.env_attempts[k] || 0) + n - (before[k] || 0)
  for (const k of Object.keys(L.env_attempts)) if (!(k in L.attempts)) delete L.env_attempts[k]
  L.hints_read.push(...p.hints)
  L.pending = null
  save(dir, L)
  // 受け付けなかった出力（rejected_output・write_outside）の理由。ok は「呼び出しを台帳に取り込んだ」ことを指す。
  const rejected = L.events.slice(seen).filter((e) => e.kind === 'rejected_output' || e.kind === 'write_outside').map((e) => e.text)
  return { ok: true, cycle: L.cycle, ...(rejected.length ? { rejected } : {}), next: 'next を流す' }
}

function cmdImportAudit(o) {
  const dir = path.resolve(need(o, 'state'))
  const L = load(dir)
  const p = L.pending
  if (!p || p.step !== 'audit') throw new Fail('取り込む coverage-audit が無い（next が audit を返した後に流す）')
  const file = auditStatusFile(p.audit_state, p.phase)
  if (!existsSync(file)) throw new Fail(`coverage-audit の status のファイルが無い: ${file}（coverage-audit を止まるまで回してから流す）`, { phase: p.phase, status_path: file })
  let status
  try { status = unwrap(JSON.parse(read(file))) } catch (e) { throw new Fail(`coverage-audit の status のファイルを読めない: ${file}（${e.message}）`, { phase: p.phase, status_path: file }) }
  // coverage-audit の status は段ごとに分かれる。上の階層は今の段の節なので、待っている段と同じ段の status だけを受ける。
  if (!status || status.phase !== p.phase) throw new Fail(`待っている段と違う段の status（待っているのは ${p.phase}、受け取ったのは ${status && status.phase}）。coverage-audit の台帳をこの段にしてから（next の audit の argv）流し直す`, { phase: p.phase })
  writeDesign(L, dir)
  const now = keysOf(L, dir)[p.phase]
  if (now !== p.key) throw new Fail('検査に渡した後に対象が変わった（next からやり直す）', { phase: p.phase })
  const designD = designDir(dir)
  const unitOfPath = (f) => {
    if (path.dirname(f) === designD) { const m = /^(U\d+)\.md$/.exec(path.basename(f)); return { unit: m ? m[1] : null, test: false } }
    return ownerOf(L, path.relative(L.repo, f))
  }
  let base
  try { base = importAudit(L, status, p.phase, { readText: reader(L, dir), unitOfPath }) } catch (e) { throw new Fail(e.message) }
  writeAtomic(path.join(dir, 'audit', `${p.phase}-status.json`), JSON.stringify(status, null, 1))
  L.audit_frame = null
  // metrics は coverage-audit の run の指標（指摘の出どころの内訳・持ち越した読みの数・全体の段で落とした数と確認で復活した数）。
  L.audits[p.phase] = { imported: p.key, state: p.audit_state, cycle: L.cycle, not_seen: base.not_seen, findings: (status.findings && status.findings.confirmed || []).length, references: base.references, metrics: status.metrics || null }
  if (p.phase !== 'baseline') L.retro.due = true
  L.pending = null
  save(dir, L)
  return { ok: true, phase: p.phase, imported_findings: L.audits[p.phase].findings, not_seen: base.not_seen.length, next: 'next を流す' }
}

function cmdRunChecks(o) {
  const dir = path.resolve(need(o, 'state'))
  const L = load(dir)
  if (!L.pending || L.pending.step !== 'checks') throw new Fail('流す check が無い（next が checks を返した後に流す）')
  if (keysOf(L, dir).impl !== L.pending.key) throw new Fail('next の後に実装のファイルが変わった（next からやり直す）')
  const results = []
  for (const c of L.checks) {
    const r = spawnSync(c.argv[0], c.argv.slice(1), { cwd: L.repo, encoding: 'utf8', timeout: CHECK_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 })
    const out = `${r.stdout || ''}${r.stderr || ''}${r.error ? `\n${r.error.message}` : ''}`
    const log = path.join(dir, 'checks', `${c.id}.log`)
    writeAtomic(log, out)
    const code = r.status ?? -1
    results.push({ id: c.id, argv: c.argv, code, log })
    if (code !== 0) addEvent(L, { stage: 'checks', kind: 'check_failed', text: `${c.id} ${JSON.stringify(c.argv)} が exit ${code} で失敗した（出力: ${log}。末尾: ${out.slice(-600).replace(/\s+/g, ' ')}）` })
  }
  if (keysOf(L, dir).impl !== L.pending.key) throw new Fail('check の実行中に実装のファイルが変わった（記録しない。next からやり直す）')
  L.checks_run = { key: L.pending.key, cycle: L.cycle, results }
  if (results.some((r) => r.code !== 0)) L.retro.due = true
  L.pending = null
  save(dir, L)
  return { ok: true, passed: results.every((r) => r.code === 0), results }
}

function cmdStatus(o) {
  const dir = path.resolve(need(o, 'state'))
  const L = load(dir)
  const roles = {}
  for (const a of L.agents) { const k = `${a.role}|${a.model}|${a.effort}`; roles[k] = roles[k] || { launched: 0, failed: 0 }; roles[k].launched++; if (!a.ok) roles[k].failed++ }
  return {
    mode: L.mode, cycle: L.cycle, stopped: L.stopped, pending: L.pending, goal_checked: L.goal.checked,
    units: unitList(L).map((u) => ({ id: u.id, kind: u.kind, title: u.title, designed: !!u.design_hash && !u.need_design, tests: u.kind === 'code' ? u.tests_for === u.design_hash : null, implemented: u.impl_for === u.design_hash, rounds: u.rounds })),
    audits: Object.fromEntries(PHASES.filter((p) => L.audits[p]).map((p) => [p, { cycle: L.audits[p].cycle, findings: L.audits[p].findings, not_seen: L.audits[p].not_seen, references: L.audits[p].references || [], metrics: L.audits[p].metrics || null }])),
    checks: L.checks_run, routes: L.routes, facts: L.facts.map((f) => ({ id: f.id, layer: f.layer, cause: f.cause, basis: f.basis })),
    human: L.human.map((h) => ({ ...h, answered: L.answers.some((a) => a.id === h.id) })), notes: L.notes,
    events_not_in_retro: dueEvents(L).map((e) => ({ id: e.id, stage: e.stage, kind: e.kind })), agents_by_role: roles, calls: L.calls,
  }
}

function cmdHint(o) {
  const dir = path.resolve(need(o, 'state'))
  const L = load(dir)
  if (L.stopped && L.stopped.stop === 'complete') throw new Fail('完了した台帳にはヒントを足せない（読まれない）')
  const id = `H${hints(dir).length + 1}`
  appendFileSync(path.join(dir, 'hints.jsonl'), `${JSON.stringify({ id, text: need(o, 'text') })}\n`)
  return { ok: true, id }
}

// answer: 目標・受け入れ基準・制約・決定の記録はファイルの中身を置き換え、引用を照らし直してから目標の照合をやり直す。
// それ以外の id への回答は、利用者の言葉として決定の記録に足し、その行を引用する制約にして方式設計からやり直す。dismiss は記録だけ。
const GOAL_FILES = { goal: 'goal', criteria: 'criteria', constraints: 'constraints', decisions: 'decisions' }
const itemsText = (xs) => xs.map((c) => `- ${c.id}: ${c.text}${c.cites.map((q) => ` 〔${q.source}: ${q.quote}〕`).join('')}`).join('\n')
// 回答から作る制約の id: 目標・基準・制約の id に無い最小の A<n>（利用者が書いた A<n> や、coverage-build から渡った A<n> と重ねない）。
const freeAnswerId = (ids) => { let n = 1; while (ids.includes(`A${n}`)) n++; return `A${n}` }
function cmdAnswer(o, dismiss = false) {
  const dir = path.resolve(need(o, 'state'))
  const L = load(dir)
  const id = need(o, 'id')
  if (id in GOAL_FILES) {
    if (dismiss) throw new Fail(`${id} は dismiss できない`)
    const body = o.file ? read(o.file) : need(o, 'text')
    const text = { goal: L.goal.text, request: L.request, decisions: L.decisions, criteria: itemsText(L.criteria), constraints: itemsText(L.constraints), [id]: id === 'goal' || id === 'decisions' ? body.trim() : body }
    const g = readGoalFiles(text)
    if (g.problems.length) throw new Fail(`直した ${id} が引用の照合を通らない（台帳は変えていない）`, { problems: g.problems })
    Object.assign(L, { goal: { text: text.goal, items: g.goal, checked: false, problems: [] }, decisions: text.decisions, criteria: g.criteria, constraints: g.constraints, need_arch: L.mode !== 'review' })
    delete L.attempts.goal
    for (const p of ['design', 'impl', 'review']) delete L.audits[p] // 照らす目標・基準が変わったので、中身が同じでもレビューをやり直す
    save(dir, L)
    return { ok: true, next: '目標の照合からやり直す。next を流す' }
  }
  const text = need(o, 'text')
  const isQ = (L.arch && L.arch.questions || []).some((q) => q.id === id)
  const known = isQ || L.human.some((h) => h.id === id) || id.startsWith('attempts:')
  if (!known) throw new Fail(`台帳に無い id: ${id}`)
  if (id.startsWith('cycles#')) { // 周の上限: answer は保留したやり直しを当てて上限を 1 増やし、dismiss は当てずに捨てる
    const p = L.pending_redo
    if (!p || p.id !== id) throw new Fail(`${id} に保留したやり直しが無い（答え済みか捨て済み。台帳は変えていない）`)
    L.answers.push({ id, text, dismiss })
    L.pending_redo = null
    if (dismiss) L.notes.push(`${id} を dismiss し、保留したやり直しを捨てた: ${redoSummary(p)}`)
    else applyRedo(L, p)
    save(dir, L)
    return { ok: true }
  }
  if (id.startsWith('attempts:')) delete L.attempts[id.slice('attempts:'.length)]
  const rounds = id.startsWith('rounds:') ? id.slice('rounds:'.length).split('#')[0] : null // rounds:<単位か arch>#<周>
  if (rounds === 'arch') L.arch_rounds = 0
  else if (rounds && L.units[rounds]) L.units[rounds].rounds = 0
  L.answers.push({ id, text, dismiss })
  if (!dismiss && !id.startsWith('attempts:') && !id.startsWith('rounds:')) {
    const said = `${id} への利用者の回答: ${text.replace(/\s*\n\s*/g, ' ')}`
    L.decisions = `${L.decisions != null ? `${L.decisions}\n` : ''}- ${said}`
    L.constraints.push({ id: freeAnswerId(goalIds(L)), text: said, cites: [{ source: 'decisions', quote: said }] })
    if (L.mode !== 'review') L.need_arch = true
  }
  save(dir, L)
  return { ok: true }
}

function cmdConfig(o) {
  const dir = path.resolve(need(o, 'state'))
  const config = posInts(o, LIMIT_KEYS)
  const L = load(dir)
  Object.assign(L.config, config)
  save(dir, L)
  return { ok: true, config: L.config }
}

export function main(argv) {
  try {
    const o = parse(argv)
    const cmd = o._[0]
    const f = { init: cmdInit, next: cmdNext, ingest: cmdIngest, 'import-audit': cmdImportAudit, 'run-checks': cmdRunChecks, status: cmdStatus, hint: cmdHint, answer: (x) => cmdAnswer(x), dismiss: (x) => cmdAnswer(x, true), config: cmdConfig }[cmd]
    if (!f) throw new Fail(`使い方: build-cli.mjs <${Object.keys(KNOWN).join('|')}> --state DIR ...（未知のコマンド: ${cmd}）`)
    return { code: 0, output: f(o) }
  } catch (e) {
    if (e instanceof Fail) return { code: 2, output: { ok: false, error: e.message, ...e.extra } }
    return { code: 1, output: { ok: false, error: String((e && e.stack) || e) } }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = main(process.argv.slice(2))
  process.stdout.write(`${JSON.stringify(r.output, null, 1)}\n`)
  process.exitCode = r.code
}
