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

test('検証方法: 模擬の検証役の種類の選び方は、prompt に埋めた強いられた未検査を除いた閉集合の先頭を選び、全て強いられていれば落ちる', async () => {
  const env = { readFromPrompt: async () => ({ kinds: [{ value: 'a' }, { value: 'b' }] }) };
  assert.equal(await firstUnforcedKind('"forced":["a"]', env), 'b');
  assert.equal(await firstUnforcedKind('埋め込み無し', env), 'a');
  await assert.rejects(firstUnforcedKind('"forced":["a","b"]', env), /閉集合に無い/);
});
