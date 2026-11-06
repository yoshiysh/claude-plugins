import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODEL_DIR = path.join(ROOT, 'tests', 'formal', 'develop');
const REQ_DIR = path.join(ROOT, 'docs', 'requirements');
const DOCS = ['develop-plugin', 'develop-implement', 'develop-review', 'develop-address-review'];
const ANY = '*';
const NONE = 'none';
// 「記録する位置」の列の値を、模型が停止に記録する stage に写す。ANY はその停止が起きた段（模型では sk.stage か段ごとの値）。
// branches は、再開の action の次の状態が分岐する変数と、それに当たる再開の表の条件の列。値は文書の「条件の値」の行から読む。
// 写像に無い形の分岐は、値の被覆の照合の外になる。
// splitsGoal は、文書が完了の条件を done の外（どの時点でも）と内の 2 つの要求に分けていること。分けない文書は 1 つの列で照らす。
const SKILLS = Object.freeze({
  'develop-implement': {
    set: 'IActs', goal: 'ImplGoal', prefix: 'Impl',
    branches: [{ next: 'IResumeStage', on: 'im.unread', column: '未読のヒント', when: { 'im.unread > 0': 'あり', 'im.unread = 0': 'なし' } }],
    stages: { なし: NONE, '開始時の check': 'baseline', '計画の run': 'plan', 'PR-DEVELOPIMPLEMENT-029 の判定': 'decide', '止まった段の、結果を記録していない項目': ANY },
  },
  'develop-review': {
    set: 'RActs', goal: 'ReviewGoal', prefix: 'Review',
    branches: [{ next: 'IF rv.pinBroken', on: 'rv.pinBroken', column: 'pin', when: { '~rv.pinBroken': '崩れていない', 'rv.pinBroken': '崩れた' } }],
    stages: { なし: NONE, '項目の起動の、未着手の項目': 'items', '止まった段の、結果を記録していない項目': ANY },
  },
  'develop-address-review': {
    set: 'AActs', goal: 'AddressGoal', prefix: 'Addr', splitsGoal: true,
    stages: { なし: NONE, '止める所への振り分け': 'route', 'develop:implement の呼び出し': 'implement', '止まった段の、結果を記録していない項目': ANY },
  },
});
const ACTION = '模型の action';
const KIND = '模型の kind';
const PROPERTY = '模型の性質';
const POSITION = '記録する位置';
const STOP = '停止';
const STOP_COND = '条件: 停止';
const DEFINING = '止まる条件を定める要求';
const RESULT = '結果';
const OTHERWISE = '上記以外';
const REFUSE = '再開を拒否';

