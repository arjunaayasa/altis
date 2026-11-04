import { isDomainError, type DomainError } from '@altis/shared';
import { sql, type RawBuilder, type Transaction } from 'kysely';
import { checkText, describe } from './checks.js';
import type { DbHandle } from './connect.js';
import { normalizeDbError } from './db-errors.js';
import { identifier } from './ddl.js';
import type { TableName } from './registry.js';
import type { DB } from './schema.js';
import { assertOutsideTx, withTx } from './tx.js';

// The concurrency primitives of spec §6.3, the same on MySQL/MariaDB, PostgreSQL and SQLite, without RETURNING,
// ON CONFLICT or ON DUPLICATE KEY (global constraints):
//
// - upsert(): UPDATE; when it found no row, INSERT inside SAVEPOINT altis_up; when that INSERT hits a normalized
//   UNIQUE_VIOLATION (another writer inserted the row after our UPDATE), ROLLBACK TO SAVEPOINT altis_up and UPDATE
//   once more. The savepoint keeps the transaction usable on PostgreSQL, which otherwise aborts it on any error.
// - increment(): the same steps with `column = column + 1`, then the value read back in the same transaction.
// - claimLock()/releaseLock(): the named locks of the `locks` table, claimed with the conditional `until < now`.
//
// Each dialect keeps its default isolation (ruling R37). Under MySQL/MariaDB REPEATABLE READ an UPDATE that finds no
// row takes a gap lock, and two transactions that both then INSERT into that gap deadlock (1213): the server rolls
// one back, and withTx runs it again (R37), when the row is there. PostgreSQL makes the second INSERT wait for the
// first transaction and then fail with 23505 (UNIQUE_VIOLATION), which the savepoint absorbs. SQLite serializes
// writers (BEGIN IMMEDIATE), so none of this happens there.
//
// Table and column names are checked as portable identifiers (ddl.ts) before they reach Kysely, and every value is
// bound as a parameter: strings, finite numbers, bigints, Uint8Arrays and null only (no SQL expressions).

/** What {@link upsert} did. */
export type UpsertOutcome = 'inserted' | 'updated';

// Rows built from caller records: the generic Kysely API over any table of DB, after the names were checked.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyTransaction = Transaction<any>;
type SqlValue = string | number | bigint | Uint8Array | null;
type Row = Record<string, SqlValue>;
/** What `UPDATE ... SET` gets: column values, or expressions such as `column + 1`. */
type SetClause = Record<string, SqlValue | RawBuilder<unknown>>;

/** `trx` for the generic Kysely API when it is a transaction; a TypeError otherwise. */
function transaction(trx: unknown, fn: string): AnyTransaction {
  if (typeof trx !== 'object' || trx === null || (trx as { isTransaction?: unknown }).isTransaction !== true) {
    throw new TypeError(`${fn}() runs inside the caller's transaction: pass the trx of withTx(), not a database handle`);
  }
  return trx as AnyTransaction;
}

