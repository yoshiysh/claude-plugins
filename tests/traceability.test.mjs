import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { normalize, evaluate } from '../scripts/traceability/core.mjs';
import { validatePlans, loadConfig, readSpecs } from '../scripts/traceability/specs.mjs';
import { runTests, coverageReport } from '../scripts/traceability/runner.mjs';

const id = 'SP-BPTEST-001';
const spec = (status='完了') => ({[id]:{id,status:status === '完了' ? 'complete':'in-progress',rows:[{status,verification:'unit'}]}});
const config = (scenarios={}) => ({scopePrefixes:['SP-BP'],scenarios});
const plan = {normal:[{id:'ok',expectation:'accepted'}],recovery:{notApplicable:'No recovery path'},error:{notApplicable:'No errors'},boundary:[{id:'edge',expectation:'accepted at limit'}]};
const leaf = (status='pass',extra={}) => ({ids:[id],scenarios:[],name:'test',status,...extra});

test('normalization retains inherited IDs, leaf results and overlapping scenario annotations', () => {
  const events = [
    {type:'test:enqueue',data:{testId:1,parentId:0,name:`${id} @normal:ok`,nesting:0,file:'a'}},
    {type:'test:enqueue',data:{testId:2,parentId:1,name:'lower @normal:ok @boundary:edge',nesting:1,file:'a'}},
    {type:'test:pass',data:{testId:2,name:'lower',nesting:1,file:'a'}},
    {type:'test:pass',data:{testId:1,name:id,nesting:0,file:'a'}},
  ];
  const [result] = normalize(events);
  assert.deepEqual(result.ids,[id]);
  assert.deepEqual(result.scenarios,[{category:'normal',id:'ok'},{category:'boundary',id:'edge'}]);
  assert.equal(normalize(events).length,1);
  assert.equal(evaluate(spec(),[result],config({[id]:plan})).errors.length,0);
});

test('unknown ID fails even on skipped or todo test; other scope is disclosed', () => {
  for (const status of ['skip','todo','pass','fail']) {
    const result = evaluate(spec('作成中'),[leaf(status,{ids:['SP-BPTEST-999','SP-OTHER-001']})],config());
    assert.match(result.errors.join(),/Unknown specification/);
    assert.deepEqual(result.ignoredIds,['SP-OTHER-001']);
  }
});

test('specification-first development reports gaps; completion and completed rows enforce passing trace', () => {
  assert.equal(evaluate(spec('未着手'),[],config()).errors.length,0);
  assert.equal(evaluate(spec('作成中'),[],config()).errors.length,0);
  assert.match(evaluate(spec('作成中'),[],config(),true).errors.join(),/Completion gate/);
  assert.match(evaluate(spec(),[leaf('skip')],config()).errors.join(),/lack passing tests/);
  assert.equal(evaluate(spec(),[leaf()],config()).errors.length,0);
  assert.equal(evaluate(spec(),[leaf()],config()).complete,false);
});

test('partial specification retains obligations of completed verification rows', () => {
  const specs = spec('作成中');
  specs[id].rows.push({status:'完了',verification:'different unit'});
  const result = evaluate(specs,[],config());
  assert.match(result.errors.join(),/Completed verification rows/);
  assert.equal(result.specifications[0].rows.length,2);
});

test('scenario plans reject missing, empty, unknown and duplicate cases', () => {
  for (const bad of [{normal:[]},{...plan,error:{notApplicable:' '}},{...plan,unexpected:[]},{...plan,normal:[{id:'x',expectation:'a'},{id:'x',expectation:'b'}]}]) assert.throws(() => validatePlans({[id]:bad},spec()));
  assert.throws(() => validatePlans({'SP-BPTEST-999':plan},spec()),/Unknown/);
  assert.doesNotThrow(() => validatePlans({[id]:plan},spec()));
});

