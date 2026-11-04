import { DomainError, isDomainError, normalizeKey, type IpTrust } from '@altis/shared';
import type { SessionStage } from '@altis/shared/api/auth';
import { errorFields, type Actor, type CoreLogger, type TxRunner } from '../context.js';
import type { PasswordHasher } from '../crypto/password.js';
import { loadGrants } from '../authz/grants.js';
import { deviceCookieAfterLogin, deviceKnows, parseDeviceCookie } from './device.js';
import { clearBucket, hit, refund, type BucketName, type Hit } from './rate-limit.js';
import { issueRememberToken } from './remember.js';
import { createSession, findSession, revokeSession, type SessionToken } from './sessions.js';
import { loadStaffAuthView, mfaNeeded, stageOf } from './staff.js';

// The staff login (spec §7.1, Global Constraints "Login limits"):
//
//   usernameKey = normalizeKey(username)          (audits keep its first 64 code points)
//   known  = a valid `altis_dev` MAC for usernameKey (a login completed on this device before)
//   perIp  = ipTrust === 'ok' && ip !== null
//   buckets = known ? [login:dev(deviceId)]
//                   : [login:user(usernameKey), ...(perIp ? [login:user-ip(usernameKey:ip), login:ip(ip)] : [])]
//   A  a hit on every bucket, each in a transaction of its own, committed before any verification, so a refused or
//      failed attempt keeps its count (atomic counters: parallel attempts never all pass)
//   a refused hit → AUTH_TOO_MANY_ATTEMPTS (the longest wait), with no verification and no audit (D9)
//   the user's id and password hash looked up by username_key: one query, the same for an unknown username, so that
//      the time to the hash does not tell which usernames exist
//   the password verified outside any transaction (S18): the user's hash, or the dummy hash for an unknown username;
//      a full hash queue (AUTH_BUSY, 429) gives the hits back first: nothing was verified, so nothing failed
//   wrong → auth.login.failed {reason: invalid_credentials} in a transaction of its own → AUTH_INVALID_CREDENTIALS
//   a stored hash with old parameters is rehashed, still outside any transaction (skipped while the queue is full)
//   B  one transaction, the session's. Its first statement locks the user's row (a write that changes nothing, as
//      D14's guard), and the account is read again under that lock: a password reset, a 2FA activation or a
//      disable that committed while the password was being verified writes that same row, so it is either seen here
//      or waits for B and then revokes the session B created. A password hash other than the verified one →
//      AUTH_INVALID_CREDENTIALS, not active → AUTH_ACCOUNT_DISABLED (D23); either rolls B back (the hits stay
//      counted) and is audited as auth.login.failed {reason: invalid_credentials | disabled | locked} in a
//      transaction of its own. Then, from that fresh read: login:user-ip cleared (when counted), every other hit
//      given back; the previous session of the browser revoked; with `remember` and no second factor owed, a
//      remember-me token issued first so the session records it (B9); the session (2FA passed unless a second factor
//      is owed, at the account's authz_version); the rehash written; and, for a completed login, last_login_at and
//      auth.login.success
//   the device cookie only for a completed login: only that proves the device (D21)
//
// A username no account can have (blank once normalized, a control character, a key longer than username_key's 191
// characters) is refused as AUTH_INVALID_CREDENTIALS before anything is counted: its buckets could not be stored, and
// nothing is learned from it (no such account can exist, so no hash runs to hide it).
//
// The responses of an unknown username and a wrong password are the same, and both run one hash ("Username tak dikenal
// tetap menjalankan dummy hash"). Every transaction goes through `run` (M38): the route hands it `rc.withTx`, whose
// audits count for the route's audit-once check.

/** What {@link login} takes besides the credentials. */
export interface LoginCtx {
  /** One transaction per call (the route's `rc.withTx`; `runnerFor` in the CLI and tests). */
  run: TxRunner;
  now: number;
  ip: string | null;
  ipTrust: IpTrust;
  userAgent: string | null;
  /** The install's decoded 32-byte sessionKey (D45): the device cookie's HMAC key. */
  sessionKey: Uint8Array;
  /** The request's `altis_dev` cookie. */
  deviceCookie?: string;
  hasher: PasswordHasher;
  /** The idle limit of a full session (`security.session_idle_minutes`), in ms. */
  idleMs: number;
  /** The session the browser holds now (a login replaces it). */
  previousSessionId?: string;
  /** For a failure no response reports (never with the username). */
  log: CoreLogger;
}

/** What a login that passed the password comes to. */
export interface LoginOutcome {
  userId: string;
  /** The new session: its token is the `altis_sid` cookie. */
  session: SessionToken;
  stage: SessionStage;
  mustChangePassword: boolean;
  /** The new `altis_dev` value; null unless the login completed (stage `full`). */
  deviceCookie: string | null;
  /** The `altis_rm` value; null unless `remember` was asked for and the login completed. */
  rememberCookie: string | null;
}

