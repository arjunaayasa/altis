import { upsert, type DB, type SessionsTable } from '@altis/db';
import { DomainError } from '@altis/shared';
import type { Kysely, Selectable, Transaction } from 'kysely';
import { randomToken, sha256hex } from '../crypto/tokens.js';

// Staff sessions in the database (spec §7.1, P6: every process of a Passenger pool sees them).
//
// - The token is 256 bits (randomToken(32), or a remember-me session token, D12); the row's id is its SHA-256 hex,
//   so the database never holds a usable token.
// - A pre-2FA session (`mfa_passed` 0) lives PRE_MFA_MS and activity never extends it. A full session expires after
//   `idleMs` without activity and at the latest SESSION_ABSOLUTE_MS after its creation; activity is written at most
//   once per TOUCH_INTERVAL_MS, never for a background request.
// - Rotation (login completed, rights changed) inserts a new row and leaves the old token valid for
//   ROTATION_GRACE_MS, so parallel requests that still carry it are not logged out (Review Focus 3).
// - A remember-me token belongs to the session that issued it, `remember_selector` (B9): rotation moves it to the new
//   row, and revoking a session deletes its token. A logout revokes the whole sign-in (revokeSessionLineage): the
//   session with the ones it was rotated from and into.
//
// Every bound is `expires_at > now`: a session is gone at its `expires_at` (M4). Subjects are staff only here;
// members (Phase 3) get their own lookups.

/** The absolute lifetime of a staff session, from its creation. */
export const SESSION_ABSOLUTE_MS = 12 * 3600_000;
/** The lifetime of a session waiting for its second factor. */
export const PRE_MFA_MS = 10 * 60_000;
/** `last_seen_at` is written at most this often. */
export const TOUCH_INTERVAL_MS = 60_000;
/** How long a rotated-away token stays valid. */
export const ROTATION_GRACE_MS = 30_000;

const STAFF = 'staff';
/** A session token: 32 bytes as unpadded base64url. */
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
/** A remember-me selector: randomToken(18), exactly the width of `remember_selector` CHAR(24). */
const SELECTOR = /^[A-Za-z0-9_-]{24}$/;
/** The width of `sessions.user_agent`, in code points (MySQL and PostgreSQL count characters, M21). */
const USER_AGENT_MAX = 191;

/** A session as the HTTP layer sees it. */
export interface SessionView {
  /** SHA-256 hex of the token. */
  id: string;
  subjectId: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  mfaPassed: boolean;
  reauthAt: number | null;
  rememberSelector: string | null;
  authzVersion: number;
  ip: string | null;
  userAgent: string | null;
}

/** What {@link createSession} takes. */
export interface CreateSessionInput {
  subjectId: string;
  mfaPassed: boolean;
  authzVersion: number;
  ip: string | null;
  userAgent: string | null;
  now: number;
  /** The idle limit (setting `security.session_idle`), in ms. */
  idleMs: number;
  /** The remember-me token this session issued or was restored from (B9). */
  rememberSelector?: string | null;
  reauthAt?: number | null;
  /** A token derived by the caller (remember-me, D12); a new randomToken(32) when absent. */
  token?: string;
}

/** What {@link rotateSession} changes; anything left out is kept from the old row. */
export interface RotatePatch {
  now: number;
  idleMs: number;
  mfaPassed?: boolean;
  authzVersion?: number;
  rememberSelector?: string | null;
  reauthAt?: number | null;
}

/** A token and the id of its session row. */
export interface SessionToken {
  token: string;
  id: string;
}

type SessionRow = Selectable<SessionsTable>;

function view(r: SessionRow): SessionView {
  return {
    id: r.id,
    subjectId: r.subject_id,
    createdAt: Number(r.created_at),
    lastSeenAt: Number(r.last_seen_at),
    expiresAt: Number(r.expires_at),
    mfaPassed: Number(r.mfa_passed) === 1,
    reauthAt: r.reauth_at === null ? null : Number(r.reauth_at),
    rememberSelector: r.remember_selector,
    authzVersion: Number(r.authz_version),
    ip: r.ip,
    userAgent: r.user_agent,
  };
}

