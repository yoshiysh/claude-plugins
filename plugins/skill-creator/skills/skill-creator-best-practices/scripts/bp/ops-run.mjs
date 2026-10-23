import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  CODES, FILE_ACTIONS, FINGERPRINT_AT, FUNCTION, GATE_DECISIONS, GROUND_REF_KEY, INSPECTING_FUNCTIONS, LIMIT_HITS, STOP_CAUSES, LIMIT_KEYS, NEXT_ARGS_KEYS, OPS, PARTED_STAGES, PREMISE_KINDS,
  RECORDS, REJECT_SCOPE, RESULT_KEYS, REWRITING_FUNCTIONS, STAGE, STAGES, STATES_DIR, STOP_KINDS, STOP_KINDS_BY_FUNCTION, WORK_DIR, emptyRunBase,
} from './constants.mjs';
import { resolveCallsites } from './callsites.mjs';
import { designNote, isTreatedGround, lastGate, progress, writtenFiles } from './ops-author.mjs';
import { inspectOutcome } from './ops-inspect.mjs';
import { checkAttempt, checkFunction, checkStage, checkWritableItem, isPosInt, needPosInt } from './checks.mjs';
import { reject } from './errors.mjs';
import { diffFingerprints, homelessReason, isHomeless, isInList, pathKey, targetFingerprint } from './fingerprint.mjs';
import { canonical, groundId, itemId, premiseId, runId, sha256Hex, stateId } from './ids.mjs';
import { append, linkCreate, readAll, readOrNull, withLock } from './journal.mjs';
import { enumerateAssets, retakeRecords } from './ledger.mjs';
import { affectedFindings, rejected } from './ops-ledger.mjs';
import { freshRecords, strip } from './records.mjs';
import { locateState, mutate, readState, stateRootOf } from './store.mjs';
import { summarize } from './summary.mjs';
import {
  buildView, currentRun, isCompleted, itemStatus, lastFingerprint, pendingItems, runBase, stageEntry, stoppedStage,
} from './view.mjs';
import { assertAllowedRoot, createStateDir, listStateIds, realpathLoose, stateDir, within } from './workspace.mjs';

export function nextArgs(view) {
  return { [NEXT_ARGS_KEYS.function]: view.state.function, [NEXT_ARGS_KEYS.state]: view.state.id };
}

// 4 機能に共通の返り値の欄（SP-BPRUN-032）と完了以外の止まった段（SP-BPAUTHORING-034・SP-BPINSPECTION-024）。機能ごとの欄は呼び出し側が足す。
export function stopOutcome(view) {
  const run = currentRun(view);
  const stop = view.stops.get(run.id);
  if (!stop) reject(CODES.input, `現在の run に停止の記録が無い: ${run.id}`);
  const out = { [RESULT_KEYS.stopKind]: stop.kind, [RESULT_KEYS.state]: view.state.id, [RESULT_KEYS.run]: run.id, [RESULT_KEYS.launches]: stop.launches };
  if (stop.kind !== STOP_KINDS.complete) {
    out[RESULT_KEYS.reason] = stop.reason;
    out[RESULT_KEYS.nextArgs] = nextArgs(view);
    out[RESULT_KEYS.stoppedStage] = stop.stage ? STAGES[stop.stage.stage] : null;
  }
  return { stop, out };
}

function checkLimits(limits) {
  if (limits === null || typeof limits !== 'object' || Array.isArray(limits)) reject(CODES.input, 'limits はオブジェクトでなければならない');
  for (const key of Object.values(LIMIT_KEYS)) {
    needPosInt(limits[key], `limits.${key} は`);
  }
}