test('adopted plans check actual successful cases and reject unknown cases on skipped tests', () => {
  const adopted = config({[id]:plan});
  assert.match(evaluate(spec(),[leaf()],adopted).errors.join(),/lack planned scenarios/);
  assert.match(evaluate(spec('未着手'),[leaf('skip',{scenarios:[{category:'normal',id:'typo'}]})],adopted).errors.join(),/Unknown scenario/);
  assert.match(evaluate(spec('未着手'),[leaf('skip',{scenarios:[{category:'typo',id:'ok'}]})],config()).errors.join(),/Unknown scenario/);
  assert.match(evaluate(spec('未着手'),[leaf('pass',{scenarios:[{category:'normal',id:'ok'}]})],config()).errors.join(),/Unknown scenario/);
});

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(),'traceability-'));
  t.after(() => rm(root,{recursive:true,force:true}));
  await mkdir(path.join(root,'specs'));
  await mkdir(path.join(root,'src'));
  await mkdir(path.join(root,'tests'));
  await writeFile(path.join(root,'specs','spec.md'),`#### ${id} behavior\n| PR-A-001 | ${id} | unit test | 作成中 |\n`);
  await writeFile(path.join(root,'src','loaded.mjs'),'export const add = (a,b) => a+b;\n');
  await writeFile(path.join(root,'src','never.mjs'),'export const never = () => 42;\n');
  await writeFile(path.join(root,'tests','bp-sample.test.mjs'),`import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport {add} from '../src/loaded.mjs';\ntest('${id}',async t=>{await t.test('@normal:ok',()=>assert.equal(add(1,2),3));await t.test('skip',{skip:true},()=>{});});\n`);
  const raw = {root:'.',specDirectories:['specs'],sourceDirectories:['src'],testDirectories:[{path:'tests',prefix:'bp-'}],scopePrefixes:['SP-BP'],scenarios:{}};
  const file = path.join(root,'config.json');
  await writeFile(file,JSON.stringify(raw));
  return {root,file,raw};
}

test('inventory discovers additions, preserves rows, rejects escapes and duplicate spec definitions', async t => {
  const {root,file,raw} = await fixture(t);
  let c = await loadConfig(file);
  assert.equal(c.sourceFiles.length,2);
  assert.equal((await readSpecs(c))[id].rows.length,1);
  await writeFile(path.join(root,'src','new.mjs'),'export const x=1;');
  assert.equal((await loadConfig(file)).sourceFiles.length,3);
  await writeFile(path.join(root,'specs','second.md'),`#### ${id} duplicate`);
  await assert.rejects(readSpecs(await loadConfig(file)),/Duplicate/);
  raw.sourceFiles=['../escape'];
  await writeFile(file,JSON.stringify(raw));
  await assert.rejects(loadConfig(file));
});

test('real Node execution distinguishes skip and loaded/never loaded source inventory', async t => {
  const {file} = await fixture(t);
  const c = await loadConfig(file);
  const run = await runTests(c,c.testFiles);
  assert.equal(run.summary.success,true);
  const tests = normalize(run.events);
  assert.equal(tests.length,2);
  assert.ok(tests.every(x => x.ids.includes(id)));
  assert.deepEqual(tests.map(x => x.status).sort(),['pass','skip']);
  const coverage = coverageReport(c,run);
  assert.equal(coverage.files.length,2);
  assert.ok(coverage.files.some(x => x.file.endsWith('loaded.mjs') && x.status === 'measured'));
  assert.ok(coverage.files.some(x => x.file.endsWith('never.mjs') && ['unloaded','zero-covered'].includes(x.status)));
});

test('runner failure cannot become success and explicit unmeasured source remains visible', async t => {
  const {root,file} = await fixture(t);
  const c = await loadConfig(file);
  await writeFile(path.join(root,'tests','bp-sample.test.mjs'),"process.exit(2);\n");
  const run = await runTests(c,c.testFiles);
  assert.equal(run.summary.success,false);
  c.unmeasuredSources['src/never.mjs']='Transformed VM source cannot be attributed';
  const coverage = coverageReport(c,run);
  assert.equal(coverage.status,'partial');
  assert.equal(coverage.files.find(x => x.file.endsWith('never.mjs')).status,'unmeasured');
});


