import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  CODES, FUNCTIONS, LIMIT_HITS, LIMIT_KEYS, NEXT_ARGS_KEYS, PREMISE_KINDS, REWRITING_FUNCTIONS,
  STAGES, STOP_KINDS, STOP_KINDS_BY_FUNCTION, WORK_DIR,
} from './constants.mjs';
import { reject } from './errors.mjs';
import { diffFingerprints, isInList, pathKey, targetFingerprint } from './fingerprint.mjs';
import { canonical, groundId, itemId, premiseId, runId, sha256Hex, stateId } from './ids.mjs';
import { append, readAll, withLock } from './journal.mjs';
import { enumerateAssets, retakeRecords } from './ledger.mjs';
import { freshRecords } from './records.mjs';
import { locateState, mutate, readState, stateRootOf } from './store.mjs';
import { summarize } from './summary.mjs';
import {
  buildView, currentRun, isCompleted, lastFingerprint, pendingItems, runBase, stageEntry, stoppedStage,
} from './view.mjs';
import { assertAllowedRoot, createStateDir, listStateIds, realpathLoose, stateDir } from './workspace.mjs';

const isPosInt = (n) => Number.isInteger(n) && n >= 1;

export function nextArgs(view) {
  return { [NEXT_ARGS_KEYS.function]: view.state.function, [NEXT_ARGS_KEYS.state]: view.state.id };
}

function checkLimits(limits) {
  if (limits === null || typeof limits !== 'object' || Array.isArray(limits)) reject(CODES.input, 'limits はオブジェクトでなければならない');
  for (const key of Object.values(LIMIT_KEYS)) {
    if (!isPosInt(limits[key])) reject(CODES.input, `limits.${key} は 1 以上の整数でなければならない: ${JSON.stringify(limits[key])}`);
  }
}

