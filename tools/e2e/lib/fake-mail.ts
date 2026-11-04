import http from 'node:http';
import type net from 'node:net';
import { startFakeSmtp, type FakeSmtpMessage } from '../../../packages/core/test/fake-smtp.js';

// The in-process mail catcher of an E2E run without mailpit (lib/mail.ts): the SMTP server of
// packages/core/test/fake-smtp.ts, and an HTTP server on 127.0.0.1 that answers the part of mailpit's REST API the
// specs read (MailCatcher), so that a spec reads mail the same way from either:
//
//   GET    /api/v1/info          200 {Version}
//   GET    /api/v1/messages      200 {total, messages: [{ID, From, To, Subject, Created}]}, newest first
//   GET    /api/v1/message/:id   200 {ID, From, To, Subject, Text} (the body decoded), 404 for an unknown id
//   DELETE /api/v1/messages      200, every message gone
//
// It lives in the Playwright runner (global-setup.ts) for the whole run; the specs run in worker processes and reach
// it over HTTP. Nothing leaves the machine.

export interface ParsedMessage {
  /** The From header as received (encoded words decoded). */
  from: string;
  /** The To header as received. */
  to: string;
  subject: string;
  /** The body with its transfer encoding undone, read as UTF-8. */
  text: string;
}

/** The bytes of quoted-printable `body` (soft line breaks removed). */
function quotedPrintable(body: string): Buffer {
  const text = body.replace(/=\r?\n/g, '');
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const hex = text.slice(i + 1, i + 3);
    if (text[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(hex)) {
      bytes.push(parseInt(hex, 16));
      i += 2;
    } else {
      bytes.push(...Buffer.from(text[i]!, 'utf8'));
    }
  }
  return Buffer.from(bytes);
}

/** A header value with its RFC 2047 encoded words (`=?charset?Q|B?…?=`) decoded; adjacent words join. */
function decodeWords(value: string): string {
  return value.replace(/(\?=)\s+(=\?)/g, '$1$2').replace(/=\?([^?]+)\?([QqBb])\?([^?]*)\?=/g, (_whole, charset: string, kind: string, data: string) => {
    const bytes = kind.toUpperCase() === 'B' ? Buffer.from(data, 'base64') : quotedPrintable(data.replace(/_/g, ' '));
    return bytes.toString(/^utf-?8$/i.test(charset) ? 'utf8' : 'latin1');
  });
}

/** Headers and decoded text of a message's DATA section. */
export function parseMessage(data: string): ParsedMessage {
  const split = /\r?\n\r?\n/.exec(data);
  const head = split === null ? data : data.slice(0, split.index);
  const body = split === null ? '' : data.slice(split.index + split[0].length);
  const headers = new Map<string, string>();
  for (const line of head.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    if (!headers.has(name)) headers.set(name, line.slice(colon + 1).trim());
  }
  const encoding = (headers.get('content-transfer-encoding') ?? '7bit').toLowerCase();
  const text =
    encoding === 'quoted-printable'
      ? quotedPrintable(body).toString('utf8')
      : encoding === 'base64'
        ? Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8')
        : body;
  return {
    from: decodeWords(headers.get('from') ?? ''),
    to: decodeWords(headers.get('to') ?? ''),
    subject: decodeWords(headers.get('subject') ?? ''),
    text,
  };
}

export interface FakeMailCatcher {
  /** Where the install sends mail (`security: 'none'`). */
  smtp: { host: string; port: number };
  /** The API's origin, for MailCatcher. */
  api: string;
  close(): Promise<void>;
}

interface Stored {
  id: string;
  at: string;
  envelope: FakeSmtpMessage;
  parsed: ParsedMessage;
}

/** Starts the SMTP side and the API side on free ports of 127.0.0.1. */
export async function startFakeMailCatcher(): Promise<FakeMailCatcher> {
  const smtp = await startFakeSmtp();
  const stored: Stored[] = [];
  let taken = 0;
  let nextId = 1;

  /** Takes what the SMTP side received since the last look. */
  const sync = (): void => {
    for (const envelope of smtp.messages.slice(taken)) {
      stored.push({ id: String(nextId++), at: new Date().toISOString(), envelope, parsed: parseMessage(envelope.data) });
    }
    taken = smtp.messages.length;
  };

  const addresses = (list: readonly string[]) => list.map((Address) => ({ Name: '', Address }));

  const server = http.createServer((req, res) => {
    const send = (status: number, body: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    const url = new URL(req.url ?? '/', 'http://catcher.invalid');
    sync();
    if (req.method === 'GET' && url.pathname === '/api/v1/info') return send(200, { Version: 'altis-e2e-fake' });
    if (req.method === 'GET' && url.pathname === '/api/v1/messages') {
      const messages = [...stored].reverse().map((m) => ({
        ID: m.id,
        From: { Name: '', Address: m.envelope.from },
        To: addresses(m.envelope.to),
        Subject: m.parsed.subject,
        Created: m.at,
      }));
      return send(200, { total: messages.length, messages });
    }
    if (req.method === 'DELETE' && url.pathname === '/api/v1/messages') {
      stored.length = 0;
      return send(200, 'ok');
    }
    const one = /^\/api\/v1\/message\/([^/]+)$/.exec(url.pathname);
    if (req.method === 'GET' && one !== null) {
      const m = stored.find((s) => s.id === decodeURIComponent(one[1]!));
      if (m === undefined) return send(404, { error: 'not found' });
      return send(200, {
        ID: m.id,
        From: { Name: '', Address: m.envelope.from },
        To: addresses(m.envelope.to),
        Subject: m.parsed.subject,
        Text: m.parsed.text,
      });
    }
    return send(404, { error: 'not found' });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const { port } = server.address() as net.AddressInfo;

  return {
    smtp: { host: '127.0.0.1', port: smtp.port },
    api: `http://127.0.0.1:${port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await smtp.close();
    },
  };
}
