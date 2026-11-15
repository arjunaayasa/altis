import { withTx, type ForeignMysql, type ForeignMysqlConfig } from '@altis/db';
import { DomainError, newId } from '@altis/shared';
import { mapLegacy } from '../../src/catalog/data/legacy-map.js';
import type { SlimsSourceFactory } from '../../src/migration/slims/factory.js';
import { SlimsFileTooLargeError, type SlimsFilesSource, type SlimsRow, type SlimsSource, type SlimsTableInfo, type SplitCheckpoint } from '../../src/migration/slims/source/types.js';
import type { SlimsStage, SlimsStageContext, SlimsStageName } from '../../src/migration/slims/stage.js';
import type { FixtureCell, FixtureData } from '../support/slims-fixture/generate.js';
import { FIXTURE_TABLES } from '../support/slims-fixture/schema.js';

// An in-memory SLiMS source and fake stages for the migration framework's tests (Phase 2 Task 23, B1): the framework
// test, the route tests, the CLI test and the audit script run whole migrations on them through the factory seam
// (__setSlimsSourceFactory, __setSlimsStages), without Task 10's readers or the stages of Tasks 37 and 38.

/** A table of the fake source: its columns, key and rows; `knownCount: false` makes `tables()` report no count. */
export interface FakeSlimsTable {
  columns: string[];
  primaryKey: string[];
  rows: SlimsRow[];
  knownCount?: boolean;
}

/** The three tables of the framework tests: a few `biblio` (one title in cp1252 bytes), `item` and `mst_author`. */
export function fakeSlimsTables(): Record<string, FakeSlimsTable> {
  const cp1252Cafe = Uint8Array.from([0x43, 0x61, 0x66, 0xe9, 0x20, 0x4d, 0x61, 0x6e, 0x69, 0x73]); // "Café Manis"
  return {
    biblio: {
      columns: ['biblio_id', 'title', 'publish_year'],
      primaryKey: ['biblio_id'],
      rows: [
        { biblio_id: 1, title: 'Laskar Pelangi: sebuah novel', publish_year: 'c1998?' },
        { biblio_id: 2, title: cp1252Cafe, publish_year: '2005' },
        { biblio_id: 3, title: 'Ronggeng Dukuh Paruk', publish_year: null },
        { biblio_id: 4, title: 'Bumi Manusia', publish_year: '1980' },
        { biblio_id: 5, title: 'Cantik Itu Luka', publish_year: '2002' },
      ],
    },
    item: {
      columns: ['item_id', 'biblio_id', 'item_code'],
      primaryKey: ['item_id'],
      rows: Array.from({ length: 7 }, (_, i) => ({ item_id: i + 1, biblio_id: (i % 5) + 1, item_code: `B${String(i + 1).padStart(5, '0')}` })),
      knownCount: false,
    },
    mst_author: {
      columns: ['author_id', 'author_name', 'authority_type'],
      primaryKey: ['author_id'],
      rows: [
        { author_id: 1, author_name: 'Hirata, Andrea', authority_type: 'p' },
        { author_id: 2, author_name: 'Tohari, Ahmad', authority_type: 'p' },
        { author_id: 3, author_name: 'Kurniawan, Eka', authority_type: 'p' },
      ],
    },
  };
}

/** An in-memory SlimsSource over `tables`: the cursor is the index of the next row. */
export function fakeSlimsSource(tables: Readonly<Record<string, FakeSlimsTable>>, kind: 'db' | 'dump' = 'db'): SlimsSource & { closed: number } {
  const source = {
    kind,
    closed: 0,
    async tables(): Promise<SlimsTableInfo[]> {
      return Object.entries(tables).map(([name, t]) => ({
        name,
        columns: [...t.columns],
        primaryKey: [...t.primaryKey],
        rows: t.knownCount === false ? null : t.rows.length,
      }));
    },
    async rows(table: string, after: string | null, limit: number): Promise<{ rows: SlimsRow[]; next: string | null }> {
      const t = Object.hasOwn(tables, table) ? tables[table]! : undefined;
      if (t === undefined) throw new Error(`fake SLiMS source: no table ${table}`);
      const start = after === null ? 0 : Number(after);
      const end = Math.min(t.rows.length, start + limit);
      return { rows: t.rows.slice(start, end).map((r) => ({ ...r })), next: end < t.rows.length ? String(end) : null };
    },
    async close(): Promise<void> {
      source.closed += 1;
    },
  };
  return source;
}

