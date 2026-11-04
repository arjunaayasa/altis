import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PHASE1_MIGRATIONS, runMigrations } from '@altis/db';
import { newId } from '@altis/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyDatabase, engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { dbInstallId, installGate, type InstallGateOptions } from '../../src/install/gate.js';

// The install gate (spec §7.7, plan Task 10): what an uninstalled process serves, decided from the files of DATA_DIR
// and appRoot, and (Docker without its volume) from the database the environment names. Five outcomes, in order:
// installed (install.lock, or config.json complete), datadir_mismatch (an install marker while DATA_DIR is not
// installed, R1c-5), volume_missing (no config, ALTIS_DB_DIALECT set, and that database already has an install id),
// resume (an unfinished config.json), fresh. On the engine picked by ALTIS_TEST_DB.

const ctx = testDbContext();

describe.skipIf(!ctx.available)(`installGate [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let root: string;
  let dataDir: string;
  let appRoot: string;
  let migrateDir: string;

  beforeAll(async () => {
    h = await testDb();
    migrateDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-core-install-gate-db-'));
  });

  afterAll(async () => {
    await h?.close();
    if (migrateDir !== undefined) await fsp.rm(migrateDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-core-install-gate-')));
    dataDir = path.join(root, 'altis-data');
    appRoot = path.join(root, 'app');
    await fsp.mkdir(dataDir);
    await fsp.mkdir(appRoot);
  });

  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  function options(over: Partial<InstallGateOptions> = {}): InstallGateOptions {
    return { dataDir, appRoot, env: {}, config: null, envDbInstallId: async () => null, ...over };
  }

  async function marker(markedDataDir: string): Promise<void> {
    await fsp.mkdir(path.join(appRoot, '.altis'), { recursive: true });
    await fsp.writeFile(path.join(appRoot, '.altis', 'installed.json'), JSON.stringify({ installId: newId(), dataDir: markedDataDir }));
  }

  it('fresh: nothing there', async () => {
    expect(await installGate(options())).toEqual({ kind: 'fresh' });
  });

  it('installed: install.lock exists (whatever it holds), or config.json says complete', async () => {
    await fsp.writeFile(path.join(dataDir, 'install.lock'), 'damaged');
    expect(await installGate(options({ config: { installState: 'migrate' } }))).toEqual({ kind: 'installed' });
    await fsp.rm(path.join(dataDir, 'install.lock'));
    expect(await installGate(options({ config: { installState: 'complete' } }))).toEqual({ kind: 'installed' });
  });

  it('installed wins over a mismatched marker and a lost volume', async () => {
    await fsp.writeFile(path.join(dataDir, 'install.lock'), '{}');
    await marker(path.join(root, 'elsewhere'));
    const envDbInstallId = vi.fn(async () => newId());
    expect(await installGate(options({ env: { ALTIS_DB_DIALECT: 'mariadb' }, envDbInstallId }))).toEqual({ kind: 'installed' });
    expect(envDbInstallId).not.toHaveBeenCalled();
  });

  it('datadir_mismatch: a marker while DATA_DIR is not installed, whichever path it names (R1c-5)', async () => {
    await marker(path.join(root, 'elsewhere'));
    expect(await installGate(options())).toEqual({ kind: 'datadir_mismatch' });
    expect(await installGate(options({ config: { installState: 'profile' } }))).toEqual({ kind: 'datadir_mismatch' });

    // The same DATA_DIR, recreated empty (the bootloader's prepareDataDir after the folder was deleted): the marker
    // still says this app was installed, so the wizard never opens over it.
    await marker(dataDir);
    expect(await installGate(options())).toEqual({ kind: 'datadir_mismatch' });
    expect(await installGate(options({ config: { installState: 'profile' } }))).toEqual({ kind: 'datadir_mismatch' });
    if (process.platform !== 'win32') {
      await fsp.symlink(dataDir, path.join(root, 'link-to-data'));
      await marker(path.join(root, 'link-to-data'));
      expect(await installGate(options())).toEqual({ kind: 'datadir_mismatch' });
    }
    // A lost volume is not looked for once the marker has decided.
    const envDbInstallId = vi.fn(async () => newId());
    expect(await installGate(options({ env: { ALTIS_DB_DIALECT: 'mariadb' }, envDbInstallId }))).toEqual({ kind: 'datadir_mismatch' });
    expect(envDbInstallId).not.toHaveBeenCalled();
    // No appRoot (an app without one) or an unusable marker: not a mismatch.
    expect(await installGate(options({ appRoot: null }))).toEqual({ kind: 'fresh' });
    await fsp.writeFile(path.join(appRoot, '.altis', 'installed.json'), 'not json');
    expect(await installGate(options())).toEqual({ kind: 'fresh' });
  });

  it('volume_missing: no config, ALTIS_DB_DIALECT set, and the env database holds schema_meta.install_id', async () => {
    await emptyDatabase(h);
    const envDbInstallId = () => dbInstallId(h);
    const env = { ALTIS_DB_DIALECT: h.dialect };
    // An empty database (no schema_meta): fresh.
    expect(await dbInstallId(h)).toBeNull();
    expect(await installGate(options({ env, envDbInstallId }))).toEqual({ kind: 'fresh' });

    await runMigrations(h, { appVersion: '0.1.0', dataDir: migrateDir, migrations: PHASE1_MIGRATIONS });
    // Migrated, but no install id yet (an install cut short): still fresh.
    expect(await dbInstallId(h)).toBeNull();
    expect(await installGate(options({ env, envDbInstallId }))).toEqual({ kind: 'fresh' });

    const installId = newId();
    await h.db.updateTable('schema_meta').set({ install_id: installId }).where('id', '=', 1).execute();
    expect(await dbInstallId(h)).toBe(installId);
    expect(await installGate(options({ env, envDbInstallId }))).toEqual({ kind: 'volume_missing' });

    // Only without a config, and only when the environment names a database.
    expect(await installGate(options({ envDbInstallId }))).toEqual({ kind: 'fresh' });
    expect(await installGate(options({ env, envDbInstallId, config: { installState: 'migrate' } }))).toEqual({ kind: 'resume', installState: 'migrate' });
    await emptyDatabase(h);
  });

  it('resume: an unfinished config.json, with its installState', async () => {
    expect(await installGate(options({ config: { installState: 'admin' } }))).toEqual({ kind: 'resume', installState: 'admin' });
  });
});
