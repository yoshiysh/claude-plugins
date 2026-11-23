// 担当の呼び出し（architecture.md「担当の起動」、cli-contract.md「依頼と応答」「受け箱」、artifact-formats.md「claim の Task」）。
// run-daemon は呼び出しを 1 つ開き、Workflow が起動した役の claim・query・submit の依頼を届いた順に 1 つずつ処理して応答を書く。
// 担当の受理は submit の照合で決まり、司令塔の close は Workflow の返り値（起動の記録と tokens）を記録して呼び出しを閉じるだけである。
// 台帳と run の状態を書くのは run-daemon だけで、役と client は依頼のファイルを公開するだけ（Lock.tla・salvage の前提）。
// 1 体の worker は 1 つ以上の担当（task）を持つ。claim はその worker の出し終えていない担当を全て返し、submit は担当ごとに受理か拒否を返す。
// 差し戻しの無い submit の応答は、同じ claim の規則で次に出す担当を next に持つ（担当は終わりの claim を流さない）。
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join, posix, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { collectReturn, completeQuoteHashes, completeWorklog, expandRefHashes, makeTask, returnSchemaOf, WORKFLOW_SCRIPT } from './agents.mjs';
import { ROLES } from './roles.mjs';
import { CloseContent, REVISE_ROUNDS_MAX, UNIT_MAX_BYTES, WORKER_CALL_MAX_MS, WorkflowReturn, conforms } from './schemas.mjs';
import { guardedWrite, SalvagedError } from './store.mjs';
import { parseTargetRef } from './target-refs.mjs';

const CLI_PATH = fileURLToPath(new URL('../formal-method-cli.mjs', import.meta.url));
const REQUEST_POLL_MS = 50;
const REQUEST_NAME_RE = /^\d+-[0-9a-f]+\.json$/;
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
// 1 つの担当の提出の上限。作成役の出し直し（REVISE_ROUNDS_MAX 巡）と同じ数で、形の違いの出し直しにも当てる
export const SUBMITS_MAX = REVISE_ROUNDS_MAX + 1;
// submit の応答を、依頼の公開（req_id の時刻）から WORKER_CALL_MAX_MS − この幅より後に書いたら、client は no_response で諦めた
// （応答を見ていない）とみなす。境目の応答を見なかった側に倒す（見た応答を見ていないとみなしても、流し直しの 1 往復が増えるだけ）
const UNSEEN_MARGIN_MS = 1000;

// 役が CLI を流す入口（<run_dir>/formal-method-cli.mjs）。args は {state, callId, stage, workers} だけで CLI の置き場を運べないので、
// Workflow script は run の領域の下のこの名前を prompt に書く。中身は本物の CLI を絶対パスで import するだけで、判断も照合も持たない。
// 台帳には登録しない（run の記録ではなく、呼び出しのたびに書き直す入口）。coverage-audit の LAUNCHER の型。
export const LAUNCHER = 'formal-method-cli.mjs';
export const launcherText = () => `// 生成物: run-daemon が呼び出しのたびに書き直す。本物の CLI を流すだけ。\nimport ${JSON.stringify(pathToFileURL(CLI_PATH).href)};\n`;

// sq・unwrap は formal-method 独自の実装（coverage-audit の同名の関数の写しではなく、一致も検査しない。architecture.md「部品の責務」）。
// shell の 1 語にする（' は '\'' に置き換える）。
export const sq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
// native Workflow の完了通知（返り値を result に包んだ形 {summary, agentCount, logs, result}）も、そのまま受け付ける。
export function unwrap(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return v;
  return Object.hasOwn(v, 'result') && typeof v.summary === 'string' && typeof v.agentCount === 'number' ? v.result : v;
}

// 詰め合わせ（formal-method の数え方）: 単位の並び（ids の順）で前から、詰めた単位の資料の和集合のバイト数が cap に収まる所まで 1 体に詰める
// （next-fit。前に戻って詰めない）。同じ体の単位が共有する資料（対象のファイルの同じ行・inventory など）は 1 度だけ数える。1 件だけで超える単位は単独の束になる。
// filesOf(id) は単位の資料のファイルごとのバイト数（agents.mjs の refFiles。範囲を渡す対象のファイルは行ごと）。
export const unionBytes = (maps) => { const seen = new Map(); for (const m of maps) for (const [k, v] of m) seen.set(k, v); let n = 0; for (const v of seen.values()) n += v; return n; };
export function packByUnion(ids, filesOf, cap = UNIT_MAX_BYTES) {
  const out = [];
  let cur = null;
  for (const id of ids) {
    const f = filesOf(id);
    if (cur && unionBytes([cur.files, f]) <= cap) { cur.ids.push(id); cur.files = new Map([...cur.files, ...f]); continue; }
    cur = { ids: [id], files: new Map(f) };
    out.push(cur);
  }
  return out.map((x) => x.ids);
}

// CLI の 1 回の呼び出しの命令（標準入力の 1 つの JSON）。via は CLI の path（本物か入口）。
export const cliCommand = (via, command, input) => `printf '%s' ${sq(JSON.stringify(input))} | ${sq(process.execPath)} ${sq(via)} ${command}`;
const refusal = (reason, text) => ({ ok: false, code: 'E_CALL', reason: text, detail: { reason } });

// ref → 担当に渡す path（対象の ref は元のファイルの絶対パス）。run が pathOf を持たなければ run の領域の下
const pathOfRun = (run) => (run.pathOf ? (ref) => run.pathOf(ref) : (ref) => join(run.runDir, ref));

