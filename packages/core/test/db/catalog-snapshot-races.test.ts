import { withTx } from '@altis/db';
import { newId, type Permission } from '@altis/shared';
import type { MaterialTypeBody } from '@altis/shared/api/catalog/masters';
import type { RecordDraft } from '@altis/shared/api/catalog/record-data';
import type { RecordCreateBody } from '@altis/shared/api/catalog/records';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import type { Grants } from '../../src/authz/grants.js';
import { loadCustomDefs, readCustomValues } from '../../src/catalog/data/custom-fields.js';
import { importBatch, type BatchSettings, type ImportUnit } from '../../src/catalog/exchange/import-batch.js';
import { batchCreateItems } from '../../src/catalog/items/batch.js';
import { bulkUpdateItems } from '../../src/catalog/items/bulk.js';
import { createItem, updateItem } from '../../src/catalog/items/service.js';
import { archiveLocation } from '../../src/catalog/locations/service.js';
import { archiveCollectionType, createCollectionType } from '../../src/catalog/masters/collection-types.js';
import { archiveLanguage, createLanguage } from '../../src/catalog/masters/languages.js';
import { createCustomField, updateCustomField } from '../../src/catalog/masters/custom-fields.js';
import { archiveMaterialType, createMaterialType, updateMaterialType } from '../../src/catalog/masters/material-types.js';
import { archiveSupplier } from '../../src/catalog/masters/suppliers.js';
import { mergeRecord } from '../../src/catalog/records/merge.js';
import { archiveRecord, createRecord, updateRecord } from '../../src/catalog/records/service.js';
import { txCtx, type TxCtx } from '../../src/context.js';
import {
  ACTOR,
  NOW,
  failure,
  fieldErrors,
  openItemsDb,
  seedItem,
  seedItemCustomField,
  seedLocation,
  seedRecord,
  seedSupplier,
  type ItemsDb,
} from './catalog-items-support.js';

// Phase 2 big review, group P1-catalog-writes: the catalogue writers inside a transaction that has read before them.
// An import batch (Task 31) runs ~200 units in ONE transaction, so its first plain read fixes the MySQL/MariaDB
// REPEATABLE READ snapshot long before a unit's service locks its row. A row-lock write that changes nothing does not
// refresh that snapshot; only a write's WHERE (or a locking read) sees the latest commit. Each case here takes the
// snapshot on one connection, commits a librarian's change on a second, then runs the service (through the import
// where the import is the caller), and checks that the service refused on the latest commit before writing anything.
//
// The Task 40 follow-ups T17-KUNCI-LOKASI-SAAT-PENEMPATAN and T12-T13-BALAPAN-ARSIP-REFERENSI (group P1): a writer
// that names a location or a master (collection type, supplier, material type, language) locks its row with a write
// that matches only a live row before it relies on it, as the archive of that row locks it before it counts what
// uses it. Those cases keep the first transaction open after the writer ran while the archive starts on the second
// connection: the archive must wait for the writer's commit and then count what it saved.
//
// The cases run on the server engines (on SQLite BEGIN IMMEDIATE serializes the writers, so the second connection
// would wait for the first). PostgreSQL (READ COMMITTED) never had the stale snapshot: each statement reads the latest
// commit, so there the unit sees the librarian's change and goes on from it; the cases pin that this stays right too.

const ctx = testDbContext();
const SERVER = ctx.engine !== 'sqlite';
/** The engines whose default isolation is REPEATABLE READ with a snapshot fixed by the first plain read. */
const SNAPSHOT = ['mysql80', 'mysql84', 'mariadb106', 'mariadb114'].includes(ctx.engine);
/** How long a writer's transaction stays open while the archive on the second connection runs. */
const HOLD_MS = 500;
const ITEMS_EVERYWHERE: Grants = {
  global: new Set<Permission>(['catalog.items.manage']),
  branches: new Map(),
  superAdmin: false,
  roleMfaRequired: false,
};

