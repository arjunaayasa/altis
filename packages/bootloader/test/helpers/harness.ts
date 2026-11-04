import { spawn, type ChildProcess } from 'node:child_process';
import fsp from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll } from 'vitest';
import { buildBootloader } from '../../src/build.js';
import { makeRelease, type MakeReleaseOptions } from './make-release.js';

// Black-box harness: builds app.js (test profile) once per test file, lays out a temporary app folder
// (`<root>/app/app.js` + `bundled-release/<v>`), DATA_DIR and HOME per test, spawns `node app.js` with a clean
// environment, and leaves nothing behind (processes, ports, temporary folders).

/** The bundled release version the test build of app.js is made for (spec §12.5: 0.1.0-test). */
export const BUNDLED_VERSION = '0.1.0-test';

export interface HttpReply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/**
 * One request to 127.0.0.1 over node:http (no global fetch, P18), on a connection of its own. With `timeoutMs`, a
 * request that gets no complete reply in time fails (something that accepts connections but never answers).
 */
export function httpGet(port: number, urlPath: string, method = 'GET', timeoutMs?: number): Promise<HttpReply> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method, agent: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        body += chunk;
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      res.on('error', reject);
    });
    if (timeoutMs !== undefined) req.setTimeout(timeoutMs, () => req.destroy(new Error(`no reply within ${timeoutMs} ms`)));
    req.on('error', reject);
    req.end();
  });
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Polls `cond` every 25 ms until it returns true; fails after `timeoutMs`. `what` names what is awaited in the
 * failure; a function is called only then, so the message can tell what was seen last.
 */
