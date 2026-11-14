import { fork } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PHASE1_MIGRATIONS, runMigrations, withTx, type DB, type TableName } from '@altis/db';
import { newId } from '@altis/shared';
import type { MigrationSummary } from '@altis/shared/api/catalog/migration';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { tableChecksumFromDb } from '../../src/backup/canonical.js';
import { legacyTarget } from '../../src/catalog/data/legacy-map.js';
import type { CatalogJobDeps } from '../../src/catalog/jobs-deps.js';
import { txCtx, type Actor, type CoreLogger } from '../../src/context.js';
import type { KeyringEntry } from '../../src/crypto/secret-box.js';
import { localStorageDriver } from '../../src/files/serve.js';
import { claimById } from '../../src/jobs/claim.js';
import { createJobRegistry } from '../../src/jobs/registry.js';
import { runSlice } from '../../src/jobs/slice.js';
import { retryDelayMs } from '../../src/jobs/types.js';
import { createCounters } from '../../src/migration/slims/counters.js';
import { __setSlimsSourceFactory, __setSlimsStages } from '../../src/migration/slims/factory.js';
import { SLIMS_STAGES, startSlimsMigration, type SlimsStartInput } from '../../src/migration/slims/job.js';
import { slimsJobs } from '../../src/migration/slims/jobs.js';
import type { SlimsStage, SlimsStageContext } from '../../src/migration/slims/stage.js';
import { __setSlimsStageBatch } from '../../src/migration/slims/stages/stage-a-kit.js';
import { __setSlimsStageBBatch } from '../../src/migration/slims/stages/stage-b-kit.js';
import { writeSettings } from '../../src/settings/service.js';
import { wipeCatalog } from '../support/search-corpus.js';
import { buildSlimsFixture, type SlimsFixture } from '../support/slims-fixture/index.js';

// The SLiMS migration end to end (Phase 2 Task 39; spec §11, §15 K15) on the engine picked by ALTIS_TEST_DB: the
// synthetic fixture (Task 10: the dump and its files zip) through the real job, its real split, analyze and report and
// every real stage of Tasks 37 and 38 (no stage replaced):
//
// - a dry run writes no catalog row (every catalog table, the settings and the legacy map keep their checksums);
// - the full migration reconciles every table it reads (0 unexplained difference, the fixture's source counts), lists
//   the "Fase 3" and derived tables as unread, repairs the mojibake and backslash traps, keeps the orphan items, and its
//   20 check pairs all match (eight of them forced onto the fixture's title traps); each SLiMS biblio id leads through
//   the legacy map (`/index.php?p=show_detail&id=N`, apps/server's legacy.ts) to the record it became;
// - every middle stage "killed" right after its writes committed and before the framework saved its counts (the next
//   process redoes the calls from the same cursor: stages A and B alike count a replay as it was counted the first
//   time) ends with the same catalogue, legacy map, counts and report as the uninterrupted run;
// - a child process SIGKILLed after a batch of `records` committed, and a second one after a batch of `items`, resumed by
//   this process → the same legacy map, catalogue checksum, counts and report as the same run never killed.

const ctx = testDbContext();
const ROOT = path.resolve(import.meta.dirname, '../../../..');
const keyring: KeyringEntry[] = [{ kid: 'k1', key: randomBytes(32).toString('base64url'), active: true }];
const silent: CoreLogger = { info() {}, warn() {}, error() {} };
/** In the past: an audit entry may not be dated ahead of the real clock. Every run's clock stands here. */
const NOW = Date.UTC(2026, 9, 30, 9, 0, 0);
const LIBRARY = 'Perpustakaan Ujung ke Ujung';
/** Rows per batch of both stage kits in the stepped runs (one batch per slice). */
const STEP_BATCH = 100;

/** The report stage's random offsets (randomInt), forced for one run: the values given first, then random ones. */
const sample = vi.hoisted(() => ({ n: -1, forced: [] as number[] }));
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  const randomInt = ((...args: unknown[]): unknown => {
    if (args.length === 1 && args[0] === sample.n && sample.forced.length > 0) return sample.forced.shift();
    return (actual.randomInt as (...a: unknown[]) => unknown)(...args);
  }) as typeof actual.randomInt;
  return { ...actual, randomInt, default: { ...actual, randomInt } };
});

