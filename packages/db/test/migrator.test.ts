import { fork, type ChildProcess } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { utimes } from 'node:fs/promises';
import { inspect } from 'node:util';
import { atomicWriteJson, dataPath, ensureDir, lockHostIdentity, processStartMs } from '@altis/platform';
import { DomainError, isDomainError } from '@altis/shared';
import { sql, type Kysely } from 'kysely';
import { Migrator } from 'kysely/migration';
import mysql from 'mysql2/promise';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TEST_DB_ROOT_PASSWORD,
  TEST_DB_USER,
  emptyDatabase,
  engineLabel,
  testDb,
  testDbContext,
  type TestDbHandle,
} from '../../../tools/test/test-db.js';
import { connect, type DbHandle } from '../src/connect.js';
import { markInDoubt, normalizeDbError } from '../src/db-errors.js';
import {
  MIGRATOR_TABLES,
  MigrationError,
  failureOf,
  keptAfterFailure,
  migrateUpOne,
  readSchemaMetaMirror,
  runMigrations,
  safeChain,
  type AltisMigration,
  type MigrationOutcome,
} from '../src/migrator.js';
import { createRunsTable, fixtureMigrations, runsPerName } from './fixtures/fixture-migrations.js';

// Spec §6.4: Kysely Migrator with an in-code provider, schema_meta + the releases/schema-meta.json mirror,
// schema-ahead / too-old decided before the Migrator is ever constructed, and a file lock around Kysely's own lock
// so that two processes apply each migration exactly once (review focus 5).

type MetaTables = {
  schema_meta: { id: number; schema_version: string; min_code_version: string; install_id: string | null };
  schema_migrations: { name: string; timestamp: string };
  schema_tables: { name: string; class: string; created_by: string };
};

const meta = (h: DbHandle) => h.db as unknown as Kysely<MetaTables>;

const ALL = ['0001_a', '0002_b', '0003_c'];

/** Spies on every public method of Kysely's Migrator that could run or inspect migrations. */
function spyMigrator() {
  return [
    vi.spyOn(Migrator.prototype, 'migrateToLatest'),
    vi.spyOn(Migrator.prototype, 'migrateUp'),
    vi.spyOn(Migrator.prototype, 'migrateTo'),
    vi.spyOn(Migrator.prototype, 'migrateDown'),
    vi.spyOn(Migrator.prototype, 'getMigrations'),
  ];
}

/** A stand-in handle whose database throws on any use: proves that a check happens before the DB is touched. */
const untouchable = {
  dialect: 'sqlite',
  db: new Proxy(
    {},
    {
      get() {
        throw new Error('the database was touched');
      },
    },
  ),
} as unknown as DbHandle;

describe('runMigrations / migrateUpOne: arguments are checked before the database is touched', () => {
  const dataDir = path.join(os.tmpdir(), 'altis-never-created');
  const ok = { appVersion: '0.3.0', dataDir, migrations: fixtureMigrations() };
  const up = { up: async () => {} } satisfies AltisMigration;

  it.each([
    ['an invalid appVersion', { ...ok, appVersion: 'v1' }],
    ['a migration name without the NNNN_ prefix', { ...ok, migrations: { first: up } }],
    ['a migration name with upper case', { ...ok, migrations: { '0001_First': up } }],
    ['two migrations with the same number', { ...ok, migrations: { '0001_a': up, '0001_b': up } }],
    ['a migration without up()', { ...ok, migrations: { '0001_a': {} as AltisMigration } }],
    ['an invalid contract version', { ...ok, migrations: { '0001_a': { ...up, contract: { minCodeVersion: '1' } } } }],
    [
      'a contract requiring newer code than appVersion',
      { ...ok, migrations: { '0001_a': { ...up, contract: { minCodeVersion: '0.4.0' } } } },
    ],
    ['a negative lockWaitMs', { ...ok, lockWaitMs: -1 }],
    // Wider than the columns that hold them: every dialect refuses the same way, before anything is touched.
    [
      'a contract version longer than 32 characters',
      { ...ok, migrations: { '0001_a': { ...up, contract: { minCodeVersion: '0.1.0-rc.1+build.20261027.abcdef01' } } } },
    ],
    ['a migration name longer than 191 characters', { ...ok, migrations: { [`0001_${'a'.repeat(187)}`]: up } }],
  ])('refuses %s with a TypeError', async (_label, o) => {
    await expect(runMigrations(untouchable, o)).rejects.toThrow(TypeError);
    await expect(migrateUpOne(untouchable, o)).rejects.toThrow(TypeError);
  });
});

describe('keptAfterFailure: what a failed run reports as still applied (item 11)', () => {
  const before = ['0001_a'];
  it('is what schema_migrations holds beyond the run start, when it could be read back', () => {
    for (const dialect of ['mysql', 'postgres', 'sqlite'] as const) {
      expect(keptAfterFailure({ dialect, before, reconciled: { applied: ['0001_a', '0002_b'] }, inBatch: true })).toEqual({
        applied: ['0002_b'],
        appliedVerified: true,
      });
    }
  });

  it('is nothing on PostgreSQL for a failure inside the batch (its transaction rolled back)', () => {
    expect(keptAfterFailure({ dialect: 'postgres', before, reconciled: null, inBatch: true })).toEqual({
      applied: [],
      appliedVerified: true,
    });
  });

  it('is unknown otherwise: a failure after the batch (COMMIT, lock release), or without transactional DDL', () => {
    const unknown = { applied: null, appliedVerified: false };
    expect(keptAfterFailure({ dialect: 'postgres', before, reconciled: null, inBatch: false })).toEqual(unknown);
    expect(keptAfterFailure({ dialect: 'mariadb', before, reconciled: null, inBatch: true })).toEqual(unknown);
    expect(keptAfterFailure({ dialect: 'sqlite', before, reconciled: null, inBatch: false })).toEqual(unknown);
  });
});

