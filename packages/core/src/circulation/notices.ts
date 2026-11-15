import { normalizeDbError, type DB } from '@altis/db';
import {
  LOCALES,
  addDays,
  isDomainError,
  isUlid,
  localDate,
  newId,
  t,
  type Locale,
  type ManualNoticeKind,
  type NoticeKind,
  type NoticeReason,
  type NoticeStatus,
} from '@altis/shared';
import type { NoticeListItem, NoticeListQuery, NoticeListResponse, NoticeSendResponse, NoticeStatusResponse } from '@altis/shared/api/notices';
import { sql, type Transaction } from 'kysely';
import { z } from 'zod';
import type { TxCtx } from '../context.js';
import { enqueue } from '../jobs/enqueue.js';
import type { JobHandler, JobRegistry } from '../jobs/types.js';
import { renderMail, type MailKind } from '../mail/templates.js';
import { libraryTimeZone, memberValidationFailed, type Db } from '../members/common.js';
import { registerMemberDataSection, registerMemberErasureStep } from '../members/ext/hooks.js';
import { localDayStart } from '../reports/collection/common.js';
import { readSettings } from '../settings/service.js';
import { memberBalances } from './charge-views.js';
import { branchToday } from './dates.js';
import { FinePreviewer } from './fines.js';
import { HOLD_READY_HOOKS } from './holds.js';

// Member notices (e-mail only): a loan due soon, an overdue loan, a hold ready for pickup.
//
// - A notice row is what the library owes one member: one per member, kind and day, made unique by `ref_key`
//   (`due_soon:<memberId>:<due_on>`, `overdue:<memberId>:<run date>`, `hold_ready:<holdId>:<ready_at>`,
//   `manual:<kind>:<memberId>:<date>`). Building the same notices again (a job run again after a crash, two runs at
//   once, a second click) inserts nothing: the INSERT runs inside a savepoint and a UNIQUE_VIOLATION is the row that
//   already exists.
// - The rows hold ids and states only. The text is rendered at the moment of sending (notices-jobs.ts), in the member's
//   language, from what is true then: a loan returned meanwhile is left out, and a notice with nothing left to say is
//   skipped (`resolved`).
// - Queueing a notice also enqueues the one sender job (`circulation.notices_send`, unique key): a sender that is
//   alive takes the new rows with it. The enqueue uses the sender's payload schema only (SEND_REGISTRY below), so it
//   works from any transaction: the hold that became ready, the daily build, a manual send.
// - A hold that becomes ready queues its notice in the transaction that made it ready (HOLD_READY_HOOKS); with
//   `circulation.notices.holdReady` off the row is written `skipped` (`setting_off`) so the log says why.
// - Anonymising a member deletes the member's notices that were not sent yet; the member's data export lists them.

export const NOTICES_BUILD_JOB = 'circulation.notices';
export const NOTICES_SEND_JOB = 'circulation.notices_send';
/** The unique key of the sender: one sender alive at a time. */
export const NOTICES_SEND_KEY = 'circulation.notices_send';
/** A notice is tried at most this many times. */
export const NOTICE_MAX_ATTEMPTS = 5;
/** At most this many loan ids in one notice. */
const LOAN_IDS_MAX = 200;

/** The mail kinds of the notices. */
export type NoticeMailKind = Extract<MailKind, 'circulation_due_soon' | 'circulation_overdue' | 'circulation_hold_ready'>;

const MAIL_KIND: Readonly<Record<NoticeKind, NoticeMailKind>> = {
  due_soon: 'circulation_due_soon',
  overdue: 'circulation_overdue',
  hold_ready: 'circulation_hold_ready',
};

/** The mail kind of a notice kind (its catalog texts are `mail.<mail kind>.subject|body`). */
export function noticeMailKind(kind: NoticeKind): NoticeMailKind {
  return MAIL_KIND[kind];
}

// ---- the sender's payload, and enqueueing it ---------------------------------------------------------------------------

const sendCounts = z.strictObject({
  sent: z.int().min(0),
  failed: z.int().min(0),
  skipped: z.int().min(0),
  /** Of `skipped`: because no SMTP server is saved. */
  noSmtp: z.int().min(0),
});

