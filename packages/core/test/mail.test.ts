import { isDomainError, type DomainError } from '@altis/shared';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_SMTP_TIMEOUT_MS, createSmtpMailer, smtpTransportOptions, type SmtpConfig } from '../src/mail/smtp.js';
import { renderMail } from '../src/mail/templates.js';
import {
  bodyOf,
  closedPort,
  headerOf,
  startFakeSmtp,
  startSilentServer,
  type FakeSmtp,
  type FakeSmtpOptions,
} from './fake-smtp.js';
import { MAILPIT_SMTP, mailpit, mailpitMode } from './mailpit.js';

// The SMTP mailer and the plain-text templates (spec §7.1, §9.10; D17, D18; Review Focus 4). The mailer talks to an
// in-process SMTP server (fake-smtp.ts), so the unit suite needs no Docker; the delivery test through the real mailpit
// service runs when ALTIS_TEST_MAILPIT_REQUIRED=1 (CI) or ALTIS_TEST_MAILPIT=1 asks for it (mailpit.ts).

const config = (port: number, over: Partial<SmtpConfig> = {}): SmtpConfig => ({
  host: '127.0.0.1',
  port,
  security: 'none',
  username: null,
  password: null,
  from: 'noreply@perpus.test',
  senderName: 'Perpus Pelita',
  ...over,
});

/** Every character that ends a line in a mail header (CR, LF, NEL, LS, PS). */
const LINE_BREAK = new RegExp('[\\r\\n\\u0085\\u2028\\u2029]');

const MAIL = { to: 'staff@perpus.test', subject: 'Uji kirim', text: 'Halo dari ALTIS.\nBaris kedua.' };

/** The DomainError a promise rejects with. */
async function failure(promise: Promise<unknown>): Promise<DomainError> {
  try {
    await promise;
  } catch (error) {
    if (isDomainError(error)) return error;
    throw error;
  }
  throw new Error('expected the promise to reject');
}

/** The nodemailer error behind a failure (the log keeps it; the problem never shows it). */
const causeOf = (error: DomainError): { code?: string; originalCode?: string } => (error.cause ?? {}) as { code?: string; originalCode?: string };

