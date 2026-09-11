import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { rehearseCheckpoint } from './checkpoint-rehearsal.mjs';
const hash = x => createHash('sha256').update(x).digest('hex');
async function fixture(t, mismatch = false) {
  const root = await mkdtemp(join(tmpdir(),'rehearsal-'));
  t.after(() => rm(root,{recursive:true,force:true}));
  const source = 'export const meta={name:"fixture",description:"checkpoint fixture"}; const a=await parallel([()=>agent("one",{label:"a"}),()=>agent("two",{label:"b"})]); return await agent(a.join("-"),{label:"next"});';
  const options = [{label:'a'},{label:'b'}];
  const events = [{type:'run.started'},
    ...options.map((option,i) => ({type:'agent.started',id:i+1,promptHash:hash(i?'two':mismatch?'wrong':'one'),options:option})),
    {type:'agent.completed',id:2,result:'B'}, {type:'agent.completed',id:1,result:'A'},
    {type:'agent.started',id:3,promptHash:hash('A-B'),options:{label:'next'}},
    {type:'run.failed',calls:3,inFlight:[3],error:'stop'}];
  const request = {args:{},sourceHash:hash(source),argsHash:hash('{}'),requirements:[],limits:{concurrency:2,maxOutputBytes:100000}};
  await Promise.all(Object.entries({'source.txt':source,'request.json':JSON.stringify(request),
    'events.jsonl':events.map((e,i)=>JSON.stringify({sequence:i+1,...e})).join('\n')+'\n'}).map(([p,v])=>writeFile(join(root,p),v)));
  return root;
}
test('saved parallel results drive real JavaScript to the unresolved boundary without inference', async t => {
  const root=await fixture(t);
  const result=await rehearseCheckpoint({previousRun:root,runDir:join(root,'rehearsal'),trustedSource:true});
  assert.equal(result.historicalResultsReplayed,2);
  assert.equal(result.modelCalls,0);
  assert.equal(result.executable,false);
  assert.equal(result.frontier.id,3);
});
test('mismatched historical prompt stops and never substitutes results', async t => {
  const root=await fixture(t,true);
  await assert.rejects(rehearseCheckpoint({previousRun:root,runDir:join(root,'rehearsal'),trustedSource:true}), /mismatch/);
});
test('trust acknowledgement is mandatory', async () => {
  await assert.rejects(rehearseCheckpoint({previousRun:'/missing',runDir:'/missing'}), /acknowledgement/);
});
