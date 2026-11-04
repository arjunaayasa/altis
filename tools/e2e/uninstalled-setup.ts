import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { extractZip } from '../release/src/zip.js';
import { E2E_HOST_SUFFIX } from './lib/browser.js';
import { RUN_DIR, REPO_ROOT, childEnv, freePort, installInput, run, tail, type AdminFixture } from './lib/server.js';

// Apps of their own for the specs that cannot share global-setup.ts's install (1c Task 34):
//
// - the install wizard (specs/wizard.spec.ts, A2, project `uninstalled`): the release unzipped afresh, never installed,
//   started standalone on SQLite; the wizard's own code read from DATA_DIR/install-code.txt; the server SIGKILLed
//   mid-install and restarted with ALTIS_TEST_CLOCK_OFFSET_MS (the test release's clock hook, M23);
// - the realtime spec (specs/realtime.spec.ts): installed headless with the fixture admin, then started with
//   ALTIS_RUNNER=off (the `external` runner mode of a host without a worker), so a job moves only when the spec drives it;
// - 1d Task 35: the update specs (update*.spec.ts): an app updated cannot be the suite's shared install. `host` gives
//   the app a DNS name as its baseUrl (the browser maps every name under E2E_HOST_SUFFIX to 127.0.0.1,
//   playwright.config.ts), `installHeadless` takes the runtime and environment of the install (a clock offset), and
//   `cli` runs `node app.js <command>`.
//
// The release is the one global-setup.ts built or was given (ALTIS_E2E_RELEASE_ZIP). Each app lives in a temp folder
// of its own, `<tmp>/app` with DATA_DIR `<tmp>/altis-data` beside it (P16), on a free port of 127.0.0.1; its server
// log goes to tools/e2e/dist/run/<name>-server.log (CI uploads it on failure). `node app.js` runs as the leader of a
// process group of its own, so a SIGKILL takes the server process it supervises along (a power cut, not a stop).
// Everything talks over node:http (no global fetch, P18).

const say = (line: string): void => void process.stderr.write(`e2e: ${line}\n`);
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** One day and one hour: an install code (24 h) and a claim (2 h idle) made before it are expired after it. */
export const CLOCK_OFFSET_25H_MS = 25 * 3_600_000;

/** `/_health` of an app that is not installed yet: 503 `{"status":"not_installed"}`. */
export const NOT_INSTALLED = 'not_installed';

export interface OwnApp {
  readonly name: string;
  readonly root: string;
  readonly appRoot: string;
  readonly dataDir: string;
  readonly port: number;
  /** `http://<host>:<port>` (127.0.0.1 unless `host` was given): the address the browser uses (and the install's baseUrl). */
  readonly baseUrl: string;
  /** `http://127.0.0.1:<port>`: where this process reaches the app (node:http resolves no E2E_HOST_SUFFIX name). */
  readonly localUrl: string;
  readonly log: string;
  /**
   * `node app.js install --config … --runtime <runtime>` (default `standalone`): SQLite, {@link baseUrl}, `admin` as the
   * first super admin; `env` is added to the install's environment (ALTIS_TEST_CLOCK_OFFSET_MS, ALTIS_RUNTIME).
   */
  installHeadless(admin: AdminFixture, o?: { runtime?: string; env?: Record<string, string> }): Promise<void>;
  /** `node app.js <args>` with DATA_DIR and `env`, exit 0 required (its output goes to `<name>-cli.log`). */
  cli(args: readonly string[], env?: Record<string, string>): Promise<void>;
  /**
   * Starts `node app.js` (stopping a running one first) with ALTIS_PORT, DATA_DIR and `env`; resolves once `/_health`
   * answers with one of `ready` (default: `ok`).
   */
  start(o?: { env?: Record<string, string>; ready?: readonly string[] }): Promise<void>;
  /** SIGKILL of app.js and the server it supervises (the whole process group). */
  kill(): Promise<void>;
  /**
   * 1d Task 35: a second `node app.js` on the same app folder and DATA_DIR, on a port of its own, as Passenger spawns
   * one: while another process holds releases/boot.lock it serves only the minimal pages of §9.2 step 6. Resolves once
   * its `/_health` answers one of `ready` (default `maintenance`, what that serving answers); `kill()` ends its group.
   */
  spawnSecond(o?: { env?: Record<string, string>; ready?: readonly string[] }): Promise<{ localUrl: string; kill(): Promise<void> }>;
  /** SIGTERM (app.js forwards it to its server), SIGKILL of the group after 15 s. */
  stop(): Promise<void>;
  /** DATA_DIR/install-code.txt's `code` (as shown: 5-5-5-5-6). */
  installCode(): Promise<string>;
  /** config.json's `secrets.cronToken` (for `POST /_cron`). */
  cronToken(): Promise<string>;
  /** Stops the app and removes its folder (ALTIS_E2E_KEEP=1 keeps it). */
  dispose(): Promise<void>;
}

