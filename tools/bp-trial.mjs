#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { main as cli } from '../plugins/skill-creator/skills/skill-creator-best-practices/scripts/bp-state.mjs';
import {
  CRITERIA_CHAPTERS, CRITERIA_DIR, CRITERIA_FILES, INSPECTING_FUNCTIONS, PROMPT_AUDIT_FILE, STAGE, STATES_DIR, WORKFLOW_SOURCES,
} from '../plugins/skill-creator/skills/skill-creator-best-practices/scripts/bp/constants.mjs';
import { sum } from '../plugins/skill-creator/skills/skill-creator-best-practices/scripts/bp/ids.mjs';
import { readAll } from '../plugins/skill-creator/skills/skill-creator-best-practices/scripts/bp/journal.mjs';
import { conformanceTable } from '../plugins/skill-creator/skills/skill-creator-best-practices/scripts/bp/kinds.mjs';
import { buildView } from '../plugins/skill-creator/skills/skill-creator-best-practices/scripts/bp/view.mjs';
import { resolveStateRoot } from '../plugins/skill-creator/skills/skill-creator-best-practices/scripts/bp/workspace.mjs';
import { injectUnits } from './read-bp-trial.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKILL_REL = path.join('plugins', 'skill-creator', 'skills', 'skill-creator-best-practices');
export const SKILL_DIR = path.join(REPO_ROOT, SKILL_REL);
export const TRIAL_DIR = path.join(REPO_ROOT, 'tests', 'fixtures', 'bp-trial');
export const RUNS_FILE = path.join(TRIAL_DIR, 'runs.json');
export const RECORDS_DIR = path.join(TRIAL_DIR, 'records');
const WORK_DIR_NAME = '.bp-trial';
const EXIT = Object.freeze({ ok: 0, failed: 1, usage: 2 });

// run の中の agent の判定に使わない章。ステータス・検証方法・TBD の書き戻しのたびに記録が古くなると、行を完了にした瞬間にその証拠が無効になる。
export const UNFINGERPRINTED_CHAPTERS = Object.freeze(CRITERIA_CHAPTERS.others.filter((c) => ['トレーサビリティ表', '検証方法', 'TBD の宣言'].includes(c)));
if (UNFINGERPRINTED_CHAPTERS.length !== 3) throw new Error('指紋から除く章が判定基準の章の閉集合に無い');
// 入口の操作のモジュールは run の中の script から呼ばれない（script の操作の写しは OPS だけを持つ）。runner の request の実測値を書き戻しても記録を古くしない。
const UNFINGERPRINTED_CLI = Object.freeze(['ops-entry.mjs']);

function sha(text) {
  return createHash('sha256').update(text).digest('hex');
}

export function criteriaBody(text) {
  const out = [];
  let skip = false;
  for (const line of text.split('\n')) {
    const h2 = /^## (.+?)\s*$/.exec(line);
    if (h2) skip = UNFINGERPRINTED_CHAPTERS.includes(h2[1]);
    if (!skip) out.push(line);
  }
  return out.join('\n');
}

function metaName(text) {
  return /^export const meta = \{\s*\n\s*name:\s*'([^']+)'/m.exec(text)?.[1] ?? null;
}

// script は置き場を移しても中身で見分ける（skill の scripts/ と plugin の workflows/ の両方を探す）。
function scriptsOf(skillDir) {
  const dirs = [path.join(skillDir, 'scripts'), path.join(skillDir, '..', '..', 'workflows')];
  const found = {};
  for (const dir of dirs.filter((d) => existsSync(d))) {
    for (const name of readdirSync(dir).filter((n) => n.endsWith('.js'))) {
      const text = readFileSync(path.join(dir, name), 'utf8');
      const role = Object.entries(WORKFLOW_SOURCES).find(([, v]) => v === metaName(text))?.[0];
      if (!role) continue;
      if (found[role]) throw new Error(`同じ meta.name の script が 2 つある: ${WORKFLOW_SOURCES[role]}`);
      found[role] = sha(text);
    }
  }
  for (const role of Object.keys(WORKFLOW_SOURCES)) if (!found[role]) throw new Error(`script が無い: ${WORKFLOW_SOURCES[role]}`);
  return found;
}

function cliFiles(skillDir) {
  const bp = path.join(skillDir, 'scripts', 'bp');
  const names = readdirSync(bp).filter((n) => n.endsWith('.mjs') && !n.endsWith('.test.mjs') && !UNFINGERPRINTED_CLI.includes(n)).sort();
  return Object.fromEntries([
    ['bp-state.mjs', sha(readFileSync(path.join(skillDir, 'scripts', 'bp-state.mjs')))],
    ...names.map((n) => [`bp/${n}`, sha(readFileSync(path.join(bp, n)))]),
  ]);
}

