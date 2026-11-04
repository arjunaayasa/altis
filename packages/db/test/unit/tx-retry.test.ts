import { DomainError, isDomainError } from '@altis/shared';
import type { Transaction } from 'kysely';
import { describe, expect, it } from 'vitest';
import { verifyAuditChain } from '../../src/audit.js';
import { claimLock, releaseLock } from '../../src/concurrency.js';
import type { DbHandle } from '../../src/connect.js';
import { normalizeDbError } from '../../src/db-errors.js';
import type { DB } from '../../src/schema.js';
import { withTx } from '../../src/tx.js';

// withTx's retry of a whole transaction that lost a deadlock or a serialization failure (rulings R37, R37b, R37c)
// and its nesting rules (R49), over fake handles: no server needed, so this runs in `pnpm test`. tx.test.ts shows
// the same against real servers.

type FakeHandle = DbHandle & { begun: number };

/** A handle whose transaction().execute(fn) just calls fn, as Kysely does between BEGIN and COMMIT/ROLLBACK. */
function fakeHandle(dialect: DbHandle['dialect'] = 'mysql'): FakeHandle {
  const trx = { isTransaction: true } as unknown as Transaction<DB>;
  const handle = {
    begun: 0,
    dialect,
    db: {
      transaction: () => ({
        execute: async <T>(fn: (t: Transaction<DB>) => Promise<T>): Promise<T> => {
          handle.begun += 1;
          return fn(trx);
        },
      }),
    },
  };
  return handle as unknown as FakeHandle;
}

/** A handle whose database throws on any use: proves that a refusal happens before the database is touched. */
function untouchableHandle(): DbHandle {
  return {
    dialect: 'postgres',
    db: new Proxy(
      {},
      {
        get() {
          throw new Error('the database was touched');
        },
      },
    ),
  } as unknown as DbHandle;
}

function mysqlError(code: string, errno: number, sqlState: string, text: string): Error {
  return Object.assign(new Error(text), { code, errno, sqlState, sqlMessage: text, fatal: false });
}

function mysqlDeadlock(): Error {
  return mysqlError('ER_LOCK_DEADLOCK', 1213, '40001', 'Deadlock found when trying to get lock; try restarting transaction');
}

/** MariaDB with innodb_snapshot_isolation=ON (the default from 11.6): a locking read of a row changed since the read view. */
function mariadbCheckread(): Error {
  return mysqlError('ER_CHECKREAD', 1020, 'HY000', "Record has changed since last read in table 'audit_head'");
}

function pgError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code, severity: 'ERROR', detail: 'Process 7 waits for ShareLock' });
}

/** What the driver layer hands the callback for a raw driver error (statements report normalized errors). */
const normalized = (raw: Error) => normalizeDbError(raw) as DomainError;

/** Runs withTx with a callback that always throws `conflict()`; how many runs, what was thrown, the gaps in ms. */
async function exhaust(h: DbHandle, conflict: () => unknown) {
  const starts: number[] = [];
  const error = await withTx(h, async () => {
    starts.push(performance.now());
    throw conflict();
  }).catch((e: unknown) => e);
  const gaps = starts.slice(1).map((t, i) => t - starts[i]!);
  return { runs: starts.length, error, gaps };
}

