/**
 * The visits API: the visit list and today's summary (library-wide reading), staff check-ins, manual and class
 * visits and voiding at a branch, and the guestbook stations of a branch (create, a one-time activation code, revoke).
 *
 * - A visit belongs to a branch: the routes that write are `branches/:branchId/visits/...`, and a visit or station id
 *   of another branch is 404.
 * - A check-in by member number records the member's type, population group and class as they are that day. A repeat
 *   check-in of the same member at the same branch within `visits.dedupeMinutes` is greeted but not counted. A guest
 *   needs a name and an institution and is never treated as a repeat.
 * - A voided visit stays stored and is left out of every count.
 * - An activation code is shown once, in the answer that made it: 8 characters, valid 10 minutes, one use. A new code
 *   or a revocation ends the station's earlier pairing.
 *
 * No Node built-ins here: the browser bundles this module. Import it as `@altis/shared/api/visits`.
 */
import { z } from 'zod';
import type { AccredGroup } from '../accreditation-vocab.js';
import { VISIT_PURPOSES, VISIT_SOURCES, type VisitPurpose, type VisitSource } from '../visits-vocab.js';
import { ulidField } from './common.js';
import { cursorQuery, dateField, shortText, type Paged } from './catalog/common.js';
import { rawMemberNoField } from './members.js';

/** A guest's name and institution (both required). */
export const GuestField = z.strictObject({ name: shortText(191).min(1), institution: shortText(191).min(1) });

export type GuestField = z.infer<typeof GuestField>;

/** The largest head count of one manual (class or group) visit. */
export const VISIT_HEADCOUNT_MAX = 1000;

/**
 * `POST branches/:branchId/visits/checkin` (a staff check-in; not audited) → `VisitCheckinResponse`. Exactly one of
 * `memberNo` and `guest` (`{path: 'memberNo', code: 'required'}` for neither, `not_allowed` for both).
 */
export const VisitCheckinBody = z
  .strictObject({
    memberNo: rawMemberNoField.optional(),
    guest: GuestField.optional(),
    purpose: z.enum(VISIT_PURPOSES).optional(),
    locationId: ulidField.optional(),
  })
  .check((ctx) => {
    const { memberNo, guest } = ctx.value;
    if (memberNo === undefined && guest === undefined) {
      ctx.issues.push({ code: 'custom', path: ['memberNo'], params: { code: 'required' }, message: 'required', input: ctx.value });
    } else if (memberNo !== undefined && guest !== undefined) {
      ctx.issues.push({ code: 'custom', path: ['guest'], params: { code: 'not_allowed' }, message: 'not_allowed', input: ctx.value });
    }
  });

export type VisitCheckinBody = z.infer<typeof VisitCheckinBody>;

/**
 * What a check-in did: `recorded` (a new visit), `repeat` (the member checked in within the repeat window: greeted, not
 * counted), `unknown` (no live member has the number: nothing recorded). `firstName` is the member's first name for
 * the greeting; `expired` and `suspended` say what to tell the member (the visit is recorded either way).
 */
export interface VisitCheckinResponse {
  outcome: 'recorded' | 'repeat' | 'unknown';
  visitId: string | null;
  firstName: string | null;
  expired: boolean;
  suspended: boolean;
}

/**
 * `POST branches/:branchId/visits` (a manual visit) → 201 `{id}`: exactly one of a member (`memberNo`), a guest
 * (`guest`), or a class or group (`className` and/or `headcount` > 1, with an optional `note`). `visitedOn` (default
 * today in the branch's time zone) may not be in the future.
 */
export const VisitCreateBody = z
  .strictObject({
    memberNo: rawMemberNoField.optional(),
    guest: GuestField.optional(),
    className: shortText(64).min(1).optional(),
    headcount: z.int().min(1).max(VISIT_HEADCOUNT_MAX).default(1),
    purpose: z.enum(VISIT_PURPOSES).optional(),
    locationId: ulidField.optional(),
    visitedOn: dateField.optional(),
    note: shortText(191).optional(),
  })
  .check((ctx) => {
    const { memberNo, guest, className, headcount } = ctx.value;
    const kinds = [memberNo !== undefined, guest !== undefined, className !== undefined || headcount > 1].filter(Boolean).length;
    if (kinds === 0) ctx.issues.push({ code: 'custom', path: ['memberNo'], params: { code: 'required' }, message: 'required', input: ctx.value });
    if (kinds > 1) ctx.issues.push({ code: 'custom', path: ['className'], params: { code: 'not_allowed' }, message: 'not_allowed', input: ctx.value });
  });

