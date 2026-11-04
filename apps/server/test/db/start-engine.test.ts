import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import type { DbHandle } from '@altis/db';
import { withFileLock } from '@altis/platform';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { engineLabel, testDb, testDbConfig, testDbContext } from '../../../../tools/test/test-db.js';
import { writeConfig } from '../../src/config.js';
import { start } from '../../src/index.js';
import { bootContext, closeTestServers, closedPort, httpRequest, sampleConfig, serverLog, useDataDir, type ServedServer } from '../support.js';

// start(ctx) against the engine picked by ALTIS_TEST_DB (the `db` Vitest project). Review Focus 1 on a real server:
// the database is unreachable at boot, then comes up (a TCP forwarder starts listening on the configured port) and
// the server recovers without a restart. start() serves through the fake ctx.serve (a test server standing in for
// app.js's one http.Server, ruling R64) and never listens itself.

const opened = vi.hoisted(() => [] as DbHandle[]);
/** The handles of `opened` whose close() was called, in that order. */
const closedHandles = vi.hoisted(() => new Set<DbHandle>());
vi.mock('@altis/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@altis/db')>();
  return {
    ...actual,
    connect: vi.fn(async (...args: Parameters<typeof actual.connect>) => {
      const handle = await actual.connect(...args);
      const close = handle.close.bind(handle);
      handle.close = async () => {
        closedHandles.add(handle);
        await close();
      };
      opened.push(handle);
      return handle;
    }),
  };
});

const engine = testDbContext();
const dirs = useDataDir();
let listenSpy: MockInstance<http.Server['listen']>;

beforeEach(async () => {
  opened.length = 0;
  closedHandles.clear();
  listenSpy = vi.spyOn(http.Server.prototype, 'listen');
  if (engine.available) await (await testDb()).close(); // start every test from an empty database
});

