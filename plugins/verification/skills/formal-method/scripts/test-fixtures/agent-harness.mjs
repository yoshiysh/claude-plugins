// 担当の代わりの harness。Workflow の代わりに、call.args_path の workers の行ごとに役として振る舞う:
// 入口（<run_dir>/formal-method-cli.mjs）で claim → <query_cmd> <task_id> → attempt の領域に成果物と返り値を書く → submit_cmd → 落ちたら直して同じ submit →
// 受理の応答の next の task を続けて果たし、next が done: true なら終える（終わりの claim は流さない。cli-contract.md「依頼と応答」）。
// 書く形は artifact-formats.md の「担当の成果物」「担当の返り値」「claim の Task」「作業記録」だけ。task から読むのは Task と TaskContext の欄と、
// query が返した資料（input_refs）だけ。最後に司令塔の代わりに close を呼ぶ（Workflow の返り値は {agents, tokens}）。
// 受け取った task が契約の形（claim の Task の欄、役ごとの context）に合わなければ、その違反で失敗する。
// #264 の下書きの形: CLI が契約で渡す印を見て、役ごとに下書きの形か今の形かを選ぶ（単位を 1 つずつ入れる間、両方の CLI で同じテストを流すため）。
//   model-author: context.model_property_id_prefix（モデルごとの task。対応表は骨組みの view への書き込みと extra_rows）
//   partition-author: context.candidates[].edges（PartitionsDraft）
//   plan-author: context.target_ids が空でない（PlanDraft・MutationsDraft）
//   extractor: context.external_references（inventory に scanned を書かない）
//   返り値と作業記録: return_schemas のその役の形が task_id を持たない（task_id・unit_id・perspective と作業記録の文脈の欄を書かない）。
//     確認役は、形が result を持たなければ items を書く
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, mkdtempSync, chmodSync, linkSync, unlinkSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { cli, expectOk, runShell } from './cli-runner.mjs';
import { close as closeInProcess, workerCall } from '../lib/client.mjs';
import { deriveGraph, crossingEdges } from './decomposition-check.mjs';

const sha = (s) => `sha256:${createHash('sha256').update(s).digest('hex')}`;
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

// Ref は全て run の領域からの相対 path（artifact-formats「共通の型」）。
export const runRef = (task, name) => relative(task.context.run_dir, join(task.attempt_dir, name));

// 行: 末尾の \n の後の空の要素は数えない。空のファイルは 0 行（artifact-formats「共通の型」）。
export function linesOf(text) {
  if (text === '') return [];
  const ls = text.split('\n');
  if (ls[ls.length - 1] === '') ls.pop();
  return ls;
}

// ---- 受け取った task の契約の検査（claim の Task の欄と、役と context の表） ----
const TASK_KEYS = ['attempt_dir', 'context', 'effort', 'instructions', 'model', 'result_path', 'role', 'task_id'];
// claim の応答の最上位（done: false のとき）。返り値の形は役ごとに 1 度、命令と scratch_dir は worker で 1 つ
// command は CLI の出力だけが持つ（client の関数で同じ process から流すと無い）ので、比べない
const CLAIM_KEYS = ['document_rules', 'done', 'ok', 'query_cmd', 'return_schemas', 'scratch_dir', 'shared_inputs', 'submit_cmd', 'tasks'];
const NEXT_KEYS = ['done', 'return_schemas', 'shared_inputs', 'tasks'];
// claim の応答（top）か submit の next（next）の、task の外の欄の検査。schemas はこの worker が受け取った返り値の形（役 → schema）
export function claimViolations(res, { runDir, callId, worker, kind = 'claim', schemas = null }) {
  const v = [];
  const at = `${worker} の ${kind}`;
  const keys = Object.keys(res).filter((k) => k !== 'command').sort().join();
  if (keys !== (kind === 'claim' ? CLAIM_KEYS : NEXT_KEYS).join()) v.push(`${at} の欄 ${keys}`);
  const rs = res.return_schemas;
  if (!rs || typeof rs !== 'object') return [...v, `${at} の return_schemas が無い`];
  const roles = [...new Set((res.tasks ?? []).map((x) => x.role))];
  if (Object.keys(rs).sort().join() !== [...roles].sort().join()) v.push(`${at} の return_schemas の役 ${Object.keys(rs).join()} が tasks の役 ${roles.join()} と違う`);
  for (const [r, sc] of Object.entries(rs)) {
    if (!sc || sc.type !== 'object') v.push(`${at} の return_schemas.${r}`);
    if (schemas) schemas[r] = sc;
  }
  if (kind === 'claim') {
    if (!String(res.submit_cmd).includes(' submit') || !String(res.query_cmd).includes(' query')) v.push(`${at} の submit_cmd・query_cmd`);
    if (res.scratch_dir !== join(runDir, 'attempts', `${callId}-${worker}`) || !existsSync(res.scratch_dir)) v.push(`${at} の scratch_dir ${res.scratch_dir}`);
  }
  return v;
}
const ROLE_PERSPECTIVE = {
  extractor: [null], 'model-author': [null], 'plan-author': [null], 'partition-author': [null], 'cause-analyst': [null],
  'extraction-reviewer': ['extraction'], 'assurance-reviewer': ['nonformal'], 'fidelity-reviewer': ['fidelity'], 'composition-reviewer': ['composition'],
};
export function taskViolations(task, runDir, memory = null, worker = null) {
  const v = [];
  const c = task.context;
  if (!c) return [`${task.task_id}: context が無い`];
  if (c.run_dir !== runDir) v.push(`${task.task_id}: context.run_dir が run の領域と違う`);
  const keys = Object.keys(task).sort();
  if (keys.join() !== TASK_KEYS.join()) v.push(`${task.task_id}: claim の Task の欄 ${keys.join()}`);
  const CONTEXT_KEYS = ['candidates', 'model_id', 'perspective', 'property_ids', 'run_dir', 'stage', 'subject', 'target_id', 'unit_id'];
  // #264 で足す欄（SP-264-012・021・026、DD-18）。単位ごとに 1 つずつ増えるので、今の欄 ⊆ 欄 ⊆ 今の欄 ∪ 足す欄 で照らす
  const ADDED_CONTEXT_KEYS = ['external_references', 'model_property_id_prefix', 'target_ids'];
  const ck = Object.keys(c);
  if (!CONTEXT_KEYS.every((k) => ck.includes(k)) || !ck.every((k) => CONTEXT_KEYS.includes(k) || ADDED_CONTEXT_KEYS.includes(k))) v.push(`${task.task_id}: context の欄 ${ck.sort().join()}（資料は query で引く）`);
  if ('model_property_id_prefix' in c) {
    const want = task.role === 'model-author' ? `${c.model_id}.` : null;
    if (c.model_property_id_prefix !== want || (task.role === 'model-author' && !c.model_id)) v.push(`${task.task_id}: model_property_id_prefix ${c.model_property_id_prefix}（model-author は <model_id>.、他は null）`);
  }
  if ('target_ids' in c && (!Array.isArray(c.target_ids) || (task.role === 'plan-author') !== (c.target_ids.length > 0))) v.push(`${task.task_id}: target_ids は plan-author だけ空でない`);
  if ('external_references' in c && (!Array.isArray(c.external_references) || (task.role !== 'extractor' && c.external_references.length > 0))) v.push(`${task.task_id}: external_references は extractor の task だけが持つ`);
  const ins = task.instructions ?? [];
  // 役の指示・役の分の義務（作成役か確認役）・役の型の抜粋・run の領域の文書の一般規約の写しの 4 つ（artifact-formats.md「claim の Task」）
  const cls = ['extractor', 'model-author', 'partition-author', 'plan-author'].includes(task.role) ? 'author' : 'confirmer';
  if (ins.length !== 4 || !ins[0].endsWith(`/agents/${task.role}.md`) || !ins[1].endsWith(`/references/obligations/${cls}.md`) || !ins[2].endsWith(`/references/types/${task.role}.md`)
    || !/^document-rules\/[0-9a-f]{64}\.md$/.test(relative(runDir, ins[3])) || !ins.every((x) => existsSync(x))) v.push(`${task.task_id}: instructions ${JSON.stringify(ins)}`);
  if (task.attempt_dir !== join(runDir, 'attempts', task.task_id) || task.result_path !== join(task.attempt_dir, 'return.json')) v.push(`${task.task_id}: attempt_dir・result_path`);
  if (!existsSync(task.attempt_dir)) v.push(`${task.task_id}: attempt の領域が無い`);
  // workers の行の role は、その worker が持つ担当の役を出てくる順に + でつないだもの（分割と計画を 1 体が担うとき 2 つ）
  if (worker && (!worker.role.split('+').includes(task.role) || worker.model !== task.model || worker.effort !== task.effort)) v.push(`${task.task_id}: workers の行と role・model・effort が違う`);
  if (!(ROLE_PERSPECTIVE[task.role] ?? []).includes(c.perspective)) v.push(`${task.task_id}: ${task.role} の perspective ${c.perspective}`);
  const expectUnit = {
    extraction: () => `extraction-${c.target_id}`, nonformal: () => `nonformal-${c.property_ids[0]}`,
    fidelity: () => `fidelity-${c.model_id}`, composition: () => 'composition',
  };
  if (c.perspective) { if (c.unit_id !== expectUnit[c.perspective]()) v.push(`${task.task_id}: unit_id ${c.unit_id}`); }
  else if (task.role === 'cause-analyst') {
    const s = c.subject;
    // 組合せは cause-combination-<model_id>-<n>（n はその組の Combinations.cells の中の 0 から数えた位置。artifact-formats「役と context」）。
    // cells は状態×出来事の宣言順（状態ごとに出来事の順）なので、harness が書いたモデルの state_machine から位置を導く
    let u = null;
    if (s?.kind === 'combination') {
      const sm = (memory?.models ?? []).filter((m) => m.id === s.model_id).map((m) => readJson(join(m.task.attempt_dir, m.file)).state_machine).at(-1);
      const n = sm ? sm.states.indexOf(s.state) * sm.events.length + sm.events.indexOf(s.event) : -1;
      u = sm && sm.states.includes(s.state) && sm.events.includes(s.event) ? `cause-combination-${s.model_id}-${n}` : '<組合せがモデルに無い>';
    } else if (s) u = `cause-${s.kind}-${s.id}`;
    if (!s || c.unit_id !== u) v.push(`${task.task_id}: cause-analyst の subject・unit_id ${c.unit_id}（規則では ${u}）`);
  } else if (c.unit_id !== null) v.push(`${task.task_id}: ${task.role} の unit_id は null`);
  if (task.role === 'extractor' && !c.target_id) v.push(`${task.task_id}: extractor の target_id`);
  if ((task.role === 'partition-author') !== (c.candidates.length > 0)) v.push(`${task.task_id}: candidates は partition-author だけ空でない`);
  if (!['受付', '洗い出し', 'モデル化', '計画', '実行', '確認', '集約'].includes(c.stage)) v.push(`${task.task_id}: context.stage`);
  return v;
}