/** The payload of the sender: `{}` when enqueued, the counts so far in a continuing job. */
export const noticesSendPayload = z.strictObject({ counts: sendCounts.optional() });

export type NoticesSendPayload = z.infer<typeof noticesSendPayload>;
export type NoticesSendCounts = z.infer<typeof sendCounts>;

/** The sender as enqueue sees it: its type, attempts and payload schema (the runtime registers the real handler). */
const SEND_SCHEMA: JobHandler<NoticesSendPayload> = {
  type: NOTICES_SEND_JOB,
  permission: 'system.jobs.manage',
  retryable: 'api',
  maxAttempts: NOTICE_MAX_ATTEMPTS,
  payload: noticesSendPayload,
  run: () => Promise.reject(new TypeError('the notice sender runs with its mail deps (noticesSendJob)')),
};

const SEND_REGISTRY: JobRegistry = {
  get: (type) => (type === NOTICES_SEND_JOB ? (SEND_SCHEMA as JobHandler<unknown>) : undefined),
  types: () => [NOTICES_SEND_JOB],
};

/**
 * Enqueues the sender in `trx` (unique key: a sender alive takes the new rows; enqueue's rules: run inside a withTx callback that may be run again). The caller wakes
 * the worker after the commit when it can (`rc.afterCommit(() => rc.services.jobs?.kick())`); otherwise the worker's
 * next pass, cron or a piggyback slice picks it up.
 */
export async function enqueueNoticeSender(trx: Transaction<DB>, now: number): Promise<string> {
  const { id } = await enqueue(trx, SEND_REGISTRY, { type: NOTICES_SEND_JOB, payload: {}, uniqueKey: NOTICES_SEND_KEY }, { now, keyring: [] });
  return id;
}

// ---- queueing ------------------------------------------------------------------------------------------------------------

export interface NewNotice {
  memberId: string;
  kind: NoticeKind;
  refKey: string;
  loanIds?: readonly string[];
  holdId?: string | null;
  /** `skipped` with its reason for a notice the library switched off; default `queued`. */
  status?: 'queued' | 'skipped';
  reason?: NoticeReason | null;
}

/**
 * Inserts the notice `n` at `now` in `trx` unless a notice with its `ref_key` exists: true when inserted. The INSERT runs
 * inside SAVEPOINT altis_notice, so a UNIQUE_VIOLATION (the row exists, perhaps committed by another transaction a
 * moment ago) leaves the caller's transaction usable on every dialect.
 */
export async function queueNotice(trx: Transaction<DB>, n: NewNotice, now: number): Promise<boolean> {
  const row = {
    id: newId(),
    member_id: n.memberId,
    kind: n.kind,
    ref_key: n.refKey,
    channel: 'email',
    status: n.status ?? 'queued',
    reason: n.reason ?? null,
    loan_ids: n.loanIds === undefined ? null : JSON.stringify(n.loanIds.slice(0, LOAN_IDS_MAX)),
    hold_id: n.holdId ?? null,
    attempts: 0,
    job_id: null,
    claimed_at: null,
    created_at: now,
    sent_at: null,
  };
  await sql`savepoint altis_notice`.execute(trx);
  try {
    await trx.insertInto('notices').values(row).execute();
  } catch (error) {
    const normalized = normalizeDbError(error);
    if (!isDomainError(normalized) || normalized.code !== 'UNIQUE_VIOLATION') throw error;
    await sql`rollback to savepoint altis_notice`.execute(trx);
    await sql`release savepoint altis_notice`.execute(trx);
    return false;
  }
  await sql`release savepoint altis_notice`.execute(trx);
  return true;
}

/** The notice settings (`circulation.notices.*`). */
export interface NoticeSettings {
  dueSoonDays: number;
  overdueEveryDays: number;
  overdueMax: number;
  holdReady: boolean;
}

export async function noticeSettings(db: Db): Promise<NoticeSettings> {
  const s = await readSettings(
    db,
    ['circulation.notices.dueSoonDays', 'circulation.notices.overdueEveryDays', 'circulation.notices.overdueMax', 'circulation.notices.holdReady'],
    [],
  );
  return {
    dueSoonDays: s['circulation.notices.dueSoonDays'] as number,
    overdueEveryDays: s['circulation.notices.overdueEveryDays'] as number,
    overdueMax: s['circulation.notices.overdueMax'] as number,
    holdReady: s['circulation.notices.holdReady'] as boolean,
  };
}

