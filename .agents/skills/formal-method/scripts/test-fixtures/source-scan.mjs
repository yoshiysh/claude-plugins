// cli-contract.md「構造の契約」をソースの走査で確かめる。実装を読まずに、契約の文だけから規則を作る。
// 字句の走査で、データの流れは追わない。追う範囲: 'run.lock' 等の名前の文字列、その文字列を含む式を代入した識別子、
// その文字列を含む式を返す関数の呼出し。その外（別ファイルからの import した path、計算した名前）は見ない（限界として返す）。

const MUTATORS = ['unlink', 'unlinkSync', 'rm', 'rmSync', 'rmdir', 'rmdirSync', 'rename', 'renameSync', 'writeFile', 'writeFileSync',
  'appendFile', 'appendFileSync', 'copyFile', 'copyFileSync', 'cp', 'cpSync', 'truncate', 'truncateSync', 'open', 'openSync',
  'link', 'linkSync', 'symlink', 'symlinkSync', 'createWriteStream'];
const DELETERS = new Set(['unlink', 'unlinkSync', 'rm', 'rmSync', 'rmdir', 'rmdirSync']);
const RENAMERS = new Set(['rename', 'renameSync']);
const LINKERS = new Set(['link', 'linkSync']);

// 文字列・テンプレート・コメントを空白に置き換える（位置は保つ）。文字列の中身は別に返す。
export function mask(src) {
  let out = '';
  let i = 0;
  const strings = [];
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === '/' && n === '/') { const j = src.indexOf('\n', i); const e = j < 0 ? src.length : j; out += ' '.repeat(e - i); i = e; continue; }
    if (c === '/' && n === '*') { const j = src.indexOf('*/', i + 2); const e = j < 0 ? src.length : j + 2; out += src.slice(i, e).replace(/[^\n]/g, ' '); i = e; continue; }
    if (c === '\'' || c === '"' || c === '`') {
      let j = i + 1;
      while (j < src.length && src[j] !== c) { if (src[j] === '\\') j += 1; j += 1; }
      const body = src.slice(i + 1, j);
      strings.push({ start: i, end: j + 1, body });
      out += c + body.replace(/[^\n]/g, '_') + c;
      i = j + 1;
      continue;
    }
    out += c;
    i += 1;
  }
  return { masked: out, strings };
}

function matchParen(masked, open) {
  let depth = 0;
  for (let i = open; i < masked.length; i += 1) {
    if (masked[i] === '(') depth += 1;
    else if (masked[i] === ')') { depth -= 1; if (depth === 0) return i; }
  }
  return -1;
}

function matchBrace(masked, open) {
  let depth = 0;
  for (let i = open; i < masked.length; i += 1) {
    if (masked[i] === '{') depth += 1;
    else if (masked[i] === '}') { depth -= 1; if (depth === 0) return i; }
  }
  return -1;
}

const lineOf = (src, idx) => src.slice(0, idx).split('\n').length;

// 名前（例 'run.lock'）を指す識別子と関数を集める。
function namesFor(src, masked, strings, literal) {
  const hasLit = (a, b) => strings.some((s) => s.start >= a && s.end <= b && s.body.includes(literal));
  const idents = new Set();
  const funcs = new Set();
  const decl = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g;
  for (let m; (m = decl.exec(masked));) {
    const end = masked.indexOf('\n', m.index);
    const stmtEnd = masked.indexOf(';', m.index);
    const e = Math.min(end < 0 ? masked.length : end, stmtEnd < 0 ? masked.length : stmtEnd);
    if (hasLit(m.index, e)) {
      // アロー関数なら関数名として扱う
      if (/=\s*(?:async\s*)?\([^)]*\)\s*=>/.test(masked.slice(m.index, e + 1))) funcs.add(m[1]); else idents.add(m[1]);
    }
  }
  const fn = /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g;
  for (let m; (m = fn.exec(masked));) {
    const b = masked.indexOf('{', m.index);
    const e = matchBrace(masked, b);
    const body = masked.slice(b, e);
    const ret = /\breturn\b/g;
    for (let r; (r = ret.exec(body));) {
      const semi = body.indexOf(';', r.index);
      const a = b + r.index;
      if (hasLit(a, b + (semi < 0 ? body.length : semi))) funcs.add(m[1]);
    }
  }
  return { idents, funcs, hasLit };
}

