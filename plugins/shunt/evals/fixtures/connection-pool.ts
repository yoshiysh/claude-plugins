// Async connection pool with bounded concurrency, retry/backoff, and
// lock-ordered eviction. Used as a "genuinely complex" fixture: the first
// ~40 lines already contain race-sensitive state transitions, not
// boilerplate, so a fidelity-axis gate should keep this in Claude's own
// context even once the file clears the line-count threshold.

interface PooledConnection {
  id: string;
  inUse: boolean;
  createdAt: number;
  lastUsedAt: number;
  failureCount: number;
}

interface PoolOptions {
  maxSize: number;
  minIdle: number;
  acquireTimeoutMs: number;
  maxRetries: number;
  baseBackoffMs: number;
  idleEvictionMs: number;
}

type Waiter = { resolve: (conn: PooledConnection) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> };

export class ConnectionPool {
  private connections: Map<string, PooledConnection> = new Map();
  private waiters: Waiter[] = [];
  private closing = false;
  // Single mutex flag guards structural mutation of `connections`/`waiters`
  // so concurrent acquire()/release() calls interleave safely even though
  // this is single-threaded JS with async interleaving points.
  private locked = false;
  private lockQueue: Array<() => void> = [];

  constructor(private readonly options: PoolOptions, private readonly factory: () => Promise<PooledConnection>) {}

  private async withLock<T>(fn: () => Promise<T> | T): Promise<T> {
    if (this.locked) {
      await new Promise<void>((resolve) => this.lockQueue.push(resolve));
    }
    this.locked = true;
    try {
      return await fn();
    } finally {
      this.locked = false;
      const next = this.lockQueue.shift();
      if (next) next();
    }
  }

  async acquire(): Promise<PooledConnection> {
    if (this.closing) throw new Error('pool is closing');

    const existing = await this.withLock(() => {
      for (const conn of this.connections.values()) {
        if (!conn.inUse) {
          conn.inUse = true;
          conn.lastUsedAt = Date.now();
          return conn;
        }
      }
      return null;
    });
    if (existing) return existing;

    if (this.connections.size < this.options.maxSize) {
      return this.createWithRetry();
    }

    // Pool is saturated: queue this caller and race the wake-up against a
    // timeout. Whichever settles first must invalidate the other so a
    // late-arriving resolve doesn't hand a connection to a caller who has
    // already given up (a classic lost-wakeup / double-fulfillment bug if
    // the timer isn't cleared on the happy path).
    return new Promise<PooledConnection>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.resolve !== resolve);
        reject(new Error(`acquire timed out after ${this.options.acquireTimeoutMs}ms`));
      }, this.options.acquireTimeoutMs);
      this.waiters.push({ resolve, reject, timer });
    });
  }

  private async createWithRetry(attempt = 0): Promise<PooledConnection> {
    try {
      const conn = await this.factory();
      await this.withLock(() => {
        this.connections.set(conn.id, { ...conn, inUse: true, createdAt: Date.now(), lastUsedAt: Date.now(), failureCount: 0 });
      });
      return this.connections.get(conn.id)!;
    } catch (err) {
      if (attempt >= this.options.maxRetries) {
        throw new Error(`failed to create connection after ${attempt + 1} attempts: ${(err as Error).message}`);
      }
      // Exponential backoff with full jitter so a burst of simultaneous
      // failures (e.g. a downstream restart) doesn't retry in lockstep and
      // re-trigger the same overload.
      const backoff = this.options.baseBackoffMs * 2 ** attempt;
      const jittered = Math.random() * backoff;
      await new Promise((r) => setTimeout(r, jittered));
      return this.createWithRetry(attempt + 1);
    }
  }

  async release(id: string): Promise<void> {
    await this.withLock(() => {
      const conn = this.connections.get(id);
      if (!conn) return;
      conn.inUse = false;
      conn.lastUsedAt = Date.now();

      // Hand this connection directly to the oldest waiter rather than
      // letting it go idle and having the waiter race a fresh acquire() —
      // that ordering starves waiters under sustained load because new
      // acquire() calls can win the "first free slot" scan before a queued
      // waiter's promise settles.
      const waiter = this.waiters.shift();
      if (waiter) {
        clearTimeout(waiter.timer);
        conn.inUse = true;
        waiter.resolve(conn);
      }
    });
  }

  async evictIdle(): Promise<number> {
    const now = Date.now();
    return this.withLock(() => {
      let evicted = 0;
      for (const [id, conn] of this.connections) {
        if (conn.inUse) continue;
        if (this.connections.size - evicted <= this.options.minIdle) break;
        if (now - conn.lastUsedAt >= this.options.idleEvictionMs) {
          this.connections.delete(id);
          evicted++;
        }
      }
      return evicted;
    });
  }

  async drain(): Promise<void> {
    this.closing = true;
    // Reject queued waiters before releasing the lock on connections, so no
    // new acquire() can slip in and observe a connection that is about to
    // be torn down.
    await this.withLock(() => {
      for (const waiter of this.waiters) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error('pool is draining'));
      }
      this.waiters = [];
    });
    while (true) {
      const stillInUse = await this.withLock(() =>
        Array.from(this.connections.values()).some((c) => c.inUse)
      );
      if (!stillInUse) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    await this.withLock(() => this.connections.clear());
  }

  size(): number {
    return this.connections.size;
  }

  idleCount(): number {
    let idle = 0;
    for (const conn of this.connections.values()) if (!conn.inUse) idle++;
    return idle;
  }
}

