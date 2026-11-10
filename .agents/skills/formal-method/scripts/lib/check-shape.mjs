// 形の検査器の部品（artifact-formats.md「表記の約束」）。object は閉じている、キーは全て必須（key? は任意）、
// string は空でない、[T] は空を許し [T]+ は許さない。検査器は (value, path, errors) を受け、違反を errors に足す。
// 検査器は同じ形の JSON Schema の断片を .json に持つ（jsonSchemaOf で読む。担当に渡す RETURN_SCHEMA の正本）。
const fail = (errs, path, msg) => { errs.push(`${path || '/'}: ${msg}`); return false; };
const withJson = (fn, json) => Object.assign(fn, { json });

export const str = withJson((v, p, e) => (typeof v === 'string' && v.length > 0) || fail(e, p, '空でない string を期待'), { type: 'string', minLength: 1 });
export const str0 = withJson((v, p, e) => typeof v === 'string' || fail(e, p, 'string を期待'), { type: 'string' });
export const bool = withJson((v, p, e) => typeof v === 'boolean' || fail(e, p, 'boolean を期待'), { type: 'boolean' });
export const num = withJson((v, p, e) => (typeof v === 'number' && Number.isFinite(v)) || fail(e, p, 'number を期待'), { type: 'number' });
export const int = withJson((v, p, e) => Number.isSafeInteger(v) || fail(e, p, '整数を期待'), { type: 'integer' });
export const intGe = (n) => withJson((v, p, e) => (Number.isSafeInteger(v) && v >= n) || fail(e, p, `${n} 以上の整数を期待`), { type: 'integer', minimum: n });
export const lit = (...vals) => withJson((v, p, e) => vals.includes(v) || fail(e, p, `${vals.map((x) => JSON.stringify(x)).join('・')} のどれかを期待`), { enum: vals });
export const nullable = (t) => withJson((v, p, e) => v === null || t(v, p, e), t.json ? { anyOf: [{ type: 'null' }, t.json] } : undefined);
export const any = withJson(() => true, {});
export const re = (rx, what) => withJson((v, p, e) => (typeof v === 'string' && rx.test(v)) || fail(e, p, `${what} を期待`), { type: 'string', pattern: rx.source });

export const arr = (t, min = 0) => withJson((v, p, e) => {
  if (!Array.isArray(v)) return fail(e, p, '配列を期待');
  if (v.length < min) fail(e, p, `${min} 個以上を期待`);
  v.forEach((x, i) => t(x, `${p}/${i}`, e));
  return true;
}, t.json ? { type: 'array', items: t.json, ...(min ? { minItems: min } : {}) } : undefined);
export const arr1 = (t) => arr(t, 1);

export const tuple = (...ts) => withJson((v, p, e) => {
  if (!Array.isArray(v) || v.length !== ts.length) return fail(e, p, `長さ ${ts.length} の配列を期待`);
  ts.forEach((t, i) => t(v[i], `${p}/${i}`, e));
  return true;
}, ts.every((t) => t.json) ? { type: 'array', prefixItems: ts.map((t) => t.json), minItems: ts.length, maxItems: ts.length } : undefined);

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function objectJson(shape, open) {
  const keys = Object.keys(shape);
  if (!keys.every((k) => shape[k].json)) return undefined;
  const properties = Object.fromEntries(keys.map((k) => [k.replace(/\?$/, ''), shape[k].json]));
  const required = keys.filter((k) => !k.endsWith('?'));
  return { type: 'object', properties, required, additionalProperties: open };
}

// 閉じた object。open: true なら書いていないキーを拒まない（依頼だけ）。
export const obj = (shape, { open = false } = {}) => withJson((v, p, e) => {
  if (!isPlainObject(v)) return fail(e, p, 'object を期待');
  for (const k of Object.keys(shape)) {
    const opt = k.endsWith('?');
    const name = opt ? k.slice(0, -1) : k;
    if (!Object.prototype.hasOwnProperty.call(v, name)) { if (!opt) fail(e, `${p}/${name}`, '必須のキーが無い'); continue; }
    shape[k](v[name], `${p}/${name}`, e);
  }
  if (!open) {
    const allowed = new Set(Object.keys(shape).map((k) => k.replace(/\?$/, '')));
    for (const k of Object.keys(v)) if (!allowed.has(k)) fail(e, `${p}/${k}`, '書いていないキー');
  }
  return true;
}, objectJson(shape, open));

export const oneOf = (...ts) => withJson((v, p, e) => {
  const tries = ts.map((t) => { const sub = []; t(v, p, sub); return sub; });
  if (tries.some((s) => s.length === 0)) return true;
  return fail(e, p, 'どの形にも合わない');
}, ts.every((t) => t.json) ? { anyOf: ts.map((t) => t.json) } : undefined);

// 検査器と同じ形の JSON Schema。断片を持たない部品（独自の検査器）を含むなら投げる。
export function jsonSchemaOf(type) {
  if (!type || !type.json) throw new Error('この検査器は JSON Schema の断片を持たない');
  return { $schema: 'https://json-schema.org/draft/2020-12/schema', ...type.json };
}

export function validate(type, value) {
  const errs = [];
  type(value, '', errs);
  return errs;
}

export const conforms = (type, value) => validate(type, value).length === 0;
