import { sumGrouped, upsert, type DB } from '@altis/db';
import { DomainError, isUlid, newId, type VisitPurpose, type VisitSource } from '@altis/shared';
import type { AccredGroup } from '@altis/shared';
import type { FieldWarning } from '@altis/shared/api/catalog/common';
import type {
  VisitCheckinBody,
  VisitCheckinResponse,
  VisitCreateBody,
  VisitCreateResponse,
  VisitListQuery,
  VisitListResponse,
  VisitSummary,
  VisitSummaryQuery,
  VisitView,
} from '@altis/shared/api/visits';
import type { Selectable } from 'kysely';
import { branchToday } from '../circulation/dates.js';
import type { TxCtx } from '../context.js';
import { libraryToday, memberStatusOf, memberValidationFailed, type Db } from '../members/common.js';
import { memberNoProblem, normalizeMemberNo } from '../members/keys.js';
import { readSettings } from '../settings/service.js';

// Visits: one row per check-in (or a group's head count) at a branch, on a calendar date of the branch's time zone.
//
// - A check-in by member number (at a station, or by staff) locks the member with a write that changes nothing (by its
//   number, matching only a live member), so two check-ins of one member serialise and the repeat window below is
//   decided on the latest commit. A number no live member holds records nothing (`unknown`). An expired or suspended
//   member is recorded all the same; the answer says so for the greeting.
// - Repeat window (`visits.dedupeMinutes`, default 60, 0 = off): a member with a visit of any source at the same branch
//   within that many minutes is greeted but not counted (`repeat`, no row). Guests are never repeats.
// - A member's visit keeps the member type, its population group and the member's class of that day, so counts per
//   type, group and class stay right after the member changes or is anonymised. A guest counts as `guest`.
// - The desk and the OPAC sign-in add a visit for a member's first action of the day at a branch (recordMemberDayVisit,
//   the seam the circulation desk and the member area call): at most one per member, branch and day through the unique
//   `day_key`, skipped when the member has any visit there that day, and never failing the action it follows (a
//   unique violation is absorbed by upsert()'s savepoint).
// - A wrong entry is voided, never deleted; every count leaves voided visits out.

type VisitRow = Selectable<DB['visits']>;

/** A visit is gone for the route (none, or another branch's). */
export function visitNotFound(): DomainError {
  return new DomainError('NOT_FOUND', { detail: 'Kunjungan tidak ditemukan / Visit not found' });
}

/** The visit settings a check-in reads. */
async function visitSettings(db: Db): Promise<{ dedupeMinutes: number; fromDesk: boolean; fromOnline: boolean }> {
  const s = await readSettings(db, ['visits.dedupeMinutes', 'visits.fromDesk', 'visits.fromOnline'], []);
  return { dedupeMinutes: s['visits.dedupeMinutes'] as number, fromDesk: s['visits.fromDesk'] as boolean, fromOnline: s['visits.fromOnline'] as boolean };
}

/** The first word of a name, for a greeting (never the whole name). */
export function firstNameOf(name: string): string {
  return name.trim().split(/\s+/u)[0] ?? '';
}

/** A field error unless `locationId` is a live location of `branchId`. */
async function locationProblem(db: Db, branchId: string, locationId: string): Promise<FieldWarning | null> {
  const row = await db.selectFrom('locations').select(['branch_id', 'archived_at']).where('id', '=', locationId).executeTakeFirst();
  return row === undefined || row.archived_at !== null || row.branch_id !== branchId ? { path: 'locationId', code: 'not_found' } : null;
}