// run の領域の中の相対の ref に正規化する（. と .. を畳み、末尾の / を除く）。絶対の path か、畳んだ後に領域の外を指す ref は null。
const normRef = (ref) => {
  if (typeof ref !== 'string' || ref === '' || ref.startsWith('/')) return null;
  const n = posix.normalize(ref).replace(/\/+$/, '');
  return n === '..' || n.startsWith('../') || n === '.' ? null : n;
};
// 資料の ref が担当の input_refs の中か（正規化した後で、同じ ref か、ディレクトリの ref の下）。
const within = (inputRefs, ref) => {
  const n = normRef(ref);
  return n !== null && inputRefs.some((x) => { const b = normRef(x.ref); return b !== null && (n === b || n.startsWith(`${b}/`)); });
};

// worker の行の役。1 体が 2 つ以上の役の担当を持つ（分割と計画）なら、出てくる順に + でつなぐ。
const roleOfItem = (item) => item.role ?? item.spec.role;
const rowRole = (items) => [...new Set(items.map(roleOfItem))].join('+');

// 担当の項目（items）を 1 つの呼び出しに出す。1 体に 1 担当。戻り値は items と同じ順の結果。
export async function runItems(run, items) {
  const out = await runWorkers(run, items.map((item) => ({ items: [item] })));
  return out.map((w) => w.results[0]);
}

// worker（1 体が持つ担当の並び）を 1 つの呼び出しに出す。戻り値は workers と同じ順の [{ results, nextCap }]。
export async function runWorkers(run, workers) {
  if (workers.length === 0) return [];
  return runCall(run, { stage: roleStage(workers), workers });
}
const roleStage = (workers) => {
  const it = workers[0].items[0];
  return it.stage ?? it.spec.stage;
};

// 1 つの呼び出しを開き、閉じるまで依頼を処理する。workers の行は w01, w02, … の順。
// worker: { items: [item], mode?: 'all' | 'fit', cap? }
//   mode 'all'（既定）: 最初の claim で、依存の無い全ての担当を返す。item.after（同じ worker の前の item の位置）は、その担当が閉じてから返す。
//   mode 'fit': 出し終えた後の claim と submit の next ごとに、残りの item を並びの順に、資料の和集合のバイト数（item.files、無ければ item.bytes）が cap に収まる所まで束で返す（next-fit）。
// item: { spec | role + spec() → spec | null, stage?, check?(ret, task), observe?(ret), onAccept?(), expect?(ret) → 文 | null, settle?(r), revoke?(r), after?, bytes? }
//   check は作成役の照合（欠陥が減っているうちは同じ担当に出し直させる）、expect は確認役の返り値の追加の照合（形の違いとして扱う）。
//   onAccept は、submit の照合でその担当を受理した時点で呼ぶ（unit をまたぐ照合が、相手が受理済みかを知るため）。閉じた時点の受理では呼ばない。
//   settle があれば、その担当が閉じた時点で結果を渡す（後の担当の spec がその結果を使うため）。呼び出しを開けなかったときも渡す。
//   revoke は、settle で受理を渡した担当の attempt の領域が、呼び出しを閉じるまでに書き換わったときに呼ぶ（渡した受理を取り消す）。
// 戻り値: workers と同じ順の [{ results: [r], nextCap }]。r は { spec, task, ok, ret?, cause?, materials, last?, notIssued?, released? }。
//   released は、mode 'fit' の束を取ったまま出さずに手放した担当と、まだ取っていない担当（次の呼び出しで出し直せる）。
//   nextCap は mode 'fit' の次の束の上限（取ったまま 1 件も出さなかった束があれば、その束の量の半分）。
export async function runCall(run, { stage, workers }) {
  // 呼び出しを開けなかったときも、settle を持つ担当には結果を渡す（閉じた時点で渡す経路と同じく、unit の onFail に届く）
  const notIssued = (why) => workers.map((w) => {
    const results = w.items.map((it) => ({ spec: typeof it.spec === 'function' ? null : it.spec, task: null, ok: false, notIssued: true, cause: why, materials: [] }));
    w.items.forEach((it, i) => { if (it.settle) it.settle(results[i]); });
    return { results, nextCap: w.cap ?? null };
  });
  if (run.halted()) return notIssued('中断の理由があるので担当を出さなかった');
  const deadline = run.clock.batchDeadlineWall();
  if (run.clock.limited && (run.clock.usableExpired() || deadline <= Date.now())) {
    run.timeLimitReached('担当の呼び出しを開く時点で、検査に使える期限が過ぎていた');
    return notIssued('時間の上限で担当を出さなかった');
  }
  const callId = `call-${String(run.nextCallNo()).padStart(3, '0')}`;
  const ws = workers.map((w, k) => {
    const id = `w${String(k + 1).padStart(2, '0')}`;
    const roles = [...new Set(w.items.map(roleOfItem))];
    const r0 = ROLES[roles[0]];
    if (roles.some((r) => ROLES[r].model !== r0.model || ROLES[r].effort !== r0.effort)) throw new Error(`1 体の worker の担当の model・effort が違う: ${roles.join(', ')}`);
    return {
      id, mode: w.mode ?? 'all', cap: w.cap ?? UNIT_MAX_BYTES, submits: 0, claims: 0, lastSubmit: null,
      row: { id, role: rowRole(w.items), model: r0.model, effort: r0.effort },
      entries: w.items.map((item, i) => ({ item, i, state: null, result: null })),
    };
  });
  const ctx = { run, callId, deadline, ws, closed: false };
  const rows = ws.map((w) => w.row);
  const argsRef = join('calls', callId, 'args.json');
  const args = { state: run.runDir, callId, stage, workers: rows };
  // mode 'all' の依存の無い担当は、呼び出しを開く時点で task を作る（呼び出しの記録に載せる）。他は claim と submit の next の時点で作る
  for (const w of ws) {
    if (w.mode !== 'all') continue;
    for (const e of w.entries) if (e.item.after === undefined && typeof e.item.spec !== 'function') newState(ctx, w, e);
  }
  // attempt の領域・worker の scratch_dir・依頼と応答の置き場を作り、記録と入口を書く。どれかが書けなければ担当を出さない（保存の失敗）。
  // scratch_dir を呼び出しを開く時点で作るのは、claim が無い scratch_dir を返さないため（作れないときは claim を受ける前に run を止める）
  for (const s of allStates(ctx)) {
    try { mkdirSync(s.task.attempt_dir, { recursive: true }); } catch (e) { run.saveFailed('worklog', relative(run.runDir, s.task.attempt_dir), `attempt の領域を作れない（${e.code ?? e.message}）`); return notIssued('attempt の領域を作れないので担当を出さなかった'); }
  }
  for (const w of ws) {
    const dir = scratchOf(ctx, w);
    try { mkdirSync(dir, { recursive: true }); } catch (e) { run.saveFailed('worklog', relative(run.runDir, dir), `worker の scratch_dir を作れない（${e.code ?? e.message}）`); return notIssued('worker の scratch_dir を作れないので担当を出さなかった'); }
  }
  run.removeClosedExchanges();
  try {
    for (const d of ['requests', 'responses']) mkdirSync(join(run.runDir, d, callId), { recursive: true });
    guardedWrite(run.runDir, LAUNCHER, launcherText());
  } catch (e) {
    if (e instanceof SalvagedError) throw e;
    run.saveFailed('worklog', LAUNCHER, `役の入口か依頼の置き場を書けない（${e.code ?? e.message}）`);
    return notIssued('役の入口を書けないので担当を出さなかった');
  }
  if (!writeTasks(ctx, stage) || !run.writeRecordFile(argsRef, JSON.stringify(args, null, 2), { kind: 'worklog', register: false })) return notIssued('呼び出しの記録を保存できないので担当を出さなかった');
  run.writeStatus('run_agents', { call_id: callId, args_path: join(run.runDir, argsRef), deadline_wall_ms: deadline, workflow_script: WORKFLOW_SCRIPT });

  const reqDir = join(run.runDir, 'requests', callId);
  const box = join(run.runDir, 'inbox', `${callId}.json`);
  const seen = new Set();
  let closedBy = 'deadline';
  for (;;) {
    drain(ctx, reqDir, seen);
    if (existsSync(box)) { drain(ctx, reqDir, seen); closedBy = 'close'; break; }
    if (Date.now() >= deadline) { drain(ctx, reqDir, seen); break; }
    await sleep(REQUEST_POLL_MS);
  }
  ctx.closed = true;
  const out = ws.map((w) => finalizeWorker(ctx, w));
  // 呼び出しの記録は、claim と submit の next の時点で作った担当を含めて書き直す（登録しない記録）
  writeTasks(ctx, stage);
  recordClose(run, { callId, stage, box, closedBy, rows, tasks: allStates(ctx).length });
  run.writeStatus('working', null);
  // 依頼と応答は受け渡しの口で、記録ではない。閉じた直後は、最後の drain の応答を client が読み直すので残し、
  // 次の呼び出しを開くときか集約で消す（cli-contract.md「依頼と応答」「run の領域の配置」）
  run.closedCalls.push(callId);
  return out;
}

