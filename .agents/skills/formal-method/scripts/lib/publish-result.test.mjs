// unit: scripts/lib/publish.mjs の publishResult(input, fs)（cli-contract「unit の入口（内部）」2）。
// FsBoundary を記憶の上のファイル系に差し替え、cli-contract「結果と台帳の保存の失敗」の表の行と lost_unreadable を確かめる。
// 結合テストで起こせない「台帳は成功し、結果の公開だけが I/O で失敗する組」をここで覆う。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { basename, join } from 'node:path';
import { sampleResult } from '../test-fixtures/fabricate.mjs';
import { resultInvariants } from '../test-fixtures/result-schema.mjs';

const loadPublish = () => import('./publish.mjs');
const RUN = '/runs/R1';
const sha = (b) => `sha256:${createHash('sha256').update(b).digest('hex')}`;
const enc = (v) => new TextEncoder().encode(typeof v === 'string' ? v : JSON.stringify(v));
const dec = (b) => new TextDecoder().decode(b);
const err = (code) => Object.assign(new Error(code), { code });

// 記憶の上のファイル系（FsBoundary）。fail は { op, final（最終の名前の basename）, code }。
// writeTemp・link・readFile は引数の path で、fsyncDir は直前に link に成功した finalPath で指す（呼ぶ順に縛らない）。
// corrupt は再読込で違うバイトを返す最終の名前。契約の境界の形（path は絶対、一時ファイルは <finalPath>.tmp-<24 桁の 16 進>）も確かめる。
const TMP = /^(.+)\.tmp-[0-9a-f]{24}$/;
function memFs({ files = {}, fail = [], corrupt = [] } = {}) {
  const store = new Map(Object.entries(files).map(([k, v]) => [k, enc(v)]));
  const log = [];
  const violations = [];
  let lastLinked = null;
  const hit = (op, p) => fail.find((f) => f.op === op && f.final === basename(p));
  const abs = (p, what) => { if (!p.startsWith('/')) violations.push(`${what} の path ${p} が絶対 path でない`); };
  return {
    store, log, violations,
    tmpLeft: () => [...store.keys()].filter((k) => TMP.test(k)),
    writeTemp(finalPath, tmpPath, bytes) {
      log.push(['writeTemp', finalPath, tmpPath]);
      abs(finalPath, 'writeTemp'); abs(tmpPath, 'writeTemp');
      const m = tmpPath.match(TMP);
      if (!m || m[1] !== finalPath) violations.push(`一時ファイルの名前 ${tmpPath} が <finalPath>.tmp-<24 桁の 16 進> でない`);
      const f = hit('writeTemp', finalPath); if (f) throw err(f.code);
      store.set(tmpPath, new Uint8Array(bytes));
    },
    link(tmpPath, finalPath) {
      log.push(['link', tmpPath, finalPath]);
      abs(tmpPath, 'link'); abs(finalPath, 'link');
      const f = hit('link', finalPath); if (f) throw err(f.code);
      if (store.has(finalPath)) throw err('EEXIST');
      if (!store.has(tmpPath)) throw err('ENOENT');
      store.set(finalPath, store.get(tmpPath));
      lastLinked = finalPath;
      log.push(['linked', finalPath]);
    },
    fsyncDir(dirPath) {
      log.push(['fsyncDir', dirPath]);
      abs(dirPath, 'fsyncDir');
      const f = lastLinked && hit('fsyncDir', lastLinked); if (f) throw err(f.code);
    },
    readFile(path) {
      log.push(['readFile', path]);
      abs(path, 'readFile');
      const f = hit('readFile', path); if (f) throw err(f.code);
      if (!store.has(path)) throw err('ENOENT');
      const st = store.get(path);
      if (st === 'DIR') throw err('EISDIR');
      return corrupt.includes(basename(path)) ? enc('corrupted') : st;
    },
    unlink(tmpPath) {
      log.push(['unlink', tmpPath]);
      const m = tmpPath.match(TMP);
      if (!m) violations.push(`unlink ${tmpPath} が一時ファイルでない`);
      const f = m && hit('unlink', m[1]); if (f) throw err(f.code);
      store.delete(tmpPath);
    },
  };
}

