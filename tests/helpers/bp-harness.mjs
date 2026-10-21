import { promises as fs, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Workflow } from '../../plugins/workflow/skills/dynamic-workflow-runner/scripts/runtime/runtime.mjs';
import { main as cli } from '../../plugins/skill-creator/skills/skill-creator-best-practices/scripts/bp-state.mjs';
import { CRITERIA_FILES, STATE_ROOT_ENV } from '../../plugins/skill-creator/skills/skill-creator-best-practices/scripts/bp/constants.mjs';
import { stateRoot } from '../../plugins/skill-creator/skills/skill-creator-best-practices/scripts/bp/fixtures/harness.mjs';
import { sum } from '../../plugins/skill-creator/skills/skill-creator-best-practices/scripts/bp/ids.mjs';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const SKILL_DIR = path.join(REPO_ROOT, 'plugins', 'skill-creator', 'skills', 'skill-creator-best-practices');
export const SCRIPT = path.join(SKILL_DIR, 'scripts', 'bp_author.js');
const CLI_PATH = path.join(SKILL_DIR, 'scripts', 'bp-state.mjs');
const COMMAND = /node '([^']+)' (\S+) <<'(BP_[0-9a-f]{8})'\n(.*)\n\3/g;

export async function tmp(t, prefix) {
  const dir = realpathSync(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

// 判定基準の写しは 4 段目まで本番の置き場に無いので、docs の正本を CRITERIA_FILES と同じ配置で一時ディレクトリへ写す。
export async function criteriaCopy(t) {
  const dir = await tmp(t, 'bp-criteria-');
  for (const parts of Object.values(CRITERIA_FILES)) {
    const src = path.join(REPO_ROOT, 'docs', ...parts);
    const dest = path.join(dir, ...parts);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.copyFile(src, dest);
  }
  return dir;
}

export function commands(prompt) {
  return [...prompt.matchAll(COMMAND)].map((m) => ({ script: m[1], op: m[2], delim: m[3], text: m[4] }));
}

export class Env {
  constructor({ root, criteriaDir }) {
    this.root = root;
    this.criteriaDir = criteriaDir;
    this.cliCalls = [];
  }

  async call(op, text) {
    const { output } = await cli([op], text, { cwd: REPO_ROOT, env: { [STATE_ROOT_ENV]: this.root }, criteriaDir: this.criteriaDir });
    this.cliCalls.push({ op, ok: output.ok, code: output.code });
    return output;
  }

  async request(op, body) {
    return this.call(op, JSON.stringify({ ...body, sum: sum(body) }));
  }

  // 運搬役の模擬: prompt から要求を区切りの文字列で抜き出し、本物の CLI の処理として順に実行する。
  async carry(prompt) {
    const list = commands(prompt);
    if (list.length === 0) throw new Error(`運搬役の prompt に要求が無い:\n${prompt}`);
    const responses = [];
    for (const c of list) {
      if (c.script !== CLI_PATH) throw new Error(`運搬役の prompt の CLI のパスが違う: ${c.script}`);
      const out = await this.call(c.op, c.text);
      responses.push(JSON.stringify(out));
      if (!out.ok) break;
    }
    return { responses };
  }

  async readFromPrompt(prompt, op) {
    const c = commands(prompt).find((x) => x.op === op);
    if (!c) throw new Error(`prompt に ${op} の読み出しが無い`);
    return this.call(op, c.text);
  }
}

export function assetIds(prompt) {
  const m = /担当の資産 ID: (.+)/.exec(prompt);
  if (!m) throw new Error('検証役の prompt に担当の資産 ID が無い');
  return m[1].split(', ').map((s) => s.trim());
}

export function payloadPath(prompt) {
  return /\{"result": <返り値>\} の形で (\S+) にも書く/.exec(prompt)?.[1] ?? null;
}

export function targetRoot(prompt) {
  return /根 (\S+) の配下/.exec(prompt)?.[1] ?? null;
}

export function groundIds(prompt) {
  return [...new Set([...prompt.matchAll(/"id":"(G\d+)"/g)].map((m) => m[1]))];
}

export function requestQuote(prompt) {
  const m = /依頼文:\n([^\n]+)/.exec(prompt);
  return m ? m[1].slice(0, 12) : null;
}

export async function writePayload(prompt, result) {
  const file = payloadPath(prompt);
  if (file) await fs.writeFile(file, JSON.stringify({ result }));
}

export const defaults = {
  async goal(prompt) {
    const grounds = groundIds(prompt);
    const sources = grounds.length ? grounds.map((g) => ({ kind: 'ground', ground: g })) : [{ kind: 'request', quote: requestQuote(prompt) }];
    return { goal: { deliverables: [{ text: '成果物', sources }], scope: [], prohibitions: [], numeric: [], deixis: [] } };
  },
  async write(prompt) {
    const root = targetRoot(prompt);
    await fs.mkdir(root, { recursive: true });
    const file = path.join(root, 'SKILL.md');
    const number = /反復の番号: (\d+)/.exec(prompt)[1];
    await fs.writeFile(file, `---\nname: made\ndescription: d\n---\n# Made\n本文 ${number}\n## 設計の説明\nA: はい。Q1: いいえ。\n`);
    return { written: [{ path: file, action: 'write' }], designNote: { path: 'SKILL.md', heading: '設計の説明' } };
  },
  async verify(prompt, options, env) {
    const viewpoint = options.label.split(':')[1];
    const assets = assetIds(prompt);
    const result = { judgements: assets.map((asset) => ({ asset, judgement: 'ok' })), candidates: [] };
    if (viewpoint === 'conformance') {
      const { rows } = await env.readFromPrompt(prompt, 'units');
      const row = rows[8];
      result.applicability = { row: row.row };
      result.units = row.units.map((u) => (row.forced.includes(u.value)
        ? { unit: u.value, result: 'unchecked', reason: '強いられた未検査', unchecked: 'forced' }
        : { unit: u.value, result: 'conform', reason: '適合' }));
      result.residualRisks = [{ role: '書き手', restriction: '対象スキルと作業ファイルだけ', host: 'Claude Code', reason: '確かめる手段が無い' }];
    }
    if (viewpoint === 'goal') result.basisConstraints = [];
    if (viewpoint === 'contract') result.contractChanges = [];
    await writePayload(prompt, result);
    return result;
  },
  async refute() {
    return { verdict: 'uphold', reason: '維持' };
  },
  async vanish() {
    return { choice: 'none' };
  },
};

function roleOf(label) {
  if (label.startsWith('carrier')) return 'carrier';
  if (label === 'writer:goal') return 'goal';
  if (label === 'writer:write') return 'write';
  if (label === 'verifier:vanish') return 'vanish';
  if (label.startsWith('verifier:')) return 'verify';
  if (label === 'refuter') return 'refute';
  throw new Error(`未知の役のラベル: ${label}`);
}

export async function runAuthor(t, { env, args, scenario = {}, maxAgents = 1000, concurrency = 3 }) {
  const calls = [];
  const backend = {
    capabilities: ['read-only', 'fresh-thread', 'workspace-write'],
    async run(prompt, options) {
      const role = roleOf(options.label);
      const call = { role, label: options.label, model: options.model, effort: options.effort, prompt, n: calls.length };
      calls.push(call);
      const fn = scenario[role] ?? (role === 'carrier' ? null : defaults[role]);
      const value = fn ? await fn(prompt, options, env, call, calls) : await env.carry(prompt);
      if (value === undefined && role === 'carrier') return env.carry(prompt);
      return value;
    },
  };
  const runDir = path.join(await tmp(t, 'bp-run-'), 'run');
  const result = await Workflow({ scriptPath: SCRIPT, args }, {
    backend, trustedSource: true, runDir, maxAgents, concurrency, timeoutMs: 120000, maxOutputBytes: 100_000_000, requirements: ['workspace-write'],
  });
  return { result, calls };
}

export async function setup(t, { fn = 'create', files } = {}) {
  const root = stateRoot(t);
  if (!root) return null;
  const criteriaDir = await criteriaCopy(t);
  const base = await tmp(t, 'bp-target-');
  let target;
  if (fn === 'create') {
    target = { root: path.join(base, '.agents', 'skills', 'made') };
  } else {
    const skill = path.join(base, 'skill');
    await fs.mkdir(skill, { recursive: true });
    for (const [rel, content] of Object.entries(files ?? { 'SKILL.md': '---\nname: x\ndescription: d\n---\n# X\n本文\n## 設計の説明\n説明\n' })) {
      await fs.mkdir(path.dirname(path.join(skill, rel)), { recursive: true });
      await fs.writeFile(path.join(skill, rel), content);
    }
    target = { root: skill };
  }
  return { env: new Env({ root, criteriaDir }), target, base };
}

let keys = 0;
export function newKey() {
  keys += 1;
  return `k-${process.pid}-${keys}-${Math.floor(Math.random() * 1e9)}`;
}

export function createArgs(target, extra = {}) {
  return { function: 'create', request: '設定ファイルを整形するスキルを作る。対象は YAML だけ。', target, skillDir: SKILL_DIR, key: newKey(), ...extra };
}

export function updateArgs(target, extra = {}) {
  return { function: 'update', grounds: [{ kind: '利用者の指示', text: '説明を短くする' }], target, skillDir: SKILL_DIR, key: newKey(), ...extra };
}

export function resumeArgs(prev, extra = {}) {
  return { nextArgs: prev.nextArgs, skillDir: SKILL_DIR, key: newKey(), ...extra };
}
