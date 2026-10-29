import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODEL_DIR = path.join(ROOT, 'tests', 'formal', 'develop');
const REQ_DIR = path.join(ROOT, 'docs', 'requirements');
const DOCS = ['develop-plugin', 'develop-implement', 'develop-review', 'develop-address-review'];
const ANY = '*';
const NONE = 'none';
// 「記録する位置」の列の値を、模型が停止に記録する stage に写す。ANY はその停止が起きた段（模型では sk.stage か段ごとの値）。
const SKILLS = Object.freeze({
  'develop-implement': {
    set: 'IActs', goal: 'ImplGoal', prefix: 'Impl',
    stages: { なし: NONE, '開始時の check': 'baseline', '計画の run': 'plan', 'PR-DEVELOPIMPLEMENT-029 の判定': 'decide', '止まった段の、結果を記録していない項目': ANY },
  },
  'develop-review': {
    set: 'RActs', goal: 'ReviewGoal', prefix: 'Review',
    stages: { なし: NONE, '項目の起動の、未着手の項目': 'items', '止まった段の、結果を記録していない項目': ANY },
  },
  'develop-address-review': {
    set: 'AActs', goal: 'AddressGoal', prefix: 'Addr',
    stages: { なし: NONE, '止める所への振り分け': 'route', 'develop:implement の呼び出し': 'implement', '止まった段の、結果を記録していない項目': ANY },
  },
});
const ACTION = '模型の action';
const KIND = '模型の kind';
const PROPERTY = '模型の性質';
const POSITION = '記録する位置';

