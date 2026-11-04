import {
  PROBE_SSE_INTERVAL_MS,
  PROBE_SSE_TICKS,
  XFF_ENTRIES_MAX,
  XFF_ENTRY_MAX_LENGTH,
  XFF_PROBE_FORGED,
  type ProbePollResponse,
  type ProbeResultBody,
} from '@altis/shared/api/diagnostics';
import { EXPOSURE_READ_MAX_BYTES, type ExposureCandidateItem } from '@altis/shared/api/install';
import { sha256Hex } from './sha256';

/**
 * The browser test (spec §9.5 step 1, §11, §2.4, P10, P15; plan Tasks 23, 30 and 32; decisions C22, C35), run by the
 * install wizard against `/install/api/probe` (the claim's holder) and by Diagnostik against
 * `/api/v1/diagnostics/probe` (signed-in staff). What each route answers is described in
 * `@altis/shared/api/diagnostics`. In order:
 *
 * 1. `GET poll`: the page can poll the server (`polling`), and the request's X-Forwarded-For chain as it arrived
 *    (`cleanXff`), with the hops it suggests and the client IP they would give (`suggestedHops`, `ipAtSuggested`).
 * 2. An `EventSource` on `sse`, opened alongside the rest: three `tick` events within 6 s, spread over at least 1 s (the
 *    route sends them 1 s apart; a proxy that buffers the stream delivers them in one burst at its end, which fails).
 *    The stream is closed once it delivered, or on `done` before the third tick, or on its first error (a 204 at the
 *    stream limit), or after 6 s.
 * 3. `PUT`, `PATCH`, `DELETE` on `methods`, each with its real method (never method override, which the route refuses):
 *    a 2xx JSON answer naming the method = the host lets it through.
 * 4. `POST chunk` (multipart/form-data, field `chunk`) of 5 MiB, halved after a 413, or a 403 that is not the server's
 *    problem+json (a WAF's page), down to 256 KiB: the largest size that passed, or null (lib/upload.ts reacts the same
 *    way to the same answers).
 * 5. `GET poll` again with `X-Forwarded-For: 203.0.113.77`: what the server derived from a forged chain
 *    (`forgedXff`, `forgedDerived`); the server decides `spoofable` from it (decision C22).
 * 6. Wizard only, given the candidates of `GET install/api/checks`: each URL path fetched at `location.origin + path`
 *    (no cache, no redirect followed, no cookies, 5 s, at most 64 KiB read, 4 at a time), its status and the SHA-256
 *    of what was read (WebCrypto; lib/sha256.ts where WebCrypto is missing, an insecure `http:` page) reported with
 *    `POST install/api/exposure`. The server compares the digests with the probe file, app.js and the data-dir pointer:
 *    422 INSTALL_EXPOSED → `exposed`, which blocks the install (§9.5 "Bila ada yang terambil → blokir").
 * 7. Wizard only: `GET probe/<nonce>` with a fresh random nonce → the HMAC the claim's secret gives it, which
 *    `POST install/api/config` hands back as the proof that this URL reaches this installation (§9.5 step 1.1).
 *
 * Every write carries `X-CSRF-Token: csrf()`. A probe that fails counts as its negative answer (false, null, empty);
 * only an aborted `signal` rejects (with its reason).
 */

export type ProbeBase = '/install/api/probe' | '/api/v1/diagnostics/probe';

/** The wizard's probe prefix: with it, steps 6 and 7 run. */
const WIZARD_BASE: ProbeBase = '/install/api/probe';
/** Where the wizard reports the exposure fetches. */
const EXPOSURE_PATH = '/install/api/exposure';

/** The first chunk tried, and the smallest (P10: 5 MB down to 256 KB). */
export const PROBE_CHUNK_START_BYTES = 5 * 1024 * 1024;
export const PROBE_CHUNK_MIN_BYTES = 256 * 1024;
/** The SSE probe's deadline for its three ticks. */
export const PROBE_SSE_TIMEOUT_MS = 6000;
/** The first and the last tick must arrive at least this far apart (half of the 2 s the route spreads them over). */
export const PROBE_SSE_MIN_SPREAD_MS = (PROBE_SSE_INTERVAL_MS * (PROBE_SSE_TICKS - 1)) / 2;
/** Each exposure fetch gets this long; at most EXPOSURE_READ_MAX_BYTES of its body are read and hashed. */
export const EXPOSURE_FETCH_TIMEOUT_MS = 5000;
/** `POST exposure` takes at most this many results. */
const EXPOSURE_RESULTS_MAX = 64;
/** Exposure candidates fetched at once: a host that silently drops paths costs 5 s per 4 candidates, not per 1. */
export const EXPOSURE_FETCH_CONCURRENCY = 4;

