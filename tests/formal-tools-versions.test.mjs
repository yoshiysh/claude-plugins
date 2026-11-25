// versions.mk（形式検証の道具の版の正本）と、CI（.github/workflows/verification.yml）が取る版が一致することを照らす。
// CI は job ごとに道具を落とすので、手元の make setup-formal と版がずれると、手元で通った検査を CI が別の版で流す。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const versions = Object.fromEntries(
  readFileSync(path.join(ROOT, 'versions.mk'), 'utf8')
    .split('\n')
    .map((line) => /^([A-Z0-9_]+) := (.+)$/.exec(line))
    .filter(Boolean)
    .map((m) => [m[1], m[2].trim()]),
);
const ci = readFileSync(path.join(ROOT, '.github/workflows/verification.yml'), 'utf8');
const setup = readFileSync(path.join(ROOT, 'scripts/setup_formal.sh'), 'utf8');
const HEX64 = /^[0-9a-f]{64}$/;

test('CI が落とす tla2tools.jar は versions.mk の URL と版のキャッシュの鍵を使う', () => {
  assert.ok(versions.TLA2TOOLS_URL.includes(`/v${versions.TLA2TOOLS_VERSION}/`), 'URL と版が合わない');
  assert.match(versions.TLA2TOOLS_SHA256, HEX64);
  const urls = [...ci.matchAll(/https:\/\/github\.com\/tlaplus\/tlaplus\/releases\/download\/\S+/g)].map((m) => m[0]);
  assert.ok(urls.length > 0, 'CI に tla2tools.jar の URL が無い');
  assert.deepEqual([...new Set(urls)], [versions.TLA2TOOLS_URL]);
  const keys = [...ci.matchAll(/key: (tla2tools-v\S+)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(keys)], [`tla2tools-v${versions.TLA2TOOLS_VERSION}`]);
});

test('CI が落とす Z3 は versions.mk の Linux x64 の資産と sha256 を使う', () => {
  const urls = [...ci.matchAll(/https:\/\/github\.com\/Z3Prover\/z3\/releases\/download\/\S+/g)].map((m) => m[0]);
  assert.deepEqual([...new Set(urls)], [`${versions.Z3_URL_BASE}/${versions.Z3_ASSET_LINUX_X64}`]);
  assert.ok(ci.includes(`echo "${versions.Z3_SHA256_LINUX_X64}  $Z3_ZIP" | sha256sum -c -`), 'CI の sha256 の照合が versions.mk の値と違う');
  const cacheKeys = [...ci.matchAll(/key: (z3-\S+)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(cacheKeys)], [`${versions.Z3_ASSET_LINUX_X64.replace(/\.zip$/, '')}-${versions.Z3_SHA256_LINUX_X64.slice(0, 16)}`]);
});

test('versions.mk は setup_formal.sh が引く全ての OS とアーキテクチャの Z3 を持つ', () => {
  assert.ok(versions.Z3_URL_BASE.endsWith(`/z3-${versions.Z3_VERSION}`), 'Z3_URL_BASE と版が合わない');
  const keys = [...setup.matchAll(/\) key=([A-Z0-9_]+) ;;/g)].map((m) => m[1]).sort();
  assert.deepEqual(keys, ['DARWIN_ARM64', 'DARWIN_X64', 'LINUX_ARM64', 'LINUX_X64']);
  const listed = Object.keys(versions).filter((k) => k.startsWith('Z3_ASSET_')).map((k) => k.slice('Z3_ASSET_'.length)).sort();
  assert.deepEqual(listed, keys);
  for (const key of keys) {
    assert.ok(versions[`Z3_ASSET_${key}`].startsWith(`z3-${versions.Z3_VERSION}-`), `${key} の版が Z3_VERSION と違う`);
    assert.match(versions[`Z3_SHA256_${key}`] || '', HEX64, `${key} に sha256 が無い`);
  }
});

test('TLC を使う検査の入口は jar の sha256 を versions.mk から読み、値を直書きしない', () => {
  for (const rel of ['tests/formal/bp-prd/check.sh', 'tests/formal/formal-method-skill/check.sh']) {
    const src = readFileSync(path.join(ROOT, rel), 'utf8');
    assert.match(src, /TLA2TOOLS_SHA256 := .*versions\.mk/, `${rel} が versions.mk を読まない`);
    assert.doesNotMatch(src, /[0-9a-f]{64}/, `${rel} に sha256 が直書きされている`);
  }
});
