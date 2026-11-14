import { withTx } from '@altis/db';
import { DomainError, addDays } from '@altis/shared';
import type { MemberBody } from '@altis/shared/api/members';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { engineLabel, testDbContext } from '../../../../tools/test/test-db.js';
import {
  claimNotices,
  createMember,
  createPolicy,
  createSettingsCache,
  lendItem,
  listNotices,
  noticesRetentionStep,
  overdueReminderDays,
  renderNotice,
  sampleNoticeContent,
  noticesBuildPayload,
  placeHold,
  queueNotice,
  releaseStaleNotices,
  returnItem,
  runNoticesBuild,
  runNoticesSend,
  sendManualNotices,
  type Mailer,
  type MailJobDeps,
} from '../../src/index.js';
import { writeSettings } from '../../src/settings/service.js';
import { DAY, NOW, openItemsDb, seedItem, seedRecord, type ItemsDb } from './catalog-items-support.js';

// Member notices on the engine picked by ALTIS_TEST_DB: the daily build (due soon on the right day, overdue on the
// reminder days only, the same rows when it is run again or resumed), the sender (each row claimed by one sender, sent
// once even with two senders at once; abandoned claims back to the queue; no address, no SMTP server, a returned loan;
// failed sends tried again by the next sender up to five attempts; the staff notified), the hold that becomes ready, and
// the manual send.

const ctx = testDbContext();

/** NOW in Jakarta: Wednesday 2 September 2026. */
const TODAY = '2026-09-02';

type Settings = Parameters<typeof writeSettings>[1];

/** A mailer that records what it sends (after a short pause, so that two senders interleave). */
function recordingMailer(): Mailer & { sent: { to: string; subject: string; text: string }[] } {
  const sent: { to: string; subject: string; text: string }[] = [];
  return {
    sent,
    async send(m) {
      await new Promise((resolve) => setTimeout(resolve, 2));
      sent.push(m);
    },
  };
}

const silentLog = { info: () => {}, warn: () => {}, error: () => {} };

