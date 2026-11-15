import { withTx, type DbHandle } from '@altis/db';
import { addDays, isDomainError, isUlid, localDate } from '@altis/shared';
import { sql, type SqlBool } from 'kysely';
import { z } from 'zod';
import { errorFields } from '../context.js';
import type { JobContext, JobHandler, JobOutcome } from '../jobs/types.js';
import { JOB_LEASE_MS } from '../jobs/types.js';
import type { MailJobDeps } from '../mail/jobs.js';
import { libraryTimeZone, type Db } from '../members/common.js';
import { notify } from '../notifications/service.js';
import { readClockAnomaly } from '../scheduler/clock.js';
import { scheduleWindowSchema } from '../scheduler/registry.js';
import {
  NOTICES_BUILD_JOB,
  NOTICES_SEND_JOB,
  NOTICE_MAX_ATTEMPTS,
  enqueueNoticeSender,
  noticeContent,
  noticeLibrary,
  noticeMember,
  noticeSettings,
  noticesSendPayload,
  overdueReminderDays,
  queueNotice,
  renderNotice,
  type NoticesSendCounts,
  type NoticesSendPayload,
} from './notices.js';

// The two notice jobs.
//
// `circulation.notices` (daily at 07:00 library time, scheduler/registry.ts) only builds `queued` rows, then enqueues
// the sender:
// - due soon: each member's open loans due exactly `dueSoonDays` days after today (today of the loan's branch), one
//   notice per member and due date (`due_soon:<memberId>:<due_on>`);
// - overdue: each member with an open loan whose days late are a reminder day (1, 1 + e, 1 + 2e, … up to `overdueMax`
//   times), one notice per member and run date (`overdue:<memberId>:<run date>`) listing all of the member's overdue
//   loans;
// - the hold shelf: when copies of expired or cancelled holds still sit on the hold shelf, one staff notification.
// It works in slices (members by id, a page at a time), its checkpoint holds the run date and each branch's today, so a
// job killed and run again builds the same rows (the unique `ref_key` adds nothing twice). It does nothing while the
// clock looks wrong (`system.clock_anomaly`): a clock that jumped would make every loan "overdue". One audit entry
// `circulation.notices.run` per run with its counts.
//
// `circulation.notices_send` (one alive at a time: unique key) sends the queued rows through the library's SMTP server:
// - at the start of each slice, rows left `sending` longer than a job lease (a sender that died) go back to `queued`
//   with one more attempt; at the start of a new sender, failed rows with attempts left are queued again;
// - a slice claims at most 50 rows with `UPDATE … SET status = 'sending', job_id, claimed_at WHERE id IN (…) AND
//   status = 'queued'` and reads back the rows it holds (job id and claim time), so two senders at once never hold the
//   same row; only claimed rows are sent, one by one, outside any transaction, each marked `sent`, `failed` (attempts
//   + 1; tried again by the next sender up to 5 attempts) or `skipped` (no address, no SMTP server, the member gone,
//   nothing left to say) right after its send;
// - a send starts only while 10 s of the slice's budget are left (the job mailer bounds a whole session to 9 s), so a
//   claimed row is sent well inside a lease; rows claimed but not reached go back to `queued`;
// - only a sender that dies between the server's "accepted" and the row's update can send a mail twice (accepted risk);
// - a run with failed sends, or with mails not sent because SMTP is not set up, notifies the staff who manage the
//   settings (at most once in 12 hours).

/** The job message of a run skipped because the clock looked wrong. */
const POSTPONED = 'date_jobs_postponed';

/** Members read per page by the build. */
const MEMBER_PAGE = 200;

/** Below this much budget left, the build stops at the next page. */
const BUILD_MARGIN_MS = 3000;

/** At most this many rows claimed at a time. */
export const NOTICE_CLAIM_BATCH = 50;

/** A send starts only with this much of the slice's budget left (the job mailer's whole session is ≤ 9 s). */
const SEND_MARGIN_MS = 10_000;

/** The staff notification about failed sends is written at most this often. */
const FAILED_NOTIFY_EVERY_MS = 12 * 3_600_000;

// ---- the build -------------------------------------------------------------------------------------------------------------

const buildCounts = z.strictObject({ dueSoon: z.int().min(0), overdue: z.int().min(0), existing: z.int().min(0) });
const dateText = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** The payload of `circulation.notices`: the schedule window, then the checkpoint of a continuing run. */
export const noticesBuildPayload = scheduleWindowSchema.extend({
  phase: z.enum(['due_soon', 'overdue', 'finish']).optional(),
  after: z.string().refine(isUlid).optional(),
  runDate: dateText.optional(),
  todays: z.record(z.string().refine(isUlid), dateText).optional(),
  counts: buildCounts.optional(),
});