/** The member a check-in names, locked (see the top of this file), with what the visit row keeps; null: no live member. */
async function lockMemberByNo(
  tx: TxCtx,
  raw: string,
): Promise<{ id: string; name: string; typeId: string; group: string | null; className: string | null; status: string; expiresOn: string | null; photoFileId: string | null } | null> {
  const key = normalizeMemberNo(raw);
  if (memberNoProblem(key) !== null) return null;
  const locked = await tx.trx
    .updateTable('members')
    .set((eb) => ({ version: eb.ref('version') }))
    .where('member_no_key', '=', key)
    .where('archived_at', 'is', null)
    .where('anonymized_at', 'is', null)
    .executeTakeFirst();
  if (Number(locked.numUpdatedRows) !== 1) return null;
  const m = await tx.trx
    .selectFrom('members as m')
    .leftJoin('member_types as t', 't.id', 'm.member_type_id')
    .select(['m.id', 'm.name', 'm.member_type_id', 't.accred_group', 'm.class_name', 'm.status', 'm.expires_on', 'm.photo_file_id'])
    .where('m.member_no_key', '=', key)
    .executeTakeFirstOrThrow();
  return {
    id: m.id,
    name: m.name,
    typeId: m.member_type_id,
    group: m.accred_group ?? null,
    className: m.class_name,
    status: m.status,
    expiresOn: m.expires_on,
    photoFileId: m.photo_file_id,
  };
}

/** Whether the member has a visit (not voided) at the branch since `since` (epoch ms). */
async function visitedSince(db: Db, memberId: string, branchId: string, since: number): Promise<boolean> {
  const row = await db
    .selectFrom('visits')
    .select('id')
    .where('member_id', '=', memberId)
    .where('branch_id', '=', branchId)
    .where('visited_at', '>=', since)
    .where('voided_at', 'is', null)
    .limit(1)
    .executeTakeFirst();
  return row !== undefined;
}

/** What a check-in records. */
export interface CheckinInput {
  branchId: string;
  source: 'station' | 'manual';
  stationId?: string | null;
  locationId?: string | null;
  memberNo?: string;
  guest?: { name: string; institution: string };
  purpose?: VisitPurpose | null;
}

/** The answer of a check-in, and for a station the member's photo when the library shows it. */
export interface CheckinResult extends VisitCheckinResponse {
  photoFileId: string | null;
}

/**
 * Records a check-in (see the top of this file): a member by number, or a guest. Not audited (a count, not a change).
 *
 * @throws DomainError VALIDATION_FAILED `{path: 'locationId', code: 'not_found'}`
 */
export async function checkIn(tx: TxCtx, input: CheckinInput): Promise<CheckinResult> {
  const { trx } = tx;
  const base = {
    branch_id: input.branchId,
    location_id: input.locationId ?? null,
    visited_at: tx.now,
    purpose: input.purpose ?? null,
    headcount: 1,
    is_repeat: 0,
    station_id: input.stationId ?? null,
    day_key: null,
    note: null,
    voided_at: null,
    voided_by: null,
    created_by: tx.actor.type === 'staff' ? tx.actor.id : null,
  };
  if (input.guest !== undefined) {
    if (input.locationId !== undefined && input.locationId !== null) {
      const e = await locationProblem(trx, input.branchId, input.locationId);
      if (e !== null) throw memberValidationFailed([e]);
    }
    const id = newId(tx.now);
    await trx
      .insertInto('visits')
      .values({
        id,
        ...base,
        visited_on: await branchToday(trx, input.branchId, tx.now),
        source: input.source,
        member_id: null,
        member_type_id: null,
        accred_group: 'guest',
        class_name: null,
        guest_name: input.guest.name,
        guest_institution: input.guest.institution,
      })
      .execute();
    return { outcome: 'recorded', visitId: id, firstName: firstNameOf(input.guest.name), expired: false, suspended: false, photoFileId: null };
  }

  const member = input.memberNo === undefined ? null : await lockMemberByNo(tx, input.memberNo);
  if (member === null) return { outcome: 'unknown', visitId: null, firstName: null, expired: false, suspended: false, photoFileId: null };
  if (input.locationId !== undefined && input.locationId !== null) {
    const e = await locationProblem(trx, input.branchId, input.locationId);
    if (e !== null) throw memberValidationFailed([e]);
  }
  const today = await branchToday(trx, input.branchId, tx.now);
  const shown = memberStatusOf({ anonymized_at: null, archived_at: null, status: member.status, expires_on: member.expiresOn }, today);
  const answer = {
    firstName: firstNameOf(member.name),
    expired: shown === 'expired',
    suspended: shown === 'suspended',
    photoFileId: member.photoFileId,
  };
  const { dedupeMinutes } = await visitSettings(trx);
  if (dedupeMinutes > 0 && (await visitedSince(trx, member.id, input.branchId, tx.now - dedupeMinutes * 60_000))) {
    return { outcome: 'repeat', visitId: null, ...answer };
  }
  const id = newId(tx.now);
  await trx
    .insertInto('visits')
    .values({
      id,
      ...base,
      visited_on: today,
      source: input.source,
      member_id: member.id,
      member_type_id: member.typeId,
      accred_group: member.group,
      class_name: member.className,
      guest_name: null,
      guest_institution: null,
    })
    .execute();
  if (input.stationId !== undefined && input.stationId !== null) {
    await trx.updateTable('visit_stations').set({ last_seen_at: tx.now }).where('id', '=', input.stationId).execute();
  }
  return { outcome: 'recorded', visitId: id, ...answer };
}

