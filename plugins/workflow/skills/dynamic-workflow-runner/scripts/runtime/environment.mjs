import { access, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, join, delimiter } from 'node:path';
import { exactObject } from './inputs.mjs';

export function environmentPolicy(input) {
  if (input === undefined) return { sdkConfig: {}, async prepare() { return { status: 'host-default-unverified' }; } };
  exactObject(input, ['path', 'requiredCommands'], 'environment');
  if (typeof input.path !== 'string' || !input.path || input.path.split(delimiter).some(p => !p || !isAbsolute(p)))
    throw Error('environment.path requires absolute nonempty PATH entries');
  if (!Array.isArray(input.requiredCommands) || !input.requiredCommands.length ||
      input.requiredCommands.some(c => typeof c !== 'string' || !/^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(c)))
    throw Error('environment.requiredCommands requires simple command names');
  const path = input.path, commands = [...new Set(input.requiredCommands)];
  return {
    sdkConfig: { shell_environment_policy: { set: { PATH: path } } },
    async prepare() {
      const resolved = {};
      for (const command of commands) {
        for (const directory of path.split(delimiter)) {
          const candidate = join(directory, command);
          try {
            await access(candidate, constants.X_OK);
            if (!(await stat(candidate)).isFile()) continue;
            resolved[command] = await realpath(candidate); break;
          } catch (error) {
            if (!['ENOENT', 'ENOTDIR', 'EACCES'].includes(error.code)) throw error;
          }
        }
        if (!resolved[command]) throw Error(`required command unavailable in explicit PATH: ${command}`);
      }
      return { status: 'executable-paths-checked', path, resolved,
        boundary: 'Filesystem check only; shell startup, hooks and sandbox execution are not certified.' };
    },
  };
}
