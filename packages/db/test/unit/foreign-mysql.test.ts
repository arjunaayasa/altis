import { format, type PoolOptions } from 'mysql2';
import { afterEach, describe, expect, it } from 'vitest';
import { __setForeignMysqlPoolFactory, openForeignMysql, type ForeignMysqlConfig } from '../../src/foreign-mysql.js';

// The read-only client of a FOREIGN MySQL/MariaDB server (Phase 2 preflight B5): the SLiMS database of a migration.
// Its pool options are checked through the test-profile pool factory; nothing here needs a database server.

const CFG: ForeignMysqlConfig = { host: 'slims.example', port: 3307, user: 'baca', password: 'rahasia', database: 'slims', tls: false };

interface FakeField {
  type: string;
  string(): string | null;
  buffer(): Buffer | null;
}

/** A field as mysql2 hands it to typeCast. */
function field(type: string, text: string | null): FakeField {
  return { type, string: () => text, buffer: () => (text === null ? null : Buffer.from(text, 'utf8')) };
}

interface Fake {
  options: PoolOptions;
  queries: { sql: string; values: unknown[] }[];
  ended: number;
  /** The pool's event listeners, by event. */
  listeners: Map<string, ((...args: unknown[]) => void)[]>;
}

/** A pool that records what it was built with and answers every query with `rows`. */
function fakePool(rows: Record<string, unknown>[] = [], fail?: Error): { fake: Fake } {
  const fake: Fake = { options: {}, queries: [], ended: 0, listeners: new Map() };
  __setForeignMysqlPoolFactory((options) => {
    fake.options = options;
    return {
      on: (event: string, listener: (...args: unknown[]) => void) => {
        fake.listeners.set(event, [...(fake.listeners.get(event) ?? []), listener]);
      },
      getConnection: (cb: (error: Error | null, conn?: { release(): void }) => void) => (fail ? cb(fail) : cb(null, { release: () => undefined })),
      query: (o: { sql: string; values: unknown[] }, cb: (error: Error | null, rows?: unknown) => void) => {
        fake.queries.push({ sql: o.sql, values: o.values });
        cb(null, rows);
      },
      end: (cb: (error: Error | null) => void) => {
        fake.ended += 1;
        cb(null);
      },
    } as never;
  });
  return { fake };
}

afterEach(() => {
  __setForeignMysqlPoolFactory(null);
});

describe('openForeignMysql', () => {
  it('builds a pool of one connection with LOCAL INFILE off, no multiple statements and no infile stream factory', async () => {
    const { fake } = fakePool();
    const db = await openForeignMysql(CFG, { connectTimeoutMs: 10_000 });
    expect(fake.options).toMatchObject({
      host: 'slims.example',
      port: 3307,
      user: 'baca',
      password: 'rahasia',
      database: 'slims',
      connectionLimit: 1,
      connectTimeout: 10_000,
      multipleStatements: false,
    });
    expect(fake.options.flags).toContain('-LOCAL_FILES');
    expect('infileStreamFactory' in fake.options).toBe(false);
    expect(fake.options.ssl).toBeUndefined();
    await db.close();
    await db.close();
    expect(fake.ended).toBe(1);
  });

  it('asks for TLS when the configuration says so', async () => {
    const { fake } = fakePool();
    const db = await openForeignMysql({ ...CFG, tls: true }, { connectTimeoutMs: 5_000 });
    expect(fake.options.ssl).toMatchObject({ rejectUnauthorized: true });
    await db.close();
  });

  it('reads every character column as a Buffer and keeps numbers and dates as the dump has them', async () => {
    const { fake } = fakePool();
    const db = await openForeignMysql(CFG, { connectTimeoutMs: 10_000 });
    const cast = fake.options.typeCast as (f: FakeField, next: () => unknown) => unknown;
    const next = (): unknown => 42;
    for (const type of ['VAR_STRING', 'VARCHAR', 'STRING', 'BLOB', 'TINY_BLOB', 'MEDIUM_BLOB', 'LONG_BLOB', 'ENUM', 'SET', 'JSON']) {
      const value = cast(field(type, 'Café'), next);
      expect([type, Buffer.isBuffer(value)]).toEqual([type, true]);
      expect((value as Buffer).toString('utf8')).toBe('Café');
    }
    expect(cast(field('VAR_STRING', null), next)).toBeNull();
    expect(cast(field('LONG', '7'), next)).toBe(42);
    expect(cast(field('NEWDECIMAL', '12.50'), next)).toBe('12.50');
    expect(cast(field('NEWDECIMAL', '125000'), next)).toBe(125000);
    expect(cast(field('DOUBLE', '1.5'), next)).toBe('1.5');
    expect(cast(field('DATETIME', '0000-00-00 00:00:00'), next)).toBe('0000-00-00 00:00:00');
    expect(cast(field('DATE', null), next)).toBeNull();
    expect(cast({ type: 'BIT', string: () => null, buffer: () => Buffer.from([0x01, 0x01]) }, next)).toBe(257);
    await db.close();
  });

  it('passes the statement and its ?? and ? values to the pool as they are, with a timeout', async () => {
    const { fake } = fakePool([{ a: 1 }]);
    const db = await openForeignMysql(CFG, { connectTimeoutMs: 10_000 });
    const rows = await db.query('SELECT ?? FROM ?? WHERE ?? > ? LIMIT ?', ['cf_4c5d6', 'biblio_custom', 'biblio_id', 5, 500]);
    expect(rows).toEqual([{ a: 1 }]);
    expect(fake.queries).toEqual([{ sql: 'SELECT ?? FROM ?? WHERE ?? > ? LIMIT ?', values: ['cf_4c5d6', 'biblio_custom', 'biblio_id', 5, 500] }]);
    // mysql2 quotes a `??` value as an identifier, so a hostile column name stays one identifier.
    expect(format('SELECT ?? FROM ??', ['cf_x` FROM user; --', 'biblio_custom'])).toBe('SELECT `cf_x`` FROM user; --` FROM `biblio_custom`');
    await db.close();
  });

  it('sets the session time zone of each new connection to UTC, and drops a connection that cannot', async () => {
    const { fake } = fakePool();
    const db = await openForeignMysql(CFG, { connectTimeoutMs: 10_000 });
    const connection = (fail: Error | null): { sent: string[]; destroyed: number } => {
      const conn = { sent: [] as string[], destroyed: 0 };
      const handle = {
        on: () => undefined,
        query: (sql: string, cb: (error: Error | null) => void) => {
          conn.sent.push(sql);
          cb(fail);
        },
        destroy: () => {
          conn.destroyed += 1;
        },
      };
      for (const listener of fake.listeners.get('connection') ?? []) listener(handle);
      return conn;
    };
    expect(connection(null)).toEqual({ sent: ["SET time_zone = '+00:00'"], destroyed: 0 });
    expect(connection(new Error('denied'))).toEqual({ sent: ["SET time_zone = '+00:00'"], destroyed: 1 });
    await db.close();
  });

  it('closes the pool and throws the error when the first connection fails', async () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    const { fake } = fakePool([], refused);
    await expect(openForeignMysql(CFG, { connectTimeoutMs: 10_000 })).rejects.toBe(refused);
    expect(fake.ended).toBe(1);
  });

  it('reaches a real socket that refuses, without a server check', async () => {
    __setForeignMysqlPoolFactory(null);
    await expect(openForeignMysql({ ...CFG, host: '127.0.0.1', port: 1 }, { connectTimeoutMs: 2_000 })).rejects.toMatchObject({ code: 'ECONNREFUSED' });
  });
});
