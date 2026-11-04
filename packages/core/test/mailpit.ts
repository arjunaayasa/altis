import http from 'node:http';

// The mailpit SMTP catcher of tools/test/compose.yml (`docker compose -f tools/test/compose.yml up -d --wait mailpit`):
// SMTP on 127.0.0.1:31025, its web UI and REST API on 127.0.0.1:38025. This helper only talks to the REST API, through
// node:http (no global fetch, P18).
//
// Whether the mail tests that need mailpit run (spec §12.3, S19):
// - ALTIS_TEST_MAILPIT_REQUIRED=1 (CI): they run, and an unreachable mailpit fails the run, as ALTIS_TEST_DB_REQUIRED
//   does for an engine;
// - ALTIS_TEST_MAILPIT=1 (a developer who started the service): they run when mailpit answers, and skip when it does not;
// - neither: they skip without looking. The unit suite needs no Docker: its other mail tests use the in-process
//   server of fake-smtp.ts.

export const MAILPIT_SMTP = Object.freeze({ host: '127.0.0.1', port: 31025 });
export const MAILPIT_API = Object.freeze({ host: '127.0.0.1', port: 38025 });

export interface MailpitMessage {
  /** The recipients' addresses. */
  to: string[];
  /** The From header, `Name <address>` or just the address. */
  from: string;
  subject: string;
  /** The plain-text body. */
  text: string;
}

export interface Mailpit {
  /** True when the REST API answers. Never rejects. */
  available(): Promise<boolean>;
  /** Deletes every message. */
  clear(): Promise<void>;
  /** Every message, oldest first. */
  messages(): Promise<MailpitMessage[]>;
}

export type MailpitMode = 'off' | 'optional' | 'required';

/** How the run treats mailpit (see the top of this file). */
export function mailpitMode(env: NodeJS.ProcessEnv = process.env): MailpitMode {
  if (env['ALTIS_TEST_MAILPIT_REQUIRED'] === '1') return 'required';
  const optIn = env['ALTIS_TEST_MAILPIT']?.trim() ?? '';
  return optIn !== '' && optIn !== '0' ? 'optional' : 'off';
}

function request(method: 'GET' | 'DELETE', path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ ...MAILPIT_API, method, path, timeout: 5000 }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('mailpit: the API did not answer within 5 s')));
    req.on('error', reject);
    req.end();
  });
}

async function json(path: string): Promise<unknown> {
  const { status, body } = await request('GET', path);
  if (status !== 200) throw new Error(`mailpit: GET ${path} → ${status}`);
  return JSON.parse(body) as unknown;
}

interface Address {
  Name?: string;
  Address?: string;
}

const addressText = (a: Address | undefined): string =>
  a === undefined ? '' : a.Name !== undefined && a.Name !== '' ? `${a.Name} <${a.Address ?? ''}>` : (a.Address ?? '');

export function mailpit(): Mailpit {
  return {
    async available(): Promise<boolean> {
      try {
        return (await request('GET', '/api/v1/info')).status === 200;
      } catch {
        return false;
      }
    },
    async clear(): Promise<void> {
      const { status } = await request('DELETE', '/api/v1/messages');
      if (status !== 200) throw new Error(`mailpit: DELETE /api/v1/messages → ${status}`);
    },
    async messages(): Promise<MailpitMessage[]> {
      const list = (await json('/api/v1/messages?limit=500')) as { messages?: { ID: string }[] };
      const found: MailpitMessage[] = [];
      // The list is newest first; each message is read for its text.
      for (const { ID } of [...(list.messages ?? [])].reverse()) {
        const message = (await json(`/api/v1/message/${encodeURIComponent(ID)}`)) as {
          From?: Address;
          To?: Address[];
          Subject?: string;
          Text?: string;
        };
        found.push({
          to: (message.To ?? []).map((a) => a.Address ?? ''),
          from: addressText(message.From),
          subject: message.Subject ?? '',
          text: message.Text ?? '',
        });
      }
      return found;
    },
  };
}
