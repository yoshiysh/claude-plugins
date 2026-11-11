// Z3 の adapter（cli-contract.md「Z3 の adapter」「証人」）。option は -in・-T:<秒>・-model・-version だけを使う。
// decode は終わり方（End）だけを返し、判定は付けない（判定は verdict.mjs の classifyCheck）。
import { execFile } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { parseForms, stripComments, collapseWhitespace, parseWithSpans } from '../sexpr.mjs';

export const ID = 'z3';
export const CPU = 1;
export const ANSWERS = Object.freeze(['sat', 'unsat', 'unknown', 'timeout']);
const VERSION_LINE = /^Z3 version (\d+\.\d+\.\d+)\b/;

// 今の PATH から実行体を探す（使うたびに探す）。見つからなければ null。
export function findExecutable(name, pathValue = process.env.PATH ?? '') {
  for (const dir of pathValue.split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    const p = join(dir, name);
    try {
      if (!statSync(p).isFile()) continue;
      accessSync(p, constants.X_OK);
      return p;
    } catch { /* 次の候補 */ }
  }
  return null;
}

// 準備: 実行体を探し、-version で版を読む。見つからないか版を読めなければ ok: false。
export function prepare() {
  const started = process.hrtime.bigint();
  const elapsed = () => Number((process.hrtime.bigint() - started) / 1000000n);
  const executable = findExecutable('z3');
  if (!executable) return Promise.resolve({ ok: false, reason: 'PATH に z3 の実行体が見つからない', elapsed_ms: elapsed() });
  return new Promise((resolve) => {
    execFile(executable, ['-version'], { env: {}, timeout: 10000, maxBuffer: 65536 }, (err, stdout) => {
      const m = !err && String(stdout).trim().match(VERSION_LINE);
      if (!m) resolve({ ok: false, reason: 'z3 の版を読めない', elapsed_ms: elapsed() });
      else resolve({ ok: true, executable, version: m[1], elapsed_ms: elapsed() });
    });
  });
}

export function argsFor(execution) {
  return ['-in', `-T:${execution.tool_time_limit_seconds}`, ...(execution.with_model ? ['-model'] : [])];
}

// 担当が書く .smt2 の規則（artifact-formats.md「担当の成果物」）。違反の文の配列を返す。
const FORBIDDEN = ['get-model', 'set-option', 'push', 'pop', 'reset', 'exit'];
export function smtViolations(text) {
  let forms;
  try { forms = parseForms(text); } catch (e) { return [`S 式として読めない（${e.message}）`]; }
  const v = [];
  const isCheckSat = (f) => Array.isArray(f.node) && f.node[0] === 'check-sat';
  const count = forms.filter(isCheckSat).length;
  if (count !== 1) v.push(`(check-sat) が ${count} 個（ちょうど 1 つ）`);
  else if (!isCheckSat(forms[forms.length - 1])) v.push('(check-sat) が最後の form でない');
  for (const f of forms) {
    if (!Array.isArray(f.node)) { v.push('top level に list でない form がある'); continue; }
    if (FORBIDDEN.includes(f.node[0])) v.push(`${f.node[0]} を書いている`);
  }
  v.push(...parallelViolations(text));
  return v;
}

// 並列の設定（parallel.enable、check-sat-using と par-or・par-then）を含む query を拒む。
export function parallelViolations(text) {
  const t = stripComments(text);
  const v = [];
  if (/parallel\.enable/.test(t)) v.push('並列の設定 parallel.enable を書いている');
  if (/check-sat-using/.test(t) && /\bpar-(or|then)\b/.test(t)) v.push('並列の設定 check-sat-using と par-or・par-then を書いている');
  return v;
}

export function hasCheckSat(text) {
  try { return parseForms(text).some((f) => Array.isArray(f.node) && f.node[0] === 'check-sat'); } catch { return /\(check-sat\)/.test(stripComments(text)); }
}

const nonEmpty = (lines) => lines.filter((l) => l.trim().length > 0);

// 読む順の 0: -model を渡した実行で、最初の空でない行が答えなら、その行と続く全ての行（モデルの文字列）に分ける。
export function splitAnswer(stdoutText) {
  const lines = stdoutText.split('\n');
  const idx = lines.findIndex((l) => l.trim().length > 0);
  if (idx < 0) return null;
  const answer = lines[idx].trim();
  if (!ANSWERS.includes(answer)) return null;
  return { answer, model: lines.slice(idx + 1).join('\n') };
}

export function answerResult(answer, expected) {
  if (answer === 'sat' || answer === 'unsat') return { tool_result: answer === expected ? '満たす' : '反する', time_limit_hit: null };
  if (answer === 'unknown') return { tool_result: '判定できない', time_limit_hit: null };
  return { tool_result: '判定できない', time_limit_hit: '道具' };
}