export type NoticesBuildPayload = z.infer<typeof noticesBuildPayload>;
export type NoticesBuildCounts = z.infer<typeof buildCounts>;

/** Each branch's today (its time zone, else the library's). */
async function branchTodays(db: Db, now: number): Promise<Record<string, string>> {
  const zone = await libraryTimeZone(db);
  const rows = await db.selectFrom('branches').select(['id', 'timezone']).execute();
  return Object.fromEntries(rows.map((b) => [b.id, localDate(b.timezone || zone, now)]));
}

/** `(l.branch_id = b AND l.due_on IN (dates_b)) OR …`, or null when there is nothing to match. */
function dueOnAny(todays: Record<string, string>, offsets: readonly number[]) {
  if (offsets.length === 0) return null;
  const parts = Object.entries(todays).map(([branchId, today]) => {
    const dates = offsets.map((d) => addDays(today, d));
    return sql<SqlBool>`(l.branch_id = ${branchId} and l.due_on in (${sql.join(dates)}))`;
  });
  return parts.length === 0 ? null : sql<SqlBool>`(${sql.join(parts, sql` or `)})`;
}

/** `(l.branch_id = b AND l.due_on < today_b) OR …` (open and overdue). */
function overdueAny(todays: Record<string, string>) {
  const parts = Object.entries(todays).map(([branchId, today]) => sql<SqlBool>`(l.branch_id = ${branchId} and l.due_on < ${today})`);
  return parts.length === 0 ? null : sql<SqlBool>`(${sql.join(parts, sql` or `)})`;
}

/** The next page of members (by id, after `after`) with an open loan matching `match`; members archived or anonymised are left out. */
async function memberPage(db: Db, match: ReturnType<typeof dueOnAny>, after: string | undefined): Promise<string[]> {
  if (match === null) return [];
  let q = db
    .selectFrom('loans as l')
    .innerJoin('members as m', 'm.id', 'l.member_id')
    .select('l.member_id')
    .distinct()
    .where('l.open_item_id', 'is not', null)
    .where('m.archived_at', 'is', null)
    .where('m.anonymized_at', 'is', null)
    .where(match);
  if (after !== undefined) q = q.where('l.member_id', '>', after);
  const rows = await q.orderBy('l.member_id').limit(MEMBER_PAGE).execute();
  return rows.map((r) => r.member_id).filter((id): id is string => id !== null);
}

/**
 * Builds one page of `phase` for the members after `after`: the rows inserted and existing, and the last member (or
 * null when the phase is done).
 */
async function buildPage(
  h: DbHandle,
  now: number,
  phase: 'due_soon' | 'overdue',
  p: { after: string | undefined; runDate: string; todays: Record<string, string>; dueSoonDays: number; reminderDays: number[] },
): Promise<{ inserted: number; existing: number; last: string | null }> {
  const match = phase === 'due_soon' ? dueOnAny(p.todays, [p.dueSoonDays]) : dueOnAny(p.todays, p.reminderDays.map((d) => -d));
  const members = await memberPage(h.db, match, p.after);
  if (members.length === 0) return { inserted: 0, existing: 0, last: null };
  const where = phase === 'due_soon' ? match : overdueAny(p.todays);
  const loans = await h.db
    .selectFrom('loans as l')
    .select(['l.id', 'l.member_id', 'l.due_on'])
    .where('l.member_id', 'in', members)
    .where('l.open_item_id', 'is not', null)
    .where(where!)
    .orderBy('l.due_on')
    .orderBy('l.id')
    .execute();
  // due soon: one notice per member and due date; overdue: one per member with all overdue loans.
  const groups = new Map<string, { memberId: string; refKey: string; loanIds: string[] }>();
  for (const l of loans) {
    if (l.member_id === null) continue;
    const refKey = phase === 'due_soon' ? `due_soon:${l.member_id}:${l.due_on}` : `overdue:${l.member_id}:${p.runDate}`;
    const g = groups.get(refKey) ?? { memberId: l.member_id, refKey, loanIds: [] };
    g.loanIds.push(l.id);
    groups.set(refKey, g);
  }
  let inserted = 0;
  let existing = 0;
  await withTx(h, async (trx) => {
    inserted = 0;
    existing = 0;
    for (const g of groups.values()) {
      if (await queueNotice(trx, { memberId: g.memberId, kind: phase, refKey: g.refKey, loanIds: g.loanIds }, now)) inserted += 1;
      else existing += 1;
    }
  });
  return { inserted, existing, last: members.length < MEMBER_PAGE ? null : members[members.length - 1]! };
}

