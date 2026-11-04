import fsp from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { isDomainError, type DomainError } from '@altis/shared';
import { Kysely, sql } from 'kysely';
import type { Pool } from 'mysql2';
import type pg from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connect, guardedMysqlDialect, guardedPostgresDialect, type DbHandle } from '../../src/connect.js';

// A stalled database server must not make requests queue for ever (final review, security minor): mysql2's pool has
// a queue limit (50 waiting callers) and the pool facade an acquisition timeout, both DB_UNAVAILABLE `busy`
// (retryable); pg-pool's wait for a client is bounded by connectionTimeoutMillis and reported the same way.
//
// The servers below accept TCP connections and never answer, as a stalled database does. Only connect()'s probe
// connection is faked (it reports max_connections 2, so the pool has ONE connection); the pools are the real ones.

const probes = vi.hoisted(() => ({
  mysql: async () => ({ query: async () => [[{ muc: 0, mc: 2 }]], end: async () => undefined }),
  pgClient: class {
    on(): void {}
    async connect(): Promise<void> {}
    async query(): Promise<{ rows: { mc: number; rcl: number | null }[] }> {
      return { rows: [{ mc: 2, rcl: null }] };
    }
    async end(): Promise<void> {}
  },
}));
vi.mock('mysql2/promise', async (importOriginal) => {
  const original = await importOriginal<typeof import('mysql2/promise')>();
  return { ...original, default: { ...original, createConnection: probes.mysql }, createConnection: probes.mysql };
});
vi.mock('pg', async (importOriginal) => {
  const original = await importOriginal<{ default: typeof pg }>();
  // pg.Pool stays the real one: it is bound to pg's real Client when pg loads.
  return { ...original, default: { ...original.default, Client: probes.pgClient } };
});