function releaseZip(): string {
  const zip = process.env['ALTIS_E2E_RELEASE_ZIP'];
  if (zip === undefined || zip === '') throw new Error('ALTIS_E2E_RELEASE_ZIP is not set: run the specs through tools/e2e/playwright.config.ts (global-setup.ts sets it)');
  return zip;
}

/** `GET /_health`: the status code and the body's `status` ('' when there is none). */
function health(baseUrl: string, timeoutMs: number): Promise<{ code: number; status: string }> {
  const url = new URL('/_health', baseUrl);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: url.hostname, port: url.port, method: 'GET', path: url.pathname, agent: false, headers: { connection: 'close' } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (body += chunk));
      res.on('end', () => {
        let status = '';
        try {
          const parsed = (JSON.parse(body) as { status?: unknown }).status;
          if (typeof parsed === 'string') status = parsed;
        } catch {
          // not JSON
        }
        resolve({ code: res.statusCode ?? 0, status });
      });
      res.on('error', reject);
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`no answer within ${timeoutMs} ms`)));
    req.once('error', (error: NodeJS.ErrnoException) => reject(new Error(error.code ?? error.message)));
    req.end();
  });
}

/**
 * A new app of its own from the suite's release (or `zip`): unzipped, not installed, not started. `host`: its baseUrl's
 * host, a name under {@link E2E_HOST_SUFFIX} or 127.0.0.1 (default).
 */