const read = (file) => readFileSync(file, 'utf8');
const ticks = (cell) => [...String(cell || '').matchAll(/`([^`]+)`/g)].map((m) => m[1]);
const cellsOf = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

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

export const expandIds = (text) => [...String(text).matchAll(/PR-([A-Z]+)-(\d{3})((?:(?:（[^）]*）)?・\d{3})*)/g)]
  .flatMap(([, p, first, rest]) => [first, ...[...rest.matchAll(/・(\d{3})/g)].map((m) => m[1])].map((n) => `PR-${p}-${n}`));

// 各 action の直前の連続した注記の行から、req の要求 ID を取る。
export function reqOfActions(skillTla) {
  const out = new Map();
  let ids = [];
  for (const line of skillTla.split('\n')) {
    const req = /^\\\* req:(.*)$/.exec(line.trim());
    if (req) { ids = expandIds(req[1]); continue; }
    if (line.trim().startsWith('\\*')) continue;
    const g = /^([A-Za-z_]\w*)_g\(e\) ==/.exec(line);
    if (g) out.set(g[1], new Set(ids));
    ids = [];
  }
  return out;
}

// 模型の action を、停止に入るもの（次の状態が stopped で kind が文字列）・止まった状態で受ける入力（guard が停止を見る）・完了・打ち切りに分ける。
// 入力のうち次の状態が running のものを再開とする（名前ではなく遷移で分けるため、拒否・環境の変化・ほかの停止への移りは再開に入らない）。
export function shapeOf(skillTla, names) {
  const enters = new Map();
  const inputs = new Map();
  const done = new Set();
  const aborts = new Set();
  const running = new Set();
  const kinds = new Set();
  for (const name of names) {
    const g = partOf(skillTla, name, '_g');
    const n = partOf(skillTla, name, '_n');
    const stop = /S[IRA]\("stopped",\s*("?[\w.]+"?),\s*"(\w+)"/.exec(n);
    if (stop) {
      enters.set(name, { stage: stop[1].startsWith('"') ? stop[1].slice(1, -1) : ANY, kind: stop[2] });
      kinds.add(stop[2]);
    }
    if (/"done"/.test(n)) done.add(name);
    if (/"aborted"/.test(n)) aborts.add(name);
    if (/S[IRA]\("running"/.test(n)) running.add(name);
    if (/(?<!["\w])Stopped\b|\b[IA]Stop\(/.test(g)) inputs.set(name, g);
  }
  const pairs = new Map();
  for (const [name, g] of inputs) {
    const ks = kindsOfGuard(g, kinds);
    pairs.set(name, ks.size ? ks : null);
  }
  const resumers = new Set([...pairs].filter(([a, ks]) => ks && running.has(a)).map(([a]) => a));
  return { enters, pairs, done, aborts, resumers, kinds };
}

function kindsOfGuard(g, kinds) {
  const ks = new Set();
  for (const m of g.matchAll(/sk\.kind\s*=\s*"(\w+)"/g)) ks.add(m[1]);
  for (const m of g.matchAll(/sk\.kind\s*\\in\s*\{([^}]*)\}/g)) for (const [, k] of m[1].matchAll(/"(\w+)"/g)) ks.add(k);
  const neg = [...g.matchAll(/sk\.kind\s*#\s*"(\w+)"/g)].map((m) => m[1]);
  if (neg.length) for (const k of kinds) if (!neg.includes(k)) ks.add(k);
  return ks;
}

function disjunctsOf(g) {
  if (!g.includes('\\/')) return [g];
  const parts = g.split('\\/');
  if (/^(?:[\s\S]*(?:\(|\/\\))?\s*$/.test(parts[0])) return parts.slice(1);
  return [parts[0].replace(/^[\s\S]*\/\\\s*\(\s*/, ''), ...parts.slice(1)];
}

// 次の状態が分岐する再開の action について、guard の選言肢ごとに、分岐の変数を見ない選言肢は条件の値の全てを、
// 分岐の変数を見る選言肢は when が写す値だけを、その (kind, action) の行の条件の列の値（* は全ての値）が過不足なく覆うかを照らす。
export function branchCoverage(markdown, skillTla, names, spec, resumeRows) {
  const errors = [];
  const { enters, kinds, resumers } = shapeOf(skillTla, names);
  const alwaysPlan = (k) => {
    const es = [...enters.values()].filter((e) => e.kind === k);
    return es.length > 0 && es.every((e) => e.stage === 'plan');
  };
  for (const b of spec.branches || []) {
    const col = `条件: ${b.column}`;
    const line = new RegExp(`^> 条件の値: ${b.column} = (.*)$`, 'm').exec(markdown);
    if (!line) { errors.push(`condition values of ${b.column} are not declared`); continue; }
    const values = line[1].split(' / ').map((v) => v.trim());
    const whenVals = Object.values(b.when || {});
    const badWhen = whenVals.filter((v) => !values.includes(v));
    if (badWhen.length) { errors.push(`branch ${b.column} maps when to undeclared values: ${badWhen}`); continue; }
    const missWhen = values.filter((v) => !whenVals.includes(v));
    if (missWhen.length) { errors.push(`branch ${b.column} when does not cover values: ${missWhen}`); continue; }
    let matchedActions = 0;
    for (const a of resumers) {
      if (!partOf(skillTla, a, '_n').includes(b.next)) continue;
      matchedActions++;
      const g = partOf(skillTla, a, '_g');
      const expected = new Map();
      for (const d of disjunctsOf(g)) {
        const ks = kindsOfGuard(d, kinds);
        if (!ks.size) { errors.push(`${a} has a disjunct without a recognized kind guard`); continue; }
        let allowed = values;
        if (d.includes(b.on)) {
          const hit = Object.entries(b.when || {})
            .filter(([expr]) => new RegExp(`(?<![~\\w])${expr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w.])`).test(d))
            .map(([, v]) => v);
          if (!hit.length) { errors.push(`${a} has an unrecognized ${b.on} guard`); continue; }
          allowed = hit;
        }
        for (const k of ks) {
          if (!expected.has(k)) expected.set(k, new Set());
          for (const v of allowed) expected.get(k).add(v);
        }
      }
      for (const [k, want] of expected) {
        const seen = new Set();
        for (const r of resumeRows) {
          if (!ticks(r[KIND]).includes(k) || !ticks(r[ACTION]).includes(a)) continue;
          if (r[col] === ANY && !alwaysPlan(k)) { errors.push(`(${k}, ${a}) cannot use * for ${b.column}`); continue; }
          if (r[col] !== ANY && !values.includes(r[col])) { errors.push(`(${k}, ${a}) has undeclared ${b.column} value: ${r[col]}`); continue; }
          for (const v of r[col] === ANY ? values : [r[col]]) seen.add(v);
        }
        const miss = [...want].filter((v) => !seen.has(v));
        if (miss.length) errors.push(`(${k}, ${a}) branches on ${b.column}, but no row covers ${miss}`);
        const extra = [...seen].filter((v) => !want.has(v));
        if (extra.length) errors.push(`(${k}, ${a}) restricts ${b.column} to ${[...want]}, but row covers ${extra}`);
      }
    }
    if (!matchedActions) errors.push(`branch ${b.column} matched no (kind, action) pair`);
  }
  return errors;
}

export function definitionsOf(tla) {
  return new Set([...tla.matchAll(/^(?:LOCAL\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*(?:\([^)]*\))?\s*==/gm)].map((m) => m[1]));
}

// ゴールの連言を、done の外（どの時点でも守る）と done の内（完了のときに守る）の 2 群に、定義の順で分ける。
export function goalGroupsOf(propsTla, goal, prefix) {
  const m = new RegExp(`^${goal} ==([\\s\\S]*?)(?=^\\S|(?![\\s\\S]))`, 'm').exec(propsTla);
  if (!m) throw new Error(`${goal} is not defined`);
  const defined = definitionsOf(propsTla);
  const at = m[1].indexOf('out.st = "done"');
  const always = [];
  const onDone = [];
  for (const x of m[1].matchAll(new RegExp(`\\b(${prefix}[A-Z]\\w*)\\b`, 'g'))) {
    if (!defined.has(x[1])) continue;
    (at >= 0 && x.index > at ? onDone : always).push(x[1]);
  }
  return [always, onDone].filter((g) => g.length);
}

const CITE = /（模型: `([A-Za-z]+)`/g;

// 連言の名前を引く箇条を、要求（#### の見出し）ごとの列として返す。箇条の外で名前を引いた行は誤りにする。
export function citedGroupsOf(markdown) {
  const groups = [];
  const errors = [];
  let block = null;
  for (const line of markdown.split('\n')) {
    if (/^#{2,4} /.test(line)) { block = { head: line, bullets: [] }; groups.push(block); continue; }
    const names = [...line.matchAll(CITE)].map((m) => m[1]);
    if (/^- /.test(line)) { if (block && !(names.length === 0 && line.includes('（模型の範囲の外）'))) block.bullets.push(names); continue; }
    if (names.length) errors.push(`a conjunct is cited outside a bullet: ${names}`);
  }
  const cited = groups.filter((g) => g.bullets.some((b) => b.length));
  for (const g of cited) for (const b of g.bullets) if (b.length !== 1) errors.push(`a bullet of ${g.head} cites ${b.length} conjuncts`);
  return { groups: cited.map((g) => g.bullets.map((b) => b[0])), errors };
}

export function reqIdsOf(tla) {
  const ids = new Set();
  for (const line of tla.split('\n')) {
    const m = /^\\\* req:(.*)$/.exec(line.trim());
    if (m) for (const id of expandIds(m[1])) ids.add(id);
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

// ほかの入力の表を、表を持つ要求の ID ごとに集める。kind の無い action は、表と req の注記の対で照らす。
export function otherTablesByRequirement(markdown) {
  const out = new Map();
  for (const part of markdown.split(/^(?=#### PR-[A-Z]+-\d{3} )/m)) {
    const id = /^#### (PR-[A-Z]+-\d{3}) /.exec(part)?.[1];
    if (!id) continue;
    const { other } = classify(tablesOf(part));
    if (other.length) out.set(id, new Set(other.flatMap((t) => t.rows.flatMap((r) => ticks(r[ACTION])))));
  }
  return out;
}

function checkStopTable(rows, shape, reqs, spec, errors) {
  const { enters, pairs, resumers } = shape;
  const nameKinds = new Map();
  const kindRow = new Map();
  const resumable = (k) => [...resumers].some((a) => pairs.get(a).has(k));
  for (const r of rows) {
    const ks = ticks(r[KIND]);
    const acts = ticks(r[ACTION]);
    const pos = spec.stages[r[POSITION]];
    if (pos === undefined) errors.push(`unknown position: ${r[POSITION]}`);
    if (nameKinds.has(r[STOP])) errors.push(`stop name ${r[STOP]} has two rows`);
    nameKinds.set(r[STOP], { kinds: ks, pos });
    for (const k of ks) {
      if (kindRow.has(k)) errors.push(`kind ${k} has two stop names: ${kindRow.get(k)} / ${r[STOP]}`);
      kindRow.set(k, r[STOP]);
      if (!acts.some((a) => enters.get(a)?.kind === k)) errors.push(`kind ${k} of ${r[STOP]} is entered by no action of the row`);
      if (pos === NONE && resumable(k)) errors.push(`${k} is resumable but the row ${r[STOP]} says なし`);
      if (pos !== NONE && pos !== undefined && !resumable(k)) errors.push(`${k} is resumable by no action but the row ${r[STOP]} records ${r[POSITION]}`);
    }
    const ids = new Set(expandIds(r[DEFINING]));
    const stages = new Set();
    for (const a of acts) {
      const e = enters.get(a);
      if (!e) { errors.push(`not a stopping action in the stop table: ${a}`); continue; }
      stages.add(e.stage);
      if (!ks.includes(e.kind)) errors.push(`${a} stops with ${e.kind}, row says ${ks}`);
      if (pos !== ANY && pos !== NONE && e.stage !== pos) errors.push(`${a} records ${e.stage}, row says ${r[POSITION]}`);
      if (![...(reqs.get(a) || [])].some((id) => ids.has(id))) errors.push(`${a} cites none of the defining requirements of ${r[STOP]}`);
    }
    if (pos === ANY && stages.size === 1 && !stages.has(ANY)) errors.push(`${r[STOP]} always records ${[...stages][0]}, row says ${r[POSITION]}`);
  }
  for (const [a, e] of enters) if (!kindRow.has(e.kind)) errors.push(`kind ${e.kind} of ${a} is in no stop row`);
  const cited = new Set(rows.flatMap((r) => ticks(r[ACTION])));
  for (const a of enters.keys()) if (!cited.has(a)) errors.push(`stopping action not in the stop table: ${a}`);
  return nameKinds;
}

function checkResumeTable(rows, nameKinds, shape, errors) {
  const { pairs, resumers } = shape;
  const rowPairs = new Set();
  const named = new Set();
  const stopKinds = new Set([...nameKinds.values()].flatMap((v) => v.kinds));
  for (const r of rows) {
    const ks = ticks(r[KIND]);
    const acts = ticks(r[ACTION]);
    const name = r[STOP_COND];
    if (name === OTHERWISE) {
      for (const k of ks) if (!stopKinds.has(k)) errors.push(`resume row ${OTHERWISE} has kind ${k} of no stop`);
    } else if (!nameKinds.has(name)) {
      errors.push(`resume row names an unknown stop: ${name}`);
    } else if (!same([...ks].sort(), [...nameKinds.get(name).kinds].sort())) {
      errors.push(`resume row ${name} says kinds ${ks}, the stop table says ${nameKinds.get(name).kinds}`);
    }
    for (const a of acts) {
      const accepted = pairs.get(a);
      if (!accepted) { errors.push(`not a kind-guarded input in the resume table: ${a}`); continue; }
      for (const k of ks) {
        if (!accepted.has(k)) errors.push(`resume row (${k}, ${a}) is not accepted by the guard`);
        rowPairs.add(`${k}|${a}`);
      }
    }
    if (acts.length) {
      const refuses = r[RESULT].startsWith(REFUSE);
      const resumes = acts.some((a) => resumers.has(a));
      if (refuses === resumes) errors.push(`resume row ${name} (${acts}) says ${refuses ? 'refused' : 'resumed'}, the model ${resumes ? 'resumes' : 'does not resume'}`);
      if (resumes && name !== OTHERWISE) named.add(name);
    }
  }
  for (const [a, set] of pairs) if (set) for (const k of set) if (!rowPairs.has(`${k}|${a}`)) errors.push(`guard pair (${k}, ${a}) is in no resume row`);
  for (const [name, { pos }] of nameKinds) if (pos !== NONE && pos !== undefined && !named.has(name)) errors.push(`resumable stop ${name} has no resume row`);
}

function checkStopValues(markdown, nameKinds, errors) {
  const lines = [...markdown.matchAll(/^> 条件の値: 停止 = (.*)$/gm)].map((m) => m[1].split(' / ').map((v) => v.trim()));
  if (lines.length !== 1) errors.push(`condition values of the stop: ${lines.length} lines`);
  else if (!same(lines[0], [...nameKinds.keys()])) errors.push(`condition values of the stop ${lines[0]} vs stop names ${[...nameKinds.keys()]}`);
}

export function checkSkillDoc(markdown, skillTla, propsTla, spec) {
  const errors = [];
  const names = actionSetsOf(skillTla)[spec.set];
  const shape = shapeOf(skillTla, names);
  const { enters, pairs, done, aborts } = shape;
  const { stop, resume, other, goal } = classify(tablesOf(markdown));
  if (stop.length !== 1 || resume.length !== 1) errors.push(`stop tables ${stop.length}, resume tables ${resume.length}`);
  const all = [...stop, ...resume, ...other, ...goal].flatMap((t) => t.rows.flatMap((r) => ticks(r[ACTION])));
  for (const a of all) if (!names.has(a)) errors.push(`not an action of ${spec.set}: ${a}`);

  const reqs = reqOfActions(skillTla);
  const nameKinds = checkStopTable(stop[0]?.rows || [], shape, reqs, spec, errors);
  checkResumeTable(resume[0]?.rows || [], nameKinds, shape, errors);
  checkStopValues(markdown, nameKinds, errors);
  errors.push(...branchCoverage(markdown, skillTla, names, spec, resume[0]?.rows || []));

  const otherActs = new Set(other.flatMap((t) => t.rows.flatMap((r) => ticks(r[ACTION]))));
  for (const a of otherActs) {
    if (enters.has(a) || pairs.get(a) || done.has(a)) errors.push(`${a} stops, resumes or completes, but is in an other-input table`);
  }
  for (const a of aborts) if (!otherActs.has(a)) errors.push(`aborting action not in an other-input table: ${a}`);
  const byReq = otherTablesByRequirement(markdown);
  const tableOnly = (a) => !enters.has(a) && !pairs.get(a) && !done.has(a);
  for (const a of names) if (tableOnly(a)) for (const id of reqs.get(a) || []) if (byReq.has(id) && !byReq.get(id).has(a)) errors.push(`${a} cites ${id} but is not in its table`);
  for (const [id, acts] of byReq) for (const a of acts) if (!reqs.get(a)?.has(id)) errors.push(`${a} is in the table of ${id} but does not cite it`);
  for (const [a, set] of pairs) if (!set && !otherActs.has(a)) errors.push(`input action without a kind guard outside the other-input tables: ${a}`);
  const doneCited = new Set(goal.flatMap((t) => t.rows.flatMap((r) => ticks(r[ACTION]))));
  for (const a of done) if (!doneCited.has(a)) errors.push(`completing action not in the completion table: ${a}`);
  for (const a of doneCited) if (!done.has(a)) errors.push(`not a completing action in the completion table: ${a}`);
  for (const t of goal) for (const r of t.rows) if (!same(ticks(r[PROPERTY]), [spec.goal])) errors.push(`completion row ${Object.values(r)[0]} has property ${ticks(r[PROPERTY])}, not ${spec.goal}`);

  const model = goalGroupsOf(propsTla, spec.goal, spec.prefix);
  const doc = citedGroupsOf(markdown);
  errors.push(...doc.errors);
  if (model.length === 0) errors.push(`${spec.goal} has no named conjuncts`);
  const fits = spec.splitsGoal ? same(doc.groups, model) : same(doc.groups, [model.flat()]);
  if (!fits) errors.push(`conjuncts ${JSON.stringify(model)} vs cited bullets ${JSON.stringify(doc.groups)}`);
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

test('照合の部品は、kind・stage・guard の対・停止の名前・結果の向き・ほかの入力の表と注記の対・分岐の値の被覆・ゴールの連言の食い違いを見分ける', () => {
  const skill = [
    'IActs == {"I_Stop", "I_Halt", "I_Go", "I_No", "I_Done", "I_Gate", "H_Abort"}', 'RActs == {"R_A"}', 'AActs == {"A_A"}',
    '\\* req: PR-X-001, PR-X-002',
    'I_Stop_g(e) == IRun("x", e, "y")', 'I_Stop_n(e) == SI("stopped", "decide", "k1", sk.res, im)',
    '\\* req: PR-X-003',
    'I_Halt_g(e) == IRun("x", e, "y")', 'I_Halt_n(e) == SI("stopped", "plan", "k2", sk.res, im)',
    'I_Go_g(e) == IStop(e, "resume") /\\ sk.kind = "k1"', 'I_Go_n(e) == SI("running", sk.stage, "none", sk.res, im)',
    'I_No_g(e) == IStop(e, "resume") /\\ sk.kind \\in {"k2"}', 'I_No_n(e) == sk',
    'I_Done_g(e) == IRun("x", e, "z")', 'I_Done_n(e) == SI("done", sk.stage, "none", "v", im)',
    '\\* req: PR-X-004',
    'I_Gate_g(e) == IRun("x", e, "w")', 'I_Gate_n(e) == SI("running", "plan", "none", sk.res, im)',
    '\\* req: PR-X-004',
    'H_Abort_g(e) == Stopped /\\ e.n = "abort"', 'H_Abort_n(e) == [sk EXCEPT !.st = "aborted"]',
    'R_A_g(e) == TRUE', 'R_A_n(e) == sk', 'A_A_g(e) == TRUE', 'A_A_n(e) == sk',
    '',
  ].join('\n');
  const props = 'LOCAL ImplA == TRUE\nLOCAL ImplB == TRUE\nImplGoal ==\n  (IsI /\\ out.st = "done") =>\n  /\\ ImplA\n  /\\ ImplB\n';
  const spec = {
    set: 'IActs', goal: 'ImplGoal', prefix: 'Impl',
    stages: { 'PR-DEVELOPIMPLEMENT-029 の判定': 'decide', '計画の run': 'plan', 止まった段: ANY, なし: NONE },
  };
  const good = [
    '#### PR-X-001 停止', '',
    '| 停止 | 止まる条件を定める要求 | 記録する位置 | 模型の kind | 模型の action |', '|---|---|---|---|---|',
    '| s1 | PR-X-001 | PR-DEVELOPIMPLEMENT-029 の判定 | `k1` | `I_Stop` |',
    '| s2 | PR-X-003 | なし | `k2` | `I_Halt` |', '',
    '> 条件の値: 停止 = s1 / s2', '',
    '| 条件: 停止 | 結果 | 模型の kind | 模型の action |', '|---|---|---|---|',
    '| s1 | 続ける | `k1` | `I_Go` |', '| 上記以外 | 再開を拒否する | `k2` | `I_No` |', '',
    '#### PR-X-004 ほかの入力', '',
    '| 入力 | 模型の action |', '|---|---|', '| 打ち切り | `H_Abort` |', '| ゲート | `I_Gate` |', '',
    '#### PR-X-002 完了', '',
    '- a（模型: `ImplA`）。', '- b（模型: `ImplB`）。', '',
    '| 完了の種類 | 模型の action | 模型の性質 |', '|---|---|---|', '| 完了 | `I_Done` | `ImplGoal` |', '',
  ].join('\n');
  assert.deepEqual(checkSkillDoc(good, skill, props, spec), []);
  const broken = {
    position: good.replace('| s1 | PR-X-001 | PR-DEVELOPIMPLEMENT-029 の判定 |', '| s1 | PR-X-001 | 計画の run |'),
    stoppedStageOnOneStage: good.replace('| s1 | PR-X-001 | PR-DEVELOPIMPLEMENT-029 の判定 |', '| s1 | PR-X-001 | 止まった段 |'),
    noneButResumable: good.replace('| s1 | PR-X-001 | PR-DEVELOPIMPLEMENT-029 の判定 |', '| s1 | PR-X-001 | なし |'),
    positionButNotResumable: good.replace('| s2 | PR-X-003 | なし |', '| s2 | PR-X-003 | 計画の run |'),
    kind: good.replace('| s1 | PR-X-001 | PR-DEVELOPIMPLEMENT-029 の判定 | `k1` |', '| s1 | PR-X-001 | PR-DEVELOPIMPLEMENT-029 の判定 | `k9` |'),
    definingDisjoint: good.replace('| s1 | PR-X-001 |', '| s1 | PR-X-009 |'),
    pairWrong: good.replace('| s1 | 続ける | `k1` | `I_Go` |', '| s1 | 続ける | `k1` | `I_No` |'),
    pairMissing: good.replace('| 上記以外 | 再開を拒否する | `k2` | `I_No` |\n', ''),
    otherSkill: good.replace('`I_Go` |', '`I_Go`・`R_A` |'),
    unknownStopName: good.replace('| s1 | 続ける |', '| s9 | 続ける |'),
    stopNameOfOtherKind: good.replace('| s1 | 続ける |', '| s2 | 続ける |'),
    stopValues: good.replace('> 条件の値: 停止 = s1 / s2', '> 条件の値: 停止 = s1'),
    resultRefusesOnResume: good.replace('| s1 | 続ける |', '| s1 | 再開を拒否する |'),
    resultResumesOnRefusal: good.replace('| 上記以外 | 再開を拒否する |', '| 上記以外 | 続ける |'),
    guardedInOtherTable: good.replace('| ゲート | `I_Gate` |', '| ゲート | `I_Gate`・`I_No` |'),
    doneInOtherTable: good.replace('| ゲート | `I_Gate` |', '| ゲート | `I_Gate`・`I_Done` |'),
    abortMissing: good.replace('| 打ち切り | `H_Abort` |\n', ''),
    doneMissing: good.replace('| 完了 | `I_Done` | `ImplGoal` |', '| 完了 | 模型の範囲の外 | `ImplGoal` |'),
    propertyMissing: good.replace('| `I_Done` | `ImplGoal` |', '| `I_Done` | 模型の範囲の外 |'),
    gateMissing: good.replace('| ゲート | `I_Gate` |\n', ''),
    gateMoved: good.replace('| ゲート | `I_Gate` |\n', '').replace('| 完了の種類 |', '| 時点 | 模型の action |\n|---|---|\n| ゲート | `I_Gate` |\n\n| 完了の種類 |'),
    conjunct: good.replace('- b（模型: `ImplB`）', '- b'),
    conjunctsSwapped: good.replace('`ImplA`', '`TMP`').replace('`ImplB`', '`ImplA`').replace('`TMP`', '`ImplB`'),
    conjunctOutsideBullets: good.replace('- b（模型: `ImplB`）。\n', '').replace('#### PR-X-001 停止', '#### PR-X-001 停止\n本文（模型: `ImplB`）。'),
  };
  for (const [name, md] of Object.entries(broken)) {
    assert.notEqual(md, good, `${name} did not change the document`);
    assert.notDeepEqual(checkSkillDoc(md, skill, props, spec), [], name);
  }

  const twoGroups = 'LOCAL ImplA == TRUE\nLOCAL ImplB == TRUE\nImplGoal ==\n  IsI =>\n    /\\ ImplA\n    /\\ out.st = "done" =>\n         /\\ ImplB\n';
  const split = good.replace('- b（模型: `ImplB`）。\n', '').replace('#### PR-X-002 完了', '#### PR-X-005 どの時点でも\n\n- a2\n\n#### PR-X-002 完了')
    .replace('- a（模型: `ImplA`）。', '- b（模型: `ImplB`）。').replace('- a2', '- a（模型: `ImplA`）。');
  const splitSpec = { ...spec, splitsGoal: true };
  assert.deepEqual(checkSkillDoc(split, skill, twoGroups, splitSpec), []);
  const moved = split.replace('- a（模型: `ImplA`）。\n', '').replace('- b（模型: `ImplB`）。', '- a（模型: `ImplA`）。\n- b（模型: `ImplB`）。');
  assert.notDeepEqual(checkSkillDoc(moved, skill, twoGroups, splitSpec), [], 'a conjunct moved across the done scope');
  assert.notDeepEqual(checkSkillDoc(split, skill, twoGroups, spec), [], 'a document that does not split the goal keeps one list');
  assert.deepEqual(checkSkillDoc(good, skill, twoGroups, spec), [], 'one bullet list holds both groups in order');

  const outside = good.replace('- b（模型: `ImplB`）。', '- b（模型: `ImplB`）。\n- c（模型の範囲の外）。');
  assert.deepEqual(checkSkillDoc(outside, skill, props, spec), [], 'a bullet marked out of the model is not a conjunct');
  assert.deepEqual(checkSkillDoc(good, skill.replace('I_Done_g(e) ==', '\\* req: PR-X-004\nI_Done_g(e) =='), props, spec), [],
    'a completing action may cite a requirement whose table holds other actions');

  const branchSkill = skill
    .replace('I_Go_g(e) == IStop(e, "resume") /\\ sk.kind = "k1"', 'I_Go_g(e) == IStop(e, "resume") /\\\n  (\\/ sk.kind = "k1"\n   \\/ sk.kind = "k2" /\\ im.unread > 0)')
    .replace('I_Go_n(e) == SI("running", sk.stage,', 'I_Go_n(e) == SI("running", IResumeStage,')
    .replace('I_No_g(e) == IStop(e, "resume") /\\ sk.kind \\in {"k2"}', 'I_No_g(e) == IStop(e, "resume") /\\ sk.kind \\in {"k2"} /\\ im.unread = 0');
  const branchSpec = { ...spec, branches: [{ next: 'IResumeStage', on: 'im.unread', column: 'ヒント', when: { 'im.unread > 0': 'あり', 'im.unread = 0': 'なし' } }] };
  const branchDoc = good
    .replace('> 条件の値: 停止 = s1 / s2', '> 条件の値: 停止 = s1 / s2\n> 条件の値: ヒント = あり / なし')
    .replace('| 条件: 停止 | 結果 | 模型の kind | 模型の action |', '| 条件: 停止 | 条件: ヒント | 結果 | 模型の kind | 模型の action |').replace('|---|---|---|---|\n| s1', '|---|---|---|---|---|\n| s1')
    .replace('| s1 | 続ける | `k1` | `I_Go` |', '| s1 | あり | 続ける | `k1` | `I_Go` |\n| s1 | なし | 続ける | `k1` | `I_Go` |\n| s2 | あり | 続ける | `k2` | `I_Go` |')
    .replace('| 上記以外 | 再開を拒否する |', '| 上記以外 | * | 再開を拒否する |')
    .replace('| s2 | PR-X-003 | なし |', '| s2 | PR-X-003 | 計画の run |');
  assert.deepEqual(checkSkillDoc(branchDoc, branchSkill, props, branchSpec), [], 'a disjunct that reads the branch variable needs one value only');
  const uncovered = branchDoc.replace('| s1 | なし | 続ける | `k1` | `I_Go` |\n', '');
  assert.match(checkSkillDoc(uncovered, branchSkill, props, branchSpec).join('\n'), /\(k1, I_Go\) branches on ヒント, but no row covers なし/);
  const restrictedWildcard = branchDoc.replace('| s2 | あり | 続ける | `k2` | `I_Go` |', '| s2 | * | 続ける | `k2` | `I_Go` |');
  assert.match(checkSkillDoc(restrictedWildcard, branchSkill, props, branchSpec).join('\n'), /\(k2, I_Go\) restricts ヒント to あり, but row covers なし/);
  const restrictedWrong = branchDoc.replace('| s2 | あり | 続ける | `k2` | `I_Go` |', '| s2 | なし | 続ける | `k2` | `I_Go` |');
  assert.match(checkSkillDoc(restrictedWrong, branchSkill, props, branchSpec).join('\n'), /\(k2, I_Go\) branches on ヒント, but no row covers あり/);
  const undeclaredVal = branchDoc.replace('| s2 | あり | 続ける | `k2` | `I_Go` |', '| s2 | 不明 | 続ける | `k2` | `I_Go` |');
  assert.match(checkSkillDoc(undeclaredVal, branchSkill, props, branchSpec).join('\n'), /\(k2, I_Go\) has undeclared ヒント value: 不明/);
  const infixSkill = branchSkill.replace('(\\/ sk.kind = "k1"\n   \\/ sk.kind = "k2" /\\ im.unread > 0)', '(sk.kind = "k1"\n   \\/ sk.kind = "k2" /\\ im.unread > 0)');
  assert.deepEqual(checkSkillDoc(branchDoc, infixSkill, props, branchSpec), [], 'an infix disjunction without a leading \\/ keeps the first disjunct');
  assert.match(checkSkillDoc(uncovered, infixSkill, props, branchSpec).join('\n'), /\(k1, I_Go\) branches on ヒント, but no row covers なし/);
  const infixFirstUnguarded = branchSkill.replace('(\\/ sk.kind = "k1"\n   \\/ sk.kind = "k2" /\\ im.unread > 0)', '(im.unread > 1\n   \\/ sk.kind = "k1"\n   \\/ sk.kind = "k2" /\\ im.unread > 0)');
  assert.match(checkSkillDoc(branchDoc, infixFirstUnguarded, props, branchSpec).join('\n'), /I_Go has a disjunct without a recognized kind guard/);
  const unguardedDisjunct = branchSkill.replace('\\/ sk.kind = "k2" /\\ im.unread > 0', '\\/ sk.kind = "k2" /\\ im.unread > 0\n   \\/ im.unread > 1');
  assert.match(checkSkillDoc(branchDoc, unguardedDisjunct, props, branchSpec).join('\n'), /I_Go has a disjunct without a recognized kind guard/);
  const unusedBranchSpec = { ...spec, branches: [{ next: 'NoSuchNext', on: 'im.unread', column: 'ヒント', when: { 'im.unread > 0': 'あり', 'im.unread = 0': 'なし' } }] };
  assert.match(checkSkillDoc(branchDoc, branchSkill, props, unusedBranchSpec).join('\n'), /branch ヒント matched no \(kind, action\) pair/);
  const badWhenSpec = { ...spec, branches: [{ next: 'IResumeStage', on: 'im.unread', column: 'ヒント', when: { 'im.unread > 0': 'そのまま', 'im.unread = 0': 'なし' } }] };
  assert.match(checkSkillDoc(branchDoc, branchSkill, props, badWhenSpec).join('\n'), /branch ヒント maps when to undeclared values: そのまま/);
  const wildcardNonPlan = branchDoc.replace('| s1 | あり | 続ける | `k1` | `I_Go` |', '| s1 | * | 続ける | `k1` | `I_Go` |').replace('| s1 | なし | 続ける | `k1` | `I_Go` |', '| s1 | あり | 続ける | `k1` | `I_Go` |');
  assert.match(checkSkillDoc(wildcardNonPlan, branchSkill, props, branchSpec).join('\n'), /\(k1, I_Go\) cannot use \* for ヒント/);

  assert.deepEqual(expandIds('PR-A-001・002（行）・003、PR-B-004'), ['PR-A-001', 'PR-A-002', 'PR-A-003', 'PR-B-004']);
  assert.deepEqual([...reqIdsOf(skill)], ['PR-X-001', 'PR-X-002', 'PR-X-003', 'PR-X-004']);
  assert.throws(() => actionSetsOf('IActs == {"I_A"}'), /RActs/);
});

const notfiredCases = [
  {
    caseId: 'TC-001',
    name: 'run_sh_notfired: ACTIONS に存在する action で発火数 0 のとき killed と判定される',
    exp: 'NOTFIRED:I_OutOfPlan',
    log: [
      '"ACTIONS"',
      '{"I_OutOfPlan", "I_Other"}',
      '}',
      '<I_Other line 10>: 1: 5',
      'Model checking completed. No error has been found.',
    ].join('\n'),
    expectedVerdict: 'killed',
  },
  {
    caseId: 'TC-004',
    name: 'run_sh_notfired: ACTIONS に存在しない誤記 action または発火回数 1 以上のとき survived と判定される',
    subcases: [
      {
        desc: '誤記アクション名',
        exp: 'NOTFIRED:I_TypoAction',
        log: [
          '"ACTIONS"',
          '{"I_OutOfPlan", "I_Other"}',
          '}',
          'Model checking completed. No error has been found.',
        ].join('\n'),
        expectedVerdict: 'survived',
      },
      {
        desc: '発火数 1 以上',
        exp: 'NOTFIRED:I_Other',
        log: [
          '"ACTIONS"',
          '{"I_OutOfPlan", "I_Other"}',
          '}',
          '<I_Other line 10>: 1: 3',
          'Model checking completed. No error has been found.',
        ].join('\n'),
        expectedVerdict: 'survived',
      },
    ],
  },
  {
    caseId: 'TC-005',
    name: 'run_sh_notfired: ACTIONS に存在する action の前方一致・部分文字列は行完全一致判定により survived と判定される',
    exp: 'NOTFIRED:I_Out',
    log: [
      '"ACTIONS"',
      '{"I_OutOfPlan", "I_Other"}',
      '}',
      'Model checking completed. No error has been found.',
    ].join('\n'),
    expectedVerdict: 'survived',
  },
];

for (const c of notfiredCases) {
  test(`${c.name} (${c.caseId})`, () => {
    const runCase = (exp, logText) => {
      const script = `