/** A TCP server that accepts connections and never sends a byte. */
async function silentServer(): Promise<{ port: number; close(): Promise<void> }> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;
  return {
    port,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

type Outcome = { reason: unknown; code: unknown; retryable: unknown; at: number };

/** Runs `n` reads at once and records how each one failed (all must fail) and when, in ms from the start. */
async function stalledReads(h: DbHandle, n: number): Promise<Outcome[]> {
  const start = performance.now();
  return Promise.all(
    Array.from({ length: n }, () =>
      sql`select 1`.execute(h.db).then(
        () => {
          throw new Error('a read on a silent server succeeded');
        },
        (error: unknown) => {
          expect(isDomainError(error) && error.code).toBe('DB_UNAVAILABLE');
          const meta = (error as DomainError).meta ?? {};
          return { reason: meta['reason'], code: meta['code'], retryable: meta['retryable'], at: performance.now() - start };
        },
      ),
    ),
  );
}

let server: Awaited<ReturnType<typeof silentServer>>;
let dataDir: string;

beforeEach(async () => {
  server = await silentServer();
  dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-pool-'));
});

afterEach(async () => {
  await server.close();
  await fsp.rm(dataDir, { recursive: true, force: true });
});

describe('MySQL/MariaDB pool against a stalled server', () => {
  it('refuses callers beyond 50 waiting at once and times the others out, all as DB_UNAVAILABLE busy', async () => {
    const connectTimeoutMs = 300;
    const h = await connect(
      { dialect: 'mariadb', host: '127.0.0.1', port: server.port, user: 'u', password: 'p', database: 'd' },
      { runtime: 'standalone', purpose: 'server', dataDir, connectTimeoutMs },
    );
    try {
      expect(h.poolSize).toBe(1);
      // 1 caller opens the one connection, 50 wait in mysql2's queue, the 52nd is refused at once.
      const outcomes = await stalledReads(h, 52);
      const queueFull = outcomes.filter((o) => o.code === 'POOL_QUEUE_FULL');
      expect(queueFull).toHaveLength(1);
      expect(queueFull[0]).toMatchObject({ reason: 'busy', retryable: true });
      expect(queueFull[0]!.at).toBeLessThan(connectTimeoutMs);
      // The waiting ones give up after connectTimeoutMs + 1 s; a few were handed a connection attempt of their own
      // in the meantime (each failed connect frees the slot) and report its connect timeout instead.
      const timedOut = outcomes.filter((o) => o.code === 'POOL_ACQUIRE_TIMEOUT');
      expect(timedOut.length).toBeGreaterThanOrEqual(40);
      for (const o of timedOut) {
        expect(o).toMatchObject({ reason: 'busy', retryable: true });
        expect(o.at).toBeGreaterThanOrEqual(connectTimeoutMs + 1000 - 50);
      }
      for (const o of outcomes) expect(['POOL_QUEUE_FULL', 'POOL_ACQUIRE_TIMEOUT', 'ETIMEDOUT']).toContain(o.code);
      expect(Math.max(...outcomes.map((o) => o.at))).toBeLessThan(5000);
    } finally {
      // mysql2's end() fails with the error of a connection attempt still under way (connect ETIMEDOUT).
      await h.close().catch(() => undefined);
    }
  });
});

describe('PostgreSQL pool against a stalled server', () => {
  it('times a caller waiting for a client out after connectionTimeoutMillis as DB_UNAVAILABLE busy', async () => {
    const connectTimeoutMs = 300;
    const h = await connect(
      { dialect: 'postgres', host: '127.0.0.1', port: server.port, user: 'u', password: 'p', database: 'd' },
      { runtime: 'standalone', purpose: 'server', dataDir, connectTimeoutMs },
    );
    try {
      expect(h.poolSize).toBe(1);
      const outcomes = await stalledReads(h, 3);
      // The first opens the one client and hits the connect timeout; the others waited for it.
      expect(outcomes.filter((o) => o.reason === 'timeout').length).toBeGreaterThanOrEqual(1);
      const waited = outcomes.filter((o) => o.code === 'POOL_ACQUIRE_TIMEOUT');
      expect(waited.length).toBeGreaterThanOrEqual(1);
      for (const o of waited) expect(o).toMatchObject({ reason: 'busy', retryable: true });
      expect(Math.max(...outcomes.map((o) => o.at))).toBeLessThan(3000);
    } finally {
      await h.close();
    }
  });
});

describe('pool facades (fake pools)', () => {
  it('MySQL/MariaDB: a connection that arrives after the acquisition timed out goes back to the pool', async () => {
    const waiting: ((error: unknown, conn?: unknown) => void)[] = [];
    const events: string[] = [];
    const conn = { threadId: 1, config: {}, release: () => events.push('release'), destroy: () => events.push('destroy') };
    const pool = {
      getConnection: (callback: (error: unknown, conn?: unknown) => void) => void waiting.push(callback),
      end: (callback: (error: unknown) => void) => callback(null),
    };
    const db = new Kysely<never>({ dialect: guardedMysqlDialect(pool as unknown as Pool, { acquireTimeoutMs: 50 }) });
    const error = await sql`select 1`.execute(db).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'DB_UNAVAILABLE', meta: { reason: 'busy', code: 'POOL_ACQUIRE_TIMEOUT', retryable: true } });
    expect(waiting).toHaveLength(1);
    waiting[0]!(null, conn); // too late
    expect(events).toEqual(['release']);
    await db.destroy();
  });

  it("MySQL/MariaDB: mysql2's 'Queue limit reached.' is DB_UNAVAILABLE busy", async () => {
    const pool = {
      getConnection: (callback: (error: unknown) => void) => callback(new Error('Queue limit reached.')),
      end: (callback: (error: unknown) => void) => callback(null),
    };
    const db = new Kysely<never>({ dialect: guardedMysqlDialect(pool as unknown as Pool) });
    const error = await sql`select 1`.execute(db).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'DB_UNAVAILABLE', meta: { reason: 'busy', code: 'POOL_QUEUE_FULL', retryable: true } });
    await db.destroy();
  });

  it("PostgreSQL: pg-pool's 'timeout exceeded when trying to connect' is DB_UNAVAILABLE busy", async () => {
    const pool = {
      options: { max: 1 },
      connect: () => Promise.reject(new Error('timeout exceeded when trying to connect')),
      end: () => Promise.resolve(),
    };
    const db = new Kysely<never>({ dialect: guardedPostgresDialect(pool as unknown as pg.Pool) });
    const error = await sql`select 1`.execute(db).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'DB_UNAVAILABLE', meta: { reason: 'busy', code: 'POOL_ACQUIRE_TIMEOUT', retryable: true } });
    await db.destroy();
  });
});
