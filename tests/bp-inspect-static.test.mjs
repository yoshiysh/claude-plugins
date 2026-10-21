import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { candidateVerifier, inspectArgs, runInspect, setupInspect, viewpointOf } from './helpers/bp-harness.mjs';
import { INPUT_KEYS, OPS } from '../plugins/skill-creator/skills/skill-creator-best-practices/scripts/bp/constants.mjs';
import { PATHS } from '../plugins/skill-creator/skills/skill-creator-best-practices/scripts/bp/applicability.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'plugins', 'skill-creator', 'skills', 'skill-creator-best-practices', 'scripts', 'bp_inspect.js');
const SOURCE = readFileSync(SCRIPT, 'utf8');
const INSPECTION = readFileSync(path.join(ROOT, 'docs', 'specifications', 'bp-inspection.md'), 'utf8');
const RUN = readFileSync(path.join(ROOT, 'docs', 'specifications', 'bp-run.md'), 'utf8');
const acorn = createRequire(path.join(ROOT, 'plugins', 'workflow', 'skills', 'dynamic-workflow-runner', 'scripts', 'runtime', 'package.json'))('acorn');
const PREFIX = 'async function __s() {\n';
const AST = acorn.parse(`${PREFIX}${SOURCE.replace(/^export const meta =/, 'const meta =')}\n}`, { ecmaVersion: 'latest' });
const BODY = AST.body[0].body.body;
const OFFSET = PREFIX.length - 'export '.length;
const BOTH = '［review］［audit］';

function walk(node, visit, parents = []) {
  if (!node || typeof node.type !== 'string') return;
  visit(node, parents);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach((v) => walk(v, visit, [...parents, node]));
    else if (value && typeof value.type === 'string') walk(value, visit, [...parents, node]);
  }
}

function enclosing(parents) {
  return parents.filter((p) => p.type === 'FunctionDeclaration').map((p) => p.id.name).at(-1) ?? '(top)';
}

function fnSource(name) {
  const d = BODY.find((s) => s.type === 'FunctionDeclaration' && s.id.name === name);
  assert.ok(d, name);
  return SOURCE.slice(d.start - OFFSET, d.end - OFFSET);
}

function literal(name) {
  const d = BODY.filter((s) => s.type === 'VariableDeclaration').flatMap((s) => s.declarations).find((x) => x.id.name === name);
  return Function(`"use strict"; return (${SOURCE.slice(d.init.start - OFFSET, d.init.end - OFFSET)});`)();
}

function tableAfter(text, marker) {
  const lines = text.slice(text.indexOf(marker)).split('\n');
  const first = lines.findIndex((l) => l.startsWith('|'));
  const rows = [];
  for (const line of lines.slice(first + 2)) {
    if (!line.startsWith('|')) break;
    rows.push(line.replace(/^\||\|$/g, '').split('|').map((c) => c.trim()));
  }
  return rows;
}

async function promptsOf(t, fn, scenario = {}) {
  const s = await setupInspect(t);
  if (!s) return null;
  const { result, calls } = await runInspect(t, { env: s.env, args: inspectArgs(fn, s.target), scenario });
  assert.equal(result.stopKind, 'complete', result.reason);
  return { s, calls };
}