fired_counts() { grep -E '^<[IRAH]_[A-Za-z]+ line' "$1" | awk -F'>: ' '{split($2,a,":"); split($1,b," "); sub("<","",b[1]); n[b[1]]+=a[2]} END {for (k in n) print k, n[k]}'; }
table_actions() { awk '/"ACTIONS"/ {f=1} f {print} f && /\\}/ {exit}' "$1" | grep -oE '"[IRAH]_[A-Za-z]+"' | tr -d '"' | sort -u; }
verdict="survived"
case "$exp" in
  NOTFIRED:*) grep -q 'No error has been found' "$log" && grep -qxF "\${exp#NOTFIRED:}" <<<"$(table_actions "$log")" && \\
                [[ "$(fired_counts "$log" | awk -v a="\${exp#NOTFIRED:}" '$1==a {print $2}')" =~ ^0?$ ]] && verdict=killed ;;
esac
echo "$verdict"
`;
      const tmp = mkdtempSync(path.join(tmpdir(), 'notfired-'));
      const logPath = path.join(tmp, 'mc.log');
      try {
        writeFileSync(logPath, logText, 'utf8');
        const out = execFileSync('/bin/bash', ['-c', script], {
          env: { ...process.env, exp, log: logPath },
          encoding: 'utf8',
        }).trim();
        return out;
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    };

    if (c.subcases) {
      for (const s of c.subcases) {
        assert.equal(runCase(s.exp, s.log), s.expectedVerdict, s.desc);
      }
    } else {
      assert.equal(runCase(c.exp, c.log), c.expectedVerdict);
    }
  });
}

const timeoutCases = [
  {
    caseId: 'TC-002',
    name: 'run_sh_timeout_fallback: mock timeout または mock gtimeout による TLC 起動',
    subcases: [
      {
        desc: 'timeout が存在する場合',
        hasTimeout: true,
        hasGtimeout: false,
        expectedMarker: 'timeout: 1200',
      },
      {
        desc: 'timeout が無く gtimeout が存在する場合',
        hasTimeout: false,
        hasGtimeout: true,
        expectedMarker: 'gtimeout: 1200',
      },
    ],
  },
  {
    caseId: 'TC-003',
    name: 'run_sh_timeout_fallback: 標準 macOS (timeout/gtimeout 無し, bash 3.2, set -u) で空 limit 配列が安全に展開され直接 TLC が起動される',
    hasTimeout: false,
    hasGtimeout: false,
    expectedMarker: 'java: -cp foo.jar',
  },
];

for (const c of timeoutCases) {
  test(`${c.name} (${c.caseId})`, () => {
    const runFallback = ({ hasTimeout, hasGtimeout }) => {
      const tmp = mkdtempSync(path.join(tmpdir(), 'to-fb-'));
      const binDir = path.join(tmp, 'bin');
      const workDir = path.join(tmp, 'work');
      const outFile = path.join(tmp, 'out.log');
      mkdirSync(binDir, { recursive: true });
      mkdirSync(workDir, { recursive: true });
      try {
        writeFileSync(path.join(binDir, 'java'), `#!/bin/sh\necho "java: $*" >> "$OUT"\n`, 'utf8');
        chmodSync(path.join(binDir, 'java'), 0o755);
        if (hasTimeout) {
          writeFileSync(path.join(binDir, 'timeout'), `#!/bin/sh\necho "timeout: $*" >> "$OUT"\nshift\n"$@"\n`, 'utf8');
          chmodSync(path.join(binDir, 'timeout'), 0o755);
        }
        if (hasGtimeout) {
          writeFileSync(path.join(binDir, 'gtimeout'), `#!/bin/sh\necho "gtimeout: $*" >> "$OUT"\nshift\n"$@"\n`, 'utf8');
          chmodSync(path.join(binDir, 'gtimeout'), 0o755);
        }

        const script = `
set -uo pipefail
export PATH="$BINDIR"
tlc=(java -cp foo.jar tlc2.TLC)
if command -v timeout >/dev/null 2>&1; then limit=(timeout 1200); elif command -v gtimeout >/dev/null 2>&1; then limit=(gtimeout 1200); else limit=(); fi
flags=(-deadlock)
(cd "$WORKDIR" && \${limit[@]+"\${limit[@]}"} "\${tlc[@]}" "\${flags[@]}" MC)
`;
        execFileSync('/bin/bash', ['-c', script], {
          env: {
            PATH: binDir,
            BINDIR: binDir,
            WORKDIR: workDir,
            OUT: outFile,
          },
          encoding: 'utf8',
        });
        const out = readFileSync(outFile, 'utf8');
        return out;
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    };

    if (c.subcases) {
      for (const s of c.subcases) {
        const out = runFallback(s);
        assert.ok(out.includes(s.expectedMarker), `${s.desc}: expected marker ${s.expectedMarker} in ${out}`);
      }
    } else {
      const out = runFallback(c);
      assert.ok(out.includes(c.expectedMarker), `expected marker ${c.expectedMarker} in ${out}`);
      assert.ok(!out.includes('unbound variable'), `unbound variable error observed: ${out}`);
    }
  });
}