export async function waitFor(cond: () => boolean | Promise<boolean>, what: string | (() => string), timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await cond()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${typeof what === 'function' ? what() : what}`);
    await sleep(25);
  }
}

/** The app.js server process (spawned without arguments) of each sandbox port, so a wait can see it exit. */
const servingOnPort = new Map<number, AppProcess>();

/** The end of `text`, for an error message. */
function tail(text: string, chars = 2000): string {
  return text.length > chars ? `…${text.slice(-chars)}` : text;
}

/** Fails when the app.js server spawned for `port` has exited: nothing will ever answer there again. */
function failIfExited(port: number, what: string): void {
  const app = servingOnPort.get(port);
  if (app === undefined || app.exitedAt() === undefined) return;
  const { code, signal } = app.exit() as Exit;
  throw new Error(
    `app.js (pid ${app.pid}) exited with ${code === null ? `signal ${String(signal)}` : `code ${code}`} while waiting for ${what}\n` +
      `stderr:\n${tail(app.stderr())}`,
  );
}

/**
 * Polls `urlPath` until a reply arrives that `accept` takes (default: any reply). Fails at once when the app.js
 * server spawned for `port` has exited (its exit code and stderr in the message); on a timeout the message names
 * the last status seen.
 */
export async function waitForHttp(
  port: number,
  urlPath: string,
  accept: (reply: HttpReply) => boolean = () => true,
  timeoutMs = 10_000,
): Promise<HttpReply> {
  let last: HttpReply | undefined;
  const what = (): string => `GET ${urlPath} on port ${port}${last === undefined ? '' : ` (last status ${last.status})`}`;
  await waitFor(
    async () => {
      failIfExited(port, what());
      try {
        last = await httpGet(port, urlPath, 'GET', 2000);
        return accept(last);
      } catch {
        return false; // not listening yet
      }
    },
    what,
    timeoutMs,
  );
  return last as HttpReply;
}

/** True while a process with this pid exists. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Ports for the apps under test: a block of PORT_BLOCK ports per Vitest pool (VITEST_POOL_ID), from PORT_BASE up.
 * The whole range lies below every ephemeral range (Linux 32768–60999, macOS and Windows 49152–65535), so neither an
 * outgoing connection (a database client, an HTTP request) nor `listen(0)` in another worker can take a port between
 * the probe and app.js binding it; parallel workers never share a block.
 */
const PORT_BASE = 20_000;
const PORT_BLOCK = 200;
const PORT_POOLS = 60; // 20000 + 60 × 200 = 32000 < 32768
/** The next port of this worker's block to try; a random start, so test files that reuse a worker spread out. */
let nextPortOffset = Math.floor(Math.random() * PORT_BLOCK);

function portBlockStart(): number {
  const pool = Number(process.env['VITEST_POOL_ID']);
  const index = Number.isInteger(pool) && pool >= 1 ? (pool - 1) % PORT_POOLS : 0;
  return PORT_BASE + index * PORT_BLOCK;
}

/** Whether a server can listen on `port` of `host` right now (`undefined`: every interface, as app.js does). */
function canListen(port: number, host: string | undefined): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', (error: NodeJS.ErrnoException) => {
      // A host without IPv6 cannot bind `::`; app.js then listens on IPv4, which the other probes cover.
      resolve(host === undefined && (error.code === 'EAFNOSUPPORT' || error.code === 'EADDRNOTAVAIL'));
    });
    probe.listen({ port, host }, () => probe.close(() => resolve(true)));
  });
}

/**
 * True when nothing listens on `port` right now: app.js's own bind (every interface) works, and so do 0.0.0.0 and
 * 127.0.0.1. macOS lets a server bind every interface (`::`) next to another one on 0.0.0.0 or 127.0.0.1 of the same
 * port, and the tests' requests to 127.0.0.1 would then reach that other server.
 */
export async function portIsFree(port: number): Promise<boolean> {
  for (const host of [undefined, '0.0.0.0', '127.0.0.1']) {
    if (!(await canListen(port, host))) return false;
  }
  return true;
}

/** A TCP port of this worker's block (see PORT_BASE) that could be listened on a moment ago. */
export async function freePort(): Promise<number> {
  const start = portBlockStart();
  for (let tries = 0; tries < PORT_BLOCK; tries += 1) {
    const port = start + (nextPortOffset % PORT_BLOCK);
    nextPortOffset += 1;
    if (await portIsFree(port)) return port;
  }
  throw new Error(`freePort: no free port in ${start}-${start + PORT_BLOCK - 1}`);
}

export interface Sandbox {
  /** Temporary folder holding everything below (a real path). */
  root: string;
  appRoot: string;
  appJs: string;
  /** `<appRoot>/bundled-release/<v>`, `<v>` the version app.js was built for (BUNDLED_VERSION unless `appJsVersion`). */
  bundledDir: string;
  dataDir: string;
  home: string;
  port: number;
}

export interface SandboxOptions {
  /** The bundled release; `null` for none. Default: the version app.js was built for, behaviour `ok`. */
  bundled?: Partial<MakeReleaseOptions> | null;
  /**
   * 1d Task 16: the bundled version app.js is built for (`__BUNDLED_VERSION__`), when it is not BUNDLED_VERSION: a
   * build of its own, made once per test file and version (§9.8: a newer bundled release than the active one).
   */
  appJsVersion?: string;
}

export interface Exit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface AppProcess {
  child: ChildProcess;
  pid: number;
  stdout(): string;
  stderr(): string;
  exited: Promise<Exit>;
  /** When the process exited (`performance.now()` in the test process), or undefined while it runs. */
  exitedAt(): number | undefined;
  /** How the process exited, or undefined while it runs. */
  exit(): Exit | undefined;
}

export interface SpawnOptions {
  args?: string[];
  /** Merged over the sandbox environment; `undefined` removes a variable. */
  env?: Record<string, string | undefined>;
  execArgv?: string[];
}

export interface Harness {
  /** The test build of app.js (outside any sandbox). */
  readonly builtAppJs: string;
  sandbox(o?: SandboxOptions): Promise<Sandbox>;
  spawn(sb: Sandbox, o?: SpawnOptions): AppProcess;
  /** Kills `pid` (if still alive) after the test. */
  track(pid: number): void;
}

/**
 * Registers the hooks of one test file: build app.js before all tests, kill every spawned or tracked process and
 * remove every sandbox after each test, remove the build after all tests.
 */
export function useHarness(): Harness {
  let buildDir = '';
  let builtAppJs = '';
  /** The builds for other bundled versions (SandboxOptions.appJsVersion), by version. */
  const otherBuilds = new Map<string, Promise<string>>();
  const roots: string[] = [];
  const processes: AppProcess[] = [];
  const pids: number[] = [];

  beforeAll(async () => {
    buildDir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-bootloader-build-')));
    builtAppJs = path.join(buildDir, 'app.js');
    await buildBootloader({ profile: 'test', outfile: builtAppJs, bundledVersion: BUNDLED_VERSION });
  });

  afterEach(async () => {
    servingOnPort.clear();
    for (const app of processes.splice(0)) {
      if (app.exitedAt() !== undefined) continue;
      app.child.kill('SIGTERM');
      const done = await Promise.race([app.exited.then(() => true), sleep(5000).then(() => false)]);
      if (!done) {
        app.child.kill('SIGKILL');
        await app.exited;
      }
    }
    for (const pid of pids.splice(0)) {
      if (pidAlive(pid)) process.kill(pid, 'SIGKILL');
      await waitFor(() => !pidAlive(pid), `pid ${pid} to end`, 5000);
    }
    await Promise.all(roots.splice(0).map((root) => fsp.rm(root, { recursive: true, force: true })));
  });

  afterAll(async () => {
    await Promise.all([...otherBuilds.values()].map((built) => built.catch(() => undefined)));
    if (buildDir !== '') await fsp.rm(buildDir, { recursive: true, force: true });
  });

  /** app.js built for the bundled version `version` (BUNDLED_VERSION: the build of beforeAll). */
  function appJsFor(version: string): Promise<string> {
    if (version === BUNDLED_VERSION) return Promise.resolve(builtAppJs);
    let built = otherBuilds.get(version);
    if (built === undefined) {
      const outfile = path.join(buildDir, version, 'app.js');
      built = buildBootloader({ profile: 'test', outfile, bundledVersion: version }).then(() => outfile);
      otherBuilds.set(version, built);
    }
    return built;
  }

  return {
    get builtAppJs() {
      return builtAppJs;
    },

    async sandbox(o: SandboxOptions = {}): Promise<Sandbox> {
      const root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-boot-')));
      roots.push(root);
      const appRoot = path.join(root, 'app');
      const home = path.join(root, 'home');
      await fsp.mkdir(appRoot);
      await fsp.mkdir(home);
      const appJs = path.join(appRoot, 'app.js');
      const appJsVersion = o.appJsVersion ?? BUNDLED_VERSION;
      await fsp.copyFile(await appJsFor(appJsVersion), appJs);
      const bundledDir = path.join(appRoot, 'bundled-release', appJsVersion);
      if (o.bundled !== null) {
        const version = o.bundled?.version ?? appJsVersion;
        await makeRelease(path.join(appRoot, 'bundled-release', version), { ...o.bundled, version });
      }
      return { root, appRoot, appJs, bundledDir, dataDir: path.join(root, 'altis-data'), home, port: await freePort() };
    },

    spawn(sb: Sandbox, o: SpawnOptions = {}): AppProcess {
      const env: Record<string, string> = {};
      const base: Record<string, string | undefined> = {
        PATH: process.env['PATH'],
        TMPDIR: process.env['TMPDIR'],
        SystemRoot: process.env['SystemRoot'],
        HOME: sb.home,
        ALTIS_DATA_DIR: sb.dataDir,
        ALTIS_PORT: String(sb.port),
        ALTIS_RUNTIME: 'service',
        ...o.env,
      };
      for (const [key, value] of Object.entries(base)) if (value !== undefined) env[key] = value;

      const child = spawn(process.execPath, [...(o.execArgv ?? []), sb.appJs, ...(o.args ?? [])], {
        cwd: sb.root,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      let exitedAt: number | undefined;
      let exit: Exit | undefined;
      child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
        stdout += chunk;
      });
      child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
        stderr += chunk;
      });
      const exited = new Promise<Exit>((resolve) => {
        child.on('exit', (code, signal) => {
          exitedAt = performance.now();
          exit = { code, signal };
          resolve(exit);
        });
      });
      const app: AppProcess = {
        child,
        pid: child.pid as number,
        stdout: () => stdout,
        stderr: () => stderr,
        exited,
        exitedAt: () => exitedAt,
        exit: () => exit,
      };
      processes.push(app);
      // A server (no command): waits for its port fail as soon as it has exited.
      if (o.args === undefined || o.args.length === 0) servingOnPort.set(sb.port, app);
      return app;
    },

    track(pid: number): void {
      pids.push(pid);
    },
  };
}

/** The JSON log lines of app.js in `stderr` (other lines, such as the bilingual messages, are skipped). */
export function logLines(stderr: string): Record<string, unknown>[] {
  const lines: Record<string, unknown>[] = [];
  for (const line of stderr.split('\n')) {
    if (!line.startsWith('{')) continue;
    try {
      lines.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      // a line cut short: not a log entry
    }
  }
  return lines;
}

/** Parses a rescue `/_health` reply. */
export function healthJson(reply: HttpReply): Record<string, unknown> {
  return JSON.parse(reply.body) as Record<string, unknown>;
}

/** `releases/<name>` in DATA_DIR. */
export function releasesPath(sb: Sandbox, ...names: string[]): string {
  return path.join(sb.dataDir, 'releases', ...names);
}

/**
 * A `/_health` reply other than app.js's "starting" one (app.js listens before it has loaded a release, and answers
 * 503 `{status:'starting'}` until the release serves or the rescue page takes over).
 */
export function notStarting(reply: HttpReply): boolean {
  try {
    return healthJson(reply)['status'] !== 'starting';
  } catch {
    return true;
  }
}

/** Waits until the rescue page answers `/_health`, and returns its reason. */
export async function rescueReason(sb: Sandbox): Promise<unknown> {
  const reply = await waitForHttp(sb.port, '/_health', notStarting);
  return reply.status === 503 ? healthJson(reply)['reason'] : `not a rescue reply: ${reply.status} ${reply.body}`;
}
