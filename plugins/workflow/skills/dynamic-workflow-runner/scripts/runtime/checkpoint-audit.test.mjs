import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { auditCheckpoint, inspectCheckpoint } from './checkpoint-audit.mjs';

const hash = x => createHash('sha256').update(x).digest('hex');
const source = 'export const meta = {name:"arbitrary"}; return await agent("x");';
const request = { args: { key: 'value' }, sourceHash: hash(source), argsHash: hash(JSON.stringify({ key: 'value' })) };
const start = id => ({ type: 'agent.started', id, promptHash: hash('x'), options: { label: `role-${id}` } });
function fixture(body = [start(1), { type: 'agent.completed', id: 1, result: { valid: true } }], inFlight = []) {
  return { source, requestText: JSON.stringify(request), eventsText: [
    { type: 'run.started' }, ...body, { type: 'run.failed', calls: 3, inFlight, error: 'budget' },
  ].map((e,i) => JSON.stringify({ sequence: i+1, ...e })).join('\n') + '\n' };
}

test('complete legacy results are frozen evidence, never an execution permit', () => {
  const result = auditCheckpoint(fixture());
  assert.equal(result.status, 'legacy-evidence-only');
  assert.equal(result.executable, false);
  assert.equal(result.candidateResults.length, 1);
  assert.throws(() => { result.candidateResults[0].id = 9; }, TypeError);
});
test('unfinished, failed and null results all need reconciliation', () => {
  for (const outcome of [undefined, { type: 'agent.failed', id: 2, error: 'transport' }, { type: 'agent.completed', id: 2, result: null }]) {
    const body = [start(1), { type: 'agent.completed', id: 1, result: false }, start(2), ...(outcome ? [outcome] : [])];
    const result = auditCheckpoint(fixture(body, outcome ? [] : [2]));
    assert.equal(result.status, 'reconciliation-required');
    assert.equal(result.candidateResults.length, 1);
    assert.equal(result.uncertainTasks[0].id, 2);
  }
});
test('source and argument identities, missing and truncated evidence fail closed', () => {
  const good = fixture();
  for (const mutation of [
    { ...good, source: source+' ' },
    { ...good, requestText: JSON.stringify({ ...request, args: {} }) },
    { ...good, eventsText: good.eventsText.slice(0, -1) },
    { ...good, eventsText: good.eventsText.split('\n').slice(0,-2).join('\n')+'\n' },
    { ...good, eventsText: good.eventsText.replace('"sequence":2', '"sequence":8') },
  ]) assert.throws(() => auditCheckpoint(mutation));
});
test('duplicates, orphan outcomes, unknown events and inconsistent pending state are rejected', () => {
  for (const data of [fixture([start(1),start(1)], [1]),
    fixture([{ type:'agent.completed', id:1, result:'orphan' }]),
    fixture([{ type:'unrecognized' }]), fixture([start(1)], []),
    fixture([], [1]), fixture([start(1)], [1,1])])
    assert.throws(() => auditCheckpoint(data));
});
test('schema-invalid outputs and events after terminal cannot become candidates', () => {
  const s = start(1); s.options.schema = { type: 'integer' };
  assert.throws(() => auditCheckpoint(fixture([s, { type:'agent.completed',id:1,result:'bad' }])));
  const good = fixture();
  assert.throws(() => auditCheckpoint({ ...good, eventsText: good.eventsText + JSON.stringify({ sequence:5,type:'log',value:'late' })+'\n' }));
});
test('fingerprint changes if otherwise valid journal metadata changes', () => {
  const a = fixture(); const b = { ...a, eventsText: a.eventsText.replace('"budget"','"deadline"') };
  assert.notEqual(auditCheckpoint(a).evidenceHash, auditCheckpoint(b).evidenceHash);
});
test('filesystem inspection is read-only and refuses evidence links outside run', async t => {
  const root = await mkdtemp(join(tmpdir(), 'checkpoint-audit-'));
  t.after(() => rm(root, { recursive:true, force:true }));
  const f = fixture();
  await Promise.all(Object.entries({ 'source.txt':f.source,'request.json':f.requestText,'events.jsonl':f.eventsText }).map(([p,v]) => writeFile(join(root,p),v)));
  assert.equal((await inspectCheckpoint(root)).candidateResults.length,1);
  await rm(join(root,'source.txt'));
  await symlink(import.meta.filename,join(root,'source.txt'));
  await assert.rejects(inspectCheckpoint(root), /leaves run/);
});
