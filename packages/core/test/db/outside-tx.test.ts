import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PHASE1_MIGRATIONS, assertOutsideTx, runMigrations, withTx } from '@altis/db';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { restoreRememberedSession, useRememberToken } from '../../src/auth/remember.js';
import { runnerFor } from '../../src/context.js';
import { createPasswordHasher, type ScryptFn } from '../../src/crypto/password.js';
import { purgeVolatile } from '../../src/housekeeping/volatile.js';
import { sweepVolatile } from '../../src/maintenance/sweep.js';

// S18 / R49 enforced, not only documented (final review T3/T10): the functions that must never run inside a withTx
// callback refuse it with a TypeError, through @altis/db's assertOutsideTx. Inside a transaction the hasher would hold
// the SQLite connection (the process's only one) for the scrypt and its queue wait; a remember-me use would deadlock
// SQLite (its statements go to the handle while BEGIN IMMEDIATE holds the connection) and misjudge a grace as a reuse
// on MariaDB REPEATABLE READ; the sweep opens transactions of its own. On the engine picked by ALTIS_TEST_DB.

const ctx = testDbContext();
const NOW = 1_767_225_600_000;
const KEY = new Uint8Array(32).fill(0x5a);
const COOKIE = `${'s'.repeat(24)}.${'v'.repeat(43)}`;

describe.skipIf(!ctx.available)(`outside any transaction (S18, R49) [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let dataDir: string;

  beforeAll(async () => {
    h = await testDb();
    dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-core-outside-tx-'));
    await runMigrations(h, { appVersion: '0.1.0', dataDir, migrations: PHASE1_MIGRATIONS });
  });

  afterAll(async () => {
    await h?.close();
    if (dataDir !== undefined) await fsp.rm(dataDir, { recursive: true, force: true });
  });

  it('@altis/db exports assertOutsideTx: a TypeError inside a withTx callback naming the caller, nothing outside', async () => {
    expect(() => assertOutsideTx('outside')).not.toThrow();
    await expect(withTx(h, async () => assertOutsideTx('inside'))).rejects.toThrow(/^inside\(\)/);
    await expect(withTx(h, async () => assertOutsideTx('inside'))).rejects.toThrow(TypeError);
  });

  it('the password hasher: hash, verify and verifyDummy refuse to run in a transaction (no scrypt runs)', async () => {
    const scrypt = vi.fn<ScryptFn>(async (_pw, _salt, keylen) => Buffer.alloc(keylen, 1));
    const hasher = createPasswordHasher({ scrypt });
    const phc = await hasher.hash('kuda-lumping-biru');
    expect(scrypt).toHaveBeenCalledTimes(1);
    const calls: [string, () => Promise<unknown>][] = [
      ['hash', () => hasher.hash('kuda-lumping-biru')],
      ['verify', () => hasher.verify('kuda-lumping-biru', phc)],
      ['verifyDummy', () => hasher.verifyDummy('kuda-lumping-biru')],
    ];
    for (const [name, call] of calls) {
      await expect(withTx(h, () => call()), name).rejects.toThrow(TypeError);
      await expect(withTx(h, () => call()), name).rejects.toThrow(new RegExp(`PasswordHasher\\.${name}\\(\\)`));
    }
    expect(scrypt).toHaveBeenCalledTimes(1);
    expect(await hasher.verify('kuda-lumping-biru', phc)).toBe(true);
  });

  it('the remember-me use and restore refuse to run in a transaction', async () => {
    await expect(withTx(h, () => useRememberToken(h, COOKIE, NOW, KEY))).rejects.toThrow(/^useRememberToken\(\)/);
    const restore = () =>
      restoreRememberedSession(runnerFor(h, NOW, { type: 'anonymous', id: null, ip: null }), h, {
        cookie: COOKIE,
        now: NOW,
        sessionKey: KEY,
        ip: null,
        userAgent: null,
        idleMs: 1_800_000,
      });
    await expect(withTx(h, () => restore())).rejects.toThrow(/^restoreRememberedSession\(\)/);
    // Outside, an unknown cookie is simply invalid.
    expect(await useRememberToken(h, COOKIE, NOW, KEY)).toEqual({ kind: 'invalid' });
    expect(await restore()).toEqual({ kind: 'invalid' });
  });

  it('the sweep: sweepVolatile and the scheduled purgeVolatile (1c Task 18) refuse to be started in a transaction', async () => {
    await expect(withTx(h, () => sweepVolatile(h, NOW))).rejects.toThrow(/^sweepVolatile\(\)/);
    await expect(withTx(h, () => purgeVolatile(h, { now: NOW, dataDir }))).rejects.toThrow(/^purgeVolatile\(\)/);
  });
});
