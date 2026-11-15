import type { DB } from '@altis/db';
import { newId, normalizeKey } from '@altis/shared';
import type { Insertable, Kysely } from 'kysely';
import { normalizeBarcode } from '../../src/catalog/lib/barcode.js';
import { titleKey } from '../../src/catalog/lib/title-key.js';
import { memberNameKey, normalizeMemberNo } from '../../src/members/keys.js';

// Rows of members, loans, in-library uses, visits, holds, charges, payments and stocktake sessions written straight into
// the tables, for the tests of the member, visit, circulation and stocktake reports. Each helper takes what the test
// cares about and fills the rest with plain defaults; every one answers the new row's id.

type Db = Kysely<DB>;

const AT = Date.parse('2026-01-02T03:00:00Z');

/** A branch of its own, in Asia/Jakarta. */
export async function seedBranch(db: Db, code: string): Promise<string> {
  const id = newId();
  await db
    .insertInto('branches')
    .values({ id, code_key: normalizeKey(code), code_display: code, name: `Cabang ${code}`, address: null, timezone: 'Asia/Jakarta', created_at: AT, updated_at: AT })
    .execute();
  return id;
}

/** The id of a seeded master row by its code (`material_types`, `collection_types`, `member_types`). */
export async function masterId(db: Db, table: 'material_types' | 'collection_types' | 'member_types', code: string): Promise<string> {
  return (await db.selectFrom(table).select('id').where('code_key', '=', normalizeKey(code)).executeTakeFirstOrThrow()).id;
}

/** A title with one copy at `branchId`; the record and item ids. */
export async function seedCopy(
  db: Db,
  o: { branchId: string; title: string; barcode: string; classification?: string | null; price?: number | null; locationId?: string | null },
): Promise<{ recordId: string; itemId: string }> {
  const recordId = newId();
  const itemId = newId();
  const record: Insertable<DB['records']> = {
    id: recordId,
    material_type_id: await masterId(db, 'material_types', 'BUKU'),
    title: o.title,
    title_key: titleKey(o.title),
    classification: o.classification ?? null,
    call_number: o.classification ?? null,
    source: 'manual',
    changed_at: AT,
    created_at: AT,
    updated_at: AT,
  };
  await db.insertInto('records').values(record).execute();
  await db
    .insertInto('items')
    .values({
      id: itemId,
      record_id: recordId,
      branch_id: o.branchId,
      barcode_display: o.barcode,
      barcode_key: normalizeKey(o.barcode),
      location_id: o.locationId ?? null,
      collection_type_id: await masterId(db, 'collection_types', 'UMUM'),
      status: 'available',
      price: o.price ?? null,
      currency: 'IDR',
      created_at: AT,
      updated_at: AT,
    })
    .execute();
  return { recordId, itemId };
}

/** A member; `typeCode` one of the seeded types (SISWA by default). */
export async function seedMember(
  db: Db,
  o: {
    no: string;
    name: string;
    typeCode?: string;
    className?: string | null;
    joinedOn?: string;
    expiresOn?: string | null;
    status?: 'active' | 'suspended';
    homeBranchId?: string | null;
    source?: string | null;
    archived?: boolean;
    phone?: string | null;
  },
): Promise<string> {
  const id = newId();
  const joined = o.joinedOn ?? '2025-07-14';
  await db
    .insertInto('members')
    .values({
      id,
      member_no_display: o.no,
      member_no_key: normalizeMemberNo(o.no),
      member_type_id: await masterId(db, 'member_types', o.typeCode ?? 'SISWA'),
      home_branch_id: o.homeBranchId ?? null,
      status: o.status ?? 'active',
      name: o.name,
      name_key: memberNameKey(o.name),
      class_name: o.className ?? null,
      phone: o.phone ?? null,
      joined_on: joined,
      valid_from: joined,
      expires_on: o.expiresOn === undefined ? '2099-07-14' : o.expiresOn,
      source: o.source ?? 'manual',
      archived_at: o.archived === true ? AT : null,
      created_at: AT,
      updated_at: AT,
    })
    .execute();
  return id;
}

