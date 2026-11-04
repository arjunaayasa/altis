import { sql, type Kysely, type RawBuilder, type Transaction } from 'kysely';
import { describe } from './checks.js';
import { TABLE_COLUMNS, TABLE_KEYS, type ColumnSpec } from './columns.js';
import { DIALECTS, type DbHandle, type Dialect } from './connect.js';
import { identifier } from './ddl.js';
import type { TableName } from './registry.js';
import type { DB } from './schema.js';
import { assertOutsideTx } from './tx.js';

// Large reads (spec P20, L31). Kysely's .stream() needs pg-cursor, which is not wired in (and is forbidden by lint):
// tables are read in keyset batches in primary-key order instead, each batch one short statement, so memory stays
// bounded and SQLite yields between batches. readSnapshot gives a backup one consistent view of a server database
// across many such batches (P17); a SQLite backup copies the file instead (sqlite-file.ts).
//
// readPkBatch is a registered raw-SQL helper (spec §7.4): the statement is built with Kysely's `sql` tag from
// identifiers of the code's column registry (sql.ref / sql.table, quoted per dialect), never from caller text, and
// every value is bound as a parameter. readKeyedBatch (1d) is the same statement for a table the catalog describes
// (the generic exporter): its names are checked identifiers, quoted the same way.

/** A primary key value: text keys are strings, integer keys safe integers. */
export type PkValue = string | number;

/** The most rows one batch may read. */
const MAX_LIMIT = 100_000;

/** Kinds stored as text: compared in byte order below. */
const TEXT_KINDS: ReadonlySet<ColumnSpec['kind']> = new Set(['id', 'ulid', 'char', 'varchar', 'key191', 'date', 'text', 'json']);
/** Text kinds that are binary (utf8mb4_bin) on MySQL/MariaDB already (ruling R17). */
const MYSQL_BINARY_KINDS: ReadonlySet<ColumnSpec['kind']> = new Set(['id', 'ulid', 'char', 'key191']);

/**
 * A key column as the ORDER BY and the keyset comparison use it, in byte order on every dialect: PostgreSQL text
 * keys `COLLATE "C"` (the database's default collation may be linguistic, such as en_US.UTF-8), which is also the
 * key columns' own collation since migration 0009 (R1c-15), so their primary key index serves the batch;
 * MySQL/MariaDB key columns are utf8mb4_bin already (another text kind would get `COLLATE utf8mb4_bin`; no key has
 * one today); SQLite compares with BINARY.
 */
function keyRef(c: ColumnSpec, dialect: Dialect): RawBuilder<unknown> {
  if (!TEXT_KINDS.has(c.kind)) return sql.ref(c.name);
  if (dialect === 'postgres') return sql`${sql.ref(c.name)} collate "C"`;
  if ((dialect === 'mysql' || dialect === 'mariadb') && !MYSQL_BINARY_KINDS.has(c.kind)) {
    return sql`${sql.ref(c.name)} collate utf8mb4_bin`;
  }
  return sql.ref(c.name);
}

/**
 * `keys > after` in key order, in a form the dialect serves from the primary key index as one range: a row value
 * `(a, b) > (?, ?)` on PostgreSQL and SQLite; on MySQL/MariaDB, which only scan the whole index for a row value
 * (filtering every row before the cursor), its expansion `a > ? or (a = ? and b > ?) or ...`, one range per term.
 */
function keysAfter(keys: readonly RawBuilder<unknown>[], after: readonly PkValue[], dialect: Dialect): RawBuilder<unknown> {
  if (keys.length === 1) return sql`${keys[0]} > ${after[0]}`;
  if (dialect !== 'mysql' && dialect !== 'mariadb') return sql`(${sql.join(keys)}) > (${sql.join(after)})`;
  const terms = keys.map((key, i) => {
    const equal = keys.slice(0, i).map((k, j) => sql`${k} = ${after[j]}`);
    return sql`(${sql.join([...equal, sql`${key} > ${after[i]}`], sql` and `)})`;
  });
  return sql`(${sql.join(terms, sql` or `)})`;
}