// 契約の保証: 台帳の link の成功が、結果の writeTemp より前。一時ファイルは戻る前に消す。境界の形に合う。
function assertBoundary(fs, ledgerName) {
  assert.deepEqual(fs.violations, []);
  assert.deepEqual(fs.tmpLeft(), [], '一時ファイルは成功でも失敗でも消す');
  const resultTemp = fs.log.findIndex((x) => x[0] === 'writeTemp' && basename(x[1]) === 'result.json');
  if (resultTemp >= 0) {
    const ledgerLinked = fs.log.findIndex((x) => x[0] === 'linked' && basename(x[1]) === ledgerName);
    assert.ok(ledgerLinked >= 0 && ledgerLinked < resultTemp, '台帳の link の成功が、結果の writeTemp より前');
  }
}

function completedR() {
  const r = sampleResult('R');
  r.status = '完了';
  r.stop_report = null;
  r.records = { ledger_refs: ['ledger.json'], saved: [{ kind: 'ledger', ref: 'ledger.json', hash: null }, { kind: 'result', ref: 'result.json', hash: null }], unsaved: [] };
  return r;
}
const ledgerContent = (name = 'ledger.json') => ({ schema: 'formal-method.ledger/1', run_id: 'R1', kind: name === 'ledger.json' ? 'main' : 'salvage', entries: [], registered_result_hash: null });
const input = (name = 'ledger.json') => ({ run_dir: RUN, ledger: { name, content: ledgerContent(name) }, result: completedR() });
const linkedTo = (fs) => fs.log.filter((x) => x[0] === 'link').map((x) => basename(x[2]));
const kindOfLedger = (name) => (name === 'ledger.json' ? 'ledger' : 'salvage_ledger');

function assertRPrime(r, ledgerName, ledgerSaved) {
  assert.deepEqual(resultInvariants(r), []);
  assert.equal(r.status, '停止');
  assert.equal(r.provisional, true, 'R\' は仮の結果');
  const reasons = r.stop_report.reasons;
  assert.ok(reasons.some((x) => x.code === '保存の失敗' && x.stage === '集約'), JSON.stringify(reasons));
  assert.ok(reasons.some((x) => x.code === '記録の未保存'), JSON.stringify(reasons));
  const saved = r.records.saved.map((s) => s.ref);
  const unsaved = r.records.unsaved;
  assert.ok(unsaved.some((u) => u.kind === 'result' && u.reason.length > 0), '結果が理由とともに unsaved');
  assert.ok(!saved.includes('result.json'), '結果は saved に無い');
  if (ledgerSaved) {
    assert.ok(r.records.saved.some((s) => s.ref === ledgerName && s.hash === null), '台帳の参照が saved（hash null）');
    assert.ok(!unsaved.some((u) => u.kind === kindOfLedger(ledgerName)));
  } else {
    assert.ok(unsaved.some((u) => u.kind === kindOfLedger(ledgerName) && u.reason.length > 0), '台帳が理由とともに unsaved');
    assert.ok(!saved.includes(ledgerName));
  }
}

for (const name of ['ledger.json', 'salvage-ledger.json']) {
  test(`cli-contract publishResult published（${name}）: 台帳 → 結果の順に link で公開し、R を返す。台帳は公開した結果の指紋を持つ`, async () => {
    const { publishResult } = await loadPublish();
    const fs = memFs();
    const out = publishResult(input(name), fs);
    assert.equal(out.outcome, 'published');
    assert.deepEqual(out.result, completedR());
    assertBoundary(fs, name);
    assert.deepEqual(linkedTo(fs).filter((n) => n === name || n === 'result.json'), [name, 'result.json'], '台帳が先');
    const resultBytes = fs.store.get(join(RUN, 'result.json'));
    assert.deepEqual(JSON.parse(dec(resultBytes)), completedR());
    assert.equal(JSON.parse(dec(resultBytes)).provisional, false, '公開した result.json は常に provisional: false');
    const ledger = JSON.parse(dec(fs.store.get(join(RUN, name))));
    assert.equal(ledger.registered_result_hash, sha(resultBytes), '結果の指紋は関数が埋める');
    for (const [, , to] of fs.log.filter((x) => x[0] === 'link')) assert.ok(to.startsWith(`${RUN}/`), '最終の名前は run の領域の中');
    for (const [, dir] of fs.log.filter((x) => x[0] === 'fsyncDir')) assert.equal(dir, RUN, 'finalPath のディレクトリを fsync する');
    assert.ok(fs.log.some((x) => x[0] === 'fsyncDir'), 'ディレクトリを fsync する');
    assert.ok(fs.log.some((x) => x[0] === 'readFile' && basename(x[1]) === 'result.json'), '再読込して照合する');
  });
}

