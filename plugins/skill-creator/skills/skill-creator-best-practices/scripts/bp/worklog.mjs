import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CODES, CRITERIA_FILES, OPS, RECORDS, WORK_LOG_KEYS } from './constants.mjs';
import { needPosInt } from './checks.mjs';
import { reject } from './errors.mjs';
import { sha256Hex } from './ids.mjs';
import { strip } from './records.mjs';
import { mutate } from './store.mjs';

const PLUGIN_JSON = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '.claude-plugin', 'plugin.json');

function readOr(file) {
  try { return readFileSync(file); } catch { return null; }
}

// 作業記録に書く一般規約の版（plugin の version）と不変の参照（写しの sha256）。得られなければ得られなかったものを理由に拒否する（SP-BPRUN-043・SP-BPRUN-045）。
export function guidelinesRef(ctx) {
  const copy = path.join(ctx.criteriaDir, ...CRITERIA_FILES.guidelines);
  const bytes = readOr(copy);
  if (bytes === null) reject(CODES.input, `文書の一般規約の写しが無いので記録台帳に足せない: ${copy}`);
  const manifest = readOr(ctx.pluginJson ?? PLUGIN_JSON);
  let version = null;
  try { version = manifest === null ? null : JSON.parse(manifest.toString('utf8')).version; } catch { version = null; }
  if (typeof version !== 'string' || version === '') reject(CODES.input, `文書の一般規約の版（plugin の version）を得られないので記録台帳に足せない: ${ctx.pluginJson ?? PLUGIN_JSON}`);
  return { version, sha256: sha256Hex(bytes) };
}

function workPath(p, what) {
  if (typeof p !== 'string' || p === '' || path.isAbsolute(p) || path.posix.normalize(p).startsWith('..')) reject(CODES.input, `${what}は作業場所の work/ からの相対パスでなければならない: ${JSON.stringify(p)}`);
  return p;
}

// 記録台帳の 1 つの記録（SP-BPRUN-042）。結果を返さなかった担当の代わりの作業記録（SP-BPRUN-047）は中身を substitute に持ち、パスを持たなくてよい。
export function workLogRecord(ctx, run, entry, { substitute = false } = {}) {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) reject(CODES.input, '作業記録の担当の記録はオブジェクトでなければならない');
  if (typeof entry[WORK_LOG_KEYS.role] !== 'string' || entry[WORK_LOG_KEYS.role] === '') reject(CODES.input, 'role（作業記録の担当の役の名前）が空でない文字列でない');
  const item = entry[WORK_LOG_KEYS.item] ?? null;
  if (item !== null && typeof item !== 'string') reject(CODES.input, 'item（作業記録の担当の項目の ID）は文字列か省略');
  needPosInt(entry[WORK_LOG_KEYS.attempt], 'attempt は');
  const evidence = entry[WORK_LOG_KEYS.evidence] ?? [];
  if (!Array.isArray(evidence)) reject(CODES.input, 'evidence は並びでなければならない');
  const file = entry[WORK_LOG_KEYS.path];
  const record = {
    t: RECORDS.workLog, run, role: entry.role, item, attempt: entry.attempt,
    path: substitute && file === undefined ? null : workPath(file, '作業記録のパス'),
    evidence: evidence.map((p) => workPath(p, '証拠のパス')),
    guidelines: guidelinesRef(ctx),
  };
  if (substitute) record.substitute = entry.content ?? null;
  return record;
}

// SP-BPRUN-042・SP-BPRUN-044: 足すだけにし、同じ鍵の同じ内容は足さない（違う内容は E_CONFLICT）。
export function record(ctx, req) {
  return mutate(ctx, req, OPS.record, () => {
    const rec = workLogRecord(ctx, req.run, req);
    return { records: [rec], output: (after) => ({ record: strip(after.workLogs.find((w) => w.run === rec.run && w.role === rec.role && w.item === rec.item && w.attempt === rec.attempt)) }) };
  });
}
