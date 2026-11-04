import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  SCHEDULES,
  claimById,
  createJobRegistry,
  createOpsMachine,
  createSqliteSwap,
  ensureSystemRoles,
  legacyTarget,
  localStorageDriver,
  restoreKind,
  runSlice,
  searchCatalog,
  seedSchedules,
  slimsJobs,
  startSlimsMigration,
  tableChecksumFromDb,
  txCtx,
  writeSettings,
  type BackupManifest,
  type CatalogJobDeps,
  type OpsMachine,
  type SlimsStartInput,
} from '@altis/core';
import { PHASE1_MIGRATIONS, connect, runMigrations, withTx, type DbConfig, type DbHandle, type TableName } from '@altis/db';
import { newId } from '@altis/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { serverBackup } from '../../../../packages/core/test/fixtures/restore-support.js';
import { finishSeededIndex, seedCatalog, type SeedRecord } from '../../../../packages/core/test/support/search-corpus.js';
import { buildSlimsFixture } from '../../../../packages/core/test/support/slims-fixture/index.js';
import { testDbConfig, testDbContext, testDbFor, type TestEngine } from '../../../../tools/test/test-db.js';
import { writeConfig, type Config } from '../../src/config.js';
import { csrfKey } from '../../src/http/csrf.js';
import { start } from '../../src/index.js';
import { bootContext, closeTestServers, httpRequest, sampleConfig, useDataDir } from '../support.js';

// K1 (Phase 2 Task 39; spec §2.3, §4.8, §15 K1) on the engine picked by ALTIS_TEST_DB, SQLite first (its restore
// swaps a work file into place, decision C17): an installation with a migrated SLiMS catalogue (the synthetic fixture's
// dump and files zip: records, items, attachments and covers with their blobs, pages, `migration_map`,
// `migration_archive`) and 1 000 more records, each with a word of its own in its title, indexed; a server backup with
// its blobs; then changes the restore must undo. Across dialects (the CI's restore pairs, as restore-matrix.test.ts):
// with ALTIS_TEST_DB_SOURCE naming another engine, the installation and its backup are made on that engine in a
// DATA_DIR of their own, and the backup (with its blobs) is restored into the same installation moved to the
// ALTIS_TEST_DB engine, whose database holds a catalogue of its own the restore replaces. After the restore:
//
// - the `data` checksums of every catalog table, the runs, `migration_*`, `files` and the settings are the backup's,
//   and every stored blob is back with its SHA-256;
// - the search tables (volatile, §2.3) are empty;
// - the server's boot queues `catalog.reindex {scope: 'all'}` by itself (catalogBoot), the cron pass builds it, and
//   then every one of the 1 000 records is found by its own word, every record has its search document, and the OPAC
//   answers a search with the record and an old SLiMS link `/index.php?p=show_detail&id=N` (K15) with a 301 to the
//   record biblio N became.

const engine = testDbContext();
/** Where the restore goes (ALTIS_TEST_DB), and where the installation and its backup are made (ALTIS_TEST_DB_SOURCE). */
const TARGET: TestEngine = engine.engine;
const SOURCE: TestEngine = engine.source ?? engine.engine;
const CROSS = SOURCE !== TARGET;
const READY = engine.available && (engine.source === null || engine.sourceAvailable);
const LABEL = READY
  ? `${SOURCE} → ${TARGET}`
  : `${SOURCE} → ${TARGET}, SKIPPED: ${(!engine.available ? engine.reason : engine.sourceReason) ?? 'not available'}`;
const dbConfigOf = (e: TestEngine): DbConfig => (e === 'sqlite' ? { dialect: 'sqlite' } : testDbConfig(engine, e));
const dirs = useDataDir();
const silent = { info() {}, warn() {}, error() {} };
const RECORDS = 1000;
/** The catalog tables of Phase 2 (class data), the runs, the legacy map and archive, files and settings. */
const DATA_TABLES = [
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
  'custom_field_defs',
  'custom_values',
  'catalog_runs',
  'migration_map',
  'migration_archive',
  'files',
  'settings',
] as const satisfies readonly TableName[];
const SEARCH_TABLES = ['search_doc', 'search_facet', 'search_term', 'search_state'] as const satisfies readonly TableName[];

afterEach(async () => {
  await closeTestServers();
  vi.unstubAllEnvs();
});

/** The word of its own the record `n` carries in its title: no record's word starts another's. */
const wordOf = (n: number): string => `penanda${n}x`;