/**
 * The days late on which an overdue loan is reminded: the first day, then every `everyDays` days, `max` times in all
 * (0: never). `[1, 8, 15]` for every 7 days, 3 times.
 */
export function overdueReminderDays(everyDays: number, max: number): number[] {
  const out: number[] = [];
  for (let k = 0; k < max; k++) out.push(1 + k * Math.max(1, everyDays));
  return out;
}

// The hold that became ready queues its mail in the same transaction (the holds module calls the hooks).
HOLD_READY_HOOKS.push(async (tx, hold) => {
  const settings = await noticeSettings(tx.trx);
  const refKey = `hold_ready:${hold.id}:${hold.readyAt}`;
  if (!settings.holdReady) {
    await queueNotice(tx.trx, { memberId: hold.memberId, kind: 'hold_ready', refKey, holdId: hold.id, status: 'skipped', reason: 'setting_off' }, tx.now);
    return;
  }
  if (await queueNotice(tx.trx, { memberId: hold.memberId, kind: 'hold_ready', refKey, holdId: hold.id }, tx.now)) {
    await enqueueNoticeSender(tx.trx, tx.now);
  }
});

// A member's notices are part of the member's own data; anonymising the member deletes those not sent yet.
registerMemberDataSection({
  name: 'notices',
  read: async (db, memberId) => {
    const rows = await db
      .selectFrom('notices')
      .select(['kind', 'status', 'reason', 'created_at', 'sent_at'])
      .where('member_id', '=', memberId)
      .orderBy('created_at')
      .orderBy('id')
      .execute();
    return rows.map((r) => ({ kind: r.kind, status: r.status, reason: r.reason, createdAt: Number(r.created_at), sentAt: r.sent_at === null ? null : Number(r.sent_at) }));
  },
});
registerMemberErasureStep({
  name: 'notices',
  run: async (tx, memberId) => {
    await tx.trx.deleteFrom('notices').where('member_id', '=', memberId).where('status', 'in', ['queued', 'sending', 'failed']).execute();
  },
});

// ---- a reminder sent by hand ------------------------------------------------------------------------------------------

/**
 * Queues a reminder of `kind` for each of `memberIds` about their open loans at the branch `branchId`: `overdue` the
 * loans past due, `due_soon` the loans not yet due. One per member, kind and day (`manual:<kind>:<memberId>:<today>`):
 * a second request the same day joins the first. A member unknown, archived or anonymised is refused; one without such
 * loans counts in `nothing`. Audits `circulation.notice.send` once (`meta {kind, count}`), and enqueues the sender
 * when anything was queued.
 */
export async function sendManualNotices(tx: TxCtx, i: { branchId: string; memberIds: readonly string[]; kind: ManualNoticeKind }): Promise<NoticeSendResponse> {
  const trx = tx.trx;
  const today = await branchToday(trx, i.branchId, tx.now);
  const ids = [...new Set(i.memberIds)];
  const live = new Set(
    (
      await trx
        .selectFrom('members')
        .select('id')
        .where('id', 'in', ids)
        .where('archived_at', 'is', null)
        .where('anonymized_at', 'is', null)
        .execute()
    ).map((m) => m.id),
  );
  let loanQuery = trx
    .selectFrom('loans')
    .select(['id', 'member_id'])
    .where('member_id', 'in', ids)
    .where('branch_id', '=', i.branchId)
    .where('open_item_id', 'is not', null);
  loanQuery = i.kind === 'overdue' ? loanQuery.where('due_on', '<', today) : loanQuery.where('due_on', '>=', today);
  const loans = await loanQuery.orderBy('due_on').orderBy('id').execute();
  const byMember = new Map<string, string[]>();
  for (const l of loans) {
    if (l.member_id === null) continue;
    const list = byMember.get(l.member_id) ?? [];
    list.push(l.id);
    byMember.set(l.member_id, list);
  }
  const out: NoticeSendResponse = { kind: i.kind, queued: 0, existing: 0, nothing: 0, refused: [] };
  for (const memberId of ids) {
    if (!live.has(memberId)) {
      out.refused.push({ memberId, reason: 'not_found' });
      continue;
    }
    const loanIds = byMember.get(memberId);
    if (loanIds === undefined) {
      out.nothing += 1;
      continue;
    }
    const inserted = await queueNotice(trx, { memberId, kind: i.kind, refKey: `manual:${i.kind}:${memberId}:${today}`, loanIds }, tx.now);
    if (inserted) out.queued += 1;
    else out.existing += 1;
  }
  if (out.queued > 0) await enqueueNoticeSender(trx, tx.now);
  await tx.audit({ action: 'circulation.notice.send', entity: null, entityId: null, branchId: i.branchId, meta: { kind: i.kind, count: out.queued } });
  return out;
}

