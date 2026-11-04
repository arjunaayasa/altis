import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import type { DbHandle } from '@altis/db';
import { withFileLock } from '@altis/platform';
import { isDomainError, isUlid } from '@altis/shared';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { updateConfig, writeConfig } from '../src/config.js';
import { bootProtocol, logsToStdout, retryDelayMs, start } from '../src/index.js';
import {
  bootContext,
  closeTestServers,
  closedPort,
  httpRequest,
  sampleConfig,
  serverLog,
  useDataDir,
  type ServedServer,
  type TestBootContext,
} from './support.js';

// start(ctx) (Task 14, bootloader contract v1 §9.2): the request listener goes to ctx.serve(handler) first (app.js
// owns the one http.Server and listens; ruling R64), then config → connect → migrations (P3), the DB retry loop
// (Review Focus 1), explicit boot failures (ruling R52). The fake ctx's serve is backed by a test server.

// Every handle start() opens, so a test can wait for start() to have closed it (DbHandle.close() is idempotent and
// returns the same promise), and see how it was opened.
const opened = vi.hoisted(() => [] as { handle: DbHandle; options: unknown; config: unknown }[]);
vi.mock('@altis/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@altis/db')>();
  return {
    ...actual,
    connect: vi.fn(async (config: Parameters<typeof actual.connect>[0], options: Parameters<typeof actual.connect>[1]) => {
      const handle = await actual.connect(config, options);
      opened.push({ handle, options, config });
      return handle;
    }),
  };
});
const { connect } = await import('@altis/db');
const connectSpy = vi.mocked(connect);

const dirs = useDataDir();
let listenSpy: MockInstance<http.Server['listen']>;
let exitSpy: MockInstance<typeof process.exit>;

beforeEach(() => {
  opened.length = 0;
  connectSpy.mockClear();
  listenSpy = vi.spyOn(http.Server.prototype, 'listen');
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`process.exit(${String(code)}) called`);
  }) as typeof process.exit);
});

afterEach(async () => {
  await closeTestServers();
  await Promise.all(opened.map(({ handle }) => handle.close()));
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    if (!server.listening) return resolve();
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

async function health(served: ServedServer): Promise<{ status: number; body: Record<string, unknown> }> {
  const reply = await httpRequest(served.port, '/_health');
  return { status: reply.status, body: JSON.parse(reply.body) as Record<string, unknown> };
}

async function installSqlite(dataDir: string): Promise<void> {
  await writeConfig(dataDir, sampleConfig({ db: { dialect: 'sqlite' } }));
}

/** Holds the file lock at `lockPath` (as another process would) until release() is called. */
function holdLock(lockPath: string): { held: Promise<void>; release(): Promise<void> } {
  let onHeld!: () => void;
  let letGo!: () => void;
  const held = new Promise<void>((resolve) => (onHeld = resolve));
  const done = new Promise<void>((resolve) => (letGo = resolve));
  const holding = fsp
    .mkdir(path.dirname(lockPath), { recursive: true })
    .then(() =>
      withFileLock(lockPath, async () => {
        onHeld();
        await done;
      }),
    );
  return {
    held,
    release: async () => {
      letGo();
      await holding;
    },
  };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected start() to reject');
}

describe('bootloader contract v1', () => {
  it('exports bootProtocol 1 and start()', () => {
    expect(bootProtocol).toBe(1);
    expect(typeof start).toBe('function');
  });

  it('retries a down database after 1, 2, 4 … s, at most 30 s apart', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 20].map(retryDelayMs)).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
  });

  it('logs to stdout too on docker and pm2, or with ALTIS_LOG_STDOUT=1 (ruling R59)', () => {
    expect(logsToStdout('docker', {})).toBe(true);
    expect(logsToStdout('pm2', {})).toBe(true);
    expect(logsToStdout('passenger', {})).toBe(false);
    expect(logsToStdout('standalone', {})).toBe(false);
    expect(logsToStdout('standalone', { ALTIS_LOG_STDOUT: '1' })).toBe(true);
    expect(logsToStdout('service', { ALTIS_LOG_STDOUT: '0' })).toBe(false);
  });
});

