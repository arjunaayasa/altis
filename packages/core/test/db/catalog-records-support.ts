import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PHASE1_MIGRATIONS, runMigrations, withTx } from '@altis/db';
import { isDomainError, newId, normalizeKey } from '@altis/shared';
import { testDb, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { txCtx, type Actor, type TxCtx } from '../../src/context.js';

// What the records tests of Phase 2 Task 16 share (catalog-records-{save,merge,duplicates,data}.test.ts): a migrated
// database with one branch, the actor and clock of the actions, and rows the records service reads but other tasks
// write (items, locations, files, custom field definitions), inserted directly.

/** In the past: an audit entry may not be dated ahead of the real clock (R51). */
export const NOW = Date.UTC(2026, 8, 1, 9, 0, 0);
export const DAY = 86_400_000;
export const STAFF = newId(NOW - DAY);
export const ACTOR: Actor = { type: 'staff', id: STAFF, ip: null };

export interface RecordsDb {
  h: TestDbHandle;
  dataDir: string;
  branchId: string;
  /** The id of the seeded material type `code` (§2.6: BUKU, EBOOK, …). */
  materialTypeId(code: string): Promise<string>;
  /** The id of the seeded collection type `code` (UMUM, REF, FIKSI, TANDON). */
  collectionTypeId(code: string): Promise<string>;
  /** The id of the seeded language `code` (ind, eng, …). */
  languageId(code: string): Promise<string>;
  /** `fn` in a transaction at `now`, as {@link ACTOR}. */
  run<T>(fn: (tx: TxCtx) => Promise<T>, now?: number): Promise<T>;
  close(): Promise<void>;
}

/** A migrated test database with the branch `PUSAT`. */
export async function openRecordsDb(prefix: string): Promise<RecordsDb> {
  const h = await testDb();
  const dataDir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), `altis-${prefix}-`)));
  await runMigrations(h, { appVersion: '0.1.0', dataDir, migrations: PHASE1_MIGRATIONS });
  const branchId = newId();
  await h.db
    .insertInto('branches')
    .values({ id: branchId, code_key: 'PUSAT', code_display: 'Pusat', name: 'Pusat', address: null, timezone: 'Asia/Jakarta', created_at: NOW, created_by: null, updated_at: NOW, updated_by: null })
    .execute();
  const byCode = async (table: 'material_types' | 'collection_types' | 'languages', code: string): Promise<string> =>
    (await h.db.selectFrom(table as 'material_types').select('id').where('code_key', '=', normalizeKey(code)).executeTakeFirstOrThrow()).id;
  return {
    h,
    dataDir,
    branchId,
    materialTypeId: (code) => byCode('material_types', code),
    collectionTypeId: (code) => byCode('collection_types', code),
    languageId: (code) => byCode('languages', code),
    run: (fn, now = NOW) => withTx(h, (trx) => fn(txCtx(trx, now, ACTOR))),
    close: async () => {
      await h.close();
      await fsp.rm(dataDir, { recursive: true, force: true });
    },
  };
}

/** What a rejected promise rejected with: `{code, errors?, meta?}` for a DomainError, else the error; 'resolved' when it did not. */
export async function failure(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => 'resolved',
    (e: unknown) => (isDomainError(e) ? { code: e.code, ...(e.meta === undefined ? {} : { meta: e.meta }) } : e),
  );
}

/** The field errors of a rejected VALIDATION_FAILED (or the failure itself, to show what came instead). */
export async function fieldErrors(p: Promise<unknown>): Promise<unknown> {
  const f = await failure(p);
  if (typeof f === 'object' && f !== null && (f as { code?: unknown }).code === 'VALIDATION_FAILED') {
    return (f as { meta: { errors: unknown } }).meta.errors;
  }
  return f;
}

/** A material type with `template` (JSON of §3.8) and its id. */
export async function seedMaterialType(db: RecordsDb, code: string, template: unknown): Promise<string> {
  const id = newId();
  await db.h.db
    .insertInto('material_types')
    .values({
      id,
      code_display: code,
      code_key: normalizeKey(code),
      name_id: `Jenis ${code}`,
      name_en: `Type ${code}`,
      marc_type: 'a',
      template: JSON.stringify(template),
      archived_at: null,
      created_at: NOW,
      created_by: null,
      updated_at: NOW,
      updated_by: null,
    })
    .execute();
  return id;
}

