import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PHASE1_MIGRATIONS, runMigrations, withTx } from '@altis/db';
import { newId } from '@altis/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import {
  REMEMBER_GRACE_MS,
  REMEMBER_MS,
  issueRememberToken,
  rememberSessionToken,
  restoreRememberedSession,
  useRememberToken,
  type RememberOutcome,
} from '../../src/auth/remember.js';
import { createSession, revokeSubject } from '../../src/auth/sessions.js';
import { runnerFor, type TxRunner } from '../../src/context.js';
import { hmacB64u, randomToken, sha256hex } from '../../src/crypto/tokens.js';

// Remember-me tokens (spec §7.1): `<selector>.<validator>`, the database keeping the SHA-256 of the validator only.
// Every use rotates the validator; for 30 s the previous validator answers with the same session (derived from the
// current validator hash, D12) without a new token; any other reuse is theft, which the caller answers by revoking
// the subject. On the engine picked by ALTIS_TEST_DB.

const ctx = testDbContext();
const NOW = 1_767_225_600_000;
const KEY = new Uint8Array(32).fill(0x5a);

/** The outcome when it is of `kind`; a test failure otherwise. */
function expectKind<K extends RememberOutcome['kind']>(o: RememberOutcome, kind: K): Extract<RememberOutcome, { kind: K }> {
  if (o.kind !== kind) return expect.fail(`expected ${kind}, got ${JSON.stringify(o)}`);
  return o as Extract<RememberOutcome, { kind: K }>;
}

