// 結果の公開（cli-contract.md「結果と台帳の保存の失敗」「unit の入口（内部）」2）。台帳 → result.json の順に、
// 一時ファイル・fsync・link・ディレクトリの fsync・再読込の指紋の照合で公開する。fs の誤りは外へ出さず outcome で返す。
import { linkSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson, sha256Bytes, randomHex } from './canonical.mjs';
import { Result, conforms } from './schemas.mjs';
import { reason, stopReport } from './stop-report.mjs';
import { writeTempFile, fsyncDir } from './storage.mjs';

const enc = (s) => new TextEncoder().encode(s);
const sameBytes = (a, b) => sha256Bytes(a) === sha256Bytes(b);

// 本番の FsBoundary（node:fs）。
export const NODE_FS = Object.freeze({
  writeTemp(finalPath, tmpPath, bytes) { writeTempFile(tmpPath, bytes); },
  link(tmpPath, finalPath) { linkSync(tmpPath, finalPath); },
  fsyncDir(dirPath) { fsyncDir(dirPath); },
  readFile(path) { return new Uint8Array(readFileSync(path)); },
  unlink(tmpPath) { unlinkSync(tmpPath); },
});

const errText = (e) => (e && e.code) || (e && e.message) || String(e);

// 1 つのファイルを公開する（cli-contract.md「公開の手順」の正本。結果を除く記録はこれで公開する）。
// 戻り値: { ok: true } | { ok: false, exists: true, existing: Uint8Array | null, readError } | { ok: false, reason }
export function publishOne(fs, dir, finalPath, bytes) {
  const tmp = `${finalPath}.tmp-${randomHex(12)}`;
  let wrote = false;
  try {
    try { fs.writeTemp(finalPath, tmp, bytes); wrote = true; } catch (e) { wrote = true; return { ok: false, reason: `一時ファイルを書けない（${errText(e)}）` }; }
    try { fs.link(tmp, finalPath); } catch (e) {
      if (e && e.code === 'EEXIST') {
        try { return { ok: false, exists: true, existing: fs.readFile(finalPath) }; } catch (re) { return { ok: false, exists: true, existing: null, readError: errText(re) }; }
      }
      return { ok: false, reason: `link で公開できない（${errText(e)}）` };
    }
    try { fs.fsyncDir(dir); } catch (e) { return { ok: false, reason: `ディレクトリの fsync ができない（${errText(e)}）` }; }
    let back;
    try { back = fs.readFile(finalPath); } catch (e) { return { ok: false, reason: `再読込できない（${errText(e)}）` }; }
    if (!sameBytes(back, bytes)) return { ok: false, reason: '再読込の指紋が一致しない' };
    return { ok: true };
  } finally {
    if (wrote) { try { fs.unlink(tmp); } catch { /* 後始末の失敗は outcome を変えない */ } }
  }
}

function readExistingResult(fs, path) {
  let bytes;
  try { bytes = fs.readFile(path); } catch (e) { return { readable: false, absent: e && e.code === 'ENOENT' }; }
  try {
    const r = JSON.parse(new TextDecoder().decode(bytes));
    return conforms(Result, r) ? { readable: true, result: r } : { readable: false, absent: false };
  } catch { return { readable: false, absent: false }; }
}

const ledgerKindOf = (name) => (name === 'ledger.json' ? 'ledger' : 'salvage_ledger');
const RESULT_REF = 'result.json';

// 公開できなかった R を捨て、停止 の R' を作り直す（cli-contract.md「状態を決める順序」3）。
export function buildUnpublished(result, { ledgerName, ledgerSaved, reason: why }) {
  const kept = result.records.saved.filter((s) => s.ref !== RESULT_REF && s.ref !== ledgerName);
  const saved = ledgerSaved ? [...kept, { kind: ledgerKindOf(ledgerName), ref: ledgerName, hash: null }] : kept;
  const unsaved = [...result.records.unsaved.filter((u) => u.ref !== RESULT_REF && u.ref !== ledgerName && u.kind !== 'result')];
  if (!ledgerSaved) unsaved.push({ kind: ledgerKindOf(ledgerName), ref: ledgerName, reason: why });
  unsaved.push({ kind: 'result', ref: RESULT_REF, reason: ledgerSaved ? why : `台帳を公開できなかったので結果の公開を試さない（${why}）` });
  const records = { ...result.records, saved, unsaved };
  const sr = result.stop_report;
  const prev = sr ? sr.reasons : [];
  const failure = reason('保存の失敗', '集約', `結果と台帳の公開: ${why}`);
  const reasons = [...prev, failure];
  if (!reasons.some((x) => x.code === '記録の未保存')) reasons.push(reason('記録の未保存', '集約', '保存できなかった記録がある'));
  const report = stopReport({
    reasons,
    confirmed: sr ? sr.confirmed_scope : [], unconfirmed: sr ? sr.unconfirmed_scope : [],
    created: (sr ? sr.artifacts_created : []).filter((a) => a.ref !== RESULT_REF && (ledgerSaved || a.ref !== ledgerName)),
    notCreated: sr ? sr.artifacts_not_created : [],
    running: sr ? sr.checks_running : [], aborted: sr ? sr.checks_aborted : [],
    questions: sr ? sr.questions : result.questions.map((q) => q.id),
    unsaved,
  });
  return { ...result, status: '停止', provisional: true, records, stop_report: report };
}

