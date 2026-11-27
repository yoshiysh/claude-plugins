// 役ごとの義務と型の抜粋（生成物）と、その正本 references/agent-obligations.md・references/artifact-formats.md の一致。
// 生成は scripts/role-references.mjs が決定的に行う。正本を直して生成し直さないと、ここで落ちる（make check の全テストに入る）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRoleReferences, entryTypesOf, OBLIGATION_FILES, refsOf, ROLE_ENTRY_TYPES, TYPES_DIR } from './role-references.mjs';
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
  assert.deepEqual(Object.keys(ROLE_ENTRY_TYPES).sort(), Object.keys(ROLES).sort());
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

// #264（SP-264-090、design §4.7）: 作成役は下書きの型を書き、CLI が実行体の骨組みと下書きから今の型を組み立てる。
// 文書の単位（U6）が artifact-formats.md に下書きの型を定義し、ROLE_ENTRY_TYPES の writes を下書きの型に変えて生成し直す。
// それまで（plugin の版が 0.1.1 の間）は今の型を期待する。版の上げ忘れは core-wiring.test.mjs の「U6 の印は揃って現れる」が捉える
const U6_READY = JSON.parse(readFileSync(join(SKILL, '..', '..', '.claude-plugin', 'plugin.json'), 'utf8')).version !== '0.1.1';
// 役 → [書く型に入れる下書きの型, 書く型から外す今の型]（組み立てた後の今の型は CLI が書く）
const DRAFT_WRITES = {
  extractor: [['InventoryDraft'], ['Inventory']],
  'model-author': [['MappingDraft'], ['MappingFile']],
  'partition-author': [['PartitionsDraft'], ['PartitionsFile']],
  'plan-author': [['PlanDraft', 'MutationsDraft'], ['PlanFile', 'MutationsFile']],
  'extraction-reviewer': [['ReviewItem'], []],
  'fidelity-reviewer': [['ReviewItem'], []],
  'assurance-reviewer': [['ReviewItem'], []],
  'composition-reviewer': [['ReviewItem'], []],
};

test('SP-264-090 型の抜粋: U6 の後、作成役と確認役の書く型（ROLE_ENTRY_TYPES の writes）は下書きの型で、組み立てた後の今の型を書く型に持たない', { skip: !U6_READY && 'artifact-formats.md に下書きの型を書く U6 の前' }, () => {
  for (const [role, [drafts, assembled]] of Object.entries(DRAFT_WRITES)) {
    const { writes } = entryTypesOf(role);
    for (const n of drafts) assert.ok(writes.includes(n), `${role} の書く型に ${n} が無い: ${writes.join()}`);
    for (const n of assembled) assert.ok(!writes.includes(n), `${role} の書く型に組み立てた後の ${n} が残る: ${writes.join()}`);
    const defs = excerptDefs(read(`${TYPES_DIR}/${role}.md`));
    for (const n of drafts) assert.ok(defs.has(n), `${role} の抜粋に下書きの型 ${n} の定義が無い`);
  }
  // 原因の分類役は、問いを返した作成役の outputs として、CLI が組み立てた後の今の型を読む（下書きは読まない）
  const { reads } = entryTypesOf('cause-analyst');
  for (const n of ['Inventory', 'PartitionsFile', 'PlanFile', 'MutationsFile']) assert.ok(reads.includes(n), `cause-analyst の読む型に ${n}`);
});

