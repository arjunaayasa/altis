import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PHASE1_MIGRATIONS, TABLE_CLASSES, connect, countRows, runMigrations, type DbHandle, type TableName } from '@altis/db';
import { newId } from '@altis/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ENGINE_SPECS, testDbConfig, testDbContext, testDbFor, type TestEngine } from '../../../../tools/test/test-db.js';
import type { BackupManifest } from '../../src/backup/manifest.js';
import { loadTables } from '../../src/restore/load.js';
import { beginRestore, loadedChecksums, manifestChecksums, restoreHarness, restoreParams, seedInstallation, serverBackup, stepUntil } from '../fixtures/restore-support.js';
import { seedCommunityRows } from '../support/community-sample-rows.js';

// A backup of an installation with every table past the Phase 1 core filled (the catalogue, reports and accreditation,
// members and circulation, holds, the calendar, items read in place, clearance letters, visits and guest-book
// stations, the member area, charges and payments, notices, stocktake: the sample rows of packages/db's table tests),
// restored into the same installation moved to another engine. Every table the restore loads comes back with the
// backup's checksum, row for row, on the target's dialect; `files` too, but for the status of the rows whose blob the
// backup does not hold (it is made without files, and the sample rows have none): the restore marks those `missing`.
//
// The backup is made on ALTIS_TEST_DB_SOURCE when the run names one, else on SQLite in a DATA_DIR of its own (SQLite
// needs no server), and restored into ALTIS_TEST_DB: `ALTIS_TEST_DB=pg17` is SQLite → PostgreSQL 17,
// `ALTIS_TEST_DB=mysql84` SQLite → MySQL 8.4; with SQLite alone both sides are SQLite.

vi.mock('@altis/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@altis/platform')>();
  return { ...actual, ensureHeadroom: async () => {} };
});

const ctx = testDbContext();
const INSTALL_ID = newId();

/** Where the restore goes (ALTIS_TEST_DB). */
const TARGET: TestEngine = ctx.engine;
/** Where the installation and its backup are made: ALTIS_TEST_DB_SOURCE, else SQLite in a DATA_DIR of its own. */
const SOURCE: TestEngine = ctx.source ?? 'sqlite';
const SOURCE_READY = SOURCE === 'sqlite' || SOURCE === ctx.engine ? true : ctx.sourceAvailable;
const PAIR_READY = ctx.available && SOURCE_READY;
const PAIR_LABEL = PAIR_READY
  ? `${SOURCE} → ${TARGET}`
  : `${SOURCE} → ${TARGET}, SKIPPED: ${(!ctx.available ? ctx.reason : ctx.sourceReason) ?? 'not available'}`;

const countOf = (h: DbHandle, table: TableName): Promise<number> => countRows(h.db.selectFrom(table));

