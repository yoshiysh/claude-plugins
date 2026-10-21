import { CODES, FUNCTIONS, STAGES } from './constants.mjs';
import { reject } from './errors.mjs';

export function checkStage(stage) {
  if (!Object.hasOwn(STAGES, stage)) reject(CODES.unknownId, `段の名前が無い: ${JSON.stringify(stage)}`);
}

export function checkFunction(fn) {
  if (!FUNCTIONS.includes(fn)) reject(CODES.input, `機能が ${FUNCTIONS.join('・')} のどれでもない: ${JSON.stringify(fn)}`);
}

export function checkWritableItem(item) {
  if (item.aborted || item.discarded) reject(CODES.conflict, `打ち切りか破棄の記録がある項目に結果を書けない: ${item.id}`);
}
