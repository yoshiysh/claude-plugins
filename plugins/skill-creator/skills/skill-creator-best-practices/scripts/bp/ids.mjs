import { createHash, randomBytes } from 'node:crypto';
import { ID_LENGTHS } from './constants.mjs';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? 'null' : canonical(v))).join(',')}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
}

// script は import を持てないので、同じ式を自分で書き写せる形にする: 正規化した JSON の UTF-16 code unit ごとの FNV-1a 32bit、8 桁の 16 進。
export function fnv1a(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export function sum(value) {
  return fnv1a(canonical(value));
}

export function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex');
}

export function base32(buffer) {
  let bits = 0;
  let acc = 0;
  let out = '';
  for (const byte of buffer) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD[(acc >>> (bits - 5)) & 31];
      bits -= 5;
    }
    acc &= (1 << bits) - 1;
  }
  if (bits > 0) out += CROCKFORD[(acc << (5 - bits)) & 31];
  return out;
}

function shortHash(text, length) {
  return base32(createHash('sha256').update(text).digest()).slice(0, length);
}

function utcStamp(date) {
  return date.toISOString().replace(/[-:T]/g, '').slice(0, 14);
}

export function stateId(date = new Date(), random = randomBytes(8)) {
  return `bp-${utcStamp(date)}-${base32(random).slice(0, ID_LENGTHS.stateRandom).toLowerCase()}`;
}

export function runId(n) {
  return `r${n}`;
}

export function groundId(n) {
  return `G${n}`;
}

export function premiseId(n) {
  return `P${n}`;
}

export function itemId(stage, round, key) {
  const prefix = round == null ? stage : `${stage}.${round}`;
  return `${prefix}-${shortHash(canonical(key), ID_LENGTHS.item)}`;
}

export function locationKey(loc) {
  return canonical(loc);
}

export function assetId(path, loc) {
  return `A${shortHash(`${path}\0${locationKey(loc)}`, ID_LENGTHS.asset)}`;
}

export function findingId(ledgerId, key) {
  return `F${shortHash(`${ledgerId}\0${key.asset}\0${key.viewpoint}\0${key.kind}`, ID_LENGTHS.finding)}`;
}

export function assignmentId(stage, n) {
  return `S${stage}${n}`;
}

export function fingerprintSet(digests) {
  const lines = Object.keys(digests).sort().map((id) => `${id}:${digests[id]}`);
  return sha256Hex(lines.join('\n'));
}

export function keyString(key) {
  return canonical({ asset: key.asset, viewpoint: key.viewpoint, kind: key.kind });
}
