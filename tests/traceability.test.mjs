import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm, readFile, readdir, realpath } from 'node:fs/promises';
import os, { hostname } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { normalize, evaluate, failedTests } from '../scripts/traceability/core.mjs';
import { acquireLock, releaseLock, io } from '../scripts/traceability/lock.mjs';
import { validatePlans, loadConfig, readSpecs } from '../scripts/traceability/specs.mjs';
import { runTests, coverageReport } from '../scripts/traceability/runner.mjs';
import { specIds } from '../tools/lib/bp-docs.mjs';
import { testTitles } from './helpers/bp-docs.mjs';

const id = 'SP-BPTEST-001';
const spec = (status='完了') => ({[id]:{id,status:status === '完了' ? 'complete':'in-progress',rows:[{status,verification:'unit'}]}});
const config = (scenarios={},extra={}) => ({scopePrefixes:['SP-BP'],scenarios,tracedTestFiles:new Set(['a']),environmentSkipReason:null,...extra});
const tolerant = scenarios => config(scenarios,{environmentSkipReason:'checkout under /tmp'});
const plan = {normal:[{id:'ok',expectation:'accepted'}],recovery:{notApplicable:'No recovery path'},error:{notApplicable:'No errors'},boundary:[{id:'edge',expectation:'accepted at limit'}]};
const leaf = (status='pass',extra={}) => ({ids:[id],scenarios:[],name:'test',file:'a',status,...extra});
const TABLE = '| 要求 ID | 仕様項目 ID | 検証方法 | ステータス |\n|---|---|---|---|';

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
  assert.match(evaluate(spec(),[],config()).errors.join(),/lack passing tests/);
  assert.match(evaluate(spec(),[leaf('todo')],config()).errors.join(),/lack passing tests/);
  assert.match(evaluate(spec(),[leaf('skip'),leaf('todo')],config()).errors.join(),/lack passing tests/);
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
  await writeFile(path.join(root,'specs','spec.md'),`#### ${id} behavior\n${TABLE}\n| PR-A-001 | ${id} | unit test | 作成中 |\n`);
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
  await writeFile(path.join(root,'specs','second.md'),`#### ${id} duplicate\n${TABLE}\n`);
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
  await writeFile(path.join(root,'specs','spec.md'),`${TABLE}\n| PR-A-001 | ${id} | unit test | 作成中 |`);
  await writeFile(path.join(root,'specs','z-definition.md'),`#### ${id} behavior\n${TABLE}\n`);
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

const CLI = fileURLToPath(new URL('../scripts/traceability/cli.mjs',import.meta.url));

function cli(args,cwd) {
  return new Promise((resolve,reject) => {
    const child = spawn(process.execPath,[CLI,...args],{cwd,env:{...process.env,NODE_TEST_CONTEXT:''}});
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
  await writeFile(path.join(root,'specs','spec.md'),`#### ${id} behavior\n${TABLE}\n| PR-A-001 | ${id} | unit test | 完了 |\n`);
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
  assert.match(blocked.stderr,/Cannot acquire output lock .*held by an unrecognized owner.*delete .*\.traceability\.lock and rerun/);
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
    const lines = [opening,duplicate,TABLE,unknownRow,closing,valid,TABLE,`| PR-A-001 | ${id} | actual | 作成中 |`];
    await writeFile(path.join(root,'specs','spec.md'),lines.join('\n'));
    const specs = await readSpecs(c);
    assert.deepEqual(Object.keys(specs),[id]);
    assert.equal(specs[id].line,7);
    assert.equal(specs[id].rows.length,1);
    assert.equal(specs[id].rows[0].line,10);
  }
});

test('fence closing requires matching character, sufficient length, allowed indentation and no suffix', async t => {
  const {root,file} = await fixture(t);
  const c = await loadConfig(file);
  for (const invalidClose of ['```','~~~~','    ````','```` suffix']) {
    const lines = ['````markdown',invalidClose,'#### SP-BPTEST-999 example','````',`#### ${id} actual`,TABLE];
    await writeFile(path.join(root,'specs','spec.md'),lines.join('\n'));
    assert.deepEqual(Object.keys(await readSpecs(c)),[id]);
  }
  await writeFile(path.join(root,'specs','spec.md'),[`#### ${id} actual`,TABLE,'  ~~~markdown','#### SP-BPTEST-999 example',`| PR-A-999 | SP-BPTEST-999 | example | 完了 |`].join('\n'));
  assert.deepEqual(Object.keys(await readSpecs(c)),[id]);
});

