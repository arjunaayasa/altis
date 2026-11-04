import { withTx } from '@altis/db';
import { newId } from '@altis/shared';
import type { SruServer } from '@altis/shared/api/settings';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { engineLabel, testDbContext } from '../../../../tools/test/test-db.js';
import { createAttachment, archiveAttachment, updateAttachment } from '../../src/catalog/attachments/service.js';
import { copyMaterialTypeResolver, sruSearchDrafts } from '../../src/catalog/copy/index.js';
import { batchCreateItems } from '../../src/catalog/items/batch.js';
import { bulkUpdateItems } from '../../src/catalog/items/bulk.js';
import { archiveItem, createItem, updateItem } from '../../src/catalog/items/service.js';
import { setCover } from '../../src/catalog/records/cover.js';
import { recordBodyFromDraft } from '../../src/catalog/records/draft.js';
import { mergeRecord } from '../../src/catalog/records/merge.js';
import { archiveRecord, createRecord, restoreRecord, updateRecord } from '../../src/catalog/records/service.js';
import { txCtx } from '../../src/context.js';
import { claimById } from '../../src/jobs/claim.js';
import { createJobRegistry } from '../../src/jobs/registry.js';
import { runSlice } from '../../src/jobs/slice.js';
import { writeIso2709, type MarcDataField, type MarcRecord } from '../../src/marc/index.js';
import { __setSlimsSourceFactory, __setSlimsStages } from '../../src/migration/slims/factory.js';
import { startSlimsMigration } from '../../src/migration/slims/job.js';
import { slimsJobs } from '../../src/migration/slims/jobs.js';
import { __setSlimsStageBatch } from '../../src/migration/slims/stages/stage-a-kit.js';
import { searchCatalog } from '../../src/search/search.js';
import type { CatalogSearchQuery } from '../../src/search/types.js';
import { readSettings } from '../../src/settings/service.js';
import { startFakeSru, type FakeSru } from '../support/fake-sru.js';
import { cf, df } from '../support/marc-corpus.js';
import { isbn13 } from '../support/search-corpus.js';
import { slimsFixtureBytes } from '../support/slims-fixture/index.js';
import { KEYRING, importFile, openExchangeDb, stageFile, type ExchangeDb } from './catalog-exchange-support.js';
import { NOW, seedFile } from './catalog-records-support.js';

// Acceptance K8, "every write path is searchable" (Phase 2 spec §4.1, §15; plan Task 39): a record saved through each
// write path is found by a unique word of its title right after the transaction of that path, on the engine picked by
// ALTIS_TEST_DB. The paths are the editor's create and update (with archive, restore and cover), an item change
// (create, update, batch, bulk, archive), an attachment change (create, update, archive), a merge, an import (MARC
// and CSV, create and update), an SRU copy saved, and the SLiMS migration.
//
// No reindex job ever runs here (§4.1: `search_term` alone is left to `catalog.reindex`): a record is findable only
// because its path indexed it in its own transaction, and every check also asserts that no `catalog.reindex` was
// queued to do it instead. Where a path does not change the title (items, attachments, a merge, a cover), the title is
// first changed straight in `records` without indexing (`stale`), and the word is shown not to be found yet: only the
// path's own index write can make it findable.
//
// The same records must be found on every engine (§4.3: the result sets are compared): the section "every engine finds
// the same records" pins the words whose engines' parsers and collations read them differently (Task 39).

const ctx = testDbContext();

/** Invented words, so that each one names exactly the record a test gave it. */
const W = {
  form: 'kalpataruwangi',
  formHidden: 'sembunyiwangi',
  update: 'sembranibiru',
  cover: 'sampulkencana',
  restore: 'pulihjelita',
  itemNew: 'eksemplarnaga',
  itemUpdate: 'eksemplarrusa',
  itemBatch: 'eksemplarbangau',
  itemBulk: 'eksemplarbadak',
  itemArchive: 'eksemplarmerak',
  attachNew: 'lampiranlembayung',
  attachUpdate: 'lampiranjingga',
  attachArchive: 'lampiranzamrud',
  mergeSource: 'lontaragemilang',
  mergeTarget: 'pinisisamudra',
  mergeAgent: 'pattingalloang',
  importMarc: 'jalasvevajaya',
  importMarcUpdate: 'trisaktimandala',
  importCsv: 'bhinnekarupa',
} as const;

