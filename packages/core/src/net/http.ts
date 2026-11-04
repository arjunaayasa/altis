// Outbound HTTP (spec §6.1, Global Constraints "Outbound HTTP", preflight S8): the one way the server reaches another
// host (SRU servers, ISBN lookups). `node:http`/`node:https` only, never the global fetch (P18). Never called inside a
// database transaction (the routes that use it are `tx: 'self'`).
//
// - Limits: connect 5 s, total 10 s (DNS, every hop and the body), at most 5 MB of body, at most 3 redirects, `http:`
//   and `https:` only (a redirect target included). A caller may ask for less time or fewer bytes, never more.
// - SSRF guard: the name is resolved once (`lookup(host, {all: true})`), every address must pass the guard (ssrf.ts),
//   and the socket connects only to those checked addresses (a pinned `lookup` on the request: no second resolution,
//   so DNS rebinding cannot swap them). `Host` stays the original name and TLS sends it as SNI, except for an IP
//   literal (no SNI for an address); the certificate is verified as usual. Each redirect hop is resolved and checked
//   again.
// - No compression: the client sends no `Accept-Encoding` (a caller's is dropped) and refuses an answer with a
//   `Content-Encoding` other than `identity`, so the byte limit counts the bytes actually received. A declared
//   Content-Length above the limit is refused before the body; otherwise the transfer is cut the moment it passes.
// - Failures are DomainErrors: `CATALOG_OUTBOUND_BLOCKED` (422) for a refused address, `CATALOG_OUTBOUND_FAILED` (502)
//   with `meta.reason` otherwise, plus `meta.status` for reason `status`. A caller's AbortSignal ends the request as
//   reason `timeout` (callers abort for a time budget, e.g. the ISBN lookup's overall 12 s).

import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { DomainError } from '@altis/shared';
import { isBlockedAddress, isForbiddenAddress } from './ssrf.js';

/** Time to connect (TCP, and the TLS handshake for https). */
export const OUTBOUND_CONNECT_MS = 5000;
/** Time for the whole request: resolution, every redirect hop and the body. */
export const OUTBOUND_TOTAL_MS = 10_000;
/** Largest response body. */
export const OUTBOUND_MAX_BYTES = 5 * 1024 * 1024;
/** Redirects followed; the next one fails with reason `redirect`. */
export const OUTBOUND_MAX_REDIRECTS = 3;

/** `meta.reason` of `CATALOG_OUTBOUND_FAILED`. */
export type OutboundFailure = 'timeout' | 'too_large' | 'status' | 'network' | 'redirect' | 'scheme' | 'encoding';

/** One outbound request. */
export interface OutboundRequest {
  /** `http:` or `https:` only. */
  url: string;
  method?: 'GET' | 'POST';
  /** Extra request headers. `Host`, `Accept-Encoding`, `Content-Length` and hop-by-hop headers are the client's own. */
  headers?: Record<string, string>;
  body?: Uint8Array;
  /** Allow loopback and private addresses (`catalog.sru.allowPrivateHosts`, super admin only, M11). */
  allowPrivate: boolean;
  /** Ends the request as reason `timeout`. */
  signal?: AbortSignal;
  /** Total time; default and ceiling 10 000 ms. */
  timeoutMs?: number;
  /** Largest response body; default and ceiling 5 MB. */
  maxBytes?: number;
}

/** Its answer: the status, the headers (lower-case names), the whole body, and the URL after redirects. */
export interface OutboundResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  finalUrl: string;
}

/** A resolver as `dns.promises.lookup(host, {all: true})`: every address of `hostname`. */
export type LookupFn = (hostname: string, options: { all: true }) => Promise<{ address: string; family: number }[]>;

/** What a test may swap (test build profile only, R57). */
interface OutboundDeps {
  lookup?: LookupFn;
  /** Replaces the whole address check (allowPrivate included). */
  blocked?: (ip: string) => boolean;
}

interface CheckedAddress {
  address: string;
  family: 4 | 6;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Request headers the client sets itself (or never sends): a caller's value is dropped. */
const CLIENT_HEADERS = new Set([
  'host',
  'accept-encoding',
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'proxy-connection',
  'te',
  'trailer',
  'upgrade',
]);

/** Dropped when a redirect leaves the origin. */
const CREDENTIAL_HEADERS = ['authorization', 'cookie', 'proxy-authorization'];

const USER_AGENT = 'ALTIS (Arsya Library Tracking Information System)';

/** The system resolver, with the hints Node's own connect uses. */
const systemLookup: LookupFn = (hostname, options) => dns.promises.lookup(hostname, { ...options, hints: dns.ADDRCONFIG });

function outboundFailed(reason: OutboundFailure, o: { status?: number; cause?: unknown } = {}): DomainError {
  return new DomainError('CATALOG_OUTBOUND_FAILED', {
    meta: o.status === undefined ? { reason } : { reason, status: o.status },
    ...(o.cause === undefined ? {} : { cause: o.cause }),
  });
}

/** `deps` in the test build profile; nothing in production, where the real resolver and guard always apply (R57). */
function testDeps(deps: OutboundDeps | undefined): OutboundDeps {
  if (typeof __BUILD_PROFILE__ !== 'undefined' && __BUILD_PROFILE__ === 'test' && deps !== undefined) return deps;
  return {};
}

/** A caller's limit: a positive integer, held to `ceiling`; `ceiling` when not given. */
function bounded(name: string, value: number | undefined, ceiling: number): number {
  if (value === undefined) return ceiling;
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`httpRequest: ${name} must be a positive integer`);
  return Math.min(value, ceiling);
}