/** `after`'s values when each fits its key column (a string for a text key, a safe integer otherwise). */
function checkAfter(fn: string, table: string, keyColumns: readonly ColumnSpec[], after: unknown): PkValue[] | null {
  if (after === null) return null;
  if (!Array.isArray(after) || after.length !== keyColumns.length) {
    throw new TypeError(`${fn}(): after must be null or the ${keyColumns.length} primary key value(s) of the last row of ${table}`);
  }
  return keyColumns.map((c, i) => {
    const value: unknown = after[i];
    const ok = TEXT_KINDS.has(c.kind) ? typeof value === 'string' : typeof value === 'number' && Number.isSafeInteger(value);
    if (!ok) {
      throw new TypeError(
        `${fn}(): after[${i}] (${table}.${c.name}) must be ${TEXT_KINDS.has(c.kind) ? 'a string' : 'a safe integer'}, ` +
          `got ${describe(value)}`,
      );
    }
    return value as PkValue;
  });
}

/**
 * One batch of `table`, whose columns are `all` and whose primary key is `pk` (see {@link readPkBatch}); `fn` names the
 * caller in errors.
 */
async function readBatch(
  fn: string,
  db: Kysely<DB> | Transaction<DB>,
  dialect: Dialect,
  table: string,
  t: { all: readonly ColumnSpec[]; pk: readonly string[] },
  o: { after: PkValue[] | null; limit: number; columns?: readonly string[] },
): Promise<Record<string, unknown>[]> {
  const { limit } = o;
  if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new TypeError(`${fn}(): limit must be an integer from 1 to ${MAX_LIMIT}, got ${describe(limit)}`);
  }
  const byName = new Map(t.all.map((c) => [c.name, c]));
  const columns = o.columns ?? t.all.map((c) => c.name);
  for (const name of columns) {
    if (!byName.has(name)) throw new TypeError(`${fn}(): ${JSON.stringify(name)} is not a column of ${table}`);
  }
  if (new Set(columns).size !== columns.length) throw new TypeError(`${fn}(): columns of ${table} repeat a column`);
  if (t.pk.length === 0) throw new TypeError(`${fn}(): ${table} has no primary key to read it in key order`);
  const keyColumns = t.pk.map((name) => {
    const c = byName.get(name);
    if (c === undefined) throw new TypeError(`${fn}(): the key column ${table}.${name} is not a column of ${table}`);
    return c;
  });
  for (const k of keyColumns) {
    if (!columns.includes(k.name)) throw new TypeError(`${fn}(): columns must include the key column ${table}.${k.name}`);
  }
  const after = checkAfter(fn, table, keyColumns, o.after);

  const keys = keyColumns.map((c) => keyRef(c, dialect));
  const where = after === null ? sql`` : sql` where ${keysAfter(keys, after, dialect)}`;
  const order = sql.join(keys.map((k) => sql`${k} asc`));
  const { rows } = await sql<Record<string, unknown>>`select ${sql.join(columns.map((c) => sql.ref(c)))}
    from ${sql.table(table)}${where} order by ${order} limit ${limit}`.execute(db);
  return rows;
}

/**
 * The next batch of rows of `table` in primary-key order: at most `limit` rows whose key is greater than `after`
 * (the key values of the last row read, or null for the first batch). Read the table to the end by passing the
 * last row's key each time until a batch has fewer than `limit` rows.
 *
 * The order is byte order on every dialect (code-point order: UTF-8 bytes sort like code points), whatever the
 * database's collation: PostgreSQL text keys are compared `COLLATE "C"`, MySQL/MariaDB key columns are utf8mb4_bin,
 * SQLite uses BINARY. A composite key is compared as a row value, `(a, b) > (?, ?)` (on MySQL/MariaDB as its
 * expansion `a > ? or (a = ? and b > ?)`, which their range optimizer can serve). Integer keys compare as numbers.
 * Each batch is a range scan of the primary key index, never a sort of the rest of the table.
 * Keys are stored trimmed (R24), so MySQL/MariaDB's PAD SPACE changes nothing.
 *
 * `columns` (default: every column of TABLE_COLUMNS, in registry order) must include the primary key columns; each
 * row holds exactly these columns. The statement runs on `db`, a handle or a transaction (a snapshot of
 * {@link readSnapshot}, for a consistent read across batches). Never `.stream()` (L31).
 *
 * @throws TypeError, before anything is sent, for an unknown dialect, a table outside TABLE_COLUMNS, a `limit` that
 *   is not an integer from 1 to 100 000, an unknown or repeated column, `columns` without a key column, or an
 *   `after` that does not fit the key
 */
