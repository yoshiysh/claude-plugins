import test from 'node:test';
import assert from 'node:assert/strict';
import { tableAfter } from './helpers/bp-docs.mjs';

test('検証方法: 表を読む処理は、表の途中に空行が挟まると残りの行を黙って捨てずに落ちる', () => {
  const header = '| a | b |';
  assert.deepEqual(tableAfter(`${header}\n|---|---|\n| 1 | 2 |\n\n## 次`, header), [['1', '2']]);
  assert.throws(() => tableAfter(`${header}\n|---|---|\n| 1 | 2 |\n\n| 3 | 4 |\n## 次`, header), /表の途中/);
  assert.throws(() => tableAfter('| x |', header), /表が無い/);
});
