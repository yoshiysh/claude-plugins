import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function collect(command, args, options) {
  return new Promise((resolve,reject) => {
    const child = spawn(command,args,{...options,shell:false,stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='';
    child.stdout.on('data',chunk => stdout+=chunk);
    child.stderr.on('data',chunk => stderr+=chunk);
    child.on('error',reject);
    child.on('close',(code,signal) => resolve({code,signal,stdout,stderr}));
  });
}
export async function runTests(config, files) {
  const help = await collect(process.execPath,['--help'],{});
  const includeAll = help.stdout.includes('--test-coverage-include-all');
  const args = ['--test','--experimental-test-coverage','--test-reporter',fileURLToPath(new URL('./reporter.mjs',import.meta.url))];
  if (includeAll) args.push('--test-coverage-include-all');
  for (const file of config.sourceFiles) if (!config.unmeasuredSources[file]) args.push(`--test-coverage-include=${file.replaceAll('\\','/')}`);
  args.push(...files);
  const env = {...process.env};
  delete env.NODE_TEST_CONTEXT;
  const result = await collect(process.execPath,args,{cwd:config.root,env});
  const events = [];
  for (const line of result.stdout.split('\n').filter(Boolean)) {
    try { events.push(JSON.parse(line)); } catch { throw new Error('Malformed or incomplete test reporter stream'); }
  }
  const summary = events.findLast(event => event.type === 'test:summary' && !event.data.file)?.data;
  if (result.signal || result.code === null || !summary || ![0,1].includes(result.code)) throw new Error(`Test runner incomplete: ${result.signal ?? result.code}; ${result.stderr}`);
  if ((result.code === 0) !== summary.success) throw new Error('Test runner exit/summary mismatch');
  const diagnostics = events.filter(x => ['test:stderr','test:stdout'].includes(x.type)).map(x => x.data.message).join('');
  return {events,summary,includeAll,diagnostics:`${result.stderr}${diagnostics}`};
}
export function coverageReport(config, run) {
  const summary = run.events.findLast(event => event.type === 'test:coverage')?.data.summary;
  if (!summary) throw new Error('Coverage summary missing');
  const files = config.sourceFiles.map(file => {
    if (config.unmeasuredSources[file]) return {file,status:'unmeasured',reason:config.unmeasuredSources[file]};
    const measured = summary.files.find(entry => path.resolve(config.root,entry.path) === path.resolve(config.root,file));
    return measured ? {...measured,file,status:measured.coveredLineCount === 0 ? 'zero-covered':'measured'} : {file,status:'unloaded'};
  });
  const measured = files.filter(file => ['measured','zero-covered'].includes(file.status));
  const counts = {};
  for (const metric of ['Line','Branch','Function']) {
    const total = measured.reduce((sum,file) => sum+(file[`total${metric}Count`] ?? 0),0);
    const covered = measured.reduce((sum,file) => sum+(file[`covered${metric}Count`] ?? 0),0);
    counts[metric.toLowerCase()] = {total,covered,percent:total ? covered/total*100:null};
  }
  return {includeAllSupported:run.includeAll,status:files.some(file => ['unmeasured','unloaded'].includes(file.status)) ? 'partial':'measured',files,counts,
    note:'Coverage measures execution, not assertions or scenario sufficiency. Explicit unmeasured sources are outside the percentages but remain in the inventory.'};
}
