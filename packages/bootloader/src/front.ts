import http from 'http';
import type { BootLog } from './log.js';

// The one http.Server of an app.js process (P2, spec §9.2, ruling R64). app.js creates it and calls listen() exactly
// once, before it imports a release; under Passenger, whose loader throws on a second listen(), that is the only way
// app.js can still fall back to another release or show its rescue page after a failed start(). Whatever answers
// requests is a handler that can be swapped: "starting" until a release serves, then the release's own handler
// (ctx.serve), the previous release's after a fallback, or the rescue page.
//
// Ruling R1c-14: the request that spawns a Passenger/LiteSpeed process reaches app.js as soon as it listens, before a
// release serves. A cron line's `POST /_cron` is then held (at most CRON_HOLD_MS, CRON_HOLD_MAX at once) instead of
// being answered "starting", and handed to the handler `use()` puts in place, so the first cron call of a cold process
// still does its work. A starting handler put in place again (a release whose start() failed) keeps holding it.
//
// Loaded before the Node check (ruling R56, through rescue.ts): it must run on Node 10. It uses `require('http')`
// without the `node:` prefix and no newer API.

/** A Node request listener: what ctx.serve takes and what the server calls for each request. */
export type RequestHandler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

export interface Front {
  readonly server: http.Server;
  /**
   * Settles with listen(): resolves once the server listens (the callback of listen() or the 'listening' event,
   * whichever comes first), rejects with the error of listen().
   */
  readonly listening: Promise<void>;
  /**
   * Makes `handler` answer every request from now on, in place of the one before. The promise resolves once
   * `handler` no longer does (another took its place, or the server closed).
   */
  use(handler: RequestHandler): Promise<void>;
}

/** Headers of every page app.js answers by itself (starting, rescue, a failed handler). */
function pageHeaders(contentType: string, length: number): http.OutgoingHttpHeaders {
  return {
    'Content-Type': contentType,
    'Content-Length': length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  };
}

/** Answers with a page of app.js's own: `status`, the headers above (plus `extra`), no body for HEAD. */
export function sendPage(
  res: http.ServerResponse,
  method: string | undefined,
  status: number,
  contentType: string,
  body: string,
  extra?: http.OutgoingHttpHeaders,
): void {
  const headers = pageHeaders(contentType, Buffer.byteLength(body));
  if (extra !== undefined) for (const name of Object.keys(extra)) headers[name] = extra[name];
  res.writeHead(status, headers);
  res.end(method === 'HEAD' ? undefined : body);
}

/** The path of a request, without its query. */
export function pathOf(req: http.IncomingMessage): string {
  const url = typeof req.url === 'string' ? req.url : '/';
  return url.split('?')[0] as string;
}

export const HEALTH_PATH = '/_health';

/** The cron line's path (apps/server api/cron.ts). */
export const CRON_PATH = '/_cron';

/** Ruling R1c-14: how long a `POST /_cron` is held while no release serves. */
export const CRON_HOLD_MS = 15000;

/** Ruling R1c-14: at most this many requests are held at once; another is answered "starting" at once. */
export const CRON_HOLD_MAX = 8;

/**
 * How long the server keeps an idle keep-alive connection open (1d Task 22, deferred item 14). Longer than the idle
 * timeout of the proxies and load balancers in front of ALTIS (commonly 60 s), so the connection is closed by the
 * proxy, or by the client that reuses it, and never by this server just as a request is sent on it. Node's default is
 * 5 s.
 */
export const KEEP_ALIVE_TIMEOUT_MS = 65000;

/**
 * How long the server waits for the headers of a request: above {@link KEEP_ALIVE_TIMEOUT_MS}, so that a request that
 * starts on a connection about to idle out is not cut by the headers timer first.
 */
export const HEADERS_TIMEOUT_MS = 66000;

/** The style of app.js's own pages. */
export const PAGE_STYLE =
  'body{font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;max-width:44rem;margin:2rem auto;padding:0 1rem;line-height:1.5;color:#1f2937;background:#fff}' +
  'h1{font-size:1.35rem}h2{font-size:1.05rem;margin-top:1.5rem}hr{border:0;border-top:1px solid #e5e7eb;margin:2rem 0}.code{color:#6b7280;font-size:.9rem}';

const STARTING_HTML =
  '<!doctype html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
  '<meta name="robots" content="noindex"><meta http-equiv="refresh" content="5"><title>ALTIS: sedang dimulai / starting</title><style>' +
  PAGE_STYLE +
  '</style></head><body>' +
  '<section lang="id"><h1>ALTIS sedang dimulai</h1><p>Halaman ini dimuat ulang sendiri dalam beberapa detik.</p></section><hr>' +
  '<section lang="en"><h1>ALTIS is starting</h1><p>This page reloads by itself in a few seconds.</p></section>' +
  '</body></html>';
const STARTING_HEALTH = JSON.stringify({ status: 'starting' });

/** The handlers startingHandler() made: while one of them is in place, openFront holds a `POST /_cron`. */
const startingHandlers = new WeakSet<RequestHandler>();

/**
 * What answers until a release serves: 503, a bilingual page, `/_health` `{status:'starting'}`. While it is in place,
 * openFront holds a `POST /_cron` (R1c-14) before it gets here.
 */
