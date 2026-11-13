import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PHASE1_MIGRATIONS, runMigrations, type DB } from '@altis/db';
import { newId, normalizeKey, type Locale } from '@altis/shared';
import type { Insertable, Kysely } from 'kysely';
import { testDb, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { titleKey } from '../../src/catalog/lib/title-key.js';
import type { ReportCtx, ReportRow, TableReport } from '../../src/reports/types.js';
import { loadAccredSettings, type AccredSettings } from '../../src/settings/accreditation.js';
import { STOCK_TZ, seedStockFixture, stockAt, type StockFixture } from '../support/stock-fixture.js';

// What the collection reports' tests share (report-collection-*.test.ts): a migrated database (with the stock fixture
// or without it), writers for a test's own titles and copies, a report context at a fixed "today", and a reader that
// drains a report page by page as the preview and the export do.

/** The day the tests read "today" as (the stock fixture's last event is earlier). */
export const TODAY = '2026-06-30';
export const NOW = stockAt(TODAY, '12:00');

export interface CollectionDb {
  h: TestDbHandle;
  db: Kysely<DB>;
  /** The stock fixture, when the database has it. */
  fx: StockFixture | null;
  branchId: string;
  settings: AccredSettings;
  close(): Promise<void>;
}

/** A migrated database, with the stock fixture unless `fixture` is false (then a branch of its own). */
export async function openCollectionDb(prefix: string, o: { fixture?: boolean } = {}): Promise<CollectionDb> {
  const h = await testDb();
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), `altis-${prefix}-`));
  await runMigrations(h, { appVersion: '0.1.0', dataDir: path.join(root, 'migrations'), migrations: PHASE1_MIGRATIONS });
  let fx: StockFixture | null = null;
  let branchId: string;
  if (o.fixture === false) {
    const at = stockAt('2017-01-02');
    branchId = newId(at);
    await h.db
      .insertInto('branches')
      .values({ id: branchId, code_key: 'KOL', code_display: 'KOL', name: 'Cabang Koleksi', address: null, timezone: STOCK_TZ, is_default: 0, created_at: at, created_by: null, updated_at: at, updated_by: null })
      .execute();
  } else {
    fx = await seedStockFixture(h.db);
    branchId = fx.branchId;
  }
  const settings = await loadAccredSettings(h.db);
  return {
    h,
    db: h.db,
    fx,
    branchId,
    settings,
    async close() {
      await h.close();
      await fsp.rm(root, { recursive: true, force: true });
    },
  };
}

/** One copy of a test title. */
export interface CopySeed {
  barcode: string;
  /** A collection type code (default `UMUM`). */
  collectionType?: string;
  status?: string;
  receivedDate?: string | null;
  inputOn?: string | null;
  inventoryNo?: string | null;
  callNumber?: string | null;
  locationId?: string | null;
  supplierId?: string | null;
  branchId?: string;
  price?: number | null;
  acqSource?: string | null;
  createdAt?: number;
  archivedAt?: number | null;
  /** The type of its first history row (default `created`); null: no history at all. */
  event?: 'created' | 'imported' | 'migrated' | null;
}

/** A test title and its copies. */
export interface TitleSeed {
  title: string;
  subtitle?: string | null;
  responsibility?: string | null;
  /** A material type code (default `BUKU`). */
  materialType?: string;
  classification?: string | null;
  callNumber?: string | null;
  /** A language code (`ind`, `eng`, …). */
  language?: string | null;
  audience?: string | null;
  localWork?: string | null;
  localWorkKind?: string | null;
  edition?: string | null;
  place?: string | null;
  year?: string | null;
  physicalDesc?: string | null;
  createdAt?: number;
  archivedAt?: number | null;
  items?: readonly CopySeed[];
}

async function idByCode(db: Kysely<DB>, table: 'material_types' | 'collection_types' | 'languages', code: string): Promise<string> {
  return (await db.selectFrom(table).select('id').where('code_key', '=', normalizeKey(code)).executeTakeFirstOrThrow()).id;
}

