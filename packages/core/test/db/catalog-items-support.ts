import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PHASE1_MIGRATIONS, runMigrations, withTx } from '@altis/db';
import { isDomainError, newId, normalizeKey } from '@altis/shared';
import { testDb, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { txCtx, type Actor, type TxCtx } from '../../src/context.js';

// What the items tests of Phase 2 Task 17 share (catalog-items-{save,batch,lifecycle,bulk,concurrency}.test.ts): a
// migrated database with two branches, the actor and clock of the actions, and the rows the items service reads but
// other tasks write (records, locations, suppliers, custom field definitions), inserted directly.

/** In the past: an audit entry may not be dated ahead of the real clock (R51). */
export const NOW = Date.UTC(2026, 8, 2, 9, 0, 0);
export const DAY = 86_400_000;
export const STAFF = newId(NOW - DAY);
export const ACTOR: Actor = { type: 'staff', id: STAFF, ip: null };

export interface ItemsDb {
  h: TestDbHandle;
  dataDir: string;
  /** The branch the actions run in (`PUSAT`). */
  branchId: string;
  /** Another branch (`UTARA`). */
  otherBranchId: string;
  /** The id of the seeded collection type `code` (UMUM, REF, FIKSI, TANDON). */
  collectionTypeId(code: string): Promise<string>;
  /** `fn` in a transaction at `now`, as {@link ACTOR}. */
  run<T>(fn: (tx: TxCtx) => Promise<T>, now?: number): Promise<T>;
  close(): Promise<void>;
}

async function seedBranch(h: TestDbHandle, code: string, isDefault: 0 | 1): Promise<string> {
  const id = newId();
  await h.db
    .insertInto('branches')
    .values({ id, code_key: normalizeKey(code), code_display: code, name: `Cabang ${code}`, address: null, timezone: 'Asia/Jakarta', is_default: isDefault, created_at: NOW, created_by: null, updated_at: NOW, updated_by: null })
    .execute();
  return id;
}

/** A migrated test database with the branches `PUSAT` and `UTARA`. */
export async function openItemsDb(prefix: string): Promise<ItemsDb> {
  const h = await testDb();
  const dataDir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), `altis-${prefix}-`)));
  await runMigrations(h, { appVersion: '0.1.0', dataDir, migrations: PHASE1_MIGRATIONS });
  const branchId = await seedBranch(h, 'PUSAT', 1);
  const otherBranchId = await seedBranch(h, 'UTARA', 0);
  return {
    h,
    dataDir,
    branchId,
    otherBranchId,
    collectionTypeId: async (code) =>
      (await h.db.selectFrom('collection_types').select('id').where('code_key', '=', normalizeKey(code)).executeTakeFirstOrThrow()).id,
    run: (fn, now = NOW) => withTx(h, (trx) => fn(txCtx(trx, now, ACTOR))),
    close: async () => {
      await h.close();
      await fsp.rm(dataDir, { recursive: true, force: true });
    },
  };
}

/** A record (material type BUKU); its id. */
export async function seedRecord(db: ItemsDb, o: { title?: string; callNumber?: string | null; archived?: boolean } = {}): Promise<string> {
  const id = newId();
  const buku = (await db.h.db.selectFrom('material_types').select('id').where('code_key', '=', 'BUKU').executeTakeFirstOrThrow()).id;
  const title = o.title ?? 'Bumi Manusia';
  await db.h.db
    .insertInto('records')
    .values({
      id,
      material_type_id: buku,
      title,
      subtitle: null,
      responsibility: null,
      title_key: title.toLowerCase(),
      edition: null,
      material_detail: null,
      publisher_id: null,
      publication_place: null,
      publication_year: null,
      publication_date_text: null,
      physical_desc: null,
      series: null,
      classification: null,
      call_number: o.callNumber ?? null,
      language_id: null,
      content_type: null,
      media_type: null,
      carrier_type: null,
      summary: null,
      notes: null,
      cover_file_id: null,
      source: 'manual',
      merged_into: null,
      changed_at: NOW - DAY,
      archived_at: o.archived === true ? NOW - DAY : null,
      created_at: NOW - DAY,
      created_by: null,
      updated_at: NOW - DAY,
      updated_by: null,
    })
    .execute();
  return id;
}

/** A location of `branchId` (default the test branch); its id. */
export async function seedLocation(
  db: ItemsDb,
  o: {
    code: string;
    kind: 'room' | 'area' | 'shelf';
    parentId?: string | null;
    branchId?: string;
    name?: string;
    classFrom?: string | null;
    classTo?: string | null;
    shelfHint?: string | null;
    archived?: boolean;
  },
): Promise<string> {
  const id = newId();
  await db.h.db
    .insertInto('locations')
    .values({
      id,
      branch_id: o.branchId ?? db.branchId,
      parent_id: o.parentId ?? null,
      kind: o.kind,
      code_display: o.code,
      code_key: normalizeKey(o.code),
      name: o.name ?? `Lokasi ${o.code}`,
      shelf_hint: o.shelfHint ?? null,
      class_from: o.classFrom ?? null,
      class_to: o.classTo ?? null,
      map_file_id: null,
      map_x: null,
      map_y: null,
      map_w: null,
      map_h: null,
      is_public: 1,
      archived_at: o.archived === true ? NOW - DAY : null,
      created_at: NOW - DAY,
      created_by: null,
      updated_at: NOW - DAY,
      updated_by: null,
    })
    .execute();
  return id;
}