/** A staff check-in at `branchId` (see {@link checkIn}). */
export function staffCheckIn(tx: TxCtx, branchId: string, body: VisitCheckinBody): Promise<CheckinResult> {
  return checkIn(tx, {
    branchId,
    source: 'manual',
    locationId: body.locationId ?? null,
    ...(body.memberNo === undefined ? {} : { memberNo: body.memberNo }),
    ...(body.guest === undefined ? {} : { guest: body.guest }),
    purpose: body.purpose ?? null,
  });
}

/**
 * Records a manual visit at `branchId`: a member (by number), a guest, or a class or group with its head count.
 * Audit `visits.visit.create`. For a class visit the answer counts the members of that class with a visit of their own
 * at this branch that day (the screen warns that the class visit counts them again).
 *
 * @throws DomainError NOT_FOUND (no live member has the number); VALIDATION_FAILED (`visitedOn` `future`, `locationId`
 *   `not_found`)
 */
export async function createManualVisit(tx: TxCtx, branchId: string, body: VisitCreateBody): Promise<VisitCreateResponse> {
  const { trx } = tx;
  let member: Awaited<ReturnType<typeof lockMemberByNo>> = null;
  if (body.memberNo !== undefined) {
    member = await lockMemberByNo(tx, body.memberNo);
    if (member === null) throw new DomainError('NOT_FOUND', { detail: 'Anggota tidak ditemukan / Member not found' });
  }
  const today = await branchToday(trx, branchId, tx.now);
  const errors: FieldWarning[] = [];
  if (body.visitedOn !== undefined && body.visitedOn > today) errors.push({ path: 'visitedOn', code: 'future' });
  if (body.locationId !== undefined) {
    const e = await locationProblem(trx, branchId, body.locationId);
    if (e !== null) errors.push(e);
  }
  if (errors.length > 0) throw memberValidationFailed(errors);
  const visitedOn = body.visitedOn ?? today;
  const id = newId(tx.now);
  const isClass = member === null && body.guest === undefined;
  await trx
    .insertInto('visits')
    .values({
      id,
      branch_id: branchId,
      location_id: body.locationId ?? null,
      visited_on: visitedOn,
      visited_at: tx.now,
      source: 'manual',
      member_id: member?.id ?? null,
      member_type_id: member?.typeId ?? null,
      accred_group: member !== null ? member.group : body.guest !== undefined ? 'guest' : null,
      class_name: member !== null ? member.className : (body.className ?? null),
      guest_name: body.guest?.name ?? null,
      guest_institution: body.guest?.institution ?? null,
      purpose: body.purpose ?? null,
      headcount: isClass ? body.headcount : 1,
      is_repeat: 0,
      station_id: null,
      day_key: null,
      note: body.note === undefined || body.note === '' ? null : body.note,
      voided_at: null,
      voided_by: null,
      created_by: tx.actor.id,
    })
    .execute();
  let classCheckedIn = 0;
  if (isClass && body.className !== undefined) {
    const rows = await trx
      .selectFrom('visits')
      .select('member_id')
      .distinct()
      .where('branch_id', '=', branchId)
      .where('visited_on', '=', visitedOn)
      .where('class_name', '=', body.className)
      .where('member_id', 'is not', null)
      .where('voided_at', 'is', null)
      .execute();
    classCheckedIn = rows.length;
  }
  await tx.audit({ action: 'visits.visit.create', entity: 'visits', entityId: id, branchId, meta: { kind: member !== null ? 'member' : body.guest !== undefined ? 'guest' : 'group', headcount: isClass ? body.headcount : 1 } });
  return { id, classCheckedIn };
}

