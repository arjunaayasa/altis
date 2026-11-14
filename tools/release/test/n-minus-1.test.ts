import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EDITION_MIGRATOR_TABLES, MIGRATOR_TABLES, PHASE1_MIGRATIONS, connect, resetDdlFaults, runMigrations, type DbHandle } from '@altis/db';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DDL_FAULT_ENGINES,
  N1UsageError,
  RUNNER_TABLE_FIRST_SCHEMA,
  lastJsonLine,
  levelOfVersion,
  parseN1Args,
  planN1,
  releaseFactsOf,
  type ReleaseFacts,
} from '../n-minus-1/run.js';
import { writeZip } from '../src/zip.js';

// The N−1 runner's command line and plan (spec §12.4; plan Task 34): which prefixes of N's migrations are run, the DDL
// statements each one runs (counted on a scratch SQLite database built at N−1's schema), the `migrate-ddl` faults on
// MySQL, the stop before the next migration, and what N−1's doctor must make of the database afterwards. The runs
// themselves need the release zips and an engine (`pnpm n-1`, nightly).

/** The release's own migrations (fixture level 1), in name order: visits' 0043, the circulation core's 0042, holds' 0041 and members and circulation's 0040 follow Komunitas K1's 0030–0033, Phase 2's 0020–0029 and 1c's 0001–0009. */
const RELEASE_MIGRATIONS = Object.keys(PHASE1_MIGRATIONS).sort();
const LEVEL1: ReleaseFacts = { version: '0.1.0-test', schemaLatest: RELEASE_MIGRATIONS.at(-1)!.slice(0, 4), minCodeVersionAfter: '0.0.0' };
const LEVEL2: ReleaseFacts = { version: '0.2.0-test', schemaLatest: '9001', minCodeVersionAfter: '0.0.0' };
const LEVEL3: ReleaseFacts = { version: '0.3.0-test', schemaLatest: '9002', minCodeVersionAfter: '0.3.0-test' };

async function usageError(p: Promise<unknown>): Promise<string> {
  const error = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(N1UsageError);
  return (error as Error).message;
}

describe('parseN1Args', () => {
  it('takes --from, --to and --db, resolved from INIT_CWD', () => {
    const o = parseN1Args(['--from', 'dist/altis-0.1.0-test.zip', '--to', 'dist/altis-0.2.0-test.zip', '--db', 'mysql80'], { INIT_CWD: '/repo' }, '/elsewhere');
    expect(o).toEqual({ from: path.resolve('/repo', 'dist/altis-0.1.0-test.zip'), to: path.resolve('/repo', 'dist/altis-0.2.0-test.zip'), db: 'mysql80', keep: false, ddlFaults: false });
    expect(parseN1Args(['--', '--from', 'a.zip', '--to', 'b.zip', '--db', 'sqlite', '--keep', '--ddl-faults'], {}, '/w')).toMatchObject({
      db: 'sqlite',
      keep: true,
      ddlFaults: true,
    });
  });

  it.each([
    [['--to', 'b.zip', '--db', 'mysql80'], /--from/],
    [['--from', 'a.zip', '--db', 'mysql80'], /--to/],
    [['--from', 'a.zip', '--to', 'b.zip'], /--db/],
    [['--from', 'a.zip', '--to', 'b.zip', '--db', 'oracle'], /--db must be one of/],
    [['--from', 'a.zip', '--to', 'b.zip', '--db', 'mysql80', '--scenario', 'x'], /USAGE/],
  ])('%j → USAGE', (argv, message) => {
    expect(() => parseN1Args(argv, {}, '/w')).toThrow(N1UsageError);
    expect(() => parseN1Args(argv, {}, '/w')).toThrow(message);
  });
});