/**
 * A files source with no file at all, or (`files`) an in-memory one: each SLiMS-relative path with its bytes, served
 * whole, or refused past `maxBytes` with SlimsFileTooLargeError as the real sources do.
 */
export function fakeSlimsFiles(files: Readonly<Record<string, Uint8Array>> = {}): SlimsFilesSource {
  const of = (rel: string): Uint8Array | null => (Object.hasOwn(files, rel) ? files[rel]! : null);
  async function* bytes(rel: string, data: Uint8Array, maxBytes: number | undefined): AsyncGenerator<Uint8Array> {
    if (maxBytes !== undefined && data.byteLength > maxBytes) throw new SlimsFileTooLargeError(rel, maxBytes);
    yield data;
  }
  return {
    open: async (rel, o = {}) => {
      const data = of(rel);
      return data === null ? null : bytes(rel, data, o.maxBytes);
    },
    size: async (rel) => of(rel)?.byteLength ?? null,
    close: async () => {},
  };
}

export interface FakeSlimsFactory extends Partial<SlimsSourceFactory> {
  /** What the fakes were called with and how often. */
  calls: { openDb: number; split: number; staged: number; files: number; passwords: string[] };
}

/**
 * A factory over an in-memory source of `tables` (default: fakeSlimsTables()): `detectSlimsVersion` answers `version`
 * (default `'9'`); `openDbSource` fails with MIGRATION_SOURCE_UNREACHABLE when `unreachable` names a reason; the dump
 * path splits in two calls (a checkpoint, then done) unless `splitFails` throws from it.
 */
export function fakeSlimsFactory(
  o: {
    tables?: Record<string, FakeSlimsTable>;
    version?: '9' | '8' | 'unknown';
    unreachable?: string;
    splitFails?: Error;
    /** The files the files source serves (by SLiMS-relative path); none by default. */
    files?: Readonly<Record<string, Uint8Array>>;
  } = {},
): FakeSlimsFactory {
  const tables = o.tables ?? fakeSlimsTables();
  const calls: FakeSlimsFactory['calls'] = { openDb: 0, split: 0, staged: 0, files: 0, passwords: [] };
  const infos = (): SlimsTableInfo[] =>
    Object.entries(tables).map(([name, t]) => ({ name, columns: [...t.columns], primaryKey: [...t.primaryKey], rows: t.rows.length }));
  return {
    calls,
    async openDbSource(cfg) {
      calls.openDb += 1;
      calls.passwords.push(cfg.password);
      if (o.unreachable !== undefined) {
        throw new DomainError('MIGRATION_SOURCE_UNREACHABLE', { detail: 'unreachable', meta: { reason: o.unreachable } });
      }
      return fakeSlimsSource(tables, 'db');
    },
    async splitDump(s) {
      calls.split += 1;
      if (o.splitFails !== undefined) throw o.splitFails;
      // The checkpoints have the real splitDump's shape (staging file names, the rows seen, the headroom mark): the
      // framework must take them back as they are (Task 39).
      if (s.checkpoint === null) {
        const checkpoint: SplitCheckpoint = { offset: 10, files: { 'biblio.ndjson': 0, 'split_tables.ndjson': 40 }, rows: { biblio: 0 }, headroomAt: 0 };
        return { done: false, checkpoint, tables: [] };
      }
      const files = Object.fromEntries(Object.keys(tables).map((t) => [`${t}.ndjson`, 1]));
      return { done: true, checkpoint: { offset: 20, files, rows: Object.fromEntries(Object.keys(tables).map((t) => [t, 1])), headroomAt: 20 }, tables: infos() };
    },
    openStagedDumpSource() {
      calls.staged += 1;
      return fakeSlimsSource(tables, 'dump');
    },
    async openFilesZip() {
      calls.files += 1;
      return fakeSlimsFiles(o.files);
    },
    async openFilesDir() {
      calls.files += 1;
      return fakeSlimsFiles(o.files);
    },
    detectSlimsVersion: () => ({ version: o.version ?? '9', missing: [], unknownColumns: {} }),
  };
}

