// 台帳の決定的な部分: 単位・hash・次の 1 手・受け入れ・振り返りのグラフ・層への戻し・coverage-audit の取り込み。
// 役の出力の静的な照合と結果の形は build-step.js の <checks> 区間が正本で、ここはそれを読み込んで使う（写しを持たない）。
// 役の提出（submit）の照合はここで行う（Workflow source は照合しない。設計「台帳と見たの記録」の B2・B5）。
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

const SRC = readFileSync(new URL('./build-step.js', import.meta.url), 'utf8')
export const C = new Function(`${SRC.slice(SRC.indexOf('// <checks>'), SRC.indexOf('// </checks>'))}
return { LIMITS, MAX_UNIT_PATHS, MAX_SPEC_LINES, ARCH_INVARIANTS, LINK_PATTERN, VAGUE_WORDS, AUDIT_LAYERS, LAYERS, LAYER_MAP, canon, norm, quoteProblem, waves, checkArch, checkSpec, checkIntents, checkExam, checkJudge, parseCited, citeSources, checkCited, checkGoalMap, goalGaps, readGoalFiles,
  GOAL_SCHEMA, ARCH_SCHEMA, SPEC_SCHEMA, WRITE_SCHEMA, INTENTS_SCHEMA, EXAM_SCHEMA, JUDGE_SCHEMA, RESULT_SCHEMAS, shapeProblems }`)()

// 同じ担当（目標の照合・方式設計・単位の詳細設計・テスト・実装・振り返りの計画、意図ごとの実行と検証）の欠け（提出されない・照合に落ちる）の上限。
// 照合に落ちた提出は同じ体が出し直すので、1 回の呼び出しの中の出し直しも数える。run をまたいで数える。
export const MAX_ATTEMPTS = 2
// 1 体に詰める単位の量の線は、coverage-audit の lineOf に単位を詰める役（詳細設計・テスト・実装の役）を渡して、roles.json の context_tokens から導く
// （build-cli.mjs の buildWave）。UNIT_MAX_BYTES は、役が context_tokens を持たないときの既定の線（テストが fixture の大きさに使う）。
export { UNIT_MAX_BYTES } from '../../coverage-audit/scripts/ledger-core.mjs'
export const DRY_ROUNDS = 2 // 振り返りで新しい原因が受理されない周がこの回数続いたら止める
export const RETRO_MAX_ROUNDS = 2 // 1 回の振り返りの周の上限
const MAX_FAIL_STREAK = 2 // 提出が 1 件も無い呼び出し（全ての役が欠けた・担当に手を付けずに返った）がこの回数続いたら止める
const DEFAULT_CONFIG = { max_cycles: 2, max_agents_total: 400, max_unit_rounds: 2 }
const RANK = { 目標: 0, 設計: 1, 実装: 2 } // 上流ほど小さい。進め方は成果物の層でなく、報告だけにする
// 成果物でなく進め方の出来事（原因が確かめられなければ進め方として報告に回す）。
const PROCESS_KINDS = ['agent_missing', 'rejected_output', 'not_seen', 'write_outside', 'import_mismatch', 'input_not_read', 'unit_removed', 'audit_internal', 'launch_mismatch']
export const PHASES = ['baseline', 'design', 'impl', 'review']
// 検査を挟む段の選択（init・config の --audit-phases）で選べる段。既定は全て。review の検査は review の本体なので外せない。
export const AUDIT_PHASES = ['baseline', 'design', 'impl']
const MODE_AUDITS = { create: ['design', 'impl'], update: ['baseline', 'design', 'impl'], review: [] }
// 外した段（mode が流す段のうち、--audit-phases に無いもの）と理由。status と停止の報告に段ごとに出す。
export const skippedAudits = (L) => MODE_AUDITS[L.mode].filter((p) => !L.audit_phases.includes(p)).map((phase) => ({ phase, reason: `--audit-phases（${L.audit_phases.join(',')}）で外したので、この段の検査（coverage-audit）を流していない。この段の指摘・見ていない単位の記録は無い` }))

export const sha = (s) => createHash('sha256').update(String(s)).digest('hex')
const arr = (a) => (Array.isArray(a) ? a : [])

export const readGoalFiles = C.readGoalFiles
export const goalIds = (L) => [...L.goal.items, ...L.criteria, ...L.constraints].map((c) => c.id)
export const goalSources = (L) => C.citeSources({ request: L.request, ...(L.decisions != null ? { decisions: L.decisions } : {}) })

export function newLedger({ mode, repo, goal, goalItems, request, decisions, criteria, constraints, inputs, targets, checks, config, roles, auditPhases = null }) {
  return {
    version: 1, rev: 0, mode, repo, cycle: 1, goal: { text: goal, items: goalItems, checked: false, problems: [] }, request, decisions, criteria, constraints, inputs, targets, checks,
    config: { ...DEFAULT_CONFIG, ...config }, roles, arch: null, need_arch: mode !== 'review', arch_rounds: 0, arch_causes: [], units: {}, audits: {}, baseline: null,
    checks_run: null, events: [], facts: [], intents: [], retro: { rounds: 0, dry: 0, due: false, open: null }, human: [], answers: [], notes: [], routes: [], pending_redo: null,
    attempts: {}, env_attempts: {}, fail_streak: 0, agents: [], calls: [], call_seq: 0, hints_read: [], pending: null, stopped: null, audit_frame: null, audit_events_seen: [], audit_groups: {},
    wave_seq: 0, audit_phases: auditPhases || [...AUDIT_PHASES], audit_halt: null,
  }
}

