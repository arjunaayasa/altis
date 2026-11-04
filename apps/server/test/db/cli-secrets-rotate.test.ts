import fsp from 'node:fs/promises';
import path from 'node:path';
import { encodeBase64Url } from '@altis/crypto';
import {
  createJobRegistry,
  enqueue,
  hotp,
  openValue,
  randomToken,
  readSecret,
  rotateSecrets,
  secretAad,
  sealValue,
  totpStep,
  writeSettings,
  type KeyringEntry,
} from '@altis/core';
import { connect, withTx, type DbHandle } from '@altis/db';
import { beforeEach, describe, expect, it } from 'vitest';
import { engineLabel, testDb, testDbConfig, testDbContext } from '../../../../tools/test/test-db.js';
import { createApp } from '../../src/app.js';
import { runCli } from '../../src/cli/index.js';
import { loadConfig, updateConfig, type Config } from '../../src/config.js';
import { csrfKey, preSessionCsrfToken } from '../../src/http/csrf.js';
import { jobHandlers } from '../../src/jobs/runtime.js';
import { createAgent } from '../agent.js';
import { captureIo, writeInput } from '../cli-support.js';
import { bootContext, recordingLogger, useDataDir } from '../support.js';
import { seedStaff } from '../support-auth.js';

// `node app.js secrets:rotate [--json]` (spec §7.6, §13.6; decision C32; 1c Task 24) against the engine picked by
// ALTIS_TEST_DB: a new kid becomes the active key of config.json's keyring (the old kids stay, for backups of branch
// a), the CLI waits 5 s for every process's config fence, then every registered secret column (SECRET_COLUMNS:
// staff_users.totp_secret_enc, settings.value where is_secret = 1, jobs.secret_param) is re-sealed under the new kid
// with compare-and-set updates in key batches, and `system.secrets_rotate {kid, rows}` is audited (actor `cli`).

const engine = testDbContext();
const dirs = useDataDir();

const ADMIN = { username: 'admin', name: 'Admin', password: 'kuda-lumping-biru' };
const SMTP_PASSWORD = 'sandi-smtp-rahasia';
const JOB_SECRET = new Uint8Array([1, 2, 3, 4, 5]);
/** A run_at no runner reaches during the test. */
const FAR = 4_102_444_800_000;
const NEW_KID = /^k[0-9A-HJKMNP-TV-Z]{26}$/;

beforeEach(async () => {
  if (engine.available) await (await testDb()).close(); // empties the worker's database
  await fsp.mkdir(path.join(dirs.root, 'home'));
});

const env = () => ({ HOME: path.join(dirs.root, 'home') });

async function cli(argv: string[]) {
  const io = captureIo(env(), { hostPanels: () => [] });
  const code = await runCli(argv, bootContext(dirs.dataDir), io);
  return { code, io };
}

async function install(): Promise<Config> {
  const input = await writeInput(path.join(dirs.root, 'input'), { baseUrl: 'https://perpus.example', db: testDbConfig(), admin: ADMIN });
  const { code, io } = await cli(['install', '--config', input]);
  if (code !== 0) throw new Error(`install failed: ${io.err}`);
  return (await loadConfig(dirs.dataDir, {}))!;
}

function open(): Promise<DbHandle> {
  return connect(testDbConfig(), { runtime: 'standalone', purpose: 'cli', dataDir: dirs.dataDir });
}

/** A TOTP user, the SMTP password and a queued job with a secret, all sealed with `keyring`. */
async function seedSecrets(h: DbHandle, keyring: readonly KeyringEntry[]) {
  const user = await seedStaff(h, { username: 'budi', totp: true, keyring });
  await withTx(h, (trx) => writeSettings(trx, { 'smtp.password': SMTP_PASSWORD }, { keyring, now: Date.now(), actorId: null }));
  const registry = createJobRegistry(jobHandlers());
  const job = await withTx(h, (trx) =>
    enqueue(trx, registry, { type: 'test.slices', payload: { slices: 1, k: 1 }, secret: JOB_SECRET, runAt: FAR }, { now: Date.now(), keyring }),
  );
  return { user, jobId: job.id };
}