const allStates = (ctx) => ctx.ws.flatMap((w) => w.entries.filter((e) => e.state).map((e) => e.state));
function writeTasks(ctx, stage) {
  const record = { call_id: ctx.callId, stage, deadline_wall_ms: ctx.deadline, tasks: allStates(ctx).map((s) => ({ worker: s.worker.id, task: s.task, input_refs: s.inputRefs })) };
  return ctx.run.writeRecordFile(join('calls', ctx.callId, 'tasks.json'), JSON.stringify(record, null, 2), { kind: 'worklog', register: false });
}

// 担当の task を作る。spec が関数なら、この時点で作る（null なら担当を出さない）。
function newState(ctx, w, e) {
  const spec = typeof e.item.spec === 'function' ? e.item.spec() : e.item.spec;
  if (!spec) { e.result = { spec: null, task: null, ok: false, notIssued: true, cause: '担当を出す時点で、出す対象が無かった', materials: [] }; return null; }
  const { task, inputRefs } = makeTask(ctx.run, spec);
  e.state = { entry: e, spec, task, inputRefs, worker: w, claimed: false, materials: null, submits: 0, prev: Infinity, last: null, lastCause: null, done: false, ok: false, ret: null, cause: null, snapshot: null, evalSig: null };
  return e.state;
}

// 届いた依頼を名前（届いた時刻の順）で 1 つずつ処理し、応答を書く。処理した依頼は seen に入れ、2 度処理しない。
function drain(ctx, reqDir, seen) {
  let names;
  try { names = readdirSync(reqDir).filter((n) => REQUEST_NAME_RE.test(n)).sort(); } catch { return; }
  for (const name of names) {
    if (seen.has(name)) continue;
    seen.add(name);
    let req = null;
    try { req = JSON.parse(readFileSync(join(reqDir, name), 'utf8')); } catch { /* 下で拒否する */ }
    let res;
    try { res = req && typeof req === 'object' ? handle(ctx, req, name) : { ok: false, code: 'E_INPUT', reason: '依頼のファイルを読めない', detail: { reason: 'shape' } }; } catch (e) {
      if (e instanceof SalvagedError) throw e;
      writeResponse(ctx, name, { ok: false, code: 'E_INTERNAL', reason: `run-daemon が依頼を処理できない: ${String(e && e.message ? e.message : e).slice(0, 300)}`, detail: null });
      throw e;
    }
    if (!writeResponse(ctx, name, res)) markUnseen(ctx, req, res);
  }
}