describe.skipIf(!READY)(`backup → restore → the boot's reindex → the catalogue searchable again (K1) [${LABEL}]`, () => {
  it(
    'the catalog tables, migration_* and the blobs come back as backed up; the search tables empty; the boot queues the reindex; every record found again',
    async () => {
      // The installation the restore goes into and the server boots (TARGET), and where its backup is made (SOURCE:
      // the same DATA_DIR and database on one engine; across dialects a DATA_DIR and database of their own).
      const dataDir = dirs.dataDir;
      const sourceDir = CROSS ? path.join(dirs.root, 'source-data') : dataDir;
      await fsp.mkdir(dataDir, { recursive: true });
      await fsp.mkdir(sourceDir, { recursive: true });
      const sourceDb = dbConfigOf(SOURCE);
      const targetDb = dbConfigOf(TARGET);
      if (SOURCE !== 'sqlite') await (await testDbFor(SOURCE, { dataDir: sourceDir })).close(); // an empty database
      const config = sampleConfig({ db: sourceDb });
      /** The same installation (its install id, keyring and session key) on the target's database. */
      const targetConfig: Config = { ...config, db: targetDb };
      await writeConfig(sourceDir, config);
      const openSource = (): Promise<DbHandle> => connect(sourceDb, { runtime: 'standalone', purpose: 'cli', dataDir: sourceDir });
      const open = (): Promise<DbHandle> => connect(targetDb, { runtime: 'standalone', purpose: 'cli', dataDir });
      const sourceStorage = localStorageDriver(sourceDir);
      const storage = localStorageDriver(dataDir);
      const now = Date.now() - 60_000;

      // ---- The installation: a SLiMS migration of the fixture, then 1 000 more records, indexed. ----------------
      const fixture = await buildSlimsFixture(path.join(dirs.root, 'fixture'));
      const seeded = new Map<string, string>();
      let h = await openSource();
      try {
        await runMigrations(h, { appVersion: '0.1.0', dataDir, migrations: PHASE1_MIGRATIONS });
        const branchId = newId(now);
        const staffId = newId(now);
        await withTx(h, async (trx) => {
          await ensureSystemRoles(trx, now);
          await seedSchedules(trx, now, 'Asia/Jakarta', SCHEDULES);
          await writeSettings(trx, { 'library.name': 'Perpustakaan Pulih' }, { keyring: config.keyring, now, actorId: null });
          await trx
            .insertInto('branches')
            .values({ id: branchId, code_key: 'PUSAT', code_display: 'PUSAT', name: 'Pusat', timezone: 'Asia/Jakarta', is_default: 1, version: 1, created_at: now, updated_at: now })
            .execute();
          await trx
            .insertInto('staff_users')
            .values({ id: staffId, username_key: 'pustakawan', username_display: 'pustakawan', name: 'Pustakawan', password_hash: 'x', status: 'active', created_at: now, updated_at: now })
            .execute();
          await trx.updateTable('schema_meta').set({ install_id: config.install.id }).where('id', '=', 1).execute();
        });
        await migrateFixture(h, { dataDir: sourceDir, branchId, staffId, now, keyring: config.keyring, dump: fixture.dumpGzPath, zip: fixture.filesZipPath });
        const records: SeedRecord[] = Array.from({ length: RECORDS }, (_, i) => ({
          key: `uji-${i + 1}`,
          title: `Kumpulan Tulisan ${wordOf(i + 1)}`,
          agents: [`Penulis ${i % 37}`],
          subjects: [`Topik ${i % 23}`],
          year: String(1990 + (i % 30)),
          items: i % 4 === 0 ? [{ barcode: `UJI${String(i + 1).padStart(5, '0')}` }] : [],
        }));
        for (const [key, id] of await seedCatalog(h, records, { now, branchId })) seeded.set(key, id);
        await finishSeededIndex(h, now);
        expect(await rowsOf(h, 'search_doc')).toBe(await rowsOf(h, 'records'));
      } finally {
        await h.close();
      }

      // ---- The backup (its blobs too), what it holds, and changes after it. --------------------------------------
      h = await openSource();
      let backupId: string;
      let manifest: BackupManifest;
      let before: Record<string, string>;
      let blobs: Map<string, string>;
      let changedFile: string | null = null;
      try {
        ({ backupId, manifest } = await serverBackup(h, {
          dataDir: sourceDir,
          installId: config.install.id,
          sessionKey: csrfKey(config),
          kids: config.keyring.map((k) => k.kid),
          includeFiles: true,
        }));
        expect(manifest.dialect).toBe(h.dialect);
        before = await checksums(h);
        blobs = await storedBlobs(h, sourceStorage);
        // The migration's attachments and covers, and its report: blobs the backup carries.
        expect(blobs.size).toBeGreaterThan(5);
        for (const table of DATA_TABLES) expect(manifest.tables[table]?.checksum, table).toBe(before[table]);

        if (!CROSS) {
          // After the backup: a record archived, a legacy map row and a blob gone, a new record.
          const victim = seeded.get('uji-7')!;
          await h.db.updateTable('records').set({ archived_at: now, changed_at: now }).where('id', '=', victim).execute();
          await h.db.deleteFrom('migration_map').where('source', '=', 'slims').where('entity', '=', 'biblio').where('legacy_key', '=', '2').execute();
          changedFile = [...blobs.keys()][0]!;
          await storage.delete(changedFile);
          await seedCatalog(h, [{ key: 'sesudah', title: 'Catatan sesudah cadangan' }], { now });
        }
      } finally {
        await h.close();
      }
      if (CROSS) await moveInstallation({ sourceDir, dataDir, target: TARGET, targetConfig, open, backupId, manifest, now });
      await writeConfig(dataDir, targetConfig);

      // ---- The restore. ---------------------------------------------------------------------------------------
      const ops = restoreMachine(targetConfig, dataDir, open);
      try {
        await ops.ops.begin('restore', { type: 'system', id: null }, { backupId, source: 'server', withoutFiles: false, confirmed: false, targetSchema: 'latest' });
        ops.advance(4000);
        let status = null;
        for (let i = 0; i < 2000; i += 1) {
          status = await ops.ops.step(20_000);
          if (status === null || status.terminal || status.needsAttention) break;
        }
        expect(status).toMatchObject({ state: 'done' });
      } finally {
        await ops.closeWork();
        await ops.ops.close();
      }

      h = await open();
      try {
        // The data as backed up, the blobs back, the search tables empty.
        // Across dialects the data came from another engine's backup (ALTIS_TEST_DB_SOURCE).
        expect([h.dialect, manifest.dialect]).toEqual([targetDb.dialect, sourceDb.dialect]);
        expect(await checksums(h)).toEqual(before);
        expect(await storedBlobs(h, storage)).toEqual(blobs);
        if (changedFile !== null) expect(blobs.has(changedFile)).toBe(true);
        for (const table of SEARCH_TABLES) expect([table, await rowsOf(h, table)]).toEqual([table, 0]);
        expect(await reindexJobs(h)).toEqual([]);
      } finally {
        await h.close();
      }

      // ---- The boot queues the rebuild by itself; the cron pass runs it. --------------------------------------
      vi.stubEnv('ALTIS_RUNNER', 'off'); // only POST /_cron runs jobs here
      const ctx = bootContext(dataDir);
      await start(ctx);
      const { port } = await ctx.served();
      h = await open();
      try {
        await vi.waitFor(async () => expect(await reindexJobs(h)).toEqual([{ status: 'queued', payload: '{"scope":"all"}', unique_key: 'catalog.reindex:all', created_by: null }]), {
          timeout: 15_000,
          interval: 100,
        });
        for (let pass = 0; pass < 200; pass += 1) {
          const state = await h.db.selectFrom('search_state').select('status').where('id', '=', 1).executeTakeFirst();
          if (state?.status === 'ready' && (await reindexJobs(h)).every((j) => j.status === 'succeeded')) break;
          const cron = await httpRequest(port, '/_cron', 'POST', { authorization: `Bearer ${targetConfig.secrets.cronToken}` });
          expect(cron.status).toBe(200);
        }
        const records = await rowsOf(h, 'records');
        expect(await h.db.selectFrom('search_state').select(['status', 'docs']).executeTakeFirstOrThrow()).toEqual({ status: 'ready', docs: records });
        expect(await rowsOf(h, 'search_doc')).toBe(records);
        expect(await rowsOf(h, 'search_term')).toBeGreaterThan(0);

        // Every one of the 1 000 records is found by its own word, and only it.
        const at = Date.now();
        for (let n = 1; n <= RECORDS; n += 1) {
          const found = await searchCatalog(h.db, { text: wordOf(n), scope: 'opac' }, { now: at });
          expect([n, found.recordIds, found.building]).toEqual([n, [seeded.get(`uji-${n}`)], false]);
        }

        // The OPAC: a search result names the record; an old SLiMS link goes to the record biblio N became.
        const page = await httpRequest(port, `/cari?q=${wordOf(500)}`, 'GET', { accept: 'text/html' });
        expect(page.status).toBe(200);
        expect(page.body).toContain(`/katalog/${seeded.get('uji-500')!}`);
        for (const n of [1, 2, 34, 150, 300]) {
          const target = (await legacyTarget(h.db, 'slims', 'biblio', String(n)))!;
          expect((await h.db.selectFrom('records').select('source').where('id', '=', target).executeTakeFirstOrThrow()).source).toBe(`slims:${n}`);
          const reply = await httpRequest(port, `/index.php?p=show_detail&id=${n}`, 'GET', { accept: 'text/html' });
          expect([n, reply.status]).toEqual([n, 301]);
          expect(new URL(String(reply.headers.location), targetConfig.baseUrl).pathname).toMatch(new RegExp(`^/katalog/${target}(/|$)`));
        }
      } finally {
        await h.close();
      }
    },
    600_000,
  );
});