const read = (file) => readFileSync(file, 'utf8');
const ticks = (cell) => [...String(cell || '').matchAll(/`([^`]+)`/g)].map((m) => m[1]);
const cellsOf = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());

export function tablesOf(markdown) {
  const tables = [];
  const lines = markdown.split('\n');
  for (let i = 0; i + 1 < lines.length; i++) {
    if (!lines[i].trim().startsWith('|') || !/^\|[\s|:-]+\|$/.test(lines[i + 1].trim())) continue;
    const header = cellsOf(lines[i]);
    const rows = [];
    let k = i + 2;
    for (; k < lines.length && lines[k].trim().startsWith('|'); k++) rows.push(cellsOf(lines[k]));
    tables.push({ header, rows: rows.map((r) => Object.fromEntries(header.map((h, j) => [h, r[j] ?? '']))) });
    i = k;
  }
  return tables;
}

export function actionSetsOf(skillTla) {
  const sets = {};
  for (const { set } of Object.values(SKILLS)) {
    const m = new RegExp(`^${set} == \\{([^}]*)\\}`, 'm').exec(skillTla);
    if (!m) throw new Error(`${set} is not defined`);
    sets[set] = new Set([...m[1].matchAll(/"([A-Za-z_]+)"/g)].map((x) => x[1]));
  }
  return sets;
}

function partOf(skillTla, name, suffix) {
  const m = new RegExp(`^${name}${suffix}\\(e\\) ==([\\s\\S]*?)(?=^\\S|(?![\\s\\S]))`, 'm').exec(skillTla);
  if (!m) throw new Error(`${name}${suffix} is not defined`);
  return m[1];
}

// 模型の action を、停止に入るもの（次の状態が stopped で kind が文字列）・止まった状態で受ける入力（guard が停止を見る）・完了に分ける。
export function shapeOf(skillTla, names) {
  const enters = new Map();
  const inputs = new Map();
  const done = new Set();
  const kinds = new Set();
  for (const name of names) {
    const g = partOf(skillTla, name, '_g');
    const n = partOf(skillTla, name, '_n');
    const stop = /S[IRA]\("stopped",\s*("?[\w.]+"?),\s*"(\w+)"/.exec(n);
    if (stop) {
      enters.set(name, { stage: stop[1].startsWith('"') ? stop[1].slice(1, -1) : ANY, kind: stop[2] });
      kinds.add(stop[2]);
    }
    if (/"done"|"aborted"/.test(n)) done.add(name);
    if (/(?<!["\w])Stopped\b|\b[IA]Stop\(/.test(g)) inputs.set(name, g);
  }
  const pairs = new Map();
  for (const [name, g] of inputs) {
    const ks = new Set();
    for (const m of g.matchAll(/sk\.kind\s*=\s*"(\w+)"/g)) ks.add(m[1]);
    for (const m of g.matchAll(/sk\.kind\s*\\in\s*\{([^}]*)\}/g)) for (const [, k] of m[1].matchAll(/"(\w+)"/g)) ks.add(k);
    const neg = [...g.matchAll(/sk\.kind\s*#\s*"(\w+)"/g)].map((m) => m[1]);
    if (neg.length) for (const k of kinds) if (!neg.includes(k)) ks.add(k);
    pairs.set(name, ks.size ? ks : null);
  }
  return { enters, pairs, done, kinds };
}

export function definitionsOf(tla) {
  return new Set([...tla.matchAll(/^(?:LOCAL\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*(?:\([^)]*\))?\s*==/gm)].map((m) => m[1]));
}

export function goalConjunctsOf(propsTla, goal, prefix) {
  const m = new RegExp(`^${goal} ==([\\s\\S]*?)(?=^\\S|(?![\\s\\S]))`, 'm').exec(propsTla);
  if (!m) throw new Error(`${goal} is not defined`);
  const defined = definitionsOf(propsTla);
  return [...m[1].matchAll(new RegExp(`\\b(${prefix}[A-Z]\\w*)\\b`, 'g'))].map((x) => x[1]).filter((x) => defined.has(x));
}

export const citedConjuncts = (markdown) => [...markdown.matchAll(/（模型: `([A-Za-z]+)`/g)].map((m) => m[1]);

export function reqIdsOf(tla) {
  const ids = new Set();
  for (const line of tla.split('\n')) {
    const m = /^\\\* req:(.*)$/.exec(line.trim());
    if (m) for (const [id] of m[1].matchAll(/PR-[A-Z]+-\d{3}/g)) ids.add(id);
  }
  return ids;
}

export const requirementIdsOf = (markdown) => new Set([...markdown.matchAll(/^#### (PR-[A-Z]+-\d{3}) /gm)].map((m) => m[1]));

// 停止の表は「記録する位置」と「模型の kind」を持つ表、再開の表は条件の列と「模型の kind」を持つ表。
export function classify(tables) {
  const stop = tables.filter((t) => t.header.includes(POSITION) && t.header.includes(KIND));
  const resume = tables.filter((t) => !t.header.includes(POSITION) && t.header.includes(KIND) && t.header.some((h) => h.startsWith('条件:')));
  const other = tables.filter((t) => t.header.includes(ACTION) && !t.header.includes(KIND) && !t.header.includes(PROPERTY));
  const goal = tables.filter((t) => t.header.includes(PROPERTY));
  return { stop, resume, other, goal };
}

export function checkSkillDoc(markdown, skillTla, propsTla, spec) {
  const errors = [];
  const names = actionSetsOf(skillTla)[spec.set];
  const { enters, pairs, done } = shapeOf(skillTla, names);
  const { stop, resume, other, goal } = classify(tablesOf(markdown));
  if (stop.length !== 1 || resume.length !== 1) errors.push(`stop tables ${stop.length}, resume tables ${resume.length}`);
  const all = [...stop, ...resume, ...other, ...goal].flatMap((t) => t.rows.flatMap((r) => ticks(r[ACTION])));
  for (const a of all) if (!names.has(a)) errors.push(`not an action of ${spec.set}: ${a}`);

  const otherActs = new Set(other.flatMap((t) => t.rows.flatMap((r) => ticks(r[ACTION]))));
  const kindRow = new Map();
  for (const r of stop[0]?.rows || []) {
    const ks = ticks(r[KIND]);
    const pos = spec.stages[r[POSITION]];
    if (pos === undefined) errors.push(`unknown position: ${r[POSITION]}`);
    for (const k of ks) {
      if (kindRow.has(k)) errors.push(`kind ${k} has two stop names: ${kindRow.get(k)} / ${r['停止']}`);
      kindRow.set(k, r['停止']);
    }
    for (const a of ticks(r[ACTION])) {
      const e = enters.get(a);
      if (!e) { errors.push(`not a stopping action in the stop table: ${a}`); continue; }
      if (!ks.includes(e.kind)) errors.push(`${a} stops with ${e.kind}, row says ${ks}`);
      if (pos !== ANY && pos !== NONE && e.stage !== pos) errors.push(`${a} records ${e.stage}, row says ${r[POSITION]}`);
      if (pos !== NONE && e.stage === ANY && pos !== ANY) errors.push(`${a} records the stopped stage, row says ${r[POSITION]}`);
    }
    if (pos === NONE) {
      for (const k of ks) for (const [a, set] of pairs) {
        if (set && set.has(k) && !otherActs.has(a) && !a.endsWith('RefuseResume')) errors.push(`${k} is resumable by ${a} but the row says なし`);
      }
    }
  }
  for (const [a, e] of enters) if (![...kindRow.keys()].includes(e.kind)) errors.push(`kind ${e.kind} of ${a} is in no stop row`);
  for (const a of enters.keys()) if (!ticks((stop[0]?.rows || []).map((r) => r[ACTION]).join(' ')).includes(a)) errors.push(`stopping action not in the stop table: ${a}`);

  const rowPairs = new Set();
  for (const r of resume[0]?.rows || []) {
    const ks = ticks(r[KIND]);
    for (const a of ticks(r[ACTION])) {
      const accepted = pairs.get(a);
      if (accepted === undefined) continue;
      if (otherActs.has(a)) continue;
      for (const k of ks) {
        if (!accepted || !accepted.has(k)) errors.push(`resume row (${k}, ${a}) is not accepted by the guard`);
        rowPairs.add(`${k}|${a}`);
      }
    }
  }
  for (const [a, set] of pairs) {
    if (otherActs.has(a)) continue;
    if (!set) { errors.push(`input action without a kind guard outside the other-input table: ${a}`); continue; }
    for (const k of set) if (!rowPairs.has(`${k}|${a}`)) errors.push(`guard pair (${k}, ${a}) is in no resume row`);
  }
  const doneCited = new Set(goal.flatMap((t) => t.rows.flatMap((r) => ticks(r[ACTION]))));
  for (const a of done) if (!doneCited.has(a) && !otherActs.has(a)) errors.push(`completing action not in the completion table: ${a}`);
  for (const t of goal) for (const r of t.rows) for (const p of ticks(r[PROPERTY])) if (p !== spec.goal) errors.push(`property ${p} is not ${spec.goal}`);

  const conj = goalConjunctsOf(propsTla, spec.goal, spec.prefix);
  const cited = citedConjuncts(markdown);
  if (conj.length === 0) errors.push(`${spec.goal} has no named conjuncts`);
  if (new Set(cited).size !== cited.length) errors.push(`a conjunct is cited twice: ${cited}`);
  if (JSON.stringify([...new Set(cited)].sort()) !== JSON.stringify([...new Set(conj)].sort())) errors.push(`conjuncts ${[...conj].sort()} vs cited ${[...cited].sort()}`);
  return errors;
}

function model() {
  const files = readdirSync(MODEL_DIR).filter((f) => f.endsWith('.tla'));
  const tla = Object.fromEntries(files.map((f) => [f, read(path.join(MODEL_DIR, f))]));
  return { skill: tla['DevelopSkill.tla'], props: tla['DevelopProps.tla'], reqIds: new Set(Object.values(tla).flatMap((t) => [...reqIdsOf(t)])) };
}

const docs = () => Object.fromEntries(DOCS.map((d) => [d, read(path.join(REQ_DIR, `${d}.md`))]));

for (const [doc, spec] of Object.entries(SKILLS)) {
  test(`${doc} の停止の表・再開の表・完了の条件が、模型の kind・stage・guard・ゴールの連言と一致する`, () => {
    const { skill, props } = model();
    assert.deepEqual(checkSkillDoc(docs()[doc], skill, props, spec), []);
  });
}

test('模型の req の注記が引く要求 ID は、develop の要求文書に見出しとして実在する', () => {
  const { reqIds } = model();
  const defined = new Set(Object.values(docs()).flatMap((t) => [...requirementIdsOf(t)]));
  assert.ok(reqIds.size > 0, '模型に req の注記が無い');
  assert.deepEqual([...reqIds].filter((id) => !defined.has(id)).sort(), []);
});

test('照合の部品は、kind・stage・guard の対・ゴールの連言の食い違いを見分ける', () => {
  const skill = [
    'IActs == {"I_Stop", "I_Go", "I_No", "I_Done"}', 'RActs == {"R_A"}', 'AActs == {"A_A"}',
    '\\* req: PR-X-001, PR-X-002',
    'I_Stop_g(e) == IRun("x", e, "y")', 'I_Stop_n(e) == SI("stopped", "decide", "k1", sk.res, im)',
    'I_Go_g(e) == IStop(e, "resume") /\\ sk.kind = "k1"', 'I_Go_n(e) == SI("running", sk.stage, "none", sk.res, im)',
    'I_No_g(e) == IStop(e, "resume") /\\ sk.kind \\in {"k2"}', 'I_No_n(e) == sk',
    'I_Done_g(e) == IRun("x", e, "z")', 'I_Done_n(e) == SI("done", sk.stage, "none", "v", im)',
    'R_A_g(e) == TRUE', 'R_A_n(e) == sk', 'A_A_g(e) == TRUE', 'A_A_n(e) == sk',
    '',
  ].join('\n');
  const props = 'LOCAL ImplA == TRUE\nLOCAL ImplB == TRUE\nImplGoal ==\n  /\\ ImplA\n  /\\ ImplB\n';
  const spec = { set: 'IActs', goal: 'ImplGoal', prefix: 'Impl', stages: { 'PR-DEVELOPIMPLEMENT-029 の判定': 'decide', '計画の run': 'plan', なし: NONE } };
  const good = [
    '| 停止 | 記録する位置 | 模型の kind | 模型の action |', '|---|---|---|---|',
    '| s1 | PR-DEVELOPIMPLEMENT-029 の判定 | `k1` | `I_Stop` |', '',
    '| 条件: 停止 | 結果 | 模型の kind | 模型の action |', '|---|---|---|---|',
    '| s1 | 続ける | `k1` | `I_Go` |', '| 上記以外 | 拒否 | `k2` | `I_No` |', '',
    '| 完了の種類 | 模型の action | 模型の性質 |', '|---|---|---|', '| 完了 | `I_Done` | `ImplGoal` |', '',
    '- a（模型: `ImplA`）', '- b（模型: `ImplB`）', '',
  ].join('\n');
  assert.deepEqual(checkSkillDoc(good, skill, props, spec), []);
  const broken = {
    position: good.replace('| s1 | PR-DEVELOPIMPLEMENT-029 の判定 |', '| s1 | 計画の run |'),
    kind: good.replace('| s1 | PR-DEVELOPIMPLEMENT-029 の判定 | `k1` |', '| s1 | PR-DEVELOPIMPLEMENT-029 の判定 | `k9` |'),
    pairWrong: good.replace('| s1 | 続ける | `k1` | `I_Go` |', '| s1 | 続ける | `k1` | `I_No` |'),
    pairMissing: good.replace('| 上記以外 | 拒否 | `k2` | `I_No` |\n', ''),
    otherSkill: good.replace('`I_Go` |', '`I_Go`・`R_A` |'),
    conjunct: good.replace('- b（模型: `ImplB`）', '- b'),
    doneMissing: good.replace('| 完了 | `I_Done` | `ImplGoal` |', '| 完了 | 模型の範囲の外 | `ImplGoal` |'),
  };
  for (const [name, md] of Object.entries(broken)) assert.notDeepEqual(checkSkillDoc(md, skill, props, spec), [], name);
  assert.deepEqual([...reqIdsOf(skill)], ['PR-X-001', 'PR-X-002']);
  assert.throws(() => actionSetsOf('IActs == {"I_A"}'), /RActs/);
});