const unitFields = (u) => ({ id: u.id, kind: u.kind, title: u.title, responsibility: u.responsibility, paths: u.paths, tests: u.tests, test_uses: u.test_uses, depends_on: u.depends_on, covers: u.covers })
const SPEC_FIELDS = ['spec', 'acceptance', 'behaviors', 'partitions', 'cases', 'premises', 'unverified', 'allowed_optional']
// 単位が作るか使う境界の約束と、その行 id（X<n>-<行の位置>）。
export const contractsOf = (L, id) => arr(L.arch && L.arch.contracts).filter((c) => c.producer === id || arr(c.consumers).includes(id))
export const rowIdsOf = (L, id) => contractsOf(L, id).flatMap((c) => arr(c.rows).map((_, i) => `${c.id}-${i + 1}`))
// 詳細設計の hash: 単位の欄・詳細設計の欄と、その単位が関わる境界の約束（行を含む）。どれかが変われば tests と impl が無効になる。
export const designHash = (u, L) => sha(C.canon({ ...unitFields(u), ...Object.fromEntries(SPEC_FIELDS.map((k) => [k, u[k]])), contracts: contractsOf(L, u.id) })).slice(0, 16)
export const unitList = (L) => arr(L.arch && L.arch.units).map((id) => L.units[id]).filter(Boolean)
export const ownedPaths = (L) => unitList(L).flatMap((u) => [...u.paths, ...u.tests])
export function ownerOf(L, rel) {
  for (const u of unitList(L)) { if (u.paths.includes(rel)) return { unit: u.id, test: false }; if (u.tests.includes(rel)) return { unit: u.id, test: true } }
  return { unit: null, test: false }
}
// 単位の covers の受け皿: 受け入れ基準と制約。どちらも 0 件なら目標の項目の id を受け皿にする（受け皿が無いと方式設計が「covers が空」で必ず落ちる）。
export function coverIds(L) {
  const ids = [...L.criteria, ...L.constraints].map((c) => c.id)
  return ids.length ? ids : L.goal.items.map((c) => c.id)
}
const dependents = (L, id) => {
  const out = new Set([id])
  for (let grew = true; grew;) { grew = false; for (const u of unitList(L)) if (!out.has(u.id) && u.depends_on.some((d) => out.has(d))) { out.add(u.id); grew = true } }
  return [...out]
}

// 設計の写し: 方式設計 1 枚と単位ごとに 1 枚。coverage-audit の資産はファイルの中のブロック（段落・箇条書き・表など）で切られるが、資産の id は path を含むので、指摘のファイルから単位が決まる。
export function renderDesign(L) {
  if (!L.arch) return {}
  const us = unitList(L)
  const contracts = arr(L.arch.contracts).flatMap((c) => ['', `### ${c.id}: ${c.subject}（${c.producer} → ${c.consumers.join(', ')}）`, '', '| 行 id | 値 | 作る側 | 使う単位ごとの扱い |', '|---|---|---|---|',
    ...c.rows.map((r, i) => `| ${c.id}-${i + 1} | ${r.value} | ${r.producer_does} | ${r.handling.map((h) => `${h.unit}: ${h.does}`).join('<br>')} |`)])
  const copies = arr(L.arch.copies)
  const files = {
    '_architecture.md': [`# 方式設計`, '', '| 単位 | 種類 | 責務 | 持つファイル | テスト | 依存 | 効く基準・制約 | テストが前提にするもの |', '|---|---|---|---|---|---|---|---|',
      ...us.map((u) => `| ${u.id} ${u.title} | ${u.kind} | ${u.responsibility} | ${u.paths.join('<br>')} | ${u.tests.join('<br>') || '-'} | ${u.depends_on.join(', ') || '-'} | ${u.covers.join(', ')} | ${arr(u.test_uses).join('<br>') || '-'} |`),
      '', '## 方式設計の照合が保証すること', '', ...C.ARCH_INVARIANTS.map((x) => `- ${x}`),
      '', '## 境界の約束（作る側の値 × 使う単位ごとの扱い）', ...(contracts.length ? contracts : ['', '- なし']),
      '', '## 写し（同じ規則を置く 2 つ以上のファイル）', '', ...(copies.length ? ['| id | 規則 | 正本 | 写し | 一致を照らすテスト |', '|---|---|---|---|---|', ...copies.map((c) => `| ${c.id} | ${c.rule} | ${c.canonical} | ${c.copies.join('<br>')} | ${c.check} |`)] : ['- なし'])].join('\n') + '\n',
  }
  for (const u of us) {
    const acc = (ns) => arr(ns).map((n) => `${u.id}A${n}`).join(', ')
    const section = (head, xs) => (xs.length ? ['', `**${head}**`, '', ...xs] : [])
    files[`${u.id}.md`] = [`# ${u.id}: ${u.title}`, '', `**責務**: ${u.responsibility}`, '', `**持つファイル**: ${u.paths.join(', ')}`, ...(u.tests.length ? ['', `**テスト（実装より先に別の担当が書く）**: ${u.tests.join(', ')}`] : []),
      '', '**仕様**', '', u.spec || '（未設計）', '', '**受け入れ**', '', ...u.acceptance.map((a) => `- ${a.id}: ${a.text}`),
      ...section('振る舞い', arr(u.behaviors).map((b, i) => `- ${u.id}S${i + 1}: ${b.text}（受け入れ: ${acc(b.accepts)}${arr(b.rows).length ? `／境界: ${b.rows.join(', ')}` : ''}）`)),
      ...(u.cases.length ? ['', '**ケース**', '', '| id | 条件 | 期待 | 受け入れ | 分け方 |', '|---|---|---|---|---|', ...u.cases.map((c, i) => `| ${u.id}C${i + 1} | ${c.condition} | ${c.expect} | ${acc(c.accepts) || '-'} | ${arr(c.covers).join(', ') || '-'} |`)] : []),
      ...section('分け方', arr(u.partitions).map((p) => `- ${p.name}: ${p.values.join(' / ')}`)),
      ...section('前提（script が引用を照らし済み）', arr(u.premises).map((p) => `- ${p.claim}（${p.path}: 「${p.quote}」）`)),
      ...section('確かめていない前提', arr(u.unverified).map((x) => `- ${x.claim} → 崩れたとき: ${x.if_broken}`)),
      ...section('決めきらない語を残した箇所', arr(u.allowed_optional).map((x) => `- 「${x.quote}」: ${x.why}`))].join('\n') + '\n'
  }
  return files
}

