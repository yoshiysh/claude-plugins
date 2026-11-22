// run-daemon の段の進行（architecture.md「段と処理の順序」「停止の手順」）。段は表の順に 1 度ずつ進み、戻るのは修正の巡だけ。
// 止めるのは 4 つの理由（時間の上限・保存の失敗・依頼の不備・内部の誤り）だけで、担当の失敗・反例・不合格では段を進める。
import { readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { sha256Bytes } from './canonical.mjs';
import { ABLATION_PER_PROPERTY_MAX, MODEL_CHECK_KINDS, STATE_SCHEMA, UNIT_MAX_BYTES } from './schemas.mjs';
import { scanSecrets, describeHits } from './secrets.mjs';
import { writeEvidence } from './storage.mjs';
import { guardedWrite, SalvagedError } from './store.mjs';
import { startRunClock, NODE_TIMER_CLOCK } from './clock.mjs';
import { checkRequestShape, checkPointers, normalizeRequest } from './request.mjs';
import { fetchTarget, writeManifest, changedFiles, lineCount } from './intake.mjs';
import { mergeSpans, parseTargetRef, refPathOf, targetRef } from './target-refs.mjs';
import { packByUnion, runItems, runWorkers } from './call.mjs';
import { refFiles } from './agents.mjs';
import { ledgerEntry, newStageLog, cliWorklog, DOC_RULES_PATH, docRulesRefOf } from './worklog.mjs';
import { coverageCheck } from './checks/coverage.mjs';
import { modelCheck, matrixGen } from './checks/model.mjs';
import { buildGraph, deriveCandidates } from './checks/graph.mjs';
import { partitionCheck } from './checks/compose.mjs';
import { planCheck, defectiveElements, checkGaps } from './checks/plan.mjs';
import { ablate, clauseGroups, clauseShapeProblem, namedTerms } from './checks/ablation.mjs';
import { noSuitableTool } from './adapters/index.mjs';
import { parseForms, symbolsOf } from './sexpr.mjs';
import { ConfirmationIds, confirmationResult, verdictOf, reviewUnits, causeUnitId, judgmentAnswers, TRUNCATED } from './checks/det.mjs';
import { classifyCheck } from './verdict.mjs';
import { readRunText, defect } from './checks/common.mjs';
import * as z3 from './adapters/z3.mjs';
import { runExecutions, NOT_STARTED_END } from './scheduler.mjs';
import { spawnTool } from './process.mjs';
import { reason, PARTITION_REJECTED } from './result.mjs';
import { locationFromEnv } from './performance.mjs';

// 否定だけ・前提と否定だけ・規則と否定だけの 3 つ（ABLATION_PER_PROPERTY_MAX はこれと前提ごとの再検査の和の上限）
const BASE_ABLATIONS = 3;

const ROLE_OUTPUTS = { extractor: ['inventory'], 'model-author': ['model', 'mapping'], 'partition-author': ['partitions'], 'plan-author': ['plan', 'mutations'] };

export class StatusWriteError extends Error {
  constructor(cause) { super(`status.json を書けない: ${cause}`); this.code = 'STATUS_WRITE'; }
}

export class Run {
  constructor({ runDir, runId, root, workspace, nonce, identity }) {
    Object.assign(this, { runDir, runId, root, workspace, nonce, identity });
    this.location = locationFromEnv();
    this.startedHr = process.hrtime.bigint();
    this.seq = 0;
    this.taskNo = 0;
    this.callNo = 0;
    this.calls = [];
    this.stage = '受付';
    this.stageConfirmed = null;
    this.logs = new Map();
    this.entries = [];
    this.unsaved = [];
    this.interrupts = [];
    this.agentFailures = [];
    this.notCreated = [];
    this.unverified = [];
    this.clock = startRunClock(null);
    this.request = null;
    this.requestRaw = null;
    this.targets = [];
    this.inventories = [];
    this.authorQuestions = [];
    this.blockedBy = new Map();
    this.models = [];
    this.queryRefs = new Map();
    this.smtBad = new Map();
    this.graph = { nodes: [], edges: [], unconfirmed: [] };
    this.candidates = [];
    this.partitions = null;
    this.decisions = [];
    this.plan = null;
    this.mutations = null;
    this.planDefects = new Map();
    this.planDefectList = [];
    this.selectionOf = () => null;
    this.prepare = null;
    this.exec = new Map();
    this.replays = new Map();
    this.confIds = new ConfirmationIds();
    this.confirmations = { deterministic: [], meaning: [], judgments: [] };
    this.judgmentRefs = new Map();
    this.viewRefs = new Map();
    this.counterexamples = [];
    this.causes = [];
    this.resultQuestions = [];
    this.timing = {};
    this.confirmationUnits = [];
    this.checkedDefects = [];
    this.partitionRejected = false;
    this.partitionRevoked = false;
    this.targetChanges = [];
    this.changedTargets = null;
    this.queriedMaterials = [];
  }

  // ref → 読む path（対象の ref は受付で控えた元のファイル。target-refs.mjs）
  pathOf(ref) { return refPathOf(this.runDir, this.targets)(ref); }
  // 対象のファイルの資料（architecture.md「担当に渡す資料」）。sel: Map<target_id, Map<FilePath, Span[] | null>>（null はファイルの全体）。
  // 読めるテキストのファイルだけを、対象の中の順（バイト列の辞書順）で返す。範囲は畳んで spans に置く
  targetRefsOf(sel) {
    const out = [];
    for (const t of this.targets) {
      const files = sel.get(t.id);
      if (!files) continue;
      for (const f of t.files) {
        if (!f.text || !files.has(f.path)) continue;
        const spans = files.get(f.path);
        out.push({ name: `target-${t.id}-${f.path}`, ref: targetRef(t.id, f.path), ...(spans ? { spans: mergeSpans(spans) } : {}) });
      }
    }
    return out;
  }
  // 依頼の範囲（scope.include）の、その対象のファイルと行の範囲。対象を挙げたか、対象を指す location が 1 つも無ければファイルの全体
  requestScopeOf(tid) {
    const t = this.targets.find((x) => x.id === tid);
    const files = new Map();
    if (!t) return new Map();
    const include = this.request?.scope?.include ?? [];
    const locs = include.filter((p) => p.kind === 'location' && p.target_id === tid);
    const whole = include.some((p) => p.kind === 'target' && p.id === tid) || locs.length === 0;
    for (const f of t.files) {
      if (whole) { files.set(f.path, null); continue; }
      const mine = locs.filter((p) => p.file === f.path);
      if (!mine.length) continue;
      files.set(f.path, mine.some((p) => !p.span) ? null : mine.map((p) => p.span));
    }
    return new Map([[tid, files]]);
  }
  // inventory の要素の id の出所の範囲（見つからない id は無視する）
  elementScopeOf(ids, into = new Map()) {
    for (const id of ids) {
      const e = this.inventories.flatMap((i) => i.data.elements).find((x) => x.id === id);
      if (!e) continue;
      const { target_id: tid, file, span } = e.source;
      if (!into.has(tid)) into.set(tid, new Map());
      const files = into.get(tid);
      if (files.has(file) && files.get(file) === null) continue;
      files.set(file, [...(files.get(file) ?? []), span]);
    }
    return into;
  }
  // 対応表の行の location の範囲（span が無い行はファイルの全体）
  mappingScopeOf(rows, into = new Map()) {
    for (const r of rows) {
      if (r.source.kind !== 'location') continue;
      const { target_id: tid, file, span } = r.source;
      if (!into.has(tid)) into.set(tid, new Map());
      const files = into.get(tid);
      if (!span || (files.has(file) && files.get(file) === null)) { files.set(file, null); continue; }
      files.set(file, [...(files.get(file) ?? []), span]);
    }
    return into;
  }
  // 範囲（Map<target_id, Map<FilePath, Span[] | null>>）を into に足す。null（ファイルの全体）が勝つ
  mergeScope(into, sel) {
    for (const [tid, files] of sel) {
      if (!into.has(tid)) into.set(tid, new Map());
      const to = into.get(tid);
      for (const [file, spans] of files) {
        if (spans === null || to.get(file) === null) { to.set(file, null); continue; }
        to.set(file, [...(to.get(file) ?? []), ...spans]);
      }
    }
    return into;
  }
  // 外部の依存の出所の範囲（source が null の依存は無視する）
  dependencyScopeOf(deps, into = new Map()) {
    for (const d of deps) {
      if (!d.source) continue;
      const { target_id: tid, file, span } = d.source;
      if (!into.has(tid)) into.set(tid, new Map());
      const files = into.get(tid);
      if (files.get(file) === null) continue;
      files.set(file, [...(files.get(file) ?? []), span]);
    }
    return into;
  }
  // そのモデルの性質（mps。null なら全て）が扱う inventory の性質の id と、それを持つ inventory
  modelInventoryOf(m, mps = null) {
    const props = m.data.properties.filter((p) => !mps || mps.includes(p.id));
    const invIds = new Set(props.flatMap((p) => p.inventory_property_ids));
    return { props, invIds, inventories: this.inventories.filter((i) => i.data.properties.some((p) => invIds.has(p.id))) };
  }
  // モデルの性質を支える出所の要素の id: そのモデルの性質が扱う inventory の性質の source_ids、節の source_ids、そのモデルの状態遷移・禁止・
  // 入出力の契約の source_ids。inventory の性質の出所を入れるのは、節に出所の無い要求（モデルが落とした要求）の本文も確認役に渡すため
  modelSourceIds(m, mps = null) {
    const { props, invIds } = this.modelInventoryOf(m, mps);
    const invSources = this.inventoryProperties().filter((p) => invIds.has(p.id)).flatMap((p) => p.source_ids);
    const sm = m.data.state_machine;
    return [...invSources, ...props.flatMap((p) => p.clauses.flatMap((c) => c.source_ids)), ...(sm ? [...sm.transitions, ...sm.forbidden].flatMap((x) => x.source_ids) : []), ...m.data.io_contracts.flatMap((c) => c.source_ids)];
  }
  // モデルの性質を支える出所の範囲の正本（architecture.md「担当に渡す資料」）。忠実さの確認役・原因の分類役（反例）に渡す範囲と、結果の
  // 対象の変化の判定（propertyScopeOf）が同じこれを使う。modelSourceIds の要素、その性質の対応表の行の location、節の外部の依存の source。
  // view（忠実さの確認役）なら、加えてそのモデルの inventory の全ての外部の依存と、どの性質にも結ばれない要素の範囲（漏れを本文で探すため）
  modelScope(m, { mps = null, view = false } = {}, into = new Map()) {
    const { props, invIds, inventories } = this.modelInventoryOf(m, mps);
    this.elementScopeOf(this.modelSourceIds(m, mps), into);
    this.mappingScopeOf(mps ? m.mapping.data.rows.filter((r) => invIds.has(r.property_id)) : m.mapping.data.rows, into);
    const extIds = new Set(props.flatMap((p) => p.clauses.map((c) => c.external_dependency_id).filter((x) => x !== null)));
    const deps = inventories.flatMap((i) => i.data.external_dependencies);
    this.dependencyScopeOf(view ? deps : deps.filter((d) => extIds.has(d.id)), into);
    if (view) this.elementScopeOf(this.unboundElements(inventories).map((e) => e.id), into);
    return into;
  }
  // どの性質の source_ids にも結ばれない要素（その inventory の中で）
  unboundElements(inventories) {
    return inventories.flatMap((i) => { const bound = new Set(i.data.properties.flatMap((p) => p.source_ids)); return i.data.elements.filter((e) => !bound.has(e.id)); });
  }
  // inventory の性質を支える出所の範囲: その性質の source_ids と、その性質を扱う全てのモデルの性質の modelScope（mps をその性質の分に限る）
  propertyScopeOf(pid) {
    const p = this.inventoryProperties().find((x) => x.id === pid);
    const sel = this.elementScopeOf(p ? p.source_ids : []);
    for (const m of this.models) {
      const mps = m.data.properties.filter((x) => x.inventory_property_ids.includes(pid)).map((x) => x.id);
      if (mps.length) this.modelScope(m, { mps }, sel);
    }
    return sel;
  }
  targetFileRefs(tid) { return this.targetRefsOf(this.requestScopeOf(tid)); }

  // 担当の最初の query で固定した資料の指紋（call.mjs）を控える。集約の段で、対象のファイルの指紋を受付の指紋と照らす
  noteMaterials(materials) { this.queriedMaterials.push(materials); }

  // 固定の前提の照合（architecture.md「対象の固定」）。集約の段で 1 度だけ、全ての対象のファイルを読み直した指紋と、担当の query の時点の
  // 指紋を、受付の指紋と比べる。違うファイルは changedTargets（target_id → Map<FilePath, 理由>）に控え、結果で検証済みとして出さない。
  // 集約が 2 度呼ばれても（内部の誤りの後の集約）、照らすのは 1 度だけで、停止の理由も 1 度だけ足す
  checkTargetsFixed() {
    if (this.changedTargets) return;
    const changed = new Map();
    const add = (tid, file, why) => {
      if (!changed.has(tid)) changed.set(tid, new Map());
      const m = changed.get(tid);
      m.set(file, m.has(file) && m.get(file) !== why ? `${m.get(file)}。${why}` : why);
    };
    for (const t of this.targets) for (const file of changedFiles(t)) add(t.id, file, '集約の段で読み直した指紋が受付の指紋と違う');
    for (const ms of this.queriedMaterials) {
      for (const x of ms) {
        const r = parseTargetRef(x.ref);
        const f = r ? this.targets.find((t) => t.id === r.targetId)?.files.find((y) => y.path === r.file) : null;
        if (f && x.hash !== f.content_hash) add(r.targetId, r.file, '担当の query の時点の指紋が受付の指紋と違う');
      }
    }
    this.changedTargets = changed;
    for (const [tid, files] of changed) this.targetChanges.push(reason('対象の変化', '集約', `対象 ${tid} のファイル ${[...files.keys()].join(', ')} が受付の後に変わった（対象は run の間固定している前提）`));
  }

  nextTaskNo() { this.taskNo += 1; return this.taskNo; }
  nextCallNo() { this.callNo += 1; return this.callNo; }
  log(stage = this.stage) { if (!this.logs.has(stage)) this.logs.set(stage, newStageLog()); return this.logs.get(stage); }
  halted() { return this.interrupts.length > 0; }
  interrupt(code, detail, stage = this.stage) { this.interrupts.push(reason(code, stage, detail)); this.log(stage).failures.push(`${code}: ${detail}`); }
  timeLimitReached(detail) { if (!this.interrupts.some((x) => x.code === '時間の上限')) this.interrupt('時間の上限', detail); }
  saveFailed(kind, ref, why) {
    this.unsaved.push({ kind, ref, reason: why });
    if (!this.interrupts.some((x) => x.code === '保存の失敗' && x.stage === this.stage)) this.interrupt('保存の失敗', `記録を保存できない: ${why}`);
    else this.log().failures.push(`保存の失敗: ${why}`);
  }
  agentFailed(task, detail) { this.agentFailedStage(task.context.stage, detail); }
  agentFailedStage(stage, detail) {
    this.agentFailures.push(reason('担当の失敗', stage, detail));
    this.log(stage).failures.push(detail);
  }

  writeStatus(action, call, result = null) {
    this.seq += 1;
    const status = { seq: this.seq, run_dir: this.runDir, action, call, result, daemon: this.identity };
    try { guardedWrite(this.runDir, 'status.json', status); } catch (e) {
      if (e instanceof SalvagedError) throw e;
      throw new StatusWriteError(e.code ?? e.message);
    }
  }

  writeState() {
    const state = { schema: STATE_SCHEMA, run_id: this.runId, stage_confirmed: this.stageConfirmed ?? '受付', location: this.location, document_rules: this.docRules ?? null, entries: this.entries };
    try { guardedWrite(this.runDir, 'state.json', state); } catch (e) {
      if (e instanceof SalvagedError) throw e;
      this.saveFailed('worklog', 'state.json', `内部の状態を書けない（${e.code ?? e.message}）`);
    }
  }

  // CLI が書く記録。秘密値の型があるか書けなければ 保存の失敗。
  writeRecordFile(ref, data, { kind, register = true, inputRefs = [] } = {}) {
    const out = writeEvidence(this.runDir, ref, data);
    if (!out.ok) { this.saveFailed(kind, ref, out.reason); return null; }
    if (register) this.entries.push(ledgerEntry({ kind, ref, hash: out.hash, stage: this.stage, inputRefs }));
    return out.hash;
  }

  // 担当が書いた記録を登録する（書く直前の走査に当たる。秘密値の型があれば登録せず 保存の失敗）。
  registerAgentFile(kind, ref, task, materials) {
    let bytes;
    try { bytes = readFileSync(join(this.runDir, ref)); } catch (e) { this.saveFailed(kind, ref, `担当の記録を読めない（${e.code ?? e.message}）`); return false; }
    const hits = scanSecrets(bytes);
    if (hits.length) { this.saveFailed(kind, ref, `秘密値の型を見つけたので保存しない: ${describeHits(hits)}`); return false; }
    if (this.entries.some((e) => e.ref === ref)) return true;
    this.entries.push(ledgerEntry({ kind, ref, hash: sha256Bytes(bytes), stage: task.context.stage, task, inputRefs: materials }));
    return true;
  }

  enterStage(stage) { this.stage = stage; this.log(stage); this.timing[stage] = { start: process.hrtime.bigint() }; }
  leaveStage(stage) {
    if (this.timing[stage]) this.timing[stage].ms = Number((process.hrtime.bigint() - this.timing[stage].start) / 1000000n);
    // 規約の写しを保存できなかったときは、適用した規約の実際の版を参照し、写しが無いことを unconfirmed に書く
    // 規約そのものを読めていなければ、作業記録の形（document_rules は実在する Ref）を満たせないので書かずに 保存の失敗 とする
    const log = this.log(stage);
    const ref = join('worklogs', `cli-${stage}.json`);
    if (!this.docRules && this.docRulesIntended && !log.unconfirmed.includes(this.docRulesIntended.missing)) log.unconfirmed.push(this.docRulesIntended.missing);
    const rules = this.docRules ?? this.docRulesIntended?.rules ?? null;
    if (rules) this.writeRecordFile(ref, JSON.stringify(cliWorklog(stage, log, rules, this.targets.map((t) => t.id).join('・') || this.runId), null, 2), { kind: 'worklog' });
    else this.saveFailed('worklog', ref, '文書規約を読めないので、作業記録の document_rules を決められない');
    this.stageConfirmed = stage;
    this.writeState();
  }

  notCreatedFor(role, why) { for (const kind of ROLE_OUTPUTS[role] ?? []) this.notCreated.push({ kind, reason: why }); }

  // ---- 受付 ----
  acceptance() {
    this.enterStage('受付');
    const docBytes = readFileSync(DOC_RULES_PATH);
    const version = sha256Bytes(docBytes);
    const docRef = docRulesRefOf(version);
    this.docRulesIntended = { rules: { ref: docRef, version }, missing: `適用した文書規約の写し ${docRef} を保存できなかった` };
    if (this.writeRecordFile(docRef, docBytes, { kind: 'document_rules' })) this.docRules = { ref: docRef, version };
    const log = this.log();
    let raw;
    try { raw = JSON.parse(readFileSync(join(this.runDir, 'request.input.json'), 'utf8')); } catch (e) { throw new Error(`依頼を読めない: ${e.message}`); }
    this.requestRaw = raw;
    const limit = raw && typeof raw === 'object' ? raw.time_limit_seconds : undefined;
    this.clock = startRunClock(Number.isSafeInteger(limit) && limit >= 1 ? limit : null);
    const { problems, unknownKeys } = checkRequestShape(raw);
    let all = [...problems];
    const fetched = new Map();
    if (problems.length === 0) {
      for (const t of raw.targets) {
        const f = fetchTarget(t, { workspace: this.workspace });
        if (!f.ok) { all.push({ request_code: f.code, item: { kind: 'target', id: t.id }, field: `/targets/${raw.targets.indexOf(t)}`, detail: f.detail }); continue; }
        fetched.set(t.id, f.target);
      }
      const view = new Map([...fetched].map(([id, t]) => [id, { files: new Map(t.files.map((f) => [f.path, { text: f.text, lines: f.bytes ? lineCount(f.bytes) : 0 }])) }]));
      all = [...all, ...checkPointers(raw, view)];
    }
    log.actions.push('依頼の形・識別子・範囲・時間の上限を照らし、対象を取得して版と指紋を固定した。');
    if (all.length) {
      for (const p of all) this.interrupts.push(reason('依頼の不備', '受付', p.detail, { request_code: p.request_code, item: p.item, field: p.field }));
      log.results.push(`受け付けない依頼（${[...new Set(all.map((p) => p.request_code))].join('・')}）なので検証を始めない。`);
      log.failures.push(...all.map((p) => `依頼の不備 ${p.request_code}: ${p.detail}`));
      this.notCreated.push({ kind: 'request', reason: '依頼を受け付けなかった' }, { kind: 'target_snapshot', reason: '依頼を受け付けなかった' });
      this.requestScope = problems.length ? { include: [], exclude: [] } : this.scopeOf(raw);
      this.leaveStage('受付');
      return false;
    }
    for (const k of unknownKeys) this.unverified.push({ item: `依頼の未知のキー: ${k}`, reason: '依頼の未知のキーは使わない' });
    const fixedById = new Map();
    for (const t of raw.targets) {
      const tg = fetched.get(t.id);
      let written;
      try { written = writeManifest(this.runDir, tg, this.workspace); } catch (e) { this.saveFailed('target_snapshot', `targets/${t.id}/manifest.json`, `対象の一覧を書けない（${e.code ?? e.message}）`); continue; }
      this.entries.push(ledgerEntry({ kind: 'target_snapshot', ref: written.ref, hash: written.hash, stage: '受付' }));
      fixedById.set(t.id, { revision: tg.revision, content_hash: tg.content_hash, root: tg.root, manifest_ref: written.ref,
        files: tg.files.map((f) => ({ path: f.path, abs_path: f.abs, content_hash: f.content_hash, text: f.text })) });
      this.targets.push(tg);
    }
    if (!this.halted()) {
      this.request = normalizeRequest(raw, fixedById);
      this.writeRecordFile('request.json', JSON.stringify(this.request, null, 2), { kind: 'request' });
      log.results.push(`依頼を受け付けた。対象 ${this.targets.length} 件の一覧と指紋を保存した（写しは作らない）。`);
      // 固定の前提の確かめ方の限界（architecture.md「対象の固定」）
      this.unverified.push({ item: '対象の固定', reason: '固定の前提は、集約の段の読み直しと、担当の query の時点の指紋でしか確かめない。途中で変わって元に戻り、その間に query が無ければ見つけられない' });
      // 担当の義務だけで守る限界（architecture.md「未検証と限界」の担当の書込み範囲と、担当に渡す資料の範囲）
      this.unverified.push({ item: '担当の読む範囲', reason: '担当が渡された行の範囲（spans）の外を読まないことは担当の義務だけで守り、CLI は機械では止めない（query が拒むのは資料の外の ref だけ）' });
      this.unverified.push({ item: '担当の書込み範囲', reason: '担当は workspace-write で動き、attempt の領域の外（状態・台帳・他の担当の領域）に書かないことは担当の義務だけで守る。CLI は登録した成果物の改ざんを指紋で見つけるが、登録の前の書換えは見つけられない' });
    }
    this.requestScope = this.scopeOf(raw);
    this.leaveStage('受付');
    return !this.halted();
  }

  scopeOf(raw) {
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.targets) || !Array.isArray(raw.goals)) return { include: [], exclude: [] };
    try {
      const n = normalizeRequest(raw, new Map());
      return { include: n.scope.include, exclude: n.scope.exclude };
    } catch { return { include: [], exclude: [] }; }
  }

  // ---- 作成役の出し直し（architecture.md「段と処理の順序」の修正の巡） ----
  // unit: { role, spec() → spec, check(ret, task) → { defects, value }, accept(last), onFail(why), observe?(ret), onAccept?() }
  // 作成役は 1 体が submit ごとに照合を受け、欠陥が減っているうちは同じ体が出し直す（call.mjs の submit）。
  // observe は、その提出の照合の前に呼ぶ（unit をまたぐ照合が、他の unit の最新の提出と比べるため）。onAccept は submit で受理した時点で呼ぶ
  async authorRounds(units) {
    const results = await runItems(this, units.map((u) => ({ spec: u.spec(), check: u.check, observe: u.observe, onAccept: u.onAccept })));
    units.forEach((u, i) => this.settleAuthor(u, results[i]));
  }

  // 作成役の担当の結果を unit に渡す。受理した提出の照合の欠陥（残ったもの）は、syntax・reference の確認のために控える
  settleAuthor(u, r) {
    if (r.ok && r.last) {
      this.checkedDefects.push({ stage: r.task.context.stage, defects: r.last.defects });
      u.accept(r.last);
      return;
    }
    u.onFail(r.notIssued ? (r.cause ?? '時間の上限か保存の失敗で担当を出さなかった') : `担当の失敗（${r.cause}）`);
  }

  // 採った分割に対象の無い契約・合成の条件の検査（取り消した分割を含む）は、欠陥の残った要素として実行しない。分割の取り消しと計画の受理の
  // どちらからも呼ぶので、閉じる時点の順（分割の取り消しが計画の受理より先か後か）に依らない
  dropPartitionlessChecks() {
    if (!this.plan) return;
    const ids = new Set([...(this.partitions?.data.contracts ?? []), ...(this.partitions?.data.composition_conditions ?? [])].map((x) => x.id));
    for (const c of this.plan.data.checks) {
      if (c.kind === 'property' || ids.has(c.target_id) || this.planDefects.has(c.id)) continue;
      this.planDefects.set(c.id, this.partitionRevoked ? '分割の受理を取り消したので、検査の対象が無い' : '分割を採っていないので、検査の対象が無い');
    }
  }

  // 閉じた時点で渡した受理を取り消す（call.mjs の revoke。受理した後に attempt の領域が書き換わった担当）。その担当の記録を台帳に残さず、
  // その担当の query の登録を外し、成果物を作れなかった記録にする
  revokeAuthor(role, r) {
    const prefix = `${relative(this.runDir, r.task.attempt_dir)}/`;
    this.entries = this.entries.filter((e) => e.producer !== r.task.task_id);
    for (const m of [this.queryRefs, this.smtBad]) for (const ref of [...m.keys()]) if (ref.startsWith(prefix)) m.delete(ref);
    this.notCreatedFor(role, r.cause);
    this.log('計画').failures.push(`${role} の受理を取り消した: ${r.cause}`);
  }

  registerAuthor(last, kinds) {
    const { ret, task, materials } = last;
    let ok = this.registerAgentFile('worklog', ret.worklog_ref, task, materials);
    for (const o of ret.outputs) if (kinds.includes(o.kind)) ok = this.registerAgentFile(o.kind, o.ref, task, materials) && ok;
    return ok;
  }

  // 作成役の問いを控え、blocked_by_question（性質の id）の性質が依存する問いを決める（artifact-formats.md「AuthorReturn.blocked_by_question」）。
  // 抽出役の依存の正本は inventory の性質ごとの blocked_by_question（問いの id）なので、ここでは問いだけを控える。
  noteQuestions(ret, role) {
    for (const q of ret.questions) {
      if (!this.authorQuestions.some((x) => x.q.id === q.id)) this.authorQuestions.push({ q, role, outputRefs: ret.outputs.map((o) => o.ref) });
    }
    if (role === 'extractor') return;
    for (const pid of ret.blocked_by_question) {
      const affecting = ret.questions.filter((q) => q.affected.includes(pid)).map((q) => q.id);
      const qids = affecting.length ? affecting : ret.questions.map((q) => q.id);
      if (!this.blockedBy.has(pid)) this.blockedBy.set(pid, new Set());
      for (const qid of qids) this.blockedBy.get(pid).add(qid);
    }
  }

  inventoryProperties() { return this.inventories.flatMap((i) => i.data.properties.map((p) => ({ ...p, target_id: i.target_id }))); }

  // ---- 洗い出し ----
  async extraction() {
    // 対象をまたぐ性質と要素の id の重複（id は run の全ての inventory を通して一意）。比べる相手は、他の対象の最新の inventory
    // （提出ごとに照合の前に observe で控える。差し戻された提出も入る）。重なりをどちらの欠陥にするかは、提出の順序に依らず次で決める:
    // 相手が受理済みなら、今 submit している側の欠陥にする（受理済みの側は変えない）。相手が未受理なら、依頼の対象の順で後ろの側だけの
    // 欠陥にする（今の側が前なら欠陥にせず、後ろの側が submit するときに見つかる）。未受理の 2 つが互いを差し戻し合わないため
    const latestIds = new Map();
    const accepted = new Set();
    const order = new Map(this.targets.map((t, i) => [t.id, i]));
    const readInventory = (ret) => {
      const outs = ret.outputs.filter((o) => o.kind === 'inventory');
      if (outs.length !== 1) return null;
      try { return { ref: outs[0].ref, data: JSON.parse(readFileSync(join(this.runDir, outs[0].ref), 'utf8')) }; } catch { return null; }
    };
    const idsOf = (data, key) => new Set((Array.isArray(data?.[key]) ? data[key] : []).map((x) => x && x.id).filter((id) => typeof id === 'string'));
    const blames = (tid, other) => other !== tid && (accepted.has(other) || order.get(other) < order.get(tid));
    const otherIds = (tid, key) => new Map([...latestIds].filter(([id]) => blames(tid, id)).flatMap(([id, ids]) => [...ids[key]].map((x) => [x, id])));
    const units = this.targets.map((t) => ({
      role: 'extractor',
      spec: () => ({ role: 'extractor', stage: '洗い出し', target_id: t.id, input_refs: [{ name: 'request', ref: 'request.json' }, { name: 'manifest', ref: join('targets', t.id, 'manifest.json') }, ...this.targetFileRefs(t.id)] }),
      observe: (ret) => {
        const inv = readInventory(ret);
        latestIds.set(t.id, { properties: idsOf(inv?.data, 'properties'), elements: idsOf(inv?.data, 'elements') });
      },
      onAccept: () => { accepted.add(t.id); },
      check: (ret) => {
        const outs = ret.outputs.filter((o) => o.kind === 'inventory');
        if (outs.length !== 1) return { defects: [defect('other', 'inventory-count', `inventory が ${outs.length} 個（ちょうど 1 つ）`)], value: null };
        const inv = readInventory(ret);
        if (!inv) return { defects: [defect('syntax', 'inventory-read', 'inventory を読めない')], value: null };
        const defects = coverageCheck(this.runDir, inv.data, t, { otherPropertyIds: otherIds(t.id, 'properties'), otherElementIds: otherIds(t.id, 'elements'), scope: this.requestScopeOf(t.id).get(t.id) });
        return { defects, value: inv };
      },
      accept: (last) => {
        if (!last.value) { this.notCreated.push({ kind: 'inventory', reason: '抽出役の成果物が形に合わない' }); return; }
        if (!this.registerAuthor(last, ['inventory'])) return;
        if (last.defects.length) this.log('洗い出し').unconfirmed.push(...last.defects.map((d) => `抽出の欠陥が残った: ${d.text}`));
        this.noteQuestions(last.ret, 'extractor');
        for (const p of last.value.data.properties ?? []) for (const q of p.blocked_by_question ?? []) {
          if (!this.blockedBy.has(p.id)) this.blockedBy.set(p.id, new Set());
          this.blockedBy.get(p.id).add(q);
        }
        if (Array.isArray(last.value.data.properties)) this.inventories.push({ target_id: t.id, ref: last.value.ref, data: last.value.data, task: last.task });
      },
      onFail: (why) => this.notCreated.push({ kind: 'inventory', reason: why }),
    }));
    this.log().actions.push('対象ごとに抽出役を出し、走査範囲の網羅・出所・引用の指紋を照らした。');
    await this.authorRounds(units);
    this.log().results.push(`inventory ${this.inventories.length} 件を回収した。`);
  }

  // ---- モデル化 ----
  async modelling() {
    const eligible = this.inventoryProperties().filter((p) => !this.blockedBy.has(p.id));
    if (eligible.length === 0) {
      this.notCreatedFor('model-author', '対象にする性質が無いのでモデル作成役を出さなかった');
      this.log().results.push('対象にする性質が無いので、モデル作成役を出さなかった。');
      return;
    }
    const eligibleSet = new Set(eligible.map((p) => p.id));
    const inputs = [{ name: 'request', ref: 'request.json' }, ...this.inventories.map((i) => ({ name: `inventory-${i.target_id}`, ref: i.ref })), ...this.targets.flatMap((t) => [{ name: `manifest-${t.id}`, ref: join('targets', t.id, 'manifest.json') }, ...this.targetFileRefs(t.id)])];
    const unit = {
      role: 'model-author',
      spec: () => ({ role: 'model-author', stage: 'モデル化', property_ids: eligible.map((p) => p.id), input_refs: inputs }),
      check: (ret, task) => {
        const prefix = `${relative(this.runDir, task.attempt_dir)}/`;
        const refs = {
          elementIds: new Set(this.inventories.flatMap((i) => i.data.elements.map((e) => e.id))),
          propertyIds: new Set(this.inventoryProperties().map((p) => p.id)),
          goalIds: new Set((this.request?.goals ?? []).map((g) => g.id)),
          knownRequirementIds: new Set((this.request?.known_requirements ?? []).map((k) => k.id)),
          targetIds: new Set(this.targets.map((t) => t.id)),
          externalDependencyIds: new Set(this.inventories.flatMap((i) => i.data.external_dependencies.map((d) => d.id))),
        };
        const c = modelCheck(this.runDir, ret.outputs, { prefix, eligible: eligibleSet, refs });
        return { defects: c.defects, value: c };
      },
      accept: (last) => {
        const c = last.value;
        if (!this.registerAuthor(last, [])) return;
        this.noteQuestions(last.ret, 'model-author');
        for (const m of c.models) {
          if (!this.registerAgentFile('model', m.ref, last.task, last.materials)) continue;
          if (!this.registerAgentFile('mapping', m.mapping.ref, last.task, last.materials)) continue;
          this.models.push(m);
        }
        for (const [ref, info] of c.queryRefs) {
          if (!c.texts.has(ref)) continue;
          if (this.registerAgentFile('query', ref, last.task, last.materials)) this.queryRefs.set(ref, info);
        }
        this.smtBad = new Map(c.smtBad);
        if (c.models.length === 0) this.notCreatedFor('model-author', 'モデル作成役の成果物が形に合わない');
        if (last.defects.length) this.log('モデル化').unconfirmed.push(...last.defects.map((d) => `モデル化の欠陥が残った: ${d.text}`));
      },
      onFail: (why) => this.notCreatedFor('model-author', why),
    };
    this.log().actions.push('モデル作成役を出し、モデルと対応表の形、query の構文を照らした。');
    await this.authorRounds([unit]);
    this.combinations = this.models.map((m) => ({ model: m, combinations: matrixGen(m.data) }));
    this.log().results.push(`モデル ${this.models.length} 件を回収した。`);
  }

  // ---- 計画 ----
  async planning() {
    const t0 = process.hrtime.bigint();
    this.prepare = await z3.prepare();
    this.prepareMs = Number((process.hrtime.bigint() - t0) / 1000000n);
    if (!this.prepare.ok) this.log().unconfirmed.push(`z3 を準備できない: ${this.prepare.reason}`);
    const read = (ref) => readRunText(this.runDir, ref);
    this.graph = buildGraph(this.models.map((m) => ({ model: m.data, ref: m.ref })), read);
    this.candidates = deriveCandidates(this.graph);
    this.log().actions.push('依存グラフを構文から導き、writer-merge-scc/1 で分割の候補を導いた。');
    if (this.halted()) return;
    const modelInputs = this.models.flatMap((m) => [{ name: `model-${m.id}`, ref: m.ref }, { name: `mapping-${m.id}`, ref: m.mapping.ref }]);
    // 分割（候補が 2 つ以上のとき）と計画は、1 体の worker が順に担う。計画の担当は分割の担当が閉じてから claim に出る（依存つきの担当）。
    // 分割の結果は閉じた時点で受け取り（settle）、計画の担当の資料と照合に使う
    const items = [];
    if (this.candidates.length >= 2 && this.models.length) {
      const cands = this.candidates.map(({ id, nodes }) => ({ id, nodes }));
      const known = new Set((this.request?.known_requirements ?? []).map((k) => k.id));
      const unit = {
        role: 'partition-author',
        spec: () => ({ role: 'partition-author', stage: '計画', candidates: cands, input_refs: modelInputs }),
        check: (ret, task) => {
          const outs = ret.outputs.filter((o) => o.kind === 'partitions');
          if (outs.length !== 1) return { defects: [defect('other', 'partitions-count', 'partitions がちょうど 1 つでない')], value: null };
          let data;
          try { data = JSON.parse(readFileSync(join(this.runDir, outs[0].ref), 'utf8')); } catch { return { defects: [defect('syntax', 'partitions-read', 'partitions を読めない')], value: null }; }
          const prefix = `${relative(this.runDir, task.attempt_dir)}/`;
          const c = partitionCheck(this.runDir, data, { candidates: cands, graph: this.graph, models: this.models, prefix, knownRequirementIds: known });
          return { defects: c.defects, value: { ref: outs[0].ref, data, check: c } };
        },
        accept: (last) => {
          // 欠陥の残った分割（形の違い・読めない・個数の違いを含む）は採らない（artifact-formats.md「欠陥の残った分割」）。
          // 計画作成役には分割の無いモデルだけを渡す
          this.partitionDefects = last.defects;
          const reject = () => {
            this.partitionRejected = true;
            this.decisions = this.candidates.map((c) => ({ candidate_id: c.id, adopted: false, reason: PARTITION_REJECTED }));
            this.log('計画').unconfirmed.push(...last.defects.map((d) => `分割の欠陥が残った: ${d.text}`));
          };
          if (!last.value || !last.value.check.valid) { this.notCreatedFor('partition-author', '分割作成役の成果物が形に合わない'); reject(); return; }
          if (!this.registerAuthor(last, ['partitions'])) return;
          const { data, check } = last.value;
          if (last.defects.length) { reject(); return; }
          this.decisions = data.decisions;
          if (data.adopted) {
            const queries = [...data.contracts, ...data.composition_conditions].map((x) => x.query_ref);
            for (const q of queries) if (this.registerAgentFile('query', q, last.task, last.materials)) this.queryRefs.set(q, { kind: 'partition' });
            for (const [ref, v] of check.smtBad) this.smtBad.set(ref, v);
            this.partitions = { ref: last.value.ref, data };
          }
        },
        onFail: (why) => this.notCreatedFor('partition-author', why),
        revoke: (r) => {
          this.revokeAuthor('partition-author', r);
          this.partitions = null;
          this.decisions = [];
          this.partitionRevoked = true;
          this.dropPartitionlessChecks();
        },
      };
      this.log().actions.push('分割の候補が 2 つ以上あるので、分割と計画を順に担う 1 体の worker に分割の担当を出し、分割を照らした。');
      items.push({ spec: unit.spec(), check: unit.check, settle: (r) => this.settleAuthor(unit, r), revoke: unit.revoke });
    }
    const modelProps = this.models.flatMap((m) => m.data.properties);
    if (modelProps.length === 0) this.notCreatedFor('plan-author', '計画する形式化できる性質が無いので計画作成役を出さなかった');
    else {
      const invProps = this.inventoryProperties();
      const formal = invProps.filter((p) => p.formalizable && !this.blockedBy.has(p.id) && modelProps.some((mp) => mp.inventory_property_ids.includes(p.id)));
      // 資料は分割の結果（採った分割）を見てから決める
      const inputs = () => [...modelInputs, ...(this.partitions ? [{ name: 'partitions', ref: this.partitions.ref }] : []), ...this.inventories.map((i) => ({ name: `inventory-${i.target_id}`, ref: i.ref }))];
      const unit = {
        role: 'plan-author',
        spec: () => ({ role: 'plan-author', stage: '計画', property_ids: formal.map((p) => p.id), input_refs: inputs() }),
        check: (ret, task) => {
          const read2 = (kind) => { const o = ret.outputs.find((x) => x.kind === kind); if (!o) return null; try { return { ref: o.ref, data: JSON.parse(readFileSync(join(this.runDir, o.ref), 'utf8')) }; } catch { return null; } };
          const plan = read2('plan');
          const mutations = read2('mutations');
          if (!plan || !mutations) return { defects: [defect('syntax', 'plan-missing', 'plan か mutations が無いか、JSON として読めない')], value: null };
          // この巡の返り値の blocked_by_question だけで照らす（問いと依存を控えるのは、受け入れた返り値の accept だけ）
          const blocked = new Set([...this.blockedBy.keys(), ...ret.blocked_by_question]);
          const eligible = new Set(formal.filter((p) => !blocked.has(p.id)).map((p) => p.id));
          const c = planCheck(plan.data, mutations.data, {
            runDir: this.runDir, prefix: `${relative(this.runDir, task.attempt_dir)}/`, models: this.models, partitions: this.partitions?.data ?? null,
            eligible, blocked, prepare: this.prepare, authorQueries: new Set(this.queryRefs.keys()), smtBad: this.smtBad,
            propertyIds: new Set(this.inventoryProperties().map((p) => p.id)),
          });
          return { defects: c.defects, value: { plan, mutations, check: c } };
        },
        accept: (last) => {
          this.noteQuestions(last.ret, 'plan-author');
          if (!last.value || !last.value.check.valid) { this.notCreatedFor('plan-author', '計画作成役の成果物が形に合わない'); return; }
          if (!this.registerAuthor(last, ['plan', 'mutations'])) return;
          const { plan, mutations, check } = last.value;
          for (const m of mutations.data.mutations) if (m.mutation_ref.startsWith(`${relative(this.runDir, last.task.attempt_dir)}/`)) this.registerAgentFile('query', m.mutation_ref, last.task, last.materials);
          this.plan = plan;
          this.mutations = mutations;
          this.planDefectList = last.defects;
          this.planDefects = defectiveElements(plan.data, mutations.data, last.defects, this.models, this.partitions?.data ?? null);
          // 分割作成役の query の違反が残った契約・合成の条件の検査は、欠陥の残った要素として実行しない
          for (const c of plan.data.checks) {
            if (c.kind === 'property') continue;
            const x = [...(this.partitions?.data.contracts ?? []), ...(this.partitions?.data.composition_conditions ?? [])].find((y) => y.id === c.target_id);
            if (x && this.smtBad.has(x.query_ref) && !this.planDefects.has(c.id)) this.planDefects.set(c.id, `${x.query_ref} が .smt2 の規則に反する（${this.smtBad.get(x.query_ref).join('・')}）`);
          }
          this.selectionOf = check.single;
          this.dropPartitionlessChecks();
          if (last.defects.length) this.log('計画').unconfirmed.push(...last.defects.map((d) => `計画の欠陥が残った: ${d.text}`));
        },
        onFail: (why) => this.notCreatedFor('plan-author', why),
        revoke: (r) => {
          this.revokeAuthor('plan-author', r);
          this.plan = null;
          this.mutations = null;
          this.planDefects = new Map();
          this.planDefectList = [];
          this.selectionOf = () => null;
        },
      };
      this.log().actions.push(items.length ? '分割の担当が閉じた後、同じ worker に計画の担当を出し、計画を照らした。' : '計画作成役を出し、計画を照らした。');
      // 中断の理由があれば、計画の担当を出さない（spec が null）
      items.push({ role: 'plan-author', stage: '計画', spec: items.length ? () => (this.halted() ? null : unit.spec()) : unit.spec(), check: unit.check, after: items.length ? 0 : undefined, settle: (r) => this.settleAuthor(unit, r), revoke: unit.revoke });
    }
    if (items.length) await runWorkers(this, [{ items }]);
    this.log().results.push(this.plan ? `計画を採った（検査 ${this.plan.data.checks.length} 件、欠陥の残った要素 ${this.planDefects.size} 件）。` : '計画が無い。');
  }

  planChecks() { return this.plan ? this.plan.data.checks.filter((c) => !this.planDefects.has(c.id)) : []; }
  planSanity() { return this.plan ? this.plan.data.sanity.filter((s) => !this.planDefects.has(s.id)) : []; }
  planMutations() { return this.mutations ? this.mutations.data.mutations.filter((m) => !this.planDefects.has(m.id)) : []; }
  mpInfo(mpId) { for (const m of this.models) { const p = m.data.properties.find((x) => x.id === mpId); if (p) return { model: m, p }; } return null; }
  parentsOf(x) { return this.mpInfo(x)?.p.inventory_property_ids ?? []; }
  derivedOf(targetId) {
    const x = [...(this.partitions?.data.contracts ?? []), ...(this.partitions?.data.composition_conditions ?? [])].find((y) => y.id === targetId);
    return x ? x.derived_from : null;
  }

  // ---- 実行 ----
  async execution() {
    const t0 = process.hrtime.bigint();
    const specs = [];
    let queue = specs;
    const deadline = this.clock.usableDeadlineWall;
    const queryOf = (refs) => Buffer.concat(refs.flatMap((r) => [readFileSync(join(this.runDir, r)), Buffer.from('\n')]));
    // source は input_refs（つないで道具に渡す）か、CLI が組み立てた query の文字列（静的な確認）
    const add = (id, kind, source, withModel, expected, seconds, dependsOn, meta) => {
      const entry = { id, kind, meta, expected, inputRef: null, outcome: null, evidence: [], notStartedReason: null, stats: null };
      this.exec.set(id, entry);
      let query;
      try { query = typeof source === 'string' ? Buffer.from(source, 'utf8') : queryOf(source); } catch (e) { entry.notStartedReason = `query を読めない（${e.code ?? e.message}）`; return; }
      const inputRef = join('checks', id, 'input.smt2');
      if (!this.writeRecordFile(inputRef, query, { kind: 'query' })) { entry.notStartedReason = '道具に渡す query を保存できない'; return; }
      entry.inputRef = inputRef;
      entry.queryText = query.toString('utf8');
      if (!this.prepare?.ok) { entry.notStartedReason = `適した道具が無い（${this.prepare?.reason ?? '準備していない'}）`; return; }
      queue.push({ spec: { execution_id: id, kind, query: new Uint8Array(query), with_model: withModel, expected, tool_time_limit_seconds: seconds, deadline_ms: deadline }, depends_on: dependsOn });
    };
    for (const c of this.planChecks()) add(c.id, c.kind, c.input_refs, MODEL_CHECK_KINDS.includes(c.kind), 'unsat', c.tool_time_limit_seconds, [...c.depends_on], { check: c });
    for (const s of this.planSanity()) add(this.confIds.next('sanity'), 'sanity', s.input_refs, false, 'sat', s.tool_time_limit_seconds, [], { sanity: s });
    for (const m of this.planMutations()) {
      const det = this.plan.data.checks.find((c) => c.id === m.detector_check_id);
      add(this.confIds.next('mutation'), 'mutation', [...det.input_refs.slice(0, -1), m.mutation_ref], false, m.expected_violation, det.tool_time_limit_seconds, [], { mutation: m, detector: det });
    }
    // 静的な確認の道具の実行（architecture.md「静的な確認」）: 否定だけ・前提と否定だけ・規則と否定だけ。道具が無ければ組み立てない
    this.ablations = this.prepare?.ok ? this.planChecks().filter((c) => c.kind === 'property').map((c) => this.planAblation(c, queryOf, add)).filter(Boolean) : [];
    this.log().actions.push(`道具の実行 ${this.exec.size} 件を、同時に動かす数の上限と検査に使える期限の下で動かした。`);
    if (this.clock.usableExpired()) { this.timeLimitReached('実行を始める時点で、検査に使える期限が過ぎていた'); for (const s of specs) this.abortExec(s.spec.execution_id, '時間の上限'); specs.length = 0; }
    await this.runSpecs(specs);
    // 反例の replay と、規則と否定だけで充足可能だった性質の前提を 1 つずつ外した再検査（同じ期限）
    const replaySpecs = [];
    queue = replaySpecs;
    for (const rec of this.ablations) {
      // 前提と否定だけが unsat で前提に外部の依存があれば、外部の依存の前提を外して出し直す（外部の依存でない前提だけで結論が出るか）
      const inner = rec.groups.premise.filter((n) => !rec.external.includes(n));
      if (rec.premise && rec.external.length && inner.length && answerOf(this.exec.get(rec.premise)) === 'unsat') {
        rec.internal = this.confIds.next('premise_only');
        add(rec.internal, 'ablation', ablate(rec.base, [...inner, ...rec.groups.goal]), false, 'sat', rec.check.tool_time_limit_seconds, [], { ablation: rec.check.id });
      }
      if (!rec.rule || answerOf(this.exec.get(rec.rule)) !== 'sat') continue;
      const g = rec.groups;
      if (BASE_ABLATIONS + g.premise.length > ABLATION_PER_PROPERTY_MAX) { rec.over = true; continue; }
      for (const name of g.premise) {
        const id = this.confIds.next('premise_load');
        add(id, 'ablation', ablate(rec.base, [...g.rule, ...g.premise.filter((n) => n !== name), ...g.goal]), false, 'unsat', rec.check.tool_time_limit_seconds, [], { ablation: rec.check.id });
        rec.perPremise.push({ name, id });
      }
    }
    for (const c of this.planChecks()) {
      if (!MODEL_CHECK_KINDS.includes(c.kind)) continue;
      const e = this.exec.get(c.id);
      if (!e || !e.outcome || verdictOf(e.outcome.end) !== '反例') continue;
      const rid = this.confIds.next('replay');
      const r = { id: rid, kind: 'replay', meta: { cex: c }, inputRef: null, outcome: null, evidence: [], notStartedReason: null, stats: null };
      this.exec.set(rid, r);
      this.replays.set(c.id, rid);
      const w = this.witness(e);
      if (!w.ok) { r.notStartedReason = w.reason; r.unfixed = w.unfixed ?? null; continue; }
      const text = z3.replayQuery(e.queryText, w.asserts);
      if (text === null) { r.notStartedReason = '反例の検査の query に (check-sat) がちょうど 1 つ無い'; continue; }
      const ref = join('checks', rid, 'input.smt2');
      if (!this.writeRecordFile(ref, text, { kind: 'query' })) { r.notStartedReason = 'replay の query を保存できない'; continue; }
      r.inputRef = ref;
      r.unfixed = w.unfixed;
      replaySpecs.push({ spec: { execution_id: rid, kind: 'replay', query: new Uint8Array(Buffer.from(text, 'utf8')), with_model: false, expected: 'sat', tool_time_limit_seconds: c.tool_time_limit_seconds, deadline_ms: deadline }, depends_on: [] });
    }
    if (replaySpecs.length && this.clock.usableExpired()) { for (const s of replaySpecs) this.abortExec(s.spec.execution_id, '時間の上限'); replaySpecs.length = 0; this.timeLimitReached('replay を始める時点で、検査に使える期限が過ぎていた'); }
    await this.runSpecs(replaySpecs);
    // 前提を 1 つずつ外して unsat だった前提が 2 つ以上あり、他の前提もあるなら、それらをまとめて外した再検査を出す（一部だけ重なって効く前提）。
    // 全ての前提が unsat なら、まとめて外した query は規則と否定だけと同じなので出さない。この 1 つも ABLATION_PER_PROPERTY_MAX に数えない
    const groupSpecs = [];
    queue = groupSpecs;
    for (const rec of this.ablations) {
      const rest = rec.perPremise.filter((pp) => answerOf(this.exec.get(pp.id)) === 'unsat').map((pp) => pp.name);
      if (rest.length < 2 || rest.length === rec.groups.premise.length) continue;
      rec.overlap = { names: rest, id: this.confIds.next('premise_load') };
      const g = rec.groups;
      add(rec.overlap.id, 'ablation', ablate(rec.base, [...g.rule, ...g.premise.filter((n) => !rest.includes(n)), ...g.goal]), false, 'unsat', rec.check.tool_time_limit_seconds, [], { ablation: rec.check.id });
    }
    if (groupSpecs.length && this.clock.usableExpired()) { for (const x of groupSpecs) this.abortExec(x.spec.execution_id, '時間の上限'); groupSpecs.length = 0; this.timeLimitReached('前提の組の再検査を始める時点で、検査に使える期限が過ぎていた'); }
    await this.runSpecs(groupSpecs);
    for (const e of this.exec.values()) {
      if (e.outcome && e.outcome.end.stopped_by === '時間') this.timeLimitReached('検査に使える期限に達したので、実行中の道具を止めた');
      if (e.outcome && !e.outcome.end.started && e.outcome.not_started_reason !== 'dependency' && this.clock.limited && this.clock.usableExpired()) this.timeLimitReached('検査に使える期限に達したので、始めていない実行を始めなかった');
    }
    this.buildConfirmationsAfterExecution();
    this.timing.checksMs = Number((process.hrtime.bigint() - t0) / 1000000n);
    this.log().results.push(`実行 ${this.exec.size} 件を終えた。反例 ${this.counterexamples.length} 件。`);
  }

  // 1 つの性質の検査について、静的な確認の道具の実行を組み立てる。節を役ごとに切り取れなければ（clauseShapeProblem）実行せず、shape に理由を置く。
  planAblation(c, queryOf, add) {
    const info = this.mpInfo(c.target_id);
    if (!info) return null;
    const external = info.p.clauses.filter((x) => x.role === 'premise' && x.basis === '外部の依存').map((x) => x.name);
    const rec = { check: c, mp: info.p.id, p: info.p, groups: clauseGroups(info.p.clauses), external, base: null, shape: null, goal: null, premise: null, rule: null, internal: null, perPremise: [], over: false };
    try { rec.base = queryOf(c.input_refs).toString('utf8'); } catch (e) { rec.shape = `検査の入力を読めない（${e.code ?? e.message}）`; return rec; }
    rec.shape = clauseShapeProblem(rec.base, info.p.clauses);
    if (rec.shape) return rec;
    const g = rec.groups;
    const run = (kind, keep, expected) => { const id = this.confIds.next(kind); add(id, 'ablation', ablate(rec.base, keep), false, expected, c.tool_time_limit_seconds, [], { ablation: c.id }); return id; };
    rec.goal = run('goal_trivial', g.goal, 'sat');
    if (g.premise.length) {
      rec.premise = run('premise_only', [...g.premise, ...g.goal], 'sat');
      rec.rule = run('premise_load', [...g.rule, ...g.goal], 'unsat');
    }
    return rec;
  }

  async runSpecs(specs) {
    if (!specs.length) return;
    const ac = new AbortController();
    const handles = new Map();
    const makeIo = (spec) => ({
      clock: NODE_TIMER_CLOCK,
      signal: ac.signal,
      spawn: (ex) => {
        const h = spawnTool({ executable: this.prepare.executable, args: z3.argsFor(ex), stdin: Buffer.from(ex.query), runDir: this.runDir });
        handles.set(spec.execution_id, h);
        return h;
      },
    });
    let outcomes;
    try { outcomes = await runExecutions(specs, { makeIo, signal: ac.signal }); } catch (e) {
      // 実行中の道具を止めてから、段の 内部の誤り として投げ直す
      ac.abort();
      for (const h of handles.values()) h.killGroup();
      throw e;
    }
    for (const [id, o] of outcomes) {
      const e = this.exec.get(id);
      e.outcome = o;
      const h = handles.get(id);
      e.stats = h ? h.stats : null;
      if (verdictOf(o.end) === null) {
        e.invalidEnd = invalidEndReason(o.end);
        this.interrupt('内部の誤り', `実行 ${id} の終わり方が契約の起こらない組（${e.invalidEnd}）`);
      }
      if (!o.end.started) {
        if (o.start_failure) { e.notStartedReason = o.start_failure; this.log().failures.push(`実行 ${id}: ${o.start_failure}`); } else if (o.not_started_reason === 'dependency') e.notStartedReason = '依存先の検査が 成功 でない';
        else this.abortExec(id, '検査に使える期限が過ぎていたか、停止の要求があった');
        continue;
      }
      const dir = join('checks', id);
      if (this.writeRecordFile(join(dir, 'stdout.txt'), Buffer.from(o.stdout), { kind: 'execution_evidence' })) e.evidence.push(join(dir, 'stdout.txt'));
      else e.stdoutUnsaved = true;
      if (this.writeRecordFile(join(dir, 'stderr.txt'), Buffer.from(o.stderr), { kind: 'execution_evidence' })) e.evidence.push(join(dir, 'stderr.txt'));
      if (this.writeRecordFile(join(dir, 'end.json'), JSON.stringify(o.end), { kind: 'execution_evidence' })) e.evidence.push(join(dir, 'end.json'));
    }
  }

  // 証人を読む（cli-contract.md「証人」）。保存と再読込の照合に通った stdout.txt からだけ読む。
  witness(e) {
    if (e.outcome.model_cut === 'truncated') return { ok: false, reason: `証人を読めない: ${TRUNCATED}` };
    if (e.outcome.model_cut === 'stopped_after_answer') return { ok: false, reason: '証人を読めない: 答えの後にモデルを読む間に期限か停止の要求が来たので、モデルを読み切っていない' };
    const ref = join('checks', e.id, 'stdout.txt');
    const entry = this.entries.find((x) => x.ref === ref);
    if (!entry || e.stdoutUnsaved) return { ok: false, reason: '証人を読めない: 標準出力を保存できなかった' };
    let text;
    try { const b = readFileSync(join(this.runDir, ref)); if (sha256Bytes(b) !== entry.hash) return { ok: false, reason: '証人を読めない: 標準出力の再読込の指紋が一致しない' }; text = b.toString('utf8'); } catch { return { ok: false, reason: '証人を読めない: 標準出力を読み直せない' }; }
    const s = z3.splitAnswer(text);
    if (!s || s.model.trim().length === 0) return { ok: false, reason: '証人を読めない: モデルが無い' };
    const w = z3.readWitness(s.model, e.queryText);
    if (!w.ok) return { ok: false, reason: `証人を読めない: ${w.reason}`, unfixed: w.unfixed };
    return w;
  }

  buildConfirmationsAfterExecution() {
    const end = (e) => (e.outcome ? e.outcome.end : { ...NOT_STARTED_END });
    const materials = (e) => (e.inputRef ? [{ ref: e.inputRef, hash: this.entries.find((x) => x.ref === e.inputRef)?.hash }].filter((m) => m.hash) : []);
    const why = (e, base) => {
      if (!e.outcome || !e.outcome.end.started) return `${base}を始めなかった: ${e.notStartedReason ?? '不明'}`;
      const r = confirmationResult(e.outcome.end);
      return `${base}の道具の終わり方に classifyCheck を当てた値は ${verdictOf(e.outcome.end) ?? '起こらない組'}（${r}）`;
    };
    for (const e of this.exec.values()) {
      if (e.kind === 'sanity') {
        const s = e.meta.sanity;
        this.confirmations.deterministic.push({ id: e.id, kind: 'sanity', property_ids: [...this.parentsOf(s.model_property_id)], model_property_id: s.model_property_id, plan_id: s.id,
          item: `前提の整合 ${s.id}（モデルの性質 ${s.model_property_id}）`, result: confirmationResult(end(e)), checker: 'cli', materials: materials(e), end: end(e), reason: why(e, '前提の整合の確認') });
      } else if (e.kind === 'mutation') {
        const m = e.meta.mutation;
        this.confirmations.deterministic.push({ id: e.id, kind: 'mutation', property_ids: [...this.parentsOf(m.property_id)], model_property_id: m.property_id, plan_id: m.id,
          item: `変異 ${m.id} の検出（期待する違反 ${m.expected_violation}）`, result: confirmationResult(end(e)), checker: 'cli', materials: materials(e), end: end(e), reason: why(e, '変異の検出の確認') });
      }
    }
    // 反例
    let n = 0;
    for (const c of this.planChecks()) {
      if (!MODEL_CHECK_KINDS.includes(c.kind)) continue;
      const e = this.exec.get(c.id);
      if (!e || !e.outcome || verdictOf(e.outcome.end) !== '反例') continue;
      const mp = c.kind === 'property' ? c.target_id : this.derivedOf(c.target_id);
      const rid = this.replays.get(c.id);
      const r = this.exec.get(rid);
      const parents = this.parentsOf(mp);
      for (const pid of parents) {
        n += 1;
        this.counterexamples.push({ id: `cex-${n}`, property_id: pid, check_id: c.id, mp, replayId: rid });
      }
      const unfixed = r.unfixed && r.unfixed.length ? `固定しなかった記号（宣言の順）: ${r.unfixed.join(', ')}` : null;
      const reasonText = r.outcome && r.outcome.end.started
        ? [`反例の再実行の終わり方に classifyCheck を当てた値は ${verdictOf(r.outcome.end) ?? '起こらない組'}`, unfixed].filter(Boolean).join('。')
        : [r.notStartedReason ?? '証人を読めない', unfixed].filter(Boolean).join('。');
      this.confirmations.deterministic.push({ id: rid, kind: 'replay', property_ids: [...parents], model_property_id: mp, plan_id: null,
        item: `反例の再実行 ${c.id}`, result: r.outcome ? confirmationResult(r.outcome.end) : '確認できず', checker: 'cli', materials: materials(r), end: r.outcome ? r.outcome.end : { ...NOT_STARTED_END }, reason: reasonText });
    }
    // 全ての計画した検査の結果の有無（SP-012 の決定的な検査）
    if (this.plan) {
      const missing = this.plan.data.checks.filter((c) => this.planDefects.has(c.id)).map((c) => c.id);
      this.confirmations.deterministic.push({ id: this.confIds.next('result_presence'), kind: 'result_presence', property_ids: [], model_property_id: null, plan_id: null,
        item: '計画した全ての検査の結果', result: missing.length ? '成り立たない' : '成り立つ', checker: 'cli', materials: [], end: null,
        reason: missing.length ? `欠陥が残った計画の検査 ${missing.join(', ')} は実行せず、結果が無い` : '計画した全ての検査に結果（終わり方と判定）がある' });
    }
    this.buildStaticConfirmations(end, materials, why);
  }

  // 静的な確認（SP-FORMALMETHOD-012 の表、architecture.md「静的な確認」）。成り立つ・成り立たないと断定できたものは
  // confirmations.deterministic に、断定できない節の付け方は confirmations.judgments（判断を要する項目）に置く。
  // 道具を実行した確認の id は、その実行の execution_id と同じ。
  buildStaticConfirmations(end, materials, why) {
    if (!this.plan) return;
    const det = (o) => this.confirmations.deterministic.push({ checker: 'cli', end: null, materials: [], ...o });
    const judge = (o) => this.confirmations.judgments.push({ end: null, materials: [], ...o });
    const fromExec = (id) => { const e = this.exec.get(id); return { id, e, answer: answerOf(e), end: end(e), materials: materials(e) }; };
    const undecided = (x, base, names) => ({ id: x.id, cause: '道具が判定できない', clause_names: names, end: x.end, materials: x.materials, reason: `${why(x.e, base)}。判定できないので意味の確認で確かめる` });
    const list = (xs) => xs.join(', ');
    for (const rec of this.ablations ?? []) {
      const c = rec.check;
      const g = rec.groups;
      const base = { property_ids: [...this.parentsOf(rec.mp)], model_property_id: rec.mp, plan_id: c.id };
      const ITEM = { goal_trivial: `性質の否定だけの充足可能性（検査 ${c.id}）`, premise_only: `前提と性質の否定だけの充足可能性（検査 ${c.id}）`, premise_load: `結論を支える前提（検査 ${c.id}）` };
      // 節を役ごとに切り取れない検査は、静的な確認を実行しない。決定的な検査を意味の確認で代えず（SP-012）、未実行の確認として残す
      if (rec.shape) {
        for (const kind of ['goal_trivial', 'premise_only', 'premise_load']) det({ ...base, id: this.confIds.next(kind), kind, item: ITEM[kind], result: '確認できず', reason: `${rec.shape}。静的な確認の道具の実行を組み立てなかった（未実行）ので、この確認は成り立たない` });
        continue;
      }
      // 否定だけ
      const goal = fromExec(rec.goal);
      const goalResult = { sat: '成り立つ', unsat: '成り立たない' }[goal.answer];
      if (goalResult) det({ ...base, id: goal.id, kind: 'goal_trivial', item: ITEM.goal_trivial, result: goalResult, end: goal.end, materials: goal.materials,
        reason: goalResult === '成り立つ' ? `性質の否定の節（${list(g.goal)}）だけで充足可能（sat）` : `性質の否定の節（${list(g.goal)}）だけで充足不能（unsat）なので、性質が自明である` });
      else judge({ ...base, kind: 'goal_trivial', item: ITEM.goal_trivial, ...undecided(goal, '性質の否定だけの実行', g.goal) });
      // 前提と否定だけ（前提が無ければ、否定だけの実行と同じ query）
      const prem = g.premise.length ? fromExec(rec.premise) : { ...goal, id: this.confIds.next('premise_only'), end: null };
      const shared = g.premise.length ? '' : `前提の節が無いので、性質の否定だけの実行 ${goal.id} と同じ query の答えを使う。`;
      const { external } = rec;
      if (prem.answer === 'sat') det({ ...base, id: prem.id, kind: 'premise_only', item: ITEM.premise_only, result: '成り立つ', end: prem.end, materials: prem.materials, reason: `${shared}規則の節（${list(g.rule) || 'なし'}）を外すと充足可能（sat）` });
      else if (prem.answer === 'unsat' && external.length) {
        // 外部の依存でない前提と否定だけ（無ければ否定だけ）の答えで決める。sat のときだけ、外部の依存が結論を支えるので断定しない。
        // 外部の依存を外した再検査は自分の実行を持つので、その答えも確認（又は判断を要する項目）として残す
        const inner = g.premise.filter((n) => !external.includes(n));
        const x = inner.length ? fromExec(rec.internal) : goal;
        const what = inner.length ? `外部の依存でない前提（${list(inner)}）と性質の否定だけ（実行 ${x.id}）` : '外部の依存でない前提が無いので性質の否定だけ';
        const ITEM_INNER = `外部の依存でない前提と性質の否定だけの充足可能性（検査 ${c.id}）`;
        const supported = () => judge({ ...base, id: prem.id, kind: 'premise_only', cause: '外部の依存', clause_names: external, item: ITEM.premise_only, end: prem.end, materials: prem.materials,
          reason: `規則の節を外すと充足不能（unsat）だが、${what}は${x.answer === 'sat' ? '充足可能（sat）なので、外部の依存の前提が結論を支える' : '答えが無いので、外部の依存の前提が結論を支えるかを断定できない'}。前提 ${list(external)} が外部の依存に支えられるので、前提だけで結論が出ていると断定しない` });
        if (x.answer === 'unsat') {
          det({ ...base, id: prem.id, kind: 'premise_only', item: ITEM.premise_only, result: '成り立たない', end: prem.end, materials: prem.materials,
            reason: `規則の節（${list(g.rule) || 'なし'}）を外すと充足不能（unsat）で、${what}でも充足不能（unsat）なので、外部の依存によらず前提だけで結論が出ている` });
          if (inner.length) det({ ...base, id: x.id, kind: 'premise_only', item: ITEM_INNER, result: '成り立たない', end: x.end, materials: x.materials, reason: `${what}で充足不能（unsat）なので、外部の依存によらず前提だけで結論が出ている` });
        } else {
          supported();
          if (inner.length && x.answer === 'sat') det({ ...base, id: x.id, kind: 'premise_only', item: ITEM_INNER, result: '成り立つ', end: x.end, materials: x.materials, reason: `${what}で充足可能（sat）` });
          else if (inner.length) judge({ ...base, kind: 'premise_only', item: ITEM_INNER, ...undecided(x, '外部の依存の前提を外した実行', inner) });
        }
      } else if (prem.answer === 'unsat') det({ ...base, id: prem.id, kind: 'premise_only', item: ITEM.premise_only, result: '成り立たない', end: prem.end, materials: prem.materials, reason: `${shared}規則の節（${list(g.rule) || 'なし'}）を外しても充足不能（unsat）なので、前提だけで結論が出ている` });
      else judge({ ...base, kind: 'premise_only', item: ITEM.premise_only, ...undecided(prem, '前提と性質の否定だけの実行', g.premise) });
      // 結論を支える前提
      if (!g.premise.length) { det({ ...base, id: this.confIds.next('premise_load'), kind: 'premise_load', item: ITEM.premise_load, result: '成り立つ', reason: '前提の節が無い' }); continue; }
      const rule = fromExec(rec.rule);
      if (rule.answer === null) { judge({ ...base, kind: 'premise_load', item: ITEM.premise_load, ...undecided(rule, '規則と性質の否定だけの実行', g.premise) }); continue; }
      det({ ...base, id: rule.id, kind: 'premise_load', item: ITEM.premise_load, result: '成り立つ', end: rule.end, materials: rule.materials,
        reason: rule.answer === 'unsat' ? `規則と性質の否定だけで充足不能（unsat）なので、前提（${list(g.premise)}）は結論を支えていない`
          : `規則と性質の否定だけでは充足可能（sat）なので、結論は前提に支えられる。前提を 1 つずつ外した結果を前提ごとに示す` });
      if (rule.answer === 'unsat') continue;
      if (rec.over) {
        for (const name of g.premise) judge({ ...base, id: this.confIds.next('premise_load'), kind: 'premise_load', cause: '上限を超えた', clause_names: [name], item: `${ITEM.premise_load}の前提 ${name}`,
          reason: `前提を 1 つずつ外す再検査が 1 つの検査あたりの上限 ABLATION_PER_PROPERTY_MAX（${ABLATION_PER_PROPERTY_MAX}）を超えるので行わず、全ての前提を意味の確認で確かめる` });
        continue;
      }
      let judged = 0;
      for (const pp of rec.perPremise) {
        const x = fromExec(pp.id);
        const item = `${ITEM.premise_load}の前提 ${pp.name}`;
        if (x.answer === 'unsat') { det({ ...base, id: x.id, kind: 'premise_load', item, result: '成り立つ', end: x.end, materials: x.materials, reason: `前提 ${pp.name} だけを外しても充足不能（unsat）なので、この前提 1 つを外しても結論は変わらない` }); continue; }
        judged += 1;
        if (x.answer === 'sat') judge({ ...base, id: x.id, kind: 'premise_load', cause: '効いている前提', clause_names: [pp.name], item, end: x.end, materials: x.materials, reason: `前提 ${pp.name} を外すと充足可能（sat）になるので、この前提が結論を支える` });
        else judge({ ...base, kind: 'premise_load', item, ...undecided(x, `前提 ${pp.name} を外した実行`, [pp.name]) });
      }
      // 1 つずつ外して unsat だった前提の一部（2 つ以上）をまとめて外すと sat なら、それらが重なって効いているので、その組を項目にする
      if (rec.overlap) {
        const x = fromExec(rec.overlap.id);
        const names = rec.overlap.names;
        const item = `${ITEM.premise_load}の前提の組 ${list(names)}`;
        if (x.answer === 'unsat') det({ ...base, id: x.id, kind: 'premise_load', item, result: '成り立つ', end: x.end, materials: x.materials, reason: `1 つずつ外して充足不能だった前提（${list(names)}）をまとめて外しても充足不能（unsat）なので、この組は結論を支えていない` });
        else if (x.answer === 'sat') judge({ ...base, id: x.id, kind: 'premise_load', cause: '効いている前提の組', clause_names: [...names], item, end: x.end, materials: x.materials,
          reason: `前提（${list(names)}）は 1 つずつ外すと充足不能（unsat）だが、まとめて外すと充足可能（sat）になるので、重なって結論を支える` });
        else judge({ ...base, kind: 'premise_load', item, ...undecided(x, `前提の組 ${list(names)} を外した実行`, names) });
      }
      // 規則と否定だけが sat なら、結論は前提に支えられる。1 つずつ外して全て unsat なら、前提が重なって効いているので、前提の組を項目にする
      if (!judged) judge({ ...base, id: this.confIds.next('premise_load'), kind: 'premise_load', cause: '効いている前提の組', clause_names: [...g.premise], item: `${ITEM.premise_load}の前提の組`, end: null, materials: rule.materials,
        reason: `規則と性質の否定だけでは充足可能（sat、実行 ${rule.id}）だが、前提を 1 つずつ外した実行は全て充足不能（unsat）なので、前提（${list(g.premise)}）が重なって結論を支える` });
    }
    this.scopeVariableConfirmations(det, materials);
    this.planCoverageConfirmations(det);
    this.mutationScopeConfirmations(det, materials);
  }

  // 範囲として扱う変数が、検査の入力で宣言され、出所の規則か性質の否定の節に現れるか。
  scopeVariableConfirmations(det, materials) {
    for (const c of this.planChecks().filter((x) => x.kind === 'property')) {
      const info = this.mpInfo(c.target_id);
      if (!info || info.p.assurance.kind !== '範囲を限った検査') continue;
      const vars = info.p.assurance.scope_variables;
      const text = c.input_refs.map((r) => readRunText(this.runDir, r)).every((t) => t !== null) ? c.input_refs.map((r) => `${readRunText(this.runDir, r)}\n`).join('') : null;
      const base = { id: this.confIds.next('scope_variables'), kind: 'scope_variables', property_ids: [...this.parentsOf(info.p.id)], model_property_id: info.p.id, plan_id: c.id,
        item: `範囲として扱う変数（検査 ${c.id}）`, materials: materials(this.exec.get(c.id) ?? {}) };
      if (text === null) { det({ ...base, result: '成り立たない', reason: '検査の入力を読めない' }); continue; }
      let declared;
      let used;
      try {
        declared = new Set(z3.declaredSymbols(text).map((d) => d.name));
        const terms = namedTerms(text);
        const names = info.p.clauses.filter((x) => x.role === 'rule' || x.role === 'goal').map((x) => x.name);
        used = new Set(names.flatMap((n) => (terms.has(n) ? symbolsOf(terms.get(n)) : [])));
      } catch (e) { det({ ...base, result: '成り立たない', reason: `検査の入力を S 式として読めない（${e.message}）` }); continue; }
      const notDeclared = vars.filter((v) => !declared.has(v));
      const notUsed = vars.filter((v) => declared.has(v) && !used.has(v));
      const bad = [...(notDeclared.length ? [`宣言されていない: ${notDeclared.join(', ')}`] : []), ...(notUsed.length ? [`出所の規則にも性質の否定にも現れない: ${notUsed.join(', ')}`] : [])];
      det({ ...base, result: bad.length ? '成り立たない' : '成り立つ',
        reason: bad.length ? `範囲として扱う変数のうち、${bad.join('。')}（保証が範囲を超えている）` : vars.length ? `範囲として扱う変数 ${vars.join(', ')} は全て宣言され、出所の規則か性質の否定に現れる` : '範囲として扱う変数が無い' });
    }
  }

  // 性質ごとに、計画した検査・前提の整合の確認・変異（又は用意できない理由）があるか（検査の欠けの正本は checks/plan.mjs の checkGaps）。
  planCoverageConfirmations(det) {
    const blocked = new Set(this.blockedBy.keys());
    const noTool = (pid) => noSuitableTool(this.prepare, this.selectionOf(pid));
    const gaps = checkGaps({ models: this.models, blocked, noTool, checks: this.planChecks(), sanity: this.planSanity() });
    const unavailable = this.mutations?.data.unavailable ?? [];
    for (const m of this.models) for (const p of m.data.properties) {
      const inv = p.inventory_property_ids;
      if (inv.length > 0 && inv.every((pid) => blocked.has(pid) || noTool(pid))) continue;
      const lacks = [
        ...(gaps.missingCheck.includes(p.id) ? ['計画した検査'] : []),
        ...(gaps.missingSanity.includes(p.id) ? ['前提の整合の確認'] : []),
        ...(this.planMutations().some((x) => x.property_id === p.id) || unavailable.some((u) => inv.includes(u.property_id)) ? [] : ['変異と、用意できない理由']),
      ];
      det({ id: this.confIds.next('plan_coverage'), kind: 'plan_coverage', property_ids: [...inv], model_property_id: p.id, plan_id: null, item: `計画の網羅（モデルの性質 ${p.id}）`,
        result: lacks.length ? '成り立たない' : '成り立つ', reason: lacks.length ? `欠陥の残らない計画に ${lacks.join('・')} が無い（計画が欠けている）` : '計画した検査・前提の整合の確認・変異（又は用意できない理由）がある' });
    }
  }

  // 変異が出所の規則の節の項だけを変えるか（名前の集合が同じことは計画の照合が確かめる）。
  mutationScopeConfirmations(det, materials) {
    for (const m of this.planMutations()) {
      const info = this.mpInfo(m.property_id);
      const detector = this.plan.data.checks.find((c) => c.id === m.detector_check_id);
      if (!info || !detector) continue;
      const exec = [...this.exec.values()].find((e) => e.kind === 'mutation' && e.meta.mutation === m);
      const base = { id: this.confIds.next('mutation_scope'), kind: 'mutation_scope', property_ids: [...this.parentsOf(m.property_id)], model_property_id: m.property_id, plan_id: m.id,
        item: `変異 ${m.id} が出所の規則を変えるか`, materials: exec ? materials(exec) : [] };
      const orig = readRunText(this.runDir, detector.input_refs[detector.input_refs.length - 1]);
      const mut = readRunText(this.runDir, m.mutation_ref);
      if (orig === null || mut === null) { det({ ...base, result: '成り立たない', reason: '検出役の検査の query か変異の query を読めない' }); continue; }
      let a;
      let b;
      try { a = namedTerms(orig); b = namedTerms(mut); parseForms(orig); parseForms(mut); } catch (e) { det({ ...base, result: '成り立たない', reason: `query を S 式として読めない（${e.message}）` }); continue; }
      const rules = info.p.clauses.filter((x) => x.role === 'rule').map((x) => x.name);
      const differs = (n) => JSON.stringify(a.get(n) ?? null) !== JSON.stringify(b.get(n) ?? null);
      const changed = rules.filter(differs);
      // 規則の節だけを変える変異か（性質の否定・前提の節と、assert でない form（宣言・define-fun など）を変えた変異は、自明な違反を作れる）
      const others = info.p.clauses.filter((x) => x.role !== 'rule' && differs(x.name)).map((x) => `${x.name}（${x.role}）`);
      const rest = (t) => parseForms(t).filter((f) => !(Array.isArray(f.node) && f.node[0] === 'assert')).map((f) => JSON.stringify(f.node)).join('\n');
      const formsChanged = rest(orig) !== rest(mut);
      const bad = [...(changed.length ? [] : [`出所の規則の節（${rules.join(', ') || 'なし'}）を変えない`]), ...(others.length ? [`規則でない節 ${others.join(', ')}を変える`] : []),
        ...(formsChanged ? ['assert でない form（宣言・define-fun など）を変える'] : [])];
      det({ ...base, result: bad.length ? '成り立たない' : '成り立つ',
        reason: bad.length ? `変異は${bad.join('。')}ので、出所の規則を壊した変異として数えない` : `変異は出所の規則の節 ${changed.join(', ')} だけを変え、性質の否定・前提の節と他の form を変えない` });
    }
  }

  // ---- 確認 ----
  // 確認役は観点（役）ごとに、単位を packByUnion で 1 体に詰める（資料の和集合が UNIT_MAX_BYTES まで、next-fit）。原因の分類役は 1 体が主題を束で取る。
  async confirmation() {
    const t0 = process.hrtime.bigint();
    const invProps = this.inventoryProperties();
    const nonformal = invProps.filter((p) => !p.formalizable && !this.blockedBy.has(p.id));
    this.writeJudgmentRecords();
    const units = reviewUnits({ inventories: this.inventories, nonformal, models: this.models, partitionsAdopted: Boolean(this.partitions?.data.adopted), judgments: this.confirmations.judgments });
    this.writeViews(units);
    const subjects = this.causeSubjects();
    // input_refs は観点ごとの表のとおり（artifact-formats.md「独立検証者と原因の分類役の input_refs」）。先頭は request.json、
    // 実在しない ref（実行していない検査の記録など）は入れない
    const R = (name, ref) => ({ name, ref });
    const exists = (ref) => { const p = this.pathOf(ref); if (p === null) return false; try { statSync(p); return true; } catch { return false; } };
    const withRequest = (refs) => [R('request', 'request.json'), ...refs.filter((x) => x.ref && exists(x.ref))];
    const copyOf = (tid) => this.targetFileRefs(tid);
    const manifestOf = (tid) => R(`manifest-${tid}`, join('targets', tid, 'manifest.json'));
    const modelRefs = (m) => [R(`model-${m.id}`, m.ref), R(`mapping-${m.id}`, m.mapping.ref)];
    const execRecord = (id) => R(`checks-${id}`, join('checks', id));
    const worklog = (stage) => R(`worklog-${stage}`, join('worklogs', `cli-${stage}.json`));
    const refsFor = (u) => {
      if (u.perspective === 'extraction') return [...copyOf(u.target_id), manifestOf(u.target_id), ...this.inventories.filter((i) => i.target_id === u.target_id).map((i) => R('inventory', i.ref)), worklog('洗い出し')];
      // 形式化できない性質: その性質と出所の要素だけの資料（views）と、出所の要素の範囲
      if (u.perspective === 'nonformal') {
        const p = this.inventoryProperties().find((x) => x.id === u.property_ids[0]);
        if (!p) return [];
        return [...(this.viewRefs.has(u.unit_id) ? [R('view', this.viewRefs.get(u.unit_id))] : []), ...this.targetRefsOf(this.elementScopeOf(p.source_ids))];
      }
      if (u.perspective === 'composition') {
        const parts = this.partitions?.data;
        const queries = parts ? [...parts.contracts, ...parts.composition_conditions].map((x) => R(`query-${x.id}`, x.query_ref)) : [];
        const execs = this.planChecks().filter((c) => c.kind === 'contract' || c.kind === 'composition').map((c) => execRecord(c.id));
        return [...(this.partitions ? [R('partitions', this.partitions.ref)] : []), ...this.models.map((m) => R(`model-${m.id}`, m.ref)), ...queries, ...execs, worklog('計画')];
      }
      // fidelity: 対応表の行の範囲と、そのモデルが扱う inventory の性質・節・遷移・入出力の契約の出所の範囲だけを渡す。inventory はその
      // モデルの性質の分と、その inventory の要素の一覧（id と範囲。文の本文は持たない。モデルに無い出所の要求を探すため）を views に置く
      const m = this.models.find((x) => x.id === u.model_id);
      const queries = m.data.properties.map((p) => R(`query-${p.id}`, p.query_ref));
      const jref = this.judgmentRefs.get(m.id);
      const sel = this.modelScope(m, { view: true });
      return [...(this.viewRefs.has(u.unit_id) ? [R('view', this.viewRefs.get(u.unit_id))] : []), ...this.targetRefsOf(sel), ...modelRefs(m), ...queries,
        ...(jref ? [R(`judgments-${m.id}`, jref)] : []), ...u.judgment_ids.map(execRecord), worklog('モデル化')];
    };
    // 原因の分類役は「要求の不足」「形式モデルの欠陥」を「無いこと」で確かめるので、主題から辿れる範囲に、全ての対象の依頼の範囲を足す
    // （抽出の確認役と同じ。architecture.md「担当に渡す資料」）
    const causeTargets = (sel) => { for (const t of this.targets) this.mergeScope(sel, this.requestScopeOf(t.id)); return this.targetRefsOf(sel); };
    const causeRefsFor = (s) => {
      if (s.kind === 'counterexample') {
        const x = this.counterexamples.find((c) => c.id === s.id);
        const check = this.planChecks().find((c) => c.id === x.check_id);
        const m = this.models.find((y) => y.id === check?.model_id);
        // 反例 → 検査 → モデルの性質 → 節の出所と、その性質の対応表の行の範囲
        const mp = m ? m.data.properties.find((p) => p.id === x.mp) : null;
        const sel = m && mp ? this.modelScope(m, { mps: [mp.id] }) : new Map();
        return [...causeTargets(sel), execRecord(x.check_id), ...(x.replayId ? [execRecord(x.replayId)] : []), ...(m ? modelRefs(m) : [])];
      }
      if (s.kind === 'combination') {
        // 組合せ → その状態か出来事の遷移・禁止の出所。無ければそのモデルの対応表の行の範囲
        const m = this.models.find((y) => y.id === s.model_id);
        const sm = m?.data.state_machine;
        const ids = sm ? [...sm.transitions.filter((t) => t.from === s.state || t.event === s.event), ...sm.forbidden.filter((f) => f.from === s.state || f.event === s.event)].flatMap((t) => t.source_ids) : [];
        const sel = m ? (ids.length ? this.elementScopeOf(ids) : this.mappingScopeOf(m.mapping.data.rows)) : new Map();
        return [...causeTargets(sel), ...(m ? modelRefs(m) : []), worklog('モデル化')];
      }
      // 問い → 影響する性質の出所
      const q = this.authorQuestions.find((x) => x.q.id === s.id);
      const affected = this.inventoryProperties().filter((p) => (q?.q.affected ?? []).includes(p.id)).flatMap((p) => p.source_ids);
      return [...causeTargets(this.elementScopeOf(affected)), ...(q?.outputRefs ?? []).map((ref, i) => R(`output-${i + 1}`, ref))];
    };
    // 1 体に詰める量は、その体の単位の資料の和集合のバイト数（共有の資料は 1 度だけ数える。call.mjs の packByUnion）
    // 範囲を持つ対象の ref は spans ごと渡し、範囲の行だけを数える
    const filesOf = (spec) => refFiles(this.runDir, spec.input_refs.map((x) => ({ ref: x.ref, ...(x.spans ? { spans: x.spans } : {}) })), (ref) => this.pathOf(ref));
    // 確認役: 役ごとに単位の並びのまま packByUnion で詰め、詰めた束ごとに 1 体
    const byRole = new Map();
    for (const u of units) { if (!byRole.has(u.role)) byRole.set(u.role, []); byRole.get(u.role).push(u); }
    const reviewWorkers = [];
    for (const us of byRole.values()) {
      const specs = us.map((u) => ({ role: u.role, stage: '確認', unit_id: u.unit_id, perspective: u.perspective, target_id: u.target_id, model_id: u.model_id, property_ids: u.property_ids, input_refs: withRequest(refsFor(u)) }));
      const files = specs.map(filesOf);
      for (const pack of packByUnion(specs.map((_, i) => i), (i) => files[i])) {
        reviewWorkers.push({ items: pack.map((i) => ({ spec: specs[i], unit: us[i], expect: judgmentAnswers(us[i].judgment_ids) })) });
      }
    }
    // 原因の分類役: 1 体が主題を束で取る（next-fit、上限 cap）。取ったまま 1 件も出さなかった束の後は、次の束の上限が半分になる
    let pool = subjects.map((s) => { const spec = { role: 'cause-analyst', stage: '確認', unit_id: causeUnitId(s, this.combinations ?? []), subject: s, input_refs: withRequest(causeRefsFor(s)) }; return { subject: s, spec, files: filesOf(spec) }; });
    this.log().actions.push(`確認の unit ${units.length} 件を ${reviewWorkers.length} 体に詰め、原因の分類 ${subjects.length} 件を 1 体の束で出した。`);
    let cap = UNIT_MAX_BYTES;
    let first = true;
    for (;;) {
      const causeWorker = pool.length ? { mode: 'fit', cap, items: pool.map((x) => ({ spec: x.spec, files: x.files })) } : null;
      const workers = [...(first ? reviewWorkers : []), ...(causeWorker ? [causeWorker] : [])];
      if (!workers.length) break;
      const out = await runWorkers(this, workers);
      if (first) reviewWorkers.forEach((w, k) => w.items.forEach((it, j) => this.meaningFrom(it.unit, out[k].results[j])));
      first = false;
      if (!causeWorker) break;
      const co = out[out.length - 1];
      const next = [];
      co.results.forEach((r, j) => { if (r.released) next.push(pool[j]); else this.causeFrom(pool[j].subject, r); });
      if (!next.length) break;
      const progressed = next.length < pool.length || (co.nextCap !== null && co.nextCap < cap);
      if (this.halted() || !progressed) {
        const why = this.halted() ? '中断の理由があるので原因の分類役を出さなかった' : '原因の分類役が束を取らないまま呼び出しが閉じた';
        for (const x of next) {
          if (!this.halted()) this.agentFailedStage('確認', `${causeUnitId(x.subject, this.combinations ?? [])}: ${why}`);
          this.causeFrom(x.subject, { ok: false, task: null, cause: why });
        }
        break;
      }
      pool = next;
      cap = co.nextCap ?? UNIT_MAX_BYTES;
    }
    this.timing.confirmationMs = Number((process.hrtime.bigint() - t0) / 1000000n);
    this.log().results.push(`意味の確認 ${this.confirmations.meaning.length} 件、原因 ${this.causes.length} 件を回収した。`);
  }

  // 判断を要する項目を、モデルごとに 1 つの記録にする（忠実さの確認役の資料。artifact-formats.md「判断を要する項目の記録」）
  writeJudgmentRecords() {
    for (const m of this.models) {
      const mps = new Set(m.data.properties.map((p) => p.id));
      const js = this.confirmations.judgments.filter((j) => mps.has(j.model_property_id));
      if (!js.length) continue;
      const ref = join('judgments', `${m.id}.json`);
      if (this.writeRecordFile(ref, JSON.stringify({ model_id: m.id, judgments: js }, null, 2), { kind: 'judgments' })) this.judgmentRefs.set(m.id, ref);
    }
  }

  // 担当に渡す範囲の資料（architecture.md「担当に渡す資料」）。fidelity はそのモデルの性質の inventory の分、結ばれた要素とどの性質にも
  // 結ばれない要素の一覧（id と範囲だけ）、その inventory の外部の依存。nonformal はその性質と出所の要素。unit ごとに views/<unit_id>.json に書く（台帳の kind: "material_view"）
  writeViews(units) {
    const elements = this.inventories.flatMap((i) => i.data.elements);
    const props = this.inventoryProperties();
    for (const u of units) {
      let view = null;
      if (u.perspective === 'fidelity') {
        const m = this.models.find((x) => x.id === u.model_id);
        const { invIds, inventories } = this.modelInventoryOf(m);
        const mine = props.filter((p) => invIds.has(p.id));
        // 要素は 2 つに分ける: (a) このモデルの性質に結ばれた要素、(b) どの性質にも結ばれない要素。他のモデルの性質にだけ結ばれた要素は入れない。
        // どちらも id と範囲だけを持ち、本文は渡す範囲（modelScope の view）の対象のファイルで読む
        const short = (e) => ({ id: e.id, kind: e.kind, source: { target_id: e.source.target_id, file: e.source.file, span: e.source.span } });
        const boundIds = new Set(mine.flatMap((p) => p.source_ids));
        view = { unit_id: u.unit_id, model_id: m.id, properties: mine.map(({ target_id: _t, ...p }) => p),
          bound_elements: inventories.flatMap((i) => i.data.elements).filter((e) => boundIds.has(e.id)).map(short),
          unbound_elements: this.unboundElements(inventories).map(short),
          external_dependencies: inventories.flatMap((i) => i.data.external_dependencies).map((d) => ({ id: d.id, text: d.text, source: d.source ? { ...d.source } : null })) };
      } else if (u.perspective === 'nonformal') {
        const p = props.find((x) => x.id === u.property_ids[0]);
        if (!p) continue;
        const { target_id: _t, ...prop } = p;
        view = { unit_id: u.unit_id, properties: [prop], elements: elements.filter((e) => p.source_ids.includes(e.id)) };
      }
      if (!view) continue;
      const ref = join('views', `${u.unit_id}.json`);
      if (this.writeRecordFile(ref, JSON.stringify(view, null, 2), { kind: 'material_view' })) this.viewRefs.set(u.unit_id, ref);
    }
  }

  causeSubjects() {
    const out = [];
    for (const x of this.counterexamples) out.push({ kind: 'counterexample', id: x.id });
    for (const { model, combinations } of this.combinations ?? []) {
      if (!combinations.applicable) continue;
      for (const cell of combinations.cells) if (cell.class === '対応できていない') out.push({ kind: 'combination', model_id: model.id, state: cell.state, event: cell.event });
    }
    for (const { q } of this.authorQuestions) out.push({ kind: 'question', id: q.id });
    return out;
  }

  meaningFrom(u, r) {
    const fidelityProps = () => { const m = this.models.find((x) => x.id === u.model_id); return [...new Set(m.data.properties.flatMap((p) => p.inventory_property_ids))].sort(); };
    const propertyIds = u.perspective === 'fidelity' ? fidelityProps() : u.perspective === 'nonformal' ? [...u.property_ids] : [];
    const checker = r.task ? r.task.task_id : 'cli';
    const materials = (r.materials ?? []).map((m) => ({ ref: m.ref, hash: m.hash, ...(m.spans ? { spans: m.spans.map((x) => ({ ...x })) } : {}) }));
    const conf = {
      id: this.confIds.next(u.perspective), kind: u.perspective, property_ids: propertyIds, model_property_id: null, plan_id: null,
      item: u.unit_id, result: '確認できず', checker, materials, end: null, reason: '',
    };
    if (r.ok) {
      this.registerAgentFile('worklog', r.ret.worklog_ref, r.task, r.materials);
      this.registerAgentFile('review_record', r.ret.record_ref, r.task, r.materials);
      conf.result = r.ret.result;
      conf.reason = r.ret.findings.length ? r.ret.findings.map((f) => `${f.kind}: ${f.note}`).join('。') : `独立した確認の結果は ${r.ret.result}`;
    } else {
      conf.reason = r.cause ?? '時間の上限か保存の失敗で担当を出さなかった';
      this.notCreated.push({ kind: 'review_record', reason: conf.reason });
    }
    if (conf.result === '確認できず') this.unverified.push({ item: u.unit_id, reason: conf.reason });
    this.confirmations.meaning.push(conf);
    // 判断を要する項目ごとの意味の確認（AC-22）。答えた者と渡した資料は、その忠実さの確認と同じ
    for (const jid of u.judgment_ids ?? []) {
      const j = this.confirmations.judgments.find((x) => x.id === jid);
      const ans = r.ok ? r.ret.judgments.find((x) => x.id === jid) : null;
      const jc = {
        id: this.confIds.next('judgment'), kind: 'judgment', property_ids: [...j.property_ids], model_property_id: j.model_property_id, plan_id: j.plan_id,
        item: j.id, result: ans ? ans.result : '確認できず', checker, materials, end: null,
        reason: ans ? (ans.note.trim() || `判断を要する項目の確認の結果は ${ans.result}`) : conf.reason,
      };
      if (jc.result === '確認できず') this.unverified.push({ item: j.id, reason: jc.reason });
      this.confirmations.meaning.push(jc);
    }
  }

  causeFrom(subject, r) {
    if (r.ok) {
      this.registerAgentFile('worklog', r.ret.worklog_ref, r.task, r.materials);
      this.registerAgentFile('review_record', r.ret.record_ref, r.task, r.materials);
      this.causes.push({ subject, cause: r.ret.cause, grounds: r.ret.grounds, classified_by: r.task.task_id });
      if (r.ret.cause === '要求の不足') {
        // 問いの subject を 要求の不足 と分類したら、その問い自身も questions[] に実在させる（artifact-formats.md「id と参照の一覧」）
        const own = subject.kind === 'question' ? this.authorQuestions.find((x) => x.q.id === subject.id)?.q : null;
        for (const q of [...(own ? [own] : []), ...r.ret.questions]) if (!this.resultQuestions.some((x) => x.id === q.id)) this.resultQuestions.push(q);
      }
      return;
    }
    this.causes.push({ subject, cause: '原因未確認', grounds: r.cause ?? '時間の上限か保存の失敗で原因の分類役を出さなかった', classified_by: r.task ? r.task.task_id : 'cli' });
  }

  // 集約の段で 1 度だけ作る決定的な確認（artifact-formats.md「syntax・reference・output_format の作り方」）。新しい照合は足さず、
  // 各段の最後の巡の欠陥の区分と、道具の実行の終わり方を写す
  addSummaryConfirmations() {
    if (this.summaryAdded) return;
    this.summaryAdded = true;
    const base = { property_ids: [], model_property_id: null, plan_id: null, checker: 'cli', materials: [], end: null };
    const ITEMS = { syntax: '担当の成果物の構文', reference: '担当の成果物の参照の解決' };
    if (this.checkedDefects.length) {
      for (const kind of ['syntax', 'reference']) {
        const hits = this.checkedDefects.flatMap(({ stage, defects }) => defects.filter((d) => d.kind === kind).map((d) => `${stage}: ${d.text}`));
        this.confirmations.deterministic.push({ id: this.confIds.next(kind), kind, ...base, item: ITEMS[kind],
          result: hits.length ? '成り立たない' : '成り立つ',
          reason: hits.length ? hits.join('。') : `照合した担当の成果物に、修正の巡の後に残った ${kind} の区分の欠陥は無い` });
      }
    }
    const started = [...this.exec.values()].filter((e) => e.outcome && e.outcome.end.started);
    if (started.length) {
      const bad = started.filter((e) => e.outcome.end.stopped_by === null && e.outcome.end.unreadable_output).map((e) => e.id);
      this.confirmations.deterministic.push({ id: this.confIds.next('output_format'), kind: 'output_format', ...base, item: '道具の出力の形式',
        result: bad.length ? '成り立たない' : '成り立つ',
        reason: bad.length ? `道具の出力を読めない実行: ${bad.join(', ')}` : '止めずに終わった道具の実行の出力は全て読めた' });
    }
  }

  // 期限か停止の要求で始めなかった実行（stop_report.checks_aborted に載る）
  abortExec(id, why) { const e = this.exec.get(id); e.notStartedReason = why; e.aborted = true; }
}

// 静的な確認の実行の答え（sat・unsat）。判定できなければ null。
function answerOf(e) {
  const v = e && e.outcome ? verdictOf(e.outcome.end) : null;
  if (v === '成功') return e.expected;
  if (v === '反例') return e.expected === 'sat' ? 'unsat' : 'sat';
  return null;
}

function invalidEndReason(end) {
  try { classifyCheck(end); return '不明'; } catch (e) { return e.message; }
}