export type VisitCreateBody = z.infer<typeof VisitCreateBody>;

/** `POST branches/:branchId/visits` answers the new visit's id (and how many members of the class checked in today already). */
export interface VisitCreateResponse {
  id: string;
  /** For a class visit: members of that class with a visit of their own at this branch today. */
  classCheckedIn: number;
}

/** `GET visits`: newest first, keyset paged; `from`/`to` are calendar dates (both included). */
export const VisitListQuery = z.strictObject({
  branchId: ulidField.optional(),
  from: dateField.optional(),
  to: dateField.optional(),
  source: z.enum(VISIT_SOURCES).optional(),
  memberId: ulidField.optional(),
  includeVoided: z.stringbool().optional(),
  ...cursorQuery,
});

export type VisitListQuery = z.infer<typeof VisitListQuery>;

/** One visit as staff see it. */
export interface VisitView {
  id: string;
  branchId: string;
  locationId: string | null;
  visitedOn: string;
  visitedAt: number;
  source: VisitSource;
  memberId: string | null;
  memberNo: string | null;
  memberName: string | null;
  memberTypeId: string | null;
  accredGroup: AccredGroup | 'guest' | 'unknown' | null;
  className: string | null;
  guestName: string | null;
  guestInstitution: string | null;
  purpose: VisitPurpose | null;
  headcount: number;
  isRepeat: boolean;
  stationId: string | null;
  note: string | null;
  voided: boolean;
}

export type VisitListResponse = Paged<VisitView>;

/** `GET visits/summary`: the counts of one day (`on`, default today) at a branch (or every branch). */
export const VisitSummaryQuery = z.strictObject({ branchId: ulidField.optional(), on: dateField.optional() });

export type VisitSummaryQuery = z.infer<typeof VisitSummaryQuery>;

/** The visits of one day: people (head counts, voided left out) in all, per source, members and guests. */
export interface VisitSummary {
  on: string;
  total: number;
  members: number;
  guests: number;
  bySource: Partial<Record<VisitSource, number>>;
}

// ---- stations --------------------------------------------------------------------------------------------------------

/** `POST branches/:branchId/visits/stations` → 201 `StationCodeResponse` (the first activation code). */
export const StationCreateBody = z.strictObject({ name: shortText(191).min(1), locationId: ulidField.nullable().optional() });

export type StationCreateBody = z.infer<typeof StationCreateBody>;

/** A station's activation code (8 characters, shown once) and when it stops working. */
export interface StationCodeResponse {
  id: string;
  code: string;
  expiresAt: number;
}

/** `GET visits/stations`: every station, newest first; `branchId` narrows them. */
export const StationListQuery = z.strictObject({ branchId: ulidField.optional(), includeRevoked: z.stringbool().optional() });

export type StationListQuery = z.infer<typeof StationListQuery>;

export interface StationView {
  id: string;
  branchId: string;
  locationId: string | null;
  name: string;
  /** Paired now (activated, not revoked, not replaced by a newer code). */
  paired: boolean;
  /** An activation code is waiting to be used (until `codeExpiresAt`). */
  codeExpiresAt: number | null;
  activatedAt: number | null;
  lastSeenAt: number | null;
  revokedAt: number | null;
  createdAt: number;
}

export interface StationListResponse {
  items: StationView[];
}

/** The characters of an activation code (base32, no padding): it is typed on the station in capitals. */
export const ACTIVATION_CODE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
/** An activation code's length. */
export const ACTIVATION_CODE_LENGTH = 8;
/** How long an activation code works. */
export const ACTIVATION_CODE_TTL_MS = 10 * 60_000;

/** An activation code as typed: spaces and dashes dropped, letters upper case. */
export function normalizeActivationCode(raw: string): string {
  return raw.replace(/[\s-]+/g, '').toUpperCase();
}

/** The station's activation form: the code as typed. */
export const StationActivateForm = z.strictObject({ code: z.string().max(32) });

/** The guestbook check-in form: a member number, or the guest fields after "I am a guest". */
export const StationCheckinForm = z.strictObject({
  memberNo: z.string().max(200).optional(),
  guestName: z.string().max(191).optional(),
  guestInstitution: z.string().max(191).optional(),
  purpose: z.string().max(16).optional(),
  guest: z.literal('1').optional(),
});
