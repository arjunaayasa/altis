import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { connect, dropRegisteredTables, ensureTable, readTableColumns, releaseMigrations, runMigrations, verifyAuditChain, type DbHandle } from '@altis/db';
import { newId } from '@altis/shared';
import { sql } from 'kysely';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { base32Decode, hotp, matchTotp, totpStep } from '../../src/auth/totp.js';
import { auditHeadOf, insertBackupRow, schemaVersionOf } from '../../src/backup/create-job.js';
import { createExporter, type ExportCheckpoint } from '../../src/backup/exporter.js';
import { readManifest, type BackupManifest } from '../../src/backup/manifest.js';
import { txCtx } from '../../src/context.js';
import { openValue, secretAad, type KeyringEntry } from '../../src/crypto/secret-box.js';
import { readMaintenance, type OpFile } from '../../src/ops/files.js';
import { createOpsMachine, type OpKindHandler, type OpStatus, type OpsMachine } from '../../src/ops/machine.js';
import { createRestoreRunner, type RestoreKindDeps, type RestoreRun, type RestoreRunParams } from '../../src/restore/runner.js';
import { readSettings, writeSettings } from '../../src/settings/service.js';
import { KEYRING, SESSION_KEY, currentOp, loadedChecksums, manifestChecksums, seedInstallation, sha256, silent, type Seeded } from '../fixtures/restore-support.js';

// The restore runner (1d Task 12; spec §9.7 `restoring`: "tanpa kunci baru; tanpa backup pre_restore; rahasia lewat
// cabang (a); targetSchema = backup (tanpa migrasi); menghapus tabel berdasarkan schema_tables di DB"; decisions C44,
// D1d-21, D1d-44; preflight S21, 1D-08) on the engine picked by ALTIS_TEST_DB, inside an `update` op the way Task 25's
// revert steps it (`op.params.restore`, sub-state `restoring` → `restored` | `restore_failed`).
//
// A database at fixture level 2 (0.2.0-test: 9001_test_expand, `test_fixture`) with rows and TOTP users; a DB-only
// `pre_update` backup of it; the update to level 3 (9002_test_contract: `test_fixture.extra`, `min_code_version
// '0.3.0-test'`), a table of the later release unknown to this code, rows changed. The runner with the code of level 2
// restores the backup at its own schema: the schema, the rows and `min_code_version` are the backup's again, no
// `pre_restore` backup exists, no key was made, and the target's install and history rows and its 2FA are intact.

vi.mock('@altis/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@altis/platform')>();
  return { ...actual, ensureHeadroom: async () => {} };
});

const ctx = testDbContext();
const INSTALL_ID = newId();
const LEVEL2 = releaseMigrations(2);
const LEVEL3 = releaseMigrations(3);
const SYSTEM = { type: 'system', id: null } as const;
const OTHER_KEY = new Uint8Array(32).fill(77);

/** Whether the TOTP of `userId` (sealed in `h`) opens with `keyring` and its code of now matches `plain`. */
async function totpWorks(h: DbHandle, keyring: readonly KeyringEntry[], userId: string, plain: string): Promise<boolean> {
  const row = await h.db.selectFrom('staff_users').select(['totp_secret_enc', 'totp_last_step']).where('id', '=', userId).executeTakeFirstOrThrow();
  if (row.totp_secret_enc === null) return false;
  const text = openValue(keyring, secretAad('staff_users', 'totp_secret_enc', userId), row.totp_secret_enc);
  if (text !== plain) return false;
  const secret = base32Decode(text);
  const now = Date.now();
  return matchTotp(secret, hotp(secret, totpStep(now), 6), now, Number(row.totp_last_step)) !== null;
}

/** The kids of every sealed value in the database (`v1:<kid>:…`): the TOTP secrets and the secret settings. */
async function sealedKids(h: DbHandle): Promise<string[]> {
  const totp = await h.db.selectFrom('staff_users').select('totp_secret_enc').where('totp_secret_enc', 'is not', null).execute();
  const settings = await h.db.selectFrom('settings').select('value').where('is_secret', '=', 1).where('value', 'is not', null).execute();
  const values = [...totp.map((r) => r.totp_secret_enc!), ...settings.map((r) => r.value!)];
  expect(values.length).toBeGreaterThan(2); // two TOTP secrets and smtp.password
  return [...new Set(values.map((v) => v.split(':')[1]!))].sort();
}

