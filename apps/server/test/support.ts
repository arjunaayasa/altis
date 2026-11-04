import fsp from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { jakartaDate } from '@altis/crypto/feed';
import { afterEach, beforeEach, vi, type Mock } from 'vitest';
import type { Config } from '../src/config.js';
import type { BootContext, BootPhase, RequestHandler } from '../src/index.js';
import type { Logger } from '../src/logger.js';
import { retirementsSettled } from '../src/retirements.js';
import { generateInstallSecrets } from '../src/secrets.js';

/** A fresh DATA_DIR (not created yet) under a temp directory that is removed after each test. */
export function useDataDir(): { readonly root: string; readonly dataDir: string } {
  const state = { root: '', dataDir: '' };
  beforeEach(async () => {
    state.root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-server-')));
    state.dataDir = path.join(state.root, 'altis-data');
  });
  afterEach(async () => {
    // maxRetries: a writer that has not quite let go yet (ENOTEMPTY, EBUSY) is waited out.
    await fsp.rm(state.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return state;
}

/**
 * A complete, valid config. `overrides` replaces whole top-level keys. Its install date (`install.trialStartedAt`) is
 * today, the Jakarta date of the real clock.
 */
export function sampleConfig(overrides: Partial<Config> = {}): Config {
  return {
    version: 1,
    baseUrl: 'https://perpus.sekolah.sch.id',
    trustProxy: { hops: 1 },
    allowedOrigins: ['https://www.sekolah.sch.id'],
    db: { dialect: 'mariadb', host: 'db.internal', port: 3306, user: 'altis', password: 'p4ss-w0rd', database: 'altis' },
    ...generateInstallSecrets(jakartaDate(Date.now())),
    installState: 'complete',
    log: { level: 'info' },
    ...overrides,
  };
}

/** One line written to a {@link recordingLogger}: the fields of its children merged under the fields of the call. */
export interface RecordedLine {
  level: 'debug' | 'info' | 'warn' | 'error';
  msg: string;
  fields: Record<string, unknown>;
}

/** A Logger (Task 13's interface) that keeps every line in `lines`, children included. */
export function recordingLogger(): Logger & { lines: RecordedLine[] } {
  const lines: RecordedLine[] = [];
  const make = (inherited: Record<string, unknown>): Logger => {
    const write = (level: RecordedLine['level']) => (msg: string, fields?: Record<string, unknown>) => {
      lines.push({ level, msg, fields: { ...inherited, ...fields } });
    };
    return {
      debug: write('debug'),
      info: write('info'),
      warn: write('warn'),
      error: write('error'),
      child: (fields) => make({ ...inherited, ...fields }),
    };
  };
  return Object.assign(make({}), { lines });
}

export interface HttpReply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** One request to 127.0.0.1 over node:http (no global fetch, P18), on a connection of its own (no keep-alive). */
export function httpRequest(port: number, urlPath: string, method = 'GET', headers: http.OutgoingHttpHeaders = {}): Promise<HttpReply> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method, headers, agent: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        body += chunk;
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

/** A port nothing listens on (it was free a moment ago): connecting to it is refused. */
export async function closedPort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as net.AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

/** The test's stand-in for app.js's one http.Server, behind a {@link TestBootContext}'s `serve`. */
export interface ServedServer {
  server: http.Server;
  port: number;
}

/** Every stand-in server, with its listen(); closed by {@link closeTestServers}. */
const testServers = new Map<http.Server, Promise<unknown>>();

/**
 * Closes every server that a test boot context's `serve` created (call it in afterEach), then waits until the handlers
 * they served have retired: their job runtimes drained and their databases closed (start()'s retire runs once the
 * server closes). A DATA_DIR removed before that could still be written in (ENOTEMPTY).
 */
export async function closeTestServers(): Promise<void> {
  const entries = [...testServers];
  testServers.clear();
  await Promise.all(
    entries.map(async ([server, listening]) => {
      await listening.catch(() => {});
      if (!server.listening) return;
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    }),
  );
  await new Promise((resolve) => setImmediate(resolve)); // the retirements the closes started are recorded by now
  await retirementsSettled();
}

/**
 * `ctx.serve` as app.js implements it (spec §9.2, ruling R64), backed by a test server: the first call creates the
 * server and listens on 127.0.0.1 (a random port); every call makes `handler` the one that answers; the promise
 * returned resolves once that handler is no longer served (another took its place, or the server closed).
 */
function fakeServe(): { serve: Mock<(handler: RequestHandler) => Promise<void>>; served(): Promise<ServedServer> } {
  let active: RequestHandler | undefined;
  let retire: (() => void) | undefined;
  let listening: Promise<ServedServer> | undefined;
  let onFirstServe!: (served: Promise<ServedServer>) => void;
  const firstServe = new Promise<ServedServer>((resolve) => (onFirstServe = resolve));
  const serve = vi.fn((handler: RequestHandler): Promise<void> => {
    if (typeof handler !== 'function') throw new TypeError('ctx.serve: the handler must be a function');
    retire?.();
    active = handler;
    if (listening === undefined) {
      const server = http.createServer((req, res) => active!(req, res));
      listening = new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as net.AddressInfo).port }));
      });
      testServers.set(server, listening);
      onFirstServe(listening);
    }
    const ready = listening;
    return new Promise<void>((resolve) => {
      retire = resolve;
      ready.then(({ server }) => server.once('close', () => resolve()), () => resolve());
    });
  });
  return { serve, served: () => firstServe };
}

/** What a test boot context records on top of {@link BootContext}. */
export interface TestBootContext extends BootContext {
  markHealthy: Mock<() => Promise<void>>;
  requestRestart: Mock<(reason: string) => Promise<void>>;
  bootMarker: { phase: Mock<(p: BootPhase) => void>; progress: Mock<() => void> };
  log: Logger & { lines: RecordedLine[] };
  serve: Mock<(handler: RequestHandler) => Promise<void>>;
  /** The stand-in server once start() has called `serve` (waits for that call). */
  served(): Promise<ServedServer>;
}

/**
 * The context the bootloader hands to start() and runCli() (§9.2), with recording fakes; port 0 unless overridden.
 * `serve` is backed by a test server created on its first call (close it with {@link closeTestServers}).
 */
export function bootContext(dataDir: string, overrides: Partial<Pick<BootContext, 'port' | 'runtime'>> & { version?: string } = {}): TestBootContext {
  const { serve, served } = fakeServe();
  return {
    bootProtocol: 1,
    appRoot: path.join(path.dirname(dataDir), 'app'),
    dataDir,
    release: { version: overrides.version ?? '0.1.0', dir: path.join(path.dirname(dataDir), 'app', 'release'), source: 'bundled' },
    runtime: overrides.runtime ?? 'standalone',
    port: overrides.port ?? 0,
    markHealthy: vi.fn(async () => {}),
    requestRestart: vi.fn(async () => {}),
    bootMarker: { phase: vi.fn(), progress: vi.fn() },
    log: recordingLogger(),
    serve,
    served,
  };
}

/** The lines of DATA_DIR/logs/altis.log, the server log (none when it does not exist). */
export async function serverLog(dataDir: string): Promise<Record<string, unknown>[]> {
  let text: string;
  try {
    text = await fsp.readFile(path.join(dataDir, 'logs', 'altis.log'), 'utf8');
  } catch {
    return [];
  }
  return text
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}
