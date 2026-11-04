import { randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PHASE1_MIGRATIONS, runMigrations, withTx } from '@altis/db';
import { newId, normalizeKey } from '@altis/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { startPasswordReset } from '../../src/auth/password.js';
import type { CoreLogger } from '../../src/context.js';
import type { KeyringEntry } from '../../src/crypto/secret-box.js';
import { sha256hex } from '../../src/crypto/tokens.js';
import { claimById } from '../../src/jobs/claim.js';
import { createJobRegistry } from '../../src/jobs/registry.js';
import { runSlice } from '../../src/jobs/slice.js';
import type { JobRegistry, SliceResult } from '../../src/jobs/types.js';
import { MAIL_PASSWORD_RESET, enqueuePasswordResetMail, mailJobs } from '../../src/mail/jobs.js';
import { createSmtpMailer, loadSmtpConfig } from '../../src/mail/smtp.js';
import type { SettingKey } from '../../src/settings/registry.js';
import { createSettingsCache, writeSettings } from '../../src/settings/service.js';
import { bodyOf, closedPort, headerOf, startFakeSmtp, type FakeSmtp } from '../fake-smtp.js';
import { MAILPIT_SMTP, mailpit, mailpitMode } from '../mailpit.js';

// The password-reset mail through the job queue (Task 18; 1b D18, decision C28, M22) on the engine picked by
// ALTIS_TEST_DB: `mail.password_reset` reads the reset token from the job's secret, renders the mail with the link
// `<baseUrl>/admin/reset-password#token=<token>` in the user's language (else the library's) with the library's
// override, and sends it. An SMTP failure takes the job's error path: queued again 20 s later, dead after 3 attempts;
// the token is never in the payload, `last_error` or the log, and `secret_param` is cleared once the job ends.
//
// The mail goes to mailpit when the run asks for it (ALTIS_TEST_MAILPIT_REQUIRED=1 in CI, ALTIS_TEST_MAILPIT=1), and
// otherwise to the in-process SMTP server of fake-smtp.ts.

const ctx = testDbContext();
const keyring: KeyringEntry[] = [{ kid: 'k1', key: randomBytes(32).toString('base64url'), active: true }];
const BASE_URL = 'https://perpus.sekolah.sch.id/';
const LINK = /https:\/\/perpus\.sekolah\.sch\.id\/admin\/reset-password#token=([A-Za-z0-9_-]{43})/;

interface Mail {
  to: string[];
  subject: string;
  text: string;
}

/** Where the mail goes: mailpit when the run asks for it, else the in-process server. */
interface Sink {
  smtp: { host: string; port: number };
  to(address: string): Promise<Mail[]>;
  close(): Promise<void>;
}

async function openSink(): Promise<Sink> {
  const mode = mailpitMode();
  if (mode !== 'off') {
    const mp = mailpit();
    const up = await mp.available();
    if (!up && mode === 'required') throw new Error('mailpit does not answer, and ALTIS_TEST_MAILPIT_REQUIRED=1 requires it');
    if (up) {
      return {
        smtp: { ...MAILPIT_SMTP },
        to: async (address) =>
          (await mp.messages()).filter((m) => m.to.includes(address)).map((m) => ({ to: m.to, subject: m.subject, text: m.text.replace(/\r\n/g, '\n') })),
        close: async () => undefined,
      };
    }
  }
  const fake: FakeSmtp = await startFakeSmtp();
  return {
    smtp: { host: '127.0.0.1', port: fake.port },
    to: async (address) =>
      fake.messages
        .filter((m) => m.to.includes(address))
        .map((m) => {
          const encoding = (headerOf(m.data, 'Content-Transfer-Encoding') ?? '').toLowerCase();
          const text =
            encoding === 'base64'
              ? Buffer.from(m.data.slice(m.data.indexOf('\r\n\r\n') + 4).replace(/\s+/g, ''), 'base64').toString('utf8')
              : bodyOf(m.data);
          return { to: m.to, subject: headerOf(m.data, 'Subject') ?? '', text: text.replace(/\r\n/g, '\n') };
        }),
    close: () => fake.close(),
  };
}

