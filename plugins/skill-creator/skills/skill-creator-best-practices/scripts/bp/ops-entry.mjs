import path from 'node:path';
import {
  CODES, ENTRY_OPS, FUNCTION, FUNCTIONS, GROUND_INSTRUCTION, GROUND_REF_KEY, INPUT_KEYS, INSPECTING_FUNCTIONS, LAUNCH_KINDS, NEXT_ARGS_KEYS,
  RESULT_KEYS, REWRITING_FUNCTIONS, ROUTES, STOP_KINDS, WORKFLOW_SOURCES,
} from './constants.mjs';
import { resolveCallsites } from './callsites.mjs';
import { checkFunction } from './checks.mjs';
import { reject } from './errors.mjs';
import { conformanceTable, conformanceValue } from './kinds.mjs';
import { outcome } from './ops-author.mjs';
import { list } from './ops-run.mjs';
import { readState } from './store.mjs';
import { currentRun } from './view.mjs';

// 入口だけが使う runner の request の値。試走の記録の指紋に入れないファイルに置く（実測で値を書き戻しても、run の中の処理が変わらないので記録を古くしない）。
// maxAgents は runner が受ける上限そのもの（native の run は上限を持たないので、上限の役目は runner に収めることだけ：SP-BPENTRY-015）。
// timeoutMs は実測までの暫定で、旧 caller の先例の値。runner の既定の 60 秒に任せない（TBD-SBPENTRY-001 の保持規則）。
export const RUNNER_REQUEST = Object.freeze({ maxAgents: 1000, timeoutMs: 3_600_000, mode: 'workspace-write' });

// SP-BPFINDINGS-029 の項目のうち、どの指摘にも載る欄（状態・状態を記録した run・見直しの判定・却下の理由は、載せない指摘がある）。
export const FINDING_REQUIRED = Object.freeze(['id', 'function', 'viewpoint', 'kind', 'assets', 'quote', 'content', 'fix', 'judgedOnCurrent']);

const RESUME_TODO = Object.freeze({
  [STOP_KINDS.needsInput]: '利用者の回答を answer に足して、next_args で再開する',
  [STOP_KINDS.blocked]: '止まった理由の原因を直してから、next_args で再開する',
  [STOP_KINDS.iterationLimit]: 'next_args で再開する',
});
const RESTART_TODO = '状態が作られていないので、入力を直して新しく起動する';

function needFunctions(functions) {
  if (!Array.isArray(functions) || functions.length === 0) reject(CODES.input, 'functions は機能の並び（1 つ以上）でなければならない');
  functions.forEach(checkFunction);
}

function needStrings(value, name) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((s) => typeof s !== 'string' || s === '')) reject(CODES.input, `${name} は空でない文字列の並びでなければならない`);
  return value;
}

// SP-BPENTRY-019: create の入力は依頼文だけで前の機能の結果を渡す形が無いので、create を先頭以外に置く列は組めない。
export async function chainCheck(ctx, req) {
  needFunctions(req.functions);
  const late = req.functions.findIndex((f, i) => i > 0 && f === FUNCTION.create);
  if (late < 0) return { functions: req.functions, buildable: true };
  return {
    functions: req.functions,
    buildable: false,
    reason: `機能の列を組めない: ${late + 1} 番目の create が先頭にない。create の入力は依頼文だけで、前の機能の結果を渡す形が無い（SP-BPENTRY-019）`,
  };
}

function excludedOf(r) {
  return r.unresolved.map((u) => ({ ...u, file: path.join(r.root, 'SKILL.md') }));
}

function missingFields(findings) {
  if (!Array.isArray(findings)) return [{ finding: null, fields: [RESULT_KEYS.findings] }];
  return findings.flatMap((f, i) => {
    const fields = FINDING_REQUIRED.filter((k) => f === null || typeof f !== 'object' || f[k] === undefined);
    return fields.length ? [{ finding: f?.id ?? i, fields }] : [];
  });
}