/** The longest username key: the width of `staff_users.username_key`, in code points. */
const USERNAME_KEY_MAX = 191;
/** Failed-login usernames are audited normalized, at most this many code points (Global Constraints, CSV export). */
const AUDIT_USERNAME_MAX = 64;
/** A control character: no username can hold one (usernameField), and a rate-limit subject cannot hold NUL. */
const CONTROL = /\p{Cc}/u;

const invalidCredentials = (): DomainError =>
  new DomainError('AUTH_INVALID_CREDENTIALS', {
    detail: 'Nama pengguna atau kata sandi salah / Wrong username or password',
  });

const accountDisabled = (): DomainError =>
  new DomainError('AUTH_ACCOUNT_DISABLED', {
    detail: 'Akun ini dinonaktifkan; hubungi admin perpustakaan / This account is disabled; ask the library admin',
  });

/** The account changed under transaction B: thrown to roll B back, then audited with `reason` and `error` thrown. */
class Refused extends Error {
  constructor(
    readonly reason: 'invalid_credentials' | 'disabled' | 'locked',
    readonly error: DomainError,
  ) {
    super(reason);
    this.name = 'Refused';
  }
}

/** Whether some account could have `key` as its username_key. */
function possibleKey(key: string): boolean {
  if (key === '' || CONTROL.test(key)) return false;
  return key.length <= USERNAME_KEY_MAX || Array.from(key).length <= USERNAME_KEY_MAX;
}

/** The first {@link AUDIT_USERNAME_MAX} code points of `key` (never a split surrogate pair). */
function auditedKey(key: string): string {
  return Array.from(key).slice(0, AUDIT_USERNAME_MAX).join('');
}

/** The account a username names, as looked up before the verification: its id and password hash only. */
interface Found {
  id: string;
  passwordHash: string;
}

/** A stored hash with old parameters, hashed again; null when it is current, or when the hasher is busy right now. */
async function rehash(hasher: PasswordHasher, phc: string, password: string): Promise<string | null> {
  if (!hasher.needsRehash(phc)) return null;
  try {
    return await hasher.hash(password);
  } catch (error) {
    // The password was right: a full queue must not turn the login into a 429. The next login rehashes.
    if (isDomainError(error) && error.code === 'AUTH_BUSY') return null;
    throw error;
  }
}

/**
 * Gives back the hits of an attempt the busy hasher never verified. A failure here is logged, not thrown: the client
 * still gets the AUTH_BUSY it can retry (429, Retry-After), and the hits simply stay counted.
 */
async function giveBack(ctx: LoginCtx, hits: readonly Hit[]): Promise<void> {
  try {
    await ctx.run(async (tx) => {
      for (const h of hits) await refund(tx.trx, h);
    });
  } catch (failure) {
    ctx.log.error('login: the rate-limit hits of an attempt the busy hasher never verified were not given back', {
      error: errorFields(failure),
    });
  }
}

/**
 * Signs a staff user in with a username and a password (see the top of this file).
 *
 * @throws DomainError `AUTH_TOO_MANY_ATTEMPTS` (`meta.retryAfterS`), `AUTH_INVALID_CREDENTIALS`,
 *   `AUTH_ACCOUNT_DISABLED`; `AUTH_BUSY` (`meta.retryAfterS`) when this process's password-hash queue is full
 */