// Each plan migrates a scratch SQLite database to N−1's schema (about a second, more on a loaded machine).
describe('planN1', { timeout: 60_000 }, () => {
  it('0.2.0-test → 0.3.0-test on mysql80: the prefix 9002_test_contract, its one DDL statement faulted, SCHEMA_TOO_NEW expected', async () => {
    const plan = await planN1(LEVEL2, LEVEL3, 'mysql80');
    expect(plan.base.at(-1)).toBe('9001_test_expand');
    expect(plan.prefixes).toEqual([
      {
        migration: '9002_test_contract',
        migrations: ['9002_test_contract'],
        ddl: 1,
        contract: '0.3.0-test',
        runs: [null, 'migrate-ddl:1'],
        stop: null,
        expect: 'SCHEMA_TOO_NEW',
      },
    ]);
  });

  it('0.1.0-test → 0.2.0-test on mysql80: the prefix 9001_test_expand, its DDL statement faulted, doctor ok expected', async () => {
    const plan = await planN1(LEVEL1, LEVEL2, 'mysql80');
    expect(plan.base).toEqual(RELEASE_MIGRATIONS);
    expect(plan.base.at(-1)).toBe('0044_member_area');
    expect(plan.prefixes).toEqual([
      { migration: '9001_test_expand', migrations: ['9001_test_expand'], ddl: 1, contract: null, runs: [null, 'migrate-ddl:1'], stop: null, expect: 'ok' },
    ]);
  });

  it('DDL faults run on mysql80 and mysql84 only (MariaDB, PostgreSQL and SQLite migrate once per prefix)', async () => {
    expect(DDL_FAULT_ENGINES).toEqual(['mysql80', 'mysql84']);
    expect((await planN1(LEVEL1, LEVEL2, 'mysql84')).prefixes[0]!.runs).toEqual([null, 'migrate-ddl:1']);
    for (const db of ['mariadb106', 'mariadb114', 'pg15', 'pg17', 'sqlite'] as const) {
      expect((await planN1(LEVEL1, LEVEL2, db)).prefixes[0]!.runs).toEqual([null]);
    }
    // --ddl-faults: on any engine (a local check of the fault runs).
    expect((await planN1(LEVEL1, LEVEL2, 'sqlite', { ddlFaults: true })).prefixes[0]!.runs).toEqual([null, 'migrate-ddl:1']);
  });

  it('0.1.0-test → 0.3.0-test: two prefixes; the first stops before 9002 and stays ok, the second faults both DDL statements', async () => {
    const plan = await planN1(LEVEL1, LEVEL3, 'mysql80');
    expect(plan.prefixes).toEqual([
      { migration: '9001_test_expand', migrations: ['9001_test_expand'], ddl: 1, contract: null, runs: [null, 'migrate-ddl:1'], stop: 'migrate:9002_test_contract', expect: 'ok' },
      {
        migration: '9002_test_contract',
        migrations: ['9001_test_expand', '9002_test_contract'],
        ddl: 2,
        contract: '0.3.0-test',
        runs: [null, 'migrate-ddl:1', 'migrate-ddl:2'],
        stop: null,
        expect: 'SCHEMA_TOO_NEW',
      },
    ]);
  });

  it('refuses a pair that is not newer, adds nothing, or whose manifest this checkout does not build', async () => {
    expect(await usageError(planN1(LEVEL2, LEVEL1, 'mysql80'))).toMatch(/^NOT_NEWER/);
    expect(await usageError(planN1(LEVEL2, LEVEL2, 'mysql80'))).toMatch(/^NOT_NEWER/);
    // A production pair of this checkout: the same migrations on both sides.
    expect(await usageError(planN1({ ...LEVEL1, version: '0.1.0' }, { ...LEVEL1, version: '0.1.1' }, 'mysql80'))).toMatch(/^NO_NEW_MIGRATIONS/);
    // 0.3.0-test's manifest stating 9001: not what this checkout builds as 0.3.0-test.
    expect(await usageError(planN1(LEVEL2, { ...LEVEL3, schemaLatest: '9001' }, 'mysql80'))).toMatch(/^N1_MISMATCH/);
    expect(await usageError(planN1(LEVEL2, { ...LEVEL3, minCodeVersionAfter: '0.0.0' }, 'mysql80'))).toMatch(/^N1_MISMATCH/);
    // N−1's schema is not one N's migrations hold.
    expect(await usageError(planN1({ ...LEVEL1, schemaLatest: '0045' }, LEVEL2, 'mysql80'))).toMatch(/^N1_MISMATCH/);
  });

  it('the fixture levels follow the release build (fixtureLevelOf)', () => {
    expect([levelOfVersion('0.1.0-test'), levelOfVersion('0.2.0-test'), levelOfVersion('0.3.0-test'), levelOfVersion('0.4.0-test'), levelOfVersion('1.0.0')]).toEqual([1, 2, 3, 1, 0]);
  });
});

