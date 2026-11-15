import type { DB } from '@altis/db';
import { DomainError, type Locale, type MemberStatus } from '@altis/shared';
import type { Kysely, Transaction } from 'kysely';
import type { TxCtx } from '../../context.js';
import { readSettings } from '../../settings/service.js';
import { renewLoan } from '../../circulation/desk.js';
import { libraryToday, lockLiveMember, memberStatusOf } from '../common.js';
import { registerMemberDataSection, registerMemberErasureStep } from '../ext/hooks.js';
import { memberDataSectionsOf } from '../ext/privacy.js';

// What a signed-in member sees and does in the OPAC member area, besides the password (auth.ts): the account and its
// card, the open loans and the loan history (paged), the online renewal, the bookmarks, the attachments of access
// `members` and the download of the member's own data. Every read is keyed by the session's member: a row of another
// member is the same NOT_FOUND as a row that does not exist (the pages answer the OPAC 404 for both).
//
// - Online renewal: a loan of the member only; the member type must allow online renewal (`online_renewal`) and
//   `circulation.renew.opac` must be on (else CIRC_RENEW_REFUSED `{reason: 'not_online'}`); then the desk's renewal
//   runs with every one of its checks, at the loan's branch, audited `circulation.loan.renew` with the member as actor.
//   The online checks are read before the transaction: they are settings, and a renewal never depends on them changing
//   in between.
// - Bookmarks: at most 200 per member, of titles the OPAC shows (another title → NOT_FOUND); a title archived later is
//   hidden from the list, not deleted.
// - Attachments of access `members`: open to a signed-in member whose type the attachment lists (none listed: every
//   member), on a record the OPAC shows.
// - The download of the member's own data: every personal column of the member and the extra fields, then the same
//   sections as the export staff download (members/ext/privacy.ts): the history, the loans, the visits, and every
//   section the other parts of the library register (holds, charges, payments, clearance letters, bookmarks, notices).

type Db = Kysely<DB> | Transaction<DB>;

/** The most bookmarks a member keeps. */
export const MEMBER_BOOKMARK_LIMIT = 200;
/** Loans per page of the account and the history. */
export const MEMBER_LOANS_PER_PAGE = 20;

const notFound = (): DomainError => new DomainError('NOT_FOUND');

// ---------------------------------------------------------------------------------------------------------------
// The account

/** The member as the member area shows them (no address, identity number or notes). */
export interface MemberSelf {
  id: string;
  memberNo: string;
  name: string;
  type: { id: string; nameId: string; nameEn: string | null };
  className: string | null;
  institution: string | null;
  status: MemberStatus;
  statusNote: string | null;
  joinedOn: string;
  expiresOn: string | null;
  hasPhoto: boolean;
  photoFileId: string | null;
  homeBranchId: string | null;
  locale: string;
  mustResetPassword: boolean;
  /** The type allows holds and online renewal (the settings decide too). */
  holdsAllowed: boolean;
  onlineRenewal: boolean;
  today: string;
}

/** The live member `memberId` as {@link MemberSelf}; NOT_FOUND for one that is archived, anonymised or gone. */
export async function memberSelf(db: Db, memberId: string, now: number): Promise<MemberSelf> {
  const r = await db
    .selectFrom('members as m')
    .innerJoin('member_types as t', 't.id', 'm.member_type_id')
    .select([
      'm.id',
      'm.member_no_display',
      'm.name',
      'm.member_type_id',
      't.name_id',
      't.name_en',
      't.holds_allowed',
      't.online_renewal',
      'm.class_name',
      'm.institution',
      'm.status',
      'm.status_note',
      'm.joined_on',
      'm.expires_on',
      'm.photo_file_id',
      'm.home_branch_id',
      'm.locale',
      'm.must_reset_password',
      'm.archived_at',
      'm.anonymized_at',
    ])
    .where('m.id', '=', memberId)
    .executeTakeFirst();
  if (r === undefined || r.archived_at !== null || r.anonymized_at !== null) throw notFound();
  const today = await libraryToday(db, now);
  return {
    id: r.id,
    memberNo: r.member_no_display,
    name: r.name,
    type: { id: r.member_type_id, nameId: r.name_id, nameEn: r.name_en },
    className: r.class_name,
    institution: r.institution,
    status: memberStatusOf(r, today),
    statusNote: r.status === 'suspended' ? r.status_note : null,
    joinedOn: r.joined_on,
    expiresOn: r.expires_on,
    hasPhoto: r.photo_file_id !== null,
    photoFileId: r.photo_file_id,
    homeBranchId: r.home_branch_id,
    locale: r.locale,
    mustResetPassword: Number(r.must_reset_password) === 1,
    holdsAllowed: Number(r.holds_allowed) === 1,
    onlineRenewal: Number(r.online_renewal) === 1,
    today,
  };
}

