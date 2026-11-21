// 全文レビュー（docs/design/coverage-ledger-method.md の決定 17、段の構成の「全文レビュー（ファイルの段より先に読む）」）のテストの道具。
// full-review.test.mjs だけが使う。launch-fixture.mjs・blackboard-fixture.mjs の既存の形と既定は変えず、全文レビューの役の結果の形と既定をここ 1 か所に置く。
//
// ここで固定する下の層の決定（変えるときはこのファイルを直す）:
// - 役の名前: full_reviewer（roles.json の key。file_reader と別の役。Opus / medium）。
// - 段の名前（args.stage）: full_review。計画の段（plan・unit_verify）の後、ファイルの段（file）の前に 1 回だけ流れ、workers はいつも 1 行。
// - 担当の種類（task.kind）: full_review。claim の担当は観点（lenses）を持たない。
// - query（--task <全文レビューの担当の id>）: { ok, task, kind, inputs }。inputs の key は FR_QUERY_KEYS の部分集合で、goal・items・units を必ず持つ。
//   units は読む範囲の単位の一覧 [{ id, path, file（stateDir/snap/ の写し）, start, end }]。観点・索引（index）・事実・前の判定・ヒントは返さない。
//   --fact を付けた query は拒む（終了状態 2）。
// - 結果（result_path に書く JSON）: { findings: [FRFinding], references: [{ claim, locations: [{ unit, quote }] }] }
//   FRFinding = { claim, locations: [{ unit, quote }], obligation, confidence, severity, layer }（全体の段が足す指摘と同じ形）。
//   引用は location の unit の本文に逐語で、unit は読む範囲の単位だけ。obligation は目標・受け入れ基準の id（結べないものは references に書く）。
//   guarantees・premises を持つ提出は拒む（ok: false。problems に欄の名前を含む）。
// - 事実: 全文レビューの指摘は type: finding・origin: full_review で、locations・paths を持つ。参考は type: reference・origin: full_review。
// - status の欄: status.full_review = { read: [単位の id], unread: [単位の id] }。unread は読む範囲の外の単位と、失敗で読まなかった単位。
//   unread の単位は status.skip・coverage.disclosed に入れない（網羅と別の一覧）。
// - 出来事の段の名前（events[].stage）: full_review。
import path from 'node:path'
import { act } from './launch-fixture.mjs'

export const FR_ROLE = 'full_reviewer'
export const FR_STAGE = 'full_review'
export const FR_KIND = 'full_review'
export const FR_ORIGIN = 'full_review'
export const FR_QUERY_KEYS = ['goal', 'items', 'criteria', 'constraints', 'units']
export const FR_QUERY_REQUIRED = ['goal', 'items', 'units']

export const frStatus = (s) => (s && s.full_review) || {}
const baseOf = (u) => path.basename(String((u && (u.path || u.id)) || ''))
// 全文レビューの担当の読む範囲（query の inputs.units。無ければ claim の task.units）。
export const frUnits = (task, q) => ((q && q.inputs && q.inputs.units) || (task && task.units) || [])
export const unitByName = (units, name) => units.find((u) => baseOf(u) === name)
// 場所: 読む範囲の単位を名前で引く（無ければ台帳に無い unit の id にして、照合に落ちる提出を作る）。
export const loc = (units, name, quote) => { const u = unitByName(units, name); return { unit: u ? u.id : `missing:${name}`, quote } }
export const frFinding = (claim, locations, extra = {}) => ({ claim, locations, obligation: 'G1', confidence: 'high', severity: 'HIGH', layer: '実装', ...extra })
// 既定の全文レビューの結果: 指摘を書かない（over.frFindings(units, inputs) で足す）。
export const frResult = (findings = [], references = []) => ({ findings, references })
// 全文レビューの指摘の事実（status.facts の中）。
export const frFacts = (s) => (s.facts || []).filter((f) => f.type === 'finding' && f.origin === FR_ORIGIN)
// 確定した指摘の事実の id（status は同じ中身の指摘を 1 件にまとめて ids に持つので、ids を平らにする）。
export const confirmedIds = (s) => s.findings.confirmed.flatMap((f) => f.ids || [f.id])

// 役の偽物。launch-fixture の act に、全文レビューの担当と、全文レビューの指摘への判定・確認を足す。
// over の key（act の key に足すもの）:
// - full_review(task, ctx, q): 全文レビューの結果を返す（undefined なら既定）。q は担当の query の出力。
// - frFindings(units, inputs): 既定の結果の findings。frReferences(units, inputs): 既定の結果の references。
// - frJudge(fact): 全文レビューの指摘の判定（keep|drop。既定 keep）。frConfirm(fact): 確認（agree|disagree|bad。bad は reason を欠いて照合に落ちる。既定 agree）。
//   over.finding・over.confirm があればそちらを使う。
export function frAct(over = {}) {
  const base = act(over)
  return async (task, ctx) => {
    if (task.kind === FR_KIND) {
      const q = ctx.query(task)
      const r = over.full_review ? over.full_review(task, ctx, q) : undefined
      if (r !== undefined) return r
      const units = frUnits(task, q)
      const inputs = (q && q.inputs) || {}
      return frResult(over.frFindings ? over.frFindings(units, inputs) : [], over.frReferences ? over.frReferences(units, inputs) : [])
    }
    if ((task.kind === 'finding' && !over.finding) || (task.kind === 'confirm' && !over.confirm)) {
      const q = ctx.query(task)
      const target = ((q && q.basis) || []).find((f) => f && f.type === 'finding' && f.origin === FR_ORIGIN)
      if (target) {
        const quote = target.quote || (Array.isArray(target.locations) && target.locations[0] && target.locations[0].quote) || ''
        if (task.kind === 'finding') return { verdict: over.frJudge ? over.frJudge(target) : 'keep', reason: '全文レビューの指摘を本文で確かめた', quote }
        const v = over.frConfirm ? over.frConfirm(target) : 'agree'
        if (v === 'bad') return { verdict: 'agree', quote }
        return { verdict: v, reason: '全文レビューの指摘への判定を本文で確かめた', quote }
      }
    }
    return base(task, ctx)
  }
}