export async function createOwnApp(name: string, o: { host?: string; zip?: string } = {}): Promise<OwnApp> {
  const host = o.host ?? '127.0.0.1';
  if (host !== '127.0.0.1' && !host.endsWith(`.${E2E_HOST_SUFFIX}`)) throw new Error(`createOwnApp: host ${host} is neither 127.0.0.1 nor a name under ${E2E_HOST_SUFFIX}`);
  const root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), `altis-e2e-${name}-`)));
  const appRoot = path.join(root, 'app');
  const dataDir = path.join(root, 'altis-data');
  await extractZip(await fsp.readFile(o.zip ?? releaseZip()), appRoot);
  await fsp.mkdir(dataDir, { mode: 0o700 });
  await fsp.mkdir(RUN_DIR, { recursive: true });
  const port = await freePort();
  const baseUrl = `http://${host}:${port}`;
  const localUrl = `http://127.0.0.1:${port}`;
  const log = path.join(RUN_DIR, `${name}-server.log`);
  let child: ChildProcess | null = null;
  /** The kills of the second processes (spawnSecond) still to end at dispose. */
  const seconds: (() => Promise<void>)[] = [];

  const running = (): boolean => child !== null && child.exitCode === null && child.signalCode === null;

  const signalGroup = (signal: NodeJS.Signals): void => {
    if (child?.pid === undefined) return;
    try {
      process.kill(-child.pid, signal);
    } catch {
      // the group is gone
    }
  };

  /** Ends the app with `signal`, then SIGKILL of the group after `graceMs`; waits for app.js to exit. */
  const end = async (signal: NodeJS.Signals, graceMs: number): Promise<void> => {
    const c = child;
    if (c === null) return;
    if (running()) {
      const exited = new Promise<void>((resolve) => c.once('exit', () => resolve()));
      if (signal === 'SIGKILL') signalGroup('SIGKILL');
      else c.kill(signal);
      const timer = setTimeout(() => signalGroup('SIGKILL'), graceMs);
      await exited;
      clearTimeout(timer);
    }
    signalGroup('SIGKILL'); // a server process app.js left behind
    child = null;
    // The port is free again once the server process is gone.
    for (let i = 0; i < 100; i++) {
      try {
        await health(localUrl, 500);
      } catch (error) {
        if (messageOf(error) === 'ECONNREFUSED') return;
      }
      await sleep(100);
    }
  };

  const app: OwnApp = {
    name,
    root,
    appRoot,
    dataDir,
    port,
    baseUrl,
    localUrl,
    log,

    async installHeadless(admin, io = {}) {
      const file = path.join(root, 'install.json');
      await fsp.writeFile(file, `${JSON.stringify(installInput({ baseUrl, admin }))}\n`, { mode: 0o600, flag: 'wx' });
      try {
        await run(`install (${name})`, process.execPath, ['app.js', 'install', '--config', file, '--runtime', io.runtime ?? 'standalone'], {
          cwd: appRoot,
          env: { ...childEnv(), ALTIS_DATA_DIR: dataDir, ...io.env },
          log: path.join(RUN_DIR, `${name}-install.log`),
          timeoutMs: 120_000,
        });
      } finally {
        await fsp.rm(file, { force: true }); // it holds the admin's password
      }
    },

    async cli(args, env = {}) {
      await run(`node app.js ${args[0] ?? ''} (${name})`, process.execPath, ['app.js', ...args], {
        cwd: appRoot,
        env: { ...childEnv(), ALTIS_DATA_DIR: dataDir, ...env },
        log: path.join(RUN_DIR, `${name}-cli.log`),
        timeoutMs: 120_000,
      });
    },

    async start(o = {}) {
      await end('SIGTERM', 15_000);
      const fd = fs.openSync(log, 'a');
      try {
        fs.writeSync(fd, `----- node app.js (${new Date().toISOString()}) ${Object.keys(o.env ?? {}).join(' ')}\n`);
        child = spawn(process.execPath, ['app.js'], {
          cwd: appRoot,
          env: { ...childEnv(), ALTIS_DATA_DIR: dataDir, ALTIS_PORT: String(port), ...o.env },
          stdio: ['ignore', fd, fd],
          detached: true,
        });
      } finally {
        fs.closeSync(fd);
      }
      let failure: Error | null = null;
      child.on('error', (error) => (failure = error));
      const ready = o.ready ?? ['ok'];
      const deadline = Date.now() + 90_000;
      let last = 'no answer';
      for (;;) {
        if (failure !== null) throw new Error(`node app.js (${name}) could not be started: ${(failure as Error).message}`);
        if (!running()) throw new Error(`node app.js (${name}) exited before /_health answered ${ready.join(' or ')} (last: ${last})\n----- ${log}\n${tail(log)}`);
        try {
          const h = await health(localUrl, 5000);
          if (ready.includes(h.status)) break;
          last = `${h.code} ${h.status}`;
        } catch (error) {
          last = messageOf(error);
        }
        if (Date.now() > deadline) throw new Error(`/_health of ${name} did not answer ${ready.join(' or ')} within 90 s (last: ${last})\n----- ${log}\n${tail(log)}`);
        await sleep(100);
      }
      say(`${name}: serving at ${baseUrl} (log: ${path.relative(REPO_ROOT, log)})`);
    },

    kill: () => end('SIGKILL', 0),
    stop: () => end('SIGTERM', 15_000),

    async spawnSecond(o = {}) {
      const secondPort = await freePort();
      const secondUrl = `http://127.0.0.1:${secondPort}`;
      const secondLog = path.join(RUN_DIR, `${name}-second.log`);
      const fd = fs.openSync(secondLog, 'a');
      let second: ChildProcess;
      try {
        second = spawn(process.execPath, ['app.js'], {
          cwd: appRoot,
          env: { ...childEnv(), ALTIS_DATA_DIR: dataDir, ALTIS_PORT: String(secondPort), ...o.env },
          stdio: ['ignore', fd, fd],
          detached: true,
        });
      } finally {
        fs.closeSync(fd);
      }
      const kill = async (): Promise<void> => {
        if (second.pid === undefined) return;
        const exited = second.exitCode !== null || second.signalCode !== null ? Promise.resolve() : new Promise<void>((resolve) => second.once('exit', () => resolve()));
        try {
          process.kill(-second.pid, 'SIGKILL');
        } catch {
          // the group is gone
        }
        await exited;
      };
      seconds.push(kill);
      const ready = o.ready ?? ['maintenance'];
      const deadline = Date.now() + 60_000;
      let last = 'no answer';
      for (;;) {
        if (second.exitCode !== null || second.signalCode !== null) throw new Error(`the second app.js of ${name} exited (last: ${last})\n----- ${secondLog}\n${tail(secondLog)}`);
        try {
          const h = await health(secondUrl, 5000);
          if (ready.includes(h.status)) break;
          last = `${h.code} ${h.status}`;
        } catch (error) {
          last = messageOf(error);
        }
        if (Date.now() > deadline) {
          await kill();
          throw new Error(`/_health of the second app.js of ${name} did not answer ${ready.join(' or ')} within 60 s (last: ${last})`);
        }
        await sleep(100);
      }
      say(`${name}: a second app.js at ${secondUrl} (log: ${path.relative(REPO_ROOT, secondLog)})`);
      return { localUrl: secondUrl, kill };
    },

    async installCode() {
      const parsed = JSON.parse(await fsp.readFile(path.join(dataDir, 'install-code.txt'), 'utf8')) as { code?: unknown };
      if (typeof parsed.code !== 'string' || parsed.code === '') throw new Error('install-code.txt holds no code');
      return parsed.code;
    },

    async cronToken() {
      const config = JSON.parse(await fsp.readFile(path.join(dataDir, 'config.json'), 'utf8')) as { secrets?: { cronToken?: unknown } };
      const token = config.secrets?.cronToken;
      if (typeof token !== 'string' || token === '') throw new Error('config.json holds no secrets.cronToken');
      return token;
    },

    async dispose() {
      for (const kill of seconds.splice(0)) await kill();
      await end('SIGTERM', 15_000);
      if (process.env['ALTIS_E2E_KEEP'] === '1') say(`${name}: keeping ${root} (ALTIS_E2E_KEEP=1)`);
      else await fsp.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    },
  };
  return app;
}