/** The member's type's name in `locale`. */
export function memberTypeName(self: Pick<MemberSelf, 'type'>, locale: Locale): string {
  return locale === 'en' && self.type.nameEn !== null && self.type.nameEn !== '' ? self.type.nameEn : self.type.nameId;
}

// ---------------------------------------------------------------------------------------------------------------
// Loans

export interface MemberLoanRow {
  id: string;
  recordId: string | null;
  title: string | null;
  barcode: string | null;
  branchId: string;
  loanedOn: string;
  dueOn: string;
  returnedOn: string | null;
  outcome: string | null;
  renewals: number;
  renewLimit: number;
  /** Days past due on the library's today (open) or on the return day (closed). */
  daysLate: number;
}

export interface MemberLoanPage {
  rows: MemberLoanRow[];
  total: number;
  page: number;
  pages: number;
}

const DAY_MS = 86_400_000;

/** Whole days from `a` to `b` (calendar dates). */
function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);
}

/** One page of the member's open loans (oldest due date first) or closed loans (newest return first). */
export async function memberLoans(db: Db, memberId: string, o: { open: boolean; page: number; now: number }): Promise<MemberLoanPage> {
  const base = db
    .selectFrom('loans as l')
    .where('l.member_id', '=', memberId)
    .where('l.open_item_id', o.open ? 'is not' : 'is', null);
  const counted = await base.select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirst();
  const total = Number(counted?.n ?? 0);
  const pages = Math.max(1, Math.ceil(total / MEMBER_LOANS_PER_PAGE));
  const page = Math.min(Math.max(1, Math.trunc(o.page)), pages);
  const rows = await base
    .leftJoin('items as i', 'i.id', 'l.item_id')
    .leftJoin('records as r', 'r.id', 'l.record_id')
    .select([
      'l.id',
      'l.record_id',
      'r.title',
      'i.barcode_display',
      'l.branch_id',
      'l.loaned_on',
      'l.due_on',
      'l.returned_on',
      'l.outcome',
      'l.renewals',
      'l.renew_limit',
    ])
    .$call((q) => (o.open ? q.orderBy('l.due_on').orderBy('l.id') : q.orderBy('l.returned_at', 'desc').orderBy('l.id', 'desc')))
    .limit(MEMBER_LOANS_PER_PAGE)
    .offset((page - 1) * MEMBER_LOANS_PER_PAGE)
    .execute();
  const today = await libraryToday(db, o.now);
  return {
    rows: rows.map((r) => {
      const end = r.returned_on ?? today;
      return {
        id: r.id,
        recordId: r.record_id,
        title: r.title,
        barcode: r.barcode_display,
        branchId: r.branch_id,
        loanedOn: r.loaned_on,
        dueOn: r.due_on,
        returnedOn: r.returned_on,
        outcome: r.outcome,
        renewals: Number(r.renewals),
        renewLimit: Number(r.renew_limit),
        daysLate: Math.max(0, daysBetween(r.due_on, end)),
      };
    }),
    total,
    page,
    pages,
  };
}

/** Whether members may renew online at all (`circulation.renew.opac`) and the member's type allows it. */
export async function onlineRenewalOpen(db: Db, self: Pick<MemberSelf, 'onlineRenewal'>): Promise<boolean> {
  const s = await readSettings(db, ['circulation.renew.opac'], []);
  return self.onlineRenewal && s['circulation.renew.opac'] === true;
}

