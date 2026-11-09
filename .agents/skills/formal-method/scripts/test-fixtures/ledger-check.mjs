// 記録台帳の entry の欄の検査（artifact-formats.md「記録台帳」）。実装を読まずに契約の文から書いた。
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const LEDGER_ENTRY_KEYS = ['kind', 'ref', 'hash', 'stage', 'producer', 'model', 'effort', 'permissions', 'input_refs'];
// 担当に与える権限（artifact-formats「記録台帳」、architecture「担当の起動」の AGENT_PERMISSIONS の値）
export const AGENT_PERMISSIONS_CONTRACT = ['fresh-thread', 'workspace-write'];
const NON_AGENT = ['cli', 'salvage'];

// run の領域の batches/*/tasks.json の全ての task を task_id で引く
export function tasksById(runDir) {
  const out = new Map();
  const dir = join(runDir, 'batches');
  if (!existsSync(dir)) return out;
  for (const b of readdirSync(dir)) {
    const p = join(dir, b, 'tasks.json');
    if (!existsSync(p)) continue;
    for (const t of JSON.parse(readFileSync(p, 'utf8')).tasks) out.set(t.task_id, t);
  }
  return out;
}

// 違反の文の配列を返す（空なら合う）
export function ledgerEntryViolations(ledger, tasks) {
  const v = [];
  if (!Array.isArray(ledger.entries)) return ['entries が配列でない'];
  for (const [i, e] of ledger.entries.entries()) {
    const at = `entries[${i}]（${e.ref}）`;
    const missing = LEDGER_ENTRY_KEYS.filter((k) => !(k in e));
    if (missing.length) { v.push(`${at} に欄が無い: ${missing.join('・')}`); continue; }
    if (NON_AGENT.includes(e.producer)) {
      if (e.model !== null || e.effort !== null) v.push(`${at} の producer ${e.producer} は model・effort が null`);
      if (!Array.isArray(e.permissions) || e.permissions.length !== 0) v.push(`${at} の producer ${e.producer} は permissions が []`);
    } else if (tasks.has(e.producer)) {
      const t = tasks.get(e.producer);
      if (e.model !== t.model) v.push(`${at} の model ${e.model} が tasks.json の ${t.model} と違う`);
      if (e.effort !== t.effort) v.push(`${at} の effort ${e.effort} が tasks.json の ${t.effort} と違う`);
      if (JSON.stringify(e.permissions) !== JSON.stringify(AGENT_PERMISSIONS_CONTRACT)) v.push(`${at} の permissions ${JSON.stringify(e.permissions)} が ${JSON.stringify(AGENT_PERMISSIONS_CONTRACT)} と違う`);
    } else v.push(`${at} の producer ${e.producer} が cli・salvage・tasks.json の task_id のどれでもない`);
  }
  return v;
}