/** The first 191 code points of `ua`: a surrogate pair is never split. */
function clipUserAgent(ua: string | null): string | null {
  if (ua === null) return null;
  let units = 0;
  let points = 0;
  for (const ch of ua) {
    if (points === USER_AGENT_MAX) return ua.slice(0, units);
    units += ch.length;
    points += 1;
  }
  return ua;
}

function checkSelector(fn: string, selector: string | null | undefined): void {
  if (selector === undefined || selector === null) return;
  if (typeof selector !== 'string' || !SELECTOR.test(selector)) {
    throw new TypeError(
      `${fn}: rememberSelector must be a remember-me selector (24 characters, randomToken(18)) or null`,
    );
  }
}

/**
 * When a session expires: a pre-2FA one PRE_MFA_MS after `now`, a full one `idleMs` after `now`; never later than
 * SESSION_ABSOLUTE_MS after its creation.
 */
function expiry(createdAt: number, now: number, mfaPassed: boolean, idleMs: number): number {
  return Math.min(now + (mfaPassed ? idleMs : PRE_MFA_MS), createdAt + SESSION_ABSOLUTE_MS);
}

/**
 * Creates a staff session in `trx` and returns its token (to set as the cookie) and id (`sha256hex(token)`, the
 * only form stored). It expires PRE_MFA_MS after `now` when `mfaPassed` is false, otherwise after
 * `min(idleMs, SESSION_ABSOLUTE_MS)`. The user agent is clipped to 191 code points.
 *
 * With `token` given (a remember-me session token, D12) the row is upserted on its id: two requests that derive the
 * same token share one row, and the second leaves the row as the first wrote it.
 *
 * Remember-me binding (B9): issue the token first, in the same transaction, and pass its selector here.
 *
 * @throws TypeError for a given token that is not 43 base64url characters or a selector that is not 24
 */
export async function createSession(trx: Transaction<DB>, o: CreateSessionInput): Promise<SessionToken> {
  if (o.token !== undefined && (typeof o.token !== 'string' || !TOKEN.test(o.token))) {
    throw new TypeError('createSession: token must be 43 base64url characters (256 bits)');
  }
  checkSelector('createSession', o.rememberSelector);
  const token = o.token ?? randomToken(32);
  const id = sha256hex(token);
  const row = {
    id,
    subject_type: STAFF,
    subject_id: o.subjectId,
    created_at: o.now,
    last_seen_at: o.now,
    expires_at: expiry(o.now, o.now, o.mfaPassed, o.idleMs),
    ip: o.ip,
    user_agent: clipUserAgent(o.userAgent),
    mfa_passed: o.mfaPassed ? 1 : 0,
    reauth_at: o.reauthAt ?? null,
    remember_selector: o.rememberSelector ?? null,
    authz_version: o.authzVersion,
  };
  if (o.token === undefined) {
    await trx.insertInto('sessions').values(row).execute();
  } else {
    // The second writer finds the row and changes nothing (a no-op SET: upsert needs one column).
    await upsert(trx, 'sessions', { id }, row, { subject_type: STAFF });
  }
  return { token, id };
}

/** The live staff session of `token` (`expires_at > now`), or null; a malformed token is null. */
export async function findSession(db: Kysely<DB>, token: string, now: number): Promise<SessionView | null> {
  if (typeof token !== 'string' || !TOKEN.test(token)) return null;
  const r = await db
    .selectFrom('sessions')
    .selectAll()
    .where('id', '=', sha256hex(token))
    .where('subject_type', '=', STAFF)
    .where('expires_at', '>', now)
    .executeTakeFirst();
  return r === undefined ? null : view(r);
}

/**
 * Records activity on a full session: when the request is not a background one, at least TOUCH_INTERVAL_MS passed
 * since `lastSeenAt` and 2FA is passed, sets `last_seen_at = now` and `expires_at = min(now + idleMs, createdAt +
 * SESSION_ABSOLUTE_MS)`. The write is conditional on the row still having the `last_seen_at` of `s` and not having
 * expired, so of two requests with one view only one writes, and a rotated-away row (whose `last_seen_at` the
 * rotation set) is never extended past its grace. Returns whether a row was written.
 */