// ---- the log ---------------------------------------------------------------------------------------------------------------

function badCursor(): never {
  throw memberValidationFailed([{ path: 'cursor', code: 'invalid' }]);
}

/** The number of loan ids of a stored list (0 when there is none or it is not a list). */
function loanCount(text: string | null): number {
  if (text === null) return 0;
  try {
    const v: unknown = JSON.parse(text);
    return Array.isArray(v) ? v.length : 0;
  } catch {
    return 0;
  }
}

/**
 * A page of the notice log by `q`, newest first (cursor `<created_at>.<id>`). `from`/`to` are days of the library's time
 * zone, both included.
 *
 * @throws DomainError VALIDATION_FAILED (`cursor`, `invalid`)
 */
export async function listNotices(db: Db, q: NoticeListQuery): Promise<NoticeListResponse> {
  let query = db
    .selectFrom('notices as n')
    .leftJoin('members as m', 'm.id', 'n.member_id')
    .select([
      'n.id',
      'n.kind',
      'n.status',
      'n.reason',
      'n.ref_key',
      'n.attempts',
      'n.created_at',
      'n.sent_at',
      'n.loan_ids',
      'n.hold_id',
      'n.member_id',
      'm.member_no_display',
      'm.name as member_name',
    ]);
  if (q.status !== undefined) query = query.where('n.status', '=', q.status);
  if (q.kind !== undefined) query = query.where('n.kind', '=', q.kind);
  if (q.memberId !== undefined) query = query.where('n.member_id', '=', q.memberId);
  if (q.from !== undefined || q.to !== undefined) {
    const tz = await libraryTimeZone(db);
    if (q.from !== undefined) query = query.where('n.created_at', '>=', localDayStart(tz, q.from));
    if (q.to !== undefined) query = query.where('n.created_at', '<', localDayStart(tz, addDays(q.to, 1)));
  }
  if (q.cursor !== undefined) {
    const m = /^(\d{1,15})\.([0-9A-Z]{26})$/.exec(q.cursor);
    if (m === null || !isUlid(m[2]!)) badCursor();
    const at = Number(m[1]);
    const after = m[2]!;
    query = query.where((eb) => eb.or([eb('n.created_at', '<', at), eb.and([eb('n.created_at', '=', at), eb('n.id', '<', after)])]));
  }
  const rows = await query.orderBy('n.created_at', 'desc').orderBy('n.id', 'desc').limit(q.limit + 1).execute();
  const page = rows.slice(0, q.limit);
  const items: NoticeListItem[] = page.map((r) => ({
    id: r.id,
    kind: r.kind as NoticeKind,
    status: r.status as NoticeStatus,
    reason: (r.reason as NoticeReason | null) ?? null,
    manual: r.ref_key.startsWith('manual:'),
    attempts: Number(r.attempts),
    createdAt: Number(r.created_at),
    sentAt: r.sent_at === null ? null : Number(r.sent_at),
    member: r.member_no_display === null ? null : { id: r.member_id, memberNo: r.member_no_display, name: r.member_name ?? '' },
    loanCount: loanCount(r.loan_ids),
    holdId: r.hold_id,
  }));
  const last = page[page.length - 1];
  return { items, nextCursor: rows.length > q.limit && last !== undefined ? `${Number(last.created_at)}.${last.id}` : null };
}

