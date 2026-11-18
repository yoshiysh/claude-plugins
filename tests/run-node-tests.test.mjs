import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../scripts/traceability/specs.mjs';
import { assignShards, normalizeRepoPath, parseShard, partitionFiles } from '../scripts/run_node_tests.mjs';

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
