import { lstat, realpath, rename, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

async function realDirectory(path, name) {
  if (typeof path !== 'string' || !isAbsolute(path)) throw Error(`${name} must be absolute`);
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw Error(`${name} must be a real directory`);
  const canonical = await realpath(path);
  if (resolve(path) !== canonical) throw Error(`${name} changed identity`);
  return canonical;
}

async function directoryIdentity(path, name) {
  await realDirectory(path, name);
  const metadata = await lstat(path);
  return Object.freeze({ dev: metadata.dev, ino: metadata.ino });
}

async function verifyIdentity(path, expected, name) {
  const current = await directoryIdentity(path, name);
  if (current.dev !== expected.dev || current.ino !== expected.ino)
    throw Error(`${name} changed identity`);
}

export async function replaceDirectoryTransactional(target, replacement, {
  renamePath = rename,
  removePath = rm,
  onBeforeSwap = async () => {},
  onInstalled = async () => {},
} = {}) {
  const parent = await realDirectory(dirname(target), 'target parent');
  if (dirname(resolve(target)) !== parent || dirname(resolve(replacement)) !== parent)
    throw Error('target and replacement must be canonical siblings');
  const parentIdentity = await directoryIdentity(parent, 'target parent');
  const targetIdentity = await directoryIdentity(target, 'target');
  const replacementIdentity = await directoryIdentity(replacement, 'replacement');
  const backup = join(parent, `.${basename(target)}.rollback-${randomUUID()}`);
  await onBeforeSwap();
  await verifyIdentity(parent, parentIdentity, 'target parent');
  await verifyIdentity(target, targetIdentity, 'target');
  await verifyIdentity(replacement, replacementIdentity, 'replacement');
  await renamePath(target, backup);
  let installed = false;
  try {
    await verifyIdentity(parent, parentIdentity, 'target parent');
    const backedUp = await directoryIdentity(backup, 'rollback backup');
    if (backedUp.dev !== targetIdentity.dev || backedUp.ino !== targetIdentity.ino)
      throw Error('target changed identity while creating rollback backup');
    try { await lstat(target); throw Error('target reappeared before replacement install'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await verifyIdentity(replacement, replacementIdentity, 'replacement');
    await renamePath(replacement, target);
    installed = true;
    await verifyIdentity(parent, parentIdentity, 'target parent');
    await verifyIdentity(target, replacementIdentity, 'installed target');
    await onInstalled();
    await verifyIdentity(parent, parentIdentity, 'target parent');
    await verifyIdentity(target, replacementIdentity, 'installed target');
  } catch (error) {
    try {
      await verifyIdentity(parent, parentIdentity, 'target parent');
      if (installed) {
        await verifyIdentity(target, replacementIdentity, 'installed target');
        await renamePath(target, replacement);
      } else {
        try { await lstat(target); throw Error('target appeared before rollback'); }
        catch (targetError) { if (targetError.code !== 'ENOENT') throw targetError; }
      }
      await verifyIdentity(backup, targetIdentity, 'rollback backup');
      await renamePath(backup, target);
    } catch (rollbackError) {
      const failure = new Error(`replacement failed and rollback was incomplete; original may remain at ${backup}`, { cause: error });
      failure.backupPath = backup;
      failure.rollbackError = rollbackError;
      throw failure;
    }
    throw error;
  }
  await verifyIdentity(parent, parentIdentity, 'target parent');
  await verifyIdentity(backup, targetIdentity, 'rollback backup');
  try {
    await removePath(backup, { recursive: true });
  } catch (error) {
    await verifyIdentity(parent, parentIdentity, 'target parent');
    await verifyIdentity(target, replacementIdentity, 'installed target');
    await verifyIdentity(backup, targetIdentity, 'rollback backup');
    return Object.freeze({ status: 'applied_with_backup_remains', target, backupPath: backup,
      cleanupError: error instanceof Error ? error.message : String(error) });
  }
  return Object.freeze({ status: 'applied', target, backupPath: undefined });
}