function isHttpScheme(url: URL): boolean {
  return url.protocol === 'http:' || url.protocol === 'https:';
}

/** The host of `url` without the brackets of an IPv6 literal. */
function hostOf(url: URL): string {
  const host = url.hostname;
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

/** `p`, or the abort reason of `signal` as soon as it aborts (a lookup cannot be cancelled, only left behind). */
function untilAborted<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/** Resolves `host` once and checks every address it has; an IP literal is checked as it is. */
async function resolveChecked(host: string, lookup: LookupFn, refused: (ip: string) => boolean, signal: AbortSignal): Promise<CheckedAddress[]> {
  let answers: { address: string; family: number }[];
  if (isIP(host) !== 0) {
    answers = [{ address: host, family: isIP(host) }];
  } else {
    try {
      answers = await untilAborted(lookup(host, { all: true }), signal);
    } catch (e) {
      if (signal.aborted) throw signal.reason;
      throw outboundFailed('network', { cause: e });
    }
  }
  if (!Array.isArray(answers) || answers.length === 0) throw outboundFailed('network');
  const checked: CheckedAddress[] = [];
  for (const answer of answers) {
    const address: unknown = answer?.address;
    const family = typeof address === 'string' ? isIP(address) : 0;
    if (typeof address !== 'string' || family === 0 || refused(address)) throw new DomainError('CATALOG_OUTBOUND_BLOCKED');
    checked.push({ address, family: family === 4 ? 4 : 6 });
  }
  return checked;
}

/** A `lookup` for the socket that answers the checked addresses and never asks DNS. */
function pinnedLookup(addresses: readonly CheckedAddress[]): LookupFunction {
  const first = addresses[0]!;
  return (_hostname, options, callback) => {
    if (options.all === true) process.nextTick(callback, null, addresses.map((a) => ({ address: a.address, family: a.family })));
    else process.nextTick(callback, null, first.address, first.family);
  };
}

/** The caller's headers with lower-case names, without the client's own. */
function callerHeaders(given: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(given ?? {})) {
    const key = name.toLowerCase();
    if (!CLIENT_HEADERS.has(key)) out[key] = value;
  }
  return out;
}

function withoutHeaders(headers: Record<string, string>, names: readonly string[]): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !names.includes(name)));
}

/** True when `value` (a Content-Encoding header) names no coding but `identity`. */
function identityOnly(value: string | undefined): boolean {
  if (value === undefined) return true;
  return value.split(',').every((token) => {
    const coding = token.trim().toLowerCase();
    return coding === '' || coding === 'identity';
  });
}

function flatHeaders(headers: http.IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined) out[name] = Array.isArray(value) ? value.join(', ') : value;
  }
  return out;
}

interface Hop {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body: Uint8Array | undefined;
  addresses: readonly CheckedAddress[];
}

type HopAnswer =
  | { kind: 'redirect'; status: number; location: string }
  | { kind: 'done'; status: number; headers: Record<string, string>; body: Buffer };

