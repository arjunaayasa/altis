import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';

// The E2E install's lifecycle pieces (global-setup.ts puts them together): the release build, the headless install,
// `node app.js` and its health. Everything talks over node:http (no global fetch, P18).

/** The test-profile release the suite installs (the version the nightly release job builds too). */
export const E2E_VERSION = '0.1.0-test';

/** tools/e2e. */
export const E2E_DIR = path.resolve(import.meta.dirname, '..');
export const REPO_ROOT = path.resolve(E2E_DIR, '..', '..');
/** What a run leaves for a look afterwards (CI uploads it on failure): server and build logs. Git-ignored (dist/). */
export const RUN_DIR = path.join(E2E_DIR, 'dist', 'run');

/** The first super admin: test-only credentials (fixtures/admin.json), for an install that only ever listens on 127.0.0.1. */
export interface AdminFixture {
  username: string;
  name: string;
  password: string;
  email: string;
}

export function readAdminFixture(file: string = path.join(E2E_DIR, 'fixtures', 'admin.json')): AdminFixture {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  const field = (name: keyof AdminFixture): string => {
    const value = raw[name];
    if (typeof value !== 'string' || value === '') throw new Error(`${file}: "${name}" must be a non-empty string`);
    return value;
  };
  return { username: field('username'), name: field('name'), password: field('password'), email: field('email') };
}

/** The input of `node app.js install --config <file> --runtime standalone`: SQLite, the browser's address, the fixture admin. */
export function installInput(o: { baseUrl: string; admin: AdminFixture }) {
  return {
    baseUrl: o.baseUrl,
    db: { dialect: 'sqlite' as const },
    library: { name: 'Perpustakaan E2E', timezone: 'Asia/Jakarta', locale: 'id' as const },
    admin: { username: o.admin.username, name: o.admin.name, password: o.admin.password, email: o.admin.email },
  };
}

/** What the app's processes inherit: enough to run Node. */
const PASS_ENV = ['PATH', 'Path', 'HOME', 'USERPROFILE', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot', 'SYSTEMROOT', 'ComSpec', 'PATHEXT', 'LANG', 'LC_ALL'];

/**
 * The environment of `node app.js` (install and server): PASS_ENV with this Node's folder first on PATH. Nothing else:
 * no ALTIS_* of the developer's shell (a database password, a test fault), and no NODE_OPTIONS (the Playwright runner's
 * module loader must not load into the app).
 */
export function childEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  const seen = new Set<string>();
  for (const name of PASS_ENV) {
    const key = process.platform === 'win32' ? name.toUpperCase() : name;
    const value = env[name];
    if (value === undefined || seen.has(key)) continue;
    seen.add(key);
    out[name] = value;
  }
  const pathKey = out['PATH'] === undefined && out['Path'] !== undefined ? 'Path' : 'PATH';
  out[pathKey] = [path.dirname(process.execPath), out[pathKey]].filter((p) => p !== undefined && p !== '').join(path.delimiter);
  return out;
}

/** The environment of the release build: this one without NODE_OPTIONS, Playwright's PW_* and anything ALTIS_*. */
export function buildEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([name]) => name !== 'NODE_OPTIONS' && !name.startsWith('PW_') && !name.startsWith('ALTIS_')));
}

/** A port that was free a moment ago on 127.0.0.1. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function get(url: URL, timeoutMs: number): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: url.hostname, port: url.port, method: 'GET', path: url.pathname, agent: false, headers: { connection: 'close' } },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        res.on('error', reject);
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`no answer within ${timeoutMs} ms`)));
    req.once('error', (error: NodeJS.ErrnoException) => reject(new Error(error.code ?? error.message)));
    req.end();
  });
}

/**
 * Asks `<baseUrl>/_health` until it answers 200 `{"status":"ok"}` (refused connections and 503 "starting" are
 * retried every `pollMs`). Rejects when `alive()` says the process is gone, or after `timeoutMs`.
 */