function recordRow(id: string, materialTypeId: string, languageId: string | null, s: TitleSeed): Insertable<DB['records']> {
  const at = s.createdAt ?? stockAt('2024-01-10');
  return {
    id,
    material_type_id: materialTypeId,
    title: s.title,
    subtitle: s.subtitle ?? null,
    responsibility: s.responsibility ?? null,
    title_key: titleKey(s.title),
    edition: s.edition ?? null,
    material_detail: null,
    publisher_id: null,
    publication_place: s.place ?? null,
    publication_year: s.year ?? null,
    publication_date_text: null,
    physical_desc: s.physicalDesc ?? null,
    series: null,
    classification: s.classification ?? null,
    call_number: s.callNumber ?? null,
    language_id: languageId,
    content_type: null,
    media_type: null,
    carrier_type: null,
    summary: null,
    notes: null,
    cover_file_id: null,
    source: 'manual',
    merged_into: null,
    changed_at: at,
    archived_at: s.archivedAt ?? null,
    created_at: at,
    created_by: null,
    updated_at: at,
    updated_by: null,
    audience: s.audience ?? null,
    local_work: s.localWork ?? null,
    local_work_kind: s.localWorkKind ?? null,
    reference_kind: null,
  };
}

function itemRow(id: string, recordId: string, branchId: string, collectionTypeId: string, c: CopySeed): Insertable<DB['items']> {
  const at = c.createdAt ?? stockAt('2024-01-10');
  return {
    id,
    record_id: recordId,
    branch_id: c.branchId ?? branchId,
    barcode_display: c.barcode,
    barcode_key: normalizeKey(c.barcode),
    inventory_no: c.inventoryNo ?? null,
    call_number: c.callNumber ?? null,
    location_id: c.locationId ?? null,
    collection_type_id: collectionTypeId,
    status: c.status ?? 'available',
    status_note: null,
    acq_source: c.acqSource ?? null,
    order_no: null,
    order_date: null,
    received_date: c.receivedDate ?? null,
    invoice_date: null,
    supplier_id: c.supplierId ?? null,
    invoice_no: null,
    price: c.price ?? null,
    currency: c.price === undefined || c.price === null ? null : 'IDR',
    note: null,
    archived_at: c.archivedAt ?? null,
    created_at: at,
    created_by: null,
    updated_at: at,
    updated_by: null,
    input_on: c.inputOn ?? null,
  };
}

/** Writes a test title with its copies (and each copy's first history row); answers their ids. */
export async function addTitle(db: Kysely<DB>, branchId: string, s: TitleSeed): Promise<{ recordId: string; itemIds: string[] }> {
  const at = s.createdAt ?? stockAt('2024-01-10');
  const recordId = newId(at);
  const languageId = s.language === undefined || s.language === null ? null : await idByCode(db, 'languages', s.language);
  await db.insertInto('records').values(recordRow(recordId, await idByCode(db, 'material_types', s.materialType ?? 'BUKU'), languageId, s)).execute();
  const itemIds: string[] = [];
  for (const c of s.items ?? []) {
    const id = newId(c.createdAt ?? at);
    await db.insertInto('items').values(itemRow(id, recordId, branchId, await idByCode(db, 'collection_types', c.collectionType ?? 'UMUM'), c)).execute();
    const event = c.event === undefined ? 'created' : c.event;
    if (event !== null) {
      await db
        .insertInto('item_events')
        .values({
          id: newId(c.createdAt ?? at),
          item_id: id,
          at: c.createdAt ?? at,
          type: event,
          from_status: null,
          to_status: c.status ?? 'available',
          from_location_id: null,
          to_location_id: null,
          actor_type: 'staff',
          actor_id: null,
          meta: JSON.stringify({ fields: [] }),
        })
        .execute();
    }
    itemIds.push(id);
  }
  return { recordId, itemIds };
}

/** A location (a room) of `branchId`. */
export async function addLocation(db: Kysely<DB>, branchId: string, code: string, name: string): Promise<string> {
  const at = stockAt('2017-01-03');
  const id = newId(at);
  await db
    .insertInto('locations')
    .values({
      id,
      branch_id: branchId,
      parent_id: null,
      kind: 'room',
      code_display: code,
      code_key: normalizeKey(code),
      name,
      shelf_hint: null,
      class_from: null,
      class_to: null,
      map_file_id: null,
      map_x: null,
      map_y: null,
      map_w: null,
      map_h: null,
      archived_at: null,
      created_at: at,
      created_by: null,
      updated_at: at,
      updated_by: null,
    })
    .execute();
  return id;
}

