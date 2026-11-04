/**
 * feed-dev: a static server for a feed folder made by `feed:build` (spec §12.6; Task 17).
 *
 *   pnpm feed-dev --dir <dir> [--port <n>] [--throttle <bytes/s>] [--ignore-range] [--drop-after <bytes>]
 *
 * It listens on 127.0.0.1 only (FEED_DEV_HOST otherwise: a feed folder is never published to the network by this tool),
 * serves the regular files under `dir` to GET and HEAD, answers `Range: bytes=a-b`, `bytes=a-` and `bytes=-n` with 206
 * (416 when the range starts past the end; any other Range header is ignored and the whole file is sent, as RFC 9110
 * allows), and keeps a log of every request (`requests`: path without the query, Range header or null). The test knobs
 * imitate a slow or unreliable host for the resumable download of Tasks 20 and 24:
 * - `throttleBytesPerSec`: the body is sent at about that rate;
 * - `ignoreRange`: Range headers are ignored (200 with the whole file, `Accept-Ranges: none`);
 * - `dropAfterBytes`: the connection is closed after that many body bytes of each response (the headers announced the
 *   full length, so the client sees a premature end).
 *
 * What is served: only regular files inside `dir` (after resolving symbolic links), never a folder listing, never a
 * path with an empty, `.`/`..` or hidden (`.name`) segment, a backslash, a colon or a NUL. Responses carry
 * `Cache-Control: no-store`. This is a development and test tool: it is not hardened for the internet, which is why it
 * refuses every other address.
 */
import fsp, { type FileHandle } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

/** The only address feed-dev listens on. */
export const FEED_DEV_HOST = '127.0.0.1';
/** The port of `pnpm feed-dev` when --port is not given (startFeedDev's default is 0: any free port). */
export const FEED_DEV_PORT = 8790;

export interface FeedDevOptions {
  /** The feed folder (`buildFeed`'s `out`): `<dir>/<channel>/feed.json`, `<dir>/packages/<zip>`. */
  dir: string;
  /** 127.0.0.1 only; anything else is refused (FEED_DEV_HOST). */
  host?: '127.0.0.1';
  /** Default 0: a free port, see `url`. */
  port?: number;
  throttleBytesPerSec?: number;
  ignoreRange?: boolean;
  dropAfterBytes?: number;
  /** One line per request (`GET /stable/feed.json 200 range=bytes=10-`); the command line prints them. */
  log?: (line: string) => void;
}

export interface FeedDevRequest {
  /** The request path without the query, as sent. */
  path: string;
  /** The Range header, or null. */
  range: string | null;
}

export interface FeedDev {
  /** `http://127.0.0.1:<port>`, no trailing slash: the feed base. */
  url: string;
  /** Every request so far, in arrival order. */
  requests: FeedDevRequest[];
  /** Stops listening and ends open connections. */
  close(): Promise<void>;
}

const CONTENT_TYPES: Readonly<Record<string, string>> = Object.freeze({
  '.json': 'application/json',
  '.sig': 'application/json',
  '.zip': 'application/zip',
});

const READ_CHUNK_BYTES = 64 * 1024;
/** Pieces of a throttled body: about 20 per second. */
const THROTTLE_STEPS_PER_SEC = 20;

const isWhole = (value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

type ByteRange = { start: number; end: number };

/**
 * The single byte range of a Range header for a file of `size` bytes: the range (end clamped to the file),
 * `'unsatisfiable'` (416) when it starts at or past the end or asks for an empty suffix, or null when the header is not
 * one range of bytes this server takes (ignored: the whole file with 200).
 */
export function parseRange(header: string, size: number): ByteRange | 'unsatisfiable' | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (m === null) return null;
  const first = m[1] as string;
  const last = m[2] as string;
  if (first === '') {
    if (last === '') return null;
    const suffix = Number(last);
    if (suffix === 0 || size === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(first);
  const end = last === '' ? Number.POSITIVE_INFINITY : Number(last);
  if (end < start) return null; // invalid (first > last): ignored
  if (start >= size) return 'unsatisfiable';
  return { start, end: Math.min(end, size - 1) };
}

/** The regular file a request path names inside `root` (a real path), or null. */
async function resolveFile(root: string, requestPath: string): Promise<string | null> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(requestPath);
  } catch {
    return null;
  }
  if (!decoded.startsWith('/') || /[\0\\:]/.test(decoded)) return null;
  const segments = decoded.slice(1).split('/');
  if (segments.some((s) => s === '' || s.startsWith('.'))) return null;
  let real: string;
  try {
    real = await fsp.realpath(path.join(root, ...segments));
  } catch {
    return null;
  }
  return real.startsWith(root + path.sep) ? real : null;
}