const eventId = (L) => `E${L.events.length + 1}`
export function addEvent(L, e) { const ev = { id: eventId(L), cycle: L.cycle, retro: null, unit: null, test: false, layer: null, ...e }; L.events.push(ev); return ev }
export const dueEvents = (L) => L.events.filter((e) => !e.retro)
// 設計レビューの群の id（c<周>:<段>:<群の id>）→ その群に入る出来事の id。
const groupMembers = (L) => {
  const m = new Map()
  for (const e of L.events) for (const g of arr(e.groups)) m.set(g, [...(m.get(g) || []), e.id])
  return m
}
// 受理した原因（事実）が、どの出来事を根拠に辿るか。basis の群の id は、その群の全ての出来事を辿る。
function coveredBy(L) {
  const facts = new Map(L.facts.map((f) => [f.id, f]))
  const members = groupMembers(L)
  const memo = new Map()
  const evOf = (id, seen = new Set()) => {
    if (!facts.has(id)) return new Set(members.get(id) || [id])
    if (memo.has(id)) return memo.get(id)
    if (seen.has(id)) return new Set()
    seen.add(id)
    const s = new Set(facts.get(id).basis.flatMap((b) => [...evOf(b, seen)]))
    memo.set(id, s)
    return s
  }
  const by = new Map()
  for (const f of L.facts) for (const e of evOf(f.id)) by.set(e, [...(by.get(e) || []), f])
  return by
}
export function retroConcluded(L) {
  const due = dueEvents(L)
  if (!due.length) return true
  const by = coveredBy(L)
  return due.every((e) => by.has(e.id)) || L.retro.dry >= DRY_ROUNDS || L.retro.rounds >= RETRO_MAX_ROUNDS
}

// 出来事ごとに戻す層を決める。振り返りの原因は層を上げられるが、下げられない（監査の層より下には戻さない）。
export function layerOf(e, facts) {
  const fl = facts.map((f) => f.layer)
  const art = [...fl, e.layer].filter((x) => x in RANK).sort((a, b) => RANK[a] - RANK[b])
  if (art.length) return art[0]
  if (fl.includes('進め方') || PROCESS_KINDS.includes(e.kind)) return '進め方'
  return null
}

// 振り返りの結論を、原因の層へ戻す。指摘の箇所だけを直す経路は無い（単位の設計か実装を丸ごとやり直す）。
export function route(L) {
  const by = coveredBy(L)
  const redo = { arch: false, design: new Set(), tests: new Set(), impl: new Set() }
  const causes = new Map()
  const note = (k, s) => causes.set(k, [...(causes.get(k) || []), s])
  for (const e of dueEvents(L)) {
    const fs = by.get(e.id) || []
    const layer = layerOf(e, fs)
    e.retro = L.cycle
    L.routes.push({ event: e.id, cycle: L.cycle, layer, unit: e.unit, by: fs.length ? fs.map((f) => f.id) : e.layer ? 'audit' : 'none' })
    if (L.mode === 'review') continue // 確かめるだけ。戻す先は報告に載せる
    const why = `${e.id}: ${e.text}${fs.length ? `（原因: ${fs.map((f) => `${f.id} ${f.cause}`).join(' / ')}）` : ''}`
    const human = (reason) => L.human.push({ id: e.id, reason, text: e.text })
    if (layer === null) human('原因の層を決められない')
    else if (layer === '目標') human('目標・方針の層の欠陥')
    else if (layer === '進め方') L.notes.push(why)
    else if (layer === '設計') { if (e.unit && L.units[e.unit]) { redo.design.add(e.unit); note(e.unit, why) } else { redo.arch = true; note('arch', why) } }
    else if (e.unit && L.units[e.unit]) { (e.test ? redo.tests : redo.impl).add(e.unit); note(e.unit, why) }
    else human('実装の欠陥だが、どの単位のものか決まらない')
  }
  const plan = { arch: redo.arch, design: [...redo.design], tests: [...redo.tests], impl: [...redo.impl], causes: Object.fromEntries(causes) }
  L.retro = { rounds: 0, dry: 0, due: false, open: null }
  if (!plan.arch && !plan.design.length && !plan.tests.length && !plan.impl.length) return
  // やり直すと周が上限を超えるなら、当てずに保留して人間に返す（answer で当て、dismiss で捨てる）。
  if (L.cycle + 1 > cycleLimit(L)) {
    const id = `cycles#${L.cycle}`
    L.pending_redo = { id, ...plan }
    L.human = L.human.filter((h) => h.id !== id) // dismiss の後に同じ周でまた超えたら、項目を差し替える
    L.human.push({ id, reason: `${cycleLimit(L)} 周で収束しない`, text: redoSummary(plan) })
    return
  }
  applyRedo(L, plan)
}

