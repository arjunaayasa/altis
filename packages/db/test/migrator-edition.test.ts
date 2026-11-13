import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { newId } from '@altis/shared';
import type { KyselyPlugin } from 'kysely';
import { Migrator } from 'kysely/migration';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../tools/test/test-db.js';
import { readSchemaTableOrigins } from '../src/catalog.js';
import type { DbHandle } from '../src/connect.js';
import { dropRegisteredTables } from '../src/ddl.js';
import { EDITION_MIGRATIONS, EDITION_MIGRATION_NAME, EDITION_MIGRATOR_TABLES, editionLaneState, isEditionCreatedBy } from '../src/edition-migrations.js';
import { PHASE1_MIGRATIONS } from '../src/migrations/index.js';
import {
  MIGRATOR_TABLES,
  MigrationError,
  migrateUpOne,
  readSchemaMetaMirror,
  runMigrations,
  type AltisMigration,
  type MigrationOptions,
} from '../src/migrator.js';
import { listCatalogTables } from '../src/server-check.js';
import { EDITION_TEST_MIGRATION, EDITION_TEST_MIGRATIONS, EDITION_TEST_TABLE, testWidgets } from './fixtures/edition-migrations.js';

// Migrasi jalur lain: a second lane of migrations (`eNNNN_slug`) beside the core lane, with its own plan, decision,
// Kysely Migrator and bookkeeping tables, run after the core lane under the same locks; schema_meta follows the core
// lane only. This edition ships an empty lane: its table is then never read for the decision and no second Migrator is
// built, whatever the database holds. The test lane `e0001_test_widgets` (fixtures/edition-migrations.ts) is injected
// through `editionMigrations`.

const ctx = testDbContext();
const noop: AltisMigration = { up: async () => {} };
/** A small core lane of no-op migrations. */
const CORE: Readonly<Record<string, AltisMigration>> = Object.freeze({ '0001_a': noop, '0002_b': noop });

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

/** The SQL text of every statement run through a handle with this plugin (no production hook: a test-local plugin). */
function sqlCapture(h: TestDbHandle): { plugin: KyselyPlugin; statements: string[] } {
  const statements: string[] = [];
  const plugin: KyselyPlugin = {
    transformQuery(args) {
      statements.push(h.db.getExecutor().compileQuery(args.node, args.queryId).sql);
      return args.node;
    },
    async transformResult(args) {
      return args.result;
    },
  };
  return { plugin, statements };
}

/** The statements of `statements` that name `table` as an identifier (quoted as every dialect quotes them). */
function naming(statements: readonly string[], table: string): string[] {
  const quoted = new RegExp(`["\`]${table}["\`]`);
  return statements.filter((s) => quoted.test(s));
}

describe('the other lane: names and arguments, checked before the database is touched', () => {
  const ok: MigrationOptions = { appVersion: '0.1.0', dataDir: path.join(os.tmpdir(), 'altis-never-created'), migrations: { ...CORE } };

  it('ships an empty, frozen lane; its names, tables and created_by rule', () => {
    expect(EDITION_MIGRATIONS).toEqual({});
    expect(Object.isFrozen(EDITION_MIGRATIONS)).toBe(true);
    expect(EDITION_MIGRATION_NAME.test('e0001_test_widgets')).toBe(true);
    expect(EDITION_MIGRATION_NAME.test('0001_test_widgets')).toBe(false);
    expect(EDITION_MIGRATION_NAME.test('e001_x')).toBe(false);
    expect(EDITION_MIGRATOR_TABLES).toEqual(['schema_migrations_edition', 'schema_migrations_edition_lock']);
    expect(MIGRATOR_TABLES).toEqual(['schema_migrations', 'schema_migrations_lock', 'schema_migrations_edition', 'schema_migrations_edition_lock']);
    expect(isEditionCreatedBy('e0001_test_widgets')).toBe(true);
    for (const createdBy of ['migrator', 'bootstrap', '0021_catalog_records', '9001_test_expand']) expect(isEditionCreatedBy(createdBy)).toBe(false);
  });

  it.each([
    ['a lane name in the core map', { ...ok, migrations: { ...CORE, e0001_x: noop } }],
    ['a core name in the lane', { ...ok, editionMigrations: { '0003_c': noop } }],
    ['a lane name without its four digits', { ...ok, editionMigrations: { e01_x: noop } }],
    ['the lane number 0000', { ...ok, editionMigrations: { e0000_x: noop } }],
    ['two lane migrations with the same number', { ...ok, editionMigrations: { e0001_a: noop, e0001_b: noop } }],
    ['a lane migration without up()', { ...ok, editionMigrations: { e0001_a: {} as AltisMigration } }],
  ])('refuses %s with a TypeError', async (_label, o) => {
    await expect(runMigrations(untouchable, o)).rejects.toThrow(TypeError);
    await expect(migrateUpOne(untouchable, o)).rejects.toThrow(TypeError);
  });
});

