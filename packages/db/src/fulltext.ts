import { DomainError } from '@altis/shared';
import { MysqlAdapter, PostgresAdapter, SqliteAdapter, sql, type Kysely, type RawBuilder, type Transaction } from 'kysely';
import { DIALECTS, type Dialect } from './connect.js';

// The registered full-text helpers (Phase 2 spec §4.3, decision P2-19): the only place where per-dialect full-text
// DDL is written. Migration 0024 calls ensureFullText with its own literal spec (R44); the query side (Task 15's
// fulltext-query.ts) reads the family of a connection with fullTextFamily and repeats the PostgreSQL expression
// through PG_SEARCH_VECTOR_SQL, so the planner can use the expression index.
//
// - MySQL/MariaDB (`innodb`): InnoDB FULLTEXT indexes, one `CREATE FULLTEXT INDEX` per index (InnoDB adds its
//   hidden FTS_DOC_ID column with the first one and rebuilds the table, so they are never combined).
// - PostgreSQL (`pg`): one GIN expression index over the weighted `to_tsvector('simple', …)` of the text columns,
//   weights A, B, C, D in column order. Every function in it is IMMUTABLE, which an expression index requires.
// - SQLite (`fts5`): an FTS5 external-content table (`content=<table>`, `content_rowid=<integer key>`, tokenizer
//   `unicode61`). FTS5 makes four shadow tables of its own (`<name>_data`, `_idx`, `_docsize`, `_config`): none of
//   them is a registered table, so the drift and table tests skip FULLTEXT_DIALECT_OBJECTS, and dropRegisteredTables
//   drops FULLTEXT_VIRTUAL_TABLES first (SQLite refuses to drop a shadow table on its own, and its four shadows go
//   with it). A SQLite restore builds a fresh file whose migrations make it again, so no backup rule is needed.
//
// Every step is idempotent and checked against the catalog first, one DDL statement each (spec §6.2); a name taken
// by another object fails loudly (SCHEMA_CONFLICT), never silently.

/** The full-text engine behind a connection. */
export type FullTextFamily = 'innodb' | 'pg' | 'fts5';

/**
 * The full-text family of `db`, read from its dialect adapter: a TxCtx carries no dialect, and the index writer runs
 * inside a transaction.
 *
 * @throws TypeError for an adapter that is none of Kysely's MySQL, PostgreSQL or SQLite adapters
 */
export function fullTextFamily(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: Kysely<any> | Transaction<any>,
): FullTextFamily {
  const adapter: unknown = db.getExecutor().adapter;
  if (adapter instanceof PostgresAdapter) return 'pg';
  if (adapter instanceof MysqlAdapter) return 'innodb';
  if (adapter instanceof SqliteAdapter) return 'fts5';
  throw new TypeError('fullTextFamily(): the connection has none of the MySQL, PostgreSQL or SQLite adapters');
}

/**
 * The objects SQLite's FTS5 creates for the search index (the virtual table and its four shadow tables), per dialect.
 * They are not in TABLE_CLASSES: the drift and table tests ignore these names on their dialect only.
 */
export const FULLTEXT_DIALECT_OBJECTS: Readonly<Record<Dialect, readonly string[]>> = Object.freeze({
  mysql: Object.freeze([]),
  mariadb: Object.freeze([]),
  postgres: Object.freeze([]),
  sqlite: Object.freeze(['search_fts', 'search_fts_data', 'search_fts_idx', 'search_fts_docsize', 'search_fts_config']),
});

/**
 * The virtual tables dropRegisteredTables drops before the registered tables (`DROP TABLE IF EXISTS`), per dialect:
 * dropping one also drops its shadow tables, which cannot be dropped on their own.
 */
export const FULLTEXT_VIRTUAL_TABLES: Readonly<Record<Dialect, readonly string[]>> = Object.freeze({
  mysql: Object.freeze([]),
  mariadb: Object.freeze([]),
  postgres: Object.freeze([]),
  sqlite: Object.freeze(['search_fts']),
});