/**
 * The member's loan `loanId` as the renewal needs it, read before its transaction: NOT_FOUND unless it is the member's
 * own; CIRC_RENEW_REFUSED `not_online` unless online renewal is open to the member.
 */
export async function ownLoanForRenewal(db: Db, input: { memberId: string; loanId: string; now: number }): Promise<{ branchId: string }> {
  const loan = await db.selectFrom('loans').select(['branch_id']).where('id', '=', input.loanId).where('member_id', '=', input.memberId).executeTakeFirst();
  if (loan === undefined) throw notFound();
  const self = await memberSelf(db, input.memberId, input.now);
  if (!(await onlineRenewalOpen(db, self))) {
    throw new DomainError('CIRC_RENEW_REFUSED', { detail: 'Perpanjangan daring tidak tersedia / Online renewal is not available', meta: { reason: 'not_online' } });
  }
  return { branchId: loan.branch_id };
}

/**
 * Renews the member's own open loan once, with every check of the desk's renewal (tx.actor: the member). Call
 * {@link ownLoanForRenewal} before the transaction.
 *
 * @throws DomainError NOT_FOUND; CIRC_LOAN_NOT_OPEN; CIRC_RENEW_REFUSED `{reason}`
 */
export async function renewOwnLoan(tx: TxCtx, input: { memberId: string; loanId: string; branchId: string }): Promise<{ dueOn: string; renewals: number }> {
  if (tx.actor.type !== 'member' || tx.actor.id !== input.memberId) throw new TypeError('renewOwnLoan: run it as the member');
  const r = await renewLoan(tx, { branchId: input.branchId, loanId: input.loanId });
  // The renewal locked the loan first and read its member: a loan that changed hands meanwhile cannot exist (an open
  // loan keeps its member), so this only guards against a caller that skipped ownLoanForRenewal.
  const owner = await tx.trx.selectFrom('loans').select('member_id').where('id', '=', input.loanId).executeTakeFirst();
  if (owner?.member_id !== input.memberId) throw notFound();
  return { dueOn: r.dueOn, renewals: r.renewals };
}

// ---------------------------------------------------------------------------------------------------------------
// Bookmarks and published records

/** The title of record `id` when the OPAC shows it (visible, not archived, not merged), else null. */
export async function publishedRecordTitle(db: Db, id: string): Promise<string | null> {
  const r = await db.selectFrom('records').select(['title', 'opac_visible', 'archived_at', 'merged_into']).where('id', '=', id).executeTakeFirst();
  if (r === undefined || Number(r.opac_visible) !== 1 || r.archived_at !== null || r.merged_into !== null) return null;
  return r.title;
}

export interface MemberBookmarkRow {
  recordId: string;
  title: string;
  responsibility: string | null;
  createdAt: number;
}

/** The member's bookmarks of titles the OPAC shows, newest first. */
export async function memberBookmarks(db: Db, memberId: string): Promise<MemberBookmarkRow[]> {
  const rows = await db
    .selectFrom('member_bookmarks as b')
    .innerJoin('records as r', 'r.id', 'b.record_id')
    .select(['b.record_id', 'r.title', 'r.responsibility', 'b.created_at'])
    .where('b.member_id', '=', memberId)
    .where('r.opac_visible', '=', 1)
    .where('r.archived_at', 'is', null)
    .where('r.merged_into', 'is', null)
    .orderBy('b.created_at', 'desc')
    .orderBy('b.record_id')
    .limit(MEMBER_BOOKMARK_LIMIT)
    .execute();
  return rows.map((r) => ({ recordId: r.record_id, title: r.title, responsibility: r.responsibility, createdAt: Number(r.created_at) }));
}

/** Whether the member has bookmarked record `recordId`. */
export async function hasBookmark(db: Db, memberId: string, recordId: string): Promise<boolean> {
  const r = await db.selectFrom('member_bookmarks').select('record_id').where('member_id', '=', memberId).where('record_id', '=', recordId).executeTakeFirst();
  return r !== undefined;
}

