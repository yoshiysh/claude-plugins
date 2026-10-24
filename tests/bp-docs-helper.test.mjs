import test from 'node:test';
import assert from 'node:assert/strict';
import { tableAfter } from './helpers/bp-docs.mjs';
import { firstUnforcedKind } from './helpers/bp-harness.mjs';

test('検証方法: 表を読む処理は、表の途中に空行が挟まると残りの行を黙って捨てずに落ちる', () => {
  const header = '| a | b |';
  assert.deepEqual(tableAfter(`${header}\n|---|---|\n| 1 | 2 |\n\n## 次`, header), [['1', '2']]);
  assert.throws(() => tableAfter(`${header}\n|---|---|\n| 1 | 2 |\n\n| 3 | 4 |\n## 次`, header), /表の途中/);
  assert.throws(() => tableAfter('| x |', header), /表が無い/);
});

test('検証方法: 表を読む処理は、表の直前の文を目印に読み、エスケープした | をセルの区切りにせず、目印の後の表でも途中の空行で落ちる', () => {
  const text = '段の表は次のとおり。\n\n| a | b |\n|---|---|\n| x \\| y | 2 |\n\n| 3 | 4 |\n';
  assert.throws(() => tableAfter(text, '段の表は次のとおり。'), /表の途中/);
  assert.deepEqual(tableAfter('段の表は次のとおり。\n\n| a | b |\n|---|---|\n| x \\| y | 2 |\n', '段の表は次のとおり。'), [['x \\| y', '2']]);
});

test('検証方法: 模擬の検証役の種類の選び方は、prompt に埋めた強いられた未検査を除いた閉集合の先頭を選び、全て強いられているか一覧の形を読めなければ落ちる', async () => {
  const env = { readFromPrompt: async () => ({ kinds: [{ value: 'a' }, { value: 'b' }] }) };
  assert.equal(await firstUnforcedKind('"forced":["a"]', env), 'b');
  assert.equal(await firstUnforcedKind('一覧を埋めない観点', env), 'a');
  await assert.rejects(firstUnforcedKind('"forced":["a","b"]', env), /閉集合に無い/);
  await assert.rejects(firstUnforcedKind('"forced": ["a"]', env), /形を読めない/);
});

test('検証方法: トレーサビリティ表を読む関数は 1 つで、表の途中に表の行でない行があれば投げ、黙って行を捨てない', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const { traceRows } = await import('../tools/lib/bp-docs.mjs');
  const { traceRows: readerRows } = await import('../tools/read-bp-trial.mjs');
  const dir = mkdtempSync(path.join(tmpdir(), 'bp-trace-'));
  const head = '## トレーサビリティ表\n\n| 要求 ID | 仕様項目 ID | 検証方法 | ステータス |\n|---|---|---|---|\n';
  writeFileSync(path.join(dir, 'ok.md'), `${head}| PR-1 | SP-A-1 | m \\| n | 完了 |\n`);
  writeFileSync(path.join(dir, 'broken.md'), `${head}| PR-1 | SP-A-1 | m | 完了 |\n\n| PR-2 | SP-A-2 | m | 完了 |\n`);
  assert.deepEqual(readerRows('ok.md', dir), traceRows('ok.md', dir));
  assert.equal(traceRows('ok.md', dir)[0].method, 'm \\| n');
  assert.throws(() => traceRows('broken.md', dir), /表の途中/);
  assert.throws(() => readerRows('broken.md', dir), /表の途中/);
});

test('検証方法: トレーサビリティ表を読む関数は、列の過不足・語彙に無いステータス・形の崩れた仕様項目 ID を範囲外として捨てずに投げる', async () => {
  const { traceTable } = await import('../tools/lib/bp-docs.mjs');
  const head = '| 要求 ID | 仕様項目 ID | 検証方法 | ステータス |\n|---|---|---|---|\n';
  assert.deepEqual(traceTable(`${head}| PR-1 | SP-A-001, SP-A-002 | m | 作成中 |\n`).map((r) => [r.line, r.ids]), [[3, ['SP-A-001', 'SP-A-002']]]);
  for (const [row, reason] of [
    ['| PR-1 | SP-A-001 | m | 完了 | extra |', /4 列でない/],
    ['| PR-1 | SP-A-001 | 完了 |', /4 列でない/],
    ['| PR-1 | SP-A-001 | m | done |', /語彙に無い/],
    ['| PR-1 | `SP-A-001` | m | 完了 |', /形が崩れている: 3 行目: `SP-A-001`/],
    ['| PR-1 | （SP-A-001） | m | 完了 |', /形が崩れている/],
    ['| PR-1 | SP-A-001 と SP-A-002 | m | 完了 |', /形が崩れている/],
  ]) assert.throws(() => traceTable(`${head}${row}\n`), reason, row);
});
