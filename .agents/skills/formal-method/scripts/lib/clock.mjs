// run の期限（architecture.md「時計と資源」、cli-contract.md「定数」の検査に使える期限）。
// 壁時計と単調な時計を併用し、どちらかが期限を過ぎるか壁時計が戻ったら期限切れとする。上限が無ければ期限を持たない。
import { performance } from 'node:perf_hooks';
import { REPORT_RESERVE_MS, AGENT_BATCH_DEADLINE_MS } from './schemas.mjs';

export function reserveMs(limitSeconds) {
  return Math.min(REPORT_RESERVE_MS, (limitSeconds * 1000) / 4);
}

export function startRunClock(limitSeconds, source = { wall: () => Date.now(), mono: () => performance.now() }) {
  const startWall = source.wall();
  const startMono = source.mono();
  const limited = Number.isSafeInteger(limitSeconds) && limitSeconds >= 1;
  const usableMs = limited ? limitSeconds * 1000 - reserveMs(limitSeconds) : null;
  let lastWall = startWall;
  const clock = {
    limited,
    startWall,
    // 検査に使える期限（壁時計）。上限が無ければ null
    usableDeadlineWall: limited ? startWall + usableMs : null,
    elapsedMs: () => Math.max(0, source.mono() - startMono),
    now: () => source.wall(),
    // 検査に使える期限を過ぎたか
    usableExpired() {
      if (!limited) return false;
      const w = source.wall();
      if (w < lastWall) return true;
      lastWall = w;
      return w >= clock.usableDeadlineWall || source.mono() - startMono >= usableMs;
    },
    // 担当の batch の期限（壁時計）: 内部の期限と、検査に使える期限の早い方
    batchDeadlineWall() {
      const internal = source.wall() + AGENT_BATCH_DEADLINE_MS;
      return limited ? Math.min(internal, clock.usableDeadlineWall) : internal;
    },
  };
  return clock;
}

// setTimeout が受ける遅延の上限（これを超える値を Node は 1ms に置き換える）。
const TIMEOUT_MAX_MS = 2 ** 31 - 1;

// scheduler の ExecutionIo の時計（本番の node の timer）。上限を超える遅延は区切って張り直す。
export const NODE_TIMER_CLOCK = Object.freeze({
  now: () => Date.now(),
  setTimer(atMs, cb) {
    const handle = { timeout: null };
    const arm = () => {
      const left = Math.max(0, atMs - Date.now());
      if (left > TIMEOUT_MAX_MS) handle.timeout = setTimeout(arm, TIMEOUT_MAX_MS);
      else handle.timeout = setTimeout(cb, left);
    };
    arm();
    return handle;
  },
  clearTimer: (h) => clearTimeout(h.timeout),
});
