// 実行体 formal-method-core の配線を、Makefile・CI・crate・plugin.json の字句で確かめる（#264 の SP-264-001・004・090）。
// U1（crate と test-rust）・U2（core-bin と Node の job の toolchain）・U6（plugin.json の版・cli-contract.md の節・SKILL.md の install の行）が共有する。
// U2 の検査は U2 が足す scripts/lib/core.mjs が在るときだけ当てる（U1 の受理の時点では core-bin はまだ無い）。
// core.mjs が在ることそのものは U2 だけが持つ core-version.test.mjs が確かめるので、この条件で検査が外れたままにはならない。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const SCRIPTS = fileURLToPath(new URL('.', import.meta.url));
const SKILL = join(SCRIPTS, '..');
const ROOT = join(SKILL, '..', '..', '..', '..');
const CRATE = join(ROOT, 'plugins', 'verification', 'crates', 'formal-method-core');
const CRATE_REL = 'plugins/verification/crates/formal-method-core';
const read = (p) => readFileSync(p, 'utf8');
const MAKEFILE = () => read(join(ROOT, 'Makefile'));
const CI = () => read(join(ROOT, '.github', 'workflows', 'verification.yml'));
const U2_READY = existsSync(join(SCRIPTS, 'lib', 'core.mjs'));
// 先例 fa4a32d と同じ toolchain の action（commit で固定）と版
const TOOLCHAIN_ACTION = 'dtolnay/rust-toolchain@683b588c487a69d01f6c6ddf40f036ff682cc2c8';
const TOOLCHAIN = '1.99.0';

// Makefile の規則の 1 行目（ターゲット: 前提）とレシピ（タブで始まる続きの行）
function rule(mk, target) {
  const lines = mk.split('\n');
  const i = lines.findIndex((l) => new RegExp(`^${target.replace(/[-.]/g, '\\$&')}\\s*:(?!=)`).test(l));
  if (i < 0) return null;
  const recipe = [];
  for (let j = i + 1; j < lines.length && (lines[j].startsWith('\t') || (recipe.length && lines[j - 1].endsWith('\\'))); j += 1) recipe.push(lines[j]);
  return { head: lines[i], prereqs: lines[i].replace(/^[^:]*:/, '').trim().split(/\s+/).filter(Boolean), recipe: recipe.join('\n') };
}

// CI の jobs を、2 字下げの名前の行で切る（YAML の読み手を足さないため、jobs の下の字下げだけを頼る）
function jobs(yml) {
  const lines = yml.split('\n');
  const start = lines.findIndex((l) => l === 'jobs:');
  const out = {};
  let cur = null;
  for (const l of lines.slice(start + 1)) {
    const m = l.match(/^ {2}([A-Za-z0-9_-]+):\s*$/);
    if (m) { cur = m[1]; out[cur] = []; continue; }
    if (cur) out[cur].push(l);
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.join('\n')]));
}
// job の steps を `- ` の行で切る
const steps = (job) => job.split(/\n(?= {6}- )/).filter((s) => /^ {6}- /.test(s));
const isToolchainStep = (s) => s.includes(`uses: ${TOOLCHAIN_ACTION}`) && new RegExp(`toolchain:\\s*['"]?${TOOLCHAIN.replace(/\./g, '\\.')}['"]?`).test(s);
const runIndex = (ss, re) => ss.findIndex((s) => re.test(s));

// ---- U1: crate と test-rust（SP-264-001） ----

