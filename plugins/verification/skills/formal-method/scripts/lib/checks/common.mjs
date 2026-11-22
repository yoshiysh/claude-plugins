// 照合の共通の部品。欠陥は { key, kind, element, property, text } で、key は巡をまたいで同じ欠陥を同じ値で表す。
// kind は欠陥の区分（artifact-formats.md「syntax・reference・output_format の作り方」）で、必ず付ける。
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const DEFECT_KINDS = Object.freeze(['syntax', 'reference', 'other']);
export function defect(kind, key, text, { element = null, property = null } = {}) {
  if (!DEFECT_KINDS.includes(kind)) throw new Error(`欠陥 ${key} の区分 ${kind} が ${DEFECT_KINDS.join('・')} のどれでもない`);
  return { key, kind, element, property, text };
}


export function linesOf(text) {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

export const readRunText = (runDir, ref) => {
  try { return statSync(join(runDir, ref)).isFile() ? readFileSync(join(runDir, ref), 'utf8') : null; } catch { return null; }
};
export const readRunJson = (runDir, ref) => {
  const t = readRunText(runDir, ref);
  if (t === null) return null;
  try { return JSON.parse(t); } catch { return null; }
};
export const runFileExists = (runDir, ref) => existsSync(join(runDir, ref));

export const cmpBytes = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));
