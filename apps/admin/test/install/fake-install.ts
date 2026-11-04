import { createHash } from 'node:crypto';
import type { InstallChecksResponse, PreflightCheck, PreflightReport } from '@altis/shared/api/install';
import type { Mock } from 'vitest';

// The fake host of the wizard tests (Task 30): `fetch` answers from a table of `METHOD path` handlers. A path under
// /install/api/ is written relative to it (`GET checks`, `POST probe/chunk`); any other URL is written as fetched
// (`GET http://localhost:3000/tmp/<id>`, the exposure candidates). `GET probe/:nonce` answers every nonce. Every
// request is recorded with its headers and its body (JSON parsed, a FormData kept); anything not in the table answers
// 404 NOT_FOUND as problem+json.

export const ORIGIN = 'http://localhost:3000';
export const API = '/install/api/';

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

export function problem(status: number, code: string, o: { detail?: string; reason?: string; headers?: Record<string, string> } = {}): Response {
  const body = { type: 'about:blank', title: code, status, code, traceId: '01JTRACE', ...(o.detail ? { detail: o.detail } : {}), ...(o.reason ? { reason: o.reason } : {}) };
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/problem+json', ...o.headers } });
}

/** A page that is not the server's (a WAF's refusal, a proxy's error page). */
export function htmlPage(status: number, text = '<html><body>Request blocked</body></html>'): Response {
  return new Response(text, { status, headers: { 'Content-Type': 'text/html' } });
}

export interface Call {
  method: string;
  /** Relative to /install/api/, or the whole URL for anything else. */
  path: string;
  headers: Headers;
  /** A JSON body parsed, a FormData as sent, else undefined. */
  body: unknown;
  init: RequestInit | undefined;
}

export type Handler = (call: Call) => Response | Promise<Response>;

export interface FakeInstall {
  on(route: string, handler: Handler): void;
  calls: Call[];
  callsTo(route: string): Call[];
}

export function fakeInstall(fetchMock: Mock<typeof fetch>, routes: Record<string, Handler> = {}): FakeInstall {
  const table = new Map<string, Handler>(Object.entries(routes));
  const calls: Call[] = [];
  fetchMock.mockImplementation(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const path = url.startsWith(API) ? url.slice(API.length) : url;
    const raw = init?.body;
    const body = typeof raw === 'string' ? (JSON.parse(raw) as unknown) : raw instanceof FormData ? raw : undefined;
    const call: Call = { method, path, headers: new Headers(init?.headers), body, init };
    calls.push(call);
    let handler = table.get(`${method} ${path}`);
    if (handler === undefined && method === 'GET' && /^probe\/[A-Za-z0-9_-]{16,64}$/.test(path)) handler = table.get('GET probe/:nonce');
    return handler === undefined ? problem(404, 'NOT_FOUND') : handler(call);
  });
  return {
    on: (route, handler) => void table.set(route, handler),
    calls,
    callsTo: (route) => calls.filter((c) => `${c.method} ${c.path}` === route),
  };
}

export const sha256 = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex');

/** The content of the exposure probe file (`DATA_DIR/tmp/<probeId>`: 32 random bytes as hex). */
export const PROBE_CONTENT = 'a1'.repeat(32);
export const PROBE_ID = '01JBQ8F7Y3W9X2V4T6R8P0N2M4';

const ok = (): PreflightCheck => ({ ok: true, level: 'error', detail: 'ok' });

export function preflight(o: Partial<PreflightReport['checks']> = {}): PreflightReport {
  const checks = { node: ok(), dataDir: ok(), docroot: ok(), wasm: { ...ok(), level: 'warn' as const }, timezone: ok(), ram: { ...ok(), level: 'warn' as const }, ...o };
  return { ok: Object.values(checks).every((c) => c.ok || c.level === 'warn'), checks };
}

/** `GET checks` of a claimed wizard, changed by `o`. */
export function checks(o: Partial<InstallChecksResponse> = {}): InstallChecksResponse {
  return {
    installState: null,
    preflight: preflight(),
    runtime: 'passenger',
    panelWarning: null,
    csrfToken: 'csrf-w',
    exposure: {
      probeId: PROBE_ID,
      candidates: [
        { kind: 'probe', path: `/${PROBE_ID}` },
        { kind: 'probe', path: `/tmp/${PROBE_ID}` },
        { kind: 'app', path: '/app.js' },
        { kind: 'pointer', path: '/altis-data-dir.txt' },
      ],
    },
    ...o,
  };
}

/**
 * The probe routes of a healthy host (every method passes, a 5 MiB chunk passes), the exposure candidates answering 404
 * and `POST exposure` comparing against the probe file, as the server does.
 */
export function healthyProbes(): Record<string, Handler> {
  return {
    'GET probe/poll': (call) => {
      const forged = call.headers.get('X-Forwarded-For');
      return json({
        now: 1_793_059_200_000,
        ip: forged === null ? '198.51.100.7' : '198.51.100.7',
        ipTrust: 'ok',
        xff: forged === null ? ['198.51.100.7'] : [forged, '198.51.100.7'],
        peerPrivate: true,
        suggestedHops: forged === null ? 1 : 2,
        ipAtSuggested: forged === null ? '198.51.100.7' : forged,
      });
    },
    'PUT probe/methods': () => json({ method: 'PUT' }),
    'PATCH probe/methods': () => json({ method: 'PATCH' }),
    'DELETE probe/methods': () => json({ method: 'DELETE' }),
    'POST probe/chunk': (call) => json({ bytes: ((call.body as FormData).get('chunk') as Blob).size }),
    'GET probe/:nonce': (call) => json({ hmac: `hmac-of-${call.path.slice('probe/'.length)}` }),
    'POST exposure': (call) => {
      const { results } = call.body as { results: { path: string; status: number; sha256: string | null }[] };
      const hit = results.some((r) => r.sha256 === sha256(PROBE_CONTENT));
      return hit ? problem(422, 'INSTALL_EXPOSED', { detail: 'Berkas ALTIS dapat diambil lewat web / ALTIS files can be fetched through the web' }) : json({ ok: true });
    },
  };
}