/**
 * Voids the visit `id` of `branchId` (a voided one stays voided). Audit `visits.visit.void`.
 *
 * @throws DomainError NOT_FOUND
 */
export async function voidVisit(tx: TxCtx, branchId: string, id: string): Promise<void> {
  const updated = await tx.trx
    .updateTable('visits')
    .set({ voided_at: tx.now, voided_by: tx.actor.id })
    .where('id', '=', id)
    .where('branch_id', '=', branchId)
    .where('voided_at', 'is', null)
    .executeTakeFirst();
  if (Number(updated.numUpdatedRows) !== 1) {
    const row = await tx.trx.selectFrom('visits').select('id').where('id', '=', id).where('branch_id', '=', branchId).executeTakeFirst();
    if (row === undefined) throw visitNotFound();
  }
  await tx.audit({ action: 'visits.visit.void', entity: 'visits', entityId: id, branchId, meta: {} });
}

/**
 * The desk's and the OPAC sign-in's visit (see the top of this file): records a visit of `source` for the member at the
 * branch on `visitedOn` (default today at the branch) unless the library turned the source off, or the member has a
 * visit there that day. Never throws for a visit that already exists. Call it inside the action's transaction, after
 * its own locks.
 *
 * @returns whether a visit was recorded
 */
export async function recordMemberDayVisit(
  tx: TxCtx,
  input: { source: 'desk' | 'online'; memberId: string; branchId: string; visitedOn?: string },
): Promise<boolean> {
  const { trx } = tx;
  const settings = await visitSettings(trx);
  if ((input.source === 'desk' && !settings.fromDesk) || (input.source === 'online' && !settings.fromOnline)) return false;
  const visitedOn = input.visitedOn ?? (await branchToday(trx, input.branchId, tx.now));
  const existing = await trx
    .selectFrom('visits')
    .select('id')
    .where('member_id', '=', input.memberId)
    .where('branch_id', '=', input.branchId)
    .where('visited_on', '=', visitedOn)
    .where('voided_at', 'is', null)
    .limit(1)
    .executeTakeFirst();
  if (existing !== undefined) return false;
  const m = await trx
    .selectFrom('members as m')
    .leftJoin('member_types as t', 't.id', 'm.member_type_id')
    .select(['m.member_type_id', 't.accred_group', 'm.class_name'])
    .where('m.id', '=', input.memberId)
    .executeTakeFirst();
  if (m === undefined) return false;
  const dayKey = `${input.source}:${input.memberId}:${input.branchId}:${visitedOn}`;
  const outcome = await upsert(
    trx,
    'visits',
    { day_key: dayKey },
    {
      id: newId(tx.now),
      branch_id: input.branchId,
      location_id: null,
      visited_on: visitedOn,
      visited_at: tx.now,
      source: input.source,
      member_id: input.memberId,
      member_type_id: m.member_type_id,
      accred_group: m.accred_group ?? null,
      class_name: m.class_name,
      guest_name: null,
      guest_institution: null,
      purpose: null,
      headcount: 1,
      is_repeat: 0,
      station_id: null,
      note: null,
      voided_at: null,
      voided_by: null,
      created_by: tx.actor.type === 'staff' ? tx.actor.id : null,
    },
    // An existing row of the key stays as it is (the value written is its own key).
    { day_key: dayKey },
  );
  return outcome === 'inserted';
}

