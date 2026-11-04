import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { decodeBase64Url } from '@altis/crypto';
import {
  BACKUP_SNAPSHOT_LOCK,
  BACKUP_SNAPSHOT_LOCK_MS,
  createOpsMachine,
  openValue,
  readAltisbakHeader,
  readOpFile,
  secretAad,
  snapshotBackupRunning,
  unwrapDek,
  writeSettings,
  type OpsMachine,
} from '@altis/core';
import { PHASE1_MIGRATIONS, claimLock, connect, dropRegisteredTables, runMigrations, withTx } from '@altis/db';
import { dataPath } from '@altis/platform';
import { newId } from '@altis/shared';
import type { BackupRestoreResponse } from '@altis/shared/api/backups';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  preparedArchive,
  seedInstallation,
  serverBackup,
  uploadedArchive,
} from '../../../../packages/core/test/fixtures/restore-support.js';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { createApp, type AppState } from '../../src/app.js';
import type { Config } from '../../src/config.js';
import { csrfKey } from '../../src/http/csrf.js';
import { createOpsFence } from '../../src/http/ops-fence.js';
import { opKinds } from '../../src/jobs/runtime.js';
import { createAgent, type Agent, type AgentReply } from '../agent.js';
import { TEST_KEYRING, seedStaff, sessionCookieFor, sessionCsrfFor } from '../support-auth.js';
import { recordingLogger, sampleConfig } from '../support.js';

// `POST backups/:id/restore` (spec §9.10, §7.3 "konfirmasi tegas"; route catalog `backups.restore`; preflight S6, S18;
// decision C25; plan Task 29) on the engine picked by ALTIS_TEST_DB. The route only begins the `restore` op (its steps
// are Task 22's and 25's tests): `prepare` derives the KEK of an encrypted archive (scrypt, outside any transaction)
// and opens its header, DEK and manifest; a backup without this installation's HMAC needs this library's name typed
// again; then `ops.begin('restore', …, {secret: kek})` and the `altis_ops` cookie → 202 {opId}.
//
// The archives come from "another installation": the test database seeded as installation A (Task 22's fixtures:
// keyring k1, its own session key), backed up and prepared as `.altisbak` files by Task 21's job (one encrypted with
// PASSPHRASE, one not), then the database is set up again as this installation, which registers them as uploaded
// backups (kind external, status uploaded) and makes a server backup of its own.

vi.mock('@altis/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@altis/platform')>();
  // A real probe writes 64 MiB per new DATA_DIR.
  return { ...actual, ensureHeadroom: async () => {} };
});

const ctx = testDbContext();
const SID = '__Host-altis_sid';
const OPS_COOKIE = '__Host-altis_ops';
const BACKUPS = '/api/v1/backups';
const PASSPHRASE = 'frasa sandi pemulihan 2026';
const LIBRARY = 'Perpustakaan Ｔujuan'; // a fullwidth letter: the name is compared after NFKC
const OTHER_INSTALL = newId();

const code = (res: AgentReply): string | undefined => (res.json as { code?: string } | undefined)?.code;

interface Browser {
  agent: Agent;
  csrf: Record<string, string>;
}

