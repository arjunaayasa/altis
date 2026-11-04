import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Kysely } from 'kysely';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyDatabase, engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../tools/test/test-db.js';
import { PHASE1_MIGRATIONS, buildFixtureLevel, migrationsForLevel, releaseMigrations } from '../src/migrations/index.js';
import { runMigrations } from '../src/migrator.js';
import { listCatalogTables } from '../src/server-check.js';

// Decision D1d-26 (spec §12.5): the release fixtures 0.1.0-test, 0.2.0-test (+ 9001_test_expand, table test_fixture)
// and 0.3.0-test (+ 9002_test_contract: a column, and min_code_version 0.3.0-test). The build define __TEST_FIXTURE__
// picks the level of a test build (Vitest defines 1); production builds have level 0 and none of it.

type FixtureTables = {
  schema_meta: { id: number; schema_version: string; min_code_version: string; install_id: string | null };
  schema_migrations: { name: string; timestamp: string };
  schema_tables: { name: string; class: string; created_by: string };
  test_fixture: { id: string; note: string; created_at: number; extra?: string };
};

const fx = (h: TestDbHandle) => h.db as unknown as Kysely<FixtureTables>;

const PHASE1 = Object.keys(PHASE1_MIGRATIONS).sort();

describe('releaseMigrations (decision D1d-26)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('level 0 and level 1 are PHASE1_MIGRATIONS', () => {
    expect(Object.keys(releaseMigrations(0))).toEqual(Object.keys(PHASE1_MIGRATIONS));
    expect(Object.keys(releaseMigrations(1))).toEqual(Object.keys(PHASE1_MIGRATIONS));
  });

  it('level 2 adds 9001_test_expand, level 3 also 9002_test_contract (a contract for 0.3.0-test); frozen', () => {
    expect(Object.keys(releaseMigrations(2)).sort()).toEqual([...PHASE1, '9001_test_expand']);
    expect(Object.keys(releaseMigrations(3)).sort()).toEqual([...PHASE1, '9001_test_expand', '9002_test_contract']);
    expect(releaseMigrations(2)['9001_test_expand']?.contract).toBeUndefined();
    expect(releaseMigrations(3)['9002_test_contract']?.contract).toEqual({ minCodeVersion: '0.3.0-test' });
    expect(Object.isFrozen(releaseMigrations(3))).toBe(true);
  });

  it('defaults to the build level: 1 under Vitest (__TEST_FIXTURE__ is 1)', () => {
    expect(__TEST_FIXTURE__).toBe(1);
    expect(buildFixtureLevel()).toBe(1);
    expect(Object.keys(releaseMigrations())).toEqual(Object.keys(PHASE1_MIGRATIONS));
    vi.stubGlobal('__TEST_FIXTURE__', 3);
    expect(buildFixtureLevel()).toBe(3);
    expect(Object.keys(releaseMigrations()).sort()).toEqual([...PHASE1, '9001_test_expand', '9002_test_contract']);
    vi.stubGlobal('__TEST_FIXTURE__', undefined); // a bundle made without the define (other tooling): level 1
    expect(buildFixtureLevel()).toBe(1);
  });

  it('outside the test profile the level is 0 and releaseMigrations never returns a test migration', () => {
    vi.stubGlobal('__BUILD_PROFILE__', 'production');
    vi.stubGlobal('__TEST_FIXTURE__', 3);
    expect(buildFixtureLevel()).toBe(0);
    expect(Object.keys(releaseMigrations(3))).toEqual(Object.keys(PHASE1_MIGRATIONS));
    vi.stubGlobal('__BUILD_PROFILE__', undefined);
    expect(buildFixtureLevel()).toBe(0);
    expect(Object.keys(releaseMigrations(2))).toEqual(Object.keys(PHASE1_MIGRATIONS));
  });

  it('migrationsForLevel (the release build, which runs without a profile) is the same set for every level', () => {
    vi.stubGlobal('__BUILD_PROFILE__', undefined);
    expect(Object.keys(migrationsForLevel(0))).toEqual(Object.keys(PHASE1_MIGRATIONS));
    expect(Object.keys(migrationsForLevel(1))).toEqual(Object.keys(PHASE1_MIGRATIONS));
    expect(Object.keys(migrationsForLevel(2)).sort()).toEqual([...PHASE1, '9001_test_expand']);
    expect(Object.keys(migrationsForLevel(3)).sort()).toEqual([...PHASE1, '9001_test_expand', '9002_test_contract']);
  });
});

