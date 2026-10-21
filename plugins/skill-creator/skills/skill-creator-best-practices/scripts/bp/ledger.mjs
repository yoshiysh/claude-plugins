import { promises as fs } from 'node:fs';
import { splitAssets } from './assets.mjs';
import { targetFiles } from './fingerprint.mjs';
import { internal } from './errors.mjs';
import { locationKey } from './ids.mjs';

export async function enumerateAssets(pathsRecord) {
  const out = [];
  const seen = new Map();
  for (const { file, key } of await targetFiles(pathsRecord)) {
    for (const asset of splitAssets(key, await fs.readFile(file))) {
      const where = `${asset.path}\0${locationKey(asset.loc)}`;
      if (seen.has(asset.id) && seen.get(asset.id) !== where) internal(`資産 ID が衝突した: ${asset.id}`);
      seen.set(asset.id, where);
      out.push(asset);
    }
  }
  return out;
}

function checkCollision(view, asset) {
  const known = view.assets.get(asset.id);
  if (known && (known.path !== asset.path || locationKey(known.loc) !== locationKey(asset.loc))) internal(`資産 ID が台帳の別の位置キーと衝突した: ${asset.id}`);
}

export function createLedgerRecords(view, assets, { ledgerId, rewriting }) {
  for (const a of assets) checkCollision(view, a);
  return [
    { t: 'ledger', id: ledgerId, rewriting },
    ...assets.flatMap((a) => [
      { t: 'asset', id: a.id, path: a.path, loc: a.loc },
      { t: 'digest', id: a.id, digest: a.digest, retake: 0 },
    ]),
  ];
}

// 取り直しの 4 行（SP-BPFINDINGS-005）: 同じ指紋は足さない・違う指紋・新しい資産・消えた資産。
export function retakeRecords(view, assets) {
  const retake = view.retakes + 1;
  const records = [];
  const counts = { unchanged: 0, changed: 0, added: 0, gone: 0 };
  const now = new Set();
  for (const a of assets) {
    checkCollision(view, a);
    now.add(a.id);
    const known = view.assets.get(a.id);
    if (!known) {
      records.push({ t: 'asset', id: a.id, path: a.path, loc: a.loc }, { t: 'digest', id: a.id, digest: a.digest, retake });
      counts.added += 1;
    } else if (known.gone || known.digest !== a.digest) {
      records.push({ t: 'digest', id: a.id, digest: a.digest, retake });
      counts.changed += 1;
    } else {
      counts.unchanged += 1;
    }
  }
  const gone = [];
  for (const known of view.assets.values()) {
    if (!known.gone && !now.has(known.id)) {
      records.push({ t: 'gone', id: known.id, retake });
      gone.push({ id: known.id, path: known.path, loc: known.loc });
      counts.gone += 1;
    }
  }
  return { records, counts, gone, retake };
}
