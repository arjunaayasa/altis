import { describe, expect, it } from 'vitest';
import { slimsItemStatus } from '../../src/migration/slims/maps/item-status.js';
import { parseSlimsRunSettings, stageOptions } from '../../src/migration/slims/options.js';
import { reconcile } from '../../src/migration/slims/reconcile.js';
import { slimsSummaryRows } from '../../src/migration/slims/report.js';
import { createCounters } from '../../src/migration/slims/counters.js';
import type { MigrationSummary } from '@altis/shared/api/catalog/migration';

// The options of a SLiMS migration run with the catalogue re-sync: the stored options of a run made before the
// catalogue mode existed still parse (`append`, no skip); the item statuses a library adds for weeding and for lost
// copies; the reconciliation of a re-sync, whose archived rows include mapped rows whose source row is gone (no source
// rows), and whose unread rows say why they are not read; the report's sentence on the tables not read.

const BRANCH = '01JD0000000000000000000000';

/** Stored options as a run before the catalogue mode wrote them. */
const OLD = {
  sourceKind: 'dump',
  db: null,
  branchId: BRANCH,
  priceMode: 'major',
  sourceName: 'slims',
  allowNonEmpty: false,
  dumpStagingId: null,
  files: null,
  filesStagingId: null,
  filesDir: null,
  adoptedFrom: null,
};

describe('SLiMS run options: the catalogue mode', () => {
  it('stored options without the catalogue fields parse, and the stages get append and no skip', () => {
    const settings = parseSlimsRunSettings(JSON.stringify(OLD));
    expect(settings.catalogMode).toBeUndefined();
    expect(stageOptions(settings)).toEqual({ branchId: BRANCH, priceMode: 'major', sourceName: 'slims', allowNonEmpty: false, catalogMode: 'append', skipCatalog: false });
  });

  it('stored options with them parse as stored; anything else in them is refused', () => {
    const settings = parseSlimsRunSettings(JSON.stringify({ ...OLD, catalogMode: 'sync', skipCatalog: true }));
    expect(stageOptions(settings)).toMatchObject({ catalogMode: 'sync', skipCatalog: true });
    expect(() => parseSlimsRunSettings(JSON.stringify({ ...OLD, catalogMode: 'replace' }))).toThrow(TypeError);
    expect(() => parseSlimsRunSettings(JSON.stringify({ ...OLD, skipCatalog: 'yes' }))).toThrow(TypeError);
  });
});

describe('SLiMS item statuses a library adds', () => {
  it('a status named for weeding becomes withdrawn, one named lost becomes lost, whatever its code, case or accents', () => {
    expect(slimsItemStatus('W', { name: 'Disiangi', noLoan: true })).toEqual({ status: 'withdrawn', note: null, unknown: false });
    expect(slimsItemStatus('pny', { name: '  PENYIANGAN ', noLoan: false })).toEqual({ status: 'withdrawn', note: null, unknown: false });
    expect(slimsItemStatus('WD', { name: 'Withdrawn', noLoan: true })).toMatchObject({ status: 'withdrawn' });
    expect(slimsItemStatus('HL', { name: 'Hilang', noLoan: true })).toEqual({ status: 'lost', note: null, unknown: false });
    expect(slimsItemStatus('X', { name: 'Dinyatakan  hilang', noLoan: true })).toMatchObject({ status: 'lost' });
    expect(slimsItemStatus('LST', { name: 'Lost', noLoan: false })).toMatchObject({ status: 'lost' });
  });

  it('the built-in codes keep their meaning, and a name that only contains the word is not taken for it', () => {
    expect(slimsItemStatus('MIS', { name: 'Hilang', noLoan: true })).toMatchObject({ status: 'missing' });
    expect(slimsItemStatus('R', { name: 'Disiangi', noLoan: true })).toMatchObject({ status: 'repair' });
    expect(slimsItemStatus('HS', { name: 'Hilang sementara', noLoan: true })).toMatchObject({ status: 'not_for_loan' });
    expect(slimsItemStatus('ZZ', null)).toEqual({ status: 'available', note: 'SLiMS: ZZ', unknown: true });
  });
});

