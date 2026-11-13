import { t, type MessageKey } from '@altis/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { engineLabel, testDbContext } from '../../../../tools/test/test-db.js';
import { collectionDataQualityReport as def } from '../../src/reports/collection/data-quality.js';
import { stockAt } from '../support/stock-fixture.js';
import { addLocation, addTitle, ctxFor, drain, openCollectionDb, type CollectionDb } from './report-collection-support.js';

// The data quality report over a catalogue of its own: one row per problem per copy or record, the problems in a fixed
// order (no receiving date, no call number on the copy or its record, no location, a record without classification, no
// acquisition date at all), each problem's rows by barcode or title. Copies that are not in the collection (ordered,
// lost, withdrawn) have no problems to fix.

const ctx = testDbContext();
const problem = (key: string) => t('id', `report.data_quality.problem.${key}` as MessageKey);

describe.skipIf(!ctx.available)(`collection.data_quality [${engineLabel()}]`, () => {
  let c: CollectionDb;

  beforeAll(async () => {
    c = await openCollectionDb('report-quality', { fixture: false });
    const room = await addLocation(c.db, c.branchId, 'R1', 'Ruang Baca');
    const at = stockAt('2024-02-01');
    // Complete.
    await addTitle(c.db, c.branchId, {
      title: 'Lengkap',
      classification: '500',
      callNumber: '500 LEN l',
      createdAt: at,
      items: [{ barcode: 'Q-0001', receivedDate: '2024-02-01', locationId: room, createdAt: at }],
    });
    // A copy without a receiving date, dated by the source system instead.
    await addTitle(c.db, c.branchId, {
      title: 'Tanpa Terima',
      classification: '510',
      callNumber: '510 TAN t',
      createdAt: at,
      items: [{ barcode: 'Q-0002', inputOn: '2020-01-01', locationId: room, createdAt: at }],
    });
    // Neither the copy nor the record has a call number.
    await addTitle(c.db, c.branchId, {
      title: 'Tanpa Nomor Panggil',
      classification: '520',
      createdAt: at,
      items: [{ barcode: 'Q-0003', receivedDate: '2024-02-01', locationId: room, createdAt: at }],
    });
    // The copy's own call number is enough.
    await addTitle(c.db, c.branchId, {
      title: 'Nomor Panggil Eksemplar',
      classification: '530',
      createdAt: at,
      items: [{ barcode: 'Q-0004', receivedDate: '2024-02-01', callNumber: '530 NOM n', locationId: room, createdAt: at }],
    });
    // A copy without a location.
    await addTitle(c.db, c.branchId, {
      title: 'Tanpa Lokasi',
      classification: '540',
      callNumber: '540 TAN t',
      createdAt: at,
      items: [{ barcode: 'Q-0005', receivedDate: '2024-02-01', createdAt: at }],
    });
    // A record without classification, two copies.
    await addTitle(c.db, c.branchId, {
      title: 'Tanpa Klasifikasi',
      callNumber: 'R 030 TAN t',
      createdAt: at,
      items: [
        { barcode: 'Q-0006', receivedDate: '2024-02-01', locationId: room, createdAt: at },
        { barcode: 'Q-0007', receivedDate: '2024-02-01', locationId: room, createdAt: at },
      ],
    });
    // Imported without any date: no receiving date and no acquisition date at all.
    await addTitle(c.db, c.branchId, {
      title: 'Impor Tanpa Tanggal',
      classification: '550',
      callNumber: '550 IMP i',
      createdAt: at,
      items: [{ barcode: 'Q-0008', locationId: room, event: 'imported', createdAt: at }],
    });
    // Not in the collection: ordered, lost, withdrawn (each would have every problem).
    await addTitle(c.db, c.branchId, {
      title: 'Bukan Koleksi',
      createdAt: at,
      items: [
        { barcode: 'Q-0009', status: 'on_order', event: 'imported', createdAt: at },
        { barcode: 'Q-0010', status: 'lost', event: 'imported', createdAt: at },
        { barcode: 'Q-0011', status: 'withdrawn', archivedAt: at, event: 'imported', createdAt: at },
      ],
    });
  });

  afterAll(async () => {
    await c?.close();
  });

  it('answers one row per problem per copy or record, in the order of the problems', async () => {
    const { rows } = await drain(def, ctxFor(c, def, {}));
    expect(rows).toEqual([
      [problem('item_no_received_date'), 'Q-0002', 'Tanpa Terima', '510 TAN t', 'Ruang Baca', null],
      [problem('item_no_received_date'), 'Q-0008', 'Impor Tanpa Tanggal', '550 IMP i', 'Ruang Baca', null],
      [problem('item_no_call_number'), 'Q-0003', 'Tanpa Nomor Panggil', null, 'Ruang Baca', null],
      [problem('item_no_location'), 'Q-0005', 'Tanpa Lokasi', '540 TAN t', null, null],
      [problem('record_no_classification'), null, 'Tanpa Klasifikasi', 'R 030 TAN t', null, t('id', 'report.row.collection.copies', { count: 2 })],
      [problem('item_no_acq_date'), 'Q-0008', 'Impor Tanpa Tanggal', '550 IMP i', 'Ruang Baca', t('id', 'report.row.collection.fill_received_date')],
    ]);
  });

  it('gives the same rows in pages of one', async () => {
    const one = await drain(def, ctxFor(c, def, {}));
    const paged = await drain(def, ctxFor(c, def, {}), 1);
    expect(paged.rows).toEqual(one.rows);
  });

  it('keeps to a branch', async () => {
    const other = await c.db.selectFrom('branches').select('id').where('id', '!=', c.branchId).executeTakeFirst();
    if (other !== undefined) {
      const { rows } = await drain(def, ctxFor(c, def, { branchId: other.id }));
      expect(rows).toEqual([]);
    }
    const { rows } = await drain(def, ctxFor(c, def, { branchId: c.branchId }));
    expect(rows).toHaveLength(6);
  });
});
