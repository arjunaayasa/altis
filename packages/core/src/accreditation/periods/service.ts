import type { AccredPeriodsTable, DB } from '@altis/db';
import { newId, type PeriodKind, type PeriodStatus, type ServiceCode } from '@altis/shared';
import {
  PeriodCreateBody,
  PeriodPatchBody,
  type AccredProfile,
  type PeriodListResponse,
  type PeriodSummaryView,
  type PeriodView,
} from '@altis/shared/api/accreditation';
import type { StoreResponse } from '@altis/shared/api/catalog/common';
import type { Kysely, Selectable, Transaction } from 'kysely';
import type { TxCtx } from '../../context.js';
import type { AccredSettings } from '../../settings/accreditation.js';
import { readSettings } from '../../settings/service.js';
import { instrumentById } from '../instruments/index.js';
import { AccredMetaPayload } from '../types.js';
import { parsePeriodBody, periodFieldErrors, periodNotFound, periodSpanRefused, periodStale } from './errors.js';
import { assertInstrumentFits, assertSchoolLevelFits } from './instruments-view.js';
import { catalogSyncedAt, lastUsageImport, latest, overlappingChange, periodLastChange, readSpanOf, sharedLastChange, spansOverlap } from './last-change.js';
import { lockOpenPeriod } from './lock.js';
import { assertProfilePhotos, copiedProfile, firstProfile, mergeProfile, profileJson, readProfile } from './profile.js';
import { periodSpan, spanMonths } from './span.js';

// The accreditation periods (spec §10.5, §10.6, §10.10): one per span of the whole library (no branch in this edition),
// with its instrument, the institution's profile, the school population and the library's facilities.
//
// - Create: the instrument must fit the library (instruments-view.ts) and take the period's kind; the span comes from
//   the kind (span.ts). The profile and the population and facility columns start as those of the period named in
//   `copyFromPeriodId`, else of the latest live period (the latest span); a first period starts from the library's
//   address only (profile.ts). The statement that every member of the school is registered is the librarian's for
//   each period, so it is never copied.
// - Update, archive (and the answers, answers.ts): the first statement of the transaction is the period lock
//   (lock.ts), so a frozen period refuses them with ACCRED_PERIOD_FROZEN and a write that read `open` cannot commit
//   after a freeze. Update then compares `version` (CONFLICT_STALE) and bumps it in the conditional UPDATE.
// - Audit: one entry per write (`accreditation.period.create|update|archive`, entity `accred_periods`) whose `meta`
//   holds codes and field names, never a profile value (the profile holds personal data).
// - Views: the period's last change (last-change.ts), when its results were computed (`_meta`), whether they are stale
//   (nothing computed, or a change at or after the computation), the last catalogue sync and the last usage import.

type PeriodRow = Selectable<AccredPeriodsTable>;
type Db = Kysely<DB>;

/** The indicator code of the row holding the evaluation's state in `accred_results`. */
const META_CODE = '_meta';
/** At most this many ids in one `IN (…)` list. */
const ID_CHUNK = 500;

/** The population and facility counts, as the body names them and as their columns. */
const COUNT_FIELDS = [
  ['students', 'students'],
  ['teachers', 'teachers'],
  ['eduStaff', 'edu_staff'],
  ['classes', 'classes'],
  ['populationServed', 'population_served'],
  ['teachersUsing', 'teachers_using'],
  ['userPcs', 'user_pcs'],
  ['staffPcs', 'staff_pcs'],
  ['ictDevices', 'ict_devices'],
  ['scanners', 'scanners'],
  ['floorM2', 'floor_m2'],
  ['bandwidthMbps', 'bandwidth_mbps'],
  ['hoursPerWeek', 'hours_per_week'],
] as const;

type CountField = (typeof COUNT_FIELDS)[number][0];
type CountColumn = (typeof COUNT_FIELDS)[number][1];

/** Every field of a PATCH, in the order the audit entry lists the changed ones. */
const PATCH_FIELDS = [
  'name',
  'profile',
  'students',
  'teachers',
  'eduStaff',
  'classes',
  'populationServed',
  'teachersUsing',
  'allRegisteredConfirmed',
  'userPcs',
  'staffPcs',
  'ictDevices',
  'scanners',
  'floorM2',
  'bandwidthMbps',
  'hoursPerWeek',
  'services',
  'externalWebsiteUrl',
] as const;

const num = (v: number | string | bigint | null): number | null => (v === null ? null : Number(v));

function servicesOf(json: string | null): ServiceCode[] | null {
  if (json === null) return null;
  const value: unknown = JSON.parse(json);
  return Array.isArray(value) ? (value as ServiceCode[]) : null;
}

