import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { startFakeMailCatcher, parseMessage, type FakeMailCatcher } from '../lib/fake-mail.js';
import { MailCatcher, mailSetup, resetLinkOf } from '../lib/mail.js';

const TOKEN = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJ0123-_9';

/** Sends one message over plain SMTP, as the server's mailer would (the fake speaks just enough of it). */
function sendRaw(port: number, o: { from: string; to: string; data: string }): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const steps = ['EHLO e2e.test', `MAIL FROM:<${o.from}>`, `RCPT TO:<${o.to}>`, 'DATA', `${o.data.replace(/\r?\n/g, '\r\n')}\r\n.`, 'QUIT'];
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      // One command per complete reply (a final reply line is `ddd ` followed by the text).
      while (/^\d{3} .*\r\n/m.test(buffer)) {
        buffer = buffer.replace(/^[\s\S]*?^\d{3} .*\r\n/m, '');
        const next = steps.shift();
        if (next === undefined) return;
        socket.write(`${next}\r\n`);
      }
    });
    socket.on('error', reject);
    socket.on('close', () => resolve());
  });
}

const RESET_MAIL = [
  'From: "Perpustakaan E2E" <perpustakaan@perpus.test>',
  'To: siti@perpus.test',
  'Subject: =?UTF-8?Q?Atur_ulang_kata_sandi_=E2=80=94_Perpus?=',
  'MIME-Version: 1.0',
  'Content-Type: text/plain; charset=utf-8',
  'Content-Transfer-Encoding: quoted-printable',
  '',
  'Halo Siti, kafe =C3=A9 tetap.',
  `Buka: http://127.0.0.1:4100/admin/reset-password#token=3D${TOKEN.slice(0, 20)}=`,
  `${TOKEN.slice(20)}`,
  '',
].join('\n');

describe('parseMessage (what the fake catcher shows of a received message)', () => {
  it('decodes quoted-printable text as UTF-8, soft line breaks included, and an RFC 2047 subject', () => {
    const m = parseMessage(RESET_MAIL.replace(/\n/g, '\r\n'));
    expect(m.subject).toBe('Atur ulang kata sandi — Perpus');
    expect(m.from).toBe('"Perpustakaan E2E" <perpustakaan@perpus.test>');
    expect(m.text).toContain('kafe é tetap.');
    expect(m.text).toContain(`reset-password#token=${TOKEN}`);
  });

  it('decodes a base64 body and leaves a 7bit one as it is', () => {
    const b64 = ['Subject: Uji', 'Content-Transfer-Encoding: base64', '', Buffer.from('Halo dunia é', 'utf8').toString('base64'), ''].join('\r\n');
    expect(parseMessage(b64).text).toBe('Halo dunia é');
    expect(parseMessage(['Subject: Uji', '', 'Baris satu', 'Baris dua', ''].join('\r\n')).text).toBe('Baris satu\r\nBaris dua\r\n');
  });
});

describe('resetLinkOf', () => {
  it('finds the password reset link of a mail', () => {
    const link = `http://127.0.0.1:4100/admin/reset-password#token=${TOKEN}`;
    expect(resetLinkOf(`Halo,\r\n\r\nBuka tautan ini:\r\n${link}\r\n\r\nSalam`)).toBe(link);
  });

  it('says so when the mail has none', () => {
    expect(() => resetLinkOf('Tidak ada tautan di sini')).toThrow(/no password reset link/);
  });
});

describe('mailSetup (mailpit or the in-process catcher)', () => {
  it('uses mailpit when the run asks for it, and the in-process catcher otherwise', () => {
    expect(mailSetup({ ALTIS_TEST_MAILPIT_REQUIRED: '1' })).toEqual({ kind: 'mailpit', required: true });
    expect(mailSetup({ ALTIS_TEST_MAILPIT: '1' })).toEqual({ kind: 'mailpit', required: false });
    expect(mailSetup({})).toEqual({ kind: 'fake' });
    expect(mailSetup({ ALTIS_TEST_MAILPIT: '0' })).toEqual({ kind: 'fake' });
  });
});

describe('MailCatcher over the fake catcher (the mailpit API subset the specs use)', () => {
  let catcher: FakeMailCatcher | undefined;
  afterEach(async () => {
    await catcher?.close();
    catcher = undefined;
  });

  it('lists, reads and clears what the SMTP side received', async () => {
    catcher = await startFakeMailCatcher();
    const mail = new MailCatcher(catcher.api);
    expect(await mail.available()).toBe(true);
    await sendRaw(catcher.smtp.port, { from: 'perpustakaan@perpus.test', to: 'siti@perpus.test', data: RESET_MAIL });
    await sendRaw(catcher.smtp.port, { from: 'perpustakaan@perpus.test', to: 'budi@perpus.test', data: 'Subject: Lain\r\n\r\nLain\r\n' });

    const found = await mail.waitFor('Siti@Perpus.test', { timeoutMs: 2000 });
    expect(found.to).toEqual(['siti@perpus.test']);
    expect(found.subject).toBe('Atur ulang kata sandi — Perpus');
    expect(resetLinkOf(found.text)).toBe(`http://127.0.0.1:4100/admin/reset-password#token=${TOKEN}`);

    await mail.clear();
    await expect(mail.waitFor('siti@perpus.test', { timeoutMs: 300, pollMs: 50 })).rejects.toThrow(/no mail to siti@perpus.test within 300 ms/);
  });

  it('waits for a message that arrives later, and gives the newest one', async () => {
    catcher = await startFakeMailCatcher();
    const mail = new MailCatcher(catcher.api);
    const port = catcher.smtp.port;
    await sendRaw(port, { from: 'a@perpus.test', to: 'siti@perpus.test', data: 'Subject: Pertama\r\n\r\nSatu\r\n' });
    const later = new Promise<void>((resolve) => setTimeout(resolve, 150)).then(() =>
      sendRaw(port, { from: 'a@perpus.test', to: 'siti@perpus.test', data: 'Subject: Kedua\r\n\r\nDua\r\n' }),
    );
    const first = await mail.waitFor('siti@perpus.test', { timeoutMs: 2000 });
    expect(first.subject).toBe('Pertama');
    await later;
    const newest = await mail.waitFor('siti@perpus.test', { timeoutMs: 2000, after: [first.id] });
    expect(newest.subject).toBe('Kedua');
  });

  it('is unavailable when nothing answers', async () => {
    const closed = await startFakeMailCatcher();
    const api = closed.api;
    await closed.close();
    expect(await new MailCatcher(api).available()).toBe(false);
  });
});