describe('withTx: retry on deadlock / serialization failure (rulings R37, R37b, R37c)', () => {
  it.each([
    ['MySQL/MariaDB 1213 (normalized by the driver layer)', 'mysql', () => normalized(mysqlDeadlock())],
    ['MariaDB 1020 ER_CHECKREAD (normalized by the driver layer)', 'mariadb', () => normalized(mariadbCheckread())],
    ['PostgreSQL 40P01 (normalized by the driver layer)', 'postgres', () => normalized(pgError('40P01', 'deadlock detected'))],
    ['PostgreSQL 40001 (normalized by the driver layer)', 'postgres', () => normalized(pgError('40001', 'could not serialize'))],
    ['a raw MySQL 1213 driver error', 'mysql', () => mysqlDeadlock()],
    ['a raw MariaDB 1020 driver error', 'mariadb', () => mariadbCheckread()],
    ['a raw PostgreSQL 40P01 driver error', 'postgres', () => pgError('40P01', 'deadlock detected')],
  ] as const)('runs the whole callback again after %s and returns its result', async (_name, dialect, conflict) => {
    const h = fakeHandle(dialect);
    let runs = 0;
    const result = await withTx(h, async () => {
      runs += 1;
      if (runs === 1) throw conflict();
      return 'done';
    });
    expect(result).toBe('done');
    expect(runs).toBe(2);
    expect(h.begun).toBe(2); // a fresh transaction for each attempt
  });

  it.each([
    ['mysql', 5],
    ['mariadb', 5],
    ['postgres', 3],
  ] as const)('%s: gives up after %i attempts with TX_CONFLICT (409), meta {attempts, code} and a safe cause', async (dialect, attempts) => {
    const conflict = dialect === 'postgres' ? () => normalized(pgError('40P01', 'deadlock detected')) : () => normalized(mysqlDeadlock());
    const { runs, error } = await exhaust(fakeHandle(dialect), conflict);
    expect(runs).toBe(attempts);
    expect(isDomainError(error)).toBe(true);
    const e = error as DomainError;
    expect(e.code).toBe('TX_CONFLICT');
    expect(e.status).toBe(409);
    const code = dialect === 'postgres' ? '40P01' : 'ER_LOCK_DEADLOCK';
    expect(e.meta).toEqual({ attempts, code });
    // Only the driver's codes, never its message (lock and transaction details).
    expect(e.cause).toEqual(dialect === 'postgres' ? { code } : { code, errno: 1213, sqlState: '40001' });
    expect(e.message).not.toMatch(/Deadlock found|deadlock detected/);
    expect(e.message).toContain(String(attempts));
  });

  it('MariaDB: ER_CHECKREAD on every attempt ends in TX_CONFLICT with code ER_CHECKREAD after 5 attempts', async () => {
    const { runs, error } = await exhaust(fakeHandle('mariadb'), () => mariadbCheckread());
    expect(runs).toBe(5);
    expect(error).toMatchObject({ code: 'TX_CONFLICT', meta: { attempts: 5, code: 'ER_CHECKREAD' } });
    expect((error as DomainError).cause).toEqual({ code: 'ER_CHECKREAD', errno: 1020, sqlState: 'HY000' });
  });

  it('keeps the last code when the conflicts differ', async () => {
    const codes = ['40P01', '40001', '40001'];
    let i = 0;
    const { error } = await exhaust(fakeHandle('postgres'), () => pgError(codes[i++] ?? '40001', 'conflict'));
    expect(error).toMatchObject({ code: 'TX_CONFLICT', meta: { attempts: 3, code: '40001' } });
    expect((error as DomainError).cause).toEqual({ code: '40001' });
  });

  it('waits an exponentially growing, jittered time between attempts: 10-20, 20-40, 40-80, 80-160 ms', async () => {
    const { gaps } = await exhaust(fakeHandle('mysql'), () => normalized(mysqlDeadlock()));
    expect(gaps).toHaveLength(4);
    const floors = [10, 20, 40, 80];
    gaps.forEach((gap, n) => {
      expect(gap).toBeGreaterThanOrEqual(floors[n]! - 1); // timer granularity
      expect(gap).toBeLessThan(1000); // never above the 200 ms cap by design; generous for a loaded CI machine
    });
  });

  it.each([
    ['UNIQUE_VIOLATION', () => new DomainError('UNIQUE_VIOLATION', { meta: { constraint: 'x' } })],
    [
      'DB_UNAVAILABLE connection_lost',
      () => new DomainError('DB_UNAVAILABLE', { meta: { reason: 'connection_lost', code: 'ECONNRESET', retryable: true } }),
    ],
    ['DB_UNAVAILABLE busy (SQLite)', () => new DomainError('DB_UNAVAILABLE', { meta: { reason: 'busy', retryable: true } })],
    ['a plain Error', () => new Error('boom')],
    ['a TypeError', () => new TypeError('bad argument')],
  ])('never runs the callback again for %s', async (_name, make) => {
    const h = fakeHandle();
    const thrown = make();
    let runs = 0;
    const error = await withTx(h, async () => {
      runs += 1;
      throw thrown;
    }).catch((e: unknown) => e);
    expect(runs).toBe(1);
    expect(error).toBe(thrown);
  });

  it('never runs the callback again for a raw lock wait timeout (1205); the error is normalized as before', async () => {
    const h = fakeHandle();
    const raw = mysqlError('ER_LOCK_WAIT_TIMEOUT', 1205, 'HY000', 'Lock wait timeout exceeded');
    let runs = 0;
    const error = await withTx(h, async () => {
      runs += 1;
      throw raw;
    }).catch((e: unknown) => e);
    expect(runs).toBe(1);
    expect(error).toBe(raw); // normalizeDbError has no mapping for it
  });

  it('{retry: false} runs the callback once and reports the conflict as TX_CONFLICT with attempts 1', async () => {
    const h = fakeHandle('postgres');
    let runs = 0;
    const error = await withTx(
      h,
      async () => {
        runs += 1;
        throw normalized(pgError('40P01', 'deadlock detected'));
      },
      { retry: false },
    ).catch((e: unknown) => e);
    expect(runs).toBe(1);
    expect(error).toMatchObject({ code: 'TX_CONFLICT', meta: { attempts: 1, code: '40P01' } });
  });

  it('transactions started side by side are not nested: each retries on its own', async () => {
    const h = fakeHandle();
    const runs = [0, 0];
    const results = await Promise.all(
      [0, 1].map((i) =>
        withTx(h, async () => {
          runs[i] = (runs[i] ?? 0) + 1;
          if (runs[i] === 1) throw normalized(mysqlDeadlock());
          return i;
        }),
      ),
    );
    expect(results).toEqual([0, 1]);
    expect(runs).toEqual([2, 2]);
  });
});