/** A location of the test branch; its id. */
export async function seedLocation(
  db: RecordsDb,
  o: { code: string; kind: 'room' | 'area' | 'shelf'; parentId?: string | null; isPublic?: boolean },
): Promise<string> {
  const id = newId();
  await db.h.db
    .insertInto('locations')
    .values({
      id,
      branch_id: db.branchId,
      parent_id: o.parentId ?? null,
      kind: o.kind,
      code_display: o.code,
      code_key: normalizeKey(o.code),
      name: `Lokasi ${o.code}`,
      shelf_hint: null,
      class_from: null,
      class_to: null,
      map_file_id: null,
      map_x: null,
      map_y: null,
      map_w: null,
      map_h: null,
      is_public: o.isPublic === false ? 0 : 1,
      archived_at: null,
      created_at: NOW,
      created_by: null,
      updated_at: NOW,
      updated_by: null,
    })
    .execute();
  return id;
}

/** An item of `recordId` in the test branch (Task 17 writes them through its service); its id. */
export async function seedItem(
  db: RecordsDb,
  recordId: string,
  o: { barcode?: string; status?: string; archived?: boolean; locationId?: string | null; price?: number | null; collectionTypeCode?: string } = {},
): Promise<string> {
  const id = newId();
  const barcode = o.barcode ?? `B${id.slice(-10)}`;
  await db.h.db
    .insertInto('items')
    .values({
      id,
      record_id: recordId,
      branch_id: db.branchId,
      barcode_display: barcode,
      barcode_key: barcode.toUpperCase(),
      inventory_no: null,
      call_number: null,
      location_id: o.locationId ?? null,
      collection_type_id: await db.collectionTypeId(o.collectionTypeCode ?? 'UMUM'),
      status: o.status ?? 'available',
      status_note: null,
      acq_source: o.price === undefined || o.price === null ? null : 'purchase',
      order_no: o.price === undefined || o.price === null ? null : 'PO-7731',
      order_date: null,
      received_date: null,
      invoice_date: null,
      supplier_id: null,
      invoice_no: o.price === undefined || o.price === null ? null : 'INV-5521',
      price: o.price ?? null,
      currency: o.price === undefined || o.price === null ? null : 'IDR',
      note: null,
      archived_at: o.archived === true ? NOW : null,
      created_at: NOW,
      created_by: null,
      updated_at: NOW,
      updated_by: null,
    })
    .execute();
  return id;
}

/** A completed upload's `files` row (no owner yet, as completion leaves it); its id. */
export async function seedFile(db: RecordsDb, o: { context: string; mime?: string; ownerType?: string | null; ownerId?: string | null }): Promise<string> {
  const id = newId();
  await db.h.db
    .insertInto('files')
    .values({
      id,
      original_name: 'gambar.jpg',
      mime: o.mime ?? 'image/jpeg',
      size: 1234,
      sha256: 'a'.repeat(64),
      context: o.context,
      owner_type: o.ownerType ?? null,
      owner_id: o.ownerId ?? null,
      access: 'staff',
      status: 'ok',
      created_at: NOW,
      created_by: STAFF,
    })
    .execute();
  return id;
}

/** A custom field definition of `records`; its id. */
export async function seedCustomField(
  db: RecordsDb,
  o: { code: string; type?: string; required?: boolean; isPublic?: boolean; labelEn?: string | null },
): Promise<string> {
  const id = newId();
  await db.h.db
    .insertInto('custom_field_defs')
    .values({
      id,
      entity: 'records',
      code_key: normalizeKey(o.code),
      code_display: o.code,
      label: `Label ${o.code}`,
      label_en: o.labelEn ?? null,
      type: o.type ?? 'text',
      options: null,
      is_required: o.required === true ? 1 : 0,
      is_public: o.isPublic === true ? 1 : 0,
      archived_at: null,
      created_at: NOW,
      created_by: null,
      updated_at: NOW,
      updated_by: null,
    })
    .execute();
  return id;
}

/** The `catalog.record.changed` events of `id`. */
export async function changedEvents(db: RecordsDb, id: string): Promise<number> {
  const rows = await db.h.db.selectFrom('events').select(['type', 'channel', 'payload']).where('type', '=', 'catalog.record.changed').execute();
  return rows.filter((r) => r.channel === 'catalog' && (JSON.parse(r.payload) as { id?: string }).id === id).length;
}

/** The audit entries of `action` on `entityId`: `{entity, meta}`. */
export async function audits(db: RecordsDb, action: string, entityId: string): Promise<{ entity: string | null; meta: Record<string, unknown> }[]> {
  const rows = await db.h.db.selectFrom('audit_log').select(['entity', 'meta']).where('action', '=', action).where('entity_id', '=', entityId).orderBy('seq').execute();
  return rows.map((r) => ({ entity: r.entity, meta: JSON.parse(r.meta) as Record<string, unknown> }));
}
