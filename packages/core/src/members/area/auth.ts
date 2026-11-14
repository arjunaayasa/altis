import type { DB } from '@altis/db';
import { DomainError, isDomainError, isLocale, type IpTrust, type Locale } from '@altis/shared';
import type { Kysely, Transaction } from 'kysely';
import { errorFields, type Actor, type CoreLogger, type TxCtx, type TxRunner } from '../../context.js';
import { clearBucket, hit, refund, BUCKETS, type BucketName, type Hit } from '../../auth/rate-limit.js';
import type { PasswordHasher } from '../../crypto/password.js';
import { normalizePassword } from '../../crypto/password.js';
import { isCommonPassword, PASSWORD_MAX_LENGTH } from '../../crypto/policy.js';
import { randomToken, sha256hex } from '../../crypto/tokens.js';
import { lockLiveMember, writeMemberEvents } from '../common.js';
import { memberNoProblem, normalizeMemberNo } from '../keys.js';
import { createMemberSession, MEMBER_SUBJECT, revokeMemberSession, revokeMemberSessions, type MemberSessionLimits } from './sessions.js';

// Signing in to the OPAC member area and the member's password (spec of the community member area):
//
// Sign-in with the member number (never an e-mail) and the password:
//   key     = normalizeMemberNo(number); a number no member can have → the one failure message, nothing counted
//   perIp   = ipTrust === 'ok' && ip !== null
//   buckets = member_login:user(key), and with perIp member_login:user-ip(key:ip), member_login:ip(ip); each hit in a
//             transaction of its own, committed before anything is verified. A refused hit → AUTH_TOO_MANY_ATTEMPTS;
//             the hit that first fills a bucket in its window writes `members.self.login_locked {bucket, count}` once.
//   the member is looked up by number (one query whatever the outcome): an unknown, archived or anonymised member, or one
//             without a password (a migrated MD5 hash was not kept), runs the dummy hash, so every failure takes the same
//             time and gives the same message ("member number or password is wrong").
//   the password is verified outside any transaction by the server's PasswordHasher (its queue and AUTH_BUSY shared with
//             staff sign-in); a SLiMS bcrypt hash verifies there too and is rehashed to scrypt, still outside.
//   then one short transaction: the member's row locked first; the rehash written only over the hash that was verified
//             (`WHERE password_hash = :old`; none written when it changed meanwhile, the sign-in still succeeds); the
//             member_login:user-ip bucket cleared and the other hits given back; the browser's previous member session
//             revoked; a new session at the member's `session_version`; `last_login_at`; and the sign-in hooks (the
//             visits of the library add the member's online visit here).
// An expired or suspended member may sign in (to look only); `must_reset_password` lets the session reach the
// password page only (the HTTP layer).
//
// The member's own password: the current one checked first (a wrong one says so), then the policy (at least
// `members.password.minLength` characters, at most 256, not a common password, no composition rule), then the new hash
// outside the transaction; the transaction writes it, ends every session of the member and opens a new one for this
// browser (`members.self.password_change`).
//
// The reset by e-mail: the member number → a 256-bit token stored as its SHA-256 for 30 minutes when the member is live
// and has an e-mail address (the mail goes to that address; the page says the same thing whatever happened); used once,
// it sets the new password, ends every session and deletes the other reset tokens (`members.self.password_reset`).
//
// Staff may set or clear a member's password (`members.member.password_set`, re-authenticated), optionally asking for a
// new one at the next sign-in; every session of the member ends.

/** How long a member's reset link works (30 minutes). */
export const MEMBER_RESET_TTL_MS = 1_800_000;

/** A token: randomToken(32). */
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

const invalidCredentials = (): DomainError =>
  new DomainError('AUTH_INVALID_CREDENTIALS', {
    detail: 'Nomor anggota atau kata sandi salah / Wrong member number or password',
  });

const tooManyAttempts = (retryAfterS: number): DomainError =>
  new DomainError('AUTH_TOO_MANY_ATTEMPTS', {
    detail: 'Terlalu banyak percobaan; coba lagi nanti / Too many attempts; try again later',
    meta: { retryAfterS },
  });

