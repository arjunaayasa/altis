import type { DB } from '@altis/db';
import { newId, normalizeKey } from '@altis/shared';
import type { Insertable, Kysely } from 'kysely';
import { titleKey } from '../../src/catalog/lib/title-key.js';

// A small catalogue whose copies cover every step of the acquisition-date chain and every way a title enters or leaves
// the stock: copies dated by their receiving date, by the date they were entered in the source system, by their
// migrated record's creation, by their own creation here, and undated ones (a migrated record created at the time of
// the migration itself, an imported copy without dates, the copy of a placeholder record); an ordered copy; a copy
// withdrawn, one declared lost, one a re-sync from the source system marked lost; titles without copies (electronic,
// with a public file, with a staff-only file). Rows are written directly, as the catalogue, the import and the SLiMS
// migration leave them, so the fixture does not depend on those writers. Dates are local dates in STOCK_TZ.

/** The time zone of every date of the fixture. */
export const STOCK_TZ = 'Asia/Jakarta';

/** The instant of the local time `hh:mm` (default 10:00) of `date` in STOCK_TZ (UTC+7, no daylight saving). */
export function stockAt(date: string, hhmm = '10:00'): number {
  return Date.parse(`${date}T${hhmm}:00+07:00`);
}

/** The SLiMS migration run: 2025-09-01 08:00 to 10:00. */
export const STOCK_MIGRATION_SPAN = Object.freeze({ from: stockAt('2025-09-01', '08:00'), to: stockAt('2025-09-01', '10:00') });

/** The copies of the fixture, by role. */
export const STOCK_ITEM_KEYS = Object.freeze([
  'received',
  'inputOn',
  'migratedValid',
  'migratedInSpan',
  'created',
  'imported',
  'onOrder',
  'withdrawn',
  'lost',
  'syncLost',
  'orphan',
] as const);

export type StockItemKey = (typeof STOCK_ITEM_KEYS)[number];

/** The titles of the fixture, by role: each copy's title under the copy's key, then the titles without copies. */
export type StockRecordKey = Exclude<StockItemKey, 'orphan'> | 'placeholder' | 'ebook' | 'publicFile' | 'staffFile';

export interface StockFixture {
  branchId: string;
  /** The SLiMS migration run (span {@link STOCK_MIGRATION_SPAN}). */
  migrationRunId: string;
  /** The catalogue import run of the imported copy. */
  importRunId: string;
  items: Readonly<Record<StockItemKey, string>>;
  records: Readonly<Record<StockRecordKey, string>>;
}

type Db = Kysely<DB>;

interface RecordSeed {
  title: string;
  materialType: 'BUKU' | 'EBOOK';
  classification?: string | null;
  callNumber?: string | null;
  createdAt: number;
  source: string;
}

interface EventSeed {
  at: number;
  type: 'created' | 'imported' | 'migrated' | 'status' | 'archived';
  from?: string | null;
  to: string;
  via?: 'sync';
}

interface ItemSeed {
  barcode: string;
  collectionType?: 'UMUM' | 'REF' | 'FIKSI';
  status: string;
  createdAt: number;
  archivedAt?: number | null;
  receivedDate?: string | null;
  inputOn?: string | null;
  inventoryNo?: string | null;
  price?: number | null;
  acqSource?: string | null;
  events: readonly EventSeed[];
}

async function idOf(db: Db, table: 'material_types' | 'collection_types', code: string): Promise<string> {
  return (await db.selectFrom(table).select('id').where('code_key', '=', normalizeKey(code)).executeTakeFirstOrThrow()).id;
}

async function insertRecord(db: Db, s: RecordSeed): Promise<string> {
  const id = newId(s.createdAt);
  const row: Insertable<DB['records']> = {
    id,
    material_type_id: await idOf(db, 'material_types', s.materialType),
    title: s.title,
    subtitle: null,
    responsibility: null,
    title_key: titleKey(s.title),
    edition: null,
    material_detail: null,
    publisher_id: null,
    publication_place: null,
    publication_year: null,
    publication_date_text: null,
    physical_desc: null,
    series: null,
    classification: s.classification ?? null,
    call_number: s.callNumber ?? null,
    language_id: null,
    content_type: null,
    media_type: null,
    carrier_type: null,
    summary: null,
    notes: null,
    cover_file_id: null,
    source: s.source,
    merged_into: null,
    changed_at: s.createdAt,
    archived_at: null,
    created_at: s.createdAt,
    created_by: null,
    updated_at: s.createdAt,
    updated_by: null,
    audience: null,
    local_work: null,
    local_work_kind: null,
    reference_kind: null,
  };
  await db.insertInto('records').values(row).execute();
  return id;
}