test('ancestor declarations remain validated when child IDs or annotations replace inheritance', () => {
  const make = (parent,child) => normalize([
    {type:'test:start',data:{name:parent,nesting:0,file:'a'}},
    {type:'test:start',data:{name:child,nesting:1,file:'a'}},
    {type:'test:pass',data:{name:child,nesting:1,file:'a'}},
    {type:'test:pass',data:{name:parent,nesting:0,file:'a'}},
  ]);
  assert.match(evaluate(spec('作成中'),make('SP-BPTEST-999',id),config()).errors.join(),/Unknown specification/);
  for (const parent of [`${id} @unknown:bad`,`${id} @normal:bad`]) {
    assert.match(evaluate(spec('作成中'),make(parent,`${id} @normal:ok`),config({[id]:plan})).errors.join(),/Unknown scenario/);
  }
});

test('complete requires nonempty scope, no reference errors, and successful execution', () => {
  const adopted = config({[id]:plan});
  const success = leaf('pass',{scenarios:[{category:'normal',id:'ok'},{category:'boundary',id:'edge'}]});
  assert.equal(evaluate(spec(),[success],adopted).complete,true);
  assert.equal(evaluate(spec(),[success,leaf('skip',{ids:['SP-BPTEST-999']})],adopted).complete,false);
  assert.equal(evaluate(spec(),[success],adopted,false,false).complete,false);
  assert.match(evaluate({},[],config(),true).errors.join(),/No specifications/);
  for (const key of ['constructor','toString','__proto__']) assert.throws(() => validatePlans(JSON.parse(JSON.stringify({[key]:plan})),{}),/Unknown/);
});

test('specification references resolve after collecting definitions from every file', async t => {
  const {root,file} = await fixture(t);
  await writeFile(path.join(root,'specs','spec.md'),`| PR-A-001 | ${id} | unit test | 作成中 |`);
  await writeFile(path.join(root,'specs','z-definition.md'),`#### ${id} behavior`);
  assert.equal((await readSpecs(await loadConfig(file)))[id].rows.length,1);
});

test('real reporter preserves concurrent nested siblings, repeated names and file isolation', async t => {
  const {root,file} = await fixture(t);
  await writeFile(path.join(root,'tests','bp-sample.test.mjs'),`import test from 'node:test';
const same = async t => { await new Promise(r=>setTimeout(r,15)); await t.test('leaf',()=>{}); };
test('${id} @normal:ok',{concurrency:true},async t=>{await Promise.all([t.test('same',same),t.test('other',same)]);});
test('SP-BPTEST-002 @normal:second',async t=>{await t.test('leaf',()=>{});});`);
  await writeFile(path.join(root,'tests','bp-second.test.mjs'),`import test from 'node:test';test('SP-BPTEST-003 @normal:third',async t=>{await t.test('leaf',()=>{});});`);
  const c = await loadConfig(file);
  const leaves = normalize((await runTests(c,c.testFiles)).events);
  assert.equal(leaves.length,4);
  assert.equal(leaves.filter(x => x.ids.includes(id)).length,2);
  for (const [suffix,scenario] of [['002','second'],['003','third']]) {
    const linked = leaves.filter(x => x.ids.includes(`SP-BPTEST-${suffix}`));
    assert.equal(linked.length,1);
    assert.deepEqual(linked[0].scenarios,[{category:'normal',id:scenario}]);
  }
});


test('nested tests declared by an imported helper retain the entry test parent', async t => {
  const {root,file} = await fixture(t);
  await writeFile(path.join(root,'tests','helper.mjs'),"export const child = t => t.test('helper leaf',()=>{});\n");
  await writeFile(path.join(root,'tests','bp-sample.test.mjs'),`import test from 'node:test';import {child} from './helper.mjs';test('${id} @normal:ok',child);`);
  const c = await loadConfig(file);
  const leaves = normalize((await runTests(c,c.testFiles)).events);
  assert.equal(leaves.length,1);
  assert.deepEqual(leaves[0].ids,[id]);
  assert.deepEqual(leaves[0].scenarios,[{category:'normal',id:'ok'}]);
});