export interface BrowserProbeOptions {
  base: ProbeBase;
  /** The CSRF token every write carries (the wizard's, or the staff session's). */
  csrf(): string;
  /** Stops the test: the promise rejects with its reason. */
  signal?: AbortSignal;
  /** Wizard only: the exposure candidates of `GET install/api/checks` (step 6 runs only with them). */
  exposure?: readonly ExposureCandidateItem[];
  /** Sees every answer of the probe routes (Diagnostik: the API client's CSRF rotation and build check). */
  onResponse?(res: Response): void;
  /** Opens the SSE stream (default: `new EventSource(url)`; no EventSource → the SSE test fails). */
  openStream?(url: string): EventSource;
  /** The clock the SSE spread is measured with (default `performance.now()`). */
  now?(): number;
}

/** What became of the exposure test: nothing served, a file served (blocking), or the report failed. */
export type ExposureOutcome = { status: 'ok' } | { status: 'exposed' } | { status: 'error'; httpStatus: number };

export interface ProbeResults extends ProbeResultBody {
  /** The clean poll's suggestion (null when it failed). */
  suggestedHops: number | null;
  ipAtSuggested: string | null;
  /** Wizard only (null otherwise, or without candidates). */
  exposure: ExposureOutcome | null;
  /** Wizard only: the nonce and the HMAC `GET probe/<nonce>` answered (null otherwise, or when it failed). */
  baseUrlProof: { nonce: string; hmac: string } | null;
}