export async function touchSession(
  db: Kysely<DB>,
  s: SessionView,
  o: { now: number; idleMs: number; background: boolean },
): Promise<boolean> {
  if (o.background || !s.mfaPassed || o.now - s.lastSeenAt < TOUCH_INTERVAL_MS) return false;
  const result = await db
    .updateTable('sessions')
    .set({ last_seen_at: o.now, expires_at: expiry(s.createdAt, o.now, true, o.idleMs) })
    .where('id', '=', s.id)
    .where('last_seen_at', '=', s.lastSeenAt)
    .where('expires_at', '>', o.now)
    .executeTakeFirst();
  return Number(result.numUpdatedRows) > 0;
}

/**
 * Replaces the session `s` with a new token (login completed, rights changed): a new row that keeps `created_at`
 * (so the absolute limit still counts from the first login), `reauth_at`, `remember_selector`, the IP and the user
 * agent unless the patch sets them, and expires as {@link createSession} would at `now`, within the absolute limit.
 *
 * The old row stays valid for ROTATION_GRACE_MS (`expires_at = min(old, now + ROTATION_GRACE_MS)`), loses its
 * `remember_selector` (the remember-me token now belongs to the new row only, B9) and gets `last_seen_at = now`, so
 * that no touch with the old token can extend it.
 *
 * @throws DomainError AUTH_REQUIRED when the old row is gone (revoked or expired at `now`): nothing is inserted
 * @throws TypeError for a selector that is not 24 characters
 */
export async function rotateSession(trx: Transaction<DB>, s: SessionView, o: RotatePatch): Promise<SessionToken> {
  checkSelector('rotateSession', o.rememberSelector);
  // A write on the old row first: it locks the row (MySQL/MariaDB, PostgreSQL) before it is read, so the read sees
  // its current values, and a session revoked or expired in the meantime is not brought back under a new token.
  const live = await trx
    .updateTable('sessions')
    .set({ last_seen_at: o.now })
    .where('id', '=', s.id)
    .where('subject_type', '=', STAFF)
    .where('expires_at', '>', o.now)
    .executeTakeFirst();
  const old =
    Number(live.numUpdatedRows) === 1
      ? await trx
          .selectFrom('sessions')
          .select(['created_at', 'reauth_at', 'remember_selector', 'ip', 'user_agent'])
          .where('id', '=', s.id)
          .executeTakeFirst()
      : undefined;
  if (old === undefined) {
    throw new DomainError('AUTH_REQUIRED', { detail: 'Sesi sudah berakhir / The session has ended' });
  }
  await trx.updateTable('sessions').set({ remember_selector: null }).where('id', '=', s.id).execute();
  const graceEnd = o.now + ROTATION_GRACE_MS;
  await trx
    .updateTable('sessions')
    .set({ expires_at: graceEnd })
    .where('id', '=', s.id)
    .where('expires_at', '>', graceEnd)
    .execute();

  const createdAt = Number(old.created_at);
  const mfaPassed = o.mfaPassed ?? s.mfaPassed;
  const token = randomToken(32);
  const id = sha256hex(token);
  await trx
    .insertInto('sessions')
    .values({
      id,
      subject_type: STAFF,
      subject_id: s.subjectId,
      created_at: createdAt,
      last_seen_at: o.now,
      expires_at: expiry(createdAt, o.now, mfaPassed, o.idleMs),
      ip: old.ip,
      user_agent: old.user_agent,
      mfa_passed: mfaPassed ? 1 : 0,
      reauth_at: o.reauthAt !== undefined ? o.reauthAt : old.reauth_at,
      remember_selector: o.rememberSelector !== undefined ? o.rememberSelector : old.remember_selector,
      authz_version: o.authzVersion ?? s.authzVersion,
    })
    .execute();
  return { token, id };
}

/** Records a successful re-authentication (§7.3) on the session. */
export async function markReauth(trx: Transaction<DB>, sessionId: string, now: number): Promise<void> {
  await trx.updateTable('sessions').set({ reauth_at: now }).where('id', '=', sessionId).execute();
}

/**
 * Deletes the session and the remember-me token it carries (B9: logout, revoking one session). Other sessions that
 * carried the same token (restored from it) keep running, without it. An unknown id does nothing.
 */
