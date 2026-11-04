import type { DB } from '@altis/db';
import { LOCALES, isDomainError, isUlid, type Locale } from '@altis/shared';
import type { Transaction } from 'kysely';
import { z } from 'zod';
import { PASSWORD_RESET_TTL_MS, type PasswordResetStart } from '../auth/password.js';
import type { KeyringEntry } from '../crypto/secret-box.js';
import { sha256hex } from '../crypto/tokens.js';
import { enqueue } from '../jobs/enqueue.js';
import type { JobContext, JobHandler, JobOutcome, JobRegistry } from '../jobs/types.js';
import type { SettingsCache } from '../settings/service.js';
import type { Mailer } from './smtp.js';
import { renderMail } from './templates.js';

// The mail jobs (1b decision D18 moved to the queue in 1c; decision C28, M22). Core holds no configuration, so the
// handlers are built from what the server gives them: the mailer (SMTP settings read at every send), the base URL of
// the links and the settings cache.
//
// `mail.password_reset` sends the reset link of one `startPasswordReset`. The route that starts the reset enqueues the
// job in the same transaction (`enqueuePasswordResetMail`), with `{userId, locale}` as its payload and the token as its
// secret (`secret_param`, sealed with the keyring, cleared once the job ends): the token is never in the payload, the
// job's `last_error` (a code and an authored detail) or the log. The slice reads the token back, sends nothing for a
// reset that was used or ran out meanwhile, renders the mail in the user's language (else the library's) with the
// library's `email.template.password_reset.<locale>.*` override, and sends it. An SMTP failure is logged as
// `mail failed {stage, code}` and rethrown: the job's error path queues it again (20 s, then 40 s) and it is dead after
// 3 attempts. `retryable: 'origin-only'`: only a new forgot request starts another mail (§10.5).

/** The job type of the password-reset mail. */
export const MAIL_PASSWORD_RESET = 'mail.password_reset';

/** What the mail jobs are built with (M22). */
export interface MailJobDeps {
  mailer: Mailer;
  /** The installation's base URL (config.json `baseUrl`) at the time of the send. */
  baseUrl(): string;
  settings: SettingsCache;
}

/** The payload of `mail.password_reset`: whose reset, in which language (null: the library's). */
export const passwordResetMailSchema = z.strictObject({
  userId: z.string().refine(isUlid, 'not a ULID'),
  locale: z.enum(LOCALES).nullable(),
});
export type PasswordResetMail = z.infer<typeof passwordResetMailSchema>;

type MailStage = 'render' | 'load';

/** Where a mail failed: the SMTP stage (`connect | tls | auth | send`), `not_configured`, or the step it was in. */
function mailStageOf(error: unknown, step: MailStage): string {
  if (isDomainError(error)) {
    if (error.code === 'SMTP_FAILED' && typeof error.meta?.['reason'] === 'string') return error.meta['reason'];
    if (error.code === 'SMTP_NOT_CONFIGURED') return 'not_configured';
  }
  return step;
}

/** A failure's code or name, never its message (it may quote what the server said, or the address). */
function failureCode(error: unknown): string {
  if (isDomainError(error)) return error.code;
  return error instanceof Error ? error.name : typeof error;
}

/**
 * Enqueues the mail of the reset `started` in `trx` (the transaction that started it), at `o.now`: payload
 * `{userId, locale}`, the token as the job's secret. Await it before the next statement on `trx`; re-runnable with
 * the transaction (R37).
 *
 * @throws TypeError when `reg` has no `mail.password_reset` handler; enqueue's errors
 */
export async function enqueuePasswordResetMail(
  trx: Transaction<DB>,
  reg: JobRegistry,
  started: PasswordResetStart,
  o: { now: number; keyring: readonly KeyringEntry[] },
): Promise<{ id: string }> {
  const payload: PasswordResetMail = { userId: started.userId, locale: started.locale };
  const { id } = await enqueue(trx, reg, { type: MAIL_PASSWORD_RESET, payload, secret: new TextEncoder().encode(started.token) }, o);
  return { id };
}

/** One slice of `mail.password_reset` (see the top of this file). */
async function sendPasswordReset(deps: MailJobDeps, ctx: JobContext, p: PasswordResetMail): Promise<JobOutcome<PasswordResetMail>> {
  const secret = await ctx.secretParam();
  if (secret === null) {
    ctx.log.warn('mail: the reset token of the job is gone', { jobId: ctx.jobId });
    return { done: true };
  }
  const token = new TextDecoder().decode(secret);
  const reset = await ctx.db
    .selectFrom('password_resets')
    .select('subject_id')
    .where('token_hash', '=', sha256hex(token))
    .where('subject_type', '=', 'staff')
    .where('used_at', 'is', null)
    .where('expires_at', '>', ctx.now())
    .executeTakeFirst();
  // Used, run out or replaced since it was started: the link would not work any more.
  if (reset === undefined || reset.subject_id !== p.userId) return { done: true };
  const user = await ctx.db
    .selectFrom('staff_users')
    .select(['name', 'username_display', 'email_display'])
    .where('id', '=', p.userId)
    .executeTakeFirst();
  if (user === undefined || user.email_display === null) return { done: true };

  let step: MailStage = 'render';
  try {
    const { settings } = deps;
    const db = ctx.db;
    const locale: Locale = p.locale ?? (await settings.get<Locale>(db, 'library.locale'));
    const library = await settings.get<string>(db, 'library.name');
    const subject = await settings.get<string | null>(db, `email.template.password_reset.${locale}.subject`);
    const body = await settings.get<string | null>(db, `email.template.password_reset.${locale}.body`);
    const link = `${deps.baseUrl().replace(/\/+$/, '')}/admin/reset-password#token=${token}`;
    const mail = renderMail(
      'password_reset',
      locale,
      { name: user.name, username: user.username_display, library, link, minutes: String(PASSWORD_RESET_TTL_MS / 60_000) },
      { subject, body },
    );
    step = 'load'; // from here on: the SMTP settings, then the server
    await deps.mailer.send({ to: user.email_display, subject: mail.subject, text: mail.text });
  } catch (error) {
    ctx.log.error('mail failed', { stage: mailStageOf(error, step), code: failureCode(error) });
    throw error;
  }
  return { done: true };
}

/** The mail job handlers, built with `deps` (M22): `mail.password_reset`. */
export function mailJobs(deps: MailJobDeps): JobHandler<PasswordResetMail>[] {
  return [
    {
      type: MAIL_PASSWORD_RESET,
      permission: 'system.users.manage',
      retryable: 'origin-only',
      maxAttempts: 3,
      payload: passwordResetMailSchema,
      run: (ctx, p) => sendPasswordReset(deps, ctx, p),
    },
  ];
}
