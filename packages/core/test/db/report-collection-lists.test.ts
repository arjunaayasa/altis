import { addDays, t } from '@altis/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { engineLabel, testDbContext } from '../../../../tools/test/test-db.js';
import { collectionItemListReport as items } from '../../src/reports/collection/item-list.js';
import { collectionTitleListReport as titles } from '../../src/reports/collection/title-list.js';
import type { ReportRow } from '../../src/reports/types.js';
import { stockAt } from '../support/stock-fixture.js';
import { TODAY, addLocation, addTitle, ctxFor, drain, openCollectionDb, type CollectionDb } from './report-collection-support.js';

// The title and copy lists over the stock fixture plus titles of their own: fiction by collection type and by call
// number prefix, local works, the reader audience, the stock at a date, and keyset pages that give the same rows as one
// page.

const ctx = testDbContext();
const titleOf = (r: ReportRow) => r[0];

describe.skipIf(!ctx.available)(`collection.title_list and collection.item_list [${engineLabel()}]`, () => {
  let c: CollectionDb;
  let roomId: string;

  beforeAll(async () => {
    c = await openCollectionDb('report-lists');
    roomId = await addLocation(c.db, c.branchId, 'R-ANAK', 'Ruang Anak');
    await addTitle(c.db, c.branchId, {
      title: 'Bumi Manusia',
      responsibility: 'Pramoedya Ananta Toer',
      classification: '899.221 3',
      callNumber: '899.221 3 PRA b',
      year: '1980',
      place: 'Jakarta',
      edition: 'Cet. 2',
      language: 'ind',
      items: [
        { barcode: 'LST-0001', collectionType: 'FIKSI', receivedDate: '2023-01-10', locationId: roomId },
        { barcode: 'LST-0002', collectionType: 'FIKSI', receivedDate: '2023-01-10', status: 'repair' },
      ],
    });
    await addTitle(c.db, c.branchId, {
      title: 'Cerita Rakyat Nusantara',
      classification: '398.2',
      callNumber: 'F 398.2 CER c',
      audience: 'children',
      items: [{ barcode: 'LST-0003', receivedDate: '2023-02-01', locationId: roomId }],
    });
    await addTitle(c.db, c.branchId, {
      title: 'Kumpulan Puisi Siswa',
      classification: '899.221 1',
      localWork: 'student',
      localWorkKind: 'poetry',
      items: [{ barcode: 'LST-0004', receivedDate: '2023-03-01' }],
    });
    await addTitle(c.db, c.branchId, {
      title: 'Sejarah Desa Sukamaju',
      classification: '959.8',
      localWork: 'local',
      items: [{ barcode: 'LST-0005', receivedDate: '2023-03-02' }],
    });
    await addTitle(c.db, c.branchId, {
      title: 'Fisika Dasar',
      classification: '530',
      callNumber: '530 FIS f',
      audience: 'general',
      createdAt: stockAt('2026-05-01'),
      items: [{ barcode: 'LST-0006', receivedDate: '2026-05-01', createdAt: stockAt('2026-05-01') }],
    });
  });

  afterAll(async () => {
    await c?.close();
  });

  const fictionSettings = () => ({ ...c.settings, fiction: { ...c.settings.fiction, callNumberPrefixes: ['F'] } });

  it('lists every title with its details and copies', async () => {
    const { rows } = await drain(titles, ctxFor(c, titles, {}));
    expect(rows.find((r) => String(titleOf(r)).startsWith('Bumi Manusia'))).toEqual([
      'Bumi Manusia / Pramoedya Ananta Toer',
      'Cet. 2',
      null,
      'Jakarta',
      '1980',
      null,
      '899.221 3',
      '899.221 3 PRA b',
      2,
    ]);
    // Every title that is not archived, in title order (the archived copies' titles too).
    expect(rows).toHaveLength(14 + 5);
  });

  it('lists the fiction by collection type and by call number prefix', async () => {
    const settings = fictionSettings();
    const live = await drain(titles, ctxFor(c, titles, { fictionOnly: true }, { settings }));
    expect(live.rows.map(titleOf)).toEqual(['Bumi Manusia / Pramoedya Ananta Toer', 'Cerita Rakyat Nusantara']);
    const withoutPrefix = await drain(titles, ctxFor(c, titles, { fictionOnly: true }));
    expect(withoutPrefix.rows.map(titleOf)).toEqual(['Bumi Manusia / Pramoedya Ananta Toer']);
    const scanned = await drain(titles, ctxFor(c, titles, { fictionOnly: true, asOf: TODAY }, { settings, today: addDays(TODAY, 1) }));
    expect(scanned.rows.map(titleOf).sort()).toEqual(live.rows.map(titleOf).sort());
  });

  it('lists the local works of students, teachers, staff and the school', async () => {
    const { rows } = await drain(titles, ctxFor(c, titles, { localWorkOnly: true }));
    expect(rows.map(titleOf)).toEqual(['Kumpulan Puisi Siswa']);
  });

  it('lists the titles for an audience', async () => {
    const { rows } = await drain(titles, ctxFor(c, titles, { audience: 'children' }));
    expect(rows.map(titleOf)).toEqual(['Cerita Rakyat Nusantara']);
  });

  it('lists the titles with a copy at a location, counting those copies', async () => {
    const { rows } = await drain(titles, ctxFor(c, titles, { locationId: roomId }));
    expect(rows.map((r) => [titleOf(r), r[8]])).toEqual([
      ['Bumi Manusia / Pramoedya Ananta Toer', 1],
      ['Cerita Rakyat Nusantara', 1],
    ]);
  });

  it('lists the stock at a date: today through the grouped queries, earlier through the scan', async () => {
    const today = await drain(titles, ctxFor(c, titles, { asOf: TODAY }));
    // The stock of the fixture (9 titles) and the five titles of this test.
    expect(today.rows).toHaveLength(14);
    const scanned = await drain(titles, ctxFor(c, titles, { asOf: TODAY }, { today: addDays(TODAY, 1) }));
    expect([...scanned.rows].sort()).toEqual([...today.rows].sort());
    const earlier = await drain(titles, ctxFor(c, titles, { asOf: '2025-01-31' }));
    expect(earlier.rows.map(titleOf)).toContain('Kamus Lama');
    expect(earlier.rows.map(titleOf)).not.toContain('Fisika Dasar');
  });

  it('gives the same titles in keyset pages of two as in one page', async () => {
    for (const params of [{}, { asOf: '2025-01-31' }, { fictionOnly: true }]) {
      const one = await drain(titles, ctxFor(c, titles, params, { settings: fictionSettings() }));
      const paged = await drain(titles, ctxFor(c, titles, params, { settings: fictionSettings() }), 2);
      expect(paged.rows, JSON.stringify(params)).toEqual(one.rows);
      if (one.rows.length > 2) expect(paged.pages, JSON.stringify(params)).toBeGreaterThan(1);
    }
  });

  it('counts the titles of a list up front', async () => {
    expect(await titles.count!(ctxFor(c, titles, { localWorkOnly: true }))).toBe(1);
    expect(await titles.count!(ctxFor(c, titles, {}))).toBe(19);
  });

  it('lists the copies with their status labels', async () => {
    const { rows } = await drain(items, ctxFor(c, items, { status: ['repair'] }));
    expect(rows).toEqual([['LST-0002', null, 'Bumi Manusia', '899.221 3 PRA b', 'Fiksi', t('id', 'vocab.item_status.repair'), null, '2023-01-10', null, null]]);
    const room = await drain(items, ctxFor(c, items, { locationId: roomId }));
    expect(room.rows.map((r) => [r[0], r[6]])).toEqual([
      ['LST-0001', 'Ruang Anak'],
      ['LST-0003', 'Ruang Anak'],
    ]);
  });

  it('lists the copies live at a date, with their status of that day', async () => {
    const earlier = await drain(items, ctxFor(c, items, { asOf: '2026-01-04' }));
    const barcodes = earlier.rows.map((r) => r[0]);
    expect(barcodes).toContain('STK-0009');
    expect(barcodes).not.toContain('STK-0008');
    expect(barcodes).not.toContain('STK-0007');
    expect(earlier.rows.find((r) => r[0] === 'STK-0009')![5]).toBe(t('id', 'vocab.item_status.missing'));
    const today = await drain(items, ctxFor(c, items, { asOf: TODAY }));
    const scanned = await drain(items, ctxFor(c, items, { asOf: TODAY }, { today: addDays(TODAY, 1) }));
    expect([...scanned.rows].sort()).toEqual([...today.rows].sort());
  });

  it('gives the same copies in keyset pages of two as in one page', async () => {
    for (const params of [{}, { asOf: '2025-01-31' }, { received: { from: '2023-01-01', to: '2023-12-31' } }]) {
      const one = await drain(items, ctxFor(c, items, params));
      const paged = await drain(items, ctxFor(c, items, params), 2);
      expect(paged.rows, JSON.stringify(params)).toEqual(one.rows);
    }
    // The copies that are not withdrawn: ten of the fixture and the six of this test.
    expect(await items.count!(ctxFor(c, items, {}))).toBe(16);
  });
});