const pass = name => normalize([{type:'test:pass',data:{testId:1,parentId:0,name,nesting:0,file:'a'}}]);

test('test titles and the trace-status check expand ID ranges with one function, so the inner ID of a range is linked', () => {
  const expected = ['SP-BPCONFORMANCE-027','SP-BPCONFORMANCE-028','SP-BPCONFORMANCE-029','SP-BPCONFORMANCE-030','SP-BPCONFORMANCE-031','SP-BPCONFORMANCE-036'];
  const title = testTitles(fileURLToPath(new URL('./bp-spelling.test.mjs',import.meta.url))).find(x => x.includes('SP-BPCONFORMANCE-027〜031'));
  assert.deepEqual(specIds(title),expected);
  const [linked] = pass(title);
  assert.deepEqual(linked.ids,expected);
  const specs = Object.fromEntries(expected.map(x => [x,{id:x,status:'complete',rows:[{status:'完了'}]}]));
  const result = evaluate(specs,[linked],config({},{scopePrefixes:['SP-BPCONFORMANCE']}));
  assert.deepEqual(result.errors,[]);
  assert.equal(result.specifications.find(x => x.id === 'SP-BPCONFORMANCE-030').traceStatus,'pass');
  assert.match(evaluate(spec('作成中'),pass('SP-BPTEST-001〜SP-BPOTHER-003'),config()).errors.join(),/Invalid specification reference \(範囲の両端の接頭辞が違う/);
  assert.match(evaluate(spec('作成中'),pass('SP-BPTEST-003〜001'),config()).errors.join(),/Invalid specification reference/);
});

test('ID ranges name every ID between both ends, across the explicit-prefix form, and reject mismatched prefixes', () => {
  assert.deepEqual(specIds('SP-BPCONFORMANCE-027〜029・SP-BPRUN-011〜SP-BPRUN-012 と SP-BPRUN-040'),
    ['SP-BPCONFORMANCE-027','SP-BPCONFORMANCE-028','SP-BPCONFORMANCE-029','SP-BPRUN-011','SP-BPRUN-012','SP-BPRUN-040']);
  assert.throws(() => specIds('SP-BPRUN-011〜SP-BPFINDINGS-013'),/接頭辞が違う/);
  assert.throws(() => specIds('SP-BPRUN-013〜011'),/終わりが始まりより前/);
});

test('skip-only evidence is unverified: tolerated in a normal run only when the environment gate names a reason, always rejected by completion', () => {
  const adopted = tolerant({[id]:plan});
  const annotated = {scenarios:[{category:'normal',id:'ok'},{category:'boundary',id:'edge'}],skipReason:'skipped: checkout under /tmp'};
  const normal = evaluate(spec(),[leaf('skip',annotated)],adopted);
  assert.deepEqual(normal.errors,[]);
  assert.equal(normal.complete,false);
  assert.deepEqual(normal.unverified.map(x => x.id),[id]);
  assert.equal(normal.specifications[0].traceStatus,'skipped');
  assert.equal(normal.specifications[0].scenarioStatus,'skipped');
  assert.deepEqual(normal.specifications[0].scenarios.normal.cases.map(x => x.status),['skipped']);
  assert.match(evaluate(spec(),[leaf('skip',annotated)],adopted,true).errors.join(),/Completion gate rejects skipped tests/);
  const mixed = [leaf('pass',{...annotated,skipReason:undefined}),leaf('skip',annotated)];
  assert.deepEqual(evaluate(spec(),mixed,adopted).errors,[]);
  assert.equal(evaluate(spec(),mixed,adopted).complete,false);
  assert.match(evaluate(spec(),mixed,adopted,true).errors.join(),/Completion gate rejects skipped tests/);
  assert.match(evaluate(spec(),[leaf('skip',{scenarios:[{category:'normal',id:'ok'}],skipReason:annotated.skipReason})],adopted).errors.join(),/lack planned scenarios/);
  const strict = config({[id]:plan});
  const rejected = evaluate(spec(),[leaf('skip',annotated)],strict);
  assert.deepEqual(rejected.errors,[`Completed verification rows have skipped tests without the environment gate reason: ${id}: test`]);
  assert.deepEqual(rejected.unverified.map(x => x.id),[id]);
  assert.match(evaluate(spec(),mixed,strict).errors.join(),/skipped tests without the environment gate reason/);
  assert.deepEqual(evaluate(spec('作成中'),mixed,strict).errors,[]);
  assert.deepEqual(evaluate(spec('未着手'),[leaf('skip',{skipReason:true})],strict).errors,[]);
  assert.deepEqual(evaluate(spec('未着手'),[leaf('skip',{skipReason:'needs systemd'})],adopted).errors,[]);
});

test('only tests in the configured test files are traced; others naming in-scope IDs are listed, not linked', () => {
  const outside = leaf('pass',{file:'b',ids:['SP-BPTEST-999'],name:'outside'});
  const result = evaluate(spec(),[outside],config());
  assert.deepEqual(result.untracedTests,['outside']);
  assert.match(result.errors.join(),/lack passing tests/);
  assert.doesNotMatch(result.errors.join(),/Unknown specification/);
});

test('annotations are checked against planned IDs, so one execution can also trace unplanned specifications', () => {
  const other = 'SP-BPTEST-002';
  const specs = {...spec(),[other]:{id:other,status:'in-progress',rows:[{status:'作成中'}]}};
  const shared = leaf('pass',{ids:[id,other],scenarios:[{category:'normal',id:'ok'}]});
  const result = evaluate(specs,[shared],config({[id]:plan}));
  assert.equal(result.errors.filter(x => /Unknown scenario/.test(x)).length,0);
  assert.equal(result.specifications.find(x => x.id === other).traceStatus,'pass');
  assert.match(evaluate(specs,[leaf('pass',{ids:[other],scenarios:[{category:'normal',id:'ok'}]})],config({[id]:plan})).errors.join(),/Unknown scenario SP-BPTEST-002/);
  assert.match(evaluate(specs,[leaf('pass',{ids:[id,other],scenarios:[{category:'normal',id:'typo'}]})],config({[id]:plan})).errors.join(),/Unknown scenario SP-BPTEST-001/);
});

test('summary states the planned part beside the whole scope', () => {
  const other = 'SP-BPTEST-002';
  const specs = {...spec(),[other]:{id:other,status:'not-started',rows:[{status:'未着手'}]}};
  const result = evaluate(specs,[leaf('pass',{scenarios:[{category:'normal',id:'ok'}]})],config({[id]:plan}));
  assert.deepEqual(result.summary,{specifications:2,specificationsMarkedDone:1,planned:1,plannedPassing:0,cases:{total:2,passed:1,skipped:0},unverified:0,untracedTests:0});
});

test('CLI names failed leaf tests outside the specification scope, with their cause, in stderr and every report', async t => {
  const {root,file} = await fixture(t);
  await writeFile(path.join(root,'tests','bp-sample.test.mjs'),"import test from 'node:test';import assert from 'node:assert/strict';test('unrelated helper behaves',()=>assert.equal(1,2));test('outer group',async t=>{await t.test('nested unrelated leaf',()=>{throw new Error('nested cause');});});\n");
  const output = path.join(root,'reports');
  const result = await cli(['--config',file,'--output',output],root);
  assert.equal(result.code,1);
  assert.equal(JSON.parse(result.stdout).failures,2);
  const trace = JSON.parse(await readFile(path.join(output,'traceability.json'),'utf8'));
  assert.deepEqual(trace.failures.map(x => x.name).sort(),['outer group > nested unrelated leaf','unrelated helper behaves']);
  const report = await readFile(path.join(output,'report.md'),'utf8');
  for (const [name,cause] of [['unrelated helper behaves','1 !== 2'],['nested unrelated leaf','nested cause']]) {
    assert.match(result.stderr,new RegExp(`FAIL [^\n]*${name}\n[\\s\\S]*?${cause}`));
    assert.ok(trace.failures.find(x => x.name.endsWith(name)).error.message.includes(cause));
    assert.ok(report.includes(name) && report.includes(cause));
  }
});

test('a lock left by a run killed with a signal is reclaimed by the next run; a live or foreign owner keeps it', async t => {
  const {root,file} = await fixture(t);
  const testPath = path.join(root,'tests','bp-sample.test.mjs');
  await writeFile(testPath,"import test from 'node:test';test('slow',()=>new Promise(r=>setTimeout(r,3000)));\n");
  const output = path.join(root,'reports');
  const lock = path.join(output,'.traceability.lock');
  const args = ['--config',file,'--output',output];
  const child = spawn(process.execPath,[CLI,...args],{cwd:root,env:{...process.env,NODE_TEST_CONTEXT:''},stdio:'ignore'});
  let exited = false;
  const closed = new Promise(resolve => child.on('close',() => { exited = true; resolve(); }));
  while (!/^\d+ /.test(await readFile(lock,'utf8').catch(() => ''))) {
    assert.equal(exited,false);
    await new Promise(resolve => setTimeout(resolve,20));
  }
  child.kill('SIGKILL');
  await closed;
  assert.match(await readFile(lock,'utf8'),new RegExp(`^${child.pid} `));
  await writeFile(testPath,`import test from 'node:test';test('${id}',()=>{});\n`);
  const rerun = await cli(args,root);
  assert.equal(rerun.code,0,rerun.stderr);
  await assert.rejects(readFile(lock),/ENOENT/);
  for (const [owner,holder] of [[`${process.pid} ${hostname()} live\n`,`PID ${process.pid} on ${hostname()}`],[`${child.pid} foreign.invalid x\n`,`PID ${child.pid} on foreign.invalid`]]) {
    await writeFile(lock,owner);
    const blocked = await cli(args,root);
    assert.equal(blocked.code,2);
    assert.ok(blocked.stderr.includes(`held by ${holder}. If that process has exited, delete ${lock} and rerun.`),blocked.stderr);
    assert.equal(await readFile(lock,'utf8'),owner);
  }
});

test('failures include a parent failing on its own code or hook and a file-level hook, but not parents failing only through children, cancelled children or todo tests', async t => {
  const {root,file} = await fixture(t);
  const testFile = path.join(root,'tests','bp-sample.test.mjs');
  await writeFile(testFile,`import test, { after } from 'node:test';
test('outer own', async t => { await t.test('inner ok', () => {}); throw new Error('outer cause'); });
test('outer children', async t => { await t.test('inner bad', () => { throw new Error('inner cause'); }); });
test('hooked', async t => { t.after(() => { throw new Error('hook cause'); }); await t.test('child', () => {}); });
test('cancelling', async t => { t.test('cancelled child', () => new Promise(r => setTimeout(r, 200))); throw new Error('cancelling cause'); });
test('timed out', { timeout: 50 }, async t => { t.test('slow child', () => new Promise(r => setTimeout(r, 500))); });
test('todo', { todo: true }, () => { throw new Error('todo cause'); });
after(() => { throw new Error('file hook cause'); });
`);
  const c = await loadConfig(file);
  const failures = failedTests((await runTests(c,c.testFiles)).events);
  const fileLevel = path.join(c.root,'tests','bp-sample.test.mjs');
  assert.deepEqual(failures.map(x => x.name).sort(),['cancelling','hooked','outer children > inner bad','outer own','timed out',fileLevel].sort());
  const byName = Object.fromEntries(failures.map(x => [x.name,x.error.message]));
  for (const [name,cause] of [['outer own','outer cause'],['outer children > inner bad','inner cause'],['hooked','hook cause'],['cancelling','cancelling cause'],['timed out','timed out after 50ms'],[fileLevel,'file hook cause']]) assert.match(byName[name],new RegExp(cause));
});

// 取り消しの組み合わせを、testId を持つ列（現行の Node）と、testId を持たず test:start の入れ子で親を決める列（Node 22 の文書の形）の両方で通す。
// Node 22 では親が待たなかった子が取り消され、親は subtestsFailed か pass で終わる（Node 22 の文書と実装の読みによる。Node 22 での実行は未確認）。
const CANCELLED = {failureType:'cancelledByParent',message:'test did not finish before its parent and was cancelled'};
const TIMEOUT = {failureType:'testTimeoutFailure',message:'timed out'};
const SUBTESTS = {failureType:'subtestsFailed',message:'1 subtest failed'};
const CANCELLATIONS = [
  {chain:[['parent',SUBTESTS],['child',CANCELLED]],expected:['parent > child']},
  {chain:[['parent',null],['child',CANCELLED]],expected:['parent > child']},
  {chain:[['pending top',CANCELLED]],expected:['pending top']},
  {chain:[['pending parent',CANCELLED],['pending child',CANCELLED]],expected:['pending parent']},
  {chain:[['parent',TIMEOUT],['child',CANCELLED]],expected:['parent']},
  {chain:[['parent',TIMEOUT],['child',CANCELLED]],expected:['parent'],parentFirst:true},
  {chain:[['grandparent',TIMEOUT],['parent',CANCELLED],['child',CANCELLED]],expected:['grandparent']},
  {chain:[['grandparent',CANCELLED],['parent',CANCELLED],['child',CANCELLED]],expected:['grandparent']},
  {chain:[['grandparent',SUBTESTS],['parent',CANCELLED],['child',CANCELLED]],expected:['grandparent > parent']},
  {chain:[['g',TIMEOUT],['p',null],['q',CANCELLED],['r',CANCELLED]],expected:['g','g > p > q']},
  {chain:[['g',TIMEOUT],['p',SUBTESTS],['q',CANCELLED]],expected:['g','g > p > q']},
  {chain:[['g',null],['p',TIMEOUT],['q',CANCELLED],['r',CANCELLED]],expected:['g > p']},
];
const result = (name,nesting,error,ids) => ({type:error ? 'test:fail':'test:pass',data:{...ids,name,nesting,file:'a',...(error && {details:{error}})}});
function modern({chain,parentFirst}) {
  const ids = nesting => ({testId:nesting + 1,parentId:nesting});
  const results = chain.map(([name,error],nesting) => result(name,nesting,error,ids(nesting)));
  return [...chain.map(([name],nesting) => ({type:'test:enqueue',data:{...ids(nesting),name,nesting,file:'a'}})),...(parentFirst ? results : results.toReversed())];
}
function legacy({chain,parentFirst}) {
  const results = chain.map(([name,error],nesting) => result(name,nesting,error,{}));
  return [...chain.map(([name],nesting) => ({type:'test:start',data:{name,nesting,file:'a'}})),...(parentFirst ? results : results.toReversed())];
}

test('a cancellation is reported once: dropped when any reported ancestor failure explains it, kept otherwise, in both event shapes', () => {
  for (const shape of [modern,legacy]) {
    for (const item of CANCELLATIONS) assert.deepEqual(failedTests(shape(item)).map(x => x.name),item.expected,`${shape.name}: ${JSON.stringify(item.chain)}`);
  }
});

// test:start の入れ子で親を決められない取り消しは、取りこぼすより二重に数える側に倒して載せる。
test('a legacy cancellation whose parent cannot be determined is reported on its own', () => {
  assert.deepEqual(failedTests([result('orphan',1,CANCELLED,{})]).map(x => x.name),['orphan']);
  const late = [{type:'test:start',data:{name:'parent',nesting:0,file:'a'}},result('parent',0,TIMEOUT,{}),{type:'test:start',data:{name:'late child',nesting:1,file:'a'}},result('late child',1,CANCELLED,{})];
  assert.deepEqual(failedTests(late).map(x => x.name),['parent','late child']);
});

test('CLI keeps every test diagnostic, including the cause of asynchronous errors after a test ended', async t => {
  const {root,file} = await fixture(t);
  await writeFile(path.join(root,'tests','bp-sample.test.mjs'),"import test from 'node:test';test('late',()=>{setTimeout(()=>{throw new Error('late uncaught cause');},20);});test('late rejection',()=>{setTimeout(()=>{Promise.reject(new Error('late rejection cause'));},20);});\n");
  const output = path.join(root,'reports');
  const result = await cli(['--config',file,'--output',output],root);
  const trace = JSON.parse(await readFile(path.join(output,'traceability.json'),'utf8'));
  const report = await readFile(path.join(output,'report.md'),'utf8');
  for (const cause of ['late uncaught cause','late rejection cause']) {
    assert.match(result.stderr,new RegExp(`DIAGNOSTIC [^\n]*${cause}`));
    assert.ok(trace.notes.some(note => note.message.includes(cause)));
    assert.ok(report.includes(cause));
  }
  assert.equal(trace.notes.length,JSON.parse(result.stdout).diagnostics);
});

test('environment skip gate is resolved from the configured module and rejects a malformed gate', async t => {
  const {root,file,raw} = await fixture(t);
  const outside = await mkdtemp(path.join(os.tmpdir(),'traceability-outside-'));
  t.after(() => rm(outside,{recursive:true,force:true}));
  await writeFile(path.join(outside,'gate.mjs'),"export const reason = () => 'outside';\n");
  await writeFile(path.join(root,'src','gate.mjs'),"export const reason = () => 'checkout under a cleaned directory';\nexport const broken = () => '';\nexport const notFunction = 1;\n");
  assert.equal((await loadConfig(file)).environmentSkipReason,null);
  await writeFile(file,JSON.stringify({...raw,environmentSkip:{module:'src/gate.mjs',export:'reason'}}));
  assert.equal((await loadConfig(file)).environmentSkipReason,'checkout under a cleaned directory');
  for (const [gate,reason] of [
    [{module:'src/gate.mjs',export:'broken'},/environmentSkip must return a reason string or null/],
    [{module:'src/gate.mjs',export:'notFunction'},/Invalid environmentSkip export notFunction/],
    [{module:path.relative(await realpath(root),path.join(await realpath(outside),'gate.mjs')),export:'reason'},/Path escapes root/],
    [{module:'src/gate.mjs'},{message:'Invalid environmentSkip'}],
  ]) {
    await writeFile(file,JSON.stringify({...raw,environmentSkip:gate}));
    await assert.rejects(loadConfig(file),reason);
  }
});

test('only skips carrying the reason the gate returns are tolerated; any other skip on a completed row fails', () => {
  const reason = 'checkout under /tmp';
  const adopted = config({[id]:plan},{environmentSkipReason:reason});
  const annotated = {scenarios:[{category:'normal',id:'ok'},{category:'boundary',id:'edge'}]};
  const environmental = leaf('skip',{...annotated,skipReason:`end-to-end root rejected: ${reason}`});
  assert.deepEqual(evaluate(spec(),[environmental],adopted).errors,[]);
  const passing = leaf('pass',{...annotated,name:'passing sibling'});
  for (const other of [leaf('skip',{...annotated,name:'unexplained',skipReason:true}),leaf('skip',{...annotated,name:'unexplained',skipReason:'needs systemd'})]) {
    for (const tests of [[other],[environmental,other],[passing,other],[passing,environmental,other]]) {
      const errors = evaluate(spec(),tests,adopted).errors;
      assert.deepEqual(errors.filter(x => /without the environment gate reason/.test(x)),[`Completed verification rows have skipped tests without the environment gate reason: ${id}: unexplained`]);
    }
    assert.deepEqual(evaluate(spec(),[passing,leaf('skip',{name:'case-free',skipReason:true})],adopted).errors,[`Completed verification rows have skipped tests without the environment gate reason: ${id}: case-free`]);
  }
  assert.deepEqual(evaluate(spec(),[passing,environmental],adopted).errors,[]);
  assert.deepEqual(evaluate(spec(),[environmental],config({[id]:plan})).errors,[`Completed verification rows have skipped tests without the environment gate reason: ${id}: test`]);
});

test('the repository gate is the same function the end-to-end harness uses to skip, and its skip carries the gate reason', async () => {
  const raw = JSON.parse(await readFile(fileURLToPath(new URL('../traceability.config.json',import.meta.url)),'utf8'));
  const harness = await import(new URL(`../${raw.environmentSkip.module}`,import.meta.url).href);
  const c = await loadConfig(fileURLToPath(new URL('../traceability.config.json',import.meta.url)));
  assert.equal(c.environmentSkipReason,harness.environmentSkipReason());
  let skipped = null;
  const root = harness.stateRoot({skip: reason => { skipped = reason; },after: () => {}});
  assert.equal(root === null,c.environmentSkipReason !== null);
  if (skipped) assert.ok(skipped.includes(c.environmentSkipReason));
});

async function lockDir(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(),'traceability-lock-'));
  t.after(() => rm(dir,{recursive:true,force:true}));
  return path.join(dir,'.traceability.lock');
}

