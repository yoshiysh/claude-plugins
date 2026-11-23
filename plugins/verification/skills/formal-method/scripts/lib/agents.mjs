// 担当の task と返り値の照合（architecture.md「担当の起動」、artifact-formats.md「claim の Task」「担当の返り値」）。
// task の起動と受け渡しは call.mjs（claim・query・submit・close）が持ち、ここは task の形と返り値の照合だけを持つ。
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, posix, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AuthorReturn, CauseReturn, ReviewReturn, conforms, parseSpan } from './schemas.mjs';
import { jsonSchemaOf } from './check-shape.mjs';
import { fileLines, parseTargetRef, spanText } from './target-refs.mjs';
import { ROLES, instructionsOf } from './roles.mjs';
import { DOC_RULES_PATH } from './worklog.mjs';
import { hashFile } from './storage.mjs';
import { sha256Bytes } from './canonical.mjs';
import { cmpBytes } from './checks/common.mjs';

const SKILL_DIR = fileURLToPath(new URL('../../', import.meta.url));
// Workflow script の置き場は plugin の workflows/（skill-creator-best-practices の best-practices.md §13「script の置き場」）。
export const WORKFLOW_SCRIPT = join(SKILL_DIR, '..', '..', 'workflows', 'formal-method-agents.js');

// 返り値の JSON Schema は schemas.mjs の型から導く（値・列挙の正本は schemas.mjs）。
const RETURN_TYPES = { author: AuthorReturn, review: ReviewReturn, cause: CauseReturn };
const returnKindOf = (task) => (task.context.perspective ? 'review' : task.role === 'cause-analyst' ? 'cause' : 'author');
// task の返り値の形。claim と submit の next は、これを役ごとに 1 度だけ応答の最上位に置く（return_schemas）
export const returnSchemaOf = (task) => jsonSchemaOf(RETURN_TYPES[returnKindOf(task)]);

// input_refs の指紋（artifact-formats.md「ディレクトリの ref の指紋」）: ファイルはそのまま 1 つ、ディレクトリはその下の全てのファイルに
// 展開する。並びは input_refs の要素の順で、1 つのディレクトリの中だけを ref の UTF-8 のバイト列の辞書順に並べる。読めないファイルと、
// 実在しない対象の ref は hash: 'unreadable' で入れる。実在しない run の ref、辿れないディレクトリ、ファイルでもディレクトリでもない要素は入れない。
// pathOf(ref) は読む path（対象の ref は元のファイル。target-refs.mjs の refPathOf）。対象の ref はファイルだけを指す。
// refs の要素は ref の文字列か { ref, spans? }。spans を持つ対象の ref は、ファイル全体の指紋に加えて、範囲ごとの指紋 spans: [{ span, hash }] を持つ。
const UNREADABLE = 'unreadable';
export function expandRefHashes(runDir, refs, pathOf = (ref) => join(runDir, ref)) {
  const out = [];
  for (const item of refs) {
    const ref = typeof item === 'string' ? item : item.ref;
    const spans = typeof item === 'string' ? null : item.spans ?? null;
    const p = pathOf(ref);
    if (p === null) continue;
    let st;
    try { st = statSync(p); } catch { if (parseTargetRef(ref)) out.push({ ref, hash: UNREADABLE }); continue; }
    if (st.isFile()) {
      // 読めないファイルは例外にせず unreadable として記録する（対象のファイルなら、集約の段の照合で 対象の変化 になる）
      let bytes;
      try { bytes = readFileSync(p); } catch { out.push({ ref, hash: UNREADABLE }); continue; }
      if (!spans) { out.push({ ref, hash: sha256Bytes(bytes) }); continue; }
      const lines = fileLines(bytes);
      out.push({ ref, hash: sha256Bytes(bytes), spans: spans.map((span) => ({ span, hash: sha256Bytes(Buffer.from(spanText(lines, span), 'utf8')) })) });
      continue;
    }
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
    for (const r of files) { let hash; try { hash = hashFile(join(runDir, r)); } catch { hash = UNREADABLE; } out.push({ ref: r, hash }); }
  }
  return out;
}

