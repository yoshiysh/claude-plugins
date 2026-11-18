// 担当の起動と返り値の回収（architecture.md「担当の起動」、cli-contract.md「受け箱」、artifact-formats.md「task の一覧」「担当の返り値」
// 「Workflow の返り値」）。task.md に指示の全文を置き、Workflow へは「その file を読む」短い指示だけを渡す。
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, posix, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { AGENT_BATCH_MAX, AuthorReturn, CauseReturn, InboxContent, OUTPUT_SCHEMA, ReviewReturn, WorkflowOutput, conforms } from './schemas.mjs';
import { jsonSchemaOf } from './check-shape.mjs';
import { ROLES, OBLIGATIONS } from './roles.mjs';
import { hashFile } from './storage.mjs';
import { cmpBytes } from './checks/common.mjs';

const SKILL_DIR = fileURLToPath(new URL('../../', import.meta.url));
export const WORKFLOW_SCRIPT = join(SKILL_DIR, 'scripts', 'formal-method-agents.js');
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const INBOX_POLL_MS = 100;

// 返り値の JSON Schema は schemas.mjs の型から導く（値・列挙の正本は schemas.mjs）。
const RETURN_TYPES = { author: AuthorReturn, review: ReviewReturn, cause: CauseReturn };
const returnSchemaText = (kind) => JSON.stringify(jsonSchemaOf(RETURN_TYPES[kind]));
const returnKindOf = (task) => (task.context.perspective ? 'review' : task.role === 'cause-analyst' ? 'cause' : 'author');

// input_refs の指紋（artifact-formats.md「ディレクトリの ref の指紋」）: ファイルはそのまま 1 つ、ディレクトリはその下の全てのファイルに
// 展開する。並びは input_refs の要素の順で、1 つのディレクトリの中だけを ref の UTF-8 のバイト列の辞書順に並べる。読めない要素は入れない。
export function expandRefHashes(runDir, refs) {
  const out = [];
  for (const ref of refs) {
    const p = join(runDir, ref);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isFile()) { out.push({ ref, hash: hashFile(p) }); continue; }
    if (!st.isDirectory()) continue;
    const files = [];
    const walk = (rel) => {
      for (const name of readdirSync(join(runDir, rel))) {
        const r = posix.join(rel, name);
        const s = statSync(join(runDir, r));
        if (s.isDirectory()) walk(r); else if (s.isFile()) files.push(r);
      }
    };
    try { walk(ref.replace(/\/+$/, '')); } catch { continue; }
    files.sort(cmpBytes);
    for (const r of files) out.push({ ref: r, hash: hashFile(join(runDir, r)) });
  }
  return out;
}

// task を作る（task.md を書く前に input_refs の指紋を控える）。
export function makeTask(run, spec) {
  const n = run.nextTaskNo();
  const taskId = `t${String(n).padStart(3, '0')}-${spec.role}`;
  const role = ROLES[spec.role];
  const attemptDir = join(run.runDir, 'attempts', taskId);
  const inputRefs = (spec.input_refs ?? []).filter((x) => x && x.ref);
  const materials = expandRefHashes(run.runDir, inputRefs.map((x) => x.ref));
  const taskMd = join(attemptDir, 'task.md');
  const task = {
    task_id: taskId, role: spec.role, model: role.model, effort: role.effort,
    prompt: `Read ${taskMd} and follow it exactly. It is your complete task.`,
    output_schema: structuredClone(OUTPUT_SCHEMA),
    attempt_dir: attemptDir, return_path: join(attemptDir, 'return.json'),
    context: {
      run_dir: run.runDir, stage: spec.stage, unit_id: spec.unit_id ?? null, perspective: spec.perspective ?? null,
      target_id: spec.target_id ?? null, model_id: spec.model_id ?? null, property_ids: spec.property_ids ?? [],
      candidates: spec.candidates ?? [], subject: spec.subject ?? null, input_refs: inputRefs.map((x) => ({ name: x.name, ref: x.ref })),
      revise_defects_ref: spec.revise_defects_ref ?? null,
    },
  };
  const { prompt, ...rest } = task;
  const md = [
    '## ROLE', `${join(SKILL_DIR, role.instructions)}`, `${join(SKILL_DIR, OBLIGATIONS)}`, '',
    '## TASK', JSON.stringify(rest), '',
    '## RETURN_SCHEMA', returnSchemaText(returnKindOf(task)), '',
    '## WRITE', `書いてよい領域: ${attemptDir}`, `返り値を書く path: ${task.return_path}`, '最後の応答: {"task_id": "<task_id>", "return_path": "<return_path>"} だけ', '',
  ].join('\n');
  return { task, md, materials };
}