// 試走の記録の指紋の範囲はこの関数だけに置く（record が書く値と、記録を照らす側が計算する値を同じ関数から得る）。
export function fingerprint(skillDir = SKILL_DIR) {
  const criteria = path.join(skillDir, CRITERIA_DIR);
  return {
    scripts: scriptsOf(skillDir),
    cli: cliFiles(skillDir),
    promptAudit: sha(readFileSync(path.join(skillDir, PROMPT_AUDIT_FILE))),
    criteria: Object.fromEntries(Object.entries(CRITERIA_FILES).map(([k, parts]) => [k, sha(criteriaBody(readFileSync(path.join(criteria, ...parts), 'utf8')))])),
  };
}

export function sameFingerprint(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function readRuns(file = RUNS_FILE) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

async function call(op, body, ctx) {
  const { output } = await cli([op], JSON.stringify({ ...body, sum: sum(body) }), ctx);
  if (!output.ok) throw new Error(`${op}: ${output.code} ${output.reason}`);
  const { ok, op: _, sum: __, ...rest } = output;
  return rest;
}

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

// 試走は本物の checkout から切った worktree で走らせる（create が .agents/skills/ を作り、update が題材を書き換える）。
export function checkWorktree({ gitDir, commonDir }) {
  if (path.resolve(gitDir) === path.resolve(commonDir)) {
    throw new Error('今の作業ディレクトリは本物の checkout で、試走の worktree ではない。git worktree add で切った worktree に移ってから走らせる');
  }
}

function toplevel(cwd) {
  const top = git(cwd, 'rev-parse', '--show-toplevel');
  checkWorktree({ gitDir: path.resolve(cwd, git(cwd, 'rev-parse', '--git-dir')), commonDir: path.resolve(cwd, git(cwd, 'rev-parse', '--git-common-dir')) });
  return realpathSync(top);
}

function copyFixture(name, dest) {
  if (existsSync(dest)) throw new Error(`写し先が既にある: ${dest}（前の試走の写し。消してから prepare し直す）`);
  mkdirSync(path.dirname(dest), { recursive: true });
  cpSync(path.join(TRIAL_DIR, name), dest, { recursive: true });
}

function recordOf(name, recordsDir) {
  const file = path.join(recordsDir, `${name}.json`);
  if (!existsSync(file)) throw new Error(`${name} の記録が無い: ${file}`);
  return JSON.parse(readFileSync(file, 'utf8'));
}

export async function prepare(name, { cwd = process.cwd(), env = process.env, recordsDir = RECORDS_DIR } = {}) {
  const def = readRuns()[name];
  if (!def) throw new Error(`run が runs.json に無い: ${name}`);
  const top = toplevel(cwd);
  const skillDir = path.join(top, SKILL_REL);
  const ctx = { cwd: top, env };
  const work = path.join(top, WORK_DIR_NAME);
  let input;
  if (def.function === 'create') {
    const root = path.join(top, '.agents', 'skills', def.skill);
    if (existsSync(root)) throw new Error(`create の対象スキルのディレクトリが既にある: ${root}`);
    input = { function: 'create', request: readFileSync(path.join(TRIAL_DIR, def.request), 'utf8').trim(), target: { root } };
  } else {
    let root;
    if (def.from) {
      root = recordOf(def.from, recordsDir).target;
      if (!root || !existsSync(root)) throw new Error(`${def.from} の対象スキルが無い: ${root}`);
    } else {
      root = path.join(work, name, def.target);
      copyFixture(def.target, root);
      if (def.inject) injectUnits(root, def.inject === 'all' ? null : def.inject);
    }
    const paths = await call('paths', { root }, ctx);
    input = { function: def.function, target: { root: paths.root, files: paths.files } };
    if (def.function === 'update') {
      const instructions = JSON.parse(readFileSync(path.join(TRIAL_DIR, def.grounds), 'utf8'));
      input.grounds = [...(def.from ? [{ from: recordOf(def.from, recordsDir).state }] : []), ...instructions.map((text) => ({ kind: '利用者の指示', text }))];
    }
  }
  const { key } = await call('key', {}, ctx);
  return { ...input, skillDir, key };
}

const ROLE_BY_STAGE = Object.freeze({
  [STAGE.goal]: '書き手',
  [STAGE.write]: '書き手',
  [STAGE.verify]: '検証役',
  [STAGE.verifyExtra]: '検証役',
  [STAGE.vanish]: '検証役',
  [STAGE.applicability]: '検証役',
  [STAGE.refute]: '反証役',
});
const CARRIER = '運搬役';

// 運搬役の起動は状態に項目として残らないので、停止の記録の起動数から項目の試行（結果 1 と失敗ごとに 1 体）を引いて数える。
export function launchesOf(view, criteriaDir) {
  const models = Object.fromEntries(conformanceTable(criteriaDir, 'SP-BPCONFORMANCE-035', 'best-practices の役').rows.map(([role, model, effort]) => [role, { model: model.replace(/`/g, ''), effort: effort.replace(/`/g, '') }]));
  const byRole = {};
  const transport = {};
  const roleOf = (stage) => ROLE_BY_STAGE[stage] ?? (stage === STAGE.assign && INSPECTING_FUNCTIONS.has(view.state.function) ? '抽出役' : null);
  for (const item of view.items.values()) {
    const role = roleOf(item.stage);
    if (!role) continue;
    byRole[role] = (byRole[role] ?? 0) + item.fails.length + (item.result !== undefined ? 1 : 0);
    const lost = item.fails.filter((f) => /E_TRANSPORT/.test(f.reason)).length;
    if (lost) transport[role] = (transport[role] ?? 0) + lost;
  }
  const total = [...view.stops.values()].reduce((n, s) => n + s.launches, 0);
  const others = Object.values(byRole).reduce((n, x) => n + x, 0);
  byRole[CARRIER] = Math.max(0, total - others);
  return {
    total,
    byRole: Object.fromEntries(Object.entries(byRole).map(([role, n]) => [role, { n, ...models[role] }])),
    transport: { byRole: transport, carrierLaunches: byRole[CARRIER], rate: byRole[CARRIER] ? Object.values(transport).reduce((n, x) => n + x, 0) / byRole[CARRIER] : 0 },
  };
}

function startedAt(stateId) {
  const m = /^bp-(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})-/.exec(stateId);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null;
}

