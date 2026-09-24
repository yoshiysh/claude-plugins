import { createHash, randomUUID } from 'node:crypto';
import { constants, promises as fsPromises } from 'node:fs';
import { lstat, mkdir, opendir, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const maxWorkspaceEntries = 10000;
const maxPendingWorkspaceNames = maxWorkspaceEntries * 2;
const maxWorkspaceBytes = 32 * 1024 * 1024;
const maxWorkspaceManifestBytes = 8 * 1024 * 1024;

function slug(name) {
  const value = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
  return value || 'workflow';
}

function overlaps(left, right) {
  const contains = (root, path) => {
    const part = relative(root, path);
    return part === '' || (part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part));
  };
  return contains(left, right) || contains(right, left);
}

async function runDirectoryPath(runDir) {
  if (typeof runDir !== 'string' || !isAbsolute(runDir)) throw Error('absolute runDir required');
  const parent = await realpath(dirname(resolve(runDir)));
  return join(parent, basename(resolve(runDir)));
}

async function realDirectory(path, name) {
  let metadata;
  try { metadata = await lstat(path); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    try { await mkdir(path, { mode: 0o700 }); }
    catch (creationError) { if (creationError.code !== 'EEXIST') throw creationError; }
    metadata = await lstat(path);
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw Error(`${name} must be a real directory`);
  const canonical = await realpath(path);
  if (canonical !== path) throw Error(`${name} changed identity`);
  return canonical;
}

async function layout(projectRoot, workflowName) {
  if (typeof projectRoot !== 'string' || !isAbsolute(projectRoot)) throw Error('absolute workspace project root required');
  if (typeof workflowName !== 'string' || !workflowName) throw Error('workflow name required');
  const project = await realpath(projectRoot);
  await realDirectory(project, 'workspace project root');
  const dynamicRoot = await realDirectory(join(project, 'dynamic-workflows'), 'dynamic-workflows');
  const workspaceRoot = await realDirectory(join(dynamicRoot, 'workspace'), 'workspace root');
  const workflowRoot = await realDirectory(join(workspaceRoot, slug(workflowName)), 'workflow workspace root');
  return { project, workflowRoot };
}

export async function createRunWorkspace({ projectRoot, workflowName, runDir }) {
  const { workflowRoot } = await layout(projectRoot, workflowName);
  const journal = await runDirectoryPath(runDir);
  const path = join(workflowRoot, randomUUID());
  if (overlaps(journal, path)) throw Error('runDir and workflow workspace must be separate');
  await mkdir(path, { mode: 0o700 });
  const canonical = await realpath(path);
  if (canonical !== path || overlaps(journal, canonical)) throw Error('workflow workspace changed identity or overlaps runDir');
  return Object.freeze({ path: canonical });
}

export async function reuseRunWorkspace({ projectRoot, workflowName, workspace, runDir }) {
  if (!workspace || typeof workspace.path !== 'string' || !isAbsolute(workspace.path))
    throw Error('checkpoint workspace path is missing');
  const { workflowRoot } = await layout(projectRoot, workflowName);
  const path = resolve(workspace.path);
  const journal = await runDirectoryPath(runDir);
  if (dirname(path) !== workflowRoot || basename(path) === '' || overlaps(journal, path))
    throw Error('checkpoint workspace path is outside its workflow root or overlaps runDir');
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw Error('checkpoint workspace must be a real directory');
  const canonical = await realpath(path);
  if (canonical !== path) throw Error('checkpoint workspace changed identity');
  return Object.freeze({ path: canonical });
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mode === right.mode && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

async function directoryNames(path, entryLimit, pendingNames) {
  const directory = await opendir(path);
  const names = [];
  try {
    for await (const entry of directory) {
      if (names.length >= entryLimit) throw Error('workspace manifest exceeds its entry limit');
      if (pendingNames.count >= maxPendingWorkspaceNames)
        throw Error('workspace manifest exceeds its pending-name limit');
      names.push(entry.name);
      pendingNames.count++;
    }
  } catch (error) {
    pendingNames.count -= names.length;
    throw error;
  } finally {
    await directory.close().catch(error => {
      if (error.code !== 'ERR_DIR_CLOSED') throw error;
    });
  }
  return names.sort();
}

export async function snapshotRunWorkspace(path) {
  if (path === null || path === undefined) return [];
  if (typeof path !== 'string' || !isAbsolute(path)) throw Error('absolute workspace path required');
  const root = resolve(path);
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || await realpath(root) !== root)
    throw Error('workspace root must be a real directory');
  if (typeof constants.O_NOFOLLOW !== 'number' || typeof constants.O_NONBLOCK !== 'number')
    throw Error('safe workspace snapshots require O_NOFOLLOW and O_NONBLOCK support');
  const entries = [];
  let totalBytes = 0, manifestBytes = 2;
  const add = entry => {
    const encodedBytes = Buffer.byteLength(JSON.stringify(entry)) + (entries.length ? 1 : 0);
    if (entries.length >= maxWorkspaceEntries || manifestBytes + encodedBytes > maxWorkspaceManifestBytes)
      throw Error('workspace manifest exceeds its size limit');
    manifestBytes += encodedBytes;
    entries.push(entry);
  };
  add({ path: '.', type: 'directory', mode: rootInfo.mode & 0o777 });
  const pendingNames = { count: 0 };
  const walk = async (directory, parent = '') => {
    const names = await directoryNames(directory, maxWorkspaceEntries - entries.length, pendingNames);
    try {
      for (const name of names) {
        if (!name || name === '.' || name === '..' || name.includes(sep)) throw Error('invalid workspace entry name');
        const absolute = join(directory, name);
        const pathName = parent ? `${parent}/${name}` : name;
        const info = await lstat(absolute);
        if (info.isSymbolicLink()) throw Error(`workspace symlink is not allowed: ${pathName}`);
        if (info.isDirectory()) {
          if (await realpath(absolute) !== absolute) throw Error(`workspace directory changed identity: ${pathName}`);
          add({ path: pathName, type: 'directory', mode: info.mode & 0o777 });
          await walk(absolute, pathName);
          const after = await lstat(absolute);
          if (!sameFile(info, after) || await realpath(absolute) !== absolute)
            throw Error(`workspace directory changed while snapshotting: ${pathName}`);
        } else if (info.isFile()) {
          totalBytes += info.size;
          if (totalBytes > maxWorkspaceBytes) throw Error('workspace contents exceed their size limit');
          const handle = await fsPromises.open(absolute,
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
          const digest = createHash('sha256');
          let bytesRead = 0;
          try {
            const opened = await handle.stat();
            if (!opened.isFile() || !sameFile(info, opened)) throw Error(`workspace file changed identity: ${pathName}`);
            const buffer = Buffer.alloc(Math.min(64 * 1024, Math.max(1, info.size)));
            while (bytesRead < info.size) {
              const length = Math.min(buffer.length, info.size - bytesRead);
              const result = await handle.read(buffer, 0, length, bytesRead);
              if (!result.bytesRead) throw Error(`workspace file changed while snapshotting (short read): ${pathName}`);
              digest.update(buffer.subarray(0, result.bytesRead));
              bytesRead += result.bytesRead;
            }
            const current = await handle.stat();
            const pathInfo = await lstat(absolute);
            if (!sameFile(opened, current) || !sameFile(opened, pathInfo) || !pathInfo.isFile() || pathInfo.isSymbolicLink())
              throw Error(`workspace file changed while snapshotting: ${pathName}`);
          } finally { await handle.close(); }
          add({ path: pathName, type: 'file', size: bytesRead, mode: info.mode & 0o777, sha256: digest.digest('hex') });
        } else throw Error(`workspace special file is not allowed: ${pathName}`);
      }
      const currentNames = await directoryNames(directory, maxWorkspaceEntries, pendingNames);
      try {
        if (JSON.stringify(currentNames) !== JSON.stringify(names))
          throw Error(`workspace entries changed while snapshotting: ${parent || '.'}`);
      } finally { pendingNames.count -= currentNames.length; }
    } finally { pendingNames.count -= names.length; }
  };
  await walk(root);
  if (!sameFile(rootInfo, await lstat(root)) || await realpath(root) !== root)
    throw Error('workspace root changed while snapshotting');
  entries.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  return entries;
}