/** Writes `chunk`; resolves true once it is handed to the socket, false when the response was closed first. */
function send(res: http.ServerResponse, chunk: Uint8Array): Promise<boolean> {
  return new Promise((resolve) => {
    if (res.destroyed) {
      resolve(false);
      return;
    }
    const closed = (): void => resolve(false);
    res.once('close', closed);
    res.write(chunk, (err) => {
      res.off('close', closed);
      resolve(err === undefined || err === null);
    });
  });
}

interface BodyKnobs {
  throttleBytesPerSec: number | undefined;
  dropAfterBytes: number | undefined;
}

/** Sends bytes start..end (inclusive) of `handle`, throttled and cut as `knobs` say; ends the response when whole. */
async function sendBody(res: http.ServerResponse, handle: FileHandle, range: ByteRange, knobs: BodyKnobs): Promise<void> {
  const total = range.end - range.start + 1;
  const piece = knobs.throttleBytesPerSec === undefined ? READ_CHUNK_BYTES : Math.max(1, Math.floor(knobs.throttleBytesPerSec / THROTTLE_STEPS_PER_SEC));
  const limit = knobs.dropAfterBytes === undefined ? total : Math.min(total, knobs.dropAfterBytes);
  const buffer = Buffer.alloc(Math.min(piece, READ_CHUNK_BYTES));
  const started = Date.now();
  let sent = 0;
  if (limit === 0) res.flushHeaders();
  while (sent < limit) {
    const want = Math.min(buffer.length, limit - sent);
    const { bytesRead } = await handle.read(buffer, 0, want, range.start + sent);
    if (bytesRead === 0) break; // the file shrank: the client sees a short body
    if (!(await send(res, Buffer.from(buffer.subarray(0, bytesRead))))) return;
    sent += bytesRead;
    if (knobs.throttleBytesPerSec !== undefined) {
      const due = started + (sent * 1000) / knobs.throttleBytesPerSec;
      const wait = due - Date.now();
      if (wait > 0) await sleep(wait);
      if (res.destroyed) return;
    }
  }
  if (sent < total) {
    // dropAfterBytes (or a file that shrank): close the connection after what was sent, before Content-Length bytes.
    res.socket?.end();
    res.destroy();
    return;
  }
  res.end();
}

/**
 * Starts feed-dev (see the top of this file).
 *
 * @throws Error `FEED_DEV_HOST:<host>` (not 127.0.0.1), `FEED_DEV_DIR:<dir>` (not a folder), `FEED_DEV_PORT`,
 *   `FEED_DEV_THROTTLE`, `FEED_DEV_DROP`, or the listen error (EADDRINUSE…)
 */