// ---- 正準のシナリオ（1 ファイル・1 目標・性質ごとに 1 検査・1 sanity・1 変異） ----
export function defaultScenario(over = {}) {
  return {
    goalIds: ['G1'],
    properties: [{ id: 'P1', file: 'spec.md', line: 2, statement: 'x は常に 0 以上である', query: { result: 'unsat' }, sanity: { result: 'sat' }, mutation: { result: 'sat' } }],
    toolTimeLimit: 30,
    reviews: {},            // perspective → '成り立つ' | '成り立たない' | '確認できず'
    judgmentAnswers: {},    // 判断を要する項目の id か kind → '成り立つ' | '成り立たない' | '確認できず' | null（答えない）。既定 成り立つ。忠実さの確認役が答える
    holdCalls: {},          // role → n。その役の worker は、最初の n 回の呼び出しで担当（束）を取って資料を引いたまま提出しない
    cause: { cause: '対象が性質を満たさない', grounds: 'モデルは出所を正しく表し、対象が性質に反する', questions: [] },
    returns: {},            // role → 'missing' | 'cannot_proceed' | 'bad_shape' | 'error'
    returnsByPerspective: {}, // perspective → 'missing' | 'bad_shape'（returns より先に見る）
    mapping: {},            // property id → relation（既定 形式化）
    claim: null,            // null | 'match' | 'mismatch'（AC-12: z3 が Rust より速いという主張と、比べる条件）
    partition: null,        // (context.candidates, put, { graph, crossing, round }) → PartitionsFile の部分（AC-07）
    // 作成役の成果物を巡（同じ役の何回目の task か。1 から）ごとに変える口。計画の欠陥・修正の巡のケースに使う
    editModelQuery: null,   // (text, { round, mp, kind: 'property' | 'sanity' }) → .smt2 の文字列（変異の .smt2 は計画作成役が書く）
    editPlan: null,         // (plan, { round, pairs, mref, put, targetRef }) → PlanFile
    editMutations: null,    // (mutations, { round, pairs, mref, put }) → MutationsFile
    editStateMachine: null, // (state_machine, { round, model_id }) → ModelFile.state_machine（モデル作成役の巡ごと）
    // 作成役が返す問い（役 → [Question]）。あればその役は needs_answer で返し、AuthorReturn.blocked_by_question に依存する性質の id を挙げる
    // （artifact-formats「AuthorReturn.blocked_by_question」: 抽出役は inventory の blocked_by_question が空でない性質、
    // モデル作成役・計画作成役は Question.affected のうち context.property_ids にあるもの）。
    // 問いに依存する性質（Question.affected の inventory の性質）は、挙げた段より後の段から外す（architecture「段と処理の順序」）:
    // 抽出役なら inventory の blocked_by_question に載せ、モデルと計画に入れない。モデル作成役・計画作成役なら計画に入れない
    questionsBy: {},
    blockedAs: {},          // 役 → 'question_ids'（契約に反して問いの id を blocked_by_question に入れる。形の違いのケース）
    allowDuplicatePlanIds: false, // true なら計画の id の重複を許す（一意の違反のケース）
    modelPropPrefix: '',    // モデルの性質の id = 接頭辞 + inventory の性質の id
    models: null,           // [{ id, propertyIds, stateMachine? }]（モデルを 2 つ以上にするとき）
    stopAfterSubmits: {},   // 役 → n: その役の提出が n 回になったら、done でなくても流し直さずに worker を終える（閉じた時点の受理の経路）
    scanDropLast: false,    // true なら抽出役は依頼の範囲の最後の行を scanned で覆わない（網羅の照合が落ちるケース）
    extraElements: [],      // [{ file, line }]: どの性質にも結ばれない要素（id は E-X<line>）を inventory に足す
    // #264 の下書きの形の口（CLI が下書きの形を求めたときだけ使う）
    editModel: null,        // (ModelFile, { round, model_id }) → ModelFile（モデル作成役の巡ごと）
    editMappingDraft: null, // (MappingDraft, { round, model_id, skeleton }) → MappingDraft
    editPlanDraft: null,    // (PlanDraft, ctx) → PlanDraft（ctx は editPlan と同じ。model_id を持つ）
    editMutationsDraft: null, // (MutationsDraft, ctx) → MutationsDraft
    reviewItems: {},        // perspective → ReviewReturn.items（既定は観点を 1 つの項目にした記録）
    ...over,
  };
}

function directives(d = {}) {
  return Object.entries(d).map(([k, v]) => `; fake-${k === 'sleepMs' ? 'sleep-ms' : k}: ${v}`).join('\n');
}
export function smtQuery(label, d, body = null) {
  return `${directives(d)}\n; ${label}\n${body ?? '(declare-const x Int)\n(assert (and (>= x (- 8)) (<= x 8)))\n(assert (not (>= (* x x) 0)))'}\n(check-sat)\n`;
}