/**
 * Bookmarks record `recordId` for the member (nothing when it already is). The member's row is locked first.
 *
 * @throws DomainError NOT_FOUND (a member that is not live, a record the OPAC does not show); VALIDATION_FAILED
 *   `{path: 'recordId', code: 'bookmark_limit'}` at {@link MEMBER_BOOKMARK_LIMIT}
 */
export async function addBookmark(tx: TxCtx, memberId: string, recordId: string): Promise<{ added: boolean }> {
  const { trx } = tx;
  if (!(await lockLiveMember(trx, memberId))) throw notFound();
  if ((await publishedRecordTitle(trx, recordId)) === null) throw notFound();
  if (await hasBookmark(trx, memberId, recordId)) return { added: false };
  const counted = await trx
    .selectFrom('member_bookmarks')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .where('member_id', '=', memberId)
    .executeTakeFirst();
  if (Number(counted?.n ?? 0) >= MEMBER_BOOKMARK_LIMIT) {
    throw new DomainError('VALIDATION_FAILED', {
      detail: `Penanda paling banyak ${MEMBER_BOOKMARK_LIMIT} / At most ${MEMBER_BOOKMARK_LIMIT} bookmarks`,
      meta: { errors: [{ path: 'recordId', code: 'bookmark_limit' }] },
    });
  }
  await trx.insertInto('member_bookmarks').values({ member_id: memberId, record_id: recordId, created_at: tx.now }).execute();
  return { added: true };
}

/** Removes the member's bookmark of `recordId`. @throws DomainError NOT_FOUND when the member has none */
export async function removeBookmark(tx: TxCtx, memberId: string, recordId: string): Promise<void> {
  const { trx } = tx;
  if (!(await lockLiveMember(trx, memberId))) throw notFound();
  const r = await trx.deleteFrom('member_bookmarks').where('member_id', '=', memberId).where('record_id', '=', recordId).executeTakeFirst();
  if (Number(r.numDeletedRows) !== 1) throw notFound();
}

// ---------------------------------------------------------------------------------------------------------------
// Attachments of access `members`

/** The member types an attachment lists (none: every signed-in member). */
export async function attachmentMemberTypes(db: Db, attachmentId: string): Promise<string[]> {
  const rows = await db.selectFrom('attachment_member_types').select('member_type_id').where('attachment_id', '=', attachmentId).orderBy('member_type_id').execute();
  return rows.map((r) => r.member_type_id);
}

/** Replaces the member types of attachment `attachmentId` (in the transaction that saves it). */
export async function setAttachmentMemberTypes(trx: Transaction<DB>, attachmentId: string, typeIds: readonly string[]): Promise<void> {
  await trx.deleteFrom('attachment_member_types').where('attachment_id', '=', attachmentId).execute();
  const unique = [...new Set(typeIds)];
  if (unique.length > 0) {
    await trx
      .insertInto('attachment_member_types')
      .values(unique.map((t) => ({ attachment_id: attachmentId, member_type_id: t })))
      .execute();
  }
}

/** A members' attachment as the member area opens it. */
export interface MemberAttachment {
  id: string;
  recordId: string;
  kind: 'file' | 'url';
  fileId: string | null;
  url: string | null;
  title: string;
}

/**
 * The attachment `attachmentId` when a member of type `memberTypeId` may open it: access `members`, not archived, on a
 * record the OPAC shows, and the type listed (or none listed); `'type'` when only the type keeps the member out; null
 * when there is no such attachment for members at all.
 */