// 周の上限: max_cycles に、answer した cycles#<周> の件数（id ごとに 1 回）を足したもの。dismiss は周を進めないので数えない。
export const cycleLimit = (L) => L.config.max_cycles + new Set(L.answers.filter((a) => a.id.startsWith('cycles#') && !a.dismiss).map((a) => a.id)).size

// 保留したやり直しの層・単位と原因の要約（人間への判断材料と、dismiss の notes）。
export function redoSummary(plan) {
  const why = (k) => arr(plan.causes[k]).join(' / ') || '上流の単位の設計がやり直しになった'
  return [
    ...(plan.arch ? [`方式設計のやり直し（原因: ${why('arch')}）`] : []),
    ...plan.design.map((id) => `単位 ${id} の設計のやり直し（原因: ${why(id)}）`),
    ...plan.tests.map((id) => `単位 ${id} のテストと実装のやり直し（原因: ${why(id)}）`),
    ...plan.impl.map((id) => `単位 ${id} の実装のやり直し（原因: ${why(id)}）`),
  ].join('; ')
}

// やり直しを当てる。route から直接か、cycles#<周> への answer で保留から呼ぶ。
export function applyRedo(L, plan) {
  const touched = new Set()
  if (plan.arch) { L.need_arch = true; L.arch_rounds += 1; L.arch_causes = plan.causes.arch }
  for (const id of plan.design) for (const d of dependents(L, id)) { L.units[d].need_design = true; touched.add(d) }
  for (const id of plan.tests) { L.units[id].tests_for = null; L.units[id].impl_for = null; touched.add(id) }
  for (const id of plan.impl) { L.units[id].impl_for = null; touched.add(id) }
  for (const id of touched) { const u = L.units[id]; u.rounds += 1; u.causes = plan.causes[id] || [`上流の単位の設計がやり直しになった`] }
  // 超えた回ごとに別の id にする（同じ id だと、前の回答で次の超過も回答済みに見える）。
  if (L.arch_rounds > L.config.max_unit_rounds && plan.arch) L.human.push({ id: `rounds:arch#${L.cycle}`, reason: `方式設計のやり直しが ${L.config.max_unit_rounds} 回を超えた`, text: arr(L.arch_causes).join(' / ') })
  for (const id of touched) if (L.units[id].rounds > L.config.max_unit_rounds) L.human.push({ id: `rounds:${id}#${L.cycle}`, reason: `単位 ${id} のやり直しが ${L.config.max_unit_rounds} 回を超えた`, text: L.units[id].causes.join(' / ') })
  // やり直した後は、中身が同じでもレビューと check をやり直す（同じ欠陥が残れば、もう一度戻して上限で止まる）。
  L.cycle += 1; delete L.audits.impl; L.checks_run = null
  if (plan.arch || plan.design.length) delete L.audits.design
}

const answered = (L, id) => L.answers.some((a) => a.id === id)
// cycles#<周> は保留が残る間だけ開いている（dismiss は周を進めないので、捨てた後に同じ id がまた立ちうる）。
const open = (L, h) => (h.id.startsWith('cycles#') ? !!L.pending_redo && L.pending_redo.id === h.id : !answered(L, h.id))
export const testsTodo = (L) => unitList(L).filter((u) => u.kind === 'code' && !u.need_design && u.design_hash && u.tests_for !== u.design_hash)
// 実装を待つ単位（設計とテストが済み、実装が今の設計に無い）。依存がそろっているか（depsDone）は問わない。
export const implPending = (L) => unitList(L).filter((u) => !u.need_design && u.design_hash && u.impl_for !== u.design_hash && (u.kind === 'doc' || u.tests_for === u.design_hash))
// 依存する単位の実装が全て今の設計に済んでいるか。実装の担当はこれがそろった単位だけを claim で渡す。
export const depsDone = (L, u) => u.depends_on.every((d) => L.units[d] && L.units[d].impl_for === L.units[d].design_hash)
export const implTodo = (L) => implPending(L).filter((u) => depsDone(L, u))