/**
 * A fake middle stage named `name` that reads `table` (`batch` rows per call, default 2) and counts each row as
 * migrated; with `write`, a real run maps each row in `migration_map` (entity `table`, the run's source name), as the
 * real stages do. `log` receives `<name>:<cursor>` per call.
 */
export function fakeCountingStage(
  name: SlimsStageName,
  table: string,
  o: { batch?: number; write?: boolean; log?: string[]; onCall?: (c: SlimsStageContext) => void | Promise<void> } = {},
): SlimsStage {
  return {
    name,
    reads: [table],
    async run(c, cursor) {
      o.log?.push(`${name}:${cursor ?? '-'}`);
      await o.onCall?.(c);
      const batch = await c.source.rows(table, cursor, o.batch ?? 2);
      c.counters.migrated(table, batch.rows.length);
      if (o.write === true && !c.dryRun && batch.rows.length > 0) {
        const key = Object.keys(batch.rows[0]!)[0]!; // the first column is the key in the fake tables
        await withTx(c.h, (trx) =>
          mapLegacy(
            trx,
            batch.rows.map((r) => ({ source: c.options.sourceName, entity: table, legacyKey: String(r[key]), targetId: newId(c.now), runId: c.runId })),
          ),
        );
      }
      return { done: batch.next === null, cursor: batch.next };
    },
  };
}

// ---- Komunitas K1 (usage tables) ----
// A fake SLiMS MySQL/MariaDB server for the direct-connection source, over the synthetic fixture's tables: the usage
// import's tests read the same rows through it as through the dump. SLiMS 9 table/column names (interoperability facts,
// no SLiMS code).

/** A cell as the foreign client hands it over: text as bytes, integers as numbers, dates as their text. */
export type FakeMysqlCell = Buffer | number | string | null;

/** A table of the fake server: its columns in order, its primary key and its rows. */
export interface FakeMysqlTable {
  columns: string[];
  primaryKey: string[];
  rows: Record<string, FakeMysqlCell>[];
}

/** The fake server: `connect` is the source's test seam; `log` holds every statement with its values. */
export interface FakeForeignMysql {
  connect: (cfg: ForeignMysqlConfig, o: { connectTimeoutMs: number }) => Promise<ForeignMysql>;
  log: { sql: string; params: unknown[] }[];
  /** What each connection was opened with. */
  opened: { cfg: ForeignMysqlConfig; connectTimeoutMs: number }[];
  readonly closed: number;
}

/** The comparable form of a key value as the fake server sees it. */
const fakeKey = (v: unknown): string | number => (Buffer.isBuffer(v) ? v.toString('utf8') : typeof v === 'number' ? v : String(v));

function compareKeys(a: readonly (string | number)[], b: readonly (string | number)[]): number {
  for (let i = 0; i < a.length; i += 1) {
    if (a[i]! < b[i]!) return -1;
    if (a[i]! > b[i]!) return 1;
  }
  return 0;
}

/**
 * A fake server that answers the statements the direct-connection source sends: the three information_schema reads,
 * `SELECT COUNT(*)`, and a SELECT of `??` columns with a keyset WHERE, an ORDER BY, a LIMIT and an OFFSET. Any other
 * statement throws, so a statement the source should not send fails the test.
 */