export async function startFeedDev(o: FeedDevOptions): Promise<FeedDev> {
  const host: string = o.host ?? FEED_DEV_HOST;
  if (host !== FEED_DEV_HOST) throw new Error(`FEED_DEV_HOST:${JSON.stringify(host)} (feed-dev listens on ${FEED_DEV_HOST} only)`);
  const port = o.port ?? 0;
  if (!isWhole(port, 0, 65_535)) throw new Error(`FEED_DEV_PORT:${String(port)} (0 to 65535)`);
  if (o.throttleBytesPerSec !== undefined && !isWhole(o.throttleBytesPerSec, 1)) {
    throw new Error(`FEED_DEV_THROTTLE:${String(o.throttleBytesPerSec)} (a whole number of bytes per second, at least 1)`);
  }
  if (o.dropAfterBytes !== undefined && !isWhole(o.dropAfterBytes, 0)) throw new Error(`FEED_DEV_DROP:${String(o.dropAfterBytes)} (a whole number of bytes)`);
  let root: string;
  try {
    root = await fsp.realpath(o.dir);
    if (!(await fsp.stat(root)).isDirectory()) throw new Error('not a folder');
  } catch (error) {
    throw new Error(`FEED_DEV_DIR:${o.dir} (${error instanceof Error ? error.message : String(error)})`, { cause: error });
  }

  const requests: FeedDevRequest[] = [];
  const knobs: BodyKnobs = { throttleBytesPerSec: o.throttleBytesPerSec, dropAfterBytes: o.dropAfterBytes };
  const ignoreRange = o.ignoreRange === true;

  async function handle(req: http.IncomingMessage, res: http.ServerResponse, { path: requestPath, range }: FeedDevRequest): Promise<number> {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD', 'Content-Length': '0' }).end();
      return 405;
    }
    const file = await resolveFile(root, requestPath);
    let fileHandle: FileHandle | undefined;
    try {
      if (file !== null) fileHandle = await fsp.open(file, 'r').catch(() => undefined); // gone, or a folder on Windows
      const stats = fileHandle === undefined ? undefined : await fileHandle.stat();
      if (fileHandle === undefined || stats === undefined || !stats.isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': '10' }).end('not found\n');
        return 404;
      }
      const size = stats.size;
      let status = 200;
      let bytes: ByteRange = { start: 0, end: size - 1 };
      const headers: http.OutgoingHttpHeaders = {
        'Content-Type': CONTENT_TYPES[path.extname(file as string).toLowerCase()] ?? 'application/octet-stream',
        'Accept-Ranges': ignoreRange ? 'none' : 'bytes',
      };
      if (!ignoreRange && range !== null) {
        const wanted = parseRange(range, size);
        if (wanted === 'unsatisfiable') {
          res.writeHead(416, { ...headers, 'Content-Range': `bytes */${size}`, 'Content-Length': '0' }).end();
          return 416;
        }
        if (wanted !== null) {
          status = 206;
          bytes = wanted;
          headers['Content-Range'] = `bytes ${wanted.start}-${wanted.end}/${size}`;
        }
      }
      const length = size === 0 ? 0 : bytes.end - bytes.start + 1;
      headers['Content-Length'] = String(length);
      res.writeHead(status, headers);
      if (req.method === 'HEAD' || length === 0) res.end();
      else await sendBody(res, fileHandle, bytes, knobs);
      return status;
    } finally {
      await fileHandle?.close();
    }
  }

  const server = http.createServer((req, res) => {
    const target = req.url ?? '';
    const query = target.indexOf('?');
    const logged: FeedDevRequest = {
      path: query === -1 ? target : target.slice(0, query),
      range: typeof req.headers.range === 'string' ? req.headers.range : null,
    };
    requests.push(logged);
    const line = `${req.method ?? '?'} ${logged.path}`;
    handle(req, res, logged).then(
      (status) => o.log?.(`${line} ${status}${logged.range === null ? '' : ` range=${logged.range}`}`),
      (error: unknown) => {
        o.log?.(`${line} failed: ${error instanceof Error ? error.message : String(error)}`);
        if (!res.headersSent) res.writeHead(500, { 'Content-Length': '0' }).end();
        else res.destroy();
      },
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, FEED_DEV_HOST, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;

  let closing: Promise<void> | undefined;
  return {
    url: `http://${FEED_DEV_HOST}:${address.port}`,
    requests,
    close(): Promise<void> {
      closing ??= new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      return closing;
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Command line

/** The options of `pnpm feed-dev …`; relative paths are taken from INIT_CWD (where pnpm was run) or `cwd`. */
export function parseFeedDevArgs(argv: readonly string[], env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): FeedDevOptions {
  const args = argv[0] === '--' ? argv.slice(1) : [...argv];
  let values: Record<string, string | boolean | undefined>;
  try {
    values = parseArgs({
      args,
      strict: true,
      allowPositionals: false,
      options: {
        dir: { type: 'string' },
        port: { type: 'string' },
        host: { type: 'string' },
        throttle: { type: 'string' },
        'ignore-range': { type: 'boolean' },
        'drop-after': { type: 'string' },
      },
    }).values;
  } catch (error) {
    throw new Error(`USAGE: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  const whole = (name: string): number | undefined => {
    const text = values[name];
    if (text === undefined) return undefined;
    if (typeof text !== 'string' || !/^\d+$/.test(text) || !Number.isSafeInteger(Number(text))) {
      throw new Error(`USAGE: --${name} must be a whole number, not ${JSON.stringify(text)}`);
    }
    return Number(text);
  };
  const dir = values['dir'];
  if (typeof dir !== 'string' || dir === '') throw new Error('USAGE: missing --dir <feed folder>');
  const base = env['INIT_CWD'] !== undefined && env['INIT_CWD'] !== '' ? env['INIT_CWD'] : cwd;
  const options: FeedDevOptions = { dir: path.resolve(base, dir), port: whole('port') ?? FEED_DEV_PORT };
  if (typeof values['host'] === 'string') options.host = values['host'] as '127.0.0.1';
  const throttle = whole('throttle');
  if (throttle !== undefined) options.throttleBytesPerSec = throttle;
  if (values['ignore-range'] === true) options.ignoreRange = true;
  const drop = whole('drop-after');
  if (drop !== undefined) options.dropAfterBytes = drop;
  return options;
}

const USAGE =
  'Usage: pnpm feed-dev --dir <feed folder> [--port <n>] [--throttle <bytes/s>] [--ignore-range] [--drop-after <bytes>]\n' +
  `  Serves the folder (feed:build's --out) on http://${FEED_DEV_HOST}:<port> only (default port ${FEED_DEV_PORT}; 0 = any free port).\n`;

async function main(argv: string[]): Promise<void> {
  let options: FeedDevOptions;
  try {
    options = parseFeedDevArgs(argv);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
    process.exitCode = 2;
    return;
  }
  const dev = await startFeedDev({ ...options, log: (line) => void process.stdout.write(`${line}\n`) });
  process.stdout.write(`feed-dev: serving ${options.dir} at ${dev.url} (${FEED_DEV_HOST} only; Ctrl+C stops)\n`);
  const stop = (): void => {
    void dev.close().then(() => {
      process.exitCode = 0;
    });
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`feed-dev failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
