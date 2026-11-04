import { randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PHASE1_MIGRATIONS, runMigrations, withTx, type DB } from '@altis/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  claimById,
  createJobRegistry,
  enqueueReindex,
  getItem,
  itemByBarcode,
  listItems,
  localStorageDriver,
  recordDetail,
  runSlice,
  searchCatalog,
  searchHealth,
  searchJobs,
  titleKey,
  type CatalogJobDeps,
  type CoreLogger,
  type JobRegistry,
  type StorageDriver,
} from '../../../../../packages/core/src/index.js';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../test-db.js';
import { PERF_PUBLISHERS, PERF_SUPPLIERS, perfAgentName, perfBarcode, perfCounts, perfPdf, perfRecord, perfSubjectTerm, perfUniqueWord, seedPhase2, type PerfCounts } from '../../seed.js';

// seedPhase2 (K9; plan Task 39) on the test engine: the rows it writes straight into the catalogue are the rows the
// services would have written. The product reads them back (recordDetail, getItem, itemByBarcode, listItems), the real
// `catalog.reindex` builds the index over them, and the search then finds a record by its own word, by a facet and by
// its ISBN. The counts are exactly those asked, and a second run on the same catalogue is refused.

const ctx = testDbContext();
const NOW = Date.UTC(2026, 10, 2, 8, 0, 0);
const silent: CoreLogger = { info() {}, warn() {}, error() {} };
const keyring = [{ kid: 'k1', key: randomBytes(32).toString('base64url'), active: true }];
const count = async (h: TestDbHandle, table: keyof DB & string): Promise<number> =>
  Number((await h.db.selectFrom(table as 'records').select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow()).n);

