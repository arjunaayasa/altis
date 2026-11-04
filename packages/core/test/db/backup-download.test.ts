import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PHASE1_MIGRATIONS, runMigrations, withTx } from '@altis/db';
import { dataPath, resetTestFaults, uploadPath } from '@altis/platform';
import { isDomainError, newId } from '@altis/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { openAltisbak, type AltisbakSource } from '../../src/archive/altisbak.js';
import { columnKey, openArchiveValue } from '../../src/archive/kdf.js';
import { checksumLine } from '../../src/backup/canonical.js';
import { createExporter, type ExportCheckpoint } from '../../src/backup/exporter.js';
import { readManifest, verifyManifestHmac, type BackupManifest } from '../../src/backup/manifest.js';
import {
  BACKUP_PREPARE_DOWNLOAD_JOB,
  backupPrepareDownloadJob,
  deriveDownloadKey,
  enqueuePrepareDownload,
  markDownloadCompleted,
  readPreparedDownload,
  type BackupPrepareDownloadPayload,
} from '../../src/backup/prepare-download.js';
import { sealValue, secretAad, type KeyringEntry } from '../../src/crypto/secret-box.js';
import { claimById } from '../../src/jobs/claim.js';
import { createJobRegistry } from '../../src/jobs/registry.js';
import { runSlice } from '../../src/jobs/slice.js';
import type { SliceResult } from '../../src/jobs/types.js';
import { writeSettings } from '../../src/settings/service.js';

// The download preparation `backup.prepare_download` (spec §9.9 "Download"; decisions C13, C14, C15; ruling R1c-6;
// plan Task 21) on the engine picked by ALTIS_TEST_DB: the job turns an `ok` backup into the preparer's own `.altisbak`
// under `backups/<id>/downloads/<preparer>/`, slice by slice (the writer pauses between chunks and entries, its
// checkpoint and the entry index travel in the payload), with the secret columns re-sealed with the archive key (a
// super admin, encrypted), kept as they are (a super admin, unencrypted) or left out (anyone else); the archive's
// manifest carries the rewritten parts' digests, the same per-table checksums and a new HMAC; the passphrase never
// reaches the job and its KEK leaves `secret_param` when the job ends.

const hooks = vi.hoisted(() => ({
  headroom: [] as [string, number][],
  /** Runs once, right after the next read (readBytes, statOrNull) of a path ending in `name`: another process's turn. */
  after: null as { name: string; run: () => Promise<void> } | null,
}));
vi.mock('@altis/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@altis/platform')>();
  // Records the call and proves nothing: a real probe writes 64 MiB per new DATA_DIR.
  const ensureHeadroom: typeof actual.ensureHeadroom = async (dir, bytes) => {
    hooks.headroom.push([dir, bytes]);
  };
  const interleave = async (p: string): Promise<void> => {
    const next = hooks.after;
    if (next === null || !p.endsWith(next.name)) return;
    hooks.after = null;
    await next.run();
  };
  const readBytes: typeof actual.readBytes = async (p, max) => {
    const bytes = await actual.readBytes(p, max);
    await interleave(p);
    return bytes;
  };
  const statOrNull: typeof actual.statOrNull = async (p) => {
    const info = await actual.statOrNull(p);
    await interleave(p);
    return info;
  };
  return { ...actual, ensureHeadroom, readBytes, statOrNull };
});

const ctx = testDbContext();
const KEY = new Uint8Array(32).fill(31);
const KEYRING: KeyringEntry[] = [{ kid: 'k1', key: Buffer.alloc(32, 5).toString('base64url'), active: true }];
const PASSPHRASE = 'kuda lumping 2026 ✓';
const SCHEMA_VERSION = Object.keys(PHASE1_MIGRATIONS).sort().at(-1)!;
const INSTALL_ID = newId();
const SMTP_PASSWORD = 'sandi-surel-rahasia';
const FILE_CONTENT = Buffer.from('isi berkas unggahan untuk blob\n');
const silent = { info() {}, warn() {}, error() {} };