/** Every registered secret value in the database. */
async function secretValues(h: DbHandle): Promise<string[]> {
  const totp = await h.db.selectFrom('staff_users').select('totp_secret_enc').where('totp_secret_enc', 'is not', null).execute();
  const settings = await h.db.selectFrom('settings').select('value').where('is_secret', '=', 1).where('value', 'is not', null).execute();
  const jobs = await h.db.selectFrom('jobs').select('secret_param').where('secret_param', 'is not', null).execute();
  return [...totp.map((r) => r.totp_secret_enc!), ...settings.map((r) => r.value!), ...jobs.map((r) => r.secret_param!)];
}

async function rotateAudits(h: DbHandle) {
  const rows = await h.db.selectFrom('audit_log').select(['actor_type', 'actor_id', 'meta']).where('action', '=', 'system.secrets_rotate').execute();
  return rows.map((r) => ({ ...r, meta: JSON.parse(r.meta) as Record<string, unknown> }));
}

/** Signs `user` in with the password and the TOTP code of now, through the app on `config` (spec §7.1). */
async function totpLogin(h: DbHandle, config: Config, user: { username: string; password: string; totpSecret: Uint8Array }) {
  const app = createApp({
    state: { phase: 'ready', db: h, config },
    version: '0.1.0',
    buildId: 'b',
    log: recordingLogger(),
  });
  const agent = createAgent(app, { peer: '203.0.113.9' });
  const cookie = randomToken(32);
  agent.setCookie('__Host-altis_csrf', cookie);
  let csrf = preSessionCsrfToken(csrfKey(config), cookie);
  const send = async (p: string, body: unknown) => {
    const res = await agent.post(p, body, { 'x-csrf-token': csrf });
    csrf = res.headers.get('x-csrf-token') ?? csrf;
    return res;
  };
  const login = await send('/api/v1/auth/login', { username: user.username, password: user.password });
  expect(login.status).toBe(200);
  expect(login.json).toMatchObject({ stage: 'mfa' });
  const verify = await send('/api/v1/auth/2fa/verify', { code: hotp(user.totpSecret, totpStep(Date.now()), 6) });
  expect(verify.status).toBe(200);
  expect(verify.json).toMatchObject({ stage: 'full' });
}