async function insertItem(db: Db, branchId: string, recordId: string, s: ItemSeed): Promise<string> {
  const id = newId(s.createdAt);
  const row: Insertable<DB['items']> = {
    id,
    record_id: recordId,
    branch_id: branchId,
    barcode_display: s.barcode,
    barcode_key: normalizeKey(s.barcode),
    inventory_no: s.inventoryNo ?? null,
    call_number: null,
    location_id: null,
    collection_type_id: await idOf(db, 'collection_types', s.collectionType ?? 'UMUM'),
    status: s.status,
    status_note: null,
    acq_source: s.acqSource ?? null,
    order_no: null,
    order_date: null,
    received_date: s.receivedDate ?? null,
    invoice_date: null,
    supplier_id: null,
    invoice_no: null,
    price: s.price ?? null,
    currency: s.price === undefined || s.price === null ? null : 'IDR',
    note: null,
    archived_at: s.archivedAt ?? null,
    created_at: s.createdAt,
    created_by: null,
    updated_at: s.createdAt,
    updated_by: null,
    input_on: s.inputOn ?? null,
  };
  await db.insertInto('items').values(row).execute();
  for (const e of s.events) {
    await db
      .insertInto('item_events')
      .values({
        id: newId(e.at),
        item_id: id,
        at: e.at,
        type: e.type,
        from_status: e.from ?? null,
        to_status: e.to,
        from_location_id: null,
        to_location_id: null,
        actor_type: e.type === 'migrated' ? 'system' : 'staff',
        actor_id: null,
        meta: JSON.stringify(e.via === undefined ? { fields: e.type === 'status' || e.type === 'archived' ? ['status'] : [] } : { via: e.via, fields: ['status'] }),
      })
      .execute();
  }
  return id;
}

async function insertRun(db: Db, kind: 'migration' | 'import', from: number, to: number, options: object): Promise<string> {
  const id = newId(from);
  await db
    .insertInto('catalog_runs')
    .values({
      id,
      kind,
      status: 'succeeded',
      dry_run: 0,
      format: kind === 'import' ? 'csv' : null,
      options: JSON.stringify(options),
      summary: '{}',
      report_file_id: null,
      output_name: null,
      output_size: null,
      expires_at: null,
      job_id: null,
      created_at: from,
      created_by: null,
      finished_at: to,
    })
    .execute();
  return id;
}

async function insertAttachment(db: Db, recordId: string, o: { kind: 'file' | 'url'; access: 'public' | 'staff'; archivedAt?: number | null; at: number }): Promise<void> {
  let fileId: string | null = null;
  if (o.kind === 'file') {
    fileId = newId(o.at);
    await db
      .insertInto('files')
      .values({
        id: fileId,
        original_name: 'lampiran.pdf',
        mime: 'application/pdf',
        size: 2048,
        sha256: 'b'.repeat(64),
        context: 'catalog.attachment',
        owner_type: 'records',
        owner_id: recordId,
        access: o.access,
        status: 'ok',
        created_at: o.at,
        created_by: null,
      })
      .execute();
  }
  await db
    .insertInto('attachments')
    .values({
      id: newId(o.at),
      record_id: recordId,
      kind: o.kind,
      file_id: fileId,
      url: o.kind === 'url' ? 'https://contoh.example/lampiran' : null,
      title: o.kind === 'file' ? 'Berkas' : 'Tautan',
      description: null,
      access: o.access,
      legacy_access_limit: null,
      sort_order: 0,
      archived_at: o.archivedAt ?? null,
      created_at: o.at,
      created_by: null,
      updated_at: o.at,
      updated_by: null,
    })
    .execute();
}

/**
 * Seeds the stock fixture into a migrated database (material types `BUKU`, `EBOOK` and collection types `UMUM`, `REF`
 * as the catalogue seed leaves them) and answers the ids. Without `branchId` it adds the branch `STOK`.
 */