describe.skipIf(!ctx.available)(`POST backups/:id/restore [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let root: string;
  let dataDir: string;
  let CONFIG: Config;
  let ORIGIN: string;
  let state: AppState;
  let ops: OpsMachine;
  let app: ReturnType<typeof createApp>;
  /** Another installation's archives (files under root). */
  let encryptedFile: string;
  let plainFile: string;
  /** This installation's backups: its own server backup, the two archives uploaded, and one that failed. */
  let own: string;
  let encrypted: string;
  let plain: string;
  let failed: string;
  let superAdmin: string;
  let reader: string;

  beforeAll(async () => {
    h = await testDb();
    root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-restore-api-')));
    // Installation A: seeded, backed up, its two archives prepared by Task 21's job.
    const sourceDir = path.join(root, 'source');
    await fsp.mkdir(sourceDir);
    await runMigrations(h, { appVersion: '0.1.0', dataDir: sourceDir, migrations: PHASE1_MIGRATIONS });
    const seeded = await seedInstallation(h, { dataDir: sourceDir, installId: OTHER_INSTALL });
    const { backupId: sourceId } = await serverBackup(h, { dataDir: sourceDir, installId: OTHER_INSTALL });
    encryptedFile = await preparedArchive(h, { dataDir: sourceDir, backupId: sourceId, preparedBy: seeded.users[0]!.id, passphrase: PASSPHRASE, into: root });
    await fsp.rm(path.join(sourceDir, 'backups', sourceId, 'downloads'), { recursive: true, force: true });
    plainFile = await preparedArchive(h, { dataDir: sourceDir, backupId: sourceId, preparedBy: seeded.users[0]!.id, passphrase: null, into: root });

    // This installation, on the same database set up again.
    await dropRegisteredTables(h.db, h.dialect);
    dataDir = path.join(root, 'data');
    await fsp.mkdir(dataDir);
    await runMigrations(h, { appVersion: '0.1.0', dataDir, migrations: PHASE1_MIGRATIONS });
    CONFIG = sampleConfig({ db: h.config, keyring: [...TEST_KEYRING] });
    ORIGIN = new URL(CONFIG.baseUrl).origin;
    superAdmin = (await seedStaff(h, { username: 'kepala', roles: [{ key: 'super_admin' }] })).id;
    reader = (await seedStaff(h, { username: 'pembaca', roles: [{ permissions: ['system.backup.read'] }] })).id;
    await withTx(h, (trx) => writeSettings(trx, { 'library.name': LIBRARY }, { keyring: CONFIG.keyring, now: Date.now(), actorId: null }));
    own = (
      await serverBackup(h, { dataDir, installId: CONFIG.install.id, sessionKey: csrfKey(CONFIG), kids: CONFIG.keyring.map((k) => k.kid) })
    ).backupId;
    encrypted = await uploadedArchive(h, dataDir, encryptedFile);
    plain = await uploadedArchive(h, dataDir, plainFile);
    failed = newId();
    await h.db
      .insertInto('backups')
      .values({ id: failed, kind: 'manual', size: null, sha256: null, schema_version: '0009_ops_jobs', app_version: '0.1.0', dialect: h.dialect, consistency: 'frozen', status: 'failed', created_at: Date.now() })
      .execute();
  }, 120_000);

  afterAll(async () => {
    await h?.close();
    if (root !== undefined) await fsp.rm(root, { recursive: true, force: true });
  });

  beforeEach(async () => {
    // Each test begins (at most) one op: the previous one's files go.
    await fsp.rm(path.join(dataDir, 'ops'), { recursive: true, force: true });
    await h.db.deleteFrom('locks').execute();
    build();
  });

  afterEach(async () => {
    await ops?.close();
  });

  /** The app as start() builds it (its own ops machine and ops fence; `fenceMs` between two looks of the fence). */
  function build(o: { fenceMs?: number } = {}): void {
    const log = recordingLogger();
    state = { phase: 'ready', db: h, config: CONFIG };
    ops = createOpsMachine({
      dataDir,
      kinds: opKinds({ appVersion: '0.1.0', config: () => state.config }),
      db: () => h,
      connect: () => connect(h.config, { runtime: 'standalone', purpose: 'cli', dataDir: h.dataDir }),
      keyring: () => CONFIG.keyring,
      clock: () => Date.now(),
      log,
      snapshotBackupRunning: () => snapshotBackupRunning(h, Date.now()),
      appVersion: '0.1.0',
    });
    const opsFence = createOpsFence({ dataDir, intervalMs: o.fenceMs ?? 0, clock: () => Date.now(), onEpoch() {}, onOpEnded() {} });
    app = createApp({ state, version: '0.1.0', buildId: 'b', log, clock: () => Date.now(), env: {}, dataDir, runtime: 'passenger', services: { ops, opsFence } });
  }

  /** A browser signed in as `userId`, re-authenticated just now unless `reauth` is false. */
  async function browser(userId: string, o: { reauth?: boolean } = {}): Promise<Browser> {
    const now = Date.now();
    const token = await sessionCookieFor(h, userId, { now, reauthAt: o.reauth === false ? null : now });
    const agent = createAgent(app, { headers: { origin: ORIGIN } });
    agent.setCookie(SID, token);
    return { agent, csrf: { 'x-csrf-token': sessionCsrfFor(CONFIG, token) } };
  }

  const restore = (b: Browser, backupId: string, body: Record<string, unknown> = {}) => b.agent.post(`${BACKUPS}/${backupId}/restore`, body, b.csrf);

  /** op.json as it is now (null without one). */
  async function opFile() {
    const op = await readOpFile(dataDir);
    if (op === 'corrupt') throw new Error('op.json is corrupt');
    return op;
  }

  /** The begun op: 202 {opId}, the `altis_ops` cookie, op.json's restore in `verifying` and the restore flag. */
  async function begun(res: AgentReply, actor: string) {
    expect(res.status, res.text).toBe(202);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const { opId } = res.json as BackupRestoreResponse;
    expect(res.json).toEqual({ opId: expect.any(String) });
    expect(res.headers.getSetCookie().some((line) => line.startsWith(`${OPS_COOKIE}=`))).toBe(true);
    const op = (await opFile())!;
    expect(op).toMatchObject({ opId, kind: 'restore', state: 'verifying', actor: { type: 'staff', id: actor }, pointOfNoReturn: false });
    const flag = JSON.parse(await fsp.readFile(path.join(dataDir, 'ops', 'maintenance.json'), 'utf8')) as { reason: string; opId: string };
    expect(flag).toMatchObject({ reason: 'restore', opId });
    // No audit entry: the op writes `backup.restore` when it ends (C25).
    expect(await h.db.selectFrom('audit_log').select('id').where('action', '=', 'backup.restore').execute()).toEqual([]);
    return op;
  }

  it('this installation’s own server backup needs no name: 202 {opId}, the op begun (source server, not confirmed)', async () => {
    const b = await browser(superAdmin);
    const op = await begun(await restore(b, own), superAdmin);
    expect(op.params).toEqual({ backupId: own, source: 'server', withoutFiles: false, confirmed: false, targetSchema: 'latest' });
    expect(op.secretParam).toBeUndefined();
  });

  it('no fresh reauth → 401; no permission → 403; unknown → 404; not ok/uploaded → 409 BACKUP_NOT_READY; nothing begun', async () => {
    const stale = await browser(superAdmin, { reauth: false });
    const noReauth = await restore(stale, own);
    expect([noReauth.status, code(noReauth)]).toEqual([401, 'AUTH_REAUTH_REQUIRED']);
    const r = await browser(reader);
    expect((await restore(r, own)).status).toBe(403);
    const b = await browser(superAdmin);
    const unknown = await restore(b, newId());
    expect([unknown.status, code(unknown)]).toEqual([404, 'NOT_FOUND']);
    const notReady = await restore(b, failed);
    expect([notReady.status, code(notReady)]).toEqual([409, 'BACKUP_NOT_READY']);
    const extra = await restore(b, own, { targetSchema: 'latest' });
    expect([extra.status, code(extra)]).toEqual([422, 'VALIDATION_FAILED']);
    expect(await opFile()).toBeNull();
  });

  it('an uploaded external archive: no name → 409 BACKUP_CONFIRM_REQUIRED, a wrong one → 409, the right one (NFKC, trimmed) → begun', async () => {
    const b = await browser(superAdmin);
    const missing = await restore(b, plain);
    expect([missing.status, code(missing)]).toEqual([409, 'BACKUP_CONFIRM_REQUIRED']);
    const wrong = await restore(b, plain, { confirmLibraryName: 'Perpustakaan Lain' });
    expect([wrong.status, code(wrong)]).toEqual([409, 'BACKUP_CONFIRM_REQUIRED']);
    const blank = await restore(b, plain, { confirmLibraryName: '   ' });
    expect([blank.status, code(blank)]).toEqual([409, 'BACKUP_CONFIRM_REQUIRED']);
    expect(await opFile()).toBeNull();
    const op = await begun(await restore(b, plain, { confirmLibraryName: '  Perpustakaan Tujuan ', withoutFiles: true }), superAdmin);
    expect(op.params).toEqual({ backupId: plain, source: 'archive', withoutFiles: true, confirmed: true, targetSchema: 'latest' });
    expect(op.secretParam).toBeUndefined();
  });

  it('an encrypted archive: no passphrase → 422 BACKUP_PASSPHRASE_REQUIRED, a wrong one → 422 BACKUP_PASSPHRASE_INVALID; the KEK goes to the op', async () => {
    const b = await browser(superAdmin);
    const none = await restore(b, encrypted, { confirmLibraryName: LIBRARY });
    expect([none.status, code(none)]).toEqual([422, 'BACKUP_PASSPHRASE_REQUIRED']);
    const wrong = await restore(b, encrypted, { passphrase: 'frasa sandi yang salah', confirmLibraryName: LIBRARY });
    expect([wrong.status, code(wrong)]).toEqual([422, 'BACKUP_PASSPHRASE_INVALID']);
    // One shorter than any passphrase prepare-download accepts is just as wrong (not a generic validation error).
    const short = await restore(b, encrypted, { passphrase: 'pendek', confirmLibraryName: LIBRARY });
    expect([short.status, code(short)]).toEqual([422, 'BACKUP_PASSPHRASE_INVALID']);
    // The archive's HMAC is another installation's: the name is needed once the manifest is open.
    const unconfirmed = await restore(b, encrypted, { passphrase: PASSPHRASE });
    expect([unconfirmed.status, code(unconfirmed)]).toEqual([409, 'BACKUP_CONFIRM_REQUIRED']);
    expect(await opFile()).toBeNull();

    const op = await begun(await restore(b, encrypted, { passphrase: PASSPHRASE, confirmLibraryName: LIBRARY }), superAdmin);
    expect(op.params).toEqual({ backupId: encrypted, source: 'archive', withoutFiles: false, confirmed: true, targetSchema: 'latest' });
    expect(JSON.stringify(op)).not.toContain(PASSPHRASE);
    // The op keeps the KEK (sealed with this installation's keyring), never the passphrase: it unwraps the DEK.
    const kek = decodeBase64Url(openValue(CONFIG.keyring, secretAad('ops', 'secret_param', op.opId), op.secretParam!))!;
    const header = await readAltisbakHeader(dataPath(dataDir, 'backups', encrypted, 'archive.altisbak'));
    expect(unwrapDek(kek, header.encryption!.dek).byteLength).toBe(32);
  });

  it('another op in progress → 409 OPS_IN_PROGRESS (a fence that has not looked again yet); nothing replaced', async () => {
    build({ fenceMs: 60_000 });
    const b = await browser(superAdmin);
    expect((await b.agent.get(BACKUPS)).status).toBe(200); // the fence looks: no op, no flag
    const other = await ops.begin('migrate', { type: 'cli', id: null }, {});
    const res = await restore(b, own);
    expect([res.status, code(res)]).toEqual([409, 'OPS_IN_PROGRESS']);
    expect(await opFile()).toMatchObject({ opId: other.opId, kind: 'migrate' });
    expect(res.headers.getSetCookie().some((line) => line.startsWith(`${OPS_COOKIE}=`))).toBe(false);
  });

  it('a snapshot backup running → 409 OPS_BLOCKED_BY_BACKUP before anything is written', async () => {
    expect(await claimLock(h, BACKUP_SNAPSHOT_LOCK, 'job:01JAAAAAAAAAAAAAAAAAAAAAAA', BACKUP_SNAPSHOT_LOCK_MS)).toBe(true);
    const b = await browser(superAdmin);
    const res = await restore(b, own);
    expect([res.status, code(res)]).toEqual([409, 'OPS_BLOCKED_BY_BACKUP']);
    expect(await opFile()).toBeNull();
    await expect(fsp.stat(path.join(dataDir, 'ops', 'maintenance.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