/** The rows of `table`. */
async function rowsOf(h: DbHandle, table: TableName): Promise<number> {
  return Number((await h.db.selectFrom(table as 'records').select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow()).n);
}

/**
 * Across dialects: the same installation on the target's engine (the restore pair's ALTIS_TEST_DB), its schema
 * migrated and a catalogue of its own the restore must replace, with the source's backup (manifest, parts and blobs)
 * brought into its DATA_DIR and registered as an `external` backup (another database's).
 */
async function moveInstallation(o: {
  sourceDir: string;
  dataDir: string;
  target: TestEngine;
  targetConfig: Config;
  open: () => Promise<DbHandle>;
  backupId: string;
  manifest: BackupManifest;
  now: number;
}): Promise<void> {
  if (o.target !== 'sqlite') await (await testDbFor(o.target, { dataDir: o.dataDir })).close(); // an empty database
  await fsp.cp(path.join(o.sourceDir, 'backups', o.backupId), path.join(o.dataDir, 'backups', o.backupId), { recursive: true });
  await fsp.cp(path.join(o.sourceDir, 'backups', 'blobs'), path.join(o.dataDir, 'backups', 'blobs'), { recursive: true });
  const h = await o.open();
  try {
    await runMigrations(h, { appVersion: '0.1.0', dataDir: o.dataDir, migrations: PHASE1_MIGRATIONS });
    await withTx(h, async (trx) => {
      await ensureSystemRoles(trx, o.now);
      await writeSettings(trx, { 'library.name': 'Perpustakaan Tujuan' }, { keyring: o.targetConfig.keyring, now: o.now, actorId: null });
      await trx.updateTable('schema_meta').set({ install_id: o.targetConfig.install.id }).where('id', '=', 1).execute();
    });
    await seedCatalog(h, [{ key: 'tujuan', title: 'Catatan pangkalan tujuan' }], { now: o.now });
    const bytes = await fsp.readFile(path.join(o.dataDir, 'backups', o.backupId, 'manifest.json'));
    await h.db
      .insertInto('backups')
      .values({
        id: o.backupId,
        kind: 'external',
        size: bytes.byteLength,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        schema_version: o.manifest.schemaVersion,
        app_version: o.manifest.appVersion,
        dialect: o.manifest.dialect,
        consistency: o.manifest.consistency,
        status: 'ok',
        created_at: Date.now(),
      })
      .execute();
    expect(await rowsOf(h, 'records')).toBe(1);
  } finally {
    await h.close();
  }
}

