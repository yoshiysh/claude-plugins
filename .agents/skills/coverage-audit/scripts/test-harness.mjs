// テストの道具（古い呼び出し側のための最小の口）: 一時ディレクトリと、CLI を in-process で流す口だけ。
// 役の偽物・Workflow の駆動・役の結果の形は blackboard-fixture.mjs（計画の段の役は plan-roles.mjs）が持つ。
// 枡・applies_to・k を前提にした古い偽物（mockAgent・drive・runWorkflow・evidenceOf）は、Workflow script が担当を claim で取る形になって消した。
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { main } from './ledger-cli.mjs'
import { WORKFLOW_SOURCE } from './ledger-core.mjs'

export const WF = WORKFLOW_SOURCE

export function tmp(t) {
  const d = mkdtempSync(path.join(tmpdir(), 'coverage-audit-'))
  t.after(() => rmSync(d, { recursive: true, force: true }))
  return d
}
export function cli(...argv) {
  const r = main(argv)
  return { code: r.code, ...r.output }
}
