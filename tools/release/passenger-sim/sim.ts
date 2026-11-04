#!/usr/bin/env tsx
/**
 * passenger-sim: a local stand-in for cPanel's Phusion Passenger (spec 12.2), used to smoke-test the release zip.
 *
 * It models what matters to an ALTIS app.js:
 *   - workers are spawned on demand, never ahead of a request, one per `max-pool` slot;
 *   - a worker serves one request at a time; further requests wait in a queue of `max-queue`, then get 503;
 *   - an idle worker is shut down after `idle-ms`; a worker that does not listen within `start-timeout-ms` is killed;
 *   - touching `<app>/tmp/restart.txt` restarts the app on the next request (in-flight requests finish first);
 *   - each worker runs `node --require shim.cjs <app>/app.js` (see shim.cjs): one listen(), bound to a unix socket or
 *     named pipe, with the peer address forced to 127.0.0.1. The supervisor fills X-Forwarded-For/-Proto.
 *
 * Deliberate simplifications: no WebSocket/upgrade proxying; a request that has not started streaming its response
 * when its worker dies gets 502; a request that arrives while no worker is ready and the pool has room "owns" the
 * worker that is spawned for it instead of counting against `max-queue` (Passenger counts it, which would make the
 * outcome of a cold-start burst depend on spawn latency).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http, {
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const SHIM_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'shim.cjs');
const IS_WINDOWS = process.platform === 'win32';
const APP_ENV = 'production';
/** How long a response that the app gave before reading the whole upload waits for the client to finish sending. */
const UPLOAD_LINGER_MS = 5000;
/** sun_path is 104 bytes on macOS and 108 on Linux, including the terminating NUL. */
const MAX_UNIX_SOCKET_PATH = 100;

export const DEFAULTS = {
  host: '127.0.0.1',
  maxPool: 3,
  idleMs: 5000,
  startTimeoutMs: 90_000,
  maxQueue: 100,
  killGraceMs: 5000,
} as const;

export type SimOptions = {
  /** Directory that holds app.js (the root of the unzipped release). */
  app: string;
  /** Port of the public listener; 0 picks a free one. */
  port: number;
  /** Interface of the public listener. Default 127.0.0.1; /__sim/* is answered to loopback peers only. */
  host?: string;
  maxPool?: number;
  idleMs?: number;
  startTimeoutMs?: number;
  maxQueue?: number;
  /** Time between SIGTERM and SIGKILL when a worker does not stop. */
  killGraceMs?: number;
  /** Receives every log line (supervisor messages and the workers' stdout/stderr). Default: stderr. */
  log?: (line: string) => void;
};

export type WorkerStats = { pid: number; busy: boolean; startedAt: number };
export type SimStats = { workers: WorkerStats[]; queued: number };

export type Sim = {
  readonly host: string;
  readonly port: number;
  /** Private directory holding the workers' unix sockets (undefined on Windows, which uses named pipes). */
  readonly tmpDir: string | undefined;
  stats(): SimStats;
  /** SIGKILLs one live worker chosen at random; resolves with its pid once it is gone (null: no worker). */
  killRandomWorker(): Promise<number | null>;
  /** Stops listening, stops every worker (SIGTERM, then SIGKILL after killGraceMs) and removes the socket dir. */
  close(): Promise<void>;
};

type Pending = { req: IncomingMessage; res: ServerResponse; gone: boolean };

type Worker = {
  pid: number;
  child: ChildProcess;
  socketPath: string;
  startedAt: number;
  /** The app has called listen() (the shim said so over IPC). */
  ready: boolean;
  exited: boolean;
  /** Serving a request, or reserved for the request it was spawned for. */
  busy: boolean;
  /** No new requests; stops as soon as it is idle (restart.txt, or already being terminated). */
  retiring: boolean;
  terminating: boolean;
  /** The request this worker was spawned for, until it is ready. */
  pending: Pending | undefined;
  idleTimer: NodeJS.Timeout | undefined;
  startTimer: NodeJS.Timeout | undefined;
  killTimer: NodeJS.Timeout | undefined;
  done: Promise<void>;
  markDone: () => void;
};

// ---------------------------------------------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------------------------------------------