/** The `data` checksum of every table of DATA_TABLES. */
async function checksums(h: DbHandle): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const table of DATA_TABLES) out[table] = await tableChecksumFromDb(h.db, h.dialect, table);
  return out;
}

/** The SHA-256 of every stored blob (`files` rows `ok`), read back from the storage, by file id. */
async function storedBlobs(h: DbHandle, storage: ReturnType<typeof localStorageDriver>): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const files = await h.db.selectFrom('files').select(['id', 'sha256']).where('status', '=', 'ok').orderBy('id').execute();
  for (const f of files) {
    const stream = await storage.get(f.id);
    if (stream === null) {
      out.set(f.id, 'missing');
      continue;
    }
    const hash = createHash('sha256');
    for await (const chunk of stream) hash.update(chunk);
    const sha256 = hash.digest('hex');
    out.set(f.id, sha256 === f.sha256 ? sha256 : `mismatch:${sha256}`);
  }
  return out;
}

/** The `catalog.reindex` jobs. */
async function reindexJobs(h: DbHandle): Promise<{ status: string; payload: string; unique_key: string | null; created_by: string | null }[]> {
  return h.db.selectFrom('jobs').select(['status', 'payload', 'unique_key', 'created_by']).where('type', '=', 'catalog.reindex').execute();
}