test('cli-contract publishResult published: 台帳が既にあって指紋が同じなら成功とみなし、結果を公開する', async () => {
  const { publishResult } = await loadPublish();
  // 先に 1 回公開した後の台帳の内容を、別の記憶の上に置いて同じ入力で公開する（決定的に作った salvage の記録）
  const first = memFs();
  publishResult(input('salvage-ledger.json'), first);
  const ledgerBytes = dec(first.store.get(join(RUN, 'salvage-ledger.json')));
  const fs = memFs({ files: { [join(RUN, 'salvage-ledger.json')]: ledgerBytes } });
  const out = publishResult(input('salvage-ledger.json'), fs);
  assert.equal(out.outcome, 'published');
  assertBoundary(fs, 'salvage-ledger.json');
  assert.ok(fs.store.has(join(RUN, 'result.json')));
});

test('cli-contract publishResult lost: result.json が既にあれば、中身によらず負けとし、既にある結果を読んで返す', async () => {
  const { publishResult } = await loadPublish();
  const existing = sampleResult('既にある結果');
  const fs = memFs({ files: { [join(RUN, 'result.json')]: existing } });
  const out = publishResult(input(), fs);
  assert.equal(out.outcome, 'lost');
  assert.deepEqual(out.result, existing);
  assert.deepEqual(JSON.parse(dec(fs.store.get(join(RUN, 'result.json')))), existing, '既にある結果を変えない');
  assertBoundary(fs, 'ledger.json');
});

test('cli-contract publishResult lost: salvage の追補台帳が既にあって指紋が違っても、result.json があれば既にある結果を返す', async () => {
  const { publishResult } = await loadPublish();
  const existing = sampleResult('勝者の結果');
  const fs = memFs({ files: { [join(RUN, 'salvage-ledger.json')]: { other: true }, [join(RUN, 'result.json')]: existing } });
  const out = publishResult(input('salvage-ledger.json'), fs);
  assert.equal(out.outcome, 'lost');
  assert.deepEqual(out.result, existing);
  assert.deepEqual(fs.tmpLeft(), []);
});

// lost_unreadable: 負けたが、既にある result.json を読めないか、結果の形に合わない
const UNREADABLE = [
  ['JSON でない', { files: { [join(RUN, 'result.json')]: '{"schema": "formal-' } }, 'ledger.json'],
  ['結果の形に合わない', { files: { [join(RUN, 'result.json')]: { schema: 'formal-method.result/1', broken: true } } }, 'ledger.json'],
  ['読むと I/O の誤り', { files: { [join(RUN, 'result.json')]: sampleResult('x') }, fail: [{ op: 'readFile', final: 'result.json', code: 'EIO' }] }, 'ledger.json'],
  ['追補台帳が既にあって指紋が違い、result.json が形に合わない', { files: { [join(RUN, 'salvage-ledger.json')]: { other: true }, [join(RUN, 'result.json')]: { broken: true } } }, 'salvage-ledger.json'],
];
for (const [name, opts, ledgerName] of UNREADABLE) {
  test(`cli-contract publishResult lost_unreadable: 既にある result.json が${name}なら、新しい結果を作らず result: null を返し、既にあるファイルを変えない`, async () => {
    const { publishResult } = await loadPublish();
    const fs = memFs(opts);
    const before = fs.store.get(join(RUN, 'result.json'));
    let out;
    assert.doesNotThrow(() => { out = publishResult(input(ledgerName), fs); });
    assert.deepEqual(out, { outcome: 'lost_unreadable', result: null });
    assert.equal(fs.store.get(join(RUN, 'result.json')), before);
    assert.deepEqual(fs.tmpLeft(), []);
    assert.deepEqual(fs.violations, []);
  });
}

