import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import {
  SCHEDULES,
  backupPrepareDownloadJob,
  claimById,
  createJobRegistry,
  deriveDownloadKey,
  enqueuePrepareDownload,
  hotp,
  preparedDownloadPath,
  randomToken,
  readSecret,
  runSlice,
  seedSchedules,
  totpStep,
  txCtx,
  writeSettings,
  type BackupManifest,
  type OpStatus,
  type OpsMachine,
} from '@altis/core';
import { PHASE1_MIGRATIONS, connect, migrationsUpTo, runMigrations, withTx, type DbHandle } from '@altis/db';
import { uploadPath } from '@altis/platform';
import { newId } from '@altis/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startFakeSmtp } from '../../../../packages/core/test/fake-smtp.js';
import { MAILPIT_SMTP, mailpit, mailpitMode } from '../../../../packages/core/test/mailpit.js';
import { loadedChecksums, manifestChecksums, serverBackup } from '../../../../packages/core/test/fixtures/restore-support.js';
import { testDbContext, testDbFor, type TestDbHandle, type TestEngine } from '../../../../tools/test/test-db.js';
import { createApp, type AppState } from '../../src/app.js';
import { runCli } from '../../src/cli/index.js';
import { loadConfig, writeConfig, type Config } from '../../src/config.js';
import { csrfKey, preSessionCsrfToken } from '../../src/http/csrf.js';
import { createOpsFence } from '../../src/http/ops-fence.js';
import { opKinds } from '../../src/jobs/runtime.js';
import { createAppOps } from '../../src/services.js';
import { createAgent, type AgentReply } from '../agent.js';
import { captureIo } from '../cli-support.js';
import { seedStaff, sessionCookieFor, sessionCsrfFor, type SeededStaff } from '../support-auth.js';
import { bootContext, recordingLogger, sampleConfig } from '../support.js';

// The cross-dialect restore matrix (spec §9.10, §12.3 "semua 12 pasangan restore", acceptance A6; plan Task 29). A
// backup is made on the engine ALTIS_TEST_DB_SOURCE names (default: the same engine) and restored into the engine
// ALTIS_TEST_DB names, each a whole installation of its own (DATA_DIR, keyring, session key, database; testDbFor,
// preflight M37), through the real route `POST backups/:id/restore` and the `restore` op of the server (on SQLite with
// Task 25's work file and swap):
//
// 1. A source seeded with fixed data (branches, staff with TOTP, an SMTP password, 3 uploaded files, 1000 audit rows),
//    backed up with its files and prepared by Task 21's job as an `.altisbak` encrypted with a passphrase, then
//    restored into the target as another installation's archive (passphrase and library name): every data checksum
//    equals the backup's, a staff member signs in with password and TOTP, the e-mail test goes out with the restored
//    SMTP password (mailpit when the run asks for it, ALTIS_TEST_MAILPIT_REQUIRED=1 in CI; the in-process SMTP server,
//    which checks the password, otherwise), every file comes back with its SHA-256, and the 1000 audit rows are kept
//    beside the backup (`imported-audit_log.jsonl.gz`).
// 2. A source at `0008_access_indexes` restored into a target at `0009_ops_jobs`: the load stops at the archive's
//    schema and `migrating` applies 0009 (the older-schema path; 1d's release fixtures repeat it across releases).
//    Another installation's backup without a passphrase: secrets branch c (TOTP to re-enrol).
// 3. Target engine only: `secrets:rotate` (Task 24) between a backup and its restore in the same installation: secrets
//    branch a still applies, because the old kid stays in the keyring.

vi.mock('@altis/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@altis/platform')>();
  // A real probe writes 64 MiB per new DATA_DIR.
  return { ...actual, ensureHeadroom: async () => {} };
});

const ctx = testDbContext();
const TARGET: TestEngine = ctx.engine;
const SOURCE: TestEngine = ctx.source ?? ctx.engine;
const READY = ctx.available && (ctx.source === null || ctx.sourceAvailable);
const LABEL = READY
  ? `${SOURCE} → ${TARGET}`
  : `${SOURCE} → ${TARGET}, SKIPPED: ${(!ctx.available ? ctx.reason : ctx.sourceReason) ?? 'not available'}`;