export async function revokeSession(trx: Transaction<DB>, sessionId: string): Promise<void> {
  const r = await trx.selectFrom('sessions').select('remember_selector').where('id', '=', sessionId).executeTakeFirst();
  await trx.deleteFrom('sessions').where('id', '=', sessionId).execute();
  const selector = r?.remember_selector ?? null;
  if (selector !== null) await revokeRememberToken(trx, selector);
}

/**
 * Deletes the remember-me token `selector`; the sessions that carried it (the one that issued it, those restored
 * from it) keep running without it. An unknown selector does nothing.
 */
export async function revokeRememberToken(trx: Transaction<DB>, selector: string): Promise<void> {
  await trx.deleteFrom('remember_tokens').where('selector', '=', selector).execute();
  await trx
    .updateTable('sessions')
    .set({ remember_selector: null })
    .where('remember_selector', '=', selector)
    .execute();
}

/**
 * Whether `s` is a rotated-away row in its grace: rotateSession leaves it with `last_seen_at` = the rotation time and
 * `expires_at` at most ROTATION_GRACE_MS later. A session that was never rotated is only that close to its end in
 * the last seconds of its absolute lifetime, where treating it as rotated away changes nothing. The one test of it:
 * step 7 (no second rotation in the grace), the session list, revokeSessionLineage and rotatedInto.
 */
export function inRotationGrace(s: Pick<SessionView, 'lastSeenAt' | 'expiresAt'>): boolean {
  return s.expiresAt - s.lastSeenAt <= ROTATION_GRACE_MS;
}

/** {@link inRotationGrace} of a row as read. */
function rowInGrace(r: { last_seen_at: number; expires_at: number }): boolean {
  return inRotationGrace({ lastSeenAt: Number(r.last_seen_at), expiresAt: Number(r.expires_at) });
}

/** A row of a sign-in, as {@link signInOf} reads it. */
interface SignInRow {
  id: string;
  last_seen_at: number;
  expires_at: number;
}

/**
 * The row `sessionId` and the rows of its sign-in, itself among them (see revokeSessionLineage: the subject's rows
 * with the same `created_at`, IP and user agent); null for an unknown id.
 */
async function signInOf(trx: Transaction<DB>, sessionId: string): Promise<{ self: SignInRow; kin: SignInRow[] } | null> {
  const self = await trx
    .selectFrom('sessions')
    .select(['id', 'subject_type', 'subject_id', 'created_at', 'last_seen_at', 'expires_at', 'ip', 'user_agent'])
    .where('id', '=', sessionId)
    .executeTakeFirst();
  if (self === undefined) return null;
  let q = trx
    .selectFrom('sessions')
    .select(['id', 'last_seen_at', 'expires_at'])
    .where('subject_type', '=', self.subject_type)
    .where('subject_id', '=', self.subject_id)
    .where('created_at', '=', Number(self.created_at));
  q = self.ip === null ? q.where('ip', 'is', null) : q.where('ip', '=', self.ip);
  q = self.user_agent === null ? q.where('user_agent', 'is', null) : q.where('user_agent', '=', self.user_agent);
  return { self, kin: await q.orderBy('id').execute() };
}

/**
 * Revokes the session `sessionId` with the rest of its sign-in (logout): the sessions it was rotated from and into,
 * each with the remember-me token it carries (revokeSession). A tab that still sends a rotated-away token in its
 * grace thus logs out the session that replaced it, and the token rotation moved onto it, too.
 *
 * The lineage is what rotateSession records: the new row keeps the old row's `created_at`, IP and user agent, and
 * the old row is left with `expires_at − last_seen_at ≤ ROTATION_GRACE_MS`. So among the subject's rows with the same
 * `created_at`, IP and user agent, the ones revoked are `sessionId` itself and, when it is rotated away, all of them;
 * otherwise the rotated-away ones (its predecessors). Two sign-ins of one user from one browser in the same
 * millisecond would count as one; nothing is ever left that should have gone.
 *
 * @returns the number of sessions deleted (0 for an unknown id)
 */
