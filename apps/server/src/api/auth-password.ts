import {
  MAIL_PASSWORD_RESET,
  changePassword,
  checkPasswordPolicy,
  completePasswordReset,
  createJobRegistry,
  enqueuePasswordResetMail,
  hit,
  inRotationGrace,
  listSessions,
  loadStaffAuthView,
  mailJobs,
  passwordResetSubject,
  revokeOwnSession,
  startPasswordReset,
  updateOwnProfile,
  type JobRegistry,
} from '@altis/core';
import { DomainError, isDomainError, normalizeKey } from '@altis/shared';
import {
  PasswordChangeBody,
  PasswordForgotBody,
  PasswordResetBody,
  ProfilePatchBody,
  type MeUser,
  type PasswordForgotResponse,
  type SessionItem,
} from '@altis/shared/api/auth';
import { z } from 'zod';
import { clearAuthCookie } from '../http/cookies.js';
import { route, type RouteContext, type RouteDecl } from '../http/route.js';

// The self-service account routes of Task 18 (spec §7.1 "Reset sandi", "Pencabutan"; §13.5 "Profil saya"; route
// catalog); the work is core's (auth/password.ts).
//
// - `auth.me.update` (PATCH auth/me) sets the user's own name and language (`auth.profile.update`) and answers the
//   updated user as `auth/me` shows it.
// - `auth.password.change` (tx: 'self': its `reauth:session` hit and failure audit commit on their own, D3) keeps the
//   requesting session and ends every other one; every remember-me token goes too, so the answer clears `altis_rm`.
//   It is the one route a pending password change lets through (step 9).
// - `auth.password.forgot` (tx: 'self'; `forgot:ip` at step 6) counts `forgot:email:5m` and `forgot:email:1d` for the
//   normalized address in a transaction of its own and always answers 202 `{accepted: true}`: 429 only from its
//   buckets, never anything that tells whether the account exists. Everything that depends on the address happens
//   after the response (`afterResponse`, D18), so that an existing and an unknown address do the same work before the
//   answer, and a slow or silent SMTP server neither delays it nor shows in its timing (Review Focus 4): starting the
//   reset for an active account with that address and enqueuing its mail job `mail.password_reset` (core's
//   mail/jobs.ts: the token in the job's secret, never in its payload) in one transaction, then waking this process's
//   worker loop, or, in external mode (passenger/litespeed, ALTIS_RUNNER=off), running one drive slice of at most
//   10 s here, so the mail does not wait for the next cron call (1c Task 18, decision C28). The job renders the mail
//   with the link `<baseUrl>/admin/reset-password#token=<token>`, in the user's language (else the library's), with the
//   library's `email.template.password_reset.<locale>.*` override; an SMTP failure retries it (3 attempts). A failure
//   is logged as `mail failed {stage, code}` (`stage: 'start'` for the reset) and nothing else: never the address, the
//   token or anything of the SMTP configuration.
// - `auth.password.reset` (`reset:ip` at step 6) reads the token's user and checks the policy, then hashes the new
//   password in `prepare`, outside any transaction (S18); the handler transaction completes the reset as that user
//   (the audit's actor). No session is created and no cookie set.
// - `auth.sessions.list` answers the user's live sessions, one entry per sign-in (a row rotated away, in its 30 s
//   grace, is left out unless it is the requesting one); `auth.sessions.revoke` revokes one of them with the rest of
//   its sign-in (B9: with its remember-me token); another user's session is 404. Revoking the requesting session
//   clears this browser's `altis_sid` and `altis_rm`.

const AUTH = '/api/v1/auth';

/** A session id: the SHA-256 hex of its token. */
const SessionParams = z.strictObject({ id: z.string().regex(/^[0-9a-f]{64}$/) });

/** `security.password_min_length`. */
function minPasswordLength(rc: RouteContext<unknown, unknown, unknown>): Promise<number> {
  return rc.services.settings.get<number>(rc.db.db, 'security.password_min_length');
}

