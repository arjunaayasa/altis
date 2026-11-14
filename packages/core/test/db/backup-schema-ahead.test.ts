import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  PHASE1_MIGRATIONS,
  connect,
  dropRegisteredTables,
  ensureColumn,
  ensureTable,
  migrationsUpTo,
  readSchemaTables,
  readTableColumns,
  releaseMigrations,
  runMigrations,
  type AltisMigration,
} from '@altis/db';
import { newId } from '@altis/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { schemaVersionOf } from '../../src/backup/create-job.js';
import { createExporter } from '../../src/backup/exporter.js';
import { readManifest } from '../../src/backup/manifest.js';
import { readMaintenance, type OpFile } from '../../src/ops/files.js';
import { createOpsMachine, type OpKindHandler, type OpStatus } from '../../src/ops/machine.js';
import { createRestoreRunner, type RestoreRun, type RestoreRunParams } from '../../src/restore/runner.js';
import {
  KEYRING,
  SESSION_KEY,
  SYSTEM,
  beginRestore,
  currentOp,
  liveChecksums,
  loadedChecksums,
  manifestChecksums,
  restoreHarness,
  restoreParams,
  seedInstallation,
  serverBackup,
  silent,
  stepUntil,
  type RestoreHarness,
} from '../fixtures/restore-support.js';

// A backup taken while the database is schema-ahead (spec §6.4 "schema-ahead (normal, tanpa migrasi)": release N runs
// on a database a later release N+1 migrated, after a pointer-only rollback or the compatible revert of §9.7, "skema
// dibiarkan") stays restorable (phase-end review C12). The registry exporter of N writes N's tables and columns only,
// so the backup records the newest migration of N whose number is at most the database's (N+1's number → N's last
// migration, `0042_member_area` since the member area), never N+1's bare number, which no release of N can resolve
// (migrationsUpTo: BACKUP_SCHEMA_TOO_NEW):
//
// - restored by N (`targetSchema` `latest`, and `backup` without a pre_restore as the revert restores): the later
//   release's table goes with schema_tables, the database is at N's schema with the backup's rows;
// - restored by N+1 (its migration known): loaded at N's schema, then migrated on to N+1's;
// - the too-old revert of a later update (its contract migration ran, then its boot failed) restores N's pre_update
//   made in that state (the restore runner, `targetSchema` `backup`, spec §9.7);
// - a pre_restore made in that state is the way back of a restore that fails past its point of no return.
//
// The test builds name every fixture migration (9001, 9002: decision D1d-26), so the later release here is a migration
// numbered right after N's last (AHEAD_SCHEMA: 0010 in 1d, 0030 in Phase 2, 0034 once Komunitas K1 added 0030–0033, 0041 after members and
// circulation's 0040, 0042 after holds' 0041, 0043 after the member area's 0042), which no build of this
// code knows, as in production.

vi.mock('@altis/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@altis/platform')>();
  return { ...actual, ensureHeadroom: async () => {} };
});

const ctx = testDbContext();
const INSTALL_ID = newId();
const N_SCHEMA = Object.keys(PHASE1_MIGRATIONS).sort().at(-1)!;
/** N+1's schema version: the number after N's last migration (a gap below N's last would be SCHEMA_CONFLICT). */
const AHEAD_SCHEMA = String(Number(N_SCHEMA.slice(0, 4)) + 1).padStart(4, '0');
const AHEAD_NAME = `${AHEAD_SCHEMA}_ahead_expand`;
/** N+2's schema version, the number after N+1's (0011 in 1d). */
const LATER_SCHEMA = String(Number(AHEAD_SCHEMA) + 1).padStart(4, '0');