describe('safe failure chains: what is safe stays as it is; AggregateError.errors are walked (round 4, items 2-3)', () => {
  // Synthetic driver errors shaped like the ones mysql2, pg and node:sqlite throw, carrying SQL text and a value.
  const SECRET = 'secret-nik-3201';
  const failure = { migration: '0007_backfill', applied: [], appliedVerified: true };
  const mysqlDuplicate = (): Error =>
    Object.assign(new Error(`Duplicate entry '${SECRET}' for key 'members.uq_members_nik'`), {
      code: 'ER_DUP_ENTRY',
      errno: 1062,
      sqlState: '23000',
      sqlMessage: `Duplicate entry '${SECRET}' for key 'members.uq_members_nik'`,
      sql: `insert into members (nik) values ('${SECRET}')`,
      fatal: false,
    });
  const mysqlWrongValue = (): Error =>
    Object.assign(new Error(`Incorrect integer value: '${SECRET}' for column 'n' at row 1`), {
      code: 'ER_TRUNCATED_WRONG_VALUE_FOR_FIELD',
      errno: 1366,
      sqlState: 'HY000',
      sqlMessage: `Incorrect integer value: '${SECRET}' for column 'n' at row 1`,
      sql: `insert into t (n) values ('${SECRET}')`,
      fatal: false,
    });
  const pgNotNull = (): Error =>
    Object.assign(new Error('null value in column "x" of relation "t" violates not-null constraint'), {
      code: '23502',
      severity: 'ERROR',
      detail: `Failing row contains (42, ${SECRET}, null).`,
    });
  const pgDuplicate = (): Error =>
    Object.assign(new Error('duplicate key value violates unique constraint "uq_members_nik"'), {
      code: '23505',
      severity: 'ERROR',
      constraint: 'uq_members_nik',
      detail: `Key (nik)=(${SECRET}) already exists.`,
    });
  const sqliteDuplicate = (): Error =>
    Object.assign(new Error('UNIQUE constraint failed: members.nik'), { code: 'ERR_SQLITE_ERROR', errcode: 2067, errstr: 'constraint failed' });
  const sqliteStrict = (): Error =>
    Object.assign(new Error('cannot store TEXT value in INTEGER column t.n'), { code: 'ERR_SQLITE_ERROR', errcode: 3091, errstr: 'constraint failed' });
  const lostWrite = (): DomainError =>
    markInDoubt(
      normalizeDbError(Object.assign(new Error('Connection lost: The server closed the connection.'), { code: 'PROTOCOL_CONNECTION_LOST', fatal: true })) as DomainError,
    );

  function expectNothingUnsafe(error: unknown, rawMessages: string[]): void {
    for (const text of [(error as Error).message, JSON.stringify(error), inspect(error, { depth: 10 })]) {
      expect(text).not.toContain(SECRET);
      expect(text).not.toMatch(/insert into/i);
      for (const raw of rawMessages) expect(text).not.toContain(raw);
    }
  }

  it.each([
    ['MySQL/MariaDB', mysqlDuplicate, 'uq_members_nik'],
    ['PostgreSQL', pgDuplicate, 'uq_members_nik'],
    ['SQLite', sqliteDuplicate, 'members.nik'],
  ])('keeps a wrapped, normalized UNIQUE_VIOLATION intact (%s): code and meta survive', (_engine, raw, constraint) => {
    const unique = normalizeDbError(raw()) as DomainError;
    const error = new MigrationError(new Error('0007 backfill failed', { cause: unique }), failure);
    const link = (error.cause as Error).cause;
    expect(link).toBe(unique);
    expect(isDomainError(link)).toBe(true);
    expect(link).toMatchObject({ code: 'UNIQUE_VIOLATION', meta: { constraint } });
    expect(error.message).toContain('0007 backfill failed');
    expectNothingUnsafe(error, [raw().message]);
  });

  it('keeps a wrapped DB_UNAVAILABLE with inDoubt intact', () => {
    const lost = lostWrite();
    const error = new MigrationError(new Error('0007 backfill failed', { cause: lost }), failure);
    expect((error.cause as Error).cause).toBe(lost);
    expect((error.cause as Error).cause).toMatchObject({
      code: 'DB_UNAVAILABLE',
      meta: { reason: 'connection_lost', retryable: true, inDoubt: true },
    });
  });

  it('safeChain returns a chain without raw driver errors as it is (a DomainError in meta.secondary stays one)', () => {
    const lost = lostWrite();
    expect(safeChain(lost)).toBe(lost);
    const unique = normalizeDbError(sqliteDuplicate());
    expect(safeChain(unique)).toBe(unique);
    const wrapped = new Error('x', { cause: unique });
    expect(safeChain(wrapped)).toBe(wrapped);
  });

  it('rebuilds a DomainError link above a raw driver error with its code, detail and meta, and a safe cause', () => {
    const conflict = new DomainError('SCHEMA_CONFLICT', { detail: 'backfill refused', meta: { reason: 't' }, cause: mysqlDuplicate() });
    const error = new MigrationError(new Error('0007 backfill failed', { cause: conflict }), failure);
    const link = (error.cause as Error).cause;
    expect(isDomainError(link)).toBe(true);
    expect(link).toMatchObject({ code: 'SCHEMA_CONFLICT', detail: 'backfill refused', meta: { reason: 't' } });
    expect((link as Error).cause).toEqual({ code: 'ER_DUP_ENTRY', errno: 1062, sqlState: '23000' });
    expectNothingUnsafe(error, [mysqlDuplicate().message]);
    expect(safeChain(conflict)).toMatchObject({ code: 'SCHEMA_CONFLICT', meta: { reason: 't' }, cause: { code: 'ER_DUP_ENTRY' } });
  });

  it('walks AggregateError.errors (Promise.allSettled): raw mysql2, pg and node:sqlite errors are reduced to their safe fields', () => {
    const plain = new Error('batch 4 skipped');
    // A backfill that ran its batches with Promise.allSettled and reports every rejection.
    const aggregate = new AggregateError([mysqlWrongValue(), pgNotNull(), sqliteStrict(), plain], 'backfill failed');
    for (const cause of [aggregate, new Error('0007 backfill failed', { cause: aggregate })]) {
      const error = new MigrationError(cause, failure);
      expectNothingUnsafe(error, [mysqlWrongValue().message, pgNotNull().message, sqliteStrict().message]);
      expect(error.message).toContain(cause.message);
      expect(error.driverError).toMatchObject({ code: 'ER_TRUNCATED_WRONG_VALUE_FOR_FIELD' });
      const safe = cause === aggregate ? error.cause : (error.cause as { cause: unknown }).cause;
      expect(safe).toEqual({
        name: 'AggregateError',
        message: 'backfill failed',
        errors: [
          { code: 'ER_TRUNCATED_WRONG_VALUE_FOR_FIELD', errno: 1366, sqlState: 'HY000' },
          { code: '23502' },
          { code: 'ERR_SQLITE_ERROR', errno: 3091 },
          plain,
        ],
      });
    }
  });

  it('drops the message of an AggregateError that repeats a driver error text, and keeps one without driver errors', () => {
    const raw = pgNotNull();
    const repeating = new AggregateError([new Error('ok'), raw], `backfill failed: ${raw.message}`);
    const error = new MigrationError(repeating, failure);
    expectNothingUnsafe(error, [raw.message]);
    expect(error.cause).toEqual({ name: 'AggregateError', errors: [new Error('ok'), { code: '23502' }] });
    const harmless = new AggregateError([new Error('a'), new Error('b')], 'two batches failed');
    expect(new MigrationError(harmless, failure).cause).toBe(harmless);
  });

  describe('a DomainError whose detail repeats driver text keeps its code and meta, not the text (round 5, item 5)', () => {
    const conflictOver = (raw: Error) =>
      new DomainError('SCHEMA_CONFLICT', { detail: `backfill refused: ${raw.message}`, meta: { reason: 't' }, cause: raw });

    it.each([
      ['mysql2', mysqlDuplicate, { code: 'ER_DUP_ENTRY', errno: 1062, sqlState: '23000' }],
      ['pg', pgNotNull, { code: '23502' }],
    ])('as a link of the chain (%s)', (_driver, raw, safe) => {
      const error = new MigrationError(new Error('0007 failed', { cause: conflictOver(raw()) }), failure);
      const link = (error.cause as Error).cause as DomainError;
      expect(isDomainError(link)).toBe(true);
      expect(link).toMatchObject({ code: 'SCHEMA_CONFLICT', status: new DomainError('SCHEMA_CONFLICT').status, meta: { reason: 't' } });
      expect(link.detail).toContain(safe.code);
      expect(link.cause).toEqual(safe);
      expectNothingUnsafe(error, [raw().message]);
      expect(link.detail).not.toContain(raw().message);
    });

    it.each([
      ['mysql2', mysqlDuplicate, { code: 'ER_DUP_ENTRY', errno: 1062, sqlState: '23000' }],
      ['pg', pgNotNull, { code: '23502' }],
    ])('thrown by the migration itself (failureOf, %s)', (_driver, raw, safe) => {
      const error = failureOf(conflictOver(raw()), failure) as DomainError;
      expect(isDomainError(error)).toBe(true);
      expect(error).toMatchObject({ code: 'SCHEMA_CONFLICT', meta: { reason: 't', ...failure } });
      expect(error.detail).toContain(safe.code);
      expect(error.detail).toContain('0007_backfill');
      expect(error.cause).toEqual(safe);
      expectNothingUnsafe(error, [raw().message]);
      expect(error.detail).not.toContain(raw().message);
    });

    it('keeps the detail of a DomainError that does not repeat driver text (failureOf)', () => {
      const error = failureOf(new DomainError('SCHEMA_CONFLICT', { detail: 'backfill refused', cause: mysqlDuplicate() }), failure);
      expect(error).toMatchObject({ code: 'SCHEMA_CONFLICT', detail: 'backfill refused [migrasi / migration 0007_backfill]' });
      expect((error as DomainError).cause).toEqual({ code: 'ER_DUP_ENTRY', errno: 1062, sqlState: '23000' });
    });
  });

  describe('SuppressedError (`using` / `await using`): its error and suppressed error are walked (round 5, item 6)', () => {
    // Node 24+ has SuppressedError; the TypeScript/esbuild downlevel helper builds an Error named SuppressedError
    // with enumerable `error` and `suppressed` instead.
    const native = (globalThis as { SuppressedError?: new (error: unknown, suppressed: unknown, message?: string) => Error }).SuppressedError;
    const helper = (error: unknown, suppressed: unknown, message: string): Error =>
      Object.assign(new Error(message), { name: 'SuppressedError', error, suppressed });
    const kinds: [string, (error: unknown, suppressed: unknown, message: string) => Error][] = [['the downlevel helper', helper]];
    if (native !== undefined) kinds.push(['the native one', (error, suppressed, message) => new native(error, suppressed, message)]);

    it.each(kinds)('reduces the raw driver errors in a SuppressedError (%s) to their safe fields', (_kind, make) => {
      const suppressed = make(mysqlWrongValue(), pgNotNull(), 'disposal failed');
      for (const cause of [suppressed, new Error('0007 backfill failed', { cause: suppressed })]) {
        const error = new MigrationError(cause, failure);
        expectNothingUnsafe(error, [mysqlWrongValue().message, pgNotNull().message]);
        const safe = cause === suppressed ? error.cause : (error.cause as { cause: unknown }).cause;
        expect(safe).toEqual({
          name: 'SuppressedError',
          message: 'disposal failed',
          error: { code: 'ER_TRUNCATED_WRONG_VALUE_FOR_FIELD', errno: 1366, sqlState: 'HY000' },
          suppressed: { code: '23502' },
        });
      }
    });

    it.each(kinds)('keeps a SuppressedError (%s) without driver errors as it is', (_kind, make) => {
      const harmless = make(new Error('a'), new Error('b'), 'disposal failed');
      expect(new MigrationError(harmless, failure).cause).toBe(harmless);
    });
  });
});

