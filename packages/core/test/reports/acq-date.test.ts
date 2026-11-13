import { describe, expect, it } from 'vitest';
import { acqDateOf, firstAcq, inStockAt, liveAt, lostAt, statusAt, type AcqInput, type ItemStockFacts, type RecordStockFacts } from '../../src/reports/stock/index.js';

// The acquisition date of a copy and the stock at a date. A copy's acquisition date is the first known of: its
// receiving date, the date it was entered in the source system, its record's creation time when the copy was migrated
// (unless that time is the migration's own clock), its own creation time when it was made here; otherwise unknown. The
// time of a migration is never an acquisition date: an undated copy is in stock at every date and never an addition.

const TZ = 'Asia/Jakarta';
/** 12:00 in Jakarta (UTC+7) on `date`. */
const noon = (date: string): number => Date.parse(`${date}T05:00:00Z`);

function input(o: Partial<AcqInput> = {}): AcqInput {
  return {
    receivedDate: null,
    inputOn: null,
    firstEventType: null,
    recordCreatedAt: null,
    recordCreatedInMigrationSpan: false,
    itemCreatedAt: noon('2026-02-01'),
    tz: TZ,
    ...o,
  };
}

function item(o: Partial<ItemStockFacts> = {}): ItemStockFacts {
  return {
    itemId: 'item-1',
    recordId: 'rec-1',
    branchId: 'branch-1',
    status: 'available',
    acqDate: '2024-01-10',
    acqBasis: 'received',
    archivedOn: null,
    statusTimeline: [],
    collectionTypeId: null,
    collectionTypeCode: null,
    locationId: null,
    barcodeKey: null,
    callNumber: null,
    inventoryNo: null,
    receivedDate: null,
    price: null,
    currency: null,
    acqSource: null,
    supplierId: null,
    ...o,
  };
}

function record(o: Partial<RecordStockFacts> = {}): RecordStockFacts {
  return {
    recordId: 'rec-1',
    archived: false,
    createdOn: '2023-05-01',
    materialTypeCode: 'BUKU',
    classification: null,
    callNumber: null,
    languageId: null,
    localWork: null,
    localWorkKind: null,
    referenceKind: null,
    audience: null,
    hasPublicFile: false,
    isPlaceholder: false,
    items: [],
    ...o,
  };
}

const EBOOK = new Set(['EBOOK']);

describe('acqDateOf: the chain of acquisition dates', () => {
  it('the receiving date comes first', () => {
    expect(acqDateOf(input({ receivedDate: '2024-03-15', inputOn: '2023-01-01', firstEventType: 'created' }))).toEqual({ date: '2024-03-15', basis: 'received' });
  });

  it('a receiving date that is not a calendar day falls through to the next step', () => {
    expect(acqDateOf(input({ receivedDate: '0000-00-00', inputOn: '2023-07-20', firstEventType: 'migrated' }))).toEqual({ date: '2023-07-20', basis: 'input_on' });
    expect(acqDateOf(input({ receivedDate: '2023-02-29', firstEventType: 'created', itemCreatedAt: noon('2025-06-02') }))).toEqual({ date: '2025-06-02', basis: 'item_created' });
  });

  it('then the date the copy was entered in the source system', () => {
    expect(acqDateOf(input({ inputOn: '2023-07-20', firstEventType: 'migrated', recordCreatedAt: noon('2020-01-01') }))).toEqual({ date: '2023-07-20', basis: 'input_on' });
    expect(acqDateOf(input({ inputOn: '0000-00-00', firstEventType: 'imported' }))).toEqual({ date: null, basis: null });
  });

  it('a migrated copy: the local date of its record creation', () => {
    // 23:30 UTC is already the next day in Jakarta.
    const late = Date.parse('2022-05-09T23:30:00Z');
    expect(acqDateOf(input({ firstEventType: 'migrated', recordCreatedAt: late }))).toEqual({ date: '2022-05-10', basis: 'record_created' });
  });

  it('a migrated copy whose record time lies in the migration run is undated', () => {
    expect(acqDateOf(input({ firstEventType: 'migrated', recordCreatedAt: noon('2025-09-01'), recordCreatedInMigrationSpan: true }))).toEqual({ date: null, basis: null });
  });

  it('a migrated copy without a known record time is undated, never dated by its own (migration) creation', () => {
    expect(acqDateOf(input({ firstEventType: 'migrated', recordCreatedAt: null, itemCreatedAt: noon('2025-09-01') }))).toEqual({ date: null, basis: null });
  });

  it('a copy made here: the local date of its own creation', () => {
    expect(acqDateOf(input({ firstEventType: 'created', itemCreatedAt: Date.parse('2025-06-01T18:00:00Z'), recordCreatedAt: noon('2020-01-01') }))).toEqual({
      date: '2025-06-02',
      basis: 'item_created',
    });
  });

  it('an imported copy without dates, or a copy without history, is undated', () => {
    expect(acqDateOf(input({ firstEventType: 'imported', recordCreatedAt: noon('2020-01-01') }))).toEqual({ date: null, basis: null });
    expect(acqDateOf(input({ firstEventType: null, recordCreatedAt: noon('2020-01-01') }))).toEqual({ date: null, basis: null });
  });
});

