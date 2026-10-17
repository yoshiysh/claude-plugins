import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { mkdtemp, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { canonicalNamedPath, readNamedFile } from './named-file.mjs';
import { resolveNamedWorkflow } from './named.mjs';

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'named-file-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'input.js');
  const source = "export const meta={name:'tiny',description:'回答'}; return null;";
  await writeFile(path, source);
  return { root, path, source };
}

function observeHandles(t) {
  const original = fs.open;
  const observed = { opened: 0, closed: 0 };
  fs.open = async function (...args) {
    const handle = await original.apply(this, args);
    observed.opened++;
    const close = handle.close.bind(handle);
    handle.close = async () => { observed.closed++; return close(); };
    return handle;
  };
  t.after(() => { fs.open = original; });
  return observed;
}

test('canonical named file retains its exact UTF-8 bytes and closes the read handle', async t => {
  const f = await fixture(t), handles = observeHandles(t);
  const expected = await canonicalNamedPath(f.path, false);
  const result = await readNamedFile(f.path, expected, [f.root]);
  assert.equal(result.source, f.source);
  assert.deepEqual(result.bytes, Buffer.from(f.source, 'utf8'));
  assert.equal(result.info.ino, expected.ino);
  assert.deepEqual(handles, { opened: 1, closed: 1 });
});

test('replacing a regular file rejects even when the replacement contains the same bytes', async t => {
  for (const contents of ['same', 'different']) {
    const f = await fixture(t);
    const expected = await canonicalNamedPath(f.path, false);
    const replacement = join(f.root, 'replacement.js');
    await writeFile(replacement, contents === 'same' ? f.source : 'different text');
    await rename(replacement, f.path);
    await assert.rejects(readNamedFile(f.path, expected, [f.root]), /changed before read/);
  }
});

test('named read failures and invalid UTF-8 close the opened handle', async t => {
  const f = await fixture(t), handles = observeHandles(t);
  await writeFile(f.path, Buffer.from([0xff]));
  await assert.rejects(readNamedFile(f.path, undefined, [f.root]), /valid UTF-8/);
  assert.deepEqual(handles, { opened: 1, closed: 1 });
  await writeFile(f.path, f.source);
  const instrumentedOpen = fs.open;
  fs.open = async function (...args) {
    const handle = await instrumentedOpen.apply(this, args);
    handle.read = async () => { throw Error('ordinary read fault'); };
    return handle;
  };
  await assert.rejects(readNamedFile(f.path, undefined, [f.root]), /ordinary read fault/);
  assert.deepEqual(handles, { opened: 2, closed: 2 });
});

test('invalid catalog JSON and source metadata leave no open handles', async t => {
  const f = await fixture(t), handles = observeHandles(t);
  await fs.mkdir(join(f.root, '.claude-plugin'));
  await fs.mkdir(join(f.root, 'workflows'));
  const manifest = join(f.root, '.claude-plugin/plugin.json');
  await writeFile(manifest, '{invalid JSON');
  const request = { name: 'example:tiny' }, host = { trustedPluginRoots: [f.root] };
  await assert.rejects(resolveNamedWorkflow(request, host), /JSON/);
  assert.deepEqual(handles, { opened: 1, closed: 1 });
  await writeFile(manifest, JSON.stringify({ name: 'example' }));
  await writeFile(join(f.root, 'workflows/tiny.js'), "export const meta={name:args.name,description:'bad'}; return null;");
  await assert.rejects(resolveNamedWorkflow(request, host), /literal/);
  assert.deepEqual(handles, { opened: 3, closed: 3 });
});


test('descriptor identity validation closes its handle before rejecting an ordinary stat mismatch', async t => {
  const f = await fixture(t), handles = observeHandles(t);
  const instrumentedOpen = fs.open;
  fs.open = async function (...args) {
    const handle = await instrumentedOpen.apply(this, args);
    const originalStat = handle.stat.bind(handle);
    handle.stat = async () => {
      const info = await originalStat();
      return { ...info, ino: info.ino + 1, isFile: () => true };
    };
    return handle;
  };
  await assert.rejects(readNamedFile(f.path, undefined, [f.root]), /changed before read/);
  assert.deepEqual(handles, { opened: 1, closed: 1 });
});