/** What the reminder screen shows about the notices: SMTP set up, the last week by status, the last runs. */
export async function noticeStatus(db: Db, now: number): Promise<NoticeStatusResponse> {
  const smtp = await readSettings(db, ['smtp.host', 'smtp.from'], []);
  const host = smtp['smtp.host'] as string | null;
  const from = smtp['smtp.from'] as string | null;
  const lastWeek: Record<NoticeStatus, number> = { queued: 0, sending: 0, sent: 0, failed: 0, skipped: 0 };
  const rows = await db.selectFrom('notices').select('status').where('created_at', '>=', now - 7 * 86_400_000).execute();
  for (const r of rows) if (Object.hasOwn(lastWeek, r.status)) lastWeek[r.status as NoticeStatus] += 1;
  const waitingRows = await db.selectFrom('notices').select('id').where('status', 'in', ['queued', 'sending']).limit(100_000).execute();
  const last = async (type: string): Promise<number | null> => {
    const row = await db
      .selectFrom('jobs')
      .select('finished_at')
      .where('type', '=', type)
      .where('status', '=', 'succeeded')
      .where('finished_at', 'is not', null)
      .orderBy('finished_at', 'desc')
      .limit(1)
      .executeTakeFirst();
    return row?.finished_at === null || row?.finished_at === undefined ? null : Number(row.finished_at);
  };
  return {
    smtpConfigured: host !== null && host !== '' && from !== null && from !== '',
    lastWeek,
    lastBuildAt: await last(NOTICES_BUILD_JOB),
    lastSendAt: await last(NOTICES_SEND_JOB),
    waiting: waitingRows.length,
  };
}

// ---- the mail ----------------------------------------------------------------------------------------------------------------

/** What a mail needs about its member. */
export interface NoticeMember {
  id: string;
  name: string;
  memberNo: string;
  locale: Locale;
}

/** The library facts of a mail. */
export interface NoticeLibrary {
  name: string;
  /** The member area's address (`<baseUrl>/akun`). */
  link: string;
  currency: string;
}

const isLocale = (v: unknown): v is Locale => typeof v === 'string' && (LOCALES as readonly string[]).includes(v);

/** `2026-11-15` as `15 November 2026` (id) or `15 November 2026` (en), the date as written, no time zone. */
export function mailDate(locale: Locale, date: string): string {
  return new Intl.DateTimeFormat(locale === 'id' ? 'id-ID' : 'en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(`${date}T00:00:00Z`),
  );
}

/** `minor` units of `currency` as the member reads them (`Rp 12.500`); the plain decimal when the currency is unknown. */
export function mailMoney(locale: Locale, minor: number, currency: string): string {
  const whole = minor % 100 === 0;
  try {
    return new Intl.NumberFormat(locale === 'id' ? 'id-ID' : 'en-US', {
      style: 'currency',
      currency,
      minimumFractionDigits: whole ? 0 : 2,
      maximumFractionDigits: 2,
    }).format(minor / 100);
  } catch {
    return `${currency} ${(minor / 100).toFixed(2)}`;
  }
}

/** One loan line of a mail. */
export interface NoticeLoanLine {
  title: string;
  barcode: string;
  dueOn: string;
  /**
   * Overdue mails: the calendar days late, the days the running fine counts (fines.ts lateness; null: no fine) and the
   * running fine (minor units, 0: none).
   */
  daysLate?: number;
  finedDays?: number | null;
  fineMinor?: number;
}

/** What one mail says (the values of its placeholders). */
export type NoticeContent =
  | { kind: 'due_soon' | 'overdue'; loans: NoticeLoanLine[]; balanceMinor: number }
  | { kind: 'hold_ready'; title: string; branch: string; pickupUntil: string };

