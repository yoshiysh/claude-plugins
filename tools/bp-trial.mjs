#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { main as cli } from '../plugins/skill-creator/skills/skill-creator-best-practices/scripts/bp-state.mjs';
import {
  CRITERIA_CHAPTERS, CRITERIA_DIR, INSPECTING_FUNCTIONS, PROMPT_AUDIT_FILE, STAGE, STATES_DIR, WORKFLOW_SOURCES,
} from '../plugins/skill-creator/skills/skill-creator-best-practices/scripts/bp/constants.mjs';
import { sum } from '../plugins/skill-creator/skills/skill-creator-best-practices/scripts/bp/ids.mjs';
import { readAll } from '../plugins/skill-creator/skills/skill-creator-best-practices/scripts/bp/journal.mjs';
import { conformanceTable } from '../plugins/skill-creator/skills/skill-creator-best-practices/scripts/bp/kinds.mjs';
import { buildView } from '../plugins/skill-creator/skills/skill-creator-best-practices/scripts/bp/view.mjs';
import { resolveStateRoot } from '../plugins/skill-creator/skills/skill-creator-best-practices/scripts/bp/workspace.mjs';
import { ISSUED_KEY } from '../plugins/skill-creator/skills/skill-creator-best-practices/scripts/bp/ops-author.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKILL_REL = path.join('plugins', 'skill-creator', 'skills', 'skill-creator-best-practices');
export const SKILL_DIR = path.join(REPO_ROOT, SKILL_REL);
export const TRIAL_DIR = path.join(REPO_ROOT, 'tests', 'fixtures', 'bp-trial');
export const RUNS_FILE = path.join(TRIAL_DIR, 'runs.json');
export const RECORDS_DIR = path.join(TRIAL_DIR, 'records');
export const EXPECTED_FILE = path.join(TRIAL_DIR, 'review-target.expected.json');
const WORK_DIR_NAME = '.bp-trial';
// 振り分けの eval の run の機能の名前。eval の記録の指紋だけが入口の SKILL.md を含む。
export const EVAL_FUNCTION = 'eval';
const EXIT = Object.freeze({ ok: 0, failed: 1, usage: 2 });

// 検証役は写しの全文を読み（bp-conformance が委ねる文書も開く）、CLI はトレーサビリティ表の仕様項目 ID の列から適用の判定の単位を作るので、
// 写しの全てのファイルの全文を run の判定に使う。指紋から除くのは、トレーサビリティ表のステータスの値だけ（試走の記録からステータスを
// 書き換えるたびに、その証拠の記録を古くしないため）。値でない文に書き換えたセルは指紋に入る。
const TRACE_CHAPTER = CRITERIA_CHAPTERS.others.find((c) => c === 'トレーサビリティ表');
if (!TRACE_CHAPTER) throw new Error('トレーサビリティ表の章が判定基準の章の閉集合に無い');
const STATUS_VALUES = Object.freeze(['未着手', '作成中', '完了']);
// 入口の操作のモジュールは run の中の script から呼ばれない（script の操作の写しは OPS だけを持つ）。runner の request の実測値を書き戻しても記録を古くしない。
const UNFINGERPRINTED_CLI = Object.freeze(['ops-entry.mjs']);

function sha(text) {
  return createHash('sha256').update(text).digest('hex');
}

