// CLI の作業記録と記録台帳の entry（artifact-formats.md「作業記録」「記録台帳」）。
// 台帳の entry の model・effort・permissions は producer で決める（担当の task_id なら tasks.json の値と AGENT_PERMISSIONS、cli・salvage なら null・null・[]）。
import { AGENT_PERMISSIONS } from './roles.mjs';
import { WORKLOG_SCHEMA } from './schemas.mjs';

export function ledgerEntry({ kind, ref, hash, stage, task = null, producer = 'cli', inputRefs = [] }) {
  if (task) {
    return { kind, ref, hash, stage, producer: task.task_id, model: task.model, effort: task.effort, permissions: [...AGENT_PERMISSIONS], input_refs: inputRefs };
  }
  return { kind, ref, hash, stage, producer, model: null, effort: null, permissions: [], input_refs: inputRefs };
}

export function newStageLog() {
  return { actions: [], results: [], grounds: [], failures: [], unconfirmed: [], inputs: [], unreadable: [] };
}

const sentence = (parts, fallback) => (parts.length ? parts.join(' ') : fallback);

export function cliWorklog(stage, log, documentRules, target) {
  return {
    schema: WORKLOG_SCHEMA, role: 'cli', task_id: null, stage, target,
    inputs: log.inputs,
    actions: sentence(log.actions, `${stage}の段の決定的な処理を行った。`),
    results: sentence(log.results, `${stage}の段の処理を終えた。`),
    grounds: sentence(log.grounds, '契約の規則に従って機械的に照合した。'),
    failures: log.failures, unconfirmed: log.unconfirmed, unreadable_inputs: log.unreadable,
    document_rules: documentRules,
  };
}