/** The part of {@link ProbeResults} that `POST diagnostics/probe-result` and the wizard's `POST config` take. */
export function probeResultBody(r: ProbeResults): ProbeResultBody {
  return {
    polling: r.polling,
    sse: r.sse,
    methods: { put: r.methods.put, patch: r.methods.patch, delete: r.methods.delete },
    chunkBytes: r.chunkBytes,
    xff: { cleanXff: [...r.xff.cleanXff], forgedXff: [...r.xff.forgedXff], forgedDerived: r.xff.forgedDerived },
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const isJson = (res: Response): boolean => /[/+]json\b/i.test(res.headers.get('Content-Type') ?? '');

const isProblemJson = (res: Response): boolean => /^\s*application\/problem\+json\b/i.test(res.headers.get('Content-Type') ?? '');

function isPoll(value: unknown): value is ProbePollResponse {
  return (
    isRecord(value) &&
    Array.isArray(value['xff']) &&
    value['xff'].every((e) => typeof e === 'string') &&
    (value['ip'] === null || typeof value['ip'] === 'string') &&
    typeof value['suggestedHops'] === 'number' &&
    typeof value['ipAtSuggested'] === 'string'
  );
}

/** An X-Forwarded-For chain as `ProbeResultBody` takes it: the last 10 entries, 64 characters each. */
const chain = (entries: readonly string[]): string[] => entries.slice(-XFF_ENTRIES_MAX).map((e) => e.slice(0, XFF_ENTRY_MAX_LENGTH));

/** A base64url nonce of 32 characters (24 random bytes), as PROBE_NONCE wants. */
function newNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** SHA-256 in lower-case hex: WebCrypto, or lib/sha256.ts where WebCrypto is missing (a page served over `http:`). */
async function digestHex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const subtle = typeof crypto === 'object' ? crypto.subtle : undefined;
  if (subtle === undefined) return sha256Hex(new Blob([bytes]));
  const digest = new Uint8Array(await subtle.digest('SHA-256', bytes));
  let hex = '';
  for (const byte of digest) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

/** At most `max` bytes of `res`'s body (the rest is not downloaded). */
async function readAtMost(res: Response, max: number): Promise<Uint8Array<ArrayBuffer>> {
  const out = new Uint8Array(max);
  if (res.body === null) return out.subarray(0, 0);
  const reader = res.body.getReader();
  let n = 0;
  try {
    while (n < max) {
      const { done, value } = await reader.read();
      if (done) break;
      const take = Math.min(value.byteLength, max - n);
      out.set(value.subarray(0, take), n);
      n += take;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return out.subarray(0, n);
}

/** A signal that aborts with `parent` or after `ms`; `done()` clears the timer. */
function deadline(parent: AbortSignal | undefined, ms: number): { signal: AbortSignal; done(): void } {
  const controller = new AbortController();
  const onAbort = (): void => controller.abort(parent?.reason);
  const timer = setTimeout(() => controller.abort(new DOMException('The probe timed out', 'TimeoutError')), ms);
  if (parent?.aborted) onAbort();
  else parent?.addEventListener('abort', onAbort, { once: true });
  return {
    signal: controller.signal,
    done() {
      clearTimeout(timer);
      parent?.removeEventListener('abort', onAbort);
    },
  };
}

/** Runs the browser test (see the top of this file). */
export async function runBrowserProbes(o: BrowserProbeOptions): Promise<ProbeResults> {
  o.signal?.throwIfAborted();
  const wizard = o.base === WIZARD_BASE;
  const now = o.now ?? (() => performance.now());

  /** `fn`'s answer, or `fallback` when it throws, unless the test was aborted (then the abort's reason). */
  async function guard<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
    try {
      return await fn();
    } catch {
      o.signal?.throwIfAborted();
      return fallback;
    }
  }

  /** A request to a probe route (`sub` below `o.base`, or an absolute path). */
  async function send(method: string, sub: string, init: { headers?: Record<string, string>; body?: BodyInit } = {}): Promise<Response> {
    const headers: Record<string, string> = { Accept: 'application/json', ...init.headers };
    if (method !== 'GET') headers['X-CSRF-Token'] = o.csrf();
    const res = await fetch(sub.startsWith('/') ? sub : `${o.base}/${sub}`, {
      method,
      headers,
      credentials: 'same-origin',
      cache: 'no-store',
      ...(init.body === undefined ? {} : { body: init.body }),
      ...(o.signal === undefined ? {} : { signal: o.signal }),
    });
    o.onResponse?.(res);
    return res;
  }

  /** The body of a 2xx JSON answer, or undefined (anything else). */
  async function jsonOf(res: Response): Promise<unknown> {
    if (!res.ok || !isJson(res)) {
      res.body?.cancel().catch(() => {});
      return undefined;
    }
    return res.json();
  }

  const poll = (forged: boolean): Promise<ProbePollResponse | null> =>
    guard(async () => {
      const body = await jsonOf(await send('GET', 'poll', forged ? { headers: { 'X-Forwarded-For': XFF_PROBE_FORGED } } : {}));
      return isPoll(body) ? body : null;
    }, null);

  function sseProbe(): Promise<boolean> {
    const open = o.openStream ?? (typeof EventSource === 'function' ? (url: string) => new EventSource(url) : undefined);
    if (open === undefined) return Promise.resolve(false);
    return new Promise((resolve) => {
      const times: number[] = [];
      let stream: EventSource | undefined;
      let settled = false;
      const finish = (ok: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        o.signal?.removeEventListener('abort', onAbort);
        stream?.close();
        resolve(ok);
      };
      const onAbort = (): void => finish(false);
      // Declared before anything can call `finish`.
      const timer = setTimeout(() => finish(false), PROBE_SSE_TIMEOUT_MS);
      o.signal?.addEventListener('abort', onAbort, { once: true });
      try {
        stream = open(`${o.base}/sse`);
      } catch {
        finish(false);
        return;
      }
      stream.addEventListener('tick', () => {
        times.push(now());
        if (times.length >= PROBE_SSE_TICKS) finish(times[times.length - 1]! - times[0]! >= PROBE_SSE_MIN_SPREAD_MS);
      });
      // `done` follows the last tick: arriving before the third, some ticks were lost on the way.
      stream.addEventListener('done', () => finish(false));
      stream.addEventListener('error', () => finish(false));
    });
  }

  const method = (m: 'PUT' | 'PATCH' | 'DELETE'): Promise<boolean> =>
    guard(async () => {
      const body = await jsonOf(await send(m, 'methods'));
      return isRecord(body) && body['method'] === m;
    }, false);

  async function chunkProbe(): Promise<number | null> {
    for (let size = PROBE_CHUNK_START_BYTES; ; size = Math.max(PROBE_CHUNK_MIN_BYTES, Math.floor(size / 2))) {
      const tooLarge = await guard(async () => {
        const form = new FormData();
        form.append('chunk', new Blob([new Uint8Array(size)], { type: 'application/octet-stream' }), 'probe.bin');
        const res = await send('POST', 'chunk', { body: form });
        res.body?.cancel().catch(() => {});
        if (res.ok) return false;
        return res.status === 413 || (res.status === 403 && !isProblemJson(res)) ? true : null;
      }, null);
      if (tooLarge === false) return size;
      if (tooLarge === null || size === PROBE_CHUNK_MIN_BYTES) return null;
    }
  }

  /** One exposure candidate: its status (0 without an answer) and the digest of up to 64 KiB of its body. */
  async function fetchCandidate(path: string): Promise<{ path: string; status: number; sha256: string | null }> {
    const limit = deadline(o.signal, EXPOSURE_FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(`${location.origin}${path}`, { cache: 'no-store', redirect: 'manual', credentials: 'omit', signal: limit.signal });
      if (res.type === 'opaqueredirect' || res.status < 100 || res.status > 999) return { path, status: 0, sha256: null };
      return { path, status: res.status, sha256: await digestHex(await readAtMost(res, EXPOSURE_READ_MAX_BYTES)) };
    } catch {
      o.signal?.throwIfAborted();
      return { path, status: 0, sha256: null };
    } finally {
      limit.done();
    }
  }

  async function exposureProbe(candidates: readonly ExposureCandidateItem[]): Promise<ExposureOutcome> {
    const paths = candidates.slice(0, EXPOSURE_RESULTS_MAX).map((c) => c.path);
    const results: { path: string; status: number; sha256: string | null }[] = new Array(paths.length);
    let next = 0;
    const lane = async (): Promise<void> => {
      while (next < paths.length) {
        const i = next++;
        results[i] = await fetchCandidate(paths[i]!);
      }
    };
    await Promise.all(Array.from({ length: Math.min(EXPOSURE_FETCH_CONCURRENCY, paths.length) }, lane));
    return guard<ExposureOutcome>(async () => {
      const res = await send('POST', EXPOSURE_PATH, { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ results }) });
      if (res.ok) {
        res.body?.cancel().catch(() => {});
        return { status: 'ok' };
      }
      const problem: unknown = isJson(res) ? await res.json().catch(() => undefined) : undefined;
      if (res.status === 422 && isRecord(problem) && problem['code'] === 'INSTALL_EXPOSED') return { status: 'exposed' };
      return { status: 'error', httpStatus: res.status };
    }, { status: 'error', httpStatus: 0 });
  }

  const proofProbe = (): Promise<{ nonce: string; hmac: string } | null> =>
    guard(async () => {
      const nonce = newNonce();
      const body = await jsonOf(await send('GET', nonce));
      return isRecord(body) && typeof body['hmac'] === 'string' && body['hmac'] !== '' ? { nonce, hmac: body['hmac'] } : null;
    }, null);

  // (2) runs alongside the others (its 2 s of ticks would otherwise add to the wait). It never rejects, and it ends by
  // itself on an abort, so nothing is left behind when a later step throws.
  const sse = sseProbe();
  const clean = await poll(false);
  const methods = { put: await method('PUT'), patch: await method('PATCH'), delete: await method('DELETE') };
  const chunkBytes = await chunkProbe();
  const forged = await poll(true);
  const exposure = wizard && o.exposure !== undefined ? await exposureProbe(o.exposure) : null;
  const baseUrlProof = wizard ? await proofProbe() : null;
  const sseOk = await sse;
  o.signal?.throwIfAborted();
  return {
    polling: clean !== null,
    sse: sseOk,
    methods,
    chunkBytes,
    xff: { cleanXff: chain(clean?.xff ?? []), forgedXff: chain(forged?.xff ?? []), forgedDerived: (forged?.ip ?? '').slice(0, XFF_ENTRY_MAX_LENGTH) },
    suggestedHops: clean?.suggestedHops ?? null,
    ipAtSuggested: clean?.ipAtSuggested ?? null,
    exposure,
    baseUrlProof,
  };
}
