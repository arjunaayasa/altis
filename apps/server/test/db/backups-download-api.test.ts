import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  base32Encode,
  cleanFiles,
  columnKey,
  createExporter,
  createOpsMachine,
  openAltisbak,
  openAltisbakWriter,
  openArchiveValue,
  readManifest,
  recordRun,
  secretAad,
  snapshotBackupRunning,
  writeSettings,
  type AltisbakHeader,
  type ExportCheckpoint,
  type OpsMachine,
} from '@altis/core';
import { PHASE1_MIGRATIONS, connect, runMigrations, withTx } from '@altis/db';
import { dataPath } from '@altis/platform';
import type { BackupItem } from '@altis/shared/api/backups';
import { newId } from '@altis/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { createApp, type AppState } from '../../src/app.js';
import type { Config } from '../../src/config.js';
import { csrfKey } from '../../src/http/csrf.js';
import { createOpsFence } from '../../src/http/ops-fence.js';
import { createJobRuntime, jobHandlers, opKinds, type JobRuntime } from '../../src/jobs/runtime.js';
import { createAgent, type Agent } from '../agent.js';
import { TEST_KEYRING, seedStaff, sessionCookieFor, sessionCsrfFor } from '../support-auth.js';
import { recordingLogger, sampleConfig } from '../support.js';

// Preparing, downloading and uploading backup archives (spec §9.9 "Download", §9.10; route catalog
// `backups.prepare_download|download|upload`; decisions C14, C15; preflight M4, M18, S15; plan Task 21) on the engine
// picked by ALTIS_TEST_DB: the preparation route derives the KEK before its transaction and queues the job (one
// `backup.download` audit entry), the job is driven to the subject's own archive, which only that subject downloads
// (whole or by one byte range, 416 past its end), the folder goes 5 minutes after the last byte or an hour after it was
// ready; an archive made by another installation is uploaded through the chunked upload routes and becomes an
// `external` backup.

vi.mock('@altis/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@altis/platform')>();
  // A real probe writes 64 MiB per new DATA_DIR.
  return { ...actual, ensureHeadroom: async () => {} };
});

const ctx = testDbContext();
/** In the past: an audit or event row may not be dated ahead of the real clock. */
const NOW = Date.UTC(2026, 9, 21, 9, 0, 5);
const SID = '__Host-altis_sid';
const BACKUPS = '/api/v1/backups';
const UPLOADS = '/api/v1/files/uploads';
const PASSPHRASE = 'frasa sandi unduhan 2026';
const SMTP_PASSWORD = 'sandi-surel-rahasia';
const SCHEMA_VERSION = Object.keys(PHASE1_MIGRATIONS).sort().at(-1)!;
const MIN = 60_000;

const code = (res: { json: unknown }): string | undefined => (res.json as { code?: string } | undefined)?.code;
const reason = (res: { json: unknown }): string | undefined => (res.json as { reason?: string } | undefined)?.reason;
const sha = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex');

interface Browser {
  agent: Agent;
  csrf: Record<string, string>;
  token: string;
  userId: string;
}