describe('createSmtpMailer', () => {
  const servers: { close(): Promise<void> }[] = [];

  async function fake(options?: FakeSmtpOptions): Promise<FakeSmtp> {
    const server = await startFakeSmtp(options);
    servers.push(server);
    return server;
  }

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => s.close()));
  });

  describe('delivery', () => {
    it('sends the message: envelope, subject, text, and the sender name in From', async () => {
      const smtp = await fake();
      const mailer = createSmtpMailer(async () => config(smtp.port));
      await mailer.send(MAIL);

      expect(smtp.messages).toHaveLength(1);
      const [message] = smtp.messages;
      expect(message!.from).toBe('noreply@perpus.test');
      expect(message!.to).toEqual(['staff@perpus.test']);
      expect(headerOf(message!.data, 'Subject')).toBe('Uji kirim');
      expect(headerOf(message!.data, 'From')).toContain('Perpus Pelita');
      expect(headerOf(message!.data, 'From')).toContain('<noreply@perpus.test>');
      expect(headerOf(message!.data, 'Content-Type')).toMatch(/^text\/plain/);
      expect(bodyOf(message!.data).replace(/\r\n/g, '\n').trim()).toBe(MAIL.text);
      // security 'none' is plain: no STARTTLS, and no AUTH without a username.
      expect(smtp.commands.filter((c) => c === 'STARTTLS' || c.startsWith('AUTH'))).toEqual([]);
    });

    it('reads the configuration at every send, so a saved change applies at once', async () => {
      const smtp = await fake();
      let current: SmtpConfig | null = null;
      let loads = 0;
      const mailer = createSmtpMailer(async () => {
        loads += 1;
        return current;
      });

      expect((await failure(mailer.send(MAIL))).code).toBe('SMTP_NOT_CONFIGURED');
      current = config(smtp.port, { senderName: 'Perpus Baru' });
      await mailer.send(MAIL);
      current = config(smtp.port, { senderName: 'Perpus Lagi' });
      await mailer.send(MAIL);

      expect(loads).toBe(3);
      expect(smtp.messages.map((m) => headerOf(m.data, 'From'))).toEqual([
        expect.stringContaining('Perpus Baru'),
        expect.stringContaining('Perpus Lagi'),
      ]);
    });

    it('authenticates with the username and the password exactly as given (not trimmed)', async () => {
      const pass = ' S3cr3t!:@ x ';
      const smtp = await fake({ auth: { user: 'mailer', pass } });
      const mailer = createSmtpMailer(async () => config(smtp.port, { username: 'mailer', password: pass }));
      await mailer.send(MAIL);
      expect(smtp.messages.map((m) => m.user)).toEqual(['mailer']);
    });

    it("security 'none' stays plain even when the server offers STARTTLS", async () => {
      const smtp = await fake({ tls: 'starttls' });
      const mailer = createSmtpMailer(async () => config(smtp.port, { security: 'none' }));
      await mailer.send(MAIL);
      expect(smtp.messages).toHaveLength(1);
      expect(smtp.commands).not.toContain('STARTTLS');
    });

    it('puts no line break from the subject or the sender name into a header', async () => {
      const smtp = await fake();
      const mailer = createSmtpMailer(async () => config(smtp.port, { senderName: 'Perpus\r\nBcc: spy@evil.test' }));
      await mailer.send({ ...MAIL, subject: 'Halo\r\nBcc: spy@evil.test' });

      const [message] = smtp.messages;
      expect(headerOf(message!.data, 'Bcc')).toBeNull();
      expect(message!.to).toEqual(['staff@perpus.test']);
      expect(headerOf(message!.data, 'Subject')).toContain('Halo');
    });

    it.each(['a@b.test, c@d.test', 'a@b.test\r\nBcc: c@d.test', '<a@b.test>', 'a@b.test;c@d.test', 'no-at-sign', ''])(
      'refuses the recipient %j (one plain address only)',
      async (to) => {
        const smtp = await fake();
        const mailer = createSmtpMailer(async () => config(smtp.port));
        await expect(mailer.send({ ...MAIL, to })).rejects.toThrow(TypeError);
        expect(smtp.messages).toEqual([]);
      },
    );
  });

  describe('not configured', () => {
    it('SMTP_NOT_CONFIGURED when the loader returns null; no connection is tried', async () => {
      const smtp = await fake();
      const mailer = createSmtpMailer(async () => null);
      const error = await failure(mailer.send(MAIL));
      expect(error.code).toBe('SMTP_NOT_CONFIGURED');
      expect(error.status).toBe(409);
      expect(smtp.commands).toEqual([]);
    });

    it('a failing loader is not turned into an SMTP error', async () => {
      const mailer = createSmtpMailer(async () => {
        throw new RangeError('db is down');
      });
      await expect(mailer.send(MAIL)).rejects.toThrow(RangeError);
    });
  });

  describe('failures: SMTP_FAILED with a stage and a fixed bilingual detail, never the server text', () => {
    it('connect: a closed port, within the timeout plus a second', async () => {
      const port = await closedPort();
      const mailer = createSmtpMailer(async () => config(port), { timeoutMs: 2000 });
      const started = Date.now();
      const error = await failure(mailer.send(MAIL));
      expect(Date.now() - started).toBeLessThan(2000 + 1000);
      expect(error.code).toBe('SMTP_FAILED');
      expect(error.meta?.['reason']).toBe('connect');
      expect(error.detail).toMatch(/ \/ /); // Indonesian / English
    });

    it('connect: a server that accepts and never greets, within 2 s at timeoutMs 500', async () => {
      const silent = await startSilentServer();
      servers.push(silent);
      const mailer = createSmtpMailer(async () => config(silent.port), { timeoutMs: 500 });
      const started = Date.now();
      const error = await failure(mailer.send(MAIL));
      const took = Date.now() - started;
      expect(took).toBeGreaterThanOrEqual(400); // it waited for the greeting, it did not give up at once
      expect(took).toBeLessThan(2000);
      expect(error.code).toBe('SMTP_FAILED');
      expect(error.meta?.['reason']).toBe('connect');
    });

    it('auth: wrong credentials; neither the server text nor the password reaches the error', async () => {
      const smtp = await fake({ auth: { user: 'mailer', pass: 'right' }, authFailureReply: '535 5.7.8 canary-server-text-8841' });
      const mailer = createSmtpMailer(async () => config(smtp.port, { username: 'mailer', password: 'wrong-pass-4417' }));
      const error = await failure(mailer.send(MAIL));
      expect(error.code).toBe('SMTP_FAILED');
      expect(error.meta?.['reason']).toBe('auth');
      expect(smtp.messages).toEqual([]);
      const shown = JSON.stringify({ message: error.message, detail: error.detail, meta: error.meta });
      expect(shown).not.toContain('canary-server-text-8841');
      expect(shown).not.toContain('wrong-pass-4417');
    });

    it('send: the server refuses the recipient; the server text stays out of the error', async () => {
      const smtp = await fake({ rcptReply: '550 5.1.1 canary-mailbox-text-2290' });
      const mailer = createSmtpMailer(async () => config(smtp.port));
      const error = await failure(mailer.send(MAIL));
      expect(error.code).toBe('SMTP_FAILED');
      expect(error.meta?.['reason']).toBe('send');
      expect(JSON.stringify({ message: error.message, detail: error.detail, meta: error.meta })).not.toContain('canary-mailbox-text-2290');
    });

    it("tls: 'starttls' is mandatory, so a server without STARTTLS is refused and nothing is sent in clear", async () => {
      const smtp = await fake();
      const mailer = createSmtpMailer(async () => config(smtp.port, { security: 'starttls' }));
      const error = await failure(mailer.send(MAIL));
      expect(error.meta?.['reason']).toBe('tls');
      expect(smtp.messages).toEqual([]);
    });

    it("tls: certificates are verified, with 'starttls' (a self-signed server is refused)", async () => {
      const smtp = await fake({ tls: 'starttls' });
      const mailer = createSmtpMailer(async () => config(smtp.port, { security: 'starttls' }));
      const error = await failure(mailer.send(MAIL));
      expect(error.code).toBe('SMTP_FAILED');
      expect(error.meta?.['reason']).toBe('tls');
      expect(causeOf(error).originalCode).toBe('DEPTH_ZERO_SELF_SIGNED_CERT'); // refused for its certificate, not for a handshake accident
      expect(smtp.messages).toEqual([]);
    });

    it("tls: certificates are verified, with 'tls' (a self-signed server is refused)", async () => {
      const smtp = await fake({ tls: 'implicit' });
      const mailer = createSmtpMailer(async () => config(smtp.port, { security: 'tls' }));
      const error = await failure(mailer.send(MAIL));
      expect(error.code).toBe('SMTP_FAILED');
      expect(error.meta?.['reason']).toBe('tls');
      expect(causeOf(error).originalCode).toBe('DEPTH_ZERO_SELF_SIGNED_CERT');
      expect(smtp.messages).toEqual([]);
    });

    it("tls: 'tls' against a server that speaks plain text fails as tls", async () => {
      const smtp = await fake();
      const mailer = createSmtpMailer(async () => config(smtp.port, { security: 'tls' }), { timeoutMs: 1500 });
      const error = await failure(mailer.send(MAIL));
      expect(error.code).toBe('SMTP_FAILED');
      expect(error.meta?.['reason']).toBe('tls');
      expect(smtp.messages).toEqual([]);
    });
  });

  describe('deadlineMs: the whole session is bounded, however quickly each step is answered', () => {
    const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
    /** A tarpit: every reply, the greeting included, 200 ms late (well inside a timeoutMs of 1000). */
    const tarpit = { replyDelayMs: () => 200 };

    it('without a deadline the tarpit delivers: no single step reaches timeoutMs', async () => {
      const smtp = await fake(tarpit);
      await createSmtpMailer(async () => config(smtp.port), { timeoutMs: 1000 }).send(MAIL);
      expect(smtp.messages).toHaveLength(1);
    });

    it('send: the tarpit is cut off at the deadline; the mail never arrives and the connection is closed', async () => {
      const smtp = await fake(tarpit);
      const mailer = createSmtpMailer(async () => config(smtp.port), { timeoutMs: 1000, deadlineMs: 700 });
      const started = Date.now();
      const error = await failure(mailer.send(MAIL));
      const took = Date.now() - started;
      expect(took).toBeGreaterThanOrEqual(650);
      expect(took).toBeLessThan(1100); // the whole session would take 1200 ms
      expect(error.code).toBe('SMTP_FAILED');
      expect(error.meta?.['reason']).toBe('send');
      expect(error.detail).toMatch(/ \/ /);
      // Stopped, not left to run on: nothing arrives later, and the server sees the connection go.
      await pause(800);
      expect(smtp.messages).toEqual([]);
      expect(smtp.openConnections()).toBe(0);
    });

    it('connect: a server that never greets is given up at the deadline, long before timeoutMs', async () => {
      const silent = await startSilentServer();
      servers.push(silent);
      const mailer = createSmtpMailer(async () => config(silent.port), { timeoutMs: 5000, deadlineMs: 300 });
      const started = Date.now();
      const error = await failure(mailer.send(MAIL));
      expect(Date.now() - started).toBeLessThan(2000);
      expect(error.code).toBe('SMTP_FAILED');
      expect(error.meta?.['reason']).toBe('connect');
    });

    it('tls: a STARTTLS handshake that hangs is given up at the deadline as tls', async () => {
      const smtp = await fake({ tls: 'starttls', stallStartTls: true });
      const mailer = createSmtpMailer(async () => config(smtp.port, { security: 'starttls' }), { timeoutMs: 5000, deadlineMs: 400 });
      const started = Date.now();
      const error = await failure(mailer.send(MAIL));
      expect(Date.now() - started).toBeLessThan(2000);
      expect(error.meta?.['reason']).toBe('tls');
      expect(smtp.commands).toContain('STARTTLS');
    });

    it('auth: a login the server holds back is given up at the deadline as auth; nothing is sent', async () => {
      const smtp = await fake({ auth: { user: 'mailer', pass: 'right' }, replyDelayMs: (verb) => (verb === 'AUTH' ? 3000 : 0) });
      const mailer = createSmtpMailer(async () => config(smtp.port, { username: 'mailer', password: 'right' }), { timeoutMs: 5000, deadlineMs: 400 });
      const started = Date.now();
      const error = await failure(mailer.send(MAIL));
      expect(Date.now() - started).toBeLessThan(2000);
      expect(error.meta?.['reason']).toBe('auth');
      expect(smtp.commands).not.toContain('MAIL');
      expect(smtp.messages).toEqual([]);
    });

    it('a session that ends in time is not affected by its deadline', async () => {
      const smtp = await fake({ auth: { user: 'mailer', pass: 'right' } });
      await createSmtpMailer(async () => config(smtp.port, { username: 'mailer', password: 'right' }), { deadlineMs: 5000 }).send(MAIL);
      expect(smtp.messages).toHaveLength(1);
      expect(smtp.messages[0]!.user).toBe('mailer');
    });
  });

  describe('transport options', () => {
    const base = config(2525, { host: 'smtp.perpus.test', username: 'mailer', password: 'rahasia' });

    it.each([
      ['none', { secure: false, requireTLS: false, ignoreTLS: true }],
      ['starttls', { secure: false, requireTLS: true, ignoreTLS: false }],
      ['tls', { secure: true, requireTLS: false, ignoreTLS: false }],
    ] as const)('security %s', (security, flags) => {
      expect(smtpTransportOptions({ ...base, security }, 7000)).toEqual({
        host: 'smtp.perpus.test',
        port: 2525,
        ...flags,
        auth: { user: 'mailer', pass: 'rahasia' },
        connectionTimeout: 7000,
        greetingTimeout: 7000,
        socketTimeout: 7000,
      });
    });

    it('has no auth without a username, never relaxes certificate checks, and defaults to 20 s', () => {
      const options = smtpTransportOptions({ ...base, username: null, password: null }, DEFAULT_SMTP_TIMEOUT_MS);
      expect(options.auth).toBeUndefined();
      expect(options).not.toHaveProperty('tls');
      expect(options).not.toHaveProperty('rejectUnauthorized');
      expect(DEFAULT_SMTP_TIMEOUT_MS).toBe(20_000);
      expect(options.connectionTimeout).toBe(20_000);
    });

    it('refuses a timeout or a deadline that is not a positive integer', () => {
      for (const ms of [0, -1, 1.5, Number.NaN, Infinity]) {
        expect(() => createSmtpMailer(async () => null, { timeoutMs: ms })).toThrow(TypeError);
        expect(() => createSmtpMailer(async () => null, { deadlineMs: ms })).toThrow(TypeError);
      }
    });
  });
});