const reqExpandCases = [
  {
    caseId: 'TC-011',
    name: 'req_ids_of_expand: 単一 ID と「・NNN」略記を展開して順序を保って抽出する',
    input: '\\* req: PR-DEVELOPIMPLEMENT-001・002（行）・003\n',
    expected: ['PR-DEVELOPIMPLEMENT-001', 'PR-DEVELOPIMPLEMENT-002', 'PR-DEVELOPIMPLEMENT-003'],
  },
  {
    caseId: 'TC-012',
    name: 'req_ids_of_expand: 略記された実在しない要求 ID も展開されて実在検査で検出される',
    input: '\\* req: PR-DEVELOPPLUGIN-001・999\n',
    expectedMissing: ['PR-DEVELOPPLUGIN-999'],
  },
  {
    caseId: 'TC-013',
    name: 'req_ids_of_expand: 3 連以上の略記の展開と非 req コメントからの空集合抽出',
    subcases: [
      {
        input: '\\* req: PR-DEVELOPIMPLEMENT-033・034・049\n',
        expected: ['PR-DEVELOPIMPLEMENT-033', 'PR-DEVELOPIMPLEMENT-034', 'PR-DEVELOPIMPLEMENT-049'],
      },
      {
        input: '(* standard comment without req *)\n\\* principle: something\n',
        expected: [],
      },
    ],
  },
];

