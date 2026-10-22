import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { candidateVerifier, inspectArgs, runInspect, setupInspect, viewpointOf } from './helpers/bp-harness.mjs';
import { INPUT_KEYS } from '../plugins/skill-creator/skills/skill-creator-best-practices/scripts/bp/constants.mjs';
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

test('SP-BPINSPECTION-011・SP-BPINSPECTION-012・SP-BPINSPECTION-013・SP-BPINSPECTION-017: 監査の観点の prompt が prompt-audit と bp-inspection と bp-designed-skill の写しのパスを渡して当て方を SP-BPINSPECTION-011〜013 に照らさせ、当て方の文を書き写さず、担当の資産を絞る指示が無い', async (t) => {
  const got = await promptsOf(t, 'audit');
  if (!got) return;
  const { s, calls } = got;
  const audit = calls.find((c) => viewpointOf(c.prompt) === 'audit').prompt;
  assert.ok(audit.includes(s.env.promptAudit));
  assert.ok(audit.includes(path.join(s.criteriaDir, 'specifications', 'bp-inspection.md')));
  assert.ok(audit.includes(path.join(s.criteriaDir, 'requirements', 'bp-designed-skill.md')));
  assert.match(audit, /SP-BPINSPECTION-011〜SP-BPINSPECTION-013 に従う/);
  assert.match(audit, /担当の資産を減らさない/);
  for (const copied of ['style preference', 'Low に当たる懸念', '「Scope」', '「Confidence and action」']) assert.ok(!audit.includes(copied), copied);
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
  assert.match(fnSource('verifyKeys'), /run\.viewpoints\.flatMap\(\(viewpoint\) => run\.groups\.map\(\(g\) => \(\{ viewpoint, assignment: g\.id \}\)\)\)/);
});

// ---- prompt と CLI に置いた写しを、写し元の仕様の記述に照らす（照らさない写しは仕様だけが変わったときに古いまま残る）

import { APPLICABILITY_ANSWERS, FIXED_AUDIT_UNCHECKED, PRESENCE } from '../plugins/skill-creator/skills/skill-creator-best-practices/scripts/bp/constants.mjs';
import { auditUnits } from '../plugins/skill-creator/skills/skill-creator-best-practices/scripts/bp/kinds.mjs';
import { forcedSources } from '../plugins/skill-creator/skills/skill-creator-best-practices/scripts/bp/units.mjs';

const DOCS = path.join(ROOT, 'docs');
const section = (id) => INSPECTION.slice(INSPECTION.indexOf(`#### ${id}`), INSPECTION.indexOf('\n#### ', INSPECTION.indexOf(`#### ${id}`) + 1));
const spList = (text) => [...text.matchAll(/SP-BPCONFORMANCE-(\d{3})((?:・\d{3})*)/g)].flatMap((m) => [m[1], ...m[2].split('・').filter(Boolean)]).map((n) => `SP-BPCONFORMANCE-${n}`);

test('SP-BPINSPECTION-006: 適用の判定の検証役の schema の答えの enum が、CLI の閉集合（SP-BPINSPECTION-006 の表の選択肢）と一致する', () => {
  const schema = Function('APPLICABILITY_QUESTIONS', 'APPLICABILITY_ANSWERS', 'PRESENCE', 'PRESENCE_QUESTIONS', `${fnSource('answerSchema')}\n${fnSource('applicabilitySchema')}\nreturn applicabilitySchema();`)(literal('APPLICABILITY_QUESTIONS'), literal('APPLICABILITY_ANSWERS'), literal('PRESENCE'), literal('PRESENCE_QUESTIONS'));
  for (const q of literal('APPLICABILITY_QUESTIONS')) assert.deepEqual(schema.properties.answers.properties[q].properties.answer.enum, Object.values(APPLICABILITY_ANSWERS));
  for (const f of literal('PRESENCE_QUESTIONS')) assert.deepEqual(schema.properties[f].properties.answer.enum, Object.values(PRESENCE));
  assert.deepEqual(schema.properties.answers.required, literal('APPLICABILITY_QUESTIONS'));
});

