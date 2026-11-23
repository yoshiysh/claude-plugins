// 節の名前（:named）の読み取りと、静的な確認（architecture.md「静的な確認」、SP-FORMALMETHOD-012）の query の組立て。
// 節は性質の query のトップレベルの assert で、(assert (! <項> :named <name>)) の形を持つ。役は ModelFile.properties[].clauses が持つ。
import { parseForms, symbolsOf } from '../sexpr.mjs';
import { declaredSymbols } from '../adapters/z3.mjs';

// (assert (! <項> :named <name>)) の name。形が違えば null。
function assertName(node) {
  const a = node[1];
  if (!Array.isArray(a) || a[0] !== '!' || node.length !== 2) return null;
  for (let k = 2; k < a.length - 1; k += 1) if (a[k] === ':named' && typeof a[k + 1] === 'string') return a[k + 1];
  return null;
}

// トップレベルの assert を現れた順に [{ name（無ければ null）, term（項の node か null）, start, end }] で返す。S 式として読めなければ投げる。
export function topAsserts(queryText) {
  return parseForms(queryText)
    .filter((f) => Array.isArray(f.node) && f.node[0] === 'assert')
    .map((f) => {
      const name = assertName(f.node);
      return { name, term: name === null ? null : f.node[1][1], start: f.start, end: f.end };
    });
}

// 名前 → 項の node（比べるときは JSON の文字列にする）。名前の無い assert と、重なった名前の 2 つ目以降は入れない。
export function namedTerms(queryText) {
  const out = new Map();
  for (const a of topAsserts(queryText)) if (a.name !== null && !out.has(a.name)) out.set(a.name, a.term);
  return out;
}

// keepNames に無いトップレベルの assert を、その form の位置で切り取る。宣言・define-fun・(check-sat)・注釈は残す。
// 読めなければ null（z3.mjs の replayQuery と同じ扱い）。
export function ablate(queryText, keepNames) {
  let asserts;
  try { asserts = topAsserts(queryText); } catch { return null; }
  const keep = new Set(keepNames);
  let out = '';
  let at = 0;
  for (const a of asserts) {
    if (a.name !== null && keep.has(a.name)) continue;
    out += queryText.slice(at, a.start);
    at = a.end;
  }
  return out + queryText.slice(at);
}

export function clauseGroups(clauses) {
  const names = (role) => clauses.filter((c) => c.role === role).map((c) => c.name);
  return { rule: names('rule'), premise: names('premise'), goal: names('goal') };
}

// 役の違う節から参照される define-fun（define-fun-rec・define-funs-rec を含む）のうち、本体が（他の define-fun を通しても）宣言した記号を含むもの。[{ name, roles }]。
// ablate は assert だけを切り取るので、そうした本体の制約は、参照する節の 1 つが残る限り切り取られない（役ごとに切り分けられない）。
// 宣言した記号を含まない本体（定数・引数だけの関数）は、どの節に置いても状態を縛らないので数えない。S 式として読めなければ投げる。
export function sharedDefinitions(queryText, clauses) {
  const forms = parseForms(queryText).map((f) => f.node).filter(Array.isArray);
  const declared = new Set(forms.filter((n) => (n[0] === 'declare-const' || n[0] === 'declare-fun') && typeof n[1] === 'string').map((n) => n[1]));
  const defs = definitionsOf(forms);
  const reach = (syms) => reachDefinitions(defs, syms);
  const stateful = (name) => [name, ...reach(defs.get(name))].some((d) => defs.get(d).some((s) => declared.has(s)));
  const roleOf = new Map(clauses.map((c) => [c.name, c.role]));
  const users = new Map();
  for (const a of topAsserts(queryText)) {
    if (a.name === null || !roleOf.has(a.name)) continue;
    for (const d of reach(symbolsOf(a.term))) { if (!users.has(d)) users.set(d, new Set()); users.get(d).add(roleOf.get(a.name)); }
  }
  return [...users].filter(([d, rs]) => rs.size >= 2 && stateful(d)).map(([name, rs]) => ({ name, roles: [...rs].sort() }));
}

// define-fun・define-fun-rec は (<head> name (params) sort body)、define-funs-rec は ((name (params) sort)…) (body…)。
// z3 5.3.3 は 3 つとも受け付ける（再帰の定義も本体の制約は ablate で外れない）ので、同じ規則で数える。名前 → 本体の記号（引数を除く）
function definitionsOf(forms) {
  const defs = new Map();
  const put = (name, params, body) => {
    if (typeof name !== 'string') return;
    const bound = Array.isArray(params) ? params.filter(Array.isArray).map((x) => x[0]) : [];
    defs.set(name, symbolsOf(body, new Set(bound)));
  };
  for (const n of forms) {
    if (n[0] === 'define-fun' || n[0] === 'define-fun-rec') put(n[1], n[2], n[4]);
    else if (n[0] === 'define-funs-rec' && Array.isArray(n[1]) && Array.isArray(n[2])) n[1].forEach((d, i) => { if (Array.isArray(d)) put(d[0], d[1], n[2][i]); });
  }
  return defs;
}
// 記号の並びから（他の define-fun を通して）届く define-fun の名前の集合
function reachDefinitions(defs, syms, out = new Set()) {
  for (const s of syms) if (defs.has(s) && !out.has(s)) { out.add(s); reachDefinitions(defs, defs.get(s), out); }
  return out;
}