/** The mail of `content` for `member`, through the library's own template of the member's language when it saved one. */
export async function renderNotice(
  db: Db,
  member: NoticeMember,
  library: NoticeLibrary,
  content: NoticeContent,
): Promise<{ subject: string; text: string }> {
  const locale = member.locale;
  const kind = MAIL_KIND[content.kind];
  const subjectKey = `email.template.${kind}.${locale}.subject` as const;
  const bodyKey = `email.template.${kind}.${locale}.body` as const;
  const s = await readSettings(db, [subjectKey, bodyKey], []);
  const override = { subject: s[subjectKey] as string | null, body: s[bodyKey] as string | null };
  const vars: Record<string, string> = { name: member.name, memberNo: member.memberNo, library: library.name, link: library.link };
  if (content.kind === 'hold_ready') {
    vars['title'] = content.title;
    vars['branch'] = content.branch;
    vars['pickupUntil'] = mailDate(locale, content.pickupUntil);
  } else {
    const lines: string[] = [];
    for (const l of content.loans) {
      const due = mailDate(locale, l.dueOn);
      if (content.kind === 'overdue') {
        // The days the fine counts are named when they differ from the days late (closed days are not fined), as at the desk.
        const fined = l.finedDays ?? null;
        lines.push(
          fined !== null && fined !== (l.daysLate ?? 0)
            ? t(locale, 'mail.circulation.line.overdue_fined', { title: l.title, barcode: l.barcode, due, days: l.daysLate ?? 0, fined })
            : t(locale, 'mail.circulation.line.overdue', { title: l.title, barcode: l.barcode, due, days: l.daysLate ?? 0 }),
        );
        if ((l.fineMinor ?? 0) > 0) lines.push(t(locale, 'mail.circulation.line.fine', { amount: mailMoney(locale, l.fineMinor!, library.currency) }));
      } else {
        lines.push(t(locale, 'mail.circulation.line.due_soon', { title: l.title, barcode: l.barcode, due }));
      }
    }
    const earliest = content.loans.map((l) => l.dueOn).sort()[0];
    vars['loans'] = lines.join('\n');
    vars['count'] = String(content.loans.length);
    vars['due'] = earliest === undefined ? '' : mailDate(locale, earliest);
    vars['balance'] = content.balanceMinor > 0 ? t(locale, 'mail.circulation.balance', { amount: mailMoney(locale, content.balanceMinor, library.currency) }) : '';
  }
  const mail = renderMail(kind, locale, vars, override);
  // An empty value (no balance) leaves an empty paragraph: two blank lines become one.
  return { subject: mail.subject, text: mail.text.replace(/\n{3,}/g, '\n\n') };
}

/** The library facts of the mails: its name, the member area's link and the currency. */
export async function noticeLibrary(db: Db, baseUrl: string): Promise<NoticeLibrary> {
  const s = await readSettings(db, ['library.name', 'catalog.currency'], []);
  return { name: s['library.name'] as string, link: `${baseUrl.replace(/\/+$/, '')}/akun`, currency: s['catalog.currency'] as string };
}

/** The member of a notice, with the language of the mail (the member's, else the library's); null when gone. */
export async function noticeMember(
  db: Db,
  memberId: string,
): Promise<(NoticeMember & { email: string | null; inactive: boolean }) | null> {
  const m = await db
    .selectFrom('members')
    .select(['id', 'name', 'member_no_display', 'email', 'locale', 'archived_at', 'anonymized_at'])
    .where('id', '=', memberId)
    .executeTakeFirst();
  if (m === undefined) return null;
  const locale = isLocale(m.locale) ? m.locale : ((await readSettings(db, ['library.locale'], []))['library.locale'] as Locale);
  return {
    id: m.id,
    name: m.name,
    memberNo: m.member_no_display,
    locale,
    email: m.email === null || m.email.trim() === '' ? null : m.email.trim(),
    inactive: m.archived_at !== null || m.anonymized_at !== null,
  };
}

/** The ids of a stored list (only ULIDs). */
function idsOf(text: string | null): string[] {
  if (text === null) return [];
  try {
    const v: unknown = JSON.parse(text);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && isUlid(x)) : [];
  } catch {
    return [];
  }
}

/**
 * What the notice `row` has to say at `now`, read afresh: the loans still open (an overdue mail: those still past due,
 * with their days late and running fine, and the member's balance; a due-soon mail: those not yet past due), or the
 * hold still ready. Null when nothing is left (`resolved`).
 */
