import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  backupPrepareDownloadJob,
  claimById,
  createJobRegistry,
  deriveDownloadKey,
  enqueuePrepareDownload,
  insertExternalBackupRow,
  preparedDownloadPath,
  readSecret,
  readUploadedHeader,
  runSlice,
  uploadedArchivePath,
  writeSettings,
  type BackupManifest,
  type OpStatus,
  type OpsMachine,
} from '@altis/core';
import { connect, listCatalogTables, withTx, type DbHandle } from '@altis/db';
import { newId } from '@altis/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadedChecksums, manifestChecksums, seedInstallation, serverBackup, type Seeded } from '../../../../packages/core/test/fixtures/restore-support.js';
import { testDbConfig, testDbContext, testDbFor, type TestEngine } from '../../../../tools/test/test-db.js';
import { createApp, type AppState } from '../../src/app.js';
import { writeConfig, type Config } from '../../src/config.js';
import { csrfKey } from '../../src/http/csrf.js';
import { createOpsFence } from '../../src/http/ops-fence.js';
import { opKinds } from '../../src/jobs/runtime.js';
import { createAppOps } from '../../src/services.js';
import { createAgent } from '../agent.js';
import { seedStaff, sessionCookieFor, sessionCsrfFor } from '../support-auth.js';
import { recordingLogger, sampleConfig } from '../support.js';

// The cross-release restore of acceptance A6 ("Backup 0.1.0 SQLite → restore di 0.2.0 MySQL"; plan Task 34; follow-up
// T29-0008-ARCHIVE-PATH). A backup made by release 0.1.0-test (fixture level 1: PHASE1_MIGRATIONS, schema 0009) on
// SQLite is prepared as an `.altisbak` archive with a passphrase (Task 21's job), uploaded to another installation that
// runs release 0.2.0-test (fixture level 2: + 9001_test_expand) on the engine ALTIS_TEST_DB names, and restored there
// by that release's code through the real route `POST backups/:id/restore` and the server's `restore` op
// (`targetSchema: 'latest'`): the archive path of restore/source.ts (openAltisbak, its extraction, partLines over the
// extracted parts) loads the older schema, and `migrating` brings it to 9001.
//
// Engines: the backup is made on ALTIS_TEST_DB_SOURCE when the run names one, else on SQLite in a DATA_DIR of its own
// (SQLite needs no server, so it is always there); the restore runs on ALTIS_TEST_DB. `ALTIS_TEST_DB=mysql80` is
// therefore exactly A6's "SQLite → MySQL 8.0"; the same file proves SQLite → MariaDB/PostgreSQL on those runs.
//
// This process's code is release 0.2.0-test: releaseMigrations() defaults to fixture level 2 (as schema-hold.test.ts).

const archiveReads = vi.hoisted(() => ({ opened: 0 }));
vi.mock('@altis/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@altis/db')>();
  return { ...actual, releaseMigrations: (level?: Parameters<typeof actual.releaseMigrations>[0]) => actual.releaseMigrations(level ?? 2) };
});
vi.mock('@altis/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@altis/platform')>();
  // A real probe writes 64 MiB per new DATA_DIR.
  return { ...actual, ensureHeadroom: async () => {} };
});
// The archive reader the restore source opens (restore/source.ts imports it from this module): counted, so that the
// test proves the restore read the `.altisbak` itself and not a server folder (T29-0008-ARCHIVE-PATH).
vi.mock('../../../../packages/core/src/archive/altisbak.js', async (importOriginal) => {
  type Open = (...args: unknown[]) => Promise<unknown>;
  const actual = await importOriginal<{ openAltisbak: Open }>();
  return {
    ...actual,
    openAltisbak: async (...args: unknown[]) => {
      archiveReads.opened += 1;
      return actual.openAltisbak(...args);
    },
  };
});
const actualDb = await vi.importActual<typeof import('@altis/db')>('@altis/db');

const ctx = testDbContext();
const TARGET: TestEngine = ctx.engine;
const SOURCE: TestEngine = ctx.source ?? 'sqlite';
/** The source engine's databases exist: SQLite always; another source only when global-setup made them. */
const SOURCE_READY = SOURCE === 'sqlite' || SOURCE === ctx.engine ? true : ctx.sourceAvailable;
const READY = ctx.available && SOURCE_READY;
const LABEL = READY
  ? `${SOURCE} 0.1.0-test → ${TARGET} 0.2.0-test`
  : `${SOURCE} → ${TARGET}, SKIPPED: ${(!ctx.available ? ctx.reason : ctx.sourceReason) ?? 'not available'}`;

const V1 = '0.1.0-test';
const V2 = '0.2.0-test';
const LEVEL1 = actualDb.releaseMigrations(1);
const LEVEL2 = actualDb.releaseMigrations(2);
const SCHEMA_V1 = Object.keys(LEVEL1).sort().at(-1)!;
const EXPAND = '9001_test_expand';
const PASSPHRASE = 'frasa sandi lintas rilis';
const TARGET_LIBRARY = 'Perpustakaan Rilis Baru';
const BACKUPS = '/api/v1/backups';
const SID = '__Host-altis_sid';
const silent = { info() {}, warn() {}, error() {} };