// 次の 1 手か停止を、台帳と今のファイルの hash（keys）だけから決める。
export function decide(L, { keys = {}, missing = [] } = {}) {
  const stop = (kind, reasons, extra = {}) => ({ stop: kind, reasons, ...extra })
  if (missing.length) return stop('blocked', [`読めないファイル: ${missing.join(', ')}`], { cause: 'input' })
  if (L.fail_streak >= MAX_FAIL_STREAK) return stop('blocked', [`提出が 1 件も無い呼び出しが ${L.fail_streak} 回続いた`], { cause: 'failure' })
  if (L.agents.length >= L.config.max_agents_total) return stop('limit', [`起動数が上限 ${L.config.max_agents_total} に達した（${L.agents.length}）`])
  // 検査（coverage-audit）が取り込めない形で止まった（利用者への問い・試行の上限・計画の欠陥・blocked・limit）。検査の停止の種類と理由をそのまま返す。
  const H = L.audit_halt
  if (H) return stop(H.stop === 'needs_input' || H.stop === 'limit' ? H.stop : 'blocked', [`coverage-audit の検査（段 ${H.phase}）が ${H.stop} で止まった`, ...arr(H.reasons)], { ...(H.stop === 'needs_input' || H.stop === 'limit' ? {} : { cause: 'audit' }), audit: H })
  if (L.goal.problems.length) return stop('needs_input', ['依頼文・決定の記録が求める成果のうち、目標・基準・制約のどの項目も受け止めていないものがある'], { goal_gaps: L.goal.problems })
  const stuck = Object.entries(L.attempts).filter(([, n]) => n >= MAX_ATTEMPTS).map(([k]) => k)
  if (stuck.length) return stop('needs_input', ['試行の上限まで欠けた段がある'], { stuck })
  const human = L.human.filter((h) => open(L, h))
  if (human.length) return stop('needs_input', ['人間が決める欠陥がある（目標・方針の層、層を決められない、やり直しの上限、周の上限）'], { human })
  const openQ = arr(L.arch && L.arch.questions).filter((q) => !answered(L, q.id))
  if (openQ.length) return stop('needs_input', ['利用者への質問がある'], { questions: openQ })
  // 振り返りの段は、確かめる意図があれば実行役、結論の受理を待つ意図があれば検証役、どちらも無く原因を辿りきれていなければ計画役（次の巡）。
  if (L.retro.due) {
    if (queuedIntents(L).length) return { step: 'retro', task: 'exam' }
    if (examinedIntents(L).length) return { step: 'retro', task: 'judge' }
    return retroConcluded(L) ? { step: 'route' } : { step: 'retro', task: 'plan' }
  }
  const design = { step: 'design', task: !L.goal.checked ? 'goal' : L.need_arch ? 'arch' : 'spec' }
  // --audit-phases で外した段は検査しない（済んだものとして進め、外したことは status と停止の報告が開示する）。
  const runs = (p) => p === 'review' || arr(L.audit_phases).includes(p)
  const audited = (p) => !runs(p) || (L.audits[p] && L.audits[p].imported === keys[p])
  if (L.mode === 'review' && !L.goal.checked) return design // 目標の照合だけ（照合はこのスキルの 1 か所で行い、coverage-audit には照合済みとして渡す）
  if (L.mode === 'review') return audited('review') ? stop('complete', ['対象を検査し、振り返りで戻す先の層を決めた（確かめるだけで直さない）']) : { step: 'audit', phase: 'review' }
  // update: 目標の固定 → 現状の検査 → 設計。現状の検査は 1 度だけ（実装で対象が変わった後に、変わった対象を現状として検査し直さない）。
  if (L.mode === 'update' && !L.goal.checked) return design
  if (L.mode === 'update' && runs('baseline') && !L.audits.baseline) return { step: 'audit', phase: 'baseline' }
  if (!L.goal.checked || L.need_arch || unitList(L).some((u) => u.need_design)) return design
  if (!audited('design')) return { step: 'audit', phase: 'design' }
  if (testsTodo(L).length) return { step: 'tests', task: 'tests' }
  if (implTodo(L).length) return { step: 'implement', task: 'implement' }
  if (unitList(L).some((u) => u.impl_for !== u.design_hash)) return stop('blocked', ['実装の残った単位があるのに、依存が揃わず進めない'], { cause: 'failure' })
  if (L.checks.length && (!L.checks_run || L.checks_run.key !== keys.impl)) return { step: 'checks' }
  if (!audited('impl')) return { step: 'audit', phase: 'impl' }
  return stop('complete', ['全ての単位を設計・実装し、設計レビューと実装レビューを通し、戻す欠陥が残っていない'])
}

// 振り返りの意図のうち、実行役がまだ確かめていないもの（今の周、意図の順）と、実行役が支持して検証役の受理を待つもの。
export const queuedIntents = (L) => L.intents.filter((i) => i.cycle === L.cycle && i.status === 'queued')
export const examinedIntents = (L) => L.intents.filter((i) => i.cycle === L.cycle && i.status === 'examined')
// 振り返りの根拠に使える id（台帳の due の出来事・事実・due の出来事が持つ群の id。群は出来事の順に、重なりを除く）。
export const dueGroups = (L) => [...new Set(dueEvents(L).flatMap((e) => arr(e.groups)))]
export const knownIds = (L) => new Set([...dueEvents(L).map((e) => e.id), ...L.facts.map((f) => f.id), ...dueGroups(L)])
// 振り返りの巡を閉じる: 計画役が出した意図が全て確かめ終わったら（実行役と検証役の担当が残らない）、その巡で原因が受理されたかで dry を数える。
export function settleRetro(L) {
  const o = L.retro.open
  if (!o || L.intents.some((i) => i.round === o.round && ['queued', 'examined'].includes(i.status))) return
  L.retro.dry = L.facts.length > o.facts ? 0 : L.retro.dry + 1
  L.retro.open = null
}

// ---------------- 担当の提出の照合（CLI の submit が呼ぶ） ----------------
// 担当の種類（task.kind）ごとの役と段。next はここから行と担当を作り、submit は種類で照合を選ぶ。役の名前は roles.json の key。
export const TASK_ROLE = { goal: 'goal_checker', arch: 'architect', spec: 'unit_designer', tests: 'test_writer', implement: 'implementer', plan: 'retro_planner', exam: 'retro_examiner', judge: 'retro_verifier' }
// 試行の鍵（stuck の id。answer --id attempts:<鍵> で戻す）。意図ごとの実行と検証は、意図の試行（tries）に数え、上限で意図を閉じる（止めない）。
export const attemptKey = (t) => ({ goal: 'goal', arch: 'arch', spec: `design:${t.unit}`, tests: `tests:${t.unit}`, implement: `implement:${t.unit}`, plan: 'retro' })[t.kind] || null
// 照合に落ちた提出を出来事にするときの見出し。
export const taskTitle = (t) => ({ goal: '目標の照合', arch: '方式設計', spec: `${t.unit} の詳細設計`, tests: `${t.unit}`, implement: `${t.unit}`, plan: '振り返りの計画', exam: `${t.intent} の実行`, judge: `${t.intent} の検証` })[t.kind]