// ---- read ------------------------------------------------------------------------------------------------------------

function badCursor(): DomainError {
  return memberValidationFailed([{ path: 'cursor', code: 'invalid' }]);
}

/**
 * Visits by `q`, newest first, keyset paged by the cursor `<visited_at>.<id>` of the last one; with the member's
 * number and name for staff.
 *
 * @throws DomainError VALIDATION_FAILED (`cursor`)
 */
export async function listVisits(db: Db, q: VisitListQuery): Promise<VisitListResponse> {
  let query = db
    .selectFrom('visits as v')
    .leftJoin('members as m', 'm.id', 'v.member_id')
    .selectAll('v')
    .select(['m.member_no_display', 'm.name as member_name']);
  if (q.branchId !== undefined) query = query.where('v.branch_id', '=', q.branchId);
  if (q.from !== undefined) query = query.where('v.visited_on', '>=', q.from);
  if (q.to !== undefined) query = query.where('v.visited_on', '<=', q.to);
  if (q.source !== undefined) query = query.where('v.source', '=', q.source);
  if (q.memberId !== undefined) query = query.where('v.member_id', '=', q.memberId);
  if (q.includeVoided !== true) query = query.where('v.voided_at', 'is', null);
  if (q.cursor !== undefined) {
    const m = /^(\d{1,15})\.([0-9A-Z]{26})$/.exec(q.cursor);
    if (m === null || !isUlid(m[2]!)) throw badCursor();
    const at = Number(m[1]);
    const after = m[2]!;
    query = query.where((eb) => eb.or([eb('v.visited_at', '<', at), eb.and([eb('v.visited_at', '=', at), eb('v.id', '<', after)])]));
  }
  const rows = await query.orderBy('v.visited_at', 'desc').orderBy('v.id', 'desc').limit(q.limit + 1).execute();
  const page = rows.slice(0, q.limit);
  const items = page.map((r) => visitView(r, r.member_no_display ?? null, r.member_name ?? null));
  const last = page[page.length - 1];
  return { items, nextCursor: rows.length > q.limit && last !== undefined ? `${Number(last.visited_at)}.${last.id}` : null };
}

function visitView(r: VisitRow, memberNo: string | null, memberName: string | null): VisitView {
  return {
    id: r.id,
    branchId: r.branch_id,
    locationId: r.location_id,
    visitedOn: r.visited_on,
    visitedAt: Number(r.visited_at),
    source: r.source as VisitSource,
    memberId: r.member_id,
    memberNo,
    memberName,
    memberTypeId: r.member_type_id,
    accredGroup: r.accred_group as AccredGroup | 'guest' | 'unknown' | null,
    className: r.class_name,
    guestName: r.guest_name,
    guestInstitution: r.guest_institution,
    purpose: r.purpose as VisitPurpose | null,
    headcount: Number(r.headcount),
    isRepeat: Number(r.is_repeat) === 1,
    stationId: r.station_id,
    note: r.note,
    voided: r.voided_at !== null,
  };
}

/** The people (head counts, voided visits left out) of one day at a branch (or every branch), per source. */
export async function visitSummary(db: Db, q: VisitSummaryQuery, now: number): Promise<VisitSummary> {
  const on = q.on ?? (q.branchId !== undefined ? await branchToday(db, q.branchId, now) : await libraryToday(db, now));
  let base = db.selectFrom('visits').where('visited_on', '=', on).where('voided_at', 'is', null);
  if (q.branchId !== undefined) base = base.where('branch_id', '=', q.branchId);
  const rows = await sumGrouped(base, { source: 'source', accred_group: 'accred_group' }, 'headcount');
  const bySource: Partial<Record<VisitSource, number>> = {};
  let total = 0;
  let guests = 0;
  let members = 0;
  for (const r of rows) {
    const source = String(r.source) as VisitSource;
    bySource[source] = (bySource[source] ?? 0) + r.sum;
    total += r.sum;
    if (r.accred_group === 'guest') guests += r.sum;
    else members += r.sum;
  }
  return { on, total, members, guests, bySource };
}

