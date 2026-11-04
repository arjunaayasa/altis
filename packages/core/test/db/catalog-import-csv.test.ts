import fsp from 'node:fs/promises';
import path from 'node:path';
import { newId, normalizeKey } from '@altis/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { engineLabel, testDbContext } from '../../../../tools/test/test-db.js';
import { createItem } from '../../src/catalog/items/service.js';
import { createRecord } from '../../src/catalog/records/service.js';
import { SLIMS_ITEM_COLUMNS } from '../../src/catalog/csv/slims.js';
import { importFile, openExchangeDb, exportFile, reportRows, seedImporter, type ExchangeDb } from './catalog-exchange-support.js';
import { NOW, seedLocation } from './catalog-records-support.js';

// The CSV side of the import job (Phase 2 Task 31; spec §5.2, §5.3; K6, S11, S19; Review Focus 1) on the engine picked
// by ALTIS_TEST_DB, every import and export run through the queue's claim path:
// - Review Focus 1: a Windows-1252 `;` file from Excel (CRLF, a quoted line break): its dry run reports
//   `encoding_cp1252`, shows the right first title, writes no record and keeps its input (S3);
// - K6: `csv-records` + `csv-items` exported, then imported into an emptied catalogue: exported again, the same rows
//   (every mapped field), the record ids aside;
// - S19: custom values from text (a number, a multiselect), and a value that does not convert as a record error;
// - S11: a `csv-items` row in a branch where the run's creator lacks `catalog.items.manage` → `branch_denied`;
// - the SLiMS 18-column layout with its `<a><b>` multi-values.

const ctx = testDbContext();