export function criteriaBody(text) {
  let trace = false;
  return text.split('\n').map((line) => {
    const h2 = /^## (.+?)\s*$/.exec(line);
    if (h2) trace = h2[1] === TRACE_CHAPTER;
    const m = trace ? /^(\|.*\|) ([^|]+?) \|\s*$/.exec(line) : null;
    return m && STATUS_VALUES.includes(m[2]) ? `${m[1]} |` : line;
  }).join('\n');
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
// 入口の SKILL.md は試走の run の中で読まれない（args は prepare が作る）ので、振り分けの eval の記録（entry）だけに入れる。
export function fingerprint(skillDir = SKILL_DIR, { entry = false } = {}) {
  const criteria = path.join(skillDir, CRITERIA_DIR);
  return {
    ...(entry ? { skill: sha(readFileSync(path.join(skillDir, 'SKILL.md'))) } : {}),
    scripts: scriptsOf(skillDir),
    cli: cliFiles(skillDir),
    promptAudit: sha(readFileSync(path.join(skillDir, PROMPT_AUDIT_FILE))),
    criteria: Object.fromEntries(walkFiles(criteria).sort().map((rel) => [rel, sha(criteriaBody(readFileSync(path.join(criteria, rel), 'utf8')))])),
  };
}

export function sameFingerprint(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function belongs(unit, sp) {
  return unit === sp || unit.startsWith(`${sp}/`);
}

function chosenInjections(sps, expected) {
  const chosen = sps === null ? expected.injections : expected.injections.filter((i) => sps.some((sp) => belongs(i.unit, sp)));
  if (sps !== null && sps.some((sp) => !chosen.some((i) => belongs(i.unit, sp)))) throw new Error(`正解表に仕込みが無い仕様項目がある: ${sps.join(', ')}`);
  return chosen;
}

function injected(text, i) {
  const at = text.indexOf(i.from);
  if (at < 0 || text.indexOf(i.from, at + 1) >= 0) throw new Error(`置き換え元がちょうど 1 回現れない: ${i.file} ${JSON.stringify(i.from)}`);
  return text.slice(0, at) + i.to + text.slice(at + i.from.length);
}

export function applyInjections(injections, outDir) {
  for (const i of injections) {
    const file = path.join(outDir, i.file);
    writeFileSync(file, injected(readFileSync(file, 'utf8'), i));
  }
}

// 単独の仕込みの run は、全ての仕込みと同じ正解表から仕様項目で選ぶ（置き換えの文字列を 2 箇所に書かない）。
export function injectUnits(dir, sps, expected = JSON.parse(readFileSync(EXPECTED_FILE, 'utf8'))) {
  applyInjections(chosenInjections(sps, expected), dir);
}

function walkFiles(dir, base = dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walkFiles(p, base) : [path.relative(base, p).split(path.sep).join('/')];
  });
}

// 題材の写しを作らずに、runs.json の題材（と仕込み）から run の開始の時点の指紋を作る。CLI の指紋と同じ sha256。
function fixtureDigests(name, inject) {
  const dir = path.join(TRIAL_DIR, name);
  const chosen = inject ? chosenInjections(inject === 'all' ? null : inject, JSON.parse(readFileSync(EXPECTED_FILE, 'utf8'))) : [];
  return Object.fromEntries(walkFiles(dir).sort().map((rel) => {
    let bytes = readFileSync(path.join(dir, rel));
    for (const i of chosen.filter((x) => x.file === rel)) bytes = Buffer.from(injected(bytes.toString('utf8'), i));
    return [rel, sha(bytes)];
  }));
}

function instructionGrounds(def) {
  return JSON.parse(readFileSync(path.join(TRIAL_DIR, def.grounds), 'utf8')).map((text) => ({ kind: '利用者の指示', text }));
}

// 試走の記録は、runs.json の題材・依頼文・修正の根拠で始めた run の状態からだけ作る（模擬の run や別の題材の状態の記録で、試走の行を完了にしない）。
export function expectedSource(name, runs = readRuns(), from = null) {
  const def = runs[name];
  if (def.function === 'create') return { request: readFileSync(path.join(TRIAL_DIR, def.request), 'utf8').trim() };
  const base = def.from ? runs[def.from] : def;
  const out = { files: fixtureDigests(base.target, base.inject) };
  if (def.function === 'update') out.grounds = { instructions: instructionGrounds(def), from: def.from ? from : null };
  return out;
}

export function sourceOfState(view) {
  const run = view.runs[0].id;
  const start = view.fingerprints.find((f) => f.run === run && f.at === 'start');
  const out = { key: view.state.key };
  if (view.state.function === 'create') out.request = view.state.request;
  else out.files = start.files;
  if (view.state.function === 'update') {
    out.grounds = {
      instructions: view.grounds.filter((g) => !g.from).map((g) => g.ground),
      from: [...new Set(view.grounds.filter((g) => g.from).map((g) => g.from))],
    };
  }
  return out;
}

