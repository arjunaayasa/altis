import type { DB } from '@altis/db';
import { LOCALES, isDomainError, isUlid, type Locale } from '@altis/shared';
import type { Transaction } from 'kysely';
import { z } from 'zod';
import type { KeyringEntry } from '../../crypto/secret-box.js';
import { sha256hex } from '../../crypto/tokens.js';
import { enqueue } from '../../jobs/enqueue.js';
import type { JobContext, JobHandler, JobOutcome, JobRegistry } from '../../jobs/types.js';
import type { MailJobDeps } from '../../mail/jobs.js';
import { renderMail } from '../../mail/templates.js';
import { MEMBER_RESET_TTL_MS, type MemberResetStart } from './auth.js';
import { MEMBER_SUBJECT } from './sessions.js';

// `mail.member_password_reset`: the reset link of one startMemberReset, sent to the address the member's row holds.
// The route that starts the reset enqueues the job in the same transaction with `{memberId, locale}` as its payload and
// the token as its secret (sealed with the keyring, cleared when the job ends): the token is never in the payload, an
// error or the log. A slice sends nothing for a reset used or run out meanwhile, renders the mail in the member's
// language (else the library's) and sends it; an SMTP failure is logged by its code and thrown, so the job retries it
// (3 attempts). Only a new request starts another mail (`origin-only`).

/** The job type of a member's password-reset mail. */
export const MAIL_MEMBER_PASSWORD_RESET = 'mail.member_password_reset';

export const memberResetMailSchema = z.strictObject({
  memberId: z.string().refine(isUlid, 'not a ULID'),
  locale: z.enum(LOCALES).nullable(),
});
export type MemberResetMail = z.infer<typeof memberResetMailSchema>;

/** Enqueues the mail of the reset `started` in `trx` (the transaction that started it). */
export async function enqueueMemberResetMail(
  trx: Transaction<DB>,
  reg: JobRegistry,
  started: MemberResetStart,
  o: { now: number; keyring: readonly KeyringEntry[] },
): Promise<{ id: string }> {
  const payload: MemberResetMail = { memberId: started.memberId, locale: started.locale };
  const { id } = await enqueue(trx, reg, { type: MAIL_MEMBER_PASSWORD_RESET, payload, secret: new TextEncoder().encode(started.token) }, o);
  return { id };
}

function failureCode(error: unknown): string {
  if (isDomainError(error)) return error.code;
  return error instanceof Error ? error.name : typeof error;
}

async function sendMemberReset(deps: MailJobDeps, ctx: JobContext, p: MemberResetMail): Promise<JobOutcome<MemberResetMail>> {
  const secret = await ctx.secretParam();
  if (secret === null) return { done: true };
  const token = new TextDecoder().decode(secret);
  const reset = await ctx.db
    .selectFrom('password_resets')
    .select('subject_id')
    .where('token_hash', '=', sha256hex(token))
    .where('subject_type', '=', MEMBER_SUBJECT)
    .where('used_at', 'is', null)
    .where('expires_at', '>', ctx.now())
    .executeTakeFirst();
  if (reset === undefined || reset.subject_id !== p.memberId) return { done: true };
  const member = await ctx.db
    .selectFrom('members')
    .select(['name', 'member_no_display', 'email', 'archived_at', 'anonymized_at'])
    .where('id', '=', p.memberId)
    .executeTakeFirst();
  if (member === undefined || member.email === null || member.archived_at !== null || member.anonymized_at !== null) return { done: true };
  try {
    const locale: Locale = p.locale ?? (await deps.settings.get<Locale>(ctx.db, 'library.locale'));
    const library = await deps.settings.get<string>(ctx.db, 'library.name');
    const link = `${deps.baseUrl().replace(/\/+$/, '')}/akun/atur-sandi/${token}`;
    const mail = renderMail('member_password_reset', locale, {
      name: member.name,
      memberNo: member.member_no_display,
      library,
      link,
      minutes: String(MEMBER_RESET_TTL_MS / 60_000),
    });
    await deps.mailer.send({ to: member.email, subject: mail.subject, text: mail.text });
  } catch (error) {
    ctx.log.error('mail failed', { stage: 'member_reset', code: failureCode(error) });
    throw error;
  }
  return { done: true };
}

/** The handler of `mail.member_password_reset`, built with the mail deps of the job runtime. */
export function memberResetMailJob(deps: MailJobDeps): JobHandler<MemberResetMail> {
  return {
    type: MAIL_MEMBER_PASSWORD_RESET,
    permission: 'system.jobs.manage',
    retryable: 'origin-only',
    maxAttempts: 3,
    payload: memberResetMailSchema,
    run: (ctx, p) => sendMemberReset(deps, ctx, p),
  };
}
