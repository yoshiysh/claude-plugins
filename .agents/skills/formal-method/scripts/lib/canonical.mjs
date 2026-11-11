// 指紋と正規の JSON（artifact-formats.md「共通の型」の Sha256）。構造データはキーを辞書順にした JSON、ファイルは生のバイト列。
import crypto from 'node:crypto';

export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('non-finite number is not canonical JSON');
    if (value === undefined) throw new Error('undefined is not canonical JSON');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

export function sha256Bytes(buf) {
  return `sha256:${crypto.createHash('sha256').update(buf).digest('hex')}`;
}

export function sha256Json(value) {
  return sha256Bytes(Buffer.from(canonicalJson(value), 'utf8'));
}

export const randomHex = (bytes) => crypto.randomBytes(bytes).toString('hex');