/** N+1's expand migration: a table of its own (class data) and a column added to a table of N. */
const aheadExpand: AltisMigration = {
  async up(db, dialect) {
    await ensureTable(db, dialect, 'ahead_extra', 'data', AHEAD_NAME, (t) => {
      t.ulid('id');
      t.varchar('note', 191);
      t.primaryKey(['id']);
    });
    await ensureColumn(db, dialect, 'branches', (t) => t.varchar('ahead_note', 191).default(''));
  },
};
/** The migrations of release N+1. */
const AHEAD: Readonly<Record<string, AltisMigration>> = Object.freeze({ ...PHASE1_MIGRATIONS, [AHEAD_NAME]: aheadExpand });
/** Release N+2: a contract migration LATER_SCHEMA (min_code_version 0.3.0), so N boots `too-old` once it ran. */
const LATER: Readonly<Record<string, AltisMigration>> = Object.freeze({
  ...AHEAD,
  [`${LATER_SCHEMA}_later_contract`]: {
    contract: { minCodeVersion: '0.3.0' },
    async up(db, dialect) {
      await ensureColumn(db, dialect, 'branches', (t) => t.varchar('later_note', 191).default(''));
    },
  } satisfies AltisMigration,
});

/** An `update` op kind that steps the restore runner as the revert's `restoring` state does (update-kind's Task 25). */
function revertKind(runner: ReturnType<typeof createRestoreRunner>): OpKindHandler {
  return {
    kind: 'update',
    initialState: 'restoring',
    maintenance: 'update',
    freeze: false,
    async step(c, op) {
      const run = await runner.step(c, op.params['restore'] as RestoreRun, { opId: op.opId, actor: op.actor });
      const next: OpFile = { ...op, params: { ...op.params, restore: run }, progress: run.progress ?? op.progress };
      if (run.state === 'done') return { ...next, state: 'restored', progress: 100 };
      if (run.state === 'failed') return { ...next, state: 'restore_failed', error: run.error === null ? null : { code: run.error.code } };
      return next;
    },
    async cancel() {},
  };
}