describe.skipIf(!ctx.available)(`backup download and upload routes [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let root: string;
  let dataDir: string;
  let now: number;
  let state: AppState;
  let ops: OpsMachine;
  let runtime: JobRuntime | undefined;
  let app: ReturnType<typeof createApp>;
  let CONFIG: Config;
  let ORIGIN: string;
  let backupId: string;
  let superA: { id: string; totpSecret?: Uint8Array };
  let superB: string;
  let downloader: string;
  let reader: string;
  /** The last audit seq before the running test: each test counts its own entries. */
  let startSeq: number;

  beforeAll(async () => {
    h = await testDb();
    CONFIG = sampleConfig({ db: h.config, keyring: [...TEST_KEYRING] });
    ORIGIN = new URL(CONFIG.baseUrl).origin;
    root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-backups-download-')));
    await runMigrations(h, { appVersion: '0.1.0', dataDir: path.join(root, 'mig'), migrations: PHASE1_MIGRATIONS });
    superA = await seedStaff(h, { username: 'kepala', roles: [{ key: 'super_admin' }], totp: true, now: NOW });
    superB = (await seedStaff(h, { username: 'wakil', roles: [{ key: 'super_admin' }], now: NOW })).id;
    downloader = (await seedStaff(h, { username: 'pengunduh', roles: [{ permissions: ['system.backup.download'] }], now: NOW })).id;
    reader = (await seedStaff(h, { username: 'pembaca', roles: [{ permissions: ['system.backup.read'] }], now: NOW })).id;
    await withTx(h, (trx) =>
      writeSettings(trx, { 'smtp.host': 'mail.example.test', 'smtp.username': 'surel', 'smtp.password': SMTP_PASSWORD }, { keyring: CONFIG.keyring, now: NOW, actorId: null }),
    );

    dataDir = path.join(root, 'data');
    await fsp.mkdir(dataDir);
    backupId = newId(NOW - 60 * MIN);
    const exporter = createExporter({
      read: h.db,
      dialect: h.dialect,
      dataDir,
      backupId,
      kind: 'manual',
      includeFiles: false,
      consistency: 'frozen',
      appVersion: '0.1.0',
      schemaVersion: SCHEMA_VERSION,
      installId: CONFIG.install.id,
      sessionKey: csrfKey(CONFIG),
      kids: CONFIG.keyring.map((k) => k.kid),
      auditHead: { seq: 0, hash: '0'.repeat(64) },
      clock: () => Date.now(),
    });
    let checkpoint: ExportCheckpoint | null = null;
    for (let i = 0; i < 1000; i += 1) {
      const r = await exporter.step(checkpoint, { deadline: Date.now() + 60_000 });
      checkpoint = r.checkpoint;
      if (r.done) break;
    }
    await h.db
      .insertInto('backups')
      .values({ id: backupId, kind: 'manual', size: 1, sha256: null, schema_version: SCHEMA_VERSION, app_version: '0.1.0', dialect: h.dialect, consistency: 'frozen', status: 'ok', created_at: NOW - 60 * MIN })
      .execute();
  }, 60_000);

  afterAll(async () => {
    await h?.close();
    if (root !== undefined) await fsp.rm(root, { recursive: true, force: true });
  });

  beforeEach(async () => {
    for (const table of ['jobs', 'locks', 'events', 'notifications', 'sessions', 'upload_sessions'] as const) await h.db.deleteFrom(table).execute();
    await h.db.deleteFrom('backups').where('id', '!=', backupId).execute();
    await fsp.rm(path.join(dataDir, 'backups', backupId, 'downloads'), { recursive: true, force: true });
    now = NOW;
    // A cron run "just now": no piggyback slice runs a job in the background after a response, so each test drives its
    // jobs itself and a job stays live until it does.
    await recordRun(h, 'cron_http', NOW, { dataDir });
    startSeq = Number((await h.db.selectFrom('audit_head').select('last_seq').where('id', '=', 1).executeTakeFirst())?.last_seq ?? 0);
    build();
  });

  afterEach(async () => {
    await runtime?.stop();
    await ops?.close();
  });

  /** The app as start() builds it on passenger (no worker loop), with its job runtime. */
  function build(): void {
    const log = recordingLogger();
    state = { phase: 'ready', db: h, config: CONFIG };
    ops = createOpsMachine({
      dataDir,
      kinds: opKinds({ appVersion: '0.1.0', config: () => state.config }),
      db: () => h,
      connect: () => connect(h.config, { runtime: 'standalone', purpose: 'cli', dataDir: h.dataDir }),
      keyring: () => CONFIG.keyring,
      clock: () => now,
      log,
      snapshotBackupRunning: () => snapshotBackupRunning(h, Date.now()),
      appVersion: '0.1.0',
    });
    runtime = createJobRuntime({
      state,
      runtime: 'passenger',
      env: {},
      dataDir,
      log,
      clock: () => now,
      ops,
      handlers: jobHandlers(),
      requestRestart: async () => {},
      installId: CONFIG.install.id,
      appVersion: '0.1.0',
    });
    state.jobs = runtime;
    const opsFence = createOpsFence({ dataDir, intervalMs: 0, clock: () => now, onEpoch() {}, onOpEnded() {} });
    app = createApp({ state, version: '0.1.0', buildId: 'b', log, clock: () => now, env: {}, dataDir, runtime: 'passenger', services: { ops, opsFence } });
  }

  /** A browser signed in as `userId`, re-authenticated now unless `reauth` is false. */
  async function browser(userId: string, o: { reauth?: boolean } = {}): Promise<Browser> {
    const token = await sessionCookieFor(h, userId, { now, reauthAt: o.reauth === false ? null : now });
    const agent = createAgent(app, { headers: { origin: ORIGIN } });
    agent.setCookie(SID, token);
    return { agent, csrf: { 'x-csrf-token': sessionCsrfFor(CONFIG, token) }, token, userId };
  }

  /** A GET of the download (or any path) with the browser's cookie; the body as bytes. */
  async function fetchBytes(b: Browser, p: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: Headers; bytes: Buffer; json: unknown }> {
    const res = await app.request(
      p,
      { method: 'GET', headers: new Headers({ origin: ORIGIN, cookie: `${SID}=${b.token}`, ...headers }) },
      { incoming: { socket: { remoteAddress: '203.0.113.10' } } },
    );
    const bytes = Buffer.from(await res.arrayBuffer());
    let json: unknown;
    try {
      json = JSON.parse(bytes.toString('utf8'));
    } catch {
      json = undefined;
    }
    return { status: res.status, headers: res.headers, bytes, json };
  }

  const prepareUrl = (id = backupId) => `${BACKUPS}/${id}/prepare-download`;
  const downloadUrl = (id = backupId) => `${BACKUPS}/${id}/download`;
  const archiveFile = (userId: string) => path.join(dataDir, 'backups', backupId, 'downloads', userId, 'archive.altisbak');
  const preparedFile = (userId: string) => path.join(dataDir, 'backups', backupId, 'downloads', userId, 'prepared.json');
  /** The running test's audit entries of `action`. */
  const auditRows = (action: string) =>
    h.db
      .selectFrom('audit_log')
      .select(['actor_id', 'entity', 'entity_id', 'meta'])
      .where('action', '=', action)
      .where('seq', '>', startSeq)
      .orderBy('seq')
      .execute();
  const exists = (p: string) =>
    fsp.stat(p).then(
      () => true,
      () => false,
    );

  const statusOf = async (jobId: string): Promise<string> =>
    (await h.db.selectFrom('jobs').select('status').where('id', '=', jobId).executeTakeFirstOrThrow()).status;

  /**
   * Drives job `jobId` one slice per drive call until it ends; its final status. A drive that finds the job leased (a
   * piggyback slice after an earlier response holds it for a moment) waits a little and tries again.
   */
  async function driveToEnd(jobId: string): Promise<string> {
    for (let i = 0; i < 400; i += 1) {
      const r = await runtime!.drive(jobId, { budgetMs: 20_000 });
      if (r !== null && r.outcome !== 'continued') break;
      if (r === null) {
        if (!['queued', 'running'].includes(await statusOf(jobId))) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    return statusOf(jobId);
  }

  /** Prepares the backup's archive as `b` (the body given) and drives the job to its end; the job id. */
  async function prepared(b: Browser, body: Record<string, unknown> = { passphrase: PASSPHRASE }): Promise<string> {
    const res = await b.agent.post(prepareUrl(), body, b.csrf);
    expect(res.status, res.text).toBe(202);
    const { jobId } = res.json as { jobId: string };
    expect(await driveToEnd(jobId)).toBe('succeeded');
    return jobId;
  }

  /** The archive bytes written to a DATA_DIR path of their own, opened with `passphrase`. */
  async function openDownloaded(bytes: Buffer, passphrase?: string) {
    const id = newId();
    const p = dataPath(root, 'tmp', id, 'archive.altisbak');
    await fsp.mkdir(path.dirname(p), { recursive: true });
    await fsp.writeFile(p, bytes);
    return openAltisbak(p, { headroomBytes: 1 << 30, ...(passphrase === undefined ? {} : { passphrase }) });
  }

  describe('POST backups/:id/prepare-download', () => {
    it('a super admin with a passphrase: 202 {jobId}, one backup.download entry; the driven archive opens with it, secrets re-sealed', async () => {
      const b = await browser(superA.id);
      const res = await b.agent.post(prepareUrl(), { passphrase: PASSPHRASE }, b.csrf);
      expect(res.status, res.text).toBe(202);
      expect(res.headers.get('cache-control')).toBe('no-store');
      const { jobId } = res.json as { jobId: string };
      const audit = await auditRows('backup.download');
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ actor_id: superA.id, entity: 'backups', entity_id: backupId });
      expect(JSON.parse(audit[0]!.meta)).toEqual({ backupId, encrypted: true, secrets: 'archive' });
      const job = await h.db.selectFrom('jobs').select(['type', 'payload', 'secret_param', 'created_by']).where('id', '=', jobId).executeTakeFirstOrThrow();
      expect(job).toMatchObject({ type: 'backup.prepare_download', created_by: superA.id });
      expect(job.secret_param).toEqual(expect.any(String));
      expect(job.payload).not.toContain(PASSPHRASE);

      expect(await driveToEnd(jobId)).toBe('succeeded');
      expect((await h.db.selectFrom('jobs').select('secret_param').where('id', '=', jobId).executeTakeFirstOrThrow()).secret_param).toBeNull();
      const got = await fetchBytes(b, downloadUrl());
      expect(got.status).toBe(200);
      const a = await openDownloaded(got.bytes, PASSPHRASE);
      try {
        expect(a.header).toMatchObject({ backupId, secrets: 'archive', dialect: h.dialect });
        const m = await a.manifest();
        const key = columnKey(a.dek!);
        const part = m.tables['staff_users']!.parts[0]!;
        const totp = new Map<string, unknown>();
        for await (const line of a.partLines('staff_users', part.n, part.bytes)) {
          const row = JSON.parse(line) as Record<string, unknown>;
          totp.set(row['id'] as string, row['totp_secret_enc']);
        }
        const sealed = totp.get(superA.id) as string;
        expect(sealed).toMatch(/^v1:archive:/);
        expect(openArchiveValue(key, secretAad('staff_users', 'totp_secret_enc', superA.id), sealed)).toBe(base32Encode(superA.totpSecret!));
        const source = (await readManifest(dataDir, backupId))!;
        for (const [table, t] of Object.entries(m.tables)) expect(t.checksum).toBe(source.tables[table]!.checksum);
      } finally {
        await a.close();
      }
    });

    it('opt-in unencrypted (secrets keyring, audit encrypted: false); a holder of system.backup.download alone gets secrets omitted', async () => {
      const b = await browser(superB);
      await prepared(b, { unencrypted: true });
      expect(JSON.parse((await auditRows('backup.download'))[0]!.meta)).toEqual({ backupId, encrypted: false, secrets: 'keyring' });
      const plain = await openDownloaded((await fetchBytes(b, downloadUrl())).bytes);
      try {
        expect(plain.header).toMatchObject({ secrets: 'keyring', encryption: null });
      } finally {
        await plain.close();
      }

      const d = await browser(downloader);
      await prepared(d);
      expect(JSON.parse((await auditRows('backup.download'))[1]!.meta)).toEqual({ backupId, encrypted: true, secrets: 'omitted' });
      const omitted = await openDownloaded((await fetchBytes(d, downloadUrl())).bytes, PASSPHRASE);
      try {
        const m = await omitted.manifest();
        expect(m.secrets).toBe('omitted');
        for (const part of m.tables['settings']!.parts) {
          for await (const line of omitted.partLines('settings', part.n, part.bytes)) {
            const row = JSON.parse(line) as Record<string, unknown>;
            if (row['key'] === 'smtp.password') expect(row['value']).toBeNull();
          }
        }
      } finally {
        await omitted.close();
      }
    });

    it('refusals: no fresh reauth 401, exactly one of passphrase/unencrypted, a short passphrase 422, unknown 404, not ok 409, no permission 403', async () => {
      const stale = await browser(superA.id, { reauth: false });
      const noReauth = await stale.agent.post(prepareUrl(), { passphrase: PASSPHRASE }, stale.csrf);
      expect([noReauth.status, code(noReauth)]).toEqual([401, 'AUTH_REAUTH_REQUIRED']);

      const b = await browser(superA.id);
      for (const body of [{}, { passphrase: PASSPHRASE, unencrypted: true }, { unencrypted: false }]) {
        const res = await b.agent.post(prepareUrl(), body, b.csrf);
        expect([res.status, code(res)], JSON.stringify(body)).toEqual([422, 'VALIDATION_FAILED']);
      }
      const short = await b.agent.post(prepareUrl(), { passphrase: 'pendek' }, b.csrf);
      expect([short.status, code(short)]).toEqual([422, 'VALIDATION_FAILED']);
      expect((await b.agent.post(prepareUrl(newId()), { unencrypted: true }, b.csrf)).status).toBe(404);
      const running = newId();
      await h.db
        .insertInto('backups')
        .values({ id: running, kind: 'manual', size: null, sha256: null, schema_version: SCHEMA_VERSION, app_version: '0.1.0', dialect: h.dialect, consistency: 'snapshot', status: 'running', created_at: NOW })
        .execute();
      const notReady = await b.agent.post(prepareUrl(running), { unencrypted: true }, b.csrf);
      expect([notReady.status, code(notReady)]).toEqual([409, 'BACKUP_NOT_READY']);
      const r = await browser(reader);
      expect((await r.agent.post(prepareUrl(), { unencrypted: true }, r.csrf)).status).toBe(403);
      // None of these queued a job or wrote a backup.download entry.
      expect(await h.db.selectFrom('jobs').select('id').execute()).toEqual([]);
      expect(await auditRows('backup.download')).toEqual([]);
    });

    it('while the job is live, the same unencrypted request joins it; a passphrase after an unencrypted one → 409 BACKUP_PREPARE_IN_PROGRESS', async () => {
      const b = await browser(superA.id);
      const first = await b.agent.post(prepareUrl(), { unencrypted: true }, b.csrf);
      expect(first.status, first.text).toBe(202);
      const { jobId } = first.json as { jobId: string };
      const same = await b.agent.post(prepareUrl(), { unencrypted: true }, b.csrf);
      expect([same.status, same.json]).toEqual([202, { jobId }]);

      const encrypted = await b.agent.post(prepareUrl(), { passphrase: PASSPHRASE }, b.csrf);
      expect([encrypted.status, code(encrypted)]).toEqual([409, 'BACKUP_PREPARE_IN_PROGRESS']);
      expect((encrypted.json as { detail?: string }).detail).toContain(jobId);
      // Nothing of the refused request: one job, unencrypted, without a key; no entry for it.
      const jobs = await h.db.selectFrom('jobs').select(['id', 'payload', 'secret_param']).execute();
      expect(jobs.map((j) => j.id)).toEqual([jobId]);
      expect(JSON.parse(jobs[0]!.payload)).toMatchObject({ encrypted: false, kdfSalt: null });
      expect(jobs[0]!.secret_param).toBeNull();
      expect((await auditRows('backup.download')).map((r) => JSON.parse(r.meta) as unknown)).toEqual([
        { backupId, encrypted: false, secrets: 'keyring' },
        { backupId, encrypted: false, secrets: 'keyring' },
      ]);
    });

    it('passphrase A, then passphrase B while A is prepared → 409; once A has ended, B is prepared and opens with B', async () => {
      const b = await browser(superA.id);
      const first = await b.agent.post(prepareUrl(), { passphrase: PASSPHRASE }, b.csrf);
      expect(first.status, first.text).toBe(202);
      const { jobId } = first.json as { jobId: string };
      const other = 'frasa sandi yang lain sama sekali';
      const refused = await b.agent.post(prepareUrl(), { passphrase: other }, b.csrf);
      expect([refused.status, code(refused)]).toEqual([409, 'BACKUP_PREPARE_IN_PROGRESS']);
      // The same passphrase again cannot be told apart from another one (each request draws its own salt): refused too.
      const again = await b.agent.post(prepareUrl(), { passphrase: PASSPHRASE }, b.csrf);
      expect([again.status, code(again)]).toEqual([409, 'BACKUP_PREPARE_IN_PROGRESS']);
      expect(await auditRows('backup.download')).toHaveLength(1);

      expect(await driveToEnd(jobId)).toBe('succeeded');
      const second = await b.agent.post(prepareUrl(), { passphrase: other }, b.csrf);
      expect(second.status, second.text).toBe(202);
      const next = (second.json as { jobId: string }).jobId;
      expect(next).not.toBe(jobId);
      expect(await driveToEnd(next)).toBe('succeeded');
      const a = await openDownloaded((await fetchBytes(b, downloadUrl())).bytes, other);
      await a.close();
    });

    it('POST jobs/:id/retry on the preparation → 409 JOB_NOT_RETRYABLE origin_only', async () => {
      const b = await browser(superA.id);
      const res = await b.agent.post(prepareUrl(), { unencrypted: true }, b.csrf);
      const { jobId } = res.json as { jobId: string };
      await h.db.updateTable('jobs').set({ status: 'dead', unique_key: null, finished_at: now }).where('id', '=', jobId).execute();
      const retry = await b.agent.post(`/api/v1/jobs/${jobId}/retry`, {}, b.csrf);
      expect([retry.status, code(retry), reason(retry)]).toEqual([409, 'JOB_NOT_RETRYABLE', 'origin_only']);
    });
  });

  describe('GET backups/:id/download', () => {
    it('the preparer only: whole, one range (206), past the end 416; completedAt after the last byte; the folder goes 5 minutes later', async () => {
      const b = await browser(superA.id);
      const jobId = await prepared(b);
      const file = await fsp.readFile(archiveFile(superA.id));
      const size = file.byteLength;

      const whole = await fetchBytes(b, downloadUrl());
      expect(whole.status).toBe(200);
      expect(whole.bytes.equals(file)).toBe(true);
      expect(Object.fromEntries(['content-type', 'content-disposition', 'accept-ranges', 'cache-control', 'etag', 'content-length'].map((k) => [k, whole.headers.get(k)]))).toEqual({
        'content-type': 'application/octet-stream',
        'content-disposition': `attachment; filename="altis-${backupId}.altisbak"`,
        'accept-ranges': 'bytes',
        'cache-control': 'no-store',
        etag: `"${jobId}-${size}"`,
        'content-length': String(size),
      });

      const range = await fetchBytes(b, downloadUrl(), { range: 'bytes=0-99' });
      expect(range.status).toBe(206);
      expect(range.headers.get('content-range')).toBe(`bytes 0-99/${size}`);
      expect(range.headers.get('content-length')).toBe('100');
      expect(range.bytes.equals(file.subarray(0, 100))).toBe(true);
      const suffix = await fetchBytes(b, downloadUrl(), { range: 'bytes=-10' });
      expect([suffix.status, suffix.headers.get('content-range')]).toEqual([206, `bytes ${size - 10}-${size - 1}/${size}`]);
      expect(suffix.bytes.equals(file.subarray(size - 10))).toBe(true);
      const past = await fetchBytes(b, downloadUrl(), { range: 'bytes=999999999-' });
      expect([past.status, code(past), past.headers.get('content-range')]).toEqual([416, 'RANGE_NOT_SATISFIABLE', `bytes */${size}`]);

      // Another super admin has no archive of their own, and never reaches this one.
      const other = await fetchBytes(await browser(superB), downloadUrl());
      expect([other.status, code(other)]).toEqual([409, 'BACKUP_NOT_READY']);
      // A HEAD and a cross-site request start nothing.
      const head = await app.request(downloadUrl(), { method: 'HEAD', headers: { origin: ORIGIN, cookie: `${SID}=${b.token}` } });
      expect(head.status).toBe(404);
      const cross = await fetchBytes(b, downloadUrl(), { 'sec-fetch-site': 'cross-site' });
      expect(cross.status).toBe(403);

      // The whole response and the suffix range held the last byte: completedAt is when the last one was served.
      now = NOW + 7 * MIN;
      const late = await fetchBytes(b, downloadUrl(), { range: 'bytes=100-' });
      expect(late.bytes.equals(file.subarray(100))).toBe(true);
      const record = JSON.parse(await fsp.readFile(preparedFile(superA.id), 'utf8')) as Record<string, unknown>;
      expect(record).toEqual({ jobId, readyAt: expect.any(Number), size, encrypted: true, secrets: 'archive', completedAt: NOW + 7 * MIN });

      const clean = (at: number) => cleanFiles(h, { dataDir, now: at, from: null, budgetLeft: () => true });
      await clean(NOW + 7 * MIN + 5 * MIN - 1000);
      expect(await exists(archiveFile(superA.id))).toBe(true);
      await clean(NOW + 7 * MIN + 5 * MIN + 1000);
      expect(await exists(path.dirname(archiveFile(superA.id)))).toBe(false);
      const gone = await fetchBytes(b, downloadUrl());
      expect([gone.status, code(gone)]).toEqual([409, 'BACKUP_NOT_READY']);
    });

    it('a range that ends before the last byte leaves completedAt null; an archive nobody downloads goes 1 hour after readyAt', async () => {
      const b = await browser(superB);
      await prepared(b, { unencrypted: true });
      const first = await fetchBytes(b, downloadUrl(), { range: 'bytes=0-9' });
      expect(first.status).toBe(206);
      const record = JSON.parse(await fsp.readFile(preparedFile(superB), 'utf8')) as { readyAt: number; completedAt: number | null };
      expect(record.completedAt).toBeNull();
      const clean = (at: number) => cleanFiles(h, { dataDir, now: at, from: null, budgetLeft: () => true });
      await clean(record.readyAt + 60 * MIN - 1000);
      expect(await exists(archiveFile(superB))).toBe(true);
      await clean(record.readyAt + 60 * MIN + 1000);
      expect(await exists(path.dirname(archiveFile(superB)))).toBe(false);
    });

    it('an archive with secrets is served only while its preparer is a super admin; demoted, 409 until they prepare one without them', async () => {
      /** Takes the super admin role away; the user keeps system.backup.download. */
      async function demote(userId: string): Promise<void> {
        const roleId = newId();
        await withTx(h, async (trx) => {
          await trx.deleteFrom('user_roles').where('user_id', '=', userId).execute();
          await trx.insertInto('roles').values({ id: roleId, key: `t_${roleId}`, name: `Peran ${roleId}`, mfa_required: 0, created_at: NOW, updated_at: NOW }).execute();
          await trx.insertInto('role_permissions').values({ role_id: roleId, permission: 'system.backup.download' }).execute();
          await trx.insertInto('user_roles').values({ id: newId(), user_id: userId, role_id: roleId, branch_id: null, scope_key: '', created_at: NOW }).execute();
          await trx
            .updateTable('staff_users')
            .set((eb) => ({ authz_version: eb('authz_version', '+', 1) }))
            .where('id', '=', userId)
            .execute();
        });
      }

      for (const [username, body, secrets] of [
        ['turun_arsip', { passphrase: PASSPHRASE }, 'archive'],
        ['turun_kunci', { unencrypted: true }, 'keyring'],
      ] as const) {
        const userId = (await seedStaff(h, { username, roles: [{ key: 'super_admin' }], now: NOW })).id;
        const b = await browser(userId);
        await prepared(b, body);
        expect(JSON.parse(await fsp.readFile(preparedFile(userId), 'utf8'))).toMatchObject({ secrets });
        expect((await fetchBytes(b, downloadUrl(), { range: 'bytes=0-9' })).status, username).toBe(206);

        await demote(userId);
        for (const headers of [{}, { range: 'bytes=0-9' }] as Record<string, string>[]) {
          const refused = await fetchBytes(b, downloadUrl(), headers);
          expect([refused.status, code(refused)], username).toEqual([409, 'BACKUP_NOT_READY']);
        }
        // Prepared again, the archive leaves the secrets out and is theirs to download.
        await prepared(b, body);
        const got = await fetchBytes(b, downloadUrl());
        expect(got.status, username).toBe(200);
        const a = await openDownloaded(got.bytes, 'passphrase' in body ? body.passphrase : undefined);
        try {
          expect(a.header.secrets).toBe('omitted');
        } finally {
          await a.close();
        }
      }
    });

    it('nothing prepared, or still preparing → 409 BACKUP_NOT_READY; without the permission → 403', async () => {
      const b = await browser(superA.id);
      expect(code(await fetchBytes(b, downloadUrl()))).toBe('BACKUP_NOT_READY');
      await b.agent.post(prepareUrl(), { unencrypted: true }, b.csrf);
      const preparing = await fetchBytes(b, downloadUrl());
      expect([preparing.status, code(preparing)]).toEqual([409, 'BACKUP_NOT_READY']);
      expect((await fetchBytes(await browser(reader), downloadUrl())).status).toBe(403);
    });
  });

  describe('POST backups/upload', () => {
    /** An `.altisbak` made by another installation (another install, dialect and key): header and manifest only. */
    async function foreignArchive(): Promise<{ bytes: Buffer; header: AltisbakHeader }> {
      const id = newId();
      const header: AltisbakHeader = {
        format: 'altis-backup/1',
        backupId: id,
        appVersion: '0.1.0',
        schemaVersion: SCHEMA_VERSION,
        dialect: h.dialect === 'mysql' ? 'postgres' : 'mysql',
        consistency: 'snapshot',
        secrets: 'keyring',
        encryption: null,
      };
      const p = dataPath(root, 'backups', id, 'archive.altisbak');
      const writer = await openAltisbakWriter(p, { header, dek: null, checkpoint: null });
      const manifest = Buffer.from(JSON.stringify({ backupId: id, note: 'dibuat di instalasi lain' }));
      await writer.writeEntry(
        'manifest.json',
        manifest.byteLength,
        async function* (from) {
          yield manifest.subarray(from);
        },
        { deadline: Number.POSITIVE_INFINITY },
      );
      await writer.finish();
      return { bytes: await fsp.readFile(p), header };
    }

    /** Uploads `bytes` in context `backup` as `b` through the chunked upload routes and completes it; the upload id. */
    async function upload(b: Browser, bytes: Buffer): Promise<string> {
      const declared = await b.agent.post(UPLOADS, { context: 'backup', size: bytes.byteLength, sha256: sha(bytes), chunkBytes: 256 * 1024 }, b.csrf);
      expect(declared.status, declared.text).toBe(201);
      const s = declared.json as { id: string; chunkSize: number };
      for (let n = 0; n * s.chunkSize < bytes.byteLength; n += 1) {
        const form = new FormData();
        form.append('chunk', new Blob([bytes.subarray(n * s.chunkSize, (n + 1) * s.chunkSize)]), 'blob');
        const res = await app.request(
          `${UPLOADS}/${s.id}/chunks/${n}`,
          { method: 'POST', headers: new Headers({ origin: ORIGIN, cookie: `${SID}=${b.token}`, ...b.csrf }), body: form },
          { incoming: { socket: { remoteAddress: '203.0.113.10' } } },
        );
        expect(res.status, await res.text()).toBe(200);
      }
      const done = await b.agent.post(`${UPLOADS}/${s.id}/complete`, { originalName: 'cadangan.altisbak' }, b.csrf);
      expect(done.status, done.text).toBe(200);
      return s.id;
    }

    it("another installation's archive: kind external, status uploaded, one backup.upload entry, the file under backups/<id>/", async () => {
      const b = await browser(superA.id);
      const { bytes, header } = await foreignArchive();
      const uploadId = await upload(b, bytes);
      const res = await b.agent.post(`${BACKUPS}/upload`, { uploadId }, b.csrf);
      expect(res.status, res.text).toBe(200);
      const item: BackupItem = {
        id: uploadId,
        kind: 'external',
        status: 'uploaded',
        size: bytes.byteLength,
        createdAt: NOW,
        consistency: 'snapshot',
        includesFiles: false,
        external: true,
        sameInstall: false,
        schemaVersion: SCHEMA_VERSION,
        appVersion: '0.1.0',
        dialect: header.dialect,
      };
      expect(res.json).toEqual(item);
      const audit = await auditRows('backup.upload');
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ actor_id: superA.id, entity: 'backups', entity_id: uploadId });
      expect(JSON.parse(audit[0]!.meta)).toEqual({ backupId: uploadId, size: bytes.byteLength, dialect: header.dialect, schemaVersion: SCHEMA_VERSION, appVersion: '0.1.0' });
      expect(await h.db.selectFrom('backups').select(['kind', 'status', 'sha256', 'dialect']).where('id', '=', uploadId).executeTakeFirstOrThrow()).toEqual({
        kind: 'external',
        status: 'uploaded',
        sha256: sha(bytes),
        dialect: header.dialect,
      });
      expect((await fsp.readFile(path.join(dataDir, 'backups', uploadId, 'archive.altisbak'))).equals(bytes)).toBe(true);
      expect(await exists(path.join(dataDir, 'tmp', uploadId))).toBe(false);
      expect(await h.db.selectFrom('upload_sessions').select('id').where('id', '=', uploadId).execute()).toEqual([]);
      // The list shows it.
      const list = await b.agent.get(BACKUPS);
      expect((list.json as { items: BackupItem[] }).items.find((i) => i.id === uploadId)).toEqual(item);
      // The same request again (its answer was lost): the same backup, nothing new, no second entry.
      const again = await b.agent.post(`${BACKUPS}/upload`, { uploadId }, b.csrf);
      expect([again.status, again.json]).toEqual([200, item]);
      expect(await h.db.selectFrom('backups').select('id').where('kind', '=', 'external').execute()).toHaveLength(1);
      expect(await auditRows('backup.upload')).toHaveLength(1);
    });

    it('after its COMMIT an upload answers its uploader only: another holder of system.backup.restore gets 404 and no entry', async () => {
      const b = await browser(superA.id);
      const { bytes } = await foreignArchive();
      const uploadId = await upload(b, bytes);
      expect((await b.agent.post(`${BACKUPS}/upload`, { uploadId }, b.csrf)).status).toBe(200);

      const other = await browser(superB);
      const res = await other.agent.post(`${BACKUPS}/upload`, { uploadId }, other.csrf);
      expect([res.status, code(res)]).toEqual([404, 'NOT_FOUND']);
      expect((await auditRows('backup.upload')).map((r) => r.actor_id)).toEqual([superA.id]);
      expect((await fsp.readFile(path.join(dataDir, 'backups', uploadId, 'archive.altisbak'))).equals(bytes)).toBe(true);
      // The uploader still gets it.
      expect((await b.agent.post(`${BACKUPS}/upload`, { uploadId }, b.csrf)).status).toBe(200);
      expect(await auditRows('backup.upload')).toHaveLength(1);
    });

    it('refusals: no fresh reauth 401; another user’s upload 404; an incomplete upload 409; a zip that is no .altisbak 422', async () => {
      const b = await browser(superA.id);
      const { bytes } = await foreignArchive();
      const uploadId = await upload(b, bytes);
      const stale = await browser(superA.id, { reauth: false });
      const noReauth = await stale.agent.post(`${BACKUPS}/upload`, { uploadId }, stale.csrf);
      expect([noReauth.status, code(noReauth)]).toEqual([401, 'AUTH_REAUTH_REQUIRED']);
      const other = await browser(superB);
      expect((await other.agent.post(`${BACKUPS}/upload`, { uploadId }, other.csrf)).status).toBe(404);
      expect((await b.agent.post(`${BACKUPS}/upload`, { uploadId: newId() }, b.csrf)).status).toBe(404);
      expect(await auditRows('backup.upload')).toEqual([]);

      const declared = await b.agent.post(UPLOADS, { context: 'backup', size: bytes.byteLength, sha256: sha(bytes), chunkBytes: 256 * 1024 }, b.csrf);
      const incomplete = await b.agent.post(`${BACKUPS}/upload`, { uploadId: (declared.json as { id: string }).id }, b.csrf);
      expect([incomplete.status, code(incomplete)]).toEqual([409, 'UPLOAD_INCOMPLETE']);

      // A zip whose first entry is not altisbak.json.
      const notAltisbak = Buffer.from(bytes);
      const at = notAltisbak.indexOf('altisbak.json');
      notAltisbak.write('altisbak.jsox', at);
      const central = notAltisbak.indexOf('altisbak.json', at + 1);
      notAltisbak.write('altisbak.jsox', central);
      const bad = await upload(b, notAltisbak);
      const refused = await b.agent.post(`${BACKUPS}/upload`, { uploadId: bad }, b.csrf);
      expect([refused.status, code(refused)]).toEqual([422, 'BACKUP_INVALID']);
      expect(await h.db.selectFrom('backups').select('id').where('kind', '=', 'external').execute()).toEqual([]);
    });
  });
});
