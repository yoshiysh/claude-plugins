import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const RECORD_RUN_CLI = path.resolve('plugins/develop/scripts/record-run.mjs');

test('record-run CLI は結果 JSON を書き出して path と sha を標準出力に返す', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'record-run-test-'));
  const inputFile = path.join(tmpDir, 'input.json');
  fs.writeFileSync(inputFile, JSON.stringify({ verdict: 'success', votes: [1, 2] }), 'utf8');

  const stdout = execFileSync('node', [
    RECORD_RUN_CLI,
    '--dir', tmpDir,
    '--name', 'output.json',
    '--input', inputFile
  ], { encoding: 'utf8' });

  const res = JSON.parse(stdout);
  assert.equal(res.ok, true);
  assert.ok(fs.existsSync(res.path));
  assert.equal(typeof res.sha, 'string');
  assert.equal(res.sha.length, 64);
  assert.equal(res.generation, 1);

  // 世代指定での実行
  const stdout2 = execFileSync('node', [
    RECORD_RUN_CLI,
    '--dir', tmpDir,
    '--name', 'output2.json',
    '--input', inputFile,
    '--expected-gen', '1'
  ], { encoding: 'utf8' });

  const res2 = JSON.parse(stdout2);
  assert.equal(res2.generation, 2);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});
