import { listNotices, noticeLibrary, noticeStatus, noticesToday, renderNotice, sampleNoticeContent, sendManualNotices } from '@altis/core';
import { isDomainError } from '@altis/shared';
import { ulidField } from '@altis/shared/api/common';
import {
  NoticeListQuery,
  NoticePreviewBody,
  NoticeSendBody,
  NoticeTestBody,
  type NoticeListResponse,
  type NoticePreviewResponse,
  type NoticeSendResponse,
  type NoticeStatusResponse,
  type NoticeTestResponse,
} from '@altis/shared/api/notices';
import { z } from 'zod';
import { route, type RouteContext, type RouteDecl } from '../../http/route.js';

// The member notices (e-mail reminders).
//
//   POST branches/:branchId/circulation/notices  NoticeSendBody → NoticeSendResponse   circulation.notice.send  (desk.use at the branch)
//   GET  circulation/notices                      NoticeListQuery → NoticeListResponse                          (circulation.records.read)
//   GET  circulation/notices/status               → NoticeStatusResponse                                         (circulation.records.read)
//   POST circulation/notices/preview              NoticePreviewBody → NoticePreviewResponse (a read)             (system.settings.read)
//   POST circulation/notices/test                 NoticeTestBody → NoticeTestResponse   circulation.notice.send  (system.settings.manage)
//
// A manual send queues one reminder per member about the member's open loans at the branch and wakes the sender after
// the commit. The preview renders the mail of a kind with sample values through the library's own template; the test
// send mails that preview to the address typed, through the saved SMTP settings, outside any transaction (the e-mail
// test's mailer: every phase and the whole session bounded inside the request), then audits it, failed or not.

const sendNotices = route({
  id: 'circulation.notices.send',
  method: 'POST',
  path: '/api/v1/branches/:branchId/circulation/notices',
  permission: 'circulation.desk.use',
  branchParam: 'branchId',
  idempotency: 'store',
  audit: 'circulation.notice.send',
  params: z.strictObject({ branchId: ulidField }),
  body: NoticeSendBody,
  handler: async (rc) => {
    const body: NoticeSendResponse = await sendManualNotices(rc.tx(), { branchId: rc.params.branchId, memberIds: rc.body.memberIds, kind: rc.body.kind });
    if (body.queued > 0) rc.afterCommit(() => rc.services.jobs?.kick());
    return { body };
  },
});

const noticesList = route({
  id: 'circulation.notices.list',
  method: 'GET',
  path: '/api/v1/circulation/notices',
  permission: 'circulation.records.read',
  idempotency: 'none',
  audit: null,
  query: NoticeListQuery,
  handler: async (rc) => {
    const body: NoticeListResponse = await listNotices(rc.db.db, rc.query);
    return { body };
  },
});

const noticesStatus = route({
  id: 'circulation.notices.status',
  method: 'GET',
  path: '/api/v1/circulation/notices/status',
  permission: 'circulation.records.read',
  idempotency: 'none',
  audit: null,
  handler: async (rc) => {
    const body: NoticeStatusResponse = await noticeStatus(rc.db.db, rc.now);
    return { body };
  },
});

/** The sample mail of `kind` in `locale`, as the library's template renders it. */
async function sampleMail(rc: RouteContext<unknown, unknown, unknown>, kind: NoticePreviewBody['kind'], locale: NoticePreviewBody['locale']): Promise<NoticePreviewResponse> {
  const db = rc.db.db;
  const library = await noticeLibrary(db, rc.config.baseUrl);
  const member = { id: '', name: 'Siti Rahma', memberNo: '2026001', locale };
  return renderNotice(db, member, library, sampleNoticeContent(kind, await noticesToday(db, rc.now)));
}

const noticesPreview = route({
  id: 'circulation.notices.preview',
  method: 'POST',
  path: '/api/v1/circulation/notices/preview',
  permission: 'system.settings.read',
  mode: 'read',
  idempotency: 'none',
  audit: null,
  tx: 'self',
  body: NoticePreviewBody,
  handler: async (rc) => {
    const body = await sampleMail(rc, rc.body.kind, rc.body.locale);
    return { body };
  },
});

/** The stage a failed test send reached (no address, no text of the server). */
function failureReason(error: unknown): string {
  if (isDomainError(error)) {
    if (error.code === 'SMTP_NOT_CONFIGURED') return 'not_configured';
    const reason = error.meta?.['reason'];
    if (error.code === 'SMTP_FAILED' && typeof reason === 'string') return reason;
  }
  return 'error';
}

const noticesTest = route({
  id: 'circulation.notices.test',
  method: 'POST',
  path: '/api/v1/circulation/notices/test',
  permission: 'system.settings.manage',
  idempotency: 'none',
  audit: 'circulation.notice.send',
  tx: 'self',
  body: NoticeTestBody,
  handler: async (rc) => {
    let failure: unknown;
    try {
      const mail = await sampleMail(rc, rc.body.kind, rc.body.locale);
      await rc.services.emailTestMailer.send({ to: rc.body.to, subject: mail.subject, text: mail.text });
    } catch (error) {
      failure = error;
    }
    const meta = failure === undefined ? { kind: rc.body.kind, test: true, ok: true } : { kind: rc.body.kind, test: true, ok: false, reason: failureReason(failure) };
    await rc.audit({ entity: null, entityId: null, meta });
    if (failure !== undefined) throw failure;
    const body: NoticeTestResponse = { sent: true };
    return { body };
  },
});

export const NOTICE_ROUTES: RouteDecl[] = [sendNotices, noticesStatus, noticesList, noticesPreview, noticesTest];