// input_refs の資料のファイルごとのバイト数（run の領域からの相対 path → バイト数。ディレクトリはその下の全てのファイル）。
// 1 体に詰める量は、詰めた単位のこの Map の和集合で数える（call.mjs の packByUnion）。読めない要素は入れない。
// 範囲を持つ対象の ref は、範囲の行ごとに <ref>#L<n> → その行のバイト数 + 1（改行）で数える（重なった範囲は和集合で 1 度だけ数える）。
export function refFiles(runDir, refs, pathOf = null) {
  const out = new Map();
  const spansOf = new Map(refs.filter((x) => typeof x !== 'string' && x.spans).map((x) => [x.ref, x.spans]));
  const walk = (rel) => {
    const own = pathOf && parseTargetRef(rel) ? pathOf(rel) : null;
    if (own !== null && spansOf.has(rel)) {
      let lines;
      try { lines = fileLines(readFileSync(own)); } catch { return; }
      for (const span of spansOf.get(rel)) {
        const p = parseSpan(span);
        if (!p) throw new Error(`読めない Span: ${JSON.stringify(span)}`);
        for (let i = p.from; i <= Math.min(p.to, lines.length); i += 1) out.set(`${rel}#L${i}`, Buffer.byteLength(lines[i - 1], 'utf8') + 1);
      }
      return;
    }
    if (own !== null) { try { out.set(rel, statSync(own).size); } catch { /* 読めない要素は入れない */ } return; }
    let st;
    try { st = statSync(join(runDir, rel)); } catch { return; }
    if (st.isFile()) { out.set(rel, st.size); return; }
    if (!st.isDirectory()) return;
    let names = [];
    try { names = readdirSync(join(runDir, rel)); } catch { return; }
    for (const name of names) walk(posix.join(rel, name));
  };
  for (const item of refs) { const ref = typeof item === 'string' ? item : item.ref; walk(parseTargetRef(ref) ? ref : posix.normalize(ref).replace(/\/+$/, '')); }
  return out;
}

// ---- 担当の下書きを CLI が補う（agent-obligations.md「作業記録」、artifact-formats.md「作業記録」「inventory」） ----
// 指紋は CLI が持つ。担当が書かなかった指紋は補い、書いた指紋は照らして、違えば欠陥の文を返す。戻り値は { worklog, problems, changed }。
// materials は最初の query の時点で固定した指紋（[RefHash]。渡した資料と範囲）。補うのは materials にある ref と範囲だけで、
// 無い ref と範囲（渡していない資料、query を流さなかった担当の資料）は今のファイルで求めず、指紋を書いていても欠陥にする。
// 理由: 作業記録の inputs は渡した資料のうち読んだもので、渡していないものの指紋を補うと、渡していない資料を読んだ記録が通る。
// inputs が配列でない作業記録は、作業記録の下書きでないので何もしない（形は登録の側の照合に任せる）。
export function completeWorklog(worklog, { materials = [], docRules = null }) {
  if (!worklog || typeof worklog !== 'object' || !Array.isArray(worklog.inputs)) return { worklog, problems: [], changed: false };
  const fixed = new Map((materials ?? []).map((m) => [m.ref, m]));
  const problems = [];
  let changed = false;
  const fill = (obj, key, want, what) => {
    if (obj[key] === undefined) { obj[key] = want; changed = true; return; }
    if (obj[key] !== want) problems.push(`作業記録の inputs の ${what} の指紋 ${obj[key]} が渡した資料の指紋 ${want} と違う`);
  };
  const inputs = worklog.inputs.map((x) => {
    if (!x || typeof x !== 'object' || typeof x.ref !== 'string') return x;
    const m = fixed.get(x.ref);
    if (!m) { problems.push(`作業記録の inputs の ${x.ref} は渡していない資料（query の資料に無い）`); return x; }
    const out = { ...x };
    fill(out, 'hash', m.hash, x.ref);
    if (Array.isArray(x.spans)) {
      out.spans = x.spans.map((sp) => {
        if (!sp || typeof sp !== 'object' || !parseSpan(sp.span)) { problems.push(`作業記録の inputs の ${x.ref} の範囲 ${JSON.stringify(sp?.span ?? sp)} を読めない`); return sp; }
        const own = m.spans?.find((y) => y.span === sp.span);
        if (!own) { problems.push(`作業記録の inputs の ${x.ref} の ${sp.span} は渡していない範囲（query の spans に無い）`); return sp; }
        const o = { ...sp };
        fill(o, 'hash', own.hash, `${x.ref} の ${sp.span}`);
        return o;
      });
    }
    return out;
  });
  const next = { ...worklog, inputs };
  if (docRules) {
    if (worklog.document_rules === undefined) { next.document_rules = { ref: docRules.ref, version: docRules.version }; changed = true; }
    else if (!worklog.document_rules || worklog.document_rules.ref !== docRules.ref || worklog.document_rules.version !== docRules.version) {
      problems.push(`作業記録の document_rules が claim の document_rules（${docRules.ref}・${docRules.version}）と違う`);
    }
  }
  return { worklog: next, problems, changed };
}

