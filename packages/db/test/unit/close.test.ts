import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Pool } from 'mysql2';
import { sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connect } from '../../src/connect.js';

// DbHandle.close() must release what the handle holds even when it never ran a statement: Kysely's destroy() does
// nothing for a driver it never initialized, which left the SQLite file open (EBUSY when 1c's restore replaces
// altis.sqlite on Windows; the -wal/-shm files stay) and the mysql2 pool's idle timer running, which keeps the
// process alive for ever (final review, fixNow 6).

// The MySQL probe connection is faked (no server); the pool is mysql2's real one, recorded to watch its end().
const probe = vi.hoisted(() => ({
  createConnection: async () => ({
    query: async () => [[{ muc: 0, mc: 151 }]],
    end: async () => undefined,
  }),
}));
const pools = vi.hoisted((): { pool: Pool; end: ReturnType<typeof vi.fn> }[] => []);
vi.mock('mysql2/promise', async (importOriginal) => {
  const original = await importOriginal<typeof import('mysql2/promise')>();
  return { ...original, default: { ...original, createConnection: probe.createConnection }, createConnection: probe.createConnection };
});
vi.mock('mysql2', async (importOriginal) => {
  const original = await importOriginal<typeof import('mysql2')>();
  const createPool = (options: Parameters<typeof original.createPool>[0]) => {
    const pool = original.createPool(options);
    const end = vi.fn(pool.end.bind(pool));
    pool.end = end as unknown as Pool['end'];
    pools.push({ pool, end });
    return pool;
  };
  return { ...original, default: { ...original, createPool }, createPool };
});

let dataDir: string;

beforeEach(async () => {
  dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-close-'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  pools.length = 0;
  await fsp.rm(dataDir, { recursive: true, force: true });
});

describe('DbHandle.close() on SQLite', () => {
  const open = () => connect({ dialect: 'sqlite' }, { runtime: 'standalone', purpose: 'cli', dataDir });
  const file = () => path.join(dataDir, 'db', 'altis.sqlite');

  async function closeSpy() {
    const { DatabaseSync } = await import('node:sqlite');
    return vi.spyOn(DatabaseSync.prototype, 'close');
  }

  it('closes the database file of a handle that never ran a statement', async () => {
    const h = await open();
    const close = await closeSpy();
    await h.close();
    expect(close).toHaveBeenCalledTimes(1);
    // The file is free: it can be renamed and deleted (Windows refuses both while it is open).
    await fsp.rename(file(), `${file()}.moved`);
    await fsp.rm(`${file()}.moved`);
  });

  it('closes it exactly once for a handle that was used', async () => {
    const h = await open();
    await sql`select 1`.execute(h.db);
    const close = await closeSpy();
    await h.close();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('closing twice is harmless', async () => {
    const h = await open();
    const close = await closeSpy();
    await h.close();
    await expect(h.close()).resolves.toBeUndefined();
    expect(close).toHaveBeenCalledTimes(1);

    const used = await open();
    await sql`select 1`.execute(used.db);
    await used.close();
    await expect(used.close()).resolves.toBeUndefined();
    expect(close).toHaveBeenCalledTimes(2);
  });
});

describe('DbHandle.close() on MySQL/MariaDB', () => {
  const open = () =>
    connect(
      { dialect: 'mariadb', host: '127.0.0.1', port: 3306, user: 'u', password: 'p', database: 'd' },
      { runtime: 'standalone', purpose: 'server', dataDir },
    );

  it('ends the pool of a handle that never ran a statement (its idle timer would keep the process alive)', async () => {
    const h = await open();
    expect(pools).toHaveLength(1);
    await h.close();
    expect(pools[0]!.end).toHaveBeenCalledTimes(1);
  });

  it('closing twice ends the pool once', async () => {
    const h = await open();
    await h.close();
    await h.close();
    expect(pools[0]!.end).toHaveBeenCalledTimes(1);
  });
});
