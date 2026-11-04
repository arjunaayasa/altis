import fsp from 'node:fs/promises';
import path from 'node:path';
import { createPasswordHasher, createSession } from '@altis/core';
import { withTx } from '@altis/db';
import { newId } from '@altis/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli/index.js';
import { captureIo, openInstalled, writeInput, type CapturedIo } from './cli-support.js';
import { bootContext, useDataDir } from './support.js';

// `node app.js user:reset-password <username>` and `user:disable-2fa <username>` (Task 24, spec §7.1 "Pemulihan darurat
// lewat CLI"), on SQLite in a temp DATA_DIR installed by the headless install. They reuse the users services of Task 19
// with the `{cli: true}` actor (D44): the same effects as the admin routes, audited with actor type `cli`.

const dirs = useDataDir();
const ADMIN = { username: 'admin', name: 'Admin', password: 'kuda-lumping-biru' };
/** The temporary password format of Task 5: four groups of four lower-case Crockford characters. */
const TEMPORARY = /^[0-9a-hjkmnp-tv-z]{4}(-[0-9a-hjkmnp-tv-z]{4}){3}$/;

let env: Record<string, string>;

beforeEach(async () => {
  const home = path.join(dirs.root, 'home');
  await fsp.mkdir(home);
  env = { HOME: home };
});

async function cli(argv: string[]): Promise<{ code: number; io: CapturedIo }> {
  const io = captureIo(env, { hostPanels: () => [] });
  const code = await runCli(argv, bootContext(dirs.dataDir), io);
  return { code, io };
}

async function installed(): Promise<void> {
  const file = await writeInput(path.join(dirs.root, 'input'), { baseUrl: 'https://perpus.example', db: { dialect: 'sqlite' }, admin: ADMIN });
  const { code, io } = await cli(['install', '--config', file]);
  expect(io.err).toBe('');
  expect(code).toBe(0);
}

/** The admin's row, the live sessions of the admin, and the audit entries, read from DATA_DIR's database. */
async function state() {
  const h = await openInstalled(dirs.dataDir);
  try {
    const user = await h.db.selectFrom('staff_users').selectAll().where('username_key', '=', 'ADMIN').executeTakeFirstOrThrow();
    return {
      user,
      sessions: await h.db.selectFrom('sessions').select('id').where('subject_id', '=', user.id).execute(),
      recovery: await h.db.selectFrom('staff_recovery_codes').select('id').where('user_id', '=', user.id).execute(),
      audit: await h.db.selectFrom('audit_log').select(['action', 'actor_type', 'actor_id', 'entity_id', 'meta']).orderBy('seq').execute(),
    };
  } finally {
    await h.close();
  }
}

/** Gives the admin a live session (and, with `totp`, an enrolled 2FA with one recovery code). */
async function signedIn(o: { totp?: boolean } = {}): Promise<void> {
  const h = await openInstalled(dirs.dataDir);
  try {
    await withTx(h, async (trx) => {
      const user = await trx.selectFrom('staff_users').select('id').where('username_key', '=', 'ADMIN').executeTakeFirstOrThrow();
      await createSession(trx, { subjectId: user.id, mfaPassed: true, authzVersion: 1, ip: null, userAgent: null, now: Date.now(), idleMs: 60_000 });
      if (o.totp === true) {
        await trx
          .updateTable('staff_users')
          .set({ totp_enabled: 1, totp_secret_enc: 'v1:k1:iv:ct', totp_last_step: 42 })
          .where('id', '=', user.id)
          .execute();
        await trx
          .insertInto('staff_recovery_codes')
          .values({ id: newId(), user_id: user.id, code_hash: 'a'.repeat(64), used_at: null, created_at: Date.now() })
          .execute();
      }
    });
  } finally {
    await h.close();
  }
}