export async function login(
  input: { username: string; password: string; remember: boolean },
  ctx: LoginCtx,
): Promise<LoginOutcome> {
  const { now, ip } = ctx;
  const usernameKey = normalizeKey(input.username);
  if (!possibleKey(usernameKey)) throw invalidCredentials();

  const device = parseDeviceCookie(ctx.deviceCookie);
  const known = device !== null && deviceKnows(ctx.sessionKey, device, usernameKey);
  /** The client IP when the per-IP buckets apply (a trusted address, D13), else null. */
  const perIp = ctx.ipTrust === 'ok' ? ip : null;
  const buckets: [BucketName, string][] = [];
  if (known) {
    buckets.push(['login:dev', device.deviceId]);
  } else {
    buckets.push(['login:user', usernameKey]);
    if (perIp !== null) buckets.push(['login:user-ip', `${usernameKey}:${perIp}`], ['login:ip', perIp]);
  }
  const anonymous: Actor = { type: 'anonymous', id: null, ip };

  // A: counted, and committed, before anything is verified. One transaction per bucket (as the IP limits of step 6):
  // each holds one counter row's lock for as short as it can, so parallel attempts queue on it instead of deadlocking
  // over several.
  const hits: Hit[] = [];
  for (const [name, subject] of buckets) {
    hits.push(await ctx.run((tx) => hit(tx.trx, name, subject, now), { actor: anonymous }));
  }
  const refused = hits.filter((h) => !h.allowed);
  if (refused.length > 0) {
    throw new DomainError('AUTH_TOO_MANY_ATTEMPTS', {
      detail: 'Terlalu banyak percobaan masuk; coba lagi nanti / Too many sign-in attempts; try again later',
      meta: { retryAfterS: Math.max(...refused.map((h) => h.retryAfterS)) },
    });
  }
  const found = await ctx.run(
    async (tx): Promise<Found | null> => {
      const row = await tx.trx
        .selectFrom('staff_users')
        .select(['id', 'password_hash'])
        .where('username_key', '=', usernameKey)
        .executeTakeFirst();
      return row === undefined ? null : { id: row.id, passwordHash: row.password_hash };
    },
    { actor: anonymous },
  );

  // Outside any transaction (S18).
  let ok: boolean;
  try {
    ok =
      found === null
        ? await ctx.hasher.verifyDummy(input.password)
        : await ctx.hasher.verify(input.password, found.passwordHash);
  } catch (error) {
    // A full hash queue verified nothing: the attempt is not a failure, so its hits are given back (a busy morning must
    // not lock anyone out). Every verified attempt still holds a hit, so the limits on guesses stand.
    if (isDomainError(error) && error.code === 'AUTH_BUSY') await giveBack(ctx, hits);
    throw error;
  }
  const failed = (reason: Refused['reason']) =>
    ctx.run(
      (tx) =>
        tx.audit({
          action: 'auth.login.failed',
          entity: 'staff_users',
          entityId: found?.id ?? null,
          meta: { usernameKey: auditedKey(usernameKey), reason, stage: 'password' },
        }),
      { actor: anonymous },
    );
  if (!ok || found === null) {
    await failed('invalid_credentials');
    throw invalidCredentials();
  }
  const userId = found.id;
  const newHash = await rehash(ctx.hasher, found.passwordHash, input.password);

  // B: the session's transaction.
  const staff: Actor = { type: 'staff', id: userId, ip };
  const done = await ctx
    .run(
      async (tx) => {
        const { trx } = tx;
        // First, before any read: the lock on the user's row (see the top of this file).
        await trx
          .updateTable('staff_users')
          .set((eb) => ({ last_login_at: eb.ref('last_login_at') }))
          .where('id', '=', userId)
          .execute();
        const current = await trx.selectFrom('staff_users').select('password_hash').where('id', '=', userId).executeTakeFirst();
        if (current === undefined || current.password_hash !== found.passwordHash) {
          throw new Refused('invalid_credentials', invalidCredentials());
        }
        const user = await loadStaffAuthView(trx, userId);
        if (user === null) throw new Refused('invalid_credentials', invalidCredentials());
        if (user.status !== 'active') {
          throw new Refused(user.status === 'locked' ? 'locked' : 'disabled', accountDisabled());
        }

        for (const h of hits) {
          if (h.name === 'login:user-ip') await clearBucket(trx, h.name, h.subject);
          else await refund(trx, h);
        }
        if (ctx.previousSessionId !== undefined) await revokeSession(trx, ctx.previousSessionId);
        const grants = await loadGrants(trx, userId);
        const needsMfa = mfaNeeded(user, grants);
        const remember =
          input.remember && !needsMfa ? await issueRememberToken(trx, { subjectId: userId, mfaBound: false, now }) : null;
        const session = await createSession(trx, {
          subjectId: userId,
          mfaPassed: !needsMfa,
          authzVersion: user.authzVersion,
          ip,
          userAgent: ctx.userAgent,
          now,
          idleMs: ctx.idleMs,
          rememberSelector: remember?.selector ?? null,
        });
        if (newHash !== null) {
          // Over the hash that was verified, which the row still holds (checked above, under the lock).
          await trx
            .updateTable('staff_users')
            .set({ password_hash: newHash })
            .where('id', '=', userId)
            .where('password_hash', '=', found.passwordHash)
            .execute();
        }
        if (!needsMfa) {
          await trx.updateTable('staff_users').set({ last_login_at: now }).where('id', '=', userId).execute();
          await tx.audit({
            action: 'auth.login.success',
            entity: 'staff_users',
            entityId: userId,
            meta: { stage: 'password' },
          });
        }
        const view = await findSession(trx, session.token, now);
        if (view === null) throw new TypeError('login: the session just created is not readable');
        return { session, needsMfa, stage: stageOf(user, grants, view), remember, mustChangePassword: user.mustChangePassword };
      },
      { actor: staff },
    )
    .catch(async (error: unknown) => {
      if (!(error instanceof Refused)) throw error;
      await failed(error.reason);
      throw error.error;
    });

  return {
    userId,
    session: done.session,
    stage: done.stage,
    mustChangePassword: done.mustChangePassword,
    deviceCookie: done.needsMfa ? null : deviceCookieAfterLogin(ctx.sessionKey, ctx.deviceCookie, usernameKey),
    rememberCookie: done.remember?.cookie ?? null,
  };
}
