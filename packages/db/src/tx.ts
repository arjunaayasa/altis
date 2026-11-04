import { AsyncLocalStorage } from 'node:async_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { DomainError, isDomainError } from '@altis/shared';
import type { Transaction } from 'kysely';
import type { DbHandle } from './connect.js';
import { isDriverError, normalizeDbError } from './db-errors.js';
import type { DB } from './schema.js';

/**
 * Attempts in all, the first one included, before a conflict is given up as TX_CONFLICT (ruling R37b): MySQL and
 * MariaDB deadlock far more often under REPEATABLE READ (gap locks of UPDATEs that find no row) than PostgreSQL.
 * SQLite never reports a conflict (BEGIN IMMEDIATE serializes writers).
 */
const MAX_ATTEMPTS: Readonly<Record<DbHandle['dialect'], number>> = { mysql: 5, mariadb: 5, postgres: 3, sqlite: 3 };
/** Backoff before retry n (n = 0 for the first): 10 ms × 2^n plus up to as much again in jitter, at most 200 ms. */
const BACKOFF_BASE_MS = 10;
const BACKOFF_CAP_MS = 200;

function backoffMs(retry: number): number {
  const base = BACKOFF_BASE_MS * 2 ** retry;
  return Math.min(BACKOFF_CAP_MS, base * (1 + Math.random()));
}

/**
 * One withTx call, seen from the callbacks it runs: its database (`h.db`), the withTx it was started in, and whether
 * it is still running. A promise the callback leaves running keeps this context after the call has ended, hence
 * `open`: only open scopes make a withTx nested.
 */
interface TxScope {
  readonly db: unknown;
  readonly outer: TxScope | undefined;
  open: boolean;
}

const insideTx = new AsyncLocalStorage<TxScope>();

/** The scopes of `scope` and its outer ones that are still running. */
function* openScopes(scope: TxScope | undefined): Generator<TxScope> {
  for (let s = scope; s !== undefined; s = s.outer) if (s.open) yield s;
}

/** Why a function refuses to run inside a transaction, when the caller names no other reason. */
const OWN_TRANSACTION =
  'runs its own transaction: call it outside any withTx callback, not inside one (it would need a second connection ' +
  'and could wait for locks the outer transaction holds)';

/**
 * A TypeError `<what>() <why>` when called inside a running withTx callback (or from work started there, awaited or
 * not, while that withTx is still running). For the functions that open their own transaction or run their own
 * statements on a handle (claimLock, releaseLock, verifyAuditChain, the remember-me use, the sweep; ruling R49):
 * inside a callback they would need a second connection — waiting forever when the pool has none free, on SQLite
 * always — and could wait for row locks the outer transaction holds. Also for slow work that must not hold a
 * transaction open (the password hasher, S18), with its own `why`.
 */
export function assertOutsideTx(what: string, why: string = OWN_TRANSACTION): void {
  if (openScopes(insideTx.getStore()).next().done !== true) throw new TypeError(`${what}() ${why}`);
}

export interface WithTxOptions {
  /**
   * Whether a transaction that lost a deadlock or serialization failure is run again (default true). Pass false
   * for a callback that cannot be run twice; the conflict is then thrown at once as TX_CONFLICT (`attempts: 1`).
   */
  retry?: boolean;
}

/** True for a normalized error saying the server rolled the transaction back after a conflict. */
function isTxConflict(error: unknown): error is DomainError {
  return isDomainError(error) && error.code === 'TX_CONFLICT';
}

/** The TX_CONFLICT withTx throws when it gives up after `attempts`; the cause stays the driver's safe codes. */
function gaveUp(last: DomainError, attempts: number): DomainError {
  const code = typeof last.meta?.['code'] === 'string' ? last.meta['code'] : 'unknown';
  return new DomainError('TX_CONFLICT', {
    detail:
      `Transaksi terus bentrok dengan transaksi lain setelah ${attempts} percobaan; coba lagi nanti (${code}) / ` +
      `The transaction kept conflicting with other transactions after ${attempts} attempt(s); try again later (${code})`,
    meta: { attempts, code },
    cause: last.cause,
  });
}

