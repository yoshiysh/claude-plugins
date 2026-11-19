import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../scripts/traceability/specs.mjs';
import { KNOWN_WEIGHTS, assignShards, normalizeRepoPath, orderByWeight, parseShard, partitionFiles } from '../scripts/run_node_tests.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('parseShard: 有効な k/N 形式を解釈し、範囲外や不正形式を拒否する', () => {
  assert.deepEqual(parseShard('1/4'), { index: 1, total: 4 });
  assert.deepEqual(parseShard('4/4'), { index: 4, total: 4 });
  assert.equal(parseShard(''), null);
  assert.throws(() => parseShard('0/4'));
  assert.throws(() => parseShard('5/4'));
  assert.throws(() => parseShard('1/0'));
  assert.throws(() => parseShard('abc'));
});

test('partitionFiles と assignShards: traceability 対象を除外し、重複も漏れもなくシャードに配分する', async () => {
  const config = await loadConfig(path.join(ROOT, 'traceability.config.json'));
  const sampleAll = [
    ...config.testFiles,
    '.agents/skills/skill-creator-best-practices/scripts/bp/cli.test.mjs',
    '.agents/skills/formal-method/scripts/cli-wait-limit.test.mjs',
    '.agents/skills/formal-method/scripts/cli-pipeline.test.mjs',
    '.agents/skills/dynamic-workflow-runner/scripts/workflow-control.test.mjs',
    'tests/traceability.test.mjs',
    'tests/run-node-tests.test.mjs',
  ];
  const untraced = partitionFiles(config.root, sampleAll, config.testFiles);
  assert.deepEqual(untraced, [
    '.agents/skills/dynamic-workflow-runner/scripts/workflow-control.test.mjs',
    '.agents/skills/formal-method/scripts/cli-pipeline.test.mjs',
    '.agents/skills/formal-method/scripts/cli-wait-limit.test.mjs',
    'tests/run-node-tests.test.mjs',
    'tests/traceability.test.mjs',
  ]);

  const shards = assignShards(untraced, 4, config.root);
  assert.equal(shards.length, 4);
  const flat = shards.flat().sort();
  assert.deepEqual(flat, [...untraced].sort());

  const tracedNorm = new Set(config.testFiles.map((f) => normalizeRepoPath(config.root, f)));
  for (const f of flat) {
    assert.equal(tracedNorm.has(normalizeRepoPath(config.root, f)), false);
  }
});

test('KNOWN_WEIGHTS: 全てのキーが実在し、normalizeRepoPath の結果（realpath の repo 相対）と一致する', () => {
  // キーが symlink 側の path や消えたファイルだと、重みが黙って 1 に落ちる。
  for (const key of KNOWN_WEIGHTS.keys()) {
    assert.equal(normalizeRepoPath(ROOT, key), key);
  }
});

test('orderByWeight: 重い順に並べ、同じ重みは path の順。symlink 経由の path も実体の重みで引く', () => {
  const files = [
    'tests/run-node-tests.test.mjs',
    '.agents/skills/dynamic-workflow-runner/scripts/workflow-control.test.mjs',
    'tests/traceability.test.mjs',
    '.agents/skills/formal-method/scripts/cli-pipeline.test.mjs',
    'tests/make-test-parallel.test.mjs',
  ];
  assert.deepEqual(orderByWeight(files, ROOT), [
    { file: '.agents/skills/formal-method/scripts/cli-pipeline.test.mjs', weight: 165 },
    { file: '.agents/skills/dynamic-workflow-runner/scripts/workflow-control.test.mjs', weight: 77 },
    { file: 'tests/traceability.test.mjs', weight: 6 },
    { file: 'tests/make-test-parallel.test.mjs', weight: 1 },
    { file: 'tests/run-node-tests.test.mjs', weight: 1 },
  ]);
});

const SCRIPT = path.join(ROOT, 'scripts/run_node_tests.mjs');
const CONFIG = path.join(ROOT, 'traceability.config.json');

function runScript(args, env = {}) {
  const e = { ...process.env, ...env };
  delete e.NODE_TEST_CONTEXT;
  delete e.NODE_TEST_SHARD;
  return spawnSync(process.execPath, [SCRIPT, '--config', CONFIG, ...args], { cwd: ROOT, env: e, encoding: 'utf8' });
}

test('--dry-run: シャードの指定が無くても重い順に出す', () => {
  const r = runScript(['--dry-run', '--', 'tests/traceability.test.mjs', 'tests/run-node-tests.test.mjs', '.agents/skills/formal-method/scripts/cli-pipeline.test.mjs']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.trim().split('\n'), [
    '.agents/skills/formal-method/scripts/cli-pipeline.test.mjs',
    'tests/traceability.test.mjs',
    'tests/run-node-tests.test.mjs',
  ]);
});

// 実行の合否: run() の結果から終了コードを決める。テストの失敗・読み込みの失敗を成功にしない。
const FIXTURES = {
  pass: "import test from 'node:test';\ntest('PASS-CASE', () => { console.log('CHILD-STDOUT'); });\n",
  fail: "import test from 'node:test';\ntest('FAIL-CASE', () => { throw new Error('BOOM'); });\n",
  load: "throw new Error('LOAD-FAIL');\n",
  todo: "import test from 'node:test';\ntest.todo('TODO-CASE', () => { throw new Error('later'); });\ntest.skip('SKIP-CASE');\n",
};

function fixtures(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rnt-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const files = {};
  for (const [name, body] of Object.entries(FIXTURES)) {
    files[name] = path.join(dir, `${name}.test.mjs`);
    fs.writeFileSync(files[name], body);
  }
  return files;
}

test('実行: 全て成功なら 0 で終わり、spec reporter の出力を stdout に出す', (t) => {
  const f = fixtures(t);
  const r = runScript(['--', f.pass, f.todo]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /PASS-CASE/);
  assert.match(r.stdout, /CHILD-STDOUT/);
  assert.match(r.stdout, /TODO-CASE/);
});

for (const kind of ['fail', 'load']) {
  test(`実行: ${kind === 'fail' ? 'テストの失敗' : 'ファイルの読み込みの失敗'}があれば 1 で終わり、他のファイルも走らせる`, (t) => {
    const f = fixtures(t);
    const r = runScript(['--', f[kind], f.pass]);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /PASS-CASE/);
    assert.match(r.stdout, kind === 'fail' ? /BOOM/ : /LOAD-FAIL/);
  });
}

test('実行: NODE_TEST_CONCURRENCY が正の整数でなければ 2 で終わる', (t) => {
  const f = fixtures(t);
  for (const extra of [[], ['--dry-run']]) {
    const r = runScript([...extra, '--', f.pass], { NODE_TEST_CONCURRENCY: 'many' });
    assert.equal(r.status, 2, extra.join(' '));
    assert.match(r.stderr, /NODE_TEST_CONCURRENCY/);
  }
});
