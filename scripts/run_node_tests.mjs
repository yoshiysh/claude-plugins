#!/usr/bin/env node
/**
 * Run Node.js tests outside traceability.config.json with optional deterministic sharding.
 * Keeps `traceability/cli.mjs` focused on its configured scope while ensuring zero omissions.
 */
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './traceability/specs.mjs';

// Estimated durations (seconds) used for LPT shard balancing.
// Exact values are not required; ordering heavy files first prevents long-tail shards.
const KNOWN_WEIGHTS = new Map([
  ['.agents/skills/dynamic-workflow-runner/scripts/workflow-control.test.mjs', 30],
  ['.agents/skills/formal-method/scripts/cli-pipeline.test.mjs', 30],
  ['.agents/skills/formal-method/scripts/cli-recovery.test.mjs', 20],
  ['.agents/skills/formal-method/scripts/cli-scope.test.mjs', 40],
  ['.agents/skills/repo-implement/scripts/implement-cli.test.mjs', 30],
  ['tests/repo-implement-workflow.test.mjs', 25],
  ['.agents/skills/formal-method/scripts/cli-intake.test.mjs', 22],
  ['tests/repo-review-workflow.test.mjs', 16],
  ['.agents/skills/address-review/scripts/address-cli.test.mjs', 12],
  ['.agents/skills/formal-method/scripts/cli-client.test.mjs', 12],
  ['.agents/skills/repo-review/scripts/review-cli.test.mjs', 9],
  ['.agents/skills/dynamic-workflow-runner/scripts/runtime/resume.test.mjs', 7],
  ['tests/traceability.test.mjs', 6],
  ['.agents/skills/formal-method/scripts/fake-z3.test.mjs', 5],
  ['tests/formal/bp-prd/check.test.mjs', 5],
]);

export function parseShard(spec) {
  if (!spec) return null;
  const m = /^([1-9]\d*)\/([1-9]\d*)$/.exec(spec);
  if (!m) throw new Error(`Invalid shard format (expected k/N): ${spec}`);
  const index = Number(m[1]);
  const total = Number(m[2]);
  if (index > total) throw new Error(`Shard index ${index} exceeds total ${total}`);
  return { index, total };
}

export function normalizeRepoPath(root, filePath) {
  const abs = path.isAbsolute(filePath) ? filePath : path.resolve(root, filePath);
  const real = realpathSync(abs);
  return path.relative(root, real).replaceAll('\\', '/');
}

export function partitionFiles(root, allFiles, tracedFiles) {
  const tracedReal = new Set(tracedFiles.map((f) => normalizeRepoPath(root, f)));
  const seenReal = new Set();
  const untraced = [];
  for (const file of allFiles) {
    const norm = normalizeRepoPath(root, file);
    if (seenReal.has(norm)) continue;
    seenReal.add(norm);
    if (!tracedReal.has(norm)) {
      untraced.push(file.replaceAll('\\', '/'));
    }
  }
  return untraced.sort();
}

export function assignShards(files, totalShards, root = process.cwd()) {
  const buckets = Array.from({ length: totalShards }, () => ({ weight: 0, files: [] }));
  const weighted = files.map((file) => {
    const norm = normalizeRepoPath(root, file);
    const weight = KNOWN_WEIGHTS.get(norm) ?? KNOWN_WEIGHTS.get(file.replaceAll('\\', '/')) ?? 1;
    return { file, weight };
  });
  weighted.sort((a, b) => b.weight - a.weight || a.file.localeCompare(b.file));
  for (const item of weighted) {
    let best = 0;
    for (let i = 1; i < buckets.length; i += 1) {
      if (buckets[i].weight < buckets[best].weight) best = i;
    }
    buckets[best].files.push(item.file);
    buckets[best].weight += item.weight;
  }
  return buckets.map((b) => b.files);
}

function parseArgs(argv) {
  const sep = argv.indexOf('--');
  const opts = sep < 0 ? argv : argv.slice(0, sep);
  const files = sep < 0 ? [] : argv.slice(sep + 1);
  let configPath = 'traceability.config.json';
  let shard = process.env.NODE_TEST_SHARD || '';
  let dryRun = false;
  for (let i = 0; i < opts.length; i += 1) {
    if (opts[i] === '--config' && opts[i + 1]) {
      configPath = opts[++i];
    } else if (opts[i] === '--shard' && opts[i + 1]) {
      shard = opts[++i];
    } else if (opts[i] === '--dry-run') {
      dryRun = true;
    } else {
      throw new Error(`Unknown or incomplete option: ${opts[i]}`);
    }
  }
  return { configPath, shard: parseShard(shard), dryRun, files };
}

async function main() {
  const { configPath, shard, dryRun, files } = parseArgs(process.argv.slice(2));
  const config = await loadConfig(path.resolve(configPath));
  const targetFiles = partitionFiles(config.root, files, config.testFiles);
  const selected = shard ? assignShards(targetFiles, shard.total, config.root)[shard.index - 1] : targetFiles;

  if (dryRun) {
    for (const f of selected) console.log(f);
    return;
  }
  if (selected.length === 0) {
    console.log('No Node test files assigned to this shard.');
    return;
  }

  const concurrency = process.env.NODE_TEST_CONCURRENCY || '4';
  const args = ['--test', `--test-concurrency=${concurrency}`, ...selected];
  const res = spawnSync(process.execPath, args, { cwd: config.root, stdio: 'inherit' });
  process.exitCode = res.status ?? 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().catch((err) => {
    console.error(err.message);
    process.exitCode = 2;
  });
}