// SP-BPENTRY-007〜010・020: 次の run の入力を前の run の状態から作る。指摘は状態 ID の参照で渡し、入口に書き写させない（書き写しは同じバイト列を保てない）。
export async function chainNext(ctx, req) {
  checkFunction(req.next);
  if (req.next === FUNCTION.create) reject(CODES.input, 'create は列の先頭にしか置けない（SP-BPENTRY-019）。chain-check で組めない列を先に断る');
  const instructions = needStrings(req.instructions, 'instructions');
  const { view } = await readState(ctx, req.state);
  const prev = view.state.function;
  if (!view.stops.has(currentRun(view).id)) {
    return { proceed: false, previous: prev, stopKind: null, reason: `前の ${prev} の run がまだ止まっていない（返り値を返していない）ので、次の ${req.next} を起動しない（SP-BPENTRY-007）` };
  }
  const result = await outcome(ctx, { state: req.state });
  if (result[RESULT_KEYS.stopKind] !== STOP_KINDS.complete) {
    return { proceed: false, previous: prev, stopKind: result[RESULT_KEYS.stopKind], reason: `前の ${prev} の run が完了で止まっていないので、次の ${req.next} を起動しない（SP-BPENTRY-008）` };
  }
  const missing = req.next === FUNCTION.update && INSPECTING_FUNCTIONS.has(prev) ? missingFields(result[RESULT_KEYS.findings]) : [];
  if (missing.length) {
    return { proceed: false, previous: prev, stopKind: STOP_KINDS.complete, missing, reason: `前の ${prev} の返り値の指摘の一覧が SP-BPFINDINGS-029 の項目を欠くので、update を起動しない（SP-BPENTRY-020）` };
  }
  let target;
  let excludedCallsites = [];
  if (REWRITING_FUNCTIONS.has(prev)) {
    // create・update の後は自分の plugin の workflow script が増減しうるので、パスの一覧を作り直す（SP-BPENTRY-009 の表の後の段落）。
    const root = prev === FUNCTION.create ? result[RESULT_KEYS.skill].root : view.paths[0].root;
    const r = resolveCallsites(root);
    target = { root: r.root, files: r.files };
    excludedCallsites = excludedOf(r);
  } else {
    const p = view.paths.at(-1);
    target = { root: p.root, files: p.files };
  }
  const input = { [INPUT_KEYS.function]: req.next, [INPUT_KEYS.target]: target };
  if (req.next === FUNCTION.update) {
    input[INPUT_KEYS.grounds] = [
      ...(INSPECTING_FUNCTIONS.has(prev) ? [{ [GROUND_REF_KEY]: req.state }] : []),
      ...instructions.map((text) => ({ [GROUND_INSTRUCTION.kindKey]: GROUND_INSTRUCTION.kind, [GROUND_INSTRUCTION.textKey]: text })),
    ];
  }
  return { proceed: true, previous: prev, input, excludedCallsites };
}

const NEW_KEYS = Object.freeze({
  [FUNCTION.create]: [INPUT_KEYS.function, INPUT_KEYS.request, INPUT_KEYS.target],
  [FUNCTION.update]: [INPUT_KEYS.function, INPUT_KEYS.target, INPUT_KEYS.grounds],
  [FUNCTION.review]: [INPUT_KEYS.function, INPUT_KEYS.target],
  [FUNCTION.audit]: [INPUT_KEYS.function, INPUT_KEYS.target],
});
const RESUME_KEYS = Object.freeze([INPUT_KEYS.nextArgs, INPUT_KEYS.answer]);

export function sourceOf(fn) {
  return REWRITING_FUNCTIONS.has(fn) ? WORKFLOW_SOURCES.author : WORKFLOW_SOURCES.inspect;
}