const LATEST = Object.keys(PHASE1_MIGRATIONS).sort().at(-1)!;
const OLDER = '0008_access_indexes';
const PASSPHRASE = 'frasa sandi matriks pemulihan';
const SMTP_USER = 'surel-perpus';
const SMTP_PASSWORD = 'sandi-smtp-matriks-2026';
const SOURCE_LIBRARY = 'Perpustakaan Sumber';
const TARGET_LIBRARY = 'Perpustakaan Tujuan';
const AUDIT_ROWS = 1000;
const BACKUPS = '/api/v1/backups';
const SID = '__Host-altis_sid';
const CSRF = '__Host-altis_csrf';
const silent = { info() {}, warn() {}, error() {} };

const sha256 = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex');
const code = (res: AgentReply): string | undefined => (res.json as { code?: string } | undefined)?.code;

/** Where the e-mail test goes: mailpit when the run asks for it, else the in-process SMTP server with a login. */
interface MailSink {
  smtp: { host: string; port: number };
  subjectsTo(to: string): Promise<string[]>;
  close(): Promise<void>;
}

async function openSink(): Promise<MailSink> {
  const mode = mailpitMode();
  if (mode !== 'off') {
    const mp = mailpit();
    const up = await mp.available();
    if (!up && mode === 'required') throw new Error('mailpit does not answer, and ALTIS_TEST_MAILPIT_REQUIRED=1 requires it');
    if (up) {
      return {
        smtp: { ...MAILPIT_SMTP },
        subjectsTo: async (to) => (await mp.messages()).filter((m) => m.to.includes(to)).map((m) => m.subject),
        close: async () => undefined,
      };
    }
  }
  // It offers AUTH and accepts only the source's credentials: the restored password must open to exactly them.
  const fake = await startFakeSmtp({ auth: { user: SMTP_USER, pass: SMTP_PASSWORD } });
  return {
    smtp: { host: '127.0.0.1', port: fake.port },
    subjectsTo: async (to) => fake.messages.filter((m) => m.to.includes(to) && m.user === SMTP_USER).map((m) => /^Subject: (.*)$/m.exec(m.data)?.[1] ?? ''),
    close: () => fake.close(),
  };
}

/** A staff member of the source (TOTP enabled), as the target must let them sign in after the restore. */
interface Person extends SeededStaff {
  username: string;
}

/** What a source installation leaves behind: its backup (files on disk) and what a restore must bring back. */
interface Source {
  dataDir: string;
  config: Config;
  backupId: string;
  manifest: BackupManifest;
  /** The archive prepared from it (passphrase), or null. */
  archive: string | null;
  people: Person[];
  files: { id: string; content: Buffer }[];
}