/** PATCH auth/me. */
const meUpdate = route({
  id: 'auth.me.update',
  method: 'PATCH',
  path: `${AUTH}/me`,
  public: true,
  session: 'required',
  mode: 'system',
  idempotency: 'none',
  audit: 'auth.profile.update',
  body: ProfilePatchBody,
  handler: async (rc) => {
    const auth = rc.auth!; // session: 'required' (step 9)
    const tx = rc.tx();
    await updateOwnProfile(tx, auth.subjectId, rc.body);
    const user = await loadStaffAuthView(tx.trx, auth.subjectId);
    // Unreachable: updateOwnProfile found the account active in this transaction.
    if (user === null) throw new DomainError('AUTH_REQUIRED');
    const body: MeUser = {
      id: user.id,
      username: user.username,
      name: user.name,
      email: user.email,
      locale: user.locale,
      totpEnabled: user.totpEnabled,
      mfaRequired: user.mfaRequired || auth.grants.roleMfaRequired,
    };
    return { body };
  },
});

/** POST auth/password/change. */
const passwordChange = route({
  id: 'auth.password.change',
  method: 'POST',
  path: `${AUTH}/password/change`,
  public: true,
  session: 'required',
  mode: 'system',
  idempotency: 'none',
  audit: 'auth.password.change',
  tx: 'self',
  body: PasswordChangeBody,
  handler: async (rc) => {
    const auth = rc.auth!;
    await changePassword(rc.withTx, {
      userId: auth.subjectId,
      sessionId: auth.session.id,
      current: rc.body.current,
      next: rc.body.next,
      now: rc.now,
      hasher: rc.services.hasher,
      minLength: await minPasswordLength(rc),
      log: rc.log,
    });
    // Every remember-me token of the user went, this session's included: the browser's cookie names none any more.
    clearAuthCookie(rc.c, 'altis_rm');
    return { body: {} };
  },
});

/** A failure's code or name, never its message (it may quote what the server said, or the address). */
function failureCode(error: unknown): string {
  if (isDomainError(error)) return error.code;
  return error instanceof Error ? error.name : typeof error;
}

/** The longest drive slice the forgot route runs after its response in external mode (decision C28). */
export const RESET_MAIL_DRIVE_MS = 10_000;

/**
 * The registry the reset mail is enqueued with: the job runtime's when it knows `mail.password_reset`, else one of the
 * mail handlers alone (an app whose runtime is not there yet: the job waits for the next runner).
 */
function mailRegistry(rc: RouteContext<unknown, unknown, unknown>): JobRegistry {
  const reg = rc.services.jobs?.registry;
  if (reg?.get(MAIL_PASSWORD_RESET) !== undefined) return reg;
  return createJobRegistry(mailJobs({ mailer: rc.services.mailer, baseUrl: () => rc.config.baseUrl, settings: rc.services.settings }));
}

/**
 * Starts the reset for `email` and enqueues its mail in one transaction (after the response, both): nothing for an
 * address no active account holds. Then the mail is sent as soon as this process can (C28): a worker loop is woken
 * (`kick()`); in external mode one drive slice of at most 10 s runs here, so the mail does not wait for the next cron
 * call. Never throws: a failure is logged (see the top of this file).
 */
async function startResetAndMail(rc: RouteContext<unknown, unknown, unknown>, email: string): Promise<void> {
  let job: { id: string } | null;
  try {
    const reg = mailRegistry(rc);
    job = await rc.withTx(async (tx) => {
      const started = await startPasswordReset(tx.trx, { email, now: rc.now });
      if (started === null) return null;
      return enqueuePasswordResetMail(tx.trx, reg, started, { now: rc.now, keyring: rc.config.keyring });
    });
  } catch (error) {
    rc.log.error('mail failed', { stage: 'start', code: failureCode(error) });
    return;
  }
  const jobs = rc.services.jobs;
  if (job === null || jobs === null) return;
  if (jobs.mode === 'worker') {
    jobs.kick();
    return;
  }
  try {
    // The slice logs a mail failure itself (`mail failed {stage, code}`) and the job retries it.
    await jobs.drive(job.id, { budgetMs: RESET_MAIL_DRIVE_MS });
  } catch (error) {
    rc.log.warn('jobs: driving the reset mail failed', { code: failureCode(error) });
  }
}

