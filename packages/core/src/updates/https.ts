import http from 'node:http';
import https from 'node:https';
import { DomainError, isDomainError } from '@altis/shared';

// Outbound requests of the feed client (spec §9.6, P18; plan Task 20). The update server is reached over node:https
// only, never through the global fetch or undici: every request has a timeout and a size limit, follows at most
// FETCH_MAX_REDIRECTS redirects, and never leaves https once it is on it. Plain http is allowed for 127.0.0.1, ::1 and
// localhost alone, and only in a test build whose caller asks for it (`allowLoopbackHttp`: feed-dev in tests and the
// release smoke); a production build folds that branch away, so it can only ever speak https.
//
// Failures are DomainErrors with `meta.reason`:
// - feed files (fetchText): FEED_UNREACHABLE, reason `insecure` (not an https URL, credentials in it, or a redirect
//   off https), `network` (no connection, TLS, a body cut short), `status` (an answer other than 200, a redirect
//   without Location or one too many), `timeout`, `too_large`;
// - package bytes (fetchRange): UPDATE_DOWNLOAD_FAILED with `insecure`, `network`, `status` or `timeout`.
// Both codes are 5xx: the reason stays server-side (op.json, the `update.check` setting), never in a response.

/** fetchText's default bound on the whole exchange, redirects included. */
export const FETCH_TIMEOUT_MS = 30_000;
/** fetchText's default bound on a body. */
export const FETCH_MAX_BYTES = 2 * 1024 * 1024;
/** Redirects followed per request (§9.6 mirrors, CDNs); one more is a `status` failure. */
export const FETCH_MAX_REDIRECTS = 3;
/** fetchRange gives up (`timeout`) when its connection stays silent this long, deadline or not. */
export const DOWNLOAD_IDLE_TIMEOUT_MS = 30_000;

/** What a failed request says in `meta.reason`. */
export type FetchFailureReason = 'insecure' | 'network' | 'status' | 'timeout' | 'too_large';

type FailureCode = 'FEED_UNREACHABLE' | 'UPDATE_DOWNLOAD_FAILED';

/** The hosts plain http may reach (URL.hostname spells IPv6 in brackets). */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', '[::1]', 'localhost']);
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);
/** setTimeout's longest delay; a longer deadline is checked again when this one fires. */
const MAX_TIMER_MS = 2_147_483_647;
const USER_AGENT = 'ALTIS-update';

/** Why a request failed, in Indonesian and in English (the detail stays server-side: op.json, the check's error). */
const WHY: Readonly<Record<FetchFailureReason, readonly [string, string]>> = {
  insecure: ['alamatnya bukan https', 'the address is not https'],
  network: ['koneksinya gagal', 'the connection failed'],
  status: ['jawaban servernya tidak dapat dipakai', 'the server answer cannot be used'],
  timeout: ['waktunya habis', 'it timed out'],
  too_large: ['jawabannya terlalu besar', 'the answer is too large'],
};

function failure(code: FailureCode, reason: FetchFailureReason, o: { host?: string; status?: number; cause?: unknown } = {}): DomainError {
  const meta: Record<string, unknown> = { reason };
  if (o.host !== undefined) meta['host'] = o.host;
  if (o.status !== undefined) meta['status'] = o.status;
  const [id, en] = WHY[reason];
  const answer = o.status === undefined ? '' : ` (HTTP ${o.status})`;
  const detail =
    code === 'FEED_UNREACHABLE'
      ? `Server pembaruan tidak dapat dipakai: ${id}${answer} / The update server cannot be used: ${en}${answer}`
      : `Paket pembaruan tidak dapat diunduh: ${id}${answer} / The update package cannot be downloaded: ${en}${answer}`;
  return new DomainError(code, { detail, meta, cause: o.cause });
}

/** Plain http to loopback: only a test build, and only when the caller asks. A production build folds this to false. */
function loopbackHttpAllowed(allowLoopbackHttp: boolean): boolean {
  if (typeof __BUILD_PROFILE__ !== 'undefined' && __BUILD_PROFILE__ === 'test') return allowLoopbackHttp === true;
  return false;
}

/**
 * The URL the feed client may request: an https URL without user or password, or (test builds asked to allow it)
 * plain http to 127.0.0.1, [::1] or localhost. Null for anything else, unparsable text included.
 */