/** Hop-by-hop headers (RFC 9110 7.6.1) plus Expect, which the front has already answered. */
const NOT_FORWARDED = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'upgrade',
  'expect',
]);

const forwardable = (headers: IncomingHttpHeaders): OutgoingHttpHeaders => {
  const out: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined && !NOT_FORWARDED.has(name)) out[name] = value;
  }
  return out;
};

const headerText = (value: string | string[] | undefined): string =>
  Array.isArray(value) ? value.join(', ') : (value ?? '');

const isLoopback = (address: string | undefined): boolean =>
  address !== undefined && (address === '::1' || /^127\./.test(address) || /^::ffff:127\./i.test(address));

/**
 * Ends `res` once the client has finished sending its request (bounded by UPLOAD_LINGER_MS), reading and discarding
 * whatever it is still uploading. Answering early and closing at once would make the OS reset the connection (unread
 * request data), and the client would lose the answer to ECONNRESET/EPIPE.
 */
const endWhenUploaded = (req: IncomingMessage, res: ServerResponse): void => {
  if (req.complete || req.destroyed) {
    res.end();
    return;
  }
  req.resume();
  const linger = setTimeout(() => res.end(), UPLOAD_LINGER_MS);
  linger.unref();
  const over = (): void => {
    clearTimeout(linger);
    res.end();
  };
  req.once('end', over);
  req.once('close', over);
};

const failed = new WeakSet<ServerResponse>();

const fail = (res: ServerResponse, status: number, message: string): void => {
  if (res.destroyed || res.writableEnded || failed.has(res)) return; // one error answer per request
  if (res.headersSent) {
    res.destroy();
    return;
  }
  failed.add(res);
  const body = `passenger-sim: ${message}\n`;
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    connection: 'close',
  });
  res.write(body);
  endWhenUploaded(res.req, res);
};

const sendJson = (res: ServerResponse, status: number, value: unknown, extra: OutgoingHttpHeaders = {}): void => {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    ...extra,
  });
  res.end(body);
};

// ---------------------------------------------------------------------------------------------------------------
// Supervisor
// ---------------------------------------------------------------------------------------------------------------

const requirePositiveInteger = (name: string, value: number): number => {
  if (!Number.isInteger(value) || value < 1) throw new RangeError(`passenger-sim: ${name} must be an integer >= 1`);
  return value;
};

