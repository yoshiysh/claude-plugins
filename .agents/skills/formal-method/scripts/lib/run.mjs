// run-daemon の段の進行（architecture.md「段と処理の順序」「停止の手順」）。段は表の順に 1 度ずつ進み、戻るのは修正の巡だけ。
// 止めるのは 4 つの理由（時間の上限・保存の失敗・依頼の不備・内部の誤り）だけで、担当の失敗・反例・不合格では段を進める。
import { readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256Bytes } from './canonical.mjs';
import { AGENT_BATCH_MAX, REVISE_ROUNDS_MAX, STATE_SCHEMA } from './schemas.mjs';
import { scanSecrets, describeHits } from './secrets.mjs';
import { writeEvidence } from './storage.mjs';
import { guardedWrite, SalvagedError } from './store.mjs';
import { startRunClock, NODE_TIMER_CLOCK } from './clock.mjs';
import { checkRequestShape, checkPointers, normalizeRequest } from './request.mjs';
import { fetchTarget, writeSnapshot, lineCount } from './intake.mjs';
import { runTasks } from './agents.mjs';
import { ledgerEntry, newStageLog, cliWorklog } from './worklog.mjs';
import { coverageCheck } from './checks/coverage.mjs';
import { modelCheck, matrixGen } from './checks/model.mjs';
import { buildGraph, deriveCandidates } from './checks/graph.mjs';
import { partitionCheck } from './checks/compose.mjs';
import { planCheck, defectiveElements } from './checks/plan.mjs';
import { ConfirmationIds, confirmationResult, verdictOf, reviewUnits, causeUnitId, TRUNCATED } from './checks/det.mjs';
import { classifyCheck } from './verdict.mjs';
import { readRunText, defect } from './checks/common.mjs';
import * as z3 from './adapters/z3.mjs';
import { runExecutions, NOT_STARTED_END } from './scheduler.mjs';
import { spawnTool } from './process.mjs';
import { reason, PARTITION_REJECTED } from './result.mjs';
import { locationFromEnv } from './performance.mjs';

