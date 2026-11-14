import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PHASE1_MIGRATIONS, TABLE_CLASSES, columnsAt, dropRegisteredTables, runMigrations, type TableName } from '@altis/db';
import { resetTestFaults } from '@altis/platform';
import { newId } from '@altis/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { readMaintenance } from '../../src/ops/files.js';
import { OPS_STALL_MS } from '../../src/ops/machine.js';
import {
  beginRestore,
  currentOp,
  liveChecksums,
  restoreHarness,
  restoreParams,
  seedInstallation,
  serverBackup,
  type RestoreHarness,
} from '../fixtures/restore-support.js';

// A restore before its point of no return whose maintenance flag was lowered by hand (ruling R1c-15, final review G2)
// on the engine picked by ALTIS_TEST_DB. The site served and wrote meanwhile, and the restore has no refreeze: what it
// did under the old freeze (the pre_restore backup, the keep/ copies of the history tables) is stale. Whether the
// flag was removed while it ran (M21, the next step) or forced off while it needed attention (resume), it ends
// `failed` through its cancel: the database as the site left it, tmp/<opId>/, ops/<opId>/keep/ and an unfinished
// pre_restore backup removed, `backup.restore` audited with outcome `failed`, maintenance off.
//
// SQLite targets restore in place here (the test build's stand-in until Task 25).

vi.mock('@altis/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@altis/platform')>();
  return { ...actual, ensureHeadroom: async () => {} };
});

const ctx = testDbContext();
const INSTALL_ID = newId();
// The tables of the Phase 1 schema: under the test profile the registry also names the release fixtures' test_fixture
// (decision D1d-26), which this database (PHASE1_MIGRATIONS) does not have.
const PHASE1_SCHEMA = Object.keys(PHASE1_MIGRATIONS).sort().at(-1)!;
const DATA_TABLES = (Object.keys(TABLE_CLASSES) as TableName[]).filter(
  (t) =>
    (TABLE_CLASSES[t] === 'data' || TABLE_CLASSES[t] === 'config') && t !== 'notifications' && columnsAt(t, PHASE1_SCHEMA).length > 0,
);