/** What ensureFullText makes for one table, on each family. */
export interface FullTextSpec {
  /** The table indexed (it must exist). */
  readonly table: string;
  /** Its integer primary key (a serial()): the FTS5 `content_rowid`. */
  readonly rowid: string;
  /** Its text columns, 1 to 4, in weight order (PostgreSQL weights A, B, C, D; the FTS5 column order). */
  readonly columns: readonly string[];
  /** MySQL/MariaDB: the FULLTEXT indexes (`ix_` names), each over some of `columns`. */
  readonly innodb: readonly { readonly name: string; readonly columns: readonly string[] }[];
  /** PostgreSQL: the GIN expression index (an `ix_` name). */
  readonly pg: { readonly name: string };
  /** SQLite: the FTS5 external-content table. */
  readonly fts5: { readonly name: string };
}

const IDENTIFIER = /^[a-z][a-z0-9_]*$/;
const MAX_IDENTIFIER = 63;

/** `name` when it is a portable identifier (as ddl.ts checks them); a TypeError otherwise. */
function identifier(kind: string, name: unknown): string {
  if (typeof name !== 'string' || !IDENTIFIER.test(name) || name.length > MAX_IDENTIFIER || name.startsWith('sqlite_')) {
    throw new TypeError(`ensureFullText(): ${kind} ${JSON.stringify(name)} must match /^[a-z][a-z0-9_]*$/, at most 63 characters`);
  }
  return name;
}

/** `spec` checked (TypeError otherwise), before the database is touched. */
function checkSpec(spec: FullTextSpec): FullTextSpec {
  if (typeof spec !== 'object' || spec === null) throw new TypeError('ensureFullText(): spec must be an object');
  identifier('table', spec.table);
  identifier('rowid column', spec.rowid);
  if (!Array.isArray(spec.columns) || spec.columns.length < 1 || spec.columns.length > PG_WEIGHTS.length) {
    throw new TypeError(`ensureFullText(): 1 to ${PG_WEIGHTS.length} columns, got ${String(spec.columns?.length)}`);
  }
  for (const c of spec.columns) identifier('column', c);
  if (new Set(spec.columns).size !== spec.columns.length) throw new TypeError('ensureFullText(): a column is repeated');
  if (spec.columns.includes(spec.rowid)) throw new TypeError('ensureFullText(): the rowid column cannot be a text column');
  if (!Array.isArray(spec.innodb)) throw new TypeError('ensureFullText(): innodb must be an array');
  const names = new Set<string>();
  for (const ix of spec.innodb) {
    const name = identifier('index', ix.name);
    if (!name.startsWith('ix_')) throw new TypeError(`ensureFullText(): index ${name} must start with ix_ (ruling R23)`);
    if (names.has(name)) throw new TypeError(`ensureFullText(): index ${name} is declared twice`);
    names.add(name);
    if (!Array.isArray(ix.columns) || ix.columns.length === 0) throw new TypeError(`ensureFullText(): index ${name} needs columns`);
    for (const c of ix.columns) {
      if (!spec.columns.includes(c)) throw new TypeError(`ensureFullText(): index ${name} names ${String(c)}, not a text column`);
    }
    if (new Set(ix.columns).size !== ix.columns.length) throw new TypeError(`ensureFullText(): index ${name} repeats a column`);
  }
  const pgName = identifier('index', spec.pg?.name);
  if (!pgName.startsWith('ix_')) throw new TypeError(`ensureFullText(): index ${pgName} must start with ix_ (ruling R23)`);
  identifier('FTS5 table', spec.fts5?.name);
  return spec;
}

/** PostgreSQL's four weights, as SQL literals (never parameters: an index expression cannot hold one). */
const PG_WEIGHTS: readonly RawBuilder<unknown>[] = [sql`'A'`, sql`'B'`, sql`'C'`, sql`'D'`];

/**
 * The weighted search vector over `columns` (weights A, B, C, D in order):
 * `setweight(to_tsvector('simple', coalesce("c1", '')), 'A') || …`. Text only, no parameter.
 */
function pgSearchVector(columns: readonly string[]): RawBuilder<unknown> {
  const parts = columns.map(
    (c, i) => sql`setweight(to_tsvector('simple', coalesce(${sql.ref(c)}, '')), ${PG_WEIGHTS[i] as RawBuilder<unknown>})`,
  );
  return sql.join(parts, sql` || `);
}

