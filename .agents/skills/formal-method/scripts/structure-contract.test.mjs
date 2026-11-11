// cli-contract.md「構造の契約」をソースの走査で確かめる（verification-plan「旧 Lock.tla が見つけた種類の欠陥を、今回どう防ぐか」2）。
// 対象は scripts/ の下の実装（*.test.mjs と test-fixtures/ を除く）。失敗のときは違反箇所と直し方を返す。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkLockContract, checkLinkOnly, checkRegionContract, LINK_ONLY } from './test-fixtures/source-scan.mjs';

const SCRIPTS = fileURLToPath(new URL('.', import.meta.url));
const SKILL = join(SCRIPTS, '..');

function sources() {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) { if (e !== 'test-fixtures' && e !== 'node_modules') walk(p); continue; }
      if (!/\.(mjs|js|cjs)$/.test(e) || /\.test\.(mjs|js)$/.test(e)) continue;
      out.push({ path: relative(SKILL, p), src: readFileSync(p, 'utf8') });
    }
  };
  walk(SCRIPTS);
  return out;
}

const report = (vs) => vs.map((v) => `${v.file}:${v.line} ${v.rule} → ${v.fix}`).join('\n');

// ---- 走査そのものの負例（testing.md: 規約を強制する検査ツール自身にも負例を設ける） ----
const STORE_OK = `import { unlinkSync, readFileSync } from 'node:fs';
const lockPath = (dir) => join(dir, 'run.lock');
export function releaseOwnLock(dir, nonce) {
  const held = JSON.parse(readFileSync(lockPath(dir), 'utf8'));
  if (held.nonce !== nonce) return false;
  unlinkSync(lockPath(dir));
  return true;
}
export function acquire(dir, id) { writeFileSync(join(dir, 'run.lock'), JSON.stringify(id), { flag: 'wx' }); }
`;
const SCAN_CASES = [
  ['正しい store.mjs は違反なし', [{ path: 'scripts/lib/store.mjs', src: STORE_OK }], []],
  ['releaseOwnLock の外で消す', [{ path: 'scripts/lib/store.mjs', src: STORE_OK }, { path: 'scripts/lib/x.mjs', src: "const L = join(d, 'run.lock');\nfs.rmSync(L, { force: true });\n" }], ['releaseOwnLock の外']],
  ['別の関数から lock の path の関数で消す', [{ path: 'scripts/lib/store.mjs', src: `${STORE_OK}\nexport function breakLock(dir) { unlinkSync(lockPath(dir)); }\n` }], ['releaseOwnLock の外']],
  ['nonce を照合せずに消す', [{ path: 'scripts/lib/store.mjs', src: "export function releaseOwnLock(dir) {\n  unlinkSync(join(dir, 'run.lock'));\n}\n" }], ['nonce を照合する前']],
  ['lock を rename する', [{ path: 'scripts/lib/store.mjs', src: STORE_OK }, { path: 'scripts/a.mjs', src: "renameSync(tmp, join(d, 'run.lock'));\n" }], ['rename']],
  ['lock を排他でなく上書きする', [{ path: 'scripts/lib/store.mjs', src: STORE_OK }, { path: 'scripts/a.mjs', src: "writeFileSync(join(d, 'run.lock'), 'x');\n" }], ['上書き']],
  ['releaseOwnLock が無い', [{ path: 'scripts/lib/store.mjs', src: 'export const x = 1;\n' }], ['export していない']],
  ['store.mjs が無い', [{ path: 'scripts/lib/other.mjs', src: '' }], ['store.mjs が無い']],
  ['コメントと文字列の中の呼出しは数えない', [{ path: 'scripts/lib/store.mjs', src: `${STORE_OK}\n// unlinkSync(join(d, 'run.lock'))\nconst s = "rmSync('run.lock')";\n` }], []],
];
for (const [name, files, expected] of SCAN_CASES) {
  test(`cli-contract 構造の契約 走査の自己検査: ${name}`, () => {
    const vs = checkLockContract(files);
    assert.equal(vs.length > 0, expected.length > 0, report(vs));
    for (const e of expected) assert.ok(vs.some((v) => v.rule.includes(e)), `${e}: ${report(vs)}`);
  });
}

