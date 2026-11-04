import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { connect, type DbConfig, type DbHandle } from '@altis/db';
import { sql } from 'kysely';
import { inject } from 'vitest';

// Database test helpers (spec §12.3). The engine is picked per run with ALTIS_TEST_DB; global-setup.ts creates one
// database per Vitest worker, `altis_t_<runId>_<VITEST_POOL_ID>`, and drops them when the run ends. SQLite uses
// one data directory (and so one database file) per worker instead.
//
// 1c Task 29 (preflight M37): a second engine for the cross-dialect restore matrix, ALTIS_TEST_DB_SOURCE (the engine a
// backup is made on; ALTIS_TEST_DB is the one it is restored into). global-setup.ts creates the per-worker databases
// on the source engine's server too, under the same names; testDbFor(engine) opens either engine's.

export const TEST_ENGINES = ['sqlite', 'mysql80', 'mysql84', 'mariadb106', 'mariadb114', 'pg15', 'pg17'] as const;

export type TestEngine = (typeof TEST_ENGINES)[number];

/** The dialect each engine is reached with, and its port on 127.0.0.1 (tools/test/compose.yml). */
export const ENGINE_SPECS: Readonly<Record<TestEngine, { dialect: DbConfig['dialect']; port: number | null }>> = {
  sqlite: { dialect: 'sqlite', port: null },
  mysql80: { dialect: 'mysql', port: 33080 },
  mysql84: { dialect: 'mysql', port: 33084 },
  mariadb106: { dialect: 'mariadb', port: 33106 },
  mariadb114: { dialect: 'mariadb', port: 33114 },
  pg15: { dialect: 'postgres', port: 54315 },
  pg17: { dialect: 'postgres', port: 54317 },
};

/** Test-only credentials, the same as in compose.yml. */
export const TEST_DB_USER = 'altis';
export const TEST_DB_PASSWORD = 'altis_test_pw';
export const TEST_DB_ROOT_PASSWORD = 'altis_root_pw';

/** What global-setup.ts hands to the test files. */
export interface TestDbContext {
  engine: TestEngine;
  /** Unique per `vitest run`; part of every database name. */
  runId: string;
  /** False when the engine's server could not be reached (and ALTIS_TEST_DB_REQUIRED was not `1`). */
  available: boolean;
  /** Why the engine is not available, or null. */
  reason: string | null;
  /** 1c Task 29: ALTIS_TEST_DB_SOURCE, the second engine of a restore pair; null when unset. */
  source: TestEngine | null;
  /** The source engine's per-worker databases exist (always true for SQLite, or a source equal to `engine`). */
  sourceAvailable: boolean;
  /** Why the source engine is not available, or null. */
  sourceReason: string | null;
}

declare module 'vitest' {
  interface ProvidedContext {
    altisTestDb: TestDbContext;
  }
}

/** ALTIS_TEST_DB: unset or empty means `sqlite`; anything else must name one of {@link TEST_ENGINES}. */
export function parseTestEngine(value: string | undefined): TestEngine {
  const v = value?.trim() ?? '';
  if (v === '') return 'sqlite';
  if ((TEST_ENGINES as readonly string[]).includes(v)) return v as TestEngine;
  throw new Error(`ALTIS_TEST_DB=${JSON.stringify(value)} is not one of ${TEST_ENGINES.join(', ')}`);
}

/** 1c Task 29: ALTIS_TEST_DB_SOURCE: unset or empty means none (null); anything else must name one of {@link TEST_ENGINES}. */
export function parseSourceEngine(value: string | undefined): TestEngine | null {
  return (value?.trim() ?? '') === '' ? null : parseTestEngine(value);
}

/** Host of the test engines: ALTIS_TEST_DB_HOST, default 127.0.0.1. */
export function testDbHost(): string {
  const host = process.env['ALTIS_TEST_DB_HOST']?.trim();
  return host !== undefined && host !== '' ? host : '127.0.0.1';
}

export function testDbName(runId: string, poolId: number | string): string {
  return `altis_t_${runId}_${poolId}`;
}

/** Temp folder of a run; global teardown removes it. */
export function testRunDir(runId: string): string {
  return path.join(os.tmpdir(), `altis_t_${runId}`);
}

/** DATA_DIR of one worker (the SQLite database lives in its `db` area). */
export function testDataDir(runId: string, poolId: number | string): string {
  return path.join(testRunDir(runId), `w${poolId}`);
}

/** The context provided by global-setup.ts. Call it from a test file (module scope is fine). */
export function testDbContext(): TestDbContext {
  return inject('altisTestDb');
}

/**
 * The engine name for suite titles. When the engine is not available it also says why, so that the skipped
 * suite shows the reason in the report: `describe.skipIf(!testDbContext().available)(\`x [${engineLabel()}]\`, ...)`.
 */
export function engineLabel(): string {
  const ctx = testDbContext();
  return ctx.available ? ctx.engine : `${ctx.engine}, SKIPPED: ${ctx.reason ?? 'not available'}`;
}

