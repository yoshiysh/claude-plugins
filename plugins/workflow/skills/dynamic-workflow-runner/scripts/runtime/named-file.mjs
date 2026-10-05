import { constants, promises as fs } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode &&
    left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

export async function canonicalNamedPath(path, directory) {
  const info = await lstat(path);
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile()) ||
      await realpath(path) !== resolve(path)) throw Error(`named workflow path must be canonical and symlink-free: ${path}`);
  return info;
}

export async function readNamedFile(path, expected, directories = []) {
  for (const directory of directories) await canonicalNamedPath(directory, true);
  const validated = await canonicalNamedPath(path, false);
  if (expected !== undefined && !sameFile(expected, validated)) throw Error('named workflow file changed before read');
  if (typeof constants.O_NOFOLLOW !== 'number' || typeof constants.O_NONBLOCK !== 'number')
    throw Error('safe named workflow reads require O_NOFOLLOW and O_NONBLOCK support');
  const handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || !sameFile(validated, opened)) throw Error('named workflow file changed before read');
    const bytes = Buffer.alloc(validated.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, Math.min(64 * 1024, bytes.length - offset), offset);
      if (!bytesRead) throw Error('named workflow file changed during read (short read)');
      offset += bytesRead;
    }
    const current = await handle.stat();
    const pathInfo = await canonicalNamedPath(path, false);
    if (!sameFile(opened, current) || !sameFile(opened, pathInfo)) throw Error('named workflow file changed during read');
    for (const directory of directories) await canonicalNamedPath(directory, true);
    const source = bytes.toString('utf8');
    if (!bytes.equals(Buffer.from(source, 'utf8'))) throw Error('named workflow file must contain valid UTF-8');
    return { source, bytes, info: opened };
  } finally { await handle.close(); }
}
