import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  classifyPaths,
  sha256,
  advanceGeneration,
  verifyGeneration,
  writeResultFile,
  readAndVerifyResultFile,
  enforceBundleBudget,
} from './develop-core.mjs';

test('classifyPaths は変更対象のパスから正しく種類を判定する', () => {
  // code の優先
  assert.equal(classifyPaths(['src/index.js']), 'code');
  assert.equal(classifyPaths(['docs/design/arch.md', 'scripts/run.sh']), 'code');
  assert.equal(classifyPaths(['Makefile', 'README.md']), 'code');

  // design の判定
  assert.equal(classifyPaths(['docs/design/develop-skills-redesign.md']), 'design');
  assert.equal(classifyPaths(['docs/requirements/develop-plugin.md']), 'design');
  assert.equal(classifyPaths(['docs/specifications/develop-plugin.md']), 'design');

  // document の判定
  assert.equal(classifyPaths(['README.md']), 'document');
  assert.equal(classifyPaths(['docs/notes.md']), 'document');

  // 空配列
  assert.equal(classifyPaths([]), 'document');
});

test('advanceGeneration と verifyGeneration は世代を正しく管理し不一致を拒否する', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'develop-gen-test-'));
  const statePath = path.join(tmpDir, 'state.json');

  const gen1 = advanceGeneration(statePath);
  assert.equal(gen1, 1);
  assert.doesNotThrow(() => verifyGeneration(1, gen1));

  const gen2 = advanceGeneration(statePath);
  assert.equal(gen2, 2);
  assert.doesNotThrow(() => verifyGeneration(2, gen2));

  // 不一致時の拒否
  assert.throws(() => verifyGeneration(1, gen2), /Generation mismatch/);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('writeResultFile と readAndVerifyResultFile は結果を保存しハッシュを検証する', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'develop-result-test-'));
  const payload = { ok: true, verdict: 'pass', votes: [{ id: 1, pass: true }] };

  const { path: resultPath, sha } = writeResultFile(tmpDir, 'test-result.json', payload);
  assert.ok(fs.existsSync(resultPath));
  assert.equal(typeof sha, 'string');
  assert.equal(sha.length, 64);

  // 正常読み出し
  const loaded = readAndVerifyResultFile(resultPath, sha);
  assert.deepEqual(loaded, payload);

  // ハッシュ不一致エラー
  assert.throws(() => readAndVerifyResultFile(resultPath, 'wrong-sha'), /SHA-256 mismatch/);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('enforceBundleBudget は洗い出しの束の上限行数を守らせる', () => {
  const smallText = 'line 1\nline 2\nline 3';
  const smallRes = enforceBundleBudget(smallText, 5);
  assert.equal(smallRes.truncated, false);
  assert.equal(smallRes.text, smallText);

  const bigLines = Array.from({ length: 1500 }, (_, i) => `line ${i + 1}`);
  const bigText = bigLines.join('\n');
  const bigRes = enforceBundleBudget(bigText, 1000);
  assert.equal(bigRes.truncated, true);
  assert.equal(bigRes.text.split('\n').length, 1000);
  assert.equal(bigRes.totalLines, 1500);
});