/** Migrates the SLiMS fixture (dump and files zip, as two staged uploads) into `h` through the real job, to its end. */
async function migrateFixture(
  h: DbHandle,
  o: { dataDir: string; branchId: string; staffId: string; now: number; keyring: CatalogJobDeps['keyring']; dump: string; zip: string },
): Promise<void> {
  const deps = (): CatalogJobDeps => ({ dataDir: o.dataDir, baseUrl: 'https://perpus.sekolah.sch.id/', keyring: o.keyring, storage: localStorageDriver(o.dataDir), log: silent });
  const registry = createJobRegistry(slimsJobs(deps));
  const staged = async (file: string): Promise<string> => {
    const id = newId(o.now);
    await fsp.mkdir(path.join(o.dataDir, 'tmp', id), { recursive: true });
    await fsp.copyFile(file, path.join(o.dataDir, 'tmp', id, 'upload.bin'));
    return id;
  };
  const input: SlimsStartInput = {
    dryRun: false,
    sourceKind: 'dump',
    db: null,
    password: null,
    dumpStagingId: await staged(o.dump),
    files: 'zip',
    filesStagingId: await staged(o.zip),
    filesDir: null,
    branchId: o.branchId,
    priceMode: 'major',
    sourceName: 'slims',
    allowNonEmpty: false,
    confirmLibraryName: null,
    fromRunId: null,
  };
  const actor = { type: 'staff' as const, id: o.staffId, ip: null };
  const { runId, jobId } = await withTx(h, (trx) => startSlimsMigration(txCtx(trx, o.now, actor), registry, input, { keyring: o.keyring }));
  for (let slices = 0; slices < 500; slices += 1) {
    const job = await claimById(h, registry, jobId, { worker: 'test', now: o.now });
    if (job === null) break;
    const r = await runSlice(h, registry, job, { mode: 'worker', budgetMs: 20_000, keyring: o.keyring, log: silent, clock: () => o.now, env: {} });
    if (r.outcome !== 'continued') break;
  }
  const run = await h.db.selectFrom('catalog_runs').select(['status', 'summary']).where('id', '=', runId).executeTakeFirstOrThrow();
  expect(run.status).toBe('succeeded');
  expect((JSON.parse(run.summary) as { reconciliation: { ok: boolean } }).reconciliation.ok).toBe(true);
}

/**
 * A restore machine for `config` on DATA_DIR `dataDir`, no live handle of its own (the op's connections). On SQLite its
 * restore loads a work file and swaps it into place; `closeWork()` closes the work handles it opened.
 */
function restoreMachine(
  config: ReturnType<typeof sampleConfig>,
  dataDir: string,
  open: () => Promise<DbHandle>,
): { ops: OpsMachine; advance(ms: number): void; closeWork(): Promise<void> } {
  let offset = 0;
  const works: DbHandle[] = [];
  const swap = config.db.dialect === 'sqlite' ? createSqliteSwap({ dataDir, log: silent }) : null;
  const ops: OpsMachine = createOpsMachine({
    dataDir,
    kinds: [
      restoreKind({
        dataDir,
        appVersion: '0.1.0',
        migrations: PHASE1_MIGRATIONS,
        sessionKey: () => csrfKey(config),
        keyring: () => config.keyring,
        installId: config.install.id,
        requestRestart: async () => {},
        sqliteSwap:
          swap === null
            ? null
            : {
                ...swap,
                async openWork(opId) {
                  const work = await swap.openWork(opId);
                  works.push(work);
                  return work;
                },
              },
        ...(swap === null ? {} : { sqliteOwn: { close: () => ops.close(), reopen: async () => {} } }),
      }),
    ],
    db: () => undefined,
    connect: open,
    keyring: () => config.keyring,
    clock: () => Date.now() + offset,
    log: silent,
    snapshotBackupRunning: async () => false,
  });
  return {
    ops,
    advance(ms) {
      offset += ms;
    },
    async closeWork() {
      for (const w of works.splice(0)) await w.close().catch(() => {});
    },
  };
}