for (const c of reqExpandCases) {
  test(`${c.name} (${c.caseId})`, () => {
    if (c.caseId === 'TC-011') {
      const ids = [...reqIdsOf(c.input)];
      assert.deepEqual(ids, c.expected);
    } else if (c.caseId === 'TC-012') {
      const defined = new Set(Object.values(docs()).flatMap((t) => [...requirementIdsOf(t)]));
      const ids = [...reqIdsOf(c.input)];
      const missing = ids.filter((id) => !defined.has(id));
      assert.deepEqual(missing, c.expectedMissing);
    } else if (c.caseId === 'TC-013') {
      for (const s of c.subcases) {
        assert.deepEqual([...reqIdsOf(s.input)], s.expected);
      }
    }
  });
}

test('TC-006 PR-DEVELOPPLUGIN-035 PR-DEVELOPPLUGIN-041 PR-DEVELOPIMPLEMENT-059 PR-DEVELOPADDRESSREVIEW-021 PR-DEVELOPADDRESSREVIEW-025 PR-DEVELOPADDRESSREVIEW-049 PR-DEVELOPADDRESSREVIEW-060 DevelopCommon への 4 演算子集約と DevelopEnv/Props からの参照、および README の要求 ID 参照検証', () => {
  const common = read(path.join(MODEL_DIR, 'DevelopCommon.tla'));
  const env = read(path.join(MODEL_DIR, 'DevelopEnv.tla'));
  const props = read(path.join(MODEL_DIR, 'DevelopProps.tla'));
  const skill = read(path.join(MODEL_DIR, 'DevelopSkill.tla'));
  const readme = read(path.join(MODEL_DIR, 'README.md'));

  for (const op of ['UnvOf(r, dec) ==', 'ConfirmedOf(r, dec) ==', 'NeedsCommitOf(a) ==', 'EffFixOf(cls, dec) ==']) {
    assert.ok(common.includes(op), `DevelopCommon.tla must define ${op}`);
  }

  for (const call of ['Unv(r) == UnvOf(r, hist.dec)', 'Confirmed(r) == ConfirmedOf(r, hist.dec)', 'NeedsCommit == NeedsCommitOf(args)', 'EffFix == EffFixOf(hist.aClass, hist.aDec)']) {
    assert.ok(env.includes(call), `DevelopEnv.tla must call ${call}`);
  }

  for (const call of ['LOCAL Unv(r) == UnvOf(r, hist.dec)', 'LOCAL Confirmed(r) == ConfirmedOf(r, hist.dec)', 'LOCAL NeedsCommit == NeedsCommitOf(args)', 'LOCAL EffFix == EffFixOf(hist.aClass, hist.aDec)']) {
    assert.ok(props.includes(call), `DevelopProps.tla must call ${call}`);
  }

  assert.ok(!skill.includes('UnvOf'), 'DevelopSkill.tla must not call UnvOf');
  assert.ok(!skill.includes('ConfirmedOf'), 'DevelopSkill.tla must not call ConfirmedOf');
  assert.ok(skill.includes('NeedsCommitOf(args)'), 'DevelopSkill.tla must call NeedsCommitOf(args)');
  assert.ok(!skill.includes('EffFixOf'), 'DevelopSkill.tla must not call EffFixOf');

  const modelFiles = readdirSync(MODEL_DIR);
  for (const f of modelFiles) {
    const full = path.join(MODEL_DIR, f);
    if (!f.endsWith('.tla') && !f.endsWith('.md')) continue;
    const content = read(full);
    assert.ok(!/sp-380c49d/i.test(content), `${f} must not contain sp-380c49d`);
    assert.ok(!/\bsp:\d+/i.test(content), `${f} must not contain sp:\\d+`);
  }

  assert.ok(readme.includes('ADDR-021・ADDR-049・ADDR-025・ADDR-060'), 'README L61 requirements');
  assert.ok(readme.includes('IMPL-059 のとおり実装へ進む'), 'README L86 requirements');
  assert.ok(readme.includes('PLUGIN-041'), 'README L96 requirements');
  assert.ok(readme.includes('docs/design/skill-design-patterns.md「どの停止でも、理由と、未着手の意図と打ち切った意図の一覧を状態に書き、次の run の計画役がそれを読んで次の手を決める」原則'), 'README L112');
  assert.ok(!readme.includes('head_moved の出口'), 'README table must not contain head_moved row');
});