const isFile = (p) => { try { return statSync(p).isFile(); } catch { return false; } };

// 返り値の照合（成功に数えるか）。戻り値: { ok: true, ret } | { ok: false, cause }
export function collectReturn(task) {
  let ret;
  try { ret = JSON.parse(readFileSync(task.return_path, 'utf8')); } catch (e) {
    return { ok: false, cause: existsSync(task.return_path) ? '返り値が JSON でない' : '返り値が無い' };
  }
  const kind = returnKindOf(task);
  const type = RETURN_TYPES[kind];
  if (!conforms(type, ret)) return { ok: false, cause: '返り値の形が違う' };
  if (ret.task_id !== task.task_id) return { ok: false, cause: '返り値の task_id が task と違う' };
  if (kind !== 'author' && ret.unit_id !== task.context.unit_id) return { ok: false, cause: '返り値の unit_id が task と違う' };
  if (kind === 'review' && ret.perspective !== task.context.perspective) return { ok: false, cause: '返り値の perspective が task と違う' };
  const prefix = relative(task.context.run_dir, task.attempt_dir) + '/';
  const refs = [ret.worklog_ref, ...(kind === 'author' ? ret.outputs.map((o) => o.ref) : [ret.record_ref])];
  for (const ref of refs) {
    if (!ref.startsWith(prefix)) return { ok: false, cause: `参照 ${ref} が attempt の領域の外` };
    if (!isFile(join(task.context.run_dir, ref))) return { ok: false, cause: `参照 ${ref} が存在しない` };
  }
  if (kind === 'author') {
    const bad = blockedByViolation(task, ret);
    if (bad) return { ok: false, cause: `返り値の形が違う（${bad}）` };
  }
  if (kind === 'author' && ret.status === 'cannot_proceed') return { ok: false, cause: `cannot_proceed を返した（${ret.reason ?? '理由なし'}）` };
  if (kind === 'author' && ret.status === 'needs_answer' && ret.questions.length === 0) return { ok: false, cause: 'needs_answer なのに問いが無い' };
  if (kind === 'cause' && ret.cause === '要求の不足' && ret.questions.length === 0) return { ok: false, cause: '要求の不足 なのに問いが無い' };
  return { ok: true, ret };
}

// AuthorReturn.blocked_by_question は性質の id（artifact-formats.md「AuthorReturn.blocked_by_question」）。違反の文か null。
function blockedByViolation(task, ret) {
  const ids = ret.blocked_by_question;
  if (task.role === 'extractor') {
    if (ret.status === 'cannot_proceed') return null;
    const o = ret.outputs.find((x) => x.kind === 'inventory');
    let props = [];
    try { props = o ? JSON.parse(readFileSync(join(task.context.run_dir, o.ref), 'utf8')).properties : []; } catch { return null; }
    if (!Array.isArray(props)) return null;
    const known = new Set(props.map((p) => p && p.id));
    const blocked = props.filter((p) => p && Array.isArray(p.blocked_by_question) && p.blocked_by_question.length > 0).map((p) => p.id);
    const unknown = ids.filter((id) => !known.has(id));
    if (unknown.length) return `blocked_by_question の ${unknown.join(', ')} が inventory の性質に無い`;
    if (new Set(ids).size !== blocked.length || !blocked.every((id) => ids.includes(id))) return 'blocked_by_question が inventory の性質ごとの blocked_by_question と一致しない';
    return null;
  }
  if (task.role === 'model-author' || task.role === 'plan-author') {
    const unknown = ids.filter((id) => !task.context.property_ids.includes(id));
    if (unknown.length) return `blocked_by_question の ${unknown.join(', ')} が context.property_ids に無い`;
  }
  return null;
}

// 受け箱と Workflow の返り値を読み、batch の拒否の原因を返す（拒否でなければ null）。
function rejectionCause(run, list, deadline) {
  const box = join(run.runDir, 'inbox', `${list.batch_id}.json`);
  const readAt = Date.now();
  let text;
  try { text = readFileSync(box, 'utf8'); } catch { return '受け箱を読めない'; }
  let content;
  try { content = JSON.parse(text); } catch { return '受け箱が JSON でない'; }
  if (!conforms(InboxContent, content)) return '受け箱が形に合わない';
  if (content.batch_id !== list.batch_id) return '受け箱の batch_id が開いている batch と違う';
  if (content.timed_out === true) return '受け箱が timed_out: true';
  if (readAt >= deadline) return '期限の後に受け箱を読んだ';
  let wf;
  try { wf = JSON.parse(readFileSync(content.workflow_output_path, 'utf8')); } catch { return 'Workflow の返り値のファイルを読めない'; }
  if (!conforms(WorkflowOutput, wf)) return 'Workflow の返り値が形に合わない';
  if (wf.batch_id !== list.batch_id) return 'Workflow の返り値の batch_id が開いている batch と違う';
  const ids = wf.results.map((r) => r.task_id);
  const want = list.tasks.map((t) => t.task_id);
  if (new Set(ids).size !== ids.length || ids.length !== want.length || !want.every((id) => ids.includes(id))) return 'Workflow の返り値の task の集合が tasks.json と違う';
  for (const r of wf.results) {
    const t = list.tasks.find((x) => x.task_id === r.task_id);
    const expect = { task_id: t.task_id, prompt: t.prompt, model: t.model, effort: t.effort, output_schema: t.output_schema };
    if (!isDeepStrictEqual(r.received, expect)) return `Workflow の返り値の received が tasks.json の task ${t.task_id} と違う`;
  }
  run.lastWorkflowOutput = wf;
  return null;
}

