import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PHASE1_MIGRATIONS, runMigrations, type DB } from '@altis/db';
import { newId, normalizeKey } from '@altis/shared';
import type { Insertable } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { instrumentById } from '../../src/accreditation/instruments/index.js';
import { metricsOfProvider, type AccredMetricId } from '../../src/accreditation/metric-ids.js';
import { readProfile } from '../../src/accreditation/periods/profile.js';
import { collectionProvider } from '../../src/accreditation/providers/collection.js';
import { evaluateSnp } from '../../src/accreditation/scoring/index.js';
import type { AccredInstrument, AccredMetricContext, AccredMetricValue, ProviderResume } from '../../src/accreditation/types.js';
import { titleKey } from '../../src/catalog/lib/title-key.js';
import { loadAccredSettings, type AccredSettings } from '../../src/settings/accreditation.js';
import { seedStockFixture, stockAt, STOCK_TZ, type StockFixture } from '../support/stock-fixture.js';
import { addLocation, addTitle } from './report-collection-support.js';

// The `collection` metric provider on the engine picked by ALTIS_TEST_DB, for a school-year period 2025-07-01 …
// 2026-06-30 read after it ended (the snapshot date D is its last day): the stock and its notes on the stock fixture
// (migrated copies created during the migration are undated: in the stock, never an addition), the fiction share, the
// additions of the three calendar years 2024–2026 against the stock of 2023-12-31 with the band size and the undated
// gate, the processing facts, the local works, the school standards' metrics, the share of the collection used, and
// one pass split over several slices giving the same values as one.

const ctx = testDbContext();
const NOW = Date.UTC(2026, 8, 1, 3, 0, 0);
const TODAY = '2026-09-01';
const D = '2026-06-30';
const ALL = metricsOfProvider('collection');

/** The metric parameters an instrument's indicators give each metric. */
function paramsFrom(instrument: AccredInstrument): (metric: AccredMetricId) => Readonly<Record<string, unknown>> {
  return (metric) => instrument.components.flatMap((c) => c.indicators).find((i) => i.metric === metric)?.metricParams ?? {};
}

/** One test title of a bulk seed. */
interface BulkTitle {
  /** The receiving date of its copies (null: none). */
  received?: string | null;
  collectionType?: 'UMUM' | 'FIKSI' | 'REF' | 'TANDON';
  copies?: number;
  callNumber?: string | null;
  /** The first history row of its copies (default `created`). */
  event?: 'created' | 'imported';
}

