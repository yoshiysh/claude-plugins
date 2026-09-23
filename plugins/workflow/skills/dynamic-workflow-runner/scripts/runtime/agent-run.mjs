// Bound each backend call so a single task cannot hold a parallel barrier forever.
export const AGENT_DEADLINE_MARGIN_MS = 50;

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
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`agent timeout after ${budget}ms`);
      error.agentTimeout = true;
      error.timeoutMs = budget;
      controller.abort(error);
      reject(error);
    }, budget);
  });
  const backendRun = Promise.resolve().then(() => backend.run(task.prompt, task.options, {
    signal: controller.signal,
    emit,
  }));
  try {
    return { result: await Promise.race([backendRun, timeout]), timedOut: false, timeoutMs: budget };
  } catch (error) {
    if (error?.agentTimeout) return { result: null, timedOut: true, timeoutMs: budget };
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', relayAbort);
  }
}
