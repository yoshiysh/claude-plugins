// 実行体 formal-method-core の schema（references/core.schema.json）を 1 度だけ読む（#264 SP-264-003）。
// 列挙・上限・実行体の名前の正本は schema で、Node はここから読み、値を書き写さない。
// 依存を持たない（schemas.mjs と core.mjs の両方が読むので、循環の import を作らないため）。
import { readFileSync } from 'node:fs';

export const CORE_SCHEMA_URL = new URL('../../references/core.schema.json', import.meta.url);
export const CORE_SCHEMA = Object.freeze(JSON.parse(readFileSync(CORE_SCHEMA_URL, 'utf8')));
export const CORE = Object.freeze(CORE_SCHEMA['x-core']);

// $defs の列挙の値。無ければ投げる（schema が壊れていれば読み込みの時点で止める）
export function coreEnum(name) {
  const values = CORE_SCHEMA.$defs?.[name]?.enum;
  if (!Array.isArray(values) || values.length === 0) throw new Error(`core.schema.json の $defs/${name}.enum が無い`);
  return Object.freeze([...values]);
}

// x-core.roles の名前で列挙の値を引く（列挙の中の位置で引かない）
export function coreRole(name) {
  const r = CORE.roles?.[name];
  if (!r || !coreEnum(r.enum).includes(r.value)) throw new Error(`core.schema.json の x-core.roles.${name} が無いか、列挙 ${r?.enum} に無い値`);
  return r.value;
}