// 性質の query の節（artifact-formats「model」の clauses と :named の規則）。1 行に 1 つのトップレベルの assert を、現れた順に
// p.roles（既定: 最後を goal、他を rule）の役で名付ける。名前は <mp>-<役の頭文字><番号>。rule と goal（と作成役の仮定の前提）の source_ids は p.clauseSources（既定 [E-<p.id>]）。
// 偽の z3 の指示 fake-core（既定: rule と goal の名前。p.fakeCore で変える）を先頭に置き、静的な確認の query（節を切り取ったもの）の答えを決める。
// mutate なら最初の rule の項を (not …) に変える（変異は名前を保ち、規則の節を変える。agents/plan-author.md）。
export function namedClauses(text, mp, p, { mutate = false } = {}) {
  const lines = text.split('\n');
  const at = lines.map((l, i) => (/^\(assert .*\)$/.test(l) && !l.includes(':named') ? i : -1)).filter((i) => i >= 0);
  const roles = p.roles ?? at.map((_, k) => (k === at.length - 1 ? 'goal' : 'rule'));
  const clauses = [];
  let mutated = false;
  at.forEach((i, k) => {
    const role = roles[k] ?? 'rule';
    const name = `${mp}-${role[0]}${k + 1}`;
    let term = lines[i].slice('(assert '.length, -1);
    if (mutate && role === 'rule' && !mutated) { term = `(not ${term})`; mutated = true; }
    lines[i] = `(assert (! ${term} :named ${name}))`;
    const basis = role === 'premise' ? (p.premiseBasis?.[name] ?? '作成役の仮定') : null;
    // 作成役の仮定の前提は、どの要素についての仮定かを出所で示す（既定は規則と同じ。p.premiseSources で変える）。他の前提は出所を持たない
    const sources = role !== 'premise' ? (p.clauseSources ?? [`E-${p.id}`]) : basis === '作成役の仮定' ? (p.premiseSources ?? p.clauseSources ?? [`E-${p.id}`]) : [];
    clauses.push({ name, role, source_ids: sources, basis, external_dependency_id: basis === '外部の依存' ? (p.externalDependencyId ?? 'X1') : null, note: `harness の ${role} の節` });
  });
  const core = p.fakeCore ? p.fakeCore(clauses) : clauses.filter((c) => c.role !== 'premise').map((c) => c.name);
  // p.fakeAnswers(clauses) → [[残す節の名前の並び, 答え]]: 切り取った実行ごとの答え（偽の z3 の fake-answers。core より先に見る）
  const answers = p.fakeAnswers && !mutate ? Object.fromEntries(p.fakeAnswers(clauses).map(([ns, a]) => [[...ns].sort().join(' '), a])) : null;
  const head = (core === null ? '' : `; fake-core: ${core.join(' ')}\n`) + (answers ? `; fake-answers: ${JSON.stringify(answers)}\n` : '');
  return { text: head + lines.join('\n'), clauses };
}

// 担当と同じく、query の資料（task.query_inputs）が指すファイルだけを読む口。資料に無い ref は読まずに null を返し、違反に挙げる
// （harness が run の領域を直接読むと、CLI が要る資料を渡さない退行を見逃す）。ディレクトリの資料の下と、畳んだ資料の entry も資料に数える
function materialReader(task, memory) {
  const files = new Map(worklogInputs(task.query_inputs).map((x) => [x.ref, null]));
  for (const x of task.query_inputs ?? []) if (x.hash && !x.entries) files.set(x.ref, x.path);
  return (ref) => {
    if (!files.has(ref)) { memory.violations.push(`${task.task_id}（${task.role}）: 要る資料 ${ref} が query の資料に無い`); return null; }
    const path = files.get(ref) ?? join(task.context.run_dir, ref);
    return existsSync(path) ? readFileSync(path, 'utf8') : null;
  };
}

// 作業記録の下書き（agent-obligations.md「作業記録」）: 読んだファイルの ref だけを書き、指紋と document_rules は書かない（submit の照合で CLI が補う）。
// 担当と同じく、query の資料を全て読んだものとする。ディレクトリの資料（hash の無い資料、畳んだ資料の / で終わる entry）はその下のファイルごとに、
// 畳んだ資料は entry ごとに <ref><entry> で 1 要素にする
function filesUnder(path, ref) {
  const out = [];
  for (const name of readdirSync(path).sort()) {
    const st = statSync(join(path, name));
    if (st.isDirectory()) out.push(...filesUnder(join(path, name), `${ref}${name}/`));
    else if (st.isFile()) out.push(`${ref}${name}`);
  }
  return out;
}
export function worklogInputs(queryInputs) {
  const one = (ref, path) => {
    let dir;
    try { dir = statSync(path).isDirectory(); } catch { return []; }
    return dir ? filesUnder(path, `${ref.replace(/\/+$/, '')}/`).map((r) => ({ ref: r })) : [{ ref }];
  };
  return (queryInputs ?? []).flatMap((x) => {
    if (x.entries) return x.entries.flatMap((e) => one(`${x.ref}${e.entry}`, `${x.path}${e.entry}`));
    if (x.hash) return [{ ref: x.ref, ...(x.spans ? { spans: x.spans.map((span) => ({ span })) } : {}) }];
    return one(x.ref, x.path);
  });
}
// draft: 下書きの形（SP-264-029）。schema・role・task_id・stage・target は CLI が complete-return で入れるので書かない
function worklog(task, draft = false) {
  const inputs = worklogInputs(task.query_inputs);
  return {
    ...(draft ? {} : { schema: 'formal-method.worklog/1', role: task.role, task_id: task.task_id, stage: task.context.stage, target: task.context.target_id ?? 'T1' }),
    inputs, actions: `${task.role} として与えられた資料を読んだ。`, results: '返り値を書いた。',
    grounds: 'テストの harness が決めた値である。', failures: [], unconfirmed: [], unreadable_inputs: [],
  };
}

const write = (task, name, value) => {
  mkdirSync(task.attempt_dir, { recursive: true });
  writeFileSync(join(task.attempt_dir, name), typeof value === 'string' ? value : JSON.stringify(value, null, 2));
};

const unk = { status: '取得できず', reason: 'harness は見積りを持たない' };
const basis = (p, over = {}) => ({ property_ids: [p.id], assumptions: ['x は -8 以上 8 以下'], scope: 'x ∈ [-8, 8]', assurance: '範囲を限った検査', judgment_rules: 'SP-FORMALMETHOD-011', ...over });
function candidate(role, name, p, s) {
  const c = { role, name, handles: '整数の算術の性質', assurance: '範囲を限った検査', environment: 'ローカル', checkable_scope: 'x の有限の領域',
    estimates: { setup: unk, execution: unk, resources: unk }, available: true, reason: '比較の候補', comparison_basis: basis(p), performance_claim: null };
  if (name === 'z3' && s.claim) {
    c.performance_claim = { better_than: 'Rust', metric: 'execution' };
    if (s.claim === 'mismatch') c.comparison_basis = basis(p, { scope: 'x ∈ [-2, 2]（範囲を減らした）', assurance: '範囲を限った検査（境界を狭めた）' });
  }
  return c;
}

// モデルの性質の id（inventory の id と違えられる。run の全てのモデルを通して一意になるよう、inventory の id から作る）
const mpid = (s, p) => `${s.modelPropPrefix}${p.id}`;
// モデルの並び。scenario.models が無ければ、形式化できる性質を全て持つ 1 つのモデル M1。
// roles のどれかが返した問いが、性質 pid に依存するか（Question.affected で結び付ける）
const questionsOf = (s, roles, pid) => roles.flatMap((r) => s.questionsBy[r] ?? []).filter((q) => q.affected.includes(pid)).map((q) => q.id);
function modelsOf(s) {
  const inModel = s.properties.filter((p) => questionsOf(s, ['extractor'], p.id).length === 0);
  const formal = inModel.filter((p) => p.formalizable !== false);
  if (!s.models) return [{ id: 'M1', props: formal, stateMachine: s.stateMachine, behavior: s.behavior, omittedEdges: s.omittedEdges, mappingProps: inModel }];
  return s.models.map((m, i) => ({ ...m, props: formal.filter((p) => m.propertyIds.includes(p.id)), mappingProps: i === 0 ? inModel.filter((p) => p.formalizable === false || m.propertyIds.includes(p.id)) : formal.filter((p) => m.propertyIds.includes(p.id)) }));
}