// 書けなかった submit の応答は、担当が見ていない（流し直しに前の応答を返す）。印を付けるのは、書けなかった応答が前の submit の応答
// （照合した応答か、流し直しに返した同じ応答）のときだけで、拒否の応答を書けなかったときは付けない
export function markUnseen(ctx, req, res) {
  if (!req || req.command !== 'submit') return;
  const w = ctx.ws.find((x) => x.id === req.worker);
  if (w && w.lastSubmit && w.lastSubmit.response === res) w.lastSubmit.unseen = true;
}
// 依頼の公開（req_id の時刻）から今までが、client が応答を待つ上限に近ければ、担当はこの応答を見ていない
const unseenNow = (name) => { const sentAt = Number(String(name).split('-')[0]); return !Number.isFinite(sentAt) || Date.now() - sentAt >= WORKER_CALL_MAX_MS - UNSEEN_MARGIN_MS; };

// 応答は guardedWrite（salvage.mark があれば書かない）で rename して置く。書けなければ client は応答の待ちの上限で no_response になる。
function writeResponse(ctx, name, res) {
  try { guardedWrite(ctx.run.runDir, join('responses', ctx.callId, name), res); return true; } catch (e) {
    if (e instanceof SalvagedError) throw e;
    ctx.run.log().failures.push(`呼び出し ${ctx.callId} の依頼 ${name} の応答を書けない（${e.code ?? e.message}）`);
    return false;
  }
}

// 依頼を呼び出しと worker で照らす（coverage-audit の pendingWorker の型）。外れたら拒否の応答を返す。
function pendingWorker(ctx, req) {
  if (ctx.closed) return { refuse: refusal('call_closed', `呼び出し ${ctx.callId} は閉じた。worker を終える`) };
  const w = ctx.ws.find((x) => x.id === req.worker);
  if (!w) return { refuse: refusal('unknown_worker', `呼び出し ${ctx.callId} の workers に無い worker: ${req.worker}`) };
  return { w };
}

const held = (w) => w.entries.filter((e) => e.state && !e.state.done).map((e) => e.state);

function handle(ctx, req, name) {
  const { refuse, w } = pendingWorker(ctx, req);
  if (refuse) return refuse;
  const late = Date.now() >= ctx.deadline;
  if (req.command === 'claim') {
    const c = claimNext(ctx, w, late);
    if (c.refuse) return c.refuse;
    if (c.done) return { ok: true, done: true };
    w.claims += 1;
    return { ok: true, ...workerFields(ctx, w), ...batchOf(ctx, c.hs) };
  }
  if (req.command === 'query') {
    const s = w.entries.map((e) => e.state).find((x) => x && x.claimed && x.task.task_id === req.task_id);
    if (!s) return refusal('outside_task', `この worker が取った担当に無い: ${req.task_id}`);
    if (late) return refusal('deadline_passed', `呼び出し ${ctx.callId} の期限を過ぎた`);
    const refs = req.refs ?? s.inputRefs.map((x) => x.ref);
    const outside = refs.filter((r) => !within(s.inputRefs, r));
    if (outside.length) return refusal('outside_task', `担当の資料の外: ${outside.join(', ')}`);
    // 渡した資料の指紋は、最初の query の時点で固定する（SP-FORMALMETHOD-012 の「渡した資料」）
    if (!s.materials) {
      s.materials = expandRefHashes(ctx.run.runDir, s.inputRefs, pathOfRun(ctx.run));
      // 対象のファイルの指紋は、集約の段で受付の指紋と照らす（run.mjs の checkTargetsFixed）
      if (ctx.run.noteMaterials) ctx.run.noteMaterials(s.materials);
    }
    const pathOf = pathOfRun(ctx.run);
    // 範囲を持つ資料は spans を返す（担当はその行だけを読む。agent-obligations.md）。refs で引いたディレクトリの下のファイルは範囲を持たない。
    // ファイルの資料は固定した指紋 hash を持つ（担当は指紋を求めない。作業記録の指紋は submit の照合で CLI が補う）。ディレクトリの資料は
    // 指紋を返さない（その下のファイルごとの指紋は materials と台帳の input_refs に残る）
    const spansOf = (ref) => s.inputRefs.find((x) => normRef(x.ref) === ref)?.spans;
    const hashOf = new Map(s.materials.map((m) => [m.ref, m.hash]));
    const one = (name, ref) => ({ name, ref, path: pathOf(ref), ...(hashOf.has(ref) ? { hash: hashOf.get(ref) } : {}), ...(spansOf(ref) ? { spans: [...spansOf(ref)] } : {}) });
    const inputs = req.refs ? refs.map(normRef).map((ref) => one((s.inputRefs.find((x) => normRef(x.ref) === ref) ?? { name: null }).name, ref))
      : foldDirs(s.inputRefs.map((x) => one(x.name, x.ref)), pathOf);
    return { ok: true, task_id: s.task.task_id, inputs };
  }
  if (req.command === 'submit') {
    const mine = claimedOf(w);
    if (!mine.length) return refusal('outside_task', 'この worker は担当を取っていない（claim を先に流す）');
    // 担当が見ていない前の応答（応答の待ちの上限 no_response の後か、応答を書けなかった）があり、その後に取った担当の attempt の領域
    // （result_path を含む）が 1 つも変わっていなければ、照合し直さず前の応答を返す。同じ submit の流し直しで、提出の回数と結果が変わらない
    // （期限の後でも、期限の前の提出の応答を返す）。見た応答の後の同じ提出は、直せなかった提出として照合する（欠陥が減らなければ受理する）
    // 取った担当は呼ぶたびに数え直す（この submit の next で取った担当も、次の流し直しの照らし合わせに入れる）
    const sigOf = () => JSON.stringify(claimedOf(w).map((s) => [s.task.task_id, attemptHashes(ctx.run, s)]));
    const sig = sigOf();
    // 前の応答を返したときも、この流し直しの依頼の時刻で見たかを決め直す（この応答も見られなければ、次の流し直しにも同じ応答を返す）
    if (w.lastSubmit && w.lastSubmit.unseen && w.lastSubmit.sig === sig) { w.lastSubmit.unseen = unseenNow(name); return w.lastSubmit.response; }
    const hs = mine.filter((s) => !s.done);
    // 受理の後の同じ submit（照合しない）も next を持つ（cli-contract.md の submit の next）
    if (!hs.length) return withNext(ctx, w, { ok: true, results: mine.map((s) => result(s, s.ok, [])) });
    if (late) return refusal('deadline_passed', `呼び出し ${ctx.callId} の期限（deadline_wall_ms ${ctx.deadline}）を過ぎたので、提出を受け付けない`);
    w.submits += 1;
    // 照合するのは、返り値があり、前の照合から attempt の領域が変わった担当。無ければ出し終えていない全ての担当を照合する（無い返り値を返す）
    const fresh = hs.filter((s) => existsSync(s.task.result_path) && attemptHashes(ctx.run, s) !== s.evalSig);
    const response = withNext(ctx, w, { ok: true, results: (fresh.length ? fresh : hs).map((s) => submit(ctx, s)) });
    w.lastSubmit = { sig: sigOf(), response, unseen: unseenNow(name) };
    return response;
  }
  return { ok: false, code: 'E_INPUT', reason: `未知の依頼: ${req.command}`, detail: { reason: 'shape' } };
}