describe.skipIf(!ctx.available)(`catalog import: CSV through the job [${engineLabel()}]`, () => {
  let db: ExchangeDb;
  let otherBranch: string;
  let supplierId: string;

  beforeAll(async () => {
    db = await openExchangeDb('import-csv');
    otherBranch = newId(NOW);
    await db.h.db
      .insertInto('branches')
      .values({ id: otherBranch, code_key: 'CABANG', code_display: 'CABANG', name: 'Cabang', address: null, timezone: 'Asia/Jakarta', created_at: NOW, created_by: null, updated_at: NOW, updated_by: null })
      .execute();
    for (const code of ['RAK-A', 'RAK-B']) await seedLocation(db, { code, kind: 'shelf' });
    supplierId = newId(NOW);
    await db.h.db
      .insertInto('suppliers')
      .values({ id: supplierId, code_display: 'SENTOSA', code_key: 'SENTOSA', name: 'Toko Buku Sentosa', contact_name: null, phone: null, email: null, address: null, note: null, archived_at: null, created_at: NOW, created_by: null, updated_at: NOW, updated_by: null })
      .execute();
    const def = (entity: 'records' | 'items', code: string, type: string, options: { value: string }[] | null = null) =>
      db.h.db
        .insertInto('custom_field_defs')
        .values({
          id: newId(NOW),
          entity,
          code_key: normalizeKey(code),
          code_display: code,
          label: `Label ${code}`,
          label_en: null,
          type,
          options: options === null ? null : JSON.stringify(options),
          is_required: 0,
          is_public: 0,
          archived_at: null,
          created_at: NOW,
          created_by: null,
          updated_at: NOW,
          updated_by: null,
        })
        .execute();
    await def('records', 'pages', 'number');
    await def('records', 'genre', 'multiselect', [{ value: 'a' }, { value: 'b' }, { value: 'c' }]);
    await def('records', 'signed', 'boolean');
    await def('items', 'kondisi', 'text');
  }, 60_000);

  afterAll(async () => {
    await db?.close();
  });

  beforeEach(async () => {
    for (const table of ['item_events', 'items', 'custom_values', 'migration_map', 'jobs', 'locks', 'catalog_runs'] as const) await db.h.db.deleteFrom(table).execute();
    await db.h.db.deleteFrom('records').execute();
  });

  const count = async (table: 'records' | 'items'): Promise<number> =>
    Number((await db.h.db.selectFrom(table).select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow()).n);

  it('Review Focus 1: a cp1252 `;` CSV dry run reports encoding_cp1252, shows the right first title, writes no record', async () => {
    const text = 'title;year;authors;summary\r\nCaf\u00e9 de Flore;1998;Mu\u00f1oz, Jos\u00e9;"baris satu\r\nbaris dua"\r\nSe\u00f1orita;2001;;\r\n';
    const bytes = Buffer.from(text, 'latin1'); // \u00e9 and \u00f1 as their Windows-1252 bytes
    expect(bytes.includes(0xe9)).toBe(true);
    const r = await importFile(db, bytes, { dryRun: true });
    expect(r.run.status).toBe('succeeded');
    expect(r.run.format).toBe('csv-records');
    expect(r.summary.warnings).toContain('encoding_cp1252');
    expect(r.summary).toMatchObject({ read: 2, created: 2, errors: 0 });
    const sample = r.summary.sample as { title: string; publicationYear?: string; summary?: string; agents: { name: string }[] }[];
    expect(sample.map((d) => d.title)).toEqual(['Caf\u00e9 de Flore', 'Se\u00f1orita']);
    expect(sample[0]).toMatchObject({ publicationYear: '1998', summary: 'baris satu\r\nbaris dua', agents: [{ name: 'Mu\u00f1oz, Jos\u00e9' }] });
    expect(await count('records')).toBe(0);
    expect(await db.h.db.selectFrom('migration_map').select('legacy_key').execute()).toEqual([]);
    // S3: the dry run keeps its input for the real run.
    expect((await fsp.stat(path.join(db.dataDir, 'tmp', r.runId, 'import.bin'))).size).toBe(bytes.byteLength);
    expect((await reportRows(db, r.run)).filter((row) => row[2] === 'warning')).toEqual([['0', '1', 'warning', 'encoding_cp1252', '', '', '']]);
  });

  it('K6: csv-records + csv-items exported, imported into an emptied catalogue, exported again → the same rows', async () => {
    const buku = await db.materialTypeId('BUKU');
    const ind = await db.languageId('ind');
    const umum = await db.collectionTypeId('UMUM');
    const ref = await db.collectionTypeId('REF');
    const rakA = (await db.h.db.selectFrom('locations').select('id').where('code_key', '=', 'RAK-A').executeTakeFirstOrThrow()).id;
    const records = [
      {
        materialTypeId: buku,
        title: 'Bumi Manusia',
        subtitle: 'sebuah roman',
        responsibility: 'Pramoedya Ananta Toer',
        edition: 'Cet. 3',
        publisher: { name: 'Hasta Mitra', place: 'Jakarta' },
        publicationPlace: 'Jakarta',
        publicationYear: '1980',
        physicalDesc: '338 hlm.',
        series: 'Tetralogi Buru',
        classification: '899.2213',
        callNumber: '899.2213 TOE b',
        languageId: ind,
        summary: 'Kisah Minke.\r\nBaris kedua; dengan titik koma | dan pipa.',
        notes: '=1+1 bukan rumus',
        opacVisible: false,
        identifiers: [{ type: 'isbn' as const, value: '978-979-97312-3-4' }],
        agents: [
          { ref: { type: 'person' as const, name: 'Toer, Pramoedya Ananta', dates: '1925-2006' }, role: 'aut' as const, isMain: true },
          { ref: { type: 'organization' as const, name: 'Badan Bahasa' }, role: 'edt' as const, isMain: false },
        ],
        subjects: [
          { ref: { type: 'topic' as const, term: 'Fiksi Indonesia' }, isPrimary: true },
          { ref: { type: 'geographic' as const, term: 'Jawa' }, isPrimary: false },
        ],
        custom: { pages: 338, genre: ['a', 'c'], signed: true },
      },
      {
        materialTypeId: buku,
        title: 'Statistika Dasar',
        publicationYear: '2015',
        identifiers: [
          { type: 'isbn' as const, value: '9786020332956' },
          { type: 'issn' as const, value: '0378-5955' },
        ],
        agents: [{ ref: { type: 'person' as const, name: 'Sudjana' }, role: 'aut' as const, isMain: true }],
      },
    ];
    const ids: string[] = [];
    for (const body of records) ids.push((await db.run((tx) => createRecord(tx, body))).id);
    await db.run((tx) =>
      createItem(tx, db.branchId, {
        recordId: ids[0]!,
        barcode: 'K6-0001',
        collectionTypeId: umum,
        status: 'available',
        partsTotal: 2,
        locationId: rakA,
        callNumber: '899.2213 TOE b c.1',
        inventoryNo: 'INV/2024/001',
        acqSource: 'purchase',
        orderNo: 'PO-7',
        orderDate: '2024-01-10',
        receivedDate: '2024-01-15',
        supplierId,
        invoiceNo: 'F-99',
        invoiceDate: '2024-01-16',
        price: '125000.50',
        currency: 'IDR',
        note: 'Sampul agak sobek',
        custom: { kondisi: 'baik' },
      }),
    );
    await db.run((tx) => createItem(tx, db.branchId, { recordId: ids[0]!, barcode: 'K6-0002', collectionTypeId: ref, status: 'repair', partsTotal: 1 }));
    await db.run((tx) => createItem(tx, db.branchId, { recordId: ids[1]!, barcode: 'K6-0101', collectionTypeId: umum, status: 'available', partsTotal: 1, acqSource: 'gift' }));

    const recordsCsv = await exportFile(db, { format: 'csv-records', filter: {} });
    const itemsCsv = await exportFile(db, { format: 'csv-items', filter: {} });
    expect([recordsCsv.run.status, itemsCsv.run.status]).toEqual(['succeeded', 'succeeded']);
    expect(recordsCsv.bytes!.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf])); // the BOM, always on export
    expect(recordsCsv.bytes!.toString('utf8')).toContain('"\'=1+1 bukan rumus"'); // the formula guard

    for (const table of ['item_events', 'items', 'custom_values'] as const) await db.h.db.deleteFrom(table).execute();
    await db.h.db.deleteFrom('records').execute();
    const back = await importFile(db, recordsCsv.bytes!);
    expect(back.summary).toMatchObject({ read: 2, created: 2, errors: 0 });
    const backItems = await importFile(db, itemsCsv.bytes!, { onMatch: 'update' });
    expect(backItems.run.format).toBe('csv-items');
    expect(backItems.summary).toMatchObject({ read: 3, created: 3, itemsCreated: 3, errors: 0 });

    const rows = (csv: Buffer) =>
      csv
        .toString('utf8')
        .split('\r\n')
        .slice(1)
        .filter((l) => l !== '')
        // The record id is the first cell of a record row and the second of an item row: the new ids differ.
        .map((l) => l.replace(/"[0-9A-HJKMNP-TV-Z]{26}"/g, '"<id>"'))
        .sort();
    const recordsAgain = await exportFile(db, { format: 'csv-records', filter: {} });
    const itemsAgain = await exportFile(db, { format: 'csv-items', filter: {} });
    expect(rows(recordsAgain.bytes!)).toEqual(rows(recordsCsv.bytes!));
    expect(rows(itemsAgain.bytes!)).toEqual(rows(itemsCsv.bytes!));
    expect(rows(itemsCsv.bytes!).join('\n')).toContain('"125000.50"');
  });

  it('S19: custom.pages=12 and a multiselect a|b are stored typed; custom.pages=abc is a record error', async () => {
    const csv = 'title,custom.pages,custom.genre\r\nBuku Halaman,12,a|b\r\nBuku Salah,abc,a\r\n';
    const r = await importFile(db, csv);
    expect(r.summary).toMatchObject({ read: 2, created: 1, errors: 1 });
    const stored = await db.h.db
      .selectFrom('custom_values as v')
      .innerJoin('custom_field_defs as d', 'd.id', 'v.field_id')
      .select(['d.code_display as code', 'v.value'])
      .orderBy('d.code_key')
      .execute();
    expect(stored.map((s) => [s.code, JSON.parse(s.value) as unknown])).toEqual([
      ['genre', ['a', 'b']],
      ['pages', 12],
    ]);
    expect((await reportRows(db, r.run)).filter((row) => row[2] === 'error')).toEqual([['2', '3', 'error', 'invalid', 'custom.pages', '', 'Buku Salah']]);
  });

  it('S11: a csv-items file naming a branch where the run creator lacks catalog.items.manage → those rows are branch_denied', async () => {
    const buku = await db.materialTypeId('BUKU');
    const { id: recordId } = await db.run((tx) => createRecord(tx, { materialTypeId: buku, title: 'Induk Eksemplar' }));
    const onlyA = await seedImporter(db, { global: ['catalog.import.run'], byBranch: { [db.branchId]: ['catalog.items.manage'] } });
    const csv = `barcode;record_id;branch;collection_type\r\nS11-A1;${recordId};PUSAT;UMUM\r\nS11-B1;${recordId};CABANG;UMUM\r\nS11-A2;${recordId};PUSAT;REF\r\n`;
    const r = await importFile(db, csv, { onMatch: 'update' }, { actor: onlyA });
    expect(r.summary).toMatchObject({ read: 3, created: 2, errors: 1 });
    expect((await db.h.db.selectFrom('items').select('barcode_key').orderBy('barcode_key').execute()).map((i) => i.barcode_key)).toEqual(['S11-A1', 'S11-A2']);
    expect((await reportRows(db, r.run)).filter((row) => row[2] === 'error')).toEqual([['2', '3', 'error', 'branch_denied', 'branch', '', 'S11-B1']]);
  });

  it('the community edition has no branch limit: items are written in, and updated in, every branch the creator manages', async () => {
    const buku = await db.materialTypeId('BUKU');
    const umum = await db.collectionTypeId('UMUM');
    const { id: recordId } = await db.run((tx) => createRecord(tx, { materialTypeId: buku, title: 'Induk Semua Cabang' }));
    await db.run((tx) => createItem(tx, otherBranch, { recordId, barcode: 'ALL-B0', collectionTypeId: umum, status: 'available', partsTotal: 1 }));
    const barcodes = async () => (await db.h.db.selectFrom('items').select('barcode_key').orderBy('barcode_key').execute()).map((i) => i.barcode_key);
    // csv-items, its format detected, no branchId: each row's own branch, and an update in the stored item's branch.
    const csv = `barcode;record_id;branch;inventory_no\r\nALL-A1;${recordId};PUSAT;\r\nALL-B1;${recordId};CABANG;\r\nALL-B0;;;INV-BARU\r\n`;
    const rows = await importFile(db, csv, { onMatch: 'update' });
    expect(rows.run.format).toBe('csv-items');
    expect(rows.summary).toMatchObject({ read: 3, created: 2, updated: 1, errors: 0 });
    expect((await reportRows(db, rows.run)).filter((row) => row[2] === 'error')).toEqual([]);
    expect((await db.h.db.selectFrom('items').select('inventory_no').where('barcode_key', '=', 'ALL-B0').executeTakeFirstOrThrow()).inventory_no).toBe('INV-BARU');
    // The options naming the other branch: csv-items and csv-slims-items rows are written there too.
    const named = await importFile(db, `barcode;record_id\r\nALL-B2;${recordId}\r\n`, { branchId: otherBranch });
    expect(named.summary).toMatchObject({ read: 1, created: 1, errors: 0 });
    const slimsRow = SLIMS_ITEM_COLUMNS.map((c) => (c === 'item_code' ? 'ALL-S1' : c === 'title' ? 'Induk Semua Cabang' : ''));
    const slims = await importFile(db, `${SLIMS_ITEM_COLUMNS.join(',')}\r\n${slimsRow.join(',')}\r\n`, { branchId: otherBranch });
    expect([slims.run.format, slims.summary.created, slims.summary.errors]).toEqual(['csv-slims-items', 1, 0]);
    expect(await barcodes()).toEqual(['ALL-A1', 'ALL-B0', 'ALL-B1', 'ALL-B2', 'ALL-S1']);
  });

  it('a csv-records update keeps the identifiers a CSV has no column for (doi, control, other) where they stand', async () => {
    const buku = await db.materialTypeId('BUKU');
    const identifiers = [
      { type: 'control', value: 'ID-JKPN:B0001' },
      { type: 'isbn', value: '978-602-03-3295-6' },
      { type: 'doi', value: '10.1000/altis.1' },
      { type: 'other', value: 'LOKAL-7' },
    ] as const;
    const { id } = await db.run((tx) => createRecord(tx, { materialTypeId: buku, title: 'Judul Lama', identifiers: [...identifiers] }));
    const stored = () =>
      db.h.db.selectFrom('record_identifiers').select(['type', 'value_display']).where('record_id', '=', id).orderBy('sort_order').execute();
    const before = await stored();
    // The same ISBN: the identifiers are not touched (same rows, same order); the title is updated.
    const same = await importFile(db, `record_id,title,isbn\r\n${id},Judul Baru,978-602-03-3295-6\r\n`, { matchOn: 'record_id', onMatch: 'update' });
    expect(same.summary).toMatchObject({ read: 1, updated: 1, errors: 0 });
    expect((await db.h.db.selectFrom('records').select('title').where('id', '=', id).executeTakeFirstOrThrow()).title).toBe('Judul Baru');
    expect(await stored()).toEqual(before);
    // Another ISBN and an ISSN: the ISBN's place takes the file's list, the others stay.
    const other = await importFile(db, `record_id,title,isbn,issn\r\n${id},Judul Baru,9786020000011,0317-8471\r\n`, { matchOn: 'record_id', onMatch: 'update' });
    expect(other.summary).toMatchObject({ read: 1, updated: 1, errors: 0 });
    expect((await stored()).map((r) => r.type)).toEqual(['control', 'isbn', 'doi', 'other', 'issn']);
    expect((await stored()).filter((r) => r.type !== 'isbn' && r.type !== 'issn')).toEqual(before.filter((r) => r.type !== 'isbn'));
  });

  it('csv-slims-items finds its record by the exact title on every engine (title_key narrows, the title decides)', async () => {
    const buku = await db.materialTypeId('BUKU');
    const lama = await db.run((tx) => createRecord(tx, { materialTypeId: buku, title: 'Kisah Lama' }));
    await db.run((tx) => createRecord(tx, { materialTypeId: buku, title: 'KISAH LAMA' })); // the same title_key
    const baru = await db.run((tx) => createRecord(tx, { materialTypeId: buku, title: 'Kisah Baru', subtitle: 'jilid dua' }));
    const row = (code: string, title: string) => SLIMS_ITEM_COLUMNS.map((c) => (c === 'item_code' ? code : c === 'title' ? title : '')).join(',');
    const csv = `${SLIMS_ITEM_COLUMNS.join(',')}\r\n${row('TK-1', 'Kisah Lama')}\r\n${row('TK-2', 'Kisah Baru')}\r\n${row('TK-3', 'kisah lama')}\r\n`;
    const r = await importFile(db, csv, { branchId: db.branchId });
    expect(r.summary).toMatchObject({ read: 3, created: 2, errors: 1 });
    expect(await db.h.db.selectFrom('items').select(['barcode_key', 'record_id']).orderBy('barcode_key').execute()).toEqual([
      { barcode_key: 'TK-1', record_id: lama.id },
      { barcode_key: 'TK-2', record_id: baru.id },
    ]);
    expect((await reportRows(db, r.run)).filter((x) => x[2] === 'error').map((x) => [x[0], x[3]])).toEqual([['3', 'record_not_found']]);
  });

  it('csv-items upserts by barcode: a stored barcode is updated (onMatch update), a new one created in its record', async () => {
    const buku = await db.materialTypeId('BUKU');
    const umum = await db.collectionTypeId('UMUM');
    const { id: recordId } = await db.run((tx) => createRecord(tx, { materialTypeId: buku, title: 'Upsert', identifiers: [{ type: 'isbn', value: '9786020332956' }] }));
    await db.run((tx) => createItem(tx, db.branchId, { recordId, barcode: 'UP-1', collectionTypeId: umum, status: 'available', partsTotal: 1 }));
    const csv = 'barcode,isbn,branch,inventory_no,status\r\nUP-1,,,INV-BARU,repair\r\nUP-2,978-602-03-3295-6,PUSAT,INV-2,available\r\n';
    const r = await importFile(db, csv, { onMatch: 'update' });
    expect(r.summary).toMatchObject({ read: 2, created: 1, updated: 1, errors: 0 });
    expect(await db.h.db.selectFrom('items').select(['barcode_key', 'record_id', 'inventory_no', 'status']).orderBy('barcode_key').execute()).toEqual([
      { barcode_key: 'UP-1', record_id: recordId, inventory_no: 'INV-BARU', status: 'repair' },
      { barcode_key: 'UP-2', record_id: recordId, inventory_no: 'INV-2', status: 'available' },
    ]);
  });

  it('csv-slims: an 18-column SLiMS row with <a><b> multi-values → two authors, two topics, its item code with createItems', async () => {
    const cells = [
      'Laskar pelangi : sebuah novel /',
      'Text',
      'Cet. 1',
      '9789793062792',
      'Bentang',
      '2005',
      'xii, 529 hlm.',
      '',
      '899.221 HIR l',
      'Indonesia',
      'Yogyakarta',
      '899.221',
      '',
      '',
      'Andrea Hirata',
      '<Hirata, Andrea><Penyunting, Ana>',
      '<Fiksi Indonesia><Persahabatan>',
      '<SL-0001>',
    ];
    const csv = `${cells.map((c) => `"${c}"`).join(',')}\r\n`;
    const r = await importFile(db, csv, { createItems: true, branchId: db.branchId });
    expect(r.run.format).toBe('csv-slims');
    expect(r.summary).toMatchObject({ read: 1, created: 1, itemsCreated: 1 });
    const rec = await db.h.db.selectFrom('records').select(['id', 'title', 'publication_year']).executeTakeFirstOrThrow();
    expect([rec.title, rec.publication_year]).toEqual(['Laskar pelangi : sebuah novel', '2005']); // its trailing ISBD ` /` dropped
    const agents = await db.h.db.selectFrom('record_agents as ra').innerJoin('agents as a', 'a.id', 'ra.agent_id').select(['a.name_display', 'ra.is_main']).where('ra.record_id', '=', rec.id).orderBy('ra.sort_order').execute();
    expect(agents).toEqual([
      { name_display: 'Hirata, Andrea', is_main: 1 },
      { name_display: 'Penyunting, Ana', is_main: 0 },
    ]);
    expect(await db.h.db.selectFrom('record_subjects').select('record_id').where('record_id', '=', rec.id).execute()).toHaveLength(2);
    expect((await db.h.db.selectFrom('items').select('barcode_key').execute()).map((i) => i.barcode_key)).toEqual(['SL-0001']);
  });

  it('a csv-records header with an unknown column is reported once; a header without title fails the run', async () => {
    const r = await importFile(db, 'title,warna\r\nSatu,merah\r\nDua,biru\r\n');
    expect(r.summary).toMatchObject({ read: 2, created: 2 });
    expect((await reportRows(db, r.run)).filter((row) => row[3] === 'unknown_column')).toEqual([['0', '1', 'warning', 'unknown_column', 'warna', '', '']]);
    const failed = await importFile(db, 'judul,tahun\r\nSatu,2001\r\n', { format: 'csv-records' });
    expect([failed.run.status, failed.summary.error, failed.summary.reason]).toEqual(['failed', 'CATALOG_IMPORT_FORMAT', 'header_required']);
  });
});
