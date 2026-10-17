import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { applyStaging, FINGERPRINT_DIGITS, fingerprintStaging } from './apply-staging.mjs';

const execute = promisify(execFile);
const script = join(dirname(fileURLToPath(import.meta.url)), 'apply-staging.mjs');

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'apply-staging-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = join(root, 'skill');
  const staging = join(root, 'staging');
  const work = join(root, 'work');
  for (const dir of [target, staging, work]) await mkdir(dir);
  await writeFile(join(target, 'SKILL.md'), 'before\n');
  await writeFile(join(target, 'notes.md'), 'target notes\n');
  await writeFile(join(staging, 'SKILL.md'), 'after\n');
  await writeFile(join(staging, 'notes.md'), 'staging notes with different bytes\n');
  await mkdir(join(staging, 'scripts'));
  await writeFile(join(staging, 'scripts', 'new.mjs'), 'export {};\n');
  const changedFiles = join(work, 'changed-files.json');
  await writeFile(changedFiles, JSON.stringify([
    { path: 'SKILL.md', reason: 'intent', findings_addressed: ['intent'] },
    { path: 'scripts/new.mjs', reason: 'intent', findings_addressed: ['intent'] },
  ]));
  return { root, target, staging, work, changedFiles, baseline: join(work, 'baseline.json') };
}

test('copies only the listed files after the fingerprint matches', async t => {
  const f = await fixture(t);
  const print = await fingerprintStaging({ staging: f.staging, out: f.baseline });
  assert.equal(print.fingerprint.length, FINGERPRINT_DIGITS);
  const result = await applyStaging({ staging: f.staging, target: f.target, baseline: f.baseline, changedFiles: f.changedFiles });
  assert.deepEqual(result.copied, ['SKILL.md', 'scripts/new.mjs']);
  assert.equal(result.fingerprint, print.fingerprint);
  assert.equal(await readFile(join(f.target, 'SKILL.md'), 'utf8'), 'after\n');
  assert.equal(await readFile(join(f.target, 'scripts', 'new.mjs'), 'utf8'), 'export {};\n');
  assert.equal(await readFile(join(f.target, 'notes.md'), 'utf8'), 'target notes\n');
});

test('refuses to copy when staging changed after the fingerprint and names the changed paths', async t => {
  const f = await fixture(t);
  await fingerprintStaging({ staging: f.staging, out: f.baseline });
  await writeFile(join(f.staging, 'notes.md'), 'written outside the update\n');
  await assert.rejects(
    applyStaging({ staging: f.staging, target: f.target, baseline: f.baseline, changedFiles: f.changedFiles }),
    error => error.message.includes('staging changed') && error.detail.changed_paths.includes('notes.md'));
  assert.equal(await readFile(join(f.target, 'SKILL.md'), 'utf8'), 'before\n');
});

test('rejects a listed path that is missing from staging or escapes the target', async t => {
  const f = await fixture(t);
  await fingerprintStaging({ staging: f.staging, out: f.baseline });
  for (const path of ['removed.md', '../outside.md']) {
    await writeFile(f.changedFiles, JSON.stringify([{ path, reason: 'x', findings_addressed: [] }]));
    await assert.rejects(applyStaging({ staging: f.staging, target: f.target, baseline: f.baseline, changedFiles: f.changedFiles }));
  }
  assert.equal(await readFile(join(f.target, 'SKILL.md'), 'utf8'), 'before\n');
});

test('rejects a baseline stored inside staging', async t => {
  const f = await fixture(t);
  await assert.rejects(fingerprintStaging({ staging: f.staging, out: join(f.staging, 'baseline.json') }), /outside the staging/);
});

test('rejects a destination that crosses a symlink in the target', async t => {
  const f = await fixture(t);
  await mkdir(join(f.root, 'elsewhere'));
  await symlink(join(f.root, 'elsewhere'), join(f.target, 'scripts'));
  await fingerprintStaging({ staging: f.staging, out: f.baseline });
  await assert.rejects(
    applyStaging({ staging: f.staging, target: f.target, baseline: f.baseline, changedFiles: f.changedFiles }),
    /symlink/);
  assert.equal(await readFile(join(f.target, 'SKILL.md'), 'utf8'), 'before\n');
});

test('the CLI reports a rejection as JSON on stderr with a non-zero exit', async t => {
  const f = await fixture(t);
  await execute(process.execPath, [script, 'fingerprint', '--staging', f.staging, '--out', f.baseline]);
  await writeFile(join(f.staging, 'SKILL.md'), 'changed\n');
  const run = execute(process.execPath, [script, 'apply', '--staging', f.staging, '--target', f.target,
    '--baseline', f.baseline, '--changed-files', f.changedFiles]);
  await assert.rejects(run, error => error.code === 1 && JSON.parse(error.stderr).status === 'rejected' &&
    JSON.parse(error.stderr).changed_paths.includes('SKILL.md'));
});