/** An `update` op kind that steps the runner as Task 25's `restoring` state does (no maintenanceFrom: held from begin). */
function updateKind(runner: ReturnType<typeof createRestoreRunner>, seen: RestoreRun[]): OpKindHandler {
  return {
    kind: 'update',
    initialState: 'restoring',
    maintenance: 'update',
    freeze: false,
    async step(c, op) {
      const run = await runner.step(c, op.params['restore'] as RestoreRun, { opId: op.opId, actor: op.actor });
      seen.push(run);
      const next: OpFile = { ...op, params: { ...op.params, restore: run }, progress: run.progress ?? op.progress };
      if (run.state === 'done') return { ...next, state: 'restored', progress: 100 };
      if (run.state === 'failed') return { ...next, state: 'restore_failed', error: run.error === null ? null : { code: run.error.code } };
      return next;
    },
    async cancel() {},
  };
}

describe.skipIf(!ctx.available)(`restore runner: the update revert's restore [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let root: string;
  let dataDir: string;
  let seeded: Seeded;
  let machine: OpsMachine | null = null;
  let deps: RestoreKindDeps & { restarts: string[] };

  beforeAll(async () => {
    h = await testDb();
    root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-restore-runner-')));
  });

  afterAll(async () => {
    await h?.close();
    if (root !== undefined) await fsp.rm(root, { recursive: true, force: true });
  });

  beforeEach(async () => {
    dataDir = await fsp.mkdtemp(path.join(root, 'data-'));
    await dropRegisteredTables(h.db, h.dialect);
    await runMigrations(h, { appVersion: '0.2.0-test', dataDir, migrations: LEVEL2 });
    seeded = await seedInstallation(h, { dataDir, installId: INSTALL_ID });
    const now = Date.now();
    for (let i = 0; i < 3; i += 1) {
      await h.db.insertInto('test_fixture' as never).values({ id: newId(now), note: `catatan ${i}`, created_at: now + i } as never).execute();
    }
    const restarts: string[] = [];
    deps = {
      dataDir,
      appVersion: '0.2.0-test',
      migrations: LEVEL2,
      sessionKey: () => SESSION_KEY,
      keyring: () => KEYRING,
      installId: INSTALL_ID,
      requestRestart: async (reason) => {
        restarts.push(reason);
      },
      sqliteSwap: null,
      restarts,
    };
  });

  afterEach(async () => {
    await machine?.close();
    machine = null;
  });

  /** A DB-only `pre_update` backup of the database now (signed with `sessionKey`), its row `ok`. */
  async function preUpdateBackup(o: { sessionKey?: Uint8Array } = {}): Promise<{ backupId: string; manifest: BackupManifest }> {
    const backupId = newId();
    const now = Date.now();
    const schemaVersion = await schemaVersionOf(h.db);
    await insertBackupRow(h, { id: backupId, kind: 'pre_update', consistency: 'frozen', dialect: h.dialect, schemaVersion, appVersion: '0.2.0-test', now });
    const exporter = createExporter({
      read: h.db,
      dialect: h.dialect,
      dataDir,
      backupId,
      kind: 'pre_update',
      includeFiles: false,
      consistency: 'frozen',
      appVersion: '0.2.0-test',
      schemaVersion,
      installId: INSTALL_ID,
      sessionKey: o.sessionKey ?? SESSION_KEY,
      kids: ['k1'],
      auditHead: await auditHeadOf(h.db),
      clock: () => now,
    });
    let cp: ExportCheckpoint | null = null;
    for (;;) {
      const r = await exporter.step(cp, { deadline: Date.now() + 60_000 });
      cp = r.checkpoint;
      if (r.done) break;
    }
    const bytes = await fsp.readFile(path.join(dataDir, 'backups', backupId, 'manifest.json'));
    await h.db.updateTable('backups').set({ status: 'ok', size: bytes.byteLength, sha256: sha256(bytes) }).where('id', '=', backupId).execute();
    return { backupId, manifest: (await readManifest(dataDir, backupId))! };
  }

  /** The update to level 3 (9002 and its `min_code_version`), a later release's own table, and rows changed after it. */
  async function updateToLevel3(): Promise<void> {
    await runMigrations(h, { appVersion: '0.3.0-test', dataDir, migrations: LEVEL3 });
    await ensureTable(h.db, h.dialect, 'later_release_table', 'data', '0004_later', (t) => {
      t.id();
      t.varchar('label', 64);
    });
    const now = Date.now();
    await sql`INSERT INTO later_release_table (id, label) VALUES (${newId()}, ${'baru'})`.execute(h.db);
    await sql`UPDATE test_fixture SET note = ${'diubah'}, extra = ${'tambahan'}`.execute(h.db);
    await sql`INSERT INTO test_fixture (id, note, created_at, extra) VALUES (${newId()}, ${'baris baru'}, ${now}, ${'x'})`.execute(h.db);
    await h.db
      .insertInto('staff_users')
      .values({ id: newId(), username_key: 'baru', username_display: 'baru', name: 'Baru', password_hash: 'x', status: 'active', created_at: now, updated_at: now })
      .execute();
    await h.db.transaction().execute((trx) => writeSettings(trx, { 'library.name': 'Nama Sesudah Update' }, { keyring: KEYRING, now, actorId: null }));
    await h.db.transaction().execute(async (trx) => {
      for (let i = 0; i < 4; i += 1) {
        await txCtx(trx, now, { type: 'system', id: null, ip: null }).audit({ action: 'audit.purge', entity: 'audit_log', entityId: null, meta: { after: i } });
      }
    });
    await h.db.updateTable('license_state').set({ status_cache: 'active', clock_high_water: now + 1 }).execute();
    await h.db
      .insertInto('releases_log')
      .values({ id: newId(), version: '0.3.0-test', action: 'update', from_version: '0.2.0-test', status: 'reverting', started_at: now, finished_at: null, backup_id: null, detail: null })
      .execute();
  }

  function newMachine(seen: RestoreRun[]): OpsMachine {
    machine = createOpsMachine({
      dataDir,
      kinds: [updateKind(createRestoreRunner(deps), seen)],
      db: () => h,
      connect: () => connect(h.config, { runtime: 'standalone', purpose: 'cli', dataDir: h.dataDir }),
      keyring: () => KEYRING,
      clock: () => Date.now(),
      log: silent,
      snapshotBackupRunning: async () => false,
    });
    return machine;
  }

  /** Steps the op until it ends (or needs attention). */
  async function stepToEnd(ops: OpsMachine): Promise<OpStatus | null> {
    let status: OpStatus | null = null;
    for (let i = 0; i < 2000; i += 1) {
      status = await ops.step(20_000);
      if (status === null || status.terminal || status.needsAttention) break;
    }
    return status;
  }

  // The plan's Task 25 row passes `withoutFiles: true`, but a restore without files marks every upload `missing`
  // (restore/files.ts, the 1c semantics that restore-secrets.test.ts pins), so the reverted installation would lose its
  // uploads although they are on disk. The revert restores this installation's own backup into its own DATA_DIR: with
  // `withoutFiles: false` every upload in place stays `ok` (spec §9.10 step 10). Task 12's report raises it for Task 25.
  const revertParams = (backupId: string): RestoreRunParams => ({
    backupId,
    source: 'server',
    targetSchema: 'backup',
    skipPreRestore: true,
    secrets: 'a',
    dropBy: 'schema_tables',
    confirmed: true,
    withoutFiles: false,
  });

  it('restores the pre_update backup at its own schema: 9001, no extra column, its min_code_version and rows; install, history and 2FA kept', { timeout: 120_000 }, async () => {
    const minCodeBefore = (await h.db.selectFrom('schema_meta').select('min_code_version').executeTakeFirstOrThrow()).min_code_version;
    const { backupId, manifest } = await preUpdateBackup();
    expect(manifest.schemaVersion).toBe('9001_test_expand');
    expect(manifest.tables).toHaveProperty('test_fixture');
    await updateToLevel3();
    expect((await h.db.selectFrom('schema_meta').select('min_code_version').executeTakeFirstOrThrow()).min_code_version).toBe('0.3.0-test');
    const license = await h.db.selectFrom('license_state').selectAll().execute();
    const head = await h.db.selectFrom('audit_head').selectAll().execute();
    const releases = await h.db.selectFrom('releases_log').selectAll().orderBy('id').execute();
    const auditIds = (await h.db.selectFrom('audit_log').select('id').execute()).map((r) => r.id).sort();
    const keyring = structuredClone(KEYRING);

    const seen: RestoreRun[] = [];
    const ops = newMachine(seen);
    const runner = createRestoreRunner(deps);
    await ops.begin('update', SYSTEM, { restore: runner.begin(revertParams(backupId)) });
    const status = await stepToEnd(ops);
    expect(status).toMatchObject({ kind: 'update', state: 'restored', error: null });
    const run = (await currentOp(dataDir)).params['restore'] as RestoreRun;
    expect(run).toMatchObject({ state: 'done', error: null, progress: 100 });
    // `migrating` is skipped (targetSchema 'backup'), and `pre_restore` is never the runner's.
    const states = seen.map((r) => r.state);
    expect(states.at(-1)).toBe('done');
    expect(states).not.toContain('migrating');
    expect(states.filter((s, i) => s !== states[i - 1])).toEqual(['prechecked', 'preserving', 'loading', 'finalizing', 'done']);

    // The schema of the backup, nothing after it.
    const migrations = (await h.db.selectFrom('schema_migrations' as never).select('name' as never).execute()) as { name: string }[];
    expect(migrations.map((m) => m.name).sort().at(-1)).toBe('9001_test_expand');
    expect((await readTableColumns(h.db, h.dialect, 'test_fixture')).map((c) => c.name)).toEqual(['id', 'note', 'created_at']);
    expect((await h.db.selectFrom('schema_meta').select(['schema_version', 'min_code_version']).executeTakeFirstOrThrow()).min_code_version).toBe(minCodeBefore);
    // The later release's table went with the drop by schema_tables, though this code's registry never knew it.
    expect(await readTableColumns(h.db, h.dialect, 'later_release_table')).toEqual([]);

    // The rows of the backup; no pre_restore backup.
    expect(await loadedChecksums(h, manifest, ['notifications'])).toEqual(manifestChecksums(manifest, ['notifications']));
    expect((await readSettings(h.db, ['library.name'], []))['library.name']).toBe('Perpustakaan Arsya');
    expect((await h.db.selectFrom('files').select('status').execute()).map((r) => r.status)).toEqual(['ok', 'ok']); // uploads in place
    expect(await h.db.selectFrom('backups').select('id').where('kind', '=', 'pre_restore').execute()).toEqual([]);

    // No new key; the install and history rows kept; 2FA intact.
    expect(KEYRING).toEqual(keyring);
    expect(await sealedKids(h)).toEqual(['k1']);
    expect(await h.db.selectFrom('license_state').selectAll().execute()).toEqual(license);
    expect(await h.db.selectFrom('releases_log').selectAll().orderBy('id').execute()).toEqual(releases);
    const newHead = await h.db.selectFrom('audit_head').selectAll().execute();
    expect(Number(newHead[0]!.last_seq)).toBe(Number(head[0]!.last_seq) + 1); // the restore's own backup.restore entry
    const restoredIds = (await h.db.selectFrom('audit_log').select('id').execute()).map((r) => r.id);
    expect(restoredIds.filter((id) => auditIds.includes(id)).sort()).toEqual(auditIds);
    expect((await verifyAuditChain(h)).ok).toBe(true);
    const entry = await h.db.selectFrom('audit_log').select('meta').where('action', '=', 'backup.restore').executeTakeFirstOrThrow();
    expect(JSON.parse(entry.meta)).toMatchObject({ secretsBranch: 'a', outcome: 'done', sourceInstallId: INSTALL_ID });
    for (const u of seeded.users.filter((x) => x.totp !== null)) expect(await totpWorks(h, KEYRING, u.id, u.totp!)).toBe(true);
    expect(await h.db.selectFrom('schema_meta').select('install_id').execute()).toEqual([{ install_id: INSTALL_ID }]);

    // The runner leaves the restart to its caller; the op's flag is lowered by the machine as for any ended update.
    expect(deps.restarts).toEqual([]);
    expect(await readMaintenance(dataDir)).toBeNull();
  });

  it('a RestoreRun with fields of a later release (top, params, checkpoint) is stepped to done and keeps them', { timeout: 120_000 }, async () => {
    const { backupId, manifest } = await preUpdateBackup();
    await updateToLevel3();
    const seen: RestoreRun[] = [];
    const ops = newMachine(seen);
    const runner = createRestoreRunner(deps);
    const begun = runner.begin(revertParams(backupId));
    const future = { ...begun, future: 1, params: { ...begun.params, futureParam: 'p' }, checkpoint: { futureCheckpoint: { n: 2 } } };
    await ops.begin('update', SYSTEM, { restore: future, laterUpdateField: true });
    expect(await stepToEnd(ops)).toMatchObject({ state: 'restored' });
    const op = await currentOp(dataDir);
    expect(op.params['laterUpdateField']).toBe(true);
    const run = op.params['restore'] as RestoreRun & { future?: unknown; params: { futureParam?: unknown } };
    expect(run.state).toBe('done');
    expect(run.future).toBe(1);
    expect(run.params.futureParam).toBe('p');
    expect(run.checkpoint['futureCheckpoint']).toEqual({ n: 2 });
    // Every intermediate run written kept them too.
    expect(seen.length).toBeGreaterThan(3);
    for (const r of seen) expect(r).toMatchObject({ future: 1, params: { futureParam: 'p' }, checkpoint: { futureCheckpoint: { n: 2 } } });
    expect(seen.length).toBeGreaterThan(1);
    expect(await loadedChecksums(h, manifest, ['notifications'])).toEqual(manifestChecksums(manifest, ['notifications']));
  });

  it('secrets a: a backup another installation signed ends failed (BACKUP_INVALID, signature) before the point of no return', { timeout: 120_000 }, async () => {
    const { backupId } = await preUpdateBackup({ sessionKey: OTHER_KEY });
    await updateToLevel3();
    const before = (await h.db.selectFrom('test_fixture' as never).select('note' as never).execute()) as { note: string }[];
    const seen: RestoreRun[] = [];
    const ops = newMachine(seen);
    const runner = createRestoreRunner(deps);
    await ops.begin('update', SYSTEM, { restore: runner.begin(revertParams(backupId)) });
    expect(await stepToEnd(ops)).toMatchObject({ state: 'restore_failed', error: { code: 'BACKUP_INVALID' } });
    const run = (await currentOp(dataDir)).params['restore'] as RestoreRun;
    expect(run).toMatchObject({ state: 'failed', error: { code: 'BACKUP_INVALID', reason: 'signature' } });
    expect(run.error!.detail).toMatch(/branch c/);
    // Nothing touched: still level 3, the rows as they were; the kept copies and the extraction gone.
    expect((await readTableColumns(h.db, h.dialect, 'test_fixture')).map((c) => c.name)).toEqual(['id', 'note', 'created_at', 'extra']);
    expect(await h.db.selectFrom('test_fixture' as never).select('note' as never).execute()).toEqual(before);
    const opId = (await currentOp(dataDir)).opId;
    await expect(fsp.stat(path.join(dataDir, 'ops', opId, 'keep'))).rejects.toMatchObject({ code: 'ENOENT' });
    // restore_failed keeps the maintenance flag (spec §9.7).
    expect(await readMaintenance(dataDir)).toMatchObject({ reason: 'update' });
    // A run that ended comes back as it is.
    expect(await createRestoreRunner(deps).step({} as never, run, { opId })).toEqual(run);
  });

  it('begin refuses params the runner cannot run: no skipPreRestore, an unknown targetSchema or field', () => {
    const runner = createRestoreRunner(deps);
    const ok = revertParams(newId());
    expect(runner.begin(ok)).toEqual({ state: 'verifying', params: ok, checkpoint: {}, error: null, progress: 0 });
    expect(() => runner.begin({ ...ok, skipPreRestore: false })).toThrow(TypeError);
    expect(() => runner.begin({ ...ok, skipPreRestore: undefined })).toThrow(TypeError);
    expect(() => runner.begin({ ...ok, targetSchema: 'newest' as never })).toThrow(TypeError);
    expect(() => runner.begin({ ...ok, secrets: 'b' as never })).toThrow(TypeError);
    expect(() => runner.begin({ ...ok, backupId: 'x' })).toThrow(TypeError);
    expect(() => runner.begin({ ...ok, extra: 1 } as never)).toThrow(TypeError);
  });
});
