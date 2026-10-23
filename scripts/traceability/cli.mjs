import { mkdir, writeFile, rename, rm, open } from 'node:fs/promises';
import path from 'node:path';
import { loadConfig, readSpecs, inside } from './specs.mjs';
import { normalize, evaluate } from './core.mjs';
import { runTests, coverageReport } from './runner.mjs';

async function publish(output, reports) {
  await mkdir(output,{recursive:true});
  for (const [name,content] of Object.entries(reports)) {
    const temporary = path.join(output,`.${name}.${process.pid}.tmp`);
    await writeFile(temporary,content);
    await rename(temporary,path.join(output,name));
  }
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
  const lock = await open(lockPath,'wx').catch(error => { throw new Error(`Cannot acquire output lock ${lockPath}: ${error.code}`); });
  try {
    await lock.writeFile(`${process.pid}\n`);
    for (const name of ['traceability.json','coverage.json','report.md']) await rm(path.join(output,name),{force:true});
    const config = await loadConfig(path.resolve(options.config));
    const specs = await readSpecs(config);
    const files = overrides.length ? await Promise.all(overrides.map(file => inside(config.root,path.relative(config.root,path.resolve(file))))) : config.testFiles;
    const run = await runTests(config,files);
    const result = evaluate(specs,normalize(run.events),config,options.complete,run.summary.success);
    const runId = new Date().toISOString();
    const inventory = {roots:config.discoveredRoots,specFiles:config.specFiles,testFiles:files,sourceFiles:config.sourceFiles};
    const trace = {runId,inventory,testSummary:run.summary,...result};
    const coverage = {runId,...coverageReport(config,run)};
    const lines = [`# Verification report`, '',`Run: ${runId}`,`Specifications: ${trace.specifications.length}`,`Complete: ${trace.complete}`,`Errors: ${trace.errors.length}`,`Ignored out-of-scope IDs: ${trace.ignoredIdCount}`,`Code coverage status: ${coverage.status}`,'',...trace.errors.map(error => `- ${error}`),'','| Specification | State | Passing leaves | Scenario plan | Normal | Recovery | Error | Boundary |','|---|---|---:|---|---|---|---|---|',...trace.specifications.map(spec => `| ${spec.id} | ${spec.status} | ${spec.passingLeaves} | ${spec.scenarioStatus} | ${Object.values(spec.scenarios).map(item => item.status).join(' | ')} |`),'','## Source inventory','','| Source | Measurement |','|---|---|',...coverage.files.map(file => `| ${file.file} | ${file.status}${file.reason ? `: ${file.reason}`:''} |`)];
    await publish(output,{'traceability.json':`${JSON.stringify(trace,null,2)}\n`,'coverage.json':`${JSON.stringify(coverage,null,2)}\n`,'report.md':`${lines.join('\n')}\n`});
    if (run.diagnostics) process.stderr.write(run.diagnostics);
    console.log(JSON.stringify({runId,specifications:trace.specifications.length,errors:trace.errors.length,complete:trace.complete,coverage:coverage.status,output}));
    process.exitCode=result.errors.length ? 1:0;
  } finally {
    await lock.close();
    await rm(lockPath,{force:true});
  }
}
main().catch(error => {console.error(error.message);process.exitCode=2;});