describe('the reconciliation of a re-sync', () => {
  it('mapped rows whose source row is gone are listed as archived and stay out of the difference', () => {
    const counters = createCounters(null);
    counters.source('item', 600);
    counters.migrated('item', 598);
    counters.skipped('item', 'edited_in_altis', 2);
    counters.vanished('item', 2);
    counters.source('loan', 6);
    counters.unread('loan', 0);
    counters.unread('search_biblio', 4);
    const json = counters.toJSON();
    expect(json.vanished).toEqual({ item: 2 });
    const r = reconcile(json);
    expect(r.ok).toBe(true);
    expect(r.tables.find((t) => t.table === 'item')).toEqual({ table: 'item', source: 600, migrated: 598, merged: 0, skipped: 2, archived: 2, unread: false, diff: 0 });
    // Every unread row says why it is not read; a read row has no such field.
    expect(r.tables.find((t) => t.table === 'loan')).toMatchObject({ unread: true, unreadKind: 'phase3' });
    expect(r.tables.find((t) => t.table === 'search_biblio')).toMatchObject({ unread: true, unreadKind: 'derived' });
    expect(r.tables.find((t) => t.table === 'item')).not.toHaveProperty('unreadKind');
    // Loaded again from the summary, the counters go on from there.
    const again = createCounters(JSON.parse(JSON.stringify(json)));
    again.vanished('item', 1);
    again.changed('item', 3);
    expect(again.toJSON()).toMatchObject({ vanished: { item: 3 }, changes: { item: 3 } });
    expect(again.toJSON().tables['item']!.archived).toBe(3);
  });

  it('a row archived beyond the vanished ones is still a difference', () => {
    const off = reconcile({ tables: { item: { source: 10, migrated: 9, merged: 0, skipped: {}, archived: 2 } }, unread: [], vanished: { item: 1 } });
    expect(off.tables[0]).toMatchObject({ archived: 2, diff: 0 });
    const more = reconcile({ tables: { item: { source: 10, migrated: 9, merged: 0, skipped: {}, archived: 2 } }, unread: [] });
    expect(more).toMatchObject({ ok: false, tables: [{ diff: -1 }] });
  });
});

describe('the report of a run', () => {
  const summary = (o: Partial<MigrationSummary> = {}): MigrationSummary => ({
    version: '9',
    stage: 'report',
    tables: {},
    unread: [],
    reconciliation: { ok: true, tables: [] },
    fixes: {},
    samples: [],
    charset: [],
    targets: [],
    checks: [],
    missingFiles: 0,
    nonstandardBarcodes: 0,
    warnings: [],
    ...o,
  });

  it('the tables not read are named by their module, with the hint of the separate aggregate import', () => {
    const rows = slimsSummaryRows({ summary: summary(), settings: { ...parseSlimsRunSettings(JSON.stringify(OLD)) }, dryRun: false, status: 'succeeded', baseUrl: 'https://x.test', checkSource: {} });
    const unread = rows.find((r) => r[2] === 'phase3_tables')!;
    expect(unread[3]).toMatch(
      /^Tidak dibaca: modul Anggota\/Sirkulasi; impor agregat terpisah membaca sebagian kolom tanpa memigrasi \/ Not read: Members\/Circulation module; the separate aggregate import reads some columns without migrating them: member\*, loan\*, group\*, fines, /,
    );
    expect(rows[0]![3]).toContain('catalogMode=append; skipCatalog=false');
  });

  it('a sync dry run names its catalogue changes in the run row', () => {
    const settings = parseSlimsRunSettings(JSON.stringify({ ...OLD, catalogMode: 'sync' }));
    const rows = slimsSummaryRows({ summary: summary({ catalogChanges: 10 }), settings, dryRun: true, status: 'succeeded', baseUrl: 'https://x.test', checkSource: {} });
    expect(rows[0]![3]).toContain('catalogMode=sync; skipCatalog=false; catalogChanges=10');
  });
});
