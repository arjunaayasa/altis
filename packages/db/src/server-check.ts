import { sql } from 'kysely';
import type { DbHandle } from './connect.js';

// Server checks for the installer and `doctor` (spec §9.5 step 2: version, engine, full-text). The connection
// limits (P17) are read by connect() itself.

export type ServerFlavor = 'mysql' | 'mariadb' | 'postgres' | 'sqlite';

export type ServerProblem = 'VERSION_TOO_OLD' | 'ENGINE_NOT_INNODB' | 'NO_FULLTEXT';

export type VersionTriple = readonly [major: number, minor: number, patch: number];

export interface ServerCheck {
  /** The version string as the server reports it (e.g. `10.6.20-MariaDB-ubu2004`, `15.10 (Debian ...)`). */
  version: string;
  /** What the server turned out to be; may differ from the configured dialect (`mysql` vs `mariadb`). */
  flavor: ServerFlavor;
  ok: boolean;
  problems: ServerProblem[];
}

/**
 * Minimum versions (global constraints): MySQL 8.0, MariaDB 10.6, PostgreSQL 15. SQLite comes with Node, which is
 * checked against 22.16 elsewhere; 3.45.0 is below anything Node 22.16+ bundles and only catches an unexpected
 * build.
 */
export const MIN_SERVER_VERSIONS: Readonly<Record<ServerFlavor, VersionTriple>> = Object.freeze({
  mysql: [8, 0, 0],
  mariadb: [10, 6, 0],
  postgres: [15, 0, 0],
  sqlite: [3, 45, 0],
});

const TRIPLE = /^(\d+)\.(\d+)\.(\d+)(?![\d.])/;

/**
 * Parses `SELECT VERSION()` of MySQL or MariaDB. The flavor is MariaDB when the string mentions it
 * (`10.6.20-MariaDB-ubu2004`), MySQL otherwise (`8.0.40`, `8.0.36-0ubuntu0.22.04.1`). The `5.5.5-` prefix that
 * MariaDB 10.x puts in front of its version for old clients is skipped. Null when there is no `x.y.z` at the start.
 */
export function parseServerVersion(raw: string): { flavor: 'mysql' | 'mariadb'; version: VersionTriple } | null {
  const flavor = /mariadb/i.test(raw) ? 'mariadb' : 'mysql';
  const text = flavor === 'mariadb' && raw.startsWith('5.5.5-') ? raw.slice('5.5.5-'.length) : raw;
  const m = TRIPLE.exec(text);
  if (m === null) return null;
  return { flavor, version: [Number(m[1]), Number(m[2]), Number(m[3])] };
}