export function fakeForeignMysql(tables: ReadonlyMap<string, FakeMysqlTable>): FakeForeignMysql {
  const log: { sql: string; params: unknown[] }[] = [];
  const opened: { cfg: ForeignMysqlConfig; connectTimeoutMs: number }[] = [];
  const state = { closed: 0 };
  const b = (s: string): Buffer => Buffer.from(s, 'utf8');
  const db: ForeignMysql = {
    async query(sql, params) {
      log.push({ sql, params: [...params] });
      if (sql.includes('information_schema.TABLES')) return [...tables.keys()].map((t) => ({ name: b(t) }));
      if (sql.includes('information_schema.COLUMNS')) return [...tables].flatMap(([t, def]) => def.columns.map((c, i) => ({ tname: b(t), cname: b(c), position: i + 1 })));
      if (sql.includes('information_schema.STATISTICS')) return [...tables].flatMap(([t, def]) => def.primaryKey.map((c, i) => ({ tname: b(t), cname: b(c), seq: i + 1 })));
      if (sql === 'SELECT COUNT(*) AS n FROM ??') return [{ n: tables.get(params[0] as string)!.rows.length }];
      const m = /^SELECT ((?:\?\?, )*\?\?) FROM \?\?(?: WHERE \(((?:\?\?, )*\?\?)\) > \(((?:\?, )*\?)\))?(?: ORDER BY ((?:\?\?, )*\?\?))? LIMIT \?(?: OFFSET \?)?$/.exec(sql);
      if (m === null) throw new Error(`fake SLiMS server: unexpected statement ${sql}`);
      const ncols = m[1]!.split(', ').length;
      const columns = params.slice(0, ncols) as string[];
      const table = tables.get(params[ncols] as string)!;
      for (const c of columns) if (!table.columns.includes(c)) throw new Error(`fake SLiMS server: unknown column ${c}`);
      let at = ncols + 1;
      let rows = table.rows;
      let after: (string | number)[] | null = null;
      if (m[2] !== undefined) {
        const nkey = m[2].split(', ').length;
        after = params.slice(at + nkey, at + 2 * nkey).map(fakeKey);
        at += 2 * nkey;
      }
      if (m[4] !== undefined) {
        const nkey = m[4].split(', ').length;
        const keyColumns = params.slice(at, at + nkey) as string[];
        at += nkey;
        const of = (r: Record<string, unknown>): (string | number)[] => keyColumns.map((c) => fakeKey(r[c]));
        rows = [...rows].sort((x, y) => compareKeys(of(x), of(y)));
        if (after !== null) rows = rows.filter((r) => compareKeys(of(r), after) > 0);
      }
      const limit = params[at] as number;
      const offset = sql.endsWith('OFFSET ?') ? (params[at + 1] as number) : 0;
      return rows.slice(offset, offset + limit).map((r) => Object.fromEntries(columns.map((c) => [c, r[c] ?? null])));
    },
    async close() {
      state.closed += 1;
    },
  };
  return {
    connect: async (cfg, o) => {
      opened.push({ cfg, connectTimeoutMs: o.connectTimeoutMs });
      return db;
    },
    log,
    opened,
    get closed() {
      return state.closed;
    },
  };
}

/** A fixture cell as the foreign client returns it for a column of SQL type `type`. */
function mysqlCell(cell: FixtureCell | undefined, type: string): FakeMysqlCell {
  if (cell === undefined || cell === null) return null;
  if (/^(date|datetime|timestamp|time)\b/i.test(type)) return typeof cell === 'string' ? cell : null;
  if (/^(tinyint|smallint|mediumint|int|bigint)\b/i.test(type)) return typeof cell === 'number' ? cell : Number(cell);
  if (typeof cell === 'number') return Buffer.from(String(cell), 'utf8');
  if (typeof cell === 'string') return Buffer.from(cell, 'utf8');
  return Buffer.from(cell instanceof Uint8Array ? cell : cell.raw);
}

/**
 * The fixture's data as the fake server holds it: the tables `only` names (default every table of the fixture's
 * schema), with the schema's columns and keys, text as UTF-8 bytes (or the raw bytes of a non-UTF-8 cell).
 */
export function fixtureMysqlTables(data: FixtureData, only?: readonly string[]): Map<string, FakeMysqlTable> {
  const out = new Map<string, FakeMysqlTable>();
  for (const t of FIXTURE_TABLES) {
    if (only !== undefined && !only.includes(t.name)) continue;
    const columns = t.columns.map(([name]) => name);
    const rows = (data.rows.get(t.name) ?? []).map((row) => Object.fromEntries(t.columns.map(([name, type]) => [name, mysqlCell(Object.hasOwn(row, name) ? row[name] : undefined, type)])));
    out.set(t.name, { columns, primaryKey: [...t.primaryKey], rows });
  }
  return out;
}