export async function waitHealthy(baseUrl: string, o: { timeoutMs: number; pollMs?: number; alive?: () => boolean }): Promise<{ version: string | undefined }> {
  const url = new URL('/_health', baseUrl);
  const pollMs = o.pollMs ?? 100;
  const deadline = Date.now() + o.timeoutMs;
  let last = 'no answer';
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`/_health did not answer 200 within ${o.timeoutMs} ms (last: ${last})`);
    try {
      const reply = await get(url, Math.max(1, Math.min(remaining, 10_000)));
      let status: unknown;
      let version: unknown;
      try {
        ({ status, version } = JSON.parse(reply.body) as { status?: unknown; version?: unknown });
      } catch {
        // reported as `last`
      }
      if (reply.status === 200 && status === 'ok') return { version: typeof version === 'string' ? version : undefined };
      last = `${reply.status} ${reply.body.slice(0, 200)}`;
    } catch (error) {
      last = messageOf(error);
    }
    if (o.alive !== undefined && !o.alive()) throw new Error(`the server exited before /_health answered 200 (last: ${last})`);
    await sleep(pollMs);
  }
}

/** The last `lines` lines of a log file, for an error message. */
export function tail(file: string, lines = 40): string {
  try {
    return fs.readFileSync(file, 'utf8').trimEnd().split('\n').slice(-lines).join('\n');
  } catch {
    return '(no log)';
  }
}

/**
 * Runs `file args` to completion, its output appended to `log`.
 *
 * @throws Error naming the exit code and the log's last lines, or after `timeoutMs`
 */
export async function run(label: string, file: string, args: readonly string[], o: { cwd: string; env: NodeJS.ProcessEnv; log: string; timeoutMs: number }): Promise<void> {
  const fd = fs.openSync(o.log, 'a');
  try {
    fs.writeSync(fd, `$ ${[file, ...args].join(' ')}\n`);
    const code = await new Promise<number | null>((resolve, reject) => {
      const child = spawn(file, [...args], {
        cwd: o.cwd,
        env: o.env,
        stdio: ['ignore', fd, fd],
        // Windows runs .cmd files (pnpm.cmd) through the shell only (CVE-2024-27980).
        shell: process.platform === 'win32' && !file.endsWith('.exe'),
        windowsHide: true,
      });
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`${label}: no result after ${o.timeoutMs} ms (log: ${o.log})`));
      }, o.timeoutMs);
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(new Error(`${label}: ${file} could not be started: ${error.message}`));
      });
      child.once('close', (exit) => {
        clearTimeout(timer);
        resolve(exit);
      });
    });
    if (code !== 0) throw new Error(`${label} failed with exit code ${String(code)} (log: ${o.log}):\n${tail(o.log)}`);
  } finally {
    fs.closeSync(fd);
  }
}

/** `node app.js` of a release, its output appended to `log`. */
export interface RunningApp {
  child: ChildProcess;
  alive(): boolean;
  /** SIGTERM (app.js forwards it to the server it supervises), then SIGKILL after `graceMs`. */
  stop(graceMs?: number): Promise<void>;
}

export function startApp(o: { appRoot: string; env: Record<string, string>; log: string }): RunningApp {
  const fd = fs.openSync(o.log, 'a');
  let child: ChildProcess;
  try {
    child = spawn(process.execPath, ['app.js'], { cwd: o.appRoot, env: o.env, stdio: ['ignore', fd, fd], windowsHide: true });
  } finally {
    fs.closeSync(fd); // the child has its own copy
  }
  let failure: Error | null = null;
  child.on('error', (error) => (failure = error));
  const alive = (): boolean => {
    if (failure !== null) throw new Error(`node app.js could not be started: ${failure.message}`);
    return child.exitCode === null && child.signalCode === null;
  };
  return {
    child,
    alive,
    stop: async (graceMs = 15_000) => {
      if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), graceMs);
      await exited;
      clearTimeout(timer);
    },
  };
}