describe.skipIf(!ctx.available)(`catalogue writers after an earlier read of their transaction [${engineLabel()}]`, () => {
  let db: ItemsDb;
  /** A second connection: the librarian saving while the batch runs. */
  let h2: TestDbHandle;
  let buku: string;
  let umum: string;

  beforeAll(async () => {
    db = await openItemsDb('snapshot-races');
    h2 = await testDb({ reset: false });
    buku = (await db.h.db.selectFrom('material_types').select('id').where('code_key', '=', 'BUKU').executeTakeFirstOrThrow()).id;
    umum = await db.collectionTypeId('UMUM');
    await seedItemCustomField(db, { code: 'asal' });
  });

  afterAll(async () => {
    await h2?.close();
    await db?.close();
  });

  /** `fn` on the second connection, committed. */
  const meanwhile = <T>(fn: (tx: TxCtx) => Promise<T>): Promise<T> => withTx(h2, (trx) => fn(txCtx(trx, NOW, ACTOR)));

  /**
   * `fn` in a transaction of the first connection whose snapshot a plain read took before `between` committed on the
   * second connection (what an import batch sees when a librarian saves during it). Run once: no retry.
   */
  const afterSnapshot = <T>(between: () => Promise<unknown>, fn: (tx: TxCtx) => Promise<T>): Promise<T> =>
    withTx(
      db.h,
      async (trx) => {
        await trx.selectFrom('records').select('id').limit(1).execute();
        await between();
        return fn(txCtx(trx, NOW, ACTOR));
      },
      { retry: false },
    );

  /**
   * `writer` in a transaction of the first connection that stays open {@link HOLD_MS} after it ran, while `archive`
   * starts on the second connection; what the archive came to (failure(): 'resolved' when it went through). Locking
   * the row the writer relied on makes the archive wait for the commit and then count what the writer saved; without
   * the lock the archive commits while the writer's transaction is still open.
   */
  async function archiveWhileOpen(writer: (tx: TxCtx) => Promise<unknown>, archive: (tx: TxCtx) => Promise<unknown>): Promise<unknown> {
    let outcome: Promise<unknown> = Promise.resolve('not started');
    await withTx(
      db.h,
      async (trx) => {
        await writer(txCtx(trx, NOW, ACTOR));
        outcome = failure(meanwhile(archive));
        await new Promise((resolve) => setTimeout(resolve, HOLD_MS));
      },
      { retry: false },
    );
    return outcome;
  }

  // A record unit's lists are the whole list in MARCXML: a CSV update keeps the stored identifiers other than ISBN and
  // ISSN in their places (review C12), so these record cases, whose identifiers are `other`, import MARCXML.
  async function batchSettings(o: Partial<BatchSettings> = {}): Promise<BatchSettings> {
    return {
      runId: newId(NOW),
      format: 'marcxml',
      matchOn: 'record_id',
      onMatch: 'update',
      onDuplicate: 'report',
      createItems: false,
      branchId: db.branchId,
      defaultMaterialTypeId: buku,
      defaultCollectionTypeId: umum,
      threshold: 100,
      grants: ITEMS_EVERYWHERE,
      recordDefs: await loadCustomDefs(db.h.db, 'records'),
      itemDefs: await loadCustomDefs(db.h.db, 'items'),
      ...o,
    };
  }

  function recordUnit(recordId: string, draft: Partial<RecordDraft>): ImportUnit {
    return {
      kind: 'record',
      recordNo: 1,
      line: 2,
      draft: { materialTypeCode: null, title: 'Laskar Pelangi', publisher: null, identifiers: [], agents: [], subjects: [], links: [], items: [], marcExtra: [], ...draft },
      recordId,
      opacVisible: null,
      rawCustom: false,
      issues: [],
    };
  }

  const record = async (b: Partial<RecordCreateBody> = {}): Promise<string> =>
    (await db.run((tx) => createRecord(tx, { materialTypeId: buku, title: 'Laskar Pelangi', ...b }))).id;

  const versionOf = async (table: 'records' | 'items', id: string): Promise<number> =>
    Number((await db.h.db.selectFrom(table as 'records').select('version').where('id', '=', id).executeTakeFirstOrThrow()).version);

  const identifiersOf = async (id: string): Promise<string[]> =>
    (await db.h.db.selectFrom('record_identifiers').select('value_display').where('record_id', '=', id).orderBy('sort_order').execute()).map((r) => r.value_display);

  const agentNamesOf = async (id: string): Promise<string[]> =>
    (
      await db.h.db
        .selectFrom('record_agents')
        .innerJoin('agents', 'agents.id', 'record_agents.agent_id')
        .select('agents.name_display')
        .where('record_agents.record_id', '=', id)
        .orderBy('record_agents.sort_order')
        .execute()
    ).map((r) => r.name_display);

  describe('C01: an update compares the version on the latest commit before it writes a list', () => {
    it.skipIf(!SERVER)('a record the librarian saved after the batch read it: CONFLICT_STALE, and the librarian’s lists stay', async () => {
      const id = await record({
        identifiers: [{ type: 'other', value: 'ASLI-1' }],
        agents: [{ ref: { type: 'person', name: 'Hirata, Andrea' }, role: 'aut', isMain: true }],
      });
      const settings = await batchSettings();
      const outcome = await afterSnapshot(
        () =>
          meanwhile((tx) =>
            updateRecord(tx, id, {
              version: 0,
              identifiers: [{ type: 'other', value: 'PUSTAKAWAN-1' }],
              agents: [{ ref: { type: 'person', name: 'Pustakawan, Uji' }, role: 'aut', isMain: true }],
            }),
          ),
        (tx) =>
          importBatch(tx, settings, [
            recordUnit(id, {
              identifiers: [{ type: 'other', value: 'IMPOR-1' }],
              agents: [{ type: 'person', name: 'Impor, Uji', role: 'aut', isMain: true }],
            }),
          ]),
      );
      if (SNAPSHOT) {
        // The unit read version 0 from the snapshot: refused on the latest commit, nothing of the import written.
        expect(outcome.counts).toMatchObject({ updated: 0, errors: 1 });
        expect(outcome.rows.map((r) => [r[2], r[3]])).toEqual([['error', 'CONFLICT_STALE']]);
        expect(await versionOf('records', id)).toBe(1);
        expect(await identifiersOf(id)).toEqual(['PUSTAKAWAN-1']);
        expect(await agentNamesOf(id)).toEqual(['Pustakawan, Uji']);
      } else {
        // The unit read version 1: the update goes on from the librarian's save, the whole of it.
        expect(outcome.counts).toMatchObject({ updated: 1, errors: 0 });
        expect(await versionOf('records', id)).toBe(2);
        expect(await identifiersOf(id)).toEqual(['IMPOR-1']);
        expect(await agentNamesOf(id)).toEqual(['Impor, Uji']);
      }
    });

    it.skipIf(!SERVER)('an item the librarian saved after the batch read it: CONFLICT_STALE, and the librarian’s custom value stays', async () => {
      const recordId = await record();
      const item = await db.run((tx) => createItem(tx, db.branchId, { recordId, barcode: 'SR-C01-1', collectionTypeId: umum, status: 'available', partsTotal: 1, custom: { asal: 'hibah' } }));
      const settings = await batchSettings({ format: 'csv-items' });
      const outcome = await afterSnapshot(
        () => meanwhile((tx) => updateItem(tx, db.branchId, item.id, { version: 0, custom: { asal: 'pustakawan' } })),
        (tx) => importBatch(tx, settings, [{ kind: 'item', recordNo: 1, line: 2, item: { barcode: 'SR-C01-1', custom: { asal: 'impor' } }, issues: [] }]),
      );
      if (SNAPSHOT) {
        expect(outcome.counts).toMatchObject({ updated: 0, errors: 1 });
        expect(outcome.rows.map((r) => [r[2], r[3]])).toEqual([['error', 'CONFLICT_STALE']]);
        expect(await versionOf('items', item.id)).toBe(1);
        expect((await readCustomValues(db.h.db, 'items', [item.id])).get(item.id)).toEqual({ asal: 'pustakawan' });
      } else {
        expect(outcome.counts).toMatchObject({ updated: 1, errors: 0 });
        expect(await versionOf('items', item.id)).toBe(2);
        expect((await readCustomValues(db.h.db, 'items', [item.id])).get(item.id)).toEqual({ asal: 'impor' });
      }
    });

    it('with no change meanwhile the same import updates the record and its lists', async () => {
      const id = await record({ identifiers: [{ type: 'other', value: 'ASLI-2' }] });
      const settings = await batchSettings();
      const outcome = await afterSnapshot(
        async () => undefined,
        (tx) => importBatch(tx, settings, [recordUnit(id, { identifiers: [{ type: 'other', value: 'IMPOR-2' }] })]),
      );
      expect(outcome.counts).toMatchObject({ updated: 1, errors: 0 });
      expect(await versionOf('records', id)).toBe(1);
      expect(await identifiersOf(id)).toEqual(['IMPOR-2']);
    });
  });

  describe('C02: a new item checks its record on the latest commit', () => {
    const itemsOf = async (recordId: string): Promise<string[]> =>
      (await db.h.db.selectFrom('items').select('barcode_key').where('record_id', '=', recordId).orderBy('barcode_key').execute()).map((r) => r.barcode_key);

    it.skipIf(!SERVER)('createItem on a record merged after the transaction read: recordId archived, no item stranded on it', async () => {
      const source = await record({ title: 'Sumber Gabung' });
      const target = await record({ title: 'Tujuan Gabung' });
      const errors = await fieldErrors(
        afterSnapshot(
          () => meanwhile((tx) => mergeRecord(tx, target, source, 0)),
          (tx) => createItem(tx, db.branchId, { recordId: source, barcode: 'SR-C02-1', collectionTypeId: umum, status: 'available', partsTotal: 1 }),
        ),
      );
      expect(errors).toEqual([{ path: 'recordId', code: 'archived' }]);
      expect(await itemsOf(source)).toEqual([]);
    });

    it.skipIf(!SERVER)('a batch on a record archived after the transaction read: recordId archived, nothing written', async () => {
      const id = await record({ title: 'Diarsipkan Saat Batch' });
      const errors = await fieldErrors(
        afterSnapshot(
          () => meanwhile((tx) => archiveRecord(tx, id, 0)),
          (tx) => batchCreateItems(tx, db.branchId, { recordId: id, count: 2, barcodes: ['SR-C02-2', 'SR-C02-3'], template: { collectionTypeId: umum, status: 'available', partsTotal: 1 } }),
        ),
      );
      expect(errors).toEqual([{ path: 'recordId', code: 'archived' }]);
      expect(await itemsOf(id)).toEqual([]);
    });

    it.skipIf(!SERVER)('a CSV item row whose record was merged after the batch read: refused, no item stranded on it', async () => {
      const source = await record({ title: 'Sumber Impor' });
      const target = await record({ title: 'Tujuan Impor' });
      const settings = await batchSettings({ format: 'csv-items', onMatch: 'skip' });
      const outcome = await afterSnapshot(
        () => meanwhile((tx) => mergeRecord(tx, target, source, 0)),
        (tx) => importBatch(tx, settings, [{ kind: 'item', recordNo: 1, line: 2, item: { barcode: 'SR-C02-4', recordId: source, custom: {} }, issues: [] }]),
      );
      expect(outcome.counts).toMatchObject({ created: 0, itemsCreated: 0, errors: 1 });
      // The snapshot still shows the record live, so the row reaches createItem, which refuses on the latest commit;
      // without the snapshot the row finds no live record at all.
      expect(outcome.rows.map((r) => [r[2], r[3], r[4]])).toEqual([SNAPSHOT ? ['error', 'archived', 'recordId'] : ['error', 'record_not_found', 'record_id']]);
      expect(await itemsOf(source)).toEqual([]);
      expect(await itemsOf(target)).toEqual([]);
    });

    it('a live record still takes the item in a transaction that read before', async () => {
      const id = await record({ title: 'Tetap Hidup' });
      await afterSnapshot(
        async () => undefined,
        (tx) => createItem(tx, db.branchId, { recordId: id, barcode: 'SR-C02-5', collectionTypeId: umum, status: 'available', partsTotal: 1 }),
      );
      expect(await itemsOf(id)).toEqual(['SR-C02-5']);
    });
  });

  describe('Task 40 follow-ups: a writer locks the location or master it names before it relies on it', () => {
    const IN_USE = expect.objectContaining({ code: 'CATALOG_IN_USE' });
    const isArchived = async (table: 'locations' | 'collection_types' | 'suppliers' | 'material_types' | 'languages', id: string): Promise<boolean> =>
      (await db.h.db.selectFrom(table as 'locations').select('archived_at').where('id', '=', id).executeTakeFirstOrThrow()).archived_at !== null;
    const unique = (prefix: string): string => `${prefix}${newId().slice(-8)}`;

    it.skipIf(!SERVER)('T17: an item placed on a shelf while the shelf is archived: the archive waits and finds it', async () => {
      const recordId = await seedRecord(db);
      const shelf = await seedLocation(db, { code: unique('RAK-'), kind: 'room' });
      const outcome = await archiveWhileOpen(
        (tx) => createItem(tx, db.branchId, { recordId, barcode: unique('T17A'), collectionTypeId: umum, status: 'available', partsTotal: 1, locationId: shelf }),
        (tx) => archiveLocation(tx, db.branchId, shelf, 0),
      );
      expect(outcome).toEqual(IN_USE);
      expect(await isArchived('locations', shelf)).toBe(false);
    });

    it.skipIf(!SERVER)('T17: an item moved to a shelf while the shelf is archived: the archive waits and finds it', async () => {
      const recordId = await seedRecord(db);
      const shelf = await seedLocation(db, { code: unique('RAK-'), kind: 'room' });
      const itemId = await seedItem(db, recordId, { barcode: unique('T17B') });
      const outcome = await archiveWhileOpen(
        (tx) => updateItem(tx, db.branchId, itemId, { version: 0, locationId: shelf }),
        (tx) => archiveLocation(tx, db.branchId, shelf, 0),
      );
      expect(outcome).toEqual(IN_USE);
    });

    it.skipIf(!SERVER)('T17: a bulk move to a shelf while the shelf is archived: the archive waits and finds the items', async () => {
      const recordId = await seedRecord(db);
      const shelf = await seedLocation(db, { code: unique('RAK-'), kind: 'room' });
      const itemId = await seedItem(db, recordId, { barcode: unique('T17C') });
      const outcome = await archiveWhileOpen(
        (tx) => bulkUpdateItems(tx, db.branchId, { ids: [itemId], set: { locationId: shelf } }),
        (tx) => archiveLocation(tx, db.branchId, shelf, 0),
      );
      expect(outcome).toEqual(IN_USE);
    });

    it.skipIf(!SERVER)('T17: a shelf archived after the batch read is refused for a new item on the latest commit', async () => {
      const recordId = await seedRecord(db);
      const shelf = await seedLocation(db, { code: unique('RAK-'), kind: 'room' });
      const errors = await fieldErrors(
        afterSnapshot(
          () => meanwhile((tx) => archiveLocation(tx, db.branchId, shelf, 0)),
          (tx) => createItem(tx, db.branchId, { recordId, barcode: unique('T17D'), collectionTypeId: umum, status: 'available', partsTotal: 1, locationId: shelf }),
        ),
      );
      expect(errors).toEqual([{ path: 'locationId', code: 'archived' }]);
    });

    it.skipIf(!SERVER)('T12: an item of a collection type being archived: the archive waits and finds it', async () => {
      const recordId = await seedRecord(db);
      const ct = (await db.run((tx) => createCollectionType(tx, { code: unique('CT'), nameId: 'Hadiah', nameEn: 'Gift', loanable: true, selfService: true, sortOrder: 50 }))).id;
      const outcome = await archiveWhileOpen(
        (tx) => createItem(tx, db.branchId, { recordId, barcode: unique('T12A'), collectionTypeId: ct, status: 'available', partsTotal: 1 }),
        (tx) => archiveCollectionType(tx, ct, 0),
      );
      expect(outcome).toEqual(IN_USE);
      expect(await isArchived('collection_types', ct)).toBe(false);
    });

    it.skipIf(!SERVER)('T12: an item of a supplier being archived: the archive waits and finds it', async () => {
      const recordId = await seedRecord(db);
      const supplier = await seedSupplier(db, unique('SUP'));
      const outcome = await archiveWhileOpen(
        (tx) => createItem(tx, db.branchId, { recordId, barcode: unique('T12B'), collectionTypeId: umum, status: 'available', partsTotal: 1, supplierId: supplier }),
        (tx) => archiveSupplier(tx, supplier, 0),
      );
      expect(outcome).toEqual(IN_USE);
    });

    it.skipIf(!SERVER)('T12: a record of a material type being archived: the archive waits and finds it', async () => {
      const type = (
        await db.run((tx) =>
          createMaterialType(tx, {
            code: unique('JB-'),
            nameId: 'Partitur',
            nameEn: 'Score',
            marcType: 'c',
            marcLevel: 'm',
            contentType: 'ntm',
            mediaType: 'n',
            carrierType: 'nc',
            schemaType: 'MusicComposition',
            dcmiType: 'Text',
            template: { fields: {}, defaults: {}, customFields: [] },
            sortOrder: 90,
          }),
        )
      ).id;
      const outcome = await archiveWhileOpen(
        (tx) => createRecord(tx, { materialTypeId: type, title: 'Partitur Baru' }),
        (tx) => archiveMaterialType(tx, type, 0),
      );
      expect(outcome).toEqual(IN_USE);
      expect(await isArchived('material_types', type)).toBe(false);
    });

    it.skipIf(!SERVER)('T12: a record moved to a language being archived: the archive waits and finds it', async () => {
      const language = (await db.run((tx) => createLanguage(tx, { code: unique('L'), nameId: 'Uji', nameEn: 'Test' }))).id;
      const id = await record({ title: 'Pindah Bahasa' });
      const outcome = await archiveWhileOpen(
        (tx) => updateRecord(tx, id, { version: 0, languageId: language }),
        (tx) => archiveLanguage(tx, language, 0),
      );
      expect(outcome).toEqual(IN_USE);
    });

    it.skipIf(!SERVER)('C03: an item brought back while its record is being archived waits for the archive and is refused', async () => {
      const recordId = await seedRecord(db);
      const itemId = await seedItem(db, recordId, { barcode: unique('C03A'), status: 'withdrawn', archived: true });
      // The other way round from archiveWhileOpen: the archive holds its transaction open, the item comes back meanwhile.
      let outcome: Promise<unknown> = Promise.resolve('not started');
      await withTx(
        db.h,
        async (trx) => {
          await archiveRecord(txCtx(trx, NOW, ACTOR), recordId, 0);
          outcome = fieldErrors(meanwhile((tx) => updateItem(tx, db.branchId, itemId, { version: 0, status: 'processing' })));
          await new Promise((resolve) => setTimeout(resolve, HOLD_MS));
        },
        { retry: false },
      );
      expect(await outcome).toEqual([{ path: 'status', code: 'record_archived' }]);
    });

    it.skipIf(!SERVER)('C03: a record archived after the batch read: an item coming back is refused on the latest commit', async () => {
      const recordId = await seedRecord(db);
      const itemId = await seedItem(db, recordId, { barcode: unique('C03B'), status: 'withdrawn', archived: true });
      const errors = await fieldErrors(
        afterSnapshot(
          () => meanwhile((tx) => archiveRecord(tx, recordId, 0)),
          (tx) => updateItem(tx, db.branchId, itemId, { version: 0, status: 'processing' }),
        ),
      );
      expect(errors).toEqual([{ path: 'status', code: 'record_archived' }]);
    });

    it.skipIf(!SERVER)('T12: a language archived after the batch read is refused for a new record on the latest commit', async () => {
      const language = (await db.run((tx) => createLanguage(tx, { code: unique('L'), nameId: 'Uji', nameEn: 'Test' }))).id;
      const errors = await fieldErrors(
        afterSnapshot(
          () => meanwhile((tx) => archiveLanguage(tx, language, 0)),
          (tx) => createRecord(tx, { materialTypeId: buku, title: 'Bahasa Terarsip', languageId: language }),
        ),
      );
      expect(errors).toEqual([{ path: 'languageId', code: 'archived' }]);
    });
  });

  describe('L02: renaming a records custom field rewrites the material type templates as they are on the latest commit', () => {
    it.skipIf(!SERVER)('a template saved while the rename waits for it keeps that save, and names the new code', async () => {
      const code = `rf_${newId().slice(-8).toLowerCase()}`;
      const renamed = `${code}_baru`;
      const field = await db.run((tx) =>
        createCustomField(tx, { entity: 'records', type: 'text', code, labelId: 'NIM', labelEn: 'Student number', required: false, sortOrder: 10, isPublic: false, isSearchable: false }),
      );
      const body: MaterialTypeBody = {
        code: `JB-${newId().slice(-8)}`,
        nameId: 'Skripsi',
        nameEn: 'Thesis',
        marcType: 'a',
        marcLevel: 'm',
        contentType: 'txt',
        mediaType: 'n',
        carrierType: 'nc',
        schemaType: 'Thesis',
        dcmiType: 'Text',
        template: { fields: {}, defaults: {}, customFields: [code] },
        sortOrder: 90,
      };
      const type = await db.run((tx) => createMaterialType(tx, body));
      // The second admin's save of the template holds its row; the rename starts meanwhile (its snapshot is older than
      // that save) and waits for the row; the save then commits.
      let rename: Promise<unknown> = Promise.resolve('not started');
      await withTx(
        h2,
        async (trx) => {
          await updateMaterialType(txCtx(trx, NOW, ACTOR), type.id, { version: 0, template: { fields: { subtitle: 'required' }, defaults: {}, customFields: [code] } });
          rename = failure(db.run((tx) => updateCustomField(tx, field.id, { version: 0, code: renamed })));
          await new Promise((resolve) => setTimeout(resolve, HOLD_MS));
        },
        { retry: false },
      );
      expect(await rename).toBe('resolved');
      const row = await db.h.db.selectFrom('material_types').select(['template', 'version']).where('id', '=', type.id).executeTakeFirstOrThrow();
      expect(JSON.parse(row.template ?? 'null')).toMatchObject({ fields: { subtitle: 'required' }, customFields: [renamed] });
      expect(Number(row.version)).toBe(2);
    });
  });
});
