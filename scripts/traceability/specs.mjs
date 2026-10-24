import { readFile, realpath, readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { TRACE_STATUS, outsideFences, specHeading, traceTable } from '../../tools/lib/bp-docs.mjs';

export const categories = ['normal', 'recovery', 'error', 'boundary'];
export async function inside(root, relative) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative)) throw new Error(`Expected relative path: ${relative}`);
  const resolved = await realpath(path.resolve(root, relative));
  if (!resolved.startsWith(`${root}${path.sep}`)) throw new Error(`Path escapes root: ${relative}`);
  return resolved;
}
export async function loadConfig(file) {
  const config = JSON.parse(await readFile(file, 'utf8'));
  config.root = await realpath(path.resolve(path.dirname(file), config.root ?? '.'));
  for (const key of ['specFiles', 'testFiles', 'sourceFiles']) config[key] ??= [];
  await discover(config);
  for (const key of ['specFiles', 'testFiles', 'sourceFiles', 'scopePrefixes']) {
    if (!Array.isArray(config[key]) || !config[key].length || config[key].some(x => typeof x !== 'string' || !x)) throw new Error(`Invalid ${key}`);
    if (new Set(config[key]).size !== config[key].length) throw new Error(`Duplicate ${key}`);
  }
  for (const key of ['specFiles', 'testFiles', 'sourceFiles']) for (const file of config[key]) await inside(config.root, file);
  config.tracedTestFiles = new Set(await Promise.all(config.testFiles.map(file => inside(config.root, file))));
  config.environmentSkipReason = await environmentSkipReason(config);
  config.scenarios ??= {};
  config.unmeasuredSources ??= {};
  for (const [file, reason] of Object.entries(config.unmeasuredSources)) {
    if (!config.sourceFiles.includes(file) || typeof reason !== 'string' || !reason.trim()) throw new Error(`Invalid unmeasured source ${file}`);
  }
  return config;
}
// skip を環境による未検証として許すのは、skip を出す側と同じ判定が「この環境では実行できない」と答えるときだけ（設定が無ければ許さない）。
async function environmentSkipReason(config) {
  const gate = config.environmentSkip;
  if (gate === undefined) return null;
  if (!gate || typeof gate.module !== 'string' || typeof gate.export !== 'string') throw new Error('Invalid environmentSkip');
  const decide = (await import(pathToFileURL(await inside(config.root, gate.module)).href))[gate.export];
  if (typeof decide !== 'function') throw new Error(`Invalid environmentSkip export ${gate.export}`);
  const reason = await decide();
  if (reason !== null && (typeof reason !== 'string' || !reason)) throw new Error('environmentSkip must return a reason string or null');
  return reason;
}
export async function readSpecs(config) {
  const specs = {};
  const documents = await Promise.all(config.specFiles.map(async file => ({file,text:await readFile(await inside(config.root,file), 'utf8')})));
  for (const {file,text} of documents) {
    for (const [index, line] of outsideFences(text).entries()) {
      const id = specHeading(line);
      if (!id || !config.scopePrefixes.some(prefix => id.startsWith(prefix))) continue;
      if (specs[id]) throw new Error(`Duplicate specification ${id}`);
      specs[id] = { id, file, line: index + 1, rows: [] };
    }
  }
  for (const {file,text} of documents) {
    let rows;
    try { rows = traceTable(text); } catch (error) { throw new Error(`Invalid verification table ${file}: ${error.message}`, {cause:error}); }
    for (const row of rows) {
      for (const id of row.ids.filter(id => config.scopePrefixes.some(prefix => id.startsWith(prefix)))) {
        if (!specs[id]) throw new Error(`Unknown specification ${id} at ${file}:${row.line}`);
        specs[id].rows.push({ file, line: row.line, requirement: row.req, verification: row.method, status: row.status });
      }
    }
  }
  for (const spec of Object.values(specs)) spec.status = spec.rows.length && spec.rows.every(x => x.status === TRACE_STATUS.done) ? 'complete' : spec.rows.some(x => x.status !== TRACE_STATUS.notStarted) ? 'in-progress' : 'not-started';
  validatePlans(config.scenarios, specs);
  return specs;
}
export function validatePlans(plans, specs) {
  if (!plans || typeof plans !== 'object' || Array.isArray(plans)) throw new Error('Invalid scenarios');
  for (const [id, plan] of Object.entries(plans)) {
    if (!Object.hasOwn(specs,id)) throw new Error(`Unknown scenario specification ${id}`);
    if (!plan || Object.keys(plan).some(x => !categories.includes(x))) throw new Error(`Invalid scenario categories ${id}`);
    for (const category of categories) {
      const entry = plan[category];
      if (Array.isArray(entry)) {
        if (!entry.length || entry.some(x => !x || typeof x.id !== 'string' || !/^[\w.-]+$/.test(x.id) || typeof x.expectation !== 'string' || !x.expectation.trim()) || new Set(entry.map(x => x.id)).size !== entry.length) throw new Error(`Invalid cases ${id}/${category}`);
      } else if (!entry || Object.keys(entry).length !== 1 || typeof entry.notApplicable !== 'string' || !entry.notApplicable.trim()) throw new Error(`Invalid notApplicable ${id}/${category}`);
    }
  }
}

export async function discover(config) {
  const excluded = new Set(['node_modules', '.git', 'fixtures', '__fixtures__', 'tests', '__tests__']);
  config.discoveredRoots = {};
  for (const [rootsKey, filesKey, extension] of [['specDirectories','specFiles',/\.md$/], ['testDirectories','testFiles',/\.test\.m?js$/], ['sourceDirectories','sourceFiles',/\.m?js$/]]) {
    const roots = config[rootsKey] ?? [];
    if (!Array.isArray(roots)) throw new Error(`Invalid ${rootsKey}`);
    config.discoveredRoots[rootsKey] = roots;
    const found = [];
    for (const root of roots) {
      const selector = typeof root === 'string' ? {path:root,prefix:''} : root;
      if (!selector || typeof selector.path !== 'string' || (selector.prefix !== undefined && typeof selector.prefix !== 'string')) throw new Error(`Invalid ${rootsKey} entry`);
      const base = await inside(config.root, selector.path);
      async function walk(directory) {
        for (const entry of await readdir(directory, {withFileTypes:true})) {
          const full = path.join(directory,entry.name);
          if (entry.isSymbolicLink()) throw new Error(`Inventory symlink is not supported: ${full}`);
          if (entry.isDirectory() && !excluded.has(entry.name)) await walk(full);
          else if (entry.isFile() && extension.test(entry.name) && entry.name.startsWith(selector.prefix ?? '') && !(filesKey === 'sourceFiles' && /\.test\.m?js$/.test(entry.name))) found.push(path.relative(config.root,full));
        }
      }
      await walk(base);
    }
    config[filesKey] = [...new Set([...config[filesKey],...found])].sort();
  }
}
