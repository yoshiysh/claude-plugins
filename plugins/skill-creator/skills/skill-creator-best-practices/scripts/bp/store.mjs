import { promises as fs } from 'node:fs';
import path from 'node:path';
import { CODES, OPS, REQUESTS_FILE } from './constants.mjs';
import { BpError, reject } from './errors.mjs';
import { append, readAll, withLock } from './journal.mjs';
import { freshRecords } from './records.mjs';
import { canonical, sha256Hex } from './ids.mjs';
import { buildView, currentRun } from './view.mjs';
import { resolveStateRoot, stateDir } from './workspace.mjs';

export function stateRootOf(ctx) {
  return ctx.stateRoot ?? resolveStateRoot({ cwd: ctx.cwd, env: ctx.env });
}

export async function locateState(ctx, id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9-]+$/.test(id)) reject(CODES.unknownId, `状態 ID の形ではない: ${JSON.stringify(id)}`);
  const dir = stateDir(stateRootOf(ctx), id);
  try {
    await fs.access(dir);
  } catch {
    reject(CODES.unknownId, `状態が無い: ${id}`);
  }
  return dir;
}

export async function readState(ctx, id) {
  const dir = await locateState(ctx, id);
  const lines = await readAll(dir);
  return { dir, lines, view: buildView(lines) };
}

function checkRun(view, run) {
  if (typeof run !== 'string') reject(CODES.unknownId, '要求に run が無い');
  if (!view.runs.some((r) => r.id === run)) reject(CODES.unknownId, `状態に無い run ID: ${run}`);
  const current = currentRun(view);
  if (current.id !== run) reject(CODES.staleRun, `現在の run ではない: ${run}（現在は ${current.id}）`);
  return view.stops.has(run);
}

// 要求の鍵は要求の本文そのもの（作業ファイルで渡した中身を足した後）から作る。運搬役の sum は本文を照らす値で、本文の無い要求の鍵にはならない。
function requestKey(req) {
  return sha256Hex(canonical(req));
}

async function appliedResponse(dir, req, op) {
  let text;
  try {
    text = await fs.readFile(path.join(dir, REQUESTS_FILE), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  for (const line of text.split('\n')) {
    if (!line) continue;
    const r = JSON.parse(line);
    if (r.run === req.run && r.op === op && r.key === requestKey(req)) return r.output;
  }
  return null;
}

// 停止を書いた後の run への書き込みは build を走らせずに決める（走らせると作業ファイルを書き、時刻で変わる結果が送り直しを拒否させ、内部の失敗の符号がすり替わる）。
// この run で既に受理した要求そのもの（操作と sum が同じ）の送り直しだけを最初の応答で受ける（SP-BPRUN-017・SP-BPRUN-027）。
export async function mutate(ctx, req, op, build) {
  const dir = await locateState(ctx, req.state);
  return withLock(dir, async () => {
    const lines = await readAll(dir);
    const view = buildView(lines);
    const stopped = checkRun(view, req.run);
    if (stopped && op !== OPS.stop) {
      const applied = await appliedResponse(dir, req, op);
      if (applied === null) reject(CODES.staleRun, `停止を書いた後の run の書き込み: ${req.run}`);
      return { ...applied, same: true };
    }
    const built = await build(view, dir);
    const fresh = freshRecords(view, built.records ?? []);
    const records = built.records ?? [];
    if (stopped && fresh.length > 0) reject(CODES.staleRun, `停止を書いた後の run の書き込み: ${req.run}`);
    let after = view;
    if (fresh.length > 0) {
      const line = { seq: view.lastSeq + 1, run: req.run, op, records: fresh };
      await append(dir, line);
      after = buildView([...lines, line]);
    }
    if (built.error) throw new BpError(built.error.code, built.error.reason, built.error.detail);
    const output = { ...(typeof built.output === 'function' ? built.output(after) : (built.output ?? {})), same: records.length > 0 && fresh.length === 0 };
    if (op !== OPS.stop) await fs.appendFile(path.join(dir, REQUESTS_FILE), `${JSON.stringify({ run: req.run, op, key: requestKey(req), output })}\n`);
    return output;
  });
}