test('TC-008 PR-DEVELOPPLUGIN-035 PR-DEVELOPPLUGIN-041 PR-DEVELOPIMPLEMENT-069 PR-DEVELOPREVIEW-073 PR-DEVELOPADDRESSREVIEW-031 DevelopSkill の各再開アクションにおける原則参照と状態復帰', () => {
  const skill = read(path.join(MODEL_DIR, 'DevelopSkill.tla'));
  assert.ok(skill.includes('I_Resume_g(e) =='), 'DevelopSkill must define I_Resume_g');
  assert.ok(skill.includes('R_Resume_g(e) =='), 'DevelopSkill must define R_Resume_g');
  assert.ok(skill.includes('A_Resume_g(e) =='), 'DevelopSkill must define A_Resume_g');
  assert.ok(skill.includes('docs/design/skill-design-patterns.md 停止・再開と人間の入力「完了以外の停止からは再開できる」「再開した run は必ず計画役から始め、止まっていた間に増えたヒントを読ませる」'), 'I_Resume principle');
  assert.ok(skill.includes('docs/design/skill-design-patterns.md 停止・再開と人間の入力「再開した run は必ず計画役から始め、止まっていた間に増えたヒントを読ませる」「再開した run は、人間の入力が効く前に、前の run と同じ理由ですぐに止まらないようにする」'), 'R_Resume principle');
  assert.ok(skill.includes('docs/design/skill-design-patterns.md 停止・再開と人間の入力「再開した run は必ず計画役から始め、止まっていた間に増えたヒントを読ませる」「再開をまたいで残す値（run ごとに数える回数を再開した run では 0 から数える）」, PR-DEVELOPPLUGIN-041'), 'A_Resume principle');
  assert.ok(skill.includes('A_Resume_n(e) == SA("running", sk.stage, "none", [ad EXCEPT !.waitCnt = 0])'), 'A_Resume waitCnt reset');
});