const DEAD = 999999;
const killing = (codes = {[DEAD]:'ESRCH'}) => (pid) => { if (codes[pid]) throw Object.assign(new Error(codes[pid]),{code:codes[pid]}); };
const leftovers = async lock => (await readdir(path.dirname(lock))).filter(name => name !== path.basename(lock));

test('concurrent runs on a stale lock: exactly one reclaims it, the others see the live owner, and no draft or recovery file remains', async t => {
  const lock = await lockDir(t);
  await writeFile(lock,`${DEAD} ${hostname()} dead\n`);
  const fs = {...io,kill:killing()};
  const results = await Promise.allSettled([1,2,3,4].map(() => acquireLock(lock,fs)));
  const won = results.filter(x => x.status === 'fulfilled');
  assert.equal(won.length,1);
  assert.equal(await readFile(lock,'utf8'),won[0].value);
  for (const lost of results.filter(x => x.status === 'rejected')) assert.match(lost.reason.message,new RegExp(`held by PID ${process.pid} on`));
  assert.deepEqual(await leftovers(lock),[]);
  await releaseLock(lock,won[0].value);
  await assert.rejects(readFile(lock),/ENOENT/);
});

test('a run killed during acquisition leaves a draft and a recovery file with its PID; the next run removes both and reclaims the lock', async t => {
  const lock = await lockDir(t);
  await writeFile(lock,`${DEAD} ${hostname()} dead\n`);
  await writeFile(`${lock}.${DEAD}.draft.tmp`,`${DEAD} ${hostname()} draft\n`);
  await writeFile(`${lock}.reclaim-0000000000000000`,`${DEAD} ${hostname()} reclaimer\n`);
  await writeFile(`${lock}.4242.live.tmp`,`4242 ${hostname()} live draft\n`);
  const token = await acquireLock(lock,{...io,kill:killing()});
  assert.deepEqual(await leftovers(lock),[`.traceability.lock.4242.live.tmp`]);
  await releaseLock(lock,token);
});