describe('readSchemaMetaMirror', () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-mirror-'));
  });
  afterEach(async () => {
    await fsp.rm(dataDir, { recursive: true, force: true });
  });

  const file = () => dataPath(dataDir, 'releases', 'schema-meta.json');

  it('is null when the mirror does not exist', async () => {
    expect(await readSchemaMetaMirror(dataDir)).toBeNull();
  });

  it('returns the two fields, ignoring fields it does not know (a newer writer may add some)', async () => {
    await ensureDir(dataPath(dataDir, 'releases'));
    await atomicWriteJson(file(), { schemaVersion: '0042', minCodeVersion: '1.2.3', future: true });
    expect(await readSchemaMetaMirror(dataDir)).toEqual({ schemaVersion: '0042', minCodeVersion: '1.2.3' });
  });

  it('falls back to the .bak copy when the mirror is corrupt, and fails with STATE_CORRUPT when both are', async () => {
    await ensureDir(dataPath(dataDir, 'releases'));
    await atomicWriteJson(file(), { schemaVersion: '0001', minCodeVersion: '0.1.0' });
    await atomicWriteJson(file(), { schemaVersion: '0002', minCodeVersion: '0.1.0' }); // .bak = 0001
    await fsp.writeFile(file(), '{"schemaVersion": "00');
    expect(await readSchemaMetaMirror(dataDir)).toEqual({ schemaVersion: '0001', minCodeVersion: '0.1.0' });
    await fsp.writeFile(`${file()}.bak`, JSON.stringify({ schemaVersion: 'x', minCodeVersion: '0.1.0' }));
    await expect(readSchemaMetaMirror(dataDir)).rejects.toMatchObject({ code: 'STATE_CORRUPT' });
  });
});

const ctx = testDbContext();
const MYSQL_ENGINES: ReadonlySet<string> = new Set(['mysql80', 'mysql84', 'mariadb106', 'mariadb114']);