/** A loan: open when `returnedOn` is not given (and `outcome` is not set). */
export async function seedLoan(
  db: Db,
  o: {
    itemId: string;
    recordId: string;
    memberId: string | null;
    branchId: string;
    loanedOn: string;
    dueOn: string;
    returnedOn?: string | null;
    outcome?: 'returned' | 'lost' | 'voided' | null;
    statDdc?: string | null;
    memberTypeId?: string | null;
    className?: string | null;
    renewals?: number;
    finePerDayMinor?: number;
    loanedAt?: number;
  },
): Promise<string> {
  const id = newId();
  const closed = o.returnedOn !== undefined && o.returnedOn !== null;
  const at = o.loanedAt ?? Date.parse(`${o.loanedOn}T03:00:00Z`);
  await db
    .insertInto('loans')
    .values({
      id,
      item_id: o.itemId,
      open_item_id: closed || (o.outcome ?? null) !== null ? null : o.itemId,
      record_id: o.recordId,
      member_id: o.memberId,
      branch_id: o.branchId,
      policy_id: null,
      loaned_on: o.loanedOn,
      loaned_at: at,
      due_on: o.dueOn,
      renewals: o.renewals ?? 0,
      returned_on: o.returnedOn ?? null,
      returned_at: closed ? Date.parse(`${o.returnedOn!}T04:00:00Z`) : null,
      return_branch_id: closed ? o.branchId : null,
      outcome: o.outcome ?? (closed ? 'returned' : null),
      loan_days: 7,
      renew_limit: 1,
      grace_days: 0,
      fine_per_day_minor: o.finePerDayMinor ?? 0,
      fine_cap_minor: null,
      currency: 'IDR',
      loaned_by: null,
      source: 'desk',
      stat_ddc: o.statDdc ?? null,
      stat_material_type_id: await masterId(db, 'material_types', 'BUKU'),
      stat_collection_type_id: await masterId(db, 'collection_types', 'UMUM'),
      stat_location_id: null,
      stat_member_type_id: o.memberTypeId ?? null,
      stat_accred_group: null,
      stat_class_name: o.className ?? null,
      created_at: at,
      updated_at: at,
    })
    .execute();
  return id;
}

/** An in-library use. */
export async function seedUse(db: Db, o: { itemId: string; recordId: string; branchId: string; usedOn: string; statDdc?: string | null }): Promise<string> {
  const id = newId();
  await db
    .insertInto('item_uses')
    .values({
      id,
      item_id: o.itemId,
      record_id: o.recordId,
      branch_id: o.branchId,
      used_on: o.usedOn,
      used_at: Date.parse(`${o.usedOn}T03:00:00Z`),
      member_id: null,
      stat_ddc: o.statDdc ?? null,
      stat_material_type_id: null,
      stat_collection_type_id: null,
      source: 'desk',
      created_by: null,
    })
    .execute();
  return id;
}

/** A visit of a member, or of a guest (`memberId` null). */
export async function seedVisit(
  db: Db,
  o: {
    branchId: string;
    visitedOn: string;
    memberId?: string | null;
    memberTypeId?: string | null;
    accredGroup?: string | null;
    className?: string | null;
    guestName?: string | null;
    source?: string;
    headcount?: number;
    voided?: boolean;
  },
): Promise<string> {
  const id = newId();
  await db
    .insertInto('visits')
    .values({
      id,
      branch_id: o.branchId,
      location_id: null,
      visited_on: o.visitedOn,
      visited_at: Date.parse(`${o.visitedOn}T02:30:00Z`),
      source: o.source ?? 'station',
      member_id: o.memberId ?? null,
      member_type_id: o.memberTypeId ?? null,
      accred_group: o.accredGroup ?? (o.memberId === undefined || o.memberId === null ? 'guest' : 'student'),
      class_name: o.className ?? null,
      guest_name: o.guestName ?? null,
      guest_institution: null,
      purpose: 'read',
      headcount: o.headcount ?? 1,
      station_id: null,
      day_key: null,
      note: null,
      voided_at: o.voided === true ? AT : null,
      voided_by: null,
      created_by: null,
    })
    .execute();
  return id;
}

/** A hold. */
export async function seedHold(
  db: Db,
  o: { recordId: string; memberId: string; branchId: string; placedOn: string; status?: string; placedAt?: number; pickupUntil?: string | null },
): Promise<string> {
  const id = newId();
  const status = o.status ?? 'waiting';
  const active = status === 'waiting' || status === 'ready';
  const at = o.placedAt ?? Date.parse(`${o.placedOn}T03:00:00Z`);
  await db
    .insertInto('holds')
    .values({
      id,
      record_id: o.recordId,
      item_id: null,
      member_id: o.memberId,
      pickup_branch_id: o.branchId,
      status,
      active_key: active ? `${o.memberId}:${o.recordId}` : null,
      trap_item_id: null,
      placed_on: o.placedOn,
      placed_at: at,
      placed_by: null,
      source: 'desk',
      expires_on: null,
      ready_at: null,
      pickup_until: o.pickupUntil ?? null,
      closed_at: active ? null : at,
      close_reason: null,
      shelf_cleared_at: null,
      loan_id: null,
      created_at: at,
      updated_at: at,
    })
    .execute();
  return id;
}

/** A charge (minor units). */
export async function seedCharge(
  db: Db,
  o: { memberId: string; branchId: string; amountMinor: number; paidMinor?: number; waivedMinor?: number; chargedOn: string; kind?: string; description?: string },
): Promise<string> {
  const id = newId();
  const paid = o.paidMinor ?? 0;
  const waived = o.waivedMinor ?? 0;
  await db
    .insertInto('charges')
    .values({
      id,
      member_id: o.memberId,
      branch_id: o.branchId,
      loan_id: null,
      item_id: null,
      kind: o.kind ?? 'overdue',
      description: o.description ?? 'Denda keterlambatan',
      amount_minor: o.amountMinor,
      paid_minor: paid,
      waived_minor: waived,
      currency: 'IDR',
      status: paid + waived >= o.amountMinor ? 'settled' : 'open',
      charged_on: o.chargedOn,
      charged_at: Date.parse(`${o.chargedOn}T03:00:00Z`),
      date_unknown: 0,
      source: 'system',
      created_at: AT,
      updated_at: AT,
    })
    .execute();
  return id;
}

