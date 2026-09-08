import { readFile } from 'node:fs/promises';
import { executeWorkflow } from './adapter.mjs';
import { exactObject, limitKeys } from './inputs.mjs';

// One JSON request file avoids shell interpolation of workflow arguments.
// Nothing defaults to live inference: both flags must be explicitly supplied.
const [requestPath, ...flags] = process.argv.slice(2);
try {
  if (!requestPath || flags.length !== 2 || !flags.includes('--live') || !flags.includes('--trusted-source'))
    throw new Error('usage: node cli.mjs REQUEST.json --live --trusted-source');
  const request = JSON.parse(await readFile(requestPath, 'utf8'));
  exactObject(request, ['scriptPath', 'args', 'runDir', 'cwd', 'modelMap', 'model',
    'modelReasoningEffort', 'codexPathOverride', 'limits', 'requirements', 'workspace', 'environment', 'context'], 'CLI request');
  exactObject(request.limits ?? {}, limitKeys, 'limits');
  const { scriptPath, args, runDir, cwd, modelMap, model, modelReasoningEffort, codexPathOverride, limits = {} } = request;
  const result = await executeWorkflow({ scriptPath, args }, { ...limits, runDir, trustedSource: true, requirements: request.requirements,
    cwd, modelMap, model, modelReasoningEffort, codexPathOverride, workspace: request.workspace, environment: request.environment, context: request.context });
  process.stdout.write(JSON.stringify({ status: 'completed', runDir, result }) + '\n');
} catch (error) {
  process.stderr.write(JSON.stringify({ status: 'failed', error: error.message }) + '\n');
  process.exitCode = 1;
}