test('TC-009 DevelopSkill.tla の principle 行と mutant patch 5 件のコンテキスト行の同期', () => {
  const skill = read(path.join(MODEL_DIR, 'DevelopSkill.tla'));
  const mutantDir = path.join(MODEL_DIR, 'mutants');
  const patches = [
    { file: 'm08_resume_position.patch', pattern: 'docs/design/skill-design-patterns.md 停止・再開と人間の入力「再開した run は必ず計画役から始め、止まっていた間に増えたヒントを読ませる」' },
    { file: 'E1_spont_resume.patch', pattern: 'docs/design/skill-design-patterns.md 停止・再開と人間の入力「完了以外の停止からは再開できる」「再開した run は必ず計画役から始め、止まっていた間に増えたヒントを読ませる」' },
    { file: 'v06_raise_plan_ignored.patch', pattern: 'docs/design/skill-design-patterns.md 停止・再開と人間の入力「再開した run は、人間の入力が効く前に、前の run と同じ理由ですぐに止まらないようにする」' },
    { file: 'J10_postmismatch_pos_post.patch', pattern: 'docs/design/skill-design-patterns.md 停止・再開と人間の入力「再開した run は必ず計画役から始め、止まっていた間に増えたヒントを読ませる」' },
    { file: 'E4_addr_auto_resume.patch', pattern: 'docs/design/skill-design-patterns.md 停止・再開と人間の入力「再開した run は必ず計画役から始め、止まっていた間に増えたヒントを読ませる」「再開をまたいで残す値（run ごとに数える回数を再開した run では 0 から数える）」, PR-DEVELOPPLUGIN-041' },
  ];

  for (const p of patches) {
    const patchContent = read(path.join(mutantDir, p.file));
    assert.ok(patchContent.includes(p.pattern), `${p.file} must include synced pattern`);
    assert.ok(skill.includes(p.pattern), `DevelopSkill.tla must include synced pattern for ${p.file}`);
  }
});

