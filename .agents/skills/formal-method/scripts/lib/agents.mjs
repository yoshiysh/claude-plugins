// 担当の task と返り値の照合（architecture.md「担当の起動」、artifact-formats.md「claim の Task」「担当の返り値」）。
// task の起動と受け渡しは call.mjs（claim・query・submit・close）が持ち、ここは task の形と返り値の照合だけを持つ。
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, posix, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AuthorReturn, CauseReturn, ReviewReturn, conforms } from './schemas.mjs';
import { jsonSchemaOf } from './check-shape.mjs';
import { ROLES, OBLIGATIONS } from './roles.mjs';
import { hashFile } from './storage.mjs';
import { cmpBytes } from './checks/common.mjs';

const SKILL_DIR = fileURLToPath(new URL('../../', import.meta.url));
export const WORKFLOW_SCRIPT = join(SKILL_DIR, 'scripts', 'formal-method-agents.js');

// 返り値の JSON Schema は schemas.mjs の型から導く（値・列挙の正本は schemas.mjs）。
const RETURN_TYPES = { author: AuthorReturn, review: ReviewReturn, cause: CauseReturn };
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

// input_refs の資料のバイト数の和（ディレクトリはその下の全てのファイル）。1 体に詰める量（UNIT_MAX_BYTES）と比べる。読めない要素は数えない。
export function refsBytes(runDir, refs) {
  let n = 0;
  const walk = (p) => {
    let st;
    try { st = statSync(p); } catch { return; }
    if (st.isFile()) { n += st.size; return; }
    if (!st.isDirectory()) return;
    let names = [];
    try { names = readdirSync(p); } catch { return; }
    for (const name of names) walk(join(p, name));
  };
  for (const ref of refs) walk(join(runDir, ref));
  return n;
}

// task を作る。資料（input_refs）は claim では渡さず、query が返してその時点の指紋を固定する（artifact-formats.md「claim の Task」）。
export function makeTask(run, spec) {
  const n = run.nextTaskNo();
  const taskId = `t${String(n).padStart(3, '0')}-${spec.role}`;
  const role = ROLES[spec.role];
  const attemptDir = join(run.runDir, 'attempts', taskId);
  const inputRefs = (spec.input_refs ?? []).filter((x) => x && x.ref);
  const task = {
    task_id: taskId, role: spec.role, model: role.model, effort: role.effort,
    instructions: [join(SKILL_DIR, role.instructions), join(SKILL_DIR, OBLIGATIONS)],
    attempt_dir: attemptDir, result_path: join(attemptDir, 'return.json'),
    context: {
      run_dir: run.runDir, stage: spec.stage, unit_id: spec.unit_id ?? null, perspective: spec.perspective ?? null,
      target_id: spec.target_id ?? null, model_id: spec.model_id ?? null, property_ids: spec.property_ids ?? [],
      candidates: spec.candidates ?? [], subject: spec.subject ?? null,
    },
  };
  task.return_schema = jsonSchemaOf(RETURN_TYPES[returnKindOf(task)]);
  return { task, inputRefs: inputRefs.map((x) => ({ name: x.name, ref: x.ref })) };
}

const isFile = (p) => { try { return statSync(p).isFile(); } catch { return false; } };

// 返り値の照合（成功に数えるか）。戻り値: { ok: true, ret } | { ok: false, cause, final? }
export function collectReturn(task) {
  let ret;
  try { ret = JSON.parse(readFileSync(task.result_path, 'utf8')); } catch {
    return { ok: false, cause: existsSync(task.result_path) ? '返り値が JSON でない' : '返り値が無い' };
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
  // cannot_proceed は担当の最後の答えなので、出し直させない（final）
  if (kind === 'author' && ret.status === 'cannot_proceed') return { ok: false, final: true, cause: `cannot_proceed を返した（${ret.reason ?? '理由なし'}）` };
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