/** A {@link DbHandle} on the worker's test database, plus what a child process needs to open it again. */
export interface TestDbHandle extends DbHandle {
  engine: TestEngine;
  config: DbConfig;
  dataDir: string;
}

function poolId(): string {
  return process.env['VITEST_POOL_ID'] ?? '1';
}

/** The connection settings of the current worker's test database (on `engine`, default the run's ALTIS_TEST_DB). */
export function testDbConfig(ctx: TestDbContext = testDbContext(), engine: TestEngine = ctx.engine): DbConfig {
  const spec = ENGINE_SPECS[engine];
  if (spec.port === null) return { dialect: spec.dialect };
  return {
    dialect: spec.dialect,
    host: testDbHost(),
    port: spec.port,
    user: TEST_DB_USER,
    password: TEST_DB_PASSWORD,
    database: testDbName(ctx.runId, poolId()),
  };
}

/**
 * Drops every table (and view) of the database `h` is connected to, on one connection so that the session-level
 * foreign-key switch applies to all the drops.
 */
export async function emptyDatabase(h: DbHandle): Promise<void> {
  const tables = await h.db.introspection.getTables({ withInternalKyselyTables: true });
  await h.db.connection().execute(async (c) => {
    if (h.dialect === 'mysql' || h.dialect === 'mariadb') await sql`SET FOREIGN_KEY_CHECKS = 0`.execute(c);
    if (h.dialect === 'sqlite') await sql`PRAGMA foreign_keys = OFF`.execute(c);
    try {
      for (const t of tables) {
        const schema = t.schema !== undefined && h.dialect === 'postgres' ? c.schema.withSchema(t.schema) : c.schema;
        if (t.isView) {
          await schema.dropView(t.name).ifExists().execute();
        } else if (h.dialect === 'postgres') {
          await schema.dropTable(t.name).ifExists().cascade().execute();
        } else {
          await schema.dropTable(t.name).ifExists().execute();
        }
      }
    } finally {
      if (h.dialect === 'mysql' || h.dialect === 'mariadb') await sql`SET FOREIGN_KEY_CHECKS = 1`.execute(c);
      if (h.dialect === 'sqlite') await sql`PRAGMA foreign_keys = ON`.execute(c);
    }
  });
}

/**
 * Connects to the current worker's test database (engine from ALTIS_TEST_DB) as runtime `standalone`, purpose
 * `server`. The database is emptied first unless `reset` is false: test files run one after another in a worker
 * and share its database, so each file starts from an empty one. Pass `reset: false` for a second handle on a
 * database another handle is using. Close the handle when done.
 *
 * Throws when the engine is not available: guard the suite with `describe.skipIf(!testDbContext().available)`.
 */
export async function testDb(o: { reset?: boolean } = {}): Promise<TestDbHandle> {
  const ctx = testDbContext();
  if (!ctx.available) {
    throw new Error(`testDb(): ${ctx.engine} is not available (${ctx.reason ?? 'unknown reason'})`);
  }
  return testDbFor(ctx.engine, o);
}

/**
 * 1c Task 29 (preflight M37): as {@link testDb}, on `engine`: the run's ALTIS_TEST_DB, or its ALTIS_TEST_DB_SOURCE
 * (the second engine of a restore pair, whose per-worker database global-setup.ts created under the same name). A
 * source equal to the run's engine is the same database. `dataDir` (default the worker's DATA_DIR) is the handle's
 * DATA_DIR; on SQLite it holds the database file (`db/altis.sqlite`), so one test can hold two SQLite installations.
 * The database is emptied first unless `reset` is false. Close the handle when done.
 *
 * Throws for an engine that is neither of the two, and for one that is not available: guard the suite with
 * `testDbContext().available` and `.sourceAvailable`.
 */
export async function testDbFor(engine: TestEngine, o: { reset?: boolean; dataDir?: string } = {}): Promise<TestDbHandle> {
  const ctx = testDbContext();
  const target = engine === ctx.engine;
  if (!target && engine !== ctx.source) {
    throw new Error(`testDbFor(${engine}): neither ALTIS_TEST_DB (${ctx.engine}) nor ALTIS_TEST_DB_SOURCE (${ctx.source ?? 'unset'})`);
  }
  if (!(target ? ctx.available : ctx.sourceAvailable)) {
    throw new Error(`testDbFor(): ${engine} is not available (${(target ? ctx.reason : ctx.sourceReason) ?? 'unknown reason'})`);
  }
  const dataDir = o.dataDir ?? testDataDir(ctx.runId, poolId());
  await fsp.mkdir(dataDir, { recursive: true });
  const config = testDbConfig(ctx, engine);
  const h = await connect(config, { runtime: 'standalone', purpose: 'server', dataDir });
  try {
    if (o.reset !== false) await emptyDatabase(h);
  } catch (error) {
    await h.close();
    throw error;
  }
  return { ...h, engine, config, dataDir };
}