describe.skipIf(!PAIR_READY)(`backup with every community table filled, restored across engines [${PAIR_LABEL}]`, () => {
  let root: string;

  beforeAll(async () => {
    root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-community-restore-')));
  });

  afterAll(async () => {
    if (root !== undefined) await fsp.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  /** An empty database on SOURCE for the installation in `dataDir` (SQLite: a new file in that DATA_DIR). */
  async function sourceHandle(dataDir: string): Promise<DbHandle> {
    if (SOURCE === ctx.engine || SOURCE === ctx.source) return testDbFor(SOURCE, { dataDir });
    return connect(testDbConfig(ctx, 'sqlite'), { runtime: 'standalone', purpose: 'server', dataDir });
  }

  it('every table the restore loads, the community ones filled, comes back with the backup’s checksum on the other engine', async () => {
    // ---- The source: an installation on SOURCE with every community table filled, backed up. -------------------
    const sourceDir = path.join(root, 'source');
    await fsp.mkdir(path.join(sourceDir, 'tmp'), { recursive: true });
    let backupId: string;
    let manifest: BackupManifest;
    let filled: TableName[];
    let sourceFiles: { id: string; status: string }[];
    const hs = await sourceHandle(sourceDir);
    try {
      await runMigrations(hs, { appVersion: '0.1.0', dataDir: sourceDir, migrations: PHASE1_MIGRATIONS });
      const seeded = await seedInstallation(hs, { dataDir: sourceDir, installId: INSTALL_ID });
      const branch = await hs.db.selectFrom('branches').select('id').where('is_default', '=', 1).executeTakeFirstOrThrow();
      filled = (await seedCommunityRows(hs.db, { branchId: branch.id, staffId: seeded.users[0]!.id })).filter((t) => TABLE_CLASSES[t] === 'data');
      for (const table of filled) expect([table, (await countOf(hs, table)) > 0]).toEqual([table, true]);
      sourceFiles = await hs.db.selectFrom('files').select(['id', 'status']).orderBy('id').execute();
      expect(sourceFiles.filter((f) => f.status === 'ok').length).toBeGreaterThan(0);
      ({ backupId, manifest } = await serverBackup(hs, { dataDir: sourceDir, installId: INSTALL_ID }));
    } finally {
      await hs.close();
    }
    expect(manifest.dialect).toBe(ENGINE_SPECS[SOURCE].dialect);
    const loaded = loadTables(manifest);
    for (const table of filled) expect([table, loaded.includes(table), manifest.tables[table]!.rows > 0]).toEqual([table, true, true]);

    // ---- The target: the same installation (install id and keys) on TARGET, its community tables empty. ---------
    const dataDir = path.join(root, 'target');
    await fsp.mkdir(path.join(dataDir, 'tmp'), { recursive: true });
    const h = await testDbFor(TARGET, { dataDir });
    try {
      await runMigrations(h, { appVersion: '0.1.0', dataDir, migrations: PHASE1_MIGRATIONS });
      await seedInstallation(h, { dataDir, installId: INSTALL_ID });
      expect(await loadedChecksums(h, manifest, ['notifications'])).not.toEqual(manifestChecksums(manifest, ['notifications']));

      // The source's backup brought into the target's DATA_DIR as an external backup.
      await fsp.cp(path.join(sourceDir, 'backups', backupId), path.join(dataDir, 'backups', backupId), { recursive: true });
      const bytes = await fsp.readFile(path.join(dataDir, 'backups', backupId, 'manifest.json'));
      await h.db
        .insertInto('backups')
        .values({
          id: backupId,
          kind: 'external',
          size: bytes.byteLength,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          schema_version: manifest.schemaVersion,
          app_version: manifest.appVersion,
          dialect: manifest.dialect,
          consistency: manifest.consistency,
          status: 'ok',
          created_at: Date.now(),
        })
        .execute();

      const harness = restoreHarness({ dataDir, config: h.config, dbDataDir: h.dataDir, live: h, installId: INSTALL_ID });
      try {
        const opId = await beginRestore(harness, restoreParams(backupId));
        const status = await stepUntil(harness, dataDir);
        expect(status).toMatchObject({ opId, kind: 'restore', state: 'done', terminal: true, error: null });
      } finally {
        await harness.close();
      }

      // The source's data on the target's engine, checksum for checksum (notifications: the archive's plus the
      // restore's own; files: below).
      expect([h.dialect, manifest.dialect]).toEqual([ENGINE_SPECS[TARGET].dialect, ENGINE_SPECS[SOURCE].dialect]);
      expect(await loadedChecksums(h, manifest, ['notifications', 'files'])).toEqual(manifestChecksums(manifest, ['notifications', 'files']));
      // Every file row is back; none has its blob here, so those that were `ok` are `missing`, the others as they were.
      expect(await h.db.selectFrom('files').select(['id', 'status']).orderBy('id').execute()).toEqual(
        sourceFiles.map((f) => ({ id: f.id, status: f.status === 'ok' ? 'missing' : f.status })),
      );
      for (const table of filled) expect([table, await countOf(h, table)]).toEqual([table, manifest.tables[table]!.rows]);
    } finally {
      await h.close();
    }
  }, 600_000);
});