/** `value` when it can be bound as a parameter; a TypeError otherwise. */
function sqlValue(where: string, column: string, value: unknown): SqlValue {
  if (value === undefined) throw new TypeError(`${where}: column ${column} is undefined (use null for NULL)`);
  if (value === null || typeof value === 'string' || typeof value === 'bigint' || value instanceof Uint8Array) return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${where}: column ${column} must be a finite number, got ${value}`);
    return value;
  }
  if (typeof value === 'boolean') {
    throw new TypeError(`${where}: column ${column} is a boolean; booleans are stored as the numbers 0 and 1 (SMALLINT)`);
  }
  throw new TypeError(
    `${where}: the value of column ${column} must be a string, a finite number, a bigint, a Uint8Array or null ` +
      `(values are always bound as parameters), got ${describe(value)}`,
  );
}

/**
 * The columns of `record` with their values, names checked as identifiers. `key` values (a row's identity) must
 * also be a string, number or bigint: NULL never equals NULL, so a row could never be found by it; a key string must
 * not end in a blank nor hold NUL or a lone surrogate.
 */
function columns(where: string, record: unknown, o: { key?: boolean } = {}): Row {
  if (typeof record !== 'object' || record === null || Array.isArray(record)) {
    throw new TypeError(`${where} must be an object of column values, got ${describe(record)}`);
  }
  const row: Row = {};
  for (const [name, value] of Object.entries(record)) {
    const column = identifier('column', name);
    const v = sqlValue(where, column, value);
    if (o.key === true && (v === null || v instanceof Uint8Array)) {
      const kind = v === null ? 'null' : 'binary';
      throw new TypeError(`${where}: column ${column} is ${kind}; a key value must be a string or a number (NULL never matches)`);
    }
    // A key text must match the same row on every dialect: no trailing blank (MySQL/MariaDB compare with PAD SPACE,
    // R24), no NUL, no lone surrogate. '' is a key like any other (user_roles.scope_key '' = global).
    if (o.key === true && typeof v === 'string') {
      checkText(`${where}: column ${column}`, v, { max: Number.MAX_SAFE_INTEGER, nonEmpty: false, noTrailingBlank: true });
    }
    row[column] = v;
  }
  return row;
}

/** `extra` plus the `key` columns; a TypeError when `extra` gives a key column another value. */
function withKey(fn: string, extra: Row, key: Row): Row {
  for (const [column, value] of Object.entries(key)) {
    if (Object.hasOwn(extra, column) && !Object.is(extra[column], value)) {
      throw new TypeError(`${fn}: insertRow.${column} contradicts the key value given for ${column}`);
    }
  }
  return { ...extra, ...key };
}

/** UPDATE `table` SET `set` WHERE every `key` column equals its value; the number of rows it matched. */
async function updateWhere(trx: AnyTransaction, table: string, set: SetClause, key: Row): Promise<number> {
  // Values and RawBuilder expressions are both what Kysely's set() takes; the DB type is dynamic here.
  let q = trx.updateTable(table).set(set as Row);
  for (const [column, value] of Object.entries(key)) q = q.where(column, '=', value);
  const result = await q.executeTakeFirst();
  // MySQL/MariaDB report matched rows, not only changed ones: mysql2 connects with CLIENT_FOUND_ROWS.
  return Number(result.numUpdatedRows);
}

/**
 * INSERT `row` inside SAVEPOINT altis_up (the one savepoint of the primitives, released before they return): true
 * when it was inserted; when a row with the same unique value is there, the normalized UNIQUE_VIOLATION, after
 * rolling back to the savepoint (the transaction stays usable). Any other error is rethrown as it is: the caller's
 * transaction rolls back (a MySQL/MariaDB deadlock has already rolled it back, savepoint included).
 */
async function insertInSavepoint(trx: AnyTransaction, table: string, row: Row): Promise<true | DomainError> {
  await sql`savepoint altis_up`.execute(trx);
  try {
    await trx.insertInto(table).values(row).execute();
  } catch (error) {
    const normalized = normalizeDbError(error);
    if (!isDomainError(normalized) || normalized.code !== 'UNIQUE_VIOLATION') throw error;
    await sql`rollback to savepoint altis_up`.execute(trx);
    await sql`release savepoint altis_up`.execute(trx);
    return normalized;
  }
  await sql`release savepoint altis_up`.execute(trx);
  return true;
}

/** For each transaction object: the end of the queue of primitives running on it. */
const queues = new WeakMap<object, Promise<void>>();

/**
 * Runs `fn` once every primitive started earlier on the same transaction object has finished (fix round 1, item 7):
 * primitives (upsert, increment, auditAppend) started together on one transaction run one after another, so their
 * statements and savepoints (altis_up, altis_audit) never interleave with each other. It orders only the
 * primitives: a plain statement run on the same transaction at the same time is not queued and can land inside a
 * primitive's savepoint, where a ROLLBACK TO SAVEPOINT undoes it without trace although its promise resolved. So
 * callers never run statements concurrently on one trx: they await them one by one, and start primitives together
 * only with Promise.allSettled (after a Promise.all rejection the callback fails at once while the queued primitives
 * still run). A copy of a transaction made with withPlugin() is another object with a queue of its own.
 * Package-internal (auditAppend uses it too).
 */
export async function exclusive<T>(trx: object, fn: () => Promise<T>): Promise<T> {
  const before = queues.get(trx) ?? Promise.resolve();
  let done!: () => void;
  const mine = new Promise<void>((resolve) => {
    done = resolve;
  });
  queues.set(trx, before.then(() => mine));
  await before;
  try {
    return await fn();
  } finally {
    done();
  }
}

/** A TypeError when an UPDATE meant for the row of `key` matched several rows (the transaction should roll back). */
function oneRow(fn: string, table: string, matched: number): void {
  if (matched > 1) {
    throw new TypeError(`${fn}: the key matches more than one row of ${table} (${matched} rows); it must identify one row`);
  }
}

/**
 * Updates the row of `table` identified by `key` with `updateSet`, or inserts `insertRow` (plus the `key` columns)
 * when there is none, inside the caller's transaction (spec §6.3): UPDATE; when it matched no row, INSERT inside
 * SAVEPOINT altis_up; when that INSERT fails with UNIQUE_VIOLATION (another transaction inserted the row after the
 * UPDATE), ROLLBACK TO SAVEPOINT and UPDATE once more; when even that UPDATE finds no row (the row was deleted in
 * between), the INSERT is tried once more. A row whose values do not change counts as updated.
 *
 * **Await it before the next statement on `trx`** (see withTx: one statement at a time). Primitives started together
 * on one transaction are queued and run one after another ({@link exclusive}), but a plain statement run at the same
 * time is not ordered with them: inside SAVEPOINT altis_up it would be undone without trace by the ROLLBACK TO
 * SAVEPOINT of a colliding INSERT. Start primitives together only with Promise.allSettled.
 *
 * `key` must be a unique key (primary key or UNIQUE) of the table: the INSERT relies on it to collide. Run it in a
 * withTx callback: a deadlock between concurrent upserts (MySQL/MariaDB gap locks) makes withTx run the whole
 * callback again (ruling R37).
 *
 * @returns `'inserted'` or `'updated'`
 * @throws TypeError, before anything is sent, when `trx` is not a transaction, a table or column name is not a
 *   portable identifier, `key` or `updateSet` is empty, a key value is null, a value is not a string, finite
 *   number, bigint, Uint8Array or null (booleans, objects, undefined), or `insertRow` gives a key column another
 *   value, or a key string that ends in a blank or holds NUL or a lone surrogate; also when `key` matches more
 *   than one row. DomainError `UNIQUE_VIOLATION` when the second INSERT collides too (on another unique key: no row
 *   of `key` exists even after it); the transaction stays usable.
 */
export async function upsert(
  trx: Transaction<DB>,
  table: TableName,
  key: Record<string, unknown>,
  insertRow: Record<string, unknown>,
  updateSet: Record<string, unknown>,
): Promise<UpsertOutcome> {
  const t = transaction(trx, 'upsert');
  const name = identifier('table', table);
  const keyRow = columns('upsert key', key, { key: true });
  if (Object.keys(keyRow).length === 0) throw new TypeError('upsert: the key needs at least one column');
  const set = columns('upsert updateSet', updateSet);
  if (Object.keys(set).length === 0) throw new TypeError('upsert: updateSet needs at least one column');
  const row = withKey('upsert', columns('upsert insertRow', insertRow), keyRow);

  return exclusive(t, async () => {
    let matched = await updateWhere(t, name, set, keyRow);
    if (matched === 0) {
      const inserted = await insertInSavepoint(t, name, row);
      if (inserted === true) return 'inserted';
      // The row appeared after our UPDATE: update it once.
      matched = await updateWhere(t, name, set, keyRow);
      if (matched === 0) {
        // No row even now: the row we collided with was deleted in between (PostgreSQL READ COMMITTED), or the INSERT
        // collided on another unique key. Insert once more; a second UNIQUE_VIOLATION is the caller's.
        const again = await insertInSavepoint(t, name, row);
        if (again === true) return 'inserted';
        throw again;
      }
    }
    oneRow('upsert', name, matched);
    return 'updated';
  });
}

/**
 * Adds 1 to `column` of the row of `table` identified by `where`, creating the row when it is absent, inside the
 * caller's transaction (spec §6.3 counter: `column = column + 1`, read after the increment). The steps are those of
 * {@link upsert}: UPDATE; no row → INSERT `insertRow` plus the `where` columns with `column` = 1 inside SAVEPOINT
 * altis_up; UNIQUE_VIOLATION → ROLLBACK TO SAVEPOINT and UPDATE once more (no row even then → the INSERT once more,
 * as in upsert). The value is then read back in the same
 * transaction, so it is this transaction's own increment, whatever other transactions did.
 *
 * `where` must be a unique key of the table. `insertRow` holds the other columns of a new row; it may leave out
 * `column` (or give 1). Await it before the next statement on `trx`, as {@link upsert}.
 *
 * @returns the value of `column` after the increment
 * @throws TypeError, before anything is sent, for the argument problems listed at {@link upsert}, a `column` that
 *   is part of `where`, an `insertRow` value of `column` other than 1; also when `where` matches more than one row
 *   or `column` does not read back as a safe integer
 */
export async function increment(
  trx: Transaction<DB>,
  table: TableName,
  where: Record<string, unknown>,
  column: string,
  insertRow: Record<string, unknown>,
): Promise<number> {
  const t = transaction(trx, 'increment');
  const name = identifier('table', table);
  const counter = identifier('column', column);
  const keyRow = columns('increment where', where, { key: true });
  if (Object.keys(keyRow).length === 0) throw new TypeError('increment: where needs at least one column');
  if (Object.hasOwn(keyRow, counter)) throw new TypeError(`increment: column ${counter} is part of where`);
  const extra = columns('increment insertRow', insertRow);
  if (Object.hasOwn(extra, counter) && extra[counter] !== 1) {
    throw new TypeError(`increment: insertRow.${counter} must be 1 or left out (the new row holds this one increment)`);
  }
  const row = { ...withKey('increment', extra, keyRow), [counter]: 1 };
  // `counter = counter + 1`: the only assignment, so no SET expression reads a column assigned before it.
  const plusOne: SetClause = { [counter]: sql`${sql.ref(counter)} + ${1}` };

  return exclusive(t, async () => {
    let matched = await updateWhere(t, name, plusOne, keyRow);
    if (matched === 0) {
      const inserted = await insertInSavepoint(t, name, row);
      if (inserted !== true) {
        matched = await updateWhere(t, name, plusOne, keyRow);
        if (matched === 0) {
          // The row we collided with is gone again, or the collision was on another key: insert once more.
          const again = await insertInSavepoint(t, name, row);
          if (again !== true) throw again;
        }
      }
    }
    oneRow('increment', name, matched);

    let q = t.selectFrom(name).select(counter);
    for (const [c, value] of Object.entries(keyRow)) q = q.where(c, '=', value);
    const rows = (await q.execute()) as Record<string, unknown>[];
    const value = rows[0]?.[counter];
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
      throw new TypeError(`increment: ${name}.${counter} read back as ${describe(value)}, not a safe integer`);
    }
    return value;
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Named locks

/** Lock names are `locks.name`, a key191() column: binary, at most 191 characters, no trailing blank (R24). */
function lockName(name: unknown): string {
  return checkText('lock name', name, { max: 191, noTrailingBlank: true });
}

/**
 * Owners are `locks.owner`, a key191() column (binary, ruling R48): at most 191 characters, no trailing blank (MySQL
 * and MariaDB compare utf8mb4_bin with PAD SPACE, R24). The holder is also compared in JavaScript, exactly.
 */
function lockOwner(owner: unknown): string {
  return checkText('lock owner', owner, { max: 191, noTrailingBlank: true });
}

/** Options of {@link claimLock}. */
export interface ClaimLockOptions {
  /**
   * Treat a lock whose `until` lies more than `2 × ttlMs` ahead of now as expired (S18): such a row was left by a
   * clock that ran ahead (`clock_anomaly`, spec §10.4), and would otherwise block the lock until the clock catches up.
   * For locks whose holders renew them well within their TTL (`jobs:heavy`, `backup:snapshot`). Default false.
   */
  farFutureIsExpired?: boolean;
}

/**
 * Claims the named lock `name` for `owner` until `Date.now() + ttlMs` (spec §6.3), in a transaction of its own
 * (withTx, so a deadlock between two claimants is retried, R37). It takes the handle, not a transaction: call it
 * outside any withTx callback (ruling R49):
 *
 * 1. the conditional claim: `UPDATE locks SET owner, until WHERE name = :name AND until < :now`, which takes the
 *    lock when it has expired (whoever held it); with `o.farFutureIsExpired` also when `until > :now + 2 × ttlMs`;
 * 2. otherwise the row is read: absent → INSERT inside SAVEPOINT altis_up (a UNIQUE_VIOLATION means another
 *    claimant was first: false); held by `owner` → renewed (`until` = now + ttlMs); held by anyone else → false.
 *
 * `now` is the application's clock (Date.now()), not the database's: every process of an installation shares the
 * host clock or is kept in sync with it. Owners are compared exactly on every dialect: `locks.owner` is binary
 * (R48), owners never end in a blank, and the holder read back is compared in JavaScript. A lock with `until` equal
 * to now is still held.
 *
 * @returns true when `owner` holds the lock now
 * @throws TypeError when called inside a withTx callback (R49); for a `name` or `owner` that is empty, longer than 191 characters, ends in a blank or holds NUL
 *   or lone surrogates, or a `ttlMs` that is not a positive integer (with now + 2 × ttlMs a safe integer);
 *   DomainError `TX_CONFLICT` when the claim kept deadlocking (R37)
 */
export async function claimLock(
  h: DbHandle,
  name: string,
  owner: string,
  ttlMs: number,
  o: ClaimLockOptions = {},
): Promise<boolean> {
  assertOutsideTx('claimLock');
  const lock = lockName(name);
  const who = lockOwner(owner);
  if (typeof ttlMs !== 'number' || !Number.isSafeInteger(ttlMs) || ttlMs <= 0 || !Number.isSafeInteger(Date.now() + 2 * ttlMs)) {
    throw new TypeError(`ttlMs must be a positive integer number of milliseconds, got ${describe(ttlMs)}`);
  }
  const farFuture = o.farFutureIsExpired === true;
  return withTx(h, async (trx) => {
    const now = Date.now();
    const until = now + ttlMs;
    const taken = await trx
      .updateTable('locks')
      .set({ owner: who, until })
      .where('name', '=', lock)
      .where((eb) => (farFuture ? eb.or([eb('until', '<', now), eb('until', '>', now + 2 * ttlMs)]) : eb('until', '<', now)))
      .executeTakeFirst();
    if (Number(taken.numUpdatedRows) > 0) return true;

    const held = await trx.selectFrom('locks').select(['owner', 'until']).where('name', '=', lock).executeTakeFirst();
    if (held === undefined) return (await insertInSavepoint(trx, 'locks', { name: lock, owner: who, until })) === true;
    if (held.owner !== who) return false;
    // Renewed only while the row is still the one read (owner and until unchanged).
    const renewed = await trx
      .updateTable('locks')
      .set({ until })
      .where('name', '=', lock)
      .where('owner', '=', who)
      .where('until', '=', held.until)
      .executeTakeFirst();
    if (Number(renewed.numUpdatedRows) > 0) return true;
    // Changed since our read: on PostgreSQL (READ COMMITTED, where the conditional claim locks no row it does not
    // match) another re-claim by the same owner may have renewed it. Still ours while the owner is and it has not
    // expired. (MySQL/MariaDB hold the row's lock from the conditional claim on, so nothing changes in between.)
    const again = await trx.selectFrom('locks').select(['owner', 'until']).where('name', '=', lock).executeTakeFirst();
    return again !== undefined && again.owner === who && again.until >= now;
  });
}

/**
 * Releases the named lock `name` when `owner` holds it (expired or not): the row is deleted, so the lock is free
 * at once. Anything else (another owner, no such lock) is left as it is. Runs in a transaction of its own, so call
 * it outside any withTx callback (R49); owners are compared exactly, as in {@link claimLock}.
 *
 * @throws TypeError when called inside a withTx callback; for an invalid `name` or `owner` (see {@link claimLock})
 */
export async function releaseLock(h: DbHandle, name: string, owner: string): Promise<void> {
  assertOutsideTx('releaseLock');
  const lock = lockName(name);
  const who = lockOwner(owner);
  await withTx(h, async (trx) => {
    const held = await trx.selectFrom('locks').select(['owner', 'until']).where('name', '=', lock).executeTakeFirst();
    if (held === undefined || held.owner !== who) return;
    // Deleted only while the row is still the one read: a lock taken over in between stays with its new owner.
    await trx
      .deleteFrom('locks')
      .where('name', '=', lock)
      .where('owner', '=', who)
      .where('until', '=', held.until)
      .execute();
  });
}
