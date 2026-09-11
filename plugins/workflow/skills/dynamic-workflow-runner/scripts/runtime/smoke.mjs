import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Workflow } from './runtime.mjs';
import { codexBackend } from './codex.mjs';

if (process.argv.length !== 3 || process.argv[2] !== '--live') throw Error('explicit --live required');
const root = await mkdtemp(join(tmpdir(), 'workflow-live-smoke-'));
const cwd = join(root, 'workspace');
await mkdir(cwd, { mode: 0o700 });
console.log(JSON.stringify({ runRoot: root, maxAgents: 2, timeoutMs: 60000 }));
try {
  const result = await Workflow({ scriptPath: fileURLToPath(new URL('./smoke.flow', import.meta.url)), args: {} }, {
    backend: codexBackend({ cwd }), runDir: join(root, 'run'), trustedSource: true,
    maxAgents: 2, concurrency: 1, timeoutMs: 60000,
  });
  console.log(JSON.stringify({ status: 'completed', result }));
} catch (error) {
  console.error(JSON.stringify({ status: 'failed', error: error.message, runRoot: root }));
  process.exitCode = 1;
}