const wrongCurrentPassword = (): DomainError =>
  new DomainError('AUTH_INVALID_CREDENTIALS', { detail: 'Kata sandi saat ini salah / The current password is wrong' });

const resetTokenInvalid = (): DomainError =>
  new DomainError('AUTH_RESET_TOKEN_INVALID', {
    detail: 'Tautan atur sandi tidak dikenal, kedaluwarsa, atau sudah dipakai / The link is unknown, expired or already used',
  });

const sessionEnded = (): DomainError =>
  new DomainError('AUTH_REQUIRED', { detail: 'Sesi sudah berakhir; silakan masuk lagi / The session has ended; sign in again' });

// ---------------------------------------------------------------------------------------------------------------
// The policy

/** The code points of `s`. */
const codePoints = (s: string): number => Array.from(s).length;

/**
 * Throws unless `pw` may be a member's password: at least `minLength` characters (`members.password.minLength`, 6-64),
 * at most 256, and not a common password. Lengths are code points of the NFKC form; nothing is trimmed.
 *
 * @throws DomainError `PASSWORD_TOO_WEAK` with `meta.reason` `too_short`, `too_long` or `common`
 */
export function checkMemberPasswordPolicy(pw: string, minLength: number): void {
  const normalized = normalizePassword(pw);
  const length = codePoints(normalized);
  if (length < minLength) {
    throw new DomainError('PASSWORD_TOO_WEAK', {
      detail: `Kata sandi minimal ${minLength} karakter / The password needs at least ${minLength} characters`,
      meta: { reason: 'too_short', minLength },
    });
  }
  if (length > PASSWORD_MAX_LENGTH) {
    throw new DomainError('PASSWORD_TOO_WEAK', {
      detail: `Kata sandi maksimal ${PASSWORD_MAX_LENGTH} karakter / The password may have at most ${PASSWORD_MAX_LENGTH} characters`,
      meta: { reason: 'too_long' },
    });
  }
  if (isCommonPassword(normalized)) {
    throw new DomainError('PASSWORD_TOO_WEAK', {
      detail: 'Kata sandi ini terlalu umum / This password is too common',
      meta: { reason: 'common' },
    });
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Sign-in

/** What a sign-in hook gets: the transaction of the new session, and whose it is. */
export type MemberSignInHook = (tx: TxCtx, signIn: { memberId: string; homeBranchId: string | null }) => Promise<void>;

/**
 * Runs in the transaction of every member sign-in, after the session is made (the visits of the library push the
 * member's online visit of the day here). A hook that fails fails the sign-in: it must swallow what it may ignore.
 */
export const MEMBER_SIGN_IN_HOOKS: MemberSignInHook[] = [];

/** What {@link memberLogin} takes besides the credentials. */
export interface MemberLoginCtx extends MemberSessionLimits {
  run: TxRunner;
  now: number;
  ip: string | null;
  ipTrust: IpTrust;
  userAgent: string | null;
  hasher: PasswordHasher;
  /** The member session the browser holds now (a sign-in replaces it). */
  previousSessionId?: string;
  log: CoreLogger;
}

export interface MemberLoginOutcome {
  memberId: string;
  session: { token: string; id: string };
  mustResetPassword: boolean;
}

interface FoundMember {
  id: string;
  passwordHash: string;
}

/** Counts `buckets` (each in its own transaction), audits a bucket that has just filled, and refuses when one is full. */
async function countAttempt(ctx: Pick<MemberLoginCtx, 'run' | 'now' | 'ip'>, buckets: readonly [BucketName, string][], actor: Actor): Promise<Hit[]> {
  const hits: Hit[] = [];
  for (const [name, subject] of buckets) hits.push(await ctx.run((tx) => hit(tx.trx, name, subject, ctx.now), { actor }));
  const refused = hits.filter((h) => !h.allowed);
  if (refused.length > 0) {
    const justFull = refused.find((h) => h.count === BUCKETS[h.name].limit + 1 && h.name.startsWith('member_login:'));
    if (justFull !== undefined) {
      await ctx.run(
        (tx) =>
          tx.audit({ action: 'members.self.login_locked', entity: 'members', entityId: null, meta: { bucket: justFull.name, count: justFull.count } }),
        { actor },
      );
    }
    throw tooManyAttempts(Math.max(...refused.map((h) => h.retryAfterS)));
  }
  return hits;
}

/** Gives the hits back (a busy hasher verified nothing); a failure is only logged. */
async function giveBack(ctx: Pick<MemberLoginCtx, 'run' | 'log'>, hits: readonly Hit[]): Promise<void> {
  try {
    await ctx.run(async (tx) => {
      for (const h of hits) await refund(tx.trx, h);
    });
  } catch (failure) {
    ctx.log.error('member login: the hits of an attempt the busy hasher never verified were not given back', { error: errorFields(failure) });
  }
}

/** `phc` hashed again when it is not a current scrypt hash; null when current, or when the hasher is busy now. */
async function rehash(hasher: PasswordHasher, phc: string, password: string): Promise<string | null> {
  if (!hasher.needsRehash(phc)) return null;
  try {
    return await hasher.hash(password);
  } catch (error) {
    if (isDomainError(error) && error.code === 'AUTH_BUSY') return null;
    throw error;
  }
}

/**
 * Signs a member in with the member number and the password (see the top of this file).
 *
 * @throws DomainError `AUTH_TOO_MANY_ATTEMPTS` (`meta.retryAfterS`), `AUTH_INVALID_CREDENTIALS`, `AUTH_BUSY`
 */
export async function memberLogin(input: { memberNo: string; password: string }, ctx: MemberLoginCtx): Promise<MemberLoginOutcome> {
  const { now, ip } = ctx;
  const key = normalizeMemberNo(input.memberNo);
  if (memberNoProblem(key) !== null) throw invalidCredentials();
  const perIp = ctx.ipTrust === 'ok' ? ip : null;
  const buckets: [BucketName, string][] = [['member_login:user', key]];
  if (perIp !== null) buckets.push(['member_login:user-ip', `${key}:${perIp}`], ['member_login:ip', perIp]);
  const anonymous: Actor = { type: 'anonymous', id: null, ip };
  const hits = await countAttempt(ctx, buckets, anonymous);

  const found = await ctx.run(
    async (tx): Promise<FoundMember | null> => {
      const row = await tx.trx
        .selectFrom('members')
        .select(['id', 'password_hash', 'archived_at', 'anonymized_at'])
        .where('member_no_key', '=', key)
        .executeTakeFirst();
      if (row === undefined || row.archived_at !== null || row.anonymized_at !== null || row.password_hash === null) return null;
      return { id: row.id, passwordHash: row.password_hash };
    },
    { actor: anonymous },
  );

  let ok: boolean;
  try {
    ok = found === null ? await ctx.hasher.verifyDummy(input.password) : await ctx.hasher.verify(input.password, found.passwordHash);
  } catch (error) {
    if (isDomainError(error) && error.code === 'AUTH_BUSY') await giveBack(ctx, hits);
    throw error;
  }
  if (!ok || found === null) throw invalidCredentials();
  const memberId = found.id;
  const newHash = await rehash(ctx.hasher, found.passwordHash, input.password);

  const member: Actor = { type: 'member', id: memberId, ip };
  return ctx.run(
    async (tx) => {
      const { trx } = tx;
      if (!(await lockLiveMember(trx, memberId))) throw invalidCredentials();
      const row = await trx
        .selectFrom('members')
        .select(['session_version', 'must_reset_password', 'home_branch_id'])
        .where('id', '=', memberId)
        .executeTakeFirstOrThrow();
      for (const h of hits) {
        if (h.name === 'member_login:user-ip') await clearBucket(trx, h.name, h.subject);
        else await refund(trx, h);
      }
      if (ctx.previousSessionId !== undefined) await revokeMemberSession(trx, ctx.previousSessionId);
      if (newHash !== null) {
        await trx
          .updateTable('members')
          .set({ password_hash: newHash })
          .where('id', '=', memberId)
          .where('password_hash', '=', found.passwordHash)
          .execute();
      }
      await trx.updateTable('members').set({ last_login_at: now }).where('id', '=', memberId).execute();
      const session = await createMemberSession(trx, {
        memberId,
        sessionVersion: Number(row.session_version),
        ip,
        userAgent: ctx.userAgent,
        now,
        idleMs: ctx.idleMs,
        absoluteMs: ctx.absoluteMs,
      });
      for (const hook of MEMBER_SIGN_IN_HOOKS) await hook(tx, { memberId, homeBranchId: row.home_branch_id });
      return { memberId, session, mustResetPassword: Number(row.must_reset_password) === 1 };
    },
    { actor: member },
  );
}

// ---------------------------------------------------------------------------------------------------------------
// The member's own password

/**
 * Changes the signed-in member's password (see the top of this file) and returns the browser's new session.
 *
 * @throws DomainError `AUTH_INVALID_CREDENTIALS` (the current password is wrong), `PASSWORD_TOO_WEAK`,
 *   `AUTH_TOO_MANY_ATTEMPTS`, `AUTH_REQUIRED` (the member left meanwhile), `AUTH_BUSY`
 */
export async function changeMemberPassword(
  input: { memberId: string; current: string; next: string; minLength: number },
  ctx: Omit<MemberLoginCtx, 'previousSessionId'>,
): Promise<{ token: string; id: string }> {
  const { now, ip } = ctx;
  const actor: Actor = { type: 'member', id: input.memberId, ip };
  const stored = await ctx.run(
    (tx) => tx.trx.selectFrom('members').select(['password_hash', 'member_no_key']).where('id', '=', input.memberId).executeTakeFirst(),
    { actor },
  );
  // A password reset by staff (`must_reset_password` without a hash) is never the case here: such a member cannot sign in.
  if (stored === undefined || stored.password_hash === null) throw sessionEnded();
  const hits = await countAttempt(ctx, [['member_login:user', stored.member_no_key]], actor);
  let ok: boolean;
  try {
    ok = await ctx.hasher.verify(input.current, stored.password_hash);
  } catch (error) {
    if (isDomainError(error) && error.code === 'AUTH_BUSY') await giveBack(ctx, hits);
    throw error;
  }
  if (!ok) throw wrongCurrentPassword();
  checkMemberPasswordPolicy(input.next, input.minLength);
  const hash = await ctx.hasher.hash(input.next);
  return ctx.run(
    async (tx) => {
      const { trx } = tx;
      if (!(await lockLiveMember(trx, input.memberId))) throw sessionEnded();
      const current = await trx.selectFrom('members').select(['password_hash', 'session_version']).where('id', '=', input.memberId).executeTakeFirstOrThrow();
      if (current.password_hash !== stored.password_hash) throw wrongCurrentPassword();
      for (const h of hits) await refund(trx, h);
      await trx
        .updateTable('members')
        .set({ password_hash: hash, must_reset_password: 0, updated_at: now })
        .where('id', '=', input.memberId)
        .execute();
      await deleteMemberResets(trx, input.memberId);
      await revokeMemberSessions(trx, input.memberId);
      await writeMemberEvents(tx, input.memberId, [{ type: 'password', meta: { by: 'member' } }]);
      await tx.audit({ action: 'members.self.password_change', entity: 'members', entityId: input.memberId });
      return createMemberSession(trx, {
        memberId: input.memberId,
        sessionVersion: Number(current.session_version) + 1,
        ip,
        userAgent: ctx.userAgent,
        now,
        idleMs: ctx.idleMs,
        absoluteMs: ctx.absoluteMs,
      });
    },
    { actor },
  );
}

/** Deletes every reset token of the member `memberId`. */
async function deleteMemberResets(trx: Transaction<DB>, memberId: string): Promise<void> {
  await trx.deleteFrom('password_resets').where('subject_type', '=', MEMBER_SUBJECT).where('subject_id', '=', memberId).execute();
}

// ---------------------------------------------------------------------------------------------------------------
// The reset by e-mail

/** What a started reset gives the caller for the mail; `token` is only in it (the database keeps its hash). */
export interface MemberResetStart {
  memberId: string;
  name: string;
  memberNo: string;
  email: string;
  locale: Locale | null;
  token: string;
}

/**
 * Starts a reset for the member number `memberNo` in `trx`: when a live member holds it and has an e-mail address, a
 * `password_resets` row (subject `member`, the token's SHA-256, 30 minutes) and what the mail needs; otherwise null.
 * The caller counts the forgot buckets first and answers the same whatever this returns.
 */
export async function startMemberReset(trx: Transaction<DB>, o: { memberNo: string; now: number }): Promise<MemberResetStart | null> {
  const key = normalizeMemberNo(o.memberNo);
  if (memberNoProblem(key) !== null) return null;
  const m = await trx
    .selectFrom('members')
    .select(['id', 'name', 'member_no_display', 'email', 'locale', 'archived_at', 'anonymized_at'])
    .where('member_no_key', '=', key)
    .executeTakeFirst();
  if (m === undefined || m.archived_at !== null || m.anonymized_at !== null || m.email === null || m.email.trim() === '') return null;
  const token = randomToken(32);
  await trx
    .insertInto('password_resets')
    .values({ token_hash: sha256hex(token), subject_type: MEMBER_SUBJECT, subject_id: m.id, expires_at: o.now + MEMBER_RESET_TTL_MS, used_at: null })
    .execute();
  return { memberId: m.id, name: m.name, memberNo: m.member_no_display, email: m.email, locale: isLocale(m.locale) ? m.locale : null, token };
}

/**
 * The member whose unused, unexpired reset token `token` is at `now` (read before the new password is hashed, so that a
 * dead link costs no hash).
 *
 * @throws DomainError AUTH_RESET_TOKEN_INVALID
 */
export async function memberResetSubject(db: Kysely<DB> | Transaction<DB>, token: string, now: number): Promise<string> {
  if (typeof token !== 'string' || !TOKEN.test(token)) throw resetTokenInvalid();
  const row = await db
    .selectFrom('password_resets')
    .select('subject_id')
    .where('token_hash', '=', sha256hex(token))
    .where('subject_type', '=', MEMBER_SUBJECT)
    .where('used_at', 'is', null)
    .where('expires_at', '>', now)
    .executeTakeFirst();
  if (row === undefined) throw resetTokenInvalid();
  return row.subject_id;
}

/**
 * Completes a reset in `tx` (actor: the token's member, from {@link memberResetSubject}) with the hash the caller made
 * outside the transaction after the policy: the member's row locked first, the token used up by the UPDATE that checks
 * it, the password set (`must_reset_password = 0`), every session ended and the other tokens deleted.
 *
 * @throws DomainError AUTH_RESET_TOKEN_INVALID (also for a member archived or anonymised meanwhile)
 */
export async function completeMemberReset(tx: TxCtx, o: { token: string; passwordHash: string }): Promise<{ memberId: string }> {
  const memberId = tx.actor.type === 'member' ? tx.actor.id : null;
  if (memberId === null) throw new TypeError("completeMemberReset: run it as the token's member (tx.actor = {type: 'member', id})");
  const { trx } = tx;
  if (!(await lockLiveMember(trx, memberId))) throw resetTokenInvalid();
  if (typeof o.token !== 'string' || !TOKEN.test(o.token)) throw resetTokenInvalid();
  const used = await trx
    .updateTable('password_resets')
    .set({ used_at: tx.now })
    .where('token_hash', '=', sha256hex(o.token))
    .where('subject_type', '=', MEMBER_SUBJECT)
    .where('subject_id', '=', memberId)
    .where('used_at', 'is', null)
    .where('expires_at', '>', tx.now)
    .executeTakeFirst();
  if (Number(used.numUpdatedRows) !== 1) throw resetTokenInvalid();
  await trx.updateTable('members').set({ password_hash: o.passwordHash, must_reset_password: 0, updated_at: tx.now }).where('id', '=', memberId).execute();
  await trx
    .deleteFrom('password_resets')
    .where('subject_type', '=', MEMBER_SUBJECT)
    .where('subject_id', '=', memberId)
    .where('token_hash', '!=', sha256hex(o.token))
    .execute();
  await revokeMemberSessions(trx, memberId);
  await writeMemberEvents(tx, memberId, [{ type: 'password', meta: { by: 'reset' } }]);
  await tx.audit({ action: 'members.self.password_reset', entity: 'members', entityId: memberId });
  return { memberId };
}

// ---------------------------------------------------------------------------------------------------------------
// Staff

/**
 * Sets (a hash made by the caller outside the transaction) or clears (null) the OPAC password of the member `memberId`,
 * with `mustReset` asking for a new one at the next sign-in; every session and reset token of the member ends. Audits
 * `members.member.password_set {cleared, mustReset}` (never the password).
 *
 * @throws DomainError NOT_FOUND for a member that is not live
 */
export async function setMemberPassword(tx: TxCtx, memberId: string, o: { passwordHash: string | null; mustReset: boolean }): Promise<{ id: string; version: number }> {
  const { trx } = tx;
  if (!(await lockLiveMember(trx, memberId))) throw new DomainError('NOT_FOUND', { detail: 'Anggota tidak ditemukan / Member not found' });
  await trx
    .updateTable('members')
    .set((eb) => ({
      password_hash: o.passwordHash,
      must_reset_password: o.mustReset ? 1 : 0,
      updated_at: tx.now,
      updated_by: tx.actor.type === 'staff' ? tx.actor.id : null,
      version: eb('version', '+', 1),
    }))
    .where('id', '=', memberId)
    .execute();
  await deleteMemberResets(trx, memberId);
  await revokeMemberSessions(trx, memberId);
  await writeMemberEvents(tx, memberId, [{ type: 'password', meta: { by: 'staff', cleared: o.passwordHash === null, mustReset: o.mustReset } }]);
  await tx.audit({ action: 'members.member.password_set', entity: 'members', entityId: memberId, meta: { cleared: o.passwordHash === null, mustReset: o.mustReset } });
  const row = await trx.selectFrom('members').select('version').where('id', '=', memberId).executeTakeFirstOrThrow();
  return { id: memberId, version: Number(row.version) };
}

/**
 * Verifies the signed-in member's current password (the download of the member's own data asks for it): counted on
 * `member_export:member` and `member_login:user` first, verified outside any transaction.
 *
 * @throws DomainError `AUTH_INVALID_CREDENTIALS`, `AUTH_TOO_MANY_ATTEMPTS`, `AUTH_REQUIRED`, `AUTH_BUSY`
 */
export async function confirmMemberPassword(
  input: { memberId: string; password: string },
  ctx: Pick<MemberLoginCtx, 'run' | 'now' | 'ip' | 'hasher' | 'log'>,
): Promise<void> {
  const actor: Actor = { type: 'member', id: input.memberId, ip: ctx.ip };
  const stored = await ctx.run(
    (tx) => tx.trx.selectFrom('members').select(['password_hash', 'member_no_key']).where('id', '=', input.memberId).executeTakeFirst(),
    { actor },
  );
  if (stored === undefined || stored.password_hash === null) throw sessionEnded();
  const hits = await countAttempt(
    ctx,
    [
      ['member_export:member', input.memberId],
      ['member_login:user', stored.member_no_key],
    ],
    actor,
  );
  let ok: boolean;
  try {
    ok = await ctx.hasher.verify(input.password, stored.password_hash);
  } catch (error) {
    if (isDomainError(error) && error.code === 'AUTH_BUSY') await giveBack(ctx, hits);
    throw error;
  }
  if (!ok) throw wrongCurrentPassword();
  // A right password was no guess: the sign-in bucket gets its hit back (the export bucket keeps its count).
  const signIn = hits.find((h) => h.name === 'member_login:user');
  if (signIn !== undefined) await ctx.run((tx) => refund(tx.trx, signIn), { actor });
}