describe.skipIf(!engine.available)(`secrets:rotate [${engineLabel()}]`, () => {
  it('adds an active kid (the old one kept), waits for the fences, re-seals every secret column, audits once; logins still work', async () => {
    const config = await install();
    const [old] = config.keyring;
    expect(config.keyring).toHaveLength(1);
    const h = await open();
    try {
      const { user, jobId } = await seedSecrets(h, config.keyring);
      expect((await secretValues(h)).map((v) => v.split(':')[1])).toEqual([old!.kid, old!.kid, old!.kid]);

      const started = performance.now();
      const { code, io } = await cli(['secrets:rotate', '--json']);
      expect(io.err).toBe('');
      expect(code).toBe(0);
      expect(performance.now() - started).toBeGreaterThanOrEqual(5000); // the fences' settle time (C32)
      const out = JSON.parse(io.out) as { ok: boolean; command: string; kid: string; rows: number };
      expect(out).toEqual({ ok: true, command: 'secrets:rotate', kid: expect.stringMatching(NEW_KID), rows: 3 });

      const after = (await loadConfig(dirs.dataDir, {}))!;
      expect(after.keyring).toEqual([
        { ...old, active: false },
        { kid: out.kid, key: expect.any(String), active: true },
      ]);
      expect(Buffer.from(after.keyring[1]!.key, 'base64url')).toHaveLength(32);

      const values = await secretValues(h);
      expect(values).toHaveLength(3);
      for (const value of values) expect(value.startsWith(`v1:${out.kid}:`)).toBe(true);
      expect(await readSecret(h.db, 'smtp.password', after.keyring)).toBe(SMTP_PASSWORD);
      const job = await h.db.selectFrom('jobs').select('secret_param').where('id', '=', jobId).executeTakeFirstOrThrow();
      expect(openValue(after.keyring, secretAad('jobs', 'secret_param', jobId), job.secret_param!)).toBe(encodeBase64Url(JOB_SECRET));
      await totpLogin(h, after, { username: 'budi', password: user.password, totpSecret: user.totpSecret! });

      expect(await rotateAudits(h)).toEqual([{ actor_type: 'cli', actor_id: null, meta: { kid: out.kid, rows: 3 } }]);
    } finally {
      await h.close();
    }
  }, 60_000);

  it('rotateSecrets: a value that does not open is left alone; values of any older kid are re-sealed; the human line', async () => {
    const config = await install();
    const h = await open();
    try {
      await seedSecrets(h, config.keyring);
      // A TOTP secret sealed under a kid this keyring never had (another installation's): it cannot be re-sealed.
      const stranger: KeyringEntry[] = [{ kid: 'elsewhere', key: Buffer.alloc(32, 9).toString('base64url'), active: true }];
      const lost = await seedStaff(h, { username: 'sari', totp: true, keyring: stranger });
      const lostValue = (await h.db.selectFrom('staff_users').select('totp_secret_enc').where('id', '=', lost.id).executeTakeFirstOrThrow()).totp_secret_enc!;

      const log = recordingLogger();
      const updateKeyring = (mutate: (keyring: readonly KeyringEntry[]) => KeyringEntry[]) =>
        updateConfig(dirs.dataDir, (cfg) => {
          cfg.keyring = mutate(cfg.keyring);
        }).then((c) => c.keyring);
      const first = await rotateSecrets(h, { dataDir: dirs.dataDir, now: () => Date.now(), log, settleMs: 0, updateKeyring });
      expect(first).toEqual({ kid: expect.stringMatching(NEW_KID), rows: 3 });
      expect(log.lines.filter((l) => l.level === 'warn')).toEqual([
        expect.objectContaining({ fields: expect.objectContaining({ table: 'staff_users', column: 'totp_secret_enc', code: 'SECRET_UNREADABLE' }) }),
      ]);
      expect((await h.db.selectFrom('staff_users').select('totp_secret_enc').where('id', '=', lost.id).executeTakeFirstOrThrow()).totp_secret_enc).toBe(lostValue);

      // A value sealed by a process that still had the previous key (before its fence looked) is picked up next time.
      const keyring = (await loadConfig(dirs.dataDir, {}))!.keyring;
      const previous = keyring.map((e) => ({ ...e, active: e.kid === config.keyring[0]!.kid }));
      await h.db
        .updateTable('settings')
        .set({ value: sealValue(previous, secretAad('settings', 'value', 'smtp.password'), SMTP_PASSWORD) })
        .where('key', '=', 'smtp.password')
        .execute();

      const { code, io } = await cli(['secrets:rotate']);
      expect(code).toBe(0);
      expect(io.out).toMatch(/^secrets:rotate: k[0-9A-Z]{26} /);
      const latest = (await loadConfig(dirs.dataDir, {}))!.keyring;
      expect(latest.map((e) => e.active)).toEqual([false, false, true]);
      expect(await readSecret(h.db, 'smtp.password', latest)).toBe(SMTP_PASSWORD);
      const audits = await rotateAudits(h);
      expect(audits).toHaveLength(2);
      expect(audits[1]!.meta).toEqual({ kid: latest[2]!.kid, rows: 3 });
    } finally {
      await h.close();
    }
  }, 60_000);

  it('before the install: exit 1, NOT_INSTALLED', async () => {
    const { code, io } = await cli(['secrets:rotate']);
    expect(code).toBe(1);
    expect(io.err).toMatch(/NOT_INSTALLED/);
  });
});