describe.skipIf(!ctx.available)(`restore whose freeze broke [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let root: string;
  let dataDir: string;
  let harness: RestoreHarness;

  beforeAll(async () => {
    h = await testDb();
    root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-restore-freeze-')));
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
    harness = restoreHarness({ dataDir, config: h.config, dbDataDir: h.dataDir, live: h, installId: INSTALL_ID });
    // One row per part: the pre_restore backup takes many steps.
    vi.stubEnv('ALTIS_TEST_EXPORT_PART_ROWS', '1');
    resetTestFaults();
  });

  afterEach(async () => {
    await harness.close();
    vi.unstubAllEnvs();
    resetTestFaults();
  });

  const exists = (...parts: string[]): Promise<boolean> =>
    fsp.stat(path.join(dataDir, ...parts)).then(
      () => true,
      () => false,
    );
  const backupRow = (id: string) => h.db.selectFrom('backups').select(['kind', 'status']).where('id', '=', id).executeTakeFirst();
  const restoreEntries = async () =>
    (await h.db.selectFrom('audit_log').select('meta').where('action', '=', 'backup.restore').execute()).map((a) => JSON.parse(a.meta) as Record<string, unknown>);
  /** `maintenance:off --force`. */
  const forceOff = (): Promise<void> => fsp.rm(path.join(dataDir, 'ops', 'maintenance.json'));
  /** What the site writes once it serves again. */
  const siteWrites = async (): Promise<void> => {
    await h.db.updateTable('branches').set({ name: 'Ditulis saat situs melayani', updated_at: Date.now() }).execute();
  };

  /** One handler step per call until `until` holds for op.json (at most `calls` calls). */
  async function stepTo(until: (state: string, params: Record<string, unknown>) => boolean | Promise<boolean>, calls = 500): Promise<void> {
    for (let i = 0; i < calls; i += 1) {
      const op = await currentOp(dataDir);
      if (await until(op.state, op.params)) return;
      const status = await harness.ops.step(1);
      if (status === null || status.terminal || status.needsAttention) break;
    }
    throw new Error(`the restore did not get there; it is in ${(await currentOp(dataDir)).state}`);
  }

  it('the flag removed by hand during pre_restore: the next step ends the restore failed and undoes its work', async () => {
    const { backupId } = await serverBackup(h, { dataDir, installId: INSTALL_ID });
    const opId = await beginRestore(harness, restoreParams(backupId));
    await stepTo((state, params) => state === 'pre_restore' && params['pre'] !== undefined && params['pre'] !== null);
    expect(await currentOp(dataDir)).toMatchObject({ state: 'pre_restore', backupId: opId, pointOfNoReturn: false });
    expect(await backupRow(opId)).toEqual({ kind: 'pre_restore', status: 'running' });
    expect(await exists('backups', opId)).toBe(true);
    // What an uploaded archive's extraction leaves there.
    await fsp.mkdir(path.join(dataDir, 'tmp', opId, 'src'), { recursive: true });
    await fsp.writeFile(path.join(dataDir, 'tmp', opId, 'src', 'manifest.json'), '{}');

    await forceOff();
    await siteWrites();
    const before = await liveChecksums(h, DATA_TABLES);
    const status = await harness.ops.step(1);

    expect(status).toMatchObject({ opId, state: 'failed', terminal: true, pointOfNoReturn: false, error: { code: 'OPS_FREEZE_BROKEN' } });
    expect(await liveChecksums(h, DATA_TABLES)).toEqual(before);
    expect(await backupRow(opId)).toEqual({ kind: 'pre_restore', status: 'failed' });
    expect(await exists('backups', opId)).toBe(false);
    expect(await exists('tmp', opId)).toBe(false);
    expect(await restoreEntries()).toMatchObject([{ opId, outcome: 'failed', error: 'OPS_FREEZE_BROKEN' }]);
    expect(await readMaintenance(dataDir)).toBeNull();
    expect(harness.deps.requestRestart.calls).toEqual([]);
  }, 60_000);

  it('needs attention in preserving, forced off, resumed: the restore ends failed, keep/ removed, the finished pre_restore backup kept', async () => {
    const { backupId } = await serverBackup(h, { dataDir, installId: INSTALL_ID });
    const opId = await beginRestore(harness, restoreParams(backupId));
    await stepTo(async (state) => state === 'preserving' && (await exists('ops', opId, 'keep')));
    expect(await currentOp(dataDir)).toMatchObject({ state: 'preserving', pointOfNoReturn: false });
    expect(await backupRow(opId)).toEqual({ kind: 'pre_restore', status: 'ok' });

    // The database stops answering for 15 minutes: the op needs attention, and the operator brings the site back.
    harness.advance(OPS_STALL_MS + 1000);
    expect(await harness.ops.step(1)).toMatchObject({ state: 'needs_attention' });
    await forceOff();
    harness.advance(-(OPS_STALL_MS + 1000)); // an audit entry may not be dated ahead of the real clock
    await siteWrites();
    const before = await liveChecksums(h, DATA_TABLES);
    const status = await harness.ops.resume();

    expect(status).toMatchObject({ opId, state: 'failed', terminal: true, pointOfNoReturn: false, error: { code: 'OPS_FREEZE_BROKEN' } });
    expect(await liveChecksums(h, DATA_TABLES)).toEqual(before);
    expect(await exists('ops', opId, 'keep')).toBe(false);
    expect(await backupRow(opId)).toEqual({ kind: 'pre_restore', status: 'ok' }); // a finished backup stays
    expect(await exists('backups', opId, 'manifest.json')).toBe(true);
    expect(await restoreEntries()).toMatchObject([{ opId, outcome: 'failed', error: 'OPS_FREEZE_BROKEN' }]);
    expect(await readMaintenance(dataDir)).toBeNull();
    expect(await harness.ops.step(1)).toMatchObject({ state: 'failed', terminal: true });
  }, 120_000);
});