// query の応答を小さくする: run の領域の中の同じディレクトリの資料（範囲を持たない）が 2 つ以上続けば、そのディレクトリの 1 つの ref と path と
// entries（[{name, entry}]。entry はディレクトリの中の名前）に畳む。続いた並びだけを畳むので、entries を順に戻すと input_refs の並びになる。
// 畳んだ資料の指紋は返さない（materials と台帳の input_refs に残る）。対象のファイルの ref と、run の領域の根の資料は畳まない（cli-contract.md の query）
function foldDirs(items, pathOf) {
  const dirOf = (x) => { const n = normRef(x.ref); if (x.spans || n === null || parseTargetRef(x.ref)) return null; const d = posix.dirname(n); return d === '.' ? null : d; };
  const out = [];
  for (let i = 0; i < items.length;) {
    const d = dirOf(items[i]);
    let j = i + 1;
    while (d && j < items.length && dirOf(items[j]) === d) j += 1;
    if (j - i < 2) { out.push(items[i]); i += 1; continue; }
    out.push({ ref: `${d}/`, path: `${pathOf(d)}/`, entries: items.slice(i, j).map((x) => ({ name: x.name, entry: posix.basename(normRef(x.ref)) })) });
    i = j;
  }
  return out;
}

// 束の担当の資料のファイルごとのバイト数。item.files（refFiles）が無ければ、item.bytes をその担当だけのファイル 1 つとして数える
const filesOfEntry = (e) => e.item.files ?? new Map([[`#item-${e.i}`, e.item.bytes ?? 0]]);

const deadlinePassed = (ctx) => refusal('deadline_passed', `呼び出し ${ctx.callId} の期限（deadline_wall_ms ${ctx.deadline}）を過ぎた。worker を終える`);
const claimedOf = (w) => w.entries.map((e) => e.state).filter((x) => x && x.claimed);

// claim の規則（claim と submit の next が使う）: 出し終えていない担当を全て返し、無ければ次に出せる担当を作って返す
// （依存する担当が閉じた後の担当、束の worker なら次の束）。出せる担当も無ければ done。返す担当は取った担当にする。
// 戻り値は { refuse }（期限の後）・{ done: true }・{ hs } のどれか。
function claimNext(ctx, w, late) {
  let hs = held(w);
  if (!hs.length) {
    if (!w.entries.some((e) => !e.state && !e.result)) return { done: true };
    if (late) return { refuse: deadlinePassed(ctx) };
    hs = take(ctx, w);
    if (!hs.length) return { done: true };
  } else if (late) return { refuse: deadlinePassed(ctx) };
  for (const s of hs) s.claimed = true;
  return { hs };
}

// 差し戻し（done: false）の無い submit の応答に next を足す。中身は claim の応答の done・tasks・shared_inputs と return_schemas。
// 期限は next を作る直前に求め直す（照合の間に期限を越えたら、新しい task を作らない）。期限の後で claim の規則が拒むときは、
// 出せる担当が無いので done: true とする（cli-contract.md の submit の next）
function withNext(ctx, w, response) {
  if (response.results.some((r) => !r.done)) return response;
  const c = claimNext(ctx, w, Date.now() >= ctx.deadline);
  return { ...response, next: c.hs ? batchOf(ctx, c.hs) : { done: true } };
}

// claim と next が返す担当の束: task（artifact-formats.md「claim の Task」）と、役ごとに 1 つの返り値の形と、共有の資料
function batchOf(ctx, hs) {
  const schemas = {};
  for (const s of hs) if (!Object.hasOwn(schemas, s.task.role)) schemas[s.task.role] = returnSchemaOf(s.task);
  return { done: false, return_schemas: schemas, tasks: hs.map((s) => ({ ...s.task })), shared_inputs: sharedInputs(ctx, hs) };
}

