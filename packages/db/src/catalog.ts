import { sql, type Kysely } from 'kysely';
import { describe } from './checks.js';
import { DIALECTS, type Dialect } from './connect.js';
import { identifier, type TableClass } from './ddl.js';

// The database's own catalog, as the generic exporter reads it (1d; spec §9.8 row 3: a bundled newer release in
// `schemaHold` backs the database up "dengan eksportir generik (kolom dibaca dari skema DB, bukan registri kode)",
// since its own registry may not describe a schema it has not migrated yet). Decision C11 keeps the code's column
// registry the only source everywhere else; this module is read only when an export asks for `columns: 'catalog'`.
//
// - The tables are the ones `schema_tables` records (spec §6.2: what restore and `install:reset` drop), never a list
//   of the catalog's: a table ALTIS did not make is not ALTIS's to back up.
// - Columns come in ordinal order from information_schema.COLUMNS (MySQL/MariaDB, `DATABASE()`), pg_attribute
//   (PostgreSQL, `current_schema()`) or PRAGMA table_info (SQLite), each in one of a few families: what its values
//   are, and, for character columns, whether they compare in byte order (`binary`: utf8mb4_bin or another `_bin`
//   collation on MySQL/MariaDB, "C"/"POSIX" on PostgreSQL, every character column on SQLite, whose default
//   collation is BINARY and which ALTIS never declares otherwise). A column outside the families (BLOB, BYTEA, BIT,
//   arrays, and the floating-point FLOAT/DOUBLE/REAL, ruling R1d-3) is refused: a backup could not hold its values
//   canonically, and the refusal comes here, before any part is written, naming the column.
// - Keys: the primary key's columns in key order and the foreign keys, from the same catalogs.
//
// Every statement is built with Kysely's `sql` tag; the table name is a checked identifier and is bound as a value.

/**
 * What a column of the catalog holds:
 *
 * - `integer`: any integer type (TINYINT but TINYINT(1), SMALLINT, INT, BIGINT, PostgreSQL int2/int4/int8, SQLite
 *   INTEGER affinity);
 * - `text`: a character column with a linguistic collation (MySQL/MariaDB `*_ci`, PostgreSQL's default);
 * - `binary`: a character column that compares in byte order (the R17 key columns; every one on SQLite);
 * - `boolean`: PostgreSQL boolean, MySQL/MariaDB TINYINT(1), SQLite BOOLEAN;
 * - `decimal`: exact numbers (DECIMAL/NUMERIC), which the drivers return as their exact decimal strings. Floating-point
 *   types (FLOAT/DOUBLE/REAL) are no family: the drivers return them as JS numbers, which have no canonical form a
 *   restore could give back exactly (ruling R1d-3). A `decimal` column cannot be a key either (the generic exporter
 *   refuses it, generic-columns.ts): its strings do not sort in the database's numeric order;
 * - `json`: a native JSON type (MySQL JSON, PostgreSQL json/jsonb, SQLite JSON); ALTIS's own `json()` is TEXT;
 * - `date`: a native date or time type (DATE, DATETIME, TIMESTAMP, TIME, YEAR); ALTIS's own `date()` is CHAR(10).
 */
export type CatalogFamily = 'integer' | 'text' | 'binary' | 'boolean' | 'decimal' | 'json' | 'date';

/** One column as the catalog describes it. */
export interface CatalogColumn {
  name: string;
  family: CatalogFamily;
  nullable: boolean;
  /** The most characters of a CHAR(n)/VARCHAR(n) column; null for every other column (TEXT included). */
  length: number | null;
}

/** A foreign key of a table: its `column` references `refColumn` of `table`. */
export interface CatalogForeignKey {
  column: string;
  table: string;
  refColumn: string;
}

/** The keys of one table as the catalog describes them. */
export interface CatalogKeys {
  /** The primary key's columns, in key order; [] when the table has none (or does not exist). */
  pk: string[];
  /** Its foreign keys, one entry per column of each. */
  fks: CatalogForeignKey[];
}

/** One row of `schema_tables`: a table and its class (spec §6.5). */
export interface SchemaTableEntry {
  name: string;
  class: string;
}