test('cli-contract 構造の契約 走査の自己検査: link でだけ作る記録を writeFile・rename で作ると違反、一時の名前と link は許す', () => {
  const bad = [{ path: 'scripts/a.mjs', src: "writeFileSync(join(d, 'salvage.mark'), id);\nrenameSync(t, join(d, 'result.json'));\n" }];
  const good = [{ path: 'scripts/a.mjs', src: "const tmp = join(d, `salvage.mark.tmp-${n}`);\nwriteFileSync(tmp, id);\nlinkSync(tmp, join(d, 'salvage.mark'));\n" }];
  assert.equal(checkLinkOnly(bad).length, 2, report(checkLinkOnly(bad)));
  assert.deepEqual(checkLinkOnly(good), []);
});

const START_OK = `export function removeOwnTmp(root, runId, nonce) { rmSync(join(root, \`.tmp-\${runId}-\${nonce}\`), { recursive: true, force: true }); }
export function removeProbeDir(dir) { rmSync(dir, { recursive: true, force: true }); }
`;
const STORE_REGION_OK = `export function publishRunDir(root, runId, nonce) { renameSync(join(root, \`.tmp-\${runId}-\${nonce}\`), join(root, runId)); }
export function writeAtomic(p, s) { const t = \`\${p}.tmp-\${n}\`; writeFileSync(t, s); renameSync(t, p); }
`;
const REGION_CASES = [
  ['正しい 4 つの関数は違反なし', [{ path: 'scripts/lib/store.mjs', src: STORE_REGION_OK }, { path: 'scripts/lib/start.mjs', src: START_OK }], []],
  ['publishRunDir の外で一時の領域を rename する', [{ path: 'scripts/lib/store.mjs', src: STORE_REGION_OK }, { path: 'scripts/lib/start.mjs', src: START_OK }, { path: 'scripts/lib/daemon.mjs', src: 'const tmp = join(root, `.tmp-${id}-${n}`);\nrenameSync(tmp, join(root, id));\n' }], ['publishRunDir の外']],
  ['removeOwnTmp の外でディレクトリを消す', [{ path: 'scripts/lib/store.mjs', src: STORE_REGION_OK }, { path: 'scripts/lib/start.mjs', src: `${START_OK}export function cleanup(d) { rmSync(d, { recursive: true }); }\n` }], ['removeOwnTmp・removeProbeDir の外']],
  ['run の領域を消す', [{ path: 'scripts/lib/store.mjs', src: STORE_REGION_OK }, { path: 'scripts/lib/start.mjs', src: START_OK }, { path: 'scripts/lib/salvage.mjs', src: 'fs.rmSync(runDir, { recursive: true, force: true });\n' }], ['removeOwnTmp・removeProbeDir の外']],
  ['関数が無い', [{ path: 'scripts/lib/store.mjs', src: '' }, { path: 'scripts/lib/start.mjs', src: '' }], ['publishRunDir が無い', 'removeOwnTmp が無い', 'removeProbeDir が無い']],
];
for (const [name, files, expected] of REGION_CASES) {
  test(`cli-contract 構造の契約 走査の自己検査（一時の領域）: ${name}`, () => {
    const vs = checkRegionContract(files);
    assert.equal(vs.length > 0, expected.length > 0, report(vs));
    for (const e of expected) assert.ok(vs.some((v) => v.rule.includes(e)), `${e}: ${report(vs)}`);
  });
}

// ---- 実装への適用 ----
test('cli-contract 構造の契約: <run_id>/run.lock を消す呼出しは scripts/lib/store.mjs の releaseOwnLock の中にだけあり、nonce の照合の後だけ。他に run.lock を消す・上書きする呼出しは無い', () => {
  const vs = checkLockContract(sources());
  assert.deepEqual(vs, [], `違反:\n${report(vs)}`);
});

test('cli-contract 構造の契約: result.json・salvage.mark・salvage-ledger.json・salvage-worklog.json・inbox/<batch_id>.json を一時ファイルからの link でだけ作る', () => {
  const vs = [...checkLinkOnly(sources(), LINK_ONLY), ...checkLinkOnly(sources(), ['inbox'])];
  assert.deepEqual(vs, [], `違反:\n${report(vs)}`);
});

test('cli-contract 構造の契約: 一時の領域の rename は store.mjs の publishRunDir、.tmp-* を消すのは start.mjs の removeOwnTmp、.probe-* を消すのは removeProbeDir の中にだけある', () => {
  const vs = checkRegionContract(sources());
  assert.deepEqual(vs, [], `違反:\n${report(vs)}`);
});