describe.skipIf(!ctx.available)(`seedPhase2 [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let root: string;
  const counts: PerfCounts = perfCounts(0.003); // 300 records (record 210 archived), 450 items, 150 agents, 60 subjects, 6 attachments
  let ids: string[];

  beforeAll(async () => {
    h = await testDb();
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-perf-seed-'));
    await runMigrations(h, { appVersion: '0.1.0', dataDir: path.join(root, 'migrations'), migrations: PHASE1_MIGRATIONS });
    await seedPhase2(h, { counts, dataDir: root, now: NOW });
    // created_at follows the record number, and so does the ULID (ids are minted at created_at).
    ids = (await h.db.selectFrom('records').select('id').orderBy('created_at').orderBy('id').execute()).map((r) => r.id);
  }, 120_000);

  afterAll(async () => {
    await h?.close();
    if (root !== undefined) await fsp.rm(root, { recursive: true, force: true });
  });

  it('writes exactly the counts asked, with the masters, branches, locations and suppliers around them', async () => {
    expect(counts).toEqual({ records: 300, items: 450, agents: 150, subjects: 60, attachments: 6 });
    expect(await count(h, 'records')).toBe(300);
    expect(await count(h, 'items')).toBe(450);
    expect(await count(h, 'item_events')).toBe(450);
    expect(await count(h, 'agents')).toBe(150);
    expect(await count(h, 'subjects')).toBe(60);
    expect(await count(h, 'attachments')).toBe(6);
    expect(await count(h, 'files')).toBe(3);
    expect(await count(h, 'publishers')).toBe(PERF_PUBLISHERS);
    expect(await count(h, 'suppliers')).toBe(PERF_SUPPLIERS);
    expect(await count(h, 'branches')).toBe(2);
    expect(await count(h, 'locations')).toBe(22);
    expect(ids).toHaveLength(300);
  });

  it('a record reads back through recordDetail as the generator made it (keys as the services write them)', async () => {
    for (const n of [0, 9, 100, 210, 299]) {
      const rec = perfRecord(n, counts);
      const d = await recordDetail(h.db, ids[n]!);
      expect(d.title).toBe(rec.title);
      expect(d.subtitle ?? null).toBe(rec.subtitle);
      expect(d.publicationYear).toBe(rec.year);
      expect(d.agents.map((a) => a.name)).toEqual(rec.agents.map((a) => perfAgentName(a.k)));
      expect(d.subjects.map((s) => s.term)).toEqual(rec.subjects.map((s) => perfSubjectTerm(s.k)));
      expect(d.items.map((i) => i.barcode).sort()).toEqual(rec.items.map(perfBarcode).sort());
      expect(d.archived).toBe(rec.archived);
      expect(d.opacVisible).toBe(!rec.hidden);
      expect(d.itemCounts.total).toBe(rec.archived ? 0 : rec.items.length); // live items only
      const row = await h.db.selectFrom('records').select('title_key').where('id', '=', ids[n]!).executeTakeFirstOrThrow();
      expect(row.title_key).toBe(titleKey(rec.title, rec.subtitle));
    }
  });

  it('items read back through getItem, itemByBarcode and listItems', async () => {
    const rec = perfRecord(0, counts);
    const found = await itemByBarcode(h.db, perfBarcode(rec.items[0]!));
    expect(found.record.id).toBe(ids[0]);
    expect(found.locationPath).not.toBeNull();
    expect(found.history.map((e) => e.type)).toEqual(['imported']);
    const item = await getItem(h.db, found.id);
    expect(item.barcode).toBe(perfBarcode(rec.items[0]!));
    const page = await listItems(h.db, { limit: 50 });
    expect(page.items).toHaveLength(50);
    expect(page.nextCursor).not.toBeNull();
  });

  it('a file attachment is stored through the storage driver with the bytes the generator made', async () => {
    const a = await h.db.selectFrom('attachments as a').innerJoin('files as f', 'f.id', 'a.file_id').select(['a.id', 'f.id as fileId', 'f.size', 'f.owner_id', 'f.status']).executeTakeFirstOrThrow();
    expect(a.owner_id).toBe(a.id);
    expect(a.status).toBe('ok');
    const storage: StorageDriver = localStorageDriver(root);
    expect(await storage.stat(a.fileId)).toEqual({ size: Number(a.size) });
    const chunks: Buffer[] = [];
    for await (const c of (await storage.get(a.fileId))!) chunks.push(Buffer.from(c));
    expect(Buffer.concat(chunks).equals(perfPdf(0))).toBe(true);
  });

  it('the real catalog.reindex indexes them all: found by a record\'s own word, by ISBN and with two facets', async () => {
    const deps = (): CatalogJobDeps => ({ dataDir: root, baseUrl: 'https://perpus.example.sch.id', keyring, storage: localStorageDriver(root), log: silent });
    const reg: JobRegistry = createJobRegistry(searchJobs(deps));
    const { jobId } = await withTx(h, (trx) => enqueueReindex(trx, reg, { scope: 'all' }, { now: NOW, keyring, createdBy: null }));
    let outcome = 'continued';
    for (let n = 0; n < 50 && outcome === 'continued'; n += 1) {
      const job = await claimById(h, reg, jobId, { worker: 'perf-seed-test', now: NOW });
      if (job === null) throw new Error('the reindex cannot be claimed');
      outcome = (await runSlice(h, reg, job, { mode: 'worker', budgetMs: 20_000, keyring, log: silent, clock: () => NOW, env: {} })).outcome;
    }
    expect(outcome).toBe('succeeded');
    expect((await searchHealth(h.db)).status).toBe('ready');
    expect(await count(h, 'search_doc')).toBe(300);

    const rec = perfRecord(42, counts);
    const own = await searchCatalog(h.db, { text: perfUniqueWord(42), scope: 'admin', pageSize: 50 }, { now: NOW });
    expect(own.recordIds).toEqual([ids[42]]);
    const isbn = await searchCatalog(h.db, { text: rec.isbn!, scope: 'admin', pageSize: 50 }, { now: NOW });
    expect(isbn.recordIds).toEqual([ids[42]]);
    const word = rec.title.toLowerCase().split(' ')[0]!;
    const all = await searchCatalog(h.db, { text: word, scope: 'opac', pageSize: 200 }, { now: NOW });
    expect(all.recordIds).toContain(ids[42]);
    const lt = await h.db.selectFrom('records').select(['material_type_id', 'language_id']).where('id', '=', ids[42]!).executeTakeFirstOrThrow();
    const faceted = await searchCatalog(h.db, { text: word, scope: 'opac', pageSize: 200, filters: { materialTypeIds: [lt.material_type_id], languageIds: [lt.language_id!] } }, { now: NOW });
    expect(faceted.recordIds).toContain(ids[42]);
    expect(faceted.recordIds.length).toBeLessThanOrEqual(all.recordIds.length);
  }, 120_000);

  it('an archived record has no live item (archiving a record with live items is 409, §2.5): its items are withdrawn', async () => {
    const archived = await h.db.selectFrom('records').select('id').where('archived_at', 'is not', null).execute();
    expect(archived.length).toBeGreaterThan(0);
    const items = await h.db.selectFrom('items').select(['status', 'archived_at']).where('record_id', 'in', archived.map((r) => r.id)).execute();
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.status).toBe('withdrawn');
      expect(item.archived_at).not.toBeNull();
    }
  });

  it('refuses to seed a catalogue that has records already', async () => {
    await expect(seedPhase2(h, { counts, dataDir: root, now: NOW })).rejects.toThrow(/not empty/);
  });
});