// 目標の照合: 照合役が挙げた成果の引用・項目の id を照らす。受理したら、どの項目にも受け止められていない成果を goal.problems に置く（decide が人間に返す）。
function submitGoal(L, rep) {
  const p = C.checkGoalMap(rep, goalIds(L), goalSources(L))
  if (p.length) return p
  L.goal.problems = C.goalGaps(rep)
  L.goal.checked = !L.goal.problems.length
  return []
}
// 方式設計: 形・不変条件と、入力の引用を照らす。受理したら単位を作り直す。ctx.inputs は読んだかを申告する入力、readText(path) は読めるファイルの本文か null。
// fresh(rel) は、呼び出しを開いた後に書かれたファイル（開いた時に照らしていなかったもの）か。方式設計が新しく単位に持たせたファイルのうち、
// この呼び出しの中で書かれたもの（方式設計の役が書いたもの）は、書く段の担当が書き直すまで受けない（tainted）。
function submitArch(L, a, { inputs, readText, fresh = () => false }) {
  const p = C.checkArch(a, { coverIds: coverIds(L), inputs })
  if (!p.length) for (const r of a.inputs_read) { const t = readText(r.path); for (const q of r.quotes) { const e = t == null ? '入力が読めない' : C.quoteProblem(q, t); if (e) p.push(`入力 ${r.path}: ${e}`) } }
  if (p.length) return p
  const ids = a.units.map((u) => u.id)
  for (const id of Object.keys(L.units)) if (!ids.includes(id)) { addEvent(L, { stage: 'design', kind: 'unit_removed', text: `単位 ${id} が方式設計から消えた（持っていたファイルは残る）` }); delete L.units[id] }
  for (const u of a.units) {
    const old = L.units[u.id] || { spec: '', acceptance: [], behaviors: [], partitions: [], cases: [], premises: [], unverified: [], allowed_optional: [], design_hash: null, tests_for: null, impl_for: null, tests_hash: {}, impl_hash: {}, rounds: 0, causes: [] }
    L.units[u.id] = { ...old, ...unitFields(u), need_design: true }
    const written = [...u.paths, ...u.tests].filter(fresh)
    if (written.length) {
      Object.assign(L.units[u.id], { tests_for: null, tests_hash: {}, impl_for: null, impl_hash: {}, tainted: [...new Set([...arr(L.units[u.id].tainted), ...written])] })
      addEvent(L, { stage: 'design', kind: 'write_outside', unit: u.id, text: `方式設計の呼び出しの中で、単位 ${u.id} が持つファイルが書かれた: ${written.join(', ')}（書く段の担当が書き直すまでテストと実装を受け付けない）` })
    }
  }
  L.arch = { units: ids, inputs_read: a.inputs_read, inputs_not_read: a.inputs_not_read, questions: a.questions, contracts: a.contracts, copies: a.copies }
  for (const r of a.inputs_not_read) addEvent(L, { stage: 'design', kind: 'input_not_read', text: `入力 ${r.path} を読まずに設計した（${r.reason}）` })
  L.need_arch = false
  return []
}
// 詳細設計: 形・結びと、前提の引用を照らす。readable は premises の path に使ってよい一覧。
function submitSpec(L, u, r, { readText, readable }) {
  if (!u.need_design) return ['単位の設計が既に済んだか、方式設計が変わった後の担当']
  const p = C.checkSpec(r, u, { rowIds: rowIdsOf(L, u.id), readable })
  if (!p.length) for (const x of r.premises) { const t = readText(x.path); const e = t == null ? '読めない' : C.quoteProblem(x.quote, t); if (e) p.push(`前提 ${x.path}: ${e}`) }
  if (p.length) return p
  Object.assign(u, {
    spec: r.spec, acceptance: r.acceptance.map((t, i) => ({ id: `${u.id}A${i + 1}`, text: t })), behaviors: r.behaviors, partitions: r.partitions, cases: r.cases,
    premises: r.premises, unverified: r.unverified, allowed_optional: r.allowed_optional, need_design: false,
  })
  u.design_hash = designHash(u, L)
  return []
}
// 書き込み: 呼び出しを開いた時と今の hash で、受け持ちの外の変更（outside）・書くはずのファイルの欠け・テストのファイルの変更を見る。
// after は今の hash（repo からの相対 path → hash か null）。
// before は呼び出しを開いた時の hash。書かない段の役が書いたファイル（u.tainted）は、この呼び出しで中身が書き直されていなければ受けない。
function submitWrite(L, stage, u, t, r, { after, outside, before = {} }) {
  const p = []
  for (const f of t.paths) if (arr(u.tainted).includes(f) && (before[f] ?? null) === (after[f] ?? null)) p.push(`${f} は書かない段の役が書いた中身のまま（受け持ちの担当が書き直す）`)
  if (r.unit_id !== u.id) p.push(`unit_id が違う: ${r.unit_id}`)
  for (const w of arr(r.written)) if (!t.paths.includes(w)) p.push(`受け持ちの外を書いたと申告した: ${w}`)
  for (const f of t.paths) if (after[f] == null) p.push(`${f} が無い`)
  if (stage === 'implement') for (const f of u.tests) if (after[f] !== u.tests_hash[f]) p.push(`テストのファイル ${f} がテストの担当の書いた内容と違う`)
  if (outside.length) p.push(`受け持ちの外のファイルが変わった: ${outside.join(', ')}`)
  if (p.length) return p
  const pick = (fs) => Object.fromEntries(fs.map((f) => [f, after[f]]))
  if (arr(u.tainted).length) u.tainted = u.tainted.filter((f) => !t.paths.includes(f))
  if (stage === 'tests') Object.assign(u, { tests_for: u.design_hash, tests_hash: pick(u.tests) })
  else Object.assign(u, { impl_for: u.design_hash, impl_hash: pick(u.paths) })
  if (arr(r.unresolved).length) addEvent(L, { stage, kind: 'unresolved', unit: u.id, test: stage === 'tests', text: `${u.id} が果たせなかったこと: ${r.unresolved.join(' / ')}` })
  return []
}
// 振り返りの計画: 根拠の id を台帳の id で照らす。受理したら巡を 1 つ進め、意図を queued で足す（実行役の担当になる）。
function submitPlan(L, rep) {
  const p = C.checkIntents(rep, knownIds(L))
  if (p.length) return p
  L.retro.rounds += 1
  L.retro.open = { round: L.retro.rounds, facts: L.facts.length }
  for (const raw of arr(rep.intents)) L.intents.push({ id: `I${L.intents.length + 1}`, cycle: L.cycle, round: L.retro.rounds, basis: raw.basis, hypothesis: raw.hypothesis, layer: raw.layer, look_at: raw.look_at, status: 'queued', why: '', exam: null, tries: 0 })
  return []
}
// 振り返りの実行: 支持した結論は、evidence の path が振り返りの読めるファイルの一覧（looks）にあり、引用がその本文に逐語であるときだけ受け、
// 検証役の受理を待つ（examined）。
function submitExam(L, it, x, { readText, looks }) {
  if (it.status !== 'queued') return ['意図が既に確かめ終わった']
  const p = C.checkExam(x)
  if (!p.length && x.verdict === 'supported') {
    for (const e of x.evidence) {
      const t = looks.includes(e.path) ? readText(e.path) : null
      const q = t == null ? '読めないか、振り返りの読めるファイルの一覧の外' : C.quoteProblem(e.quote, t)
      if (q) p.push(`${e.path}: ${q}`)
    }
  }
  if (p.length) return p
  Object.assign(it, { status: x.verdict === 'supported' ? 'examined' : x.verdict, exam: x })
  return []
}
// 振り返りの検証: 受理なら原因（事実）を足す。原因は、実行役の引用が本文に逐語であり、別の検証役が受理したものだけ。
function submitJudge(L, it, j) {
  if (it.status !== 'examined') return ['意図が検証を待っていない']
  const p = C.checkJudge(j)
  if (p.length) return p
  if (!j.accept) { Object.assign(it, { status: 'refuted', why: j.reason }); return [] }
  it.status = 'accepted'
  L.facts.push({ id: `F${L.facts.length + 1}`, cycle: L.cycle, basis: it.basis, cause: it.exam.cause, layer: it.exam.layer, evidence: it.exam.evidence, intent: it.id })
  return []
}
// 担当の結果を照らし、受理なら台帳に書く。結果の形（schema）を先に照らし、合わなければ照合の式に渡さない。返すのは拒む理由（空なら受理）。
// ctx は { inputs, readText, readable, looks, after, outside, before, fresh }（CLI がファイルから作る）。
export function submitTask(L, t, rep, ctx) {
  if (rep == null) return ['結果の JSON が読めない']
  const shape = C.shapeProblems(rep, C.RESULT_SCHEMAS[TASK_ROLE[t.kind]])
  if (shape.length) return shape
  const u = t.unit ? L.units[t.unit] : null
  const it = t.intent ? L.intents.find((x) => x.id === t.intent) : null
  if (t.unit && !u) return [`単位 ${t.unit} が方式設計から消えた`]
  if (t.intent && !it) return [`意図 ${t.intent} が台帳に無い`]
  if (t.kind === 'goal') return submitGoal(L, rep)
  if (t.kind === 'arch') return submitArch(L, rep, ctx)
  if (t.kind === 'spec') return submitSpec(L, u, rep, ctx)
  if (t.kind === 'tests' || t.kind === 'implement') return submitWrite(L, t.kind, u, t, rep, ctx)
  if (t.kind === 'plan') return submitPlan(L, rep)
  if (t.kind === 'exam') return submitExam(L, it, rep, ctx)
  return submitJudge(L, it, rep)
}
// 意図ごとの担当が試行の上限に達したとき、意図を判定できずに開示して閉じる（undecided。退けた rejected・refuted と区別する）。止めずに振り返りを進める。
// 閉じる前の状態（undecided_from）を残し、環境の失敗の分を戻す再開で待ちに戻せるようにする。
export function dropIntent(L, t, reason) {
  const it = L.intents.find((x) => x.id === t.intent)
  if (it && ['queued', 'examined'].includes(it.status)) Object.assign(it, { status: 'undecided', undecided_from: it.status, why: reason })
}

