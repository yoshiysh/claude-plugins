// Bound each backend call so a single task cannot hold a parallel barrier forever.
export const AGENT_DEADLINE_MARGIN_MS = 50;
export const AGENT_QUIESCENCE_TIMEOUT_MS = 10000;

export function agentBudget(remainingMs, configuredMs) {
  const available = Math.floor(remainingMs - AGENT_DEADLINE_MARGIN_MS);
  return Math.max(1, Math.min(configuredMs, available));
}

export async function runAgent({ backend, task, signal, emit, remainingMs, timeoutMs }) {
  const controller = new AbortController();
  const relayAbort = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', relayAbort, { once: true });
  if (signal?.aborted) relayAbort();
  const budget = agentBudget(remainingMs, timeoutMs);
  let timer, timedOut = false;
  const backendRun = Promise.resolve().then(() => backend.run(task.prompt, task.options, {
    signal: controller.signal,
    emit,
  })).then(value => ({ type: 'result', value }), error => ({ type: 'error', error }));
  const timeout = new Promise(resolve => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error(`agent timeout after ${budget}ms`));
      resolve({ type: 'timeout' });
    }, budget);
  });
  try {
    const outcome = await Promise.race([backendRun, timeout]);
    if (outcome.type === 'timeout') {
      let quiescenceTimer;
      const quiesced = await Promise.race([
        backendRun.then(() => true),
        new Promise(resolve => { quiescenceTimer = setTimeout(() => resolve(false), AGENT_QUIESCENCE_TIMEOUT_MS); }),
      ]);
      clearTimeout(quiescenceTimer);
      if (!quiesced) {
        const error = new Error(`agent failed to quiesce within ${AGENT_QUIESCENCE_TIMEOUT_MS}ms after timeout`);
        error.fatal = true;
        throw error;
      }
      return { result: null, timedOut: true, quiesced: true, timeoutMs: budget };
    }
    if (timedOut) return { result: null, timedOut: true, quiesced: true, timeoutMs: budget };
    if (outcome.type === 'error') throw outcome.error;
    return { result: outcome.value, timedOut: false, quiesced: true, timeoutMs: budget };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', relayAbort);
  }
}