export async function readPkBatch(
  db: Kysely<DB> | Transaction<DB>,
  dialect: Dialect,
  table: TableName,
  o: { after: PkValue[] | null; limit: number; columns?: readonly string[] },
): Promise<Record<string, unknown>[]> {
  if (!(DIALECTS as readonly unknown[]).includes(dialect)) throw new TypeError(`readPkBatch(): unknown dialect ${JSON.stringify(dialect)}`);
  const all = Object.hasOwn(TABLE_COLUMNS, table) ? TABLE_COLUMNS[table] : undefined;
  if (all === undefined) throw new TypeError(`readPkBatch(): ${JSON.stringify(table)} is not a table of TABLE_COLUMNS`);
  return readBatch('readPkBatch', db, dialect, table, { all, pk: TABLE_KEYS[table].pk }, o);
}

/**
 * {@link readPkBatch} for a table the code's registry may not know (1d's generic exporter, which reads the columns
 * from the database's catalog): `spec.columns` are the table's columns, whose kinds pick each key column's byte-order
 * comparison as in readPkBatch, and `spec.pk` its primary key's columns in key order. `o.columns` defaults to every
 * column of `spec.columns`. The table and column names must be identifiers; they are quoted per dialect (sql.table,
 * sql.ref), and every value is bound.
 *
 * @throws TypeError, before anything is sent, as readPkBatch, and for a name that is not an identifier, a column
 *   `spec.columns` repeats, or a `spec.pk` that is empty or names a column `spec.columns` does not have
 */
export async function readKeyedBatch(
  db: Kysely<DB> | Transaction<DB>,
  dialect: Dialect,
  table: string,
  spec: { columns: readonly ColumnSpec[]; pk: readonly string[] },
  o: { after: PkValue[] | null; limit: number; columns?: readonly string[] },
): Promise<Record<string, unknown>[]> {
  if (!(DIALECTS as readonly unknown[]).includes(dialect)) throw new TypeError(`readKeyedBatch(): unknown dialect ${JSON.stringify(dialect)}`);
  identifier('table', table);
  for (const c of spec.columns) identifier('column', c.name);
  if (new Set(spec.columns.map((c) => c.name)).size !== spec.columns.length) {
    throw new TypeError(`readKeyedBatch(): the columns of ${table} repeat a column`);
  }
  return readBatch('readKeyedBatch', db, dialect, table, { all: spec.columns, pk: spec.pk }, o);
}

/**
 * Runs `fn` inside one read-only, repeatable-read transaction on one connection of `h`, so that every read of `fn`
 * sees the database as it was at the transaction's start, whatever other connections commit meanwhile (a backup of
 * a live database, spec §9.9 `snapshot`):
 *
 * - MySQL/MariaDB: `SET TRANSACTION ISOLATION LEVEL REPEATABLE READ` first, since a host default of READ COMMITTED
 *   would void the snapshot (M32), then `START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY` (the snapshot is
 *   taken at once, not at the first read);
 * - PostgreSQL: `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY`.
 *
 * The transaction is committed when `fn` resolves and rolled back when it rejects (its error comes out as it is). A
 * write inside is refused by the server. `fn` must only read through the `db` it is given: it must not start a
 * transaction of its own (MySQL/MariaDB would commit the snapshot silently) nor use `h.db` (another connection).
 *
 * Meant for a dedicated handle (`connect(cfg, {purpose: 'cli'})`, pool 1; P17): the connection stays checked out
 * for as long as `fn` runs, and such a handle never writes audit entries (L41, connect.ts).
 *
 * @throws TypeError on SQLite (a SQLite snapshot copies the file: sqliteSnapshotTo), and inside a withTx callback
 *   (it would need a second connection, R49)
 */
export async function readSnapshot<T>(h: DbHandle, fn: (db: Kysely<DB>) => Promise<T>): Promise<T> {
  if (h.dialect === 'sqlite') {
    throw new TypeError('readSnapshot(): SQLite has no snapshot transaction for a backup; copy the file with sqliteSnapshotTo()');
  }
  assertOutsideTx('readSnapshot');
  const mysql = h.dialect === 'mysql' || h.dialect === 'mariadb';
  return h.db.connection().execute(async (c) => {
    if (mysql) {
      await sql`set transaction isolation level repeatable read`.execute(c);
      await sql`start transaction with consistent snapshot, read only`.execute(c);
    } else {
      await sql`begin isolation level repeatable read read only`.execute(c);
    }
    let result: T;
    try {
      result = await fn(c);
    } catch (error) {
      // Fails as well when the connection is gone (the server ended the transaction): fn's error is what matters.
      await sql`rollback`.execute(c).catch(() => {});
      throw error;
    }
    await sql`commit`.execute(c);
    return result;
  });
}
