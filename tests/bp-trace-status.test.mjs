import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SPECS = path.join(ROOT, 'docs', 'specifications');
const TEST_DIRS = [path.join(ROOT, 'tests'), path.join(ROOT, 'plugins', 'skill-creator', 'skills', 'skill-creator-best-practices', 'scripts', 'bp')];

function testTitles() {
  return TEST_DIRS.flatMap((dir) => readdirSync(dir).filter((f) => f.endsWith('.test.mjs')).map((f) => readFileSync(path.join(dir, f), 'utf8')))
    .flatMap((text) => [...text.matchAll(/\btest\(\s*([`'"])((?:(?!\1).)*)\1/g)].map((m) => m[2]));
}

// テストの有無しか見ない（確かめ方が行の検証方法に足りるかは見ない。それは生成者と別の検証役が行とテストを突き合わせて見る）。
// 「完了」の行にテスト名の無い仕様項目があれば、テストの無い行を「完了」にしている。
test('検証方法: best-practices の仕様書のトレーサビリティ表で「完了」の行の仕様項目 ID が、どれかのテスト名に現れる', () => {
  const ids = new Set(testTitles().flatMap((t) => t.match(/SP-[A-Z]+-\d{3}/g) ?? []));
  const missing = [];
  let rows = 0;
  for (const file of readdirSync(SPECS).filter((f) => /^bp-.*\.md$/.test(f))) {
    for (const line of readFileSync(path.join(SPECS, file), 'utf8').split('\n')) {
      if (!/^\| PR-[^|]*\|[^|]*\|[^|]*\| 完了 \|$/.test(line)) continue;
      rows += 1;
      const id = line.split('|')[2].trim();
      if (!ids.has(id)) missing.push(`${file}: ${id}`);
    }
  }
  assert.ok(rows > 0);
  assert.deepEqual([...new Set(missing)], []);
});
