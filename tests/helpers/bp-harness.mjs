import { promises as fs, readFileSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Workflow } from '../../plugins/workflow/skills/dynamic-workflow-runner/scripts/runtime/runtime.mjs';
import { main as cli } from '../../plugins/skill-creator/skills/skill-creator-best-practices/scripts/bp-state.mjs';
import { CRITERIA_DIR, PROMPT_AUDIT_FILE, STATES_DIR, STATE_ROOT_ENV } from '../../plugins/skill-creator/skills/skill-creator-best-practices/scripts/bp/constants.mjs';
import { stateRoot } from '../../plugins/skill-creator/skills/skill-creator-best-practices/scripts/bp/fixtures/harness.mjs';
import { sum } from '../../plugins/skill-creator/skills/skill-creator-best-practices/scripts/bp/ids.mjs';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const SKILL_DIR = path.join(REPO_ROOT, 'plugins', 'skill-creator', 'skills', 'skill-creator-best-practices');
export const SCRIPT = path.join(SKILL_DIR, 'scripts', 'bp_author.js');
export const INSPECT_SCRIPT = path.join(SKILL_DIR, 'scripts', 'bp_inspect.js');
const CLI_PATH = path.join(SKILL_DIR, 'scripts', 'bp-state.mjs');

// 最小の起動数は SP-BPRUN-021 に書き戻した値を正本にし、テストは仕様から読む（script の定数との一致は bp-spelling が照らす）。
export const MIN_LAUNCHES = (() => {
  const text = readFileSync(path.join(REPO_ROOT, 'docs', 'specifications', 'bp-run.md'), 'utf8');
  const m = /create の最小の起動数は (\d+)、update は (\d+) とする/.exec(text);
  const n = /review の最小の起動数は (\d+)、audit は (\d+) とする/.exec(text);
  if (!m || !n) throw new Error('SP-BPRUN-021 に最小の起動数が無い');
  return Object.freeze({ create: Number(m[1]), update: Number(m[2]), review: Number(n[1]), audit: Number(n[2]) });
})();
const COMMAND = /node '([^']+)' (\S+) <<'(BP_[0-9a-f]{8})'\n(.*)\n\3/g;