// 範囲として扱う変数のうち、query で宣言されないもの（notDeclared）と、宣言されたが出所の規則（rule）にも性質の否定（goal）の項にも
// 現れないもの（notUsed）。確認の段の scope_variables（検査の入力をつないだもの）と、モデル化の照合（性質の query）が同じこの判定を使う。
// S 式として読めなければ投げる。
export function scopeVariableGaps(queryText, clauses, vars) {
  const declared = new Set(declaredSymbols(queryText).map((d) => d.name));
  const terms = namedTerms(queryText);
  const names = clauses.filter((x) => x.role === 'rule' || x.role === 'goal').map((x) => x.name);
  const used = new Set(names.flatMap((n) => (terms.has(n) ? symbolsOf(terms.get(n)) : [])));
  return { notDeclared: vars.filter((v) => !declared.has(v)), notUsed: vars.filter((v) => declared.has(v) && !used.has(v)) };
}

// 性質の否定（goal）の項にだけ現れる、引数の無い宣言の記号（規則・前提の項にも、それらが届く define-fun の本体にも無い）。どの制約も縛らないので、
// 否定はその記号を自由に選べる（空虚な性質か、規則・前提の書き漏らし）。偽の陽性を避けるため、次は数えない（狭くとる）:
// どれかの define-fun の本体に現れる記号（定義を通した使い方は節の項だけでは読めない）と、否定の項で、宣言した関数か select・store の
// 引数として（その中の項を含めて）現れる記号（任意の添字・引数の定数。(not (P (a k))) の k は、a を縛る規則を通して性質に効く）。define-fun の適用の引数も同じに扱う。S 式として読めなければ投げる。
export function goalOnlyVariables(queryText, clauses) {
  const forms = parseForms(queryText).map((f) => f.node).filter(Array.isArray);
  const decls = declaredSymbols(queryText);
  const consts = new Set(decls.filter((d) => !d.args).map((d) => d.name));
  const funcs = new Set(decls.filter((d) => d.args).map((d) => d.name));
  const defs = definitionsOf(forms);
  const inDefs = new Set([...defs.values()].flat());
  const terms = namedTerms(queryText);
  const constrained = new Set();
  for (const c of clauses.filter((x) => x.role !== 'goal')) {
    if (!terms.has(c.name)) continue;
    const syms = symbolsOf(terms.get(c.name));
    for (const s of syms) constrained.add(s);
    for (const d of reachDefinitions(defs, syms)) for (const s of defs.get(d)) constrained.add(s);
  }
  const candidates = new Map(); // 記号 → 関数・配列の引数として現れたか
  const visit = (node, scope, asArgument) => {
    if (typeof node === 'string') {
      if (consts.has(node) && !scope.has(node) && !constrained.has(node) && !inDefs.has(node)) candidates.set(node, (candidates.get(node) ?? false) || asArgument);
      return;
    }
    if (!Array.isArray(node) || node.length === 0) return;
    const head = node[0];
    if ((head === 'let' || head === 'forall' || head === 'exists') && Array.isArray(node[1])) {
      const pairs = node[1].filter(Array.isArray);
      if (head === 'let') for (const pair of pairs) visit(pair[1], scope, asArgument);
      const inner = new Set(scope);
      for (const pair of pairs) inner.add(pair[0]);
      node.slice(2).forEach((x) => visit(x, inner, asArgument));
      return;
    }
    const applies = typeof head === 'string' && (funcs.has(head) || defs.has(head) || head === 'select' || head === 'store');
    node.forEach((x, i) => visit(x, scope, asArgument || (applies && i > 0)));
  };
  for (const c of clauses.filter((x) => x.role === 'goal')) if (terms.has(c.name)) visit(terms.get(c.name), new Set(), false);
  return [...candidates].filter(([, asArgument]) => !asArgument).map(([name]) => name);
}

// 静的な確認の道具の実行を組み立てられるか（節を役ごとに切り取れるか）。組み立てられなければ理由の文、組み立てられれば null。
// 性質の否定の節が 1 つ以上あり、全ての assert に名前があり、名前の集合が節の名前の集合と一致し、役の違う節が状態を縛る define-fun を共有しない。
export function clauseShapeProblem(queryText, clauses) {
  if (!clauses.some((c) => c.role === 'goal')) return '節に性質の否定（role goal）が無い';
  let asserts;
  let shared;
  try { asserts = topAsserts(queryText); shared = sharedDefinitions(queryText, clauses); } catch (e) { return `検査の入力を S 式として読めない（${e.message}）`; }
  if (asserts.some((a) => a.name === null)) return '検査の入力に :named の無いトップレベルの assert がある';
  const got = asserts.map((a) => a.name).sort();
  const want = clauses.map((c) => c.name).sort();
  if (new Set(got).size !== got.length || got.join('\n') !== want.join('\n')) return `検査の入力の assert の名前（${got.join(', ')}）が節の名前（${want.join(', ')}）と一致しない`;
  if (shared.length) return `宣言した記号を本体に含む define-fun（${shared.map((d) => `${d.name}: ${d.roles.join('・')}`).join('、')}）を役の違う節が参照するので、節を役ごとに切り取れない`;
  return null;
}
