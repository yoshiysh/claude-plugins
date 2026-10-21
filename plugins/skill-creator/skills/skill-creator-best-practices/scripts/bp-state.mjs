#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CODES, CRITERIA_DIR, EXIT, OPS, PROMPT_AUDIT_FILE } from './bp/constants.mjs';
import { BpError } from './bp/errors.mjs';
import * as run from './bp/ops-run.mjs';
import * as ledger from './bp/ops-ledger.mjs';
import * as author from './bp/ops-author.mjs';
import * as inspect from './bp/ops-inspect.mjs';
import { locateState } from './bp/store.mjs';
import { resolvePayload, sealResponse, verifyRequest } from './bp/transport.mjs';

const SKILL_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const HANDLERS = {
  [OPS.start]: run.start,
  [OPS.premise]: run.premise,
  [OPS.stageStart]: run.stageStart,
  [OPS.itemResult]: run.itemResult,
  [OPS.itemFail]: run.itemFail,
  [OPS.stageRepeat]: run.stageRepeat,
  [OPS.stageFinish]: run.stageFinish,
  [OPS.discard]: run.discard,
  [OPS.files]: run.files,
  [OPS.stop]: run.stop,
  [OPS.summary]: run.summary,
  [OPS.list]: run.list,
  [OPS.ledgerCreate]: ledger.ledgerCreate,
  [OPS.ledgerRetake]: ledger.ledgerRetake,
  [OPS.assignments]: ledger.assignments,
  [OPS.verdicts]: ledger.verdicts,
  [OPS.refutationItems]: ledger.refutationItems,
  [OPS.refutation]: ledger.refutation,
  [OPS.reviewJudge]: ledger.reviewJudge,
  [OPS.vanishMatch]: ledger.vanishMatch,
  [OPS.report]: ledger.report,
  [OPS.kinds]: ledger.kinds,
  [OPS.key]: author.key,
  [OPS.paths]: author.paths,
  [OPS.pathsRetake]: author.pathsRetake,
  [OPS.snapshot]: author.snapshot,
  [OPS.goalCheck]: author.goalCheck,
  [OPS.filesScan]: author.filesScan,
  [OPS.units]: author.units,
  [OPS.gate]: author.gate,
  [OPS.outcome]: author.outcome,
  [OPS.targets]: inspect.targets,
  [OPS.bundle]: inspect.bundle,
  [OPS.applicability]: inspect.applicability,
  [OPS.stopDraft]: run.stopDraft,
};

const RESERVED = ['ok', 'op', 'sum'];

export function context({ cwd = process.cwd(), env = process.env, criteriaDir = path.join(SKILL_DIR, CRITERIA_DIR), promptAudit = path.join(SKILL_DIR, PROMPT_AUDIT_FILE) } = {}) {
  return { cwd, env, criteriaDir, promptAudit };
}

// 操作の出力が受理の印を上書きすると、応答の ok で受理を見分ける運搬役が誤るので、衝突は内部の失敗にする。
export function acceptance(op, output) {
  const clash = RESERVED.filter((k) => Object.hasOwn(output, k));
  if (clash.length) throw new BpError(CODES.internal, `操作の出力が応答の予約欄と衝突する: ${op}（${clash.join('・')}）`);
  return sealResponse({ ok: true, op, ...output });
}

export async function main(argv, stdinText, { cwd, env, criteriaDir, promptAudit } = {}) {
  const ctx = context({ cwd, env, criteriaDir, promptAudit });
  try {
    const op = argv[0];
    const handler = Object.hasOwn(HANDLERS, op) ? HANDLERS[op] : null;
    if (!handler) throw new BpError(CODES.input, `操作が無い: ${JSON.stringify(op)}（${Object.values(OPS).join(' ')}）`);
    let req = verifyRequest(stdinText);
    if (req.payloadFile !== undefined) req = await resolvePayload(req, await locateState(ctx, req.state));
    const output = await handler(ctx, req);
    return { exitCode: EXIT.ok, output: acceptance(op, output) };
  } catch (error) {
    if (error instanceof BpError && error.code !== CODES.internal) {
      return { exitCode: EXIT.rejected, output: sealResponse({ ok: false, code: error.code, reason: error.reason, ...error.detail }) };
    }
    return { exitCode: EXIT.internal, output: sealResponse({ ok: false, code: CODES.internal, reason: error.reason ?? String(error?.stack ?? error) }) };
  }
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

if (process.argv[1] && realpathSync(path.resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  const { exitCode, output } = await main(process.argv.slice(2), await readStdin());
  process.stdout.write(`${JSON.stringify(output)}\n`);
  process.exitCode = exitCode;
}