export function updateUrl(text: unknown, allowLoopbackHttp: boolean): URL | null {
  if (typeof text !== 'string') return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.username !== '' || url.password !== '') return null;
  if (url.protocol === 'https:') return url;
  if (url.protocol === 'http:' && loopbackHttpAllowed(allowLoopbackHttp) && LOOPBACK_HOSTS.has(url.hostname)) return url;
  return null;
}

/**
 * Where a redirect from `from` to `location` (resolved against `from`) may go: https to https only, and otherwise
 * what {@link updateUrl} allows. Null when it may not.
 */
export function redirectTarget(from: URL, location: string, allowLoopbackHttp: boolean): URL | null {
  let next: URL;
  try {
    next = new URL(location, from);
  } catch {
    return null;
  }
  if (from.protocol === 'https:' && next.protocol !== 'https:') return null;
  return updateUrl(next.href, allowLoopbackHttp);
}

interface Opened {
  res: http.IncomingMessage;
  status: number;
  url: URL;
}

/** One GET of `url`; resolves with the response once its headers are in. */
function requestOnce(url: URL, headers: Record<string, string>, signal: AbortSignal): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    let req: http.ClientRequest;
    try {
      const transport = url.protocol === 'https:' ? https : http;
      // agent: false: one connection per request, closed after it (no pooled socket keeps a CLI process alive).
      req = transport.request(url, { method: 'GET', headers, agent: false, signal }, (res) => {
        res.on('error', () => {}); // the body's reader sees the error; an unread body must not crash the process
        resolve(res);
      });
    } catch (error) {
      reject(error);
      return;
    }
    req.on('error', reject); // after the response this is a no-op: the body's reader reports it
    req.end();
  });
}

/**
 * GETs `first`, following up to {@link FETCH_MAX_REDIRECTS} redirects (each checked by {@link redirectTarget}); the
 * final response, of any other status, is returned unread.
 */
async function openFollowing(first: URL, o: { code: FailureCode; headers: Record<string, string>; signal: AbortSignal; allowLoopbackHttp: boolean }): Promise<Opened> {
  let url = first;
  for (let hops = 0; ; hops += 1) {
    const res = await requestOnce(url, o.headers, o.signal);
    const status = res.statusCode ?? 0;
    if (!REDIRECT_STATUSES.has(status)) return { res, status, url };
    res.destroy();
    const location = res.headers.location;
    if (hops >= FETCH_MAX_REDIRECTS || typeof location !== 'string' || location === '') {
      throw failure(o.code, 'status', { host: url.host, status });
    }
    const next = redirectTarget(url, location, o.allowLoopbackHttp);
    if (next === null) throw failure(o.code, 'insecure', { host: url.host, status });
    url = next;
  }
}

/** The Content-Length of `res`, or null when it has none (chunked) or an unreadable one. */
function contentLength(res: http.IncomingMessage): number | null {
  const value = res.headers['content-length'];
  if (typeof value !== 'string' || !/^\d{1,15}$/.test(value)) return null;
  return Number(value);
}

export interface FetchTextOptions {
  /** The whole exchange, redirects included (default {@link FETCH_TIMEOUT_MS}). */
  timeoutMs?: number;
  /** The longest body read (default {@link FETCH_MAX_BYTES}). */
  maxBytes?: number;
  /** Test builds: plain http to 127.0.0.1, ::1 and localhost too. Ignored by a production build. */
  allowLoopbackHttp: boolean;
}

/**
 * The body of a 200 answer to GET `url`, as UTF-8 text (a feed file). See the top of this file for the URLs allowed,
 * the redirects followed and the bounds.
 *
 * @throws DomainError `FEED_UNREACHABLE` with `meta.reason` `insecure`, `network`, `status` (`meta.status`), `timeout`
 *   or `too_large` (`meta.host` where a request was made)
 * @throws RangeError for a `timeoutMs` or `maxBytes` that is not a positive safe integer
 */
