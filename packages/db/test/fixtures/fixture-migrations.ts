import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import type { Dialect } from '../../src/connect.js';
import { ensureIndex, ensureTable } from '../../src/ddl.js';
import type { AltisMigration } from '../../src/migrator.js';

// The fixture migrations of migrator.test.ts and migrate-child.mjs: 0001_a, 0002_b (a contract requiring code
// 0.2.0) and 0003_c. Each one does real DDL through the DDL helpers and then records itself in RUNS_TABLE, so a
// test can count how many times each `up` took effect.

/** One row per completed `up`: (id, name). Created by the test (not a migration, not registered). */
export const RUNS_TABLE = 't_mig_runs';

type RunsTables = { t_mig_runs: { id: string; name: string } };

export async function createRunsTable<T>(db: Kysely<T>): Promise<void> {
  await (db as unknown as Kysely<RunsTables>).schema
    .createTable(RUNS_TABLE)
    .addColumn('id', 'varchar(80)', (c) => c.primaryKey())
    .addColumn('name', 'varchar(64)', (c) => c.notNull())
    .execute();
}

/** How many times each migration recorded itself. */
export async function runsPerName<T>(db: Kysely<T>): Promise<Record<string, number>> {
  const rows = await (db as unknown as Kysely<RunsTables>).selectFrom(RUNS_TABLE).select('name').execute();
  const counts: Record<string, number> = {};
  for (const { name } of rows) counts[name] = (counts[name] ?? 0) + 1;
  return counts;
}

export interface FixtureOptions {
  /** This migration throws on its first invocation (after its DDL, before recording itself). */
  failFirst?: string;
  /** Pause at the end of every `up`, to widen the window in which two processes could overlap. */
  delayMs?: number;
  /** Called at the start of every `up` invocation. */
  onUp?: (name: string) => void;
  /**
   * 0001_a then keeps the database busy this long with back-to-back statements. On SQLite (node:sqlite is
   * synchronous) that is one unbroken chain of microtasks: timers such as the lock heartbeat only run when the
   * code yields to the event loop.
   */
  busyMs?: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function fixtureMigrations(o: FixtureOptions = {}): Record<string, AltisMigration> {
  let failed = false;
  const step =
    (name: string, work: (db: Kysely<never>, dialect: Dialect) => Promise<void>) =>
    async (db: Kysely<never>, dialect: Dialect): Promise<void> => {
      o.onUp?.(name);
      await work(db, dialect);
      if (o.busyMs !== undefined && name === '0001_a') {
        const until = performance.now() + o.busyMs;
        for (let n = 0; performance.now() < until; n += 1) await sql`select ${n} as n`.execute(db);
      }
      if (o.failFirst === name && !failed) {
        failed = true;
        throw new Error(`fixture failure in ${name}`);
      }
      await (db as unknown as Kysely<RunsTables>)
        .insertInto(RUNS_TABLE)
        .values({ id: `${name}-${process.pid}-${randomUUID()}`, name })
        .execute();
      if (o.delayMs !== undefined) await sleep(o.delayMs);
    };
  return {
    '0001_a': {
      up: step('0001_a', (db, dialect) =>
        ensureTable(db, dialect, 't_fx_a', 'data', '0001_a', (t) => {
          t.id();
          t.key191('code_key');
        }),
      ),
    },
    '0002_b': {
      contract: { minCodeVersion: '0.2.0' },
      up: step('0002_b', (db, dialect) =>
        ensureTable(db, dialect, 't_fx_b', 'data', '0002_b', (t) => {
          t.id();
          t.ulid('a_id');
          t.foreignKey('a_id', 't_fx_a', 'id', { onDelete: 'cascade' });
        }),
      ),
    },
    '0003_c': {
      up: step('0003_c', (db, dialect) => ensureIndex(db, dialect, 't_fx_a', 'uq_t_fx_a_code_key', ['code_key'], { unique: true })),
    },
  };
}