/** Every table a migration may write besides its run: what a dry run must leave as it is (`files` apart). */
const CATALOG_TABLES = [
  'languages',
  'material_types',
  'publishers',
  'agents',
  'subjects',
  'subject_relations',
  'records',
  'record_identifiers',
  'record_marc_extra',
  'record_agents',
  'record_subjects',
  'record_relations',
  'attachments',
  'locations',
  'collection_types',
  'suppliers',
  'items',
  'item_events',
  'pages',
  'page_translations',
  'search_doc',
  'search_facet',
  'search_term',
  'search_state',
  'migration_map',
  'migration_archive',
  'custom_field_defs',
  'custom_values',
  'settings',
] as const satisfies readonly TableName[];

/** The tables whose rows the canonical snapshot holds (ids replaced by names). */
const SNAPSHOT_TABLES = [
  'languages',
  'material_types',
  'publishers',
  'agents',
  'subjects',
  'subject_relations',
  'records',
  'record_identifiers',
  'record_agents',
  'record_subjects',
  'record_relations',
  'attachments',
  'locations',
  'collection_types',
  'suppliers',
  'items',
  'item_events',
  'pages',
  'page_translations',
  'search_doc',
  'search_facet',
  'migration_archive',
  'custom_field_defs',
  'custom_values',
] as const satisfies readonly (keyof DB)[];

/** A ULID inside a text (a `/files/<id>` link of a page, a facet's value). */
const ULID_IN_TEXT = /[0-9A-HJKMNP-TV-Z]{26}/g;

/**
 * `stage`, whose first call runs once more after a "crash": its writes commit, but its counts and report rows are lost
 * with the process (the framework saves them only after the slice), so the framework calls it again from the same
 * cursor, as the next process would. Every call of a stage run with the default budget does the whole stage, so the
 * second call replays every batch of it.
 */
function killedOnce(stage: SlimsStage): SlimsStage {
  let killed = false;
  return {
    name: stage.name,
    reads: stage.reads,
    async run(c, cursor) {
      if (!killed) {
        killed = true;
        const lost: SlimsStageContext = { ...c, counters: createCounters(null), report: () => {} };
        await stage.run(lost, cursor);
      }
      return stage.run(c, cursor);
    },
  };
}

