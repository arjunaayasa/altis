import { newId, normalizeKey } from '@altis/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { engineLabel, testDbContext } from '../../../../tools/test/test-db.js';
import { createRecord } from '../../src/catalog/records/service.js';
import { MARCXML_COLLECTION_CLOSE, MARCXML_COLLECTION_OPEN, readIso2709, writeIso2709, writeMarcXmlRecord } from '../../src/marc/index.js';
import type { MarcDataField, MarcRecord } from '../../src/marc/index.js';
import { CORPUS, cf, df, marc8Iso2709, maskLeader } from '../support/marc-corpus.js';
import { exportFile, importFile, openExchangeDb, reportRows, type ExchangeDb } from './catalog-exchange-support.js';
import { NOW, seedLocation } from './catalog-records-support.js';

// The MARC side of the import job (Phase 2 Task 31; spec §5.1, §5.3; K5, B3, S4, S5, M7; Review Focus 5) on the engine
// picked by ALTIS_TEST_DB, every import and export run through the queue's claim path:
// - K5 through the jobs: the 50+ record corpus imported, exported (#1), #1 imported into an emptied catalogue (one test
//   database per worker: the catalogue rows are deleted, the masters, locations and authorities stay) and exported
//   again (#2): #1 and #2 are equal record by record once the generated parts are masked;
// - Review Focus 5: one broken record among 10 → 9 created and one report line naming it;
// - a DOCTYPE → the run fails with CATALOG_IMPORT_FORMAT;
// - `onMatch: update` by ISBN; 952 with `createItems` → items with the history event `imported`;
// - M7: `onDuplicate` against a stored record (the real titleCandidates of Task 15) and two equal drafts in one batch.

const ctx = testDbContext();

/** The locations the corpus's 852/952 name, created in the branch of each test database. */
const CORPUS_LOCATIONS = ['RAK-FIK', 'RAK-PUI', 'REF', 'RAK-598', 'DEPO', 'RAK-ATL', 'ANAK', 'GUDANG', 'RAK-633'];

/** The corpus as one ISO 2709 file (the MARC-8 records as MARC-8 bytes). */
function corpusFile(): Buffer {
  return Buffer.concat(CORPUS.map((e) => Buffer.from(e.marc8 === true ? marc8Iso2709(e.record) : writeIso2709(e.record))));
}

/** A small book record: 001, an optional ISBN, 100, 245, 264 with `year`, and `extra` fields. */
function book(o: { id: string; title: string; year?: string; isbn?: string; author?: string; extra?: MarcDataField[] }): MarcRecord {
  return {
    leader: '00000nam a2200000 i 4500',
    fields: [
      cf('001', o.id),
      ...(o.isbn === undefined ? [] : [df('020', '  ', `a${o.isbn}`)]),
      ...(o.author === undefined ? [] : [df('100', '1 ', `a${o.author}`)]),
      df('245', '10', `a${o.title}`),
      ...(o.year === undefined ? [] : [df('264', ' 1', 'aJakarta :', 'bPenerbit Uji,', `c${o.year}.`)]),
      ...(o.extra ?? []),
    ],
  };
}

const iso = (records: MarcRecord[]): Buffer => Buffer.concat(records.map((r) => Buffer.from(writeIso2709(r))));

/** The records of an ISO 2709 file (every result must read). */
function readAll(bytes: Uint8Array): MarcRecord[] {
  const reader = readIso2709();
  const results = [...reader.push(bytes), ...reader.end()];
  return results.map((r) => {
    if (!r.ok) throw new Error(`a record did not read: ${r.error}`);
    return r.record;
  });
}

/**
 * K5's comparable form of an exported record: 001, 003 and 005 left out, the leader's computed positions masked, and an
 * 852 as {barcode $p, locationCode $c, callNumber $h}.
 */
