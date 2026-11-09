#!/usr/bin/env node
// テスト用の偽の z3。cli-contract.md「Z3 の adapter」の実測の表どおりに出力と終了コードを返す。
// CLI が渡す option は -in・-T:<秒>・-model・-version だけ。振る舞いは query の中の指示か、PATH に置く wrapper の --fake-* で決める。
//   query の指示（行の形 `; fake-<名前>: <値>`。最初に現れた行を使う）
//     result: sat | unsat | unknown | timeout | その他の文字列（そのまま 1 行書く。読めない出力になる）
//     mode:   answer（既定） | syntax-error | oom | crash | empty | multi（sat と unsat の 2 行） | multi-junk（maybe と sat の 2 行）
//             | error-after-answer（sat の後に (error …) の行、-model ならその後にモデル、終了コード 1。実測の (check-sat) の後の誤った form）
//     sleep-ms: 応答までの遅延。-T の秒を超えると、その時点で `timeout` を返す（道具自身の時間の上限）
//     exit:   答えを返した後の終了コード（既定 0）
//     model:  -model を受けて答えが sat か unknown のとき、答えの後に出すモデル（-model が無ければ何も出さない。実測では unsat・timeout の後には出ない）
//       real（既定）: 実測（macOS arm64、Z3 5.3.3）の形。query の宣言ごとに `(define-fun <記号> () <sort>\n    <値>)` を出す。
//                     実測の並びは宣言の順でないので、宣言の逆順に出す（モデルの要素の順と宣言の順を取り違えた実装を落とすため）。
//                     最後に補助の記号 k!0 の定義を出す。値は sort ごとに Int → 2、Real → (- (/ 3.0 2.0))、Bool → true、String → "ab"、
//                     (_ BitVec n) → #x0…（n が 4 の倍数）か #b0…、(Array …) → ((as const (Array …)) 0)。
//                     引数のある declare-fun は `(define-fun f ((x!0 Int)) Int\n    3)` の形で出す。
//       none:        モデルを出さない
//       malformed:   real の list の後に、空白でない form `(extra)` を続ける（形に合わない）
//       unfixable:   宣言された記号の値を全て literal でない項（(+ k!0 1)）にする（固定する記号が無い）
//       huge:        real の list の中に、補助の記号の定義を TOOL_OUTPUT_MAX_BYTES（1048576）を超えるまで足す
//       secret:      real と同じで、String の値を秘密値の型（aws_access_key_id）の文字列にする（query には秘密値を書かない）
//     model-text: JSON の文字列。-model を受けて答えが sat か unknown のとき、モデルとしてその文字列をそのまま出す（model より先に見る）
//     model-sleep-ms: 答えの行とモデルの最初の行を書いた後、残りを書くまでの遅延（答えの後の停止を起こす）
//   wrapper の引数（make-fake-bin.mjs が付ける。CLI は付けない）
//     --fake-mode=always-unsat  query の指示によらず unsat を返す（常に成功を返す道具）
//     --fake-log=<path>         呼出しごとに JSON の行を追記する（受け取った引数、環境変数の名前、時刻、query の指紋と注釈の行）
import { appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { TOOL_OUTPUT_MAX_BYTES } from './constants.mjs';

const raw = process.argv.slice(2);
const own = Object.fromEntries(raw.filter((a) => a.startsWith('--fake-')).map((a) => {
  const i = a.indexOf('=');
  return [a.slice(7, i < 0 ? undefined : i), i < 0 ? true : a.slice(i + 1)];
}));
const args = raw.filter((a) => !a.startsWith('--fake-'));
const started = Date.now();

function log(extra) {
  if (!own.log) return;
  appendFileSync(own.log, `${JSON.stringify({
    pid: process.pid, ppid: process.ppid, args, env_keys: Object.keys(process.env).sort(),
    started_ms: started, at_ms: Date.now(), ...extra,
  })}\n`);
}

// 書き終えてから終わる（macOS の pipe は非同期なので、write の直後に exit すると末尾を失う）。
function finish(text, code) {
  if (!text) { process.exit(code); return; }
  process.stdout.write(text, () => process.exit(code));
}

// query の宣言（declare-const と declare-fun）を、宣言の順に [{ name, params, sort }] で返す。sort は S 式の文字列のまま。
function declarations(text) {
  const out = [];
  const src = text.replace(/;[^\n]*/g, '');
  const rx = /\((declare-const|declare-fun)\s+([^\s()]+)\s+/g;
  let m;
  const readForm = (i) => {
    // i から 1 つの S 式（記号か list）を読み、[文字列, 次の位置] を返す
    while (/\s/.test(src[i])) i += 1;
    if (src[i] !== '(') { let j = i; while (j < src.length && !/[\s()]/.test(src[j])) j += 1; return [src.slice(i, j), j]; }
    let depth = 0; let j = i;
    for (; j < src.length; j += 1) { if (src[j] === '(') depth += 1; if (src[j] === ')') { depth -= 1; if (depth === 0) { j += 1; break; } } }
    return [src.slice(i, j), j];
  };
  while ((m = rx.exec(src)) !== null) {
    let i = m.index + m[0].length;
    let params = null;
    if (m[1] === 'declare-fun') { const [p, j] = readForm(i); params = p.slice(1, -1).trim().split(/\s+/).filter(Boolean); i = j; }
    const [sort] = readForm(i);
    out.push({ name: m[2], params: params && params.length ? params : null, sort });
  }
  return out;
}

function valueOf(sort, kind) {
  if (sort === 'String') return kind === 'secret' ? `"AKIA${'ABCDEFGHIJKLMNOP'}"` : '"ab"';
  if (sort === 'Int') return '2';
  if (sort === 'Real') return '(- (/ 3.0 2.0))';
  if (sort === 'Bool') return 'true';
  const bv = sort.match(/^\(_\s+BitVec\s+(\d+)\)$/);
  if (bv) { const n = Number(bv[1]); return n % 4 === 0 ? `#x${'0'.repeat(n / 4)}` : `#b${'0'.repeat(n)}`; }
  if (/^\(Array\s/.test(sort)) return `((as const ${sort}) 0)`;
  return '0';
}

// モデルの list の行。実測の形: "(" の行、要素ごとに 2 行（定義の頭と、4 つの空白で字下げした項）、")" の行。
function modelLines(text, kind) {
  const elems = [];
  for (const d of declarations(text)) {
    if (d.params) {
      const ps = d.params.map((s, i) => `(x!${i} ${s})`).join(' ');
      elems.push([`  (define-fun ${d.name} (${ps}) ${d.sort}`, '    3)']);
    } else {
      elems.push([`  (define-fun ${d.name} () ${d.sort}`, `    ${kind === 'unfixable' ? '(+ k!0 1)' : valueOf(d.sort, kind)})`]);
    }
  }
  elems.reverse();
  elems.push(['  (define-fun k!0 () Int', '    5)']);
  if (kind === 'huge') {
    let size = 0;
    for (let n = 1; size <= TOOL_OUTPUT_MAX_BYTES + 65536; n += 1) {
      const e = [`  (define-fun k!${n} () Int`, '    0)'];
      size += e[0].length + e[1].length + 2;
      elems.push(e);
    }
  }
  const lines = ['(', ...elems.flat(), ')'];
  if (kind === 'malformed') lines.push('(extra)');
  return lines;
}

if (args.includes('-version')) {
  log({ kind: 'version' });
  finish('Z3 version 5.3.3 - 64 bit\n', 0);
} else {
  const tArg = args.find((a) => a.startsWith('-T:'));
  const limitMs = tArg ? Number(tArg.slice(3)) * 1000 : Infinity;
  const withModel = args.includes('-model');

  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { input += c; });
  process.stdin.on('end', () => {
    const pick = (name) => {
      const m = input.match(new RegExp(`^\\s*; fake-${name}: (.+)$`, 'm'));
      return m ? m[1].trim() : null;
    };
    const query_sha256 = createHash('sha256').update(input).digest('hex');
    // 注釈の行のうち fake- の指示でないもの（テストが実行の種類を見分ける印。例 `; property P1`）
    const labels = input.split('\n').filter((l) => /^\s*;/.test(l) && !/^\s*; fake-/.test(l)).map((l) => l.trim());
    const always = own.mode === 'always-unsat';
    const mode = always ? 'answer' : (pick('mode') ?? 'answer');
    const result = always ? 'unsat' : (pick('result') ?? 'unsat');
    const sleep = Number(pick('sleep-ms') ?? 0);
    const exitCode = Number(pick('exit') ?? 0);
    const modelKind = pick('model') ?? 'real';
    const modelText = pick('model-text');
    const modelSleep = Number(pick('model-sleep-ms') ?? 0);
    const timedOut = sleep > limitMs;
    log({ kind: 'query-start', query_sha256, labels, mode, result, sleep_ms: sleep, with_model: withModel });
    setTimeout(() => {
      const answer = timedOut ? 'timeout' : result;
      const emitModel = withModel && !timedOut && mode === 'answer' && (answer === 'sat' || answer === 'unknown') && modelKind !== 'none';
      log({ kind: 'query-end', query_sha256, mode, result: answer, model: emitModel ? modelKind : null });
      if (timedOut) { finish('timeout\n', 0); return; }
      switch (mode) {
        case 'syntax-error':
          finish('(error "line 1 column 1: invalid command, symbol expected")\n', 1);
          break;
        case 'oom':
          process.stderr.write('(error "out of memory")\n', () => process.exit(101));
          break;
        case 'crash':
          process.exit(exitCode === 0 ? 3 : exitCode);
          break;
        case 'empty':
          process.exit(0);
          break;
        case 'multi':
          finish('sat\nunsat\n', 0);
          break;
        case 'multi-junk':
          finish('maybe\nsat\n', 0);
          break;
        case 'error-after-answer': {
          // 実測（Z3 5.3.3）: -model のモデルは終了の時に出るので、(error …) の行の後に来る
          const model = withModel ? `${modelLines(input, 'real').join('\n')}\n` : '';
          finish(`sat\n(error "line 4 column 11: unknown constant y")\n${model}`, 1);
          break;
        }
        default: {
          if (!emitModel) { finish(`${result}\n`, exitCode); break; }
          const lines = modelText !== null ? JSON.parse(modelText).replace(/\n$/, '').split('\n') : modelLines(input, modelKind);
          const head = `${result}\n${lines[0]}\n`;
          const rest = `${lines.slice(1).join('\n')}\n`;
          if (modelSleep > 0) {
            process.stdout.write(head);
            setTimeout(() => finish(rest, exitCode), modelSleep);
          } else {
            finish(head + rest, exitCode);
          }
        }
      }
    }, timedOut ? limitMs : sleep);
  });
}