export async function startSim(options: SimOptions): Promise<Sim> {
  const appDir = path.resolve(options.app);
  const appFile = path.join(appDir, 'app.js');
  if (!fs.statSync(appFile, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`passenger-sim: ${appFile} not found (--app is the directory that holds app.js)`);
  }
  const host = options.host ?? DEFAULTS.host;
  const maxPool = requirePositiveInteger('maxPool', options.maxPool ?? DEFAULTS.maxPool);
  const idleMs = requirePositiveInteger('idleMs', options.idleMs ?? DEFAULTS.idleMs);
  const startTimeoutMs = requirePositiveInteger('startTimeoutMs', options.startTimeoutMs ?? DEFAULTS.startTimeoutMs);
  const maxQueue = requirePositiveInteger('maxQueue', options.maxQueue ?? DEFAULTS.maxQueue);
  const killGraceMs = requirePositiveInteger('killGraceMs', options.killGraceMs ?? DEFAULTS.killGraceMs);
  const log = options.log ?? ((line: string) => void process.stderr.write(`${line}\n`));

  // mkdtemp creates the directory with mode 0700: no other local user can reach the workers' sockets.
  const tmpDir = IS_WINDOWS ? undefined : fs.mkdtempSync(path.join(os.tmpdir(), 'altis-sim-'));
  const removeTmpDir = (): void => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  };
  if (tmpDir && path.join(tmpDir, 'w999999.sock').length > MAX_UNIX_SOCKET_PATH) {
    removeTmpDir();
    throw new Error(`passenger-sim: ${tmpDir} is too long for a unix socket path; point TMPDIR to a shorter directory`);
  }

  const restartFile = path.join(appDir, 'tmp', 'restart.txt');
  const readRestartMtime = (): number | null => {
    try {
      return fs.statSync(restartFile, { throwIfNoEntry: false })?.mtimeMs ?? null;
    } catch {
      return null;
    }
  };
  let lastRestartMtime = readRestartMtime();

  const workers: Worker[] = [];
  const queue: Pending[] = [];
  let workerCounter = 0;
  let closing = false;
  let closePromise: Promise<void> | undefined;

  const stats = (): SimStats => ({
    workers: workers.map((w) => ({ pid: w.pid, busy: w.busy, startedAt: w.startedAt })),
    queued: queue.length,
  });

  // ------------------------------------------------------------------ worker lifecycle

  const terminate = (w: Worker): void => {
    if (w.exited || w.terminating) return;
    w.terminating = true;
    w.retiring = true;
    clearTimeout(w.idleTimer);
    w.child.kill('SIGTERM');
    w.killTimer = setTimeout(() => {
      log(`passenger-sim: worker ${w.pid} ignored SIGTERM for ${killGraceMs} ms; sending SIGKILL`);
      w.child.kill('SIGKILL');
    }, killGraceMs);
    w.killTimer.unref();
  };

  const armIdleTimer = (w: Worker): void => {
    clearTimeout(w.idleTimer);
    if (closing) return;
    w.idleTimer = setTimeout(() => {
      if (w.busy || w.exited) return;
      log(`passenger-sim: worker ${w.pid} idle for ${idleMs} ms; shutting it down`);
      terminate(w);
    }, idleMs);
    w.idleTimer.unref();
  };

  /** The worker has no request any more (or never had one): hand it the next queued request, else let it idle. */
  const settle = (w: Worker): void => {
    if (w.exited) return;
    w.busy = false;
    if (w.retiring) {
      terminate(w);
      return;
    }
    pump();
    if (!w.busy) armIdleTimer(w);
  };

  const findIdle = (): Worker | undefined => workers.find((w) => w.ready && !w.busy && !w.retiring);

  const pump = (): void => {
    while (!closing) {
      const next = queue[0];
      if (!next) return;
      if (next.gone) {
        queue.shift();
        continue;
      }
      const idle = findIdle();
      if (idle) {
        queue.shift();
        dispatch(idle, next);
      } else if (workers.length < maxPool) {
        queue.shift();
        spawnWorker(next);
      } else {
        return;
      }
    }
  };

  const dispatch = (w: Worker, p: Pending): void => {
    w.busy = true;
    clearTimeout(w.idleTimer);
    proxy(w, p, () => settle(w));
  };

  const onReady = (w: Worker): void => {
    if (w.ready || w.exited) return;
    w.ready = true;
    clearTimeout(w.startTimer);
    log(`passenger-sim: worker ${w.pid} listening after ${Date.now() - w.startedAt} ms`);
    const p = w.pending;
    w.pending = undefined;
    if (p && !p.gone) dispatch(w, p);
    else settle(w);
  };

  const onGone = (w: Worker, code: number | null, signal: NodeJS.Signals | null): void => {
    if (w.exited) return;
    w.exited = true;
    clearTimeout(w.idleTimer);
    clearTimeout(w.startTimer);
    clearTimeout(w.killTimer);
    const index = workers.indexOf(w);
    if (index >= 0) workers.splice(index, 1);
    if (!IS_WINDOWS) fs.rmSync(w.socketPath, { force: true });

    const how = `code=${code ?? 'null'}, signal=${signal ?? 'null'}`;
    if (!w.ready) log(`passenger-sim: worker ${w.pid} exited before listening (${how})`);
    else if (!w.terminating) log(`passenger-sim: worker ${w.pid} died (${how})`);

    const p = w.pending;
    w.pending = undefined;
    if (p) fail(p.res, 503, 'the application failed to start (see the worker log above)');
    w.markDone();
    pump();
  };

  function spawnWorker(p: Pending): void {
    const n = ++workerCounter;
    const socketPath = tmpDir
      ? path.join(tmpDir, `w${n}.sock`)
      : `\\\\.\\pipe\\altis-sim-${process.pid}-${n}`;
    let child: ChildProcess;
    try {
      child = spawn(process.execPath, ['--require', SHIM_PATH, appFile], {
        cwd: appDir,
        // Passenger derives NODE_ENV for Node apps from PASSENGER_APP_ENV; the supervisor's own NODE_ENV must not leak.
        env: {
          ...process.env,
          IN_PASSENGER: '1',
          PASSENGER_APP_ENV: APP_ENV,
          NODE_ENV: APP_ENV,
          SIM_SOCKET: socketPath,
        },
        // stdin closed; stdout/stderr relayed to the log; fd 3 is the IPC channel the shim reports 'listening' on
        // and whose closure tells an orphaned worker to exit.
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        windowsHide: true,
      });
    } catch (err) {
      log(`passenger-sim: cannot spawn a worker: ${(err as Error).message}`);
      fail(p.res, 503, 'cannot spawn a worker');
      return;
    }

    let markDone = (): void => {};
    const done = new Promise<void>((resolve) => {
      markDone = resolve;
    });
    const w: Worker = {
      pid: child.pid ?? 0,
      child,
      socketPath,
      startedAt: Date.now(),
      ready: false,
      exited: false,
      busy: true,
      retiring: false,
      terminating: false,
      pending: p,
      idleTimer: undefined,
      startTimer: undefined,
      killTimer: undefined,
      done,
      markDone,
    };
    workers.push(w);
    log(`passenger-sim: spawned worker ${w.pid}`);

    for (const stream of [child.stdout, child.stderr]) {
      if (!stream) continue;
      readline.createInterface({ input: stream }).on('line', (line) => log(`[worker ${w.pid}] ${line}`));
    }
    child.on('message', (message) => {
      if (typeof message === 'object' && message !== null && (message as { type?: unknown }).type === 'listening') {
        onReady(w);
      }
    });
    child.on('error', (err) => {
      log(`passenger-sim: worker ${w.pid} error: ${err.message}`);
      if (child.pid === undefined) onGone(w, null, null); // spawn itself failed: there will be no 'exit'
    });
    child.on('exit', (code, signal) => onGone(w, code, signal));

    w.startTimer = setTimeout(() => {
      log(`passenger-sim: worker ${w.pid} did not listen within ${startTimeoutMs} ms; killing it`);
      child.kill('SIGKILL');
    }, startTimeoutMs);
    w.startTimer.unref();
  }

  const restartWorkers = (): void => {
    log('passenger-sim: tmp/restart.txt changed; restarting the application');
    for (const w of [...workers]) {
      w.retiring = true;
      if (!w.busy) terminate(w);
    }
  };

  const checkRestart = (): void => {
    const mtime = readRestartMtime();
    if (mtime === lastRestartMtime) return;
    lastRestartMtime = mtime;
    if (mtime !== null) restartWorkers();
  };

  const killRandomWorker = async (): Promise<number | null> => {
    const victim = workers[Math.floor(Math.random() * workers.length)];
    if (!victim) return null;
    log(`passenger-sim: killing worker ${victim.pid} (SIGKILL)`);
    victim.child.kill('SIGKILL');
    await victim.done;
    return victim.pid;
  };

  // ------------------------------------------------------------------ request routing

  const route = (p: Pending): void => {
    const idle = findIdle();
    if (idle) dispatch(idle, p);
    else if (workers.length < maxPool) spawnWorker(p);
    else if (queue.length < maxQueue) queue.push(p);
    else {
      log(`passenger-sim: request queue is full (${maxQueue}); answering 503`);
      fail(p.res, 503, `the application is busy and the request queue is full (${maxQueue})`);
    }
  };

  const proxy = (w: Worker, p: Pending, onDone: () => void): void => {
    const { req, res } = p;
    let finished = false;
    let responseStarted = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      onDone();
    };

    const headers = forwardable(req.headers);
    const client = req.socket.remoteAddress ?? '';
    const chain = headerText(req.headers['x-forwarded-for']);
    headers['x-forwarded-for'] = chain ? `${chain}, ${client}` : client;
    // A TLS-terminating front (or a test) may already have said https; otherwise this hop is plain http.
    headers['x-forwarded-proto'] = headerText(req.headers['x-forwarded-proto']).split(',')[0]?.trim() || 'http';

    // Explicit keep-alive: with the `Connection: close` that agent:false would add, an app that answers before it has
    // read the whole upload (413) closes its socket with unread data, the OS resets the connection, and the answer
    // is lost on its way back. Our side still closes the socket once the answer is in (the agent does not keep it).
    headers['connection'] = 'keep-alive';
    const upstream = http.request({
      socketPath: w.socketPath,
      method: req.method,
      path: req.url,
      headers,
      agent: false,
    });
    upstream.on('response', (ur) => {
      res.statusCode = ur.statusCode ?? 502;
      if (ur.statusMessage) res.statusMessage = ur.statusMessage;
      res.writeHead(res.statusCode, forwardable(ur.headers));
      // Send the head now: server-sent events and long polls have no body to push it out for a long time.
      res.flushHeaders();
      responseStarted = true;
      ur.on('error', () => res.destroy());
      ur.on('close', () => {
        if (!ur.complete) res.destroy(); // the worker died mid-response: the client must see a truncated reply
        finish();
      });
      ur.on('end', () => {
        if (!req.complete) {
          // The app finished its answer without reading the whole upload (typically a 413): stop feeding it and drop
          // the upstream socket (a request that never finished would keep it open). Reading is deliberately not
          // stopped earlier: an app may flush its head first and read the body afterwards.
          req.unpipe(upstream);
          upstream.destroy();
        }
        // Keep draining the client; the end of the response waits for the upload (see endWhenUploaded).
        endWhenUploaded(req, res);
      });
      ur.pipe(res, { end: false });
    });
    upstream.on('error', () => {
      // Once the answer is on its way (e.g. the app replied early and closed while we were still sending the upload)
      // a broken upstream socket must not turn it into a 502; ur's 'close' ends the exchange.
      if (responseStarted) return;
      fail(res, 502, 'the application worker closed the connection before it answered');
      finish();
    });
    res.on('error', () => {});
    res.on('close', () => {
      if (res.writableFinished) return;
      upstream.destroy(); // the client went away
      finish();
    });
    req.on('error', () => upstream.destroy());
    req.pipe(upstream);
  };

  const control = (req: IncomingMessage, res: ServerResponse, pathname: string): void => {
    if (!isLoopback(req.socket.remoteAddress)) {
      fail(res, 403, 'control endpoints are reachable from the loopback interface only');
      return;
    }
    if (pathname === '/__sim/stats') {
      if (req.method !== 'GET') sendJson(res, 405, { error: 'use GET' }, { allow: 'GET' });
      else sendJson(res, 200, stats());
    } else if (pathname === '/__sim/kill-random') {
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'use POST' }, { allow: 'POST' });
        return;
      }
      req.resume();
      killRandomWorker().then(
        (killed) => sendJson(res, 200, { killed }),
        (err: unknown) => fail(res, 500, (err as Error).message),
      );
    } else {
      sendJson(res, 404, { error: 'unknown control endpoint' });
    }
  };

  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    try {
      const pathname = (req.url ?? '/').split('?', 1)[0] ?? '/';
      if (pathname.startsWith('/__sim/')) {
        control(req, res, pathname);
        return;
      }
      if (closing) {
        fail(res, 503, 'shutting down');
        return;
      }
      checkRestart();
      const p: Pending = { req, res, gone: false };
      res.once('close', () => {
        if (res.writableFinished) return;
        p.gone = true; // the client left while the request was waiting for a worker
        const index = queue.indexOf(p);
        if (index >= 0) queue.splice(index, 1);
      });
      route(p);
    } catch (err) {
      log(`passenger-sim: internal error: ${(err as Error).stack ?? String(err)}`);
      fail(res, 500, 'internal error');
    }
  };

  // ------------------------------------------------------------------ public listener and shutdown

  const server = http.createServer(handle);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(options.port, host, () => {
        server.off('error', reject);
        resolve();
      });
    });
  } catch (err) {
    removeTmpDir();
    throw err;
  }
  server.on('error', (err) => log(`passenger-sim: server error: ${err.message}`));
  const port = (server.address() as AddressInfo).port;

  const close = (): Promise<void> => {
    closePromise ??= (async () => {
      closing = true;
      for (const p of queue.splice(0)) fail(p.res, 503, 'shutting down');
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      const stopping = workers.map((w) => w.done);
      for (const w of [...workers]) terminate(w);
      await Promise.all(stopping);
      await closed;
      removeTmpDir();
    })();
    return closePromise;
  };

  return { host, port, tmpDir, stats, killRandomWorker, close };
}

