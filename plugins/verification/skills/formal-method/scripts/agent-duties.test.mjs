// 担当の指示から、実行体と照合が決める値を書く義務を除いたことを、指示と型の抜粋の字句で確かめる（#264）。
// SP-264-021: plan-author は検査と sanity の列挙・input_refs・depends_on・detector_check_id を書かない（plan-skeleton が決め、CLI が組み立てる）。
// SP-264-024: composition-reviewer は前提の循環と分割前後の対応の無い要素を確かめない（compose.mjs:128 と result.mjs:341,350 の照合が判定する）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILL = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => readFileSync(join(SKILL, rel), 'utf8');
const hitsOf = (text, words) => text.split('\n').flatMap((l, i) => words.filter((w) => l.includes(w)).map((w) => `L${i + 1} ${w}: ${l.trim().slice(0, 120)}`));

const WORDS = ['depends_on', 'detector_check_id', 'input_refs'];
test('SP-264-021: plan-author の指示に depends_on・detector_check_id・input_refs の語が無い', () => {
  assert.deepEqual(hitsOf(read('agents/plan-author.md'), WORDS), [], 'agents/plan-author.md に CLI が決める欄の語が残っている');
});

// 型の抜粋（references/types/plan-author.md）は references/artifact-formats.md から role-references.mjs が生成する。
// 抜粋は plan-author が読む型（PartitionsFile の composition_conditions[].depends_on、返り値の depends_on_questions）も含むので、
// 語を禁じるのは plan-author が書く型の節（「plan と mutations（計画作成役）」）だけにする。artifact-formats.md を直すのは文書の単位（U6）なので、
// plugin の版を上げた後（U6 の後）に当てる。版の上げ忘れは core-wiring.test.mjs の「U6 の印は揃って現れる」が捉え、
// 版が 0.2.0 であることも core-wiring.test.mjs が確かめる。上の agents/plan-author.md の検査は版に関わらず当てる
const U6_READY = JSON.parse(readFileSync(join(SKILL, '..', '..', '.claude-plugin', 'plugin.json'), 'utf8')).version !== '0.1.1';
test('SP-264-021: plan-author の型の抜粋の、計画作成役が書く型の節に depends_on・detector_check_id・input_refs の語が無い', { skip: !U6_READY && 'artifact-formats.md を直す U6 の前' }, () => {
  const doc = read('references/types/plan-author.md');
  const m = doc.match(/^## plan と mutations[^\n]*\n([\s\S]*?)(?=^## |(?![\s\S]))/m);
  assert.ok(m, '型の抜粋に「plan と mutations」の節が無い');
  assert.deepEqual(hitsOf(m[1], WORDS), []);
});

test('SP-264-024: composition-reviewer の指示に「循環」と「対応の無い要素」の語が無い', () => {
  // 観点を外したことを語で確かめる。照合が判定することを説明する文も置かない（担当がその観点で指摘を書く余地を残さない）
  assert.deepEqual(hitsOf(read('agents/composition-reviewer.md'), ['循環', '対応の無い要素']), []);
});

test('SP-264-024: ReviewReturn の指摘の kind から circular_assumption を除かない（他の観点の役も使う）', () => {
  assert.match(read('scripts/lib/schemas.mjs'), /circular_assumption/);
});