export async function seedStockFixture(db: Db, o: { branchId?: string } = {}): Promise<StockFixture> {
  let branchId = o.branchId;
  if (branchId === undefined) {
    branchId = newId(stockAt('2017-01-02'));
    const at = stockAt('2017-01-02');
    await db
      .insertInto('branches')
      .values({ id: branchId, code_key: 'STOK', code_display: 'STOK', name: 'Cabang Stok', address: null, timezone: STOCK_TZ, is_default: 0, created_at: at, created_by: null, updated_at: at, updated_by: null })
      .execute();
  }
  const span = STOCK_MIGRATION_SPAN;
  const migrationRunId = await insertRun(db, 'migration', span.from, span.to, { sourceKind: 'dump', sourceName: 'slims' });
  const importRunId = await insertRun(db, 'import', stockAt('2025-04-15', '09:00'), stockAt('2025-04-15', '11:00'), { format: 'csv' });
  const migratedAt = stockAt('2025-09-01', '09:00');
  const migrated = (to = 'available'): EventSeed[] => [{ at: migratedAt, type: 'migrated', to }];
  const madeHere = (date: string, to = 'available'): EventSeed[] => [{ at: stockAt(date), type: 'created', to }];

  const records = {} as Record<StockRecordKey, string>;
  const items = {} as Record<StockItemKey, string>;
  const maps: Insertable<DB['migration_map']>[] = [];
  const mapRecord = (entity: 'biblio' | 'biblio_missing', key: string, id: string) => maps.push({ source: 'slims', entity, legacy_key: key, target_id: id, run_id: migrationRunId });

  // Received on a known date (an Arabic-script title).
  records.received = await insertRecord(db, { title: 'تفسير الجلالين', materialType: 'BUKU', classification: '297', createdAt: stockAt('2024-03-18'), source: 'manual' });
  items.received = await insertItem(db, branchId, records.received, {
    barcode: 'STK-0001',
    status: 'available',
    createdAt: stockAt('2024-03-18'),
    receivedDate: '2024-03-15',
    inventoryNo: 'INV/2024/001',
    price: 7_500_000,
    acqSource: 'purchase',
    events: madeHere('2024-03-18'),
  });

  // Migrated: the copy carries the date it was entered in SLiMS; the record its valid input date.
  records.inputOn = await insertRecord(db, { title: 'Laskar Pelangi', materialType: 'BUKU', classification: '899.221', createdAt: stockAt('2019-02-11'), source: 'slims:101' });
  mapRecord('biblio', '101', records.inputOn);
  items.inputOn = await insertItem(db, branchId, records.inputOn, { barcode: 'STK-0002', status: 'available', createdAt: migratedAt, inputOn: '2023-07-20', events: migrated() });

  // Migrated without copy dates: the record's valid input date.
  records.migratedValid = await insertRecord(db, { title: 'Fikih Ibadah Praktis', materialType: 'BUKU', classification: '2X4.3', createdAt: stockAt('2022-05-10'), source: 'slims:102' });
  mapRecord('biblio', '102', records.migratedValid);
  items.migratedValid = await insertItem(db, branchId, records.migratedValid, { barcode: 'STK-0003', status: 'available', createdAt: migratedAt, events: migrated() });

  // Migrated without copy dates, the record created at the time of the migration (its input date was empty).
  records.migratedInSpan = await insertRecord(db, {
    title: 'Ensiklopedia Nusantara',
    materialType: 'BUKU',
    classification: null,
    callNumber: 'R 030 ENS e',
    createdAt: stockAt('2025-09-01', '09:10'),
    source: 'slims:103',
  });
  mapRecord('biblio', '103', records.migratedInSpan);
  items.migratedInSpan = await insertItem(db, branchId, records.migratedInSpan, { barcode: 'STK-0004', collectionType: 'REF', status: 'available', createdAt: migratedAt, events: migrated() });

  // Made here without a receiving date: its own creation.
  records.created = await insertRecord(db, { title: 'Program Kerja Perpustakaan 2021', materialType: 'BUKU', classification: 'PROG/2021', createdAt: stockAt('2025-06-02'), source: 'manual' });
  items.created = await insertItem(db, branchId, records.created, { barcode: 'STK-0005', status: 'available', createdAt: stockAt('2025-06-02'), events: madeHere('2025-06-02') });

  // Imported from a catalogue file without dates: undated.
  records.imported = await insertRecord(db, { title: 'Sejarah Kebudayaan Islam', materialType: 'BUKU', classification: '909', createdAt: stockAt('2025-04-15'), source: `import:${importRunId}` });
  items.imported = await insertItem(db, branchId, records.imported, {
    barcode: 'STK-0006',
    status: 'available',
    createdAt: stockAt('2025-04-15'),
    events: [{ at: stockAt('2025-04-15'), type: 'imported', to: 'available' }],
  });
  await db
    .insertInto('migration_map')
    .values([
      { source: `import:${importRunId}`, entity: 'record', legacy_key: '1', target_id: records.imported, run_id: importRunId },
      { source: `import:${importRunId}`, entity: 'item', legacy_key: '1', target_id: items.imported, run_id: importRunId },
    ])
    .execute();

  // Ordered for a new title: dated by its creation, yet never an acquisition while it is on order.
  records.onOrder = await insertRecord(db, { title: 'Matematika Kelas X', materialType: 'BUKU', classification: '510', createdAt: stockAt('2026-02-01'), source: 'manual' });
  items.onOrder = await insertItem(db, branchId, records.onOrder, { barcode: 'STK-0007', status: 'on_order', createdAt: stockAt('2026-02-01'), events: madeHere('2026-02-01', 'on_order') });

  // Withdrawn (archived) on 2025-02-01, the title's only copy.
  records.withdrawn = await insertRecord(db, { title: 'Kamus Lama', materialType: 'BUKU', classification: '423', createdAt: stockAt('2019-08-02'), source: 'manual' });
  items.withdrawn = await insertItem(db, branchId, records.withdrawn, {
    barcode: 'STK-0008',
    status: 'withdrawn',
    createdAt: stockAt('2019-08-02'),
    archivedAt: stockAt('2025-02-01'),
    receivedDate: '2019-08-01',
    events: [...madeHere('2019-08-02'), { at: stockAt('2025-02-01'), type: 'archived', from: 'available', to: 'withdrawn' }],
  });

  // Missing from 2025-12-20, declared lost on 2026-01-05, the title's only copy.
  records.lost = await insertRecord(db, { title: 'Atlas Dunia', materialType: 'BUKU', classification: '912', createdAt: stockAt('2021-04-13'), source: 'manual' });
  items.lost = await insertItem(db, branchId, records.lost, {
    barcode: 'STK-0009',
    status: 'lost',
    createdAt: stockAt('2021-04-13'),
    receivedDate: '2021-04-12',
    events: [
      ...madeHere('2021-04-13'),
      { at: stockAt('2025-12-20'), type: 'status', from: 'available', to: 'missing' },
      { at: stockAt('2026-01-05'), type: 'status', from: 'missing', to: 'lost' },
    ],
  });

  // Migrated, then marked lost in SLiMS: the re-sync of 2026-03-10 wrote the loss.
  records.syncLost = await insertRecord(db, { title: 'Bahasa Jawa Dasar', materialType: 'BUKU', classification: '499.222', createdAt: stockAt('2017-03-03'), source: 'slims:104' });
  mapRecord('biblio', '104', records.syncLost);
  items.syncLost = await insertItem(db, branchId, records.syncLost, {
    barcode: 'STK-0010',
    status: 'lost',
    createdAt: migratedAt,
    inputOn: '2018-01-09',
    events: [...migrated(), { at: stockAt('2026-03-10'), type: 'migrated', from: 'available', to: 'lost', via: 'sync' }],
  });

  // The placeholder record SLiMS's orphan copy was attached to (made at the time of the migration).
  records.placeholder = await insertRecord(db, { title: '[Cantuman hilang - SLiMS #9001]', materialType: 'BUKU', createdAt: stockAt('2025-09-01', '09:20'), source: 'slims:9001' });
  mapRecord('biblio_missing', '9001', records.placeholder);
  items.orphan = await insertItem(db, branchId, records.placeholder, { barcode: 'STK-0011', status: 'available', createdAt: migratedAt, events: migrated() });

  // Titles without copies: an e-book, a printed title with a public file, one with only a staff file (plus an
  // archived public file and a public link, neither of which is a public file).
  records.ebook = await insertRecord(db, { title: 'Panduan Literasi Digital', materialType: 'EBOOK', classification: '028', createdAt: stockAt('2024-11-20'), source: 'manual' });
  records.publicFile = await insertRecord(db, { title: 'Modul Ajar IPA', materialType: 'BUKU', classification: '507', createdAt: stockAt('2025-03-03'), source: 'manual' });
  await insertAttachment(db, records.publicFile, { kind: 'file', access: 'public', at: stockAt('2025-03-03') });
  records.staffFile = await insertRecord(db, { title: 'Arsip Rapat Guru', materialType: 'BUKU', classification: '371', createdAt: stockAt('2025-03-04'), source: 'manual' });
  await insertAttachment(db, records.staffFile, { kind: 'file', access: 'staff', at: stockAt('2025-03-04') });
  await insertAttachment(db, records.staffFile, { kind: 'file', access: 'public', archivedAt: stockAt('2025-03-05'), at: stockAt('2025-03-04') });
  await insertAttachment(db, records.staffFile, { kind: 'url', access: 'public', at: stockAt('2025-03-04') });

  // The SLiMS legacy map of the migrated rows.
  const itemKeys: [StockItemKey, string][] = [
    ['inputOn', '2001'],
    ['migratedValid', '2002'],
    ['migratedInSpan', '2003'],
    ['syncLost', '2004'],
    ['orphan', '2005'],
  ];
  for (const [key, legacy] of itemKeys) maps.push({ source: 'slims', entity: 'item', legacy_key: legacy, target_id: items[key], run_id: migrationRunId });
  await db.insertInto('migration_map').values(maps).execute();

  return { branchId, migrationRunId, importRunId, items: Object.freeze(items), records: Object.freeze(records) };
}