function checkDialect(dialect: unknown, fn: string): asserts dialect is Dialect {
  if (!(DIALECTS as readonly unknown[]).includes(dialect)) throw new TypeError(`${fn}(): unknown dialect ${describe(dialect)}`);
}

function mysqlFamily(dialect: Dialect): boolean {
  return dialect === 'mysql' || dialect === 'mariadb';
}

function unsupported(table: string, column: string, type: string): TypeError {
  return new TypeError(`readTableColumns(): ${table}.${column} has the type ${type}, which a backup cannot hold`);
}

/** The schema_tables registry's row type, for the query builder. */
type RegistryTables = { schema_tables: { name: string; class: string } };

/**
 * Every row of `schema_tables` (its name and class), sorted by name in byte order. `db` may be any Kysely instance or
 * transaction on an ALTIS database.
 */
export async function readSchemaTableEntries(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: Kysely<any>,
): Promise<SchemaTableEntry[]> {
  const rows = await (db as Kysely<RegistryTables>).selectFrom('schema_tables').select(['name', 'class']).execute();
  return rows
    .map((r) => ({ name: String(r.name), class: String(r.class) }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * The table names `schema_tables` records, sorted in byte order: the tables ALTIS made (and registered before making
 * them, so a name may be listed whose table a crash left uncreated).
 */
export async function readSchemaTables(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: Kysely<any>,
): Promise<string[]> {
  return (await readSchemaTableEntries(db)).map((e) => e.name);
}

// ---- Komunitas K1 (edition lane) ----

/** One row of `schema_tables` with the migration (or runner) that made the table: its `created_by`. */
export interface SchemaTableOrigin {
  name: string;
  class: TableClass;
  createdBy: string;
}

/** The schema_tables registry's row type with `created_by`, for the query builder. */
type OriginTables = { schema_tables: { name: string; class: string; created_by: string } };

/**
 * Every row of `schema_tables` with its `created_by`, sorted by name in byte order: what made each table (a
 * migration's name, `bootstrap` or `migrator`; a migration of the other lane records its own `eNNNN_slug` name). `db`
 * may be any Kysely instance or transaction on an ALTIS database.
 */
export async function readSchemaTableOrigins(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: Kysely<any>,
): Promise<SchemaTableOrigin[]> {
  const rows = await (db as Kysely<OriginTables>).selectFrom('schema_tables').select(['name', 'class', 'created_by']).execute();
  return rows
    .map((r) => ({ name: String(r.name), class: String(r.class) as TableClass, createdBy: String(r.created_by) }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** The character length in a declared type such as `VARCHAR(191)` or `character(26)`; null when it has none. */
function declaredLength(type: string): number | null {
  const m = /\(\s*(\d+)\s*\)/.exec(type);
  return m === null ? null : Number(m[1]);
}

/** MySQL/MariaDB: the family of a column of DATA_TYPE `dt` (COLUMN_TYPE `ct`, collation `coll`); null outside them. */
function mysqlFamilyOf(dt: string, ct: string, coll: string | null): CatalogFamily | null {
  if (dt === 'tinyint' && /^tinyint\(1\)/.test(ct)) return 'boolean';
  if (['tinyint', 'smallint', 'mediumint', 'int', 'integer', 'bigint'].includes(dt)) return 'integer';
  if (['decimal', 'numeric'].includes(dt)) return 'decimal'; // float, double, real: none (ruling R1d-3)
  if (['char', 'varchar', 'tinytext', 'text', 'mediumtext', 'longtext', 'enum', 'set'].includes(dt)) {
    return coll !== null && coll.endsWith('_bin') ? 'binary' : 'text';
  }
  if (dt === 'json') return 'json';
  if (['date', 'datetime', 'timestamp', 'time', 'year'].includes(dt)) return 'date';
  return null;
}

/** PostgreSQL: the family of a column of base type `typname` (collation `coll`); null outside them. */
function pgFamilyOf(typname: string, coll: string | null): CatalogFamily | null {
  if (['int2', 'int4', 'int8'].includes(typname)) return 'integer';
  if (typname === 'bool') return 'boolean';
  if (typname === 'numeric') return 'decimal'; // float4, float8: none (ruling R1d-3)
  if (['bpchar', 'varchar', 'text'].includes(typname)) return coll === 'C' || coll === 'POSIX' ? 'binary' : 'text';
  if (typname === 'json' || typname === 'jsonb') return 'json';
  if (['date', 'timestamp', 'timestamptz', 'time', 'timetz'].includes(typname)) return 'date';
  return null;
}

/**
 * SQLite: the family of a column declared `type`, by SQLite's affinity rules (§3.1 of its datatype documentation):
 * INT → integer; CHAR/CLOB/TEXT → binary (compared with BINARY); BLOB or nothing → none; REAL/FLOA/DOUB (REAL
 * affinity, floating point) → none (ruling R1d-3); the rest (NUMERIC affinity) by name: BOOL… → boolean,
 * …DATE…/…TIME… → date, JSON → json, else decimal.
 */
function sqliteFamilyOf(type: string): CatalogFamily | null {
  const t = type.toUpperCase();
  if (t.includes('INT')) return 'integer';
  if (t.includes('CHAR') || t.includes('CLOB') || t.includes('TEXT')) return 'binary';
  if (t.includes('BLOB') || t.trim() === '') return null;
  if (t.includes('REAL') || t.includes('FLOA') || t.includes('DOUB')) return null; // floating point (ruling R1d-3)
  if (t.startsWith('BOOL')) return 'boolean';
  if (t.includes('DATE') || t.includes('TIME')) return 'date';
  if (t.startsWith('JSON')) return 'json';
  return 'decimal';
}

/**
 * The columns of `table` in the current database/schema, in ordinal order (a column added later comes last), each
 * with its family, nullability and character length; [] when the table does not exist. The SQLite rowid alias (the
 * only primary key column, declared INTEGER) is never null, whatever PRAGMA table_info reports.
 *
 * @throws TypeError for an unknown dialect, a table name that is not an identifier, or a column outside the families
 *   (naming `table.column` and its type)
 */
export async function readTableColumns(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: Kysely<any>,
  dialect: Dialect,
  table: string,
): Promise<CatalogColumn[]> {
  checkDialect(dialect, 'readTableColumns');
  identifier('table', table);
  if (mysqlFamily(dialect)) {
    const { rows } = await sql<{ name: string; dt: string; ct: string; len: unknown; nullable: string; coll: string | null }>`
      SELECT COLUMN_NAME AS name, DATA_TYPE AS dt, COLUMN_TYPE AS ct, CHARACTER_MAXIMUM_LENGTH AS len,
             IS_NULLABLE AS nullable, COLLATION_NAME AS coll
      FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ${table}
      ORDER BY ORDINAL_POSITION`.execute(db);
    return rows.map((r) => {
      const dt = String(r.dt).toLowerCase();
      const family = mysqlFamilyOf(dt, String(r.ct).toLowerCase(), r.coll === null ? null : String(r.coll));
      if (family === null) throw unsupported(table, String(r.name), String(r.ct));
      const sized = dt === 'char' || dt === 'varchar';
      return { name: String(r.name), family, nullable: String(r.nullable) === 'YES', length: sized ? Number(r.len) : null };
    });
  }
  if (dialect === 'postgres') {
    const { rows } = await sql<{ name: string; typname: string; typmod: unknown; notnull: unknown; coll: string | null }>`
      SELECT a.attname AS name, t.typname AS typname, a.atttypmod AS typmod, a.attnotnull AS notnull, co.collname AS coll
      FROM pg_catalog.pg_attribute a
      JOIN pg_catalog.pg_type t ON t.oid = a.atttypid
      LEFT JOIN pg_catalog.pg_collation co ON co.oid = a.attcollation
      WHERE a.attrelid = to_regclass(format('%I.%I', current_schema(), ${table}::text)) AND a.attnum > 0
        AND NOT a.attisdropped
      ORDER BY a.attnum`.execute(db);
    return rows.map((r) => {
      const typname = String(r.typname);
      const family = pgFamilyOf(typname, r.coll === null ? null : String(r.coll));
      if (family === null) throw unsupported(table, String(r.name), typname);
      const typmod = Number(r.typmod);
      const sized = (typname === 'bpchar' || typname === 'varchar') && typmod > 4;
      return { name: String(r.name), family, nullable: r.notnull !== true, length: sized ? typmod - 4 : null };
    });
  }
  const { rows } = await sql<{ name: string; type: string; nn: unknown; pk: unknown }>`
    SELECT name, type, "notnull" AS nn, pk FROM pragma_table_info(${table}) ORDER BY cid`.execute(db);
  const keyColumns = rows.filter((r) => Number(r.pk) > 0).length;
  return rows.map((r) => {
    const type = String(r.type);
    const family = sqliteFamilyOf(type);
    if (family === null) throw unsupported(table, String(r.name), type === '' ? '(none)' : type);
    const rowid = keyColumns === 1 && Number(r.pk) === 1 && type.toUpperCase() === 'INTEGER';
    return {
      name: String(r.name),
      family,
      nullable: Number(r.nn) === 0 && !rowid,
      length: family === 'binary' ? declaredLength(type) : null,
    };
  });
}

/**
 * The primary key (columns in key order) and the foreign keys of `table` in the current database/schema; both empty
 * when the table does not exist.
 *
 * @throws TypeError for an unknown dialect or a table name that is not an identifier
 */
export async function readTableKeys(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: Kysely<any>,
  dialect: Dialect,
  table: string,
): Promise<CatalogKeys> {
  checkDialect(dialect, 'readTableKeys');
  identifier('table', table);
  let pk: { rows: { col: string }[] };
  let fks: { rows: CatalogForeignKey[] };
  if (mysqlFamily(dialect)) {
    pk = await sql<{ col: string }>`SELECT COLUMN_NAME AS col FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ${table} AND INDEX_NAME = 'PRIMARY'
      ORDER BY SEQ_IN_INDEX`.execute(db);
    fks = await sql<CatalogForeignKey>`
      SELECT COLUMN_NAME AS "column", REFERENCED_TABLE_NAME AS "table", REFERENCED_COLUMN_NAME AS "refColumn"
      FROM information_schema.KEY_COLUMN_USAGE
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ${table} AND REFERENCED_TABLE_NAME IS NOT NULL
      ORDER BY CONSTRAINT_NAME, ORDINAL_POSITION`.execute(db);
  } else if (dialect === 'postgres') {
    pk = await sql<{ col: string }>`SELECT a.attname AS col FROM pg_catalog.pg_index ix
      CROSS JOIN LATERAL unnest(ix.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord)
      JOIN pg_catalog.pg_attribute a ON a.attrelid = ix.indrelid AND a.attnum = k.attnum
      WHERE ix.indrelid = to_regclass(format('%I.%I', current_schema(), ${table}::text)) AND ix.indisprimary
      ORDER BY k.ord`.execute(db);
    fks = await sql<CatalogForeignKey>`
      SELECT a.attname AS "column", rt.relname AS "table", ra.attname AS "refColumn"
      FROM pg_catalog.pg_constraint c
      CROSS JOIN LATERAL unnest(c.conkey, c.confkey) WITH ORDINALITY AS k(attnum, refnum, ord)
      JOIN pg_catalog.pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
      JOIN pg_catalog.pg_class rt ON rt.oid = c.confrelid
      JOIN pg_catalog.pg_attribute ra ON ra.attrelid = c.confrelid AND ra.attnum = k.refnum
      WHERE c.contype = 'f' AND c.conrelid = to_regclass(format('%I.%I', current_schema(), ${table}::text))
      ORDER BY c.conname, k.ord`.execute(db);
  } else {
    pk = await sql<{ col: string }>`SELECT name AS col FROM pragma_table_info(${table}) WHERE pk > 0 ORDER BY pk`.execute(db);
    fks = await sql<CatalogForeignKey>`SELECT f."from" AS "column", f."table" AS "table", f."to" AS "refColumn"
      FROM pragma_foreign_key_list(${table}) f ORDER BY f.id, f.seq`.execute(db);
  }
  return {
    pk: pk.rows.map((r) => String(r.col)),
    fks: fks.rows.map((r) => ({ column: String(r.column), table: String(r.table), refColumn: String(r.refColumn) })),
  };
}
