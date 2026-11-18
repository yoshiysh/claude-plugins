import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// docs/ は配布されないので、prd-spec は依頼語の表を references に写して持つ。写しが片方だけ直されると、
// 要求（PR-REQUESTER-003）と実行時の判定が食い違う。
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
const SPLITTING = 'plugins/workflow/skills/prd-spec/references/document-splitting.md';
const REQUESTER = 'docs/requirements/requester.md';
const FLOW = 'docs/specifications/flow.md';
const KIND = { requirements: '要求文書', specifications: '仕様書', '**両方**': '要求文書と仕様書の両方' };

function section(text, start) {
  const from = text.indexOf(start);
  assert.notEqual(from, -1, `${start} が無い`);
  const rest = text.slice(from + start.length);
  const end = rest.search(/\n#{2,4} /);
  return end === -1 ? rest : rest.slice(0, end);
}

function rows(body) {
  return body.split('\n')
    .filter((l) => l.startsWith('|'))
    .map((l) => l.split('|').slice(1, -1).map((c) => c.trim()))
    .filter(([a]) => a !== '依頼文に現れる語' && !/^-+$/.test(a));
}

test('document-splitting §0 の表は PR-REQUESTER-003 の表と同じ語・同じ割り当て', () => {
  const skill = rows(section(read(SPLITTING), '## 0.')).map(([w, k]) => [w, KIND[k]]);
  const req = rows(section(read(REQUESTER), '#### PR-REQUESTER-003'));
  assert.equal(req.length, 3);
  assert.deepEqual(skill, req);
});

test('SP-FLOW-007 は表を写さず PR-REQUESTER-003 の表を指す', () => {
  const body = section(read(FLOW), '#### SP-FLOW-007');
  assert.deepEqual(rows(body), []);
  assert.match(body, /PR-REQUESTER-003 の表に従って/);
});
