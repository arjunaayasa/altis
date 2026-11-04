import { newId } from '@altis/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { engineLabel, testDbContext } from '../../../../tools/test/test-db.js';
import { createRecord, listRecords, loadRecordData, recordDetail, updateRecord } from '../../src/catalog/records/index.js';
import {
  NOW,
  failure,
  openRecordsDb,
  seedCustomField,
  seedFile,
  seedItem,
  seedLocation,
  type RecordsDb,
} from './catalog-records-support.js';

// Phase 2 Task 16: the denormalised record (loadRecordData, B3), the detail and the admin list, on the engine picked by
// ALTIS_TEST_DB.

const ctx = testDbContext();

describe.skipIf(!ctx.available)(`records: data loader, detail and list [${engineLabel()}]`, () => {
  let db: RecordsDb;
  let buku: string;
  let recordId: string;
  let relatedId: string;
  let shelfId: string;
  const items: Record<string, string> = {};

  beforeAll(async () => {
    db = await openRecordsDb('records-data');
    buku = await db.materialTypeId('BUKU');
    await seedCustomField(db, { code: 'catatan_publik', isPublic: true, labelEn: 'Public note' });
    await seedCustomField(db, { code: 'catatan_staf' });
    relatedId = (await db.run((tx) => createRecord(tx, { materialTypeId: buku, title: 'Anak Semua Bangsa' }))).id;
    const created = await db.run((tx) =>
      createRecord(tx, {
        materialTypeId: buku,
        title: 'Bumi Manusia',
        subtitle: 'Roman',
        publicationYear: '1980',
        languageId: undefined,
        callNumber: '899.221 TOE b',
        identifiers: [{ type: 'isbn', value: '979-8659-12-0' }],
        agents: [{ ref: { type: 'person', name: 'Toer, Pramoedya Ananta', dates: '1925-2006' }, role: 'aut', isMain: true }],
        subjects: [{ ref: { type: 'topic', term: 'Sejarah Indonesia', classification: '959.8' }, isPrimary: true }],
        publisher: { name: 'Hasta Mitra', place: 'Jakarta' },
        relations: [{ relatedId, type: 'other_edition' }],
        custom: { catatan_publik: 'Tetralogi Buru', catatan_staf: 'Rak khusus' },
        links: [{ url: 'https://contoh.example/bumi', title: 'Ulasan' }],
        marcExtra: [{ tag: '590', ind1: ' ', ind2: ' ', data: '[["a","Lokal"]]' }],
      }),
    );
    recordId = created.id;
    const room = await seedLocation(db, { code: 'LT2', kind: 'room' });
    shelfId = await seedLocation(db, { code: 'RAK-800', kind: 'shelf', parentId: room });
    items['available'] = await seedItem(db, recordId, { barcode: 'B0000001', locationId: shelfId, price: 12_500_000 });
    items['withdrawn'] = await seedItem(db, recordId, { barcode: 'B0000002', status: 'withdrawn', archived: true, price: 9_900_000 });
    items['lost'] = await seedItem(db, recordId, { barcode: 'B0000003', status: 'lost' });
    items['ref'] = await seedItem(db, recordId, { barcode: 'B0000004', collectionTypeCode: 'REF' });
    // A staff attachment, an archived one, and a public file attachment.
    const pdf = await seedFile(db, { context: 'catalog.attachment', mime: 'application/pdf' });
    for (const a of [
      { id: newId(), kind: 'url', file_id: null, url: 'https://staf.example/', title: 'Catatan staf', access: 'staff', archived_at: null },
      { id: newId(), kind: 'url', file_id: null, url: 'https://lama.example/', title: 'Lama', access: 'public', archived_at: NOW },
      { id: newId(), kind: 'file', file_id: pdf, url: null, title: 'Teks lengkap', access: 'public', archived_at: null },
    ]) {
      await db.h.db
        .insertInto('attachments')
        .values({ ...a, record_id: recordId, description: null, legacy_access_limit: null, sort_order: 5, created_at: NOW, created_by: null, updated_at: NOW, updated_by: null })
        .execute();
    }
  });

  afterAll(async () => {
    await db?.close();
  });

  it('publicOnly: no staff or archived attachments, no withdrawn/lost/archived items, no prices; items carry their locationCode (B3)', async () => {
    const data = (await loadRecordData(db.h.db, [recordId], { publicOnly: true, includeItems: true })).get(recordId);
    expect(data).toBeDefined();
    expect(data?.attachments.map((a) => [a.kind, a.title, a.access, a.mime])).toEqual([
      ['url', 'Ulasan', 'public', null],
      ['file', 'Teks lengkap', 'public', 'application/pdf'],
    ]);
    expect(data?.links).toEqual([{ url: 'https://contoh.example/bumi', title: 'Ulasan' }]);
    expect(data?.items.map((i) => i.barcode).sort()).toEqual(['B0000001', 'B0000004']);
    const shelved = data?.items.find((i) => i.barcode === 'B0000001');
    expect(shelved).toMatchObject({ locationId: shelfId, locationCode: 'RAK-800', branchCode: 'Pusat', status: 'available', collectionTypeCode: 'UMUM', loanable: true, selfService: true });
    expect(data?.items.find((i) => i.barcode === 'B0000004')).toMatchObject({ locationCode: null, collectionTypeCode: 'REF', loanable: true, selfService: false });
    const text = JSON.stringify(data);
    for (const secret of ['12500000', '125000', '9900000', 'PO-7731', 'INV-5521', 'price', 'supplier', 'Rak khusus']) expect(text).not.toContain(secret);
    expect(data?.custom).toBeUndefined();
    expect(data?.customPublic).toEqual([{ code: 'catatan_publik', labelId: 'Label catatan_publik', labelEn: 'Public note', value: 'Tetralogi Buru' }]);
  });

  it('a staff load keeps every live attachment and item, and every custom value', async () => {
    const data = (await loadRecordData(db.h.db, [recordId, relatedId, newId()], { publicOnly: false, includeItems: true })).get(recordId);
    expect(data?.attachments.map((a) => a.access).sort()).toEqual(['public', 'public', 'staff']);
    expect(data?.items).toHaveLength(4);
    expect(data?.custom).toEqual({ catatan_publik: 'Tetralogi Buru', catatan_staf: 'Rak khusus' });
    expect(JSON.stringify(data)).not.toContain('12500000');
  });

  it('carries the record, its masters, authorities with ids, relations both ways and marcExtra', async () => {
    const map = await loadRecordData(db.h.db, [recordId, relatedId, newId()], { publicOnly: false, includeItems: false });
    expect([...map.keys()].sort()).toEqual([recordId, relatedId].sort());
    const data = map.get(recordId)!;
    expect(data).toMatchObject({
      id: recordId,
      title: 'Bumi Manusia',
      subtitle: 'Roman',
      publicationYear: '1980',
      callNumber: '899.221 TOE b',
      materialTypeCode: 'BUKU',
      materialType: { id: buku, code: 'BUKU', marcType: 'a', marcLevel: 'm', schemaType: 'Book', dcmiType: 'Text' },
      language: null,
      publisher: { id: expect.any(String), name: 'Hasta Mitra', place: 'Jakarta' },
      identifiers: [{ type: 'isbn', value: '979-8659-12-0' }],
      agents: [{ id: expect.any(String), type: 'person', name: 'Toer, Pramoedya Ananta', dates: '1925-2006', role: 'aut', isMain: true }],
      subjects: [{ id: expect.any(String), type: 'topic', term: 'Sejarah Indonesia', classification: '959.8', isPrimary: true }],
      marcExtra: [{ tag: '590', ind1: ' ', ind2: ' ', data: '[["a","Lokal"]]' }],
      opacVisible: true,
      archived: false,
      mergedInto: null,
      items: [],
    });
    expect(data.relations).toEqual([{ type: 'other_edition', direction: 'out', recordId: relatedId, title: 'Anak Semua Bangsa' }]);
    expect(map.get(relatedId)?.relations).toEqual([{ type: 'other_edition', direction: 'in', recordId, title: 'Bumi Manusia' }]);
  });

  it('publicOnly leaves out relations to hidden or archived records', async () => {
    const hidden = (await db.run((tx) => createRecord(tx, { materialTypeId: buku, title: 'Tersembunyi', opacVisible: false, relations: [{ relatedId, type: 'related' }] }))).id;
    const pub = (await loadRecordData(db.h.db, [relatedId], { publicOnly: true, includeItems: false })).get(relatedId);
    expect(pub?.relations.map((r) => r.recordId)).toEqual([recordId]);
    const staff = (await loadRecordData(db.h.db, [relatedId], { publicOnly: false, includeItems: false })).get(relatedId);
    expect(staff?.relations.map((r) => r.recordId).sort()).toEqual([recordId, hidden].sort());
  });

  it('recordDetail: the staff view with version, ids, custom values, identifier warnings and item counts', async () => {
    const bad = await db.run((tx) => createRecord(tx, { materialTypeId: buku, title: 'Salah Cek', identifiers: [{ type: 'issn', value: '1234-5678' }, { type: 'isbn', value: '978-602-03-0112-0' }] }));
    const detail = await recordDetail(db.h.db, bad.id);
    expect(detail).toMatchObject({ id: bad.id, version: 0, materialTypeId: buku, languageId: null, source: 'manual', custom: {}, itemCounts: { total: 0, available: 0 } });
    expect(detail.warnings).toEqual([
      { path: 'identifiers.0.value', code: 'issn_invalid' },
      { path: 'identifiers.1.value', code: 'isbn_invalid' },
    ]);
    const full = await recordDetail(db.h.db, recordId);
    expect(full.itemCounts).toEqual({ total: 3, available: 2 });
    expect(full.custom).toEqual({ catatan_publik: 'Tetralogi Buru', catatan_staf: 'Rak khusus' });
    expect(await failure(recordDetail(db.h.db, newId()))).toEqual({ code: 'NOT_FOUND' });
  });

  it('listRecords: a keyset over (changed_at, id) newest change first, or over (title_key, id); filters', async () => {
    const base = NOW + 1000;
    const ids: string[] = [];
    for (const [i, title] of ['Zaman Peralihan', 'Arok Dedes', 'Mangir'].entries()) {
      ids.push((await db.run((tx) => createRecord(tx, { materialTypeId: buku, title, series: 'Daftar Uji' }), base + i)).id);
    }
    const first = await listRecords(db.h.db, { limit: 2 });
    expect(first.items.map((r) => r.title)).toEqual(['Mangir', 'Arok Dedes']);
    expect(first).toMatchObject({ total: null, page: null, nextCursor: expect.any(String) });
    const second = await listRecords(db.h.db, { limit: 2, cursor: first.nextCursor! });
    expect(second.items[0]?.title).toBe('Zaman Peralihan');

    const byTitle = await listRecords(db.h.db, { sort: 'title', limit: 2 });
    expect(byTitle.items.map((r) => r.title)).toEqual(['Anak Semua Bangsa', 'Arok Dedes']);
    const nextByTitle = await listRecords(db.h.db, { sort: 'title', limit: 2, cursor: byTitle.nextCursor! });
    expect(nextByTitle.items[0]?.title).toBe('Bumi Manusia');
    expect(await failure(listRecords(db.h.db, { sort: 'changed', limit: 2, cursor: byTitle.nextCursor! }))).toMatchObject({ code: 'VALIDATION_FAILED' });

    const row = (await listRecords(db.h.db, { hasItems: true, limit: 50 })).items;
    expect(row).toEqual([
      {
        id: recordId,
        title: 'Bumi Manusia',
        subtitle: 'Roman',
        mainAgent: 'Toer, Pramoedya Ananta',
        materialTypeId: buku,
        year: '1980',
        callNumber: '899.221 TOE b',
        itemCount: 3,
        coverFileId: null,
        opacVisible: true,
        archived: false,
        changedAt: expect.any(Number),
      },
    ]);
    expect((await listRecords(db.h.db, { hidden: 'only', limit: 50 })).items.map((r) => r.title)).toEqual(['Tersembunyi']);
    expect((await listRecords(db.h.db, { changedFrom: base, changedTo: base + 1, limit: 50 })).items.map((r) => r.title)).toEqual(['Arok Dedes', 'Zaman Peralihan']);
    await db.run((tx) => updateRecord(tx, ids[0]!, { version: 0, title: 'Zaman Peralihan (arsip)' }));
    await db.h.db.updateTable('records').set({ archived_at: NOW }).where('id', '=', ids[0]!).execute();
    expect((await listRecords(db.h.db, { archived: true, limit: 50 })).items.map((r) => r.id)).toEqual([ids[0]]);
    expect((await listRecords(db.h.db, { limit: 50 })).items.map((r) => r.id)).not.toContain(ids[0]);
  });
});