const sha = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex');

describe.skipIf(!ctx.available)(`backup.prepare_download [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let root: string;
  let dataDir: string;
  let backupId: string;
  let source: BackupManifest;
  /** The TOTP plaintext of each seeded user that has one. */
  const totp = new Map<string, string>();
  const users: string[] = [];
  const reg = createJobRegistry([backupPrepareDownloadJob(() => ({ dataDir, keyring: KEYRING, sessionKey: KEY }))]);

  beforeAll(async () => {
    h = await testDb();
    root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-backup-download-')));
    dataDir = path.join(root, 'data');
    await fsp.mkdir(dataDir);
    await runMigrations(h, { appVersion: '0.1.0', dataDir: path.join(root, 'mig'), migrations: PHASE1_MIGRATIONS });
    const now = Date.now();
    await withTx(h, async (trx) => {
      for (let i = 0; i < 3; i += 1) {
        const id = newId();
        users.push(id);
        const secret = i < 2 ? `JBSWY3DPEHPK3PX${i}` : null;
        if (secret !== null) totp.set(id, secret);
        await trx
          .insertInto('staff_users')
          .values({
            id,
            username_key: `staf_${i}`,
            username_display: `staf_${i}`,
            name: `Staf ${i}`,
            password_hash: 'x',
            status: 'active',
            totp_secret_enc: secret === null ? null : sealValue(KEYRING, secretAad('staff_users', 'totp_secret_enc', id), secret),
            totp_enabled: secret === null ? 0 : 1,
            created_at: now,
            updated_at: now,
          })
          .execute();
      }
      await writeSettings(
        trx,
        { 'library.name': 'Perpustakaan Arsya', 'smtp.host': 'mail.example.test', 'smtp.username': 'surel', 'smtp.password': SMTP_PASSWORD },
        { keyring: KEYRING, now, actorId: null },
      );
      const fileId = newId();
      await trx
        .insertInto('files')
        .values({
          id: fileId,
          original_name: 'berkas.txt',
          mime: 'text/plain',
          size: FILE_CONTENT.byteLength,
          sha256: sha(FILE_CONTENT),
          context: 'test',
          access: 'staff',
          status: 'ok',
          created_at: now,
        })
        .execute();
      const file = uploadPath(dataDir, fileId);
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await fsp.writeFile(file, FILE_CONTENT);
    });

    // The backup to download: two rows per part, so staff_users and settings have several parts each.
    vi.stubEnv('ALTIS_TEST_EXPORT_PART_ROWS', '2');
    backupId = newId();
    const exporter = createExporter({
      read: h.db,
      dialect: h.dialect,
      dataDir,
      backupId,
      kind: 'manual',
      includeFiles: true,
      consistency: 'frozen',
      appVersion: '0.1.0',
      schemaVersion: SCHEMA_VERSION,
      installId: INSTALL_ID,
      sessionKey: KEY,
      kids: ['k1'],
      auditHead: { seq: 0, hash: '0'.repeat(64) },
      clock: () => Date.now(),
    });
    let checkpoint: ExportCheckpoint | null = null;
    for (let i = 0; i < 1000; i += 1) {
      const r = await exporter.step(checkpoint, { deadline: Date.now() + 60_000 });
      checkpoint = r.checkpoint;
      if (r.done) break;
    }
    vi.unstubAllEnvs();
    source = (await readManifest(dataDir, backupId))!;
    expect(source.tables['staff_users']!.parts.length).toBeGreaterThan(1);
    expect(source.tables['settings']!.parts.length).toBeGreaterThan(1);
    expect(source.blobs).toHaveLength(1);
    await h.db
      .insertInto('backups')
      .values({ id: backupId, kind: 'manual', size: 1, sha256: null, schema_version: SCHEMA_VERSION, app_version: '0.1.0', dialect: h.dialect, consistency: 'frozen', status: 'ok', created_at: now })
      .execute();
  }, 60_000);

  afterAll(async () => {
    await h?.close();
    if (root !== undefined) await fsp.rm(root, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await h.db.deleteFrom('jobs').execute();
    await h.db.deleteFrom('notifications').execute();
    hooks.headroom.length = 0;
    hooks.after = null;
    resetTestFaults();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetTestFaults();
  });

  /** Enqueues the preparation of `backupId` by `preparedBy`. */
  async function prepare(o: { preparedBy: string; superAdmin: boolean; encrypted: boolean }): Promise<string> {
    const key = o.encrypted ? await deriveDownloadKey(PASSPHRASE) : null;
    const r = await withTx(h, (trx) =>
      enqueuePrepareDownload(trx, { backupId, preparedBy: o.preparedBy, superAdmin: o.superAdmin, key, now: Date.now(), keyring: KEYRING }),
    );
    expect(r.existing).toBe(false);
    return r.jobId;
  }

  /** Slices of job `id` back to back, each with `budgetMs`, until it is not continued; the payload after each one. */
  async function drive(
    id: string,
    o: { budgetMs?: number; between?: (r: SliceResult, i: number) => Promise<void> } = {},
  ): Promise<{ results: SliceResult[]; payloads: BackupPrepareDownloadPayload[] }> {
    const results: SliceResult[] = [];
    const payloads: BackupPrepareDownloadPayload[] = [];
    for (let i = 0; i < 500; i += 1) {
      const job = await claimById(h, reg, id, { worker: 'w1', now: Date.now() });
      if (job === null) break;
      const r = await runSlice(h, reg, job, { mode: 'cron_cli', budgetMs: o.budgetMs ?? 1, keyring: KEYRING, log: silent, clock: () => Date.now(), env: process.env });
      results.push(r);
      const row = await h.db.selectFrom('jobs').select('payload').where('id', '=', id).executeTakeFirstOrThrow();
      payloads.push(JSON.parse(row.payload) as BackupPrepareDownloadPayload);
      await o.between?.(r, i);
      if (r.outcome !== 'continued') break;
    }
    return { results, payloads };
  }

  const downloadDir = (preparedBy: string): string => path.join(dataDir, 'backups', backupId, 'downloads', preparedBy);
  const archivePath = (preparedBy: string) => dataPath(dataDir, 'backups', backupId, 'downloads', preparedBy, 'archive.altisbak');
  const exists = (p: string) =>
    fsp.stat(p).then(
      () => true,
      () => false,
    );

  /** Every row of `table` in the archive, in part order, with each part's lines checked against the manifest. */
  async function rowsOf(a: AltisbakSource, m: BackupManifest, table: string): Promise<Record<string, unknown>[]> {
    const rows: Record<string, unknown>[] = [];
    for (const part of m.tables[table]!.parts) {
      let bytes = 0;
      let count = 0;
      for await (const line of a.partLines(table, part.n, part.bytes)) {
        bytes += Buffer.byteLength(line, 'utf8') + 1;
        count += 1;
        rows.push(JSON.parse(line) as Record<string, unknown>);
      }
      expect(bytes).toBe(part.bytes);
      expect(count).toBe(part.rows);
    }
    return rows;
  }

  /** The per-table checksum recomputed from the archive's own lines (secret columns left out). */
  async function checksumOf(a: AltisbakSource, m: BackupManifest, table: string): Promise<string> {
    const hash = createHash('sha256');
    for (const row of await rowsOf(a, m, table)) hash.update(checksumLine(table as never, row), 'utf8');
    return hash.digest('hex');
  }

  /** Checks what every archive holds: the descriptive header, the HMAC, the checksums, the blob, the extraction. */
  async function checkCommon(a: AltisbakSource, m: BackupManifest, secrets: string): Promise<void> {
    expect(a.header).toMatchObject({
      format: 'altis-backup/1',
      backupId,
      appVersion: '0.1.0',
      schemaVersion: SCHEMA_VERSION,
      dialect: h.dialect,
      consistency: 'frozen',
      secrets,
    });
    expect(m.secrets).toBe(secrets);
    expect(verifyManifestHmac(KEY, m)).toBe(true);
    expect(verifyManifestHmac(new Uint8Array(32).fill(1), m)).toBe(false);
    expect(Object.keys(m.tables)).toEqual(Object.keys(source.tables));
    for (const [table, t] of Object.entries(m.tables)) {
      expect(t.checksum).toBe(source.tables[table]!.checksum);
      expect(t.rows).toBe(source.tables[table]!.rows);
      expect(await checksumOf(a, m, table)).toBe(t.checksum);
    }
    expect(m.blobs).toEqual(source.blobs);
    const chunks: Buffer[] = [];
    for await (const c of a.blob(source.blobs[0]!.sha256)) chunks.push(Buffer.from(c));
    expect(Buffer.concat(chunks).equals(FILE_CONTENT)).toBe(true);
    // Every part and blob matches the manifest's SHA-256 (extractTo refuses a mismatch).
    const opId = newId();
    expect(await a.extractTo(opId, { deadline: Number.POSITIVE_INFINITY, checkpoint: null })).toMatchObject({ done: true });
    await fsp.rm(path.join(dataDir, 'tmp', opId), { recursive: true, force: true });
  }

  it('a super admin, encrypted: paused slices, archive secrets re-sealed (v1:archive:), same checksums, new HMAC, no passphrase kept', async () => {
    const preparedBy = users[0]!;
    const jobId = await prepare({ preparedBy, superAdmin: true, encrypted: true });
    const queued = await h.db.selectFrom('jobs').select(['payload', 'secret_param']).where('id', '=', jobId).executeTakeFirstOrThrow();
    expect(queued.secret_param).toMatch(/^v1:k1:/);
    expect(JSON.parse(queued.payload)).toEqual({
      backupId,
      preparedBy,
      encrypted: true,
      secrets: 'archive',
      kdfSalt: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/),
      dekWrap: null,
      checkpoint: null,
      entry: 0,
    });

    const { results, payloads } = await drive(jobId);
    expect(results.at(-1)!.outcome).toBe('succeeded');
    expect(results.filter((r) => r.outcome === 'continued').length).toBeGreaterThanOrEqual(2);
    for (const p of payloads.slice(0, -1)) {
      expect(p.checkpoint).not.toBeNull();
      expect(p.entry).toBe(p.checkpoint!.entry - 1);
      expect(p.dekWrap).toEqual({ iv: expect.any(String), ct: expect.any(String) });
    }
    const done = await h.db.selectFrom('jobs').select(['status', 'payload', 'secret_param']).where('id', '=', jobId).executeTakeFirstOrThrow();
    expect(done.status).toBe('succeeded');
    expect(done.secret_param).toBeNull();
    expect(done.payload).not.toContain(PASSPHRASE);
    expect(done.payload).not.toContain('passphrase');
    expect(hooks.headroom.length).toBeGreaterThanOrEqual(1);

    const prepared = await readPreparedDownload(dataDir, backupId, preparedBy);
    const size = (await fsp.stat(archivePath(preparedBy))).size;
    expect(prepared).toEqual({ jobId, readyAt: expect.any(Number), size, encrypted: true, secrets: 'archive', completedAt: null });
    // The sidecar and the rewritten parts go once the archive is ready.
    expect(await exists(path.join(downloadDir(preparedBy), 'archive.central'))).toBe(false);
    expect(await exists(path.join(downloadDir(preparedBy), '.work'))).toBe(false);

    await expect(openAltisbak(archivePath(preparedBy), { headroomBytes: 1 << 30 })).rejects.toMatchObject({ code: 'BACKUP_PASSPHRASE_REQUIRED' });
    await expect(openAltisbak(archivePath(preparedBy), { passphrase: 'bukan frasa sandinya', headroomBytes: 1 << 30 })).rejects.toMatchObject({
      code: 'BACKUP_PASSPHRASE_INVALID',
    });
    const a = await openAltisbak(archivePath(preparedBy), { passphrase: PASSPHRASE, headroomBytes: 1 << 30, dataDir });
    try {
      expect(a.header.encryption).not.toBeNull();
      const m = await a.manifest();
      await checkCommon(a, m, 'archive');
      const key = columnKey(a.dek!);
      const staff = await rowsOf(a, m, 'staff_users');
      expect(staff).toHaveLength(3);
      for (const row of staff) {
        const id = row['id'] as string;
        const plain = totp.get(id);
        if (plain === undefined) {
          expect(row['totp_secret_enc']).toBeNull();
          continue;
        }
        expect(row['totp_secret_enc']).toMatch(/^v1:archive:/);
        expect(openArchiveValue(key, secretAad('staff_users', 'totp_secret_enc', id), row['totp_secret_enc'] as string)).toBe(plain);
      }
      const settings = await rowsOf(a, m, 'settings');
      const password = settings.find((r) => r['key'] === 'smtp.password')!;
      expect(password['is_secret']).toBe(1);
      expect(password['value']).toMatch(/^v1:archive:/);
      expect(openArchiveValue(key, secretAad('settings', 'value', 'smtp.password'), password['value'] as string)).toBe(SMTP_PASSWORD);
      expect(settings.find((r) => r['key'] === 'smtp.host')!['value']).toBe('"mail.example.test"');
      // The rewritten parts carry their own digests; the others are the backup's own.
      for (const [table, t] of Object.entries(m.tables)) {
        const rewritten = table === 'staff_users' || table === 'settings';
        t.parts.forEach((p, i) => {
          const was = source.tables[table]!.parts[i]!;
          expect({ ...p, sha256: '', bytes: 0 }).toEqual({ ...was, sha256: '', bytes: 0 });
          if (!rewritten) expect(p).toEqual(was);
        });
      }
      expect(m.tables['settings']!.parts.some((p, i) => p.sha256 !== source.tables['settings']!.parts[i]!.sha256)).toBe(true);
    } finally {
      await a.close();
    }
  });

  it('anyone else (not a super admin): secrets omitted, totp_secret_enc and smtp.password NULL, checksums kept', async () => {
    const preparedBy = users[1]!;
    const jobId = await prepare({ preparedBy, superAdmin: false, encrypted: true });
    const { results } = await drive(jobId, { budgetMs: 20_000 });
    expect(results.at(-1)!.outcome).toBe('succeeded');
    const a = await openAltisbak(archivePath(preparedBy), { passphrase: PASSPHRASE, headroomBytes: 1 << 30, dataDir });
    try {
      const m = await a.manifest();
      await checkCommon(a, m, 'omitted');
      for (const row of await rowsOf(a, m, 'staff_users')) expect(row['totp_secret_enc']).toBeNull();
      const settings = await rowsOf(a, m, 'settings');
      expect(settings.find((r) => r['key'] === 'smtp.password')!['value']).toBeNull();
      expect(settings.find((r) => r['key'] === 'smtp.username')!['value']).toBe('"surel"');
    } finally {
      await a.close();
    }
  });

  it('a super admin, unencrypted: no encryption, secrets keyring, every part (sealed values included) as the backup holds it', async () => {
    const preparedBy = users[2]!;
    const jobId = await prepare({ preparedBy, superAdmin: true, encrypted: false });
    expect(JSON.parse((await h.db.selectFrom('jobs').select('payload').where('id', '=', jobId).executeTakeFirstOrThrow()).payload)).toMatchObject({
      encrypted: false,
      secrets: 'keyring',
      kdfSalt: null,
    });
    expect((await h.db.selectFrom('jobs').select('secret_param').where('id', '=', jobId).executeTakeFirstOrThrow()).secret_param).toBeNull();
    const { results } = await drive(jobId);
    expect(results.at(-1)!.outcome).toBe('succeeded');
    expect((await readPreparedDownload(dataDir, backupId, preparedBy))?.encrypted).toBe(false);
    const a = await openAltisbak(archivePath(preparedBy), { headroomBytes: 1 << 30, dataDir });
    try {
      expect(a.header.encryption).toBeNull();
      expect(a.dek).toBeNull();
      const m = await a.manifest();
      await checkCommon(a, m, 'keyring');
      expect(m.tables).toEqual(source.tables);
      const db = await h.db.selectFrom('staff_users').select(['id', 'totp_secret_enc']).execute();
      for (const row of await rowsOf(a, m, 'staff_users')) {
        expect(row['totp_secret_enc']).toBe(db.find((r) => r.id === row['id'])!.totp_secret_enc);
      }
    } finally {
      await a.close();
    }
  });

  it.each(['damaged', 'missing'] as const)('a %s blob is left out: the archive still extracts whole', async (how) => {
    // The blob is a hard link to the upload: damage in place of the same size (bit rot, an FTP overwrite) reaches it
    // after the backup. A blob that is gone (removed by hand) is left out the same way.
    const name = `blobs/${source.blobs[0]!.sha256}`;
    const blob = path.join(dataDir, 'backups', name);
    const original = await fsp.readFile(blob);
    if (how === 'damaged') {
      const damaged = Buffer.from(original);
      damaged[0] = damaged[0]! ^ 0xff;
      await fsp.writeFile(blob, damaged);
    } else {
      await fsp.rm(blob);
    }
    try {
      const preparedBy = newId();
      const jobId = await prepare({ preparedBy, superAdmin: true, encrypted: true });
      const { results } = await drive(jobId);
      expect(results.length).toBeGreaterThan(2);
      expect(results.at(-1)!.outcome).toBe('succeeded');
      const a = await openAltisbak(archivePath(preparedBy), { passphrase: PASSPHRASE, headroomBytes: 1 << 30, dataDir });
      try {
        const m = await a.manifest();
        expect(a.entryNames()).not.toContain(name);
        const parts = Object.values(source.tables).reduce((n, t) => n + t.parts.length, 0);
        expect(a.entryNames().filter((n) => n.startsWith('tables/'))).toHaveLength(parts);
        // The manifest still lists the blob: a restore finds no bytes for it and marks the file `missing` (§9.10).
        expect(m.blobs).toEqual(source.blobs);
        const opId = newId();
        expect(await a.extractTo(opId, { deadline: Number.POSITIVE_INFINITY, checkpoint: null })).toMatchObject({ done: true });
        await fsp.rm(path.join(dataDir, 'tmp', opId), { recursive: true, force: true });
      } finally {
        await a.close();
      }
    } finally {
      await fsp.writeFile(blob, original);
    }
  });

  it('P7: garbage a dead slice appended is cut off, and an archive that vanished between slices is started over', async () => {
    const preparedBy = newId();
    const jobId = await prepare({ preparedBy, superAdmin: true, encrypted: true });
    const { results } = await drive(jobId, {
      async between(r, i) {
        if (r.outcome !== 'continued') return;
        if (i === 3) {
          await fsp.rm(downloadDir(preparedBy), { recursive: true, force: true });
          return;
        }
        await fsp.appendFile(path.join(downloadDir(preparedBy), 'archive.altisbak'), Buffer.alloc(777, 0x41));
        await fsp.appendFile(path.join(downloadDir(preparedBy), 'archive.central'), Buffer.alloc(99, 0x42));
      },
    });
    expect(results.at(-1)!.outcome).toBe('succeeded');
    const a = await openAltisbak(archivePath(preparedBy), { passphrase: PASSPHRASE, headroomBytes: 1 << 30, dataDir });
    try {
      await checkCommon(a, await a.manifest(), 'archive');
    } finally {
      await a.close();
    }
  });

  it('P21: a full disk removes the partial archive, notifies disk_low and fails the slice with DISK_QUOTA; the retry starts over', async () => {
    const preparedBy = newId();
    const jobId = await prepare({ preparedBy, superAdmin: true, encrypted: true });
    vi.stubEnv('ALTIS_TEST_FAULT', 'disk-full:backups:6');
    const first = await drive(jobId);
    expect(first.results.at(-1)).toMatchObject({ outcome: 'retry', error: 'DISK_QUOTA' });
    expect(await exists(downloadDir(preparedBy))).toBe(false);
    expect(await h.db.selectFrom('notifications').select('type').where('type', '=', 'disk.low').execute()).toHaveLength(1);
    vi.unstubAllEnvs();
    // The retry waits for its backoff; it is due once run_at has passed.
    await h.db.updateTable('jobs').set({ run_at: Date.now() - 1 }).where('id', '=', jobId).execute();
    const second = await drive(jobId, { budgetMs: 20_000 });
    expect(second.results.at(-1)!.outcome).toBe('succeeded');
    const a = await openAltisbak(archivePath(preparedBy), { passphrase: PASSPHRASE, headroomBytes: 1 << 30, dataDir });
    await a.close();
  });

  it('enqueue: one live job per backup and preparer; an unknown backup is NOT_FOUND, one that is not ok BACKUP_NOT_READY', async () => {
    const preparedBy = newId();
    const first = await withTx(h, (trx) =>
      enqueuePrepareDownload(trx, { backupId, preparedBy, superAdmin: true, key: null, now: Date.now(), keyring: KEYRING }),
    );
    const again = await withTx(h, (trx) =>
      enqueuePrepareDownload(trx, { backupId, preparedBy, superAdmin: true, key: null, now: Date.now(), keyring: KEYRING }),
    );
    expect(again).toEqual({ ...first, existing: true });
    expect(first).toMatchObject({ encrypted: false, secrets: 'keyring' });
    const job = await h.db.selectFrom('jobs').select(['type', 'unique_key', 'created_by']).where('id', '=', first.jobId).executeTakeFirstOrThrow();
    expect(job).toEqual({ type: BACKUP_PREPARE_DOWNLOAD_JOB, unique_key: `backup.prepare_download:${backupId}:${preparedBy}`, created_by: preparedBy });

    const unknown = await withTx(h, (trx) =>
      enqueuePrepareDownload(trx, { backupId: newId(), preparedBy, superAdmin: true, key: null, now: Date.now(), keyring: KEYRING }),
    ).catch((e: unknown) => e);
    expect(isDomainError(unknown) && unknown.code).toBe('NOT_FOUND');
    const running = newId();
    await h.db
      .insertInto('backups')
      .values({ id: running, kind: 'manual', size: null, sha256: null, schema_version: SCHEMA_VERSION, app_version: '0.1.0', dialect: h.dialect, consistency: 'snapshot', status: 'running', created_at: Date.now() })
      .execute();
    const notReady = await withTx(h, (trx) =>
      enqueuePrepareDownload(trx, { backupId: running, preparedBy, superAdmin: true, key: null, now: Date.now(), keyring: KEYRING }),
    ).catch((e: unknown) => e);
    expect(isDomainError(notReady) && notReady.code).toBe('BACKUP_NOT_READY');
  });

  it('markDownloadCompleted writes only beside the archive prepared.json describes, and never brings back a removed folder', async () => {
    const preparedBy = newId();
    const jobId = await prepare({ preparedBy, superAdmin: true, encrypted: false });
    expect((await drive(jobId, { budgetMs: 20_000 })).results.at(-1)!.outcome).toBe('succeeded');
    const dir = downloadDir(preparedBy);
    const record = path.join(dir, 'prepared.json');
    const archive = path.join(dir, 'archive.altisbak');
    const ready = await fsp.readFile(record, 'utf8');
    const bytes = await fsp.readFile(archive);
    const mark = () => markDownloadCompleted(dataDir, backupId, preparedBy, { jobId, at: Date.now() });
    /** The folder as the finished preparation left it. */
    const restore = async () => {
      await fsp.rm(dir, { recursive: true, force: true });
      await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(archive, bytes);
      await fsp.writeFile(record, ready);
    };
    /** What a new preparation's first slice does: the folder emptied, then a new archive begun (no prepared.json). */
    const begin = async () => {
      await fsp.rm(dir, { recursive: true, force: true });
      await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(archive, bytes.subarray(0, 100));
    };

    // The archive is gone (or not the size recorded): nothing is written.
    await fsp.rm(archive);
    expect(await mark()).toBe(false);
    expect(await fsp.readFile(record, 'utf8')).toBe(ready);
    await fsp.writeFile(archive, bytes.subarray(1));
    expect(await mark()).toBe(false);
    expect(await fsp.readFile(record, 'utf8')).toBe(ready);

    // The cleanup removed the folder right after prepared.json was read, or after the archive was looked at.
    for (const name of ['prepared.json', 'archive.altisbak']) {
      await restore();
      hooks.after = { name, run: () => fsp.rm(dir, { recursive: true, force: true }) };
      expect(await mark(), name).toBe(false);
      expect(await exists(dir), name).toBe(false);
    }
    // A new preparation began in between: its folder gets no record of the old archive.
    for (const name of ['prepared.json', 'archive.altisbak']) {
      await restore();
      hooks.after = { name, run: begin };
      expect(await mark(), name).toBe(false);
      expect(await exists(record), name).toBe(false);
      expect((await fsp.stat(archive)).size, name).toBe(100);
    }

    await restore();
    expect(await mark()).toBe(true);
    expect((JSON.parse(await fsp.readFile(record, 'utf8')) as { completedAt: number | null }).completedAt).toEqual(expect.any(Number));
  });

  it('enqueue while a job is live: only an unencrypted request with the same secrets joins it, any other is BACKUP_PREPARE_IN_PROGRESS', async () => {
    const enq = (preparedBy: string, o: { superAdmin: boolean; key: Awaited<ReturnType<typeof deriveDownloadKey>> | null }) =>
      withTx(h, (trx) => enqueuePrepareDownload(trx, { backupId, preparedBy, ...o, now: Date.now(), keyring: KEYRING })).catch((e: unknown) => e);
    const key = await deriveDownloadKey(PASSPHRASE);

    const plain = newId();
    const first = (await enq(plain, { superAdmin: true, key: null })) as { jobId: string };
    for (const o of [
      { superAdmin: true, key },
      { superAdmin: false, key: null },
    ]) {
      const refused = await enq(plain, o);
      expect(isDomainError(refused) && [refused.code, refused.meta]).toEqual(['BACKUP_PREPARE_IN_PROGRESS', { jobId: first.jobId }]);
    }

    const sealed = newId();
    const live = (await enq(sealed, { superAdmin: true, key })) as { jobId: string };
    for (const o of [
      { superAdmin: true, key },
      { superAdmin: true, key: null },
    ]) {
      const refused = await enq(sealed, o);
      expect(isDomainError(refused) && [refused.code, refused.meta]).toEqual(['BACKUP_PREPARE_IN_PROGRESS', { jobId: live.jobId }]);
    }
    // The refused requests wrote nothing: the live job keeps its payload and its key.
    const rows = await h.db.selectFrom('jobs').select(['id', 'payload', 'secret_param']).orderBy('id').execute();
    expect(rows.map((r) => r.id).sort()).toEqual([first.jobId, live.jobId].sort());
    const kept = rows.find((r) => r.id === live.jobId)!;
    expect(JSON.parse(kept.payload)).toMatchObject({ encrypted: true, kdfSalt: key.kdfSalt });
    expect(kept.secret_param).toMatch(/^v1:k1:/);
  });
});