describe.skipIf(!ctx.available)(`runMigrations [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let dataDir: string;

  beforeAll(async () => {
    h = await testDb({ reset: false });
  });

  afterAll(async () => {
    await h?.close();
  });

  beforeEach(async () => {
    await emptyDatabase(h);
    await createRunsTable(h.db);
    dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-migrate-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fsp.rm(dataDir, { recursive: true, force: true });
  });

  const options = (extra: Partial<Parameters<typeof runMigrations>[1]> = {}) => ({
    appVersion: '0.3.0',
    dataDir,
    migrations: fixtureMigrations(),
    ...extra,
  });

  async function schemaMeta() {
    return meta(h).selectFrom('schema_meta').select(['id', 'schema_version', 'min_code_version']).execute();
  }

  async function appliedNames() {
    const rows = await meta(h).selectFrom('schema_migrations').select('name').execute();
    return rows.map((r) => r.name).sort();
  }

  it('fresh DB: applies all three, records schema_meta and mirrors it to releases/schema-meta.json', async () => {
    const [migrateToLatest] = spyMigrator();
    const outcome = await runMigrations(h, options());
    expect(outcome).toEqual({ mode: 'migrated', applied: ALL, schemaVersion: '0003', minCodeVersion: '0.2.0', edition: { mode: 'empty', applied: [] } });
    // Positive control for the "never called" assertions elsewhere: the spies do see the runner's Migrator.
    expect(migrateToLatest).toHaveBeenCalledTimes(1);
    expect(await schemaMeta()).toEqual([{ id: 1, schema_version: '0003', min_code_version: '0.2.0' }]);
    expect(await appliedNames()).toEqual(ALL);
    expect(await runsPerName(h.db)).toEqual({ '0001_a': 1, '0002_b': 1, '0003_c': 1 });
    const mirror = JSON.parse(await fsp.readFile(dataPath(dataDir, 'releases', 'schema-meta.json'), 'utf8'));
    expect(mirror).toEqual({ schemaVersion: '0003', minCodeVersion: '0.2.0' });
    expect(await readSchemaMetaMirror(dataDir)).toEqual({ schemaVersion: '0003', minCodeVersion: '0.2.0' });
  });

  it("registers the Kysely Migrators' tables in schema_tables as class migrator, the other lane's two included", async () => {
    await runMigrations(h, options());
    const rows = await meta(h)
      .selectFrom('schema_tables')
      .selectAll()
      .where('name', 'in', [...MIGRATOR_TABLES])
      .orderBy('name')
      .execute();
    expect(MIGRATOR_TABLES).toEqual(['schema_migrations', 'schema_migrations_lock', 'schema_migrations_edition', 'schema_migrations_edition_lock']);
    expect(rows).toEqual([
      { name: 'schema_migrations', class: 'migrator', created_by: 'migrator' },
      { name: 'schema_migrations_edition', class: 'migrator', created_by: 'migrator' },
      { name: 'schema_migrations_edition_lock', class: 'migrator', created_by: 'migrator' },
      { name: 'schema_migrations_lock', class: 'migrator', created_by: 'migrator' },
    ]);
  });

  it("creates Kysely's two tables itself, with the house DDL, before the Migrator runs (R27)", async () => {
    await runMigrations(h, options());
    if (h.dialect === 'mysql' || h.dialect === 'mariadb') {
      const { rows: tables } = await sql<{ name: string; engine: string; collation: string }>`
        SELECT TABLE_NAME AS name, ENGINE AS engine, TABLE_COLLATION AS collation FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('schema_migrations', 'schema_migrations_lock')
        ORDER BY TABLE_NAME`.execute(h.db);
      expect(tables).toEqual([
        { name: 'schema_migrations', engine: 'InnoDB', collation: 'utf8mb4_unicode_ci' },
        { name: 'schema_migrations_lock', engine: 'InnoDB', collation: 'utf8mb4_unicode_ci' },
      ]);
      const { rows: keys } = await sql<{ name: string; length: number; collation: string }>`
        SELECT TABLE_NAME AS name, CHARACTER_MAXIMUM_LENGTH AS length, COLLATION_NAME AS collation
        FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()
        AND ((TABLE_NAME = 'schema_migrations' AND COLUMN_NAME = 'name')
          OR (TABLE_NAME = 'schema_migrations_lock' AND COLUMN_NAME = 'id'))
        ORDER BY TABLE_NAME`.execute(h.db);
      // Kysely's own DDL would have made VARCHAR(255) keys in the database's default collation.
      expect(keys.map((k) => ({ ...k, length: Number(k.length) }))).toEqual([
        { name: 'schema_migrations', length: 191, collation: 'utf8mb4_bin' },
        { name: 'schema_migrations_lock', length: 191, collation: 'utf8mb4_bin' },
      ]);
    } else if (h.dialect === 'postgres') {
      const { rows } = await sql<{ table: string; key: string }>`
        SELECT c.relname AS table, k.conname AS key FROM pg_catalog.pg_class c
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_catalog.pg_constraint k ON k.conrelid = c.oid AND k.contype = 'p'
        WHERE n.nspname = current_schema() AND c.relname IN ('schema_migrations', 'schema_migrations_lock')
        ORDER BY c.relname`.execute(h.db);
      // In current_schema(), keyed pk_<table> (Kysely would have made <table>_pkey).
      expect(rows).toEqual([
        { table: 'schema_migrations', key: 'pk_schema_migrations' },
        { table: 'schema_migrations_lock', key: 'pk_schema_migrations_lock' },
      ]);
    } else {
      const { rows } = await sql<{ name: string; ddl: string }>`
        SELECT name, sql AS ddl FROM sqlite_master
        WHERE type = 'table' AND name IN ('schema_migrations', 'schema_migrations_lock') ORDER BY name`.execute(h.db);
      expect(rows.map((r) => r.name)).toEqual(['schema_migrations', 'schema_migrations_lock']);
      for (const row of rows) expect(row.ddl).toContain(`pk_${row.name}`);
    }
  });

  it('refuses with SCHEMA_CONFLICT when schema_tables lists a migrator table under another class (R19)', async () => {
    await runMigrations(h, options({ migrations: {} }));
    await meta(h).updateTable('schema_tables').set({ class: 'data' }).where('name', '=', 'schema_migrations').execute();
    const spies = spyMigrator();
    await expect(runMigrations(h, options())).rejects.toMatchObject({
      code: 'SCHEMA_CONFLICT',
      meta: { reason: 'class_mismatch', table: 'schema_migrations' },
    });
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    expect(await runsPerName(h.db)).toEqual({});
  });

  it('second run: up-to-date, nothing executed again', async () => {
    await runMigrations(h, options());
    const outcome = await runMigrations(h, options());
    expect(outcome).toEqual({ mode: 'up-to-date', applied: [], schemaVersion: '0003', minCodeVersion: '0.2.0', edition: { mode: 'empty', applied: [] } });
    expect(await runsPerName(h.db)).toEqual({ '0001_a': 1, '0002_b': 1, '0003_c': 1 });
  });

  it('an empty set of migrations on a fresh DB: up-to-date at 0000 / 0.0.0', async () => {
    const outcome = await runMigrations(h, options({ migrations: {} }));
    expect(outcome).toEqual({ mode: 'up-to-date', applied: [], schemaVersion: '0000', minCodeVersion: '0.0.0', edition: { mode: 'empty', applied: [] } });
    expect(await readSchemaMetaMirror(dataDir)).toEqual({ schemaVersion: '0000', minCodeVersion: '0.0.0' });
  });

  it('a newer release adds a migration: only that one runs', async () => {
    const older = fixtureMigrations();
    delete older['0003_c'];
    expect(await runMigrations(h, options({ migrations: older }))).toMatchObject({
      mode: 'migrated',
      applied: ['0001_a', '0002_b'],
      schemaVersion: '0002',
    });
    expect(await runMigrations(h, options())).toEqual({
      mode: 'migrated',
      applied: ['0003_c'],
      schemaVersion: '0003',
      minCodeVersion: '0.2.0',
      edition: { mode: 'empty', applied: [] },
    });
  });

  describe('a DB migrated by newer code (9999_future in schema_migrations)', () => {
    async function migratedByNewerCode(minCodeVersion: string) {
      await runMigrations(h, options());
      await meta(h).insertInto('schema_migrations').values({ name: '9999_future', timestamp: new Date().toISOString() }).execute();
      await meta(h).updateTable('schema_meta').set({ schema_version: '9999', min_code_version: minCodeVersion }).where('id', '=', 1).execute();
    }

    it('schema-ahead when appVersion >= min_code_version; the Kysely Migrator is never called', async () => {
      await migratedByNewerCode('0.2.0');
      const spies = spyMigrator();
      const outcome = await runMigrations(h, options({ appVersion: '0.3.0' }));
      expect(outcome).toEqual({ mode: 'schema-ahead', applied: [], schemaVersion: '9999', minCodeVersion: '0.2.0', edition: { mode: 'empty', applied: [] } });
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
      expect(await runsPerName(h.db)).toEqual({ '0001_a': 1, '0002_b': 1, '0003_c': 1 });
      // The mirror follows the database, so the bootloader sees what the newer code wrote.
      expect(await readSchemaMetaMirror(dataDir)).toEqual({ schemaVersion: '9999', minCodeVersion: '0.2.0' });
    });

    it('too-old when appVersion < min_code_version; the Kysely Migrator is never called', async () => {
      await migratedByNewerCode('9.0.0');
      const spies = spyMigrator();
      const outcome = await runMigrations(h, options({ appVersion: '0.3.0' }));
      expect(outcome).toEqual({ mode: 'too-old', applied: [], schemaVersion: '9999', minCodeVersion: '9.0.0', edition: { mode: 'empty', applied: [] } });
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
      expect(await readSchemaMetaMirror(dataDir)).toEqual({ schemaVersion: '9999', minCodeVersion: '9.0.0' });
    });

    it('schema-ahead even when some of this code’s migrations were never applied (they are not run)', async () => {
      const older = fixtureMigrations();
      delete older['0003_c'];
      await runMigrations(h, options({ migrations: older }));
      await meta(h).insertInto('schema_migrations').values({ name: '9999_future', timestamp: new Date().toISOString() }).execute();
      const spies = spyMigrator();
      const outcome = await runMigrations(h, options());
      expect(outcome.mode).toBe('schema-ahead');
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
      expect(await runsPerName(h.db)).toEqual({ '0001_a': 1, '0002_b': 1 });
    });

    it('migrateUpOne: done when schema-ahead, SCHEMA_TOO_NEW when too old', async () => {
      await migratedByNewerCode('0.2.0');
      expect(await migrateUpOne(h, options())).toEqual({ done: true });
      await meta(h).updateTable('schema_meta').set({ min_code_version: '9.0.0' }).where('id', '=', 1).execute();
      await expect(migrateUpOne(h, options())).rejects.toMatchObject({
        code: 'SCHEMA_TOO_NEW',
        meta: { appVersion: '0.3.0', minCodeVersion: '9.0.0', schemaVersion: '9999' },
      });
    });
  });

  it('too-old also when every applied migration is known but min_code_version was raised past appVersion', async () => {
    // A newer release's contract migration raised the floor and stopped before it was recorded.
    await runMigrations(h, options());
    await meta(h).updateTable('schema_meta').set({ min_code_version: '0.4.0' }).where('id', '=', 1).execute();
    const spies = spyMigrator();
    expect(await runMigrations(h, options())).toEqual({
      mode: 'too-old',
      applied: [],
      schemaVersion: '0003',
      minCodeVersion: '0.4.0',
      edition: { mode: 'empty', applied: [] },
    });
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it('refuses with SCHEMA_CONFLICT when a known migration is missing between applied ones', async () => {
    await runMigrations(h, options());
    await meta(h).deleteFrom('schema_migrations').where('name', '=', '0002_b').execute();
    const spies = spyMigrator();
    await expect(runMigrations(h, options())).rejects.toMatchObject({
      code: 'SCHEMA_CONFLICT',
      meta: { reason: 'migration_order', missing: ['0002_b'] },
    });
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it('is not confused by applied timestamps out of name order (a clock that went back)', async () => {
    const older = fixtureMigrations();
    delete older['0003_c'];
    await runMigrations(h, options({ migrations: older }));
    // Kysely orders applied migrations by timestamp; without care it would call this "corrupted migrations".
    await meta(h).updateTable('schema_migrations').set({ timestamp: '2099-01-01T00:00:00.000Z' }).where('name', '=', '0001_a').execute();
    expect(await runMigrations(h, options())).toMatchObject({ mode: 'migrated', applied: ['0003_c'] });
  });

  it('a contract migration raises min_code_version before its own DDL runs', async () => {
    const seen: string[] = [];
    const migrations: Record<string, AltisMigration> = {
      '0001_x': { up: async () => {} },
      '0002_y': {
        contract: { minCodeVersion: '0.3.0' },
        async up(db) {
          const row = await (db as Kysely<MetaTables>).selectFrom('schema_meta').select('min_code_version').executeTakeFirst();
          seen.push(row?.min_code_version ?? 'none');
        },
      },
    };
    expect(await runMigrations(h, options({ migrations }))).toEqual({
      mode: 'migrated',
      applied: ['0001_x', '0002_y'],
      schemaVersion: '0002',
      minCodeVersion: '0.3.0',
      edition: { mode: 'empty', applied: [] },
    });
    expect(seen).toEqual(['0.3.0']);
  });

  it('min_code_version never goes down: a later contract with a lower version keeps the higher one', async () => {
    const seen: string[] = [];
    const migrations: Record<string, AltisMigration> = {
      '0001_x': { contract: { minCodeVersion: '0.3.0' }, up: async () => {} },
      '0002_y': { contract: { minCodeVersion: '0.1.0' }, up: async () => {} },
      '0003_z': {
        // Observed during the run, before the final reconciliation could repair a lowered floor.
        async up(db) {
          const row = await (db as Kysely<MetaTables>).selectFrom('schema_meta').select('min_code_version').executeTakeFirst();
          seen.push(row?.min_code_version ?? 'none');
        },
      },
    };
    expect(await runMigrations(h, options({ migrations }))).toMatchObject({ minCodeVersion: '0.3.0' });
    expect(seen).toEqual(['0.3.0']);
  });

  it('reconciles schema_meta with schema_migrations: a drifted row is corrected and mirrored', async () => {
    await runMigrations(h, options());
    // As if a crash had separated schema_meta from the migrations actually recorded.
    await meta(h).updateTable('schema_meta').set({ schema_version: '0001', min_code_version: '0.0.0' }).where('id', '=', 1).execute();
    const spies = spyMigrator();
    expect(await runMigrations(h, options())).toEqual({
      mode: 'up-to-date',
      applied: [],
      schemaVersion: '0003',
      minCodeVersion: '0.2.0',
      edition: { mode: 'empty', applied: [] },
    });
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    expect(await schemaMeta()).toEqual([{ id: 1, schema_version: '0003', min_code_version: '0.2.0' }]);
    expect(await readSchemaMetaMirror(dataDir)).toEqual({ schemaVersion: '0003', minCodeVersion: '0.2.0' });
  });

  it('0002_b throws on its first invocation: the run rejects; a rerun completes', async () => {
    const migrations = fixtureMigrations({ failFirst: '0002_b' });
    const error = await runMigrations(h, options({ migrations })).catch((e: unknown) => e);
    // PostgreSQL runs the whole batch in one transaction (transactional DDL): 0001_a was rolled back with it,
    // and so was the floor 0002_b's contract raised. Elsewhere each migration stands on its own: 0001_a stays
    // applied, and the floor stays raised (it is raised before the contract's DDL runs).
    const pg = h.dialect === 'postgres';
    const keptFirst = pg ? [] : ['0001_a'];
    expect(error).toBeInstanceOf(MigrationError);
    expect(error).toMatchObject({
      message: expect.stringContaining('fixture failure in 0002_b'),
      meta: { migration: '0002_b', applied: keptFirst },
      cause: expect.objectContaining({ message: 'fixture failure in 0002_b' }),
    });
    expect(await appliedNames()).toEqual(keptFirst);
    const floor = pg ? { schema_version: '0000', min_code_version: '0.0.0' } : { schema_version: '0001', min_code_version: '0.2.0' };
    expect(await schemaMeta()).toEqual([{ id: 1, ...floor }]);
    // The mirror matches the database after the failure too.
    expect(await readSchemaMetaMirror(dataDir)).toEqual({
      schemaVersion: floor.schema_version,
      minCodeVersion: floor.min_code_version,
    });

    const outcome = await runMigrations(h, options({ migrations }));
    expect(outcome).toEqual({
      mode: 'migrated',
      applied: h.dialect === 'postgres' ? ALL : ['0002_b', '0003_c'],
      schemaVersion: '0003',
      minCodeVersion: '0.2.0',
      edition: { mode: 'empty', applied: [] },
    });
    expect(await appliedNames()).toEqual(ALL);
    expect(await runsPerName(h.db)).toEqual({ '0001_a': 1, '0002_b': 1, '0003_c': 1 });
    expect(await readSchemaMetaMirror(dataDir)).toEqual({ schemaVersion: '0003', minCodeVersion: '0.2.0' });
  });

  describe('a failing migration is reported with its name (item 6)', () => {
    const pass = { up: async () => {} } satisfies AltisMigration;

    it('a migration rejecting without a reason fails the run; later ones do not run', async () => {
      const ran: string[] = [];
      const migrations: Record<string, AltisMigration> = {
        '0001_x': { up: async () => void ran.push('0001_x') },
        '0002_y': { up: () => Promise.reject() },
        '0003_z': { up: async () => void ran.push('0003_z') },
      };
      const error = await runMigrations(h, options({ migrations })).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(MigrationError);
      expect(error).toMatchObject({ meta: { migration: '0002_y', applied: h.dialect === 'postgres' ? [] : ['0001_x'] } });
      expect(ran).toEqual(['0001_x']);
      // Step by step too (on PostgreSQL 0001_x was rolled back with the batch, so it comes first again).
      if (h.dialect === 'postgres') expect(await migrateUpOne(h, options({ migrations }))).toEqual({ done: false, applied: '0001_x' });
      await expect(migrateUpOne(h, options({ migrations }))).rejects.toMatchObject({ meta: { migration: '0002_y', applied: [] } });
    });

    it('a DomainError keeps its code and meta, plus the migration and what this run applied', async () => {
      const migrations: Record<string, AltisMigration> = {
        '0001_x': pass,
        '0002_y': {
          up: async () => {
            throw new DomainError('SCHEMA_CONFLICT', { detail: 'test refusal', meta: { reason: 'test' } });
          },
        },
      };
      const error = await runMigrations(h, options({ migrations })).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(DomainError);
      expect(error).toMatchObject({
        code: 'SCHEMA_CONFLICT',
        detail: expect.stringContaining('0002_y'),
        meta: { reason: 'test', migration: '0002_y', applied: h.dialect === 'postgres' ? [] : ['0001_x'] },
      });
    });

    it('a raw driver error keeps its code on the wrapper', async () => {
      const migrations: Record<string, AltisMigration> = {
        '0001_x': { up: (db) => sql`SELECT * FROM no_such_table_here`.execute(db).then(() => undefined) },
      };
      const error = await runMigrations(h, options({ migrations })).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(MigrationError);
      const cause = (error as MigrationError).cause as { code?: unknown };
      expect((error as MigrationError).code).toBe(typeof cause.code === 'string' ? cause.code : undefined);
      expect((error as MigrationError).code).toBeDefined();
    });

    it('an error writing the mirror after a failed migration is carried, with what stayed applied (item 11)', async () => {
      const mirror = dataPath(dataDir, 'releases', 'schema-meta.json');
      const migrations: Record<string, AltisMigration> = {
        '0001_x': pass,
        '0002_y': {
          async up() {
            await fsp.rm(mirror, { force: true });
            await fsp.mkdir(mirror, { recursive: true }); // a directory where the mirror file goes
            throw new Error('boom');
          },
        },
      };
      const error = await runMigrations(h, options({ migrations })).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(MigrationError);
      // schema_meta could still be read back: what stayed applied is known (PostgreSQL rolled the batch back).
      expect(error).toMatchObject({
        message: expect.stringContaining('boom'),
        meta: { migration: '0002_y', applied: h.dialect === 'postgres' ? [] : ['0001_x'], appliedVerified: true },
      });
      expect((error as MigrationError).meta.secondary).toBeInstanceOf(Error);
    });

    it.skipIf(ctx.engine.startsWith('pg'))(
      'when schema_meta cannot be read back after the failure, what stayed applied is reported unknown (item 11)',
      async () => {
        const migrations: Record<string, AltisMigration> = {
          '0001_x': pass,
          '0002_y': {
            async up(db) {
              await db.schema.dropTable('schema_meta').execute(); // not transactional here: reconciliation fails
              throw new Error('boom');
            },
          },
        };
        const error = await runMigrations(h, options({ migrations })).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(MigrationError);
        expect(error).toMatchObject({ meta: { migration: '0002_y', applied: null, appliedVerified: false } });
        expect((error as MigrationError).meta.secondary).toBeDefined();
        // A driver error kept there follows the safe-cause policy too: no SQL text in the serialized error.
        expect(JSON.stringify(error)).not.toMatch(/select|schema_meta`|"sql"/i);
      },
    );

    it.skipIf(!ctx.engine.startsWith('pg'))(
      'a failure after the last up() (its COMMIT) still names that migration (item 11)',
      async () => {
        // A deferred constraint trigger makes the batch's COMMIT fail, after every up() returned.
        const migrations: Record<string, AltisMigration> = {
          '0001_x': pass,
          '0002_y': {
            async up(db) {
              await sql`CREATE TABLE t_defer (id integer)`.execute(db);
              await sql`CREATE FUNCTION t_defer_refuse() RETURNS trigger LANGUAGE plpgsql AS
                $$ BEGIN RAISE EXCEPTION 'refused at commit'; END $$`.execute(db);
              await sql`CREATE CONSTRAINT TRIGGER t_defer_check AFTER INSERT ON t_defer
                DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION t_defer_refuse()`.execute(db);
              await sql`INSERT INTO t_defer (id) VALUES (1)`.execute(db);
            },
          },
        };
        const error = await runMigrations(h, options({ migrations })).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(MigrationError);
        expect(error).toMatchObject({ meta: { migration: '0002_y', applied: [], appliedVerified: true } });
        expect(await appliedNames()).toEqual([]);
      },
    );

    it('a raw driver error leaves no SQL text or values in the message or the serialized error (item 12)', async () => {
      const secret = 'secret-value-42';
      const migrations: Record<string, AltisMigration> = {
        '0001_x': {
          async up(db, dialect) {
            if (dialect === 'sqlite') await sql`CREATE TABLE t_secret (n INTEGER) STRICT`.execute(db);
            else await sql`CREATE TABLE t_secret (n INTEGER)`.execute(db);
            await sql`INSERT INTO t_secret (n) VALUES (${secret})`.execute(db);
          },
        },
      };
      const error = await runMigrations(h, options({ migrations })).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(MigrationError);
      const failure = error as MigrationError;
      expect(failure.code).toEqual(expect.any(String));
      for (const text of [failure.message, JSON.stringify(failure), JSON.stringify(failure.cause)]) {
        expect(text).not.toContain(secret);
        expect(text).not.toMatch(/insert into/i);
      }
      expect(Object.keys(failure.cause as object).every((k) => ['code', 'errno', 'sqlState', 'constraint'].includes(k))).toBe(true);
      expect(failure.message).toContain(failure.code!);
    });

    describe('a driver error wrapped by the migration (safe causes down the chain, item 5)', () => {
      const secret = 'secret-value-42';
      /** A migration whose INSERT fails with a raw driver error, which it wraps with `wrap`. */
      const wrapping = (wrap: (driverError: Error) => Error): Record<string, AltisMigration> => ({
        '0001_x': {
          async up(db, dialect) {
            if (dialect === 'sqlite') await sql`CREATE TABLE t_secret (n INTEGER) STRICT`.execute(db);
            else await sql`CREATE TABLE t_secret (n INTEGER)`.execute(db);
            try {
              await sql`INSERT INTO t_secret (n) VALUES (${secret})`.execute(db);
            } catch (error) {
              throw wrap(error as Error);
            }
          },
        },
      });

      function expectNoDriverText(error: unknown) {
        for (const text of [
          (error as Error).message,
          JSON.stringify(error),
          inspect(error, { depth: 10 }),
          JSON.stringify((error as Error).cause),
        ]) {
          expect(text).not.toContain(secret);
          expect(text).not.toMatch(/insert into/i);
        }
      }

      it('keeps the wrapper message and reduces the driver error below it to its safe fields', async () => {
        const error = await runMigrations(
          h,
          options({ migrations: wrapping((driverError) => new Error('backfill failed', { cause: driverError })) }),
        ).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(MigrationError);
        expect((error as Error).message).toContain('backfill failed');
        expect((error as Error).cause).toMatchObject({ name: 'Error', message: 'backfill failed', cause: { code: expect.any(String) } });
        expectNoDriverText(error);
      });

      it('cuts the chain where a wrapper repeats the driver message', async () => {
        let driverMessage = '';
        const error = await runMigrations(
          h,
          options({
            migrations: wrapping((driverError) => {
              driverMessage = driverError.message;
              return new Error(`backfill failed: ${driverError.message}`, { cause: driverError });
            }),
          }),
        ).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(MigrationError);
        expect(driverMessage).not.toBe('');
        expect((error as Error).message).not.toContain(driverMessage);
        expect(JSON.stringify((error as Error).cause)).not.toContain(driverMessage);
        expectNoDriverText(error);
      });

      it('reduces the raw driver errors inside an AggregateError of Promise.allSettled rejections (round 4, item 3)', async () => {
        const error = await runMigrations(
          h,
          options({
            migrations: {
              '0001_x': {
                async up(db, dialect) {
                  if (dialect === 'sqlite') await sql`CREATE TABLE t_secret (n INTEGER) STRICT`.execute(db);
                  else await sql`CREATE TABLE t_secret (n INTEGER)`.execute(db);
                  // One statement at a time: the Migrator's single connection (and PostgreSQL's transaction).
                  const settled: PromiseSettledResult<unknown>[] = [];
                  for (const value of [secret, `${secret}-2`]) {
                    settled.push(...(await Promise.allSettled([sql`INSERT INTO t_secret (n) VALUES (${value})`.execute(db)])));
                    if (dialect === 'postgres') break; // the first failure aborts PostgreSQL's transaction
                  }
                  const rejected = settled.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
                  throw new AggregateError(rejected.map((r) => r.reason as unknown), 'backfill failed');
                },
              },
            },
          }),
        ).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(MigrationError);
        expect((error as Error).message).toContain('backfill failed');
        const cause = (error as Error).cause as { name: string; message: string; errors: unknown[] };
        expect(cause).toMatchObject({ name: 'AggregateError', message: 'backfill failed' });
        expect(cause.errors.length).toBe(ctx.engine.startsWith('pg') ? 1 : 2);
        for (const e of cause.errors) {
          expect(Object.keys(e as object).every((k) => ['code', 'errno', 'sqlState', 'constraint'].includes(k))).toBe(true);
          expect(e).toMatchObject({ code: expect.any(String) });
        }
        expectNoDriverText(error);
      });

      it('keeps a wrapped UNIQUE_VIOLATION (normalized by the driver layer) intact, the same on every engine (round 4, item 2)', async () => {
        const error = await runMigrations(
          h,
          options({
            migrations: {
              '0001_x': {
                async up(db) {
                  await sql`CREATE TABLE t_secret (n VARCHAR(40) NOT NULL, CONSTRAINT uq_t_secret_n UNIQUE (n))`.execute(db);
                  await sql`INSERT INTO t_secret (n) VALUES (${secret})`.execute(db);
                  try {
                    await sql`INSERT INTO t_secret (n) VALUES (${secret})`.execute(db);
                  } catch (e) {
                    throw new Error('seeding failed', { cause: e });
                  }
                },
              },
            },
          }),
        ).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(MigrationError);
        const link = ((error as Error).cause as Error).cause;
        expect(isDomainError(link)).toBe(true);
        expect(link).toMatchObject({ code: 'UNIQUE_VIOLATION', meta: { constraint: ctx.engine === 'sqlite' ? 't_secret.n' : 'uq_t_secret_n' } });
        expectNoDriverText(error);
      });

      it('a DomainError thrown with a detail repeating the driver message keeps its code and meta, not the text (round 5, item 5)', async () => {
        let driverMessage = '';
        const error = await runMigrations(
          h,
          options({
            migrations: wrapping((driverError) => {
              driverMessage = driverError.message;
              return new DomainError('SCHEMA_CONFLICT', {
                detail: `backfill refused: ${driverError.message}`,
                meta: { reason: 't' },
                cause: driverError,
              });
            }),
          }),
        ).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(DomainError);
        expect(error).toMatchObject({ code: 'SCHEMA_CONFLICT', meta: { reason: 't', migration: '0001_x' } });
        expect(driverMessage).not.toBe('');
        expect((error as DomainError).detail).not.toContain(driverMessage);
        expect(inspect(error, { depth: 10 })).not.toContain(driverMessage);
        expectNoDriverText(error);
      });

      it('applies the same to a DomainError thrown with a driver error as its cause', async () => {
        const error = await runMigrations(
          h,
          options({
            migrations: wrapping(
              (driverError) => new DomainError('SCHEMA_CONFLICT', { detail: 'backfill refused', meta: { reason: 't' }, cause: driverError }),
            ),
          }),
        ).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(DomainError);
        expect((error as DomainError).cause).toMatchObject({ code: expect.any(String) });
        expectNoDriverText(error);
      });
    });
  });

  describe.skipIf(!MYSQL_ENGINES.has(ctx.engine))('MySQL/MariaDB: the migration lock belongs to this database (R26)', () => {
    let admin: mysql.Connection;
    let other: DbHandle | undefined;
    let otherName: string;

    beforeAll(async () => {
      admin = await mysql.createConnection({
        host: h.config.host!,
        port: h.config.port!,
        user: 'root',
        password: TEST_DB_ROOT_PASSWORD,
      });
      otherName = `${h.config.database}_mig`;
      await admin.query('DROP DATABASE IF EXISTS ??', [otherName]);
      await admin.query('CREATE DATABASE ?? CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci', [otherName]);
      await admin.query(`GRANT ALL PRIVILEGES ON ??.* TO ?@'%'`, [otherName, TEST_DB_USER]);
      other = await connect({ ...h.config, database: otherName }, { runtime: 'standalone', purpose: 'server', dataDir: h.dataDir });
    });

    afterAll(async () => {
      await other?.close();
      await admin?.query('DROP DATABASE IF EXISTS ??', [otherName]);
      await admin?.end();
    });

    const lockNameOf = (database: string) => sql`concat('altis_mig_', left(sha2(${database}, 256), 40))`;

    it("another database's migration, or another app holding Kysely's stock lock name, does not block this one", async () => {
      await admin.query("SELECT GET_LOCK('ea586330-2c93-47c8-908d-981d9d270f9d', 60)"); // Kysely's own name
      try {
        let enter!: () => void;
        const entered = new Promise<void>((resolve) => (enter = resolve));
        let release!: () => void;
        const gate = new Promise<void>((resolve) => (release = resolve));
        const otherDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-migrate-other-'));
        try {
          // The other database migrates and stays inside its migration (holding its lock) until released.
          const slow = runMigrations(other!, {
            appVersion: '0.3.0',
            dataDir: otherDir,
            migrations: { '0001_slow': { up: async () => (enter(), gate) } },
          });
          await entered;
          const timer = new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 5000).unref());
          const mine = runMigrations(h, options({ lockWaitMs: 4000 })).then((o) => o.mode);
          expect(await Promise.race([mine, timer])).toBe('migrated');
          release();
          expect((await slow).mode).toBe('migrated');
        } finally {
          release();
          await fsp.rm(otherDir, { recursive: true, force: true });
        }
      } finally {
        await admin.query("SELECT RELEASE_LOCK('ea586330-2c93-47c8-908d-981d9d270f9d')");
      }
    });

    it('a migration lock still held after lockWaitMs is an error, not a silent unlocked run', async () => {
      const name = (await sql<{ name: string }>`SELECT ${lockNameOf(h.config.database!)} AS name`.execute(h.db)).rows[0]!.name;
      await admin.query('SELECT GET_LOCK(?, 60)', [name]);
      try {
        const started = Date.now();
        const error = await runMigrations(h, options({ lockWaitMs: 1000 })).catch((e: unknown) => e);
        expect(error).toMatchObject({
          code: 'DB_UNAVAILABLE',
          meta: { reason: 'busy', code: 'MIGRATION_LOCK', retryable: true },
        });
        expect(Date.now() - started).toBeGreaterThanOrEqual(900);
        expect(await runsPerName(h.db)).toEqual({});
      } finally {
        await admin.query('SELECT RELEASE_LOCK(?)', [name]);
      }
    });
  });

  it('migrateUpOne applies one migration per call, then reports done', async () => {
    const o = options();
    expect(await migrateUpOne(h, o)).toEqual({ done: false, applied: '0001_a' });
    expect(await schemaMeta()).toEqual([{ id: 1, schema_version: '0001', min_code_version: '0.0.0' }]);
    expect(await migrateUpOne(h, o)).toEqual({ done: false, applied: '0002_b' });
    expect(await readSchemaMetaMirror(dataDir)).toEqual({ schemaVersion: '0002', minCodeVersion: '0.2.0' });
    expect(await migrateUpOne(h, o)).toEqual({ done: true, applied: '0003_c' });
    expect(await migrateUpOne(h, o)).toEqual({ done: true });
    expect(await runsPerName(h.db)).toEqual({ '0001_a': 1, '0002_b': 1, '0003_c': 1 });
    expect(await runMigrations(h, o)).toMatchObject({ mode: 'up-to-date', schemaVersion: '0003' });
  });

  it('migrate.lock goes stale after 10 min on SQLite, after 30 s elsewhere (R31)', async () => {
    await ensureDir(dataPath(dataDir, 'tmp'));
    // A live holder of this host (this very process, under another token), last refreshed a minute ago.
    const lockPath = dataPath(dataDir, 'tmp', 'migrate.lock');
    await fsp.writeFile(
      lockPath,
      JSON.stringify({ pid: process.pid, startMs: processStartMs(), token: 'other', host: lockHostIdentity() }),
    );
    const minuteAgo = new Date(Date.now() - 60_000);
    await utimes(lockPath, minuteAgo, minuteAgo);
    const outcome = runMigrations(h, options({ lockWaitMs: 400 }));
    if (h.dialect === 'sqlite') {
      // A long synchronous SQLite statement can starve the heartbeat for more than 30 s: still the holder's lock.
      await expect(outcome).rejects.toMatchObject({ code: 'STATE_CORRUPT', meta: { reason: 'lock_timeout' } });
      expect(await runsPerName(h.db)).toEqual({});
    } else {
      expect((await outcome).mode).toBe('migrated');
    }
  });

  it('waits for the migrate lock held by another process and gives up after lockWaitMs', async () => {
    await ensureDir(dataPath(dataDir, 'tmp'));
    // A live holder of this host (this very process, under another token) with a fresh lock.
    const lockPath = dataPath(dataDir, 'tmp', 'migrate.lock');
    await fsp.writeFile(
      lockPath,
      JSON.stringify({ pid: process.pid, startMs: processStartMs(), token: 'other', host: lockHostIdentity() }),
    );
    await expect(runMigrations(h, options({ lockWaitMs: 300 }))).rejects.toMatchObject({
      code: 'STATE_CORRUPT',
      meta: { reason: 'lock_timeout' },
    });
    expect(await runsPerName(h.db)).toEqual({});
  });

  describe('two processes at once (review focus 5)', () => {
    const root = path.resolve(import.meta.dirname, '../../..');
    const fixture = path.join(import.meta.dirname, 'fixtures', 'migrate-child.mjs');
    const children: ChildProcess[] = [];

    afterEach(() => {
      for (const child of children.splice(0)) child.kill('SIGKILL');
    });

    type Report = { outcome: MigrationOutcome; invoked: string[]; startedAt: number; endedAt: number };

    function startChild(extra: { delayMs?: number; busyMs?: number } = {}, env: Record<string, string> = {}) {
      const options = { config: h.config, connectDataDir: h.dataDir, migrateDataDir: dataDir, appVersion: '0.3.0', ...extra };
      const child = fork(fixture, [JSON.stringify(options)], {
        cwd: root,
        env: { ...process.env, ...env },
        execArgv: ['--import', 'tsx'],
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      });
      children.push(child);
      let report: Report | undefined;
      const ready = new Promise<void>((resolve, reject) => {
        child.on('message', (message) => {
          if (message === 'ready') resolve();
          else report = message as Report;
        });
        child.once('error', reject);
        child.once('exit', (code) => reject(new Error(`child exited with ${String(code)} before it was ready`)));
      });
      // 'close' comes after every IPC message has been delivered.
      const exited = new Promise<{ code: number | null; report: Report | undefined }>((resolve) =>
        child.once('close', (code) => resolve({ code, report })),
      );
      return { child, ready, exited };
    }

    it('each migration is applied exactly once and both exit 0', async () => {
      const a = startChild({ delayMs: 150 });
      const b = startChild({ delayMs: 150 });
      await Promise.all([a.ready, b.ready]); // start both only once both are up, so that they really compete
      a.child.send('go');
      b.child.send('go');
      const [ra, rb] = await Promise.all([a.exited, b.exited]);
      expect([ra.code, rb.code]).toEqual([0, 0]);

      // The two runs overlapped in time: they really competed for the lock.
      const [x, y] = [ra.report!, rb.report!];
      expect(x.startedAt).toBeLessThan(y.endedAt);
      expect(y.startedAt).toBeLessThan(x.endedAt);
      // Every `up` started exactly once across both processes (whatever its transaction did) ...
      const invoked = [...x.invoked, ...y.invoked].sort();
      expect(invoked).toEqual(ALL);
      // ... and took effect exactly once.
      expect(await runsPerName(h.db)).toEqual({ '0001_a': 1, '0002_b': 1, '0003_c': 1 });
      // One process migrated, the other found the work done.
      expect([x.outcome.mode, y.outcome.mode].sort()).toEqual(['migrated', 'up-to-date']);
      expect(await appliedNames()).toEqual(ALL);
      expect(await readSchemaMetaMirror(dataDir)).toEqual({ schemaVersion: '0003', minCodeVersion: '0.2.0' });
      await expect(fsp.access(dataPath(dataDir, 'tmp', 'migrate.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
    }, 60_000);

    it.skipIf(ctx.engine !== 'sqlite')(
      'SQLite: a migration that keeps the database busy longer than the stale time keeps its lock (R25)',
      async () => {
        // node:sqlite is synchronous: without yielding to the event loop the lock heartbeat never runs, the lock
        // looks stale to the waiter, and the waiter starts a second Migrator. Timings scaled down with the test
        // hooks: stale after 1.5 s (heartbeat every 0.5 s), SQLite yields after 50 ms instead of 1 s.
        const env = { ALTIS_TEST_LOCK_STALE_MS: '1500', ALTIS_TEST_SQLITE_YIELD_MS: '50' };
        const holder = startChild({ busyMs: 4500 }, env);
        const waiter = startChild({}, env);
        await Promise.all([holder.ready, waiter.ready]);
        const lockPath = dataPath(dataDir, 'tmp', 'migrate.lock');
        holder.child.send('go');
        const mtimes: number[] = [];
        while (mtimes.length === 0) {
          const stat = await fsp.stat(lockPath).catch(() => null);
          if (stat !== null) mtimes.push(stat.mtimeMs);
          else await new Promise((resolve) => setTimeout(resolve, 10));
        }
        waiter.child.send('go'); // the holder has the lock: the waiter waits for it
        let done = false;
        const watching = (async () => {
          while (!done) {
            const stat = await fsp.stat(lockPath).catch(() => null);
            if (stat !== null && stat.mtimeMs !== mtimes.at(-1)) mtimes.push(stat.mtimeMs);
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
        })();
        const [rh, rw] = await Promise.all([holder.exited, waiter.exited]);
        done = true;
        await watching;
        expect([rh.code, rw.code]).toEqual([0, 0]);
        expect(rh.report!.invoked).toEqual(ALL);
        expect(rw.report!.invoked).toEqual([]); // never took the lock over
        expect([rh.report!.outcome.mode, rw.report!.outcome.mode]).toEqual(['migrated', 'up-to-date']);
        expect(rw.report!.endedAt).toBeGreaterThanOrEqual(rh.report!.endedAt - 50);
        expect(await runsPerName(h.db)).toEqual({ '0001_a': 1, '0002_b': 1, '0003_c': 1 });
        // The heartbeat kept refreshing the lock while the holder was busy.
        expect(mtimes.length).toBeGreaterThanOrEqual(3);
      },
      60_000,
    );
  });
});