// 台帳は成功し、結果の公開だけが I/O で失敗する組（結合テストで起こせない組）
const RESULT_FAIL = [
  ['結果の link が EEXIST 以外の誤り（EIO）', { fail: [{ op: 'link', final: 'result.json', code: 'EIO' }] }],
  ['結果の一時ファイルを書けない（ENOSPC）', { fail: [{ op: 'writeTemp', final: 'result.json', code: 'ENOSPC' }] }],
  ['結果の link の後のディレクトリの fsync が I/O の誤り', { fail: [{ op: 'fsyncDir', final: 'result.json', code: 'EIO' }] }],
  ['結果の再読込の指紋が合わない', { corrupt: ['result.json'] }],
  ['結果の再読込が I/O の誤り', { fail: [{ op: 'readFile', final: 'result.json', code: 'EIO' }] }],
];
for (const [name, opts] of RESULT_FAIL) {
  test(`cli-contract publishResult result_failed: ${name}なら、R を捨てて 停止 の R' を返し、台帳の参照は saved、結果は unsaved`, async () => {
    const { publishResult } = await loadPublish();
    const fs = memFs(opts);
    let out;
    assert.doesNotThrow(() => { out = publishResult(input(), fs); }, 'fs の誤りを外へ出さない');
    assert.equal(out.outcome, 'result_failed');
    assertBoundary(fs, 'ledger.json');
    assertRPrime(out.result, 'ledger.json', true);
    assert.ok(fs.store.has(join(RUN, 'ledger.json')), '台帳は公開した');
    if (!opts.corrupt) assert.equal(fs.store.has(join(RUN, 'result.json')), false);
  });
}

const LEDGER_FAIL = [
  ['台帳の link が EIO', 'ledger.json', { fail: [{ op: 'link', final: 'ledger.json', code: 'EIO' }] }],
  ['台帳の一時ファイルを書けない', 'ledger.json', { fail: [{ op: 'writeTemp', final: 'ledger.json', code: 'EACCES' }] }],
  ['台帳の link の後のディレクトリの fsync が I/O の誤り', 'ledger.json', { fail: [{ op: 'fsyncDir', final: 'ledger.json', code: 'EIO' }] }],
  ['台帳の再読込の指紋が合わない', 'ledger.json', { corrupt: ['ledger.json'] }],
  ['run-daemon の台帳が既にあって指紋が違う', 'ledger.json', { files: { [join(RUN, 'ledger.json')]: { other: true } } }],
  ['salvage の追補台帳が既にあって指紋が違い、result.json が無い', 'salvage-ledger.json', { files: { [join(RUN, 'salvage-ledger.json')]: { other: true } } }],
];
for (const [name, ledgerName, opts] of LEDGER_FAIL) {
  test(`cli-contract publishResult ledger_failed: ${name}なら、結果の公開を試さず、停止 の R' に台帳と結果を unsaved で載せる`, async () => {
    const { publishResult } = await loadPublish();
    const fs = memFs(opts);
    let out;
    assert.doesNotThrow(() => { out = publishResult(input(ledgerName), fs); });
    assert.equal(out.outcome, 'ledger_failed');
    assertBoundary(fs, ledgerName);
    assertRPrime(out.result, ledgerName, false);
    assert.ok(!linkedTo(fs).includes('result.json'), '結果の link を試さない');
    assert.equal(fs.store.has(join(RUN, 'result.json')), false);
  });
}

test('cli-contract publishResult: どの操作がどの誤りを投げても、例外を外へ出さず 4 つの outcome のどれかを返し、完了 は published のときだけ', async () => {
  const { publishResult } = await loadPublish();
  for (const op of ['writeTemp', 'link', 'fsyncDir', 'readFile']) for (const nm of ['ledger.json', 'result.json']) for (const code of ['EIO', 'EEXIST', 'EACCES']) {
    const fs = memFs({ fail: [{ op, final: nm, code }] });
    let out;
    assert.doesNotThrow(() => { out = publishResult(input(), fs); }, `${op} ${nm} ${code}`);
    assert.ok(['published', 'lost', 'lost_unreadable', 'result_failed', 'ledger_failed'].includes(out.outcome));
    if (out.outcome === 'lost_unreadable') assert.equal(out.result, null);
    else if (out.result.status === '完了') assert.equal(out.outcome, 'published', `${op} ${nm} ${code}`);
    if (out.outcome === 'result_failed' || out.outcome === 'ledger_failed') assert.equal(out.result.status, '停止');
    assert.deepEqual(fs.tmpLeft(), [], `${op} ${nm} ${code}: 一時ファイルを消す`);
  }
});

test('cli-contract publishResult: 一時ファイルの unlink の失敗は outcome を変えない', async () => {
  const { publishResult } = await loadPublish();
  const fs = memFs({ fail: [{ op: 'unlink', final: 'result.json', code: 'EIO' }, { op: 'unlink', final: 'ledger.json', code: 'EIO' }] });
  let out;
  assert.doesNotThrow(() => { out = publishResult(input(), fs); });
  assert.equal(out.outcome, 'published');
  assert.ok(fs.log.some((x) => x[0] === 'unlink'), '一時ファイルを消そうとする');
  assert.deepEqual(fs.violations, []);
});