describe.skipIf(!ctx.available)(`member notices [${engineLabel()}]`, () => {
  let db: ItemsDb;
  let siswa: string;
  let seq = 0;

  async function member(o: Partial<MemberBody> = {}): Promise<string> {
    seq += 1;
    const body = { memberNo: `NT-${seq}`, memberTypeId: siswa, name: `Anggota ${seq}`, email: `anggota${seq}@example.test`, ...o } as MemberBody;
    return (await db.run((tx) => createMember(tx, body))).id;
  }
  async function item(): Promise<{ barcode: string; id: string; recordId: string }> {
    seq += 1;
    const recordId = await seedRecord(db, { title: `Buku ${seq}` });
    const barcode = `NT-B-${seq}`;
    return { barcode, id: await seedItem(db, recordId, { barcode }), recordId };
  }
  /** A loan of a new item to `memberId`, lent `daysAgo` days ago (7-day loans: due in `7 - daysAgo` days). */
  async function loanFor(memberId: string, daysAgo: number): Promise<{ loanId: string; barcode: string }> {
    const book = await item();
    const loan = await db.run((tx) => lendItem(tx, { branchId: db.branchId, memberId, barcode: book.barcode }), NOW - daysAgo * DAY);
    return { loanId: loan.id, barcode: book.barcode };
  }
  const settings = (patch: Settings) => withTx(db.h, (trx) => writeSettings(trx, patch, { keyring: [], now: NOW, actorId: null }));
  const notices = (memberId: string) => db.h.db.selectFrom('notices').selectAll().where('member_id', '=', memberId).orderBy('created_at').orderBy('id').execute();
  const window = { windowStart: NOW - DAY, windowEnd: NOW };
  const deps = (mailer: Mailer): MailJobDeps => ({ mailer, baseUrl: () => 'https://perpus.example.test/', settings: createSettingsCache() });
  const sender = (jobId: string, now = NOW) => ({
    db: db.h.db,
    handle: db.h,
    log: silentLog,
    jobId,
    now: () => now,
    budgetLeftMs: () => 1_000_000,
    cancelled: () => false,
  });
  /** Clears every notice (each test starts from an empty queue). */
  const clearQueue = () => db.h.db.deleteFrom('notices').execute();

  beforeAll(async () => {
    db = await openItemsDb('notices');
    siswa = (await db.h.db.selectFrom('member_types').select('id').where('code_key', '=', 'SISWA').executeTakeFirstOrThrow()).id;
    await db.h.db.updateTable('branches').set({ timezone: 'Asia/Jakarta' }).execute();
    // Pupils: 7 days, 500.00 a day, no grace days.
    await db.run((tx) => createPolicy(tx, { code: 'SISWA-NT', name: 'Siswa', memberTypeId: siswa, loanDays: 7, loanLimit: null, renewLimit: 2, finePerDay: '500', graceDays: 0 } as never));
    await settings({ 'circulation.notices.dueSoonDays': 2, 'circulation.notices.overdueEveryDays': 7, 'circulation.notices.overdueMax': 3 });
  });
  afterAll(async () => {
    await db?.close();
  });

  it('a notice is queued once per ref_key: a second insert of the same key adds nothing and leaves the transaction usable', async () => {
    const m = await member();
    const first = await withTx(db.h, async (trx) => {
      const a = await queueNotice(trx, { memberId: m, kind: 'overdue', refKey: `overdue:${m}:${TODAY}`, loanIds: [] }, NOW);
      const b = await queueNotice(trx, { memberId: m, kind: 'overdue', refKey: `overdue:${m}:${TODAY}`, loanIds: [] }, NOW);
      // The transaction still works after the refused insert.
      const c = await queueNotice(trx, { memberId: m, kind: 'due_soon', refKey: `due_soon:${m}:${TODAY}`, loanIds: [] }, NOW);
      return [a, b, c];
    });
    expect(first).toEqual([true, false, true]);
    expect(await notices(m)).toHaveLength(2);
    await clearQueue();
  });

  it('the daily build: due soon on the right day, overdue on the reminder days only; run again or resumed it adds nothing', async () => {
    const soon = await member();
    const soonLoan = await loanFor(soon, 5); // due in 2 days
    await loanFor(soon, 4); // due in 3 days: not yet
    const late1 = await member();
    const late1Loan = await loanFor(late1, 8); // 1 day late: a reminder day
    const late1Other = await loanFor(late1, 10); // 3 days late: listed with it
    const late3 = await member();
    await loanFor(late3, 10); // 3 days late only: no reminder today
    const late8 = await member();
    await loanFor(late8, 15); // 8 days late: the second reminder (1 + 7)

    // A run killed after its first page resumes from its checkpoint.
    const first = await runNoticesBuild(db.h, NOW, noticesBuildPayload.parse(window), () => 0);
    expect(first.done).toBe(false);
    const resumed = first.done ? null : await runNoticesBuild(db.h, NOW, first.next, () => 1_000_000);
    expect(resumed).toEqual({ done: true, counts: { dueSoon: 1, overdue: 2, existing: 0 } });

    const s = await notices(soon);
    expect(s.map((n) => [n.kind, n.ref_key, JSON.parse(n.loan_ids!)])).toEqual([['due_soon', `due_soon:${soon}:${addDays(TODAY, 2)}`, [soonLoan.loanId]]]);
    const l1 = await notices(late1);
    expect(l1.map((n) => [n.kind, n.ref_key, n.status])).toEqual([['overdue', `overdue:${late1}:${TODAY}`, 'queued']]);
    expect([...JSON.parse(l1[0]!.loan_ids!)].sort()).toEqual([late1Loan.loanId, late1Other.loanId].sort());
    expect(await notices(late3)).toEqual([]);
    expect(await notices(late8)).toHaveLength(1);

    // The same day again (a second run, the job run again after a crash): nothing new.
    const again = await runNoticesBuild(db.h, NOW, noticesBuildPayload.parse(window));
    expect(again).toEqual({ done: true, counts: { dueSoon: 0, overdue: 0, existing: 3 } });
    expect(await db.h.db.selectFrom('notices').select('id').execute()).toHaveLength(3);

    // Switched off: nothing is built.
    await clearQueue();
    await settings({ 'circulation.notices.dueSoonDays': 0, 'circulation.notices.overdueMax': 0 });
    expect(await runNoticesBuild(db.h, NOW, noticesBuildPayload.parse(window))).toEqual({ done: true, counts: { dueSoon: 0, overdue: 0, existing: 0 } });
    await settings({ 'circulation.notices.dueSoonDays': 2, 'circulation.notices.overdueMax': 3 });
    // Leave the loans of this test out of the next ones.
    await db.h.db.updateTable('loans').set({ open_item_id: null, returned_at: NOW, returned_on: TODAY }).where('member_id', 'in', [soon, late1, late3, late8]).execute();
    await clearQueue();
  });

  it('the sender: the mail in the member’s language with the loans, the fine and the balance; no address and returned loans are skipped', async () => {
    const reader = await member({ locale: 'en' });
    const lateLoan = await loanFor(reader, 10); // 3 days late: 1 500.00 so far
    const noMail = await member({ email: undefined });
    await loanFor(noMail, 10);
    const gone = await member();
    const goneLoan = await loanFor(gone, 10);
    await withTx(db.h, async (trx) => {
      for (const m of [reader, noMail, gone]) {
        const loans = await trx.selectFrom('loans').select('id').where('member_id', '=', m).execute();
        await queueNotice(trx, { memberId: m, kind: 'overdue', refKey: `overdue:${m}:${TODAY}`, loanIds: loans.map((l) => l.id) }, NOW);
      }
    });
    await db.run((tx) => returnItem(tx, { branchId: db.branchId, barcode: goneLoan.barcode }), NOW);

    const mailer = recordingMailer();
    const r = await runNoticesSend(deps(mailer), sender('01JOBSENDER00000000000001A'), {});
    expect(r).toEqual({ counts: { sent: 1, failed: 0, skipped: 2, noSmtp: 0 }, more: false });
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]!.to).toBe((await db.h.db.selectFrom('members').select('email').where('id', '=', reader).executeTakeFirstOrThrow()).email);
    expect(mailer.sent[0]!.subject).toContain('overdue');
    expect(mailer.sent[0]!.text).toContain(lateLoan.barcode);
    expect(mailer.sent[0]!.text).toContain('3 days late');
    expect(mailer.sent[0]!.text).toContain('https://perpus.example.test/akun');
    expect(mailer.sent[0]!.text).not.toMatch(/\n{3,}/);

    expect((await notices(reader)).map((n) => [n.status, n.reason, Number(n.attempts)])).toEqual([['sent', null, 1]]);
    expect((await notices(noMail)).map((n) => [n.status, n.reason])).toEqual([['skipped', 'no_email']]);
    expect((await notices(gone)).map((n) => [n.status, n.reason])).toEqual([['skipped', 'resolved']]);
    // A second sender finds nothing to send.
    expect((await runNoticesSend(deps(mailer), sender('01JOBSENDER00000000000002A'), {})).counts.sent).toBe(0);
    expect(mailer.sent).toHaveLength(1);
    await clearQueue();
  });

  it('two senders at once never send the same row; a claim left by a dead sender goes back to the queue with one more attempt', async () => {
    const ids: string[] = [];
    const loanIds: string[] = [];
    for (let k = 0; k < 30; k++) {
      const m = await member();
      ids.push(m);
      loanIds.push((await loanFor(m, 5)).loanId);
    }
    await withTx(db.h, async (trx) => {
      for (let k = 0; k < 30; k++) {
        await queueNotice(trx, { memberId: ids[k]!, kind: 'due_soon', refKey: `due_soon:${ids[k]!}:${addDays(TODAY, 2)}`, loanIds: [loanIds[k]!] }, NOW);
      }
    });
    // A dead sender's claim of one row, older than a job lease.
    const dead = await claimNotices(db.h, '01JOBDEAD000000000000000AA', NOW - 120_000, 1);
    expect(dead).toHaveLength(1);
    const mailer = recordingMailer();
    const [a, b] = await Promise.all([
      runNoticesSend(deps(mailer), sender('01JOBSENDER00000000000003A'), {}),
      runNoticesSend(deps(mailer), sender('01JOBSENDER00000000000004A'), {}),
    ]);
    expect(a.counts.sent + b.counts.sent).toBe(30);
    expect(mailer.sent).toHaveLength(30);
    expect(new Set(mailer.sent.map((m) => m.to)).size).toBe(30);
    const rows = await db.h.db.selectFrom('notices').select(['id', 'status', 'attempts']).execute();
    expect(rows.every((r) => r.status === 'sent')).toBe(true);
    expect(Number(rows.find((r) => r.id === dead[0]!.id)!.attempts)).toBe(2); // the abandoned claim, then the send
    await db.h.db.updateTable('loans').set({ open_item_id: null, returned_at: NOW, returned_on: TODAY }).where('member_id', 'in', ids).execute();
    await clearQueue();
  });

  it('without SMTP the notices are skipped and the staff told once; a failed send is tried again by the next sender, five attempts at most', async () => {
    const m = await member();
    await loanFor(m, 5);
    const loans = await db.h.db.selectFrom('loans').select('id').where('member_id', '=', m).execute();
    await withTx(db.h, (trx) => queueNotice(trx, { memberId: m, kind: 'due_soon', refKey: `due_soon:${m}:${addDays(TODAY, 2)}`, loanIds: loans.map((l) => l.id) }, NOW));
    const noSmtp: Mailer = { send: () => Promise.reject(new DomainError('SMTP_NOT_CONFIGURED')) };
    const r = await runNoticesSend(deps(noSmtp), sender('01JOBSENDER00000000000005A'), {});
    expect(r.counts).toEqual({ sent: 0, failed: 0, skipped: 1, noSmtp: 1 });
    expect((await notices(m)).map((n) => [n.status, n.reason])).toEqual([['skipped', 'smtp_not_configured']]);

    // A failing server: failed with its stage, queued again only by the next sender.
    const m2 = await member();
    await withTx(db.h, (trx) => queueNotice(trx, { memberId: m2, kind: 'due_soon', refKey: `due_soon:${m2}:${addDays(TODAY, 2)}`, loanIds: loans.map((l) => l.id) }, NOW));
    await db.h.db.updateTable('loans').set({ member_id: m2 }).where('member_id', '=', m).execute();
    let tries = 0;
    const failing: Mailer = {
      send: () => {
        tries += 1;
        return Promise.reject(new DomainError('SMTP_FAILED', { meta: { reason: 'auth' } }));
      },
    };
    for (let run = 0; run < 7; run++) await runNoticesSend(deps(failing), sender(`01JOBSENDER0000000000001${run}A`), {});
    expect(tries).toBe(5);
    expect((await notices(m2)).map((n) => [n.status, n.reason, Number(n.attempts)])).toEqual([['failed', 'smtp_auth', 5]]);
    // One notification for the staff, however many runs failed.
    const told = await db.h.db.selectFrom('notifications').select(['type', 'audience_permission']).where('type', '=', 'circulation.notices_failed').execute();
    expect(told).toEqual([{ type: 'circulation.notices_failed', audience_permission: 'system.settings.manage' }]);
    await db.h.db.updateTable('loans').set({ open_item_id: null, returned_at: NOW, returned_on: TODAY }).where('member_id', '=', m2).execute();
    await clearQueue();
  });

  it('a hold that becomes ready queues its mail and the sender in the same transaction; switched off it is logged as skipped', async () => {
    const holder = await member();
    const other = await member();
    const book = await item();
    await db.run((tx) => lendItem(tx, { branchId: db.branchId, memberId: other, barcode: book.barcode }));
    const hold = await db.run((tx) => placeHold(tx, { memberId: holder, recordId: book.recordId, pickupBranchId: db.branchId, source: 'desk' }));
    await db.run((tx) => returnItem(tx, { branchId: db.branchId, barcode: book.barcode }), NOW + 60_000);
    const rows = await notices(holder);
    expect(rows.map((n) => [n.kind, n.status, n.hold_id, n.ref_key])).toEqual([['hold_ready', 'queued', hold.id, `hold_ready:${hold.id}:${NOW + 60_000}`]]);
    const job = await db.h.db.selectFrom('jobs').select(['type', 'status', 'unique_key']).where('type', '=', 'circulation.notices_send').where('status', '=', 'queued').executeTakeFirst();
    expect(job?.unique_key).toBe('circulation.notices_send');

    const mailer = recordingMailer();
    await runNoticesSend(deps(mailer), sender('01JOBSENDER00000000000006A'), {});
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]!.subject).toContain('siap diambil');
    expect(mailer.sent[0]!.text).toContain('Buku');
    await clearQueue();
  });

  it('a manual send: one per member, kind and day; nothing to remind and unknown members are counted apart; audited once', async () => {
    const late = await member();
    await loanFor(late, 9);
    const none = await member();
    const unknown = '01JUNKNOWNMEMBER0000000000';
    const send = () => db.run((tx) => sendManualNotices(tx, { branchId: db.branchId, memberIds: [late, none, unknown], kind: 'overdue' }));
    expect(await send()).toEqual({ kind: 'overdue', queued: 1, existing: 0, nothing: 1, refused: [{ memberId: unknown, reason: 'not_found' }] });
    expect(await send()).toEqual({ kind: 'overdue', queued: 0, existing: 1, nothing: 1, refused: [{ memberId: unknown, reason: 'not_found' }] });
    const rows = await notices(late);
    expect(rows.map((n) => [n.kind, n.ref_key])).toEqual([['overdue', `manual:overdue:${late}:${TODAY}`]]);
    const log = await listNotices(db.h.db, { memberId: late, limit: 10 } as never);
    expect(log.items.map((i) => [i.kind, i.manual, i.loanCount, i.member?.id])).toEqual([['overdue', true, 1, late]]);
    const audits = await db.h.db.selectFrom('audit_log').select(['action', 'meta']).where('action', '=', 'circulation.notice.send').execute();
    expect(audits).toHaveLength(2);
    await clearQueue();
  });

  it('the reminder days, and the library’s own template in the member’s language (the built-in text for a part left empty)', async () => {
    expect(overdueReminderDays(7, 3)).toEqual([1, 8, 15]);
    expect(overdueReminderDays(1, 2)).toEqual([1, 2]);
    expect(overdueReminderDays(7, 0)).toEqual([]);
    await settings({ 'email.template.circulation_due_soon.id.subject': 'Ingat {count} buku, {name}', 'email.template.circulation_due_soon.id.body': '' });
    const library = { name: 'Perpus SMA 1', link: 'https://perpus.example.test/akun', currency: 'IDR' };
    const mail = await renderNotice(db.h.db, { id: '', name: 'Siti\r\nBcc: x', memberNo: 'A1', locale: 'id' }, library, sampleNoticeContent('due_soon', TODAY));
    expect(mail.subject).toBe('Ingat 2 buku, Siti Bcc: x');
    expect(mail.text).toContain('Pinjaman berikut akan segera jatuh tempo');
    expect(mail.text).toContain('- Laskar Pelangi (barkod B00012), jatuh tempo 4 September 2026');
    const overdue = await renderNotice(db.h.db, { id: '', name: 'Siti', memberNo: 'A1', locale: 'id' }, library, sampleNoticeContent('overdue', TODAY));
    expect(overdue.text).toContain('terlambat 8 hari');
    expect(overdue.text).toContain('Denda sementara: Rp');
    expect(overdue.text).toContain('Tanggungan biaya Anda saat ini: Rp');
    await settings({ 'email.template.circulation_due_soon.id.subject': null, 'email.template.circulation_due_soon.id.body': null });
  });

  it('a notice is kept 400 days after it was queued, then the reports housekeeping deletes it', async () => {
    const m = await member();
    await withTx(db.h, async (trx) => {
      await queueNotice(trx, { memberId: m, kind: 'overdue', refKey: `overdue:${m}:old`, loanIds: [] }, NOW - 401 * DAY);
      await queueNotice(trx, { memberId: m, kind: 'overdue', refKey: `overdue:${m}:kept`, loanIds: [] }, NOW - 399 * DAY);
    });
    const r = await noticesRetentionStep.run({ h: db.h, now: NOW, deps: {} as never, cursor: null, budgetLeftMs: () => 1_000_000, enqueue: async () => {} });
    expect(r).toEqual({ done: true, cursor: null });
    expect((await notices(m)).map((n) => n.ref_key)).toEqual([`overdue:${m}:kept`]);
    await clearQueue();
  });

  it('releaseStaleNotices leaves fresh claims alone', async () => {
    const m = await member();
    await withTx(db.h, (trx) => queueNotice(trx, { memberId: m, kind: 'overdue', refKey: `overdue:${m}:x`, loanIds: [] }, NOW));
    await claimNotices(db.h, '01JOBFRESH00000000000000AA', NOW - 1000);
    await releaseStaleNotices(db.h, NOW, { retryFailed: true });
    expect((await notices(m)).map((n) => n.status)).toEqual(['sending']);
    await clearQueue();
  });
});