// 置き場と依存は spec §1 の表の値（SP-264-001 の crate の行。schemars を足さないのは SP-264-003）
test('SP-264-001: crate は Cargo.toml・Cargo.lock・src を持ち、publish = false・edition 2024・依存は serde・serde_json・sha2 だけ', () => {
  for (const f of ['Cargo.toml', 'Cargo.lock', 'src']) assert.ok(existsSync(join(CRATE, f)), `${CRATE_REL}/${f} が無い`);
  const toml = read(join(CRATE, 'Cargo.toml'));
  assert.match(toml, /^name\s*=\s*"formal-method-core"/m);
  assert.match(toml, /^publish\s*=\s*false/m);
  assert.match(toml, /^edition\s*=\s*"2024"/m);
  const deps = toml.split(/^\[dependencies\]\s*$/m)[1]?.split(/^\[/m)[0] ?? '';
  const names = deps.split('\n').map((l) => l.match(/^([A-Za-z0-9_-]+)\s*=/)?.[1]).filter(Boolean).sort();
  assert.deepEqual(names, ['serde', 'serde_json', 'sha2']);
  assert.ok(!/schemars/.test(toml), 'schemars を依存に足さない（SP-264-003）');
});

test('SP-264-001: Makefile は PLUGIN_CRATES と test-rust を持ち、TEST_TARGETS に test-rust を入れる', () => {
  const mk = MAKEFILE();
  assert.ok(mk.includes('PLUGIN_CRATES := $(patsubst %/Cargo.toml,%,$(wildcard $(PLUGINS_DIR)/*/crates/*/Cargo.toml))'), 'PLUGIN_CRATES の定義');
  const r = rule(mk, 'test-rust');
  assert.ok(r, 'test-rust のターゲットが無い');
  assert.match(r.recipe, /PLUGIN_CRATES/);
  assert.match(r.recipe, /fmt[^\n]*--check/);
  assert.match(r.recipe, /clippy[^\n]*--all-targets[^\n]*--locked[^\n]*-D warnings/);
  assert.match(r.recipe, /\btest\b[^\n]*--locked/);
  assert.match(r.recipe, /── Rust \$\$c/, 'crate ごとに「── Rust <crate>」を出す');
  const tt = mk.match(/^TEST_TARGETS\s*:=(.*)$/m);
  assert.ok(tt && tt[1].split(/\s+/).includes('test-rust'), `TEST_TARGETS に test-rust: ${tt?.[1]}`);
});

test('SP-264-001: make -n test に test-rust が出る', () => {
  const r = spawnSync('make', ['-n', 'test'], { cwd: ROOT, encoding: 'utf8', timeout: 120000 });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /test-rust/);
});

test('SP-264-001: CI は toolchain の step の後に make test-rust の step を持つ', () => {
  const found = Object.entries(jobs(CI())).filter(([, j]) => runIndex(steps(j), /run:\s*make[^\n]*\btest-rust\b/) >= 0);
  assert.ok(found.length >= 1, 'make test-rust を流す step が無い');
  for (const [name, j] of found) {
    const ss = steps(j);
    const tc = ss.findIndex(isToolchainStep);
    assert.ok(tc >= 0 && tc < runIndex(ss, /run:\s*make[^\n]*\btest-rust\b/), `${name}: ${TOOLCHAIN_ACTION}（${TOOLCHAIN}）の step が make test-rust より前に無い`);
  }
});