async function lstatOrNull(p) {
  try { return await fs.lstat(p); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function statOrNull(p) {
  try { return await fs.stat(p); } catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null; throw error; }
}

async function checkTarget(fn, root) {
  if (fn === FUNCTION.create) {
    const st = await lstatOrNull(root);
    if (st) reject(CODES.input, `対象スキルのディレクトリが既にある: ${root}${st.isSymbolicLink() ? '（symlink）' : ''}。既存のスキルを直すなら update を使う`);
    return;
  }
  const dir = await statOrNull(root);
  if (!dir || !dir.isDirectory()) reject(CODES.input, `対象スキルのディレクトリが無い: ${root}`);
  if (fn === FUNCTION.review || fn === FUNCTION.audit) {
    const skill = await statOrNull(path.join(root, 'SKILL.md'));
    if (!skill || !skill.isFile()) reject(CODES.input, `対象スキルのディレクトリに SKILL.md が無い: ${root}`);
  }
}

function checkKeyRefs(view, key) {
  if (key === null || typeof key !== 'object') return;
  if (Array.isArray(key)) { key.forEach((k) => checkKeyRefs(view, k)); return; }
  const tables = { asset: view.assets, assignment: view.assignments, finding: view.findings, item: view.items };
  for (const [field, value] of Object.entries(key)) {
    if (tables[field] && !tables[field].has(value)) reject(CODES.unknownId, `項目の鍵が状態に無い ${field} を指す: ${value}`);
    if (field === 'ground' && !view.grounds.some((g) => g.id === value)) reject(CODES.unknownId, `項目の鍵が状態に無い修正の根拠を指す: ${value}`);
    if (typeof value === 'object') checkKeyRefs(view, value);
  }
}

function checkKey(key) {
  if (typeof key !== 'string' || !/^[A-Za-z0-9._-]+$/.test(key)) reject(CODES.input, `key は英数字と . _ - だけの文字列でなければならない: ${JSON.stringify(key)}`);
}

function keyMarker(root, key) {
  return path.join(root, STATES_DIR, `.key-${sha256Hex(key)}`);
}

async function readMarker(marker) {
  return (await readOrNull(marker))?.trim() ?? null;
}

function startOutput(view, dir, run, extra = {}) {
  return { state: view.state.id, run, workDir: path.join(dir, WORK_DIR), groundIds: view.grounds.map((g) => g.id), ...extra, progress: progress(view), summary: summarize(view) };
}

// 運搬役の失敗で開始を送り直しても状態と run が増えないよう、呼び出し側の key で同じ開始を見分ける（SP-BPRUN-031）。
async function existingStart(root, id, req) {
  const dir = id ? stateDir(root, id) : null;
  const view = dir ? buildView(await readAll(dir)) : null;
  if (!view?.state) reject(CODES.conflict, `key の記録が指す状態が無い: ${req.key}（${keyMarker(root, req.key)} が ${JSON.stringify(id)} を指す。記録を消してから起動し直す）`);
  if (view.state.key !== req.key || view.state.function !== req.function || view.paths[0].root !== realpathLoose(req.target.root)) {
    reject(CODES.conflict, `同じ key の開始が別の機能か対象で既にある: ${req.key}`);
  }
  return { ...startOutput(view, dir, view.runs[0].id), same: true };
}

// 参照の形の修正の根拠を、指す状態の返り値の指摘の一覧（返り値を作るのと同じ関数）に展開する。入口が指摘を書き写すと同じバイト列を保てない（SP-BPENTRY-010・SP-BPFINDINGS-031）。
async function expandGrounds(ctx, grounds, root) {
  const out = [];
  for (const g of grounds) {
    if (g === null || typeof g !== 'object' || Array.isArray(g) || !Object.hasOwn(g, GROUND_REF_KEY)) { out.push({ ground: g }); continue; }
    const id = g[GROUND_REF_KEY];
    if (typeof id !== 'string' || Object.keys(g).length !== 1) reject(CODES.input, `参照の形の修正の根拠は {"${GROUND_REF_KEY}": <状態 ID>} だけを持つ: ${JSON.stringify(g)}`);
    const { view } = await readState(ctx, id);
    if (!INSPECTING_FUNCTIONS.has(view.state.function)) reject(CODES.input, `参照の形の修正の根拠が review・audit でない状態を指す: ${id}（${view.state.function}）`);
    if (!isCompleted(view)) reject(CODES.input, `参照の形の修正の根拠が完了で止まっていない状態を指す: ${id}`);
    if (view.paths[0].root !== realpathLoose(root)) reject(CODES.input, `参照の形の修正の根拠が別の対象スキルの状態を指す: ${id}（${view.paths[0].root}）`);
    const result = await inspectOutcome(ctx, { state: id });
    for (const f of result[RESULT_KEYS.findings]) out.push({ ground: f, from: id });
  }
  const treated = out.filter((g) => isTreatedGround(g.ground)).length;
  // 参照の無い並びは script が agent の起動の前に数えて止めるので、ここで数えるのは参照を含む並びだけ（参照が 0 件の指摘に展開されても数える）。
  const refs = grounds.some((g) => g !== null && typeof g === 'object' && !Array.isArray(g) && Object.hasOwn(g, GROUND_REF_KEY));
  if (treated === 0 && refs) {
    reject(CODES.input, `修正の根拠として扱う根拠が 0 件（参照を展開して受け取った ${out.length} 件、扱わなかった ${out.length} 件）。open の指摘か利用者の指示を 1 件以上渡す（SP-BPAUTHORING-029）`, { treatedGrounds: 0, receivedGrounds: out.length });
  }
  return out;
}

async function startNew(ctx, req) {
  checkFunction(req.function);
  checkKey(req.key);
  checkLimits(req.limits);
  const target = req.target;
  if (!target || typeof target.root !== 'string' || !path.isAbsolute(target.root)) reject(CODES.input, 'target.root は絶対パスでなければならない');
  const files = target.files ?? [];
  if (!Array.isArray(files) || files.some((f) => typeof f !== 'string' || !path.isAbsolute(f))) reject(CODES.input, 'target.files は絶対パスの並びでなければならない');
  if (req.function === FUNCTION.create && typeof req.request !== 'string') reject(CODES.input, 'create の request は文字列でなければならない');
  if (req.function === FUNCTION.update && !Array.isArray(req.grounds)) reject(CODES.input, 'update の grounds は並びでなければならない');
  const root = assertAllowedRoot(stateRootOf(ctx), { targetRoots: [target.root] });
  const marker = keyMarker(root, req.key);
  const known = await readMarker(marker);
  if (known !== null) return existingStart(root, known, req);
  await checkTarget(req.function, target.root);
  const id = stateId(ctx.now ?? new Date(), ctx.random);
  // 外した callsite は開始の時点の SKILL.md の行番号で記録する。後の run が行をずらしても、この状態の返り値の行番号を変えない（SP-BPENTRY-023）。
  const paths = { t: RECORDS.paths, n: 1, root: realpathLoose(target.root), files: files.map(realpathLoose), unresolved: resolveCallsites(target.root).unresolved };
  const grounds = req.function === FUNCTION.update ? (await expandGrounds(ctx, req.grounds, target.root)).map((g, i) => ({ t: RECORDS.ground, id: groundId(i + 1), ...g })) : [];
  const state = { t: RECORDS.state, id, key: req.key, function: req.function, limits: req.limits };
  if (req.function === FUNCTION.create) state.request = req.request;
  const run = runId(1);
  const started = await targetFingerprint(paths);
  if (started.homeless.length) reject(CODES.input, homelessReason(started.homeless));
  const records = [
    state,
    ...grounds,
    { t: RECORDS.run, id: run, key: req.key, base: emptyRunBase() },
    paths,
    { t: RECORDS.fingerprint, run, at: FINGERPRINT_AT.start, n: 1, files: started.digests },
  ];
  const line = { seq: 1, run, op: OPS.start, records };
  const dir = await createStateDir(root, id, line, { writeFile: ctx.writeFile });
  if (!(await linkCreate(marker, id))) {
    await fs.rm(dir, { recursive: true, force: true });
    return existingStart(root, await readMarker(marker), req);
  }
  return startOutput(buildView([line]), dir, run);
}

function resumeOutput(view, dir, runRecord) {
  const stopped = stoppedStage(view);
  return startOutput(view, dir, runRecord.id, {
    changed: runRecord.changed,
    baseline: runRecord.baseline,
    retake: runRecord.retake,
    stoppedStage: stopped,
    pending: pendingItems(view, stopped),
  });
}

function answerRecord(view, run, answer) {
  if (answer === undefined) return [];
  if (typeof answer !== 'string' || answer === '') reject(CODES.input, 'answer は空でない文字列でなければならない');
  const hash = sha256Hex(answer);
  const known = view.premises.find((p) => p.run === run && p.kind === 'answer' && p.hash === hash);
  return [{ t: RECORDS.premise, id: known?.id ?? premiseId(view.premises.length + 1), run, kind: 'answer', hash, text: answer }];
}

async function resume(ctx, req) {
  checkKey(req.key);
  const dir = await locateState(ctx, req.state);
  return withLock(dir, async () => {
    const lines = await readAll(dir);
    const view = buildView(lines);
    const last = currentRun(view);
    if (last.key === req.key) {
      if (freshRecords(view, answerRecord(view, last.id, req.answer)).length) reject(CODES.conflict, `同じ key の再開が別の回答で届いた: ${req.key}`);
      return { ...resumeOutput(view, dir, last), same: true };
    }
    if (isCompleted(view)) reject(CODES.input, `完了した状態は再開できない: ${req.state}`);
    const run = runId(view.runs.length + 1);
    const paths = view.paths.at(-1);
    const baseline = lastFingerprint(view);
    const fresh = await targetFingerprint(paths);
    if (fresh.homeless.length) reject(CODES.input, homelessReason(fresh.homeless));
    const now = fresh.digests;
    let retake = null;
    const ledgerRecords = [];
    if (view.ledger) {
      const r = retakeRecords(view, await enumerateAssets(paths));
      ledgerRecords.push(...r.records);
      retake = { counts: r.counts, gone: r.gone, retake: r.records.length ? r.retake : null, affected: affectedFindings(view, r.gone) };
    }
    const runRecord = {
      t: RECORDS.run, id: run, key: req.key, base: { iterations: view.iterations, repeats: Object.fromEntries(view.repeats) },
      changed: diffFingerprints(baseline?.files, now), baseline: baseline ? { run: baseline.run, at: baseline.at } : null, retake,
    };
    const records = [runRecord, ...answerRecord(view, run, req.answer), { t: RECORDS.fingerprint, run, at: FINGERPRINT_AT.start, n: 1, files: now }, ...ledgerRecords];
    const line = { seq: view.lastSeq + 1, run, op: OPS.start, records: freshRecords(view, records) };
    await append(dir, line);
    return resumeOutput(buildView([...lines, line]), dir, runRecord);
  });
}

export function start(ctx, req) {
  return req.state === undefined ? startNew(ctx, req) : resume(ctx, req);
}

export function premise(ctx, req) {
  return mutate(ctx, req, OPS.premise, (view) => {
    if (!PREMISE_KINDS.includes(req.kind)) reject(CODES.input, `前提の種類が ${PREMISE_KINDS.join('・')} のどれでもない: ${JSON.stringify(req.kind)}`);
    if (typeof req.text !== 'string') reject(CODES.input, '前提の text は文字列でなければならない');
    const hash = sha256Hex(req.text);
    const known = view.premises.find((p) => p.run === req.run && p.kind === req.kind && p.hash === hash);
    const id = known?.id ?? premiseId(view.premises.length + 1);
    return { records: [{ t: RECORDS.premise, id, run: req.run, kind: req.kind, hash, text: req.text }], output: { id } };
  });
}

function checkRound(round) {
  if (round != null) needPosInt(round, '回は');
}

export function stageStart(ctx, req) {
  return mutate(ctx, req, OPS.stageStart, (view) => {
    checkStage(req.stage);
    checkRound(req.round);
    if (!Array.isArray(req.keys)) reject(CODES.input, 'keys は並びでなければならない');
    const round = req.round ?? null;
    const part = req.part ?? null;
    if (part !== null && (!PARTED_STAGES.includes(req.stage) || !isPosInt(part))) reject(CODES.input, `part は ${PARTED_STAGES.join('・')} の段だけが持つ 1 以上の整数: ${JSON.stringify(part)}`);
    const items = [];
    const ids = new Set();
    for (const key of req.keys) {
      checkKeyRefs(view, key);
      const id = itemId(req.stage, round, key);
      const known = view.items.get(id);
      if (known && canonical(known.key) !== canonical(key)) reject(CODES.internal, `項目の ID が衝突した: ${id}`);
      if (ids.has(id)) continue;
      ids.add(id);
      items.push({ id, key });
    }
    if (req.stage === STAGE.vanish && (round === null || req.keys.some((k) => k?.gone !== round))) {
      reject(CODES.input, `消えた資産の照合の段の回は、照合する取り直しの番号（項目の鍵の gone）でなければならない: ${JSON.stringify(round)}`);
    }
    const record = { t: RECORDS.stage, stage: req.stage, round, items, ...(part === null ? {} : { part }) };
    return {
      records: [record],
      output: (after) => ({
        items: items.map((i) => i.id),
        status: items.map((i) => itemStatus(after.items.get(i.id))),
      }),
    };
  });
}

function itemOf(view, id) {
  const item = view.items.get(id);
  if (!item) reject(CODES.unknownId, `状態に無い項目の ID: ${JSON.stringify(id)}`);
  return item;
}

export function limitState(view, key, count, base) {
  const limit = view.state.limits[key];
  const since = count - base;
  return { limit, count, sinceRunStart: since, hit: since >= limit };
}

// SP-BPAUTHORING-013: 設計の説明は対象スキルの根の配下の既存のファイルでなければならない。外を指すと、返り値が対象スキルの外を逐語で写す。
async function designNoteProblem(view, result) {
  const note = result?.designNote;
  if (note === null || typeof note !== 'object' || typeof note.path !== 'string' || note.path === '') return '書く段の結果に設計の説明のパス designNote.path が無い';
  if (path.isAbsolute(note.path)) return `設計の説明のパスは根からの相対パスでなければならない: ${note.path}`;
  const root = realpathLoose(view.paths.at(-1).root);
  const file = realpathLoose(path.join(root, note.path));
  if (!within(file, root)) return `設計の説明のパスが対象スキルの根の外を指す: ${note.path}`;
  const st = await statOrNull(file);
  if (!st?.isFile()) return `設計の説明のファイルが無い: ${note.path}`;
  return null;
}

export function itemResult(ctx, req) {
  return mutate(ctx, req, OPS.itemResult, async (view) => {
    const item = itemOf(view, req.item);
    checkWritableItem(item);
    if (req.result === undefined) reject(CODES.input, 'result が無い');
    if (item.stage === STAGE.write && REWRITING_FUNCTIONS.has(view.state.function) && item.result === undefined) {
      const bad = await designNoteProblem(view, req.result);
      if (bad) return rejected(`${REJECT_SCOPE.item}${req.item}`, item.fails.length + 1, null, req.result, bad);
    }
    const record = { t: RECORDS.result, item: req.item, result: req.result };
    if (req.iteration !== undefined) {
      needPosInt(req.iteration, 'iteration は');
      if (item.result === undefined && req.iteration !== view.iterations + 1) reject(CODES.conflict, `反復の番号が今の回数 + 1 ではない: ${req.iteration}（今の回数 ${view.iterations}）`);
      record.iteration = req.iteration;
    }
    return {
      records: [record],
      output: (after) => ({ item: req.item, iterations: limitState(after, LIMIT_KEYS.iterations, after.iterations, runBase(after).iterations) }),
    };
  });
}

export function itemFail(ctx, req) {
  return mutate(ctx, req, OPS.itemFail, (view) => {
    const item = itemOf(view, req.item);
    // 結果を書く要求の応答を失った後は、CLI が結果を書いたかを script が知らないので、結果のある項目を「済み」として返させる。
    if (item.result !== undefined && req.ifNoResult === true) {
      return { records: [], output: { item: req.item, attempts: item.fails.length, limit: view.state.limits[LIMIT_KEYS.attempts], aborted: false, resulted: true } };
    }
    if (item.result !== undefined) reject(CODES.conflict, `結果のある項目に試行の失敗を書けない: ${req.item}`);
    if (item.discarded) reject(CODES.conflict, `破棄した項目に試行の失敗を書けない: ${req.item}`);
    checkAttempt(item, req.attempt, '試行の失敗');
    const current = item.fails.length;
    const reason = String(req.reason ?? '');
    const records = [{ t: RECORDS.fail, item: req.item, attempt: req.attempt, reason }];
    const limit = view.state.limits[LIMIT_KEYS.attempts];
    if (req.attempt === current + 1 && req.attempt >= limit) records.push({ t: RECORDS.abort, item: req.item, reason: `試行の上限 ${limit} 回に達した: ${reason}` });
    return {
      records,
      output: (after) => {
        const it = after.items.get(req.item);
        return { item: req.item, attempts: it.fails.length, limit, aborted: Boolean(it.aborted) };
      },
    };
  });
}

export function checkRepeatNumber(view, stage, n) {
  needPosInt(n, 'n は');
  const current = view.repeats.get(stage) ?? 0;
  if (n > current + 1) reject(CODES.conflict, `繰り返しの番号が今の回数 + 1 を超える: ${n}（今の回数 ${current}）`);
}

export function stageRepeat(ctx, req) {
  return mutate(ctx, req, OPS.stageRepeat, (view) => {
    checkStage(req.stage);
    if (!Object.values(LIMIT_KEYS).includes(req.limitKey)) reject(CODES.input, `limitKey が ${Object.values(LIMIT_KEYS).join('・')} のどれでもない: ${JSON.stringify(req.limitKey)}`);
    checkRepeatNumber(view, req.stage, req.n);
    return {
      records: [{ t: RECORDS.repeat, stage: req.stage, n: req.n }],
      output: (after) => ({ stage: req.stage, ...limitState(after, req.limitKey, after.repeats.get(req.stage) ?? 0, runBase(after).repeats[req.stage] ?? 0) }),
    };
  });
}

export function stageFinish(ctx, req) {
  return mutate(ctx, req, OPS.stageFinish, (view) => {
    checkStage(req.stage);
    checkRound(req.round);
    if (!stageEntry(view, req.stage, req.round ?? null)) reject(CODES.unknownId, `始めていない段: ${req.stage}${req.round != null ? `.${req.round}` : ''}`);
    return { records: [{ t: RECORDS.stageEnd, stage: req.stage, round: req.round ?? null }], output: {} };
  });
}

export function discard(ctx, req) {
  return mutate(ctx, req, OPS.discard, (view) => {
    if (!Array.isArray(req.items)) reject(CODES.input, 'items は並びでなければならない');
    const records = req.items.map((id) => {
      const item = itemOf(view, id);
      if (item.result !== undefined) reject(CODES.conflict, `結果のある項目は破棄できない: ${id}`);
      return { t: RECORDS.discard, item: id, run: req.run };
    });
    return { records, output: { discarded: req.items } };
  });
}

export function files(ctx, req) {
  return mutate(ctx, req, OPS.files, (view) => {
    if (!Array.isArray(req.entries)) reject(CODES.input, 'entries は並びでなければならない');
    if (req.entries.some((e) => e?.action !== undefined) && req.entries.some((e) => e?.verified !== undefined)) {
      reject(CODES.input, '書いたファイルの記録と検証の記録は別の要求で送る（同じ要求の中の順に意味を持たせない）');
    }
    const paths = view.paths.at(-1);
    const records = [];
    const outside = [];
    const recorded = [];
    for (const entry of req.entries) {
      if (!entry || typeof entry.path !== 'string' || !path.isAbsolute(entry.path)) reject(CODES.input, 'entries の path は絶対パスでなければならない');
      if (!isInList(paths, entry.path)) { outside.push(entry.path); continue; }
      if (isHomeless(paths.root, entry.path)) reject(CODES.input, homelessReason([entry.path]));
      const key = pathKey(paths.root, entry.path);
      needPosInt(entry.iteration, 'entries の iteration は');
      if (entry.action !== undefined) {
        if (!Object.values(FILE_ACTIONS).includes(entry.action)) reject(CODES.input, `action は ${Object.values(FILE_ACTIONS).join('・')} のどれか: ${JSON.stringify(entry.action)}`);
        records.push({ t: RECORDS.file, run: req.run, path: key, iteration: entry.iteration, action: entry.action });
      } else if (typeof entry.verified === 'boolean') {
        if (!view.files.some((f) => f.path === key) && !records.some((r) => r.t === RECORDS.file && r.path === key)) reject(CODES.unknownId, `書いたファイルの一覧に無いパスの検証の記録: ${key}`);
        records.push({ t: RECORDS.verified, run: req.run, path: key, iteration: entry.iteration, verified: entry.verified });
      } else {
        reject(CODES.input, 'entries の各要素は action か verified を持たなければならない');
      }
      recorded.push(key);
    }
    return { records, output: { recorded, outside } };
  });
}

// 通った後に書き直したか落ちたファイルを通ったと数えないよう、最後の書き込みより後の最後の検証の記録だけで決める。
export function unverifiedFiles(view) {
  const latest = new Map();
  for (const f of view.files) latest.set(f.path, f);
  return [...latest.values()].filter((f) => {
    const last = view.verified.filter((v) => v.path === f.path && v.seq > f.seq).at(-1);
    return !last?.verified;
  }).map((f) => ({ path: f.path, action: f.action, run: f.run, iteration: f.iteration }));
}

export function stop(ctx, req) {
  return mutate(ctx, req, OPS.stop, async (view) => {
    const fn = view.state.function;
    const asked = sha256Hex(canonical({ kind: req.kind, reason: req.reason ?? '', limitHit: req.limitHit ?? null, pending: req.pending ?? null, launches: req.launches, outside: req.outside ?? [], onTargetChanged: req.onTargetChanged ?? null, cause: req.cause }));
    const output = (after) => {
      const stopped = after.stops.get(req.run);
      return { stop: stopped, ...(stopped.kind === STOP_KINDS.complete ? {} : { nextArgs: nextArgs(after) }) };
    };
    const written = view.stops.get(req.run);
    // 停止の後に対象が変わってから届いた送り直しも同じ停止として受けるため、指紋を計算し直さず、受け取った要求だけを照らす。
    if (written) {
      if (written.asked !== asked) reject(CODES.staleRun, `停止を書いた後の run の違う停止: ${req.run}`);
      return { records: [strip(written)], output };
    }
    if (!STOP_KINDS_BY_FUNCTION[fn].includes(req.kind)) reject(CODES.input, `${fn} が使わない停止の種類: ${JSON.stringify(req.kind)}`);
    if (req.kind !== STOP_KINDS.complete && (typeof req.reason !== 'string' || req.reason === '')) reject(CODES.input, '完了以外の停止には理由が要る');
    if ((req.kind === STOP_KINDS.iterationLimit) !== (req.limitHit !== undefined)) reject(CODES.input, 'limitHit は反復の上限の停止にだけ、必ず付ける');
    if (req.limitHit !== undefined && !Object.values(LIMIT_HITS).includes(req.limitHit)) reject(CODES.input, `limitHit が ${Object.values(LIMIT_HITS).join('・')} のどれでもない: ${JSON.stringify(req.limitHit)}`);
    if (req.cause !== undefined && (req.kind !== STOP_KINDS.blocked || !Object.values(STOP_CAUSES).includes(req.cause))) reject(CODES.input, `cause は BLOCKED にだけ ${Object.values(STOP_CAUSES).join('・')} を付ける: ${JSON.stringify(req.cause)}`);
    if (!Number.isInteger(req.launches) || req.launches < 0) reject(CODES.input, `launches は 0 以上の整数でなければならない: ${JSON.stringify(req.launches)}`);
    if (req.onTargetChanged !== undefined && (req.onTargetChanged !== STOP_KINDS.blocked || REWRITING_FUNCTIONS.has(fn))) reject(CODES.input, 'onTargetChanged は review・audit の blocked だけ');
    const rewriting = REWRITING_FUNCTIONS.has(fn);
    const passed = rewriting ? lastGate(view) : null;
    if (rewriting && req.kind === STOP_KINDS.complete && passed?.result.result.decision !== GATE_DECISIONS.pass) {
      reject(CODES.conflict, '直前の反復の合否が合格でないので完了で止まれない（SP-BPAUTHORING-026）');
    }
    const outsidePaths = req.outside ?? [];
    if (!Array.isArray(outsidePaths)) reject(CODES.input, 'outside は並びでなければならない');
    const live = stoppedStage(view, { includeCurrentRun: true });
    const derived = pendingItems(view, live);
    // pending を省いた停止は状態から導いた並びを書く（未着手の正本を CLI の 1 箇所にする。SP-BPRUN-020）。
    const pending = req.pending === undefined ? derived : req.pending;
    if (!Array.isArray(pending) || canonical(pending) !== canonical(derived)) {
      reject(CODES.conflict, `pending が状態から導いた未着手の項目の並び（列挙の順）と一致しない（状態: ${derived.join(',') || 'なし'}）`, { derived });
    }
    const { digests: now, homeless: excluded } = await targetFingerprint(view.paths.at(-1));
    const startFp = view.fingerprints.find((f) => f.run === req.run && f.at === FINGERPRINT_AT.start);
    let kind = req.kind;
    let reason = req.reason ?? '';
    let limitHit = req.limitHit;
    let requested;
    if (req.onTargetChanged) {
      const changed = [...new Set([...diffFingerprints(startFp?.files, now), ...excluded])].sort();
      if (changed.length > 0) {
        requested = { kind, reason };
        kind = STOP_KINDS.blocked;
        reason = `run の中で対象スキルが変わった: ${changed.join(', ')}`;
        limitHit = undefined;
      }
    }
    // 残した件数の正本は CLI が導いた未着手の並びなので、script の理由に CLI が足す（SP-BPCONFORMANCE-023）。
    if (limitHit === LIMIT_HITS.launch) reason = `${reason}。残した項目の件数 ${pending.length}`;
    const record = {
      t: RECORDS.stop, run: req.run, kind, reason, limitHit, requested, cause: kind === req.kind ? req.cause : undefined,
      stage: live.stage == null ? null : { stage: live.stage, round: live.round },
      pending, launches: req.launches,
      unverified: rewriting && req.kind !== STOP_KINDS.complete ? unverifiedFiles(view) : [],
      outside: outsidePaths,
      excluded,
      asked,
      // 完了の返り値の設計の説明は停止の時点の本文で返す。後の run が対象スキルを書き換えても、同じ状態から同じ返り値を作る（SP-BPRUN-032）。
      designNote: rewriting && kind === STOP_KINDS.complete ? await designNote(view) : undefined,
    };
    // 完了だけが書いたファイルに検証を通ったことを追記する（SP-BPAUTHORING-026）。
    const verified = rewriting && kind === STOP_KINDS.complete
      ? unverifiedFiles(view).map((f) => ({ t: RECORDS.verified, run: req.run, path: f.path, iteration: passed.result.result.number, verified: true }))
      : [];
    return {
      records: [...verified, record, { t: RECORDS.fingerprint, run: req.run, at: FINGERPRINT_AT.stop, n: 1, files: now }],
      output,
    };
  });
}

export async function list(ctx, req) {
  checkFunction(req.function);
  if (!req.target || typeof req.target.root !== 'string') reject(CODES.input, 'target.root が要る');
  const root = stateRootOf(ctx);
  const wanted = realpathLoose(req.target.root);
  const states = [];
  const unreadable = [];
  for (const id of await listStateIds(root)) {
    let view;
    try {
      view = buildView(await readAll(stateDir(root, id)));
    } catch (error) {
      unreadable.push({ state: id, reason: String(error.message ?? error) });
      continue;
    }
    if (!view.state || view.state.function !== req.function || view.paths[0]?.root !== wanted || isCompleted(view)) continue;
    const stopped = stoppedStage(view, { includeCurrentRun: true });
    states.push({ state: id, nextArgs: nextArgs(view), stoppedStage: stopped, pending: pendingItems(view, stopped) });
  }
  return { states, unreadable };
}

export async function summary(ctx, req) {
  const { view } = await readState(ctx, req.state);
  return { summary: summarize(view) };
}

// 停止と同じ規則で段を導くのは、停止の記録を書けなかった run の理由の段を、停止の記録が書かれたときの段と食い違わせないため（SP-BPRUN-018・SP-BPRUN-027）。
export async function stopDraft(ctx, req) {
  const { view } = await readState(ctx, req.state);
  const live = stoppedStage(view, { includeCurrentRun: true });
  return { stage: live.stage == null ? null : STAGES[live.stage], writtenFiles: writtenFiles(view) };
}
