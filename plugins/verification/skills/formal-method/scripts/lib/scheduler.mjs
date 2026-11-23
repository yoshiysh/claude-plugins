// 道具の実行の終わり方と、同時に動かす実行の管理（architecture.md「期限と道具の終わりが重なったとき」「scheduler の unit の入口」
// 「同時に動かす数」「互いに独立な検査（D1）」）。終わり方は 1 つの event loop の中で先に観測した出来事だけで決める。
import { availableParallelism } from 'node:os';
import { TOOL_OUTPUT_MAX_BYTES } from './schemas.mjs';
import { decodeEnd, answerResult, ANSWERS } from './adapters/z3.mjs';
import { classifyCheck } from './verdict.mjs';

export const NOT_STARTED_END = Object.freeze({
  started: false, tool_result: 'なし', abnormal_exit: false, unreadable_output: false, stopped_by: null, time_limit_hit: null,
});
const STOPPED = (stoppedBy, timeLimitHit, unreadable = false) => ({
  started: true, tool_result: 'なし', abnormal_exit: false, unreadable_output: unreadable, stopped_by: stoppedBy, time_limit_hit: timeLimitHit,
});
const EMPTY = new Uint8Array(0);

function concatBytes(chunks, total) {
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

// 標準出力のバイト列から、最初の空でない行が改行まで届いたかを見る。届いていれば { answer, endOffset }（改行の位置）、
// 最初の空でない行が答えでなければ { answer: null }、まだ届いていなければ null。
function firstLine(bytes) {
  let lineStart = 0;
  for (let i = 0; i < bytes.length; i += 1) {
    if (bytes[i] !== 0x0a) continue;
    const line = Buffer.from(bytes.subarray(lineStart, i)).toString('utf8').trim();
    if (line.length > 0) return ANSWERS.includes(line) ? { answer: line, newlineAt: i } : { answer: null };
    lineStart = i + 1;
  }
  return null;
}

export function runExecution(execution, io) {
  const base = { execution_id: execution.execution_id, stdout: EMPTY, stderr: EMPTY, exit_code: null, model_cut: 'none' };
  const now = io.clock.now();
  if ((execution.deadline_ms !== null && execution.deadline_ms !== undefined && now >= execution.deadline_ms) || io.signal.aborted) {
    return Promise.resolve({ ...base, end: { ...NOT_STARTED_END } });
  }
  return new Promise((resolve) => {
    const outChunks = [];
    let outLen = 0;
    const errChunks = [];
    let errLen = 0;
    let decided = null; // close より先に決まった終わり方
    let answer = null; // 答えの行（with_model のとき）
    let firstLineSeen = false;
    let modelCut = 'none';
    let timer = null;
    let proc = null;
    const clearTimer = () => { if (timer !== null) { io.clock.clearTimer(timer); timer = null; } };
    const stop = (end) => {
      decided = end;
      clearTimer();
      proc.killGroup();
    };
    const onEvent = (kind) => {
      if (decided) return;
      if (execution.with_model && answer !== null) {
        if (modelCut === 'none') modelCut = 'stopped_after_answer';
        stop({ started: true, abnormal_exit: false, unreadable_output: false, stopped_by: null, ...answerResult(answer, execution.expected) });
        return;
      }
      stop(kind === 'deadline' ? STOPPED('時間', '依頼元') : STOPPED('その他', null));
    };
    const onAbort = () => onEvent('abort');
    proc = io.spawn(execution);
    proc.onStdout((chunk) => {
      if (decided) return;
      const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
      const room = Math.max(0, TOOL_OUTPUT_MAX_BYTES - outLen);
      const kept = bytes.length > room ? bytes.subarray(0, room) : bytes;
      if (kept.length > 0) { outChunks.push(kept); outLen += kept.length; }
      const overflow = bytes.length > room;
      if (execution.with_model && !firstLineSeen) {
        const all = concatBytes(outChunks, outLen);
        const fl = firstLine(all);
        if (fl) {
          firstLineSeen = true;
          if (fl.answer !== null && fl.newlineAt < TOOL_OUTPUT_MAX_BYTES) answer = fl.answer;
        }
      }
      if (overflow) {
        if (execution.with_model && answer !== null) modelCut = 'truncated';
        else stop(STOPPED('その他', null, true));
      }
    });
    proc.onStderr((chunk) => {
      const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
      errChunks.push(bytes);
      errLen += bytes.length;
    });
    proc.onClose((exitCode) => {
      io.signal.removeEventListener('abort', onAbort);
      clearTimer();
      const stdout = concatBytes(outChunks, outLen);
      const stderr = concatBytes(errChunks, errLen);
      // 起動できなかった実行（startFailure）は、道具の異常終了でなく始めていない実行とし、原因を持たせる
      const failure = proc.startFailure ?? null;
      if (failure) { resolve({ ...base, end: { ...NOT_STARTED_END }, stdout, stderr, exit_code: exitCode, model_cut: 'none', start_failure: failure }); return; }
      const end = decided ?? decodeEnd({ stdout, exit_code: exitCode, with_model: execution.with_model, expected: execution.expected });
      resolve({ ...base, end, stdout, stderr, exit_code: exitCode, model_cut: modelCut });
    });
    io.signal.addEventListener('abort', onAbort, { once: true });
    if (execution.deadline_ms !== null && execution.deadline_ms !== undefined) timer = io.clock.setTimer(execution.deadline_ms, () => { timer = null; onEvent('deadline'); });
  });
}

// 実行の一覧を、依存（depends_on）と同時に動かす数の上限の下で動かす。依存先が 成功 でない実行は始めずに始めていない終わり方とする（D1）。
// executions: [{ spec: ExecutionSpec, depends_on: [execution_id] }]、makeIo(spec) → ExecutionIo、onDone(outcome) は終わるたびに呼ぶ。
// 依存が循環して始められない実行と、一覧に無い依存先（欠陥で除いた検査・query を読めず始めなかった実行）を持つ実行は、
// 依存先が 成功 でないものと同じく始めない（not_started_reason: 'dependency'）。
// 実行の起動が投げたら（reject）、以後は始めずに、その誤りで返り値の Promise をすぐ reject する（動いている実行を止めるのは呼び手）。
export async function runExecutions(executions, { makeIo, onDone = null, signal }) {
  const byId = new Map(executions.map((x) => [x.spec.execution_id, x]));
  const independent = executions.filter((x) => x.depends_on.length === 0).length;
  const limit = Math.max(1, Math.min(availableParallelism(), Math.max(1, independent)));
  const outcomes = new Map();
  const waiting = new Map(executions.map((x) => [x.spec.execution_id, x]));
  let running = 0;
  return new Promise((resolve, reject) => {
    let failure = null;
    const notStarted = (id, why) => ({ execution_id: id, end: { ...NOT_STARTED_END }, stdout: EMPTY, stderr: EMPTY, exit_code: null, model_cut: 'none', not_started_reason: why });
    const finish = (id, outcome) => {
      outcomes.set(id, outcome);
      if (onDone) onDone(outcome);
    };
    const verdictOf = (id) => { const o = outcomes.get(id); try { return o ? classifyCheck(o.end) : null; } catch { return '実行失敗'; } };
    const pump = () => {
      if (failure) return;
      let progressed = true;
      while (progressed) {
        progressed = false;
        for (const [id, x] of waiting) {
          const absent = x.depends_on.some((d) => !byId.has(d));
          const deps = x.depends_on.filter((d) => byId.has(d));
          if (!absent && deps.some((d) => !outcomes.has(d))) continue;
          if (absent || deps.some((d) => verdictOf(d) !== '成功') || signal?.aborted) {
            waiting.delete(id);
            finish(id, notStarted(id, signal?.aborted ? 'aborted' : 'dependency'));
            progressed = true;
            continue;
          }
          if (running >= limit) continue;
          waiting.delete(id);
          running += 1;
          let started;
          try { started = runExecution(x.spec, makeIo(x.spec)); } catch (e) { started = Promise.reject(e); }
          started.then((o) => {
            running -= 1;
            finish(id, o);
            pump();
          }, (e) => {
            running -= 1;
            if (failure) return;
            failure = e;
            reject(e);
          });
          progressed = true;
        }
      }
      // 何も動いておらず、待ちが残る: 依存の循環。残りを始めずに終える
      if (running === 0 && waiting.size > 0) {
        for (const id of [...waiting.keys()]) { waiting.delete(id); finish(id, notStarted(id, 'dependency')); }
      }
      if (waiting.size === 0 && running === 0) resolve(outcomes);
    };
    pump();
  });
}