/** One request to the checked addresses of `hop.url`: a redirect to follow, or the final answer. */
function exchange(hop: Hop, signal: AbortSignal, maxBytes: number): Promise<HopAnswer> {
  return new Promise<HopAnswer>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const secure = hop.url.protocol === 'https:';
    const host = hostOf(hop.url);
    const options: https.RequestOptions = {
      host,
      port: hop.url.port === '' ? (secure ? 443 : 80) : Number(hop.url.port),
      path: `${hop.url.pathname}${hop.url.search}`,
      method: hop.method,
      headers: hop.headers,
      // A fresh connection for each request: nothing pooled, nothing left open.
      agent: false,
      lookup: pinnedLookup(hop.addresses),
      // SNI is the original name; none for an IP literal ('' turns it off).
      ...(secure ? { servername: isIP(host) === 0 ? host : '' } : {}),
    };
    const request = (secure ? https : http).request(options);
    let connectTimer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const settle = (error: unknown, answer?: HopAnswer): void => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      signal.removeEventListener('abort', onAbort);
      request.destroy();
      if (answer === undefined) reject(error);
      else resolve(answer);
    };
    const onAbort = (): void => settle(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });

    request.on('error', (e) => settle(outboundFailed('network', { cause: e })));
    request.on('socket', (socket) => {
      if (settled) return;
      connectTimer = setTimeout(() => settle(outboundFailed('timeout')), OUTBOUND_CONNECT_MS);
      socket.once(secure ? 'secureConnect' : 'connect', () => clearTimeout(connectTimer));
    });
    request.on('response', (res) => {
      clearTimeout(connectTimer);
      res.on('error', (e) => settle(outboundFailed('network', { cause: e })));
      const status = res.statusCode ?? 0;
      const location = res.headers.location;
      if (REDIRECT_STATUSES.has(status) && location !== undefined && location !== '') {
        settle(null, { kind: 'redirect', status, location });
        return;
      }
      if (status < 200 || status > 299) {
        settle(outboundFailed('status', { status }));
        return;
      }
      if (!identityOnly(res.headers['content-encoding'])) {
        settle(outboundFailed('encoding'));
        return;
      }
      const declared = res.headers['content-length'];
      if (declared !== undefined && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
        settle(outboundFailed('too_large'));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) settle(outboundFailed('too_large'));
        else chunks.push(chunk);
      });
      res.on('end', () => settle(null, { kind: 'done', status, headers: flatHeaders(res.headers), body: Buffer.concat(chunks) }));
      res.on('close', () => {
        if (!res.complete) settle(outboundFailed('network'));
      });
    });
    request.end(hop.body);
  });
}

/**
 * Sends `req` (see the top of this file). `deps` replaces the resolver and the address check, in the test build profile
 * only (R57).
 *
 * @throws DomainError `CATALOG_OUTBOUND_BLOCKED` for an address the guard refuses; `CATALOG_OUTBOUND_FAILED` with
 *   `meta.reason` (`timeout`, `too_large`, `status`, `network`, `redirect`, `scheme`, `encoding`)
 * @throws RangeError for a `timeoutMs` or `maxBytes` that is not a positive integer
 */
export async function httpRequest(req: OutboundRequest, deps?: { lookup?: LookupFn; blocked?: (ip: string) => boolean }): Promise<OutboundResponse> {
  const hooks = testDeps(deps);
  const lookup = hooks.lookup ?? systemLookup;
  const refused = hooks.blocked ?? (req.allowPrivate ? isForbiddenAddress : isBlockedAddress);
  const timeoutMs = bounded('timeoutMs', req.timeoutMs, OUTBOUND_TOTAL_MS);
  const maxBytes = bounded('maxBytes', req.maxBytes, OUTBOUND_MAX_BYTES);

  let url: URL;
  try {
    url = new URL(req.url);
  } catch (e) {
    throw outboundFailed('scheme', { cause: e });
  }
  if (!isHttpScheme(url)) throw outboundFailed('scheme');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(outboundFailed('timeout')), timeoutMs);
  const callerSignal = req.signal;
  const onCallerAbort = (): void => controller.abort(outboundFailed('timeout', { cause: callerSignal?.reason }));
  if (callerSignal?.aborted === true) onCallerAbort();
  else callerSignal?.addEventListener('abort', onCallerAbort, { once: true });
  try {
    let method = req.method ?? 'GET';
    let body = req.body;
    let extra = callerHeaders(req.headers);
    for (let redirects = 0; ; redirects++) {
      const addresses = await resolveChecked(hostOf(url), lookup, refused, controller.signal);
      const headers: Record<string, string> = { 'user-agent': USER_AGENT, ...extra, host: url.host };
      if (body !== undefined) headers['content-length'] = String(body.byteLength);
      const answer = await exchange({ url, method, headers, body, addresses }, controller.signal, maxBytes);
      if (answer.kind === 'done') return { status: answer.status, headers: answer.headers, body: answer.body, finalUrl: url.href };

      if (redirects >= OUTBOUND_MAX_REDIRECTS) throw outboundFailed('redirect');
      let next: URL;
      try {
        next = new URL(answer.location, url);
      } catch (e) {
        throw outboundFailed('redirect', { cause: e });
      }
      if (!isHttpScheme(next)) throw outboundFailed('scheme');
      if (answer.status === 303 || ((answer.status === 301 || answer.status === 302) && method === 'POST')) {
        method = 'GET';
        body = undefined;
        extra = withoutHeaders(extra, ['content-type']);
      }
      if (next.origin !== url.origin) extra = withoutHeaders(extra, CREDENTIAL_HEADERS);
      url = next;
    }
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener('abort', onCallerAbort);
  }
}
