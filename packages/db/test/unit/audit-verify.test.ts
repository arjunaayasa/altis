import { Kysely } from 'kysely';
import type { Pool } from 'mysql2';
import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import { verifyAuditChain } from '../../src/audit.js';
import { guardedMysqlDialect, guardedPostgresDialect, type DbHandle } from '../../src/connect.js';
import type { DB } from '../../src/schema.js';

// verifyAuditChain reports a broken chain only for a row the driver cannot decode (a RangeError: PostgreSQL's int8
// parser, node:sqlite's ERR_OUT_OF_RANGE). A database failure that arrives as a plain Error without a driver code
// (mysql2 'Pool is closed.', pg-pool 'Cannot use a pool after calling end', Kysely 'driver has already been
// destroyed') must be rethrown: reported as a break it would be a false tamper alarm (final review, fixNow 2).
// The database is a scripted fake pool behind the real Kysely MySQL driver and the driver layer.

/** What the fake answers for a statement: rows, or an error to fail it with. */
type Answer = Record<string, unknown>[] | Error;

/** A mysql2 pool whose connections answer each statement through `answer`; getConnection fails with `refuse()`. */
function fakeMysqlPool(answer: (sqlText: string) => Answer, refuse: (call: number) => Error | null = () => null) {
  let calls = 0;
  const connection = {
    threadId: 1,
    config: {},
    query(sqlText: string, _parameters: unknown, callback: (error: unknown, rows?: unknown) => void) {
      const result = answer(sqlText);
      setImmediate(() => (result instanceof Error ? callback(result) : callback(null, result)));
      return {};
    },
    release: () => undefined,
    destroy: () => undefined,
  };
  return {
    getConnection(callback: (error: unknown, conn?: unknown) => void) {
      calls += 1;
      const refused = refuse(calls);
      process.nextTick(() => (refused === null ? callback(null, connection) : callback(refused)));
    },
    end: (callback: (error: unknown) => void) => callback(null),
  };
}

function handle(db: Kysely<DB>): DbHandle {
  return { db, dialect: 'mysql', limits: { maxUserConnections: 0, maxConnections: 10 }, poolSize: 1, close: () => db.destroy() };
}

const HEAD = [{ last_seq: 3, last_hash: 'f'.repeat(64) }];

/** audit_head answers; audit_log reads get `log`. */
const scripted = (log: () => Answer) => (sqlText: string): Answer => (sqlText.includes('audit_head') ? HEAD : log());

describe('verifyAuditChain rethrows database failures that carry no driver code', () => {
  it("rethrows mysql2's 'Pool is closed.' when reading audit_head", async () => {
    const closed = new Error('Pool is closed.');
    const pool = fakeMysqlPool(scripted(() => []), () => closed);
    const h = handle(new Kysely<DB>({ dialect: guardedMysqlDialect(pool as unknown as Pool) }));
    await expect(verifyAuditChain(h)).rejects.toBe(closed);
  });

  it("rethrows mysql2's 'Pool is closed.' when reading audit_log (batch and row by row)", async () => {
    const closed = new Error('Pool is closed.');
    const pool = fakeMysqlPool(scripted(() => []), (call) => (call >= 2 ? closed : null));
    const h = handle(new Kysely<DB>({ dialect: guardedMysqlDialect(pool as unknown as Pool) }));
    await expect(verifyAuditChain(h)).rejects.toBe(closed);
  });

  it("rethrows Kysely's 'driver has already been destroyed' after the handle was closed", async () => {
    const pool = fakeMysqlPool(scripted(() => []));
    const db = new Kysely<DB>({ dialect: guardedMysqlDialect(pool as unknown as Pool) });
    await db.selectFrom('audit_head').selectAll().execute(); // initializes the driver, so destroy() really destroys
    await db.destroy();
    await expect(verifyAuditChain(handle(db))).rejects.toThrow('driver has already been destroyed');
  });

  it("rethrows pg-pool's 'Cannot use a pool after calling end'", async () => {
    const ended = new Error('Cannot use a pool after calling end on the pool');
    const pool = { options: { max: 1 }, connect: () => Promise.reject(ended), end: () => Promise.resolve() };
    const db = new Kysely<DB>({ dialect: guardedPostgresDialect(pool as unknown as pg.Pool) });
    await expect(verifyAuditChain({ ...handle(db), dialect: 'postgres' })).rejects.toBe(ended);
  });

  it('rethrows a plain Error of a statement (not a value the driver cannot decode)', async () => {
    const failure = new Error('something went wrong');
    const pool = fakeMysqlPool(scripted(() => failure));
    const h = handle(new Kysely<DB>({ dialect: guardedMysqlDialect(pool as unknown as Pool) }));
    await expect(verifyAuditChain(h)).rejects.toBe(failure);
  });
});

describe('verifyAuditChain still reports an undecodable row as a break', () => {
  it.each([
    ['a RangeError (pg int8 parser)', () => new RangeError('BIGINT 9223372036854775807 is outside the safe integer range')],
    [
      "node:sqlite's ERR_OUT_OF_RANGE",
      () => Object.assign(new RangeError('Value is too large to be represented as a JavaScript number'), { code: 'ERR_OUT_OF_RANGE' }),
    ],
  ])('%s while reading audit_log breaks the chain at seq 1', async (_name, make) => {
    const pool = fakeMysqlPool(scripted(make));
    const h = handle(new Kysely<DB>({ dialect: guardedMysqlDialect(pool as unknown as Pool) }));
    expect(await verifyAuditChain(h)).toEqual({ ok: false, brokenAt: 1 });
  });

  it('a RangeError while reading audit_head breaks the chain at seq 1', async () => {
    const pool = fakeMysqlPool(() => new RangeError('BIGINT out of range'));
    const h = handle(new Kysely<DB>({ dialect: guardedMysqlDialect(pool as unknown as Pool) }));
    expect(await verifyAuditChain(h)).toEqual({ ok: false, brokenAt: 1 });
  });
});