describe('start(ctx)', () => {
  it('installed SQLite: serves through ctx.serve and never listens itself, migrates, /_health 200, markHealthy once', async () => {
    await installSqlite(dirs.dataDir);
    const ctx = bootContext(dirs.dataDir);
    await start(ctx);

    // One request listener, handed to app.js; the only listen() is the one of app.js's server (here the stand-in).
    expect(ctx.serve).toHaveBeenCalledTimes(1);
    expect(typeof ctx.serve.mock.calls[0]?.[0]).toBe('function');
    const served = await ctx.served();
    expect(listenSpy.mock.contexts).toEqual([served.server]);
    expect(await health(served)).toEqual({ status: 200, body: { status: 'ok', version: '0.1.0' } });
    expect(ctx.markHealthy).toHaveBeenCalledTimes(1);
    expect(ctx.bootMarker.phase.mock.calls.map(([p]) => p)).toEqual(['listening', 'migrating']);

    // The database was opened with the runtime and purpose of the context (P17 pool sizing happens in connect).
    expect(connectSpy).toHaveBeenCalledTimes(1);
    expect(opened[0]?.options).toEqual({
      runtime: 'standalone',
      purpose: 'server',
      dataDir: dirs.dataDir,
      onIdleError: expect.any(Function), // L19: idle pool errors reach the server log
    });
    // Migrations ran: the schema mirror exists.
    await expect(fsp.stat(path.join(dirs.dataDir, 'releases', 'schema-meta.json'))).resolves.toBeTruthy();

    const reply = await httpRequest(served.port, '/nothing-here');
    expect(reply.status).toBe(404);
    expect(isUlid(String(reply.headers['x-request-id']))).toBe(true);
    expect(reply.headers['x-content-type-options']).toBe('nosniff');
    expect(reply.headers['strict-transport-security']).toBe('max-age=31536000'); // sampleConfig's baseUrl is https
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('1c Task 13: a retired handler starts no work: POST /_cron on it while the job runtime drains → 202 {skipped: busy}', async () => {
    await installSqlite(dirs.dataDir);
    const config = JSON.parse(await fsp.readFile(path.join(dirs.dataDir, 'config.json'), 'utf8')) as { secrets: { cronToken: string } };
    const ctx = bootContext(dirs.dataDir);
    await start(ctx);
    await ctx.served();
    // The retired handler stays reachable for a request already on its way: here through a server of its own.
    const retiring = ctx.serve.mock.calls[0]![0];
    const old = http.createServer((req, res) => retiring(req, res));
    await new Promise<void>((resolve) => old.listen(0, '127.0.0.1', resolve));
    try {
      void ctx.serve((_req, res) => res.end('next'));
      const reply = await httpRequest((old.address() as { port: number }).port, '/_cron', 'POST', {
        authorization: `Bearer ${config.secrets.cronToken}`,
      });
      expect(reply.status, reply.body).toBe(202);
      expect(JSON.parse(reply.body)).toEqual({ skipped: 'busy' });
      await expect(fsp.stat(path.join(dirs.dataDir, 'tmp', 'cron-flight.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await closeServer(old);
    }
  });

  it('makes the system roles after the migrations (Task 24, D5) and logs the ones it created; a reboot creates none', async () => {
    await installSqlite(dirs.dataDir); // a config only: the database has no seeds, so no roles
    const ctx = bootContext(dirs.dataDir);
    await start(ctx);
    const roles = await opened[0]!.handle.db.selectFrom('roles').select(['key', 'is_system']).orderBy('key').execute();
    expect(roles).toEqual([
      { key: 'admin', is_system: 1 },
      { key: 'super_admin', is_system: 1 },
    ]);
    expect((await serverLog(dirs.dataDir)).filter((l) => l['msg'] === 'system roles created')).toEqual([
      expect.objectContaining({ roles: ['super_admin', 'admin'] }),
    ]);

    await closeTestServers();
    await opened[0]!.handle.close();
    const again = bootContext(dirs.dataDir);
    await start(again);
    expect((await serverLog(dirs.dataDir)).filter((l) => l['msg'] === 'system roles created')).toHaveLength(1);
    expect(await opened[1]!.handle.db.selectFrom('roles').select('key').execute()).toHaveLength(2);
  });

  it('before install: serves, /_health 503 not_installed, / to the wizard, other paths NOT_INSTALLED, never markHealthy', async () => {
    const ctx = bootContext(dirs.dataDir);
    await start(ctx);
    expect(ctx.serve).toHaveBeenCalledTimes(1);
    const served = await ctx.served();
    expect(await health(served)).toEqual({ status: 503, body: { status: 'not_installed', version: '0.1.0' } });
    const home = await httpRequest(served.port, '/');
    expect(home.status).toBe(302);
    expect(home.headers['location']).toBe('/install');
    const reply = await httpRequest(served.port, '/api/v1/x');
    expect(reply.status).toBe(503);
    expect(JSON.parse(reply.body)).toMatchObject({ code: 'NOT_INSTALLED', detail: 'Jalankan / Run: node app.js install --config <file>' });
    expect(ctx.markHealthy).not.toHaveBeenCalled();
    expect(connectSpy).not.toHaveBeenCalled();
  });

  it('an unfinished install (installState other than complete) counts as not installed', async () => {
    await writeConfig(dirs.dataDir, sampleConfig({ db: { dialect: 'sqlite' }, installState: 'migrate' }));
    const ctx = bootContext(dirs.dataDir);
    // The wizard resumes: start() prints the install code (1c Task 10), kept out of the test output.
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await start(ctx);
    expect((await health(await ctx.served())).body['status']).toBe('not_installed');
    expect(connectSpy).not.toHaveBeenCalled();
    expect(stdout.mock.calls.some(([text]) => String(text).includes('/install'))).toBe(true);
  });

  it(
    'DB down at boot (closed MariaDB port): serves 503 db_unavailable, no exit; recovers without restart',
    async () => {
      await writeConfig(
        dirs.dataDir,
        sampleConfig({ db: { dialect: 'mariadb', host: '127.0.0.1', port: await closedPort(), user: 'altis', password: 'pw', database: 'altis' } }),
      );
      const ctx = bootContext(dirs.dataDir);
      let settled = false;
      const started = start(ctx).finally(() => {
        settled = true;
      });

      const served = await ctx.served();
      await vi.waitFor(async () => expect((await health(served)).body).toEqual({ status: 'db_unavailable', version: '0.1.0' }));
      expect((await health(served)).status).toBe(503);
      expect(settled).toBe(false);
      expect(ctx.markHealthy).not.toHaveBeenCalled();
      const other = await httpRequest(served.port, '/api/v1/x');
      expect(JSON.parse(other.body)).toMatchObject({ status: 503, code: 'DB_UNAVAILABLE' });
      // Once the config is known, start() logs to the server log (DATA_DIR/logs/altis.log).
      expect((await serverLog(dirs.dataDir)).some((l) => l['level'] === 'warn' && l['reason'] === 'unreachable')).toBe(true);

      // The operator fixes the database (here: the config now points to a reachable SQLite).
      const fixedAt = Date.now();
      await updateConfig(dirs.dataDir, (cfg) => {
        cfg.db = { dialect: 'sqlite' };
      });
      await vi.waitFor(async () => expect(await health(served)).toEqual({ status: 200, body: { status: 'ok', version: '0.1.0' } }), {
        timeout: 10_000,
        interval: 100,
      });
      expect(Date.now() - fixedAt).toBeLessThan(10_000);
      await started;

      // The same handler on the same server all along: served once, never restarted.
      expect(ctx.serve).toHaveBeenCalledTimes(1);
      expect(listenSpy.mock.contexts).toEqual([served.server]);
      expect(served.server.listening).toBe(true);
      expect(ctx.markHealthy).toHaveBeenCalledTimes(1);
      expect(connectSpy.mock.calls.map(([cfg]) => cfg.dialect)).toEqual(expect.arrayContaining(['mariadb', 'sqlite']));
      expect(ctx.bootMarker.progress).toHaveBeenCalled();
      expect(exitSpy).not.toHaveBeenCalled();
    },
    20_000,
  );

  it.each(['the server closes', 'another handler takes its place'] as const)(
    'the handler is no longer served (%s): the retry loop ends at once, start() resolves, no further attempt',
    async (how) => {
      await writeConfig(
        dirs.dataDir,
        sampleConfig({ db: { dialect: 'mariadb', host: '127.0.0.1', port: await closedPort(), user: 'altis', password: 'pw', database: 'altis' } }),
      );
      const ctx = bootContext(dirs.dataDir);
      const started = start(ctx);
      const served = await ctx.served();
      await vi.waitFor(async () => expect((await health(served)).body['status']).toBe('db_unavailable'));
      // After the second failure the loop pauses 2 s; retiring the handler must wake it at once.
      await vi.waitFor(() => expect(connectSpy.mock.calls.length).toBeGreaterThanOrEqual(2), { timeout: 3000 });
      const retiredAt = Date.now();
      if (how === 'the server closes') await closeServer(served.server);
      else void ctx.serve((_req, res) => res.end('next'));
      await started;
      expect(Date.now() - retiredAt).toBeLessThan(500);
      const attempts = connectSpy.mock.calls.length;
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(connectSpy.mock.calls.length).toBe(attempts);
      expect(ctx.markHealthy).not.toHaveBeenCalled();
    },
  );

  it('an error of ctx.serve rejects start() with it, before any boot work', async () => {
    await installSqlite(dirs.dataDir);
    const ctx = bootContext(dirs.dataDir);
    const refused = new Error('serve() is not available to a command');
    ctx.serve.mockImplementation(() => {
      throw refused;
    });
    expect(await rejection(start(ctx))).toBe(refused);
    expect(listenSpy).not.toHaveBeenCalled();
    expect(connectSpy).not.toHaveBeenCalled();
    expect(ctx.markHealthy).not.toHaveBeenCalled();
  });

  it('an invalid config is an explicit boot failure: logged without values, start() rejects, no server closed', async () => {
    await fsp.mkdir(dirs.dataDir, { recursive: true });
    const cfg = sampleConfig({ db: { dialect: 'sqlite', password: 'S3cr3t-Value' } });
    await fsp.writeFile(path.join(dirs.dataDir, 'config.json'), JSON.stringify({ ...cfg, port: 'not-a-port' }));
    const ctx = bootContext(dirs.dataDir);
    const error = await rejection(start(ctx));
    expect(isDomainError(error) && error.code).toBe('INVALID_CONFIG');

    // app.js decides what serves next (the previous release or the rescue page): start() closes nothing, and until
    // then its handler never answers 200.
    const served = await ctx.served();
    expect(ctx.serve).toHaveBeenCalledTimes(1);
    expect(served.server.listening).toBe(true);
    expect(await health(served)).toEqual({ status: 503, body: { status: 'starting', version: '0.1.0' } });
    expect(ctx.markHealthy).not.toHaveBeenCalled();
    const failure = ctx.log.lines.find((l) => l.level === 'error');
    expect(failure?.fields).toMatchObject({ code: 'INVALID_CONFIG' });
    expect(JSON.stringify(ctx.log.lines)).not.toContain('S3cr3t-Value');
    expect(JSON.stringify(await serverLog(dirs.dataDir))).not.toContain('S3cr3t-Value');
  });

  it.each(['passenger', 'litespeed'] as const)(
    'SQLite on runtime %s (installed from a shell as standalone): an explicit boot failure before connecting (R66)',
    async (runtime) => {
      const base = sampleConfig({ db: { dialect: 'sqlite' } });
      await writeConfig(dirs.dataDir, { ...base, install: { ...base.install, runtime: 'standalone' } });
      const ctx = bootContext(dirs.dataDir, { runtime });
      const error = await rejection(start(ctx));
      expect(isDomainError(error) && error.code).toBe('SQLITE_NOT_ALLOWED');
      expect(isDomainError(error) && error.detail).toMatch(new RegExp(`${runtime}.*standalone`));
      expect(connectSpy).not.toHaveBeenCalled();
      expect(ctx.markHealthy).not.toHaveBeenCalled();
      expect((await serverLog(dirs.dataDir)).find((l) => l['level'] === 'error')).toMatchObject({ code: 'SQLITE_NOT_ALLOWED' });
      expect((await health(await ctx.served())).status).toBe(503);
    },
  );

  it('a runtime other than the one installed for is logged as a warning (P15 hops were chosen for that one)', async () => {
    const base = sampleConfig({ db: { dialect: 'sqlite' } });
    await writeConfig(dirs.dataDir, { ...base, install: { ...base.install, runtime: 'docker' } });
    const ctx = bootContext(dirs.dataDir, { runtime: 'service' });
    await start(ctx);
    expect((await serverLog(dirs.dataDir)).find((l) => l['msg'] === 'runtime differs from the install')).toMatchObject({
      level: 'warn',
      runtime: 'service',
      installRuntime: 'docker',
    });
  });

  it('a migration-runner error (SCHEMA_CONFLICT) is an explicit boot failure; the database is closed', async () => {
    await installSqlite(dirs.dataDir);
    await start(bootContext(dirs.dataDir));
    // Damage the bookkeeping: 0001 missing while later migrations are recorded.
    const first = opened[0]!.handle;
    await first.close();
    const h = await connect({ dialect: 'sqlite' }, { runtime: 'standalone', purpose: 'cli', dataDir: dirs.dataDir });
    await h.db.deleteFrom('schema_migrations').where('name', '=', '0001_meta_and_locks').execute();
    await h.close();

    const ctx = bootContext(dirs.dataDir);
    const error = await rejection(start(ctx));
    expect(isDomainError(error) && error.code).toBe('SCHEMA_CONFLICT');
    const served = await ctx.served();
    expect(served.server.listening).toBe(true); // not closed: app.js decides what serves next
    expect((await health(served)).status).toBe(503);
    expect(ctx.markHealthy).not.toHaveBeenCalled();
    expect((await serverLog(dirs.dataDir)).find((l) => l['level'] === 'error')).toMatchObject({ code: 'SCHEMA_CONFLICT', reason: 'migration_order' });
    // The handle start() opened for the failed boot is closed: using it fails.
    const failedBoot = opened[opened.length - 1]!.handle;
    await expect(failedBoot.db.selectFrom('schema_meta').selectAll().execute()).rejects.toThrow();
  });

  it('a database that needs newer code: /_health 503 schema_too_new, no markHealthy, start() resolves', async () => {
    await installSqlite(dirs.dataDir);
    await start(bootContext(dirs.dataDir));
    const h = await connect({ dialect: 'sqlite' }, { runtime: 'standalone', purpose: 'cli', dataDir: dirs.dataDir });
    await h.db.updateTable('schema_meta').set({ min_code_version: '99.0.0' }).execute();
    await h.close();

    const ctx = bootContext(dirs.dataDir);
    await start(ctx);
    const served = await ctx.served();
    expect(await health(served)).toEqual({ status: 503, body: { status: 'schema_too_new', version: '0.1.0' } });
    expect(JSON.parse((await httpRequest(served.port, '/x')).body)).toMatchObject({ code: 'SCHEMA_TOO_NEW' });
    expect(ctx.markHealthy).not.toHaveBeenCalled();
    // The database is not kept open for nothing.
    const tooOldBoot = opened[opened.length - 1]!.handle;
    await expect(tooOldBoot.db.selectFrom('schema_meta').selectAll().execute()).rejects.toThrow();
  });

  it(
    'waiting for migrate.lock is not a boot failure (R60): 503 starting, keeps retrying, ready once released',
    async () => {
      vi.stubEnv('ALTIS_TEST_MIGRATE_LOCK_WAIT_MS', '200'); // test hook: give up waiting after 200 ms, not 10 min
      await installSqlite(dirs.dataDir);
      const lock = holdLock(path.join(dirs.dataDir, 'tmp', 'migrate.lock'));
      await lock.held;
      const ctx = bootContext(dirs.dataDir);
      let outcome = 'pending';
      const started = start(ctx).then(
        () => (outcome = 'resolved'),
        () => (outcome = 'rejected'),
      );
      const served = await ctx.served();
      try {
        // Two lock waits ran out, each followed by a retry; start() neither failed nor closed the server.
        await vi.waitFor(
          async () => expect((await serverLog(dirs.dataDir)).filter((l) => l['msg'] === 'migration lock busy, retrying').length).toBeGreaterThanOrEqual(2),
          { timeout: 5000, interval: 50 },
        );
        expect(outcome).toBe('pending');
        expect(served.server.listening).toBe(true);
        expect(await health(served)).toEqual({ status: 503, body: { status: 'starting', version: '0.1.0' } });
        expect((await serverLog(dirs.dataDir)).find((l) => l['msg'] === 'migration lock busy, retrying')).toMatchObject({ lock: 'migrate.lock' });
        expect(ctx.markHealthy).not.toHaveBeenCalled();
      } finally {
        await lock.release();
      }
      await vi.waitFor(async () => expect(await health(served)).toEqual({ status: 200, body: { status: 'ok', version: '0.1.0' } }), {
        timeout: 10_000,
        interval: 100,
      });
      await started;
      expect(outcome).toBe('resolved');
      expect(ctx.serve).toHaveBeenCalledTimes(1);
      expect(ctx.markHealthy).toHaveBeenCalledTimes(1);
    },
    20_000,
  );

  it('runtime docker: the server log also goes to stdout, and a broken stdout cannot crash the process', async () => {
    const written: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    const before = process.stdout.listenerCount('error');
    await installSqlite(dirs.dataDir);
    const ctx: TestBootContext = bootContext(dirs.dataDir, { runtime: 'docker' });
    await start(ctx);

    const lines = written.filter((w) => w.startsWith('{')).map((w) => JSON.parse(w) as Record<string, unknown>);
    expect(lines.some((l) => l['msg'] === 'ready' && l['level'] === 'info')).toBe(true);
    expect(process.stdout.listenerCount('error')).toBe(before + 1);
    const epipe = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    expect(() => process.stdout.emit('error', epipe)).not.toThrow();
  });
});

// 1d Task 32 (L8, decision D1d-36): SQLite under PM2 cluster mode or with more than one instance is an explicit boot
// failure (P20: one process per SQLite file). Runtime pm2 also logs to stdout (R59), kept quiet here. This block stays
// after the docker test above, which counts the stdout guard that the first stdout logger installs.
describe('start(ctx): SQLite under a PM2 cluster', () => {
  const quietStdout = (): void => void vi.spyOn(process.stdout, 'write').mockImplementation((() => true) as typeof process.stdout.write);

  /** PM2's environment for the process: exec_mode, instances, NODE_APP_INSTANCE (undefined: not set). */
  function pm2Env(env: { exec_mode?: string; instances?: string; NODE_APP_INSTANCE?: string }): void {
    vi.stubEnv('pm_id', '0');
    vi.stubEnv('exec_mode', env.exec_mode);
    vi.stubEnv('instances', env.instances);
    vi.stubEnv('NODE_APP_INSTANCE', env.NODE_APP_INSTANCE);
  }

  it('runtime pm2 with instances=2: SQLITE_NOT_ALLOWED naming the signal (meta.signals), before any connection', async () => {
    quietStdout();
    await installSqlite(dirs.dataDir);
    pm2Env({ exec_mode: 'fork_mode', instances: '2', NODE_APP_INSTANCE: '0' });
    const ctx = bootContext(dirs.dataDir, { runtime: 'pm2' });
    const error = await rejection(start(ctx));
    expect(isDomainError(error) && error.code).toBe('SQLITE_NOT_ALLOWED');
    expect(isDomainError(error) && error.meta).toEqual({ runtime: 'pm2', installRuntime: null, signals: ['instances=2'] });
    expect(isDomainError(error) && error.detail).toMatch(/PM2.*instances=2/);
    expect(connectSpy).not.toHaveBeenCalled();
    expect(ctx.markHealthy).not.toHaveBeenCalled();
    expect((await serverLog(dirs.dataDir)).find((l) => l['level'] === 'error')).toMatchObject({
      code: 'SQLITE_NOT_ALLOWED',
      detail: expect.stringMatching(/instances=2/),
    });
    expect((await health(await ctx.served())).status).toBe(503);
  });

  it('cluster mode on its second instance: refused, naming both signals', async () => {
    quietStdout();
    await installSqlite(dirs.dataDir);
    pm2Env({ exec_mode: 'cluster_mode', NODE_APP_INSTANCE: '1' });
    const error = await rejection(start(bootContext(dirs.dataDir, { runtime: 'pm2' })));
    expect(isDomainError(error) && error.code).toBe('SQLITE_NOT_ALLOWED');
    expect(isDomainError(error) && error.meta?.['signals']).toEqual(['exec_mode=cluster_mode', 'NODE_APP_INSTANCE=1']);
    expect(connectSpy).not.toHaveBeenCalled();
  });

  it('the shipped template (fork mode, one instance) boots SQLite under pm2', async () => {
    quietStdout();
    await installSqlite(dirs.dataDir);
    pm2Env({ exec_mode: 'fork_mode', instances: '1', NODE_APP_INSTANCE: '0' });
    const ctx = bootContext(dirs.dataDir, { runtime: 'pm2' });
    await start(ctx);
    expect(ctx.markHealthy).toHaveBeenCalledTimes(1);
    expect((await health(await ctx.served())).status).toBe(200);
  });

  it('the signals count under runtime pm2 only: a standalone process boots SQLite whatever they say', async () => {
    await installSqlite(dirs.dataDir);
    pm2Env({ exec_mode: 'cluster_mode', instances: '4', NODE_APP_INSTANCE: '2' });
    const ctx = bootContext(dirs.dataDir, { runtime: 'standalone' });
    await start(ctx);
    expect(ctx.markHealthy).toHaveBeenCalledTimes(1);
  });
});