test('SP-264-001: crate の target/ は追跡しない（.gitignore が除く）', () => {
  const r = spawnSync('git', ['check-ignore', '-q', `${CRATE_REL}/target/release/formal-method-core`], { cwd: ROOT });
  assert.equal(r.status, 0, 'target/ が .gitignore で除かれていない');
  const ls = spawnSync('git', ['ls-files', `${CRATE_REL}/target`], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(ls.stdout.trim(), '', 'target/ の下のファイルが追跡されている');
});

// ---- U2: core-bin と CORE_ENV（SP-264-004） ----

const FM_TARGETS = ['test', 'test-static-and-python', 'test-node-traceability', 'test-node-other', 'traceability', 'traceability-complete'];

test('SP-264-004: Makefile は core-bin を持ち、stamp の前提は crate の src・Cargo.toml・Cargo.lock と core.schema.json', { skip: !U2_READY && 'U2（scripts/lib/core.mjs）の前' }, () => {
  const mk = MAKEFILE();
  const stamp = `${CRATE_REL}/target/release/.core-bin.stamp`;
  assert.ok(rule(mk, 'core-bin'), 'core-bin のターゲットが無い');
  // stamp の規則の行（変数で書いてもよいので、Makefile を展開した make -p の規則から探す）
  const p = spawnSync('make', ['-pn', 'core-bin'], { cwd: ROOT, encoding: 'utf8', timeout: 120000, maxBuffer: 64 * 1024 * 1024 });
  const head = p.stdout.split('\n').find((l) => !l.startsWith('#') && l.includes(`${stamp}:`));
  assert.ok(rule(mk, 'core-bin').prereqs.length > 0 || rule(mk, 'core-bin').recipe, 'core-bin は stamp に依る');
  assert.ok(head, `make -p に ${stamp} の規則が無い`);
  for (const dep of [`${CRATE_REL}/Cargo.toml`, `${CRATE_REL}/Cargo.lock`, `${CRATE_REL}/src/`, 'plugins/verification/skills/formal-method/references/core.schema.json']) {
    assert.ok(head.includes(dep), `stamp の前提に ${dep} が無い: ${head}`);
  }
});

test('SP-264-004: CORE_ENV を定め、TEST_ENV は CORE_ENV を含む', { skip: !U2_READY && 'U2 の前' }, () => {
  const mk = MAKEFILE();
  assert.ok(mk.includes(`CORE_ENV := FORMAL_METHOD_CORE_BIN=$(abspath ${CRATE_REL}/target/release/formal-method-core)`), 'CORE_ENV の定義');
  const te = mk.match(/^TEST_ENV\s*:=(.*)$/m);
  assert.ok(te && te[1].includes('$(CORE_ENV)') && te[1].includes('CLAUDE_PLUGINS_SKIP_FSYNC=1'), `TEST_ENV: ${te?.[1]}`);
});

test('SP-264-004: formal-method の CLI を起動しうる 6 つのターゲットは core-bin を前提に持つ', { skip: !U2_READY && 'U2 の前' }, () => {
  const mk = MAKEFILE();
  for (const t of FM_TARGETS) {
    const r = rule(mk, t);
    assert.ok(r, `${t} の規則が無い`);
    assert.ok(r.prereqs.includes('core-bin'), `${t} の前提に core-bin が無い: ${r.head}`);
  }
});

test('SP-264-004: traceability・traceability-complete のレシピは $(CORE_ENV) を $(NODE) の前に置く', { skip: !U2_READY && 'U2 の前' }, () => {
  const mk = MAKEFILE();
  for (const t of ['traceability', 'traceability-complete']) {
    const r = rule(mk, t);
    assert.match(r.recipe, /\$\(CORE_ENV\)\s+\$\(NODE\)/, `${t}: ${r.recipe}`);
    assert.ok(!r.recipe.includes('$(TEST_ENV)'), `${t} は TEST_ENV の他の値を渡さない`);
  }
});

test('SP-264-004: make -n test-node-other で core-bin の build が 1 度だけ、Node のテストより先に出る', { skip: !U2_READY && 'U2 の前' }, () => {
  // -B: stamp が新しくても core-bin のレシピを出させる（-n なので実際には build しない）
  const r = spawnSync('make', ['-n', '-B', 'test-node-other'], { cwd: ROOT, encoding: 'utf8', timeout: 120000, maxBuffer: 64 * 1024 * 1024 });
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.split('\n');
  const builds = lines.map((l, i) => (/cargo\b.*\bbuild\b/.test(l) ? i : -1)).filter((i) => i >= 0);
  assert.equal(builds.length, 1, `cargo build の行: ${builds.map((i) => lines[i]).join(' | ')}`);
  const nodeTests = lines.findIndex((l) => l.includes('run_node_tests.mjs'));
  assert.ok(nodeTests > builds[0], 'core-bin の build が Node のテストより先');
  assert.ok(lines[nodeTests].includes('FORMAL_METHOD_CORE_BIN='), 'Node のテストに FORMAL_METHOD_CORE_BIN を渡す');
});

test('SP-264-004: make -n traceability・traceability-complete に core-bin の build と FORMAL_METHOD_CORE_BIN= が出る', { skip: !U2_READY && 'U2 の前' }, () => {
  for (const t of ['traceability', 'traceability-complete']) {
    const r = spawnSync('make', ['-n', '-B', t], { cwd: ROOT, encoding: 'utf8', timeout: 120000, maxBuffer: 64 * 1024 * 1024 });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /cargo\b.*\bbuild\b/, `${t} に core-bin の build が無い`);
    assert.match(r.stdout, /FORMAL_METHOD_CORE_BIN=\S+formal-method-core\b/, `${t} に FORMAL_METHOD_CORE_BIN= が無い`);
  }
});