export async function fetchText(url: string, o: FetchTextOptions): Promise<string> {
  const timeoutMs = o.timeoutMs ?? FETCH_TIMEOUT_MS;
  const maxBytes = o.maxBytes ?? FETCH_MAX_BYTES;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new RangeError('fetchText: timeoutMs must be a positive integer');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new RangeError('fetchText: maxBytes must be a positive integer');
  const code: FailureCode = 'FEED_UNREACHABLE';
  const target = updateUrl(url, o.allowLoopbackHttp);
  if (target === null) throw failure(code, 'insecure');

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(
    () => {
      timedOut = true;
      controller.abort();
    },
    Math.min(timeoutMs, MAX_TIMER_MS),
  );
  let host = target.host;
  try {
    const opened = await openFollowing(target, {
      code,
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', 'Accept-Encoding': 'identity' },
      signal: controller.signal,
      allowLoopbackHttp: o.allowLoopbackHttp,
    });
    host = opened.url.host;
    const { res, status } = opened;
    if (status !== 200) {
      res.destroy();
      throw failure(code, 'status', { host, status });
    }
    const declared = contentLength(res);
    if (declared !== null && declared > maxBytes) {
      res.destroy();
      throw failure(code, 'too_large', { host });
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of res as AsyncIterable<Buffer>) {
      size += chunk.length;
      if (size > maxBytes) {
        res.destroy();
        throw failure(code, 'too_large', { host });
      }
      chunks.push(chunk);
    }
    if (!res.complete) throw failure(code, 'network', { host });
    return Buffer.concat(chunks).toString('utf8');
  } catch (error) {
    if (isDomainError(error)) throw error;
    throw failure(code, timedOut ? 'timeout' : 'network', { host, cause: error });
  } finally {
    clearTimeout(timer);
  }
}

export interface FetchRangeOptions {
  /** The first byte wanted: `Range: bytes=<start>-` when above 0. */
  start: number;
  /**
   * Epoch ms (`Date.now()`): the transfer stops after the chunk in hand once it passes, and fetchRange returns
   * `ended: false`. `Infinity` for none. A deadline that passes before the answer's headers arrive is a `timeout`.
   */
  deadline: number;
  /** Test builds: plain http to 127.0.0.1, ::1 and localhost too. Ignored by a production build. */
  allowLoopbackHttp: boolean;
  /**
   * Called once with the answer's status and total size, before any byte is handed to `onChunk`. A 200 to a request
   * with `start` > 0 means the server ignored the range: its body starts at byte 0. Its error ends the transfer and is
   * thrown as it is.
   */
  onResponse?(r: { status: 200 | 206; total: number | null }): Promise<void>;
  /** Each piece of the body in order, awaited before the next is read. Its error ends the transfer and is thrown as it is. */
  onChunk(bytes: Uint8Array): Promise<void>;
}

export interface FetchRangeResult {
  /** 206: the body starts at `start`; 200: the server sent the whole file from byte 0. */
  status: 200 | 206;
  /** The size of the whole file when the server says it (Content-Range's length, a 200's Content-Length), else null. */
  total: number | null;
  /** True when the body arrived whole; false when the deadline stopped it. */
  ended: boolean;
}

/** `bytes <first>-<last>/<total or *>` of a 206. */
const CONTENT_RANGE = /^bytes (\d{1,15})-(\d{1,15})\/(\d{1,15}|\*)$/;

/**
 * GETs the package bytes of `url` from byte `o.start` (resumable download, spec §9.6 "berpotongan dan bisa
 * dilanjutkan"), handing the body to `o.onChunk` piece by piece. See the top of this file for the URLs allowed and
 * the redirects followed. A connection silent for {@link DOWNLOAD_IDLE_TIMEOUT_MS} fails with `timeout`.
 *
 * @throws DomainError `UPDATE_DOWNLOAD_FAILED` with `meta.reason` `insecure`, `network` (also a body cut short: the
 *   bytes before the cut were handed to `onChunk`), `status` (`meta.status`: an answer other than 200/206, 416
 *   included, a 206 for another range than asked, too many redirects) or `timeout` (no answer by the deadline, or a
 *   silent connection); the error of `onResponse` or `onChunk` as it is
 * @throws TypeError for a `start` that is not a non-negative safe integer, a `deadline` that is not a number, or no
 *   `onChunk`
 */