/** A payment (minor units), received by `staffId`. */
export async function seedPayment(
  db: Db,
  o: { memberId: string; branchId: string; amountMinor: number; paidOn: string; method?: string; staffId?: string | null; seq: number; voided?: boolean },
): Promise<string> {
  const id = newId();
  const year = Number(o.paidOn.slice(0, 4));
  await db
    .insertInto('payments')
    .values({
      id,
      member_id: o.memberId,
      branch_id: o.branchId,
      receipt_year: year,
      receipt_seq: o.seq,
      receipt_no: `UT/${year}/${String(o.seq).padStart(6, '0')}`,
      amount_minor: o.amountMinor,
      currency: 'IDR',
      method: o.method ?? 'cash',
      paid_on: o.paidOn,
      paid_at: Date.parse(`${o.paidOn}T03:00:00Z`),
      received_by: o.staffId ?? null,
      note: null,
      voided_at: o.voided === true ? AT : null,
      voided_by: null,
      void_reason: o.voided === true ? 'Salah' : null,
      date_unknown: 0,
      source: 'desk',
      created_at: AT,
      updated_at: AT,
    })
    .execute();
  return id;
}

// ---- Komunitas K4 (stocktake) ----

/** A copy of a stocktake session: its state, its DDC statistics key, and who scanned it where (a copy scanned). */
export interface StocktakeCopy {
  itemId: string;
  state: 'pending' | 'found' | 'misplaced' | 'on_loan' | 'unexpected';
  statDdc?: string | null;
  scannedBy?: string | null;
  /** Where it was scanned: the copy's own location unless given. */
  scannedLocationId?: string | null;
}

/**
 * A finished stocktake session at `branchId` that changed no copy (neither option chosen): its copies (each copy's own
 * location and collection type, an unexpected one outside the expected list), its unknown codes, and the counters
 * its rows give.
 */
export async function seedStocktake(
  db: Db,
  o: { branchId: string; name: string; staffId?: string | null; copies: readonly StocktakeCopy[]; unknown?: readonly { code: string; scannedBy?: string | null }[] },
): Promise<string> {
  const id = newId();
  const finishedAt = AT + 3_600_000;
  const n = (f: (c: StocktakeCopy) => boolean): number => o.copies.filter(f).length;
  await db
    .insertInto('stocktakes')
    .values({
      id,
      branch_id: o.branchId,
      name: o.name,
      scope: '{}',
      status: 'finished',
      active_key: null,
      options: JSON.stringify({ markMissing: false, restoreFound: false }),
      total: n((c) => c.state !== 'unexpected'),
      found: n((c) => c.state === 'found' || c.state === 'misplaced'),
      misplaced: n((c) => c.state === 'misplaced'),
      on_loan: n((c) => c.state === 'on_loan'),
      unexpected: n((c) => c.state === 'unexpected'),
      unknown_codes: o.unknown?.length ?? 0,
      started_at: AT,
      started_by: o.staffId ?? null,
      finished_at: finishedAt,
      finished_by: o.staffId ?? null,
      source: 'altis',
      version: 2,
      created_at: AT,
      created_by: o.staffId ?? null,
      updated_at: finishedAt,
      updated_by: o.staffId ?? null,
    })
    .execute();
  for (const [k, c] of o.copies.entries()) {
    const item = await db.selectFrom('items').select(['location_id', 'collection_type_id', 'status']).where('id', '=', c.itemId).executeTakeFirstOrThrow();
    const expected = c.state !== 'unexpected';
    const scanned = c.state === 'found' || c.state === 'misplaced' || c.state === 'unexpected';
    await db
      .insertInto('stocktake_items')
      .values({
        stocktake_id: id,
        item_id: c.itemId,
        expected: expected ? 1 : 0,
        state: c.state,
        expected_location_id: item.location_id,
        expected_status: expected ? item.status : null,
        stat_ddc: expected ? (c.statDdc ?? null) : null,
        collection_type_id: expected ? item.collection_type_id : null,
        scanned_at: scanned ? AT + 60_000 * (k + 1) : null,
        scanned_by: scanned ? (c.scannedBy ?? null) : null,
        scanned_by_name: null,
        scanned_location_id: scanned ? (c.scannedLocationId === undefined ? item.location_id : c.scannedLocationId) : null,
        result: 'none',
      })
      .execute();
  }
  for (const [k, u] of (o.unknown ?? []).entries()) {
    const at = AT + 600_000 + 60_000 * k;
    await db
      .insertInto('stocktake_unknown_codes')
      .values({ stocktake_id: id, code_key: normalizeBarcode(u.code) || u.code, code_display: u.code, first_at: at, last_at: at, seen: 1, scanned_by: u.scannedBy ?? null })
      .execute();
  }
  return id;
}