const ctx = testDbContext();

describe.skipIf(!ctx.available)(`release fixtures against the database [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let dataDir: string;

  beforeAll(async () => {
    h = await testDb();
    dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-fixtures-'));
  });

  afterAll(async () => {
    await h?.close();
    if (dataDir !== undefined) await fsp.rm(dataDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await emptyDatabase(h);
  });

  const migrate = (appVersion: string, level: 0 | 1 | 2 | 3) =>
    runMigrations(h, { appVersion, dataDir, migrations: releaseMigrations(level) });

  async function schemaMeta() {
    return fx(h).selectFrom('schema_meta').select(['schema_version', 'min_code_version']).where('id', '=', 1).executeTakeFirstOrThrow();
  }

  it('level 2: test_fixture exists, schema_tables lists it (data, 9001_test_expand), the schema is at 9001_test_expand', async () => {
    const outcome = await migrate('0.2.0-test', 2);
    expect(outcome).toMatchObject({ mode: 'migrated', schemaVersion: '9001', minCodeVersion: '0.0.0' });
    expect(outcome.applied.at(-1)).toBe('9001_test_expand');
    expect(await listCatalogTables(h)).toContain('test_fixture');
    expect(await fx(h).selectFrom('schema_tables').selectAll().where('name', '=', 'test_fixture').execute()).toEqual([
      { name: 'test_fixture', class: 'data', created_by: '9001_test_expand' },
    ]);
    const names = (await fx(h).selectFrom('schema_migrations').select('name').execute()).map((r) => r.name).sort();
    expect(names.at(-1)).toBe('9001_test_expand');
    expect(await schemaMeta()).toEqual({ schema_version: '9001', min_code_version: '0.0.0' });
    await fx(h).insertInto('test_fixture').values({ id: '01JA0000000000000000000001', note: 'n', created_at: 1 }).execute();
    expect(await fx(h).selectFrom('test_fixture').selectAll().execute()).toEqual([{ id: '01JA0000000000000000000001', note: 'n', created_at: 1 }]);
  });

  it("level 3: 9002_test_contract raises min_code_version to 0.3.0-test and adds test_fixture.extra (default '')", async () => {
    await migrate('0.2.0-test', 2);
    await fx(h).insertInto('test_fixture').values({ id: '01JA0000000000000000000001', note: 'kept', created_at: 1 }).execute();
    const outcome = await migrate('0.3.0-test', 3);
    expect(outcome).toEqual({ mode: 'migrated', applied: ['9002_test_contract'], schemaVersion: '9002', minCodeVersion: '0.3.0-test' });
    expect(await schemaMeta()).toEqual({ schema_version: '9002', min_code_version: '0.3.0-test' });
    expect(await fx(h).selectFrom('test_fixture').selectAll().execute()).toEqual([
      { id: '01JA0000000000000000000001', note: 'kept', created_at: 1, extra: '' },
    ]);
  });

  it('level-2 code (0.2.0-test) on a level-3 database: too-old', async () => {
    await migrate('0.3.0-test', 3);
    expect(await migrate('0.2.0-test', 2)).toEqual({ mode: 'too-old', applied: [], schemaVersion: '9002', minCodeVersion: '0.3.0-test' });
  });

  it('level-1 code (0.1.0-test) on a level-2 database: schema-ahead', async () => {
    await migrate('0.2.0-test', 2);
    expect(await migrate('0.1.0-test', 1)).toEqual({ mode: 'schema-ahead', applied: [], schemaVersion: '9001', minCodeVersion: '0.0.0' });
  });

  it('level 1 creates no test table', async () => {
    const outcome = await migrate('0.1.0-test', 1);
    expect(outcome.schemaVersion).toBe(PHASE1.at(-1)!.slice(0, 4)); // the release's last migration (0027 since Phase 2)
    expect(await listCatalogTables(h)).not.toContain('test_fixture');
  });
});
