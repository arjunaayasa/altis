import type { DB } from '@altis/db';
import { DummyDriver, Kysely, MysqlAdapter, MysqlIntrospector, MysqlQueryCompiler, type CompiledQuery, type DatabaseConnection, type QueryResult } from 'kysely';
import { describe, expect, it } from 'vitest';
import { txCtx } from '../../src/context.js';
import { finishBatch } from '../../src/stocktake/jobs.js';

// On MySQL/MariaDB (REPEATABLE READ) the first plain read of a transaction fixes its snapshot. A finish batch must
// lock its copies before that read, or a loan committed while it waited for a copy's lock stays out of its sight and
// a copy on loan is marked missing. Compiled for MySQL without a server: the statements a batch sends, in order.

/** A MySQL connection that answers one pending row of the session and nothing else, and keeps every statement. */
class Recording extends DummyDriver {
  readonly sql: string[] = [];
  override async acquireConnection(): Promise<DatabaseConnection> {
    const sql = this.sql;
    return {
      async executeQuery<R>(q: CompiledQuery): Promise<QueryResult<R>> {
        sql.push(q.sql);
        const pending = /^select .* from `stocktake_items`/.test(q.sql) && sql.filter((s) => s.includes('from `stocktake_items`')).length === 1;
        return { rows: (pending ? [{ item_id: 'I1', state: 'pending', expected: 1, scanned_at: null }] : []) as R[] };
      },
      // eslint-disable-next-line require-yield
      async *streamQuery() {
        return;
      },
    };
  }
}

describe('stocktake finish on MySQL/MariaDB', () => {
  it('locks the batch rows and their copies before its first plain read', async () => {
    const driver = new Recording();
    const db = new Kysely<DB>({
      dialect: { createAdapter: () => new MysqlAdapter(), createDriver: () => driver, createIntrospector: (d) => new MysqlIntrospector(d), createQueryCompiler: () => new MysqlQueryCompiler() },
    });
    const more = await db.transaction().execute((trx) => finishBatch(txCtx(trx, 0, { type: 'system', id: null, ip: null }), 'B', 'S', { markMissing: true, restoreFound: true }));
    expect(more).toBe(true);
    const plain = driver.sql.findIndex((s) => s.startsWith('select') && !s.endsWith('for update'));
    const itemLock = driver.sql.findIndex((s) => s.startsWith('update `items`'));
    expect(itemLock).toBeGreaterThanOrEqual(0);
    expect(plain).toBeGreaterThan(itemLock);
  });
});