async function lstatOrNull(p) {
  try { return await fs.lstat(p); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function statOrNull(p) {
  try { return await fs.stat(p); } catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null; throw error; }
}

// 開始の操作が確かめる入力（bp-authoring SP-BPAUTHORING-029 の「開始の操作」の行、bp-inspection SP-BPINSPECTION-021・026）。
async function checkTarget(fn, root) {
  if (fn === 'create') {
    const st = await lstatOrNull(root);
    if (st) reject(CODES.input, `対象スキルのディレクトリが既にある: ${root}${st.isSymbolicLink() ? '（symlink）' : ''}。既存のスキルを直すなら update を使う`);
    return;
  }
  const dir = await statOrNull(root);
  if (!dir || !dir.isDirectory()) reject(CODES.input, `対象スキルのディレクトリが無い: ${root}`);
  if (fn === 'review' || fn === 'audit') {
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

async function startNew(ctx, req) {
  if (!FUNCTIONS.includes(req.function)) reject(CODES.input, `機能が ${FUNCTIONS.join('・')} のどれでもない: ${JSON.stringify(req.function)}`);
  checkLimits(req.limits);
  const target = req.target;
  if (!target || typeof target.root !== 'string' || !path.isAbsolute(target.root)) reject(CODES.input, 'target.root は絶対パスでなければならない');
  const files = target.files ?? [];
  if (!Array.isArray(files) || files.some((f) => typeof f !== 'string' || !path.isAbsolute(f))) reject(CODES.input, 'target.files は絶対パスの並びでなければならない');
  if (req.function === 'create' && typeof req.request !== 'string') reject(CODES.input, 'create の request は文字列でなければならない');
  if (req.function === 'update' && !Array.isArray(req.grounds)) reject(CODES.input, 'update の grounds は並びでなければならない');
  await checkTarget(req.function, target.root);
  const root = assertAllowedRoot(stateRootOf(ctx), { targetRoots: [target.root] });
  const id = stateId(ctx.now ?? new Date(), ctx.random);
  const paths = { t: 'paths', n: 1, root: realpathLoose(target.root), files: files.map(realpathLoose), unresolved: [] };
  const grounds = req.function === 'update' ? req.grounds.map((g, i) => ({ t: 'ground', id: groundId(i + 1), ground: g })) : [];
  const state = { t: 'state', id, function: req.function, limits: req.limits };
  if (req.function === 'create') state.request = req.request;
  const run = runId(1);
  const records = [
    state,
    ...grounds,
    { t: 'run', id: run, base: { iterations: 0, repeats: {} } },
    paths,
    { t: 'fingerprint', run, at: 'start', n: 1, files: await targetFingerprint(paths) },
  ];
  const line = { seq: 1, run, op: 'start', records };
  const dir = await createStateDir(root, id, line, { writeFile: ctx.writeFile });
  const view = buildView([line]);
  return { state: id, run, workDir: path.join(dir, WORK_DIR), groundIds: grounds.map((g) => g.id), summary: summarize(view) };
}

async function resume(ctx, req) {
  const dir = await locateState(ctx, req.state);
  return withLock(dir, async () => {
    const lines = await readAll(dir);
    const view = buildView(lines);
    if (isCompleted(view)) reject(CODES.input, `完了した状態は再開できない: ${req.state}`);
    const run = runId(view.runs.length + 1);
    const paths = view.paths.at(-1);
    const baseline = lastFingerprint(view);
    const now = await targetFingerprint(paths);
    const records = [
      { t: 'run', id: run, base: { iterations: view.iterations, repeats: Object.fromEntries(view.repeats) } },
      { t: 'fingerprint', run, at: 'start', n: 1, files: now },
    ];
    let retake = null;
    if (view.ledger) {
      const r = retakeRecords(view, await enumerateAssets(paths));
      records.push(...r.records);
      retake = { counts: r.counts, gone: r.gone, retake: r.retake };
    }
    const line = { seq: view.lastSeq + 1, run, op: 'start', records: freshRecords(view, records) };
    await append(dir, line);
    const after = buildView([...lines, line]);
    const stopped = stoppedStage(after);
    return {
      state: req.state,
      run,
      workDir: path.join(dir, WORK_DIR),
      groundIds: after.grounds.map((g) => g.id),
      changed: diffFingerprints(baseline?.files, now),
      baseline: baseline ? { run: baseline.run, at: baseline.at } : null,
      retake,
      stoppedStage: stopped,
      pending: pendingItems(after, stopped),
      summary: summarize(after),
    };
  });
}

export function start(ctx, req) {
  return req.state === undefined ? startNew(ctx, req) : resume(ctx, req);
}

export function premise(ctx, req) {
  return mutate(ctx, req, 'premise', (view) => {
    if (!PREMISE_KINDS.includes(req.kind)) reject(CODES.input, `前提の種類が ${PREMISE_KINDS.join('・')} のどれでもない: ${JSON.stringify(req.kind)}`);
    if (typeof req.text !== 'string') reject(CODES.input, '前提の text は文字列でなければならない');
    const hash = sha256Hex(req.text);
    const known = view.premises.find((p) => p.run === req.run && p.kind === req.kind && p.hash === hash);
    const id = known?.id ?? premiseId(view.premises.length + 1);
    return { records: [{ t: 'premise', id, run: req.run, kind: req.kind, hash, text: req.text }], output: { id } };
  });
}

function checkStage(stage) {
  if (!Object.hasOwn(STAGES, stage)) reject(CODES.unknownId, `段の名前が無い: ${JSON.stringify(stage)}`);
}

function checkRound(round) {
  if (round != null && !isPosInt(round)) reject(CODES.input, `回は 1 以上の整数でなければならない: ${JSON.stringify(round)}`);
}

export function stageStart(ctx, req) {
  return mutate(ctx, req, 'stage-start', (view) => {
    checkStage(req.stage);
    checkRound(req.round);
    if (!Array.isArray(req.keys)) reject(CODES.input, 'keys は並びでなければならない');
    const round = req.round ?? null;
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
    return { records: [{ t: 'stage', stage: req.stage, round, items }], output: { items: items.map((i) => i.id) } };
  });
}

function itemOf(view, id) {
  const item = view.items.get(id);
  if (!item) reject(CODES.unknownId, `状態に無い項目の ID: ${JSON.stringify(id)}`);
  return item;
}

function limitState(view, key, count, base) {
  const limit = view.state.limits[key];
  const since = count - base;
  return { limit, count, sinceRunStart: since, hit: since >= limit };
}

export function itemResult(ctx, req) {
  return mutate(ctx, req, 'item-result', (view) => {
    const item = itemOf(view, req.item);
    if (item.aborted || item.discarded) reject(CODES.conflict, `打ち切りか破棄の記録がある項目に結果を書けない: ${req.item}`);
    if (req.result === undefined) reject(CODES.input, 'result が無い');
    const record = { t: 'result', item: req.item, result: req.result };
    if (req.iteration !== undefined) {
      if (!isPosInt(req.iteration)) reject(CODES.input, `iteration は 1 以上の整数でなければならない: ${JSON.stringify(req.iteration)}`);
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
  return mutate(ctx, req, 'item-fail', (view) => {
    const item = itemOf(view, req.item);
    if (item.result !== undefined) reject(CODES.conflict, `結果のある項目に試行の失敗を書けない: ${req.item}`);
    if (!isPosInt(req.attempt)) reject(CODES.input, `attempt は 1 以上の整数でなければならない: ${JSON.stringify(req.attempt)}`);
    const current = item.fails.length;
    if (req.attempt > current + 1) reject(CODES.conflict, `試行の番号が今の回数 + 1 を超える: ${req.attempt}（今の回数 ${current}）`);
    const reason = String(req.reason ?? '');
    const records = [{ t: 'fail', item: req.item, attempt: req.attempt, reason }];
    const limit = view.state.limits[LIMIT_KEYS.attempts];
    if (req.attempt === current + 1 && req.attempt >= limit) records.push({ t: 'abort', item: req.item, reason: `試行の上限 ${limit} 回に達した: ${reason}` });
    return {
      records,
      output: (after) => {
        const it = after.items.get(req.item);
        return { item: req.item, attempts: it.fails.length, limit, aborted: Boolean(it.aborted) };
      },
    };
  });
}

export function stageRepeat(ctx, req) {
  return mutate(ctx, req, 'stage-repeat', (view) => {
    checkStage(req.stage);
    if (!Object.values(LIMIT_KEYS).includes(req.limitKey)) reject(CODES.input, `limitKey が ${Object.values(LIMIT_KEYS).join('・')} のどれでもない: ${JSON.stringify(req.limitKey)}`);
    if (!isPosInt(req.n)) reject(CODES.input, `n は 1 以上の整数でなければならない: ${JSON.stringify(req.n)}`);
    const current = view.repeats.get(req.stage) ?? 0;
    if (req.n > current + 1) reject(CODES.conflict, `繰り返しの番号が今の回数 + 1 を超える: ${req.n}（今の回数 ${current}）`);
    return {
      records: [{ t: 'repeat', stage: req.stage, n: req.n }],
      output: (after) => ({ stage: req.stage, ...limitState(after, req.limitKey, after.repeats.get(req.stage) ?? 0, runBase(after).repeats[req.stage] ?? 0) }),
    };
  });
}

export function stageFinish(ctx, req) {
  return mutate(ctx, req, 'stage-finish', (view) => {
    checkStage(req.stage);
    checkRound(req.round);
    if (!stageEntry(view, req.stage, req.round ?? null)) reject(CODES.unknownId, `始めていない段: ${req.stage}${req.round != null ? `.${req.round}` : ''}`);
    return { records: [{ t: 'stageEnd', stage: req.stage, round: req.round ?? null }], output: {} };
  });
}

export function discard(ctx, req) {
  return mutate(ctx, req, 'discard', (view) => {
    if (!Array.isArray(req.items)) reject(CODES.input, 'items は並びでなければならない');
    const records = req.items.map((id) => {
      const item = itemOf(view, id);
      if (item.result !== undefined) reject(CODES.conflict, `結果のある項目は破棄できない: ${id}`);
      return { t: 'discard', item: id, run: req.run };
    });
    return { records, output: { discarded: req.items } };
  });
}

export function files(ctx, req) {
  return mutate(ctx, req, 'files', (view) => {
    if (!Array.isArray(req.entries)) reject(CODES.input, 'entries は並びでなければならない');
    const paths = view.paths.at(-1);
    const records = [];
    const outside = [];
    const recorded = [];
    for (const entry of req.entries) {
      if (!entry || typeof entry.path !== 'string' || !path.isAbsolute(entry.path)) reject(CODES.input, 'entries の path は絶対パスでなければならない');
      if (!isInList(paths, entry.path)) { outside.push(entry.path); continue; }
      const key = pathKey(paths.root, entry.path);
      if (entry.action !== undefined) {
        if (entry.action !== 'write' && entry.action !== 'delete') reject(CODES.input, `action は write・delete のどちらか: ${JSON.stringify(entry.action)}`);
        records.push({ t: 'file', run: req.run, path: key, action: entry.action });
      } else if (typeof entry.verified === 'boolean') {
        if (!view.files.some((f) => f.path === key) && !records.some((r) => r.t === 'file' && r.path === key)) reject(CODES.unknownId, `書いたファイルの一覧に無いパスの検証の記録: ${key}`);
        const iteration = entry.iteration ?? view.iterations;
        records.push({ t: 'verified', run: req.run, path: key, iteration, verified: entry.verified });
      } else {
        reject(CODES.input, 'entries の各要素は action か verified を持たなければならない');
      }
      recorded.push(key);
    }
    return { records, output: { recorded, outside } };
  });
}

export function unverifiedFiles(view) {
  const latest = new Map();
  for (const f of view.files) latest.set(f.path, f);
  return [...latest.values()].filter((f) => !view.verified.some((v) => v.path === f.path && v.verified && v.seq > f.seq)).map((f) => ({ path: f.path, action: f.action, run: f.run }));
}

export function stop(ctx, req) {
  return mutate(ctx, req, 'stop', async (view) => {
    const fn = view.state.function;
    if (!STOP_KINDS_BY_FUNCTION[fn].includes(req.kind)) reject(CODES.input, `${fn} が使わない停止の種類: ${JSON.stringify(req.kind)}`);
    if (req.kind !== STOP_KINDS.complete && (typeof req.reason !== 'string' || req.reason === '')) reject(CODES.input, '完了以外の停止には理由が要る');
    if ((req.kind === STOP_KINDS.iterationLimit) !== (req.limitHit !== undefined)) reject(CODES.input, 'limitHit は反復の上限の停止にだけ、必ず付ける');
    if (req.limitHit !== undefined && !LIMIT_HITS.includes(req.limitHit)) reject(CODES.input, `limitHit が ${LIMIT_HITS.join('・')} のどれでもない: ${JSON.stringify(req.limitHit)}`);
    if (!Number.isInteger(req.launches) || req.launches < 0) reject(CODES.input, `launches は 0 以上の整数でなければならない: ${JSON.stringify(req.launches)}`);
    if (req.onTargetChanged !== undefined && (req.onTargetChanged !== STOP_KINDS.blocked || REWRITING_FUNCTIONS.has(fn))) reject(CODES.input, 'onTargetChanged は review・audit の blocked だけ');
    const outsidePaths = req.outside ?? [];
    if (!Array.isArray(outsidePaths)) reject(CODES.input, 'outside は並びでなければならない');
    const live = stoppedStage(view, { includeCurrentRun: true });
    const derived = pendingItems(view, live);
    const pending = req.pending ?? [];
    if (!Array.isArray(pending) || pending.length !== derived.length || new Set(pending).size !== pending.length || pending.some((id) => !derived.includes(id))) {
      reject(CODES.conflict, `pending が状態から導いた未着手の項目と一致しない（状態: ${derived.join(',') || 'なし'}）`, { derived });
    }
    const now = await targetFingerprint(view.paths.at(-1));
    const startFp = view.fingerprints.find((f) => f.run === req.run && f.at === 'start');
    let kind = req.kind;
    let reason = req.reason ?? '';
    let limitHit = req.limitHit;
    let requested;
    if (req.onTargetChanged) {
      const changed = diffFingerprints(startFp?.files, now);
      if (changed.length > 0) {
        requested = { kind, reason };
        kind = STOP_KINDS.blocked;
        reason = `run の中で対象スキルが変わった: ${changed.join(', ')}`;
        limitHit = undefined;
      }
    }
    const record = {
      t: 'stop', run: req.run, kind, reason, limitHit, requested,
      stage: live.stage == null ? null : { stage: live.stage, round: live.round },
      pending, launches: req.launches,
      unverified: REWRITING_FUNCTIONS.has(fn) ? unverifiedFiles(view) : [],
      outside: outsidePaths,
    };
    return {
      records: [record, { t: 'fingerprint', run: req.run, at: 'stop', n: 1, files: now }],
      output: (after) => {
        const written = after.stops.get(req.run);
        return { stop: written, ...(written.kind === STOP_KINDS.complete ? {} : { nextArgs: nextArgs(after) }) };
      },
    };
  });
}

export async function list(ctx, req) {
  if (!FUNCTIONS.includes(req.function)) reject(CODES.input, `機能が ${FUNCTIONS.join('・')} のどれでもない: ${JSON.stringify(req.function)}`);
  if (!req.target || typeof req.target.root !== 'string') reject(CODES.input, 'target.root が要る');
  const root = stateRootOf(ctx);
  const wanted = realpathLoose(req.target.root);
  const states = [];
  for (const id of await listStateIds(root)) {
    const view = buildView(await readAll(stateDir(root, id)));
    if (!view.state || view.state.function !== req.function || view.paths[0]?.root !== wanted || isCompleted(view)) continue;
    const stopped = stoppedStage(view, { includeCurrentRun: true });
    states.push({ state: id, nextArgs: nextArgs(view), stoppedStage: stopped, pending: pendingItems(view, stopped) });
  }
  return { states };
}

export async function summary(ctx, req) {
  const { view } = await readState(ctx, req.state);
  return { summary: summarize(view) };
}