/** The population and facility columns of a new period: those of `source`, else all empty. */
function copiedCounts(source: PeriodRow | undefined): Record<CountColumn, number | null> & { services: string | null; external_website_url: string | null } {
  const out = {} as Record<CountColumn, number | null>;
  for (const [, column] of COUNT_FIELDS) out[column] = source === undefined ? null : num(source[column]);
  return { ...out, services: source?.services ?? null, external_website_url: source?.external_website_url ?? null };
}

/** When the results of each of `ids` were computed (the `_meta` row's `computedAt`), for those that have one. */
async function computedAtOf(db: Db, ids: readonly string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const rows = await db
      .selectFrom('accred_results')
      .select(['period_id', 'payload'])
      .where('indicator_code', '=', META_CODE)
      .where('period_id', 'in', ids.slice(i, i + ID_CHUNK))
      .execute();
    for (const r of rows) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(r.payload);
      } catch {
        continue;
      }
      const meta = AccredMetaPayload.safeParse(parsed);
      if (meta.success && meta.data.computedAt !== undefined) out.set(r.period_id, meta.data.computedAt);
    }
  }
  return out;
}

/** Stale: nothing was computed, or something changed at or after the computation (equal times count as stale). */
const isStale = (computedAt: number | null, lastChangeAt: number | null): boolean => computedAt === null || (lastChangeAt !== null && lastChangeAt >= computedAt);

function summaryOf(row: PeriodRow, computedAt: number | null, lastChangeAt: number | null): PeriodSummaryView {
  return {
    id: row.id,
    name: row.name,
    instrumentId: row.instrument_id,
    kind: row.kind as PeriodKind,
    startsOn: row.starts_on,
    endsOn: row.ends_on,
    status: row.status as PeriodStatus,
    computedAt,
    stale: isStale(computedAt, lastChangeAt),
  };
}

/** The live periods, the latest span first. */
export async function listPeriods(db: Db): Promise<PeriodListResponse> {
  const rows = await db.selectFrom('accred_periods').selectAll().where('archived_at', 'is', null).orderBy('starts_on', 'desc').orderBy('id', 'desc').execute();
  if (rows.length === 0) return { periods: [] };
  const shared = await sharedLastChange(db);
  const computed = await computedAtOf(
    db,
    rows.map((r) => r.id),
  );
  const periods = rows.map((row) => {
    // Every live period is in `rows`: the latest change of those overlapping the days this one reads is read from them.
    const read = readSpanOf(row);
    const overlapping = latest(...rows.filter((o) => spansOverlap(o, read)).map((o) => Number(o.updated_at)));
    return summaryOf(row, computed.get(row.id) ?? null, latest(periodLastChange(row, overlapping), shared));
  });
  return { periods };
}

async function liveRow(db: Db, id: string): Promise<PeriodRow> {
  const row = await db.selectFrom('accred_periods').selectAll().where('id', '=', id).where('archived_at', 'is', null).executeTakeFirst();
  if (row === undefined) throw periodNotFound();
  return row;
}

/**
 * One live period with its last change, when its results were computed and whether they are stale, the last catalogue
 * sync and the last SLiMS usage import.
 *
 * @throws DomainError `NOT_FOUND` for an unknown or archived period
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- `now` is part of the shared signature; the view needs no clock
export async function getPeriod(db: Db, id: string, now: number): Promise<PeriodView> {
  const row = await liveRow(db, id);
  const lastChangeAt = latest(periodLastChange(row, await overlappingChange(db, row)), await sharedLastChange(db));
  const computedAt = (await computedAtOf(db, [id])).get(id) ?? null;
  return {
    id: row.id,
    name: row.name,
    instrumentId: row.instrument_id,
    kind: row.kind as PeriodKind,
    startsOn: row.starts_on,
    endsOn: row.ends_on,
    branchId: null,
    profile: readProfile(row.profile),
    students: num(row.students),
    teachers: num(row.teachers),
    eduStaff: num(row.edu_staff),
    classes: num(row.classes),
    populationServed: num(row.population_served),
    teachersUsing: num(row.teachers_using),
    allRegisteredConfirmed: Number(row.all_registered_confirmed) === 1,
    userPcs: num(row.user_pcs),
    staffPcs: num(row.staff_pcs),
    ictDevices: num(row.ict_devices),
    scanners: num(row.scanners),
    floorM2: num(row.floor_m2),
    bandwidthMbps: num(row.bandwidth_mbps),
    hoursPerWeek: num(row.hours_per_week),
    services: servicesOf(row.services),
    externalWebsiteUrl: row.external_website_url,
    status: row.status as PeriodStatus,
    frozenAt: num(row.frozen_at),
    frozenBy: row.frozen_by,
    version: Number(row.version),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    lastChangeAt,
    computedAt,
    stale: isStale(computedAt, lastChangeAt),
    catalogSyncedAt: await catalogSyncedAt(db),
    lastUsageImport: await lastUsageImport(db),
  };
}

/** The period a new one copies: the one named, else the latest live one; undefined when there is none. */
async function sourceOf(trx: Transaction<DB>, copyFromPeriodId: string | undefined): Promise<PeriodRow | undefined> {
  if (copyFromPeriodId !== undefined) {
    const row = await trx.selectFrom('accred_periods').selectAll().where('id', '=', copyFromPeriodId).where('archived_at', 'is', null).executeTakeFirst();
    if (row === undefined) throw periodFieldErrors([{ path: 'copyFromPeriodId', code: 'not_found' }]);
    return row;
  }
  return trx.selectFrom('accred_periods').selectAll().where('archived_at', 'is', null).orderBy('starts_on', 'desc').orderBy('id', 'desc').limit(1).executeTakeFirst();
}

