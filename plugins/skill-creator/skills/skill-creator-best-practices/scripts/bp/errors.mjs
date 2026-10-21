import { CODES } from './constants.mjs';

export class BpError extends Error {
  constructor(code, reason, detail = {}) {
    super(`${code}: ${reason}`);
    this.code = code;
    this.reason = reason;
    this.detail = detail;
  }
}

export function reject(code, reason, detail) {
  throw new BpError(code, reason, detail);
}

export function internal(reason, detail) {
  throw new BpError(CODES.internal, reason, detail);
}