/**
 * `n` plain titles with one received copy each (classes cycling through the hundreds, receiving dates through
 * 2015–2024), written in chunks: a catalogue larger than one batch of the stock scan.
 */
export async function seedBulk(db: Kysely<DB>, branchId: string, n: number, o: { prefix: string; locationId?: string | null }): Promise<void> {
  const materialTypeId = await idByCode(db, 'material_types', 'BUKU');
  const collectionTypeId = await idByCode(db, 'collection_types', 'UMUM');
  const base = stockAt('2015-01-05');
  const CHUNK = 20;
  for (let from = 0; from < n; from += CHUNK) {
    const records: Insertable<DB['records']>[] = [];
    const items: Insertable<DB['items']>[] = [];
    const events: Insertable<DB['item_events']>[] = [];
    for (let k = from; k < Math.min(n, from + CHUNK); k += 1) {
      const at = base + k * 60_000;
      const recordId = newId(at);
      const itemId = newId(at);
      const year = 2015 + (k % 10);
      const cls = `${k % 10}${(k * 7) % 10}${k % 3}.${k % 97}`;
      records.push(recordRow(recordId, materialTypeId, null, { title: `${o.prefix} ${String(k).padStart(5, '0')}`, classification: cls, callNumber: `${cls} ABC a`, createdAt: at }));
      items.push(
        itemRow(itemId, recordId, branchId, collectionTypeId, {
          barcode: `${o.prefix}-${String(k).padStart(5, '0')}`,
          receivedDate: `${year}-0${1 + (k % 9)}-1${k % 10}`,
          inventoryNo: `${o.prefix}/${String(k).padStart(5, '0')}`,
          callNumber: `${cls} ABC a`,
          locationId: o.locationId ?? null,
          price: 1_000_00 + k,
          acqSource: 'purchase',
          createdAt: at,
        }),
      );
      events.push({
        id: newId(at),
        item_id: itemId,
        at,
        type: 'created',
        from_status: null,
        to_status: 'available',
        from_location_id: null,
        to_location_id: null,
        actor_type: 'staff',
        actor_id: null,
        meta: '{"fields":[]}',
      });
    }
    await db.insertInto('records').values(records).execute();
    await db.insertInto('items').values(items).execute();
    await db.insertInto('item_events').values(events).execute();
  }
}

/** A report context at {@link TODAY} (or `o.today`) in the fixture's time zone, with the definition's parsed params. */
export function ctxFor(
  c: CollectionDb,
  def: TableReport,
  params: Record<string, unknown>,
  o: { today?: string; now?: number; locale?: Locale; budget?: () => number; settings?: AccredSettings } = {},
): ReportCtx {
  return {
    db: c.db,
    locale: o.locale ?? 'id',
    tz: STOCK_TZ,
    now: o.now ?? NOW,
    today: o.today ?? TODAY,
    settings: o.settings ?? c.settings,
    params: def.paramsSchema.parse(params),
    budgetLeftMs: o.budget ?? (() => 60_000),
  };
}

/** Every row of `def` in `ctx`, page by page (`limit` rows a page), the totals row and the cursors it answered. */
export async function drain(def: TableReport, ctx: ReportCtx, limit = 500): Promise<{ rows: ReportRow[]; totals: ReportRow | null; cursors: string[]; pages: number }> {
  const rows: ReportRow[] = [];
  const cursors: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  for (;;) {
    const page: { rows: ReportRow[]; nextCursor: string | null } = await def.rows(ctx, cursor, limit);
    pages += 1;
    rows.push(...page.rows);
    if (page.nextCursor === null) break;
    if (page.rows.length === 0 && page.nextCursor === cursor) throw new Error('the cursor did not move');
    if (pages > 10_000) throw new Error('too many pages');
    cursors.push(page.nextCursor);
    cursor = page.nextCursor;
  }
  const totals = def.totals === undefined ? null : await def.totals(ctx);
  return { rows, totals, cursors, pages };
}

/** The rows whose first cells are `head`. */
export function rowsStarting(rows: readonly ReportRow[], ...head: (string | number | null)[]): ReportRow[] {
  return rows.filter((row) => head.every((cell, k) => row[k] === cell));
}
