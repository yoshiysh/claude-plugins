import { realpath, stat, mkdtemp } from 'node:fs/promises';
import { join, relative, isAbsolute, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { exactObject } from './inputs.mjs';

const execute = promisify(execFile);
const inside = (root, path) => { const rel = relative(root, path); return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)); };
export function workspacePolicy(cwd, input = {}) {
  exactObject(input, ['mode', 'worktreeRoot', 'baseCommit'], 'workspace');
  const { mode = 'read-only', worktreeRoot, baseCommit } = input;
  if (!['read-only', 'workspace-write'].includes(mode)) throw Error('unsupported workspace mode');
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
  function prepare() {
    return prepared ??= (async () => {
      const directory = await realpath(cwd);
      if (!(await stat(directory)).isDirectory()) throw Error('worker cwd must be a directory');
      if (!worktreeRoot) return Object.freeze({ mode, cwd: directory });
      const root = await realpath(worktreeRoot);
      if (!(await stat(root)).isDirectory() || inside(directory, root) || inside(root, directory))
        throw Error('worktree root must be separate from worker repository');
      const repository = await realpath(await git(['rev-parse', '--show-toplevel']));
      if (repository !== directory) throw Error('worktree cwd must be the repository root');
      const commit = await git(['rev-parse', '--verify', `${baseCommit}^{commit}`]);
      if (commit !== baseCommit) throw Error('worktree baseline must identify the exact commit');
      return Object.freeze({ mode, cwd: directory, worktreeRoot: root, baseCommit: commit });
    })();
  }
  function validate(options) {
    if (options.isolation !== undefined && (options.isolation !== 'worktree' || !worktreeRoot))
      throw Error('unsupported isolation; explicit worktree policy required');
  }
  return {
    capabilities, prepare, validate,
    async allocate(options, { signal, emit }) {
      validate(options);
      const policy = await prepare();
      signal?.throwIfAborted();
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