test('lock acquisition retries a vanished lock, treats EPERM as alive, rethrows other kill errors, and names a live recovery holder when recovery never finishes', async t => {
  const lock = await lockDir(t);
  let vanish = true;
  const vanishing = {...io,readFile: async (...args) => { if (vanish && args[0] === lock) { vanish = false; await rm(lock,{force:true}); } return io.readFile(...args); }};
  await writeFile(lock,`${DEAD} ${hostname()} other\n`);
  const token = await acquireLock(lock,vanishing);
  assert.match(token,new RegExp(`^${process.pid} `));
  await releaseLock(lock,token);
  await writeFile(lock,`4242 ${hostname()} permission\n`);
  await assert.rejects(acquireLock(lock,{...io,kill:killing({4242:'EPERM'})}),new RegExp(`held by PID 4242 on ${hostname()}\\. If that process has exited, delete .*\\.traceability\\.lock and rerun`));
  await assert.rejects(acquireLock(lock,{...io,kill:killing({4242:'EINVAL'})}),/EINVAL/);
  await writeFile(lock,`${DEAD} ${hostname()} dead\n`);
  const busy = {...io,kill:killing(),sleep:async () => {},
    link:(from,to) => to.includes('.reclaim-') ? Promise.reject(Object.assign(new Error('exists'),{code:'EEXIST'})) : io.link(from,to),
    readFile:(file,...rest) => file.includes('.reclaim-') ? Promise.resolve(`${process.pid} ${hostname()} live reclaimer\n`) : io.readFile(file,...rest)};
  await assert.rejects(acquireLock(lock,busy),new RegExp(`stale-lock recovery did not finish in \\d+ attempts \\(.*\\.reclaim-[0-9a-f]+ held by PID ${process.pid} on`));
  assert.equal(await readFile(lock,'utf8'),`${DEAD} ${hostname()} dead\n`);
  assert.deepEqual(await leftovers(lock),[]);
});
