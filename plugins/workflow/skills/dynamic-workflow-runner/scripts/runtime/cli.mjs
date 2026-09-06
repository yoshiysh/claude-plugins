import { readFile } from 'node:fs/promises';
import { Workflow } from './runtime.mjs';
import { codexBackend } from './codex.mjs';

// One JSON request file avoids shell interpolation of workflow arguments.
// Nothing defaults to live inference: both flags must be explicitly supplied.
const [requestPath, ...flags] = process.argv.slice(2);
try {
  if (!requestPath || flags.length !== 2 || !flags.includes('--live') || !flags.includes('--trusted-source'))
    throw new Error('usage: node cli.mjs REQUEST.json --live --trusted-source');
  const request = JSON.parse(await readFile(requestPath, 'utf8'));
  const { scriptPath, args, runDir, cwd, modelMap, model, modelReasoningEffort, codexPathOverride, limits = {} } = request;
  const result = await Workflow({ scriptPath, args }, { ...limits, runDir, trustedSource: true,
    backend: codexBackend({ cwd, modelMap, model, modelReasoningEffort, codexPathOverride }) });
  process.stdout.write(JSON.stringify({ status: 'completed', runDir, result }) + '\n');
} catch (error) {
  process.stderr.write(JSON.stringify({ status: 'failed', error: error.message }) + '\n');
  process.exitCode = 1;
}
