import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { realpathLoose, within } from './workspace.mjs';

const CALL = /Workflow\s*\(\s*\{([\s\S]*?)\}\s*\)/g;
const NAME = /(?:^|[\s,{])name\s*:\s*(['"])([^'"]+)\1/;
const SCRIPT_PATH = /(?:^|[\s,{])scriptPath\s*:\s*(\S)/;
const LITERAL_PATH = /(?:^|[\s,{])scriptPath\s*:\s*(['"])([^'"`$]+)\1/;
const META = /^\s*export\s+const\s+meta\s*=\s*\{([\s\S]*?)\n\}/;
// callsite の scriptPath は「このスキルのディレクトリ」を表す置き換えの印で始まる書き方を持つ（[SKILL_DIR]・<…>・${…}）。
const DIR_MARK = /^(?:\[[^\]]+\]|<[^>]+>|\$\{[^}]+\})\//;

function topLevel(body) {
  let out = body;
  for (;;) {
    const next = out.replace(/\{[^{}]*\}/g, '');
    if (next === out) return out;
    out = next;
  }
}

function lineOf(text, index) {
  return text.slice(0, index).split('\n').length;
}

export function pluginOf(root) {
  const real = realpathLoose(root);
  if (path.basename(path.dirname(real)) !== 'skills') return null;
  const pluginRoot = path.dirname(path.dirname(real));
  const manifest = path.join(pluginRoot, '.claude-plugin', 'plugin.json');
  if (!existsSync(manifest)) return null;
  try {
    const name = JSON.parse(readFileSync(manifest, 'utf8')).name;
    return typeof name === 'string' && name ? { name, root: pluginRoot } : null;
  } catch {
    return null;
  }
}

export function workflowMetaName(source) {
  const m = META.exec(source);
  if (!m) return null;
  return NAME.exec(topLevel(m[1]))?.[2] ?? null;
}

function namedSources(plugin) {
  const dir = path.join(plugin.root, 'workflows');
  if (!existsSync(dir)) return new Map();
  const out = new Map();
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.js')).sort()) {
    const file = path.join(dir, name);
    const meta = workflowMetaName(readFileSync(file, 'utf8'));
    if (meta) out.set(meta, [...(out.get(meta) ?? []), file]);
  }
  return out;
}

export function extractCallsites(text) {
  const out = [];
  for (const m of text.matchAll(CALL)) {
    const body = topLevel(m[1]);
    const name = NAME.exec(body);
    const line = lineOf(text, m.index);
    const callText = m[0].replace(/\s+/g, ' ');
    if (name) out.push({ kind: 'name', value: name[2], line, text: callText });
    else if (SCRIPT_PATH.test(body)) out.push({ kind: 'scriptPath', value: LITERAL_PATH.exec(body)?.[2] ?? null, line, text: callText });
  }
  return out;
}

export function resolveCallsites(root) {
  const realRoot = realpathLoose(root);
  const skillMd = path.join(realRoot, 'SKILL.md');
  const plugin = pluginOf(realRoot);
  if (!existsSync(skillMd)) return { root: realRoot, plugin: plugin?.name ?? null, files: [], unresolved: [] };
  const text = readFileSync(skillMd, 'utf8');
  const files = [];
  const unresolved = [];
  const sources = plugin ? namedSources(plugin) : new Map();
  for (const call of extractCallsites(text)) {
    const miss = () => unresolved.push({ line: call.line, text: call.text });
    if (call.kind === 'name') {
      const [namespace, local] = call.value.split(':');
      if (plugin && namespace !== plugin.name) continue;
      const found = local ? sources.get(local) ?? [] : [];
      if (!plugin || found.length !== 1) { miss(); continue; }
      files.push(realpathLoose(found[0]));
      continue;
    }
    if (call.value === null) { miss(); continue; }
    const rel = call.value.replace(DIR_MARK, '');
    const file = realpathLoose(path.isAbsolute(rel) ? rel : path.join(realRoot, rel));
    if (!existsSync(file)) { miss(); continue; }
    if (within(file, realRoot)) continue;
    if (!plugin || !within(file, plugin.root)) { miss(); continue; }
    files.push(file);
  }
  return { root: realRoot, plugin: plugin?.name ?? null, files: [...new Set(files)].sort(), unresolved };
}