// coverage-audit の確定指摘の path。指摘は 1 つ以上の path（paths）を持ち、引用（quote）は先頭の path の単位の本文にある。
// paths の無い指摘（coverage-audit の振り返りなど、対象のファイルでないもの）は null。
export function findingPath(f) {
  const ps = arr(f && f.paths).filter((p) => typeof p === 'string' && p)
  return ps.length ? ps[0] : null
}

// coverage-audit の status（stateDir/status-<段>.json の中身）を取り込む。終わった検査だけを受け、引用を今の本文に照らし、指摘を単位と層へ結ぶ。
// 指摘は path・義務（obligation）・確信度（confidence）・原因の層（layer）・出どころ（origin）と、再レビューでの出どころの分類（provenance）を持つ。
// 参考（references。義務に結べないもの）は指摘にせず、開示の一覧として残す。試行の上限で判定できずに閉じた意図（undecided）を含む complete も受け、意図の id を出来事にする。
export function importAudit(L, status, phase, { readText, unitOfPath }) {
  const st = status && status.stopped
  if (!st || !['complete', 'needs_input'].includes(st.stop)) throw new Error(`coverage-audit が終わっていない（stopped: ${st ? st.stop : 'なし'}）。coverage-audit の「止まったとき」に従ってから取り込む`)
  if (status.pending != null) throw new Error('coverage-audit の呼び出しが途中にある（stopped は前の停止の記録）。coverage-audit を止まるまで回してから取り込む')
  if (arr(status.coverage && status.coverage.pending).length) throw new Error(`coverage-audit に読み終えていない単位が ${status.coverage.pending.length} 件ある。coverage-audit を続けてから取り込む`)
  const stage = `${phase}_review`
  // coverage-audit の群の id は段の始まりごとに数え直されるので、build の周と段を前に付けて別の群にする。
  const auditGroups = new Map(arr(status.groups).map((g) => [g.id, g]))
  const groupsOf = (f) => arr(f.groups).map((g) => {
    const id = `c${L.cycle}:${phase}:${g}`
    const src = auditGroups.get(g)
    if (!(id in L.audit_groups)) L.audit_groups[id] = { root_cause: src ? src.root_cause : null, layer: src ? C.LAYER_MAP[src.layer] || null : null }
    return id
  })
  const base = {
    findings: [], unverifiable: [],
    not_seen: arr(status.skip).map((s) => (s && s.reason ? `${s.unit}（${s.reason}）` : s && s.unit)).filter(Boolean),
    references: arr(status.references).map((r) => ({ id: r.id, path: r.path, claim: r.claim, quote: r.quote })),
  }
  for (const f of arr(status.findings && status.findings.confirmed)) {
    const path = findingPath(f)
    if (path === null) { addEvent(L, { stage, kind: 'audit_internal', text: `coverage-audit の進め方の指摘 ${f.id}: ${f.claim}` }); continue }
    const t = readText(path)
    const q = t == null ? '対象が読めない' : C.quoteProblem(f.quote, t)
    const layer = C.LAYER_MAP[f.layer]
    if (q || !layer) { addEvent(L, { stage, kind: 'import_mismatch', text: `${f.id}: ${q || `層が不正: ${f.layer}`}` }); continue }
    const others = arr(f.paths).slice(1)
    const where = others.length ? `${path} ほか ${others.join('、')}` : path
    const extra = { ...(f.obligation ? { obligation: f.obligation } : {}), ...(f.confidence ? { confidence: f.confidence } : {}), ...(f.origin ? { origin: f.origin } : {}), ...(f.provenance ? { provenance: f.provenance } : {}) }
    if (phase === 'baseline') {
      base.findings.push({ id: f.id, path, paths: arr(f.paths), layer, claim: f.claim, quote: f.quote, ...extra })
      if (layer === '目標') L.human.push({ id: `B${L.human.length + 1}`, reason: '現状の検査で目標・方針の層の欠陥が出た（設計に進まない）', text: `${f.claim}（${where}: ${f.quote}）` })
      continue
    }
    const m = unitOfPath(path)
    addEvent(L, { stage, kind: 'finding', layer, unit: m.unit, test: m.test, text: `${f.claim}（${where}: 「${f.quote}」）`, ref: f.id, groups: groupsOf(f), ...extra })
  }
  for (const f of arr(status.findings && status.findings.unverifiable)) {
    if (phase === 'baseline') base.unverifiable.push(f)
    else addEvent(L, { stage, kind: 'unverifiable', text: `検証不能の指摘 ${f.id}: ${f.claim}`, ref: f.id })
  }
  // coverage-audit のこの段の出来事（振り返りの資産を作らずに status で返す）を、探索グラフの出来事として 1 回だけ受ける。
  for (const e of arr(status.events)) {
    if (!e || !e.id || L.audit_events_seen.includes(e.id)) continue
    L.audit_events_seen.push(e.id)
    addEvent(L, { stage, kind: 'audit_internal', text: `coverage-audit の出来事 ${e.id} [${e.stage}/${e.kind}]: ${e.text}`, ref: e.id })
  }
  // 試行の上限で判定できずに開示して閉じた意図。出来事に意図の id が出ていなければ、ここで 1 回だけ出来事にする（黙って完了に含めない）。
  for (const u of arr(status.undecided)) {
    const key = `${phase}:undecided:${u.id}`
    if (!u || !u.id || L.audit_events_seen.includes(key)) continue
    L.audit_events_seen.push(key)
    if (arr(status.events).some((e) => e && String(e.text).includes(u.id))) continue
    addEvent(L, { stage, kind: 'audit_internal', text: `coverage-audit が判定できずに開示して閉じた意図 ${u.id} [${u.kind}]: ${u.reason || '理由なし'}`, ref: u.id })
  }
  if (phase === 'baseline') L.baseline = base
  else for (const c of base.not_seen) addEvent(L, { stage, kind: 'not_seen', text: `見ていない単位（開示）: ${c}` })
  return base
}