const sha256 = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex');

/** The source installation: release 0.1.0-test's backup, prepared as a passphrase archive and copied out. */
interface Source {
  config: Config;
  manifest: BackupManifest;
  archive: string;
  seeded: Seeded;
}

describe.skipIf(!READY)(`cross-release restore [${LABEL}]`, () => {
  let root: string;

  beforeAll(async () => {
    root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-cross-release-')));
  });

  afterAll(async () => {
    if (root !== undefined) await fsp.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  /** A handle on the source engine's database in `dataDir`, emptied first (SQLite: a new file in that DATA_DIR). */
  async function sourceHandle(dataDir: string): Promise<DbHandle> {
    if (SOURCE === ctx.engine || SOURCE === ctx.source) return testDbFor(SOURCE, { dataDir });
    return actualDb.connect(testDbConfig(ctx, 'sqlite'), { runtime: 'standalone', purpose: 'server', dataDir });
  }

  /** Release 0.1.0-test's installation on SOURCE, seeded, backed up (DB and files) and prepared as an archive. */
  async function makeSource(): Promise<Source> {
    const dataDir = await fsp.mkdtemp(path.join(root, 'source-'));
    const h = await sourceHandle(dataDir);
    try {
      await actualDb.runMigrations(h, { appVersion: V1, dataDir, migrations: LEVEL1 });
      // Only its keys count here (keyring, session key, install id): the source never runs a server.
      const config = sampleConfig({ db: { dialect: 'sqlite' } });
      const seeded = await seedInstallation(h, { dataDir, installId: config.install.id, keyring: config.keyring });
      const { backupId, manifest } = await serverBackup(h, {
        dataDir,
        installId: config.install.id,
        sessionKey: csrfKey(config),
        kids: config.keyring.map((k) => k.kid),
        includeFiles: true,
      });
      // Task 21's job prepares the `.altisbak` (encrypted with the passphrase) for the first seeded staff member.
      const deps = { dataDir, keyring: config.keyring, sessionKey: csrfKey(config) };
      const reg = createJobRegistry([backupPrepareDownloadJob(() => deps)]);
      const key = await deriveDownloadKey(PASSPHRASE);
      const preparedBy = seeded.users[0]!.id;
      const { jobId } = await withTx(h, (trx) => enqueuePrepareDownload(trx, { backupId, preparedBy, superAdmin: true, key, now: Date.now(), keyring: config.keyring }));
      for (let i = 0; i < 500; i += 1) {
        const job = await claimById(h, reg, jobId, { worker: 'cross-release', now: Date.now() });
        if (job === null) break;
        const r = await runSlice(h, reg, job, { mode: 'cron_cli', budgetMs: 20_000, keyring: config.keyring, log: silent, clock: () => Date.now(), env: {} });
        if (r.outcome !== 'continued') break;
      }
      const archive = path.join(root, `${newId()}.altisbak`);
      await fsp.copyFile(preparedDownloadPath(dataDir, backupId, preparedBy, 'archive.altisbak'), archive);
      return { config, manifest, archive, seeded };
    } finally {
      await h.close();
    }
  }

  /** Release 0.2.0-test's installation on TARGET (fixture level 2), its own admin and library, the server's ops machine. */
  async function makeTarget() {
    const dataDir = await fsp.mkdtemp(path.join(root, 'target-'));
    const first = await testDbFor(TARGET, { dataDir });
    await actualDb.runMigrations(first, { appVersion: V2, dataDir, migrations: LEVEL2 });
    const config = sampleConfig({ db: first.config });
    await writeConfig(dataDir, config);
    const admin = await seedStaff(first, { username: 'kepala_baru', roles: [{ key: 'super_admin' }], keyring: config.keyring });
    await withTx(first, async (trx) => {
      await writeSettings(trx, { 'library.name': TARGET_LIBRARY }, { keyring: config.keyring, now: Date.now(), actorId: null });
      await trx.updateTable('schema_meta').set({ install_id: config.install.id }).where('id', '=', 1).execute();
      await trx.insertInto('test_fixture' as never).values({ id: newId(), note: 'baris 0.2 sebelum pemulihan', created_at: Date.now() } as never).execute();
    });
    const log = recordingLogger();
    const state: AppState = { phase: 'ready', db: first, config };
    let offset = 0;
    // As start() does on SQLite (1c Task 25): this process lets go of the live file for the swap and opens it again.
    let released = false;
    const own = {
      async close(): Promise<void> {
        await ops.close();
        const h = state.db;
        state.db = undefined;
        if (h === undefined) return;
        released = true;
        await h.close();
      },
      async reopen(): Promise<void> {
        if (!released || state.db !== undefined) return;
        state.db = await connect(first.config, { runtime: 'standalone', purpose: 'server', dataDir });
        released = false;
      },
    };
    const ops: OpsMachine = createAppOps(state, {
      dataDir,
      version: V2,
      log,
      clock: () => Date.now() + offset,
      runtime: 'standalone',
      kinds: opKinds({ appVersion: V2, config: () => state.config, dataDir, sqlite: { log, own } }),
    });
    const app = () =>
      createApp({
        state,
        version: V2,
        buildId: 'cross-release',
        log,
        clock: () => Date.now(),
        env: {},
        dataDir,
        runtime: 'standalone',
        services: { ops, opsFence: createOpsFence({ dataDir, intervalMs: 0, clock: () => Date.now(), onEpoch() {}, onOpEnded() {} }) },
      });
    const db = (): DbHandle => {
      if (state.db === undefined) throw new Error('the target has no live handle');
      return state.db;
    };
    return {
      dataDir,
      config,
      db,
      async close(): Promise<void> {
        await ops.close();
        await state.db?.close();
        state.db = undefined;
      },
      /** POST backups/:id/restore as the re-authenticated super admin, then the op stepped by the server until it ends. */
      async restore(backupId: string, body: Record<string, unknown>): Promise<{ opId: string; status: OpStatus }> {
        const token = await sessionCookieFor(db(), admin.id, { reauthAt: Date.now() });
        const agent = createAgent(app(), { headers: { origin: new URL(config.baseUrl).origin } });
        agent.setCookie(SID, token);
        const res = await agent.post(`${BACKUPS}/${backupId}/restore`, body, { 'x-csrf-token': sessionCsrfFor(config, token) });
        expect(res.status, res.text).toBe(202);
        const { opId } = res.json as { opId: string };
        offset += 4000; // the freeze's 3 s, on the machine's clock
        let status: OpStatus | null = null;
        for (let i = 0; i < 2000; i += 1) {
          status = await ops.step(20_000);
          if (status === null || status.terminal || status.needsAttention) break;
        }
        expect(status).toMatchObject({ opId, state: 'done' });
        return { opId, status: status! };
      },
    };
  }

  it(
    `a ${V1} backup at ${SCHEMA_V1}, as a passphrase .altisbak, restored by ${V2}: checksums equal, the schema ends at ${EXPAND}`,
    async () => {
      const source = await makeSource();
      expect(source.manifest.schemaVersion).toBe(SCHEMA_V1);
      expect(source.manifest.tables['test_fixture']).toBeUndefined();
      const t = await makeTarget();
      try {
        // The archive uploaded to the target: `backups/<id>/archive.altisbak` and its `external` row (Task 21's
        // registration), its header read as the upload route reads it.
        const backupId = newId();
        const file = uploadedArchivePath(t.dataDir, backupId);
        await fsp.mkdir(path.dirname(file), { recursive: true });
        await fsp.copyFile(source.archive, file);
        const bytes = await fsp.readFile(file);
        const header = await readUploadedHeader(file);
        expect(header).toMatchObject({ schemaVersion: SCHEMA_V1, dialect: 'sqlite' });
        expect(header.encryption).not.toBeNull();
        await withTx(t.db(), (trx) => insertExternalBackupRow(trx, { id: backupId, size: bytes.byteLength, sha256: sha256(bytes), header, now: Date.now() }));

        archiveReads.opened = 0;
        await t.restore(backupId, { passphrase: PASSPHRASE, confirmLibraryName: TARGET_LIBRARY });

        // Through the archive reader, not a server folder.
        expect(archiveReads.opened).toBeGreaterThan(0);
        const audit = await t.db().db.selectFrom('audit_log').select(['entity_id', 'meta']).where('action', '=', 'backup.restore').executeTakeFirstOrThrow();
        expect(audit.entity_id).toBe(backupId);
        expect(JSON.parse(audit.meta)).toMatchObject({ secretsBranch: 'b', sourceInstallId: source.config.install.id, archiveSha256: sha256(bytes), outcome: 'done' });

        // Every loaded table equals the backup, column for column at the archive's schema (notifications: the restore
        // notifies).
        const skip = ['notifications'];
        expect(await loadedChecksums(t.db(), source.manifest, skip)).toEqual(manifestChecksums(source.manifest, skip));
        // The secrets came along (branch b: opened with the passphrase, sealed again with this installation's keyring).
        expect(await readSecret(t.db().db, 'smtp.password', t.config.keyring)).toBe(source.seeded.smtpPassword);

        // The load stopped at the archive's schema; `migrating` applied 0.2.0-test's 9001: the schema ends there.
        const names = (await t.db().db.selectFrom('schema_migrations').select('name').execute()).map((r) => r.name).sort();
        expect(names).toEqual(Object.keys(LEVEL2).sort());
        expect(names.at(-1)).toBe(EXPAND);
        expect(await t.db().db.selectFrom('schema_meta').select(['schema_version', 'install_id']).execute()).toEqual([
          { schema_version: EXPAND.slice(0, 4), install_id: t.config.install.id },
        ]);
        // 9001's table is there again, made by the migration (the archive had none), and holds no row: the target's
        // own row before the restore went with the table drop.
        expect(await listCatalogTables(t.db())).toContain('test_fixture');
        expect(await t.db().db.selectFrom('test_fixture' as never).select('id' as never).execute()).toEqual([]);
      } finally {
        await t.close();
      }
    },
    240_000,
  );
});