describe.skipIf(!ctx.available)(`the other migration lane [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let root: string;
  let dataDir: string;

  beforeAll(async () => {
    h = await testDb();
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-edition-lane-'));
  });

  afterAll(async () => {
    await h?.close();
    if (root !== undefined) await fsp.rm(root, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await dropRegisteredTables(h.db, h.dialect);
    dataDir = await fsp.mkdtemp(path.join(root, 'data-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const options = (o: Partial<MigrationOptions> = {}): MigrationOptions => ({ appVersion: '0.1.0', dataDir, migrations: { ...CORE }, ...o });
  const coreNames = async (): Promise<string[]> => (await h.db.selectFrom('schema_migrations').select('name').execute()).map((r) => r.name).sort();
  const laneNames = async (): Promise<string[]> => (await h.db.selectFrom('schema_migrations_edition').select('name').execute()).map((r) => r.name).sort();
  const laneRow = (name: string) => h.db.insertInto('schema_migrations_edition').values({ name, timestamp: new Date().toISOString() }).execute();
  const schemaMeta = () => h.db.selectFrom('schema_meta').select(['schema_version', 'min_code_version']).executeTakeFirstOrThrow();

  it('keeps its own bookkeeping: the core lane runs first, then the lane, each recorded in its own table', async () => {
    const seen: string[] = [];
    const outcome = await runMigrations(
      h,
      options({
        editionMigrations: EDITION_TEST_MIGRATIONS,
        onProgress: (e) => {
          if (e.migration !== null && seen.at(-1) !== e.migration) seen.push(e.migration);
        },
      }),
    );
    expect(outcome).toEqual({
      mode: 'migrated',
      applied: ['0001_a', '0002_b'],
      schemaVersion: '0002',
      minCodeVersion: '0.0.0',
      edition: { mode: 'migrated', applied: [EDITION_TEST_MIGRATION] },
    });
    expect(seen).toEqual(['0001_a', '0002_b', EDITION_TEST_MIGRATION]);
    expect(await coreNames()).toEqual(['0001_a', '0002_b']);
    expect(await laneNames()).toEqual([EDITION_TEST_MIGRATION]);
    const origins = await readSchemaTableOrigins(h.db);
    expect(origins.find((o) => o.name === EDITION_TEST_TABLE)).toEqual({ name: EDITION_TEST_TABLE, class: 'data', createdBy: EDITION_TEST_MIGRATION });
    // Both lanes' runner tables are registered as the runner's own.
    for (const name of MIGRATOR_TABLES) expect(origins.find((o) => o.name === name)).toEqual({ name, class: 'migrator', createdBy: 'migrator' });
    expect(await editionLaneState(h.db)).toEqual({ rows: 1, tables: [EDITION_TEST_TABLE] });
    // A second run finds nothing to do in either lane and builds no Migrator.
    const migrateToLatest = vi.spyOn(Migrator.prototype, 'migrateToLatest');
    expect(await runMigrations(h, options({ editionMigrations: EDITION_TEST_MIGRATIONS }))).toEqual({
      mode: 'up-to-date',
      applied: [],
      schemaVersion: '0002',
      minCodeVersion: '0.0.0',
      edition: { mode: 'up-to-date', applied: [] },
    });
    expect(migrateToLatest).not.toHaveBeenCalled();
  });

  it('one step at a time: the core lane first, then the lane, then done', async () => {
    const o = options({ editionMigrations: EDITION_TEST_MIGRATIONS });
    expect(await migrateUpOne(h, o)).toEqual({ done: false, applied: '0001_a' });
    expect(await migrateUpOne(h, o)).toEqual({ done: false, applied: '0002_b' });
    expect(await migrateUpOne(h, o)).toEqual({ done: true, applied: EDITION_TEST_MIGRATION });
    expect(await migrateUpOne(h, o)).toEqual({ done: true });
    expect(await coreNames()).toEqual(['0001_a', '0002_b']);
    expect(await laneNames()).toEqual([EDITION_TEST_MIGRATION]);
  });

  it('the core lane goes on after a row of the lane: the next core migration runs and schema_meta follows it', { timeout: 120_000 }, async () => {
    const names = Object.keys(PHASE1_MIGRATIONS).sort();
    const last = names.at(-1)!;
    const upToBeforeLast = Object.fromEntries(names.slice(0, -1).map((name) => [name, PHASE1_MIGRATIONS[name]!]));
    expect(Object.keys(upToBeforeLast).at(-1)).toBe(names.at(-2));
    await runMigrations(h, options({ migrations: upToBeforeLast }));
    await laneRow(EDITION_TEST_MIGRATION);
    const outcome = await runMigrations(h, options({ migrations: { ...PHASE1_MIGRATIONS } }));
    expect(outcome).toMatchObject({ mode: 'migrated', applied: [last], schemaVersion: last.slice(0, 4), edition: { mode: 'empty', applied: [] } });
    expect((await schemaMeta()).schema_version).toBe(last.slice(0, 4));
    expect(await coreNames()).toEqual(names);
    expect(await laneNames()).toEqual([EDITION_TEST_MIGRATION]);
  });

  it.each([false, true])('a wrong core order stays SCHEMA_CONFLICT migration_order (a row of the lane present: %s)', async (withLaneRow) => {
    await runMigrations(h, options({ migrations: { '0001_a': noop, '0003_c': noop } }));
    if (withLaneRow) await laneRow(EDITION_TEST_MIGRATION);
    await expect(runMigrations(h, options({ migrations: { ...CORE, '0003_c': noop } }))).rejects.toMatchObject({
      code: 'SCHEMA_CONFLICT',
      meta: { reason: 'migration_order', missing: ['0002_b'] },
    });
  });

  it('an empty lane: its table is never read for the decision, no second Migrator is built, the core lane runs', async () => {
    await runMigrations(h, options({ migrations: { '0001_a': noop } }));
    await laneRow(EDITION_TEST_MIGRATION);
    const capture = sqlCapture(h);
    const migrateToLatest = vi.spyOn(Migrator.prototype, 'migrateToLatest');
    const outcome = await runMigrations({ ...h, db: h.db.withPlugin(capture.plugin) }, options());
    expect(outcome).toEqual({ mode: 'migrated', applied: ['0002_b'], schemaVersion: '0002', minCodeVersion: '0.0.0', edition: { mode: 'empty', applied: [] } });
    // Positive control: the capture sees the core lane's reads, and the core lane's Migrator ran once.
    expect(naming(capture.statements, 'schema_migrations').length).toBeGreaterThan(0);
    expect(migrateToLatest).toHaveBeenCalledTimes(1);
    expect(naming(capture.statements, 'schema_migrations_edition')).toEqual([]);
    expect(naming(capture.statements, 'schema_migrations_edition_lock')).toEqual([]);
    expect(await laneNames()).toEqual([EDITION_TEST_MIGRATION]);
    expect(await editionLaneState(h.db)).toEqual({ rows: 1, tables: [] });
  });

  it('a lane name the code does not know: the lane is schema-ahead and its Migrator is never built; the core lane still runs', async () => {
    await runMigrations(h, options({ editionMigrations: EDITION_TEST_MIGRATIONS }));
    await laneRow('e0002_x');
    const capture = sqlCapture(h);
    const migrateToLatest = vi.spyOn(Migrator.prototype, 'migrateToLatest');
    const outcome = await runMigrations(
      { ...h, db: h.db.withPlugin(capture.plugin) },
      options({ migrations: { ...CORE, '0003_c': noop }, editionMigrations: EDITION_TEST_MIGRATIONS }),
    );
    expect(outcome).toEqual({
      mode: 'schema-ahead',
      applied: ['0003_c'],
      schemaVersion: '0003',
      minCodeVersion: '0.0.0',
      edition: { mode: 'schema-ahead', applied: [] },
    });
    expect(migrateToLatest).toHaveBeenCalledTimes(1); // the core lane's only
    expect(naming(capture.statements, 'schema_migrations_edition').length).toBeGreaterThan(0); // the lane's decision
    expect(naming(capture.statements, 'schema_migrations_edition_lock')).toEqual([]);
    expect(await laneNames()).toEqual([EDITION_TEST_MIGRATION, 'e0002_x']);
    // With nothing pending in the core lane, the outcome is schema-ahead too.
    expect(await runMigrations(h, options({ migrations: { ...CORE, '0003_c': noop }, editionMigrations: EDITION_TEST_MIGRATIONS }))).toEqual({
      mode: 'schema-ahead',
      applied: [],
      schemaVersion: '0003',
      minCodeVersion: '0.0.0',
      edition: { mode: 'schema-ahead', applied: [] },
    });
  });

  it('a gap in the lane is SCHEMA_CONFLICT migration_order for the lane', async () => {
    await runMigrations(h, options());
    await laneRow('e0002_more');
    await expect(runMigrations(h, options({ editionMigrations: { ...EDITION_TEST_MIGRATIONS, e0002_more: noop } }))).rejects.toMatchObject({
      code: 'SCHEMA_CONFLICT',
      meta: { reason: 'migration_order', missing: [EDITION_TEST_MIGRATION], lane: 'edition' },
    });
  });

  it('schema_meta follows the core lane only: a contract of the lane leaves min_code_version as it was', async () => {
    const lane = { [EDITION_TEST_MIGRATION]: { ...testWidgets, contract: { minCodeVersion: '9.0.0' } } };
    const outcome = await runMigrations(h, options({ editionMigrations: lane }));
    expect(outcome).toEqual({
      mode: 'migrated',
      applied: ['0001_a', '0002_b'],
      schemaVersion: '0002',
      minCodeVersion: '0.0.0',
      edition: { mode: 'migrated', applied: [EDITION_TEST_MIGRATION] },
    });
    expect(await schemaMeta()).toEqual({ schema_version: '0002', min_code_version: '0.0.0' });
    expect(await readSchemaMetaMirror(dataDir)).toEqual({ schemaVersion: '0002', minCodeVersion: '0.0.0' });
  });

  it('a failed migration of the lane names it; the core lane stays applied and a rerun completes', async () => {
    let fail = true;
    const lane: Record<string, AltisMigration> = {
      e0001_flaky: {
        async up(db, dialect) {
          await testWidgets.up(db, dialect);
          if (fail) throw new Error('fixture failure in e0001_flaky');
        },
      },
    };
    const error = await runMigrations(h, options({ editionMigrations: lane })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MigrationError);
    expect(error).toMatchObject({ meta: { migration: 'e0001_flaky', applied: ['0001_a', '0002_b'], appliedVerified: true } });
    expect(await coreNames()).toEqual(['0001_a', '0002_b']);
    expect(await laneNames()).toEqual([]);
    expect(await schemaMeta()).toEqual({ schema_version: '0002', min_code_version: '0.0.0' });
    fail = false;
    expect(await runMigrations(h, options({ editionMigrations: lane }))).toMatchObject({ mode: 'up-to-date', edition: { mode: 'migrated', applied: ['e0001_flaky'] } });
  });

  it('the drop guard: dropRegisteredTables with keep leaves the tables of the lane, their rows and schema_tables', async () => {
    await runMigrations(h, options({ editionMigrations: EDITION_TEST_MIGRATIONS }));
    await h.db.insertInto(EDITION_TEST_TABLE as never).values({ id: newId(), label: 'satu' } as never).execute();
    const asked: { name: string; createdBy: string }[] = [];
    await dropRegisteredTables(h.db, h.dialect, {
      keep: (t) => {
        asked.push(t);
        return isEditionCreatedBy(t.createdBy);
      },
    });
    expect(asked.map((t) => t.name)).not.toContain('schema_tables');
    expect(asked.find((t) => t.name === EDITION_TEST_TABLE)).toEqual({ name: EDITION_TEST_TABLE, createdBy: EDITION_TEST_MIGRATION });
    expect((await listCatalogTables(h)).sort()).toEqual([EDITION_TEST_TABLE, 'schema_tables']);
    expect(await readSchemaTableOrigins(h.db)).toEqual([
      { name: EDITION_TEST_TABLE, class: 'data', createdBy: EDITION_TEST_MIGRATION },
      { name: 'schema_tables', class: 'migrator', createdBy: 'bootstrap' },
    ]);
    expect(await h.db.selectFrom(EDITION_TEST_TABLE as never).select('label' as never).execute()).toEqual([{ label: 'satu' }]);
    // Without `keep`, everything registered goes, schema_tables last.
    await dropRegisteredTables(h.db, h.dialect);
    expect(await listCatalogTables(h)).toEqual([]);
  });
});