// 下書きの形のモデル作成役の 1 つのモデル（SP-264-012）。性質の組は CLI の partition-models が決め、context.property_ids で渡る。
// scenario.models の要素は、性質の組が重なるものを状態遷移などの中身の出所に使う（id は CLI が決めるので使わない）。
// scenario.models が無ければ、scenario の最初の形式化できる性質を持つモデルに scenario.stateMachine などを置く（今の形の 1 つのモデルと同じ中身）
function modelForTask(s, c) {
  const ids = new Set(c.property_ids);
  const inModel = s.properties.filter((p) => ids.has(p.id));
  const formal = inModel.filter((p) => p.formalizable !== false);
  const spec = (s.models ?? []).find((m) => m.propertyIds.some((id) => ids.has(id)));
  const first = !s.models && formal.some((p) => p.id === s.properties.find((x) => x.formalizable !== false)?.id);
  const pick = (k) => (spec ? spec[k] : first ? s[k] : undefined);
  return { id: c.model_id, props: formal, mappingProps: inModel, stateMachine: pick('stateMachine'), behavior: pick('behavior'), omittedEdges: pick('omittedEdges') };
}
// 下書きの対応表（MappingDraft。SP-264-025）: 骨組み（views/mapping-rows-<model_id>.json。DD-16）の行ごとに model_element と理由を書き、
// 形式化できる性質の行だけ relation を書く。目標を出所にする行は extra_rows。骨組みは query の資料から読む（渡されなければ違反に挙げる）
function mappingDraft(task, s, memory, m, { el, relOf, reasonOf, goalRows, round }) {
  const ref = `views/mapping-rows-${m.id}.json`;
  if (!(task.context.input_refs ?? []).some((x) => x.ref === ref)) memory.violations.push(`${task.task_id}（model-author）: 対応表の骨組み ${ref} が task の資料に無い`);
  const skeleton = JSON.parse(materialReader(task, memory)(ref) ?? '{"rows":[]}');
  const byId = new Map(s.properties.map((p) => [p.id, p]));
  const rows = skeleton.rows.filter((r) => byId.get(r.property_id)?.mappingLocation !== false).map((r) => {
    const p = byId.get(r.property_id);
    if (p.formalizable === false) return { row_id: r.row_id, model_element: el(p), reason: r.reason ?? null };
    return { row_id: r.row_id, model_element: el(p), relation: relOf(p), reason: reasonOf(relOf(p)) };
  });
  const d = { schema: 'formal-method.mapping-draft/1', rows, extra_rows: m.mappingProps.flatMap((p) => goalRows(p)) };
  return s.editMappingDraft ? s.editMappingDraft(d, { round, model_id: m.id, skeleton }) : d;
}
// 各モデルの最後の書き込み（モデル作成役の修正の巡で同じモデルを書き直すと後ろに足す）
const latestModels = (memory) => [...new Set(memory.models.map((m) => m.id))].map((id) => memory.models.filter((x) => x.id === id).at(-1));

