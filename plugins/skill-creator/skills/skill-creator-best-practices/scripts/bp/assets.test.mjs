import test from 'node:test';
import assert from 'node:assert/strict';
import { splitAssets } from './assets.mjs';
import { fingerprintSet } from './ids.mjs';

const DOC = [
  '---',
  'name: demo',
  '---',
  '前置きの本文',
  '',
  '# 手順',
  '本文 1',
  '```sh',
  '# コードの中の行',
  '```',
  '## 注意',
  'a',
  '# 手順',
  '本文 2',
  '## 注意',
  'b',
  '見出し setext',
  '---',
  '本文 3',
  '',
].join('\n');

test('SP-BPFINDINGS-002 @normal:structured-assets: frontmatter・前置き・同名の見出し 2 つ・コードブロックの中の # 行を含む Markdown と script 1 つで、資産の数と範囲の位置を照らす', () => {
  const md = splitAssets('SKILL.md', DOC);
  assert.deepEqual(md.map((a) => a.loc), [
    { k: 'fm' },
    { k: 'pre' },
    { k: 'sec', h: [[1, '手順']], n: 1 },
    { k: 'sec', h: [[1, '手順'], [2, '注意']], n: 1 },
    { k: 'sec', h: [[1, '手順']], n: 2 },
    { k: 'sec', h: [[1, '手順'], [2, '注意']], n: 2 },
    { k: 'sec', h: [[1, '手順'], [2, '見出し setext']], n: 1 },
  ]);
  const script = splitAssets('scripts/run.js', '# not a heading\nconsole.log(1)\n');
  assert.deepEqual(script.map((a) => a.loc), [{ k: 'file' }]);
  assert.equal(new Set(md.map((a) => a.id)).size, md.length);
  assert.ok(md.every((a) => /^A[0-9A-Z]{10}$/.test(a.id)));
});

test('SP-BPFINDINGS-002 @boundary:line-shift: 範囲の位置は行番号を持たない', () => {
  const shifted = splitAssets('SKILL.md', DOC.replace('前置きの本文', '前置きの本文\n足した行\n足した行'));
  assert.deepEqual(shifted.map((a) => a.id), splitAssets('SKILL.md', DOC).map((a) => a.id));
  for (const a of shifted) assert.equal(JSON.stringify(a.loc).match(/"(line|start|end)"/), null);
});

test('SP-BPFINDINGS-003: 節の本文だけを書き換えて列挙し直しても、資産 ID が変わらない', () => {
  const before = splitAssets('SKILL.md', DOC);
  const after = splitAssets('SKILL.md', DOC.replace('本文 1', '書き換えた本文'));
  assert.deepEqual(after.map((a) => a.id), before.map((a) => a.id));
});

test('SP-BPFINDINGS-003: 同じ入力で 2 回列挙し、資産 ID が一致する', () => {
  assert.deepEqual(splitAssets('SKILL.md', DOC), splitAssets('SKILL.md', DOC));
});

test('SP-BPFINDINGS-004 @normal:one-character: 1 字だけ変えた節の内容の指紋が変わり、他の節の指紋は変わらない', () => {
  const before = splitAssets('SKILL.md', DOC);
  const after = splitAssets('SKILL.md', DOC.replace('本文 2', '本文 X'));
  const changed = before.filter((a, i) => a.digest !== after[i].digest).map((a) => a.loc);
  assert.deepEqual(changed, [{ k: 'sec', h: [[1, '手順']], n: 2 }]);
});

test('SP-BPFINDINGS-002 @boundary:fence-setext: ~~~ のフェンスと閉じない setext の下線を見出しに数えない', () => {
  const doc = '# A\n~~~\n## 中\n~~~\n\n---\n## B\n';
  assert.deepEqual(splitAssets('x.md', doc).map((a) => a.loc), [
    { k: 'sec', h: [[1, 'A']], n: 1 },
    { k: 'sec', h: [[1, 'A'], [2, 'B']], n: 1 },
  ]);
});


test('SP-BPFINDINGS-002: 空白だけの Markdown と最小の見出しを区別する', async (t) => {
  const cases = [
    { id: 'empty-markdown', text: '', locs: [] },
    { id: 'whitespace-markdown', text: ' \n\t\n', locs: [] },
    { id: 'minimal-heading', text: '#', locs: [{ k: 'sec', h: [[1, '']], n: 1 }] },
  ];
  for (const { id, text, locs } of cases) {
    await t.test(`@boundary:${id}`, () => {
      assert.deepEqual(splitAssets('x.md', text).map((asset) => asset.loc), locs);
    });
  }
});

test('SP-BPFINDINGS-003: 空ファイルに内容を足しても同じ位置なら ID は変わらない', () => {
  const empty = splitAssets('x.js', '');
  const populated = splitAssets('x.js', 'x');
  assert.equal(empty.length, 1);
  assert.equal(populated[0].id, empty[0].id);
  assert.notEqual(splitAssets('y.js', '')[0].id, empty[0].id);
});

test('SP-BPFINDINGS-004 @boundary:raw-bytes: 空の内容の指紋と改行を正規化しない境界を照らす', () => {
  assert.equal(splitAssets('x.js', '')[0].digest, 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  const digests = ['x', 'x\n', 'x\r\n'].map((text) => splitAssets('x.js', text)[0].digest);
  assert.equal(new Set(digests).size, 3);
  assert.ok(digests.every((digest) => /^[0-9a-f]{64}$/.test(digest)));
});


test('SP-BPFINDINGS-004 @normal:fingerprint-set: 担当の指紋は資産 ID 順で決まり、列挙順に依存しない', () => {
  const first = { A1: '0'.repeat(64), A2: '1'.repeat(64) };
  const reversed = { A2: first.A2, A1: first.A1 };
  assert.equal(fingerprintSet(first), '800e1b6df1a3de3e791a1ab598443791eadf47272f97b67c0affe56c7b7e5d37');
  assert.equal(fingerprintSet(reversed), fingerprintSet(first));
  assert.notEqual(fingerprintSet({ ...first, A2: '2'.repeat(64) }), fingerprintSet(first));
});