describe('the status in force at a date', () => {
  const timeline = [
    { on: '2025-09-01', to: 'available' as const },
    { on: '2026-01-05', to: 'lost' as const },
    { on: '2026-03-01', to: 'available' as const },
  ];

  it('a copy lost on 2026-01-05 and found on 2026-03-01 is lost in between only', () => {
    const i = item({ statusTimeline: timeline });
    expect(lostAt(i, '2026-02-01')).toBe(true);
    expect(lostAt(i, '2026-01-05')).toBe(true);
    expect(lostAt(i, '2026-03-02')).toBe(false);
    expect(lostAt(i, '2026-03-01')).toBe(false);
    expect(lostAt(i, '2025-12-31')).toBe(false);
  });

  it('before every entry, the first status holds (a migrated copy already lost before the run)', () => {
    const i = item({ status: 'lost', statusTimeline: [{ on: '2025-09-01', to: 'lost' }] });
    expect(lostAt(i, '2024-01-01')).toBe(true);
    expect(statusAt(i, '2024-01-01')).toBe('lost');
  });

  it('without any entry, the current status holds', () => {
    expect(statusAt(item({ status: 'repair' }), '2020-01-01')).toBe('repair');
    expect(lostAt(item({ status: 'lost' }), '2020-01-01')).toBe(true);
  });

  it('two entries on the same day: the later one is in force that day', () => {
    const i = item({ statusTimeline: [{ on: '2025-01-01', to: 'available' }, { on: '2025-06-01', to: 'missing' }, { on: '2025-06-01', to: 'lost' }] });
    expect(statusAt(i, '2025-06-01')).toBe('lost');
    expect(statusAt(i, '2025-05-31')).toBe('available');
  });
});

describe('liveAt: a copy in the stock at a date', () => {
  it('needs an acquisition on or before the date', () => {
    const i = item({ acqDate: '2024-01-10' });
    expect(liveAt(i, '2024-01-09')).toBe(false);
    expect(liveAt(i, '2024-01-10')).toBe(true);
  });

  it('an undated copy is live at every date', () => {
    expect(liveAt(item({ acqDate: null, acqBasis: null }), '1990-01-01')).toBe(true);
  });

  it('a withdrawn copy leaves the stock on the day it was archived', () => {
    const i = item({ status: 'withdrawn', archivedOn: '2025-02-01' });
    expect(liveAt(i, '2025-01-31')).toBe(true);
    expect(liveAt(i, '2025-02-01')).toBe(false);
  });

  it('an ordered copy is never live', () => {
    expect(liveAt(item({ status: 'on_order', acqDate: '2026-02-01', acqBasis: 'item_created' }), '2027-01-01')).toBe(false);
  });

  it('a lost copy is not live while it is lost', () => {
    const i = item({ status: 'lost', statusTimeline: [{ on: '2021-04-12', to: 'available' }, { on: '2026-01-05', to: 'lost' }] });
    expect(liveAt(i, '2026-01-04')).toBe(true);
    expect(liveAt(i, '2026-01-05')).toBe(false);
  });
});