describe.skipIf(!READY)(`restore matrix [${LABEL}]`, () => {
  let root: string;
  let sink: MailSink;

  beforeAll(async () => {
    root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-restore-matrix-')));
    sink = await openSink();
  });

  afterAll(async () => {
    await sink?.close();
    if (root !== undefined) await fsp.rm(root, { recursive: true, force: true });
  });

  /** The fixed data of an installation in `h` (its schema migrated); its staff with TOTP and its uploaded files. */
  async function seed(h: DbHandle, dataDir: string, config: Config, o: { library: string }): Promise<{ people: Person[]; files: Source['files'] }> {
    const now = Date.now();
    const people: Person[] = [];
    for (const [username, key] of [['kepala_sumber', 'super_admin'], ['staf_sumber', 'admin']] as const) {
      const staff = await seedStaff(h, { username, password: `sandi-${username}-2026`, roles: [{ key }], totp: true, keyring: config.keyring, now });
      people.push({ ...staff, username });
    }
    await seedStaff(h, { username: 'tamu_sumber', roles: [{ permissions: ['system.backup.read'] }], now });
    const files: Source['files'] = [];
    await withTx(h, async (trx) => {
      await seedSchedules(trx, now, 'Asia/Jakarta', SCHEDULES);
      await writeSettings(
        trx,
        {
          'library.name': o.library,
          'smtp.host': sink.smtp.host,
          'smtp.port': sink.smtp.port,
          'smtp.security': 'none',
          'smtp.username': SMTP_USER,
          'smtp.password': SMTP_PASSWORD,
          'smtp.from': 'perpus@sumber.test',
        },
        { keyring: config.keyring, now, actorId: null },
      );
      for (let i = 0; i < 3; i += 1) {
        await trx
          .insertInto('branches')
          .values({
            id: newId(now),
            code_key: `cb${i}`,
            code_display: `CB${i}`,
            name: `Cabang ${['Utara', 'Selatan', 'Tengah'][i]} ✓`,
            address: i === 0 ? null : `Jalan Merdeka ${i}`,
            timezone: 'Asia/Jakarta',
            is_default: i === 0 ? 1 : 0,
            version: 1,
            created_at: now,
            updated_at: now,
          })
          .execute();
      }
      for (let i = 0; i < 3; i += 1) {
        const id = newId(now);
        const content = Buffer.from(`berkas unggahan ${i}: ${'isi '.repeat(100 * (i + 1))}\n`);
        files.push({ id, content });
        await trx
          .insertInto('files')
          .values({ id, original_name: `berkas-${i}.txt`, mime: 'text/plain', size: content.byteLength, sha256: sha256(content), context: 'test', access: 'staff', status: 'ok', created_at: now })
          .execute();
      }
      await trx.updateTable('schema_meta').set({ install_id: config.install.id }).where('id', '=', 1).execute();
    });
    for (const f of files) {
      const file = uploadPath(dataDir, f.id);
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await fsp.writeFile(file, f.content);
    }
    for (let batch = 0; batch < AUDIT_ROWS / 100; batch += 1) {
      await withTx(h, async (trx) => {
        for (let i = 0; i < 100; i += 1) {
          await txCtx(trx, now, { type: 'system', id: null, ip: null }).audit({ action: 'audit.purge', entity: 'audit_log', entityId: null, meta: { seed: batch * 100 + i } });
        }
      });
    }
    return { people, files };
  }

  /** The `.altisbak` of `backupId`, prepared by Task 21's job for `preparedBy` with PASSPHRASE, copied out of DATA_DIR. */
  async function prepareArchive(h: DbHandle, dataDir: string, config: Config, backupId: string, preparedBy: string): Promise<string> {
    const deps = { dataDir, keyring: config.keyring, sessionKey: csrfKey(config) };
    const reg = createJobRegistry([backupPrepareDownloadJob(() => deps)]);
    const key = await deriveDownloadKey(PASSPHRASE);
    const { jobId } = await withTx(h, (trx) =>
      enqueuePrepareDownload(trx, { backupId, preparedBy, superAdmin: true, key, now: Date.now(), keyring: config.keyring }),
    );
    for (let i = 0; i < 500; i += 1) {
      const job = await claimById(h, reg, jobId, { worker: 'matrix', now: Date.now() });
      if (job === null) break;
      const r = await runSlice(h, reg, job, { mode: 'cron_cli', budgetMs: 20_000, keyring: config.keyring, log: silent, clock: () => Date.now(), env: {} });
      if (r.outcome !== 'continued') break;
    }
    const copy = path.join(root, `${newId()}.altisbak`);
    await fsp.copyFile(preparedDownloadPath(dataDir, backupId, preparedBy, 'archive.altisbak'), copy);
    return copy;
  }

  /** A source installation on SOURCE at `schemaVersion`, seeded and backed up (with its files); its handle closed. */
  async function makeSource(o: { schemaVersion?: string; archive: boolean }): Promise<Source> {
    const dataDir = await fsp.mkdtemp(path.join(root, 'source-'));
    const h: TestDbHandle = await testDbFor(SOURCE, { dataDir });
    try {
      const migrations = o.schemaVersion === undefined ? PHASE1_MIGRATIONS : migrationsUpTo(PHASE1_MIGRATIONS, o.schemaVersion);
      await runMigrations(h, { appVersion: '0.1.0', dataDir, migrations });
      const config = sampleConfig({ db: h.config });
      const { people, files } = await seed(h, dataDir, config, { library: SOURCE_LIBRARY });
      const { backupId, manifest } = await serverBackup(h, {
        dataDir,
        installId: config.install.id,
        sessionKey: csrfKey(config),
        kids: config.keyring.map((k) => k.kid),
        includeFiles: true,
      });
      const archive = o.archive ? await prepareArchive(h, dataDir, config, backupId, people[0]!.id) : null;
      return { dataDir, config, backupId, manifest, archive, people, files };
    } finally {
      await h.close();
    }
  }

  /** A target installation on TARGET: config.json, its own super admin and library name, the server's ops machine. */
  async function makeTarget() {
    const dataDir = await fsp.mkdtemp(path.join(root, 'target-'));
    const first = await testDbFor(TARGET, { dataDir });
    await runMigrations(first, { appVersion: '0.1.0', dataDir, migrations: PHASE1_MIGRATIONS });
    const config = sampleConfig({ db: first.config });
    await writeConfig(dataDir, config);
    const admin = await seedStaff(first, { username: 'kepala_tujuan', roles: [{ key: 'super_admin' }], keyring: config.keyring });
    await withTx(first, async (trx) => {
      await writeSettings(trx, { 'library.name': TARGET_LIBRARY }, { keyring: config.keyring, now: Date.now(), actorId: null });
      await trx.updateTable('schema_meta').set({ install_id: config.install.id }).where('id', '=', 1).execute();
    });
    const log = recordingLogger();
    const state: AppState = { phase: 'ready', db: first, config };
    let offset = 0;
    // As start() does on SQLite (Task 25): this process lets go of the live file for the swap and opens it again.
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
      version: '0.1.0',
      log,
      clock: () => Date.now() + offset,
      runtime: 'standalone',
      kinds: opKinds({ appVersion: '0.1.0', config: () => state.config, dataDir, sqlite: { log, own } }),
    });
    const app = () =>
      createApp({
        state,
        version: '0.1.0',
        buildId: 'matrix',
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
      state,
      admin: admin.id,
      app,
      db,
      async close(): Promise<void> {
        await ops.close();
        await state.db?.close();
        state.db = undefined;
      },
      /**
       * POST backups/:id/restore as the target's super admin (re-authenticated just now), then the op stepped by the
       * server's machine until it ends (the freeze's 3 s skipped on its clock).
       */
      async restore(backupId: string, body: Record<string, unknown>): Promise<{ opId: string; status: OpStatus }> {
        const token = await sessionCookieFor(db(), admin.id, { reauthAt: Date.now() });
        const agent = createAgent(app(), { headers: { origin: new URL(config.baseUrl).origin } });
        agent.setCookie(SID, token);
        const res = await agent.post(`${BACKUPS}/${backupId}/restore`, body, { 'x-csrf-token': sessionCsrfFor(config, token) });
        expect(res.status, res.text).toBe(202);
        const { opId } = res.json as { opId: string };
        offset += 4000;
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

  type Target = Awaited<ReturnType<typeof makeTarget>>;

  /** A browser of the target signed in as `p` with the password and a TOTP code; `send` posts with its CSRF token. */
  async function signIn(t: Target, p: Person) {
    const config = t.state.config!;
    const agent = createAgent(t.app(), { peer: '203.0.113.20', headers: { origin: new URL(config.baseUrl).origin } });
    const value = randomToken(32);
    agent.setCookie(CSRF, value);
    let csrf = preSessionCsrfToken(csrfKey(config), value);
    const send = async (p2: string, body: unknown): Promise<AgentReply> => {
      const res = await agent.post(p2, body, { 'x-csrf-token': csrf });
      const next = res.headers.get('x-csrf-token');
      if (next !== null) csrf = next;
      return res;
    };
    const login = await send('/api/v1/auth/login', { username: p.username, password: p.password });
    expect(login.status, login.text).toBe(200);
    expect(login.json).toMatchObject({ stage: 'mfa' });
    const step = totpStep(Date.now());
    const verify = await send('/api/v1/auth/2fa/verify', { code: hotp(p.totpSecret!, step, 6) });
    expect(verify.status, verify.text).toBe(200);
    expect(verify.json).toMatchObject({ stage: 'full' });
    return { send, step };
  }

  /** The lines of the history part the restore kept beside the backup (`backups/<id>/imported-<table>.jsonl.gz`). */
  async function importedRows(dataDir: string, backupId: string, table: string): Promise<number> {
    const bytes = gunzipSync(await fsp.readFile(path.join(dataDir, 'backups', backupId, `imported-${table}.jsonl.gz`)));
    return bytes.toString('utf8').split('\n').filter((line) => line !== '').length;
  }

  it(
    'another installation’s passphrase archive: checksums, TOTP sign-in, the e-mail test, files and the 1000 audit rows',
    async () => {
      const source = await makeSource({ archive: true });
      expect(source.manifest.tables['audit_log']!.rows).toBeGreaterThanOrEqual(AUDIT_ROWS);
      const t = await makeTarget();
      try {
        // The archive uploaded to the target (Task 21's registration: kind external, status uploaded).
        const backupId = newId();
        const file = path.join(t.dataDir, 'backups', backupId, 'archive.altisbak');
        await fsp.mkdir(path.dirname(file), { recursive: true });
        await fsp.copyFile(source.archive!, file);
        const bytes = await fsp.readFile(file);
        await t
          .db()
          .db.insertInto('backups')
          .values({ id: backupId, kind: 'external', size: bytes.byteLength, sha256: sha256(bytes), schema_version: LATEST, app_version: '0.1.0', dialect: source.manifest.dialect, consistency: 'frozen', status: 'uploaded', created_at: Date.now() })
          .execute();

        await t.restore(backupId, { passphrase: PASSPHRASE, confirmLibraryName: TARGET_LIBRARY });

        const skip = ['notifications'];
        expect(await loadedChecksums(t.db(), source.manifest, skip)).toEqual(manifestChecksums(source.manifest, skip));
        expect(await t.db().db.selectFrom('schema_meta').select('install_id').execute()).toEqual([{ install_id: t.state.config!.install.id }]);
        const audit = await t.db().db.selectFrom('audit_log').select(['entity_id', 'meta']).where('action', '=', 'backup.restore').executeTakeFirstOrThrow();
        expect(audit.entity_id).toBe(backupId);
        expect(JSON.parse(audit.meta)).toMatchObject({ secretsBranch: 'b', sourceInstallId: source.config.install.id, archiveSha256: sha256(bytes), outcome: 'done' });
        // The files, from the archive's blobs, with their SHA-256.
        for (const f of source.files) expect(sha256(await fsp.readFile(uploadPath(t.dataDir, f.id)))).toBe(sha256(f.content));
        // The source's audit log, kept beside the backup (history is never loaded over the target's own).
        expect(await importedRows(t.dataDir, backupId, 'audit_log')).toBe(source.manifest.tables['audit_log']!.rows);

        // A staff member of the source signs in with the password and TOTP (secrets re-sealed with the target's keyring).
        const boss = source.people[0]!;
        const { send, step } = await signIn(t, boss);
        // The e-mail test, through the SMTP settings and the password the restore brought.
        expect((await send('/api/v1/auth/reauth', { password: boss.password, code: hotp(boss.totpSecret!, step + 1, 6) })).status).toBe(200);
        const to = `uji-${newId().toLowerCase()}@perpus.test`;
        const mail = await send('/api/v1/system/config/email-test', { to });
        expect([mail.status, mail.json], mail.text).toEqual([200, { sent: true }]);
        expect(await sink.subjectsTo(to)).toHaveLength(1);
        expect(await readSecret(t.db().db, 'smtp.password', t.state.config!.keyring)).toBe(SMTP_PASSWORD);
      } finally {
        await t.close();
      }
    },
    240_000,
  );

  it(
    `an archive at ${OLDER} into a database at ${LATEST}: migrating applies the newer migration (branch c, no passphrase)`,
    async () => {
      const source = await makeSource({ schemaVersion: OLDER, archive: false });
      expect(source.manifest.schemaVersion).toBe(OLDER);
      const t = await makeTarget();
      try {
        // The source's backup folder (and its blobs) brought over as another installation's server backup.
        await fsp.cp(path.join(source.dataDir, 'backups', source.backupId), path.join(t.dataDir, 'backups', source.backupId), { recursive: true });
        await fsp.cp(path.join(source.dataDir, 'backups', 'blobs'), path.join(t.dataDir, 'backups', 'blobs'), { recursive: true });
        const manifestBytes = await fsp.readFile(path.join(t.dataDir, 'backups', source.backupId, 'manifest.json'));
        await t
          .db()
          .db.insertInto('backups')
          .values({ id: source.backupId, kind: 'external', size: manifestBytes.byteLength, sha256: sha256(manifestBytes), schema_version: OLDER, app_version: '0.1.0', dialect: source.manifest.dialect, consistency: 'frozen', status: 'ok', created_at: Date.now() })
          .execute();
        const refused = await (async () => {
          const token = await sessionCookieFor(t.db(), t.admin, { reauthAt: Date.now() });
          const agent = createAgent(t.app(), { headers: { origin: new URL(t.state.config!.baseUrl).origin } });
          agent.setCookie(SID, token);
          return agent.post(`${BACKUPS}/${source.backupId}/restore`, {}, { 'x-csrf-token': sessionCsrfFor(t.state.config!, token) });
        })();
        expect([refused.status, code(refused)]).toEqual([409, 'BACKUP_CONFIRM_REQUIRED']);

        await t.restore(source.backupId, { confirmLibraryName: TARGET_LIBRARY });

        // Branch c changes staff_users on purpose (`totp_reenroll`, below); every other table equals the backup.
        const skip = ['notifications', 'staff_users'];
        expect(await loadedChecksums(t.db(), source.manifest, skip)).toEqual(manifestChecksums(source.manifest, skip));
        expect((await t.db().db.selectFrom('staff_users').select('id').execute()).length).toBe(source.manifest.tables['staff_users']!.rows);
        // The load stopped at 0008; `migrating` brought the database to this release's schema.
        expect(await t.db().db.selectFrom('schema_meta').select('schema_version').execute()).toEqual([{ schema_version: LATEST.split('_')[0] }]);
        expect(await t.db().db.selectFrom('jobs').select('point_of_no_return').limit(1).execute()).toEqual([]);
        expect((await t.db().db.selectFrom('schema_migrations').select('name').where('name', '=', LATEST).execute()).length).toBe(1);
        // Another installation without a passphrase: the TOTP secrets could not come along (branch c), re-enrolment.
        const people = await t.db().db.selectFrom('staff_users').select(['id', 'totp_secret_enc', 'totp_reenroll']).where('id', 'in', source.people.map((p) => p.id)).execute();
        expect(people.map((p) => [p.totp_secret_enc, Number(p.totp_reenroll)])).toEqual([
          [null, 1],
          [null, 1],
        ]);
        for (const f of source.files) expect(sha256(await fsp.readFile(uploadPath(t.dataDir, f.id)))).toBe(sha256(f.content));
        const audit = await t.db().db.selectFrom('audit_log').select('meta').where('action', '=', 'backup.restore').executeTakeFirstOrThrow();
        expect(JSON.parse(audit.meta)).toMatchObject({ secretsBranch: 'c', outcome: 'done' });
      } finally {
        await t.close();
      }
    },
    240_000,
  );

  it(
    `[${TARGET} only] secrets:rotate between a backup and its restore: branch a still applies (the old kid stays)`,
    async () => {
      const t = await makeTarget();
      try {
        const config = t.state.config!;
        const { people } = await seed(t.db(), t.dataDir, config, { library: TARGET_LIBRARY });
        const { backupId } = await serverBackup(t.db(), {
          dataDir: t.dataDir,
          installId: config.install.id,
          sessionKey: csrfKey(config),
          kids: config.keyring.map((k) => k.kid),
          includeFiles: true,
        });
        const io = captureIo({ HOME: root });
        const rotated = await runCli(['secrets:rotate', '--json'], bootContext(t.dataDir), io);
        expect([rotated, io.err]).toEqual([0, '']);
        const after = (await loadConfig(t.dataDir, {}))!;
        expect(after.keyring.map((k) => k.kid)).toEqual([config.keyring[0]!.kid, (JSON.parse(io.out) as { kid: string }).kid]);
        t.state.config = after;

        await t.restore(backupId, {});

        const audit = await t.db().db.selectFrom('audit_log').select('meta').where('action', '=', 'backup.restore').executeTakeFirstOrThrow();
        expect(JSON.parse(audit.meta)).toMatchObject({ secretsBranch: 'a', outcome: 'done' });
        // The values the backup held, sealed with the old kid, still open: TOTP and the SMTP password.
        expect(await readSecret(t.db().db, 'smtp.password', after.keyring)).toBe(SMTP_PASSWORD);
        await signIn(t, people[1]!);
      } finally {
        await t.close();
      }
    },
    240_000,
  );
});