const DOC_RULES = fileURLToPath(new URL('../../references/document-rules.md', import.meta.url));
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
    this.batchNo = 0;
    this.tasks = new Map();
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
    this.confirmations = { deterministic: [], meaning: [] };
    this.counterexamples = [];
    this.causes = [];
    this.resultQuestions = [];
    this.timing = {};
    this.confirmationUnits = [];
    this.checkedDefects = [];
    this.partitionRejected = false;
  }

  nextTaskNo() { this.taskNo += 1; return this.taskNo; }
  nextBatchNo() { this.batchNo += 1; return this.batchNo; }
  log(stage = this.stage) { if (!this.logs.has(stage)) this.logs.set(stage, newStageLog()); return this.logs.get(stage); }
  halted() { return this.interrupts.length > 0; }
  interrupt(code, detail, stage = this.stage) { this.interrupts.push(reason(code, stage, detail)); this.log(stage).failures.push(`${code}: ${detail}`); }
  timeLimitReached(detail) { if (!this.interrupts.some((x) => x.code === '時間の上限')) this.interrupt('時間の上限', detail); }
  saveFailed(kind, ref, why) {
    this.unsaved.push({ kind, ref, reason: why });
    if (!this.interrupts.some((x) => x.code === '保存の失敗' && x.stage === this.stage)) this.interrupt('保存の失敗', `記録を保存できない: ${why}`);
    else this.log().failures.push(`保存の失敗: ${why}`);
  }
  agentFailed(task, detail) {
    this.agentFailures.push(reason('担当の失敗', task.context.stage, detail));
    this.log(task.context.stage).failures.push(detail);
  }

  writeStatus(action, batch, result = null) {
    this.seq += 1;
    const status = { seq: this.seq, run_dir: this.runDir, action, batch, result, daemon: this.identity };
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
    const docBytes = readFileSync(DOC_RULES);
    const version = sha256Bytes(docBytes);
    const docRef = `document-rules/${version.slice(7)}.md`;
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
      try { written = writeSnapshot(this.runDir, tg); } catch (e) { this.saveFailed('target_snapshot', `targets/${t.id}`, `対象の写しを書けない（${e.code ?? e.message}）`); continue; }
      for (const w of written) this.entries.push(ledgerEntry({ kind: 'target_snapshot', ref: w.ref, hash: w.hash, stage: '受付' }));
      fixedById.set(t.id, { revision: tg.revision, content_hash: tg.content_hash, snapshot_ref: join('targets', t.id), files: tg.files.map((f) => ({ path: f.path, content_hash: f.content_hash, text: f.text })) });
      this.targets.push(tg);
    }
    if (!this.halted()) {
      this.request = normalizeRequest(raw, fixedById);
      this.writeRecordFile('request.json', JSON.stringify(this.request, null, 2), { kind: 'request' });
      log.results.push(`依頼を受け付けた。対象 ${this.targets.length} 件の写しを保存した。`);
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

  // ---- 作成役の巡（修正の巡を含む） ----
  // unit: { role, spec(round, reviseRef) → spec, check(ret, task) → { defects, value }, accept(last), onFail(why) }
  async authorRounds(units) {
    let pending = units.map((u) => ({ u, round: 1, prev: Infinity, reviseRef: null, last: null }));
    // 各 unit の最後の巡に照合した成果物の欠陥（受け入れたかによらない）を、syntax・reference の確認のために控える
    const settle = (p) => { if (p.last) this.checkedDefects.push({ stage: p.last.task.context.stage, defects: p.last.defects }); };
    while (pending.length) {
      const results = await runTasks(this, pending.map((p) => p.u.spec(p.round, p.reviseRef)));
      const next = [];
      pending.forEach((p, i) => {
        const r = results[i];
        if (!r.ok) {
          settle(p);
          if (p.last) p.u.accept(p.last);
          else p.u.onFail(r.notIssued ? '時間の上限か保存の失敗で担当を出さなかった' : `担当の失敗（${r.cause}）`);
          return;
        }
        const c = p.u.check(r.ret, r.task);
        p.last = { ret: r.ret, task: r.task, materials: r.materials, ...c };
        if (c.defects.length === 0 || p.round > REVISE_ROUNDS_MAX || c.defects.length >= p.prev || this.halted()) { settle(p); p.u.accept(p.last); return; }
        const ref = join('revisions', `${r.task.task_id}-defects.json`);
        if (!this.writeRecordFile(ref, JSON.stringify({ task_id: r.task.task_id, defects: c.defects.map((d) => ({ key: d.key, text: d.text })) }, null, 2), { kind: 'worklog' })) { settle(p); p.u.accept(p.last); return; }
        this.log().actions.push(`${p.u.role} の成果物に欠陥 ${c.defects.length} 件を見つけたので、修正の巡（${p.round + 1} 巡目）を出した。`);
        next.push({ ...p, round: p.round + 1, prev: c.defects.length, reviseRef: ref });
      });
      pending = next;
    }
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
    const units = this.targets.map((t) => ({
      role: 'extractor',
      spec: (round, reviseRef) => ({ role: 'extractor', stage: '洗い出し', target_id: t.id, input_refs: [{ name: 'request', ref: 'request.json' }, { name: 'manifest', ref: join('targets', t.id, 'manifest.json') }], revise_defects_ref: reviseRef }),
      check: (ret) => {
        const outs = ret.outputs.filter((o) => o.kind === 'inventory');
        if (outs.length !== 1) return { defects: [defect('other', 'inventory-count', `inventory が ${outs.length} 個（ちょうど 1 つ）`)], value: null };
        let data;
        try { data = JSON.parse(readFileSync(join(this.runDir, outs[0].ref), 'utf8')); } catch { return { defects: [defect('syntax', 'inventory-read', 'inventory を読めない')], value: null }; }
        return { defects: coverageCheck(this.runDir, data, t), value: { ref: outs[0].ref, data } };
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
    const inputs = [{ name: 'request', ref: 'request.json' }, ...this.inventories.map((i) => ({ name: `inventory-${i.target_id}`, ref: i.ref })), ...this.targets.map((t) => ({ name: `manifest-${t.id}`, ref: join('targets', t.id, 'manifest.json') }))];
    const unit = {
      role: 'model-author',
      spec: (round, reviseRef) => ({ role: 'model-author', stage: 'モデル化', property_ids: eligible.map((p) => p.id), input_refs: inputs, revise_defects_ref: reviseRef }),
      check: (ret, task) => {
        const prefix = `${relative(this.runDir, task.attempt_dir)}/`;
        const c = modelCheck(this.runDir, ret.outputs, { prefix, eligible: eligibleSet });
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
    if (this.candidates.length >= 2 && this.models.length) {
      const cands = this.candidates.map(({ id, nodes }) => ({ id, nodes }));
      const known = new Set((this.request?.known_requirements ?? []).map((k) => k.id));
      const unit = {
        role: 'partition-author',
        spec: (round, reviseRef) => ({ role: 'partition-author', stage: '計画', candidates: cands, input_refs: modelInputs, revise_defects_ref: reviseRef }),
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
          if (!last.value || !last.value.check.valid) { this.notCreatedFor('partition-author', '分割作成役の成果物が形に合わない'); return; }
          if (!this.registerAuthor(last, ['partitions'])) return;
          const { data, check } = last.value;
          this.partitionDefects = last.defects;
          if (last.defects.length) {
            // 欠陥の残った分割は採らない（artifact-formats.md「欠陥の残った分割」）。計画作成役には分割の無いモデルだけを渡す
            this.partitionRejected = true;
            this.decisions = this.candidates.map((c) => ({ candidate_id: c.id, adopted: false, reason: PARTITION_REJECTED }));
            this.log('計画').unconfirmed.push(...last.defects.map((d) => `分割の欠陥が残った: ${d.text}`));
            return;
          }
          this.decisions = data.decisions;
          if (data.adopted) {
            const queries = [...data.contracts, ...data.composition_conditions].map((x) => x.query_ref);
            for (const q of queries) if (this.registerAgentFile('query', q, last.task, last.materials)) this.queryRefs.set(q, { kind: 'partition' });
            for (const [ref, v] of check.smtBad) this.smtBad.set(ref, v);
            this.partitions = { ref: last.value.ref, data };
          }
        },
        onFail: (why) => this.notCreatedFor('partition-author', why),
      };
      this.log().actions.push('分割の候補が 2 つ以上あるので分割作成役を出し、分割を照らした。');
      await this.authorRounds([unit]);
      if (this.halted()) return;
    }
    const modelProps = this.models.flatMap((m) => m.data.properties);
    if (modelProps.length === 0) {
      this.notCreatedFor('plan-author', '計画する形式化できる性質が無いので計画作成役を出さなかった');
      return;
    }
    const invProps = this.inventoryProperties();
    const formal = invProps.filter((p) => p.formalizable && !this.blockedBy.has(p.id) && modelProps.some((mp) => mp.inventory_property_ids.includes(p.id)));
    const inputs = [...modelInputs, ...(this.partitions ? [{ name: 'partitions', ref: this.partitions.ref }] : []), ...this.inventories.map((i) => ({ name: `inventory-${i.target_id}`, ref: i.ref }))];
    const unit = {
      role: 'plan-author',
      spec: (round, reviseRef) => ({ role: 'plan-author', stage: '計画', property_ids: formal.map((p) => p.id), input_refs: inputs, revise_defects_ref: reviseRef }),
      check: (ret, task) => {
        const read2 = (kind) => { const o = ret.outputs.find((x) => x.kind === kind); if (!o) return null; try { return { ref: o.ref, data: JSON.parse(readFileSync(join(this.runDir, o.ref), 'utf8')) }; } catch { return null; } };
        const plan = read2('plan');
        const mutations = read2('mutations');
        if (!plan || !mutations) return { defects: [defect('syntax', 'plan-missing', 'plan か mutations が無いか、JSON として読めない')], value: null };
        this.noteQuestions(ret, 'plan-author');
        const eligible = new Set(formal.filter((p) => !this.blockedBy.has(p.id)).map((p) => p.id));
        const blocked = new Set(this.blockedBy.keys());
        const c = planCheck(plan.data, mutations.data, {
          runDir: this.runDir, prefix: `${relative(this.runDir, task.attempt_dir)}/`, models: this.models, partitions: this.partitions?.data ?? null,
          eligible, blocked, prepare: this.prepare, authorQueries: new Set(this.queryRefs.keys()), smtBad: this.smtBad,
        });
        return { defects: c.defects, value: { plan, mutations, check: c } };
      },
      accept: (last) => {
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
        if (last.defects.length) this.log('計画').unconfirmed.push(...last.defects.map((d) => `計画の欠陥が残った: ${d.text}`));
      },
      onFail: (why) => this.notCreatedFor('plan-author', why),
    };
    this.log().actions.push('計画作成役を出し、計画を照らした。');
    await this.authorRounds([unit]);
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
    const deadline = this.clock.usableDeadlineWall;
    const queryOf = (refs) => Buffer.concat(refs.flatMap((r) => [readFileSync(join(this.runDir, r)), Buffer.from('\n')]));
    const add = (id, kind, refs, withModel, expected, seconds, dependsOn, meta) => {
      const entry = { id, kind, meta, inputRef: null, outcome: null, evidence: [], notStartedReason: null, stats: null };
      this.exec.set(id, entry);
      let query;
      try { query = queryOf(refs); } catch (e) { entry.notStartedReason = `query を読めない（${e.code ?? e.message}）`; return; }
      const inputRef = join('checks', id, 'input.smt2');
      if (!this.writeRecordFile(inputRef, query, { kind: 'query' })) { entry.notStartedReason = '道具に渡す query を保存できない'; return; }
      entry.inputRef = inputRef;
      entry.queryText = query.toString('utf8');
      if (!this.prepare?.ok) { entry.notStartedReason = `適した道具が無い（${this.prepare?.reason ?? '準備していない'}）`; return; }
      specs.push({ spec: { execution_id: id, kind, query: new Uint8Array(query), with_model: withModel, expected, tool_time_limit_seconds: seconds, deadline_ms: deadline }, depends_on: dependsOn });
    };
    for (const c of this.planChecks()) add(c.id, c.kind, c.input_refs, c.kind === 'property' || c.kind === 'composition', 'unsat', c.tool_time_limit_seconds, c.depends_on.filter((d) => !this.planDefects.has(d)), { check: c });
    for (const s of this.planSanity()) add(this.confIds.next('sanity'), 'sanity', s.input_refs, false, 'sat', s.tool_time_limit_seconds, [], { sanity: s });
    for (const m of this.planMutations()) {
      const det = this.plan.data.checks.find((c) => c.id === m.detector_check_id);
      add(this.confIds.next('mutation'), 'mutation', [...det.input_refs.slice(0, -1), m.mutation_ref], false, m.expected_violation, det.tool_time_limit_seconds, [], { mutation: m, detector: det });
    }
    this.log().actions.push(`道具の実行 ${this.exec.size} 件を、同時に動かす数の上限と検査に使える期限の下で動かした。`);
    if (this.clock.usableExpired()) { this.timeLimitReached('実行を始める時点で、検査に使える期限が過ぎていた'); for (const s of specs) this.abortExec(s.spec.execution_id, '時間の上限'); specs.length = 0; }
    await this.runSpecs(specs);
    // 反例の replay（同じ期限）
    const replaySpecs = [];
    for (const c of this.planChecks()) {
      if (c.kind !== 'property' && c.kind !== 'composition') continue;
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
    for (const e of this.exec.values()) {
      if (e.outcome && e.outcome.end.stopped_by === '時間') this.timeLimitReached('検査に使える期限に達したので、実行中の道具を止めた');
      if (e.outcome && !e.outcome.end.started && e.outcome.not_started_reason !== 'dependency' && this.clock.limited && this.clock.usableExpired()) this.timeLimitReached('検査に使える期限に達したので、始めていない実行を始めなかった');
    }
    this.buildConfirmationsAfterExecution();
    this.timing.checksMs = Number((process.hrtime.bigint() - t0) / 1000000n);
    this.log().results.push(`実行 ${this.exec.size} 件を終えた。反例 ${this.counterexamples.length} 件。`);
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
        if (o.not_started_reason === 'dependency') e.notStartedReason = '依存先の検査が 成功 でない';
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
      if (c.kind !== 'property' && c.kind !== 'composition') continue;
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
  }

  // ---- 確認 ----
  async confirmation() {
    const t0 = process.hrtime.bigint();
    const invProps = this.inventoryProperties();
    const nonformal = invProps.filter((p) => !p.formalizable && !this.blockedBy.has(p.id));
    const units = reviewUnits({ inventories: this.inventories, nonformal, models: this.models, partitionsAdopted: Boolean(this.partitions?.data.adopted) });
    const subjects = this.causeSubjects();
    const specs = [];
    // input_refs は観点ごとの表のとおり（artifact-formats.md「独立検証者と原因の分類役の input_refs」）。先頭は request.json、
    // 実在しない ref（実行していない検査の記録など）は入れない
    const R = (name, ref) => ({ name, ref });
    const exists = (ref) => { try { statSync(join(this.runDir, ref)); return true; } catch { return false; } };
    const withRequest = (refs) => [R('request', 'request.json'), ...refs.filter((x) => x.ref && exists(x.ref))];
    const copyOf = (tid) => R(`copy-${tid}`, join('targets', tid, 'files'));
    const manifestOf = (tid) => R(`manifest-${tid}`, join('targets', tid, 'manifest.json'));
    const allCopies = () => this.targets.map((t) => copyOf(t.id));
    const allInventories = () => this.inventories.map((i) => R(`inventory-${i.target_id}`, i.ref));
    const modelRefs = (m) => [R(`model-${m.id}`, m.ref), R(`mapping-${m.id}`, m.mapping.ref)];
    const execRecord = (id) => R(`checks-${id}`, join('checks', id));
    const worklog = (stage) => R(`worklog-${stage}`, join('worklogs', `cli-${stage}.json`));
    const refsFor = (u) => {
      if (u.perspective === 'extraction') return [copyOf(u.target_id), manifestOf(u.target_id), ...this.inventories.filter((i) => i.target_id === u.target_id).map((i) => R('inventory', i.ref)), worklog('洗い出し')];
      if (u.perspective === 'nonformal') {
        const inv = this.inventories.find((i) => i.data.properties.some((p) => p.id === u.property_ids[0]));
        if (!inv) return [];
        const p = inv.data.properties.find((x) => x.id === u.property_ids[0]);
        const tids = [...new Set(p.source_ids.map((sid) => inv.data.elements.find((e) => e.id === sid)?.source.target_id).filter(Boolean))];
        return [...tids.map(copyOf), R(`inventory-${inv.target_id}`, inv.ref)];
      }
      if (u.perspective === 'composition') {
        const parts = this.partitions?.data;
        const queries = parts ? [...parts.contracts, ...parts.composition_conditions].map((x) => R(`query-${x.id}`, x.query_ref)) : [];
        const execs = this.planChecks().filter((c) => c.kind === 'contract' || c.kind === 'composition').map((c) => execRecord(c.id));
        return [...(this.partitions ? [R('partitions', this.partitions.ref)] : []), ...this.models.map((m) => R(`model-${m.id}`, m.ref)), ...queries, ...execs, worklog('計画')];
      }
      const m = this.models.find((x) => x.id === u.model_id);
      if (u.perspective === 'fidelity') return [...allCopies(), ...this.targets.map((t) => manifestOf(t.id)), ...allInventories(), ...modelRefs(m), worklog('モデル化')];
      // assurance: そのモデルの性質を target_id か model_property_id に持つ実行の記録
      const mp = m.data.properties.find((x) => x.id === u.model_property_id);
      const execIds = [...(this.plan?.data.checks ?? []).filter((c) => c.target_id === u.model_property_id).map((c) => c.id),
        ...this.confirmations.deterministic.filter((c) => ['sanity', 'mutation', 'replay'].includes(c.kind) && c.model_property_id === u.model_property_id).map((c) => c.id)];
      return [...modelRefs(m), R('query', mp.query_ref), ...(this.plan ? [R('plan', this.plan.ref)] : []), ...(this.mutations ? [R('mutations', this.mutations.ref)] : []), ...execIds.map(execRecord)];
    };
    const causeRefsFor = (s) => {
      if (s.kind === 'counterexample') {
        const x = this.counterexamples.find((c) => c.id === s.id);
        const check = this.planChecks().find((c) => c.id === x.check_id);
        const m = this.models.find((y) => y.id === check?.model_id);
        return [...allCopies(), execRecord(x.check_id), ...(x.replayId ? [execRecord(x.replayId)] : []), ...(m ? modelRefs(m) : [])];
      }
      if (s.kind === 'combination') return [...allCopies(), ...this.models.filter((m) => m.id === s.model_id).flatMap(modelRefs), worklog('モデル化')];
      const q = this.authorQuestions.find((x) => x.q.id === s.id);
      return [...allCopies(), ...(q?.outputRefs ?? []).map((ref, i) => R(`output-${i + 1}`, ref))];
    };
    for (const u of units) specs.push({ role: u.role, stage: '確認', unit_id: u.unit_id, perspective: u.perspective, target_id: u.target_id, model_id: u.model_id, property_ids: u.property_ids, input_refs: withRequest(refsFor(u)), __unit: u });
    for (const s of subjects) specs.push({ role: 'cause-analyst', stage: '確認', unit_id: causeUnitId(s, this.combinations ?? []), subject: s, input_refs: withRequest(causeRefsFor(s)), __subject: s });
    this.log().actions.push(`確認の unit ${units.length} 件と原因の分類 ${subjects.length} 件を、${AGENT_BATCH_MAX} 件ずつの batch で出した。`);
    const results = specs.length ? await runTasks(this, specs.map(({ __unit, __subject, ...s }) => s)) : [];
    results.forEach((r, i) => {
      const spec = specs[i];
      if (spec.__unit) this.meaningFrom(spec.__unit, r);
      else this.causeFrom(spec.__subject, r);
    });
    this.timing.confirmationMs = Number((process.hrtime.bigint() - t0) / 1000000n);
    this.log().results.push(`意味の確認 ${this.confirmations.meaning.length} 件、原因 ${this.causes.length} 件を回収した。`);
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
    const propertyIds = u.perspective === 'fidelity' ? fidelityProps() : (u.perspective === 'nonformal' || u.perspective === 'assurance') ? [...u.property_ids] : [];
    const conf = {
      id: this.confIds.next(u.perspective), kind: u.perspective, property_ids: propertyIds, model_property_id: u.perspective === 'assurance' ? u.model_property_id : null, plan_id: null,
      item: u.unit_id, result: '確認できず', checker: r.task ? r.task.task_id : 'cli', materials: (r.materials ?? []).map((m) => ({ ref: m.ref, hash: m.hash })), end: null, reason: '',
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
    if (!r.task) conf.checker = 'cli';
    if (conf.result === '確認できず') this.unverified.push({ item: u.unit_id, reason: conf.reason });
    this.confirmations.meaning.push(conf);
  }

  causeFrom(subject, r) {
    if (r.ok) {
      this.registerAgentFile('worklog', r.ret.worklog_ref, r.task, r.materials);
      this.registerAgentFile('review_record', r.ret.record_ref, r.task, r.materials);
      this.causes.push({ subject, cause: r.ret.cause, grounds: r.ret.grounds, classified_by: r.task.task_id });
      if (r.ret.cause === '要求の不足') for (const q of r.ret.questions) if (!this.resultQuestions.some((x) => x.id === q.id)) this.resultQuestions.push(q);
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

function invalidEndReason(end) {
  try { classifyCheck(end); return '不明'; } catch (e) { return e.message; }
}
