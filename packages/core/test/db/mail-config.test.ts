import { randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PHASE1_MIGRATIONS, runMigrations, withTx } from '@altis/db';
import { isDomainError } from '@altis/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import type { KeyringEntry } from '../../src/crypto/secret-box.js';
import { createSmtpMailer, loadSmtpConfig } from '../../src/mail/smtp.js';
import type { SettingKey } from '../../src/settings/registry.js';
import { writeSettings } from '../../src/settings/service.js';
import { startFakeSmtp } from '../fake-smtp.js';

// loadSmtpConfig (Task 9): the SMTP configuration as the settings hold it. On the engine picked by ALTIS_TEST_DB.

const ctx = testDbContext();
const NOW = 1_767_225_600_000;
const keyring: KeyringEntry[] = [{ kid: 'k1', key: randomBytes(32).toString('base64url'), active: true }];
const otherKeyring: KeyringEntry[] = [{ kid: 'k2', key: randomBytes(32).toString('base64url'), active: true }];

describe.skipIf(!ctx.available)(`loadSmtpConfig [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let dataDir: string;

  beforeAll(async () => {
    h = await testDb();
    dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-core-mail-'));
    await runMigrations(h, { appVersion: '0.1.0', dataDir, migrations: PHASE1_MIGRATIONS });
  });

  afterAll(async () => {
    await h?.close();
    if (dataDir !== undefined) await fsp.rm(dataDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await h.db.deleteFrom('settings').execute();
  });

  const write = (patch: Partial<Record<SettingKey, unknown>>, ring: KeyringEntry[] = keyring) =>
    withTx(h, (trx) => writeSettings(trx, patch, { keyring: ring, now: NOW, actorId: null }));

  it('is null while the SMTP host is not set, and while the sender address is not set', async () => {
    expect(await loadSmtpConfig(h.db, keyring)).toBeNull();
    await write({ 'smtp.host': 'smtp.perpus.test' });
    expect(await loadSmtpConfig(h.db, keyring)).toBeNull();
    await write({ 'smtp.host': null, 'smtp.from': 'noreply@perpus.test' });
    expect(await loadSmtpConfig(h.db, keyring)).toBeNull();
  });

  it('reads the defaults for what is not set: port 587, STARTTLS, no login, the library name as sender name', async () => {
    await write({ 'smtp.host': 'smtp.perpus.test', 'smtp.from': 'noreply@perpus.test', 'library.name': 'Perpustakaan Pelita' });
    expect(await loadSmtpConfig(h.db, keyring)).toEqual({
      host: 'smtp.perpus.test',
      port: 587,
      security: 'starttls',
      username: null,
      password: null,
      from: 'noreply@perpus.test',
      senderName: 'Perpustakaan Pelita',
    });
  });

  it('reads every saved value, and opens the password with the keyring', async () => {
    await write({
      'smtp.host': 'smtp.perpus.test',
      'smtp.port': 465,
      'smtp.security': 'tls',
      'smtp.username': 'mailer',
      'smtp.password': ' rahasia:@ ',
      'smtp.from': 'noreply@perpus.test',
      'email.sender_name': 'Perpus Pelita',
      'library.name': 'Perpustakaan Pelita',
    });
    expect(await loadSmtpConfig(h.db, keyring)).toEqual({
      host: 'smtp.perpus.test',
      port: 465,
      security: 'tls',
      username: 'mailer',
      password: ' rahasia:@ ',
      from: 'noreply@perpus.test',
      senderName: 'Perpus Pelita', // email.sender_name wins over library.name
    });
  });

  it('a blank sender name is the library name', async () => {
    await write({ 'smtp.host': 'h.test', 'smtp.from': 'a@b.test', 'library.name': 'Perpus A', 'email.sender_name': '  ' });
    expect((await loadSmtpConfig(h.db, keyring))?.senderName).toBe('Perpus A');
  });

  it('keeps the password only while host, port and username stay (purpose-bound, §7.6)', async () => {
    await write({ 'smtp.host': 'smtp.perpus.test', 'smtp.username': 'mailer', 'smtp.password': 'rahasia', 'smtp.from': 'a@b.test' });
    expect((await loadSmtpConfig(h.db, keyring))?.password).toBe('rahasia');
    await write({ 'smtp.host': 'smtp.other.test' });
    expect((await loadSmtpConfig(h.db, keyring))?.password).toBeNull();
  });

  it('opens the password only for a login: without a username it is neither read nor a reason to fail', async () => {
    await write({ 'smtp.host': 'smtp.perpus.test', 'smtp.password': 'rahasia', 'smtp.from': 'a@b.test' });
    expect((await loadSmtpConfig(h.db, keyring))?.password).toBeNull();
    // A keyring that does not open it (a database restored without its keys): the mail goes out all the same.
    expect(await loadSmtpConfig(h.db, otherKeyring)).toMatchObject({ host: 'smtp.perpus.test', username: null, password: null });
  });

  it('a password that does not open with the keyring is SECRET_UNREADABLE, never the value', async () => {
    await write({ 'smtp.host': 'smtp.perpus.test', 'smtp.username': 'mailer', 'smtp.password': 'sandi-unik-7731', 'smtp.from': 'a@b.test' });
    const error = await loadSmtpConfig(h.db, otherKeyring).catch((e: unknown) => e);
    expect(isDomainError(error) && error.code).toBe('SECRET_UNREADABLE');
    expect(JSON.stringify([(error as Error).message, (error as { meta?: unknown }).meta])).not.toContain('sandi-unik-7731');
  });

  it('reads inside a transaction', async () => {
    await write({ 'smtp.host': 'smtp.perpus.test', 'smtp.from': 'a@b.test' });
    const config = await withTx(h, (trx) => loadSmtpConfig(trx, keyring));
    expect(config?.host).toBe('smtp.perpus.test');
  });

  it('feeds the mailer: a saved change is used by the very next send', async () => {
    const smtp = await startFakeSmtp({ auth: { user: 'mailer', pass: 'rahasia' } });
    try {
      const mailer = createSmtpMailer(() => loadSmtpConfig(h.db, keyring));
      await expect(mailer.send({ to: 'staff@perpus.test', subject: 'S', text: 'T' })).rejects.toMatchObject({ code: 'SMTP_NOT_CONFIGURED' });

      await write({
        'smtp.host': '127.0.0.1',
        'smtp.port': smtp.port,
        'smtp.security': 'none',
        'smtp.username': 'mailer',
        'smtp.password': 'rahasia',
        'smtp.from': 'noreply@perpus.test',
        'email.sender_name': 'Perpus Pelita',
      });
      await mailer.send({ to: 'staff@perpus.test', subject: 'S', text: 'T' });
      expect(smtp.messages.map((m) => [m.to, m.user])).toEqual([[['staff@perpus.test'], 'mailer']]);

      // Another port with the same password: the password is bound to the old one and is cleared (§7.6), so the login fails.
      await write({ 'smtp.port': smtp.port + 1 });
      expect((await loadSmtpConfig(h.db, keyring))?.password).toBeNull();
    } finally {
      await smtp.close();
    }
  });
});