describe.skipIf(!ctx.available)(`K8: a record saved through every write path is found by its title right after the transaction [${engineLabel()}]`, () => {
  let db: ExchangeDb;
  let fake: FakeSru;
  let buku: string;
  let umum: string;

  beforeAll(async () => {
    db = await openExchangeDb('search-every-path');
    fake = await startFakeSru();
    buku = await db.materialTypeId('BUKU');
    umum = await db.collectionTypeId('UMUM');
  }, 60_000);

  afterAll(async () => {
    await fake?.close();
    await db?.close();
  });

  /** The ids `text` finds right now (a correction the search applied in place of `text` counts as nothing found). */
  async function hits(text: string, q: Partial<CatalogSearchQuery> = {}): Promise<string[]> {
    const r = await searchCatalog(db.h.db, { text, scope: 'opac', page: 1, pageSize: 200, ...q }, { now: NOW });
    return r.correction?.applied === true ? [] : [...r.recordIds].sort();
  }

  /** What the admin finds, hidden and archived records included. */
  const adminHits = (text: string): Promise<string[]> => hits(text, { scope: 'admin', filters: { includeArchived: true, includeHidden: true } });

  /** The `catalog.reindex` jobs queued so far: a path must never leave its indexing to one. */
  async function reindexJobs(): Promise<number> {
    const row = await db.h.db
      .selectFrom('jobs')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('type', '=', 'catalog.reindex')
      .executeTakeFirstOrThrow();
    return Number(row.n);
  }

  /** `title` written straight into `records` (no index write): its words must not be found until a path indexes. */
  async function stale(recordId: string, title: string): Promise<void> {
    await db.h.db.updateTable('records').set({ title }).where('id', '=', recordId).execute();
    expect(await hits(title)).toEqual([]);
  }

  /** The row's version, read outside any transaction (SQLite has one connection: a read inside `db.run` would wait for it). */
  const version = async (table: 'records' | 'items' | 'attachments', id: string): Promise<number> =>
    Number((await db.h.db.selectFrom(table as 'records').select('version').where('id', '=', id).executeTakeFirstOrThrow()).version);

  /** A record made through the editor's create; its id. */
  const record = (title: string, extra: Partial<Parameters<typeof createRecord>[1]> = {}): Promise<string> =>
    db.run(async (tx) => (await createRecord(tx, { materialTypeId: buku, title, ...extra })).id);

  // ---- the editor ------------------------------------------------------------------------------------------------

  it('form create: the record is found by its title, author and ISBN once its transaction committed; a hidden one by the admin only', async () => {
    const isbn = isbn13('978602900101');
    const id = await db.run(async (tx) => {
      const made = await createRecord(tx, {
        materialTypeId: buku,
        title: `Hikayat ${W.form}`,
        identifiers: [{ type: 'isbn', value: isbn }],
        agents: [{ ref: { type: 'person', name: 'Wirasenapati, Dyah' }, role: 'aut', isMain: true }],
      });
      // Inside the transaction the document is there already (§4.1: the same transaction, not after it).
      const inside = await tx.trx.selectFrom('search_doc').select('record_id').where('record_id', '=', made.id).execute();
      expect(inside).toHaveLength(1);
      return made.id;
    });
    expect(await hits(W.form)).toEqual([id]);
    expect(await hits(`judul:${W.form}`)).toEqual([id]);
    expect(await hits('pengarang:wirasenapati')).toEqual([id]);
    expect(await hits(isbn)).toEqual([id]);

    const hidden = await record(`Catatan ${W.formHidden}`, { opacVisible: false });
    expect(await hits(W.formHidden)).toEqual([]);
    expect(await adminHits(W.formHidden)).toEqual([hidden]);
    expect(await reindexJobs()).toBe(0);
  });

  it('a rolled-back save leaves nothing to find', async () => {
    await expect(
      withTx(db.h, async (trx) => {
        await createRecord(txCtx(trx, NOW, { type: 'staff', id: newId(NOW), ip: null }), { materialTypeId: buku, title: 'Gagalwangi Batal' });
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect(await adminHits('gagalwangi')).toEqual([]);
  });

  it('update: the new title is found and the old one is gone; archive, restore and a new cover re-index too', async () => {
    const id = await record(`Kitab ${W.form}duplikat`);
    await db.run((tx) => updateRecord(tx, id, { version: 0, title: `Kitab ${W.update}` }));
    expect(await hits(W.update)).toEqual([id]);
    expect(await hits(`${W.form}duplikat`)).toEqual([]);

    await db.run((tx) => archiveRecord(tx, id, 1));
    expect(await hits(W.update)).toEqual([]);
    expect(await adminHits(W.update)).toEqual([id]);

    await stale(id, `Kitab ${W.restore}`);
    const v1 = await version('records', id);
    await db.run((tx) => restoreRecord(tx, id, v1));
    expect(await hits(W.restore)).toEqual([id]);

    const cover = await seedFile(db, { context: 'catalog.cover' });
    await stale(id, `Kitab ${W.cover}`);
    const v2 = await version('records', id);
    await db.run((tx) => setCover(tx, id, cover, v2));
    expect(await hits(W.cover)).toEqual([id]);
    expect(await reindexJobs()).toBe(0);
  });

  // ---- items -----------------------------------------------------------------------------------------------------

  it('item change: create, update, batch, bulk and archive each re-index the record (its title, barcodes and availability)', async () => {
    const id = await record('Belum diganti');

    await stale(id, `Serat ${W.itemNew}`);
    const item = await db.run((tx) => createItem(tx, db.branchId, { recordId: id, barcode: 'SEP77001', collectionTypeId: umum, status: 'available', partsTotal: 1 }));
    expect(await hits(W.itemNew)).toEqual([id]);
    expect(await hits('sep77001')).toEqual([id]);
    expect(await hits(W.itemNew, { filters: { available: true } })).toEqual([id]);

    await stale(id, `Serat ${W.itemUpdate}`);
    await db.run((tx) => updateItem(tx, db.branchId, item.id, { version: item.version, status: 'repair', barcode: 'SEP77002' }));
    expect(await hits(W.itemUpdate)).toEqual([id]);
    expect(await hits('sep77002')).toEqual([id]);
    expect(await hits('sep77001')).toEqual([]);
    expect(await hits(W.itemUpdate, { filters: { available: true } })).toEqual([]);

    await stale(id, `Serat ${W.itemBatch}`);
    const batch = await db.run((tx) =>
      batchCreateItems(tx, db.branchId, { recordId: id, count: 2, barcodes: ['SEP77003', 'SEP77004'], template: { collectionTypeId: umum, status: 'processing', partsTotal: 1 } }),
    );
    expect(batch.created).toHaveLength(2);
    expect(await hits(W.itemBatch)).toEqual([id]);
    expect(await hits('sep77004')).toEqual([id]);
    expect(await hits(W.itemBatch, { filters: { available: true } })).toEqual([]);

    await stale(id, `Serat ${W.itemBulk}`);
    const bulk = await db.run((tx) => bulkUpdateItems(tx, db.branchId, { ids: batch.created.map((c) => c.id), set: { status: 'available' } }));
    expect(bulk).toMatchObject({ updated: 2, refused: [] });
    expect(await hits(W.itemBulk)).toEqual([id]);
    expect(await hits(W.itemBulk, { filters: { available: true } })).toEqual([id]);

    await stale(id, `Serat ${W.itemArchive}`);
    const itemVersion = await version('items', item.id);
    await db.run((tx) => archiveItem(tx, db.branchId, item.id, itemVersion));
    expect(await hits(W.itemArchive)).toEqual([id]);
    expect(await hits('sep77002')).toEqual([]);
    expect(await reindexJobs()).toBe(0);
  });

  // ---- attachments -----------------------------------------------------------------------------------------------

  it('attachment change: create, update and archive each re-index the record (its title and the attachment facet)', async () => {
    const id = await record('Belum diganti juga');

    await stale(id, `Babad ${W.attachNew}`);
    const link = await db.run((tx) => createAttachment(tx, id, { kind: 'url', url: 'https://contoh.example.org/babad', title: 'Tautan', access: 'public' }));
    expect(await hits(W.attachNew)).toEqual([id]);
    expect(await hits(W.attachNew, { filters: { attachmentKinds: ['url'] } })).toEqual([id]);

    const fileId = await seedFile(db, { context: 'catalog.attachment', mime: 'application/pdf' });
    const pdf = await db.run((tx) => createAttachment(tx, id, { kind: 'file', fileId, title: 'Berkas', access: 'public' }));
    expect(await hits(W.attachNew, { filters: { attachmentKinds: ['pdf'] } })).toEqual([id]);

    await stale(id, `Babad ${W.attachUpdate}`);
    await db.run((tx) => updateAttachment(tx, link.id, { version: link.version, access: 'staff' }));
    expect(await hits(W.attachUpdate)).toEqual([id]);
    expect(await hits(W.attachUpdate, { filters: { attachmentKinds: ['url'] } })).toEqual([]);

    await stale(id, `Babad ${W.attachArchive}`);
    await db.run((tx) => archiveAttachment(tx, pdf.id, pdf.version));
    expect(await hits(W.attachArchive)).toEqual([id]);
    expect(await hits(W.attachArchive, { filters: { attachmentKinds: ['pdf'] } })).toEqual([]);
    expect(await reindexJobs()).toBe(0);
  });

  // ---- merge -----------------------------------------------------------------------------------------------------

  it("merge: the source's title is gone, the target is found by its own title and by what moved to it", async () => {
    const isbn = isbn13('978602900202');
    const source = await record(`Hikayat ${W.mergeSource}`, {
      identifiers: [{ type: 'isbn', value: isbn }],
      agents: [{ ref: { type: 'person', name: `${W.mergeAgent}, Karaeng` }, role: 'aut', isMain: true }],
    });
    await db.run((tx) => createItem(tx, db.branchId, { recordId: source, barcode: 'MRG88001', collectionTypeId: umum, status: 'available', partsTotal: 1 }));
    const target = await record('Sebelum digabung');
    await stale(target, `Hikayat ${W.mergeTarget}`);

    const targetVersion = await version('records', target);
    await db.run((tx) => mergeRecord(tx, target, source, targetVersion));
    expect(await hits(W.mergeTarget)).toEqual([target]);
    expect(await hits(W.mergeSource)).toEqual([]);
    expect(await adminHits(W.mergeSource)).toEqual([source]);
    expect(await hits(isbn)).toEqual([target]);
    expect(await hits(`pengarang:${W.mergeAgent}`)).toEqual([target]);
    expect(await hits('mrg88001')).toEqual([target]);
    expect(await reindexJobs()).toBe(0);
  });

  // ---- imports ---------------------------------------------------------------------------------------------------

  /** A small book record for an import file. */
  const book = (o: { id: string; title: string; isbn?: string; extra?: MarcDataField[] }): MarcRecord => ({
    leader: '00000nam a2200000 i 4500',
    fields: [cf('001', o.id), ...(o.isbn === undefined ? [] : [df('020', '  ', `a${o.isbn}`)]), df('245', '10', `a${o.title}`), ...(o.extra ?? [])],
  });
  const iso = (records: MarcRecord[]): Buffer => Buffer.concat(records.map((r) => Buffer.from(writeIso2709(r))));
  const bySource = async (runId: string): Promise<string[]> =>
    (await db.h.db.selectFrom('records').select('id').where('source', '=', `import:${runId}`).execute()).map((r) => r.id).sort();

  it('import (MARC): a created record is found by its title, and one the file updates by ISBN by its new title', async () => {
    const r = await importFile(db, iso([book({ id: 'K8-1', title: `Hikayat ${W.importMarc}`, extra: [df('100', '1 ', 'aNalendra, Gusti')] })]));
    expect([r.run.status, r.summary.created, r.summary.errors]).toEqual(['succeeded', 1, 0]);
    const made = await bySource(r.runId);
    expect(made).toHaveLength(1);
    expect(await hits(W.importMarc)).toEqual(made);
    expect(await hits('pengarang:nalendra')).toEqual(made);

    const isbn = isbn13('978602900303');
    const stored = await record('Judul sebelum impor', { identifiers: [{ type: 'isbn', value: isbn }] });
    const u = await importFile(db, iso([book({ id: 'K8-2', title: `Hikayat ${W.importMarcUpdate}`, isbn })]), { matchOn: 'isbn', onMatch: 'update' });
    expect([u.run.status, u.summary.created, u.summary.updated]).toEqual(['succeeded', 0, 1]);
    expect(await hits(W.importMarcUpdate)).toEqual([stored]);
    expect(await hits('sebelum impor')).toEqual([]);
    expect(await reindexJobs()).toBe(0);
  });

  it('import (CSV): every created record is found by its title', async () => {
    const csv = `title,authors,year\r\nPustaka ${W.importCsv},"Sasmita, Laras",2019\r\nPustaka ${W.importCsv} jilid dua,,2020\r\n`;
    const r = await importFile(db, csv);
    expect([r.run.status, r.summary.created, r.summary.errors]).toEqual(['succeeded', 2, 0]);
    const made = await bySource(r.runId);
    expect(made).toHaveLength(2);
    expect(await hits(W.importCsv)).toEqual(made);
    expect(await hits(`"${W.importCsv} jilid"`)).toHaveLength(1);
    expect(await reindexJobs()).toBe(0);
  });

  // ---- SRU copy --------------------------------------------------------------------------------------------------

  it('SRU save: a copy taken from an SRU server and saved is found by its title, its note and its ISBN', async () => {
    const server: SruServer = {
      id: 'perpusnas',
      name: 'Perpusnas',
      url: `${fake.url}/sru`,
      version: '1.2',
      recordSchema: 'marcxml',
      indexes: { isbn: 'bath.isbn', title: 'dc.title', author: 'dc.creator', any: 'cql.serverChoice' },
      enabled: true,
    };
    const page = await sruSearchDrafts(server, 'title', 'edensor', { start: 1, allowPrivate: true, materialTypeCodeFor: await copyMaterialTypeResolver(db.h.db) });
    expect(page.drafts).toHaveLength(1);
    const draft = page.drafts[0]!;
    // What the editor posts after the librarian picked the copy: the draft's body with its source.
    const { body } = await recordBodyFromDraft(db.h.db, draft, { defaultMaterialTypeId: buku });
    const id = await db.run(async (tx) => (await createRecord(tx, { ...body, source: 'sru:perpusnas' })).id);
    expect((await db.h.db.selectFrom('records').select('source').where('id', '=', id).executeTakeFirstOrThrow()).source).toBe('sru:perpusnas');
    expect(await hits('edensor')).toEqual([id]);
    expect(await hits('universite')).toEqual([id]);
    expect(await hits(draft.identifiers[0]!.value)).toEqual([id]);
    expect(await reindexJobs()).toBe(0);
  });

  // ---- every engine finds the same records ------------------------------------------------------------------------
  //
  // The engines' own full-text parsers read the token text again (§4.3), and each reads it its own way: InnoDB's
  // character table predates Javanese, Sundanese and Batak and treats every character beyond the BMP as a separator,
  // and its collation (the server's default, utf8mb4_unicode_ci here) equates hiragana with katakana and a digit with
  // the same digit of another script; PostgreSQL's parser cuts `2e10x` into a float and a word, and its weighted vector
  // joins the columns end to end, so a phrase ran on from the title into the authors. The words below must find the
  // same records on every engine, as they do on SQLite.

  it('every engine: a word in Javanese, Sundanese, Batak, a CJK ideograph beyond the BMP, Arabic, Cyrillic or Greek finds its record', async () => {
    const titles = {
      javanese: 'Serat ꦗꦮꦏꦤ',
      sundanese: 'Wawacan ᮞᮔᮓᮛ',
      batak: 'Pustaha ᯅᯖᯂ',
      astral: 'Kisah 𠮷野家 dan 𠀋',
      arabic: 'Kitab مكتبة',
      cyrillic: 'Книга библиотека',
      greek: 'Βιβλίο βιβλιοθήκη',
    } as const;
    const ids: Record<string, string> = {};
    for (const [key, title] of Object.entries(titles)) ids[key] = await record(title);
    expect(await hits('ꦗꦮꦏꦤ')).toEqual([ids['javanese']]);
    expect(await hits('ᮞᮔᮓᮛ')).toEqual([ids['sundanese']]);
    expect(await hits('ᯅᯖᯂ')).toEqual([ids['batak']]);
    expect(await hits('𠮷野家')).toEqual([ids['astral']]);
    expect(await hits('𠀋')).toEqual([ids['astral']]);
    // `野家` alone is not a word of the title (the ideographs run together into one word, as everywhere).
    expect(await hits('野家')).toEqual([]);
    expect(await hits('مكتبة')).toEqual([ids['arabic']]);
    expect(await hits('БИБЛИОТЕКА')).toEqual([ids['cyrillic']]);
    expect(await hits('библио*')).toEqual([ids['cyrillic']]);
    expect(await hits('βιβλιοθηκη')).toEqual([ids['greek']]);
    expect(await hits('judul:ꦗꦮꦏꦤ')).toEqual([ids['javanese']]);
  });

  it('every engine: hiragana is not katakana, and an Arabic-Indic number is not the same number in ASCII digits', async () => {
    const hiragana = await record('Buku ひらがなのほん');
    const katakana = await record('Buku ヒラガナノホン');
    const arabicDigits = await record('Laporan tahunan ١٩٤٥٢');
    const asciiDigits = await record('Laporan tahunan 19452');
    expect(await hits('ひらがなのほん')).toEqual([hiragana]);
    expect(await hits('ヒラガナノホン')).toEqual([katakana]);
    expect(await hits('١٩٤٥٢')).toEqual([arabicDigits]);
    expect(await hits('19452')).toEqual([asciiDigits]);
  });

  it('every engine: a phrase stays inside one field, and a word like 2e10x stays one word', async () => {
    const id = await record('Kembara Senjakala', { agents: [{ ref: { type: 'person', name: 'Lintangpagi, Rara' }, role: 'aut', isMain: true }] });
    expect(await hits('"kembara senjakala"')).toEqual([id]);
    expect(await hits('"rara lintangpagi"')).toEqual([id]);
    // The title's last word and the author's first: adjacent only across the end of a field.
    expect(await hits('"senjakala lintangpagi"')).toEqual([]);
    expect(await hits('-"senjakala lintangpagi" kembara')).toEqual([id]);

    const float = await record('Reaktor 2e10x');
    expect(await hits('2e10x')).toEqual([float]);
    expect(await hits('2e10')).toEqual([]);
    expect(await hits('2e10*')).toEqual([float]);
    expect(await hits('2e1*')).toEqual([float]);
  });

  // ---- the SLiMS migration ---------------------------------------------------------------------------------------

  it('migration: a record is found right after the batch that migrated it, while the run goes on; every migrated record is indexed', async () => {
    const silent = { info() {}, warn() {}, error() {} };
    const registry = createJobRegistry(slimsJobs(db.deps));
    __setSlimsSourceFactory(null);
    __setSlimsStages(null);
    // Batches of 5 rows: `biblio` 4 is migrated in the first batch of the records stage, `biblio` 34 seven batches later.
    __setSlimsStageBatch(5);
    try {
      const fixture = slimsFixtureBytes();
      const libraryName = String((await readSettings(db.h.db, ['library.name'], []))['library.name']);
      const dumpStagingId = await stageFile(db, fixture.dump);
      const filesStagingId = await stageFile(db, fixture.filesZip);
      const { runId, jobId } = await withTx(db.h, (trx) =>
        startSlimsMigration(
          txCtx(trx, NOW, db.staff),
          registry,
          {
            dryRun: false,
            sourceKind: 'dump',
            db: null,
            password: null,
            dumpStagingId,
            files: 'zip',
            filesStagingId,
            filesDir: null,
            branchId: db.branchId,
            priceMode: 'major',
            sourceName: 'slims',
            // The other paths of this file left records in the catalogue.
            allowNonEmpty: true,
            confirmLibraryName: libraryName,
            fromRunId: null,
          },
          { keyring: KEYRING },
        ),
      );
      const runStatus = async (): Promise<string> =>
        (await db.h.db.selectFrom('catalog_runs').select('status').where('id', '=', runId).executeTakeFirstOrThrow()).status;
      const migrated = async (biblioId: number): Promise<string | null> =>
        (
          await db.h.db
            .selectFrom('migration_map')
            .select('target_id')
            .where('source', '=', 'slims')
            .where('entity', '=', 'biblio')
            .where('legacy_key', '=', String(biblioId))
            .executeTakeFirst()
        )?.target_id ?? null;

      // One stage call per slice (a budget equal to the framework's save margin, the clock standing still) until biblio 4
      // is checked, then 20 s slices. The split of the dump thus takes several slices too, each resumed from its checkpoint.
      let checked = false;
      let splitSlices = 0;
      let outcome = 'continued';
      for (let slice = 0; slice < 3000 && outcome === 'continued'; slice += 1) {
        const payload = JSON.parse((await db.h.db.selectFrom('jobs').select('payload').where('id', '=', jobId).executeTakeFirstOrThrow()).payload) as { stage: number };
        if (payload.stage === 0) splitSlices += 1;
        const job = await claimById(db.h, registry, jobId, { worker: 'test', now: NOW });
        if (job === null) throw new Error('the migration job cannot be claimed');
        const budgetMs = checked ? 20_000 : 2_000;
        outcome = (await runSlice(db.h, registry, job, { mode: 'worker', budgetMs, keyring: KEYRING, log: silent, clock: () => NOW, env: {} })).outcome;
        const first = checked ? null : await migrated(4);
        if (first === null) continue;
        // Right after the slice whose batch migrated biblio 4: found by its title while the run goes on, biblio 34 not yet.
        expect(await runStatus()).toBe('running');
        expect(await hits('oreilly')).toEqual([first]);
        expect(await migrated(34)).toBeNull();
        expect(await hits('tubruk')).toEqual([]);
        checked = true;
        __setSlimsStageBatch(null);
      }
      expect([outcome, checked, await runStatus()]).toEqual(['succeeded', true, 'succeeded']);
      expect(splitSlices).toBeGreaterThan(1);

      // biblio 34's mojibake title is found by its repaired word, biblio 4's by its word without the apostrophe.
      expect(await hits('tubruk')).toEqual([await migrated(34)]);
      expect(await hits('oreilly')).toEqual([await migrated(4)]);
      expect(await hits('"laskar pelangi"')).toEqual([await migrated(1)]);
      // Every record the run made (each `biblio`, and the stand-ins of the items whose `biblio` is missing) has its
      // document: none is left for a reindex to find.
      const records = (await db.h.db.selectFrom('records').select('id').where('source', 'like', 'slims:%').execute()).map((r) => r.id);
      const mapped = await db.h.db
        .selectFrom('migration_map')
        .select('entity')
        .where('source', '=', 'slims')
        .where('entity', 'in', ['biblio', 'biblio_missing'])
        .execute();
      expect(mapped.filter((m) => m.entity === 'biblio')).toHaveLength(fixture.expected.tables['biblio']!.source);
      expect(records).toHaveLength(mapped.length);
      const docs = new Set<string>();
      for (let i = 0; i < records.length; i += 200) {
        for (const r of await db.h.db.selectFrom('search_doc').select('record_id').where('record_id', 'in', records.slice(i, i + 200)).execute()) docs.add(r.record_id);
      }
      expect(records.filter((id) => !docs.has(id))).toEqual([]);
      expect(await reindexJobs()).toBe(0);
    } finally {
      __setSlimsStageBatch(null);
    }
  }, 300_000);
});