/** A supplier; its id. */
export async function seedSupplier(db: ItemsDb, code: string): Promise<string> {
  const id = newId();
  await db.h.db
    .insertInto('suppliers')
    .values({
      id,
      code_display: code,
      code_key: normalizeKey(code),
      name: `Pemasok ${code}`,
      contact_name: null,
      phone: null,
      email: null,
      address: null,
      note: null,
      archived_at: null,
      created_at: NOW - DAY,
      created_by: null,
      updated_at: NOW - DAY,
      updated_by: null,
    })
    .execute();
  return id;
}

/** A custom field definition of `items`; its id. */
export async function seedItemCustomField(db: ItemsDb, o: { code: string; type?: string; required?: boolean }): Promise<string> {
  const id = newId();
  await db.h.db
    .insertInto('custom_field_defs')
    .values({
      id,
      entity: 'items',
      code_key: normalizeKey(o.code),
      code_display: o.code,
      label: `Label ${o.code}`,
      label_en: null,
      type: o.type ?? 'text',
      options: null,
      is_required: o.required === true ? 1 : 0,
      archived_at: null,
      created_at: NOW - DAY,
      created_by: null,
      updated_at: NOW - DAY,
      updated_by: null,
    })
    .execute();
  return id;
}

/** An item stored directly (as an import or a manual create elsewhere would leave it); its id. */
export async function seedItem(
  db: ItemsDb,
  recordId: string,
  o: { barcode: string; status?: string; branchId?: string; archived?: boolean; locationId?: string | null; collectionTypeCode?: string },
): Promise<string> {
  const id = newId();
  await db.h.db
    .insertInto('items')
    .values({
      id,
      record_id: recordId,
      branch_id: o.branchId ?? db.branchId,
      barcode_display: o.barcode,
      barcode_key: o.barcode,
      inventory_no: null,
      call_number: null,
      location_id: o.locationId ?? null,
      collection_type_id: await db.collectionTypeId(o.collectionTypeCode ?? 'UMUM'),
      status: o.status ?? 'available',
      status_note: null,
      acq_source: null,
      order_no: null,
      order_date: null,
      received_date: null,
      invoice_date: null,
      supplier_id: null,
      invoice_no: null,
      price: null,
      currency: null,
      note: null,
      archived_at: o.archived === true ? NOW - DAY : null,
      created_at: NOW - DAY,
      created_by: null,
      updated_at: NOW - DAY,
      updated_by: null,
    })
    .execute();
  return id;
}

/** What a rejected promise rejected with: `{code, meta?}` for a DomainError, else the error; 'resolved' when it did not. */
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

/** The item row `id`. */
export function itemRow(db: ItemsDb, id: string) {
  return db.h.db.selectFrom('items').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
}

/** The `item_events` of `itemId`, oldest first: `{type, from_status, to_status, from_location_id, to_location_id, fields}`. */
export async function itemEvents(db: ItemsDb, itemId: string) {
  const rows = await db.h.db.selectFrom('item_events').selectAll().where('item_id', '=', itemId).orderBy('at').orderBy('id').execute();
  return rows.map((r) => ({
    type: r.type,
    from_status: r.from_status,
    to_status: r.to_status,
    from_location_id: r.from_location_id,
    to_location_id: r.to_location_id,
    actor_type: r.actor_type,
    actor_id: r.actor_id,
    fields: (JSON.parse(r.meta) as { fields?: string[] }).fields ?? [],
  }));
}

/** The `catalog.item.changed` events: their payloads, in order. */
export async function itemChangedEvents(db: ItemsDb): Promise<{ id: string; recordId: string }[]> {
  const rows = await db.h.db.selectFrom('events').select(['channel', 'payload']).where('type', '=', 'catalog.item.changed').orderBy('seq').execute();
  return rows.filter((r) => r.channel === 'catalog').map((r) => JSON.parse(r.payload) as { id: string; recordId: string });
}

/** The audit entries of `action`: `{entity, entityId, branchId, meta}`, in order. */
export async function audits(db: ItemsDb, action: string): Promise<{ entity: string | null; entityId: string | null; branchId: string | null; meta: Record<string, unknown> }[]> {
  const rows = await db.h.db.selectFrom('audit_log').select(['entity', 'entity_id', 'branch_id', 'meta']).where('action', '=', action).orderBy('seq').execute();
  return rows.map((r) => ({ entity: r.entity, entityId: r.entity_id, branchId: r.branch_id, meta: JSON.parse(r.meta) as Record<string, unknown> }));
}