/**
 * The expression of the PostgreSQL search index of `search_doc` (migration 0024), as SQL text without parameters:
 *
 * ```sql
 * setweight(to_tsvector('simple', coalesce("t_title", '')), 'A') || setweight(to_tsvector('simple',
 * coalesce("t_agents", '')), 'B') || setweight(to_tsvector('simple', coalesce("t_subjects", '')), 'C') ||
 * setweight(to_tsvector('simple', coalesce("t_rest", '')), 'D')
 * ```
 *
 * A query that wants the index repeats it through this builder (`${PG_SEARCH_VECTOR_SQL} @@ to_tsquery(…)`,
 * `ts_rank_cd(${PG_SEARCH_VECTOR_SQL}, …)`), never by retyping it.
 */
export const PG_SEARCH_VECTOR_SQL: RawBuilder<unknown> = pgSearchVector(['t_title', 't_agents', 't_subjects', 't_rest']);

/** TypeError unless `dialect` is one of DIALECTS. */
function checkDialect(dialect: unknown): asserts dialect is Dialect {
  if (!(DIALECTS as readonly unknown[]).includes(dialect)) throw new TypeError(`unknown dialect ${JSON.stringify(dialect)}`);
}

function conflict(reason: string, detail: string, meta: Record<string, unknown>): DomainError {
  return new DomainError('SCHEMA_CONFLICT', { detail, meta: { reason, ...meta } });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = Kysely<any>;

/** The tables of the current database/schema that have an index `name`, sorted. */
async function indexOwners(db: AnyDb, dialect: Dialect, name: string): Promise<string[]> {
  let q: RawBuilder<{ owner: string }>;
  if (dialect === 'mysql' || dialect === 'mariadb') {
    q = sql`SELECT DISTINCT TABLE_NAME AS owner FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND INDEX_NAME = ${name}`;
  } else if (dialect === 'postgres') {
    q = sql`SELECT tablename AS owner FROM pg_catalog.pg_indexes WHERE schemaname = current_schema() AND indexname = ${name}`;
  } else {
    q = sql`SELECT tbl_name AS owner FROM sqlite_master WHERE type = 'index' AND name = ${name}`;
  }
  return [...new Set((await q.execute(db)).rows.map((r) => String(r.owner)))].sort();
}

/** Whether a base table `name` exists in the current database/schema. */
async function tablePresent(db: AnyDb, dialect: Dialect, name: string): Promise<boolean> {
  let q: RawBuilder<{ present: unknown }>;
  if (dialect === 'mysql' || dialect === 'mariadb') {
    q = sql`SELECT 1 AS present FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ${name} AND TABLE_TYPE = 'BASE TABLE'`;
  } else if (dialect === 'postgres') {
    q = sql`SELECT 1 AS present FROM pg_catalog.pg_class
      WHERE oid = to_regclass(format('%I.%I', current_schema(), ${name}::text)) AND relkind IN ('r', 'p')`;
  } else {
    q = sql`SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ${name}`;
  }
  return (await q.execute(db)).rows.length > 0;
}

/**
 * Creates something unless `exists()` says it is there. A create that fails is accepted when, outside a transaction,
 * `exists()` now reports the object (another connection created it at the same time); inside one, PostgreSQL has
 * aborted the transaction already, so the error stands.
 */
async function createUnlessPresent(db: AnyDb, exists: () => Promise<boolean>, create: () => Promise<unknown>): Promise<void> {
  if (await exists()) return;
  try {
    await create();
  } catch (error) {
    if (!db.isTransaction) {
      let present = false;
      try {
        present = await exists();
      } catch {
        // the create's error is the one to report
      }
      if (present) return;
    }
    throw error;
  }
}

/** True when `name` is an index of `table`; SCHEMA_CONFLICT `index_name_taken` when another table has it. */
async function indexOn(db: AnyDb, dialect: Dialect, table: string, name: string): Promise<boolean> {
  const owners = await indexOwners(db, dialect, name);
  if (owners.includes(table)) return true;
  if (owners.length > 0) {
    throw conflict(
      'index_name_taken',
      `Nama indeks ${name} sudah dipakai tabel ${owners.join(', ')} / Index name ${name} is already used by table ${owners.join(', ')}`,
      { name, table: owners[0] },
    );
  }
  return false;
}

/** The CREATE statement of the FTS5 table, when SQLite lists `name` as a table; null when it does not. */
async function sqliteTableSql(db: AnyDb, name: string): Promise<string | null> {
  const { rows } = await sql<{ ddl: string | null }>`SELECT sql AS ddl FROM sqlite_master WHERE type = 'table' AND name = ${name}`.execute(db);
  const row = rows[0];
  return row === undefined ? null : String(row.ddl ?? '');
}

/** True when the FTS5 table `name` exists; SCHEMA_CONFLICT `fulltext_name_taken` when `name` is another table. */
async function fts5Present(db: AnyDb, name: string): Promise<boolean> {
  const ddl = await sqliteTableSql(db, name);
  if (ddl === null) return false;
  if (!/^create\s+virtual\s+table\b[\s\S]*\busing\s+fts5\s*\(/i.test(ddl)) {
    throw conflict(
      'fulltext_name_taken',
      `Tabel ${name} sudah ada tetapi bukan tabel FTS5 / Table ${name} exists but is not an FTS5 table`,
      { name },
    );
  }
  return true;
}

/**
 * Makes sure the full-text index of `spec.table` exists for `dialect` (see the top of this file): idempotent, every
 * object checked against the catalog first, one DDL statement each.
 *
 * - MySQL/MariaDB: `CREATE FULLTEXT INDEX <name> ON <table> (<columns>)` for each of `spec.innodb`.
 * - PostgreSQL: `CREATE INDEX <pg.name> ON <table> USING gin ((<weighted vector>))`, the vector of
 *   {@link PG_SEARCH_VECTOR_SQL}'s form over `spec.columns`.
 * - SQLite: `CREATE VIRTUAL TABLE <fts5.name> USING fts5(<columns>, content='<table>', content_rowid='<rowid>',
 *   tokenize='unicode61')`.
 *
 * An index or FTS5 table already there is accepted as it is, without comparing its definition (as ensureIndex does).
 *
 * @throws TypeError, before the database is touched, for an unknown dialect or a spec whose names are not portable
 *   identifiers, whose index names lack `ix_`, with more than four columns, or whose indexes name other columns
 * @throws DomainError `SCHEMA_CONFLICT` with `meta.reason`: `table_missing` (`meta.table`), `index_name_taken`
 *   (`meta.name`, `table`: an index of that name belongs to another table) or `fulltext_name_taken` (SQLite: a table
 *   of the FTS5 table's name exists and is not an FTS5 table)
 */
export async function ensureFullText(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: Kysely<any>,
  dialect: Dialect,
  spec: FullTextSpec,
): Promise<void> {
  checkDialect(dialect);
  checkSpec(spec);
  if (!(await tablePresent(db, dialect, spec.table))) {
    throw conflict(
      'table_missing',
      `Tabel ${spec.table} tidak ada, indeks teks lengkapnya tidak dapat dibuat / ` +
        `Table ${spec.table} does not exist, so its full-text index cannot be created`,
      { table: spec.table },
    );
  }
  if (dialect === 'mysql' || dialect === 'mariadb') {
    for (const ix of spec.innodb) {
      await createUnlessPresent(
        db,
        () => indexOn(db, dialect, spec.table, ix.name),
        () =>
          sql`CREATE FULLTEXT INDEX ${sql.id(ix.name)} ON ${sql.table(spec.table)} (${sql.join(ix.columns.map((c) => sql.ref(c)))})`.execute(db),
      );
    }
    return;
  }
  if (dialect === 'postgres') {
    await createUnlessPresent(
      db,
      () => indexOn(db, dialect, spec.table, spec.pg.name),
      () => sql`CREATE INDEX ${sql.id(spec.pg.name)} ON ${sql.table(spec.table)} USING gin ((${pgSearchVector(spec.columns)}))`.execute(db),
    );
    return;
  }
  await createUnlessPresent(
    db,
    () => fts5Present(db, spec.fts5.name),
    () =>
      sql`CREATE VIRTUAL TABLE ${sql.id(spec.fts5.name)} USING fts5(${sql.join(spec.columns.map((c) => sql.id(c)))}, content=${sql.lit(spec.table)}, content_rowid=${sql.lit(spec.rowid)}, tokenize='unicode61')`.execute(
        db,
      ),
  );
}

/**
 * The expression index ensureFullText makes on PostgreSQL for `spec`, as a builder (for tests that compare it with
 * {@link PG_SEARCH_VECTOR_SQL}).
 */
export function pgSearchVectorOf(spec: Pick<FullTextSpec, 'columns'>): RawBuilder<unknown> {
  return pgSearchVector(spec.columns);
}
