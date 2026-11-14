/**
 * The member notices API: the e-mails ALTIS sends members (a loan due soon, an overdue loan, a hold ready for pickup),
 * the log staff read, a reminder sent by hand, and the preview and test send of the settings screen.
 *
 * - A daily job (07:00, library time) queues one notice per member, kind and day; a sender job sends them through the
 *   library's SMTP server, and a hold that becomes ready queues its own at once. The log keeps ids and states only,
 *   never the text of a mail.
 * - A reminder sent by hand (`POST branches/:branchId/circulation/notices`) covers the member's open loans of that
 *   branch: `overdue` the loans past due, `due_soon` the loans not yet due. A second request for the same member, kind
 *   and day joins the first (`existing`); a member with nothing to remind is counted in `nothing`.
 * - Personal data never travels in a URL: a member is named by id.
 *
 * No Node built-ins here: the browser bundles this module. Import it as `@altis/shared/api/notices`.
 */
import { z } from 'zod';
import { MANUAL_NOTICE_KINDS, NOTICE_KINDS, NOTICE_STATUSES, type ManualNoticeKind, type NoticeKind, type NoticeReason, type NoticeStatus } from '../circulation-vocab.js';
import { cursorQuery, dateField } from './catalog/common.js';
import { emailField, localeField, ulidField } from './common.js';

/** At most this many members in one manual send. */
export const NOTICE_SEND_MAX_MEMBERS = 200;

// ---- the log -----------------------------------------------------------------------------------------------------------

/**
 * `GET circulation/notices` (`circulation.records.read`): the notices, newest first, by status, kind, member and the
 * day they were queued (library time, `from`/`to` inclusive).
 */
export const NoticeListQuery = z.strictObject({
  status: z.enum(NOTICE_STATUSES).optional(),
  kind: z.enum(NOTICE_KINDS).optional(),
  memberId: ulidField.optional(),
  from: dateField.optional(),
  to: dateField.optional(),
  ...cursorQuery,
});

export type NoticeListQuery = z.infer<typeof NoticeListQuery>;

/** The member a notice is for (null once the member is gone). */
export interface NoticeMemberRef {
  id: string;
  memberNo: string;
  name: string;
}

/** One notice of the log. */
export interface NoticeListItem {
  id: string;
  kind: NoticeKind;
  status: NoticeStatus;
  reason: NoticeReason | null;
  /** Sent by staff (`manual:` notices) rather than by the daily job or a hold. */
  manual: boolean;
  attempts: number;
  /** Epoch ms. */
  createdAt: number;
  sentAt: number | null;
  member: NoticeMemberRef | null;
  /** How many loans the mail is about (0 for a hold). */
  loanCount: number;
  holdId: string | null;
}

export interface NoticeListResponse {
  items: NoticeListItem[];
  nextCursor: string | null;
}

/**
 * `GET circulation/notices/status` (`circulation.records.read`): what the reminder screen and Diagnostik show: whether
 * SMTP is set up, the notices by status over the last 7 days, the last run of the daily job and of the sender.
 */
export interface NoticeStatusResponse {
  smtpConfigured: boolean;
  /** Notices queued in the last 7 days, by status. */
  lastWeek: Record<NoticeStatus, number>;
  /** The last finished run of the daily notices job (epoch ms), or null. */
  lastBuildAt: number | null;
  /** The last finished run of the sender (epoch ms), or null. */
  lastSendAt: number | null;
  /** Notices waiting now (queued or being sent). */
  waiting: number;
}

// ---- a reminder sent by hand ---------------------------------------------------------------------------------------------

/** `POST branches/:branchId/circulation/notices` (`circulation.desk.use` at the branch). */
export const NoticeSendBody = z.strictObject({
  memberIds: z.array(ulidField).min(1).max(NOTICE_SEND_MAX_MEMBERS),
  kind: z.enum(MANUAL_NOTICE_KINDS),
});

export type NoticeSendBody = z.infer<typeof NoticeSendBody>;

/** Why a member got no reminder: unknown, archived or anonymised. */
export type NoticeSendRefusal = 'not_found';

export interface NoticeSendResponse {
  kind: ManualNoticeKind;
  /** New notices queued (one per member). */
  queued: number;
  /** Members who already had this reminder today. */
  existing: number;
  /** Members with nothing to remind at this branch. */
  nothing: number;
  refused: { memberId: string; reason: NoticeSendRefusal }[];
}

// ---- preview and test send ---------------------------------------------------------------------------------------------

/**
 * `POST circulation/notices/preview` (`system.settings.read`, a read): the mail of `kind` in `locale` with sample
 * values, through the library's own template when it saved one.
 */
export const NoticePreviewBody = z.strictObject({
  kind: z.enum(NOTICE_KINDS),
  locale: localeField,
});

export type NoticePreviewBody = z.infer<typeof NoticePreviewBody>;

export interface NoticePreviewResponse {
  subject: string;
  text: string;
}

/** `POST circulation/notices/test` (`system.settings.manage`): the preview's mail sent to `to`. */
export const NoticeTestBody = z.strictObject({
  kind: z.enum(NOTICE_KINDS),
  locale: localeField,
  to: emailField,
});

export type NoticeTestBody = z.infer<typeof NoticeTestBody>;

export interface NoticeTestResponse {
  sent: true;
}