describe.skipIf(!ctx.available)(`a backup of a schema-ahead database [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let root: string;
  let dataDir: string;
  let harness: RestoreHarness | null = null;

  beforeAll(async () => {
    h = await testDb();
    root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-schema-ahead-')));
  });

  afterAll(async () => {
    await h?.close();
    if (root !== undefined) await fsp.rm(root, { recursive: true, force: true });
  });

  beforeEach(async () => {
    dataDir = await fsp.mkdtemp(path.join(root, 'data-'));
    await dropRegisteredTables(h.db, h.dialect);
    await runMigrations(h, { appVersion: '0.1.0', dataDir, migrations: PHASE1_MIGRATIONS });
    await seedInstallation(h, { dataDir, installId: INSTALL_ID });
    // N+1 migrated the database, then the pointer went back to N: N runs schema-ahead.
    await runMigrations(h, { appVersion: '0.2.0', dataDir, migrations: AHEAD });
    expect(await runMigrations(h, { appVersion: '0.1.0', dataDir, migrations: PHASE1_MIGRATIONS })).toMatchObject({ mode: 'schema-ahead', schemaVersion: AHEAD_SCHEMA });
    await h.db.insertInto('ahead_extra' as never).values({ id: newId(), note: 'baris rilis berikutnya' } as never).execute();
  });

  afterEach(async () => {
    await harness?.close();
    harness = null;
    vi.unstubAllEnvs();
  });

  const harnessOf = (migrations: Readonly<Record<string, AltisMigration>> = PHASE1_MIGRATIONS): RestoreHarness =>
    (harness = restoreHarness({ dataDir, config: h.config, dbDataDir: h.dataDir, live: h, installId: INSTALL_ID, migrations }));
  const migrationNames = async (): Promise<string[]> =>
    ((await h.db.selectFrom('schema_migrations' as never).select('name' as never).execute()) as { name: string }[]).map((r) => r.name).sort();
  const branchColumns = async (): Promise<string[]> => (await readTableColumns(h.db, h.dialect, 'branches')).map((c) => c.name);
  /** The tables schema_tables lists now. */
  const registered = (): Promise<string[]> => readSchemaTables(h.db);

  it('records the newest migration of this code at or below the database’s version, which every restore resolves', async () => {
    const version = await schemaVersionOf(h.db);
    expect(version).toBe(N_SCHEMA);
    expect(Object.keys(migrationsUpTo(releaseMigrations(), version)).at(-1)).toBe(N_SCHEMA);
    expect(Object.keys(migrationsUpTo(AHEAD, version)).at(-1)).toBe(N_SCHEMA);
    const { backupId, manifest } = await serverBackup(h, { dataDir, installId: INSTALL_ID });
    expect(manifest.schemaVersion).toBe(N_SCHEMA);
    expect(manifest.tables).not.toHaveProperty('ahead_extra');
    expect(manifest.tables['branches']?.columns).not.toContain('ahead_note');
    expect(await h.db.selectFrom('backups').select('schema_version').where('id', '=', backupId).executeTakeFirst()).toEqual({ schema_version: N_SCHEMA });
    // The catalog export (spec §9.8 row 3) writes the database's own tables and columns: it records the database's own
    // version (a name this build does not know stays its number).
    expect(await schemaVersionOf(h.db, { columns: 'catalog' })).toBe(AHEAD_SCHEMA);
  });

  it('a registry export refuses a schema version that names no migration of this code', () => {
    const options = {
      read: h.db,
      dialect: h.dialect,
      dataDir,
      backupId: newId(),
      kind: 'manual' as const,
      includeFiles: false,
      consistency: 'frozen' as const,
      appVersion: '0.1.0',
      installId: INSTALL_ID,
      sessionKey: SESSION_KEY,
      kids: ['k1'],
      auditHead: { seq: 0, hash: 'x' },
      clock: () => Date.now(),
    };
    expect(() => createExporter({ ...options, schemaVersion: AHEAD_SCHEMA })).toThrow(TypeError);
    expect(() => createExporter({ ...options, schemaVersion: AHEAD_NAME })).toThrow(TypeError);
    expect(() => createExporter({ ...options, schemaVersion: N_SCHEMA })).not.toThrow();
    // The catalog export (spec §9.8 row 3) describes the database's own tables: any schema version is accepted.
    expect(() => createExporter({ ...options, columns: 'catalog', schemaVersion: AHEAD_SCHEMA })).not.toThrow();
  });

  for (const targetSchema of ['latest', 'backup'] as const) {
    it(`restored by N (targetSchema ${targetSchema}): the backup's rows at N's schema, the later release's table gone`, { timeout: 120_000 }, async () => {
      const { backupId, manifest } = await serverBackup(h, { dataDir, installId: INSTALL_ID });
      await h.db.updateTable('branches').set({ name: 'Diubah', updated_at: Date.now() }).execute();
      const ops = harnessOf();
      const params = targetSchema === 'latest' ? restoreParams(backupId) : restoreParams(backupId, { targetSchema, skipPreRestore: true });
      await beginRestore(ops, params);
      expect(await stepUntil(ops, dataDir)).toMatchObject({ state: 'done', error: null });
      expect(await loadedChecksums(h, manifest, ['notifications'])).toEqual(manifestChecksums(manifest, ['notifications']));
      expect((await migrationNames()).at(-1)).toBe(N_SCHEMA);
      expect(await registered()).not.toContain('ahead_extra');
      expect(await branchColumns()).not.toContain('ahead_note');
      expect(await readMaintenance(dataDir)).toBeNull();
    });
  }

  it('restored by N+1: loaded at N\'s schema, then its own migration runs', { timeout: 120_000 }, async () => {
    const { backupId, manifest } = await serverBackup(h, { dataDir, installId: INSTALL_ID });
    const ops = harnessOf(AHEAD);
    await beginRestore(ops, restoreParams(backupId));
    expect(await stepUntil(ops, dataDir)).toMatchObject({ state: 'done', error: null });
    expect(await loadedChecksums(h, manifest, ['notifications'])).toEqual(manifestChecksums(manifest, ['notifications']));
    expect((await migrationNames()).at(-1)).toBe(AHEAD_NAME);
    expect(await registered()).toContain('ahead_extra');
    expect(await branchColumns()).toContain('ahead_note');
  });

  it('the too-old revert of a later update restores the pre_update N made schema-ahead (runner, targetSchema backup)', { timeout: 120_000 }, async () => {
    // N's pre_update, then N+2 migrates on (LATER_SCHEMA, a contract) and fails: N boots too-old and restores the backup.
    const { backupId, manifest } = await serverBackup(h, { dataDir, installId: INSTALL_ID });
    await runMigrations(h, { appVersion: '0.3.0', dataDir, migrations: LATER });
    expect(await runMigrations(h, { appVersion: '0.1.0', dataDir, migrations: PHASE1_MIGRATIONS })).toMatchObject({ mode: 'too-old', schemaVersion: LATER_SCHEMA });
    const runner = createRestoreRunner({
      dataDir,
      appVersion: '0.1.0',
      migrations: PHASE1_MIGRATIONS,
      sessionKey: () => SESSION_KEY,
      keyring: () => KEYRING,
      installId: INSTALL_ID,
      requestRestart: async () => {},
      sqliteSwap: null,
    });
    const machine = createOpsMachine({
      dataDir,
      kinds: [revertKind(runner)],
      db: () => h,
      connect: () => connect(h.config, { runtime: 'standalone', purpose: 'cli', dataDir: h.dataDir }),
      keyring: () => KEYRING,
      clock: () => Date.now(),
      log: silent,
      snapshotBackupRunning: async () => false,
    });
    try {
      const params: RestoreRunParams = {
        backupId,
        source: 'server',
        targetSchema: 'backup',
        skipPreRestore: true,
        secrets: 'a',
        dropBy: 'schema_tables',
        confirmed: true,
        withoutFiles: false,
      };
      await machine.begin('update', SYSTEM, { restore: runner.begin(params) });
      let status: OpStatus | null = null;
      for (let i = 0; i < 2000; i += 1) {
        status = await machine.step(20_000);
        if (status === null || status.terminal || status.needsAttention) break;
      }
      expect(status).toMatchObject({ kind: 'update', state: 'restored', error: null });
    } finally {
      await machine.close();
    }
    expect(await loadedChecksums(h, manifest, ['notifications'])).toEqual(manifestChecksums(manifest, ['notifications']));
    expect((await migrationNames()).at(-1)).toBe(N_SCHEMA);
    expect(await h.db.selectFrom('schema_meta').select(['schema_version', 'min_code_version']).executeTakeFirstOrThrow()).toEqual({
      schema_version: N_SCHEMA.slice(0, 4),
      min_code_version: '0.0.0',
    });
    expect(await registered()).not.toContain('ahead_extra');
    expect(await branchColumns()).not.toContain('later_note');
  });

  it('a pre_restore made schema-ahead is the way back of a restore that fails past its point of no return', { timeout: 120_000 }, async () => {
    vi.stubEnv('ALTIS_TEST_EXPORT_PART_ROWS', '1');
    const { backupId } = await serverBackup(h, { dataDir, installId: INSTALL_ID });
    vi.unstubAllEnvs();
    await h.db.updateTable('branches').set({ name: 'Diubah', updated_at: Date.now() }).execute();
    const tables = ['branches', 'staff_users', 'roles', 'user_roles', 'settings', 'files'] as const;
    const before = await liveChecksums(h, [...tables]);
    vi.stubEnv('ALTIS_TEST_FAULT', 'restore-mid-load:2');
    const ops = harnessOf();
    const opId = await beginRestore(ops, restoreParams(backupId));
    const states: string[] = [];
    await stepUntil(ops, dataDir, (op) => {
      if (states.at(-1) !== op.state) states.push(op.state);
      return false;
    }, { budgetMs: 1 });
    expect(states).toContain('failed_restoring_pre');
    expect(await currentOp(dataDir)).toMatchObject({ opId, state: 'failed', pointOfNoReturn: true });
    const pre = await readManifest(dataDir, opId);
    expect(pre?.schemaVersion).toBe(N_SCHEMA);
    expect(await liveChecksums(h, [...tables])).toEqual(before);
    expect(await readMaintenance(dataDir)).toBeNull();
  });
});
