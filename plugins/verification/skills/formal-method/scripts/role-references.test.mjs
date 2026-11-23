// 役ごとの義務と型の抜粋（生成物）と、その正本 references/agent-obligations.md・references/artifact-formats.md の一致。
// 生成は scripts/role-references.mjs が決定的に行う。正本を直して生成し直さないと、ここで落ちる（make check の全テストに入る）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRoleReferences, OBLIGATION_FILES, ROLE_TYPES, TYPES_DIR } from './role-references.mjs';
import { ROLES, AUTHOR_ROLES, CONFIRMER_ROLES, instructionsOf } from './lib/roles.mjs';

const SKILL = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => readFileSync(join(SKILL, rel), 'utf8');

test('SP-FORMALMETHOD-013 役ごとの参照: 生成物は正本から作り直したものとバイト列で一致する（直し方: node scripts/role-references.mjs）', () => {
  const files = buildRoleReferences(SKILL);
  assert.ok(files.length > 0);
  for (const f of files) {
    assert.ok(existsSync(join(SKILL, f.path)), `${f.path} が無い。直し方: node ${join(SKILL, 'scripts', 'role-references.mjs')}`);
    assert.equal(read(f.path), f.text, `${f.path} が正本と食い違う。直し方: node ${join(SKILL, 'scripts', 'role-references.mjs')}`);
  }
  // 生成物の置き場に、生成しないファイルを置かない（古い役の残りを拾わない）
  const made = new Set(files.map((f) => f.path));
  for (const dir of [TYPES_DIR, 'references/obligations']) {
    for (const name of readdirSync(join(SKILL, dir))) assert.ok(made.has(`${dir}/${name}`), `${dir}/${name} は生成物でない`);
  }
});

test('SP-FORMALMETHOD-013 役ごとの参照: 生成は決定的（2 度作って同じ）で、全ての役に型の抜粋がある', () => {
  assert.deepEqual(buildRoleReferences(SKILL), buildRoleReferences(SKILL));
  assert.deepEqual(Object.keys(ROLE_TYPES).sort(), Object.keys(ROLES).sort());
});

test('SP-FORMALMETHOD-013 役ごとの義務: 作成役の分は作成役の禁止を持ち独立検証者の読む範囲を持たず、確認役の分はその逆。どちらも共通の節を持つ', () => {
  const author = read(OBLIGATION_FILES.author);
  const confirmer = read(OBLIGATION_FILES.confirmer);
  for (const common of ['## 受け取るもの', '## 書く場所と返し方', '## 作業記録', '## 成功に読み替えない・秘密値・限界']) {
    assert.ok(author.includes(common) && confirmer.includes(common), common);
  }
  assert.ok(author.includes('## 作成役の禁止') && !author.includes('## 独立検証者の読む範囲'));
  assert.ok(confirmer.includes('## 独立検証者の読む範囲') && !confirmer.includes('## 作成役の禁止'));
  // 正本より短い（役に関係しない節を読ませない）
  const whole = Buffer.byteLength(read('references/agent-obligations.md'));
  assert.ok(Buffer.byteLength(author) < whole && Buffer.byteLength(confirmer) < whole);
});

test('SP-FORMALMETHOD-013 役ごとの参照: task の instructions は役の指示・その役の分の義務・その役の型の抜粋の 3 つの実在する絶対パス', () => {
  for (const role of Object.keys(ROLES)) {
    const ins = instructionsOf(role).map((rel) => join(SKILL, rel));
    const cls = AUTHOR_ROLES.includes(role) ? 'author' : 'confirmer';
    assert.deepEqual(ins, [join(SKILL, 'agents', `${role}.md`), join(SKILL, OBLIGATION_FILES[cls]), join(SKILL, TYPES_DIR, `${role}.md`)], role);
    for (const p of ins) assert.ok(existsSync(p), p);
  }
  assert.equal(AUTHOR_ROLES.length + CONFIRMER_ROLES.length, Object.keys(ROLES).length);
});

test('SP-FORMALMETHOD-013 型の抜粋: 抜粋の型の定義は artifact-formats.md の同じ行の写しで、役の指示が挙げる型を含む', () => {
  const source = read('references/artifact-formats.md');
  const want = {
    extractor: ['Inventory', 'Question', 'Worklog', 'RefHash'],
    'model-author': ['ModelFile', 'Clause', 'StateMachine', 'MappingFile', 'Worklog'],
    'partition-author': ['PartitionsFile', 'ModelFile', 'Worklog'],
    'plan-author': ['PlanFile', 'MutationsFile', 'ModelFile', 'Worklog'],
    'extraction-reviewer': ['Inventory', 'Worklog'],
    'fidelity-reviewer': ['ModelFile', 'Clause', 'MappingFile', 'Judgment', 'Worklog'],
    'assurance-reviewer': ['Inventory', 'Worklog'],
    'composition-reviewer': ['PartitionsFile', 'ModelFile', 'Worklog'],
    'cause-analyst': ['ModelFile', 'Counterexample', 'Question', 'Worklog'],
  };
  for (const [role, names] of Object.entries(want)) {
    const text = read(`${TYPES_DIR}/${role}.md`);
    for (const n of names) assert.match(text, new RegExp(`^\\s*${n}\\s*= `, 'm'), `${role} の抜粋に ${n} が無い`);
    // 型の定義の行（"X = " で始まる行）は、正本の行と同じ（抜粋は加工しない）
    for (const line of text.split('\n').filter((l) => /^[A-Z][A-Za-z]*\s*= /.test(l))) assert.ok(source.includes(line), `${role}: 正本に無い行 ${line}`);
    // 抜粋の中のリンクは、置き場から解ける相対パスか、この抜粋の中の見出し
    for (const m of text.matchAll(/\]\(([^)#]+)(#[^)]*)?\)/g)) assert.ok(existsSync(join(SKILL, TYPES_DIR, m[1])), `${role}: 解けないリンク ${m[1]}`);
  }
});

test('SP-FORMALMETHOD-013 役の指示: agents/*.md の型と義務の参照は、その役の型の抜粋と役の分の義務を指し、artifact-formats.md・agent-obligations.md を読ませない', () => {
  for (const role of Object.keys(ROLES)) {
    const text = read(`agents/${role}.md`);
    assert.ok(!text.includes('artifact-formats.md'), `agents/${role}.md が artifact-formats.md を指す`);
    assert.ok(!text.includes('agent-obligations.md'), `agents/${role}.md が agent-obligations.md を指す`);
    assert.ok(text.includes(`../references/types/${role}.md`), `agents/${role}.md が型の抜粋を指さない`);
  }
});

test('SP-FORMALMETHOD-014 役ごとの義務: 担当に文書の一般規約の写しを読ませず、指紋を手で求めさせない（CLI が claim の document_rules と submit の照合で持つ）', () => {
  for (const path of Object.values(OBLIGATION_FILES)) {
    const text = read(path);
    assert.ok(!text.includes('<run_dir>/document-rules/'), `${path} が規約の写しを読ませる`);
    assert.ok(!text.includes('createHash'), `${path} が指紋の command を持つ`);
    assert.ok(text.includes('document_rules'), `${path} が claim の document_rules を挙げない`);
  }
  assert.ok(!read('agents/extractor.md').includes('createHash'), 'extractor.md が quote_hash の command を持つ');
});
