import { lstat, realpath, stat, mkdtemp } from 'node:fs/promises';
import { dirname, join, relative, resolve, isAbsolute, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { exactObject } from './inputs.mjs';

const execute = promisify(execFile);
const inside = (root, path) => { const rel = relative(root, path); return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)); };
const descendant = (root, path) => {
  const rel = relative(root, path);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};
const updatePathKeys = ['targetRoot', 'stagingRoot', 'targetDir', 'stagingDir'];
const updatePhases = new Set(['Find', 'Verify', 'Update', 'Reverify']);

function validateUpdateContractShape(cwd, updateContract) {
  if (updateContract === undefined) return;
  exactObject(updateContract, updatePathKeys, 'updateContract');
  for (const key of updatePathKeys) {
    if (typeof updateContract[key] !== 'string' || !isAbsolute(updateContract[key]))
      throw Error(`updateContract.${key} must be an absolute path`);
  }
  if (inside(updateContract.targetRoot, updateContract.stagingRoot) ||
      inside(updateContract.stagingRoot, updateContract.targetRoot) ||
      !descendant(updateContract.targetRoot, updateContract.targetDir) ||
      dirname(updateContract.stagingDir) !== updateContract.stagingRoot ||
      inside(updateContract.targetDir, updateContract.stagingDir) ||
      inside(updateContract.stagingDir, updateContract.targetDir))
    throw Error('updateContract roots and directories must be separate and contained');
}

async function canonicalDirectory(path, name) {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw Error(`${name} must be a real directory`);
  const canonical = await realpath(path);
  if (resolve(path) !== canonical) throw Error(`${name} changed identity`);
  return canonical;
}

export function workspacePolicy(cwd, input = {}, updateContract) {
  exactObject(input, ['mode', 'worktreeRoot', 'baseCommit'], 'workspace');
  const { mode = 'read-only', worktreeRoot, baseCommit } = input;
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) throw Error('worker cwd must be an absolute path');
  validateUpdateContractShape(cwd, updateContract);
  if (!['read-only', 'workspace-write'].includes(mode)) throw Error('unsupported workspace mode');
  if (updateContract !== undefined && mode !== 'read-only')
    throw Error('update contract requires a read-only base workspace; write access is phase-scoped');
  if (updateContract !== undefined && worktreeRoot !== undefined)
    throw Error('update contract cannot be combined with worktree isolation');
  if ((worktreeRoot === undefined) !== (baseCommit === undefined)) throw Error('worktreeRoot and baseCommit are required together');
  if (worktreeRoot !== undefined && (typeof worktreeRoot !== 'string' || !isAbsolute(worktreeRoot) ||
      typeof baseCommit !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(baseCommit)))
    throw Error('worktree requires an absolute root and a full commit hash');
  const capabilities = Object.freeze(['read-only', 'fresh-thread',
    ...(mode === 'workspace-write' ? ['workspace-write'] : []), ...(worktreeRoot ? ['worktree'] : [])]);
  let prepared;
  const git = async (args, signal) => (await execute('git', ['-C', cwd, ...args], {
    timeout: 10000, maxBuffer: 1024 * 1024, signal,
  })).stdout.trim();
  async function validateUpdatePaths() {
    const [targetRoot, stagingRoot, target, staging] = await Promise.all([
      canonicalDirectory(updateContract.targetRoot, 'update targetRoot'),
      canonicalDirectory(updateContract.stagingRoot, 'update stagingRoot'),
      canonicalDirectory(updateContract.targetDir, 'update targetDir'),
      canonicalDirectory(updateContract.stagingDir, 'update stagingDir'),
    ]);
    if (targetRoot !== updateContract.targetRoot || stagingRoot !== updateContract.stagingRoot ||
        target !== updateContract.targetDir || staging !== updateContract.stagingDir ||
        !descendant(targetRoot, target) || !descendant(stagingRoot, staging) ||
        dirname(staging) !== stagingRoot || inside(targetRoot, stagingRoot) || inside(stagingRoot, targetRoot) ||
        inside(target, staging) || inside(staging, target))
      throw Error('update contract roots or directories changed identity or containment');
    return Object.freeze({ targetRoot, stagingRoot, target, staging });
  }
  function prepare() {
    return prepared ??= (async () => {
      const directory = await realpath(cwd);
      if (!(await stat(directory)).isDirectory()) throw Error('worker cwd must be a directory');
      let updatePaths;
      if (updateContract !== undefined) {
        const paths = await validateUpdatePaths();
        updatePaths = Object.freeze({ ...paths });
      }
      if (!worktreeRoot) return Object.freeze({ mode, cwd: directory, updatePaths });
      const root = await realpath(worktreeRoot);
      if (!(await stat(root)).isDirectory() || inside(directory, root) || inside(root, directory))
        throw Error('worktree root must be separate from worker repository');
      const repository = await realpath(await git(['rev-parse', '--show-toplevel']));
      if (repository !== directory) throw Error('worktree cwd must be the repository root');
      const commit = await git(['rev-parse', '--verify', `${baseCommit}^{commit}`]);
      if (commit !== baseCommit) throw Error('worktree baseline must identify the exact commit');
      return Object.freeze({ mode, cwd: directory, worktreeRoot: root, baseCommit: commit, updatePaths });
    })();
  }
  function validate(options) {
    if (updateContract !== undefined && !updatePhases.has(options.phase))
      throw Error('update contract requires a recognized review phase');
    if (updateContract !== undefined && options.isolation !== undefined)
      throw Error('update contract does not allow worktree isolation');
    if (options.isolation !== undefined && (options.isolation !== 'worktree' || !worktreeRoot))
      throw Error('unsupported isolation; explicit worktree policy required');
    if (mode === 'workspace-write' && options.isolation === 'worktree')
      throw Error('workspace-write cannot use worktree isolation because the shared run workspace is outside the isolated checkout');
  }
  function modeFor(options) {
    validate(options);
    if (updateContract !== undefined) return options.phase === 'Update' ? 'workspace-write' : 'read-only';
    return mode;
  }
  return {
    capabilities, prepare, validate, modeFor,
    async validateDispatch(options, directory) {
      if (updateContract === undefined) return;
      const paths = await validateUpdatePaths();
      const policy = await prepare();
      const expected = options.phase === 'Update' ? paths.staging : policy.cwd;
      if (directory !== expected) throw Error('update dispatch directory differs from its phase-bound path');
    },
    async allocate(options, { signal, emit }) {
      validate(options);
      const policy = await prepare();
      signal?.throwIfAborted();
      if (policy.updatePaths) {
        const paths = await validateUpdatePaths();
        return options.phase === 'Update' ? paths.staging : policy.cwd;
      }
      if (!options.isolation) return policy.cwd;
      const target = await mkdtemp(join(policy.worktreeRoot, 'agent-'));
      // Keep all worktrees, including failed/cancelled runs, for inspection. Never
      // reset, remove, or merge worker changes automatically.
      emit({ type: 'workspace.allocated', path: target, baseCommit: policy.baseCommit, state: 'preparing' });
      try {
        await git(['-c', 'core.hooksPath=/dev/null', 'worktree', 'add', '--detach', target, policy.baseCommit], signal);
      } catch (error) { error.fatal = true; throw error; }
      signal?.throwIfAborted();
      emit({ type: 'workspace.ready', path: target, baseCommit: policy.baseCommit, mode });
      return target;
    },
  };
}