// ---------------------------------------------------------------------------------------------------------------
// The wizard's words

/** The wizard's catalogue (apps/admin/src/install/i18n.ts, its own bundle): read as text, it imports React. */
const INSTALL_I18N = path.join(REPO_ROOT, 'apps', 'admin', 'src', 'install', 'i18n.ts');

let installTexts: ReadonlyMap<string, string> | null = null;

/** The Indonesian texts of the wizard (`INSTALL_ID`): every `'key': 'value'` pair of that object literal. */
function wizardTexts(): ReadonlyMap<string, string> {
  if (installTexts !== null) return installTexts;
  const source = fs.readFileSync(INSTALL_I18N, 'utf8');
  const start = source.indexOf('export const INSTALL_ID = {');
  const end = source.indexOf('} as const;', start);
  if (start === -1 || end === -1) throw new Error(`${INSTALL_I18N}: no INSTALL_ID object`);
  const texts = new Map<string, string>();
  for (const m of source.slice(start, end).matchAll(/'([A-Za-z0-9_.]+)':\s*'((?:[^'\\]|\\.)*)'/g)) {
    texts.set(m[1]!, m[2]!.replace(/\\(.)/g, '$1'));
  }
  installTexts = texts;
  return texts;
}

/** The wizard's Indonesian text of `key`, its `{name}` placeholders filled from `params`. */
export function wizardText(key: string, params: Readonly<Record<string, string | number>> = {}): string {
  const text = wizardTexts().get(key);
  if (text === undefined) throw new Error(`the install wizard has no text ${key} (${INSTALL_I18N})`);
  return text.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole: string, name: string) => (Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : whole));
}
