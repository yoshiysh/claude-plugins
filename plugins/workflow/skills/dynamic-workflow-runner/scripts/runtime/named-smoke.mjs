import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

const [artifactRoot, model] = process.argv.slice(2);
if (!artifactRoot || !isAbsolute(artifactRoot) || !model || process.argv.length !== 4)
  throw Error('usage: node named-smoke.mjs NEW_ABSOLUTE_ARTIFACT_ROOT EXPLICIT_CODEX_MODEL');
await mkdir(artifactRoot, { mode: 0o700 });
const root = await realpath(artifactRoot);
const plugin = join(root, 'plugin'), workspace = join(root, 'workspace');
await mkdir(join(plugin, '.claude-plugin'), { recursive: true });
await mkdir(join(plugin, 'workflows'));
await mkdir(workspace);
await writeFile(join(plugin, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'runner-smoke', version: '1.0.0' }));
await writeFile(join(plugin, 'workflows/write-check.js'), `export const meta={name:'write-check',description:'one writable named SDK agent',requirements:['workspace-write']};
return await agent('Create the UTF-8 file '+args.workspace+'/marker.txt containing exactly named-workflow-ok followed by one newline. Read it back from disk. Return the absolute path in path and the exact read-back contents in contents.', {
 model:'smoke', effort:'low', label:'write-check', schema:{type:'object',properties:{path:{type:'string'},contents:{type:'string'}},required:['path','contents']}
});`);
const request = { name: 'runner-smoke:write-check', trustedPluginRoots: [plugin],
  args: { workspace }, cwd: workspace, workspace: { mode: 'workspace-write' }, runDir: join(root, 'run'),
  modelMap: { smoke: model }, requirements: ['workspace-write'],
  limits: { maxAgents: 1, concurrency: 1, timeoutMs: 120000, agentTimeoutMs: 90000, maxOutputBytes: 1000000 } };
const requestPath = join(root, 'request.json');
await writeFile(requestPath, JSON.stringify(request, null, 2), { mode: 0o600 });
process.stdout.write(JSON.stringify({ requestPath, markerPath: join(workspace, 'marker.txt') }) + '\n');
