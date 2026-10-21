import { promises as fs } from 'node:fs';
import { CODES, OPS } from './constants.mjs';
import { BpError, reject } from './errors.mjs';
import { append, readAll, withLock } from './journal.mjs';
import { freshRecords } from './records.mjs';
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

// 現在でない run と、停止を書いた後の run の書き込みを拒否する（SP-BPRUN-017）。
function checkRun(view, run) {
  if (typeof run !== 'string') reject(CODES.unknownId, '要求に run が無い');
  if (!view.runs.some((r) => r.id === run)) reject(CODES.unknownId, `状態に無い run ID: ${run}`);
  const current = currentRun(view);
  if (current.id !== run) reject(CODES.staleRun, `現在の run ではない: ${run}（現在は ${current.id}）`);
  return view.stops.has(run);
}

export async function mutate(ctx, req, op, build) {
  const dir = await locateState(ctx, req.state);
  return withLock(dir, async () => {
    const lines = await readAll(dir);
    const view = buildView(lines);
    const stopped = checkRun(view, req.run);
    if (stopped && op !== OPS.stop) reject(CODES.staleRun, `停止を書いた後の run の書き込み: ${req.run}`);
    let built;
    let fresh;
    try {
      built = await build(view, dir);
      fresh = freshRecords(view, built.records ?? []);
    } catch (error) {
      if (stopped) reject(CODES.staleRun, `停止を書いた後の run の書き込み: ${req.run}`);
      throw error;
    }
    const records = built.records ?? [];
    if (stopped && fresh.length > 0) reject(CODES.staleRun, `停止を書いた後の run の書き込み: ${req.run}`);
    let after = view;
    if (fresh.length > 0) {
      const line = { seq: view.lastSeq + 1, run: req.run, op, records: fresh };
      await append(dir, line);
      after = buildView([...lines, line]);
    }
    if (built.error) throw new BpError(built.error.code, built.error.reason, built.error.detail);
    const output = typeof built.output === 'function' ? built.output(after) : (built.output ?? {});
    return { ...output, same: records.length > 0 && fresh.length === 0 };
  });
}
