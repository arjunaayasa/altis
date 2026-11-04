import { assertOutsideTx, withTx, type DbHandle } from '@altis/db';

// The sweep of expired volatile rows (D19). 1b swept opportunistically, once per 10 minutes per process after a
// request; 1c Task 18 replaced that sweeper with the scheduled job `housekeeping.volatile` (housekeeping/volatile.ts),
// which runs this sweep every 10 minutes in whatever runner mode the installation has.
//
// Each table is swept in a short transaction of its own, so a sweep never holds the connection (SQLite's only one)
// for long, and a failure leaves the tables already swept swept.

const HOUR = 3_600_000;

/** Rate-limit windows older than this are deleted: the longest window is 24 h, and the estimate reads one back. */
const RATE_LIMITS_KEEP_MS = 48 * HOUR;
/** Idempotency keys are kept 24 h (spec §7.9). */
const IDEMPOTENCY_KEEP_MS = 24 * HOUR;

/** Rows deleted per table by one {@link sweepVolatile}. */
export interface SweepResult {
  deleted: Record<string, number>;
}

/**
 * Deletes the expired rows of the volatile tables as of `now` (epoch ms), each table in a transaction of its own:
 *
 * - `rate_limits` with `window_start < now − 48 h`;
 * - `sessions`, `remember_tokens` and `password_resets` with `expires_at < now`;
 * - `idempotency_keys` with `created_at < now − 24 h`.
 *
 * Call it outside any withTx callback (it opens its own transactions, R49): inside one it throws a TypeError
 * (assertOutsideTx) before deleting anything.
 *
 * @returns the number of rows deleted per table
 */
export async function sweepVolatile(h: DbHandle, now: number): Promise<SweepResult> {
  assertOutsideTx('sweepVolatile');
  if (typeof now !== 'number' || !Number.isSafeInteger(now)) {
    throw new TypeError(`sweepVolatile: now must be an integer of epoch milliseconds, got ${String(now)}`);
  }
  const deleted: Record<string, number> = {};
  const count = (r: { numDeletedRows: bigint }): number => Number(r.numDeletedRows);

  deleted['rate_limits'] = await withTx(h, async (trx) =>
    count(await trx.deleteFrom('rate_limits').where('window_start', '<', now - RATE_LIMITS_KEEP_MS).executeTakeFirst()),
  );
  deleted['sessions'] = await withTx(h, async (trx) =>
    count(await trx.deleteFrom('sessions').where('expires_at', '<', now).executeTakeFirst()),
  );
  deleted['remember_tokens'] = await withTx(h, async (trx) =>
    count(await trx.deleteFrom('remember_tokens').where('expires_at', '<', now).executeTakeFirst()),
  );
  deleted['password_resets'] = await withTx(h, async (trx) =>
    count(await trx.deleteFrom('password_resets').where('expires_at', '<', now).executeTakeFirst()),
  );
  deleted['idempotency_keys'] = await withTx(h, async (trx) =>
    count(await trx.deleteFrom('idempotency_keys').where('created_at', '<', now - IDEMPOTENCY_KEEP_MS).executeTakeFirst()),
  );
  return { deleted };
}