describe.skipIf(!ctx.available)(`SLiMS migration end to end (K15) [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let root: string;
  let dataDir: string;
  let branchId: string;
  let staff: Actor;
  let fixture: SlimsFixture;
  let seeds: Record<'material_types' | 'languages' | 'collection_types', string[]>;
  const deps = (): CatalogJobDeps => ({ dataDir, baseUrl: 'https://perpus.example.sch.id/', keyring, storage: localStorageDriver(dataDir), log: silent });
  const registry = createJobRegistry(slimsJobs(deps));

  beforeAll(async () => {
    h = await testDb();
    root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-slims-e2e-')));
    dataDir = path.join(root, 'data');
    await fsp.mkdir(dataDir, { recursive: true });
    await runMigrations(h, { appVersion: '0.1.0', dataDir: path.join(root, 'migrations'), migrations: PHASE1_MIGRATIONS });
    await wipeCatalog(h);
    for (const table of ['migration_map', 'migration_archive', 'catalog_runs', 'suppliers'] as const) await h.db.deleteFrom(table).execute();
    branchId = newId(NOW);
    await h.db
      .insertInto('branches')
      .values({ id: branchId, code_key: 'UJUNG', code_display: 'UJUNG', name: LIBRARY, timezone: 'Asia/Jakarta', is_default: 0, created_at: NOW, updated_at: NOW })
      .execute();
    const staffId = newId(NOW);
    await h.db
      .insertInto('staff_users')
      .values({ id: staffId, username_key: 'MIGRATOR-E2E', username_display: 'migrator-e2e', name: 'migrator', password_hash: 'x', status: 'active', created_at: NOW, updated_at: NOW })
      .execute();
    staff = { type: 'staff', id: staffId, ip: null };
    // S10 with the fixture's oversized entry: catalog.attachment.maxMb 1.
    await withTx(h, (trx) => writeSettings(trx, { 'catalog.attachment.maxMb': 1, 'library.name': LIBRARY }, { now: NOW, actorId: null, keyring: [] }));
    fixture = await buildSlimsFixture(path.join(root, 'fixture'));
    seeds = {
      material_types: (await h.db.selectFrom('material_types').select('id').execute()).map((r) => r.id),
      languages: (await h.db.selectFrom('languages').select('id').execute()).map((r) => r.id),
      collection_types: (await h.db.selectFrom('collection_types').select('id').execute()).map((r) => r.id),
    };
    // The real sources and stages: no test seam replaces any of them.
    __setSlimsSourceFactory(null);
    __setSlimsStages(null);
  }, 120_000);

  afterEach(() => {
    __setSlimsStages(null);
    __setSlimsStageBatch(null);
    __setSlimsStageBBatch(null);
    sample.forced = [];
    sample.n = -1;
  });

  afterAll(async () => {
    __setSlimsStages(null);
    if (h !== undefined) {
      await wipe();
      await h.close();
    }
    if (root !== undefined) await fsp.rm(root, { recursive: true, force: true });
  });

  /** Removes everything a migration wrote: the catalogue back to the seeded masters, the runs, the blobs. */
  async function wipe(): Promise<void> {
    await h.db.deleteFrom('page_translations').execute();
    await h.db.deleteFrom('pages').execute();
    await wipeCatalog(h);
    for (const table of ['migration_map', 'migration_archive', 'catalog_runs', 'suppliers'] as const) await h.db.deleteFrom(table).execute();
    for (const table of ['material_types', 'languages', 'collection_types'] as const) await h.db.deleteFrom(table).where('id', 'not in', seeds[table]).execute();
    await h.db.deleteFrom('settings').where('key', 'in', ['catalog.sru.servers', 'catalog.barcode.patterns']).execute();
    await fsp.rm(dataDir, { recursive: true, force: true });
    await fsp.mkdir(dataDir, { recursive: true });
  }

  /** `bytes` as a staged upload (`tmp/<id>/upload.bin`), its id. */
  async function staged(bytes: Buffer): Promise<string> {
    const id = newId(NOW);
    await fsp.mkdir(path.join(dataDir, 'tmp', id), { recursive: true });
    await fsp.writeFile(path.join(dataDir, 'tmp', id, 'upload.bin'), bytes);
    return id;
  }

  /** Starts a migration of the fixture's dump and files zip (as two uploads). */
  async function start(o: { dryRun?: boolean } = {}): Promise<{ runId: string; jobId: string }> {
    const input: SlimsStartInput = {
      dryRun: o.dryRun ?? false,
      sourceKind: 'dump',
      db: null,
      password: null,
      dumpStagingId: await staged(await fsp.readFile(fixture.dumpGzPath)),
      files: 'zip',
      filesStagingId: await staged(await fsp.readFile(fixture.filesZipPath)),
      filesDir: null,
      branchId,
      priceMode: 'major',
      sourceName: 'slims',
      allowNonEmpty: false,
      confirmLibraryName: null,
      fromRunId: null,
    };
    return withTx(h, (trx) => startSlimsMigration(txCtx(trx, NOW, staff), registry, input, { keyring }));
  }

  /**
   * Runs job `id` slice by slice until it ends: the split and analyze slices get 20 s, every other `budgetMs` (2 000 =
   * the framework's save margin: one stage call per slice, one batch or file per call).
   */
  async function runToEnd(id: string, budgetMs = 20_000): Promise<string> {
    for (let slices = 1; slices <= 3000; slices += 1) {
      const payload = JSON.parse((await h.db.selectFrom('jobs').select('payload').where('id', '=', id).executeTakeFirstOrThrow()).payload) as { stage: number };
      const job = await claimById(h, registry, id, { worker: 'test', now: NOW });
      if (job === null) throw new Error(`job ${id} cannot be claimed`);
      const r = await runSlice(h, registry, job, { mode: 'worker', budgetMs: payload.stage < 2 ? 20_000 : budgetMs, keyring, log: silent, clock: () => NOW, env: {} });
      if (r.outcome !== 'continued') return r.outcome;
    }
    throw new Error('no end after 3000 slices');
  }

  interface Ended {
    runId: string;
    summary: MigrationSummary;
    /** The stages' report rows (after the framework's own rows), each as its cells. */
    rows: string[][];
    snapshot: Record<string, unknown>;
  }

  async function ended(runId: string): Promise<Ended> {
    const run = await h.db.selectFrom('catalog_runs').select(['status', 'summary', 'report_file_id']).where('id', '=', runId).executeTakeFirstOrThrow();
    expect(run.status).toBe('succeeded');
    return { runId, summary: JSON.parse(run.summary) as MigrationSummary, rows: await stageRows(run.report_file_id), snapshot: await snapshot() };
  }

  async function migrate(o: { dryRun?: boolean; budgetMs?: number } = {}): Promise<Ended> {
    const { runId, jobId } = await start(o);
    expect(await runToEnd(jobId, o.budgetMs)).toBe('succeeded');
    return ended(runId);
  }

  /** The report file `fileId` as rows of cells (BOM and CRLF stripped, the `"` quoting undone). */
  async function reportRows(fileId: string | null): Promise<string[][]> {
    if (fileId === null) throw new Error('the run has no report');
    const chunks: Buffer[] = [];
    for await (const c of (await localStorageDriver(dataDir).get(fileId))!) chunks.push(Buffer.from(c));
    const text = Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, '');
    const rows: string[][] = [];
    let row: string[] = [];
    let cell = '';
    let quoted = false;
    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i]!;
      if (quoted) {
        if (ch === '"' && text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else if (ch === '"') quoted = false;
        else cell += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === ',') {
        row.push(cell);
        cell = '';
      } else if (ch === '\r') continue;
      else if (ch === '\n') {
        row.push(cell);
        rows.push(row);
        row = [];
        cell = '';
      } else cell += ch;
    }
    return rows;
  }

  /** The stages' own report rows: after the framework's rows, which end with the fixed `phase3_tables` row. */
  async function stageRows(fileId: string | null): Promise<string[][]> {
    const rows = await reportRows(fileId);
    const end = rows.findIndex((r) => r[2] === 'phase3_tables');
    expect(end).toBeGreaterThan(0);
    return rows.slice(end + 1);
  }

  /**
   * The catalogue as a run left it, without its random ids: each row of SNAPSHOT_TABLES (sorted), every id named by the
   * first legacy key that maps to it (`biblio:7`, `mst_author:12`, ...) or, for a seeded master no row maps to, by its
   * code; the legacy map; the settings a migration writes; the stored files but the runs' reports.
   */
  async function snapshot(): Promise<Record<string, unknown>> {
    const names = new Map<string, string>();
    const maps = (await h.db.selectFrom('migration_map').select(['source', 'entity', 'legacy_key', 'target_id']).execute()).sort((a, b) => {
      const x = `${a.entity}\u0000${a.legacy_key}`;
      const y = `${b.entity}\u0000${b.legacy_key}`;
      return x < y ? -1 : x > y ? 1 : 0;
    });
    for (const m of maps) if (!names.has(m.target_id)) names.set(m.target_id, `${m.entity}:${m.legacy_key}`);
    for (const t of ['material_types', 'languages', 'collection_types', 'suppliers', 'locations'] as const) {
      for (const r of await h.db.selectFrom(t).select(['id', 'code_key']).execute()) if (!names.has(r.id)) names.set(r.id, `${t}:${r.code_key}`);
    }
    for (const r of await h.db.selectFrom('catalog_runs').select('id').execute()) names.set(r.id, 'run');
    names.set(branchId, 'branch');
    const files = await h.db.selectFrom('files').selectAll().where('context', '<>', 'catalog.report').execute();
    // A file is named by its owner and its context (an attachment's, a cover's, a page image's).
    for (const f of files) if (!names.has(f.id)) names.set(f.id, `file:${f.context}:${names.get(f.owner_id ?? '') ?? f.owner_id ?? '-'}:${f.sha256}`);
    const name = (v: unknown): unknown => {
      if (typeof v === 'string') return names.get(v) ?? v.replace(ULID_IN_TEXT, (u) => names.get(u) ?? u);
      if (v instanceof Uint8Array) return Buffer.from(v).toString('hex');
      if (typeof v === 'bigint') return Number(v);
      return v;
    };
    const canon = (row: Record<string, unknown>, drop: readonly string[]): string =>
      JSON.stringify(Object.fromEntries(Object.entries(row).filter(([k]) => !drop.includes(k)).map(([k, v]) => [k, name(v)])));
    const out: Record<string, unknown> = {};
    out['migration_map'] = maps.map((m) => `${m.source}|${m.entity}|${m.legacy_key}|${String(name(m.target_id))}`);
    for (const t of SNAPSHOT_TABLES) {
      const rows = (await h.db.selectFrom(t as 'records').selectAll().execute()) as unknown as Record<string, unknown>[];
      // A document's texts as sets of words: an item's words come in the order of the item ids, which the processes
      // of a run killed twice made at the same instant of its standing clock (ULIDs of different processes).
      const words = (r: Record<string, unknown>): Record<string, unknown> =>
        t !== 'search_doc' ? r : Object.fromEntries(Object.entries(r).map(([k, v]) => [k, k.startsWith('t_') && typeof v === 'string' ? v.split(' ').sort().join(' ') : v]));
      out[t] = rows.map((r) => canon(words(r), ['id', 'doc_no'])).sort();
    }
    out['files'] = files.map((f) => canon(f as unknown as Record<string, unknown>, ['id'])).sort();
    out['settings'] = (await h.db.selectFrom('settings').select(['key', 'value']).where('key', 'in', ['catalog.sru.servers', 'catalog.barcode.patterns']).execute())
      .map((s) => `${s.key}=${s.value}`)
      .sort();
    return out;
  }

  /** The checksum of every table of CATALOG_TABLES, and the rows of `files` but the runs' reports. */
  async function catalogChecksums(): Promise<Record<string, string | number>> {
    const out: Record<string, string | number> = {};
    for (const t of CATALOG_TABLES) out[t] = await tableChecksumFromDb(h.db, h.dialect, t);
    out['files'] = Number(
      (await h.db.selectFrom('files').select((eb) => eb.fn.countAll<number>().as('n')).where('context', '<>', 'catalog.report').executeTakeFirstOrThrow()).n,
    );
    return out;
  }

  /** Two snapshots hold the same rows, table by table (the legacy map first). */
  function expectSameCatalogue(actual: Record<string, unknown>, expected: Record<string, unknown>): void {
    expect(Object.keys(actual).sort()).toEqual(Object.keys(expected).sort());
    for (const table of Object.keys(expected)) expect(actual[table], table).toEqual(expected[table]);
  }

  /** What two runs must have the same of: the counts, the repairs, the files and barcodes summed up, the report. */
  const outcome = (e: Ended) => ({
    tables: e.summary.tables,
    unread: e.summary.unread,
    fixes: e.summary.fixes,
    samples: e.summary.samples,
    missingFiles: e.summary.missingFiles,
    nonstandardBarcodes: e.summary.nonstandardBarcodes,
    warnings: e.summary.warnings,
    rows: e.rows,
  });

  // ---------------------------------------------------------------------------------------------------------------

  it('a dry run of the dump and the files zip writes no catalog row, and reconciles', async () => {
    await wipe();
    const before = await catalogChecksums();
    const dry = await migrate({ dryRun: true });
    expect(await catalogChecksums()).toEqual(before);
    expect(dry.summary.reconciliation?.ok).toBe(true);
    expect(dry.summary.tables['biblio']).toMatchObject({ source: 300, migrated: 300 });
    expect(dry.summary.checks).toEqual([]);
  }, 300_000);

  let whole: Ended;

  it('the full migration reconciles every table it reads, keeps the traps right, and its 20 check pairs match', async () => {
    await wipe();
    // The check sample: eight of the 20 forced onto the title traps (split titles, mojibake, backslashes), the rest
    // random. The report stage picks offsets into the run's `biblio` map rows ordered by legacy key (byte order).
    const ordered = Array.from({ length: 300 }, (_, i) => String(i + 1)).sort();
    const traps = fixture.expected.traps;
    const titleKeys = [
      ...traps.titles.map((t) => String(t.biblioId)),
      ...[...traps.mojibake, ...traps.backslash].filter((t) => t.table === 'biblio' && t.column === 'title').map((t) => t.key),
    ];
    const forced = [...new Set(titleKeys)];
    expect(forced).toEqual(expect.arrayContaining(['1', '2', '4', '18', '22', '23', '24', '34']));
    sample.n = 300;
    sample.forced = forced.map((k) => ordered.indexOf(k));
    whole = await migrate();
    expect(sample.forced).toEqual([]);
    const s = whole.summary;

    // §11.6: 0 unexplained difference, every table read with the fixture's own count.
    expect(s.reconciliation?.ok).toBe(true);
    expect(s.warnings).toEqual([]);
    const roles = fixture.expected.roles;
    for (const table of [...roles.read, ...roles.archived, ...roles.people]) {
      const row = s.reconciliation!.tables.find((t) => t.table === table);
      expect(row, table).toBeDefined();
      expect([table, row!.diff, row!.source, row!.unread]).toEqual([table, 0, fixture.expected.tables[table]!.source, false]);
    }
    for (const table of roles.archived) expect([table, s.tables[table]!.archived]).toEqual([table, fixture.expected.tables[table]!.source]);
    for (const table of [...roles.phase3, ...roles.derived]) {
      expect(s.unread, table).toContain(table);
      expect([table, s.tables[table]?.source]).toEqual([table, fixture.expected.tables[table]!.source]);
    }

    // The 20 check pairs (§11.6), each SLiMS title compared with its record's, all matching: a repaired title matches
    // the cleaned SLiMS one.
    expect(s.checks).toHaveLength(20);
    expect(s.checks.filter((c) => !c.matches)).toEqual([]);
    expect(s.checks.map((c) => c.legacyId)).toEqual(expect.arrayContaining(forced));

    // Mojibake and backslashes repaired (§11.5); the orphan items kept under hidden placeholders (§11.4).
    for (const t of [...traps.mojibake, ...traps.backslash].filter((x) => x.table === 'biblio' && x.column === 'title')) {
      const record = await h.db.selectFrom('records').select(['title', 'subtitle']).where('id', '=', (await legacyTarget(h.db, 'slims', 'biblio', t.key))!).executeTakeFirstOrThrow();
      expect([t.key, record.subtitle === null ? record.title : `${record.title}: ${record.subtitle}`]).toEqual([t.key, t.clean]);
    }
    for (const t of [...traps.mojibake, ...traps.backslash].filter((x) => x.table === 'mst_author')) {
      const agent = await h.db.selectFrom('agents').select('name_display').where('id', '=', (await legacyTarget(h.db, 'slims', 'mst_author', t.key))!).executeTakeFirstOrThrow();
      expect([t.key, agent.name_display]).toEqual([t.key, t.clean]);
    }
    expect(Number((await h.db.selectFrom('items').select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow()).n)).toBe(fixture.expected.tables['item']!.source);
    for (const o of traps.orphans.items) {
      const item = await h.db.selectFrom('items').select('record_id').where('id', '=', (await legacyTarget(h.db, 'slims', 'item', String(o.itemId)))!).executeTakeFirstOrThrow();
      const placeholder = await h.db.selectFrom('records').select(['opac_visible', 'source']).where('id', '=', item.record_id).executeTakeFirstOrThrow();
      expect([o.itemId, Number(placeholder.opac_visible), placeholder.source]).toEqual([o.itemId, 0, `slims:${o.biblioId}`]);
    }
  }, 300_000);

  it('/index.php?p=show_detail&id=N: every SLiMS biblio id leads through the legacy map to the record it became', async () => {
    const records = new Map((await h.db.selectFrom('records').select(['id', 'source', 'title']).execute()).map((r) => [r.id, r]));
    for (let n = 1; n <= 300; n += 1) {
      const target = await legacyTarget(h.db, 'slims', 'biblio', String(n));
      expect([n, target === null ? null : records.get(target)?.source]).toEqual([n, `slims:${n}`]);
    }
    for (const c of whole.summary.checks) expect(await legacyTarget(h.db, 'slims', 'biblio', c.legacyId)).toBe(c.recordId);
    expect(await legacyTarget(h.db, 'slims', 'biblio', '9999')).toBeNull();
  }, 60_000);

  it('every stage killed after its writes committed and before its counts were saved → the same catalogue, counts and report (stages A and B agree)', async () => {
    await wipe();
    __setSlimsStages(SLIMS_STAGES.slice(2, -1).map(killedOnce));
    const killed = await migrate();
    expectSameCatalogue(killed.snapshot, whole.snapshot);
    expect(outcome(killed)).toEqual(outcome(whole));
  }, 600_000);

  it('a process SIGKILLed after a batch of records committed, and another after a batch of items, resumed → the same migration_map, checksums, counts and report', async () => {
    // The same run never killed: the same batches, one per slice.
    await wipe();
    __setSlimsStageBatch(STEP_BATCH);
    __setSlimsStageBBatch(STEP_BATCH);
    const steady = await migrate({ budgetMs: 2_000 });

    await wipe();
    const { runId, jobId } = await start();
    const mapped = async (entity: string): Promise<number> =>
      Number(
        (await h.db.selectFrom('migration_map').select((eb) => eb.fn.countAll<number>().as('n')).where('run_id', '=', runId).where('entity', '=', entity).executeTakeFirstOrThrow()).n,
      );
    const counted = async (table: string): Promise<number> => {
      const summary = JSON.parse((await h.db.selectFrom('catalog_runs').select('summary').where('id', '=', runId).executeTakeFirstOrThrow()).summary) as Partial<MigrationSummary>;
      return summary.tables?.[table]?.migrated ?? 0;
    };

    // A slice runs batches until its 2 s budget is spent, so a fast machine may commit more than one before the save
    // the child waits at: the kill lands on whole batches that are stored and not yet counted, whatever their number.
    const wholeBatches = (n: number, total: number): void => {
      expect(n % STEP_BATCH === 0 || n === total, `${String(n)} rows, whole batches of ${String(STEP_BATCH)}`).toBe(true);
      expect(n).toBeGreaterThanOrEqual(STEP_BATCH);
    };

    // 1. Killed after a `biblio` batch committed, before the slice saved its counts.
    await killedChild(jobId, 'records', async () => (await mapped('biblio')) > 0);
    wholeBatches(await mapped('biblio'), 300);
    expect(await mapped('biblio')).toBeLessThan(300);
    expect(await counted('biblio')).toBe(0);
    await leaseRunsOut(jobId);

    // 2. The next process redoes that batch, goes on, and is killed after its first `item` batch committed.
    await killedChild(jobId, 'items', async () => (await mapped('item')) > 0);
    expect(await mapped('biblio')).toBe(300);
    wholeBatches(await mapped('item'), Number.POSITIVE_INFINITY);
    expect(await counted('item')).toBe(0);
    await leaseRunsOut(jobId);

    // 3. This process resumes the run to its end.
    expect(await runToEnd(jobId, 2_000)).toBe('succeeded');
    const resumed = await ended(runId);
    expectSameCatalogue(resumed.snapshot, steady.snapshot);
    expect(outcome(resumed)).toEqual(outcome(steady));
  }, 600_000);

  /**
   * Runs job `jobId` in a child process (slims-migrate-child.mjs, the stepped batches) and SIGKILLs it as soon as
   * `until()` holds: the child waits before the save of each slice that ran a batch of `stage`.
   */
  async function killedChild(jobId: string, stage: string, until: () => Promise<boolean>): Promise<void> {
    const child = fork(
      path.join(import.meta.dirname, '../fixtures/slims-migrate-child.mjs'),
      [JSON.stringify({ config: h.config, dbDataDir: h.dataDir, dataDir, jobId, now: NOW, batch: STEP_BATCH, pauseStage: stage, pauseMs: 10_000 })],
      { cwd: ROOT, env: process.env, execArgv: ['--import', 'tsx'], stdio: ['ignore', 'inherit', 'inherit', 'ipc'] },
    );
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.once('close', (code, signal) => resolve({ code, signal })));
    try {
      await new Promise<void>((resolve, reject) => {
        child.once('message', (m) => (m === 'ready' ? resolve() : reject(new Error(`unexpected ${String(m)}`))));
        child.once('exit', (code) => reject(new Error(`the child exited (${String(code)}) before it was ready`)));
      });
      child.send('go');
      const deadline = Date.now() + 240_000;
      while (Date.now() < deadline && child.exitCode === null) {
        if (await until()) {
          child.kill('SIGKILL');
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    expect(await closed).toEqual({ code: null, signal: 'SIGKILL' });
  }

  /**
   * The dead child's lease and its `jobs:heavy` lock run out (they would 50 s and a backoff after the kill; the clock of
   * the runs stands still, so they are moved back instead).
   */
  async function leaseRunsOut(jobId: string): Promise<void> {
    const job = await h.db.selectFrom('jobs').select(['status', 'attempts']).where('id', '=', jobId).executeTakeFirstOrThrow();
    expect(job.status).toBe('running');
    await h.db
      .updateTable('jobs')
      .set({ locked_until: NOW - retryDelayMs(Number(job.attempts)) - 1_000 })
      .where('id', '=', jobId)
      .execute();
    await h.db.updateTable('locks').set({ until: NOW - 1_000 }).where('name', '=', 'jobs:heavy').execute();
  }
});
