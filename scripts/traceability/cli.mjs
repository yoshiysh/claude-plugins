import { mkdir, writeFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { loadConfig, readSpecs, inside } from './specs.mjs';
import { normalize, evaluate, failedTests } from './core.mjs';
import { acquireLock, releaseLock } from './lock.mjs';
import { runTests, coverageReport } from './runner.mjs';

async function publish(output, reports) {
  await mkdir(output,{recursive:true});
  for (const [name,content] of Object.entries(reports)) {
    const temporary = path.join(output,`.${name}.${process.pid}.tmp`);
    await writeFile(temporary,content);
    await rename(temporary,path.join(output,name));
  }
}

function report(trace, coverage) {
  const s = trace.summary;
  return [`# Verification report`, '',`Run: ${trace.runId}`,`Specifications: ${s.specifications} (every verification row marked 完了: ${s.specificationsMarkedDone})`,
    `Scenario plans: ${s.planned} / ${s.specifications} specifications planned, ${s.plannedPassing} passing; cases passed ${s.cases.passed} / ${s.cases.total}, skipped ${s.cases.skipped}`,
    `Complete: ${trace.complete}`,`Errors: ${trace.errors.length}`,`Failed tests: ${s.failures}`,`Test diagnostics: ${trace.notes.length}`,
    `Unverified (skipped) specifications: ${s.unverified}`,`Environment skip gate reason: ${trace.environmentSkipReason ?? 'none (no skip is tolerated)'}`,`Tests outside the traced test files naming in-scope IDs: ${s.untracedTests}`,
    `Ignored out-of-scope IDs: ${trace.ignoredIdCount}`,`Code coverage status: ${coverage.status}`,'',...trace.errors.map(error => `- ${error}`),
    ...(trace.failures.length ? ['','## Failed tests','',...trace.failures.flatMap(failure => [`### ${failure.file}`,'',`Test: ${failure.name}`,'','~~~text',failure.error?.message ?? '','~~~',''])] : []),
    ...(trace.notes.length ? ['','## Test diagnostics','',...trace.notes.flatMap(note => [`### ${note.file ? `${note.file}:${note.line ?? ''}` : '(run)'}`,'','~~~text',note.message,'~~~',''])] : []),
    ...(trace.untracedTests.length ? ['','## Tests outside the traced test files','',...trace.untracedTests.map(name => `- ${name}`)] : []),
    ...(trace.unverified.length ? ['','## Unverified (skipped)','','| Specification | Skipped leaves | Environmental skips | Passing leaves | Trace | Scenario plan |','|---|---:|---:|---:|---|---|',...trace.unverified.map(spec => `| ${spec.id} | ${spec.skippedLeaves} | ${spec.environmentalSkips} | ${spec.passingLeaves} | ${spec.traceStatus} | ${spec.scenarioStatus} |`)] : []),
    '','## Specifications','','| Specification | State | Passing leaves | Skipped leaves | Trace | Scenario plan | Normal | Recovery | Error | Boundary |','|---|---|---:|---:|---|---|---|---|---|---|',
    ...trace.specifications.map(spec => `| ${spec.id} | ${spec.status} | ${spec.passingLeaves} | ${spec.skippedLeaves} | ${spec.traceStatus} | ${spec.scenarioStatus} | ${Object.values(spec.scenarios).map(item => item.status).join(' | ')} |`),
    '','## Source inventory','','| Source | Measurement |','|---|---|',...coverage.files.map(file => `| ${file.file} | ${file.status}${file.reason ? `: ${file.reason}`:''} |`)].join('\n');
}

async function main() {
  const args = process.argv.slice(2);
  const separator = args.indexOf('--');
  const overrides = separator < 0 ? [] : args.splice(separator).slice(1);
  const options = {};
  for (let i=0;i<args.length;i++) {
    if (args[i] === '--complete') options.complete=true;
    else if (['--config','--output'].includes(args[i]) && args[i+1]) options[args[i].slice(2)] = args[++i];
    else throw new Error(`Unknown or missing argument ${args[i]}`);
  }
  if (!options.config || !options.output) throw new Error('Usage: node scripts/traceability/cli.mjs --config <json> --output <directory> [--complete] [-- testfile...]');
  const output = path.resolve(options.output);
  await mkdir(output,{recursive:true});
  const lockPath = path.join(output,'.traceability.lock');
  const token = await acquireLock(lockPath);
  try {
    for (const name of ['traceability.json','coverage.json','report.md']) await rm(path.join(output,name),{force:true});
    const config = await loadConfig(path.resolve(options.config));
    const specs = await readSpecs(config);
    const files = overrides.length ? await Promise.all(overrides.map(file => inside(config.root,path.relative(config.root,path.resolve(file))))) : config.testFiles;
    const run = await runTests(config,files);
    const result = evaluate(specs,normalize(run.events),config,options.complete,run.summary.success);
    const runId = new Date().toISOString();
    const inventory = {roots:config.discoveredRoots,specFiles:config.specFiles,testFiles:files,sourceFiles:config.sourceFiles};
    const failures = failedTests(run.events);
    const trace = {runId,inventory,testSummary:run.summary,...result,failures,notes:run.notes,summary:{...result.summary,failures:failures.length}};
    const coverage = {runId,...coverageReport(config,run)};
    await publish(output,{'traceability.json':`${JSON.stringify(trace,null,2)}\n`,'coverage.json':`${JSON.stringify(coverage,null,2)}\n`,'report.md':`${report(trace,coverage)}\n`});
    if (run.diagnostics) process.stderr.write(run.diagnostics);
    for (const failure of trace.failures) process.stderr.write(`FAIL ${failure.file}: ${failure.name}\n${failure.error?.message ?? ''}\n\n`);
    for (const note of trace.notes) process.stderr.write(`DIAGNOSTIC ${note.file ? `${note.file}:${note.line ?? ''}` : '(run)'} ${note.message}\n`);
    for (const error of trace.errors) process.stderr.write(`ERROR ${error}\n`);
    if (trace.unverified.length) process.stderr.write(`UNVERIFIED ${trace.unverified.length} specifications have skipped tests (not counted as passing; skips carrying the environment gate reason are tolerated in a normal run: ${trace.environmentSkipReason ?? 'none'}); see ${path.join(output,'report.md')}\n`);
    console.log(JSON.stringify({runId,specifications:trace.specifications.length,errors:trace.errors.length,failures:trace.failures.length,diagnostics:trace.notes.length,unverified:trace.unverified.length,complete:trace.complete,coverage:coverage.status,output}));
    process.exitCode=result.errors.length ? 1:0;
  } finally {
    await releaseLock(lockPath,token);
  }
}
main().catch(error => {console.error(error.message);process.exitCode=2;});