test('SP-FORMALMETHOD-013 型の抜粋: 抜粋の型の定義は artifact-formats.md の同じ行の写しで、役の指示が挙げる型を含む', () => {
  const source = read('references/artifact-formats.md');
  const want = U6_READY ? {
    // U6 の後: 作成役は下書きの型を書く（SP-264-090）。読む型は CLI が組み立てた後の今の型
    extractor: ['InventoryDraft', 'Question', 'Worklog', 'RefHash'],
    'model-author': ['ModelFile', 'Clause', 'StateMachine', 'MappingDraft', 'Worklog'],
    'partition-author': ['PartitionsDraft', 'ModelFile', 'Worklog'],
    'plan-author': ['PlanDraft', 'MutationsDraft', 'ModelFile', 'PartitionsFile', 'Worklog'],
    'extraction-reviewer': ['ReviewItem', 'Inventory', 'Worklog'],
    'fidelity-reviewer': ['ReviewItem', 'ModelFile', 'Clause', 'MappingFile', 'Judgment', 'Worklog', 'Inventory'],
    'assurance-reviewer': ['ReviewItem', 'Inventory', 'Worklog'],
    'composition-reviewer': ['ReviewItem', 'PartitionsFile', 'ModelFile', 'Worklog'],
    'cause-analyst': ['ModelFile', 'Cause', 'Subject', 'Question', 'Worklog', 'Inventory', 'PartitionsFile', 'PlanFile', 'MutationsFile'],
  } : {
    extractor: ['Inventory', 'Question', 'Worklog', 'RefHash'],
    'model-author': ['ModelFile', 'Clause', 'StateMachine', 'MappingFile', 'Worklog'],
    'partition-author': ['PartitionsFile', 'ModelFile', 'Worklog'],
    'plan-author': ['PlanFile', 'MutationsFile', 'ModelFile', 'Worklog'],
    'extraction-reviewer': ['Inventory', 'Worklog'],
    // views/<unit_id>.json は資料の形から型に辿れないので、中身の inventory の性質と要素の型（Inventory）を入口に明示する
    'fidelity-reviewer': ['ModelFile', 'Clause', 'MappingFile', 'Judgment', 'Worklog', 'Inventory'],
    'assurance-reviewer': ['Inventory', 'Worklog'],
    'composition-reviewer': ['PartitionsFile', 'ModelFile', 'Worklog'],
    // 主題が問いなら、問いを返した作成役の outputs（inventory・分割・計画・変異）を読む
    'cause-analyst': ['ModelFile', 'Cause', 'Subject', 'Question', 'Worklog', 'Inventory', 'PartitionsFile', 'PlanFile', 'MutationsFile'],
  };
  for (const [role, names] of Object.entries(want)) {
    const text = read(`${TYPES_DIR}/${role}.md`);
    for (const n of names) assert.match(text, new RegExp(`^\\s*${n}\\s*= `, 'm'), `${role} の抜粋に ${n} が無い`);
    // 型の定義の行（"X = " で始まる行）は、正本の行と同じ（抜粋は加工しない）
    for (const line of text.split('\n').filter((l) => /^[A-Z][A-Za-z]*\s*= /.test(l))) assert.ok(source.includes(line), `${role}: 正本に無い行 ${line}`);
    // 抜粋の中のリンクは、置き場から解ける相対パスか、この抜粋の中の見出しか、由来の注記の URL（install 先に無い文書は URL で指す）
    for (const m of text.matchAll(/\]\(([^)#]+)(#[^)]*)?\)/g)) {
      if (/^https:\/\//.test(m[1])) continue;
      assert.ok(existsSync(join(SKILL, TYPES_DIR, m[1])), `${role}: 解けないリンク ${m[1]}`);
    }
  }
});

// 抜粋の中の型の定義（```text の塊の行頭の「<名前> =」）の名前と、定義の行の並び
function excerptDefs(text) {
  const lines = text.split('\n');
  const defs = new Map();
  let inText = false;
  let cur = null;
  for (const line of lines) {
    if (line.startsWith('```')) { inText = !inText && line === '```text'; cur = null; continue; }
    if (!inText) continue;
    const m = /^([A-Za-z][A-Za-z0-9_]*)\s*=/.exec(line);
    if (m) { cur = m[1]; defs.set(cur, []); }
    if (cur) defs.get(cur).push(line);
  }
  return defs;
}
const sourceTypes = () => excerptDefs(read('references/artifact-formats.md'));
// 抜粋の中の型の定義が参照する型（正本に定義のある名前）のうち、抜粋に定義が無いもの
export function undefinedRefs(text, isType) {
  const defs = excerptDefs(text);
  const out = [];
  for (const [name, lines] of defs) for (const r of refsOf(lines, isType, name)) if (!defs.has(r)) out.push(`${name} → ${r}`);
  return out;
}

test('SP-FORMALMETHOD-013 型の抜粋: 抜粋の型の定義が参照する型は、全て同じ抜粋の中で定義されている（入口の型から正本を推移的に辿る）', () => {
  const all = sourceTypes();
  for (const role of Object.keys(ROLES)) {
    const text = read(`${TYPES_DIR}/${role}.md`);
    assert.deepEqual(undefinedRefs(text, (n) => all.has(n)), [], `${role} の抜粋に定義の無い型`);
    const defs = excerptDefs(text);
    const { writes, reads } = entryTypesOf(role);
    for (const n of [...writes, ...reads]) assert.ok(defs.has(n), `${role} の抜粋に入口の型 ${n} が無い`);
    // 定義は正本の定義の行の写し（途中で切らない）
    for (const [n, lines] of defs) assert.deepEqual(lines, all.get(n), `${role}: ${n} の定義が正本と違う`);
  }
});

test('SP-FORMALMETHOD-013 型の抜粋: 役が使わない型を入れない（作成役は Counterexample・Cause を持たず、問いの Question と主題の Subject だけを持つ）', () => {
  for (const role of AUTHOR_ROLES) {
    const defs = excerptDefs(read(`${TYPES_DIR}/${role}.md`));
    for (const n of ['Counterexample', 'Cause', 'Result', 'Confirmation']) assert.ok(!defs.has(n), `${role} の抜粋に ${n}`);
    assert.ok(defs.has('Question') && defs.has('Subject'), role);
  }
});

test('SP-FORMALMETHOD-013 型の抜粋: 役の指示が名前で挙げる型は、その役の抜粋で定義され、指示が指す抜粋の見出しは抜粋にある', () => {
  const all = sourceTypes();
  const anchor = (h) => h.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
  for (const role of Object.keys(ROLES)) {
    const ins = read(`agents/${role}.md`);
    const text = read(`${TYPES_DIR}/${role}.md`);
    const defs = excerptDefs(text);
    for (const m of ins.matchAll(/`([A-Z][A-Za-z0-9]*)(?:\.[a-z_]+)*`/g)) if (all.has(m[1])) assert.ok(defs.has(m[1]), `agents/${role}.md の ${m[1]} が抜粋に無い`);
    const heads = new Set(text.split('\n').filter((l) => l.startsWith('## ')).map((l) => anchor(l.slice(3))));
    for (const m of ins.matchAll(new RegExp(`\\.\\./references/types/${role}\\.md#([^)]+)\\)`, 'g'))) assert.ok(heads.has(decodeURIComponent(m[1])), `agents/${role}.md の #${m[1]} が抜粋に無い`);
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

test('SP-FORMALMETHOD-014 役ごとの義務: 文書の一般規約は task の instructions の 4 つ目で読ませ、義務に規約の中身を写さず、指紋を手で求めさせない（CLI が claim の document_rules と submit の照合で持つ）', () => {
  // 規約の太字の規則の文（中身）を、義務・役の指示・Workflow の prompt に写さない（写すと規約の正本が 2 つになる）
  const rules = [...read('references/document-rules.md').matchAll(/\*\*(.+?)\*\*/g)].map((m) => m[1].replace(/。$/, ''));
  assert.ok(rules.length >= 5);
  // 規則の文の 8 文字の窓（言い換えた要約も、規則の句をそのまま含めば見つかる）
  const fragments = [...new Set(rules.flatMap((r) => Array.from({ length: Math.max(0, r.length - 7) }, (_, i) => r.slice(i, i + 8))))];
  const texts = { ...Object.fromEntries(Object.values(OBLIGATION_FILES).map((p) => [p, read(p)])), 'references/agent-obligations.md': read('references/agent-obligations.md'),
    ...Object.fromEntries(Object.keys(ROLES).map((r) => [`agents/${r}.md`, read(`agents/${r}.md`)])), workflow: readFileSync(join(SKILL, '..', '..', 'workflows', 'formal-method-agents.js'), 'utf8') };
  for (const [path, text] of Object.entries(texts)) for (const f of fragments) assert.ok(!text.includes(f), `${path} が規約の中身「${f}」を写す`);
  for (const path of Object.values(OBLIGATION_FILES)) {
    const text = read(path);
    assert.ok(text.includes('`instructions` の 4 つのファイル'), `${path} が instructions の 4 つ目（規約）を読ませない`);
    assert.ok(!text.includes('写しを読む必要はない') && !text.includes('写しは読まない'), `${path} が規約を読ませない`);
    assert.ok(!text.includes('createHash'), `${path} が指紋の command を持つ`);
    assert.ok(text.includes('document_rules'), `${path} が claim の document_rules を挙げない`);
  }
  assert.ok(!read('agents/extractor.md').includes('createHash'), 'extractor.md が quote_hash の command を持つ');
});
