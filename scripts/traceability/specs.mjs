import { readFile, realpath, readdir } from 'node:fs/promises';
import path from 'node:path';

export const categories = ['normal', 'recovery', 'error', 'boundary'];
export const idPattern = /SP-[A-Z][A-Z0-9]*-\d+/g;
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
  config.scenarios ??= {};
  config.unmeasuredSources ??= {};
  for (const [file, reason] of Object.entries(config.unmeasuredSources)) {
    if (!config.sourceFiles.includes(file) || typeof reason !== 'string' || !reason.trim()) throw new Error(`Invalid unmeasured source ${file}`);
  }
  return config;
}
function outsideFences(markdown) {
  let fence;
  return markdown.split('\n').map(line => {
    if (fence) {
      const close = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*\r?$/);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) fence = undefined;
      return '';
    }
    const open = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (open && !(open[1][0] === '`' && open[2].includes('`'))) {
      fence = open[1];
      return '';
    }
    return line;
  });
}
export async function readSpecs(config) {
  const specs = {};
  const documents = await Promise.all(config.specFiles.map(async file => ({file,lines:outsideFences(await readFile(await inside(config.root,file), 'utf8'))})));
  for (const {file,lines} of documents) {
    for (const [index, line] of lines.entries()) {
      const match = line.match(/^#{1,6}\s+(SP-[A-Z][A-Z0-9]*-\d+)\b/);
      if (!match || !config.scopePrefixes.some(prefix => match[1].startsWith(prefix))) continue;
      if (specs[match[1]]) throw new Error(`Duplicate specification ${match[1]}`);
      specs[match[1]] = { id: match[1], file, line: index + 1, rows: [] };
    }
  }
  for (const {file,lines} of documents) {
    for (const [index, line] of lines.entries()) {
      if (!line.startsWith('|') || !line.includes('PR-')) continue;
      const cells = line.split('|').slice(1, -1).map(x => x.trim());
      if (cells.length < 4) continue;
      const ids = cells[1].match(idPattern) ?? [];
      const status = cells.at(-1);
      if (!ids.length) continue;
      if (!['未着手', '作成中', '完了'].includes(status)) throw new Error(`Invalid status ${file}:${index + 1}`);
      for (const id of ids.filter(id => config.scopePrefixes.some(prefix => id.startsWith(prefix)))) {
        if (!specs[id]) throw new Error(`Unknown specification ${id} at ${file}:${index + 1}`);
        specs[id].rows.push({ file, line: index + 1, requirement: cells[0], verification: cells[2], status });
      }
    }
  }
  for (const spec of Object.values(specs)) spec.status = spec.rows.length && spec.rows.every(x => x.status === '完了') ? 'complete' : spec.rows.some(x => x.status !== '未着手') ? 'in-progress' : 'not-started';
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