export async function noticeContent(
  db: Db,
  row: { kind: string; member_id: string; loan_ids: string | null; hold_id: string | null },
  now: number,
): Promise<NoticeContent | null> {
  if (row.kind === 'hold_ready') {
    if (row.hold_id === null) return null;
    const h = await db
      .selectFrom('holds as h')
      .innerJoin('records as r', 'r.id', 'h.record_id')
      .innerJoin('branches as b', 'b.id', 'h.pickup_branch_id')
      .select(['r.title', 'b.name as branch_name', 'h.pickup_until'])
      .where('h.id', '=', row.hold_id)
      .where('h.member_id', '=', row.member_id)
      .where('h.status', '=', 'ready')
      .executeTakeFirst();
    if (h === undefined || h.pickup_until === null) return null;
    return { kind: 'hold_ready', title: h.title, branch: h.branch_name, pickupUntil: h.pickup_until };
  }
  if (row.kind !== 'due_soon' && row.kind !== 'overdue') return null;
  const ids = idsOf(row.loan_ids);
  if (ids.length === 0) return null;
  const loans = await db
    .selectFrom('loans as l')
    .leftJoin('items as i', 'i.id', 'l.item_id')
    .leftJoin('records as r', 'r.id', 'l.record_id')
    .select([
      'l.id',
      'l.branch_id',
      'l.due_on',
      'l.currency',
      'l.fine_per_day_minor',
      'l.fine_cap_minor',
      'l.grace_days',
      'i.barcode_display',
      'r.title',
    ])
    .where('l.id', 'in', ids)
    .where('l.member_id', '=', row.member_id)
    .where('l.open_item_id', 'is not', null)
    .orderBy('l.due_on')
    .orderBy('l.id')
    .execute();
  const todays = new Map<string, string>();
  const todayOf = async (branchId: string): Promise<string> => {
    let d = todays.get(branchId);
    if (d === undefined) {
      d = await branchToday(db, branchId, now);
      todays.set(branchId, d);
    }
    return d;
  };
  const fines = row.kind === 'overdue' ? await FinePreviewer.open(db) : null;
  const lines: NoticeLoanLine[] = [];
  for (const l of loans) {
    const today = await todayOf(l.branch_id);
    const late = l.due_on < today;
    if (row.kind === 'overdue' ? !late : late) continue;
    const line: NoticeLoanLine = { title: l.title ?? '', barcode: l.barcode_display ?? '', dueOn: l.due_on };
    if (fines !== null) {
      const late = await fines.lateness(
        {
          branchId: l.branch_id,
          dueOn: l.due_on,
          finePerDayMinor: Number(l.fine_per_day_minor),
          fineCapMinor: l.fine_cap_minor === null ? null : Number(l.fine_cap_minor),
          graceDays: Number(l.grace_days),
        },
        today,
      );
      line.daysLate = late.daysLate;
      line.finedDays = late.finedDays;
      line.fineMinor = late.fineMinor;
    }
    lines.push(line);
  }
  if (lines.length === 0) return null;
  const balanceMinor = row.kind === 'overdue' ? ((await memberBalances(db, [row.member_id])).get(row.member_id) ?? 0) : 0;
  return { kind: row.kind, loans: lines, balanceMinor };
}

/** Sample values of a mail of `kind` (the settings screen's preview and test send). */
export function sampleNoticeContent(kind: NoticeKind, today: string): NoticeContent {
  if (kind === 'hold_ready') return { kind, title: 'Laskar Pelangi', branch: 'Perpustakaan Pusat', pickupUntil: addDays(today, 3) };
  if (kind === 'due_soon') {
    return {
      kind,
      loans: [
        { title: 'Laskar Pelangi', barcode: 'B00012', dueOn: addDays(today, 2) },
        { title: 'Bumi Manusia', barcode: 'B00345', dueOn: addDays(today, 2) },
      ],
      balanceMinor: 0,
    };
  }
  return {
    kind,
    loans: [{ title: 'Laskar Pelangi', barcode: 'B00012', dueOn: addDays(today, -8), daysLate: 8, fineMinor: 400_000 }],
    balanceMinor: 650_000,
  };
}

/** The local date of `now` in the library's time zone. */
export async function noticesToday(db: Db, now: number): Promise<string> {
  return localDate(await libraryTimeZone(db), now);
}
