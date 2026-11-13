import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PHASE1_MIGRATIONS, connect, dropRegisteredTables, listCatalogTables, runMigrations } from '@altis/db';
import { DomainError, isDomainError, newId } from '@altis/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EDITION_TEST_MIGRATION, EDITION_TEST_MIGRATIONS, EDITION_TEST_TABLE } from '../../../db/test/fixtures/edition-migrations.js';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { auditHeadOf, insertBackupRow, schemaVersionOf } from '../../src/backup/create-job.js';
import { createExporter, type ExportCheckpoint } from '../../src/backup/exporter.js';
import { catalogBackupTables } from '../../src/backup/generic-columns.js';
import { readManifest, type BackupManifest } from '../../src/backup/manifest.js';
import type { OpFile } from '../../src/ops/files.js';
import { createOpsMachine, type OpKindHandler, type OpStatus } from '../../src/ops/machine.js';
import { assertNoEditionTables } from '../../src/restore/prepass.js';
import { createRestoreRunner, type RestoreRun } from '../../src/restore/runner.js';
import { revertRestoreParams } from '../../src/updates/revert.js';
import {
  KEYRING,
  SESSION_KEY,
  SYSTEM,
  beginRestore,
  restoreHarness,
  restoreParams,
  seedInstallation,
  serverBackup,
  silent,
  stepUntil,
  type RestoreHarness,
} from '../fixtures/restore-support.js';

// A database that holds tables of the other migration lane ("migrasi jalur lain": `schema_tables.created_by` names a
// migration `eNNNN_slug`), seen by code whose own lane is empty (this edition):
//
// - the catalog export of a `pre_update` backup leaves those tables out, and an ordinary backup (the code's registry)
//   never had them;
// - a restore onto that database, and the update revert's restore, are refused with 409 BACKUP_EDITION_TABLES before
//   anything is dropped: the tables and their rows stay.

vi.mock('@altis/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@altis/platform')>();
  return { ...actual, ensureHeadroom: async () => {} };
});

const ctx = testDbContext();
const INSTALL_ID = newId();

/** An `update` op kind that steps the restore runner as the revert's `restoring` state does. */
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