afterEach(async () => {
  await closeTestServers();
  await Promise.all(opened.map((handle) => handle.close()));
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const LOCK_RETRY = 'migration lock busy, retrying';

/** Holds a lock (as another process would) from `take` until release() is called; `take` resolves once it is held. */
function holdUntilReleased(take: (whileHeld: () => Promise<void>) => Promise<void>): { held: Promise<void>; release(): Promise<void> } {
  let onHeld!: () => void;
  let letGo!: () => void;
  const held = new Promise<void>((resolve) => (onHeld = resolve));
  const done = new Promise<void>((resolve) => (letGo = resolve));
  const holding = take(async () => {
    onHeld();
    await done;
  });
  return {
    held: Promise.race([held, holding]),
    release: async () => {
      letGo();
      await holding;
    },
  };
}

/**
 * Boots while `lock` is held: start() must keep retrying as `starting` (ruling R60: waiting for the migration lock
 * is not a boot failure), then become ready once the lock is released.
 */
async function bootsAfterLockReleased(lock: { held: Promise<void>; release(): Promise<void> }, which: string): Promise<void> {
  await lock.held;
  const ctx = bootContext(dirs.dataDir);
  let outcome = 'pending';
  const started = start(ctx).then(
    () => (outcome = 'resolved'),
    () => (outcome = 'rejected'),
  );
  const server = await ctx.served();
  try {
    await vi.waitFor(async () => expect((await serverLog(dirs.dataDir)).filter((l) => l['msg'] === LOCK_RETRY).length).toBeGreaterThanOrEqual(1), {
      timeout: 10_000,
      interval: 50,
    });
    expect(outcome).toBe('pending');
    expect(await health(server)).toEqual({ status: 503, body: { status: 'starting', version: '0.1.0' } });
    expect((await serverLog(dirs.dataDir)).find((l) => l['msg'] === LOCK_RETRY)).toMatchObject({ lock: which });
    expect(ctx.markHealthy).not.toHaveBeenCalled();
  } finally {
    await lock.release();
  }
  await vi.waitFor(async () => expect(await health(server)).toEqual({ status: 200, body: { status: 'ok', version: '0.1.0' } }), {
    timeout: 15_000,
    interval: 100,
  });
  await started;
  expect(outcome).toBe('resolved');
  expect(ctx.serve).toHaveBeenCalledTimes(1);
  expect(ctx.markHealthy).toHaveBeenCalledTimes(1);
}

async function health(served: ServedServer): Promise<unknown> {
  const reply = await httpRequest(served.port, '/_health');
  return { status: reply.status, body: JSON.parse(reply.body) as unknown };
}

/** A TCP forwarder from 127.0.0.1:`port` to the engine; close() ends it and every connection through it. */
async function forwarder(port: number, target: { host: string; port: number }): Promise<{ close(): Promise<void> }> {
  const sockets = new Set<net.Socket>();
  const track = (socket: net.Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  };
  const server = net.createServer((client) => {
    const upstream = net.connect(target.port, target.host);
    track(client);
    track(upstream);
    client.on('error', () => upstream.destroy());
    upstream.on('error', () => client.destroy());
    client.on('close', () => upstream.destroy());
    upstream.on('close', () => client.destroy());
    client.pipe(upstream);
    upstream.pipe(client);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return {
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        for (const socket of sockets) socket.destroy();
      }),
  };
}

describe.skipIf(!engine.available)(`start(ctx) [${engineLabel()}]`, () => {
  it('boots against the engine: migrates, /_health 200, markHealthy once', async () => {
    await writeConfig(dirs.dataDir, sampleConfig({ db: testDbConfig(engine) }));
    const ctx = bootContext(dirs.dataDir);
    await start(ctx);
    const served = await ctx.served();
    expect(listenSpy.mock.contexts).toEqual([served.server]); // the only listen() is app.js's (the stand-in)
    expect(await health(served)).toEqual({ status: 200, body: { status: 'ok', version: '0.1.0' } });
    expect(ctx.markHealthy).toHaveBeenCalledTimes(1);
  });

  // A retired handler drains its job runtime and closes its database after the server closed. Removing DATA_DIR before
  // that is over failed with ENOTEMPTY (a writer still active): closeTestServers waits for it.
  it('closeTestServers returns once the retired handler has closed its database', async () => {
    await writeConfig(dirs.dataDir, sampleConfig({ db: testDbConfig(engine) }));
    const ctx = bootContext(dirs.dataDir);
    await start(ctx);
    await ctx.served();
    const handles = [...opened];
    expect(handles.length).toBeGreaterThan(0);
    await closeTestServers();
    expect(handles.filter((h) => !closedHandles.has(h))).toEqual([]);
  });

  it(
    'migrate.lock held by another process: 503 starting and retries, never a boot failure; ready once released',
    async () => {
      vi.stubEnv('ALTIS_TEST_MIGRATE_LOCK_WAIT_MS', '300'); // test hook: give up waiting after 300 ms, not 10 min
      await writeConfig(dirs.dataDir, sampleConfig({ db: testDbConfig(engine) }));
      const lockPath = path.join(dirs.dataDir, 'tmp', 'migrate.lock');
      await fsp.mkdir(path.dirname(lockPath), { recursive: true });
      await bootsAfterLockReleased(
        holdUntilReleased((whileHeld) => withFileLock(lockPath, whileHeld)),
        'migrate.lock',
      );
    },
    40_000,
  );

  it.skipIf(!['mysql80', 'mysql84', 'mariadb106', 'mariadb114'].includes(engine.engine))(
    "the database's migration lock (GET_LOCK) held elsewhere: 503 starting and retries; ready once released",
    async () => {
      vi.stubEnv('ALTIS_TEST_MIGRATE_LOCK_WAIT_MS', '1000'); // GET_LOCK waits ceil(1000 ms / 1 s) = 1 s
      const config = testDbConfig(engine);
      await writeConfig(dirs.dataDir, sampleConfig({ db: config }));
      // The runner's lock name (ruling R26): 'altis_mig_' + the first 40 hex digits of SHA-256(DATABASE()).
      const name = `altis_mig_${createHash('sha256').update(config.database ?? '').digest('hex').slice(0, 40)}`;
      const other = await testDb({ reset: false });
      try {
        await bootsAfterLockReleased(
          holdUntilReleased((whileHeld) =>
            other.db.connection().execute(async (c) => {
              const row = await c.selectNoFrom((eb) => eb.fn<number>('get_lock', [eb.val(name), eb.lit(30)]).as('got')).executeTakeFirst();
              if (Number(row?.got) !== 1) throw new Error('the test could not take the migration lock');
              try {
                await whileHeld();
              } finally {
                await c.selectNoFrom((eb) => eb.fn('release_lock', [eb.val(name)]).as('released')).execute();
              }
            }),
          ),
          'database',
        );
      } finally {
        await other.close();
      }
    },
    40_000,
  );

  it.skipIf(engine.engine === 'sqlite')(
    'DB down at boot: serves 503 db_unavailable, then recovers within 10 s once the server answers',
    async () => {
      const real = testDbConfig(engine);
      const port = await closedPort();
      await writeConfig(dirs.dataDir, sampleConfig({ db: { ...real, host: '127.0.0.1', port } }));
      const ctx = bootContext(dirs.dataDir);
      const started = start(ctx);

      const server = await ctx.served();
      await vi.waitFor(async () => expect(await health(server)).toEqual({ status: 503, body: { status: 'db_unavailable', version: '0.1.0' } }));
      expect(ctx.markHealthy).not.toHaveBeenCalled();

      const proxy = await forwarder(port, { host: real.host ?? '127.0.0.1', port: real.port ?? 0 });
      try {
        const upAt = Date.now();
        await vi.waitFor(async () => expect(await health(server)).toEqual({ status: 200, body: { status: 'ok', version: '0.1.0' } }), {
          timeout: 15_000,
          interval: 100,
        });
        expect(Date.now() - upAt).toBeLessThan(10_000);
        await started;
        expect(ctx.serve).toHaveBeenCalledTimes(1);
        expect(listenSpy.mock.contexts).toEqual([server.server]);
        expect(ctx.markHealthy).toHaveBeenCalledTimes(1);
      } finally {
        await closeTestServers();
        await Promise.all(opened.map((handle) => handle.close()));
        await proxy.close();
      }
    },
    40_000,
  );
});