/** How many holds closed with their copy still on the hold shelf (expired or cancelled after being ready). */
async function holdShelfToClear(db: Db): Promise<number> {
  const rows = await db
    .selectFrom('holds')
    .select('id')
    .where('status', 'in', ['expired', 'cancelled'])
    .where('ready_at', 'is not', null)
    .where('shelf_cleared_at', 'is', null)
    .limit(10_000)
    .execute();
  return rows.length;
}

/**
 * Runs the build from `p` on `h` at `now` while `budgetLeftMs` allows: the next checkpoint, or the finished counts.
 * Exported for the tests (a job slice is this plus the clock check, the audit and the notifications).
 */
export async function runNoticesBuild(
  h: DbHandle,
  now: number,
  p: NoticesBuildPayload,
  budgetLeftMs: () => number = () => Number.POSITIVE_INFINITY,
): Promise<{ done: false; next: NoticesBuildPayload } | { done: true; counts: NoticesBuildCounts }> {
  const settings = await noticeSettings(h.db);
  const runDate = p.runDate ?? localDate(await libraryTimeZone(h.db), now);
  const todays = p.todays ?? (await branchTodays(h.db, now));
  const counts: NoticesBuildCounts = { ...(p.counts ?? { dueSoon: 0, overdue: 0, existing: 0 }) };
  let phase = p.phase ?? 'due_soon';
  let after = p.after;
  const reminderDays = overdueReminderDays(settings.overdueEveryDays, settings.overdueMax);
  let pages = 0;
  while (phase !== 'finish') {
    if (pages > 0 && budgetLeftMs() < BUILD_MARGIN_MS) {
      return { done: false, next: { windowStart: p.windowStart, windowEnd: p.windowEnd, phase, ...(after === undefined ? {} : { after }), runDate, todays, counts } };
    }
    const off = phase === 'due_soon' ? settings.dueSoonDays === 0 : reminderDays.length === 0;
    const page = off ? { inserted: 0, existing: 0, last: null } : await buildPage(h, now, phase, { after, runDate, todays, dueSoonDays: settings.dueSoonDays, reminderDays });
    pages += 1;
    if (phase === 'due_soon') counts.dueSoon += page.inserted;
    else counts.overdue += page.inserted;
    counts.existing += page.existing;
    if (page.last === null) {
      phase = phase === 'due_soon' ? 'overdue' : 'finish';
      after = undefined;
    } else {
      after = page.last;
    }
  }
  return { done: true, counts };
}

/** The `circulation.notices` handler: permission `system.jobs.manage` (its schedule's), retryable from the API. */
export function noticesBuildJob(): JobHandler<NoticesBuildPayload> {
  return {
    type: NOTICES_BUILD_JOB,
    permission: 'system.jobs.manage',
    retryable: 'api',
    payload: noticesBuildPayload,
    async run(ctx, p): Promise<JobOutcome<NoticesBuildPayload>> {
      if ((await readClockAnomaly(ctx.db)) !== null) {
        ctx.log.info('circulation.notices: skipped while the clock looks wrong', { jobId: ctx.jobId });
        return { done: true, message: POSTPONED };
      }
      const r = await runNoticesBuild(ctx.handle, ctx.now(), p, () => ctx.budgetLeftMs());
      if (!r.done) return { continueWith: r.next, progress: r.next.phase === 'overdue' ? 50 : 25 };
      const now = ctx.now();
      await withTx(ctx.handle, (trx) => enqueueNoticeSender(trx, now));
      await ctx.audit({ action: 'circulation.notices.run', entity: null, entityId: null, meta: { ...r.counts } });
      const toClear = await holdShelfToClear(ctx.db);
      if (toClear > 0) {
        await withTx(ctx.handle, (trx) =>
          notify(
            trx,
            {
              audience: { permission: 'circulation.desk.use' },
              type: 'circulation.hold_shelf',
              titleKey: 'notification.circulation_hold_shelf.title',
              params: { count: toClear },
              link: '/admin/layanan/rak-tunggu',
            },
            now,
          ),
        );
      }
      return { done: true };
    },
  };
}

// ---- the sender ------------------------------------------------------------------------------------------------------------

type ClaimedRow = { id: string; kind: string; member_id: string; loan_ids: string | null; hold_id: string | null; attempts: number; reason: string | null };