function comparable(rec: MarcRecord): string {
  const fields = rec.fields
    .filter((f) => f.tag !== '001' && f.tag !== '003' && f.tag !== '005')
    .map((f) => {
      if (f.tag !== '852' || !('subfields' in f)) return f;
      const sub = (c: string) => f.subfields.find(([code]) => code === c)?.[1] ?? null;
      return { tag: '852', barcode: sub('p'), locationCode: sub('c'), callNumber: sub('h') };
    });
  return JSON.stringify({ leader: maskLeader(rec.leader), fields });
}

describe.skipIf(!ctx.available)(`catalog import: MARC 21 through the job [${engineLabel()}]`, () => {
  let db: ExchangeDb;

  beforeAll(async () => {
    db = await openExchangeDb('import-marc');
    for (const code of CORPUS_LOCATIONS) await seedLocation(db, { code, kind: 'shelf' });
  }, 60_000);

  afterAll(async () => {
    await db?.close();
  });

  /** An empty catalogue: no record, item, run or mapping (the masters, locations and authorities stay). */
  async function clean(d: ExchangeDb): Promise<void> {
    for (const table of ['item_events', 'items', 'custom_values', 'migration_map', 'jobs', 'locks', 'catalog_runs'] as const) await d.h.db.deleteFrom(table).execute();
    await d.h.db.deleteFrom('records').execute();
  }

  beforeEach(async () => {
    await clean(db);
  });

  const count = async (d: ExchangeDb, table: 'records' | 'items'): Promise<number> =>
    Number((await d.h.db.selectFrom(table).select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow()).n);

  it(
    'K5: corpus → export #1 → an emptied catalogue → export #2: #1 and #2 are equal record by record; 856 http(s) and 541 survive (S4, S5)',
    async () => {
      expect(CORPUS.length).toBeGreaterThanOrEqual(50);
      const first = await importFile(db, corpusFile(), { createItems: true, branchId: db.branchId });
      expect(first.run.status).toBe('succeeded');
      expect(first.summary.read).toBe(CORPUS.length);
      const stored = await count(db, 'records');
      expect(stored).toBe(first.summary.created);
      expect(stored).toBeGreaterThanOrEqual(50);
      expect(first.summary.itemsCreated).toBeGreaterThan(5);
      // Every row the corpus imported carries its source and its legacy key.
      expect(await db.h.db.selectFrom('migration_map').select('legacy_key').where('source', '=', `import:${first.runId}`).execute()).toHaveLength(stored);

      const one = await exportFile(db, { format: 'marc21', filter: { includeItems: true } });
      expect(one.run.status).toBe('succeeded');
      expect(one.bytes!.byteLength).toBe(Number(one.run.output_size));
      const export1 = readAll(one.bytes!);
      expect(export1).toHaveLength(stored);

      await clean(db);
      const again = await importFile(db, one.bytes!, { createItems: true, branchId: db.branchId });
      expect(again.summary).toMatchObject({ read: stored, created: stored, errors: 0 });
      const two = await exportFile(db, { format: 'marc21', filter: { includeItems: true } });
      const export2 = readAll(two.bytes!);
      expect(export2.map(comparable).sort()).toEqual(export1.map(comparable).sort());

      // S4: the corpus's http(s) links are 856 fields of both exports; S5: the staff export keeps the 541.
      for (const records of [export1, export2]) {
        const urls = records.flatMap((r) => r.fields.filter((f): f is MarcDataField => f.tag === '856' && 'subfields' in f).flatMap((f) => f.subfields.filter(([c]) => c === 'u').map(([, v]) => v)));
        expect(urls).toEqual(expect.arrayContaining(['https://example.org/panduan.pdf', 'http://example.org/sampul.jpg', 'https://example.org/statistika']));
        expect(records.some((r) => r.fields.some((f) => f.tag === '541'))).toBe(true);
      }
      // An 852 with a barcode carries an item (S5: no price or supplier in what ALTIS generates); the corpus's holdings
      // statements without one stay MARC extra fields, exported as they came.
      const f852 = export1.flatMap((r) => r.fields.filter((f): f is MarcDataField => f.tag === '852' && 'subfields' in f && f.subfields.some(([c]) => c === 'p')));
      expect(f852.length).toBe(first.summary.itemsCreated);
      expect(f852.flatMap((f) => f.subfields.map(([c]) => c)).filter((c) => !['b', 'c', 'h', 'p'].includes(c))).toEqual([]);
    },
    180_000,
  );

  it('Review Focus 5: one record with a broken directory among 10 → 9 created and one report line naming record 4', async () => {
    const records = Array.from({ length: 10 }, (_, i) => book({ id: `RF5-${i + 1}`, title: `Buku Rusak Uji ${i + 1}` }));
    const bytes = records.map((r) => Buffer.from(writeIso2709(r)));
    bytes[3]![24 + 3] = 'X'.charCodeAt(0); // the 4th record's first directory entry has no digits any more
    const r = await importFile(db, Buffer.concat(bytes));
    expect(r.run.status).toBe('succeeded');
    expect(r.summary).toMatchObject({ read: 10, created: 9, errors: 1 });
    expect(await count(db, 'records')).toBe(9);
    expect(await reportRows(db, r.run)).toEqual([['4', '', 'error', 'directory', '', '', '']]);
  });

  it('a MARC record without a 245 title is one report row (title_missing) and the import goes on', async () => {
    const untitled: MarcRecord = { leader: '00000nam a2200000 i 4500', fields: [cf('001', 'NT-1'), df('500', '  ', 'aTanpa judul.')] };
    const r = await importFile(db, iso([book({ id: 'T-1', title: 'Sebelum' }), untitled, book({ id: 'T-3', title: 'Sesudah' })]));
    expect(r.summary).toMatchObject({ read: 3, created: 2, errors: 1 });
    expect((await reportRows(db, r.run)).filter((row) => row[2] === 'error')).toEqual([['2', '', 'error', 'title_missing', 'title', '', '']]);
  });

  it('a MARCXML file with a DOCTYPE → the run fails with CATALOG_IMPORT_FORMAT and nothing is written', async () => {
    const xml = MARCXML_COLLECTION_OPEN.replace('?>\n', '?>\n<!DOCTYPE collection [<!ENTITY x "y">]>\n') + writeMarcXmlRecord(book({ id: 'DT-1', title: 'Doctype' })) + MARCXML_COLLECTION_CLOSE;
    const r = await importFile(db, xml);
    expect(r.run.format).toBe('marcxml');
    expect(r.run.status).toBe('failed');
    expect(r.summary).toMatchObject({ error: 'CATALOG_IMPORT_FORMAT', reason: 'xml_doctype', created: 0 });
    expect(await count(db, 'records')).toBe(0);
    const finish = await db.h.db.selectFrom('audit_log').select(['actor_type', 'meta']).where('action', '=', 'catalog.import.finish').where('entity_id', '=', r.runId).execute();
    expect(finish.map((e) => [e.actor_type, (JSON.parse(e.meta ?? '{}') as { status: string }).status])).toEqual([['system', 'failed']]);
  });

  it('a MARCXML namespace context too large to checkpoint (a 9 000-character prefix) → CATALOG_IMPORT_FORMAT', async () => {
    const p = `p${'x'.repeat(9000)}`;
    const xml =
      `<?xml version="1.0" encoding="UTF-8"?>\n<${p}:collection xmlns:${p}="http://www.loc.gov/MARC21/slim">` +
      `<${p}:record><${p}:leader>00000nam a2200000 i 4500</${p}:leader>` +
      `<${p}:datafield tag="245" ind1="1" ind2="0"><${p}:subfield code="a">Awalan Panjang</${p}:subfield></${p}:datafield></${p}:record>` +
      `</${p}:collection>\n`;
    const r = await importFile(db, xml, { format: 'marcxml' });
    // The reader's own bound (S9, Task 6) refuses it first; the job would refuse a context over 8 KiB of JSON anyway.
    expect([r.run.status, r.summary.error, r.summary.reason, r.summary.created]).toEqual(['failed', 'CATALOG_IMPORT_FORMAT', 'xml_limit', 0]);
  });

  it('a file that is no import format → the run fails with CATALOG_IMPORT_FORMAT (unknown_format)', async () => {
    const r = await importFile(db, Buffer.from('hanya satu kolom tanpa kepala yang dikenal\r\n', 'utf8'));
    expect([r.run.status, r.run.format, r.summary.error, r.summary.reason]).toEqual(['failed', null, 'CATALOG_IMPORT_FORMAT', 'unknown_format']);
  });

  it('onMatch update by ISBN: the stored record takes the file title; nothing new is created', async () => {
    const buku = await db.materialTypeId('BUKU');
    const { id } = await db.run((tx) => createRecord(tx, { materialTypeId: buku, title: 'Judul Lama', identifiers: [{ type: 'isbn', value: '978-602-03-3295-6' }] }));
    const r = await importFile(db, iso([book({ id: 'UPD-1', title: 'Judul Baru', isbn: '9786020332956', year: '2015' })]), { matchOn: 'isbn', onMatch: 'update' });
    expect(r.summary).toMatchObject({ read: 1, created: 0, updated: 1, errors: 0 });
    const rows = await db.h.db.selectFrom('records').select(['id', 'title', 'publication_year', 'version']).execute();
    expect(rows).toEqual([{ id, title: 'Judul Baru', publication_year: '2015', version: 1 }]);
    // With `skip` the same file changes nothing and is counted as matched.
    const skipped = await importFile(db, iso([book({ id: 'UPD-1', title: 'Judul Lain', isbn: '9786020332956' })]), { matchOn: 'isbn', onMatch: 'skip' });
    expect(skipped.summary).toMatchObject({ updated: 0, created: 0, skipped: { matched: 1 } });
    expect((await db.h.db.selectFrom('records').select('title').executeTakeFirstOrThrow()).title).toBe('Judul Baru');
  });

  it('952 with createItems → items in the options branch with the history event `imported`, the location by code', async () => {
    const rec = book({
      id: 'ITM-1',
      title: 'Buku Berkas Eksemplar',
      extra: [df('952', '  ', 'aPUSAT', 'cREF', 'o001 UJI', 'pIMP-0001', 'yUMUM'), df('952', '  ', 'aPUSAT', 'pIMP-0002', 'yREF')],
    });
    const r = await importFile(db, iso([rec]), { createItems: true, branchId: db.branchId });
    expect(r.summary).toMatchObject({ created: 1, itemsCreated: 2, errors: 0 });
    const items = await db.h.db
      .selectFrom('items as i')
      .leftJoin('locations as l', 'l.id', 'i.location_id')
      .innerJoin('collection_types as ct', 'ct.id', 'i.collection_type_id')
      .select(['i.barcode_key', 'i.branch_id', 'l.code_key as location', 'i.call_number', 'ct.code_key as type', 'i.status'])
      .orderBy('i.barcode_key')
      .execute();
    expect(items).toEqual([
      { barcode_key: 'IMP-0001', branch_id: db.branchId, location: 'REF', call_number: '001 UJI', type: 'UMUM', status: 'available' },
      { barcode_key: 'IMP-0002', branch_id: db.branchId, location: null, call_number: null, type: 'REF', status: 'available' },
    ]);
    const events = await db.h.db.selectFrom('item_events').select(['type', 'to_status']).execute();
    expect(events).toEqual([
      { type: 'imported', to_status: 'available' },
      { type: 'imported', to_status: 'available' },
    ]);
  });

  describe('M7: onDuplicate', () => {
    /** A stored record "Laskar Pelangi" (2005, Hirata, Andrea) through the records service: indexed by Task 15. */
    async function storedNovel(): Promise<string> {
      const buku = await db.materialTypeId('BUKU');
      const saved = await db.run((tx) =>
        createRecord(tx, {
          materialTypeId: buku,
          title: 'Laskar Pelangi',
          publicationYear: '2005',
          agents: [{ ref: { type: 'person', name: 'Hirata, Andrea' }, role: 'aut', isMain: true }],
        }),
      );
      return saved.id;
    }

    // A typo in the title: no ISBN and no equal title key, so only the scored check (titleCandidates + Dice) finds it.
    const likely = () => iso([book({ id: 'DUP-1', title: 'Laskar Pelangii', year: '2005', author: 'Hirata, Andrea' })]);

    it("'skip': a record whose title, year and main agent score above the threshold is skipped and counted", async () => {
      const existing = await storedNovel();
      const r = await importFile(db, likely(), { onDuplicate: 'skip' });
      expect(r.summary).toMatchObject({ read: 1, created: 0, duplicates: 1, skipped: { duplicate: 1 } });
      expect(await count(db, 'records')).toBe(1);
      expect(await reportRows(db, r.run)).toEqual([['1', '', 'duplicate', 'duplicate', '', existing, 'Laskar Pelangii']]);
    });

    it("'report': the likely duplicate is created and reported", async () => {
      const existing = await storedNovel();
      const r = await importFile(db, likely(), { onDuplicate: 'report' });
      expect(r.summary).toMatchObject({ read: 1, created: 1, duplicates: 1 });
      expect(await count(db, 'records')).toBe(2);
      expect((await reportRows(db, r.run)).filter((row) => row[2] === 'duplicate')).toEqual([['1', '', 'duplicate', 'duplicate', '', existing, 'Laskar Pelangii']]);
    });

    it('two equal drafts in one batch: the second is caught by the in-batch check (title key + year), on every dialect', async () => {
      // Title and year only: the scored check would give 60 + 15 = 75, below the threshold 80, on any dialect; the
      // in-batch check by title key + year finds it whether the engine's full text sees the batch's own rows or not.
      const twins = iso([book({ id: 'TW-1', title: 'Kembar Siam', year: '2001' }), book({ id: 'TW-2', title: 'Kembar siam!', year: '2001' })]);
      const skip = await importFile(db, twins, { onDuplicate: 'skip' });
      expect(skip.summary).toMatchObject({ read: 2, created: 1, duplicates: 1, skipped: { duplicate: 1 } });
      const kept = (await db.h.db.selectFrom('records').select('id').executeTakeFirstOrThrow()).id;
      expect(await reportRows(db, skip.run)).toEqual([['2', '', 'duplicate', 'duplicate', '', kept, 'Kembar siam!']]);
      // The skipped twin is mapped to the record it duplicates (a repeated slice passes it over).
      expect(await db.h.db.selectFrom('migration_map').select(['legacy_key', 'target_id']).where('source', '=', `import:${skip.runId}`).orderBy('legacy_key').execute()).toEqual([
        { legacy_key: '1', target_id: kept },
        { legacy_key: '2', target_id: kept },
      ]);

      await clean(db);
      const report = await importFile(db, twins, { onDuplicate: 'report' });
      expect(report.summary).toMatchObject({ read: 2, created: 2, duplicates: 1 });
    });
  });

  it('a record whose material type the leader names is stored with it; an unknown leader takes the default', async () => {
    const map: MarcRecord = { ...book({ id: 'MAP-1', title: 'Peta Jawa' }), leader: '00000nem a2200000 i 4500' };
    const odd: MarcRecord = { ...book({ id: 'ODD-1', title: 'Jenis Aneh' }), leader: '00000nzm a2200000 i 4500' };
    await importFile(db, iso([map, odd]));
    const rows = await db.h.db
      .selectFrom('records as r')
      .innerJoin('material_types as mt', 'mt.id', 'r.material_type_id')
      .select(['r.title', 'mt.code_key'])
      .orderBy('r.title')
      .execute();
    expect(rows).toEqual([
      { title: 'Jenis Aneh', code_key: normalizeKey('BUKU') },
      { title: 'Peta Jawa', code_key: normalizeKey('PETA') },
    ]);
  });

  it('records are created by the run creator with the source import:<runId>', async () => {
    const r = await importFile(db, iso([book({ id: 'SRC-1', title: 'Sumber Impor' })]));
    expect(await db.h.db.selectFrom('records').select(['source', 'created_by', 'created_at']).execute()).toEqual([
      { source: `import:${r.runId}`, created_by: db.staff.id, created_at: NOW },
    ]);
    expect(newId(NOW)).not.toBe(r.runId);
  });
});
