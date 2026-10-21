import { promises as fs } from 'node:fs';
import path from 'node:path';
import { CODES, WORK_DIR } from './constants.mjs';
import { reject } from './errors.mjs';
import { sum } from './ids.mjs';

// 運搬役（haiku・low）の写し崩れを、要求の sum で構造的に検出する（bp-run SP-BPRUN-031）。
export function verifyRequest(text) {
  let request;
  try {
    request = JSON.parse(text);
  } catch (error) {
    reject(CODES.transport, `要求が JSON として読めない: ${error.message}`);
  }
  if (request === null || typeof request !== 'object' || Array.isArray(request)) reject(CODES.transport, '要求は JSON のオブジェクトでなければならない');
  const { sum: given, ...body } = request;
  if (typeof given !== 'string') reject(CODES.transport, '要求に sum が無い');
  const actual = sum(body);
  if (given !== actual) reject(CODES.transport, `要求の sum が合わない（受け取った ${given}、計算した ${actual}）`);
  return body;
}

export async function resolvePayload(request, stateDirPath) {
  if (request.payloadFile === undefined) return request;
  const { payloadFile, payloadSum, ...rest } = request;
  const work = path.join(stateDirPath, WORK_DIR);
  const file = path.resolve(work, payloadFile);
  const rel = path.relative(work, file);
  if (rel.startsWith('..') || path.isAbsolute(rel)) reject(CODES.transport, `payloadFile は作業場所の ${WORK_DIR}/ の中でなければならない: ${payloadFile}`);
  let payload;
  try {
    payload = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    reject(CODES.transport, `payloadFile を読めない: ${payloadFile}（${error.message}）`);
  }
  const actual = sum(payload);
  if (payloadSum !== actual) reject(CODES.transport, `payloadFile の sum が合わない（受け取った ${payloadSum}、計算した ${actual}）`);
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) reject(CODES.transport, 'payloadFile の中身は JSON のオブジェクトでなければならない');
  for (const key of Object.keys(payload)) {
    if (key in rest) reject(CODES.transport, `payloadFile と要求に同じ欄がある: ${key}`);
  }
  return { ...rest, ...payload };
}

export function sealResponse(response) {
  return { ...response, sum: sum(response) };
}