// A release whose runner did not make the other lane's two tables yet: N's runner creates them first, before N's
// first migration, and the `migrate-ddl` fault counts them like any migration's DDL.
describe('planN1 from a release older than the runner’s own tables', { timeout: 180_000 }, () => {
  /** A release at 0029, the schema before the other lane's tables came with the runner. */
  const BEFORE_LANE: ReleaseFacts = { version: '0.0.9-test', schemaLatest: '0029', minCodeVersionAfter: '0.0.0' };
  const dirs: string[] = [];

  afterEach(async () => {
    vi.unstubAllEnvs();
    resetDdlFaults();
    for (const dir of dirs.splice(0)) await fsp.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  /** A scratch SQLite database as that release left it: its migrations applied, the other lane's tables never made. */
  async function databaseBeforeLane(): Promise<{ h: DbHandle; dataDir: string }> {
    const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-n1-test-'));
    dirs.push(dataDir);
    const h = await connect({ dialect: 'sqlite' }, { runtime: 'standalone', purpose: 'cli', dataDir });
    const migrations = Object.fromEntries(Object.entries(PHASE1_MIGRATIONS).filter(([name]) => name.slice(0, 4) <= BEFORE_LANE.schemaLatest));
    await runMigrations(h, { appVersion: BEFORE_LANE.version, dataDir, migrations });
    for (const table of EDITION_MIGRATOR_TABLES) {
      await h.db.schema.dropTable(table).execute();
      await h.db.deleteFrom('schema_tables').where('name', '=', table).execute();
    }
    return { h, dataDir };
  }

  const tablesOf = async (h: DbHandle): Promise<string[]> => (await h.db.introspection.getTables()).map((t) => t.name);
  const appliedOf = async (h: DbHandle): Promise<string[]> => (await h.db.selectFrom('schema_migrations').select('name').execute()).map((r) => r.name).sort();
  /** N's migrate (0.1.0-test) of that database with the fault armed, or its error. */
  const migrateWith = (h: DbHandle, dataDir: string, fault: string): Promise<unknown> => {
    resetDdlFaults();
    vi.stubEnv('ALTIS_TEST_FAULT', fault);
    return runMigrations(h, { appVersion: LEVEL1.version, dataDir, migrations: PHASE1_MIGRATIONS }).then(
      () => null,
      (e: unknown) => e,
    );
  };

  it('every runner table names the schema of the first release whose runner made it', () => {
    expect(Object.keys(RUNNER_TABLE_FIRST_SCHEMA).sort()).toEqual([...MIGRATOR_TABLES].sort());
  });

  it('counts the two tables N’s runner creates first in every prefix, as N migrating that database executes them', async () => {
    const plan = await planN1(BEFORE_LANE, LEVEL1, 'mysql80');
    expect(plan.runner).toEqual([...EDITION_MIGRATOR_TABLES]);
    expect(plan.base.at(-1)).toBe('0029_search_token_version');
    expect(plan.prefixes.map((p) => p.migration)).toEqual(RELEASE_MIGRATIONS.filter((n) => n > '0029~'));

    // N's real migrate of such a database, every DDL statement recorded with the migration whose turn it was; the
    // `migrate-ddl` fault one past the plan's last count is armed and must never fire.
    const { h, dataDir } = await databaseBeforeLane();
    try {
      const last = plan.prefixes.at(-1)!.ddl;
      const statements: { migration: string | null; kind: string; table: string | null }[] = [];
      let turn: string | null = null;
      const recorder: Parameters<DbHandle['db']['withPlugin']>[0] = {
        transformQuery(args) {
          const node = args.node as unknown as { kind: string; sqlFragments?: readonly string[]; table?: { table?: { identifier?: { name?: string } } } };
          if (/^(Create|Alter|Drop)[A-Za-z]*Node$/.test(node.kind) || (node.kind === 'RawNode' && /^\s*(CREATE|ALTER|DROP)\b/i.test((node.sqlFragments ?? []).join('')))) {
            statements.push({ migration: turn, kind: node.kind, table: node.table?.table?.identifier?.name ?? null });
          }
          return args.node;
        },
        transformResult: async (args) => args.result,
      };
      resetDdlFaults();
      vi.stubEnv('ALTIS_TEST_FAULT', `migrate-ddl:${last + 1}`);
      const outcome = await runMigrations(
        { db: h.db.withPlugin(recorder), dialect: h.dialect },
        { appVersion: LEVEL1.version, dataDir, migrations: PHASE1_MIGRATIONS, onProgress: (e) => void (turn = e.migration) },
      );
      expect(outcome.applied).toEqual(plan.prefixes.at(-1)!.migrations);
      // The runner's two tables come first, before any migration's turn.
      expect(statements.slice(0, 2)).toEqual(EDITION_MIGRATOR_TABLES.map((table) => ({ migration: null, kind: 'CreateTableNode', table })));
      // Each prefix's count is the statements executed up to the end of its last migration.
      const upTo = (migration: string): number => statements.filter((s) => s.migration === null || s.migration <= migration).length;
      expect(plan.prefixes.map((p) => [p.migration, p.ddl])).toEqual(plan.prefixes.map((p) => [p.migration, upTo(p.migration)]));
      expect(statements.length).toBe(last);
      for (const p of plan.prefixes) expect(p.runs).toEqual([null, ...Array.from({ length: p.ddl }, (_, j) => `migrate-ddl:${j + 1}`)]);
    } finally {
      await h.close();
    }
  });

  it('its first faults hit the runner’s two tables, and the next one the first statement of N’s first migration', async () => {
    const plan = await planN1(BEFORE_LANE, LEVEL1, 'mysql80');
    const first = plan.prefixes[0]!.migration;

    const one = await databaseBeforeLane();
    try {
      expect(String(await migrateWith(one.h, one.dataDir, 'migrate-ddl:1'))).toMatch(/test fault migrate-ddl:1\b/);
      const tables = await tablesOf(one.h);
      expect([tables.includes(EDITION_MIGRATOR_TABLES[0]), tables.includes(EDITION_MIGRATOR_TABLES[1])]).toEqual([true, false]);
      expect(await appliedOf(one.h)).toEqual(plan.base);
    } finally {
      await one.h.close();
    }

    const next = await databaseBeforeLane();
    try {
      const fault = `migrate-ddl:${plan.runner.length + 1}`;
      const error = String(await migrateWith(next.h, next.dataDir, fault));
      expect(error).toContain(first);
      expect(error).toContain(`test fault ${fault}`);
      const tables = await tablesOf(next.h);
      expect(EDITION_MIGRATOR_TABLES.map((t) => tables.includes(t))).toEqual([true, true]);
      expect(await appliedOf(next.h)).toEqual(plan.base);
    } finally {
      await next.h.close();
    }
  });

  it('a release that already has them: the runner adds no DDL (the test pairs of this checkout)', async () => {
    expect((await planN1(LEVEL1, LEVEL2, 'mysql80')).runner).toEqual([]);
    expect((await planN1(LEVEL2, LEVEL3, 'mysql80')).runner).toEqual([]);
  });
});

describe('releaseFactsOf and lastJsonLine', () => {
  it('reads the bundled release manifest of a zip', () => {
    const manifest = { version: '0.3.0-test', buildId: 'b', schemaLatest: '9002', minCodeVersionAfter: '0.3.0-test', files: [] };
    const zip = writeZip([
      { path: 'app.js', data: Buffer.from('"use strict";\n') },
      { path: 'bundled-release/0.3.0-test/manifest.json', data: Buffer.from(JSON.stringify(manifest)) },
    ]);
    expect(releaseFactsOf(zip)).toEqual(LEVEL3);
    expect(() => releaseFactsOf(writeZip([{ path: 'app.js', data: Buffer.from('x') }]))).toThrow(/not an ALTIS release zip/);
  });

  it('takes the last JSON object a --json command printed', () => {
    expect(lastJsonLine('note\n{"ok":true,"command":"migrate","mode":"migrated"}\n')).toEqual({ ok: true, command: 'migrate', mode: 'migrated' });
    expect(lastJsonLine('{"a":1}\n{"ok":false,"code":"SCHEMA_TOO_NEW"}\n\n')).toEqual({ ok: false, code: 'SCHEMA_TOO_NEW' });
    expect(lastJsonLine('GAGAL / FAILED\n')).toBeNull();
  });
});

describe('nightly.yml: the n-minus-1 job', () => {
  const workflow = fs.readFileSync(path.resolve(import.meta.dirname, '..', '..', '..', '.github', 'workflows', 'nightly.yml'), 'utf8');
  const lines = workflow.split('\n');
  const start = lines.indexOf('  n-minus-1:');
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^ {2}[\w-]+:\s*$/.test(line));
  const job = rest.slice(0, end === -1 ? undefined : end).join('\n');

  it('runs 0.1→0.2 and 0.2→0.3 on mysql80 and mariadb106, each pair built first, one JSON line per prefix kept', () => {
    expect(start).toBeGreaterThan(-1);
    expect(job).toContain('engine: [mysql80, mariadb106]');
    expect(job).toContain('- { from: 0.1.0-test, to: 0.2.0-test }');
    expect(job).toContain('- { from: 0.2.0-test, to: 0.3.0-test }');
    expect(job).toContain('pnpm release --profile test --version "$FROM"');
    expect(job).toContain('pnpm release --profile test --version "$TO"');
    expect(job).toContain('docker compose -f tools/test/compose.yml up -d --wait "$ENGINE"');
    expect(job).toMatch(/pnpm --silent n-1 --from "dist\/altis-\$FROM\.zip" --to "dist\/altis-\$TO\.zip" --db "\$ENGINE"/);
    expect(job).toContain('node-version: ${{ env.NODE_VERSION }}');
    expect(job).toMatch(/if: always\(\)\n\s+run: docker compose -f tools\/test\/compose.yml down/);
  });
});