describe('inStockAt: a title in the stock at a date', () => {
  it('a title with a live copy', () => {
    const r = record({ items: [item({ acqDate: '2024-01-10' })] });
    expect(inStockAt(r, '2024-01-09', EBOOK)).toBe(false);
    expect(inStockAt(r, '2024-01-10', EBOOK)).toBe(true);
  });

  it('an archived title never', () => {
    expect(inStockAt(record({ archived: true, items: [item()] }), '2030-01-01', EBOOK)).toBe(false);
  });

  it('a title whose only copy is ordered never, even though the record has items', () => {
    expect(inStockAt(record({ materialTypeCode: 'EBOOK', items: [item({ status: 'on_order' })] }), '2030-01-01', EBOOK)).toBe(false);
  });

  it('an electronic title without copies from its creation date on', () => {
    const r = record({ materialTypeCode: 'EBOOK', createdOn: '2024-11-20' });
    expect(inStockAt(r, '2024-11-19', EBOOK)).toBe(false);
    expect(inStockAt(r, '2024-11-20', EBOOK)).toBe(true);
    expect(inStockAt(record({ materialTypeCode: 'EBOOK', createdOn: null }), '1990-01-01', EBOOK)).toBe(true);
  });

  it('a printed title without copies only with a public file', () => {
    expect(inStockAt(record({ createdOn: '2025-03-03' }), '2026-01-01', EBOOK)).toBe(false);
    expect(inStockAt(record({ createdOn: '2025-03-03', hasPublicFile: true }), '2026-01-01', EBOOK)).toBe(true);
    expect(inStockAt(record({ createdOn: '2025-03-03', hasPublicFile: true }), '2025-03-02', EBOOK)).toBe(false);
  });
});

describe('firstAcq: the first acquisition of a title', () => {
  it('a title whose only copy is ordered (made here, dated by its creation) has none', () => {
    const r = record({ items: [item({ status: 'on_order', acqDate: '2026-02-01', acqBasis: 'item_created' })] });
    expect(firstAcq(r)).toBe('unknown');
  });

  it('an ordered copy beside a received one does not count', () => {
    const r = record({
      items: [item({ itemId: 'item-1', status: 'on_order', acqDate: '2020-01-01', acqBasis: 'item_created' }), item({ itemId: 'item-2', acqDate: '2024-03-15', acqBasis: 'received' })],
    });
    expect(firstAcq(r)).toBe('2024-03-15');
  });

  it('the earliest copy, archived copies included', () => {
    const r = record({ items: [item({ itemId: 'item-1', acqDate: '2024-03-15' }), item({ itemId: 'item-2', status: 'withdrawn', acqDate: '2019-08-01', archivedOn: '2025-02-01' })] });
    expect(firstAcq(r)).toBe('2019-08-01');
  });

  it('one undated copy makes it unknown', () => {
    const r = record({ items: [item({ itemId: 'item-1', acqDate: '2024-03-15' }), item({ itemId: 'item-2', acqDate: null, acqBasis: null })] });
    expect(firstAcq(r)).toBe('unknown');
  });

  it('a title without copies: its creation date, or unknown', () => {
    expect(firstAcq(record({ createdOn: '2024-11-20' }))).toBe('2024-11-20');
    expect(firstAcq(record({ createdOn: null }))).toBe('unknown');
  });
});