// claim の応答の最上位に 1 度だけ置く、worker で 1 つの値（cli-contract.md「依頼と応答」）。query は <query_cmd> <task_id> で流す。
// scratch_dir は worker の作業用の領域で、呼び出しを開く時点で作ってある。task の attempt の領域の外なので受理の照合に入らず、台帳にも登録しない
const scratchOf = (ctx, w) => join(ctx.run.runDir, 'attempts', `${ctx.callId}-${w.id}`);
function workerFields(ctx, w) {
  const base = { run_dir: ctx.run.runDir, call_id: ctx.callId, worker: w.id };
  // document_rules: 適用する文書の一般規約の {ref, version}（担当は写しを読まず、作業記録の document_rules は submit の照合で CLI が補う）
  return { query_cmd: cliCommand(CLI_PATH, 'query', base), submit_cmd: cliCommand(CLI_PATH, 'submit', base), scratch_dir: scratchOf(ctx, w), document_rules: docRulesOf(ctx.run) };
}

// 出し終えた後の claim と submit の next で、次に返す担当を作る。中断の理由があれば新しい担当を出さない。
function take(ctx, w) {
  if (ctx.run.halted()) return [];
  const pending = w.entries.filter((e) => !e.state && !e.result);
  let pick;
  if (w.mode === 'fit') {
    pick = [];
    for (const e of pending) {
      if (pick.length && unionBytes([...pick, e].map(filesOfEntry)) > w.cap) break;
      pick.push(e);
    }
  } else pick = pending.filter((e) => e.item.after === undefined || Boolean(w.entries[e.item.after].state?.done || w.entries[e.item.after].result));
  const out = [];
  for (const e of pick) {
    const s = newState(ctx, w, e);
    if (!s) continue;
    try { mkdirSync(s.task.attempt_dir, { recursive: true }); } catch (err) {
      ctx.run.saveFailed('worklog', relative(ctx.run.runDir, s.task.attempt_dir), `attempt の領域を作れない（${err.code ?? err.message}）`);
      e.state = null;
      e.result = { spec: s.spec, task: null, ok: false, notIssued: true, cause: 'attempt の領域を作れないので担当を出さなかった', materials: [] };
      continue;
    }
    out.push(s);
  }
  return out;
}

const result = (s, ok, problems, extra = {}) => ({ task_id: s.task.task_id, ok, problems, done: s.done, ...extra });

// 同じ claim で返す 2 つ以上の task が共有する資料（input_refs の同じ ref）を 1 度だけ挙げる。担当はこれを 1 度だけ読み、task ごとの
// query の応答に同じ ref が出ても読み直さない。渡した資料の指紋は task ごとの最初の query で固定するので、ここでは指紋を取らない。
// 範囲は task ごとに残す（tasks: [{ task_id, spans? }]。和に畳まない）。担当は task ごとにその task の範囲だけで判断する（agent-obligations.md）
function sharedInputs(ctx, hs) {
  const by = new Map();
  for (const s of hs) for (const x of s.inputRefs) {
    if (!by.has(x.ref)) by.set(x.ref, []);
    const ts = by.get(x.ref);
    if (!ts.some((y) => y.task_id === s.task.task_id)) ts.push({ task_id: s.task.task_id, ...(x.spans ? { spans: [...x.spans] } : {}) });
  }
  const pathOf = pathOfRun(ctx.run);
  return [...by].filter(([, ts]) => ts.length >= 2).map(([ref, ts]) => ({ ref, path: pathOf(ref), tasks: ts }));
}

// 適用する文書の一般規約（受付で写しを保存できなかったときは、適用した版）。run が持たなければ null
const docRulesOf = (run) => run.docRules ?? run.docRulesIntended?.rules ?? null;

// 担当の下書きを補う（agents.mjs の completeWorklog・completeQuoteHashes）。照合の前に attempt の領域のファイルを書き直すので、
// 提出の指紋（evalSig）と受理の指紋（snapshot）は補った後の領域で取る。戻り値は補いで見つけた欠陥の文（無ければ []）。
// 返り値を読めないか、参照が attempt の領域の外なら何もしない（collectReturn が形の違いにする）
function completeDrafts(ctx, s) {
  const { run } = ctx;
  let ret;
  try { ret = JSON.parse(readFileSync(s.task.result_path, 'utf8')); } catch { return []; }
  const prefix = `${relative(run.runDir, s.task.attempt_dir)}/`;
  const mine = (ref) => typeof ref === 'string' && ref.startsWith(prefix) && normRef(ref) === ref;
  const problems = [];
  const rewrite = (ref, value) => {
    try { guardedWrite(run.runDir, ref, `${JSON.stringify(value, null, 2)}\n`); return true; } catch (e) {
      if (e instanceof SalvagedError) throw e;
      problems.push(`${ref} に CLI が補った値を書けない（${e.code ?? e.message}）`);
      return false;
    }
  };
  const readJson = (ref) => { try { return JSON.parse(readFileSync(join(run.runDir, ref), 'utf8')); } catch { return null; } };
  if (ret && mine(ret.worklog_ref)) {
    const wl = readJson(ret.worklog_ref);
    const r = completeWorklog(wl, { materials: s.materials ?? [], pathOf: pathOfRun(run), docRules: docRulesOf(run) });
    problems.push(...r.problems);
    if (r.changed) rewrite(ret.worklog_ref, r.worklog);
  }
  if (s.task.role === 'extractor' && ret && Array.isArray(ret.outputs)) {
    const textOf = (tid, file) => {
      const f = (run.targets ?? []).find((t) => t.id === tid)?.files?.find((x) => x.path === file);
      return f && f.text && f.bytes ? Buffer.from(f.bytes).toString('utf8') : null;
    };
    for (const o of ret.outputs) {
      if (!o || o.kind !== 'inventory' || !mine(o.ref)) continue;
      const r = completeQuoteHashes(readJson(o.ref), textOf);
      if (r.changed) rewrite(o.ref, r.inventory);
    }
  }
  return problems;
}