describe.skipIf(!ctx.available)(`tables of the other migration lane: backup, restore and revert [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let root: string;
  let dataDir: string;
  let harness: RestoreHarness | null = null;

  beforeAll(async () => {
    h = await testDb();
    root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-edition-backup-')));
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
  });

  afterEach(async () => {
    await harness?.close();
    harness = null;
  });

  /** The test lane run on the database (as code that ships it would), and one row in its table. */
  async function withLaneTable(): Promise<void> {
    const outcome = await runMigrations(h, { appVersion: '0.1.0', dataDir, migrations: PHASE1_MIGRATIONS, editionMigrations: EDITION_TEST_MIGRATIONS });
    expect(outcome.edition).toEqual({ mode: 'migrated', applied: [EDITION_TEST_MIGRATION] });
    await h.db.insertInto(EDITION_TEST_TABLE as never).values({ id: newId(), label: 'baris jalur lain' } as never).execute();
  }

  const laneRows = async (): Promise<unknown[]> => h.db.selectFrom(EDITION_TEST_TABLE as never).select('label' as never).execute();

  /** A `pre_update` backup in catalog mode (the generic exporter of the `schemaHold` update), its manifest. */
  async function catalogPreUpdate(): Promise<BackupManifest> {
    const backupId = newId();
    const now = Date.now();
    const schemaVersion = await schemaVersionOf(h.db, { columns: 'catalog' });
    await insertBackupRow(h, { id: backupId, kind: 'pre_update', consistency: 'frozen', dialect: h.dialect, schemaVersion, appVersion: '0.1.0', now });
    const exporter = createExporter({
      read: h.db,
      dialect: h.dialect,
      dataDir,
      backupId,
      kind: 'pre_update',
      includeFiles: false,
      consistency: 'frozen',
      appVersion: '0.1.0',
      schemaVersion,
      installId: INSTALL_ID,
      sessionKey: SESSION_KEY,
      kids: ['k1'],
      auditHead: await auditHeadOf(h.db),
      clock: () => now,
      columns: 'catalog',
    });
    let cp: ExportCheckpoint | null = null;
    for (;;) {
      const r = await exporter.step(cp, { deadline: Date.now() + 60_000 });
      cp = r.checkpoint;
      if (r.done) break;
    }
    return (await readManifest(dataDir, backupId))!;
  }

  it('the catalog export of a pre_update backup leaves the tables of the other lane out', async () => {
    await withLaneTable();
    expect((await catalogBackupTables(h.db, h.dialect)).map((t) => t.table)).not.toContain(EDITION_TEST_TABLE);
    const manifest = await catalogPreUpdate();
    expect(manifest.tables).not.toHaveProperty(EDITION_TEST_TABLE);
    // The core tables are there (a catalog export holds every data, config and history table of schema_tables).
    expect(manifest.tables).toHaveProperty('branches');
  });

  it('an ordinary backup (the code’s registry) never lists them', async () => {
    await withLaneTable();
    const { manifest } = await serverBackup(h, { dataDir, installId: INSTALL_ID });
    expect(manifest.tables).not.toHaveProperty(EDITION_TEST_TABLE);
  });

  it('assertNoEditionTables: 409 BACKUP_EDITION_TABLES with the count of the lane’s rows, else of its tables', async () => {
    await expect(assertNoEditionTables(h.db)).resolves.toBeUndefined();
    await withLaneTable();
    const error = await assertNoEditionTables(h.db).catch((e: unknown) => e);
    expect(isDomainError(error)).toBe(true);
    expect(error).toMatchObject({ code: 'BACKUP_EDITION_TABLES', status: 409, meta: { count: 1 } });
    expect(error).toBeInstanceOf(DomainError);
    // Without the lane's rows, its tables are counted.
    await h.db.deleteFrom('schema_migrations_edition').execute();
    await expect(assertNoEditionTables(h.db)).rejects.toMatchObject({ code: 'BACKUP_EDITION_TABLES', meta: { count: 1 } });
    // A row of the lane alone is refused too.
    await dropRegisteredTables(h.db, h.dialect);
    await runMigrations(h, { appVersion: '0.1.0', dataDir, migrations: PHASE1_MIGRATIONS });
    await h.db.insertInto('schema_migrations_edition').values({ name: 'e0002_x', timestamp: new Date().toISOString() }).execute();
    await expect(assertNoEditionTables(h.db)).rejects.toMatchObject({ code: 'BACKUP_EDITION_TABLES', meta: { count: 1 } });
  });

  it('a restore onto that database is refused with BACKUP_EDITION_TABLES before any table is dropped', { timeout: 120_000 }, async () => {
    await withLaneTable();
    const { backupId } = await serverBackup(h, { dataDir, installId: INSTALL_ID });
    const before = (await listCatalogTables(h)).sort();
    harness = restoreHarness({ dataDir, config: h.config, dbDataDir: h.dataDir, live: h, installId: INSTALL_ID });
    await beginRestore(harness, restoreParams(backupId));
    const status = await stepUntil(harness, dataDir);
    expect(status).toMatchObject({ kind: 'restore', state: 'failed', error: { code: 'BACKUP_EDITION_TABLES' } });
    expect((await listCatalogTables(h)).sort()).toEqual(before);
    expect(await laneRows()).toEqual([{ label: 'baris jalur lain' }]);
  });

  it('the update revert’s restore onto that database is refused the same way', { timeout: 120_000 }, async () => {
    await withLaneTable();
    const { backupId } = await serverBackup(h, { dataDir, installId: INSTALL_ID });
    const before = (await listCatalogTables(h)).sort();
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
    let status: OpStatus | null = null;
    try {
      await machine.begin('update', SYSTEM, { restore: runner.begin(revertRestoreParams(backupId)) });
      for (let i = 0; i < 2000; i += 1) {
        status = await machine.step(20_000);
        if (status === null || status.terminal || status.needsAttention) break;
      }
    } finally {
      await machine.close();
    }
    expect(status).toMatchObject({ kind: 'update', state: 'restore_failed', error: { code: 'BACKUP_EDITION_TABLES' } });
    expect((await listCatalogTables(h)).sort()).toEqual(before);
    expect(await laneRows()).toEqual([{ label: 'baris jalur lain' }]);
  });
});