// ---------------------------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------------------------

export class UsageError extends Error {
  override name = 'UsageError';
}

export const USAGE = `Usage: passenger-sim --app <dir> --port <n> [options]

  --app <dir>               directory that holds app.js (the unzipped release)
  --port <n>                port of the public listener (0 = pick a free one)
  --max-pool <n>            maximum number of workers          (default ${DEFAULTS.maxPool})
  --idle-ms <n>             stop a worker idle this long       (default ${DEFAULTS.idleMs})
  --start-timeout-ms <n>    kill a worker that does not listen (default ${DEFAULTS.startTimeoutMs})
  --max-queue <n>           queued requests before 503         (default ${DEFAULTS.maxQueue})
  --host <address>          interface of the public listener   (default ${DEFAULTS.host})

Control endpoints (loopback peers only):
  GET  /__sim/stats         {"workers":[{"pid","busy","startedAt"}],"queued":n}
  POST /__sim/kill-random   SIGKILL one worker -> {"killed":pid|null}
`;

const integerOption = (flag: string, raw: string, min: number, max: number): number => {
  if (!/^\d+$/.test(raw)) throw new UsageError(`--${flag} must be an integer, got "${raw}"`);
  const value = Number(raw);
  if (value < min || value > max) throw new UsageError(`--${flag} must be between ${min} and ${max}, got ${raw}`);
  return value;
};

