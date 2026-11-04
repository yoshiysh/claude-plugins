#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { writeResultFile, advanceGeneration, verifyGeneration } from './develop-core.mjs';

function parseArgs(args) {
  const opts = {
    dir: null,
    name: 'run-result.json',
    input: null,
    expectedGen: null,
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dir' && args[i + 1]) opts.dir = args[++i];
    else if (args[i] === '--name' && args[i + 1]) opts.name = args[++i];
    else if (args[i] === '--input' && args[i + 1]) opts.input = args[++i];
    else if (args[i] === '--expected-gen' && args[i + 1]) opts.expectedGen = parseInt(args[++i], 10);
  }
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.dir) {
    console.error('Usage: record-run.mjs --dir <stateDir> [--name <filename>] [--input <jsonFile>] [--expected-gen <n>]');
    process.exit(1);
  }

  const statePath = path.join(opts.dir, 'state.json');

  if (opts.expectedGen !== null) {
    let state = {};
    if (fs.existsSync(statePath)) {
      try { state = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch {}
    }
    const currentGen = state.generation || 0;
    try {
      verifyGeneration(opts.expectedGen, currentGen);
    } catch (e) {
      console.error(e.message);
      process.exit(2);
    }
  }

  let data = {};
  if (opts.input) {
    data = JSON.parse(fs.readFileSync(opts.input, 'utf8'));
  } else {
    // 標準入力から読み込み
    try {
      const stdinData = fs.readFileSync(0, 'utf8');
      if (stdinData.trim()) data = JSON.parse(stdinData);
    } catch {}
  }

  // 結果ファイル書き込み
  const result = writeResultFile(opts.dir, opts.name, data);
  const nextGen = advanceGeneration(statePath);

  // 標準出力に path と sha を JSON で出力
  process.stdout.write(JSON.stringify({
    ok: true,
    path: result.path,
    sha: result.sha,
    generation: nextGen,
  }) + '\n');
}

main();
