// unit: scripts/lib/roles.mjs の AGENT_PERMISSIONS と、Workflow script の meta.requirements の一致（architecture.md「担当の起動」）。
// Workflow script は import せず（本文が実行され、ホストの global が無いので落ちる）、本文を architecture.md の 4 つの手順で読む。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AGENT_PERMISSIONS_CONTRACT } from '../test-fixtures/ledger-check.mjs';

const loadRoles = () => import('./roles.mjs');
const WORKFLOW_TEXT = () => readFileSync(new URL('../formal-method-agents.js', import.meta.url), 'utf8');

// architecture.md「担当の起動」の手順 1〜3。成り立てば { value }、成り立たなければ { error }（手順 4 の不一致）
function readRequirements(text) {
  const lines = text.split(/\r?\n/);
  // 1. 行頭の `export const meta = {` の行から、次の `}` だけの行まで
  const start = lines.findIndex((l) => l.startsWith('export const meta = {'));
  if (start < 0) return { error: 'meta の範囲の始まりが無い' };
  const endRel = lines.slice(start + 1).findIndex((l) => l === '}');
  if (endRel < 0) return { error: 'meta の範囲の終わりが無い' };
  const range = lines.slice(start, start + 1 + endRel + 1);
  // 2. 範囲の行のうち、requirements の行がちょうど 1 つ
  const hits = range.map((l) => l.match(/^\s*requirements:\s*\[([^\]]*)\],?\s*$/)).filter(Boolean);
  if (hits.length !== 1) return { error: `requirements の行が ${hits.length} 個` };
  // 3. `,` で分け、前後の空白を除いた各要素が ^'[a-z-]+'$
  const items = hits[0][1].split(',').map((x) => x.trim());
  if (!items.every((x) => /^'[a-z-]+'$/.test(x))) return { error: `要素の形が違う: ${hits[0][1]}` };
  return { value: items.map((x) => x.slice(1, -1)) };
}
// 4. 値が期待と順も含めて等しいときだけ一致
const matches = (text, expected) => { const r = readRequirements(text); return !r.error && JSON.stringify(r.value) === JSON.stringify(expected); };

const SAMPLE = (inner) => `export const meta = {\n  name: 'formal-method-agents',\n${inner}\n  phases: [],\n}\n\nexport default async function run() {}\n`;
const GOOD = "  requirements: ['fresh-thread', 'workspace-write'],";
const BROKEN = [
  // [名前, 本文]
  ['meta の範囲が無い', `const meta = {\n${GOOD}\n}\n`],
  ['meta の範囲の終わりの } だけの行が無い', `export const meta = {\n${GOOD}\n  phases: [] }\n`],
  ['requirements の行が 2 つある', SAMPLE(`${GOOD}\n${GOOD}`)],
  ['requirements の行が無い', SAMPLE("  name2: 'x',")],
  ['要素が二重引用符', SAMPLE('  requirements: ["fresh-thread", "workspace-write"],')],
  ['要素に大文字', SAMPLE("  requirements: ['Fresh-thread', 'workspace-write'],")],
  ['要素が文字列でない', SAMPLE("  requirements: ['fresh-thread', WRITE],")],
  ['requirements が meta の範囲の外にだけある', `export const meta = {\n  name: 'x',\n}\nconst other = {\n${GOOD}\n}\n`],
  ['順が違う', SAMPLE("  requirements: ['workspace-write', 'fresh-thread'],")],
];

test('roles 自己検査: 手順どおりの本文は一致し、手順 1〜3 のどれかが崩れた本文と順の違いは不一致になる', () => {
  assert.deepEqual(readRequirements(SAMPLE(GOOD)), { value: AGENT_PERMISSIONS_CONTRACT });
  assert.equal(matches(SAMPLE(GOOD), AGENT_PERMISSIONS_CONTRACT), true);
  assert.equal(matches(SAMPLE("  requirements: ['fresh-thread', 'workspace-write']"), AGENT_PERMISSIONS_CONTRACT), true, '末尾の , は省ける');
  for (const [name, text] of BROKEN) assert.equal(matches(text, AGENT_PERMISSIONS_CONTRACT), false, name);
});

test('architecture 担当の起動: Workflow script の meta.requirements は手順どおりに読め、契約の値 ["fresh-thread","workspace-write"] と一致する', () => {
  const r = readRequirements(WORKFLOW_TEXT());
  assert.equal(r.error, undefined, r.error);
  assert.deepEqual(r.value, AGENT_PERMISSIONS_CONTRACT);
});

test('architecture 担当の起動: roles.mjs の AGENT_PERMISSIONS は、Workflow script の meta.requirements と順も含めて一致する', async () => {
  const { AGENT_PERMISSIONS } = await loadRoles();
  assert.ok(Array.isArray(AGENT_PERMISSIONS), 'AGENT_PERMISSIONS は配列');
  const r = readRequirements(WORKFLOW_TEXT());
  assert.equal(r.error, undefined, r.error);
  assert.equal(matches(WORKFLOW_TEXT(), AGENT_PERMISSIONS), true, `${JSON.stringify(r.value)} と ${JSON.stringify(AGENT_PERMISSIONS)}`);
});