export function startingHandler(): RequestHandler {
  const handler: RequestHandler = function (req, res) {
    req.resume();
    if (pathOf(req) === HEALTH_PATH) sendPage(res, req.method, 503, 'application/json; charset=utf-8', STARTING_HEALTH);
    else sendPage(res, req.method, 503, 'text/html; charset=utf-8', STARTING_HTML);
  };
  startingHandlers.add(handler);
  return handler;
}

/** Whether the request is the cron call (R1c-14). */
function isCronCall(req: http.IncomingMessage): boolean {
  return req.method === 'POST' && pathOf(req) === CRON_PATH;
}

/** A request openFront holds (R1c-14). */
interface Held {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * A handler threw or its promise rejected. It is logged; then: a response the handler already ended is left alone
 * (it may still be flushing, and the connection may be kept alive); one it started but did not end is cut, as its
 * client could not tell it from a complete one; one it never started gets a 500.
 */
function handlerFailed(res: http.ServerResponse, error: unknown, log: BootLog | undefined): void {
  if (log !== undefined) log.error('request handler failed', { err: error });
  if (res.writableEnded === true) return;
  if (res.headersSent) {
    res.destroy();
    return;
  }
  sendPage(res, 'GET', 500, 'text/plain; charset=utf-8', 'ALTIS: kesalahan internal / internal error\n');
}

/** What openFront takes besides the port and the log. */
export interface FrontOptions {
  /** How long a `POST /_cron` is held while no release serves (default {@link CRON_HOLD_MS}; tests). */
  cronHoldMs?: number;
}

/**
 * Creates the server (with the keep-alive timeouts {@link KEEP_ALIVE_TIMEOUT_MS} and {@link HEADERS_TIMEOUT_MS}), calls
 * listen(port) once, and serves `startingHandler()` until `use()` says otherwise. Meanwhile a `POST /_cron` is held
 * (R1c-14, see the top of this file).
 */
export function openFront(port: number, log?: BootLog, o?: FrontOptions): Front {
  const holdMs = o !== undefined && typeof o.cronHoldMs === 'number' ? o.cronHoldMs : CRON_HOLD_MS;
  let current: RequestHandler = startingHandler();
  let retireCurrent: (() => void) | null = null;
  let closed = false;
  let listened = false;
  const held: Held[] = [];

  function invoke(handler: RequestHandler, req: http.IncomingMessage, res: http.ServerResponse): void {
    let result: unknown;
    try {
      result = handler(req, res);
    } catch (error) {
      handlerFailed(res, error, log);
      return;
    }
    // A handler may be async (the server's is): a rejection must not go unhandled.
    if (result !== null && typeof result === 'object' && typeof (result as { then?: unknown }).then === 'function') {
      (result as Promise<unknown>).then(undefined, function (error: unknown) {
        handlerFailed(res, error, log);
      });
    }
  }

  /** Takes `entry` off the held list (and stops its timer): true when it was still held. */
  function unhold(entry: Held): boolean {
    const at = held.indexOf(entry);
    if (at === -1) return false;
    held.splice(at, 1);
    if (entry.timer !== null) clearTimeout(entry.timer);
    entry.timer = null;
    return true;
  }

  /** R1c-14: holds the request until a handler other than a starting one is in place, at most `holdMs`. */
  function hold(req: http.IncomingMessage, res: http.ServerResponse): void {
    const entry: Held = { req: req, res: res, timer: null };
    held.push(entry);
    entry.timer = setTimeout(function () {
      // Still no release: whatever is in place now answers (the starting page).
      if (unhold(entry)) invoke(current, req, res);
    }, holdMs);
    // A client that went away is forgotten: its request never reaches a handler.
    res.on('close', function () {
      unhold(entry);
    });
  }

  const server = http.createServer(function (req, res) {
    if (startingHandlers.has(current) && isCronCall(req) && held.length < CRON_HOLD_MAX) {
      hold(req, res);
      return;
    }
    invoke(current, req, res);
  });
  // Set before listen(): plain properties since Node 8 (keepAliveTimeout) and 11.3 (headersTimeout), ignored by an
  // older Node, which only ever gets the rescue page anyway.
  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
  server.headersTimeout = HEADERS_TIMEOUT_MS;

  function retire(): void {
    const done = retireCurrent;
    retireCurrent = null;
    if (done !== null) done();
  }

  server.on('close', function () {
    closed = true;
    retire();
  });

  // Settled by whichever comes first: the callback of listen() or the 'listening' event. A host's loader may patch
  // listen() and drop the callback (an lsnode variant, say); the server still emits 'listening' then.
  const listening = new Promise<void>(function (resolve, reject) {
    function done(): void {
      if (listened) return;
      listened = true;
      resolve();
    }
    server.on('error', function (error: Error) {
      if (!listened) {
        reject(error);
        return;
      }
      // Not a listen() failure (an accept error, say): keep serving.
      if (log !== undefined) log.error('http server error', { err: error });
    });
    server.once('listening', done);
    server.listen(port, done);
  });

  return {
    server: server,
    listening: listening,
    use: function (handler: RequestHandler): Promise<void> {
      retire();
      current = handler;
      // R1c-14: the requests held while no release served go to the handler that now does (a starting one keeps them).
      if (!startingHandlers.has(handler)) {
        const waiting = held.slice();
        for (let i = 0; i < waiting.length; i += 1) {
          const entry = waiting[i] as Held;
          if (unhold(entry)) invoke(handler, entry.req, entry.res);
        }
      }
      if (closed) return Promise.resolve();
      return new Promise<void>(function (resolve) {
        retireCurrent = resolve;
      });
    },
  };
}
