// 記録台帳の entry の欄の検査（artifact-formats.md「記録台帳」）。実装を読まずに契約の文から書いた。
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, posix } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileHash } from './fabricate.mjs';

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

// input_refs をファイルの RefHash の並びにする（artifact-formats「ディレクトリの ref の指紋」）。
// ファイルはそのまま 1 つ、ディレクトリは下の全てのファイル（再帰、ディレクトリ自身は除く）を、そのディレクトリの中だけ
// ref の UTF-8 のバイト列の辞書順（Buffer.compare）に並べる。並びは input_refs の要素の順
export function expandRefs(runDir, inputRefs) {
  const out = [];
  for (const { ref } of inputRefs) {
    const p = join(runDir, ref);
    if (!statSync(p).isDirectory()) { out.push({ ref, hash: fileHash(p) }); continue; }
    const files = [];
    const walk = (d) => { for (const n of readdirSync(join(runDir, d))) { const r = posix.join(d, n); if (statSync(join(runDir, r)).isDirectory()) walk(r); else files.push(r); } };
    walk(ref.replace(/\/+$/, ''));
    files.sort((a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')));
    for (const r of files) out.push({ ref: r, hash: fileHash(join(runDir, r)) });
  }
  return out;
}

// 違反の文の配列を返す（空なら合う）。runDir を渡せば、担当の entry の input_refs が task の input_refs を展開したものかも照らす
export function ledgerEntryViolations(ledger, tasks, runDir = null) {
  const v = [];
  if (!Array.isArray(ledger.entries)) return ['entries が配列でない'];
  for (const [i, e] of ledger.entries.entries()) {
    const at = `entries[${i}]（${e.ref}）`;
    const missing = LEDGER_ENTRY_KEYS.filter((k) => !(k in e));
    if (missing.length) { v.push(`${at} に欄が無い: ${missing.join('・')}`); continue; }
    if (NON_AGENT.includes(e.producer)) {
      if (e.model !== null || e.effort !== null) v.push(`${at} の producer ${e.producer} は model・effort が null`);
      if (!Array.isArray(e.permissions) || e.permissions.length !== 0) v.push(`${at} の producer ${e.producer} は permissions が []`);
      if (!Array.isArray(e.input_refs) || e.input_refs.length !== 0) v.push(`${at} の producer ${e.producer} は input_refs が []`);
    } else if (tasks.has(e.producer)) {
      const t = tasks.get(e.producer);
      if (e.model !== t.model) v.push(`${at} の model ${e.model} が tasks.json の ${t.model} と違う`);
      if (e.effort !== t.effort) v.push(`${at} の effort ${e.effort} が tasks.json の ${t.effort} と違う`);
      if (JSON.stringify(e.permissions) !== JSON.stringify(AGENT_PERMISSIONS_CONTRACT)) v.push(`${at} の permissions ${JSON.stringify(e.permissions)} が ${JSON.stringify(AGENT_PERMISSIONS_CONTRACT)} と違う`);
      // 作業記録を含む全ての記録で、その task の context.input_refs を展開したもの
      // キーの順は比べず（台帳は正規の JSON でキーが辞書順）、配列の並びと値は比べる
      if (runDir && !isDeepStrictEqual(e.input_refs, expandRefs(runDir, t.context?.input_refs ?? []))) v.push(`${at} の input_refs が ${e.producer} の context.input_refs を展開したものと違う`);
    } else v.push(`${at} の producer ${e.producer} が cli・salvage・tasks.json の task_id のどれでもない`);
  }
  return v;
}