// 1 つの担当の提出の照合: 下書きの補い（completeDrafts）、返り値の形（collectReturn）と、確認役なら追加の照合（expect）、作成役なら段の照合（check）。
function submit(ctx, s) {
  const { run } = ctx;
  const item = s.entry.item;
  s.submits += 1;
  const drafted = completeDrafts(ctx, s);
  s.evalSig = attemptHashes(run, s);
  const c0 = collectReturn(s.task);
  // 補いの欠陥（作業記録の指紋・document_rules の食い違い）は、返り値の形の違いと同じく同じ担当に直させる
  const c = c0.ok && drafted.length ? { ok: false, cause: `作業記録の欠陥（${drafted.join('; ')}）` } : c0;
  const extra = c.ok && item.expect ? item.expect(c.ret) : null;
  if (!c.ok || extra) {
    const cause = c.ok ? `返り値の形が違う（${extra}）` : c.cause;
    s.lastCause = cause;
    // 出し直しは同じ attempt の領域を書き換えるので、形の落ちた提出の後に前の提出を受理しない（前の成果物はもう残っていない）
    if (c.final || s.submits >= SUBMITS_MAX) fail(ctx, s, cause);
    else s.last = null;
    return result(s, false, [cause]);
  }
  if (!item.check) { s.last = { ret: c.ret, task: s.task, materials: s.materials ?? [], defects: [] }; return accept(ctx, s, s.last, []); }
  if (item.observe) item.observe(c.ret);
  const r = item.check(c.ret, s.task);
  s.last = { ret: c.ret, task: s.task, materials: s.materials ?? [], ...r };
  s.snapshot = attemptHashes(run, s);
  const remaining = r.defects.map((d) => d.text);
  if (r.defects.length === 0 || s.submits >= SUBMITS_MAX || r.defects.length >= s.prev || run.halted()) return accept(ctx, s, s.last, remaining);
  // 出し直しに返した欠陥は台帳の revisions に持つ（submit の応答の problems と同じ中身で、応答は呼び出しを閉じると消す）
  run.revisions.push({ task_id: s.task.task_id, submit: s.submits, stage: s.task.context.stage, defects: r.defects.map((d) => ({ key: d.key, text: d.text })) });
  run.log(s.task.context.stage).actions.push(`${s.task.role} の提出 ${s.submits} 回目に欠陥 ${r.defects.length} 件を見つけたので、同じ担当に出し直させた（台帳の revisions）。`);
  s.prev = r.defects.length;
  s.lastCause = `欠陥 ${r.defects.length} 件の出し直しを求めた後、書き換えた成果物が提出されなかった`;
  return result(s, false, remaining);
}

function accept(ctx, s, last, remaining) {
  s.done = true;
  s.ok = true;
  s.ret = last.ret;
  s.accepted = last;
  s.snapshot = attemptHashes(ctx.run, s);
  if (s.entry.item.onAccept) s.entry.item.onAccept();
  settleEarly(ctx, s);
  return result(s, true, [], remaining.length ? { remaining } : {});
}
function fail(ctx, s, cause) { s.done = true; s.ok = false; s.cause = cause; settleEarly(ctx, s); }

// settle を持つ担当は、閉じた時点で結果を渡す（同じ worker の後の担当がその結果を使う）。
function settleEarly(ctx, s) {
  const e = s.entry;
  if (!e.item.settle || e.result) return;
  e.result = outcome(ctx, s);
  e.settled = true;
  e.item.settle(e.result);
}

// attempt の領域の全てのファイルの指紋。受理した後に書き換わった成果物を受理のまま登録しない。
const attemptHashes = (run, s) => JSON.stringify(expandRefHashes(run.runDir, [relative(run.runDir, s.task.attempt_dir)]));
const unchanged = (run, s) => s.snapshot !== null && s.snapshot === attemptHashes(run, s);
const failText = (ctx, s, text) => `呼び出し ${ctx.callId} の task ${s.task.task_id} の返り値を成功に数えない: ${text}`;

// 閉じた担当の結果。受理か、担当の失敗（記録する）。
function outcome(ctx, s, cause = null) {
  const base = { spec: s.spec, task: s.task, materials: s.materials ?? [] };
  if (s.ok && cause === null) return { ...base, ok: true, ret: s.ret, last: s.accepted, materials: s.accepted.materials };
  const detail = failText(ctx, s, cause ?? s.cause);
  ctx.run.agentFailed(s.task, detail);
  return { ...base, ok: false, cause: detail };
}