describe('user:reset-password', () => {
  it('--json prints the temporary password once; the old password stops working, a change is forced, sessions end', async () => {
    await installed();
    await signedIn();
    const before = await state();
    expect(before.sessions).toHaveLength(1);

    const { code, io } = await cli(['user:reset-password', 'admin', '--json']);
    expect(io.err).toBe('');
    expect(code).toBe(0);
    expect(io.out.trim().split('\n')).toHaveLength(1);
    const out = JSON.parse(io.out) as { ok: boolean; command: string; temporaryPassword: string };
    expect(out).toEqual({ ok: true, command: 'user:reset-password', temporaryPassword: expect.stringMatching(TEMPORARY) });

    const after = await state();
    const hasher = createPasswordHasher();
    expect(await hasher.verify(ADMIN.password, after.user.password_hash)).toBe(false);
    expect(await hasher.verify(out.temporaryPassword, after.user.password_hash)).toBe(true);
    expect(after.user.must_change_password).toBe(1);
    expect(after.user.version).toBe(before.user.version + 1);
    expect(after.sessions).toEqual([]);
    const reset = after.audit.filter((a) => a.action === 'users.password.reset');
    expect(reset).toEqual([expect.objectContaining({ actor_type: 'cli', actor_id: null, entity_id: after.user.id })]);
    expect(JSON.stringify(after.audit)).not.toContain(out.temporaryPassword);
  });

  it('finds the user by the normalized username (case, full-width, spaces) and prints the password for humans', async () => {
    await installed();
    const { code, io } = await cli(['user:reset-password', ' ＡＤＭＩＮ ']);
    expect(io.err).toBe('');
    expect(code).toBe(0);
    const shown = new RegExp(TEMPORARY.source.slice(1, -1)).exec(io.out);
    expect(shown).not.toBeNull();
    expect(io.out).toMatch(/Kata sandi sementara/);
    expect(io.out).toMatch(/Temporary password/);
    expect(await createPasswordHasher().verify(shown![0], (await state()).user.password_hash)).toBe(true);
  });

  it('an unknown username: exit 1, NOT_FOUND, nothing changed', async () => {
    await installed();
    const before = await state();
    const { code, io } = await cli(['user:reset-password', 'nobody']);
    expect(code).toBe(1);
    expect(io.err).toMatch(/NOT_FOUND/);
    const json = await cli(['user:reset-password', 'nobody', '--json']);
    expect(json.code).toBe(1);
    expect(JSON.parse(json.io.out)).toMatchObject({ ok: false, command: 'user:reset-password', code: 'NOT_FOUND' });
    // A name whose key could never fit the column is just as unknown.
    expect((await cli(['user:reset-password', 'ΐ'.repeat(64)])).io.err).toMatch(/NOT_FOUND/);
    expect((await state()).user.password_hash).toBe(before.user.password_hash);
  });

  it('before install: exit 1, NOT_INSTALLED', async () => {
    const { code, io } = await cli(['user:reset-password', 'admin']);
    expect(code).toBe(1);
    expect(io.err).toMatch(/NOT_INSTALLED/);
  });

  it('usage: exactly one username', async () => {
    for (const argv of [['user:reset-password'], ['user:reset-password', 'a', 'b'], ['user:reset-password', 'admin', '--force']]) {
      const { code, io } = await cli(argv);
      expect(code).toBe(1);
      expect(io.err).toMatch(/USAGE/);
      expect(io.err).toMatch(/user:reset-password <username>/);
    }
  });
});

describe('user:disable-2fa', () => {
  it('turns 2FA off: no secret, totp_enabled 0, recovery codes gone, sessions end, users.2fa.reset by the cli', async () => {
    await installed();
    await signedIn({ totp: true });
    const before = await state();
    expect(before.user.totp_enabled).toBe(1);

    const { code, io } = await cli(['user:disable-2fa', 'admin']);
    expect(io.err).toBe('');
    expect(code).toBe(0);
    expect(io.out).toMatch(/2FA/);

    const after = await state();
    expect(after.user).toMatchObject({ totp_enabled: 0, totp_secret_enc: null, totp_reenroll: 0, totp_last_step: 0 });
    expect(after.recovery).toEqual([]);
    expect(after.sessions).toEqual([]);
    expect(after.audit.filter((a) => a.action === 'users.2fa.reset')).toEqual([
      expect.objectContaining({ actor_type: 'cli', actor_id: null, entity_id: after.user.id }),
    ]);

    const json = await cli(['user:disable-2fa', 'admin', '--json']);
    expect(json.code).toBe(0);
    expect(JSON.parse(json.io.out)).toEqual({ ok: true, command: 'user:disable-2fa' });
  });

  it('an unknown username: exit 1, NOT_FOUND', async () => {
    await installed();
    const { code, io } = await cli(['user:disable-2fa', 'nobody', '--json']);
    expect(code).toBe(1);
    expect(JSON.parse(io.out)).toMatchObject({ ok: false, command: 'user:disable-2fa', code: 'NOT_FOUND' });
  });
});