// --- Failure-injection wrapper used by the test suite below -----------------
// Wraps a real factory and forces the Nth call (1-indexed) to fail, so the
// retry/backoff path above is exercised deterministically instead of relying
// on flaky timing.
export function withInjectedFailure(
  factory: () => Promise<PooledConnection>,
  failOnCall: number
): () => Promise<PooledConnection> {
  let calls = 0;
  return async () => {
    calls++;
    if (calls === failOnCall) {
      throw new Error(`injected failure on call ${calls}`);
    }
    return factory();
  };
}

function makeFakeConnection(id: string): PooledConnection {
  return { id, inUse: false, createdAt: Date.now(), lastUsedAt: Date.now(), failureCount: 0 };
}

async function scenarioAcquireReleaseCycle(): Promise<void> {
  let counter = 0;
  const pool = new ConnectionPool(
    { maxSize: 2, minIdle: 0, acquireTimeoutMs: 200, maxRetries: 1, baseBackoffMs: 5, idleEvictionMs: 50 },
    async () => makeFakeConnection(`conn-${++counter}`)
  );
  const a = await pool.acquire();
  const b = await pool.acquire();
  if (pool.size() !== 2) throw new Error('expected pool to grow to maxSize');
  await pool.release(a.id);
  const c = await pool.acquire();
  if (c.id !== a.id) throw new Error('expected released connection to be reused before creating a third');
  await pool.release(b.id);
  await pool.release(c.id);
}

async function scenarioQueuedWaiterWins(): Promise<void> {
  let counter = 0;
  const pool = new ConnectionPool(
    { maxSize: 1, minIdle: 0, acquireTimeoutMs: 500, maxRetries: 1, baseBackoffMs: 5, idleEvictionMs: 50 },
    async () => makeFakeConnection(`conn-${++counter}`)
  );
  const first = await pool.acquire();
  const pending = pool.acquire();
  setTimeout(() => pool.release(first.id), 10);
  const second = await pending;
  if (second.id !== first.id) throw new Error('expected the queued waiter to receive the released connection');
}

async function scenarioAcquireTimesOut(): Promise<void> {
  const pool = new ConnectionPool(
    { maxSize: 1, minIdle: 0, acquireTimeoutMs: 20, maxRetries: 1, baseBackoffMs: 5, idleEvictionMs: 50 },
    async () => makeFakeConnection('only-conn')
  );
  await pool.acquire();
  let timedOut = false;
  try {
    await pool.acquire();
  } catch (err) {
    timedOut = (err as Error).message.includes('timed out');
  }
  if (!timedOut) throw new Error('expected the second acquire() to time out');
}

async function scenarioRetriesThenSucceeds(): Promise<void> {
  let counter = 0;
  const flaky = withInjectedFailure(async () => makeFakeConnection(`conn-${++counter}`), /* failOnCall */ 1);
  const pool = new ConnectionPool(
    { maxSize: 1, minIdle: 0, acquireTimeoutMs: 500, maxRetries: 3, baseBackoffMs: 5, idleEvictionMs: 50 },
    flaky
  );
  const conn = await pool.acquire();
  if (!conn) throw new Error('expected acquire() to eventually succeed after one injected failure');
}

async function scenarioEvictsIdleBelowMinIdle(): Promise<void> {
  let counter = 0;
  const pool = new ConnectionPool(
    { maxSize: 5, minIdle: 1, acquireTimeoutMs: 200, maxRetries: 1, baseBackoffMs: 5, idleEvictionMs: 1 },
    async () => makeFakeConnection(`conn-${++counter}`)
  );
  const conns = await Promise.all([pool.acquire(), pool.acquire(), pool.acquire()]);
  for (const c of conns) await pool.release(c.id);
  await new Promise((r) => setTimeout(r, 5));
  const evicted = await pool.evictIdle();
  if (pool.idleCount() < 1) throw new Error('expected minIdle to keep at least one idle connection');
  if (evicted !== conns.length - 1) throw new Error(`expected ${conns.length - 1} evictions, got ${evicted}`);
}