test('TC-010 mutants/EXPECTED に登録された全 59 件の mutant patch が patch -s -F 0 -p0 で clean 適用できる', () => {
  const expectedText = read(path.join(MODEL_DIR, 'mutants', 'EXPECTED'));
  const patchNames = expectedText.split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => l.split(/\s+/)[0]);

  assert.equal(patchNames.length, 59, '59 mutant patches expected in EXPECTED');

  const tmp = mkdtempSync(path.join(tmpdir(), 'mutant-apply-'));
  try {
    for (const f of readdirSync(MODEL_DIR).filter((f) => f.endsWith('.tla'))) {
      writeFileSync(path.join(tmp, f), read(path.join(MODEL_DIR, f)), 'utf8');
    }
    for (const name of patchNames) {
      const patchPath = path.join(MODEL_DIR, 'mutants', `${name}.patch`);
      execFileSync('patch', ['-s', '-F', '0', '-p0', '--dry-run', '-i', patchPath], { cwd: tmp });
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('TC-015 PR-DEVELOPADDRESSREVIEW-028 PR-DEVELOPADDRESSREVIEW-032 PR-DEVELOPADDRESSREVIEW-058 address-review の head 不一致・head 移動停止における次の手の明記', () => {
  const doc = docs()['develop-address-review'];
  assert.ok(doc.includes('新しく呼んで指摘の収集から始めることを次の手として返さなければならない'), 'PR-DEVELOPADDRESSREVIEW-028 next step');
  assert.ok(doc.includes('PR-DEVELOPADDRESSREVIEW-032 再開の前に head が動いていたとき'), 'PR-DEVELOPADDRESSREVIEW-032 header');
  assert.ok(doc.includes('（新しく呼んで指摘の収集から始める）'), 'PR-DEVELOPADDRESSREVIEW-058 table');
  const t58 = tablesOf(doc).find((t) => t.header.includes(STOP) && t.header.includes(DEFINING));
  assert.ok(t58, 'PR-DEVELOPADDRESSREVIEW-058 table found');
  const row28 = t58.rows.find((r) => r[STOP] === 'push した SHA が head でない');
  assert.ok(row28 && row28[DEFINING].includes('（新しく呼んで指摘の収集から始める）'), 'row28 next step');
  const row32 = t58.rows.find((r) => r[STOP] === 'head が動いた');
  assert.ok(row32 && row32[DEFINING].includes('（新しく呼んで指摘の収集から始める）'), 'row32 next step');
});

test('TC-016 PR-DEVELOPIMPLEMENT-078 PR-DEVELOPPLUGIN-069 PR-DEVELOPPLUGIN-070 implement の commit 引き継ぎ不一致時の拒否と plugin の完了肯定条件', () => {
  const implDoc = docs()['develop-implement'];
  const plugDoc = docs()['develop-plugin'];
  assert.ok(implDoc.includes('引き継ぐ未 push commit は記録された SHA 一覧と実際の未 push commit 一覧が一致するときに限定して不一致があれば引き継ぎを拒否して止まり'), 'IMPL-078 commit mismatch rejection');
  assert.ok(plugDoc.includes('next_args での再開を含めたその回の最後の run で結果の状態 success か degraded を返し、方針文書の「読むもの」表が解決されて読まれ、読めなかった文書が無いときにだけ、完了としなければならない'), 'PLUGIN-069 positive condition');
  const t70 = tablesOf(plugDoc).find((t) => t.header.includes('条件: 置いた形') && t.header.includes('結果'));
  assert.ok(t70, 'PLUGIN-070 table found');
  const rowView = t70.rows.find((r) => r['条件: 置いた形'] === '必ず当てる観点');
  assert.ok(rowView && rowView['結果'].includes('next_args での再開を含めたその回の最後の run で結果の状態 success か degraded を返し'), 'rowView positive condition');
  const rowDoc = t70.rows.find((r) => r['条件: 置いた形'] === '「読むもの」表の行');
  assert.ok(rowDoc && rowDoc['結果'].includes('next_args での再開を含めたその回の最後の run で結果の状態 success か degraded を返し'), 'rowDoc positive condition');
});

test('TC-017 PR-DEVELOPIMPLEMENT-033 PR-DEVELOPIMPLEMENT-034 PR-DEVELOPIMPLEMENT-049 PR-DEVELOPIMPLEMENT-078 PR-DEVELOPREVIEW-001 implement の未コミット変更・commit 所有境界と review の diff baseRef/headSha 組', () => {
  const implDoc = docs()['develop-implement'];
  const revDoc = docs()['develop-review'];
  assert.ok(implDoc.includes('呼び出しの前からの変更（開始時に固定した変更のあったパス・内容・index）を除外'), 'IMPL-033 ownership boundary');
  assert.ok(implDoc.includes('この呼び出しで作った commit（PR-DEVELOPIMPLEMENT-078 で記録と一致して引き継いだ未 push の commit を含む）に限定して push'), 'IMPL-034 push boundary');
  assert.ok(implDoc.includes('この呼び出しで作った commit（PR-DEVELOPIMPLEMENT-078 で記録と一致して引き継いだ未 push の commit を含む）の SHA を全て返さなければならない'), 'IMPL-049 return boundary');
  assert.ok(implDoc.includes('開始時の HEAD・開始時に変更のあったパスとその内容・index'), 'IMPL-078 recorded state');
  const t01 = tablesOf(revDoc).find((t) => t.header.includes('mode') && t.header.includes('目標として固定する対象の版'));
  assert.ok(t01, 'REV-001 table found');
  const diffRow = t01.rows.find((r) => r['mode'] === 'diff');
  assert.ok(diffRow && diffRow['目標として固定する対象の版'] === '比較元の完全な SHA（baseRef）と比較先の完全な SHA（headSha）の組（方針の版 policyRef とは別に固定する）', 'REV-001 diff pinned version');
});