test(`SP-BPINSPECTION-001・SP-BPRUN-038・SP-BPFINDINGS-018: meta.phases が SP-BPINSPECTION-001 の表の段の列の順に並び、各段の名前が SP-BPRUN-038 の slug の表にあり、見直しと合否の操作を要求に入れない${BOTH}`, () => {
  const phases = literal('meta').phases.map((p) => p.title);
  assert.deepEqual(phases, tableAfter(INSPECTION, '| 順 | 段 | 部品 | 起動する役 | 機能 | 項目 | 定める項目 |').map((r) => r[1]));
  const slugs = new Map(tableAfter(RUN, '段の slug は次の表とする。').map(([name, slug]) => [slug.replace(/`/g, ''), name.split('・')]));
  for (const [slug, title] of Object.entries(literal('STAGE_TITLES'))) assert.ok(slugs.get(slug)?.includes(title), `${slug}: ${title}`);
  const used = [];
  walk(AST, (n) => { if (n.type === 'MemberExpression' && n.object.name === 'OPS') used.push(n.property.name); });
  for (const op of ['reviewJudge', 'gate', 'goalCheck', 'files', 'filesScan', 'snapshot', 'paths', 'pathsRetake', 'discard']) assert.ok(!used.includes(op), op);
});

test(`SP-BPRUN-023・SP-BPINSPECTION-020・SP-BPRUN-025: agent() を呼ぶのは launch の 1 箇所だけで、起動する役は運搬役・抽出役・検証役・反証役だけ（書き手を起動しない）${BOTH}`, () => {
  const calls = [];
  walk(AST, (n, parents) => { if (n.type === 'CallExpression' && n.callee.type === 'Identifier' && n.callee.name === 'agent') calls.push(enclosing(parents)); });
  assert.deepEqual(calls, ['launch']);
  assert.match(fnSource('launch'), /agent\(prompt, \{ \.\.\.ROLE_MODELS\[role\], label, schema \}\)/);
  const roles = new Set();
  walk(AST, (n) => { if (n.type === 'CallExpression' && n.callee.name === 'launch') roles.add(n.arguments[0].value); });
  assert.deepEqual([...roles].sort(), ['carrier', 'extractor', 'refuter', 'verifier']);
  assert.ok(!SOURCE.includes("launch('writer'"));
});

test(`SP-BPRUN-002・SP-BPRUN-010・SP-BPRUN-011: 入力を待つ手順が無く、needs_input で止まる箇所が無い（review・audit は needs_input を使わず、入力の不足も BLOCKED で返す）${BOTH}`, () => {
  const places = [];
  walk(AST, (n, parents) => {
    if (n.type === 'MemberExpression' && n.object.name === 'STOP_KINDS' && n.property.name === 'needsInput') places.push(enclosing(parents));
    if (n.type === 'Identifier' && n.name === 'checkpoint') places.push(`checkpoint in ${enclosing(parents)}`);
  });
  assert.deepEqual(places, []);
});

test(`SP-BPRUN-019: Workflow が起動数の上限を省略できる入力 maxLaunches として受け取る${BOTH}`, () => {
  assert.match(fnSource('validateArgs'), /if \(a\[INPUT_KEYS\.maxLaunches\] !== undefined\)/);
  assert.match(fnSource('makeBudget'), /if \(limit === undefined\) return true/);
});

test(`script の制約: 本体が meta を読まず、Date.now・Math.random・引数の無い new Date・import() を使わない${BOTH}`, () => {
  const body = SOURCE.slice(SOURCE.indexOf('\n}\n') + 3);
  assert.doesNotMatch(body, /\bmeta\b/);
  for (const bad of [/\bDate\.now\s*\(/, /\bMath\.random\s*\(/, /\bnew\s+Date\s*\(\s*\)/, /\bimport\s*\(/]) assert.doesNotMatch(SOURCE, bad);
});

test('SP-BPINSPECTION-006: CLI が受理する答えの並びと到達した形が、SP-BPINSPECTION-006 に書き戻した表と一致する', () => {
  const rows = tableAfter(INSPECTION, '| A | Q1 | Q2 | Q3 | 到達した形 |');
  assert.deepEqual(rows.map((r) => [r.slice(0, 4).join(','), r[4]]).sort(), PATHS.map((p) => [p.answers.join(','), p.shape]).sort());
});

test('SP-BPINSPECTION-023: bp-inspection.md に review・audit の入力の表が無い（入力の表は SP-BPENTRY-013 だけにある）', () => {
  for (const line of INSPECTION.split('\n').filter((l) => l.startsWith('|'))) {
    assert.doesNotMatch(line, /条件: (起動|項目)/, line);
    for (const key of Object.values(INPUT_KEYS)) assert.ok(!line.includes(`\`${key}\``) || key === 'target', `${key}: ${line}`);
  }
  assert.match(INSPECTION, /`docs\/specifications\/bp-entry\.md` の SP-BPENTRY-013 の表を正とし、本文書に表を置かない/);
});

test(`SP-BPINSPECTION-008・SP-BPINSPECTION-017・SP-BPRUN-036: review の検証役の prompt が資産の束と照らす先（判定基準の写し）のパスを持ち、共通の部分が先頭にあり、仕様の観点の prompt に「性能・容量」の章の値が無く、docs/ のパスを渡さない［review］`, async (t) => {
  const got = await promptsOf(t, 'review');
  if (!got) return;
  const { s, calls } = got;
  const flow = calls.find((c) => viewpointOf(c.prompt) === 'flow').prompt;
  const spec = calls.find((c) => viewpointOf(c.prompt) === 'spec').prompt;
  const conformance = path.join(s.criteriaDir, 'specifications', 'bp-conformance.md');
  const design = path.join(s.criteriaDir, 'design', 'skill-design-patterns.md');
  for (const p of [flow, spec]) {
    assert.ok(p.includes(conformance) && p.includes(design));
    assert.match(p, /資産の束（[^）]*）: \S+bundle\.0\.md/);
    assert.doesNotMatch(p, /(^|[\s/])docs\//);
  }
  let i = 0;
  while (flow[i] === spec[i]) i += 1;
  const common = flow.slice(0, i);
  assert.ok(common.includes('資産の束') && common.includes('照らす先') && common.includes('書いてよいのは作業ファイル') && common.includes('対象スキル:'));
  assert.ok(!common.includes('フローの観点') && !common.includes('仕様の観点') && !common.includes('担当 ID'));
  const capacity = readFileSync(conformance, 'utf8').split(/^## /m).find((c) => c.startsWith('性能・容量'));
  const values = [...capacity.matchAll(/(\d[\d,]*) ?(体|回|周|字)以下/g)].map((m) => m[0]);
  assert.ok(values.length >= 3, values.join(' '));
  for (const v of values) assert.ok(!spec.includes(v), v);
  const extractor = calls.find((c) => c.role === 'extract').prompt;
  assert.ok(extractor.includes('bundle.0.md') && extractor.includes(conformance));
});

test('SP-BPINSPECTION-011・SP-BPINSPECTION-012・SP-BPINSPECTION-013: 監査の観点の prompt が prompt-audit のパスと 4 つの当て方を持ち、担当の資産を絞る指示が無く、優先と鮮度を未検査の観点の候補として返させる', async (t) => {
  const got = await promptsOf(t, 'audit');
  if (!got) return;
  const { s, calls } = got;
  const audit = calls.find((c) => viewpointOf(c.prompt) === 'audit').prompt;
  assert.ok(audit.includes(s.env.promptAudit));
  for (const part of ['「Scope」の節', '導入文と末尾の style preference の段落', '「Confidence and action」の節の Low の行', '「Confidence and action」の節の最後の 2 段落']) assert.ok(audit.includes(part), part);
  assert.match(audit, /担当の資産を減らさない/);
  assert.match(audit, /全ての監査の観点を担当の全ての資産に当てる/);
  assert.match(audit, /bp-designed-skill\.md の要求と食い違うときは、その要求を優先して候補を返さず/);
  assert.match(audit, /PA-4 の未検査の観点の候補/);
  assert.match(audit, /PA-3 を当てない/);
});

test(`SP-BPINSPECTION-020・SP-BPRUN-025: 各役の prompt の書いてよい先が作業ファイルか CLI を通した状態だけで、対象スキルを書き換える指示が無い${BOTH}`, async (t) => {
  for (const fn of ['review', 'audit']) {
    const got = await promptsOf(t, fn, { verify: candidateVerifier({ viewpoint: fn === 'review' ? 'flow' : 'audit' }) });
    if (!got) return;
    const roles = new Set(got.calls.map((c) => c.role));
    assert.ok(roles.has('refute') && roles.has('extract'));
    for (const c of got.calls) {
      if (c.role === 'carrier') assert.match(c.prompt, /ファイルに書いてよいのは CLI を通した状態だけ/, c.label);
      else {
        assert.match(c.prompt, /書いてよいのは作業ファイル（[^）]+）だけ。対象スキルにも状態にも書かない/, c.label);
        assert.doesNotMatch(c.prompt, /書いてよい先: 対象スキル/, c.label);
      }
    }
  }
});

test('SP-BPINSPECTION-016: 検証の段の項目の鍵を観点の順・担当の順で並べる（列挙の順が未着手の順位になる）', () => {
  assert.match(fnSource('verifyKeys'), /run\.viewpoints\.flatMap\(\(viewpoint\) => run\.groups\.map\(\(g, i\) => \(\{ viewpoint, group: i \+ 1 \}\)\)\)/);
  assert.ok(OPS.stageStart);
});

// ---- prompt と CLI に置いた写しを、写し元の仕様の記述に照らす（照らさない写しは仕様だけが変わったときに古いまま残る）

import { APPLICABILITY_ANSWERS, FIXED_AUDIT_UNCHECKED, PRESENCE } from '../plugins/skill-creator/skills/skill-creator-best-practices/scripts/bp/constants.mjs';
import { auditUnits } from '../plugins/skill-creator/skills/skill-creator-best-practices/scripts/bp/kinds.mjs';
import { forcedSources } from '../plugins/skill-creator/skills/skill-creator-best-practices/scripts/bp/units.mjs';

const DOCS = path.join(ROOT, 'docs');
const section = (id) => INSPECTION.slice(INSPECTION.indexOf(`#### ${id}`), INSPECTION.indexOf('\n#### ', INSPECTION.indexOf(`#### ${id}`) + 1));
const spList = (text) => [...text.matchAll(/SP-BPCONFORMANCE-(\d{3})((?:・\d{3})*)/g)].flatMap((m) => [m[1], ...m[2].split('・').filter(Boolean)]).map((n) => `SP-BPCONFORMANCE-${n}`);

test('SP-BPINSPECTION-006: 適用の判定の検証役の schema の答えの enum が、CLI の閉集合（SP-BPINSPECTION-006 の表の選択肢）と一致する', () => {
  const schema = Function('APPLICABILITY_QUESTIONS', 'APPLICABILITY_ANSWERS', 'PRESENCE', `${fnSource('answerSchema')}\n${fnSource('applicabilitySchema')}\nreturn applicabilitySchema();`)(literal('APPLICABILITY_QUESTIONS'), literal('APPLICABILITY_ANSWERS'), literal('PRESENCE'));
  for (const q of literal('APPLICABILITY_QUESTIONS')) assert.deepEqual(schema.properties.answers.properties[q].properties.answer.enum, Object.values(APPLICABILITY_ANSWERS));
  for (const f of ['ledger', 'fanout']) assert.deepEqual(schema.properties[f].properties.answer.enum, Object.values(PRESENCE));
  assert.deepEqual(schema.properties.answers.required, literal('APPLICABILITY_QUESTIONS'));
});

test('SP-BPINSPECTION-012・SP-BPINSPECTION-013・SP-BPINSPECTION-009: script と CLI に書いた監査の観点の識別子が、SP-BPINSPECTION-012・013 が名指す識別子で、SP-BPINSPECTION-009 の表にあり、PA-3 の固定の 1 件が SP-BPINSPECTION-012 の固定の記述と一致する', () => {
  const named = new Set([...`${section('SP-BPINSPECTION-012')}${section('SP-BPINSPECTION-013')}`.matchAll(/PA-\d/g)].map((m) => m[0]));
  const table = new Set(auditUnits(DOCS).map((u) => u.value));
  const used = [...new Set([...SOURCE.matchAll(/PA-\d/g)].map((m) => m[0]))];
  assert.ok(used.length > 0);
  for (const id of [...used, FIXED_AUDIT_UNCHECKED.value]) {
    assert.ok(named.has(id), id);
    assert.ok(table.has(id), id);
  }
  const fixed = /次の 1 件は[\s\S]*?- ([^\n]+)/.exec(section('SP-BPINSPECTION-012'))[1];
  assert.ok(fixed.includes(`${FIXED_AUDIT_UNCHECKED.value} を当ててはならない`));
  for (const ref of ['PR-BPDESIGNEDSKILL-021', 'SP-BPCONFORMANCE-025']) {
    assert.ok(fixed.includes(ref) && FIXED_AUDIT_UNCHECKED.reason.includes(ref), ref);
  }
});

test('SP-BPINSPECTION-025: 強いられた未検査の単位に付ける理由の仕様項目 ID の集合が、SP-BPINSPECTION-025 の表の検証役の未検査の行が名指す ID と一致する', () => {
  const row = tableAfter(INSPECTION, '| 場合 | 観点 | 範囲 | 理由 |').find((r) => r[0].includes('検証役が判定の単位を未検査とした'));
  const { always, turnForm } = forcedSources(DOCS);
  assert.deepEqual([...new Set([...always.values(), ...turnForm.values()])].sort(), spList(row[3]).sort());
});

test('SP-BPINSPECTION-006・SP-BPINSPECTION-007・SP-BPINSPECTION-011: prompt に書いた仕様項目 ID と prompt-audit の節の名前が、写し元の SP-BPINSPECTION-006・007・011 の記述と一致する', () => {
  const lines = fnSource('viewpointLines');
  const flow = /観点: フローの観点。[^`]*?(SP-BPCONFORMANCE-[\d・]+) のとおり/.exec(lines)[1];
  assert.deepEqual(spList(flow), spList(section('SP-BPINSPECTION-007').split('\n').find((l) => l.startsWith('フローの観点の検証役は'))));
  const applicability = fnSource('applicabilityPrompt');
  const criteria = tableAfter(INSPECTION, '| 問い | 選択肢 | 判定基準 |').flatMap((r) => spList(r[2]));
  assert.deepEqual([...new Set(spList(applicability))].sort(), [...new Set(criteria)].sort());
  const sections = [...new Set([...lines.matchAll(/「([A-Za-z ]+)」の節/g)].map((m) => m[1]))].sort();
  const spec = [...new Set(tableAfter(INSPECTION, '| 現行の prompt-audit の記述 | 当て方 |').flatMap((r) => [...r[0].matchAll(/「([A-Za-z ]+)」の節/g)].map((m) => m[1])))].sort();
  assert.deepEqual(sections, spec);
});
