// 結果の公開（cli-contract.md「結果と台帳の保存の失敗」「unit の入口（内部）」2）。台帳 → result.json の順に、
// 一時ファイル・fsync・link（run-daemon の台帳は rename）・ディレクトリの fsync・再読込の指紋の照合で公開する。fs の誤りは外へ出さず outcome で返す。
// 台帳（ledger.json）を書く関数は writeLedger だけで、run-daemon の段ごとの書込みと集約の公開はどちらもこれを呼ぶ（cli-contract.md「構造の契約」）。
import { linkSync, readFileSync, renameSync, unlinkSync } from 'node:fs';
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
  rename(tmpPath, finalPath) { renameSync(tmpPath, finalPath); },
  fsyncDir(dirPath) { fsyncDir(dirPath); },
  readFile(path) { return new Uint8Array(readFileSync(path)); },
  unlink(tmpPath) { unlinkSync(tmpPath); },
});

const errText = (e) => (e && e.code) || (e && e.message) || String(e);

// 公開の手順（cli-contract.md「公開の手順」の正本）: 一時ファイルの書込み・置く・ディレクトリの fsync・再読込の指紋の照合・一時ファイルの後始末。
// 置き方だけを引数で受ける。place(tmp) は一時ファイルを finalPath に置き、成功なら null、失敗なら返す outcome を返す。
// keepsTmp は置いた後も一時ファイルの名前が残るか（link は残るので後始末で消し、rename は残らないので消さない）。置けなければ一時ファイルを消す。
function writeVerified(fs, dir, finalPath, bytes, { place, keepsTmp }) {
  const tmp = `${finalPath}.tmp-${randomHex(12)}`;
  let pending = false;
  try {
    try { pending = true; fs.writeTemp(finalPath, tmp, bytes); } catch (e) { return { ok: false, reason: `一時ファイルを書けない（${errText(e)}）` }; }
    const failed = place(tmp);
    if (failed) return failed;
    if (!keepsTmp) pending = false;
    try { fs.fsyncDir(dir); } catch (e) { return { ok: false, reason: `ディレクトリの fsync ができない（${errText(e)}）` }; }
    let back;
    try { back = fs.readFile(finalPath); } catch (e) { return { ok: false, reason: `再読込できない（${errText(e)}）` }; }
    if (!sameBytes(back, bytes)) return { ok: false, reason: '再読込の指紋が一致しない' };
    return { ok: true };
  } finally {
    if (pending) { try { fs.unlink(tmp); } catch { /* 後始末の失敗は outcome を変えない */ } }
  }
}

// 1 つのファイルを link で公開する（結果を除く記録はこれで公開する。既にあれば置き換えない）。
// 戻り値: { ok: true } | { ok: false, exists: true, existing: Uint8Array | null, readError } | { ok: false, reason }
export function publishOne(fs, dir, finalPath, bytes) {
  return writeVerified(fs, dir, finalPath, bytes, {
    keepsTmp: true,
    place: (tmp) => {
      try { fs.link(tmp, finalPath); return null; } catch (e) {
        if (e && e.code === 'EEXIST') {
          try { return { ok: false, exists: true, existing: fs.readFile(finalPath) }; } catch (re) { return { ok: false, exists: true, existing: null, readError: errText(re) }; }
        }
        return { ok: false, reason: `link で公開できない（${errText(e)}）` };
      }
    },
  });
}

// run-daemon の台帳の名前。run の台帳はこの 1 つのファイルで、写しを持たない（PR-BPDESIGNEDSKILL-032）。
export const LEDGER_REF = 'ledger.json';

// 台帳を書く（cli-contract.md「結果と台帳の保存の失敗」の台帳）。run-daemon だけが、段の確定ごとと集約の公開で呼ぶ。
// 公開の手順と同じで、置き方だけが rename である。rename で置き換えるので、読む者は書きかけを見ず、
// 保存済みの範囲は rename を終えた台帳だけで決まる。戻り値: { ok: true } | { ok: false, reason }
export function writeLedger(fs, dir, content) {
  const finalPath = join(dir, LEDGER_REF);
  return writeVerified(fs, dir, finalPath, enc(canonicalJson(content)), {
    keepsTmp: false,
    place: (tmp) => {
      try { fs.rename(tmp, finalPath); return null; } catch (e) { return { ok: false, reason: `rename で置き換えられない（${errText(e)}）` }; }
    },
  });
}

function readExistingResult(fs, path) {
  let bytes;
  try { bytes = fs.readFile(path); } catch (e) { return { readable: false, absent: e && e.code === 'ENOENT' }; }
  try {
    const r = JSON.parse(new TextDecoder().decode(bytes));
    return conforms(Result, r) ? { readable: true, result: r } : { readable: false, absent: false };
  } catch { return { readable: false, absent: false }; }
}

const ledgerKindOf = (name) => (name === LEDGER_REF ? 'ledger' : 'salvage_ledger');
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

// Status の result に置く値（cli-contract.md「status.json」）。result.json にあって、読んだバイト列がその結果だと確かめたもの
// （published と lost）は、本文の代わりに参照 { ref, path } を置く。それ以外（公開しなかった R'・再読込で確かめられなかった R）は、
// Status が本文を持つ（参照する先が無いか、その先を確かめていない）。
export const resultRefOf = (runDir) => ({ ref: RESULT_REF, path: join(runDir, RESULT_REF) });
export function resultForStatus(runDir, out) {
  return out.outcome === 'published' || out.outcome === 'lost' ? resultRefOf(runDir) : out.result;
}

export function publishResult(input, fs = NODE_FS) {
  const dir = input.run_dir;
  const ledgerName = input.ledger.name;
  const published = { ...input.result, provisional: false };
  const resultBytes = enc(canonicalJson(published));
  const ledgerContent = { ...input.ledger.content, registered_result_hash: sha256Bytes(resultBytes) };
  const ledgerBytes = enc(canonicalJson(ledgerContent));
  const ledgerPath = join(dir, ledgerName);
  const resultPath = join(dir, RESULT_REF);
  const failLedger = (reason) => ({ outcome: 'ledger_failed', result: buildUnpublished(published, { ledgerName, ledgerSaved: false, reason }), fault: null });

  // run-daemon の台帳は段ごとに書いた同じファイルを rename で置き換える。salvage の追補台帳は link で 1 度だけ作る
  if (ledgerName === LEDGER_REF) {
    const w = writeLedger(fs, dir, ledgerContent);
    if (!w.ok) return failLedger(w.reason);
    return publishResultFile(fs, dir, resultPath, resultBytes, published, ledgerName);
  }
  const l = publishOne(fs, dir, ledgerPath, ledgerBytes);
  if (!l.ok) {
    if (l.exists) {
      if (l.existing && sameBytes(l.existing, ledgerBytes)) {
        // 決定的に作った記録を 2 つの salvage が公開した場合。成功とみなす
      } else if (l.existing) {
        const r = readExistingResult(fs, resultPath);
        if (r.readable) return { outcome: 'lost', result: r.result, fault: null };
        if (!r.absent) return { outcome: 'lost_unreadable', result: null, fault: null };
        return failLedger('追補台帳が既にあって指紋が違う');
      } else {
        // 既にある台帳を読めず、指紋を比べられない（result.json を確かめるのは指紋が違うときだけ）
        return failLedger(`既にある台帳を読めない（${l.readError}）`);
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