// 閉じた呼び出しの worker の担当を、受理・担当の失敗・手放した担当に分ける。
// 取ったまま出さなかった担当・取らなかった担当・照合に落ちたままの担当は 担当の失敗。mode 'fit' では、取ったまま出さなかった担当は
// 次の呼び出しに手放す（その呼び出しで 1 件以上出した worker か、2 件以上の束を 1 件も出さなかった worker）。後者は次の束の上限を半分にする。
function finalizeWorker(ctx, w) {
  const { run } = ctx;
  // 呼び出しの間に閉じた（受理か失敗が決まった）担当。依存つきの担当を出さなかった理由を事実どおりに書くため、閉じる前に控える
  const closedInCall = w.entries.map((e) => Boolean(e.state?.done));
  const unsent = held(w).filter((s) => s.submits === 0);
  const releaseHeld = w.mode === 'fit' && unsent.length > 0 && (w.submits > 0 || unsent.length >= 2);
  let nextCap = w.mode === 'fit' ? (w.submits > 0 ? UNIT_MAX_BYTES : w.cap) : null;
  if (w.mode === 'fit' && w.submits === 0 && unsent.length >= 2) {
    nextCap = Math.floor(unionBytes(unsent.map((s) => filesOfEntry(s.entry))) / 2);
    run.log(ctx.run.stage).actions.push(`呼び出し ${ctx.callId} の ${w.row.role} は束 ${unsent.length} 件を取ったまま 1 件も出さなかったので、試行に数えずに手放し、次の束の上限を ${nextCap} バイトにした。`);
  }
  for (const e of w.entries) {
    if (e.result) {
      // 閉じた時点で渡した担当も、受理した後の書き換えは受理のまま登録しない（担当の失敗）。渡した受理は revoke で取り消す
      if (e.settled && e.state?.ok && !unchanged(run, e.state)) {
        e.state.ok = false;
        e.result = outcome(ctx, e.state, '受理した後に attempt の領域のファイルが書き換わった');
        if (e.item.revoke) e.item.revoke(e.result);
      }
      continue;
    }
    const s = e.state;
    if (!s) {
      if (w.mode === 'fit') { e.result = { spec: null, task: null, ok: false, released: true, materials: [] }; continue; }
      if (run.halted()) { e.result = { spec: null, task: null, ok: false, notIssued: true, cause: '中断の理由があるので担当を出さなかった', materials: [] }; continue; }
      const dep = e.item.after;
      const head = `呼び出し ${ctx.callId} の worker ${w.id} の ${roleOfItem(e.item)} の担当は`;
      const why = dep !== undefined && !closedInCall[dep] ? `${head}、依存する担当が閉じる前に呼び出しが閉じたので出さなかった`
        : dep !== undefined ? `${head}、依存する担当が閉じた時点で呼び出しの期限を過ぎていたので出さなかった`
          : `${head}、呼び出しが閉じるまでに worker が claim しなかったので出さなかった`;
      run.agentFailedStage(e.item.stage ?? run.stage, why);
      e.result = { spec: null, task: null, ok: false, notIssued: true, dependency: true, cause: why, materials: [] };
      continue;
    }
    if (releaseHeld && !s.done && s.submits === 0) { e.result = { spec: s.spec, task: s.task, ok: false, released: true, materials: [] }; continue; }
    let cause = null;
    if (!s.done && s.last && unchanged(run, s)) { s.done = true; s.ok = true; s.ret = s.last.ret; s.accepted = s.last; }
    if (s.ok && !unchanged(run, s)) cause = '受理した後に attempt の領域のファイルが書き換わった';
    else if (s.ok) cause = null;
    else if (s.done) cause = s.cause;
    else if (!s.claimed) cause = '担当が claim しなかった';
    else if (s.submits === 0) cause = '担当が claim したまま submit しなかった';
    else cause = `最後の提出が受理されないまま閉じた（${s.lastCause}）`;
    if (!s.ok || cause) { s.ok = false; s.cause = cause; }
    e.result = outcome(ctx, s, s.ok ? null : cause);
  }
  // settle を持つ担当のうち、閉じた時点で渡していないもの（受理されないまま閉じた・出さなかった）にも結果を渡す
  for (const e of w.entries) if (e.item.settle && !e.settled) { e.settled = true; e.item.settle(e.result); }
  return { results: w.entries.map((e) => e.result), nextCap };
}

// close の受け箱を読み、Workflow の返り値から起動の記録と tokens だけを記録する。受理は submit で済んでいるので、受け箱が壊れていても受理を変えない。
function recordClose(run, { callId, stage, box, closedBy, rows, tasks }) {
  const entry = { call_id: callId, stage, workers: rows.length, tasks, closed_by: closedBy, agents: null, tokens: null, note: null };
  const note = (text) => { entry.note = text; run.log(stage).unconfirmed.push(`呼び出し ${callId}: ${text}`); };
  if (closedBy === 'deadline') note('期限までに close が届かなかったので、run-daemon が期限で閉じた。起動の記録と tokens は無い');
  else {
    let content = null;
    try { content = JSON.parse(readFileSync(box, 'utf8')); } catch { /* 下で記録する */ }
    if (!conforms(CloseContent, content) || content.call_id !== callId) note('close の受け箱を読めないか形に合わない。起動の記録と tokens は無い');
    else if (content.timed_out === true) { entry.closed_by = 'timed_out'; note('close が timed_out: true で閉じた。起動の記録と tokens は無い'); }
    else {
      let wf = null;
      try { wf = unwrap(JSON.parse(readFileSync(content.workflow_output_path, 'utf8'))); } catch { /* 下で記録する */ }
      if (!conforms(WorkflowReturn, wf)) note('Workflow の返り値のファイルを読めないか {agents, tokens} の形に合わない。起動の記録と tokens は無い');
      else {
        entry.agents = wf.agents.map((a) => ({ role: a.role, label: a.label, model: a.model, effort: a.effort, ok: a.ok }));
        entry.tokens = wf.tokens;
        if (wf.tokens === null) entry.note = 'Workflow の返り値の tokens が null（budget.spent() を読めない経路）';
        const missing = wf.agents.filter((a) => !a.ok);
        run.log(stage).actions.push(`呼び出し ${callId} を閉じた（起動 ${wf.agents.length} 体、返らなかった ${missing.length} 体、tokens ${wf.tokens ?? '取得できず'}）。`);
      }
    }
  }
  run.calls.push(entry);
}