// inventory の要素の quote_hash を、出所の行から補う（書いた値の照合は coverage.mjs の洗い出しの照合が持つ）。
// textOf(target_id, file) は受付で固定した対象のファイルの文字列か null。読めない出所・読めない Span は補わない（照合が欠陥にする）。
export function completeQuoteHashes(inventory, textOf) {
  if (!inventory || typeof inventory !== 'object' || !Array.isArray(inventory.elements)) return { inventory, changed: false };
  let changed = false;
  const elements = inventory.elements.map((e) => {
    const src = e && typeof e === 'object' ? e.source : null;
    if (!src || typeof src !== 'object' || src.quote_hash !== undefined || !parseSpan(src.span)) return e;
    const text = textOf(src.target_id, src.file);
    if (typeof text !== 'string') return e;
    changed = true;
    return { ...e, source: { ...src, quote_hash: sha256Bytes(Buffer.from(spanText(fileLines(Buffer.from(text, 'utf8')), src.span), 'utf8')) } };
  });
  return { inventory: changed ? { ...inventory, elements } : inventory, changed };
}

// 適用する文書の一般規約のファイル（task の instructions の 4 つ目）: run の領域の写し（document-rules/<指紋>.md）。受付で写しを
// 保存できなかったときは、同じ版の規約の正本（references/document-rules.md）
const docRulesPathOf = (run) => (run.docRules ? join(run.runDir, run.docRules.ref) : DOC_RULES_PATH);

// task を作る。資料（input_refs）は claim では渡さず、query が返してその時点の指紋を固定する（artifact-formats.md「claim の Task」）。
export function makeTask(run, spec) {
  const n = run.nextTaskNo();
  const taskId = `t${String(n).padStart(3, '0')}-${spec.role}`;
  const role = ROLES[spec.role];
  const attemptDir = join(run.runDir, 'attempts', taskId);
  const inputRefs = (spec.input_refs ?? []).filter((x) => x && x.ref);
  const task = {
    task_id: taskId, role: spec.role, model: role.model, effort: role.effort,
    instructions: [...instructionsOf(spec.role).map((rel) => join(SKILL_DIR, rel)), docRulesPathOf(run)],
    attempt_dir: attemptDir, result_path: join(attemptDir, 'return.json'),
    context: {
      run_dir: run.runDir, stage: spec.stage, unit_id: spec.unit_id ?? null, perspective: spec.perspective ?? null,
      target_id: spec.target_id ?? null, model_id: spec.model_id ?? null, property_ids: spec.property_ids ?? [],
      candidates: spec.candidates ?? [], subject: spec.subject ?? null,
    },
  };
  return { task, inputRefs: inputRefs.map((x) => ({ name: x.name, ref: x.ref, ...(x.spans ? { spans: [...x.spans] } : {}) })) };
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