describe.skipIf(!ctx.available)(`remember-me tokens [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let dataDir: string;

  beforeAll(async () => {
    h = await testDb();
    dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-core-remember-'));
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

  const issue = (subjectId = newId(), mfaBound = false, now = NOW) =>
    withTx(h, (trx) => issueRememberToken(trx, { subjectId, mfaBound, now }));
  const tokenRow = (selector: string) =>
    h.db.selectFrom('remember_tokens').selectAll().where('selector', '=', selector).executeTakeFirstOrThrow();

  it('issues <selector>.<validator> with a 24-character selector, storing only the validator hash', async () => {
    const subjectId = newId();
    const { cookie, selector } = await issue(subjectId, true);
    const [sel, validator] = cookie.split('.');
    expect(sel).toBe(selector);
    expect(selector).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(validator).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const row = await tokenRow(selector);
    expect(row).toEqual({
      selector,
      validator_hash: sha256hex(validator!),
      prev_validator_hash: null,
      rotated_at: null,
      subject_type: 'staff',
      subject_id: subjectId,
      expires_at: NOW + REMEMBER_MS,
      mfa_bound: 1,
      last_used_at: null,
    });
    expect(REMEMBER_MS).toBe(30 * 86_400_000);
    expect(JSON.stringify(row)).not.toContain(validator);
  });

  it('rememberSessionToken is the HMAC of rm-session:<selector>:<validator hash> under the decoded key (D12, D45)', () => {
    const vh = sha256hex('v');
    expect(rememberSessionToken(KEY, 'sel', vh)).toBe(hmacB64u(KEY, `rm-session:sel:${vh}`, 32));
    expect(rememberSessionToken(KEY, 'sel', vh)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('first use → rotated: a new validator, and the old one no longer equals validator_hash', async () => {
    const subjectId = newId();
    const { cookie, selector } = await issue(subjectId);
    const oldVh = sha256hex(cookie.split('.')[1]!);
    const at = NOW + 1000;
    const r = expectKind(await useRememberToken(h, cookie, at, KEY), 'rotated');
    expect(r.subjectId).toBe(subjectId);
    expect(r.mfaBound).toBe(false);
    expect(r.selector).toBe(selector);
    const [sel, newValidator] = r.cookie.split('.');
    expect(sel).toBe(selector);
    expect(newValidator).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(r.cookie).not.toBe(cookie);
    const row = await tokenRow(selector);
    expect(row.validator_hash).toBe(sha256hex(newValidator!));
    expect(row.validator_hash).not.toBe(oldVh);
    expect(row).toMatchObject({ prev_validator_hash: oldVh, rotated_at: at, last_used_at: at, expires_at: NOW + REMEMBER_MS });
    expect(r.sessionToken).toBe(rememberSessionToken(KEY, selector, row.validator_hash));
  });

  it('the same old cookie 10 s later → grace with the same session token; 31 s later → reuse', async () => {
    const subjectId = newId();
    const { cookie, selector } = await issue(subjectId, true);
    const rotated = expectKind(await useRememberToken(h, cookie, NOW, KEY), 'rotated');
    expect(REMEMBER_GRACE_MS).toBe(30_000);

    const grace = expectKind(await useRememberToken(h, cookie, NOW + 10_000, KEY), 'grace');
    expect(grace).toEqual({ kind: 'grace', subjectId, mfaBound: true, selector, sessionToken: rotated.sessionToken });
    expect(expectKind(await useRememberToken(h, cookie, NOW + 30_000, KEY), 'grace').sessionToken).toBe(rotated.sessionToken);
    // the grace path issues nothing: the row is as the rotation left it
    expect((await tokenRow(selector)).validator_hash).toBe(sha256hex(rotated.cookie.split('.')[1]!));

    expect(await useRememberToken(h, cookie, NOW + 31_000, KEY)).toEqual({ kind: 'reuse', subjectId });
    // the rotated cookie still works (revoking is the caller's job)
    expectKind(await useRememberToken(h, rotated.cookie, NOW + 31_000, KEY), 'rotated');
  });

  it('a validator two rotations old → reuse, even inside 30 s', async () => {
    const subjectId = newId();
    const { cookie } = await issue(subjectId);
    const first = expectKind(await useRememberToken(h, cookie, NOW, KEY), 'rotated');
    expectKind(await useRememberToken(h, first.cookie, NOW + 1000, KEY), 'rotated');
    expect(await useRememberToken(h, cookie, NOW + 2000, KEY)).toEqual({ kind: 'reuse', subjectId });
  });

  it('two uses started together with one cookie → one rotated and one grace, with equal sessionToken (B5)', async () => {
    const subjectId = newId();
    const { cookie, selector } = await issue(subjectId);
    // On SQLite the two calls serialize on the process's one connection, which gives the same outcome.
    const outcomes = await Promise.all([useRememberToken(h, cookie, NOW, KEY), useRememberToken(h, cookie, NOW, KEY)]);
    expect(outcomes.map((o) => o.kind).sort()).toEqual(['grace', 'rotated']);
    const rotated = expectKind(outcomes.find((o) => o.kind === 'rotated')!, 'rotated');
    const grace = expectKind(outcomes.find((o) => o.kind === 'grace')!, 'grace');
    expect(grace.sessionToken).toBe(rotated.sessionToken);
    expect(grace.selector).toBe(selector);

    // both requests then open the same session: createSession with one given token keeps one row
    for (const o of outcomes) {
      const token = expectKind(o, o.kind as 'rotated' | 'grace').sessionToken;
      await withTx(h, (trx) =>
        createSession(trx, {
          subjectId,
          mfaPassed: true,
          authzVersion: 1,
          ip: null,
          userAgent: null,
          now: NOW,
          idleMs: 30 * 60_000,
          rememberSelector: selector,
          reauthAt: null,
          token,
        }),
      );
    }
    expect(await h.db.selectFrom('sessions').select('id').execute()).toEqual([{ id: sha256hex(rotated.sessionToken) }]);
  });

  it('an expired token → invalid', async () => {
    const { cookie } = await issue();
    expect(await useRememberToken(h, cookie, NOW + REMEMBER_MS - 1, KEY)).toMatchObject({ kind: 'rotated' });
    const { cookie: other } = await issue();
    expect(await useRememberToken(h, other, NOW + REMEMBER_MS, KEY)).toEqual({ kind: 'invalid' });
  });

  it('an unknown selector or a bad format → invalid', async () => {
    const { cookie, selector } = await issue();
    const validator = cookie.split('.')[1]!;
    for (const bad of [
      '',
      'x',
      selector,
      `${selector}.`,
      `.${validator}`,
      `${selector}.${validator}.x`,
      `${selector.slice(1)}.${validator}`,
      `${selector}.${validator.slice(1)}`,
      `${selector}.${validator.slice(1)}=`,
      `${randomToken(18)}.${validator}`,
      ` ${cookie}`,
    ]) {
      expect(await useRememberToken(h, bad, NOW, KEY), JSON.stringify(bad)).toEqual({ kind: 'invalid' });
    }
    // nothing above touched the row
    expect(await tokenRow(selector)).toMatchObject({ validator_hash: sha256hex(validator), rotated_at: null });
  });

  it('a wrong validator for a known selector is reuse', async () => {
    const subjectId = newId();
    const { selector } = await issue(subjectId);
    expect(await useRememberToken(h, `${selector}.${randomToken(32)}`, NOW, KEY)).toEqual({ kind: 'reuse', subjectId });
  });

  describe('restoreRememberedSession (Task 17)', () => {
    async function seedUser(): Promise<string> {
      const id = newId();
      await h.db
        .insertInto('staff_users')
        .values({
          id,
          username_key: `U${id}`,
          username_display: `u${id}`,
          name: 'Staf Uji',
          password_hash: '$scrypt$test',
          status: 'active',
          created_at: NOW,
          updated_at: NOW,
        })
        .execute();
      return id;
    }

    const input = (cookie: string, now = NOW) => ({ cookie, now, sessionKey: KEY, ip: '203.0.113.9', userAgent: 'UA', idleMs: 30 * 60_000 });

    it('rotated → the session of the token (D12), 2FA passed, no reauth_at, the selector recorded; grace → the same session', async () => {
      const userId = await seedUser();
      const { cookie, selector } = await issue(userId);
      const run = runnerFor(h, NOW, { type: 'anonymous', id: null, ip: null });
      const first = await restoreRememberedSession(run, h, input(cookie));
      if (first.kind !== 'restored') return expect.fail(JSON.stringify(first));
      expect(first.cookie).not.toBeNull();
      expect(first.session.token).toBe(rememberSessionToken(KEY, selector, sha256hex(first.cookie!.split('.')[1]!)));
      expect(first.view).toMatchObject({ subjectId: userId, mfaPassed: true, reauthAt: null, rememberSelector: selector, ip: '203.0.113.9' });
      expect(first.user.id).toBe(userId);

      const again = await restoreRememberedSession(run, h, input(cookie, NOW + REMEMBER_GRACE_MS));
      if (again.kind !== 'restored') return expect.fail(JSON.stringify(again));
      expect(again.cookie).toBeNull();
      expect(again.session).toEqual(first.session);
      expect(await h.db.selectFrom('sessions').select('id').execute()).toEqual([{ id: first.session.id }]);
    });

    it('a token revoked between its use and the restore transaction (the lock, then the re-read) → invalid, no session', async () => {
      const userId = await seedUser();
      const { cookie } = await issue(userId);
      const inner = runnerFor(h, NOW, { type: 'anonymous', id: null, ip: null });
      let calls = 0;
      // A password change that commits right after useRememberToken rotated the token.
      const run: TxRunner = async (fn, o) => {
        calls += 1;
        await withTx(h, (trx) => revokeSubject(trx, userId));
        return inner(fn, o);
      };
      expect(await restoreRememberedSession(run, h, input(cookie))).toEqual({ kind: 'invalid' });
      expect(calls).toBe(1);
      expect(await h.db.selectFrom('sessions').select('id').execute()).toEqual([]);
      expect(await h.db.selectFrom('remember_tokens').select('selector').execute()).toEqual([]);
    });
  });
});