test('SP-264-004: Node のテストを流す 3 つの job は、make の前に toolchain の step を持つ', { skip: !U2_READY && 'U2 の前' }, () => {
  const js = jobs(CI());
  for (const target of ['test-static-and-python', 'test-node-traceability', 'test-node-other']) {
    const re = new RegExp(`run:\\s*make[^\\n]*\\b${target}\\b`);
    const found = Object.entries(js).filter(([, j]) => runIndex(steps(j), re) >= 0);
    assert.ok(found.length >= 1, `make ${target} を流す job が無い`);
    for (const [name, j] of found) {
      const ss = steps(j);
      const tc = ss.findIndex(isToolchainStep);
      assert.ok(tc >= 0 && tc < runIndex(ss, re), `${name}: toolchain の step が make ${target} より前に無い`);
    }
  }
});

// ---- U6: plugin の版（SP-264-090） ----

const pluginVersion = (p) => JSON.parse(read(join(ROOT, 'plugins', 'verification', p, 'plugin.json'))).version;

test('SP-264-090: 2 つの plugin.json の version が等しい', () => {
  assert.equal(pluginVersion('.claude-plugin'), pluginVersion('.codex-plugin'));
});

// U6 の印は 3 つ（plugin の版を 0.1.1 から上げる・cli-contract.md の「実行体」の節・SKILL.md の install の行）。
// U6 の前（U1〜U5 の受理の時点）はどれも無いので外す。1 つでも在れば U6 の後とみなし、3 つ全てを要る。
// こうして、版の上げ忘れで版を条件にした他の検査（agent-duties・schemas-constants）が黙って外れたままになることを防ぐ
const SKILL_DOC = () => read(join(SKILL, 'SKILL.md'));
const CLI_CONTRACT = () => read(join(SKILL, 'references', 'cli-contract.md'));
const coreSection = (doc) => (doc.match(/^## 実行体\s*$([\s\S]*?)(?=^## )/m) ?? doc.match(/^## 実行体\s*$([\s\S]*)$/m))?.[1] ?? null;
const INSTALL_RE = /cargo install --locked --git https:\/\/github\.com\/yoshiysh\/claude-plugins\.git --tag formal-method-core-v[^\s`]+ formal-method-core/;
const U6_SIGNALS = () => ({
  version: pluginVersion('.claude-plugin') !== '0.1.1' || pluginVersion('.codex-plugin') !== '0.1.1',
  section: coreSection(CLI_CONTRACT()) !== null,
  install: INSTALL_RE.test(SKILL_DOC()),
});
const U6_STARTED = Object.values(U6_SIGNALS()).some(Boolean);

test('SP-264-090: U6 の印は揃って現れる（版を上げたなら節と install の行も在り、節か install の行が在るなら版も上げてある）', { skip: !U6_STARTED && 'U6 の前（3 つの印のどれも無い）' }, () => {
  assert.deepEqual(U6_SIGNALS(), { version: true, section: true, install: true });
});

test('SP-264-090: U6 の後、2 つの plugin.json の version は 0.2.0', { skip: !U6_STARTED && 'U6 の前' }, () => {
  assert.equal(pluginVersion('.claude-plugin'), '0.2.0');
  assert.equal(pluginVersion('.codex-plugin'), '0.2.0');
});

test('SP-264-090: U6 の後、cli-contract.md の「実行体」の節は install のコマンドと core.schema.json へのリンクを持つ', { skip: !U6_STARTED && 'U6 の前' }, () => {
  const sec = coreSection(CLI_CONTRACT());
  assert.ok(sec !== null, 'cli-contract.md に「## 実行体」の節が無い');
  assert.match(sec, INSTALL_RE, '節に install のコマンドが無い');
  assert.match(sec, /\]\(\.?\/?core\.schema\.json(#[^)]*)?\)/, '節に core.schema.json へのリンクが無い');
});