export function sourceProblems(source, expected) {
  const problems = [];
  if (!source) return ['記録に run の出所が無い'];
  if (typeof source.key !== 'string' || !ISSUED_KEY.test(source.key)) problems.push(`起動の key が CLI の key の操作で得た形でない: ${JSON.stringify(source.key)}（prepare を通さずに始めた run）`);
  if (expected.request !== undefined && source.request !== expected.request) problems.push('依頼文が runs.json の依頼文と違う');
  if (expected.files !== undefined && JSON.stringify(source.files) !== JSON.stringify(expected.files)) problems.push('開始の時点の対象スキルが runs.json の題材（と仕込み）と違う');
  if (expected.grounds !== undefined) {
    if (JSON.stringify(source.grounds?.instructions) !== JSON.stringify(expected.grounds.instructions)) problems.push('利用者の指示の修正の根拠が runs.json と違う');
    const refs = source.grounds?.from ?? [];
    if (expected.grounds.from === null ? refs.length > 0 : refs.some((f) => f !== expected.grounds.from)) problems.push(`参照の形の修正の根拠が前の run の状態と違う: ${refs.join(', ')}`);
  }
  return problems;
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
      input.grounds = [...(def.from ? [{ from: recordOf(def.from, recordsDir).state }] : []), ...instructionGrounds(def)];
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
  // review・audit の担当の作成と適用の判定は項目を持たず、agent の結果ごとに段の繰り返しの番号を書くので、その番号を起動数に数える。
  if (INSPECTING_FUNCTIONS.has(view.state.function)) {
    for (const [stage, role] of [[STAGE.assign, '抽出役'], [STAGE.applicability, '検証役']]) {
      const n = view.repeats.get(stage) ?? 0;
      if (n) byRole[role] = (byRole[role] ?? 0) + n;
    }
  }
  for (const item of view.items.values()) {
    const role = ROLE_BY_STAGE[item.stage];
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

// Claude Code の native Workflow は、run ごとに <設定のディレクトリ>/projects/<project>/<session>/workflows/<runId>.json へ、
// 渡した args・script の本文・返り値・agent の数を書く。記録はこれを実行の側の証拠として、状態の run の key ごとに 1 つずつ持つ。
// 模擬の backend の run はこのファイルを残さないので、証拠を見つけられずに記録を書かない（ファイルそのものの偽造は防げない）。
export function workflowRunFiles(configDir) {
  const projects = path.join(configDir, 'projects');
  if (!existsSync(projects)) return [];
  const out = [];
  for (const project of readdirSync(projects)) {
    const pdir = path.join(projects, project);
    if (!statSync(pdir).isDirectory()) continue;
    for (const session of readdirSync(pdir)) {
      const wdir = path.join(pdir, session, 'workflows');
      if (!existsSync(wdir)) continue;
      for (const f of readdirSync(wdir).filter((n) => n.endsWith('.json'))) out.push(path.join(wdir, f));
    }
  }
  return out;
}

function roleOfFunction(fn) {
  return fn === 'create' || fn === 'update' ? 'author' : 'inspect';
}

const WORKFLOW_DONE = 'completed';
// host の失敗で止まった run が残す記録の状態。agent を起動する前に失敗すると agentCount は 0 になるので、止まった記録には agent の数を求めない。
const WORKFLOW_STOPPED = Object.freeze(['killed', 'failed']);
const HOUR_MS = 3_600_000;

function argsOf(json) {
  if (typeof json.args !== 'string') return json.args;
  try {
    return JSON.parse(json.args);
  } catch {
    return null;
  }
}

// 本物の run は completed で、返り値に状態を持ち、運搬役を 1 体以上起動する（開始の運搬役）。状態の無い返り値（入力の確かめで止まった run）は、
// 同じ key で別に走らせた模擬の run の状態と組めてしまうので受けない。
function completedFor(stateId) {
  return (f) => f.json.status === WORKFLOW_DONE && f.json.result?.state === stateId && Number.isInteger(f.json.agentCount) && f.json.agentCount >= 1;
}

function agentsOf(json) {
  return (Array.isArray(json.workflowProgress) ? json.workflowProgress : []).filter((a) => a.type === 'workflow_agent')
    .map((a) => ({ label: a.label ?? null, model: a.model ?? null, state: a.state ?? null, attempt: a.attempt ?? null, durationMs: a.durationMs ?? null }));
}

// 同じ key の止まった記録の後に native が同じ run を続けると、続きの記録の agent は cached で所要時間を持たないので、同じ key の止まった記録の agent も持たせる。
function evidenceOf({ file, sha: fileSha, json }, key, siblings = []) {
  return {
    key, runId: json.runId ?? null, file, fileSha, scriptPath: json.scriptPath ?? null, scriptSha: typeof json.script === 'string' ? sha(json.script) : null,
    status: json.status ?? null, agentCount: json.agentCount ?? null, durationMs: json.durationMs ?? null, totalTokens: json.totalTokens ?? null,
    resultState: json.result?.state ?? null,
    agents: [...siblings.flatMap((f) => agentsOf(f.json)), ...agentsOf(json)],
    // 畳み込んだ記録も読み取りで照らせるよう、1 つずつの状態・script の本文・返り値の状態を残す。
    siblings: siblings.map((f) => ({
      runId: f.json.runId ?? null, file: f.file, fileSha: f.sha, status: f.json.status ?? null,
      scriptSha: typeof f.json.script === 'string' ? sha(f.json.script) : null, resultState: f.json.result?.state ?? null,
    })),
  };
}

// 再開は next_args と新しい key で別の Workflow を起動する（SP-BPRUN-014）ので、状態の run ごとに key の違う記録ができる。
// 状態の run ごとに、その key の completed の記録が 1 つ（返り値の状態が同じもの）か、host の失敗で止まった前の run なら killed・failed の記録を受ける。
// 最後の run は completed でなければならない（記録を書くのは止まった run の返り値が状態にあるときだけ）。同じ key の completed が 2 つあれば、どちらの run の記録かを決められないので拒否する。
export function workflowEvidence(view, stateId, configDir) {
  const files = workflowRunFiles(configDir).map((file) => {
    const bytes = readFileSync(file);
    try {
      return { file, sha: sha(bytes), json: JSON.parse(bytes.toString('utf8')) };
    } catch {
      return null;
    }
  }).filter((f) => f && f.json && typeof f.json === 'object');
  return view.runs.map((r, i) => {
    const mine = files.filter((f) => argsOf(f.json)?.key === r.key);
    const done = mine.filter((f) => f.json.status === WORKFLOW_DONE);
    const ok = done.filter(completedFor(stateId));
    const last = i === view.runs.length - 1;
    const where = path.join(configDir, 'projects');
    if (done.length > 1) throw new Error(`run ${r.id} の key ${r.key} の completed の Workflow の実行の記録が ${done.length} 件（1 件でなければならない）: ${where}`);
    const stopped = mine.filter((f) => WORKFLOW_STOPPED.includes(f.json.status));
    const other = mine.filter((f) => f.json.status !== WORKFLOW_DONE && !WORKFLOW_STOPPED.includes(f.json.status));
    if (other.length) throw new Error(`run ${r.id} の key ${r.key} の Workflow の実行の記録の状態が completed・${WORKFLOW_STOPPED.join('・')} のどれでもない: ${other.map((f) => f.file).join(', ')}`);
    const foreign = stopped.filter((f) => f.json.result?.state !== undefined && f.json.result?.state !== null && f.json.result.state !== stateId);
    if (foreign.length) throw new Error(`run ${r.id} の key ${r.key} の止まった Workflow の実行の記録の返り値が別の状態を持つ: ${foreign.map((f) => f.file).join(', ')}`);
    if (ok.length === 1) return evidenceOf(ok[0], r.key, stopped);
    if (done.length === 1) throw new Error(`run ${r.id} の key ${r.key} の Workflow の実行の記録の返り値が状態 ${stateId} を持たないか、agent を起動していない: ${done[0].file}`);
    if (last) throw new Error(`最後の run ${r.id} の key ${r.key} の completed の Workflow の実行の記録が無い（${mine.length} 件。模擬の backend の run は記録を残さない）: ${where}`);
    if (stopped.length === 0) throw new Error(`run ${r.id} の key ${r.key} の Workflow の実行の記録が 0 件（模擬の backend の run は記録を残さない）: ${where}`);
    return evidenceOf(stopped.at(-1), r.key, stopped.slice(0, -1));
  });
}

// runner の request の時間の上限を試走の記録から決める（SP-BPENTRY-016）。Codex runner では試走を記録できないので、native の所要時間から決める。
export function runnerTimeouts(records) {
  const ev = records.flatMap((r) => r.evidence ?? []);
  const run = Math.max(0, ...ev.map((e) => e.durationMs ?? 0));
  const agent = Math.max(0, ...ev.flatMap((e) => (e.agents ?? []).map((a) => a.durationMs ?? 0)));
  return { timeoutMs: Math.ceil((run * 2) / HOUR_MS) * HOUR_MS, agentTimeoutMs: agent * 2 };
}

// 記録が照らせるのは、状態・Workflow の実行の記録・script の本文の整合まで。ファイルを書き換えた偽造は区別できないので、記録の出所は記録を足す PR の人間のレビューが保証する。
export function evidenceProblems(rec, current) {
  const ev = rec.evidence;
  if (!Array.isArray(ev) || ev.length === 0) return ['本物の Workflow の実行の証拠が無い'];
  const problems = [];
  if (ev[0].key !== rec.source?.key) problems.push('最初の Workflow の実行の key が状態の key と違う');
  const want = current.scripts[roleOfFunction(rec.function)];
  const sib = ev.flatMap((e) => e.siblings ?? []);
  if (ev.some((e) => e.status !== WORKFLOW_DONE && !WORKFLOW_STOPPED.includes(e.status))) problems.push(`Workflow の実行の状態が completed・${WORKFLOW_STOPPED.join('・')} のどれでもない`);
  if (sib.some((e) => !WORKFLOW_STOPPED.includes(e.status))) problems.push(`畳み込んだ Workflow の実行の状態が ${WORKFLOW_STOPPED.join('・')} のどれでもない`);
  if ([...ev, ...sib].some((e) => e.scriptSha !== want)) problems.push('Workflow の実行が走らせた script の本文が今の script と違う');
  if ([...ev, ...sib].some((e) => (e.status === WORKFLOW_DONE || e.resultState !== null) && e.resultState !== rec.state)) problems.push('Workflow の実行の返り値の状態が記録の状態と違う');
  if (ev.at(-1).status !== WORKFLOW_DONE) problems.push('最後の Workflow の実行が completed でない');
  return problems;
}

export async function writeRecord(name, stateId, { top, env = process.env, recordsDir = RECORDS_DIR, configDir = env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude') }) {
  const def = readRuns()[name];
  if (!def) throw new Error(`run が runs.json に無い: ${name}`);
  const skillDir = path.join(top, SKILL_REL);
  const ctx = { cwd: top, env };
  const dir = path.join(resolveStateRoot(ctx), STATES_DIR, stateId);
  const view = buildView(await readAll(dir));
  if (view.state?.function !== def.function) throw new Error(`状態 ${stateId} の機能 ${view.state?.function} が ${name} の ${def.function} と違う`);
  const source = sourceOfState(view);
  const refused = sourceProblems(source, expectedSource(name, readRuns(), def.from ? recordOf(def.from, recordsDir).state : null));
  if (refused.length) throw new Error(`${name} の記録を書かない: ${refused.join('。')}`);
  const evidence = workflowEvidence(view, stateId, configDir);
  const current = fingerprint(skillDir, { entry: def.function === EVAL_FUNCTION });
  const stale = evidenceProblems({ function: def.function, state: stateId, source, evidence }, current);
  if (stale.length) throw new Error(`${name} の記録を書かない: ${stale.join('。')}`);
  const result = await call('outcome', { state: stateId }, ctx);
  const started = startedAt(stateId);
  const out = {
    run: name,
    function: def.function,
    state: stateId,
    target: view.paths[0].root,
    source,
    evidence,
    result,
    launches: launchesOf(view, path.join(skillDir, CRITERIA_DIR)),
    durationMs: started === null ? null : statSync(path.join(dir, 'log.jsonl')).mtimeMs - started,
    fingerprint: current,
  };
  mkdirSync(recordsDir, { recursive: true });
  writeFileSync(path.join(recordsDir, `${name}.json`), `${JSON.stringify(out, null, 2)}\n`);
  if (def.function === 'create' && result.skill?.root && existsSync(result.skill.root)) {
    cpSync(result.skill.root, path.join(recordsDir, `${name}-output`), { recursive: true });
  }
  return out;
}

export async function record(name, stateId, { cwd = process.cwd(), ...rest } = {}) {
  return writeRecord(name, stateId, { top: toplevel(cwd), ...rest });
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
