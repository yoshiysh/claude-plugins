// 自己検査: 偽の z3（test-fixtures/fake-z3.mjs）が、cli-contract.md「Z3 の adapter」の実測の表の形で出力と終了コードを返す。
// 結合のケースが偽の z3 で契約の振る舞いを起こせることを、CLI を使わずに確かめる。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSexprs } from './test-fixtures/decomposition-check.mjs';

const FAKE = fileURLToPath(new URL('./test-fixtures/fake-z3.mjs', import.meta.url));
import { TOOL_OUTPUT_MAX_BYTES } from './test-fixtures/constants.mjs';

function runFake(args, query) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(process.execPath, [FAKE, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks = [];
    let firstAt = null;
    let stderr = '';
    child.stdout.on('data', (c) => { if (firstAt === null) firstAt = Date.now(); chunks.push(c); });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', reject);
    child.on('close', (code) => {
      const stdout = Buffer.concat(chunks).toString('utf8');
      resolve({ code, stdout, stderr, bytes: Buffer.concat(chunks).length, lines: stdout.split('\n').filter((l) => l.trim()), firstMs: firstAt === null ? null : firstAt - started, totalMs: Date.now() - started });
    });
    child.stdin.end(query);
  });
}

const q = (directives, body = '(declare-const x Int)\n(assert (> x 1))') => `${Object.entries(directives).map(([k, v]) => `; fake-${k}: ${v}`).join('\n')}\n${body}\n(check-sat)\n`;
// 答えの行の後の文字列（モデルの文字列）
const modelText = (out) => out.stdout.slice(out.stdout.indexOf('\n') + 1);

const CASES = [
  // [名前, 引数, 指示, 期待の答えの行, モデルの検査, 終了コード]
  ['-model なしの sat は答えの 1 行だけ', ['-in', '-T:5'], { result: 'sat' }, 'sat', 'none', 0],
  ['-model の sat は答えの後に 1 つの list のモデル', ['-in', '-T:5', '-model'], { result: 'sat' }, 'sat', 'list', 0],
  ['-model の unknown も答えの後にモデル（実測の一部の unknown）', ['-in', '-T:5', '-model'], { result: 'unknown' }, 'unknown', 'list', 0],
  ['-model の unsat の後にモデルは出ない（実測）', ['-in', '-T:5', '-model'], { result: 'unsat' }, 'unsat', 'none', 0],
  ['-model の timeout は 1 行だけ（実測）', ['-in', '-T:5', '-model'], { result: 'timeout' }, 'timeout', 'none', 0],
  ['-T を超える遅れは -model でも timeout の 1 行だけ', ['-in', '-T:1', '-model'], { result: 'sat', 'sleep-ms': 3000 }, 'timeout', 'none', 0],
  ['model none は -model でもモデルを出さない', ['-in', '-T:5', '-model'], { result: 'sat', model: 'none' }, 'sat', 'none', 0],
  ['model malformed は list の後に空白でない form が残る', ['-in', '-T:5', '-model'], { result: 'sat', model: 'malformed' }, 'sat', 'trailing', 0],
  ['model unfixable は宣言した記号の値が literal でない', ['-in', '-T:5', '-model'], { result: 'sat', model: 'unfixable' }, 'sat', 'unfixable', 0],
  ['mode multi は sat と unsat の 2 行', ['-in', '-T:5', '-model'], { mode: 'multi' }, 'sat', 'multi', 0],
  ['mode multi-junk は答えでない行で始まる 2 行', ['-in', '-T:5', '-model'], { mode: 'multi-junk' }, 'maybe', 'multi-junk', 0],
  ['構文の誤りは標準出力に (error と終了コード 1', ['-in', '-T:5', '-model'], { mode: 'syntax-error' }, null, 'error', 1],
  ['答えの後の誤った form は sat・(error・モデルの順で終了コード 1（-model、実測）', ['-in', '-T:5', '-model'], { mode: 'error-after-answer' }, 'sat', 'error-then-model', 1],
  ['答えの後の誤った form は -model なしで sat と (error の 2 行', ['-in', '-T:5'], { mode: 'error-after-answer' }, 'sat', 'error-only', 1],
];
for (const [name, args, directives, answer, model, code] of CASES) {
  test(`fake-z3 の自己検査: ${name}`, async () => {
    const out = await runFake(args, q(directives));
    assert.equal(out.code, code, out.stderr);
    if (answer !== null) assert.equal(out.lines[0], answer);
    const rest = modelText(out);
    switch (model) {
      case 'none': assert.deepEqual(out.lines, [answer]); break;
      case 'list': {
        const forms = parseSexprs(rest);
        assert.equal(forms.length, 1, 'モデルはちょうど 1 つの list');
        const defs = forms[0].node;
        assert.ok(Array.isArray(defs) && defs.every((e) => Array.isArray(e) && e[0] === 'define-fun'), rest);
        assert.deepEqual(defs.find((e) => e[1] === 'x'), ['define-fun', 'x', [], 'Int', '2'], '宣言した x の引数の無い定義');
        assert.ok(defs.some((e) => e[1] === 'k!0'), '補助の記号の定義');
        break;
      }
      case 'trailing': assert.equal(parseSexprs(rest).length, 2, 'list の後に form が残る'); break;
      case 'unfixable': {
        const [{ node }] = parseSexprs(rest);
        assert.deepEqual(node.find((e) => e[1] === 'x')[4], ['+', 'k!0', '1']);
        break;
      }
      case 'multi': assert.deepEqual(out.lines, ['sat', 'unsat']); break;
      case 'multi-junk': assert.deepEqual(out.lines, ['maybe', 'sat']); break;
      case 'error': assert.ok(out.lines.some((l) => l.startsWith('(error'))); break;
      case 'error-then-model': assert.ok(out.lines[1].startsWith('(error')); assert.equal(parseSexprs(rest).length, 2, '(error …) とモデルの list'); break;
      case 'error-only': assert.equal(out.lines.length, 2); assert.ok(out.lines[1].startsWith('(error')); break;
      default: assert.fail(model);
    }
  });
}

