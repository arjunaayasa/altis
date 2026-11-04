import http from 'node:http';
import { mailpitMode } from '../../../packages/core/test/mailpit.js';

// Where the E2E install's mail goes, and how the specs read it.
//
// - mailpit (tools/test/compose.yml: SMTP 127.0.0.1:31025, API 127.0.0.1:38025) when the run asks for it, as the
//   unit and DB suites decide it (packages/core/test/mailpit.ts, S19): ALTIS_TEST_MAILPIT_REQUIRED=1 (CI: an
//   unreachable mailpit fails the run) or ALTIS_TEST_MAILPIT=1 (a developer who started it);
// - otherwise the in-process catcher of fake-mail.ts, which global-setup.ts starts in the runner: the SMTP server of
//   packages/core/test/fake-smtp.ts behind the subset of mailpit's REST API that MailCatcher reads. The specs run the
//   same either way, and no mail leaves the machine.
//
// The API is read through node:http: global fetch is forbidden in this repository (P18).

export type MailSetup = { kind: 'mailpit'; required: boolean } | { kind: 'fake' };

/** mailpit or the in-process catcher, for `env` (see the top of this file). */
export function mailSetup(env: NodeJS.ProcessEnv = process.env): MailSetup {
  const mode = mailpitMode(env);
  return mode === 'off' ? { kind: 'fake' } : { kind: 'mailpit', required: mode === 'required' };
}

export interface MailMessage {
  id: string;
  /** The recipients' addresses. */
  to: string[];
  /** `Name <address>`, or the address. */
  from: string;
  subject: string;
  /** The plain-text body, decoded. */
  text: string;
}

interface ApiAddress {
  Name?: string;
  Address?: string;
}

interface ApiSummary {
  ID: string;
  To?: ApiAddress[] | null;
}

interface ApiMessage extends ApiSummary {
  From?: ApiAddress | null;
  Subject?: string;
  Text?: string;
}

const REQUEST_TIMEOUT_MS = 5000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const addressText = (a: ApiAddress | null | undefined): string =>
  a === null || a === undefined ? '' : a.Name !== undefined && a.Name !== '' ? `${a.Name} <${a.Address ?? ''}>` : (a.Address ?? '');

/** A client of the mail catcher's REST API (mailpit's, or the in-process one that speaks the same). */
export class MailCatcher {
  readonly #base: URL;

  /** @param api the API's origin, e.g. `http://127.0.0.1:38025` */
  constructor(api: string) {
    this.#base = new URL(api);
  }

  #request(method: 'GET' | 'DELETE', pathname: string): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        { host: this.#base.hostname, port: this.#base.port, method, path: pathname, agent: false, headers: { accept: 'application/json' } },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
          res.on('error', reject);
        },
      );
      req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error(`mail catcher: ${method} ${pathname} had no answer within ${REQUEST_TIMEOUT_MS} ms`)));
      req.on('error', reject);
      req.end();
    });
  }

  async #json<T>(pathname: string): Promise<T> {
    const { status, body } = await this.#request('GET', pathname);
    if (status !== 200) throw new Error(`mail catcher: GET ${pathname} → ${status}`);
    return JSON.parse(body) as T;
  }

  /** True when the API answers. Never rejects. */
  async available(): Promise<boolean> {
    try {
      return (await this.#request('GET', '/api/v1/info')).status === 200;
    } catch {
      return false;
    }
  }

  /** Deletes every message. */
  async clear(): Promise<void> {
    const { status } = await this.#request('DELETE', '/api/v1/messages');
    if (status !== 200) throw new Error(`mail catcher: DELETE /api/v1/messages → ${status}`);
  }

  /** The message `id`, read in full. */
  async message(id: string): Promise<MailMessage> {
    const m = await this.#json<ApiMessage>(`/api/v1/message/${encodeURIComponent(id)}`);
    return {
      id: m.ID,
      to: (m.To ?? []).map((a) => a.Address ?? ''),
      from: addressText(m.From),
      subject: m.Subject ?? '',
      text: m.Text ?? '',
    };
  }

  /**
   * The newest message to `to` (compared without case) whose id is not in `after`, waiting up to `timeoutMs` for one
   * (the server sends its mail after the response, D18).
   */
  async waitFor(to: string, o: { timeoutMs?: number; pollMs?: number; after?: readonly string[] } = {}): Promise<MailMessage> {
    const timeoutMs = o.timeoutMs ?? 20_000;
    const pollMs = o.pollMs ?? 200;
    const wanted = to.toLowerCase();
    const skip = new Set(o.after ?? []);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const list = await this.#json<{ messages?: ApiSummary[] | null }>('/api/v1/messages?limit=200');
      const messages = list.messages ?? [];
      // The list is newest first.
      const hit = messages.find((m) => !skip.has(m.ID) && (m.To ?? []).some((a) => (a.Address ?? '').toLowerCase() === wanted));
      if (hit !== undefined) return this.message(hit.ID);
      if (Date.now() >= deadline) throw new Error(`no mail to ${to} within ${timeoutMs} ms (${messages.length} message(s) in the catcher)`);
      await sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())));
    }
  }
}

/** The link of a password reset mail (`<baseUrl>/admin/reset-password#token=<43 base64url characters>`). */
export function resetLinkOf(text: string): string {
  const match = /https?:\/\/\S+?\/admin\/reset-password#token=[A-Za-z0-9_-]{43}/.exec(text);
  if (match === null) throw new Error(`no password reset link in the mail: ${JSON.stringify(text.slice(0, 500))}`);
  return match[0];
}