// batch を出して回収する。specs は AGENT_BATCH_MAX 件ずつ順に出す。
// 戻り値: [{ task, ok, ret?, cause?, rejected? }]。時間の上限で出せなければ notIssued の要素を返す。
export async function runTasks(run, specs) {
  const out = [];
  for (let i = 0; i < specs.length; i += AGENT_BATCH_MAX) {
    const chunk = specs.slice(i, i + AGENT_BATCH_MAX);
    if (run.halted()) { for (const s of chunk) out.push({ spec: s, task: null, ok: false, notIssued: true }); continue; }
    const deadline = run.clock.batchDeadlineWall();
    if (run.clock.limited && (run.clock.usableExpired() || deadline <= Date.now())) {
      run.timeLimitReached('担当の batch を出す時点で、検査に使える期限が過ぎていた');
      for (const s of chunk) out.push({ spec: s, task: null, ok: false, notIssued: true });
      continue;
    }
    const made = chunk.map((s) => ({ spec: s, ...makeTask(run, s) }));
    const batchId = `batch-${String(run.nextBatchNo()).padStart(3, '0')}`;
    let saved = true;
    for (const m of made) {
      if (!run.writeRecordFile(join('attempts', m.task.task_id, 'task.md'), m.md, { kind: 'worklog', register: false })) saved = false;
    }
    const list = { batch_id: batchId, deadline_wall_ms: deadline, tasks: made.map((m) => m.task) };
    const tasksRef = join('batches', batchId, 'tasks.json');
    if (saved && !run.writeRecordFile(tasksRef, JSON.stringify(list, null, 2), { kind: 'worklog', register: false })) saved = false;
    if (!saved) {
      for (const m of made) out.push({ spec: m.spec, task: null, ok: false, notIssued: true });
      continue;
    }
    for (const m of made) run.tasks.set(m.task.task_id, { task: m.task, materials: m.materials });
    run.writeStatus('run_agents', { batch_id: batchId, tasks_path: join(run.runDir, tasksRef), deadline_wall_ms: deadline, workflow_script: WORKFLOW_SCRIPT });
    const box = join(run.runDir, 'inbox', `${batchId}.json`);
    while (!existsSync(box) && Date.now() < deadline) await sleep(INBOX_POLL_MS);
    const cause = existsSync(box) ? rejectionCause(run, list, deadline) : `期限（deadline_wall_ms ${deadline}）までに受け箱が公開されなかった`;
    if (cause) {
      for (const m of made) {
        const detail = `batch ${batchId} の task ${m.task.task_id} の返り値を使わない（batch の拒否）: ${cause}`;
        out.push({ spec: m.spec, task: m.task, ok: false, rejected: true, cause: detail, materials: m.materials });
      }
    } else {
      const wf = run.lastWorkflowOutput;
      for (const m of made) {
        const r = wf.results.find((x) => x.task_id === m.task.task_id);
        if (r.status !== 'returned') {
          out.push({ spec: m.spec, task: m.task, ok: false, cause: `task ${m.task.task_id} の返り値を成功に数えない: Workflow の結末が ${r.status}${r.error ? `（${r.error}）` : ''}`, materials: m.materials });
          continue;
        }
        const c = collectReturn(m.task);
        if (c.ok) out.push({ spec: m.spec, task: m.task, ok: true, ret: c.ret, materials: m.materials });
        else out.push({ spec: m.spec, task: m.task, ok: false, cause: `task ${m.task.task_id} の返り値を成功に数えない: ${c.cause}`, materials: m.materials });
      }
    }
    for (const o of out.slice(-made.length)) if (!o.ok && o.task) run.agentFailed(o.task, o.cause);
    run.writeStatus('working', null);
  }
  return out;
}
