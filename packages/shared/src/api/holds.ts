/**
 * The holds API: title-level holds queued per record and pickup branch, the hold shelf (rak tunggu) of a branch, and
 * the hold list.
 *
 * - A hold is on a title (a record); it may be pinned to one copy (`itemId`). The queue of a title at a pickup branch
 *   is ordered by the time the hold was placed, then its id; a waiting hold's `position` is the number of waiting holds
 *   before it plus one.
 * - A member has at most one active (`waiting` or `ready`) hold per title, and at most the member type's `holds_limit`
 *   active holds. A desk places a hold for pickup at its own branch.
 * - A returned copy whose title has a waiting hold at the copy's branch is kept for the first in the queue: the hold
 *   becomes `ready` with a pickup deadline (`pickupUntil`, `circulation.holds.pickupDays` days after the day it was
 *   kept) and the return answers who it is kept for. Staff may also mark a waiting hold ready by scanning a copy on the
 *   shelf. A kept copy can only be lent to that member (else 409 CIRC_ITEM_ON_HOLD); a renewal is refused while the
 *   title has a waiting hold at the loan's branch. A hold not picked up in time expires (a job runs every 15 minutes) and
 *   the copy is kept for the next in the queue, else it is listed to go back to the shelf.
 * - Every refusal is 409 CIRC_HOLD_REFUSED `{reason}` (HOLD_REFUSALS).
 * - Personal data never travels in a URL: a member is named by id.
 *
 * No Node built-ins here: the browser bundles this module. Import it as `@altis/shared/api/holds`.
 */
import { z } from 'zod';
import type { HoldCloseReason, HoldRefusal, HoldSource, HoldStatus } from '../circulation-vocab.js';
import { HOLD_STATUSES } from '../circulation-vocab.js';
import { cursorQuery, type Paged } from './catalog/common.js';
import { rawBarcodeField } from './catalog/items.js';
import { ulidField } from './common.js';

/** The copy of a hold (pinned, or kept on the hold shelf). */
export interface HoldItemRef {
  id: string;
  barcode: string;
  callNumber: string | null;
}

/** The member of a hold, for staff. */
export interface HoldMemberRef {
  id: string;
  memberNo: string;
  name: string;
  className: string | null;
}

/** One hold as staff (and, for their own holds, the member) see it. */
export interface HoldView {
  id: string;
  version: number;
  status: HoldStatus;
  record: { id: string; title: string };
  /** The pinned copy, or the copy kept for the member while `ready`. */
  item: HoldItemRef | null;
  pinned: boolean;
  /** null once the history was anonymised. */
  member: HoldMemberRef | null;
  pickupBranch: { id: string; code: string; name: string };
  source: HoldSource;
  placedOn: string;
  placedAt: number;
  /** The place in the queue of a waiting hold (1 = next), else null. */
  position: number | null;
  readyAt: number | null;
  /** The last day a `ready` hold may be picked up (the pickup branch's calendar date). */
  pickupUntil: string | null;
  expiresOn: string | null;
  closedAt: number | null;
  closeReason: HoldCloseReason | null;
  shelfClearedAt: number | null;
}

/**
 * `POST branches/:branchId/circulation/holds` → 201 `HoldCreateResponse` (`circulation.desk.use`): a hold for the member
 * `memberId` on the record `recordId`, picked up at the desk's branch, optionally pinned to the copy `itemId` (a copy of
 * that record at that branch; else `{path: 'itemId', code: 'invalid'}`). Refused with 409 CIRC_HOLD_REFUSED `{reason}`;
 * 404 for a member or record that is not live.
 */
export const HoldBody = z.strictObject({ memberId: ulidField, recordId: ulidField, itemId: ulidField.optional() });

export type HoldBody = z.infer<typeof HoldBody>;

export interface HoldCreateResponse {
  id: string;
  version: number;
  status: HoldStatus;
  position: number | null;
}

/** What a hold action (cancel, ready, clear) answers. */
export interface HoldActionResponse {
  id: string;
  version: number;
  status: HoldStatus;
  pickupUntil: string | null;
}

/**
 * `POST branches/:branchId/circulation/holds/:id/ready` → `HoldActionResponse`: "Tandai siap": staff scan an
 * `available` copy of the hold's record at the pickup branch (the pinned copy for a pinned hold) and the copy is kept
 * for the member. A copy of another record is `{path: 'barcode', code: 'other_record'}`.
 */
export const HoldReadyBody = z.strictObject({ barcode: rawBarcodeField });

export type HoldReadyBody = z.infer<typeof HoldReadyBody>;

/** A title with waiting holds at a branch, for the hold shelf screen. */
export interface WaitingTitleView {
  record: { id: string; title: string };
  waiting: number;
  firstPlacedOn: string;
  /** The first hold in the queue (the one "Tandai siap" keeps a copy for). */
  firstHoldId: string;
}

/**
 * `GET branches/:branchId/circulation/hold-shelf` → `HoldShelfResponse` (`circulation.desk.use`): the copies kept on
 * the branch's hold shelf (`ready`, by pickup deadline), the copies to put back on the shelf (a hold that expired or was
 * cancelled while its copy was kept, not cleared yet, oldest first) and the titles with waiting holds at the branch
 * (most waiting first). `today` is the branch's calendar date.
 */
export interface HoldShelfResponse {
  today: string;
  ready: HoldView[];
  toClear: HoldView[];
  waitingTitles: WaitingTitleView[];
}

/**
 * `GET circulation/holds` → `HoldListResponse` (`circulation.records.read`): holds by status (default the active ones),
 * member, record and pickup branch; newest first (cursor `<placedAt>.<id>`).
 */
export const HoldListQuery = z.strictObject({
  status: z.enum([...HOLD_STATUSES, 'active'] as const).default('active'),
  memberId: ulidField.optional(),
  recordId: ulidField.optional(),
  branchId: ulidField.optional(),
  ...cursorQuery,
});

export type HoldListQuery = z.infer<typeof HoldListQuery>;

export type HoldListResponse = Paged<HoldView>;

/** A return that kept the copy for a hold: who it is for and until when (the desk prints the slip from it). */
export interface ReturnHoldTrap {
  holdId: string;
  memberId: string;
  memberNo: string;
  memberName: string;
  pickupUntil: string;
}

/** `meta` of CIRC_HOLD_REFUSED. */
export interface HoldRefusedMeta {
  reason: HoldRefusal;
}