export function modelNames(criteriaDir) {
  return [...new Set(conformanceTable(criteriaDir, 'SP-BPCONFORMANCE-035', 'best-practices の役').rows.map((r) => r[1].replace(/`/g, '')))];
}

// SP-BPENTRY-013・015・016: Workflow の args と、Codex runner の経路の request の項目を作る。入口は出力を書き換えずに渡す。
export async function launchArgs(ctx, req) {
  if (!Object.values(ROUTES).includes(req.route)) reject(CODES.input, `route は ${Object.values(ROUTES).join('・')} のどれか`);
  if (!Object.values(LAUNCH_KINDS).includes(req.launch)) reject(CODES.input, `launch は ${Object.values(LAUNCH_KINDS).join('・')} のどれか`);
  if (typeof req.key !== 'string' || req.key === '') reject(CODES.input, 'key は key の操作で得た文字列');
  const input = req.input;
  if (input === null || typeof input !== 'object' || Array.isArray(input)) reject(CODES.input, 'input はオブジェクトでなければならない');
  let fn;
  let allowed;
  if (req.launch === LAUNCH_KINDS.new) {
    checkFunction(input[INPUT_KEYS.function]);
    fn = input[INPUT_KEYS.function];
    allowed = NEW_KEYS[fn];
    for (const k of allowed) if (!Object.hasOwn(input, k)) reject(CODES.input, `新しい状態での ${fn} の起動に ${k} が無い（SP-BPENTRY-013）`);
  } else {
    const na = input[INPUT_KEYS.nextArgs];
    if (!na || typeof na !== 'object' || typeof na[NEXT_ARGS_KEYS.state] !== 'string') reject(CODES.input, '再開の起動に nextArgs が無い（SP-BPENTRY-013）');
    checkFunction(na[NEXT_ARGS_KEYS.function]);
    fn = na[NEXT_ARGS_KEYS.function];
    allowed = RESUME_KEYS;
  }
  const stray = Object.keys(input).filter((k) => !allowed.includes(k));
  if (stray.length) reject(CODES.input, `${req.launch === LAUNCH_KINDS.new ? '新しい状態での起動' : '再開'}の ${fn} に渡さない項目がある: ${stray.join(', ')}（SP-BPENTRY-013）`);
  const args = { ...input, [INPUT_KEYS.skillDir]: ctx.skillDir, [INPUT_KEYS.key]: req.key };
  const out = { route: req.route, source: sourceOf(fn), args };
  if (req.route === ROUTES.codex) {
    args[INPUT_KEYS.maxLaunches] = RUNNER_REQUEST.maxAgents;
    out.request = {
      limits: { maxAgents: RUNNER_REQUEST.maxAgents, timeoutMs: RUNNER_REQUEST.timeoutMs, concurrency: conformanceValue(ctx.criteriaDir, 'SP-BPCONFORMANCE-027', '体') },
      modelMap: Object.fromEntries(modelNames(ctx.criteriaDir).map((m) => [m, null])),
      workspace: { mode: RUNNER_REQUEST.mode },
      requirements: [RUNNER_REQUEST.mode],
    };
  }
  return out;
}

function resumeOf(result) {
  const na = result[RESULT_KEYS.nextArgs];
  if (na) return { nextArgs: na, todo: RESUME_TODO[result[RESULT_KEYS.stopKind]] };
  return { nextArgs: null, todo: RESTART_TODO };
}

async function runResult(ctx, run) {
  if (run && typeof run === 'object' && typeof run.state === 'string' && Object.keys(run).length === 1) {
    const { view } = await readState(ctx, run.state);
    const result = await outcome(ctx, { state: run.state });
    const p = view.paths[0];
    // review・audit は対象を書き換えず、状態のパスの一覧は外した callsite を持たないので、一覧の根から解き直す（SP-BPENTRY-023）。
    const excluded = INSPECTING_FUNCTIONS.has(view.state.function) ? excludedOf(resolveCallsites(p.root)) : (result[RESULT_KEYS.excludedCallsites] ?? []);
    return { function: view.state.function, result, excluded };
  }
  if (run && typeof run === 'object' && run.result && typeof run.result === 'object' && FUNCTIONS.includes(run.function) && Object.keys(run).length === 2) {
    if (run.result[RESULT_KEYS.state] !== undefined) reject(CODES.input, '状態のある run は {"state": <状態 ID>} で渡す（返り値は状態から作り直す）');
    return { function: run.function, result: run.result, excluded: [] };
  }
  reject(CODES.input, `runs の要素は {"state"} か、状態を作らずに止まった run の {"function", "result"}: ${JSON.stringify(run)}`);
}

// SP-BPENTRY-017・021・023: 利用者への返り値を、状態から機能の列の順に組み立てる。
export async function chainReport(ctx, req) {
  needFunctions(req.functions);
  if (!Array.isArray(req.runs) || req.runs.length > req.functions.length) reject(CODES.input, 'runs は起動した run の並び（機能の列より長くない）');
  const unmatched = needStrings(req.unmatched, 'unmatched');
  const runs = [];
  for (const [i, r] of req.runs.entries()) {
    const one = await runResult(ctx, r);
    if (one.function !== req.functions[i]) reject(CODES.input, `${i + 1} 番目の run の機能 ${one.function} が列の ${req.functions[i]} と違う`);
    runs.push(one);
  }
  const out = { results: runs.map((r) => r.result) };
  const last = runs.at(-1)?.result;
  const failure = req.hostFailure;
  if (failure !== undefined && (typeof failure !== 'string' || failure === '')) reject(CODES.input, 'hostFailure は host が返した失敗の文言');
  const stopped = failure !== undefined || (last !== undefined && last[RESULT_KEYS.stopKind] !== STOP_KINDS.complete);
  const launched = failure !== undefined ? runs.length + 1 : runs.length;
  if (launched > req.functions.length) reject(CODES.input, 'hostFailure の run が機能の列に無い');
  const unexecuted = req.functions.slice(launched);
  if (stopped && unexecuted.length) out.unexecuted = unexecuted;
  if (failure !== undefined) {
    const fn = req.functions[runs.length];
    if (!req.target || typeof req.target.root !== 'string') reject(CODES.input, 'hostFailure には失敗した起動の target が要る（未完了の状態を列挙する）');
    out.hostFailure = { function: fn, failure, resumable: (await list(ctx, { function: fn, target: req.target })).states };
  } else if (stopped) {
    out.resume = resumeOf(last);
  }
  if (unmatched.length) out.unmatched = unmatched;
  const excluded = runs.flatMap((r, i) => r.excluded.map((e) => ({ run: i + 1, ...e })));
  if (excluded.length) out.excludedCallsites = excluded;
  return out;
}

export const HANDLERS = Object.freeze({
  [ENTRY_OPS.chainCheck]: chainCheck,
  [ENTRY_OPS.chainNext]: chainNext,
  [ENTRY_OPS.launchArgs]: launchArgs,
  [ENTRY_OPS.chainReport]: chainReport,
});
