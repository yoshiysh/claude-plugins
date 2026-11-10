// SMT-LIB の S 式の読み取り（artifact-formats.md「依存グラフの導出の規則」の記号の読み方）。
// atom は文字列（文字列の literal は引用符を含めたまま、|…| は引用を外した名前）、list は配列。
// top level の form は { node, start, end }（文字の位置、0 始まり、end を含まない）。注釈（; から行末）は読まない。
// 文字列の literal（text[start] が '"'）の閉じ引用符の位置。中の "" は引用符 1 つのエスケープ。閉じていなければ -1。
export function stringLiteralClose(text, start) {
  let j = start + 1;
  while (j < text.length) {
    if (text[j] === '"') { if (text[j + 1] === '"') { j += 2; continue; } return j; }
    j += 1;
  }
  return -1;
}

export function parseForms(text) {
  // 字句: '(' ')' と atom（位置付き）。注釈と空白は読み飛ばす
  const tokens = [];
  for (let i = 0; i < text.length;) {
    const c = text[i];
    if (/\s/.test(c)) { i += 1; continue; }
    if (c === ';') { const nl = text.indexOf('\n', i); i = nl < 0 ? text.length : nl; continue; }
    if (c === '(' || c === ')') { tokens.push({ t: c, at: i, end: i + 1 }); i += 1; continue; }
    if (c === '"' || c === '|') {
      const close = c === '"' ? stringLiteralClose(text, i) : text.indexOf(c, i + 1);
      if (close < 0) throw new Error(c === '"' ? '閉じていない文字列' : '閉じていない |記号|');
      tokens.push({ t: 'atom', v: c === '"' ? text.slice(i, close + 1) : text.slice(i + 1, close), at: i, end: close + 1 });
      i = close + 1;
      continue;
    }
    let j = i;
    while (j < text.length && !/[\s();"]/.test(text[j])) j += 1;
    tokens.push({ t: 'atom', v: text.slice(i, j), at: i, end: j });
    i = j;
  }
  // 構文: token の列を top level の form にまとめる
  const forms = [];
  const stack = [];
  for (const tok of tokens) {
    if (tok.t === '(') { stack.push({ list: [], at: tok.at }); continue; }
    if (tok.t === ')') {
      if (!stack.length) throw new Error('対応の無い閉じ括弧');
      const done = stack.pop();
      if (stack.length) stack[stack.length - 1].list.push(done.list);
      else forms.push({ node: done.list, start: done.at, end: tok.end });
      continue;
    }
    if (stack.length) stack[stack.length - 1].list.push(tok.v);
    else forms.push({ node: tok.v, start: tok.at, end: tok.end });
  }
  if (stack.length) throw new Error('閉じていない括弧');
  return forms;
}

export const RESERVED = new Set(['assert', 'and', 'or', 'not', 'xor', '=>', '=', 'distinct', 'ite', 'let', 'forall', 'exists', 'true', 'false',
  '+', '-', '*', '/', 'div', 'mod', 'abs', '<', '<=', '>', '>=', 'to_real', 'to_int', 'is_int', 'select', 'store', 'Int', 'Real', 'Bool',
  'Array', '!', 'named', 'pattern', 'as', '_']);

// 数値・keyword・#x/#b・文字列の literal は記号に数えない
const notSymbol = (a) => a.length === 0 || RESERVED.has(a) || a.startsWith(':') || a.startsWith('#') || a.startsWith('"') || /^-?\d+(\.\d+)?$/.test(a);

// 項の中の記号を、現れた順に重複なく返す。let・forall・exists の束縛と、呼び手が渡した束縛（define-fun の引数）を除く。
export function symbolsOf(term, bound = new Set(), out = []) {
  const seen = new Set(out);
  const visit = (node, scope) => {
    if (typeof node === 'string') {
      if (!notSymbol(node) && !scope.has(node) && !seen.has(node)) { seen.add(node); out.push(node); }
      return;
    }
    if (!Array.isArray(node) || node.length === 0) return;
    const binder = node[0];
    if ((binder === 'let' || binder === 'forall' || binder === 'exists') && Array.isArray(node[1])) {
      const pairs = node[1].filter(Array.isArray);
      // let は束縛の項を外の scope で読み、量化子は変数の sort を外の scope で読む
      for (const pair of pairs) visit(binder === 'let' ? pair[1] : pair.slice(1), scope);
      const inner = new Set(scope);
      for (const pair of pairs) inner.add(pair[0]);
      node.slice(2).forEach((x) => visit(x, inner));
      return;
    }
    node.forEach((x) => visit(x, scope));
  };
  visit(term, bound);
  return out;
}

// (! t :named n) の n を集める。
export function namedIn(node, out = []) {
  const walk = (n) => {
    if (!Array.isArray(n)) return;
    if (n[0] === '!') n.forEach((x, k) => { if (x === ':named' && typeof n[k + 1] === 'string') out.push(n[k + 1]); });
    n.forEach(walk);
  };
  walk(node);
  return out;
}

// 注釈（文字列の literal の外の ; から行末）を除く。位置を保たない。
export function stripComments(text) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      const close = stringLiteralClose(text, i);
      const j = close < 0 ? text.length : close;
      out += text.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === ';') { while (i < text.length && text[i] !== '\n') i += 1; continue; }
    out += c;
    i += 1;
  }
  return out;
}

// 文字列の literal の外の空白の並び（改行を含む）を空白 1 つにまとめる。
export function collapseWhitespace(text) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      const close = stringLiteralClose(text, i);
      const j = close < 0 ? text.length : close;
      out += text.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (/\s/.test(c)) {
      while (i < text.length && /\s/.test(text[i])) i += 1;
      out += ' ';
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

// 位置付きの読み取り（証人の項を写すため）。atom は { atom, start, end }、list は { list, start, end }。
export function parseWithSpans(text) {
  let i = 0;
  const skipWs = () => { while (i < text.length && /\s/.test(text[i])) i += 1; };
  const read = () => {
    skipWs();
    if (i >= text.length) throw new Error('S 式が途中で終わる');
    const start = i;
    const c = text[i];
    if (c === '(') {
      i += 1;
      const list = [];
      for (;;) {
        skipWs();
        if (i >= text.length) throw new Error('閉じていない括弧');
        if (text[i] === ')') { i += 1; return { list, start, end: i }; }
        list.push(read());
      }
    }
    if (c === ')') throw new Error('対応の無い閉じ括弧');
    if (c === '"') {
      const close = stringLiteralClose(text, i);
      if (close < 0) throw new Error('閉じていない文字列');
      i = close + 1;
      return { atom: text.slice(start, i), start, end: i };
    }
    if (c === '|') {
      i += 1;
      while (i < text.length && text[i] !== '|') i += 1;
      if (i >= text.length) throw new Error('閉じていない |記号|');
      i += 1;
      return { atom: text.slice(start + 1, i - 1), start, end: i };
    }
    while (i < text.length && !/[\s()"]/.test(text[i])) i += 1;
    return { atom: text.slice(start, i), start, end: i };
  };
  const forms = [];
  for (;;) {
    skipWs();
    if (i >= text.length) break;
    forms.push(read());
  }
  return forms;
}
