#!/usr/bin/env node
/**
 * Run Node.js tests outside traceability.config.json with optional deterministic sharding.
 * Keeps `traceability/cli.mjs` focused on its configured scope while ensuring zero omissions.
 */
import { realpathSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import path from 'node:path';
import { run } from 'node:test';
import { spec } from 'node:test/reporters';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './traceability/specs.mjs';

// ファイルごとの所要時間の見積もり（秒）。シャードの配分（LPT）と、実行の順（重い順）に使う。
// 値は make test の並列実行での実測（2026-11）。キーは normalizeRepoPath の結果（realpath の repo 相対）で、
// .agents/skills の symlink 経由で渡されたファイルも実体の path で引く。正確さは要らず、重いものが先に起動すれば足りる。
export const KNOWN_WEIGHTS = new Map([
  ['.agents/skills/formal-method/scripts/cli-pipeline.test.mjs', 70],
  ['.agents/skills/formal-method/scripts/cli-pipeline-returns.test.mjs', 55],
  ['.agents/skills/formal-method/scripts/cli-pipeline-models.test.mjs', 45],
  ['.agents/skills/formal-method/scripts/cli-pipeline-plan-defects.test.mjs', 30],
  ['plugins/workflow/skills/dynamic-workflow-runner/scripts/workflow-control.test.mjs', 8],
  ['plugins/workflow/skills/dynamic-workflow-runner/scripts/runtime/run-workspace.test.mjs', 64],
  ['tests/repo-review-workflow.test.mjs', 52],
  ['.agents/skills/repo-review/scripts/review-cli.test.mjs', 35],
  ['.agents/skills/formal-method/scripts/cli-recovery.test.mjs', 14],
  ['.agents/skills/formal-method/scripts/cli-client.test.mjs', 12],
  ['.agents/skills/formal-method/scripts/cli-scope.test.mjs', 11],
  ['.agents/skills/formal-method/scripts/cli-intake.test.mjs', 8],
  ['plugins/workflow/skills/dynamic-workflow-runner/scripts/runtime/resume.test.mjs', 7],
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

// 重い順（同じ重みは path の順）に並べる。node:test の run() は渡した順に起動するので、
// 長いファイルが最後に起動して全体の終わりを引き延ばすことを防ぐ。
export function orderByWeight(files, root = process.cwd()) {
  return files
    .map((file) => ({ file, weight: KNOWN_WEIGHTS.get(normalizeRepoPath(root, file)) ?? 1 }))
    .sort((a, b) => b.weight - a.weight || a.file.localeCompare(b.file));
}

export function assignShards(files, totalShards, root = process.cwd()) {
  const buckets = Array.from({ length: totalShards }, () => ({ weight: 0, files: [] }));
  for (const item of orderByWeight(files, root)) {
    let best = 0;
    for (let i = 1; i < buckets.length; i += 1) {
      if (buckets[i].weight < buckets[best].weight) best = i;
    }
    buckets[best].files.push(item.file);
    buckets[best].weight += item.weight;
  }
  return buckets.map((b) => b.files);
}

// files を run() で実行し、spec reporter で stdout に出す。全体の test:summary の success を返す
// （summary が来ないまま終わったら失敗）。`node --test` は argv の順を無視して path の順に起動するので、run() を使う。
export async function runFiles(files, { cwd, concurrency, output = process.stdout }) {
  let success = false;
  // Node 22 の run() は cwd を受け付けない（v23 で追加）ので、子が継ぐ cwd を process の側でもそろえる。
  process.chdir(cwd);
  const stream = run({ files: files.map((f) => path.resolve(cwd, f)), cwd, concurrency });
  stream.on('test:summary', (data) => {
    if (data.file === undefined) success = data.success;
  });
  const reporter = stream.compose(spec);
  reporter.pipe(output, { end: false });
  await new Promise((resolve, reject) => {
    reporter.on('end', resolve);
    reporter.on('error', reject);
  });
  return success;
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

// 同時に走らせるファイルの数。NODE_TEST_CONCURRENCY が無ければ CPU の半分。make test では traceability の段
// （node --test の既定の CPU − 1 だが、対象のファイルの数で頭打ちになる）と同時に走るので、全ての CPU は取らない。
// CI は値を明示する（verification.yml）。
export function testConcurrency(value, cpus) {
  if (value === undefined || value === '') return Math.max(1, Math.floor(cpus / 2));
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`Invalid NODE_TEST_CONCURRENCY: ${value}`);
  return n;
}

async function main() {
  const { configPath, shard, dryRun, files } = parseArgs(process.argv.slice(2));
  const config = await loadConfig(path.resolve(configPath));
  const targetFiles = partitionFiles(config.root, files, config.testFiles);
  const selected = shard ? assignShards(targetFiles, shard.total, config.root)[shard.index - 1] : orderByWeight(targetFiles, config.root).map((x) => x.file);

  const concurrency = testConcurrency(process.env.NODE_TEST_CONCURRENCY, availableParallelism());
  if (dryRun) {
    for (const f of selected) console.log(f);
    return;
  }
  if (selected.length === 0) {
    console.log('No Node test files assigned to this shard.');
    return;
  }

  // reporter が終わりを告げずに event loop が空になっても、成功で終わらせない。
  process.exitCode = 1;
  const ok = await runFiles(selected, { cwd: config.root, concurrency });
  process.exitCode = ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().catch((err) => {
    console.error(err.message);
    process.exitCode = 2;
  });
}