function cli(args,cwd) {
  return new Promise((resolve,reject) => {
    const child = spawn(process.execPath,[fileURLToPath(new URL('../scripts/traceability/cli.mjs',import.meta.url)),...args],{cwd,env:{...process.env,NODE_TEST_CONTEXT:''}});
    let stdout='',stderr='';
    child.stdout.on('data',chunk=>stdout+=chunk);
    child.stderr.on('data',chunk=>stderr+=chunk);
    child.on('error',reject);
    child.on('close',code=>resolve({code,stdout,stderr}));
  });
}

test('CLI reports share a run ID, failures invalidate completion, and output locks preserve existing reports', async t => {
  const {root,file,raw} = await fixture(t);
  raw.scenarios = {[id]:plan};
  await writeFile(file,JSON.stringify(raw));
  await writeFile(path.join(root,'specs','spec.md'),`#### ${id} behavior\n| PR-A-001 | ${id} | unit test | 完了 |\n`);
  const testPath = path.join(root,'tests','bp-sample.test.mjs');
  const passing = `import test from 'node:test';test('${id} @normal:ok @boundary:edge',()=>{});`;
  await writeFile(testPath,passing);
  const output = path.join(root,'reports');
  const args = ['--config',file,'--output',output];
  assert.equal((await cli(args,root)).code,0);
  const trace = JSON.parse(await readFile(path.join(output,'traceability.json'),'utf8'));
  const coverage = JSON.parse(await readFile(path.join(output,'coverage.json'),'utf8'));
  assert.equal(trace.complete,true);
  assert.equal(trace.runId,coverage.runId);
  assert.match(await readFile(path.join(output,'report.md'),'utf8'),new RegExp(trace.runId));
  const lock = path.join(output,'.traceability.lock');
  await writeFile(lock,'test-owned lock');
  const blocked = await cli(args,root);
  assert.equal(blocked.code,2);
  assert.match(blocked.stderr,/Cannot acquire output lock/);
  assert.equal(JSON.parse(await readFile(path.join(output,'traceability.json'),'utf8')).runId,trace.runId);
  await rm(lock);
  await writeFile(testPath,`${passing}test('unrelated failure',()=>{throw new Error('failed');});`);
  assert.equal((await cli(args,root)).code,1);
  assert.equal(JSON.parse(await readFile(path.join(output,'traceability.json'),'utf8')).complete,false);
  await writeFile(file,'{}');
  assert.equal((await cli(args,root)).code,2);
  await assert.rejects(readFile(path.join(output,'traceability.json')),/ENOENT/);
});


test('specification parsing excludes fenced definitions and rows while preserving source positions', async t => {
  const {root,file} = await fixture(t);
  const c = await loadConfig(file);
  const duplicate = `#### ${id} duplicate`;
  const unknownRow = '| PR-A-999 | SP-BPTEST-999 | example | invalid-example-state |';
  const valid = `#### ${id} real`;
  for (const [opening,closing] of [['```markdown','```'],['   ~~~~markdown','  ~~~~~'],[' ````','   `````']]) {
    const lines = [opening,duplicate,unknownRow,closing,valid,`| PR-A-001 | ${id} | actual | 作成中 |`];
    await writeFile(path.join(root,'specs','spec.md'),lines.join('\n'));
    const specs = await readSpecs(c);
    assert.deepEqual(Object.keys(specs),[id]);
    assert.equal(specs[id].line,5);
    assert.equal(specs[id].rows.length,1);
    assert.equal(specs[id].rows[0].line,6);
  }
});

test('fence closing requires matching character, sufficient length, allowed indentation and no suffix', async t => {
  const {root,file} = await fixture(t);
  const c = await loadConfig(file);
  for (const invalidClose of ['```','~~~~','    ````','```` suffix']) {
    const lines = ['````markdown',invalidClose,'#### SP-BPTEST-999 example','````',`#### ${id} actual`];
    await writeFile(path.join(root,'specs','spec.md'),lines.join('\n'));
    assert.deepEqual(Object.keys(await readSpecs(c)),[id]);
  }
  await writeFile(path.join(root,'specs','spec.md'),[`#### ${id} actual`,'  ~~~markdown','#### SP-BPTEST-999 example',`| PR-A-999 | SP-BPTEST-999 | example | 完了 |`].join('\n'));
  assert.deepEqual(Object.keys(await readSpecs(c)),[id]);
});
