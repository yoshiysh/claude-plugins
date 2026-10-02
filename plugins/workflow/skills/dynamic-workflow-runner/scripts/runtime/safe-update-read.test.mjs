import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { lstat, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { readRegularFileBounded } from './safe-update-read.mjs';

const execute = promisify(execFile);

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'safe-update-read-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'file');
  await writeFile(path, 'old');
  return { root, path, expected: await lstat(path) };
}

test('a file swapped to a FIFO after lstat cannot hang the update reader', async t => {
  const { root, path, expected } = await fixture(t);
  await rename(path, join(root, 'original'));
  await execute('mkfifo', [path]);
  await assert.rejects(readRegularFileBounded(path, expected, 100), /changed identity/);
});

test('a file swapped to a symlink after lstat cannot be followed', async t => {
  const { root, path, expected } = await fixture(t);
  await rename(path, join(root, 'original'));
  await symlink(join(root, 'original'), path);
  await assert.rejects(readRegularFileBounded(path, expected, 100));
});

test('the update reader rejects oversized regular files before reading', async t => {
  const { path } = await fixture(t);
  await assert.rejects(readRegularFileBounded(path, await lstat(path), 2), /size limit/);
});