function recorder(): CoreLogger & { lines: { level: string; msg: string; fields?: Record<string, unknown> }[] } {
  const lines: { level: string; msg: string; fields?: Record<string, unknown> }[] = [];
  return {
    lines,
    info: (msg, fields) => lines.push({ level: 'info', msg, ...(fields === undefined ? {} : { fields }) }),
    warn: (msg, fields) => lines.push({ level: 'warn', msg, ...(fields === undefined ? {} : { fields }) }),
    error: (msg, fields) => lines.push({ level: 'error', msg, ...(fields === undefined ? {} : { fields }) }),
  };
}

describe.skipIf(!ctx.available)(`mail.password_reset [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let migDir: string;
  let sink: Sink;
  let now: number;
  let reg: JobRegistry;
  let log: ReturnType<typeof recorder>;

  beforeAll(async () => {
    h = await testDb();
    migDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-core-mail-job-'));
    await runMigrations(h, { appVersion: '0.1.0', dataDir: migDir, migrations: PHASE1_MIGRATIONS });
    sink = await openSink();
  });

  afterAll(async () => {
    await sink?.close();
    await h?.close();
    if (migDir !== undefined) await fsp.rm(migDir, { recursive: true, force: true });
  });

  const settings = (patch: Partial<Record<SettingKey, unknown>>) =>
    withTx(h, (trx) => writeSettings(trx, patch, { keyring, now, actorId: null }));

  beforeEach(async () => {
    for (const t of ['jobs', 'settings', 'password_resets', 'staff_users', 'events', 'notifications'] as const) await h.db.deleteFrom(t).execute();
    now = Date.now();
    await settings({ 'smtp.host': sink.smtp.host, 'smtp.port': sink.smtp.port, 'smtp.security': 'none', 'smtp.from': 'noreply@perpus.test' });
    log = recorder();
    const mailer = createSmtpMailer(() => loadSmtpConfig(h.db, keyring), { timeoutMs: 3000 });
    reg = createJobRegistry(mailJobs({ mailer, baseUrl: () => BASE_URL, settings: createSettingsCache({ ttlMs: 0 }) }));
  });

  async function staff(o: { username: string; name: string; locale?: string | null }): Promise<{ id: string; email: string }> {
    const id = newId();
    const email = `${o.username}.${id.toLowerCase()}@perpus.test`;
    await h.db
      .insertInto('staff_users')
      .values({
        id,
        username_key: normalizeKey(o.username),
        username_display: o.username,
        name: o.name,
        email_key: normalizeKey(email),
        email_display: email,
        locale: o.locale ?? null,
        password_hash: '$scrypt$test',
        status: 'active',
        created_at: now,
        updated_at: now,
      })
      .execute();
    return { id, email };
  }

  /** What the forgot route does after its response: the reset and its mail job, in one transaction. */
  async function forgot(email: string): Promise<{ jobId: string; token: string }> {
    return withTx(h, async (trx) => {
      const started = await startPasswordReset(trx, { email, now });
      if (started === null) throw new Error('no such account');
      const { id } = await enqueuePasswordResetMail(trx, reg, started, { now, keyring });
      return { jobId: id, token: started.token };
    });
  }

  async function slice(jobId: string): Promise<SliceResult> {
    const job = await claimById(h, reg, jobId, { worker: 'test', now });
    if (job === null) throw new Error('not claimable');
    return runSlice(h, reg, job, { mode: 'worker', budgetMs: 20_000, keyring, log, clock: () => now, env: {} });
  }

  const row = (id: string) => h.db.selectFrom('jobs').selectAll().where('id', '=', id).executeTakeFirstOrThrow();

  it('is registered with system.users.manage, origin-only retries and 3 attempts', () => {
    expect(reg.get(MAIL_PASSWORD_RESET)).toMatchObject({ permission: 'system.users.manage', retryable: 'origin-only', maxAttempts: 3 });
  });

  it('sends the reset link (library language); the payload holds {userId, locale} only; secret_param is NULL afterwards', async () => {
    const budi = await staff({ username: 'budi', name: 'Budi Santoso' });
    const { jobId, token } = await forgot(budi.email);
    const queued = await row(jobId);
    expect(JSON.parse(queued.payload)).toEqual({ userId: budi.id, locale: null });
    expect(queued.secret_param).not.toBeNull();
    expect(queued.secret_param).not.toContain(token);

    expect(await slice(jobId)).toMatchObject({ outcome: 'succeeded' });
    const mails = await sink.to(budi.email);
    expect(mails).toHaveLength(1);
    expect(mails[0]!.subject).toBe('Atur ulang kata sandi Anda di Perpustakaan');
    expect(LINK.exec(mails[0]!.text)?.[1]).toBe(token);
    expect(mails[0]!.text).toContain('Halo Budi Santoso,');
    const done = await row(jobId);
    expect(done).toMatchObject({ status: 'succeeded', secret_param: null });
    expect(JSON.stringify(log.lines)).not.toContain(token);
  });

  it("the user's own language with the library's override for it", async () => {
    await settings({
      'email.template.password_reset.en.subject': 'Password for {username} at {library}',
      'email.template.password_reset.en.body': 'Hi {name}, open {link} within {minutes} minutes.',
      'library.name': 'Perpus Pelita',
    });
    const ani = await staff({ username: 'ani', name: 'Ani', locale: 'en' });
    const { jobId, token } = await forgot(ani.email);
    expect(JSON.parse((await row(jobId)).payload)).toEqual({ userId: ani.id, locale: 'en' });
    expect(await slice(jobId)).toMatchObject({ outcome: 'succeeded' });
    const [mail] = await sink.to(ani.email);
    expect(mail!.subject).toBe('Password for ani at Perpus Pelita');
    expect(mail!.text.trim()).toBe(`Hi Ani, open https://perpus.sekolah.sch.id/admin/reset-password#token=${token} within 30 minutes.`);
  });

  it('SMTP down: queued again 20 s later, the token neither in the payload nor in last_error; dead after 3 attempts with secret_param NULL', async () => {
    await settings({ 'smtp.port': await closedPort(), 'smtp.host': '127.0.0.1' });
    const budi = await staff({ username: 'budi', name: 'Budi' });
    const { jobId, token } = await forgot(budi.email);

    const first = await slice(jobId);
    expect(first).toMatchObject({ outcome: 'retry' });
    const retry = await row(jobId);
    expect(retry).toMatchObject({ status: 'queued', attempts: 1, run_at: now + 20_000 });
    expect(retry.secret_param).not.toBeNull();
    expect(retry.payload).not.toContain(token);
    expect(retry.last_error).toMatch(/^SMTP_FAILED/);
    expect(retry.last_error).not.toContain(token);
    expect(log.lines.find((l) => l.msg === 'mail failed')?.fields).toMatchObject({ stage: 'connect', code: 'SMTP_FAILED' });

    now += 20_000;
    expect(await slice(jobId)).toMatchObject({ outcome: 'retry' });
    now += 40_000;
    expect(await slice(jobId)).toMatchObject({ outcome: 'dead' });
    const dead = await row(jobId);
    expect(dead).toMatchObject({ status: 'dead', attempts: 3, secret_param: null });
    expect(dead.last_error).not.toContain(token);
    expect(JSON.stringify(log.lines)).not.toContain(token);
    expect(await sink.to(budi.email)).toEqual([]);
  });

  it('a reset that was used (or ran out) before the job ran sends nothing', async () => {
    const budi = await staff({ username: 'budi', name: 'Budi' });
    const { jobId, token } = await forgot(budi.email);
    await h.db.updateTable('password_resets').set({ used_at: now }).where('token_hash', '=', sha256hex(token)).execute();
    expect(await slice(jobId)).toMatchObject({ outcome: 'succeeded' });
    expect(await sink.to(budi.email)).toEqual([]);
  });
});
