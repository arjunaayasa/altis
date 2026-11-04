import { withTx } from '@altis/db';
import { DomainError, newId } from '@altis/shared';
import { mapLegacy } from '../../src/catalog/data/legacy-map.js';
import type { SlimsSourceFactory } from '../../src/migration/slims/factory.js';
import type { SlimsFilesSource, SlimsRow, SlimsSource, SlimsTableInfo, SplitCheckpoint } from '../../src/migration/slims/source/types.js';
import type { SlimsStage, SlimsStageContext, SlimsStageName } from '../../src/migration/slims/stage.js';

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

/** A files source with no file at all. */
export function fakeSlimsFiles(): SlimsFilesSource {
  return { open: async () => null, size: async () => null, close: async () => {} };
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
  o: { tables?: Record<string, FakeSlimsTable>; version?: '9' | '8' | 'unknown'; unreachable?: string; splitFails?: Error } = {},
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
      return fakeSlimsFiles();
    },
    async openFilesDir() {
      calls.files += 1;
      return fakeSlimsFiles();
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