/**
 * Creates an open period of the whole library at version 0 (see the top of this file). Answers `{id, version: 0}`;
 * audited `accreditation.period.create {instrumentId, kind, startsOn, endsOn, copiedFrom}`.
 *
 * @throws DomainError `VALIDATION_FAILED` (`instrumentId`/`not_found`, `copyFromPeriodId`/`not_found`,
 *   `branchId`/`branch_scope_not_available`, the span's inputs `required`, `profile.schoolLevel`/`required`, the
 *   contract's own); `ACCRED_INSTRUMENT_MISMATCH {libraryType, schoolLevel}`; `ACCRED_PERIOD_SPAN {kind, months}` for a
 *   kind the instrument does not take or a free span over 24 months
 */
export async function createPeriod(tx: TxCtx, body: PeriodCreateBody, settings: AccredSettings, now: number): Promise<StoreResponse> {
  const input = parsePeriodBody(PeriodCreateBody, body);
  const instrument = instrumentById(input.instrumentId);
  if (instrument === null) throw periodFieldErrors([{ path: 'instrumentId', code: 'not_found' }]);
  const span = periodSpan(input.kind, input, settings.schoolYearStartMonth);

  const { trx } = tx;
  const source = await sourceOf(trx, input.copyFromPeriodId);
  let base: AccredProfile;
  if (source !== undefined) {
    base = copiedProfile(readProfile(source.profile));
  } else {
    const address = (await readSettings(trx, ['library.address'], []))['library.address'];
    base = firstProfile(typeof address === 'string' ? address : null);
  }
  const profile = mergeProfile(base, input.profile);
  assertInstrumentFits(instrument, settings.libraryType, profile.schoolLevel ?? null);
  if (!instrument.periodKinds.includes(input.kind)) throw periodSpanRefused(input.kind, spanMonths(span));
  const json = profileJson(profile);

  const id = newId(now);
  await trx
    .insertInto('accred_periods')
    .values({
      id,
      branch_id: null,
      name: input.name,
      kind: input.kind,
      starts_on: span.startsOn,
      ends_on: span.endsOn,
      instrument_id: instrument.id,
      status: 'open',
      frozen_at: null,
      frozen_by: null,
      profile: json,
      ...copiedCounts(source),
      all_registered_confirmed: 0,
      archived_at: null,
      version: 0,
      created_at: now,
      created_by: tx.actor.id,
      updated_at: now,
      updated_by: tx.actor.id,
    })
    .execute();
  await tx.audit({
    action: 'accreditation.period.create',
    entity: 'accred_periods',
    entityId: id,
    meta: { instrumentId: instrument.id, kind: input.kind, startsOn: span.startsOn, endsOn: span.endsOn, copiedFrom: source?.id ?? null },
  });
  return { id, version: 0 };
}

/** The value of PATCH field `field` as it would be stored, for the comparison with the row. */
function storedForm(field: (typeof PATCH_FIELDS)[number], value: unknown): unknown {
  if (field === 'allRegisteredConfirmed') return value === true ? 1 : 0;
  if (field === 'services') return value === null ? null : JSON.stringify(value);
  return value;
}

/** The stored value of PATCH field `field` in `row`, in its stored form. */
function rowValue(row: PeriodRow, field: (typeof PATCH_FIELDS)[number]): unknown {
  switch (field) {
    case 'name':
      return row.name;
    case 'profile':
      return row.profile;
    case 'allRegisteredConfirmed':
      return Number(row.all_registered_confirmed);
    case 'services':
      return row.services;
    case 'externalWebsiteUrl':
      return row.external_website_url;
    default:
      return num(row[COUNT_FIELDS.find(([f]) => f === field)![1]]);
  }
}