test('fake-z3 の自己検査: real のモデルは query の宣言の逆順（実測も宣言の順でない）に sort ごとの値を持ち、引数のある関数も定義する（実測の形）', async () => {
  const body = '(declare-const x Int)\n(declare-const r Real)\n(declare-fun b () Bool)\n(declare-const s String)\n(declare-const v (_ BitVec 8))\n(declare-const w (_ BitVec 3))\n(declare-const a (Array Int Int))\n(declare-fun f (Int) Int)';
  const out = await runFake(['-in', '-T:5', '-model'], q({ result: 'sat' }, body));
  const [{ node }] = parseSexprs(modelText(out));
  assert.deepEqual(node, [
    ['define-fun', 'f', [['x!0', 'Int']], 'Int', '3'],
    ['define-fun', 'a', [], ['Array', 'Int', 'Int'], [['as', 'const', ['Array', 'Int', 'Int']], '0']],
    ['define-fun', 'w', [], ['_', 'BitVec', '3'], '#b000'],
    ['define-fun', 'v', [], ['_', 'BitVec', '8'], '#x00'],
    ['define-fun', 's', [], 'String', '"ab"'],
    ['define-fun', 'b', [], 'Bool', 'true'],
    ['define-fun', 'r', [], 'Real', ['-', ['/', '3.0', '2.0']]],
    ['define-fun', 'x', [], 'Int', '2'],
    ['define-fun', 'k!0', [], 'Int', '5'],
  ]);
  // 実測の形: 項は定義の頭の次の行に 4 つの空白で字下げして置く
  assert.match(out.stdout, /\n {2}\(define-fun x \(\) Int\n {4}2\)\n/);
});

test('fake-z3 の自己検査: model-text は指定した文字列をそのままモデルとして出し、model secret は String の値を秘密値の型にする（query には書かない）', async () => {
  const text = '(\n  ; 注釈\n  (define-fun p () Int\n    4)\n)\n';
  const a = await runFake(['-in', '-T:5', '-model'], q({ result: 'sat', 'model-text': JSON.stringify(text) }));
  assert.equal(a.stdout, `sat\n${text}`);
  const query = q({ result: 'sat', model: 'secret' }, '(declare-const t String)');
  assert.doesNotMatch(query, /AKIA/);
  const b = await runFake(['-in', '-T:5', '-model'], query);
  assert.match(b.stdout, /\b(AKIA|ASIA)[0-9A-Z]{16}\b/, 'cli-contract 秘密値の走査の aws_access_key_id の型');
});

test('fake-z3 の自己検査: model huge は TOOL_OUTPUT_MAX_BYTES を超える出力を最後まで書く', async () => {
  const out = await runFake(['-in', '-T:5', '-model'], q({ result: 'sat', model: 'huge' }));
  assert.equal(out.code, 0);
  assert.ok(out.bytes > TOOL_OUTPUT_MAX_BYTES, `${out.bytes} バイト`);
  assert.equal(out.lines[0], 'sat');
  assert.equal(parseSexprs(modelText(out)).length, 1, '途中で切れずに 1 つの list');
});

test('fake-z3 の自己検査: model-sleep-ms は答えの行を先に書き、モデルの残りを遅らせる', async () => {
  const out = await runFake(['-in', '-T:5', '-model'], q({ result: 'sat', 'model-sleep-ms': 1500 }));
  assert.equal(out.lines[0], 'sat');
  assert.ok(out.firstMs !== null && out.totalMs - out.firstMs >= 1200, `最初の出力 ${out.firstMs} ms、終わり ${out.totalMs} ms`);
  assert.equal(parseSexprs(modelText(out)).length, 1);
});

test('fake-z3 の自己検査: メモリ不足は標準エラーに (error "out of memory") と終了コード 101 で、答えの行が無い', async () => {
  const out = await runFake(['-in', '-T:5', '-model'], q({ mode: 'oom' }));
  assert.equal(out.code, 101);
  assert.deepEqual(out.lines, []);
  assert.match(out.stderr, /\(error "out of memory"\)/);
});

test('fake-z3 の自己検査: --fake-log は受け取った引数と、fake- の指示でない注釈の行（実行の印）を記録する', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fm-fake-'));
  try {
    const log = join(dir, 'calls.jsonl');
    await runFake([`--fake-log=${log}`, '-in', '-T:7', '-model'], q({ result: 'sat' }, '; property MP1\n(declare-const x Int)'));
    const entries = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const start = entries.find((e) => e.kind === 'query-start');
    assert.deepEqual(start.args, ['-in', '-T:7', '-model']);
    assert.deepEqual(start.labels, ['; property MP1']);
    assert.equal(start.with_model, true);
    assert.equal(entries.find((e) => e.kind === 'query-end').model, 'real');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