/** POST auth/password/forgot. */
const passwordForgot = route({
  id: 'auth.password.forgot',
  method: 'POST',
  path: `${AUTH}/password/forgot`,
  public: true,
  mode: 'system',
  idempotency: 'none',
  audit: null,
  tx: 'self',
  ipLimits: ['forgot:ip'],
  body: PasswordForgotBody,
  handler: async (rc) => {
    const subject = normalizeKey(rc.body.email);
    // Counted first, in a transaction of their own, whether or not the address belongs to anyone.
    const hits = await rc.withTx(async (tx) => [
      await hit(tx.trx, 'forgot:email:5m', subject, rc.now),
      await hit(tx.trx, 'forgot:email:1d', subject, rc.now),
    ]);
    const refused = hits.filter((h) => !h.allowed);
    if (refused.length > 0) {
      throw new DomainError('AUTH_TOO_MANY_ATTEMPTS', {
        detail: 'Terlalu banyak permintaan; coba lagi nanti / Too many requests; try again later',
        meta: { retryAfterS: Math.max(...refused.map((h) => h.retryAfterS)) },
      });
    }
    // The same work before the answer for every address: whether it belongs to anyone shows only after it.
    const email = rc.body.email;
    rc.afterResponse(() => startResetAndMail(rc, email));
    const body: PasswordForgotResponse = { accepted: true };
    return { status: 202, body };
  },
});

/** What the reset route's `prepare` hands its handler. */
interface PreparedReset {
  userId: string;
  passwordHash: string;
}

/** POST auth/password/reset. */
const passwordReset = route({
  id: 'auth.password.reset',
  method: 'POST',
  path: `${AUTH}/password/reset`,
  public: true,
  mode: 'system',
  idempotency: 'none',
  audit: 'auth.password.reset',
  ipLimits: ['reset:ip'],
  body: PasswordResetBody,
  prepare: async (rc): Promise<PreparedReset> => {
    // A dead link first (it needs a new mail whatever the password), then the policy, then scrypt (S18).
    const userId = await passwordResetSubject(rc.db.db, rc.body.token, rc.now);
    checkPasswordPolicy(rc.body.password, { minLength: await minPasswordLength(rc) });
    return { userId, passwordHash: await rc.services.hasher.hash(rc.body.password) };
  },
  handler: async (rc) => {
    const { userId, passwordHash } = rc.prepared as PreparedReset;
    // §7.1: the reset is the user's own action, whoever's browser sent it.
    const tx = rc.tx({ actor: { type: 'staff', id: userId, ip: rc.ip } });
    await completePasswordReset(tx, { token: rc.body.token, passwordHash, now: rc.now });
    return { body: {} };
  },
});

/** GET auth/sessions. */
const sessionsList = route({
  id: 'auth.sessions.list',
  method: 'GET',
  path: `${AUTH}/sessions`,
  public: true,
  session: 'required',
  mode: 'system',
  idempotency: 'none',
  audit: null,
  handler: async (rc) => {
    const auth = rc.auth!;
    const current = auth.session.id;
    const sessions = await listSessions(rc.db.db, auth.subjectId, rc.now);
    const body: SessionItem[] = sessions
      .filter((s) => s.id === current || !inRotationGrace(s))
      .map((s) => ({
        id: s.id,
        current: s.id === current,
        createdAt: s.createdAt,
        lastSeenAt: s.lastSeenAt,
        ip: s.ip,
        userAgent: s.userAgent,
        remembered: s.rememberSelector !== null,
      }));
    return { body, headers: { 'Cache-Control': 'no-store' } };
  },
});

/** DELETE auth/sessions/:id. */
const sessionsRevoke = route({
  id: 'auth.sessions.revoke',
  method: 'DELETE',
  path: `${AUTH}/sessions/:id`,
  public: true,
  session: 'required',
  mode: 'system',
  idempotency: 'none',
  audit: 'auth.session.revoke',
  params: SessionParams,
  handler: async (rc) => {
    const auth = rc.auth!;
    const { currentEnded } = await revokeOwnSession(rc.tx(), {
      userId: auth.subjectId,
      sessionId: rc.params.id,
      currentSessionId: auth.session.id,
    });
    if (currentEnded) {
      rc.afterCommit(() => {
        clearAuthCookie(rc.c, 'altis_sid');
        clearAuthCookie(rc.c, 'altis_rm');
      });
    }
    return { body: {} };
  },
});

/** The routes of this file, in the order of the route catalog. */
export const AUTH_PASSWORD_ROUTES: RouteDecl[] = [
  meUpdate,
  passwordChange,
  passwordForgot,
  passwordReset,
  sessionsList,
  sessionsRevoke,
];