export async function fetchRange(url: string, o: FetchRangeOptions): Promise<FetchRangeResult> {
  if (!Number.isSafeInteger(o.start) || o.start < 0) throw new TypeError('fetchRange: start must be a non-negative integer');
  if (typeof o.deadline !== 'number' || Number.isNaN(o.deadline)) throw new TypeError('fetchRange: deadline must be a number (epoch ms)');
  if (typeof o.onChunk !== 'function') throw new TypeError('fetchRange: onChunk must be a function');
  const code: FailureCode = 'UPDATE_DOWNLOAD_FAILED';
  const target = updateUrl(url, o.allowLoopbackHttp);
  if (target === null) throw failure(code, 'insecure');
  let host = target.host;
  if (!(o.deadline - Date.now() > 0)) throw failure(code, 'timeout', { host });

  const controller = new AbortController();
  let stop: 'deadline' | 'idle' | null = null;
  const halt = (why: 'deadline' | 'idle'): void => {
    if (stop === null) stop = why;
    controller.abort();
  };
  // The deadline, measured on the monotonic clock from now on, so a clock step cannot stretch it.
  const deadlineAt = performance.now() + (o.deadline - Date.now());
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const armDeadline = (): void => {
    const left = deadlineAt - performance.now();
    if (!Number.isFinite(left)) return;
    if (left <= 0) {
      halt('deadline');
      return;
    }
    deadlineTimer = setTimeout(armDeadline, Math.min(left, MAX_TIMER_MS));
  };
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const touch = (): void => {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => halt('idle'), DOWNLOAD_IDLE_TIMEOUT_MS);
  };
  armDeadline();
  touch();

  /** A callback's own error: thrown as it is. */
  const callback: { failed: boolean; error: unknown } = { failed: false, error: undefined };
  const passed = (): boolean => stop === 'deadline' || performance.now() >= deadlineAt;
  try {
    const headers: Record<string, string> = { 'User-Agent': USER_AGENT, Accept: 'application/octet-stream', 'Accept-Encoding': 'identity' };
    if (o.start > 0) headers['Range'] = `bytes=${o.start}-`;
    let opened: Opened;
    try {
      opened = await openFollowing(target, { code, headers, signal: controller.signal, allowLoopbackHttp: o.allowLoopbackHttp });
    } catch (error) {
      if (isDomainError(error)) throw error;
      // No answer yet: a deadline reached here is a timeout, there is nothing to return.
      throw failure(code, stop === null ? 'network' : 'timeout', { host, cause: error });
    }
    host = opened.url.host;
    const { res } = opened;
    touch();

    let status: 200 | 206;
    let total: number | null;
    if (opened.status === 206) {
      const m = CONTENT_RANGE.exec(String(res.headers['content-range'] ?? ''));
      if (m === null || Number(m[1]) !== o.start || Number(m[2]) < Number(m[1])) {
        res.destroy();
        throw failure(code, 'status', { host, status: 206 });
      }
      status = 206;
      total = m[3] === '*' ? null : Number(m[3]);
    } else if (opened.status === 200) {
      status = 200;
      total = contentLength(res);
    } else {
      res.destroy();
      throw failure(code, 'status', { host, status: opened.status });
    }

    if (o.onResponse !== undefined) {
      try {
        await o.onResponse({ status, total });
      } catch (error) {
        callback.failed = true;
        callback.error = error;
        res.destroy();
        throw error;
      }
    }

    try {
      for await (const chunk of res as AsyncIterable<Buffer>) {
        touch();
        try {
          await o.onChunk(chunk);
        } catch (error) {
          callback.failed = true;
          callback.error = error;
          throw error;
        }
        if (passed()) {
          stop = 'deadline';
          break;
        }
      }
    } catch (error) {
      if (callback.failed) throw callback.error;
      if (stop === 'deadline') return { status, total, ended: false };
      throw failure(code, stop === 'idle' ? 'timeout' : 'network', { host, cause: error });
    } finally {
      if (!res.complete) res.destroy();
    }
    if (stop === 'deadline') return { status, total, ended: false };
    if (stop === 'idle') throw failure(code, 'timeout', { host });
    if (!res.complete) throw failure(code, 'network', { host });
    return { status, total, ended: true };
  } catch (error) {
    if (callback.failed && error === callback.error) throw error;
    if (isDomainError(error)) throw error;
    throw failure(code, stop === null ? 'network' : 'timeout', { host, cause: error });
  } finally {
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
    if (idleTimer !== undefined) clearTimeout(idleTimer);
  }
}