test('SP-BPINSPECTION-012・SP-BPINSPECTION-009: script は監査の観点の識別子を書き写さず、CLI の PA-3 の固定の 1 件が SP-BPINSPECTION-012 の固定の記述と SP-BPINSPECTION-009 の表に一致する', () => {
  assert.deepEqual([...SOURCE.matchAll(/PA-\d/g)].map((m) => m[0]), []);
  assert.ok(auditUnits(DOCS).some((u) => u.value === FIXED_AUDIT_UNCHECKED.value));
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

test('SP-BPINSPECTION-006・SP-BPINSPECTION-007・SP-BPINSPECTION-008: script は照らす先の章・節の名前を書き写さず照らす先の決定の出力から得て、適用の判定の prompt の仕様項目 ID が SP-BPINSPECTION-006 の表の判定基準と一致する', async (t) => {
  const { CRITERIA_CHAPTERS, PROMPT_AUDIT_SECTION } = await import('../plugins/skill-creator/skills/skill-creator-best-practices/scripts/bp/constants.mjs');
  for (const name of [CRITERIA_CHAPTERS.functional, CRITERIA_CHAPTERS.capacityPrefix, PROMPT_AUDIT_SECTION]) assert.ok(!SOURCE.includes(name), name);
  const applicability = fnSource('applicabilityPrompt');
  const criteria = tableAfter(INSPECTION, '| 問い | 選択肢 | 判定基準 |').flatMap((r) => spList(r[2]));
  assert.deepEqual([...new Set(spList(applicability))].sort(), [...new Set(criteria)].sort());
  const got = await promptsOf(t, 'review');
  if (!got) return;
  const flow = got.calls.find((c) => viewpointOf(c.prompt) === 'flow').prompt;
  const spec = got.calls.find((c) => viewpointOf(c.prompt) === 'spec').prompt;
  const inspection = path.join(got.s.criteriaDir, 'specifications', 'bp-inspection.md');
  assert.ok(flow.includes(`「${CRITERIA_CHAPTERS.functional}」の章`));
  assert.ok(flow.includes(`${inspection} の SP-BPINSPECTION-007 のとおり`));
  assert.ok(spec.includes(`「${CRITERIA_CHAPTERS.capacityPrefix}」で始まる章`));
  assert.ok(spec.includes(`${inspection} の SP-BPINSPECTION-008`));
});

test(`SP-BPRUN-027・SP-BPRUN-028: host の agent() が投げた失敗の内容を、その呼び出しの理由に載せ、同じラベルで並行した起動の失敗と混ざらず、全ての起動が受け取った失敗を理由に載せる${BOTH}`, async () => {
  const make = Function('agent', 'ROLE_MODELS', `const budget = { charge() {} }; const run = { launched: 0 };\n${fnSource('launch')}\nreturn launch;`);
  const launch = make(async (p) => {
    await null;
    if (p === 'ok') return { fine: true };
    throw new Error(`${p} の失敗`);
  }, { carrier: { model: 'sonnet', effort: 'low' } });
  const label = 'carrier:verify';
  const together = await Promise.all(['A', 'ok', 'B'].map((p) => launch('carrier', p, { label })));
  assert.deepEqual(together, [{ out: null, failure: '（host の失敗: A の失敗）' }, { out: { fine: true }, failure: '' }, { out: null, failure: '（host の失敗: B の失敗）' }]);
  // 失敗を受け取った起動は、次の関数の宣言までに理由へ載せる（受け取って捨てると理由に失敗の内容が無い）。2 本の script の全ての起動を照らす。
  for (const file of ['bp_inspect.js', 'bp_author.js']) {
    const text = readFileSync(path.join(path.dirname(SCRIPT), file), 'utf8');
    const sites = text.split('const { out: res, failure } = await launch(').slice(1);
    assert.ok(sites.length >= 5, file);
    for (const site of sites) assert.match(site.split(/\nasync function |\nfunction /)[0], /結果を返さなかった\$\{failure\}/, `${file}: ${site.slice(0, 60)}`);
  }
});

test('SP-BPINSPECTION-017・SP-BPINSPECTION-018・SP-BPRUN-036: audit の検証役の prompt が資産の束と照らす先のパスを共通の部分として先頭に持ち、反証役の prompt が資産の束と候補の観点の照らす先のパスを持つ［review］［audit］', async (t) => {
  for (const fn of ['review', 'audit']) {
    const vp = fn === 'review' ? 'flow' : 'audit';
    const got = await promptsOf(t, fn, { verify: candidateVerifier({ viewpoint: vp }) });
    if (!got) return;
    const { s, calls } = got;
    const verifiers = calls.filter((c) => c.role === 'verify' && viewpointOf(c.prompt) === vp).map((c) => c.prompt);
    assert.equal(verifiers.length, 2);
    let i = 0;
    while (verifiers[0][i] === verifiers[1][i]) i += 1;
    const common = verifiers[0].slice(0, i);
    for (const part of ['資産の束', '照らす先（判定基準', '書いてよいのは作業ファイル', '対象スキル:', '観点:']) assert.ok(common.includes(part), `${fn}: ${part}`);
    const refuter = calls.find((c) => c.role === 'refute').prompt;
    assert.match(refuter, /資産の束（[^）]*）: \S+bundle\.0\.md/);
    const own = /候補の観点の照らす先: (.+)/.exec(refuter)[1].split(' ');
    if (fn === 'review') {
      assert.ok(own.includes(path.join(s.criteriaDir, 'design', 'skill-design-patterns.md')));
      const spec = calls.find((c) => viewpointOf(c.prompt) === 'spec').prompt;
      const specLine = spec.split('\n').find((l) => l.startsWith('観点: 仕様の観点'));
      assert.ok(!specLine.includes('skill-design-patterns.md'));
    } else {
      assert.ok(own.includes(s.env.promptAudit));
    }
  }
});