/**
 * Changes what `body` sends of period `id`; `body.version` is the period's. A profile changes the fields it names
 * (profile.ts); its school level must stay one the instrument is for, and its photos must be this period's profile
 * evidence (JPEG). `teachersUsing` may not exceed `teachers` (as they are after the change). Answers `{id, version}`;
 * audited `accreditation.period.update {fields}` (the names of the fields whose value changed).
 *
 * @throws DomainError `NOT_FOUND`, `ACCRED_PERIOD_FROZEN` (from the lock); `CONFLICT_STALE`; `ACCRED_INSTRUMENT_MISMATCH`;
 *   `VALIDATION_FAILED` (`profile.schoolLevel`/`required`, `profile.photos.<slot>` `not_found`|`invalid`,
 *   `teachersUsing`/`too_big`, `profile`/`too_big`, the contract's own)
 */
export async function updatePeriod(tx: TxCtx, id: string, body: PeriodPatchBody, settings: AccredSettings, now: number): Promise<StoreResponse> {
  const input = parsePeriodBody(PeriodPatchBody, body);
  const { trx } = tx;
  await lockOpenPeriod(trx, id);
  const row = await liveRow(trx, id);
  if (Number(row.version) !== input.version) throw periodStale();

  const set: Partial<Record<string, unknown>> = {};
  if (input.name !== undefined) set['name'] = input.name;
  if (input.profile !== undefined) {
    const instrument = instrumentById(row.instrument_id);
    if (instrument !== null && input.profile.schoolLevel !== undefined) assertSchoolLevelFits(instrument, settings.libraryType, input.profile.schoolLevel);
    await assertProfilePhotos(trx, id, input.profile.photos);
    set['profile'] = profileJson(mergeProfile(readProfile(row.profile), input.profile));
  }
  for (const [field, column] of COUNT_FIELDS) {
    const value = input[field as CountField];
    if (value !== undefined) set[column] = value;
  }
  if (input.allRegisteredConfirmed !== undefined) set['all_registered_confirmed'] = input.allRegisteredConfirmed ? 1 : 0;
  if (input.services !== undefined) set['services'] = input.services === null ? null : JSON.stringify(input.services);
  if (input.externalWebsiteUrl !== undefined) set['external_website_url'] = input.externalWebsiteUrl;

  const teachers = input.teachers !== undefined ? input.teachers : num(row.teachers);
  const teachersUsing = input.teachersUsing !== undefined ? input.teachersUsing : num(row.teachers_using);
  if ((input.teachers !== undefined || input.teachersUsing !== undefined) && teachers !== null && teachersUsing !== null && teachersUsing > teachers) {
    throw periodFieldErrors([{ path: 'teachersUsing', code: 'too_big' }]);
  }

  const fields = PATCH_FIELDS.filter((field) => {
    if (input[field] === undefined) return false;
    const next = field === 'profile' ? set['profile'] : storedForm(field, input[field]);
    return next !== rowValue(row, field);
  });

  const updated = await trx
    .updateTable('accred_periods')
    .set((eb) => ({ ...set, updated_at: now, updated_by: tx.actor.id, version: eb('version', '+', 1) }))
    .where('id', '=', id)
    .where('version', '=', input.version)
    .executeTakeFirst();
  if (Number(updated.numUpdatedRows) !== 1) throw periodStale();
  await tx.audit({ action: 'accreditation.period.update', entity: 'accred_periods', entityId: id, meta: { fields } });
  return { id, version: input.version + 1 };
}

/**
 * Archives period `id` (`archived_at`; gone from the list and its page). Answers `{id, version}`; audited
 * `accreditation.period.archive {}`.
 *
 * @throws DomainError `NOT_FOUND` (unknown or already archived), `ACCRED_PERIOD_FROZEN` (from the lock)
 */
export async function archivePeriod(tx: TxCtx, id: string, now: number): Promise<StoreResponse> {
  const { trx } = tx;
  await lockOpenPeriod(trx, id);
  const row = await liveRow(trx, id);
  const version = Number(row.version);
  const updated = await trx
    .updateTable('accred_periods')
    .set((eb) => ({ archived_at: now, updated_at: now, updated_by: tx.actor.id, version: eb('version', '+', 1) }))
    .where('id', '=', id)
    .where('version', '=', version)
    .where('archived_at', 'is', null)
    .executeTakeFirst();
  if (Number(updated.numUpdatedRows) !== 1) throw periodStale();
  await tx.audit({ action: 'accreditation.period.archive', entity: 'accred_periods', entityId: id, meta: {} });
  return { id, version: version + 1 };
}