export function parseCliArgs(argv: string[]): SimOptions {
  let values: Record<string, string | undefined>;
  try {
    values = parseArgs({
      args: argv,
      allowPositionals: false,
      strict: true,
      options: {
        app: { type: 'string' },
        port: { type: 'string' },
        host: { type: 'string' },
        'max-pool': { type: 'string' },
        'idle-ms': { type: 'string' },
        'start-timeout-ms': { type: 'string' },
        'max-queue': { type: 'string' },
      },
    }).values;
  } catch (err) {
    throw new UsageError((err as Error).message);
  }

  if (!values['app']) throw new UsageError('--app <dir> is required');
  if (values['port'] === undefined) throw new UsageError('--port <n> is required');
  const options: SimOptions = { app: values['app'], port: integerOption('port', values['port'], 0, 65_535) };
  if (values['host'] !== undefined) options.host = values['host'];
  if (values['max-pool'] !== undefined) options.maxPool = integerOption('max-pool', values['max-pool'], 1, 1000);
  if (values['idle-ms'] !== undefined) options.idleMs = integerOption('idle-ms', values['idle-ms'], 1, 2 ** 31 - 1);
  if (values['start-timeout-ms'] !== undefined) {
    options.startTimeoutMs = integerOption('start-timeout-ms', values['start-timeout-ms'], 1, 2 ** 31 - 1);
  }
  if (values['max-queue'] !== undefined) {
    options.maxQueue = integerOption('max-queue', values['max-queue'], 1, 1_000_000);
  }
  return options;
}

async function main(argv: string[]): Promise<void> {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(USAGE);
    return;
  }
  let options: SimOptions;
  try {
    options = parseCliArgs(argv);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    process.stderr.write(`passenger-sim: ${err.message}\n\n${USAGE}`);
    process.exitCode = 2;
    return;
  }

  let sim: Sim;
  try {
    sim = await startSim(options);
  } catch (err) {
    process.stderr.write(`passenger-sim: ${(err as Error).message}\n`);
    process.exitCode = 1;
    return;
  }
  const shownHost = sim.host.includes(':') ? `[${sim.host}]` : sim.host;
  process.stdout.write(`passenger-sim: listening on http://${shownHost}:${sim.port}\n`);

  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    sim.close().then(
      () => process.exit(0),
      (err: unknown) => {
        process.stderr.write(`passenger-sim: shutdown failed: ${(err as Error).message}\n`);
        process.exit(1);
      },
    );
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

const isMainModule = (): boolean => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fs.realpathSync(entry) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};

if (isMainModule()) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    process.stderr.write(`passenger-sim: ${(err as Error).stack ?? String(err)}\n`);
    process.exit(1);
  });
}
