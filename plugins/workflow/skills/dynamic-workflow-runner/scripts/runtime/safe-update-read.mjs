import { constants, promises as fs } from 'node:fs';
import { lstat } from 'node:fs/promises';

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mode === right.mode && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

export async function readRegularFileBounded(path, expected, maxBytes) {
  if (typeof constants.O_NOFOLLOW !== 'number' || typeof constants.O_NONBLOCK !== 'number')
    throw Error('safe update reads require O_NOFOLLOW and O_NONBLOCK support');
  if (!expected.isFile() || expected.isSymbolicLink() || expected.size > maxBytes)
    throw Error('update file is not regular or exceeds its size limit');
  const handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || !sameFile(expected, opened))
      throw Error('update file changed identity before read');
    const contents = Buffer.alloc(expected.size);
    let offset = 0;
    while (offset < contents.length) {
      const { bytesRead } = await handle.read(contents, offset, Math.min(64 * 1024, contents.length - offset), offset);
      if (!bytesRead) throw Error('update file changed during read (short read)');
      offset += bytesRead;
    }
    const current = await handle.stat();
    const pathInfo = await lstat(path);
    if (!sameFile(opened, current) || !sameFile(opened, pathInfo) ||
        !pathInfo.isFile() || pathInfo.isSymbolicLink())
      throw Error('update file changed during read');
    return contents;
  } finally {
    await handle.close();
  }
}