/**
 * Runs `fn` in a transaction: committed when `fn` resolves, rolled back when it throws. On SQLite the
 * transaction starts with `BEGIN IMMEDIATE` (the dialect's driver does that, P20), so a writer waits for the lock
 * up to busy_timeout at the start instead of failing halfway.
 *
 * **Conflicts are retried (rulings R37, R37b, R37c).** Each dialect keeps its default isolation level
 * (MySQL/MariaDB REPEATABLE READ, PostgreSQL READ COMMITTED), under which concurrent transactions can deadlock
 * (InnoDB gap locks of an UPDATE that found no row, then an INSERT; rows locked in opposite orders). When the server
 * rolls the transaction back for that — MySQL/MariaDB 1213 ER_LOCK_DEADLOCK, MariaDB 1020 ER_CHECKREAD
 * (innodb_snapshot_isolation=ON, the default from MariaDB 11.6), PostgreSQL 40P01 deadlock_detected or 40001
 * serialization_failure, normalized to `TX_CONFLICT` by the driver layer — the WHOLE callback is run again in a
 * fresh transaction: at most 5 attempts in all on MySQL/MariaDB, 3 on PostgreSQL, waiting 10 ms × 2^n plus up to as
 * much again in jitter (at most 200 ms) before retry n. After the last one withTx throws DomainError `TX_CONFLICT`
 * (409) with `meta: {attempts, code}` (code: the driver's code of the last conflict) and the driver's safe codes as
 * `cause`. A conflict is final for its transaction even when the callback catches it: the driver layer then
 * refuses every later statement and the COMMIT with the same error, so nothing after it is committed and the
 * callback is run again. Nothing else is ever retried: not a lock wait timeout, not a lost connection (P17: whether
 * a write landed is unknown), not SQLite's `busy` (BEGIN IMMEDIATE and busy_timeout already serialize writers).
 *
 * So **`fn` must be re-runnable**: no side effects outside the transaction (no HTTP calls, files, e-mails or
 * in-memory state that a second run would duplicate). Pass `{retry: false}` for a callback that cannot be run
 * twice.
 *
 * **One statement at a time.** A transaction is one connection: never run statements concurrently on `trx`; await
 * each statement, upsert/increment and auditAppend before starting the next. The primitives queue among themselves
 * (concurrency.ts `exclusive`), but a plain statement is not ordered with them: run alongside one, it can execute
 * inside the primitive's SAVEPOINT (altis_up, altis_audit) and be undone without trace by its ROLLBACK TO SAVEPOINT,
 * although its own promise resolved. When primitives are started together, use Promise.allSettled, not
 * Promise.all: after a Promise.all rejection the callback fails at once (and withTx rolls back or retries) while
 * the primitives already queued still run on that transaction.
 *
 * **Nested use (ruling R49).** Inside a running withTx callback — including work the callback starts without
 * awaiting it, for as long as the outer withTx is running — a withTx on the same database (`h.db`) is refused with a
 * TypeError: it would be a second transaction on a second connection, waiting forever when the pool has no free
 * connection (SQLite: always) and deadlocking unseen on any row the outer transaction holds. Pass the outer `trx`
 * down instead. A withTx on another handle is allowed but never retried on its own: its conflict is thrown at once
 * (`attempts: 1`), so that the outermost withTx, which owns the whole unit of work, rolls back and runs everything
 * again. Work meant to run detached must be started outside the callback (after withTx has returned).
 *
 * Statements already report normalized errors (the driver layer runs {@link normalizeDbError}). Of what `fn`
 * throws, only driver errors ({@link isDriverError}: errors that carry a driver code, `errno` or `sqlState`) are
 * normalized here; anything else, including the callback's own errors that merely look like network or pg client
 * errors, is rethrown unchanged.
 *
 * @throws TypeError for a withTx nested on the same database (see above)
 */
export async function withTx<T>(
  h: DbHandle,
  fn: (trx: Transaction<DB>) => Promise<T>,
  opts: WithTxOptions = {},
): Promise<T> {
  const outer = [...openScopes(insideTx.getStore())];
  if (outer.some((s) => s.db === h.db)) {
    throw new TypeError(
      'withTx() inside a withTx() callback on the same database would open a second transaction on a second ' +
        'connection (waiting forever for a free one, or for locks the outer transaction holds): pass the outer trx down',
    );
  }
  const maxAttempts = outer.length > 0 || opts.retry === false ? 1 : (MAX_ATTEMPTS[h.dialect] ?? 3);
  const scope: TxScope = { db: h.db, outer: insideTx.getStore(), open: true };
  try {
    for (let attempt = 1; ; attempt += 1) {
      let failure: unknown;
      try {
        return await insideTx.run(scope, () => h.db.transaction().execute(fn));
      } catch (error) {
        failure = isDriverError(error) ? normalizeDbError(error) : error;
      }
      if (!isTxConflict(failure)) throw failure;
      if (attempt >= maxAttempts) throw gaveUp(failure, attempt);
      await sleep(backoffMs(attempt - 1));
    }
  } finally {
    scope.open = false;
  }
}