function functionRanges(masked) {
  const ranges = [];
  const re = /\b(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(|\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b[^(]*)?\([^)]*\)\s*(?:=>)?\s*\{/g;
  for (let m; (m = re.exec(masked));) {
    const b = masked.indexOf('{', m.index + m[0].length - 1);
    const e = matchBrace(masked, b);
    if (b >= 0 && e > b) ranges.push({ name: m[1] ?? m[2], start: b, end: e });
  }
  return ranges;
}

function innermostFunction(ranges, idx) {
  return ranges.filter((r) => r.start <= idx && idx <= r.end).sort((a, b) => (a.end - a.start) - (b.end - b.start))[0] ?? null;
}

// 1 ファイルの呼出しのうち、名前（literal）を指すものを返す。
export function callsTouching(src, literal) {
  const { masked, strings } = mask(src);
  const { idents, funcs, hasLit } = namesFor(src, masked, strings, literal);
  const ranges = functionRanges(masked);
  const out = [];
  const re = new RegExp(`(?:\\.|\\b)(${MUTATORS.join('|')})\\s*\\(`, 'g');
  for (let m; (m = re.exec(masked));) {
    const open = m.index + m[0].length - 1;
    const close = matchParen(masked, open);
    if (close < 0) continue;
    const argsMasked = masked.slice(open + 1, close);
    const touches = hasLit(open, close)
      || [...idents].some((id) => new RegExp(`\\b${id.replace(/\$/g, '\\$')}\\b`).test(argsMasked))
      || [...funcs].some((f) => new RegExp(`\\b${f.replace(/\$/g, '\\$')}\\s*\\(`).test(argsMasked));
    if (!touches) continue;
    const argsText = src.slice(open + 1, close);
    const fn = innermostFunction(ranges, m.index);
    out.push({ op: m[1], line: lineOf(src, m.index), args: argsText.replace(/\s+/g, ' ').slice(0, 160), fn: fn?.name ?? null, fnStart: fn?.start ?? null, index: m.index });
  }
  return { calls: out, masked, ranges };
}

const exclusiveCreate = (args) => /['"`]wx\+?['"`]|O_EXCL/.test(args);

// 構造の契約の 1 つ目: run.lock を消すのは store.mjs の releaseOwnLock の中だけで、nonce の照合の後だけ。
// 他のどこにも run.lock の path を消す・上書きする・rename する呼出しは無い。files は { path, src }。
export function checkLockContract(files) {
  const violations = [];
  const store = files.find((f) => f.path.endsWith('scripts/lib/store.mjs'));
  if (!store) violations.push({ file: 'scripts/lib/store.mjs', line: 0, rule: 'store.mjs が無い', fix: 'scripts/lib/store.mjs に releaseOwnLock を置く' });
  else if (!/export\s+(?:async\s+)?function\s+releaseOwnLock\b|export\s*\{[^}]*\breleaseOwnLock\b[^}]*\}|export\s+const\s+releaseOwnLock\b/.test(store.src)) {
    violations.push({ file: store.path, line: 0, rule: 'releaseOwnLock を export していない', fix: 'store.mjs から releaseOwnLock を export する' });
  }
  let releaseDeletes = 0;
  for (const f of files) {
    const { calls, masked, ranges } = callsTouching(f.src, 'run.lock');
    for (const c of calls) {
      const inRelease = f === store && c.fn === 'releaseOwnLock';
      if (DELETERS.has(c.op)) {
        if (!inRelease) { violations.push({ file: f.path, line: c.line, rule: `run.lock の path を ${c.op} で消している（releaseOwnLock の外）`, fix: 'lock を消すのは store.mjs の releaseOwnLock だけにし、ここから呼ぶ' }); continue; }
        releaseDeletes += 1;
        const fnRange = ranges.find((r) => r.name === 'releaseOwnLock');
        const before = masked.slice(fnRange.start, c.index);
        if (!/\bnonce\b[^;]*?(?:===|!==|==|!=)|(?:===|!==|==|!=)[^;]*?\bnonce\b/.test(before)) {
          violations.push({ file: f.path, line: c.line, rule: 'releaseOwnLock が nonce を照合する前に消している', fix: 'run.lock を読み、nonce が自分のものと一致したときだけ消す' });
        }
      } else if (RENAMERS.has(c.op)) {
        violations.push({ file: f.path, line: c.line, rule: `run.lock の path を ${c.op} している`, fix: 'run.lock を rename しない（排他作成と releaseOwnLock だけ）' });
      } else if (!LINKERS.has(c.op) && !exclusiveCreate(c.args) && !/^(open|openSync)$/.test(c.op)) {
        violations.push({ file: f.path, line: c.line, rule: `run.lock の path を ${c.op} で上書きしうる`, fix: "run.lock は排他作成（flag 'wx'）だけで書く" });
      } else if (/^(open|openSync)$/.test(c.op) && !exclusiveCreate(c.args) && /['"`][wa]\+?['"`]/.test(c.args)) {
        violations.push({ file: f.path, line: c.line, rule: 'run.lock を書込みで開いている（排他でない）', fix: "flag 'wx' で開く" });
      }
    }
  }
  if (store && releaseDeletes === 0) violations.push({ file: store.path, line: 0, rule: 'releaseOwnLock の中に run.lock を消す呼出しが見つからない', fix: 'releaseOwnLock の中で、nonce の照合の後に run.lock を消す' });
  return violations;
}

// 構造の契約: result.json・salvage.mark・salvage-ledger.json・salvage-worklog.json・inbox/<batch_id>.json は
// 一時ファイルからの link でだけ作る。これらの名前を指す書込み・rename・copy を違反とする。
export const LINK_ONLY = ['result.json', 'salvage.mark', 'salvage-ledger.json', 'salvage-worklog.json'];
export function checkLinkOnly(files, names = LINK_ONLY) {
  const violations = [];
  for (const f of files) for (const name of names) {
    const { calls } = callsTouching(f.src, name);
    for (const c of calls) {
      if (LINKERS.has(c.op) || DELETERS.has(c.op) || /^(open|openSync)$/.test(c.op)) continue;
      // 一時の名前（name.tmp-...）への書込みは許す
      if (new RegExp(`${name.replace(/[.]/g, '\\.')}\\.tmp`).test(c.args) || /\btmp\b|\.tmp-/i.test(c.args)) continue;
      violations.push({ file: f.path, line: c.line, rule: `${name} を ${c.op} で作っている（link でない）`, fix: `一時ファイルに書いて fsync し、${name} へ link で公開する` });
    }
  }
  return violations;
}

// 構造の契約の 2〜4 つ目（cli-contract「構造の契約」）:
//   一時の領域 .tmp-<run_id>-<nonce>/ を rename するのは store.mjs の publishRunDir だけ。
//   .tmp-* を消すのは start.mjs の removeOwnTmp だけ、.probe-* を消すのは start.mjs の removeProbeDir だけ。
// 字句の近似: ディレクトリを消す呼出し（recursive の rm・rmdir）は、removeOwnTmp か removeProbeDir の中にだけあってよい
// （契約が消してよいディレクトリはこの 2 つだけで、run の領域は消さない）。'.tmp-' で始まる名前（領域の名前の形）を
// rename する呼出しは publishRunDir の中にだけあってよい。'<file>.tmp-<nonce>' のような一時ファイルの名前は対象にしない。
const DIR_DELETE = /^(rm|rmSync|rmdir|rmdirSync)$/;
export function checkRegionContract(files) {
  const violations = [];
  const store = files.find((f) => f.path.endsWith('scripts/lib/store.mjs'));
  const start = files.find((f) => f.path.endsWith('scripts/lib/start.mjs'));
  const defines = (f, name) => f && new RegExp(`\\bfunction\\s+${name}\\b|\\b(?:const|let)\\s+${name}\\s*=`).test(f.src);
  if (!defines(store, 'publishRunDir')) violations.push({ file: 'scripts/lib/store.mjs', line: 0, rule: 'publishRunDir が無い', fix: 'store.mjs に一時の領域を最終の名前へ rename する publishRunDir を置く' });
  for (const name of ['removeOwnTmp', 'removeProbeDir']) {
    if (!defines(start, name)) violations.push({ file: 'scripts/lib/start.mjs', line: 0, rule: `${name} が無い`, fix: `start.mjs に ${name} を置く` });
  }
  for (const f of files) {
    const { masked, strings } = mask(f.src);
    const ranges = functionRanges(masked);
    const re = /(?:\.|\b)(rm|rmSync|rmdir|rmdirSync|rename|renameSync)\s*\(/g;
    for (let m; (m = re.exec(masked));) {
      const open = m.index + m[0].length - 1;
      const close = matchParen(masked, open);
      if (close < 0) continue;
      const args = f.src.slice(open + 1, close);
      const fn = innermostFunction(ranges, m.index)?.name ?? null;
      const line = lineOf(f.src, m.index);
      if (DIR_DELETE.test(m[1]) && (/recursive\s*:\s*true/.test(args) || /^rmdir/.test(m[1]))) {
        if (!(f === start && (fn === 'removeOwnTmp' || fn === 'removeProbeDir'))) {
          violations.push({ file: f.path, line, rule: `ディレクトリを ${m[1]} で消している（removeOwnTmp・removeProbeDir の外）`, fix: '.tmp-* は start.mjs の removeOwnTmp、.probe-* は removeProbeDir だけで消す。run の領域は消さない' });
        }
      }
      if (/^rename/.test(m[1])) {
        const { idents, funcs } = namesForPrefix(masked, strings, '.tmp-');
        const touches = strings.some((s) => s.start > open && s.end <= close && s.body.startsWith('.tmp-'))
          || [...idents].some((id) => new RegExp(`\\b${id}\\b`).test(masked.slice(open + 1, close)))
          || [...funcs].some((fnn) => new RegExp(`\\b${fnn}\\s*\\(`).test(masked.slice(open + 1, close)));
        if (touches && !(f === store && fn === 'publishRunDir')) {
          violations.push({ file: f.path, line, rule: '一時の領域（.tmp-<run_id>-<nonce>/）を publishRunDir の外で rename している', fix: '一時の領域の rename は store.mjs の publishRunDir だけにする' });
        }
      }
    }
  }
  return violations;
}

// 本体が prefix で始まる文字列を含む式を代入した識別子と、それを返す関数。
function namesForPrefix(masked, strings, prefix) {
  const has = (a, b) => strings.some((s) => s.start >= a && s.end <= b && s.body.startsWith(prefix));
  const idents = new Set();
  const funcs = new Set();
  const decl = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g;
  for (let m; (m = decl.exec(masked));) {
    const nl = masked.indexOf('\n', m.index);
    const e = nl < 0 ? masked.length : nl;
    if (has(m.index, e)) (/=\s*(?:async\s*)?\([^)]*\)\s*=>/.test(masked.slice(m.index, e)) ? funcs : idents).add(m[1]);
  }
  return { idents, funcs };
}