export async function record(name, stateId, { cwd = process.cwd(), env = process.env, recordsDir = RECORDS_DIR } = {}) {
  const def = readRuns()[name];
  if (!def) throw new Error(`run が runs.json に無い: ${name}`);
  const top = toplevel(cwd);
  const skillDir = path.join(top, SKILL_REL);
  const ctx = { cwd: top, env };
  const dir = path.join(resolveStateRoot(ctx), STATES_DIR, stateId);
  const view = buildView(await readAll(dir));
  if (view.state?.function !== def.function) throw new Error(`状態 ${stateId} の機能 ${view.state?.function} が ${name} の ${def.function} と違う`);
  const result = await call('outcome', { state: stateId }, ctx);
  const started = startedAt(stateId);
  const out = {
    run: name,
    function: def.function,
    state: stateId,
    target: view.paths[0].root,
    result,
    launches: launchesOf(view, path.join(skillDir, CRITERIA_DIR)),
    durationMs: started === null ? null : statSync(path.join(dir, 'log.jsonl')).mtimeMs - started,
    fingerprint: fingerprint(skillDir),
  };
  mkdirSync(recordsDir, { recursive: true });
  writeFileSync(path.join(recordsDir, `${name}.json`), `${JSON.stringify(out, null, 2)}\n`);
  if (def.function === 'create' && result.skill?.root && existsSync(result.skill.root)) {
    cpSync(result.skill.root, path.join(recordsDir, `${name}-output`), { recursive: true });
  }
  return out;
}

export async function main(argv) {
  const [op, name] = argv;
  if (op === 'prepare' && name && argv.length === 2) return { exitCode: EXIT.ok, text: JSON.stringify(await prepare(name)) };
  const s = argv.indexOf('--state');
  if (op === 'record' && name && s > 0 && argv[s + 1]) {
    const r = await record(name, argv[s + 1]);
    return { exitCode: EXIT.ok, text: `${name} の記録を書いた（${r.result.stopKind}、起動 ${r.launches.total}）` };
  }
  return { exitCode: EXIT.usage, text: '使い方: node tools/bp-trial.mjs prepare <run> | record <run> --state <状態 ID>（run は tests/fixtures/bp-trial/runs.json の名前。試走の worktree の中で走らせる）' };
}

if (process.argv[1] && realpathSync(path.resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  try {
    const { exitCode, text } = await main(process.argv.slice(2));
    process.stdout.write(`${text}\n`);
    process.exitCode = exitCode;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = EXIT.failed;
  }
}
