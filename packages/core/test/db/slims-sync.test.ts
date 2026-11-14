import { randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PHASE1_MIGRATIONS, runMigrations, withTx, type TableName } from '@altis/db';
import { DomainError, newId } from '@altis/shared';
import type { MigrationSummary } from '@altis/shared/api/catalog/migration';
import type { MemberBody } from '@altis/shared/api/members';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { tableChecksumFromDb } from '../../src/backup/canonical.js';
import { legacyTarget } from '../../src/catalog/data/legacy-map.js';
import { updateItem } from '../../src/catalog/items/service.js';
import type { CatalogJobDeps } from '../../src/catalog/jobs-deps.js';
import { lendItem, returnItem } from '../../src/circulation/desk.js';
import { updateRecord } from '../../src/catalog/records/service.js';
import { txCtx, type Actor, type CoreLogger } from '../../src/context.js';
import type { KeyringEntry } from '../../src/crypto/secret-box.js';
import { localStorageDriver } from '../../src/files/serve.js';
import { claimById } from '../../src/jobs/claim.js';
import { createJobRegistry } from '../../src/jobs/registry.js';
import { runSlice } from '../../src/jobs/slice.js';
import { __setSlimsSourceFactory, __setSlimsStages } from '../../src/migration/slims/factory.js';
import { startSlimsMigration, type SlimsStartInput } from '../../src/migration/slims/job.js';
import { createMember } from '../../src/members/members.js';
import { slimsJobs } from '../../src/migration/slims/jobs.js';
import { writeSettings } from '../../src/settings/service.js';
import { wipeCatalog } from '../support/search-corpus.js';
import { generateSlimsFixture, type FixtureData } from '../support/slims-fixture/generate.js';
import { SLIMS_FIXTURE_SEED } from '../support/slims-fixture/index.js';
import { mutateCatalogAfterFirstRun, type CatalogMutationExpected } from '../support/slims-fixture/mutate-catalog.js';

// The SLiMS catalogue re-sync (`catalogMode = sync`) end to end on the engine picked by ALTIS_TEST_DB, through the real
// job and every real stage, on the synthetic fixture (its items 1-3 given an entry date, a zero one and 1970-01-01):
//
// - an append run maps `item.input_date` to `items.input_on` (the local date; zero and 1970-01-01 → null);
// - a sync of the unchanged source rewrites nothing (a title with a zero `input_date` included), a sync dry run counts no
//   change, and every `created_at` stays as the first run wrote it (clock fallbacks are never compared or written);
// - after one record and one copy are edited in ALTIS and SLiMS changes its catalogue (weeded, deleted, moved, lost,
//   received date emptied, a copy added, a title deleted with its copies, a title deleted while a copy stays), a sync
//   dry run writes no row and counts the 10 changes; the sync follows SLiMS for the rows no one edited in ALTIS (the
//   status through the item lifecycle, with history rows `migrated {via: 'sync'}`), archives the copies and the title
//   whose source rows are gone, keeps the title that still has a live copy, leaves the two edited rows as they are with
//   `edited_in_altis` naming the differing fields, and reconciles with no difference;
// - a copy out on loan keeps its status and stays live while SLiMS weeds or deletes it, and the first re-sync after its
//   return follows SLiMS.

const ctx = testDbContext();
const keyring: KeyringEntry[] = [{ kid: 'k1', key: randomBytes(32).toString('base64url'), active: true }];
const silent: CoreLogger = { info() {}, warn() {}, error() {} };
/** In the past: an audit entry may not be dated ahead of the real clock. Every run's clock stands here. */
const NOW = Date.UTC(2026, 10, 2, 9, 0, 0);
const LIBRARY = 'Perpustakaan Selaras';

/** The copies given an entry date to map (the plain fixture's are all valid dates). */
const ENTRY_DATES: Readonly<Record<number, string>> = { 1: '2019-08-17 10:00:00', 2: '0000-00-00 00:00:00', 3: '1970-01-01 07:00:00' };

/** The plain fixture with the entry dates of ENTRY_DATES. */
function withEntryDates(data: FixtureData): FixtureData {
  const rows = new Map(data.rows);
  rows.set(
    'item',
    (data.rows.get('item') ?? []).map((r) => (Object.hasOwn(ENTRY_DATES, Number(r['item_id'])) ? { ...r, input_date: ENTRY_DATES[Number(r['item_id'])]! } : r)),
  );
  return { ...data, rows };
}