const ROLE = {
  extractor(task, s) {
    const req = readJson(join(task.context.run_dir, 'request.json'));
    const target = req.targets.find((t) => t.id === task.context.target_id);
    // 写しは作らないので、元のファイル（fixed.files の abs_path）を読む
    const snap = (f) => target.fixed.files.find((x) => x.path === f).abs_path;
    // 覆うのは依頼の範囲（scope.include）だけ（run.mjs の requestScopeOf と同じ決め方）。範囲の外のファイル・行は scanned に入れない
    const include = req.scope?.include ?? [];
    const locs = include.filter((p) => p.kind === 'location' && p.target_id === target.id);
    const whole = include.some((p) => p.kind === 'target' && p.id === target.id) || locs.length === 0;
    const scopeOf = (file) => {
      if (whole) return null;
      const mine = locs.filter((p) => p.file === file);
      if (!mine.length) return undefined;
      return mine.some((p) => !p.span) ? null : mine.map((p) => p.span);
    };
    const scanned = target.fixed.files.filter((f) => scopeOf(f.path) !== undefined).flatMap((f) => {
      if (!f.text || f.content_hash === 'unreadable') return [{ file: f.path, span: null, status: 'unread', reason: 'テキストでない' }];
      const n = linesOf(readFileSync(snap(f.path), 'utf8')).length;
      const spans = scopeOf(f.path) ?? (n === 0 ? [] : [`L1-L${n}`]);
      if (spans.length === 0) return [{ file: f.path, span: null, status: 'read', reason: null }];
      const out = spans.map((span) => ({ file: f.path, span, status: 'read', reason: null }));
      if (s.scanDropLast) {
        const last = out[out.length - 1];
        const [, a, b] = last.span.match(/^L(\d+)-L(\d+)$/).map(Number);
        if (a === b) out.pop(); else last.span = `L${a}-L${b - 1}`;
      }
      return out;
    });
    const elements = [];
    const properties = [];
    for (const p of s.properties) {
      const line = linesOf(readFileSync(snap(p.file), 'utf8'))[p.line - 1];
      elements.push({ id: `E-${p.id}`, kind: 'requirement', source: { target_id: target.id, file: p.file, span: `L${p.line}-L${p.line}`, ...(s.omitQuoteHash ? {} : { quote_hash: sha(line) }) }, text: line });
      // p.sources: 出所に引く性質の要素（既定は自分の行の要素だけ）。出所を共有する性質は partition-models で同じモデルになる（SP-264-010）
      properties.push({ id: p.id, source_ids: (p.sources ?? [p.id]).map((id) => `E-${id}`), statement: p.statement, formalizable: p.formalizable !== false,
        nonformal_reason: p.formalizable === false ? '数で表せない' : null, nonformal_method: p.formalizable === false ? '文書の読み合わせ' : null,
        assumptions: [], scope: '対象の全体', blocked_by_question: [...(p.blocked_by_question ?? []), ...questionsOf(s, ['extractor'], p.id)] });
    }
    for (const x of s.extraElements ?? []) {
      const line = linesOf(readFileSync(snap(x.file), 'utf8'))[x.line - 1];
      elements.push({ id: `E-X${x.line}`, kind: 'requirement', source: { target_id: target.id, file: x.file, span: `L${x.line}-L${x.line}`, quote_hash: sha(line) }, text: line });
    }
    // 下書きの形（SP-264-026）: scanned は CLI が extract-skeleton で埋めるので書かない
    const draft = Array.isArray(task.context.external_references);
    write(task, 'inventory.json', { schema: 'formal-method.inventory/1', target_id: target.id, content_hash: target.fixed.content_hash, ...(draft ? {} : { scanned }), elements, properties, external_dependencies: s.externalDependencies ?? [] });
    return [{ kind: 'inventory', ref: runRef(task, 'inventory.json') }];
  },
  'model-author'(task, s, memory) {
    const outputs = [];
    const round = memory.rounds[task.role];
    const c = task.context;
    // 下書きの形（SP-264-012・025）: task はモデルごとに 1 つ。model_id と性質は context から、対応表の location の行は骨組みの view から
    const draft = typeof c.model_property_id_prefix === 'string';
    if (!draft) memory.models = [];
    const ms = draft ? [modelForTask(s, c)] : modelsOf(s);
    for (const m of ms) {
      const mp = (p) => (draft ? `${c.model_property_id_prefix}${s.modelPropPrefix}${p.id}` : mpid(s, p));
      const q = (text, id, kind) => (s.editModelQuery ? s.editModelQuery(text, { round, mp: id, kind, model_id: m.id }) : text);
      for (const p of m.props) {
        write(task, `${mp(p)}.smt2`, q(namedClauses(smtQuery(`property ${mp(p)}`, p.query, p.smt), mp(p), p).text, mp(p), 'property'));
        write(task, `${mp(p)}-sanity.smt2`, q(smtQuery(`sanity ${mp(p)}`, p.sanity ?? { result: 'sat' }, p.smt), mp(p), 'sanity'));
      }
      const file = `model-${m.id}.json`;
      const modelData = {
        schema: 'formal-method.model/2', model_id: m.id, adapter_id: 'z3',
        covers: { targets: ['T1'], states: m.stateMachine?.states ?? [], events: m.stateMachine?.events ?? [], assumptions: [{ id: 'A1', text: 'x は -8 以上 8 以下の整数' }], constraints: [], excluded: [] },
        state_machine: m.stateMachine ? (s.editStateMachine ? s.editStateMachine(structuredClone(m.stateMachine), { round, model_id: m.id }) : m.stateMachine) : null, no_state_machine_reason: m.stateMachine ? null : '対象は状態遷移を持たない', io_contracts: [],
        properties: m.props.map((p) => ({ id: mp(p), inventory_property_ids: [p.id], query_ref: runRef(task, `${mp(p)}.smt2`), expected: 'unsat',
          assurance: { kind: '範囲を限った検査', scope: 'x は -8 以上 8 以下の整数', bounds: [{ item: 'x', bound: '-8..8' }], scope_variables: p.scopeVariables ?? (p.smt ? [] : ['x']), fairness_assumptions: [] },
          clauses: p.clauses ?? namedClauses(smtQuery('', p.query, p.smt), mp(p), p).clauses,
          sanity: [{ kind: 'assumptions_consistent', query_ref: runRef(task, `${mp(p)}-sanity.smt2`) }] })),
        behavior: m.behavior ?? { applicable: false, reason: '状態遷移を持たない' }, source_diagrams: [], omitted_edges: m.omittedEdges ?? [],
      };
      write(task, file, s.editModel ? s.editModel(modelData, { round, model_id: m.id }) : modelData);
      const mapFile = `mapping-${m.id}.json`;
      const relOf = (p) => s.mapping[p.id] ?? (p.formalizable === false ? '形式検証でない確認' : '形式化');
      const reasonOf = (relation) => (relation === '対応なし' || relation === '範囲外' ? 'harness が対応を付けなかった' : null);
      const el = (p) => (p.formalizable === false ? p.id : mp(p));
      // 目標を出所にする行（今の形では行に含め、下書きの形では extra_rows。SP-264-025）
      const goalRows = (p) => s.goalIds.map((g) => ({ source: { kind: 'goal', id: g }, property_id: p.id, model_element: el(p), relation: relOf(p), reason: reasonOf(relOf(p)) }));
      if (draft) write(task, mapFile, mappingDraft(task, s, memory, m, { el, relOf, reasonOf, goalRows, round }));
      else write(task, mapFile, { schema: 'formal-method.mapping/1', model_id: m.id, rows: (m.mappingProps ?? m.props).flatMap((p) => {
        const relation = relOf(p);
        const reason = reasonOf(relation);
        return [
          ...goalRows(p),
          // p.mappingLocation === false なら、出所の行の対応を書かない（性質の出所が対応表にも節にも無い場面）
          ...(p.mappingLocation === false ? [] : [{ source: { kind: 'location', target_id: 'T1', file: p.file, span: `L${p.line}-L${p.line}` }, property_id: p.id, model_element: el(p), relation, reason }]),
        ];
      }) });
      memory.models.push({ id: m.id, file, task, props: m.props, mp: Object.fromEntries(m.props.map((p) => [p.id, mp(p)])) });
      outputs.push({ kind: 'model', ref: runRef(task, file) }, { kind: 'mapping', ref: runRef(task, mapFile) });
    }
    return outputs;
  },
  'partition-author'(task, s, memory) {
    const cands = task.context.candidates;
    // 下書きの形（SP-264-023）: 候補が他の候補への辺（edges）を持つ。adopted・parts・境界の producer・consumer・shared_symbols は CLI が決める
    const draft = cands.length > 0 && cands.every((x) => Array.isArray(x.edges));
    // 部分を跨ぐ辺は、自分の書いたモデルから依存グラフの導出の規則で求める（Boundary.edge_id はその辺の id）
    // 担当と同じく、query が渡した資料だけを読む（モデルも性質の query も。渡されなければ違反に挙げ、読まない）
    const run = task.context.run_dir;
    const read = materialReader(task, memory);
    const latest = latestModels(memory);
    const models = latest.map((m) => { const ref = relative(run, join(m.task.attempt_dir, m.file)); return { model: JSON.parse(read(ref) ?? 'null'), ref }; }).filter((x) => x.model);
    const graph = deriveGraph(models, read);
    const put = (name, body) => { write(task, name, body); return runRef(task, name); };
    // 候補の節点の id（var:<model_id>/… と tr:<model_id>/…）から、分割するモデルの id を引く。候補は全てのモデルの依存グラフから出るので、
    // 分けられる（候補を 2 つ以上持つ）モデルを選ぶ。無ければ最初の候補のモデルにする（モデルの順に依存しない）
    const modelOfNode = (n) => n.match(/^(?:var|tr):([^/]+)\//)?.[1];
    const candModels = cands.map((x) => x.nodes.map(modelOfNode).find(Boolean)).filter(Boolean);
    const modelId = candModels.find((id) => candModels.filter((y) => y === id).length >= 2) ?? candModels[0] ?? null;
    const mpIn = (pid) => latest.find((m) => m.id === modelId)?.mp[pid] ?? pid;
    const extra = s.partition ? s.partition(cands, put, { graph, crossing: (parts, mid) => crossingEdges(graph, parts, mid), round: memory.rounds[task.role], modelId, mp: mpIn, draft }) : null;
    memory.partition = extra;
    if (draft) {
      const adopted = new Set((extra?.parts ?? []).map((x) => x.id));
      write(task, 'partitions.json', {
        schema: 'formal-method.partitions-draft/1',
        decisions: cands.map((x) => ({ candidate_id: x.id, adopted: adopted.has(x.id), reason: adopted.has(x.id) ? '依存の弱い境界で分ける' : '分けない' })),
        reason: extra ? '部分ごとに検証する' : '分けずに検証する',
        boundaries: (extra?.boundaries ?? []).map(({ edge_id, assumption, guarantee, assumption_basis, responsible }) => ({ edge_id, assumption, guarantee, assumption_basis, responsible })),
        contracts: extra?.contracts ?? [], composition_conditions: extra?.composition_conditions ?? [],
      });
      return [{ kind: 'partitions', ref: runRef(task, 'partitions.json') }];
    }
    write(task, 'partitions.json', {
      schema: 'formal-method.partitions/1',
      decisions: cands.map((c) => ({ candidate_id: c.id, adopted: Boolean(extra), reason: extra ? '依存の弱い境界で分ける' : '分けない' })),
      adopted: Boolean(extra), reason: extra ? '部分ごとに検証する' : '分けずに検証する',
      parts: extra?.parts ?? [], boundaries: extra?.boundaries ?? [], contracts: extra?.contracts ?? [], composition_conditions: extra?.composition_conditions ?? [],
    });
    return [{ kind: 'partitions', ref: runRef(task, 'partitions.json') }];
  },
  'plan-author'(task, s, memory) {
    const c = task.context;
    // 下書きの形（SP-264-021）: task はモデルごとに 1 つで、context.target_ids がそのモデルで出しうる target_id の一覧
    const draft = Array.isArray(c.target_ids) && c.target_ids.length > 0;
    const latest = latestModels(memory).filter((m) => !draft || m.id === c.model_id);
    assert.ok(latest.length, 'plan-author の前に model-author の task がある');
    const run = task.context.run_dir;
    // mref(name): モデル作成役の attempt のファイルの ref（モデルが複数の task に分かれるので、そのファイルを書いた task を引く）
    const mref = (name) => { const m = latest.find((x) => existsSync(join(x.task.attempt_dir, name))) ?? latest[0]; return relative(run, join(m.task.attempt_dir, name)); };
    // 分割から契約・合成の条件の検査を作るのは、CLI が分割を採って計画作成役の入力に分割を渡したときだけ
    // （欠陥の残った分割は採らず、計画作成役には分割の無いモデルだけを渡す。artifact-formats「欠陥の残った分割」）。
    // 採った分割の ref は、今の形では分割作成役の attempt、組み立てる形では assembled/ なので、資料の名前 partitions で見る
    const adopted = (task.context.input_refs ?? []).some((r) => r.name === 'partitions') ? memory.partition : null;
    const part = adopted && draft ? { ...adopted, contracts: (adopted.contracts ?? []).filter((k) => k.model_id === c.model_id), composition_conditions: (adopted.composition_conditions ?? []).filter((k) => k.model_id === c.model_id) } : adopted;
    // モデル作成役・計画作成役が問いに依存すると挙げた性質は、計画に入れない（変異は unavailable に理由を書く）
    const all = latest.flatMap((m) => m.props.map((p) => ({ m, p, mp: m.mp[p.id] })));
    const blocked = all.filter(({ p }) => questionsOf(s, ['model-author', 'plan-author'], p.id).length > 0);
    const pairs = all.filter((x) => !blocked.includes(x));
    // targetRef: 対象のファイルの ref（target:<target_id>/<FilePath>。担当が書いたものでない資料）
    const targetRef = (file) => { const req = readJson(join(task.context.run_dir, 'request.json')); return `target:${req.targets[0].id}/${file}`; };
    const ctx = { round: memory.rounds[task.role], pairs, mref, targetRef, draft, model_id: c.model_id, put: (name, body) => { write(task, name, body); return runRef(task, name); } };
    // 変異は、置き換える性質の query の節を読んで書く（agents/plan-author.md）。担当と同じく、query が渡した資料からだけ読む
    // （渡されなければ違反に挙げる。run 766370 では性質の query が資料に無く、全ての性質の変異を書けなかった）
    const read = materialReader(task, memory);
    for (const { p, mp } of pairs.filter(({ p }) => p.mutation)) read(mref(`${mp}.smt2`));
    // 変異の .smt2 は計画作成役自身の attempt に書き、mutation_ref はそこを指す（artifact-formats「変異のファイル」、agents/plan-author.md）
    for (const { p, mp } of pairs.filter(({ p }) => p.mutation)) write(task, `${mp}-mut.smt2`, namedClauses(smtQuery(`mutation ${mp}`, p.mutation, p.smt), mp, p, { mutate: true }).text);
    // 計画の id は plan-skeleton と同じ形で書く（今の形でも、id の期待値を単位で変えないため。test-fixtures/core-ids.mjs）
    const plan = {
      schema: 'formal-method.plan/1',
      // selection は inventory の性質の id。CLI が実行できる道具の名前は adapter の id（z3）で書く（artifact-formats「plan と mutations」の道具の名前）
      selection: pairs.map(({ p }) => ({ property_id: p.id, candidates: [candidate('実行基盤', 'Rust', p, s), candidate('検証器', 'z3', p, s)], chosen: { technique: 'SMT', tool: 'z3' }, reason: '整数の制約を直接書ける' })),
      checks: [
        // kind: property の target_id はモデルの性質の id
        ...pairs.map(({ m, p, mp }) => ({ id: `prop-${mp}`, kind: 'property', target_id: mp, model_id: m.id, input_refs: [mref(`${mp}.smt2`)], expected: 'unsat', assumptions: ['x は -8 以上 8 以下'], scope: 'x ∈ [-8, 8]', tool_time_limit_seconds: p.toolTimeLimit ?? s.toolTimeLimit, depends_on: [] })),
        ...(part?.contracts ?? []).map((k) => ({ id: `contract-${k.id}`, kind: 'contract', target_id: k.id, model_id: k.model_id, input_refs: [k.query_ref], expected: 'unsat', assumptions: [], scope: '部分', tool_time_limit_seconds: s.toolTimeLimit, depends_on: [] })),
        ...(part?.composition_conditions ?? []).map((k) => ({ id: `comp-${k.id}`, kind: 'composition', target_id: k.id, model_id: k.model_id, input_refs: [k.query_ref], expected: 'unsat', assumptions: [], scope: '全体', tool_time_limit_seconds: s.toolTimeLimit, depends_on: (k.depends_on ?? []).map((x) => `contract-${x}`) })),
      ],
      sanity: pairs.map(({ mp }) => ({ id: `sanity-${mp}-1`, model_property_id: mp, input_refs: [mref(`${mp}-sanity.smt2`)], tool_time_limit_seconds: s.toolTimeLimit })),
    };
    const planOut = s.editPlan ? s.editPlan(plan, ctx) : plan;
    const mutations = {
      schema: 'formal-method.mutations/1',
      // mutations の property_id はモデルの性質の id、unavailable は inventory の性質の id
      mutations: pairs.filter(({ p }) => p.mutation).map(({ p, mp }) => ({ id: `MU-${mp}`, property_id: mp, mutation_ref: runRef(task, `${mp}-mut.smt2`), expected_violation: 'sat', detector_check_id: `prop-${mp}` })),
      unavailable: [...pairs.filter(({ p }) => !p.mutation).map(({ p }) => ({ property_id: p.id, reason: '変異を作れない', alternative: null })),
        ...blocked.map(({ p }) => ({ property_id: p.id, reason: '問いに依存する', alternative: null }))],
    };
    const mutOut = s.editMutations ? s.editMutations(mutations, ctx) : mutations;
    if (draft) {
      // 今の形の計画から下書きを作る: selection はそのまま、targets は検査の target_id ごとの時間の上限・前提・範囲（検査を除いた target は欠ける）。
      // sanity の時間の上限は、その性質の target の値（plan-skeleton が写す）なので、sanity の上限を変えた編集はその性質の target に移す
      const targets = new Map();
      for (const x of planOut.checks ?? []) if (!targets.has(x.target_id)) targets.set(x.target_id, { target_id: x.target_id, tool_time_limit_seconds: x.tool_time_limit_seconds, assumptions: x.assumptions, scope: x.scope });
      for (const x of planOut.sanity ?? []) { const tg = targets.get(x.model_property_id); if (tg && x.tool_time_limit_seconds !== s.toolTimeLimit) tg.tool_time_limit_seconds = x.tool_time_limit_seconds; }
      let pd = { schema: 'formal-method.plan-draft/1', selection: planOut.selection, targets: [...targets.values()] };
      let md = { schema: 'formal-method.mutations-draft/1', mutations: (mutOut.mutations ?? []).map(({ detector_check_id: _d, ...rest }) => rest), unavailable: mutOut.unavailable ?? [] };
      if (s.editPlanDraft) pd = s.editPlanDraft(pd, ctx);
      if (s.editMutationsDraft) md = s.editMutationsDraft(md, ctx);
      write(task, 'plan.json', pd);
      write(task, 'mutations.json', md);
      return [{ kind: 'plan', ref: runRef(task, 'plan.json') }, { kind: 'mutations', ref: runRef(task, 'mutations.json') }];
    }
    write(task, 'plan.json', planOut);
    write(task, 'mutations.json', mutOut);
    // 計画の 3 つの id（検査・sanity・変異）は、確認の id（confirm-<kind>-<n>）と重ならないよう confirm- で始めない
    const planIds = [...planOut.checks.map((x) => x.id), ...planOut.sanity.map((x) => x.id), ...mutOut.mutations.map((x) => x.id)];
    assert.ok(planIds.every((id) => !id.startsWith('confirm-')), 'harness の計画の id は confirm- で始まらない');
    if (!s.allowDuplicatePlanIds) assert.ok(new Set(planIds).size === planIds.length, 'harness の計画の id は一意');
    return [{ kind: 'plan', ref: runRef(task, 'plan.json') }, { kind: 'mutations', ref: runRef(task, 'mutations.json') }];
  },
};

// 忠実さの確認役は、query が渡した判断を要する項目の記録（judgments/<model_id>.json）の項目ごとに答える
function judgmentsOf(task) {
  const r = (task.context.input_refs ?? []).find((x) => x.name === `judgments-${task.context.model_id}`);
  return r ? readJson(join(task.context.run_dir, r.ref)).judgments : [];
}
// shape: { ctx: 返り値に task_id・unit_id・perspective を書くか, result: result を書くか（書かなければ items。SP-264-028） }
function reviewReturn(task, s, shape) {
  const perspective = task.context.perspective;
  const result = s.reviews[perspective] ?? '成り立つ';
  write(task, 'review.json', { perspective, note: 'harness の確認の記録' });
  // 答えが null の項目は答えない（返り値の形の違いのケース）
  const answer = (j) => (j.id in s.judgmentAnswers ? s.judgmentAnswers[j.id] : j.kind in s.judgmentAnswers ? s.judgmentAnswers[j.kind] : '成り立つ');
  const judgments = perspective === 'fidelity' ? judgmentsOf(task).filter((j) => answer(j) !== null).map((j) => ({ id: j.id, result: answer(j), note: `harness の答え（${j.cause}）` })) : [];
  // items: 見た観点ごとの記録。harness は観点を 1 つの項目として、決めた結果を書く（成り立たないは指摘で表すので、項目は 確認できず にしない）
  const items = s.reviewItems?.[perspective] ?? [{ ref: perspective, result: result === '成り立たない' ? '成り立つ' : result }];
  return {
    ...(shape.ctx ? { task_id: task.task_id, unit_id: task.context.unit_id, perspective } : {}), ...(shape.result ? { result } : { items }),
    findings: result === '成り立たない' ? [{ ref: task.context.property_ids[0] ?? 'P1', kind: 'meaning_change', note: '否定が逆になっている' }] : [],
    judgments, record_ref: runRef(task, 'review.json'), worklog_ref: runRef(task, 'worklog.json'),
  };
}

function causeReturn(task, s, shape) {
  write(task, 'cause.json', { note: 'harness の分類の記録' });
  return { ...(shape.ctx ? { task_id: task.task_id, unit_id: task.context.unit_id } : {}), cause: s.cause.cause, grounds: s.cause.grounds, questions: s.cause.questions,
    record_ref: runRef(task, 'cause.json'), worklog_ref: runRef(task, 'worklog.json') };
}

// hooks:
//   via: 'process'（既定）| 'shell'。担当の claim・query・submit と司令塔の close を、client の関数で同じ process から流すか、
//     担当と同じく Bash の命令（入口の claim・<query_cmd> <task_id>・submit_cmd、CLI の close）で流すか。どちらも同じ依頼・応答・受け箱のファイルを通る。
//     既定を process にするのは、node の起動の数を減らし、時間の上限のケースの担当の進みを並列の負荷に左右させないため。
//     入口と命令の文字列そのものは、shell で流すケース（call.test.mjs）が確かめる。
//   beforeSubmit(status, { tasks: [task] }): 担当が成果物と返り値を書いた後、submit の前に呼ぶ（担当ごと・提出ごと）。
//   close(status, call) → null | 閉じ方。司令塔の close の型（artifact-formats「Workflow の返り値」、SKILL.md「担当の起動」）:
//     null・'plain': {agents, tokens} を書いたファイルで close。'wrapped': ホストの完了通知の包み {summary, agentCount, logs, result} で close。
//     'timed_out': timed_out: true で close。'late': 期限（deadline_wall_ms）を過ぎてから close。'none': close しない（run-daemon が期限で閉じる）。
//     'inbox_not_json'・'inbox_shape'・'inbox_call_id': 受け箱そのものを崩す（close の入力の検査を通らないので、close と同じ手順で直接公開する）。
//     'wf_unreadable'・'wf_shape': Workflow の返り値のファイルを崩す。
//   tokens(call) → number | null: close に渡す Workflow の返り値の tokens。
export const CLOSE_MODES = ['plain', 'wrapped', 'timed_out', 'late', 'none', 'inbox_not_json', 'inbox_shape', 'inbox_call_id', 'wf_unreadable', 'wf_shape'];
// close と同じ手順で受け箱を公開する（一時ファイルに書いてから link するので、書きかけは見えない）
function publishInbox(runDir, callId, text) {
  const inbox = join(runDir, 'inbox');
  mkdirSync(inbox, { recursive: true });
  const tmp = join(inbox, `.tmp-harness-${randomBytes(8).toString('hex')}`);
  writeFileSync(tmp, text);
  linkSync(tmp, join(inbox, `${callId}.json`));
  unlinkSync(tmp);
}
const LATE_MARGIN_MS = 1000;
const sq = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;
const json1 = (r) => r.json ?? { ok: false, code: 'E_HARNESS', reason: `出力が 1 行の JSON でない: ${r.stdout.slice(0, 300)} ${r.stderr.slice(0, 300)}` };

// 返り値（artifact-formats「担当の返り値」）を役ごとに書く。round はその役の提出の何回目か（1 から）。
// schema: その役の返り値の形（claim・next の return_schemas）。下書きの形かどうかを、形が task_id・result を持つかで見る
function writeReturn(task, scenario, memory, mode, schema = null) {
  const props = schema?.properties ?? null;
  const shape = { ctx: !props || 'task_id' in props, result: !props || 'result' in props };
  write(task, 'worklog.json', worklog(task, !shape.ctx));
  const tid = shape.ctx ? { task_id: task.task_id } : {};
  let ret;
  if (task.context.perspective) ret = reviewReturn(task, scenario, shape);
  else if (task.role === 'cause-analyst') ret = causeReturn(task, scenario, shape);
  else if (mode === 'cannot_proceed') ret = { ...tid, status: 'cannot_proceed', outputs: [], questions: [], blocked_by_question: [], reason: 'harness が進めない', worklog_ref: runRef(task, 'worklog.json') };
  else {
    const qs = scenario.questionsBy[task.role] ?? [];
    const outputs = ROLE[task.role](task, scenario, memory);
    let blocked;
    if (scenario.blockedAs[task.role] === 'question_ids') blocked = qs.map((q) => q.id);
    else if (task.role === 'extractor') blocked = readJson(join(task.attempt_dir, 'inventory.json')).properties.filter((p) => p.blocked_by_question.length > 0).map((p) => p.id);
    else blocked = [...new Set(qs.flatMap((q) => q.affected))].filter((id) => task.context.property_ids.includes(id));
    ret = { ...tid, status: qs.length ? 'needs_answer' : 'done', outputs, questions: qs, blocked_by_question: blocked, reason: null, worklog_ref: runRef(task, 'worklog.json') };
    memory.authorReturns.push({ task, ret });
  }
  if (mode === 'bad_shape') ret = { ...ret, unexpected: true };
  writeFileSync(task.result_path, JSON.stringify(ret, null, 2));
}

export function makeHarness(scenario, hooks = {}) {
  // returnSchemas: claim・next で受け取った返り値の形（役 → schema）。テストが形の欄を見る
  const memory = { byRole: {}, rounds: {}, tasks: [], calls: [], submits: [], violations: [], refusals: [], partition: null, models: [], closes: [], authorReturns: [], held: {}, returnSchemas: {} };
  // Workflow の返り値は、run の workspace の保存先の root（<ws>/.formal-method/。runs/<run_id> の 2 つ上）の下に置く。
  // 呼び手は workspace を消すので tmpdir() の直下に残らず、.formal-method/ は対象の集まりから除かれるので、対象の指紋も変えない
  let wfDir = null;
  // 役の 1 体: 最初の claim で取った担当（1 つ以上）を果たし、受理の submit の応答の next の担当を続けて果たす。next が done: true なら終える
  // （終わりの claim は流さない）。戻り値は Workflow の起動の記録の 1 行。
  async function worker(status, args, w, call, opts) {
    const rec = { role: w.role, label: `${w.role}-${w.id}`, model: w.model, effort: w.effort, ok: true };
    const roles = w.role.split('+');
    // 'error' は、担当が起動に失敗した（claim を流さない）
    if (roles.some((r) => scenario.returns[r] === 'error')) return { ...rec, ok: false };
    const launcher = join(args.state, 'formal-method-cli.mjs');
    const base = { run_dir: args.state, call_id: args.callId, worker: w.id };
    const claimCmd = `printf '%s' '${JSON.stringify(base)}' | '${process.execPath}' '${launcher}' claim`;
    const shell = hooks.via === 'shell';
    // 担当のコマンドの拒否（ok: false）は、memory.refusals に控え、stderr に 1 行の JSON で出す（Issue #264: 拒否の理由が test の失敗の
    // 文言に出ず、原因を追えなかった）。契約の違反（memory.violations）には足さない: 意図して claim しない・提出しない test がある
    const refused = (command, j) => {
      if (!j || j.ok !== false) return;
      const entry = { call_id: args.callId, worker: w.id, command, code: j.code ?? null, reason: j.reason ?? null, detail: j.detail ?? null };
      memory.refusals.push(entry);
      process.stderr.write(`${JSON.stringify(entry)}\n`);
    };
    const run = async (command, cmd, input) => {
      const j = shell ? json1(await runShell(cmd, opts)) : await workerCall(command, input);
      refused(command, j);
      return j;
    };
    // holdCalls: この呼び出しで束を取ったまま出さないか
    const holdRole = roles.find((r) => (scenario.holdCalls[r] ?? 0) > (memory.held[r] ?? 0));
    if (holdRole) memory.held[holdRole] = (memory.held[holdRole] ?? 0) + 1;
    const c = await run('claim', claimCmd, base);
    if (!c.ok || c.done) { call.claims.push({ worker: w.id, via: 'claim', ...c }); return rec; }
    const ctx = { runDir: status.run_dir, callId: args.callId, worker: w.id };
    // この worker が受け取った返り値の形（役 → schema）。claim と next の return_schemas で受け取る
    const schemas = {};
    memory.violations.push(...claimViolations(c, { ...ctx, kind: 'claim', schemas }));
    Object.assign(memory.returnSchemas, schemas);
    const cmds = { query: c.query_cmd, submit: c.submit_cmd };
    const closed = new Set();
    let batch = c;
    let via = 'claim';
    for (let guard = 0; guard < 40; guard += 1) {
      call.claims.push({ worker: w.id, done: false, via, task_ids: batch.tasks.map((x) => x.task_id) });
      const got = [];
      for (const raw of batch.tasks) {
        if (closed.has(raw.task_id)) memory.violations.push(`${w.id} の ${via} が閉じた担当 ${raw.task_id} を返した`);
        if (!schemas[raw.role]) memory.violations.push(`${w.id} の ${raw.task_id}: 役 ${raw.role} の返り値の形を受け取っていない`);
        let task = memory.tasks.find((x) => x.task_id === raw.task_id);
        if (!task) {
          memory.violations.push(...taskViolations(raw, status.run_dir, memory, w));
          // query は worker で 1 つの query_cmd に task_id を引数で足して流す
          const q = await run('query', `${cmds.query} ${sq(raw.task_id)}`, { ...base, task_id: raw.task_id });
          // 呼び出しが閉じた・期限を過ぎた（時間の上限のケース）なら、担当を終える
          if (!q.ok) { call.claims.push({ worker: w.id, query: q }); return { ...rec, ok: false }; }
          // query_inputs: query の応答の inputs をそのまま（path を見るテストのため）
          // 同じディレクトリに畳んだ資料（{ref, path, entries}）は、entries ごとの ref に戻す（cli-contract.md の query。ディレクトリの entry の末尾の / は除く）
          const flat = q.inputs.flatMap((x) => (x.entries ? x.entries.map((e) => ({ name: e.name, ref: `${x.ref}${e.entry}`.replace(/\/$/, '') })) : [x]));
          task = { ...raw, query_inputs: q.inputs, context: { ...raw.context, input_refs: flat.map((x) => ({ name: x.name, ref: x.ref, ...(x.spans ? { spans: x.spans } : {}) })) } };
          memory.tasks.push(task);
          call.tasks.push(task);
          memory.byRole[task.role] = task;
        }
        got.push(task);
      }
      if (holdRole) return { ...rec, ok: false };
      // 最後に受理された submit の応答の next（次の担当か done: true）
      let next = null;
      for (const task of got) {
        if (closed.has(task.task_id)) continue;
        const mode = (task.context.perspective && scenario.returnsByPerspective[task.context.perspective]) || scenario.returns[task.role];
        // 'missing' は、取って資料を引いたまま提出しない（返らなかった担当）
        if (mode === 'missing') return { ...rec, ok: false };
        let done = false;
        for (let n = 0; n < 10 && !done; n += 1) {
          memory.rounds[task.role] = (memory.rounds[task.role] ?? 0) + 1;
          const round = memory.rounds[task.role];
          writeReturn(task, scenario, memory, mode, schemas[task.role]);
          if (hooks.beforeSubmit) await hooks.beforeSubmit(status, { tasks: [task] });
          const r = await run('submit', cmds.submit, base);
          if (!r.ok) { memory.submits.push({ task_id: task.task_id, role: task.role, round, refused: r }); return rec; }
          const res = r.results.find((x) => x.task_id === task.task_id);
          memory.submits.push({ task_id: task.task_id, role: task.role, round, result: res });
          if (hooks.afterSubmit) await hooks.afterSubmit(status, { task, result: res });
          done = res.done;
          const sentBack = r.results.some((x) => !x.done);
          // 差し戻しの応答は next を持たず、差し戻しの無い応答は next を持つ（cli-contract.md「依頼と応答」）
          if (sentBack === ('next' in r)) { memory.violations.push(`${w.id} の submit の応答: 差し戻し ${sentBack} で next ${'next' in r ? 'あり' : 'なし'}`); return { ...rec, ok: false }; }
          if (!sentBack) next = r.next;
          if (!done && (scenario.stopAfterSubmits[task.role] ?? Infinity) <= round) return rec;
        }
        closed.add(task.task_id);
      }
      if (!next) { memory.violations.push(`${w.id}: 受理の後の next が無い`); return { ...rec, ok: false }; }
      if (next.done === true) {
        if (Object.keys(next).join() !== 'done') memory.violations.push(`${w.id} の next（done: true）の欄 ${Object.keys(next).join()}`);
        call.claims.push({ worker: w.id, via: 'next', done: true });
        return rec;
      }
      memory.violations.push(...claimViolations(next, { ...ctx, kind: 'next', schemas }));
      Object.assign(memory.returnSchemas, schemas);
      batch = next;
      via = 'next';
    }
    return rec;
  }
  async function onAgents(status, opts = {}) {
    if (!wfDir) wfDir = mkdtempSync(join(dirname(dirname(status.run_dir)), '.fm-harness-wf-'));
    assert.ok(status.call, `run_agents は call を持つ: ${JSON.stringify(status)}`);
    const args = readJson(status.call.args_path);
    assert.deepEqual(Object.keys(args).sort(), ['callId', 'stage', 'state', 'workers'], 'args は {state, callId, stage, workers} だけ');
    assert.equal(args.callId, status.call.call_id);
    assert.equal(args.state, status.run_dir);
    const call = { ...args, deadline_wall_ms: status.call.deadline_wall_ms, tasks: [], claims: [] };
    memory.calls.push(call);
    const agents = await Promise.all(args.workers.map((w) => worker(status, args, w, call, opts)));
    // 契約に合わなければ、呼び出しを閉じないまま失敗にする。run-daemon が呼び出しの期限まで残らないよう、先に止める
    if (memory.violations.length && status.daemon?.pid) { try { process.kill(status.daemon.pid, 'SIGKILL'); } catch { /* 既に終わっている */ } }
    assert.deepEqual(memory.violations, [], 'run-daemon が出した task が契約（claim の Task の欄・役と context、claim・submit の応答の形）に合う');
    const mode = (hooks.close ? hooks.close(status, call) : null) ?? 'plain';
    assert.ok(CLOSE_MODES.includes(mode), `harness の閉じ方 ${mode}`);
    memory.closes.push({ call_id: args.callId, mode });
    if (mode === 'none') return;
    if (mode === 'late') while (Date.now() < status.call.deadline_wall_ms + LATE_MARGIN_MS) await new Promise((r) => setTimeout(r, 100));
    const doClose = async (input) => {
      if (hooks.via === 'shell') expectOk(await cli('close', input, opts), 'close');
      else assert.ok(['accepted', 'duplicate'].includes(closeInProcess(input).outcome));
    };
    if (mode === 'timed_out') { await doClose({ run_dir: status.run_dir, call_id: args.callId, timed_out: true }); return; }
    const wf = join(wfDir, `${args.callId}.json`);
    // tokens: hooks.tokens(call) が数を返せばその値（Workflow の budget.spent() の差の代わり）、無ければ null
    const out = { agents, tokens: hooks.tokens ? hooks.tokens(call) : null };
    const inboxModes = {
      inbox_not_json: () => publishInbox(status.run_dir, args.callId, '{"call_id": '),
      inbox_shape: () => publishInbox(status.run_dir, args.callId, JSON.stringify({ call_id: args.callId })),
      inbox_call_id: () => { writeFileSync(wf, JSON.stringify(out)); publishInbox(status.run_dir, args.callId, JSON.stringify({ call_id: `${args.callId}-other`, workflow_output_path: wf })); },
    };
    if (inboxModes[mode]) { inboxModes[mode](); return; }
    if (mode === 'wrapped') writeFileSync(wf, JSON.stringify({ summary: `${agents.length} 体の担当が終わった`, agentCount: agents.length, logs: [], result: out }));
    else if (mode === 'wf_shape') writeFileSync(wf, JSON.stringify({ agents: 'not-an-array', tokens: null }));
    else if (mode !== 'wf_unreadable') writeFileSync(wf, JSON.stringify(out));
    await doClose({ run_dir: status.run_dir, call_id: args.callId, workflow_output_path: mode === 'wf_unreadable' ? join(wfDir, `${args.callId}-missing.json`) : wf });
  }
  return { onAgents, memory };
}