/** Rows left `sending` longer than a job lease go back to `queued` with one more attempt; on a new sender, failed rows with attempts left too. */
export async function releaseStaleNotices(h: DbHandle, now: number, o: { retryFailed: boolean }): Promise<void> {
  await withTx(h, async (trx) => {
    await trx
      .updateTable('notices')
      .set((eb) => ({ status: 'queued', job_id: null, claimed_at: null, attempts: eb('attempts', '+', 1) }))
      .where('status', '=', 'sending')
      .where('claimed_at', '<', now - JOB_LEASE_MS)
      .execute();
    if (o.retryFailed) {
      await trx
        .updateTable('notices')
        .set({ status: 'queued', job_id: null, claimed_at: null })
        .where('status', '=', 'failed')
        .where('attempts', '<', NOTICE_MAX_ATTEMPTS)
        .execute();
    }
  });
}

/**
 * Claims at most `limit` queued rows for the job `jobId` at `now`: the oldest first, `status = 'queued'` checked in the
 * UPDATE, so of two senders each row goes to one. The rows this claim holds (job id and claim time).
 */
export async function claimNotices(h: DbHandle, jobId: string, now: number, limit = NOTICE_CLAIM_BATCH): Promise<ClaimedRow[]> {
  return withTx(h, async (trx) => {
    const ids = (await trx.selectFrom('notices').select('id').where('status', '=', 'queued').orderBy('created_at').orderBy('id').limit(limit).execute()).map((r) => r.id);
    if (ids.length === 0) return [];
    await trx.updateTable('notices').set({ status: 'sending', job_id: jobId, claimed_at: now }).where('id', 'in', ids).where('status', '=', 'queued').execute();
    const rows = await trx
      .selectFrom('notices')
      .select(['id', 'kind', 'member_id', 'loan_ids', 'hold_id', 'attempts', 'reason'])
      .where('job_id', '=', jobId)
      .where('claimed_at', '=', now)
      .where('status', '=', 'sending')
      .orderBy('created_at')
      .orderBy('id')
      .execute();
    return rows.map((r) => ({ ...r, attempts: Number(r.attempts) }));
  });
}

/** Rows claimed by `jobId` and not sent go back to `queued` (no attempt counted). */
async function releaseClaimed(h: DbHandle, jobId: string, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  await withTx(h, (trx) =>
    trx.updateTable('notices').set({ status: 'queued', job_id: null, claimed_at: null }).where('id', 'in', [...ids]).where('job_id', '=', jobId).where('status', '=', 'sending').execute(),
  );
}

type Outcome = { status: 'sent' } | { status: 'failed'; reason: string; tried: boolean } | { status: 'skipped'; reason: string };

/** The SMTP stage of a failed send as a notice reason. */
function failureReason(error: unknown): string {
  if (isDomainError(error) && error.code === 'SMTP_FAILED') {
    const stage = error.meta?.['reason'];
    if (stage === 'connect' || stage === 'tls' || stage === 'auth' || stage === 'send') return `smtp_${stage}`;
  }
  return 'error';
}

/** Sends one claimed row (outside any transaction): what became of it. */
async function deliver(deps: MailJobDeps, ctx: Pick<JobContext, 'db' | 'log'>, row: ClaimedRow, now: number): Promise<Outcome> {
  if (row.attempts >= NOTICE_MAX_ATTEMPTS) return { status: 'failed', reason: row.reason ?? 'error', tried: false };
  const member = await noticeMember(ctx.db, row.member_id);
  if (member === null || member.inactive) return { status: 'skipped', reason: 'member_inactive' };
  if (member.email === null) return { status: 'skipped', reason: 'no_email' };
  let mail: { subject: string; text: string };
  try {
    const content = await noticeContent(ctx.db, row, now);
    if (content === null) return { status: 'skipped', reason: 'resolved' };
    mail = await renderNotice(ctx.db, member, await noticeLibrary(ctx.db, deps.baseUrl()), content);
  } catch (error) {
    ctx.log.error('notice failed', { stage: 'render', ...errorFields(error) });
    return { status: 'failed', reason: 'error', tried: true };
  }
  try {
    await deps.mailer.send({ to: member.email, subject: mail.subject, text: mail.text });
    return { status: 'sent' };
  } catch (error) {
    if (isDomainError(error) && error.code === 'SMTP_NOT_CONFIGURED') return { status: 'skipped', reason: 'smtp_not_configured' };
    ctx.log.error('notice failed', { stage: 'send', ...errorFields(error) });
    return { status: 'failed', reason: failureReason(error), tried: true };
  }
}

