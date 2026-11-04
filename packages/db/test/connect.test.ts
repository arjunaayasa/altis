import fsp from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { poolSize } from '@altis/platform';
import { isDomainError } from '@altis/shared';
import { sql, type Kysely } from 'kysely';
import { createPool } from 'mysql2';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  TEST_DB_ROOT_PASSWORD,
  engineLabel,
  testDb,
  testDbContext,
  type TestDbHandle,
} from '../../../tools/test/test-db.js';
import { connect, sessionSetup, type DbConfig } from '../src/connect.js';
import { normalizeDbError } from '../src/db-errors.js';
import { checkServer } from '../src/server-check.js';
import { withTx } from '../src/tx.js';

// Runs against the engine picked by ALTIS_TEST_DB (default sqlite); see tools/test/test-db.ts.

// A type alias, not an interface: withTables() needs an index signature.
type Tables = {
  t_conn: { id: number; at: number | null; flag: number | null; name: string | null };
};

const ctx = testDbContext();
const EPOCH_MS = 1767225600000; // 2026-01-01T00:00:00Z

/** The error `promise` rejects with (fails the test when it resolves). */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
}

describe.skipIf(!ctx.available)(`connect [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let db: Kysely<Tables>;
  const mysqlFamily = () => h.dialect === 'mysql' || h.dialect === 'mariadb';

  beforeAll(async () => {
    h = await testDb();
    db = h.db.withTables<Tables>();
    await db.schema
      .createTable('t_conn')
      .addColumn('id', 'integer', (c) => c.primaryKey())
      .addColumn('at', 'bigint')
      .addColumn('flag', 'smallint')
      .addColumn('name', 'varchar(191)')
      .addUniqueConstraint('uq_t_conn_name', ['name'])
      .execute();
  });

  afterAll(async () => {
    await h?.close();
  });

  beforeEach(async () => {
    await db.deleteFrom('t_conn').execute();
  });

  it('round-trips a BIGINT epoch-ms value as a JS number', async () => {
    await db.insertInto('t_conn').values({ id: 1, at: EPOCH_MS }).execute();
    const row = await db.selectFrom('t_conn').select('at').where('id', '=', 1).executeTakeFirstOrThrow();
    expect(row.at).toBe(EPOCH_MS);
    expect(typeof row.at).toBe('number');
  });

  it('returns a SMALLINT 1 as the number 1', async () => {
    await db.insertInto('t_conn').values({ id: 1, flag: 1 }).execute();
    const row = await db.selectFrom('t_conn').select('flag').executeTakeFirstOrThrow();
    expect(row.flag).toBe(1);
  });

  it('returns COUNT(*) as a JS number', async () => {
    await db.insertInto('t_conn').values([{ id: 1 }, { id: 2 }]).execute();
    const row = await db.selectFrom('t_conn').select((eb) => eb.fn.countAll().as('n')).executeTakeFirstOrThrow();
    expect(row.n).toBe(2);
  });

  it("round-trips 'Perpustakaan Ñ €' (and a 4-byte character)", async () => {
    await db.insertInto('t_conn').values({ id: 1, name: 'Perpustakaan Ñ €' }).execute();
    await db.insertInto('t_conn').values({ id: 2, name: 'Buku 📚' }).execute();
    const rows = await db.selectFrom('t_conn').select('name').orderBy('id').execute();
    expect(rows.map((r) => r.name)).toEqual(['Perpustakaan Ñ €', 'Buku 📚']);
  });

  it('normalizes a duplicate unique insert to UNIQUE_VIOLATION', async () => {
    await db.insertInto('t_conn').values({ id: 1, name: 'dup' }).execute();
    const error = await rejection(db.insertInto('t_conn').values({ id: 2, name: 'dup' }).execute());
    // The driver layer already reports it normalized; normalizing again changes nothing.
    expect(error).toMatchObject({ code: 'UNIQUE_VIOLATION' });
    expect(JSON.stringify((error as Error).cause)).not.toContain('dup');
    const normalized = normalizeDbError(error);
    expect(isDomainError(normalized)).toBe(true);
    expect(normalized).toMatchObject({
      code: 'UNIQUE_VIOLATION',
      meta: { constraint: h.dialect === 'sqlite' ? 't_conn.name' : 'uq_t_conn_name' },
    });
  });

  it('sizes the pool from the limits read through the probe connection', () => {
    expect(h.poolSize).toBe(poolSize('standalone', 'server', h.limits));
    if (h.dialect === 'sqlite') {
      expect(h.poolSize).toBe(1);
    } else {
      expect(h.limits.maxConnections).toBeGreaterThan(0);
      expect(h.limits.maxUserConnections).toBeGreaterThanOrEqual(0);
    }
  });

  it('checkServer reports the engine as supported', async () => {
    const result = await checkServer(h);
    expect(result).toMatchObject({ ok: true, problems: [] });
    expect(result.version).not.toBe('');
    const flavor = { sqlite: 'sqlite', mysql80: 'mysql', mysql84: 'mysql', mariadb106: 'mariadb', mariadb114: 'mariadb', pg15: 'postgres', pg17: 'postgres' }[h.engine];
    expect(result.flavor).toBe(flavor);
  });

  describe('withTx', () => {
    it('commits what the callback wrote and returns its result', async () => {
      const result = await withTx(h, async (trx) => {
        await trx.withTables<Tables>().insertInto('t_conn').values({ id: 1, name: 'tx' }).execute();
        return 'done';
      });
      expect(result).toBe('done');
      expect(await db.selectFrom('t_conn').select('name').execute()).toEqual([{ name: 'tx' }]);
    });

    it('rolls back when the callback throws, and rethrows the same error', async () => {
      const boom = new Error('boom');
      const error = await rejection(
        withTx(h, async (trx) => {
          await trx.withTables<Tables>().insertInto('t_conn').values({ id: 1, name: 'gone' }).execute();
          throw boom;
        }),
      );
      expect(error).toBe(boom);
      expect(await db.selectFrom('t_conn').selectAll().execute()).toEqual([]);
    });

    it('rethrows errors of the callback that are not driver errors unchanged, even when they look like one', async () => {
      const lookalikes = [
        new Error('timeout expired'), // pg client message
        new Error('Connection terminated unexpectedly'),
        Object.assign(new Error('socket hang up'), { code: 'ECONNRESET', errno: -54, syscall: 'read' }),
        Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }),
        Object.assign(new Error('closed'), { fatal: true }),
      ];
      for (const thrown of lookalikes) {
        expect(await rejection(withTx(h, async () => Promise.reject(thrown)))).toBe(thrown);
      }
    });

    it('normalizes a driver error the callback rethrows', async () => {
      const driverError = Object.assign(new Error("Duplicate entry 'x' for key 'uq_a'"), {
        code: 'ER_DUP_ENTRY',
        errno: 1062,
        sqlState: '23000',
      });
      const error = await rejection(withTx(h, async () => Promise.reject(driverError)));
      expect(error).toMatchObject({ code: 'UNIQUE_VIOLATION', meta: { constraint: 'uq_a' } });
    });

    it('rejects with the normalized error when a statement fails', async () => {
      await db.insertInto('t_conn').values({ id: 1, name: 'dup' }).execute();
      const error = await rejection(
        withTx(h, (trx) => trx.withTables<Tables>().insertInto('t_conn').values({ id: 2, name: 'dup' }).execute()),
      );
      expect(error).toMatchObject({ code: 'UNIQUE_VIOLATION' });
    });
  });

  describe('MySQL/MariaDB session', () => {
    it.runIf(ctx.engine.startsWith('mysql') || ctx.engine.startsWith('mariadb'))(
      'rejects 192 characters in a VARCHAR(191) column (strict mode)',
      async () => {
        const error = await rejection(db.insertInto('t_conn').values({ id: 1, name: 'x'.repeat(192) }).execute());
        expect(error).toMatchObject({ code: 'ER_DATA_TOO_LONG' });
      },
    );

    it.runIf(ctx.engine.startsWith('mysql') || ctx.engine.startsWith('mariadb'))(
      'runs SET sql_mode on every pooled connection',
      async () => {
        expect(mysqlFamily()).toBe(true);
        // Hold several connections at once so that the pool has to open new ones.
        const modes = await Promise.all(
          Array.from({ length: h.poolSize }, () =>
            h.db.connection().execute(async (c) => {
              const { rows } = await sql<{ m: string }>`SELECT @@SESSION.sql_mode AS m`.execute(c);
              await new Promise((resolve) => setTimeout(resolve, 50));
              return rows[0]?.m ?? '';
            }),
          ),
        );
        for (const mode of modes) {
          expect(mode.split(',').sort()).toEqual(['NO_ENGINE_SUBSTITUTION', 'NO_ZERO_DATE', 'STRICT_ALL_TABLES']);
        }
      },
    );
  });

  describe('credentials and database name', () => {
    const opts = { runtime: 'standalone', purpose: 'cli', dataDir: os.tmpdir() } as const;

    it.runIf(ctx.engine !== 'sqlite')('a wrong password gives DB_UNAVAILABLE access_denied', async () => {
      const error = await rejection(connect({ ...h.config, password: 'wrong-password' }, opts));
      expect(error).toMatchObject({ code: 'DB_UNAVAILABLE', meta: { reason: 'access_denied', retryable: false } });
      expect(JSON.stringify((error as Error).cause)).not.toContain('altis'); // no user name, host or message
    });

    it.runIf(ctx.engine.startsWith('pg'))('an unknown database gives DB_UNAVAILABLE unknown_database', async () => {
      const error = await rejection(connect({ ...h.config, database: 'altis_no_such_db' }, opts));
      expect(error).toMatchObject({ code: 'DB_UNAVAILABLE', meta: { reason: 'unknown_database', code: '3D000' } });
    });

    it.runIf(ctx.engine.startsWith('mysql') || ctx.engine.startsWith('mariadb'))(
      'an unknown database gives unknown_database (1049), or access_denied (1044) for an account without rights on it',
      async () => {
        const asRoot = { ...h.config, user: 'root', password: TEST_DB_ROOT_PASSWORD, database: 'altis_no_such_db' };
        expect(await rejection(connect(asRoot, opts))).toMatchObject({
          code: 'DB_UNAVAILABLE',
          meta: { reason: 'unknown_database', code: 'ER_BAD_DB_ERROR' },
        });
        expect(await rejection(connect({ ...h.config, database: 'altis_no_such_db' }, opts))).toMatchObject({
          code: 'DB_UNAVAILABLE',
          meta: { reason: 'access_denied', code: 'ER_DBACCESS_DENIED_ERROR' },
        });
      },
    );
  });

  describe('MySQL/MariaDB session setup failure', () => {
    it.runIf(ctx.engine.startsWith('mysql') || ctx.engine.startsWith('mariadb'))(
      'fails the queries queued behind a failed SET sql_mode instead of running them (or hanging)',
      async () => {
        const { host, port, user, password, database } = h.config;
        const pool = createPool({ host, port, user, password, database, connectionLimit: 1 });
        pool.on('connection', sessionSetup("SET SESSION sql_mode = 'NOT_A_MODE'"));
        try {
          const error = await new Promise((resolve) => pool.query('SELECT 1 AS one', (e) => resolve(e)));
          expect(error).toMatchObject({ code: 'ER_WRONG_VALUE_FOR_VAR' });
        } finally {
          await new Promise((resolve) => pool.end(resolve));
        }
      },
      10_000,
    );
  });

  describe('PostgreSQL types', () => {
    it.runIf(ctx.engine.startsWith('pg'))('throws on a BIGINT outside the safe integer range', async () => {
      const error = await rejection(sql`SELECT CAST(9007199254740993 AS BIGINT) AS v`.execute(h.db));
      expect(String(error)).toMatch(/safe integer/i);
      // The failed parse leaves the pooled client usable.
      const { rows } = await sql<{ v: number }>`SELECT CAST(9007199254740991 AS BIGINT) AS v`.execute(h.db);
      expect(rows).toEqual([{ v: Number.MAX_SAFE_INTEGER }]);
    });
  });

  describe('SQLite', () => {
    it.runIf(ctx.engine === 'sqlite')('reports the pragmas of P20', async () => {
      const read = async (pragma: string) => {
        const { rows } = await sql<Record<string, unknown>>`PRAGMA ${sql.id(pragma)}`.execute(h.db);
        return Object.values(rows[0] ?? {})[0];
      };
      expect(await read('journal_mode')).toBe('wal');
      expect(await read('synchronous')).toBe(2);
      expect(await read('foreign_keys')).toBe(1);
      expect(await read('busy_timeout')).toBe(5000);
    });

    it.runIf(ctx.engine === 'sqlite')('keeps the database at DATA_DIR/db/altis.sqlite', async () => {
      expect((await fsp.stat(path.join(h.dataDir, 'db', 'altis.sqlite'))).isFile()).toBe(true);
    });

    it.runIf(ctx.engine === 'sqlite')('withTx takes the write lock at BEGIN (BEGIN IMMEDIATE)', async () => {
      const { DatabaseSync } = await import('node:sqlite');
      const other = new DatabaseSync(path.join(h.dataDir, 'db', 'altis.sqlite'));
      try {
        other.exec('PRAGMA busy_timeout = 0');
        await withTx(h, async () => {
          // No statement has run inside the transaction yet: only BEGIN IMMEDIATE holds the lock.
          expect(() => other.exec('BEGIN IMMEDIATE')).toThrow(/locked|busy/i);
        });
        other.exec('BEGIN IMMEDIATE');
        other.exec('ROLLBACK');
      } finally {
        other.close();
      }
    });
  });
});

describe('connect: SQLite without the test harness', () => {
  let root: string;

  beforeEach(async () => {
    root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-connect-')));
  });

  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  it('creates the db area and the database file; one connection', async () => {
    const dataDir = path.join(root, 'altis-data');
    const h = await connect({ dialect: 'sqlite' }, { runtime: 'standalone', purpose: 'cli', dataDir });
    try {
      expect(h.dialect).toBe('sqlite');
      expect(h.poolSize).toBe(1);
      expect(h.limits).toEqual({ maxUserConnections: 0, maxConnections: 1 });
      await sql`CREATE TABLE t (id INTEGER PRIMARY KEY)`.execute(h.db);
      expect((await fsp.stat(path.join(dataDir, 'db', 'altis.sqlite'))).isFile()).toBe(true);
    } finally {
      await h.close();
    }
    await h.close(); // idempotent
  });

  it.each(['passenger', 'litespeed'] as const)('refuses SQLite on %s with SQLITE_NOT_ALLOWED, before touching DATA_DIR', async (runtime) => {
    const dataDir = path.join(root, 'altis-data');
    const error = await rejection(connect({ dialect: 'sqlite' }, { runtime, purpose: 'server', dataDir }));
    expect(isDomainError(error)).toBe(true);
    expect(error).toMatchObject({ code: 'SQLITE_NOT_ALLOWED', meta: { runtime } });
    await expect(fsp.stat(dataDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('a write blocked past busy_timeout gives DB_UNAVAILABLE busy, retryable', async () => {
    const dataDir = path.join(root, 'altis-data');
    const h = await connect({ dialect: 'sqlite' }, { runtime: 'standalone', purpose: 'cli', dataDir });
    const { DatabaseSync } = await import('node:sqlite');
    const other = new DatabaseSync(path.join(dataDir, 'db', 'altis.sqlite'));
    try {
      await sql`CREATE TABLE t (id INTEGER PRIMARY KEY)`.execute(h.db);
      await sql`PRAGMA busy_timeout = 100`.execute(h.db); // shortened for the test (P20 value: 5000)
      other.exec('BEGIN IMMEDIATE'); // another process holds the write lock
      const busy = { code: 'DB_UNAVAILABLE', meta: { reason: 'busy', code: 'SQLITE_BUSY', retryable: true } };
      expect(await rejection(withTx(h, (trx) => sql`INSERT INTO t (id) VALUES (1)`.execute(trx)))).toMatchObject(busy);
      expect(await rejection(sql`INSERT INTO t (id) VALUES (2)`.execute(h.db))).toMatchObject(busy);
      other.exec('ROLLBACK');
      await withTx(h, (trx) => sql`INSERT INTO t (id) VALUES (3)`.execute(trx));
      const { rows } = await sql<{ id: number }>`SELECT id FROM t`.execute(h.db);
      expect(rows).toEqual([{ id: 3 }]);
    } finally {
      other.close();
      await h.close();
    }
  });

  it('accepts file "altis.sqlite" and refuses any other file name', async () => {
    const dataDir = path.join(root, 'altis-data');
    const h = await connect({ dialect: 'sqlite', file: 'altis.sqlite' }, { runtime: 'service', purpose: 'cli', dataDir });
    await h.close();
    const error = await rejection(
      connect({ dialect: 'sqlite', file: '../escape.sqlite' }, { runtime: 'service', purpose: 'cli', dataDir }),
    );
    expect(error).toMatchObject({ code: 'INVALID_CONFIG', meta: { field: 'file' } });
  });
});

describe('connect: server dialects without a server', () => {
  /** A TCP port on 127.0.0.1 that nothing listens on (bound, then released). */
  async function closedPort(): Promise<number> {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as net.AddressInfo;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return port;
  }

  it.each(['mysql', 'mariadb', 'postgres'] as const)('a closed port gives DB_UNAVAILABLE (%s)', async (dialect) => {
    const port = await closedPort();
    const cfg: DbConfig = { dialect, host: '127.0.0.1', port, user: 'altis', password: 'x', database: 'altis' };
    const error = await rejection(connect(cfg, { runtime: 'standalone', purpose: 'server', dataDir: os.tmpdir() }));
    expect(isDomainError(error)).toBe(true);
    expect(error).toMatchObject({
      code: 'DB_UNAVAILABLE',
      status: 503,
      meta: { reason: 'unreachable', code: 'ECONNREFUSED', retryable: false },
    });
  });

  it.each(['mysql', 'mariadb', 'postgres'] as const)(
    'a server that accepts but never answers gives DB_UNAVAILABLE after connectTimeoutMs (%s)',
    async (dialect) => {
      const sockets: net.Socket[] = [];
      const server = net.createServer((socket) => void sockets.push(socket)); // accepts, never speaks
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address() as net.AddressInfo;
      try {
        const cfg: DbConfig = { dialect, host: '127.0.0.1', port, user: 'altis', password: 'x', database: 'altis' };
        const started = Date.now();
        const error = await rejection(
          connect(cfg, { runtime: 'standalone', purpose: 'server', dataDir: os.tmpdir(), connectTimeoutMs: 300 }),
        );
        expect(Date.now() - started).toBeLessThan(5000);
        expect(error).toMatchObject({ code: 'DB_UNAVAILABLE', meta: { reason: 'timeout', retryable: false } });
      } finally {
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );

  it.each([
    ['an unknown dialect', { dialect: 'oracle' }, 'dialect'],
    ['a missing database', { dialect: 'mysql', user: 'altis' }, 'database'],
    ['a missing user', { dialect: 'postgres', database: 'altis' }, 'user'],
    ['a port out of range', { dialect: 'mysql', user: 'a', database: 'b', port: 70000 }, 'port'],
    ['a fractional port', { dialect: 'postgres', user: 'a', database: 'b', port: 54.5 }, 'port'],
    ['an empty host', { dialect: 'mariadb', user: 'a', database: 'b', host: '' }, 'host'],
  ])('refuses %s with INVALID_CONFIG', async (_name, cfg, field) => {
    const error = await rejection(
      connect(cfg as DbConfig, { runtime: 'standalone', purpose: 'server', dataDir: os.tmpdir() }),
    );
    expect(error).toMatchObject({ code: 'INVALID_CONFIG', meta: { field } });
  });
});