export async function tmp(t, prefix) {
  const dir = realpathSync(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

// 模擬実行も配布する写しそのものを読む（書き換えるテストが本物の写しを汚さないよう一時ディレクトリへ写す）。
export async function criteriaCopy(t) {
  const dir = await tmp(t, 'bp-criteria-');
  await fs.cp(path.join(SKILL_DIR, CRITERIA_DIR), dir, { recursive: true });
  return dir;
}

// 本文を置き換えた script の写しを作る。置き換えが 1 箇所も当たらなければ、黙って元の script を試さないよう落とす。
export async function variant(t, replacements, script = SCRIPT) {
  let source = await fs.readFile(script, 'utf8');
  for (const [from, to] of replacements) {
    if (!source.includes(from)) throw new Error(`置き換え元が script に無い: ${from}`);
    source = source.replace(from, to);
  }
  const dir = await tmp(t, 'bp-variant-');
  const file = path.join(dir, path.basename(script));
  await fs.writeFile(file, source);
  return file;
}

// 読み替えの文は script の criteriaNote を正本にし、テストは字面を書き写さない（2 本の字面の一致は bp-script-shared が照らす）。
export function criteriaNoteOf(root, script = SCRIPT) {
  const m = /^function criteriaNote\(root\) \{\n([\s\S]*?)\n\}/m.exec(readFileSync(script, 'utf8'));
  if (!m) throw new Error(`script に criteriaNote が無い: ${script}`);
  return new Function('root', m[1])(root);
}

// 起動数の上限で止まった停止の理由から、上限・その時点の起動数・残した件数を読む（SP-BPCONFORMANCE-023）。読めなければ null。
export function launchStopFacts(reason) {
  const m = /起動数の上限 (\d+) で止まった（その時点の起動数 (\d+)。[^）]*）。残した項目の件数 (\d+)/.exec(reason ?? '');
  return m ? { limit: Number(m[1]), used: Number(m[2]), left: Number(m[3]) } : null;
}

export function commands(prompt) {
  return [...prompt.matchAll(COMMAND)].map((m) => ({ script: m[1], op: m[2], delim: m[3], text: m[4] }));
}

// prompt-audit は既定で本物の references/prompt-audit.md を使う（写しを書き換えるテストは promptAudit に一時ファイルを渡す）。
export class Env {
  constructor({ root, criteriaDir, promptAudit = path.join(SKILL_DIR, PROMPT_AUDIT_FILE) }) {
    this.root = root;
    this.criteriaDir = criteriaDir;
    this.promptAudit = promptAudit;
    this.cliCalls = [];
  }

  async call(op, text) {
    const { output } = await cli([op], text, { cwd: REPO_ROOT, env: { [STATE_ROOT_ENV]: this.root }, criteriaDir: this.criteriaDir, promptAudit: this.promptAudit });
    this.cliCalls.push({ op, ok: output.ok, code: output.code });
    return output;
  }

  async request(op, body) {
    return this.call(op, JSON.stringify({ ...body, sum: sum(body) }));
  }

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

// 2 本の script のラベルの和集合。未知のラベルは prompt の形の誤りとしてテストを落とす。
const VERIFY_LABEL = /^verifier:(conformance|goal|contract|flow|spec|audit)(:extra)?$/;

function roleOf(label) {
  if (label.startsWith('carrier')) return 'carrier';
  if (label === 'writer:goal') return 'goal';
  if (label === 'writer:write') return 'write';
  if (label === 'verifier:vanish') return 'vanish';
  if (label === 'verifier:applicability') return 'applicability';
  if (label === 'extractor') return 'extract';
  if (VERIFY_LABEL.test(label)) return 'verify';
  if (label === 'refuter') return 'refute';
  throw new Error(`未知の役のラベル: ${label}`);
}

export async function runWorkflow(t, { env, args, scenario = {}, maxAgents = 1000, concurrency = 3, scriptPath, defaultRoles = defaults }) {
  const calls = [];
  const backend = {
    capabilities: ['read-only', 'fresh-thread', 'workspace-write'],
    async run(prompt, options) {
      const role = roleOf(options.label);
      const call = { role, label: options.label, model: options.model, effort: options.effort, prompt, n: calls.length };
      calls.push(call);
      const fn = scenario[role] ?? (role === 'carrier' ? null : defaultRoles[role]);
      const value = fn ? await fn(prompt, options, env, call, calls) : await env.carry(prompt);
      if (value === undefined && role === 'carrier') return env.carry(prompt);
      return value;
    },
  };
  const runDir = path.join(await tmp(t, 'bp-run-'), 'run');
  const result = await Workflow({ scriptPath, args }, {
    backend, trustedSource: true, runDir, maxAgents, concurrency, timeoutMs: 120000, maxOutputBytes: 100_000_000, requirements: ['workspace-write'],
  });
  return { result, calls };
}

export function runAuthor(t, options) {
  return runWorkflow(t, { scriptPath: SCRIPT, ...options });
}

export function runInspect(t, options) {
  return runWorkflow(t, { scriptPath: INSPECT_SCRIPT, defaultRoles: inspectDefaults, ...options });
}

export function bundlePath(prompt) {
  const m = /資産の束（[^）]*）: (\S+)/.exec(prompt);
  if (!m) throw new Error('prompt に資産の束のパスが無い');
  return m[1];
}

export async function bundleAssets(prompt) {
  const text = await fs.readFile(bundlePath(prompt), 'utf8');
  return [...text.matchAll(/^## (\S+) (\S+) /gm)].map((m) => ({ id: m[1], path: m[2] }));
}

export function viewpointOf(prompt) {
  return /^観点の値: (\S+)$/m.exec(prompt)?.[1] ?? null;
}

function presence(answer, quotes) {
  return { answer, quotes };
}

// review・audit の既定の模擬の役。抽出役はファイルごとに 1 組、適用の判定は固定パイプライン型（資産台帳・fan-out 無）、検証役は全て ok。
export const inspectDefaults = {
  async extract(prompt) {
    const assets = await bundleAssets(prompt);
    const byFile = new Map();
    for (const a of assets) byFile.set(a.path, [...(byFile.get(a.path) ?? []), a.id]);
    return { groups: [...byFile.values()] };
  },
  async applicability(prompt) {
    const [first] = await bundleAssets(prompt);
    const quotes = [{ asset: first.id, line: 1, text: '---' }];
    const a = (answer) => presence(answer, quotes);
    return { answers: { A: a('はい'), Q1: a('はい'), Q2: a('問いに到達しない'), Q3: a('問いに到達しない') }, ledger: a('無'), fanout: a('無') };
  },
  async verify(prompt) {
    const result = { judgements: assetIds(prompt).map((asset) => ({ asset, judgement: 'ok' })), candidates: [], unchecked: [] };
    await writePayload(prompt, result);
    return result;
  },
  refute: defaults.refute,
  vanish: defaults.vanish,
};

export const INSPECT_FILES = {
  'SKILL.md': '---\nname: x\ndescription: d\n---\n# X\n本文\n## 手順\n手順の本文\n',
  'scripts/x.js': 'export const meta = { name: "x" }\n',
};

export async function setupInspect(t, { files = INSPECT_FILES, promptAudit } = {}) {
  const root = stateRoot(t);
  if (!root) return null;
  const criteriaDir = await criteriaCopy(t);
  const base = await tmp(t, 'bp-target-');
  const skill = path.join(base, 'skill');
  for (const [rel, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(skill, rel)), { recursive: true });
    await fs.writeFile(path.join(skill, rel), content);
  }
  return { env: new Env({ root, criteriaDir, ...(promptAudit ? { promptAudit } : {}) }), target: { root: skill }, base, criteriaDir };
}

export function inspectArgs(fn, target, extra = {}) {
  return { function: fn, target, skillDir: SKILL_DIR, key: newKey(), ...extra };
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

// 反復 1 で「消す節」に適合の観点の指摘を出し、反復 2 の書き手がその節を消す（消えた資産の照合の段が走る）。
export const VANISH_FILES = { 'SKILL.md': '---\nname: x\n---\n# X\n## 設計の説明\nd\n## 消す節\n中身\n' };

export function vanishScenario(root) {
  const write = async (prompt) => {
    const file = path.join(root, 'SKILL.md');
    const n = /反復の番号: (\d+)/.exec(prompt)[1];
    await fs.writeFile(file, n === '1' ? '---\nname: x\n---\n# X\n## 設計の説明\nd1\n## 消す節\n中身\n' : '---\nname: x\n---\n# X\n## 設計の説明\nd2\n');
    return { written: [{ path: file, action: 'write' }], designNote: { path: 'SKILL.md', heading: '設計の説明' } };
  };
  const verify = async (prompt, options, env, call, calls) => {
    const iteration = calls.filter((c) => c.role === 'write').length;
    const result = await defaults.verify(prompt, options, env);
    if (options.label !== 'verifier:conformance' || iteration !== 1) return result;
    const { assets } = await env.readFromPrompt(prompt, 'report');
    const target = assets.find((a) => JSON.stringify(a.loc).includes('消す節')).id;
    const { kinds } = await env.readFromPrompt(prompt, 'kinds');
    const unit = result.units.find((u) => u.result === 'conform');
    const key = { asset: target, viewpoint: 'conformance', kind: kinds[0].value };
    result.judgements.find((j) => j.asset === target).judgement = 'candidate';
    result.candidates = [{ ...key, quote: 'L8: 中身', content: 'c', fix: 'f' }];
    Object.assign(unit, { result: 'nonconform', keys: [key] });
    await writePayload(prompt, result);
    return result;
  };
  return { write, verify };
}

export async function logOf(env, state) {
  const { readAll } = await import('../../plugins/skill-creator/skills/skill-creator-best-practices/scripts/bp/journal.mjs');
  return readAll(path.join(env.root, STATES_DIR, state));
}

export async function viewOf(env, state) {
  const { buildView } = await import('../../plugins/skill-creator/skills/skill-creator-best-practices/scripts/bp/view.mjs');
  return buildView(await logOf(env, state));
}

export function stagesIn(lines) {
  return lines.flatMap((l) => l.records.filter((r) => r.t === 'stage').map((r) => r.stage));
}

// prompt に埋めた強いられた未検査の一覧の外から、閉集合の先頭の種類を選ぶ。一覧を埋めているのに形が違えば（空白入りなど）、
// 強いられた種類を選んだり黙って先頭を選んだりせずに落とす。一覧を埋めない観点の prompt では、閉集合の先頭を選ぶ。
export async function firstUnforcedKind(prompt, env) {
  const { kinds } = await env.readFromPrompt(prompt, 'kinds');
  const embeds = prompt.includes('"forced"');
  const embedded = /"forced":(\[[^\]]*\])/.exec(prompt)?.[1];
  if (embeds && !embedded) throw new Error('prompt の強いられた未検査の一覧の形を読めない');
  const forced = embedded ? JSON.parse(embedded) : [];
  const kind = kinds.find((k) => !forced.includes(k.value));
  if (!kind) throw new Error('強いられた未検査でない指摘の種類が閉集合に無い');
  return kind.value;
}

export function candidateOf(asset, viewpoint, kind) {
  return { asset, viewpoint, kind, quote: 'L1: 本文', content: '基準に反する', fix: '直す' };
}

// 観点が viewpoint の検証役のうち when に当たる起動で、担当の資産の 1 つに候補を返す（閉集合の先頭の、強いられた未検査でない種類）。
export function candidateVerifier({ viewpoint, when = () => true, asset = (ids) => ids[0], judgement = 'candidate', also = {} } = {}) {
  return async (prompt, options, env, call, calls) => {
    // when は起動の時点の calls で決める（await の後では並行の起動が calls に足されている）。
    const hit = viewpointOf(prompt) === viewpoint && when(prompt, calls.slice(0, call.n + 1), call);
    const base = await inspectDefaults.verify(prompt);
    if (!hit) return base;
    const ids = assetIds(prompt);
    const target = asset(ids);
    if (!ids.includes(target)) return base;
    const kind = await firstUnforcedKind(prompt, env);
    const result = {
      ...base,
      judgements: ids.map((id) => ({ asset: id, judgement: id === target ? judgement : 'ok' })),
      candidates: judgement === 'candidate' ? [candidateOf(target, viewpoint, kind)] : [],
      ...also,
    };
    await writePayload(prompt, result);
    return result;
  };
}

// 要求に op を含む運搬役の n 回目（when に当たるもの）を失わせる。execute なら CLI を実行した後に応答を捨てる。
export function failCarrier(op, { execute = false, nth = [1], when = () => true } = {}) {
  let seen = 0;
  return async (prompt, options, env) => {
    if (!prompt.includes(` ${op} <<`) || !when(prompt)) return undefined;
    seen += 1;
    if (!nth.includes(seen)) return undefined;
    if (execute) await env.carry(prompt);
    return null;
  };
}

export async function editFile(file, edit) {
  await fs.writeFile(file, edit(await fs.readFile(file, 'utf8')));
}

export function compose(...carriers) {
  return async (...a) => {
    for (const c of carriers) {
      const out = await c(...a);
      if (out !== undefined) return out;
    }
    return undefined;
  };
}

// op を含む運搬役のうち when に当たる最初の 1 つで、先頭の k 個の要求だけを実行して応答を失う（段の途中まで書いて止まった run を作る）。
export function partialCarrier(op, k, when = () => true) {
  let done = false;
  return async (prompt, options, env) => {
    if (done || !prompt.includes(` ${op} <<`) || !when(prompt)) return undefined;
    done = true;
    for (const c of commands(prompt).slice(0, k)) await env.call(c.op, c.text);
    return null;
  };
}

// op の要求の項目のうち、現れた順で index 番目の項目の運搬役を全て失う（送り直しも失うので、その項目の書き込みで BLOCKED になる）。
export function loseItem(op, index = 0) {
  const seen = [];
  return async (prompt) => {
    if (!prompt.includes(` ${op} <<`)) return undefined;
    const item = /"item":"([^"]+)"/.exec(prompt)[1];
    if (!seen.includes(item)) seen.push(item);
    return seen.indexOf(item) === index ? null : undefined;
  };
}

