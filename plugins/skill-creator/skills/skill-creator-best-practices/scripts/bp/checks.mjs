import { CODES, FUNCTIONS, STAGES } from './constants.mjs';
import { reject } from './errors.mjs';

export function checkStage(stage) {
  if (!Object.hasOwn(STAGES, stage)) reject(CODES.unknownId, `段の名前が無い: ${JSON.stringify(stage)}`);
}

export function checkFunction(fn) {
  if (!FUNCTIONS.includes(fn)) reject(CODES.input, `機能が ${FUNCTIONS.join('・')} のどれでもない: ${JSON.stringify(fn)}`);
}

export const isPosInt = (n) => Number.isInteger(n) && n >= 1;

export function needPosInt(value, name) {
  if (!isPosInt(value)) reject(CODES.input, `${name} は 1 以上の整数でなければならない: ${JSON.stringify(value)}`);
}

// 試行の番号は今の回数 + 1 まで。それ以下は前に書いた試行の送り直しなので、打ち切った後でも同じ記録として受ける（SP-BPRUN-028）。
export function checkAttempt(item, attempt, what) {
  if (item.aborted && attempt > item.fails.length) reject(CODES.conflict, `打ち切った項目に${what}を書けない: ${item.id}`);
  needPosInt(attempt, 'attempt');
  if (attempt > item.fails.length + 1) reject(CODES.conflict, `試行の番号が今の回数 + 1 を超える: ${attempt}（今の回数 ${item.fails.length}）`);
}

export function checkWritableItem(item) {
  if (item.aborted || item.discarded) reject(CODES.conflict, `打ち切りか破棄の記録がある項目に結果を書けない: ${item.id}`);
}