describe.skipIf(!ctx.available)(`accreditation collection provider [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let root: string;
  let branchId: string;
  let base: AccredSettings;

  beforeAll(async () => {
    h = await testDb();
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-core-accred-collection-'));
    await runMigrations(h, { appVersion: '0.1.0', dataDir: path.join(root, 'migrations'), migrations: PHASE1_MIGRATIONS });
    base = await loadAccredSettings(h.db);
    const at = stockAt('2017-01-02');
    branchId = newId(at);
    await h.db
      .insertInto('branches')
      .values({ id: branchId, code_key: 'KOLEKSI', code_display: 'KOLEKSI', name: 'Cabang Koleksi', address: null, timezone: STOCK_TZ, is_default: 0, created_at: at, created_by: null, updated_at: at, updated_by: null })
      .execute();
  });

  afterAll(async () => {
    await h?.close();
    if (root !== undefined) await fsp.rm(root, { recursive: true, force: true });
  });

  /** Empties the catalogue (titles, copies, their history, attachments) and the periods. */
  async function clearCatalogue(): Promise<void> {
    await h.db.deleteFrom('item_events').execute();
    await h.db.deleteFrom('items').execute();
    await h.db.deleteFrom('attachments').execute();
    await h.db.deleteFrom('files').execute();
    await h.db.deleteFrom('migration_map').execute();
    await h.db.deleteFrom('catalog_runs').execute();
    await h.db.deleteFrom('records').execute();
    await h.db.deleteFrom('usage_stats').execute();
    await h.db.deleteFrom('accred_periods').execute();
  }

  async function idOf(table: 'material_types' | 'collection_types', code: string): Promise<string> {
    return (await h.db.selectFrom(table).select('id').where('code_key', '=', normalizeKey(code)).executeTakeFirstOrThrow()).id;
  }

  /** `n` titles of `spec(k)` written in chunks (a catalogue larger than a batch of the stock reader). */
  async function seedTitles(n: number, prefix: string, spec: (k: number) => BulkTitle): Promise<void> {
    const book = await idOf('material_types', 'BUKU');
    const types = new Map<string, string>();
    for (const code of ['UMUM', 'FIKSI', 'REF', 'TANDON']) types.set(code, await idOf('collection_types', code));
    const start = stockAt('2015-01-05');
    const CHUNK = 20;
    let serial = 0;
    for (let from = 0; from < n; from += CHUNK) {
      const records: Insertable<DB['records']>[] = [];
      const items: Insertable<DB['items']>[] = [];
      const events: Insertable<DB['item_events']>[] = [];
      for (let k = from; k < Math.min(n, from + CHUNK); k += 1) {
        const s = spec(k);
        const at = start + k * 60_000;
        const recordId = newId(at);
        const title = `${prefix} ${String(k).padStart(5, '0')}`;
        records.push({
          id: recordId,
          material_type_id: book,
          title,
          subtitle: null,
          responsibility: null,
          title_key: titleKey(title),
          edition: null,
          material_detail: null,
          publisher_id: null,
          publication_place: null,
          publication_year: null,
          publication_date_text: null,
          physical_desc: null,
          series: null,
          classification: `${k % 10}${(k * 3) % 10}0.${k % 89}`,
          call_number: s.callNumber ?? null,
          language_id: null,
          content_type: null,
          media_type: null,
          carrier_type: null,
          summary: null,
          notes: null,
          cover_file_id: null,
          source: 'manual',
          merged_into: null,
          changed_at: at,
          archived_at: null,
          created_at: at,
          created_by: null,
          updated_at: at,
          updated_by: null,
          audience: null,
          local_work: null,
          local_work_kind: null,
          reference_kind: null,
        });
        for (let c = 0; c < (s.copies ?? 1); c += 1) {
          serial += 1;
          const itemId = newId(at);
          items.push({
            id: itemId,
            record_id: recordId,
            branch_id: branchId,
            barcode_display: `${prefix}-${serial}`,
            barcode_key: normalizeKey(`${prefix}-${serial}`),
            inventory_no: null,
            call_number: null,
            location_id: null,
            collection_type_id: types.get(s.collectionType ?? 'UMUM')!,
            status: 'available',
            status_note: null,
            acq_source: null,
            order_no: null,
            order_date: null,
            received_date: s.received === undefined ? '2015-03-10' : s.received,
            invoice_date: null,
            supplier_id: null,
            invoice_no: null,
            price: null,
            currency: null,
            note: null,
            archived_at: null,
            created_at: at,
            created_by: null,
            updated_at: at,
            updated_by: null,
            input_on: null,
          });
          events.push({
            id: newId(at),
            item_id: itemId,
            at,
            type: s.event ?? 'created',
            from_status: null,
            to_status: 'available',
            from_location_id: null,
            to_location_id: null,
            actor_type: 'staff',
            actor_id: null,
            meta: '{"fields":[]}',
          });
        }
      }
      await h.db.insertInto('records').values(records).execute();
      await h.db.insertInto('items').values(items).execute();
      await h.db.insertInto('item_events').values(events).execute();
    }
  }

  /** The school-year period 2025/2026 of `instrumentId`, with `scanners` barcode scanners. */
  async function period(o: { instrumentId?: string; scanners?: number | null } = {}): Promise<string> {
    const id = newId(NOW);
    await h.db
      .insertInto('accred_periods')
      .values({
        id,
        branch_id: null,
        name: 'Tahun pelajaran 2025/2026',
        kind: 'school_year',
        starts_on: '2025-07-01',
        ends_on: '2026-06-30',
        instrument_id: o.instrumentId ?? 'sch-sma-2025',
        status: 'open',
        frozen_at: null,
        frozen_by: null,
        profile: '{"schoolLevel":"sma_smk_ma"}',
        students: 400,
        teachers: 30,
        edu_staff: 10,
        all_registered_confirmed: 0,
        scanners: o.scanners === undefined ? 2 : o.scanners,
        archived_at: null,
        version: 0,
        created_at: NOW,
        created_by: null,
        updated_at: NOW,
        updated_by: null,
      })
      .execute();
    return id;
  }

  async function metricCtx(periodId: string, o: { settings?: AccredSettings; budget?: () => number } = {}): Promise<AccredMetricContext> {
    const p = await h.db.selectFrom('accred_periods').selectAll().where('id', '=', periodId).executeTakeFirstOrThrow();
    const instrument = instrumentById(p.instrument_id)!;
    return {
      db: h.db,
      periodId,
      period: p,
      profile: readProfile(p.profile),
      instrument,
      D,
      today: TODAY,
      settings: o.settings ?? base,
      baseUrl: null,
      now: NOW,
      budgetLeftMs: o.budget ?? (() => 60_000),
      paramsOf: paramsFrom(instrument),
    };
  }

  /** Every slice of the provider for `ids` until it is done (each resume passed on as JSON, as the job keeps it). */
  async function run(c: AccredMetricContext, ids: readonly AccredMetricId[] = ALL): Promise<{ values: Map<AccredMetricId, AccredMetricValue>; resumes: ProviderResume[] }> {
    const resumes: ProviderResume[] = [];
    let resume: ProviderResume | null = null;
    for (let slice = 0; slice < 200; slice += 1) {
      const step = await collectionProvider.compute(c, ids, resume);
      if (step.done) {
        expect([...step.values.keys()].sort()).toEqual([...ids].sort());
        return { values: new Map(step.values), resumes };
      }
      resumes.push(step.resume);
      resume = JSON.parse(JSON.stringify(step.resume)) as ProviderResume;
    }
    throw new Error('the pass did not end');
  }

  async function value(periodId: string, id: AccredMetricId, o: { settings?: AccredSettings } = {}): Promise<AccredMetricValue> {
    return (await run(await metricCtx(periodId, o), [id])).values.get(id)!;
  }

  describe('on the stock fixture', () => {
    let fx: StockFixture;
    let periodId: string;

    beforeAll(async () => {
      await clearCatalogue();
      fx = await seedStockFixture(h.db, { branchId });
      periodId = await period();
    });

    it('titles at D: nine in stock, with the electronic titles without copies, the placeholder and the undated copies as facts and notes', async () => {
      const v = await value(periodId, 'collection.titles');
      expect(v).toEqual({
        value: 9,
        unit: 'count',
        basis: 'live',
        notes: [
          { key: 'accred.note.electronic_counted', params: { count: 2 } },
          { key: 'accred.note.replacement_records', params: { count: 1 } },
          { key: 'accred.note.items_without_received_date', params: { count: 3 } },
        ],
        detail: { reportId: 'collection.title_list', params: { asOf: D } },
        facts: { electronicNoItems: 2, replacementRecords: 1, undatedItems: 3 },
      });
    });

    it('live and undated copies at D', async () => {
      const values = (await run(await metricCtx(periodId), ['collection.live_items', 'collection.undated_items'])).values;
      expect(values.get('collection.live_items')).toMatchObject({ value: 7, unit: 'count' });
      expect(values.get('collection.undated_items')).toMatchObject({
        value: 3,
        notes: [{ key: 'accred.note.items_without_received_date', params: { count: 3 } }],
        facts: { live: 7, pct: 42 },
      });
    });

    it('additions of 2024–2026 against the stock of 2023-12-31: copies the migration dated by its own clock never count, and many undated copies stop the suggestion', async () => {
      const values = (await run(await metricCtx(periodId), ['collection.titles_window_start', 'collection.title_additions_3y_pct'])).values;
      expect(values.get('collection.titles_window_start')).toMatchObject({ value: 8, unit: 'count' });
      // 2024: the received copy and the e-book; 2025: the copy made here and the title with a public file. The record
      // the migration created on 2025-09-01 (empty input date) and the placeholder of the orphan copy are undated.
      expect(values.get('collection.title_additions_3y_pct')).toEqual({
        value: 50,
        numerator: 4,
        denominator: 8,
        unit: 'percent',
        basis: 'live',
        notes: [
          { key: 'accred.note.items_without_received_date', params: { count: 3 } },
          { key: 'accred.note.undated_share_high', params: { pct: 42, max: 10 } },
        ],
        detail: { reportId: 'accreditation.annex.additions', params: { periodId } },
        table: [
          ['2023-12-31', 8],
          [2024, 2],
          [2025, 2],
          [2026, 0],
        ],
        facts: { undated: 3, live: 7 },
        suggest: false,
      });
    });

    it('a title whose only copy is on order is never an addition', async () => {
      const before = await value(periodId, 'collection.title_additions_3y_pct');
      const ordered = await addTitle(h.db, branchId, {
        title: 'Biologi Kelas XI',
        classification: '570',
        createdAt: stockAt('2025-05-05'),
        items: [{ barcode: 'ORD-0001', status: 'on_order', createdAt: stockAt('2025-05-05') }],
      });
      try {
        const after = await value(periodId, 'collection.title_additions_3y_pct');
        expect([after.value, after.numerator, after.denominator, after.table]).toEqual([before.value, before.numerator, before.denominator, before.table]);
      } finally {
        await h.db.deleteFrom('item_events').where('item_id', 'in', ordered.itemIds).execute();
        await h.db.deleteFrom('items').where('id', 'in', ordered.itemIds).execute();
        await h.db.deleteFrom('records').where('id', '=', ordered.recordId).execute();
      }
    });

    /** Replaces the history of copy `itemId` by `entries` (local dates in the fixture's time zone). */
    async function history(itemId: string, entries: readonly { on: string; type: 'created' | 'imported' | 'migrated' | 'status' | 'archived'; to: string }[]): Promise<void> {
      await h.db.deleteFrom('item_events').where('item_id', '=', itemId).execute();
      for (const e of entries) {
        await h.db
          .insertInto('item_events')
          .values({
            id: newId(stockAt(e.on)),
            item_id: itemId,
            at: stockAt(e.on),
            type: e.type,
            from_status: null,
            to_status: e.to,
            from_location_id: null,
            to_location_id: null,
            actor_type: 'staff',
            actor_id: null,
            meta: JSON.stringify({ fields: ['status'] }),
          })
          .execute();
      }
    }

    async function removeTitles(titles: readonly { recordId: string; itemIds: string[] }[]): Promise<void> {
      for (const t of titles) {
        await h.db.deleteFrom('item_events').where('item_id', 'in', t.itemIds).execute();
        await h.db.deleteFrom('items').where('id', 'in', t.itemIds).execute();
        await h.db.deleteFrom('records').where('id', '=', t.recordId).execute();
      }
    }

    async function k6Values(): Promise<{ start: number | null; added: AccredMetricValue }> {
      const values = (await run(await metricCtx(periodId), ['collection.titles_window_start', 'collection.title_additions_3y_pct'])).values;
      return { start: values.get('collection.titles_window_start')!.value, added: values.get('collection.title_additions_3y_pct')! };
    }

    it('a title weeded in 2025 and archived after its copy still counts in the stock of 2023-12-31', async () => {
      const weeded = await addTitle(h.db, branchId, {
        title: 'Kimia Kurikulum Lama',
        classification: '540',
        createdAt: stockAt('2018-05-02'),
        archivedAt: stockAt('2025-03-02'),
        items: [{ barcode: 'WED-0001', status: 'withdrawn', receivedDate: '2018-05-01', createdAt: stockAt('2018-05-02'), archivedAt: stockAt('2025-03-01') }],
      });
      try {
        await history(weeded.itemIds[0]!, [
          { on: '2018-05-02', type: 'created', to: 'available' },
          { on: '2025-03-01', type: 'archived', to: 'withdrawn' },
        ]);
        const { start, added } = await k6Values();
        expect(start).toBe(9);
        expect([added.numerator, added.denominator, added.table]).toEqual([
          4,
          9,
          [
            ['2023-12-31', 9],
            [2024, 2],
            [2025, 2],
            [2026, 0],
          ],
        ]);
        // Not in the stock at D, after its archive.
        expect((await value(periodId, 'collection.titles')).value).toBe(9);
      } finally {
        await removeTitles([weeded]);
      }
    });

    it('a title acquired in 2024 and weeded and archived in 2025 is an addition of 2024; a title merged into another never is', async () => {
      const weeded = await addTitle(h.db, branchId, {
        title: 'Fisika Edisi Lama',
        classification: '530',
        createdAt: stockAt('2024-06-02'),
        archivedAt: stockAt('2025-08-02'),
        items: [{ barcode: 'WED-0003', status: 'withdrawn', receivedDate: '2024-06-01', createdAt: stockAt('2024-06-02'), archivedAt: stockAt('2025-08-01') }],
      });
      const merged = await addTitle(h.db, branchId, {
        title: 'Fisika Edisi Lama (duplikat)',
        classification: '530',
        createdAt: stockAt('2024-07-02'),
        archivedAt: stockAt('2025-01-10'),
        items: [{ barcode: 'MRG-0001', status: 'withdrawn', receivedDate: '2024-07-01', createdAt: stockAt('2024-07-02'), archivedAt: stockAt('2025-01-10') }],
      });
      try {
        await history(weeded.itemIds[0]!, [
          { on: '2024-06-02', type: 'created', to: 'available' },
          { on: '2025-08-01', type: 'archived', to: 'withdrawn' },
        ]);
        await history(merged.itemIds[0]!, [
          { on: '2024-07-02', type: 'created', to: 'available' },
          { on: '2025-01-10', type: 'archived', to: 'withdrawn' },
        ]);
        await h.db.updateTable('records').set({ merged_into: weeded.recordId }).where('id', '=', merged.recordId).execute();
        const { start, added } = await k6Values();
        expect(start).toBe(8);
        expect([added.numerator, added.denominator, added.table]).toEqual([
          5,
          8,
          [
            ['2023-12-31', 8],
            [2024, 3],
            [2025, 2],
            [2026, 0],
          ],
        ]);
        // Neither is in the stock at D.
        expect((await value(periodId, 'collection.titles')).value).toBe(9);
      } finally {
        await h.db.updateTable('records').set({ merged_into: null }).where('id', '=', merged.recordId).execute();
        await removeTitles([merged, weeded]);
      }
    });

    it('a copy weeded in SLiMS before the migration is not in the stock of 2023-12-31', async () => {
      const migratedAt = stockAt('2025-09-01', '09:00');
      const weeded = await addTitle(h.db, branchId, {
        title: 'Sejarah Lama',
        classification: '959',
        createdAt: stockAt('2015-03-02'),
        items: [{ barcode: 'WED-0002', status: 'withdrawn', inputOn: '2015-03-01', createdAt: migratedAt, archivedAt: migratedAt, event: 'migrated' }],
      });
      try {
        const { start, added } = await k6Values();
        expect(start).toBe(8);
        expect(added.table).toEqual([
          ['2023-12-31', 8],
          [2024, 2],
          [2025, 2],
          [2026, 0],
        ]);
      } finally {
        await removeTitles([weeded]);
      }
    });

    it('an order cancelled before it arrived is no addition; a copy ordered in 2024 and received in 2025 is an addition of 2025', async () => {
      const cancelled = await addTitle(h.db, branchId, {
        title: 'Fisika Kelas XII',
        classification: '530',
        createdAt: stockAt('2025-03-01'),
        items: [{ barcode: 'ORD-0002', status: 'withdrawn', createdAt: stockAt('2025-03-01'), archivedAt: stockAt('2025-05-01') }],
      });
      const late = await addTitle(h.db, branchId, {
        title: 'Geografi Kelas X',
        classification: '910',
        createdAt: stockAt('2024-12-10'),
        items: [{ barcode: 'ORD-0003', status: 'available', createdAt: stockAt('2024-12-10') }],
      });
      try {
        await history(cancelled.itemIds[0]!, [
          { on: '2025-03-01', type: 'created', to: 'on_order' },
          { on: '2025-05-01', type: 'archived', to: 'withdrawn' },
        ]);
        await history(late.itemIds[0]!, [
          { on: '2024-12-10', type: 'created', to: 'on_order' },
          { on: '2025-01-20', type: 'status', to: 'available' },
        ]);
        const { start, added } = await k6Values();
        expect(start).toBe(8);
        expect([added.numerator, added.table]).toEqual([
          5,
          [
            ['2023-12-31', 8],
            [2024, 2],
            [2025, 3],
            [2026, 0],
          ],
        ]);
      } finally {
        await removeTitles([cancelled, late]);
      }
    });

    it('a copy a catalogue import brought in on order and that arrived in 2025 is an addition of 2025, not missing from both sides', async () => {
      const imported = await addTitle(h.db, branchId, {
        title: 'Ekonomi Kelas XI',
        classification: '330',
        createdAt: stockAt('2024-11-05'),
        items: [{ barcode: 'IMP-0001', status: 'available', createdAt: stockAt('2024-11-05'), event: 'imported' }],
      });
      try {
        await history(imported.itemIds[0]!, [
          { on: '2024-11-05', type: 'imported', to: 'on_order' },
          { on: '2025-02-10', type: 'status', to: 'available' },
        ]);
        const { start, added } = await k6Values();
        expect(start).toBe(8);
        expect([added.numerator, added.denominator, added.table]).toEqual([
          5,
          8,
          [
            ['2023-12-31', 8],
            [2024, 2],
            [2025, 3],
            [2026, 0],
          ],
        ]);
        expect((await value(periodId, 'collection.titles')).value).toBe(10);
      } finally {
        await removeTitles([imported]);
      }
    });

    it('the printed titles by DDC class: the e-book is left out', async () => {
      const v = await value(periodId, 'collection.ddc_printed_recap');
      expect(v.value).toBe(8);
      const table = new Map((v.table ?? []).map((row) => [row[0], [row[1], row[2]]]));
      expect(table.get('000')).toEqual([1, 1]);
      expect(table.get('030')).toEqual([1, 1]);
      expect(table.get('2X')).toEqual([1, 1]);
      expect(table.get('NON')).toEqual([2, 2]);
      expect(table.get('500')).toEqual([1, 0]);
      expect(fx.records.ebook).toBeTruthy();
    });

    it('the collection by medium and kind', async () => {
      const v = await value(periodId, 'collection.profile_matrix');
      expect(v.value).toBe(9);
      expect(v.table).toEqual([
        ['print', 'fiction', 0, 0],
        ['print', 'nonfiction', 7, 6],
        ['print', 'reference', 1, 1],
        ['electronic', 'fiction', 0, 0],
        ['electronic', 'nonfiction', 1, 0],
        ['electronic', 'reference', 0, 0],
      ]);
    });
  });

  describe('a thousand titles', () => {
    let periodId: string;

    beforeAll(async () => {
      await clearCatalogue();
      // 200 titles with two copies (1 200 copies), 250 fiction titles, and one title whose call number starts with F.
      await seedTitles(1000, 'SERIBU', (k) => ({
        copies: k < 200 ? 2 : 1,
        collectionType: k >= 200 && k < 450 ? 'FIKSI' : 'UMUM',
        callNumber: k === 999 ? 'F 813 KIS' : null,
      }));
      periodId = await period();
    });

    beforeEach(async () => {
      await h.db.deleteFrom('usage_stats').execute();
    });

    async function used(metric: 'titles_used' | 'items_used', n: number): Promise<void> {
      await h.db
        .insertInto('usage_stats')
        .values({ source: 'manual', metric, span_from: '2025-07-01', span_to: '2026-06-30', branch_key: '', group_key: '', value: n, run_id: null, updated_at: NOW, updated_by: null })
        .execute();
    }

    it('exactly 1 000 titles in stock', async () => {
      const v = await value(periodId, 'collection.titles');
      expect(v).toMatchObject({ value: 1000, notes: [], facts: { electronicNoItems: 0, replacementRecords: 0, undatedItems: 0 } });
      expect((await value(periodId, 'collection.live_items')).value).toBe(1200);
    });

    it('fiction 250 of 1 000 titles → 25, by the fiction collection type; a call number prefix adds its titles', async () => {
      expect(await value(periodId, 'collection.fiction_pct')).toEqual({
        value: 25,
        numerator: 250,
        denominator: 1000,
        unit: 'percent',
        basis: 'live',
        notes: [],
        detail: { reportId: 'collection.title_list', params: { asOf: D, fictionOnly: true } },
        facts: { rule: 'tipe koleksi FIKSI' },
      });
      const withPrefix = await value(periodId, 'collection.fiction_pct', { settings: { ...base, fiction: { ...base.fiction, callNumberPrefixes: ['F'] } } });
      expect([withPrefix.value, withPrefix.numerator]).toEqual([25, 251]);
      expect(withPrefix.notes).toEqual([{ key: 'accred.note.truncated' }]);
      expect(withPrefix.facts).toEqual({ rule: 'tipe koleksi FIKSI atau nomor panggil berawalan F' });
    });

    it('the collection used: 250 titles used of 1 000 → 25; per copy, 300 of 1 200 → 25', async () => {
      await used('titles_used', 250);
      await used('items_used', 300);
      expect(await value(periodId, 'usage.collection_used_pct')).toEqual({
        value: 25,
        numerator: 250,
        denominator: 1000,
        unit: 'percent',
        basis: 'manual',
        notes: [{ key: 'accred.note.usage_unit', params: { unit: 'judul' } }],
        facts: { unit: 'titles', used: 250, base: 1000 },
      });
      const items = await value(periodId, 'usage.collection_used_pct', { settings: { ...base, usedUnit: 'items' } });
      expect(items).toMatchObject({ value: 25, numerator: 300, denominator: 1200, facts: { unit: 'items', used: 300, base: 1200 } });
      expect(items.notes).toEqual([{ key: 'accred.note.usage_unit', params: { unit: 'eksemplar' } }]);
    });

    it('the collection used without a figure for the period: no value', async () => {
      expect(await value(periodId, 'usage.collection_used_pct')).toEqual({
        value: null,
        unit: 'percent',
        basis: 'none',
        notes: [{ key: 'accred.note.usage_unit', params: { unit: 'judul' } }, { key: 'accred.note.usage_no_data' }],
        facts: { unit: 'titles', used: null, base: 1000 },
      });
    });

    it('one pass split over three slices by a tiny budget gives the values of one slice', async () => {
      await used('titles_used', 250);
      const whole = await run(await metricCtx(periodId), [...ALL]);
      expect(whole.resumes).toEqual([]);
      const sliced = await run(await metricCtx(periodId, { budget: () => 0 }), [...ALL]);
      expect(sliced.resumes).toHaveLength(2);
      for (const r of sliced.resumes) {
        expect(typeof r.cursor).toBe('string');
        expect(new TextEncoder().encode(JSON.stringify(r.state)).length).toBeLessThanOrEqual(32_000);
      }
      expect(sliced.values).toEqual(whole.values);
    });
  });

  describe('additions of the three calendar years', () => {
    let periodId: string;

    /** `start` titles received in 2020, `undated` titles imported without dates, `added` titles received in 2024–2026. */
    async function catalogue(o: { start: number; added: number; undated?: number }): Promise<void> {
      await clearCatalogue();
      await seedTitles(o.start, 'AWAL', () => ({ received: '2020-03-03' }));
      await seedTitles(o.undated ?? 0, 'TANPA', () => ({ received: null, event: 'imported' }));
      await seedTitles(o.added, 'BARU', (k) => ({ received: ['2024-02-02', '2025-02-02', '2026-02-02'][k % 3]! }));
      periodId = await period();
    }

    async function k6(): Promise<{ value: AccredMetricValue; size: AccredMetricValue }> {
      const values = (await run(await metricCtx(periodId), ['collection.title_additions_3y_pct', 'collection.titles_window_start'])).values;
      return { value: values.get('collection.title_additions_3y_pct')!, size: values.get('collection.titles_window_start')! };
    }

    it('start 1 500 and 500 additions → 33, the band chosen from a size of 1 500', async () => {
      await catalogue({ start: 1500, added: 500 });
      const { value: v, size } = await k6();
      expect([v.value, v.numerator, v.denominator, size.value]).toEqual([33, 500, 1500, 1500]);
      expect(v.table).toEqual([
        ['2023-12-31', 1500],
        [2024, 167],
        [2025, 167],
        [2026, 166],
      ]);
      expect(v.suggest).toBeUndefined();
      expect(v.notes).toEqual([{ key: 'accred.note.truncated' }]);
    });

    it('start 1 501 and 375 additions → 24', async () => {
      await catalogue({ start: 1501, added: 375 });
      const { value: v, size } = await k6();
      expect([v.value, size.value]).toEqual([24, 1501]);
    });

    it('start 2 000: 360 additions → 18, 380 → 19', async () => {
      await catalogue({ start: 2000, added: 360 });
      expect((await k6()).value.value).toBe(18);
      await seedTitles(20, 'LAGI', () => ({ received: '2025-08-08' }));
      const { value: v, size } = await k6();
      expect([v.value, v.numerator, size.value]).toEqual([19, 380, 2000]);
    });

    it('121 undated of 1 200 live copies: no suggestion, for the three years and for the period', async () => {
      await catalogue({ start: 1079, undated: 121, added: 0 });
      const values = (await run(await metricCtx(periodId), ['collection.title_additions_3y_pct', 'collection.title_additions_period_pct'])).values;
      const threeYears = values.get('collection.title_additions_3y_pct')!;
      expect(threeYears).toMatchObject({ value: 0, suggest: false, facts: { undated: 121, live: 1200 } });
      expect(threeYears.notes).toEqual([
        { key: 'accred.note.items_without_received_date', params: { count: 121 } },
        { key: 'accred.note.undated_share_high', params: { pct: 10, max: 10 } },
      ]);
      const inPeriod = values.get('collection.title_additions_period_pct')!;
      expect(inPeriod).toMatchObject({ value: 0, suggest: false, facts: { undated: 121, live: 1200 } });
      expect(inPeriod.notes).toContainEqual({ key: 'accred.note.items_without_received_date', params: { count: 121 } });
    });

    it('120 undated of 1 200 live copies: the suggestion stays', async () => {
      await catalogue({ start: 1080, undated: 120, added: 0 });
      const values = (await run(await metricCtx(periodId), ['collection.title_additions_3y_pct', 'collection.title_additions_period_pct'])).values;
      for (const v of values.values()) {
        expect(v.suggest).toBeUndefined();
        expect(v.notes.map((n) => n.key)).not.toContain('accred.note.undated_share_high');
        expect(v.notes).toContainEqual({ key: 'accred.note.items_without_received_date', params: { count: 120 } });
      }
    });

    it('the additions of the period against the stock of the day before it starts', async () => {
      await catalogue({ start: 1000, added: 0 });
      await seedTitles(90, 'PERIODE', (k) => ({ received: k < 60 ? '2025-07-01' : '2026-06-30' }));
      await seedTitles(5, 'SEBELUM', () => ({ received: '2025-06-30' }));
      await seedTitles(4, 'SESUDAH', () => ({ received: '2026-07-01' }));
      const values = (await run(await metricCtx(periodId), ['collection.titles_period_start', 'collection.title_additions_period_pct'])).values;
      expect(values.get('collection.titles_period_start')?.value).toBe(1005);
      expect(values.get('collection.title_additions_period_pct')).toMatchObject({ value: 8, numerator: 90, denominator: 1005, unit: 'percent' });
    });

    it('no title at the start of the window → no value', async () => {
      await catalogue({ start: 0, added: 12 });
      const { value: v, size } = await k6();
      expect(size.value).toBe(0);
      expect(v.value).toBeNull();
      expect(v.notes).toContainEqual({ key: 'accred.note.k6_no_start' });
      expect(v.table).toEqual([
        ['2023-12-31', 0],
        [2024, 4],
        [2025, 4],
        [2026, 4],
      ]);
    });
  });

  describe('small catalogues', () => {
    beforeEach(async () => {
      await clearCatalogue();
    });

    it('processing: the facts the rule reads, live, processed, threshold and scanners', async () => {
      const room = await addLocation(h.db, branchId, 'RB-K7', 'Ruang baca');
      const copy = (barcode: string, o: { callNumber?: string | null; locationId?: string | null } = {}) => ({
        barcode,
        receivedDate: '2024-04-04',
        callNumber: o.callNumber === undefined ? '510 ABC m' : o.callNumber,
        locationId: o.locationId === undefined ? room : o.locationId,
      });
      await addTitle(h.db, branchId, { title: 'Lengkap', classification: '510', items: [copy('K7-1')] });
      await addTitle(h.db, branchId, { title: 'Nomor panggil di cantuman', classification: '510', callNumber: '510 ABC n', items: [copy('K7-2', { callNumber: null })] });
      await addTitle(h.db, branchId, { title: 'Tanpa lokasi', classification: '510', items: [copy('K7-3', { locationId: null })] });
      await addTitle(h.db, branchId, { title: 'Tanpa klasifikasi', classification: null, items: [copy('K7-4')] });
      const periodId = await period({ scanners: 2 });
      expect(await value(periodId, 'collection.k7_organisation')).toEqual({
        value: 50,
        numerator: 2,
        denominator: 4,
        unit: 'percent',
        basis: 'live',
        notes: [],
        detail: { reportId: 'collection.data_quality', params: {} },
        facts: { live: 4, processed: 2, threshold: 100, scanners: 2 },
      });
      const lowered = await value(periodId, 'collection.k7_organisation', { settings: { ...base, k7ThresholdPct: 90 } });
      expect(lowered.facts).toEqual({ live: 4, processed: 2, threshold: 90, scanners: 2 });
    });

    it('processing without any copy: no value', async () => {
      const periodId = await period({ scanners: null });
      expect(await value(periodId, 'collection.k7_organisation')).toMatchObject({
        value: null,
        notes: [{ key: 'accred.note.collection_empty' }],
        facts: { live: 0, processed: 0, threshold: 100, scanners: null },
      });
    });

    it('local works: four kinds by students, the elementary instrument counts three, the upper secondary four', async () => {
      const kinds = ['written_work', 'clipping', 'poetry', 'abstract'];
      for (const [n, kind] of kinds.entries()) {
        const t = await addTitle(h.db, branchId, { title: `Karya siswa ${n}`, items: [{ barcode: `LW-${n}` }] });
        await h.db.updateTable('records').set({ local_work: 'student', local_work_kind: kind }).where('id', '=', t.recordId).execute();
      }
      // A local author's work and an archived student work do not count.
      const local = await addTitle(h.db, branchId, { title: 'Karya penulis lokal', items: [{ barcode: 'LW-L' }] });
      await h.db.updateTable('records').set({ local_work: 'local', local_work_kind: 'review' }).where('id', '=', local.recordId).execute();
      const gone = await addTitle(h.db, branchId, { title: 'Karya lama', archivedAt: stockAt('2025-01-01'), items: [{ barcode: 'LW-A', archivedAt: stockAt('2025-01-01') }] });
      await h.db.updateTable('records').set({ local_work: 'student', local_work_kind: 'short_stories' }).where('id', '=', gone.recordId).execute();

      const sd = await value(await period({ instrumentId: 'sch-sd-2025' }), 'collection.local_work_kinds');
      expect(sd).toMatchObject({
        value: 3,
        unit: 'count',
        notes: [],
        detail: { reportId: 'collection.title_list', params: { asOf: D, localWorkOnly: true } },
        facts: { elements: ['written_work', 'clipping', 'poetry'] },
      });
      const sma = await value(await period({ instrumentId: 'sch-sma-2025' }), 'collection.local_work_kinds');
      expect(sma).toMatchObject({ value: 4, facts: { elements: ['written_work', 'clipping', 'poetry', 'abstract'] } });
    });

    it('local works when no record has a kind: no value, answered by hand', async () => {
      const t = await addTitle(h.db, branchId, { title: 'Karya tanpa jenis', items: [{ barcode: 'LW-0' }] });
      await h.db.updateTable('records').set({ local_work: 'student' }).where('id', '=', t.recordId).execute();
      expect(await value(await period(), 'collection.local_work_kinds')).toMatchObject({ value: null, notes: [{ key: 'accred.note.l6_manual' }] });
    });

    it('enrichment titles with an empty textbook setting, and with a textbook collection type', async () => {
      for (let n = 0; n < 3; n += 1) await addTitle(h.db, branchId, { title: `Novel ${n}`, items: [{ barcode: `EN-F${n}`, collectionType: 'FIKSI' }] });
      for (let n = 0; n < 5; n += 1) await addTitle(h.db, branchId, { title: `Pengetahuan ${n}`, items: [{ barcode: `EN-U${n}` }] });
      for (let n = 0; n < 2; n += 1) await addTitle(h.db, branchId, { title: `Kamus ${n}`, items: [{ barcode: `EN-R${n}`, collectionType: 'REF' }] });
      for (let n = 0; n < 2; n += 1) await addTitle(h.db, branchId, { title: `Buku teks ${n}`, items: [{ barcode: `EN-T${n}`, collectionType: 'TANDON' }] });
      await addTitle(h.db, branchId, { title: 'Buku elektronik', materialType: 'EBOOK' });
      const periodId = await period();
      const ids: AccredMetricId[] = ['collection.enrichment_fiction_pct', 'collection.enrichment_titles'];
      const empty = (await run(await metricCtx(periodId), ids)).values;
      expect(empty.get('collection.enrichment_fiction_pct')).toMatchObject({
        value: 27,
        numerator: 3,
        denominator: 11,
        facts: { fiction: 3, enrichment: 11 },
      });
      expect(empty.get('collection.enrichment_fiction_pct')?.notes).toContainEqual({ key: 'accred.note.snp_textbook_default' });
      expect(empty.get('collection.enrichment_titles')).toMatchObject({ value: 11, notes: [{ key: 'accred.note.snp_textbook_default' }] });
      const textbooks = (await run(await metricCtx(periodId, { settings: { ...base, textbookCollectionTypeCodes: ['TANDON'] } }), ids)).values;
      expect(textbooks.get('collection.enrichment_fiction_pct')).toMatchObject({ value: 33, numerator: 3, denominator: 9 });
      expect(textbooks.get('collection.enrichment_titles')).toMatchObject({ value: 9, notes: [] });
    });

    it('the reference kinds in stock, the named ones among them', async () => {
      const kinds = ['globe', 'encyclopedia', 'biography', 'dictionary', 'handbook'];
      for (const [n, kind] of kinds.entries()) {
        const t = await addTitle(h.db, branchId, { title: `Referensi ${n}`, items: [{ barcode: `RK-${n}`, collectionType: 'REF' }] });
        await h.db.updateTable('records').set({ reference_kind: kind }).where('id', '=', t.recordId).execute();
      }
      const gone = await addTitle(h.db, branchId, { title: 'Atlas lama', archivedAt: stockAt('2025-01-01'), items: [{ barcode: 'RK-A', archivedAt: stockAt('2025-01-01') }] });
      await h.db.updateTable('records').set({ reference_kind: 'atlas' }).where('id', '=', gone.recordId).execute();
      const v = await value(await period(), 'collection.reference_kinds');
      expect(v).toMatchObject({ value: 5, unit: 'count', facts: { elements: ['encyclopedia', 'dictionary', 'handbook', 'globe', 'biography'] } });
      // The upper secondary standard names the four primary kinds and biographies, and asks for five kinds.
      const standard = instrumentById('sch-sma-2025')!.snp.find((s) => s.code === 'SNP-S-04')!;
      expect(evaluateSnp(standard, v, null, null).outcome).toBe('pass');
      await h.db.updateTable('records').set({ reference_kind: 'atlas' }).where('reference_kind', '=', 'biography').execute();
      const withoutBiography = await value(await period(), 'collection.reference_kinds');
      expect(withoutBiography).toMatchObject({ value: 5, facts: { elements: ['encyclopedia', 'dictionary', 'handbook', 'atlas', 'globe'] } });
      expect(evaluateSnp(standard, withoutBiography, null, null).outcome).toBe('fail');
    });

    it('serial titles with a copy received in the twelve months to D', async () => {
      const serial = (title: string, receivedDate: string | null, status?: string) =>
        addTitle(h.db, branchId, { title, materialType: 'BERSERI', items: [{ barcode: `SR-${title}`, receivedDate, status, createdAt: stockAt('2025-12-01') }] });
      await serial('Majalah A', '2025-07-01');
      await serial('Majalah B', '2025-06-30');
      await serial('Majalah C', '2026-06-30');
      await serial('Majalah D', null, 'on_order');
      await addTitle(h.db, branchId, { title: 'Buku biasa', items: [{ barcode: 'SR-BUKU', receivedDate: '2026-01-01' }] });
      expect(await value(await period(), 'collection.serial_titles_recent')).toMatchObject({
        value: 2,
        unit: 'count',
        notes: [{ key: 'accred.note.snp_serials_approx' }],
      });
    });
  });
});
