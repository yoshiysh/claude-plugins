import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, basename } from 'node:path';
import { realpath } from 'node:fs/promises';
import { environmentPolicy } from './environment.mjs';
import { codexBackend } from './codex.mjs';

test('explicit environment snapshots PATH and commands without mutating global environment', async () => {
  const original = process.env.PATH;
  const input = {path:dirname(process.execPath),requiredCommands:[basename(process.execPath)]};
  const policy = environmentPolicy(input);
  input.path = '/missing'; input.requiredCommands.push('missing');
  const receipt = await policy.prepare();
  assert.equal(receipt.resolved[basename(process.execPath)],await realpath(process.execPath));
  assert.equal(policy.sdkConfig.shell_environment_policy.set.PATH,dirname(process.execPath));
  assert.equal(process.env.PATH,original);
});

test('invalid environment and missing dependencies fail closed', async () => {
  for (const input of [{path:'.',requiredCommands:['node']},
    {path:'/bin:',requiredCommands:['node']},{path:'/bin',requiredCommands:['a;id']},
    {path:'/bin',requiredCommands:[]},{path:'/bin',requiredCommands:['sh'],extra:true}])
    assert.throws(()=>environmentPolicy(input));
  await assert.rejects(environmentPolicy({path:'/no-such-runtime-directory',requiredCommands:['node']}).prepare(),/unavailable/);
  assert.equal((await environmentPolicy().prepare()).status,'host-default-unverified');
});

test('backend checks environment before thread dispatch and passes scoped SDK override', async () => {
  let starts=0, options;
  class Fake {
    constructor(input) {options=input;}
    startThread() {starts++; throw Error('must not dispatch');}
  }
  const backend=codexBackend({cwd:'/tmp',CodexClass:Fake,environment:{path:'/no-such-runtime-directory',requiredCommands:['node','rtk']}});
  await assert.rejects(backend.prepare(),/unavailable/);
  await assert.rejects(backend.run('x',{}, {emit(){}}),/unavailable/);
  assert.equal(starts,0);
  assert.equal(options.config.shell_environment_policy.set.PATH,'/no-such-runtime-directory');
});