export function publishResult(input, fs = NODE_FS) {
  const dir = input.run_dir;
  const ledgerName = input.ledger.name;
  const published = { ...input.result, provisional: false };
  const resultBytes = enc(canonicalJson(published));
  const ledgerBytes = enc(canonicalJson({ ...input.ledger.content, registered_result_hash: sha256Bytes(resultBytes) }));
  const ledgerPath = join(dir, ledgerName);
  const resultPath = join(dir, RESULT_REF);
  const failLedger = (reason) => ({ outcome: 'ledger_failed', result: buildUnpublished(published, { ledgerName, ledgerSaved: false, reason }), fault: null });

  const l = publishOne(fs, dir, ledgerPath, ledgerBytes);
  if (!l.ok) {
    if (l.exists) {
      if (l.existing && sameBytes(l.existing, ledgerBytes)) {
        // 決定的に作った記録を 2 つの salvage が公開した場合。成功とみなす
      } else if (l.existing && ledgerName === 'salvage-ledger.json') {
        const r = readExistingResult(fs, resultPath);
        if (r.readable) return { outcome: 'lost', result: r.result, fault: null };
        if (!r.absent) return { outcome: 'lost_unreadable', result: null, fault: null };
        return failLedger('追補台帳が既にあって指紋が違う');
      } else if (!l.existing) {
        // 既にある台帳を読めず、指紋を比べられない（result.json を確かめるのは指紋が違うときだけ）
        return failLedger(`既にある台帳を読めない（${l.readError}）`);
      } else {
        return failLedger('台帳が既にあって指紋が違う');
      }
    } else {
      return failLedger(l.reason);
    }
  }

  return publishResultFile(fs, dir, resultPath, resultBytes, published, ledgerName);
}

const asResult = (bytes) => {
  try { const r = JSON.parse(new TextDecoder().decode(bytes)); return conforms(Result, r) ? r : null; } catch { return null; }
};

// 結果の公開（cli-contract.md「link の後の失敗」）。link に成功した後は取り消さず、R' を作らない。
function publishResultFile(fs, dir, resultPath, bytes, published, ledgerName) {
  const tmp = `${resultPath}.tmp-${randomHex(12)}`;
  const unpublished = (reason) => ({ outcome: 'result_failed', result: buildUnpublished(published, { ledgerName, ledgerSaved: true, reason }), fault: null });
  try {
    try { fs.writeTemp(resultPath, tmp, bytes); } catch (e) { return unpublished(`一時ファイルを書けない（${errText(e)}）`); }
    try { fs.link(tmp, resultPath); } catch (e) {
      if (!(e && e.code === 'EEXIST')) return unpublished(`link で公開できない（${errText(e)}）`);
      let existing;
      try { existing = fs.readFile(resultPath); } catch { return { outcome: 'lost_unreadable', result: null, fault: null }; }
      const r = asResult(existing);
      return r ? { outcome: 'lost', result: r, fault: null } : { outcome: 'lost_unreadable', result: null, fault: null };
    }
    // link の後: fsync が失敗しても再読込は試す。指紋の違いは fsync の失敗より優先する
    let fault = null;
    try { fs.fsyncDir(dir); } catch { fault = 'fsync_dir'; }
    let back;
    try { back = fs.readFile(resultPath); } catch { return { outcome: 'published_unverified', result: published, fault: fault ?? 'reread_io' }; }
    if (!sameBytes(back, bytes)) {
      const r = asResult(back);
      return r ? { outcome: 'lost', result: r, fault: 'reread_mismatch' } : { outcome: 'lost_unreadable', result: null, fault: 'reread_mismatch' };
    }
    return fault ? { outcome: 'published_unverified', result: published, fault } : { outcome: 'published', result: published, fault: null };
  } finally {
    try { fs.unlink(tmp); } catch { /* 後始末の失敗は outcome を変えない */ }
  }
}