describe('withTx: nested use (ruling R49)', () => {
  it.each(['mysql', 'mariadb', 'postgres', 'sqlite'] as const)(
    '%s: a withTx nested on the same handle is refused at once (TypeError), the inner callback never runs',
    async (dialect) => {
      const h = fakeHandle(dialect);
      let innerRuns = 0;
      const error = await withTx(h, async () =>
        withTx(h, async () => {
          innerRuns += 1;
        }),
      ).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(TypeError);
      expect((error as TypeError).message).toMatch(/outer trx/);
      expect(innerRuns).toBe(0);
      expect(h.begun).toBe(1); // the outer one only, and it was not retried
    },
  );

  it('on another handle the inner withTx is never retried; the outer one runs its whole callback again', async () => {
    const h = fakeHandle('mysql');
    const other = fakeHandle('mysql');
    let outerRuns = 0;
    let innerRuns = 0;
    const error = await withTx(h, async () => {
      outerRuns += 1;
      await withTx(other, async () => {
        innerRuns += 1;
        throw normalized(mysqlDeadlock());
      });
    }).catch((e: unknown) => e);
    // Each outer attempt ran the inner callback exactly once.
    expect(outerRuns).toBe(5);
    expect(innerRuns).toBe(5);
    expect(error).toMatchObject({ code: 'TX_CONFLICT', meta: { attempts: 5, code: 'ER_LOCK_DEADLOCK' } });
  });

  it('on another handle the inner conflict is reported with attempts 1 when the outer callback catches it', async () => {
    const h = fakeHandle();
    const other = fakeHandle();
    let innerRuns = 0;
    const seen = await withTx(h, async () =>
      withTx(other, async () => {
        innerRuns += 1;
        throw normalized(mysqlDeadlock());
      }).catch((e: unknown) => e),
    );
    expect(innerRuns).toBe(1);
    expect(seen).toMatchObject({ code: 'TX_CONFLICT', meta: { attempts: 1 } });
  });

  it('after a nested withTx returned, a top-level withTx is retried as usual', async () => {
    const h = fakeHandle();
    await withTx(h, async () => withTx(fakeHandle(), async () => 'inner'));
    let runs = 0;
    await withTx(h, async () => {
      runs += 1;
      if (runs === 1) throw normalized(mysqlDeadlock());
    });
    expect(runs).toBe(2);
  });

  it('work started un-awaited inside a callback counts as nested while the outer withTx is open', async () => {
    const h = fakeHandle('postgres');
    const other = fakeHandle('postgres');
    let started!: Promise<unknown>;
    let otherRuns = 0;
    let sameHandle!: Promise<unknown>;
    await withTx(h, async () => {
      // Not awaited: still inside the scope of the outer withTx while it runs.
      started = withTx(other, async () => {
        otherRuns += 1;
        throw normalized(pgError('40P01', 'deadlock detected'));
      }).catch((e: unknown) => e);
      sameHandle = withTx(h, async () => 'never').catch((e: unknown) => e);
    });
    expect(await started).toMatchObject({ code: 'TX_CONFLICT', meta: { attempts: 1 } });
    expect(otherRuns).toBe(1);
    expect(await sameHandle).toBeInstanceOf(TypeError);
  });

  it('a withTx scheduled inside a callback but started after the outer one ended is not nested', async () => {
    const h = fakeHandle('sqlite');
    let outerDone!: () => void;
    const outerEnded = new Promise<void>((resolve) => {
      outerDone = resolve;
    });
    let detached!: Promise<unknown>;
    await withTx(h, async () => {
      // Scheduled here (it keeps this async context), run only after the outer transaction has ended.
      detached = outerEnded.then(() => {
        let runs = 0;
        return withTx(h, async () => {
          runs += 1;
          if (runs === 1) throw normalized(mysqlDeadlock());
          return runs;
        });
      });
    });
    outerDone();
    // Neither refused (same handle) nor deprived of its retry.
    expect(await detached).toBe(2);
  });

  it.each([
    ['claimLock', () => claimLock(untouchableHandle(), 'job', 'owner', 1000)],
    ['releaseLock', () => releaseLock(untouchableHandle(), 'job', 'owner')],
    ['verifyAuditChain', () => verifyAuditChain(untouchableHandle())],
  ])('%s opens its own transaction or statements: refused inside any withTx callback, before the database is touched', async (_name, call) => {
    const error = await withTx(fakeHandle(), async () => call().catch((e: unknown) => e));
    expect(error).toBeInstanceOf(TypeError);
    expect((error as TypeError).message).toMatch(/outside any withTx/);
  });
});