describe('createSmtpMailer through mailpit', () => {
  const mode = mailpitMode();
  const box = mailpit();
  let up = false;

  beforeAll(async () => {
    if (mode === 'off') return;
    up = await box.available();
    if (!up && mode === 'required') {
      throw new Error(
        'ALTIS_TEST_MAILPIT_REQUIRED=1 but mailpit is not answering on 127.0.0.1:38025: docker compose -f tools/test/compose.yml up -d --wait mailpit',
      );
    }
  });

  it('delivers one message with that subject and text, and From holds the sender name', async (ctx) => {
    if (!up) ctx.skip();
    await box.clear();
    const mailer = createSmtpMailer(async () => config(MAILPIT_SMTP.port, { host: MAILPIT_SMTP.host }));
    await mailer.send(MAIL);

    const messages = await box.messages();
    expect(messages).toHaveLength(1);
    expect(messages[0]!.to).toEqual(['staff@perpus.test']);
    expect(messages[0]!.subject).toBe(MAIL.subject);
    expect(messages[0]!.text.replace(/\r\n/g, '\n').trim()).toBe(MAIL.text);
    expect(messages[0]!.from).toContain('Perpus Pelita');
  });
});

describe('renderMail', () => {
  const vars = {
    name: 'Budi',
    username: 'budi',
    library: 'Perpus',
    link: 'https://x/admin/reset-password#token=t',
    minutes: '30',
  };

  it('password_reset (Indonesian) holds the link and the minutes, and the library in the subject', () => {
    const mail = renderMail('password_reset', 'id', vars);
    expect(mail.text).toContain('https://x/admin/reset-password#token=t');
    expect(mail.text).toContain('30');
    expect(mail.text).toContain('Halo Budi');
    expect(mail.text).toContain('"budi"');
    expect(mail.subject).toBe('Atur ulang kata sandi Anda di Perpus');
    expect(mail.text).not.toMatch(/\{[a-z_]+\}/); // every placeholder was filled
  });

  it('password_reset (English) is in English', () => {
    const mail = renderMail('password_reset', 'en', vars);
    expect(mail.subject).toBe('Reset your password at Perpus');
    expect(mail.text).toContain('Hello Budi');
    expect(mail.text).toContain('https://x/admin/reset-password#token=t');
  });

  it('email_test needs only the library', () => {
    const mail = renderMail('email_test', 'id', { library: 'Perpus' });
    expect(mail.subject).toBe('Email uji dari Perpus');
    expect(mail.text).toContain('email uji dari ALTIS untuk Perpus');
    expect(renderMail('email_test', 'en', { library: 'Perpus' }).subject).toBe('Test email from Perpus');
  });

  it('an override body replaces the catalog text and fills {name}', () => {
    const mail = renderMail('password_reset', 'id', vars, { body: 'Hai {name}' });
    expect(mail.text).toBe('Hai Budi');
    expect(mail.subject).toBe('Atur ulang kata sandi Anda di Perpus'); // the subject was not overridden
  });

  it('an override subject replaces the catalog subject', () => {
    const mail = renderMail('password_reset', 'en', vars, { subject: 'Sandi {username} @ {library}' });
    expect(mail.subject).toBe('Sandi budi @ Perpus');
    expect(mail.text).toContain('Hello Budi');
  });

  it.each([[{}], [{ subject: null, body: null }], [{ subject: '', body: '' }], [{ subject: '  ', body: '\n ' }]])(
    'an unset override (%j) falls back to the catalog',
    (override) => {
      expect(renderMail('password_reset', 'id', vars, override)).toEqual(renderMail('password_reset', 'id', vars));
    },
  );

  it('puts no CR or LF into the subject, however the library name is written', () => {
    const hostile = { ...vars, library: 'Perpus\r\nBcc: x' };
    for (const mail of [
      renderMail('password_reset', 'id', hostile),
      renderMail('password_reset', 'en', hostile, { subject: 'Reset di {library}' }),
      renderMail('email_test', 'id', hostile),
    ]) {
      expect(mail.subject).not.toMatch(LINE_BREAK);
      expect(mail.subject).toContain('Perpus');
    }
  });

  it('an override subject that itself spans lines is flattened to one', () => {
    expect(renderMail('password_reset', 'id', vars, { subject: 'Baris satu\nBaris dua' }).subject).not.toMatch(/[\r\n]/);
  });

  it('leaves an unknown placeholder as written, fills in one pass, and takes values literally', () => {
    const mail = renderMail('password_reset', 'id', { ...vars, name: '{link} $& $1' }, { body: '{name} / {unknown} / {minutes}' });
    expect(mail.text).toBe('{link} $& $1 / {unknown} / 30');
  });

  it('is plain text: a value with markup is not escaped or altered', () => {
    expect(renderMail('password_reset', 'id', { ...vars, name: '<b>Budi</b> & co' }, { body: 'Hai {name}' }).text).toBe('Hai <b>Budi</b> & co');
  });
});
