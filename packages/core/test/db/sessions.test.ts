import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PHASE1_MIGRATIONS, runMigrations, withTx } from '@altis/db';
import { newId } from '@altis/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { issueRememberToken } from '../../src/auth/remember.js';
import {
  PRE_MFA_MS,
  ROTATION_GRACE_MS,
  SESSION_ABSOLUTE_MS,
  TOUCH_INTERVAL_MS,
  createSession,
  findSession,
  inRotationGrace,
  listSessions,
  markReauth,
  revokeSession,
  revokeSubject,
  rotateSession,
  rotatedInto,
  touchSession,
  type SessionView,
} from '../../src/auth/sessions.js';
import { randomToken, sha256hex } from '../../src/crypto/tokens.js';

// Staff sessions in the database (spec §7.1, P6): the DB keeps only the SHA-256 of the 256-bit token; a pre-2FA
// session lives 10 min; a full one is idle-limited (written at most once per 60 s, never by a background request)
// and absolute-limited to 12 h from its creation; a rotated token stays valid for 30 s; a session is revoked with
// its remember-me token (B9). On the engine picked by ALTIS_TEST_DB.

const ctx = testDbContext();
const NOW = 1_767_225_600_000;
const MIN = 60_000;
const IDLE = 30 * MIN;

describe.skipIf(!ctx.available)(`sessions [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let dataDir: string;

  beforeAll(async () => {
    h = await testDb();
    dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-core-sessions-'));
    await runMigrations(h, { appVersion: '0.1.0', dataDir, migrations: PHASE1_MIGRATIONS });
  });

  afterAll(async () => {
    await h?.close();
    if (dataDir !== undefined) await fsp.rm(dataDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await h.db.deleteFrom('sessions').execute();
    await h.db.deleteFrom('remember_tokens').execute();
  });

  const create = (o: Partial<Parameters<typeof createSession>[1]> = {}) =>
    withTx(h, (trx) =>
      createSession(trx, {
        subjectId: o.subjectId ?? newId(),
        mfaPassed: true,
        authzVersion: 3,
        ip: '203.0.113.9',
        userAgent: 'Mozilla/5.0',
        now: NOW,
        idleMs: IDLE,
        ...o,
      }),
    );

  const row = (id: string) => h.db.selectFrom('sessions').selectAll().where('id', '=', id).executeTakeFirst();
  const found = async (token: string, now: number): Promise<SessionView> => {
    const s = await findSession(h.db, token, now);
    if (s === null) return expect.fail(`no session for the token at ${now - NOW} ms`);
    return s;
  };

  describe('createSession / findSession', () => {
    it('stores only the SHA-256 of a 256-bit token, never the token', async () => {
      const subjectId = newId();
      const { token, id } = await create({ subjectId });
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(id).toBe(sha256hex(token));
      const rows = await h.db.selectFrom('sessions').selectAll().execute();
      expect(rows).toHaveLength(1);
      expect(JSON.stringify(rows)).not.toContain(token);
      expect(rows[0]).toMatchObject({
        id,
        subject_type: 'staff',
        subject_id: subjectId,
        created_at: NOW,
        last_seen_at: NOW,
        expires_at: NOW + IDLE,
        ip: '203.0.113.9',
        user_agent: 'Mozilla/5.0',
        mfa_passed: 1,
        reauth_at: null,
        remember_selector: null,
        authz_version: 3,
      });
    });

    it('findSession returns the view of the session', async () => {
      const subjectId = newId();
      const selector = randomToken(18);
      const { token, id } = await create({ subjectId, reauthAt: NOW, rememberSelector: selector });
      expect(await findSession(h.db, token, NOW + 1)).toEqual({
        id,
        subjectId,
        createdAt: NOW,
        lastSeenAt: NOW,
        expiresAt: NOW + IDLE,
        mfaPassed: true,
        reauthAt: NOW,
        rememberSelector: selector,
        authzVersion: 3,
        ip: '203.0.113.9',
        userAgent: 'Mozilla/5.0',
      } satisfies SessionView);
    });

    it('a pre-2FA session (mfaPassed false) expires 10 min after its creation', async () => {
      const { token, id } = await create({ mfaPassed: false });
      expect(PRE_MFA_MS).toBe(10 * MIN);
      expect(await row(id)).toMatchObject({ expires_at: NOW + PRE_MFA_MS, mfa_passed: 0 });
      expect((await found(token, NOW + PRE_MFA_MS - 1)).mfaPassed).toBe(false);
      expect(await findSession(h.db, token, NOW + PRE_MFA_MS)).toBeNull();
    });

    it('a full session never outlives the absolute limit, whatever the idle time', async () => {
      const { id } = await create({ idleMs: 24 * 3_600_000 });
      expect(SESSION_ABSOLUTE_MS).toBe(12 * 3_600_000);
      expect((await row(id))?.expires_at).toBe(NOW + SESSION_ABSOLUTE_MS);
    });

    it('findSession misses at expires_at, and for an unknown or malformed token', async () => {
      const { token } = await create();
      expect(await findSession(h.db, token, NOW + IDLE - 1)).not.toBeNull();
      expect(await findSession(h.db, token, NOW + IDLE)).toBeNull();
      expect(await findSession(h.db, randomToken(), NOW)).toBeNull();
      for (const bad of ['', 'x', `${token}=`, token.slice(1), sha256hex(token)]) {
        expect(await findSession(h.db, bad, NOW), bad).toBeNull();
      }
    });

    it('clips the user agent to 191 code points without splitting a surrogate pair (M21)', async () => {
      const long = `${'a'.repeat(190)}😀tail`;
      const { id } = await create({ userAgent: long });
      expect((await row(id))?.user_agent).toBe(`${'a'.repeat(190)}😀`);
      const pairs = '😀'.repeat(200);
      const { id: id2 } = await create({ userAgent: pairs });
      expect((await row(id2))?.user_agent).toBe('😀'.repeat(191));
      const { id: id3 } = await create({ userAgent: null, ip: null });
      expect(await row(id3)).toMatchObject({ user_agent: null, ip: null });
    });

    it('with a given token, two calls share one row (an upsert on sessions.id)', async () => {
      const token = randomToken();
      const subjectId = newId();
      const first = await create({ token, subjectId });
      const second = await create({ token, subjectId, now: NOW + 1000 });
      expect(first).toEqual({ token, id: sha256hex(token) });
      expect(second).toEqual(first);
      const rows = await h.db.selectFrom('sessions').selectAll().execute();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ created_at: NOW, expires_at: NOW + IDLE });
    });

    it('refuses a given token that is not 43 characters of base64url, and a malformed remember selector', async () => {
      await expect(create({ token: 'short' })).rejects.toThrow(TypeError);
      await expect(create({ rememberSelector: 'S' })).rejects.toThrow(TypeError);
      expect(await h.db.selectFrom('sessions').selectAll().execute()).toEqual([]);
    });
  });

  describe('touchSession', () => {
    it('writes nothing at +59 s or for a background request, and writes at +60 s', async () => {
      const { token, id } = await create();
      const s = await found(token, NOW);
      expect(TOUCH_INTERVAL_MS).toBe(MIN);
      expect(await touchSession(h.db, s, { now: NOW + 59_999, idleMs: IDLE, background: false })).toBe(false);
      expect(await touchSession(h.db, s, { now: NOW + MIN, idleMs: IDLE, background: true })).toBe(false);
      expect(await row(id)).toMatchObject({ last_seen_at: NOW, expires_at: NOW + IDLE });
      expect(await touchSession(h.db, s, { now: NOW + MIN, idleMs: IDLE, background: false })).toBe(true);
      expect(await row(id)).toMatchObject({ last_seen_at: NOW + MIN, expires_at: NOW + MIN + IDLE });
    });

    it('never writes a pre-2FA session', async () => {
      const { token, id } = await create({ mfaPassed: false });
      const s = await found(token, NOW);
      expect(await touchSession(h.db, s, { now: NOW + 2 * MIN, idleMs: IDLE, background: false })).toBe(false);
      expect(await row(id)).toMatchObject({ last_seen_at: NOW, expires_at: NOW + PRE_MFA_MS });
    });

    it('writes once when two requests touch with the same view', async () => {
      const { token, id } = await create();
      const s = await found(token, NOW + MIN);
      expect(await touchSession(h.db, s, { now: NOW + MIN, idleMs: IDLE, background: false })).toBe(true);
      expect(await touchSession(h.db, s, { now: NOW + MIN + 5, idleMs: IDLE, background: false })).toBe(false);
      expect(await row(id)).toMatchObject({ last_seen_at: NOW + MIN, expires_at: NOW + MIN + IDLE });
    });

    it('idle limit: with idleMs 30 min a session untouched for 30 min + 1 ms is gone', async () => {
      const { token } = await create();
      const s = await found(token, NOW + 5 * MIN);
      await touchSession(h.db, s, { now: NOW + 5 * MIN, idleMs: IDLE, background: false });
      expect(await findSession(h.db, token, NOW + 5 * MIN + IDLE - 1)).not.toBeNull();
      expect(await findSession(h.db, token, NOW + 5 * MIN + IDLE + 1)).toBeNull();
    });

    it('absolute limit: touched every 10 min, the session is still gone at createdAt + 12 h', async () => {
      const { token } = await create();
      let at = NOW;
      for (; at < NOW + SESSION_ABSOLUTE_MS; at += 10 * MIN) {
        const s = await found(token, at);
        await touchSession(h.db, s, { now: at, idleMs: IDLE, background: false });
      }
      expect(at).toBe(NOW + SESSION_ABSOLUTE_MS);
      expect(await findSession(h.db, token, NOW + SESSION_ABSOLUTE_MS - 1)).not.toBeNull();
      expect(await findSession(h.db, token, NOW + SESSION_ABSOLUTE_MS)).toBeNull();
    });
  });

  describe('rotateSession', () => {
    it('the new token finds the session; the old one until +29 999 ms, not at +30 000 ms (M4)', async () => {
      const subjectId = newId();
      const { token: oldToken, id: oldId } = await create({ subjectId, mfaPassed: false, authzVersion: 1 });
      const s = await found(oldToken, NOW);
      const at = NOW + MIN;
      const rotated = await withTx(h, (trx) =>
        rotateSession(trx, s, { now: at, idleMs: IDLE, mfaPassed: true, authzVersion: 2 }),
      );
      expect(rotated.id).toBe(sha256hex(rotated.token));
      expect(rotated.token).not.toBe(oldToken);
      expect(ROTATION_GRACE_MS).toBe(30_000);
      expect(await findSession(h.db, rotated.token, at)).toEqual({
        id: rotated.id,
        subjectId,
        createdAt: NOW,
        lastSeenAt: at,
        expiresAt: at + IDLE,
        mfaPassed: true,
        reauthAt: null,
        rememberSelector: null,
        authzVersion: 2,
        ip: '203.0.113.9',
        userAgent: 'Mozilla/5.0',
      } satisfies SessionView);
      expect((await found(oldToken, at + 29_999)).id).toBe(oldId);
      expect(await findSession(h.db, oldToken, at + 30_000)).toBeNull();
    });

    it('keeps created_at, reauth_at, ip and user agent; the absolute limit still counts from created_at', async () => {
      const { token } = await create({ reauthAt: NOW + 1000, userAgent: 'UA/1', ip: '198.51.100.7', idleMs: 24 * 3_600_000 });
      const at = NOW + SESSION_ABSOLUTE_MS - 5 * MIN;
      const s = await found(token, at);
      const rotated = await withTx(h, (trx) => rotateSession(trx, s, { now: at, idleMs: IDLE }));
      expect(await row(rotated.id)).toMatchObject({
        created_at: NOW,
        last_seen_at: at,
        expires_at: NOW + SESSION_ABSOLUTE_MS,
        reauth_at: NOW + 1000,
        ip: '198.51.100.7',
        user_agent: 'UA/1',
        mfa_passed: 1,
        authz_version: 3,
      });
      const cleared = await withTx(h, async (trx) =>
        rotateSession(trx, (await findSession(trx, rotated.token, at))!, { now: at, idleMs: IDLE, reauthAt: null }),
      );
      expect((await row(cleared.id))?.reauth_at).toBeNull();
    });

    it('cuts the old row only down, never extends it', async () => {
      const { token, id } = await create();
      const at = NOW + IDLE - 10_000; // the old row expires in 10 s, less than the grace
      const s = await found(token, at);
      await withTx(h, (trx) => rotateSession(trx, s, { now: at, idleMs: IDLE }));
      expect((await row(id))?.expires_at).toBe(NOW + IDLE);
    });

    it('moves the remember selector to the new row: {rememberSelector: S} → new row S, old row NULL (B9)', async () => {
      const S = randomToken(18);
      const { token, id } = await create({ rememberSelector: randomToken(18) });
      const s = await found(token, NOW);
      const rotated = await withTx(h, (trx) => rotateSession(trx, s, { now: NOW + 1, idleMs: IDLE, rememberSelector: S }));
      expect((await row(rotated.id))?.remember_selector).toBe(S);
      expect((await row(id))?.remember_selector).toBeNull();

      const again = await withTx(h, async (trx) =>
        rotateSession(trx, (await findSession(trx, rotated.token, NOW + 2))!, { now: NOW + 2, idleMs: IDLE }),
      );
      expect((await row(again.id))?.remember_selector).toBe(S);
      expect((await row(rotated.id))?.remember_selector).toBeNull();
    });

    it('a touch with the old token cannot extend the rotated row past the grace', async () => {
      const { token: oldToken, id: oldId } = await create();
      const before = await found(oldToken, NOW + 5 * MIN);
      const at = NOW + 5 * MIN;
      await withTx(h, (trx) => rotateSession(trx, before, { now: at, idleMs: IDLE }));
      // a parallel request that read the session before the rotation, and one that reads it after
      expect(await touchSession(h.db, before, { now: at + 1000, idleMs: IDLE, background: false })).toBe(false);
      const after = await found(oldToken, at + 1000);
      expect(await touchSession(h.db, after, { now: at + 29_000, idleMs: IDLE, background: false })).toBe(false);
      expect(await touchSession(h.db, after, { now: at + MIN, idleMs: IDLE, background: false })).toBe(false);
      expect((await row(oldId))?.expires_at).toBe(at + ROTATION_GRACE_MS);
    });

    it('refuses a session that is gone (revoked or expired) with AUTH_REQUIRED and inserts nothing', async () => {
      const { token, id } = await create();
      const s = await found(token, NOW);
      await withTx(h, (trx) => revokeSession(trx, id));
      await expect(withTx(h, (trx) => rotateSession(trx, s, { now: NOW + 1, idleMs: IDLE }))).rejects.toMatchObject({
        code: 'AUTH_REQUIRED',
      });
      const { token: t2 } = await create();
      const s2 = await found(t2, NOW);
      await expect(
        withTx(h, (trx) => rotateSession(trx, s2, { now: NOW + IDLE, idleMs: IDLE })),
      ).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
      expect(await h.db.selectFrom('sessions').select('id').execute()).toHaveLength(1);
    });
  });

  describe('markReauth', () => {
    it('sets reauth_at', async () => {
      const { id } = await create();
      await withTx(h, (trx) => markReauth(trx, id, NOW + 5000));
      expect((await row(id))?.reauth_at).toBe(NOW + 5000);
    });
  });

  describe('revocation', () => {
    it('revokeSession deletes the session and its remember token, and no other', async () => {
      const subjectId = newId();
      const { id, other, selector, otherSelector } = await withTx(h, async (trx) => {
        const rm = await issueRememberToken(trx, { subjectId, mfaBound: false, now: NOW });
        const rm2 = await issueRememberToken(trx, { subjectId, mfaBound: false, now: NOW });
        const s = await createSession(trx, {
          subjectId,
          mfaPassed: true,
          authzVersion: 1,
          ip: null,
          userAgent: null,
          now: NOW,
          idleMs: IDLE,
          rememberSelector: rm.selector,
        });
        const s2 = await createSession(trx, {
          subjectId,
          mfaPassed: true,
          authzVersion: 1,
          ip: null,
          userAgent: null,
          now: NOW,
          idleMs: IDLE,
          rememberSelector: rm2.selector,
        });
        return { id: s.id, other: s2.id, selector: rm.selector, otherSelector: rm2.selector };
      });
      await withTx(h, (trx) => revokeSession(trx, id));
      expect(await row(id)).toBeUndefined();
      expect(await h.db.selectFrom('remember_tokens').select('selector').execute()).toEqual([{ selector: otherSelector }]);
      expect((await row(other))?.remember_selector).toBe(otherSelector);
      expect(selector).not.toBe(otherSelector);
      await withTx(h, (trx) => revokeSession(trx, 'f'.repeat(64))); // unknown: nothing to do
    });

    it('a token issued and passed to createSession in one transaction is removed by revokeSession of that session (B9)', async () => {
      const subjectId = newId();
      const { session, selector } = await withTx(h, async (trx) => {
        const rm = await issueRememberToken(trx, { subjectId, mfaBound: true, now: NOW });
        const s = await createSession(trx, {
          subjectId,
          mfaPassed: true,
          authzVersion: 1,
          ip: null,
          userAgent: null,
          now: NOW,
          idleMs: IDLE,
          rememberSelector: rm.selector,
        });
        return { session: s, selector: rm.selector };
      });
      expect((await row(session.id))?.remember_selector).toBe(selector);
      // a second session restored from the same token carries its selector too
      const restored = await create({ subjectId, rememberSelector: selector });
      await withTx(h, (trx) => revokeSession(trx, session.id));
      expect(await h.db.selectFrom('remember_tokens').selectAll().execute()).toEqual([]);
      expect(await row(restored.id)).toMatchObject({ remember_selector: null });
    });

    it('revokeSubject(…, {exceptSessionId}) keeps exactly that session, without its remember token', async () => {
      const subjectId = newId();
      const otherSubject = newId();
      const keep = await withTx(h, async (trx) => {
        const rm = await issueRememberToken(trx, { subjectId, mfaBound: true, now: NOW });
        return createSession(trx, {
          subjectId,
          mfaPassed: true,
          authzVersion: 1,
          ip: null,
          userAgent: null,
          now: NOW,
          idleMs: IDLE,
          rememberSelector: rm.selector,
        });
      });
      await create({ subjectId });
      await create({ subjectId, mfaPassed: false });
      await withTx(h, (trx) => issueRememberToken(trx, { subjectId, mfaBound: false, now: NOW }));
      const foreign = await create({ subjectId: otherSubject });
      await withTx(h, (trx) => issueRememberToken(trx, { subjectId: otherSubject, mfaBound: false, now: NOW }));

      const result = await withTx(h, (trx) => revokeSubject(trx, subjectId, { exceptSessionId: keep.id }));
      expect(result).toEqual({ sessions: 2, tokens: 2 });
      const left = await h.db.selectFrom('sessions').select(['id', 'remember_selector']).orderBy('id').execute();
      expect(left).toEqual([keep.id, foreign.id].sort().map((id) => ({ id, remember_selector: null })));
      expect(await h.db.selectFrom('remember_tokens').select('subject_id').execute()).toEqual([{ subject_id: otherSubject }]);
    });

    it('rotatedInto: for a token rotated away (in its grace) the session it was rotated into; none otherwise; revokeSubject keeps every id it is given', async () => {
      const subjectId = newId();
      const { token } = await create({ subjectId });
      const other = await create({ subjectId, now: NOW + 1 }); // another sign-in: another created_at
      const at = NOW + MIN;
      const s = await found(token, at);
      expect(inRotationGrace(s)).toBe(false);
      const rotated = await withTx(h, (trx) => rotateSession(trx, s, { now: at, idleMs: IDLE }));
      expect(inRotationGrace(await found(token, at))).toBe(true);
      expect(inRotationGrace(await found(rotated.token, at))).toBe(false);

      expect(await withTx(h, (trx) => rotatedInto(trx, s.id))).toEqual([rotated.id]);
      expect(await withTx(h, (trx) => rotatedInto(trx, rotated.id))).toEqual([]);
      expect(await withTx(h, (trx) => rotatedInto(trx, other.id))).toEqual([]);
      expect(await withTx(h, (trx) => rotatedInto(trx, sha256hex(randomToken(32))))).toEqual([]);

      const result = await withTx(h, (trx) => revokeSubject(trx, subjectId, { exceptSessionId: [s.id, rotated.id] }));
      expect(result).toEqual({ sessions: 1, tokens: 0 });
      expect((await h.db.selectFrom('sessions').select('id').orderBy('id').execute()).map((r) => r.id)).toEqual([s.id, rotated.id].sort());
    });

    it('revokeSubject without an exception deletes every session and token of the subject', async () => {
      const subjectId = newId();
      await create({ subjectId });
      await create({ subjectId });
      await withTx(h, (trx) => issueRememberToken(trx, { subjectId, mfaBound: true, now: NOW }));
      expect(await withTx(h, (trx) => revokeSubject(trx, subjectId))).toEqual({ sessions: 2, tokens: 1 });
      expect(await h.db.selectFrom('sessions').selectAll().execute()).toEqual([]);
      expect(await h.db.selectFrom('remember_tokens').selectAll().execute()).toEqual([]);
    });

    it("revokeSubject(…, {rememberOnly: 'mfa_unbound'}) deletes only mfa_bound = 0 tokens and the sessions they created", async () => {
      const subjectId = newId();
      const bind = (mfaBound: boolean) =>
        withTx(h, async (trx) => {
          const rm = await issueRememberToken(trx, { subjectId, mfaBound, now: NOW });
          const s = await createSession(trx, {
            subjectId,
            mfaPassed: true,
            authzVersion: 1,
            ip: null,
            userAgent: null,
            now: NOW,
            idleMs: IDLE,
            rememberSelector: rm.selector,
          });
          return { ...s, selector: rm.selector };
        });
      const unbound = await bind(false);
      const restoredUnbound = await create({ subjectId, rememberSelector: unbound.selector });
      const bound = await bind(true);
      const plain = await create({ subjectId });

      const result = await withTx(h, (trx) => revokeSubject(trx, subjectId, { rememberOnly: 'mfa_unbound' }));
      expect(result).toEqual({ sessions: 2, tokens: 1 });
      expect(await row(unbound.id)).toBeUndefined();
      expect(await row(restoredUnbound.id)).toBeUndefined();
      expect((await row(bound.id))?.remember_selector).toBe(bound.selector);
      expect(await row(plain.id)).toBeDefined();
      expect(await h.db.selectFrom('remember_tokens').select(['selector', 'mfa_bound']).execute()).toEqual([
        { selector: bound.selector, mfa_bound: 1 },
      ]);
    });
  });

  describe('listSessions', () => {
    it("lists the subject's live sessions, newest first", async () => {
      const subjectId = newId();
      const a = await create({ subjectId, now: NOW });
      const b = await create({ subjectId, now: NOW + 1000 });
      const c = await create({ subjectId, now: NOW + 2000 });
      await create({ subjectId, now: NOW - IDLE }); // already expired at NOW + 2000
      await create({ subjectId: newId(), now: NOW + 3000 });
      const list = await listSessions(h.db, subjectId, NOW + 2000);
      expect(list.map((s) => s.id)).toEqual([c.id, b.id, a.id]);
      expect(list[0]).toMatchObject({ subjectId, createdAt: NOW + 2000, mfaPassed: true });
    });
  });
});