function compareTriples(a: VersionTriple, b: VersionTriple): number {
  for (let i = 0; i < 3; i += 1) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** True when `version` is at least {@link MIN_SERVER_VERSIONS}[flavor]. */
export function meetsMinimum(flavor: ServerFlavor, version: VersionTriple): boolean {
  return compareTriples(version, MIN_SERVER_VERSIONS[flavor]) >= 0;
}

/** Runs `probe`; false when it throws (the probe's statement is not supported). */
async function succeeds(probe: () => Promise<unknown>): Promise<boolean> {
  try {
    await probe();
    return true;
  } catch {
    return false;
  }
}

async function checkMysql(h: DbHandle): Promise<ServerCheck> {
  const { rows } = await sql<{ v: string }>`SELECT VERSION() AS v`.execute(h.db);
  const version = String(rows[0]?.v ?? '');
  const parsed = parseServerVersion(version);
  const flavor = parsed?.flavor ?? (/mariadb/i.test(version) ? 'mariadb' : 'mysql');
  const problems: ServerProblem[] = [];
  if (parsed === null || !meetsMinimum(flavor, parsed.version)) problems.push('VERSION_TOO_OLD');

  const engine = await sql<{ s: string }>`SELECT SUPPORT AS s FROM information_schema.ENGINES WHERE ENGINE = 'InnoDB'`.execute(h.db);
  const support = String(engine.rows[0]?.s ?? '').toUpperCase();
  const innodb = support === 'YES' || support === 'DEFAULT';
  if (!innodb) problems.push('ENGINE_NOT_INNODB');

  // InnoDB full-text search: its settings exist only when the server has it. Side-effect free, unlike creating a
  // table with a FULLTEXT index (which InnoDB refuses on temporary tables).
  const fulltext = innodb && (await succeeds(() => sql`SELECT @@innodb_ft_min_token_size AS n`.execute(h.db)));
  if (!fulltext) problems.push('NO_FULLTEXT');
  return { version, flavor, ok: problems.length === 0, problems };
}

async function checkPostgres(h: DbHandle): Promise<ServerCheck> {
  const { rows } = await sql<{ v: string; n: string }>`
    SELECT current_setting('server_version') AS v, current_setting('server_version_num') AS n`.execute(h.db);
  const version = String(rows[0]?.v ?? '');
  const num = Number(rows[0]?.n);
  const problems: ServerProblem[] = [];
  // server_version_num is major * 10000 + minor since PostgreSQL 10.
  const triple: VersionTriple = [Math.floor(num / 10000), num % 10000, 0];
  if (!Number.isInteger(num) || !meetsMinimum('postgres', triple)) problems.push('VERSION_TOO_OLD');
  if (!(await succeeds(() => sql`SELECT to_tsvector('simple', 'altis') AS t`.execute(h.db)))) problems.push('NO_FULLTEXT');
  return { version, flavor: 'postgres', ok: problems.length === 0, problems };
}

async function checkSqlite(h: DbHandle): Promise<ServerCheck> {
  const { rows } = await sql<{ v: string }>`SELECT sqlite_version() AS v`.execute(h.db);
  const version = String(rows[0]?.v ?? '');
  const m = TRIPLE.exec(version);
  const problems: ServerProblem[] = [];
  if (m === null || !meetsMinimum('sqlite', [Number(m[1]), Number(m[2]), Number(m[3])])) problems.push('VERSION_TOO_OLD');
  // FTS5, probed in the connection's private temp schema so the database file is not touched.
  const fts5 = await succeeds(async () => {
    await sql`DROP TABLE IF EXISTS temp.altis_fts5_probe`.execute(h.db);
    await sql`CREATE VIRTUAL TABLE temp.altis_fts5_probe USING fts5(body)`.execute(h.db);
    await sql`DROP TABLE temp.altis_fts5_probe`.execute(h.db);
  });
  if (!fts5) problems.push('NO_FULLTEXT');
  return { version, flavor: 'sqlite', ok: problems.length === 0, problems };
}

/**
 * The names of everything the catalog lists as a table, a view or a sequence in the database the handle is
 * connected to, sorted (ruling R55: an install needs a database in which this is empty):
 *
 * - MySQL/MariaDB: every row of `information_schema.TABLES` for `DATABASE()` (base tables, views, system-versioned
 *   tables, MariaDB sequences);
 * - PostgreSQL: `pg_class` in `current_schema()` only (other schemas of the database are not looked at) with
 *   `relkind` table, partitioned table, view, materialized view, foreign table or sequence; indexes, TOAST tables
 *   and composite types are not counted;
 * - SQLite: `sqlite_master` entries of type `table` or `view`, except SQLite's own `sqlite_*` tables (such as
 *   `sqlite_sequence`, which AUTOINCREMENT creates).
 */
export async function listCatalogTables(h: Pick<DbHandle, 'db' | 'dialect'>): Promise<string[]> {
  let names: unknown[];
  if (h.dialect === 'sqlite') {
    const { rows } = await sql<{ name: string }>`SELECT name FROM sqlite_master
      WHERE type IN ('table', 'view') AND substr(name, 1, 7) <> 'sqlite_'`.execute(h.db);
    names = rows.map((r) => r.name);
  } else if (h.dialect === 'postgres') {
    const { rows } = await sql<{ name: string }>`SELECT c.relname AS name FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = current_schema() AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')`.execute(h.db);
    names = rows.map((r) => r.name);
  } else {
    const { rows } = await sql<{ name: string }>`SELECT TABLE_NAME AS name FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE()`.execute(h.db);
    names = rows.map((r) => r.name);
  }
  return names.map(String).sort();
}

/**
 * Checks that the server can run ALTIS: version at least {@link MIN_SERVER_VERSIONS} (`VERSION_TOO_OLD`, also
 * when the version cannot be read), InnoDB available on MySQL/MariaDB (`ENGINE_NOT_INNODB`), and full-text search
 * (`NO_FULLTEXT`: InnoDB FTS, PostgreSQL `to_tsvector`, SQLite FTS5). `ok` is true when there is no problem.
 */
export function checkServer(h: DbHandle): Promise<ServerCheck> {
  if (h.dialect === 'sqlite') return checkSqlite(h);
  if (h.dialect === 'postgres') return checkPostgres(h);
  return checkMysql(h);
}