export async function memberAttachment(db: Db, attachmentId: string, memberTypeId: string): Promise<MemberAttachment | 'type' | null> {
  const a = await db
    .selectFrom('attachments')
    .select(['id', 'record_id', 'kind', 'file_id', 'url', 'title', 'access', 'archived_at'])
    .where('id', '=', attachmentId)
    .executeTakeFirst();
  if (a === undefined || a.archived_at !== null || a.access !== 'members') return null;
  if ((await publishedRecordTitle(db, a.record_id)) === null) return null;
  const types = await attachmentMemberTypes(db, a.id);
  if (types.length > 0 && !types.includes(memberTypeId)) return 'type';
  return { id: a.id, recordId: a.record_id, kind: a.kind === 'url' ? 'url' : 'file', fileId: a.file_id, url: a.url, title: a.title };
}

/** Whether the file `fileId` (owned by a members' attachment) may be served to a member of type `memberTypeId`. */
export async function memberMayOpenFile(db: Db, f: { owner_type: string | null; owner_id: string | null }, memberTypeId: string): Promise<boolean> {
  if (f.owner_type !== 'attachments' || f.owner_id === null) return false;
  const a = await memberAttachment(db, f.owner_id, memberTypeId);
  return a !== null && a !== 'type';
}

// ---------------------------------------------------------------------------------------------------------------
// The member's own data

/** The columns of a member row the download carries: every personal column and the membership facts. */
const PROFILE_COLUMNS = [
  'member_no_display',
  'name',
  'gender',
  'birth_date',
  'identity_no',
  'institution',
  'class_name',
  'email',
  'phone',
  'address',
  'postal_code',
  'mailing_address',
  'notes',
  'status',
  'status_note',
  'locale',
  'joined_on',
  'valid_from',
  'expires_on',
  'last_login_at',
  'created_at',
] as const;

/**
 * Everything the library holds about the member `memberId` (see the top of this file), as JSON-ready data. The photo is
 * named by the member-area address that shows it. The password hash is never in it.
 *
 * @throws DomainError NOT_FOUND for a member that is not live
 */
export async function memberDataExport(db: Db, memberId: string, now: number): Promise<Record<string, unknown>> {
  const m = await db
    .selectFrom('members as m')
    .innerJoin('member_types as t', 't.id', 'm.member_type_id')
    .select([...PROFILE_COLUMNS.map((c) => `m.${c}` as const), 'm.photo_file_id', 'm.archived_at', 'm.anonymized_at', 't.code_display as type_code', 't.name_id as type_name'])
    .where('m.id', '=', memberId)
    .executeTakeFirst();
  if (m === undefined || m.archived_at !== null || m.anonymized_at !== null) throw notFound();
  const profile: Record<string, unknown> = {};
  for (const c of PROFILE_COLUMNS) profile[c] = m[c];
  profile['member_type'] = { code: m.type_code, name: m.type_name };
  profile['photo'] = m.photo_file_id === null ? null : '/akun/foto';

  const custom = await db
    .selectFrom('custom_values as v')
    .innerJoin('custom_field_defs as d', 'd.id', 'v.field_id')
    .select(['d.code_display', 'd.label', 'v.value'])
    .where('d.entity', '=', 'members')
    .where('v.entity_id', '=', memberId)
    .orderBy('d.sort_order')
    .execute();
  return {
    exportedAt: new Date(now).toISOString(),
    profile,
    customFields: custom.map((c) => ({ code: c.code_display, label: c.label, value: parseJson(c.value) })),
    ...(await memberDataSectionsOf(db, memberId)),
  };
}

function parseJson(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

// A member's bookmarks are part of the member's own data; anonymising the member deletes them.
registerMemberDataSection({
  name: 'bookmarks',
  read: async (db, memberId) => {
    const rows = await db
      .selectFrom('member_bookmarks as b')
      .leftJoin('records as r', 'r.id', 'b.record_id')
      .select(['b.record_id', 'r.title', 'b.created_at'])
      .where('b.member_id', '=', memberId)
      .orderBy('b.created_at')
      .orderBy('b.record_id')
      .execute();
    return rows.map((b) => ({ recordId: b.record_id, title: b.title ?? null, at: Number(b.created_at) }));
  },
});
registerMemberErasureStep({
  name: 'bookmarks',
  run: async (tx, memberId) => {
    await tx.trx.deleteFrom('member_bookmarks').where('member_id', '=', memberId).execute();
  },
});