/** The changed source changed once more: title 101 renamed with a new ISBN, copy 34 (in repair) declared lost. */
function later(data: FixtureData): FixtureData {
  const m = mutateCatalogAfterFirstRun(withEntryDates(data)).data;
  const rows = new Map(m.rows);
  rows.set(
    'biblio',
    (m.rows.get('biblio') ?? []).map((r) => (r['biblio_id'] === 101 ? { ...r, title: 'Sejarah Desa Pesisir: edisi kedua', isbn_issn: '978-602-03-3345-1' } : r)),
  );
  rows.set('item', (m.rows.get('item') ?? []).map((r) => (r['item_id'] === 34 ? { ...r, item_status_id: 'HL' } : r)));
  return { ...m, rows };
}

/** Every table a sync dry run must leave as it is. */
const CATALOG_TABLES = [
  'records',
  'record_identifiers',
  'record_agents',
  'record_subjects',
  'locations',
  'items',
  'item_events',
  'search_doc',
  'migration_map',
  'migration_archive',
  'custom_values',
] as const satisfies readonly TableName[];

describe.skipIf(!ctx.available)(`SLiMS catalogue re-sync [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let root: string;
  let dataDir: string;
  let branchId: string;
  let staff: Actor;
  let plainDump: Buffer;
  let mutatedDump: Buffer;
  /** The changed source changed once more: title 101 renamed with a new ISBN, copy 34 (in repair) declared lost. */
  let laterDump: Buffer;
  let filesZip: Buffer;
  let mutation: CatalogMutationExpected;
  let seeds: Record<'material_types' | 'languages' | 'collection_types', string[]>;
  const deps = (): CatalogJobDeps => ({ dataDir, baseUrl: 'https://perpus.example.sch.id/', keyring, storage: localStorageDriver(dataDir), log: silent });
  const registry = createJobRegistry(slimsJobs(deps));

  beforeAll(async () => {
    h = await testDb();
    root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-slims-sync-')));
    dataDir = path.join(root, 'data');
    await fsp.mkdir(dataDir, { recursive: true });
    await runMigrations(h, { appVersion: '0.1.0', dataDir: path.join(root, 'migrations'), migrations: PHASE1_MIGRATIONS });
    seeds = {
      material_types: (await h.db.selectFrom('material_types').select('id').execute()).map((r) => r.id),
      languages: (await h.db.selectFrom('languages').select('id').execute()).map((r) => r.id),
      collection_types: (await h.db.selectFrom('collection_types').select('id').execute()).map((r) => r.id),
    };
    branchId = newId(NOW);
    await h.db
      .insertInto('branches')
      .values({ id: branchId, code_key: 'SELARAS', code_display: 'SELARAS', name: LIBRARY, timezone: 'Asia/Jakarta', is_default: 0, created_at: NOW, updated_at: NOW })
      .execute();
    const staffId = newId(NOW);
    await h.db
      .insertInto('staff_users')
      .values({ id: staffId, username_key: 'PENYELARAS', username_display: 'penyelaras', name: 'penyelaras', password_hash: 'x', status: 'active', created_at: NOW, updated_at: NOW })
      .execute();
    staff = { type: 'staff', id: staffId, ip: null };
    await withTx(h, (trx) => writeSettings(trx, { 'catalog.attachment.maxMb': 1, 'library.name': LIBRARY }, { now: NOW, actorId: null, keyring: [] }));
    const plain = generateSlimsFixture(SLIMS_FIXTURE_SEED, { transform: withEntryDates });
    plainDump = plain.dump;
    filesZip = plain.filesZip;
    let expected: CatalogMutationExpected | null = null;
    mutatedDump = generateSlimsFixture(SLIMS_FIXTURE_SEED, {
      transform: (data) => {
        const m = mutateCatalogAfterFirstRun(withEntryDates(data));
        expected = m.expected;
        return m.data;
      },
    }).dump;
    mutation = expected!;
    laterDump = generateSlimsFixture(SLIMS_FIXTURE_SEED, { transform: later }).dump;
    __setSlimsSourceFactory(null);
    __setSlimsStages(null);
  }, 120_000);

  afterAll(async () => {
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
    for (const table of ['loans', 'member_events', 'members'] as const) await h.db.deleteFrom(table).execute();
    for (const table of ['migration_map', 'migration_archive', 'catalog_runs', 'suppliers', 'jobs'] as const) await h.db.deleteFrom(table).execute();
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

  /** Starts a migration of `dump` (and the files zip): a later run with the catalogue's confirmation. */
  async function start(dump: Buffer, o: { dryRun?: boolean; sync?: boolean } = {}): Promise<{ runId: string; jobId: string }> {
    const later = (await h.db.selectFrom('records').select('id').limit(1).executeTakeFirst()) !== undefined;
    const input: SlimsStartInput = {
      dryRun: o.dryRun ?? false,
      sourceKind: 'dump',
      db: null,
      password: null,
      dumpStagingId: await staged(dump),
      files: 'zip',
      filesStagingId: await staged(filesZip),
      filesDir: null,
      branchId,
      priceMode: 'major',
      sourceName: 'slims',
      allowNonEmpty: later,
      confirmLibraryName: later ? LIBRARY : null,
      fromRunId: null,
      ...(o.sync === true ? { catalogMode: 'sync' as const } : {}),
    };
    return withTx(h, (trx) => startSlimsMigration(txCtx(trx, NOW, staff), registry, input, { keyring }));
  }

  async function runToEnd(id: string): Promise<string> {
    for (let slices = 1; slices <= 3000; slices += 1) {
      const job = await claimById(h, registry, id, { worker: 'test', now: NOW });
      if (job === null) throw new Error(`job ${id} cannot be claimed`);
      const r = await runSlice(h, registry, job, { mode: 'worker', budgetMs: 20_000, keyring, log: silent, clock: () => NOW, env: {} });
      if (r.outcome !== 'continued') return r.outcome;
    }
    throw new Error('no end after 3000 slices');
  }

  interface Ended {
    runId: string;
    summary: MigrationSummary;
    /** The stages' report rows (after the framework's own rows), each as its cells. */
    rows: string[][];
  }

  async function migrate(dump: Buffer, o: { dryRun?: boolean; sync?: boolean } = {}): Promise<Ended> {
    const { runId, jobId } = await start(dump, o);
    expect(await runToEnd(jobId)).toBe('succeeded');
    const run = await h.db.selectFrom('catalog_runs').select(['status', 'summary', 'report_file_id']).where('id', '=', runId).executeTakeFirstOrThrow();
    expect(run.status).toBe('succeeded');
    return { runId, summary: JSON.parse(run.summary) as MigrationSummary, rows: await stageRows(run.report_file_id) };
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

  async function checksums(): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const t of CATALOG_TABLES) out[t] = await tableChecksumFromDb(h.db, h.dialect, t);
    return out;
  }

  const itemOf = async (id: number) => (await legacyTarget(h.db, 'slims', 'item', String(id)))!;
  const recordOf = async (id: number) => (await legacyTarget(h.db, 'slims', 'biblio', String(id)))!;
  const item = async (id: number) => h.db.selectFrom('items').selectAll().where('id', '=', await itemOf(id)).executeTakeFirstOrThrow();
  const record = async (id: number) => h.db.selectFrom('records').selectAll().where('id', '=', await recordOf(id)).executeTakeFirstOrThrow();
  /** The history rows of SLiMS item `id`: every run's clock stands at NOW, so their order is not their ids'. */
  const events = async (id: number) =>
    (await h.db.selectFrom('item_events').selectAll().where('item_id', '=', await itemOf(id)).execute()).map((e) => ({
      type: e.type,
      from: e.from_status,
      to: e.to_status,
      fromLocation: e.from_location_id,
      toLocation: e.to_location_id,
      meta: JSON.parse(e.meta) as { fields: string[]; via?: string },
    }));
  /** The history rows a re-sync wrote for SLiMS item `id`. */
  const synced = async (id: number) => (await events(id)).filter((e) => e.meta.via === 'sync');

  /** The `created_at` of every record and item, by id. */
  async function createdAts(): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const r of await h.db.selectFrom('records').select(['id', 'created_at']).execute()) out[r.id] = Number(r.created_at);
    for (const r of await h.db.selectFrom('items').select(['id', 'created_at']).execute()) out[r.id] = Number(r.created_at);
    return out;
  }

  /** Every unread row of a reconciliation says why it is not read, and every read row reconciles. */
  function expectReconciled(s: MigrationSummary): void {
    expect(s.reconciliation?.ok).toBe(true);
    expect(s.warnings).toEqual([]);
    for (const row of s.reconciliation!.tables) {
      if (row.unread) expect(row.unreadKind, row.table).toMatch(/^(phase3|derived)$/);
      else expect([row.table, row.diff]).toEqual([row.table, 0]);
    }
    expect(s.reconciliation!.tables.filter((r) => r.unread).length).toBeGreaterThan(0);
  }

  // ---------------------------------------------------------------------------------------------------------------

  it('an append run maps item.input_date to items.input_on: the local date, a zero date and 1970-01-01 → null', async () => {
    await wipe();
    const first = await migrate(plainDump);
    expectReconciled(first.summary);
    expect((await item(1)).input_on).toBe('2019-08-17');
    expect((await item(2)).input_on).toBeNull();
    expect((await item(3)).input_on).toBeNull();
    // Every other copy keeps the date part of its SLiMS entry date.
    expect((await item(10)).input_on).toBe('2019-02-11');
    expect(first.summary.fixes['item.input_date']).toEqual({ date: 2 });
    // An append run adds nothing to its summary of a re-sync.
    expect(first.summary.catalogChanges).toBeUndefined();
  }, 300_000);

  it('a sync of the unchanged source rewrites nothing, its dry run counts 0 changes, and every created_at stays', async () => {
    // The run before: the append run of the test above.
    const versions = async () => [
      ...(await h.db.selectFrom('records').select(['id', 'version']).execute()),
      ...(await h.db.selectFrom('items').select(['id', 'version']).execute()),
    ].map((r) => `${r.id}:${Number(r.version)}`).sort();
    const before = { versions: await versions(), created: await createdAts(), events: await h.db.selectFrom('item_events').select('id').execute() };
    // biblio 9 has a zero input_date: its record's created_at is the first run's clock, never compared again.
    expect(Number((await record(9)).created_at)).toBe(NOW);

    const dry = await migrate(plainDump, { dryRun: true, sync: true });
    expect(dry.rows.filter((r) => r[2] === 'sync_change')).toEqual([]);
    expect(dry.summary.catalogChanges).toBe(0);
    expect(dry.rows.filter((r) => ['edited_in_altis', 'source_missing', 'source_missing_kept', 'status_guard'].includes(r[2]!))).toEqual([]);

    const sync = await migrate(plainDump, { sync: true });
    expectReconciled(sync.summary);
    expect(sync.summary.catalogChanges).toBeUndefined();
    expect(sync.summary.tables['item']).toMatchObject({ migrated: 600, archived: 0, skipped: {} });
    expect(sync.summary.tables['biblio']).toMatchObject({ migrated: 300, archived: 0, skipped: {} });
    expect(await versions()).toEqual(before.versions);
    expect(await createdAts()).toEqual(before.created);
    expect(await h.db.selectFrom('item_events').select('id').execute()).toEqual(before.events);
  }, 600_000);

  it('a re-sync of the changed source: SLiMS changes are followed, rows edited in ALTIS are skipped and reported, gone rows archived', async () => {
    await wipe();
    await migrate(plainDump);
    const sl = (await legacyTarget(h.db, 'slims', 'mst_location', 'SL'))!;
    // Two rows edited in ALTIS through the catalogue services: a record's title, a copy's location.
    const edited = { record: await record(100), item: await item(88) };
    await withTx(h, (trx) => updateRecord(txCtx(trx, NOW, staff), edited.record.id, { version: Number(edited.record.version), title: 'Judul Disunting di ALTIS' }));
    await withTx(h, (trx) => updateItem(txCtx(trx, NOW, staff), branchId, edited.item.id, { version: Number(edited.item.version), locationId: sl }));
    const versions = new Map<string, number>();
    for (const r of await h.db.selectFrom('items').select(['id', 'version']).execute()) versions.set(r.id, Number(r.version));
    const created = await createdAts();

    // A sync dry run on the changed source: no row written, the 10 changes counted.
    const before = await checksums();
    const dry = await migrate(mutatedDump, { dryRun: true, sync: true });
    expect(await checksums()).toEqual(before);
    // The dry run lists the rows the sync would change, with their fields.
    expect(dry.rows.filter((r) => r[2] === 'sync_change').map((r) => `${r[0]}:${r[1]}:${r[3]}`)).toEqual([
      'item:72:status',
      'item:73:location',
      'item:76:status',
      'item:78:receivedDate',
      'item:160:status',
    ]);
    expect(dry.summary.catalogChanges).toBe(mutation.catalogChanges);
    expect(dry.summary.catalogChanges).toBe(10);

    const sync = await migrate(mutatedDump, { sync: true });
    expectReconciled(sync.summary);
    const s = sync.summary;
    // Every source row once: migrated (new, rewritten, unchanged) or skipped; the gone rows archived beside them.
    expect(s.tables['item']).toMatchObject({ source: 599, migrated: 598, skipped: { edited_in_altis: 1 }, archived: 2 });
    expect(s.tables['biblio']).toMatchObject({ source: 298, migrated: 297, skipped: { edited_in_altis: 1 }, archived: 1 });
    const report = (code: string) => sync.rows.filter((r) => r[2] === code).map((r) => `${r[0]}:${r[1]}:${r[3]}`).sort();

    // Weeded in SLiMS: withdrawn and archived, through the lifecycle, with a history row of the sync.
    for (const id of mutation.weeded) {
      const it = await item(id);
      expect([id, it.status, it.archived_at !== null, it.updated_by, Number(it.version)]).toEqual([id, 'withdrawn', true, null, versions.get(it.id)! + 1]);
      expect(await synced(id)).toEqual([{ type: 'migrated', from: 'available', to: 'withdrawn', fromLocation: null, toLocation: null, meta: { fields: ['status'], via: 'sync' } }]);
    }
    // Deleted in SLiMS: archived, reported source_missing.
    for (const id of mutation.deletedRecord.items) {
      const it = await item(id);
      expect([id, it.status, it.archived_at !== null]).toEqual([id, 'withdrawn', true]);
      expect(await synced(id)).toMatchObject([{ type: 'migrated', from: 'available', to: 'withdrawn', meta: { fields: ['status'], via: 'sync' } }]);
    }
    expect(report('source_missing')).toEqual(['biblio:150:archived', 'item:150:withdrawn', 'item:447:withdrawn']);
    // Moved to the second floor: the shelf the first run made there for the same shelf text (item 24's).
    const moved = await item(mutation.moved.itemId);
    const shelf = (await item(24)).location_id;
    expect(moved.location_id).toBe(shelf);
    expect(await synced(mutation.moved.itemId)).toMatchObject([{ type: 'migrated', from: null, to: null, toLocation: shelf, meta: { fields: ['location'], via: 'sync' } }]);
    // Lost in SLiMS (it was missing): lost, through the lifecycle.
    expect((await item(mutation.lost)).status).toBe('lost');
    expect(await synced(mutation.lost)).toEqual([{ type: 'migrated', from: 'missing', to: 'lost', fromLocation: null, toLocation: null, meta: { fields: ['status'], via: 'sync' } }]);
    // The receiving date emptied: null, the entry date still there; no history row (neither status nor location).
    const emptied = await item(mutation.receivedEmptied);
    expect([emptied.received_date, emptied.input_on]).toEqual([null, '2019-07-16']);
    expect((await events(mutation.receivedEmptied)).map((e) => e.type)).toEqual(['migrated']);
    // The copy added after the first run.
    const added = await item(mutation.added.itemId);
    expect([added.barcode_key, added.record_id, added.input_on, added.received_date]).toEqual(['B00601', await recordOf(mutation.added.biblioId), '2026-01-10', '2026-01-10']);
    // The title deleted with its copies is archived; the one whose copy stays is kept, and reported.
    expect((await record(mutation.deletedRecord.biblioId)).archived_at).not.toBeNull();
    const kept = await record(mutation.keptRecord.biblioId);
    expect(kept.archived_at).toBeNull();
    expect((await item(mutation.keptRecord.remainingItemId)).record_id).toBe(kept.id);
    expect((await item(mutation.keptRecord.remainingItemId)).archived_at).toBeNull();
    expect(report('source_missing_kept')).toEqual(['biblio:160:items=1']);
    // The rows edited in ALTIS are left as they are, reported with the fields that differ.
    expect((await record(100)).title).toBe('Judul Disunting di ALTIS');
    expect((await item(88)).location_id).toBe(sl);
    expect(report('edited_in_altis')).toEqual(['biblio:100:title', 'item:88:location']);
    expect(report('status_guard')).toEqual([]);
    // The rows the sync rewrote: version + 1, still not edited in ALTIS; the others as they were.
    for (const id of [mutation.moved.itemId, mutation.lost, mutation.receivedEmptied]) {
      const it = await item(id);
      expect([id, Number(it.version), it.updated_by]).toEqual([id, versions.get(it.id)! + 1, null]);
    }
    expect(Number((await item(5)).version)).toBe(versions.get(await itemOf(5)));
    // Clock fallbacks never written: every row of the first run keeps its created_at.
    const now = await createdAts();
    for (const [id, at] of Object.entries(created)) expect([id, now[id]]).toEqual([id, at]);

    // A second sync of the same source finds nothing more to do.
    const again = await migrate(mutatedDump, { dryRun: true, sync: true });
    expect(again.summary.catalogChanges).toBe(0);

    // A real run that skips the catalogue stages needs a sync dry run that found no change.
    const skip = (fromRunId: string | null): Promise<unknown> =>
      withTx(h, (trx) =>
        startSlimsMigration(
          txCtx(trx, NOW, staff),
          registry,
          {
            dryRun: false,
            sourceKind: 'dump',
            db: null,
            password: null,
            dumpStagingId: null,
            files: null,
            filesStagingId: null,
            filesDir: null,
            branchId,
            priceMode: 'major',
            sourceName: 'slims',
            allowNonEmpty: true,
            confirmLibraryName: LIBRARY,
            fromRunId,
            catalogMode: 'sync',
            skipCatalog: true,
          },
          { keyring },
        ),
      ).then(
        () => null,
        (e: unknown) => e,
      );
    const without = await skip(null);
    expect(without).toBeInstanceOf(DomainError);
    expect([(without as DomainError).code, (without as DomainError).meta]).toEqual(['VALIDATION_FAILED', { errors: [{ path: 'skipCatalog', code: 'dry_run_required' }] }]);
    const changed = await skip(dry.runId);
    expect(changed).toBeInstanceOf(DomainError);
    expect([(changed as DomainError).code, (changed as DomainError).status, (changed as DomainError).meta]).toEqual([
      'MIGRATION_PRECHECK_FAILED',
      422,
      { reason: 'catalog_changed', count: 10 },
    ]);
    expect((changed as DomainError).detail).toContain('catalog_changed');
    // Nothing of a refused start stays: no run, no job, the dry run not taken over.
    expect(await h.db.selectFrom('jobs').select('id').where('status', '=', 'queued').execute()).toEqual([]);
    expect(JSON.parse((await h.db.selectFrom('catalog_runs').select('options').where('id', '=', dry.runId).executeTakeFirstOrThrow()).options)).not.toHaveProperty('adoptedBy');
  }, 900_000);

  it('a record changed in SLiMS is rewritten (title and identifiers); a status change the lifecycle refuses keeps the status, reported status_guard', async () => {
    // The catalogue as the test above left it.
    const before = await record(101);
    const repair = await item(34);
    expect(repair.status).toBe('repair');
    const created = await createdAts();
    const dry = await migrate(laterDump, { dryRun: true, sync: true });
    expect(dry.summary.catalogChanges).toBe(1);
    expect(dry.rows.filter((r) => r[2] === 'sync_change').map((r) => `${r[0]}:${r[1]}:${r[3]}`)).toEqual(['biblio:101:identifiers,subtitle,title']);

    const sync = await migrate(laterDump, { sync: true });
    expectReconciled(sync.summary);
    const after = await record(101);
    expect([after.title, after.subtitle, after.updated_by, Number(after.version)]).toEqual(['Sejarah Desa Pesisir', 'edisi kedua', null, Number(before.version) + 1]);
    expect(after.title_key).not.toBe(before.title_key);
    expect(Number(after.changed_at)).toBe(NOW);
    expect(Number(after.created_at)).toBe(Number(before.created_at));
    const ids = await h.db.selectFrom('record_identifiers').select(['type', 'value_key']).where('record_id', '=', after.id).execute();
    expect(ids).toEqual([{ type: 'isbn', value_key: '9786020333451' }]);
    // In repair, the copy may not become lost: its status stays, the refusal is reported, nothing else changes.
    const kept = await item(34);
    expect([kept.status, Number(kept.version)]).toEqual(['repair', Number(repair.version)]);
    expect(sync.rows.filter((r) => r[2] === 'status_guard').map((r) => `${r[0]}:${r[1]}:${r[3]}`)).toEqual(['item:34:repair -> lost']);
    const now = await createdAts();
    for (const [id, at] of Object.entries(created)) expect([id, now[id]]).toEqual([id, at]);
  }, 600_000);
  it('a copy out on loan keeps its status and stays live while SLiMS weeds or deletes it; the first re-sync after its return follows SLiMS', async () => {
    // The catalogue as the test above left it. Two copies no one edited, available and live, are lent at the desk.
    const free: number[] = [];
    for (let id = 1; free.length < 2 && id <= 60; id += 1) {
      const it = await item(id);
      if (it.status === 'available' && it.updated_by === null && it.archived_at === null) free.push(id);
    }
    const [gone, weeded] = free as [number, number];
    const siswa = (await h.db.selectFrom('member_types').select('id').where('code_key', '=', 'SISWA').executeTakeFirstOrThrow()).id;
    const body = { memberNo: 'SINKRON-1', memberTypeId: siswa, name: 'Peminjam Sinkron' } as MemberBody;
    const reader = await withTx(h, (trx) => createMember(txCtx(trx, NOW, staff), body));
    const barcodes = new Map<number, string>();
    for (const id of free) barcodes.set(id, (await item(id)).barcode_key);
    const due = new Map<number, string>();
    for (const id of free) {
      const loan = await withTx(h, (trx) => lendItem(txCtx(trx, NOW, staff), { branchId, memberId: reader.id, barcode: barcodes.get(id)! }));
      due.set(id, loan.dueOn);
    }
    const eventsBefore = { gone: (await events(gone)).length, weeded: (await events(weeded)).length };

    // SLiMS deletes one copy and weeds the other.
    const changed = generateSlimsFixture(SLIMS_FIXTURE_SEED, {
      transform: (data) => {
        const m = later(data);
        const rows = new Map(m.rows);
        rows.set(
          'item',
          (m.rows.get('item') ?? []).flatMap((r) => (r['item_id'] === gone ? [] : r['item_id'] === weeded ? [{ ...r, item_status_id: 'W' }] : [r])),
        );
        return { ...m, rows };
      },
    }).dump;
    const report = (e: Ended, code: string) => e.rows.filter((r) => r[2] === code).map((r) => `${r[0]}:${r[1]}:${r[3]}`);

    // The dry run reports both copies kept, and counts no change: the sync would write nothing for them.
    const dry = await migrate(changed, { dryRun: true, sync: true });
    expect(report(dry, 'source_missing_on_loan')).toEqual([`item:${gone}:due_on=${due.get(gone)!}`]);
    expect(report(dry, 'status_on_loan')).toEqual([`item:${weeded}:available -> withdrawn`]);
    expect(dry.summary.catalogChanges).toBe(0);

    const sync = await migrate(changed, { sync: true });
    expectReconciled(sync.summary);
    expect(report(sync, 'source_missing_on_loan')).toEqual([`item:${gone}:due_on=${due.get(gone)!}`]);
    expect(report(sync, 'status_on_loan')).toEqual([`item:${weeded}:available -> withdrawn`]);
    expect(report(sync, 'source_missing')).toEqual([]);
    for (const id of free) {
      const it = await item(id);
      expect([id, it.status, it.archived_at]).toEqual([id, 'available', null]);
    }
    expect([(await events(gone)).length, (await events(weeded)).length]).toEqual([eventsBefore.gone, eventsBefore.weeded]);
    const open = await h.db.selectFrom('loans').select('open_item_id').where('member_id', '=', reader.id).execute();
    expect(open.map((r) => r.open_item_id).sort()).toEqual([await itemOf(gone), await itemOf(weeded)].sort());

    // Both copies come back at the desk; the next re-sync follows SLiMS.
    for (const id of free) await withTx(h, (trx) => returnItem(txCtx(trx, NOW, staff), { branchId, barcode: barcodes.get(id)! }));
    const after = await migrate(changed, { sync: true });
    expectReconciled(after.summary);
    expect(report(after, 'source_missing')).toEqual([`item:${gone}:withdrawn`]);
    expect(report(after, 'source_missing_on_loan')).toEqual([]);
    expect(report(after, 'status_on_loan')).toEqual([]);
    for (const id of free) {
      const it = await item(id);
      expect([id, it.status, it.archived_at !== null]).toEqual([id, 'withdrawn', true]);
    }
  }, 600_000);
});