async function scenarioDrainRejectsQueuedWaiters(): Promise<void> {
  const pool = new ConnectionPool(
    { maxSize: 1, minIdle: 0, acquireTimeoutMs: 1000, maxRetries: 1, baseBackoffMs: 5, idleEvictionMs: 50 },
    async () => makeFakeConnection('only-conn')
  );
  await pool.acquire();
  const pending = pool.acquire();
  const drainPromise = pool.drain();
  let rejected = false;
  try {
    await pending;
  } catch (err) {
    rejected = (err as Error).message.includes('draining');
  }
  if (!rejected) throw new Error('expected queued waiter to be rejected on drain()');
  await pool.release('only-conn');
  await drainPromise;
  if (pool.size() !== 0) throw new Error('expected drain() to clear all connections');
}

// --- Circuit breaker over the pool's factory ---------------------------
// Trips after `failureThreshold` consecutive factory failures and stays
// open for `resetTimeoutMs`, after which exactly one probe call is allowed
// through (half-open) — letting more than one through concurrently would
// double-count the probe's outcome and could flap the breaker.
type BreakerState = 'closed' | 'open' | 'half-open';

export class CircuitBreaker {
  private state: BreakerState = 'closed';
  private consecutiveFailures = 0;
  private openedAt = 0;
  private probeInFlight = false;

  constructor(private readonly failureThreshold: number, private readonly resetTimeoutMs: number) {}

  async call<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'open') {
      if (Date.now() - this.openedAt < this.resetTimeoutMs) {
        throw new Error('circuit is open');
      }
      if (this.probeInFlight) {
        throw new Error('circuit is open (probe already in flight)');
      }
      this.state = 'half-open';
      this.probeInFlight = true;
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure();
      throw err;
    } finally {
      this.probeInFlight = false;
    }
  }

  private onSuccess(): void {
    this.consecutiveFailures = 0;
    this.state = 'closed';
  }

  private onFailure(): void {
    this.consecutiveFailures++;
    if (this.state === 'half-open' || this.consecutiveFailures >= this.failureThreshold) {
      this.state = 'open';
      this.openedAt = Date.now();
    }
  }

  currentState(): BreakerState {
    return this.state;
  }
}

async function scenarioBreakerOpensAfterThreshold(): Promise<void> {
  const breaker = new CircuitBreaker(2, 1000);
  const failing = async () => {
    throw new Error('downstream unavailable');
  };
  for (let i = 0; i < 2; i++) {
    try {
      await breaker.call(failing);
    } catch {
      // expected
    }
  }
  if (breaker.currentState() !== 'open') throw new Error('expected breaker to open after threshold failures');
  let blocked = false;
  try {
    await breaker.call(async () => 'unreachable');
  } catch (err) {
    blocked = (err as Error).message.includes('circuit is open');
  }
  if (!blocked) throw new Error('expected calls to be rejected while the breaker is open');
}

async function scenarioBreakerHalfOpenSingleProbe(): Promise<void> {
  const breaker = new CircuitBreaker(1, 10);
  try {
    await breaker.call(async () => {
      throw new Error('fail once');
    });
  } catch {
    // expected — this trips the breaker open
  }
  await new Promise((r) => setTimeout(r, 15));
  // Two concurrent calls race for the single half-open probe slot; exactly
  // one must be allowed through to fn(), the other must be rejected without
  // ever invoking fn() — that invariant is what half-open exists to protect.
  let probesExecuted = 0;
  const attempt = () =>
    breaker.call(async () => {
      probesExecuted++;
      return 'ok';
    });
  const results = await Promise.allSettled([attempt(), attempt()]);
  const fulfilled = results.filter((r) => r.status === 'fulfilled').length;
  if (probesExecuted !== 1) throw new Error(`expected exactly one probe to execute, got ${probesExecuted}`);
  if (fulfilled !== 1) throw new Error(`expected exactly one call to succeed, got ${fulfilled}`);
}

export async function runAllScenarios(): Promise<void> {
  const scenarios = [
    scenarioAcquireReleaseCycle,
    scenarioQueuedWaiterWins,
    scenarioAcquireTimesOut,
    scenarioRetriesThenSucceeds,
    scenarioEvictsIdleBelowMinIdle,
    scenarioDrainRejectsQueuedWaiters,
    scenarioBreakerOpensAfterThreshold,
    scenarioBreakerHalfOpenSingleProbe,
  ];
  for (const scenario of scenarios) {
    await scenario();
  }
}