export async function revokeSessionLineage(trx: Transaction<DB>, sessionId: string): Promise<number> {
  const signIn = await signInOf(trx, sessionId);
  if (signIn === null) return 0;
  const all = rowInGrace(signIn.self);
  const doomed = new Set([sessionId, ...signIn.kin.filter((r) => all || rowInGrace(r)).map((r) => r.id)]);
  for (const id of doomed) await revokeSession(trx, id);
  return doomed.size;
}

/**
 * The sessions `sessionId` was rotated into: when it is a rotated-away row in its grace ({@link inRotationGrace}),
 * the rows of its sign-in that are not (the lineage revokeSessionLineage reads); otherwise, and for an unknown id,
 * none. A request that still carries the old token (another tab, a parallel request: Review Focus 3) acts for a
 * browser that already holds one of these, so what keeps the requesting session keeps them too (a password change,
 * revokeSubject's `exceptSessionId`).
 */
export async function rotatedInto(trx: Transaction<DB>, sessionId: string): Promise<string[]> {
  const signIn = await signInOf(trx, sessionId);
  if (signIn === null || !rowInGrace(signIn.self)) return [];
  return signIn.kin.filter((r) => r.id !== sessionId && !rowInGrace(r)).map((r) => r.id);
}

/**
 * Revokes a subject's sessions and remember-me tokens (password change or reset, 2FA changes, disabling, role
 * revocation): every session but `exceptSessionId` (one id, or several: a password change keeps the session it was
 * rotated into too, rotatedInto), and every remember token, the excepted sessions' included (they stay signed in,
 * without remember-me).
 *
 * With `rememberOnly: 'mfa_unbound'` (2FA enabled or required, §7.1) only the tokens with `mfa_bound = 0` go, with the
 * sessions that carry them (the one that issued each token and those restored from it).
 *
 * @returns the numbers of sessions and tokens deleted
 */
export async function revokeSubject(
  trx: Transaction<DB>,
  subjectId: string,
  o: { exceptSessionId?: string | readonly string[]; rememberOnly?: 'mfa_unbound' } = {},
): Promise<{ sessions: number; tokens: number }> {
  const unboundOnly = o.rememberOnly === 'mfa_unbound';
  const except: string[] =
    o.exceptSessionId === undefined ? [] : typeof o.exceptSessionId === 'string' ? [o.exceptSessionId] : [...o.exceptSessionId];
  const doomedSelectors = () => {
    let q = trx
      .selectFrom('remember_tokens')
      .select('selector')
      .where('subject_type', '=', STAFF)
      .where('subject_id', '=', subjectId);
    if (unboundOnly) q = q.where('mfa_bound', '=', 0);
    return q;
  };

  if (except.length > 0) {
    await trx
      .updateTable('sessions')
      .set({ remember_selector: null })
      .where('id', 'in', except)
      .where('remember_selector', 'in', doomedSelectors())
      .execute();
  }

  let sessions = trx.deleteFrom('sessions').where('subject_type', '=', STAFF).where('subject_id', '=', subjectId);
  if (unboundOnly) sessions = sessions.where('remember_selector', 'in', doomedSelectors());
  if (except.length > 0) sessions = sessions.where('id', 'not in', except);
  const deletedSessions = await sessions.executeTakeFirst();

  let tokens = trx.deleteFrom('remember_tokens').where('subject_type', '=', STAFF).where('subject_id', '=', subjectId);
  if (unboundOnly) tokens = tokens.where('mfa_bound', '=', 0);
  const deletedTokens = await tokens.executeTakeFirst();

  return { sessions: Number(deletedSessions.numDeletedRows), tokens: Number(deletedTokens.numDeletedRows) };
}

/** The live staff sessions of `subjectId`, newest first. */
export async function listSessions(db: Kysely<DB>, subjectId: string, now: number): Promise<SessionView[]> {
  const rows = await db
    .selectFrom('sessions')
    .selectAll()
    .where('subject_type', '=', STAFF)
    .where('subject_id', '=', subjectId)
    .where('expires_at', '>', now)
    .orderBy('created_at', 'desc')
    .orderBy('last_seen_at', 'desc')
    .orderBy('id')
    .execute();
  return rows.map(view);
}