// 道具が自分で終わったときの終わり方（cli-contract.md「読む順」0〜4）。標準エラーは読まない。
export function decodeEnd({ stdout, exit_code: exitCode, with_model: withModel, expected }) {
  const text = Buffer.from(stdout).toString('utf8');
  const base = { started: true, tool_result: 'なし', abnormal_exit: false, unreadable_output: false, stopped_by: null, time_limit_hit: null };
  let answer = null;
  let rest = text.split('\n');
  if (withModel) {
    const s = splitAnswer(text);
    if (s) { answer = s.answer; rest = []; }
  }
  // 1
  if (rest.some((l) => l.trim().startsWith('(error'))) return { ...base, tool_result: '判定以外のエラー' };
  // 2
  if (exitCode === 0) {
    let line = answer;
    if (line === null) {
      const ne = nonEmpty(rest);
      if (ne.length === 1) line = ne[0].trim();
    }
    if (line !== null && ANSWERS.includes(line)) return { ...base, ...answerResult(line, expected) };
  }
  // 3
  if (exitCode !== 0) return { ...base, abnormal_exit: true };
  // 4
  return { ...base, unreadable_output: true };
}

// ---- 証人（cli-contract.md「証人」） ----
const DIGITS = /^\d+$/;
const DECIMAL = /^\d+\.\d+$/;
const isAtom = (n, rx) => n && typeof n.atom === 'string' && rx.test(n.atom);
const headIs = (n, h) => n && Array.isArray(n.list) && n.list[0] && n.list[0].atom === h;
function isLiteralTerm(n) {
  if (!n) return false;
  if (typeof n.atom === 'string') {
    const a = n.atom;
    return a === 'true' || a === 'false' || DIGITS.test(a) || DECIMAL.test(a) || /^#x[0-9A-Fa-f]+$/.test(a) || /^#b[01]+$/.test(a) || (a.startsWith('"') && a.endsWith('"') && a.length >= 2);
  }
  const l = n.list;
  if (headIs(n, '-') && l.length === 2) return isAtom(l[1], DIGITS) || isAtom(l[1], DECIMAL) || (headIs(l[1], '/') && isDivision(l[1]));
  if (headIs(n, '/')) return isDivision(n);
  return false;
}
const isDivision = (n) => n.list.length === 3 && isAtom(n.list[1], DECIMAL) && isAtom(n.list[2], DECIMAL);

// query で宣言された記号（declare-const と引数の無い declare-fun）を宣言の順に返す。
export function declaredSymbols(queryText) {
  let forms;
  try { forms = parseForms(queryText); } catch { return []; }
  const out = [];
  for (const f of forms) {
    const n = f.node;
    if (!Array.isArray(n) || typeof n[1] !== 'string') continue;
    if (n[0] === 'declare-const') out.push({ name: n[1], args: false });
    if (n[0] === 'declare-fun') out.push({ name: n[1], args: !(Array.isArray(n[2]) && n[2].length === 0) });
  }
  return out;
}

// モデルの文字列から証人を読む。読めなければ { ok: false, reason }。
export function readWitness(modelText, queryText) {
  const stripped = stripComments(modelText);
  let forms;
  try { forms = parseWithSpans(stripped); } catch (e) { return { ok: false, reason: `モデルの文字列を S 式として読めない（${e.message}）` }; }
  if (forms.length === 0) return { ok: false, reason: 'モデルが無い' };
  if (forms.length !== 1 || !Array.isArray(forms[0].list)) return { ok: false, reason: 'モデルの文字列がちょうど 1 つの list でない' };
  const declared = declaredSymbols(queryText);
  const noArg = new Set(declared.filter((d) => !d.args).map((d) => d.name));
  const asserts = [];
  const fixed = new Set();
  for (const el of forms[0].list) {
    const l = el.list;
    if (!l || l.length !== 5 || !headIs(el, 'define-fun') || typeof l[1].atom !== 'string') continue;
    if (!Array.isArray(l[2].list) || l[2].list.length !== 0) continue;
    const sym = l[1].atom;
    if (!noArg.has(sym) || fixed.has(sym)) continue;
    if (!isLiteralTerm(l[4])) continue;
    asserts.push({ symbol: sym, term: collapseWhitespace(stripped.slice(l[4].start, l[4].end)) });
    fixed.add(sym);
  }
  const unfixed = declared.filter((d) => !fixed.has(d.name)).map((d) => d.name);
  if (asserts.length === 0) return { ok: false, reason: '固定する記号が無い', unfixed };
  return { ok: true, asserts, unfixed };
}

// replay の query: ただ 1 つの (check-sat) の form の直前に、固定する記号ごとの assert の行を挿入する。
export function replayQuery(queryText, asserts) {
  let forms;
  try { forms = parseForms(queryText); } catch { return null; }
  const cs = forms.filter((f) => Array.isArray(f.node) && f.node[0] === 'check-sat');
  if (cs.length !== 1) return null;
  const at = cs[0].start;
  const lines = asserts.map((a) => `(assert (= ${a.symbol} ${a.term}))\n`).join('');
  return queryText.slice(0, at) + lines + queryText.slice(at);
}