/** Marks a claimed row with its outcome (only while this job still holds it). */
async function mark(h: DbHandle, jobId: string, row: ClaimedRow, o: Outcome, now: number): Promise<void> {
  await withTx(h, async (trx) => {
    const held = trx.updateTable('notices').where('id', '=', row.id).where('job_id', '=', jobId).where('status', '=', 'sending');
    if (o.status === 'sent') await held.set((eb) => ({ status: 'sent', reason: null, sent_at: now, attempts: eb('attempts', '+', 1) })).execute();
    else if (o.status === 'failed' && o.tried) await held.set((eb) => ({ status: 'failed', reason: o.reason, attempts: eb('attempts', '+', 1) })).execute();
    else await held.set({ status: o.status, reason: o.reason }).execute();
  });
}

/** Tells the staff who manage the settings that reminders did not go out (at most once in 12 hours). */
async function notifyFailures(h: DbHandle, counts: NoticesSendCounts, now: number): Promise<void> {
  if (counts.failed + counts.noSmtp === 0) return;
  await withTx(h, async (trx) => {
    const recent = await trx
      .selectFrom('notifications')
      .select('id')
      .where('type', '=', 'circulation.notices_failed')
      .where('created_at', '>', now - FAILED_NOTIFY_EVERY_MS)
      .executeTakeFirst();
    if (recent !== undefined) return;
    await notify(
      trx,
      {
        audience: { permission: 'system.settings.manage' },
        type: 'circulation.notices_failed',
        titleKey: 'notification.circulation_notices_failed.title',
        params: { failed: counts.failed, skipped: counts.noSmtp },
        link: '/admin/layanan/pengingat',
      },
      now,
    );
  });
}

/**
 * One slice of the sender (see the top of this file) with `deps` as the mail deps: the counts so far, and whether rows
 * remain; the last slice tells the staff about failures. Exported for the tests.
 */
export async function runNoticesSend(
  deps: MailJobDeps,
  ctx: Pick<JobContext, 'db' | 'handle' | 'log' | 'jobId' | 'now' | 'budgetLeftMs' | 'cancelled'> & { heartbeat?: () => Promise<void> },
  p: NoticesSendPayload,
): Promise<{ counts: NoticesSendCounts; more: boolean }> {
  const counts: NoticesSendCounts = { ...(p.counts ?? { sent: 0, failed: 0, skipped: 0, noSmtp: 0 }) };
  await releaseStaleNotices(ctx.handle, ctx.now(), { retryFailed: p.counts === undefined });
  for (;;) {
    if (ctx.budgetLeftMs() < SEND_MARGIN_MS || ctx.cancelled()) return { counts, more: true };
    const rows = await claimNotices(ctx.handle, ctx.jobId, ctx.now());
    if (rows.length === 0) {
      await notifyFailures(ctx.handle, counts, ctx.now());
      return { counts, more: false };
    }
    for (let k = 0; k < rows.length; k++) {
      if (ctx.budgetLeftMs() < SEND_MARGIN_MS || ctx.cancelled()) {
        await releaseClaimed(ctx.handle, ctx.jobId, rows.slice(k).map((r) => r.id));
        return { counts, more: true };
      }
      const row = rows[k]!;
      const outcome = await deliver(deps, ctx, row, ctx.now());
      await mark(ctx.handle, ctx.jobId, row, outcome, ctx.now());
      if (outcome.status === 'sent') counts.sent += 1;
      else if (outcome.status === 'failed') counts.failed += 1;
      else {
        counts.skipped += 1;
        if (outcome.reason === 'smtp_not_configured') counts.noSmtp += 1;
      }
    }
    if (ctx.heartbeat !== undefined) await ctx.heartbeat();
  }
}

/**
 * The `circulation.notices_send` handler, built with the mail deps of the job runtime: permission `system.jobs.manage`,
 * retryable from the API, 5 attempts.
 */
export function noticesSendJob(deps: MailJobDeps): JobHandler<NoticesSendPayload> {
  return {
    type: NOTICES_SEND_JOB,
    permission: 'system.jobs.manage',
    retryable: 'api',
    maxAttempts: NOTICE_MAX_ATTEMPTS,
    payload: noticesSendPayload,
    async run(ctx, p): Promise<JobOutcome<NoticesSendPayload>> {
      const r = await runNoticesSend(
        deps,
        {
          db: ctx.db,
          handle: ctx.handle,
          log: ctx.log,
          jobId: ctx.jobId,
          now: () => ctx.now(),
          budgetLeftMs: () => ctx.budgetLeftMs(),
          cancelled: () => ctx.cancelled(),
          heartbeat: () => ctx.heartbeat(),
        },
        p,
      );
      if (r.more) return { continueWith: { counts: r.counts }, progress: 50 };
      return { done: true };
    },
  };
}
